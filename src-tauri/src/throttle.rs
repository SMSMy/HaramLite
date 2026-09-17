//! P1 autopsy — ≤4Hz progress channel + emit accounting.
//!
//! Progress callbacks fire at SOURCE rate (yt-dlp stdout lines, separator
//! chunks). Every fire used to cross the Tauri IPC bridge into the renderer,
//! so the only bound was whatever the source happened to do — on a fast pipe
//! that is unknowable without measuring. This module caps every named
//! channel at 4Hz (visually identical: the UI paints at most once per
//! frame anyway) and counts emitted-vs-suppressed so the next field freeze
//! carries its own rate evidence in the log. Pure and unit-tested.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Minimum gap between two emits on the same channel (4Hz).
pub const MIN_GAP: Duration = Duration::from_millis(250);

pub struct Throttle {
    last: Mutex<HashMap<&'static str, Instant>>,
    emitted: Mutex<HashMap<&'static str, u64>>,
    suppressed: Mutex<HashMap<&'static str, u64>>,
}

impl Throttle {
    pub fn new() -> Self {
        Self {
            last: Mutex::new(HashMap::new()),
            emitted: Mutex::new(HashMap::new()),
            suppressed: Mutex::new(HashMap::new()),
        }
    }

    fn bump(map: &Mutex<HashMap<&'static str, u64>>, key: &'static str) {
        if let Ok(mut m) = map.lock() {
            *m.entry(key).or_insert(0) += 1;
        }
    }

    /// Testable core: first call per key always passes; afterwards only when
    /// `MIN_GAP` elapsed since the last PASS (suppressed calls do NOT move
    /// the window — a steady 100Hz source still emits at exactly 4Hz).
    pub fn allow_at(&self, key: &'static str, now: Instant) -> bool {
        let mut last = match self.last.lock() {
            Ok(g) => g,
            Err(_) => return true, // poisoned → fail open (progress over silence)
        };
        match last.get(key) {
            None => {
                last.insert(key, now);
                Self::bump(&self.emitted, key);
                true
            }
            Some(t) if now.duration_since(*t) >= MIN_GAP => {
                last.insert(key, now);
                Self::bump(&self.emitted, key);
                true
            }
            _ => {
                drop(last);
                Self::bump(&self.suppressed, key);
                false
            }
        }
    }

    pub fn allow(&self, key: &'static str) -> bool {
        self.allow_at(key, Instant::now())
    }

    /// One-line rate evidence for end-of-run log lines.
    ///
    /// A counter whose lock is poisoned is **said to be unmeasured**, never
    /// reported as `0 emitted / 0 suppressed`: zero is a real measurement
    /// ("the channel never fired"), and printing it for a lock we could not
    /// read is a log line asserting a measurement that was never taken — the
    /// one thing rule 3 forbids. A thread that panicked while holding either
    /// counter leaves that side unknown; the line then carries no numbers at
    /// all, so nothing downstream can mistake silence for evidence.
    pub fn report(&self, key: &'static str) -> String {
        let count = |m: &Mutex<HashMap<&'static str, u64>>| -> Option<u64> {
            m.lock().ok().map(|g| g.get(key).copied().unwrap_or(0))
        };
        let emitted = count(&self.emitted);
        let suppressed = count(&self.suppressed);
        match (emitted, suppressed) {
            (Some(e), Some(s)) => format!("{key}: {e} emitted / {s} suppressed"),
            (e, s) => format!(
                "{key}: قياس غير متاح — {}؛ لا أرقام ولا ادّعاء بمعدّل",
                match (e.is_some(), s.is_some()) {
                    (false, false) => "عدّادا emitted و suppressed مقفلان (خيط سمّمهما)",
                    (false, true) => "عدّاد emitted مقفل (خيط سمّمه)",
                    _ => "عدّاد suppressed مقفل (خيط سمّمه)",
                }
            ),
        }
    }
}

impl Default for Throttle {
    fn default() -> Self {
        Self::new()
    }
}

/// Process-wide 4Hz channel shared by the program-path commands.
pub static EMIT_4HZ: std::sync::OnceLock<Throttle> = std::sync::OnceLock::new();

pub fn emit_4hz() -> &'static Throttle {
    EMIT_4HZ.get_or_init(Throttle::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_passes_then_gates_per_key() {
        let th = Throttle::new();
        let t0 = Instant::now();
        assert!(th.allow_at("dl", t0), "first must pass");
        assert!(!th.allow_at("dl", t0), "same instant suppressed");
        assert!(
            !th.allow_at("dl", t0 + Duration::from_millis(249)),
            "under gap"
        );
        assert!(
            th.allow_at("dl", t0 + Duration::from_millis(250)),
            "gap edge passes"
        );
        // Suppressed calls do not slide the window: +250 from the PASS.
        assert!(!th.allow_at("dl", t0 + Duration::from_millis(499)));
        assert!(th.allow_at("dl", t0 + Duration::from_millis(500)));
        // Independent keys never interfere.
        assert!(th.allow_at("sep", t0), "other key first passes");
    }

    #[test]
    fn steady_source_emits_at_4hz_not_more() {
        let th = Throttle::new();
        let t0 = Instant::now();
        let mut n = 0;
        // 100Hz source for 1 second.
        for i in 0..100 {
            if th.allow_at("flood", t0 + Duration::from_millis(i * 10)) {
                n += 1;
            }
        }
        assert!((4..=5).contains(&n), "100Hz in → ~4Hz out, got {n}");
        let rep = th.report("flood");
        assert!(
            rep.contains("suppressed"),
            "report must carry both sides: {rep}"
        );
    }

    /// Rule 3 at the log line: a counter the process could not read must not
    /// be printed as a number. A thread panics while holding the `emitted`
    /// lock, poisoning it, and the report must name the unmeasured side
    /// instead of claiming «0 emitted / 0 suppressed».
    #[test]
    fn a_poisoned_counter_is_said_not_zeroed() {
        let th = std::sync::Arc::new(Throttle::new());
        let t0 = Instant::now();
        assert!(th.allow_at("k", t0), "one real emit");
        assert!(!th.allow_at("k", t0), "one real suppression");

        let poisoner = {
            let th = std::sync::Arc::clone(&th);
            std::thread::spawn(move || {
                // The guard is held across the panic, so unwinding poisons it.
                let _held = th.emitted.lock().expect("fresh counter lock");
                panic!("deliberate: poison the emitted counter");
            })
        };
        assert!(poisoner.join().is_err(), "the poisoner must have panicked");

        let rep = th.report("k");
        assert!(
            rep.contains("غير متاح"),
            "an unreadable counter must be said, not zeroed: {rep}"
        );
        assert!(
            !rep.contains("emitted /"),
            "no two-number claim may be printed at all: {rep}"
        );
        assert!(
            rep.contains("emitted مقفل"),
            "the line must name WHICH side is unknown: {rep}"
        );

        // Control: a healthy throttle still prints real numbers — the fix
        // changed the unavailable case only.
        let fresh = Throttle::new();
        assert!(fresh.allow_at("k", t0));
        assert!(
            fresh.report("k").contains("1 emitted / 0 suppressed"),
            "healthy path unchanged: {}",
            fresh.report("k")
        );
    }
}
