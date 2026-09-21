//! Shared processing pipeline used by BOTH the GUI (Tauri commands) and the
//! CLI entrypoint. Single source of truth — no duplicated logic.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::proc::CancelToken;
use crate::{decide, media, separator, silence, v1proto};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// أغنية: فصل + مؤثرات إعادة حياة + قص صمت
    Song,
    /// مقطع عادي: إزالة موسيقى فقط
    Clip,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "song" | "music" | "اغنية" | "أغاني" => Some(Self::Song),
            "clip" | "normal" | "مقطع" => Some(Self::Clip),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutFormat {
    Wav,
    Flac,
    Mp3,
}

impl OutFormat {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "wav" => Some(Self::Wav),
            "flac" => Some(Self::Flac),
            "mp3" => Some(Self::Mp3),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Mp3 => "mp3",
        }
    }
}

/// Simplified user-facing output choice (M4 spec: فيديو أو صوت).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutKind {
    /// MP4 with processed audio; optional height cap (None = same as source).
    Video { max_height: Option<u32> },
    /// Audio file in the given container (MP3 default for simple users).
    Audio { fmt: OutFormat },
}

#[derive(Debug)]
pub struct PipelineError(String);

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for PipelineError {}

fn err<E: std::fmt::Display>(e: E) -> PipelineError {
    tracing::error!(target: "pipe", "{e}");
    PipelineError(e.to_string())
}

/// Cross-path mutual exclusion (functional gap H-1): GUI single/batch,
/// bridge, watch and CLI ALL funnel through `process_file` — one lockfile
/// registry here covers every path with a single integration point, so the
/// same file can never be separated twice concurrently (double GPU, duplicate
/// outputs, cross-cancel confusion).
fn locks_dir() -> PathBuf {
    crate::paths::data_dir().join("locks")
}

/// اسم القفل للملف — **مستعمل في الاختبارات وحدها**: مسار الإنتاج يمرّ بـ
/// `claim_processing_in` الذي يبني الاسم من مجلده الصريح، ولا ينادي هذه أبداً.
/// والوسم هنا **صادق** لا تسكيت: لا مستدعي في المنتج.
#[cfg(test)]
fn lock_name_for(input: &Path) -> PathBuf {
    lock_name_in(&locks_dir(), input)
}

/// الصيغة الواحدة لاسم القفل من (مجلد الأقفال، مسار الإدخال) — ومفصولة حتى
/// يحسب اختبار «القفل الميت» موضع القفل في مجلده بلا لمس الحالة العامة.
fn lock_name_in(locks_dir: &Path, input: &Path) -> PathBuf {
    let canon = canonical_input(input);
    locks_dir.join(format!("{:x}.lock", lock_hash(&canon)))
}

/// المسار المعياري الذي يُبنى عليه القفل: `.\a.mp3` و`A.MP3` والصيغة المطلقة
/// تُجزّأ تجزئة واحدة.
fn canonical_input(input: &Path) -> PathBuf {
    input
        .canonicalize()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default().join(input))
}

/// تجزئة مسار الإدخال إلى اسم ملف قفل (`{:x}` — ست عشري بلا شرطات).
fn lock_hash(canon: &Path) -> sha2::digest::Output<sha2::Sha256> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(canon.to_string_lossy().as_bytes());
    h.finalize()
}

/// Exclusive processing claim, released on drop (even on panic-unwind,
/// which is what makes it crash-safe where in-memory sets are not).
///
/// **عطل ميداني مُصلَح (شرط قبول م٢)**: القفل كان يحمل طابعاً زمنياً فقط،
/// و`Drop` لا يعمل عند قتل العملية ⇒ مهمّة تُقتل (أو يُلغى ملفها) تترك قفلاً
/// **ميتاً** يمنع إعادة معالجة **الملف نفسه** ١٢ ساعة برسالة «الملف قيد
/// المعالجة حالياً — تخطي» (قِيس: رفض في 10ms). أي أن الإلغاء كان **عقوبة**.
///
/// والعلاج: القفل يخزّن **PID المالك وطابعه الزمني**، ويُسترجع بفحص **حياة
/// العملية المالكة** (`lock_owner_is_dead`) بدل انتظار الزمن. والطابع الزمني
/// يبقى **مساراً بديلاً صريحاً** لقفل بلا PID مقروء (قفل من نسخة أقدم أو ملف
/// عبث به أحد) — فلا يتعلّق ملف إلى الأبد بحجّة «تعذّر الفحص».
pub(crate) struct ProcessingClaim {
    path: PathBuf,
}

impl Drop for ProcessingClaim {
    fn drop(&mut self) {
        // **لا حذف بالاسم**: لو استُرجع قفلُنا (مالكٌ حُكم عليه بالموت خطأً) ثم
        // أنشأ غيره قفلاً جديداً في المسار نفسه، فحذفٌ أعمى هنا **يهدم قفل مالك
        // حيّ** — وهو النصف الثاني من سباق TOCTOU الذي أُغلق في
        // `claim_processing_in`. فنحذف فقط الكائن الذي يحمل PIDنا.
        let me = std::process::id();
        let mine = move |text: &str, _age: Option<std::time::Duration>| {
            lock_text_owner_pid(text) == Some(me)
        };
        for attempt in 0..LOCK_DROP_ATTEMPTS {
            match delete_lock_where(&self.path, &mine) {
                LockDelete::Deleted | LockDelete::Kept => return,
                LockDelete::Failed => {
                    if attempt + 1 < LOCK_DROP_ATTEMPTS {
                        // نافذة الفتح الحصري في مسار الاسترجاع ميكروثانية،
                        // وإعادة محاولة قصيرة تُبطل احتمال أن يكون فشلُنا
                        // لحظةَ مرور مسترجع — وإلا بقي قفلٌ لمهمّة انتهت.
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                }
            }
        }
        tracing::warn!(
            target: "pipe",
            "تعذّر تحرير قفل {} بعد {LOCK_DROP_ATTEMPTS} محاولات",
            self.path.display()
        );
    }
}

/// القفل مشغول — الرسالة **الواحدة** لكل مسارات الرفض (فحصٌ حيّ، أو استنفاد
/// محاولات الاسترجاع): نصّان يفترقان يجعلان القياس على أحدهما لا على السلوك.
const LOCK_BUSY: &str = "الملف قيد المعالجة حالياً — تخطي";

/// قفل عمره أطول من هذا لا يمكن أن يكون لمهمّة حيّة (لا مهمّة تمتدّ ١٢ ساعة)
/// ⇒ **يُسترجع**. وهو الآن **احتياط** لا الأصل: الأصل فحص حياة المالك.
const STALE_LOCK_SECS: u64 = 12 * 3600;

/// الأقدمية التي يُقبل بها **قفل بلا PID مقروء** كقفل ميت. أصغر بكثير من
/// `STALE_LOCK_SECS` عن قصد: القفل بلا PID يعني «لا سبيل لفحص الحياة»، وإبقاء
/// ملف ١٢ ساعة على الاحتمال أسوأ من إعادة محاولة تُكرَّر — والقفل المتعارَض
/// الحقيقي يبقى محميّاً لأن كل قفل نكتبه يحمل PID.
const UNREADABLE_LOCK_STALE_SECS: u64 = 60;

/// **نافذة القفل الفارغ**: `create_new` يُنشئ الملف فارغاً ثم يُكتب فيه PID —
/// فبينهما قفلٌ موجود بلا مالك معلَن. مَن يراه في تلك النافذة ويحكم «ميت»
/// **يستولي على قفل حيّ**. والنافذة الحقيقية ميكروثانية، والهامش خمس ثوانٍ عن
/// قصد: **الاتجاه الآمن** (احتجاز لا استرجاع) هو الحكم خلالها. وهي مهلة
/// **منفصلة** عن `UNREADABLE_LOCK_STALE_SECS` عن قصد: قفل بلا PID **ومعه نصّ**
/// (نسخة أقدم كتبت طابعاً زمنياً) ليس قفلاً فارغاً، ولا يُستَرجع بسرعة الفارغ.
const EMPTY_LOCK_GRACE_SECS: u64 = 5;

/// أقصى عدد محاولات في حلقة الاسترجاع. والمحاولة الواحدة إمّا تُنشئ قفلاً وإمّا
/// تحذف قفلاً ميتاً؛ فمحاولتان متتاليتان بلا نتيجة تعني **متسابقاً آخر يعمل
/// الآن** ⇒ الرسالة الصادقة «قيد المعالجة» بدل دوران لا ينتهي.
const RECLAIM_ATTEMPTS: usize = 3;

/// محاولات تحرير القفل عند سقوط الحارس (`Drop`) — النافذة التي قد يفشل فيها
/// الحذف ميكروثانية (مسترجع يمسك الملف)، وإعادة محاولة قصيرة تُبطلها.
const LOCK_DROP_ATTEMPTS: usize = 5;

/// عمر القفل (بدقّة تحت الثانية — اللازمة لقياس مهلة القفل الفارغ بلا نوم).
fn lock_age(lock: &Path) -> Option<std::time::Duration> {
    lock_file_age(std::fs::metadata(lock).ok()?.modified().ok()?)
}

/// العمر من طابع تعديل معلوم — الصيغة الواحدة للمسار (‏`metadata` على المسار)
/// وللمقبض (‏`File::metadata`).
fn lock_file_age(modified: std::time::SystemTime) -> Option<std::time::Duration> {
    std::time::SystemTime::now().duration_since(modified).ok()
}

/// PID المالك المسجَّل في **نصّ** القفل، إن كان مقروءاً.
fn lock_text_owner_pid(text: &str) -> Option<u32> {
    text.split_whitespace().next()?.parse::<u32>().ok()
}

/// PID المالك من المسار (قراءة عاديّة — للحكم والتحقّق، لا للحذف).
fn lock_owner_pid(lock: &Path) -> Option<u32> {
    lock_text_owner_pid(&std::fs::read_to_string(lock).ok()?)
}

/// هل القفل **قفلُنا**؟ (المحتوى: PID المالك + طابعه الزمني، كما يكتبهما
/// [`create_lock`].) يُسأل بعد الإنشاء — فلا ندّعي ملكية قفلٍ سبقنا إليه غيرنا.
fn lock_is_ours(lock: &Path) -> bool {
    lock_owner_pid(lock) == Some(std::process::id())
}

/// فحص **حياة العملية المالكة** لقفل قائم.
///
/// * `true` = المالك **مات** (أو القفل غير مقروء وقديم) ⇒ القفل يُسترجع.
/// * `false` = المالك **حيّ** ⇒ القفل يُحترم.
///
/// وعلى ويندوز: `OpenProcess(SYNCHRONIZE|QUERY_LIMITED_INFORMATION)` ثم
/// `WaitForSingleObject(handle, 0)`:
/// * `WAIT_OBJECT_0` ⇒ العملية انتهت (ميتة) — أو PID مُعاد استخدامه لعملية
///   انتهت أيضاً، وفي الحالتين لا مالك حيّ ⇒ الاسترجاع سليم.
/// * `WAIT_TIMEOUT` ⇒ العملية حيّة ⇒ لا استرجاع.
/// * فشل الفتح (`ERROR_INVALID_PARAMETER`) ⇒ لا عملية بهذا المعرّف ⇒ ميتة.
/// * `ERROR_ACCESS_DENIED` ⇒ العملية موجودة (ملكٌ لغيرنا) ⇒ حيّة، ولا نخمّن.
///
/// **حدّها المعلَن**: عملية ميتة أُعيد استخدام معرّفها لعملية حيّة أخرى تُقرأ
/// «حيّة» فيبقى القفل حتى `STALE_LOCK_SECS`. وهو **تحفّظ آمن** (لا يُسترجع قفل
/// حيّ أبداً) لا عطل: احتمال إعادة استخدام PID داخل نافذة الأقدمية ضئيل،
/// والخطأ في الاتجاه الآخر يهدم حصرية المعالجة كلها.
fn lock_owner_is_dead(lock: &Path) -> bool {
    lock_is_reclaimable(
        lock,
        std::time::Duration::from_secs(EMPTY_LOCK_GRACE_SECS),
        std::time::Duration::from_secs(UNREADABLE_LOCK_STALE_SECS),
    )
}

/// الفحص الواحد لثلاث حالات، بمهلة **محقونة** لكل حالة — والحقن للقياس بلا نوم:
/// اختبار «قفل فارغ قديم يُسترجع» يمرّر مهلة صفرية بدل انتظار خمس ثوانٍ.
///
/// * **فارغ** (لا محرف غير فراغ): صاحبه في نافذة `create` ⟶ `write` ⇒ محتجَز
///   خلال `empty_grace`، وقابل للاسترجاع بعدها (ملف فارغ مهجور لا يكتب نفسه).
/// * **PID مقروء**: الحكم على حياة العملية وحدها — المهلة لا تشارك.
/// * **نصّ بلا PID** (نسخة أقدم/عبث): `unreadable_grace` وحدها.
///
/// وفشل `metadata` (اختفى بين القراءة والفحص) ⇒ `true` = لا مالك.
fn lock_is_reclaimable(
    lock: &Path,
    empty_grace: std::time::Duration,
    unreadable_grace: std::time::Duration,
) -> bool {
    let Ok(text) = std::fs::read_to_string(lock) else {
        return true; // اختفى بين الفحص والقراءة ⇒ لا مالك
    };
    lock_text_is_reclaimable(&text, lock_age(lock), empty_grace, unreadable_grace)
}

/// الحكم نفسه على **نصّ** القفل وعمره — وهي الصيغة التي يستعملها الحذف الذرّي
/// على محتوى المقبض (`delete_lock_where`) فلا حكمان يفترقان.
fn lock_text_is_reclaimable(
    text: &str,
    age: Option<std::time::Duration>,
    empty_grace: std::time::Duration,
    unreadable_grace: std::time::Duration,
) -> bool {
    let older_than = |grace: std::time::Duration| age.map(|a| a > grace).unwrap_or(true);
    if text.trim().is_empty() {
        return older_than(empty_grace);
    }
    match lock_text_owner_pid(text) {
        Some(pid) => !process_is_alive(pid),
        None => older_than(unreadable_grace),
    }
}

/// المالك حيّ؟ — الصيغة الوحيدة في هذا الملف، مفصولة لتُقاس بمعرّف معروف
/// (اختبار `a_killed_process_is_not_alive`).
fn process_is_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, ERROR_ACCESS_DENIED, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        };
        unsafe {
            let handle: HANDLE = OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            );
            if handle.is_null() {
                // لا مقبض: إما لا عملية بهذا المعرّف (ميتة) وإما مُنعنا (حيّة).
                return GetLastError() == ERROR_ACCESS_DENIED;
            }
            let waited = WaitForSingleObject(handle, 0);
            CloseHandle(handle);
            match waited {
                WAIT_OBJECT_0 => false, // انتهت ⇒ ميتة
                WAIT_TIMEOUT => true,   // ما زالت تعمل ⇒ حيّة
                _ => true,              // فشل غير متوقّع ⇒ لا نخمّن بمهاجمة قفل قائم
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // يونكس: `/proc` إن وُجد، وإلا `kill -0` كسؤال «هل يستطيع إشارةً؟».
        let proc_dir = Path::new("/proc").join(pid.to_string());
        if proc_dir.exists() {
            return true;
        }
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(true)
    }
}

/// يسجّل القفل باسم المالك (PID + طابع زمني)، ويعيد حارساً يحذفه في `Drop`.
fn claim_processing(input: &Path) -> Result<ProcessingClaim, PipelineError> {
    claim_processing_in(
        &locks_dir(),
        input,
        lock_owner_is_dead,
        ClaimHooks::production(),
    )
}

/// خطّافا قياس — **لا سلوك**: الإنتاج يمرّر [`ClaimHooks::production`] وهما
/// نداءان إلى دالتين فارغتين. وموضعهما مقصود: `before_reclaim` **بعد** قرار
/// «القفل ميت» و**قبل** الخطوة التدميرية، فاختبار السباق يُجبر الترتيب عنده
/// بدل `sleep` تخميني؛ و`after_create` بعد إنشاء القفل وقبل التحقّق من ملكيّته،
/// فيُقاس رفضُ قفلٍ ليس قفلنا.
struct ClaimHooks<'a> {
    /// يُنادى برقم المحاولة (من الصفر) **قبل** خطوة الاسترجاع التدميرية.
    before_reclaim: &'a dyn Fn(usize),
    /// يُنادى بعد إنشاء القفل وقبل التحقّق من أنّه قفلنا.
    after_create: &'a dyn Fn(&Path),
}

impl ClaimHooks<'static> {
    /// الخطّافان الفارغان — مسار الإنتاج.
    fn production() -> Self {
        Self {
            before_reclaim: &|_| {},
            after_create: &|_| {},
        }
    }
}

/// [`claim_processing`] بمجلد أقفال صريح وفحص مالك **محقون**.
///
/// ولماذا الحقن: مالك القفل في الاختبار هو العملية نفسها، فلا سبيل لقياس مسار
/// «مالك ميت» بلا حقن. ومجلد الأقفال صريح حتى لا يعتمد القياس على
/// `HARAMLITE_DATA_DIR` (لمسُه في اختبار يُسابق كل اختبار يحلّ مساراً — عطل
/// مقيس في `paths.rs:29-31`) ولا يكتب في بيانات المستخدم.
///
/// **الاسترجاع ذرّي (عطل م٢ المقيس)**: الكود السابق كان `remove_file(&lock)`
/// ثم `create_lock` **بلا إعادة تحقّق** — فبين قراءةِ «القفل ميت» وحذفه يستطيع
/// المسترجع الآخر أن يسبق فيحذف هذا **قفلَ الأول الحيّ** ⇒ **مالكان لملف واحد**
/// (قِيس بالمدقّق بنافذة ٣٠٠ مللي: `A-holds=true · B-holds=true ·
/// BOTH-HELD-AT-ONCE=true`).
///
/// **والعلاج على ثلاث طبقات، كلٌّ منها مقيسة بمُفسَد**:
/// 1. **لا حذف بالاسم**: الحكم والفعل على **كائن ملف واحد** (`delete_lock_where`
///    عبر [`open_lock_exclusive`] ثم الحذف بـ`FILE_DISPOSITION_INFO`). وهذا هو
///    ما يُغلق السباق فعلاً: `rename` وحده **لم يكفِ** — قِيس أنه ينقل «ما في
///    المسار» فينقل قفل الفائز الحيّ (‏`A يملك · B يملك` مع `rename` وحده).
/// 2. **إعادة القرار من أوله** بعد فشل الاسترجاع، بحدّ `RECLAIM_ATTEMPTS` ثم
///    الرسالة الصادقة `LOCK_BUSY` — فلا دوران ولا حذف غير مملوك.
/// 3. **تحقّق الملكية بعد الإنشاء** (`lock_is_ours`) و**في `Drop`**: لا يُدَّعى
///    قفلٌ ليس لنا، ولا يُحذف قفلُ غيرنا.
fn claim_processing_in(
    dir: &Path,
    input: &Path,
    owner_is_dead: impl Fn(&Path) -> bool,
    hooks: ClaimHooks,
) -> Result<ProcessingClaim, PipelineError> {
    std::fs::create_dir_all(dir).map_err(|e| PipelineError(format!("تعذر مجلد الأقفال: {e}")))?;
    let lock = lock_name_in(dir, input);
    for attempt in 0..RECLAIM_ATTEMPTS {
        match create_lock(&lock) {
            Ok(()) => {
                (hooks.after_create)(&lock);
                // **تحقّق بعد الإنشاء**: `create_new` نجح، لكن قفلَنا قد يكون
                // استُبدل في النافذة بين الإنشاء والقراءة. لا نعيد حارساً على
                // قفلٍ ليس لنا (وإلا صار `Drop` يحذف قفل غيره).
                if lock_is_ours(&lock) {
                    return Ok(ProcessingClaim { path: lock });
                }
                tracing::warn!(
                    target: "pipe",
                    "القفل {} لم يبق قفلنا بعد إنشائه — إعادة القرار من أوله",
                    lock.display()
                );
            }
            Err(_) => {
                let stale = owner_is_dead(&lock)
                    || lock_age(&lock)
                        .map(|age| age > std::time::Duration::from_secs(STALE_LOCK_SECS))
                        .unwrap_or(false);
                if !stale {
                    return Err(PipelineError(LOCK_BUSY.into()));
                }
                (hooks.before_reclaim)(attempt);
                if !reclaim_dead_lock(&lock) {
                    // سبقنا مسترجع آخر إلى النقل (أو اختفى القفل) ⇒ أعد القرار
                    // من أوله: القفل الجديد هناك قد يكون حيّاً.
                    continue;
                }
            }
        }
    }
    Err(PipelineError(LOCK_BUSY.into()))
}

/// **الاسترجاع الذرّي — الحكم والفعل على كائن ملف واحد**.
///
/// `rename` وحده **لا يكفي، وهذا مقيس**: نقل «ما في المسار» لا يفرّق بين القفل
/// الميّت الذي حكمنا عليه وبين قفلٍ **حيّ** أنشأه غيره في النافذة بين `rename`
/// و`create` — فالسباق يبقى مفتوحاً (قِيس مع `rename` وحده:
/// `A يملك=true · B يملك=true`، الاختبار
/// `two_reclaimers_race_for_one_dead_lock_and_exactly_one_wins`). والنقل الناجح
/// يعني «سبقتَ إلى نقل ملفٍ ما» لا «نقلتَ الملف الذي حكمت عليه».
///
/// فالعلاج الأقوى: **فتح حصري** (`share_mode(0)` ⇒ لا يستطيع أحد حذف الملف ولا
/// نقله ولا إنشاء غيره في المسار ما دام مقبضنا مفتوحاً)، ثم **الحكم من محتوى
/// المقبض نفسه**، ثم **الحذف بالكائن** (`FILE_DISPOSITION_INFO`) لا بالاسم.
/// فبين الحكم والفعل لا يوجد «ما في المسار» أصلاً.
///
/// والمسار الاحتياطي على غير ويندوز يحذف بالاسم بعد القراءة (‏`std` لا يعطي
/// «حذفاً بالكائن» هناك) — **وسباق TOCTOU يبقى نظرياً قائماً على تلك المنصّة**،
/// وهي مصرَّح بها في [`delete_by_handle`]. والمنتج على ويندوز (CI و
/// `pnpm e2e:release` على `windows-latest`)، والاختبار الحاكم للسباق يعمل على
/// المنصّتين ويقيس ما تُتيحه كلٌّ منهما.
fn reclaim_dead_lock(lock: &Path) -> bool {
    let grace = std::time::Duration::from_secs(EMPTY_LOCK_GRACE_SECS);
    let long = std::time::Duration::from_secs(UNREADABLE_LOCK_STALE_SECS);
    delete_lock_where(lock, &|text, age| {
        lock_text_is_reclaimable(text, age, grace, long)
    }) == LockDelete::Deleted
}

/// نتيجة محاولة حذف قفل — ثلاثة أحوال لا رابع: حُذف · **تُرك عن قصد** (ليس
/// ميّتاً/ليس قفلنا) · **فشل** (مقبض مفتوح عند غيره، أو خطأ نظام) — والفرق بين
/// الأخيرين هو الفرق بين «لا تُعِد المحاولة» و«أعِدها».
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockDelete {
    Deleted,
    Kept,
    Failed,
}

/// يفتح القفل **حصرياً**، ويحكم عليه من محتواه وعمره **داخل المقبض**، ثم يحذفه
/// بالكائن إن قال الحكم `should_delete`.
///
/// و`age` يُحسب من الملف المفتوح (`File::metadata`) لا من المسار — فلا فصل بين
/// ما حُكم عليه وما سيُحذف.
fn delete_lock_where(
    lock: &Path,
    should_delete: &dyn Fn(&str, Option<std::time::Duration>) -> bool,
) -> LockDelete {
    let Ok(f) = open_lock_exclusive(lock) else {
        // تعذّر الفتح: إمّا سبقنا غيره فحذفه/نقله، وإمّا مسترجع آخر يمسكه الآن
        // (لا مشاركة) — وفي الحالتين لم نحذف شيئاً.
        return LockDelete::Failed;
    };
    let age = f
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| std::time::SystemTime::now().duration_since(t).ok());
    let mut text = String::new();
    if std::io::Read::read_to_string(&mut &f, &mut text).is_err() {
        return LockDelete::Failed;
    }
    if !should_delete(&text, age) {
        return LockDelete::Kept;
    }
    match delete_by_handle(f, lock) {
        Ok(()) => LockDelete::Deleted,
        Err(e) => {
            tracing::warn!(target: "pipe", "تعذّر حذف القفل {} بالكائن: {e}", lock.display());
            LockDelete::Failed
        }
    }
}

/// فتح حصري لملف القفل (ويندوز): `DELETE` للسماح بالحذف **عبر المقبض**،
/// و`share_mode(0)` لتثبيت المسار ما دام المقبض مفتوحاً.
#[cfg(windows)]
fn open_lock_exclusive(lock: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const GENERIC_READ: u32 = 0x8000_0000;
    const DELETE: u32 = 0x0001_0000;
    std::fs::OpenOptions::new()
        .access_mode(GENERIC_READ | DELETE)
        .share_mode(0)
        .open(lock)
}

#[cfg(not(windows))]
fn open_lock_exclusive(lock: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(lock)
}

/// **الحذف بالكائن لا بالاسم** (ويندوز): نعلّم كائن الملف بالحذف عند الإغلاق،
/// فيحذف النواة **الملف الذي أمسكناه** — لا «ما صار في المسار». وهو الفرق
/// العملي الوحيد الذي يُغلق سباق TOCTOU بلا نافذة.
#[cfg(windows)]
fn delete_by_handle(f: std::fs::File, _lock: &Path) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };
    let info = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    let ok = unsafe {
        SetFileInformationByHandle(
            f.as_raw_handle() as HANDLE,
            FileDispositionInfo,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    drop(f); // الإغلاق ينفّذ الحذف على الكائن
    Ok(())
}

/// **حدّ أمانة مصرَّح به**: على غير ويندوز لا واجهة «حذف بالكائن» في `std`،
/// فالحذف بالاسم بعد القراءة — وسباق TOCTOU يبقى **نظرياً قائماً هناك**.
/// والمنتج على ويندوز وحده (CI و`pnpm e2e:release` على `windows-latest`)،
/// والاختبار الحاكم للسباق [`two_reclaimers_race_for_one_dead_lock_and_exactly_one_wins`]
/// يعمل على المنصّتين ويقيس ما تُتيحه كلٌّ منهما.
#[cfg(not(windows))]
fn delete_by_handle(f: std::fs::File, lock: &Path) -> std::io::Result<()> {
    drop(f);
    std::fs::remove_file(lock)
}

/// ينشئ ملف القفل **حصراً** ويكتب فيه PID المالك وطابعه الزمني.
fn create_lock(lock: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock)?;
    writeln!(
        f,
        "{} {}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    )
}

pub struct PipelineOutput {
    pub vocals: Option<PathBuf>,
    /// None unless the hidden "keep instrumental" option is enabled.
    pub instrumental: Option<PathBuf>,
    /// MP4 with processed audio (and cut-mirrored video) for video inputs.
    pub video: Option<PathBuf>,
    /// Kept (content) ranges on the ORIGINAL timeline (song silence cuts;
    /// empty for clips) — the extension page player maps its clock through
    /// these so filtered audio stays in sync with the page video.
    ///
    /// **معناها لا يتغيّر**: «ما قُصّ فعلاً من الملف المُسلَّم». ومسار `clip`
    /// لا يقصّ شيئاً ⇒ تبقى فارغة **بالبناء** هناك، وخريطته في [`Self::page_kept`].
    pub kept_ranges: Vec<(f64, f64)>,
    /// **خريطة صوت الصفحة في مسار `clip`** — حقل **مستقلّ تماماً** عن
    /// [`Self::kept_ranges`]، ولا يُمرَّر أحدهما مكان الآخر أبداً.
    ///
    /// **ولماذا حقل ثانٍ** (م٦-ب · `ARCHIVE/0.2.9PLAN.md` §٩-ب ·
    /// `ARCHIVE/review-0.2.9-cline.md` §٤-٣): مسار الأغنية **يقصّ** الملف
    /// المُسلَّم، فخريطة [`Self::kept_ranges`] تصف **ما قُصّ**؛ ومسار `clip`
    /// يبني mute/duck **ويُبقي الطول** (وهو وعد الواجهة للمستخدم، `src/i18n.ts:22`:
    /// «لن يقطع الصمت»). فتمرير خريطة الكتم في مكان «ما قُصّ» يجعل الثابت
    /// المؤسِّس للمشغّل («الخريطة مسطّحة داخل الفجوة»،
    /// `scripts/check-extension-sync.cjs` §٢) **كاذباً**: المشغّل يظنّ الفجوة
    /// محذوفة وهي موجودة مكتومة، فيهبط بالموضع أمام الصورة بمقدار الفجوة.
    /// ولذلك **لا يُمرَّر شيء إلى [`Self::kept_ranges`] في مسار clip إطلاقاً**
    /// (اختبار بنيوي في هذا الملف يحرس ذلك).
    ///
    /// **وما تصفه هذه الخريطة**: صوت الصفحة **بعد قصّه** — أي ملفاً آخر غير
    /// ملف المستخدم. والقصّ يقع في `bridge.rs` على **نسخة** تُسلَّم للمشغّل
    /// (`silence::cut_silence_with_ranges`)، وملف المستخدم يبقى كامل الطول.
    /// والعتبات هي **نفس عتبات القصّ** (800ms ±150ms) بقرار المالك §١٧/٣،
    /// فالفجوة هنا = ما يراه كاشف الصمت صمتاً في الصوت المعالَج (والمكتوم هو
    /// ما يراه كذلك — والمُخفَّض −12dB لا يُرى عادةً؛ وهذا **فرق معنى معلَن**:
    /// قد تقلّ الفجوات عن مواضع الخفض).
    ///
    /// **التقادم (تراكمي)**: `page_kept` و`mode` حقلان **جديدان**، و
    /// [`Self::kept_ranges`] **يحفظ معناه** ⇒ «إضافة قديمة + تطبيق جديد»
    /// و«إضافة جديدة + تطبيق قديم» آمنتان. **وإن تغيّر معنى حقل قائم مستقبلاً
    /// فيلزم `state_version` في حالة الجسر** — لا يكفي إضافة حقل جديد.
    pub page_kept: Vec<(f64, f64)>,
    pub seconds: f32,
}

/// Audit 2026-09-15 (٤.ب.١٠): the final cancel checkpoint used to discard its
/// result — a cancel that arrived during the encode still returned Ok, so the
/// app reported success and the caller went on to delete the downloaded source
/// (lib.rs:358-365).
///
/// Removing the outputs HERE is safe and must NOT be copied to the earlier
/// checkpoints (:359 · :380): by the time this runs the encode has already
/// overwritten those paths, so removing them destroys nothing that was still
/// intact. Before the encode starts they may still hold a previous successful
/// run's output, and cancelling must not destroy it.
fn finish_run(
    progress: &dyn Fn(f32) -> bool,
    outputs: [Option<&Path>; 3],
) -> Result<(), PipelineError> {
    if progress(1.0) {
        return Ok(());
    }
    for p in outputs.into_iter().flatten() {
        let _ = std::fs::remove_file(p);
    }
    Err(err("تم إلغاء المعالجة من قبل المستخدم."))
}

/// **الرقم الواحد الصادق لسقف نداء المحرّك** — يقرؤه تلغرام (رسالة `/kill`)
/// والواجهة (`src/jobs.ts: STOP_CEILING_SECS`، وحارس تكافؤ يمنع تباعدهما).
///
/// **من أين جاء**: أطول نداء محرّك (ONNX) سُجِّل فعلاً **565.451 ث** —
/// `SEPARATE-AB-REPORT … inference_ms=565451` في سجلّ المالك
/// `%LOCALAPPDATA%\com.harammute.haramlite\logs\haramlite.log.2026-09-21`، وهو
/// أكبر **١١** عيّنة في ذلك السجلّ (التالي 250377 ث · ثم 179368 ث · والوسيط
/// نحو 32.7 ث). والرقم المعلَن **566 ث (‏٩.٤ دقيقة)** بترفيع إلى الثانية الصحيحة.
///
/// **وهو أطول ما قيس، لا حدّ رياضي**: نداء أطول (ملفّ أطول، أو بناء تصحيح)
/// يتجاوزه، فلا يُقرأ وعداً. ولذلك الصياغة المعلَنة **«أطول ما قيس … والغالب
/// أقلّ بكثير»** ولا يُقال «فوراً» عن نداء المحرّك: هو نداء واحد داخل العملية
/// لا نقطة إلغاء فيه، والهجر يقع عند أول حدّ بعده (انظر `process_file`).
///
/// **وسابقة مُصلَحة**: كان المعلَن رقمين مختلفين لنفس الحالة — `141` في الواجهة
/// و`150` في تلغرام — وكلاهما من عيّنة **140.208 ث** قديمة، أي **أقلّ من الواقع
/// ٣.٨×**. والرقم المشترك هنا هو ما يجب أن يُقرأ في المواضع الثلاثة.
pub const ENGINE_CALL_CEILING_SECS: u64 = 566;

/// Process one media file end-to-end.
///
/// Stages (per approved plan):
/// 1. probe/normalize any input → clean 44.1k stereo WAV   [M1 ✓]
/// 2. MDX-Net separation → vocals/instrumental stems       [M2 ✓]
/// 3. (M3) song-mode effect chain + silence cut            [hook below]
/// 4. (M4/M5) encode to requested container                [wav native now]
///
/// **`cancel` (م٢)**: رمز الإلغاء **لكل مهمّة** يُمرَّر من `slots::run_separation`
/// (ويحقن `proc::never()` في الاختبارات المباشرة). وكل حدّ مرحلة يقرؤه، وكل
/// نداء أداة يقرؤه **ويقتل شجرته فوراً** (`proc::run_cancellable`). والحدّ
/// الباقي مصرَّح به: `separator::separate` (ONNX) نداء واحد غير قابل للقطع،
/// فالإلغاء داخله يُهجر عند أول حدّ بعده بلا إنتاج ناتج (دلالة على مرحلتين).
pub fn process_file(
    input: &Path,
    out_dir: &Path,
    mode: Mode,
    kind: OutKind,
    keep_instrumental: bool,
    keep_vocals: bool,
    use_cuda: bool,
    preview_seconds: Option<f32>,
    cancel: &CancelToken,
    progress: &dyn Fn(f32) -> bool,
    stage: &dyn Fn(&str, f32),
) -> Result<PipelineOutput, PipelineError> {
    let started = std::time::Instant::now();
    // Held for the whole run: any second path attempting this file gets a
    // clean skip instead of a concurrent double separation.
    let _claim = claim_processing(input)?;
    // **حدّ الإلغاء الواحد لكل مرحلة** (م٢): يسأل رمز الإلغاء **و**المستدعي
    // (علم الواجهة/البوت العام كما كان — فلا يتغيّر سلوك مستدعٍ قديم). ومعه
    // تنظيف مجلد العمل: الإلغاء لا يترك سكراتش (وإلا صار الإلغاء عقوبة على
    // القرص أيضاً). قبل الترميز النهائي لا نحذف ناتجاً سابقاً ناجحاً (التعليل
    // في `finish_run`).
    let checkpoint = |p: f32| -> Result<(), PipelineError> {
        if progress(p) && !cancel.is_cancelled() {
            return Ok(());
        }
        let _ = std::fs::remove_dir_all(out_dir.join("_haramlite_work"));
        Err(err("تم إلغاء المعالجة من قبل المستخدم."))
    };
    // P1 autopsy: time every stage transition. The wrapper shadows the
    // caller's callback — zero changes at the dozen call sites below, and
    // the log now shows exactly where a run's wall time goes.
    let last_mark = std::cell::Cell::new(started);
    let stage = &|name: &str, p: f32| {
        let now = std::time::Instant::now();
        let since_mark = now.duration_since(last_mark.get()).as_secs_f32();
        last_mark.set(now);
        tracing::info!(
            target: "pipe",
            "stage {name} {p:.2} (+{since_mark:.1}s, total {:.1}s)",
            now.duration_since(started).as_secs_f32()
        );
        stage(name, p);
    };
    let work_dir = out_dir.join("_haramlite_work");
    // Sprint B1: preview = quality sample of the first N seconds; every
    // output file carries the `_preview` tag so it can never be mistaken
    // for the final artifact.
    let name_tag = if preview_seconds.is_some() {
        "_preview"
    } else {
        ""
    };

    // Stage 1 — repair & normalize whatever came in (Sprint C2: visible stages)
    stage("normalize", 0.0);
    checkpoint(0.02)?;
    // Audit 2026-09-03: scratch must not outlive a failed run (tens of MB
    // per failure used to accumulate in the user's output folder).
    let normalized = media::normalize_for_engine_limited(input, &work_dir, preview_seconds)
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&work_dir);
            err(e)
        })?;
    stage("normalize", 1.0);
    tracing::info!(target: "pipe", "normalized: {}", normalized.display());

    // Stage 2 — separation.
    // Expert D2أ: a SPARSE clip (no sustained-music run) skips MDX entirely
    // and goes detect-then-mute: the v1 position map rendered straight onto
    // the normalized audio. Song mode always takes full MDX (explicit user
    // choice — songs are dense by construction).
    let mut clip_direct_vocals: Option<PathBuf> = None;
    // Audit 2026-09-15 (٤.ب.٧): the clip gate already scans the whole file, so
    // hand that same analysis to `separate` (a dense clip takes full MDX there)
    // instead of letting it scan the entire mix a second time for the log.
    let mut clip_analysis: Option<separator::MixAnalysis> = None;
    if matches!(mode, Mode::Clip) {
        let (dl, dr, dsr) = separator::read_wav_stereo(&normalized).map_err(|e| {
            let _ = std::fs::remove_dir_all(&work_dir);
            err(e)
        })?;
        let analysis = separator::analyze_mix(&dl, &dr, dsr);
        tracing::info!(
            target: "pipe",
            "clip density gate: dense={} suspect_spans={} scored_windows={}",
            analysis.dense,
            analysis.suspect.len(),
            analysis.scored_windows
        );
        if !analysis.dense {
            tracing::info!(target: "pipe", "sparse clip — detect-then-mute, MDX skipped");
            let rep =
                v1proto::build_position_map(&dl, &dr, dsr, 60.0, &decide::DecideConfig::default());
            let mut mute: Vec<(f64, f64)> = Vec::new();
            let mut duck: Vec<(f64, f64)> = Vec::new();
            for c in &rep.chunks {
                mute.extend(c.muted_ranges_sec.iter().copied());
                duck.extend(c.ducked_ranges_sec.iter().copied());
            }
            let mut ml = dl;
            let mut mr = dr;
            silence::apply_mute_duck(&mut ml, &mut mr, dsr, &mute, &duck, 50);
            let stem_name = normalized
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "audio".into());
            let direct_path = out_dir.join(format!("{stem_name}_(Vocals)_haramlite.wav"));
            separator::write_wav_stereo_f32_pub(&direct_path, &ml, &mr, dsr).map_err(|e| {
                let _ = std::fs::remove_dir_all(&work_dir);
                err(e)
            })?;
            stage("separate", 1.0);
            checkpoint(0.90)?;
            clip_direct_vocals = Some(direct_path);
        }
        // Audit 2026-09-15 (٤.ب.٧): keep the scan for the MDX call below. Only
        // a DENSE clip reaches it (a sparse one is detect-then-mute, no MDX at
        // all), and re-scanning the whole mix there bought nothing but the log.
        clip_analysis = Some(analysis);
    }
    let sep_progress = |p: f32| {
        stage("separate", p);
        progress(0.05 + p * 0.85) && !cancel.is_cancelled()
    };
    let (vocals_raw, instrumental_raw): (PathBuf, Option<PathBuf>) = if let Some(v) =
        clip_direct_vocals
    {
        if keep_instrumental {
            tracing::warn!(target: "pipe", "sparse clip has no instrumental (MDX skipped) — vocals only");
        }
        (v, None)
    } else {
        let stems = separator::separate(
            &normalized,
            out_dir,
            use_cuda,
            &sep_progress,
            clip_analysis.as_ref(),
        )
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&work_dir);
            err(e)
        })?;
        (stems.vocals, Some(stems.instrumental))
    };
    stage("separate", 1.0);
    // **أول حدّ بعد نداء الاستدلال** (م٢): نداء ONNX غير قابل للقطع داخل
    // العملية، فالإلغاء الذي وصل أثناءه يسقط العمل **هنا** بلا إنتاج ناتج.
    if cancel.is_cancelled() {
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err(err("تم إلغاء المعالجة من قبل المستخدم."));
    }
    let _ = std::fs::remove_dir_all(&work_dir);

    // Stage 3 — song mode: enhancement chain (M3) applied ONTO the vocals stem
    let mut vocals_path = vocals_raw;
    let mut kept_ranges: Vec<(f64, f64)> = Vec::new();
    if matches!(mode, Mode::Song) {
        checkpoint(0.92)?;
        stage("effects", 0.0);
        tracing::info!(target: "pipe", "Starting DSP phase (CPU bound) for audio enhancement...");
        let tmp_enhanced = out_dir.join("_haramlite_enhanced.wav");
        // Audit 2026-09-03: DSP checkpoints share the cancel flag AND move
        // the progress bar (it used to freeze through the whole phase).
        let dsp_progress = |p: f32| {
            stage("effects", p);
            progress(0.90 + p * 0.06) && !cancel.is_cancelled()
        };
        kept_ranges = crate::effects::enhance_song_file(
            &vocals_path,
            &tmp_enhanced,
            &Default::default(),
            &dsp_progress,
        )
        .map_err(err)?;
        // replace raw vocals with the enhanced version
        std::fs::rename(&tmp_enhanced, &vocals_path).map_err(err)?;
        stage("effects", 1.0);
    }

    // Stage 3ب — مسار `clip`: **خريطة صوت الصفحة**، وهي ليست خريطة الملف
    // المُسلَّم (انظر [`PipelineOutput::page_kept`]).
    //
    // تُحسب على **الصوت المعالَج** نفسه (لا على قرار الكتم): فما يراه كاشف
    // الصمت صمتاً هو ما سيقصّه `bridge.rs` من نسخة صوت الصفحة، فتكون الخريطة
    // وصفاً للملف المُسلَّم لا رجماً. والعتبات هي عتبات القصّ نفسها (قرار
    // المالك §١٧/٣) — فلا عتبة مشاهدة مُبتكرة هنا، وأي ضبط لاحق يقتضي قياس
    // مشاهدة يُدوَّن.
    //
    // والكلفة: قراءة واحدة إضافية لملف الغناء + مسحة RMS واحدة
    // (`compute_kept_ranges` — نوافذ 50ms)، **ولا نداء محرّك ثانياً**.
    // (زمنها **لم يُقَس**: قياسه يقتضي تشغيل هذا المسار كاملاً بمحرّك ونموذج.)
    let page_kept: Vec<(f64, f64)> = if matches!(mode, Mode::Clip) {
        let (clip_l, clip_r, clip_sr) = separator::read_wav_stereo(&vocals_path).map_err(err)?;
        let map = silence::kept_ranges_sec(
            &clip_l,
            &clip_r,
            clip_sr,
            &silence::SilenceConfig::default(),
        );
        tracing::info!(
            target: "pipe",
            "clip: page map has {} kept ranges ({}s of a {:.1}s page audio)",
            map.len(),
            map.iter().map(|(a, b)| b - a).sum::<f64>(),
            if clip_sr > 0 { clip_l.len() as f64 / clip_sr as f64 } else { 0.0 }
        );
        map
    } else {
        Vec::new()
    };

    // Probe the ORIGINAL input once for video routing decisions.
    let input_info = media::probe(input).ok();
    let has_video = input_info.as_ref().map(|i| i.has_video).unwrap_or(false);

    // Stage 4 — instrumental handling (hidden opt-in; default = vocals only).
    // None on the sparse-clip path (no MDX ⇒ no instrumental — warned above).
    let mut instrumental_path: Option<PathBuf> = match instrumental_raw {
        Some(p) if keep_instrumental => Some(p),
        Some(p) => {
            let _ = std::fs::remove_file(&p);
            None
        }
        None => None,
    };

    // Cosmetic: stems inherit the ORIGINAL file name, not the scratch wav.
    let orig_stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "audio".into());
    {
        let new_vocals =
            vocals_path.with_file_name(format!("{orig_stem}_(Vocals)_haramlite{name_tag}.wav"));
        if new_vocals != vocals_path {
            std::fs::rename(&vocals_path, &new_vocals).map_err(err)?;
            vocals_path = new_vocals;
        }
        if let Some(ip) = &mut instrumental_path {
            let new_i = ip.with_file_name(format!(
                "{orig_stem}_(Instrumental)_haramlite{name_tag}.wav"
            ));
            if new_i != *ip {
                std::fs::rename(&*ip, &new_i).map_err(err)?;
                *ip = new_i;
            }
        }
    }

    // Stage 5/6 — delivery per simplified OutKind (فيديو / صوت)
    let mut actual_kind = kind;
    if matches!(kind, OutKind::Video { .. })
        && (!has_video
            || input_info
                .as_ref()
                .map(|i| i.video_is_cover_art)
                .unwrap_or(false))
    {
        tracing::info!(target: "pipe", "Smart fallback: input lacks video, switching to Audio (mp3)");
        actual_kind = OutKind::Audio {
            fmt: OutFormat::Mp3,
        };
    }

    let mut video_out: Option<PathBuf> = None;
    let mut final_vocals: Option<PathBuf> = Some(vocals_path.clone());
    match actual_kind {
        OutKind::Video { max_height } => {
            checkpoint(0.97)?;
            stage("encode", 0.0);
            let vid_target = out_dir.join(format!("{orig_stem}_(Clean)_haramlite{name_tag}.mp4"));
            let ranges_for_video: &[(f64, f64)] = if matches!(mode, Mode::Song) {
                &kept_ranges
            } else {
                &[]
            };
            media::export_video_with_cuts(
                input,
                &vocals_path,
                ranges_for_video,
                max_height,
                &vid_target,
            )
            .map_err(err)?;
            let _ = std::fs::remove_file(&vocals_path);
            stage("encode", 1.0);
            tracing::info!(target: "pipe", "video output: {}", vid_target.display());
            video_out = Some(vid_target);
            final_vocals = None;
        }
        OutKind::Audio { fmt } => {
            if fmt != OutFormat::Wav {
                checkpoint(0.96)?;
                stage("encode", 0.0);
                let encode_one = |p: &mut PathBuf| -> Result<(), PipelineError> {
                    let encoded = media::extract_audio(p, fmt.as_str(), out_dir).map_err(err)?;
                    let _ = std::fs::remove_file(&*p);
                    let clean = p.with_extension(fmt.as_str());
                    if encoded != clean {
                        std::fs::rename(&encoded, &clean).map_err(err)?;
                        *p = clean;
                    } else {
                        *p = encoded;
                    }
                    Ok(())
                };

                if keep_vocals {
                    encode_one(&mut vocals_path)?;
                    final_vocals = Some(vocals_path);
                } else {
                    let _ = std::fs::remove_file(&vocals_path);
                    final_vocals = None;
                }

                if let Some(ip) = &mut instrumental_path {
                    encode_one(ip)?;
                }
                stage("encode", 1.0);
                tracing::info!(target: "pipe", "encoded stems to {}", fmt.as_str());
            } else {
                if !keep_vocals {
                    let _ = std::fs::remove_file(&vocals_path);
                    final_vocals = None;
                }
            }
        }
    }

    let seconds = started.elapsed().as_secs_f32();
    finish_run(
        progress,
        [
            video_out.as_deref(),
            final_vocals.as_deref(),
            instrumental_path.as_deref(),
        ],
    )?;
    let out = PipelineOutput {
        vocals: final_vocals,
        instrumental: instrumental_path,
        video: video_out,
        kept_ranges,
        page_kept,
        seconds,
    };
    tracing::info!(target: "pipe", "pipeline done in {seconds:.1}s (kept_ranges={} · page_kept={})", out.kept_ranges.len(), out.page_kept.len());

    Ok(out)
}

/// Quick health check used by `--check` (CLI) and startup diagnostics (GUI).
pub fn health_check() -> Result<Vec<(String, bool, String)>, String> {
    let mut rows = Vec::new();

    for tool in ["ffmpeg", "ffprobe", "yt-dlp"] {
        let ok = media::resolve_tool(tool).is_ok();
        rows.push((tool.to_string(), ok, String::new()));
    }

    match crate::separator::resolve_model_pub() {
        Ok(p) => rows.push(("model".into(), true, p.display().to_string())),
        Err(_) => rows.push(("model".into(), false, String::new())),
    }

    // ROADMAP §٧.ب بند ٩: report the CUDA situation explicitly instead of
    // leaving `--check` silent about it. `true` = the row states a fact, not a
    // promise: CUDA being absent is NOT a health failure (DirectML/CPU remains
    // the default and the app is fully functional without it), so this row must
    // never turn `--check` red. Only a machine that ASKED for CUDA and cannot
    // have it shows the reason here.
    {
        let d = crate::cuda_runtime::current_diagnosis(true);
        rows.push(("cuda".into(), true, d.message()));
    }

    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// وضع «حامل القفل»: عملية تأخذ القفل ثم **تُقتل** بلا `Drop` — وهو مسار
    /// العطل الميداني (قتل/إلغاء مهمّة) بلا محاكاة.
    const LOCK_HOLDER_MODE: &str = "HARAMLITE_LOCK_HOLDER";

    /// **نفس الوضع لكن بالمسار الإنتاجي**: الطفل ينادي `claim_processing`
    /// (التي تستعمل `locks_dir()` من `HARAMLITE_DATA_DIR`) لا
    /// `claim_processing_in` المحقونة — فالاختبار يقيس المسار الذي يعمل في
    /// المنتج لا نسخةً منه.
    const PROD_LOCK_HOLDER_MODE: &str = "HARAMLITE_LOCK_HOLDER_PROD";

    #[test]
    fn lock_holder_process() {
        let prod = std::env::var(PROD_LOCK_HOLDER_MODE).is_ok();
        if std::env::var(LOCK_HOLDER_MODE).is_err() && !prod {
            return; // لسنا في وضع حامل القفل
        }
        let input = PathBuf::from(std::env::var("HARAMLITE_LOCK_INPUT").expect("مسار الإدخال"));
        let ready = PathBuf::from(std::env::var("HARAMLITE_LOCK_READY").expect("مجلد العلامة"));
        // البيئة تُضبط من الأب **قبل** إقلاع هذا الطفل، فالقفل يُكتب في مجلد
        // القياس (لا في بيانات المستخدم). وفي وضع الإنتاج يكون المجلد هو مجلد
        // بيانات `HARAMLITE_DATA_DIR` نفسه — وهو ما يجعله مسار الإنتاج بحرفه.
        let _claim = if prod {
            claim_processing(&input).expect("الطفل يأخذ القفل (مسار الإنتاج)")
        } else {
            let locks = PathBuf::from(std::env::var("HARAMLITE_LOCKS_DIR").expect("مجلد الأقفال"));
            claim_processing_in(&locks, &input, lock_owner_is_dead, ClaimHooks::production())
                .expect("الطفل يأخذ القفل")
        };
        std::fs::write(ready.join("held.pid"), std::process::id().to_string())
            .expect("علامة الجاهزية");
        // يبقى حيّاً حتى يُقتل — والقتل لا يعمل المدوِّرات فيبقى القفل.
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }

    /// **شرط قبول م٢ — القفل الميت ١٢ ساعة**.
    ///
    /// العطل المقيس: `ProcessingClaim` يحذف القفل في `Drop`، والقتل لا يعمل
    /// المدوِّرات، و`STALE_LOCK_SECS = 12h` ⇒ بعد قتل مهمّة تفشل إعادة معالجة
    /// **الملف نفسه** ١٢ ساعة بـ«الملف قيد المعالجة حالياً — تخطي» (قِيس: رفض
    /// في 10ms). فالإلغاء كان **عقوبة**.
    ///
    /// القياس هنا **حقيقي لا محقون**: عملية طفل تأخذ القفل فعلاً ثم تُقتل
    /// `TerminateProcess` (لا `Drop`)، فيبقى ملف القفل على القرص حاملاً PID
    /// ميتاً. ثم يُقاس على `claim_processing` الحقيقية:
    ///
    /// * **ضابط موجب**: القفل موجود وPIDه هو PID الطفل المقتول (فالمسار المقيس
    ///   هو المسار الميداني)، وهي **ميتة** (`process_is_alive` = false).
    /// * **الادّعاء**: إعادة المحاولة على الملف نفسه **تنجح فوراً**.
    /// * **ضابط سالب (المُفسَد)**: لو حُكم على المالك بأنه **حيّ** (فحص معطَّل)
    ///   لرُفض الطلب بالرسالة نفسها التي قِيس بها العطل — وهذا يُثبت أن النجاح
    ///   سببه فحص الحياة لا مجرد إعادة محاولة عمياء.
    #[test]
    fn a_dead_owner_lock_is_reclaimed_immediately() {
        let _guard = crate::paths::serial_guard();
        let dir = std::env::temp_dir().join(format!("hl_deadlock_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("same_file.mp3");
        std::fs::write(&input, b"x").unwrap();
        let locks = dir.join("locks");

        // القفل يُحسب من (مجلد الأقفال، مسار الإدخال) — ويحسبه المساعد
        // **بالصيغة نفسها** في مجلد القياس، فلا يتّسخ مجلد بيانات المستخدم ولا
        // يُلمس متغيّر بيئة عام (لمسُه يُسابق كل اختبار يحلّ مساراً — عطل مقيس
        // في `paths.rs:29-31`).
        let (_lock, holder_pid, died) = kill_a_live_lock_holder(&dir, &input, false);

        // ضابط سالب: القفل **الطازج نفسه** (بلا فحص حياة) لا يُستَرجع — وهذا
        // يثبت أن المسار المقيس هو مسار «القفل القائم» لا مسار «لا قفل».
        std::thread::sleep(std::time::Duration::from_millis(1200));
        let fresh = claim_processing_in(&locks, &input, |_| false, ClaimHooks::production());
        assert!(
            fresh.is_err(),
            "قفل عمره ثانية يجب أن يُرفض — وإلا فالقياس بلا قفل أصلاً"
        );
        let fresh_msg = fresh.err().map(|e| e.to_string()).unwrap_or_default();
        assert_eq!(fresh_msg, LOCK_BUSY, "الرسالة المقيسة في العطل نفسه");

        // **الادّعاء**: إعادة المحاولة فوراً على الملف نفسه تنجح.
        let t = std::time::Instant::now();
        let again =
            claim_processing_in(&locks, &input, lock_owner_is_dead, ClaimHooks::production());
        let reclaim = t.elapsed();
        assert!(
            again.is_ok(),
            "إعادة المعالجة على الملف نفسه يجب أن تنجح فوراً بعد قتل المالك: {:?}",
            again.as_ref().err().map(|e| e.to_string())
        );
        assert!(
            reclaim < std::time::Duration::from_secs(2),
            "الاسترجاع فوري، وقياسه {reclaim:?}"
        );
        assert!(
            reclaim.as_secs() < STALE_LOCK_SECS,
            "الاسترجاع لم ينتظر الطابع الزمني (١٢ ساعة)"
        );
        eprintln!(
            "م٢/القفل الميت: pid={holder_pid} مات بعد {died:?} · الاسترجاع {reclaim:?} \
             (المهلتان: احتياط الطابع الزمني {STALE_LOCK_SECS} ث · قفل بلا PID {UNREADABLE_LOCK_STALE_SECS} ث)"
        );
        drop(again);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **الوعاء الواحد** لكل اختبارات القفل الميت: يطلق حامل قفل حقيقياً، ينتظر
    /// جاهزيته، **يقتله قاسراً** (`TerminateProcess` — لا `Drop`)، ويعيد
    /// `(مسار القفل، pid المالك المقتول، الزمن المنقضي)`.
    ///
    /// `prod = true` ⇒ الطفل يأخذ القفل عبر `claim_processing` الإنتاجية
    /// (‏`locks_dir()` من `HARAMLITE_DATA_DIR` الذي يضبطه المستدعي)، وإلا فبمجلد
    /// أقفال صريح محقون.
    fn kill_a_live_lock_holder(
        dir: &Path,
        input: &Path,
        prod: bool,
    ) -> (PathBuf, u32, std::time::Duration) {
        let ready = dir.join("ready");
        std::fs::create_dir_all(&ready).unwrap();
        let locks = dir.join("locks");
        let lock = if prod {
            lock_name_in(&locks_dir(), input)
        } else {
            lock_name_in(&locks, input)
        };

        let exe = std::env::current_exe().expect("مسار ثنائي الاختبار");
        let mut cmd = std::process::Command::new(&exe);
        cmd.args([
            "pipeline::tests::lock_holder_process",
            "--exact",
            "--nocapture",
        ])
        .env("HARAMLITE_LOCK_INPUT", input)
        .env("HARAMLITE_LOCK_READY", &ready)
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());
        if prod {
            cmd.env(PROD_LOCK_HOLDER_MODE, "1");
        } else {
            cmd.env(LOCK_HOLDER_MODE, "1")
                .env("HARAMLITE_LOCKS_DIR", &locks);
        }
        let mut child = cmd.spawn().expect("إطلاق حامل القفل");

        let pid_file = ready.join("held.pid");
        let started = std::time::Instant::now();
        while !pid_file.exists() && started.elapsed() < std::time::Duration::from_secs(15) {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(
            pid_file.exists(),
            "الطفل لم يعلن أخذه القفل خلال 15 ث — القياس باطل"
        );
        let pid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap_or_default()
            .trim()
            .parse()
            .expect("pid الطفل");

        // ضابط موجب: القفل على القرص يحمل PID الطفل (فالمسار المقيس هو الميداني).
        assert!(lock.is_file(), "ملف القفل موجود: {}", lock.display());
        assert_eq!(lock_owner_pid(&lock), Some(pid), "القفل يحمل PID المالك");

        // القتل القاسر: لا `Drop` ⇒ القفل يبقى (وهذا هو العطل الأصلي).
        assert!(
            kill_process(pid),
            "قتل حامل القفل ({pid}) — القياس بلا قتل باطل"
        );
        let _ = child.wait();
        let died = started.elapsed();
        assert!(
            !process_is_alive(pid),
            "المالك مات فعلاً (وإلا لكان الاسترجاع خاطئاً)"
        );
        assert!(lock.is_file(), "القفل الميت باقٍ على القرص كما في الميدان");
        (lock, pid, died)
    }

    /// **سباق المسترجعَين — العطل الذي أُغلق في `claim_processing_in`**.
    ///
    /// الكود القديم: `remove_file(&lock)` ثم `create_lock` بلا إعادة تحقّق ⇒
    /// إن سبق B إلى الحذف **بعد** أن أنشأ A قفله الجديد، حذف B **قفل A الحيّ**
    /// ⇒ **مالكان لملف واحد** (قياس المدقّق بنافذة ٣٠٠ مللي:
    /// `A-holds=true · B-holds=true · BOTH-HELD-AT-ONCE=true`).
    ///
    /// **والترتيب مُجبَر لا مُتوقَّع**: الخطّاف `before_reclaim` يقع بعد قرار
    /// «القفل ميت» وقبل الخطوة التدميرية، فيُوقف الخيطين عند حاجز ⇒ كلاهما
    /// **مرّ الفحص** ثم يُطلق A وحده (B ينتظر إشعار «أخذت») — فلا `sleep` ولا
    /// رهان على جدولة.
    #[test]
    fn two_reclaimers_race_for_one_dead_lock_and_exactly_one_wins() {
        let _guard = crate::paths::serial_guard();
        let dir = std::env::temp_dir().join(format!("hl_race_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("raced.mp3");
        std::fs::write(&input, b"x").unwrap();
        let locks = dir.join("locks");
        let (_lock, holder_pid, _died) = kill_a_live_lock_holder(&dir, &input, false);

        let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let rx = std::sync::Arc::new(std::sync::Mutex::new(rx));
        let hooks_of =
            |winner: bool,
             gate: std::sync::Arc<std::sync::Barrier>,
             rx: std::sync::Arc<std::sync::Mutex<std::sync::mpsc::Receiver<()>>>| {
                move |_attempt: usize| {
                    gate.wait(); // كلانا بعد فحص «القفل ميت»
                    if !winner {
                        // الخاسر ينتظر حتى يصير القفل للفائز فعلاً — فيقع تدميره
                        // **بعد** ملكية الأول لا قبلها. وهذا هو الترتيب الذي يكشف
                        // الحذف بالاسم.
                        let _ = rx
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .recv_timeout(std::time::Duration::from_secs(20));
                    }
                }
            };
        let a_dir = locks.clone();
        let a_input = input.clone();
        let a_gate = gate.clone();
        let a_rx = rx.clone();
        let a = std::thread::spawn(move || {
            let hook = hooks_of(true, a_gate, a_rx);
            let hooks = ClaimHooks {
                before_reclaim: &hook,
                after_create: &|_| {},
            };
            let r = claim_processing_in(&a_dir, &a_input, lock_owner_is_dead, hooks);
            let _ = tx.send(());
            r
        });
        let b_dir = locks.clone();
        let b_input = input.clone();
        let b_gate = gate.clone();
        let b_rx = rx.clone();
        let b = std::thread::spawn(move || {
            let hook = hooks_of(false, b_gate, b_rx);
            let hooks = ClaimHooks {
                before_reclaim: &hook,
                after_create: &|_| {},
            };
            claim_processing_in(&b_dir, &b_input, lock_owner_is_dead, hooks)
        });

        let a_res = a.join().expect("خيط A");
        let b_res = b.join().expect("خيط B");
        let wins = usize::from(a_res.is_ok()) + usize::from(b_res.is_ok());
        let loser_msg = [&a_res, &b_res]
            .iter()
            .find_map(|r| r.as_ref().err().map(|e| e.to_string()))
            .unwrap_or_default();
        eprintln!(
            "م٢/سباق القفل: مالك القفل الميت pid={holder_pid} · A={:?} · B={:?}",
            a_res.as_ref().map(|_| "يملك"),
            b_res.as_ref().map(|_| "يملك")
        );
        assert_eq!(
            wins,
            1,
            "**مالكان لملف واحد**: A يملك={} · B يملك={} (والقفل يجب أن يعود لواحد)",
            a_res.is_ok(),
            b_res.is_ok()
        );
        assert_eq!(loser_msg, LOCK_BUSY, "الخاسر يفشل بالرسالة الصادقة الواحدة");
        // ولا يدّعي الفائز قفلاً ليس له: قفل قائم حيّ لا يُسترجع.
        assert!(
            lock_owner_pid(&locks.join(lock_file_name(&input))).is_some(),
            "قفل الفائز قائم على القرص بعد السباق"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// اسم ملف القفل (لا مساره) — للمقارنة داخل مجلد أقفال معلوم.
    fn lock_file_name(input: &Path) -> String {
        lock_name_in(Path::new("."), input)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    /// **نافذة القفل الفارغ** (‏`create_new` ثم الكتابة): قفل موجود وفارغ
    /// يُعتبر **محتجَزاً** خلال المهلة — الاتجاه الآمن — ولا يُستَرجع إلا بعدها.
    /// والمهلتان **محقونتان** في الفحص نفسه، فالقياس بلا نوم.
    #[test]
    fn an_empty_lock_is_held_inside_the_grace_window_and_reclaimable_after_it() {
        let dir = std::env::temp_dir().join(format!("hl_empty_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let lock = dir.join("empty.lock");
        std::fs::write(&lock, b"").unwrap();

        let grace = std::time::Duration::from_secs(EMPTY_LOCK_GRACE_SECS);
        let long = std::time::Duration::from_secs(UNREADABLE_LOCK_STALE_SECS);
        assert!(
            !lock_is_reclaimable(&lock, grace, long),
            "قفل فارغ طازج ⇒ محتجَز (مَن ينشئ ثم يكتب لا يُسرق)"
        );
        assert!(
            lock_is_reclaimable(&lock, std::time::Duration::ZERO, long),
            "وبعد المهلة يصير قابلاً للاسترجاع — فلا يتعلّق ملف أبداً"
        );

        // ومحتوى **بلا PID** (نسخة أقدم كتبت طابعاً) تحكمه المهلة الطويلة لا
        // مهلة الفارغ: لا يُستَرجع بمهلة الصفر.
        std::fs::write(&lock, b"not-a-pid").unwrap();
        assert!(
            !lock_is_reclaimable(&lock, std::time::Duration::ZERO, long),
            "نصّ بلا PID ليس قفلاً فارغاً ⇒ المهلة الطويلة"
        );
        assert!(
            lock_is_reclaimable(&lock, std::time::Duration::ZERO, std::time::Duration::ZERO),
            "ومهلة الصفر للمجهول تعني «لا سبيل للفحص» ⇒ استرجاع"
        );

        // والقفل الحيّ (PID حيّ = عمليتنا) لا يُستَرجع بأي مهلة.
        std::fs::write(&lock, format!("{} 1", std::process::id())).unwrap();
        assert!(
            !lock_is_reclaimable(&lock, std::time::Duration::ZERO, std::time::Duration::ZERO),
            "مالك حيّ ⇒ لا استرجاع مهما كان العمر"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **تحقّق الملكية بعد الإنشاء + حدّ المحاولات**: كاتب آخر يستبدل القفل بعد
    /// `create_new` (بالمحاكاة عبر `after_create`) ⇒ لا نعيد حارساً على قفل ليس
    /// قفلنا، وندور **ثلاث محاولات فقط** ثم نقول الرسالة الصادقة.
    ///
    /// (والمُفسَد: إسقاط `lock_is_ours` ⇒ يعود `Ok` على قفلٍ PIDه لغيره.)
    #[test]
    fn a_lock_we_did_not_write_is_never_claimed_as_ours() {
        let dir = std::env::temp_dir().join(format!("hl_notours_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("stolen.mp3");
        std::fs::write(&input, b"x").unwrap();

        let created = std::sync::atomic::AtomicUsize::new(0);
        let reclaimed = std::sync::atomic::AtomicUsize::new(0);
        let hooks = ClaimHooks {
            before_reclaim: &|_| {
                reclaimed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
            after_create: &|p| {
                created.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // مستبدل: PID ليس PIDنا.
                std::fs::write(p, b"4294967290 1").unwrap();
            },
        };
        let r = claim_processing_in(&dir, &input, |_| true, hooks);
        let msg = r.as_ref().err().map(|e| e.to_string()).unwrap_or_default();
        assert!(r.is_err(), "قفلٌ ليس قفلنا لا يُدَّعى (الملكية محتجَزة لغيره)");
        assert_eq!(
            msg, LOCK_BUSY,
            "الرسالة الصادقة الواحدة بعد استنفاد المحاولات"
        );
        assert_eq!(
            created.load(std::sync::atomic::Ordering::SeqCst),
            RECLAIM_ATTEMPTS - 1,
            "الإنشاء يقع في المحاولتين ٠ و٢ (والثالثة استرجاع) — فالحدّ محترم"
        );
        assert_eq!(
            reclaimed.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "استرجاع واحد بينهما — لا دوران بلا حدّ"
        );
        // والقفل المستبدَل **باقٍ** (لم نحذفه: ليس لنا).
        assert!(
            dir.join(lock_file_name(&input)).is_file(),
            "لا نحذف قفل غيرنا"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **المسار الإنتاجي** (لا المحقون): عملية تحمل القفل عبر `claim_processing`
    /// الحقيقية ثم تُقتل ⇒ إعادة المعالجة على **الملف نفسه** تنجح فوراً.
    ///
    /// ولماذا اختبار ثانٍ بعد `a_dead_owner_lock_is_reclaimed_immediately`:
    /// ذاك ينادي `claim_processing_in(…, lock_owner_is_dead)` **بنفسه**، فإسقاط
    /// فحص الحياة من `claim_processing` (المسار الإنتاجي) لا يُسقطه — قياس
    /// المدقّق. وهذا الاختبار يمرّ بـ`claim_processing` وحدها.
    #[test]
    fn the_production_claim_path_reclaims_a_dead_owners_lock() {
        let _serial = crate::paths::serial_guard();
        let _env = crate::paths::env_restore("HARAMLITE_DATA_DIR");
        let base = std::env::temp_dir().join(format!("hl_prodclaim_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::env::set_var("HARAMLITE_DATA_DIR", &base);

        let input = base.join("same_file.mp3");
        std::fs::write(&input, b"x").unwrap();

        // ضابط سالب أولاً: بلا قفل أصلاً ⇒ المسار ينجح (فالقياس على قفل قائم).
        let first = claim_processing(&input).expect("أول أخذ للقفل");
        drop(first);
        drop(claim_processing(&input).expect("بعد التحرير"));

        let (lock, holder_pid, died) = kill_a_live_lock_holder(&base, &input, true);
        // ضابط سالب: القفل قائم وفيه PID ميت ⇒ لولا فحص الحياة لَرُفض الطلب.
        assert_eq!(
            lock_owner_pid(&lock),
            Some(holder_pid),
            "القفل للطفل المقتول"
        );
        assert!(!process_is_alive(holder_pid), "المالك ميت فعلاً");

        let t = std::time::Instant::now();
        let again = claim_processing(&input);
        let reclaim = t.elapsed();
        let msg = again
            .as_ref()
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        eprintln!(
            "م٢/الإنتاج: pid={holder_pid} مات بعد {died:?} · استرجاع المسار الإنتاجي {reclaim:?}"
        );
        assert!(
            again.is_ok(),
            "المسار الإنتاجي يجب أن يسترجع قفل مالك ميت فوراً: {msg}"
        );
        assert!(
            reclaim < std::time::Duration::from_secs(5),
            "الاسترجاع فوري لا بعد ١٢ ساعة، وقياسه {reclaim:?}"
        );
        assert!(
            reclaim.as_secs() < STALE_LOCK_SECS,
            "الاسترجاع لم ينتظر الطابع الزمني (١٢ ساعة)"
        );
        drop(again);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// **`Drop` لا يهدم قفل غيره**: لو استُرجع قفلنا (مالكٌ حُكم عليه بالموت
    /// خطأً) وأنشأ غيره قفلاً في المسار نفسه، فحذفٌ أعمى عند انتهاء مهمّتنا
    /// **يمنح مالكين**: الذي ما زال يعمل، والذي سيقفل بعدنا. فيُشترط أن القفل
    /// **قفلنا** (PIDنا) قبل الحذف.
    ///
    /// (والمُفسَد: حذف بلا شرط ⇒ يسقط هذا الاختبار.)
    #[test]
    fn a_claim_never_deletes_a_lock_that_is_no_longer_its_own() {
        let dir = std::env::temp_dir().join(format!("hl_dropguard_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("taken.mp3");
        std::fs::write(&input, b"x").unwrap();

        let claim =
            claim_processing_in(&dir, &input, |_| false, ClaimHooks::production()).expect("قفلنا");
        let lock = lock_name_in(&dir, &input);
        assert!(lock.is_file(), "القفل مكتوب باسمنا");
        // مسترجع آخر سبقنا: القفل الآن يحمل PID غيره (لا وجود له ⇒ «ميّت» لكنه
        // ليس قفلنا — وهذا هو الفرق الذي يقيسه الاختبار).
        std::fs::write(&lock, b"4294967290 1").unwrap();
        drop(claim);
        assert!(
            lock.is_file(),
            "`Drop` حذف قفلاً ليس قفله — وهذا يفتح الباب لمالكين لملف واحد"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// قتل قاسر بعملية (نفس مسار الميدان: قتل مهمّة لا يعمل المدوِّرات).
    #[cfg(windows)]
    fn kill_process(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if h.is_null() || h == INVALID_HANDLE_VALUE {
                return false;
            }
            let ok = TerminateProcess(h, 1);
            CloseHandle(h);
            ok != 0
        }
    }

    #[cfg(not(windows))]
    fn kill_process(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// اسم القفل **واحد للملف الواحد** أياً كانت صيغة المسار: الصيغة النسبية
    /// و`..` والحالة المختلفة للحروف تُجزّأ تجزئة واحدة (وإلا مرّت معالجة
    /// مزدوجة لنفس الملف). والاختبار يستدعي `lock_name_for` نفسها (لا نسخة من
    /// صيغتها) فتبقى مغطّاة بعد فصل `claim_processing_in`.
    #[test]
    fn the_same_file_maps_to_one_lock_however_it_is_spelled() {
        let _guard = crate::paths::test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = std::env::temp_dir().join(format!("hl_lockname_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("sub")).unwrap();
        let f = tmp.join("Clip.MP3");
        std::fs::write(&f, b"x").unwrap();

        let direct = lock_name_for(&f);
        let dotted = lock_name_for(&tmp.join("sub").join("..").join("Clip.MP3"));
        assert_eq!(direct, dotted, "الصيغة النسبية بالقفزة لا تُنشئ قفلاً ثانياً");
        assert_ne!(
            direct,
            lock_name_for(&tmp.join("other.MP3")),
            "ملف آخر يقفل باسم آخر"
        );
        assert!(
            direct.starts_with(crate::paths::data_dir().join("locks")),
            "القفل تحت مجلد بيانات التطبيق: {}",
            direct.display()
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Cross-path exclusion: a live claim blocks a second claimant.
    #[test]
    fn processing_lock_excludes_double_claim() {
        // The lock file lives under the shared resolved data dir, so this test
        // must not overlap a test that swaps or deletes that dir (the bridge
        // tests set HARAMLITE_DATA_DIR and remove their base on teardown).
        let _guard = crate::paths::test_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = std::env::temp_dir().join(format!("hl_lock_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("a.mp3");
        std::fs::write(&f, b"fake").unwrap();
        let c1 = claim_processing(&f).expect("first claim");
        assert!(
            claim_processing(&f).is_err(),
            "second concurrent claim must conflict"
        );
        drop(c1);
        let _c2 = claim_processing(&f).expect("lock released on drop");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Audit 2026-09-03: a failed run must not leave `_haramlite_work`
    /// scratch (tens of MB) behind in the user's output folder.
    #[test]
    fn failed_run_leaves_no_work_dir() {
        // `process_file` claims the cross-path lock, and that lock file lives
        // under the shared resolved data dir — so this test READS the env var
        // the bridge tests write. Same crate-wide lock as theirs (paths.rs).
        let _guard = crate::paths::serial_guard();
        let tmp = std::env::temp_dir().join(format!("hl_pipe_fail_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let out = tmp.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let missing = tmp.join("no_such_file.mp3");
        let r = process_file(
            &missing,
            &out,
            Mode::Song,
            OutKind::Audio {
                fmt: OutFormat::Mp3,
            },
            false,
            true,
            false,
            None,
            &CancelToken::new(),
            &|_| true,
            &|_, _| {},
        );
        assert!(r.is_err(), "missing input must fail");
        assert!(
            !out.join("_haramlite_work").exists(),
            "scratch dir must be cleaned on failure"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Negative test for ٤.ب.١٠: a cancel that lands on the final checkpoint
    /// must fail the run **and** remove what the run just wrote — before the
    /// fix the value was dropped, the run returned Ok, and the caller then
    /// deleted the downloaded source of a "successful" job.
    #[test]
    fn a_final_cancel_fails_the_run_and_removes_the_output() {
        let dir = std::env::temp_dir().join(format!("hl_cancel_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.mp4");
        std::fs::write(&out, b"x").unwrap();

        let cancelled = finish_run(&|_| false, [Some(out.as_path()), None, None]);
        assert!(
            cancelled.is_err(),
            "a cancelled run must never report success"
        );
        assert!(!out.exists(), "the cancelled run's output must be removed");

        std::fs::write(&out, b"y").unwrap();
        let finished = finish_run(&|_| true, [Some(out.as_path()), None, None]);
        assert!(finished.is_ok(), "a normal finish must stay Ok");
        assert!(out.exists(), "a completed run must keep its output");

        // A missing file must not panic (best-effort removal, like the rest).
        let gone = dir.join("never_written.mp4");
        let r = finish_run(&|_| false, [Some(gone.as_path()), None, None]);
        assert!(r.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **ب٥ — الفخّ الدلالي، بنيوياً**: خريطة صوت الصفحة لا تصل إلى
    /// `kept_ranges` أبداً.
    ///
    /// **الثابت المحروس**: `kept_ranges` تعني «ما قُصّ فعلاً من الملف
    /// المُسلَّم للمستخدم»، ومسار `clip` **لا يقصّ** ملف المستخدم (وعد الواجهة
    /// `src/i18n.ts:22`). فخريطة الكتم لو مرّت هناك لصار المشغّل يظنّ الفجوة
    /// محذوفة وهي موجودة مكتومة ⇒ «الخريطة مسطّحة داخل الفجوة» يصير **كاذباً**
    /// (`scripts/check-extension-sync.cjs` §٢) ويهبط الموضع أمام الصورة.
    ///
    /// **حدّ الحارس (معلَن)**: حارس نصّي لا برهان — يقرأ النصف الإنتاجي من هذا
    /// الملف نفسه (`include_str!`) ويحكم على **كل** استخدام للمعرّف فيه. تحويلٌ
    /// ملتوٍ عبر اسم مستعار (تعريف وسيط يُنسخ إليه ثم يُكتب منه) لا يراه، وهو
    /// موكول إلى المراجعة.
    ///
    /// **مُفسَده**: `kept_ranges = page_kept.clone();` في فرع clip ⇒ يسقط
    /// الادّعاءان (فحص الكتابة، وقائمة الاستخدامات) ويُسمّى الثابت المنقوض.
    #[test]
    fn the_page_map_never_reaches_kept_ranges() {
        let src = include_str!("pipeline.rs");
        // النصف الإنتاجي وحده: كتلة الاختبارات تتكلّم عن الحقلين معاً بالضرورة.
        // (وليس أول `#[cfg(test)]` في الملف — ذاك على `lock_name_for` أعلى الملف.)
        let cut = src.rfind("\nmod tests {").unwrap_or(src.len());
        let production = &src[..cut];

        /// هل يذكر السطر المعرّف `kept_ranges` (بحدّ معرّف: لا `kept_ranges_sec`)؟
        fn mentions(line: &str) -> bool {
            let mut rest = line;
            while let Some(i) = rest.find("kept_ranges") {
                let after = &rest[i + "kept_ranges".len()..];
                if !after.starts_with(|c: char| c.is_alphanumeric() || c == '_') {
                    return true;
                }
                rest = after;
            }
            false
        }
        /// تجريد المحارف النصّية: `{kept_ranges=}` داخل سطر سجلّ ليس إسناداً.
        fn strip_literals(line: &str) -> String {
            let mut out = String::with_capacity(line.len());
            let mut in_str = false;
            let mut chars = line.chars();
            while let Some(c) = chars.next() {
                if in_str {
                    if c == '\\' {
                        let _ = chars.next();
                    } else if c == '"' {
                        in_str = false;
                    }
                    continue;
                }
                if c == '"' {
                    in_str = true;
                    continue;
                }
                out.push(c);
            }
            out
        }
        /// الكتابة في الحقل: إسناد (`=`) في أي موضع من السطر، أو نداء مُغيِّر.
        fn writes_to_it(line: &str) -> bool {
            let line = strip_literals(line);
            let mut rest = line.as_str();
            while let Some(i) = rest.find("kept_ranges") {
                let after = rest[i + "kept_ranges".len()..].trim_start();
                if after.starts_with('=') && !after.starts_with("==") {
                    return true;
                }
                if after.starts_with('[') {
                    return true;
                }
                for m in [
                    ".push(",
                    ".extend(",
                    ".append(",
                    ".insert(",
                    ".splice(",
                    ".drain(",
                    ".retain(",
                    ".truncate(",
                    ".resize(",
                    ".clear(",
                    ".fill(",
                    ".sort",
                    ".swap(",
                    ".pop(",
                    ".remove(",
                ] {
                    if after.starts_with(m) {
                        return true;
                    }
                }
                rest = &rest[i + "kept_ranges".len()..];
            }
            false
        }

        // (١) الكتابة في الحقل — سلسلة الأغنية وحدها.
        let writes: Vec<&str> = production
            .lines()
            .map(str::trim)
            .filter(|t| !t.starts_with("//") && writes_to_it(t))
            .collect();
        assert_eq!(
            writes,
            vec!["kept_ranges = crate::effects::enhance_song_file("],
            "الثابت المنقوض: «kept_ranges تصف ما قُصّ من الملف المُسلَّم، ومسار clip لا يقصّه» \
             — الكتابة الوحيدة المسموحة هي سلسلة الأغنية"
        );

        // (٢) كل استخدام آخر (قراءة أو تمرير) — قائمة مُراجَعة: أي سطر جديد
        // هنا يجب أن يُراجَع، فإن كان قراءة/سجلاً يُضاف بعد التحقّق، وإن كان
        // كتابةً من مسار clip فالثابت منقوض.
        let uses: Vec<&str> = production
            .lines()
            .map(str::trim)
            .filter(|t| !t.starts_with("//") && mentions(t))
            .collect();
        assert_eq!(
            uses,
            vec![
                "pub kept_ranges: Vec<(f64, f64)>,",
                "let mut kept_ranges: Vec<(f64, f64)> = Vec::new();",
                "kept_ranges = crate::effects::enhance_song_file(",
                "&kept_ranges",
                "kept_ranges,",
                "tracing::info!(target: \"pipe\", \"pipeline done in {seconds:.1}s (kept_ranges={} · page_kept={})\", out.kept_ranges.len(), out.page_kept.len());",
            ],
            "استخدام جديد لـkept_ranges — راجعه: إن كان كتابةً من مسار clip فالثابت المنقوض \
             («kept_ranges تصف ما قُصّ من الملف المُسلَّم»)، وإن كان قراءة/سجلاً فأضفه بعد التحقّق"
        );

        // ومقصّ الفيديو يبقى مربوطاً بالخريطة نفسها، لا بخريطة الصفحة.
        assert!(
            production
                .contains("let ranges_for_video: &[(f64, f64)] = if matches!(mode, Mode::Song)"),
            "مقصّ الفيديو لا يجوز أن يُغذّى من خريطة مسار clip"
        );
        // والخريطتان مفصولتان بنيوياً: كل واحدة تُبنى في فرعها.
        assert!(
            production.contains("let page_kept: Vec<(f64, f64)> = if matches!(mode, Mode::Clip)"),
            "خريطة الصفحة تُبنى في فرع clip وحده"
        );
    }
}
