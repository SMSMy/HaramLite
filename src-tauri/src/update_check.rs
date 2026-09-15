//! هـ) نظام التحديث (الخيار ١) — فحص الإصدار من واجهة GitHub العامة.
//!
//! لماذا نداء `releases/latest` ولا مُحدِّث Tauri الموقّع؟ لأن `tauri.conf.json`
//! يحمل `createUpdaterArtifacts:false` فلا يُنشر `latest.json` أبداً، فنداء
//! `tauri-plugin-updater` يفشل دائماً — وهو العطل نفسه الذي أُزيل لأجله زرّ
//! «التحقق من التحديثات» في 0.2.4. هنا: نداء واحد بلا توقيع وبلا ملف وسيط، ثم
//! مقارنة **دلالية** مع إصدار حزمة التطبيق نفسه (`app.package_info().version`)
//! لا مع سلسلة مكتوبة بيد — فتغيير الإصدار في `tauri.conf.json` وحده يكفي.
//!
//! هـ.٤ — حدّ المعدّل (60 طلباً/الساعة لكل IP بلا مصادقة): الفحص عند الطلب
//! (الزرّ) دائماً نداء حقيقي، والفحص الصامت عند الإقلاع خلف **كاش ٢٤ ساعة**
//! في `update_check.json` داخل مجلد بيانات التطبيق (`paths::data_dir()`) —
//! فكل إقلاعات اليوم تكلّف نداءً واحداً. وفشل النداء لا يُكتب في الكاش: بلا
//! شبكة لا يصل الطلب إلى GitHub أصلاً فلا يُستهلك من الحدّ شيء، والاحتفاظ
//! بالفشل ٢٤ ساعة كان سيخفي تحديثاً حقيقياً بعد عثرة عابرة.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// نقطة النهاية الوحيدة — إصدار واحد، لا قائمة إصدارات ولا ملف تحديثات.
const LATEST_API: &str = "https://api.github.com/repos/SMSMy/HaramLite/releases/latest";
/// صفحة التنزيل الاحتياطية: تُعاد في مسار الفشل فلا يعود رابط فارغ أبداً.
const RELEASES_PAGE: &str = "https://github.com/SMSMy/HaramLite/releases/latest";
const TAG_PAGE_BASE: &str = "https://github.com/SMSMy/HaramLite/releases/tag";
/// `User-Agent` إلزامي في واجهة GitHub العامة (وبدونه يرتدّ الطلب بـ403).
const USER_AGENT: &str = concat!("HaramLite/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(15);
/// مدّة صلاحية الكاش: ٢٤ ساعة (هـ.٤).
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const CACHE_FILE: &str = "update_check.json";

// ─────────────────────────────────────────────────────────────────────
// المقارنة الدلالية (SemVer) — دالّة نقيّة بلا شبكة ولا ملفات
// ─────────────────────────────────────────────────────────────────────

/// إصدار مُفكَّك. الحقول الثلاثة الأولى تُقارن **عددياً** (‏`0.2.10` أحدث من
/// `0.2.9` — والمقارنة النصّية تقول العكس).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Semver {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// قرار اللاحقات (`-rc` · `-beta` · أي لاحقة): وفق SemVer §11 **الإصدار ذو
    /// اللاحقة أقدم من نظيره المستقر** ⇒ `0.2.5-rc1` أقدم من `0.2.5`، فمن كان
    /// على `0.2.5-rc1` يُقال له إن `0.2.5` متوفّر، ومن كان على `0.2.5` لا
    /// يُنزعج بـ`0.2.5-rc1`. وهي مكتوبة **رتبةً** لا علماً (`1` مستقر · `0` ذو
    /// لاحقة) ليرتّب `Ord` المشتقّ الحقلَين ترتيباً صحيحاً بلا مقارنة يدوية.
    /// ولاحقتان على النواة نفسها (`rc1` مقابل `rc2`) تتساويان هنا **قصداً**:
    /// لا إشعار بتذبذب إصدارات تجريبية، لأن إشعاراً كاذباً أسوأ من تفويت rc.
    pub stability: u8,
}

/// يفكّ وسم الإصدار: يقبل `v0.2.4` و`0.2.4`، ويتجاهل ما بعد `+` (وصف البناء
/// لا يدخل في الأسبقية)، ويعتبر ما بعد `-` لاحقةً. ويعيد `None` لأي شيء غير
/// ثلاثة أرقام — فلا ندّعي تحديثاً على وسم لا نفهمه (خطأ في اتجاه الأمان).
pub fn parse_semver(raw: &str) -> Option<Semver> {
    let s = raw.trim();
    let s = s.strip_prefix('v').or_else(|| s.strip_prefix('V')).unwrap_or(s);
    let s = s.split('+').next().unwrap_or(s);
    let (core, pre) = match s.split_once('-') {
        Some((core, pre)) => (core, pre.trim()),
        None => (s, ""),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.trim().parse::<u64>().ok()?;
    let minor = parts.next()?.trim().parse::<u64>().ok()?;
    let patch = parts.next()?.trim().parse::<u64>().ok()?;
    Some(Semver { major, minor, patch, stability: u8::from(pre.is_empty()) })
}

/// هل `latest` أحدث من `current`؟ وسم غير مفهوم ⇒ `false` (لا إشعار بلا يقين).
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_semver(latest), parse_semver(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

// ─────────────────────────────────────────────────────────────────────
// الحالة المُعادة للواجهة
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    /// إصدار التطبيق الحالي — من `app.package_info().version`.
    pub current: String,
    /// أحدث إصدار منشور (بلا بادئة `v`)، أو `None` عند الفشل.
    pub latest: Option<String>,
    pub update_available: bool,
    /// صفحة التنزيل — رابط صالح دائماً (لا فراغ).
    pub download_url: String,
    /// رسالة عربية مفهومة عند الفشل، و`None` عند نجاح الفحص.
    pub error: Option<String>,
    /// هل جاء الجواب من كاش ٢٤ ساعة بدل نداء حقيقي (هـ.٤).
    pub from_cache: bool,
}

impl UpdateStatus {
    fn from_latest(current: &str, latest: Option<String>, download_url: &str, from_cache: bool) -> Self {
        let update_available = latest.as_deref().map(|l| is_newer(l, current)).unwrap_or(false);
        Self {
            current: current.to_string(),
            latest,
            update_available,
            download_url: download_url.to_string(),
            error: None,
            from_cache,
        }
    }

    fn failed(current: &str, error: String) -> Self {
        Self {
            current: current.to_string(),
            latest: None,
            update_available: false,
            download_url: RELEASES_PAGE.to_string(),
            error: Some(error),
            from_cache: false,
        }
    }
}

/// يقرأ حمولة `releases/latest` ويبني الحالة — **دالّة نقيّة**: لا شبكة ولا
/// ملفات، فتُختبر على نصّ الحمولة الحقيقي مباشرة (هـ.٣).
pub fn status_from_payload(current: &str, body: &str) -> Result<UpdateStatus, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("تعذر قراءة ردّ GitHub (JSON غير صالح): {e}"))?;

    let tag = v.get("tag_name").and_then(|t| t.as_str()).unwrap_or("").trim();
    if tag.is_empty() {
        // GitHub يرد على `releases/latest` في مستودع بلا إصدار بـ404، وجسمُ
        // الرد `{"message":"Not Found"}` — وهذا مسار «بلا إصدارات منشورة».
        if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
            return Err(format!("لا توجد إصدارات منشورة على GitHub بعد (ردّ الخادم: {msg})"));
        }
        return Err("ردّ غير متوقع من GitHub: لا حقل tag_name فيه".to_string());
    }

    let latest = tag.strip_prefix('v').or_else(|| tag.strip_prefix('V')).unwrap_or(tag).to_string();
    let download_url = v
        .get("html_url")
        .and_then(|u| u.as_str())
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{TAG_PAGE_BASE}/{tag}"));

    Ok(UpdateStatus::from_latest(current, Some(latest), &download_url, false))
}

// ─────────────────────────────────────────────────────────────────────
// النداء الوحيد
// ─────────────────────────────────────────────────────────────────────

/// رسالة عربية لكل رمز حالة متوقّع — تُختبر وحدها بلا شبكة.
fn http_status_message(code: u16) -> String {
    match code {
        // 403 و429 هما ردّ GitHub عند استنفاد الحدّ (60 طلباً/الساعة لكل IP).
        403 | 429 => "تجاوز حدّ الطلبات المسموح من GitHub (60 طلباً في الساعة) — أعد المحاولة بعد قليل"
            .to_string(),
        404 => "لا توجد إصدارات منشورة على GitHub بعد".to_string(),
        _ => format!("ردّ GitHub برمز خطأ {code}"),
    }
}

/// نداء واحد إلى `releases/latest` وإعادة جسم الردّ نصّاً (نمط `repair.rs`:
/// `ureq` بمهلة و`User-Agent`). كل خطأ يعود **رسالة عربية** لا panic.
fn fetch_body(url: &str, timeout: Duration) -> Result<String, String> {
    let resp = ureq::get(url).timeout(timeout).set("User-Agent", USER_AGENT).call().map_err(|e| match e {
        ureq::Error::Status(code, _) => http_status_message(code),
        ureq::Error::Transport(t) => {
            format!("تعذر الاتصال بـGitHub — تحقق من اتصالك بالإنترنت ثم أعد المحاولة ({t})")
        }
    })?;
    resp.into_string().map_err(|e| format!("تعذر قراءة ردّ GitHub: {e}"))
}

fn fetch_latest() -> Result<String, String> {
    fetch_body(LATEST_API, TIMEOUT)
}

// ─────────────────────────────────────────────────────────────────────
// الكاش (هـ.٤)
// ─────────────────────────────────────────────────────────────────────

/// آخر نتيجة **ناجحة** فقط. الطابع الزمني بالثواني منذ UNIX EPOCH.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Cache {
    checked_at: u64,
    latest: String,
    download_url: String,
}

fn cache_path(root: &Path) -> PathBuf {
    root.join(CACHE_FILE)
}

fn read_cache(root: &Path) -> Option<Cache> {
    let raw = std::fs::read_to_string(cache_path(root)).ok()?;
    serde_json::from_str::<Cache>(&raw).ok()
}

/// كتابة ذرّية (tmp ثم rename كما في `yt_dlp::write_state`)، وفشل الكاش **لا
/// يُفشل الفحص**: الجواب صحيح أصلاً، وأسوأ ما يحدث نداءٌ زائد في الإقلاع القادم.
fn write_cache(root: &Path, cache: &Cache) {
    let path = cache_path(root);
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(root)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(cache)?)?;
        std::fs::rename(&tmp, &path)
    };
    if let Err(e) = write() {
        tracing::warn!(target: "update", "تعذر حفظ كاش فحص التحديث في {}: {e}", path.display());
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// الفحص الكامل: `force=false` (الفحص الصامت عند الإقلاع) يقرأ الكاش أولاً،
/// و`force=true` (الزرّ) ينادي دائماً. الحالة تُبنى من الكاش بمقارنتها
/// بالإصدار الحالي الآن، فلا يقدُم حكم «يوجد تحديث» بتغيّر إصدار التطبيق.
fn check_with(
    root: &Path,
    current: &str,
    force: bool,
    now: u64,
    fetch: &dyn Fn() -> Result<String, String>,
) -> UpdateStatus {
    if !force {
        if let Some(c) = read_cache(root) {
            if now.saturating_sub(c.checked_at) < CACHE_TTL_SECS {
                tracing::debug!(
                    target: "update",
                    "فحص التحديث من الكاش (عمره {} ثانية) — بلا نداء لـGitHub",
                    now.saturating_sub(c.checked_at)
                );
                return UpdateStatus::from_latest(current, Some(c.latest), &c.download_url, true);
            }
        }
    }

    match fetch() {
        Ok(body) => match status_from_payload(current, &body) {
            Ok(status) => {
                if let Some(latest) = status.latest.clone() {
                    write_cache(root, &Cache { checked_at: now, latest, download_url: status.download_url.clone() });
                }
                status
            }
            Err(msg) => UpdateStatus::failed(current, msg),
        },
        // لا كاش للفشل (هـ.٤): عثرة عابرة لا تُخفي تحديثاً ٢٤ ساعة.
        Err(msg) => UpdateStatus::failed(current, msg),
    }
}

/// الواجهة الإنتاجية: كاش في مجلد بيانات التطبيق (`%LOCALAPPDATA%\
/// com.harammute.haramlite\update_check.json`)، ونداء حقيقي عند الحاجة.
pub fn check(current: &str, force: bool) -> UpdateStatus {
    check_with(&crate::paths::data_dir(), current, force, now_secs(), &|| fetch_latest())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// حمولة `releases/latest` الحقيقية لمستودع `SMSMy/HaramLite` — منسوخة
    /// نصّاً من ردّ الواجهة (قُرئت 2026-09-15، وآخر إصدار منشور فيها `v0.2.4`).
    /// حُذفت منها مفاتيح الضجيج (`author` · `uploader` · `node_id` …) وبقي كلّ
    /// ما يقرؤه هذا الملف بأسمائه وقيمه كما هي.
    const REAL_LATEST_PAYLOAD: &str = r##"{
  "tag_name": "v0.2.4",
  "target_commitish": "main",
  "name": "HaramLite 0.2.4",
  "body": "# HaramLite 0.2.4\n\nإصدار **إصلاحات ومتانة**.",
  "draft": false,
  "prerelease": false,
  "id": 389048035,
  "created_at": "2026-09-15T10:11:35Z",
  "published_at": "2026-09-15T10:24:51Z",
  "url": "https://api.github.com/repos/SMSMy/HaramLite/releases/389048035",
  "html_url": "https://github.com/SMSMy/HaramLite/releases/tag/v0.2.4",
  "assets_url": "https://api.github.com/repos/SMSMy/HaramLite/releases/389048035/assets",
  "assets": [
    {
      "name": "HaramLite_0.2.4_x64-setup.exe",
      "content_type": "application/x-msdownload",
      "size": 230889131,
      "download_count": 2,
      "browser_download_url": "https://github.com/SMSMy/HaramLite/releases/download/v0.2.4/HaramLite_0.2.4_x64-setup.exe",
      "digest": "sha256:6905f5df9ed58996b18dda8a3d8fb8b9dace95050d42fddd2280f81fa849a3f8"
    },
    {
      "name": "HaramLite_0.2.4_x64_en-US.msi",
      "content_type": "application/octet-stream",
      "size": 452173824,
      "download_count": 1,
      "browser_download_url": "https://github.com/SMSMy/HaramLite/releases/download/v0.2.4/HaramLite_0.2.4_x64_en-US.msi",
      "digest": "sha256:44d050eabe4ca7e390880e8694be6be76ae722f5c4b55aaa42969779e2814d29"
    }
  ],
  "zipball_url": "https://api.github.com/repos/SMSMy/HaramLite/zipball/v0.2.4",
  "tarball_url": "https://api.github.com/repos/SMSMy/HaramLite/tarball/v0.2.4"
}"##;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hl_update_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn has_arabic(s: &str) -> bool {
        s.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c))
    }

    /// هـ.١: المقارنة **دلالية** لا نصّية، وحدّ اللاحقات مطبَّق كما في SemVer §11.
    #[test]
    fn version_comparison_is_numeric_and_puts_prereleases_below_stable() {
        // عددية لا نصّية: «0.2.10» < «0.2.9» نصّاً، وأحدث منها دلالياً.
        assert!(is_newer("0.2.10", "0.2.9"), "patch must compare numerically, not as text");
        assert!(is_newer("0.3.0", "0.2.99"), "minor outranks any patch");
        assert!(is_newer("1.0.0", "0.99.99"), "major outranks everything");
        assert!(is_newer("v0.2.5", "0.2.4"), "the leading v of the tag is not part of the version");
        assert!(!is_newer("0.2.4", "0.2.4"), "the same version is not newer");
        assert!(!is_newer("0.2.4", "0.2.5"), "an older tag must never look newer");

        // SemVer §11: ذو اللاحقة أقدم من نظيره المستقر.
        assert!(is_newer("0.2.5", "0.2.5-rc1"), "0.2.5 is newer than 0.2.5-rc1");
        assert!(!is_newer("0.2.5-rc1", "0.2.5"), "0.2.5-rc1 is NOT newer than 0.2.5");
        assert!(!is_newer("0.2.5-beta", "0.2.5"), "same rule for -beta");
        assert!(
            !is_newer("0.2.5-rc2", "0.2.5-rc1"),
            "two prereleases of one core compare equal on purpose — rc churn never prompts"
        );
        assert!(is_newer("0.2.6-rc1", "0.2.5"), "a newer core still wins over an older stable");

        // وسم غير مفهوم ⇒ لا ادّعاء تحديث (خطأ في اتجاه الأمان).
        assert!(!is_newer("nightly", "0.2.4"), "an unparseable tag must not claim an update");
        assert!(!is_newer("0.2", "0.2.4"), "a two-component version is not a SemVer we trust");
        assert!(!is_newer("", "0.2.4"), "an empty tag must not claim an update");
        assert!(parse_semver("v0.2.4").is_some() && parse_semver("0.2.4+build.7").is_some());
    }

    /// هـ.٣ (١): إصدار أقدم صناعياً يكتشف الأحدث من حمولة حقيقية، مع رابط
    /// التنزيل الصحيح المأخوذ من الحمولة نفسها.
    #[test]
    fn a_forged_older_version_detects_the_published_release() {
        let st = status_from_payload("0.2.3", REAL_LATEST_PAYLOAD).expect("the real payload must parse");
        assert!(st.error.is_none(), "a good payload has no error: {:?}", st.error);
        assert_eq!(st.latest.as_deref(), Some("0.2.4"), "latest comes from tag_name");
        assert!(st.update_available, "0.2.3 must see v0.2.4");
        assert_eq!(
            st.download_url, "https://github.com/SMSMy/HaramLite/releases/tag/v0.2.4",
            "the download page is the release's own html_url"
        );
        assert!(!st.from_cache, "a direct parse is not a cached answer");
    }

    /// هـ.٣ (٢): النسخة الحالية نفسها ⇒ «أنت على الأحدث».
    #[test]
    fn the_current_version_reports_up_to_date() {
        let st = status_from_payload("0.2.4", REAL_LATEST_PAYLOAD).expect("the real payload must parse");
        assert!(st.error.is_none());
        assert!(!st.update_available, "0.2.4 against a latest of 0.2.4 is up to date");
        assert_eq!(st.latest.as_deref(), Some("0.2.4"));
    }

    /// مسار «JSON مشوّه» و«استجابة غير متوقعة»: رسالة عربية لا panic ولا فراغ.
    #[test]
    fn a_broken_payload_is_a_message_not_a_panic() {
        let bad_json = status_from_payload("0.2.4", "{ this is not json").expect_err("malformed JSON must fail");
        assert!(has_arabic(&bad_json), "the message must be Arabic: {bad_json}");
        assert!(bad_json.contains("JSON"), "and must name the cause: {bad_json}");

        // جسم خطأ GitHub (‏404 بلا إصدار منشور) وصل بحالة 200 من وسيط ما.
        let not_found = status_from_payload("0.2.4", r#"{"message":"Not Found","status":"404"}"#)
            .expect_err("a message-only body is not a release");
        assert!(not_found.contains("لا توجد إصدارات منشورة"), "the no-releases path: {not_found}");

        // JSON صالح بلا حقل إصدار ⇒ «استجابة غير متوقعة».
        let no_tag = status_from_payload("0.2.4", r#"{"name":"HaramLite"}"#).expect_err("no tag_name must fail");
        assert!(no_tag.contains("غير متوقع"), "unexpected-shape path: {no_tag}");

        // مصفوفة أو نصّ بدل كائن — نفس المصير بلا panic.
        assert!(status_from_payload("0.2.4", "[]").is_err());
        assert!(status_from_payload("0.2.4", "null").is_err());
    }

    /// رسائل رموز الحالة (ومنها حدّ المعدّل في هـ.٤) — بلا شبكة.
    #[test]
    fn http_status_codes_map_to_comprehensible_arabic() {
        let rate = http_status_message(403);
        assert!(rate.contains("حدّ الطلبات"), "403 is the rate-limit reply: {rate}");
        assert_eq!(rate, http_status_message(429), "429 is the same condition");
        assert!(http_status_message(404).contains("لا توجد إصدارات منشورة"));
        assert!(http_status_message(500).contains("500"), "unknown codes keep their number");
        for code in [403u16, 404, 429, 500, 503] {
            assert!(has_arabic(&http_status_message(code)), "code {code} must answer in Arabic");
        }
    }

    /// هـ.٣ (٣): فشل الشبكة ⇒ خطأ مفهوم بلا panic — على مقبس حقيقي، وبلا DNS
    /// وبلا إنترنت: (أ) منفذ مُغلق مضمون ⇒ رفض فوري، (ب) منفذ يبلع الاتصال بلا
    /// ردّ ⇒ **مهلة القراءة هي المضبوطة (ثانيتان)** — ولا مضيف خارجي غير موجود
    /// هنا لأنه يترك القرار لمُحلِّل الأسماء فيبطئ الاختبار بلا زيادة تغطية.
    #[test]
    fn an_unreachable_github_is_an_arabic_message_not_a_panic() {
        // (أ) منفذ مُغلق مضمون: نربط مستمعاً فنأخذ رقمه ثم نُسقطه ⇒ رفض فوري.
        let closed = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a free port");
            let addr = listener.local_addr().expect("local addr");
            drop(listener);
            format!("http://{addr}/releases/latest")
        };
        let refused = fetch_body(&closed, Duration::from_secs(2)).expect_err("a closed port must fail");
        assert!(!refused.trim().is_empty(), "no empty error");
        assert!(refused.contains("GitHub"), "the message names the source: {refused}");
        assert!(has_arabic(&refused), "the message is Arabic: {refused}");

        // (ب) «بلا شبكة» فعلياً: مستمع حيّ لا يقبل ولا يردّ ⇒ المهلة تضرب.
        let silent = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a silent port");
        let silent_url = format!("http://{}/releases/latest", silent.local_addr().expect("addr"));
        let started = std::time::Instant::now();
        let timed_out = fetch_body(&silent_url, Duration::from_secs(2)).expect_err("a silent server must fail");
        assert!(has_arabic(&timed_out), "the offline message is Arabic: {timed_out}");
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "the request timeout must bound the wait, not the OS retry clock (took {:?})",
            started.elapsed()
        );

        // والمسار الكامل يعيد **بنية** برسالة، لا فراغاً ولا panic.
        let root = tmpdir("net");
        let st = check_with(&root, "0.2.4", true, 0, &|| Err(refused.clone()));
        assert!(st.error.is_some(), "the failure reaches the UI as a field");
        assert!(!st.update_available, "a failed check never claims an update");
        assert_eq!(st.current, "0.2.4", "the current version is still reported");
        assert!(!st.download_url.is_empty(), "the download link is never empty");
        assert!(!root.join(CACHE_FILE).exists(), "a failed fetch must not write a cache");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// هـ.٤: الكاش يمنع النداء، والزرّ (force) ينادي دائماً.
    #[test]
    fn the_24h_cache_answers_without_a_network_call() {
        let root = tmpdir("cache");
        let now = 1_800_000_000u64;
        let calls = std::cell::Cell::new(0u32);
        let fetch = || {
            calls.set(calls.get() + 1);
            Ok(REAL_LATEST_PAYLOAD.to_string())
        };

        // نداء أول: يبني الكاش (‏0.2.4 أمام 0.2.4 ⇒ لا تحديث، والحمولة الحقيقية).
        let first = check_with(&root, "0.2.4", false, now, &fetch);
        assert!(!first.update_available, "0.2.4 against a latest of 0.2.4 is up to date");
        assert!(!first.from_cache, "the first answer comes from the call, not the cache");
        assert_eq!(calls.get(), 1, "the first check must call GitHub");
        assert!(root.join(CACHE_FILE).exists(), "a successful check writes the cache next to the app data");

        // ٢٣ ساعة لاحقاً: من الكاش، وصفر نداءات — حدّ المعدّل محفوظ.
        let cached = check_with(&root, "0.2.4", false, now + 23 * 3600, &fetch);
        assert_eq!(calls.get(), 1, "within 24h the silent check must NOT call GitHub again");
        assert!(cached.from_cache, "and it says so");
        assert!(!cached.update_available, "the cached tag is still compared with the current version");

        // الزرّ ينادي دائماً ولو كان الكاش طازجاً.
        let forced = check_with(&root, "0.2.4", true, now + 23 * 3600, &fetch);
        assert_eq!(calls.get(), 2, "the button always performs a real call");
        assert!(!forced.from_cache);

        // ٢٤ ساعة بعد آخر نداء ناجح (والزرّ جدّد الكاش): الكاش منتهٍ ⇒ نداء ثالث.
        let stale_at = now + 23 * 3600 + CACHE_TTL_SECS + 1;
        let _ = check_with(&root, "0.2.4", false, stale_at, &fetch);
        assert_eq!(calls.get(), 3, "a stale cache must be refreshed");

        // وكاش قديم يقول «يوجد تحديث» يُقارن بالإصدار الحالي وقت القراءة.
        let stale_root = tmpdir("stale");
        write_cache(
            &stale_root,
            &Cache { checked_at: now, latest: "0.2.5".into(), download_url: format!("{TAG_PAGE_BASE}/v0.2.5") },
        );
        let on_old = check_with(&stale_root, "0.2.4", false, now + 60, &|| Err("no network".into()));
        assert!(on_old.from_cache && on_old.update_available, "0.2.4 sees the cached 0.2.5");
        assert_eq!(calls.get(), 3, "a fresh cache means the failing fetcher is never used");
        let updated = check_with(&stale_root, "0.2.5", false, now + 60, &|| Err("no network".into()));
        assert!(!updated.update_available, "the same cached tag is not an update for 0.2.5");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&stale_root);
    }
}
