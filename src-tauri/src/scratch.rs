//! Scratch cleanup that runs on EVERY exit path.
//!
//! Audit 2026-09-15 (٤.ب.٦): the failure paths are exactly the ones that leak —
//! an early `?` return skips the single cleanup call sitting at the end of the
//! function (`%TEMP%\hl_player_<pid>`, a partial `<name>.download`). A drop
//! guard cannot be skipped: the same pattern already runs in telegram.rs
//! (`ScratchGuard`, :1078), and this is its shared form for the two other
//! scratch sites — one implementation, one place that decides what "gone"
//! means (a missing path is not an error, a refusal is warned).

use std::path::{Path, PathBuf};

/// Removes what it tracks when it is dropped — a file, or a whole directory.
pub struct ScratchGuard {
    paths: Vec<PathBuf>,
}

impl ScratchGuard {
    /// Take ownership of one scratch path (it need not exist yet).
    pub fn new(p: &Path) -> Self {
        Self {
            paths: vec![p.to_path_buf()],
        }
    }
}

impl Drop for ScratchGuard {
    fn drop(&mut self) {
        for p in &self.paths {
            let removed = if p.is_dir() {
                std::fs::remove_dir_all(p)
            } else {
                std::fs::remove_file(p)
            };
            match removed {
                Ok(()) => tracing::debug!(target: "app", "حُذف مؤقت: {}", p.display()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => tracing::warn!(target: "app", "تعذر حذف المؤقت {}: {e}", p.display()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hl_scratch_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_tracked_scratch_path_is_gone_after_an_early_return() {
        let root = tmp("early");
        let dir = root.join("hl_player_fixture");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("_haramlite_normalized_x.wav"), b"partial").unwrap();
        let file = root.join("ffmpeg.download");
        std::fs::write(&file, b"partial").unwrap();

        // The shape of every leaking site: the guard is taken first, then a
        // fallible step returns early with `?`.
        fn work(dir: &Path, file: &Path) -> Result<(), String> {
            let _scratch_dir = ScratchGuard::new(dir);
            let _scratch_file = ScratchGuard::new(file);
            std::fs::read_to_string(dir.join("input_that_never_arrived"))
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        assert!(work(&dir, &file).is_err(), "the fixture must fail early");
        assert!(
            !dir.exists(),
            "the scratch dir must be gone after the early return"
        );
        assert!(!file.exists(), "the partial download must be gone too");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_scratch_path_is_not_an_error() {
        let root = tmp("missing");
        let never = root.join("never_created");
        drop(ScratchGuard::new(&never)); // must not warn, must not panic
        assert!(!never.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
