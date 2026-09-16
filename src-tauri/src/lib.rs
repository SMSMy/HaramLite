mod autostart;
mod atomic;
mod bridge;
mod calibrate;
mod cli;
mod cuda_runtime;
mod decide;
mod dynamics;
mod effects;
mod filters;
mod ipc_guard;
mod livemap;
mod logging;
mod loudness;
mod media;
mod paths;
mod pipeline;
mod player;
mod repair;
mod reverb_delay;
mod scratch;
mod seal;
mod separator;
mod session;
mod settings;
mod silence;
mod stft;
mod telegram;
mod throttle;
mod tray;
mod update_check;
mod v1proto;
mod watch_service;
mod yt_dlp;

// Audit 2026-09-15 (٨): مانيفست comctl32 **v6** لثنائي اختبار المكتبة وحده.
//
// أي اختبار يلمس `watch_service::apply_settings` يسحب `run_watch` → الـpipeline
// → `rfd` (‏`comctl32!TaskDialogIndirect`) إلى هذا الثنائي؛ وبلا مانيفست يطلب
// v6 يُحمَّل v5 الافتراضي فلا يجد الدالة ⇒ الثنائي **لا يُقلع** أصلاً
// (‏`STATUS_ENTRYPOINT_NOT_FOUND / 0xc0000139`) ويسقط `cargo test` كله.
//
// tauri-build يمنح المانيفست لـ bins وحدها (`rustc-link-arg-bins`)، وcargo لا
// يملك تعليمة ربط تخصّ ثنائي اختبار المكتبة وحده (التفصيل والدليل في `build.rs`)
// — فالثنائي يربط هنا مكتبة الموارد التي ولّدها `build.rs` في OUT_DIR، وهي
// تحمل مانيفست v6 نفسه (متحقَّق منه مقابل `test-comctl32.manifest`).
// `#[cfg(test)]` تعني أن الإنتاج وbins لا يتغيّران.
#[cfg(test)]
#[link(name = "resource", kind = "static")]
extern "C" {}

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

/// و-٤: الرمز الفعلي لهذه الجلسة، مع تطبيع عبر الملف.
///
/// التوليد يقع في `load_or_create_nonce`، والكتابة **قبل** ربط المنفذ: لو
/// رُبط أولاً لتسابق اتصالٌ وصولَ الرمز إلى الملف.
fn session_nonce(base: &Path) -> Vec<u8> {
    let n = ipc_guard::load_or_create_nonce(base);
    ipc_guard::effective_nonce(base, &n)
}

/// Single-instance guard: bind a loopback TCP listener as an OS-level mutex.
/// A second instance asks the RUNNING one to show its window (important when
/// the running instance was started hidden by the browser bridge), then exits.
///
/// و-٤: الطلب لم يبقَ «بايت واحد» — بل بادئة `HLSI` + رمز الجلسة المخزَّن في
/// `paths::data_dir()`. الاتصال بغير الرمز **يُرفض بصمت** (بايت الرفض بلا
/// إظهار نافذة). الحدّ المتبقّي منصوص في `ipc_guard`: من يقرأ الملف بنفس
/// صلاحية المستخدم يعرف الرمز، والأثر الأقصى يبقى «إظهار نافذة».
fn take_single_instance() -> Option<std::sync::mpsc::Receiver<()>> {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::time::Duration;
    match TcpListener::bind("127.0.0.1:48765") {
        Ok(listener) => {
            let (tx, rx) = mpsc::channel::<()>();
            // الرمز قبل أول اتصال ممكن؛ فشل الكتابة لا يمنع الجلسة.
            let nonce = session_nonce(&paths::data_dir());
            std::thread::spawn(move || {
                // Audit 2026-09-15 (٤.ج): كان `incoming().flatten()` يُسقط أخطاء
                // `accept` بصمت — وعند فشل دائم (استنفاد مقابض مثلاً) تدور الحلقة
                // بلا نوم فتلهب نواة كاملة إلى الأبد. الآن يُعدّ الخطأ المتتابع:
                // الخطأ الأول يمر فوراً (عابر لا يستحق تأخيراً)، ومن الثاني نوم
                // 250ms × عدد الأخطاء بسقف 20 خطأ ⇒ 5 ثوانٍ. الحدّ 20 محاولة
                // يجعل أسوأ حالة 12 محاولة في الدقيقة بدل دوران مشغول، ويبقى
                // الاستئناف فورياً (لا تضخيم أسّي) فالاتصال الشرعي التالي يُقبل
                // بلا تأخير ملموس. العدّاد يُصفَّر عند أول اتصال ناجح.
                //
                // و-٤: البروتوكول تغيّر — كان بايتاً واحداً `0x01` يقبله أي
                // ضيف؛ الآن `HLSI` + الرمز، ولا إظهار إلا للمطابق.
                let mut consec_err: u32 = 0;
                loop {
                    let mut stream = match listener.accept() {
                        Ok((s, _)) => {
                            consec_err = 0;
                            s
                        }
                        Err(_) => {
                            consec_err = consec_err.saturating_add(1);
                            if consec_err > 1 {
                                let backoff =
                                    Duration::from_millis(250 * u64::from(consec_err.min(20)));
                                std::thread::sleep(backoff);
                            }
                            continue;
                        }
                    };
                    // نبضة الجسر (اتصال بلا بيانات) تُقرأ بصفر بايتات؛ الطلب
                    // الحقيقي يحمل البادئة والرمز. الردّ بايت واحد يخبر
                    // المرسل هل أُظهرت النافذة — ومن رُفض يخرج بصمت.
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
                    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
                    let mut buf = [0u8; ipc_guard::WIRE_MAGIC.len() + ipc_guard::NONCE_BYTES];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let accepted = ipc_guard::authentic_request(&nonce, &buf[..n]);
                    let _ = stream.write_all(&[if accepted {
                        ipc_guard::ACCEPT_BYTE
                    } else {
                        ipc_guard::REJECT_BYTE
                    }]);
                    if accepted {
                        let _ = tx.send(());
                    }
                }
            });
            Some(rx)
        }
        Err(_) => {
            // already running → ask it to show its window, then exit quietly
            if let Some(nonce) = ipc_guard::load_nonce(&paths::data_dir()) {
                if let Ok(mut s) = TcpStream::connect("127.0.0.1:48765") {
                    let _ = s.set_write_timeout(Some(Duration::from_millis(500)));
                    let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
                    // غير مصادَق ⇒ لا شيء في الجلسة القائمة، ونحن نخرج كما كنا.
                    let _ = s.write_all(&ipc_guard::request_bytes(&nonce));
                    let mut ack = [0u8; 1];
                    let _ = s.read(&mut ack);
                }
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
///
/// P1 ROOT CAUSE (proven from tauri 2.11.5 source, owner-verified): SYNC
/// commands run INLINE on the main loop thread (on_message →
/// run_invoke_handler, no automatic transfer in 2.11.5) — the old comment
/// claiming an automatic spawn_blocking pool was WRONG and is corrected
/// here. A minutes-long body wedges paint+input (black + Not Responding)
/// while renderer timers keep ticking (hence the silent detector). Heavy
/// commands therefore go async + INTERNAL spawn_blocking; emits and cancel
/// flags keep working from the worker (AppHandle/Arc are shareable). The
/// frontend promise contract is unchanged.
#[tauri::command]
async fn download_media_cmd(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
    out_dir: String,
) -> Result<String, String> {
    let cancel = state.cancel_flag.clone();
    let downloaded = state.downloaded.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;

        let final_out_dir = if out_dir.trim().is_empty() {
            dirs::video_dir().unwrap_or_else(|| PathBuf::from("."))
                .join("HaramLite")
        } else {
            PathBuf::from(out_dir)
        };

        let path = yt_dlp::download_media(&url, &final_out_dir, &|p| {
            // P1: ≤4Hz channel — source rate is whatever yt-dlp does on this
            // pipe (measured 1.4 lines/s slow, unknowable fast); the UI paints
            // per frame at most, so anything above 4Hz was pure IPC load.
            if throttle::emit_4hz().allow("dl-progress") {
                let _ = app.emit("dl-progress", p.clamp(0.0, 1.0));
            }
            true
        }, &cancel)
        .map_err(|e| e.to_string())?;
        tracing::info!(target: "ytdlp", "program-path download finished ({})", throttle::emit_4hz().report("dl-progress"));
        // P2: remember auto-fetched sources so a later successful separation can
        // drop them (bridge rule, literally). User files never enter this set.
        remember_downloaded(&downloaded, &path);
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("download worker failed: {e}"))?
}

/// M5: manual/forced yt-dlp update check. Async + internal spawn_blocking
/// (P1: network + subprocess wait must never sit on the main loop thread).
#[tauri::command]
async fn update_ytdlp(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let (updated, message) = yt_dlp::ensure_updated(true, &|p| {
            let _ = app.emit("dl-progress", p.clamp(0.0, 1.0));
        });
        Ok(serde_json::json!({ "updated": updated, "message": message }))
    })
    .await
    .map_err(|e| format!("update worker failed: {e}"))?
}

/// ق-١: إصدار yt-dlp المحلي، من `local_version()` نفسها التي يحكم بها
/// `ensure_updated` على «محدّث بالفعل» — فلا يظهر في الإعدادات رقم يخالف ما
/// يقرّره المحدِّث. `None` تعني: لا نسخة محلية (تُشرح في الواجهة) أو تعذّر
/// تشغيل `--version`؛ والواجهة لا تدّعي إصداراً في الحالتين.
#[tauri::command]
fn ytdlp_local_version() -> Option<String> {
    yt_dlp::local_version()
}

/// هـ.١/هـ.٤: فحص الإصدار من `releases/latest` على GitHub (بلا توقيع وبلا
/// `latest.json`). إصدار التطبيق الحالي يُقرأ من الحزمة نفسها —
/// `package_info().version`، أي `tauri.conf.json` — لا من سلسلة مكتوبة بيد،
/// فإصدار مُزوَّر في الإعداد يكفي لاختبار «إصدار أقدم يكتشف الأحدث» (هـ.٣).
/// `force=true` (زرّ الإعدادات) ينادي GitHub دائماً، و`force=false` (الإقلاع)
/// يقرأ كاش ٢٤ ساعة أولاً فلا نداء لكل إقلاع. Async + spawn_blocking كبقية
/// أوامر الشبكة (P1: نداء الشبكة لا يجلس على خيط الحلقة الرئيسية).
#[tauri::command]
async fn check_update(app: tauri::AppHandle, force: bool) -> Result<update_check::UpdateStatus, String> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || update_check::check(&current, force))
        .await
        .map_err(|e| format!("update worker failed: {e}"))
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
/// component from the `assets-v1` GitHub release. Async + internal
/// spawn_blocking (P1: big download must never sit on the main loop thread).
#[tauri::command]
async fn repair_component(app: tauri::AppHandle, key: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let path = repair::repair(&key, &|p| {
            let _ = app.emit("repair-progress", p.clamp(0.0, 1.0));
        })?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|e| format!("repair worker failed: {e}"))?
}

#[tauri::command]
async fn probe_media(path: String) -> Result<media::MediaInfo, String> {
    // P1: ffprobe subprocess wait leaves the main loop thread.
    tauri::async_runtime::spawn_blocking(move || {
        media::probe(Path::new(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("probe worker failed: {e}"))?
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
    // P1: ffmpeg subprocess wait leaves the main loop thread.
    tauri::async_runtime::spawn_blocking(move || {
        let out = media::extract_audio(Path::new(&path), &format, Path::new(&out_dir))
            .map_err(|e| e.to_string())?;
        tracing::info!(target: "media", "extracted {format}: {}", out.display());
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("extract worker failed: {e}"))?
}

#[tauri::command]
async fn remux_to_mp4(video: String, audio_wav: String, out_path: String) -> Result<String, String> {
    // P1: ffmpeg subprocess wait leaves the main loop thread.
    tauri::async_runtime::spawn_blocking(move || {
        let out = media::remux_video_with_audio(
            Path::new(&video),
            Path::new(&audio_wav),
            Path::new(&out_path),
        )
        .map_err(|e| e.to_string())?;
        tracing::info!(target: "media", "remuxed mp4: {}", out.display());
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("remux worker failed: {e}"))?
}

/// M2: full separation pipeline — normalize any input → MDX-Net stems.
/// Thin wrapper over pipeline::process_file (shared with CLI).
///
/// P1 ROOT CAUSE (same as download_media_cmd): this body runs 3–20 minutes
/// (ONNX + FFmpeg) and as a SYNC command sat INLINE on the main loop thread
/// — every click during a run queued behind it (black + Not Responding) while
/// renderer timers kept ticking. Now async + INTERNAL spawn_blocking; the
/// cancel flag is reset up front on the fast path, and emits keep flowing
/// from the worker. Frontend promise contract unchanged.
#[tauri::command]
async fn separate_file(
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
    // Reset cancel flag before starting (fast path — never blocked).
    state.cancel_flag.store(false, Ordering::SeqCst);
    let cancel = state.cancel_flag.clone();
    let downloaded = state.downloaded.clone();
    tauri::async_runtime::spawn_blocking(move || {
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

        let out = pipeline::process_file(Path::new(&path), Path::new(&out_dir), mode, kind, keep_inst, true, cuda_enabled, preview_seconds, &|p| {
            if throttle::emit_4hz().allow("sep-progress") {
                let _ = app.emit("sep-progress", p.clamp(0.0, 1.0));
            }
            !cancel.load(Ordering::SeqCst)
        }, &|stage, p| {
            // Sprint C2: visible pipeline stages for the UI
            if throttle::emit_4hz().allow("sep-stage") {
                let _ = app.emit("sep-stage", serde_json::json!({ "stage": stage, "pct": p.clamp(0.0, 1.0) }));
            }
        })
        .map_err(|e| e.to_string())?;
        tracing::info!(target: "pipe", "program-path separate finished ({}; {})",
            throttle::emit_4hz().report("sep-progress"), throttle::emit_4hz().report("sep-stage"));

        // P2: drop auto-fetched sources after SUCCESS only — the bridge rule,
        // literally: same folder + real outputs exist + no output IS the source.
        // User files are never tracked, so they can never match.
        let mut outs: Vec<PathBuf> = Vec::new();
        for p in [&out.vocals, &out.instrumental, &out.video].into_iter().flatten() {
            outs.push(p.clone());
        }
        let src = Path::new(&path);
        if take_tracked_download(&downloaded, src)
            && bridge::should_remove_bridge_source(src, Path::new(&out_dir), &outs)
        {
            match std::fs::remove_file(src) {
                Ok(()) => tracing::info!(target: "app", "حُذف المصدر المنزّل بعد نجاح المعالجة: {}", src.display()),
                Err(e) => tracing::warn!(target: "app", "تعذر حذف المصدر المنزّل {}: {e}", src.display()),
            }
        }

        Ok(serde_json::json!({
            "vocals": out.vocals.as_ref().map(|p| p.to_string_lossy()),
            "instrumental": out.instrumental.as_ref().map(|p| p.to_string_lossy()),
            "video": out.video.as_ref().map(|p| p.to_string_lossy()),
            "seconds": out.seconds,
        }))
    })
    .await
    .map_err(|e| format!("separate worker failed: {e}"))?
}

/// v1 player surface (songs scope): session queue truth. All instant
/// (pure engine calls, no I/O) except `player_prepare`, which runs the real
/// decode→map→decide path once per file. Audio output wiring is the
/// end-to-end prototype slice — not here.
#[tauri::command]
fn player_open(state: tauri::State<'_, AppState>, total_secs: f64, chunk_secs: f64) -> u64 {
    state
        .player_sessions
        .lock()
        .map(|mut s| s.open(total_secs, chunk_secs))
        .unwrap_or(u64::MAX)
}

#[tauri::command]
fn player_status(
    state: tauri::State<'_, AppState>,
    id: u64,
    pos: f64,
) -> Result<serde_json::Value, String> {
    let sessions = state.player_sessions.lock().map_err(|e| e.to_string())?;
    let e = sessions.get(id).ok_or_else(|| "unknown player session".to_string())?;
    Ok(serde_json::json!({
        "chunks": e.chunk_count(),
        "chunk": e.chunk_of(pos),
        "states": e.states_snapshot(),
        "can_start": e.can_start(),
        "frozen": e.exhausted(pos),
        "next_needed": e.next_needed(pos),
    }))
}

#[tauri::command]
fn player_advance(state: tauri::State<'_, AppState>, id: u64, pos: f64) -> Result<usize, String> {
    let mut sessions = state.player_sessions.lock().map_err(|e| e.to_string())?;
    let e = sessions.get_mut(id).ok_or_else(|| "unknown player session".to_string())?;
    Ok(e.consume_through(pos))
}

#[tauri::command]
fn player_seek(
    state: tauri::State<'_, AppState>,
    id: u64,
    pos: f64,
) -> Result<player::SeekAction, String> {
    let sessions = state.player_sessions.lock().map_err(|e| e.to_string())?;
    let e = sessions.get(id).ok_or_else(|| "unknown player session".to_string())?;
    Ok(e.seek(pos))
}

#[tauri::command]
fn player_close(state: tauri::State<'_, AppState>, id: u64) -> bool {
    state.player_sessions.lock().map(|mut s| s.close(id)).unwrap_or(false)
}

/// Decode `input` into the per-process scratch dir and read the stereo mix.
///
/// Audit 2026-09-15 (٤.ب.٦): the scratch dir is now owned by a drop guard, so
/// BOTH `?` below (normalize, read) can no longer skip the cleanup and leave
/// `%TEMP%\hl_player_<pid>` behind for the next run to inherit.
fn read_normalized_mix(input: &Path) -> Result<(Vec<f32>, Vec<f32>, u32), String> {
    let work = std::env::temp_dir().join(format!("hl_player_{}", std::process::id()));
    let _scratch = crate::scratch::ScratchGuard::new(&work);
    let normalized =
        media::normalize_for_engine_limited(input, &work, None).map_err(|e| e.to_string())?;
    separator::read_wav_stereo(&normalized).map_err(|e| e.to_string())
}

/// Precompute the real position map of a file (decode + silence map +
/// decision over every chunk). Async + worker (ffmpeg + full scan); returns
/// absolute mute/duck ranges plus the per-minute cost evidence.
/// Marks every chunk of session `id` Ready on success, so `player_status`
/// stops reporting the stale "waiting for chunks" freeze after the map is
/// built (field defect 3: status must reflect reality).
#[tauri::command]
async fn player_prepare(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: u64,
    path: String,
    chunk_secs: f64,
) -> Result<serde_json::Value, String> {
    // Fail fast on an unknown session — never run ffmpeg for a dead id.
    let store = state.player_sessions.clone();
    {
        let sessions = store.lock().map_err(|e| e.to_string())?;
        if sessions.get(id).is_none() {
            return Err("unknown player session".to_string());
        }
    }
    let handed = path.clone();
    let rep = tauri::async_runtime::spawn_blocking(move || {
        let input = PathBuf::from(&path);
        let (l, r, sr) = read_normalized_mix(&input)?;
        let rep = v1proto::build_position_map(&l, &r, sr, chunk_secs, &decide::DecideConfig::default());
        Ok::<_, String>(serde_json::json!({
            "total_secs": rep.total_audio_secs,
            "chunks": rep.chunks,
            "muted_fraction": rep.muted_fraction,
            "ducked_fraction": rep.ducked_fraction,
            "minute_cost_ms": rep.minute_cost_ms,
        }))
    })
    .await
    .map_err(|e| format!("prepare worker failed: {e}"))??;
    // و-١: النطاق الثابت في `tauri.conf.json` فارغ، فالسماح هنا **زمني**
    // ولهذا الملف وحده: الواجهة تستعمل بروتوكول الأصول مرة واحدة
    // (`src/player.ts:308`) على `plPath` — وهو نفس المسار الذي نجح الخلف
    // للتوّ في فكّ ترميزه وقراءته. مسار لم ينجح لا يُسمح له بشيء.
    ipc_guard::allow_asset_for_frontend(&app, Path::new(&handed));
    // The map covers the whole file — every queued chunk is now inspectable.
    let marked = {
        let mut sessions = store.lock().map_err(|e| e.to_string())?;
        match sessions.get_mut(id) {
            Some(e) => {
                e.mark_all_ready();
                e.chunk_count()
            }
            None => return Err("unknown player session".to_string()),
        }
    };
    let mut out = rep;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("marked_ready".to_string(), serde_json::json!(marked));
    }
    Ok(out)
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

/// Where the app writes its results (downloads + processed outputs).
pub(crate) fn results_dir() -> PathBuf {
    dirs::video_dir().unwrap_or_else(|| PathBuf::from(".")).join("HaramLite")
}

/// Reveal a folder in the OS file manager. Shared by the `open_folder` command
/// and the tray menu (Sprint T2) so both behave identically.
pub(crate) fn open_in_explorer(target: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let target = if path.trim().is_empty() {
        results_dir()
    } else {
        PathBuf::from(path)
    };

    if !target.exists() {
        let _ = std::fs::create_dir_all(&target);
    }

    open_in_explorer(&target)
}

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

struct AppState {
    cancel_flag: Arc<AtomicBool>,
    settings: Arc<Mutex<settings::Settings>>,
    /// P2: sources fetched via download_media_cmd this session (canonicalized
    /// when possible). ONLY these may be auto-removed after a successful
    /// separation — user files never enter this set, by construction.
    downloaded: Arc<Mutex<HashSet<PathBuf>>>,
    /// v1 player surfaces: queue truth per opened file (maps live in the
    /// worker; the store keeps engines only).
    player_sessions: Arc<Mutex<player::PlayerStore>>,
}

/// Canonicalize for set identity; fall back to the raw path (deleted or
/// not-yet-existing files must still match).
fn download_key(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn remember_downloaded(set: &Mutex<HashSet<PathBuf>>, path: &Path) {
    if let Ok(mut s) = set.lock() {
        s.insert(download_key(path));
    }
}

/// Take-once: true only for a tracked auto-download (removes it so a later
/// manual re-process of the same path is treated as a user file).
fn take_tracked_download(set: &Mutex<HashSet<PathBuf>>, path: &Path) -> bool {
    set.lock().map(|mut s| s.remove(&download_key(path))).unwrap_or(false)
}

/// Sprint D1: read the unified settings (Rust-backed single source of truth).
#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let s = state.settings.lock().map_err(|e| e.to_string())?;
    serde_json::to_value(&*s).map_err(|e| e.to_string())
}

/// Audit 2026-09-15 (٤.ب.١): the file is the source of truth, so publish to
/// memory only **after** the write succeeded. Publishing first left a failed
/// write with the running app ahead of the disk (new values in memory, old
/// file on disk) and the error only reached `console.error` in the UI.
fn persist_then_publish(
    mem: &Mutex<settings::Settings>,
    new: &settings::Settings,
    save: impl FnOnce(&settings::Settings) -> Result<(), String>,
) -> Result<(), String> {
    save(new)?;
    let mut cur = mem.lock().map_err(|e| e.to_string())?;
    *cur = new.clone();
    Ok(())
}

/// Sprint D1/D2: persist settings, notify the UI, and apply watch-folder
/// changes immediately (start/stop/restart the watcher thread).
#[tauri::command]
fn set_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // The UI no longer keeps the bot secrets in localStorage (a second
    // plaintext copy at rest, and it defeated sealing). So on any unrelated
    // settings push it cannot resend them: `null` (or a missing key) means
    // "unchanged", an empty string means "clear" — explicit, never guessed.
    let mut value = value;
    if !value.is_object() {
        return Err("settings payload must be an object".into());
    }
    let current = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    for (key, existing) in [
        ("telegram_token", current.telegram_token),
        ("telegram_api_hash", current.telegram_api_hash),
    ] {
        let unchanged = value.get(key).map(|v| v.is_null()).unwrap_or(true);
        if unchanged {
            value[key] = serde_json::Value::String(existing);
        }
    }
    let new: settings::Settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let app_data = paths::data_dir();
    persist_then_publish(&state.settings, &new, |s| {
        settings::save(&app_data, s).map_err(|e| e.to_string())
    })?;
    watch_service::apply_settings(&new);
    telegram::apply_settings(&new);
    // Tray labels follow the app language (no-op when nothing moved).
    tray::refresh_lang(&app, &new.lang);
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

/// Sprint E3: live integration status for the persistent checkbox —
/// ground truth is manifest + registry, never the cached setting.
#[tauri::command]
fn bridge_status(app: tauri::AppHandle) -> serde_json::Value {
    // هل اتصل متصفح بهذا التطبيق من قبل؟ لا يمكن لتطبيق مكتبي أن يعدّ إضافات
    // المتصفح المثبَّتة، لكن المضيف يُسجّل أصل كل إضافة تتصل به — وسجلّ حديث
    // يعني أن الإضافة موجودة، وسجلّ غائب أو قديم يعني «لا نعرف» فيُوجَّه
    // المستخدم إلى صفحة الإضافة بدل أن يُترك يخمّن.
    const MONTH_SECS: u64 = 30 * 24 * 3600;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (extension_seen, extension_days_ago, extension_origin) = match bridge::host_seen() {
        Some((ts, origin)) => (
            bridge::seen_within(ts, now, MONTH_SECS),
            Some(now.saturating_sub(ts) / 86_400),
            origin,
        ),
        None => (false, None, String::new()),
    };
    serde_json::json!({
        "enabled": bridge::is_registered(&app),
        "extension_seen": extension_seen,
        "extension_days_ago": extension_days_ago,
        "extension_origin": extension_origin,
    })
}
/// هل يشغّل ويندوز البرنامج مع الإقلاع؟ (يُقرأ من الريجستري مباشرة)
#[tauri::command]
fn autostart_status() -> serde_json::Value {
    serde_json::json!({ "enabled": autostart::is_enabled() })
}

/// تفعيل/إلغاء التشغيل مع النظام. عند التفعيل يُكتب سطر الأمر مع
/// `--hidden-start` فيقلع البرنامج في الخلفية (بوت تيليجرام وتكامل
/// المتصفح) بلا فتح نافذة.
#[tauri::command]
fn set_autostart(on: bool) -> Result<serde_json::Value, String> {
    autostart::set_enabled(on)?;
    Ok(serde_json::json!({ "enabled": autostart::is_enabled() }))
}

/// Sprint E3: checkbox-off path — removes keys + manifest (mirror of register).
#[tauri::command]
fn unregister_native_host(app: tauri::AppHandle) -> Result<String, String> {
    bridge::unregister(&app)
}

/// Sprint T1: live Telegram worker state for the settings panel (running,
/// last error, queue, paired id, whether a pairing code is live).
#[tauri::command]
fn telegram_status() -> serde_json::Value {
    telegram::status_json()
}

/// Sprint T1: the one-time pairing code shown in the panel. `force` mints a new
/// one (the previous code is invalidated); otherwise the live code is returned,
/// or a fresh one is minted when none is live.
#[tauri::command]
fn telegram_pairing_code(force: bool) -> serde_json::Value {
    telegram::pairing_code(force)
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

/// Crash forensics: a marker written at boot and removed on graceful exit.
/// If it survives to the NEXT boot, the previous session was killed without
/// a clean shutdown (the user reported random silent crashes — this turns
/// them into visible evidence).
fn crash_marker_path() -> Option<PathBuf> {
    Some(paths::data_dir().join("session.lock"))
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
            downloaded: Arc::new(Mutex::new(HashSet::new())),
            player_sessions: Arc::new(Mutex::new(player::PlayerStore::default())),
        })
        // Sprint T2 (owner's choice): closing the window HIDES it — the bot,
        // the watch folder and the browser bridge keep running, and the always
        // present tray icon is how you come back or quit for real. Before this,
        // the process could outlive its window with no handle at all, which is
        // exactly the complaint that produced tray.rs.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                tracing::info!(target: "app", "أُخفيت النافذة إلى الشريط — البرنامج يعمل في الخلفية (الإغلاق الكامل من قائمة الأيقونة)");
            }
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
            // Sprint T3: ONE place decides where app data lives, and the move
            // off the roaming profile happens here — before anything reads or
            // writes (the log folder included).
            let app_data = paths::data_dir();
            let _ = std::fs::create_dir_all(&app_data);
            let moved = paths::migrate_legacy(&paths::legacy_dir(), &app_data);
            let log_dir = app_data.join("logs");
            let shown = logging::init(log_dir);
            tracing::info!(target: "app", "HaramLite v{} starting — logs in {}", env!("CARGO_PKG_VERSION"), shown.display());
            match &moved {
                paths::Migration::Moved { files } => tracing::info!(
                    target: "app",
                    "نُقل مجلد البيانات من Roaming إلى LocalAppData ({files} ملفاً) — {}",
                    app_data.display()
                ),
                paths::Migration::Failed(e) => tracing::error!(
                    target: "app",
                    "تعذر نقل مجلد البيانات ({e}) — سأقرأ الإعدادات القديمة ولن أكتب فيها"
                ),
                paths::Migration::Nothing => {}
            }
            note_previous_crash();
            cleanup_crash_leftovers();
            // Audit F-1: push log lines to the UI as events instead of the
            // frontend polling get_recent_logs every 700ms.
            logging::attach_emitter(app.handle().clone());

            // Sprint D1/D2: load persisted settings and (re)start the watch
            // folder service so it survives app restarts.
            let mut loaded = settings::load(&app_data);
            if !settings::path(&app_data).exists() {
                // A failed migration must never cost the user their settings.
                loaded = settings::load(&paths::legacy_dir());
            }
            // Upgrade path: a file written before sealing existed holds its
            // secrets in the clear — seal it now, on this boot, rather than
            // waiting for a settings change that may never come.
            if settings::needs_sealing(&app_data) || settings::needs_sealing(&paths::legacy_dir()) {
                match settings::save(&app_data, &loaded) {
                    Ok(()) => tracing::info!(target: "app", "شُفّرت أسرار الإعدادات (توكن تيليجرام) عند الإقلاع"),
                    Err(e) => tracing::warn!(target: "app", "تعذر تشفير أسرار الإعدادات: {e}"),
                }
            }
            // Audit R-2 (corrected): commit the ORT environment ONCE at startup
            // (no providers at env level — sessions select their own), BEFORE
            // the watch folder can start processing.
            separator::init_ort_env();
            watch_service::init(app.handle().clone());
            watch_service::apply_settings(&loaded);
            // Sprint T2: the tray icon is the app's only always-visible handle
            // (it can run with no window at all) — created with the language
            // the settings already carry.
            tray::init(app.handle(), &loaded.lang);
            // Sprint T1: Telegram bot worker (off unless enabled + token set)
            telegram::init(app.handle().clone());
            telegram::apply_settings(&loaded);
            let auto_update_ytdlp = loaded.ytdlp_auto_update;
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

            // M5: background yt-dlp update check (24h cadence, never fatal).
            // `auto_update_ytdlp` was copied out of `loaded` above, before the
            // settings value is moved into AppState.
            std::thread::Builder::new()
                .name("ytdlp-update".into())
                .spawn(move || {
                    if !auto_update_ytdlp {
                        tracing::info!(
                            target: "ytdlp",
                            "فحص تحديث yt-dlp معطّل من الإعدادات — لا شبكة ولا نداء"
                        );
                        return;
                    }
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
            probe_media,
            path_exists,
            path_is_dir,
            extract_audio,
            remux_to_mp4,
            separate_file,
            download_media_cmd,
            update_ytdlp,
            ytdlp_local_version,
            check_update,
            notify_done,
            health_check_cmd,
            repair_component,
            get_settings,
            set_settings,
            register_native_host,
            unregister_native_host,
            bridge_status,
            autostart_status,
            set_autostart,
            telegram_status,
            telegram_pairing_code,
            player_open,
            player_status,
            player_advance,
            player_seek,
            player_close,
            player_prepare,
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

#[cfg(test)]
mod p2_tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hl_p2_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn tracked_download_taken_exactly_once() {
        let set: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
        let dir = tmpdir("once");
        let f = dir.join("video.mp4");
        std::fs::write(&f, b"x").unwrap();
        assert!(!take_tracked_download(&set, &f), "untracked must never match");
        remember_downloaded(&set, &f);
        assert!(take_tracked_download(&set, &f), "first take hits");
        assert!(!take_tracked_download(&set, &f), "second take misses (one-shot)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tracked_source_uses_bridge_rule_literally() {
        let set: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
        let dir = tmpdir("rule");
        let src = dir.join("dl.mp4");
        let out = dir.join("dl_(Clean)_haramlite.mp4");
        std::fs::write(&src, b"x").unwrap();
        std::fs::write(&out, b"y").unwrap();
        remember_downloaded(&set, &src);
        // success path: tracked + same folder + live output -> delete allowed
        assert!(take_tracked_download(&set, &src));
        assert!(bridge::should_remove_bridge_source(&src, &dir, std::slice::from_ref(&out)));
        // output IS the source -> forbidden even if tracked
        remember_downloaded(&set, &src);
        assert!(take_tracked_download(&set, &src));
        assert!(!bridge::should_remove_bridge_source(&src, &dir, std::slice::from_ref(&src)));
        // user file (never tracked) -> take fails first, nothing proceeds
        let user = dir.join("mine.mp4");
        std::fs::write(&user, b"z").unwrap();
        assert!(!take_tracked_download(&set, &user));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Negative test for ٤.ب.١: a write that fails must leave memory exactly
    /// as it was (before the fix, memory was published first, so a failed
    /// write silently desynced the running app from the file on disk).
    #[test]
    fn a_failed_settings_write_never_reaches_memory() {
        let mem = Mutex::new(settings::Settings::default());
        assert_eq!(mem.lock().unwrap().lang, "ar", "fixture starts on the default");

        let next = settings::Settings { lang: "en".into(), ..Default::default() };

        let failed = persist_then_publish(&mem, &next, |_| Err("disk full".into()));
        assert!(failed.is_err(), "the write error must surface, not be swallowed");
        assert_eq!(
            mem.lock().unwrap().lang,
            "ar",
            "memory must still hold the old value after a failed write"
        );

        // and the happy path still publishes (the guard must not block writes)
        let ok = persist_then_publish(&mem, &next, |_| Ok(()));
        assert!(ok.is_ok());
        assert_eq!(mem.lock().unwrap().lang, "en");
    }

    /// Negative test for ٤.ب.٦: the player scratch dir must be gone when the
    /// decode returns early. It used to be removed by a single call at the END
    /// of the worker, so the two `?` before it (normalize, read) leaked
    /// `%TEMP%\hl_player_<pid>` on every failure.
    #[test]
    fn the_player_scratch_dir_survives_no_failure() {
        let work = std::env::temp_dir().join(format!("hl_player_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        // Whatever a failed decode had already written inside it.
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("_haramlite_normalized_x.wav"), b"partial").unwrap();

        let missing = work.join("does_not_exist.mp4");
        let failed = read_normalized_mix(&missing);
        assert!(failed.is_err(), "an undecodable input must fail the decode");
        assert!(!work.exists(), "the scratch dir must be removed on the early return");
    }

    /// Audit 2026-09-15 (٨): حارس اللغم الذي كان يمنع `cargo test` من العمل
    /// أصلاً. استدعاء `watch_service::apply_settings` يجعل `run_watch` →
    /// الـpipeline → `rfd` (‏`comctl32!TaskDialogIndirect`) قابلاً للوصول من
    /// ثنائي الاختبار، فيُصدَّر `comctl32.dll` في جدول الاستيراد. وبلا مانيفست
    /// يطلب comctl32 **v6** في الثنائي نفسه، تُحمَّل النسخة v5 الافتراضية ولا
    /// تجد `TaskDialogIndirect` ⇒ **الثنائي لا يُقلع إطلاقاً**
    /// (‏`STATUS_ENTRYPOINT_NOT_FOUND / 0xc0000139`) ويسقط `cargo test` كله.
    ///
    /// أي أن هذا الاختبار يفشل **بالتحميل** لا بالتنفيذ حين يغيب المانيفست:
    /// المانيفست يأتي من مكتبة الموارد التي يجهّزها `build.rs`، ويربطها هذا
    /// الملف عبر `#[cfg(test)] #[link(name = "resource", …)]` أعلاه — وهو ما
    /// صُوِّر فعلاً: بلا ذلك يخرج الثنائي بـ 0xc0000139 قبل أي اختبار.
    ///
    /// الإعدادات الافتراضية تُبقي المراقبة معطّلة (`watch_enabled=false`)
    /// فيعود الاستدعاء بعد مسار الإيقاف وحده — بلا خيط، وبلا قراءة/كتابة
    /// ملفات، وبلا أي أثر جانبي على بقية الاختبارات.
    #[test]
    fn watch_settings_apply_keeps_the_test_binary_loadable() {
        let s = settings::Settings::default();
        assert!(
            !s.watch_enabled,
            "fixture: الإعداد الافتراضي يجب أن يُبقي المراقبة معطّلة"
        );
        // النداء الذي يحمل العطل: بدونه لا يُسحب rfd إلى ثنائي الاختبار.
        watch_service::apply_settings(&s);
        // والنداء الثاني بنفس البصمة يغطي مسار «لا شيء تغيّر» أيضاً.
        watch_service::apply_settings(&s);
    }
}
