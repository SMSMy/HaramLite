//! Dynamics: RMS feed-forward compressor + look-ahead brickwall limiter.

/// Simple RMS compressor per channel pair (shared envelope = glued sound).
pub struct Compressor {
    threshold: f32, // linear
    ratio: f32,
    release_coef: f32,
    env: f32,
    makeup: f32,
}

impl Compressor {
    /// thresholds/ratios in musical defaults; makeup restores perceived level.
    pub fn new(sr: u32, threshold_db: f32, ratio: f32) -> Self {
        let release = 180e-3f32;
        Self {
            threshold: 10f32.powf(threshold_db / 20.0),
            ratio,
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
///
/// Peak tracking is a monotonic-deque sliding maximum — O(N) instead of the
/// old O(N × look_len) circular scan with a per-sample modulo (audit R-1,
/// which cost ~2.3B `idiv` ops ≈ +15-20s per 4-minute track).
pub struct Limiter {
    /// (sample_index, max(|l|,|r|)) — values non-increasing front→back.
    win: std::collections::VecDeque<(usize, f32)>,
    look_len: usize,
    ceiling: f32,
    gain_smooth: f32,
    sr: f32,
}

impl Limiter {
    pub fn new(sr: u32, lookahead_ms: f32, ceiling_db: f32) -> Self {
        let look_len = ((sr as f32 * lookahead_ms / 1000.0) as usize).max(8);
        Self {
            win: std::collections::VecDeque::with_capacity(look_len + 1),
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
            // Window = last (look_len + 1) samples [i-look_len, i] — exactly
            // what the old full-buffer scan + current sample computed.
            // NaN never affects the max (f32::max ignores NaN), so skip it.
            let m = l[i].abs().max(r[i].abs());
            if !m.is_nan() {
                while let Some(&(_, v)) = self.win.back() {
                    if v <= m {
                        self.win.pop_back();
                    } else {
                        break;
                    }
                }
                self.win.push_back((i, m));
            }
            // expire samples that fell out of the window
            while let Some(&(j, _)) = self.win.front() {
                if j + self.look_len < i {
                    self.win.pop_front();
                } else {
                    break;
                }
            }
            let peak = self.win.front().map_or(0.0, |&(_, v)| v);

            let need = if peak > self.ceiling { self.ceiling / peak } else { 1.0 };
            // fast attack, slow release on smoothed gain
            self.gain_smooth = if need < self.gain_smooth { need } else { need + (self.gain_smooth - need) * rel };

            l[i] *= self.gain_smooth;
            r[i] *= self.gain_smooth;
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

    /// Bit-exact reference of the PRE-R-1 implementation (circular buffer
    /// scan with modulo), used to prove the deque rewrite is output-identical.
    fn limiter_naive_ref(l: &mut [f32], r: &mut [f32], look_len: usize, ceiling: f32, sr: u32) {
        let mut delay_l = vec![0.0f32; look_len];
        let mut delay_r = vec![0.0f32; look_len];
        let mut pos = 0usize;
        let mut gain_smooth = 1.0f32;
        let rel = (-1.0 / (0.06 * sr as f32)).exp();
        for i in 0..l.len() {
            let mut peak = 0.0f32;
            for k in 0..look_len {
                let j = (pos + k) % look_len;
                peak = peak.max(delay_l[j].abs()).max(delay_r[j].abs());
            }
            peak = peak.max(l[i].abs()).max(r[i].abs());
            let need = if peak > ceiling { ceiling / peak } else { 1.0 };
            gain_smooth = if need < gain_smooth { need } else { need + (gain_smooth - need) * rel };
            let wl = l[i];
            let wr = r[i];
            delay_l[pos] = wl;
            delay_r[pos] = wr;
            l[i] = delay_l[pos] * gain_smooth;
            r[i] = delay_r[pos] * gain_smooth;
            pos = (pos + 1) % look_len;
        }
    }

    #[test]
    fn limiter_deque_matches_naive_bit_exact() {
        let sr = 44100u32;
        let lookahead_ms = 5.0f32;
        let look_len = ((sr as f32 * lookahead_ms / 1000.0) as usize).max(8);
        let ceiling = 10f32.powf(-1.0 / 20.0);

        // deterministic pseudo-random signal (LCG), incl. hot peaks + NaN spikes
        let mut seed: u32 = 0x9E3779B9;
        let mut next = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.4 - 1.2
        };
        let n = 4096 + 32; // crosses several look_len boundaries
        let mut l1: Vec<f32> = (0..n).map(|_| next()).collect();
        let mut r1: Vec<f32> = (0..n).map(|_| next()).collect();
        // NaN spikes: ignored by f32::max in both implementations
        l1[100] = f32::NAN;
        r1[100] = f32::NAN;
        let l_raw = l1.clone();
        let mut l2 = l1.clone();
        let mut r2 = r1.clone();

        Limiter::new(sr, lookahead_ms, -1.0).process(&mut l1, &mut r1);
        limiter_naive_ref(&mut l2, &mut r2, look_len, ceiling, sr);

        for (i, (a, b)) in l1.iter().zip(&l2).enumerate() {
            if a.to_bits() != b.to_bits() {
                panic!("L first mismatch at {i}: deque={a} naive={b} raw={}", l_raw[i]);
            }
        }
        for (i, (a, b)) in r1.iter().zip(&r2).enumerate() {
            if a.to_bits() != b.to_bits() {
                panic!("R first mismatch at {i}: deque={a} naive={b}");
            }
        }
    }

    /// Manual timing probe — NOT part of the regular suite (wall-clock
    /// asserts are flaky in CI). Run with:
    /// `cargo test --release limiter_timing_probe -- --ignored --nocapture`
    /// Baseline (pre-R-1, audit-measured): ~15-20s on this workload.
    #[test]
    #[ignore]
    fn limiter_timing_probe() {
        let sr = 44100u32;
        let n = sr as usize * 240; // 4-minute stereo ≈ 10.5M samples
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        let mut seed: u32 = 0x12345678;
        for v in l.iter_mut().chain(r.iter_mut()) {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *v = (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0;
        }
        let t0 = std::time::Instant::now();
        Limiter::new(sr, 5.0, -1.0).process(&mut l, &mut r);
        let dt = t0.elapsed();
        eprintln!(
            "LIMITER: {n} samples in {:.3}s ({:.1}M samples/s)",
            dt.as_secs_f32(),
            n as f64 / dt.as_secs_f64() / 1e6
        );
    }
}
