mod cli;
mod dynamics;
mod effects;
mod filters;
mod logging;
mod loudness;
mod media;
mod pipeline;
mod reverb_delay;
mod separator;
mod silence;
mod stft;
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

/// Public CLI entrypoint called from main.rs.
pub fn cli_entry(args: &[String]) -> i32 {
    attach_parent_console();
    logging::init_cli();
    cli::entry(args)
}

/// M5: download media from a URL via yt-dlp with live progress events.
#[tauri::command]
async fn download_media_cmd(
    app: tauri::AppHandle,
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
    })
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// M5: manual/forced yt-dlp update check.
#[tauri::command]
async fn update_ytdlp(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Emitter;
    let (updated, message) = yt_dlp::ensure_updated(true, &|p| {
        let _ = app.emit("dl-progress", p.clamp(0.0, 1.0));
    });
    Ok(serde_json::json!({ "updated": updated, "message": message }))
}

#[tauri::command]
async fn probe_media(path: String) -> Result<media::MediaInfo, String> {
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
async fn extract_audio(path: String, format: String, out_dir: String) -> Result<String, String> {
    let out = media::extract_audio(Path::new(&path), &format, Path::new(&out_dir))
        .map_err(|e| e.to_string())?;
    tracing::info!(target: "media", "extracted {format}: {}", out.display());
    Ok(out.to_string_lossy().into_owned())
}

#[tauri::command]
async fn remux_to_mp4(video: String, audio_wav: String, out_path: String) -> Result<String, String> {
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
#[tauri::command]
async fn separate_file(
    app: tauri::AppHandle,
    path: String,
    out_dir: String,
    mode: Option<String>,
    kind: Option<String>,           // "video" | "audio" (simplified UI)
    quality: Option<u32>,           // video height cap (None = same as source)
    format: Option<String>,         // advanced override (audio containers)
    keep_instrumental: Option<bool>,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;

    let mode = mode.as_deref().and_then(Mode::parse).unwrap_or(Mode::Song);
    let keep_inst = keep_instrumental.unwrap_or(false);

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

    let out = pipeline::process_file(Path::new(&path), Path::new(&out_dir), mode, kind, keep_inst, &|p| {
        let _ = app.emit("sep-progress", p.clamp(0.0, 1.0));
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let log_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir")
                .join("logs");
            let shown = logging::init(log_dir);
            tracing::info!(target: "app", "HaramLite v{} starting — logs in {}", env!("CARGO_PKG_VERSION"), shown.display());

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
            cause_test_panic,
            probe_media,
            path_exists,
            path_is_dir,
            extract_audio,
            remux_to_mp4,
            separate_file,
            download_media_cmd,
            update_ytdlp
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
