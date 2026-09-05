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
    /// Abort only the file being processed right now (the watcher thread
    /// itself keeps running). Reset after every file by the watch loop.
    cancel_file: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    fingerprint: String,
}

/// Cancel the currently processing watched file, if any (functional gap:
/// the watch path used to have no cancel affordance at all).
pub fn cancel_current() {
    let handle = HANDLE.get_or_init(|| Mutex::new(None));
    if let Some(h) = handle.lock().unwrap().as_ref() {
        h.cancel_file.store(true, Ordering::SeqCst);
        tracing::warn!(target: "watch", "أُرسل إلغاء ملف المراقبة الجاري");
    }
}

/// Persistent done-set: inputs already processed in EARLIER sessions must not
/// be reprocessed on every boot (functional gap: hours wasted + outputs
/// overwritten). Keyed by the same `key_of` (path|size|mtime); namespaced by
/// the settings fingerprint so a mode/quality change re-runs everything once.
fn done_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_default()
        .join("com.harammute.haramlite")
        .join("watch_done.json")
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct DoneSet {
    fp: String,
    keys: HashSet<String>,
}

fn load_done_keys_at(path: &Path, fp: &str) -> HashSet<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<DoneSet>(&s).ok())
        .filter(|d| d.fp == fp)
        .map(|d| d.keys)
        .unwrap_or_default()
}

fn save_done_keys_at(path: &Path, fp: &str, keys: &HashSet<String>) {
    let d = DoneSet { fp: fp.into(), keys: keys.clone() };
    if let Ok(bytes) = serde_json::to_vec(&d) {
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
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
fn wait_stable(p: &Path, stop: &AtomicBool, cancel_file: &AtomicBool) -> Result<u64, String> {
    let mut last = 0u64;
    for _ in 0..20 {
        if stop.load(Ordering::SeqCst) {
            return Err("توقف المراقبة".into());
        }
        if cancel_file.load(Ordering::SeqCst) {
            return Err("أُلغي ملف المراقبة".into());
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

/// Process one watched file. Returns true when terminally handled (done,
/// failed, or guard-rejected → remember and never retry this session) and
/// false when transient (still copying, cancelled, stopped → allow retry).
fn process_watched(
    p: PathBuf,
    opts: &WatchOpts,
    stop: &AtomicBool,
    cancel_file: &AtomicBool,
) -> bool {
    // A `watch-start` event feeds the unified external-jobs feed in the GUI
    // (functional gap: external jobs used to be invisible).
    emit(
        "watch-start",
        serde_json::json!({ "path": p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() }),
    );
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
    let len = match wait_stable(&p, stop, cancel_file) {
        Ok(len) => len,
        Err(e) => {
            skip(&p, &e);
            return false;
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
        return true;
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
            return true;
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
            !stop.load(Ordering::SeqCst) && !cancel_file.load(Ordering::SeqCst)
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
    true
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

fn run_watch(
    stop: Arc<AtomicBool>,
    cancel_file: Arc<AtomicBool>,
    dir: PathBuf,
    opts: WatchOpts,
    fp: String,
) {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut seen: HashSet<String> = HashSet::new();
    let mut active: HashSet<PathBuf> = HashSet::new();
    // Persistent done-set (functional gap): inputs finished in earlier
    // sessions are skipped — the boot sweep below must not reprocess them.
    let mut done = load_done_keys_at(&done_path(), &fp);

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
                if done.contains(&key) {
                    continue; // finished in an earlier session — never again
                }
                if !seen.insert(key.clone()) {
                    continue;
                }
                active.insert(path.clone());
                let terminal = process_watched(path.clone(), &opts, &stop, &cancel_file);
                cancel_file.store(false, Ordering::SeqCst);
                active.remove(&path);
                // re-key AFTER processing: wait_stable may have settled the
                // file at a different size — remember the final key so the
                // next rescan does not process the same file twice.
                let final_key = key_of(&path).unwrap_or_else(|| key.clone());
                if terminal {
                    seen.insert(final_key.clone());
                    done.insert(final_key);
                    save_done_keys_at(&done_path(), &fp, &done);
                } else {
                    // Transient (still copying / cancelled): forget the
                    // pre-key so a later rescan retries instead of skipping
                    // forever (functional gap: seen-poisoning).
                    seen.remove(&key);
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
    let should_run = s.watch_enabled
        && s
            .watch_path
            .as_deref()
            .map(|p| Path::new(p).is_dir())
            .unwrap_or(false);
    let fp = fingerprint(s);

    // Take the old handle under the lock, then join OUTSIDE it: joining a
    // long DSP job while holding HANDLE froze every other set_settings
    // caller behind this mutex (audit 2026-09-03).
    let old = {
        let mut guard = HANDLE.get_or_init(|| Mutex::new(None)).lock().unwrap();
        if let Some(h) = guard.as_ref() {
            if h.fingerprint == fp {
                return; // nothing changed
            }
        }
        guard.take()
    };

    // stop whatever was running
    if let Some(mut h) = old {
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
    let cancel_file = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let cancel2 = cancel_file.clone();
    let fp2 = fp.clone();
    let join = std::thread::Builder::new()
        .name("watch".into())
        .spawn(move || run_watch(stop2, cancel2, dir, opts, fp2))
        .ok();
    let mut guard = HANDLE.get_or_init(|| Mutex::new(None)).lock().unwrap();
    *guard = Some(WatchHandle {
        stop,
        cancel_file,
        join,
        fingerprint: fp,
    });
    tracing::info!(
        target: "watch",
        "watch started: {}",
        s.watch_path.as_deref().unwrap_or("")
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Functional gap: the done-set must survive a restart and must reset
    /// when the settings fingerprint changes (new mode/quality = rerun).
    #[test]
    fn done_set_roundtrips_and_namespaces_by_fingerprint() {
        let dir = std::env::temp_dir().join(format!("hl_watch_done_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("watch_done.json");

        let mut keys = HashSet::new();
        keys.insert("a|1|2".to_string());
        save_done_keys_at(&path, "fp1", &keys);

        assert!(load_done_keys_at(&path, "fp1").contains("a|1|2"));
        assert!(
            load_done_keys_at(&path, "fp2").is_empty(),
            "fingerprint change must invalidate the set"
        );
        assert!(load_done_keys_at(&dir.join("missing.json"), "fp1").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
