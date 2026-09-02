//! Integrated loudness (ITU-R BS.1770 gating) + target normalization.
//!
//! K-weighting is implemented as RBJ high-shelf (+4 dB @ ~1.68 kHz) followed
//! by a 2nd-order high-pass (~60 Hz RLB intent) — the standard practical
//! approximation of the spec filter, valid at any sample rate. Gating
//! (absolute −70 LUFS, relative −10 LU) follows the spec exactly.

use crate::filters::Biquad;

struct KWeight {
    shelf: Biquad,
    hp: Biquad,
}

impl KWeight {
    fn new(sr: u32) -> Self {
        Self {
            shelf: Biquad::high_shelf(sr, 1680.0, 3.999843),
            hp: Biquad::highpass(sr as f32, 55.0),
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        self.hp.process(self.shelf.process(x))
    }
}

/// Mean square of one filtered channel over a 400ms block.
fn block_ms(channel_filtered: &[f32]) -> f64 {
    if channel_filtered.is_empty() {
        return 0.0;
    }
    channel_filtered.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>()
        / channel_filtered.len() as f64
}

/// Integrated gated loudness of stereo (L,R). Weights: L/R = 1.0.
pub fn integrated_lufs(l: &[f32], r: &[f32], sr: u32) -> f32 {
    let block = (sr as usize * 2) / 5; // 400 ms
    let hop = sr as usize / 10; // 100 ms — 75% overlap per ITU-R BS.1770
    if l.len() < block {
        return -70.0;
    }

    // Audit R-3: K-weight the WHOLE channel first. The shelf/high-pass are
    // stateful IIRs — running them per overlapping window made their state
    // jump 300ms back in time every 100ms hop, corrupting every measurement.
    let mut kl = KWeight::new(sr);
    let mut kr = KWeight::new(sr);
    let fl: Vec<f32> = l.iter().map(|&v| kl.process(v)).collect();
    let fr: Vec<f32> = r.iter().map(|&v| kr.process(v)).collect();

    // Keep LINEAR mean-square power per window here. Gating must average
    // POWER and convert to dB only at the end (ITU-R BS.1770): averaging the
    // per-window LUFS (dB) values biases the measurement low and makes
    // normalization over-amplify dynamic material.
    let mut blocks: Vec<f64> = Vec::new();
    let mut start = 0usize;
    while start + block <= l.len() {
        let z = block_ms(&fl[start..start + block]) + block_ms(&fr[start..start + block]);
        blocks.push(z.max(1e-20));
        start += hop;
    }

    if blocks.is_empty() {
        return -70.0;
    }

    // absolute gate −70 LUFS ⇔ power > 10^((−70 + 0.691) / 10)
    let abs_gate_z = 10f64.powf((-70.0 + 0.691) / 10.0);
    let abs_gated: Vec<f64> = blocks.iter().cloned().filter(|z| *z > abs_gate_z).collect();
    if abs_gated.is_empty() {
        return -70.0;
    }
    let mean_z = abs_gated.iter().sum::<f64>() / abs_gated.len() as f64;

    // relative gate −10 LU below ungated-mean ⇔ z > mean_z / 10
    // (−10 LU ⇔ power/10, since LUFS = −0.691 + 10·log10(z))
    let rel_threshold_z = mean_z / 10.0;
    let rel_gated: Vec<f64> =
        abs_gated.iter().cloned().filter(|z| *z > rel_threshold_z).collect();
    let final_z = rel_gated.iter().sum::<f64>() / rel_gated.len().max(1) as f64;

    (-0.691 + 10.0 * final_z.log10()) as f32
}

/// Apply gain so integrated loudness == target; returns applied gain in dB.
pub fn normalize_to_target(l: &mut [f32], r: &mut [f32], sr: u32, target_lufs: f32) -> f32 {
    let measured = integrated_lufs(l, r, sr);
    if measured <= -69.9 {
        tracing::warn!(target: "dsp", "loudness measurement silent ({measured}) — skipping normalize");
        return 0.0;
    }
    let gain_db = target_lufs - measured;
    let g = 10f32.powf(gain_db / 20.0);
    for v in l.iter_mut().chain(r.iter_mut()) {
        *v *= g;
    }
    gain_db
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(sr: u32, f: f32, secs: f32, amp: f32) -> Vec<f32> {
        // 997 Hz — the spec's reference tone region
        (0..(sr as f32 * secs) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * f * i as f32 / sr as f32).sin() * amp)
            .collect()
    }

    #[test]
    fn sine_loudness_matches_reference_math() {
        // Full-scale 997Hz sine, identical both channels.
        // Per-channel mean square ≈ A²/2 → ΣGz = A² → L ≈ −0.691 dB for A=1.
        let sr = 44100u32;
        let x = tone(sr, 997.0, 3.0, 1.0);
        let lufs = integrated_lufs(&x, &x.clone(), sr);
        assert!(
            (lufs - (-0.691)).abs() < 1.0,
            "expected ≈−0.69 LUFS for FS sine, got {lufs}"
        );
    }

    #[test]
    fn normalization_hits_target() {
        let sr = 44100u32;
        let mut l = tone(sr, 997.0, 3.0, 0.25);
        let mut r = tone(sr, 997.0, 3.0, 0.25);
        let before = integrated_lufs(&l, &r, sr);
        let gain = normalize_to_target(&mut l, &mut r, sr, -14.0);
        let after = integrated_lufs(&l, &r, sr);
        assert!((after - -14.0).abs() < 0.4, "after={after}");
        assert!((gain - (-14.0 - before)).abs() < 0.6);
    }

    #[test]
    fn quieter_signal_needs_positive_gain() {
        let sr = 44100u32;
        let mut l = tone(sr, 997.0, 2.5, 0.05);
        let mut r = tone(sr, 997.0, 2.5, 0.05);
        normalize_to_target(&mut l, &mut r, sr, -14.0);
        let peak = l.iter().fold(0.0f32, |m, v| m.max(*v));
        assert!(peak > 0.18 && peak < 1.05, "peak after normalize = {peak}");
    }

    #[test]
    fn kweight_runs_continuously_not_per_window() {
        // Impulse placed exactly on a 100ms hop boundary. The pre-R-3 code
        // re-filtered every window with zero state, so the window STARTING at
        // the impulse saw a different energy than the continuous run. This
        // asserts the public function matches the continuous pipeline exactly.
        let sr = 44100u32;
        let n = sr as usize * 2;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        let at = sr as usize / 10; // 100 ms — a hop boundary
        l[at] = 0.9;
        r[at] = 0.9;

        let measured = integrated_lufs(&l, &r, sr);

        // reference: continuous filtering + identical windowing/gating
        let mut kl = KWeight::new(sr);
        let mut kr = KWeight::new(sr);
        let fl: Vec<f32> = l.iter().map(|&v| kl.process(v)).collect();
        let fr: Vec<f32> = r.iter().map(|&v| kr.process(v)).collect();
        let block = (sr as usize * 2) / 5;
        let hop = sr as usize / 10;
        let mut blocks: Vec<f64> = Vec::new();
        let mut start = 0usize;
        while start + block <= n {
            let z = block_ms(&fl[start..start + block]) + block_ms(&fr[start..start + block]);
            blocks.push(z.max(1e-20));
            start += hop;
        }
        let abs_gate_z = 10f64.powf((-70.0 + 0.691) / 10.0);
        let abs_gated: Vec<f64> = blocks.iter().cloned().filter(|z| *z > abs_gate_z).collect();
        let mean_z = abs_gated.iter().sum::<f64>() / abs_gated.len().max(1) as f64;
        let rel_gated: Vec<f64> =
            abs_gated.iter().cloned().filter(|z| *z > mean_z / 10.0).collect();
        let expected = -0.691
            + 10.0
                * (rel_gated.iter().sum::<f64>() / rel_gated.len().max(1) as f64)
                    .max(1e-20)
                    .log10();

        assert!(
            (measured as f64 - expected).abs() < 1e-6,
            "integrated_lufs diverged from continuous filtering: {measured} vs {expected}"
        );
    }
}
