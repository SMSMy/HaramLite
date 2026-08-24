//! Dynamics: RMS feed-forward compressor + look-ahead brickwall limiter.

/// Simple RMS compressor per channel pair (shared envelope = glued sound).
pub struct Compressor {
    sr: f32,
    threshold: f32, // linear
    ratio: f32,
    attack_coef: f32,
    release_coef: f32,
    env: f32,
    makeup: f32,
}

impl Compressor {
    /// thresholds/ratios in musical defaults; makeup restores perceived level.
    pub fn new(sr: u32, threshold_db: f32, ratio: f32) -> Self {
        let attack = 20e-3f32;
        let release = 180e-3f32;
        Self {
            sr: sr as f32,
            threshold: 10f32.powf(threshold_db / 20.0),
            ratio,
            attack_coef: (-1.0 / (attack * sr as f32)).exp(),
            release_coef: (-1.0 / (release * sr as f32)).exp(),
            env: 0.0,
            makeup: 1.0, // level handled downstream by LUFS normalization
        }
    }

    pub fn process(&mut self, l: &mut Vec<f32>, r: &mut Vec<f32>) {
        let n = l.len().min(r.len());
        // Instant-attack peak follower: env jumps to peaks immediately,
        // decays exponentially — required when carrier period << attack ms.
        let release_factor = self.release_coef;
        for i in 0..n {
            let m = l[i].abs().max(r[i].abs());
            self.env = m.max(self.env * release_factor);

            let over_db = if self.env > self.threshold {
                20.0 * (self.env / self.threshold).log10() * (1.0 - 1.0 / self.ratio)
            } else {
                0.0
            };
            let gain = 10f32.powf(-over_db / 20.0) * self.makeup;

            l[i] *= gain;
            r[i] *= gain;
        }
    }
}

/// Look-ahead limiter with smooth gain smoothing; ceiling in dBFS (−1 typical).
pub struct Limiter {
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    pos: usize,
    look_len: usize,
    ceiling: f32,
    gain_smooth: f32,
    sr: f32,
}

impl Limiter {
    pub fn new(sr: u32, lookahead_ms: f32, ceiling_db: f32) -> Self {
        let look_len = ((sr as f32 * lookahead_ms / 1000.0) as usize).max(8);
        Self {
            delay_l: vec![0.0; look_len],
            delay_r: vec![0.0; look_len],
            pos: 0,
            look_len,
            ceiling: 10f32.powf(ceiling_db / 20.0),
            gain_smooth: 1.0,
            sr: sr as f32,
        }
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        // release time constant ~60ms
        let rel = (-1.0 / (0.06 * self.sr)).exp();
        let n = l.len().min(r.len());
        for i in 0..n {
            // required gain from the NEXT look-ahead window
            let mut peak = 0.0f32;
            for k in 0..self.look_len {
                let j = (self.pos + k) % self.look_len;
                peak = peak.max(self.delay_l[j].abs()).max(self.delay_r[j].abs());
            }
            // include current sample too (about to be delayed)
            peak = peak.max(l[i].abs()).max(r[i].abs());

            let need = if peak > self.ceiling { self.ceiling / peak } else { 1.0 };
            // fast attack, slow release on smoothed gain
            self.gain_smooth = if need < self.gain_smooth { need } else { need + (self.gain_smooth - need) * rel };

            // push current into delay line, emit delayed sample scaled
            let wl = l[i];
            let wr = r[i];
            self.delay_l[self.pos] = wl;
            self.delay_r[self.pos] = wr;
            l[i] = self.delay_l[self.pos] * self.gain_smooth;
            r[i] = self.delay_r[self.pos] * self.gain_smooth;
            self.pos = (self.pos + 1) % self.look_len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(sr: u32, f: f32, secs: f32, amp: f32) -> Vec<f32> {
        (0..(sr as f32 * secs) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * f * i as f32 / sr as f32).sin() * amp)
            .collect()
    }

    #[test]
    fn compressor_reduces_loud_peaks_more_than_quiet_parts() {
        let sr = 44100u32;
        let mut l = tone(sr, 440.0, 0.5, 0.9); // above −18dBFS threshold
        let mut r = tone(sr, 441.0, 0.5, 0.9);
        let pre_peak = l.iter().fold(0.0f32, |m, v| m.max(*v));
        let mut comp = Compressor::new(sr, -18.0, 3.0);
        comp.process(&mut l, &mut r);
        let post_peak = l.iter().fold(0.0f32, |m, v| m.max(*v));
        assert!(
            post_peak < pre_peak * 0.75 && post_peak.is_finite(),
            "compression must tame peaks: {pre_peak} → {post_peak}"
        );
    }

    #[test]
    fn limiter_never_exceeds_ceiling() {
        let sr = 44100u32;
        let mut l = tone(sr, 1000.0, 0.4, 1.4); // deliberately hot
        let mut r = tone(sr, 1500.0, 0.4, 1.2);
        let mut lim = Limiter::new(sr, 5.0, -1.0); // −1 dBFS ≈ 0.891
        lim.process(&mut l, &mut r);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak <= 0.891 + 1e-3, "ceiling violated: {peak}");
    }
}
