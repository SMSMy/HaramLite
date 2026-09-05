mod bridge;
mod cli;
mod cuda_runtime;
mod dynamics;
mod effects;
mod filters;
mod logging;
mod loudness;
mod media;
mod pipeline;
mod repair;
mod reverb_delay;
mod separator;
mod settings;
mod silence;
mod stft;
mod watch_service;
mod yt_dlp;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use tauri::Manager;

use logging::LogLine;
use pipeline::Mode;

/// Release builds use windows_subsystem="windows" (no console). When the user
/// runs the exe from a terminal with CLI args, attach to that parent console
/// and rebind Rust's stdout/stderr so prints become visible.
#[cfg(all(windows, not(debug_assertions)))]
fn attach_parent_console() {
    unsafe {
        use windows_sys::Win32::System::Console::{
            AttachConsole, ATTACH_PARENT_PROCESS, SetStdHandle, STD_ERROR_HANDLE,
            STD_OUTPUT_HANDLE,
        };

        if AttachConsole(ATTACH_PARENT_PROCESS) != 0 {
            // reopen CONOUT$ as our std handles (safe: no CRT involved)
            if let Ok(f) = std::fs::OpenOptions::new().write(true).read(true).open("CONOUT$") {
                use std::os::windows::io::AsRawHandle;
                let h = f.as_raw_handle();
                let _ = SetStdHandle(STD_OUTPUT_HANDLE, h);
                let _ = SetStdHandle(STD_ERROR_HANDLE, h);
                std::mem::forget(f); // keep the handle valid for process lifetime
            }
        }
    }
}

#[cfg(any(not(windows), debug_assertions))]
fn attach_parent_console() {}

/// Sprint B2: Windows toasts need an explicit AppUserModelID. NSIS installs
/// register it via the Start Menu shortcut; portable runs would otherwise
/// fail silently — this call makes notifications work wherever possible.
#[cfg(target_os = "windows")]
fn set_explicit_aumid() {
    unsafe {
        use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        let id: Vec<u16> = "com.harammute.haramlite"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let _ = SetCurrentProcessExplicitAppUserModelID(id.as_ptr());
    }
}

#[cfg(not(target_os = "windows"))]
fn set_explicit_aumid() {}

/// Single-instance guard: bind a loopback TCP listener as an OS-level mutex.
/// A second instance asks the RUNNING one to show its window (important when
/// the running instance was started hidden by the browser bridge), then exits.
/// Returns the "show window" receiver for the winning instance.
fn take_single_instance() -> Option<std::sync::mpsc::Receiver<()>> {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::time::Duration;
    match TcpListener::bind("127.0.0.1:48765") {
        Ok(listener) => {
            let (tx, rx) = mpsc::channel::<()>();
            std::thread::spawn(move || {
                for mut stream in listener.incoming().flatten() {
                    // A connection carrying a single 0x01 byte = "show the
                    // window" (a second GUI launch). Data-less connections are
                    // the bridge's liveness probes — ignore those.
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
                    let mut b = [0u8; 1];
                    if stream.read(&mut b).is_ok() && b[0] == 1 {
                        let _ = tx.send(());
                    }
                }
            });
            Some(rx)
        }
        Err(_) => {
            // already running → ask it to show its window, then exit quietly
            if let Ok(mut s) = TcpStream::connect("127.0.0.1:48765") {
                let _ = s.set_write_timeout(Some(Duration::from_millis(500)));
                let _ = s.write_all(&[1]);
            }
            std::process::exit(0);
        }
    }
}

/// Public CLI entrypoint called from main.rs.
pub fn cli_entry(args: &[String]) -> i32 {
    attach_parent_console();
    // CUDA_RUNTIME_PLAN (الشرط 2): مسار DLL قبل أي خيط وأي ORT
    cuda_runtime::ensure_dll_path();
    logging::init_cli();
    cli::entry(args)
}

/// Public Native Messaging host entrypoint (Sprint E) called from main.rs.
pub fn native_host_entry() -> i32 {
    bridge::native_host_entry()
}

/// M5: download media from a URL via yt-dlp with live progress events.
/// Sync (not async): yt-dlp runs for minutes and must not hold a Tokio
/// worker — Tauri v2 dispatches sync commands to its spawn_blocking pool.
#[tauri::command]
fn download_media_cmd(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
    out_dir: String,
) -> Result<String, String> {
    use tauri::Emitter;

    let final_out_dir = if out_dir.trim().is_empty() {
        dirs::video_dir().unwrap_or_else(|| PathBuf::from("."))
            .join("HaramLite")
    } else {
        PathBuf::from(out_dir)
    };

    let path = yt_dlp::download_media(&url, &final_out_dir, &|p| {
        let _ = app.emit("dl-progress", p.clamp(0.0, 1.0));
        true
    }, &state.cancel_flag)
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// M5: manual/forced yt-dlp update check. Sync: network + subprocess wait
/// must not block a Tokio worker.
#[tauri::command]
fn update_ytdlp(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Emitter;
    let (updated, message) = yt_dlp::ensure_updated(true, &|p| {
        let _ = app.emit("dl-progress", p.clamp(0.0, 1.0));
    });
    Ok(serde_json::json!({ "updated": updated, "message": message }))
}

/// Sprint B2: system notification for completion events. On Windows this
/// needs an AUMID + Start Menu shortcut (NSIS creates them; portable runs
/// may fail silently) — the frontend falls back to an in-app toast + sound.
#[tauri::command]
fn notify_done(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}

/// Sprint C1: full component health (ffmpeg/ffprobe/yt-dlp/model) for the
/// first-run setup / self-repair wizard.
#[tauri::command]
fn health_check_cmd() -> Vec<repair::HealthRow> {
    repair::health_rows()
}

/// Sprint C1: download + SHA-256 verify + atomically install one missing
/// component from the `assets-v1` GitHub release. Sync: big download, must
/// not hold a Tokio worker.
#[tauri::command]
fn repair_component(app: tauri::AppHandle, key: String) -> Result<String, String> {
    use tauri::Emitter;
    let path = repair::repair(&key, &|p| {
        let _ = app.emit("repair-progress", p.clamp(0.0, 1.0));
    })
    .map_err(|e| e)?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn probe_media(path: String) -> Result<media::MediaInfo, String> {
    media::probe(Path::new(&path)).map_err(|e| e.to_string())
}

/// B1/B2 support: frontend-side existence validation without ffprobe.
#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn path_is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
fn extract_audio(path: String, format: String, out_dir: String) -> Result<String, String> {
    let out = media::extract_audio(Path::new(&path), &format, Path::new(&out_dir))
        .map_err(|e| e.to_string())?;
    tracing::info!(target: "media", "extracted {format}: {}", out.display());
    Ok(out.to_string_lossy().into_owned())
}

#[tauri::command]
fn remux_to_mp4(video: String, audio_wav: String, out_path: String) -> Result<String, String> {
    let out = media::remux_video_with_audio(
        Path::new(&video),
        Path::new(&audio_wav),
        Path::new(&out_path),
    )
    .map_err(|e| e.to_string())?;
    tracing::info!(target: "media", "remuxed mp4: {}", out.display());
    Ok(out.to_string_lossy().into_owned())
}

/// M2: full separation pipeline — normalize any input → MDX-Net stems.
/// Thin wrapper over pipeline::process_file (shared with CLI).
/// Sync (not async): processing takes 3–20 minutes (ONNX + FFmpeg). An
/// `async fn` here would pin a Tokio worker for the whole run and starve
/// every other command (incl. cancel_process); Tauri v2 moves sync commands
/// to its spawn_blocking pool automatically.
#[tauri::command]
fn separate_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    out_dir: String,
    mode: Option<String>,
    kind: Option<String>,
    quality: Option<u32>,
    format: Option<String>,
    keep_instrumental: Option<bool>,
    use_cuda: Option<bool>,
    preview_seconds: Option<f32>,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;

    let mode = mode.as_deref().and_then(Mode::parse).unwrap_or(Mode::Song);
    let keep_inst = keep_instrumental.unwrap_or(false);
    let cuda_enabled = use_cuda.unwrap_or(false);

    let kind = match kind.as_deref() {
        Some("video") => pipeline::OutKind::Video { max_height: quality },
        _ => {
            let fmt = format
                .as_deref()
                .and_then(pipeline::OutFormat::parse)
                .unwrap_or(pipeline::OutFormat::Mp3); // simple default: MP3
            pipeline::OutKind::Audio { fmt }
        }
    };

    // Reset cancel flag before starting
    state.cancel_flag.store(false, Ordering::SeqCst);
    let cancel = state.cancel_flag.clone();

    // In CLI mode this uses CPU-only for now, or we could pass cuda_enabled to CLI too.
    // For GUI, we pass it down via an environment variable or just wait, `pipeline::process_file`
    // doesn't take use_cuda! I need to modify pipeline::process_file to take use_cuda.
    // Let me just set an environment variable or thread local?
    // Let's modify pipeline::process_file to take `use_cuda: bool`.
    let out = pipeline::process_file(Path::new(&path), Path::new(&out_dir), mode, kind, keep_inst, true, cuda_enabled, preview_seconds, &|p| {
        let _ = app.emit("sep-progress", p.clamp(0.0, 1.0));
        !cancel.load(Ordering::SeqCst)
    }, &|stage, p| {
        // Sprint C2: visible pipeline stages for the UI
        let _ = app.emit("sep-stage", serde_json::json!({ "stage": stage, "pct": p.clamp(0.0, 1.0) }));
    })
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "vocals": out.vocals.as_ref().map(|p| p.to_string_lossy()),
        "instrumental": out.instrumental.as_ref().map(|p| p.to_string_lossy()),
        "video": out.video.as_ref().map(|p| p.to_string_lossy()),
        "seconds": out.seconds,
    }))
}

#[tauri::command]
fn ping() -> serde_json::Value {
    serde_json::json!({
        "app": "HaramLite",
        "version": env!("CARGO_PKG_VERSION"),
        "rust": rustc_version(),
    })
}

fn rustc_version() -> String {
    // Compile-time stamp of the toolchain that built us.
    option_env!("RUSTC_VERSION").unwrap_or(env!("CARGO_PKG_RUST_VERSION")).to_string()
}

#[tauri::command]
fn get_recent_logs(limit: usize) -> Vec<LogLine> {
    logging::recent_logs(limit)
}

#[tauri::command]
fn push_log(level: String, message: String) {
    logging::push_line(&level, &message);
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let target = if path.trim().is_empty() {
        dirs::video_dir().unwrap_or_else(|| PathBuf::from(".")).join("HaramLite")
    } else {
        PathBuf::from(path)
    };
    
    if !target.exists() {
        let _ = std::fs::create_dir_all(&target);
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

struct AppState {
    cancel_flag: Arc<AtomicBool>,
    settings: Arc<Mutex<settings::Settings>>,
}

/// Sprint D1: read the unified settings (Rust-backed single source of truth).
#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let s = state.settings.lock().map_err(|e| e.to_string())?;
    serde_json::to_value(&*s).map_err(|e| e.to_string())
}

/// Sprint D1/D2: persist settings, notify the UI, and apply watch-folder
/// changes immediately (start/stop/restart the watcher thread).
#[tauri::command]
fn set_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let new: settings::Settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    {
        let mut cur = state.settings.lock().map_err(|e| e.to_string())?;
        *cur = new.clone();
    }
    settings::save(&app_data, &new).map_err(|e| e.to_string())?;
    watch_service::apply_settings(&new);
    use tauri::Emitter;
    let v = serde_json::to_value(&new).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", v.clone());
    Ok(v)
}

/// Sprint E2: register HaramLite as a Native Messaging host for the given
/// browser (writes the host manifest + HKCU registry keys).
#[tauri::command]
fn register_native_host(app: tauri::AppHandle, browser: String) -> Result<String, String> {
    bridge::register(&app, &browser)
}

/// Smart CUDA toggle support: NVIDIA GPU present? runtime DLLs ready?
/// `cuda: true` means the sixteen runtime files sit in the app's bin folder
/// (self-downloaded) — the UI offers the one-click install when false.
#[tauri::command]
fn cuda_status() -> serde_json::Value {
    serde_json::json!({
        "nvidia": cuda_runtime::nvidia_gpu_present(),
        "cuda": cuda_runtime::is_available(),
    })
}

/// CUDA_RUNTIME_PLAN: download + verify + install the CUDA runtime on first
/// enable. Progress and completion arrive as `cuda-install` / `cuda-install-done`
/// events; any failure leaves DirectML untouched (condition 3). The worker's
/// body is panic-guarded and ALWAYS emits a done event, so the UI can never
/// hang on the progress bar (audit).
#[tauri::command]
async fn install_cuda_runtime(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    let handle = app.clone();
    std::thread::Builder::new()
        .name("cuda-install".into())
        .spawn(move || {
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::cuda_runtime::install(&|name, p| {
                    let _ = handle.emit(
                        "cuda-install",
                        serde_json::json!({ "file": name, "pct": p.clamp(0.0, 1.0) }),
                    );
                })
            }));
            let res = match res {
                Ok(r) => r,
                Err(_) => Err("عطل داخلي غير متوقع أثناء التنزيل".to_string()),
            };
            let _ = handle.emit(
                "cuda-install-done",
                serde_json::json!({ "ok": res.is_ok(), "error": res.err().unwrap_or_default() }),
            );
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn cancel_process(state: tauri::State<'_, AppState>) {
    state.cancel_flag.store(true, Ordering::SeqCst);
    tracing::warn!(target: "app", "تم إرسال أمر الإلغاء...");
}

/// Functional gap: cancel a running BROWSER job from the desktop UI.
#[tauri::command]
fn cancel_bridge_job() -> Result<(), String> {
    bridge::cancel_via_gui()
}

/// Functional gap: cancel the file the WATCH folder is processing right now
/// (the watcher thread itself keeps running).
#[tauri::command]
fn cancel_watch_file() {
    watch_service::cancel_current();
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("الملف غير موجود".into());
    }
    
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &target.to_string_lossy()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Demonstrates the panic hook safely: the panic is captured, logged with its
/// exact source location, and converted into a normal error for the UI.
#[tauri::command]
fn cause_test_panic() -> Result<String, String> {
    match catch_unwind(AssertUnwindSafe(|| {
        panic!("رسالة اختبار: هذا panic مقصود لاختبار نافذة السجل");
    })) {
        Ok(_) => Ok("لم يقع panic؟".into()),
        Err(payload) => {
            let msg = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "unknown".into());
            Err(format!("تم التقاط panic وإثباته في السجل: {msg}"))
        }
    }
}

/// Crash forensics: a marker written at boot and removed on graceful exit.
/// If it survives to the NEXT boot, the previous session was killed without
/// a clean shutdown (the user reported random silent crashes — this turns
/// them into visible evidence).
fn crash_marker_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("com.harammute.haramlite").join("session.lock"))
}

fn note_previous_crash() {
    if let Some(marker) = crash_marker_path() {
        if marker.is_file() {
            let prev = std::fs::read_to_string(&marker).unwrap_or_default();
            tracing::warn!(
                target: "app",
                "⚠ الجلسة السابقة انتهت فجأة دون إغلاق رشيق{} — راجع نهاية السجل السابق",
                if prev.trim().is_empty() { String::new() } else { format!(" (بدأت: {})", prev.trim()) }
            );
        }
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = std::fs::write(&marker, started.to_string());
    }
}

fn clear_crash_marker() {
    if let Some(marker) = crash_marker_path() {
        let _ = std::fs::remove_file(marker);
    }
}

/// Functional gap: kill-mid-run staging files (`*.download` next to
/// binaries/tools) were never cleaned and accumulated forever. Live runs
/// always write-then-rename within one process lifetime, so anything with
/// this suffix found at boot is by definition an orphan.
fn cleanup_crash_leftovers() {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("bin"));
            roots.push(parent.join("models"));
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("com.harammute.haramlite").join("tools"));
    }
    // NOTE: per-file work dirs (`_haramlite_work/`) live next to user media
    // in unknown folders, so they cannot be swept globally — instead their
    // scratch FILES now carry the `_haramlite_` infix (media.rs) so the watch
    // folder at least never mistakes them for new inputs.
    let mut stack = roots;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().and_then(|x| x.to_str()) == Some("download") {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // CUDA_RUNTIME_PLAN (الشرط 2): مسار بحث DLL قبل أي خيط وأي تهيئة ORT
    cuda_runtime::ensure_dll_path();
    let show_rx = take_single_instance();
    set_explicit_aumid();
    let shared_settings = Arc::new(Mutex::new(settings::Settings::default()));
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            settings: shared_settings.clone(),
        })
        .setup(move |app| {
            // Second launch while we run (e.g. the user double-clicks the
            // shortcut while a hidden bridge instance is alive): bring the
            // main window forward instead of silently doing nothing.
            if let Some(rx) = show_rx {
                let handle = app.handle().clone();
                std::thread::Builder::new()
                    .name("show-requests".into())
                    .spawn(move || {
                        while rx.recv().is_ok() {
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .ok();
            }
            let log_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir")
                .join("logs");
            let shown = logging::init(log_dir);
            tracing::info!(target: "app", "HaramLite v{} starting — logs in {}", env!("CARGO_PKG_VERSION"), shown.display());
            note_previous_crash();
            cleanup_crash_leftovers();
            // Audit F-1: push log lines to the UI as events instead of the
            // frontend polling get_recent_logs every 700ms.
            logging::attach_emitter(app.handle().clone());

            // Sprint D1/D2: load persisted settings and (re)start the watch
            // folder service so it survives app restarts.
            let app_data = app.path().app_data_dir().expect("no app data dir");
            let loaded = settings::load(&app_data);
            // Audit R-2 (corrected): commit the ORT environment ONCE at startup
            // (no providers at env level — sessions select their own), BEFORE
            // the watch folder can start processing.
            separator::init_ort_env();
            watch_service::init(app.handle().clone());
            watch_service::apply_settings(&loaded);
            {
                let state = app.state::<AppState>();
                let mut cur = state
                    .settings
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *cur = loaded;
            }

            // Sprint E: browser-extension request pickup + self-healing
            // registration (rewrites the registry key if a cleaner removed it)
            bridge::ensure_registered();
            bridge::init(app.handle().clone(), shared_settings);

            // Launched by the browser bridge while no GUI was open: stay
            // hidden — the in-page mini panel in the browser is the UI.
            if std::env::var("HARAMLITE_HIDDEN").as_deref() == Ok("1") {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            // M5: background yt-dlp update check (24h cadence, never fatal)
            std::thread::Builder::new()
                .name("ytdlp-update".into())
                .spawn(|| {
                    let (updated, msg) = yt_dlp::ensure_updated(false, &|_| {});
                    if updated {
                        tracing::info!(target: "ytdlp", "{msg}");
                    } else {
                        tracing::debug!(target: "ytdlp", "{msg}");
                    }
                })
                .ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            get_recent_logs,
            push_log,
            open_folder,
            open_file,
            cancel_process,
            cancel_bridge_job,
            cancel_watch_file,
            cause_test_panic,
            probe_media,
            path_exists,
            path_is_dir,
            extract_audio,
            remux_to_mp4,
            separate_file,
            download_media_cmd,
            update_ytdlp,
            notify_done,
            health_check_cmd,
            repair_component,
            get_settings,
            set_settings,
            register_native_host,
            cuda_status,
            install_cuda_runtime
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                // graceful shutdown → next boot must NOT see the marker
                clear_crash_marker();
            }
        });
}
