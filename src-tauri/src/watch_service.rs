//! Sprint D2 — watch folder service.
//!
//! Runs entirely in Rust: filesystem events (notify) + a periodic rescan
//! safety net (notify misses events under OneDrive/antivirus/network
//! drives) + the disk guard (max file size + free-space check BEFORE
//! separation — "أداة رأيية بلا حارس تملأ القرص بأدب") + sequential
//! background processing with progress/done/skip events for the UI.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use notify::Watcher;

use crate::pipeline::{self, Mode, OutFormat, OutKind};
use crate::settings::Settings;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static HANDLE: OnceLock<Mutex<Option<WatchHandle>>> = OnceLock::new();

pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

struct WatchHandle {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    fingerprint: String,
}

const MEDIA_EXTS: &[&str] = &[
    "mp4", "mkv", "mov", "avi", "webm", "m4v", "ts", "mp3", "wav", "flac", "m4a", "aac", "ogg",
    "opus", "wma",
];

fn is_media(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| MEDIA_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Never touch our own outputs or obvious temp files.
fn candidate_ok(p: &Path) -> bool {
    if !is_media(p) {
        return false;
    }
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.starts_with('.') || name.starts_with('~') {
        return false;
    }
    if matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("partial") | Some("download") | Some("crdownload") | Some("tmp")
    ) {
        return false;
    }
    !(name.contains("_haramlite")
        || name.contains("_preview")
        || name.contains("(vocals)")
        || name.contains("(instrumental)")
        || name.contains("(clean)"))
}

fn key_of(p: &Path) -> Option<String> {
    let md = std::fs::metadata(p).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(format!("{}|{}|{}", p.display(), md.len(), mtime))
}

fn emit(event: &str, payload: serde_json::Value) {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

fn sys_notify(title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Some(app) = APP.get() {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

#[cfg(target_os = "windows")]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free = 0u64;
    let mut total = 0u64;
    let mut total_free = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            &mut total,
            &mut total_free,
        )
    };
    if ok != 0 {
        Some(free)
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn free_bytes(_dir: &Path) -> Option<u64> {
    None
}

/// Wait until the file size stops changing (copy/download in progress).
fn wait_stable(p: &Path, stop: &AtomicBool) -> Result<u64, String> {
    let mut last = 0u64;
    for _ in 0..20 {
        if stop.load(Ordering::SeqCst) {
            return Err("توقف المراقبة".into());
        }
        let len = std::fs::metadata(p)
            .map(|m| m.len())
            .map_err(|e| format!("تعذر قراءة الملف: {e}"))?;
        if last > 0 && len == last {
            return Ok(len);
        }
        last = len;
        std::thread::sleep(Duration::from_millis(1500));
    }
    Err("لم يستقر حجم الملف — قد يكون ما يزال قيد التنزيل".into())
}

#[derive(Clone)]
struct WatchOpts {
    mode: Mode,
    kind: OutKind,
    keep_inst: bool,
    cuda: bool,
    notify: bool,
    max_mb: u64,
    rescan_secs: u64,
}

fn skip(p: &Path, reason: &str) {
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    tracing::warn!(target: "watch", "skip {name}: {reason}");
    emit(
        "watch-skip",
        serde_json::json!({ "path": name, "reason": reason }),
    );
}

fn process_watched(p: PathBuf, opts: &WatchOpts, stop: &AtomicBool) {
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    tracing::info!(target: "watch", "processing: {name}");

    // ── stability FIRST: the file may still be copying in. The guards below
    // MUST run after this — measuring metadata while a big file is being
    // copied reads a tiny size (even 0), so the file sailed through the size
    // and free-space guards unguarded (TOCTOU). Use the settled length that
    // wait_stable returns instead of re-reading metadata.
    let len = match wait_stable(&p, stop) {
        Ok(len) => len,
        Err(e) => {
            skip(&p, &e);
            return;
        }
    };

    // ── disk guard 1: maximum file size (measured AFTER the copy settled) ──
    if len > opts.max_mb * 1024 * 1024 {
        skip(
            &p,
            &format!(
                "الحجم ({:.0}MB) أكبر من الحد الأقصى ({:.0}MB)",
                len as f64 / 1048576.0,
                opts.max_mb as f64
            ),
        );
        return;
    }

    // ── disk guard 2: free space on the output volume ──
    let out_dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    if let Some(free) = free_bytes(&out_dir) {
        let need = (len * 3).max(1024 * 1024 * 1024);
        if free < need {
            skip(
                &p,
                &format!(
                    "مساحة القرص غير كافية (المطلوب ~{:.1}GB، المتاح {:.1}GB)",
                    need as f64 / 1073741824.0,
                    free as f64 / 1073741824.0
                ),
            );
            return;
        }
    }

    let out = pipeline::process_file(
        &p,
        &out_dir,
        opts.mode,
        opts.kind,
        opts.keep_inst,
        true,
        opts.cuda,
        None,
        &|pct| {
            emit(
                "watch-progress",
                serde_json::json!({ "path": name, "pct": pct.clamp(0.0, 1.0) }),
            );
            !stop.load(Ordering::SeqCst)
        },
        &|stage, pct| {
            let _ = (stage, pct);
        },
    );

    match out {
        Ok(o) => {
            emit(
                "watch-done",
                serde_json::json!({
                    "path": name,
                    "ok": true,
                    "seconds": o.seconds,
                    "vocals": o.vocals.as_ref().map(|p| p.to_string_lossy().into_owned()),
                    "video": o.video.as_ref().map(|p| p.to_string_lossy().into_owned()),
                }),
            );
            tracing::info!(target: "watch", "done: {name} in {:.1}s", o.seconds);
            if opts.notify {
                sys_notify("اكتملت المعالجة (مجلد المراقبة)", &name);
            }
        }
        Err(e) => {
            emit(
                "watch-done",
                serde_json::json!({ "path": name, "ok": false, "error": e.to_string() }),
            );
            tracing::warn!(target: "watch", "failed: {name}: {e}");
            if opts.notify {
                sys_notify("فشلت المعالجة (مجلد المراقبة)", &name);
            }
        }
    }
}

fn sweep(dir: &Path, tx: &mpsc::Sender<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !candidate_ok(&p) {
            continue;
        }
        // dedup happens in the receive loop via `seen` — a sweep must not
        // pre-mark keys, or the loop would skip every swept file.
        let _ = tx.send(p);
    }
}

fn run_watch(stop: Arc<AtomicBool>, dir: PathBuf, opts: WatchOpts) {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut seen: HashSet<String> = HashSet::new();
    let mut active: HashSet<PathBuf> = HashSet::new();

    // initial sweep — pick up anything already sitting in the folder
    sweep(&dir, &tx);

    // filesystem events (fast path)
    let tx2 = tx.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let interesting = ev.kind.is_create()
                || matches!(
                    ev.kind,
                    notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                );
            if interesting {
                for path in ev.paths {
                    let _ = tx2.send(path);
                }
            }
        }
    });
    let mut watcher = match watcher {
        Ok(w) => w,
        Err(e) => {
            tracing::error!(target: "watch", "فشل إنشاء المراقب: {e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(&dir, notify::RecursiveMode::NonRecursive) {
        tracing::error!(target: "watch", "فشل مراقبة المجلد {}: {e}", dir.display());
        return;
    }

    let mut last_rescan = std::time::Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(path) => {
                if !candidate_ok(&path) {
                    continue;
                }
                if active.contains(&path) {
                    continue; // already being processed right now
                }
                let Some(key) = key_of(&path) else { continue };
                if !seen.insert(key.clone()) {
                    continue;
                }
                active.insert(path.clone());
                process_watched(path.clone(), &opts, &stop);
                active.remove(&path);
                // re-key AFTER processing: wait_stable may have settled the
                // file at a different size — remember the final key so the
                // next rescan does not process the same file twice.
                if let Some(final_key) = key_of(&path) {
                    seen.insert(final_key);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // periodic rescan — the safety net for missed events
                if last_rescan.elapsed().as_secs() >= opts.rescan_secs {
                    last_rescan = std::time::Instant::now();
                    sweep(&dir, &tx);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = watcher.unwatch(&dir);
    tracing::info!(target: "watch", "watch stopped: {}", dir.display());
}

fn fingerprint(s: &Settings) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
        s.watch_enabled,
        s.watch_path.as_deref().unwrap_or(""),
        s.watch_mode,
        s.watch_out_kind,
        s.keep_instrumental,
        s.cuda,
        s.notify,
        s.watch_max_size_mb,
        s.watch_rescan_secs,
    )
}

/// Start / stop / restart the watch thread to match the given settings.
pub fn apply_settings(s: &Settings) {
    let mut guard = HANDLE.get_or_init(|| Mutex::new(None)).lock().unwrap();

    let should_run = s.watch_enabled
        && s
            .watch_path
            .as_deref()
            .map(|p| Path::new(p).is_dir())
            .unwrap_or(false);
    let fp = fingerprint(s);

    if let Some(h) = guard.as_ref() {
        if h.fingerprint == fp {
            return; // nothing changed
        }
    }

    // stop whatever is running
    if let Some(mut h) = guard.take() {
        h.stop.store(true, Ordering::SeqCst);
        if let Some(j) = h.join.take() {
            let _ = j.join();
        }
    }

    if !should_run {
        tracing::info!(target: "watch", "watch disabled");
        return;
    }

    let opts = WatchOpts {
        mode: if s.watch_mode == "clip" { Mode::Clip } else { Mode::Song },
        kind: match s.watch_out_kind.as_str() {
            "audio" => OutKind::Audio { fmt: OutFormat::Mp3 },
            // "auto"|"video": pipeline smart-falls back to mp3 for audio-only inputs
            _ => OutKind::Video { max_height: None },
        },
        keep_inst: s.keep_instrumental,
        cuda: s.cuda,
        notify: s.notify,
        max_mb: s.watch_max_size_mb,
        rescan_secs: s.watch_rescan_secs,
    };
    let dir = PathBuf::from(s.watch_path.clone().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let join = std::thread::Builder::new()
        .name("watch".into())
        .spawn(move || run_watch(stop2, dir, opts))
        .ok();
    *guard = Some(WatchHandle {
        stop,
        join,
        fingerprint: fp,
    });
    tracing::info!(
        target: "watch",
        "watch started: {}",
        s.watch_path.as_deref().unwrap_or("")
    );
}
