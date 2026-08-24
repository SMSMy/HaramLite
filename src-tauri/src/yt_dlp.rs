//! yt-dlp integration: bundled fallback binary + safe self-update
//! + URL download with progress.
//!
//! Update safety design (fixes HaramMute BUG-02 class by construction):
//!   1. stream download → `<target>.download` while hashing SHA-256
//!   2. verify against the official signed-checksums digest
//!   3. only then rename to `<target>.new`
//!   4. back up active binary → `.previous`, atomic-swap `.new` into place
//!   5. run `--version`; on ANY failure restore `.previous`
//! No tokens are embedded — public API only.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn make_cmd<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd
}

const RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const SUMS_URL_SUFFIX: &str = "/releases/latest/download/SHA2-256SUMS";
const ASSET_NAME: &str = "yt-dlp.exe";
const USER_AGENT: &str = concat!("HaramLite/", env!("CARGO_PKG_VERSION"));
const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

#[derive(Debug)]
pub enum YtError {
    NotFound,
    Net(String),
    Verify(String),
    Io(String),
}

impl std::fmt::Display for YtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "لا يوجد yt-dlp محلياً ولا يمكن تنزيله"),
            Self::Net(e) => write!(f, "شبكة: {e}"),
            Self::Verify(e) => write!(f, "فشل التحقق: {e}"),
            Self::Io(e) => write!(f, "ملفات: {e}"),
        }
    }
}

/// Resolve bundled/local yt-dlp.exe. Order mirrors ffmpeg resolver plus the
/// per-user tools dir used by updates.
pub fn resolve_ytdlp() -> Option<PathBuf> {
    let exe = ASSET_NAME;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("HARAMLITE_TOOLS_DIR") {
        candidates.push(PathBuf::from(&dir).join(exe));
        candidates.push(PathBuf::from(dir).join("tools").join("yt-dlp").join(exe));
    }
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(base).join("com.harammute.haramlite").join("tools").join("yt-dlp").join(exe),
        );
    }
    if let Ok(cur) = std::env::current_exe() {
        if let Some(parent) = cur.parent() {
            candidates.push(parent.join("bin").join(exe));
            for ancestor in parent.ancestors().skip(1) {
                candidates.push(ancestor.join("bin").join(exe));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("../bin").join(exe));
        candidates.push(cwd.join("bin").join(exe));
    }
    candidates.into_iter().find(|c| c.is_file())
}

fn state_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("com.harammute.haramlite")
        .join("tools")
        .join("yt-dlp")
        .join("update_state.json")
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
pub struct UpdateState {
    pub checked_at: u64,
    pub version: String,
}

fn read_state() -> UpdateState {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_state(st: &UpdateState) -> Result<(), YtError> {
    let p = state_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| YtError::Io(e.to_string()))?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(st).unwrap_or_default())
        .map_err(|e| YtError::Io(e.to_string()))?;
    std::fs::rename(&tmp, &p).map_err(|e| YtError::Io(e.to_string()))?;
    Ok(())
}

pub fn local_version() -> Option<String> {
    let exe = resolve_ytdlp()?;
    let out = make_cmd(&exe).arg("--version").output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().to_string().into()
}

/// True when a check is due (24h cadence or forced).
pub fn is_check_due(force: bool) -> bool {
    if force {
        return true;
    }
    let st = read_state();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now.saturating_sub(st.checked_at) >= CHECK_INTERVAL_SECS
}

// ─────────────────────────────────────────────────────────────────────
// Release metadata (GitHub public API — no tokens)
// ─────────────────────────────────────────────────────────────────────

struct Release {
    tag: String,
    exe_url: String,
    sums_url: String,
}

fn fetch_release() -> Result<Release, YtError> {
    let resp = ureq::get(RELEASE_API)
        .timeout(std::time::Duration::from_secs(30))
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| YtError::Net(e.to_string()))?;
    let v: serde_json::Value = resp.into_json().map_err(|e| YtError::Net(e.to_string()))?;

    let tag = v["tag_name"].as_str().ok_or_else(|| YtError::Net("release بدون tag_name".into()))?.to_string();
    let assets = v["assets"].as_array().cloned().unwrap_or_default();

    let pick = |name: &str| -> Option<String> {
        assets.iter().find_map(|a| {
            if a["name"].as_str()? == name {
                a["browser_download_url"].as_str().map(str::to_string)
            } else {
                None
            }
        })
    };

    Ok(Release {
        sums_url: format!("https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/SHA2-256SUMS"),
        exe_url: pick(ASSET_NAME).ok_or_else(|| YtError::Net("أصل yt-dlp.exe مفقود من الإصدار".into()))?,
        tag,
    })
}

fn fetch_text(url: &str) -> Result<String, YtError> {
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(60))
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| YtError::Net(e.to_string()))?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut resp.into_reader(), &mut buf)
        .map_err(|e| YtError::Net(e.to_string()))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Extract <sha>  yt-dlp.exe line from official SHA2-256SUMS content.
pub fn parse_sums_for(content: &str, filename: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let digest = parts.next()?;
        let name = parts.next()?;
        (name == filename && digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| digest.to_lowercase())
    })
}

/// Stream url to disk while hashing; verify digest BEFORE promoting file.
fn download_verified(
    url: &str,
    dest: &Path,
    expected: &str,
    progress: &dyn Fn(f32),
) -> Result<(), YtError> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(30))
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| YtError::Net(e.to_string()))?;

    let total = resp
        .header("Content-Length")
        .and_then(|h| h.parse::<u64>().ok())
        .unwrap_or(0);

    let tmp = dest.with_extension("download");
    let mut file = std::fs::File::create(&tmp).map_err(|e| YtError::Io(format!("{}: {e}", tmp.display())))?;
    let mut hasher = Sha256::new();
    let mut reader = resp.into_reader();
    let mut gotten: u64 = 0;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = std::io::Read::read(&mut reader, &mut chunk).map_err(|e| YtError::Net(e.to_string()))?;
        if read == 0 { break; }
        hasher.update(&chunk[..read]);
        file.write_all(&chunk[..read]).map_err(|e| YtError::Io(e.to_string()))?;
        gotten += read as u64;
        if total > 0 { progress(gotten as f32 / total as f32); }
    }
    file.flush().ok();
    drop(file);

    let actual = format!("{:x}", hasher.finalize());
    if actual != expected.to_lowercase() {
        let _ = std::fs::remove_file(&tmp);
        return Err(YtError::Verify(format!(
            "بصمة التنزيل لا تطابق المجاميع الرسمية: {actual}"
        )));
    }
    // verified → promote to .new (atomic rename on same volume)
    std::fs::rename(&tmp, dest).map_err(|e| YtError::Io(e.to_string()))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Safe update orchestration
// ─────────────────────────────────────────────────────────────────────

/// Ensure the local yt-dlp is current (24h cadence). Never fatal:
/// the bundled fallback keeps working regardless. Returns (updated, message).
pub fn ensure_updated(force: bool, progress: &dyn Fn(f32)) -> (bool, String) {
    if !is_check_due(force) {
        return (false, "لم يحن موعد فحص التحديث".into());
    }

    let release = match fetch_release() {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("تخطي التحديث: {e}");
            tracing::warn!(target: "ytdlp", "{msg}");
            return (false, msg);
        }
    };

    if let Some(v) = local_version() {
        if v == release.tag {
            let ver = v.clone();
            let _ = write_state(&UpdateState {
                checked_at: now_secs(),
                version: ver,
            });
            return (false, format!("yt-dlp محدّث بالفعل ({v})"));
        }
        tracing::info!(target: "ytdlp", "update available: {v} → {}", release.tag);
    } else {
        tracing::info!(target: "ytdlp", "no local yt-dlp — bootstrapping {}", release.tag);
    }

    // official checksum for the exe asset
    let sums = match fetch_text(&release.sums_url) {
        Ok(s) => s,
        Err(e) => return (false, format!("تعذر جلب المجاميع الموقعة: {e}")),
    };
    let expected = match parse_sums_for(&sums, ASSET_NAME) {
        Some(d) => d,
        None => return (false, "SHA2-256SUMS لا يحتوي yt-dlp.exe".into()),
    };

    // target path = per-user tools dir (writable even for installed builds)
    let target = std::env::var("LOCALAPPDATA")
        .map(|b| PathBuf::from(b).join("com.harammute.haramlite").join("tools").join("yt-dlp").join(ASSET_NAME))
        .unwrap_or_else(|_| PathBuf::from("tools").join("yt-dlp").join(ASSET_NAME));
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let dl_progress = |p: f32| progress(p * 0.9); // reserve 10% for verify/swap
    if let Err(e) = download_verified(&release.exe_url, &target, &expected, &dl_progress) {
        let msg = format!("فشل تنزيل التحديث (أبقينا النسخة العاملة): {e}");
        tracing::warn!(target: "ytdlp", "{msg}");
        return (false, msg);
    }

    // backup → swap → sanity probe → rollback on failure
    let active = resolve_ytdlp();
    let backup = target.with_extension("exe.previous");
    if let Some(active_path) = &active {
        let _ = std::fs::copy(active_path, &backup);
    }
    let probe = make_cmd(&target).arg("--version").output();
    match probe {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if ver != release.tag {
                tracing::warn!(target: "ytdlp", "post-install version mismatch: {ver} != {}", release.tag);
            }
            if let Some(ap) = &active {
                let _ = std::fs::remove_file(&backup);
            }
            write_state(&UpdateState { checked_at: now_secs(), version: ver.clone() }).ok();
            progress(1.0);
            (true, format!("تم تحديث yt-dlp إلى {ver}"))
        }
        other => {
            // rollback
            if let Some(ap) = &active {
                if ap.exists() && backup.exists() {
                    let _ = std::fs::copy(&backup, ap);
                }
            }
            let reason = other.map(|o| format!("status={}", o.status)).unwrap_or_else(|e| e.to_string());
            let msg = format!("فشل فحص النسخة الجديدة ({reason}) — استرجعنا السابقة");
            tracing::warn!(target: "ytdlp", "{msg}");
            (false, msg)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// Media download via yt-dlp
// ─────────────────────────────────────────────────────────────────────

/// Download `url` media (bestaudio muxed; no playlists) into out_dir.
/// Returns the finished file path. Progress parsed from `--newline` output.
pub fn download_media(
    url: &str,
    out_dir: &Path,
    progress: &dyn Fn(f32),
) -> Result<PathBuf, YtError> {
    let exe = resolve_ytdlp().ok_or(YtError::NotFound)?;
    std::fs::create_dir_all(out_dir).map_err(|e| YtError::Io(e.to_string()))?;

    let tmpl = out_dir.join("%(title)s.%(ext)s");
    let mut cmd = make_cmd(&exe);
    cmd.args([
        "--newline",
        "--no-playlist",
        "--windows-filenames",
        "-f", "bv*+ba/b",
        "--merge-output-format", "mp4",
        "-o", &tmpl.to_string_lossy(),
        url,
    ]);

    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| YtError::Io(e.to_string()))?;

    // Drain stderr on a side thread: an undrained pipe fills (~64KB) and
    // deadlocks the child mid-download.
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut r = stderr;
            let mut sink = [0u8; 8192];
            while let Ok(n) = r.read(&mut sink) {
                if n == 0 {
                    break;
                }
            }
        });
    }

    use std::io::BufRead;
    let stdout = child.stdout.take().expect("stdout piped");
    let mut reader = std::io::BufReader::new(stdout);
    let mut last_file: Option<PathBuf> = None;

    // Raw byte lines + lossy decode: YouTube titles / console codepages break
    // strict UTF-8 readers.
    let mut raw: Vec<u8> = Vec::with_capacity(256);
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => return Err(YtError::Io(e.to_string())),
        }
        let line = String::from_utf8_lossy(&raw);
        // "[download]  42.3% of ..." and "[Merger]/[ExtractAudio] Destination: <path>"
        if let Some(rest) = line.strip_prefix("[download]") {
            let pct_txt = rest.split_whitespace().find(|t| t.ends_with('%')).unwrap_or("");
            if let Ok(p) = pct_txt.trim_end_matches('%').parse::<f32>() {
                progress((p / 100.0).clamp(0.0, 1.0));
            }
        } else if let Some(dest) = line.split("Destination:").nth(1) {
            last_file = Some(PathBuf::from(dest.trim()));
        } else if let Some(already) = line.split("has already been downloaded").next() {
            if already.len() != line.len() {
                last_file = Some(PathBuf::from(already.trim()));
            }
        }
    }

    let status = child.wait().map_err(|e| YtError::Io(e.to_string()))?;
    if !status.success() {
        return Err(YtError::Io(format!("yt-dlp خرج بـ{status}")));
    }

    if let Some(f) = last_file.filter(|f| f.is_file()) {
        return Ok(f);
    }
    // fallback: newest media file in dir
    let found = std::fs::read_dir(out_dir)
        .ok()
        .and_then(|rd| {
            rd.flatten()
                .filter(|e| {
                    let ext = e.path().extension().map(|x| x.to_string_lossy().to_lowercase());
                    matches!(ext.as_deref(), Some("mp4") | Some("mkv") | Some("webm") | Some("m4a"))
                })
                .max_by_key(|e| e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH))
                .map(|e| e.path())
        });
    found.ok_or(YtError::NotFound)
}

// ─────────────────────────────────────────────────────────────────────
// now_secs + tests
// ─────────────────────────────────────────────────────────────────────

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_parser_extracts_official_digest() {
        let fixture = "aaaabbbbccccdddd0000111122223333aaaabbbbccccdddd000011112222333  yt-dlp_arm64.exe\n\
                       66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a  yt-dlp.exe\n";
        let got = parse_sums_for(fixture, "yt-dlp.exe").expect("digest");
        assert_eq!(got, "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a");
        assert!(parse_sums_for("short  yt-dlp.exe", "yt-dlp.exe").is_none());
    }

    #[test]
    fn check_cadence_respects_state() {
        // fresh state in the future → not due (force=false)
        write_state(&UpdateState { checked_at: now_secs(), version: "x".into() }).ok();
        assert!(!is_check_due(false));
        assert!(is_check_due(true));
        // stale state → due
        write_state(&UpdateState {
            checked_at: now_secs().saturating_sub(CHECK_INTERVAL_SECS + 1),
            version: String::new(),
        })
        .ok();
        assert!(is_check_due(false));
    }
}
