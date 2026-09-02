//! Sprint C1 — first-run self-repair wizard.
//!
//! The NSIS installer ships every component (bin/ + models/), but antivirus
//! or the user may delete them, and portable runs start with nothing. On
//! startup the GUI runs `health_check_cmd`; any missing component can be
//! repaired from the `assets-v1` GitHub release with SHA-256 verification —
//! the same download-then-verify-then-rename pattern used by yt_dlp.rs.

use std::path::PathBuf;

use serde::Serialize;

pub const ASSET_BASE: &str = "https://github.com/SMSMy/HaramLite/releases/download/assets-v1";

const USER_AGENT: &str = "HaramLite-Repair/0.2";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Component {
    /// stable key used by the frontend / repair command
    pub key: &'static str,
    /// release asset file name
    pub asset: &'static str,
    /// expected SHA-256 (hex, lowercase)
    pub sha256: &'static str,
    /// install subdirectory relative to the executable (bin | models)
    pub subdir: &'static str,
    /// Arabic label for the UI
    pub label: &'static str,
}

pub const COMPONENTS: &[Component] = &[
    Component {
        key: "ffmpeg",
        asset: "ffmpeg.exe",
        sha256: "09948d4cdd0650da6ff5a87577469f2a218dc2615ae379f8f734d24c49de0f73",
        subdir: "bin",
        label: "FFmpeg (معالجة الوسائط)",
    },
    Component {
        key: "ffprobe",
        asset: "ffprobe.exe",
        sha256: "a6618e99bb58869ded3c6f37b53aa1a8d701c3591dbb7b5b317d47369c112be2",
        subdir: "bin",
        label: "ffprobe (فحص الملفات)",
    },
    Component {
        key: "yt-dlp",
        asset: "yt-dlp.exe",
        sha256: "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a",
        subdir: "bin",
        label: "yt-dlp (التنزيل من الروابط)",
    },
    Component {
        key: "model",
        asset: "UVR-MDX-NET-Voc_FT.onnx",
        sha256: "534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111",
        subdir: "models",
        label: "نموذج الفصل UVR-MDX-NET-Voc_FT",
    },
];

#[derive(Debug, Serialize)]
pub struct HealthRow {
    pub key: String,
    pub label: String,
    pub ok: bool,
    pub path: Option<String>,
}

fn component_path(c: &Component) -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let base = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    base.join(c.subdir).join(c.asset)
}

fn is_ok(c: &Component) -> bool {
    match c.key {
        "model" => crate::separator::resolve_model_pub().is_ok(),
        _ => crate::media::resolve_tool(c.key).is_ok(),
    }
}

/// Full health list for the GUI setup wizard (includes yt-dlp, unlike the
/// CLI `--check` which only reports ffmpeg/ffprobe/model).
pub fn health_rows() -> Vec<HealthRow> {
    COMPONENTS
        .iter()
        .map(|c| {
            let ok = is_ok(c);
            let path = if ok {
                match c.key {
                    "model" => crate::separator::resolve_model_pub().ok().map(|p| p.display().to_string()),
                    _ => crate::media::resolve_tool(c.key).ok().map(|p| p.display().to_string()),
                }
            } else {
                None
            };
            HealthRow {
                key: c.key.to_string(),
                label: c.label.to_string(),
                ok,
                path,
            }
        })
        .collect()
}

/// Download one component from the assets-v1 release and verify its SHA-256
/// BEFORE promoting it into place (atomic rename on the same volume).
pub fn repair(
    key: &str,
    progress: &dyn Fn(f32),
) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let c = COMPONENTS
        .iter()
        .find(|c| c.key == key)
        .ok_or_else(|| format!("مكوّن غير معروف: {key}"))?;

    let dest = component_path(c);
    let parent = dest.parent().ok_or_else(|| "مسار غير صالح".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("تعذر إنشاء المجلد {}: {e}", parent.display()))?;

    let url = format!("{ASSET_BASE}/{}", c.asset);
    tracing::info!(target: "repair", "repairing {} ← {url}", c.key);

    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(60))
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("فشل الاتصال: {e}"))?;

    let total = resp
        .header("Content-Length")
        .and_then(|h| h.parse::<u64>().ok())
        .unwrap_or(0);

    let tmp = dest.with_extension("download");
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let mut hasher = Sha256::new();
    let mut reader = resp.into_reader();
    let mut gotten: u64 = 0;
    let mut chunk = [0u8; 256 * 1024];
    loop {
        let read = std::io::Read::read(&mut reader, &mut chunk).map_err(|e| format!("انقطع التنزيل: {e}"))?;
        if read == 0 { break; }
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
    if actual != c.sha256 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "بصمة التنزيل لا تطابق المتوقع لـ {} — أُلغي التثبيت حمايةً لك",
            c.asset
        ));
    }

    std::fs::rename(&tmp, &dest).map_err(|e| format!("تعذر التثبيت في {}: {e}", dest.display()))?;
    tracing::info!(target: "repair", "{} repaired ✓", c.key);
    progress(1.0);
    Ok(dest)
}
