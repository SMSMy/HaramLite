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

use crate::pipeline::{self, Mode, OutKind};
use crate::settings::Settings;

/// Cancel flag for the currently running browser-requested job.
/// Stored as an Arc so worker/monitor threads can hold it safely.
static CANCEL: std::sync::OnceLock<Arc<AtomicBool>> = std::sync::OnceLock::new();
fn cancel_flag() -> Arc<AtomicBool> {
    CANCEL
        .get_or_init(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

pub const HOST_NAME: &str = "com.harammute.haramlite";
pub const CHROME_EXT_ID: &str = "jchaeejligdfbkgkbgneimclkagoopig";
pub const FIREFOX_EXT_ID: &str = "haramlite_bridge@harammute.app";

/// Base data dir, overridable for tests (`HARAMLITE_DATA_DIR`) so unit tests
/// never touch the user's real `requests/` or `bridge_state.json`.
fn data_dir() -> PathBuf {
    crate::paths::data_dir()
}

fn requests_dir() -> PathBuf {
    data_dir()
        .join("com.harammute.haramlite")
        .join("requests")
}

fn state_path() -> PathBuf {
    data_dir()
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
        "status" => reply_ok(serde_json::json!({
            "ok": true,
            "state": read_state(),
            // Expert D2د: provider truth for the page CPU-only policy (the
            // host process cannot see ACTIVE_PROVIDER — it reads the file).
            "provider": crate::separator::read_provider(),
        })),
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
            match write_request(url, job_watch_of(msg)) {
                Ok(path) => {
                    spawn_main_app();
                    reply_ok(serde_json::json!({ "ok": true, "queued": path }));
                }
                Err(e) => reply_err(&e),
            }
        }
        "result_file" => {
            // In-page watching: slices of the RECORDED last page-audio only
            // (same rule as open_file — the browser never passes paths).
            let offset = msg.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let len = msg.get("len").and_then(|v| v.as_u64()).unwrap_or(PAGE_SLICE_MAX as u64) as usize;
            match serve_page_audio_slice(offset, len) {
                Ok(v) => reply_ok(serde_json::json!({ "ok": true, "file": v })),
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

fn write_request(url: &str, watch: bool) -> Result<String, String> {
    let dir = requests_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = dir.join(format!("req_{nanos:x}.json"));
    let mut body = serde_json::json!({
        "type": "link",
        "url": url,
        "ts": nanos,
    });
    // Temp watch-listens ride the same file so old hosts/clients interoperate:
    // absent mode means full-save (backward compatible both directions).
    if watch {
        body["mode"] = serde_json::json!("watch");
    }
    let body = serde_json::to_vec(&body).unwrap_or_default();
    // Atomic write (tmp + rename): notify fires on file CREATE — a direct
    // write could be picked up half-written, fail to parse, and linger
    // forever (dispatch bails before remove_file). Same pattern as write_state.
    let tmp = dir.join(format!("req_{nanos:x}.json.tmp"));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Max binary bytes per page-audio slice: hex doubles the size and the host
/// protocol caps messages at 1MB — 256KB binary ≈ 524KB JSON, safe margin.
pub const PAGE_SLICE_MAX: usize = 262144;

/// Pure slice (unit-tested): clamped offset, lowercase hex, done flag.
pub fn slice_bytes(bytes: &[u8], offset: usize, len: usize) -> (usize, String, bool) {
    let total = bytes.len();
    let off = offset.min(total);
    let end = (off + len.min(PAGE_SLICE_MAX)).min(total);
    let mut hex = String::with_capacity((end - off) * 2);
    for b in &bytes[off..end] {
        hex.push_str(&format!("{b:02x}"));
    }
    (off, hex, end >= total)
}

/// Pure reader for the completion-job URL (unit-tested): states written
/// before the url field (or failures) yield None — never panic, never guess.
pub fn job_url_of(last: &serde_json::Value) -> Option<&str> {
    last.get("url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

/// Serve ONLY the recorded last page-audio (same rule as open_file — the
/// browser never passes arbitrary paths, so an extension bug can never
/// turn this into a file-read primitive).
fn serve_page_audio_slice(offset: usize, len: usize) -> Result<serde_json::Value, String> {
    let st = read_state();
    let path = st
        .get("last")
        .and_then(|l| l.get("page_audio"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "لا يوجد صوت صفحة مكتمل بعد".to_string())?
        .to_string();
    let bytes = std::fs::read(&path).map_err(|e| format!("تعذر قراءة صوت الصفحة: {e}"))?;
    let (off, hex, done) = slice_bytes(&bytes, offset, len);
    Ok(serde_json::json!({ "total": bytes.len(), "offset": off, "data": hex, "done": done }))
}

/// Directory for compact in-page audio (NOT the user's folder — no clutter).
pub fn page_audio_dir() -> PathBuf {
    crate::paths::data_dir().join("page-audio")
}

/// Keep only `keep` inside the page-audio dir (best-effort): temp listens
/// vanish as soon as the next one completes (field #3).
fn sweep_page_audio_dir(keep: Option<&Path>) {
    let dir = page_audio_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if Some(p.as_path()) != keep {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Page-audio for in-page watching: the vocals mp3 reused for audio jobs;
/// a compact mp3 extracted beside it for video jobs (the Clean MP4 is far
/// too heavy for 1MB native messages). None ⇒ watching unavailable — the
/// file pipeline itself is unaffected (graceful, warned).
fn ensure_page_audio(o: &crate::pipeline::PipelineOutput) -> Option<PathBuf> {
    if o.video.is_none() {
        return o.vocals.clone();
    }
    let video = o.video.as_ref()?;
    let dir = page_audio_dir();
    // Sweep older page-audio first (best-effort — the folder holds one file).
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
    match crate::media::extract_audio(video, "mp3", &dir) {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!(target: "bridge", "تعذر استخراج صوت الصفحة ({e}) — المشاهدة داخل الصفحة غير متاحة");
            None
        }
    }
}

/// Pure predicate (unit-tested): remove the auto-downloaded source only when
/// it lives in our managed download folder AND at least one real output
/// exists AND no output IS the source.
/// P2: shared literally with the GUI download path (lib.rs) — one rule.
pub(crate) fn should_remove_bridge_source(source: &Path, out_dir: &Path, outputs: &[PathBuf]) -> bool {
    if source.parent() != Some(out_dir) {
        return false;
    }
    let mut live = false;
    for o in outputs {
        if o == source {
            return false;
        }
        if o.is_file() {
            live = true;
        }
    }
    live
}

/// GUI-initiated cancel of a browser job (functional gap: the desktop UI
/// could never cancel one). Writes the same atomic cancel file the native
/// host writes for `type: cancel`, so the running worker drains and stops.
pub fn cancel_via_gui() -> Result<(), String> {
    let dir = requests_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = dir.join(format!("cancel_{nanos:x}.json"));
    let body = serde_json::to_vec(&serde_json::json!({ "type": "cancel" })).unwrap_or_default();
    let tmp = dir.join(format!("cancel_{nanos:x}.json.tmp"));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
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

/// Grace window for the cold-start race: request files newer than this are
/// treated as "may have woken us up" and survive the startup cleanup.
const COLD_START_GRACE_SECS: u64 = 120;

/// Remove stale request files, keeping anything fresh enough to have
/// triggered this very boot (cold start via the native host).
fn clear_stale_requests(dir: &Path, now: std::time::SystemTime, grace_secs: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        // A file from the future (clock skew) or unreadable mtime is kept:
        // deleting what we cannot date caused real request loss in tests.
        let fresh = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .map(|t| now.duration_since(t).map(|age| age.as_secs() < grace_secs).unwrap_or(true))
            .unwrap_or(true);
        if !fresh {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Shared dispatch context: the watcher thread files requests here, the
/// worker thread drains them. Extracted from the `bridge_loop` closure so it
/// is unit-testable (audit 2026-09-03).
struct DispatchCtx {
    job_tx: mpsc::Sender<Job>,
    job_rx: Arc<Mutex<mpsc::Receiver<Job>>>,
    pending: Arc<AtomicUsize>,
}

/// A queued browser request: full-save (default) or temp watch-listen
/// (field #3 — audio only, temp dir, swept; never saved to the user folder).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Job {
    url: String,
    watch: bool,
}

/// Pure mode parse (unit-tested): only an explicit `"watch"` opts into the
/// temp path — old clients send no mode and stay full-save.
fn job_watch_of(msg: &serde_json::Value) -> bool {
    msg.get("mode").and_then(|v| v.as_str()) == Some("watch")
}

/// File one request off disk and route it. The file is removed as soon as its
/// bytes are in hand, on EVERY path — a poison (duplicate/empty/garbage) file
/// must never survive to be re-dispatched by the 5s sweep forever.
fn dispatch_file(path: &Path, ctx: &DispatchCtx) {
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return;
    }
    // Unreadable (transient lock/half-rename): keep for the next sweep.
    let Ok(data) = std::fs::read_to_string(path) else {
        return;
    };
    // Bytes in hand: never re-dispatch, whatever follows.
    let _ = std::fs::remove_file(path);
    if data.trim().is_empty() {
        return;
    }
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(&data) else {
        return;
    };
    let t = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match t {
        "cancel" => {
            // IMMEDIATE: flip the flag — the running job aborts at its
            // next progress checkpoint (download or separation).
            cancel_flag().store(true, Ordering::SeqCst);
            // Drain the queue: "cancel" must stop EVERYTHING queued, not
            // just the current item — otherwise the worker grabs the next
            // URL at once and starts another 20-minute job.
            {
                let guard = ctx.job_rx.lock().unwrap_or_else(|p| p.into_inner());
                while guard.try_recv().is_ok() {}
            }
            ctx.pending.store(0, Ordering::SeqCst);
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
            ctx.pending.fetch_add(1, Ordering::SeqCst);
            let _ = ctx.job_tx.send(Job { url, watch: job_watch_of(&msg) });
        }
        _ => {}
    }
}

pub fn init(app: tauri::AppHandle, settings: Arc<Mutex<Settings>>) {
    let dir = requests_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        tracing::warn!(target: "bridge", "تعذر إنشاء مجلد الطلبات");
        return;
    }
    // Browser requests are ephemeral: drop anything left over from a previous
    // session (stale clicks must not resume processing after a restart).
    // Audit 2026-09-03: a cold start TRIGGERED by a fresh request (the native
    // host writes req_*.json THEN spawns us hidden) must not delete the very
    // file that woke us — keep anything fresher than the grace window.
    clear_stale_requests(&dir, std::time::SystemTime::now(), COLD_START_GRACE_SECS);
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
    let (job_tx, job_rx) = mpsc::channel::<Job>(); // queued requests
    // Shared receiver so the watcher thread can DRAIN the queue on cancel.
    // A plain owned Receiver sits blocked inside the worker's recv() and
    // cannot be drained from anywhere else.
    let job_rx = Arc::new(Mutex::new(job_rx));
    let pending = Arc::new(AtomicUsize::new(0));
    let ctx = DispatchCtx {
        job_tx,
        job_rx: job_rx.clone(),
        pending: pending.clone(),
    };
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
                let job = {
                    let guard = worker_rx.lock().unwrap_or_else(|p| p.into_inner());
                    match guard.recv_timeout(Duration::from_millis(200)) {
                        Ok(job) => Some(job),
                        Err(mpsc::RecvTimeoutError::Timeout) => None,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                };
                if let Some(job) = job {
                    // Audit 2026-09-03: a panic inside one job (e.g. a NaN
                    // sample tripping DSP) must not kill this thread forever
                    // and wedge every later request — survive it loudly.
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        handle_request(&worker_app, &worker_settings, &job.url, job.watch, &worker_pending);
                    }));
                    if r.is_err() {
                        tracing::error!(target: "bridge", "نجا العامل من عطل في مهمة — راجع سجل الانهيار؛ الطابور مستمر");
                        forget_seen(&job.url);
                        worker_pending
                            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| {
                                Some(v.saturating_sub(1))
                            })
                            .ok();
                        write_state(&serde_json::json!({
                            "running": null,
                            "queue": 0,
                            "last": { "name": job.url, "ok": false, "error": "عطل داخلي — أعد المحاولة" }
                        }));
                    }
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

    let dispatch = |path: &Path| dispatch_file(path, &ctx);

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
    watch: bool,
    pending: &Arc<AtomicUsize>,
) {
    use tauri::Emitter;

    tracing::info!(target: "bridge", "طلب من المتصفح: {url}");
    cancel_flag().store(false, Ordering::SeqCst);

    let (s, notify_enabled) = {
        let s = settings.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let n = s.notify;
        (s, n)
    };

    // Field #3: temp watch-listens process audio-only inside the managed
    // page-audio dir — nothing is ever saved to the user folder, and each
    // completion sweeps the previous temp (deleted when no longer wanted).
    let out_dir = if watch {
        page_audio_dir()
    } else {
        dirs::video_dir().unwrap_or_default().join("HaramLite")
    };
    let url_label = url.to_string();
    let name_label = url_label.clone();
    let queued = pending.load(Ordering::SeqCst).saturating_sub(1);
    write_state(&serde_json::json!({
        "running": { "name": name_label, "stage": "download", "pct": 0.0 },
        "queue": queued,
        "last": null
    }));
    // Functional gap: external jobs were invisible to the desktop UI —
    // announce the start so the unified jobs feed can track it.
    let _ = app.emit(
        "bridge-start",
        serde_json::json!({ "name": name_label, "queue": queued }),
    );

    let dl_progress = |p: f32| {
        let _ = app.emit("dl-progress", p.clamp(0.0, 1.0));
        write_state_throttled(&serde_json::json!({
            "running": { "name": name_label, "stage": "download", "pct": p.clamp(0.0, 1.0) },
            "queue": queued,
            "last": null
        }));
        !cancel_flag().load(Ordering::SeqCst)
    };
    if watch {
        tracing::info!(target: "bridge", "watch-temp request: audio-only into {}", out_dir.display());
    }
    let downloaded = if watch {
        crate::yt_dlp::download_audio(url, &out_dir, &dl_progress, &cancel_flag())
    } else {
        crate::yt_dlp::download_media(url, &out_dir, &dl_progress, &cancel_flag())
    };
    match downloaded {
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
                if watch {
                    OutKind::Audio { fmt: crate::pipeline::OutFormat::Mp3 }
                } else {
                    OutKind::Video { max_height: None }
                },
                if watch { false } else { s.keep_instrumental },
                true,
                s.cuda,
                None,
                &|p| {
                    let _ = app.emit("sep-progress", p.clamp(0.0, 1.0));
                    !cancel_flag().load(Ordering::SeqCst)
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
                    // Functional gap: a finished URL stayed in SEEN forever,
                    // so an intentional re-send in the same session was
                    // silently skipped. Dedup now only guards the
                    // running/queued window.
                    forget_seen(url);
                    // In-page watching surface: compact page-audio + kept
                    // ranges (the page maps its clock through them so song
                    // outputs with mirrored silence cuts stay in sync).
                    let page_audio = ensure_page_audio(&o);
                    if watch {
                        // Temp listens must not accumulate: keep only this job's file.
                        sweep_page_audio_dir(page_audio.as_deref());
                    }
                    write_state(&serde_json::json!({
                        "running": null,
                        "queue": 0,
                        "last": { "name": out_name, "ok": true, "seconds": o.seconds,
                                  "vocals": o.vocals.as_ref().map(|p| p.to_string_lossy().into_owned()),
                                  "video": o.video.as_ref().map(|p| p.to_string_lossy().into_owned()),
                                  "page_audio": page_audio.as_ref().map(|p| p.to_string_lossy().into_owned()),
                                  "kept": o.kept_ranges.clone(),
                                  // The requesting page URL: the extension matches
                                  // completions by video identity (output names
                                  // derive from titles, not ids — name-matching
                                  // would misfire). Old states lack it: None.
                                  "url": url }
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
                    // The downloaded source was app-fetched cache, not user
                    // data — drop it now that real outputs exist (it used to
                    // pile up next to every processed video forever).
                    let mut outs: Vec<PathBuf> = Vec::new();
                    for slot in [&o.vocals, &o.instrumental, &o.video] {
                        if let Some(p) = slot {
                            outs.push(p.clone());
                        }
                    }
                    if should_remove_bridge_source(&file, &out_dir, &outs) {
                        match std::fs::remove_file(&file) {
                            Ok(()) => tracing::info!(target: "bridge", "حُذف المصدر المؤقت بعد نجاح المعالجة: {}", file.display()),
                            // Watch-temp jobs run the sweep a few lines above, which
                            // already deleted this file (page-audio holds one file
                            // only) — a second delete is not an error, and warning
                            // about it was pure log noise on every watch job
                            // (field report, 2026-09-11).
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                                tracing::debug!(target: "bridge", "المصدر المؤقت مُنظَّف مسبقاً: {}", file.display())
                            }
                            Err(e) => tracing::warn!(target: "bridge", "تعذر حذف المصدر المؤقت {}: {e}", file.display()),
                        }
                    }
                }
                Err(e) => {
                    let cancelled = cancel_flag().load(Ordering::SeqCst);
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
            let cancelled = cancel_flag().load(Ordering::SeqCst);
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
    let manifest_path = crate::paths::data_dir()
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

/// All native-messaging registry locations we manage (Chrome group + Firefox).
pub fn registry_targets() -> [&'static str; 4] {
    [
        r"Software\Google\Chrome\NativeMessagingHosts",
        r"Software\Chromium\NativeMessagingHosts",
        r"Software\Microsoft\Edge\NativeMessagingHosts",
        r"Software\Mozilla\NativeMessagingHosts",
    ]
}

/// Manifest location under any app-data base (pure — unit-tested).
/// Production passes the Tauri app-data dir (same dir `register` writes).
pub fn manifest_path_for(base: &Path) -> PathBuf {
    base.join("native-host").join(format!("{HOST_NAME}.json"))
}

/// Pure comparison: does a registry default value point at our manifest?
/// (`None` = missing/unreadable key — never counts as registered.)
pub fn is_subkey_match(actual: Option<&str>, expected_manifest: &str) -> bool {
    matches!(actual, Some(v) if v == expected_manifest)
}

/// Live integration status: the manifest must exist AND at least one
/// registry subkey must point at it. Either half missing → disabled.
/// (Reads the real HKCU — runtime only; tests cover the pure pieces.)
pub fn is_registered(app: &tauri::AppHandle) -> bool {
    let _ = app;
    let base = crate::paths::data_dir();
    let manifest = manifest_path_for(&base);
    if !manifest.is_file() {
        return false;
    }
    let expected = manifest.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for t in registry_targets() {
            let sub = format!("{t}\\{HOST_NAME}");
            if let Ok(key) = hkcu.open_subkey(&sub) {
                let actual: Result<String, _> = key.get_value("");
                if is_subkey_match(actual.as_deref().ok(), &expected) {
                    return true;
                }
            }
        }
        return false;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = expected;
        // Non-Windows hosts have no registry: manifest presence is the status.
        true
    }
}

/// Disable integration: remove every registry subkey we manage (missing is
/// fine) and delete the host manifest so startup self-heal stays quiet.
/// Mirror of `register` — the checkbox-off path.
pub fn unregister(app: &tauri::AppHandle) -> Result<String, String> {
    let _ = app; // the data dir is resolved globally now (paths::data_dir)
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for t in registry_targets() {
            let sub = format!("{t}\\{HOST_NAME}");
            // Best-effort: absent keys and legacy values simply vanish.
            if let Ok((parent, _)) = hkcu.create_subkey(t) {
                let _ = parent.delete_value(HOST_NAME);
            }
            let _ = hkcu.delete_subkey(&sub);
        }
    }
    let base = crate::paths::data_dir();
    let manifest = manifest_path_for(&base);
    if manifest.is_file() {
        std::fs::remove_file(&manifest).map_err(|e| e.to_string())?;
    }
    Ok("أُوقف التكامل مع المتصفح — أُزيلت المفاتيح والمانيفست ✓".into())
}

pub fn register(app: &tauri::AppHandle, browser: &str) -> Result<String, String> {
    let _ = app;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let base = crate::paths::data_dir();
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize tests: they mutate the shared `HARAMLITE_DATA_DIR` env,
    /// the global `SEEN` set and the global cancel flag. The lock is shared
    /// crate-wide (paths::test_lock) because the *pipeline* lock file lives
    /// under the same resolved data dir — see paths.rs.
    fn test_serial() -> &'static std::sync::Mutex<()> {
        crate::paths::test_lock()
    }

    fn nanos() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    fn isolated_base(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("hl_bridge_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("com.harammute.haramlite").join("requests")).unwrap();
        std::env::set_var("HARAMLITE_DATA_DIR", &base);
        base
    }

    fn teardown(base: &Path) {
        std::env::remove_var("HARAMLITE_DATA_DIR");
        cancel_flag().store(false, Ordering::SeqCst);
        let _ = std::fs::remove_dir_all(base);
    }

    fn ctx_with() -> (DispatchCtx, Arc<AtomicUsize>) {
        let (tx, rx) = mpsc::channel::<Job>();
        let pending = Arc::new(AtomicUsize::new(0));
        let ctx = DispatchCtx {
            job_tx: tx,
            job_rx: Arc::new(Mutex::new(rx)),
            pending: pending.clone(),
        };
        (ctx, pending)
    }

    fn write_req(name: &str, body: &str) -> PathBuf {
        let p = requests_dir().join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn duplicate_link_removed_and_queued_once() {
        let _guard = test_serial().lock().unwrap_or_else(|p| p.into_inner());
        let base = isolated_base("dup");
        let (ctx, pending) = ctx_with();
        let url = format!("https://example.invalid/dup_{}", nanos());

        // first delivery → queued, file gone
        let p1 = write_req("req_1.json", &format!(r#"{{"type":"link","url":"{url}"}}"#));
        dispatch_file(&p1, &ctx);
        assert!(!p1.exists(), "first request file must be removed");
        assert_eq!(pending.load(Ordering::SeqCst), 1);
        let got = ctx
            .job_rx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .try_recv()
            .expect("job must be queued");
        assert_eq!(got, Job { url: url.clone(), watch: false });
        // re-queue it so the SECOND delivery is genuinely a duplicate
        ctx.pending.fetch_add(1, Ordering::SeqCst);
        let _ = ctx.job_tx.send(Job { url: url.clone(), watch: false });

        // second delivery of the same URL → skipped AND removed (no 5s loop)
        let p2 = write_req("req_2.json", &format!(r#"{{"type":"link","url":"{url}"}}"#));
        dispatch_file(&p2, &ctx);
        assert!(!p2.exists(), "duplicate request file must be removed, not re-logged forever");
        // drain the re-queued job for a clean slate
        let guard = ctx.job_rx.lock().unwrap_or_else(|p| p.into_inner());
        while guard.try_recv().is_ok() {}
        drop(guard);
        teardown(&base);
    }

    /// Field #3: only an explicit `"watch"` mode takes the temp path —
    /// missing/garbage modes stay full-save (both directions compatible).
    #[test]
    fn watch_mode_parses_explicit_only() {
        use serde_json::json;
        assert!(job_watch_of(&json!({ "type": "link", "mode": "watch" })));
        assert!(!job_watch_of(&json!({ "type": "link" })));
        assert!(!job_watch_of(&json!({ "type": "link", "mode": "full" })));
        assert!(!job_watch_of(&json!({ "type": "link", "mode": "" })));
        assert!(!job_watch_of(&json!({ "type": "link", "mode": 7 })));
        assert!(!job_watch_of(&json!({})));
    }

    /// Field #3: a watch-mode request file queues a temp job (flag survives
    /// dispatch); a modeless file queues full-save.
    #[test]
    fn watch_request_dispatches_temp_job() {
        let _guard = test_serial().lock().unwrap_or_else(|p| p.into_inner());
        let base = isolated_base("watchmode");
        let (ctx, _pending) = ctx_with();
        let url = format!("https://example.invalid/watch_{}", nanos());
        let p1 = write_req("req_watch.json", &format!(r#"{{"type":"link","url":"{url}","mode":"watch"}}"#));
        dispatch_file(&p1, &ctx);
        let got = ctx
            .job_rx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .try_recv()
            .expect("watch job must be queued");
        assert_eq!(got, Job { url: url.clone(), watch: true });
        let p2 = write_req("req_full.json", &format!(r#"{{"type":"link","url":"{url}x"}}"#));
        dispatch_file(&p2, &ctx);
        let got2 = ctx
            .job_rx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .try_recv()
            .expect("full job must be queued");
        assert!(!got2.watch);
        teardown(&base);
    }

    #[test]
    fn empty_and_garbage_files_removed() {
        let _guard = test_serial().lock().unwrap_or_else(|p| p.into_inner());
        let base = isolated_base("poison");
        let (ctx, pending) = ctx_with();

        let p1 = write_req("req_empty.json", r#"{"type":"link","url":""}"#);
        dispatch_file(&p1, &ctx);
        assert!(!p1.exists(), "empty-url file must be removed");

        let p2 = write_req("req_garbage.json", "not json {{{");
        dispatch_file(&p2, &ctx);
        assert!(!p2.exists(), "unparseable file must be removed");

        let p3 = write_req("req_blank.json", "   \n");
        dispatch_file(&p3, &ctx);
        assert!(!p3.exists(), "blank file must be removed");

        assert_eq!(pending.load(Ordering::SeqCst), 0);
        teardown(&base);
    }

    #[test]
    fn cancel_removes_file_drains_queue_zeroes_pending() {
        let _guard = test_serial().lock().unwrap_or_else(|p| p.into_inner());
        let base = isolated_base("cancel");
        let (ctx, pending) = ctx_with();

        for i in 0..2 {
            let url = format!("https://example.invalid/c_{}_{}", nanos(), i);
            let p = write_req(&format!("req_q{i}.json"), &format!(r#"{{"type":"link","url":"{url}"}}"#));
            dispatch_file(&p, &ctx);
        }
        assert_eq!(pending.load(Ordering::SeqCst), 2);

        let pc = write_req("cancel_x.json", r#"{"type":"cancel"}"#);
        dispatch_file(&pc, &ctx);
        assert!(!pc.exists(), "cancel file must be removed");
        assert_eq!(pending.load(Ordering::SeqCst), 0);
        assert!(
            ctx.job_rx
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .try_recv()
                .is_err(),
            "queue must be drained"
        );
        teardown(&base);
    }

    #[test]
    fn bridge_source_removal_rules() {
        let _guard = test_serial().lock().unwrap_or_else(|p| p.into_inner());
        let base = isolated_base("rm-src");
        let out_dir = requests_dir().join("HaramLite");
        std::fs::create_dir_all(&out_dir).unwrap();
        let src = out_dir.join("song.mp4");
        std::fs::write(&src, b"raw").unwrap();
        let vid = out_dir.join("song_(Clean)_haramlite.mp4");
        std::fs::write(&vid, b"clean").unwrap();

        assert!(should_remove_bridge_source(&src, &out_dir, &[vid.clone()]));
        // same file / no outputs / missing output → keep
        assert!(!should_remove_bridge_source(&src, &out_dir, &[src.clone()]));
        assert!(!should_remove_bridge_source(&src, &out_dir, &[]));
        assert!(!should_remove_bridge_source(&src, &out_dir, &[out_dir.join("gone.mp4")]));
        // outside our managed folder → never touch (user files)
        let elsewhere = base.join("other.mp4");
        std::fs::write(&elsewhere, b"x").unwrap();
        assert!(!should_remove_bridge_source(&elsewhere, &out_dir, &[vid]));
        teardown(&base);
    }

    #[test]
    fn cold_start_grace_keeps_fresh_drops_with_zero_grace() {
        let _guard = test_serial().lock().unwrap_or_else(|p| p.into_inner());
        let base = isolated_base("grace");
        let dir = requests_dir();

        let fresh = dir.join("req_fresh.json");
        std::fs::write(&fresh, r#"{"type":"link","url":"https://example.invalid/fresh"}"#).unwrap();
        // `now` AFTER the write: the file must date at-or-before it.
        let now = std::time::SystemTime::now();
        clear_stale_requests(&dir, now, 3600);
        assert!(fresh.exists(), "fresh request must survive startup cleanup");

        clear_stale_requests(&dir, now, 0);
        assert!(!fresh.exists(), "with zero grace the file is stale and must go");
        teardown(&base);
    }

    #[test]
    fn status_helpers_are_pure_and_honest() {
        // Manifest location composes under any base (production passes the
        // Tauri app-data dir — same dir `register` writes).
        let p = manifest_path_for(Path::new(r"C:\base"));
        assert_eq!(p.file_name().and_then(|n| n.to_str()), Some("com.harammute.haramlite.json"));
        assert!(p.to_string_lossy().contains("native-host"));
        // Four managed locations, stable order for logs.
        assert_eq!(registry_targets().len(), 4);
        // Only an exact match counts — missing/foreign never does.
        assert!(is_subkey_match(Some(r"C:\a\com.harammute.haramlite.json"), r"C:\a\com.harammute.haramlite.json"));
        assert!(!is_subkey_match(None, r"C:\a\com.harammute.haramlite.json"));
        assert!(!is_subkey_match(Some(r"C:\other\host.json"), r"C:\a\com.harammute.haramlite.json"));
        assert!(!is_subkey_match(Some(""), r"C:\a\com.harammute.haramlite.json"));
    }

    /// Decision 3: page-audio slices are offset-clamped, hex-encoded and
    /// flagged done exactly at the end; oversized requests clamp to the cap.
    #[test]
    fn page_slices_clamp_encode_and_flag_done() {
        let bytes: Vec<u8> = (0..1024u32).map(|i| (i % 251) as u8).collect();
        let (off, hex, done) = slice_bytes(&bytes, 100, 64);
        assert_eq!(off, 100);
        assert!(!done);
        assert_eq!(hex.len(), 128);
        // hex round-trips byte-exact.
        let back: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        assert_eq!(back, bytes[100..164]);
        // Past-end offset clamps to total and reports done with empty data.
        let (off2, hex2, done2) = slice_bytes(&bytes, 99999, 64);
        assert_eq!((off2, done2), (1024, true));
        assert!(hex2.is_empty());
        // Oversized length clamps to PAGE_SLICE_MAX, staying far under 1MB.
        let big = vec![0xABu8; PAGE_SLICE_MAX + 1000];
        let (_, hex3, done3) = slice_bytes(&big, 0, big.len());
        assert_eq!(hex3.len(), PAGE_SLICE_MAX * 2);
        assert!(!done3, "clamped end stops before total");
        assert!(hex3.len() < 1_000_000);
    }

    /// Decision 3: with no outputs at all there is simply no page-audio
    /// (watching unavailable) — never an error, never a invented path.
    #[test]
    fn page_audio_absent_without_outputs() {
        let o = crate::pipeline::PipelineOutput {
            vocals: None,
            instrumental: None,
            video: None,
            kept_ranges: Vec::new(),
            seconds: 0.0,
        };
        assert!(ensure_page_audio(&o).is_none());
    }

    /// The completion URL is readable when present and unknown otherwise —
    /// old states (no url field), failures and garbage never match.
    #[test]
    fn completion_url_reads_exact_or_unknown() {
        use serde_json::json;
        assert_eq!(
            job_url_of(&json!({ "url": "https://www.youtube.com/watch?v=abc123" })),
            Some("https://www.youtube.com/watch?v=abc123")
        );
        assert_eq!(job_url_of(&json!({ "name": "x", "ok": true })), None);
        assert_eq!(job_url_of(&json!({ "url": "" })), None);
        assert_eq!(job_url_of(&json!({ "url": 7 })), None);
        assert_eq!(job_url_of(&json!({})), None);
    }
}

