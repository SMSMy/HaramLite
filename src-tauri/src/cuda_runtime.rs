//! CUDA_RUNTIME_PLAN.md — تسريع CUDA ذاتي التنزيل: المستخدم النهائي لا يثبّت
//! أي شيء إطلاقاً.
//!
//! عند أول تفعيل لخيار CUDA، ينزّل التطبيق منفستاً من إصدار `assets-v1`
//! (يولّده CI عند الرفع) ثم المكتبات الست عشرة بتحقق SHA-256 وتثبيت ذري.
//! ملاحظة معمارية: مكتبات ONNX Runtime مربوطة ربطاً ثابتاً داخل التنفيذي —
//! مزوّد CUDA مضمّن فيه ويحمّل ملفات NVIDIA هذه ديناميكياً (LoadLibrary)،
//! لذلك لا حاجة لملف `onnxruntime_providers_cuda.dll` منفصل في هذا البناء.

use std::path::{Path, PathBuf};

/// ملفات تشغيل CUDA العشرة (الشرط 1 — كاملة فعلاً هذه المرة):
/// NVIDIA (CUDA 12.x / cuDNN 9.x) + جسر مزود ORT 1.22.
/// الدرس المؤلم: مزود CUDA في ORT يُحمّل ديناميكياً عبر الجسر ويحتاج
/// `cufft64_11.dll` (كان ناقصاً — أول تبعية مفقودة أبلغ عنها المحمل) ثم
/// مكتبتي الجسر نفسيهما `onnxruntime_providers_{shared,cuda}.dll` بالنسخة
/// المطابقة تماماً لبناء ORT المضمّن (1.22.0) — بدونهما يسقط التسجيل بصمت.
pub const CUDA_FILES: &[&str] = &[
    // NVIDIA: cudart + cublas(+Lt) + cuFFT + cuDNN كاملة (كل الأجزاء العشرة:
    // أي نقص — كما حدث مع cudnn_graph — قد يسقط التهيئة بانهيار أصلي لا
    // بـpanic، فالاكتمال هنا مسألة استقرار لا ترف).
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

/// مجلد التثبيت: `<مجلد التنفيذي>\bin` (بجوار ffmpeg/ffprobe).
fn bin_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().map(|p| p.join("bin")).unwrap_or_default()
}

/// كل الملفات موجودة في مجلد معين → جلسة CUDA تستطيع تحميلها.
pub(crate) fn dir_has_runtime(dir: &Path) -> bool {
    CUDA_FILES.iter().all(|f| dir.join(f).is_file())
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

/// الملفات العشرة موجودة → جلسة CUDA تستطيع تحميلها.
pub fn is_available() -> bool {
    dir_has_runtime(&bin_dir())
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
}

/// هل يوجد كرت NVIDIA أصلاً؟ (`nvcuda.dll` يأتي مع تعريف الكرت)
pub fn nvidia_gpu_present() -> bool {
    #[cfg(target_os = "windows")]
    {
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        Path::new(&format!("{sysroot}\\System32\\nvcuda.dll")).exists()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
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
