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
    pub lang: String, // "ar" | "en"
    pub cuda: bool,
    pub notify: bool,
    pub preview: bool,
    pub preview_seconds: u32, // 10 | 15 | 30
    pub keep_instrumental: bool,
    pub log_open: bool,
    // Switching this off leaves yt-dlp frozen at its current version, so a
    // site change can break downloads until the user updates by hand — hence
    // the status line and warning the settings panel shows while it is off.
    pub ytdlp_auto_update: bool,
    // ── watch folder (Sprint D2) ──
    pub watch_enabled: bool,
    pub watch_path: Option<String>,
    pub watch_mode: String,     // "song" | "clip"
    pub watch_out_kind: String, // "auto" | "video" | "audio"
    pub watch_max_size_mb: u64, // disk guard: reject larger files
    pub watch_rescan_secs: u64, // periodic rescan (notify misses events)
    pub bridge_enabled: bool,   // browser-integration checkbox (Sprint E3)
    /// هل سُئل المستخدم عن التشغيل مع النظام مرة واحدة؟ (يُسأل مرة واحدة فقط)
    pub autostart_asked: bool,
    // ── Telegram bot (Sprint T1) ──
    pub telegram_enabled: bool,
    pub telegram_token: String,    // BotFather token "123456:ABC…"
    pub telegram_user_id: String,  // owner's numeric id; empty ⇒ pairing mode
    pub telegram_audio_only: bool, // always deliver mp3 (skips the video render)
    // Advanced: a LOCAL Bot API server lifts the cloud caps (send 50MB /
    // download 20MB → 2000MB) and hands files to us as plain disk paths.
    // api_id/api_hash belong to the server the owner runs, not to our calls —
    // we only keep them to print the exact launch command.
    pub telegram_api_id: String,
    pub telegram_api_hash: String,
    pub telegram_local_url: String, // e.g. "http://127.0.0.1:8081" (empty ⇒ cloud)
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
            ytdlp_auto_update: true,
            watch_enabled: false,
            watch_path: None,
            watch_mode: "song".into(),
            watch_out_kind: "auto".into(),
            watch_max_size_mb: 2048,
            watch_rescan_secs: 60,
            bridge_enabled: false,
            autostart_asked: false,
            telegram_enabled: false,
            telegram_token: String::new(),
            telegram_user_id: String::new(),
            telegram_audio_only: false,
            telegram_api_id: String::new(),
            telegram_api_hash: String::new(),
            telegram_local_url: String::new(),
        }
    }
}

pub fn path(app_data: &Path) -> PathBuf {
    app_data.join("settings.json")
}

pub fn load(app_data: &Path) -> Settings {
    let p = path(app_data);
    match std::fs::read_to_string(&p) {
        Ok(s) => {
            let mut v: Settings = serde_json::from_str(&s).unwrap_or_default();
            // Secrets are sealed at rest (seal.rs). Open them in memory here so
            // the rest of the app only ever sees plaintext — and so an upgrade
            // from a plaintext file keeps working before the first re-save.
            v.telegram_token = crate::seal::open_setting(&v.telegram_token);
            v.telegram_api_hash = crate::seal::open_setting(&v.telegram_api_hash);
            v
        }
        Err(_) => Settings::default(),
    }
}

pub fn save(app_data: &Path, s: &Settings) -> std::io::Result<()> {
    let p = path(app_data);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Never write a secret in the clear: seal a COPY, leaving the caller's
    // in-memory value (and the running worker) untouched.
    let mut on_disk = s.clone();
    on_disk.telegram_token = crate::seal::seal_setting(&s.telegram_token);
    on_disk.telegram_api_hash = crate::seal::seal_setting(&s.telegram_api_hash);
    // و-٦: نفس نمط tmp+rename، لكن عبر المساعد الموحّد الذي يضيف `sync_all`
    // قبل النقل — الإعدادات أهمّ ملف في التطبيق، وانقطاع التيار في اللحظة
    // الحرجة كان يفقد آخر كتابة (الملف المقطوع كان محفوظاً أصلاً).
    // The temp name is unchanged (`.json.tmp`): same path, same recoverability.
    let body = serde_json::to_string_pretty(&on_disk)?;
    crate::atomic::write_atomic_str(&p, &body, "json")
}

/// True when the file still holds a secret in the clear (an install upgraded
/// from a build that predates sealing). The caller re-saves once so the upgrade
/// completes even if the user never touches a setting.
pub fn needs_sealing(app_data: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path(app_data)) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    ["telegram_token", "telegram_api_hash"].iter().any(|k| {
        v.get(*k)
            .and_then(|x| x.as_str())
            .map(|s| !s.is_empty() && !crate::seal::is_sealed(s))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hl_settings_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn settings_round_trip_and_secrets_never_land_in_the_clear() {
        let dir = tmp("seal");
        let s = Settings {
            telegram_token: "1234567890:AA_fixture_token".into(),
            telegram_api_hash: "abcdef0123456789".into(),
            lang: "en".into(),
            ..Default::default()
        };
        save(&dir, &s).unwrap();

        let raw = std::fs::read_to_string(path(&dir)).unwrap();
        #[cfg(target_os = "windows")]
        {
            // Audit 2026-09-15 (٤.ب.٢): the guard here asserted on a string that
            // existed only in this test ("AAH_roundtrip_secret"), so it proved
            // nothing. Assert on the REAL fixture values, and on the file as a
            // whole, so a plaintext write fails the test.
            assert!(
                !raw.contains("1234567890:AA_fixture_token"),
                "the token must never be written in the clear: {raw}"
            );
            assert!(!raw.contains("abcdef0123456789"), "api_hash sealed too");
            assert!(raw.contains(crate::seal::MARKER), "sealed marker expected");
            // The marker must be ON the secret's own field, not just somewhere.
            let on_disk: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let stored = on_disk["telegram_token"].as_str().unwrap_or_default();
            assert!(
                crate::seal::is_sealed(stored),
                "the token field itself must carry the marker: {stored}"
            );
            assert_eq!(
                crate::seal::open_setting(stored),
                "1234567890:AA_fixture_token",
                "the sealed field must still open back to the token"
            );
            assert!(
                !needs_sealing(&dir),
                "a freshly saved file has nothing left to seal"
            );
        }
        // …and it still comes back whole.
        let back = load(&dir);
        assert_eq!(back.telegram_token, "1234567890:AA_fixture_token");
        assert_eq!(back.telegram_api_hash, "abcdef0123456789");
        assert_eq!(back.lang, "en");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ytdlp_auto_update_is_on_by_default_and_survives_an_old_file() {
        // ق-١: الإقلاع لا يفحص تحديث yt-dlp إلا إذا كان هذا الحقل true، فأي
        // مسار يجعل «الغياب» يعني false يوقف الفحص بصمت عن كل مستخدم قديم.
        assert!(
            Settings::default().ytdlp_auto_update,
            "الافتراضي يجب أن يكون التشغيل"
        );

        // ملف قديم كتبه بناء لا يعرف الحقل أصلاً (لا مفتاح في JSON).
        let dir = tmp("ytdlp_auto_legacy");
        std::fs::write(path(&dir), r#"{"lang":"ar","cuda":true}"#).unwrap();
        assert!(
            load(&dir).ytdlp_auto_update,
            "غياب المفتاح في ملف قديم يجب أن يعني التشغيل، لا الإطفاء"
        );

        // وإطفاء صريح يبقى مُطفأً (الاختبار السلبي: الحقل ليس ثابتاً على true).
        std::fs::write(path(&dir), r#"{"ytdlp_auto_update":false}"#).unwrap();
        assert!(!load(&dir).ytdlp_auto_update, "الإطفاء المكتوب يجب أن يُقرأ");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_plaintext_file_from_an_older_build_still_loads() {
        let dir = tmp("legacy");
        std::fs::write(
            path(&dir),
            r#"{"lang":"ar","telegram_token":"1234567890:PLAINTEXT_OLD","telegram_enabled":true}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.telegram_token, "1234567890:PLAINTEXT_OLD");
        assert!(s.telegram_enabled);
        // A re-save seals it, so an upgrade heals itself on the first write.
        save(&dir, &s).unwrap();
        let raw = std::fs::read_to_string(path(&dir)).unwrap();
        #[cfg(target_os = "windows")]
        assert!(!raw.contains("PLAINTEXT_OLD"), "upgrade must seal: {raw}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn needs_sealing_detects_only_a_cleartext_secret() {
        let dir = tmp("needs");
        // No file at all ⇒ nothing to do.
        assert!(!needs_sealing(&dir));
        // Plaintext ⇒ yes.
        std::fs::write(
            path(&dir),
            r#"{"telegram_token":"1234567890:SOMETHING","telegram_api_hash":"","telegram_enabled":true}"#,
        )
        .unwrap();
        assert!(needs_sealing(&dir));
        // Empty secrets are not secrets.
        std::fs::write(
            path(&dir),
            r#"{"telegram_token":"","telegram_api_hash":""}"#,
        )
        .unwrap();
        assert!(!needs_sealing(&dir));
        // Sealed (or a broken file) ⇒ no rewrite.
        std::fs::write(
            path(&dir),
            r#"{"telegram_token":"dpapi:v1:00ff","telegram_api_hash":""}"#,
        )
        .unwrap();
        assert!(!needs_sealing(&dir));
        std::fs::write(path(&dir), "{ not json").unwrap();
        assert!(!needs_sealing(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
