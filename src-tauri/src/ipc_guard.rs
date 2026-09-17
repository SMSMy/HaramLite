//! و-٤ — رمز مشترك لحلقة الإقلاع الواحد (منفذ 48765 المحلي).
//!
//! المنفذ كان بلا مصادقة: أي عملية محلية تتّصل وتكتب بايتاً واحداً فتُظهر
//! نافذة التطبيق. الأثر الأقصى **مضايقة بصرية** (لا يُقرأ من المنفذ ولا
//! يُكتب إليه شيء)، لكن المنع رخيص: رمز عشوائي من عشوائية النظام يُكتب في
//! ملف داخل مجلد بيانات التطبيق (`paths::data_dir`) تقرأه النسخة الثانية
//! وترسله، والمستمع لا يقبل إلا الرمز المطابق.
//!
//! **الحدّ المتبقّي بصراحة** (مذكور في التقرير أيضاً): من يقرأ الملف بنفس
//! صلاحية المستخدم يعرف الرمز. فالقيمة المضافة ليست سرّية مطلقة بل منع
//! **العبث من عمليات لا تقرأ ملفاتنا** (سكربت عابر، أداة شبكة، صفحة تُنفَّذ
//! في متصفح) — والأثر الأقصى يبقى «إظهار نافذة» كما كان.
//!
//! ويضم هذا الملف أيضاً قرار **و-١** (نطاق بروتوكول الأصول): لم يكن له موضع
//! أنسب — التضييق الزمني في المسار نفسه الذي يمنح فيه الخلف شيئاً للواجهة.

use std::path::{Path, PathBuf};

/// طول الرمز بالبايت قبل الترميز النصّي.
pub const NONCE_BYTES: usize = 32;
/// بادئة السلك (`HLSI` = HaramLite Single Instance) — تميّز رسالتنا عن نبضة
/// جسر التكامل (اتصال بلا بيانات) وعن أي مسبار عشوائي.
pub const WIRE_MAGIC: [u8; 4] = *b"HLSI";
/// موافقة المستمع: البايت الوحيد الذي يعني «النافذة ستُظهر».
pub const ACCEPT_BYTE: u8 = 0x01;
/// رفض المستمع: لا شيء سيحدث، فاخرج بصمت.
pub const REJECT_BYTE: u8 = 0x00;

/// اسم ملف الرمز داخل مجلد بيانات التطبيق.
pub const NONCE_FILE: &str = "instance.nonce";

pub fn nonce_path(base: &Path) -> PathBuf {
    base.join(NONCE_FILE)
}

/// رمز جديد من عشوائية النظام (`getrandom` ← `RtlGenRandom` على ويندوز).
///
/// فشل مصدر العشوائية **لا يُستبدل** ببديل ضعيف: يُعاد خطأ، والمتصل يقرر.
/// (وهذا هو الفرق الجوهري عن `RandomState` في و-٧: لا سقوط صامت إلى بذرة
/// غير سرّية.)
pub fn new_nonce() -> Result<[u8; NONCE_BYTES], String> {
    let mut buf = [0u8; NONCE_BYTES];
    getrandom::fill(&mut buf).map_err(|e| format!("تعذر توليد رمز عشوائي: {e}"))?;
    Ok(buf)
}

/// الترميز النصّي (hex صغير) — ملف قابل للقراءة والنسخ عند التشخيص.
pub fn nonce_to_hex(n: &[u8]) -> String {
    let mut s = String::with_capacity(n.len() * 2);
    for b in n {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// الرمز المخزَّن، أو `None` إن لم يوجد/كان تالفاً. لا يُنشئ شيئاً: القراءة
/// للنسخة الثانية (التي لا تملك حقّ التوليد) وللفحص.
pub fn load_nonce(base: &Path) -> Option<Vec<u8>> {
    let raw = std::fs::read_to_string(nonce_path(base)).ok()?;
    let hex = raw.trim();
    if hex.is_empty() || hex.len() % 2 != 0 || hex.len() != NONCE_BYTES * 2 {
        return None;
    }
    let mut out = Vec::with_capacity(NONCE_BYTES);
    let bytes = hex.as_bytes();
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

/// اكتب الرمز ذرّياً (نفس مساعد و-٦) وأعده. تُستدعى في **النسخة الأولى**
/// (التي فازت بالمنفذ) قبل أن تستقبل أول اتصال.
pub fn save_nonce(base: &Path, nonce: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    crate::atomic::write_atomic_str(&nonce_path(base), &nonce_to_hex(nonce), "nonce")
        .map_err(|e| format!("تعذر حفظ رمز الجلسة: {e}"))
}

/// الرمز الحالي: المخزَّن إن وُجد، وإلا يُولَّد ويُكتب (النسخة الأولى فقط).
/// فشل الكتابة ليس قاتلاً: الجلسة تعمل بالرمز في الذاكرة، والنسخة الثانية
/// ستفشل في المصادقة وتخرج بصمت — سلوك آمن لا سلوك مكسور.
pub fn load_or_create_nonce(base: &Path) -> Vec<u8> {
    if let Some(n) = load_nonce(base) {
        return n;
    }
    match new_nonce() {
        Ok(n) => {
            if let Err(e) = save_nonce(base, &n) {
                // Warning only: no secret is printed, and the session is fine.
                tracing::warn!(target: "app", "تعذر كتابة رمز الجلسة: {e}");
            }
            n.to_vec()
        }
        Err(e) => {
            tracing::error!(target: "app", "تعذر توليد رمز الجلسة: {e}");
            Vec::new()
        }
    }
}

/// هل هذه حمولة سلك مطابقة للرمز؟ يقبل حمولة أطول (تحمّل بايتات زائدة) لكن
/// يقارن **كل** بايتات الرمز.
pub fn accepts(actual_nonce: &[u8], payload: &[u8]) -> bool {
    !actual_nonce.is_empty()
        && payload.len() >= actual_nonce.len()
        && payload[..actual_nonce.len()] == *actual_nonce
}

/// طلب سلك كامل: البادئة `HLSI` ثم الرمز. دالة نقية — وهذا ما يفحصه الاختبار
/// السلبي («رمز خاطئ ⇒ لا إظهار») بلا فتح منفذ حقيقي.
pub fn authentic_request(actual_nonce: &[u8], wire: &[u8]) -> bool {
    if wire.len() < WIRE_MAGIC.len() {
        return false;
    }
    if wire[..WIRE_MAGIC.len()] != WIRE_MAGIC {
        return false;
    }
    accepts(actual_nonce, &wire[WIRE_MAGIC.len()..])
}

/// حمولة الطلب من رمز معروف (نفس ما ترسله النسخة الثانية حرفياً).
pub fn request_bytes(nonce: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(WIRE_MAGIC.len() + nonce.len());
    out.extend_from_slice(&WIRE_MAGIC);
    out.extend_from_slice(nonce);
    out
}

/// الرمز الفعلي للجلسة، مع تطبيع ترميزه عبر إعادة القراءة من الملف.
///
/// لماذا إعادة القراءة: النسخة الأولى قد تكون ولّدت الرمز في جلسة سابقة
/// وكتبته، ثم نُسخ الملف أو عُدِّل يدوياً؛ القراءة الحالية هي مصدر الحقيقة
/// الوحيد — والذاكرة مجرد احتياط عند تعذّر القراءة.
pub fn effective_nonce(base: &Path, in_memory: &[u8]) -> Vec<u8> {
    load_nonce(base).unwrap_or_else(|| in_memory.to_vec())
}

// ─────────────────────────────────────────────────────────────────────
// و-١ — السماح الزمني بمسار واحد في نطاق بروتوكول الأصول
// ─────────────────────────────────────────────────────────────────────
//
// `tauri.conf.json` كان يسمح بـ`"**"`: أي تمكّن من تنفيذ سكربت في الواجهة
// يقرأ **أي ملف** بصلاحية المستخدم عبر `asset:`. الواجهة تستعمل البروتوكول
// في موضع وحيد (`src/player.ts:308` على `convertFileSrc(plPath)`)، و`plPath`
// يأتي من حوار الملفات ثم يُسلَّم إلى الخلف في `player_prepare`.
//
// فالنطاق الثابت صار **فارغاً**، والسماح **زمني**: يُمنح لحظة أن ينجح الخلف
// فعلاً في فتح ذاك الملف وقراءته — أي أن المسار صار مساراً سلّمناه، لا مساراً
// ادّعته الواجهة. مسار لم يمرّ بذاك النجاح يبقى مرفوضاً حتى لو وُجد على القرص.
//
// **وو-١ ب (مراجعة 0.2.7)**: «زمني» كانت تسمية لا سلوكاً — `allow_file` تُضاف
// ولا تُسحب، فالنطاق ينمو لعمر العملية. الآن للمنح **نافذة** (`GRANT_WINDOW`)
// والأقدم يُبطل بـ`forbid_file` فلا يبقى مقروءاً. التفصيل والثمن المُعلَن في
// تعليق `GRANT_WINDOW`.

/// المسار الذي يقارن به Tauri فعلاً: `is_allowed` يستدعي
/// `try_resolve_symlink_and_canonicalize`، فالنمط المسموح يجب أن يكون
/// بالصيغة نفسها. على ويندوز هذا يعني بادئة `\\?\` — مقيسة لا مفترضة
/// (اختبار `granting_one_path_does_not_open_the_rest_of_the_disk`).
///
/// ملف غير موجود ⇒ `None`: لا نسمح بمسار لا نستطيع تأكيده.
pub fn canonical_target(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// كم مساراً مُسلَّماً يبقى مقروءاً في الوقت نفسه.
///
/// **العيب الذي يعالجه** (و-١ ب، المراجعة الأمنية لـ0.2.7): `allow_file` كانت
/// **تُضاف ولا تُسحب**، فنطاق الأصول ينمو لعمر العملية — كل ملف نجح
/// `player_prepare` عليه يبقى مقروءاً عبر `asset:` إلى أن يُغلق التطبيق، ولو
/// كان المستخدم قد انتهى منه منذ ساعات. أي سكربت يجري في الواجهة يقرأ **كل**
/// ما مُرِّر في الجلسة، لا ما يُعرض الآن.
///
/// **ولماذا نافذة لا مسار واحد**: `Scope` لا يملك «إلغاء سماح»، و`forbid_file`
/// له الأولوية **دائماً وبلا رجعة** (`try_resolve_symlink_and_canonicalize` ثم
/// `forbidden` تُسبق `allowed`). فسحب مسار يمنع إعادة منحه في العملية نفسها —
/// أي أن التضييق إلى مسار واحد يكسر تدفّقاً حقيقياً (أ ← ب ← أ). فالنافذة تحفظ
/// الذهاب والعودة داخل جلسة اللاعب، وتجعل المقروء **ثابتاً** بدل أن ينمو.
///
/// **الثمن المُعلَن**: المنح بعد الإبطال لا يمكن استرجاعه (`Scope` بلا
/// un-forbid)، فيُعاد **خطأً صريحاً** لا فشلاً صامتاً. وثانياً — وهذا **مقيس لا
/// مُدَّعى** — `forbid_file` **لا يحذف** النمط من مجموعة السماح: فالمجموعتان
/// تنموان معاً (نمطان لكل مسار)، لكن القرار يمرّ على المنع أولاً، فالنموّ
/// **ذاكرة فقط** ولا يمنح قراءة. أي أن هذا الإصلاح يضيّق **المقروء** لا
/// البصمة؛ ولو أُريد تقييد البصمة أيضاً فلا سبيل إليه بهذه الواجهة.
pub const GRANT_WINDOW: usize = 8;

/// المسارات الممنوحة الآن، من الأقدم إلى الأحدث.
static GRANTED: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

/// سياسة المنح وحدها، **دالة نقية**: تأخذ السجل (من الأقدم إلى الأحدث) والمسار
/// الجديد والسعة، وتعيد السجل بعد المنح والمسارات التي يجب سحبها.
///
/// نقية لتُختبر بلا نطاق ولا تطبيق ولا إطلاق — وهي الموضع الوحيد الذي يقرر
/// الإبطال، فلا يمكن «إصلاح» الإبطال في الاختبار وحده.
pub fn plan_grant(
    history: &[PathBuf],
    newly: &Path,
    window: usize,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    // إعادة المنح تُحرّك المسار إلى الأحدث ولا تُكرّره (والنمط في `Scope`
    // مجموعة، فالتكرار لا يوسّع شيئاً — لكن السجل يجب أن يبقى صادقاً).
    let mut next: Vec<PathBuf> = history
        .iter()
        .filter(|p| p.as_path() != newly)
        .cloned()
        .collect();
    next.push(newly.to_path_buf());
    let cap = window.max(1);
    let mut revoked = Vec::new();
    while next.len() > cap {
        revoked.push(next.remove(0));
    }
    (next, revoked)
}

/// المسارات الممنوحة الآن (الأقدم أولاً) — للفحص والاختبار.
pub fn granted_paths() -> Vec<PathBuf> {
    GRANTED.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// اسمح لبروتوكول الأصول بمسار واحد سلّمه الخلف إلى الواجهة، واسحب الأقدم إن
/// امتلأت النافذة.
///
/// يُستدعى **بعد** نجاح قراءة الملف فعلاً (لا قبل). فشل السماح لا يُسقط
/// العملية: أسوأ حاله ألا تُعرض المعاينة (والرسالة في السجل).
///
/// `Err` تعني **مساراً أُبطل سابقاً في هذه العملية**: `forbid_file` له الأولوية
/// على أي `allow_file` لاحق، فلا فائدة من تسليم الواجهة مساراً سيردّ عليه
/// البروتوكول بـ403. تُبلَّغ الحالة صراحةً بدل فشل صامت.
///
/// عامّة على `R` لتُقاس في الاختبار على `MockRuntime` بنفس الكود الذي يعمل في
/// الإنتاج (لا نسخة ثانية للاختبار).
pub fn allow_asset_for_frontend<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<(), String> {
    use tauri::Manager;
    let Some(canonical) = canonical_target(path) else {
        tracing::debug!(target: "app", "لم يُسمح بمسار غير موجود في نطاق الأصول: {}", path.display());
        return Ok(());
    };
    let scope = app.asset_protocol_scope();

    // مُبطل سابقاً ⇒ لا يمكن استرجاعه في هذه العملية (انظر `GRANT_WINDOW`).
    if scope.is_forbidden(&canonical) {
        return Err(format!(
            "سُحب السماح بهذا المسار سابقاً في هذه الجلسة ولا يمكن منحه ثانية: {}",
            canonical.display()
        ));
    }

    let (next, revoked) = {
        let history = granted_paths();
        plan_grant(&history, &canonical, GRANT_WINDOW)
    };

    scope
        .allow_file(&canonical)
        .map_err(|e| format!("تعذر السماح بالمسار في نطاق الأصول: {e}"))?;
    *GRANTED.lock().unwrap_or_else(|p| p.into_inner()) = next;
    tracing::debug!(target: "app", "سُمح لمسار واحد في نطاق الأصول: {}", canonical.display());

    for old in revoked {
        match scope.forbid_file(&old) {
            Ok(()) => tracing::debug!(
                target: "app",
                "سُحب السماح بمسار خارج النافذة ({}): {}",
                GRANT_WINDOW,
                old.display()
            ),
            // سحب فاشل = المسار يبقى مقروءاً؛ يُسجَّل تحذيراً ولا يُسقط المنح
            // الجديد (الواجهة تحتاجه الآن).
            Err(e) => tracing::warn!(target: "app", "تعذر سحب السماح بالمسار: {e}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// و-١ — القرار الفعلي لنطاق بروتوكول الأصول، بلا ادّعاء.
    ///
    /// يبني النطاق من التهيئة الحقيقية (`tauri.conf.json` المُضمَّنة في
    /// `generate_context!`) ويقيس `is_allowed` قبل السماح وبعده:
    /// الملف المُسلَّم يُقبل، وغيره — ولو كان موجوداً على القرص — يُرفض.
    /// ولو عاد `allow: ["**"]` إلى التهيئة لكان الصفّ الأخير `true` وسقط
    /// الاختبار.
    #[test]
    fn granting_one_path_does_not_open_the_rest_of_the_disk() {
        use tauri::Manager as _;

        let app = tauri::test::mock_app();
        let scope = app.asset_protocol_scope();

        let root = std::env::temp_dir().join(format!("hl_scope_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let handed = root.join("song.mp3");
        let stranger = root.join("secret.txt");
        std::fs::write(&handed, b"the file the backend handed over").unwrap();
        std::fs::write(&stranger, b"never handed over").unwrap();

        let canonical = canonical_target(&handed).expect("file exists ⇒ canonical");
        assert!(
            canonical.to_string_lossy().starts_with(r"\\?\"),
            "canonicalize على ويندوز يضيف \\\\?\\ — والدليل مسجَّل في التقرير"
        );

        // قبل السماح: كل شيء مرفوض.
        assert!(!scope.is_allowed(&canonical), "لا شيء مسموح قبل التسليم");
        assert!(!scope.is_allowed(&stranger), "ولا جاره");
        assert!(!scope.is_allowed(std::env::temp_dir()), "ولا مجلد المؤقتات");

        // بعد السماح بمسار واحد: ذاك وحده.
        scope.allow_file(&canonical).expect("allow_file");
        assert!(scope.is_allowed(&canonical), "الملف المُسلَّم يجب أن يُقبل");
        assert!(
            scope.is_allowed(&handed),
            "ونفسه بالمسار الخام (is_allowed يوحّد الصيغتين)"
        );
        assert!(
            !scope.is_allowed(&stranger),
            "ملف آخر في المجلد نفسه يجب أن يبقى مرفوضاً"
        );
        assert!(
            !scope.is_allowed(std::env::temp_dir().join("hl_never_granted.bin")),
            "ومسار لم يُسلَّم قطّ مرفوض"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// و-١ سلبي على ملف التهيئة نفسه: `allow` لا يحوي `**`، و`deny` فارغ.
    /// يقرأ الملف الحقيقي من القرص — فلا يمكن «إصلاح» السلوك في الكود وحده.
    #[test]
    fn the_asset_scope_config_grants_no_wildcard() {
        let raw = include_str!("../tauri.conf.json");
        let v: serde_json::Value =
            serde_json::from_str(raw).expect("tauri.conf.json is valid JSON");
        let scope = &v["app"]["security"]["assetProtocol"]["scope"];
        let allow = scope["allow"].as_array().expect("scope.allow is an array");
        assert!(
            allow.is_empty(),
            "allow يجب أن يبقى فارغاً: السماح زمني من الخلف لا شامل من التهيئة — وجدت {allow:?}",
        );
        for entry in allow {
            let s = entry.as_str().unwrap_or_default();
            assert!(!s.contains('*'), "نمط شامل في allow: {s}");
        }
        assert!(
            v["app"]["security"]["assetProtocol"]["enable"].as_bool() == Some(true),
            "البروتوكول نفسه يبقى مفعَّلاً — الضيق في النطاق لا في التعطيل"
        );
        assert!(
            scope["deny"]
                .as_array()
                .map(|d| d.is_empty())
                .unwrap_or(false),
            "deny فارغ كما كان (لا سلوك جديد)"
        );
    }

    /// و-١ ب — سياسة النافذة وحدها، **نقية**: بلا نطاق ولا تطبيق ولا إطلاق.
    /// وهي الموضع الوحيد الذي يقرر الإبطال، فلا يمكن «إصلاح» السلوك في
    /// الاختبار وحده.
    #[test]
    fn the_grant_window_keeps_the_newest_and_revokes_the_oldest() {
        let p = |i: usize| PathBuf::from(format!(r"C:\out\track{i}.mp3"));
        let total = GRANT_WINDOW * 3;
        let mut history: Vec<PathBuf> = Vec::new();
        let mut revoked: Vec<PathBuf> = Vec::new();
        for i in 0..total {
            let (next, rev) = plan_grant(&history, &p(i), GRANT_WINDOW);
            assert!(
                next.len() <= GRANT_WINDOW,
                "النافذة تجاوزت سعتها: {}",
                next.len()
            );
            assert_eq!(next.last(), Some(&p(i)), "الجديد في آخر السجل");
            assert!(!rev.contains(&p(i)), "لا يُبطل ما مُنح للتوّ");
            revoked.extend(rev);
            history = next;
        }
        assert_eq!(
            revoked.len(),
            total - GRANT_WINDOW,
            "كل ما خرج من النافذة أُبطل مرة واحدة"
        );
        assert!(!history.contains(&p(0)), "الأقدم خرج من النافذة");
        assert!(history.contains(&p(total - 1)), "الأحدث بقي");

        // إعادة منح مسار **داخل** النافذة: يصير الأحدث، بلا تكرار ولا إبطال —
        // وهذا هو تدفّق اللاعب (أ ← ب ← أ).
        let back = history[0].clone();
        let (next, rev) = plan_grant(&history, &back, GRANT_WINDOW);
        assert_eq!(next.last(), Some(&back), "إعادة المنح تُحرّك إلى الأحدث");
        assert_eq!(next.len(), GRANT_WINDOW, "بلا تكرار");
        assert!(rev.is_empty(), "إعادة منح لا تُبطل شيئاً");
        assert_eq!(next.iter().filter(|x| **x == back).count(), 1, "مرة واحدة");
    }

    /// سعة دنيا (1): تبقى صحيحة — لا انهيار ولا إبطال للجديد.
    #[test]
    fn a_window_of_one_keeps_exactly_one_path() {
        let a = PathBuf::from(r"C:\out\a.mp3");
        let b = PathBuf::from(r"C:\out\b.mp3");
        let (one, none) = plan_grant(&[], &a, 1);
        assert_eq!(one, vec![a.clone()]);
        assert!(none.is_empty());
        let (still_one, rev) = plan_grant(&one, &b, 1);
        assert_eq!(still_one, vec![b.clone()]);
        assert_eq!(rev, vec![a], "الأقدم وحده يُبطل");
        // سعة 0 تُعامل كـ1: لا نافذة فارغة تُبطل ما مُنح للتوّ.
        let (floor, rev) = plan_grant(&[], &b, 0);
        assert_eq!(floor, vec![b]);
        assert!(rev.is_empty());
    }

    /// و-١ ب — السلوك الفعلي على نطاق حقيقي، و**مُفسَده**: ما لم يُسلَّم قطّ أو
    /// خرج من النافذة ⇒ `is_allowed` كاذب ⇒ بروتوكول الأصول يردّ 403.
    ///
    /// وهو الاختبار **الوحيد** الذي يمسّ السجل العام (`GRANTED`): لو شاركه غيره
    /// لصار الإبطال تابعاً لترتيب تشغيل الاختبارات لا للسياسة.
    #[test]
    fn the_asset_scope_stops_growing_and_evicted_paths_are_refused() {
        use tauri::Manager as _;

        let app = tauri::test::mock_app();
        let scope = app.asset_protocol_scope();
        let handle = app.handle().clone();
        let root = std::env::temp_dir().join(format!("hl_scope_window_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let n = GRANT_WINDOW * 3;
        let files: Vec<PathBuf> = (0..n)
            .map(|i| {
                let p = root.join(format!("t{i}.mp3"));
                std::fs::write(&p, b"handed over").unwrap();
                p
            })
            .collect();
        let stranger = root.join("never-handed.txt");
        std::fs::write(&stranger, b"never handed over").unwrap();

        // ضابط: قبل أي منح لا شيء مسموح.
        assert!(!scope.is_allowed(&files[n - 1]), "لا شيء مسموح قبل التسليم");

        for f in &files {
            allow_asset_for_frontend(&handle, f).expect("منح مسار سلّمه الخلف");
        }

        // الأحدث مسموح، والأقدم (خرج من النافذة) **يُرفض** — وهو المُفسَد.
        assert!(
            scope.is_allowed(canonical_target(&files[n - 1]).unwrap()),
            "أحدث مسار مسموح"
        );
        assert!(scope.is_allowed(&files[n - 1]), "ونفسه بالمسار الخام");
        assert!(
            !scope.is_allowed(canonical_target(&files[0]).unwrap()),
            "أقدم مسار خرج من النافذة ⇒ يجب أن يُرفض"
        );
        assert!(!scope.is_allowed(&files[0]), "ونفسه بالمسار الخام مرفوض");
        assert!(!scope.is_allowed(&stranger), "وملف لم يُسلَّم قطّ مرفوض");

        // **المقيس**: المقروء الآن هو النافذة وحدها لا كل ما مُنح. هذا هو
        // الفرق العملي — قبل هذا الإصلاح كان العدّ 24 (كل ما مُنح في الجلسة)،
        // وهو معنى «النطاق ينمو لعمر العملية».
        let readable: Vec<&PathBuf> = files.iter().filter(|f| scope.is_allowed(f)).collect();
        assert_eq!(
            readable.len(),
            GRANT_WINDOW,
            "المقروء يجب أن يكون النافذة وحدها ({GRANT_WINDOW}) لا {n} — والمقروء فعلاً: {readable:?}"
        );
        assert_eq!(
            readable.last().map(|p| p.as_path()),
            Some(files[n - 1].as_path()),
            "وآخرها هو أحدث ما مُنح"
        );

        // **والثمن المُعلَن — مقيس لا مُدَّعى**: `Scope` لا يملك إزالة نمط،
        // فمجموعة السماح **تبقى** تحمل كل مسار مُنح (نمطان لكل مسار على ويندوز:
        // الصيغة الأصلية والمجرَّدة)، ومجموعة المنع تحمل كل ما أُبطل. فالنموّ
        // الباقي ذاكرةٌ فقط ولا يمنح قراءة: القرار يمرّ على المنع أولاً.
        let patterns = scope.allowed_patterns().len();
        assert!(
            patterns >= 2 * n,
            "أنماط السماح لا تُحذف من `Scope` — قياس متوقّع ≥ {}، وجدت {patterns}",
            2 * n
        );
        assert!(
            scope.forbidden_patterns().len() >= n - GRANT_WINDOW,
            "وكل ما أُبطل دخل مجموعة المنع"
        );

        // الثمن المُعلَن: `forbid_file` لا رجعة له، فإعادة منح مسار أُبطل
        // **تُبلَّغ** ولا تمرّ بصمت (البروتوكول سيردّ 403 على أي حال).
        assert!(
            allow_asset_for_frontend(&handle, &files[0]).is_err(),
            "إعادة منح مسار مُبطل يجب أن تُبلَّغ"
        );
        assert_eq!(granted_paths().len(), GRANT_WINDOW, "السجل بطول النافذة");

        let _ = std::fs::remove_dir_all(&root);
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hl_ipc_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// و-٤ الأساس: الرمز المخزَّن يُقرأ مطابقاً، والحمولة المطابقة تُقبل.
    #[test]
    fn a_saved_nonce_round_trips_and_accepts_only_itself() {
        let root = tmp("roundtrip");
        let nonce = new_nonce().expect("OS entropy must be available in tests");
        save_nonce(&root, &nonce).unwrap();
        let loaded = load_nonce(&root).expect("saved nonce must load");
        assert_eq!(loaded, nonce.to_vec(), "الرمز المخزَّن يجب أن يطابق");
        assert!(accepts(&loaded, &nonce));
        // وما بعده لا يؤثر: الحمولة قد تحمل بايتات زائدة.
        let mut longer = nonce.to_vec();
        longer.extend_from_slice(b"extra");
        assert!(accepts(&loaded, &longer));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// و-٤ سلبي: رمز خاطئ ⇒ رفض. هذا هو الفحص الذي يسقط لو عاد المستمع
    /// يقبل أي اتصال.
    #[test]
    fn a_wrong_nonce_is_rejected() {
        let root = tmp("wrong");
        let nonce = new_nonce().unwrap();
        save_nonce(&root, &nonce).unwrap();
        let stored = load_nonce(&root).unwrap();

        let mut wrong = nonce;
        wrong[0] ^= 0xFF; // بايت واحد مختلف يكفي
        assert!(!accepts(&stored, &wrong), "رمز ببايت مبدَّل يجب أن يُرفض");

        // رمز من جلسة أخرى (نفس الطول، قيم أخرى) يجب أن يُرفض أيضاً.
        let other = new_nonce().unwrap();
        assert!(!accepts(&stored, &other), "رمز جلسة أخرى يجب أن يُرفض");
    }

    /// و-٤ سلبي: الحمولات القصيرة/الفارغة لا تُقبل — البايت الواحد القديم
    /// (`0x01`) لم يبق له أثر.
    #[test]
    fn short_probes_and_the_legacy_byte_are_rejected() {
        let nonce = new_nonce().unwrap();
        assert!(!accepts(&nonce, &[]), "حمولة فارغة = نبضة، لا طلب");
        assert!(!accepts(&nonce, &[0x01]), "البايت القديم لم يبق مقبولاً");
        assert!(
            !accepts(&nonce, &nonce[..nonce.len() - 1]),
            "حمولة أقصر من الرمز مرفوضة"
        );
        assert!(!accepts(&[], &[0x01]), "بلا رمز فعلي لا يُقبل شيء");
    }

    /// و-٤ سلبي: ملف مفقود أو تالف ⇒ `None` (فلا مصادقة بلا رمز).
    #[test]
    fn a_missing_or_corrupt_nonce_file_yields_nothing() {
        let root = tmp("corrupt");
        assert!(load_nonce(&root).is_none(), "ملف مفقود = لا رمز");
        std::fs::write(nonce_path(&root), b"not-hex-and-too-short").unwrap();
        assert!(load_nonce(&root).is_none(), "ملف تالف = لا رمز");
        std::fs::write(nonce_path(&root), b"").unwrap();
        assert!(load_nonce(&root).is_none(), "ملف فارغ = لا رمز");
        // طول صحيح لكن محارف غير سداسية عشرية.
        std::fs::write(nonce_path(&root), "z".repeat(NONCE_BYTES * 2)).unwrap();
        assert!(load_nonce(&root).is_none(), "محارف غير hex = لا رمز");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// الرمز المولَّد من عشوائية النظام: طوله مضبوط، ولا يتكرر بين نداءين
    /// (يسقط لو عاد المولّد ثابتاً).
    #[test]
    fn generated_nonces_are_full_length_and_never_repeat() {
        let a = new_nonce().unwrap();
        let b = new_nonce().unwrap();
        assert_eq!(a.len(), NONCE_BYTES);
        assert_ne!(a, b, "رمزان متتاليان لا يتطابقان");
        assert_eq!(nonce_to_hex(&a).len(), NONCE_BYTES * 2);
    }

    /// و-٤ الأساس عبر السلك كاملاً: طلب بالرمز الصحيح ⇒ إظهار، وبأي انحراف
    /// (بادئة خاطئة · رمز خاطئ · حمولة مبتورة · نبضة فارغة) ⇒ لا إظهار.
    /// هذا هو الاختبار الذي يقابل «اتصال برمز خاطئ ⇒ لا إظهار» في التقرير.
    #[test]
    fn wire_requests_show_the_window_only_with_the_exact_nonce() {
        let nonce = new_nonce().unwrap();

        // المسار الشرعي: نفس ما ترسله النسخة الثانية.
        assert!(
            authentic_request(&nonce, &request_bytes(&nonce)),
            "الطلب الشرعي يجب أن يُقبل"
        );

        // رمز خاطئ ببايت واحد.
        let mut wrong = nonce;
        wrong[NONCE_BYTES - 1] ^= 0x01;
        assert!(
            !authentic_request(&nonce, &request_bytes(&wrong)),
            "رمز ببايت مبدَّل يجب ألا يُظهر النافذة"
        );

        // البادئة القديمة (بايت واحد) لم تبق مقبولة.
        assert!(!authentic_request(&nonce, &[ACCEPT_BYTE]));
        assert!(!authentic_request(&nonce, &[]));

        // بادئة صحيحة وحمولة ناقصة.
        let mut short = request_bytes(&nonce);
        short.pop();
        assert!(!authentic_request(&nonce, &short), "حمولة مبتورة مرفوضة");

        // بادئة صحيحة ورمز جلسة أخرى.
        let other = new_nonce().unwrap();
        assert!(!authentic_request(&nonce, &request_bytes(&other)));

        // بادئة خاطئة ورمز صحيح.
        let mut bad_magic = request_bytes(&nonce);
        bad_magic[0] = b'X';
        assert!(!authentic_request(&nonce, &bad_magic));
    }
}
