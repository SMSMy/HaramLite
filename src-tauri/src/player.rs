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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum ChunkState {
    /// Queued, background worker has not finished it.
    Pending,
    /// Position map ready (mute/duck ranges known).
    Ready,
    /// Played past — eligible for disk eviction.
    Consumed,
}

/// Expert D2ج: silence-skip policy — TWO modes only.
/// "Speed-up" was dropped officially: it balloons output size and chipmunks
/// voices (recorded reason). The surface exposes exactly these two variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipMode {
    /// Play straight through silences.
    Off,
    /// Jump over silence spans with a 50ms crossfade (see silence.rs).
    Skip,
}

/// Where a seek lands.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
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
        (cur..(cur + 1 + self.lookahead).min(self.chunks))
            .find(|&idx| self.states[idx] == ChunkState::Pending)
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
            ChunkState::Ready => SeekAction::Instant {
                chunk: idx,
                offset_sec: offset,
            },
            _ => SeekAction::MiniInit {
                chunk: idx,
                offset_sec: offset,
            },
        }
    }

    /// Expert D2ج: seek AND immediately flush the heard store — everything
    /// strictly behind the jump turns Consumed at once, so no stale chunk
    /// survives a seek. The target chunk itself is never flushed.
    /// Returns the evicted count and the landing action.
    pub fn seek_flush(&mut self, pos_sec: f64) -> (usize, SeekAction) {
        let n = self.consume_through(pos_sec);
        (n, self.seek(pos_sec))
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

    /// Full state snapshot for the surface (chunk pills). Cheap: ≤ dozens.
    pub fn states_snapshot(&self) -> Vec<ChunkState> {
        self.states.clone()
    }

    /// Whole-file map built → every queued chunk is inspectable.
    /// Idempotent (Ready/Consumed stay untouched).
    pub fn mark_all_ready(&mut self) {
        for s in self.states.iter_mut() {
            if *s == ChunkState::Pending {
                *s = ChunkState::Ready;
            }
        }
    }
}

/// Surface session store: one engine per opened file, keyed by id.
/// Maps live in the worker (session.rs); the store keeps queue truth only.
#[derive(Default)]
pub struct PlayerStore {
    next_id: u64,
    docs: std::collections::HashMap<u64, PlayerEngine>,
}

impl PlayerStore {
    pub fn open(&mut self, total_secs: f64, chunk_secs: f64) -> u64 {
        // Approved look-ahead depth (2) lives in exactly one place.
        let id = self.next_id;
        self.next_id += 1;
        self.docs
            .insert(id, PlayerEngine::new(total_secs, chunk_secs, 2));
        id
    }

    pub fn get(&self, id: u64) -> Option<&PlayerEngine> {
        self.docs.get(&id)
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut PlayerEngine> {
        self.docs.get_mut(&id)
    }

    pub fn close(&mut self, id: u64) -> bool {
        self.docs.remove(&id).is_some()
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
            SeekAction::Instant {
                chunk: 2,
                offset_sec: 10.0
            }
        );
        assert_eq!(
            e.seek(30.0),
            SeekAction::MiniInit {
                chunk: 0,
                offset_sec: 30.0
            }
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
        assert!(
            e.exhausted(70.0),
            "playhead past frontier → freeze, not gap"
        );
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

    #[test]
    fn store_opens_tracks_closes_sessions() {
        let mut st = PlayerStore::default();
        let a = st.open(250.0, 60.0);
        let b = st.open(30.0, 60.0);
        assert_ne!(a, b, "ids unique");
        assert_eq!(st.get(a).unwrap().chunk_count(), 5);
        assert_eq!(st.get(9999).map(|_| ()), None, "unknown id");
        st.get_mut(a).unwrap().mark_ready(0);
        assert_eq!(st.get(a).unwrap().states_snapshot()[0], ChunkState::Ready);
        assert!(st.close(a));
        assert!(!st.close(a), "double close reports false");
        assert_eq!(st.get(b).unwrap().chunk_count(), 1);
    }

    #[test]
    fn prepare_marks_whole_file_ready_status_turns_honest() {
        // Field defect 3: after the whole-file map is built, status must stop
        // reporting the stale "waiting for chunks" freeze.
        let mut e = engine();
        assert!(e.exhausted(0.0), "pre-map → frozen is honest");
        assert!(!e.can_start());
        e.mark_all_ready();
        assert!(e.can_start(), "post-map → chunk 0 Ready gates start");
        assert!(
            !e.exhausted(0.0),
            "post-map → pos 0 inside Ready, not frozen"
        );
        assert!(!e.exhausted(70.0));
        assert_eq!(e.next_needed(0.0), None, "frontier Ready → worker idles");
        // Idempotent: Consumed history survives a second mark.
        e.consume_through(65.0);
        e.mark_all_ready();
        assert_eq!(e.states_snapshot()[0], ChunkState::Consumed);
        assert_eq!(e.states_snapshot()[1], ChunkState::Ready);
    }

    /// Expert D2ج: a seek flushes the heard store IMMEDIATELY — chunks
    /// behind the jump turn Consumed at once; the landing chunk is untouched.
    #[test]
    fn seek_flush_evicts_heard_immediately() {
        let mut e = engine();
        for i in 0..4 {
            e.mark_ready(i);
        }
        let (n, act) = e.seek_flush(125.0);
        assert_eq!(n, 2, "chunks 0,1 flushed at the jump");
        assert_eq!(
            act,
            SeekAction::Instant {
                chunk: 2,
                offset_sec: 5.0
            }
        );
        let snap = e.states_snapshot();
        assert_eq!(snap[0], ChunkState::Consumed);
        assert_eq!(snap[1], ChunkState::Consumed);
        assert_eq!(snap[2], ChunkState::Ready, "landing chunk never flushed");
        // Second identical jump flushes nothing new (idempotent).
        let (n2, _) = e.seek_flush(125.0);
        assert_eq!(n2, 0);
        // Past-end jump flushes everything and lands at End.
        let (n3, end) = e.seek_flush(999.0);
        assert_eq!(end, SeekAction::EndOfUnit);
        assert!(e
            .states_snapshot()
            .iter()
            .all(|s| *s == ChunkState::Consumed));
        assert_eq!(n3, 3, "chunks 2,3,4 flushed (0,1 already were)");
    }

    /// Expert D2ج: the skip policy is EXACTLY two modes — speed-up must not
    /// exist. The exhaustive match below fails compilation if a third
    /// variant is ever added without updating the surface contract.
    #[test]
    fn skip_policy_is_exactly_two_modes() {
        for m in [SkipMode::Off, SkipMode::Skip] {
            let s = match m {
                SkipMode::Off => "off",
                SkipMode::Skip => "skip",
            };
            assert!(!s.is_empty());
        }
        assert_ne!(SkipMode::Off, SkipMode::Skip);
    }
}
