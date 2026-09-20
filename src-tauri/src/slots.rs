//! م١ — محدِّد فتحات الفصل **عبر العمليات** + سِجلّ المهامّ.
//!
//! ## العطل المقيس الذي يعالجه هذا الملف
//!
//! لم يكن في التطبيق أي محدِّد تنفيذ متزامن، وخمسة مداخل تستدعي
//! `pipeline::process_file` — كلٌّ منها يُحمّل جلسة ORT خاصّة به. وقياس المالك
//! (RTX 3070 · 8192 MiB) أعطى: خط الأساس 1419 MiB · فصل واحد 3732 MiB ·
//! فصلان معاً 6069 MiB ⇒ **الذاكرة خطّية** (‏1419 + n × 2325)، فثلاثة فصول
//! متزامنة تتجاوز البطاقة (~8.4 GB). ومحدِّد **داخل العملية** لا يكفي: مسار
//! `cli.rs` عملية منفصلة تماماً عن الواجهة، فتتجاوز أي عدّاد في ذاكنة العملية.
//!
//! ## الحلّ
//!
//! سيمافور **مسمّى في نواة ويندوز** (`CreateSemaphoreW`/`OpenSemaphoreW`) باسم
//! في نطاق `Global\`، فيراه كل عمليات الجلسة، والعدّاد محفوظ في النواة لا في
//! أي عملية. حارس RAII (`Drop`) يحرّر الفتحة عند الخروج — **حتى مع الخطأ
//! والذعر**، ولو انهارت العملية نفسها زال الكائن بزوال آخر مقبض عليه.
//!
//! ## ما لا يفعله هذا الملف (بصراحة)
//!
//! * **لا يقتل شجرة العمليات** عند الإلغاء: `cancel_job` يضبط رمز إلغاء
//!   **لكل مهمّة** فقط، ولا مسار إنتاجي يقرأه في م١ — بند م٢ هو الذي سيقرأه
//!   ويقتل الشجرة. فحتى الآن الإلغاء الفعلي يمرّ بالعلم العام القائم
//!   (`AppState::cancel_flag`) كما كان.
//! * **سقف السيمافور يثبّته أول من يُنشئ الكائن**: ويندوز يتجاهل السقف في
//!   `CreateSemaphoreW` إن كان الكائن قائماً. فلو خالف إعداد عمليتَيْن، فالسقف
//!   سقف الأولى. والمضمون **دائماً** ألّا يتجاوز السقف `MAX_LIMIT` أبداً، لأن
//!   `clamp_limit` يُطبَّق قبل الإنشاء — أي أن الإعداد يمكن أن يكون أرخى من
//!   طلب المستخدم، ولا يمكن أن يكون أقسى من سقف البطاقة.
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
/// **لماذا 2 لا أكثر**: القياس أعلاه — 1419 + 3 × 2325 ≈ 8.4 GB على بطاقة
/// 8192 MiB ⇒ الثالث يجلب `out of memory` على البطاقة (وسقوطاً إلى RAM/CPU
/// أو فشلاً). والسقف حدّ **بطاقة** لا تفضيل.
pub const MAX_LIMIT: u32 = 2;

/// القيمة الافتراضية لإعداد `max_concurrent_jobs` (وهي أيضاً سقف العملية
/// إذا لم يُطبَّق أي إعداد: CLI مثلاً).
pub const DEFAULT_LIMIT: u32 = 2;

/// أقصى انتظار لفتحة قبل الخطأ الصريح — **لا انتظار أبدي**: تشابك عمليتين
/// تنتظران إلى الأبد أسوأ من خطأ يقول للمستخدم ما جرى.
pub const DEFAULT_WAIT: Duration = Duration::from_secs(30 * 60);

/// قصّ ما خرج عن المدى المسموح (1..=MAX_LIMIT). الصفر يُرفع إلى 1 لأن سقفاً
/// صفرياً يعني انتظاراً أبدياً لا تعطيلاً.
pub fn clamp_limit(n: u32) -> u32 {
    n.clamp(1, MAX_LIMIT)
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

/// حارس الفتحة. النوع يختلف بحسب المنصّة، والسلوك واحد: `Drop` يحرّر الفتحة.
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
    //! سيمافور نواة ويندوز المسمّى.

    use super::{AcquireFailure, Duration, SlotGuard, WinSem};
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_ALREADY_EXISTS, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        CreateSemaphoreW, OpenSemaphoreW, ReleaseSemaphore, WaitForSingleObject,
        SEMAPHORE_ALL_ACCESS,
    };

    /// مقابض مفتوحة في هذه العملية، بالاسم — فلا يُعاد الإنشاء مع كل مهمّة،
    /// ولا يُغلق مقبض مستعمل (الإغلاق كان سيُبطل الكائن إن كان آخر مقبض).
    fn cache() -> &'static Mutex<HashMap<String, isize>> {
        static CACHE: OnceLock<Mutex<HashMap<String, isize>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// يفتح الكائن القائم، وإلا يُنشئه بالسقف المطلوب.
    fn open_or_create(name: &str, cap: u32) -> Result<isize, AcquireFailure> {
        let mut map = cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(h) = map.get(name) {
            return Ok(*h);
        }
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // `OpenSemaphoreW` أولاً: العملية الثانية تجد كائن الأولى فتأخذ سقفه
        // ولا تُنشئ كائناً ثانياً (وهذا أصل نظام «السقف يثبّته أول من يُنشئ»).
        let mut handle = unsafe { OpenSemaphoreW(SEMAPHORE_ALL_ACCESS, 0, wide.as_ptr()) };
        let mut created = false;
        if handle.is_null() {
            handle = unsafe {
                CreateSemaphoreW(std::ptr::null(), cap as i32, cap as i32, wide.as_ptr())
            };
            created = !handle.is_null();
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
                tracing::debug!(target: "slots", "كائن السيمافور «{name}» كان قائماً — سقفه سقف منشئه");
            } else {
                tracing::info!(target: "slots", "أُنشئ سيمافور الفصل «{name}» بسعة {cap}");
            }
        }
        let raw = handle as isize;
        map.insert(name.to_string(), raw);
        Ok(raw)
    }

    pub(super) fn acquire(
        name: &str,
        cap: u32,
        timeout: Duration,
    ) -> Result<SlotGuard, AcquireFailure> {
        let handle = open_or_create(name, cap)?;
        // `as_millis` u128 ⇒ قصّ إلى u32-1: `INFINITE` (0xFFFFFFFF) لا يُستعمل
        // أبداً، فالمهمّة لا تنتظر أبداً حتى لو أُعطي مهلة هائلة.
        let ms = timeout.as_millis().min((u32::MAX - 1) as u128) as u32;
        match unsafe { WaitForSingleObject(handle as _, ms) } {
            WAIT_OBJECT_0 => Ok(WinSem { handle }),
            WAIT_TIMEOUT => Err((
                false,
                format!(
                    "انتهت مهلة انتظار فتحة الفصل ({:.0} دقيقة) — فصول أخرى تعمل على هذا الجهاز؛ \
                     أعد المحاولة بعد انتهائها أو ارفع المهلة",
                    timeout.as_secs_f64() / 60.0
                ),
            )),
            other => Err((false, format!("فشل انتظار فتحة الفصل (رمز Win32 {other})"))),
        }
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

/// حارس فتحة على ويندوز: مقبض كائن نواة.
#[cfg(windows)]
struct WinSem {
    /// `HANDLE` مؤشّر خام (`*mut c_void`) لا يقبل `Send`/`Sync` تلقائياً.
    /// نخزّنه `isize` ونتحوّل عند النداء: مقابض النواة صالحة من أي خيط في
    /// العملية (ضمان Win32)، والمقبض لا يُغلق أبداً فلا إغلاق مزدوج.
    handle: isize,
}

#[cfg(windows)]
impl Drop for WinSem {
    fn drop(&mut self) {
        kernel::release(self.handle);
    }
}

#[cfg(not(windows))]
mod local {
    //! انحدار غير ويندوز: محدِّد **داخل العملية** (عدّاد + `Condvar`) مفتاحه
    //! الاسم — كي يبقى `cargo test` ممكناً على أي منصّة، بنفس الدلالة.

    use super::{AcquireFailure, Duration, LocalSem, LocalSema};
    use std::collections::HashMap;
    use std::sync::{Arc, Condvar, Mutex, OnceLock};
    use std::time::Instant;

    fn registry() -> &'static Mutex<HashMap<String, Arc<LocalSema>>> {
        static MAP: OnceLock<Mutex<HashMap<String, Arc<LocalSema>>>> = OnceLock::new();
        MAP.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn acquire(
        name: &str,
        cap: u32,
        timeout: Duration,
    ) -> Result<LocalSem, AcquireFailure> {
        let sem = {
            let mut map = registry().lock().unwrap_or_else(|p| p.into_inner());
            map.entry(name.to_string())
                .or_insert_with(|| {
                    Arc::new(LocalSema {
                        count: Mutex::new(cap),
                        cv: Condvar::new(),
                    })
                })
                .clone()
        };
        let mut count = sem.count.lock().unwrap_or_else(|p| p.into_inner());
        let deadline = Instant::now() + timeout;
        while *count == 0 {
            let now = Instant::now();
            if now >= deadline {
                return Err((false, timeout_message(timeout)));
            }
            let (guard, wait) = sem
                .cv
                .wait_timeout(count, deadline - now)
                .unwrap_or_else(|p| p.into_inner());
            count = guard;
            if wait.timed_out() && *count == 0 {
                return Err((false, timeout_message(timeout)));
            }
        }
        *count -= 1;
        // القفل يُسقط **قبل** نقل `sem` إلى الحارس: `MutexGuard` يستعير من
        // `sem.count`، فنقله وهو حيّ خطأ تصريف لا يظهر إلا على منصّة غير
        // ويندوز (اكتُشف بإجبار فرع `cfg(not(windows))` على التصريف).
        drop(count);
        Ok(LocalSem { sem })
    }

    fn timeout_message(timeout: Duration) -> String {
        format!(
            "انتهت مهلة انتظار فتحة الفصل ({:.0} دقيقة) — فصول أخرى تعمل على هذا الجهاز؛ \
             أعد المحاولة بعد انتهائها أو ارفع المهلة",
            timeout.as_secs_f64() / 60.0
        )
    }

    pub(super) fn release(sem: &Arc<LocalSema>) {
        let mut count = sem.count.lock().unwrap_or_else(|p| p.into_inner());
        *count += 1;
        sem.cv.notify_one();
    }
}

#[cfg(not(windows))]
struct LocalSema {
    count: Mutex<u32>,
    cv: std::sync::Condvar,
}

#[cfg(not(windows))]
struct LocalSem {
    sem: Arc<LocalSema>,
}

#[cfg(not(windows))]
impl Drop for LocalSem {
    fn drop(&mut self) {
        local::release(&self.sem);
    }
}

/// فتحة في نطاق الجلسة (بلا بادئة `Global\`) — بديل إن رُفض النطاق العام.
fn session_local(name: &str) -> Option<String> {
    name.strip_prefix(r"Global\")
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// يكتسب فتحة بالاسم المعطى: يفتح جسم النواة أو يُنشئه، ثم ينتظر بمهلة.
///
/// **السقوط إلى نطاق الجلسة**: إنشاء كائن في `Global\` يحتاج
/// `SeCreateGlobalPrivilege` وهي ليست مضمونة لكل مستخدم. فإن رُفض الإنشاء
/// (وليس الانتظار) أُعيدت المحاولة باسم بلا البادئة — وهو نطاق الجلسة، وهو
/// المدى الذي تتنازع فيه عملياتنا فعلاً (الواجهة وخدمة المراقبة والجسر في
/// العملية نفسها، وCLI في الجلسة نفسها). فلا يتحوّل رفضُ الصلاحية إلى تعطيل
/// الفصل كله.
fn acquire_named(name: &str, limit: u32, timeout: Duration) -> Result<SlotGuard, String> {
    let cap = clamp_limit(limit);
    match platform_acquire(name, cap, timeout) {
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
                    platform_acquire(&local, cap, timeout).map_err(|(_, e)| e)
                }
                None => Err(why),
            }
        }
    }
}

#[cfg(windows)]
fn platform_acquire(name: &str, cap: u32, timeout: Duration) -> Result<SlotGuard, AcquireFailure> {
    kernel::acquire(name, cap, timeout)
}

#[cfg(not(windows))]
fn platform_acquire(name: &str, cap: u32, timeout: Duration) -> Result<SlotGuard, AcquireFailure> {
    local::acquire(name, cap, timeout)
}

// ───────────────────────── مدخل الفصل الواحد ─────────────────────────

/// **النواة الوحيدة**: سِجلّ المهمّة + فتحة الفصل + الجسم، في نقطة واحدة
/// تمرّ منها كل مهمّة فصل. الترتيب مقصود: التسجيل قبل الانتظار (فتظهر
/// المهمّة المنتظرة في السِجلّ لا المخدومة وحدها)، والتحرير بترتيب عكسي
/// (الفتحة تُحرَّر قبل إلغاء التسجيل، فلا تبقى مهمّة «نشطة» بلا فتحة).
fn run_registered<T>(
    slot_name: &str,
    label: &str,
    body: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _job = register_job(label);
    let _slot = acquire_named(slot_name, current_limit(), DEFAULT_WAIT)?;
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

    // ── عبر العمليات: 3 عمليات مساعدة ⇒ أقصى تداخل مقيس = 2 ─────────────

    const HELPER_MODE: &str = "HARAMLITE_SLOT_HELPER";
    const HELPER_SLOT: &str = "HARAMLITE_SLOT_HELPER_SLOT";
    const HELPER_LOG: &str = "HARAMLITE_SLOT_HELPER_LOG";
    const HELPER_READY: &str = "HARAMLITE_SLOT_HELPER_READY";
    const HELPER_ID: &str = "HARAMLITE_SLOT_HELPER_ID";
    const HELPERS: usize = 3;

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
    /// فتحة وتكتب بدايتها ونهايتها بطابع زمني في ملف مشترك.
    ///
    /// تُشغَّل بـ`current_exe` مع `HARAMLITE_SLOT_HELPER=1` من الاختبار التالي؛
    /// وفي تشغيل `cargo test` العادي تعود فوراً بلا عمل.
    #[test]
    fn slot_helper_process() {
        if std::env::var(HELPER_MODE).is_err() {
            return; // لسنا في وضع المساعد
        }
        let slot = std::env::var(HELPER_SLOT).expect("اسم الفتحة");
        let log = PathBuf::from(std::env::var(HELPER_LOG).expect("ملف التتبّع"));
        let ready = PathBuf::from(std::env::var(HELPER_READY).expect("مجلد الحاجز"));
        let id = std::env::var(HELPER_ID).expect("معرّف المساعد");

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

        run_registered(&slot, "helper", || {
            append_line(&log, &format!("{id} START {}\n", now_ms()));
            std::thread::sleep(Duration::from_millis(HOLD_MS));
            append_line(&log, &format!("{id} END {}\n", now_ms()));
            Ok(())
        })
        .expect("المساعد أخذ فتحة خلال المهلة");
    }

    #[test]
    fn three_helper_processes_never_overlap_more_than_the_cap() {
        if std::env::var(HELPER_MODE).is_ok() {
            return; // لا نُعيد إطلاق المساعدين من داخل مساعد
        }
        let _lock = registry_lock();
        let dir = tmp_dir("xproc");
        let log = dir.join("trace.log");
        let ready = dir.join("ready");
        std::fs::create_dir_all(&ready).unwrap();

        let exe = std::env::current_exe().expect("مسار ثنائي الاختبار");
        // **اسم واحد لكل المساعدين** — وهذا جوهر القياس: لو أخذ كل مساعد
        // اسماً خاصاً به لما تنازعوا على كائن واحد، ولصار «التداخل ≤ 2» نتيجة
        // اسمٍ مختلف لا نتيجة محدِّد.
        let slot = unique_name("xproc");
        let mut children = Vec::new();
        for i in 0..HELPERS {
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
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("إطلاق عملية مساعدة");
            children.push(child);
        }
        for (i, mut c) in children.into_iter().enumerate() {
            let status = c.wait().expect("انتظار المساعد");
            assert!(status.success(), "المساعد {i} فشل: {status}");
        }

        let raw = std::fs::read_to_string(&log).expect("ملف التتبّع موجود");
        let mut events: Vec<(u128, i32)> = Vec::new();
        let mut started = 0usize;
        let mut ended = 0usize;
        for line in raw.lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            assert_eq!(f.len(), 3, "سطر تتبّع غير سليم (تداخل كتابة؟): {line:?}");
            let ts: u128 = f[2]
                .parse()
                .unwrap_or_else(|_| panic!("طابع غير رقمي: {line:?}"));
            match f[1] {
                "START" => {
                    started += 1;
                    events.push((ts, 1));
                }
                "END" => {
                    ended += 1;
                    events.push((ts, -1));
                }
                other => panic!("حدث غير معروف {other:?} في {line:?}"),
            }
        }
        // إثبات أن القياس وقع فعلاً: 3 عمليات × (بداية+نهاية).
        assert_eq!(
            (started, ended),
            (HELPERS, HELPERS),
            "سطور التتبّع ناقصة — القياس باطل. المحتوى:\n{raw}"
        );
        let peak = max_overlap(&events);
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
        let _ = std::fs::remove_dir_all(&dir);
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
