//! التشغيل مع بدء تشغيل ويندوز.
//!
//! الغرض ليس فتح النافذة عند الإقلاع، بل إبقاء ما يعمل في الخلفية جاهزاً:
//! بوت تيليجرام وتكامل المتصفح. لذلك يُكتب في سطر الأمر `--hidden-start`
//! (وهو مسار موجود في `main.rs`) فتقلع النسخة بلا نافذة، ويمكن للمستخدم
//! فتحها متى شاء من أيقونة الشريط.
//!
//! المصدر الوحيد للحقيقة هو الريجستري نفسه: لا يوجد حقل مقابل في
//! `settings.json` كي لا ينشأ تعارض بين ما يقوله الملف وما يفعله ويندوز.

use std::path::Path;

/// مفتاح Run الخاص بالمستخدم الحالي — لا يطلب صلاحيات مسؤول.
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// اسم القيمة كما يظهر في «بدء التشغيل» في مدير المهام.
const VALUE_NAME: &str = "HaramLite";

/// سطر الأمر المكتوب في الريجستري: المسار بين علامتي اقتباس (فقد يحوي مسافات)
/// ثم علَم التشغيل المخفي. دالّة نقية لتُختبر بلا لمس الريجستري.
fn command_line(exe: &Path) -> String {
    format!("\"{}\" --hidden-start", exe.display())
}

/// Does the stored line still point at this executable? Upgrading or moving the
/// install must not leave a stale path behind that fails silently at boot.
/// A PREFIX match is not enough: the build renames the exe to `.old`, so
/// `…\HaramLite.exe.old" --hidden-start` must NOT count as enabled. After
/// stripping quotes, the stored line must equal the exe path (case-insensitive)
/// or continue with `"`, whitespace, or end-of-string. Pure, unit-tested.
fn points_at(existing: &str, exe: &Path) -> bool {
    let line = existing.trim().trim_matches('"');
    let exe_s = exe.display().to_string();
    // Byte-prefix compare ignoring ASCII case (safe to slice at len on match:
    // ASCII case-folding never changes byte length, so the boundary holds).
    let Some(prefix) = line.get(..exe_s.len()) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case(&exe_s) {
        return false;
    }
    matches!(
        line[exe_s.len()..].chars().next(),
        None | Some('"') | Some(' ') | Some('\t')
    )
}

#[cfg(target_os = "windows")]
mod win {
    use super::{command_line, points_at, RUN_KEY};
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    pub fn read_raw(name: &str) -> Option<String> {
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_READ).ok()?;
        key.get_value::<String, _>(name).ok()
    }

    pub fn is_enabled_for(name: &str) -> bool {
        match (read_raw(name), std::env::current_exe()) {
            (Some(v), Ok(exe)) => points_at(&v, &exe),
            (Some(_), Err(_)) => true, // مسارنا غير معروف: نُبلّغ بما في الريجستري
            (None, _) => false,
        }
    }

    pub fn set_enabled_for(name: &str, on: bool) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey(RUN_KEY)
            .map_err(|e| format!("تعذر فتح مفتاح بدء التشغيل: {e}"))?;
        if on {
            let exe = std::env::current_exe()
                .map_err(|e| format!("تعذر تحديد مسار البرنامج: {e}"))?;
            key.set_value(name, &command_line(&exe))
                .map_err(|e| format!("تعذر كتابة قيمة بدء التشغيل: {e}"))
        } else {
            // الحذف قد يفشل لغياب القيمة أصلاً — وهذا نجاح لا خطأ.
            match key.delete_value(name) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("تعذر حذف قيمة بدء التشغيل: {e}")),
            }
        }
    }
}

/// هل التشغيل مع النظام مفعّل ويشير إلى هذا التنفيذي؟
pub fn is_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        win::is_enabled_for(VALUE_NAME)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// تفعيل/إلغاء التشغيل مع النظام. يُعيد خطأً مقروءاً بدل الفشل الصامت.
pub fn set_enabled(on: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        win::set_enabled_for(VALUE_NAME, on)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = on;
        Err("التشغيل مع النظام مدعوم على ويندوز فقط".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_quotes_path_and_hides_window() {
        let cmd = command_line(Path::new(r"C:\Program Files\HaramLite\HaramLite.exe"));
        assert_eq!(cmd, r#""C:\Program Files\HaramLite\HaramLite.exe" --hidden-start"#);
        // الغرض من العلَم: النافذة لا تُفتح عند الإقلاع
        assert!(cmd.ends_with("--hidden-start"));
    }

    #[test]
    fn stale_paths_are_not_treated_as_enabled() {
        let exe = Path::new(r"C:\Apps\HaramLite\HaramLite.exe");
        assert!(points_at(r#""C:\Apps\HaramLite\HaramLite.exe" --hidden-start"#, exe));
        assert!(points_at(r"C:\Apps\HaramLite\HaramLite.exe", exe));
        assert!(!points_at(r#""C:\Old\HaramLite.exe" --hidden-start"#, exe));
        assert!(!points_at("", exe));
    }

    /// The build renames the exe to `.old`: a prefix match would report a
    /// stale renamed binary as still enabled. Only a full-path match (or one
    /// followed by `"`, whitespace, or end-of-string) counts.
    #[test]
    fn renamed_exe_old_is_not_treated_as_enabled() {
        let exe = Path::new(r"C:\Apps\HaramLite\HaramLite.exe");
        assert!(!points_at(
            r#""C:\Apps\HaramLite\HaramLite.exe.old" --hidden-start"#,
            exe
        ));
        assert!(points_at(
            r#""C:\Apps\HaramLite\HaramLite.exe" --hidden-start"#,
            exe
        ));
        assert!(points_at(r#""C:\Apps\HaramLite\HaramLite.exe""#, exe));
        assert!(!points_at(
            r#""C:\Other\HaramLite.exe" --hidden-start"#,
            exe
        ));
        assert!(points_at(
            r#""c:\apps\haramlite\haramlite.exe" --hidden-start"#,
            exe
        ));
    }

    /// يعمل على الريجستري الحقيقي لكن باسم قيمة اختبارية ثم ينظّف نفسه —
    /// كي لا يُثبت الاختبار قيمةً في «بدء التشغيل» عند المستخدم.
    #[cfg(target_os = "windows")]
    #[test]
    fn write_read_delete_roundtrip() {
        let name = "HaramLite__test_only";
        let _ = win::set_enabled_for(name, false);
        assert!(win::read_raw(name).is_none());
        win::set_enabled_for(name, true).expect("write must succeed for the current user");
        let written = win::read_raw(name).expect("value must exist after write");
        assert!(written.contains("--hidden-start"));
        // والحذف مرتين ناجح (الغياب ليس خطأ)
        win::set_enabled_for(name, false).expect("first delete");
        win::set_enabled_for(name, false).expect("second delete is a no-op");
        assert!(win::read_raw(name).is_none());
    }
}
