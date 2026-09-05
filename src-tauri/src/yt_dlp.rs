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

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn make_cmd<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd
}

const RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
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
    // Audit 2026-09-03: overridable so unit tests never touch (or leave
    // stale) the user's real update state.
    if let Ok(dir) = std::env::var("HARAMLITE_YTDLP_STATE_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir).join("update_state.json");
        }
    }
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("com.harammute.haramlite")
        .join("tools")
        .join("yt-dlp")
        .join("update_state.json")
}

/// Last `n` captured stdout lines, oldest first — attached to download
/// failures so the #1 recurring user error is diagnosable (audit 2026-09-03).
fn tail_text(tail: &VecDeque<String>, n: usize) -> String {
    tail.iter()
        .skip(tail.len().saturating_sub(n))
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
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

    let new_path = target.with_extension("new");
    let dl_progress = |p: f32| progress(p * 0.9); // reserve 10% for verify/swap
    if let Err(e) = download_verified(&release.exe_url, &new_path, &expected, &dl_progress) {
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
    
    if let Err(e) = std::fs::rename(&new_path, &target) {
        let msg = format!("فشل تبديل الملف الجديد: {e}");
        tracing::warn!(target: "ytdlp", "{msg}");
        return (false, msg);
    }
    let probe = make_cmd(&target).arg("--version").output();
    match probe {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if ver != release.tag {
                tracing::warn!(target: "ytdlp", "post-install version mismatch: {ver} != {}", release.tag);
            }
            if let Some(_ap) = &active {
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
/// The progress closure returns false to abort; `cancel` is polled by a
/// monitor thread so cancellation also works while yt-dlp is MERGING
/// (no progress lines during that phase).
pub fn download_media(
    url: &str,
    out_dir: &Path,
    progress: &dyn Fn(f32) -> bool,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<PathBuf, YtError> {
    download_media_inner(url, out_dir, progress, cancel)
}

/// How long a download may go without a single stdout line before it is
/// declared stalled, killed and failed (functional gap: stall watchdog).
const STALL_SECS: u64 = 15 * 60;

/// Video metadata needed before any byte moves: a safe deterministic slot
/// plus a pretty display name.
struct VideoMeta {
    id: String,
    title: String,
}

/// One metadata-only call. Cheap (~1s) and it decides everything downstream:
/// without a trustworthy id there is no safe slot, so fail here loudly
/// instead of downloading blindly into a name we cannot re-identify.
fn fetch_meta(exe: &Path, url: &str) -> Result<VideoMeta, YtError> {
    let out = make_cmd(exe)
        .args([
            "--no-playlist",
            "--skip-download",
            "--socket-timeout",
            "20",
            "--dump-single-json",
        ])
        .arg(url)
        .env("PYTHONIOENCODING", "utf-8")
        .output()
        .map_err(|e| YtError::Net(e.to_string()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let lines: Vec<&str> = stderr.lines().collect();
        let start = lines.len().saturating_sub(5);
        return Err(YtError::Net(format!(
            "تعذر قراءة بيانات الفيديو: {}",
            lines[start..].join(" | ")
        )));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| YtError::Net(format!("بيانات غير مقروءة: {e}")))?;
    let id = v
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(YtError::Net("تعذر تحديد معرف الفيديو".into()));
    }
    let title = v
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(VideoMeta {
        title: if title.is_empty() { id.clone() } else { title },
        id,
    })
}

/// Our own filename sanitizer, applied ONCE to a name WE then write via
/// rename — by construction the computed name always equals the disk name.
/// This ends the whole class where yt-dlp PRINTS `Just A Dream` but SAVES
/// `＂Just A Dream＂` (U+FF02 one-way sanitizing on Windows): we never read
/// yt-dlp's mind again, we only match our deterministic `hl_<id>_*` slot.
pub fn sanitize_title(title: &str, fallback_id: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    // Windows forbids trailing dots/spaces (also after truncation below).
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    let s = s.trim().to_string();
    // Leave headroom for collision suffix + extension.
    let mut s: String = s.chars().take(180).collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() {
        format!("video_{fallback_id}")
    } else {
        s
    }
}

/// Unique-per-attempt slot stem. The id part keeps every attempt of one video
/// findable; the suffix keeps concurrent attempts from sharing one file
/// (same URL from bridge + GUI at once degrades to redundant work, never to
/// a corrupted shared file or an overwrite of user data).
fn slot_stem(video_id: &str) -> String {
    static ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("hl_{video_id}_{}_{n}", std::process::id())
}

/// Our slot files for this video (any attempt suffix), newest first.
/// Skips transient junk (`.part`/`.ytdl`/`.tmp`) — those are never complete.
fn find_slots(out_dir: &Path, video_id: &str) -> Vec<PathBuf> {
    let prefix = format!("hl_{video_id}_");
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(out_dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with(&prefix) || !p.is_file() {
                continue;
            }
            if name.ends_with(".part") || name.ends_with(".ytdl") || name.ends_with(".tmp") {
                continue;
            }
            let m = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            found.push((m, p));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// A pre-existing slot file is only reusable when it is a REAL complete
/// media file: killed mid-merge runs leave corrupt slot files behind, so
/// non-empty plus a valid probe with positive duration is required.
fn slot_usable(p: &Path) -> bool {
    if std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) == 0 {
        return false;
    }
    crate::media::probe(p)
        .map(|info| info.has_audio && info.duration_secs > 0.0)
        .unwrap_or(false)
}

/// Delete our stale slot files and transient junk (crash leftovers).
/// Only `hl_<id>_*` matches — user files are never touched.
fn clear_slots(out_dir: &Path, video_id: &str) {
    let prefix = format!("hl_{video_id}_");
    if let Ok(rd) = std::fs::read_dir(out_dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with(&prefix) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

/// Promote a slot file to its pretty user-facing name (computed by OUR
/// sanitizer, so the rename target is exactly what lands on disk).
/// Collisions resolve with the unique id suffix — never overwrite user data.
/// A redundant twin (same video downloaded twice concurrently) is dropped in
/// favor of the existing file.
fn promote_slot(slot: &Path, out_dir: &Path, meta: &VideoMeta) -> Result<PathBuf, YtError> {
    let ext = slot.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    let stem = sanitize_title(&meta.title, &meta.id);
    let mut dest = out_dir.join(format!("{stem}.{ext}"));
    if dest != slot && dest.is_file() {
        dest = out_dir.join(format!("{stem} [{}].{ext}", meta.id));
    }
    if dest == slot {
        return Ok(dest);
    }
    if dest.is_file() {
        let _ = std::fs::remove_file(slot);
        return Ok(dest);
    }
    std::fs::rename(slot, &dest).map_err(|e| YtError::Io(format!("تعذر التسمية النهائية: {e}")))?;
    Ok(dest)
}

fn download_media_inner(
    url: &str,
    out_dir: &Path,
    progress: &dyn Fn(f32) -> bool,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<PathBuf, YtError> {
    use std::sync::atomic::Ordering;
    let exe = resolve_ytdlp().ok_or(YtError::NotFound)?;
    std::fs::create_dir_all(out_dir).map_err(|e| YtError::Io(e.to_string()))?;

    // 1) metadata first: no id → no safe slot → fail loudly before downloading.
    let meta = fetch_meta(&exe, url)?;

    // 2) fast paths with zero network beyond metadata: a usable slot from an
    // earlier run, or a legacy title-named file from the pre-slot era.
    if let Some(slot) = find_slots(out_dir, &meta.id).into_iter().find(|p| slot_usable(p)) {
        return promote_slot(&slot, out_dir, &meta);
    }
    let legacy = out_dir.join(format!("{}.mp4", sanitize_title(&meta.title, &meta.id)));
    if legacy.is_file() && slot_usable(&legacy) {
        return Ok(legacy);
    }

    // 3) fresh unique slot; stale crash leftovers of ours go first.
    clear_slots(out_dir, &meta.id);
    let stem = slot_stem(&meta.id);
    let tmpl = out_dir.join(format!("{stem}.%(ext)s"));
    let mut cmd = make_cmd(&exe);
    // NOTE: no `--windows-filenames` and no title in `-o` anymore — the slot
    // is id-safe by construction, so yt-dlp's sanitizer has nothing to mangle.
    let args: Vec<String> = vec![
        "--newline".into(),
        "--no-playlist".into(),
        "-f".into(),
        "bv*+ba/b".into(),
        "--merge-output-format".into(),
        "mp4".into(),
        "--socket-timeout".into(),
        "20".into(),
        "-o".into(),
        tmpl.to_string_lossy().into_owned(),
        // forensics only: what yt-dlp THINKS it wrote (unsanitized — feeds
        // the failure tail, never trusted for identification).
        "--print".into(),
        "after_move:HARAMLITE_OUT:%(filepath)s".into(),
        url.to_string(),
    ];
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd.args(&arg_refs);
    // Arabic titles: force yt-dlp's stdout to UTF-8 instead of the Windows
    // console codepage (cp1256 on this machine) — keeps logs exact.
    cmd.env("PYTHONIOENCODING", "utf-8");

    let child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| YtError::Io(e.to_string()))?;

    // Audit: `child.kill()` on Windows only kills yt-dlp.exe itself — the
    // ffmpeg merger child becomes an orphan burning CPU. A monitor thread
    // polls the cancel flag and kills the WHOLE process tree, which also
    // makes cancel responsive during the merge phase (no progress lines).
    //
    // Audit 2026-09-03: the monitor's lifetime is the CHILD's, not the
    // flag's — the old loop exited only on cancel, leaking one sleeper
    // thread per successful download (callers pass process-lifetime flags)
    // and taskkilling a possibly-recycled PID on the NEXT cancel.
    let child_pid = child.id();
    let child = Arc::new(Mutex::new(child));
    // Last stdout line instant — the stall watchdog below kills a download
    // that goes silent for STALL_SECS (no output at all, not even slow
    // progress), so one hung subprocess can never wedge the bridge queue.
    let activity = Arc::new(Mutex::new(std::time::Instant::now()));
    let stalled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        // the monitor holds its OWN Arc — the flag stays alive for as long
        // as the watcher runs, whatever the caller does afterwards
        let cancel_flag = cancel.clone();
        let watched = child.clone();
        let watch_activity = activity.clone();
        let watch_stalled = stalled.clone();
        std::thread::Builder::new()
            .name("ytdlp-cancel-watch".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let alive = watched
                    .lock()
                    .map(|mut c| matches!(c.try_wait(), Ok(None)))
                    .unwrap_or(false);
                if !alive {
                    break; // child reaped/exited — nothing left to watch
                }
                if cancel_flag.load(Ordering::SeqCst) {
                    kill_tree(child_pid);
                    break;
                }
                let idle = watch_activity
                    .lock()
                    .map(|t| t.elapsed().as_secs() >= STALL_SECS)
                    .unwrap_or(false);
                if idle {
                    tracing::warn!(target: "ytdlp", "جمود التنزيل (لا مخرجات منذ {STALL_SECS} ثانية) — قتل العملية");
                    watch_stalled.store(true, Ordering::SeqCst);
                    kill_tree(child_pid);
                    break;
                }
            })
            .ok();
    }

    // Drain stderr on a side thread: an undrained pipe fills (~64KB) and
    // deadlocks the child mid-download.
    let stderr = child.lock().ok().and_then(|mut c| c.stderr.take());
    if let Some(stderr) = stderr {
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
    let stdout = child
        .lock()
        .ok()
        .and_then(|mut c| c.stdout.take())
        .expect("stdout piped");
    let mut reader = std::io::BufReader::new(stdout);

    // Raw byte lines + lossy decode: YouTube titles / console codepages break
    // strict UTF-8 readers.
    let mut raw: Vec<u8> = Vec::with_capacity(256);
    // Retain a tail of stdout so failures carry evidence.
    let mut tail: VecDeque<String> = VecDeque::with_capacity(41);
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => {
                // Never orphan the child (yt-dlp + its ffmpeg merger) —
                // the old code returned here and leaked both burning CPU.
                if let Ok(mut c) = child.lock() {
                    kill_tree(c.id());
                    let _ = c.wait();
                }
                return Err(YtError::Io(e.to_string()));
            }
        }
        let line = String::from_utf8_lossy(&raw);
        let trimmed = line.trim();
        tail.push_back(trimmed.to_string());
        while tail.len() > 40 {
            tail.pop_front();
        }
        // Any output at all resets the stall watchdog.
        if let Ok(mut t) = activity.lock() {
            *t = std::time::Instant::now();
        }
        // Identification no longer reads filenames from stdout AT ALL (the
        // sanitization drift made every printed name untrustworthy) — only
        // percentage progress is parsed here; the slot file below is proof.
        if let Some(rest) = line.strip_prefix("[download]") {
            let pct_txt = rest.split_whitespace().find(|t| t.ends_with('%')).unwrap_or("");
            if let Ok(p) = pct_txt.trim_end_matches('%').parse::<f32>() {
                let p = (p / 100.0).clamp(0.0, 1.0);
                if !progress(p) {
                    if let Ok(mut c) = child.lock() {
                        kill_tree(c.id());
                        let _ = c.wait();
                    }
                    return Err(YtError::Io("أُلغي التنزيل من قبل المستخدم".into()));
                }
            }
        }
    }

    let status = child
        .lock()
        .map_err(|e| YtError::Io(e.to_string()))?
        .wait()
        .map_err(|e| YtError::Io(e.to_string()))?;
    if stalled.load(Ordering::SeqCst) {
        tracing::warn!(target: "ytdlp", "توقف التنزيل لانقطاع التقدم ({url}) — ذيل المخرجات:\n{}", tail_text(&tail, 30));
        return Err(YtError::Io(format!(
            "توقف التنزيل: لا تقدم منذ {} دقيقة — قد يكون الاتصال متجمداً\n{}",
            STALL_SECS / 60,
            tail_text(&tail, 12)
        )));
    }
    if !status.success() {
        tracing::warn!(target: "ytdlp", "yt-dlp خرج بـ{status} لـ {url} — ذيل المخرجات:\n{}", tail_text(&tail, 30));
        return Err(YtError::Io(format!(
            "yt-dlp خرج بـ{status}\n{}",
            tail_text(&tail, 12)
        )));
    }

    // The slot file is the ONLY proof of success — no printed name, no
    // merger line, no folder guessing. It must exist and be a real media
    // file; anything else is a genuine failure with the tail attached.
    find_slots(out_dir, &meta.id)
        .into_iter()
        .find(|p| slot_usable(p))
        .map(|slot| promote_slot(&slot, out_dir, &meta))
        .unwrap_or_else(|| {
            tracing::warn!(target: "ytdlp", "نجح yt-dlp دون ملف صالح في الخانة ({url}) — ذيل المخرجات:\n{}", tail_text(&tail, 30));
            Err(YtError::Io(format!(
                "yt-dlp نجح دون ملف ناتج صالح — أعد المحاولة\n{}",
                tail_text(&tail, 12)
            )))
        })
}

/// Kill a process and its WHOLE tree (Windows: taskkill /T /F; Unix: kill).
/// Plain `child.kill()` leaves yt-dlp's ffmpeg merger orphaned.
fn kill_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
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
    fn sanitize_title_kills_forbidden_chars() {
        // The reported killer: ASCII quotes must not survive (yt-dlp would
        // save them as U+FF02 on disk while printing them raw).
        assert_eq!(sanitize_title("Just \"A\" Dream", "abc123"), "Just _A_ Dream");
        assert_eq!(sanitize_title("a<b>c:d/e\\f|g?h*i", "x"), "a_b_c_d_e_f_g_h_i");
        // Windows trailing dots/spaces
        assert_eq!(sanitize_title("song...   ", "x"), "song");
        // empty/blank → deterministic fallback
        assert_eq!(sanitize_title("   ", "abc123"), "video_abc123");
        assert_eq!(sanitize_title("", "abc123"), "video_abc123");
        // length cap leaves room for suffix + extension
        let long = "a".repeat(500);
        assert!(sanitize_title(&long, "x").chars().count() <= 180);
    }

    #[test]
    fn slot_stem_is_unique_and_prefixed() {
        let a = slot_stem("dQw4w9WgXcQ");
        let b = slot_stem("dQw4w9WgXcQ");
        assert_ne!(a, b);
        assert!(a.starts_with("hl_dQw4w9WgXcQ_"));
    }

    #[test]
    fn slots_find_newest_and_skip_partials() {
        let dir = std::env::temp_dir().join(format!("hl_ytdlp_slots_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("other.mp4"), b"x").unwrap();
        std::fs::write(dir.join("hl_abc_1_0.mp4.part"), b"partial").unwrap();
        std::fs::write(dir.join("hl_abc_1_0.mp4"), b"old").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("hl_abc_2_1.mp4"), b"new").unwrap();

        let found = find_slots(&dir, "abc");
        assert_eq!(found.len(), 2, "partials and foreign files must be excluded");
        assert!(found[0].ends_with("hl_abc_2_1.mp4"), "newest first");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_cadence_respects_state() {
        // Audit 2026-09-03: isolate from the user's REAL update state.
        let dir = std::env::temp_dir().join(format!("hl_ytdlp_state_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HARAMLITE_YTDLP_STATE_DIR", &dir);

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

        std::env::remove_var("HARAMLITE_YTDLP_STATE_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_text_keeps_last_n_lines() {
        let mut tail: VecDeque<String> = VecDeque::new();
        for i in 0..5 {
            tail.push_back(format!("line{i}"));
        }
        assert_eq!(tail_text(&tail, 2), "line3\nline4");
        assert_eq!(tail_text(&tail, 99).lines().count(), 5);
        assert_eq!(tail_text(&VecDeque::new(), 12), "");
    }
}
