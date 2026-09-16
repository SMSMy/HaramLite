//! الكتابة الذرّية الموحّدة (و-٦): tmp → `sync_all` → rename.
//!
//! كان النمط `fs::write(tmp)` ثم `rename` مكرَّراً في ثلاثة مواضع
//! (`settings.rs` · `bridge.rs` · `yt_dlp.rs`) وبلا `sync_all` في الكود كله.
//! الـ`rename` وحده يحمي من **ملف مقطوع**، لا من **فقد آخر كتابة**: الكتابة
//! تعود من مخزن النظام وقد تبقى في ذاكرة القرص حين ينقطع التيار في اللحظة
//! الحرجة. `sync_all()` قبل الـ`rename` يجعل المحتوى على الوسيط فعلاً، ويجعل
//! الاسم الجديد لا يظهر إلا بعد استقرار بايتاته.
//!
//! الدالة الواحدة تعني قراراً واحداً في مكان واحد: ما اسم المؤقت، وماذا
//! يعني «تمّ». وهي متزامنة عن قصد — تُستدعى من مسارات كتابة صغيرة (إعدادات،
//! حالة جسر، حالة تحديث) لا من مسار معالجة الوسائط.

use std::path::{Path, PathBuf};

/// الاسم المؤقت المستعمل: `<dest>.<tag>.tmp` بجانب الهدف (المجلد نفسه ⇒
/// الـ`rename` على نفس الوحدة، وهو شرط الذرّية في ويندوز).
///
/// لا يُشتق من امتداد الهدف: `settings.rs` كان يستعمل `.json.tmp` و
/// `yt_dlp.rs` مثله، فالمؤقت يتغيّر شكله لو تغيّر الامتداد. الوسم الصريح
/// يجعل الاسم متوقَّعاً من الخارج (والاختبارات تتحقق من زواله).
pub fn tmp_sibling(dest: &Path, tag: &str) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    dest.with_file_name(format!("{name}.{tag}.tmp"))
}

/// اكتب `bytes` إلى `dest` ذرّياً: مؤقت بجانبه ← `sync_all` ← `rename`.
///
/// المجلد الأب يُنشأ إن لزم (سلوك المواضع الثلاثة القديمة). أي فشل في أي
/// خطوة يترك `dest` **كما كان** ويزيل المؤقت إن أمكن — لا يُرقّى ملف لم
/// تُؤكَّد بايتاته.
pub fn write_atomic(dest: &Path, bytes: &[u8], tag: &str) -> std::io::Result<()> {
    use std::io::Write;

    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let tmp = tmp_sibling(dest, tag);
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        // Durability, not just atomicity: without this the rename can land
        // before the data does and a power cut loses the LAST write — the one
        // the user just made.
        f.sync_all()
    })();
    if let Err(e) = written {
        // Same drop-guard rule as repair.rs: a failed write must not leave a
        // partial temp file for the next run to inherit.
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    std::fs::rename(&tmp, dest).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// نسخة نصّية — كل مواضع الاستبدال الثلاثة تكتب JSON نصّاً.
pub fn write_atomic_str(dest: &Path, body: &str, tag: &str) -> std::io::Result<()> {
    write_atomic(dest, body.as_bytes(), tag)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hl_atomic_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// و-٦ الأساس: ما كُتب ذرّياً يُقرأ كاملاً — عبر مسار الدالة نفسها.
    #[test]
    fn an_atomic_write_reads_back_byte_for_byte() {
        let root = tmp("roundtrip");
        let dest = root.join("settings.json");
        write_atomic_str(&dest, "{\"lang\":\"ar\"}", "json").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "{\"lang\":\"ar\"}");
        // الكتابة الثانية تستبدل الأولى بلا بقايا من الأولى.
        write_atomic_str(&dest, "{\"lang\":\"en\"}", "json").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "{\"lang\":\"en\"}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// و-٦ سلبي: لا يبقى المؤقت بعد النجاح — وإلا لتراكم ملف بأثر كل حفظ.
    #[test]
    fn no_temporary_file_survives_a_successful_write() {
        let root = tmp("no_tmp");
        let dest = root.join("state.json");
        let temp = tmp_sibling(&dest, "json");
        write_atomic_str(&dest, "{}", "json").unwrap();
        assert!(!temp.exists(), "المؤقت لم يُنقل: {}", temp.display());
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            1,
            "المجلد يجب أن يحوي الملف النهائي وحده"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// و-٦ سلبي: فشل الكتابة لا يمسّ الملف القائم ولا يترك مؤقتاً.
    /// الهدف مجلدٌ قائم ⇒ التعارض، وهو أسهل شكل للفشل بلا صدفة توقيت.
    #[test]
    fn a_failed_write_keeps_the_old_file_and_leaves_no_temp() {
        let root = tmp("fail");
        let dest = root.join("settings.json");
        write_atomic_str(&dest, "old", "json").unwrap();
        let as_dir = root.join("occupied");
        std::fs::create_dir_all(&as_dir).unwrap();
        assert!(write_atomic_str(&as_dir, "new", "json").is_err(), "يجب أن يفشل");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old", "الملف القديم سليم");
        assert!(!tmp_sibling(&as_dir, "json").exists(), "لا مؤقت بعد الفشل");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// المجلد الأب يُنشأ كما كان المواضع الثلاثة تفعل (تثبيت جديد).
    #[test]
    fn the_parent_directory_is_created() {
        let root = tmp("parent");
        let dest = root.join("nested").join("deep").join("settings.json");
        write_atomic_str(&dest, "x", "json").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "x");
        let _ = std::fs::remove_dir_all(&root);
    }
}
