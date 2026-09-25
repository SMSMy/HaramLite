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
    // (**حُذف `preview` و`preview_seconds`** — جولة settings2 الرابعة: كانا
    // إعدادَي «المعاينة السريعة»، ولا سطح لهما في الواجهة أصلاً، وكانا يقرأهما
    // `pipeline.rs` فيُقصّ الصوت إلى أوّل N ثانية ويُوسَم الناتج `_preview` عند
    // تحرير `settings.json` يدوياً. وقياس الجولة: كل مسارات الإنتاج والاختبار
    // تمرّر `None` (‏`lib.rs:575` · `bridge.rs:1261` · `cli.rs:314` ·
    // `telegram.rs:6888` · `watch_service.rs:306`) فلا سلوك مرصود يتغيّر.
    // وملف قديم يحمل المفتاحين **يُحمَّل كما هو**: `serde` يتجاهل الحقول
    // المجهولة، والاختبار `removed_preview_keys_in_an_old_file_still_load` يقيسه.)
    pub keep_instrumental: bool,
    pub log_open: bool,
    // م١: سقف الفصول المتزامنة على الجهاز. **إعداد بطاقةٍ لا تفضيل**: قياس
    // المالك على RTX 3070 (8192 MiB) أعطى 1419 + n×2325 MiB ⇒ الثالثة تتجاوز
    // ذاكرة الكرت. فالمدى المسموح 1..=2 وحده، وما خرج يُقصّ في `normalize`.
    pub max_concurrent_jobs: u32,
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
    /// م٤: وضع المجموعة — `"mentions"` (افتراضيّ، قرار المالك) أو `"all"`.
    ///
    /// **ولماذا الافتراضيّ «بالمنشن»**: البوت يعالج **على جهاز المالك**، فمجموعةٌ
    /// يرسل فيها كل عضو رابطاً بلا منشن = معالجة بلا إذن على حاسبه. والوضع
    /// الموسَّع («كل الرسائل») لا يعالج شيئاً بلا ضغطة المالك (بطاقة موافقة في
    /// خاصّه)، فهو توسيعٌ **مُصرَّح** لا فتحٌ أعمى.
    pub telegram_group_mode: String,
    /// م٥: «استخدم اسم HaramLite وصورته للبوت» — يُطبَّق بـ`setMyName`
    /// و`setMyProfilePhoto`، وإلغاؤه يُعيد الوضع السابق
    /// (`removeMyProfilePhoto` ثم الاسم المخزَّن). **والافتراضيّ: لا** — هوية
    /// البوت ملكُ صاحبه، فلا تُغيَّر بلا طلبٍ صريح.
    pub telegram_bot_identity: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            lang: "ar".into(),
            cuda: false,
            notify: false,
            keep_instrumental: false,
            log_open: true,
            max_concurrent_jobs: crate::slots::DEFAULT_LIMIT,
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
            telegram_group_mode: GROUP_MODE_MENTIONS.to_string(),
            telegram_bot_identity: false,
        }
    }
}

/// م٤ — وضعا المجموعة. **قيمتان لا أكثر**، وما خالفهما يُقيَّد عند التحميل.
pub const GROUP_MODE_MENTIONS: &str = "mentions";
/// الوضع الموسَّع: كل رسالة تُعرَض على المالك في خاصّه، ولا معالجة قبل ضغطته.
pub const GROUP_MODE_ALL: &str = "all";

/// تقييد وضع المجموعة: قيمة غير معروفة ⇒ الافتراضيّ الآمن.
///
/// **ولماذا التقييد لا القبول**: قيمة مجهولة تعني «وضعاً» لا وجود له في الكود،
/// فتمرّ إلى `TgConfig` ويُبنى عليها سلوك غير معرَّف (وهو أسوأ من سلوكٍ ضيّق).
/// والقاعدة: المجهول يُقيَّد إلى الأضيق لا إلى الأوسع.
pub fn clamp_group_mode(v: &str) -> String {
    match v.trim() {
        GROUP_MODE_ALL => GROUP_MODE_ALL.to_string(),
        _ => GROUP_MODE_MENTIONS.to_string(),
    }
}

pub fn path(app_data: &Path) -> PathBuf {
    app_data.join("settings.json")
}

impl Settings {
    /// قصّ القيم الخارجة عن مداها. **نقطة واحدة** يستدعيها كل مدخل تُقرأ منه
    /// الإعدادات: `load` (ملف عُدّل يدوياً) و`set_settings` (`serde_json`
    /// مباشرةً، فلا يمرّ بـ`load`).
    ///
    /// ولماذا يلزم القصّ أصلاً: القيمة تُحفظ وتُنشر إلى الواجهة كما هي، فسقف 7
    /// في الملف يبقى معروضاً ويُكتب ثانيةً — ولو قُصّ عند الاستعمال وحده لبدت
    /// الواجهة تقول 7 والمحرّك يعمل بـ2.
    pub fn normalize(&mut self) {
        self.max_concurrent_jobs = crate::slots::clamp_limit(self.max_concurrent_jobs);
        // م٤: وضع المجموعة يُقيَّد هنا أيضاً — والقصّ في `normalize` وحدها
        // يستدعيه `load` (ملف عُدّل يدوياً) و`set_settings` (‏serde مباشرةً).
        self.telegram_group_mode = clamp_group_mode(&self.telegram_group_mode);
    }
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
            v.normalize();
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

    /// **حذف `preview` و`preview_seconds` لا يكسر ملفاً قديماً**: `#[serde(default)]`
    /// يعني أن المفتاح الغائب يأخذ الافتراضيّ، والحقل **المجهول** في الملف
    /// يُتجاهَل (لا `deny_unknown_fields`) ⇒ فلا خطأ تحميل ولا حاجة إلى ترحيل.
    /// وهذا يقيسه هذا الاختبار: ملف كتبه بناء سابق يحمل المفتاحين يُحمَّل، وبقيّة
    /// قيمه تصل سليمة، وإعادة الحفظ تُسقط المفتاحين وحدهما.
    #[test]
    fn removed_preview_keys_in_an_old_file_still_load() {
        let dir = tmp("removed_preview");
        std::fs::write(
            path(&dir),
            r#"{"lang":"en","cuda":true,"preview":true,"preview_seconds":30,"notify":true}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.lang, "en", "بقيّة القيم تُقرأ كما هي");
        assert!(s.cuda && s.notify);
        // وإعادة الحفظ تُنتج ملفاً بلا المفتاحين (والباقي سليم).
        save(&dir, &s).unwrap();
        let raw = std::fs::read_to_string(path(&dir)).unwrap();
        assert!(
            !raw.contains("\"preview\""),
            "المفتاح المحذوف يجب ألّا يُكتب ثانيةً: {raw}"
        );
        assert!(raw.contains("\"notify\""), "وبقيّة الحقول تُكتب");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// م١: سقف الفصول المتزامنة — الافتراضي **1** (قرار المالك بعد قياس هامش
    /// الفصلين: 245 MiB)، والمسموح 1..=2، وما خرج يُقصّ **عند القراءة** فلا
    /// يبقى سقف 9 في الذاكرة ولا يُعرض في الواجهة ولا يُكتب ثانيةً. (القصّ في
    /// `normalize` وحدها، و`set_settings` يناديها.)
    #[test]
    fn max_concurrent_jobs_defaults_to_one_and_clamps_out_of_range_values() {
        assert_eq!(
            Settings::default().max_concurrent_jobs,
            crate::slots::DEFAULT_LIMIT,
            "الافتراضي هو DEFAULT_LIMIT نفسه (1) لا رقم مكرَّر هنا"
        );
        assert_eq!(
            crate::slots::DEFAULT_LIMIT,
            1,
            "الافتراضيّ المعلَن للمستخدم: 1 (والسقف المسموح 2 يبقى اختياراً)"
        );
        let dir = tmp("max_jobs");
        std::fs::write(path(&dir), r#"{"max_concurrent_jobs":9}"#).unwrap();
        assert_eq!(load(&dir).max_concurrent_jobs, 2, "9 تُقصّ إلى السقف");
        std::fs::write(path(&dir), r#"{"max_concurrent_jobs":0}"#).unwrap();
        assert_eq!(
            load(&dir).max_concurrent_jobs,
            1,
            "0 تُرفع إلى 1 لا انتظار أبدي"
        );
        std::fs::write(path(&dir), r#"{"max_concurrent_jobs":1}"#).unwrap();
        assert_eq!(load(&dir).max_concurrent_jobs, 1, "القيمة المشروعة تمرّ");
        std::fs::write(path(&dir), r#"{"lang":"ar"}"#).unwrap();
        assert_eq!(
            load(&dir).max_concurrent_jobs,
            1,
            "ملف بناء قديم ⇒ الافتراضي (1)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// م٤: وضع المجموعة — الافتراضيّ «بالمنشن» (قرار المالك)، الموسَّع اختيارٌ
    /// صريح، **وكل ما ليس قيمةً معروفة يُقيَّد إلى الافتراضيّ الأضيق** عند
    /// التحميل. (مُفسَد محروس: إسقاط التقييد ⇒ يبقى `"garbage"` ويكسر مقارنة
    /// `TgConfig` ويُبنى عليه سلوك غير معرَّف.)
    #[test]
    fn telegram_group_mode_defaults_to_mentions_and_clamps_unknown_values() {
        assert_eq!(
            Settings::default().telegram_group_mode,
            GROUP_MODE_MENTIONS,
            "الافتراضيّ قرار المالك: بالمنشن"
        );
        // القيمتان المعروفتان تمرّان كما هما.
        assert_eq!(clamp_group_mode("all"), GROUP_MODE_ALL);
        assert_eq!(clamp_group_mode("mentions"), GROUP_MODE_MENTIONS);
        // وكل ما خالفهما — حتى الفراغ وتغيّر الحالة والصيغة القريبة — يُقيَّد.
        for bad in [
            "", "  ", "ALL", "All", "alll", "everyone", "1", "true", "منشن", "all ",
        ] {
            let got = clamp_group_mode(bad);
            assert!(
                got == GROUP_MODE_MENTIONS || got == GROUP_MODE_ALL,
                "قيمة خارج المجموعة نجت من التقييد: {bad:?} ⇒ {got:?}"
            );
            if bad.trim() != "all" {
                assert_eq!(
                    got, GROUP_MODE_MENTIONS,
                    "المجهول يجب أن يُقيَّد إلى الأضيق لا إلى الأوسع: {bad:?}"
                );
            }
        }
        // ومن ملف على القرص: القيمة المجهولة لا تصل إلى الذاكرة أصلاً.
        let dir = tmp("group_mode");
        std::fs::write(path(&dir), r#"{"telegram_group_mode":"garbage"}"#).unwrap();
        assert_eq!(load(&dir).telegram_group_mode, GROUP_MODE_MENTIONS);
        std::fs::write(path(&dir), r#"{"telegram_group_mode":"all"}"#).unwrap();
        assert_eq!(load(&dir).telegram_group_mode, GROUP_MODE_ALL);
        // وملف بناء قديم لا يعرف الحقل ⇒ الافتراضيّ.
        std::fs::write(path(&dir), r#"{"lang":"ar"}"#).unwrap();
        assert_eq!(load(&dir).telegram_group_mode, GROUP_MODE_MENTIONS);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
