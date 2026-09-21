//! م٥ — ملف إحصاءات لكل مستخدم: `<data_dir>/telegram/stats/<id>.json`.
//!
//! **الشكل الملزم** (‏`m5-brief.md` §٢): `{"id":…,"name":"…","files":…,"bytes":…}`
//! — **أرقام فقط**: لا تواريخ ولا أسماء ملفات ولا مسارات. وهذا ليس تنسيقاً
//! تجميلياً بل شرطُ بقاءٍ: الملف يُحدَّث مع كل معالجة، فكلُّ حقلٍ يتراكم (سطرٌ
//! لكل معالجة، أو قائمةُ أسماءٍ تكبر) يجعل حجمه ينمو بلا سقف. الحجم هنا
//! **ثابت الشكل**: أربعة حقول، أرقامها تطول بخانةٍ عند كل قفزة عشرية فقط.
//!
//! **والمفتاح هو الـID لا الاسم**: اسم المستخدم في تلغرام يتغيّر، ولو كان
//! المفتاح الاسم لصار للمستخدم الواحد سجلّان (أو أكثر) وضاع نصف إحصائه. فالاسم
//! **حقل داخل السجلّ** يُحدَّث، والمعرّف هو اسم الملف.
//!
//! **والتحديث في مكانه** بكتابة ذرّية عبر [`crate::atomic::write_atomic_str`]
//! (مؤقت ← `sync_all` ← `rename`): لا يُقرأ ملفٌ نصفه مكتوب، ولا يبقى مؤقت
//! يتيم.
//!
//! **والقفل ذو طبقتين، والثانية ليست ترفاً** (جولة التفنيد، عطل ٢): قفلٌ داخل
//! العملية (`Mutex`) يُسلسل خيوط التطبيق، لكنه **لا يرى عملية أخرى** — ومسار
//! CLI عمليةٌ ثانية تعمل فعلاً (المُقيِّمات و`release:verify` تشغّله، والمالك قد
//! يشغّله والتطبيق مفتوح). قِيس الفقد: ٤ عمليات × ٥٠ تسليماً ⇒ سُجّل ٥٢ من ٢٠٠.
//! فالقفل الحاكم صار **فتحاً حصرياً لملف قفل** (`share_mode(0)`): مقبضٌ يمنع
//! غيره من فتح المسار، **وتُطلقه النواة بموت صاحبه** — فلا قفل يتيم بعد انهيار،
//! ولا انتظار أبدي (مهلة [`LOCK_WAIT`] ثم خطأ مُعلَن).
//!
//! **وحدّه المعلَن**: على غير ويندوز لا يُنفَّذ الحصر (`std` لا يعطي `share_mode`
//! هناك) — فالقفل يعود داخل العملية وحدها، والضياع بين العمليات يبقى قائماً على
//! تلك المنصّة. والمنتج على ويندوز (`slots.rs` و`pipeline.rs` يصرّحان بالمثل).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};

/// المجلد تحت مجلد بيانات التطبيق (`paths::data_dir`).
pub const STATS_DIR: &str = "stats";
/// **قفل عبور العمليات**: ملفٌ بجانب مجلد الإحصاءات لا داخله، فلا يظهر في
/// تعداد سجلات المستخدمين (ت٧ يفحص التعداد).
const LOCK_FILE: &str = "stats.lock";
/// كم يُنتظر القفل قبل أن يُعلَن الفشل — وحدٌّ صريح لا انتظار أبدي.
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// الفاصل بين محاولات أخذ القفل.
const LOCK_POLL: std::time::Duration = std::time::Duration::from_millis(2);
/// وسم المؤقت — الشكل نفسه الذي تستعمله بقية كتابات التطبيق.
const TAG: &str = "json";
/// أقصى طول لاسمٍ محفوظ. **سقفنا نحن** لا سقف تلغرام: الغرض أن يبقى الملف
/// صغيراً مهما كان الاسم القادم من الشبكة (والاسم يُعرض في `/stats` وحده).
const NAME_CAP: usize = 48;

/// سجلّ مستخدم واحد — أربعة حقول، ولا خامس.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserStats {
    pub id: i64,
    pub name: String,
    pub files: u64,
    pub bytes: u64,
}

/// قفل **خيوط هذه العملية** — الطبقة الأولى: بلا نداء نظام في الحالة العادية
/// (خيطان في التطبيق نفسه يكتبان لمستخدمٍ واحد).
fn lock() -> MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// مسار ملف القفل: `<data_dir>/telegram/stats.lock` — **جارُ المجلد لا داخله**.
fn lock_path(app_data: &Path) -> PathBuf {
    app_data.join("telegram").join(LOCK_FILE)
}

/// فتح ملف القفل **حصرياً** (ويندوز): `share_mode(0)` يمنع أي فتحٍ آخر للمسار
/// ما دام المقبض مفتوحاً — وهي الحصرية الوحيدة التي **تُطلقها النواة بموت
/// صاحبها**، فلا قفل يتيم.
#[cfg(windows)]
fn open_lock_exclusive(lock: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        // **بلا اقتطاع**: القفل مقبضٌ لا محتوى، واقتطاعُ ملفٍ يملكه غيرنا ممنوع
        // (و`clippy` يطلب تعريف السلوك صراحةً).
        .truncate(false)
        .share_mode(0)
        .open(lock)
}

/// خارج ويندوز: لا حصر بين العمليات (`std` لا يعطي `share_mode`) — الحدّ معلَن
/// في رأس الملف، والقفل يبقى داخل العملية.
#[cfg(not(windows))]
fn open_lock_exclusive(lock: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock)
}

/// يأخذ القفل العابر للعمليات، أو يُعلن الفشل بعد [`LOCK_WAIT`].
///
/// و**الفشل يُعلَن** (`Err`) ولا يُتابَع بلا قفل: كتابةٌ بلا قفل تُسقط زيادات
/// غيرها بصمت — وهو العطل المقيس نفسه بعينه.
fn acquire_file_lock(app_data: &Path) -> Result<std::fs::File, String> {
    let path = lock_path(app_data);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("تعذّر إنشاء {}: {e}", parent.display()))?;
    }
    let deadline = std::time::Instant::now() + LOCK_WAIT;
    loop {
        match open_lock_exclusive(&path) {
            Ok(f) => return Ok(f),
            Err(e) => {
                // `ERROR_SHARING_VIOLATION` (32) ⇒ غيره يمسكه الآن: انتظار.
                let held = e.raw_os_error() == Some(32);
                if !held || std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "تعذّر أخذ قفل الإحصاءات {} بعد {:?}: {e}",
                        path.display(),
                        LOCK_WAIT
                    ));
                }
                std::thread::sleep(LOCK_POLL);
            }
        }
    }
}

/// مجلد الإحصاءات: `<data_dir>/telegram/stats`.
pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join("telegram").join(STATS_DIR)
}

/// مسار سجلّ مستخدم: **المفتاح هو المعرّف** — تغيّر الاسم لا يغيّر المسار.
pub fn path_for(app_data: &Path, id: i64) -> PathBuf {
    dir(app_data).join(format!("{id}.json"))
}

/// السجلّ المخزَّن، أو `None` إن لم يُعالَج له شيء بعد (لا سجلّ صفري يُنشأ
/// من الفراغ: `/stats` تقول «لا سجلّ» بصدق بدل أن تخترع أصفاراً).
pub fn load(app_data: &Path, id: i64) -> Option<UserStats> {
    let body = std::fs::read_to_string(path_for(app_data, id)).ok()?;
    // ملف تالف ⇒ «لا سجلّ» لا انهيار، ولا سجلّ مُختلق من نصف JSON.
    serde_json::from_str::<UserStats>(&body).ok()
}

/// **الكاتب الوحيد لهذا الملف**: يُدوِّن **تسليماً ناجحاً** — ملفٌّ واحد بحجمه،
/// والاسم الحالي لصاحبه.
///
/// ولماذا كاتبٌ واحد: كل زيادةٍ أخرى (عدّادُ محاولة، سطرُ محاولة فاشلة، تاريخُ
/// آخر نشاط) تجعل الملف ينمو بلا سقف مع الزمن — وهو ما يمنعه ت٦. فما يُدوَّن
/// هنا هو ما **وصل المستخدم** لا ما جرى في الطريق.
///
/// واسمٌ فارغ لا يمحو اسماً معروفاً: الغياب ليس تصفيراً.
pub fn note_delivery(
    app_data: &Path,
    id: i64,
    name: &str,
    bytes: u64,
) -> Result<UserStats, String> {
    let _thread = lock();
    // **والقفل العابر للعمليات يُؤخذ قبل القراءة لا بعدها** (جولة التفنيد،
    // عطل ٢): القراءة-ثم-الزيادة-ثم-الكتابة بلا حصرٍ بين العمليات تُسقط زيادة
    // العملية الأخرى — قِيس ٥٢ من ٢٠٠ بين أربع عمليات.
    let _file = acquire_file_lock(app_data)?;
    let mut rec = load(app_data, id).unwrap_or_default();
    rec.id = id;
    let clean = clean_name(name);
    if !clean.is_empty() {
        rec.name = clean;
    }
    rec.files = rec.files.saturating_add(1);
    rec.bytes = rec.bytes.saturating_add(bytes);
    store(app_data, &rec)?;
    Ok(rec)
}

/// كتابة السجلّ كاملاً في مكانه — كائن JSON واحد، لا سطر يُضاف إلى ما قبله.
fn store(app_data: &Path, rec: &UserStats) -> Result<(), String> {
    let body = serde_json::to_string(rec).map_err(|e| e.to_string())?;
    crate::atomic::write_atomic_str(&path_for(app_data, rec.id), &body, TAG)
        .map_err(|e| format!("تعذّر حفظ إحصاءات {}: {e}", rec.id))
}

/// تنظيف الاسم القادم من الشبكة: بلا أسطر (وإلا صار الملف سطرين) وبلا طول مفرط.
fn clean_name(name: &str) -> String {
    let flat: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    flat.trim().chars().take(NAME_CAP).collect()
}

/// حجم مقروء: البايت والكيلو والميغا والجيجا — لا `MB` وحدها، فصفرُ ملفٍ
/// ليس «‎0.0MB» في عين القارئ.
pub fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        return format!("{bytes} بايت");
    }
    if b < KB * KB {
        return format!("{:.1} ك.ب", b / KB);
    }
    if b < KB * KB * KB {
        return format!("{:.1} م.ب", b / (KB * KB));
    }
    format!("{:.2} ج.ب", b / (KB * KB * KB))
}

/// نصّ `/stats` — **من الملف وحده**: الاسم والـID والعدد والحجم كلها من السجلّ،
/// ولا يُحصى هنا شيء آخر (لا مهامّ جارية ولا طابور ولا معلَّقات).
///
/// **وبلا سجلّ لا تُعرَض أصفار** (جولة التفنيد، عطل ١): «الملفات: 0 · 0 بايت»
/// في موضع قياسٍ تُقرأ **قياساً** — وهي ليست قياساً بل غياب سجلّ. ونصف الواجهة
/// يرفضها صراحةً (`known:false` ⇒ لا أرقام). فالفرق بين الحالتين في النصّ:
///
/// * **لا سجلّ** ⇒ معرّفٌ يُعرَف من الرسالة، ولا رقمَ قياسٍ واحد؛
/// * **سجلّ حقيقي** ⇒ أرقامه ولو كانت صفراً: ملفٌّ بحجم صفر يعطي «الملفات: 1»
///   و«0 بايت» — وذاك **قياس** لا اختراع.
pub fn text_for(id: i64, rec: Option<&UserStats>) -> String {
    match rec {
        Some(r) => format!(
            "📊 إحصاءاتك\n👤 الاسم: {}\n🆔 المعرّف: {}\n📎 الملفات: {}\n💾 الحجم: {}",
            if r.name.is_empty() {
                "(بلا اسم محفوظ)"
            } else {
                r.name.as_str()
            },
            r.id,
            r.files,
            human_size(r.bytes)
        ),
        None => format!(
            "📊 لا سجلّ إحصاءات بعد لهذا المستخدم.\n\
             🆔 المعرّف: {id}\n\
             (لا ملفات مسلَّمة بعد — فلا أرقام لأعرضها)"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hl_tgstats_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn entries(root: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir(root))
            .map(|it| {
                it.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    }

    /// **ت٦ — الأرقام تزيد والحجم لا يكبر.**
    ///
    /// ٦٤ تسليماً لمستخدم واحد: الملف يُقرأ بعد كل تسليم ويُقاس طوله بالبايت.
    /// والدعوى مزدوجة: (أ) العدّاد والحجم يزيدان فعلاً — وإلا فالاختبار يقيس
    /// لا شيئاً، (ب) والملف **يبقى كائناً واحداً** شكله ثابت، فلا ينمو بطول
    /// الزمن. ومَن كتب سطراً لكل معالجة (المُفسَد) يُسقط (ب) من وجهين: الطول
    /// ينمو خطياً، والنصّ يتوقف عن كونه كائن JSON واحداً.
    #[test]
    fn t6_the_numbers_grow_and_the_file_never_does() {
        let root = tmp("t6");
        let mut lens = Vec::new();
        for i in 0..64u64 {
            let rec = note_delivery(&root, 7, "Ali", 1000).unwrap();
            assert_eq!(rec.files, i + 1, "العدّاد لم يتبع عدد التسليمات");
            assert_eq!(rec.bytes, (i + 1) * 1000, "الحجم التراكمي خطأ");
            let body = std::fs::read_to_string(path_for(&root, 7)).unwrap();
            // ② كائن JSON **واحد**: نصٌّ فيه سطر لكل معالجة لا يُقرأ كائناً.
            let parsed: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("الملف ليس كائن JSON واحداً بعد {i} تسليماً: {e}"));
            assert!(parsed.is_object(), "الشكل تغيّر: {body}");
            // والأقوى: الملف **هو** السجلّ، حرفاً بحرف — لا سطر مضاف إليه.
            assert_eq!(
                body,
                serde_json::to_string(&rec).unwrap(),
                "الملف ليس السجلّ نفسه (تراكم فيه شيء)"
            );
            lens.push(body.len());
        }
        let last = load(&root, 7).unwrap();
        assert_eq!((last.files, last.bytes), (64, 64_000), "الأرقام لم تصل");
        // ① الأطوال كلها في نافذة خانةٍ عشرية واحدة، وسقفٌ مطلق صغير: لا نموّ
        //    مع الزمن (النموّ الخطي لسطرٍ لكل معالجة يعطي ≥ ٦٤×٢٠ بايت).
        let min = *lens.iter().min().unwrap();
        let max = *lens.iter().max().unwrap();
        assert!(
            max - min <= 8,
            "حجم الملف يتبدّل مع عدد المعالجات: {min}..{max}"
        );
        assert!(max <= 128, "حجم السجلّ تجاوز سقفاً صغيراً: {max} بايت");
        // والأرقام المقيسة تُطبَع لتُعاد مراجعتها بلا وسيط (نمط م٤ نفسه).
        eprintln!(
            "م٥/إحصاءات: ٦٤ تسليماً ⇒ files={} bytes={} · أطوال الملف {}..{} بايت",
            last.files, last.bytes, min, max
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **ت٦ (تكملة) — لا تاريخ ولا اسم ملف.** السجلّ أربعة مفاتيح بالضبط، ولا
    /// موضع خامس: مَن أراد إضافة تاريخٍ أو اسمِ ملفٍّ وجد مفتاحاً زائداً يسقط
    /// هنا. والنصّ نفسه لا يحمل ما يشبه تاريخاً ولا مساراً ولا امتداد وسائط.
    #[test]
    fn t6b_no_dates_no_file_names_just_four_keys() {
        let root = tmp("t6b");
        note_delivery(&root, 7, "Ali", 5_000_000).unwrap();
        let body = std::fs::read_to_string(path_for(&root, 7)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        // `Value` يرتّب المفاتيح (‏BTreeMap) فالفحص على **المجموعة** لا الترتيب؛
        // وترتيب الملف الخام نفسه محروس في ت٦ بمطابقته نصَّ السجلّ.
        let mut keys: Vec<String> = v
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.to_string())
            .collect();
        keys.sort();
        assert_eq!(keys, ["bytes", "files", "id", "name"], "حقل زائد: {body}");
        // ولا أثر لتاريخ أو مسار أو امتداد وسائط (و`-` لا وجود لها في قيم هذا
        // السجلّ: لا معرّف سالب هنا ولا فاصل تاريخ).
        for forbidden in ["2026", "T00:", "-", "\\", "/", ".mp4", ".mp3", "song"] {
            assert!(
                !body.contains(forbidden),
                "ظهر «{forbidden}» في سجلّ يجب أن يكون أرقاماً فقط: {body}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **ت٧ — المفتاح هو الـID لا الاسم**: تغيير الاسم يُحدِّث السجلّ نفسه
    /// ولا يُنشئ سجلاً ثانياً، والتسليمات تجتمع كلها في سجلٍّ واحد.
    #[test]
    fn t7_the_key_is_the_id_and_a_renamed_user_keeps_one_record() {
        let root = tmp("t7");
        let first = note_delivery(&root, 7, "Ali", 100).unwrap();
        assert_eq!(first.name, "Ali");
        assert_eq!(entries(&root), ["7.json"], "اسم ملف السجلّ ليس المعرّف");

        let rec = note_delivery(&root, 7, "اسمٌ جديد تماماً", 100).unwrap();
        assert_eq!(rec.name, "اسمٌ جديد تماماً", "الاسم لم يُحدَّث");
        assert_eq!(rec.files, 2, "تسليم الاسم الجديد لم يُضَف إلى السجلّ نفسه");
        assert_eq!(
            entries(&root),
            ["7.json"],
            "تغيير الاسم أنشأ ملفاً ثانياً — المفتاح صار الاسم"
        );

        // ومستخدمان مختلفان ⇒ سجلان (المفتاح ليس ثابتاً للجميع).
        note_delivery(&root, 8, "Ali", 5).unwrap();
        assert_eq!(entries(&root), ["7.json", "8.json"]);
        assert_eq!(load(&root, 8).unwrap().files, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// بلا سجلّ: `/stats` تقول «لا سجلّ» **ولا تعرض أرقام قياس** — والصفر
    /// الحقيقي (ملفٌّ بحجم صفر) يبقى معروضاً لأنه قياس.
    ///
    /// **جولة التفنيد، عطل ١**: كان النصّ بلا سجلّ يقول «الملفات: 0 · 0 بايت»
    /// في موضع قياسٍ — وهي أصفار مُختلقة يرفضها نصف الواجهة (`known:false`).
    /// والمُفسَد: إعادة الأصفار إلى نصّ «لا سجلّ» ⇒ يسقط هذا الاختبار.
    #[test]
    fn a_missing_record_is_reported_as_missing_and_creates_no_file() {
        let root = tmp("missing");
        assert_eq!(load(&root, 7), None);
        assert!(!dir(&root).exists(), "القراءة لا تُنشئ مجلداً");
        let text = text_for(7, None);
        assert!(text.contains("لا سجلّ"), "{text}");
        assert!(text.contains("المعرّف: 7"), "{text}");
        for invented in ["الملفات: 0", "0 بايت", "الحجم: 0"] {
            assert!(
                !text.contains(invented),
                "صفرٌ مُختلق في موضع قياس («{invented}») — لا سجلّ يعني لا رقم: {text}"
            );
        }
        // النصّ كما يراه المستخدم يُطبَع — فيُقاس على الشجرة الساكنة بلا وسيط.
        eprintln!("م٥/بلا سجلّ (نصّ /stats): {}", text.replace('\n', " ¦ "));

        // وبسجلّ: القيم الأربع من السجلّ نفسه.
        note_delivery(&root, 7, "Ali", 3 * 1024 * 1024).unwrap();
        let rec = load(&root, 7).unwrap();
        let text = text_for(7, Some(&rec));
        for want in ["Ali", "المعرّف: 7", "الملفات: 1", "3.0 م.ب"] {
            assert!(text.contains(want), "ناقص «{want}» في: {text}");
        }

        // **والصفر المقيس يُعرَض**: ملفٌّ واحد بحجم صفر ⇒ «الملفات: 1» و«0 بايت»,
        // وهذا ليس اختراعاً بل قياس (وإلا لكان الفرق بين الحالتين ضائعاً).
        note_delivery(&root, 9, "Zero", 0).unwrap();
        let zero = load(&root, 9).unwrap();
        let ztext = text_for(9, Some(&zero));
        assert!(ztext.contains("الملفات: 1"), "{ztext}");
        assert!(ztext.contains("0 بايت"), "{ztext}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// الاسم القادم من الشبكة لا يكسر الشكل: سطرٌ في الاسم لا يصنع سطراً في
    /// الملف، والطول مقيَّد.
    #[test]
    fn a_hostile_display_name_cannot_add_lines_or_grow_the_file() {
        let root = tmp("hostile");
        let long = "x".repeat(400);
        let rec = note_delivery(&root, 7, &format!("Ali\n\"files\":999999,\n{long}"), 10).unwrap();
        assert!(!rec.name.contains('\n'), "بقي سطر في الاسم: {:?}", rec.name);
        assert!(rec.name.chars().count() <= NAME_CAP, "الاسم غير مقيَّد");
        let body = std::fs::read_to_string(path_for(&root, 7)).unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(&body).is_ok(),
            "الاسم أفسد الملف: {body}"
        );
        assert_eq!(load(&root, 7).unwrap().files, 1, "الاسم عدّل عدّاداً");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// حجم مقروء بالوحدات: صفرُ ملفٍ ليس «‎0.0MB».
    #[test]
    fn sizes_are_readable_across_units() {
        assert_eq!(human_size(0), "0 بايت");
        assert_eq!(human_size(999), "999 بايت");
        assert_eq!(human_size(1024), "1.0 ك.ب");
        assert_eq!(human_size(1024 * 1024), "1.0 م.ب");
        assert_eq!(human_size(3 * 1024 * 1024 * 1024), "3.00 ج.ب");
    }

    /// **جولة التفنيد، عطل ٢ — لا زيادة تُفقد بين العمليات.**
    ///
    /// أربع عمليات × ٤٠ تسليماً ⇒ المجموع **بالضبط** ١٦٠. والمُفسَد: قفلٌ داخل
    /// العملية وحده (بلا حصرٍ بين العمليات) ⇒ القراءة-ثم-الزيادة-ثم-الكتابة
    /// تتسابق فتُسقط زيادات (قِيس في الجولة السابقة: ٥٢ من ٢٠٠ بين أربع عمليات).
    ///
    /// والعملية الفرعية هي **ثنائي الاختبار نفسه** يُعاد تشغيله بمرشّح هذه
    /// الدالة ووسمٍ بيئي يحمل مجلد العمل — فلا ثنائي مساعد ولا اعتمادية جديدة.
    #[test]
    fn no_delivery_is_lost_between_processes() {
        const CHILD_ENV: &str = "HL_TGSTATS_CHILD_DIR";
        const CHILD_TEST: &str = "tg_stats::tests::no_delivery_is_lost_between_processes";
        const ROUNDS: u64 = 40;
        const PROCS: usize = 4;

        // —— فرع العملية الفرعية: يكتب ثم يخرج (يُعاد تشغيله من الأب).
        if let Ok(shared) = std::env::var(CHILD_ENV) {
            for _ in 0..ROUNDS {
                note_delivery(Path::new(&shared), 7, "ابن", 1).expect("كتابة الابن");
            }
            return;
        }

        let root = tmp("xproc");
        let exe = std::env::current_exe().expect("مسار ثنائي الاختبار");
        let mut kids = Vec::new();
        for _ in 0..PROCS {
            kids.push(
                std::process::Command::new(&exe)
                    .args(["--exact", CHILD_TEST, "--test-threads=1"])
                    // بلا أنابيب: لا نقرأ مخرجهما فلا نحتاجها (ولا نُعلّق).
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .env(CHILD_ENV, root.as_os_str())
                    .spawn()
                    .expect("تشغيل عملية فرعية"),
            );
        }
        let mut failed = Vec::new();
        for mut k in kids {
            let st = k.wait().expect("انتظار العملية الفرعية");
            if !st.success() {
                failed.push(st);
            }
        }

        // **العدد أولاً** (الادّعاء الأصلي): بلا قفلٍ عابر للعمليات تُقرأ القيمة
        // نفسها مرّتين فتُكتب مرّة — فينقص العدّ. ويُقاس الفقد رقماً لا وصفاً
        // (قِيس على المُفسَد: «سُجّل ١ من ١٦٠» و«٤٢ من ١٦٠» في تشغيلين).
        let rec = load(&root, 7).expect("سجلّ بعد العمليات");
        assert_eq!(
            rec.files,
            ROUNDS * PROCS as u64,
            "ضاعت زيادات بين العمليات: سُجّل {} من {} — القفل لا يعبر العمليات",
            rec.files,
            ROUNDS * PROCS as u64
        );
        assert_eq!(
            rec.bytes,
            ROUNDS * PROCS as u64,
            "الحجم لم يجمع كل الزيادات"
        );
        // **ثمّ حالة العمليات**: كتابةٌ فشلت بصوتٍ عالٍ ليست أفضل من ضياعٍ صامت
        // — فمجموعٌ صحيح مع عملية فاشلة يعني أن الكتابة الفاشلة لم تُدوَّن.
        assert!(
            failed.is_empty(),
            "{} عملية فرعية فشلت (أولها {:?}) رغم أن المجموع صحّ",
            failed.len(),
            failed.first()
        );
        eprintln!(
            "م٥/عبر العمليات: {PROCS} عمليات × {ROUNDS} تسليماً ⇒ سُجّل {} من {}",
            rec.files,
            ROUNDS * PROCS as u64
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
