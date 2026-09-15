//! Sprint T1 — Telegram bot bridge (settings-driven, off by default).
//!
//! What it does: a link sent to the bot is downloaded on THIS machine, the bot
//! asks whether it is a song or an ordinary clip, the local pipeline strips the
//! music, and the result is sent back. A video/audio file sent to the bot is
//! processed the same way. Nothing is processed for anybody until the owner's
//! numeric id is configured (pairing mode) — an open bot on a desktop is a
//! resource drain waiting to happen.
//!
//! The design is driven by the Bot API's own caps, read from
//! core.telegram.org/bots/api, not by taste:
//!   • a bot may SEND at most 50 MB per file (video/audio/document alike);
//!   • a bot may only DOWNLOAD 20 MB of a file a user sent it (getFile);
//!   • a LOCAL Bot API server (advanced setting) lifts both to 2000 MB and
//!     hands us plain disk paths instead of an HTTPS download.
//! So: links are the unlimited path, sent files are the 20 MB path, and a
//! finished video that would not fit is re-encoded down to a computed bitrate —
//! or the audio is sent instead, with the reason said out loud.

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::pipeline::{self, Mode, OutFormat, OutKind};
use crate::settings::Settings;

// ── caps (core.telegram.org/bots/api) ───────────────────────────────────────
/// Hard cloud cap on anything a bot sends.
pub const CLOUD_SEND_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// Hard cloud cap on what a bot may download from a user's message.
pub const CLOUD_DOWNLOAD_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// We aim well under `CLOUD_SEND_MAX_BYTES`: the container adds overhead and a
/// rejected upload is worse than a slightly smaller file.
pub const CLOUD_TARGET_MB: f64 = 40.0;
/// Video-bitrate floor under which the picture is not worth sending.
pub use crate::media::MIN_WATCHABLE_VIDEO_KBPS;
const AUDIO_KBPS: u32 = 96;
const LONG_POLL_SECS: u64 = 25;
/// Telegram tolerates roughly one edit/second per chat; edits are cosmetic, so
/// they are throttled hard to leave room for real API calls.
const EDIT_MIN_GAP: Duration = Duration::from_secs(3);
/// Local Bot API server default port (telegram-bot-api).
pub const LOCAL_SERVER_HINT: &str = "http://127.0.0.1:8081";

// ── pairing (OTP) ───────────────────────────────────────────────────────────
/// Six digits: a four-digit code is guessable inside the attempt budget.
const PAIR_DIGITS: usize = 6;
/// A pairing code that lives forever is a password nobody rotates.
const PAIR_TTL: Duration = Duration::from_secs(600);
/// Five wrong numeric guesses burn the code — the owner regenerates it in the
/// app with one click, so guessing costs the attacker everything and us nothing.
const PAIR_MAX_FAILS: u32 = 5;

struct PairState {
    code: String,
    issued: Instant,
    fails: u32,
}

static PAIR: OnceLock<Mutex<Option<PairState>>> = OnceLock::new();

fn pair_slot() -> &'static Mutex<Option<PairState>> {
    PAIR.get_or_init(|| Mutex::new(None))
}

/// Entropy with no new dependency: std's `RandomState` is seeded from the OS
/// per instance, so mixing four fresh instances through SplitMix64 gives a code
/// that cannot be guessed from the clock or the pid. This is a one-shot code
/// behind a 5-attempt / 10-minute budget, not a long-term key.
fn random_code(digits: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut seed = nanos() as u64;
    for i in 0..4u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(nanos() as u64 ^ i.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        seed ^= h.finish().rotate_left((i as u32 * 13) % 64);
    }
    let mut x = seed;
    let mut out = String::with_capacity(digits);
    for _ in 0..digits {
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        out.push(char::from(b'0' + (z % 10) as u8));
    }
    out
}

/// The code shown in the app's settings panel. Generated on first sight or when
/// the previous one expired.
pub fn pairing_code(force: bool) -> Value {
    // Lock order (٤.ب.٩): pair_slot BEFORE status, held across it. Both sites
    // that take this pair use this order; reversed in either one, two threads
    // can hold one lock each and wait for the other forever.
    let mut slot = pair_slot().lock().unwrap_or_else(|p| p.into_inner());
    let stale = slot
        .as_ref()
        .map(|s| s.issued.elapsed() > PAIR_TTL)
        .unwrap_or(true);
    if force || stale {
        *slot = Some(PairState {
            code: random_code(PAIR_DIGITS),
            issued: Instant::now(),
            fails: 0,
        });
    }
    let s = slot.as_ref().expect("just filled");
    let paired = status()
        .lock()
        .map(|g| g.paired_id.is_some())
        .unwrap_or(false);
    json!({
        "code": s.code,
        "expires_in_secs": PAIR_TTL.saturating_sub(s.issued.elapsed()).as_secs(),
        "fails_left": PAIR_MAX_FAILS.saturating_sub(s.fails),
        "paired": paired,
    })
}

/// Test-only: the pair slot is process-global, so a test that inspects it has
/// to be able to reset it.
#[cfg(test)]
fn forget_pairing_code() {
    *pair_slot().lock().unwrap_or_else(|p| p.into_inner()) = None;
}

enum PairTry {
    /// The code matched (and has now been consumed).
    Ok,
    /// A numeric guess that did not match.
    Wrong { fails_left: u32 },
    /// Not a pairing attempt at all.
    NotAnAttempt,
}

fn check_pairing_code(text: &str) -> PairTry {
    let mut slot = pair_slot().lock().unwrap_or_else(|p| p.into_inner());
    let expired = slot
        .as_ref()
        .map(|s| s.issued.elapsed() > PAIR_TTL)
        .unwrap_or(true);
    if expired {
        *slot = None;
        return PairTry::NotAnAttempt;
    }
    let is_numeric = !text.is_empty() && text.chars().all(|c| c.is_ascii_digit());
    if !is_numeric {
        return PairTry::NotAnAttempt;
    }
    if slot.as_ref().map(|s| s.code == text).unwrap_or(false) {
        *slot = None; // one-shot: a used code is worthless, even if leaked
        return PairTry::Ok;
    }
    let s = slot.as_mut().expect("checked above");
    s.fails += 1;
    if s.fails >= PAIR_MAX_FAILS {
        *slot = None;
        return PairTry::Wrong { fails_left: 0 };
    }
    PairTry::Wrong {
        fails_left: PAIR_MAX_FAILS - s.fails,
    }
}

/// Persist the newly paired owner: shared state, settings.json, and the UI.
fn complete_pairing(from_id: i64) -> Result<Settings, String> {
    use tauri::Manager;
    let app = APP.get().ok_or("التطبيق غير مهيأ")?;
    let state = app.try_state::<crate::AppState>().ok_or("حالة التطبيق غير متاحة")?;
    let s = {
        let mut cur = state.settings.lock().unwrap_or_else(|p| p.into_inner());
        cur.telegram_user_id = from_id.to_string();
        cur.clone()
    };
    let app_data = crate::paths::data_dir();
    crate::settings::save(&app_data, &s).map_err(|e| e.to_string())?;
    if let Ok(mut st) = status().lock() {
        st.paired_id = Some(from_id);
    }
    tracing::info!(target: "telegram", "تم الاقتران بالمعرّف {from_id}");
    Ok(s)
}

fn pairing_hint(from_id: i64) -> String {
    format!(
        "🔒 هذا البوت غير مقترن بعد.\n\
         معرّفك: `{from_id}`\n\n\
         لربطه: افتح البرنامج ← الإعدادات ← تيليجرام، وأرسل رمز الاقتران الظاهر هناك \
         إلى هذا البوت (أو الصق معرّفك في خانة «معرّف المستخدم المسموح»)."
    )
}

/// The settings that actually change behaviour — compared on every
/// `set_settings` so the worker is only restarted when something moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TgConfig {
    pub token: String,
    pub owner_id: Option<i64>,
    pub audio_only: bool,
    pub local_url: Option<String>,
}

impl TgConfig {
    pub fn from_settings(s: &Settings) -> Self {
        let trim = |v: &str| v.trim().to_string();
        let token = trim(&s.telegram_token);
        let owner = trim(&s.telegram_user_id);
        let local = trim(&s.telegram_local_url);
        Self {
            token,
            owner_id: owner.parse::<i64>().ok(),
            audio_only: s.telegram_audio_only,
            // A URL without a scheme is what people actually type.
            local_url: if local.is_empty() {
                None
            } else if local.starts_with("http") {
                Some(local.trim_end_matches('/').to_string())
            } else {
                Some(format!("http://{}", local.trim_end_matches('/')))
            },
        }
    }

    /// A bot cannot run without a token; everything else has a safe default.
    pub fn usable(&self) -> bool {
        !self.token.is_empty()
    }

    /// Pairing gate: with no owner id configured, NOBODY is processed — not
    /// even an educated guess. The bot answers with the caller's id so the
    /// owner can paste it into the settings.
    pub fn allows(&self, from_id: i64) -> bool {
        matches!(self.owner_id, Some(o) if o == from_id)
    }

    pub fn is_local(&self) -> bool {
        self.local_url.is_some()
    }

    /// Bot API root for both the cloud and a local server — the only
    /// difference between the two transports.
    fn api(&self) -> String {
        let base = self
            .local_url
            .clone()
            .unwrap_or_else(|| "https://api.telegram.org".to_string());
        format!("{base}/bot{}", self.token)
    }
}

// ── delivery policy (pure — unit-tested, no network) ────────────────────────

/// What to do with a finished result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Send the produced video untouched (it already fits, or we are local).
    Video,
    /// Re-encode at `target_kbps` so it fits the cloud cap.
    VideoShrunk { target_kbps: u32 },
    /// Send the audio track only — the owner asked, or no watchable picture
    /// can fit into the cap at this duration.
    Audio,
}

/// Pre-flight, before spending minutes on a video render: at this duration can
/// a cloud upload ever carry a watchable picture? Local server ⇒ always yes.
pub fn video_worth_rendering(duration_secs: f64, local: bool) -> bool {
    if local || !(duration_secs > 0.0) {
        return true;
    }
    crate::media::target_video_kbps(duration_secs, CLOUD_TARGET_MB, AUDIO_KBPS)
        >= MIN_WATCHABLE_VIDEO_KBPS
}

/// Post-flight: the real produced size is known, so only shrink when needed.
pub fn plan_delivery(
    produced_bytes: u64,
    duration_secs: f64,
    has_video: bool,
    audio_only: bool,
    local: bool,
) -> Delivery {
    if !has_video || audio_only {
        return Delivery::Audio;
    }
    if local {
        return Delivery::Video;
    }
    if produced_bytes > 0 && produced_bytes <= (CLOUD_TARGET_MB * 1024.0 * 1024.0) as u64 {
        return Delivery::Video;
    }
    let kbps = crate::media::target_video_kbps(duration_secs, CLOUD_TARGET_MB, AUDIO_KBPS);
    if kbps < MIN_WATCHABLE_VIDEO_KBPS {
        Delivery::Audio
    } else {
        Delivery::VideoShrunk {
            target_kbps: kbps,
        }
    }
}

/// Standard Telegram "/start"-style payload parsing.
fn parse_mode_action(data: &str) -> Option<(String, Mode)> {
    let mut it = data.splitn(3, ':');
    if it.next()? != "mode" {
        return None;
    }
    let mode = match it.next()? {
        "song" => Mode::Song,
        "clip" => Mode::Clip,
        _ => return None,
    };
    let token = it.next()?.to_string();
    if token.is_empty() {
        return None;
    }
    Some((token, mode))
}

/// First http(s) URL in a message — the only "link" the bot will chase.
fn find_url(text: &str) -> Option<String> {
    let start = text.find("http://").or_else(|| text.find("https://"))?;
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '<' || c == '>')
        .unwrap_or(rest.len());
    let url = &rest[..end];
    // A bare scheme is not a link.
    if url.len() > 12 {
        Some(url.to_string())
    } else {
        None
    }
}

fn human_mb(bytes: u64) -> String {
    format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
}

// ── HTTP: cloud and local speak the same language ───────────────────────────

fn call(cfg: &TgConfig, method: &str, body: &Value, timeout: Duration) -> Result<Value, String> {
    let url = format!("{}/{}", cfg.api(), method);
    let resp = ureq::post(&url)
        .timeout(timeout)
        .set("Content-Type", "application/json")
        .send_json(body.clone());
    match resp {
        Ok(r) => {
            let v: Value = r.into_json().map_err(|e| e.to_string())?;
            if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                Ok(v.get("result").cloned().unwrap_or(Value::Null))
            } else {
                Err(describe(&v))
            }
        }
        // Telegram answers 4xx with a JSON body that explains itself — keep it.
        Err(ureq::Error::Status(code, r)) => match r.into_json::<Value>() {
            Ok(v) => Err(redact(&cfg.token, describe(&v))),
            Err(_) => Err(format!("HTTP {code}")),
        },
        Err(e) => Err(redact(&cfg.token, e.to_string())),
    }
}

fn describe(v: &Value) -> String {
    v.get("description")
        .and_then(Value::as_str)
        .unwrap_or("خطأ غير معروف من تيليجرام")
        .to_string()
}

/// Nothing we display, send or store may carry the bot token. ureq's transport
/// errors begin with the URL (`error.rs`: `write!(f, "{}: ", url)`) and every
/// Telegram URL is `/bot<token>/…`, so a network hiccup would otherwise print
/// the secret — and one of those strings (`✗ فشل الإرسال: …`) is posted INTO the
/// Telegram chat itself, where it would sit in the history forever.
/// Found by reading ureq's source, 2026-09-11. Every error path goes through here.
fn redact(token: &str, msg: String) -> String {
    if token.is_empty() {
        return msg;
    }
    msg.replace(token, "<التوكن محجوب>")
}

fn get_updates(cfg: &TgConfig, offset: i64) -> Result<Vec<Value>, String> {
    let body = json!({
        "offset": offset,
        "timeout": LONG_POLL_SECS,
        "allowed_updates": ["message", "callback_query"],
    });
    let v = call(
        cfg,
        "getUpdates",
        &body,
        Duration::from_secs(LONG_POLL_SECS + 15),
    )?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

fn send_message(cfg: &TgConfig, chat_id: i64, text: &str, keyboard: Option<Value>) -> Result<i64, String> {
    let mut body = json!({ "chat_id": chat_id, "text": text, "disable_web_page_preview": true });
    if let Some(k) = keyboard {
        body["reply_markup"] = k;
    }
    let v = call(cfg, "sendMessage", &body, Duration::from_secs(20))?;
    Ok(v.get("message_id").and_then(Value::as_i64).unwrap_or(0))
}

fn edit_message(cfg: &TgConfig, chat_id: i64, message_id: i64, text: &str) -> Result<(), String> {
    let body = json!({ "chat_id": chat_id, "message_id": message_id, "text": text });
    call(cfg, "editMessageText", &body, Duration::from_secs(20)).map(|_| ())
}

fn answer_callback(cfg: &TgConfig, id: &str, text: &str) {
    let body = json!({ "callback_query_id": id, "text": text });
    let _ = call(cfg, "answerCallbackQuery", &body, Duration::from_secs(10));
}

fn get_file(cfg: &TgConfig, file_id: &str) -> Result<(String, u64), String> {
    let v = call(cfg, "getFile", &json!({ "file_id": file_id }), Duration::from_secs(30))?;
    let path = v
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or("لا مسار للملف في رد تيليجرام")?
        .to_string();
    let size = v
        .get("file_size")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Ok((path, size))
}

/// Cloud transport: files come over HTTPS and the bot is capped at 20 MB.
fn download_cloud_file(cfg: &TgConfig, remote_path: &str, dest: &Path, cap: u64) -> Result<u64, String> {
    let url = format!(
        "{}/file/bot{}/{}",
        cfg.local_url.clone().unwrap_or_else(|| "https://api.telegram.org".into()),
        cfg.token,
        remote_path
    );
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(180))
        .call()
        .map_err(|e| redact(&cfg.token, e.to_string()))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    // Read one byte past the cap so an over-limit file is detected, not stored.
    let mut limited = resp.into_reader().take(cap + 1);
    let written = std::io::copy(&mut limited, &mut out).map_err(|e| e.to_string())?;
    if written > cap {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "الملف أكبر من حد تيليجرام السحابي ({}) — أرسله كرابط، أو فعّل الخادم المحلي من الإعدادات",
            human_mb(cap)
        ));
    }
    Ok(written)
}

// ── multipart upload (hand-rolled: no extra dependency) ─────────────────────

/// Boundary + body framing for one file field. Split into head/tail so the file
/// itself is streamed from disk — a 2 GB local-server upload must never be
/// loaded into memory.
struct MultipartBody {
    head: Vec<u8>,
    tail: Vec<u8>,
    boundary: String,
}

impl MultipartBody {
    fn build(fields: &[(&str, String)], file_field: &str, filename: &str, content_type: &str) -> Self {
        let boundary = format!("----HaramLiteBoundary{}", nanos());
        let mut head = Vec::new();
        for (k, v) in fields {
            head.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
            head.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{k}\"\r\n\r\n").as_bytes(),
            );
            head.extend_from_slice(v.as_bytes());
            head.extend_from_slice(b"\r\n");
        }
        head.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        head.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{file_field}\"; filename=\"{filename}\"\r\n"
            )
            .as_bytes(),
        );
        head.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
        let tail = format!("\r\n--{boundary}--\r\n").into_bytes();
        Self {
            head,
            tail,
            boundary,
        }
    }
}

/// POST one file. Content-Length is declared explicitly (and asserted by a
/// unit test) so the request is never chunked — Telegram's edge is happier with
/// a known length, and progress/retry semantics stay predictable.
fn post_file(
    url: &str,
    body: &MultipartBody,
    file: std::fs::File,
    file_len: u64,
    timeout: Duration,
    token: &str,
) -> Result<Value, String> {
    let total = body.head.len() as u64 + file_len + body.tail.len() as u64;
    let reader = Cursor::new(body.head.clone())
        .chain(file)
        .chain(Cursor::new(body.tail.clone()));
    let resp = ureq::post(url)
        .timeout(timeout)
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={}", body.boundary),
        )
        .set("Content-Length", &total.to_string())
        .send(reader);
    match resp {
        Ok(r) => {
            let v: Value = r.into_json().map_err(|e| e.to_string())?;
            if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                Ok(v.get("result").cloned().unwrap_or(Value::Null))
            } else {
                Err(describe(&v))
            }
        }
        Err(ureq::Error::Status(code, r)) => match r.into_json::<Value>() {
            Ok(v) => Err(redact(token, describe(&v))),
            Err(_) => Err(format!("HTTP {code}")),
        },
        Err(e) => Err(redact(token, e.to_string())),
    }
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn content_type_for(path: &Path) -> (&'static str, &'static str) {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") => ("video", "video/mp4"),
        Some("mp3") => ("audio", "audio/mpeg"),
        Some("m4a") => ("audio", "audio/mp4"),
        Some("wav") => ("audio", "audio/wav"),
        Some("opus") => ("audio", "audio/ogg"),
        _ => ("document", "application/octet-stream"),
    }
}

/// Send one media file, choosing the Bot API method by extension.
fn send_media(
    cfg: &TgConfig,
    chat_id: i64,
    path: &Path,
    caption: &str,
) -> Result<(), String> {
    let (field, ctype) = content_type_for(path);
    let method = match field {
        "video" => "sendVideo",
        "audio" => "sendAudio",
        _ => "sendDocument",
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "haramlite.bin".into());
    let fields: Vec<(&str, String)> = vec![
        ("chat_id", chat_id.to_string()),
        ("caption", caption.to_string()),
        ("supports_streaming", "true".to_string()),
    ];
    let body = MultipartBody::build(&fields, field, &name, ctype);
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let url = format!("{}/{}", cfg.api(), method);
    // Local uploads are instant; cloud uploads of tens of MB are not.
    let timeout = if cfg.is_local() {
        Duration::from_secs(300)
    } else {
        Duration::from_secs(600)
    };
    post_file(&url, &body, file, len, timeout, &cfg.token).map(|_| ())
}

// ── incoming updates (pure parsing) ─────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Link(String),
    File {
        file_id: String,
        name: String,
        size: u64,
    },
}

/// What a message means to us, if anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    /// A link to download, or a file the user attached.
    Job(Source),
    /// Anything else worth a short answer (`/start`, plain text, …).
    Smalltalk(String),
}

/// Extract the sender id, chat id and meaning from one `message` update.
pub fn parse_message(msg: &Value) -> Option<(i64, i64, Incoming)> {
    let from_id = msg
        .get("from")
        .and_then(|f| f.get("id"))
        .and_then(Value::as_i64)?;
    let chat_id = msg
        .get("chat")
        .and_then(|c| c.get("id"))
        .and_then(Value::as_i64)
        .unwrap_or(from_id);
    // A file wins over its own caption text.
    for key in ["video", "audio", "voice", "document"] {
        if let Some(f) = msg.get(key) {
            if let Some(id) = f.get("file_id").and_then(Value::as_str) {
                let name = f
                    .get("file_name")
                    .and_then(Value::as_str)
                    .or_else(|| msg.get("caption").and_then(Value::as_str))
                    .unwrap_or("media")
                    .to_string();
                let size = f.get("file_size").and_then(Value::as_u64).unwrap_or(0);
                return Some((
                    from_id,
                    chat_id,
                    Incoming::Job(Source::File {
                        file_id: id.to_string(),
                        name,
                        size,
                    }),
                ));
            }
        }
    }
    let text = msg.get("text").and_then(Value::as_str).unwrap_or("");
    if let Some(url) = find_url(text) {
        return Some((from_id, chat_id, Incoming::Job(Source::Link(url))));
    }
    Some((from_id, chat_id, Incoming::Smalltalk(text.to_string())))
}

// ── runtime: one worker thread + one job thread ─────────────────────────────

struct Job {
    chat_id: i64,
    source: Source,
    mode: Mode,
}

struct Pending {
    token: String,
    source: Source,
}

#[derive(Default)]
struct Status {
    running: bool,
    last_error: String,
    last_activity: String,
    processed: u64,
    queue: usize,
    paired_id: Option<i64>,
}

struct Runtime {
    cfg: TgConfig,
    stop: Arc<AtomicBool>,
}

static HANDLE: OnceLock<Mutex<Option<Runtime>>> = OnceLock::new();
static STATUS: OnceLock<Mutex<Status>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn handle() -> &'static Mutex<Option<Runtime>> {
    HANDLE.get_or_init(|| Mutex::new(None))
}
fn status() -> &'static Mutex<Status> {
    STATUS.get_or_init(|| Mutex::new(Status::default()))
}

pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

fn set_error(e: impl Into<String>) {
    if let Ok(mut s) = status().lock() {
        s.last_error = e.into();
    }
}

fn set_activity(a: impl Into<String>) {
    if let Ok(mut s) = status().lock() {
        s.last_activity = a.into();
    }
}

/// Live status for the settings panel — ground truth is the worker itself.
pub fn status_json() -> Value {
    // Lock order (٤.ب.٩): pair_slot BEFORE status — the same order
    // `pairing_code` uses. This site used to take them the other way round.
    let slot = pair_slot().lock().unwrap_or_else(|p| p.into_inner());
    let code_active = slot
        .as_ref()
        .map(|c| c.issued.elapsed() <= PAIR_TTL)
        .unwrap_or(false);
    let s = status().lock().map(|g| g).unwrap_or_else(|p| p.into_inner());
    json!({
        "running": s.running,
        "last_error": s.last_error,
        "last_activity": s.last_activity,
        "processed": s.processed,
        "queue": s.queue,
        "paired_id": s.paired_id,
        "pairing_code_active": code_active,
        "local_server_hint": LOCAL_SERVER_HINT,
        "cloud_send_max_mb": CLOUD_SEND_MAX_BYTES / (1024 * 1024),
        "cloud_download_max_mb": CLOUD_DOWNLOAD_MAX_BYTES / (1024 * 1024),
    })
}

/// Start/stop/restart the worker to match the settings. Called from
/// `set_settings` next to the watch-folder service.
pub fn apply_settings(s: &Settings) {
    let want = TgConfig::from_settings(s);
    let enabled = s.telegram_enabled && want.usable();
    let mut guard = handle().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(rt) = guard.as_ref() {
        let same = rt.cfg == want;
        if same && enabled {
            return; // nothing moved — never bounce a healthy worker
        }
        rt.stop.store(true, Ordering::SeqCst);
    }
    *guard = None;
    if !enabled {
        if let Ok(mut st) = status().lock() {
            st.running = false;
        }
        tracing::info!(target: "telegram", "بوت تيليجرام متوقف");
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let queue = Arc::new(AtomicUsize::new(0));
    *guard = Some(Runtime {
        cfg: want.clone(),
        stop: stop.clone(),
    });
    drop(guard);
    {
        let mut st = status().lock().unwrap_or_else(|p| p.into_inner());
        st.running = true;
        st.last_error.clear();
        st.paired_id = want.owner_id;
    }
    tracing::info!(
        target: "telegram",
        "بوت تيليجرام يعمل{} ({})",
        if want.is_local() { " عبر خادم محلي" } else { "" },
        if want.owner_id.is_some() { "مقترن" } else { "وضع الاقتران" }
    );
    let (tx, rx) = mpsc::channel::<Job>();
    spawn_job_thread(want.clone(), stop.clone(), rx, queue.clone());
    spawn_poll_thread(want, stop, tx, queue);
}

fn spawn_poll_thread(cfg: TgConfig, stop: Arc<AtomicBool>, tx: Sender<Job>, queue: Arc<AtomicUsize>) {
    std::thread::Builder::new()
        .name("telegram-poll".into())
        .spawn(move || {
            use tauri::Emitter;
            // Drop the backlog: links sent while the app was closed are stale,
            // and processing them unasked would burn the machine at startup.
            let mut offset = match call(&cfg, "getUpdates", &json!({ "offset": -1 }), Duration::from_secs(20)) {
                Ok(v) => v
                    .as_array()
                    .and_then(|a| a.last())
                    .and_then(|u| u.get("update_id"))
                    .and_then(Value::as_i64)
                    .map(|id| id + 1)
                    .unwrap_or(0),
                Err(e) => {
                    set_error(format!("تعذر الاتصال بتيليجرام: {e}"));
                    0
                }
            };
            let mut pending: HashMap<i64, Pending> = HashMap::new();
            // Chats already told how to pair — a stranger gets one hint, then
            // silence (never a second reply to keep poking at).
            let mut hinted: HashSet<i64> = HashSet::new();
            while !stop.load(Ordering::SeqCst) {
                match get_updates(&cfg, offset) {
                    Ok(updates) => {
                        if let Ok(mut st) = status().lock() {
                            st.last_error.clear();
                        }
                        for u in updates {
                            if let Some(id) = u.get("update_id").and_then(Value::as_i64) {
                                offset = offset.max(id + 1);
                            }
                            if stop.load(Ordering::SeqCst) {
                                break;
                            }
                            handle_update(&cfg, &mut pending, &mut hinted, &u, &tx, &queue);
                        }
                    }
                    Err(e) => {
                        set_error(e);
                        // Backoff: a bad token must not spin the CPU.
                        std::thread::sleep(Duration::from_secs(5));
                    }
                }
            }
            let _ = APP.get().map(|a| a.emit("telegram-status", status_json()));
        })
        .ok();
}

fn handle_update(
    cfg: &TgConfig,
    pending: &mut HashMap<i64, Pending>,
    hinted: &mut HashSet<i64>,
    u: &Value,
    tx: &Sender<Job>,
    queue: &Arc<AtomicUsize>,
) {
    if let Some(cb) = u.get("callback_query") {
        let from_id = cb.get("from").and_then(|f| f.get("id")).and_then(Value::as_i64).unwrap_or(0);
        let data = cb.get("data").and_then(Value::as_str).unwrap_or("");
        let cb_id = cb.get("id").and_then(Value::as_str).unwrap_or("");
        let chat_id = cb
            .get("message")
            .and_then(|m| m.get("chat"))
            .and_then(|c| c.get("id"))
            .and_then(Value::as_i64)
            .unwrap_or(from_id);
        let msg_id = cb
            .get("message")
            .and_then(|m| m.get("message_id"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if !cfg.allows(from_id) {
            answer_callback(cfg, cb_id, "غير مصرّح");
            return;
        }
        let Some((token, mode)) = parse_mode_action(data) else {
            answer_callback(cfg, cb_id, "");
            return;
        };
        let Some(p) = pending.remove(&chat_id) else {
            answer_callback(cfg, cb_id, "انتهت صلاحية هذا الطلب — أعد الإرسال");
            return;
        };
        if p.token != token {
            answer_callback(cfg, cb_id, "طلب قديم");
            return;
        }
        let label = if mode == Mode::Song { "أغنية" } else { "مقطع عادي" };
        answer_callback(cfg, cb_id, &format!("اخترت: {label}"));
        let queued = queue.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut st) = status().lock() {
            st.queue = queued;
        }
        if tx.send(Job { chat_id, source: p.source, mode }).is_err() {
            queue.fetch_sub(1, Ordering::SeqCst);
            let _ = send_message(cfg, chat_id, "⚠ تعذر جدولة المهمة", None);
            return;
        }
        let text = if queued > 1 {
            format!("⏳ في الطابور (المكان {queued}) — الوضع: {label}")
        } else {
            format!("▶ بدأ العمل — الوضع: {label}")
        };
        if msg_id != 0 {
            let _ = edit_message(cfg, chat_id, msg_id, &text);
        } else {
            let _ = send_message(cfg, chat_id, &text, None);
        }
        return;
    }

    let Some(msg) = u.get("message") else { return };
    let Some((from_id, chat_id, incoming)) = parse_message(msg) else {
        return;
    };

    // ── security gate: an open bot on a desktop drains the machine ─────────
    // Paired ⇒ only the owner exists as far as this bot is concerned; anyone
    // else gets nothing at all, not even an acknowledgement.
    if let Some(owner) = cfg.owner_id {
        if from_id != owner {
            set_activity(format!("رُفض متطفل: {from_id}"));
            tracing::warn!(target: "telegram", "رسالة من غير المالك ({from_id}) — تجاهُل تام");
            return;
        }
    } else {
        // Pairing mode: the ONE thing that opens this bot is the one-time code
        // shown in the app's settings panel.
        let text = msg
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        match check_pairing_code(&text) {
            PairTry::Ok => {
                let reply = match complete_pairing(from_id) {
                    Ok(s) => {
                        // Re-apply settings so the running worker becomes the
                        // paired one immediately (no restart by the user).
                        apply_settings(&s);
                        "✅ تم اقتران حسابك بنجاح.\nأرسل رابط فيديو، أو ارفع ملف صوت/فيديو، وسأزيل الموسيقى وأعيده إليك.".to_string()
                    }
                    Err(e) => format!("⚠ تعذر حفظ الاقتران: {e}"),
                };
                let _ = send_message(cfg, chat_id, &reply, None);
                set_activity(format!("اقتران ناجح: {from_id}"));
                return;
            }
            PairTry::Wrong { fails_left } => {
                let body = if fails_left == 0 {
                    "❌ كود غير صحيح — أُبطل الرمز. اطلب رمزاً جديداً من إعدادات البرنامج.".to_string()
                } else {
                    format!("❌ كود غير صحيح. المحاولات المتبقية: {fails_left}")
                };
                let _ = send_message(cfg, chat_id, &body, None);
                set_activity(format!("محاولة اقتران فاشلة من {from_id}"));
                return;
            }
            PairTry::NotAnAttempt => {}
        }
        if hinted.insert(chat_id) {
            let _ = send_message(cfg, chat_id, &pairing_hint(from_id), None);
        }
        set_activity(format!("غير مقترن: رسالة من {from_id}"));
        return;
    }

    match incoming {
        Incoming::Job(source) => {
            let token = format!("{:x}", nanos());
            let hint = match &source {
                Source::Link(u) => format!("🔗 {u}"),
                Source::File { name, .. } => format!("📎 {name}"),
            };
            let keyboard = json!({
                "inline_keyboard": [[
                    { "text": "🎵 أغنية", "callback_data": format!("mode:song:{token}") },
                    { "text": "🎬 مقطع عادي", "callback_data": format!("mode:clip:{token}") }
                ]]
            });
            let text = format!(
                "{hint}\n\nهل هذا **أغنية** أم **مقطع عادي**؟\n\
                 (الأغنية: فصل كامل + قصّ الصمت — المقطع: إزالة الموسيقى فقط)"
            );
            match send_message(cfg, chat_id, &text, Some(keyboard)) {
                Ok(_) => {
                    pending.insert(chat_id, Pending { token, source });
                }
                Err(e) => set_error(e),
            }
        }
        Incoming::Smalltalk(t) => {
            let help = "أرسل رابط فيديو، أو ارفع ملف صوت/فيديو (حتى 20MB)، وسأزيل الموسيقى وأعيده إليك.";
            if t.trim_start().starts_with('/') || t.trim().is_empty() {
                let _ = send_message(cfg, chat_id, help, None);
            } else {
                let _ = send_message(cfg, chat_id, &format!("لم أجد رابطاً في رسالتك.\n{help}"), None);
            }
        }
    }
}

fn spawn_job_thread(cfg: TgConfig, stop: Arc<AtomicBool>, rx: Receiver<Job>, queue: Arc<AtomicUsize>) {
    std::thread::Builder::new()
        .name("telegram-jobs".into())
        .spawn(move || {
            // Self-healing: wipe whatever a previous run (or a crash) left in
            // the scratch dir. Safe here because no job can be running yet.
            clear_scratch(&work_dir(&crate::paths::data_dir()));
            while let Ok(job) = rx.recv() {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                queue.fetch_sub(1, Ordering::SeqCst);
                if let Ok(mut st) = status().lock() {
                    st.queue = queue.load(Ordering::SeqCst);
                }
                run_job(&cfg, job, &stop);
                if let Ok(mut st) = status().lock() {
                    st.processed += 1;
                    st.last_activity = now_stamp();
                }
            }
        })
        .ok();
}

fn now_stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// Throttled status message: Telegram rate-limits edits, and progress is
/// cosmetic — 3s granularity is plenty.
struct StatusMsg {
    chat_id: i64,
    message_id: i64,
    last: Instant,
    text: String,
}

impl StatusMsg {
    fn new(chat_id: i64, message_id: i64, text: String) -> Self {
        Self {
            chat_id,
            message_id,
            last: Instant::now(),
            text,
        }
    }
    fn set(&mut self, cfg: &TgConfig, text: String, force: bool) {
        if !force && self.last.elapsed() < EDIT_MIN_GAP && text == self.text {
            return;
        }
        if !force && self.last.elapsed() < EDIT_MIN_GAP {
            return;
        }
        self.last = Instant::now();
        self.text = text.clone();
        if self.message_id != 0 {
            let _ = edit_message(cfg, self.chat_id, self.message_id, &text);
        }
    }
}

fn work_dir(app_data: &Path) -> PathBuf {
    let d = app_data.join("telegram");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Nothing in the Telegram scratch dir is user data: it holds our copy of a
/// file the user sent, plus our compression intermediates (the delivered
/// result itself goes to the results folder). So it can always be emptied —
/// at worker start (leftovers from a crashed run) and at the end of every job
/// on EVERY exit path, via `Drop`.
#[derive(Default)]
struct ScratchGuard {
    files: Vec<PathBuf>,
}

impl ScratchGuard {
    fn track(&mut self, p: &Path) {
        self.files.push(p.to_path_buf());
    }
}

impl Drop for ScratchGuard {
    fn drop(&mut self) {
        for f in &self.files {
            match std::fs::remove_file(f) {
                Ok(()) => tracing::debug!(target: "telegram", "حُذف مؤقت: {}", f.display()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => tracing::warn!(target: "telegram", "تعذر حذف المؤقت {}: {e}", f.display()),
            }
        }
    }
}

/// Empty the scratch dir. Only called when no job can be running (worker
/// start), so a plain wipe is safe — and it heals whatever a killed run left
/// behind (field report: 150MB of stale results, 2026-09-11).
fn clear_scratch(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut freed: u64 = 0;
    let mut n = 0;
    for e in entries.flatten() {
        let p = e.path();
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        let removed = if p.is_dir() {
            std::fs::remove_dir_all(&p).is_ok()
        } else {
            std::fs::remove_file(&p).is_ok()
        };
        if removed {
            freed += size;
            n += 1;
        }
    }
    if n > 0 {
        tracing::info!(
            target: "telegram",
            "نُظّف مجلد تيليجرام المؤقت: {n} ملفاً ({:.1}MB)",
            freed as f64 / (1024.0 * 1024.0)
        );
    }
}

fn out_dir() -> PathBuf {
    crate::results_dir()
}

fn run_job(cfg: &TgConfig, job: Job, stop: &Arc<AtomicBool>) {
    let app_data = crate::paths::data_dir();
    let scratch = work_dir(&app_data);
    // Delivered results live with the user's other results; the scratch dir
    // holds only our copy of a sent file and compression intermediates.
    let results = out_dir();
    let _ = std::fs::create_dir_all(&results);
    let Job { chat_id, source, mode } = job;

    let msg_id = send_message(cfg, chat_id, "📥 جارٍ التجهيز…", None).unwrap_or(0);
    // RefCell: the progress closure AND the stage closure both report through
    // the same status message, and two `&mut` captures cannot coexist.
    let status = std::cell::RefCell::new(StatusMsg::new(chat_id, msg_id, String::new()));

    // 1. Obtain the input. Everything this job creates inside the scratch dir
    //    is disposable and tracked here, so no exit path can leak it.
    let cancel = Arc::new(AtomicBool::new(false));
    let mut scratch_files = ScratchGuard::default();
    let input: PathBuf = match &source {
        Source::Link(url) => {
            status.borrow_mut().set(cfg, "📥 جارٍ التنزيل… 0%".into(), true);
            let dir = out_dir();
            let _ = std::fs::create_dir_all(&dir);
            let dl = |p: f32| {
                status.borrow_mut().set(cfg, format!("📥 جارٍ التنزيل… {}%", (p * 100.0).round()), false);
                !stop.load(Ordering::SeqCst)
            };
            match crate::yt_dlp::download_media(url, &dir, &dl, &cancel) {
                Ok(p) => p,
                Err(e) => {
                    status.borrow_mut().set(cfg, format!("✗ فشل التنزيل: {e}"), true);
                    return;
                }
            }
        }
        Source::File {
            file_id,
            name,
            size,
        } => {
            if !cfg.is_local() && *size > 0 && *size > CLOUD_DOWNLOAD_MAX_BYTES {
                let _ = edit_message(
                    cfg,
                    chat_id,
                    msg_id,
                    &format!(
                        "✗ حجم الملف {} يتجاوز حد تيليجرام للتنزيل ({}).\n\
                         أرسل المقطع كرابط (بلا حد)، أو فعّل الخادم المحلي من الإعدادات.",
                        human_mb(*size),
                        human_mb(CLOUD_DOWNLOAD_MAX_BYTES)
                    ),
                );
                return;
            }
            status.borrow_mut().set(cfg, "📥 جارٍ استلام الملف…".into(), true);
            let (remote, _sz) = match get_file(cfg, file_id) {
                Ok(v) => v,
                Err(e) => {
                    status.borrow_mut().set(cfg, format!("✗ تعذر استلام الملف: {e}"), true);
                    return;
                }
            };
            let safe = sanitize_name(name);
            let dest = scratch.join(format!("{}_{}", nanos(), safe));
            if cfg.is_local() {
                // A local Bot API server hands us a real path on this disk.
                let src = PathBuf::from(&remote);
                if src.is_file() {
                    match std::fs::copy(&src, &dest) {
                        Ok(_) => {
                            scratch_files.track(&dest);
                            dest
                        }
                        Err(e) => {
                            status.borrow_mut().set(cfg, format!("✗ تعذر نسخ الملف: {e}"), true);
                            return;
                        }
                    }
                } else {
                    status.borrow_mut().set(cfg, "✗ مسار الملف المحلي غير موجود".into(), true);
                    return;
                }
            } else {
                match download_cloud_file(cfg, &remote, &dest, CLOUD_DOWNLOAD_MAX_BYTES) {
                    Ok(_) => {
                        scratch_files.track(&dest);
                        dest
                    }
                    Err(e) => {
                        status.borrow_mut().set(cfg, format!("✗ {e}"), true);
                        return;
                    }
                }
            }
        }
    };

    // 2. Probe: duration decides whether a cloud upload can carry a picture.
    let info = crate::media::probe(&input).ok();
    let duration = info.as_ref().map(|i| i.duration_secs).unwrap_or(0.0);
    let source_has_video = info
        .as_ref()
        .map(|i| i.has_video && !i.video_is_cover_art)
        .unwrap_or(false);
    let render_video = source_has_video
        && !cfg.audio_only
        && video_worth_rendering(duration, cfg.is_local());
    if source_has_video && !render_video && !cfg.audio_only {
        status.borrow_mut().set(
            cfg,
            format!(
                "ℹ️ المقطع طويل ({}) — لا يمكن أن يحمل الفيديو داخل حد تيليجرام، \
                 سأرسل الصوت بجودة كاملة.",
                format_duration(duration)
            ),
            true,
        );
    }

    // 3. Process.
    let s = APP
        .get()
        .and_then(|a| {
            use tauri::Manager;
            a.try_state::<crate::AppState>()
                .map(|st| st.settings.lock().unwrap_or_else(|p| p.into_inner()).clone())
        })
        .unwrap_or_default();
    let kind = if render_video {
        OutKind::Video { max_height: None }
    } else {
        OutKind::Audio {
            fmt: OutFormat::Mp3,
        }
    };
    let prog = |p: f32| {
        status.borrow_mut().set(cfg, format!("🎛️ فصل الصوت… {}%", (p * 100.0).round()), false);
        !stop.load(Ordering::SeqCst)
    };
    let stage = |name: &str, _p: f32| {
        let ar = match name {
            "normalize" => "تجهيز الملف…",
            "separate" => "فصل الموسيقى عن الصوت…",
            "effects" => "تنقية وتحسين…",
            "encode" => "ترميز الناتج…",
            _ => "معالجة…",
        };
        status.borrow_mut().set(cfg, ar.to_string(), false);
    };
    let processed = pipeline::process_file(
        // Results land in the user's results folder — the same place the
        // browser bridge puts them — NOT in our scratch dir. That was the bug
        // behind the 150MB of "temporary" files the owner found in AppData:
        // the delivered artefact was being written to the scratch folder and
        // never cleaned (2026-09-11).
        &input,
        &results,
        mode,
        kind,
        false,
        true,
        s.cuda,
        None,
        &prog,
        &stage,
    );
    let out = match processed {
        Ok(o) => o,
        Err(e) => {
            status.borrow_mut().set(cfg, format!("✗ فشلت المعالجة: {e}"), true);
            // A Telegram-sent copy is ours (the guard removes it); a link
            // download is kept for inspection, exactly like the bridge does.
            if matches!(source, Source::Link(_)) {
                let _ = std::fs::remove_file(&input);
            }
            return;
        }
    };

    // 4. Pick the artifact and decide how to deliver it.
    let produced = out
        .video
        .clone()
        .or_else(|| out.vocals.clone())
        .or_else(|| out.instrumental.clone());
    let Some(produced) = produced else {
        status.borrow_mut().set(cfg, "✗ لم ينتج ملف".into(), true);
        return;
    };
    let has_video = produced
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("mp4"))
        .unwrap_or(false);
    let bytes = std::fs::metadata(&produced).map(|m| m.len()).unwrap_or(0);
    let plan = plan_delivery(bytes, duration, has_video, cfg.audio_only, cfg.is_local());

    let to_send: PathBuf = match plan {
        Delivery::Video => produced.clone(),
        Delivery::VideoShrunk { target_kbps } => {
            status.borrow_mut().set(
                cfg,
                format!(
                    "🗜️ الناتج {} — أضغطه ليدخل في حد تيليجرام…",
                    human_mb(bytes)
                ),
                true,
            );
            let shrunk = scratch.join(format!("tg_{}_small.mp4", nanos()));
            scratch_files.track(&shrunk);
            let height = info
                .as_ref()
                .and_then(|i| i.height)
                .map(|h| h.min(720));
            match crate::media::transcode_to_bitrate(&produced, &shrunk, target_kbps, AUDIO_KBPS, height)
            {
                Ok(p) => {
                    let small = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    if small > CLOUD_SEND_MAX_BYTES {
                        // Still over: the honest fallback is the audio track.
                        match audio_fallback(cfg, &produced, &scratch, &mut scratch_files) {
                            Some(a) => a,
                            None => {
                                status.borrow_mut().set(cfg, "✗ تعذر تصغير الناتج ليدخل في حد تيليجرام".into(), true);
                                return;
                            }
                        }
                    } else {
                        p
                    }
                }
                Err(e) => {
                    tracing::warn!(target: "telegram", "transcode failed: {e}");
                    match audio_fallback(cfg, &produced, &scratch, &mut scratch_files) {
                        Some(a) => a,
                        None => {
                            status.borrow_mut().set(cfg, format!("✗ تعذر ضغط الناتج: {e}"), true);
                            return;
                        }
                    }
                }
            }
        }
        Delivery::Audio => {
            if has_video {
                match audio_fallback(cfg, &produced, &scratch, &mut scratch_files) {
                    Some(a) => a,
                    None => {
                        status.borrow_mut().set(cfg, "✗ تعذر استخراج الصوت".into(), true);
                        return;
                    }
                }
            } else {
                produced.clone()
            }
        }
    };

    // 5. Send it.
    let bytes_out = std::fs::metadata(&to_send).map(|m| m.len()).unwrap_or(0);
    if !cfg.is_local() && bytes_out > CLOUD_SEND_MAX_BYTES {
        status.borrow_mut().set(
            cfg,
            format!(
                "✗ الناتج {} يتجاوز حد الإرسال ({}).",
                human_mb(bytes_out),
                human_mb(CLOUD_SEND_MAX_BYTES)
            ),
            true,
        );
        return;
    }
    status.borrow_mut().set(cfg, "📤 جارٍ الإرسال…".into(), true);
    let caption = format!(
        "🎧 HaramLite — أُزيلت الموسيقى ({})\nالوضع: {}",
        human_mb(bytes_out),
        if mode == Mode::Song { "أغنية" } else { "مقطع عادي" }
    );
    match send_media(cfg, chat_id, &to_send, &caption) {
        Ok(()) => {
            status.borrow_mut().set(
                cfg,
                format!("✅ تم — {} في {:.0} ثانية", human_mb(bytes_out), out.seconds),
                true,
            );
        }
        Err(e) => {
            status.borrow_mut().set(cfg, format!("✗ فشل الإرسال: {e}"), true);
        }
    }
    // Housekeeping: a downloaded link source is ours, not the user's, and the
    // processed result already exists — drop it (same P2 rule as the bridge).
    // A Telegram-sent copy is removed by the guard on the way out.
    if matches!(source, Source::Link(_)) {
        let _ = std::fs::remove_file(&input);
    }
}

/// Extract a compact mp3 beside the produced file (cloud fallback path). The
/// output is disposable — the guard deletes it when the job ends.
fn audio_fallback(
    cfg: &TgConfig,
    video: &Path,
    scratch: &Path,
    guard: &mut ScratchGuard,
) -> Option<PathBuf> {
    let _ = cfg;
    match crate::media::extract_audio(video, "mp3", scratch) {
        Ok(p) => {
            guard.track(&p);
            Some(p)
        }
        Err(e) => {
            tracing::warn!(target: "telegram", "audio fallback failed: {e}");
            None
        }
    }
}

fn format_duration(secs: f64) -> String {
    let total = secs.max(0.0) as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// File names arrive from the network: keep the extension, drop everything a
/// path could hide behind.
fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() {
        format!("input_{}", nanos())
    } else {
        trimmed.chars().take(96).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_gate_blocks_everyone_until_the_owner_is_set() {
        let mut cfg = TgConfig {
            token: "t".into(),
            owner_id: None,
            audio_only: false,
            local_url: None,
        };
        assert!(!cfg.allows(12345), "no id configured ⇒ nobody is allowed");
        cfg.owner_id = Some(12345);
        assert!(cfg.allows(12345));
        assert!(!cfg.allows(999), "another user must never be processed");
    }

    #[test]
    fn local_url_is_normalised_and_switches_the_transport() {
        let mut s = Settings::default();
        s.telegram_token = " 123:abc ".into();
        s.telegram_local_url = "127.0.0.1:8081/".into();
        let cfg = TgConfig::from_settings(&s);
        assert_eq!(cfg.token, "123:abc");
        assert_eq!(cfg.local_url.as_deref(), Some("http://127.0.0.1:8081"));
        assert_eq!(cfg.api(), "http://127.0.0.1:8081/bot123:abc");
        assert!(cfg.is_local());
        let cloud = TgConfig::from_settings(&Settings::default());
        assert_eq!(cloud.api(), "https://api.telegram.org/bot");
        assert!(!cloud.usable());
    }

    #[test]
    fn a_long_video_is_not_rendered_for_the_cloud() {
        // 3 min fits comfortably; an hour cannot carry a watchable picture.
        assert!(video_worth_rendering(180.0, false));
        assert!(!video_worth_rendering(3600.0, false));
        // The local server lifts the cap ⇒ always worth rendering.
        assert!(video_worth_rendering(3600.0, true));
        // Unknown duration must not block the job.
        assert!(video_worth_rendering(0.0, false));
    }

    #[test]
    fn delivery_only_shrinks_when_the_file_really_does_not_fit() {
        let small = 20 * 1024 * 1024;
        let big = 120 * 1024 * 1024;
        assert_eq!(plan_delivery(small, 180.0, true, false, false), Delivery::Video);
        assert_eq!(
            plan_delivery(big, 180.0, true, false, false),
            Delivery::VideoShrunk { target_kbps: crate::media::target_video_kbps(180.0, CLOUD_TARGET_MB, AUDIO_KBPS) }
        );
        // An hour cannot fit ⇒ audio, and the same for the audio-only pref.
        assert_eq!(plan_delivery(big, 3600.0, true, false, false), Delivery::Audio);
        assert_eq!(plan_delivery(small, 180.0, true, true, false), Delivery::Audio);
        // No video stream at all ⇒ audio.
        assert_eq!(plan_delivery(small, 180.0, false, false, false), Delivery::Audio);
        // Local server ⇒ never shrink, never fall back.
        assert_eq!(plan_delivery(big, 3600.0, true, false, true), Delivery::Video);
        // A zero-byte probe must not be mistaken for "fits".
        assert!(matches!(
            plan_delivery(0, 180.0, true, false, false),
            Delivery::VideoShrunk { .. }
        ));
    }

    #[test]
    fn mode_buttons_round_trip() {
        assert_eq!(
            parse_mode_action("mode:song:abc123"),
            Some(("abc123".to_string(), Mode::Song))
        );
        assert_eq!(
            parse_mode_action("mode:clip:abc123"),
            Some(("abc123".to_string(), Mode::Clip))
        );
        assert_eq!(parse_mode_action("mode:weird:abc"), None);
        assert_eq!(parse_mode_action("mode:song:"), None);
        assert_eq!(parse_mode_action("cancel:1"), None);
    }

    #[test]
    fn links_are_found_but_bare_schemes_are_not() {
        assert_eq!(
            find_url("شوف هذا https://youtu.be/abcDEF123 خلّني أسمعه"),
            Some("https://youtu.be/abcDEF123".to_string())
        );
        assert_eq!(find_url("no link here"), None);
        assert_eq!(find_url("https://"), None);
        assert_eq!(find_url("http://a.io/x?y=1&z=2, ok"), Some("http://a.io/x?y=1&z=2,".to_string()));
    }

    #[test]
    fn message_parsing_prefers_the_file_over_its_caption() {
        let msg = json!({
            "from": { "id": 7 },
            "chat": { "id": 7 },
            "caption": "https://example.com/not-a-job",
            "video": { "file_id": "AAA", "file_name": "song.mp4", "file_size": 1234 }
        });
        let (from, chat, inc) = parse_message(&msg).unwrap();
        assert_eq!((from, chat), (7, 7));
        assert_eq!(
            inc,
            Incoming::Job(Source::File { file_id: "AAA".into(), name: "song.mp4".into(), size: 1234 })
        );

        let link = json!({ "from": { "id": 5 }, "chat": { "id": 5 }, "text": "https://youtu.be/x" });
        assert!(matches!(parse_message(&link).unwrap().2, Incoming::Job(Source::Link(_))));

        let hi = json!({ "from": { "id": 5 }, "chat": { "id": 5 }, "text": "/start" });
        assert!(matches!(parse_message(&hi).unwrap().2, Incoming::Smalltalk(_)));
    }

    #[test]
    fn tokens_are_redacted_from_any_outgoing_text() {
        let cfg = TgConfig {
            token: "88360566:AAH_supersecret_part".into(),
            owner_id: Some(7),
            audio_only: false,
            local_url: None,
        };
        // The exact shape ureq produces: URL first, then the reason.
        let leaky = format!(
            "https://api.telegram.org/bot{}/getUpdates: Connection Failed",
            cfg.token
        );
        let safe = redact(&cfg.token, leaky);
        assert!(!safe.contains("AAH_supersecret_part"), "token survived: {safe}");
        assert!(safe.contains("محجوب"));
        assert!(safe.starts_with("https://api.telegram.org/bot<"), "context kept: {safe}");
        // Text without the token is never touched.
        assert_eq!(redact(&cfg.token, "نص عادي".into()), "نص عادي");
        // An empty token must not panic or swallow the message.
        assert_eq!(redact("", "خطأ".into()), "خطأ");
    }

    #[test]
    fn scratch_guard_deletes_what_it_tracked_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("hl_tg_guard_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let mine = dir.join("mine_small.mp4");
        let other = dir.join("someone_elses.mp4");
        std::fs::write(&mine, b"x").unwrap();
        std::fs::write(&other, b"y").unwrap();
        {
            let mut g = ScratchGuard::default();
            g.track(&mine);
        } // dropped here — every job exit path goes through this
        assert!(!mine.exists(), "a tracked transient must be gone after the job");
        assert!(other.exists(), "an untracked file must never be touched");
        let _ = std::fs::remove_file(&other);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn clear_scratch_empties_files_and_nested_dirs_and_tolerates_missing() {
        let dir = std::env::temp_dir().join(format!("hl_tg_clear_{}", std::process::id()));
        let sub = dir.join("_haramlite_work");
        let _ = std::fs::create_dir_all(&sub);
        std::fs::write(dir.join("leftover.mp3"), b"1").unwrap();
        std::fs::write(sub.join("leftover.wav"), b"2").unwrap();
        clear_scratch(&dir);
        assert_eq!(
            std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(99),
            0,
            "the scratch dir must be empty (this was the 150MB leak)"
        );
        clear_scratch(&dir); // idempotent on an empty dir
        clear_scratch(&std::env::temp_dir().join("hl_tg_missing_dir_xyz")); // and on a missing one
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole pairing flow in ONE test on purpose: the pair slot is
    /// process-global, so parallel tests would stomp on each other's codes.
    #[test]
    fn pairing_flow_is_one_shot_and_budgeted() {
        // 1. A fresh code is six digits, and never a constant.
        let first = pairing_code(true)["code"].as_str().unwrap().to_string();
        let second = pairing_code(true)["code"].as_str().unwrap().to_string();
        assert_eq!(first.len(), PAIR_DIGITS);
        assert!(first.chars().all(|c| c.is_ascii_digit()));
        assert_ne!(first, second, "a regenerated code must differ");

        // 2. Non-code chatter is not an attempt (strangers must not burn it).
        assert!(matches!(check_pairing_code("مرحبا"), PairTry::NotAnAttempt));
        assert!(matches!(check_pairing_code(""), PairTry::NotAnAttempt));

        // 3. Guessing is budgeted, and the budget ends the code's life.
        let wrong = if second == "000000" { "000001" } else { "000000" };
        for i in 0..(PAIR_MAX_FAILS - 1) {
            let expect = PAIR_MAX_FAILS - 1 - i;
            match check_pairing_code(wrong) {
                PairTry::Wrong { fails_left } => assert_eq!(fails_left, expect, "attempt {i}"),
                other => panic!("expected Wrong, got {:?}", matches!(other, PairTry::Ok)),
            }
        }
        assert!(matches!(
            check_pairing_code(wrong),
            PairTry::Wrong { fails_left: 0 }
        ));
        // Burnt: even the true code is worthless now, and guesses are not
        // attempts any more (no code exists to attack).
        assert!(matches!(check_pairing_code(&second), PairTry::NotAnAttempt));
        assert!(matches!(check_pairing_code(wrong), PairTry::NotAnAttempt));

        // 4. A newly issued code works exactly once.
        let third = pairing_code(true)["code"].as_str().unwrap().to_string();
        assert!(matches!(check_pairing_code(&third), PairTry::Ok));
        assert!(
            matches!(check_pairing_code(&third), PairTry::NotAnAttempt),
            "a consumed code must never pair a second account"
        );

        // 5. The status surface tells the UI whether a code is live.
        let _ = pairing_code(true);
        let st = status_json();
        assert_eq!(st["pairing_code_active"], json!(true));
        assert_eq!(st["cloud_download_max_mb"], json!(20));
        assert_eq!(st["cloud_send_max_mb"], json!(50));
        forget_pairing_code();
        assert_eq!(status_json()["pairing_code_active"], json!(false));
    }

    /// Negative test for ٤.ب.٩: the two sites that take the settings lock PAIR
    /// (`pairing_code`, `status_json`) must take them in ONE order — pair_slot
    /// before status. Taken the other way round in either site, two threads can
    /// hold one lock each and wait for the other forever. Probe: while this
    /// thread holds `status`, a thread inside `status_json` must already hold
    /// pair_slot (= it is parked on the second lock, not on the first).
    #[test]
    fn status_json_takes_pair_slot_before_status() {
        // Several attempts: a child that has not been scheduled yet looks
        // exactly like one that took `status` first.
        let mut pair_slot_taken_first = false;
        for _ in 0..10 {
            let held_status = status().lock().unwrap_or_else(|p| p.into_inner());
            let finished = Arc::new(AtomicBool::new(false));
            let flag = finished.clone();
            let child = std::thread::spawn(move || {
                let _ = status_json();
                flag.store(true, Ordering::SeqCst);
            });
            std::thread::sleep(Duration::from_millis(50));
            let parked_on_status = !finished.load(Ordering::SeqCst);
            let holds_pair_slot = pair_slot().try_lock().is_err();
            drop(held_status); // let the child through, whatever it did
            let _ = child.join();
            assert!(finished.load(Ordering::SeqCst), "the child must finish once status is free");
            if parked_on_status && holds_pair_slot {
                pair_slot_taken_first = true;
                break;
            }
        }
        assert!(pair_slot_taken_first, "status_json must take pair_slot BEFORE status (٤.ب.٩)");
    }

    #[test]
    fn network_filenames_cannot_escape_the_scratch_dir() {        assert_eq!(sanitize_name("../../evil.exe"), "evil.exe");
        assert_eq!(sanitize_name("C:\\Windows\\system32\\cmd.exe"), "cmd.exe");
        assert_eq!(sanitize_name("song (official) [4K].mp4"), "song__official___4K_.mp4");
        assert!(sanitize_name("...").starts_with("input_"));
        assert!(sanitize_name("").starts_with("input_"));
    }

    /// The riskiest assumption in this module: that ureq sends our explicit
    /// Content-Length instead of switching to chunked encoding (Telegram's edge
    /// rejects/limits chunked uploads unpredictably). Verified against a real
    /// socket, offline.
    #[test]
    fn multipart_upload_declares_content_length_and_never_chunks() {
        use std::io::Write;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            // Read until the header terminator AND the start of the first body part.
            // A single read() is not guaranteed to return the whole request: on some
            // hosts (loopback segmentation changes with VPN/filter drivers) it returns
            // only the headers, so the body assertion below would fail for reasons
            // that have nothing to do with the code under test.
            let mut buf: Vec<u8> = Vec::with_capacity(8192);
            let mut chunk = [0u8; 4096];
            loop {
                let n = match sock.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                buf.extend_from_slice(&chunk[..n]);
                let body_start = buf
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map(|i| i + 4);
                if let Some(p) = body_start {
                    // 128 bytes into the body covers "--<boundary>" + the first
                    // Content-Disposition line, which is what the test asserts on.
                    if buf.len() >= p + 128 {
                        break;
                    }
                }
                if buf.len() > 64 * 1024 {
                    break; // never hang the test on a malformed request
                }
            }
            let head = String::from_utf8_lossy(&buf).to_string();
            let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}");
            std::thread::sleep(Duration::from_millis(120));
            head
        });

        let tmp = std::env::temp_dir().join(format!("hl_tg_mp_{}.bin", std::process::id()));
        std::fs::write(&tmp, vec![7u8; 1024]).unwrap();
        let fields = vec![("chat_id", "42".to_string()), ("caption", "hi".to_string())];
        let body = MultipartBody::build(&fields, "video", "a.mp4", "video/mp4");
        let expect_len =
            body.head.len() as u64 + 1024 + body.tail.len() as u64;
        let f = std::fs::File::open(&tmp).unwrap();

        let url = format!("http://{addr}/botTEST/sendVideo");
        let _ = post_file(&url, &body, f, 1024, Duration::from_secs(10), "TEST");
        let head = server.join().unwrap();

        let lower = head.to_ascii_lowercase();
        assert!(lower.starts_with("post /bottest/sendvideo http/1.1"), "got: {head}");
        assert!(
            lower.contains(&format!("content-length: {expect_len}")),
            "exact Content-Length must be declared ({expect_len}): {head}"
        );
        assert!(
            !lower.contains("transfer-encoding"),
            "must never fall back to chunked: {head}"
        );
        assert!(lower.contains("multipart/form-data; boundary=----haramliteboundary"));
        assert!(head.contains("name=\"chat_id\""));
        let _ = std::fs::remove_file(&tmp);
    }
}
