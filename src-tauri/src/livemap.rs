//! Live v1 Slice 1 — per-chunk silence map + embedded timing.
//!
//! Ideas-only inspiration (see inspiration/NOTES.md — prohibition header:
//! two-threshold RMS-envelope hysteresis taken as an IDEA and reimplemented
//! here from scratch; no third-party code copied; project license unchanged).
//!
//! Scope is deliberately narrow: detection + timing ONLY. No muting, no
//! pass/duck/mute decisions, no MDX. The player stage (later slice) consumes
//! [`ChunkMap`] to build the position map; its ONLY acceptance deliverable
//! for this slice is the per-minute cost report (see tests).

// Dead until the player stage wires it (Slice 2+); tests exercise everything.
#![allow(dead_code)]

use std::time::Instant;

/// Detection tuning. Defaults mirror the file pipeline where sensible.
pub struct MapConfig {
    /// RMS envelope window in ms (default 50).
    pub window_ms: u32,
    /// HIGH threshold: silence STARTS when a window falls below
    /// `p90 * start_threshold_rel` (default 0.06 ≈ −24 dB vs loud parts).
    pub start_threshold_rel: f32,
    /// LOW threshold ratio: silence ENDS only when a window rises above
    /// `high * end_threshold_ratio` (default 0.5). The band between the two
    /// is the hysteresis that stops flutter on borderline levels.
    pub end_threshold_ratio: f32,
    /// Absolute floor in dBFS clamping the high threshold (default −55).
    pub absolute_floor_db: f32,
    /// A silence run must last at least this long to count (default 800ms).
    pub min_silence_ms: u32,
    /// Breathing room kept on each side of a cut (default 150ms).
    pub keep_ms: u32,
}

impl Default for MapConfig {
    fn default() -> Self {
        Self {
            window_ms: 50,
            start_threshold_rel: 0.06,
            end_threshold_ratio: 0.5,
            absolute_floor_db: -55.0,
            min_silence_ms: 800,
            keep_ms: 150,
        }
    }
}

/// Embedded timing of one map call (milliseconds, wall clock).
pub struct MapTiming {
    pub envelope_ms: f32,
    pub detect_ms: f32,
    pub total_ms: f32,
}

/// Silence map of ONE chunk on the ABSOLUTE timeline.
pub struct ChunkMap {
    pub chunk_index: usize,
    pub chunk_start_sec: f64,
    pub chunk_secs: f64,
    /// Kept (non-silent) ranges, absolute seconds, padded with keep_ms.
    pub kept_ranges_sec: Vec<(f64, f64)>,
    /// Fraction of the chunk covered by unpadded silence cuts (0..1).
    pub silence_fraction: f32,
    /// Number of silence runs ≥ min duration.
    pub silence_runs: usize,
    /// Trailing silence run length in seconds (0 when the chunk ends loud).
    /// Streaming semantic: a trailing run may continue into the next chunk —
    /// the player resolves it with look-ahead instead of cutting blindly.
    pub trailing_open_sec: f64,
    pub timing: MapTiming,
}

/// Chunking plan: (index, absolute start sec, length sec).
/// Pure function — the 60s/120s size decision is made by the caller.
pub fn split_plan(total_secs: f64, chunk_secs: f64) -> Vec<(usize, f64, f64)> {
    if !(total_secs > 0.0) || !(chunk_secs > 0.0) {
        return Vec::new();
    }
    let mut plan = Vec::new();
    let mut start = 0.0f64;
    let mut idx = 0usize;
    while start < total_secs {
        let len = (total_secs - start).min(chunk_secs);
        plan.push((idx, start, len));
        start += len;
        idx += 1;
    }
    plan
}

fn window_rms(l: &[f32], r: &[f32], win: usize) -> Vec<f32> {
    let n = l.len().min(r.len());
    let count = n / win.max(1);
    (0..count)
        .map(|w| {
            let s = w * win;
            // Non-finite samples must never poison the measurement:
            // treat them as loud so they are never cut.
            let sum: f32 = l[s..s + win]
                .iter()
                .chain(r[s..s + win].iter())
                .map(|v| {
                    if v.is_finite() {
                        v * v
                    } else {
                        f32::INFINITY
                    }
                })
                .sum();
            if sum.is_finite() {
                (sum / (win * 2) as f32).sqrt()
            } else {
                f32::INFINITY
            }
        })
        .collect()
}

/// Build the silence map of one chunk. `chunk_start_sec` anchors the output
/// on the absolute timeline; `l`/`r` hold exactly this chunk's samples.
pub fn map_chunk_silence(
    l: &[f32],
    r: &[f32],
    sr: u32,
    chunk_index: usize,
    chunk_start_sec: f64,
    cfg: &MapConfig,
) -> ChunkMap {
    let t0 = Instant::now();
    let n = l.len().min(r.len());
    let chunk_secs = if sr > 0 { n as f64 / sr as f64 } else { 0.0 };

    let empty = |timing: MapTiming| ChunkMap {
        chunk_index,
        chunk_start_sec,
        chunk_secs,
        kept_ranges_sec: Vec::new(),
        silence_fraction: 0.0,
        silence_runs: 0,
        trailing_open_sec: 0.0,
        timing,
    };
    if n == 0 || sr == 0 {
        let ms = t0.elapsed().as_secs_f32() * 1000.0;
        return empty(MapTiming { envelope_ms: 0.0, detect_ms: 0.0, total_ms: ms });
    }

    // Phase 1 — RMS envelope.
    let t_env = Instant::now();
    let win = ((sr as usize * cfg.window_ms as usize) / 1000).max(64);
    let rms = window_rms(l, r, win);
    let envelope_ms = t_env.elapsed().as_secs_f32() * 1000.0;

    // Phase 2 — two-threshold hysteresis detection.
    let t_det = Instant::now();
    let mut sorted = rms.clone();
    sorted.sort_by(|a, b| a.total_cmp(b)); // total_cmp: NaN can never panic
    let p90 = sorted
        .get((sorted.len() as f32 * 0.9) as usize)
        .copied()
        .unwrap_or(1.0);
    let floor_lin = 10f32.powf(cfg.absolute_floor_db / 20.0);
    let hi = (p90 * cfg.start_threshold_rel).max(floor_lin);
    let lo = (hi * cfg.end_threshold_ratio).max(floor_lin * 0.5);

    // State machine: enter silence below LO, leave only above HI.
    let mut cuts: Vec<(usize, usize)> = Vec::new(); // window indices
    let mut in_silence = false;
    let mut run_start = 0usize;
    let min_run = ((cfg.min_silence_ms as usize * sr as usize / 1000) / win).max(1);
    for (idx, &v) in rms.iter().enumerate() {
        if !in_silence && v < lo {
            in_silence = true;
            run_start = idx;
        } else if in_silence && v > hi {
            in_silence = false;
            if idx - run_start >= min_run {
                cuts.push((run_start, idx));
            }
        }
    }
    let nw = rms.len();
    // Trailing run: measured for the streaming open-run signal; cut only if
    // it is a real run AND the chunk does not start inside it (rs > 0 keeps
    // the whole-chunk-silent case consistent with the file pipeline).
    let mut trailing_open_sec = 0.0f64;
    if in_silence {
        trailing_open_sec = (nw - run_start) as f64 * win as f64 / sr as f64;
        if nw - run_start >= min_run && run_start > 0 {
            cuts.push((run_start, nw));
        }
    }
    // Whole-chunk silence: every window silent from 0 — one run, no kept audio.
    if in_silence && run_start == 0 && nw >= min_run {
        cuts.push((0, nw));
    }

    // Kept ranges = inverse of cuts, padded, slivers dropped, absolute secs.
    let pad = cfg.keep_ms as usize * sr as usize / 1000;
    let mut kept: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0usize;
    for (rs, re_) in &cuts {
        let cut_start = ((rs * win) + pad).min(n);
        let cut_end = (re_ * win).saturating_sub(pad).max(cut_start);
        if cut_start > cursor {
            kept.push((cursor, cut_start));
        }
        cursor = cut_end.max(cursor);
    }
    if cursor < n {
        kept.push((cursor, n));
    }
    kept.retain(|(a, b)| b - a > sr as usize / 10); // drop slivers <100ms

    let kept_ranges_sec: Vec<(f64, f64)> = kept
        .iter()
        .map(|(a, b)| {
            (chunk_start_sec + *a as f64 / sr as f64, chunk_start_sec + *b as f64 / sr as f64)
        })
        .collect();

    let cut_windows: usize = cuts.iter().map(|(a, b)| b - a).sum();
    let silence_fraction = if nw > 0 {
        (cut_windows as f32 / nw as f32).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let detect_ms = t_det.elapsed().as_secs_f32() * 1000.0;
    let total_ms = t0.elapsed().as_secs_f32() * 1000.0;

    ChunkMap {
        chunk_index,
        chunk_start_sec,
        chunk_secs,
        kept_ranges_sec,
        silence_fraction,
        silence_runs: cuts.len(),
        trailing_open_sec,
        timing: MapTiming { envelope_ms, detect_ms, total_ms },
    }
}

/// Processing cost per 60s of audio from summed map timings (ms per minute).
/// The per-minute cost report — Slice 1's ONLY acceptance deliverable — is
/// built from this over a ≤5-minute clip (see tests).
pub fn minute_cost_ms(total_map_ms: f32, total_audio_secs: f64) -> f32 {
    if total_audio_secs <= 0.0 {
        return 0.0;
    }
    total_map_ms / (total_audio_secs / 60.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44100;

    fn tone(secs: f32, amp: f32, hz: f32) -> Vec<f32> {
        (0..(SR as f32 * secs) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin() * amp)
            .collect()
    }

    fn concat(parts: &[Vec<f32>]) -> Vec<f32> {
        parts.iter().flat_map(|p| p.iter().copied()).collect()
    }

    #[test]
    fn middle_gap_maps_to_two_kept_ranges() {
        // 2s tone / 2s silence / 2s tone — the canonical map shape.
        let l = concat(&[tone(2.0, 0.5, 440.0), vec![0.0; SR as usize * 2], tone(2.0, 0.5, 440.0)]);
        let r = l.clone();
        let m = map_chunk_silence(&l, &r, SR, 0, 0.0, &MapConfig::default());
        assert_eq!(m.silence_runs, 1, "one silence run expected");
        assert_eq!(m.kept_ranges_sec.len(), 2, "two kept ranges expected");
        assert!((m.kept_ranges_sec[0].0 - 0.0).abs() < 0.01);
        assert!((m.kept_ranges_sec[0].1 - 2.15).abs() < 0.25, "first kept ends ≈2.0+keep: {:?}", m.kept_ranges_sec);
        assert!((m.kept_ranges_sec[1].0 - 3.85).abs() < 0.25, "second kept starts ≈4.0-keep: {:?}", m.kept_ranges_sec);
        assert!((m.silence_fraction - 1.0 / 3.0).abs() < 0.06, "fraction={}", m.silence_fraction);
        assert_eq!(m.trailing_open_sec, 0.0, "ends loud");
        assert!(m.timing.total_ms >= m.timing.envelope_ms + m.timing.detect_ms);
    }

    #[test]
    fn hysteresis_holds_borderline_plateau_after_loud() {
        // loud 1s → mid 1s (inside the hi/lo band) → loud 1s: NO new run.
        // mid sine A=0.02 → rms≈0.0141; hi≈0.0212, lo≈0.0106 → inside band.
        let l = concat(&[tone(1.0, 0.5, 440.0), tone(1.0, 0.02, 440.0), tone(1.0, 0.5, 440.0)]);
        let r = l.clone();
        let m = map_chunk_silence(&l, &r, SR, 0, 0.0, &MapConfig::default());
        assert_eq!(m.silence_runs, 0, "hysteresis must hold the plateau loud");
    }

    #[test]
    fn hysteresis_absorbs_borderline_tail_after_silence() {
        // loud 0.5s → silence 1.5s → mid 1s (in-band) → loud: ONE run, tail absorbed.
        let l = concat(&[
            tone(0.5, 0.5, 440.0),
            vec![0.0; (SR as f32 * 1.5) as usize],
            tone(1.0, 0.02, 440.0),
            tone(1.0, 0.5, 440.0),
        ]);
        let r = l.clone();
        let m = map_chunk_silence(&l, &r, SR, 0, 0.0, &MapConfig::default());
        assert_eq!(m.silence_runs, 1, "mid tail must stay silent");
        // kept audio resumes only at the final loud second (≈3.0s mark).
        let last = m.kept_ranges_sec.last().copied().unwrap_or((0.0, 0.0));
        assert!((last.0 - 2.85).abs() < 0.4, "resume ≈3.0-keep: {last:?}");
    }

    #[test]
    fn all_silence_never_panics_and_reports_full() {
        let l = vec![0.0f32; SR as usize * 2];
        let r = l.clone();
        let m = map_chunk_silence(&l, &r, SR, 3, 120.0, &MapConfig::default());
        assert_eq!(m.chunk_index, 3);
        assert!((m.chunk_start_sec - 120.0).abs() < 1e-9);
        assert!(m.silence_fraction > 0.95, "fraction={}", m.silence_fraction);
        assert!(m.kept_ranges_sec.iter().all(|(a, b)| b > a));
    }

    #[test]
    fn empty_input_maps_empty() {
        let m = map_chunk_silence(&[], &[], SR, 0, 0.0, &MapConfig::default());
        assert_eq!(m.silence_runs, 0);
        assert!(m.kept_ranges_sec.is_empty());
    }

    #[test]
    fn split_plan_covers_exactly() {
        let p = split_plan(250.0, 60.0);
        assert_eq!(p.len(), 5);
        assert_eq!(p[0], (0, 0.0, 60.0));
        assert_eq!(p[4].0, 4);
        assert!((p[4].1 - 240.0).abs() < 1e-9);
        assert!((p[4].2 - 10.0).abs() < 1e-9);
        let total: f64 = p.iter().map(|(_, _, l)| l).sum();
        assert!((total - 250.0).abs() < 1e-9);
        assert_eq!(split_plan(30.0, 60.0).len(), 1);
        assert!(split_plan(0.0, 60.0).is_empty());
        assert!(split_plan(60.0, 0.0).is_empty());
    }

    /// Slice 1 acceptance vehicle: silence-map a ~4.5-minute synthetic clip
    /// in 60s chunks (the candidate chunk size) with embedded timing, and
    /// print the per-minute cost report. Run with `-- --nocapture`.
    /// Correctness asserted; timing printed (never asserted — not flaky).
    #[test]
    fn report_minute_cost_270s_clip() {
        // 7 × (30s dense mix + 5s silence) + 25s tail ≈ 270s, 7 gaps ≥ min run.
        let mut l: Vec<f32> = Vec::new();
        for k in 0..7 {
            // dense mix: two detuned sines (music-ish energy, deterministic)
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
        l.extend(tone(25.0, 0.4, 440.0));
        let r = l.clone();
        let total_secs = l.len() as f64 / SR as f64;
        assert!(total_secs > 265.0 && total_secs <= 300.0, "clip must be ≤5min: {total_secs}");

        let cfg = MapConfig::default();
        let plan = split_plan(total_secs, 60.0);
        let mut runs = 0usize;
        let mut map_ms = 0.0f32;
        for (idx, start, len) in &plan {
            let a = (*start * SR as f64) as usize;
            let b = ((start + len) * SR as f64) as usize;
            let m = map_chunk_silence(&l[a..b], &r[a..b], SR, *idx, *start, &cfg);
            runs += m.silence_runs;
            map_ms += m.timing.total_ms;
        }
        assert!(runs >= 6, "must find the planted gaps: {runs}");
        let per_min = minute_cost_ms(map_ms, total_secs);
        println!("LIVEMAP-REPORT total_secs={total_secs:.1} chunks={} gaps={runs} map_ms={map_ms:.1} minute_cost_ms={per_min:.1}",
            plan.len());
    }
}
