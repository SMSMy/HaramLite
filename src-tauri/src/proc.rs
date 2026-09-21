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
//! * [`register_phase`] — تسجيل **مقبض** العمليات الفرعية الحيّة في سياق المهمّة
//!   الجارية **على هذا الخيط**. ولذلك نُسجّل المقبض (`Child`) لا الرقم وحده:
//!   بين قراءة PID وقتله قد يموت الطفل ويُعاد استخدام المعرّف، فتقع `taskkill`
//!   على عملية بريئة (الخطر مصرَّح به في `yt_dlp.rs:1103`). والمقبض الذي لم
//!   يُحصَد بعد (`try_wait() == Ok(None)`) دليل حياة **ملكُنا** لا يشاركنا فيه
//!   غيرنا.
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

/// **مقبض عملية مملوك لا رقم**: مرجعنا إلى العملية الفرعية هو **مقبض نواة**
/// مُستنسخ (`DuplicateHandle`)، لا `u32`.
///
/// **لماذا هذا هو العلاج الصحيح لخطر إعادة استخدام PID**: `Child` في المكتبة
/// القياسية **ليس `Clone`**، ومقبضه يُغلق عند حصاده — فلو سجّلنا الرقم وحده
/// لأمكن أن يموت الطفل ويُعاد استخدام معرّفه قبل وصول `taskkill`، فتقع على
/// عملية **بريئة** (الخطر مصرَّح به في `yt_dlp.rs:1103`). ومقبض مملوك **يُبقي
/// معرّف العملية محجوزاً في النواة** ما دام مفتوحاً ⇒ الاستخدام الآمن:
/// `WaitForSingleObject(handle, 0)` يقول «حيّة» أو «انتهت» بلا أي التباس،
/// ثم `taskkill /T /F /PID` يقتل الشجرة كاملة.
#[derive(Clone)]
pub struct ChildHandle {
    pub pid: u32,
    handle: isize,
}

impl ChildHandle {
    /// مقبض من طفل حيّ. `None` إن فشل الاستنساخ (لا قتل عندها — ولا ضرر).
    pub fn new(child: &Child) -> Option<Self> {
        #[cfg(target_os = "windows")]
        {
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
                Some(Self {
                    pid: child.id(),
                    handle: dup as isize,
                })
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            Some(Self {
                pid: child.id(),
                handle: 0,
            })
        }
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
    children: Vec<ChildHandle>,
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

/// **تسجيل عملية فرعية قبل تشغيلها**: يضمن أن `cancel_job(id)` يقتل أبناء هذه
/// المهمّة وحدها. والطفل يبقى مسجَّلاً حتى [`unregister_phase`] بعد حصاده —
/// فلا نافذة زمنية بين الخروج والتسجيل. وإرجاع `0` يعني «لم يُسجَّل مقبض»
/// (لا مهمّة على هذا الخيط، أو فشل الاستنساخ) — ولا قتل عندها ولا ضرر.
pub fn register_phase(child: &Child) -> u32 {
    let pid = child.id();
    let Some(handle) = ChildHandle::new(child) else {
        return 0;
    };
    if let Some(ctx) = current() {
        if let Ok(mut p) = ctx.phases.lock() {
            p.children.push(handle);
            return pid;
        }
    }
    // لا مهمّة على هذا الخيط ⇒ المقبض يُسقط الآن (لا تسريب مقابض).
    drop(handle);
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
fn drain<R: Read + Send + 'static>(mut r: R) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 16384];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // سقف الذكرى: يُحتفظ بالذيل (سبب الفشل في آخره دائماً).
                    if buf.len() + n > TAIL_CAP {
                        let drop_n = (buf.len() + n - TAIL_CAP).min(buf.len());
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
/// * `spawn()` بمقبض مسجَّل في سِجلّ المهمّة،
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
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    spawn_and_wait(cmd, args, cancel)
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
    wait_child(child, cancel)
}

fn spawn_and_wait(
    mut cmd: Command,
    args: &[&str],
    cancel: Option<&CancelToken>,
) -> Result<ToolOutput, String> {
    // **الحدّ هنا لا في المستدعي**: كل عمليات هذا المستودع تُشغَّل بمخرجات
    // موصولة تقرؤها خيوطنا — فلا طفل يكتب على أنبوب لا يقرؤه أحد.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.args(args);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    wait_child(child, cancel)
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
fn wait_child(mut child: Child, cancel: Option<&CancelToken>) -> Result<ToolOutput, String> {
    let pid = register_phase(&child);
    let out_thread = child.stdout.take().map(drain);
    let err_thread = child.stderr.take().map(drain);
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
                kill_tree(pid);
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
            kill_tree(pid);
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
// (انظر `wait_child`: كل مسارات الخروج تمرّ بـ`collect`)، فلا يبقى قارئ على
// أنبوب طفل بعد عودته. وملء `threads` كان سيقتضي تسليم ملكية `JoinHandle` إلى
// `Phases` ثم سحبها — أي إعادة تصميم لضمانٍ هو اليوم بنيوي. ومن أضاف مساراً
// يُنشئ قارئاً **خارج** `wait_child` عليه أن يعيد الضمان صراحةً.

/// يقتل كل أبناء مهمّة **أحياءً فقط** — يُنادى من `slots::cancel_job` فور ضبط
/// الرمز. ويُسأل **المقبض المملوك** لا الرقم: `is_alive()` على مقبض مفتوح
/// بيدنا لا يمكن أن يكون عملية أخرى (PID محجوز ما دام المقبض) ⇒ خطر إعادة
/// استخدام المعرّف **مُبطَل بالبنية** لا بالاحتياط.
///
/// ## **ما هذا المسار بالضبط: تحسين زمن لا الحارس** (توثيق صريح، م٢/إصلاح)
///
/// إن حُذف هذا النداء من `cancel_job` فالإلغاء **يبقى يعمل**: حلقة الاستطلاع في
/// [`wait_child`] تقرأ الرمز فتُنادي `kill_tree` بنفسها. فالفرق بين الوجودَين
/// **زمني**: مع القتل المباشر يعود الطلب بعد أن صارت الشجرة ميتة فعلاً
/// (قِيس 169 مللي = زمن `taskkill /T /F`)، وبدونه يعود الطلب فوراً **والشجرة
/// حيّة** حتى دورة الاستطلاع التالية ([`POLL`] = 200 مللي) ثم يستغرق قتلها
/// زمن `taskkill` آخر. ولأن الفرق زمنيّ لا وظيفي، ثُبِّت بقياس زمني صريح
/// (`slots::tests::the_direct_kill_returns_only_after_the_tree_is_dead`) وله
/// **مُفسَد** يُسقطه: إسقاط هذا النداء ⇒ يفشل عدّاد القتل المباشر وقياس الحياة.
///
/// ## ما لا ينوب عنه (الفرق الذي يجعل المسارَين معاً لازمين)
///
/// مقبضٌ مسجَّل يخصّ **نداءً آخر** من نداءات المهمّة، أو طفلاً وُلد قبل ضبط
/// الرمز: الحلقة تُنهي أداةً واحدة بعينها، وهذا يقتل كل ما سُجِّل للمهمّة.
pub fn kill_children(ctx: &JobCtx) -> usize {
    let handles: Vec<ChildHandle> = match ctx.phases.lock() {
        Ok(mut p) => std::mem::take(&mut p.children),
        Err(p) => std::mem::take(&mut p.into_inner().children),
    };
    let mut killed = 0;
    for h in handles {
        if h.is_alive() {
            kill_tree(h.pid);
            killed += 1;
        }
        // المقبض يسقط هنا (يُغلق) — والحلقة في خيط الأداة ترى الإلغاء فتُكمل
        // الحصاد وإلغاء التسجيل.
    }
    #[cfg(test)]
    DIRECT_KILLS.fetch_add(killed, Ordering::SeqCst);
    killed
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
}
