//! Live v1 player session — engine + position maps wired together.
//!
//! The integration slice: [`crate::player::PlayerEngine`] decides WHAT is
//! needed and WHEN; [`crate::v1proto::map_one_chunk`] produces it. This
//! session owns both sides over one in-memory audio unit: background
//! production in engine-priority order, playhead advance with eviction,
//! seeks, and the graceful-freeze signal. Still no file I/O and no audio
//! output — the FIRST field stop-test stays constrained to a
//! non-production environment (recorded rule).

// Dead until the player stage wires it; tests exercise everything.
#![allow(dead_code)]

use std::collections::HashMap;
use std::time::Instant;

use crate::decide::DecideConfig;
use crate::player::{PlayerEngine, SeekAction};
use crate::v1proto::{map_one_chunk, ChunkProto};

/// Approved look-ahead depth (chunks past the playhead kept Ready).
pub const LOOKAHEAD: usize = 2;

/// A live session over one audio unit.
pub struct Session<'a> {
    engine: PlayerEngine,
    maps: HashMap<usize, ChunkProto>,
    l: &'a [f32],
    r: &'a [f32],
    sr: u32,
    chunk_secs: f64,
    total_secs: f64,
    produced_ms: f32,
}

impl<'a> Session<'a> {
    pub fn new(l: &'a [f32], r: &'a [f32], sr: u32, chunk_secs: f64) -> Self {
        let total = if sr > 0 && chunk_secs > 0.0 {
            l.len().min(r.len()) as f64 / sr as f64
        } else {
            0.0
        };
        Self {
            engine: PlayerEngine::new(total, chunk_secs, LOOKAHEAD),
            maps: HashMap::new(),
            l,
            r,
            sr,
            chunk_secs,
            total_secs: total,
            produced_ms: 0.0,
        }
    }

    /// Background worker step: build the map for the chunk the engine needs
    /// most at this playhead position. Returns the produced chunk index, or
    /// `None` when the frontier is fully Ready (worker idles).
    pub fn process_next(&mut self, pos_sec: f64, dcfg: &DecideConfig) -> Option<usize> {
        let idx = self.engine.next_needed(pos_sec)?;
        let t = Instant::now();
        let start = idx as f64 * self.chunk_secs;
        let chunk_secs = self.engine_chunk_secs(idx);
        let c = map_one_chunk(self.l, self.r, self.sr, idx, start, chunk_secs, dcfg);
        self.produced_ms += t.elapsed().as_secs_f32() * 1000.0;
        self.engine.mark_ready(idx);
        self.maps.insert(idx, c);
        Some(idx)
    }

    /// Move the playhead: evict heard chunks' map data, report count.
    pub fn advance(&mut self, pos_sec: f64) -> usize {
        let upto = match self.engine.chunk_of(pos_sec) {
            Some(c) => c,
            None if pos_sec >= self.total_secs() => self.engine.chunk_count(),
            None => return 0,
        };
        let mut n = 0;
        for idx in 0..upto {
            if self.maps.remove(&idx).is_some() {
                n += 1;
            }
        }
        // Engine-side state follows (idempotent with the map drops above).
        let _ = self.engine.consume_through(pos_sec);
        n
    }

    pub fn seek_action(&self, pos_sec: f64) -> SeekAction {
        self.engine.seek(pos_sec)
    }

    /// Graceful-freeze signal at this playhead position.
    pub fn frozen(&self, pos_sec: f64) -> bool {
        self.engine.exhausted(pos_sec)
    }

    pub fn can_start(&self) -> bool {
        self.engine.can_start()
    }

    pub fn ready_count(&self) -> usize {
        self.maps.len()
    }

    pub fn produced_ms(&self) -> f32 {
        self.produced_ms
    }

    fn total_secs(&self) -> f64 {
        self.total_secs
    }

    /// Chunk boundaries identical to `split_plan` by construction:
    /// full `chunk_secs` slices plus one remainder tail.
    fn engine_chunk_secs(&self, idx: usize) -> f64 {
        let start = idx as f64 * self.chunk_secs;
        (self.total_secs - start).min(self.chunk_secs).max(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44100;

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
        l.extend(
            (0..SR as usize * 25).map(|i| {
                (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SR as f32).sin() * 0.4
            }),
        );
        (l.clone(), l)
    }

    /// Scripted session: first-frame gate → look-ahead fill → playhead walk
    /// with eviction → seek into ready (instant) → frontier overrun (freeze)
    /// → drain. Prints SESSION-REPORT (per-minute gate). `-- --nocapture`.
    #[test]
    fn report_scripted_session() {
        let (l, r) = unit_270s();
        let dcfg = DecideConfig::default();
        let mut s = Session::new(&l, &r, SR, 60.0);
        assert!(!s.can_start());

        // First frame: chunk 0 gates playback (the initial delay, measured).
        assert_eq!(s.process_next(0.0, &dcfg), Some(0));
        assert!(s.can_start());
        // Look-ahead fill at playhead 0: chunks 1, 2, then idle.
        assert_eq!(s.process_next(0.0, &dcfg), Some(1));
        assert_eq!(s.process_next(0.0, &dcfg), Some(2));
        assert_eq!(s.process_next(0.0, &dcfg), None);
        assert_eq!(s.ready_count(), 3);

        // Walk the playhead: eviction drops heard maps, worker refills.
        let ev = s.advance(65.0);
        assert_eq!(ev, 1, "chunk 0 evicted past 60s");
        assert_eq!(s.ready_count(), 2);
        assert_eq!(s.process_next(65.0, &dcfg), Some(3));
        assert!(!s.frozen(65.0));

        // Seeks: ready → instant, pending → mini-init.
        assert!(matches!(
            s.seek_action(200.0),
            SeekAction::Instant { chunk: 3, .. }
        ));
        // Frontier overrun freezes gracefully (chunk 4 still pending).
        assert!(s.frozen(250.0));
        assert!(matches!(
            s.seek_action(250.0),
            SeekAction::MiniInit { chunk: 4, .. }
        ));
        // Mini-init with maximum priority drains the last chunk.
        assert_eq!(s.process_next(250.0, &dcfg), Some(4));
        assert!(!s.frozen(250.0));
        assert_eq!(s.process_next(250.0, &dcfg), None);

        let mins = 270.0 / 60.0;
        println!(
            "SESSION-REPORT chunks=5 ready={} produced_ms={:.1} minute_cost_ms={:.1}",
            s.ready_count(),
            s.produced_ms(),
            s.produced_ms() / mins as f32
        );
        assert_eq!(s.ready_count(), 4, "chunk 0 evicted, 1..4 resident");
    }
}
