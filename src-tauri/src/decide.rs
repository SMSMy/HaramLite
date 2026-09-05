//! Live v1 Slice 2 — decision layer OVER silence maps.
//!
//! Ideas-only inspiration (see inspiration/NOTES.md — prohibition header:
//! reimplemented from scratch; no third-party code copied; unchanged license).
//!
//! Scope is deliberately narrow: per-window feature extraction + v0 scoring
//! rule + hysteresis smoother + embedded timing. The scorer consumes a
//! [`crate::livemap::ChunkMap`] and only examines KEPT ranges (silent audio
//! is never scored — that is the "over maps" contract).
//!
//! HONESTY LABEL: thresholds/weights are UNCALIBRATED (no labeled data
//! exists tonight). Accuracy is NOT claimed here; per-minute COST is measured
//! and decides the 60s/120s chunk size. Calibration is Slice 3.

// Dead until the player stage wires it; tests exercise everything.
#![allow(dead_code)]

use std::time::Instant;

use rustfft::{num_complex::Complex, FftPlanner};

use crate::livemap::ChunkMap;

/// Decision tuning. The matrix values (3-window confirmation, 1.5s minimum,
/// 1s hangover) come from the approved design; the WEIGHTS are v0 guesses.
pub struct DecideConfig {
    /// Decision window length in seconds (default 3.0).
    pub window_secs: f32,
    /// Scoring cadence in seconds (default 0.5; inference<HOP budget reads it).
    pub hop_secs: f32,
    /// Consecutive confirming windows to enter Mute/Duck (default 3).
    pub confirm_windows: usize,
    /// Confidence ≥ this → Mute candidate (default 0.8).
    pub mute_conf: f32,
    /// Confidence ≥ this → Duck candidate (default 0.5).
    pub duck_conf: f32,
    /// Minimum time in a state before leaving it (default 1.5s).
    pub min_state_secs: f32,
    /// After Mute ends, hold Duck this long (default 1.0s).
    pub hangover_secs: f32,
}

impl Default for DecideConfig {
    fn default() -> Self {
        Self {
            window_secs: 3.0,
            hop_secs: 0.5,
            confirm_windows: 3,
            mute_conf: 0.8,
            duck_conf: 0.5,
            min_state_secs: 1.5,
            hangover_secs: 1.0,
        }
    }
}

/// Player-side verdict. The 50ms anti-click ramp is applied by the player,
/// not here — this layer only emits states on the timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Duck,
    Mute,
}

/// Score of one decision window.
pub struct WindowScore {
    pub start_sec: f64,
    /// Music-presence confidence 0..1 (UNCALIBRATED v0 — cost vehicle only).
    pub confidence: f32,
    /// True when the window fell outside kept ranges (skipped, ~free).
    pub silent: bool,
    pub timing_us: u64,
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos())
        .collect()
}

/// Mean-zero-crossing-rate + RMS of a mono slice (non-finite → loud-safe).
fn zcr_rms(x: &[f32]) -> (f32, f32) {
    if x.len() < 2 {
        return (0.0, 0.0);
    }
    let mut crossings = 0usize;
    let mut sum_sq = 0.0f64;
    let mut prev = if x[0].is_finite() { x[0] } else { 1.0 };
    for &v in x {
        let v = if v.is_finite() { v } else { 1.0 };
        sum_sq += (v as f64) * (v as f64);
        if (prev < 0.0) != (v < 0.0) {
            crossings += 1;
        }
        prev = v;
    }
    (
        crossings as f32 / (x.len() - 1) as f32,
        (sum_sq / x.len() as f64).sqrt() as f32,
    )
}

/// Spectral centroid (Hz) + flatness (0=tonal … 1=white) of one 4096 frame.
fn centroid_flatness(frame: &[f32], sr: f32, planner: &mut FftPlanner<f32>, win: &[f32]) -> (f32, f32) {
    const N: usize = 4096;
    let mut buf: Vec<Complex<f32>> = (0..N)
        .map(|i| {
            let v = frame.get(i).copied().unwrap_or(0.0);
            let v = if v.is_finite() { v } else { 0.0 };
            Complex::new(v * win[i], 0.0)
        })
        .collect();
    planner.plan_fft_forward(N).process(&mut buf);
    let half = N / 2;
    let mut num = 0.0f64;
    let mut den = 0.0f64;
    let mut log_sum = 0.0f64;
    let mut count = 0usize;
    for (k, c) in buf.iter().take(half).enumerate() {
        let p = (c.norm_sqr() as f64).max(1e-12);
        let hz = k as f64 * sr as f64 / N as f64;
        num += hz * p;
        den += p;
        log_sum += p.ln();
        count += 1;
    }
    if den <= 0.0 || count == 0 {
        return (0.0, 1.0);
    }
    let centroid = (num / den) as f32;
    let flatness = ((log_sum / count as f64).exp() / (den / count as f64)) as f32;
    (centroid, flatness.clamp(0.0, 1.0))
}

/// v0 music-confidence from window aggregates. Documented guess, NOT tuned:
/// tonal (low flatness) + steady energy + mid-band centroid → music-ish.
/// White/chaotic content scores low; the ORDER (sine > noise) is what the
/// tests pin, never absolute values.
fn v0_confidence(mean_flat: f32, steadiness: f32, centroid_hz: f32) -> f32 {
    let tonal = 1.0 - mean_flat.clamp(0.0, 1.0);
    let band = if centroid_hz < 150.0 || centroid_hz > 6000.0 {
        0.2
    } else if centroid_hz < 300.0 || centroid_hz > 4000.0 {
        0.7
    } else {
        1.0
    };
    (0.5 * tonal + 0.3 * steadiness.clamp(0.0, 1.0) + 0.2 * band).clamp(0.0, 1.0)
}

/// Score decision windows over a chunk, honouring its silence map.
/// Windows outside kept ranges are emitted silent (confidence 0, ~free).
pub fn score_windows(
    l: &[f32],
    r: &[f32],
    sr: u32,
    map: &ChunkMap,
    cfg: &DecideConfig,
) -> Vec<WindowScore> {
    let n = l.len().min(r.len());
    let mut out = Vec::new();
    if n == 0 || sr == 0 || cfg.hop_secs <= 0.0 || cfg.window_secs <= 0.0 {
        return out;
    }
    let win_n = (cfg.window_secs * sr as f32) as usize;
    let hop_n = ((cfg.hop_secs * sr as f32) as usize).max(1);
    let hann_win = hann(4096);
    let mut planner = FftPlanner::<f32>::new();

    // Mono mix once (decision runs on energy/shape, not stereo image).
    let mono: Vec<f32> = l
        .iter()
        .zip(r.iter())
        .map(|(a, b)| {
            let a = if a.is_finite() { *a } else { 0.0 };
            let b = if b.is_finite() { *b } else { 0.0 };
            0.5 * (a + b)
        })
        .collect();

    let in_kept = |s: usize| {
        let t = map.chunk_start_sec + s as f64 / sr as f64;
        map.kept_ranges_sec.iter().any(|(a, b)| t >= *a && t < *b)
    };

    let mut start = 0usize;
    while start + win_n <= n {
        let t0 = Instant::now();
        let mid = start + win_n / 2;
        if !in_kept(mid) {
            out.push(WindowScore {
                start_sec: map.chunk_start_sec + start as f64 / sr as f64,
                confidence: 0.0,
                silent: true,
                timing_us: t0.elapsed().as_micros() as u64,
            });
            start += hop_n;
            continue;
        }
        // Subframes of 100ms for stability statistics.
        let sub = (sr as usize / 10).max(256);
        let mut rms_vals = Vec::new();
        let mut flats = Vec::new();
        let mut cents = Vec::new();
        let mut zcrs = Vec::new();
        let mut s = start;
        while s + sub <= start + win_n {
            let sl = &mono[s..s + sub];
            let (z, rms) = zcr_rms(sl);
            zcrs.push(z);
            rms_vals.push(rms);
            // One FFT per subframe start (4096 samples ≈ 93ms @44.1k).
            let f0 = s.min(n.saturating_sub(4096));
            let (c, f) = centroid_flatness(&mono[f0..], sr as f32, &mut planner, &hann_win);
            cents.push(c);
            flats.push(f);
            s += sub;
        }
        let mean = |v: &[f32]| {
            if v.is_empty() {
                0.0
            } else {
                v.iter().sum::<f32>() / v.len() as f32
            }
        };
        let m_rms = mean(&rms_vals);
        let range = rms_vals.iter().cloned().fold(0.0f32, f32::max)
            - rms_vals.iter().cloned().fold(f32::INFINITY, f32::min);
        let steadiness = if m_rms > 1e-6 { 1.0 - (range / m_rms).min(1.0) } else { 0.0 };
        let conf = if m_rms <= 1e-6 {
            0.0
        } else {
            v0_confidence(mean(&flats), steadiness, mean(&cents))
        };
        let _ = mean(&zcrs); // wired into v1 calibration (Slice 3); measured, not used
        out.push(WindowScore {
            start_sec: map.chunk_start_sec + start as f64 / sr as f64,
            confidence: conf,
            silent: false,
            timing_us: t0.elapsed().as_micros() as u64,
        });
        start += hop_n;
    }
    out
}

/// Hysteresis smoother over a confidence series → (start_sec, verdict).
/// Approved matrix: `confirm_windows` consecutive candidates to enter a
/// state, `min_state_secs` hold before leaving, `hangover_secs` of Duck
/// after Mute ends. Pure function — fully unit-tested.
pub fn smooth_verdicts(
    scores: &[WindowScore],
    cfg: &DecideConfig,
    hop_secs: f32,
) -> Vec<(f64, Verdict)> {
    let mut out: Vec<(f64, Verdict)> = Vec::new();
    let mut state = Verdict::Pass;
    let mut state_since = scores.first().map(|s| s.start_sec).unwrap_or(0.0);
    let mut mute_run = 0usize;
    let mut duck_run = 0usize;
    let mut hangover_until = f64::NEG_INFINITY;

    let mut enter = |t: f64, v: Verdict, now_state: &mut Verdict, since: &mut f64| {
        if *now_state != v {
            *now_state = v;
            *since = t;
            out.push((t, v));
        }
    };

    for s in scores {
        let cand = if s.confidence >= cfg.mute_conf {
            Some(Verdict::Mute)
        } else if s.confidence >= cfg.duck_conf {
            Some(Verdict::Duck)
        } else {
            None
        };
        match cand {
            Some(Verdict::Mute) => {
                mute_run += 1;
                duck_run = 0;
            }
            Some(Verdict::Duck) => {
                duck_run += 1;
                mute_run = 0;
            }
            _ => {
                mute_run = 0;
                duck_run = 0;
            }
        }
        let held = (s.start_sec - state_since) as f32 >= cfg.min_state_secs;
        match state {
            Verdict::Pass => {
                if mute_run >= cfg.confirm_windows {
                    enter(s.start_sec, Verdict::Mute, &mut state, &mut state_since);
                } else if duck_run >= cfg.confirm_windows {
                    enter(s.start_sec, Verdict::Duck, &mut state, &mut state_since);
                }
            }
            Verdict::Duck => {
                if mute_run >= cfg.confirm_windows {
                    enter(s.start_sec, Verdict::Mute, &mut state, &mut state_since);
                } else if cand.is_none() && held {
                    enter(s.start_sec, Verdict::Pass, &mut state, &mut state_since);
                }
            }
            Verdict::Mute => {
                if cand.is_none() && held {
                    // Hangover: step down through Duck, never straight to Pass.
                    enter(s.start_sec, Verdict::Duck, &mut state, &mut state_since);
                    hangover_until = s.start_sec + cfg.hangover_secs as f64;
                    let _ = hop_secs;
                }
            }
        }
        // Hangover expiry while still Duck with no candidate → Pass.
        if state == Verdict::Duck && cand.is_none() && s.start_sec >= hangover_until
            && (s.start_sec - state_since) as f32 >= cfg.min_state_secs
            && hangover_until.is_finite()
        {
            enter(s.start_sec, Verdict::Pass, &mut state, &mut state_since);
            hangover_until = f64::NEG_INFINITY;
        }
    }
    out
}

/// Processing cost per 60s of audio from summed decision timings.
pub fn minute_cost_ms(total_us: u64, total_audio_secs: f64) -> f32 {
    if total_audio_secs <= 0.0 {
        return 0.0;
    }
    total_us as f32 / 1000.0 / (total_audio_secs / 60.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::livemap::{map_chunk_silence, split_plan, MapConfig};

    const SR: u32 = 44100;

    fn sine(secs: f32, amp: f32, hz: f32) -> Vec<f32> {
        (0..(SR as f32 * secs) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin() * amp)
            .collect()
    }

    fn noise(secs: f32, amp: f32, seed: u64) -> Vec<f32> {
        // Deterministic LCG white noise (no rng dependency in tests).
        // Top 32 bits → [0,1] → zero-mean ±amp (a one-sided range would
        // inject DC and fake a tonal spectrum — caught by this very test).
        let mut x = seed | 1;
        (0..(SR as f32 * secs) as usize)
            .map(|_| {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                (((x >> 32) as f32) / (u32::MAX as f32) - 0.5) * 2.0 * amp
            })
            .collect()
    }

    fn concat(parts: &[Vec<f32>]) -> Vec<f32> {
        parts.iter().flat_map(|p| p.iter().copied()).collect()
    }

    fn map_of(l: &[f32], r: &[f32]) -> crate::livemap::ChunkMap {
        map_chunk_silence(l, r, SR, 0, 0.0, &MapConfig::default())
    }

    #[test]
    fn silent_windows_score_zero_and_free() {
        let l = vec![0.0f32; SR as usize * 6];
        let r = l.clone();
        let m = map_of(&l, &r);
        let scores = score_windows(&l, &r, SR, &m, &DecideConfig::default());
        assert!(!scores.is_empty());
        assert!(scores.iter().all(|s| s.silent && s.confidence == 0.0));
    }

    #[test]
    fn tonal_scores_above_noise_ordering_only() {
        // Pins ORDER (music-ish sine mix > white noise), never absolutes:
        // weights are uncalibrated by declared scope.
        let l = concat(&[sine(3.0, 0.3, 330.0), sine(3.0, 0.2, 497.0)]);
        let r = l.clone();
        let m = map_of(&l, &r);
        let tscores: Vec<f32> = score_windows(&l, &r, SR, &m, &DecideConfig::default())
            .iter()
            .filter(|s| !s.silent)
            .map(|s| s.confidence)
            .collect();
        assert!(!tscores.is_empty());
        let tonal: f32 = tscores.iter().sum::<f32>() / tscores.len() as f32;

        let n = noise(6.0, 0.35, 0x1234);
        let nr = n.clone();
        let nm = map_of(&n, &nr);
        let nscores: Vec<f32> = score_windows(&n, &nr, SR, &nm, &DecideConfig::default())
            .iter()
            .filter(|s| !s.silent)
            .map(|s| s.confidence)
            .collect();
        assert!(!nscores.is_empty());
        let noisy: f32 = nscores.iter().sum::<f32>() / nscores.len() as f32;
        assert!(tonal > noisy, "ordering must hold: tonal={tonal} noise={noisy}");
    }

    #[test]
    fn smoother_confirms_mute_and_ignores_blip() {
        let cfg = DecideConfig::default();
        let mk = |t: f64, c: f32| WindowScore { start_sec: t, confidence: c, silent: false, timing_us: 0 };
        // Four strong windows → Mute entered once (3rd confirms).
        let s: Vec<WindowScore> = (0..6).map(|i| mk(i as f64 * 0.5, if i < 4 { 0.9 } else { 0.1 })).collect();
        let v = smooth_verdicts(&s, &cfg, 0.5);
        assert!(v.iter().any(|(_, x)| *x == Verdict::Mute), "must enter Mute: {v:?}");
        assert_eq!(v.iter().filter(|(_, x)| *x == Verdict::Mute).count(), 1);
        // Single blip → nothing (needs 3 consecutive).
        let b: Vec<WindowScore> = (0..6).map(|i| mk(i as f64 * 0.5, if i == 2 { 0.95 } else { 0.1 })).collect();
        let vb = smooth_verdicts(&b, &cfg, 0.5);
        assert!(!vb.iter().any(|(_, x)| *x == Verdict::Mute), "blip must not latch: {vb:?}");
    }

    #[test]
    fn smoother_hangover_steps_down_through_duck() {
        let cfg = DecideConfig::default();
        let mk = |t: f64, c: f32| WindowScore { start_sec: t, confidence: c, silent: false, timing_us: 0 };
        // 6 strong (Mute at 3rd, held) then long quiet → Duck hangover, then Pass.
        let mut s: Vec<WindowScore> = (0..6).map(|i| mk(i as f64 * 0.5, 0.9)).collect();
        s.extend((6..16).map(|i| mk(i as f64 * 0.5, 0.05)));
        let v = smooth_verdicts(&s, &cfg, 0.5);
        let kinds: Vec<Verdict> = v.iter().map(|(_, x)| *x).collect();
        assert_eq!(kinds.first(), Some(&Verdict::Mute));
        assert!(kinds.contains(&Verdict::Duck), "hangover Duck required: {v:?}");
        assert_eq!(kinds.last(), Some(&Verdict::Pass));
    }

    #[test]
    fn empty_and_degenerate_inputs_safe() {
        let m = map_of(&[], &[]);
        assert!(score_windows(&[], &[], SR, &m, &DecideConfig::default()).is_empty());
        assert!(smooth_verdicts(&[], &DecideConfig::default(), 0.5).is_empty());
        assert_eq!(minute_cost_ms(0, 0.0), 0.0);
    }

    /// Slice 2 acceptance vehicle: decision cost over the SAME 270s clip as
    /// Slice 1 (60s chunks, hop 0.5s), printing the DECIDE-REPORT. The FIRST
    /// numerical chunk-size decision is derived from map+decide cost here.
    /// Run with `-- --nocapture`. Correctness asserted; timing printed.
    #[test]
    fn report_decide_cost_270s_clip() {
        let mut l: Vec<f32> = Vec::new();
        for k in 0..7 {
            let mix: Vec<f32> = (0..SR as usize * 30)
                .map(|i| {
                    let t = i as f32 / SR as f32;
                    0.3 * (2.0 * std::f32::consts::PI * (330.0 + k as f32 * 40.0) * t).sin()
                        + 0.2 * (2.0 * std::f32::consts::PI * 497.0 * t).sin()
                })
                .collect();
            l.extend(mix);
            l.extend(vec![0.0f32; SR as usize * 5]);
        }
        l.extend(sine(25.0, 0.4, 440.0));
        let r = l.clone();
        let total_secs = l.len() as f64 / SR as f64;

        let mcfg = MapConfig::default();
        let dcfg = DecideConfig::default();
        let plan = split_plan(total_secs, 60.0);
        let mut scored = 0usize;
        let mut skipped = 0usize;
        let mut decide_us = 0u64;
        let mut map_ms = 0.0f32;
        for (idx, start, len) in &plan {
            let a = (*start * SR as f64) as usize;
            let b = ((start + len) * SR as f64) as usize;
            let m = map_chunk_silence(&l[a..b], &r[a..b], SR, *idx, *start, &mcfg);
            map_ms += m.timing.total_ms;
            for s in score_windows(&l[a..b], &r[a..b], SR, &m, &dcfg) {
                decide_us += s.timing_us;
                if s.silent {
                    skipped += 1;
                } else {
                    scored += 1;
                }
            }
        }
        assert!(scored > 400, "must score hundreds of windows: {scored}");
        assert!(skipped > 20, "silence must skip dozens: {skipped}");
        let d_min = minute_cost_ms(decide_us, total_secs);
        let m_min = crate::livemap::minute_cost_ms(map_ms, total_secs);
        println!("DECIDE-REPORT total_secs={total_secs:.1} scored={scored} skipped={skipped} decide_min_ms={d_min:.1} map_min_ms={m_min:.1} combined_min_ms={:.1}", d_min + m_min);
    }
}
