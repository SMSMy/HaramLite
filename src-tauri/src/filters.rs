//! Core filters (RBJ biquad cookbook) + harmonic exciter.

/// Transposed-direct-form-II biquad. Processes one channel in place.
#[derive(Clone)]
pub struct Biquad {
    b0: f32, b1: f32, b2: f32,
    a1: f32, a2: f32,
    z1: f32, z2: f32,
}

impl Biquad {
    fn from_coeffs(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Self {
            b0: (b0 / a0) as f32, b1: (b1 / a0) as f32, b2: (b2 / a0) as f32,
            a1: (a1 / a0) as f32, a2: (a2 / a0) as f32,
            z1: 0.0, z2: 0.0,
        }
    }

    /// RBJ highpass, Q ≈ 0.707 (Butterworth).
    pub fn highpass(sr: f32, freq: f32) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * freq as f64 / sr as f64;
        let (s, c) = w0.sin_cos();
        let alpha = s / (2.0 * 0.7071135624381276);
        Self::from_coeffs(
            (1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0,
            1.0 + alpha, -2.0 * c, 1.0 - alpha,
        )
    }

    /// RBJ peaking EQ (dB gain, musical Q).
    pub fn peaking(sr: f32, freq: f32, q: f32, gain_db: f32) -> Self {
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq as f64 / sr as f64;
        let (s, c) = w0.sin_cos();
        let alpha = s / (2.0 * q as f64);
        Self::from_coeffs(
            1.0 + alpha * a, -2.0 * c, 1.0 - alpha * a,
            1.0 + alpha / a, -2.0 * c, 1.0 - alpha / a,
        )
    }

    /// RBJ high-shelf (+gain_db above corner freq), S=1 — K-weighting stage 1.
    pub fn high_shelf(sr: u32, freq: f32, gain_db: f32) -> Self {
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq as f64 / sr as f64;
        let (s, c) = w0.sin_cos();
        let sq_a = a.sqrt();
        let alpha = s / 2.0 * std::f64::consts::SQRT_2; // cookbook S=1 form
        let t = 2.0 * sq_a * alpha;
        Self::from_coeffs(
            a * ((a + 1.0) + (a - 1.0) * c + t),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - t),
            (a + 1.0) - (a - 1.0) * c + t,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - t,
        )
    }

    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    pub fn process_block(&mut self, data: &mut [f32]) {
        for v in data.iter_mut() {
            *v = self.process(*v);
        }
    }
}

/// Harmonic exciter: HP the signal, soft-clip it, blend back.
/// Removes the "muffled" post-separation feel without harshness.
pub struct Exciter {
    hp: Biquad,          // band we generate harmonics from
    hp2: Biquad,         // second-order for steeper focus
    amount: f32,         // wet blend 0..1
}

impl Exciter {
    pub fn new(sr: u32, amount: f32) -> Self {
        Self {
            hp: Biquad::highpass(sr as f32, 2500.0),
            hp2: Biquad::highpass(sr as f32, 5000.0),
            amount,
        }
    }

    pub fn process(&mut self, x: f32) -> f32 {
        let band = self.hp.process(x);
        let band = self.hp2.process(band);
        // harmonic RESIDUAL: x − tanh(x) isolates pure odd harmonics
        // (fundamental untouched), scaled back up to musical level.
        let residual = band - band.tanh();
        x + residual * (self.amount * 8.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gen(sr: u32, freq: f32, secs: f32) -> Vec<f32> {
        let n = (sr as f32 * secs) as usize;
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr as f32).sin())
            .collect()
    }

    fn rms(d: &[f32]) -> f32 {
        (d.iter().map(|v| v * v).sum::<f32>() / d.len().max(1) as f32).sqrt()
    }

    #[test]
    fn highpass_kills_dc_passes_treble() {
        let sr = 44100u32;
        let mut dc = vec![0.5f32; sr as usize]; // DC
        Biquad::highpass(sr as f32, 80.0).process_block(&mut dc);
        // steady state settles toward ~0 (allow long tail via RMS of last half)
        assert!(rms(&dc[sr as usize / 2..]) < 1e-3);

        let mut treble = gen(sr, 5000.0, 0.5);
        let in_rms = rms(&treble);
        Biquad::highpass(sr as f32, 80.0).process_block(&mut treble);
        let out_rms = rms(&treble[sr as usize / 4..]);
        assert!(
            (out_rms / in_rms - 1.0).abs() < 0.05,
            "5kHz must pass: {out_rms}/{in_rms}"
        );
    }

    #[test]
    fn exciter_generates_third_harmonic() {
        let sr = 44100u32;
        let f0 = 3000.0f32;
        let mut sig = gen(sr, f0, 0.3);
        let mut ex = Exciter::new(sr, 0.35);
        for v in sig.iter_mut() {
            *v = ex.process(*v);
        }
        assert!(sig.iter().all(|v| v.is_finite()));

        // Goertzel at 3·f0 (9 kHz): harmonic must now exist with real energy
        let n = sig.len();
        let k_f = 3.0 * f0;
        let w = 2.0 * std::f32::consts::PI * k_f / sr as f32;
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        let coeff = 2.0 * w.cos();
        for &v in &sig {
            let s = v + coeff * s1 - s2;
            s2 = s1;
            s1 = s;
        }
        let mag = (s1 * s1 + s2 * s2 - coeff * s1 * s2).sqrt() / (n as f32 / 2.0);
        assert!(mag > 5e-4, "9kHz harmonic too weak: {mag}");
    }
}
