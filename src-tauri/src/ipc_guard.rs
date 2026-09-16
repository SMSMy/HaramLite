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

/// المسار الذي يقارن به Tauri فعلاً: `is_allowed` يستدعي
/// `try_resolve_symlink_and_canonicalize`، فالنمط المسموح يجب أن يكون
/// بالصيغة نفسها. على ويندوز هذا يعني بادئة `\\?\` — مقيسة لا مفترضة
/// (اختبار `granting_one_path_does_not_open_the_rest_of_the_disk`).
///
/// ملف غير موجود ⇒ `None`: لا نسمح بمسار لا نستطيع تأكيده.
pub fn canonical_target(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// اسمح لبروتوكول الأصول بمسار واحد سلّمه الخلف إلى الواجهة.
///
/// يُستدعى **بعد** نجاح قراءة الملف فعلاً (لا قبل). فشل السماح لا يُسقط
/// العملية: أسوأ حاله ألا تُعرض المعاينة (والرسالة في السجل).
pub fn allow_asset_for_frontend(app: &tauri::AppHandle, path: &Path) {
    use tauri::Manager;
    let Some(canonical) = canonical_target(path) else {
        tracing::debug!(target: "app", "لم يُسمح بمسار غير موجود في نطاق الأصول: {}", path.display());
        return;
    };
    let scope = app.asset_protocol_scope();
    match scope.allow_file(&canonical) {
        Ok(()) => {
            tracing::debug!(target: "app", "سُمح لمسار واحد في نطاق الأصول: {}", canonical.display())
        }
        Err(e) => tracing::warn!(target: "app", "تعذر السماح بالمسار في نطاق الأصول: {e}"),
    }
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
