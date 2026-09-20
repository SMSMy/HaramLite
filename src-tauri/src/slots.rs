//! م١ — محدِّد فتحات الفصل **عبر العمليات** + سِجلّ المهامّ.
//!
//! ## العطل المقيس الذي يعالجه هذا الملف
//!
//! لم يكن في التطبيق أي محدِّد تنفيذ متزامن، وخمسة مداخل تستدعي
//! `pipeline::process_file` — كلٌّ منها يُحمّل جلسة ORT خاصّة به. ومحدِّد
//! **داخل العملية** لا يكفي: مسار `cli.rs` عملية منفصلة تماماً عن الواجهة،
//! فتتجاوز أي عدّاد في ذاكنة العملية.
//!
//! ## أساس السقف (`MAX_LIMIT = 2`) — قياس `nvidia-smi` على جهاز واحد
//!
//! الأرقام التالية مقيسة **بـ`nvidia-smi` على بطاقة المالك** (RTX 3070 ·
//! 8192 MiB)، وهي قياس **جهاز واحد بطريقة واحدة** — لا رقم معمَّم على غيره:
//!
//! | الحالة | ذاكرة البطاقة |
//! |---|---|
//! | خط الأساس (بلا فصل) | 1419 MiB |
//! | فصل واحد | 3732 MiB |
//! | **فصلان متزامنان (الذروة)** | **7947 من 8192 MiB — 97%** |
//!
//! ونموّ `BFCArena for Cuda` المقيس ≈ **2.28 GB** لكل جلسة فصل. فهامش الفصلين
//! **245 MiB فقط** على بطاقة 8 GB: السقف 2 حدّ **بطاقة** لا تفضيل، والثالث
//! يُنفق هامشاً غير موجود. (والنموذج الخطّي القديم «1419 + n × 2325 ≈ 8.4 GB»
//! الذي كان يقدّر فصلين بـ6069 MiB **مُبطَل**: قياس الذروة المباشر أعلى منه،
//! فالحجّة للسقف 2 أقوى لا أضعف.)
//!
//! **وقياس ثانٍ في جولة الإصلاح نفسها** (طريقة: `nvidia-smi --query-gpu` على
//! مستوى الجهاز، جلستان **حقيقيتان** متزامنتان على CUDA بمقطع 12 ثانية، بناء
//! debug): خط الأساس **1047 MiB** ← ذروة **4734 MiB** ⇒ نصيب الجلستين
//! **3687 MiB** (≈1843 لكل جلسة بالتقسيم المتساوي المفترض)، وعادت البطاقة إلى
//! 1047 بعد الانتهاء. فالرقمان لا يتطابقان (7947 مقابل 4734) — واختلاف الحمل
//! (طول المقطع، وما يحمله سطح المكتب من سياقات GPU) يفسّره — و**السقف يُبنى
//! على أسوأ ما قيس (7947) لا على أرحمه**: حدّ البطاقة بأسوأ حالة، وقياس جولة
//! واحدة لا يُعمَّم. و`--query-compute-apps=pid,used_memory` أعطى `[N/A]` لكل
//! عملية على هذا الجهاز (قيد WDDM)، فالنصيبان مقيسان على مستوى **الجهاز** لا
//! لكل عملية.
//!
//! ## الافتراضيّ **1** والسقف 2 — قرار المالك بعد هذا القياس
//!
//! إعداد `max_concurrent_jobs` افتراضيّه **1** (`DEFAULT_LIMIT` أدناه): هو ما
//! تأخذه نسخة جديدة، أو ملفّ إعدادات لا يحمل الحقل أصلاً. والسقف المسموح يبقى
//! 2 (`MAX_LIMIT`) لمن يطلبه صراحةً من الواجهة: فأسوأ ما قيس للفصلين هامش
//! **245 MiB**، فالاثنان **خيار واعٍ** لا افتراض مريح.
//!
//! ## الحلّ — **زوج** سيمافورات مسمّاة، سعة كل رمز **1**
//!
//! سيمافور مسمّى في نواة ويندوز (`CreateSemaphoreW`/`OpenSemaphoreW`) باسم في
//! نطاق `Global\` يراه كل عمليات الجلسة، والعدّاد محفوظ في النواة لا في أي
//! عملية. وهذا الملف يستعمل **رمزين** (`<name>-a` و`<name>-b`) سعة كلٍّ منهما
//! **1**:
//!
//! * مهمّة بسقف 2 تأخذ **رمزاً واحداً** — أيّهما صار متاحاً
//!   (`WaitForMultipleObjects` بعدّاد 2 و`bWaitAll = FALSE`) ⇒ فتحتان معاً.
//! * مهمّة بسقف 1 تأخذ **الرمزين معاً** (`bWaitAll = TRUE`) ⇒ **حصرية فعلية**.
//!
//! ولماذا زوج لا سيمافور واحد بسعة 2: ويندوز **يتجاهل السقف المطلوب** في
//! `CreateSemaphoreW` إن كان الكائن قائماً، فكانت السعة سعةَ **أول من أنشأ**
//! الكائن — فطلبُ إعداد 1 على عملية ثانية يُفتح على سعة 2 ولا يحصر شيئاً.
//! وبالزوج **لا سعة متغيّرة أصلاً** (1 في كل عملية)، فينتفي «السقف سقف أول من
//! أنشأ» من أصله. وحارس RAII (`Drop`) يحرّر **ما أُخذ بالضبط** عند الخروج —
//! حتى مع الخطأ والذعر — ولو انهارت العملية نفسها زال الكائن بزوال آخر مقبض
//! عليه.
//!
//! ## قيد مقيس: الميزانية **لكل اسم كائن**
//!
//! التحديد كلّه معلَّق على **الاسم** لا على التطبيق: تمرير `HARAMLITE_SLOTS_NAME`
//! باسم آخر (أو تشغيل نسخة باسم مختلف) يفتح **ميزانية ثانية كاملة** — أي
//! فتحتان إضافيتان على البطاقة نفسها. والاسم المتجاوز يكوّن **الرمزين معاً**
//! (`<name>-a` و`<name>-b`) فلا تختلط ميزانيته بغيرها.
//!
//! ## ما لا يفعله هذا الملف (بصراحة)
//!
//! * **لا يقتل شجرة العمليات** عند الإلغاء: `cancel_job` يضبط رمز إلغاء
//!   **لكل مهمّة** فقط، ولا مسار إنتاجي يقرأه في م١ — بند م٢ هو الذي سيقرأه
//!   ويقتل الشجرة. فحتى الآن الإلغاء الفعلي يمرّ بالعلم العام القائم
//!   (`AppState::cancel_flag`) كما كان.
//! * **سقف الكائن لا يُعاد ضبطه على عملية تعمل**: الرمزان سعتهما 1 دائماً،
//!   فإعداد هذه العملية (`set_limit`) يغيّر **ما تأخذه مهامّها الجديدة**
//!   (رمزاً أو رمزين) ولا يمسّ مهاماً جارية ولا كائناً قائماً — وهذا هو
//!   المضمون الدقيق لـ«الإعداد حيّ»: يُطبَّق على المهامّ الجديدة بلا إعادة
//!   تشغيل، ولا يُقاطع الجاري.
//! * **العدّاد لا يُستعاد بموت العملية إن بقي مقبض آخر مفتوحاً**: كائن النواة
//!   يُدمَّر بزوال **آخر** مقبض. فإن ماتت عملية ماسكة لفتحة وبقيت أخرى تحمل
//!   مقبضاً للكائن نفسه، بقيت الفتحة محسوبة عليها. (مقيس في
//!   `a_dead_process_slots_are_reusable_once_its_last_handle_is_gone`.)

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::pipeline::{self, Mode, OutKind, PipelineOutput};

// ───────────────────────────── الاسم والسقف ─────────────────────────────

/// اسم جسم النواة الافتراضي. نطاق `Global\` مقصود: الفتحات تُحجز **عبر
/// العمليات** لا عبر الخيوط، ومسار CLI عملية أخرى.
pub const DEFAULT_NAME: &str = r"Global\HaramLite-Separation-Slots";

/// متغيّر البيئة الذي يتجاوز الاسم — للاختبار أساساً: اسم فريد لكل اختبار
/// فلا يتنازع الاختبار مع تطبيق المالك العامل (وهو شرط صريح في التكليف).
pub const ENV_NAME: &str = "HARAMLITE_SLOTS_NAME";

/// السقف المطلق لعدد الفصول المتزامنة على الجهاز.
///
/// **لماذا 2 لا أكثر**: قياس `nvidia-smi` على بطاقة المالك (RTX 3070 ·
/// 8192 MiB) — فصلان متزامنان بلغا ذروة **7947 من 8192 MiB (97%)** والهامش
/// **245 MiB** فقط، وفصل واحد ≈ 3732 MiB، ونموّ `BFCArena for Cuda` ≈ 2.28 GB
/// لكل جلسة. فالثالث يُنفق هامشاً غير موجود. والسقف حدّ **بطاقة** لا تفضيل
/// (التفصيل والطريقة في رأس الملف).
pub const MAX_LIMIT: u32 = 2;

/// عدد **الرموز** في زوج السيمافورات المسمّاة: رمز لكل فتحة يسمح بها السقف.
const TOKENS: usize = MAX_LIMIT as usize;

/// حسّاس بنيوي: تصميم الزوج يرمّز **سقفاً = 2** وحده.
///
/// مهمّة بسقف `n` تأخذ `MAX_LIMIT + 1 - n` رمزاً؛ وسقف 1 تعني «كل الرموز»
/// فلا تُنفَّذ إلا بـ`WaitForMultipleObjects(bWaitAll = TRUE)`. أما «k من n»
/// لـ`1 < k < n` فلا تُعبَّر بها نداءً واحداً. فرفع `MAX_LIMIT` بلا إعادة
/// تصميم **يفتح ثغرة في ضمان ب١** ⇒ يُمنع عند التصريف لا في التعليق.
const _: () = assert!(
    MAX_LIMIT == 2,
    "زوج الرموز يرمّز سقفاً = 2 فقط؛ رفع MAX_LIMIT يحتاج إعادة تصميم (k من n)"
);

/// القيمة الافتراضية لإعداد `max_concurrent_jobs` (وهي أيضاً سقف العملية
/// إذا لم يُطبَّق أي إعداد: CLI مثلاً).
///
/// **الافتراضي 1 لا 2** — قرار المالك في جولة م١ بعد قياس الهامش: فصلان
/// متزامنان بلغا ذروة **7947 من 8192 MiB (هامش 245 MiB)** في أسوأ ما قيس،
/// فالسقف 2 يبقى متاحاً لمن يطلبه صراحةً، والافتراضيّ يقف عند الطرف الآمن.
/// (الأساس والطريقة والقياس الثاني في رأس الملف.)
pub const DEFAULT_LIMIT: u32 = 1;

/// أقصى انتظار لفتحة قبل الخطأ الصريح — **لا انتظار أبدي**: تشابك عمليتين
/// تنتظران إلى الأبد أسوأ من خطأ يقول للمستخدم ما جرى.
pub const DEFAULT_WAIT: Duration = Duration::from_secs(30 * 60);

/// قصّ ما خرج عن المدى المسموح (1..=MAX_LIMIT). الصفر يُرفع إلى 1 لأن سقفاً
/// صفرياً يعني انتظاراً أبدياً لا تعطيلاً.
pub fn clamp_limit(n: u32) -> u32 {
    n.clamp(1, MAX_LIMIT)
}

/// **كم رمزاً تأخذ مهمّة بسقف `limit`** من زوج الرموز.
///
/// سقف `MAX_LIMIT` ⇒ رمز واحد (فتحتان متزامنتان)، وسقف 1 ⇒ الرمزان معاً
/// (حصرية فعلية: لا يبقى رمز لغيرهما). والصيغة تُبقي الدلالة صريحة عند قراءة
/// السقف، والحسّاس في الأعلى يمنع سقفاً ثالثاً لا يُعبَّر عنه.
fn tokens_required(limit: u32) -> usize {
    (MAX_LIMIT + 1 - clamp_limit(limit)) as usize
}

/// نصّ خطأ المهلة — **مصدر واحد** للمنصّتين، فالاختبارات تؤكّد النصّ نفسه على
/// أي منهما.
fn timeout_message(timeout: Duration) -> String {
    format!(
        "انتهت مهلة انتظار فتحة الفصل ({:.0} دقيقة) — فصول أخرى تعمل على هذا الجهاز؛ \
         أعد المحاولة بعد انتهائها أو ارفع المهلة",
        timeout.as_secs_f64() / 60.0
    )
}

/// الاسم الفعلي: تجاوز البيئة إن وُجد نصّ غير فارغ، وإلا الافتراضي.
fn slot_name() -> String {
    match std::env::var(ENV_NAME) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => DEFAULT_NAME.to_string(),
    }
}

/// سقف هذه العملية (يضبطه `set_limit` من الإعدادات). الافتراضي `DEFAULT_LIMIT`.
static LIMIT: AtomicU32 = AtomicU32::new(DEFAULT_LIMIT);

/// يضبط السقف من الإعدادات (مقصوضاً دائماً).
pub fn set_limit(n: u32) {
    LIMIT.store(clamp_limit(n), Ordering::SeqCst);
}

/// السقف الحالي (مقصوض — لا يمكن أن يتجاوز `MAX_LIMIT` ولو عبث أحد بالذاترة).
pub fn current_limit() -> u32 {
    clamp_limit(LIMIT.load(Ordering::SeqCst))
}

// ───────────────────────────── سِجلّ المهامّ ─────────────────────────────

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

struct JobEntry {
    label: String,
    started_ms: u128,
    cancel: Arc<AtomicBool>,
}

fn registry() -> &'static Mutex<Vec<(u64, JobEntry)>> {
    static JOBS: OnceLock<Mutex<Vec<(u64, JobEntry)>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(Vec::new()))
}

fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::SeqCst)
}

/// صورة مهمّة نشطة — تُقرأ من `active_jobs()` لمن يريد عرضها أو إلغاءها.
pub struct JobInfo {
    pub id: u64,
    /// الوسم/المصدر: `"gui"` · `"cli"` · `"bridge"` · `"watch"` · `"telegram"`.
    pub label: String,
    /// طابع البدء (ميلي ثانية منذ حقبة يونكس) — يشمل زمن انتظار الفتحة.
    pub started_ms: u128,
    /// هل طُلب إلغاؤها؟ (الرمز يُضبط بـ`cancel_job`، ويقرؤه م٢.)
    pub cancelled: bool,
}

/// حارس تسجيل المهمّة: إلغاء التسجيل في `Drop` — أي عند النجاح **وعند الخطأ
/// وعند الذعر** (`Drop` يعمل أثناء فكّ المكدّس). ولا شيء هنا يفكّ الذعر ولا
/// يقفل قفلاً يُميت: القفل يُعالَج من التسمّم دائماً.
pub struct JobGuard {
    id: u64,
    label: String,
    started_ms: u128,
    cancel: Arc<AtomicBool>,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        let removed = {
            let mut jobs = registry().lock().unwrap_or_else(|p| p.into_inner());
            let before = jobs.len();
            jobs.retain(|(id, _)| *id != self.id);
            before != jobs.len()
        };
        let elapsed = now_ms().saturating_sub(self.started_ms);
        if removed {
            tracing::info!(
                target: "slots",
                "انتهت المهمة #{} ({}) بعد {elapsed}ms — أُلغيت: {}",
                self.id, self.label, self.cancel.load(Ordering::SeqCst)
            );
        } else {
            tracing::warn!(target: "slots", "المهمة #{} ({}) لم تكن مسجَّلة عند الانتهاء", self.id, self.label);
        }
    }
}

/// يسجّل مهمّة ويعيد حارساً يلغي التسجيل عند سقوطه.
fn register_job(label: &str) -> JobGuard {
    let id = next_id();
    let started_ms = now_ms();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = registry().lock().unwrap_or_else(|p| p.into_inner());
        jobs.push((
            id,
            JobEntry {
                label: label.to_string(),
                started_ms,
                cancel: cancel.clone(),
            },
        ));
    }
    tracing::info!(target: "slots", "بدأت المهمة #{id} ({label})");
    JobGuard {
        id,
        label: label.to_string(),
        started_ms,
        cancel,
    }
}

/// المهامّ النشطة الآن، مرتّبةً بمعرّفها (أي بترتيب بدئها).
pub fn active_jobs() -> Vec<JobInfo> {
    let jobs = registry().lock().unwrap_or_else(|p| p.into_inner());
    let mut out: Vec<JobInfo> = jobs
        .iter()
        .map(|(id, e)| JobInfo {
            id: *id,
            label: e.label.clone(),
            started_ms: e.started_ms,
            cancelled: e.cancel.load(Ordering::SeqCst),
        })
        .collect();
    out.sort_by_key(|j| j.id);
    out
}

/// يضبط رمز الإلغاء **لهذه المهمّة وحدها**. يعيد `false` إن لم تكن المهمّة
/// نشطة (انتهت أو معرّف خاطئ) — فلا يُدَّعى إلغاء لم يقع.
///
/// **حدّ صريح**: لا يقتل شجرة عمليات ولا يوقف `pipeline::process_file` في م١؛
/// الرمز يقرؤه بند م٢. أي أن `true` هنا تعني «سُجِّل الطلب»، لا «توقّف العمل».
pub fn cancel_job(id: u64) -> bool {
    let jobs = registry().lock().unwrap_or_else(|p| p.into_inner());
    match jobs.iter().find(|(jid, _)| *jid == id) {
        Some((_, e)) => {
            e.cancel.store(true, Ordering::SeqCst);
            tracing::warn!(target: "slots", "طُلب إلغاء المهمة #{id} ({})", e.label);
            true
        }
        None => false,
    }
}

/// يطلب إلغاء كل المهامّ النشطة (يستدعيه أمر الواجهة `cancel_process` إضافةً
/// إلى العلم العام القائم، فلا يتغيّر سلوك المستخدم: من يقرأ الرمز لم يُبنَ
/// بعد). يعيد عدد ما سُجِّل إلغاؤه.
pub fn cancel_all() -> usize {
    let jobs = active_jobs();
    if !jobs.is_empty() {
        let now = now_ms();
        let described: Vec<String> = jobs
            .iter()
            .map(|j| {
                format!(
                    "#{} {}{} (+{}ms)",
                    j.id,
                    j.label,
                    if j.cancelled {
                        " [طُلب إلغاؤها سابقاً]"
                    } else {
                        ""
                    },
                    now.saturating_sub(j.started_ms)
                )
            })
            .collect();
        tracing::info!(target: "slots", "إلغاء {} مهمّة نشطة: {}", jobs.len(), described.join(" · "));
    }
    jobs.iter().filter(|j| cancel_job(j.id)).count()
}

// ─────────────────────── الفتحة (سيمافور نواة/عملية) ───────────────────────

/// حارس فتحة. النوع يختلف بحسب المنصّة، والسلوك واحد: `Drop` يحرّر الفتحة.
#[cfg(windows)]
type SlotGuard = WinSem;
#[cfg(not(windows))]
type SlotGuard = LocalSem;

/// فشل الاكتساب: `(هل يصحّ السقوط إلى نطاق الجلسة؟, الرسالة العربية)`.
///
/// زوج لا `enum`: الفروع لا تُنشأ كلها على كل منصّة، و`enum` بفرع لا يُنشأ
/// يُنتج تحذير `dead_code` — ولا نُضيف `#[allow(dead_code)]` (ممنوع في العقد).
type AcquireFailure = (bool, String);

#[cfg(windows)]
mod kernel {
    //! **زوج سيمافورات نواة مسمّاة** — سعة كل رمز **1** دائماً.
    //!
    //! لماذا زوج لا سيمافور واحد بسعة 2: ويندوز يتجاهل السقف المطلوب في
    //! `CreateSemaphoreW` إن كان الكائن قائماً، فكانت السعة سعة **أول من
    //! أنشأ** الكائن — فطلبُ إعداد 1 يُفتح على سعة 2 ولا يحصر شيئاً (ع١).
    //! وبالزوج لا سعة متغيّرة أصلاً (1 في كل عملية)، فينتفي العطل من أصله.
    //!
    //! | سقف المهمّة | ما تأخذه | الأثر |
    //! |---|---|---|
    //! | 2 | رمز **واحد**، أيّهما (`bWaitAll = FALSE`) | مهمّتان متزامنتان |
    //! | 1 | **الرمزان معاً** (`bWaitAll = TRUE`) | حصرية: لا شيء معهما |
    //!
    //! و`bWaitAll = TRUE` **لا يجزّئ الاكتساب**: إما الرمزان وإما لا شيء — وهو
    //! ما يجعل مسار المهلة نظيفاً (لا رمز معلَّق في يد منتظر فاشل).

    use super::{timeout_message, AcquireFailure, Duration, SlotGuard, WinSem, TOKENS};
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{
        GetLastError, BOOL, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        CreateSemaphoreW, OpenSemaphoreW, ReleaseSemaphore, WaitForMultipleObjects,
        SEMAPHORE_ALL_ACCESS,
    };

    /// سعة **كل** رمز — ثابت لا يُشتقّ من الإعداد، فلا يختلف طلبان على كائن
    /// واحد (وهو جوهر إصلاح ع١).
    const TOKEN_CAP: i32 = 1;

    /// لواحق الرموز: رمز لكل فتحة. أسماء **جديدة تماماً** لا كائن قديم بها من
    /// نسخة سابقة (الاسم القديم كان بلا لاحقة) ⇒ لا يُفتح كائن موروث بسعة
    /// غير 1. (وهي خاصّة بفضاء أسماء النواة، فمحلّها هذا الوحدة.)
    const TOKEN_SUFFIX: [&str; TOKENS] = ["a", "b"];

    /// اسم **رمز** من الزوج مشتقّاً من الاسم الأساس: تجاوز البيئة
    /// (`HARAMLITE_SLOTS_NAME`) يكوّن الرمزين معاً، فلا تختلط ميزانيتان.
    fn token_name(base: &str, i: usize) -> String {
        format!("{base}-{}", TOKEN_SUFFIX[i])
    }

    /// مقابض مفتوحة في هذه العملية، بالاسم — فلا يُعاد الإنشاء مع كل مهمّة،
    /// ولا يُغلق مقبض مستعمل (الإغلاق كان سيُبطل الكائن إن كان آخر مقبض).
    fn cache() -> &'static Mutex<HashMap<String, isize>> {
        static CACHE: OnceLock<Mutex<HashMap<String, isize>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// يفتح رمزاً قائماً، وإلا يُنشئه بسعة 1.
    fn token_handle(name: &str) -> Result<isize, AcquireFailure> {
        let mut map = cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(h) = map.get(name) {
            return Ok(*h);
        }
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // `OpenSemaphoreW` أولاً: العملية الثانية تجد رمز الأولى فلا تُنشئ
        // ثانياً. والسعة **1 في الحالتين**، فلا يبقى لـ«سقف أول من أنشأ» محلّ.
        let mut handle = unsafe { OpenSemaphoreW(SEMAPHORE_ALL_ACCESS, 0, wide.as_ptr()) };
        let created = handle.is_null();
        if created {
            handle =
                unsafe { CreateSemaphoreW(std::ptr::null(), TOKEN_CAP, TOKEN_CAP, wide.as_ptr()) };
        }
        if handle.is_null() {
            let code = unsafe { GetLastError() };
            return Err((
                true,
                format!("تعذر إنشاء/فتح سيمافور الفصل «{name}» (رمز Win32 {code})"),
            ));
        }
        if created {
            // `GetLastError` فوراً بعد `CreateSemaphoreW` (لا نداء Win32 بينهما).
            let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
            if existed {
                tracing::debug!(target: "slots", "رمز الفصل «{name}» كان قائماً — سعته 1 في كل الأحوال");
            } else {
                tracing::info!(target: "slots", "أُنشئ رمز الفصل «{name}» بسعة 1");
            }
        }
        let raw = handle as isize;
        map.insert(name.to_string(), raw);
        Ok(raw)
    }

    /// يكتسب `tokens` رمزاً من رمزَي الاسم الأساس، بمهلة.
    pub(super) fn acquire(
        base: &str,
        tokens: usize,
        timeout: Duration,
    ) -> Result<SlotGuard, AcquireFailure> {
        let handles = [
            token_handle(&token_name(base, 0))?,
            token_handle(&token_name(base, 1))?,
        ];
        // الرمزان معاً = حصرية (سقف 1). وحسّاس التصريف يضمن ألّا يكون الطلب
        // إلا 1 أو الرمزين، فلا حاجة إلى «k من n» غير قابل للتنفيذ.
        let all = tokens >= TOKENS;
        let raw: [HANDLE; TOKENS] = [handles[0] as _, handles[1] as _];
        // `as_millis` u128 ⇒ قصّ إلى u32-1: `INFINITE` (0xFFFFFFFF) لا يُستعمل
        // أبداً، فالمهمّة لا تنتظر أبداً حتى لو أُعطي مهلة هائلة.
        let ms = timeout.as_millis().min((u32::MAX - 1) as u128) as u32;
        let rc = unsafe { WaitForMultipleObjects(TOKENS as u32, raw.as_ptr(), all as BOOL, ms) };
        if rc == WAIT_OBJECT_0 {
            // `bWaitAll = TRUE`: الرمزان. و`FALSE`: **الأول وحده** (أدنى فهرسةً
            // صار متاحاً) — ويندوز لا يكتسب إلا الرمز الذي أُعيد فهرسه.
            return Ok(if all {
                WinSem::all(handles)
            } else {
                WinSem::first(handles)
            });
        }
        if !all && rc == WAIT_OBJECT_0 + 1 {
            return Ok(WinSem::second(handles));
        }
        if rc == WAIT_TIMEOUT {
            // **لا شيء أُخذ**: `TRUE` لا يجزّئ الاكتساب، و`FALSE` لا يكتسب عند
            // المهلة ⇒ الزوج كما كان، ومهمّة تالية تجد ما كانت تجده.
            return Err((false, timeout_message(timeout)));
        }
        Err((false, format!("فشل انتظار فتحة الفصل (رمز Win32 {rc})")))
    }

    pub(super) fn release(handle: isize) {
        let ok = unsafe { ReleaseSemaphore(handle as _, 1, std::ptr::null_mut()) };
        if ok == 0 {
            tracing::warn!(
                target: "slots",
                "تعذر تحرير فتحة الفصل (رمز Win32 {})",
                unsafe { GetLastError() }
            );
        }
    }
}

/// حارس الفتحة على ويندوز: مقابض رمزَي النواة + **ما أُخذ بالضبط**.
#[cfg(windows)]
struct WinSem {
    /// `HANDLE` مؤشّر خام (`*mut c_void`) لا يقبل `Send`/`Sync` تلقائياً.
    /// نخزّنه `isize` ونتحوّل عند النداء: مقابض النواة صالحة من أي خيط في
    /// العملية (ضمان Win32)، والمقبض لا يُغلق أبداً فلا إغلاق مزدوج.
    handles: [isize; TOKENS],
    /// ما أُخذ: رمز واحد (سقف 2) أو الرمزان (سقف 1). التحرير **بقدره**.
    held: [bool; TOKENS],
}

#[cfg(windows)]
impl WinSem {
    fn first(handles: [isize; TOKENS]) -> Self {
        Self {
            handles,
            held: [true, false],
        }
    }

    fn second(handles: [isize; TOKENS]) -> Self {
        Self {
            handles,
            held: [false, true],
        }
    }

    fn all(handles: [isize; TOKENS]) -> Self {
        Self {
            handles,
            held: [true, true],
        }
    }
}

#[cfg(windows)]
impl Drop for WinSem {
    fn drop(&mut self) {
        // تحرير **ما أُخذ بالضبط**: تحرير غير مأخوذ يزيد عدّاد رمز فوق سعته
        // (فيفتح فتحة ثالثة)، وتفويت مأخوذ يُجمّد فتحة إلى الأبد.
        for i in 0..TOKENS {
            if self.held[i] {
                kernel::release(self.handles[i]);
            }
        }
    }
}

#[cfg(not(windows))]
mod local {
    //! انحدار غير ويندوز: **زوج رموز داخل العملية** (مصفوفة + `Condvar`)
    //! مفتاحه الاسم — بنفس دلالة الزوج في النواة: الرمز لأيّ مهمّة، والرمزان
    //! للحصرية، والاكتساب **لا يُجزَّأ** (كـ`bWaitAll`). الغرض أن يبقى
    //! `cargo test` ممكناً على أي منصّة بنفس السلوك لا بشكل يشبهه.

    use super::{timeout_message, AcquireFailure, Duration, LocalPair, LocalSem, TOKENS};
    use std::collections::HashMap;
    use std::sync::{Arc, Condvar, Mutex, OnceLock};
    use std::time::Instant;

    fn registry() -> &'static Mutex<HashMap<String, Arc<LocalPair>>> {
        static MAP: OnceLock<Mutex<HashMap<String, Arc<LocalPair>>>> = OnceLock::new();
        MAP.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// يأخذ `n` رمزاً حرّاً (الأدنى فهرسةً أولاً) أو **لا شيء**: عند نقص رمز
    /// يُعاد ما أُخذ — فلا اكتساب جزئي، مطابقةً لـ`bWaitAll = TRUE`.
    fn take(free: &mut [bool; TOKENS], n: usize) -> Option<[bool; TOKENS]> {
        let mut taken = [false; TOKENS];
        let mut left = n;
        for i in 0..TOKENS {
            if left == 0 {
                break;
            }
            if free[i] {
                free[i] = false;
                taken[i] = true;
                left -= 1;
            }
        }
        if left == 0 {
            return Some(taken);
        }
        for i in 0..TOKENS {
            if taken[i] {
                free[i] = true;
            }
        }
        None
    }

    pub(super) fn acquire(
        name: &str,
        tokens: usize,
        timeout: Duration,
    ) -> Result<LocalSem, AcquireFailure> {
        let pair = {
            let mut map = registry().lock().unwrap_or_else(|p| p.into_inner());
            map.entry(name.to_string())
                .or_insert_with(|| {
                    Arc::new(LocalPair {
                        free: Mutex::new([true; TOKENS]),
                        cv: Condvar::new(),
                    })
                })
                .clone()
        };
        let mut free = pair.free.lock().unwrap_or_else(|p| p.into_inner());
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(taken) = take(&mut free, tokens) {
                // القفل يُسقط **قبل** نقل `pair` إلى الحارس: `MutexGuard` يستعير
                // من `pair.free`، فنقله وهو حيّ خطأ تصريف لا يظهر إلا على منصّة
                // غير ويندوز (اكتُشف بإجبار فرع `cfg(not(windows))` على التصريف).
                drop(free);
                return Ok(LocalSem { pair, taken });
            }
            let now = Instant::now();
            if now >= deadline {
                return Err((false, timeout_message(timeout)));
            }
            // الاستيقاظ الكاذب والمهلة يُعاد فحصهما في رأس الحلقة، فلا مسار
            // يُعلن فشلاً ورمزٌ حرّ.
            let (guard, _) = pair
                .cv
                .wait_timeout(free, deadline - now)
                .unwrap_or_else(|p| p.into_inner());
            free = guard;
        }
    }

    /// تحرير **ما أُخذ بالضبط**، ثم `notify_all`.
    ///
    /// `notify_all` لا `notify_one` **عمداً**: حاصرٌ يحتاج الرمزين قد يُوقَظ
    /// أولاً برمز واحد فيعود إلى الانتظار، ولو كان الإيقاظ واحداً لنام من
    /// يستطيع الأخذ ⇒ **ضياع إيقاظ** لا مجرّد بطء.
    pub(super) fn release(pair: &Arc<LocalPair>, taken: [bool; TOKENS]) {
        let mut free = pair.free.lock().unwrap_or_else(|p| p.into_inner());
        for i in 0..TOKENS {
            if taken[i] {
                free[i] = true;
            }
        }
        pair.cv.notify_all();
    }
}

/// زوج الرموز في انحدار غير ويندوز: `true` = الرمز حرّ.
#[cfg(not(windows))]
struct LocalPair {
    free: Mutex<[bool; TOKENS]>,
    cv: std::sync::Condvar,
}

#[cfg(not(windows))]
struct LocalSem {
    pair: Arc<LocalPair>,
    /// ما أُخذ بالضبط (مطابقةً لدلالة `WinSem`).
    taken: [bool; TOKENS],
}

#[cfg(not(windows))]
impl Drop for LocalSem {
    fn drop(&mut self) {
        local::release(&self.pair, self.taken);
    }
}

/// فتحة في نطاق الجلسة (بلا بادئة `Global\`) — بديل إن رُفض النطاق العام.
fn session_local(name: &str) -> Option<String> {
    name.strip_prefix(r"Global\")
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// يكتسب فتحة بالاسم المعطى: يفتح رمزَي النواة أو يُنشئهما، ثم ينتظر بمهلة.
///
/// عدد الرموز يُشتقّ من السقف مرة واحدة هنا (`tokens_required`) فيسري الأمر
/// نفسه على المنصّتين.
///
/// **السقوط إلى نطاق الجلسة**: إنشاء كائن في `Global\` يحتاج
/// `SeCreateGlobalPrivilege` وهي ليست مضمونة لكل مستخدم. فإن رُفض الإنشاء
/// (وليس الانتظار) أُعيدت المحاولة باسم بلا البادئة — وهو نطاق الجلسة، وهو
/// المدى الذي تتنازع فيه عملياتنا فعلاً (الواجهة وخدمة المراقبة والجسر في
/// العملية نفسها، وCLI في الجلسة نفسها). فلا يتحوّل رفضُ الصلاحية إلى تعطيل
/// الفصل كله. واللواحق تُضاف **بعد** نزع البادئة، فالرمزين هما الرمزان في
/// النطاقين.
fn acquire_named(name: &str, limit: u32, timeout: Duration) -> Result<SlotGuard, String> {
    let tokens = tokens_required(limit);
    match platform_acquire(name, tokens, timeout) {
        Ok(guard) => Ok(guard),
        Err((retry_local, why)) => {
            if !retry_local {
                return Err(why);
            }
            match session_local(name) {
                Some(local) => {
                    tracing::warn!(
                        target: "slots",
                        "{why} — السقوط إلى نطاق الجلسة «{local}»"
                    );
                    platform_acquire(&local, tokens, timeout).map_err(|(_, e)| e)
                }
                None => Err(why),
            }
        }
    }
}

#[cfg(windows)]
fn platform_acquire(
    name: &str,
    tokens: usize,
    timeout: Duration,
) -> Result<SlotGuard, AcquireFailure> {
    kernel::acquire(name, tokens, timeout)
}

#[cfg(not(windows))]
fn platform_acquire(
    name: &str,
    tokens: usize,
    timeout: Duration,
) -> Result<SlotGuard, AcquireFailure> {
    local::acquire(name, tokens, timeout)
}

// ───────────────────────── مدخل الفصل الواحد ─────────────────────────

/// **النواة الوحيدة**: سِجلّ المهمّة + فتحة الفصل + الجسم، في نقطة واحدة
/// تمرّ منها كل مهمّة فصل. الترتيب مقصود: التسجيل قبل الانتظار (فتظهر
/// المهمّة المنتظرة في السِجلّ لا المخدومة وحدها)، والتحرير بترتيب عكسي
/// (الفتحة تُحرَّر قبل إلغاء التسجيل، فلا تبقى مهمّة «نشطة» بلا فتحة).
///
/// والسقف يُقرأ **لحظة الطلب** (ب٣): تغيير الإعداد في الإعدادات يغيّر ما تأخذه
/// المهامّ **الجديدة** بلا إعادة تشغيل، ولا يمسّ مهمّة جارية (الرموز المأخوذة
/// تبقى بيد صاحبها حتى ينتهي).
fn run_registered<T>(
    slot_name: &str,
    label: &str,
    body: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    run_registered_with(slot_name, label, current_limit(), body)
}

/// نفس النواة بسقف صريح — يفصل «ما تأخذه هذه المهمّة» عن الحالة العامة
/// (`LIMIT`)، فيُقاس سقف بعينه بلا لمس إعداد العملية كلها (والاختبارات تحتاجه).
fn run_registered_with<T>(
    slot_name: &str,
    label: &str,
    limit: u32,
    body: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _job = register_job(label);
    // سطر قبل الانتظار: الانتظار كان صامتاً تماماً في السجلّ (قاس المدقّق
    // 342 ثانية بلا أثر)، فلا يُعرف أمهمّة تنتظر أم تعمل.
    tracing::info!(target: "slots", "المهمّة ({label}) تنتظر فتحة فصل (سقف {limit})…");
    let _slot = acquire_named(slot_name, limit, DEFAULT_WAIT)?;
    body()
}

/// فصل ملف عبر `pipeline::process_file` تحت فتحة جهاز — **المدخل الواحد**.
///
/// `label` هو وسم المصدر (`"gui"` · `"cli"` · `"bridge"` · `"watch"` ·
/// `"telegram"`) ويظهر في سِجلّ المهامّ. والوسائط بعدها بنفس ترتيب
/// `pipeline::process_file` حرفياً، فلا يتغيّر شيء في `progress`/`stage`.
///
/// الخطأ `String` لا `PipelineError`: الخطأ صار من مصدرين (الفتحة والمحرّك)،
/// وكل المواضع الخمسة تحوّله إلى نصّ أصلاً.
pub fn run_separation(
    label: &str,
    input: &Path,
    out_dir: &Path,
    mode: Mode,
    kind: OutKind,
    keep_instrumental: bool,
    keep_vocals: bool,
    use_cuda: bool,
    preview_seconds: Option<f32>,
    progress: &dyn Fn(f32) -> bool,
    stage: &dyn Fn(&str, f32),
) -> Result<PipelineOutput, String> {
    run_separation_as(
        &slot_name(),
        label,
        input,
        out_dir,
        mode,
        kind,
        keep_instrumental,
        keep_vocals,
        use_cuda,
        preview_seconds,
        progress,
        stage,
    )
}

/// نفس `run_separation` باسم فتحة صريح — للاختبار: كل اختبار باسمه الفريد فلا
/// يتنازع مع تطبيق المالك العامل، ولا ينتظر فتحات محجوزة في الجهاز.
fn run_separation_as(
    slot_name: &str,
    label: &str,
    input: &Path,
    out_dir: &Path,
    mode: Mode,
    kind: OutKind,
    keep_instrumental: bool,
    keep_vocals: bool,
    use_cuda: bool,
    preview_seconds: Option<f32>,
    progress: &dyn Fn(f32) -> bool,
    stage: &dyn Fn(&str, f32),
) -> Result<PipelineOutput, String> {
    run_registered(slot_name, label, || {
        pipeline::process_file(
            input,
            out_dir,
            mode,
            kind,
            keep_instrumental,
            keep_vocals,
            use_cuda,
            preview_seconds,
            progress,
            stage,
        )
        .map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    /// اسم فريد لكل اختبار: لا تنازع مع تطبيق المالك ولا مع اختبار آخر.
    fn unique_name(tag: &str) -> String {
        format!(
            r"Global\HaramLite-Test-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        )
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hl_slots_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// أقصى تداخل من أزواج (طابع زمني, +1 بداية/−1 نهاية).
    ///
    /// عند تساوي الطابع: **النهاية قبل البداية** — نهاية في اللحظة نفسها
    /// ليست تداخلاً، وإلا عُدّ التسليم المتعاقب تزامناً كاذباً.
    fn max_overlap(events: &[(u128, i32)]) -> usize {
        let mut ev = events.to_vec();
        ev.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let (mut cur, mut peak) = (0i32, 0i32);
        for (_, delta) in ev {
            cur += delta;
            peak = peak.max(cur);
        }
        peak.max(0) as usize
    }

    /// الاختبارات التي تلمس السِجلّ العامّ تتسلسل: السِجلّ **واحد للعملية**،
    /// فلو تشابه اختباران لصار القياس تابعاً لترتيب الخيوط لا للسلوك.
    fn registry_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ── القيمة والاسم (دوالّ نقية) ─────────────────────────────────────

    #[test]
    fn the_limit_is_clamped_to_the_card_ceiling() {
        // `current_limit()` حالة عامّة للعملية: القفل يمنع أن يقرأها هذا
        // الاختبار في اللحظة التي يغيّرها فيها اختبار آخر (ب٣ يقيس تغييرها حيّاً).
        let _lock = registry_lock();
        assert_eq!(clamp_limit(1), 1, "الحدّ الأدنى المسموح");
        assert_eq!(clamp_limit(2), MAX_LIMIT, "السقف المسموح");
        assert_eq!(clamp_limit(0), 1, "الصفر يُرفع إلى 1 لا يُترك انتظاراً أبدياً");
        assert_eq!(clamp_limit(9), MAX_LIMIT, "ما خرج يُقصّ إلى السقف");
        assert_eq!(current_limit(), DEFAULT_LIMIT, "بلا إعداد: الافتراضي");
    }

    #[test]
    fn the_default_name_is_the_global_one_and_the_env_overrides_it() {
        // لا يضبط أي اختبار هذا المتغيّر (ولا يلمس البيئة أصلاً) فالقراءة آمنة.
        match std::env::var(ENV_NAME) {
            Ok(v) if !v.trim().is_empty() => assert_eq!(slot_name(), v),
            _ => assert_eq!(slot_name(), DEFAULT_NAME),
        }
        assert!(DEFAULT_NAME.starts_with(r"Global\"), "النطاق يعبر العمليات");
        assert_eq!(
            session_local(DEFAULT_NAME).as_deref(),
            Some("HaramLite-Separation-Slots"),
            "بديل الجلسة يسقط البادئة وحدها"
        );
        assert_eq!(session_local("HaramLite-No-Prefix"), None);
        assert_eq!(session_local(r"Global\"), None, "اسم فارغ ليس بديلاً");
    }

    // ── داخل العملية: 3 خيوط والسقف 2 ⇒ أقصى تزامن مقيس = 2 ─────────────

    const HOLD_MS: u64 = 400;

    #[test]
    fn three_threads_never_exceed_the_cap() {
        let _lock = registry_lock();
        let name = unique_name("inproc");
        let events: Arc<Mutex<Vec<(u128, i32)>>> = Arc::new(Mutex::new(Vec::new()));
        let mut threads = Vec::new();
        for _ in 0..3 {
            let name = name.clone();
            let events = events.clone();
            threads.push(std::thread::spawn(move || {
                run_registered(&name, "inproc", || {
                    events.lock().unwrap().push((now_ms(), 1));
                    std::thread::sleep(Duration::from_millis(HOLD_MS));
                    events.lock().unwrap().push((now_ms(), -1));
                    Ok(())
                })
                .expect("فتحة متاحة خلال المهلة");
            }));
        }
        for t in threads {
            t.join().expect("لا ذعر في الخيوط");
        }
        let events = events.lock().unwrap().clone();
        assert_eq!(events.len(), 6, "ثلاث بدايات وثلاث نهايات");
        let peak = max_overlap(&events);
        // يُطبع دائماً كي يراه من يُشغّل `--nocapture`، وليبقى القياس قابلاً
        // لإعادة الإنتاج لا مجرّد كلمة «نجح».
        eprintln!(
            "م١/داخل العملية: أقصى تزامن مُقاس = {peak} (السقف {}) — الأحداث: {events:?}",
            current_limit()
        );
        assert_eq!(
            peak, 2,
            "أقصى تزامن مُقاس يجب أن يساوي السقف (2)، وقياسه {peak} — الأحداث: {events:?}"
        );
    }

    /// **ب٣ — الإعداد حيّ**: يُطبَّق على المهامّ **الجديدة** بلا إعادة تشغيل،
    /// ولا يقاطع الجارية.
    ///
    /// القياس: مهمّة تعمل بسقف 2 (تحمل رمزاً واحداً)، ثم يُغيَّر الإعداد إلى 1
    /// **وهي تعمل**، ثم تُطلب مهمّة جديدة بالمسار الإنتاجي (`run_registered`
    /// يقرأ السقف لحظة الطلب) على الاسم نفسه ⇒ عليها أن تنتظر انتهاء الجارية
    /// (لأنها تحتاج **الرمزين** بسقف 1)، والجارية تُكمل مدّتها كاملة ثم تحرّر.
    /// فلا إعادة تشغيل، ولا مقاطعة، والسقف الجديد سارٍ.
    ///
    /// (`set_limit` حالة عامّة للعملية، والاختبار يعيدها إلى أصلها **قبل** أي
    /// حكم — وكل اختبار يقرأ `current_limit()` يأخذ `registry_lock` نفسه.)
    #[test]
    fn a_new_setting_applies_to_new_jobs_without_interrupting_running_ones() {
        let _lock = registry_lock();
        let name = unique_name("live-limit");
        let events: Arc<Mutex<Vec<TracedEvent>>> = Arc::new(Mutex::new(Vec::new()));

        // الجارية: سقف السقف الكامل ⇒ رمز واحد، وتبقى حيّة `HOLD_MS`.
        let holder = {
            let name = name.clone();
            let events = events.clone();
            std::thread::spawn(move || {
                run_registered_with(&name, "holder", MAX_LIMIT, || {
                    events.lock().unwrap().push((0, now_ms(), 1));
                    std::thread::sleep(Duration::from_millis(HOLD_MS));
                    events.lock().unwrap().push((0, now_ms(), -1));
                    Ok(())
                })
                .expect("الجارية أخذت رمزاً");
            })
        };
        // لا يُقاس الترتيب على مصادفة جدولة: ننتظر حتى تحمل الجارية رمزها فعلاً.
        let started = std::time::Instant::now();
        while events.lock().unwrap().is_empty() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "الجارية لم تبدأ"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        // الإعداد يتغيّر **والجارية تعمل** — بلا إعادة تشغيل أي شيء.
        set_limit(1);
        assert_eq!(current_limit(), 1, "الإعداد الحيّ انضبط");

        // مهمّة جديدة بالمسار الإنتاجي: تقرأ سقف 1 ⇒ تحتاج الرمزين.
        let newcomer = {
            let name = name.clone();
            let events = events.clone();
            std::thread::spawn(move || {
                run_registered(&name, "newcomer", || {
                    events.lock().unwrap().push((1, now_ms(), 1));
                    std::thread::sleep(Duration::from_millis(HOLD_MS));
                    events.lock().unwrap().push((1, now_ms(), -1));
                    Ok(())
                })
                .expect("الجديدة أخذت الفتحة بعد انتهاء الجارية");
            })
        };
        holder.join().expect("لا ذعر في الجارية");
        newcomer.join().expect("لا ذعر في الجديدة");
        set_limit(DEFAULT_LIMIT); // الإعداد العامّ يعود إلى أصله قبل أي حكم

        let events = events.lock().unwrap().clone();
        let spans = spans(&events);
        assert_eq!(spans.len(), 2, "فترتان (جارية وجديدة): {spans:?}");
        let h = spans.iter().find(|(id, _, _)| *id == 0).expect("الجارية");
        let n = spans.iter().find(|(id, _, _)| *id == 1).expect("الجديدة");
        assert_eq!(
            overlap_ms((h.1, h.2), (n.1, n.2)),
            0,
            "الجديدة تقاطعت مع الجارية — إما أن السقف الجديد لم يُطبَّق وإما أن \
             الجارية قُوطعت: {spans:?}"
        );
        assert!(
            h.2 - h.1 >= (HOLD_MS - 20) as u128,
            "الجارية أكملت مدّتها كاملة (لم تُقاطَع): {spans:?}"
        );
        eprintln!("ب٣/سقف حيّ: الجارية {h:?} ثم الجديدة {n:?} — بلا تقاطع وبلا مقاطعة");
    }

    // ── عبر العمليات: 3 عمليات مساعدة ⇒ أقصى تداخل مقيس = 2 ─────────────

    const HELPER_MODE: &str = "HARAMLITE_SLOT_HELPER";
    const HELPER_SLOT: &str = "HARAMLITE_SLOT_HELPER_SLOT";
    const HELPER_LOG: &str = "HARAMLITE_SLOT_HELPER_LOG";
    const HELPER_READY: &str = "HARAMLITE_SLOT_HELPER_READY";
    const HELPER_ID: &str = "HARAMLITE_SLOT_HELPER_ID";
    /// سقف المساعد (اختياري: الافتراضي `DEFAULT_LIMIT`) — لقياس خليط الإعدادات.
    const HELPER_LIMIT: &str = "HARAMLITE_SLOT_HELPER_LIMIT";
    /// تأخير المساعد بعد الحاجز بالملّي ثانية (اختياري: 0) — يُرتَّب به الطلب
    /// فيُقاس «الحصرية لا تتقاطع» بضابط موجب في اللحظة نفسها.
    const HELPER_DELAY_MS: &str = "HARAMLITE_SLOT_HELPER_DELAY_MS";
    const HELPERS: usize = 3;

    // ── أدوات قياس التقاطع (تُستعمل داخل العملية وعبرها) ────────────────

    /// حدث تتبّع موسوم بمعرّف المهمّة: `(المعرّف, الطابع الزمني, +1 بداية/−1 نهاية)`.
    type TracedEvent = (usize, u128, i32);

    /// يقرأ سطور التتبّع `{id} START|END {ts}` إلى أحداث موسومة.
    fn parse_trace(raw: &str) -> Vec<TracedEvent> {
        let mut out = Vec::new();
        for line in raw.lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            assert_eq!(f.len(), 3, "سطر تتبّع غير سليم (تداخل كتابة؟): {line:?}");
            let id: usize = f[0]
                .parse()
                .unwrap_or_else(|_| panic!("معرّف غير رقمي: {line:?}"));
            let ts: u128 = f[2]
                .parse()
                .unwrap_or_else(|_| panic!("طابع غير رقمي: {line:?}"));
            match f[1] {
                "START" => out.push((id, ts, 1)),
                "END" => out.push((id, ts, -1)),
                other => panic!("حدث غير معروف {other:?} في {line:?}"),
            }
        }
        out
    }

    /// الأحداث بلا وسوم — لقياس الذروة بـ`max_overlap`.
    fn deltas(events: &[TracedEvent]) -> Vec<(u128, i32)> {
        events.iter().map(|(_, ts, d)| (*ts, *d)).collect()
    }

    /// فترات المهامّ: `(المعرّف, البداية, النهاية)`. وبداية بلا نهاية (أو
    /// العكس) تُسقط الاختبار: سطر ناقص لا يُقرأ فترةً صفرية تمرّ صامتة.
    fn spans(events: &[TracedEvent]) -> Vec<(usize, u128, u128)> {
        let mut starts: Vec<(usize, u128)> = Vec::new();
        let mut out = Vec::new();
        for (id, ts, d) in events {
            if *d > 0 {
                starts.push((*id, *ts));
            } else {
                let pos = starts
                    .iter()
                    .position(|(sid, _)| sid == id)
                    .unwrap_or_else(|| panic!("نهاية بلا بداية للمهمّة {id}"));
                let (_, start) = starts.remove(pos);
                out.push((*id, start, *ts));
            }
        }
        assert!(starts.is_empty(), "بدايات بلا نهايات: {starts:?}");
        out
    }

    /// تداخل فترتين بالملّي ثانية — و**النهاية قبل البداية** عند تساوي الطابع
    /// (اتفاقية `max_overlap` نفسها: تسليم في اللحظة نفسها ليس تداخلاً).
    fn overlap_ms(a: (u128, u128), b: (u128, u128)) -> u128 {
        a.1.min(b.1).saturating_sub(a.0.max(b.0))
    }

    /// يحكم على قياس واحد بثلاثة شروط معاً:
    ///   • **ب١**: الذروة لا تتجاوز `MAX_LIMIT`.
    ///   • **ب٢**: كل مهمّة بسقف 1 **لا تتقاطع** مع أي مهمّة أخرى.
    ///   • **ضابط موجب**: مهمّتا السقف `MAX_LIMIT` تتقاطعان فعلاً (ذروة =
    ///     `MAX_LIMIT`) — وإلا كان «لا تقاطع» نتيجة أداة عمياء لا نتيجة محدِّد.
    ///     وإن كانت الخطة حصرية كلها فالمتوقَّع ذروة = 1 (تسلسل تامّ).
    fn assert_peak_and_exclusivity(events: &[TracedEvent], plan: &[(u32, u64)], where_: &str) {
        let spans = spans(events);
        assert_eq!(
            spans.len(),
            plan.len(),
            "{where_}: فترة لكل مهمّة — الفترات: {spans:?}"
        );
        let peak = max_overlap(&deltas(events));
        eprintln!("ت٣/{where_}: أقصى تزامن مُقاس = {peak} (السقف {MAX_LIMIT}) — الفترات: {spans:?}");
        assert!(
            peak <= MAX_LIMIT as usize,
            "{where_}: الذروة {peak} تجاوزت السقف {MAX_LIMIT} — الفترات: {spans:?}"
        );

        let exclusive: Vec<usize> = plan
            .iter()
            .enumerate()
            .filter(|(_, (l, _))| *l == 1)
            .map(|(i, _)| i)
            .collect();
        assert!(
            !exclusive.is_empty(),
            "{where_}: الخطة بلا مهمّة بسقف 1 — القياس بلا موضوع"
        );
        for id in &exclusive {
            let a = spans
                .iter()
                .find(|(sid, _, _)| sid == id)
                .unwrap_or_else(|| panic!("{where_}: فترة الحصرية #{id} غائبة"));
            for (oid, s, e) in &spans {
                if oid == id {
                    continue;
                }
                assert_eq!(
                    overlap_ms((a.1, a.2), (*s, *e)),
                    0,
                    "{where_}: المهمّة بسقف 1 #{id} تقاطعت مع #{oid} — الفترات: {spans:?}"
                );
            }
        }

        let wide = plan.iter().filter(|(l, _)| *l == MAX_LIMIT).count();
        let expect = if wide >= 2 { MAX_LIMIT as usize } else { 1 };
        assert_eq!(
            peak, expect,
            "{where_}: الذروة المتوقَّعة {expect} وقياسها {peak} — الفترات: {spans:?}"
        );
    }

    /// يكتب سطراً كاملاً بنداء كتابة واحد على الملف المشترك.
    fn append_line(path: &Path, line: &str) {
        use std::io::Write;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path);
        match file {
            Ok(mut f) => {
                if let Err(e) = f.write_all(line.as_bytes()) {
                    eprintln!("helper: تعذر الكتابة في ملف التتبّع: {e}");
                }
            }
            Err(e) => eprintln!("helper: تعذر فتح ملف التتبّع: {e}"),
        }
    }

    /// **عملية مساعدة** (ليست اختباراً في الوضع العادي): تنتظر الحاجز ثم تأخذ
    /// فتحة بسقفها وتكتب بدايتها ونهايتها بطابع زمني في ملف مشترك.
    ///
    /// تُشغَّل بـ`current_exe` مع `HARAMLITE_SLOT_HELPER=1` من الاختبارات
    /// التالية؛ وفي تشغيل `cargo test` العادي تعود فوراً بلا عمل.
    ///
    /// `HARAMLITE_SLOT_HELPER_LIMIT` (سقف المهمّة) و`HARAMLITE_SLOT_HELPER_DELAY_MS`
    /// (تأخير بعد الحاجز) اختياريان: بلا ضبطهما يتصرّف المساعد كما كان.
    #[test]
    fn slot_helper_process() {
        if std::env::var(HELPER_MODE).is_err() {
            return; // لسنا في وضع المساعد
        }
        let slot = std::env::var(HELPER_SLOT).expect("اسم الفتحة");
        let log = PathBuf::from(std::env::var(HELPER_LOG).expect("ملف التتبّع"));
        let ready = PathBuf::from(std::env::var(HELPER_READY).expect("مجلد الحاجز"));
        let id = std::env::var(HELPER_ID).expect("معرّف المساعد");
        let limit: u32 = std::env::var(HELPER_LIMIT)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_LIMIT);
        let delay_ms: u64 = std::env::var(HELPER_DELAY_MS)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        // حاجز: كل المساعدين يبدأون الطلب في اللحظة نفسها تقريباً، وإلا كان
        // «عدم التداخل» أثراً من تباعد الإقلاع لا من المحدِّد.
        std::fs::write(ready.join(format!("h{id}")), b"1").expect("ملف الحاجز");
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while std::fs::read_dir(&ready).map(|d| d.count()).unwrap_or(0) < HELPERS {
            assert!(
                std::time::Instant::now() < deadline,
                "انتهت مهلة الحاجز: لم يصل كل المساعدين"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        // التأخير **بعد** الحاجز مقصود: يُرتَّب الطلب فيُقاس في اللحظة نفسها
        // أن مهمّتَي السقف الكامل تتقاطعان وأن الحصرية لا تتقاطع (ضابط موجب).
        std::thread::sleep(Duration::from_millis(delay_ms));

        run_registered_with(&slot, "helper", limit, || {
            append_line(&log, &format!("{id} START {}\n", now_ms()));
            std::thread::sleep(Duration::from_millis(HOLD_MS));
            append_line(&log, &format!("{id} END {}\n", now_ms()));
            Ok(())
        })
        .expect("المساعد أخذ فتحة خلال المهلة");
    }

    /// يُطلق `HELPERS` عملية مساعدة — **باسم فتحة واحد** للجميع (وهو جوهر
    /// القياس: بأسماء مختلفة لما تنازعوا على زوج رموز واحد) — لكلٍّ سقفها
    /// وتأخيرها، ثم ينتظرها ويعيد نصّ سجلّ التتبّع.
    fn run_three_helpers(tag: &str, plan: [(u32, u64); HELPERS]) -> String {
        let dir = tmp_dir(tag);
        let log = dir.join("trace.log");
        let ready = dir.join("ready");
        std::fs::create_dir_all(&ready).unwrap();

        let exe = std::env::current_exe().expect("مسار ثنائي الاختبار");
        let slot = unique_name(tag);
        let mut children = Vec::new();
        for (i, (limit, delay)) in plan.iter().enumerate() {
            let child = Command::new(&exe)
                .args([
                    "slots::tests::slot_helper_process",
                    "--exact",
                    "--nocapture",
                ])
                .env(HELPER_MODE, "1")
                .env(HELPER_SLOT, &slot)
                .env(HELPER_LOG, &log)
                .env(HELPER_READY, &ready)
                .env(HELPER_ID, i.to_string())
                .env(HELPER_LIMIT, limit.to_string())
                .env(HELPER_DELAY_MS, delay.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("إطلاق عملية مساعدة");
            children.push(child);
        }
        let mut failed = Vec::new();
        for (i, mut c) in children.into_iter().enumerate() {
            let status = c.wait().expect("انتظار المساعد");
            if !status.success() {
                failed.push(format!("المساعد {i}: {status}"));
            }
        }
        // السجلّ يُقرأ **قبل** الحكم كي يظهر في رسالة الفشل لا أن يضيع.
        let raw = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(
            failed.is_empty(),
            "{} — سجلّ التتبّع:\n{raw}",
            failed.join(" · ")
        );
        let _ = std::fs::remove_dir_all(&dir);
        raw
    }

    #[test]
    fn three_helper_processes_never_overlap_more_than_the_cap() {
        if std::env::var(HELPER_MODE).is_ok() {
            return; // لا نُعيد إطلاق المساعدين من داخل مساعد
        }
        let _lock = registry_lock();
        // السقف الافتراضي للثلاثة (بلا ضبط `HELPER_LIMIT`) وبلا تأخير.
        let raw = run_three_helpers("xproc", [(DEFAULT_LIMIT, 0); HELPERS]);
        let events = parse_trace(&raw);
        let (started, ended) = (
            events.iter().filter(|(_, _, d)| *d > 0).count(),
            events.iter().filter(|(_, _, d)| *d < 0).count(),
        );
        // إثبات أن القياس وقع فعلاً: 3 عمليات × (بداية+نهاية).
        assert_eq!(
            (started, ended),
            (HELPERS, HELPERS),
            "سطور التتبّع ناقصة — القياس باطل. المحتوى:\n{raw}"
        );
        let peak = max_overlap(&deltas(&events));
        // الدليل الخام: الطوابع الزمنية الحقيقية من العمليات الثلاث، لا نداء
        // API يقول «حصلت على فتحة».
        eprintln!(
            "م١/عبر العمليات: أقصى تداخل مُقاس = {peak} (السقف {}) — سطور التتبّع:\n{raw}",
            current_limit()
        );
        assert_eq!(
            peak, 2,
            "أقصى تداخل بين العمليات يجب أن يساوي السقف (2)، وقياسه {peak}. \
             السطور:\n{raw}"
        );
    }

    /// **ت٣ — الخليط**: مهمّتان بسقف 2 ومهمّة بسقف 1 على **ثلاث عمليات**.
    /// والترتيب مقصود: الحصرية أولاً فتأخذ الرمزين، والاثنتان تنتظران ثم تأخذ
    /// كلٌّ رمزاً فتتقاطعان ⇒ يُقاس في اللحظة نفسها أن الحصرية معزولة (ب٢) وأن
    /// الأداة ترى التداخل فعلاً (ضابط موجب)، وأن الذروة لا تتجاوز السقف (ب١).
    #[test]
    fn a_mixed_gang_of_three_processes_respects_the_cap_and_the_exclusive_job() {
        if std::env::var(HELPER_MODE).is_ok() {
            return;
        }
        let _lock = registry_lock();
        let plan = [(1u32, 0u64), (MAX_LIMIT, 100), (MAX_LIMIT, 200)];
        let raw = run_three_helpers("xmix", plan);
        let events = parse_trace(&raw);
        assert_eq!(
            events.len(),
            HELPERS * 2,
            "سطور التتبّع ناقصة — القياس باطل:\n{raw}"
        );
        assert_peak_and_exclusivity(&events, &plan, "عبر العمليات/خليط");
    }

    /// **ب٢ في أنقى صورها**: ثلاثة مساعدين كلّهم بسقف 1 على ثلاث عمليات ⇒
    /// لا تقاطع واحد بين أي فترتين (تسلسل تامّ، ذروة = 1). ويسقط على تصميم
    /// يأخذ للحصرية رمزاً واحداً: حينها يتقاطع اثنان.
    #[test]
    fn three_exclusive_processes_run_strictly_one_at_a_time() {
        if std::env::var(HELPER_MODE).is_ok() {
            return;
        }
        let _lock = registry_lock();
        let plan = [(1u32, 0u64); HELPERS];
        let raw = run_three_helpers("xexcl3", plan);
        let events = parse_trace(&raw);
        assert_eq!(
            events.len(),
            HELPERS * 2,
            "سطور التتبّع ناقصة — القياس باطل:\n{raw}"
        );
        assert_peak_and_exclusivity(&events, &plan, "عبر العمليات/حصرية ثلاثية");
    }

    /// **داخل العملية** بالخطة نفسها: ضابط ثالث للقياس نفسه بلا عمليات —
    /// فإن اختلف سلوك المنصّة الواحدة عن نفسها ظهر الفرق هنا.
    #[test]
    fn a_mixed_plan_in_one_process_respects_the_cap_and_the_exclusive_job() {
        let _lock = registry_lock();
        let name = unique_name("inproc-mix");
        let plan = [(1u32, 0u64), (MAX_LIMIT, 100), (MAX_LIMIT, 200)];
        let events: Arc<Mutex<Vec<TracedEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let mut threads = Vec::new();
        for (id, (limit, delay)) in plan.iter().enumerate() {
            let name = name.clone();
            let events = events.clone();
            let (limit, delay) = (*limit, *delay);
            threads.push(std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(delay));
                run_registered_with(&name, "inproc-mix", limit, || {
                    events.lock().unwrap().push((id, now_ms(), 1));
                    std::thread::sleep(Duration::from_millis(HOLD_MS));
                    events.lock().unwrap().push((id, now_ms(), -1));
                    Ok(())
                })
                .expect("فتحة متاحة خلال المهلة");
            }));
        }
        for t in threads {
            t.join().expect("لا ذعر في الخيوط");
        }
        let events = events.lock().unwrap().clone();
        assert_eq!(events.len(), HELPERS * 2, "أحداث ناقصة: {events:?}");
        assert_peak_and_exclusivity(&events, &plan, "داخل العملية/خليط");
    }

    // ── السِجلّ: لا تسرّب في مسار النجاح ولا الخطأ ولا الذعر ─────────────

    #[test]
    fn the_job_registry_is_empty_after_success_failure_and_panic() {
        let _lock = registry_lock();
        let name = unique_name("leak");
        assert!(active_jobs().is_empty(), "لا مهمّة مسجَّلة قبل البدء");

        // ضابط موجب: المهمّة **مسجَّلة وهي تعمل** — لولا هذا لكان «السِجلّ
        // فارغ» صحيحاً حتى لو لم يُسجَّل شيء قطّ (نجاح كاذب).
        let seen = run_registered(&name, "jobs-live", || {
            Ok::<_, String>(
                active_jobs()
                    .iter()
                    .map(|j| j.label.clone())
                    .collect::<Vec<_>>(),
            )
        })
        .expect("مهمّة ناجحة");
        assert_eq!(
            seen,
            vec!["jobs-live".to_string()],
            "المهمّة مرئية أثناء عملها"
        );
        assert!(active_jobs().is_empty(), "نجاح ⇒ لا شيء يبقى مسجَّلاً");

        // مسار الفشل: نفس الشيء.
        let failed = run_registered(&name, "jobs-fail", || Err::<(), String>("عطل مصطنع".into()));
        assert!(failed.is_err(), "الجسم أعاد خطأً");
        assert!(active_jobs().is_empty(), "فشل ⇒ لا شيء يبقى مسجَّلاً");

        // مسار الذعر: الحارس يسقط أثناء فكّ المكدّس فيُلغى التسجيل.
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {})); // ذعر متوقَّع: لا نُلوّث الخرج
        let caught = std::panic::catch_unwind(|| {
            let _ = run_registered::<()>(&name, "jobs-panic", || panic!("ذعر مصطنع"));
        });
        std::panic::set_hook(previous_hook);
        assert!(caught.is_err(), "الذعر فعلاً وقع");
        assert!(active_jobs().is_empty(), "ذعر ⇒ لا شيء يبقى مسجَّلاً");
    }

    #[test]
    fn cancelling_targets_one_job_and_reports_what_it_did() {
        let _lock = registry_lock();
        let name = unique_name("cancel");
        let mut inside = Vec::new();
        run_registered(&name, "cancel-me", || {
            let alive = active_jobs();
            assert_eq!(alive.len(), 1, "مهمّة واحدة نشطة");
            let id = alive[0].id;
            assert!(!alive[0].cancelled, "لم يُطلب إلغاؤها بعد");
            assert!(cancel_job(id), "إلغاء مهمّة نشطة يُبلَّغ بنجاح");
            inside = active_jobs();
            Ok::<_, String>(())
        })
        .expect("مهمّة ناجحة");
        assert_eq!(inside.len(), 1, "المهمّة بقيت نشطة بعد طلب الإلغاء");
        assert!(inside[0].cancelled, "الرمز انضبط فعلاً");
        assert!(
            !cancel_job(inside[0].id),
            "بعد انتهائها لا يُدَّعى إلغاء (المعرّف لم يبق نشطاً)"
        );
        assert!(!cancel_job(0), "معرّف غير موجود ⇒ false");
        assert!(active_jobs().is_empty(), "السِجلّ فارغ في النهاية");
    }

    // ── الغلاف نفسه على المحرّك الحقيقي ────────────────────────────────

    /// `run_separation` الحقيقي (بلا محرّك مُبدَّل): ملف غير موجود ⇒ فشل سريع
    /// من المحرّك، والسِجلّ يعود فارغاً والفتحة تُحرَّر. اسم الفتحة فريد، فلا
    /// ينتظر الاختبار فتحات تطبيق المالك.
    #[test]
    fn the_real_wrapper_fails_fast_on_a_missing_file_and_leaves_no_trace() {
        let _lock = registry_lock();
        let name = unique_name("real");
        let dir = tmp_dir("real");
        let missing = dir.join("لا-يوجد.mp3");
        let started = std::time::Instant::now();
        let result = run_separation_as(
            &name,
            "test",
            &missing,
            &dir,
            Mode::Song,
            OutKind::Audio {
                fmt: pipeline::OutFormat::Mp3,
            },
            false,
            true,
            false,
            None,
            &|_| true,
            &|_, _| {},
        );
        assert!(result.is_err(), "ملف غير موجود لا ينجح");
        let err = result.err().unwrap_or_default();
        assert!(!err.is_empty(), "الخطأ يحمل رسالة: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "الفشل يجب أن يكون سريعاً لا أن ينتظر مهلة"
        );
        assert!(active_jobs().is_empty(), "السِجلّ فارغ بعد الفشل الحقيقي");
        // والفتحة تحرّرت فعلاً: مهمّة ثانية بالاسم نفسه تجدها فوراً.
        run_registered(&name, "after-failure", || Ok(())).expect("الفتحة متاحة بعد الفشل");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **مُفسَد «العملية الميتة»**: عملية تأخذ فتحتين ثم تخرج بـ`exit` بلا
    /// تحرير (لا تعمل المدوِّرات)، فيجب أن يعود الكائن كاملاً لمن يأتي بعدها
    /// **ما دام لم يبق مقبض مفتوح**. والتحقّق يجري في عملية ثالثة، لأن أي
    /// مقبض في عملية الفحص نفسه يُبقي الكائن حيّاً بعدد ناقص.
    #[test]
    fn a_dead_process_slots_are_reusable_once_its_last_handle_is_gone() {
        if std::env::var(HELPER_MODE).is_ok() {
            return;
        }
        let _lock = registry_lock();
        let dir = tmp_dir("dead");
        let slot = unique_name("dead");
        let exe = std::env::current_exe().expect("مسار ثنائي الاختبار");

        // ١) عملية تأخذ الفتحتين ثم تموت بلا تحرير.
        let taken = Command::new(&exe)
            .args(["slots::tests::slot_hog_process", "--exact", "--nocapture"])
            .env(HELPER_MODE, "1")
            .env(HELPER_SLOT, &slot)
            .env(HELPER_LOG, dir.join("hog.log"))
            .env(HELPER_READY, &dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("إطلاق عملية الحجز");
        assert!(taken.success(), "عملية الحجز خرجت بلا خطأ");

        // ٢) عملية ثالثة (لا تحمل مقبضاً) تجد الفتحتين متاحتين.
        let check = Command::new(&exe)
            .args(["slots::tests::slot_probe_process", "--exact", "--nocapture"])
            .env(HELPER_MODE, "1")
            .env(HELPER_SLOT, &slot)
            .env(HELPER_LOG, dir.join("probe.log"))
            .env(HELPER_READY, &dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("إطلاق عملية الفحص");
        let raw = std::fs::read_to_string(dir.join("probe.log")).unwrap_or_default();
        assert!(
            check.success(),
            "الفتحتان يجب أن تعودا بعد موت ماسكهما — سجلّ الفحص: {raw}"
        );
        assert!(raw.contains("PROBE OK"), "سجلّ الفحص: {raw}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// عملية تحجز فتحتين ثم تخرج بلا تحرير (`exit` لا يعمل مدوِّرات المكدّس).
    #[test]
    fn slot_hog_process() {
        if std::env::var(HELPER_MODE).is_err() {
            return;
        }
        let slot = std::env::var(HELPER_SLOT).expect("اسم الفتحة");
        let log = PathBuf::from(std::env::var(HELPER_LOG).expect("ملف السجلّ"));
        let first = acquire_named(&slot, DEFAULT_LIMIT, Duration::from_secs(10));
        let second = acquire_named(&slot, DEFAULT_LIMIT, Duration::from_secs(10));
        let ok = first.is_ok() && second.is_ok();
        append_line(&log, &format!("HOG {}\n", if ok { "OK" } else { "FAIL" }));
        assert!(ok, "العملية الحاجزة يجب أن تأخذ الفتحتين");
        // بلا `drop`: الخروج الفوري لا يعمل المدوِّرات.
        std::process::exit(0);
    }

    /// عملية ثالثة: تتحقّق أن السقف كامل بعد موت الحاجز.
    #[test]
    fn slot_probe_process() {
        if std::env::var(HELPER_MODE).is_err() {
            return;
        }
        let slot = std::env::var(HELPER_SLOT).expect("اسم الفتحة");
        let log = PathBuf::from(std::env::var(HELPER_LOG).expect("ملف السجلّ"));
        let a = acquire_named(&slot, DEFAULT_LIMIT, Duration::from_secs(5));
        let b = acquire_named(&slot, DEFAULT_LIMIT, Duration::from_secs(5));
        let ok = a.is_ok() && b.is_ok();
        append_line(&log, &format!("PROBE {}\n", if ok { "OK" } else { "FAIL" }));
        assert!(ok, "بعد موت الحاجز يجب أن تُتاح الفتحتان كاملتين");
    }

    /// المُفسَد الآخر: سقف أصغر ⇒ الانتظار يعطي خطأً عربياً صريحاً لا انتظاراً
    /// أبدياً. يُقاس بمهلة قصيرة جداً كي يبقى الاختبار سريعاً.
    #[test]
    fn a_taken_slot_times_out_with_an_explicit_arabic_error() {
        let _lock = registry_lock();
        let name = unique_name("timeout");
        let _held = acquire_named(&name, 1, Duration::from_secs(5)).expect("فتحة وحيدة");
        let started = std::time::Instant::now();
        let denied = acquire_named(&name, 1, Duration::from_millis(300));
        let waited = started.elapsed();
        let err = denied.err().expect("لا فتحة ثانية بسقف 1");
        assert!(
            err.contains("انتهت مهلة انتظار فتحة الفصل"),
            "رسالة عربية صريحة: {err}"
        );
        assert!(
            waited >= Duration::from_millis(250) && waited < Duration::from_secs(5),
            "انتظر المهلة المطلوبة لا أكثر ({waited:?})"
        );
    }

    /// **مسار المهلة على الزوج** (وهو ما يجعل الحصرية آمنة): مهمّة بسقف 1
    /// تنتهي مهلتها ومهمّة أخرى تحمل رمزاً ⇒ **لا تتغيّر حالة الرمزين**:
    /// مهمّة تالية بسقف 2 تنجح **فوراً**، وبعد تحرير الرمزين تنجح الحصرية فوراً.
    /// (و`bWaitAll = TRUE` لا يجزّئ الاكتساب، فهذا ليس تفصيلاً بل خاصّية.)
    #[test]
    fn an_exclusive_timeout_leaves_the_tokens_untouched() {
        let _lock = registry_lock();
        let name = unique_name("excl-timeout");

        // مهمّة بسقف السقف الكامل تحمل رمزاً واحداً (والثاني حرّ).
        let held = acquire_named(&name, MAX_LIMIT, Duration::from_secs(5)).expect("رمز حرّ");

        // مهمّة بسقف 1: تحتاج الرمزين ⇒ مهلة صريحة بلا أي أثر على الزوج.
        let t0 = std::time::Instant::now();
        let denied = acquire_named(&name, 1, Duration::from_millis(300));
        let waited = t0.elapsed();
        let err = denied.err().expect("سقف 1 مع رمز محجوز لا ينجح");
        assert!(
            err.contains("انتهت مهلة انتظار فتحة الفصل"),
            "رسالة عربية صريحة: {err}"
        );
        assert!(
            waited >= Duration::from_millis(250) && waited < Duration::from_secs(5),
            "انتظر المهلة المطلوبة لا أكثر ({waited:?})"
        );

        // الدليل أن المنتظر الفاشل **لم يأخذ شيئاً**: الرمز الثاني ما زال حرّاً.
        let t1 = std::time::Instant::now();
        let second = acquire_named(&name, MAX_LIMIT, Duration::from_secs(5))
            .expect("الرمز الثاني ما زال حرّاً بعد مهلة الحصرية");
        assert!(
            t1.elapsed() < Duration::from_secs(1),
            "بلا انتظار: الرمز كان حرّاً فعلاً ({:?})",
            t1.elapsed()
        );

        // وفحص العكس: الرمزان محجوزان الآن ⇒ حصرية ثانية تنتهي مهلتها.
        assert!(
            acquire_named(&name, 1, Duration::from_millis(200)).is_err(),
            "الرمزان محجوزان ⇒ لا حصرية ثانية"
        );

        drop(second);
        drop(held);
        // بعد التحرير: الحصرية تنجح فوراً — لا رمز ضاع ولا رمز زاد.
        let t2 = std::time::Instant::now();
        let _excl = acquire_named(&name, 1, Duration::from_secs(5)).expect("الرمزان حُرّان");
        assert!(
            t2.elapsed() < Duration::from_secs(1),
            "بلا انتظار بعد التحرير ({:?})",
            t2.elapsed()
        );
    }

    /// الذعر لا يسرّب **الفتحة** (لا السِجلّ وحده): الحارس يتحرّر أثناء فكّ
    /// المكدّس، فما بعده يجد السقف كاملاً وفوراً. وهذا هو الفرق العملي بين
    /// حارس RAII وعلمٍ يُصفَّر في آخر سطر من الدالة — الأخير يُتخطّى بالذعر.
    #[test]
    fn a_panicking_job_still_frees_its_slot() {
        let _lock = registry_lock();
        let name = unique_name("panic");
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {})); // ذعر متوقَّع: لا نُلوّث الخرج
        let caught = std::panic::catch_unwind(|| {
            let _ = run_registered::<()>(&name, "panic-holder", || panic!("ذعر مصطنع"));
        });
        std::panic::set_hook(previous_hook);
        assert!(caught.is_err(), "الذعر وقع فعلاً");

        // السقف كامل من جديد: تُكتسب فتحتان (وهما السقف) بلا انتظار.
        let started = std::time::Instant::now();
        let mut held = Vec::new();
        for i in 0..current_limit() {
            held.push(
                acquire_named(&name, current_limit(), Duration::from_secs(5))
                    .unwrap_or_else(|e| panic!("الفتحة رقم {i} لم تُتح بعد الذعر: {e}")),
            );
        }
        assert_eq!(held.len(), current_limit() as usize, "السقف كامل بعد الذعر");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "بلا انتظار: الفتحة كانت حرّة فعلاً ({:?})",
            started.elapsed()
        );
    }
}
