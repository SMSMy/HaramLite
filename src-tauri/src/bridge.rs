//! Sprint E2 — Native Messaging bridge between the browser extension and
//! the desktop app.
//!
//! Architecture (no open ports, no CORS, no cloud):
//!   browser → spawns HaramLite.exe --native-host → stdin/stdout JSON
//!   host instance writes `<app_data>/requests/req_*.json` and exits
//!   (spawning the GUI app if it is not already running)
//!   running app → bridge_loop watches the requests dir (notify + periodic
//!   sweep) → downloads the URL with yt-dlp → runs the full local pipeline
//!   → system notification.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use notify::Watcher;
use tauri::Manager;

use crate::pipeline::{self, Mode, OutKind};
use crate::settings::Settings;

/// Cancel flag for the currently running browser-requested job.
static CANCEL: AtomicBool = AtomicBool::new(false);

pub const HOST_NAME: &str = "com.harammute.haramlite";
pub const CHROME_EXT_ID: &str = "jchaeejligdfbkgkbgneimclkagoopig";
pub const FIREFOX_EXT_ID: &str = "haramlite_bridge@harammute.app";

fn requests_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_default()
        .join("com.harammute.haramlite")
        .join("requests")
}

fn state_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_default()
        .join("com.harammute.haramlite")
        .join("bridge_state.json")
}

/// Live state consumed by the browser mini-panel (via the `status` message):
/// { running: {name, stage, pct} | null, last: {name, ok, seconds?, error?} }
pub fn write_state(v: &serde_json::Value) {
    if let Ok(bytes) = serde_json::to_vec(v) {
        let path = state_path();
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// Progress closures fire VERY often — writing the state file on every tick
/// thrashes the disk and measurably slows the pipeline. Throttle to one
/// write per 250ms; final states bypass the throttle.
static LAST_STATE_WRITE: Mutex<Option<std::time::Instant>> = Mutex::new(None);

pub fn write_state_throttled(v: &serde_json::Value) {
    let now = std::time::Instant::now();
    {
        let mut last = LAST_STATE_WRITE
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(t) = *last {
            if now.duration_since(t).as_millis() < 250 {
                return;
            }
        }
        *last = Some(now);
    }
    write_state(v);
}

pub fn read_state() -> serde_json::Value {
    // Audit: the writer replaces the file atomically (tmp + rename); on
    // Windows a read hitting the rename instant can fail with Access Denied.
    // Retry briefly before falling back to an empty state (prevents the
    // in-page progress bar from flickering).
    for _ in 0..3 {
        if let Ok(s) = std::fs::read_to_string(state_path()) {
            if let Ok(v) = serde_json::from_str(&s) {
                return v;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    serde_json::json!({ "running": null, "last": null })
}

// ─────────────────────────────────────────────────────────────────────
// Native Messaging host entry (spawned BY the browser, headless)
// ─────────────────────────────────────────────────────────────────────

pub fn native_host_entry() -> i32 {
    // Audit E-1: persistent stdio loop — the browser keeps ONE host process
    // per `connectNative` port and reuses it for every message, instead of
    // spawning and killing a process for each 1.5s poll (sendNativeMessage).
    let mut stdin = std::io::stdin();
    let mut len_buf = [0u8; 4];
    loop {
        if stdin.read_exact(&mut len_buf).is_err() {
            break; // EOF: the browser closed the port → clean exit
        }
        let len = u32::from_le_bytes(len_buf) as usize;
        if len == 0 || len > 1_000_000 {
            reply_err("bad message length");
            continue;
        }
        let mut buf = vec![0u8; len];
        if stdin.read_exact(&mut buf).is_err() {
            break;
        }
        match serde_json::from_slice::<serde_json::Value>(&buf) {
            Ok(msg) => handle_host_message(&msg),
            Err(_) => reply_err("invalid json"),
        }
    }
    0
}

fn handle_host_message(msg: &serde_json::Value) {
    match msg.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "ping" => reply_ok(serde_json::json!({ "ok": true, "app": "HaramLite" })),
        "status" => reply_ok(serde_json::json!({ "ok": true, "state": read_state() })),
        "open_folder" => {
            let dir = dirs::video_dir().unwrap_or_default().join("HaramLite");
            let _ = std::fs::create_dir_all(&dir);
            #[cfg(target_os = "windows")]
            {
                let _ = std::process::Command::new("explorer").arg(&dir).spawn();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
            }
            reply_ok(serde_json::json!({ "ok": true }));
        }
        "open_file" => {
            // Open the FINISHED output (video preferred, else vocals) from the
            // app's own state — the browser never passes arbitrary paths.
            let st = read_state();
            let path = st
                .get("last")
                .and_then(|l| l.get("video").or_else(|| l.get("vocals")))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            match path {
                Some(p) if !p.is_empty() => {
                    #[cfg(target_os = "windows")]
                    {
                        let _ = std::process::Command::new("explorer").arg(&p).spawn();
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        let _ = std::process::Command::new("xdg-open").arg(&p).spawn();
                    }
                    reply_ok(serde_json::json!({ "ok": true }));
                }
                _ => reply_err("لا يوجد مخرج مكتمل بعد"),
            }
        }
        "cancel" => {
            // relay the cancel request to the running app as a request file
            // (atomic tmp+rename: the watcher must never read a half file)
            let dir = requests_dir();
            if std::fs::create_dir_all(&dir).is_ok() {
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let path = dir.join(format!("cancel_{nanos:x}.json"));
                let body = serde_json::to_vec(&serde_json::json!({ "type": "cancel" }))
                    .unwrap_or_default();
                let tmp = dir.join(format!("cancel_{nanos:x}.json.tmp"));
                if std::fs::write(&tmp, body).is_ok() {
                    let _ = std::fs::rename(&tmp, &path);
                }
            }
            reply_ok(serde_json::json!({ "ok": true }));
        }
        "link" => {
            let url = msg.get("url").and_then(|u| u.as_str()).unwrap_or("");
            if url.trim().is_empty() {
                reply_err("empty url");
                return;
            }
            match write_request(url) {
                Ok(path) => {
                    spawn_main_app();
                    reply_ok(serde_json::json!({ "ok": true, "queued": path }));
                }
                Err(e) => reply_err(&e),
            }
        }
        other => reply_err(&format!("unknown message type: {other}")),
    }
}

fn reply_ok(v: serde_json::Value) {
    let bytes = serde_json::to_vec(&v).unwrap_or_default();
    let mut out = std::io::stdout();
    let _ = out.write_all(&(bytes.len() as u32).to_le_bytes());
    let _ = out.write_all(&bytes);
    let _ = out.flush();
}

fn reply_err(msg: &str) {
    reply_ok(serde_json::json!({ "ok": false, "error": msg }));
}

fn write_request(url: &str) -> Result<String, String> {
    let dir = requests_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = dir.join(format!("req_{nanos:x}.json"));
    let body = serde_json::to_vec(&serde_json::json!({
        "type": "link",
        "url": url,
        "ts": nanos,
    }))
    .unwrap_or_default();
    // Atomic write (tmp + rename): notify fires on file CREATE — a direct
    // write could be picked up half-written, fail to parse, and linger
    // forever (dispatch bails before remove_file). Same pattern as write_state.
    let tmp = dir.join(format!("req_{nanos:x}.json.tmp"));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// If no main GUI instance is running, start one (hidden) so the request is
/// picked up; if it IS running, its bridge_loop sees the request file anyway.
/// Stdio is nulled so the child never inherits (and holds open) the native
/// messaging stdout pipe to the browser.
fn spawn_main_app() {
    if app_already_running() {
        return; // no duplicate windows — the running instance handles it
    }
    if let Ok(exe) = std::env::current_exe() {
        use std::process::Stdio;
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new(exe)
                .arg("--hidden-start")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x00000008) // DETACHED_PROCESS
                .spawn();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new(exe)
                .arg("--hidden-start")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
    }
}

/// Probe (without keeping) the single-instance lock: true when a GUI
/// instance is already alive.
fn app_already_running() -> bool {
    use std::net::TcpStream;
    TcpStream::connect("127.0.0.1:48765").is_ok()
}

// ─────────────────────────────────────────────────────────────────────
// Request pickup inside the RUNNING app
// ─────────────────────────────────────────────────────────────────────

pub fn init(app: tauri::AppHandle, settings: Arc<Mutex<Settings>>) {
    let dir = requests_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        tracing::warn!(target: "bridge", "تعذر إنشاء مجلد الطلبات");
        return;
    }
    // Browser requests are ephemeral: drop anything left over from a previous
    // session (stale clicks must not resume processing after a restart).
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
    // and reset the live state so the panel never shows a dead job
    write_state(&serde_json::json!({ "running": null, "queue": 0, "last": null }));
    std::thread::Builder::new()
        .name("bridge".into())
        .spawn(move || bridge_loop(app, settings, dir))
        .ok();
}

fn bridge_loop(app: tauri::AppHandle, settings: Arc<Mutex<Settings>>, dir: PathBuf) {
    // ── worker thread: processes link requests SEQUENTIALLY ──
    // (the watcher loop below must never block on a 20-minute job, or
    // cancel requests would queue up behind it and never fire)
    let (job_tx, job_rx) = mpsc::channel::<String>(); // queued URLs
    // Shared receiver so the watcher thread can DRAIN the queue on cancel.
    // A plain owned Receiver sits blocked inside the worker's recv() and
    // cannot be drained from anywhere else.
    let job_rx = Arc::new(Mutex::new(job_rx));
    let pending = Arc::new(AtomicUsize::new(0));
    {
        let worker_app = app.clone();
        let worker_settings = settings.clone();
        let worker_pending = pending.clone();
        let worker_rx = job_rx.clone();
        std::thread::Builder::new()
            .name("bridge-worker".into())
            .spawn(move || loop {
                // Hold the lock only around a short recv_timeout so the
                // cancel branch can grab the same mutex to drain the queue.
                let url = {
                    let guard = worker_rx.lock().unwrap_or_else(|p| p.into_inner());
                    match guard.recv_timeout(Duration::from_millis(200)) {
                        Ok(url) => Some(url),
                        Err(mpsc::RecvTimeoutError::Timeout) => None,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                };
                if let Some(url) = url {
                    handle_request(&worker_app, &worker_settings, &url, &worker_pending);
                }
            })
            .ok();
    }

    // ── watcher loop: dispatch requests, handle cancel IMMEDIATELY ──
    let (file_tx, file_rx) = mpsc::channel::<PathBuf>();
    let ftx = file_tx.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.kind.is_create() {
                for p in ev.paths {
                    let _ = ftx.send(p);
                }
            }
        }
    })
    .ok();

    let dispatch = |path: &Path| {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            return;
        }
        let Ok(data) = std::fs::read_to_string(path) else {
            return;
        };
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&data) else {
            return;
        };
        let t = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "cancel" => {
                // IMMEDIATE: flip the flag — the running job aborts at its
                // next progress checkpoint (download or separation).
                CANCEL.store(true, Ordering::SeqCst);
                // Drain the queue: "cancel" must stop EVERYTHING queued, not
                // just the current item — otherwise the worker grabs the next
                // URL at once and starts another 20-minute job.
                {
                    let guard = job_rx.lock().unwrap_or_else(|p| p.into_inner());
                    while guard.try_recv().is_ok() {}
                }
                pending.store(0, Ordering::SeqCst);
                tracing::warn!(target: "bridge", "أُرسل أمر الإلغاء — سيتوقف العمل الجاري وفُرّغ الطابور");
                write_state(&serde_json::json!({
                    "running": null,
                    "queue": 0,
                    "last": { "name": "—", "ok": false, "error": "أُلغيت المعالجة من قبل المستخدم" }
                }));
            }
            "link" => {
                let url = msg.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if url.is_empty() {
                    return;
                }
                if seen_before(&url) {
                    tracing::warn!(target: "bridge", "طلب مكرر لنفس الرابط — تخطي: {url}");
                    write_state(&serde_json::json!({
                        "running": null,
                        "last": { "name": url, "ok": false, "error": "هذا الرابط طُلب من قبل في هذه الجلسة — تخطي المكرر" }
                    }));
                    return;
                }
                pending.fetch_add(1, Ordering::SeqCst);
                let _ = job_tx.send(url);
            }
            _ => {}
        }
        let _ = std::fs::remove_file(path);
    };

    let Some(mut watcher) = watcher else {
        tracing::error!(target: "bridge", "فشل إنشاء مراقب الطلبات");
        return;
    };
    if watcher.watch(&dir, notify::RecursiveMode::NonRecursive).is_err() {
        return;
    }

    loop {
        match file_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(p) => dispatch(&p),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // safety net for missed events (OneDrive/AV-style drops)
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for e in entries.flatten() {
                        dispatch(&e.path());
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// ONE shared dedup set for the whole process (module-level so both
/// `seen_before` and `forget_seen` see the same data).
static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Session-scoped duplicate guard: repeated clicks on the same video must
/// not re-download and re-process it (the user's 5 clicks → 5×20 minutes).
fn seen_before(url: &str) -> bool {
    let mut guard = SEEN.lock().unwrap_or_else(|p| p.into_inner());
    let set = guard.get_or_insert_with(HashSet::new);
    !set.insert(url.to_string())
}

/// Audit: a FAILED request must be retryable in the same session — remove
/// its URL from the dedup set (download errors, cancels, processing errors).
fn forget_seen(url: &str) {
    let mut guard = SEEN.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(set) = guard.as_mut() {
        set.remove(url);
    }
}

fn handle_request(
    app: &tauri::AppHandle,
    settings: &Arc<Mutex<Settings>>,
    url: &str,
    pending: &Arc<AtomicUsize>,
) {
    use tauri::Emitter;

    tracing::info!(target: "bridge", "طلب من المتصفح: {url}");
    CANCEL.store(false, Ordering::SeqCst);

    let (s, notify_enabled) = {
        let s = settings.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let n = s.notify;
        (s, n)
    };

    let out_dir = dirs::video_dir().unwrap_or_default().join("HaramLite");
    let url_label = url.to_string();
    let name_label = url_label.clone();
    let queued = pending.load(Ordering::SeqCst).saturating_sub(1);
    write_state(&serde_json::json!({
        "running": { "name": name_label, "stage": "download", "pct": 0.0 },
        "queue": queued,
        "last": null
    }));

    match crate::yt_dlp::download_media(url, &out_dir, &|p| {
        let _ = app.emit("dl-progress", p.clamp(0.0, 1.0));
        write_state_throttled(&serde_json::json!({
            "running": { "name": name_label, "stage": "download", "pct": p.clamp(0.0, 1.0) },
            "queue": queued,
            "last": null
        }));
        !CANCEL.load(Ordering::SeqCst)
    }) {
        Ok(file) => {
            let mode = if s.watch_mode == "clip" { Mode::Clip } else { Mode::Song };
            let file_label = file
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into());
            write_state(&serde_json::json!({
                "running": { "name": file_label, "stage": "normalize", "pct": 0.0 },
                "queue": queued,
                "last": null
            }));
            let res = pipeline::process_file(
                &file,
                &out_dir,
                mode,
                OutKind::Video { max_height: None },
                s.keep_instrumental,
                true,
                s.cuda,
                None,
                &|p| {
                    let _ = app.emit("sep-progress", p.clamp(0.0, 1.0));
                    !CANCEL.load(Ordering::SeqCst)
                },
                &|stage, p| {
                    write_state_throttled(&serde_json::json!({
                        "running": { "name": file_label, "stage": stage, "pct": p.clamp(0.0, 1.0) },
                        "queue": queued,
                        "last": null
                    }));
                },
            );
            match res {
                Ok(o) => {
                    // name the FINISHED OUTPUT (not the downloaded input) so the
                    // completion card/toast never points the user at the wrong file
                    let out_name = o
                        .video
                        .as_ref()
                        .or(o.vocals.as_ref())
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| file_label.clone());
                    tracing::info!(target: "bridge", "اكتمل طلب المتصفح: {} في {:.1}s", out_name, o.seconds);
                    write_state(&serde_json::json!({
                        "running": null,
                        "queue": 0,
                        "last": { "name": out_name, "ok": true, "seconds": o.seconds,
                                  "vocals": o.vocals.as_ref().map(|p| p.to_string_lossy().into_owned()),
                                  "video": o.video.as_ref().map(|p| p.to_string_lossy().into_owned()) }
                    }));
                    let _ = app.emit(
                        "bridge-done",
                        serde_json::json!({ "name": out_name, "ok": true, "seconds": o.seconds }),
                    );
                    if notify_enabled {
                        use tauri_plugin_notification::NotificationExt;
                        let _ = app
                            .notification()
                            .builder()
                            .title("اكتمل طلب المتصفح")
                            .body(&out_name)
                            .show();
                    }
                }
                Err(e) => {
                    let cancelled = CANCEL.load(Ordering::SeqCst);
                    tracing::warn!(target: "bridge", "فشل طلب المتصفح: {}: {e}", file_label);
                    // Audit: a failed job must be retryable in this session
                    forget_seen(url);
                    write_state(&serde_json::json!({
                        "running": null,
                        "queue": 0,
                        "last": { "name": file_label, "ok": false,
                                  "error": if cancelled { "أُلغيت المعالجة من قبل المستخدم".to_string() } else { e.to_string() } }
                    }));
                    let _ = app.emit(
                        "bridge-done",
                        serde_json::json!({ "name": file_label, "ok": false, "error": e.to_string() }),
                    );
                }
            }
        }
        Err(e) => {
            let cancelled = CANCEL.load(Ordering::SeqCst);
            tracing::warn!(target: "bridge", "فشل تنزيل رابط المتصفح: {e}");
            // Audit: a failed download must be retryable in this session
            forget_seen(url);
            write_state(&serde_json::json!({
                "running": null,
                "queue": 0,
                "last": { "name": name_label, "ok": false,
                          "error": if cancelled { "أُلغي التنزيل من قبل المستخدم".to_string() } else { e.to_string() } }
            }));
            let _ = app.emit(
                "bridge-done",
                serde_json::json!({ "name": name_label, "ok": false, "error": e.to_string() }),
            );
        }
    }
    // Saturating: a cancel zeroes `pending` while the running job is still
    // finishing, so its final decrement must not underflow the counter.
    pending
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| Some(v.saturating_sub(1)))
        .ok();
}

// ─────────────────────────────────────────────────────────────────────
// Registration (Settings → "التكامل مع المتصفح")
// ─────────────────────────────────────────────────────────────────────

/// Self-healing: called at every app startup — if the registry key vanished
/// (cleaner tools, manual reset) but our host manifest still exists, rewrite
/// the keys silently so the extension keeps working.
pub fn ensure_registered() {
    let manifest_path = dirs::data_dir()
        .unwrap_or_default()
        .join("com.harammute.haramlite")
        .join("native-host")
        .join(format!("{HOST_NAME}.json"));
    if !manifest_path.is_file() {
        return; // user never enabled integration — nothing to heal
    }
    let manifest_str = manifest_path.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for t in [
            r"Software\Google\Chrome\NativeMessagingHosts",
            r"Software\Chromium\NativeMessagingHosts",
            r"Software\Microsoft\Edge\NativeMessagingHosts",
            r"Software\Mozilla\NativeMessagingHosts",
        ] {
            // cleanup: older builds wrote a NAMED VALUE under the parent key
            // (Chrome never reads that) — remove it if present.
            if let Ok((parent, _)) = hkcu.create_subkey(t) {
                let _ = parent.delete_value(HOST_NAME);
            }
            // correct structure: a SUBKEY named after the host whose
            // DEFAULT value points at the manifest JSON.
            if let Ok((key, _)) = hkcu.create_subkey(&format!("{t}\\{HOST_NAME}")) {
                let current: Result<String, _> = key.get_value("");
                let needs_write = match current {
                    Ok(v) => v != manifest_str,
                    Err(_) => true, // missing or unreadable → rewrite
                };
                if needs_write && key.set_value("", &manifest_str).is_ok() {
                    tracing::info!(target: "bridge", "أُعيد تسجيل مضيف التكامل في {t}");
                }
            }
        }
    }
}

pub fn register(app: &tauri::AppHandle, browser: &str) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("native-host");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let manifest_path = dir.join(format!("{HOST_NAME}.json"));
    let manifest = serde_json::json!({
        "name": HOST_NAME,
        "description": "HaramLite desktop bridge (Native Messaging)",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{CHROME_EXT_ID}/")],
        "allowed_extensions": [FIREFOX_EXT_ID],
    });
    std::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;

    // A2: write the registry keys AND verify them by reading back — no more
    // silent "success" that leaves the user confused by Chrome's cache.
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let targets: &[&str] = match browser.to_ascii_lowercase().as_str() {
            "firefox" => &[r"Software\Mozilla\NativeMessagingHosts"],
            _ => &[
                r"Software\Google\Chrome\NativeMessagingHosts",
                r"Software\Chromium\NativeMessagingHosts",
                r"Software\Microsoft\Edge\NativeMessagingHosts",
            ],
        };
        let manifest_str = manifest_path.to_string_lossy().into_owned();
        for t in targets {
            // remove any legacy wrongly-placed named value under the parent
            let (parent, _) = hkcu.create_subkey(t).map_err(|e| e.to_string())?;
            let _ = parent.delete_value(HOST_NAME);
            // Chrome/Firefox expect a SUBKEY whose default value is the path
            let (key, _) = hkcu
                .create_subkey(&format!("{t}\\{HOST_NAME}"))
                .map_err(|e| e.to_string())?;
            key.set_value("", &manifest_str)
                .map_err(|e| e.to_string())?;
            // verification: read back exactly what we just wrote
            let read_back: String = key.get_value("").map_err(|e| {
                format!("كُتب المفتاح لكن تعذر التحقق منه: {e} — أعد المحاولة")
            })?;
            if read_back != manifest_str {
                return Err(format!(
                    "تحقق التسجيل فشل: القيمة المكتوبة لا تطابق ({t})"
                ));
            }
        }
    }

    let browser_name = if browser.eq_ignore_ascii_case("firefox") {
        "Firefox"
    } else {
        "Chrome/Edge"
    };
    Ok(format!(
        "سُجّل التكامل مع {browser_name} وتحقّق منه ✓\n⚠ أغلق المتصفح بالكامل ثم أعد فتحه لتفعيل الاتصال، ثم حمّل الإضافة من مجلد browser-extension"
    ))
}
