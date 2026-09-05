//! Live v1 Slice 3 — calibration harness on LABELED synthetic data.
//!
//! Ground truth BY CONSTRUCTION: every sample is synthesized here with a
//! known label, so the report below measures discrimination honestly.
//! Real-music / real-speech calibration needs a labeled corpus (future
//! work); this slice tells us what synthetic classes CAN and CANNOT tell us
//! about the v0 rule, and records the verdict. Accuracy on real audio is
//! NOT claimed.
//!
//! NOTE on scope: the harness reuses [`crate::decide`] scoring and
//! [`crate::livemap`] maps — it calibrates thresholds, never hardware.

// Dead until the player stage wires it; tests exercise everything.
#![allow(dead_code)]

use crate::decide::{score_windows, DecideConfig};
use crate::livemap::{map_chunk_silence, MapConfig};

/// Ground-truth label, known because we synthesized the sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Truth {
    /// Tonal chord mixes (music-like by construction).
    MusicLike,
    /// AM-modulated harmonic complexes (speech-like by construction).
    SpeechLike,
    /// Zero-mean white noise.
    Noise,
    /// Digital silence.
    Silence,
}

impl Truth {
    pub fn name(self) -> &'static str {
        match self {
            Truth::MusicLike => "music-like",
            Truth::SpeechLike => "speech-like",
            Truth::Noise => "noise",
            Truth::Silence => "silence",
        }
    }
}

pub struct Sample {
    pub label: Truth,
    pub l: Vec<f32>,
    pub r: Vec<f32>,
}

/// Pooled window-confidence statistics of one class.
pub struct ClassStats {
    pub windows: usize,
    pub mean_conf: f32,
    pub min_conf: f32,
    pub max_conf: f32,
}

/// Calibration report: per-class stats + margins + confusion at the two
/// approved operating thresholds (0.5 duck, 0.8 mute).
pub struct CalibReport {
    pub per_class: Vec<(Truth, ClassStats)>,
    /// min(music-like) − max(speech-like, noise). Silence is gated to 0 by
    /// construction and excluded from the margin.
    pub margin_music_vs_rest: f32,
    /// (threshold, true-positive-rate on music-like, false-positive-rate on
    /// speech-like + noise). Silence never scores (gated).
    pub confusion: Vec<(f32, f32, f32)>,
}

fn stats(confs: &[f32]) -> ClassStats {
    if confs.is_empty() {
        return ClassStats { windows: 0, mean_conf: 0.0, min_conf: 0.0, max_conf: 0.0 };
    }
    ClassStats {
        windows: confs.len(),
        mean_conf: confs.iter().sum::<f32>() / confs.len() as f32,
        min_conf: confs.iter().cloned().fold(f32::INFINITY, f32::min),
        max_conf: confs.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
    }
}

/// Score every sample and pool confidences by label. Silent windows contribute
/// nothing (gated upstream) — the silence class therefore yields zero windows
/// by design, which the tests assert.
pub fn run_calibration(samples: &[Sample], sr: u32, dcfg: &DecideConfig) -> CalibReport {
    let mcfg = MapConfig::default();
    let mut pooled: Vec<(Truth, Vec<f32>)> = vec![
        (Truth::MusicLike, Vec::new()),
        (Truth::SpeechLike, Vec::new()),
        (Truth::Noise, Vec::new()),
        (Truth::Silence, Vec::new()),
    ];
    for s in samples {
        let m = map_chunk_silence(&s.l, &s.r, sr, 0, 0.0, &mcfg);
        for w in score_windows(&s.l, &s.r, sr, &m, dcfg) {
            if !w.silent {
                if let Some((_, v)) = pooled.iter_mut().find(|(t, _)| *t == s.label) {
                    v.push(w.confidence);
                }
            }
        }
    }
    let get = |t: Truth| {
        pooled
            .iter()
            .find(|(x, _)| *x == t)
            .map(|(_, v)| stats(v))
            .unwrap_or(ClassStats { windows: 0, mean_conf: 0.0, min_conf: 0.0, max_conf: 0.0 })
    };
    let music = get(Truth::MusicLike);
    let speech = get(Truth::SpeechLike);
    let noise = get(Truth::Noise);
    let silence = get(Truth::Silence);

    let rest_max = speech.max_conf.max(noise.max_conf);
    let margin = if music.windows > 0 && (speech.windows + noise.windows) > 0 {
        music.min_conf - rest_max
    } else {
        f32::NEG_INFINITY
    };

    // Confusion needs the raw pools again for threshold sweeps.
    let pool_of = |t: Truth| -> Vec<f32> {
        pooled.iter().find(|(x, _)| *x == t).map(|(_, v)| v.clone()).unwrap_or_default()
    };
    let pm = pool_of(Truth::MusicLike);
    let pn: Vec<f32> = pool_of(Truth::SpeechLike)
        .into_iter()
        .chain(pool_of(Truth::Noise).into_iter())
        .collect();
    let rate = |pool: &[f32], thr: f32| {
        if pool.is_empty() {
            0.0
        } else {
            pool.iter().filter(|c| **c >= thr).count() as f32 / pool.len() as f32
        }
    };
    let confusion = [0.5f32, 0.8]
        .iter()
        .map(|thr| (*thr, rate(&pm, *thr), rate(&pn, *thr)))
        .collect();

    CalibReport {
        per_class: vec![
            (Truth::MusicLike, music),
            (Truth::SpeechLike, speech),
            (Truth::Noise, noise),
            (Truth::Silence, silence),
        ],
        margin_music_vs_rest: margin,
        confusion,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44100;

    fn sine(secs: f32, amp: f32, hz: f32) -> Vec<f32> {
        (0..(SR as f32 * secs) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin() * amp)
            .collect()
    }

    /// Deterministic zero-mean white noise (top 32 bits of LCG).
    fn noise(secs: f32, amp: f32, seed: u64) -> Vec<f32> {
        let mut x = seed | 1;
        (0..(SR as f32 * secs) as usize)
            .map(|_| {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                (((x >> 32) as f32) / (u32::MAX as f32) - 0.5) * 2.0 * amp
            })
            .collect()
    }

    /// Music-like by construction: root+fifth+octave chord with slow swell.
    fn music_like(secs: f32, root: f32) -> Vec<f32> {
        (0..(SR as f32 * secs) as usize)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let swell = 0.7 + 0.3 * (2.0 * std::f32::consts::PI * 0.25 * t).sin();
                swell
                    * (0.30 * (2.0 * std::f32::consts::PI * root * t).sin()
                        + 0.20 * (2.0 * std::f32::consts::PI * root * 1.5 * t).sin()
                        + 0.12 * (2.0 * std::f32::consts::PI * root * 2.0 * t).sin())
            })
            .collect()
    }

    /// Speech-like by construction: harmonic complex with 4 Hz syllabic AM
    /// and slow pitch wobble. Shares tonality with music ON PURPOSE — the
    /// calibration must reveal whether v0 features can separate them.
    fn speech_like(secs: f32, f0: f32) -> Vec<f32> {
        (0..(SR as f32 * secs) as usize)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let am = 0.55 + 0.45 * (2.0 * std::f32::consts::PI * 4.0 * t).sin();
                let f = f0 * (1.0 + 0.02 * (2.0 * std::f32::consts::PI * 0.7 * t).sin());
                am * (0.35 * (2.0 * std::f32::consts::PI * f * t).sin()
                    + 0.18 * (2.0 * std::f32::consts::PI * 2.0 * f * t).sin()
                    + 0.09 * (2.0 * std::f32::consts::PI * 3.0 * f * t).sin())
            })
            .collect()
    }

    fn mix(a: &[f32], b: &[f32]) -> Vec<f32> {
        a.iter().zip(b.iter()).map(|(x, y)| x + y).collect()
    }

    fn stereo(v: Vec<f32>) -> (Vec<f32>, Vec<f32>) {
        (v.clone(), v)
    }

    fn labeled_set() -> Vec<Sample> {
        let mut out = Vec::new();
        for root in [220.0, 277.0, 330.0] {
            let (l, r) = stereo(music_like(9.0, root));
            out.push(Sample { label: Truth::MusicLike, l, r });
        }
        for f0 in [120.0, 150.0, 190.0] {
            let (l, r) = stereo(speech_like(9.0, f0));
            out.push(Sample { label: Truth::SpeechLike, l, r });
        }
        for seed in [0x1111, 0x2222] {
            let (l, r) = stereo(noise(9.0, 0.35, seed));
            out.push(Sample { label: Truth::Noise, l, r });
        }
        // Robustness curve: tonal mix at +10 dB and 0 dB SNR (still music).
        let tone = music_like(9.0, 262.0);
        let nz = noise(9.0, 0.35, 0x9999);
        let rms = |v: &[f32]| (v.iter().map(|x| x * x).sum::<f32>() / v.len() as f32).sqrt();
        for snr_db in [10.0, 0.0] {
            let g = rms(&tone) / (rms(&nz) * 10f32.powf(snr_db / 20.0));
            let m: Vec<f32> = mix(&tone, &nz.iter().map(|x| x * g).collect::<Vec<_>>());
            let (l, r) = stereo(m);
            out.push(Sample { label: Truth::MusicLike, l, r });
        }
        let (l, r) = stereo(vec![0.0f32; SR as usize * 9]);
        out.push(Sample { label: Truth::Silence, l, r });
        out
    }

    #[test]
    fn silence_class_scores_nothing() {
        let (l, r) = stereo(vec![0.0f32; SR as usize * 6]);
        let rep = run_calibration(
            &[Sample { label: Truth::Silence, l, r }],
            SR,
            &DecideConfig::default(),
        );
        let sil = rep.per_class.iter().find(|(t, _)| *t == Truth::Silence).unwrap().1.windows;
        assert_eq!(sil, 0, "silence must be fully gated");
    }

    #[test]
    fn music_above_noise_on_synthetic() {
        // Structural assertion the harness itself must satisfy; the speech
        // position is RECORDED, never asserted (that is the finding).
        let rep = run_calibration(&labeled_set(), SR, &DecideConfig::default());
        let mean = |t: Truth| {
            let s = &rep.per_class.iter().find(|(x, _)| *x == t).unwrap().1;
            assert!(s.windows > 10, "{t:?} needs windows, got {}", s.windows);
            s.mean_conf
        };
        assert!(mean(Truth::MusicLike) > mean(Truth::Noise) + 0.15, "tonal must beat noise clearly");
    }

    /// Slice 3 acceptance vehicle: print the CALIBRATE-REPORT.
    /// Run with `-- --nocapture`. Verdict recorded in AUDIT.md, not asserted
    /// here beyond harness integrity (calibration outcomes must stay honest
    /// even when they are negative).
    #[test]
    fn report_calibration() {
        let rep = run_calibration(&labeled_set(), SR, &DecideConfig::default());
        for (t, s) in &rep.per_class {
            println!(
                "CALIBRATE-CLASS {} n={} mean={:.3} min={:.3} max={:.3}",
                t.name(),
                s.windows,
                s.mean_conf,
                s.min_conf,
                s.max_conf
            );
        }
        println!("CALIBRATE-MARGIN music_vs_rest={:.3}", rep.margin_music_vs_rest);
        for (thr, tpr, fpr) in &rep.confusion {
            println!("CALIBRATE-CONFUSION thr={thr} tpr={tpr:.2} fpr_nonsilence={fpr:.2}");
        }
        // Harness integrity only.
        assert!(rep.margin_music_vs_rest.is_finite());
    }
}
