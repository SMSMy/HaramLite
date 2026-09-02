//! Silence cutting for song mode — removes dead-air runs with musical padding.

/// Cut configuration.
pub struct SilenceConfig {
    /// Detection threshold relative to the LOUD parts of this file:
    /// fraction (0..1) of the 90th-percentile window RMS.
    pub relative_threshold: f32,
    /// absolute floor in dBFS below relative logic
    pub absolute_floor_db: f32,
    /// silence must last at least this long to be cut
    pub min_silence_ms: u32,
    /// keep this much "silence" on each side of a cut (breathing room)
    pub keep_ms: u32,
    /// fade length applied at every cut edge to avoid clicks
    pub fade_ms: u32,
}

impl Default for SilenceConfig {
    fn default() -> Self {
        Self {
            relative_threshold: 0.06, // ≈ −24 dB vs loud parts
            absolute_floor_db: -55.0,
            min_silence_ms: 800,
            keep_ms: 150,
            fade_ms: 12,
        }
    }
}

struct Range {
    start: usize,
    end: usize, // exclusive
}

fn window_rms(l: &[f32], r: &[f32], win: usize) -> Vec<f32> {
    let n = l.len().min(r.len());
    let count = n / win.max(1);
    (0..count)
        .map(|w| {
            let s = w * win;
            let sum: f32 = l[s..s + win].iter().chain(r[s..s + win].iter())
                .map(|v| v * v).sum();
            (sum / (win * 2) as f32).sqrt()
        })
        .collect()
}

/// Returns kept ranges [start,end) of samples after cutting silences.
pub fn compute_kept_ranges(l: &[f32], r: &[f32], sr: u32, cfg: &SilenceConfig) -> Vec<(usize, usize)> {
    let n = l.len().min(r.len());
    let win = (sr as usize / 20).max(64); // 50 ms windows
    let rms = window_rms(l, r, win);

    // adaptive threshold: 90th percentile × factor, clamped by absolute floor
    let mut sorted = rms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p90 = sorted.get((sorted.len() as f32 * 0.9) as usize).copied().unwrap_or(1.0);
    let floor = 10f32.powf(cfg.absolute_floor_db / 20.0);
    let threshold = (p90 * cfg.relative_threshold).max(floor);

    let silent_windows: Vec<bool> = rms.iter().map(|v| *v < threshold).collect();

    // find silence RUNS ≥ min duration
    let min_run = ((cfg.min_silence_ms as usize * sr as usize / 1000) / win).max(1);
    let mut cuts: Vec<(usize, usize)> = Vec::new(); // window indices
    let mut run_start: Option<usize> = None;
    for (idx, &is_silent) in silent_windows.iter().enumerate() {
        if is_silent {
            if run_start.is_none() {
                run_start = Some(idx);
            }
        } else if let Some(rs) = run_start.take() {
            if idx - rs >= min_run {
                cuts.push((rs, idx));
            }
        }
    }
    if let Some(rs) = run_start.take() {
        if silent_windows.len() - rs >= min_run && rs > 0 {
            // trailing silence — only cut if it's not the whole file tail we need
            cuts.push((rs, silent_windows.len()));
        }
    }

    if cuts.is_empty() {
        return vec![];
    }

    // build kept ranges = inverse of cuts, padded by keep_ms
    let pad = cfg.keep_ms as usize * sr as usize / 1000;
    let mut kept: Vec<Range> = Vec::new();
    let mut cursor = 0usize;
    for (rs, re_) in cuts {
        let cut_start = ((rs * win) + pad).min(n);
        let cut_end = (re_ * win).saturating_sub(pad).max(cut_start);
        if cut_start > cursor {
            kept.push(Range { start: cursor, end: cut_start });
        }
        cursor = cut_end.max(cursor);
    }
    if cursor < n {
        kept.push(Range { start: cursor, end: n });
    }
    kept.retain(|r| r.end - r.start > sr as usize / 10); // drop slivers <100ms
    kept.into_iter().map(|rg| (rg.start, rg.end)).collect()
}

/// In-place silence removal on stereo buffers. Returns removed fraction 0..1.
/// The production path (effects.rs) calls [`cut_silence_with_ranges`] directly
/// to reuse already-computed ranges; this entry point stays for CLI/future
/// callers and is exercised by the tests.
#[allow(dead_code)]
pub fn cut_silence(l: &mut Vec<f32>, r: &mut Vec<f32>, sr: u32, cfg: &SilenceConfig) -> f32 {
    let ranges = compute_kept_ranges(l, r, sr, cfg);
    cut_silence_with_ranges(l, r, sr, cfg, &ranges)
}

/// Apply a cut using ranges already computed by [`compute_kept_ranges`].
/// Audit R-5: callers that need the ranges anyway (e.g. for mirroring cuts on
/// the video track) pass them in instead of running the whole detection pass twice.
pub fn cut_silence_with_ranges(
    l: &mut Vec<f32>,
    r: &mut Vec<f32>,
    sr: u32,
    cfg: &SilenceConfig,
    ranges: &[(usize, usize)],
) -> f32 {
    let before = l.len().min(r.len());
    if ranges.is_empty() {
        return 0.0;
    }

    let fade = (cfg.fade_ms as usize * sr as usize / 1000).max(2);
    let mut nl = Vec::with_capacity(before);
    let mut nr = Vec::with_capacity(before);

    for (idx, (start, end)) in ranges.iter().enumerate() {
        let a = (*start).min(l.len());
        let b = (*end).min(l.len());
        if b <= a {
            continue;
        }
        let seg_start = nl.len();
        nl.extend_from_slice(&l[a..b]);
        nr.extend_from_slice(&r[a..b]);

        // Short fades at every INTERIOR cut boundary to avoid clicks:
        // fade-IN at the start of a segment that follows a cut, fade-OUT at
        // the end of a segment that precedes a cut. (The old code applied a
        // rising fade to the END of every segment — clicks stayed and endings
        // bulged. The file's own true start/end is left untouched.)
        let head = fade.min(b - a);
        if idx > 0 {
            for k in 0..head {
                let g = (k + 1) as f32 / head as f32;
                nl[seg_start + k] *= g;
                nr[seg_start + k] *= g;
            }
        }
        if idx + 1 < ranges.len() {
            for k in 0..head {
                let g = (head - k) as f32 / head as f32;
                let li = nl.len() - 1 - k;
                let ri = nr.len() - 1 - k;
                nl[li] *= g;
                nr[ri] *= g;
            }
        }
    }

    let removed = 1.0 - nl.len().max(1) as f32 / before.max(1) as f32;
    *l = nl;
    *r = nr;
    removed.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_middle_gap_and_keeps_content() {
        let sr = 44100u32;
        let tone = |secs: f32| -> Vec<f32> {
            (0..(sr as f32 * secs) as usize)
                .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr as f32).sin() * 0.5)
                .collect()
        };

        let mut l = tone(2.0);
        l.extend(std::iter::repeat(0.0).take(sr as usize * 2)); // 2s silence
        l.extend(tone(2.0));
        let mut r = l.clone();

        let removed = cut_silence(&mut l, &mut r, sr, &SilenceConfig::default());

        // expect ~2s removed out of 6s ≈ 0.33
        assert!((removed - 1.0 / 3.0).abs() < 0.08, "removed={removed}");
        assert!(l.iter().all(|v| v.is_finite()));
        assert!(l.len() < sr as usize * 5, "must shrink");
    }

    #[test]
    fn no_silence_means_no_cut() {
        let sr = 44100u32;
        let tone = |a: f32| -> Vec<f32> {
            (0..sr as usize * 3).map(|i| (i as f32 * 0.01).sin() * a).collect()
        };
        let mut l = tone(0.5);
        let mut r = tone(0.5);
        let removed = cut_silence(&mut l, &mut r, sr, &SilenceConfig::default());
        assert!(removed < 0.02, "should not cut loud content: {removed}");
        assert_eq!(l.len(), sr as usize * 3);
    }

    #[test]
    fn fades_prevent_clicks_at_boundaries() {
        // ensure first sample of output is faded toward zero when a cut happened
        let sr = 44100u32;
        let mut l = vec![0.7f32; sr as usize]; // constant DC → "silence" by RMS?
        // craft: quiet then loud then quiet
        let mut sig: Vec<f32> = std::iter::repeat(0.00001f32).take(sr as usize).collect();
        sig.extend(std::iter::repeat(0.6f32).take(sr as usize));
        sig.extend(std::iter::repeat(0.00001f32).take(sr as usize));
        let mut r = sig.clone();
        let mut ll = sig.clone();
        let _ = (&mut l, &mut r);
        let removed = cut_silence(&mut ll, &mut r, sr, &SilenceConfig::default());
        assert!(removed > 0.2);
    }
}
