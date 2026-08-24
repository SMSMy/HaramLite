//! M3 — Song-mode enhancement chain orchestrator.
//!
//! Order (musically deliberate):
//!   1. de-muffle highpass (70 Hz)          — remove separation mud
//!   2. harmonic exciter (+presence)        — "bring it back to life"
//!   3. room reverb (send blend)            — glue/air
//!   4. pingpong delay                      — width
//!   5. compressor                          — consistency
//!   6. silence cut                         — songs shouldn't keep dead air
//!   7. LUFS normalize → −14 LUFS           — streaming loudness
//!   8. look-ahead limiter → −1 dBTP        — transparent ceiling

use std::path::Path;

use crate::{dynamics::{Compressor, Limiter}, filters::{Biquad, Exciter}, loudness::normalize_to_target, reverb_delay::{Freeverb, PingpongDelay}, silence::{cut_silence, SilenceConfig}};

pub struct SongEffectsConfig {
    pub highpass_hz: f32,
    pub exciter_amount: f32,
    pub reverb_room: f32,
    pub reverb_mix: f32,
    pub delay_ms: f32,
    pub delay_feedback: f32,
    pub delay_mix: f32,
    pub comp_threshold_db: f32,
    pub comp_ratio: f32,
    pub target_lufs: f32,
    pub ceiling_db: f32,
    pub silence: SilenceConfig,
}

impl Default for SongEffectsConfig {
    fn default() -> Self {
        Self {
            highpass_hz: 70.0,
            exciter_amount: 0.30,
            reverb_room: 0.45,
            reverb_mix: 0.12,
            delay_ms: 240.0,
            delay_feedback: 0.22,
            delay_mix: 0.10,
            comp_threshold_db: -18.0,
            comp_ratio: 2.5,
            target_lufs: -14.0,
            ceiling_db: -1.0,
            silence: SilenceConfig::default(),
        }
    }
}

/// Apply the full song chain in-place on stereo buffers.
/// Returns kept ranges in SECONDS (for mirroring cuts on the video track).
pub fn enhance_song(
    l: &mut Vec<f32>,
    r: &mut Vec<f32>,
    sr: u32,
    cfg: &SongEffectsConfig,
) -> Result<Vec<(f64, f64)>, String> {
    let s = sr as f32;

    // 1) de-muffle
    let mut hp_l = Biquad::highpass(s, cfg.highpass_hz);
    let mut hp_r = Biquad::highpass(s, cfg.highpass_hz);
    for i in 0..l.len().min(r.len()) {
        l[i] = hp_l.process(l[i]);
        r[i] = hp_r.process(r[i]);
    }

    // 2) exciter
    let mut ex_l = Exciter::new(sr, cfg.exciter_amount);
    let mut ex_r = Exciter::new(sr, cfg.exciter_amount);
    for i in 0..l.len().min(r.len()) {
        l[i] = ex_l.process(l[i]);
        r[i] = ex_r.process(r[i]);
    }

    // 3+4) space & width
    Freeverb::new(sr, cfg.reverb_room, cfg.reverb_mix).process(l, r);
    PingpongDelay::new(sr, cfg.delay_ms, cfg.delay_feedback, cfg.delay_mix).process(l, r);

    // 5) dynamics
    Compressor::new(sr, cfg.comp_threshold_db, cfg.comp_ratio).process(l, r);

    // 6) silence cut (songs only) — capture ranges for video mirroring
    let kept_ranges = crate::silence::compute_kept_ranges(l, r, sr, &cfg.silence);
    let removed = cut_silence(l, r, sr, &cfg.silence);
    tracing::info!(target: "dsp", "silence cut removed {:.1}%", removed * 100.0);
    let ranges_sec: Vec<(f64, f64)> =
        kept_ranges.iter().map(|(a, b)| (*a as f64 / s as f64, *b as f64 / s as f64)).collect();

    // 7) loudness
    let gain_db = normalize_to_target(l, r, sr, cfg.target_lufs);
    tracing::info!(target: "dsp", "loudness gain {gain_db:+.2} dB → {} LUFS", cfg.target_lufs);

    // 8) ceiling
    Limiter::new(sr, 5.0, cfg.ceiling_db).process(l, r);

    Ok(ranges_sec)
}

/// Convenience wrapper reading/writing WAV files (pipeline stage).
/// Returns kept ranges in seconds (empty when nothing was cut).
pub fn enhance_song_file(
    wav_path: &Path,
    out_path: &Path,
    cfg: &SongEffectsConfig,
) -> Result<Vec<(f64, f64)>, String> {
    let (mut l, mut r, sr) =
        crate::separator::read_wav_stereo(wav_path).map_err(|e| e.to_string())?;
    let ranges = enhance_song(&mut l, &mut r, sr, cfg)?;
    crate::separator::write_wav_stereo_f32_pub(out_path, &l, &r, sr)
        .map_err(|e| e.to_string())?;
    Ok(ranges)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo_tone(sr: u32, secs: f32, amp: f32) -> (Vec<f32>, Vec<f32>) {
        let v: Vec<f32> = (0..(sr as f32 * secs) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * 660.0 * i as f32 / sr as f32).sin() * amp)
            .collect();
        (v.clone(), v.clone())
    }

    #[test]
    fn full_chain_stays_finite_and_hits_target() {
        let sr = 44100u32;
        let (mut l, mut r) = stereo_tone(sr, 4.0, 0.5);
        enhance_song(&mut l, &mut r, sr, &SongEffectsConfig::default()).expect("chain");

        assert_eq!(l.len(), r.len());
        assert!(l.iter().all(|v| v.is_finite()));
        let peak = l.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak <= 0.9 + 0.02, "limiter ceiling violated: {peak}");
        let lufs = crate::loudness::integrated_lufs(&l, &r, sr);
        assert!((lufs - (-14.0)).abs() < 1.2, "post-chain loudness {lufs}");
    }
}
