//! Freeverb-style reverb (Schoenefeldt tunings) + stereo pingpong delay.

/// Freeverb comb filter.
struct Comb {
    buf: Vec<f32>,
    idx: usize,
    feedback: f32,
    damp1: f32,
    damp2: f32,
    store: f32,
}

impl Comb {
    fn new(size: usize, feedback: f32, damp: f32) -> Self {
        Self { buf: vec![0.0; size], idx: 0, feedback, damp1: damp, damp2: 1.0 - damp, store: 0.0 }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.buf[self.idx];
        self.store = y * self.damp2 + self.store * self.damp1;
        self.buf[self.idx] = x + self.store * self.feedback;
        self.idx += 1;
        if self.idx >= self.buf.len() {
            self.idx = 0; // audit R-4: branch beats per-sample `%` (idiv)
        }
        y
    }
}

/// Freeverb allpass.
struct Allpass {
    buf: Vec<f32>,
    idx: usize,
    feedback: f32,
}

impl Allpass {
    fn new(size: usize, feedback: f32) -> Self {
        Self { buf: vec![0.0; size], idx: 0, feedback }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let b = self.buf[self.idx];
        let y = -x + b;
        self.buf[self.idx] = x + b * self.feedback;
        self.idx += 1;
        if self.idx >= self.buf.len() {
            self.idx = 0; // audit R-4: branch beats per-sample `%` (idiv)
        }
        y
    }
}

// Freeverb classic tunings (samples @44.1k; scaled for other rates).
const COMB_TUNING: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLP_TUNING: [usize; 4] = [556, 441, 341, 225];
const STEREO_SPREAD: usize = 23;

pub struct Freeverb {
    combs_l: Vec<Comb>,
    combs_r: Vec<Comb>,
    allps_l: Vec<Allpass>,
    allps_r: Vec<Allpass>,
    wet: f32,
    dry: f32,
}

impl Freeverb {
    /// room 0..1 controls damping/decay feel; mix = wet blend of the SEND.
    pub fn new(sr: u32, room: f32, mix: f32) -> Self {
        let scale = sr as f64 / 44100.0;
        let scaled = |s: usize| ((s as f64 * scale).round() as usize).max(2);

        let fb = 0.72 + room * 0.24; // decay
        let damp = 0.35 - room * 0.25;

        let mk_combs = || {
            COMB_TUNING.iter().map(|&t| Comb::new(scaled(t), fb as f32, damp as f32)).collect::<Vec<_>>()
        };
        let mk_combs_r = || {
            COMB_TUNING.iter()
                .map(|&t| Comb::new(scaled(t + STEREO_SPREAD), fb as f32, damp as f32))
                .collect::<Vec<_>>()
        };

        Self {
            combs_l: mk_combs(),
            combs_r: mk_combs_r(),
            allps_l: ALLP_TUNING.iter().map(|&t| Allpass::new(scaled(t), 0.5)).collect(),
            allps_r: ALLP_TUNING.iter().map(|&t| Allpass::new(scaled(t + STEREO_SPREAD), 0.5)).collect(),
            wet: mix,
            dry: 1.0 - mix * 0.6,
        }
    }

    pub fn process(&mut self, l: &mut Vec<f32>, r: &mut Vec<f32>) {
        let n = l.len();
        for i in 0..n {
            let (xl, xr) = (l[i], r[i]);
            let mut outl = 0.0f32;
            let mut outr = 0.0f32;
            for c in self.combs_l.iter_mut() { outl += c.process(xl); }
            for c in self.combs_r.iter_mut() { outr += c.process(xr); }
            for a in self.allps_l.iter_mut() { outl = a.process(outl); }
            for a in self.allps_r.iter_mut() { outr = a.process(outr); }
            l[i] = xl * self.dry + outl * self.wet * 0.02;
            r[i] = xr * self.dry + outr * self.wet * 0.02;
        }
    }
}

/// Pingpong delay: L feeds R feeds L..., musical width after music removal.
pub struct PingpongDelay {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    idx: usize,
    time_ms: f32,
    sr: u32,
    pub mix: f32,
    pub feedback: f32,
}

impl PingpongDelay {
    pub fn new(sr: u32, time_ms: f32, feedback: f32, mix: f32) -> Self {
        let size = ((sr as f32 * time_ms / 1000.0) as usize).max(4);
        Self { buf_l: vec![0.0; size], buf_r: vec![0.0; size], idx: 0, time_ms, sr, mix, feedback }
    }

    pub fn process(&mut self, l: &mut Vec<f32>, r: &mut Vec<f32>) {
        if self.sr == 0 {
            return;
        }
        let _ = self.time_ms; // captured at construction
        let n = l.len();
        let fb = self.feedback;
        let len = self.buf_l.len(); // audit R-4: constant, avoids per-sample `%`
        for i in 0..n {
            let dl = self.buf_l[self.idx];
            let dr = self.buf_r[self.idx];

            // write cross-fed input
            self.buf_l[self.idx] = r[i] + dr * fb;
            self.buf_r[self.idx] = l[i] + dl * fb;

            l[i] += dl * self.mix;
            r[i] += dr * self.mix;

            self.idx += 1;
            if self.idx >= len {
                self.idx = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(sr: u32, f: f32, secs: f32) -> Vec<f32> {
        (0..(sr as f32 * secs) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * f * i as f32 / sr as f32).sin() * 0.5)
            .collect()
    }

    #[test]
    fn freeverb_adds_tail_and_stays_finite() {
        let sr = 44100u32;
        // tone STOPS at 0.25s → last 0.25s is true silence pre-reverb
        let mut l = tone(sr, 1000.0, 0.25);
        let mut r = tone(sr, 1000.0, 0.25);
        let tail_len = sr as usize / 4;
        l.resize(sr as usize, 0.0);
        r.resize(sr as usize, 0.0);
        let pre_tail_energy: f32 = l[l.len() - tail_len..].iter().map(|v| v * v).sum();

        let mut rv = Freeverb::new(sr, 0.5, 0.3);
        rv.process(&mut l, &mut r);
        assert!(l.iter().all(|v| v.is_finite()) && r.iter().all(|v| v.is_finite()));

        let post_tail_energy: f32 = l[l.len() - tail_len..].iter().map(|v| v * v).sum();
        assert!(
            post_tail_energy > pre_tail_energy.max(1e-9),
            "reverb must fill the tail ({pre_tail_energy} → {post_tail_energy})"
        );
    }

    #[test]
    fn pingpong_cross_feeds_channels() {
        let sr = 44100u32;
        // impulse on LEFT only
        let mut l = vec![0.0f32; sr as usize];
        let mut r = vec![0.0f32; sr as usize];
        l[10] = 0.8;

        let mut d = PingpongDelay::new(sr, 50.0, 0.4, 1.0);
        d.process(&mut l, &mut r);

        // right channel must now contain delayed copies of the impulse
        let r_has_energy = r[10..].iter().any(|v| v.abs() > 0.01);
        assert!(r_has_energy, "pingpong must cross-feed L→R");
    }
}
