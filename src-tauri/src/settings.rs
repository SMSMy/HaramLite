//! Sprint D1 — unified, Rust-backed settings (single source of truth).
//!
//! The frontend keeps localStorage only as a fast read-cache; every change
//! is also pushed here via `set_settings`, and the watch-folder service
//! (watch_service.rs) reads these values to survive app restarts.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    // ── existing UI preferences ──
    pub lang: String,             // "ar" | "en"
    pub cuda: bool,
    pub notify: bool,
    pub preview: bool,
    pub preview_seconds: u32,     // 10 | 15 | 30
    pub keep_instrumental: bool,
    pub log_open: bool,
    // ── watch folder (Sprint D2) ──
    pub watch_enabled: bool,
    pub watch_path: Option<String>,
    pub watch_mode: String,       // "song" | "clip"
    pub watch_out_kind: String,   // "auto" | "video" | "audio"
    pub watch_max_size_mb: u64,   // disk guard: reject larger files
    pub watch_rescan_secs: u64,   // periodic rescan (notify misses events)
    pub bridge_enabled: bool,     // browser-integration checkbox (Sprint E3)
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            lang: "ar".into(),
            cuda: false,
            notify: false,
            preview: false,
            preview_seconds: 15,
            keep_instrumental: false,
            log_open: true,
            watch_enabled: false,
            watch_path: None,
            watch_mode: "song".into(),
            watch_out_kind: "auto".into(),
            watch_max_size_mb: 2048,
            watch_rescan_secs: 60,
            bridge_enabled: false,
        }
    }
}

pub fn path(app_data: &Path) -> PathBuf {
    app_data.join("settings.json")
}

pub fn load(app_data: &Path) -> Settings {
    let p = path(app_data);
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(app_data: &Path, s: &Settings) -> std::io::Result<()> {
    let p = path(app_data);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Atomic write: a crash mid-write must never leave a truncated/empty
    // settings file (the same tmp+rename pattern as yt_dlp.rs/bridge.rs).
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(s)?)?;
    std::fs::rename(&tmp, &p)
}
