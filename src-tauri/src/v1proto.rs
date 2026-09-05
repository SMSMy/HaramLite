//! Live v1 prototype — SONGS-ONLY scope (Slice 4+ owns speech).
//!
//! Ideas-only inspiration (see inspiration/NOTES.md — prohibition header:
//! reimplemented from scratch; no third-party code copied; unchanged license).
//!
//! The prototype wires the three slices into one callable path over a single
//! audio unit (≤5 minutes): split into chunks → silence map → decision scores
//! → smoothed verdicts → POSITION MAP (absolute mute/duck ranges the player
//! will enforce) + embedded per-minute cost. No file I/O, no player, no MDX.
//! Its ONLY acceptance deliverable is the per-minute cost report (see tests).

// Dead until the player stage wires it; tests exercise everything.
#![allow(dead_code)]

use std::time::Instant;

use crate::decide::{score_windows, smooth_verdicts, DecideConfig, Verdict};
use crate::livemap::{map_chunk_silence, split_plan, MapConfig};

/// One chunk's contribution to the position map.
pub struct ChunkProto {
    pub index: usize,
    pub start_sec: f64,
    pub len_sec: f64,
    /// Absolute mute ranges (player silences these, 50ms ramp player-side).
    pub muted_ranges_sec: Vec<(f64, f64)>,
    /// Absolute duck ranges (−12 dB player-side).
    pub ducked_ranges_sec: Vec<(f64, f64)>,
    pub scored_windows: usize,
    pub skipped_windows: usize,
    pub timing_ms: f32,
}

/// End-to-end position map of one audio unit + its cost.
pub struct ProtoReport {
    pub total_audio_secs: f64,
    pub chunks: Vec<ChunkProto>,
    pub muted_fraction: f32,
    pub ducked_fraction: f32,
    pub total_ms: f32,
    pub minute_cost_ms: f32,
}

/// Merge consecutive same-verdict verdict points into absolute ranges.
/// A Mute span runs from the first Mute point until the next non-Mute point
/// (or `span_end`); same for Duck. Adjacent spans closer than 0.1s fuse.
fn collect_ranges(
    verdicts: &[(f64, Verdict)],
    want: Verdict,
    span_end: f64,
) -> Vec<(f64, f64)> {
    let mut ranges: Vec<(f64, f64)> = Vec::new();
    let mut open: Option<f64> = None;
    let mut ordered: Vec<(f64, Verdict)> = verdicts.to_vec();
    ordered.sort_by(|a, b| a.0.total_cmp(&b.0));
    for (t, v) in &ordered {
        if *v == want {
            if open.is_none() {
                open = Some(*t);
            }
        } else if let Some(s) = open.take() {
            ranges.push((s, *t));
        }
    }
    if let Some(s) = open.take() {
        ranges.push((s, span_end));
    }
    // Fuse near-adjacent spans (hysteresis chatter guard).
    let mut fused: Vec<(f64, f64)> = Vec::new();
    for (a, b) in ranges {
        if let Some(last) = fused.last_mut() {
            if a - last.1 < 0.1 {
                last.1 = b;
                continue;
            }
        }
        fused.push((a, b));
    }
    fused.retain(|(a, b)| b - a > 0.05);
    fused
}

/// Build the position map of one in-memory audio unit.
pub fn build_position_map(
    l: &[f32],
    r: &[f32],
    sr: u32,
    chunk_secs: f64,
    dcfg: &DecideConfig,
) -> ProtoReport {
    let t0 = Instant::now();
    let total_audio_secs = if sr > 0 { l.len().min(r.len()) as f64 / sr as f64 } else { 0.0 };
    let mcfg = MapConfig::default();
    let mut chunks = Vec::new();
    let mut muted_len = 0.0f64;
    let mut ducked_len = 0.0f64;

    for (idx, start, len) in split_plan(total_audio_secs, chunk_secs) {
        let ct = Instant::now();
        let a = (start * sr as f64) as usize;
        let b = ((start + len) * sr as f64) as usize;
        let m = map_chunk_silence(&l[a..b], &r[a..b], sr, idx, start, &mcfg);
        let scores = score_windows(&l[a..b], &r[a..b], sr, &m, dcfg);
        let scored = scores.iter().filter(|s| !s.silent).count();
        let skipped = scores.len() - scored;
        let verdicts = smooth_verdicts(&scores, dcfg, dcfg.hop_secs);
        let span_end = start + len;
        let muted = collect_ranges(&verdicts, Verdict::Mute, span_end);
        let ducked = collect_ranges(&verdicts, Verdict::Duck, span_end);
        muted_len += muted.iter().map(|(a, b)| b - a).sum::<f64>();
        ducked_len += ducked.iter().map(|(a, b)| b - a).sum::<f64>();
        chunks.push(ChunkProto {
            index: idx,
            start_sec: start,
            len_sec: len,
            muted_ranges_sec: muted,
            ducked_ranges_sec: ducked,
            scored_windows: scored,
            skipped_windows: skipped,
            timing_ms: ct.elapsed().as_secs_f32() * 1000.0,
        });
    }

    let total_ms = t0.elapsed().as_secs_f32() * 1000.0;
    let minute_cost_ms = if total_audio_secs > 0.0 {
        total_ms / (total_audio_secs / 60.0) as f32
    } else {
        0.0
    };
    ProtoReport {
        total_audio_secs,
        muted_fraction: if total_audio_secs > 0.0 {
            (muted_len / total_audio_secs) as f32
        } else {
            0.0
        },
        ducked_fraction: if total_audio_secs > 0.0 {
            (ducked_len / total_audio_secs) as f32
        } else {
            0.0
        },
        chunks,
        total_ms,
        minute_cost_ms,
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

    /// Same 270s synthetic unit as Slices 1–2 (≤5min single unit).
    fn unit_270s() -> (Vec<f32>, Vec<f32>) {
        let mut l: Vec<f32> = Vec::new();
        for k in 0..7 {
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
        l.extend(sine(25.0, 0.4, 440.0));
        (l.clone(), l)
    }

    #[test]
    fn ranges_are_ordered_inside_unit() {
        let (l, r) = unit_270s();
        let rep = build_position_map(&l, &r, SR, 60.0, &DecideConfig::default());
        assert_eq!(rep.chunks.len(), 5);
        assert!((rep.total_audio_secs - 270.0).abs() < 0.1);
        for c in &rep.chunks {
            for (a, b) in c.muted_ranges_sec.iter().chain(c.ducked_ranges_sec.iter()) {
                assert!(b > a, "range must be positive");
                assert!(*a >= c.start_sec - 1e-6 && *b <= c.start_sec + c.len_sec + 1e-6,
                    "range must stay inside its chunk");
            }
            for w in c.muted_ranges_sec.windows(2) {
                assert!(w[1].0 >= w[0].1, "ranges must not overlap");
            }
        }
        assert!((0.0..=1.0).contains(&rep.muted_fraction));
        assert!((0.0..=1.0).contains(&rep.ducked_fraction));
    }

    #[test]
    fn empty_unit_maps_empty() {
        let rep = build_position_map(&[], &[], SR, 60.0, &DecideConfig::default());
        assert!(rep.chunks.is_empty());
        assert_eq!(rep.minute_cost_ms, 0.0);
    }

    /// Prototype acceptance vehicle: PROTO-REPORT with the per-minute cost
    /// gate. Run with `-- --nocapture`. Structure asserted; cost printed.
    #[test]
    fn report_prototype_cost() {
        let (l, r) = unit_270s();
        let rep = build_position_map(&l, &r, SR, 60.0, &DecideConfig::default());
        let muted_n: usize = rep.chunks.iter().map(|c| c.muted_ranges_sec.len()).sum();
        let ducked_n: usize = rep.chunks.iter().map(|c| c.ducked_ranges_sec.len()).sum();
        println!("PROTO-REPORT secs={:.1} chunks={} muted_ranges={muted_n} ducked_ranges={ducked_n} muted_frac={:.3} ducked_frac={:.3} total_ms={:.1} minute_cost_ms={:.1}",
            rep.total_audio_secs, rep.chunks.len(), rep.muted_fraction, rep.ducked_fraction, rep.total_ms, rep.minute_cost_ms);
        assert_eq!(rep.chunks.len(), 5);
    }
}
