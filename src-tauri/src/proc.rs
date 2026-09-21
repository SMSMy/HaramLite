//! **إلغاء حقيقي**: رمز إلغاء مشترك + تشغيل أداة بقابلية القتل + قتل شجرة العمليات.
//!
//! **لماذا وحدة مستقلّة**: كانت `kill_tree` خاصّة بـ`yt_dlp.rs` وحدها (كانت
//! `yt_dlp.rs:1277`)، و`media.rs` فيه ستّة نداءات تحجب بلا مقبض. ونقلُ المساعد
//! إلى هنا هو الشرط الذي يمنع **نسخة ثانية** منه في المستودع (تصميم م٢/١) —
//! والاختبار القائم على سلوكه يتبع الموضع الجديد.
//!
//! ## العقد (يُقرأ مع `slots.rs` و`media.rs` و`pipeline.rs`)
//!
//! * [`CancelToken`] — `Arc<AtomicBool>` واحد **لكل مهمّة**. يسكن سِجلّ المهامّ
//!   في `slots.rs`، فيراه `cancel_job(id)` و`cancel_all()`، ويُنسخ في الجسم
//!   فيراه كل حدّ مرحلة وكل نداء أداة. فلا إلغاء بمهمّة إلا بضبط هذا الرمز.
//! * [`prepare_child`] + [`register_child`] — تسجيل **قاتل الطفل** (مقبض مملوك +
//!   **مهمّة نواة** تحيط بشجرته) في سياق المهمّة الجارية **على هذا الخيط**.
//!   ولذلك نُسجّل المقبض (`Child`) لا الرقم وحده: بين قراءة PID وقتله قد يموت
//!   الطفل ويُعاد استخدام المعرّف، فتقع `taskkill` على عملية بريئة. والمقبض
//!   الذي لم يُحصَد بعد (`try_wait() == Ok(None)`) دليل حياة **ملكُنا** لا
//!   يشاركنا فيه غيرنا. **وأُضيفت مهمّة النواة (م٣/إصلاح٢) لأن `taskkill /T`
//!   يقيس الشجرة في لحظة وصوله**: قِيس أن `yt-dlp.exe` عمليّتان (مُشغّل +
//!   عامل)، وأن قتلاً مبكراً يترك العامل حيّاً في **١ من ٤** تشغيلات (انظر
//!   [`JobGuard`]).
//! * [`run_cancellable`] — `spawn()` ثم استطلاع `try_wait()` كل [`POLL`]،
//!   وعند الإلغاء `kill_tree` **فوراً** ثم خطأ عربي. والدلالة على مرحلتين
//!   (قرار المالك): العمليات المنفصلة تُقتل فوراً، ونداء ONNX داخل العملية
//!   **غير قابل للقطع** فيُهجر عند أول حدّ (انظر `pipeline.rs`).
//!
//! ## ما لا يفعله هذا الملف (بصراحة)
//!
//! * **لا يوقف نداء داخل العملية**: `separator::separate` (ONNX) يمرّ داخل
//!   نداء واحد لا نقطة إلغاء فيه؛ الهجر يقع عند أول فحص بعده.
//! * **لا يعرف مهمّةً غير جارية على خيطه**: خيط بلا سياق مهمّة يسلك مسار
//!   الانتظار البسيط (`wait_with_output`) — فلا إلغاء له، وهو مقصود: نداءات
//!   التشخيص (`has_nvenc` · `probe` خارج مسار الفصل) لا مهمّة لها.

use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// دورة الاستطلاع: `try_wait` كل 200 مللي. وهي أيضاً **حدّ الاستجابة المقيس**:
/// من ضبط الرمز إلى قتل الشجرة لا يمرّ أكثر من دورة واحدة زائد زمن `taskkill`.
pub const POLL: Duration = Duration::from_millis(200);

/// مهلة قتل الشجرة نفسها: `taskkill /T /F` على شجرة كبيرة قد يتأخّر، ولا يجوز
/// أن يعلّق الإلغاء نفسه.
const KILL_WAIT: Duration = Duration::from_secs(5);

/// **مهلة تأكيد الموت بعد أمر القتل** — مقياس مستقلّ عن [`KILL_WAIT`]:
/// `taskkill` **يعود قبل أن يموت الهدف**، فالمطلوب انتظار **مقبض العملية**
/// (إشارة النواة) حتى يموت فعلاً. والمهلة سخيّة عمداً (٢ ث): القتل على ويندوز
/// يستغرق عشرات المللي، وما يهمّ أن **العودة تعني الموت** لا مجرّد الأمر به.
/// وإن انقضت المهلة يُسجَّل تحذير صريح ولا يُدّعى النجاح.
const KILL_CONFIRM_WAIT: Duration = Duration::from_secs(2);

/// أكثر ما يُحتفظ به من مخرجات الأداة (stdout/stderr معاً) لتقرير الفشل.
/// السلوك السابق كان `.output()` فيحتفظ بالكل؛ والفارق هنا **مقصود ومحدود**:
/// آخر 256KB تحمل سبب الفشل دائماً، وقراءة بلا سقف تفتح ذكرى غير محدودة.
const TAIL_CAP: usize = 256 * 1024;

// ─────────────────────────── رمز الإلغاء ───────────────────────────

/// الرمز الحقيقي: `Arc<AtomicBool>` **لكل مهمّة**. وهو **مشترك**: نسخُه تشير
/// إلى العلم نفسه — و`slots.rs` ينسخه إلى المهمّة فيراه `cancel_job(id)`،
/// ويمرّره إلى `pipeline::process_file` فيراه كل حدّ مرحلة. (المهمّة الواحدة
/// **رمزها واحد**: لا يفرّق بين «رمز السِجلّ» و«رمز الجسم» — فإلغاء السِجلّ
/// هو نفسه ما يقرؤه الجسم، بلا مزامنة إضافية.)
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn set(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// العلم الخام — لمن يحتاج `&Arc<AtomicBool>` (‏`yt_dlp::download_media`
    /// مثلاً) فيكون **رمز المهمّة نفسه** لا نسخةً منه: إلغاء السِجلّ يوقف
    /// التنزيل فعلاً، بلا علمٍ ثانٍ يُزامَن.
    pub fn raw(&self) -> &Arc<AtomicBool> {
        &self.0
    }

    /// **رمز من علم قائم** — العلم **نفسه** لا نسخة منه (فمن ضبط العلم أوقف
    /// هذا الرمز). يُستعمل في مسار التنزيل الذي يملك علماً خاماً
    /// (`Arc<AtomicBool>`) ويريد تمريره إلى [`run_cancellable_with_cap`].
    pub fn from_flag(flag: Arc<AtomicBool>) -> Self {
        Self(flag)
    }
}

// ─────────────────── سياق المهمّة على هذا الخيط ───────────────────
//
// لماذا `thread_local` لا وسيطاً في كل نداء: نداءات الأدوات في `media.rs`
// تنتشر في خطّ الأنابيب كلّه، وتمرير سياق في كل توقيع يلمس كل مستدعٍ (ونصفها
// تشخيص بلا مهمّة). والسياق **مؤقّت بطبع المهمّة**: يُوضع في `slots.rs` حول
// الجسم وحده، فيسري على كل نداء داخل المهمّة وحدها.

#[derive(Clone, Default)]
pub struct JobCtx {
    /// مَن يقرأ الرمز **لهذه المهمّة**.
    pub cancel: Option<CancelToken>,
    /// مقابض العمليات الفرعية الحيّة (والخيوط التي قرأت مخرجاتها).
    pub phases: Arc<Mutex<Phases>>,
}

/// **مهمّة نواة (Job Object) تحيط بشجرة طفل** — العقد الوحيد الذي يضمن موت
/// **الأحفاد**، لا مجرّد ما تصادفه `taskkill` في لحظتها.
///
/// ## العطل الذي وُلدت منه (مقيس ٢٠٢٦-٠٩-٢٤، م٣/إصلاح٢)
///
/// `yt-dlp.exe` **عمليّتان لا واحدة**: مُشغّل يبثّ نفسه في مجلد مؤقت ثم يُنشئ
/// العامل (قِيس بـ`Win32_Process`: `yt-dlp.exe` (٣١١٤٨) ← `yt-dlp.exe` (٧٤٧٢)).
/// و`taskkill /T /F /PID <المُشغّل>` يقتل الشجرة **التي يراها في تلك اللحظة**:
/// فإذا وقع القتل أثناء إنشاء العامل نجا العامل، **وصار يتيماً لا يُدرَك بمعرّف
/// أبيه** — وقِيس ذلك حيّاً: **١ من ٤** تشغيلات عند ٢٠٠ مللي من الإطلاق (صفر
/// من ٤ عند ١٢٠ و٣٠٠ و٩٠٠ مللي). والعامل الناجي **يبقي أنبوب مخرجات أبيه
/// مفتوحاً**، فلا يصل `EOF` إلى قارئ المهمّة فتبقى معلّقة بلا نهاية — وهو
/// العطل الميداني بعينه («المهمّة تبقى حيّة، و0% لا يتغيّر، وyt-dlp حيّ»).
///
/// ## ولماذا الـJob تُغلق ذلك بالنواة لا بالتوقيت
///
/// العامل يُخلق **داخل** المهمّة (يرثها من أبيه)، فـ[`JobGuard::terminate`]
/// يقتل **كل أعضاء المهمّة دفعةً واحدة** — ولو مات المُشغّل قبلهم. وبهذا لا
/// تبقى نافذة سباق أصلاً: لا نُطارِد شجرة تتحرّك، بل نُغلق وعاءها.
///
/// ## `KILL_ON_JOB_CLOSE` — شبكة أمان لا زيادة
///
/// إغلاق المقبض (في `Drop`) يقتل كل ما بقي في المهمّة: فانهيار التطبيق أو
/// إغلقه لا يترك تنزيلاً يتيماً يستهلك الشبكة والمعالج.
///
/// ## التراجع بأمان
///
/// إن فشل أي نداء (أو رفض النظام الإسناد — عملٌ متداخل في بيئات CI مثلاً)
/// نعود إلى `taskkill /T /F` كما كان، **ويُسجَّل السبب** — لا صمت عن تراجع.
#[cfg(target_os = "windows")]
struct JobGuard {
    handle: isize,
}

/// الربط الخام لواجهات المهمّة في `kernel32` — بلا علم ميزة جديد في
/// `Cargo.toml` (النطاق ملفات `src/*.rs`)، وبلا اعتمادية جديدة.
#[cfg(target_os = "windows")]
mod job_ffi {
    use windows_sys::Win32::Foundation::HANDLE;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateJobObjectW(attrs: *mut core::ffi::c_void, name: *const u16) -> HANDLE;
        pub fn SetInformationJobObject(
            job: HANDLE,
            class: i32,
            info: *mut core::ffi::c_void,
            len: u32,
        ) -> i32;
        pub fn AssignProcessToJobObject(job: HANDLE, process: HANDLE) -> i32;
        pub fn TerminateJobObject(job: HANDLE, exit_code: u32) -> i32;
    }
}

/// `JobObjectExtendedLimitInformation` = 9.
#[cfg(target_os = "windows")]
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` = 0x2000.
#[cfg(target_os = "windows")]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

/// تخطيط `JOBOBJECT_BASIC_LIMIT_INFORMATION` على x64 — مكتوب حقلاً حقلاً
/// ليُقابَل بالنصّ الأصلي (٦٤ بايتاً، وحشو صريح في مواضعه).
#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
struct JobBasicLimit {
    per_process_user_time: i64,
    per_job_user_time: i64,
    limit_flags: u32,
    _pad0: u32,
    min_working_set: usize,
    max_working_set: usize,
    active_process_limit: u32,
    _pad1: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

/// `IO_COUNTERS` — ستّة عدّادات ٦٤-بت (٤٨ بايتاً).
#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_ops: u64,
    write_ops: u64,
    other_ops: u64,
    read_bytes: u64,
    write_bytes: u64,
    other_bytes: u64,
}

/// `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` (١٤٤ بايتاً على x64).
#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
struct JobExtendedLimit {
    basic: JobBasicLimit,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}

#[cfg(target_os = "windows")]
impl JobGuard {
    /// يُنشئ مهمّةً بحدّ «اقتل الكل عند الإغلاق» ويُسند الطفل إليها.
    /// `None` = تعذّر (يُسجَّل السبب، ويبقى `taskkill /T /F` بديلاً).
    fn attach(child: &Child) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let _ = GetCurrentProcess;
        unsafe {
            let job = job_ffi::CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                tracing::warn!(
                    target: "proc",
                    "تعذّر إنشاء مهمّة النواة ({}) — القتل سيبقى بـtaskkill /T",
                    std::io::Error::last_os_error()
                );
                return None;
            }
            let mut info = JobExtendedLimit::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = job_ffi::SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &mut info as *mut JobExtendedLimit as *mut core::ffi::c_void,
                std::mem::size_of::<JobExtendedLimit>() as u32,
            );
            if set == 0 {
                tracing::warn!(
                    target: "proc",
                    "تعذّر ضبط حدّ «اقتل عند الإغلاق» ({}) — القتل سيبقى بـtaskkill /T",
                    std::io::Error::last_os_error()
                );
                CloseHandle(job);
                return None;
            }
            let assigned = job_ffi::AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
            if assigned == 0 {
                tracing::warn!(
                    target: "proc",
                    "تعذّر إسناد الطفل (pid={}) إلى مهمّة النواة ({}) — القتل سيبقى بـtaskkill /T",
                    child.id(),
                    std::io::Error::last_os_error()
                );
                CloseHandle(job);
                return None;
            }
            Some(Self {
                handle: job as isize,
            })
        }
    }

    /// **يقتل كل أعضاء المهمّة** (الطفل وكل أحفاده) — ولو مات المُشغّل قبلهم.
    fn terminate(&self) {
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::Foundation::HANDLE;
            unsafe {
                job_ffi::TerminateJobObject(self.handle as HANDLE, 1);
            }
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for JobGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        unsafe {
            // مع `KILL_ON_JOB_CLOSE`: إغلاق المقبض يقتل ما بقي من أعضاء.
            CloseHandle(self.handle as HANDLE);
        }
    }
}

/// **مقبض عملية مملوك لا رقم + مهمّة نواة تحيط بشجرته**: مرجعنا إلى العملية
/// الفرعية هو **مقبض نواة** مُستنسخ (`DuplicateHandle`)، لا `u32`.
///
/// **لماذا هذا هو العلاج الصحيح لخطر إعادة استخدام PID**: `Child` في المكتبة
/// القياسية **ليس `Clone`**، ومقبضه يُغلق عند حصاده — فلو سجّلنا الرقم وحده
/// لأمكن أن يموت الطفل ويُعاد استخدام معرّفه قبل وصول `taskkill`، فتقع على
/// عملية **بريئة**. ومقبض مملوك **يُبقي معرّف العملية محجوزاً في النواة** ما
/// دام مفتوحاً ⇒ الاستخدام الآمن: `WaitForSingleObject(handle, 0)` يقول
/// «حيّة» أو «انتهت» بلا أي التباس.
pub struct ChildHandle {
    pub pid: u32,
    handle: isize,
    /// مهمّة النواة إن أُسند الطفل إليها (وإلا `taskkill /T /F`).
    #[cfg(target_os = "windows")]
    job: Option<JobGuard>,
}

impl ChildHandle {
    /// **مقبض نواة مملوك مستنسخ** (`DuplicateHandle`) من طفل حيّ — الجزء المشترك
    /// بين [`ChildHandle::new`] و[`ChildHandle::without_job`]، فلا تتكرّر معرفةُ
    /// الاستنساخ في موضعين (`None` = تعذّر؛ لا قتل عندها ولا ضرر).
    #[cfg(target_os = "windows")]
    fn duplicated(child: &Child) -> Option<isize> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE};
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        unsafe {
            let src = child.as_raw_handle() as HANDLE;
            let mut dup: HANDLE = std::ptr::null_mut();
            let ok = DuplicateHandle(
                GetCurrentProcess(),
                src,
                GetCurrentProcess(),
                &mut dup,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            );
            if ok == 0 || dup.is_null() {
                return None;
            }
            Some(dup as isize)
        }
    }

    /// مقبض من طفل حيّ **ومهمّة تحيط بشجرته**. `None` إن فشل الاستنساخ
    /// (لا قتل عندها — ولا ضرر؛ وتعذّر المهمّة وحده لا يمنع المقبض).
    pub fn new(child: &Child) -> Option<Self> {
        #[cfg(target_os = "windows")]
        {
            Some(Self {
                pid: child.id(),
                handle: Self::duplicated(child)?,
                job: JobGuard::attach(child),
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Some(Self {
                pid: child.id(),
                handle: 0,
            })
        }
    }

    /// **مقبض مملوك بلا مهمّة نواة** — يمثّل بالحرف ما ينتج عن
    /// [`JobGuard::attach`] حين يعود `None` (فشل إنشاء المهمّة أو الإسناد)،
    /// وهو المسار الذي وعد به التوثيق أعلاه («التراجع بأمان»): [`ChildHandle::kill`]
    /// يسلك عنده `taskkill /T /F`.
    ///
    /// **ولماذا يوجد (و٢/دَين الحرّاس)**: هذا الفرع **لا يبلغه اختبار قائم** —
    /// كل حرّاس الشجرة في المستودع تمرّ بمهمّة مُسندة، فلو انقطع الإسناد في
    /// الإنتاج لكان القتل الاحتياطي **غير مقيس قطّ**. وبوجوده يصير مقيساً
    /// **بمحاولة قتل واحدة**:
    /// `tests::the_fallback_kills_a_two_process_tree_in_one_attempt`.
    ///
    /// **وللاختبار وحده**: لا مسار إنتاج يناديه (الإنتاج يمرّ بـ
    /// [`ChildHandle::new`] فيُسند أو يتراجع).
    #[cfg(test)]
    pub fn without_job(child: &Child) -> Option<Self> {
        #[cfg(target_os = "windows")]
        {
            Some(Self {
                pid: child.id(),
                handle: Self::duplicated(child)?,
                job: None,
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Some(Self {
                pid: child.id(),
                handle: 0,
            })
        }
    }

    /// **يقتل الطفل وشجرته كلها** — بالأداة الأقوى المتاحة:
    /// مهمّة النواة إن أُسند الطفل إليها (فتقتل الأحفاد ولو مات المُشغّل)،
    /// وإلا `taskkill /T /F /PID` كما كان.
    ///
    /// **ولا يُنادي الاثنين**: الـJob تشمل كل الأعضاء، و`taskkill` بعدها
    /// إطلاق عملية زائدة في كل دورة استطلاع. وإن تعذّر الإسناد فالسجلّ يقول
    /// ذلك ([`JobGuard::attach`]) والبديل يعمل.
    ///
    /// **والفرعان مقيسان (و٢/دَين الحرّاس)**: كان كل حارس شجرة في المستودع
    /// يمرّ بمهمّة **مُسندة**، فلم يكن في `proc` ما يقيس **الاحتياط** أصلاً.
    /// [`ChildHandle::without_job`] يمنح الاختبار مقبضاً بلا مهمّة (مسار
    /// `attach → None`) فيقيس أن **محاولة واحدة** تقتل شجرةً من عمليتين
    /// (`tests::the_fallback_kills_a_two_process_tree_in_one_attempt`)، ويقيس
    /// الثاني المسار الإنتاجي أن المحاولة الواحدة تُدرك عاملاً حيّاً مات
    /// مُشغّله (`tests::one_kill_attempt_reaches_the_worker_after_its_launcher_died`).
    pub fn kill(&self) {
        #[cfg(target_os = "windows")]
        if let Some(job) = self.job.as_ref() {
            job.terminate();
            return;
        }
        kill_tree(self.pid);
    }

    /// هل العملية **ما زالت تعمل**؟ (`false` عند الفشل — لا نخمّن بحياة.)
    pub fn is_alive(&self) -> bool {
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
            use windows_sys::Win32::System::Threading::WaitForSingleObject;
            unsafe {
                match WaitForSingleObject(self.handle as HANDLE, 0) {
                    WAIT_TIMEOUT => true,
                    WAIT_OBJECT_0 => false,
                    _ => false,
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            // إشارة 0 = «هل يستطيع هذا المعرّف أن يتلقّى إشارة؟»
            std::process::Command::new("kill")
                .args(["-0", &self.pid.to_string()])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }
    }

    /// **ينتظر موت العملية فعلاً** — بحدّ زمني — ويعيد هل ماتت.
    ///
    /// **لماذا لزم (عطل مقيس 2026-09-21)**: `cancel_job` كان يُصدر `taskkill`
    /// ويعود، و`taskkill` **يعود قبل أن يموت الهدف**. فقِيس أن `cancel_job`
    /// يعود والابن **حيّ** في **٧ من ٢٠ تشغيلاً** (~190 مللي)، وهذا يخالف
    /// الوعد المنشور «تُقتل مع شجرتها كاملة»، ويفتح نافذة تُحسب فيها المهمّة
    /// منتهية وعمليتها ما زالت تكتب. والانتظار على **مقبض العملية** (إشارة
    /// النواة) هو المقياس الصحيح: لا استطلاع اسم ولا تخمين.
    pub fn wait_gone(&self, timeout: Duration) -> bool {
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
            use windows_sys::Win32::System::Threading::WaitForSingleObject;
            let ms = timeout.as_millis().min(u32::MAX as u128) as u32;
            unsafe { WaitForSingleObject(self.handle as HANDLE, ms) == WAIT_OBJECT_0 }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let deadline = std::time::Instant::now() + timeout;
            while std::time::Instant::now() < deadline {
                if !self.is_alive() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            !self.is_alive()
        }
    }
}

impl Drop for ChildHandle {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
            if self.handle != 0 {
                unsafe {
                    CloseHandle(self.handle as HANDLE);
                }
            }
        }
    }
}

#[derive(Default)]
pub struct Phases {
    children: Vec<Arc<ChildHandle>>,
}

#[derive(Clone, Copy, Default)]
struct CtxSlot(*const JobCtx);

thread_local! {
    static CURRENT: std::cell::Cell<CtxSlot> = const { std::cell::Cell::new(CtxSlot(std::ptr::null())) };
    static DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// يضع سياق المهمّة على الخيط ويعيد حارساً يزيله في `Drop` — حتى عند الذعر
/// (فلا يبقى سياق مهمّة منتهية معلّقاً على خيط أُعيد استعماله).
pub struct CtxGuard;

impl Drop for CtxGuard {
    fn drop(&mut self) {
        DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
        if DEPTH.with(|d| d.get()) == 0 {
            CURRENT.with(|c| c.set(CtxSlot(std::ptr::null())));
        }
    }
}

/// يُثبّت السياق على هذا الخيط مدة حياة الحارس. التعشيش مدعوم (عدّ أعماق).
///
/// # Safety
/// المتصل يضمن أن `ctx` يبقى حيّاً ما دام الحارس (وهو ما يضمنه `slots.rs`
/// بإبقاء `Arc<JobCtx>` في `JobGuard` إلى نهاية الجسم).
pub fn enter(ctx: &JobCtx) -> CtxGuard {
    DEPTH.with(|d| d.set(d.get() + 1));
    CURRENT.with(|c| c.set(CtxSlot(ctx as *const JobCtx)));
    CtxGuard
}

/// السياق الجاري على هذا الخيط، إن كان هذا الخيط ينفّذ مهمّة.
pub fn current() -> Option<JobCtx> {
    CURRENT.with(|c| {
        let p = c.get().0;
        if p.is_null() {
            None
        } else {
            // الأمان: المؤشّر كُتب من `enter` و`CtxGuard` يعيده فارغاً قبل أن
            // يسقط مرجعه (انظر العقد في `enter`). والنسخ هنا **نسخة من قيم
            // الحقول** (`Arc`s) لا من الكائن المشار إليه.
            Some(unsafe { (*p).clone() })
        }
    })
}

/// رمز إلغاء المهمّة الجارية على هذا الخيط (None = لا مهمّة ⇒ لا إلغاء).
pub fn current_cancel() -> Option<CancelToken> {
    current().and_then(|c| c.cancel)
}

/// **يُجهّز قاتل الطفل**: مقبض مملوك + مهمّة نواة تحيط بشجرته. `None` إن فشل
/// استنساخ المقبض (لا قتل عندها — ولا ضرر).
///
/// **لماذا يُفصَل عن التسجيل**: مسار يقرأ مخرجات طفله بنفسه (تنزيل `yt-dlp`
/// يقرأ التقدّم سطراً سطراً) يحتاج القاتل **في يده** ليقتل به من حلقة
/// استطلاعه هو، ولو لم يكن على الخيط سياق مهمّة أصلاً (نداءات الجسر/الـCLI).
pub fn prepare_child(child: &Child) -> Option<Arc<ChildHandle>> {
    ChildHandle::new(child).map(Arc::new)
}

/// **تسجيل قاتل في سياق المهمّة الجارية على هذا الخيط**: يضمن أن
/// `cancel_job(id)` يقتل أبناء هذه المهمّة وحدها. ويبقى مسجَّلاً حتى
/// [`unregister_phase`] بعد حصاده — فلا نافذة زمنية بين الخروج والتسجيل.
/// وإرجاع `0` يعني «لم يُسجَّل» (لا مهمّة على هذا الخيط) — ولا قتل عندها ولا
/// ضرر (والقاتل يبقى بيد مستدعيه فيعمل من حلقته).
pub fn register_child(killer: &Arc<ChildHandle>) -> u32 {
    let pid = killer.pid;
    if let Some(ctx) = current() {
        if let Ok(mut p) = ctx.phases.lock() {
            p.children.push(killer.clone());
            return pid;
        }
    }
    0
}

/// إلغاء تسجيل العملية (بعد حصادها — فلا يقتل الإلغاء مقبضاً ميتاً).
pub fn unregister_phase(pid: u32) {
    if pid == 0 {
        return;
    }
    if let Some(ctx) = current() {
        if let Ok(mut p) = ctx.phases.lock() {
            p.children.retain(|h| h.pid != pid);
        }
    }
}

// ───────────────────────── تشغيل أداة قابلة للقتل ─────────────────────────

/// **مخرجات أداة بقابلية إلغاء**: نفس ما كانت `.output()` تعيده، لكن الحصاد
/// يقع في حلقة استطلاع لا في حجب أعمى.
pub struct ToolOutput {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// أنبوب يُقرأ على خيط مستقل — وإلا امتلأ (~64KB) فتعلّق الأداة إلى الأبد،
/// وهو ما كان `.output()` يفعله ضمنياً.
fn drain<R: Read + Send + 'static>(mut r: R, cap: usize) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 16384];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // سقف الذكرى: يُحتفظ بالذيل (سبب الفشل في آخره دائماً).
                    if buf.len() + n > cap {
                        let drop_n = (buf.len() + n - cap).min(buf.len());
                        buf.drain(..drop_n);
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
            }
        }
        buf
    })
}

/// **النداء الواحد** الذي يمرّ منه كل تشغيل أداة في مسار المنتج:
///
/// * `spawn()` بمقبض مسجَّل في سِجلّ المهمّة (وشجرته في مهمّة نواة)،
/// * استطلاع [`POLL`] مع فحص رمز الإلغاء ⇒ **قتل فوري للشجرة** ثم خطأ،
/// * عند النجاح/الفشل العادي: نفس المخرجات التي كانت `.output()` تعيدها.
///
/// `program` مسار صريح (لا `PATH`) لأن كل مستدعٍ في هذا المستودع يحلّ أداته
/// أولاً (`resolve_tool`) — فالسلوك الأمني كما كان.
pub fn run_cancellable(
    program: &Path,
    args: &[&str],
    cancel: Option<&CancelToken>,
) -> Result<ToolOutput, String> {
    run_cancellable_with_cap(program, &[], args, cancel, TAIL_CAP)
}

/// [`run_cancellable`] بسقف مخرجات صريح **ومتغيّرات بيئة للطفل**.
///
/// **ولماذا لزم السقف وسيطاً (مقيس ٢٠٢٦-٠٩-٢٤)**: نداء البيانات الوصفية في
/// مسار التنزيل (`--dump-single-json`) يُحلَّل **كاملاً** بـ`serde_json`، وسقف
/// الذيل الافتراضي (٢٥٦KB) يقصّ **أوّله** فيصير JSON غير مقروء. وقِيس على هذه
/// الآلة أن ردّ فيديو واحد (‏4K بعشرات الترجمات) **٦٦٣٬٤٩٥ بايتاً** ⇒ فتمريره
/// بالسقف الافتراضي كان سيكسر التنزيل. فالسقف هنا صريح عند المستدعي.
///
/// **و`envs` لا زينة**: نداء البيانات الوصفية كان يضبط
/// `PYTHONIOENCODING=utf-8` على أمره (عناوين عربية من مجرى بايثون)، وإسقاطه
/// مع نقل النداء كان سيُفسد الترميز — فيُمرَّر صراحةً.
pub fn run_cancellable_with_cap(
    program: &Path,
    envs: &[(&str, &str)],
    args: &[&str],
    cancel: Option<&CancelToken>,
    cap: usize,
) -> Result<ToolOutput, String> {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    spawn_and_wait(cmd, args, cancel, cap)
}

/// [`run_cancellable`] بوسائط من نوع `OsString` — تستعمله اختبارات اليتيم
/// (مسار أداة وهمية ووسائط مبنية في زمن التشغيل).
#[cfg(test)]
pub fn run_cancellable_cmd(
    program: &Path,
    args: &[std::ffi::OsString],
    cancel: Option<&CancelToken>,
) -> Result<ToolOutput, String> {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.args(args);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    wait_child_cap(child, cancel, TAIL_CAP)
}

fn spawn_and_wait(
    mut cmd: Command,
    args: &[&str],
    cancel: Option<&CancelToken>,
    cap: usize,
) -> Result<ToolOutput, String> {
    // **الحدّ هنا لا في المستدعي**: كل عمليات هذا المستودع تُشغَّل بمخرجات
    // موصولة تقرؤها خيوطنا — فلا طفل يكتب على أنبوب لا يقرؤه أحد.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.args(args);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    wait_child_cap(child, cancel, cap)
}

/// الحلقة الواحدة: تسجيل ⇒ استطلاع ⇒ (قتل) ⇒ حصاد ⇒ مخرجات.
///
/// **ومساران للإلغاء لا مسار واحد** — وقد قِيس أيّهما الحارس وأيّهما تحسين الزمن:
/// * **فحص الرمز في هذه الحلقة هو الحارس**: بإسقاطه لا يبقى لمن ضُبط رمزه قبل
///   ولادة طفله من يقتله، فينتهي النوم كاملاً (قِيس بمُفسَد: الأداة نائمة ٦٠ ث
///   تعود كاملة). ولذلك له اختبار يقيس **الزمن الفعلي** لا علامةً تُكتب لاحقاً:
///   `slots::tests::a_cancelled_tool_reports_cancellation_and_leaves_no_output`.
/// * **والقتل المباشر في `cancel_job` تحسين زمن** لا الحارس (التعليل الكامل في
///   [`kill_children`]): بدونه يقتل هذا الفحص الشجرةَ بعد دورة استطلاع.
///   وحين يسبق القتلُ المباشر الحلقة، يصل الطفل مقتولاً بـ`Ok(Some(_))` ورمز
///   الإلغاء مضبوط ⇒ **يُقرأ إلغاءً لا فشلاً**، وإلا صار المُدمِج المقتول
///   «خطأ أداة» كاذباً (وهو ما رصده مُفسَد د حرفياً).
///
/// وبسقف مخرجات صريح (انظر [`run_cancellable_with_cap`]).
fn wait_child_cap(
    mut child: Child,
    cancel: Option<&CancelToken>,
    cap: usize,
) -> Result<ToolOutput, String> {
    // القاتل **في اليد** لا في السِجلّ وحده: به يُقتل الطفل من هذه الحلقة ولو
    // لم يكن على الخيط سياق مهمّة (فلا نافذة تعتمد على وجود سياق).
    let killer = prepare_child(&child);
    let pid = match killer.as_ref() {
        Some(k) => register_child(k),
        None => 0,
    };
    // قتل الطفل وشجرته بالأداة الأقوى المتاحة (مهمّة النواة إن أُسند إليها).
    let kill_now = |pid: u32| match killer.as_ref() {
        Some(k) => k.kill(),
        None => kill_tree(pid),
    };
    let out_thread = child.stdout.take().map(|s| drain(s, cap));
    let err_thread = child.stderr.take().map(|s| drain(s, cap));
    let mut killed = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                // قُتل من `cancel_job` (أو من خارجنا) والرمز مضبوط ⇒ إلغاء.
                if cancel.map(|c| c.is_cancelled()).unwrap_or(false) {
                    killed = true;
                }
                break st;
            }
            Ok(None) => {}
            Err(e) => {
                // مقبض فسد (نادر): لا نُيتّم الطفل — نقتل شجرته ثم نُبلّغ.
                kill_now(pid);
                let _ = child.wait();
                let _ = collect(out_thread, err_thread);
                unregister_phase(pid);
                return Err(e.to_string());
            }
        }
        if !killed && cancel.map(|c| c.is_cancelled()).unwrap_or(false) {
            // **قتل فوري** للعمليات المنفصلة (قرار المالك): لا انتظار دورة
            // أخرى ولا نهاية الملف.
            tracing::warn!(target: "proc", "إلغاء: قتل شجرة العملية {pid} (ومعها مخدّم مدمجها)");
            kill_now(pid);
            killed = true;
        }
        std::thread::sleep(POLL);
    };
    if killed {
        // مهلة قصيرة لحصاد الشجرة كلها: بلا هذا قد يعود الخطأ قبل أن يموت
        // المُدمِج فعلاً — فيُقاس «يتيم» بعد الإلغاء بلا سبب.
        let _ = child.wait();
    }
    let (stdout, stderr) = collect(out_thread, err_thread);
    unregister_phase(pid);
    if killed {
        // لا `child.wait()` هنا: الطفل يُحصَد في الحلقة (`try_wait`)، ونداء
        // حصاد ثانٍ على طفل محصود يعيد Err على ويندوز (ERROR_INVALID_HANDLE)
        // فيُسجَّل فشل كاذب في مسار الإلغاء نفسه.
        return Err(CANCELLED.into());
    }
    Ok(ToolOutput {
        status,
        stdout,
        stderr,
    })
}

/// الرسالة الواحدة للإلغاء — مصدر واحد لكل مسار (لا نصّان يفترقان).
pub const CANCELLED: &str = "أُلغيت المعالجة";

/// هل وقع الإلغاء؟ — فحص موحّد: `None` (بلا مهمّة) ⇒ لا. **للاختبار**: مسار
/// الإنتاج يستعمل `cancel.is_cancelled()` مباشرةً (فلا لفّ بلا داعٍ).
#[cfg(test)]
pub fn cancelled(cancel: Option<&CancelToken>) -> bool {
    cancel.map(|c| c.is_cancelled()).unwrap_or(false)
}

fn collect(
    out: Option<std::thread::JoinHandle<Vec<u8>>>,
    err: Option<std::thread::JoinHandle<Vec<u8>>>,
) -> (Vec<u8>, Vec<u8>) {
    let o = out
        .map(|t| t.join().unwrap_or_default())
        .unwrap_or_default();
    let e = err
        .map(|t| t.join().unwrap_or_default())
        .unwrap_or_default();
    (o, e)
}

// ───────────────────────── قتل الشجرة ─────────────────────────

/// اقتل عملية و**شجرتها كلها** (ويندوز: `taskkill /T /F` · يونكس: `kill`).
///
/// `child.kill()` وحده **يترك مُدمِج ffmpeg يتيماً** (التعليل المنقول حرفياً من
/// `yt_dlp.rs:1275` حيث كان هذا المساعد، وقد أُثبت العطل باختبار اليتيم في م٢).
pub fn kill_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .and_then(|mut c| wait_with_deadline(&mut c, KILL_WAIT));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .and_then(|mut c| wait_with_deadline(&mut c, KILL_WAIT));
    }
}

/// انتظار طفل بمهلة (لا `.output()` — كان يحجب بلا سقف).
fn wait_with_deadline(
    child: &mut Child,
    limit: Duration,
) -> std::io::Result<std::process::ExitStatus> {
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return Ok(st),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                return child.wait();
            }
            Err(e) => return Err(e),
        }
    }
}

// ── **حُذف `join_reader_threads` و`Phases.threads` (م٢/إصلاح)** ──────────────
// وكانا وعداً غير منفَّذ: الحقل `threads` **لا يُكتب فيه قطّ**، فالدالّة كانت
// تأخذ متجهاً فارغاً دائماً، والضمان المُعلَن («خيوط القراءة تُضمّ قبل إلغاء
// التسجيل») **معطّل** والتعليق غير صادق.
//
// **ولماذا الحذف لا الملء**: الضمان **قائم فعلاً** في مكانه الصحيح — كل نداء
// أداة يضمّ خيطَي القراءة بنفسه في `collect` **قبل** `unregister_phase`
// (انظر `wait_child_cap`: كل مسارات الخروج تمرّ بـ`collect`)، فلا يبقى قارئ على
// أنبوب طفل بعد عودته. وملء `threads` كان سيقتضي تسليم ملكية `JoinHandle` إلى
// `Phases` ثم سحبها — أي إعادة تصميم لضمانٍ هو اليوم بنيوي. ومن أضاف مساراً
// يُنشئ قارئاً **خارج** `wait_child_cap` عليه أن يعيد الضمان صراحةً.

/// **نتيجة القتل المباشر** — رقمان لا رقم: الأول عمليات حيّة وُجدت وقُتلت،
/// والثاني مهمّات نواة أُنهيت. **ولماذا رقمان**: `yt-dlp.exe` عمليّتان، وقد
/// يموت المُشغّل (المقبض المسجَّل) ويبقى العامل حيّاً — فعدّ الأول وحده يقول
/// «صفر» و`TerminateJobObject` يكون قد قتل عاملاً حيّاً فعلاً (وهو ما قِيس).
/// فالسطر في السجلّ يجب أن يحمل الحقيقتين لا واحدة.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct KillReport {
    pub alive_children: usize,
    pub jobs_terminated: usize,
}

/// يقتل كل أبناء مهمّة — يُنادى من `slots::cancel_job` فور ضبط الرمز. ويُسأل
/// **المقبض المملوك** لا الرقم: `is_alive()` على مقبض مفتوح بيدنا لا يمكن أن
/// يكون عملية أخرى (PID محجوز ما دام المقبض) ⇒ خطر إعادة استخدام المعرّف
/// **مُبطَل بالبنية** لا بالاحتياط.
///
/// ## **ما هذا المسار بالضبط: تحسين زمن لا الحارس** (توثيق صريح، م٢/إصلاح)
///
/// إن حُذف هذا النداء من `cancel_job` فالإلغاء **يبقى يعمل**: حلقة الاستطلاع في
/// [`wait_child_cap`] (وحلقة مسار التنزيل) تقرأ الرمز فتُنادي القاتل بنفسها. فالفرق
/// بين الوجودَين **زمني**: مع القتل المباشر يعود الطلب بعد أن صارت الشجرة ميتة
/// فعلاً (قِيس 169 مللي = زمن `taskkill /T /F`)، وبدونه يعود الطلب فوراً
/// **والشجرة حيّة** حتى دورة الاستطلاع التالية ([`POLL`] = 200 مللي) ثم يستغرق
/// قتلها زمن `taskkill` آخر. ولأن الفرق زمنيّ لا وظيفي، ثُبِّت بقياس زمني صريح
/// (`slots::tests::the_direct_kill_returns_only_after_the_tree_is_dead`) وله
/// **مُفسَد** يُسقطه: إسقاط هذا النداء ⇒ يفشل عدّاد القتل المباشر وقياس الحياة.
///
/// ## ما لا ينوب عنه (الفرق الذي يجعل المسارَين معاً لازمين)
///
/// مقبضٌ مسجَّل يخصّ **نداءً آخر** من نداءات المهمّة، أو طفلاً وُلد قبل ضبط
/// الرمز: حلقة تُنهي أداةً واحدة بعينها، وهذا يقتل كل ما سُجِّل للمهمّة.
///
/// ## **والـJob تُنهى دائماً — ولو مات الطفل المسجَّل** (م٣/إصلاح٢)
///
/// هذا موضع العطل المقيس: المُشغّل يموت والعامل يبقى، فسؤال «هل المقبض حيّ؟»
/// يجيب «لا» ولا يقتل شيئاً. فمتى وُجدت مهمّة نواة **تُنهى** — فهي الوعاء الذي
/// يحمل العامل الناجي، والنواة تقتله بلا حاجة إلى معرّف أبيه.
pub fn kill_children(ctx: &JobCtx) -> KillReport {
    let handles: Vec<Arc<ChildHandle>> = match ctx.phases.lock() {
        Ok(mut p) => std::mem::take(&mut p.children),
        Err(p) => std::mem::take(&mut p.into_inner().children),
    };
    let mut report = KillReport::default();
    for h in handles {
        let alive = h.is_alive();
        // **الـJob أولاً ودائماً**: قد تحمل عاملاً حيّاً مات مُشغّله.
        let killed_by_job = {
            #[cfg(target_os = "windows")]
            {
                match h.job.as_ref() {
                    Some(job) => {
                        job.terminate();
                        report.jobs_terminated += 1;
                        true
                    }
                    None => false,
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                false
            }
        };
        if alive {
            // مهمّة النواة إن وُجدت تكفّلت بالشجرة كلها؛ وإلا `taskkill /T /F`.
            if !killed_by_job {
                kill_tree(h.pid);
            }
            report.alive_children += 1;
            // **ولا يكفي إصدار الأمر**: ‏`taskkill` يعود قبل أن يموت الهدف،
            // وقِيس (٢٠ تشغيلاً) أن `cancel_job` كان يعود **والابن حيّ** في
            // **٧ منها** (~190 مللي) — وهذا يخالف الوعد المنشور «تُقتل مع شجرتها
            // كاملة»، ويفتح نافذة تُحسب فيها المهمّة منتهية وعمليتها ما زالت
            // تكتب. فالانتظار على مقبض العملية هو ما يجعل العودة تعني «ماتت»
            // لا «أُمرت بالموت».
            if !h.wait_gone(KILL_CONFIRM_WAIT) {
                tracing::warn!(
                    target: "proc",
                    "الابن (pid={}) لم يمت خلال {:?} من أمر القتل — قد يبقى يعمل",
                    h.pid,
                    KILL_CONFIRM_WAIT
                );
            }
        }
        // المقبض يسقط هنا (يُغلق، ومعه مهمّة النواة) — والحلقة في خيط الأداة
        // ترى الإلغاء فتُكمل الحصاد وإلغاء التسجيل.
    }
    #[cfg(test)]
    DIRECT_KILLS.fetch_add(report.alive_children, Ordering::SeqCst);
    report
}

/// **عدّاد قياس للاختبار وحده**: كم طفلاً حيّاً قتله **القتل المباشر** من
/// `cancel_job` (لا حلقة الاستطلاع). وجودُه هو ما يجعل «تحسين الزمن» في
/// [`kill_children`] **مقيساً** لا موصوفاً: إسقاط النداء يُصفّر هذا العدّاد.
#[cfg(test)]
pub static DIRECT_KILLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
mod tests {
    use super::*;

    /// **رمز المهمّة الواحد**: ما يضبطه `cancel_job` هو نفسه ما يقرؤه الجسم —
    /// نسخُ `CancelToken` تشير إلى العلم نفسه (ولو كانت نسخاً مستقلّة لكان
    /// الإلغاء يضبط رمزاً ولا يراه القارئ، وهو **العطل الأصلي** في م١).
    #[test]
    fn cloned_tokens_share_one_flag() {
        let token = CancelToken::new();
        let handed_to_body = token.clone();
        let polled_in_media = token.clone();
        assert!(!handed_to_body.is_cancelled());
        assert!(!cancelled(None), "بلا مهمّة ⇒ لا إلغاء");
        assert!(!cancelled(Some(&polled_in_media)));
        token.set();
        assert!(handed_to_body.is_cancelled(), "نسخة الجسم ترى الإلغاء");
        assert!(polled_in_media.is_cancelled(), "ونسخة نداء الأداة تراه");
        assert!(cancelled(Some(&handed_to_body)));
        assert!(!CancelToken::new().is_cancelled(), "رمز مهمّة أخرى لا يتأثّر");
    }

    // ── و٢: قتل الشجرة بمحاولة **واحدة** — بالـJob وبالاحتياط ──────────────
    //
    // **الفراغ المقيس الذي وُلد منه هذا القسم**: كل حرّاس الشجرة القائمة تمرّ
    // بمهمّة نواة **مُسندة**، فأي مُفسَد يعطّل الإسناد (فشل `CreateJobObject` أو
    // `AssignProcessToJobObject`) يبقى **غير مُسقَط**: القتل الاحتياطي
    // (`taskkill /T /F`) يقتل شجرةً سليمة الجذر فتمرّ الاختبارات كلها. فحارسان
    // هنا: أحدهما يقيس **الاحتياط** بلا مهمّة، والآخر يقيس الـ**Job** في البنية
    // التي لا يبلغها الاحتياط أصلاً (عامل حيّ مات مُشغّله).

    /// مهلة تأكيد الموت في حرّاس و٢ (سخيّة عمداً: موت النواة في مللي ثوانٍ،
    /// والمهلة ليست القياس — القياس أن الانتظار **على مقبض العملية** لا نوم).
    #[cfg(windows)]
    const DEATH_WAIT: Duration = Duration::from_secs(5);

    /// مهلة انتظار خروج **المُشغّل بنفسه** (تشغيل `pwsh` + إطلاق العامل + خروجه).
    #[cfg(windows)]
    const LAUNCHER_EXIT_WAIT: Duration = Duration::from_secs(30);

    /// مجلد عمل فريد لكل تشغيل، **يرفض أن يكون غير فارغ** (لا قياس على أثر
    /// سابق — الدرس نفسه في `slots::tests::tmp_dir`).
    #[cfg(windows)]
    fn tree_dir(tag: &str) -> std::path::PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("hl_proc_{}_{}_{}", std::process::id(), tag, n));
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        std::fs::create_dir_all(&dir).expect("مجلد عمل الاختبار");
        assert!(
            std::fs::read_dir(&dir)
                .map(|mut i| i.next().is_none())
                .unwrap_or(false),
            "مجلد العمل يجب أن يكون فارغاً: {}",
            dir.display()
        );
        dir
    }

    /// علامة ذرّية لهذا الاختبار وحده (في سطر أوامر كل عملية من شجرته) فيُميَّز
    /// أثرُه عن أي عملية أخرى عند الجرد اليدوي أو التنظيف.
    #[cfg(windows)]
    fn tree_token(tag: &str) -> String {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        format!(
            "hl-w2-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        )
    }

    /// **شجرة من عمليتين حقيقيتين** بلا شبكة ولا تنزيل: مُشغّل `pwsh` يُنشئ
    /// عاملاً `pwsh` نائماً ويكتب رقمه في `pid_file`.
    ///
    /// * `trigger`: المُشغّل **لا يُنشئ عامله** حتى يوجد هذا الملف — فالاختبار
    ///   يُنشئه **بعد** أن يمسك المقبض المسجَّل، فيُولد العامل **داخل** المهمّة
    ///   (عضوية موروثة) بلا سباق زمني. وهذا ما يجعل القياس حتميّاً: بلا الإشارة
    ///   قد يُولد العامل قبل الإسناد فلا يكون في المهمّة أصلاً.
    /// * `launcher_secs = 0` ⇒ المُشغّل **يخرج بنفسه** فور ولادة عامله، فيبقى
    ///   العامل وحده حيّاً — بنية العطل الميداني المقيس في هذا الملف.
    #[cfg(windows)]
    fn tree_command(
        trigger: &Path,
        pid_file: &Path,
        launcher_secs: u32,
        worker_secs: u32,
        token: &str,
    ) -> (String, Vec<std::ffi::OsString>) {
        let worker = format!("Start-Sleep -Seconds {worker_secs}; # {token}");
        let tail = if launcher_secs == 0 {
            "exit 0".to_string()
        } else {
            format!("Start-Sleep -Seconds {launcher_secs}; # {token}")
        };
        let launcher = format!(
            "while (-not (Test-Path '{}')) {{ Start-Sleep -Milliseconds 20 }}; \
             $c = Start-Process -FilePath 'pwsh' -ArgumentList '-NoProfile','-NonInteractive','-Command',\"{worker}\" -PassThru -WindowStyle Hidden; \
             Set-Content -Path '{}' -Value $c.Id; {tail}",
            trigger.display(),
            pid_file.display(),
        );
        (
            "pwsh".to_string(),
            ["-NoProfile", "-NonInteractive", "-Command", &launcher]
                .iter()
                .map(std::ffi::OsString::from)
                .collect(),
        )
    }

    /// **ضابط موجب**: رقم العامل من ملفه — **رقم مقروء لا ملفٌّ موجود**.
    ///
    /// (درس هذا المستودع: `Set-Content` يُنشئ الملف **ثم** يكتب فيه، فقراءة
    /// سابقة تُعطي نصّاً فارغاً ورُصد `ParseIntError { kind: Empty }`.)
    #[cfg(windows)]
    fn wait_for_worker_pid(pid_file: &Path) -> u32 {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            if let Ok(pid) = std::fs::read_to_string(pid_file)
                .unwrap_or_default()
                .trim()
                .parse::<u32>()
            {
                return pid;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "رقم العامل لم يُكتب خلال 30 ث ({}) — القياس بلا شجرة باطل",
            pid_file.display()
        );
    }

    /// مقبض انتظار نواة على عملية (`SYNCHRONIZE`). `None` = لا عملية بهذا المعرّف.
    #[cfg(windows)]
    fn wait_handle(pid: u32) -> Option<isize> {
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        (!h.is_null()).then_some(h as isize)
    }

    /// هل العملية حيّة الآن؟ — **سؤال النواة** على مقبضها لا استطلاع اسم.
    #[cfg(windows)]
    fn handle_alive(handle: isize) -> bool {
        use windows_sys::Win32::Foundation::{HANDLE, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        unsafe { WaitForSingleObject(handle as HANDLE, 0) == WAIT_TIMEOUT }
    }

    /// **ينتظر موت العملية فعلاً** على مقبضها بحدّ زمني — لا نوم يخمّن نجاحاً.
    #[cfg(windows)]
    fn handle_wait_death(handle: isize, timeout: Duration) -> bool {
        use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        let ms = timeout.as_millis().min(u32::MAX as u128) as u32;
        unsafe { WaitForSingleObject(handle as HANDLE, ms) == WAIT_OBJECT_0 }
    }

    #[cfg(windows)]
    fn close_wait_handle(handle: isize) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        unsafe {
            CloseHandle(handle as HANDLE);
        }
    }

    /// تنظيف اختبار (لا قياس): يقتل شجرة معرّف حتى لا يبقى يتيم نائم بعد فشل
    /// تأكيد — ويُنادى **قبل** الحكم لا بعده.
    #[cfg(windows)]
    fn cleanup_pid(pid: u32) {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
    }

    /// **و٢/حارس أ — المسار الاحتياطي: بلا مهمّة نواة، القتل يقع بمحاولة واحدة.**
    ///
    /// الفراغ المقيس: كل حرّاس الشجرة القائمة تمرّ بمهمّة **مُسندة**، فلو لم
    /// تُسجَّل العملية في Job (فشل الإنشاء أو الإسناد ⇒ `attach → None`) لم يكن
    /// في المستودع ما يقيس أن القتل الاحتياطي (`taskkill /T /F`) يقتل شجرةً من
    /// عمليتين بمحاولة **واحدة**. هنا المقبض بلا مهمّة
    /// ([`ChildHandle::without_job`] = مسار `attach → None` بعينه)، والشجرة
    /// **عمليتان حيّتان**: مُشغّل `pwsh` وعامله النائم.
    ///
    /// **بلا ادّعاء زائف**: ضابطان موجبان قبل القتل (المُشغّل حيّ بمقبضه ·
    /// والعامل حيّ بمقبضه)، ثم نداء **واحد** لـ[`ChildHandle::kill`]، ثم
    /// **انتظار نواة** على المقبضين حتى الموت مع قياس زمنه — لا نوم يخمّن نجاحاً.
    ///
    /// **والمُفسَد الذي يُسقطه**: إسقاط `kill_tree(self.pid)` من
    /// [`ChildHandle::kill`] ⇒ لا يموت شيء ويسقط التأكيد (قِيس).
    #[cfg(windows)]
    #[test]
    fn the_fallback_kills_a_two_process_tree_in_one_attempt() {
        let dir = tree_dir("fallback");
        let trigger = dir.join("trigger");
        let pid_file = dir.join("worker.pid");
        let token = tree_token("fallback");
        let (program, args) = tree_command(&trigger, &pid_file, 120, 120, &token);
        let mut launcher = Command::new(&program)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("إطلاق المُشغّل");
        // المقبض المملوك **بلا مهمّة نواة**: مسار `attach → None` بعينه.
        let killer = ChildHandle::without_job(&launcher).expect("مقبض مملوك للشجرة");
        // الإذن: العامل يُولد **بعد** أن أمسكنا المقبض ⇒ داخل الشجرة المقيسة.
        std::fs::write(&trigger, b"go").expect("إشارة الإطلاق");
        let worker_pid = wait_for_worker_pid(&pid_file);
        let worker = wait_handle(worker_pid).expect("مقبض انتظار على العامل");
        // ضابطان موجبان: **الاثنان حيّان** لحظة القياس (وإلا فُسر «مات» على لا شيء).
        assert!(killer.is_alive(), "المُشغّل ميت قبل القتل — القياس باطل");
        assert!(
            handle_alive(worker),
            "العامل {worker_pid} ميت قبل القتل — القياس باطل"
        );
        // **محاولة واحدة** — لا حلقة استطلاع ولا نداء ثانٍ.
        let started = std::time::Instant::now();
        killer.kill();
        let launcher_gone = killer.wait_gone(DEATH_WAIT);
        let worker_gone = handle_wait_death(worker, DEATH_WAIT);
        let elapsed = started.elapsed();
        // تنظيف **قبل الحكم**: فشل التأكيد لا يترك عاملاً نائماً 120 ث.
        if !worker_gone {
            cleanup_pid(worker_pid);
        }
        let _ = launcher.kill();
        let _ = launcher.wait();
        close_wait_handle(worker);
        eprintln!(
            "و٢/الاحتياط (بلا Job): المُشغّل pid={} · العامل pid={worker_pid} · محاولة واحدة ⇒ \
             المُشغّل مات={launcher_gone} · العامل مات={worker_gone} · الزمن {elapsed:?} · العلامة {token}",
            killer.pid
        );
        assert!(
            launcher_gone,
            "المُشغّل (pid={}) لم يمت بـtaskkill /T /F — القتل الاحتياطي معطَّل",
            killer.pid
        );
        assert!(
            worker_gone,
            "العامل (pid={worker_pid}) نجا بعد محاولة قتل واحدة — إسقاط القتل الاحتياطي لا يُسقط شيئاً"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **و٢/حارس ب — المحاولة الواحدة تُدرك عاملاً حيّاً مات مُشغّله.**
    ///
    /// هذه بنية العطل الميداني المقيس في هذا الملف (م٣/إصلاح٢): العمليتان
    /// (`yt-dlp.exe` مُشغّل + عامل)، والمُشغّل يموت والعامل يبقى — و`taskkill /T`
    /// **لا يبلغه** (لم يبق لمعرّف أبيه أثر في الشجرة). فالوعاء الوحيد الذي
    /// يبلغه هو مهمّة النواة.
    ///
    /// القياس على **المسار الإنتاجي** ([`prepare_child`] ⇒ [`ChildHandle::kill`]):
    /// المُشغّل **يخرج بنفسه** بعد ولادة عامله (لا بأمر منّا)، ويُقاس أن العامل
    /// ما زال حيّاً بعد موت مُشغّله، ثم **محاولة واحدة** للقتل يجب أن تُنهيه —
    /// والانتظار على **مقبض العملية** بحدّ زمني، لا نوم.
    ///
    /// **والمُفسَد الذي يُسقطه**: تعطيل الإسناد (`attach → None`، أي كأن
    /// `CreateJobObject`/`AssignProcessToJobObject` فشل) ⇒ `kill()` يسلك
    /// `taskkill` على معرّف مُشغّل **ميت** فلا يقتل شيئاً ⇒ العامل ينجو ويسقط
    /// التأكيد (قِيس).
    #[cfg(windows)]
    #[test]
    fn one_kill_attempt_reaches_the_worker_after_its_launcher_died() {
        let dir = tree_dir("job_orphan");
        let trigger = dir.join("trigger");
        let pid_file = dir.join("worker.pid");
        let token = tree_token("job-orphan");
        // `launcher_secs = 0`: المُشغّل يخرج بنفسه فور ولادة عامله.
        let (program, args) = tree_command(&trigger, &pid_file, 0, 120, &token);
        let mut launcher = Command::new(&program)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("إطلاق المُشغّل");
        // **المسار الإنتاجي**: نفس الدالة التي يناديها `wait_child_cap`.
        let killer = prepare_child(&launcher).expect("قاتل الطفل (مقبض مملوك + مهمّة)");
        std::fs::write(&trigger, b"go").expect("إشارة الإطلاق");
        let worker_pid = wait_for_worker_pid(&pid_file);
        let worker = wait_handle(worker_pid).expect("مقبض انتظار على العامل");
        assert!(
            handle_alive(worker),
            "العامل {worker_pid} ميت قبل القياس — القياس باطل"
        );
        // ضابط موجب للبنية: **المُشغّل يموت بنفسه والعامل يبقى**.
        assert!(
            killer.wait_gone(LAUNCHER_EXIT_WAIT),
            "المُشغّل (pid={}) لم يخرج بنفسه خلال {LAUNCHER_EXIT_WAIT:?} — البنية غير قائمة",
            killer.pid
        );
        assert!(
            handle_alive(worker),
            "العامل {worker_pid} مات مع مُشغّله — لا يتيم يُقاس (بناء الشجرة خطأ)"
        );
        // **محاولة واحدة** — `kill()` هي نداء الإنتاج (مهمّة النواة إن أُسندت).
        let started = std::time::Instant::now();
        killer.kill();
        let worker_gone = handle_wait_death(worker, DEATH_WAIT);
        let elapsed = started.elapsed();
        if !worker_gone {
            cleanup_pid(worker_pid);
        }
        let _ = launcher.kill();
        let _ = launcher.wait();
        close_wait_handle(worker);
        eprintln!(
            "و٢/الـJob (مُشغّل ميت + عامل حيّ): المُشغّل pid={} خرج بنفسه · العامل pid={worker_pid} · \
             محاولة واحدة ⇒ العامل مات={worker_gone} · الزمن {elapsed:?} · العلامة {token}",
            killer.pid
        );
        assert!(
            worker_gone,
            "العامل (pid={worker_pid}) نجا بعد محاولة قتل واحدة ومُشغّله ميت — الـJob لم تحمله"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
