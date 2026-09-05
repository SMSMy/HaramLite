//! Live v1 in-app player engine — SONGS-ONLY scope.
//!
//! Ideas-only inspiration (see inspiration/NOTES.md — prohibition header:
//! reimplemented from scratch; no third-party code copied; unchanged license).
//!
//! Pure state machine (no I/O, no audio output, no MDX): it tracks chunk
//! readiness over the absolute timeline and answers the four player
//! questions — what to process next (serial priority + look-ahead), what to
//! evict (already heard), where a seek lands (ready → instant, otherwise
//! mini-init), and when to freeze gracefully (playback outruns the ready
//! frontier). Audio fetching, decoding and output wiring are LATER slices;
//! the FIRST field stop-test must run on a non-production environment
//! (recorded constraint) — this module is verified by unit tests only.

// Dead until the player stage wires it; tests exercise everything.
#![allow(dead_code)]

/// Lifecycle of one chunk inside the player queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkState {
    /// Queued, background worker has not finished it.
    Pending,
    /// Position map ready (mute/duck ranges known).
    Ready,
    /// Played past — eligible for disk eviction.
    Consumed,
}

/// Where a seek lands.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SeekAction {
    /// Chunk already Ready → resume instantly at this offset.
    Instant { chunk: usize, offset_sec: f64 },
    /// Chunk still Pending → mini-init with maximum priority at this offset.
    MiniInit { chunk: usize, offset_sec: f64 },
    /// Beyond the unit — clamp to end.
    EndOfUnit,
}

/// The player queue brain. All positions are absolute seconds.
pub struct PlayerEngine {
    chunk_secs: f64,
    total_secs: f64,
    chunks: usize,
    lookahead: usize,
    states: Vec<ChunkState>,
}

impl PlayerEngine {
    /// `lookahead`: how many chunks past the playhead stay Ready
    /// (approved: 2).
    pub fn new(total_secs: f64, chunk_secs: f64, lookahead: usize) -> Self {
        let chunks = if total_secs > 0.0 && chunk_secs > 0.0 {
            (total_secs / chunk_secs).ceil() as usize
        } else {
            0
        };
        Self {
            chunk_secs,
            total_secs,
            chunks,
            lookahead,
            states: vec![ChunkState::Pending; chunks],
        }
    }

    pub fn chunk_count(&self) -> usize {
        self.chunks
    }

    pub fn chunk_of(&self, pos_sec: f64) -> Option<usize> {
        if self.chunks == 0 || pos_sec < 0.0 || pos_sec >= self.total_secs {
            return None;
        }
        Some(((pos_sec / self.chunk_secs) as usize).min(self.chunks - 1))
    }

    /// Background worker finished a chunk → Ready (idempotent).
    pub fn mark_ready(&mut self, idx: usize) {
        if let Some(s) = self.states.get_mut(idx) {
            if *s == ChunkState::Pending {
                *s = ChunkState::Ready;
            }
        }
    }

    /// Serial priority with look-ahead: the playhead chunk first, then the
    /// next `lookahead` chunks in order; skips Ready/Consumed. `None` means
    /// the frontier is fully Ready (worker idles).
    pub fn next_needed(&self, pos_sec: f64) -> Option<usize> {
        let cur = self.chunk_of(pos_sec)?;
        for idx in cur..(cur + 1 + self.lookahead).min(self.chunks) {
            if self.states[idx] == ChunkState::Pending {
                return Some(idx);
            }
        }
        None
    }

    /// Mark every chunk strictly before the playhead Consumed.
    /// Returns evicted count (caller deletes their disk data).
    pub fn consume_through(&mut self, pos_sec: f64) -> usize {
        let upto = match self.chunk_of(pos_sec) {
            Some(c) => c,
            None if pos_sec >= self.total_secs => self.chunks,
            None => return 0,
        };
        let mut n = 0;
        for s in self.states.iter_mut().take(upto) {
            if *s != ChunkState::Consumed {
                *s = ChunkState::Consumed;
                n += 1;
            }
        }
        n
    }

    /// Resolve a seek: Ready → instant; Pending → mini-init; past end → End.
    pub fn seek(&self, pos_sec: f64) -> SeekAction {
        if pos_sec >= self.total_secs || self.chunks == 0 {
            return SeekAction::EndOfUnit;
        }
        let pos = pos_sec.max(0.0);
        let idx = self.chunk_of(pos).unwrap_or(0);
        let offset = pos - idx as f64 * self.chunk_secs;
        match self.states[idx] {
            ChunkState::Ready => SeekAction::Instant { chunk: idx, offset_sec: offset },
            _ => SeekAction::MiniInit { chunk: idx, offset_sec: offset },
        }
    }

    /// Graceful-freeze signal: playback position is NOT inside Ready audio
    /// (unprocessed frontier or consumed/evicted past). The player shows a
    /// badge and holds — never cuts to raw unfiltered audio, never gaps.
    pub fn exhausted(&self, pos_sec: f64) -> bool {
        match self.chunk_of(pos_sec) {
            Some(idx) => self.states[idx] != ChunkState::Ready,
            None => true,
        }
    }

    /// First-frame gate: playback may start only after chunk 0 is Ready.
    /// The initial delay IS first-chunk readiness (no arbitrary counter).
    pub fn can_start(&self) -> bool {
        !self.states.is_empty() && self.states[0] == ChunkState::Ready
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> PlayerEngine {
        PlayerEngine::new(250.0, 60.0, 2) // 5 chunks: 60×4 + 10
    }

    #[test]
    fn plan_counts_and_locates() {
        let e = engine();
        assert_eq!(e.chunk_count(), 5);
        assert_eq!(e.chunk_of(0.0), Some(0));
        assert_eq!(e.chunk_of(59.9), Some(0));
        assert_eq!(e.chunk_of(60.0), Some(1));
        assert_eq!(e.chunk_of(249.9), Some(4));
        assert_eq!(e.chunk_of(250.0), None);
        assert_eq!(e.chunk_of(-1.0), None);
        assert!(!e.can_start(), "nothing ready yet");
    }

    #[test]
    fn serial_priority_with_lookahead() {
        let mut e = engine();
        assert_eq!(e.next_needed(0.0), Some(0), "playhead chunk first");
        e.mark_ready(0);
        assert!(e.can_start(), "first chunk gates playback");
        assert_eq!(e.next_needed(0.0), Some(1));
        e.mark_ready(1);
        e.mark_ready(2);
        assert_eq!(e.next_needed(0.0), None, "frontier Ready → worker idles");
        assert_eq!(e.next_needed(65.0), Some(3), "priority follows playhead");
    }

    #[test]
    fn consume_evicts_only_the_past() {
        let mut e = engine();
        for i in 0..3 {
            e.mark_ready(i);
        }
        assert_eq!(e.consume_through(125.0), 2, "chunks 0,1 evicted at pos 125");
        assert_eq!(e.consume_through(125.0), 0, "idempotent");
        assert_eq!(e.consume_through(999.0), 3, "past end evicts the rest");
    }

    #[test]
    fn seek_ready_is_instant_pending_is_mini_init() {
        let mut e = engine();
        e.mark_ready(2);
        assert_eq!(
            e.seek(130.0),
            SeekAction::Instant { chunk: 2, offset_sec: 10.0 }
        );
        assert_eq!(
            e.seek(30.0),
            SeekAction::MiniInit { chunk: 0, offset_sec: 30.0 }
        );
        assert_eq!(e.seek(250.0), SeekAction::EndOfUnit);
        assert_eq!(e.seek(999.0), SeekAction::EndOfUnit);
    }

    #[test]
    fn exhaustion_freezes_never_gaps() {
        let mut e = engine();
        assert!(e.exhausted(0.0), "nothing ready → frozen with badge");
        e.mark_ready(0);
        assert!(!e.exhausted(10.0));
        assert!(e.exhausted(70.0), "playhead past frontier → freeze, not gap");
        e.mark_ready(1);
        assert!(!e.exhausted(70.0));
    }

    #[test]
    fn degenerate_units_safe() {
        let e = PlayerEngine::new(0.0, 60.0, 2);
        assert_eq!(e.chunk_count(), 0);
        assert_eq!(e.next_needed(0.0), None);
        assert_eq!(e.seek(5.0), SeekAction::EndOfUnit);
        assert!(e.exhausted(0.0));
        assert!(!e.can_start());
    }
}
