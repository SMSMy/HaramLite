//! Single source of truth for the app's data directory.
//!
//! Why `%LOCALAPPDATA%` and not `%APPDATA%` (owner's decision, 2026-09-11):
//! everything kept there is machine-local by nature — `locks/`, `logs/`, the
//! browser request queue, `page-audio/`, the Telegram scratch, `provider.json`,
//! `watch_done.json`, `session.lock` — and it holds a bot token. `%APPDATA%` is
//! the ROAMING profile: in a domain it travels between machines, and it is the
//! folder backup and cloud-sync tools include by default. So a machine-bound or
//! secret value there is both a security smell and a functional hazard (a
//! DPAPI blob does not survive being copied to another machine). Microsoft's
//! guidance is the same: machine- or hardware-bound and cached data belongs in
//! `%LOCALAPPDATA%`.

use std::path::{Path, PathBuf};

pub const APP_DIR_NAME: &str = "com.harammute.haramlite";

/// The one place that decides where app data lives. `HARAMLITE_DATA_DIR` still
/// wins, so tests never touch real user data (existing convention in bridge.rs).
pub fn data_dir() -> PathBuf {
    resolve_data_dir(
        std::env::var("HARAMLITE_DATA_DIR").ok().as_deref(),
        dirs::data_local_dir(),
        dirs::data_dir(),
    )
}

/// Pure resolution, so the precedence is testable WITHOUT mutating the
/// process-wide env var — a test that sets `HARAMLITE_DATA_DIR` races with every
/// parallel test that resolves a path through here (observed as a one-off
/// failure of the pipeline lock test, 2026-09-11).
fn resolve_data_dir(override_dir: Option<&str>, local: Option<PathBuf>, roaming: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = override_dir {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    local
        // Falling back to the roaming dir is still better than losing data on
        // an exotic system without LOCALAPPDATA.
        .or(roaming)
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_DIR_NAME)
}

/// The pre-2026-09-11 location (`%APPDATA%`, roaming). Read only, for the
/// one-time migration and as a read fallback if that migration ever fails.
pub fn legacy_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join(APP_DIR_NAME)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Migration {
    /// Nothing to do: already migrated, or no legacy data at all.
    Nothing,
    Moved { files: usize },
    Failed(String),
}

/// One-time move off the roaming profile: **copy → verify → remove**. Nothing
/// is deleted unless the copy proved complete, so a failed migration can never
/// cost the user their settings (the caller keeps reading the old file).
pub fn migrate_legacy(legacy: &Path, target: &Path) -> Migration {
    if !legacy.is_dir() || legacy == target {
        return Migration::Nothing;
    }
    // Already migrated (or a fresh install): the target owns the settings now.
    if target.join("settings.json").is_file() {
        return Migration::Nothing;
    }
    if count_files(legacy) == 0 {
        return Migration::Nothing;
    }
    let files = match copy_tree(legacy, target) {
        Ok(n) => n,
        Err(e) => return Migration::Failed(e),
    };
    if let Some(missing) = first_missing(legacy, target) {
        return Migration::Failed(format!("نسخة غير مكتملة: {}", missing.display()));
    }
    // Verified — the old tree is now a duplicate. Its removal is a courtesy:
    // failing to remove it must never fail the migration.
    if let Err(e) = std::fs::remove_dir_all(legacy) {
        tracing::warn!(target: "app", "تعذر حذف مجلد البيانات القديم بعد نجاح النقل: {e}");
    }
    Migration::Moved { files }
}

/// Crate-wide test lock for tests that touch process-wide state — chiefly the
/// `HARAMLITE_DATA_DIR` env var. Anything resolving a path through `data_dir()`
/// is in the blast radius, because one test's teardown deletes its temp base,
/// and that used to unclaim the pipeline lock test mid-test (the lock file
/// lives under the very same resolved path — a real flake caught 2026-09-11).
#[cfg(test)]
pub fn test_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}

fn count_files(root: &Path) -> usize {
    walk(root).len()
}

/// Every file under `root`, as paths relative to it.
fn walk(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_path_buf());
            }
        }
    }
    out
}

fn copy_tree(from: &Path, to: &Path) -> Result<usize, String> {
    let mut copied = 0;
    for rel in walk(from) {
        let src = from.join(&rel);
        let dst = to.join(&rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
        copied += 1;
    }
    Ok(copied)
}

/// First source file whose copy is absent or a different size — the check that
/// licenses deleting the original.
fn first_missing(from: &Path, to: &Path) -> Option<PathBuf> {
    for rel in walk(from) {
        let src = from.join(&rel);
        let dst = to.join(&rel);
        let same = match (std::fs::metadata(&src), std::fs::metadata(&dst)) {
            (Ok(a), Ok(b)) => a.len() == b.len(),
            _ => false,
        };
        if !same {
            return Some(rel);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hl_paths_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn migration_copies_verifies_then_removes_the_old_tree() {
        let root = tmp("move");
        let old = root.join("roaming");
        let new = root.join("local");
        std::fs::create_dir_all(old.join("logs")).unwrap();
        std::fs::write(old.join("settings.json"), br#"{"lang":"ar"}"#).unwrap();
        std::fs::write(old.join("logs").join("a.log"), b"hello").unwrap();

        assert_eq!(migrate_legacy(&old, &new), Migration::Moved { files: 2 });
        assert!(new.join("settings.json").is_file(), "settings must arrive");
        assert!(new.join("logs").join("a.log").is_file(), "nested files too");
        assert!(!old.exists(), "the verified original is removed");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_never_runs_twice_and_never_touches_a_fresh_install() {
        let root = tmp("twice");
        let old = root.join("roaming");
        let new = root.join("local");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("settings.json"), b"old").unwrap();
        // target already owns settings.json ⇒ the old copy is left alone
        std::fs::write(new.join("settings.json"), b"new").unwrap();
        assert_eq!(migrate_legacy(&old, &new), Migration::Nothing);
        assert!(old.join("settings.json").is_file(), "must not delete the old tree");
        assert_eq!(std::fs::read(new.join("settings.json")).unwrap(), b"new");
        // fresh install: no legacy at all
        let empty = root.join("empty_legacy");
        assert_eq!(migrate_legacy(&empty, &new), Migration::Nothing);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_reports_failure_and_keeps_the_original_when_the_copy_fails() {
        let root = tmp("fail");
        let old = root.join("roaming");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("settings.json"), b"data").unwrap();
        // A target that cannot exist: a *file* stands where the directory goes.
        let blocked = root.join("blocked");
        std::fs::write(&blocked, b"i am a file").unwrap();
        match migrate_legacy(&old, &blocked.join("sub")) {
            Migration::Failed(_) => {}
            other => panic!("expected Failed, got {other:?}"),
        }
        assert!(old.join("settings.json").is_file(), "the original must survive a failure");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn data_dir_precedence_is_override_then_local_then_roaming() {
        let local = PathBuf::from("C:\\Users\\x\\AppData\\Local");
        let roaming = PathBuf::from("C:\\Users\\x\\AppData\\Roaming");
        // An explicit override always wins (this is the test hook).
        assert_eq!(
            resolve_data_dir(Some("C:\\tmp\\hl"), Some(local.clone()), Some(roaming.clone())),
            PathBuf::from("C:\\tmp\\hl")
        );
        // A blank override is not an override.
        assert_eq!(
            resolve_data_dir(Some("   "), Some(local.clone()), Some(roaming.clone())),
            local.join(APP_DIR_NAME)
        );
        // LOCALAPPDATA is the intended home.
        assert_eq!(
            resolve_data_dir(None, Some(local.clone()), Some(roaming.clone())),
            local.join(APP_DIR_NAME)
        );
        // Roaming is only a last resort, then temp — never a panic.
        assert_eq!(
            resolve_data_dir(None, None, Some(roaming.clone())),
            roaming.join(APP_DIR_NAME)
        );
        assert!(resolve_data_dir(None, None, None).ends_with(APP_DIR_NAME));
    }
}
