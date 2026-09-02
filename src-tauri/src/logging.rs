use std::collections::VecDeque;
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use tracing_subscriber::layer::Context;
use tracing_subscriber::{fmt as tracing_fmt, prelude::*, EnvFilter, Layer};

/// In-memory ring buffer of formatted log lines, shared with the UI.
pub type SharedBuffer = Arc<Mutex<VecDeque<LogLine>>>;

#[derive(Clone, serde::Serialize)]
pub struct LogLine {
    pub ts: String,
    pub level: String,
    pub target: String,
    pub message: String,
}

const CAPACITY: usize = 1000;

fn buffer() -> &'static SharedBuffer {
    static BUF: OnceLock<SharedBuffer> = OnceLock::new();
    BUF.get_or_init(|| Arc::new(Mutex::new(VecDeque::with_capacity(CAPACITY))))
}

/// Tauri app handle hooked by `attach_emitter` — each new log line is pushed
/// to the UI as a `log-line` event (audit F-1: replaces the frontend polling
/// `get_recent_logs` every 700ms). Empty in CLI mode.
static EMITTER: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn attach_emitter(app: tauri::AppHandle) {
    let _ = EMITTER.set(app);
}

struct MemoryLayer;

impl<S> Layer<S> for MemoryLayer
where
    S: tracing::Subscriber,
{
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: Context<'_, S>,
    ) {
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);

        let line = LogLine {
            ts: chrono_now(),
            level: event.metadata().level().to_string(),
            target: event.metadata().target().to_string(),
            message: visitor.0.unwrap_or_default(),
        };

        if let Ok(mut buf) = buffer().lock() {
            if buf.len() >= CAPACITY {
                buf.pop_front();
            }
            buf.push_back(line.clone());
        }
        if let Some(app) = EMITTER.get() {
            use tauri::Emitter;
            let _ = app.emit("log-line", &line);
        }
    }
}

#[derive(Default)]
struct MessageVisitor(Option<String>);

impl tracing::field::Visit for MessageVisitor {
    fn record_debug(&mut self, _field: &tracing::field::Field, value: &dyn fmt::Debug) {
        let msg = format!("{value:?}");
        match &mut self.0 {
            Some(existing) => *existing = format!("{existing} {msg}"),
            None => self.0 = Some(msg),
        }
    }

    fn record_str(&mut self, _field: &tracing::field::Field, value: &str) {
        match &mut self.0 {
            Some(existing) => *existing = format!("{existing} {value}"),
            None => self.0 = Some(value.to_string()),
        }
    }
}

fn chrono_now() -> String {
    // Local wall-clock without pulling chrono: seconds since epoch formatted
    // by the frontend is awkward; keep a compact ISO-ish stamp here.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("[{secs}]")
}

/// Install logging + panic capture. Returns the log directory.
pub fn init(log_dir: PathBuf) -> PathBuf {
    let _ = std::fs::create_dir_all(&log_dir);
    let file_appender = tracing_appender::rolling::daily(&log_dir, "haramlite.log");

    let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);
    // Leak the guard so the writer lives for the whole process.
    std::mem::forget(_guard);

    let file_layer = tracing_fmt::layer()
        .with_writer(file_writer)
        .with_ansi(false)
        .with_target(true);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(MemoryLayer)
        .init();

    install_panic_hook();
    log_dir
}

/// CLI-mode logging: stderr console layer + same rotating file.
/// Idempotent — safe against double invocation (Once-guarded).
pub fn init_cli() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static INITED: AtomicBool = AtomicBool::new(false);
    if INITED.swap(true, Ordering::SeqCst) {
        return;
    }

    let dir = dirs_data().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let file_appender = tracing_appender::rolling::daily(&dir, "haramlite.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
    std::mem::forget(guard);

    let file_layer = tracing_fmt::layer()
        .with_writer(file_writer)
        .with_ansi(false)
        .with_target(true);
    let console_layer = tracing_fmt::layer()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_target(false)
        .with_level(false);

    // Custom targets ("sep","pipe","dsp","media") bypass crate-name filters,
    // so use a plain global level for the headless run.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(console_layer)
        .with(MemoryLayer)
        .init();

    install_panic_hook();
}

/// %LOCALAPPDATA%/<identifier> equivalent without a Tauri handle.
fn dirs_data() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs_home().join("AppData").join("Local"));
    base.join("com.harammute.haramlite")
}

fn dirs_home() -> PathBuf {
    std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "Box<dyn Any> panic".into());

        tracing::error!(
            target = "panic",
            "PANIC at {location}: {payload} — backtrace:\n{}",
            std::backtrace::Backtrace::force_capture()
        );
        default_hook(info);
    }));
}

pub fn recent_logs(limit: usize) -> Vec<LogLine> {
    match buffer().lock() {
        Ok(buf) => buf.iter().rev().take(limit).rev().cloned().collect(),
        Err(_) => Vec::new(),
    }
}

pub fn push_line(level: &str, message: &str) {
    match level.to_ascii_lowercase().as_str() {
        "error" => tracing::error!(target: "frontend", "{message}"),
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        "debug" => tracing::debug!(target: "frontend", "{message}"),
        _ => tracing::info!(target: "frontend", "{message}"),
    }
}
