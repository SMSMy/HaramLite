//! CUDA_RUNTIME_PLAN.md — تسريع CUDA ذاتي التنزيل: المستخدم النهائي لا يثبّت
//! أي شيء إطلاقاً.
//!
//! عند أول تفعيل لخيار CUDA، ينزّل التطبيق منفستاً من إصدار `assets-v1`
//! (يولّده CI عند الرفع) ثم المكتبات الست عشرة بتحقق SHA-256 وتثبيت ذري.
//! ملاحظة معمارية: مكتبات ONNX Runtime مربوطة ربطاً ثابتاً داخل التنفيذي —
//! مزوّد CUDA مضمّن فيه ويحمّل ملفات NVIDIA هذه ديناميكياً (LoadLibrary)،
//! لذلك لا حاجة لملف `onnxruntime_providers_cuda.dll` منفصل في هذا البناء.

use std::path::{Path, PathBuf};

/// ملفات تشغيل CUDA الست عشرة (الشرط 1 — كاملة فعلاً هذه المرة):
/// NVIDIA (CUDA 12.x / cuDNN 9.x) + جسر مزود ORT 1.22.
/// الدرس المؤلم: مزود CUDA في ORT يُحمّل ديناميكياً عبر الجسر ويحتاج
/// `cufft64_11.dll` (كان ناقصاً — أول تبعية مفقودة أبلغ عنها المحمل) ثم
/// مكتبتي الجسر نفسيهما `onnxruntime_providers_{shared,cuda}.dll` بالنسخة
/// المطابقة تماماً لبناء ORT المضمّن (1.22.0) — بدونهما يسقط التسجيل بصمت.
pub const CUDA_FILES: &[&str] = &[
    // NVIDIA: cudart + cublas(+Lt) + cuFFT + cuDNN كاملة (أربعة عشر ملفاً
    // في القائمة أدناه، عدا مكتبتَي جسر ORT: أي نقص — كما حدث مع
    // cudnn_graph — قد يسقط التهيئة بانهيار أصلي لا بـpanic، فالاكتمال هنا
    // مسألة استقرار لا ترف).
    "cudart64_12.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll",
    "cufft64_11.dll",
    "cudnn64_9.dll",
    "cudnn_ops64_9.dll",
    "cudnn_cnn64_9.dll",
    "cudnn_adv64_9.dll",
    "cudnn_graph64_9.dll",
    "cudnn_heuristic64_9.dll",
    "cudnn_engines_precompiled64_9.dll",
    "cudnn_engines_runtime_compiled64_9.dll",
    "cudnn_engines_tensor_ir64_9.dll",
    "cudnn_ext64_9.dll",
    // ORT provider bridge (exact 1.22.0 match — keep in lockstep with
    // `.github/workflows/cuda-assets.yml` and CUDA_RUNTIME_PLAN.md)
    "onnxruntime_providers_shared.dll",
    "onnxruntime_providers_cuda.dll",
];

const MANIFEST_ASSET: &str = "cuda-runtime-manifest.json";
const USER_AGENT: &str = "HaramLite-Repair/0.2";

/// Manifest asset names must be bare filenames (`^[A-Za-z0-9_.-]+$`), never
/// paths: the manifest is fetched from a remote release, and each name is
/// joined onto `bin/` then renamed — so `..`, separators, or absolute paths
/// would write outside the install dir. Pure function, unit-tested.
pub(crate) fn asset_name_ok(name: &str) -> bool {
    if name.is_empty() || name == "." {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains(':') {
        return false;
    }
    if name.contains("..") {
        return false;
    }
    if Path::new(name).is_absolute() {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

/// The manifest hash must be a 64-char hex SHA-256 (compared case-insensitively
/// after trimming in `file_matches`). Pure function, unit-tested.
pub(crate) fn asset_sha_ok(sha: &str) -> bool {
    let s = sha.trim();
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// مجلد التثبيت: `<مجلد التنفيذي>\bin` (بجوار ffmpeg/ffprobe).
fn bin_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().map(|p| p.join("bin")).unwrap_or_default()
}

/// كل الملفات موجودة في مجلد معين → جلسة CUDA تستطيع تحميلها.
pub(crate) fn dir_has_runtime(dir: &Path) -> bool {
    runtime_gap_in(dir) == RuntimeGap::Usable
}

/// مثبت بالقياس: جسر مزود ORT لا يبحث في `bin/` (لا SetDllDirectory ولا
/// PATH) — يحمّل مكتبتيه من مجلد التنفيذي فقط. النسخ هنا للتحميل، والفحص
/// والتنزيل يبقيان على `bin/` وحده (مصدر واحد للحقيقة).
pub const BRIDGE_DLLS: &[&str] = &[
    "onnxruntime_providers_shared.dll",
    "onnxruntime_providers_cuda.dll",
];

/// شفاء إقلاعي: إن وُجدت مكتبتا الجسر في `bin/` وغابتا عن مجلد التنفيذي
/// انسخهما (الحالة الشائعة بعد التنزيل الذاتي). آمن للتكرار ولا يمس ملفات
/// المستخدم — يعمل على مجلدات تُمرر صراحة ليفحصه الاختبار دون آثار جانبية.
pub(crate) fn heal_provider_dlls_in(exe_dir: &Path, bin_dir: &Path) -> usize {
    let mut healed = 0;
    for name in BRIDGE_DLLS {
        let dest = exe_dir.join(name);
        if dest.is_file() {
            continue;
        }
        let src = bin_dir.join(name);
        if src.is_file() && std::fs::copy(&src, &dest).is_ok() {
            healed += 1;
        }
    }
    healed
}

/// الملفات الست عشرة موجودة → جلسة CUDA تستطيع تحميلها.
pub fn is_available() -> bool {
    dir_has_runtime(&bin_dir())
}

// ─────────────────── حالات CUDA صريحة: كشف نقي + قرار + رسالة ───────────────
//
// ROADMAP §٧.ب بند ٩: «لكل حالة رسالة واضحة + سقوط إلى CPU (لا فشل صامت ولا خطأ
// عام)، واختبارات وحدة لما يمكن محاكته بلا عتاد».
//
// كل ما في هذا القسم **دوال نقية** تستقبل ما تقرأه من القرص أو من البيئة بدل
// أن تقرأه بنفسها — لأن قراءة `current_exe()` و`SystemRoot` تجعل الفحص غير
// قابل للاختبار. لا يتغيّر سلوك المعالجة هنا إطلاقاً: هذه طبقة تشخيص وقرار،
// وسلسلة المحاولات الفعلية تبقى كما هي في `separator::MdxSession::load`.

/// اسم مكتبة التعريف (`nvcuda.dll` يأتي مع تعريف NVIDIA نفسه).
pub(crate) const DRIVER_DLL: &str = "nvcuda.dll";

/// هل يوجد كرت NVIDIA أصلاً؟ النسخة القابلة للاختبار: تقبل جذر النظام.
pub(crate) fn nvidia_gpu_present_in(system_root: &Path) -> bool {
    system_root.join("System32").join(DRIVER_DLL).exists()
}

/// نتيجة فحص مجلد التشغيل. الفصل بين «لم يُنزَّل شيء» و«نُزِّل بعضه» مقصود:
/// الأولى حالة مستخدم جديد، والثانية عطل حقيقي (تنزيل انقطع أو ملف حُذف يدوياً)
/// — ونصيحة كل منهما مختلفة.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RuntimeGap {
    Usable,
    /// لا يوجد أي ملف من الستة عشر — لم يُفعَّل التنزيل الذاتي بعد.
    Absent,
    /// بعض الملفات موجود وبعضها ناقص — إما لم تكتمل بعد أو حُذف بعضها يدوياً.
    Incomplete(Vec<String>),
}

/// فحص نقي لمجلد التشغيل — يفصل «غائب» عن «ناقص» بدل `bool` واحد كان يخلط
/// حالات مختلفة تماماً في سببها وفي ما على المستخدم فعله.
pub(crate) fn runtime_gap_in(dir: &Path) -> RuntimeGap {
    let missing: Vec<String> = CUDA_FILES
        .iter()
        .filter(|f| !dir.join(f).is_file())
        .map(|f| (*f).to_string())
        .collect();
    if missing.is_empty() {
        RuntimeGap::Usable
    } else if missing.len() == CUDA_FILES.len() {
        RuntimeGap::Absent
    } else {
        RuntimeGap::Incomplete(missing)
    }
}

/// حالة CUDA كما تُشخَّص قبل بناء الجلسة. **لا تُغيّر أي قرار معالجة** — تصف
/// الواقع كي تُبنى الرسالة عليه.
///
/// ملاحظة صدق: «جهاز موجود وتهيئته تفشل» (تعريف أقدم، أو cuDNN غير مطابق، أو
/// فشل تحميل فعلي) **لا يُكتشف من الملفات**: الستة عشر تكتمل أسماؤها ولا شيء
/// في أسمائها يكشف إصدارها. لذلك لا ندّعي حالة خامسة هنا — تُجرَّب CUDA فعلاً
/// في تلك الحالة، وإن سقطت فهي رسالة `ort` الأصلية (تُلتقط في
/// `separator::ep_first_error`) مع السقوط الصريح إلى DirectML ثم CPU.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CudaState {
    /// المستخدم لم يطلب CUDA — لا رسالة تحذير إطلاقاً.
    NotRequested,
    /// طُلبت CUDA ولا كرت NVIDIA على الجهاز (لا `nvcuda.dll` = لا تعريف).
    NoNvidiaGpu,
    /// الكرت والتعريف موجودان، ومكتبات التشغيل غير مكتملة في `bin/`.
    RuntimeIncomplete,
    /// الأسماء الستة عشر كاملة والشاشة عليها كرت — تُجرَّب CUDA فعلاً.
    Ready,
}

/// تشخيص كامل قابل للاختبار بلا عتاد (تُمرَّر له كل المدخلات).
pub(crate) struct CudaDiagnosis {
    pub state: CudaState,
    /// عدد ملفات التشغيل الموجودة فعلاً من الستة عشر.
    pub present: usize,
    /// الملفات الناقصة (فارغة في حالة الاكتمال).
    pub missing: Vec<String>,
    /// هل يرى النظام كرت NVIDIA (وجود `nvcuda.dll` = تعريف مثبت)؟ يحدّد نصّ
    /// الحالة: «لا كرت» ليست «كرت بلا مكتبات».
    pub gpu_present: bool,
}

impl CudaDiagnosis {
    /// الرسالة الظاهرة في السجل. **لكل حالة نصّها الخاص** — لا نصّ عام واحد
    /// يخفي السبب، ولا سقوط صامت.
    pub fn message(&self) -> String {
        match self.state {
            CudaState::NotRequested => "CUDA غير مطلوبة — DirectML أولاً".to_string(),
            CudaState::Ready => format!(
                "CUDA مكتملة ({}/{} ملفاً) — ستُجرَّب أولاً",
                self.present,
                CUDA_FILES.len()
            ),
            // `nvcuda.dll` comes with the driver, so its absence covers both
            // "no card" and "card without a driver" — same fact, same fix. The
            // wording still separates the two so the log is actionable.
            CudaState::NoNvidiaGpu if self.gpu_present => format!(
                "كرت NVIDIA موجود لكن مكتبات تشغيل CUDA غير مكتملة في مجلد bin ({}) — \
                 هذا طلب CUDA بلا مكتبات، وسيُستخدم DirectML ثم CPU الآن",
                self.gap_detail()
            ),
            CudaState::NoNvidiaGpu => format!(
                "لا يوجد كرت NVIDIA بتعريفه على هذا الجهاز ({DRIVER_DLL} غير موجود في System32) — \
                 لا يمكن تشغيل CUDA، وسيُستخدم DirectML ثم CPU"
            ),
            CudaState::RuntimeIncomplete => format!(
                "تعريف NVIDIA موجود لكن مكتبات تشغيل CUDA غير مكتملة في مجلد bin: {} — \
                 فعّل خيار CUDA في الإعدادات لتنزيلها تلقائياً، وسيُستخدم DirectML ثم CPU الآن",
                self.gap_detail()
            ),
        }
    }

    /// وصف النقص بصيغة واحدة («لم تُنزَّل أي…» أو «ينقص n من 16 (أسماء)»).
    fn gap_detail(&self) -> String {
        if self.missing.len() == CUDA_FILES.len() {
            format!("لم تُنزَّل أي من {} ملفاتها بعد", CUDA_FILES.len())
        } else {
            format!(
                "ينقص {} من {} ملفاً ({})",
                self.missing.len(),
                CUDA_FILES.len(),
                summarize_missing(&self.missing)
            )
        }
    }

    /// هل تُجرَّب CUDA فعلاً في هذه الجلسة؟ (البوابة الوحيدة لسلسلة المحاولات)
    pub fn attempt_cuda(&self) -> bool {
        self.state == CudaState::Ready
    }
}

/// أول أسماء قليلة من الناقص + عدّاد الباقي (رسالة واحدة لا قائمة طويلة).
fn summarize_missing(missing: &[String]) -> String {
    const SHOWN: usize = 3;
    let head: Vec<&str> = missing.iter().take(SHOWN).map(|s| s.as_str()).collect();
    if missing.len() > SHOWN {
        format!("{}، و{} غيرها", head.join("، "), missing.len() - SHOWN)
    } else {
        head.join("، ")
    }
}

/// التشخيص النقي: كل مدخل يُمرَّر صراحةً فيصير الاختبار ممكناً بلا عتاد.
pub(crate) fn diagnose(use_cuda: bool, gpu_present: bool, gap: RuntimeGap) -> CudaDiagnosis {
    let missing = match &gap {
        RuntimeGap::Usable => Vec::new(),
        RuntimeGap::Absent => CUDA_FILES.iter().map(|f| (*f).to_string()).collect(),
        RuntimeGap::Incomplete(m) => m.clone(),
    };
    let present = CUDA_FILES.len() - missing.len();
    // Not asking = no warning, whatever the machine looks like.
    if !use_cuda {
        return CudaDiagnosis { state: CudaState::NotRequested, present, missing, gpu_present };
    }
    let state = match &gap {
        // Complete set AND a device: the only state where CUDA is attempted.
        RuntimeGap::Usable if gpu_present => CudaState::Ready,
        // Complete set, no device: attempting would only burn a provider build
        // that cannot register — the provider cannot load without `nvcuda.dll`.
        RuntimeGap::Usable => CudaState::NoNvidiaGpu,
        // Libraries incomplete: with a device this is the actionable
        // "download them" case; without one there is nothing to download for.
        RuntimeGap::Absent | RuntimeGap::Incomplete(_) if gpu_present => {
            CudaState::RuntimeIncomplete
        }
        RuntimeGap::Absent | RuntimeGap::Incomplete(_) => CudaState::NoNvidiaGpu,
    };
    CudaDiagnosis { state, present, missing, gpu_present }
}

/// القرارات التي تتخذها طبقة التشخيص (فقط) — تُختبر وتُقرأ في السجل.
pub(crate) struct CudaPlan {
    pub attempt_cuda: bool,
    /// ترتيب المزودين الذي ستسلكه السلسلة فعلاً (للسجل: لا ادّعاء ولا إخفاء).
    pub provider_chain: &'static str,
}

/// الخطوة التالية: سلسلة المحاولات كما هي في `MdxSession::load` بلا تغيير،
/// لكن مع تصريح حالة الجهاز التي أُسقطت سابقاً من التقرير.
pub(crate) fn plan(d: &CudaDiagnosis) -> CudaPlan {
    if d.attempt_cuda() {
        CudaPlan { attempt_cuda: true, provider_chain: "CUDA -> DirectML -> CPU" }
    } else {
        CudaPlan { attempt_cuda: false, provider_chain: "DirectML -> CPU" }
    }
}

/// التشخيص الفعلي على هذا الجهاز (يقرأ القرص والبيئة مرة واحدة).
pub(crate) fn current_diagnosis(use_cuda: bool) -> CudaDiagnosis {
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let driver = nvidia_gpu_present_in(Path::new(&sysroot));
    diagnose(use_cuda, driver, runtime_gap_in(&bin_dir()))
}

/// هل يوجد كرت NVIDIA أصلاً؟ (`nvcuda.dll` يأتي مع تعريف الكرت)
pub fn nvidia_gpu_present() -> bool {
    #[cfg(target_os = "windows")]
    {
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        nvidia_gpu_present_in(Path::new(&sysroot))
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// الشفاء الإقلاعي: نسخ من `bin/` لمجلد التنفيذي عند الغياب فقط.
    #[test]
    fn provider_heal_copies_missing_only() {
        let base = std::env::temp_dir().join(format!("hl_heal_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let exe_dir = base.join("exe");
        let bin_dir = base.join("bin");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();
        for name in BRIDGE_DLLS {
            std::fs::write(bin_dir.join(name), b"dll-bytes").unwrap();
        }
        assert_eq!(heal_provider_dlls_in(&exe_dir, &bin_dir), 2);
        assert_eq!(heal_provider_dlls_in(&exe_dir, &bin_dir), 0, "second run is a no-op");
        // A real user file at destination must never be overwritten.
        std::fs::write(exe_dir.join(BRIDGE_DLLS[0]), b"user-bytes").unwrap();
        assert_eq!(heal_provider_dlls_in(&exe_dir, &bin_dir), 0);
        assert_eq!(
            std::fs::read(exe_dir.join(BRIDGE_DLLS[0])).unwrap(),
            b"user-bytes"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Manifest names: bare filenames only — no traversal, no separators,
    /// no absolute paths, no spaces.
    #[test]
    fn manifest_asset_names_are_sanitized() {
        assert!(!asset_name_ok(r"..\..\hl_probe.txt"));
        assert!(!asset_name_ok(r"C:\Windows\x.dll"));
        assert!(!asset_name_ok("a/b.dll"));
        assert!(!asset_name_ok("a\\b.dll"));
        assert!(!asset_name_ok("my dll.dll"));
        assert!(!asset_name_ok(".."));
        assert!(!asset_name_ok(""));
        assert!(asset_name_ok("cufft64_11.dll"));
        assert!(asset_name_ok("cudnn_ops64_9.dll"));
    }

    /// Manifest hashes: 64 hex chars (case-insensitive, surrounding
    /// whitespace tolerated).
    #[test]
    fn manifest_asset_shas_are_validated() {
        assert!(asset_sha_ok(
            "fb04eb6c6592db00df19e5554e889117874b77afb485eb0326276200ce7c2c33"
        ));
        assert!(!asset_sha_ok("xyz"));
        assert!(!asset_sha_ok(""));
    }
}

/// الشرط 2 — حل مسار القراءة: يُستدعى أول سطر في `run()` و`cli_entry()`
/// وقبل أي خيط آخر وقبل أي تهيئة ORT. طبقتان:
/// 1) `SetDllDirectoryW(<bin>)` — مسار بحث خاص بالعملية الحالية فقط.
/// 2) حقن `PATH` احتياطي يغطي التحميلات غير المباشرة.
///
/// تنظيف ذاتي: سكربت بناء ort يترك ملفات `onnxruntime_providers_*.dll`
/// فارغة (0 بايت) بجانب التنفيذي، وهي تحجب (shadow) النسخ الحقيقية في
/// `bin/` لأن مجلد التنفيذي أول مسارات البحث — أي ملف 0 بايت هنا عديم
/// الفائدة تعريفاً فيُحذف.
/// A 0-byte provider file is useless by definition (the ort build script
/// recreates these stubs on every build) yet it SHADOWS the real DLLs in
/// `bin/`, because the exe dir is first in the loader search order.
pub(crate) fn sweep_provider_stubs_in(dir: &Path) {
    for stub in [
        "onnxruntime_providers_shared.dll",
        "onnxruntime_providers_cuda.dll",
    ] {
        let p = dir.join(stub);
        if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(1) == 0 {
            let _ = std::fs::remove_file(&p);
        }
    }
}

pub fn ensure_dll_path() {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            sweep_provider_stubs_in(exe_dir);
            // Silent by necessity: logging isn't initialized yet at this point.
            let _ = heal_provider_dlls_in(exe_dir, &bin_dir());
        }
    }
    let dir = bin_dir();
    let dir_s = dir.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::LibraryLoader::SetDllDirectoryW;
        let wide: Vec<u16> = dir_s.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { let _ = SetDllDirectoryW(wide.as_ptr()); }
    }
    if let Ok(path) = std::env::var("PATH") {
        if !path.split(';').any(|p| p.eq_ignore_ascii_case(&dir_s)) {
            // safe here: called at process startup before other threads
            std::env::set_var("PATH", format!("{dir_s};{path}"));
        }
    }
}

/// تنزيل + تحقق + تثبيت المكتبات كاملة (الشرطان 1 و3).
/// `progress(name, 0..1)` — اسم الملف الحالي والكسر الإجمالي.
/// أي فشل يعيد Err ويترك المكوّن «ناقصاً» (لا ملفات نصف مكتملة) —
/// والمتصل مسؤول عن التراجع الرشيق لـ DirectML.
pub fn install(progress: &dyn Fn(&str, f32)) -> Result<(), String> {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Manifest {
        files: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        name: String,
        sha256: String,
    }

    let dir = bin_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // 1) المنفست (يولّده CI مع الملفات — ذاتي الوصف، لا بصمات مضمّنة هنا)
    let manifest_url = format!("{}/{}", crate::repair::ASSET_BASE, MANIFEST_ASSET);
    let resp = ureq::get(&manifest_url)
        .timeout(std::time::Duration::from_secs(30))
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| match e {
            // 404 = the repo/CI hasn't published the assets yet — a distinct,
            // honest message, not a scary network error.
            ureq::Error::Status(404, _) => "مكتبات التسريع لم تُنشر بعد في المستودع (assets-v1) — ستتوفر تلقائياً بعد أول إصدار رسمي".to_string(),
            other => format!("تعذر الوصول لمنفست مكونات CUDA: {other}"),
        })?;
    let body = resp
        .into_string()
        .map_err(|e| format!("منفست غير مقروء: {e}"))?;
    let manifest: Manifest =
        serde_json::from_str(&body).map_err(|e| format!("منفست تالف: {e}"))?;
    // Forward-compatible: the manifest may carry MORE files than this build
    // knows (newer runtime revision) — require only our own set, ignore extras.
    // (A strict count check once bricked every top-up during the 7→16 migration.)
    // Security first: validate EVERY entry name/hash BEFORE touching the disk —
    // a hostile manifest must not get a single join/rename/hash-compare.
    for entry in &manifest.files {
        if !asset_name_ok(&entry.name) {
            return Err(format!("اسم ملف مرفوض في المنفست: {}", entry.name));
        }
        if !asset_sha_ok(&entry.sha256) {
            return Err(format!("بصمة مرفوضة في المنفست: {}", entry.name));
        }
    }
    for expected in CUDA_FILES {
        if !manifest.files.iter().any(|e| e.name == *expected) {
            return Err(format!("ينقص المنفست: {expected}"));
        }
    }

    // 2) كل ملف: إن كان موجوداً وبصمته سليمة → تخطَّه (لا إعادة تنزيل بعد
    //    انهيار مفاجئ)؛ وإلا تنزيل مؤقت → SHA-256 → نقل ذري.
    let total = manifest.files.len();
    for (idx, entry) in manifest.files.iter().enumerate() {
        let base = idx as f32 / total as f32;
        let span = 1.0 / total as f32;
        let dest = dir.join(&entry.name);
        if file_matches(&dest, &entry.sha256) {
            progress(&entry.name, base + span);
            continue;
        }
        download_verified(
            &format!("{}/{}", crate::repair::ASSET_BASE, entry.name),
            &dest,
            &entry.sha256,
            &|p| progress(&entry.name, base + p * span),
        )?;
    }
    progress("done", 1.0);
    Ok(())
}

/// ملف موجود على القرص وبصمته تطابق المتوقع؟
fn file_matches(path: &Path, expected_sha: &str) -> bool {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut chunk = [0u8; 256 * 1024];
    loop {
        match f.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => hasher.update(&chunk[..n]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(expected_sha.trim())
}

fn download_verified(
    url: &str,
    dest: &Path,
    expected_sha: &str,
    progress: &dyn Fn(f32),
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let tmp = dest.with_extension("download");
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(600))
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("فشل التنزيل: {e}"))?;
    let total = resp
        .header("Content-Length")
        .and_then(|h| h.parse::<u64>().ok())
        .unwrap_or(0);
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let mut hasher = Sha256::new();
    let mut reader = resp.into_reader();
    let mut gotten: u64 = 0;
    let mut chunk = [0u8; 256 * 1024];
    loop {
        let read = std::io::Read::read(&mut reader, &mut chunk)
            .map_err(|e| format!("انقطع التنزيل: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
        file.write_all(&chunk[..read]).map_err(|e| format!("فشل الكتابة: {e}"))?;
        gotten += read as u64;
        if total > 0 {
            progress((gotten as f32 / total as f32).clamp(0.0, 1.0));
        }
    }
    file.flush().ok();
    drop(file);

    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha.trim()) {
        let _ = std::fs::remove_file(&tmp);
        let name = dest
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Err(format!("بصمة {name} لا تطابق — أُلغي التثبيت حمايةً لك"));
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("تعذر التثبيت: {e}"))?;
    Ok(())
}

/// ROADMAP §٧.ب بند ٩ — حالات الفشل صريحةً. كل ما هنا **محاكى بلا عتاد**: مجلد
/// مؤقت يمثّل `bin/`، ومجلد مؤقت يمثّل `System32`. لا يُدَّعى اختبار عتاد حقيقي:
/// ما يحتاج كرتاً فعلياً هو `separator::tests::cuda_full_separation_smoke`
/// (مُهمَل، ويُشغَّل يدوياً على جهاز فيه RTX).
#[cfg(test)]
mod failure_states {
    use super::*;

    /// مجلد `bin/` كامل مصطنع (16 ملفاً وهمياً) — لا يلزمه عتاد ولا تنزيل.
    fn fake_bin(base: &Path) -> PathBuf {
        let dir = base.join("bin");
        std::fs::create_dir_all(&dir).unwrap();
        for f in CUDA_FILES {
            std::fs::write(dir.join(f), b"stub").unwrap();
        }
        dir
    }

    fn sysroot(with_driver: bool) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "hl_sysroot_{}_{}",
            std::process::id(),
            with_driver
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("System32")).unwrap();
        if with_driver {
            std::fs::write(base.join("System32").join(DRIVER_DLL), b"driver").unwrap();
        }
        base
    }

    /// الحالة 1+2 — لا NVIDIA (أو كرت بلا تعريفه): الرسالة تسمّي السبب ولا تدعو
    /// لتنزيل مكتبات لا فائدة منها.
    #[test]
    fn no_nvidia_gpu_is_named_and_does_not_attempt_cuda() {
        // A machine with no NVIDIA card never downloaded the runtime, so the
        // realistic case is an ABSENT one — covered by `RuntimeGap::Absent`.
        let d = diagnose(true, false, RuntimeGap::Absent);
        assert_eq!(d.state, CudaState::NoNvidiaGpu);
        assert_eq!(d.present, 0);
        assert!(!d.attempt_cuda(), "no device means no CUDA attempt");
        let m = d.message();
        assert!(m.contains("NVIDIA"), "message must name the vendor: {m}");
        assert!(m.contains(DRIVER_DLL), "the missing driver DLL is named: {m}");
        assert!(
            !m.contains("في مجلد bin"),
            "must not ask for a library download when there is no card: {m}"
        );
        assert_eq!(plan(&d).provider_chain, "DirectML -> CPU");
        // Half-downloaded libraries with no driver: the device still decides.
        let d2 = diagnose(true, false, RuntimeGap::Incomplete(vec!["cudart64_12.dll".into()]));
        assert_eq!(d2.state, CudaState::NoNvidiaGpu, "no card wins over a partial download");
        assert!(!d2.attempt_cuda());
    }

    /// الحالة 3 — مكتبة ناقصة: الرسالة تسمّي الناقص بالاسم (وهو ما كان يُفقد
    /// حين كان الفحص `bool` واحداً).
    #[test]
    fn missing_runtime_dlls_are_named_in_the_message() {
        let base = std::env::temp_dir().join(format!("hl_gap_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = fake_bin(&base);
        // A missing cuDNN file is exactly the historical failure this guards.
        std::fs::remove_file(dir.join("cudnn_cnn64_9.dll")).unwrap();
        std::fs::remove_file(dir.join("cufft64_11.dll")).unwrap();
        let gap = runtime_gap_in(&dir);
        assert_eq!(
            gap,
            RuntimeGap::Incomplete(vec!["cufft64_11.dll".into(), "cudnn_cnn64_9.dll".into()])
        );
        let d = diagnose(true, true, gap);
        assert_eq!(d.state, CudaState::RuntimeIncomplete);
        assert_eq!(d.present, CUDA_FILES.len() - 2);
        assert!(!d.attempt_cuda(), "an incomplete runtime must not be attempted");
        let m = d.message();
        assert!(m.contains("cufft64_11.dll"), "missing file must be named: {m}");
        assert!(m.contains("cudnn_cnn64_9.dll"), "missing file must be named: {m}");
        assert!(m.contains("2 من 16"), "count must be explicit: {m}");
        assert!(m.contains("DirectML"), "the fallback must be stated: {m}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// الحالة 4 — «كرت موجود لكن لم تُنزَّل المكتبات»: الرسالة تدلّ على الحل
    /// بخطوة واحدة، وتُفرَّق عن «لا كرت».
    #[test]
    fn present_card_with_no_download_gets_the_one_click_advice() {
        let d = diagnose(true, true, RuntimeGap::Absent);
        assert_eq!(d.state, CudaState::RuntimeIncomplete);
        assert_eq!(d.present, 0);
        assert!(!d.attempt_cuda());
        let m = d.message();
        assert!(m.contains("لم تُنزَّل أي من 16"), "absent is stated as such: {m}");
        assert!(m.contains("تنزيلها تلقائياً"), "the one-click fix is stated: {m}");
        assert!(!m.contains(DRIVER_DLL), "the driver is present, not the problem: {m}");
    }

    /// الحالة 5 — الاكتمال: الستة عشر موجودة، فتُجرَّب CUDA فعلاً. وإن فشلت
    /// التهيئة (تعريف أقدم أو cuDNN غير مطابق) فذلك لا يُكتشف من الأسماء —
    /// تلتقطه رسالة `ort` والسقوط الصريح في `separator`.
    #[test]
    fn complete_runtime_attempts_cuda_and_defers_failure_to_the_chain() {
        let base = std::env::temp_dir().join(format!("hl_full_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = fake_bin(&base);
        assert_eq!(runtime_gap_in(&dir), RuntimeGap::Usable);
        assert!(dir_has_runtime(&dir), "existing behaviour preserved");
        let d = diagnose(true, true, runtime_gap_in(&dir));
        assert_eq!(d.state, CudaState::Ready);
        assert!(d.attempt_cuda());
        assert_eq!(d.present, CUDA_FILES.len());
        assert!(d.message().contains("16/16"), "message states completeness");
        // The chain is confirmed BEFORE any attempt — so a silent fallback is
        // impossible to report as CUDA.
        assert_eq!(plan(&d).provider_chain, "CUDA -> DirectML -> CPU");
        // Complete NAMES but no driver: attempting would only burn a provider
        // build that cannot register — the device is reported instead.
        let nd = diagnose(true, false, RuntimeGap::Usable);
        assert_eq!(nd.state, CudaState::NoNvidiaGpu);
        assert!(!nd.attempt_cuda());
        assert_eq!(plan(&nd).provider_chain, "DirectML -> CPU");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// لا طلب → لا تحذير، مهما كانت حالة الجهاز.
    #[test]
    fn not_requested_stays_silent_about_cuda() {
        let gaps = [
            RuntimeGap::Usable,
            RuntimeGap::Absent,
            RuntimeGap::Incomplete(vec![DRIVER_DLL.into()]),
        ];
        for gap in &gaps {
            for driver in [true, false] {
                // `diagnose` takes the gap by value so it can move the missing
                // list into the diagnosis; rebuild it per iteration instead of
                // cloning (keeps `RuntimeGap` free of a Clone impl it needs
                // nowhere else).
                let gap = match gap {
                    RuntimeGap::Usable => RuntimeGap::Usable,
                    RuntimeGap::Absent => RuntimeGap::Absent,
                    RuntimeGap::Incomplete(m) => RuntimeGap::Incomplete(m.clone()),
                };
                let d = diagnose(false, driver, gap);
                assert_eq!(d.state, CudaState::NotRequested);
                assert!(!d.attempt_cuda());
                assert!(!d.message().contains("ينقص"));
                assert_eq!(plan(&d).provider_chain, "DirectML -> CPU");
            }
        }
    }

    /// كشف التعريف من مجلد النظام، وفصل «غائب» عن «ناقص»، وتقصير القوائم
    /// الطويلة.
    #[test]
    fn driver_presence_absent_vs_incomplete_and_long_lists() {
        assert!(nvidia_gpu_present_in(&sysroot(true)));
        assert!(!nvidia_gpu_present_in(&sysroot(false)));
        // Empty dir = Absent, one file present = Incomplete.
        let base = std::env::temp_dir().join(format!("hl_gapkind_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        assert_eq!(runtime_gap_in(&base), RuntimeGap::Absent);
        std::fs::write(base.join(CUDA_FILES[0]), b"stub").unwrap();
        match runtime_gap_in(&base) {
            RuntimeGap::Incomplete(m) => {
                assert_eq!(m.len(), CUDA_FILES.len() - 1);
                assert!(!m.contains(&CUDA_FILES[0].to_string()), "present file is not 'missing'");
            }
            other => panic!("expected Incomplete, got {other:?}"),
        }
        // The long-list summary must not print sixteen names. All sixteen
        // missing is the `Absent` wording, so one file is kept present here to
        // reach the `Incomplete` summary path.
        let long: Vec<String> = CUDA_FILES.iter().skip(1).map(|s| s.to_string()).collect();
        assert_eq!(long.len(), CUDA_FILES.len() - 1);
        let long = diagnose(true, true, RuntimeGap::Incomplete(long)).message();
        assert!(long.contains("و12 غيرها"), "long lists are summarised: {long}");
        assert!(
            !long.contains(&CUDA_FILES[5].to_string()),
            "only the first few names are listed: {long}"
        );
        // All sixteen missing has its own, shorter wording.
        let absent = diagnose(true, true, RuntimeGap::Absent).message();
        assert!(absent.contains("لم تُنزَّل أي من 16"), "absent wording: {absent}");
        let _ = std::fs::remove_dir_all(&base);
    }
}

