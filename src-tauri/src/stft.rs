//! STFT / ISTFT — surgical port of `uvr_lib_v5/stft.py` semantics
//! (torch.stft / torch.istft with center=True, reflect padding, periodic Hann).
//!
//! CRITICAL: the FFT buffer must have its upper half cleared before every
//! inverse call. `process()` overwrites the entire buffer, so stale values
//! from the previous frame's output would feed the butterflies and overflow
//! to inf within ~20 frames.

use rustfft::{num_complex::Complex, FftPlanner};

pub const N_FFT: usize = 7680;
pub const HOP: usize = 1024;
pub const TRIM: usize = N_FFT / 2; // 3840
pub const DIM_F: usize = 3072;
pub const N_BINS: usize = N_FFT / 2 + 1; // 3841

/// torch hann_window(periodic=True)
fn hann_periodic(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5f32 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos())
        .collect()
}

/// torch F.pad(x, (pad,pad), 'reflect') — edge-exclusive mirror.
fn reflect_pad(data: &[f32], pad: usize) -> Vec<f32> {
    let len = data.len() as isize;
    let src = |idx: isize| data[idx.rem_euclid((2 * len - 2).max(1)) as usize];
    let mut out = Vec::with_capacity(data.len() + 2 * pad);
    for k in (1..=pad).rev() {
        out.push(src(k as isize));
    }
    out.extend_from_slice(data);
    for k in 0..pad {
        out.push(src(len - 2 - k as isize));
    }
    out
}

pub struct StftPlan {
    forward: std::sync::Arc<dyn rustfft::Fft<f32>>,
    inverse: std::sync::Arc<dyn rustfft::Fft<f32>>,
    window: Vec<f32>,
}

impl Default for StftPlan {
    fn default() -> Self {
        Self::new()
    }
}

impl StftPlan {
    pub fn new() -> Self {
        let mut planner = FftPlanner::<f32>::new();
        Self {
            forward: planner.plan_fft_forward(N_FFT),
            inverse: planner.plan_fft_inverse(N_FFT),
            window: hann_periodic(N_FFT),
        }
    }

    /// Forward STFT of one channel.
    /// Returns (re, im) each [DIM_F][frames]; frames = len/HOP + 1
    /// (valid when len % HOP == 0, guaranteed by the demix chunking).
    pub fn forward(&self, channel: &[f32]) -> (Vec<Vec<f32>>, Vec<Vec<f32>>) {
        let pad = TRIM.min(channel.len().saturating_sub(1));
        let padded = reflect_pad(channel, pad);
        let frames = channel.len() / HOP + 1;

        let mut re = vec![vec![0.0f32; frames]; DIM_F];
        let mut im = vec![vec![0.0f32; frames]; DIM_F];
        let mut buf: Vec<Complex<f32>> = Vec::with_capacity(N_FFT);

        for t in 0..frames {
            let start = t * HOP;
            buf.clear();
            for n in 0..N_FFT {
                let idx = start + n;
                let s = if idx < padded.len() { padded[idx] } else { 0.0 };
                buf.push(Complex::new(s * self.window[n], 0.0));
            }
            self.forward.process(&mut buf);
            for f in 0..DIM_F.min(N_BINS) {
                re[f][t] = buf[f].re;
                im[f][t] = buf[f].im;
            }
        }
        (re, im)
    }

    /// Inverse STFT. `spec_re/spec_im`: [DIM_F][frames] one-sided spectrum.
    /// Returns exactly `(frames-1)*HOP` samples (torch.istft center=True).
    pub fn inverse(&self, spec_re: &[Vec<f32>], spec_im: &[Vec<f32>], frames: usize) -> Vec<f32> {
        let out_len = (frames - 1) * HOP;
        let total = out_len + N_FFT;
        let mut acc = vec![0.0f32; total];
        let mut env = vec![0.0f32; total];

        // One full spectrum buffer; upper half re-zeroed every frame (see
        // module docs).
        let mut frame: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); N_FFT];

        // torch.istft internally uses irfft, which exploits Hermitian symmetry:
        // AC bins contribute twice, DC and Nyquist once. Our plain complex
        // IDFT of the one-sided spectrum needs the same weighting explicitly,
        // otherwise every stem comes out at exactly half amplitude.
        let bin_weight = |f: usize| -> f32 {
            if f == 0 || f == N_BINS - 1 { 1.0 } else { 2.0 }
        };

        for t in 0..frames {
            for f in 0..N_BINS {
                frame[f] = if f < DIM_F {
                    Complex::new(spec_re[f][t], spec_im[f][t]) * bin_weight(f)
                } else {
                    Complex::new(0.0, 0.0) // freq padding done by python inverse
                };
            }
            for f in N_BINS..N_FFT {
                frame[f] = Complex::new(0.0, 0.0);
            }

            self.inverse.process(&mut frame);

            let base = t * HOP;
            for n in 0..N_FFT {
                acc[base + n] += frame[n].re / N_FFT as f32 * self.window[n];
                env[base + n] += self.window[n] * self.window[n];
            }
        }

        (TRIM..TRIM + out_len)
            .map(|i| if env[i] > 1e-9 { acc[i] / env[i] } else { 0.0 })
            .collect()
    }

    /// Full forward→inverse identity check helper (test-only).
    #[cfg(test)]
    pub fn round_trip(&self, x: &[f32]) -> Vec<f32> {
        let (re, im) = self.forward(x);
        let frames = x.len() / HOP + 1;
        self.inverse(&re, &im, frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stft_istft_round_trip_is_faithful_interior() {
        let plan = StftPlan::new();
        // length divisible by hop → exact frame math
        let len = HOP * 255; // 261120 like a real chunk
        let x: Vec<f32> = (0..len)
            .map(|i| {
                let t = i as f32 / 44100.0;
                0.4 * (2.0 * std::f32::consts::PI * 440.0 * t).sin()
                    + 0.2 * (2.0 * std::f32::consts::PI * 1320.0 * t).cos()
            })
            .collect();

        let y = plan.round_trip(&x);
        assert_eq!(y.len(), len, "istft must return (T-1)*hop samples");

        let bad = y.iter().filter(|v| !v.is_finite()).count();
        assert_eq!(bad, 0, "non-finite outputs: {bad}");

        // interior region (away from reflect-padded edges) must match closely
        // Cross-correlation note: for multi-tone signals the correlation
        // landscape has many near-equal peaks, so a single argmax lag is not
        // evidence of misalignment. We rely on direct sample comparison below.
        let mut max_err: f32 = 0.0;
        let mut worst = 0usize;
        for i in (TRIM..len - TRIM).step_by(7) {
            let e = (x[i] - y[i]).abs();
            if e > max_err {
                max_err = e;
                worst = i;
            }
        }
        // Error profile: sample three bands (start/middle/end of interior)
        let band = |a: usize, b: usize| -> f32 {
            (a..b).step_by(11).map(|i| (x[i] - y[i]).abs()).fold(0.0f32, f32::max)
        };
        assert!(
            max_err < 2e-3,
            "round-trip error {max_err} at i={worst} (offset_from_trim={}) bands: start={} mid={} end={}",
            worst - TRIM,
            band(TRIM, TRIM + 20000),
            band(len / 2 - 10000, len / 2 + 10000),
            band(len - TRIM - 20000, len - TRIM)
        );
    }

    #[test]
    fn inverse_of_forward_stays_finite_many_frames() {
        let plan = StftPlan::new();
        let win: Vec<f32> = (0..N_FFT)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / N_FFT as f32).cos())
            .collect();

        for t in 0..40usize {
            let input: Vec<f32> =
                (0..N_FFT).map(|n| ((t * HOP + n) as f32 * 0.01).sin() * win[n]).collect();
            let (re, im) = plan.forward(&input);
            let frames = input.len() / HOP + 1;
            let y = plan.inverse(&re, &im, frames);
            assert!(y.iter().all(|v| v.is_finite()), "t={t} produced non-finite");
        }
    }
}

#[cfg(test)]
mod spectral_purity {
    use super::*;

    #[test]
    fn tone_at_bin_k_lands_in_expected_bins() {
        let plan = StftPlan::new();
        let len = HOP * 255;
        let k = 76usize;
        let x: Vec<f32> = (0..len)
            .map(|n| (2.0 * std::f32::consts::PI * k as f32 * n as f32 / N_FFT as f32).sin())
            .collect();
        let (re, im) = plan.forward(&x);
        let t = 128;

        // collect energies per bin
        let mut peaks: Vec<(usize, f32)> = (0..DIM_F)
            .map(|f| {
                let m = (re[f][t] * re[f][t] + im[f][t] * im[f][t]).sqrt();
                (f, m)
            })
            .collect();
        peaks.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        eprintln!(
            "PURE TONE top bins: {:?} {:?} {:?} (expect dominant near k={k})",
            peaks[0], peaks[1], peaks[2]
        );
        assert!(peaks[0].0.abs_diff(k) <= 1 || peaks[0].0.abs_diff(N_FFT - k) <= 1,
            "energy leaked: dominant bin {}", peaks[0].0);
    }
}

