//! Sprint C1 — first-run self-repair wizard.
//!
//! The NSIS installer ships every component (bin/ + models/), but antivirus
//! or the user may delete them, and portable runs start with nothing. On
//! startup the GUI runs `health_check_cmd`; any missing component can be
//! repaired from the `assets-v1` GitHub release with SHA-256 verification —
//! the same download-then-verify-then-rename pattern used by yt_dlp.rs.

use std::path::{Path, PathBuf};

use serde::Serialize;

pub const ASSET_BASE: &str = "https://github.com/SMSMy/HaramLite/releases/download/assets-v1";

const USER_AGENT: &str = "HaramLite-Repair/0.2";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Component {
    /// stable key used by the frontend / repair command
    pub key: &'static str,
    /// release asset file name on the `assets-v1` release. It may differ from
    /// `local` on purpose: the asset name records the license variant
    /// (`ffmpeg-lgpl.exe`) and the old GPL assets keep their own names, so a
    /// published 0.2.4 client still verifies the bytes its embedded hash expects.
    pub asset: &'static str,
    /// name the file is INSTALLED under, i.e. what `media::resolve_tool` looks
    /// for inside `bin/`. Renaming this breaks repair silently: the download
    /// succeeds, the hash matches, and nothing ever finds the file.
    pub local: &'static str,
    /// Expected SHA-256 (hex, lowercase) — **و-٣: مرساة الثقة المثبَّتة في
    /// التنفيذي.**
    ///
    /// This constant is the ONLY integrity source for the `assets-v1` channel:
    /// the value is compiled in, never read from the release, never from an
    /// HTTP header, never from a sibling file the same host serves. A version
    /// of the release whose bytes differ from this digest is refused by name
    /// (`download_and_verify`) however legitimate its manifest or URL looks.
    ///
    /// Bound that remains (stated in the threat model §٥/و-٣): a hash pins the
    /// BYTES, not the AUTHOR. Authenticode signing — the real fix — is deferred
    /// by the owner (no certificate), and the self-updater is active: false; so
    /// the chain still rests on "the GitHub account and the CI were not
    /// compromised". Changing these digests is a release decision, not a
    /// refactor.
    pub sha256: &'static str,
    /// install subdirectory relative to the executable (bin | models)
    pub subdir: &'static str,
    /// Arabic label for the UI
    pub label: &'static str,
}

pub const COMPONENTS: &[Component] = &[
    Component {
        key: "ffmpeg",
        asset: "ffmpeg-lgpl.exe",
        local: "ffmpeg.exe",
        sha256: "799b9ee9484f1cb7eeee997099afc8ab8cda7a2a9bd52615d5ddf3770561dd4b",
        subdir: "bin",
        label: "FFmpeg (معالجة الوسائط)",
    },
    Component {
        key: "ffprobe",
        asset: "ffprobe-lgpl.exe",
        local: "ffprobe.exe",
        sha256: "01af86fa4b71fd53c11862ecbc7089519cdf9fe7403b821ceee860f415b94dab",
        subdir: "bin",
        label: "ffprobe (فحص الملفات)",
    },
    Component {
        key: "yt-dlp",
        asset: "yt-dlp.exe",
        local: "yt-dlp.exe",
        sha256: "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a",
        subdir: "bin",
        label: "yt-dlp (التنزيل من الروابط)",
    },
    Component {
        key: "model",
        asset: "UVR-MDX-NET-Voc_FT.onnx",
        local: "UVR-MDX-NET-Voc_FT.onnx",
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
    base.join(c.subdir).join(c.local)
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
                    "model" => crate::separator::resolve_model_pub()
                        .ok()
                        .map(|p| p.display().to_string()),
                    _ => crate::media::resolve_tool(c.key)
                        .ok()
                        .map(|p| p.display().to_string()),
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

/// Download one component from the `assets-v1` release and verify its SHA-256
/// BEFORE promoting it into place (atomic rename on the same volume).
///
/// و-٣: the digest compared here is `c.sha256` — a **compile-time constant**
/// (`COMPONENTS`). Nothing in the HTTP response feeds the comparison: no
/// manifest field, no header, no sibling checksum file on the same host. That
/// is the whole trust anchor for this channel today.
pub fn repair(key: &str, progress: &dyn Fn(f32)) -> Result<PathBuf, String> {
    let c = COMPONENTS
        .iter()
        .find(|c| c.key == key)
        .ok_or_else(|| format!("مكوّن غير معروف: {key}"))?;

    let dest = component_path(c);
    let parent = dest.parent().ok_or_else(|| "مسار غير صالح".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("تعذر إنشاء المجلد {}: {e}", parent.display()))?;

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

    download_and_verify(resp.into_reader(), &dest, total, c.sha256, progress)?;
    tracing::info!(target: "repair", "{} repaired ✓", c.key);
    progress(1.0);
    Ok(dest)
}

/// Stream the response body into `<dest>.download` (hashing as it goes), verify
/// it, then promote it with one rename.
///
/// Audit 2026-09-15 (٤.ب.٦): the partial file is owned by a drop guard, so a
/// dropped connection or a write error removes it too — only the hash mismatch
/// used to clean up, and every other exit left `<name>.download` on the disk.
fn download_and_verify(
    mut reader: impl std::io::Read,
    dest: &Path,
    total: u64,
    expect_sha256: &str,
    progress: &dyn Fn(f32),
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let tmp = dest.with_extension("download");
    let _scratch = crate::scratch::ScratchGuard::new(&tmp);
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let mut hasher = Sha256::new();
    let mut gotten: u64 = 0;
    let mut chunk = [0u8; 256 * 1024];
    loop {
        let read = std::io::Read::read(&mut reader, &mut chunk)
            .map_err(|e| format!("انقطع التنزيل: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
        file.write_all(&chunk[..read])
            .map_err(|e| format!("فشل الكتابة: {e}"))?;
        gotten += read as u64;
        if total > 0 {
            progress((gotten as f32 / total as f32).clamp(0.0, 1.0));
        }
    }
    file.flush().ok();
    drop(file);

    let actual = format!("{:x}", hasher.finalize());
    if actual != expect_sha256 {
        return Err(format!(
            "بصمة التنزيل لا تطابق المتوقع لـ {} — أُلغي التثبيت حمايةً لك",
            dest.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("تعذر التثبيت في {}: {e}", dest.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Negative test for the `asset` ≠ `local` split (2026-09-15, ب.٤.أ): the
    /// release asset is named after its license (`ffmpeg-lgpl.exe`) while the app
    /// resolves `bin/ffmpeg.exe` (`media::resolve_tool`). If `local` ever follows
    /// `asset`, repair downloads, verifies and installs a file that nothing looks
    /// for — a silent failure that reports success. Break `local` and this fails.
    #[test]
    fn every_binary_component_installs_under_the_name_the_app_resolves() {
        for c in COMPONENTS.iter().filter(|c| c.key != "model") {
            let expected = if cfg!(windows) {
                format!("{}.exe", c.key)
            } else {
                c.key.to_string()
            };
            assert_eq!(
                c.local,
                expected.as_str(),
                "component `{}` would install as `{}` but the app resolves `{}`",
                c.key,
                c.local,
                expected
            );
        }
        let ffmpeg = COMPONENTS
            .iter()
            .find(|c| c.key == "ffmpeg")
            .expect("ffmpeg component");
        assert_ne!(
            ffmpeg.asset, ffmpeg.local,
            "the LGPL asset name must differ from the installed name: assets-v1 keeps the 0.2.4 GPL names untouched so published clients still verify"
        );
        assert!(
            ffmpeg.asset.contains("lgpl"),
            "the asset name must state the license variant: {}",
            ffmpeg.asset
        );
    }

    /// A transfer that yields a little data and then fails — the shape of a
    /// dropped connection, i.e. the exit path that used to leave the partial
    /// `<name>.download` behind (٤.ب.٦).
    struct BrokenReader(u8);

    impl std::io::Read for BrokenReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0 == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionReset,
                    "انقطع",
                ));
            }
            self.0 -= 1;
            let n = buf.len().min(8);
            buf[..n].fill(b'x');
            Ok(n)
        }
    }

    /// Negative test for ٤.ب.٦: a failed transfer must leave NO `.download`
    /// file. Before the guard, only the hash-mismatch branch removed it.
    #[test]
    fn a_broken_download_leaves_no_partial_file_behind() {
        let dir = std::env::temp_dir().join(format!("hl_repair_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("ffmpeg.exe");
        let tmp = dest.with_extension("download");
        let progress = |_p: f32| {};

        let broken = download_and_verify(BrokenReader(2), &dest, 0, "deadbeef", &progress);
        let err = broken.expect_err("a broken transfer must fail");
        assert!(
            err.contains("انقطع التنزيل"),
            "the transfer error must surface: {err}"
        );
        assert!(!tmp.exists(), "the partial download must be gone (٤.ب.٦)");
        assert!(!dest.exists(), "and nothing may be promoted");

        // Short-but-complete transfer ⇒ hash mismatch ⇒ same cleanup.
        let body = std::io::Cursor::new(b"wrong bytes".to_vec());
        assert!(download_and_verify(body, &dest, 0, "deadbeef", &progress).is_err());
        assert!(
            !tmp.exists(),
            "a hash mismatch must not leave the file either"
        );

        // …and the verified path still promotes the file with one rename.
        use sha2::{Digest, Sha256};
        let payload = b"a component".to_vec();
        let sha = format!("{:x}", Sha256::digest(&payload));
        let promoted = download_and_verify(
            std::io::Cursor::new(payload.clone()),
            &dest,
            0,
            &sha,
            &progress,
        );
        assert!(
            promoted.is_ok(),
            "a verified transfer must install: {promoted:?}"
        );
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        assert!(
            !tmp.exists(),
            "the temporary name must not survive the rename"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// و-٣ سلبي: تعبئة البصمة **المثبَّتة** ⇒ فشل يسمّي الملف، ولا يُرقّى شيء.
    ///
    /// هذا هو الاختبار الذي يقابل «بصمة مُعبَّثة ⇒ فشل يسمّي الملف» في تقرير
    /// الفجوة. وهو يثبت أيضاً أن المرجع ثابت في الكود: الدالة تقارن بالوسيط
    /// القادم من `COMPONENTS`، ولو صار المصدر ملفاً/مانيفست تنزيل لما استطاع
    /// اختبار بلا شبكة أن يجعلها تفشل بهذه الدقّة.
    #[test]
    fn one_tampered_pinned_hash_fails_and_names_the_file() {
        let dir = std::env::temp_dir().join(format!("hl_repair_pin_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let progress = |_p: f32| {};

        let ytdlp = COMPONENTS
            .iter()
            .find(|c| c.key == "yt-dlp")
            .expect("yt-dlp component");
        let dest = dir.join(ytdlp.local);

        // البصمة المثبَّتة معبَّثة ببايت واحد ⇒ الفشل، والرسالة تسمّي الملف.
        let tampered = {
            let mut v = ytdlp.sha256.to_string().into_bytes();
            v[0] = if v[0] == b'a' { b'b' } else { b'a' };
            String::from_utf8(v).unwrap()
        };
        assert_ne!(tampered, ytdlp.sha256);
        let payload = b"the bytes a hostile release would serve".to_vec();
        let err = download_and_verify(
            std::io::Cursor::new(payload.clone()),
            &dest,
            0,
            &tampered,
            &progress,
        )
        .expect_err("بصمة مُعبَّثة يجب أن تفشل");
        assert!(
            err.contains(ytdlp.local),
            "رسالة الفشل يجب أن تسمّي الملف «{}»: {err}",
            ytdlp.local
        );
        assert!(!dest.exists(), "لا يُرقّى ملف ببصمة منحرفة");
        assert!(
            !dest.with_extension("download").exists(),
            "ولا يبقى مؤقت بعد الفشل"
        );

        // وبصمة حقيقية مطابقة ⇒ التثبيت ينجح (سلوك المسار السليم سليم).
        let good = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(&payload))
        };
        download_and_verify(std::io::Cursor::new(payload), &dest, 0, &good, &progress)
            .expect("البصمة المطابقة تُثبّت");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// و-٣: الثوابت المثبَّتة سليمة الشكل ومتمايزة — تكرار بصمة بين مكوّنين
    /// يعني أن أحدهما يحمل بصمة الآخر (وهو خطأ صامت لا يكشفه أي فشل تنزيل).
    #[test]
    fn pinned_component_hashes_are_well_formed_and_distinct() {
        assert_eq!(COMPONENTS.len(), 4);
        for c in COMPONENTS {
            assert_eq!(c.sha256.len(), 64, "بصمة {} ليست 64 محرفاً", c.key);
            assert!(
                c.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
                "بصمة {} ليست hex",
                c.key
            );
            assert_eq!(
                c.sha256,
                c.sha256.to_ascii_lowercase(),
                "بصمة {} يجب أن تكون صغيرة",
                c.key
            );
        }
        for (i, a) in COMPONENTS.iter().enumerate() {
            for b in COMPONENTS.iter().skip(i + 1) {
                assert_ne!(a.sha256, b.sha256, "بصمة مكرَّرة بين {} و{}", a.key, b.key);
            }
        }
    }
}
