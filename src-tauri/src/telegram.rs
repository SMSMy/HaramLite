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

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::pipeline::{Mode, OutFormat, OutKind};
use crate::settings::Settings;
use crate::slots;

// ── caps (core.telegram.org/bots/api) ───────────────────────────────────────
/// Hard cloud cap on anything a bot sends.
pub const CLOUD_SEND_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// Hard cloud cap on what a bot may download from a user's message.
pub const CLOUD_DOWNLOAD_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// We aim well under `CLOUD_SEND_MAX_BYTES`: the container adds overhead and a
/// rejected upload is worse than a slightly smaller file.
pub const CLOUD_TARGET_MB: f64 = 40.0;
/// حدّ أعلى **صريح** لعدد الملفات المعلَّقة في المحادثة الواحدة (بانتظار اختيار
/// الوضع). بدونه ينمو السِجلّ بلا سقف، ومع بلوغه يُقال للمستخدم صراحةً
/// «أكمل الملفات الحالية أولاً» — لا إسقاط صامت ولا نموّ أبدي.
pub const MAX_PENDING_PER_CHAT: usize = 10;
/// صلاحية سؤال تجاوز السقف: بعده لا يُنفَّذ ضغطٌ قديم (ضغطة على سؤال منسيّ
/// تُجاب بصراحة)، **والناتج يبقى في مجلد النتائج** — لا حذف (شرط قبول م٣).
pub const OVERSIZE_TTL: Duration = Duration::from_secs(30 * 60);
/// Video-bitrate floor under which the picture is not worth sending.
pub use crate::media::MIN_WATCHABLE_VIDEO_KBPS;
const AUDIO_KBPS: u32 = 96;
const LONG_POLL_SECS: u64 = 25;
/// Telegram tolerates roughly one edit/second per chat; edits are cosmetic, so
/// they are throttled hard to leave room for real API calls.
const EDIT_MIN_GAP: Duration = Duration::from_secs(3);
/// Local Bot API server default port (telegram-bot-api).
pub const LOCAL_SERVER_HINT: &str = "http://127.0.0.1:8081";
/// كم ينتظر `/kill` قبل أن يجيب (م٢): الانتظار **محدود**، وبعد انتهائه يقول
/// الحقيقة («طُلب الإلغاء…») بدل وعد لا يُضمن.
///
/// **وقُصِّر من ٢٠ ث إلى ٢ ث (م٢/إصلاح)**: هذا الانتظار يقع على **خيط تحديثات
/// البوت**، فكل `/kill` كان **يحجب كل أوامر المحادثة** حتى ٢٠ ث — وأوامر أخرى
/// (‏`/status` · `/kill` ثانٍ) لا تُقرأ إلا بعدها. والمهلة القصيرة تكفي للحالة
/// الغالبة (العمليات المنفصلة تُقتل في أجزاء الثانية)، وإن كانت المهمّة داخل
/// نداء المحرّك فالجواب الصادق يصل فوراً بدل انتظارٍ لا يغيّر شيئاً (النداء
/// غير قابل للقطع أصلاً).
pub const CANCEL_CONFIRM_WAIT: Duration = Duration::from_secs(2);
/// الحدّ المعلَن للمستخدم لسقوط المهمّة بعد طلب الإلغاء وهي داخل نداء المحرّك
/// (ONNX غير قابل للقطع داخل العملية) — **مشتقّ من المقيس لا مكتوب بيد**:
/// [`crate::pipeline::ENGINE_CALL_CEILING_SECS`] هو الرقم الواحد الذي تقرؤه
/// الواجهة أيضاً، وحارس تكافؤ يمنع تباعدهما (`src/__tests__/stopCeiling.parity.test.ts`).
///
/// **وسابقة مُصلَحة**: كان هنا `150` وفي الواجهة `141` — **رقمان مختلفان لنفس
/// الحالة**، وكلاهما من عيّنة ١٤٠ ث قديمة أقلّ من أطول ما قيس بأكثر من ثلاث
/// مرات. فالثابت الآن واحد، والصياغة تقول «أطول ما قيس» لا «≤ كذا ث».
pub const INFERENCE_BAIL_HINT_SECS: u64 = crate::pipeline::ENGINE_CALL_CEILING_SECS;
/// **النصّ النهائي الواحد للإلغاء** — تُستعمله المواضع الثلاثة: جواب الزرّ،
/// وجواب `/kill`، والتعديل النهائي لرسالة الحالة. فواحدٌ لا ثلاثة، والشاشة
/// تقول الشيء نفسه حيث نظر المستخدم.
pub(crate) const CANCELLED_TEXT: &str = "🛑 أُلغيت";
/// **أطول زمن مقيس لإلغاء مهمّة في مرحلة التحضير** (تنزيل رابط أو استلام ملف)
/// — أجزاء من الثانية لا دقائق، لأن أدوات التحضير (yt-dlp/ffmpeg) عمليات فرعية
/// **مسجَّلة في سياق المهمّة وموضوعة في مهمّة نواة** فيقتلها `cancel_job` مع
/// شجرتها كاملة (`proc::kill_children`).
///
/// ## من أين جاء الرقم — قياس حيّ على الأداة الحقيقية (م٣/إصلاح٢)
///
/// **القياس**: `yt-dlp` الحقيقي (‏`bin/yt-dlp.exe` بعمليّتين: مُشغّل + عامل)،
/// تنزيل حقيقي من يوتيوب، ثم إلغاء من السِجلّ (`slots::cancel_job` — نفس مسار
/// زرّ تلغرام و`/kill`) فور أول سطر تقدّم:
/// **٢٢٧ · ٢١٦ · ٢١٨ · ٢١٨ مللي** في أربعة تشغيلات ⇒ **أطول ما قيس ٢٢٧ مللي**،
/// وصار الرقم المعلن **٠.٣ ث** (تقريب لأعلى إلى عُشر). والحارس المعزول
/// `yt_dlp::tests::live_cancel_during_a_real_download_measures_the_true_kill_time`
/// يعيد هذا القياس، **وجردُه في كل تشغيل: عمليّتا yt-dlp قبل الإلغاء ⇒ صفر
/// بعدهما**.
///
/// ## و**الرقم السابق (٣.٦ ث) كان مبنيّاً على إسناد سبب خاطئ**
///
/// قِيس في م٣ أنه كان **خروج yt-dlp نفسه بخطأ شبكة** (‏`exit code: 1`) لا
/// قتلاً — أي قياسٌ صحيح بآلية مفهومة خطأً. فأُبطل الرقم، وهذا بديله مقيساً.
///
/// ## ولا يُخفَّض ولا يُرفع بلا قياس
///
/// حارس `the_prepare_phase_cancel_reply_carries_a_measured_number` يقيس الإلغاء
/// **من مسار التنزيل الإنتاجي نفسه** (`download_media` بثنائي مزيّف نائم — لا
/// بديل يشبهه) ويسقط إن تجاوز الرقم، ويسقط إن خرج الرقم من نطاق «القتل الفوري»
/// (‏< ١ ث) فيصير سقفاً مطّاطاً بلا قياس.
pub const CANCEL_PREPARE_WORST_SECS: f64 = 0.3;

// ── م٤: المجموعات — الحدود المقيسة من توثيق تلغرام نفسه ─────────────────────
/// سقف الإرسال في المجموعة (‏core.telegram.org/bots/faq): **≈٢٠ رسالة/دقيقة**،
/// و**≈رسالة/ثانية** للمحادثة الواحدة. الرقمان مكتوبان هنا صراحةً ليُقرآ من
/// الشيفرة لا من نيّة، ويُفرَضان على **كل** إرسال وتعديل في محادثة معرّفها سالب
/// (مجموعة) عبر [`SendPacer`] — وتعديلات التقدّم تمرّ أصلاً ببوّابة الرسالة
/// ([`status_push`]) فلا خيط يكتب بلا حدّ.
pub const GROUP_MSG_PER_MINUTE: usize = 20;
/// أدنى فرق بين رسالتين في المحادثة نفسها.
pub const GROUP_MIN_GAP: Duration = Duration::from_secs(1);

/// حدود `setMyCommands` في Bot API: **١٠٠ أمر** كحدّ أقصى · اسم الأمر **١–٣٢**
/// (إنجليزي صغير/أرقام/`_`) · وصفه **١–٢٥٦**. تُفحَص على [`COMMANDS`] نفسها في
/// اختبار — فحدُّ الـAPI ليس نيّةً في تعليق.
pub const MAX_BOT_COMMANDS: usize = 100;
pub const MAX_COMMAND_NAME: usize = 32;
pub const MAX_COMMAND_DESC: usize = 256;

// ── م٥: هوية البوت (الاسم والصورة) ──────────────────────────────────────────

/// الاسم الذي يُطبَّق عند تفعيل «استخدم اسم HaramLite وصورته للبوت».
pub const BOT_DISPLAY_NAME: &str = "HaramLite";

/// حدّ `setMyName`: **٠–٦٤ حرفاً**، والفراغ **يزيل** الاسم المخصّص لتلك اللغة
/// ولا يُرجع الافتراضي — فلذلك يُخزَّن السابق صراحةً قبل أي تبديل.
pub const MAX_BOT_NAME: usize = 64;

/// اسم المرفق في جسم `multipart`، **ويُذكر في `attach://` نفسه**: حقل `photo`
/// في `InputProfilePhotoStatic` **نصٌّ** لا ملف، فالصورة تُرفع باسمٍ ويُشار
/// إليها بـ`attach://<الاسم>`. وشرطان بحرفٍ واحد يفترقان ⇒ يرفض تلغرام الطلب.
const BOT_PHOTO_ATTACH: &str = "photo_file";

/// صورة البوت: **JPG** لأن `InputProfilePhotoStatic` «a static profile photo
/// in the .JPG format» — والأصل في الخطة PNG فلا يُقبل.
///
/// **أمر التحويل** (‏`bin/ffmpeg.exe` · مقيس 2026-09-21):
/// ```text
/// ffmpeg -i IMG/haramless-app-icon.png -filter_complex
///   "[0:v]format=rgba,scale=512:512:flags=lanczos[fg];color=white:s=512x512[bg];[bg][fg]overlay=format=auto:shortest=1,format=yuvj420p"
///   -frames:v 1 -q:v 3 IMG/haramless-app-icon.jpg
/// ```
/// **البصمات (SHA-256)**: الأصل `IMG/haramless-app-icon.png` =
/// `07968EB2…C62145` (‏239,141 بايت · ‎1024×1024‎ · ‎rgba) · والناتج
/// `IMG/haramless-app-icon.jpg` = `6461F475…6ADC7C` (‏18,950 بايت · ‎512×512‎
/// · ‎yuvj420p). والأصل فيه شفافية حقيقية (‏`alphaextract`+`signalstats`:
/// ‏YMIN=0 · YAVG=246.245) وJPEG لا يحمل قناة ألفا، فرُكِّب على **أبيض
/// صريح** — وإلا صارت الزوايا الشفافة سوداء وتُرى في العرض الدائري.
///
/// **ولا يُدَّعى حدّ حجم/أبعاد للصورة الشخصية**: التوثيق لا يذكره (`m5-facts`
/// ١.٨)، والقياس الحقّ هو استجابة الـAPI عند أول رفع حقيقي. وما هنا **اختيارنا
/// المعلَن**: ‎512×512‎ لأن الصورة تُعرض صغيرة، و‎19KB‎ أقلّ من قاعدة الرفع
/// العامّة للصور (‎10MB‎) — وهي قاعدة **عامّة غير منصوصة** على هذه الدالّة.
const BOT_PHOTO_JPG: &[u8] = include_bytes!("../../IMG/haramless-app-icon.jpg");

/// اسم ملف الصورة في الرفع (‎.jpg‎ لأن الصيغة المطلوبة هي `.JPG`).
const BOT_PHOTO_NAME: &str = "haramless-app-icon.jpg";

/// **شكلان للرسالة الفانية لا شكل واحد**:
/// * 10.2 (١٤ يوليو ٢٠٢٦): `receiver_user_id` **مسطّحاً**؛
/// * 10.3 (٢٤ أغسطس ٢٠٢٦): **استُبدل** بكائن `ephemeral_message_parameters`
///   (نصّ سجلّ التغييرات: «replaced the parameters receiver_user_id … with the
///   parameter ephemeral_message_parameters»).
///
/// فلا يُثبَّت شكل في الشيفرة: يُجرَّب الأحدث ثم الأقدم، و**لا يُبنى عليه سلوك**
/// أصلاً — التسليم **غير مضمون** (لا يصل غير المتّصلين)، والردّ على رسالة فانية
/// يجب أن يقع خلال ١٥ ث. فالأساس هو [`notify_member`] وسقوطُه إلى **الخاص** ثم
/// إلى المحادثة نفسها، والفانية تحسينٌ لا عماد (شرط ت٨).
pub const EPHEMERAL_PARAMS_V10_3: &str = "ephemeral_message_parameters";
pub const EPHEMERAL_PARAMS_V10_2: &str = "receiver_user_id";

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

/// رمز من **عشوائية نظام** — لا من `RandomState`.
///
/// و-٧: كان التوليد يبني بذرة من `std::collections::hash_map::RandomState`
/// ممزوجة بـSplitMix64، وتعليقُه يصرّح «Entropy with no new dependency».
/// توثيق Rust نفسه يقول إن `RandomState` مُبذَّر لمقاومة تصادم التجزئة،
/// **لا ليكون سرّاً**. الرمز محميّ فعلاً بحدّ ٥ محاولات/10 دقائق، لكن
/// الأساس يجب أن يكون صحيحاً لا «كافياً عملياً».
///
/// `getrandom` كان موجوداً أصلاً في شجرة الاعتماديات (0.3.4 عبر سلسلة
/// tauri/uuid)، فأصبح اعتمادية مباشرة: لا عائلة جديدة في `Cargo.lock`.
/// الشكل لم يتغيّر: `digits` أرقام عشرية كما كان (`PAIR_DIGITS` = ٦)،
/// والحدّ الأقصى للمحاولات كما هو.
fn random_code(digits: usize) -> String {
    let mut out = String::with_capacity(digits);
    // بايتات نظام لا تنضب نظرياً؛ ومع ذلك لا سقوط إلى مصدر أضعف لو فشلت:
    // يتوقّف التوليد بما جمعه، والمتصل يرى الرمز كما هو (والحدّ الأمني
    // الحقيقي هو المحاولات لا الطول).
    let mut buf = [0u8; 64];
    while out.len() < digits {
        if getrandom::fill(&mut buf).is_err() {
            break;
        }
        for b in buf {
            if out.len() == digits {
                break;
            }
            // رفض ما فوق 249: 250 = 25×10، فكل رقم يأخذ 25 قيمة بالضبط ⇒
            // توزيع متساوٍ تماماً بلا انحياز modulo (كان `% 10` يمنح الأرقام
            // 0..5 احتمالاً 26/256 و6..9 احتمالاً 25/256).
            if b >= 250 {
                continue;
            }
            out.push(char::from(b'0' + (b % 10)));
        }
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
    let state = app
        .try_state::<crate::AppState>()
        .ok_or("حالة التطبيق غير متاحة")?;
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

/// م٤: كيف يُخاطَب البوت في **المجموعة**. وضعان لا أكثر، والمجهول يُقيَّد في
/// `settings::clamp_group_mode` قبل أن يصل إلى هنا.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GroupMode {
    /// **الافتراضيّ (قرار المالك)**: لا معالجة إلا لما خُوطب فيه البوت
    /// (منشن أو ردّ على رسالته). وما عدا ذلك **صمت** — ليس تجاهلاً، بل لأن
    /// رسالةً لا تخاطبه ليست طلباً.
    #[default]
    Mentions,
    /// الموسَّع: كل رسالة تُعرَض على **المالك في خاصّه** كبطاقة أزرار، ولا
    /// معالجة قبل ضغطته — فالموافقة تحلّ محلّ المنشن.
    All,
}

/// نوع المحادثة كما يعنينا: **خاصة** (المالك وحده) أو **مجموعة** (فيها غير
/// المالك، فتلزم قائمة السماح والأوضاع).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatKind {
    Private,
    Group,
}

/// هوية البوت من `getMe` — بها وحدها يُعرَف المنشن (`@username`) والردّ على
/// رسالة البوت. وبلا معرفةٍ لا تُدَّعى معرفة: [`PollState::identity`] يبقى
/// فارغاً و`mentions_bot` تعيد `false` بصدق.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BotIdentity {
    pub id: i64,
    pub username: String,
}

impl BotIdentity {
    fn known(&self) -> bool {
        self.id != 0 || !self.username.is_empty()
    }
}

/// The settings that actually change behaviour — compared on every
/// `set_settings` so the worker is only restarted when something moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TgConfig {
    pub token: String,
    pub owner_id: Option<i64>,
    pub audio_only: bool,
    pub local_url: Option<String>,
    /// م٤: وضع المجموعة (يُقرأ من الإعدادات ويدخل مقارنة إعادة التشغيل —
    /// تغييره يجب أن يبني عاملاً جديداً لا أن يبقى القديم).
    pub group_mode: GroupMode,
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
            group_mode: if crate::settings::clamp_group_mode(&s.telegram_group_mode)
                == crate::settings::GROUP_MODE_ALL
            {
                GroupMode::All
            } else {
                GroupMode::Mentions
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
        Delivery::VideoShrunk { target_kbps: kbps }
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

/// وسم مهمّة البوت في سِجلّ المهامّ (م٢): `telegram:<chat_id>:<user_id>`.
///
/// **لماذا الوسم لا معرّف المهمّة وحده**: `/kill` يجب أن يُلغي مهمّة **مَن
/// أرسلها** لا مهمّة غيره. والوسم هو ما يجعل المهمّة قابلة للعثور عليها من
/// الخيط الذي يعالج التحديث، بلا حالة إضافية تُزامَن.
///
/// **ولماذا `<user_id>` أُضيف في م٤**: مجموعةٌ فيها عشرة أعضاء كلّهم بوسم
/// `telegram:<chat>` واحد تعني أن `/kill` واحداً — أو ضغطة زرّ — تُلغي مهامّ
/// **الجميع**. والفصل بالمستخدم هو ما يجعل «لا يُلغي أحدٌ مهمّة غيره» صحيحاً
/// بالبناء لا بالوعد.
fn job_label(chat_id: i64, user_id: i64) -> String {
    format!("telegram:{chat_id}:{user_id}")
}

/// بادئة مهامّ محادثةٍ بعينها — كل مستخدميها. تُقرأ بها `/status` (للمالك).
fn chat_label_prefix(chat_id: i64) -> String {
    format!("telegram:{chat_id}:")
}

/// هل هذه المحادثة مجموعة؟ تلغرام يعطي المجموعات والقنوات معرّفات **سالية**،
/// والمعرّف الموجب محادثة خاصة. الشرط واحد في كل الملف.
fn is_group_chat(chat_id: i64) -> bool {
    chat_id < 0
}

/// نوع المحادثة من التحديث: `chat.type` إن وُجد، وإلا فالإشارة الرقمية —
/// فاختبارٌ يبني مجموعةً بمعرّف سالب بلا حقل نوع لا يُقرأ خاصاً.
fn chat_kind_of(chat_id: i64, msg: &Value) -> ChatKind {
    match msg.pointer("/chat/type").and_then(Value::as_str) {
        Some("private") => ChatKind::Private,
        Some("group" | "supergroup" | "channel") => ChatKind::Group,
        _ if is_group_chat(chat_id) => ChatKind::Group,
        _ => ChatKind::Private,
    }
}

/// معرّفات المهامّ النشطة **لهذا المستخدم في هذه المحادثة** (وسم
/// `telegram:<chat_id>:<user_id>`).
fn active_job_ids(chat_id: i64, user_id: i64) -> Vec<u64> {
    let want = job_label(chat_id, user_id);
    slots::active_jobs()
        .into_iter()
        .filter(|j| j.label == want)
        .map(|j| j.id)
        .collect()
}

/// معرّفات مهامّ **المحادثة كلها** — كل مستخدميها. يقرؤها `/kill` من المالك
/// وحده (و`/status`)، ولا يقرؤها زرٌّ ولا أمرُ عضو.
fn active_job_ids_in_chat(chat_id: i64) -> Vec<u64> {
    let prefix = chat_label_prefix(chat_id);
    slots::active_jobs()
        .into_iter()
        .filter(|j| j.label.starts_with(&prefix))
        .map(|j| j.id)
        .collect()
}

/// زر الإلغاء على رسالة التقدّم: `cancel:<chat_id>:<user_id>` — نفس معنى
/// `/kill` حرفاً، **وموثَّقٌ بصاحبه**: ضغطة من غيره تُرفض قبل أن تصل إلى السِجلّ.
fn cancel_button(chat_id: i64, user_id: i64) -> Value {
    json!({
        "inline_keyboard": [[
            { "text": "🛑 إلغاء", "callback_data": format!("cancel:{chat_id}:{user_id}") }
        ]]
    })
}

/// يقرأ `cancel:<chat_id>:<user_id>`. الشكل القديم `cancel:<chat_id>` بلا صاحب
/// **لا يُقبل**: بلا صاحبٍ لا يمكن مصادقة الضغطة، والقبول يعني إلغاء مهامّ
/// الجميع (وهو الفرق بين ت٢ وت٥).
fn parse_cancel_button(data: &str) -> Option<(i64, i64)> {
    let rest = data.strip_prefix("cancel:")?;
    let mut it = rest.split(':');
    let chat: i64 = it.next()?.trim().parse().ok()?;
    let user: i64 = it.next()?.trim().parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((chat, user))
}

/// **لوحة فارغة صراحةً** — إزالة الأزرار تُطلَب ولا تُترك لسلوك ضمني.
///
/// **عطل ميداني (بلاغ المالك)**: كان زرّ الإلغاء يظهر «لثانية واحدة أو أقل ثم
/// يختفي»؛ والسبب أن تعديل رسالة الحالة لم يكن يمرّر `reply_markup` — وتلغرام
/// يحذف لوحة الأزرار عند تعديلٍ لا لوحة فيه. والعلاج من الطرفين: كل تعديل
/// **يمرّر لوحته صراحةً** (زرّ الإلغاء وهو جارية، وفارغةً عند الانتهاء)، فلا
/// يبقى السلوك معلَّقاً على تفصيلٍ في الـAPI.
fn no_keyboard() -> Value {
    json!({ "inline_keyboard": [] })
}

/// ينفّذ الإلغاء ويعيد **نصّاً صادقاً**: لا يقول «أُلغيت» إلا إذا فرغت المهمّة
/// فعلاً من السِجلّ. و`cancel_job` وحده يعيد «سُجِّل الطلب» لا «توقّف العمل»،
/// والفرق بينهما دقائق ممكنة داخل نداء المحرّك (ONNX غير قابل للقطع).
///
/// `pub(crate)` لأن قياس **زمن الحجب** يحتاج سِجلّ المهامّ الحقيقي، ومرافقه في
/// `slots::tests` حيث يوجد (`registry_lock` + `run_registered`).
///
/// **م٤**: الإلغاء صار **لمستخدمٍ بعينه** (`user_id`) لا لكل مهامّ المحادثة —
/// وهو نصّ «لا يُلغي أحدٌ مهمّة غيره» في مسار `/kill`.
pub(crate) fn cancel_chat_jobs(chat_id: i64, user_id: i64) -> String {
    cancel_chat_jobs_with(chat_id, user_id, CANCEL_CONFIRM_WAIT)
}

/// نفس العمل بمهلة انتظار صريحة — والمنتَج ينادي [`cancel_chat_jobs`] بمهلة
/// [`CANCEL_CONFIRM_WAIT`]، وهذه تُقاس بها **نصوص المراحل** بلا انتظار ثانيتين
/// في كل فحص (والمهلة لا تغيّر النصّ، بل تُغيّر جواب «هل فرغت فعلاً؟»).
///
/// **و`cancel_job` لكل معرّف — لا `cancel_all`** (شرط ت٥): `cancel_all` يوقف
/// كل ما على الجهاز (ومنها مهامّ الواجهة والجسر ومستخدمٍ آخر)، وهو عكس المطلوب.
pub(crate) fn cancel_chat_jobs_with(chat_id: i64, user_id: i64, wait: Duration) -> String {
    cancel_ids(&active_job_ids(chat_id, user_id), wait)
}

/// **`/kill` من المالك**: يوقف مهامّ **المحادثة كلها** — المالك صاحب الجهاز،
/// وأمره يوقف ما يجري في محادثته.
///
/// **وحدُّه**: لا يمسّ محادثةً أخرى ولا مهمّة الواجهة/الجسر/CLI. وهذا فرقُه عن
/// [`slots::cancel_all`] — والأخير يوقف **كل** ما على الجهاز، ومنه عمل
/// المستخدم نفسه في نافذة أخرى (وهو ما يمنعه حارس ت٥).
///
/// **وأما الضغطة على زرّ** فتبقى لصاحب المهمّة أو المالك وحدهم (ت٢)، والأمرُ
/// لا يغيّر ذلك: العضو لا يملك `/kill` أصلاً (ت٧).
pub(crate) fn cancel_chat_all_jobs(chat_id: i64) -> String {
    cancel_ids(&active_job_ids_in_chat(chat_id), CANCEL_CONFIRM_WAIT)
}

/// النواة الواحدة للإلغاء: `cancel_job` لكل معرّف — **لا `cancel_all`**.
fn cancel_ids(ids: &[u64], wait: Duration) -> String {
    if ids.is_empty() {
        return "لا مهمّة جارية".to_string();
    }
    let mut marked = 0;
    for id in ids {
        if slots::cancel_job(*id) {
            marked += 1;
        }
    }
    if marked == 0 {
        return "لا مهمّة جارية".to_string();
    }
    // الانتظار **محدود**: بعد انتهائه نقول الحقيقة لا الوعد. **والمرحلة تُقرأ
    // من السِجلّ** (م٣/إصلاح)، فلا يُقال «بعد انتهاء نداء المحرّك» لمهمّة ما
    // زالت تنزّل: عدد صادق لمرحلةٍ صادقة.
    let gone = slots::wait_until_gone(ids, wait);
    cancel_reply(gone, slots::phase_of(ids))
}

/// الجواب الواحد بعد طلب الإلغاء — دالّة **نقيّة** لتُقاس بلا مهمّة حقيقية،
/// ولئلا يفترق نصّان لنفس الحالة.
///
/// **والنصّ بحسب المرحلة** (م٣/إصلاح): كان نصّاً واحداً يقول دائماً «سيتوقّف بعد
/// انتهاء نداء المحرّك الجاري… أطول ما قيس ٩.٤ دقيقة» — **حتى في مرحلة
/// التنزيل**، والمدقّق قاس الإلغاء هناك **٣.٦ ث** فعلية (قتل `yt-dlp`/`ffmpeg`
/// فوريّ). فالآن:
/// * [`slots::JobPhase::Preparing`] ⇒ الرقم المقيس لتلك المرحلة
///   ([`CANCEL_PREPARE_WORST_SECS`])، ويُقال إن الأدوات تُقتل فوراً (وهو صحيح
///   هناك وحده — لا يُقال عن نداء المحرّك).
/// * [`slots::JobPhase::Processing`] ⇒ الحدّ الصادق لتلك المرحلة:
///   [`INFERENCE_BAIL_HINT_SECS`] لنداء المحرّك الذي لا يُقطع داخل العملية،
///   و[`slots::DEFAULT_WAIT`] لفتحة الجهاز التي قد تنتظرها (والانتظار لا يقرأ
///   رمز الإلغاء، فذكره صدقٌ لا زيادة).
///
/// **ولا يُقال «فوراً»** عن نداء المحرّك (نصيحة المالك): هو نداء واحد داخل
/// العملية لا نقطة إلغاء فيه، فالصياغة تقول **«أطول ما قيس»** وتُصرّح بأنّ
/// الغالب أقلّ بكثير.
pub(crate) fn cancel_reply(gone: bool, phase: slots::JobPhase) -> String {
    if gone {
        return CANCELLED_TEXT.to_string();
    }
    match phase {
        slots::JobPhase::Preparing => format!(
            "🛑 طُلب الإلغاء — المهمّة في مرحلة التحضير (تنزيل/استلام): أدواتها \
             (yt-dlp/ffmpeg) تُقتل فوراً. أطول ما قيس في هذه المرحلة {:.1} ث.",
            CANCEL_PREPARE_WORST_SECS
        ),
        slots::JobPhase::Processing => {
            let secs = INFERENCE_BAIL_HINT_SECS;
            let mins = secs as f64 / 60.0;
            let slot_mins = slots::DEFAULT_WAIT.as_secs() / 60;
            format!(
                "🛑 طُلب الإلغاء — المهمّة في مرحلة المعالجة: إمّا تنتظر فتحة \
                 جهاز (حتى {slot_mins} دقيقة)، وإمّا داخل نداء محرّك لا يُقطع داخل \
                 العملية (لا نقطة إلغاء فيه). أطول ما قيس {mins:.1} دقيقة ({secs} ث)، \
                 والغالب أقلّ بكثير."
            )
        }
    }
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

// ── م٤: مُنظِّم معدّل الإرسال في المجموعة ───────────────────────────────────

/// نافذة زمنية من الطلبات لكل محادثة، بسقفين **معلَنين** من توثيق تلغرام:
/// [`GROUP_MSG_PER_MINUTE`] في الدقيقة و[`GROUP_MIN_GAP`] بين رسالتين.
///
/// **والساعة معامل لا `Instant::now()` داخلياً**: فيُقاس السلوك عند حدود
/// النافذة بلا انتظار دقيقةٍ في اختبار (وهو نفس نمط `purge_expired`).
///
/// **ولا يُطبَّق على المحادثات الخاصة**: السقف سقف **مجموعة**، والمحادثة
/// الخاصة مع المالك رسالة/ثانية لا تبلغها أصلاً، ففرضُه هناك يقصّ بلا سبب.
#[derive(Debug, Default)]
struct SendPacer {
    hits: HashMap<i64, VecDeque<Instant>>,
}

impl SendPacer {
    /// هل يُسمح بإرسالٍ الآن؟ **يسجّل الطلب إن سُمح** (أو يرفض بلا تسجيل).
    fn admit_at(&mut self, chat_id: i64, now: Instant) -> bool {
        if !is_group_chat(chat_id) {
            return true;
        }
        let q = self.hits.entry(chat_id).or_default();
        while let Some(front) = q.front() {
            if now.saturating_duration_since(*front) >= Duration::from_secs(60) {
                q.pop_front();
            } else {
                break;
            }
        }
        let gap_ok = q
            .back()
            .map(|last| now.saturating_duration_since(*last) >= GROUP_MIN_GAP)
            .unwrap_or(true);
        if q.len() >= GROUP_MSG_PER_MINUTE || !gap_ok {
            return false;
        }
        q.push_back(now);
        true
    }

    /// متى كان آخر طلبٍ مسموح لهذه المحادثة — تُقرأ في الاختبار **لتُثبَت
    /// الوصلة** (أن `send_message` في مجموعة يمرّ من هنا فعلاً)، لا السياسة وحدها.
    #[cfg(test)]
    fn last_hit(&self, chat_id: i64) -> Option<Instant> {
        self.hits.get(&chat_id).and_then(|q| q.back().copied())
    }
}

fn send_pacer() -> &'static Mutex<SendPacer> {
    static P: OnceLock<Mutex<SendPacer>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(SendPacer::default()))
}

#[cfg(test)]
fn reset_send_pacer() {
    let mut p = send_pacer().lock().unwrap_or_else(|e| e.into_inner());
    p.hits.clear();
}

/// **خيط الكاتب وحده ينام على المعدّل.** كان `pace_group_send` يُنادى من خيط
/// الاستطلاع، فأي انتظار فيه **يوقف قراءة التحديثات** ومعها `/kill`. والعلاج
/// ليس تقصير الانتظار ولا إسقاط الرسالة، بل **ألّا يكون الإرسال متزامناً في
/// خيط الاستطلاع أصلاً**: الطلب يُدرَج في [`SendQueue`] ويستهلكه خيطٌ كاتب
/// واحد، فالانتظار يقع على خيطه وحده.
///
/// **ولذلك لا حدّ زمني لهذا الانتظار**: الخيط مخصَّص له، ولا يحجب غيره؛ وحدٌّ
/// زمني كان يعني إسقاط رسالة عضو — وهو ما يمنعه التصميم §٢-٣. (الثابت القديم
/// `GROUP_PACE_MAX_WAIT` أُزيل لأنه لم يبقَ له مستهلك.)
fn pace_group_send(chat_id: i64) {
    loop {
        {
            let mut p = send_pacer().lock().unwrap_or_else(|e| e.into_inner());
            if p.admit_at(chat_id, Instant::now()) {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(120));
    }
}

/// حصّة **تعديل** في مجموعة بلا انتظار: `false` تعني «أُسقِط هذا التعديل
/// التجميلي».
///
/// **وهذا هو موضع الإسقاط الوحيد اليوم**، وهو **قبل الطابور لا داخله**: كتابة
/// الحالة تحمل قفل رسالتها عبر نداء الشبكة (`status_push`)، فترتيبُ ما يصل
/// السلك هو ترتيب الرتب — وإدراجُها في طابور كان يَكسر ذلك الضمان (وهو سلوك
/// مُختبَر). فلا تتكدّس التعديلات ولا تزاحم رسالةَ عضو.
fn pace_group_edit(chat_id: i64) -> bool {
    send_pacer()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .admit_at(chat_id, Instant::now())
}

// ── م٤: طابور الإرسال وخيط الكاتب ──────────────────────────────────────────

/// سعة الطابور لكل محادثة قبل أن يُصرَخ.
///
/// **وما يقع عند بلوغها**: لا شيء يُسقَط. الرسالة الضرورية سؤالُ عضوٍ أو
/// جوابُه، وإسقاطُها صمتٌ عليه — والتأخّر في الإرسال أهون من الصمت (التصميم
/// §٢-٣). فالسقف هنا **عتبة إنذار** لا عتبة إسقاط: يُكتب سطرٌ واحد لكل انفجار
/// بعمق الطابور وعدد المُسقَط (صفر) — فلا يمرّ تضخّمٌ بصمت.
pub const SEND_QUEUE_CAP: usize = 24;

/// أقصى انتظارٍ **لمعرّف رسالة** على خيط مهمّة ([`send_message_wait_id`]).
/// ولا يناديه خيط الاستطلاع أبداً — فالحجب هنا لا يمسّ قراءة التحديثات.
pub const SEND_ID_WAIT: Duration = Duration::from_secs(90);

/// خانة معرّف رسالة يكتبها خيط الكاتب بعد نجاح الإرسال — فيبقى المُرسِل غير
/// حاجب ويظلّ قادراً على تحرير رسالته لاحقاً (‏`Pending::ask_msg_id`).
type IdSlot = Arc<AtomicI64>;

/// ما يُنفّذه الكاتب.
enum SendItem {
    /// رسالة نصّية في مجموعة، و`pin` تعني «ثبّتها بعد إرسالها» (رسالة التعريف).
    Message {
        chat_id: i64,
        text: String,
        keyboard: Option<Value>,
        reply_to: Option<i64>,
        pin: bool,
        id_slot: Option<IdSlot>,
    },
    /// تنبيه عضوٍ في مجموعة: **السلسلة كلها على خيط الكاتب** (فانية ← خاص ←
    /// المحادثة) — لأن معرفة نجاح كل خطوة تحتاج نتيجتها، وهي هنا لا على خيط
    /// الاستطلاع.
    Notify {
        chat_id: i64,
        user_id: i64,
        text: String,
    },
}

struct SendJob {
    cfg: TgConfig,
    item: SendItem,
}

#[derive(Default)]
struct SendQueueState {
    q: VecDeque<SendJob>,
    /// طلبٌ يخضع للمعدّل الآن — فالسِجلّ ليس فارغاً وإن خلا الطابور.
    busy: bool,
    /// عمق أُعلن لكل محادثة — فلا يتكرّر السطر مع كل رسالة في الانفجار نفسه.
    warned: HashMap<i64, usize>,
}

/// **طابور الإرسال**: محدود العتبة، وخيطٌ كاتب واحد يستهلكه.
struct SendQueue {
    state: Mutex<SendQueueState>,
    ready: Condvar,
}

impl SendQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(SendQueueState::default()),
            ready: Condvar::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SendQueueState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// يُدرج طلباً **بلا حجب ولا إسقاط**، ويُصرَخ إن تجاوز العمق العتبة.
    fn push(&self, job: SendJob) {
        let chat_id = match &job.item {
            SendItem::Message { chat_id, .. } | SendItem::Notify { chat_id, .. } => *chat_id,
        };
        {
            let mut s = self.lock();
            s.q.push_back(job);
            let depth = s.q.len();
            let seen = s.warned.get(&chat_id).copied().unwrap_or(0);
            if depth > SEND_QUEUE_CAP && depth > seen {
                s.warned.insert(chat_id, depth);
                tracing::warn!(
                    target: "telegram",
                    "طابور إرسال المحادثة {chat_id} بلغ {depth} (العتبة {SEND_QUEUE_CAP}) — \
                     المُسقَط 0: الرسائل الضرورية لا تُسقَط، والتأخّر على خيط الكاتب وحده"
                );
            } else if depth <= SEND_QUEUE_CAP {
                s.warned.remove(&chat_id);
            }
        }
        self.ready.notify_one();
    }

    /// يُخرج الطلب التالي، **وينتظر إن خلا الطابور**.
    ///
    /// **ولا إيقاف للكاتب**: خيطٌ واحد ساكن على `Condvar` كلفتُه صفر، وإيقافُه
    /// عند إطفاء البوت كان يُبقي رسالةً أُدرجت قبله بلا إرسال — والكاتب يُفرغ
    /// ما في يده دائماً.
    fn pop(&self) -> Option<SendJob> {
        let mut s = self.lock();
        loop {
            if let Some(job) = s.q.pop_front() {
                s.busy = true;
                return Some(job);
            }
            s = self.ready.wait(s).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// يُعلن أن الطلب الحالي انتهى تنفيذه.
    fn done(&self) {
        self.lock().busy = false;
    }

    /// معلَّق الآن (منتظرٌ + قيد التنفيذ) — للقياس في الاختبارات.
    #[cfg(test)]
    fn depth(&self) -> usize {
        let s = self.lock();
        s.q.len() + usize::from(s.busy)
    }
}

/// الطابور **واحد للعملية**، وخيطه الكاتب يُنشأ عند أول استعمال.
///
/// **ولماذا عامّ لا ممرَّر**: الإرسال يقع من مواضع كثيرة (خيط الاستطلاع، خيوط
/// المهامّ، خيط التصغير، خيط الكاتب نفسه)، وتمرير الطابور إلى كلٍّ منها كان
/// يُضخّم التوقيعات بلا مقابل — تماماً كسِجلّ `telegram-jobs` وبوّابات الرسائل.
fn send_queue() -> &'static Arc<SendQueue> {
    static Q: OnceLock<Arc<SendQueue>> = OnceLock::new();
    Q.get_or_init(|| Arc::new(SendQueue::new()))
}

/// ينشئ خيط الكاتب مرة واحدة (‏`OnceLock` على المقبض) — **ويعيش ما دامت
/// العملية**: لا يُوقَف عند إطفاء البوت، فلا تضيع رسالةٌ أُدرجت قبله.
fn ensure_send_writer() {
    static W: OnceLock<()> = OnceLock::new();
    W.get_or_init(|| {
        let queue = send_queue().clone();
        let _ = std::thread::Builder::new()
            .name("telegram-send".into())
            .spawn(move || {
                while let Some(job) = queue.pop() {
                    run_send_job(&job);
                    queue.done();
                }
            });
    });
}

/// ينفّذ طلب إرسالٍ واحداً **على خيط الكاتب**: المعدّل هنا وحده، ثم النداء.
fn run_send_job(job: &SendJob) {
    match &job.item {
        SendItem::Message {
            chat_id,
            text,
            keyboard,
            reply_to,
            pin,
            id_slot,
        } => {
            pace_group_send(*chat_id);
            match send_message_now(&job.cfg, *chat_id, text, keyboard.clone(), *reply_to) {
                Ok(id) => {
                    if let Some(slot) = id_slot {
                        slot.store(id, Ordering::SeqCst);
                    }
                    if *pin {
                        let body = json!({
                            "chat_id": chat_id,
                            "message_id": id,
                            "disable_notification": true,
                        });
                        match call(&job.cfg, "pinChatMessage", &body, Duration::from_secs(20)) {
                            Ok(_) => tracing::info!(
                                target: "telegram",
                                "ثُبّتت رسالة التعريف في {chat_id} (مرة واحدة)"
                            ),
                            Err(e) => tracing::warn!(
                                target: "telegram",
                                "تعذّر تثبيت رسالة التعريف في {chat_id}: {e}"
                            ),
                        }
                    }
                }
                Err(e) => tracing::warn!(
                    target: "telegram",
                    "تعذّر الإرسال إلى {chat_id} من طابور الإرسال: {e}"
                ),
            }
        }
        SendItem::Notify {
            chat_id,
            user_id,
            text,
        } => {
            let path = run_notify_chain(&job.cfg, *chat_id, *user_id, text);
            tracing::info!(target: "telegram", "تنبيه العضو {user_id} في {chat_id} سلك {path:?}");
        }
    }
}

/// سلسلة التنبيه **على خيط الكاتب**: فانية ← خاص ← المحادثة. والمعدّل يُطبَّق
/// على كل خطوةٍ داخل المجموعة (والخاص ليس عليه حصّة أصلاً).
fn run_notify_chain(cfg: &TgConfig, chat_id: i64, user_id: i64, text: &str) -> NotifyPath {
    for shape in [EPHEMERAL_PARAMS_V10_3, EPHEMERAL_PARAMS_V10_2] {
        pace_group_send(chat_id);
        if send_ephemeral(cfg, chat_id, user_id, text, shape).is_ok() {
            return NotifyPath::Ephemeral;
        }
    }
    // الخاص ليس محادثة مجموعة ⇒ لا حصّة عليه.
    if send_message_now(cfg, user_id, text, None, None).is_ok() {
        return NotifyPath::Private;
    }
    pace_group_send(chat_id);
    let _ = send_message_now(cfg, chat_id, &format!("@{user_id} {text}"), None, None);
    NotifyPath::InChat
}

/// انتظار الطابور حتى يفرغ — **للاختبار وحده**: الإنتاج لا ينتظر إرسالاً أبداً.
#[cfg(test)]
fn wait_sends(timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if send_queue().depth() == 0 {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

// ── م٤: قائمة السماح — `chat_id` + `user_id` معاً ──────────────────────────

/// مدخل سماح محفوظ. **الزوج لا العضو وحده**: من سُمح له في مجموعةٍ ليس
/// مسموحاً في غيرها — فالصلاحية للمكان وللعضو معاً، كما في التصميم §٣.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct AllowPair {
    chat_id: i64,
    user_id: i64,
}

/// ملف قائمة السماح كما يُكتب على القرص.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct AccessFile {
    #[serde(default)]
    v: u32,
    #[serde(default)]
    entries: Vec<AllowPair>,
}

/// **قائمة السماح** (تصميم م٤ §٣): البوت يشغّل معالجةً على **جهاز المالك**، فلا
/// يكفي أن يكون المُرسِل في المجموعة — يلزم أن يكون مسموحاً فيها بعينه.
///
/// **والمالك مسموح دائماً** بلا مدخل: هو صاحب الجهاز، وطلبُه الإذن من نفسه عبث.
/// و`path: None` يعني «بلا حفظ» — وهو حال كل اختبار (فلا يلمس قرصاً).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct AccessStore {
    entries: HashSet<(i64, i64)>,
    path: Option<PathBuf>,
}

impl AccessStore {
    /// تحميل من ملف — وملفٌ تالف أو غائب يعني **قائمة فارغة** لا خطأً: أساسٌ
    /// ضيّق يُصلَح بضغطة، وأساسٌ واسع لا يُستَرَدّ.
    fn from_path(path: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<AccessFile>(&raw).ok())
            .map(|f| {
                f.entries
                    .into_iter()
                    .map(|e| (e.chat_id, e.user_id))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            entries,
            path: Some(path),
        }
    }

    /// الحكم الواحد: المالك دائماً، وإلا فمدخلٌ صريح لهذا الزوج.
    fn allows(&self, chat_id: i64, user_id: i64, owner: Option<i64>) -> bool {
        if Some(user_id) == owner {
            return true;
        }
        self.entries.contains(&(chat_id, user_id))
    }

    /// يُضيف مدخلاً ويعيد `true` إن كان جديداً (فلا يُقال «أُضيف» لموجود).
    fn allow(&mut self, chat_id: i64, user_id: i64) -> bool {
        self.entries.insert((chat_id, user_id))
    }

    /// كتابة **ذرّية** (`atomic.rs`) — القائمة تُقرأ عند كل رسالة، فملفٌ مقطوع
    /// يعني فقدان كل السماحات.
    fn save(&self) -> Result<(), String> {
        let Some(path) = self.path.as_ref() else {
            return Ok(());
        };
        let mut entries: Vec<AllowPair> = self
            .entries
            .iter()
            .map(|(chat_id, user_id)| AllowPair {
                chat_id: *chat_id,
                user_id: *user_id,
            })
            .collect();
        entries.sort_by_key(|e| (e.chat_id, e.user_id));
        let body =
            serde_json::to_string(&AccessFile { v: 1, entries }).map_err(|e| e.to_string())?;
        crate::atomic::write_atomic_str(path, &body, "json").map_err(|e| e.to_string())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// ملف قائمة السماح في مجلد بيانات التطبيق.
fn access_path(app_data: &Path) -> PathBuf {
    app_data.join("telegram-access.json")
}

/// **يُخاطَب البوت؟** منشن `@username` (بالكيانات إن وُجدت، وبالنصّ كذلك لأن
/// إزاحات الكيانات UTF-16 وسهلة الخطأ)، أو `text_mention` بمعرّف البوت، أو
/// **ردٌّ على رسالةٍ من البوت**.
///
/// وبلا هويةٍ معروفة (تعذّر `getMe`) تعيد `false` — لا يُدَّعى منشنٌ لم يُقرأ.
fn mentions_bot(msg: &Value, bot: &BotIdentity) -> bool {
    if !bot.known() {
        return false;
    }
    if bot.id != 0
        && msg
            .pointer("/reply_to_message/from/id")
            .and_then(Value::as_i64)
            == Some(bot.id)
    {
        return true;
    }
    for key in ["entities", "caption_entities"] {
        for e in msg
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            match e.get("type").and_then(Value::as_str) {
                // `text_mention` يحمل معرّف البوت نفسه — فلا يُبنى على الاسم.
                Some("text_mention")
                    if e.pointer("/user/id").and_then(Value::as_i64) == Some(bot.id) =>
                {
                    return true;
                }
                Some("mention") => {
                    if let Some(t) = e.get("text").and_then(Value::as_str) {
                        if bot.username_matches(t) {
                            return true;
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let text = msg
        .get("text")
        .or_else(|| msg.get("caption"))
        .and_then(Value::as_str)
        .unwrap_or("");
    text.split_whitespace().any(|w| bot.username_matches(w))
}

impl BotIdentity {
    /// هل هذه الكلمة منشَنٌ لهذا البوت؟ يقبل `@Name` و`@Name,` وما شابه من
    /// الترقيم الملتصق (وهو شائع في نهاية جملة)، ويقارن بلا حساسية لحالة الأحرف
    /// (تلغرام لا يفرّق فيها في أسماء المستخدمين).
    fn username_matches(&self, word: &str) -> bool {
        if self.username.is_empty() {
            return false;
        }
        let core = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '@');
        let Some(handle) = core.strip_prefix('@') else {
            return false;
        };
        !handle.is_empty() && handle.eq_ignore_ascii_case(&self.username)
    }
}

/// **أمرٌ موجَّه إلى هذا البوت**: `/kill` أو `/kill@MyBot`؛ و`/kill@OtherBot`
/// ليس لنا فلا يُقرأ (فلا يُجاب عنه بوتٌ ليس المقصود).
///
/// **ولماذا يُحتسب «مخاطَبةً»**: في مجموعةٍ بالمنشن، كتابةُ عضوٍ `/status`
/// مخاطبةٌ صريحة للبوت لا رسالةً عابرة — وتلغرام نفسه يرسل الأمر ككيان
/// `bot_command`، والعملاء تُلحق `@اسمه` تلقائياً.
fn command_for_bot(text: &str, bot: &BotIdentity) -> bool {
    let Some(rest) = text.trim().strip_prefix('/') else {
        return false;
    };
    let head = rest.split_whitespace().next().unwrap_or("");
    let mut it = head.split('@');
    let name = it.next().unwrap_or("");
    if name.is_empty() {
        return false;
    }
    match it.next() {
        // بلا تسمية: الأمر للبوت الوحيد في المحادثة (وهو حالنا).
        None => true,
        Some(handle) => bot.username_matches(&format!("@{handle}")),
    }
}

// ── م٤: مسار تنبيه عضوٍ في مجموعة (فانيّ ← خاص ← المحادثة) ────────────────

/// أيّ طريقٍ سلك التنبيه فعلاً — **يُعاد ليُقاس**، فلا يُدَّعى مسارٌ لم يقع.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyPath {
    /// رسالة فانية في المجموعة (‏Bot API 10.2/10.3) — تحسينٌ لا عماد.
    Ephemeral,
    /// رسالة في **خاص العضو** (تعمل فقط إن كان قد بدأ محادثةً مع البوت).
    Private,
    /// رسالة في المحادثة نفسها — الطريق الأخير الذي لا يفشل.
    InChat,
}

/// يُبلّغ عضواً في مجموعة برسالةٍ موجزة. **ولا يُنفَّذ هنا**: الطلب يُدرَج في
/// طابور الإرسال، والسلسلة (فانية ← خاص ← المحادثة) تُسلك على **خيط الكاتب**.
///
/// **ولماذا لا هنا**: معرفة نجاح كل خطوة تحتاج نتيجتها، وانتظارُها على خيط
/// الاستطلاع يوقف قراءة التحديثات ومعها `/kill` — وهو العطل الذي أُزيل.
/// ويعيد `true` إن أُدرج الطلب.
///
/// **ولا يُبنى على الفانية**: التسليم غير مضمون (لا يصل غير المتّصلين)، والشكل
/// نفسُه تغيّر بين 10.2 و10.3 ⇒ فشلُها **ليس فشلاً**، بل خطوة تُتجاوز.
fn notify_member(cfg: &TgConfig, chat_id: i64, user_id: i64, text: &str) -> bool {
    if !is_group_chat(chat_id) {
        // الخاص ليس عليه حصّة، فالنداء المباشر هو الأقصر — ويقع غالباً على خيط
        // المهامّ، ولا يمسّ خيط الاستطلاع في حالته الغالبة (بطاقة المالك).
        return send_message_now(cfg, user_id, text, None, None).is_ok();
    }
    send_group_async(
        cfg,
        SendItem::Notify {
            chat_id,
            user_id,
            text: text.to_string(),
        },
    )
}

/// محاولة إرسالٍ فانيّة بشكلٍ بعينه. **الشكل معامل** لا ثابت: 10.3 استبدلت
/// `receiver_user_id` بـ`ephemeral_message_parameters`، فالاثنان يُجرَّبان.
///
/// **ولا حصّة هنا**: معدّل الإرسال يُطبَّق في [`run_send_job`] — على خيط الكاتب
/// وحده. ومن نادى هذه من خيط غيره نادى [`pace_group_send`] قبله.
fn send_ephemeral(
    cfg: &TgConfig,
    chat_id: i64,
    user_id: i64,
    text: &str,
    shape: &str,
) -> Result<i64, String> {
    let mut body = json!({ "chat_id": chat_id, "text": text, "disable_web_page_preview": true });
    body[shape] = if shape == EPHEMERAL_PARAMS_V10_3 {
        // 10.3: كائنٌ يحمل المستقبِل.
        json!({ "receiver_user_id": user_id })
    } else {
        // 10.2: الحقل مسطّح على الرسالة.
        json!(user_id)
    };
    let v = call(cfg, "sendMessage", &body, Duration::from_secs(20))?;
    Ok(v.get("message_id").and_then(Value::as_i64).unwrap_or(0))
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
        // `my_chat_member` (م٤): لحظة **إضافة البوت إلى مجموعة** — وعندها وحدها
        // تُثبَّت رسالة التعريف (ت٩)، فلا تُثبَّت مع كل رسالة.
        "allowed_updates": ["message", "callback_query", "my_chat_member"],
    });
    let v = call(
        cfg,
        "getUpdates",
        &body,
        Duration::from_secs(LONG_POLL_SECS + 15),
    )?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

/// `reply_to` يجعل الرسالة **ردّاً على رسالة المستخدم الأصلية** (م٣): بلا هذا
/// الربط يقع الناتج في مكان آخر من المحادثة، وهو أصل شكوى «المحادثة مشتّتة».
/// والحمولة `reply_parameters: {message_id}` هي الصيغة الحالية في Bot API
/// (`reply_to_message_id` القديمة ما زالت تُقبل لكنها مهجورة).
///
/// **وهذا هو النداء الخام**: بلا حصّة وبلا طابور. يناديه الخاصُّ مباشرةً
/// (فلا حصّة عليه)، وخيطُ الكاتب بعد أن يكون قد أدّى الحصّة.
fn send_message_now(
    cfg: &TgConfig,
    chat_id: i64,
    text: &str,
    keyboard: Option<Value>,
    reply_to: Option<i64>,
) -> Result<i64, String> {
    let mut body = json!({ "chat_id": chat_id, "text": text, "disable_web_page_preview": true });
    if let Some(k) = keyboard {
        body["reply_markup"] = k;
    }
    if let Some(id) = reply_to.filter(|id| *id != 0) {
        body["reply_parameters"] = json!({ "message_id": id });
    }
    let v = call(cfg, "sendMessage", &body, Duration::from_secs(20))?;
    Ok(v.get("message_id").and_then(Value::as_i64).unwrap_or(0))
}

/// **إدراج طلبٍ في طابور الإرسال** — يعيد `true` إن أُدرج.
///
/// وهو الموضع الذي يمرّ منه كل إرسالٍ في **مجموعة**: لا حصّة هنا ولا انتظار،
/// والكاتب وحده ينام على المعدّل. ويعيد إنشاء خيط الكاتب إن لم يكن قائماً.
fn send_group_async(cfg: &TgConfig, item: SendItem) -> bool {
    ensure_send_writer();
    send_queue().push(SendJob {
        cfg: cfg.clone(),
        item,
    });
    true
}

/// الواجهة التي يناديها الكود كلّه.
///
/// * **محادثة خاصة** ⇒ نداءٌ مباشر (لا حصّة على الخاص أصلاً) ويُعاد المعرّف.
/// * **مجموعة** ⇒ يُدرَج في الطابور ويُعاد `Ok(0)`: **لا معرّف بعد**، ولا انتظار.
///   ومن يحتاج المعرّف في مجموعة ينادي [`send_message_wait_id`]، ومن يحتاجه
///   لاحقاً يمرّر [`IdSlot`].
fn send_message(
    cfg: &TgConfig,
    chat_id: i64,
    text: &str,
    keyboard: Option<Value>,
    reply_to: Option<i64>,
) -> Result<i64, String> {
    if !is_group_chat(chat_id) {
        return send_message_now(cfg, chat_id, text, keyboard, reply_to);
    }
    send_group_async(
        cfg,
        SendItem::Message {
            chat_id,
            text: text.to_string(),
            keyboard,
            reply_to,
            pin: false,
            id_slot: None,
        },
    );
    Ok(0)
}

/// إرسالٌ في مجموعة **يُنتظَر معرّفُه** — `SEND_ID_WAIT` حدّاً أقصى.
///
/// **ولا يناديه خيط الاستطلاع**: انتظارُه هناك هو الحجب الذي أُزيل، فمن ناداه
/// من خيط مهمّةٍ (سؤال التجاوز) لم يمسّ قراءة التحديثات.
fn send_message_wait_id(
    cfg: &TgConfig,
    chat_id: i64,
    text: &str,
    keyboard: Option<Value>,
    reply_to: Option<i64>,
) -> Result<i64, String> {
    if !is_group_chat(chat_id) {
        return send_message_now(cfg, chat_id, text, keyboard, reply_to);
    }
    let slot: IdSlot = Arc::new(AtomicI64::new(0));
    send_group_async(
        cfg,
        SendItem::Message {
            chat_id,
            text: text.to_string(),
            keyboard,
            reply_to,
            pin: false,
            id_slot: Some(slot.clone()),
        },
    );
    let started = Instant::now();
    loop {
        let id = slot.load(Ordering::SeqCst);
        if id != 0 {
            return Ok(id);
        }
        if started.elapsed() >= SEND_ID_WAIT {
            return Err("انتهت مهلة انتظار معرّف الرسالة من طابور الإرسال".to_string());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn edit_message(cfg: &TgConfig, chat_id: i64, message_id: i64, text: &str) -> Result<(), String> {
    edit_message_kb(cfg, chat_id, message_id, text, None)
}

/// تحرير **مع لوحة أزرار**: يلزم حين تصير رسالة السؤال (وفيها أزرار الوضع)
/// رسالةَ حالةٍ تحمل زرّ الإلغاء — وإلا بقيت أزرار الوضع على رسالةٍ تقول
/// «بدأت المعالجة».
fn edit_message_kb(
    cfg: &TgConfig,
    chat_id: i64,
    message_id: i64,
    text: &str,
    keyboard: Option<Value>,
) -> Result<(), String> {
    let mut body = json!({ "chat_id": chat_id, "message_id": message_id, "text": text });
    if let Some(k) = keyboard {
        body["reply_markup"] = k;
    }
    call(cfg, "editMessageText", &body, Duration::from_secs(20)).map(|_| ())
}

fn answer_callback(cfg: &TgConfig, id: &str, text: &str) {
    let body = json!({ "callback_query_id": id, "text": text });
    let _ = call(cfg, "answerCallbackQuery", &body, Duration::from_secs(10));
}

fn get_file(cfg: &TgConfig, file_id: &str) -> Result<(String, u64), String> {
    let v = call(
        cfg,
        "getFile",
        &json!({ "file_id": file_id }),
        Duration::from_secs(30),
    )?;
    let path = v
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or("لا مسار للملف في رد تيليجرام")?
        .to_string();
    let size = v.get("file_size").and_then(Value::as_u64).unwrap_or(0);
    Ok((path, size))
}

/// Cloud transport: files come over HTTPS and the bot is capped at 20 MB.
///
/// `cancel` (م٣): يُفحص بين الكتل، فزرّ الإلغاء يعمل **أثناء الاستلام** لا بعده
/// فقط — وكان قبل التسجيل المبكر لا يعمل إطلاقاً في هذه المرحلة.
fn download_cloud_file(
    cfg: &TgConfig,
    remote_path: &str,
    dest: &Path,
    cap: u64,
    cancel: &std::sync::Arc<AtomicBool>,
) -> Result<u64, String> {
    let url = format!(
        "{}/file/bot{}/{}",
        cfg.local_url
            .clone()
            .unwrap_or_else(|| "https://api.telegram.org".into()),
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
    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(out);
            let _ = std::fs::remove_file(dest);
            return Err("أُلغي استلام الملف".to_string());
        }
        let n = match limited.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                drop(out);
                let _ = std::fs::remove_file(dest);
                return Err(format!("انقطع استلام الملف: {e}"));
            }
        };
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        written += n as u64;
    }
    if written > cap {
        drop(out);
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
    fn build(
        fields: &[(&str, String)],
        file_field: &str,
        filename: &str,
        content_type: &str,
    ) -> Self {
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

/// POST one multipart body. Content-Length is declared explicitly (and asserted
/// by a unit test) so the request is never chunked — Telegram's edge is happier
/// with a known length, and progress/retry semantics stay predictable.
///
/// `content` is generic over the reader: a file on disk for media (streamed —
/// a 2 GB local-server upload must never be loaded into memory) or an in-memory
/// slice for the bot's own profile photo (‎19KB‎ compiled into the binary).
fn post_multipart<R: Read>(
    url: &str,
    body: &MultipartBody,
    content: R,
    content_len: u64,
    timeout: Duration,
    token: &str,
) -> Result<Value, String> {
    let total = body.head.len() as u64 + content_len + body.tail.len() as u64;
    let reader = Cursor::new(body.head.clone())
        .chain(content)
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

/// POST one file from disk — الغلاف الذي تستعمله مسارات الوسائط.
fn post_file(
    url: &str,
    body: &MultipartBody,
    file: std::fs::File,
    file_len: u64,
    timeout: Duration,
    token: &str,
) -> Result<Value, String> {
    post_multipart(url, body, file, file_len, timeout, token)
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
///
/// `reply_to` (م٣): الناتج **ردٌّ على رسالة المستخدم** التي جاء منها الطلب،
/// فيقع تحت الوسائط المعالجة في المحادثة لا في ذيلها.
fn send_media(
    cfg: &TgConfig,
    chat_id: i64,
    path: &Path,
    caption: &str,
    reply_to: Option<i64>,
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
    let mut fields: Vec<(&str, String)> = vec![
        ("chat_id", chat_id.to_string()),
        ("caption", caption.to_string()),
        ("supports_streaming", "true".to_string()),
    ];
    // Bot API يقبل الكائنات المتشعّبة في multipart كـJSON مُسلسَل في حقل نصّي.
    if let Some(id) = reply_to.filter(|id| *id != 0) {
        fields.push(("reply_parameters", json!({ "message_id": id }).to_string()));
    }
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
    /// **صاحب الطلب** (م٤): مفتاح الطابور (‏FIFO لكل مستخدم) ووسم المهمّة في
    /// السِجلّ (`telegram:<chat>:<user>`) ومصادقة الضغطات — ثلاثةٌ بمصدر واحد.
    user_id: i64,
    /// **الاسم المعروض لصاحب الطلب** (م٥): يسافر مع المهمّة إلى نهايتها، فيُكتب
    /// في سجلّ الإحصاءات **بلا قراءةٍ ثانية من الشبكة** — والاسم يتغيّر، والسجلّ
    /// مفتاحه الـID فلا يتفرّق.
    user: String,
    source: Source,
    mode: Mode,
    /// رسالة المستخدم الأصلية — كل ردٍّ لهذه المهمّة يقع تحتها (م٣).
    src_msg_id: i64,
    /// رسالة السؤال التي ضُغط زرُّها: تصير **رسالة الحالة** فتُحرَّر في مكانها
    /// (لا رسالة لكل تحديث). صفر = لا معرّف ⇒ تُنشأ رسالة ردّاً على المستخدم.
    status_msg_id: i64,
    /// الاسم المعروض للناتج (بلا مسار).
    file: String,
    /// صفّ `telegram-jobs` — يسافر مع المهمّة إلى نهايتها.
    row_id: u64,
}

/// اسم المرسل كما يعرضه تلغرام: `first_name` ثم `username` ثم المعرّف الرقمي.
fn display_user(from: &Value) -> String {
    let field = |k: &str| {
        from.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    field("first_name")
        .or_else(|| field("username"))
        .map(|v| v.chars().take(48).collect())
        .unwrap_or_else(|| {
            from.get("id")
                .and_then(Value::as_i64)
                .map(|id| id.to_string())
                .unwrap_or_else(|| "غير معروف".to_string())
        })
}

/// اسم الملف **المعروض**: بلا مسار (خصوصية) وبلا طول مفرط. يقبل اسماً قادماً من
/// الشبكة فلا يفترض شيئاً عن شكله — ويقع على الجزء الأخير من أي فاصل مسار.
fn display_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    if base.is_empty() {
        return "ملف".to_string();
    }
    base.chars().take(64).collect()
}

// ── المعلَّق: **مدخل لكل ملف** لا لكل محادثة (م٣/١) ─────────────────────────

/// ملفٌ وصل وينتظر اختيار وضعه.
///
/// **ولماذا لكل ملف**: كان السِجلّ `HashMap<chat_id, Pending>` — مدخل واحد لكل
/// محادثة — فوصولُ ملفٍ ثانٍ قبل اختيار وضع الأول **يسحق الأول ويضيع بلا
/// رسالة** (عطل بيانات، أخطر ما في هذه الجولة). والمفتاح الآن **(المحادثة،
/// الرمز)**، والرمز يسري في أزرار الملف وحده.
struct Pending {
    chat_id: i64,
    /// **صاحب الملف** (م٤): أزرارُه لا تُقبل من غيره — ولا يرى غيرُه ملفاته.
    user_id: i64,
    /// اسمه المعروض (م٥): ينتقل إلى `Job` فيصل سجلَّ الإحصاءات.
    user: String,
    /// رمز هذا الملف: زرُّه لا يصلح لملفٍ آخر.
    token: String,
    source: Source,
    /// رسالة المستخدم التي جاء منها الملف.
    src_msg_id: i64,
    /// **رسالة السؤال التي تحمل أزرار هذا الملف الآن** (م٣/إصلاح).
    ///
    /// كانت الأزرار تُرسَل ولا يُحفظ موضعها، فضغطة على سؤال **قديم** (نسخة
    /// سابقة من السؤال — يُنشئها `/mode` ولا يمحو القديمة) تُقبل ويصير
    /// معرّفها **مرجعَ الحالة** للمهمّة الجارية: تُحرَّر رسالةٌ قديمة ويبقى
    /// السؤال الحقيقي بأزراره. والحقل يربط الضغطة بسؤالها: ما لا يطابق يُردّ
    /// بصدق ولا يُحرَّر شيء. و`/mode` **ينقل** الربط إلى الرسالة الجديدة.
    ///
    /// **ولماذا خانةٌ مشتركة لا رقم** (م٤): في المجموعة يُسلَّم الإرسال إلى خيط
    /// الكاتب فلا معرّف عند الإدراج، والكاتب يكتبه في هذه الخانة. والضغطة لا
    /// تقع قبل وجود الرسالة أصلاً، فالنافذة بلا أثر.
    ask_msg_id: IdSlot,
    /// الاسم المعروض (بلا مسار).
    file: String,
    /// صفّ `telegram-jobs` (يُسجَّل عند الوصول).
    row_id: u64,
}

/// سِجلّ المعلَّقات، مفتاحه `(chat_id, token)`.
#[derive(Default)]
struct PendingStore {
    by_token: HashMap<(i64, String), Pending>,
}

impl PendingStore {
    fn count_for(&self, chat_id: i64) -> usize {
        self.by_token.keys().filter(|(c, _)| *c == chat_id).count()
    }

    /// هل تقبل هذه المحادثة ملفاً آخر؟ **حدّ أعلى صريح** لا نموّ بلا سقف.
    fn can_accept(&self, chat_id: i64) -> bool {
        self.count_for(chat_id) < MAX_PENDING_PER_CHAT
    }

    /// يُدرج **بلا إسقاط شيء**: لا يُزيل مدخلاً قائماً أبداً. يعيد `false` عند
    /// بلوغ السقف (والمستدعي يفحص `can_accept` قبله فيقول للمستخدم صراحةً).
    fn insert(&mut self, p: Pending) -> bool {
        if !self.can_accept(p.chat_id) {
            return false;
        }
        self.by_token.insert((p.chat_id, p.token.clone()), p);
        true
    }

    /// يأخذ معلَّقاً **بعينه** بالرمز — فلا يُلغي اختيارُ ملفٍ ملفاً آخر.
    fn take(&mut self, chat_id: i64, token: &str) -> Option<Pending> {
        self.by_token.remove(&(chat_id, token.to_string()))
    }

    /// معلَّقٌ بعينه بلا سحبه (للقراءة قبل الحكم — فلا يُفقد معلَّقٌ برفض ضغطة).
    fn get(&self, chat_id: i64, token: &str) -> Option<&Pending> {
        self.by_token.get(&(chat_id, token.to_string()))
    }

    /// **ينقل ربط المعلَّق إلى رسالة السؤال الجديدة** (`/mode` يعيد الأزرار في
    /// رسالة جديدة ولا يمحو القديمة) — فالرسالة الحيّة هي الأحدث وحدها.
    fn set_ask_msg(&mut self, chat_id: i64, token: &str, ask_msg_id: IdSlot) {
        if let Some(p) = self.by_token.get_mut(&(chat_id, token.to_string())) {
            p.ask_msg_id = ask_msg_id;
        }
    }

    /// معلَّقات **مستخدمٍ بعينه** في محادثةٍ بترتيب الوصول (م٤).
    ///
    /// **ولماذا ليس لكل المحادثة**: في مجموعة، `/mode` بلا هذا الفصل يعرض
    /// لصاحب الطلب أزرارَ ملفات **غيره** — تسريبٌ بين الأعضاء وضغطةٌ تُشغّل
    /// ملفاً ليس له.
    fn for_user(&self, chat_id: i64, user_id: i64) -> Vec<&Pending> {
        let mut v: Vec<&Pending> = self
            .by_token
            .values()
            .filter(|p| p.chat_id == chat_id && p.user_id == user_id)
            .collect();
        v.sort_by_key(|p| p.row_id);
        v
    }

    /// عدد المعلَّقات كلها — للاختبار (لا يقرؤه مسار المنتج).
    #[cfg(test)]
    fn len(&self) -> usize {
        self.by_token.len()
    }
}

// ── سؤال التجاوز (م٣/٤): ناتجٌ فوق السقف ينتظر قرار صاحبه ───────────────────

/// ناتج تجاوز سقف الإرسال. **يُسأل كل مرّة** ولا يُحفظ جواب (قرار المالك)،
/// و`asked` وحدها تحدّد الصلاحية — فلا ذاكرة لاختيار سابق في أي حقل.
#[derive(Debug, Clone)]
struct Oversize {
    chat_id: i64,
    /// **صاحب الناتج** (م٤): ضغطةٌ من غيره تُرفض ولا تستهلك السؤال — فالناتج
    /// يُرسَل إلى صاحبه، ومن ضغط زرَّ غيره كان سيُرسل ناتجَ غيره إليه.
    user_id: i64,
    /// اسمه المعروض (م٥): يُكتب في سجلّ الإحصاءات لحظة تسليم المضغوط.
    user: String,
    /// رسالة السؤال — **مفتاح المدخل**، وتُحرَّر بالنتيجة.
    msg_id: i64,
    /// رسالة المستخدم الأصلية (الردّ يقع تحتها).
    src_msg_id: i64,
    /// الناتج في **مجلد النتائج** — لا وسيطاً في مجلد مؤقّت يُمحى (وإلا صار
    /// السؤال يشير إلى ملفٍ محذوف). ولا يُحذف أبداً.
    path: PathBuf,
    bytes: u64,
    duration_secs: f64,
    has_video: bool,
    /// ارتفاع الصورة — يُقصّ إليه عند الضغط فلا نُكبّر صورةً صغيرة.
    height: Option<u32>,
    file: String,
    asked: Instant,
}

/// أسئلة التجاوز المفتوحة، مفتاحها `(chat_id, msg_id)` — فسؤالان في محادثة
/// واحدة لا يسحق أحدهما الآخر (سؤال الجاسوس ٦).
#[derive(Default)]
struct OversizeStore {
    by_msg: HashMap<(i64, i64), Oversize>,
}

impl OversizeStore {
    fn insert(&mut self, o: Oversize) {
        self.by_msg.insert((o.chat_id, o.msg_id), o);
    }

    fn get(&self, chat_id: i64, msg_id: i64) -> Option<&Oversize> {
        self.by_msg.get(&(chat_id, msg_id))
    }

    fn take(&mut self, chat_id: i64, msg_id: i64) -> Option<Oversize> {
        self.by_msg.remove(&(chat_id, msg_id))
    }

    fn count_for(&self, chat_id: i64) -> usize {
        self.by_msg.keys().filter(|(c, _)| *c == chat_id).count()
    }

    /// عدد الأسئلة كلها — للاختبار (لا يقرؤه مسار المنتج).
    #[cfg(test)]
    fn len(&self) -> usize {
        self.by_msg.len()
    }

    /// يُزيل ما انتهت مدّته **ويعيده** ليعلم صاحبه — لا إسقاط صامت. و`now`
    /// معاملٌ لا `Instant::now()` داخلياً، فيُقاس انتهاء المدة بلا انتظار حقيقي.
    fn purge_expired(&mut self, now: Instant) -> Vec<Oversize> {
        let (dead, live): (Vec<_>, Vec<_>) = self
            .by_msg
            .drain()
            .partition(|(_, o)| now.saturating_duration_since(o.asked) >= OVERSIZE_TTL);
        self.by_msg = live.into_iter().collect();
        dead.into_iter().map(|(_, o)| o).collect()
    }
}

// ── عدّاد الطابور الفعلي (لا تقدير) ─────────────────────────────────────────

/// مهامّ قُبلت ولم يدخل تنفيذها بعد (عمق قناة المهامّ).
static QUEUE_DEPTH: AtomicUsize = AtomicUsize::new(0);
/// مهامّ دخلت `run_job` ولم تنتهِ — تشمل نافذة «التجهيز» التي لا تكون فيها
/// المهمّة في القناة ولا في سِجلّ الفتحات، فبغيرها يَعُدّ الطابور نفسه ناقصاً.
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// تنقيص **مشبع**: لا يلتفّ العدّاد إلى `usize::MAX` لو نقص أكثر مما زِيد
/// (يقع عند إعادة تشغيل العامل ومهمّة قديمة ما زالت تنقص).
fn dec(counter: &AtomicUsize) {
    let _ = counter.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| {
        Some(v.saturating_sub(1))
    });
}

/// عدد مهامّ تلغرام التي تسبق مهمّةً جديدة **الآن**: الجارية + المنتظرة.
/// رقمٌ من عدّادين حقيقيّين، لا تخمين.
fn jobs_ahead() -> u32 {
    let inflight = IN_FLIGHT.load(Ordering::SeqCst) as u32;
    let queued = QUEUE_DEPTH.load(Ordering::SeqCst) as u32;
    inflight.saturating_add(queued)
}

/// مهمّة دخلت التنفيذ — تُحسب «جارية» من أول سطر إلى آخر مخرج (`Drop`).
struct InFlightGuard;

impl InFlightGuard {
    fn enter() -> Self {
        IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        dec(&IN_FLIGHT);
    }
}

// ── `telegram-jobs`: ما تعرضه الواجهة (عقد مُجمَّد) ──────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JobState {
    Queued,
    Running,
    Done,
    Failed,
}

impl JobState {
    fn as_str(self) -> &'static str {
        match self {
            JobState::Queued => "queued",
            JobState::Running => "running",
            JobState::Done => "done",
            JobState::Failed => "failed",
        }
    }
}

/// صفّ مهمّة — **بلا مسار ملف** (الخصوصية: الاسم المعروض وحده).
#[derive(Debug, Clone)]
struct TgJobRow {
    id: u64,
    chat_id: i64,
    user: String,
    file: String,
    state: JobState,
    pct: Option<f64>,
}

static TG_JOBS: OnceLock<Mutex<Vec<TgJobRow>>> = OnceLock::new();
static TG_JOB_SEQ: AtomicU64 = AtomicU64::new(1);

fn tg_jobs() -> &'static Mutex<Vec<TgJobRow>> {
    TG_JOBS.get_or_init(|| Mutex::new(Vec::new()))
}

/// حمولة `telegram-jobs` من صفوفٍ بعينها — **نقيّة**، فتُقاس بلا تطبيق ولا شبكة.
///
/// **العقد**: مصفوفة مرتّبة بترتيب الوصول؛ ولكل صفّ `chat_id` و`user` و`file`
/// (اسم معروض بلا مسار) و`state` (`queued|running|done|failed`) و`position`
/// (‏1 = أول المصفوفة، وهو **التالي أو الجاري**) و`total` (طول المصفوفة) و`pct`
/// (‏`null` قبل البدء). والصفّ المنتهي **يُبَثّ مرّة واحدة** بحالته النهائية ثم
/// يُزال — فترى الواجهة `done`/`failed` مرةً ولا يبقى سطرٌ ميت.
fn jobs_payload(rows: &[TgJobRow]) -> Value {
    let total = rows.len() as u32;
    Value::Array(
        rows.iter()
            .enumerate()
            .map(|(i, r)| {
                json!({
                    "chat_id": r.chat_id,
                    "user": r.user,
                    "file": r.file,
                    "state": r.state.as_str(),
                    "position": (i as u32) + 1,
                    "total": total,
                    "pct": r.pct,
                })
            })
            .collect(),
    )
}

/// يُبَثّ عند **كل تغيّر فعلي** (وصول · بدء · تقدّم · انتهاء) — لا استطلاعاً
/// دورياً. وبلا تطبيق (اختبارات) لا يفعل شيئاً ولا يفشل.
fn emit_jobs() {
    let Some(app) = APP.get() else { return };
    use tauri::Emitter;
    let payload = {
        let rows = tg_jobs().lock().unwrap_or_else(|p| p.into_inner());
        jobs_payload(&rows)
    };
    let _ = app.emit("telegram-jobs", payload);
}

/// يُسجّل صفّاً عند وصول الملف ويعيد معرّفه (يسافر مع المهمّة حتى نهايتها).
fn jobs_arrived(chat_id: i64, user: &str, file: &str) -> u64 {
    let id = TG_JOB_SEQ.fetch_add(1, Ordering::SeqCst);
    {
        let mut rows = tg_jobs().lock().unwrap_or_else(|p| p.into_inner());
        rows.push(TgJobRow {
            id,
            chat_id,
            user: user.to_string(),
            file: file.to_string(),
            state: JobState::Queued,
            pct: None,
        });
    }
    emit_jobs();
    id
}

fn jobs_started(id: u64) {
    {
        let mut rows = tg_jobs().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(r) = rows.iter_mut().find(|r| r.id == id) {
            r.state = JobState::Running;
            r.pct = Some(0.0);
        }
    }
    emit_jobs();
}

/// تقريب النسبة إلى عُشر في المئة — **تغيّرٌ فعلي لا ضجيج فواصل عشرية**، وإلا
/// بُثّ الحدث آلاف المرّات على مهمّة واحدة.
fn round_pct(pct: f64) -> f64 {
    (pct.clamp(0.0, 100.0) * 10.0).round() / 10.0
}

/// تقدّم بنسبة مئوية. **ولا يُبَثّ ضجيج الفواصل**: عتبة ٠٫١٪ تغيّرٌ فعلي.
fn jobs_progress(id: u64, pct: f64) {
    let rounded = round_pct(pct);
    let changed = {
        let mut rows = tg_jobs().lock().unwrap_or_else(|p| p.into_inner());
        match rows.iter_mut().find(|r| r.id == id) {
            Some(r) if r.pct != Some(rounded) => {
                r.pct = Some(rounded);
                true
            }
            _ => false,
        }
    };
    if changed {
        emit_jobs();
    }
}

/// يُبَثّ الصفّ بحالته النهائية **ثم يُزال**.
fn jobs_finished(id: u64, ok: bool) {
    {
        let mut rows = tg_jobs().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(r) = rows.iter_mut().find(|r| r.id == id) {
            r.state = if ok { JobState::Done } else { JobState::Failed };
            if ok {
                r.pct = Some(100.0);
            }
        }
    }
    emit_jobs();
    tg_jobs()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|r| r.id != id);
}

/// يُنهي صفّ المهمّة على **كل** مخرج (`Drop` يعمل عند النجاح والخطأ والذعر).
/// والافتراض `failed` حتى يُقال `ok()` صراحةً — فلا تُعلَن نجاةٌ لم تُثبَت.
struct JobRowGuard {
    id: u64,
    ok: bool,
}

impl JobRowGuard {
    fn ok(&mut self) {
        self.ok = true;
    }
}

impl Drop for JobRowGuard {
    fn drop(&mut self) {
        jobs_finished(self.id, self.ok);
    }
}

/// حالة خيط التحديثات وحدها: ما ينتظر اختيار الوضع، ومن أُخبر بالاقتران.
/// (وسِجلّ أسئلة التجاوز **مشترك** مع خيط المهامّ: السؤال يُطرح هناك ويُجاب هنا.)
#[derive(Default)]
struct PollState {
    pending: PendingStore,
    hinted: HashSet<i64>,
    /// هوية البوت من `getMe` (م٤): بها وحدها يُعرَف المنشن والردّ على رسالته.
    identity: BotIdentity,
    /// **قائمة السماح** (م٤): `(chat_id, user_id)` — الافتراضيّ فارغة، والحفظ
    /// في مجلد بيانات التطبيق (يُبنى في [`spawn_poll_thread`]).
    access: AccessStore,
    /// طلبات الموافقة المفتوحة (الوضع الموسَّع): تُعرَض في خاصّ المالك ولا
    /// تُعالَج قبل ضغطته.
    approvals: ApprovalStore,
    /// محادثات ثُبّتت فيها رسالة التعريف — **مرة واحدة لكل محادثة** (ت٩).
    pinned: HashSet<i64>,
    /// من أُخبر مرّةً أنه غير مسموح: «رسالة **واحدة** موجزة» حرفاً لا سيلاً.
    notified: HashSet<(i64, i64)>,
}

// ── م٤: طلبات الموافقة (الوضع الموسَّع) ────────────────────────────────────

/// طلبُ عضوٍ في مجموعة ينتظر قرار المالك. **يُحفظ كاملاً** (المصدر والرسالة
/// والاسم) لأن الموافقة تُنفِّذ الطلب بعدها — فبلا المصدر تصير الموافقة وعداً
/// بلا فعل.
#[derive(Debug, Clone)]
struct Approval {
    chat_id: i64,
    user_id: i64,
    user: String,
    source: Source,
    src_msg_id: i64,
    file: String,
    /// رسالة البطاقة في خاصّ المالك — تُحرَّر بالقرار فلا يبقى زرٌّ منتهٍ.
    card_msg_id: i64,
}

/// حدّ أعلى **صريح** لطلبات الموافقة في المحادثة الواحدة — فلا يملأ عضوٌ
/// خاصَّ المالك ببطاقاتٍ لا تنتهي (نفس مبدأ `MAX_PENDING_PER_CHAT`).
pub const MAX_APPROVALS_PER_CHAT: usize = 10;

#[derive(Default)]
struct ApprovalStore {
    by_token: HashMap<String, Approval>,
}

impl ApprovalStore {
    fn count_for(&self, chat_id: i64) -> usize {
        self.by_token
            .values()
            .filter(|a| a.chat_id == chat_id)
            .count()
    }

    /// يُدرج بلا إسقاط شيء، ويعيد `false` عند بلوغ السقف (فيُقال للمستخدم).
    fn insert(&mut self, token: String, a: Approval) -> bool {
        if self.count_for(a.chat_id) >= MAX_APPROVALS_PER_CHAT {
            return false;
        }
        self.by_token.insert(token, a);
        true
    }

    fn get(&self, token: &str) -> Option<&Approval> {
        self.by_token.get(token)
    }

    fn take(&mut self, token: &str) -> Option<Approval> {
        self.by_token.remove(token)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.by_token.len()
    }
}

/// أزرار بطاقة الموافقة: `apv:<yes|always|no>:<token>`.
fn approval_keyboard(token: &str) -> Value {
    json!({
        "inline_keyboard": [[
            { "text": "✅ اسمح", "callback_data": format!("apv:yes:{token}") },
            { "text": "❌ ارفض", "callback_data": format!("apv:no:{token}") },
            { "text": "♾️ اسمح دائماً", "callback_data": format!("apv:always:{token}") },
        ]]
    })
}

/// قراءة زرّ الموافقة: `(القرار، الرمز)`.
fn parse_approval_button(data: &str) -> Option<(&'static str, String)> {
    let rest = data.strip_prefix("apv:")?;
    let (verdict, token) = rest.split_once(':')?;
    let verdict = match verdict {
        "yes" => "yes",
        "no" => "no",
        "always" => "always",
        _ => return None,
    };
    if token.is_empty() {
        return None;
    }
    Some((verdict, token.to_string()))
}

/// نصّ بطاقة الموافقة في خاصّ المالك.
fn approval_text(a: &Approval) -> String {
    format!(
        "🔗 طلب من {} ({})\n📎 {}\n\nلا معالجة قبل ضغطتك.",
        a.user, a.user_id, a.file
    )
}

/// يُرسل بطاقة الموافقة إلى **خاصّ المالك** ويسجّلها. ويعيد `false` إن تعذّر
/// إبلاغ المالك — فيُقال ذلك في المجموعة بدل صمتٍ يبدو عطلاً.
fn send_approval(cfg: &TgConfig, poll: &mut PollState, mut a: Approval) -> bool {
    let Some(owner) = cfg.owner_id else {
        return false;
    };
    let text = approval_text(&a);
    let mut token = format!("{:x}", nanos());
    if poll.approvals.get(&token).is_some() {
        token.push('x');
    }
    let Ok(msg_id) = send_message(cfg, owner, &text, Some(approval_keyboard(&token)), None) else {
        return false;
    };
    a.card_msg_id = msg_id;
    tracing::info!(target: "telegram", "طلب موافقة من {} في {} (رسالة {msg_id})", a.user_id, a.chat_id);
    poll.approvals.insert(token, a)
}

/// صفوف مهامّ محادثةٍ بعينها — للاختبار فقط (لا يقرؤها مسار المنتج).
#[cfg(test)]
fn tg_job_states_for_test(chat_id: i64) -> Vec<(String, Option<f64>)> {
    tg_jobs()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|r| r.chat_id == chat_id)
        .map(|r| (r.state.as_str().to_string(), r.pct))
        .collect()
}

/// صفوف محادثةٍ بعينها كحمولة كاملة — للاختبار فقط.
#[cfg(test)]
fn tg_job_rows_for_test(chat_id: i64) -> Vec<Value> {
    let rows = tg_jobs().lock().unwrap_or_else(|p| p.into_inner());
    let mine: Vec<TgJobRow> = rows
        .iter()
        .filter(|r| r.chat_id == chat_id)
        .cloned()
        .collect();
    jobs_payload(&mine).as_array().cloned().unwrap_or_default()
}

#[derive(Default)]
struct Status {
    running: bool,
    last_error: String,
    last_activity: String,
    processed: u64,
    queue: usize,
    paired_id: Option<i64>,
    /// م٥: **آخر خطأ** في ضبط الهوية/الأوامر — يُعرَض بنصّه بدل فشلٍ صامت
    /// (ت١١). أمّا «مُطبَّق أم لا» فيُقرأ من القرص عند كل طلب، فليس صورةً
    /// مخبَّأة تقدم (عطل ٤).
    identity_error: String,
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
    // **صورةٌ ثم إسقاط القفل**: `identity_now()` يأخذ قفل `Status` بنفسه، فلو
    // بقي مأخوذاً هنا لصار **جموداً على النفس** (‏`Mutex` غير تراكبي) — وقد
    // وقع فعلاً عند أول تشغيل لهذا الفحص (علق الاختبار حتى المهلة).
    let (running, last_error, last_activity, processed, queue, paired_id) = {
        let s = status().lock().unwrap_or_else(|p| p.into_inner());
        (
            s.running,
            s.last_error.clone(),
            s.last_activity.clone(),
            s.processed,
            s.queue,
            s.paired_id,
        )
    };
    json!({
        "running": running,
        "last_error": last_error,
        "last_activity": last_activity,
        "processed": processed,
        "queue": queue,
        "paired_id": paired_id,
        "pairing_code_active": code_active,
        "local_server_hint": LOCAL_SERVER_HINT,
        "cloud_send_max_mb": CLOUD_SEND_MAX_BYTES / (1024 * 1024),
        "cloud_download_max_mb": CLOUD_DOWNLOAD_MAX_BYTES / (1024 * 1024),
        // م٥: هوية البوت — **تُقرأ من القرص عند كل طلب** (عطل ٤: كانت صورةً
        // مخبَّأة في `Status` فلا تتحرّك حتى نداء `apply_settings`)، ومعها
        // مقابلةٌ بالخادم تُطلَق في الخلف إن قدمت (عطل ٣).
        "identity": identity_now(),
    })
}

/// حالة الهوية كما تُعرَض الآن: قراءةٌ طازجة من القرص + إطلاق مقابلةٍ بالخادم
/// **إن قدمت** (بلا حجب: الخيط يُطلَق ويُنسى، والنتيجة تظهر في الطلب التالي).
fn identity_now() -> Value {
    let data = crate::paths::data_dir();
    let st = load_identity_state(&data).unwrap_or_default();
    let error = status()
        .lock()
        .map(|s| s.identity_error.clone())
        .unwrap_or_default();
    if let Some(cfg) = live_cfg() {
        spawn_identity_verify_if_stale(&cfg, &data);
    }
    identity_payload(&st, false, &error)
}

/// حمولة هوية البوت كما تُعرَض في الواجهة — **بأسماء دقيقة** (عطلان ٣ و٥):
///
/// * `applied` = **ما فعلناه** (راية القرص). ليست «الاسم مطابق الآن»؛
/// * `name` = الاسم كما **قاله الخادم** آخر مرّة، وإلا فالهدف إن كنّا طبّقنا
///   (فنحن نعلم ما ضبطناه) وإلا فالاسم السابق. ولا يُخلط الهدفُ بالحيّ؛
/// * `target_name` = ما تُطبِّقه الضغطة («HaramLite») — مفصولاً عن `name`؛
/// * `matches` = هل الاسم الحيّ هو هدفنا؟ (`null` = لم تُقابَل بعد)؛
/// * `verified_secs_ago` = عُمر المقابلة بالثواني (`null` = لا مقابلة)؛
/// * `photo_applied` = هل صورتنا مرفوعة (يفترق عن `applied` عند فشلٍ جزئي).
fn identity_payload(st: &BotIdentityState, changed: bool, error: &str) -> Value {
    let verified = st.checked_ms > 0;
    let name = if !st.server_name.is_empty() {
        st.server_name.clone()
    } else if st.applied {
        BOT_DISPLAY_NAME.to_string()
    } else {
        st.previous_name.clone()
    };
    let matches = if verified {
        Some(st.server_name.trim() == BOT_DISPLAY_NAME)
    } else {
        None
    };
    let age = if verified {
        Some((epoch_ms().saturating_sub(st.checked_ms) / 1000) as u64)
    } else {
        None
    };
    json!({
        "applied": st.applied,
        "photo_applied": st.photo_applied,
        "name": name,
        "target_name": BOT_DISPLAY_NAME,
        "previous_name": st.previous_name,
        "matches": matches,
        "verified_secs_ago": age,
        "changed": changed,
        "error": error,
    })
}

/// م٥: «اضبط الأوامر» من الواجهة — نداءٌ صريح بنتيجة صريحة.
pub fn set_commands_now() -> Result<Value, BotSetupError> {
    let cfg = live_cfg().ok_or_else(|| BotSetupError::NotConfigured("لا توكن للبوت".into()))?;
    let n = apply_bot_commands(&cfg)?;
    if let Ok(mut st) = status().lock() {
        st.identity_error.clear();
    }
    Ok(json!({ "commands": n, "scope_chat": cfg.owner_id }))
}

/// الإعداد الحيّ للبوت (توكن + مالك) من العامل القائم — ومصدره الإعدادات إن
/// كان العامل متوقفاً: نداءات الواجهة تسبق تشغيل العامل عادةً.
fn live_cfg() -> Option<TgConfig> {
    if let Some(rt) = handle()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|rt| rt.cfg.clone())
    {
        if rt.usable() {
            return Some(rt);
        }
    }
    let s = crate::settings::load(&crate::paths::data_dir());
    let cfg = TgConfig::from_settings(&s);
    cfg.usable().then_some(cfg)
}

/// Start/stop/restart the worker to match the settings. Called from
/// `set_settings` next to the watch-folder service.
pub fn apply_settings(s: &Settings) {
    let want = TgConfig::from_settings(s);
    let enabled = s.telegram_enabled && want.usable();
    // م٥: هوية البوت تتبع الإعداد **بالمزامنة لا بالتخمين** (‏`m5-brief` §٢-الواجهة ١):
    // والتطبيق/العكس يقع **مرة واحدة عند اختلاف المطلوب عن الواقع** — في خيطٍ
    // مستقل لأن النداء شبكي ولا يجوز أن يحجب مسار حفظ الإعدادات.
    // (**ولا قراءةَ حالةٍ هنا**: الواجهة تقرأها من `telegram_status` عند كل
    // طلب مباشرةً من القرص، فلا صورة مخبَّأة تحتاج تحديثاً.)
    if want.usable() {
        let cfg = want.clone();
        let wanted = s.telegram_bot_identity;
        let data = crate::paths::data_dir();
        // `photo_applied` جزءٌ من «هل هناك أثر لنا؟»: تطبيقٌ فشل نصفه يترك
        // صورةً بلا اسم، وإلغاءُ المربّع يجب أن يُزيلها (عطل ٦).
        let st = load_identity_state(&data).unwrap_or_default();
        if identity_needs_call(&st, wanted) {
            let _ = std::thread::Builder::new()
                .name("tg-identity".into())
                .spawn(move || match sync_bot_identity(&cfg, &data, wanted) {
                    Some(Ok(o)) => {
                        if let Ok(mut st) = status().lock() {
                            st.identity_error.clear();
                        }
                        tracing::info!(
                            target: "telegram",
                            "هوية البوت: {} (الاسم {})",
                            if o.applied { "طُبِّقت" } else { "عُكست" },
                            o.name
                        );
                    }
                    Some(Err(e)) => {
                        // **الفشل يُعلَن** ولا يُسكَت عنه: يُحفظ نصّه، والحالة
                        // تُقرأ من القرص عند العرض (لا ادّعاء نجاح).
                        if let Ok(mut st) = status().lock() {
                            st.identity_error = e.to_string();
                        }
                        tracing::warn!(target: "telegram", "تعذّر ضبط هوية البوت: {e}");
                    }
                    None => {}
                });
        }
    }
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
    // عدّاد القناة يبدأ من صفر مع قناة جديدة: ما كان في القناة القديمة لن يُنفَّذ
    // أبداً، فإبقاء عدّه يجعل «دورك» رقماً عن مهامّ لا وجود لها. أما `IN_FLIGHT`
    // **فلا يُصفَّر**: مهمّة قديمة ما زالت تعمل تبقى محسوبة حتى تنتهي فعلاً.
    QUEUE_DEPTH.store(0, Ordering::SeqCst);
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
        st.queue = 0;
    }
    tracing::info!(
        target: "telegram",
        "بوت تيليجرام يعمل{} ({})",
        if want.is_local() { " عبر خادم محلي" } else { "" },
        if want.owner_id.is_some() { "مقترن" } else { "وضع الاقتران" }
    );
    let oversize = Arc::new(Mutex::new(OversizeStore::default()));
    let (tx, rx) = mpsc::channel::<Job>();
    // م٤: الطابور يُبنى على **سقف الجهاز نفسه** (`slots::current_limit`) —
    // رقمٌ واحد لا رقمان يفترقان، وقصّه إلى 1..=2 في `clamp_limit`.
    let queue = Arc::new(JobQueue::new(slots::current_limit()));
    // **وخيط الكاتب** يقوم مع العامل: الإرسال في المجموعة لا يقع على خيط
    // الاستطلاع ولا على خيوط المهامّ.
    ensure_send_writer();
    spawn_job_thread(want.clone(), stop.clone(), rx, oversize.clone(), queue);
    spawn_poll_thread(want, stop, tx, oversize);
}

/// هوية البوت من `getMe`. الفشل ليس كارثة: تُعاد هوية فارغة و`known()` تكذب
/// على أحد — والمنشن لا يُدَّعى بلا اسم.
fn fetch_identity(cfg: &TgConfig) -> BotIdentity {
    match call(cfg, "getMe", &json!({}), Duration::from_secs(20)) {
        Ok(v) => BotIdentity {
            id: v.get("id").and_then(Value::as_i64).unwrap_or(0),
            username: v
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_start_matches('@')
                .to_string(),
        },
        Err(e) => {
            tracing::warn!(target: "telegram", "getMe فشل: {e}");
            BotIdentity::default()
        }
    }
}

fn spawn_poll_thread(
    cfg: TgConfig,
    stop: Arc<AtomicBool>,
    tx: Sender<Job>,
    oversize: Arc<Mutex<OversizeStore>>,
) {
    std::thread::Builder::new()
        .name("telegram-poll".into())
        .spawn(move || {
            use tauri::Emitter;
            // أوامر البوت تُسجَّل عند كل تشغيل: قائمة `/help` **هي** قائمة
            // `setMyCommands`، فلا يُعلَن أمرٌ لا يعمل ولا يعمل أمرٌ لم يُعلَن.
            register_commands(&cfg);
            // **هوية البوت مرة واحدة** (م٤): المنشن والردّ على رسالته يُقاسان
            // بها، وتعذّرها لا يُسقط البوت — يُسجَّل تحذير وتبقى الهوية فارغة
            // فتُقرأ الرسائل كما كانت (وضعٌ أضيق لا سلوك مخترع).
            let identity = fetch_identity(&cfg);
            if !identity.known() {
                tracing::warn!(target: "telegram", "تعذّر قراءة هوية البوت (getMe) — المنشن لن يُعرَف");
            }
            // قائمة السماح (م٤): تُحمَّل من القرص مرة واحدة لكل عامل.
            let access = AccessStore::from_path(access_path(&crate::paths::data_dir()));
            tracing::info!(
                target: "telegram",
                "قائمة السماح: {} مدخلاً",
                access.entries.len()
            );
            // Drop the backlog: links sent while the app was closed are stale,
            // and processing them unasked would burn the machine at startup.
            let mut offset = match call(
                &cfg,
                "getUpdates",
                &json!({ "offset": -1 }),
                Duration::from_secs(20),
            ) {
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
            let mut poll = PollState {
                identity,
                access,
                ..Default::default()
            };
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
                            handle_update(&cfg, &mut poll, &oversize, &u, &tx);
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

// ── النصوص والأوامر (م٣/٦) ──────────────────────────────────────────────────

fn mode_label(mode: Mode) -> &'static str {
    if mode == Mode::Song {
        "أغنية"
    } else {
        "مقطع عادي"
    }
}

/// نصّ سؤال الوضع. **وإشعار الانتظار يُقال هنا — عند الوصول**، لا عند الضغط على
/// الزرّ (شكوى المالك: كان لا يخبره أنه في قائمة الانتظار حتى يضغط).
///
/// والمصطلح: **«قائمة الانتظار»** و**«دورك: N»** — كلمة «طابور» مرفوضة.
fn mode_question_text(hint: &str, ahead: u32) -> String {
    let wait = if ahead > 0 {
        format!(
            "\n⏳ في قائمة الانتظار — دورك: {}\n(قبلك {} مهمّة تعمل أو تنتظر)\n",
            ahead.saturating_add(1),
            ahead
        )
    } else {
        String::new()
    };
    format!(
        "{hint}\n{wait}\nهل هذا أغنية أم مقطع عادي؟\n\
         (الأغنية: فصل كامل + قصّ الصمت — المقطع: إزالة الموسيقى فقط)"
    )
}

/// نصّ الانتظار بعد اختيار الوضع. **ولا يُقال «بدأت» قبل أن تبدأ فعلاً** —
/// [`running_text`] وحدها تقولها لحظة دخول المهمّة التنفيذ.
fn waiting_text(label: &str, position: u32) -> String {
    format!("⏳ في قائمة الانتظار — دورك: {position}\nالوضع: {label}")
}

/// لحظة **دخول المهمّة التنفيذ** فعلاً.
fn running_text(label: &str) -> String {
    format!("▶ بدأت المعالجة — الوضع: {label}")
}

/// نصّ بلوغ سقف المعلَّقات — صادق وقابل للتنفيذ، لا إسقاط صامت.
fn pending_full_text() -> String {
    format!(
        "⏳ عندك {MAX_PENDING_PER_CHAT} ملفات تنتظر اختيار الوضع — \
         أكمل الملفات الحالية أولاً ثم أعد إرسال هذا الملف."
    )
}

/// أوامر البوت — **مصدر واحد**: ما يُسجَّل في تلغرام (`setMyCommands`) هو نفسه
/// ما يعرضه `/help`، فلا يفترق إعلانٌ عن فعل (قاعدة المالك: ما يظهر يعمل).
///
/// **ولا `/stop` في أي مكان**: أمر واحد وظيفته الإلغاء (`/kill`) — فلا اسمان
/// لحالة واحدة، ولا أمرٌ يُعلَن ولا يفعل شيئاً.
const COMMANDS: &[(&str, &str)] = &[
    ("status", "ما يعمل الآن ولِمَن"),
    ("stats", "إحصاءاتك: عدد الملفات والحجم"),
    ("mode", "إعادة أزرار اختيار الوضع للملفات المنتظرة"),
    ("lang", "لغة رسائل البوت (العربية وحدها متاحة الآن)"),
    ("kill", "إلغاء مهمّة هذه المحادثة"),
    ("help", "قائمة الأوامر"),
];

/// **الأوامر العامة: صفر** (م٤/٣، بعد قياس توثيق تلغرام).
///
/// القائمة الافتراضية (`BotCommandScopeDefault`) تظهر في **كل** محادثة، ومنها
/// المجموعات. وفي المجموعة `/kill` و`/status` **للمالك وحده** ⇒ إعلانُهما هناك
/// إعلانُ أمرٍ سيُرفض، وهو نقض «ما يظهر يعمل». و`ChatMember`/`ChatAdministrators`
/// يسبقان `Chat` في المجموعات، فلا يُتّكل على نطاق محادثةٍ لتضييق مجموعة.
/// فالنتيجة: **لا أمر عام**، وقائمة المالك في نطاق محادثته وحدها.
const PUBLIC_COMMANDS: &[(&str, &str)] = &[];

/// قائمة موجزة **صادقة**: كل سطر فيها أمرٌ يعمل فعلاً — **لمن يقرؤها**.
/// وغير المالك يرى [`PUBLIC_COMMANDS`] وحدها، فلا يُعرض عليه أمرٌ سيُرفض.
fn help_text_for(is_owner: bool) -> String {
    let list: &[(&str, &str)] = if is_owner { COMMANDS } else { PUBLIC_COMMANDS };
    let mut s = String::from("🤖 أوامر البوت:\n");
    if list.is_empty() {
        s.push_str("(لا أوامر عامة — الأوامر تظهر في محادثة المالك وحدها)\n");
    }
    for (name, desc) in list {
        s.push_str(&format!("/{name} — {desc}\n"));
    }
    s.push_str(&format!(
        "\nأرسل رابط فيديو، أو ارفع ملف صوت/فيديو (حتى {} سحابياً)، \
         وسأزيل الموسيقى وأعيده إليك.",
        human_mb(CLOUD_DOWNLOAD_MAX_BYTES)
    ));
    s
}

/// قائمة المالك — الاسم الذي تناديه حرّاس `/help` القائمة (`help_text()`).
/// والمنتَج ينادي [`help_text_for`] لأن القائمة تختلف بحسب القارئ (م٤/٣).
#[cfg(test)]
fn help_text() -> String {
    help_text_for(true)
}

/// يفصل الأمر ووسيطه: `/kill@MyBot الآن` ⇒ `("kill", Some("الآن"))`.
/// ويعيد `None` إن لم تكن الرسالة أمراً — فلا يُقرأ نصٌّ عادي أمراً.
fn parse_command(text: &str) -> Option<(String, Option<String>)> {
    let rest = text.trim().strip_prefix('/')?;
    let mut it = rest.splitn(2, char::is_whitespace);
    let head = it.next().unwrap_or("");
    // `/kill@TheBot` موجَّه لبوت بعينه — يُقبل ممن يخاطب هذا البوت.
    let name = head.split('@').next().unwrap_or("").to_ascii_lowercase();
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let arg = it
        .next()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty());
    Some((name, arg))
}

/// نصّ `/status` — **نقيّ** (يأخذ `now_ms`) ليُقاس بلا شبكة ولا مهمّة حقيقية.
pub fn status_text(
    chat_id: i64,
    running: &[slots::JobInfo],
    queued: usize,
    pendings: usize,
    oversize: usize,
    last_error: &str,
    now_ms: u128,
) -> String {
    let mut s = String::from("📊 الحال الآن\n");
    // **كل مهامّ المحادثة** — لمستخدميها جميعاً: `/status` للمالك وحده في
    // المجموعة (م٤/٤)، فهو الذي يسأل «ما يعمل الآن **ولِمَن**».
    let prefix = chat_label_prefix(chat_id);
    let mine: Vec<&slots::JobInfo> = running
        .iter()
        .filter(|j| j.label.starts_with(&prefix))
        .collect();
    if mine.is_empty() {
        s.push_str("▶ لا شيء يعمل لهذه المحادثة الآن.\n");
    } else {
        s.push_str(&format!("▶ يعمل الآن ({}):\n", mine.len()));
        for j in mine {
            let secs = now_ms.saturating_sub(j.started_ms) / 1000;
            let file = j
                .path
                .as_deref()
                .map(display_name)
                .unwrap_or_else(|| "بلا ملف".to_string());
            s.push_str(&format!(
                "   • {file} — منذ {secs} ث{}\n",
                if j.cancelled {
                    " (طُلب إلغاؤها)"
                } else {
                    ""
                }
            ));
        }
    }
    s.push_str(&format!(
        "⏳ في قائمة الانتظار: {queued}\n\
         📎 ملفات تنتظر اختيار الوضع: {pendings}\n\
         ⏳ أسئلة ضغط مفتوحة: {oversize}\n\
         👤 المحادثة: {chat_id}"
    ));
    if !last_error.is_empty() {
        s.push_str(&format!("\n⚠️ آخر خطأ: {last_error}"));
    }
    s
}

/// نصّ `/lang` — **صادق**: العربية وحدها عاملة، ولا يُوهم بمفتاح لغةٍ لا وجود
/// لها (تسجيل `/lang` بوصفه مبدِّلاً وهو لا يبدّل شيئاً كذبٌ صريح).
fn lang_text(arg: Option<&str>) -> String {
    const AVAILABLE: [(&str, &str); 1] = [("ar", "العربية")];
    let list = AVAILABLE
        .iter()
        .map(|(c, n)| format!("{n} ({c})"))
        .collect::<Vec<_>>()
        .join(" · ");
    match arg {
        None => format!("🌐 لغة رسائل البوت: العربية\nالمتاح: {list}"),
        Some(code) => {
            let code = code.trim().to_ascii_lowercase();
            if AVAILABLE.iter().any(|(c, _)| *c == code) {
                format!("🌐 العربية هي اللغة العاملة أصلاً — لا تغيير.\nالمتاح: {list}")
            } else {
                format!("🌐 لا تتوفّر لغة «{code}» بعد — الرسائل بالعربية وحدها.\nالمتاح: {list}")
            }
        }
    }
}

// ── م٥: الإحصاءات (من الملف وحده) ───────────────────────────────────────────

/// زرّ **«📊 إحصاءات»**. وضغطةٌ عليه ⇒ **رسالة واحدة** لا تعديلٌ لرسالة قائمة:
/// مسار التعديل التجميلي (`status_push`) يخصّ تقدّم مهمّة، والزرّ ليس تقدّماً —
/// ورسالةٌ واحدة لكل ضغطة تحترم سقف المجموعة (٢٠/دقيقة) بلا استهلاكه بأزرار.
/// ومعرّف الزرّ **ثابت**: لا يحمل معرّفاً لأن ما يُعرَض سجلُّ الضاغط نفسه.
const STATS_CALLBACK: &str = "stats";

fn stats_keyboard() -> Value {
    json!({ "inline_keyboard": [[{ "text": "📊 إحصاءات", "callback_data": STATS_CALLBACK }]] })
}

/// نصّ الإحصاءات لصاحبها — **من ملفه وحده**: لا عدّ مهامّ ولا طابور ولا
/// معلَّقات (تلك في `/status`)، وهذا سجلٌّ تراكمي يُقرأ من القرص.
fn stats_reply(data: &Path, id: i64) -> String {
    crate::tg_stats::text_for(id, crate::tg_stats::load(data, id).as_ref())
}

/// يُرسل الإحصاءات **رسالةً واحدة** مربوطةً بالزرّ نفسه، وردّاً على رسالة
/// الطالب (`reply_to`) فلا تظهر في ذيل المحادثة بلا سياق.
fn send_stats(cfg: &TgConfig, chat_id: i64, user_id: i64, reply_to: i64) -> bool {
    let text = stats_reply(&crate::paths::data_dir(), user_id);
    send_message(cfg, chat_id, &text, Some(stats_keyboard()), Some(reply_to)).is_ok()
}

/// يدوّن تسليماً ناجحاً في سجلّ صاحبه (م٥) — **بأفضل جهد مع إعلان الفشل**:
/// تعذّرُ الكتابة لا يُسقط مهمّةً نجحت، ولا يُسكَت عنه (يُسجَّل تحذير)، ولا
/// يُخترع رقم.
fn note_stats_delivery(user_id: i64, user: &str, bytes: u64) {
    if let Err(e) = crate::tg_stats::note_delivery(&crate::paths::data_dir(), user_id, user, bytes)
    {
        tracing::warn!(target: "telegram", "تعذّر تدوين إحصاءات {user_id}: {e}");
    }
}

/// يسجّل قوائم الأوامر في تلغرام — **بنطاقٍ لكل محادثة** (م٤/٣): «ما يظهر يعمل».
///
/// ١) **النطاق الافتراضي: صفر أوامر** — تُحذف صراحةً بـ`deleteMyCommands`، فلا
///    تبقى قائمة بناءٍ سابق تظهر في المجموعات حيث `/kill` و`/status` مرفوضان.
/// ٢) **نطاق محادثة المالك** (`BotCommandScopeChat`): القائمة الكاملة، وفيها
///    وحدها `/kill` و`/status`. والنطاق «محادثة بعينها» **ولا يقبل القنوات**،
///    فالمعرّف موجب (محادثة المالك الخاصة) وإلا لم يُرسَل أصلاً.
///
/// **وبأفضل جهد**: فشلُ التسجيل لا يُسقط البوت (يُسجَّل تحذير). ومسار الإقلاع
/// هذا هو نفسه الذي تستعمله «اضبط الأوامر» في الواجهة ([`apply_bot_commands`]):
/// **فعلٌ واحد بنتيجتين مُعلَنتين** — تحذيرٌ في السجل هنا، وخطأٌ مُسمّى هناك.
fn register_commands(cfg: &TgConfig) {
    match apply_bot_commands(cfg) {
        Ok(n) => tracing::info!(
            target: "telegram",
            "سُجّلت أوامر المالك في محادثته وحدها: {n} أمراً"
        ),
        Err(e) => tracing::warn!(target: "telegram", "تعذّر ضبط الأوامر: {e}"),
    }
}

/// **م٥/٤ — «اضبط الأوامر»**: نفس ما بناه م٤ حرفاً بحرف (لا نسخة ثانية منه):
/// `deleteMyCommands` للنطاق الافتراضي ⇒ **صفر أوامر عامة**، و`setMyCommands`
/// بنطاق محادثة المالك ⇒ **ما يظهر يعمل**.
///
/// والفرق عن [`register_commands`] فرقُ **إعلانٍ لا فعل**: هذه تُعيد عددَ ما
/// سُجّل أو **خطأً مُسمّى بالسبب**، فيُعرَض في الواجهة «نجح/فشل» بصدق بدل
/// نجاحٍ مُفترَض. ولذلك تُنفَّذ المحاولتان **معاً** ثم يُبلَّغ أول فشل: تعليقُ
/// الثانية على نجاح الأولى كان يجعل فشلَ الإفراغ يمنع تسجيل قائمة المالك وهي
/// نافعةٌ في نفسها.
pub fn apply_bot_commands(cfg: &TgConfig) -> Result<usize, BotSetupError> {
    let cleared = call(
        cfg,
        "deleteMyCommands",
        &json!({ "scope": { "type": "default" } }),
        Duration::from_secs(20),
    )
    .map_err(|e| BotSetupError::Commands(format!("deleteMyCommands: {e}")));

    // **وحدود الـAPI تُفحص قبل الإرسال**: قائمةٌ مخالفة يرفضها تلغرام **كاملةً**
    // فيصير الفشل صامتاً ويظنّ المستخدم أن الأوامر سُجّلت. فالفحص هنا صريح،
    // والأرقام هي أرقام التوثيق المعلَنة في رأس الملف لا أرقاماً مخترعة.
    let too_long = COMMANDS.len() > MAX_BOT_COMMANDS;
    let bad = COMMANDS.iter().find(|(n, d)| {
        n.is_empty()
            || n.len() > MAX_COMMAND_NAME
            || d.is_empty()
            || d.len() > MAX_COMMAND_DESC
            || !n
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    });
    if too_long || bad.is_some() {
        return Err(BotSetupError::Limits(format!(
            "قائمة الأوامر مخالفة لحدود Bot API ({} أمراً · المخالف {bad:?}) — لم تُسجَّل",
            COMMANDS.len()
        )));
    }

    // النطاق «محادثة بعينها»: بلا معرّف مالك **موجب** لا نطاق — والإفراغ وحده
    // هو الصواب، ولا يُدَّعى تسجيلٌ لم يقع. **ويُعلَن ذلك خطأً لا نجاحاً**:
    // «نجح، صفر أوامر» في الواجهة يوهم بأن شيئاً سُجّل، والصحيح أنّ لا نطاق
    // محادثة أصلاً — فيُقال السبب (وهو نفس ما كان يُسجَّل تحذيراً في مسار الإقلاع).
    let Some(owner) = cfg.owner_id.filter(|id| *id > 0) else {
        cleared?;
        return Err(BotSetupError::NotConfigured(
            "لا معرّف مالك — لا نطاق محادثة تُسجَّل فيه الأوامر (اقترن أولاً)".to_string(),
        ));
    };
    let cmds: Vec<Value> = COMMANDS
        .iter()
        .map(|(c, d)| json!({ "command": c, "description": d }))
        .collect();
    let body = json!({
        "commands": cmds,
        "scope": { "type": "chat", "chat_id": owner },
    });
    let listed = call(cfg, "setMyCommands", &body, Duration::from_secs(20))
        .map_err(|e| BotSetupError::Commands(format!("setMyCommands: {e}")));

    // الاثنتان جُرِّبتا؛ والفشل يُعلَن (الأولوية للإفراغ: هو الذي يمنع ظهور
    // أمرٍ عامّ سيُرفض في المجموعة).
    cleared?;
    listed?;
    Ok(COMMANDS.len())
}

// ── م٥: هوية البوت — الاسم والصورة، وقابلة للعكس ────────────────────────────

/// خطأ **مُسمّى** لإعداد البوت: كلُّ فرعٍ يقول **أيُّ نداءٍ** فشل وبأي نصّ —
/// فلا `bool` غامض يُخفي فشلاً، ولا `let _ =` يجعل الرفض نجاحاً.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotSetupError {
    /// `getMyName` — بلا قراءة الاسم الحالي لا يُخزَّن سابقٌ، وبلا سابقٍ يكون
    /// العكس كذباً؛ فالفشل هنا **يوقف** التطبيق ولا يُكمَل على أمل.
    Read(String),
    /// `setMyName`.
    Name(String),
    /// `setMyProfilePhoto` / `removeMyProfilePhoto` (ومنه رفض الصيغة).
    Photo(String),
    /// `setMyCommands` / `deleteMyCommands`.
    Commands(String),
    /// قيمة مخالفة لحدود الـAPI: **لم تُرسَل أصلاً** (وتلغرام كان سيرفضها).
    Limits(String),
    /// حالة العكس على القرص — بلا تخزينِ الاسم السابق لا عكس صادق.
    State(String),
    /// لا بوت مُهيَّأ (لا توكن): لا نداء أصلاً ولا ادّعاء نجاح.
    NotConfigured(String),
}

impl std::fmt::Display for BotSetupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(e) => write!(f, "تعذّرت قراءة اسم البوت (getMyName): {e}"),
            Self::Name(e) => write!(f, "تعذّر تعيين اسم البوت (setMyName): {e}"),
            Self::Photo(e) => write!(f, "تعذّر ضبط صورة البوت: {e}"),
            Self::Commands(e) => write!(f, "تعذّر ضبط الأوامر: {e}"),
            Self::Limits(e) => write!(f, "قيمة مخالفة لحدود Bot API: {e}"),
            Self::State(e) => write!(f, "حالة الهوية: {e}"),
            Self::NotConfigured(e) => write!(f, "لا بوت مُهيَّأ: {e}"),
        }
    }
}

impl std::error::Error for BotSetupError {}

/// حالة الهوية على القرص: **الاسم السابق يُخزَّن صراحةً** لأن `setMyName("")`
/// يزيل الاسم المخصّص لتلك اللغة ولا يُرجع الافتراضي — فبلا تخزينٍ صريح يصير
/// «العكس» محواً للاسم لا إعادةً له.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct BotIdentityState {
    /// هل الهوية مطبَّقة الآن؟ (يُرفع **بعد** نجاح نداءَي التطبيق لا قبله.)
    applied: bool,
    /// الاسم الذي كان على البوت قبلنا. وفراغُه معناه «لم يكن له اسم مخصّص»،
    /// وإعادتُه فراغاً هي الصدق نفسه لا نقصٌ في العكس.
    previous_name: String,
    /// **هل صورةُ HaramLite مرفوعة الآن؟** (جولة التفنيد، عطل ٦.)
    ///
    /// `applied` لا يكفي: فشلُ `setMyName` **بعد** نجاح الرفع يترك صورةً بلا
    /// اسم، ولو كان الحقل الوحيد `applied=false` لصار العكسُ لا يعرف أن عليه
    /// إزالة صورة. فالحقلان يفترقان، والعكس يعمل إن كان أحدهما صحيحاً.
    ///
    /// **وحدّ الـAPI**: لا تُقرأ صورة البوت الحالية (لا دالّة لها) ⇒ «العكس»
    /// **يُزيل** الصورة ولا يُعيد ما كان عليها قبلنا.
    #[serde(default)]
    photo_applied: bool,
    /// آخر اسمٍ **قاله الخادم** (`getMyName`) أو تأكّد بنداء `setMyName` ناجح.
    /// وهو أساس «مطابق الآن» — لا رايتنا المحلّية وحدها (عطل ٣).
    #[serde(default)]
    server_name: String,
    /// متى قُوبل الاسم مع الخادم (ميلي ثانية منذ الحقبة) — به يُقاس عُمر
    /// التحقّق، ويُعرَض «قبل كم ثانية» بدل ادّعاء معرفةٍ حالية.
    #[serde(default)]
    checked_ms: u128,
}

/// كم يبقى التحقّق من الخادم صالحاً قبل إعادة قراءته في الخلف — **اختيارنا**
/// المعلَن: نداء `getMyName` واحد في الدقيقة كحدّ أقصى، ولا حجب لأي مسار.
const IDENTITY_VERIFY_TTL: Duration = Duration::from_secs(60);

/// ملف حالة الهوية — بجانب `telegram-access.json` في جذر مجلد البيانات (نفس
/// نمط جيرانه من ملفات حالة تيليجرام).
fn identity_path(data: &Path) -> PathBuf {
    data.join("telegram-identity.json")
}

/// `None` يعني **لا ملف**: لم نمسّ هوية هذا البوت قطّ، فلا عكسَ بلا سابق.
fn load_identity_state(data: &Path) -> Option<BotIdentityState> {
    let raw = std::fs::read_to_string(identity_path(data)).ok()?;
    serde_json::from_str::<BotIdentityState>(&raw).ok()
}

fn save_identity_state(data: &Path, st: &BotIdentityState) -> Result<(), BotSetupError> {
    let path = identity_path(data);
    let body = serde_json::to_string(st).map_err(|e| BotSetupError::State(e.to_string()))?;
    crate::atomic::write_atomic_str(&path, &body, "json")
        .map_err(|e| BotSetupError::State(format!("{}: {e}", path.display())))
}

/// قفل التطبيق/العكس: نداءان متوازيان كانا يرفعان الصورة مرّتين ويتباريان على
/// الاسم السابق. والقفل يجعل «مُطبَّقٌ بالفعل» حكماً يُقرأ **بعد** انتهاء الآخر.
fn identity_lock() -> std::sync::MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// نتيجة تطبيق/عكس الهوية — أرقامٌ تقول ما جرى فعلاً.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotIdentityOutcome {
    /// هل الهوية مطبَّقة الآن؟
    pub applied: bool,
    /// الاسم الذي صار على البوت الآن.
    pub name: String,
    /// الاسم الذي كان قبله (وهو ما يُعاد عند العكس).
    pub previous_name: String,
    /// بايتات الصورة المرفوعة (صفر في العكس).
    pub photo_bytes: usize,
}

/// أبعاد JPEG **من الملف نفسه**: أول وسم `SOF`. قراءةُ مقاطع مباشرة بلا
/// اعتمادية، والغرض أن يكون الحارس على الصورة حكماً على بايتاتها لا على امتداد
/// اسمِها.
fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2usize; // بعد SOI (FF D8)
    while i + 3 < b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = b[i + 1];
        if marker == 0xFF {
            i += 1; // حشو: FF متكرّرة قبل الوسم
            continue;
        }
        if marker == 0xD8 || (0xD0..=0xD9).contains(&marker) {
            i += 2; // وسوم بلا طول
            continue;
        }
        let len = ((b[i + 2] as usize) << 8) | b[i + 3] as usize;
        if len < 2 {
            return None;
        }
        // SOF0..SOF3 · SOF5..SOF7 · SOF9..SOF11 · SOF13..SOF15 (بلا DHT/DAC…)
        if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF)
            && i + 9 < b.len()
        {
            let h = ((b[i + 5] as u32) << 8) | b[i + 6] as u32;
            let w = ((b[i + 7] as u32) << 8) | b[i + 8] as u32;
            return Some((w, h));
        }
        i += 2 + len;
    }
    None
}

/// **حارس الصورة قبل الرفع**: ملف JPEG صالح (ترويسة `FFD8FF` ونهاية `FFD9`)
/// وأبعادٌ معقولة. وهذا حكمٌ على **البايتات التي ستُرسَل** لا على نيّةٍ في
/// تعليق — فصورةٌ مرفوضة تُعلَن قبل أن تُرسَل، وإن رفضها الـAPI فالخطأ مُسمّى.
///
/// **ولا يُدَّعى حدُّ تلغرام**: الحدّان هنا (‎16..4096‎) حدّانا لمنع ملفٍ عبثي،
/// لا نقلُ حدٍّ من توثيقٍ لا يذكره.
fn photo_problem(jpg: &[u8]) -> Result<(u32, u32), String> {
    if jpg.len() < 4 || jpg[..3] != [0xFF, 0xD8, 0xFF] {
        return Err(format!(
            "ليس JPEG صالحاً: ترويسة FFD8FF مفقودة ({} بايت)",
            jpg.len()
        ));
    }
    if jpg[jpg.len() - 2..] != [0xFF, 0xD9] {
        return Err("ملف JPEG بلا نهاية FFD9 (ملف مقطوع)".to_string());
    }
    let (w, h) = jpeg_size(jpg).ok_or_else(|| "تعذّرت قراءة أبعاد JPEG (لا وسم SOF)".to_string())?;
    if !(16..=4096).contains(&w) || !(16..=4096).contains(&h) {
        return Err(format!("أبعاد الصورة خارج المعقول: {w}×{h}"));
    }
    Ok((w, h))
}

/// الاسم الحالي للبوت (`getMyName`).
fn bot_current_name(cfg: &TgConfig) -> Result<String, BotSetupError> {
    let v = call(cfg, "getMyName", &json!({}), Duration::from_secs(20))
        .map_err(|e| BotSetupError::Read(format!("getMyName: {e}")))?;
    Ok(v.get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

/// `setMyName` — والفراغ مقبول **بمعناه الموثَّق**: إزالة الاسم المخصّص.
fn set_bot_name(cfg: &TgConfig, name: &str) -> Result<(), BotSetupError> {
    let len = name.chars().count();
    if len > MAX_BOT_NAME {
        return Err(BotSetupError::Limits(format!(
            "اسم البوت {len} حرفاً وحدّ setMyName {MAX_BOT_NAME}"
        )));
    }
    call(
        cfg,
        "setMyName",
        &json!({ "name": name }),
        Duration::from_secs(20),
    )
    .map_err(|e| BotSetupError::Name(format!("setMyName: {e}")))?;
    Ok(())
}

/// يرفع صورة البوت: **`multipart/form-data` إلزاماً** («can only be uploaded as
/// a new file» — لا `file_id` ولا رابط)، وحقل `photo` **نصٌّ** فيه
/// `{"type":"static","photo":"attach://<اسم المرفق>"}`، والصورة في جزءٍ باسم ذلك
/// المرفق نفسه.
fn upload_bot_photo(cfg: &TgConfig) -> Result<usize, BotSetupError> {
    let (w, h) = photo_problem(BOT_PHOTO_JPG).map_err(BotSetupError::Photo)?;
    let fields = [(
        "photo",
        format!(r#"{{"type":"static","photo":"attach://{BOT_PHOTO_ATTACH}"}}"#),
    )];
    let body = MultipartBody::build(&fields, BOT_PHOTO_ATTACH, BOT_PHOTO_NAME, "image/jpeg");
    let url = format!("{}/setMyProfilePhoto", cfg.api());
    let len = BOT_PHOTO_JPG.len() as u64;
    post_multipart(
        &url,
        &body,
        Cursor::new(BOT_PHOTO_JPG),
        len,
        Duration::from_secs(120),
        &cfg.token,
    )
    .map_err(|e| BotSetupError::Photo(format!("setMyProfilePhoto: {e}")))?;
    tracing::info!(target: "telegram", "صورة البوت رُفعت ({w}×{h} · {len} بايت)");
    Ok(BOT_PHOTO_JPG.len())
}

/// `removeMyProfilePhoto` (متاح منذ Bot API 9.4) — عكسُ رفع الصورة.
fn remove_bot_photo(cfg: &TgConfig) -> Result<(), BotSetupError> {
    call(
        cfg,
        "removeMyProfilePhoto",
        &json!({}),
        Duration::from_secs(60),
    )
    .map_err(|e| BotSetupError::Photo(format!("removeMyProfilePhoto: {e}")))?;
    Ok(())
}

/// **يُطبِّق هوية HaramLite**: الاسم والصورة — وأي فشلٍ خطأٌ مُسمّى.
///
/// والترتيب مقصود:
/// ① يُقرأ الاسم الحالي (وفشلُه يوقف كل شيء: بلا سابقٍ لا عكس صادق)،
/// ② ويُخزَّن السابق على القرص **قبل** أي تبديل،
/// ③ ثم **الصورة** — وهي الخطوة التي تُرفض (صيغة) فلا يبقى نصفُ تطبيق،
/// ④ ثم الاسم،
/// ⑤ وتُرفع راية «مُطبَّق» **بعد** نجاح النداءين لا قبلهما.
pub fn apply_bot_identity(
    cfg: &TgConfig,
    data: &Path,
) -> Result<BotIdentityOutcome, BotSetupError> {
    let _g = identity_lock();
    let current = bot_current_name(cfg)?;
    let stored = load_identity_state(data);
    // إعادةُ تطبيقٍ على هوية مطبَّقة: لا يُستبدل السابق بالتسمية نفسها (وإلا
    // صار العكس إعادةَ «HaramLite» مكان «HaramLite»).
    let previous = match &stored {
        Some(st) if current.trim() == BOT_DISPLAY_NAME => st.previous_name.clone(),
        _ => current,
    };
    if previous.chars().count() > MAX_BOT_NAME {
        return Err(BotSetupError::Limits(format!(
            "الاسم السابق {} حرفاً فوق حدّ setMyName {MAX_BOT_NAME}",
            previous.chars().count()
        )));
    }
    save_identity_state(
        data,
        &BotIdentityState {
            applied: false,
            previous_name: previous.clone(),
            photo_applied: false,
            server_name: previous.clone(),
            checked_ms: epoch_ms(),
        },
    )?;
    let photo_bytes = upload_bot_photo(cfg)?;
    // **الصورة صارت مرفوعة فعلاً** — يُدوَّن فوراً (عطل ٦): فشلُ الاسم بعدها كان
    // يترك صورةً بلا اسم بلا أثرٍ في الحالة، فيصير العكس أعمى عنها.
    save_identity_state(
        data,
        &BotIdentityState {
            applied: false,
            previous_name: previous.clone(),
            photo_applied: true,
            server_name: previous.clone(),
            checked_ms: epoch_ms(),
        },
    )?;
    if let Err(e) = set_bot_name(cfg, BOT_DISPLAY_NAME) {
        // **لا نجاح نصفيّ صامت**: النصّ يقول ما نجح وما فشل، والحالة تحمل
        // `photo_applied:true` فيعمل العكس (يُزيل الصورة ويُعيد الاسم).
        return Err(match e {
            BotSetupError::Name(m) => BotSetupError::Name(format!(
                "{m} — ⚠ الصورة رُفعت فعلاً والاسم لم يُضبط؛ \
                 ألغِ المربّع لإزالة الصورة وإعادة الاسم «{previous}»"
            )),
            other => other,
        });
    }
    save_identity_state(
        data,
        &BotIdentityState {
            applied: true,
            previous_name: previous.clone(),
            photo_applied: true,
            server_name: BOT_DISPLAY_NAME.to_string(),
            checked_ms: epoch_ms(),
        },
    )?;
    Ok(BotIdentityOutcome {
        applied: true,
        name: BOT_DISPLAY_NAME.to_string(),
        previous_name: previous,
        photo_bytes,
    })
}

/// **يعكس الهوية**: يُزيل الصورة ويُعيد **الاسم المخزَّن** نصّاً — ولو كان
/// فارغاً، لأن الفراغ هو ما كان (إزالة الاسم المخصّص لا إرجاع الافتراضي).
///
/// وبلا حالةٍ مخزَّنة **لا يُعكَس شيء**: `revert` بلا سابقٍ كان سيمحو اسم البوت
/// الحقيقي — والامتناع هنا أصدق من فعلٍ لا يُعرَف مرجعه.
///
/// **وحدّ الـAPI يُعلَن**: لا دالّة تقرأ صورة البوت الحالية ⇒ العكس **يُزيل**
/// الصورة ولا يُعيد ما كانت عليه قبلنا؛ وما يُعاد نصّاً هو **الاسم** وحده.
pub fn revert_bot_identity(
    cfg: &TgConfig,
    data: &Path,
) -> Result<BotIdentityOutcome, BotSetupError> {
    let _g = identity_lock();
    let Some(st) = load_identity_state(data) else {
        return Err(BotSetupError::State(
            "لا هوية مطبَّقة مخزَّنة — لا اسم سابق يُعاد".to_string(),
        ));
    };
    let previous = st.previous_name.clone();
    remove_bot_photo(cfg)?;
    // الصورة أُزيلت فعلاً (عطل ٦ بالاتجاه المعاكس): يُدوَّن قبل محاولة الاسم.
    save_identity_state(
        data,
        &BotIdentityState {
            applied: false,
            previous_name: previous.clone(),
            photo_applied: false,
            server_name: BOT_DISPLAY_NAME.to_string(),
            checked_ms: epoch_ms(),
        },
    )?;
    if let Err(e) = set_bot_name(cfg, &previous) {
        return Err(match e {
            BotSetupError::Name(m) => BotSetupError::Name(format!(
                "{m} — ⚠ الصورة أُزيلت فعلاً والاسم لم يُعَد إلى «{previous}»"
            )),
            other => other,
        });
    }
    save_identity_state(
        data,
        &BotIdentityState {
            applied: false,
            previous_name: previous.clone(),
            photo_applied: false,
            server_name: previous.clone(),
            checked_ms: epoch_ms(),
        },
    )?;
    Ok(BotIdentityOutcome {
        applied: false,
        name: previous.clone(),
        previous_name: previous,
        photo_bytes: 0,
    })
}

/// **يُقابل حالتنا بالخادم** (`getMyName`) ويُدوِّن ما قاله — عطل ٣: الراية
/// المحلّية تقول «طبّقنا»، ولا تقول «مطابق الآن»؛ ومن أعاد الاسم من BotFather
/// لا يُكتشَف برايةٍ وحدها.
///
/// ويُعيد الاسم كما رآه الخادم، أو خطأ `Read` إن تعذّر النداء (ولا يُخمَّن).
pub fn verify_identity_name(cfg: &TgConfig, data: &Path) -> Result<String, BotSetupError> {
    let _g = identity_lock();
    let name = bot_current_name(cfg)?;
    let mut st = load_identity_state(data).unwrap_or_default();
    st.server_name = name.clone();
    st.checked_ms = epoch_ms();
    save_identity_state(data, &st)?;
    Ok(name)
}

/// **هل يحين وقت مقابلةٍ جديدة؟** — نقيّة على الزمن (تُقاس بلا شبكة).
fn verify_due(last_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(last_ms) >= IDENTITY_VERIFY_TTL.as_millis() as u64
}

/// **يحجز محاولة مقابلة**: يكتب وقت المحاولة، ويعيد `true` إن حجزها.
///
/// **والترتيب هنا موضع عطل حقيقي كشفه القياس لا النظر**: نسخةٌ كتبت الختم ثم
/// فحصت المدة كانت **تُصفِّر المؤقّت مع كل نداء** — وواجهةٌ تستطلع الحالة كل
/// ٥ ثوانٍ تُبقي الفرق ٥ ثوانٍ أبداً، فلا تقع مقابلةٌ أبداً. فالفحص **قبل**
/// الكتابة، ولا يُكتب الختم إلا حين تُحجز المحاولة فعلاً.
fn claim_verify_slot(last: &AtomicU64, now_ms: u64) -> bool {
    if !verify_due(last.load(Ordering::SeqCst), now_ms) {
        return false;
    }
    last.store(now_ms, Ordering::SeqCst);
    true
}

/// **هل حالة القرص كافية؟** تُقرأ الحالة، فإن كان آخر تحقّق أقدم من
/// [`IDENTITY_VERIFY_TTL`] أُطلق **خيطٌ واحد** يُقابلها بالخادم ولا يُحجَب أي
/// مسار. ولا يُنتظر الخيط: القارئ يرى الحالة الحالية، والمقابلة تصل بعدها
/// بالنتيجة (وفيها `server_name` و`checked_ms`).
fn spawn_identity_verify_if_stale(cfg: &TgConfig, data: &Path) {
    static LAST_ATTEMPT: AtomicU64 = AtomicU64::new(0);
    if !claim_verify_slot(&LAST_ATTEMPT, epoch_ms() as u64) {
        return;
    }
    let cfg = cfg.clone();
    let data = data.to_path_buf();
    let _ = std::thread::Builder::new()
        .name("tg-identity-verify".into())
        .spawn(move || {
            if let Err(e) = verify_identity_name(&cfg, &data) {
                tracing::debug!(target: "telegram", "تعذّرت مقابلة اسم البوت بالخادم: {e}");
            }
        });
}

/// يُزامن الهوية مع المطلوب **مرة واحدة عند اللزوم**: لا نداء إن كان الواقع
/// مطابقاً للمطلوب، فلا رفعُ صورةٍ في كل حفظِ إعدادات ولا في كل إقلاع.
/// `None` = لا شيء يستحق نداءً.
///
/// **وهذا المسار (الإقلاع/دفع الإعدادات) لا يسأل الخادم**: نداء `getMyName` في
/// كل حفظِ إعدادات كلفةٌ بلا مقابل — والمقابلة بالخادم تقع في مسار الضغطة
/// ([`set_identity_now`]) وفي التحقّق الدوري.
pub fn sync_bot_identity(
    cfg: &TgConfig,
    data: &Path,
    wanted: bool,
) -> Option<Result<BotIdentityOutcome, BotSetupError>> {
    let st = load_identity_state(data).unwrap_or_default();
    if !identity_needs_call(&st, wanted) {
        return None;
    }
    Some(if wanted {
        apply_bot_identity(cfg, data)
    } else {
        revert_bot_identity(cfg, data)
    })
}

/// **هل يلزم نداء؟** حكمٌ بلا شبكة: راية القرص و`photo_applied`، **وما قاله
/// الخادم في آخر مقابلة**.
///
/// * مطلوبُ التطبيق: يلزم إن لم تكن الراية مرفوعة، **أو** كانت مرفوعة وآخر
///   مقابلةٍ تقول إن الاسم على الخادم ليس اسمنا (إعادةُ تسميةٍ من `@BotFather`
///   ⇒ يُعاد التطبيق عند أول حفظِ إعدادات، من دون نداءٍ إضافي: المقابلة
///   مسجَّلة أصلاً)؛
/// * مطلوبُ العكس: يلزم إن كان لنا **أثر** — اسمٌ مطبَّق أو صورة معلّقة من
///   تطبيقٍ فشل نصفه (عطل ٦). ورايةٌ منزوعة بلا صورة ⇒ لا نداء.
fn identity_needs_call(st: &BotIdentityState, wanted: bool) -> bool {
    if wanted {
        !st.applied || (st.checked_ms > 0 && st.server_name.trim() != BOT_DISPLAY_NAME)
    } else {
        st.applied || st.photo_applied
    }
}

/// **قرار الضغطة، مقابَلاً بالخادم** (عطل ٣): يُقرأ الاسم الحقيقي من `getMyName`
/// أولاً، ثم يُقرَّر:
///
/// * مطلوب التطبيق والاسم على الخادم **هو** اسمنا ⇒ لا شيء (لا رفعَ صورة ثانياً)؛
/// * مطلوب التطبيق والاسم غيره (أعاده المالك من BotFather مثلاً) ⇒ **يُعاد
///   التطبيق** ولو كانت رايتنا تقول «مطبَّق»؛
/// * مطلوب العكس ولنا أثر (اسمٌ أو صورة) ⇒ عكس.
pub fn set_identity_now(enabled: bool) -> Result<Value, BotSetupError> {
    let cfg = live_cfg().ok_or_else(|| BotSetupError::NotConfigured("لا توكن للبوت".into()))?;
    let data = crate::paths::data_dir();
    match decide_identity_action(&cfg, &data, enabled) {
        IdentityAction::None => {
            let st = load_identity_state(&data).unwrap_or_default();
            if let Ok(mut s) = status().lock() {
                s.identity_error.clear();
            }
            Ok(identity_payload(&st, false, ""))
        }
        IdentityAction::Apply => finish_identity(apply_bot_identity(&cfg, &data), &data),
        IdentityAction::Revert => finish_identity(revert_bot_identity(&cfg, &data), &data),
    }
}

/// ما يجب فعله عند ضغطة المربّع — حكمٌ **مقيس بالخادم** لا بالراية وحدها.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdentityAction {
    None,
    Apply,
    Revert,
}

/// **القرار** — دالّة نقيّة تُغذّى بما قاله الخادم (فتُقاس بلا شبكة):
/// `server_name` هو ما ردّ به `getMyName`، و`state` ما عندنا على القرص.
fn identity_action(server_name: &str, state: &BotIdentityState, wanted: bool) -> IdentityAction {
    let ours_now = server_name.trim() == BOT_DISPLAY_NAME;
    if wanted {
        // مطبَّقٌ فعلاً: رايتنا مرفوعة **والخادم يقول اسمنا**. وغير ذلك يلزمه
        // نداء: رايةٌ منزوعة، أو اسمٌ غيّره المالك، أو صورةٌ معلّقة بلا اسم.
        if state.applied && ours_now {
            IdentityAction::None
        } else {
            IdentityAction::Apply
        }
    } else if state.applied || state.photo_applied || ours_now {
        // `ours_now` وحدها سببٌ للعكس: اسمُنا على الخادم أثرٌ لنا ولو ضاعت
        // رايتنا (ملف حالة حُذف) — وإلا بقي الاسم غريباً عن صاحبه.
        IdentityAction::Revert
    } else {
        IdentityAction::None
    }
}

/// يقرأ الخادم ثم يحكم — و**الفشل في القراءة يُعلَن** ولا يُخمَّن: بلا معرفة
/// اسم الخادم لا يُقال «لا شيء يستحق نداءً».
fn decide_identity_action(cfg: &TgConfig, data: &Path, wanted: bool) -> IdentityAction {
    let state = load_identity_state(data).unwrap_or_default();
    match bot_current_name(cfg) {
        Ok(name) => {
            let mut st = state.clone();
            st.server_name = name.clone();
            st.checked_ms = epoch_ms();
            let _ = save_identity_state(data, &st);
            identity_action(&name, &state, wanted)
        }
        Err(e) => {
            if let Ok(mut s) = status().lock() {
                s.identity_error = e.to_string();
            }
            tracing::warn!(target: "telegram", "تعذّرت قراءة اسم البوت قبل القرار: {e}");
            // بلا قراءةٍ لا ادّعاء: يُحكَم بالراية المحلّية وحدها (أضيق مسار)
            // — وهذا أصدق من ردّ نجاحٍ بلا فعل.
            if wanted {
                if state.applied {
                    IdentityAction::None
                } else {
                    IdentityAction::Apply
                }
            } else if state.applied || state.photo_applied {
                IdentityAction::Revert
            } else {
                IdentityAction::None
            }
        }
    }
}

/// يُنهي مسار الضغطة: نجاحٌ ⇒ **حمولةُ واقع** كاملة (ومعها بايتات الصورة
/// المرفوعة و`changed:true`)، وفشلٌ ⇒ نصّه محفوظاً ليعرضه `telegram_status`.
fn finish_identity(
    outcome: Result<BotIdentityOutcome, BotSetupError>,
    data: &Path,
) -> Result<Value, BotSetupError> {
    match outcome {
        Ok(o) => {
            let st = load_identity_state(data).unwrap_or_default();
            if let Ok(mut s) = status().lock() {
                s.identity_error.clear();
            }
            let mut v = identity_payload(&st, true, "");
            v["photo_bytes"] = json!(o.photo_bytes);
            Ok(v)
        }
        Err(e) => {
            if let Ok(mut s) = status().lock() {
                s.identity_error = e.to_string();
            }
            Err(e)
        }
    }
}

// ── م٤: رسالة التعريف المثبَّتة ونصيحة المعالج ──────────────────────────────

/// **نصيحة المعالج** (م٤/٨) — تُبنى على **ما جرى فعلاً** لا على تحليلٍ نظري.
///
/// * المصدر [`crate::separator::read_provider`] — المزوّد **المقيس** لآخر جلسة
///   فصل حقيقية على هذا الجهاز (‏`provider.json`).
/// * و`None` (لم يجرِ فصلٌ بعد) ⇒ **لا نصيحة**: لا يُدَّعى مسارٌ لم يُقَس.
/// * **ولا يُقاس CPU الصافي**: لا عَلَم في هذا البناء يعطّل CUDA وDirectML
///   معاً، فالحكم على التجربة وحدها — ولا رقم مُختلق (`m4-design.md` §٤).
fn cpu_advice_line(provider: Option<&str>) -> Option<&'static str> {
    match provider {
        Some("CPU") => Some(
            "⚠️ آخر فصلٍ على هذا الجهاز جرى على المعالج (CPU) لا على كرت — \
             ومجموعةٌ فيها أكثر من عضو غير عملية على المعالج.",
        ),
        _ => None,
    }
}

/// نصّ رسالة التعريف المثبَّتة (سطران كما في التصميم §٢-١)، ومعرّف البوت يُذكر
/// **إن عُرف** فقط — ولا يُختلق اسمٌ لم يُقرأ.
fn intro_text(bot: &BotIdentity, advice: Option<&str>) -> String {
    let example = if bot.username.is_empty() {
        "اذكرني مع الرابط: مثال `@<البوت> https://…`".to_string()
    } else {
        format!("اذكرني مع الرابط — مثال: `@{} https://…`", bot.username)
    };
    let mut s = format!("📌 للاستخدام: {example}\nوالمعالجة تجري على جهاز المالك.");
    if let Some(a) = advice {
        s.push_str(&format!("\n\n{a}"));
    }
    s
}

// ── سؤال التجاوز: الحساب نقيّ والنصوص ثابتة (م٣/٤) ───────────────────────────

/// الحجم المتوقَّع بالميغابايت لمعدّلٍ ومدة — **معكوس الصيغة نفسها** المستعملة
/// في `media::target_video_kbps`/`target_audio_kbps` (‏`mb × 8192 / ث`)، فلا
/// رقمان لشيء واحد.
fn projected_mb(kbps: u32, secs: f64) -> f64 {
    if crate::media::invalid_budget(secs) {
        return f64::INFINITY;
    }
    f64::from(kbps) * secs / 8192.0
}

/// ما يمكن عرضه لصاحب ناتجٍ تجاوز السقف. الصفر يعني «هذا الخيار غير ممكن»،
/// ولا يُعرض زرٌّ لا يفعل شيئاً (قاعدة المالك: ما يظهر يعمل).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OversizePlan {
    /// «🗜️ اضغط وأرسل»: إعادة ترميز **الفيديو** إلى هذا المعدّل، أو الصوت إن
    /// كان الناتج صوتاً. صفر = لا يدخل الهدف.
    pub shrink_kbps: u32,
    /// «🎧 أرسله صوتاً»: استخراج الصوت وضغطه إلى هذا المعدّل (ناتج فيديو فقط).
    pub audio_kbps: u32,
}

impl OversizePlan {
    pub fn can_shrink(&self) -> bool {
        self.shrink_kbps > 0
    }
    pub fn can_audio(&self) -> bool {
        self.audio_kbps > 0
    }
    /// هل يمكن إدخال هذا الناتج بالضغط إطلاقاً؟
    pub fn any(&self) -> bool {
        self.can_shrink() || self.can_audio()
    }
}

/// يخطّط ما يمكن عمله بناتجٍ تجاوز السقف: يحسب المعدّل الذي **يدخل الهدف
/// فعلاً** (لا الذي يُطلب فقط)، فلا يُعرض خيارٌ لا يبلغه.
///
/// ولناتج **فيديو**: «الضغط» إعادة ترميز الصورة، و«أرسله صوتاً» ضغط الصوت —
/// ولا يُعرض زرّ الصوت إذا لم يكن الصوت نفسه داخل الهدف. وإن لم يدخل الفيديو
/// بصورةٍ مشاهَدة (`MIN_WATCHABLE_VIDEO_KBPS`) فالزرّ الأول لا يُعرض أصلاً.
pub fn plan_oversize(duration_secs: f64, has_video: bool) -> OversizePlan {
    let audio_kbps = crate::media::target_audio_kbps(duration_secs, CLOUD_TARGET_MB);
    let audio_fits = audio_kbps > 0 && projected_mb(audio_kbps, duration_secs) <= CLOUD_TARGET_MB;
    if !has_video {
        // ناتج صوتي: «الضغط» هو إعادة ترميز الصوت نفسه، ولا معنى لزرّ «أرسله صوتاً».
        return OversizePlan {
            shrink_kbps: if audio_fits { audio_kbps } else { 0 },
            audio_kbps: 0,
        };
    }
    let video_kbps = crate::media::target_video_kbps(duration_secs, CLOUD_TARGET_MB, AUDIO_KBPS);
    let video_fits = video_kbps >= MIN_WATCHABLE_VIDEO_KBPS
        && projected_mb(video_kbps.saturating_add(AUDIO_KBPS), duration_secs) <= CLOUD_TARGET_MB;
    OversizePlan {
        shrink_kbps: if video_fits { video_kbps } else { 0 },
        audio_kbps: if audio_fits { audio_kbps } else { 0 },
    }
}

/// نصّ سؤال التجاوز. **يقول ما سيقع** ولا يَعِد بخيارٍ لا يبلغ الهدف، ويُصرّح
/// بأن الملف باقٍ في مجلد النتائج (لا حذف — شرط قبول م٣).
pub fn oversize_text(bytes: u64, file: &str, plan: &OversizePlan) -> String {
    let head = format!(
        "⚠️ الناتج {} — {file}\nيتجاوز حدّ الإرسال في تلغرام ({}).\n\
         الملف محفوظ في مجلد النتائج ولن يُحذف.",
        human_mb(bytes),
        human_mb(CLOUD_SEND_MAX_BYTES)
    );
    if plan.any() {
        format!("{head}\n\nاختر ما تريد:")
    } else {
        format!(
            "{head}\n\n✗ ولا يمكن إدخاله بالضغط: أطول من أن يحمله أدنى معدّل صوتي \
             ({} كيلوبت، والهدف {} م.ب).\n\
             ارفع الحدّ بخادم Bot API محلي (زرّ «كيف أرفع الحدّ؟»)، أو أرسل مقطعاً أقصر، \
             أو خُذ الملف من مجلد النتائج على الجهاز.",
            crate::media::MIN_AUDIO_KBPS,
            CLOUD_TARGET_MB.round() as u32
        )
    }
}

/// الدليل — **معلوماتي فقط** (ت٥): لا رابط يُفتح تلقائياً ولا إجراء يتّخذ،
/// والسؤال يبقى قائماً.
pub fn oversize_guide_text() -> String {
    format!(
        "ℹ️ كيف أرفع الحدّ؟\n\n\
         • حدّ تلغرام السحابي للبوت: {} إرسالاً و{} استقبالاً — وهو حدّ الخدمة، \
         لا إعداد في هذا البرنامج.\n\
         • الحلّ الرسمي: تشغيل خادم Bot API محلي (‏telegram-bot-api) على الجهاز، \
         فيصير الحدّ 2000 م.ب.\n\
         • وبعد تشغيله: الإعدادات ← تيليجرام ← «عنوان الخادم المحلي» \
         (مثال: {LOCAL_SERVER_HINT}).\n\n\
         وهذا الزرّ معلومة لا إجراء: لا يرسل شيئاً ولا يغيّر إعداداً.\n\
         ولا أقسّم الناتج إلى أجزاء — قرار المالك.",
        human_mb(CLOUD_SEND_MAX_BYTES),
        human_mb(CLOUD_DOWNLOAD_MAX_BYTES)
    )
}

/// لوحة أزرار السؤال: زرٌّ لكل فعل **ممكن**، ثم الدليل، ثم الإلغاء.
fn oversize_keyboard(plan: &OversizePlan) -> Value {
    let mut actions: Vec<Value> = Vec::new();
    if plan.can_shrink() {
        actions.push(json!({
            "text": format!("🗜️ اضغط وأرسل (حتى ~{} م.ب)", CLOUD_TARGET_MB.round() as u32),
            "callback_data": "oversize:shrink",
        }));
    }
    if plan.can_audio() {
        actions.push(json!({ "text": "🎧 أرسله صوتاً", "callback_data": "oversize:audio" }));
    }
    let mut rows: Vec<Value> = Vec::new();
    if !actions.is_empty() {
        rows.push(Value::Array(actions));
    }
    rows.push(json!([{ "text": "ℹ️ كيف أرفع الحدّ؟", "callback_data": "oversize:help" }]));
    rows.push(json!([{ "text": "❌ إلغاء", "callback_data": "oversize:cancel" }]));
    json!({ "inline_keyboard": rows })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OversizeAction {
    Shrink,
    Audio,
    Help,
    Cancel,
}

/// `oversize:<action>` — الأزرار تحمل **الفعل وحده**، ورسالةُ السؤال نفسها هي
/// المفتاح (تأتي في `callback_query.message.message_id`) فلا يمكن أن يُطبَّق
/// فعلٌ على سؤالٍ آخر.
fn parse_oversize_action(data: &str) -> Option<OversizeAction> {
    match data.strip_prefix("oversize:")? {
        "shrink" => Some(OversizeAction::Shrink),
        "audio" => Some(OversizeAction::Audio),
        "help" => Some(OversizeAction::Help),
        "cancel" => Some(OversizeAction::Cancel),
        _ => None,
    }
}

/// كل ما يحتاجه طرحُ سؤال التجاوز — يُبنى في `run_job` ويُمرَّر مجموعةً واحدة
/// (بدل أحد عشر معاملاً تخطئ في ترتيبها).
struct OversizeAsk<'a> {
    chat_id: i64,
    /// **صاحب الناتج** (م٤): ضغطةٌ من غيره تُرفض قبل أن تستهلك السؤال.
    user_id: i64,
    /// اسمه المعروض (م٥): يُكتب في سجلّ الإحصاءات عند تسليم المضغوط.
    user: &'a str,
    src_msg_id: i64,
    /// الناتج في **مجلد النتائج** — لا وسيطاً في مجلد مؤقّت يُمحى.
    produced: &'a Path,
    duration_secs: f64,
    has_video: bool,
    bytes: u64,
    height: Option<u32>,
    file: &'a str,
}

/// يطرح السؤال ويسجّله. **ويُطرح في كل مرّة**: لا حقل يحفظ جواباً سابقاً،
/// ولا فرع يقرأ تفضيلاً — فمُفسِد «تخزين الاختيار» لا يجد ما يخزّنه.
fn ask_oversize(
    cfg: &TgConfig,
    store: &Arc<Mutex<OversizeStore>>,
    ask: OversizeAsk<'_>,
) -> Result<(), String> {
    let plan = plan_oversize(ask.duration_secs, ask.has_video);
    let text = oversize_text(ask.bytes, ask.file, &plan);
    // رسالة مستقلة **ردٌّ على رسالة المستخدم**: رسالة الحالة تحمل تقدّم معالجةٍ
    // جرت فعلاً، ولو حُرِّرت إلى سؤالٍ لضاع أثرها.
    //
    // **ويُنتظَر معرّفها** (م٤): هو مفتاح مدخل السؤال في السِجلّ. والانتظار هنا
    // على **خيط مهمّة** لا على خيط الاستطلاع، فقراءة التحديثات (ومعها `/kill`)
    // لا تتأثّر.
    let qid = send_message_wait_id(
        cfg,
        ask.chat_id,
        &text,
        Some(oversize_keyboard(&plan)),
        Some(ask.src_msg_id),
    )?;
    store
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(Oversize {
            chat_id: ask.chat_id,
            user_id: ask.user_id,
            user: ask.user.to_string(),
            msg_id: qid,
            src_msg_id: ask.src_msg_id,
            path: ask.produced.to_path_buf(),
            bytes: ask.bytes,
            duration_secs: ask.duration_secs,
            has_video: ask.has_video,
            height: ask.height,
            file: ask.file.to_string(),
            asked: Instant::now(),
        });
    Ok(())
}

/// يُزيل الأسئلة المنتهية **ويُعلن ذلك** — لا إسقاط صامت، **والملف يبقى**.
fn purge_oversize(cfg: &TgConfig, store: &Arc<Mutex<OversizeStore>>) {
    let dead = store
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .purge_expired(Instant::now());
    for o in dead {
        let _ = edit_message_kb(
            cfg,
            o.chat_id,
            o.msg_id,
            &format!(
                "⌛ انتهت صلاحية سؤال الضغط ({} دقيقة).\n\
                 الناتج باقٍ في مجلد النتائج ولم يُحذف: أعد إرسال الملف إن أردت المحاولة.",
                OVERSIZE_TTL.as_secs() / 60
            ),
            None,
        );
        tracing::info!(target: "telegram", "انتهت صلاحية سؤال تجاوز للـ{}", o.chat_id);
    }
}

/// ينفّذ ما اختاره صاحب الناتج: يضغط ثم يُرسل في خيط **مستقل**.
///
/// **ولماذا خيط مستقل**: الضغط يستغرق دقائق، وهذا النداء يقع على **خيط تحديثات
/// البوت** — فلو ضغط هنا لتوقّف `/status` و`/kill` وكل المحادثة حتى ينتهي
/// (وهو الدرس نفسه المسجَّل في `CANCEL_CONFIRM_WAIT`).
fn run_oversize_action(
    cfg: &TgConfig,
    chat_id: i64,
    msg_id: i64,
    entry: Oversize,
    want_audio: bool,
) {
    let mut scratch = ScratchGuard::default();
    let dir = work_dir(&crate::paths::data_dir());
    let plan = plan_oversize(entry.duration_secs, entry.has_video);
    let kbps = if want_audio {
        plan.audio_kbps
    } else {
        plan.shrink_kbps
    };
    if kbps == 0 {
        let _ = edit_message_kb(
            cfg,
            chat_id,
            msg_id,
            "✗ تعذّر الضغط إلى داخل الحدّ — الناتج الأصلي باقٍ في مجلد النتائج.",
            Some(no_keyboard()),
        );
        return;
    }
    // الناتج الأصلي **لا يُلمس ولا يُحذف**؛ والمضغوط وسيطٌ مؤقّت يُنظَّف بعد الإرسال.
    let made = if want_audio || !entry.has_video {
        let dest = dir.join(format!("ov_{}_audio.mp3", nanos()));
        crate::media::compress_audio(&entry.path, &dest, kbps).map_err(|e| e.to_string())
    } else {
        let dest = dir.join(format!("ov_{}_small.mp4", nanos()));
        crate::media::transcode_to_bitrate(&entry.path, &dest, kbps, AUDIO_KBPS, entry.height)
            .map_err(|e| e.to_string())
    };
    let small = match made {
        Ok(p) => {
            scratch.track(&p);
            p
        }
        Err(e) => {
            let _ = edit_message_kb(
                cfg,
                chat_id,
                msg_id,
                &format!("✗ تعذّر الضغط: {e}\nالناتج الأصلي باقٍ في مجلد النتائج."),
                Some(no_keyboard()),
            );
            return;
        }
    };
    let bytes = std::fs::metadata(&small).map(|m| m.len()).unwrap_or(0);
    if bytes > CLOUD_SEND_MAX_BYTES {
        // الصدق قبل الطمأنة: الضغط لم يُدخل الملف، ولا يُرسَل ما سيُرفض.
        let _ = edit_message_kb(
            cfg,
            chat_id,
            msg_id,
            &format!(
                "✗ بقي المضغوط {} — فوق حدّ الإرسال ({}).\nالناتج الأصلي باقٍ في مجلد النتائج.",
                human_mb(bytes),
                human_mb(CLOUD_SEND_MAX_BYTES)
            ),
            Some(no_keyboard()),
        );
        return;
    }
    let _ = edit_message(cfg, chat_id, msg_id, "📤 جارٍ إرسال المضغوط…");
    let caption = format!(
        "🎧 HaramLite — أُزيلت الموسيقى ({} — مضغوط بطلبك)",
        human_mb(bytes)
    );
    match send_media(cfg, chat_id, &small, &caption, Some(entry.src_msg_id)) {
        Ok(()) => {
            // م٥: المضغوط ملفٌّ **وصل** أيضاً — يُدوَّن مثل كل تسليم ناجح، وإلا
            // نقص العدّ في أكثر الحالات إلحاحاً (ناتجٌ كبير سأل صاحبه).
            note_stats_delivery(entry.user_id, &entry.user, bytes);
            let _ = edit_message_kb(
                cfg,
                chat_id,
                msg_id,
                &format!("✅ تم — أُرسل بعد الضغط ({}).", human_mb(bytes)),
                None,
            );
        }
        Err(e) => {
            let _ = edit_message_kb(
                cfg,
                chat_id,
                msg_id,
                &format!("✗ فشل الإرسال: {e}\nالناتج الأصلي باقٍ في مجلد النتائج."),
                Some(no_keyboard()),
            );
        }
    }
}

/// يعالج ضغطة على سؤال تجاوز. **وكل ضغطة تُجاب** (`answerCallbackQuery`) وإلا
/// بقي مؤشّر العميل يدور.
///
/// **ومصادقة صاحب الناتج (م٤)**: الضغطة تُقبل من صاحب السؤال أو المالك وحدهما.
/// والفحص **قبل أي حالة**: غريبٌ ضغط زرَّ غيره لا يُنقص السؤال ولا يرفع ناتج
/// غيره — يُردّ بصدق ويبقى كل شيء كما كان.
fn handle_oversize_action(
    cfg: &TgConfig,
    store: &Arc<Mutex<OversizeStore>>,
    action: OversizeAction,
    chat_id: i64,
    msg_id: i64,
    from_id: i64,
    cb_id: &str,
) {
    // المعلومة يجوز للجميع (لا تفعل شيئاً)؛ أما ما **ينفّذ** فلمالكه وحده.
    let acting = !matches!(action, OversizeAction::Help);
    let entry = store
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(chat_id, msg_id)
        .cloned();
    let Some(entry) = entry else {
        // ضغطة ثانية على الزرّ نفسه، أو سؤال انتهى وقته: **لا رفع مرّتين**،
        // وتُجاب الضغطة بصدق.
        answer_callback(cfg, cb_id, "لم يعد هذا السؤال فعّالاً");
        return;
    };
    if acting && from_id != entry.user_id && Some(from_id) != cfg.owner_id {
        answer_callback(cfg, cb_id, "هذا الزرّ ليس لك");
        return;
    }
    match action {
        OversizeAction::Help => {
            // معلوماتي فقط: السؤال **يبقى** ولوحته تبقى (ت٥).
            answer_callback(cfg, cb_id, "معلومة");
            let plan = plan_oversize(entry.duration_secs, entry.has_video);
            let text = format!(
                "{}\n\n{}",
                oversize_text(entry.bytes, &entry.file, &plan),
                oversize_guide_text()
            );
            let _ = edit_message_kb(cfg, chat_id, msg_id, &text, Some(oversize_keyboard(&plan)));
        }
        OversizeAction::Cancel => {
            let taken = store
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take(chat_id, msg_id);
            answer_callback(cfg, cb_id, "أُلغي الإرسال");
            if taken.is_some() {
                // لا رفع ولا حذف: الناتج يبقى في مجلد النتائج (ت٤).
                let _ = edit_message_kb(
                    cfg,
                    chat_id,
                    msg_id,
                    "❌ أُلغي الإرسال — الناتج باقٍ في مجلد النتائج ولم يُحذف.",
                    None,
                );
            }
        }
        OversizeAction::Shrink | OversizeAction::Audio => {
            // **يُسحب المدخل قبل بدء العمل**: ضغطة ثانية لا تجد شيئاً فلا يُرفع
            // الملف مرّتين ولا يتنازع ضغطان على المخرج نفسه.
            let taken = store
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take(chat_id, msg_id);
            let Some(entry) = taken else {
                answer_callback(cfg, cb_id, "جارٍ التنفيذ بالفعل");
                return;
            };
            let want_audio = action == OversizeAction::Audio;
            answer_callback(
                cfg,
                cb_id,
                if want_audio {
                    "أستخرج الصوت وأضغطه…"
                } else {
                    "أضغط ثم أرسل…"
                },
            );
            let _ = edit_message_kb(
                cfg,
                chat_id,
                msg_id,
                "🗜️ جارٍ الضغط… (لن تُحجب بقية المحادثة)",
                Some(no_keyboard()),
            );
            let thread_cfg = cfg.clone();
            if let Err(e) = std::thread::Builder::new()
                .name("telegram-oversize".into())
                .spawn(move || run_oversize_action(&thread_cfg, chat_id, msg_id, entry, want_audio))
            {
                // فشل إنشاء الخيط لا يُسقط الطلب بصمت: يُقال في المحادثة.
                let _ = edit_message_kb(
                    cfg,
                    chat_id,
                    msg_id,
                    &format!("✗ تعذّر بدء الضغط: {e}\nالناتج باقٍ في مجلد النتائج."),
                    Some(no_keyboard()),
                );
            }
        }
    }
}

fn handle_update(
    cfg: &TgConfig,
    poll: &mut PollState,
    oversize: &Arc<Mutex<OversizeStore>>,
    u: &Value,
    tx: &Sender<Job>,
) {
    if let Some(cb) = u.get("callback_query") {
        let from_id = cb
            .get("from")
            .and_then(|f| f.get("id"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
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
        // **ولا مفوَّض عام هنا** (م٤): كل فرعٍ يصادق ضغطته بنفسه، لأن لكل فرعٍ
        // صاحباً مختلفاً — مهمّةٌ لصاحبها، وسؤالُ تجاوزٍ لصاحبه، ومعلَّقٌ لصاحبه،
        // وبطاقةُ موافقةٍ للمالك. وفحصٌ واحد عام كان يمنع المالك من مساعدة أحد
        // أو يسمح لغريبٍ بالضغط على زرّ غيره.
        //
        // ── بطاقة الموافقة (م٤): قرارُ المالك وحده، وهي في خاصّه ──
        if let Some((verdict, token)) = parse_approval_button(data) {
            handle_approval_press(cfg, poll, from_id, &token, verdict, cb_id);
            return;
        }
        // ── زر الإلغاء (م٢/م٤): `cancel:<chat_id>:<user_id>` — **صاحبُ المهمّة
        //    أو المالك**، ولا ثالث. ولا يُلغي أحدٌ مهمّة غيره (ت٢).
        if let Some((target_chat, target_user)) = parse_cancel_button(data) {
            // **ولا إلغاء بمحادثةٍ أخرى**: الزرّ يحمل محادثته، وطلبُ إلغاءٍ في
            // محادثةٍ غير محادثة المهمّة يُرفض بصراحة (لا يُترجَم إلى الافتراض).
            if target_chat != chat_id {
                answer_callback(cfg, cb_id, "هذا الزرّ ليس لهذه المحادثة");
                return;
            }
            if from_id != target_user && Some(from_id) != cfg.owner_id {
                answer_callback(cfg, cb_id, "هذا الزرّ ليس لك");
                return;
            }
            let reply = cancel_chat_jobs(target_chat, target_user);
            answer_callback(cfg, cb_id, &reply);
            if msg_id != 0 {
                // الزرّ يُزال **صراحةً** بلوحة فارغة: الرسالة كانت تحمله، وتعديلٌ
                // بلا لوحة يحذفه في تلغرام — فالطلب صريح لا ضمني.
                //
                // **والرتبة بحسب النصّ** (م٣/إصلاح): «🛑 أُلغيت» نهائية تُجمّد
                // الرسالة، فلا يطمسها تعديلٌ متأخّر من خيط المهمّة (كان يصل
                // بعدها «✗ فشلت المعالجة: أُلغيت المعالجة»).
                let rank = cancel_reply_rank(&reply);
                let _ = status_push(cfg, chat_id, msg_id, rank, &reply, no_keyboard());
            }
            set_activity(reply);
            return;
        }
        // ── أزرار سؤال التجاوز (م٣) — قبل أزرار الوضع، فشكل البيانات مختلف.
        //    والمصادقة داخلها: صاحب الناتج أو المالك (م٤). ──
        if let Some(action) = parse_oversize_action(data) {
            handle_oversize_action(cfg, oversize, action, chat_id, msg_id, from_id, cb_id);
            return;
        }
        // ── زرّ الإحصاءات (م٥): **رسالة واحدة لكل ضغطة**، وإحصاءاتُ الضاغط
        //    وحده من ملفه. ولا مصادقة زائدة: ما يُعرَض هو سجلّ الضاغط نفسه،
        //    ولا يُكشف سجلّ غيره — والزرّ لا يُرسَل إلا في سياقٍ مسموح
        //    (خاصّ المالك، أو مجموعةٌ مرّت بوابة قائمة السماح).
        if data == STATS_CALLBACK {
            answer_callback(cfg, cb_id, "📊");
            if send_stats(cfg, chat_id, from_id, msg_id) {
                set_activity(format!("إحصاءات {from_id}@{chat_id}"));
            }
            return;
        }
        let Some((token, mode)) = parse_mode_action(data) else {
            answer_callback(cfg, cb_id, "");
            return;
        };
        // **البحث بالرمز لا بالمحادثة** (م٣/١): اختيار وضع ملفٍ لا يُلغي غيره.
        //
        // **وقبل السحب: هل الرسالة المضغوطة هي سؤال هذا المعلَّق؟** (م٣/إصلاح)
        // ضغطة على نسخةٍ قديمة من السؤال (يبقى زرّها على الشاشة — `/mode` يُنشئ
        // سؤالاً جديداً ولا يمحو القديم) كانت تُقبل، فيصير معرّف الرسالة القديمة
        // **مرجعَ الحالة**: تُحرَّر رسالةٌ منسيّة ويبقى السؤال الحيّ بأزراره.
        // والحكم **قبل `take`**: يُردّ بصدق ويبقى المعلَّق كما هو.
        let Some(current) = poll.pending.get(chat_id, &token) else {
            answer_callback(cfg, cb_id, "انتهت صلاحية هذا الطلب — أعد الإرسال");
            return;
        };
        // **ومصادقة صاحب الملف** (م٤): ضغطةٌ من غيره تُرفض **قبل** السحب —
        // فلا يُستهلك معلَّق غيره، ولا يُشغَّل ملفٌّ ليس له.
        if current.user_id != from_id && Some(from_id) != cfg.owner_id {
            answer_callback(cfg, cb_id, "هذا الزرّ ليس لك");
            return;
        }
        if current.ask_msg_id.load(Ordering::SeqCst) != 0
            && msg_id != current.ask_msg_id.load(Ordering::SeqCst)
        {
            answer_callback(cfg, cb_id, "هذا سؤال قديم — استعمل أزرار آخر رسالة سؤال");
            return;
        }
        let owner_of_file = current.user_id;
        let Some(p) = poll.pending.take(chat_id, &token) else {
            answer_callback(cfg, cb_id, "انتهت صلاحية هذا الطلب — أعد الإرسال");
            return;
        };
        let label = mode_label(mode);
        answer_callback(cfg, cb_id, &format!("اخترت: {label}"));
        let Pending {
            source,
            src_msg_id,
            file,
            row_id,
            user,
            ..
        } = p;
        // الدور يُقرأ من العدّادات **قبل** إضافة هذه المهمّة، ثم يُقال `ahead+1`.
        let position = jobs_ahead().saturating_add(1);
        QUEUE_DEPTH.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut st) = status().lock() {
            st.queue = QUEUE_DEPTH.load(Ordering::SeqCst);
        }
        let queued_ok = tx
            .send(Job {
                chat_id,
                // **صاحب الملف لا الضاغط**: المالك قد يضغط نيابةً عن عضو،
                // والمهمّة تبقى للعضو (وسمها وطابورها وزرّها).
                user_id: owner_of_file,
                user,
                source,
                mode,
                src_msg_id,
                status_msg_id: msg_id,
                file,
                row_id,
            })
            .is_ok();
        if !queued_ok {
            dec(&QUEUE_DEPTH);
            if let Ok(mut st) = status().lock() {
                st.queue = QUEUE_DEPTH.load(Ordering::SeqCst);
            }
            jobs_finished(row_id, false);
            let _ = send_message(cfg, chat_id, "⚠ تعذر جدولة المهمة", None, Some(src_msg_id));
            return;
        }
        // **ولا يُقال «بدأت» هنا**: المهمّة في القائمة، و`run_job` وحدها تقول
        // «بدأت المعالجة» لحظة دخولها التنفيذ.
        //
        // **والرتبة `Queued`** (م٣/إصلاح): هذا التعديل يقع **بعد** `tx.send`،
        // فقد يصل بعد أن يكون خيط المهمّة كتب «▶ بدأت المعالجة» — والبوابة
        // تُسقطه حينها، فلا تبقى «دورك: 1» على مهمّة بدأت.
        let text = waiting_text(label, position);
        if msg_id != 0 {
            // زرّ الإلغاء **يحلّ محلّ أزرار الوضع** على الرسالة نفسها: زرٌّ واحد
            // صادق بدل زرَّين لا يفعلان شيئاً بعد الاختيار.
            let _ = status_push(
                cfg,
                chat_id,
                msg_id,
                StatusRank::Queued,
                &text,
                cancel_button(chat_id, owner_of_file),
            );
        } else {
            let _ = send_message(
                cfg,
                chat_id,
                &text,
                Some(cancel_button(chat_id, owner_of_file)),
                Some(src_msg_id),
            );
        }
        return;
    }

    // ── م٤: إضافة البوت إلى مجموعة ⇒ تثبيت رسالة التعريف (ت٩) ──────────────
    // يُقرأ **قبل** أي معالجة، والتحديث لا يُقرأ رسالةً عادية (وإلا رُدَّ عليه
    // بـ«لم أجد رابطاً»).
    if let Some(m) = u.get("my_chat_member") {
        handle_my_chat_member(cfg, poll, m);
        return;
    }
    let Some(msg) = u.get("message") else { return };
    if handle_bot_added(cfg, poll, msg) {
        return;
    }
    let Some((from_id, chat_id, incoming)) = parse_message(msg) else {
        return;
    };
    let kind = chat_kind_of(chat_id, msg);
    let owner = cfg.owner_id;
    // «المالك» تعريفٌ واحد في الملف كله: مطابقة معرّف الإعداد (`allows`).
    let is_owner = cfg.allows(from_id);

    // ── security gate: an open bot on a desktop drains the machine ─────────
    // Paired ⇒ only the owner exists as far as this bot is concerned; anyone
    // else gets nothing at all, not even an acknowledgement.
    if owner.is_none() {
        // وضع الاقتران **خاصٌّ بالمحادثة الخاصة**: مجموعةٌ بلا مالك معرَّف لا
        // تُخاطَب أصلاً (ولا رمز اقتران يُقال فيها لمَن لا يملك الجهاز).
        if kind == ChatKind::Group {
            return;
        }
        let src_msg_id = msg.get("message_id").and_then(Value::as_i64).unwrap_or(0);
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
                let _ = send_message(cfg, chat_id, &reply, None, Some(src_msg_id));
                set_activity(format!("اقتران ناجح: {from_id}"));
                return;
            }
            PairTry::Wrong { fails_left } => {
                let body = if fails_left == 0 {
                    "❌ كود غير صحيح — أُبطل الرمز. اطلب رمزاً جديداً من إعدادات البرنامج.".to_string()
                } else {
                    format!("❌ كود غير صحيح. المحاولات المتبقية: {fails_left}")
                };
                let _ = send_message(cfg, chat_id, &body, None, Some(src_msg_id));
                set_activity(format!("محاولة اقتران فاشلة من {from_id}"));
                return;
            }
            PairTry::NotAnAttempt => {}
        }
        if poll.hinted.insert(chat_id) {
            let _ = send_message(cfg, chat_id, &pairing_hint(from_id), None, None);
        }
        set_activity(format!("غير مقترن: رسالة من {from_id}"));
        return;
    }

    // ── م٤: بوابة المجموعة — الوضع ثم قائمة السماح، **قبل أي معالجة** ───────
    if kind == ChatKind::Group {
        // ① الوضع: في «بالمنشن» لا تُقرأ إلا رسالةٌ تخاطب البوت — منشناً، أو
        //    **أمراً موجَّهاً إليه**. والرسالة التي لا تخاطبه ليست طلباً،
        //    فالصمت هنا صوابٌ لا عطل.
        let addressed = cfg.group_mode == GroupMode::All
            || mentions_bot(msg, &poll.identity)
            || msg
                .get("text")
                .and_then(Value::as_str)
                .map(|t| command_for_bot(t, &poll.identity))
                .unwrap_or(false);
        if !addressed {
            return;
        }
        // ② قائمة السماح: `chat_id` + `user_id` **إلزاميان** (ت١). وغير المسموح
        //    لا يُشغّل مهمّة أبداً.
        if !poll.access.allows(chat_id, from_id, owner) {
            // الوضع الموسَّع: الرابط يُعرَض على المالك في خاصّه، **ولا معالجة
            // قبل ضغطته** — فالموافقة تحلّ محلّ المنشن.
            if cfg.group_mode == GroupMode::All {
                if let Incoming::Job(source) = &incoming {
                    let user = display_user(msg.get("from").unwrap_or(&Value::Null));
                    let file = match source {
                        Source::Link(u) => display_name(u),
                        Source::File { name, .. } => display_name(name),
                    };
                    let src_msg_id = msg.get("message_id").and_then(Value::as_i64).unwrap_or(0);
                    let a = Approval {
                        chat_id,
                        user_id: from_id,
                        user,
                        source: source.clone(),
                        src_msg_id,
                        file,
                        card_msg_id: 0,
                    };
                    if !send_approval(cfg, poll, a) {
                        // تعذّر إبلاغ المالك ⇒ يُقال في المجموعة بدل صمتٍ يبدو
                        // عطلاً (ومَن ليس في القائمة يُردّ عليه دائماً).
                        let _ = notify_member(
                            cfg,
                            chat_id,
                            from_id,
                            "🔒 طلبك يحتاج إذن المالك، وتعذّر إبلاغه الآن.",
                        );
                        return;
                    }
                }
            }
            // ③ **رسالة واحدة موجزة** لا صمت (تصميم §٢-٣).
            if notify_not_allowed(cfg, poll, chat_id, from_id) {
                set_activity(format!("طلب من غير مسموح: {from_id}@{chat_id}"));
            }
            return;
        }
    } else if !is_owner {
        // محادثة خاصة مع غير المالك: **صمت تام** (سلوك م٢/م٣ القائم — لا إقرار
        // ولا دعوة، فالبوت ليس خدمة عامة).
        set_activity(format!("رُفض متطفل: {from_id}"));
        tracing::warn!(target: "telegram", "رسالة من غير المالك ({from_id}) — تجاهُل تام");
        return;
    }

    // أسئلة تجاوزٍ انتهى وقتها: تُزال **ويُقال ذلك** قبل معالجة أي تحديث جديد.
    purge_oversize(cfg, oversize);

    match incoming {
        Incoming::Job(source) => {
            let src_msg_id = msg.get("message_id").and_then(Value::as_i64).unwrap_or(0);
            let user = display_user(msg.get("from").unwrap_or(&Value::Null));
            let file = match &source {
                Source::Link(u) => display_name(u),
                Source::File { name, .. } => display_name(name),
            };
            // ① الحدّ الأعلى **صراحةً وقبل الإرسال**: لا سؤال يُرسَل ثم يُلغى،
            //    ولا إسقاط صامت — رسالة واحدة تقول ما يلزم عمله.
            if !poll.pending.can_accept(chat_id) {
                let _ = send_message(cfg, chat_id, &pending_full_text(), None, Some(src_msg_id));
                return;
            }
            offer_mode_question(cfg, poll, chat_id, from_id, source, src_msg_id, &user, file);
        }
        Incoming::Smalltalk(t) => {
            // رسالة المستخدم الأصلية: كل ردٍّ في هذا الفرع ردٌّ عليها (م٣).
            let src_msg_id = msg.get("message_id").and_then(Value::as_i64).unwrap_or(0);
            let cmd = parse_command(&t);
            let name = cmd.as_ref().map(|(n, _)| n.as_str()).unwrap_or("");
            let arg = cmd.as_ref().and_then(|(_, a)| a.as_deref());
            match name {
                // ── م٤/٤: `/kill` و`/status` **للمالك وحده في المجموعة** (ت٧).
                //    والرفض **صريح** لا صمت: العضو يعرف أنه ليس له، ولا يُنفَّذ
                //    شيء — فلا يُلغي عضوٌ مهامّ غيره ولا يرى حال غيره. ──
                "kill" | "status" if kind == ChatKind::Group && !is_owner => {
                    let _ = send_message(
                        cfg,
                        chat_id,
                        "🔒 هذا الأمر للمالك وحده في المجموعة.",
                        None,
                        Some(src_msg_id),
                    );
                    set_activity(format!("رُفض أمر مالك من {from_id}@{chat_id}"));
                }
                // ── `/kill` من **المالك** (وليس من غيره — الفحص أعلاه): يوقف
                //    مهامّ هذه المحادثة كلها بـ`cancel_job` لكل معرّف،
                //    **لا `cancel_all`** (شرط ت٥). **ولا `/stop`** في أي مكان. ──
                "kill" => {
                    let reply = cancel_chat_all_jobs(chat_id);
                    let _ = send_message(cfg, chat_id, &reply, None, Some(src_msg_id));
                    set_activity(reply);
                }
                // ── `/status` (م٣): ماذا يعمل الآن **ولِمَن**. ──
                "status" => {
                    let running = slots::active_jobs();
                    let text = status_text(
                        chat_id,
                        &running,
                        QUEUE_DEPTH.load(Ordering::SeqCst),
                        poll.pending.count_for(chat_id),
                        oversize
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .count_for(chat_id),
                        &status()
                            .lock()
                            .map(|s| s.last_error.clone())
                            .unwrap_or_default(),
                        epoch_ms(),
                    );
                    let _ = send_message(cfg, chat_id, &text, None, Some(src_msg_id));
                }
                // ── `/mode`: يُعيد أزرار الوضع **لملفات صاحب الأمر** وحدها ──
                "mode" => {
                    let items: Vec<(String, String, i64)> = poll
                        .pending
                        .for_user(chat_id, from_id)
                        .iter()
                        .map(|p| (p.token.clone(), p.file.clone(), p.src_msg_id))
                        .collect();
                    if items.is_empty() {
                        let _ = send_message(
                            cfg,
                            chat_id,
                            "لا ملفات تنتظر اختيار الوضع الآن.\nأرسل ملفاً أو رابطاً وسأسألك.",
                            None,
                            Some(src_msg_id),
                        );
                    } else {
                        let position = jobs_ahead().saturating_add(1);
                        for (token, file, src) in items {
                            let keyboard = json!({
                                "inline_keyboard": [[
                                    { "text": "🎵 أغنية", "callback_data": format!("mode:song:{token}") },
                                    { "text": "🎬 مقطع عادي", "callback_data": format!("mode:clip:{token}") }
                                ]]
                            });
                            let text =
                                format!("📎 {file}\n\n{}", waiting_text("لم يُختر بعد", position));
                            // **والربط ينتقل إلى الرسالة الجديدة** (م٣/إصلاح): هي
                            // التي تحمل الأزرار الحيّة، والقديمة يُردّ ضغطُها بصدق
                            // («هذا سؤال قديم») بدل أن تُحرَّر وتصير مرجع الحالة.
                            //
                            // **وخانةٌ جديدة لكل إعادة عرض** (م٤): في المجموعة
                            // يكتب الكاتب المعرّف فيها بعد الإرسال.
                            let slot: IdSlot = Arc::new(AtomicI64::new(0));
                            match send_message(cfg, chat_id, &text, Some(keyboard), Some(src)) {
                                Ok(id) => {
                                    if id != 0 {
                                        slot.store(id, Ordering::SeqCst);
                                    }
                                    poll.pending.set_ask_msg(chat_id, &token, slot);
                                }
                                Err(e) => set_error(e),
                            }
                        }
                    }
                }
                // ── `/lang`: يقول اللغات المتاحة بصدق ولا يدّعي تبديلاً ──
                "lang" => {
                    let _ = send_message(cfg, chat_id, &lang_text(arg), None, Some(src_msg_id));
                }
                // ── `/stats` (م٥): إحصاءات **صاحب الأمر** من ملفه وحده ──
                //    (وملفٌّ لكل مستخدم مفتاحه الـID، فتغيّر الاسم لا يُنشئ
                //    سجلاً ثانياً). ويُرسَل معها زرّها ليعاد بضغطة.
                "stats" => {
                    if send_stats(cfg, chat_id, from_id, src_msg_id) {
                        set_activity(format!("إحصاءات {from_id}@{chat_id}"));
                    }
                }
                // ── `/help` (و`/start` الذي يرسله كل عميل): القائمة نفسها التي
                //    سُجّلت في `setMyCommands` — لا قائمتان تفترقان. **ولكلٍّ
                //    قائمته**: المالك يرى `/kill` و`/status`، وغيره لا يراهما
                //    (فلا يُعرَض عليه أمرٌ سيُرفض). ──
                "help" | "start" => {
                    let _ = send_message(
                        cfg,
                        chat_id,
                        &help_text_for(is_owner),
                        // م٥: زرّ الإحصاءات يُرسَل مع القائمة — فما يظهر يعمل،
                        // وضغطته رسالةٌ واحدة.
                        Some(stats_keyboard()),
                        Some(src_msg_id),
                    );
                }
                // أمر معروف الشكل لا نعرفه: يُقال بصراحة بدل صمت أو تنكّر.
                other if !other.is_empty() => {
                    let _ = send_message(
                        cfg,
                        chat_id,
                        &format!("لا أعرف الأمر /{other}.\n\n{}", help_text_for(is_owner)),
                        None,
                        Some(src_msg_id),
                    );
                }
                _ => {
                    if t.trim().is_empty() || t.trim_start().starts_with('/') {
                        let _ = send_message(
                            cfg,
                            chat_id,
                            &help_text_for(is_owner),
                            None,
                            Some(src_msg_id),
                        );
                    } else {
                        let _ = send_message(
                            cfg,
                            chat_id,
                            &format!("لم أجد رابطاً في رسالتك.\n{}", help_text_for(is_owner)),
                            None,
                            Some(src_msg_id),
                        );
                    }
                }
            }
        }
    }
}

/// يسأل عن الوضع ويسجّل المعلَّق — **مسار واحد** يستعمله الوصول المباشر
/// (رسالة من مسموح) وموافقة المالك (الوضع الموسَّع)، فلا يفترق مساران لنفس
/// السؤال.
#[allow(clippy::too_many_arguments)]
fn offer_mode_question(
    cfg: &TgConfig,
    poll: &mut PollState,
    chat_id: i64,
    user_id: i64,
    source: Source,
    src_msg_id: i64,
    user: &str,
    file: String,
) {
    let token = format!("{:x}", nanos());
    let hint = match &source {
        Source::Link(u) => format!("🔗 {u}"),
        Source::File { .. } => format!("📎 {file}"),
    };
    // إشعار الانتظار يُحسب **من الطابور الفعلي** ويُرسَل مع السؤال **عند
    // الوصول** (لا عند الضغط على الزرّ).
    let ahead = jobs_ahead();
    let keyboard = json!({
        "inline_keyboard": [[
            { "text": "🎵 أغنية", "callback_data": format!("mode:song:{token}") },
            { "text": "🎬 مقطع عادي", "callback_data": format!("mode:clip:{token}") }
        ]]
    });
    let text = mode_question_text(&hint, ahead);
    // **المعلَّق يُسجَّل قبل الإرسال** (م٤): في المجموعة لا معرّف عند الإدراج —
    // الكاتب يكتبه في الخانة المشتركة، والضغطة لا تقع قبل وجود الرسالة.
    let slot: IdSlot = Arc::new(AtomicI64::new(0));
    let row_id = jobs_arrived(chat_id, user, &file);
    let inserted = poll.pending.insert(Pending {
        chat_id,
        user_id,
        user: user.to_string(),
        token: token.clone(),
        source,
        src_msg_id,
        ask_msg_id: slot.clone(),
        file,
        row_id,
    });
    if !inserted {
        jobs_finished(row_id, false);
        let _ = send_message(cfg, chat_id, &pending_full_text(), None, Some(src_msg_id));
        return;
    }
    match send_message(cfg, chat_id, &text, Some(keyboard), Some(src_msg_id)) {
        Ok(id) => {
            // الخاص: المعرّف وصل الآن ⇒ يُكتب في الخانة فوراً.
            if id != 0 {
                slot.store(id, Ordering::SeqCst);
            }
        }
        Err(e) => {
            // فشلُ الإرسال لا يترك معلَّقاً بلا رسالة: يُسحب الصفّ والمعلَّق.
            poll.pending.take(chat_id, &token);
            jobs_finished(row_id, false);
            set_error(e);
        }
    }
}

// ── م٤: إضافة البوت إلى مجموعة، ورسالة التعريف المثبَّتة (ت٩) ──────────────

/// تحديث `my_chat_member`: **يُرسَل للبوت وحده**، فعضوية البوت صارت `member`
/// أو `administrator` بعد أن كانت خارجه ⇒ أُضيف الآن.
fn handle_my_chat_member(cfg: &TgConfig, poll: &mut PollState, m: &Value) {
    let chat_id = m.pointer("/chat/id").and_then(Value::as_i64).unwrap_or(0);
    let now = m
        .pointer("/new_chat_member/status")
        .and_then(Value::as_str)
        .unwrap_or("");
    let before = m
        .pointer("/old_chat_member/status")
        .and_then(Value::as_str)
        .unwrap_or("");
    let joined =
        matches!(now, "member" | "administrator") && matches!(before, "left" | "kicked" | "");
    if joined {
        pin_intro(cfg, poll, chat_id);
    }
}

/// `message.new_chat_members` تحمل البوت ⇒ أُضيف. **تعيد `true`** حينها فقط،
/// فلا يُقرأ تحديث الإضافة رسالةً عادية ويُردّ عليه بـ«لم أجد رابطاً».
fn handle_bot_added(cfg: &TgConfig, poll: &mut PollState, msg: &Value) -> bool {
    let members = msg
        .get("new_chat_members")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if members.is_empty() {
        return false;
    }
    // بلا هويةٍ لا يُدَّعى أن المضاف هو البوت: تُقرأ الرسالة رسالةً عادية.
    if poll.identity.id == 0 {
        return false;
    }
    let added = members
        .iter()
        .any(|m| m.get("id").and_then(Value::as_i64) == Some(poll.identity.id));
    if !added {
        return false;
    }
    let chat_id = msg.pointer("/chat/id").and_then(Value::as_i64).unwrap_or(0);
    pin_intro(cfg, poll, chat_id);
    true
}

/// **تُثبَّت مرة واحدة عند الإضافة** (ت٩) — لا مع كل رسالة.
///
/// العلامة (`pinned`) تُفحص وتُضبط **في موضع واحد** قبل الإرسال، فالتحديثات
/// المتكرّرة لا تُنتج تثبيتاً ثانياً. والإرسال **يُدرَج في الطابور** ويثبّته
/// الكاتب بعد نجاحه (فلا ينتظر خيط الاستطلاع حصّةً ولا ردّاً).
///
/// **ونصيحة المعالج** تُضاف إن كان المسار الفعّال CPU (م٤/٨) — والحكم على
/// التجربة لا على تحليلٍ نظري (لا عَلَم يعطّل CUDA وDirectML معاً).
fn pin_intro(cfg: &TgConfig, poll: &mut PollState, chat_id: i64) -> bool {
    if !is_group_chat(chat_id) || chat_id == 0 {
        return false;
    }
    if !poll.pinned.insert(chat_id) {
        tracing::debug!(target: "telegram", "رسالة التعريف مثبَّتة أصلاً في {chat_id}");
        return false;
    }
    let provider = crate::separator::read_provider();
    let advice = cpu_advice_line(provider.as_deref());
    if provider.is_none() {
        tracing::info!(target: "telegram", "لا نصيحة معالج: لم يُقَس مزوّد أي فصل بعد");
    }
    let text = intro_text(&poll.identity, advice);
    send_group_async(
        cfg,
        SendItem::Message {
            chat_id,
            text,
            keyboard: None,
            reply_to: None,
            pin: true,
            id_slot: None,
        },
    )
}

/// **رسالة واحدة موجزة** لغير المسموح (تصميم §٢-٣): الصمت يجعل البوت يبدو
/// معطّلاً، والتكرار سيلٌ. فتُقال **مرة واحدة** لكل (محادثة، عضو) في عمر
/// العامل، وبعدها لا يُعاد — و`false` تعني «قيلت سابقاً».
fn notify_not_allowed(cfg: &TgConfig, poll: &mut PollState, chat_id: i64, user_id: i64) -> bool {
    if !poll.notified.insert((chat_id, user_id)) {
        return false;
    }
    notify_member(
        cfg,
        chat_id,
        user_id,
        "🔒 لست في قائمة السماح لهذا البوت — اطلب من المالك السماح.",
    )
}

// ── م٤: قرار المالك على بطاقة الموافقة ──────────────────────────────────────

/// ضغطةٌ على بطاقة الموافقة (وهي في **خاصّ المالك**): القرار له وحده، وفروع
/// القرار ثلاثة: `yes` ينفّذ الطلب مرةً، و`always` يُضيف الزوج إلى قائمة
/// السماح **ويحفظه** (فالسماح الدائم يجب أن ينجو من إعادة التشغيل)، و`no`
/// يُنهي الطلب بصدق.
fn handle_approval_press(
    cfg: &TgConfig,
    poll: &mut PollState,
    from_id: i64,
    token: &str,
    verdict: &str,
    cb_id: &str,
) {
    if Some(from_id) != cfg.owner_id {
        answer_callback(cfg, cb_id, "هذا القرار للمالك وحده");
        return;
    }
    let Some(a) = poll.approvals.get(token).cloned() else {
        answer_callback(cfg, cb_id, "لم يعد هذا الطلب فعّالاً");
        return;
    };
    poll.approvals.take(token);
    let card = |text: String| {
        if a.card_msg_id != 0 {
            let _ = edit_message_kb(cfg, from_id, a.card_msg_id, &text, Some(no_keyboard()));
        }
    };
    match verdict {
        "no" => {
            answer_callback(cfg, cb_id, "رُفض الطلب");
            card(format!("❌ رُفض طلب {} ({}).", a.user, a.user_id));
            let _ = notify_member(cfg, a.chat_id, a.user_id, "🔒 لم يُسمح بطلبك.");
            set_activity(format!("رُفض طلب {}@{}", a.user_id, a.chat_id));
        }
        "yes" | "always" => {
            let permanent = verdict == "always";
            if permanent {
                let added = poll.access.allow(a.chat_id, a.user_id);
                let saved = poll.access.save();
                if let Err(e) = &saved {
                    // القائمة في الذاكرة صارت أوسع، والحفظ فشل: يُقال صراحةً
                    // بدل وعدٍ لا ينجو من إعادة التشغيل.
                    tracing::warn!(target: "telegram", "تعذّر حفظ قائمة السماح: {e}");
                }
                card(format!(
                    "♾️ سُمح دائماً لـ{} ({}){}.",
                    a.user,
                    a.user_id,
                    if added {
                        if saved.is_ok() {
                            " — أُضيف إلى قائمة السماح"
                        } else {
                            " — أُضيف في الذاكرة وتعذّر حفظه"
                        }
                    } else {
                        " — كان مسموحاً أصلاً"
                    }
                ));
            } else {
                card(format!("✅ سُمح لطلب {} ({}).", a.user, a.user_id));
            }
            answer_callback(cfg, cb_id, "تم");
            set_activity(format!("سُمح لطلب {}@{}", a.user_id, a.chat_id));
            // **ويُنفَّذ الطلب الآن**: نفس سؤال الوضع الذي يُطرح للمسموح به
            // مباشرةً — فلا مسار ثانٍ للسؤال نفسه. (والمهمّة تُدخَل الطابور عند
            // ضغط زرّ الوضع، فلا تُنشأ مهمّة بلا وضعٍ مختار.)
            let file = a.file.clone();
            let user_id = a.user_id;
            let src_msg_id = a.src_msg_id;
            let source = a.source.clone();
            let user = a.user.clone();
            let chat_id = a.chat_id;
            offer_mode_question(cfg, poll, chat_id, user_id, source, src_msg_id, &user, file);
        }
        _ => {
            answer_callback(cfg, cb_id, "قرار غير معروف");
        }
    }
}

// ── م٤: طابور FIFO لكل مستخدم فوق السقف العام ──────────────────────────────

/// **طابور المهامّ** (تصميم م٤ §٣): ترتيبٌ عادل بين المستخدمين تحت سقفٍ عام.
///
/// * **FIFO لكل `user_id`**: ملفّا المستخدم نفسه لا يتقدّم أحدهما على الآخر.
/// * **دورٌ بين المستخدمين (round-robin)**: مستخدمٌ بأربعة ملفات **لا يحتكر**
///   السقف — يأخذ ملفاً ثم يفسح الدور لغيره. هذا نصّ ت٤ لا تفسيرٌ له.
/// * **والسقف العام** ([`QueueState::limit`]) يحمي البطاقة: افتراضيّ ١ وأقصى ٢،
///   وهو الرقم المقيس لسقف ذاكرة الكرت في `slots`.
/// * **ولا يُحتجز موردٌ في الطابور**: مهمّةٌ تنتظر دورها لا تحمل فتحة جهاز ولا
///   فتحة مشغّل؛ الفتحتان تُؤخذان عند التنفيذ وتُحرَّران قبل أي انتظار بشري.
struct JobQueue {
    state: Mutex<QueueState>,
    ready: Condvar,
}

#[derive(Default)]
struct QueueState {
    /// طابور كل مستخدم بترتيب الوصول.
    per_user: HashMap<i64, VecDeque<Job>>,
    /// المستخدمون بأدوارهم — كلٌّ **مرة واحدة** ما دام له ما ينتظر.
    order: VecDeque<i64>,
    /// مهامّ قيد التنفيذ الآن.
    running: usize,
    /// السقف العام (من `slots::current_limit`).
    limit: u32,
    stop: bool,
}

impl JobQueue {
    fn new(limit: u32) -> Self {
        Self {
            state: Mutex::new(QueueState {
                limit: limit.clamp(1, slots::MAX_LIMIT),
                ..Default::default()
            }),
            ready: Condvar::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, QueueState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// يُدرج مهمّةً في طابور صاحبها **ويُعلم** عاملاً منتظراً.
    fn push(&self, job: Job) {
        let user = job.user_id;
        {
            let mut s = self.lock();
            let fresh = !s.per_user.contains_key(&user);
            s.per_user.entry(user).or_default().push_back(job);
            // **مرة واحدة في الترتيب**: طابورٌ ثانٍ لصاحبٍ حاضر لا يعني دوراً
            // ثانياً — وإلا صار مستخدمٌ بأربعة ملفات أربعةَ أدوار.
            if fresh {
                s.order.push_back(user);
            }
        }
        self.ready.notify_one();
    }

    /// يُخرج المهمّة التالية، أو `None` عند الإيقاف. **يحجب** حتى يتوفّر عملٌ
    /// وفتحة — وهذا هو مكان السقف العام الوحيد.
    fn pop(&self) -> Option<Job> {
        let mut s = self.lock();
        loop {
            if s.stop {
                return None;
            }
            if s.running < s.limit as usize {
                if let Some(job) = Self::take_next(&mut s) {
                    s.running += 1;
                    return Some(job);
                }
            }
            s = self.ready.wait(s).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// يأخذ مهمّةً واحدة بالدور: مستخدمٌ من مقدّمة الترتيب، فإن بقي له عمل
    /// أُعيد إلى **آخره** — فلا يحتكر السقف.
    fn take_next(s: &mut QueueState) -> Option<Job> {
        while let Some(user) = s.order.pop_front() {
            let Some(q) = s.per_user.get_mut(&user) else {
                continue;
            };
            let Some(job) = q.pop_front() else {
                s.per_user.remove(&user);
                continue;
            };
            if q.is_empty() {
                s.per_user.remove(&user);
            } else {
                s.order.push_back(user);
            }
            return Some(job);
        }
        None
    }

    /// **يُحرّر فتحةً** ويوقظ المنتظرين. نداءٌ على مهمّةٍ انتهت (وفيها نقص)
    /// لا يُنقص إلى ما تحت الصفر — العدّاد لا يلتفّ.
    fn finish_one(&self) {
        {
            let mut s = self.lock();
            s.running = s.running.saturating_sub(1);
        }
        self.ready.notify_all();
    }

    /// يوقف الطابور ويفتح كل المنتظرين (إيقاف العامل من الإعدادات).
    fn shutdown(&self) {
        {
            let mut s = self.lock();
            s.stop = true;
        }
        self.ready.notify_all();
    }

    /// عدد المهامّ المنتظرة (بلا الجارية) — للقياس في الاختبارات.
    #[cfg(test)]
    fn waiting(&self) -> usize {
        self.lock().per_user.values().map(VecDeque::len).sum()
    }

    /// المهامّ الجارية الآن — **المقياس المباشر للسقف** في اختبار التوازي.
    #[cfg(test)]
    fn running(&self) -> usize {
        self.lock().running
    }
}

/// فتحة مشغّل: تُحرَّر **صراحةً** فور انتهاء حاجة المهمّة إلى موارد الجهاز،
/// وتلقائياً عند الخروج من `run_job` (نجاحاً أو خطأً أو ذعراً).
///
/// **النداء مرتان لا يُنقص مرتين** (‏`released`)، فالفتحة لا «تُوهَب» لمهمّة
/// أخرى مرتين.
struct JobSlot {
    queue: Arc<JobQueue>,
    released: bool,
}

impl JobSlot {
    fn new(queue: Arc<JobQueue>) -> Self {
        Self {
            queue,
            released: false,
        }
    }

    /// **يُحرّر المورد قبل أي انتظار بشري** (شرط م٤ §٣): يُنادى بعد نداء المحرّك
    /// مباشرةً، فسؤال التجاوز وضغطات الأعضاء لا تُبقي أحداً خارج السقف.
    fn release(&mut self) {
        if !self.released {
            self.released = true;
            self.queue.finish_one();
        }
    }
}

impl Drop for JobSlot {
    fn drop(&mut self) {
        self.release();
    }
}

/// مهامّ تلغرام: خيط استقبالٍ واحد يُدخل الطابور، وعاملٌ لكل فتحة يسمح بها
/// السقف الأقصى. **والسقف الفعلي يُفحص داخل الطابور** ([`JobQueue::pop`])،
/// فالعامل الثاني ينتظر حين يكون السقف ١ ولا يُلغي وجوده السقف.
fn spawn_job_thread(
    cfg: TgConfig,
    stop: Arc<AtomicBool>,
    rx: Receiver<Job>,
    oversize: Arc<Mutex<OversizeStore>>,
    queue: Arc<JobQueue>,
) {
    // Self-healing: wipe whatever a previous run (or a crash) left in the
    // scratch dir. Safe here because no job can be running yet.
    clear_scratch(&work_dir(&crate::paths::data_dir()));
    spawn_job_intake(stop.clone(), rx, queue.clone());
    spawn_job_workers(cfg, stop, oversize, queue);
}

/// خيط الاستقبال: القناة ← الطابور. (مفصولٌ عن العاملين ليستطيع فحصٌ أن
/// **يملأ الطابور قبل أن يبدأ أي عامل** فيقيس ترتيب الدور بلا سباق.)
fn spawn_job_intake(stop: Arc<AtomicBool>, rx: Receiver<Job>, queue: Arc<JobQueue>) {
    let _ = std::thread::Builder::new()
        .name("telegram-intake".into())
        .spawn(move || {
            while let Ok(job) = rx.recv() {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                queue.push(job);
            }
            // القناة أُغلقت (إعادة تشغيل العامل) ⇒ لا منتظرَ إلى الأبد.
            queue.shutdown();
        });
}

/// العاملون: واحد لكل فتحة يسمح بها السقف الأقصى، والسقف الفعلي يُفحص داخل
/// الطابور ([`JobQueue::pop`]) فالعامل الثاني ينتظر حين يكون السقف ١.
fn spawn_job_workers(
    cfg: TgConfig,
    stop: Arc<AtomicBool>,
    oversize: Arc<Mutex<OversizeStore>>,
    queue: Arc<JobQueue>,
) {
    for i in 0..slots::MAX_LIMIT {
        let cfg = cfg.clone();
        let stop = stop.clone();
        let oversize = oversize.clone();
        let queue = queue.clone();
        let _ = std::thread::Builder::new()
            .name(format!("telegram-jobs-{i}"))
            .spawn(move || {
                while let Some(job) = queue.pop() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    // الخارج من الطابور يُحسب **داخل** `run_job` بعد
                    // `InFlightGuard` (لا هنا): بهذا لا توجد لحظة تكون فيها
                    // المهمّة في لا عدّاد.
                    let mut slot = JobSlot::new(queue.clone());
                    run_job(&cfg, job, &stop, &oversize, Some(&mut slot));
                    if let Ok(mut st) = status().lock() {
                        st.processed += 1;
                        st.last_activity = now_stamp();
                    }
                }
            });
    }
}

fn now_stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// نفس ساعة `slots::JobInfo::started_ms` (ميلي ثانية منذ حقبة يونكس) — فتُقاس
/// مدة المهمّة بمصدر واحد لا بمصدرين يفترقان.
fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ── بوابة الكتابة على رسالة الحالة: «آخر ما يُكتب هو الأحدث» (م٣/إصلاح) ─────

/// رتبة الحالة المكتوبة على رسالة واحدة. **الكتابة لا تتراجع**: ما رتبته أدنى
/// من آخر ما كُتب **يُسقَط**، و[`StatusRank::Cancelled`] تُجمّد الرسالة نهائياً
/// فلا يطمسها تعديلٌ متأخّر.
///
/// **والعطل المقيس**: «⏳ في قائمة الانتظار — دورك: 1» و«▶ بدأت المعالجة»
/// يُحرَّران من **خيطين** (خيط تحديثات البوت بعد `tx.send`، وخيط
/// `telegram-jobs`)، فوصل التعديلان في المللي ثانية نفسها وبقيت على الشاشة
/// «دورك: 1» لمهمّة **بدأت فعلاً**. والترتيب هنا هو الحارس.
///
/// **وعطل ثانٍ بالآلية نفسها**: بعد «🛑 أُلغيت» كان يصل تعديلٌ متأخّر بنصّ
/// «✗ فشلت المعالجة: أُلغيت المعالجة» فيمحو أثر الإلغاء — و`Cancelled`
/// (وهي أعلى رتبة) تمنعه.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum StatusRank {
    /// «⏳ في قائمة الانتظار» — تُحرَّر لحظة الاختيار، وقد تصل بعد البدء.
    Queued = 0,
    /// «▶ بدأت المعالجة» — دخول التنفيذ فعلاً.
    Running = 1,
    /// تقدّم/مرحلة أثناء العمل (لا تسبق البدء ولا تتبع النهاية).
    Progress = 2,
    /// «🛑 طُلب الإلغاء…» — طلبٌ سُجّل ولم تفرغ المهمّة بعد.
    CancelRequested = 3,
    /// نهاية عادية (‏✅ أو ✗).
    Finished = 4,
    /// «🛑 أُلغيت» — **نهائية**: لا يُكتب على الرسالة بعدها شيء.
    Cancelled = 5,
}

/// سطرٌ في سِجلّ الكتابات: **زمن وصول التعديل وترتيبه** — وهما المقياس المطلوب
/// في عطل السباق — وهل قُبل أم أُسقط.
///
/// **وزمنان لا زمن**: `at_ms` لحظة وصول الكتابة (قبل قفل الرسالة)، و`decided_ms`
/// لحظة القرار داخل القسم الحرج. فالأول يكشف **ترتيب الوصول الحقيقي** بين
/// الخيطين، والثاني مرتّبٌ بحكم القفل (وهو ما يقع على السلك).
#[derive(Debug, Clone, PartialEq, Eq)]
struct StatusWrite {
    rank: StatusRank,
    at_ms: u128,
    decided_ms: u128,
    applied: bool,
    text: String,
}

/// عدد الكتابات المحفوظة لكل رسالة (الأقدم يُسقَط) — السِجلّ للتشخيص والقياس،
/// فلا ينمو بلا حدّ على رسالة مهمّةٍ طويلة.
const STATUS_LOG_CAP: usize = 32;
/// عدد البوابات المحفوظة. والحدّ يحمي من نموّ أبدي في عمليةٍ تعمل أسابيع.
///
/// **وما يعنيه الإسقاط**: بوابةٌ خرجت من الحدّ تعود فارغة، فكتابةٌ متأخّرة
/// جداً (بعد ٢٥٦ رسالة أخرى) قد تُقبل نصّاً قديماً. والحدّ **معلَن** لا مخفيّ،
/// والواقع أن معرّف الرسالة في تلغرام لا يُعاد (رسالة الحالة لكل مهمّة جديدة).
const STATUS_GATE_CAP: usize = 256;
/// بوابة ساكنة هذه المدة تُعدّ جديدة عند أول كتابة عليها: حارسٌ لا يبني على
/// «المعرّفات لا تُعاد» وحدها (سلامةٌ احتياطية لا مسار مستعمَل اليوم).
const STATUS_GATE_IDLE_MS: u128 = 6 * 60 * 60 * 1000;

/// بوابة **رسالة واحدة**: آخر رتبة كُتبت، وهل جُمّدت بالإلغاء، وسِجلّ ما وقع.
#[derive(Default)]
struct MessageGate {
    last_rank: Option<StatusRank>,
    /// جُمّدت بـ[`StatusRank::Cancelled`]: لا كتابة بعدها، أبداً.
    frozen: bool,
    writes: u32,
    dropped: u32,
    log: Vec<StatusWrite>,
}

impl MessageGate {
    /// يقبل الكتابة أو يُسقطها، **ويسجّل الزمن والترتيب** في الحالين.
    fn admit(&mut self, rank: StatusRank, at_ms: u128, decided_ms: u128, text: &str) -> bool {
        // بوابة ساكنة ساعاتٍ تُعدّ جديدة (سلامةٌ احتياطية، انظر الثابت).
        if let Some(StatusWrite { at_ms: last, .. }) = self.log.last() {
            if at_ms.saturating_sub(*last) > STATUS_GATE_IDLE_MS {
                self.last_rank = None;
                self.frozen = false;
            }
        }
        let applied = !self.frozen && self.last_rank.map(|l| rank >= l).unwrap_or(true);
        if applied {
            self.last_rank = Some(rank);
            self.frozen = rank == StatusRank::Cancelled;
            self.writes += 1;
        } else {
            self.dropped += 1;
        }
        self.log.push(StatusWrite {
            rank,
            at_ms,
            decided_ms,
            applied,
            text: text.to_string(),
        });
        if self.log.len() > STATUS_LOG_CAP {
            self.log.remove(0);
        }
        applied
    }
}

/// بوابات الرسائل: `(chat_id, message_id) → MessageGate`.
///
/// **قفلٌ لكل رسالة** (لا قفلٌ واحد للكل): يُحتجز عبر **الكتابة نفسها**، فيقع
/// «القرار + الإرسال» في قسمٍ حرج واحد ⇒ ترتيب ما يصل تلغرام هو ترتيب الرتب،
/// **وهو ما لا يكفيه القرار وحده**: قِيس في اختبار السباق أن قرارين صحيحين
/// (انتظارٌ ثم بدء) وصلا مقلوبين على السلك لأن النداءين شبكيّان متوازيان.
#[derive(Default)]
struct StatusGates {
    order: VecDeque<(i64, i64)>,
    by_key: HashMap<(i64, i64), Arc<Mutex<MessageGate>>>,
}

fn status_gates() -> &'static Mutex<StatusGates> {
    static G: OnceLock<Mutex<StatusGates>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(StatusGates::default()))
}

/// **البوابة الوحيدة لكل كتابة على رسالة حالة** — من أي خيط. تُرتِّب الكتابة
/// وتسجّل زمنها، فإن قُبلت أُرسل التعديل، وإلا فلا شيء (والنصّ الأحدث يبقى).
///
/// **والقفل يُحتجز عبر نداء الشبكة**: بدونه كان القرار مرتّباً والوصول مقلوباً
/// (قاسه اختبار السباق: الرتبة `Running` قُبلت بعد `Queued` ووصلت **قبلها**).
/// والقفل **لكل رسالة**، فلا تُبطئ رسالةٌ رسالةً أخرى.
///
/// **والفشل الشبكي لا يُرجِع الرتبة**: التعديلات في هذا الملف كلها بأفضل جهد
/// (`let _ =`)، فلو فشل تعديلٌ حسبت البوابة أنه وقع — النصّ على الشاشة قد يبقى
/// أقدم من الرتبة المحفوظة. والبديل (إرجاع الرتبة عند الفشل) يفتح باب السباق
/// من جديد، فالحدّ **معلَن** لا مخفيّ.
///
/// `message_id == 0` تعني «لا رسالة» (فشل الإنشاء) ⇒ لا كتابة ولا سِجلّ.
fn status_push(
    cfg: &TgConfig,
    chat_id: i64,
    message_id: i64,
    rank: StatusRank,
    text: &str,
    keyboard: Value,
) -> bool {
    if message_id == 0 {
        return false;
    }
    let key = (chat_id, message_id);
    // **زمن الوصول** يُلتقط قبل أي قفل: هو ترتيب وصول الخيطين الحقيقي.
    let at_ms = epoch_ms();
    let gate = {
        let mut g = status_gates().lock().unwrap_or_else(|p| p.into_inner());
        // ترتيب «الأحدث كتابةً في الخلف»: المفتاح المكتوب الآن يُنقل إلى الخلف.
        g.order.retain(|k| *k != key);
        g.order.push_back(key);
        while g.order.len() > STATUS_GATE_CAP {
            // يُسقَط الأقدم **غير المجمّد**: المجمّد هو ما يمنع عودة نصٍّ قديم
            // (عطل الإلغاء)، وإسقاطه يعيد العطل. وإن كانت كلها مجمّدة يسقط
            // الأقدم — فالحدّ يمنع نموّاً أبدياً ولا يُخفي ذلك.
            //
            // **و`try_lock` لا `lock`**: المسح يقع وقفلُ السِجلّ مُحتجز، فانتظار
            // قفل رسالةٍ يكتب عليها خيطٌ الآن (حتى مهلة الشبكة) كان سيُجمّد كل
            // الرسائل. والبوابة المشغولة **تُحتفظ** بها (فهي الفاعلة الآن).
            let victim = g
                .order
                .iter()
                .position(|k| match g.by_key.get(k) {
                    None => true,
                    Some(m) => {
                        let frozen = match m.try_lock() {
                            Ok(mg) => mg.frozen,
                            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner().frozen,
                            Err(std::sync::TryLockError::WouldBlock) => true,
                        };
                        !frozen
                    }
                })
                .unwrap_or(0);
            if let Some(old) = g.order.remove(victim) {
                g.by_key.remove(&old);
            }
        }
        g.by_key
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(MessageGate::default())))
            .clone()
    };
    // **القفل يُحتجز عبر الإرسال**: القرار والكتابة في قسمٍ حرج واحد، فلا
    // يسبق تعديلٌ أقدمُ رتبةً تعديلاً أحدث منها على السلك.
    let mut gate = gate.lock().unwrap_or_else(|p| p.into_inner());
    let decided_ms = epoch_ms();
    // م٤: **سقف المجموعة** — التعديلات التجميلية (ما دون النهاية) تُسقَط إن
    // تجاوزت حصّة المحادثة (٢٠/دقيقة · رسالة/ثانية)، فالتقدّم زينةٌ لا خبر.
    // أما الكتابة **النهائية** فلا تُسقَط: هي آخر ما يراه المستخدم، وإسقاطها
    // يترك «⏳ في قائمة الانتظار» على مهمّة انتهت.
    if rank < StatusRank::Finished && !pace_group_edit(chat_id) {
        gate.dropped += 1;
        gate.log.push(StatusWrite {
            rank,
            at_ms,
            decided_ms,
            applied: false,
            text: format!("(أُسقِط لسقف المجموعة) {text}"),
        });
        if gate.log.len() > STATUS_LOG_CAP {
            gate.log.remove(0);
        }
        return false;
    }
    if !gate.admit(rank, at_ms, decided_ms, text) {
        return false;
    }
    let _ = edit_message_kb(cfg, chat_id, message_id, text, Some(keyboard));
    true
}

/// رتبة الكتابة المناسبة لجواب الإلغاء: «🛑 أُلغيت» **نهائية** تُجمّد الرسالة،
/// وما دونها (طلبٌ معلَّق أو «لا مهمّة جارية») لا يُجمّد — فقد يأتي بعدها نهايةٌ
/// حقيقية تُكتب.
fn cancel_reply_rank(reply: &str) -> StatusRank {
    if reply == CANCELLED_TEXT {
        StatusRank::Cancelled
    } else {
        StatusRank::CancelRequested
    }
}

/// سِجلّ كتابات رسالةٍ ما — **للقياس وحده**: زمن وصول كل تعديل وترتيبه، وهل
/// قُبل. (`#[cfg(test)]` لأن المنتج لا يقرأ السِجلّ، بل يبني عليه القرار فقط.)
#[cfg(test)]
fn status_write_log(chat_id: i64, message_id: i64) -> Option<Vec<StatusWrite>> {
    let g = status_gates().lock().unwrap_or_else(|p| p.into_inner());
    let gate = g.by_key.get(&(chat_id, message_id))?.clone();
    drop(g);
    let log = gate.lock().unwrap_or_else(|p| p.into_inner()).log.clone();
    Some(log)
}

/// عدد المقبول والمُسقَط على رسالة — للقياس في الاختبارات.
#[cfg(test)]
fn status_write_counts(chat_id: i64, message_id: i64) -> Option<(u32, u32)> {
    let g = status_gates().lock().unwrap_or_else(|p| p.into_inner());
    let gate = g.by_key.get(&(chat_id, message_id))?.clone();
    drop(g);
    let mg = gate.lock().unwrap_or_else(|p| p.into_inner());
    Some((mg.writes, mg.dropped))
}

/// تصفير البوابات — **بين الاختبارات**: السِجلّ واحد للعملية كلها، وبوابةٌ
/// مجمّدة من فحصٍ سابق كانت ستُسقط كتابات فحصٍ لاحق على الرسالة نفسها (‏1001).
#[cfg(test)]
fn reset_status_gates() {
    let mut g = status_gates().lock().unwrap_or_else(|p| p.into_inner());
    g.order.clear();
    g.by_key.clear();
}

/// هل اللوحة فارغة صراحةً؟ (هي علامة «انتهت» في هذا الملف.)
fn keyboard_is_empty(keyboard: &Value) -> bool {
    keyboard
        .pointer("/inline_keyboard")
        .and_then(Value::as_array)
        .map(|a| a.is_empty())
        .unwrap_or(false)
}

/// Throttled status message: Telegram rate-limits edits, and progress is
/// cosmetic — 3s granularity is plenty.
///
/// **واللوحة تُمرَّر مع كل تعديل**: زرّ الإلغاء يبقى ما دامت المهمّة، ويُزال
/// **بلوحة فارغة صراحةً** في التعديل النهائي (`end`) — لأن تعديلاً بلا
/// `reply_markup` يمحو اللوحة في تلغرام، وهو عطل المالك المقيس.
///
/// **وكل كتابة تمرّ بـ[`status_push`]** (م٣/إصلاح): فلا خيطان يكتبان بلا ترتيب.
struct StatusMsg {
    chat_id: i64,
    /// **صاحب المهمّة** (م٤): زرّ الإلغاء يُبنى بمعرّفه، فلا يقع زرٌّ بلا صاحب
    /// (وضغطةٌ بلا صاحب لا يمكن مصادقتها).
    user_id: i64,
    message_id: i64,
    last: Instant,
    text: String,
    /// هل اللوحة المرفقة الآن هي زرّ الإلغاء؟ (يُصفَّر عند الإنهاء.)
    button_live: bool,
    /// **علم إلغاء المهمّة نفسه** (الرمز الذي يضبطه الزرّ و`/kill`): مهمّة
    /// أُلغيَت تُوصَف بإلغاء لا بفشل — ولا يُبنى ذلك على نصّ الخطأ.
    cancel: Arc<AtomicBool>,
}

impl StatusMsg {
    fn new(chat_id: i64, user_id: i64, message_id: i64, cancel: Arc<AtomicBool>) -> Self {
        Self {
            chat_id,
            user_id,
            message_id,
            last: Instant::now(),
            text: String::new(),
            button_live: message_id != 0,
            cancel,
        }
    }

    /// تحديث **أثناء العمل**: يمرّر زرّ الإلغاء فيبقى على الرسالة.
    fn set(&mut self, cfg: &TgConfig, text: String, force: bool) {
        self.push(
            cfg,
            text,
            force,
            cancel_button(self.chat_id, self.user_id),
            StatusRank::Progress,
        );
    }

    /// تحديث **نهائي**: يمرّر لوحة فارغة **صراحةً** فيزول الزر — ولا يُترك
    /// زواله لسلوك ضمني هشّ.
    ///
    /// **ومهمّة أُلغيَت لا تُوصَف بفشل** (م٣/إصلاح): كان الخروج بعد الإلغاء
    /// يكتب «✗ فشلت المعالجة: أُلغيت المعالجة» بعد «🛑 أُلغيت» فيمحو أثره
    /// ويُظهر فشلاً لعملٍ أُلغي عمداً. فالنصّ ورتبته يُختاران هنا في موضع واحد.
    fn end(&mut self, cfg: &TgConfig, text: String) {
        let (rank, text) = self.terminal(text);
        self.push(cfg, text, true, no_keyboard(), rank);
    }

    /// النصّ والرتبة عند الخروج: إلغاءٌ صريح، أو النصّ كما هو.
    fn terminal(&self, text: String) -> (StatusRank, String) {
        if self.cancel.load(Ordering::SeqCst) {
            (StatusRank::Cancelled, CANCELLED_TEXT.to_string())
        } else {
            (StatusRank::Finished, text)
        }
    }

    fn push(
        &mut self,
        cfg: &TgConfig,
        text: String,
        force: bool,
        keyboard: Value,
        rank: StatusRank,
    ) {
        if !force && self.last.elapsed() < EDIT_MIN_GAP {
            return;
        }
        self.last = Instant::now();
        let terminal = rank >= StatusRank::Finished;
        let shown = if self.message_id == 0 {
            true
        } else {
            status_push(
                cfg,
                self.chat_id,
                self.message_id,
                rank,
                &text,
                keyboard.clone(),
            )
        };
        if shown {
            self.text = text;
            // اللوحة الفارغة تعني «انتهت» — يُسجَّل ذلك حتى لا تُعاد الإزالة مرّتين.
            self.button_live = !keyboard_is_empty(&keyboard);
        } else if terminal {
            // رتبتُنا النهائية رُفضت لأن رسالةً أحدث سبقتنا (إلغاءٌ كتب نصّه
            // عليها) ⇒ الرسالة **منتهية** وإن لم نكتب نحن، ويجب ألا يبقى زرٌّ
            // عليها. **ولا نكتب نصّنا القديم** — كان سيطمس الإلغاء.
            self.button_live = false;
        }
    }
}

/// **ضمانة بنيوية**: على كل باب خروج من `run_job` — نجاحاً أو خطأً أو ذعراً —
/// يُزال زرّ الإلغاء بلوحة فارغة صراحةً إن لم يكن فرعٌ قد أزاله. فلا يبقى زرّ
/// إلغاء على مهمّة منتهية، ولا يتوقّف ذلك على تذكّر كل فرع.
///
/// **وحدّه المعلَن اليوم**: كل فروع `run_job` الحالية تُنادي `end()` أو تُزيل
/// اللوحة صراحةً، فلا فرعَ يُنفّذ هذا الحارس وحده **إلا الذعر** (فكّ مكدّس) —
/// ولا يُصطنَع ذعرٌ من البيانات (`Job` كلّها بيانات عاديّة، والمقابض تُعالَج
/// من التسمّم بـ`unwrap_or_else(|p| p.into_inner())`). فالاختبارات تقيس الحارس
/// **في موضعه**: إسقاطٌ صريح بلا `end` (يُزيل الزرّ)، وبعد `end` (لا يُرسل
/// تعديلاً زائداً).
struct CancelButtonGuard<'a> {
    cfg: &'a TgConfig,
    status: &'a std::cell::RefCell<StatusMsg>,
}

impl Drop for CancelButtonGuard<'_> {
    fn drop(&mut self) {
        let s = self.status.borrow();
        if s.message_id != 0 && s.button_live && !s.text.is_empty() {
            // **النصّ بحسب الحال**: مهمّة أُلغيَت لا يُعاد كتابة تقدّمها القديم
            // فوق نصّ الإلغاء — يُكتب نصّ الإلغاء نفسه، ورتبته نهائية.
            let (rank, text) = s.terminal(s.text.clone());
            let _ = status_push(
                self.cfg,
                s.chat_id,
                s.message_id,
                rank,
                &text,
                no_keyboard(),
            );
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
                Err(e) => {
                    tracing::warn!(target: "telegram", "تعذر حذف المؤقت {}: {e}", f.display())
                }
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

fn run_job(
    cfg: &TgConfig,
    job: Job,
    stop: &Arc<AtomicBool>,
    oversize: &Arc<Mutex<OversizeStore>>,
    // فتحة المشغّل (م٤): `None` في الاختبارات التي تنادي `run_job` مباشرةً
    // بلا طابور — والمسار الإنتاجي يمرّرها دائماً.
    mut slot: Option<&mut JobSlot>,
) {
    // ① المهمّة «جارية» **قبل** أن تخرج من عدّاد القناة: لا لحظة تكون فيها في
    //    لا عدّاد (وإلا عُدّ «دورك» ناقصاً في تلك النافذة).
    let _in_flight = InFlightGuard::enter();
    dec(&QUEUE_DEPTH);
    if let Ok(mut st) = status().lock() {
        st.queue = QUEUE_DEPTH.load(Ordering::SeqCst);
    }
    let row_id = job.row_id;
    jobs_started(row_id);
    // الافتراض `failed` حتى يُقال `ok()` صراحةً عند نجاةٍ مُثبَتة.
    let mut row = JobRowGuard {
        id: row_id,
        ok: false,
    };
    // **م٣: التسجيل قبل التنزيل لا بعده.** قبله كانت المهمّة خارج السِجلّ حتى
    // `run_separation`، فكان زرّ الإلغاء (و`/kill`) يردّ «لا مهمّة جارية» كذباً
    // وهو ظاهر على الشاشة — قياس: للمهمّة نافذة تحضير كاملة لا يُلغيها أحد.
    // والمسار يُثبَّت لاحقاً (`set_path`) فور أن يصير معلوماً: `None` هنا صادق
    // (لم يُعرف بعد)، ولا يكسر مطابقة الواجهة بالمسار.
    // **م٣: التسجيل قبل التنزيل لا بعده.** قبله كانت المهمّة خارج السِجلّ حتى
    // `run_separation`، فكان زرّ الإلغاء (و`/kill`) يردّ «لا مهمّة جارية» كذباً
    // وهو ظاهر على الشاشة — قياس: للمهمّة نافذة تحضير كاملة لا يُلغيها أحد.
    // والمسار يُثبَّت لاحقاً (`set_path`) فور أن يصير معلوماً: `None` هنا صادق
    // (لم يُعرف بعد)، ولا يكسر مطابقة الواجهة بالمسار.
    let early = slots::register_early(&job_label(job.chat_id, job.user_id), None);

    let app_data = crate::paths::data_dir();
    let scratch = work_dir(&app_data);
    // Delivered results live with the user's other results; the scratch dir
    // holds only our copy of a sent file and compression intermediates.
    let results = out_dir();
    let _ = std::fs::create_dir_all(&results);
    let Job {
        chat_id,
        user_id,
        user: job_user,
        source,
        mode,
        src_msg_id,
        status_msg_id,
        file: job_file,
        row_id: _,
    } = job;

    let label = mode_label(mode);
    // رمز الإلغاء **رمز المهمّة نفسه**: ضغطة الزرّ تضبطه، فيتوقّف التنزيل
    // (‏yt-dlp يستقبل هذا العلم بعينه ويستطلع عليه)، وتُقتل شجرته لأن سياق
    // المهمّة مثبَّت على هذا الخيط منذ `register_early`.
    //
    // **ويُقرأ قبل إنشاء رسالة الحالة** (م٣/إصلاح): نصّ الخروج يُختار به —
    // فمهمّة أُلغيَت تُوصَف بإلغاء لا بفشل.
    let cancel = early.cancel_flag();
    // ② «بدأت المعالجة» تُقال **الآن** لا عند الضغط على الزرّ. ورسالة الحالة هي
    //    **رسالة السؤال نفسها** حين أمكن: رسالة واحدة للملف تُحرَّر في مكانها
    //    (لا رسالة لكل تحديث)، وزرّ الإلغاء يحلّ محلّ أزرار الوضع.
    //
    //    **ورتبتها `Running`** (م٣/إصلاح): هي أعلى من `Queued`، فإشعار الانتظار
    //    المتأخّر (يُحرَّر من خيط التحديثات) لا يمحوها إن وصل بعدها.
    let msg_id = if status_msg_id != 0 {
        let _ = status_push(
            cfg,
            chat_id,
            status_msg_id,
            StatusRank::Running,
            &running_text(label),
            cancel_button(chat_id, user_id),
        );
        status_msg_id
    } else {
        send_message(
            cfg,
            chat_id,
            &running_text(label),
            Some(cancel_button(chat_id, user_id)),
            Some(src_msg_id),
        )
        .unwrap_or(0)
    };
    // RefCell: the progress closure AND the stage closure both report through
    // the same status message, and two `&mut` captures cannot coexist.
    let status = std::cell::RefCell::new(StatusMsg::new(chat_id, user_id, msg_id, cancel.clone()));
    // ضمانة بنيوية: **على كل باب خروج** يُزال زرّ الإلغاء صراحةً لو نسي فرعٌ
    // ذلك، فلا يبقى زرّ على مهمّة منتهية أبداً.
    let _cancel_button_guard = CancelButtonGuard {
        cfg,
        status: &status,
    };

    // 1. Obtain the input. Everything this job creates inside the scratch dir
    //    is disposable and tracked here, so no exit path can leak it.
    let mut scratch_files = ScratchGuard::default();
    let input: PathBuf = match &source {
        Source::Link(url) => {
            status
                .borrow_mut()
                .set(cfg, "📥 جارٍ التنزيل… 0%".into(), true);
            let dir = out_dir();
            let _ = std::fs::create_dir_all(&dir);
            let dl = |p: f32| {
                status.borrow_mut().set(
                    cfg,
                    format!("📥 جارٍ التنزيل… {}%", (p * 100.0).round()),
                    false,
                );
                !stop.load(Ordering::SeqCst)
            };
            match crate::yt_dlp::download_media(url, &dir, &dl, &cancel) {
                Ok(p) => p,
                Err(e) => {
                    status.borrow_mut().end(cfg, format!("✗ فشل التنزيل: {e}"));
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
                // الرسالة تحمل زرّ الإلغاء من إنشائها، فيُزال **صراحةً** هنا —
                // ومن البوابة الواحدة (`end`) لا بتعديلٍ مباشر: كل كتابة على
                // رسالة الحالة تمرّ من موضع واحد، فلا خيطان بلا ترتيب.
                status.borrow_mut().end(
                    cfg,
                    format!(
                        "✗ حجم الملف {} يتجاوز حد تيليجرام للتنزيل ({}).\n\
                         أرسل المقطع كرابط (بلا حد)، أو فعّل الخادم المحلي من الإعدادات.",
                        human_mb(*size),
                        human_mb(CLOUD_DOWNLOAD_MAX_BYTES)
                    ),
                );
                return;
            }
            status
                .borrow_mut()
                .set(cfg, "📥 جارٍ استلام الملف…".into(), true);
            let (remote, _sz) = match get_file(cfg, file_id) {
                Ok(v) => v,
                Err(e) => {
                    status
                        .borrow_mut()
                        .end(cfg, format!("✗ تعذر استلام الملف: {e}"));
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
                            status
                                .borrow_mut()
                                .end(cfg, format!("✗ تعذر نسخ الملف: {e}"));
                            return;
                        }
                    }
                } else {
                    status
                        .borrow_mut()
                        .end(cfg, "✗ مسار الملف المحلي غير موجود".into());
                    return;
                }
            } else {
                match download_cloud_file(cfg, &remote, &dest, CLOUD_DOWNLOAD_MAX_BYTES, &cancel) {
                    Ok(_) => {
                        scratch_files.track(&dest);
                        dest
                    }
                    Err(e) => {
                        status.borrow_mut().end(cfg, format!("✗ {e}"));
                        return;
                    }
                }
            }
        }
    };

    // 2. Probe: duration decides whether a cloud upload can carry a picture.
    // المسار صار معلوماً ⇒ يُثبَّت في السِجلّ (تطابق الواجهة بالمسار كما في م٢).
    early.set_path(&input.to_string_lossy());
    let info = crate::media::probe(&input).ok();
    let duration = info.as_ref().map(|i| i.duration_secs).unwrap_or(0.0);
    let source_has_video = info
        .as_ref()
        .map(|i| i.has_video && !i.video_is_cover_art)
        .unwrap_or(false);
    let render_video =
        source_has_video && !cfg.audio_only && video_worth_rendering(duration, cfg.is_local());
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
            a.try_state::<crate::AppState>().map(|st| {
                st.settings
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
            })
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
        // تقدّم حقيقي ⇒ بثٌّ حقيقي (`telegram-jobs`)، لا استطلاعاً دورياً.
        jobs_progress(row_id, f64::from(p) * 100.0);
        status.borrow_mut().set(
            cfg,
            format!("🎛️ فصل الصوت… {}%", (p * 100.0).round()),
            false,
        );
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
    // م١: مهمّة البوت تأخذ فتحة جهاز مثل كل مدخل آخر.
    // م٢: ووسمها يحمل معرّف المحادثة (`telegram:<chat_id>`) فيجدها `/kill`،
    // ويُسجَّل مسار الإدخال معها فتظهر الواجهةُ المهمّةَ بمصدرها.
    // م٣: والتسجيل **مبكر** (فُتح قبل التنزيل)، فلا تُسجَّل المهمّة مرّتين ولا
    // يُبنى رمز إلغاء ثانٍ — الفتحة وحدها تُؤخذ هنا.
    let processed = slots::run_separation_registered(
        early,
        // Results land in the user's results folder — the same place the
        // browser bridge puts them — NOT in our scratch dir. That was the bug
        // behind the 150MB of "temporary" files the owner found in AppData:
        // the delivered artefact was being written to the scratch folder and
        // never cleaned (2026-09-11).
        &input, &results, mode, kind, false, true, s.cuda, None, &prog, &stage,
    );
    let out = match processed {
        Ok(o) => o,
        Err(e) => {
            status
                .borrow_mut()
                .end(cfg, format!("✗ فشلت المعالجة: {e}"));
            // A Telegram-sent copy is ours (the guard removes it); a link
            // download is kept for inspection, exactly like the bridge does.
            if matches!(source, Source::Link(_)) {
                let _ = std::fs::remove_file(&input);
            }
            return;
        }
    };
    // **الموارد صارت حرة الآن** (نداء المحرّك انتهى وفتحة الجهاز أُعيدت):
    // فتحة المشغّل تُحرَّر هنا — **قبل** أي انتظار بشري أدناه (سؤال التجاوز
    // وضغطات الأعضاء) وقبل الإرسال. فلا يبقى مستخدمٌ خارج السقف لأن غيره
    // ينتظر ضغطة. (والتحرير يقع في `Drop` أيضاً على كل باب خروج آخر.)
    if let Some(s) = slot.as_mut() {
        s.release();
    }

    // 4. Pick the artifact and decide how to deliver it.
    let produced = out
        .video
        .clone()
        .or_else(|| out.vocals.clone())
        .or_else(|| out.instrumental.clone());
    let Some(produced) = produced else {
        status.borrow_mut().end(cfg, "✗ لم ينتج ملف".into());
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
            let height = info.as_ref().and_then(|i| i.height).map(|h| h.min(720));
            match crate::media::transcode_to_bitrate(
                &produced,
                &shrunk,
                target_kbps,
                AUDIO_KBPS,
                height,
            ) {
                Ok(p) => {
                    let small = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    if small > CLOUD_SEND_MAX_BYTES {
                        // Still over: the honest fallback is the audio track.
                        match audio_fallback(cfg, &produced, &scratch, &mut scratch_files) {
                            Some(a) => a,
                            None => {
                                status
                                    .borrow_mut()
                                    .end(cfg, "✗ تعذر تصغير الناتج ليدخل في حد تيليجرام".into());
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
                            status
                                .borrow_mut()
                                .end(cfg, format!("✗ تعذر ضغط الناتج: {e}"));
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
                        status.borrow_mut().end(cfg, "✗ تعذر استخراج الصوت".into());
                        return;
                    }
                }
            } else {
                produced.clone()
            }
        }
    };

    // 5. Send it — أو **اسأل** عند التجاوز (م٣): الرفض الصامت كان يترك الناتج
    //    عالقاً بلا خيار. والسؤال يُطرح هنا **بعد** أن فرغت فتحة الجهاز
    //    (`run_separation` أعادت)، فلا تُحتجز مورد على انتظار ضغطة (شرط م٣).
    let bytes_out = std::fs::metadata(&to_send).map(|m| m.len()).unwrap_or(0);
    if !cfg.is_local() && bytes_out > CLOUD_SEND_MAX_BYTES {
        // **يُسأل عن الناتج الأصلي في مجلد النتائج** — لا عن `to_send` الذي قد
        // يكون وسيطاً في المجلد المؤقّت (`ScratchGuard` يمحوه عند الخروج)، فكان
        // السؤال يشير إلى ملفٍ محذوف.
        let ask = OversizeAsk {
            chat_id,
            user_id,
            user: &job_user,
            src_msg_id,
            produced: &produced,
            duration_secs: duration,
            has_video,
            bytes: bytes_out,
            height: info.as_ref().and_then(|i| i.height).map(|h| h.min(720)),
            file: &job_file,
        };
        match ask_oversize(cfg, oversize, ask) {
            // المعالجة نجحت والملف موجود وينتظر قراراً: هذا ليس فشلاً.
            Ok(()) => {
                row.ok();
                // الحالة تُنهى بزرٍّ مُزال: لا شيء يُلغى بعد الآن.
                status.borrow_mut().end(
                    cfg,
                    format!(
                        "⏳ الناتج {} فوق حدّ الإرسال — سألتك في الرسالة أدناه.",
                        human_mb(bytes_out)
                    ),
                );
            }
            Err(e) => {
                status
                    .borrow_mut()
                    .end(cfg, format!("✗ تعذّر طرح سؤال الضغط: {e}"));
            }
        }
        if matches!(source, Source::Link(_)) {
            let _ = std::fs::remove_file(&input);
        }
        return;
    }
    status.borrow_mut().set(cfg, "📤 جارٍ الإرسال…".into(), true);
    let caption = format!(
        "🎧 HaramLite — أُزيلت الموسيقى ({})\nالوضع: {}",
        human_mb(bytes_out),
        mode_label(mode)
    );
    // م٣: الناتج **ردٌّ على رسالة المستخدم** فيقع تحت الوسائط المعالجة.
    match send_media(cfg, chat_id, &to_send, &caption, Some(src_msg_id)) {
        Ok(()) => {
            row.ok();
            // م٥: الإحصاء يُدوَّن **عند التسليم الناجح وحده** — ملفٌّ واحد
            // بحجمه، بعد أن وصل صاحبه فعلاً. والفشل لا يُدوَّن (فلا رقم يكذب)
            // ولا يُكتب سطر (فلا ملفّ ينمو)، والفشلُ نفسه يُعلَن في الحالة أعلاه.
            note_stats_delivery(user_id, &job_user, bytes_out);
            status.borrow_mut().end(
                cfg,
                format!(
                    "✅ تم — {} في {:.0} ثانية",
                    human_mb(bytes_out),
                    out.seconds
                ),
            );
        }
        Err(e) => {
            status.borrow_mut().end(cfg, format!("✗ فشل الإرسال: {e}"));
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
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
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

    // ═══════════════════════════════════════════════════════════════════════
    //  م٣ — خادم Bot API وهمي محلي: يقيس **ما يُرسَل فعلاً** بلا شبكة خارجية
    //  ولا توكن ولا تلغرام حقيقي. النمط مأخوذ من اختبار multipart القائم في هذا
    //  الملف (‏`TcpListener` حقيقي على 127.0.0.1).
    // ═══════════════════════════════════════════════════════════════════════

    #[derive(Debug, Clone)]
    struct SeenCall {
        method: String,
        body: String,
        /// **الجسم بايتاتٍ** (م٥): نصُّ `body` أعلاه يمرّ بـ`from_utf8_lossy`
        /// فتصير كل بايتةٍ غير صالحة UTF-8 **ثلاث** بايتات (`U+FFFD`) — ورَفْعُ
        /// صورة JPEG كلُّه بايتاتٌ كذلك. فما يُقاس على الطول أو على حمولة
        /// الصورة يُقاس هنا، وما يُقرأ JSON يُقرأ من `body`.
        raw: Vec<u8>,
        /// **ترويسات الطلب الخام** (م٥): بها وحدها يُقاس أن جسم `multipart`
        /// معلَنٌ بـ`Content-Type: multipart/form-data; boundary=…`، وأن الحدّ
        /// المكتوب في الترويسة هو **نفسه** الذي في الجسم حرفاً بحرف.
        head: String,
        /// **ردّ الخادم الوهمي** كما أُرسل — ومنه تُقرأ المعرّفات التي وزّعها
        /// (`message_id`) بلا تخمين رقمٍ متسلسل يبدأ من 1000.
        reply: String,
        /// **زمن وصول الطلب** (ميلي ثانية منذ حقبة يونكس) — يُسجّله الخادم
        /// الوهمي عند القراءة، فتُقاس **أزمنة التعديلات وترتيبها** لا وجودها
        /// وحده (وهو مقياس عطل السباق في م٣).
        at_ms: u128,
    }

    struct FakeBot {
        addr: std::net::SocketAddr,
        seen: Arc<Mutex<Vec<SeenCall>>>,
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
        /// **رفضٌ مصطنع** (م٤): نصوصٌ في جسم الطلب تجعل الخادم يردّ
        /// `{"ok":false}` — وهو الشكل الحقيقي لرفض Bot API («Bad Request: …»).
        /// وبه يُقاس **السقوط** لا النجاح: فانيةٌ غير مدعومة، أو محادثةٌ لم
        /// يبدأها العضو (‏`chat not found`).
        reject_body: Arc<Mutex<Vec<String>>>,
        /// معرّفات محادثات يرفضها الخادم (‏`chat_id`).
        reject_chat: Arc<Mutex<Vec<i64>>>,
        /// **دوالّ يرفضها الخادم** (م٥): الرفض على **اسم الدالّة** لا على نصٍّ
        /// في جسمها — فحارس ت١١ لا يعتمد على شكل جسم الـmultipart، ويبقى
        /// صالحاً لو تغيّر شكله.
        reject_method: Arc<Mutex<Vec<String>>>,
        /// **الاسم الحالي للبوت** على الخادم الوهمي (م٥): `getMyName` يقرؤه
        /// و`setMyName` يكتبه. فالعكس يُقاس على **حالة الخادم** («رجع الاسم»)
        /// لا على نصّ طلبٍ أرسلناه («أرسلنا الاسم») — وهما ليسا سواء.
        my_name: Arc<Mutex<String>>,
    }

    /// يقرأ طلب HTTP واحد: (اسم الدالّة، الترويسات الخام، الجسم بايتات).
    fn read_http_request(sock: &mut std::net::TcpStream) -> (String, String, Vec<u8>) {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut split: Option<usize> = None;
        let mut content_len = 0usize;
        loop {
            if split.is_none() {
                if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    split = Some(p);
                    let head = String::from_utf8_lossy(&buf[..p]).to_ascii_lowercase();
                    content_len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                }
            }
            if let Some(p) = split {
                if buf.len() >= p + 4 + content_len {
                    break;
                }
            }
            if buf.len() > 8 * 1024 * 1024 {
                break; // لا يُعلَّق الاختبار على طلب مشوّه
            }
            match std::io::Read::read(sock, &mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        let p = split.unwrap_or(buf.len());
        let head = String::from_utf8_lossy(&buf[..p.min(buf.len())]).to_string();
        let method = head
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_string();
        let body_start = (p + 4).min(buf.len());
        let body = buf[body_start..].to_vec();
        (method, head, body)
    }

    /// ردّ الخادم الوهمي. **والرفض يُحاكي Bot API حرفاً**: `ok:false` مع
    /// `description`، وهذا ما يقرؤه `call` فيعيد `Err` — فالمسار المُقاس هو
    /// مسار الفشل الحقيقي لا نجاحٌ مصطنع.
    fn fake_reply(
        method: &str,
        body: &str,
        next_msg_id: &mut i64,
        reject_body: &[String],
        reject_chat: &[i64],
        reject_method: &[String],
        my_name: &mut String,
    ) -> String {
        if reject_method.iter().any(|m| m == method) {
            let err = format!(
                "{{\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: {method} rejected by the fixture\"}}"
            );
            return format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                err.len(),
                err
            );
        }
        if reject_body
            .iter()
            .any(|needle| body.contains(needle.as_str()))
        {
            let err = format!(
                "{{\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: {method} rejected by the fixture\"}}"
            );
            return format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                err.len(),
                err
            );
        }
        if !reject_chat.is_empty() && method == "sendMessage" {
            let sent = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|v| v.get("chat_id").and_then(Value::as_i64))
                .unwrap_or(0);
            if reject_chat.contains(&sent) {
                let err = "{\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: chat not found\"}";
                return format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    err.len(),
                    err
                );
            }
        }
        let result = match method {
            "sendMessage" => {
                *next_msg_id += 1;
                json!({ "message_id": *next_msg_id }).to_string()
            }
            // م٥: اسم البوت **حالةً على الخادم** لا نصّاً في طلبنا: `getMyName`
            // يقرؤه و`setMyName` يكتبه — فالعكس يُقاس على ما رجع فعلاً.
            "getMyName" => json!({ "name": my_name.as_str() }).to_string(),
            "setMyName" => {
                if let Ok(v) = serde_json::from_str::<Value>(body) {
                    *my_name = v
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                }
                "true".to_string()
            }
            // تأخير قصير يمثّل long-polling، فلا تدور حلقة الاستطلاع بلا توقّف.
            "getUpdates" => {
                std::thread::sleep(Duration::from_millis(120));
                "[]".to_string()
            }
            // **بطيء عمداً**: يفتح نافذة استلامٍ يُقاس فيها أن المهمّة مسجَّلة
            // أثناءه (التسجيل المبكر، م٣) — وهي النافذة التي كان الزرّ فيها
            // يردّ «لا مهمّة جارية» كذباً. **وفي م٤ صارت نافذة قياس التوازي**:
            // ثلاث مهامّ في ثلاث نافذة ٤٠٠ مللي تُظهر السقف العام فعلاً.
            "getFile" => {
                std::thread::sleep(Duration::from_millis(400));
                json!({ "file_path": "hl_m3_absent.bin", "file_size": 0 }).to_string()
            }
            _ => "true".to_string(),
        };
        let body = format!("{{\"ok\":true,\"result\":{result}}}");
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    impl FakeBot {
        fn start() -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let addr = listener.local_addr().unwrap();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let reject_body: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let reject_chat: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(Vec::new()));
            let reject_method: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            // **اسم البوت المُهيَّأ في BotFather** — ما يجب أن يعود بعد العكس.
            let my_name: Arc<Mutex<String>> = Arc::new(Mutex::new("HaramLite Bot".to_string()));
            let handle = {
                let seen = seen.clone();
                let stop = stop.clone();
                let reject_body = reject_body.clone();
                let reject_chat = reject_chat.clone();
                let reject_method = reject_method.clone();
                let my_name = my_name.clone();
                std::thread::spawn(move || {
                    use std::io::Write as _;
                    let mut next_msg_id: i64 = 1000;
                    while !stop.load(Ordering::SeqCst) {
                        match listener.accept() {
                            Ok((mut sock, _)) => {
                                // **مقيس**: على ويندوز يرث المقبس المقبول وضعَ
                                // المستمع غير الحاجب، فيعود `read` بـ`WouldBlock`
                                // فوراً ويُقرأ **صفر بايت** — والخادم يردّ ردّاً
                                // صحيحاً عن طلبٍ لم يقرأه، فيبدو القياس ناجحاً
                                // وكأن شيئاً لم يُرسَل. فيُعاد إلى الحجب صراحةً.
                                sock.set_nonblocking(false).ok();
                                sock.set_read_timeout(Some(Duration::from_secs(5))).ok();
                                let (method, head, raw) = read_http_request(&mut sock);
                                // النصّ المقروء JSON مشتقٌّ من البايتات (فلا
                                // نسختان تفترقان إن تغيّر القارئ).
                                let body = String::from_utf8_lossy(&raw).to_string();
                                let reject_b = reject_body
                                    .lock()
                                    .unwrap_or_else(|p| p.into_inner())
                                    .clone();
                                let reject_c = reject_chat
                                    .lock()
                                    .unwrap_or_else(|p| p.into_inner())
                                    .clone();
                                let reject_m = reject_method
                                    .lock()
                                    .unwrap_or_else(|p| p.into_inner())
                                    .clone();
                                let mut name =
                                    my_name.lock().unwrap_or_else(|p| p.into_inner()).clone();
                                let reply = fake_reply(
                                    &method,
                                    &body,
                                    &mut next_msg_id,
                                    &reject_b,
                                    &reject_c,
                                    &reject_m,
                                    &mut name,
                                );
                                *my_name.lock().unwrap_or_else(|p| p.into_inner()) = name;
                                if !method.is_empty() {
                                    seen.lock()
                                        .unwrap_or_else(|p| p.into_inner())
                                        .push(SeenCall {
                                            method: method.clone(),
                                            head,
                                            body,
                                            raw,
                                            reply: reply.clone(),
                                            at_ms: epoch_ms(),
                                        });
                                }
                                let _ = sock.write_all(reply.as_bytes());
                                let _ = sock.flush();
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(Duration::from_millis(2));
                            }
                            Err(_) => break,
                        }
                    }
                })
            };
            Self {
                addr,
                seen,
                stop,
                handle: Some(handle),
                reject_body,
                reject_chat,
                reject_method,
                my_name,
            }
        }

        /// **يرفض دالّةً بعينها** — شكل «تلغرام رفض هذا النداء» الحقيقي، وهو
        /// الرفض الذي يجب أن يظهر خطأً مُسمّى لا نجاحاً كاذباً (ت١١).
        fn reject_method(&self, method: &str) {
            self.reject_method
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(method.to_string());
        }

        /// يُوقف الرفض عن دالّة — لإثبات أن المسار ينجح حين يزول السبب (فلا
        /// يكون الفشل المُقاس فشلاً دائماً بحكم التهيئة).
        fn accept_method(&self, method: &str) {
            self.reject_method
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .retain(|m| m != method);
        }

        /// الاسم الحالي للبوت **على الخادم** — ما رجع فعلاً لا ما أرسلناه.
        fn current_name(&self) -> String {
            self.my_name
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
        }

        /// **يُغيّر اسم البوت على الخادم من خارجنا** — محاكاة إعادة التسمية من
        /// `@BotFather`، وهي الحالة التي لا تكشفها رايتنا المحلّية (عطل ٣).
        fn rename_on_server(&self, name: &str) {
            *self.my_name.lock().unwrap_or_else(|p| p.into_inner()) = name.to_string();
        }

        /// يجعل الخادم يرفض كل طلبٍ يحمل هذا النصّ في جسمه — وهو الشكل الحقيقي
        /// لـ«Bot API لا يعرف هذا المعامل».
        fn reject_containing(&self, needle: &str) {
            self.reject_body
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(needle.to_string());
        }

        /// يجعل الخادم يرفض الإرسال إلى هذه المحادثة — شكل «لم يبدأ العضو
        /// محادثةً مع البوت» الحقيقي (‏`chat not found`).
        fn reject_chat_id(&self, chat_id: i64) {
            self.reject_chat
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(chat_id);
        }

        /// إعداد **محلي** (‏`local_url` ⇒ `is_local()`): يعني أن مسار السحابة
        /// (‏سقف الإرسال وسؤال التجاوز) **لا يُفعَّل**، وأن ملفاً مُرسَلاً يُقرأ من
        /// مسار على القرص — وهو ما يجعل `run_job` يُقاس بلا محرّك.
        fn cfg(&self, owner: i64) -> TgConfig {
            TgConfig {
                token: "TESTTOKEN".into(),
                owner_id: Some(owner),
                audio_only: false,
                local_url: Some(format!("http://{}", self.addr)),
                group_mode: GroupMode::Mentions,
            }
        }

        /// نفس الإعداد بوضع مجموعةٍ صريح — للفحوص التي تقيس الوضعين.
        fn cfg_group(&self, owner: i64, mode: GroupMode) -> TgConfig {
            TgConfig {
                group_mode: mode,
                ..self.cfg(owner)
            }
        }

        fn calls(&self) -> Vec<SeenCall> {
            self.seen.lock().unwrap_or_else(|p| p.into_inner()).clone()
        }

        fn bodies(&self, method: &str) -> Vec<String> {
            self.calls()
                .into_iter()
                .filter(|c| c.method == method)
                .map(|c| c.body)
                .collect()
        }

        fn count(&self, method: &str) -> usize {
            self.calls().iter().filter(|c| c.method == method).count()
        }

        fn clear(&self) {
            self.seen.lock().unwrap_or_else(|p| p.into_inner()).clear();
        }

        /// أجسام `sendMessage` كـJSON — للفحص بالحقل لا بالبحث النصّي.
        fn sent_messages(&self) -> Vec<Value> {
            self.bodies("sendMessage")
                .iter()
                .filter_map(|b| serde_json::from_str::<Value>(b).ok())
                .collect()
        }

        fn edited_messages(&self) -> Vec<Value> {
            self.bodies("editMessageText")
                .iter()
                .filter_map(|b| serde_json::from_str::<Value>(b).ok())
                .collect()
        }

        /// **معرّفات الرسائل التي وزّعها الخادم** على `sendMessage`، من ردوده
        /// نفسها — فلا يخمّن الاختبار رقماً متسلسلاً داخلياً.
        fn sent_message_ids(&self) -> Vec<i64> {
            self.calls()
                .iter()
                .filter(|c| c.method == "sendMessage")
                .filter_map(|c| {
                    let body = c.reply.rsplit("\r\n\r\n").next().unwrap_or(&c.reply).trim();
                    let v: Value = serde_json::from_str(body).ok()?;
                    v.pointer("/result/message_id").and_then(Value::as_i64)
                })
                .collect()
        }
    }

    impl Drop for FakeBot {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    /// قفل اختبارات الحالة العملية-الشاملة: `QUEUE_DEPTH` و`IN_FLIGHT` و`TG_JOBS`
    /// و`STATUS` مشتركة بين كل اختبارات العمليّة، و`cargo test` يشغّلها على خيوط
    /// متوازية ⇒ كل اختبار يلمسها يأخذ هذا القفل، وإلا كان «دورك: 2» رقماً عن
    /// اختبارٍ آخر لا عن الحالة المقيسة.
    fn state_lock() -> std::sync::MutexGuard<'static, ()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        let g = L.get_or_init(|| Mutex::new(())).lock();
        match g {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    /// يصفّر العدّادات — يُنادى **بعد** أخذ `state_lock` فقط. **وبوابات
    /// الرسائل معها**: بوابةٌ مجمّدة (إلغاء) من فحصٍ سابق تُسقط كتابات الفحص
    /// التالي على الرسالة نفسها، فيبدو الفحص ساقطاً لسببٍ ليس عطلاً.
    fn reset_counters() {
        QUEUE_DEPTH.store(0, Ordering::SeqCst);
        IN_FLIGHT.store(0, Ordering::SeqCst);
        reset_status_gates();
        // **ومُنظِّم المجموعة معها** (م٤): حصّة الإرسال عدّادٌ عامّ أيضاً،
        // ففحصٌ يرسل في مجموعةٍ كان يُسقط رسائل الفحص التالي بلا سبب.
        reset_send_pacer();
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hl_tg_m3_{}_{tag}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    fn file_msg(from: i64, message_id: i64, name: &str) -> Value {
        json!({
            "update_id": 100 + message_id,
            "message": {
                "message_id": message_id,
                "from": { "id": from, "first_name": "المالك" },
                "chat": { "id": from },
                "video": { "file_id": format!("F{message_id}"), "file_name": name, "file_size": 1024 }
            }
        })
    }

    fn text_msg(from: i64, message_id: i64, text: &str) -> Value {
        json!({
            "update_id": 200 + message_id,
            "message": {
                "message_id": message_id,
                "from": { "id": from, "first_name": "المالك" },
                "chat": { "id": from },
                "text": text
            }
        })
    }

    fn press(from: i64, msg_id: i64, data: &str) -> Value {
        json!({
            "update_id": 300 + msg_id,
            "callback_query": {
                "id": format!("CB{msg_id}"),
                "from": { "id": from },
                "data": data,
                "message": { "message_id": msg_id, "chat": { "id": from } }
            }
        })
    }

    /// ضغطة **في محادثةٍ بعينها** (م٤): في المجموعة `chat_id` سالب وصاحب
    /// الضغطة غيره — وهذا الفرق هو ما يقيسه ت٢.
    fn press_in(from: i64, chat_id: i64, msg_id: i64, data: &str) -> Value {
        json!({
            "update_id": 400 + msg_id,
            "callback_query": {
                "id": format!("CB{msg_id}"),
                "from": { "id": from },
                "data": data,
                "message": { "message_id": msg_id, "chat": { "id": chat_id } }
            }
        })
    }

    /// رسالة **في مجموعة**: معرّف سالب ونوع `supergroup` — فلا تُقرأ خاصة.
    fn group_msg(from: i64, chat_id: i64, message_id: i64, text: &str) -> Value {
        json!({
            "update_id": 500 + message_id,
            "message": {
                "message_id": message_id,
                "from": { "id": from, "first_name": format!("عضو{from}") },
                "chat": { "id": chat_id, "type": "supergroup" },
                "text": text
            }
        })
    }

    /// ملفٌ في مجموعة.
    fn group_file(from: i64, chat_id: i64, message_id: i64, name: &str) -> Value {
        json!({
            "update_id": 600 + message_id,
            "message": {
                "message_id": message_id,
                "from": { "id": from, "first_name": format!("عضو{from}") },
                "chat": { "id": chat_id, "type": "supergroup" },
                "video": { "file_id": format!("F{message_id}"), "file_name": name, "file_size": 1024 }
            }
        })
    }

    /// تحديث `my_chat_member` يقول إن البوت أُضيف إلى المجموعة.
    fn bot_joined(chat_id: i64, from: &str, to: &str) -> Value {
        json!({
            "update_id": 700,
            "my_chat_member": {
                "chat": { "id": chat_id, "type": "supergroup" },
                "from": { "id": 7 },
                "old_chat_member": { "status": from, "user": { "id": 99, "is_bot": true } },
                "new_chat_member": { "status": to, "user": { "id": 99, "is_bot": true } }
            }
        })
    }

    /// حالة استطلاع **في مجموعة**: هوية بوتٍ معروفة وقائمةُ سماحٍ صريحة.
    /// (بلا هويةٍ لا يُعرَف منشن — وهو سلوكٌ مقصود لا سهو.)
    fn group_poll(username: &str, bot_id: i64, allowed: &[(i64, i64)]) -> PollState {
        let mut poll = PollState {
            identity: BotIdentity {
                id: bot_id,
                username: username.to_string(),
            },
            ..Default::default()
        };
        for (chat, user) in allowed {
            poll.access.allow(*chat, *user);
        }
        poll
    }

    /// رسائل أُرسلت إلى محادثةٍ بعينها.
    fn sent_to(bot: &FakeBot, chat_id: i64) -> Vec<Value> {
        bot.sent_messages()
            .into_iter()
            .filter(|m| m.get("chat_id").and_then(Value::as_i64) == Some(chat_id))
            .collect()
    }

    /// أجوبة `answerCallbackQuery` النصّية.
    fn callback_answers(bot: &FakeBot) -> Vec<String> {
        bot.bodies("answerCallbackQuery")
            .iter()
            .filter_map(|b| serde_json::from_str::<Value>(b).ok())
            .filter_map(|v| v.get("text").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    /// معرّفات الرسائل التي وزّعها الخادم على إرسالاتٍ إلى محادثةٍ بعينها —
    /// من **الردود** لا من الطلبات (فطلب `sendMessage` لا يحمل `message_id`).
    fn sent_message_ids_to(bot: &FakeBot, chat_id: i64) -> Vec<i64> {
        bot.calls()
            .into_iter()
            .filter(|c| c.method == "sendMessage")
            .filter(|c| {
                serde_json::from_str::<Value>(&c.body)
                    .ok()
                    .and_then(|v| v.get("chat_id").and_then(Value::as_i64))
                    == Some(chat_id)
            })
            .filter_map(|c| {
                let body = c.reply.rsplit("\r\n\r\n").next().unwrap_or(&c.reply).trim();
                serde_json::from_str::<Value>(body)
                    .ok()?
                    .pointer("/result/message_id")
                    .and_then(Value::as_i64)
            })
            .collect()
    }

    /// رسائل `sendMessage` التي تحمل أزرار اختيار الوضع (‏`mode:`).
    fn mode_questions_to(bot: &FakeBot, chat_id: i64) -> Vec<Value> {
        sent_to(bot, chat_id)
            .into_iter()
            .filter(|m| {
                m.pointer("/reply_markup/inline_keyboard")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter().any(|r| {
                            r.as_array().cloned().unwrap_or_default().iter().any(|b| {
                                b.get("callback_data")
                                    .and_then(Value::as_str)
                                    .map(|d| d.starts_with("mode:"))
                                    .unwrap_or(false)
                            })
                        })
                    })
                    .unwrap_or(false)
            })
            .collect()
    }

    /// رموز الملفات كما وردت **فعلاً** في أزرار الرسائل المُرسَلة (لا من حالة
    /// داخلية) — فالقياس على ما يراه المستخدم. **ورمز واحد لكل ملف**: زرّا
    /// «أغنية» و«مقطع عادي» يحملان الرمز نفسه، فيُطوى المكرّر.
    fn mode_tokens(bot: &FakeBot) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for m in bot.sent_messages() {
            let rows = m
                .pointer("/reply_markup/inline_keyboard")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for row in rows {
                for btn in row.as_array().cloned().unwrap_or_default() {
                    if let Some(d) = btn.get("callback_data").and_then(Value::as_str) {
                        if let Some((token, _)) = parse_mode_action(d) {
                            if !out.contains(&token) {
                                out.push(token);
                            }
                        }
                    }
                }
            }
        }
        out
    }

    /// نصوص `sendMessage` المُرسَلة.
    fn sent_texts(bot: &FakeBot) -> Vec<String> {
        bot.sent_messages()
            .iter()
            .filter_map(|m| m.get("text").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    fn new_oversize_store() -> Arc<Mutex<OversizeStore>> {
        Arc::new(Mutex::new(OversizeStore::default()))
    }

    /// حارس على الأداة نفسها: الخادم الوهمي **يقرأ الطلب** فعلاً ويسجّله. بغير
    /// هذا الحارس كان كل قياسٍ لاحقٍ «صفر طلبات» — وهو ما يبدو كنجاحٍ صامت.
    #[test]
    fn the_fake_bot_actually_records_what_it_receives() {
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        assert_eq!(
            call(&cfg, "getMe", &json!({}), Duration::from_secs(5)),
            Ok(json!(true))
        );
        let calls = bot.calls();
        assert_eq!(calls.len(), 1, "الخادم الوهمي لم يسجّل الطلب");
        assert_eq!(calls[0].method, "getMe", "اسم الدوال مقروء من المسار");
    }

    /// **وحارسٌ ثانٍ على الأداة** (م٣/إصلاح): القياس المطلوب في عطل السباق هو
    /// **زمن وصول كل تعديل وترتيبه**، فالخادم يجب أن يسجّل الطلبات بترتيب
    /// وصولها وأن تكون أزمنتها غير متناقصة — وإلا كان «الترتيب» المُقاس وهماً.
    #[test]
    fn the_fake_bot_records_arrival_order_and_time() {
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        for i in 0..3 {
            let _ = edit_message_kb(&cfg, 7, 1001 + i, &format!("ن{i}"), Some(no_keyboard()));
        }
        let calls = bot.calls();
        assert_eq!(calls.len(), 3, "لم تُسجَّل التعديلات الثلاثة: {calls:?}");
        let bodies: Vec<String> = calls.iter().map(|c| c.body.clone()).collect();
        for i in 0..3 {
            assert!(
                bodies[i].contains(&format!("ن{i}")),
                "ترتيب التسجيل ليس ترتيب الوصول: {bodies:?}"
            );
        }
        assert!(
            calls.windows(2).all(|w| w[1].at_ms >= w[0].at_ms),
            "أزمنة الوصول متناقصة: {:?}",
            calls.iter().map(|c| c.at_ms).collect::<Vec<_>>()
        );
    }

    /// حالة استطلاع فارغة — للاختبارات التي لا تقرأ المعلَّقات.
    fn poll_state() -> PollState {
        PollState::default()
    }

    /// قناة مهامّ: يُعاد **الطرفان** حتى يبقى المستقبِل حيّاً (مستقبِلٌ يُسقَط
    /// فوراً يجعل كل `send` فاشلاً فيتغيّر المسار المقيس).
    fn chan() -> (Sender<Job>, Receiver<Job>) {
        mpsc::channel()
    }

    #[test]
    fn pairing_gate_blocks_everyone_until_the_owner_is_set() {
        let mut cfg = TgConfig {
            token: "t".into(),
            owner_id: None,
            audio_only: false,
            local_url: None,
            group_mode: GroupMode::Mentions,
        };
        assert!(!cfg.allows(12345), "no id configured ⇒ nobody is allowed");
        cfg.owner_id = Some(12345);
        assert!(cfg.allows(12345));
        assert!(!cfg.allows(999), "another user must never be processed");
    }

    #[test]
    fn local_url_is_normalised_and_switches_the_transport() {
        let s = Settings {
            telegram_token: " 123:abc ".into(),
            telegram_local_url: "127.0.0.1:8081/".into(),
            ..Default::default()
        };
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
        assert_eq!(
            plan_delivery(small, 180.0, true, false, false),
            Delivery::Video
        );
        assert_eq!(
            plan_delivery(big, 180.0, true, false, false),
            Delivery::VideoShrunk {
                target_kbps: crate::media::target_video_kbps(180.0, CLOUD_TARGET_MB, AUDIO_KBPS)
            }
        );
        // An hour cannot fit ⇒ audio, and the same for the audio-only pref.
        assert_eq!(
            plan_delivery(big, 3600.0, true, false, false),
            Delivery::Audio
        );
        assert_eq!(
            plan_delivery(small, 180.0, true, true, false),
            Delivery::Audio
        );
        // No video stream at all ⇒ audio.
        assert_eq!(
            plan_delivery(small, 180.0, false, false, false),
            Delivery::Audio
        );
        // Local server ⇒ never shrink, never fall back.
        assert_eq!(
            plan_delivery(big, 3600.0, true, false, true),
            Delivery::Video
        );
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
        assert_eq!(
            find_url("http://a.io/x?y=1&z=2, ok"),
            Some("http://a.io/x?y=1&z=2,".to_string())
        );
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
            Incoming::Job(Source::File {
                file_id: "AAA".into(),
                name: "song.mp4".into(),
                size: 1234
            })
        );

        let link =
            json!({ "from": { "id": 5 }, "chat": { "id": 5 }, "text": "https://youtu.be/x" });
        assert!(matches!(
            parse_message(&link).unwrap().2,
            Incoming::Job(Source::Link(_))
        ));

        let hi = json!({ "from": { "id": 5 }, "chat": { "id": 5 }, "text": "/start" });
        assert!(matches!(
            parse_message(&hi).unwrap().2,
            Incoming::Smalltalk(_)
        ));
    }

    #[test]
    fn tokens_are_redacted_from_any_outgoing_text() {
        let cfg = TgConfig {
            token: "88360566:AAH_supersecret_part".into(),
            owner_id: Some(7),
            audio_only: false,
            local_url: None,
            group_mode: GroupMode::Mentions,
        };
        // The exact shape ureq produces: URL first, then the reason.
        let leaky = format!(
            "https://api.telegram.org/bot{}/getUpdates: Connection Failed",
            cfg.token
        );
        let safe = redact(&cfg.token, leaky);
        assert!(
            !safe.contains("AAH_supersecret_part"),
            "token survived: {safe}"
        );
        assert!(safe.contains("محجوب"));
        assert!(
            safe.starts_with("https://api.telegram.org/bot<"),
            "context kept: {safe}"
        );
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
        assert!(
            !mine.exists(),
            "a tracked transient must be gone after the job"
        );
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
        // **حدّ أمانة**: هذا السطر «رمي عملة» باحتمال فشل كاذب **10⁻⁶** لكل
        // تشغيل (تطابق رمزين من فضاء 10⁶) — دون حدّ 10⁻¹² المطلوب. لم أغيّره
        // لأن الغرض هنا «الرمز يعمل مرّة واحدة» لا إثبات تنوّع المولّد: فحص
        // التنوّع صار في `pairing_codes_are_not_a_fixed_or_small_pool`، وهو
        // الذي يقيس الأثر بعتبة محسوبة (7.6e-38).
        assert_ne!(first, second, "a regenerated code must differ");

        // 2. Non-code chatter is not an attempt (strangers must not burn it).
        assert!(matches!(check_pairing_code("مرحبا"), PairTry::NotAnAttempt));
        assert!(matches!(check_pairing_code(""), PairTry::NotAnAttempt));

        // 3. Guessing is budgeted, and the budget ends the code's life.
        let wrong = if second == "000000" {
            "000001"
        } else {
            "000000"
        };
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

    /// و-٧ — الشكل: الرمز أرقام عشرية فقط، وبالطول المطلوب (`PAIR_DIGITS`).
    #[test]
    fn pairing_codes_are_digits_of_the_exact_length() {
        for digits in [1usize, 4, PAIR_DIGITS, 12] {
            let code = random_code(digits);
            assert_eq!(code.chars().count(), digits, "طول الرمز خاطئ: {code}");
            assert!(
                code.chars().all(|c| c.is_ascii_digit()),
                "الرمز يحوي غير رقم: {code}"
            );
        }
        // الطول صفر لا ينفجر (ولا يعلّق في حلقة التوليد).
        assert_eq!(random_code(0), "");
    }

    /// و-٧ — **مسبار الركود**: المولّد لا يعطي رموزاً ثابتة ولا محبوساً في
    /// بركة صغيرة، على أثر **يُقاس كل تشغيل**.
    ///
    /// **ولماذا تغيّر المسبار** (كان `..._never_repeat` ويشترط أن الـ٢٠٠ رمز
    /// كلها مختلفة): شرط «لا تكرار إطلاقاً» في سحب من فضاء 10⁶ **رميُ عملة**،
    /// لا حارس. فاحتمال وقوع تصادم واحد على الأقل = `1 - exp(-λ)` بـ
    /// `λ = n(n-1)/2N = 0.0199` ⇒ **1.9703%** لكل تشغيل، والقياس يؤكّده:
    /// **4 إخفاقات في 300 تشغيل (1.33%)** على الثنائي المبنيّ من هذا الملف
    /// (والمدقّق قاس 1.67% برسالة «رمز مكرَّر عند المحاولة 170»). فـ«cargo
    /// test أخضر» لم يكن قابلاً لإعادة الإنتاج، وهي بوابة يعتمد عليها ما بعدها.
    ///
    /// **والمقصود المعلَن** كان: «يسقط فوراً لو عاد المولّد ثابتاً أو حبيس
    /// بركة ضيقة». وهذا يقيسه عدد **العناصر المتمايزة** لا شرط «لا تكرار»:
    /// مولّد ثابت ⇒ متمايز = **1**، ومولّد محبوس في ٥ قيم ⇒ متمايز **≤ 5**،
    /// والثلاثة كلها دون أي عتبة معقولة.
    ///
    /// **حساب العتبة** (لا تخمين)، على توزيع التصادمات لا تقريب:
    ///   • `E[متمايز] = N·(1-(1-1/N)^n) = 199.980101` و`sd = 0.205218`.
    ///   • `P(متمايز ≤ 190) = P(تصادمات ≥ 10) = 7.6e-38` (تكرار ستيرلنغ الدقيق
    ///     في `ARCHIVE/birthday-calc3.cjs`؛ وبواسون بنفس λ: `2.6e-24`) ⇒
    ///     احتمال الفشل الكاذب **أصغر من 10⁻¹² بكثير**، والعتبة **190**
    ///     تفصل بينه وبين ما يمسكه المُفسَد فصلاً واسعاً (5 ⇒ 48 sd).
    #[test]
    fn pairing_codes_are_not_a_fixed_or_small_pool() {
        // عيّنة كبيرة عن قصد: العتبة تُحكم باحتمال فشل كاذب ضئيل جبراً.
        const DRAWS: usize = 200;
        // انظر حساب العتبة في توثيق الاختبار أعلاه (7.6e-38 فشل كاذب).
        const MIN_DISTINCT: usize = 190;
        let mut seen = std::collections::HashSet::with_capacity(DRAWS);
        for _ in 0..DRAWS {
            seen.insert(random_code(PAIR_DIGITS));
        }
        assert!(
            seen.len() >= MIN_DISTINCT,
            "المولّد راكد: {} رمزاً متمايزاً من {DRAWS} سحباً (العتبة {MIN_DISTINCT}) — \
             عيّنة من الرموز: {:?}",
            seen.len(),
            seen.iter().take(8).collect::<Vec<_>>()
        );
    }

    /// و-٧ — توزيع الأرقام: ١٢٠٠ رقم مولَّد تستعمل كل الأرقام العشرة. يسقط
    /// لو رجع المولّد إلى بذرة شبه ثابتة أو انحاز إلى أرقام بعينها.
    #[test]
    fn generated_digits_cover_the_whole_alphabet() {
        let mut counts = [0usize; 10];
        for _ in 0..200 {
            for c in random_code(PAIR_DIGITS).chars() {
                counts[c.to_digit(10).unwrap() as usize] += 1;
            }
        }
        for (digit, n) in counts.iter().enumerate() {
            assert!(*n > 0, "الرقم {digit} لم يظهر إطلاقاً في 1200 رقم");
        }
        let total: usize = counts.iter().sum();
        assert_eq!(total, 200 * PAIR_DIGITS);
        // لا رقم يسيطر: أسوأ حالة مسموحة 3× المتوسط (فحص خشن لا chi-square
        // حتى لا يصير الاختبار متذبذباً — التوزيع الدقيق ليس Claim هنا).
        let mean = (total / 10) as f64;
        for (digit, n) in counts.iter().enumerate() {
            assert!(
                (*n as f64) < mean * 3.0,
                "الرقم {digit} منحاز: {n} من {total}"
            );
        }
    }

    /// و-٧ — **فحص نصّي** (لا طريقة سلوكية تميّز مولّداً من `RandomState` عن
    /// مولّد نظام، فالاثنان يعطيان رقماً يبدو عشوائياً). يحرس ضد رجوع
    /// `RandomState`/SplitMix64 إلى دالة التوليد.
    #[test]
    fn the_pairing_code_generator_no_longer_uses_randomstate() {
        let src = include_str!("telegram.rs");
        // نقتصر على جسم `random_code` وحده حتى لا يُحسب استعمالٌ آخر مشروع.
        let start = src
            .find("fn random_code(digits: usize) -> String {")
            .expect("random_code must exist");
        let body = &src[start..];
        let end = body.find("\n}\n").expect("random_code must end");
        let body = &body[..end];

        for banned in [
            "RandomState",
            "SplitMix64",
            "BuildHasher",
            "build_hasher",
            "nanos()",
        ] {
            assert!(
                !body.contains(banned),
                "مولّد الرمز رجع إلى {banned} (و-٧ يمنع ذلك):\n{body}"
            );
        }
        assert!(
            body.contains("getrandom"),
            "مولّد الرمز يجب أن يستعمل getrandom:\n{body}"
        );
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
            assert!(
                finished.load(Ordering::SeqCst),
                "the child must finish once status is free"
            );
            if parked_on_status && holds_pair_slot {
                pair_slot_taken_first = true;
                break;
            }
        }
        assert!(
            pair_slot_taken_first,
            "status_json must take pair_slot BEFORE status (٤.ب.٩)"
        );
    }

    #[test]
    fn network_filenames_cannot_escape_the_scratch_dir() {
        assert_eq!(sanitize_name("../../evil.exe"), "evil.exe");
        assert_eq!(sanitize_name("C:\\Windows\\system32\\cmd.exe"), "cmd.exe");
        assert_eq!(
            sanitize_name("song (official) [4K].mp4"),
            "song__official___4K_.mp4"
        );
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
                let body_start = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4);
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
        let expect_len = body.head.len() as u64 + 1024 + body.tail.len() as u64;
        let f = std::fs::File::open(&tmp).unwrap();

        let url = format!("http://{addr}/botTEST/sendVideo");
        let _ = post_file(&url, &body, f, 1024, Duration::from_secs(10), "TEST");
        let head = server.join().unwrap();

        let lower = head.to_ascii_lowercase();
        assert!(
            lower.starts_with("post /bottest/sendvideo http/1.1"),
            "got: {head}"
        );
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

    /// **صياغة الإلغاء لا تكذب (م٢/إصلاح)**: الجواب الصادق يذكر **أطول ما قيس**
    /// ورقمه، **ولا يقول «فوراً»** عن نداء المحرّك ولا يعِد بسقف مطلق.
    ///
    /// (وسابقة مُصلَحة: كان الجواب يَعِد بسقف مطلق «خلال ١٥٠ ث» — وعدٌ أقصر
    /// من الواقع ٣.٨× — والآن يقول «أطول ما قيس» ورقمه.)
    ///
    /// **والنصّ بحسب المرحلة (م٣/إصلاح)**: كان نصّاً واحداً يذكر سقف نداء المحرّك
    /// (٩.٤ دقيقة) **حتى في مرحلة التنزيل**، والمدقّق قاس الإلغاء هناك **٣.٦ ث**
    /// فعلية ⇒ وعدٌ أطول من الواقع بعشرات المرات في أكثر الحالات وقوعاً.
    #[test]
    fn the_cancel_reply_states_the_measured_worst_case_and_never_promises_instant() {
        use crate::slots::JobPhase;
        assert_eq!(
            cancel_reply(true, JobPhase::Preparing),
            "🛑 أُلغيت",
            "الفراغ = إلغاء وقع فعلاً"
        );
        assert_eq!(
            cancel_reply(true, JobPhase::Processing),
            "🛑 أُلغيت",
            "وجواب الفراغ واحد لا يختلف بالمرحلة"
        );
        let pending = cancel_reply(false, JobPhase::Processing);
        let secs = crate::pipeline::ENGINE_CALL_CEILING_SECS;
        assert!(
            pending.contains(&secs.to_string()),
            "الرقم المقيس مذكور في الجواب: {pending}"
        );
        assert!(
            pending.contains("أطول ما قيس"),
            "التوصيف «أطول ما قيس» لا وعداً: {pending}"
        );
        assert!(
            pending.contains("والغالب أقلّ بكثير"),
            "ويُقال إن الغالب أقلّ بكثير: {pending}"
        );
        assert!(
            !pending.contains("فوراً"),
            "لا «فوراً» عن نداء المحرّك: {pending}"
        );
        assert!(!pending.contains('≤'), "لا سقف مطلق في الجواب: {pending}");

        // **ومرحلة التحضير تقول مرحلتها ورقمها المقيس** — لا رقم نداء المحرّك.
        let prep = cancel_reply(false, JobPhase::Preparing);
        assert!(
            prep.contains("مرحلة التحضير"),
            "المرحلة مذكورة صراحةً: {prep}"
        );
        assert!(
            prep.contains(&format!("{CANCEL_PREPARE_WORST_SECS:.1}")),
            "رقم المرحلة المقيس مذكور: {prep}"
        );
        assert!(
            !prep.contains(&secs.to_string()),
            "رقم نداء المحرّك لا يُقال عن التنزيل (كان العطل): {prep}"
        );
        assert_ne!(prep, pending, "نصّان لحالتين — لا نصّ واحد يوحّدهما");
        // ومرحلة المعالجة تقول مرحلتها، وتذكر انتظار الفتحة الذي لا يُقطع أيضاً.
        assert!(
            pending.contains("مرحلة المعالجة"),
            "المرحلة مذكورة صراحةً: {pending}"
        );
        assert!(
            pending.contains(&format!(
                "{} دقيقة",
                crate::slots::DEFAULT_WAIT.as_secs() / 60
            )),
            "انتظار فتحة الجهاز مذكور بمدّته من ثابته: {pending}"
        );
        assert!(
            !pending.contains(&format!("{CANCEL_PREPARE_WORST_SECS:.1} ث")),
            "رقم التحضير لا يُقال عن المعالجة: {pending}"
        );
    }

    /// **حجب خيط تحديثات البوت محدود (م٢/إصلاح)**: كان الانتظار ٢٠ ث لكل
    /// `/kill` على خيط التحديثات (فتُحجب أوامر المحادثة كلها). والحدّ الآن قصير،
    /// والقياس **السلوكي** في
    /// `slots::tests::a_kill_command_does_not_block_the_bot_thread_for_long`.
    #[test]
    fn the_cancel_confirmation_wait_is_short() {
        assert!(
            CANCEL_CONFIRM_WAIT <= Duration::from_secs(3),
            "انتظار /kill يحجب خيط البوت: {CANCEL_CONFIRM_WAIT:?}"
        );
        assert!(
            CANCEL_CONFIRM_WAIT >= Duration::from_millis(500),
            "وانتظار بلا معنى لا يكفي الحالة الغالبة: {CANCEL_CONFIRM_WAIT:?}"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  م٣/إصلاح — المهمّة مسجَّلة **قبل** عملها التحضيري (فيصدق الزرّ)
    // ═══════════════════════════════════════════════════════════════════════

    /// **العطل**: كان التسجيل يقع عند `run_separation` وحدها، فطوال التنزيل/
    /// الاستلام لا مهمّة في السِجلّ ⇒ زرّ الإلغاء و`/kill` يردّان «لا مهمّة
    /// جارية» **وهما ظاهران**.
    ///
    /// **القياس السلوكي**: `run_job` على خيط، والخادم الوهمي يُبطئ `getFile`،
    /// وأثناء تلك النافذة نقرأ سِجلّ المهامّ **الحقيقي** ونجرّب الإلغاء عبر
    /// `cancel_chat_jobs` (نفس ما يناديه الزرّ و`/kill` حرفاً).
    #[test]
    fn the_job_is_registered_and_cancellable_while_the_file_is_still_arriving() {
        // السِجلّ العامّ واحد للعملية: نفس القفل الذي تتسلسل عليه اختبارات
        // `slots` — وإلا صار قياسها تابعاً لترتيب الخيوط (وقع فعلاً).
        let _reg = crate::slots::registry_test_lock();
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let ov = new_oversize_store();
        let job = Job {
            chat_id: 7,
            user_id: 7,
            user: "المالك".into(),
            source: Source::File {
                file_id: "F12".into(),
                name: "second.mp4".into(),
                size: 0,
            },
            mode: Mode::Song,
            src_msg_id: 12,
            status_msg_id: 1001,
            file: "second.mp4".into(),
            row_id: jobs_arrived(7, "المالك", "second.mp4"),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let cfg = cfg.clone();
            let ov = ov.clone();
            let stop = stop.clone();
            std::thread::spawn(move || run_job(&cfg, job, &stop, &ov, None))
        };

        // ننتظر ظهور المهمّة في السِجلّ العام (‏`slots::active_jobs`) ثم نحكم.
        let mut live = false;
        for _ in 0..300 {
            if slots::active_jobs()
                .iter()
                .any(|j| j.label == job_label(7, 7))
            {
                live = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            live,
            "المهمّة ليست في السِجلّ أثناء الاستلام — الزرّ و/kill يكذبان الآن"
        );
        // والمسارات في السِجلّ لم تُعرف بعد ⇒ None صادق لا مخترع.
        let entry = slots::active_jobs();
        let mine = entry.iter().find(|j| j.label == job_label(7, 7)).unwrap();
        assert!(mine.path.is_none(), "مسار مخترع قبل التنزيل: {mine:?}");

        // **والزرّ يعمل فعلاً**: نفس الدالّة التي يناديها الزرّ و`/kill`.
        let reply = cancel_chat_jobs(7, 7);
        assert_ne!(
            reply, "لا مهمّة جارية",
            "الإلغاء أثناء الاستلام لم يجد المهمّة (العطل الأصلي)"
        );

        let _ = worker.join();
        // **ومهمّة أُلغيَت لا تُوصَف بفشل (م٣/إصلاح)** — قياسٌ من الطرفين على
        // المسار الحقيقي: رسالة الحالة آخرُ ما كُتب عليها **نصّ إلغاء**، ولا
        // نصَّ فشل بعد الإلغاء (كان يصل «✗ فشلت المعالجة: أُلغيت المعالجة»
        // بعد «🛑 أُلغيت» فيمحو أثره).
        let status_texts = edit_texts_on(&bot, 1001);
        assert!(!status_texts.is_empty(), "لا تعديل على رسالة الحالة");
        assert_eq!(
            status_texts.last().map(String::as_str),
            Some(CANCELLED_TEXT),
            "آخر ما على رسالة الحالة لمهمّة أُلغيت: {status_texts:?}"
        );
        assert!(
            status_texts.iter().all(|t| !t.contains('✗')),
            "نصّ فشل على مهمّة أُلغيت بأمر المالك: {status_texts:?}"
        );

        // وبعد الانتهاء لا تبقى مهمّة معلّقة في السِجلّ.
        assert!(
            !slots::active_jobs()
                .iter()
                .any(|j| j.label == job_label(7, 7)),
            "تسريب تسجيل بعد انتهاء المهمّة"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  عطل ميداني — زرّ الإلغاء يختفي بعد أول تعديل (بلاغ المالك)
    // ═══════════════════════════════════════════════════════════════════════

    /// **العَرَض**: «زر الإلغاء يظهر في تلغرام لثانية واحدة أو أقل ثم يختفي».
    ///
    /// **السبب المقيس**: رسالة الحالة تُنشأ بالزر، ثم **أول تعديل** لها كان
    /// يمرّ بلا `reply_markup` — وتلغرام يحذف لوحة الأزرار عند تعديلٍ لا لوحة
    /// فيه. ومسار الملف يحرّر تحريرين قسريّين (`📥 جارٍ استلام الملف…` ثم
    /// `✗ …`) قبل أن يمضي ثانياً ⇒ الزر يُمحى فوراً، لا بعد دقيقة.
    ///
    /// **القياس**: كل تعديلات المهمّة وهي جارية تحمل زرّ الإلغاء، والتعديل
    /// **النهائي** يحمل `inline_keyboard` **فارغة صراحةً**.
    #[test]
    fn the_cancel_button_survives_every_update_and_is_removed_explicitly_at_the_end() {
        let _reg = crate::slots::registry_test_lock();
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let ov = new_oversize_store();
        let job = Job {
            chat_id: 7,
            user_id: 7,
            user: "المالك".into(),
            source: Source::File {
                file_id: "F12".into(),
                name: "second.mp4".into(),
                size: 0,
            },
            mode: Mode::Song,
            src_msg_id: 12,
            status_msg_id: 1001,
            file: "second.mp4".into(),
            row_id: jobs_arrived(7, "المالك", "second.mp4"),
        };
        let stop = Arc::new(AtomicBool::new(false));
        run_job(&cfg, job, &stop, &ov, None);

        let edits = bot.edited_messages();
        assert!(
            edits.len() >= 3,
            "المسار يحرّر ثلاث مرات على الأقل (بدء · استلام · خروج): {edits:?}"
        );
        for e in &edits[..edits.len() - 1] {
            assert_eq!(
                e.pointer("/reply_markup/inline_keyboard/0/0/callback_data")
                    .and_then(Value::as_str),
                Some("cancel:7:7"),
                "تعديل أثناء العمل بلا زرّ إلغاء ⇒ الزر يختفي في تلغرام: {e}"
            );
        }
        let last = edits.last().unwrap();
        assert_eq!(
            last.pointer("/reply_markup/inline_keyboard"),
            Some(&json!([])),
            "التعديل النهائي يجب أن يمرّر لوحة فارغة صراحةً: {last}"
        );
        assert!(
            last["text"].as_str().unwrap_or("").starts_with('✗'),
            "والتعديل الأخير هو الخروج: {last}"
        );
        // ولا تعديل واحد بلا `reply_markup` إطلاقاً — هذا هو الحارس الحقيقي:
        // أي تعديل يُسقط الحقل يمحو اللوحة في تلغرام.
        for e in &edits {
            assert!(
                e.get("reply_markup").is_some(),
                "تعديل بلا لوحة يحذف أزرار الرسالة في تلغرام: {e}"
            );
        }
    }

    /// والضغطة على الزرّ القديم بعد انتهاء المهمّة تبقى صادقة (سلوك م٢ محفوظ).
    #[test]
    fn a_stale_cancel_press_still_answers_honestly_and_is_explicit() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let ov = new_oversize_store();
        let (tx, _rx) = chan();
        handle_update(
            &cfg,
            &mut poll_state(),
            &ov,
            &press(7, 1001, "cancel:7:7"),
            &tx,
        );
        let answers: Vec<String> = bot
            .bodies("answerCallbackQuery")
            .iter()
            .filter_map(|b| serde_json::from_str::<Value>(b).ok())
            .filter_map(|v| v.get("text").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert_eq!(answers, vec!["لا مهمّة جارية".to_string()]);
        let edits = bot.edited_messages();
        assert_eq!(
            edits[0].pointer("/reply_markup/inline_keyboard"),
            Some(&json!([])),
            "الإزالة صريحة لا ضمنية: {edits:?}"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  م٣/١ — **معلَّق لكل ملف** لا لكل محادثة
    // ═══════════════════════════════════════════════════════════════════════

    /// **العطل المقيس**: `HashMap<chat_id, Pending>` كان يسحق ملفاً بملف.
    /// وهذا الاختبار يقيس الأثر لا الشكل: ملفان قبل أي اختيار ⇒ **الاثنان
    /// موجودان**، واختيار الأول **لا يُلغي** الثاني، والمهمّتان تصلان القناة.
    #[test]
    fn two_files_waiting_together_are_both_kept_and_one_choice_never_drops_the_other() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, rx) = mpsc::channel::<Job>();

        handle_update(&cfg, &mut poll, &ov, &file_msg(7, 11, "first.mp4"), &tx);
        handle_update(&cfg, &mut poll, &ov, &file_msg(7, 12, "second.mp4"), &tx);
        assert_eq!(
            poll.pending.count_for(7),
            2,
            "وصول ملفٍ ثانٍ أسحق الأول (عطل البيانات المقيس)"
        );
        let tokens = mode_tokens(&bot);
        assert_eq!(tokens.len(), 2, "لكل ملف رمزُه: {tokens:?}");
        assert_ne!(tokens[0], tokens[1], "رموز الملفين يجب أن تتمايز");

        // اختيار الأول: يخرج هو وحده.
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &press(7, 1001, &format!("mode:song:{}", tokens[0])),
            &tx,
        );
        assert_eq!(poll.pending.count_for(7), 1, "اختيار الأول ألغى الثاني");
        // والثاني ما زال قابلاً للاختيار برمزه.
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &press(7, 1002, &format!("mode:clip:{}", tokens[1])),
            &tx,
        );
        assert_eq!(poll.pending.count_for(7), 0);
        let jobs: Vec<Job> = rx.try_iter().collect();
        assert_eq!(jobs.len(), 2, "ملفٌ ضاع في الطريق إلى القناة");
        assert_eq!(jobs[0].file, "first.mp4");
        assert_eq!(jobs[1].file, "second.mp4");
        assert_eq!(jobs[0].mode, Mode::Song);
        assert_eq!(jobs[1].mode, Mode::Clip);
    }

    /// **حدّ أعلى صريح**: بلوغه يُرفض به **رسالة صادقة قابلة للتنفيذ**، ولا
    /// يُسقط معلَّقاً قائماً ولا ينمو بلا سقف.
    #[test]
    fn the_pending_list_has_an_explicit_cap_with_an_honest_message() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, _rx) = mpsc::channel::<Job>();

        for i in 0..MAX_PENDING_PER_CHAT {
            handle_update(
                &cfg,
                &mut poll,
                &ov,
                &file_msg(7, 100 + i as i64, &format!("f{i}.mp4")),
                &tx,
            );
        }
        assert_eq!(poll.pending.count_for(7), MAX_PENDING_PER_CHAT);
        bot.clear();
        // الملف رقم MAX+1: لا سؤال، بل رسالة الحدّ.
        handle_update(&cfg, &mut poll, &ov, &file_msg(7, 900, "extra.mp4"), &tx);
        assert_eq!(
            poll.pending.count_for(7),
            MAX_PENDING_PER_CHAT,
            "نما السِجلّ فوق السقف"
        );
        assert_eq!(bot.count("sendMessage"), 1, "لم تُرسَل رسالة الحدّ وحدها");
        let sent = bot.sent_messages();
        let text = sent[0].get("text").and_then(Value::as_str).unwrap_or("");
        assert!(text.contains("أكمل الملفات الحالية أولاً"), "النصّ: {text}");
        assert!(
            text.contains(&MAX_PENDING_PER_CHAT.to_string()),
            "الرسالة تذكر الحدّ: {text}"
        );
        assert!(
            sent[0].get("reply_markup").is_none(),
            "لا أزرار لملفٍ لم يُقبل: {sent:?}"
        );
    }

    /// السِجلّ **لا يُسقط شيئاً أبداً**: الإدراج فوق السقف يعيد `false` ويترك
    /// القائم كما هو. (نقيّ — بلا شبكة.)
    #[test]
    fn the_pending_insert_never_evicts_an_existing_entry() {
        let mut store = PendingStore::default();
        let mk = |token: &str| Pending {
            chat_id: 5,
            user_id: 5,
            user: "عضو5".into(),
            token: token.into(),
            source: Source::Link(format!("https://x/{token}")),
            src_msg_id: 1,
            ask_msg_id: Arc::new(AtomicI64::new(900)),
            file: format!("{token}.mp4"),
            row_id: 1,
        };
        for i in 0..MAX_PENDING_PER_CHAT {
            assert!(store.insert(mk(&format!("t{i}"))), "إدراج داخل السقف");
        }
        assert!(!store.insert(mk("overflow")), "السقف يجب أن يردّ");
        assert_eq!(store.count_for(5), MAX_PENDING_PER_CHAT);
        assert_eq!(
            store.len(),
            MAX_PENDING_PER_CHAT,
            "المجموع = مجموع المحادثة"
        );
        assert!(store.take(5, "t0").is_some(), "الأول ما زال محفوظاً");
        assert!(store.take(5, "overflow").is_none(), "لم يُدرَج");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  م٣/٢ — إشعار قائمة الانتظار **عند الوصول**
    // ═══════════════════════════════════════════════════════════════════════

    /// **الشكوى**: «لا يخبرني أنه في قائمة الانتظار» — كان الإشعار يُرسَل عند
    /// الضغط على الزرّ فقط. والقياس: ملف يصل ومهمّة جارية (عدّاد حقيقي، لا حقل
    /// مزروع) ⇒ **رسالة الوصول نفسها** تحمل «⏳ في قائمة الانتظار — دورك: 2».
    #[test]
    fn the_wait_notice_arrives_with_the_second_file_not_on_the_button_press() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, _rx) = mpsc::channel::<Job>();

        // مهمّة جارية فعلاً (نفس العدّاد الذي تعدّه المهامّ الحقيقية).
        let running = InFlightGuard::enter();
        // مهمّة ثانية تنتظر في القناة.
        QUEUE_DEPTH.fetch_add(1, Ordering::SeqCst);

        handle_update(&cfg, &mut poll, &ov, &file_msg(7, 31, "second.mp4"), &tx);

        let text = &sent_texts(&bot)[0];
        assert!(
            text.contains("⏳ في قائمة الانتظار"),
            "الإشعار يجب أن يأتي عند الوصول: {text}"
        );
        assert!(
            text.contains("دورك: 3"),
            "الدور من الطابور الفعلي (جارية 1 + منتظرة 1 + هذه): {text}"
        );
        assert!(
            !text.contains("طابور"),
            "المصطلح المعتمد «قائمة الانتظار» لا «طابور»: {text}"
        );
        assert!(
            text.contains("reply_markup") || bot.sent_messages()[0].get("reply_markup").is_some(),
            "أزرار الوضع تُرسَل مع الإشعار نفسه"
        );
        drop(running);
        dec(&QUEUE_DEPTH);
    }

    /// ولا إشعار انتظار حين لا يسبق الملفَ شيء: الرسالة تقول السؤال وحده.
    /// (مُفسَد محروس: ذِكر «قائمة الانتظار» دائماً.)
    #[test]
    fn no_wait_notice_when_nothing_is_ahead() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, _rx) = mpsc::channel::<Job>();
        handle_update(&cfg, &mut poll, &ov, &file_msg(7, 41, "only.mp4"), &tx);
        let text = &sent_texts(&bot)[0];
        assert!(!text.contains("قائمة الانتظار"), "لا انتظار بلا سابق: {text}");
        assert!(text.contains("هل هذا أغنية"), "السؤال قائم: {text}");
    }

    /// **«ثم حرّرها لمّا يبدأ الدور»**: رسالة الوضع تصير رسالة الحالة، وتُحرَّر
    /// إلى «▶ بدأت المعالجة» لحظة دخول المهمّة التنفيذ — **ولا رسالة جديدة**.
    #[test]
    fn the_wait_notice_is_edited_to_started_processing_when_the_turn_comes() {
        let _reg = crate::slots::registry_test_lock();
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let ov = new_oversize_store();
        // رسالة السؤال الحقيقية للملف الثاني هي رقم 1001 في الخادم الوهمي.
        let job = Job {
            chat_id: 7,
            user_id: 7,
            user: "المالك".into(),
            source: Source::File {
                file_id: "F12".into(),
                name: "second.mp4".into(),
                size: 0,
            },
            mode: Mode::Song,
            src_msg_id: 12,
            status_msg_id: 1001,
            file: "second.mp4".into(),
            row_id: jobs_arrived(7, "المالك", "second.mp4"),
        };
        let stop = Arc::new(AtomicBool::new(false));
        run_job(&cfg, job, &stop, &ov, None);

        let edits = bot.edited_messages();
        assert!(!edits.is_empty(), "لا تحرير لرسالة الحالة");
        let first = &edits[0];
        assert_eq!(
            first.get("message_id").and_then(Value::as_i64),
            Some(1001),
            "الحالة تُحرَّر في مكانها (رسالة السؤال نفسها)"
        );
        let t0 = first.get("text").and_then(Value::as_str).unwrap_or("");
        assert!(t0.contains("▶ بدأت المعالجة"), "أول تحرير: {t0}");
        assert!(t0.contains("أغنية"), "الوضع مذكور: {t0}");
        assert!(
            first.get("reply_markup").is_some(),
            "زرّ الإلغاء يرافق رسالة الحالة"
        );
        // **ولا رسالة جديدة لكل تحديث**: كل التحديثات تحريرٌ لرسالة واحدة.
        assert_eq!(
            bot.count("sendMessage"),
            0,
            "أُنشئت رسالة جديدة بدل التحرير في المكان: {:?}",
            sent_texts(&bot)
        );
        assert!(
            edits
                .iter()
                .all(|e| e.get("message_id").and_then(Value::as_i64) == Some(1001)),
            "كل التحديثات على الرسالة نفسها"
        );
        // والمهمّة وصلت خطوة الاستلام ثم سقطت على مسار غير موجود (لا محرّك هنا).
        let last = edits
            .last()
            .unwrap()
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(
            last.starts_with('✗'),
            "يُقاس المسار كاملاً إلى أول خروج: {last}"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  م٣/٣ — ربط الرسائل (`reply_parameters`)
    // ═══════════════════════════════════════════════════════════════════════

    /// **الشكوى**: «المحادثة مشتتة». القياس: الناتج يُرسَل بـ`reply_parameters`
    /// يشير إلى **رسالة المستخدم** التي جاء منها الطلب.
    #[test]
    fn the_sent_media_is_a_reply_to_the_users_own_message() {
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let dir = temp_dir("reply");
        let f = dir.join("out.mp3");
        std::fs::write(&f, vec![1u8; 512]).unwrap();

        send_media(&cfg, 7, &f, "نتيجة", Some(4242)).unwrap();
        let body = &bot.bodies("sendAudio")[0];
        assert!(
            body.contains("name=\"reply_parameters\""),
            "لا حقل reply_parameters في الطلب: {body}"
        );
        assert!(
            body.contains("{\"message_id\":4242}"),
            "الردّ لا يشير إلى رسالة المستخدم: {body}"
        );

        // وبلا معرّف لا يُرسَل الحقل أصلاً (لا `message_id: 0`).
        bot.clear();
        send_media(&cfg, 7, &f, "نتيجة", Some(0)).unwrap();
        assert!(
            !bot.bodies("sendAudio")[0].contains("reply_parameters"),
            "صفر ليس معرّفاً"
        );
        let _ = std::fs::remove_file(&f);
    }

    /// ورسالة الوضع (وعاء الحالة) ردٌّ على رسالة المستخدم أيضاً.
    #[test]
    fn the_status_anchor_replies_to_the_users_message() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, _rx) = mpsc::channel::<Job>();
        handle_update(&cfg, &mut poll, &ov, &file_msg(7, 51, "clip.mp4"), &tx);
        let msg = &bot.sent_messages()[0];
        assert_eq!(
            msg.pointer("/reply_parameters/message_id")
                .and_then(Value::as_i64),
            Some(51),
            "رسالة الحالة ليست ردّاً على رسالة المستخدم: {msg}"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  م٣/٤ — سؤال التجاوز بلوحة أزرار
    // ═══════════════════════════════════════════════════════════════════════

    /// الحساب: ناتج صوتي طوله ساعة لا يدخل 40 م.ب بأي معدّل معقول؟ لا — بل
    /// يدخل بـ327 كيلوبت. والفحص على **معكوس الصيغة** لا على رقم مكتوب بيد.
    #[test]
    fn the_oversize_plan_offers_only_options_that_really_fit() {
        // فيديو 10 دقائق: الفيديو يدخل بصورة مشاهَدة، والصوت يدخل أيضاً ⇒ زرّان.
        let p = plan_oversize(600.0, true);
        assert!(p.can_shrink() && p.can_audio(), "{p:?}");
        assert!(projected_mb(p.shrink_kbps + AUDIO_KBPS, 600.0) <= CLOUD_TARGET_MB);
        assert!(projected_mb(p.audio_kbps, 600.0) <= CLOUD_TARGET_MB);

        // صوت بلا صورة: «الضغط» إعادة ترميز الصوت، ولا زرّ «أرسله صوتاً».
        let p = plan_oversize(600.0, false);
        assert!(p.can_shrink() && !p.can_audio(), "{p:?}");

        // فيديو 5 ساعات: لا صورة مشاهَدة ولا صوت داخل الهدف ⇒ **لا وعود كاذبة**.
        let p = plan_oversize(5.0 * 3600.0, true);
        assert!(!p.any(), "وُعد بخيار لا يبلغ الهدف: {p:?}");

        // مدة مجهولة (فشل probe) ⇒ لا حساب ولا وعد.
        let p = plan_oversize(0.0, false);
        assert!(!p.any(), "{p:?}");
    }

    /// الأزرار: **٣ للناتج الصوتي و٤ للفيديو** — وكل زرّ فعلُه (لا زرّ ساكن).
    #[test]
    fn the_oversize_panel_has_the_declared_buttons_and_the_guide_is_informational() {
        let audio = plan_oversize(600.0, false);
        let kb = oversize_keyboard(&audio);
        let flat: Vec<String> = kb["inline_keyboard"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|r| r.as_array().unwrap().clone())
            .map(|b| b["callback_data"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            flat,
            vec!["oversize:shrink", "oversize:help", "oversize:cancel"],
            "لوحة الناتج الصوتي: ٣ أزرار"
        );
        let video = plan_oversize(600.0, true);
        let kb = oversize_keyboard(&video);
        let flat: Vec<String> = kb["inline_keyboard"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|r| r.as_array().unwrap().clone())
            .map(|b| b["callback_data"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            flat,
            vec![
                "oversize:shrink",
                "oversize:audio",
                "oversize:help",
                "oversize:cancel"
            ],
            "لوحة الفيديو: ٤ أزرار"
        );

        // الدليل **معلومة لا إجراء**: يذكر الحدّ والخادم المحلي، ولا وعدَ تقسيم.
        let guide = oversize_guide_text();
        assert!(guide.contains("2000"), "يذكر حدّ الخادم المحلي: {guide}");
        assert!(guide.contains(LOCAL_SERVER_HINT), "ويذكر العنوان: {guide}");
        assert!(guide.contains("معلومة لا إجراء"), "{guide}");
        assert!(guide.contains("لا أقسّم"), "لا تقسيم للناتج: {guide}");
    }

    /// **«يُسأل كل مرّة»** (قرار المالك): سؤالان متتاليان لنفس المحادثة ⇒
    /// **رسالتا سؤال**. ومُفسَد هذا الاختبار: تخزين الاختيار ⇒ الثاني يمرّ بلا سؤال.
    #[test]
    fn the_oversize_question_is_asked_every_single_time() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let ov = new_oversize_store();
        let dir = temp_dir("asked_twice");
        let produced = dir.join("big.mp3");
        std::fs::write(&produced, vec![3u8; 256]).unwrap();

        for i in 0..2 {
            let ask = OversizeAsk {
                chat_id: 7,
                user_id: 7,
                user: "المالك",
                src_msg_id: 60 + i,
                produced: &produced,
                duration_secs: 600.0,
                has_video: false,
                bytes: 60 * 1024 * 1024,
                height: None,
                file: "big.mp3",
            };
            ask_oversize(&cfg, &ov, ask).unwrap();
        }
        assert_eq!(
            bot.sent_messages().len(),
            2,
            "سُئل مرة واحدة فقط — الجواب حُفظ (ممنوع)"
        );
        assert_eq!(ov.lock().unwrap().count_for(7), 2, "سؤالان مفتوحان معاً");
        // وكل سؤال يحمل لوحته، وردٌّ على **رسالة المستخدم التي جاء منها**.
        let replies: Vec<Option<i64>> = bot
            .sent_messages()
            .iter()
            .map(|m| {
                m.pointer("/reply_parameters/message_id")
                    .and_then(Value::as_i64)
            })
            .collect();
        assert_eq!(replies, vec![Some(60), Some(61)], "الربط برسالة المستخدم");
        for m in bot.sent_messages() {
            assert!(m.get("reply_markup").is_some(), "سؤال بلا لوحة: {m}");
        }
        // والنصّ يقول الحجم والحدّ **وأن الملف باقٍ**.
        let text = &sent_texts(&bot)[0];
        assert!(text.contains("60.0MB"), "{text}");
        assert!(text.contains("50.0MB"), "{text}");
        assert!(text.contains("لن يُحذف"), "{text}");
        let _ = std::fs::remove_file(&produced);
    }

    /// «❌ إلغاء» ⇒ **لا رفع ولا حذف** (ت٤)، والسؤال يُزال، والضغطة تُجاب.
    #[test]
    fn cancelling_an_oversize_question_uploads_nothing_and_deletes_nothing() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let ov = new_oversize_store();
        let dir = temp_dir("cancel");
        let produced = dir.join("keep_me.mp3");
        std::fs::write(&produced, vec![9u8; 128]).unwrap();
        ov.lock().unwrap().insert(Oversize {
            chat_id: 7,
            user_id: 7,
            user: "المالك".into(),
            msg_id: 777,
            src_msg_id: 61,
            path: produced.clone(),
            bytes: 60 * 1024 * 1024,
            duration_secs: 600.0,
            has_video: false,
            height: None,
            file: "keep_me.mp3".into(),
            asked: Instant::now(),
        });

        let (tx, _rx) = chan();
        handle_update(
            &cfg,
            &mut poll_state(),
            &ov,
            &press(7, 777, "oversize:cancel"),
            &tx,
        );

        assert_eq!(ov.lock().unwrap().len(), 0, "السؤال لم يُزل");
        assert_eq!(
            bot.count("sendAudio") + bot.count("sendVideo"),
            0,
            "رُفع ملف"
        );
        assert_eq!(bot.count("sendDocument"), 0, "رُفع ملف");
        assert!(produced.is_file(), "حُذف الناتج عند الإلغاء (ممنوع)");
        let answers: Vec<String> = bot
            .bodies("answerCallbackQuery")
            .iter()
            .filter_map(|b| serde_json::from_str::<Value>(b).ok())
            .filter_map(|v| v.get("text").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert_eq!(answers.len(), 1, "كل ضغطة تُجاب: {answers:?}");
        assert!(answers[0].contains("أُلغي"), "{answers:?}");
        let edits = bot.edited_messages();
        assert!(
            edits[0]["text"]
                .as_str()
                .unwrap()
                .contains("باقٍ في مجلد النتائج"),
            "يُقال إن الملف باقٍ: {edits:?}"
        );
        let _ = std::fs::remove_file(&produced);
    }

    /// «ℹ️» ⇒ نصّ الدليل **ويبقى السؤال** بلوحته (ت٥: معلومة لا إجراء).
    #[test]
    fn the_guide_button_keeps_the_question_open_and_takes_no_action() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let ov = new_oversize_store();
        let dir = temp_dir("guide");
        let produced = dir.join("q.mp3");
        std::fs::write(&produced, vec![1u8; 64]).unwrap();
        ov.lock().unwrap().insert(Oversize {
            chat_id: 7,
            user_id: 7,
            user: "المالك".into(),
            msg_id: 778,
            src_msg_id: 62,
            path: produced.clone(),
            bytes: 55 * 1024 * 1024,
            duration_secs: 600.0,
            has_video: false,
            height: None,
            file: "q.mp3".into(),
            asked: Instant::now(),
        });

        let (tx, _rx) = chan();
        handle_update(
            &cfg,
            &mut poll_state(),
            &ov,
            &press(7, 778, "oversize:help"),
            &tx,
        );

        assert_eq!(ov.lock().unwrap().len(), 1, "السؤال يجب أن يبقى مفتوحاً");
        let edits = bot.edited_messages();
        assert_eq!(edits.len(), 1);
        let text = edits[0]["text"].as_str().unwrap();
        assert!(text.contains("كيف أرفع الحدّ"), "{text}");
        assert!(text.contains("2000"), "{text}");
        assert!(text.contains("معلومة لا إجراء"), "{text}");
        assert!(
            edits[0].get("reply_markup").is_some(),
            "اللوحة تبقى بعد الدليل"
        );
        assert_eq!(
            bot.count("sendAudio") + bot.count("sendVideo"),
            0,
            "أُرسل ملف"
        );
        let _ = std::fs::remove_file(&produced);
    }

    /// **صلاحية السؤال** (ت٦): بعد المدة تُزال الحالة **ويُعلَن ذلك**، والملف
    /// يبقى. والقياس بلا انتظار حقيقي: `Instant` مصنوع في الماضي.
    #[test]
    fn an_expired_question_leaks_no_state_and_keeps_the_file() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let mut store = OversizeStore::default();
        let dir = temp_dir("ttl");
        let produced = dir.join("old.mp3");
        std::fs::write(&produced, vec![2u8; 32]).unwrap();
        let now = Instant::now();
        let mk = |msg_id: i64, asked: Instant| Oversize {
            chat_id: 7,
            user_id: 7,
            user: "المالك".into(),
            msg_id,
            src_msg_id: 63,
            path: produced.clone(),
            bytes: 51 * 1024 * 1024,
            duration_secs: 600.0,
            has_video: false,
            height: None,
            file: "old.mp3".into(),
            asked,
        };
        store.insert(mk(801, now - OVERSIZE_TTL - Duration::from_secs(1)));
        store.insert(mk(802, now - Duration::from_secs(5)));

        let dead = store.purge_expired(now);
        assert_eq!(dead.len(), 1, "المنتهي وحده يُزال: {dead:?}");
        assert_eq!(dead[0].msg_id, 801);
        assert_eq!(store.len(), 1, "الحالة لم تتسرّب");
        assert!(store.get(7, 802).is_some(), "الحديث يبقى");

        // والسلوكي: الإعلان في المحادثة عبر المسار الحقيقي.
        let ov = Arc::new(Mutex::new(store));
        ov.lock()
            .unwrap()
            .insert(mk(803, now - OVERSIZE_TTL - Duration::from_secs(30)));
        purge_oversize(&cfg, &ov);
        assert_eq!(ov.lock().unwrap().len(), 1, "بقي المنتهي");
        assert!(produced.is_file(), "حُذف الملف عند انتهاء المدة (ممنوع)");
        let edits = bot.edited_messages();
        assert_eq!(edits[0]["message_id"].as_i64(), Some(803));
        assert!(
            edits[0]["text"]
                .as_str()
                .unwrap()
                .contains("باقٍ في مجلد النتائج"),
            "{edits:?}"
        );
        let _ = std::fs::remove_file(&produced);
    }

    /// **ضغطة من غير المالك** (ت٨): لا تنفيذ ولا استهلاك للحالة، والضغطة تُجاب.
    #[test]
    fn an_oversize_press_from_a_stranger_is_rejected_without_consuming_the_question() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let ov = new_oversize_store();
        ov.lock().unwrap().insert(Oversize {
            chat_id: 7,
            user_id: 7,
            user: "المالك".into(),
            msg_id: 779,
            src_msg_id: 64,
            path: PathBuf::from("does-not-matter.mp3"),
            bytes: 60 * 1024 * 1024,
            duration_secs: 600.0,
            has_video: false,
            height: None,
            file: "x.mp3".into(),
            asked: Instant::now(),
        });
        // المتطفل يخاطب المحادثة نفسها بضغطة على الزرّ نفسه.
        let mut stranger = press(999, 779, "oversize:cancel");
        stranger["callback_query"]["message"]["chat"]["id"] = json!(7);
        let (tx, _rx) = chan();
        handle_update(&cfg, &mut poll_state(), &ov, &stranger, &tx);

        assert_eq!(ov.lock().unwrap().len(), 1, "المتطفل استهلك السؤال");
        assert_eq!(bot.count("editMessageText"), 0, "المتطفل حرّر رسالة");
        let answers = callback_answers(&bot);
        // **م٤: الرفض صار مُسنَداً إلى صاحب الناتج** لا إلى «غير مصرّح» العام:
        // السؤال يحمل `user_id` صاحبه، فالحكم دقيق (والمعنى واحد: لا تنفيذ).
        assert_eq!(
            answers,
            vec!["هذا الزرّ ليس لك".to_string()],
            "الرفض يجب أن يكون بسبب الملكية لا صمتاً"
        );
    }

    /// **ضغطتان متزامنتان** (سؤال الجاسوس ٢): الضغطة الثانية لا تجد مدخلاً
    /// فلا يُرفع الملف مرّتين، وتُجاب بصدق.
    #[test]
    fn a_second_press_on_the_same_button_never_uploads_twice() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let ov = new_oversize_store();
        ov.lock().unwrap().insert(Oversize {
            chat_id: 7,
            user_id: 7,
            user: "المالك".into(),
            msg_id: 780,
            src_msg_id: 65,
            // مسار غير موجود: ffmpeg يفشل فوراً فلا يعتمد القياس على ترميز حقيقي.
            path: PathBuf::from("hl_m3_no_such_input.mp3"),
            bytes: 60 * 1024 * 1024,
            duration_secs: 600.0,
            has_video: false,
            height: None,
            file: "gone.mp3".into(),
            asked: Instant::now(),
        });
        let (tx, _rx) = chan();
        handle_update(
            &cfg,
            &mut poll_state(),
            &ov,
            &press(7, 780, "oversize:shrink"),
            &tx,
        );
        assert_eq!(ov.lock().unwrap().len(), 0, "المدخل يُسحب قبل العمل");
        bot.clear();
        handle_update(
            &cfg,
            &mut poll_state(),
            &ov,
            &press(7, 780, "oversize:shrink"),
            &tx,
        );
        assert_eq!(ov.lock().unwrap().len(), 0);
        assert_eq!(
            bot.count("sendAudio") + bot.count("sendVideo") + bot.count("sendDocument"),
            0,
            "رُفع الملف من ضغطةٍ بلا مدخل"
        );
        let answers: Vec<String> = bot
            .bodies("answerCallbackQuery")
            .iter()
            .filter_map(|b| serde_json::from_str::<Value>(b).ok())
            .filter_map(|v| v.get("text").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert_eq!(answers, vec!["لم يعد هذا السؤال فعّالاً".to_string()]);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  م٣/٥ — حدث `telegram-jobs` (العقد المُجمَّد)
    // ═══════════════════════════════════════════════════════════════════════

    /// الحمولة **نقيّة** فتُقاس بلا تطبيق: الترتيب بترتيب الوصول، و`position`
    /// واحدٌ للأول، و`total` طول المصفوفة، والحالات بأسمائها، و`pct` `null`
    /// قبل البدء، **والاسم بلا مسار**.
    #[test]
    fn the_jobs_payload_matches_the_frozen_contract() {
        let rows = vec![
            TgJobRow {
                id: 1,
                chat_id: 7,
                user: "المالك".into(),
                file: "a.mp4".into(),
                state: JobState::Running,
                pct: Some(37.5),
            },
            TgJobRow {
                id: 2,
                chat_id: 7,
                user: "المالك".into(),
                file: "b.mp4".into(),
                state: JobState::Queued,
                pct: None,
            },
            TgJobRow {
                id: 3,
                chat_id: 8,
                user: "آخر".into(),
                file: "c.mp4".into(),
                state: JobState::Done,
                pct: Some(100.0),
            },
            TgJobRow {
                id: 4,
                chat_id: 8,
                user: "آخر".into(),
                file: "d.mp4".into(),
                state: JobState::Failed,
                pct: None,
            },
        ];
        let v = jobs_payload(&rows);
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 4);
        assert_eq!(arr[0]["state"], json!("running"));
        assert_eq!(arr[0]["position"], json!(1));
        assert_eq!(arr[1]["position"], json!(2));
        assert_eq!(arr[1]["pct"], Value::Null);
        assert_eq!(arr[0]["total"], json!(4));
        assert_eq!(arr[2]["state"], json!("done"));
        assert_eq!(arr[3]["state"], json!("failed"));
        // **المفاتيح الأربعة المعلَنة** لا غيرها (العقد مُجمَّد للواجهة).
        let keys: Vec<&str> = arr[0]
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        assert_eq!(
            keys,
            vec!["chat_id", "file", "pct", "position", "state", "total", "user"]
        );
        // ولا مسار في `file` — الخصوصية.
        assert!(!arr[0]["file"].as_str().unwrap().contains('\\'));
    }

    /// `display_name` يقصّ المسار: الاسم المعروض لا يكشف مجلد الجهاز.
    #[test]
    fn the_displayed_name_never_carries_a_path() {
        assert_eq!(display_name("C:\\Users\\me\\Videos\\song.mp4"), "song.mp4");
        assert_eq!(display_name("/home/me/سر.mp4"), "سر.mp4");
        assert_eq!(display_name("   "), "ملف");
        assert_eq!(display_name(""), "ملف");
        assert_eq!(display_name("song.mp4"), "song.mp4");
    }

    /// **عند كل تغيّر فعلي**: وصول ⇒ صفّ `queued`؛ بدء ⇒ `running`؛ انتهاء ⇒
    /// يُبَثّ `done` **مرّة** ثم يُزال (فلا سطر ميت في اللوحة).
    #[test]
    fn a_job_row_walks_queued_running_done_and_is_then_removed() {
        let _g = state_lock();
        reset_counters();
        let id = jobs_arrived(4242, "المالك", "clip.mp4");
        assert_eq!(tg_job_states_for_test(4242), vec![("queued".into(), None)]);
        jobs_started(id);
        assert_eq!(
            tg_job_states_for_test(4242),
            vec![("running".into(), Some(0.0))]
        );
        jobs_progress(id, 37.44);
        assert_eq!(
            tg_job_states_for_test(4242),
            vec![("running".into(), Some(37.4))],
            "النسبة مقرّبة لعُشر — تغيّر فعلي لا ضجيج"
        );
        // نسبة لا تتغيّر ⇒ لا بثّ: التقريب نفسه هو الحارس (يُقاس نقيّاً).
        assert_eq!(
            round_pct(37.44),
            round_pct(37.449),
            "فرقٌ دون العُشر ليس تغيّراً"
        );
        assert_ne!(round_pct(37.44), round_pct(37.46), "فرقٌ فوق العُشر تغيّر");
        jobs_finished(id, true);
        assert!(
            tg_job_states_for_test(4242).is_empty(),
            "الصفّ المنتهي يجب أن يُزال بعد بثّه"
        );
    }

    /// والوصول الحقيقي (عبر `handle_update`) يُسجّل صفّاً باسم الملف المعروض.
    #[test]
    fn an_arriving_file_shows_up_in_the_jobs_list_without_a_path() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, _rx) = chan();
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &file_msg(7, 71, "C:\\secret\\dir\\song.mp4"),
            &tx,
        );
        let rows = tg_job_rows_for_test(7);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0]["file"], json!("song.mp4"), "المسار يتسرّب");
        assert_eq!(rows[0]["state"], json!("queued"));
        assert_eq!(rows[0]["user"], json!("المالك"));
        assert_eq!(rows[0]["position"], json!(1));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  م٣/٦ — الأوامر
    // ═══════════════════════════════════════════════════════════════════════

    /// `/help` يعرض **القائمة نفسها** التي تُسجَّل في تلغرام؛ ولا `/stop`
    /// في القائمة ولا في النصّ (قاعدة المالك: ما يظهر يعمل).
    #[test]
    fn the_help_list_is_the_registered_list_and_has_no_stop() {
        let help = help_text();
        for (name, desc) in COMMANDS {
            assert!(help.contains(&format!("/{name}")), "أمر غير معروض: {name}");
            assert!(!desc.is_empty(), "وصف فارغ لـ{name}");
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "اسم أمر غير مقبول في Bot API: {name}"
            );
        }
        // الأمر الممنوع: يُبنى النصّ مقطّعاً حتى لا يجد الحارس نفسه في المصدر.
        let banned = concat!("/st", "op");
        assert!(!help.contains(banned), "ظهر أمر ممنوع في /help");
        // النصّ الممنوع يُبنى بـ`concat!` حتى في هذا الفحص نفسه — وإلا وجد
        // الحارسُ نفسَه في المصدر (وقع فعلاً: `"stop"` هنا أسقطت الفحص).
        assert!(!COMMANDS.iter().any(|(n, _)| *n == concat!("st", "op")));
        // وحارس على المصدر: **أسطر التعليق تُنزع أولاً** — فالتعليق الذي يمنع
        // الأمر يذكر نصّه، ومسبارٌ خام كان يسقط على توثيقه هو (وقع فعلاً).
        let code: String = include_str!("telegram.rs")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains(banned) && !code.contains("\"stop\""),
            "ذُكر {banned} في كود المصدر (ممنوع في أي مكان)"
        );
    }

    /// **الأوامر بنطاق محادثة (م٤/٣)**: النطاق الافتراضي **يُفرَّغ** فلا يظهر
    /// أمرٌ في مجموعةٍ سيُرفض فيها (`/kill` و`/status` للمالك وحده)، وقائمة
    /// المالك الكاملة تُسجَّل في **نطاق محادثته** وحدها.
    ///
    /// وهذا الحارس **مُقوّى لا مُرخّى**: كان يقيس «سطراً واحداً بالقائمة نفسها»،
    /// وصار يقيس ثلاثة أضعاف ذلك — صفرُ أوامر عامة، ونطاقٌ لمحادثة المالك
    /// بعينها، والقائمة حرفاً بحرف، وحدود الـAPI (١٠٠ · ٣٢ · ٢٥٦).
    #[test]
    fn the_commands_are_registered_in_the_owners_scope_only() {
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        register_commands(&cfg);

        // ① النطاق الافتراضي: **صفر أوامر** — طلبٌ صريح لا تركٌ ضمني.
        let deletes = bot.bodies("deleteMyCommands");
        assert_eq!(deletes.len(), 1, "لم يُفرَّغ النطاق الافتراضي مرة واحدة");
        let dv: Value = serde_json::from_str(&deletes[0]).unwrap();
        assert_eq!(
            dv.pointer("/scope/type").and_then(Value::as_str),
            Some("default"),
            "الإفراغ يجب أن يكون للنطاق الافتراضي صراحةً: {dv}"
        );

        // ② القائمة الكاملة: تسجيلٌ **واحد** بنطاق محادثة المالك.
        let bodies = bot.bodies("setMyCommands");
        assert_eq!(
            bodies.len(),
            1,
            "الأوامر تُسجَّل مرة واحدة — ولا قائمة عامة ثانية: {bodies:?}"
        );
        let v: Value = serde_json::from_str(&bodies[0]).unwrap();
        assert_eq!(
            v.pointer("/scope/type").and_then(Value::as_str),
            Some("chat"),
            "القائمة الكاملة في نطاق محادثةٍ بعينها لا في النطاق الافتراضي: {v}"
        );
        assert_eq!(
            v.pointer("/scope/chat_id").and_then(Value::as_i64),
            Some(7),
            "النطاق محادثة المالك نفسها: {v}"
        );
        let listed: Vec<(String, String)> = v["commands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["command"].as_str().unwrap().to_string(),
                    c["description"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let declared: Vec<(String, String)> = COMMANDS
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        assert_eq!(listed, declared, "قائمة الإعلان ≠ قائمة العرض");

        // ③ **حدود الـAPI** على القائمة المنشورة نفسها — لا نيّةً في تعليق:
        //    ١٠٠ أمر · اسم ١–٣٢ (إنجليزي صغير/أرقام/`_`) · وصف ١–٢٥٦.
        assert!(
            listed.len() <= MAX_BOT_COMMANDS,
            "عدد الأوامر {} فوق حدّ الـAPI {MAX_BOT_COMMANDS}",
            listed.len()
        );
        for (name, desc) in &listed {
            assert!(
                !name.is_empty() && name.len() <= MAX_COMMAND_NAME,
                "طول اسم الأمر خارج ١–{MAX_COMMAND_NAME}: {name:?}"
            );
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "اسم أمر غير مقبول في Bot API: {name:?}"
            );
            assert!(
                !desc.is_empty() && desc.len() <= MAX_COMMAND_DESC,
                "طول الوصف خارج ١–{MAX_COMMAND_DESC}: {desc:?}"
            );
        }
        // ④ ولا أمر عام أصلاً (فلا يظهر في مجموعةٍ ما سيُرفض فيها).
        assert!(
            PUBLIC_COMMANDS.is_empty(),
            "قائمة عامة غير فارغة تعني أمراً ظاهراً في المجموعات: {PUBLIC_COMMANDS:?}"
        );
        // ⑤ ونطاق المحادثة **لا يُرسَل لقناة**: بلا مالك موجب لا تسجيل أصلاً.
        bot.clear();
        let mut anon = bot.cfg(7);
        anon.owner_id = None;
        register_commands(&anon);
        assert_eq!(
            bot.bodies("setMyCommands").len(),
            0,
            "سُجّلت أوامر بلا معرّف مالك ⇒ نطاقٌ بلا محادثة"
        );
        assert_eq!(bot.bodies("deleteMyCommands").len(), 1, "الإفراغ يقع دائماً");
    }

    /// `/status` **نقيّ**: يقول ما يعمل ولمن، ويعدّ المنتظر والمعلَّق.
    #[test]
    fn status_text_names_what_runs_for_whom_and_counts_the_rest() {
        let running = vec![
            slots::JobInfo {
                id: 1,
                label: job_label(7, 7),
                path: Some("C:\\tmp\\mysong.mp4".into()),
                started_ms: 12_000,
                cancelled: false,
            },
            // مهمّة مصدرها الواجهة: ليست لهذه المحادثة فلا تُنسب إليها.
            slots::JobInfo {
                id: 2,
                label: "gui".into(),
                path: Some("other.mp4".into()),
                started_ms: 1_000,
                cancelled: false,
            },
        ];
        let t = status_text(7, &running, 3, 2, 1, "", 17_500);
        assert!(t.contains("mysong.mp4"), "{t}");
        assert!(t.contains("منذ 5 ث"), "المدة مقيسة من started_ms: {t}");
        assert!(!t.contains("other.mp4"), "مهمّة مصدرٍ آخر نُسبت للمحادثة: {t}");
        assert!(t.contains("قائمة الانتظار: 3"), "{t}");
        assert!(t.contains("تنتظر اختيار الوضع: 2"), "{t}");
        assert!(t.contains("أسئلة ضغط مفتوحة: 1"), "{t}");
        assert!(t.contains("المحادثة: 7"), "«ولِمَن»: {t}");
        // بلا مهمّة: يُقال بصراحة، ولا قائمة فارغة.
        let idle = status_text(7, &running[1..], 0, 0, 0, "خطأ ما", 17_500);
        assert!(idle.contains("لا شيء يعمل"), "{idle}");
        assert!(idle.contains("خطأ ما"), "الخطأ الأخير يُقال: {idle}");
        // ومهمّة طُلب إلغاؤها تُوصَف بذلك لا بأنها تعمل بصمت.
        let mut c = running.clone();
        c[0].cancelled = true;
        assert!(status_text(7, &c, 0, 0, 0, "", 17_500).contains("طُلب إلغاؤها"));
    }

    /// `/status` و`/kill` يعملان فعلاً في المحادثة (سلوكي، بخادم وهمي).
    #[test]
    fn slash_commands_answer_in_the_chat_and_a_stranger_gets_silence() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, _rx) = chan();

        for (i, cmd) in [
            "/status",
            "/help",
            "/lang",
            "/lang en",
            "/mode",
            "/nonsense",
        ]
        .iter()
        .enumerate()
        {
            handle_update(&cfg, &mut poll, &ov, &text_msg(7, 200 + i as i64, cmd), &tx);
        }
        let texts = sent_texts(&bot);
        assert_eq!(texts.len(), 6, "كل أمر يُجاب: {texts:?}");
        assert!(texts[0].contains("📊 الحال الآن"), "{}", texts[0]);
        assert!(texts[1].contains("/status"), "{}", texts[1]);
        assert!(texts[2].contains("العربية"), "{}", texts[2]);
        assert!(texts[3].contains("لا تتوفّر لغة"), "{}", texts[3]);
        assert!(texts[4].contains("لا ملفات تنتظر"), "{}", texts[4]);
        assert!(
            texts[5].contains("لا أعرف الأمر /nonsense"),
            "الأمر المجهول يُقال بصراحة: {}",
            texts[5]
        );

        // متطفل: **صمت تام** — ولا حتى إقرار (نفس سياسة الرسائل).
        bot.clear();
        handle_update(&cfg, &mut poll, &ov, &text_msg(999, 300, "/status"), &tx);
        assert_eq!(bot.calls().len(), 0, "ردّ على غير المالك");
    }

    /// `/mode` يُعيد الأزرار للملفات المنتظرة **برمزها** فيصلح الزرّان معاً.
    #[test]
    fn the_mode_command_resends_the_buttons_for_every_waiting_file() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, _rx) = chan();
        handle_update(&cfg, &mut poll, &ov, &file_msg(7, 81, "a.mp4"), &tx);
        handle_update(&cfg, &mut poll, &ov, &file_msg(7, 82, "b.mp4"), &tx);
        let tokens = mode_tokens(&bot);
        bot.clear();
        handle_update(&cfg, &mut poll, &ov, &text_msg(7, 301, "/mode"), &tx);
        let again = mode_tokens(&bot);
        assert_eq!(again, tokens, "رموز جديدة تعني أزراراً قديمة معطّلة");
        assert_eq!(sent_texts(&bot).len(), 2, "سؤال لكل ملف منتظر");
        // ولا يُلغى اختيار ملفٍ بإعادة العرض: المدخلان ما زالا قائمين.
        assert_eq!(poll.pending.count_for(7), 2);
    }

    /// الخيط الذي يُسجّل الأوامر عند الإقلاع: القائمة تصل إلى تلغرام **قبل**
    /// أول استطلاع. (مُفسَد محروس: حذف `register_commands` من خيط الاستطلاع.)
    #[test]
    fn the_poll_thread_registers_the_commands_at_startup() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, _rx) = chan();
        spawn_poll_thread(cfg, stop.clone(), tx, new_oversize_store());
        for _ in 0..200 {
            // **م٤**: صار التسجيل تسجيليْن — إفراغٌ افتراضيّ وقائمةُ المالك —
            // فينتظر الفحص كليهما (وحارسُه اختبار التسجيل نفسه).
            if bot.count("setMyCommands") > 0
                && bot.count("deleteMyCommands") > 0
                && bot.count("getUpdates") > 0
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        stop.store(true, Ordering::SeqCst);
        assert_eq!(
            bot.count("setMyCommands"),
            1,
            "أوامر المالك لم تُسجَّل عند الإقلاع"
        );
        assert_eq!(
            bot.count("deleteMyCommands"),
            1,
            "لم يُفرَّغ النطاق الافتراضي عند الإقلاع (فأوامر قديمة تظهر في المجموعات)"
        );
        assert!(bot.count("getUpdates") >= 1, "لم يبدأ الاستطلاع");
    }

    /// الأوامر تُفهم بصورها المتكافئة: `/kill@TheBot` و`/status الآن`.
    #[test]
    fn commands_are_parsed_in_their_equivalent_spellings() {
        assert_eq!(
            parse_command("/kill@MyBot"),
            Some(("kill".to_string(), None))
        );
        assert_eq!(
            parse_command("  /STATUS  "),
            Some(("status".to_string(), None))
        );
        assert_eq!(
            parse_command("/lang en"),
            Some(("lang".to_string(), Some("en".to_string())))
        );
        // نصّ عادي ليس أمراً، و«/» وحدها ليست أمراً.
        assert_eq!(parse_command("مرحبا"), None);
        assert_eq!(parse_command("/"), None);
        assert_eq!(parse_command(""), None);
        assert_eq!(parse_command("//x"), None);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  م٣/إصلاح — ستّة عيوب أثبتها مدقّق مستقلّ، ولكلٍّ مُفسَد يُسقطه
    // ═══════════════════════════════════════════════════════════════════════

    /// نصوص التعديلات على رسالةٍ بعينها (ما يراه المستخدم فعلاً).
    fn edit_texts_on(bot: &FakeBot, message_id: i64) -> Vec<String> {
        bot.edited_messages()
            .iter()
            .filter(|m| m.get("message_id").and_then(Value::as_i64) == Some(message_id))
            .filter_map(|m| m.get("text").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    // ── ① نصّ الإلغاء بحسب المرحلة، ورقمه مقيس لا مكتوب بيد ──────────────────

    /// **العطل (١)**: `cancel_reply` كانت تقول دائماً «سيتوقّف بعد انتهاء نداء
    /// المحرّك الجاري… أطول ما قيس ٩.٤ دقيقة» **حتى في مرحلة التنزيل** — وعدٌ
    /// أطول من الواقع بعشرات المرات في أكثر الحالات وقوعاً.
    ///
    /// **القياس هنا**: (أ) الجواب يأتي من **السِجلّ الحقيقي** لا من وسيط،
    /// (ب) ورقمه مُشتقّ من قياس **مسار التنزيل الإنتاجي نفسه**: الحارس ينادي
    /// [`crate::yt_dlp::tests::measure_download_cancel_secs`] — وهي تبني ثنائياً
    /// مزيّفاً بدور yt-dlp وتمرّ من `download_media` بعينها ثم تُلغي من السِجلّ
    /// وتقيس. **وهذا هو إعادة بناء الحارس (م٣/إصلاح٢)**: كان يقيس `ping` عبر
    /// `proc::run_cancellable` — وهو **المسار المسجَّل المُستطلَع** — بينما
    /// yt-dlp كان يسلك مساراً آخر (‏`spawn` مباشر بلا تسجيل) ⇒ **حارس أخضر
    /// ومنتج معطوب**. فالقياس اليوم على المسار لا على شبيهه.
    ///
    /// (مُفسَد محروس: توحيد النصّين ⇒ يسقط الفحص على «مرحلة التحضير»؛ وإسقاط
    /// التسجيل/الـJob في مسار التنزيل ⇒ يسقط قياس (ب) في حرّاس `yt_dlp`).
    #[cfg(windows)]
    #[test]
    fn the_prepare_phase_cancel_reply_carries_a_measured_number() {
        let _reg = crate::slots::registry_test_lock();
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let _ = &cfg;

        // (أ) الجواب يُقرأ من السِجلّ: مهمّة مُسجَّلة في التحضير (لم تدخل الجسم).
        let early = slots::register_early(&job_label(7, 7), None);
        let reply = cancel_chat_jobs_with(7, 7, Duration::ZERO);
        assert!(
            reply.contains("مرحلة التحضير"),
            "الجواب ليس جواب مرحلة التحضير: {reply}"
        );
        assert!(
            reply.contains(&format!("{CANCEL_PREPARE_WORST_SECS:.1}")),
            "الرقم المقيس لهذه المرحلة مذكور: {reply}"
        );
        assert!(
            !reply.contains(&crate::pipeline::ENGINE_CALL_CEILING_SECS.to_string()),
            "رقم نداء المحرّك لا يُقال عن مرحلة التحضير (العطل الأصلي): {reply}"
        );
        drop(early);

        // (ب) **الزمن من مسار التنزيل الإنتاجي** — لا من بديل يشبهه، ولا من
        //     أداة نائمة خارج المسار (وهو ما كان يجعل الحارس أخضر والمنتج معطوباً).
        let measured = crate::yt_dlp::tests::measure_download_cancel_secs();
        assert!(
            measured <= CANCEL_PREPARE_WORST_SECS,
            "الإلغاء الفعلي في التحضير {measured:.4} ث تجاوز الرقم المعلَن {CANCEL_PREPARE_WORST_SECS} ث"
        );
        // **ولا يصير الرقم سقفاً مطّاطاً**: مرحلة التحضير أدواتها تُقتل فوراً،
        // فيبقى الرقم داخل نطاق القتل الفوري (< ١ ث). ومن أطاله إلى دقائق — أو
        // أبقى الرقم القديم ٣.٦ المبنيّ على إسناد سبب خاطئ — يسقط هنا.
        //
        // **والرقم يُقرأ من النصّ نفسه** (لا من الثابت): ما يراه المستخدم هو ما
        // يُقاس، والقراءة من نصّ وقت التشغيل لا من ثابتٍ يُطوى في التصريف.
        let shown: f64 = reply
            .split("في هذه المرحلة ")
            .nth(1)
            .and_then(|rest| rest.split(' ').next())
            .and_then(|tok| tok.parse::<f64>().ok())
            .unwrap_or_else(|| panic!("لا رقم في نصّ الإلغاء: {reply}"));
        assert!(
            shown < 1.0,
            "الرقم المعلَن في النصّ {shown} ث خرج من نطاق «يُقتل فوراً» — سقفٌ مطّاط لا زمن مقيس: {reply}"
        );
        assert!(
            (shown - CANCEL_PREPARE_WORST_SECS).abs() < 1e-9,
            "نصّ الإلغاء يحمل رقماً غير الثابت المعلَن ({shown} ≠ {CANCEL_PREPARE_WORST_SECS}): {reply}"
        );
        eprintln!(
            "م٣/إلغاء التحضير: المقيس من مسار التنزيل {measured:.4} ث · المعلَن في النصّ {shown} ث · الجواب «{reply}»"
        );
    }

    // ── ② الإلغاء حالة نهائية لا تُطمس ──────────────────────────────────────

    /// **العطل (٢)**: بعد «🛑 أُلغيت» يصل بعد ~٣ ث تعديلٌ ثانٍ بنصّ «✗ فشلت
    /// المعالجة: أُلغيت المعالجة» فيمحو أثر الإلغاء ويُظهر فشلاً لعملٍ أُلغي عمداً.
    ///
    /// **الطرف الأول من العلاج**: علم إلغاء المهمّة نفسه هو ما يختار النصّ
    /// النهائي — فمسار الخروج لا يوصف بفشل بعد إلغاء (أيًّا كان الخطأ: تنزيل أو
    /// محرّك أو إرسال).
    ///
    /// (مُفسَد محروس: تمرير نصّ الخطأ كما هو في `end` ⇒ يسقط هذا الفحص.)
    #[test]
    fn a_cancelled_job_ends_with_the_cancel_text_not_a_failure() {
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let msg = 4001;
        let cancel = Arc::new(AtomicBool::new(false));
        let status = std::cell::RefCell::new(StatusMsg::new(7, 7, msg, cancel.clone()));
        status
            .borrow_mut()
            .set(&cfg, "🎛️ فصل الصوت… 50%".into(), true);
        // الزرّ أو `/kill` يضبطان الرمز، ثم يخرج المسار بخطأ المحرّك نفسه.
        cancel.store(true, Ordering::SeqCst);
        status
            .borrow_mut()
            .end(&cfg, format!("✗ فشلت المعالجة: {}", crate::proc::CANCELLED));

        let texts = edit_texts_on(&bot, msg);
        assert_eq!(
            texts.last().map(String::as_str),
            Some(CANCELLED_TEXT),
            "التعديل النهائي لمهمّة أُلغيت: {texts:?}"
        );
        assert!(
            texts.iter().all(|t| !t.contains('✗')),
            "نصّ فشل لعملٍ أُلغي عمداً: {texts:?}"
        );
        // والزرّ أُزيل صراحةً في التعديل النهائي.
        let last = bot
            .edited_messages()
            .into_iter()
            .rfind(|m| m.get("message_id").and_then(Value::as_i64) == Some(msg))
            .unwrap();
        assert_eq!(
            last.pointer("/reply_markup/inline_keyboard"),
            Some(&json!([])),
            "زرّ الإلغاء بقي على رسالة إلغاء: {last}"
        );
    }

    /// **العطل (٢) — الطرف الثاني**: التعديل المتأخّر نفسه. بعد أن كُتب نصّ
    /// الإلغاء على الرسالة تُجمَّد: **لا يُقبل بعدها شيء**، فلا يمحوها تعديلٌ
    /// متأخّر من خيط المهمّة (وهو ما قاسه المدقّق: ~٣ ث ثم «✗ …»).
    ///
    /// **والسِجلّ يشهد**: الكتابة الثانية مسجَّلة **بزمن وصولها وترتيبها**
    /// ومُسقطة (`applied: false`).
    ///
    /// (مُفسَد محروس: إسقاط شرط التجميد/الرتبة ⇒ التعديل المتأخّر يمرّ ⇒ يسقط.)
    #[test]
    fn the_cancel_text_freezes_the_message_against_late_edits() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let msg = 4101;

        // ① «🛑 أُلغيت» من الزرّ — بنفس الدالّة التي يناديها المعالج.
        let reply = cancel_reply(true, crate::slots::JobPhase::Processing);
        assert_eq!(reply, CANCELLED_TEXT);
        assert!(status_push(
            &cfg,
            7,
            msg,
            cancel_reply_rank(&reply),
            &reply,
            no_keyboard()
        ));
        // ② ثم تعديلٌ متأخّر بنصّ فشل (خيط المهمّة بعد دوائه) — يجب ألا يُقبل.
        let late = status_push(
            &cfg,
            7,
            msg,
            StatusRank::Finished,
            "✗ فشلت المعالجة: أُلغيت المعالجة",
            no_keyboard(),
        );
        assert!(!late, "تعديل متأخّر طمس أثر الإلغاء");
        // وحتى نصّ الإلغاء نفسه لا يُعاد كتابته (الرسالة مجمّدة نهائياً).
        assert!(!status_push(
            &cfg,
            7,
            msg,
            StatusRank::Cancelled,
            CANCELLED_TEXT,
            no_keyboard()
        ));

        let texts = edit_texts_on(&bot, msg);
        assert_eq!(
            texts,
            vec![CANCELLED_TEXT.to_string()],
            "ما وصل إلى الشاشة: {texts:?}"
        );
        let log = status_write_log(7, msg).expect("سِجلّ الكتابات");
        assert_eq!(log.len(), 3, "السِجلّ لا يشهد بكل كتابة: {log:?}");
        assert_eq!(
            log.iter().map(|w| (w.rank, w.applied)).collect::<Vec<_>>(),
            vec![
                (StatusRank::Cancelled, true),
                (StatusRank::Finished, false),
                (StatusRank::Cancelled, false)
            ]
        );
        assert!(
            log.windows(2).all(|w| w[1].at_ms >= w[0].at_ms),
            "أزمنة الوصول غير مرتّبة: {log:?}"
        );
        eprintln!("م٣/تجميد الإلغاء: {log:?}");
    }

    // ── ③ سباق الرسالة نفسها: آخر ما يُكتب هو الحالة الأحدث ─────────────────

    /// **العطل (٣)**: «▶ بدأت المعالجة» و«⏳ في قائمة الانتظار — دورك: 1» يصلان
    /// في المللي ثانية نفسها من خيطين (خيط التحديثات يحرّر **بعد** `tx.send`
    /// وخيط المهمّة يحرّر عند البدء) ⇒ قد تبقى على الشاشة «دورك: 1» لمهمّة بدأت.
    ///
    /// **القياس**: الكتابة المتأخّرة تُسقَط، وآخر ما على الرسالة هو الأحدث —
    /// والسِجلّ يسجّل **زمن وصول كل تعديل وترتيبه**.
    ///
    /// (مُفسَد محروس: إسقاط مقارنة الرتبة ⇒ إشعار الانتظار المتأخّر يمحو البدء ⇒ يسقط.)
    #[test]
    fn a_late_queue_notice_never_overwrites_the_started_state() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let msg = 4201;

        // ① خيط المهمّة: «▶ بدأت المعالجة» (رتبة Running).
        assert!(status_push(
            &cfg,
            7,
            msg,
            StatusRank::Running,
            &running_text("أغنية"),
            cancel_button(7, 7)
        ));
        // ② خيط التحديثات: إشعار الانتظار يصل **متأخّراً** (وهو موضعه المقيس:
        //    بعد `tx.send`) — فيُسقَط ولا يمحو البدء.
        let late = status_push(
            &cfg,
            7,
            msg,
            StatusRank::Queued,
            &waiting_text("أغنية", 1),
            cancel_button(7, 7),
        );
        assert!(!late, "إشعار انتظار متأخّر قُبل فمحا «بدأت المعالجة»");

        let texts = edit_texts_on(&bot, msg);
        assert_eq!(texts.len(), 1, "تعديلٌ ثانٍ وقع: {texts:?}");
        assert!(
            texts[0].contains("▶ بدأت المعالجة"),
            "آخر ما على الشاشة: {texts:?}"
        );
        assert!(!texts[0].contains("دورك"), "«دورك» بقيت على مهمّة بدأت");
        let log = status_write_log(7, msg).expect("سِجلّ الكتابات");
        assert_eq!(
            log.iter().map(|w| (w.rank, w.applied)).collect::<Vec<_>>(),
            vec![(StatusRank::Running, true), (StatusRank::Queued, false)]
        );
        assert_eq!(status_write_counts(7, msg), Some((1, 1)));
        eprintln!("م٣/سباق الرسالة (متأخّر): {log:?}");
    }

    /// **ونفس العطل بسباقٍ حقيقي**: خيطان يكتبان في اللحظة نفسها (`Barrier`)،
    /// ويتكرّر القياس — والمحكوم عليه **ثابتٌ في كل ترتيب**: آخر ما على الرسالة
    /// هو «بدأت المعالجة» لا «دورك: N».
    ///
    /// (والترتيب المُقاس يُطبع من السِجلّ: من وصل أولاً.)
    #[test]
    fn the_message_shows_the_newest_state_under_a_real_two_thread_race() {
        use std::sync::Barrier;
        let rounds = 12;
        let mut orders: Vec<String> = Vec::new();
        for round in 0..rounds {
            let _g = state_lock();
            reset_counters();
            let bot = FakeBot::start();
            let cfg = bot.cfg(7);
            let msg = 4300 + round;
            let gate = Arc::new(Barrier::new(2));
            let mut handles = Vec::new();
            for rank in [StatusRank::Queued, StatusRank::Running] {
                let (cfg, gate) = (cfg.clone(), gate.clone());
                handles.push(std::thread::spawn(move || {
                    let text = if rank == StatusRank::Running {
                        running_text("أغنية")
                    } else {
                        waiting_text("أغنية", 1)
                    };
                    gate.wait();
                    status_push(&cfg, 7, msg, rank, &text, cancel_button(7, 7))
                }));
            }
            for h in handles {
                let _ = h.join();
            }
            let texts = edit_texts_on(&bot, msg);
            let last = texts.last().cloned().unwrap_or_default();
            let log = status_write_log(7, msg).unwrap_or_default();
            orders.push(format!(
                "جولة {round}: {:?} ⇒ «{}»",
                log.iter().map(|w| w.rank).collect::<Vec<_>>(),
                last
            ));
            assert!(
                last.contains("▶ بدأت المعالجة") && !last.contains("دورك"),
                "آخر ما على الرسالة ليس الأحدث (جولة {round}): {texts:?} · السِجلّ {log:?}"
            );
        }
        eprintln!("م٣/سباق خيطين حقيقي:\n{}", orders.join("\n"));
    }

    // ── ④ الحرّاس الناقصة ───────────────────────────────────────────────────

    /// **العطل (٤-أ)**: جعل `MAX_PENDING_PER_CHAT` = ٣ ⇒ **302/302 نجحت**، لأن
    /// كل الفحوص تستعمل الثابت نفسه لا الرقم ⇒ الوعد الظاهر للمستخدم
    /// («عندك ١٠ ملفات…») بلا حارس على **الرقم**.
    ///
    /// **القياس**: الرقم مكتوب هنا **مرّة** بيدٍ (وهو الوعد المقصود)، ويُقاس
    /// على **نصّ الرسالة** التي يراها المستخدم — فلا يكفي أن يتساوى الثابت مع
    /// نفسه في كل موضع.
    ///
    /// (مُفسَد محروس: ١٠ ⟶ ٣ ⇒ يسقط هذا الفحص وحده بينما تبقى فحوص السقف خضراء.)
    #[test]
    fn the_pending_cap_is_the_number_the_user_is_promised() {
        // الرقم المعلَن للمستخدم — مصدره هذا السطر وحده في الاختبارات.
        const PROMISED_PENDING_CAP: usize = 10;
        assert_eq!(
            MAX_PENDING_PER_CHAT, PROMISED_PENDING_CAP,
            "الحدّ المعلَن للملفات المعلّقة تغيّر بلا تحديث الوعد"
        );
        let text = pending_full_text();
        assert!(
            text.contains(&format!("{PROMISED_PENDING_CAP} ملفات")),
            "نصّ بلوغ السقف لا يذكر الرقم الموعود: {text}"
        );
        // ورسالة `/help` لا تذكر هذا الرقم (لا وعد ثانٍ يفترق عنه) — يُقاس لا يُفترض.
        assert!(
            !help_text().contains(&format!("{PROMISED_PENDING_CAP} ملفات")),
            "وعدٌ ثانٍ بالرقم في /help: {}",
            help_text()
        );
    }

    /// **العطل (٤-ب)**: جعل نصّ `/lang` يقول «تم تبديل اللغة إلى العربية» ⇒ نجحت
    /// الاختبارات (لا حارس على **مصداقية النصّ**).
    ///
    /// **القياس**: (أ) لا صيغة تبديل في أي جواب من أجوبة `/lang` — والأمر لا
    /// يبدّل شيئاً فعلاً (لا مفتاح لغة في الإعدادات)، و(ب) والدليل السلوكي:
    /// تنفيذ الأمر لا يُغيّر شيئاً في المحادثة (رسالة واحدة، ونصّ `/help` نفسه
    /// حرفياً قبله وبعده) — فالنصّ الذي يدّعي تبديلاً يكذّب هذا القياس.
    ///
    /// (مُفسَد محروس: نصّ يدّعي التبديل ⇒ يسقط الفحص (أ) و(ب) معاً.)
    #[test]
    fn the_lang_command_never_claims_a_switch_it_does_not_make() {
        // صيغ «فعل التبديل» — قائمة **معلَنة الحدّ**: مرادفٌ غير مُدرَج يعضّها،
        // ولهذا يقيس (ب) عدمَ وقوع الفعل لا غياب الكلمة وحدها.
        const SWITCH_CLAIMS: [&str; 8] = [
            "تم تبديل",
            "تم التبديل",
            "تم تغيير",
            "تم التغيير",
            "بدّلت اللغة",
            "غيّرت اللغة",
            "سأبدّل",
            "تم ضبط اللغة",
        ];
        for arg in [None, Some("ar"), Some("AR"), Some("en"), Some("ar-EG")] {
            let t = lang_text(arg);
            for claim in SWITCH_CLAIMS {
                assert!(
                    !t.contains(claim),
                    "نصّ /lang يدّعي تبديلاً لا يقع («{claim}»): {t}"
                );
            }
            assert!(t.contains("المتاح"), "النصّ يعرض المتاح (لا فعل): {t}");
        }
        // والحالة الصادقة لكل جواب: لا تبديل، أو لغة غير متوفّرة.
        assert!(
            lang_text(Some("ar")).contains("لا تغيير"),
            "اللغة العاملة أصلاً: يُقال إنها لا تغيير: {}",
            lang_text(Some("ar"))
        );
        assert!(
            lang_text(Some("en")).contains("لا تتوفّر لغة"),
            "{}",
            lang_text(Some("en"))
        );
        // والوصف المُسجَّل في تلغرام يقول الحقيقة نفسها (لا قائمتان تفترقان).
        let described = COMMANDS
            .iter()
            .find(|(c, _)| *c == "lang")
            .map(|(_, d)| *d)
            .unwrap_or("");
        assert!(
            described.contains("العربية وحدها"),
            "وصف الأمر لا يقول إن لغةً واحدة متاحة: {described}"
        );

        // (ب) سلوكي عبر الأمر نفسه: لا أثر — لا رسالة ثانية ولا تغيّر في نصّ /help.
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, _rx) = chan();
        handle_update(&cfg, &mut poll, &ov, &text_msg(7, 601, "/help"), &tx);
        let help_before = sent_texts(&bot).last().cloned().unwrap_or_default();
        bot.clear();
        handle_update(&cfg, &mut poll, &ov, &text_msg(7, 602, "/lang ar"), &tx);
        assert_eq!(
            bot.count("sendMessage"),
            1,
            "أمر /lang أرسل أكثر من جوابه: {:?}",
            sent_texts(&bot)
        );
        assert_eq!(
            bot.count("editMessageText"),
            0,
            "أمر /lang حرّر رسالة (فعلٌ لم يُعلَن)"
        );
        handle_update(&cfg, &mut poll, &ov, &text_msg(7, 603, "/help"), &tx);
        let help_after = sent_texts(&bot).last().cloned().unwrap_or_default();
        assert_eq!(
            help_before, help_after,
            "نصّ المحادثة تغيّر بعد /lang ar — تبديلٌ وقع بلا إعلان"
        );
    }

    /// **العطل (٤-ج)**: تعطيل شرط `Drop` في `CancelButtonGuard` بالكامل ⇒
    /// **302/302 نجحت**، لأن كل مسارات الإنتاج الحالية تُنهي الزرّ صراحةً
    /// (`end`) فالحارس «ضمانة بلا مُفسَد».
    ///
    /// **والحقيقة المعلَنة**: لا فرعَ في `run_job` اليوم يمرّ بالحارس وحده إلا
    /// **الذعر** (فكّ مكدّس) — ولا يُصطنَع ذعرٌ من بيانات `Job`. فالقياس هنا
    /// **على الحارس نفسه**: إسقاطٌ صريح بلا `end` يُزيل الزرّ (فحارسٌ لا يفعله
    /// ساقط)، وبعد `end` لا يُرسل تعديلاً زائداً (فلا يُكرّر ما وقع).
    ///
    /// (مُفسَد محروس: تفريغ جسم `Drop` ⇒ يسقط الفحص الأول؛ وإسقاط فحص
    /// `button_live` ⇒ يسقط الثاني.)
    #[test]
    fn the_cancel_button_guard_removes_the_button_when_no_branch_did() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let msg = 4401;
        let cancel = Arc::new(AtomicBool::new(false));
        let status = std::cell::RefCell::new(StatusMsg::new(7, 7, msg, cancel));
        status
            .borrow_mut()
            .set(&cfg, "🎛️ فصل الصوت… 10%".into(), true);
        assert_eq!(bot.count("editMessageText"), 1, "لم تُكتب الحالة أصلاً");

        // خروجٌ **بلا `end`** (وهو الذعر في الإنتاج): الحارس وحده يُزيل الزرّ.
        drop(CancelButtonGuard {
            cfg: &cfg,
            status: &status,
        });
        let edits = bot.edited_messages();
        assert_eq!(edits.len(), 2, "الحارس لم يُرسل إزالة الزرّ: {edits:?}");
        assert_eq!(
            edits[1].pointer("/reply_markup/inline_keyboard"),
            Some(&json!([])),
            "اللوحة ليست فارغة صراحةً: {}",
            edits[1]
        );
        assert_eq!(
            edits[1].get("text").and_then(Value::as_str),
            Some("🎛️ فصل الصوت… 10%"),
            "الحارس غيّر النصّ بدل أن يُزيل الزرّ وحده"
        );

        // وبعد `end` (إزالة صريحة) لا يُرسل الحارس تعديلاً زائداً.
        let msg2 = 4402;
        let cancel2 = Arc::new(AtomicBool::new(false));
        let status2 = std::cell::RefCell::new(StatusMsg::new(7, 7, msg2, cancel2));
        status2
            .borrow_mut()
            .set(&cfg, "🎛️ فصل الصوت… 20%".into(), true);
        status2.borrow_mut().end(&cfg, "✅ تم".into());
        let before = edit_texts_on(&bot, msg2).len();
        assert_eq!(before, 2, "بدءٌ ثم نهاية: {before}");
        drop(CancelButtonGuard {
            cfg: &cfg,
            status: &status2,
        });
        assert_eq!(
            edit_texts_on(&bot, msg2).len(),
            before,
            "الحارس أرسل تعديلاً بعد نهاية صريحة (تكرار بلا معنى)"
        );
        // والرسالة الثانية لم تُلمس من الحارس الأول.
        assert!(
            edit_texts_on(&bot, msg2).last().unwrap().contains('✅'),
            "نصّ النهاية تغيّر"
        );
    }

    /// **العطل (٤-د)**: `StatusMsg::end` يمرّر **الزرّ** بدل اللوحة الفارغة ⇒
    /// يبقى زرّ إلغاء كاذب على مهمّة منتهية (ضغطُه يقول «لا مهمّة جارية»).
    ///
    /// **القياس على مسار الحالة نفسه**: تعديلات العمل تحمل الزرّ، والتعديل
    /// **النهائي** يحمل `inline_keyboard: []` **صراحةً** — ولا تعديل بعده.
    ///
    /// (مُفسَد محروس: `end` يمرّر `cancel_button` ⇒ يسقط هذا الفحص.)
    #[test]
    fn the_final_edit_passes_an_explicitly_empty_keyboard() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let msg = 5101;
        let status =
            std::cell::RefCell::new(StatusMsg::new(7, 7, msg, Arc::new(AtomicBool::new(false))));
        status
            .borrow_mut()
            .set(&cfg, "🎛️ فصل الصوت… 40%".into(), true);
        status.borrow_mut().end(&cfg, "✅ تم".into());

        let edits = bot.edited_messages();
        assert_eq!(edits.len(), 2, "تعديلان: أثناء العمل ثم النهائي: {edits:?}");
        assert_eq!(
            edits[0]
                .pointer("/reply_markup/inline_keyboard/0/0/callback_data")
                .and_then(Value::as_str),
            Some("cancel:7:7"),
            "تعديل أثناء العمل بلا زرّ الإلغاء: {}",
            edits[0]
        );
        assert_eq!(
            edits[1].pointer("/reply_markup/inline_keyboard"),
            Some(&json!([])),
            "الإنهاء لم يمرّر لوحة فارغة صراحةً (زرّ كاذب على مهمّة منتهية): {}",
            edits[1]
        );
        assert!(
            edits[1]["text"].as_str().unwrap_or("").contains('✅'),
            "نصّ النهاية ليس نصّ النهاية: {}",
            edits[1]
        );
    }

    /// **العطل (ع٤)**: ضغطة على **نسخة قديمة** من سؤال الوضع. و`/mode` يُنشئ
    /// سؤالاً جديداً **ولا يمحو القديم**، فيبقى زرّه على الشاشة — وكانت ضغطته
    /// تُقبل، فيصير معرّف الرسالة القديمة **مرجعَ الحالة**: تُحرَّر رسالةٌ منسيّة
    /// ويبقى السؤال الحيّ بأزراره (ولا يرى المستخدم ما يجري).
    ///
    /// **القياس**: (أ) الضغطة القديمة تُجاب بصدق ولا تُحرَّر ولا تُسحب المعلَّق
    /// ولا تنطلق مهمّة، (ب) والضغطة على الرسالة الحيّة تعمل ومرجع الحالة هو
    /// **الرسالة الحيّة** بالذات.
    ///
    /// (مُفسَد محروس: إزالة مطابقة `ask_msg_id` ⇒ الضغطة القديمة تُحرَّر ⇒ يسقط.)
    #[test]
    fn a_press_on_an_old_question_never_moves_the_status_anchor() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        // محادثة بعينها لهذا الفحص (٥٥): صفوف `telegram-jobs` عامّة للعملية،
        // فمحادثةٌ مشتركة مع فحصٍ آخر تعني قياساً على صفوف غيره.
        let cfg = bot.cfg(55);
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, rx) = chan();

        // ملف يصل ⇒ سؤالٌ في رسالة، ثم `/mode` يعيد الأزرار في رسالة جديدة.
        handle_update(&cfg, &mut poll, &ov, &file_msg(55, 61, "old.mp4"), &tx);
        let token = mode_tokens(&bot).remove(0);
        let first_ask = bot.sent_message_ids()[0];
        handle_update(&cfg, &mut poll, &ov, &text_msg(55, 62, "/mode"), &tx);
        let asks = bot.sent_message_ids();
        assert_eq!(asks.len(), 2, "سؤالان (الوصول ثم إعادة العرض): {asks:?}");
        let live_ask = *asks.last().unwrap();
        assert_ne!(first_ask, live_ask, "إعادة العرض لم تُنشئ رسالة جديدة");
        let row_id = poll.pending.for_user(55, 55)[0].row_id;

        // (أ) الضغطة على **القديمة**: صمتٌ عن التحرير وصدقٌ في الجواب.
        bot.clear();
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &press(55, first_ask, &format!("mode:song:{token}")),
            &tx,
        );
        assert_eq!(
            bot.count("editMessageText"),
            0,
            "حُرِّرت رسالة سؤال قديم فصارت مرجع الحالة"
        );
        assert_eq!(
            poll.pending.count_for(55),
            1,
            "سُحب المعلَّق بضغطةٍ مرفوضة (يضيع الملف)"
        );
        assert!(rx.try_recv().is_err(), "انطلقت مهمّة من ضغطة على سؤال قديم");
        let answers: Vec<String> = bot
            .bodies("answerCallbackQuery")
            .iter()
            .filter_map(|b| serde_json::from_str::<Value>(b).ok())
            .filter_map(|v| v.get("text").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert!(
            answers.iter().any(|a| a.contains("سؤال قديم")),
            "الضغطة القديمة لم تُجَب بصدق: {answers:?}"
        );

        // (ب) والضغطة على **الحيّة**: تعمل، ومرجع الحالة هو الرسالة الحيّة.
        bot.clear();
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &press(55, live_ask, &format!("mode:clip:{token}")),
            &tx,
        );
        let job = rx.try_recv().expect("مهمّة الاختيار لم تصل القناة");
        assert_eq!(
            job.status_msg_id, live_ask,
            "مرجع الحالة ليس الرسالة التي ضُغط عليها"
        );
        let edits = bot.edited_messages();
        assert_eq!(edits.len(), 1, "تحريرٌ واحد (إشعار الانتظار): {edits:?}");
        assert_eq!(
            edits[0].get("message_id").and_then(Value::as_i64),
            Some(live_ask),
            "التحرير وقع على رسالةٍ غير المضغوطة: {}",
            edits[0]
        );
        assert_eq!(poll.pending.count_for(55), 0, "المعلَّق لم يُسحب بعد الاختيار");
        // تنظيف: صفّ `telegram-jobs` الذي سجّله الوصول لا يبقى لفحصٍ آخر
        // (السِجلّ عامّ للعملية، والصفّ يُبَثّ مرّةً ثم يُزال عند الانتهاء).
        jobs_finished(row_id, false);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  م٤ — المجموعات: قائمة السماح · المصادقة · الطوابير · الأوامر
    //  · الفانية والسقوط · رسالة التعريف · الوضعان
    //
    //  كلٌّ من هذه الفحوص له **مُفسَد** أثبته المشرف بيده (في التقرير): يُعبَّث
    //  الشرط فيسقط الفحص، ثم يُستعاد الملف ببصمته.
    // ═══════════════════════════════════════════════════════════════════════

    /// ينتظر فراغ طابور الإرسال.
    ///
    /// **م٤**: الإرسال في المجموعة **غير متزامن** (يستهلكه خيط الكاتب)، فالفحص
    /// الذي يقرأ ما وصل الخادم يجب أن ينتظر الكاتب — وإلا قاس «لم يُرسَل بعد»
    /// وقرأه «لم يُرسَل». وهو انتظارُ **الفحص** لا المنتَج.
    fn drain_sends() {
        assert!(
            wait_sends(Duration::from_secs(60)),
            "طابور الإرسال لم يفرغ خلال المهلة"
        );
    }

    /// مشغّل مهامّ حقيقي بسقفٍ صريح: نفس `spawn_job_thread` الإنتاجي (خيط
    /// استقبال + عاملان)، فما يُقاس هو الجدولة الفعلية لا شبيهٌ لها.
    fn spawn_dispatcher(
        cfg: TgConfig,
        limit: u32,
    ) -> (Sender<Job>, Arc<AtomicBool>, Arc<JobQueue>) {
        let (tx, rx) = mpsc::channel::<Job>();
        let stop = Arc::new(AtomicBool::new(false));
        let queue = Arc::new(JobQueue::new(limit));
        spawn_job_thread(cfg, stop.clone(), rx, new_oversize_store(), queue.clone());
        (tx, stop, queue)
    }

    /// مهمّة ملفٍّ لمستخدمٍ بعينه في مجموعة.
    fn group_job(chat_id: i64, user_id: i64, status_msg_id: i64, name: &str) -> Job {
        Job {
            chat_id,
            user_id,
            user: format!("عضو{user_id}"),
            source: Source::File {
                file_id: format!("F{user_id}"),
                name: name.into(),
                size: 0,
            },
            mode: Mode::Song,
            src_msg_id: 900 + user_id,
            status_msg_id,
            file: name.into(),
            row_id: jobs_arrived(chat_id, &format!("عضو{user_id}"), name),
        }
    }

    /// المهامّ الحيّة لهذه المحادثة في **السِجلّ العام** (‏`slots`) — مصدر
    /// مستقلّ عن عدّادات الطابور، فلا يقيس الفحص عدّاده بنفسه.
    fn live_jobs_in(chat_id: i64) -> Vec<slots::JobInfo> {
        let prefix = chat_label_prefix(chat_id);
        slots::active_jobs()
            .into_iter()
            .filter(|j| j.label.starts_with(&prefix))
            .collect()
    }

    fn cancelled_job(id: u64) -> bool {
        slots::active_jobs()
            .into_iter()
            .find(|j| j.id == id)
            .map(|j| j.cancelled)
            .unwrap_or(false)
    }

    /// عدد رسائل الحالة التي **انتهت** (تعديلٌ نهائي بلوحة فارغة) — علامة
    /// انتهاءٍ يوزّعها الخادم نفسه، فلا تُقاس بعدّاد الطابور.
    fn finished_status_messages(bot: &FakeBot) -> usize {
        let mut ids: Vec<i64> = bot
            .edited_messages()
            .iter()
            .filter(|e| e.pointer("/reply_markup/inline_keyboard") == Some(&json!([])))
            .filter_map(|e| e.get("message_id").and_then(Value::as_i64))
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids.len()
    }

    /// ترتيب **بدء** المهامّ كما وصل الخادم: أول كتابة «▶ بدأت المعالجة» على
    /// كل رسالة حالة.
    fn started_status_messages(bot: &FakeBot) -> Vec<i64> {
        let mut started: Vec<i64> = Vec::new();
        for e in bot.edited_messages() {
            let text = e.get("text").and_then(Value::as_str).unwrap_or("");
            if text.starts_with('▶') {
                if let Some(mid) = e.get("message_id").and_then(Value::as_i64) {
                    if !started.contains(&mid) {
                        started.push(mid);
                    }
                }
            }
        }
        started
    }

    // ── ت١: غير المسموح لا يُشغّل مهمّة ──────────────────────────────────────

    /// **ت١**: عضوٌ في مجموعة ليس في قائمة السماح **لا يُشغّل مهمّة** — ولا
    /// يُسأل عن الوضع، ولا يُسجَّل ملفٌّ معلَّق، ولا تصل القناة مهمّة. ويُردّ
    /// عليه **برسالة واحدة موجزة** لا بصمت (تصميم §٢-٣).
    ///
    /// **ولا يمرّ الفحص بفراغ**: بعد إضافة الزوج إلى القائمة يعمل الطلب نفسه —
    /// فالقياس «مُنع ثم سُمح»، لا «لم يقع شيء».
    #[test]
    fn t1_a_member_outside_the_allowlist_never_starts_a_job() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg_group(7, GroupMode::Mentions);
        let mut poll = group_poll("MyBot", 99, &[]);
        let ov = new_oversize_store();
        let (tx, rx) = chan();

        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &group_msg(55, -101, 11, "@MyBot https://youtu.be/aaaa"),
            &tx,
        );
        drain_sends();
        assert!(
            mode_questions_to(&bot, -101).is_empty(),
            "غير المسموح سُئل عن الوضع ⇒ بدأت معالجة على جهاز المالك"
        );
        assert_eq!(poll.pending.count_for(-101), 0, "معلَّقٌ سُجّل لغير مسموح");
        assert!(rx.try_recv().is_err(), "مهمّة انطلقت من عضوٍ غير مسموح");
        assert!(
            !sent_to(&bot, -101).is_empty(),
            "غير المسموح قوبل بصمت تام — الصمت يجعل البوت يبدو معطّلاً"
        );

        // **رسالة واحدة**: تكرار الطلب — رابطاً كان أو ملفاً — لا يُنتج سيلاً.
        let first = sent_to(&bot, -101).len();
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &group_msg(55, -101, 12, "@MyBot https://youtu.be/bbbb"),
            &tx,
        );
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &group_file(55, -101, 13, "song.mp4"),
            &tx,
        );
        drain_sends();
        assert_eq!(
            sent_to(&bot, -101).len(),
            first,
            "أُعيدت رسالة «غير مسموح» — المطلوب واحدة موجزة"
        );
        assert_eq!(poll.pending.count_for(-101), 0, "ملفٌّ سُجّل لغير مسموح");

        // **والضابط**: نفس الطلب من عضوٍ مسموح يعمل (فالمنع سببه القائمة).
        poll.access.allow(-101, 55);
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &group_msg(55, -101, 14, "@MyBot https://youtu.be/cccc"),
            &tx,
        );
        drain_sends();
        assert_eq!(
            mode_questions_to(&bot, -101).len(),
            1,
            "المسموح لم يُسأل عن الوضع ⇒ القائمة تمنع الجميع لا غير المسموح"
        );
        assert_eq!(poll.pending.count_for(-101), 1);
    }

    // ── ت٢ · ت٥: مصادقة كل ضغطة، وإلغاء لا يمسّ غيره ────────────────────────

    /// **ت٢**: ضغطةٌ من **غير صاحب المهمّة** تُرفض ولا تُلغي شيئاً؛ وصاحبها
    /// يُلغيها، **والمالك** يُلغيها نيابةً. والثلاثة تُقاس على سِجلّ المهامّ
    /// الحقيقي (‏`cancelled`)، لا على نصّ جواب.
    #[test]
    fn t2_a_cancel_press_is_authenticated_against_the_owner_of_the_job() {
        let _reg = crate::slots::registry_test_lock();
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg_group(7, GroupMode::Mentions);
        let mut poll = group_poll("MyBot", 99, &[]);
        let ov = new_oversize_store();
        let (tx, _rx) = chan();

        let mine = slots::register_early(&job_label(-102, 55), None);
        let mine_id = mine.id();
        let button = "cancel:-102:55";

        // ① غريب (٦٦) يضغط زرّ ٥٥ ⇒ رفض، والمهمّة كما هي.
        handle_update(&cfg, &mut poll, &ov, &press_in(66, -102, 1001, button), &tx);
        assert!(
            !cancelled_job(mine_id),
            "غريبٌ ألغى مهمّة غيره — المصادقة غائبة"
        );
        assert_eq!(
            callback_answers(&bot).last().map(String::as_str),
            Some("هذا الزرّ ليس لك"),
            "الرفض يجب أن يُقال صراحةً: {:?}",
            callback_answers(&bot)
        );

        // ② وصاحبها يضغط ⇒ الإلغاء يقع فعلاً.
        handle_update(&cfg, &mut poll, &ov, &press_in(55, -102, 1001, button), &tx);
        assert!(cancelled_job(mine_id), "صاحب المهمّة لم يُلغِ مهمّته");
        drop(mine);

        // ③ والمالك يضغط زرّ غيره ⇒ مقبول (تصميم §٣: «صاحب المهمّة **أو** المالك»).
        let other = slots::register_early(&job_label(-102, 66), None);
        let other_id = other.id();
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &press_in(7, -102, 1002, "cancel:-102:66"),
            &tx,
        );
        assert!(cancelled_job(other_id), "المالك مُنع من إلغاء مهمّة عضوه");
        drop(other);
    }

    /// **ت٥**: إيقافُ أحدهم **لا يمسّ** مهمّة غيره — والفرق بين `cancel_job`
    /// و`cancel_all` هو هذا الفحص بعينه (والأخير يُسقطه فوراً).
    #[test]
    fn t5_cancelling_one_user_never_touches_anothers_jobs() {
        let _reg = crate::slots::registry_test_lock();
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg_group(7, GroupMode::Mentions);
        let mut poll = group_poll("MyBot", 99, &[]);
        let ov = new_oversize_store();
        let (tx, _rx) = chan();

        let a = slots::register_early(&job_label(-103, 55), None);
        let b = slots::register_early(&job_label(-103, 66), None);
        let (a_id, b_id) = (a.id(), b.id());
        assert_ne!(a_id, b_id);

        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &press_in(55, -103, 1003, "cancel:-103:55"),
            &tx,
        );
        assert!(cancelled_job(a_id), "مهمّة الضاغط لم تُلغَ");
        assert!(
            !cancelled_job(b_id),
            "إلغاء مستخدمٍ ألغى مهمّة غيره — cancel_all بدل cancel_job"
        );
        // ومهمّةٌ في **محادثة أخرى** لم تُمسّ أيضاً (الوسم يحمل المحادثة).
        let c = slots::register_early(&job_label(-203, 55), None);
        let c_id = c.id();
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &press_in(55, -103, 1004, "cancel:-103:55"),
            &tx,
        );
        assert!(!cancelled_job(c_id), "الإلغاء تعدّى حدود المحادثة");
        drop((a, b, c));
    }

    /// زرّ الإلغاء **يحمل صاحبه**: الشكل القديم بلا صاحب لا يُقبل — لأن قبوله
    /// يعني إلغاء مهامّ كل من في المحادثة.
    #[test]
    fn the_cancel_button_data_always_carries_its_owner() {
        assert_eq!(parse_cancel_button("cancel:-100:55"), Some((-100, 55)));
        assert_eq!(parse_cancel_button("cancel:7:7"), Some((7, 7)));
        assert_eq!(
            parse_cancel_button("cancel:7"),
            None,
            "شكلٌ بلا صاحب لا يمكن مصادقته"
        );
        assert_eq!(parse_cancel_button("cancel:-100:55:9"), None);
        assert_eq!(parse_cancel_button("mode:song:tok"), None);
        assert_eq!(parse_cancel_button(""), None);
        let kb = cancel_button(-100, 55);
        assert_eq!(
            kb.pointer("/inline_keyboard/0/0/callback_data")
                .and_then(Value::as_str),
            Some("cancel:-100:55"),
            "الزرّ لا يحمل صاحبه: {kb}"
        );
    }

    // ── ت٣ · ت٤: الطابور لكل مستخدم والسقف العام ────────────────────────────

    /// **ت٣**: مستخدمان يعملان **متوازيين** والسقف ٢، والسقف **محترم**.
    ///
    /// القياس على المسار الإنتاجي كاملاً: `spawn_job_thread` الحقيقي، و`run_job`
    /// الحقيقي (الخادم الوهمي يُبطئ `getFile` ٤٠٠ مللي فنافذة التوازي قائمة)،
    /// والعدّ من **سِجلّ المهامّ العام** لا من عدّاد الطابور.
    ///
    /// والمُفسَد الذي يُسقطه: سقفٌ لا يُفحص (‏٣ مستخدمين ⇒ ذروة ٣).
    #[test]
    fn t3_two_users_run_in_parallel_up_to_the_global_cap() {
        let _serial = crate::paths::serial_guard();
        let _env = crate::paths::env_restore("HARAMLITE_DATA_DIR");
        let base = temp_dir("m4_parallel");
        std::env::set_var("HARAMLITE_DATA_DIR", &base);
        let _reg = crate::slots::registry_test_lock();
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);

        for cap in [2u32, 1u32] {
            reset_counters();
            bot.clear();
            let (tx, stop, queue) = spawn_dispatcher(cfg.clone(), cap);
            for user in [55i64, 66, 77] {
                // رسالة حالة لكل مستخدم: بها يُقاس **انتهاء** المهمّة من
                // الخادم نفسه، لا من عدّاد الطابور (فلا يسبق الانتظارُ التنفيذَ).
                tx.send(group_job(-111, user, 2000 + user, &format!("u{user}.mp4")))
                    .expect("القناة مفتوحة");
            }
            // نراقب الذروة من السِجلّ العام حتى تنتهي المهامّ الثلاث فعلاً.
            let mut peak = 0usize;
            let deadline = Instant::now() + Duration::from_secs(60);
            while Instant::now() < deadline {
                peak = peak.max(live_jobs_in(-111).len());
                if finished_status_messages(&bot) == 3 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            stop.store(true, Ordering::SeqCst);
            queue.shutdown();
            assert_eq!(
                finished_status_messages(&bot),
                3,
                "لم تنتهِ المهامّ الثلاث (السقف {cap})"
            );
            if cap == 2 {
                assert!(
                    peak >= 2,
                    "مستخدمون لم يعملوا متوازيين مع سقف ٢ (الذروة {peak}) — طابورٌ عالميّ واحد"
                );
            }
            assert!(
                peak <= cap as usize,
                "الذروة {peak} تجاوزت السقف العام {cap} — البطاقة غير محميّة"
            );
            eprintln!("م٤/توازٍ: السقف {cap} ⇒ الذروة المقيسة {peak}");
        }
    }

    /// **ت٤**: مستخدمٌ بأربعة ملفات **لا يعطّل غيره**.
    ///
    /// القياس **ترتيب البدء الفعلي** كما وصل الخادمَ: كل مهمّة تكتب «▶ بدأت
    /// المعالجة» على رسالة حالتها، فترتيب تلك الكتابات هو ترتيب الجدولة.
    /// والمتوقَّع: ملفات أ ثم ملف ب ثم بقيّة ملفات أ — لا ب في الذيل.
    #[test]
    fn t4_a_user_with_four_files_does_not_block_another_user() {
        let _serial = crate::paths::serial_guard();
        let _env = crate::paths::env_restore("HARAMLITE_DATA_DIR");
        let base = temp_dir("m4_fairness");
        std::env::set_var("HARAMLITE_DATA_DIR", &base);
        let _reg = crate::slots::registry_test_lock();
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        // **الطابور يُمتلأ قبل أن يبدأ أي عامل**: فيقيس الفحص ترتيب الدور لا
        // سباق وصول الطلبات (وهو ما يجعل «ب في الذيل» نتيجةً لا صدفة).
        let queue = Arc::new(JobQueue::new(1));
        for (i, name) in ["a1.mp4", "a2.mp4", "a3.mp4", "a4.mp4"].iter().enumerate() {
            queue.push(group_job(-112, 55, 1000 + i as i64, name));
        }
        queue.push(group_job(-112, 66, 2000, "b1.mp4"));
        assert_eq!(queue.waiting(), 5, "الطابور لم يُمتلأ قبل البدء");
        let stop = Arc::new(AtomicBool::new(false));
        spawn_job_workers(
            cfg.clone(),
            stop.clone(),
            new_oversize_store(),
            queue.clone(),
        );

        // ننتظر **البدء الفعلي للخمسة** (والسقف ١ ⇒ كلٌّ يبدأ بعد انتهاء سابقه).
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline && started_status_messages(&bot).len() < 5 {
            std::thread::sleep(Duration::from_millis(5));
        }
        // ثم انتهاءها — والشutdown بعد ذلك حتى لا تُقطع الخامسة في منتصفها.
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline && finished_status_messages(&bot) < 5 {
            std::thread::sleep(Duration::from_millis(5));
        }
        stop.store(true, Ordering::SeqCst);
        queue.shutdown();

        // ترتيب البدء = ترتيب أول كتابة «▶ بدأت المعالجة» على كل رسالة حالة.
        let started = started_status_messages(&bot);
        assert_eq!(started.len(), 5, "لم تبدأ المهامّ الخمس: {started:?}");
        assert_eq!(
            started[..2].to_vec(),
            vec![1000, 2000],
            "ملفات المستخدم الأول حجبت الثاني عن الدور: {started:?}"
        );
        assert_eq!(
            started,
            vec![1000, 2000, 1001, 1002, 1003],
            "الترتيب ليس دوراً بين المستخدمين مع FIFO لكل مستخدم: {started:?}"
        );
        assert_eq!(
            finished_status_messages(&bot),
            5,
            "لم تنتهِ المهامّ الخمس رغم بدئها"
        );
        eprintln!("م٤/إنصاف: ترتيب البدء المقيس {started:?} (أ×٤ ثم ب×١ · السقف ١)");
    }

    /// الطابور نفسه **نقيّاً**: دورٌ بين المستخدمين، وFIFO داخل المستخدم،
    /// والسقف لا يُتجاوز، والإيقاف يفتح كل منتظر.
    #[test]
    fn the_queue_is_fifo_per_user_and_round_robin_between_users() {
        let q = JobQueue::new(1);
        for name in ["a1", "a2", "a3", "a4"] {
            q.push(group_job(-100, 55, 0, name));
        }
        q.push(group_job(-100, 66, 0, "b1"));
        let mut order = Vec::new();
        for _ in 0..5 {
            let job = q.pop().expect("مهمّة متاحة");
            order.push(job.file.clone());
            // **الفتحة تُحرَّر** كي يقيس الفحص الترتيب لا السقف (والسقف يقيسه
            // الفحص التالي في الأسفل).
            q.finish_one();
        }
        assert_eq!(order, vec!["a1", "b1", "a2", "a3", "a4"], "ترتيب الدور");
        // والسقف: مع فتحةٍ مشغولة لا يخرج شيء (و`waiting` تحدّد أنّ الانتظار لا
        // يعني فقدان المهمّة).
        let q2 = JobQueue::new(1);
        q2.push(group_job(-100, 55, 0, "x"));
        q2.push(group_job(-100, 66, 0, "y"));
        let _first = q2.pop().unwrap();
        assert_eq!(q2.waiting(), 1, "المهمّة الثانية ضاعت");
        assert_eq!(q2.running(), 1);
        q2.finish_one();
        assert_eq!(q2.pop().unwrap().file, "y");
        q2.shutdown();
        assert!(q2.pop().is_none(), "الإيقاف لم يفتح المنتظر");
    }

    // ── ت٧: الأوامر في المجموعة ─────────────────────────────────────────────

    /// **ت٧**: `/kill` و`/status` **للمالك وحده في المجموعة** — تُرفض لغير
    /// المالك ولا تُنفَّذ، والقائمة العامة صفر فلا يُعلَن أمرٌ يُرفض.
    #[test]
    fn t7_owner_only_commands_are_refused_for_members_in_a_group() {
        let _reg = crate::slots::registry_test_lock();
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg_group(7, GroupMode::Mentions);
        // العضو **مسموح** — فالرفض سببه الأمر لا القائمة (وهو ما يقيسه ت٧).
        let mut poll = group_poll("MyBot", 99, &[(-104, 55)]);
        let ov = new_oversize_store();
        let (tx, _rx) = chan();

        let job = slots::register_early(&job_label(-104, 55), None);
        let job_id = job.id();

        for (i, cmd) in ["/kill", "/status"].iter().enumerate() {
            handle_update(
                &cfg,
                &mut poll,
                &ov,
                &group_msg(55, -104, 30 + i as i64, cmd),
                &tx,
            );
        }
        assert!(
            !cancelled_job(job_id),
            "عضوٌ نفّذ /kill على مهمّته ⇒ الأمر لم يُرفض"
        );
        drain_sends();
        let replies = sent_to(&bot, -104);
        assert_eq!(replies.len(), 2, "كل أمرٍ يُجاب: {replies:?}");
        for r in &replies {
            assert!(
                r["text"].as_str().unwrap_or("").contains("للمالك وحده"),
                "الرفض غير صريح: {r}"
            );
            assert!(
                !r["text"].as_str().unwrap_or("").contains("📊 الحال"),
                "‏/status نُفِّذ لعضو: {r}"
            );
        }

        // **والضابط**: المالك نفسه يُنفَّذ أمره — ويوقف مهامّ محادثته كلها
        // (ومهامّ غيره في محادثةٍ **أخرى** لا تُمسّ: هذا فرقُه عن `cancel_all`).
        let elsewhere = slots::register_early(&job_label(-204, 55), None);
        let elsewhere_id = elsewhere.id();
        bot.clear();
        handle_update(&cfg, &mut poll, &ov, &group_msg(7, -104, 40, "/kill"), &tx);
        assert!(cancelled_job(job_id), "المالك مُنع من /kill في مجموعته");
        assert!(
            !cancelled_job(elsewhere_id),
            "‏/kill تعدّى المحادثة — cancel_all بدل cancel_job"
        );
        drop((job, elsewhere));

        // والقائمة: المالك يرى `/kill`، والعضو لا يراه.
        assert!(help_text_for(true).contains("/kill"));
        assert!(help_text_for(true).contains("/status"));
        assert!(!help_text_for(false).contains("/kill"));
        assert!(!help_text_for(false).contains("/status"));
    }

    // ── ت٨: الفانية غير مدعومة ⇒ السقوط لا الفشل ────────────────────────────

    /// **ت٨**: الرسالة الفانية **تحسينٌ لا عماد**. وشكلها تغيّر بين 10.2
    /// و10.3، فالكود يجرّب الشكلين ثم يسقط إلى **الخاص** ثم إلى المحادثة —
    /// ولا يُسقِط التنبيه أبداً.
    ///
    /// **والقياس على الأثر لا على قيمةٍ مُعادة** (م٤): السلسلة تُسلك على **خيط
    /// الكاتب**، فما يُقاس هو **أيّ محادثةٍ وصلها النصّ فعلاً** — وهو ما يراه
    /// العضو، وأقوى من قراءة قيمةٍ من دالّة.
    #[test]
    fn t8_when_ephemeral_is_unsupported_the_notice_falls_back_instead_of_failing() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg_group(7, GroupMode::Mentions);
        let drain = || assert!(wait_sends(Duration::from_secs(40)), "الطابور لم يفرغ");

        // ① الشكلان مرفوضان (‏10.3 و10.2) ⇒ **الخاص**، وقد وقع فعلاً.
        bot.reject_containing(EPHEMERAL_PARAMS_V10_3);
        bot.reject_containing(EPHEMERAL_PARAMS_V10_2);
        assert!(
            notify_member(&cfg, -105, 55, "نصّ التنبيه"),
            "لم يُدرَج التنبيه"
        );
        drain();
        assert!(
            sent_to(&bot, 55).iter().any(|m| m["text"] == "نصّ التنبيه"),
            "غياب دعم الفانية لم يسقط إلى الخاص: {:?}",
            bot.sent_messages()
        );

        // ② والخاص نفسه مرفوض (العضو لم يبدأ محادثة) ⇒ **المحادثة**، بلا فشل.
        bot.clear();
        bot.reject_chat_id(55);
        assert!(notify_member(&cfg, -105, 55, "نصّ ثانٍ"));
        drain();
        assert!(
            sent_to(&bot, -105)
                .iter()
                .any(|m| m["text"].as_str().unwrap_or("").contains("نصّ ثانٍ")),
            "التنبيه ضاع تماماً — فشلٌ صامت"
        );

        // ③ ولا رفض ⇒ الفانية نفسها، وبالشكل **الأحدث** (‏10.3) لا القديم —
        //    **ونجحت من أول محاولة**: لا نداء خاصّ ولا رسالة في المحادثة.
        let fresh = FakeBot::start();
        let cfg2 = fresh.cfg_group(7, GroupMode::Mentions);
        assert!(notify_member(&cfg2, -105, 55, "فانية"));
        drain();
        let bodies = fresh.bodies("sendMessage");
        assert_eq!(bodies.len(), 1, "أكثر من محاولةٍ واحدة: {bodies:?}");
        let v: Value = serde_json::from_str(&bodies[0]).unwrap();
        assert_eq!(
            v.pointer("/ephemeral_message_parameters/receiver_user_id")
                .and_then(Value::as_i64),
            Some(55),
            "الشكل الأحدث هو ما يُجرَّب أولاً: {v}"
        );
        assert!(
            v.get(EPHEMERAL_PARAMS_V10_2).is_none(),
            "الشكلان معاً في طلبٍ واحد: {v}"
        );

        // ④ و10.3 وحدها مرفوضة ⇒ يجرّب 10.2 بنجاح (الشكل مُكتشَف لا مثبَّت).
        let legacy = FakeBot::start();
        legacy.reject_containing(EPHEMERAL_PARAMS_V10_3);
        let cfg3 = legacy.cfg_group(7, GroupMode::Mentions);
        assert!(notify_member(&cfg3, -105, 55, "قديمة"));
        drain();
        let bodies = legacy.bodies("sendMessage");
        assert_eq!(bodies.len(), 2, "لم تُجرَّب الصيغتان: {bodies:?}");
        let v2: Value = serde_json::from_str(&bodies[1]).unwrap();
        assert_eq!(
            v2.get(EPHEMERAL_PARAMS_V10_2).and_then(Value::as_i64),
            Some(55),
            "لم يُجرَّب شكل 10.2 بعد رفض 10.3: {v2}"
        );
    }

    // ── ت٩: رسالة التعريف تُثبَّت مرة واحدة ─────────────────────────────────

    /// **ت٩**: رسالة التعريف تُثبَّت **عند الإضافة مرة واحدة** — لا مع كل رسالة.
    /// والعدّ من الخادم نفسه (`pinChatMessage` و`sendMessage`).
    #[test]
    fn t9_the_intro_is_pinned_once_at_the_moment_the_bot_is_added() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg_group(7, GroupMode::Mentions);
        let mut poll = group_poll("MyBot", 99, &[(-106, 55)]);
        let ov = new_oversize_store();
        let (tx, _rx) = chan();

        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &bot_joined(-106, "left", "member"),
            &tx,
        );
        drain_sends();
        assert_eq!(bot.count("pinChatMessage"), 1, "لم تُثبَّت رسالة التعريف");
        let intro = sent_to(&bot, -106);
        assert_eq!(intro.len(), 1, "أُرسلت رسالة التعريف أكثر من مرة");
        let text = intro[0]["text"].as_str().unwrap_or("");
        assert_eq!(text.lines().count(), 2, "النصّ سطران كما في التصميم: {text}");
        assert!(text.contains("@MyBot"), "معرّف البوت مذكور: {text}");
        assert!(
            text.contains("جهاز المالك"),
            "المعالجة على جهاز المالك: {text}"
        );

        // **عشر رسائل عادية** لا تُثبّت شيئاً آخر — هذا هو المُفسَد المحروس.
        for i in 0..10 {
            handle_update(
                &cfg,
                &mut poll,
                &ov,
                &group_msg(55, -106, 100 + i, "@MyBot https://youtu.be/x"),
                &tx,
            );
        }
        // وتحديث إضافةٍ ثانٍ لا يُعيد الكرّ أيضاً.
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &bot_joined(-106, "left", "administrator"),
            &tx,
        );
        drain_sends();
        assert_eq!(
            bot.count("pinChatMessage"),
            1,
            "رسالة التعريف ثُبّتت أكثر من مرة عند الإضافة"
        );
        assert_eq!(
            sent_to(&bot, -106)
                .iter()
                .filter(|m| m["text"].as_str().unwrap_or("").contains("للاستخدام"))
                .count(),
            1,
            "أُعيد إرسال رسالة التعريف"
        );

        // **ونصيحة المعالج** (م٤/٨) تُبنى على **المقيس** لا على تحليل نظري.
        assert!(cpu_advice_line(Some("CPU")).is_some(), "CPU ⇒ نصيحة");
        assert!(cpu_advice_line(Some("CUDA")).is_none(), "CUDA ليست CPU");
        assert!(cpu_advice_line(Some("DirectML")).is_none());
        assert!(
            cpu_advice_line(None).is_none(),
            "بلا قياس مزوّد لا نصيحة — ولا رقم مُختلق"
        );
        let unknown = intro_text(&BotIdentity::default(), None);
        assert!(
            !unknown.contains("@MyBot"),
            "اختُلق اسم بوت لم يُقرأ: {unknown}"
        );
        assert!(
            intro_text(&BotIdentity::default(), cpu_advice_line(Some("CPU"))).contains("CPU"),
            "نصيحة المعالج لا تظهر في رسالة التعريف"
        );
    }

    // ── الوضعان: mentions-only افتراضاً، والموسَّع بموافقة المالك ─────────────

    /// **الوضع الافتراضي (بالمنشن)**: رسالةٌ في المجموعة لا تخاطب البوت
    /// **صمتٌ مقصود** — لا ردّ ولا معالجة. ومع المنشن تعمل.
    #[test]
    fn mentions_only_silences_a_group_message_that_does_not_address_the_bot() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg_group(7, GroupMode::Mentions);
        let mut poll = group_poll("MyBot", 99, &[(-107, 55)]);
        let ov = new_oversize_store();
        let (tx, _rx) = chan();

        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &group_msg(55, -107, 50, "شوفوا هذا https://youtu.be/zzz"),
            &tx,
        );
        assert_eq!(bot.calls().len(), 0, "البوت ردّ على رسالةٍ لا تخاطبه");
        assert_eq!(poll.pending.count_for(-107), 0);

        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &group_msg(55, -107, 51, "@MyBot https://youtu.be/zzz"),
            &tx,
        );
        drain_sends();
        assert_eq!(mode_questions_to(&bot, -107).len(), 1, "المنشن لم يُعرَف");
    }

    /// كشف المنشن نفسه — بالحالات المتكافئة (ترقيم ملتصق، حالة أحرف، ردّ على
    /// رسالة البوت) وبلا هويةٍ معروفة.
    #[test]
    fn mention_detection_accepts_the_equivalent_spellings_and_refuses_lookalikes() {
        let id = BotIdentity {
            id: 99,
            username: "MyBot".into(),
        };
        // `mentions_bot` تقرأ **رسالة** لا تحديثاً — ومن يمرّر التحديث كاملاً
        // يقيس `None` فيبدو المنشن غير معروف.
        let m = |t: &str| group_msg(55, -100, 1, t)["message"].clone();
        assert!(mentions_bot(&m("@MyBot https://x"), &id));
        assert!(mentions_bot(&m("@mybot https://x"), &id), "حالة الأحرف");
        assert!(mentions_bot(&m("يا @MyBot, شوف"), &id), "ترقيم ملتصق");
        assert!(!mentions_bot(&m("https://x"), &id));
        assert!(!mentions_bot(&m("@OtherBot https://x"), &id));
        assert!(
            !mentions_bot(&m("@MyBotX https://x"), &id),
            "اسمٌ يبدأ بنا ليس اسمنا"
        );
        assert!(
            !mentions_bot(&m("@MyBot https://x"), &BotIdentity::default()),
            "بلا هويةٍ لا يُدَّعى منشن"
        );
        let reply = json!({
            "text": "شكراً",
            "reply_to_message": { "from": { "id": 99 } }
        });
        assert!(mentions_bot(&reply, &id), "الردّ على رسالة البوت منشن");
        let reply_other = json!({
            "text": "شكراً",
            "reply_to_message": { "from": { "id": 100 } }
        });
        assert!(!mentions_bot(&reply_other, &id));
    }

    /// **الوضع الموسَّع**: الرابط بلا منشن يُعرَض على المالك في خاصّه كبطاقة
    /// أزرار ثلاثة، **ولا معالجة قبل ضغطته**، و«اسمح دائماً» تُضيف الزوج إلى
    /// قائمة السماح فيُخدَم الطلب مباشرةً بعدها.
    #[test]
    fn the_expanded_mode_asks_the_owner_before_anything_runs() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg_group(7, GroupMode::All);
        let mut poll = group_poll("MyBot", 99, &[]);
        let ov = new_oversize_store();
        let (tx, _rx) = chan();

        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &group_msg(55, -108, 60, "https://youtu.be/free"),
            &tx,
        );
        // ① بطاقةٌ واحدة في **خاصّ المالك** بأزرارها الثلاثة.
        drain_sends();
        let cards = sent_to(&bot, 7);
        assert_eq!(cards.len(), 1, "لم تُرسَل بطاقة موافقة واحدة: {cards:?}");
        let buttons: Vec<String> = cards[0]
            .pointer("/reply_markup/inline_keyboard/0")
            .and_then(Value::as_array)
            .map(|row| {
                row.iter()
                    .filter_map(|b| {
                        b.get("callback_data")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(buttons.len(), 3, "الأزرار الثلاثة: {buttons:?}");
        assert!(buttons.iter().any(|d| d.starts_with("apv:yes:")));
        assert!(buttons.iter().any(|d| d.starts_with("apv:no:")));
        assert!(buttons.iter().any(|d| d.starts_with("apv:always:")));
        // ② **ولا معالجة**: لا سؤال وضع ولا معلَّق ولا مهمّة.
        assert!(
            mode_questions_to(&bot, -108).is_empty(),
            "عُولج الطلب قبل ضغطة المالك"
        );
        assert_eq!(poll.pending.count_for(-108), 0);
        assert_eq!(poll.approvals.len(), 1);

        // ③ المالك يضغط «♾️ اسمح دائماً».
        let always = buttons
            .iter()
            .find(|d| d.starts_with("apv:always:"))
            .unwrap()
            .clone();
        let card_msg = sent_message_ids_to(&bot, 7)[0];
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &press_in(7, 7, card_msg, &always),
            &tx,
        );
        assert!(
            poll.access.allows(-108, 55, Some(7)),
            "«اسمح دائماً» لم تُضف الزوج إلى قائمة السماح"
        );
        assert_eq!(poll.approvals.len(), 0, "الطلب لم يُستهلك بالقرار");
        drain_sends();
        assert_eq!(
            mode_questions_to(&bot, -108).len(),
            1,
            "لم يُطرح سؤال الوضع بعد الموافقة"
        );

        // ④ **وطلبٌ ثانٍ من العضو نفسه يمرّ مباشرةً**: لا بطاقة ثانية.
        bot.clear();
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &group_msg(55, -108, 61, "https://youtu.be/second"),
            &tx,
        );
        drain_sends();
        assert!(
            sent_to(&bot, 7).is_empty(),
            "بطاقة موافقة ثانية بعد السماح الدائم"
        );
        assert_eq!(
            mode_questions_to(&bot, -108).len(),
            1,
            "الطلب المسموح لم يُسأل عن وضعه"
        );
    }

    /// **ضغطة الموافقة ليست للجميع**: غير المالك لا يقرّر، والطلب يبقى قائماً.
    #[test]
    fn only_the_owner_can_answer_an_approval_card() {
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg_group(7, GroupMode::All);
        let mut poll = group_poll("MyBot", 99, &[]);
        let ov = new_oversize_store();
        let (tx, _rx) = chan();
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &group_msg(55, -109, 70, "https://youtu.be/x"),
            &tx,
        );
        let token = {
            let a = poll.approvals.by_token.keys().next().cloned().unwrap();
            a
        };
        let card = sent_message_ids_to(&bot, 7)[0];
        handle_update(
            &cfg,
            &mut poll,
            &ov,
            &press_in(55, 7, card, &format!("apv:always:{token}")),
            &tx,
        );
        assert_eq!(
            callback_answers(&bot).last().map(String::as_str),
            Some("هذا القرار للمالك وحده")
        );
        assert!(!poll.access.allows(-109, 55, Some(7)), "غريبٌ وسّع القائمة");
        assert_eq!(poll.approvals.len(), 1, "غريبٌ استهلك الطلب");
    }

    /// **قائمة السماح تُحفظ وتُقرأ**، والمفتاح **الزوج** لا العضو، والملف
    /// التالف يعني قائمةً فارغة لا خطأً (الأساس الضيّق يُصلَح بضغطة).
    #[test]
    fn the_allowlist_is_persisted_per_chat_and_user() {
        let dir = temp_dir("access");
        let p = access_path(&dir);
        let _ = std::fs::remove_file(&p);
        let mut a = AccessStore::from_path(p.clone());
        assert_eq!(a.len(), 0);
        assert!(a.allows(-100, 7, Some(7)), "المالك مسموح دائماً بلا مدخل");
        assert!(!a.allows(-100, 55, Some(7)));
        assert!(a.allow(-100, 55), "الإضافة الأولى جديدة");
        assert!(!a.allow(-100, 55), "الإضافة الثانية ليست جديدة");
        a.save().unwrap();

        let b = AccessStore::from_path(p.clone());
        assert_eq!(b.len(), 1);
        assert!(
            b.allows(-100, 55, Some(7)),
            "السماح لم ينجُ من إعادة القراءة"
        );
        assert!(
            !b.allows(-200, 55, Some(7)),
            "السماح تسرّب إلى محادثةٍ أخرى — المفتاح الزوج لا العضو"
        );
        assert!(!b.allows(-100, 66, Some(7)), "السماح تسرّب إلى عضوٍ آخر");

        std::fs::write(&p, "{ ليس JSON").unwrap();
        assert_eq!(
            AccessStore::from_path(p.clone()).len(),
            0,
            "ملفٌ تالف يجب أن يعني قائمةً فارغة لا قائمةً مخترعة"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── سقف إرسال المجموعة (٢٠/دقيقة · رسالة/ثانية) ─────────────────────────

    /// **سقف تلغرام للمجموعة** مفروضٌ في الشيفرة وليس في النيّة: الحصّة
    /// تُقاس بساعةٍ مُمرَّرة (بلا انتظار دقيقة)، **ووصلتها** في `send_message`
    /// تُقاس على الخادم الوهمي (‏سقفٌ غير موصول ليس سقفاً).
    #[test]
    fn the_group_send_cap_is_enforced_and_wired_into_send_message() {
        let _g = state_lock();
        let mut p = SendPacer::default();
        let t0 = Instant::now();
        assert!(p.admit_at(-110, t0), "الأولى تمرّ");
        assert!(
            !p.admit_at(-110, t0 + Duration::from_millis(500)),
            "رسالتان في أقلّ من ثانية"
        );
        for i in 1..GROUP_MSG_PER_MINUTE {
            assert!(
                p.admit_at(-110, t0 + Duration::from_secs(i as u64)),
                "الحصّة انقطعت عند {i}"
            );
        }
        assert!(
            !p.admit_at(-110, t0 + Duration::from_secs(GROUP_MSG_PER_MINUTE as u64)),
            "السقف {GROUP_MSG_PER_MINUTE}/دقيقة تُجوز"
        );
        assert!(
            p.admit_at(-110, t0 + Duration::from_secs(61)),
            "النافذة لا تنزلق ⇒ حجبٌ دائم"
        );
        // والخاص بلا حصّة: السقف سقف **مجموعة**.
        assert!(p.admit_at(7, t0));
        assert!(p.admit_at(7, t0));

        // **الوصلة**: إرسالٌ حقيقي في مجموعة يمرّ من المُنظِّم — **عبر خيط
        // الكاتب** (فلا بدّ من انتظاره: الإدراج وحده لا يستهلك حصّة).
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let t = Instant::now();
        send_message(&cfg, -110, "مرحبا", None, None).unwrap();
        let enqueue = t.elapsed();
        assert!(
            enqueue < Duration::from_millis(200),
            "الإدراج في الطابور انتظر {enqueue:?} — الإرسال ما زال متزامناً"
        );
        send_message(&cfg, 7, "خاص", None, None).unwrap();
        drain_sends();
        let pacer = send_pacer().lock().unwrap_or_else(|e| e.into_inner());
        assert!(
            pacer.last_hit(-110).is_some(),
            "إرسال المجموعة لم يمرّ من مُنظِّم المعدّل"
        );
        assert!(pacer.last_hit(7).is_none(), "المحادثة الخاصة حُصِّصت بلا سبب");
        drop(pacer);
        // وتعديلٌ تجميلي فوق الحصّة **يُسقَط** بدل أن يُرسَل بلا حدّ.
        let _ = send_message(&cfg, -110, "ثانية", None, None);
        assert!(!pace_group_edit(-110), "تعديلٌ تجميلي مرّ فوق السقف");
    }

    // ── الاستجابة تحت ضغط الإرسال: خيط الاستطلاع لا ينام على المعدّل ────────

    /// **الحارس الذي يقيس الاستجابة لا وجود الطابور**: مع طابور إرسالٍ ممتلئ
    /// (‏٨ رسائل في مجموعةٍ واحدة ⇒ ≥٨ ث على الكاتب بحصّة رسالة/ثانية) فإن
    /// تحديث `/kill` **يُقرأ ويُلغي المهمّة**، والزمن المقيس هو زمن قراءته.
    ///
    /// **والمُفسَد هو بيت القصيد**: إعادة الانتظار إلى داخل مسار التحديث (أي
    /// جعل الإرسال متزامناً في `handle_update`) تُسقطه — لأن الزمن يصير زمن
    /// الحصّة لا زمن القراءة.
    #[test]
    fn under_a_saturated_send_queue_a_kill_update_is_still_read_and_acts() {
        let _reg = crate::slots::registry_test_lock();
        let _g = state_lock();
        reset_counters();
        let bot = FakeBot::start();
        let cfg = bot.cfg_group(7, GroupMode::Mentions);
        let mut poll = group_poll("MyBot", 99, &[(-113, 7)]);
        let ov = new_oversize_store();
        let (tx, _rx) = chan();

        // مهمّة حيّة للمالك في هذه المجموعة، **تنتهي فعلاً عند الإلغاء** (وإلا
        // قاس الفحص انتظار `CANCEL_CONFIRM_WAIT` لا زمن قراءة التحديث).
        let early = slots::register_early(&job_label(-113, 7), None);
        let job_id = early.id();
        let flag = early.cancel_flag();
        let reaper = std::thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            drop(early); // المهمّة تخرج من السِجلّ ⇒ `wait_until_gone` يعود فوراً
        });

        // **إشباع الطابور مباشرةً**: ٨ رسائل في المجموعة نفسها ⇒ الكاتب مشغول
        // ≥٨ ث (‏`GROUP_MIN_GAP` = ١ ث).
        //
        // **ولماذا لا عبر المسار المفحوص**: لو ملأناه بـ`send_group_async` لصار
        // المُفسَد (إعادة الإرسال متزامناً) يمنع الإشباع أصلاً، فيسقط الفحص على
        // **غياب الطابور** لا على **الاستجابة** — وذلك ليس ما يُدَّعى. فالإشباع
        // هنا **شرطٌ مُهيَّأ** لا موضعُ قياس.
        ensure_send_writer();
        for i in 0..8 {
            send_queue().push(SendJob {
                cfg: cfg.clone(),
                item: SendItem::Message {
                    chat_id: -113,
                    text: format!("إشباع {i}"),
                    keyboard: None,
                    reply_to: None,
                    pin: false,
                    id_slot: None,
                },
            });
        }
        assert!(
            send_queue().depth() >= 8,
            "الطابور لم يُشبَع ⇒ الفحص لا يقيس ما يدّعيه"
        );

        // والمعالجة تستمرّ: التحديث يُقرأ الآن.
        let started = Instant::now();
        handle_update(&cfg, &mut poll, &ov, &group_msg(7, -113, 90, "/kill"), &tx);
        let read = started.elapsed();
        let reaped = {
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline && slots::active_jobs().iter().any(|j| j.id == job_id) {
                std::thread::sleep(Duration::from_millis(5));
            }
            !slots::active_jobs().iter().any(|j| j.id == job_id)
        };
        let _ = reaper.join();
        assert!(reaped, "المهمّة لم تُلغَ");
        // **والحدّ مقيس من الطرفين**: السليم ~٠٫١ ث (`wait_until_gone` يستطلع
        // كل ١٠٠ مللي)، والمُفسَد (إرسالٌ متزامن) ينتظر حصّة **ثانيةً كاملة**
        // على الأقل. فـ٦٠٠ مللي تفصل بينهما بلا التباس.
        assert!(
            read < Duration::from_millis(600),
            "قراءة التحديث تأخّرت {read:?} والطابور مُشبَع — الإرسال ما زال يحجب خيط الاستطلاع"
        );
        eprintln!("م٤/استجابة: طابور مُشبَع بثمانِ رسائل · /kill قُرئ ونُفِّذ في {read:?}");
        drain_sends();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  م٥ — هوية البوت (ت٨ · ت٩ · ت١١) والإحصاءات (ت٦ خارجياً · هنا الزرّ)
    //  ولا شبكة ولا توكن: كلُّها على الخادم الوهمي ومسارٍ مؤقّت.
    // ═══════════════════════════════════════════════════════════════════════

    /// **ت٩ — جسم الرفع multipart صحيح الشكل**، مقيساً على الطلب الخام:
    /// حدّ واحد يطابق بين الترويسة والجسم · بداية `--حد` · نهاية `--حد--` ·
    /// جزءان لا أكثر · الحقلان (`photo` نصّاً و`photo_file` ملفاً) · وحمولة
    /// الصورة هي بايتات JPEG نفسها (‏`FFD8FF`…`FFD9`).
    ///
    /// والمُفسَد الذي يُسقطه: حدٌّ مُختلق لا يطابق الجسم، أو جسم بلا حدّ
    /// نهائي، أو إرسال الصورة كجزءٍ واحد بلا الحقل النصّي `attach://`.
    #[test]
    fn t9_the_photo_upload_is_one_well_formed_multipart_body() {
        let _g = state_lock();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let dir = temp_dir("m5_multipart");
        let out = apply_bot_identity(&cfg, &dir).expect("التطبيق يجب أن ينجح");
        assert!(out.applied, "التطبيق لم يرفع راية «مُطبَّق»");
        assert_eq!(out.photo_bytes, BOT_PHOTO_JPG.len());

        let calls = bot.calls();
        let upload = calls
            .iter()
            .find(|c| c.method == "setMyProfilePhoto")
            .expect("لم يُرسَل setMyProfilePhoto");

        // ① الترويسة تعلن multipart وبحدٍّ غير فارغ. **والحدّ يُقرأ من السطر
        //    الأصلي لا من نسخته المصغَّرة**: الحدّ حسّاس لحالة الأحرف، وتصغيرُ
        //    السطر كلّه كان يجعل المقارنة تفشل لسببٍ لا علاقة له بالشكل.
        let header_value = |name: &str| -> String {
            upload
                .head
                .lines()
                .find(|l| {
                    l.trim_start()
                        .to_ascii_lowercase()
                        .starts_with(&format!("{name}:"))
                })
                .map(|l| l.trim_start()[name.len() + 1..].trim().to_string())
                .unwrap_or_default()
        };
        let ctype = header_value("content-type");
        let boundary = ctype
            .strip_prefix("multipart/form-data; boundary=")
            .unwrap_or("")
            .to_string();
        assert!(
            !boundary.is_empty(),
            "لا حدّ في ترويسة الـmultipart: {ctype:?}"
        );

        // ② الطول المُعلَن = الطول المُرسَل فعلاً (‏Content-Length صريح، ولا
        //    نقل مُجزَّأ). والقياس على **البايتات** لا على نصٍّ مُشفَّر بـlossy.
        let declared: usize = header_value("content-length").parse().unwrap_or(0);
        assert_eq!(
            declared,
            upload.raw.len(),
            "الطول المُعلَن ≠ المُرسَل (فالطلب يُقطَع أو يُكمَّل بلا علمنا)"
        );
        assert!(
            !upload
                .head
                .to_ascii_lowercase()
                .contains("transfer-encoding"),
            "الطلب صار مُجزَّأً: {}",
            upload.head
        );

        let find = |hay: &[u8], needle: &[u8]| -> Option<usize> {
            hay.windows(needle.len()).position(|w| w == needle)
        };
        let count = |hay: &[u8], needle: &[u8]| -> usize {
            hay.windows(needle.len()).filter(|w| *w == needle).count()
        };

        // ③ البداية والنهاية بالحدّ نفسه — لا حدَّين يفترقان.
        let opener = format!("--{boundary}\r\n").into_bytes();
        let closer = format!("\r\n--{boundary}--\r\n").into_bytes();
        assert!(
            upload.raw.starts_with(&opener),
            "الجسم لا يبدأ بالحدّ: {:?}",
            String::from_utf8_lossy(&upload.raw[..upload.raw.len().min(60)])
        );
        assert!(
            upload.raw.ends_with(&closer),
            "الجسم لا ينتهي بالحدّ الخاتم: {:?}",
            String::from_utf8_lossy(&upload.raw[upload.raw.len().saturating_sub(60)..])
        );

        // ④ عدد الأجزاء: فاصلُ البداية يظهر مرّتين بالضبط (مرّة لكل جزء)،
        //    والخاتمة مرّة. فجزءٌ ناقص أو زائد يسقط هنا.
        assert_eq!(
            count(&upload.raw, &opener),
            2,
            "عدد الأجزاء ليس اثنين: {}",
            String::from_utf8_lossy(&upload.raw[..upload.raw.len().min(200)])
        );
        assert_eq!(count(&upload.raw, &closer), 1, "خاتمة واحدة للجسم");

        // ⑤ الجزء النصّي: `photo` يحمل `attach://<اسم المرفق>` **نصّاً** كما
        //    يوثّق `InputProfilePhotoStatic` (الحقل `String` لا `InputFile`).
        let json_field = b"Content-Disposition: form-data; name=\"photo\"\r\n\r\n";
        let at = find(&upload.raw, json_field).expect("حقل `photo` النصّي مفقود");
        let tail = &upload.raw[at + json_field.len()..];
        let json_text = std::str::from_utf8(&tail[..tail.len().min(200)])
            .ok()
            .and_then(|s| s.split("\r\n").next())
            .unwrap_or("");
        let parsed: Value = serde_json::from_str(json_text)
            .unwrap_or_else(|e| panic!("حقل photo ليس JSON: {json_text:?} ({e})"));
        assert_eq!(parsed["type"], "static", "نوع الصورة ليس static: {parsed}");
        assert_eq!(
            parsed["photo"].as_str(),
            Some(format!("attach://{BOT_PHOTO_ATTACH}").as_str()),
            "المرجع ليس attach:// بالاسم نفسه: {parsed}"
        );

        // ⑥ جزء الملف: اسم المرفق **نفسه** الذي في `attach://`، واسم ملف
        //    بصيغة `.jpg`، ونوعه `image/jpeg`.
        let file_field = format!(
            "Content-Disposition: form-data; name=\"{BOT_PHOTO_ATTACH}\"; filename=\"{BOT_PHOTO_NAME}\"\r\nContent-Type: image/jpeg\r\n\r\n"
        )
        .into_bytes();
        let at = find(&upload.raw, &file_field).unwrap_or_else(|| {
            panic!(
                "جزء الملف ليس بالشكل المتوقَّع: {}",
                String::from_utf8_lossy(&upload.raw[..upload.raw.len().min(400)])
            )
        });

        // ⑦ **والبايتات المُرسَلة هي الصورة نفسها**: حمولة الجزء تساوي ملف
        //    JPEG المضمَّن بايتاً ببايت — لا نصٌّ يشبهه ولا صورة أخرى.
        let payload = &upload.raw[at + file_field.len()..];
        let payload = &payload[..payload.len() - closer.len()];
        assert_eq!(
            payload.len(),
            BOT_PHOTO_JPG.len(),
            "حجم الحمولة ≠ حجم الصورة"
        );
        assert!(
            payload == BOT_PHOTO_JPG,
            "الحمولة ليست الصورة المضمَّنة (أوّلها {:02X?})",
            &payload[..4.min(payload.len())]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **حارس الصورة المُصرَّفة في الثنائي**: البايتات المضمَّنة بـ`include_bytes!`
    /// ملفُّ JPEG صالح — ترويسة `FFD8FF` ونهاية `FFD9` وأبعاد تُقرأ من وسم SOF.
    ///
    /// **ولا يُدَّعى حدُّ تلغرام** (التوثيق لا يذكره): الحدّان هنا حدّانا نحن،
    /// وما يُقاس هو **شكل الملف** لا سماحُ خدمةٍ لم تُسأل.
    #[test]
    fn the_bundled_bot_photo_is_a_real_jpeg_with_readable_dimensions() {
        let (w, h) = photo_problem(BOT_PHOTO_JPG).expect("الصورة المضمَّنة يجب أن تكون JPEG صالحاً");
        assert_eq!(
            (w, h),
            (512, 512),
            "الأبعاد المقروءة من الملف ليست ما وثّقناه في التحويل"
        );
        assert!(BOT_PHOTO_JPG.len() > 1024, "ملف صغير بشكل غير معقول");
        assert_eq!(BOT_PHOTO_JPG[..3], [0xFF, 0xD8, 0xFF], "ترويسة JPEG");

        // والمُفسَد الذي يُسقط هذا الحارس: بايتة واحدة تُقلَب في الترويسة.
        let mut broken = BOT_PHOTO_JPG.to_vec();
        broken[1] = 0x00;
        assert!(
            photo_problem(&broken).is_err(),
            "صورة بترويسة مكسورة مرّت من الحارس"
        );
        // وملفٌ مقطوع (بلا EOI) يُرفض كذلك.
        let cut = &BOT_PHOTO_JPG[..BOT_PHOTO_JPG.len() - 2];
        assert!(photo_problem(cut).is_err(), "ملف مقطوع مرّ من الحارس");
    }

    /// **ت٨ — العكس صادق**: بعد `revert` يعود **الاسم السابق المخزَّن** فعلاً،
    /// والصورة تُزال — مقيساً على **حالة الخادم** لا على نصّ الطلب.
    ///
    /// والمُفسَد الذي يُسقطه: عدم تخزين الاسم السابق (فيُرسَل فراغٌ فيُمحى اسم
    /// البوت بدل أن يعود)، أو إعادة «HaramLite» مكان نفسه.
    #[test]
    fn t8_revert_restores_the_stored_previous_name_on_the_server() {
        let _g = state_lock();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let dir = temp_dir("m5_identity");
        // اسم البوت قبلنا كما يعطيه BotFather — وهو ما يجب أن يعود.
        let original = bot.current_name();
        assert_eq!(original, "HaramLite Bot", "تهيئة الخادم الوهمي");

        // ① التطبيق: يُقرأ الاسم أولاً، ويُخزَّن **قبل** أي تبديل.
        let applied = apply_bot_identity(&cfg, &dir).expect("التطبيق");
        assert_eq!(applied.name, "HaramLite");
        assert_eq!(applied.previous_name, original, "الاسم السابق لم يُقرأ");
        assert_eq!(bot.current_name(), "HaramLite", "الاسم على الخادم لم يتغيّر");
        let stored = load_identity_state(&dir).expect("حالة مخزَّنة بعد التطبيق");
        assert!(stored.applied, "راية التطبيق لم تُرفع");
        assert!(stored.photo_applied, "الصورة رُفعت ولم تُدوَّن");
        assert_eq!(stored.server_name, "HaramLite", "اسم الخادم لم يُدوَّن");
        assert!(stored.checked_ms > 0, "زمن المقابلة لم يُدوَّن");
        assert_eq!(
            stored.previous_name, original,
            "الاسم السابق لم يُخزَّن على القرص"
        );
        // وترتيب النداءات: القراءة **قبل** الكتابة (وإلا سُجِّل اسمٌ بعد التبديل).
        let order: Vec<String> = bot
            .calls()
            .iter()
            .map(|c| c.method.clone())
            .filter(|m| m == "getMyName" || m == "setMyName" || m == "setMyProfilePhoto")
            .collect();
        assert_eq!(
            order,
            ["getMyName", "setMyProfilePhoto", "setMyName"],
            "ترتيب نداءات الهوية ليس: قراءة ← صورة ← اسم"
        );

        // ② العكس: إزالة الصورة وإعادة الاسم المخزَّن.
        bot.clear();
        let reverted = revert_bot_identity(&cfg, &dir).expect("العكس");
        assert!(!reverted.applied);
        assert_eq!(reverted.name, original);
        assert_eq!(
            bot.current_name(),
            original,
            "الاسم السابق لم يعد على الخادم — العكس ليس عكساً"
        );
        assert_eq!(bot.count("removeMyProfilePhoto"), 1, "الصورة لم تُزَل");
        // والعكس **لم يرفع** صورة ثانية ولا أرسل `setMyProfilePhoto`.
        assert_eq!(bot.count("setMyProfilePhoto"), 0, "العكس رفع صورة");
        let after = load_identity_state(&dir).expect("حالة بعد العكس");
        assert!(!after.applied, "راية التطبيق لم تُنزَل");
        assert!(!after.photo_applied, "الصورة أُزيلت وبقيت الراية مرفوعة");
        assert_eq!(
            after.server_name, original,
            "اسم الخادم بعد العكس ليس الاسم المُعاد"
        );
        assert_eq!(
            after.previous_name, original,
            "الاسم السابق يبقى معروفاً بعد العكس (عكسٌ ثانٍ لا يصير أعمى)"
        );

        // ③ وبلا حالةٍ مخزَّنة **لا عكس**: كان سيمحو اسم البوت الحقيقي.
        let fresh = temp_dir("m5_identity_none");
        match revert_bot_identity(&cfg, &fresh) {
            Err(BotSetupError::State(_)) => {}
            other => panic!("عكسٌ بلا سجلّ سابق يجب أن يُرفض، جاء: {other:?}"),
        }
        assert_eq!(bot.current_name(), original, "العكس المرفوض مسّ اسم البوت");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&fresh);
    }

    /// **ت١١ — الفشل يُعلَن**: صورةٌ يرفضها الـAPI ⇒ **خطأ مُسمّى** لا نجاح
    /// كاذب، ولا نصفُ تطبيق (الاسم لم يُمَسّ)، والحالة تبقى `applied:false`.
    ///
    /// والمُفسَد الذي يُسقطه: `let _ = …` على نتيجة الرفع (فيُعاد `Ok`)، أو
    /// تعيينُ الاسم **قبل** الصورة (فيبقى اسمٌ مبدَّل وصورةٌ مرفوضة).
    #[test]
    fn t11_a_rejected_photo_is_a_named_error_and_no_false_success() {
        let _g = state_lock();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let dir = temp_dir("m5_identity_fail");
        let original = bot.current_name();

        bot.reject_method("setMyProfilePhoto");
        let err = apply_bot_identity(&cfg, &dir).expect_err("الرفض يجب أن يُعلَن");
        assert!(
            matches!(err, BotSetupError::Photo(_)),
            "الخطأ ليس مُسمّى بالصورة: {err:?}"
        );
        let text = err.to_string();
        assert!(
            text.contains("setMyProfilePhoto"),
            "نصّ الخطأ لا يسمّي النداء الفاشل: {text}"
        );

        // **ولا نصف تطبيق**: الاسم لم يُمَسّ على الخادم، ولا `setMyName` أُرسل.
        assert_eq!(
            bot.current_name(),
            original,
            "الاسم تغيّر رغم فشل الصورة — نصفُ تطبيق"
        );
        assert_eq!(bot.count("setMyName"), 0, "أُرسل setMyName بعد فشل الصورة");
        let st = load_identity_state(&dir).expect("الحالة تُكتب قبل المحاولة (للعكس)");
        assert!(!st.applied, "ادُّعي التطبيق رغم الفشل");
        assert_eq!(
            st.previous_name, original,
            "الاسم السابق يُخزَّن قبل المحاولة — وإلا فلا عكس صادق"
        );

        // ③ وبزوال السبب ينجح المسار: الفشل المُقاس ليس فشلاً دائماً.
        bot.accept_method("setMyProfilePhoto");
        let ok = apply_bot_identity(&cfg, &dir).expect("بعد زوال السبب");
        assert!(ok.applied, "لم يُطبَّق بعد زوال سبب الرفض");
        assert_eq!(bot.current_name(), "HaramLite");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **جولة التفنيد، عطل ٣ — الراية المحلّية لا تكفي: الحقيقة تُقرأ من
    /// الخادم.** من أعاد الاسم من `@BotFather` تُبقيه رايتُنا «مطبَّقاً»،
    /// والقرار يجب أن يرى الاسم الحقيقي.
    ///
    /// والمُفسَد: قرارٌ بالراية وحدها (`applied == wanted`) ⇒ يسقط الشقّ الأول
    /// (إعادة تسمية خارجية لا تُكتشَف)، وإرجاعُ الهدف مكان الاسم الحيّ في
    /// الحمولة يسقط في [`the_identity_payload_names_the_live_name_not_the_target`].
    #[test]
    fn t13_a_rename_outside_us_is_seen_and_reapplied() {
        let _g = state_lock();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let dir = temp_dir("m5_rename");
        apply_bot_identity(&cfg, &dir).expect("تطبيق أوّلي");
        let applied_state = load_identity_state(&dir).unwrap();
        assert!(applied_state.applied);

        // ① الاسم على الخادم اسمُنا ⇒ **لا شيء يستحق نداءً** (لا رفعَ صورة ثانية).
        assert_eq!(
            identity_action(&bot.current_name(), &applied_state, true),
            IdentityAction::None
        );

        // ② المالك أعاد الاسم من @BotFather: الراية تقول «مطبَّق» والخادم يقول غير ذلك.
        bot.rename_on_server("Haramlite");
        assert_eq!(
            identity_action(&bot.current_name(), &applied_state, true),
            IdentityAction::Apply,
            "إعادة تسمية خارجية لم تُكتشَف — القرار بالراية وحدها"
        );

        // ③ والمقابلة الفعلية بالخادم تُدوَّن: الاسم وزمنُه (لا ادّعاء معرفةٍ حالية).
        bot.clear();
        let seen = verify_identity_name(&cfg, &dir).expect("مقابلة الاسم");
        assert_eq!(seen, "Haramlite");
        let st = load_identity_state(&dir).unwrap();
        assert_eq!(st.server_name, "Haramlite", "اسم الخادم لم يُحدَّث");
        assert!(st.checked_ms > 0, "زمن المقابلة لم يُحدَّث");
        assert_eq!(bot.count("getMyName"), 1, "المقابلة تطلب الاسم مرّة واحدة");
        let payload = identity_payload(&st, false, "");
        assert_eq!(
            payload["matches"],
            json!(false),
            "الحمولة تدّعي مطابقةً والخادم يقول غير ذلك: {payload}"
        );

        // ④ والعكس مطلوبٌ لأن لنا أثراً (اسمُنا كان عليه، وصورتنا مرفوعة).
        assert_eq!(
            identity_action(&bot.current_name(), &st, false),
            IdentityAction::Revert
        );

        // ④ب **وإصلاحٌ ذاتيّ بلا نداء إضافي**: رايتنا مرفوعة وآخر مقابلةٍ تقول
        //     إن الاسم على الخادم غيره ⇒ أول حفظِ إعدادات يُعيد التطبيق.
        let mut mismatch = applied_state.clone();
        mismatch.server_name = "Haramlite".into();
        mismatch.checked_ms = 1;
        assert!(
            identity_needs_call(&mismatch, true),
            "مقابلةٌ تقول إن الاسم تغيّر ولم تُوجب إعادة التطبيق"
        );
        assert!(
            !identity_needs_call(&applied_state, true),
            "مقابلةٌ مطابقة أوجبت نداءً — رفعُ صورةٍ بلا سبب"
        );
        // ⑤ وبعد عكسٍ كامل لا أثر لنا ⇒ لا نداء (ولا نداءَ في كل حفظ إعدادات).
        let clean = BotIdentityState {
            applied: false,
            photo_applied: false,
            previous_name: "HaramLite Bot".into(),
            server_name: "HaramLite Bot".into(),
            checked_ms: 1,
        };
        assert!(
            !identity_needs_call(&clean, false),
            "عكسٌ بلا أثر = نداء زائد"
        );
        assert!(
            identity_needs_call(
                &BotIdentityState {
                    photo_applied: true,
                    ..clean.clone()
                },
                false
            ),
            "صورةٌ معلّقة من تطبيقٍ فاشل يجب أن تُوجب العكس"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **جولة التفنيد، عطل ٥ — الاسم في الحمولة هو الحيّ لا الهدف.**
    ///
    /// والمُفسَد: `name` تُعاد دائماً `BOT_DISPLAY_NAME` ⇒ الشقّ الثاني يسقط
    /// (الحمولة تقول «HaramLite» والحالة تقول «Haramlite»).
    #[test]
    fn the_identity_payload_names_the_live_name_not_the_target() {
        // مطبَّق: الحيّ = الهدف.
        let applied = BotIdentityState {
            applied: true,
            photo_applied: true,
            previous_name: "Haramlite".into(),
            server_name: "HaramLite".into(),
            checked_ms: 1_700_000_000_000,
        };
        let p = identity_payload(&applied, false, "");
        assert_eq!(p["name"], json!("HaramLite"));
        assert_eq!(p["target_name"], json!("HaramLite"));
        assert_eq!(p["matches"], json!(true));
        assert_eq!(p["applied"], json!(true));
        assert_eq!(p["photo_applied"], json!(true));
        assert!(p["verified_secs_ago"].is_u64(), "عُمر المقابلة ليس رقماً");

        // **بعد العكس**: الحيّ هو الاسم المُعاد، والهدف يبقى مذكوراً بوصفه هدفاً.
        let reverted = BotIdentityState {
            applied: false,
            photo_applied: false,
            previous_name: "Haramlite".into(),
            server_name: "Haramlite".into(),
            checked_ms: 1_700_000_000_000,
        };
        let p = identity_payload(&reverted, true, "");
        assert_eq!(
            p["name"],
            json!("Haramlite"),
            "الاسم المعروض بعد العكس هو الهدف لا الحيّ: {p}"
        );
        assert_eq!(p["target_name"], json!("HaramLite"), "الهدف ضاع: {p}");
        assert_eq!(p["matches"], json!(false), "المطابقة كاذبة بعد العكس: {p}");
        assert_eq!(p["applied"], json!(false));
        assert_eq!(p["changed"], json!(true));

        // ولم تُقابَل بعد: لا يُدَّعى اسمٌ حيّ ولا مطابقة.
        let unverified = BotIdentityState::default();
        let p = identity_payload(&unverified, false, "");
        assert_eq!(p["matches"], Value::Null, "مطابقةٌ بلا مقابلة: {p}");
        assert_eq!(p["verified_secs_ago"], Value::Null);
        assert_eq!(p["name"], json!(""), "اسمٌ مُختلق بلا مقابلة: {p}");
    }

    /// **جولة التفنيد، عطل ٤ — الحالة تُقرأ عند كل طلب لا صورةً مخبَّأة.**
    ///
    /// يُكتب ملف الحالة **من خارجنا** (كما لو كتبته عملية أخرى) ثم يُسأل
    /// `telegram_status` مباشرةً — بلا `apply_settings` بينهما. والمُفسَد:
    /// إعادة الحقل المخبَّأ (`Status.identity_applied`) ⇒ يسقط.
    #[test]
    fn a_state_file_written_outside_is_reflected_on_the_next_status_read() {
        let _serial = crate::paths::serial_guard();
        let _env = crate::paths::env_restore("HARAMLITE_DATA_DIR");
        let _g = state_lock();
        let base = temp_dir("m5_status_fresh");
        std::env::set_var("HARAMLITE_DATA_DIR", &base);

        // ① لا ملف ⇒ لا ادّعاء: راية منزوعة ولا مطابقة (لا مقابلة).
        let first = status_json();
        assert_eq!(first["identity"]["applied"], json!(false));
        assert_eq!(first["identity"]["matches"], Value::Null);

        // ② ملفٌ يُكتب من الخارج (بلا أي نداء منّا).
        save_identity_state(
            &base,
            &BotIdentityState {
                applied: true,
                photo_applied: true,
                previous_name: "Haramlite".into(),
                server_name: "HaramLite".into(),
                checked_ms: epoch_ms(),
            },
        )
        .unwrap();
        let second = status_json();
        assert_eq!(
            second["identity"]["applied"],
            json!(true),
            "القراءة التالية لم ترَ الملف — الحالة صورة مخبَّأة: {second}"
        );
        assert_eq!(second["identity"]["photo_applied"], json!(true));
        assert_eq!(second["identity"]["name"], json!("HaramLite"));
        assert_eq!(
            second["identity"]["target_name"],
            json!(BOT_DISPLAY_NAME),
            "الهدف مفقود من الحمولة"
        );
        assert_eq!(second["identity"]["matches"], json!(true));
        assert!(
            second["identity"]["verified_secs_ago"].is_u64(),
            "عُمر المقابلة ليس رقماً: {second}"
        );

        // ③ وحذفُ الملف يُرى فوراً كذلك (لا بقايا من القراءة السابقة).
        std::fs::remove_file(identity_path(&base)).unwrap();
        let third = status_json();
        assert_eq!(
            third["identity"]["applied"],
            json!(false),
            "حذفُ الملف لم يظهر — رايةٌ باقية بلا سند: {third}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// **جولة التفنيد، عطل ٦ — لا نجاح نصفيّ صامت**: الاسمُ يرفضه الـAPI **بعد**
    /// نجاح رفع الصورة ⇒ خطأٌ يقول ما نجح وما فشل، وحالةٌ تحمل `photo_applied`
    /// ليعمل العكس.
    ///
    /// والمُفسَد: ابتلاعُ فشل الاسم، أو عدم تدوين `photo_applied` بعد الرفع ⇒
    /// يسقط هذا الاختبار (ويبقى أثرٌ لا يعرفه العكس).
    #[test]
    fn t14_a_name_failure_after_the_photo_is_declared_and_reversible() {
        let _g = state_lock();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let dir = temp_dir("m5_partial");
        let original = bot.current_name();

        bot.reject_method("setMyName");
        let err = apply_bot_identity(&cfg, &dir).expect_err("فشل الاسم يجب أن يُعلَن");
        assert!(
            matches!(err, BotSetupError::Name(_)),
            "الخطأ ليس مُسمّى بالاسم: {err:?}"
        );
        let text = err.to_string();
        assert!(
            text.contains("رُفعت فعلاً"),
            "نصّ الخطأ لا يقول إن الصورة رُفعت: {text}"
        );

        // **الصورة رُفعت فعلاً** على الخادم، والاسم لم يتغيّر — والحالة تقول ذلك.
        assert_eq!(bot.count("setMyProfilePhoto"), 1, "الصورة لم تُرفع");
        assert_eq!(bot.current_name(), original, "الاسم تغيّر رغم فشل النداء");
        let st = load_identity_state(&dir).expect("حالة بعد فشلٍ جزئي");
        assert!(!st.applied, "ادُّعي التطبيق");
        assert!(
            st.photo_applied,
            "الصورة مرفوعة والحالة لا تعرف — العكس يصير أعمى"
        );
        assert_eq!(st.previous_name, original);
        assert_eq!(
            identity_payload(&st, false, "")["photo_applied"],
            json!(true),
            "الحمولة لا تُعلن الصورة المعلّقة"
        );
        // وقرارُ العكس يعرف أن عليه إزالة صورة (عطل ٦ في مسار القرار).
        assert!(
            identity_needs_call(&st, false),
            "صورةٌ معلّقة بلا اسم لا تُوجب العكس"
        );

        // **والعكس ينظّف الأثر كاملاً**: تُزال الصورة ويعود الاسم.
        bot.accept_method("setMyName");
        bot.clear();
        let back = revert_bot_identity(&cfg, &dir).expect("عكس نصف تطبيق");
        assert!(!back.applied);
        assert_eq!(bot.count("removeMyProfilePhoto"), 1, "الصورة لم تُزَل");
        assert_eq!(bot.current_name(), original, "الاسم لم يعد");
        let after = load_identity_state(&dir).unwrap();
        assert!(!after.applied && !after.photo_applied, "أثرٌ باقٍ في الحالة");
        assert!(!identity_needs_call(&after, false), "نداءٌ بلا أثر");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **جولة التفنيد — ساعة المقابلة الدورية**: نداءُ حالةٍ متكرّر **لا
    /// يصفّر المؤقّت**، والمقابلة تقع مرّة كل [`IDENTITY_VERIFY_TTL`].
    ///
    /// والمُفسَد الذي يُسقطه: كتابةُ الختم **قبل** فحص المدة (وهو ما كتبته
    /// أولاً وكشفه هذا القياس) ⇒ كل نداءٍ يصفّر المؤقّت، فلا تقع مقابلة أبداً
    /// مع واجهةٍ تستطلع كل ٥ ثوانٍ — يسقط الشقّ الثالث هنا.
    #[test]
    fn repeated_status_reads_do_not_reset_the_verify_clock() {
        let ttl = IDENTITY_VERIFY_TTL.as_millis() as u64;
        let t0 = 1_700_000_000_000u64; // زمنٌ حقيقي المقدار (‏epoch ms)
        assert!(verify_due(1_000, 1_000 + ttl), "بعد المدة يحين الوقت");
        assert!(!verify_due(1_000, 1_000 + ttl - 1), "وقبلها لا");

        // ① المحاولة الأولى تُحجز (الختم صفر ⇒ الوقت حان).
        let clock = AtomicU64::new(0);
        assert!(claim_verify_slot(&clock, t0), "المحاولة الأولى لم تُحجز");
        // ② وإحدى عشرة قراءة كل ٥ ثوانٍ (٥٥ ثانية) **لا تحجز** واحدة: الختم
        //    لم يتقدّم، فالوقت لم يحن بعد.
        for step in 1..12u64 {
            assert!(
                !claim_verify_slot(&clock, t0 + step * 5_000),
                "نداء حالةٍ في الثانية {} حجز محاولة — المؤقّت يُصفَّر مع كل قراءة",
                step * 5
            );
        }
        // ③ وعند الدقيقة تماماً تُحجز مرّة واحدة، ثم يُقفل الباب من جديد.
        assert!(
            claim_verify_slot(&clock, t0 + ttl),
            "بعد المدة لم تُحجز محاولة — المؤقّت توقّف عن التقدّم"
        );
        assert!(
            !claim_verify_slot(&clock, t0 + ttl + 1),
            "محاولتان في اللحظة نفسها"
        );
    }

    /// **ت١٠ — لا `/stop` في أي نطاق**: لا في القائمة المُسجَّلة على الخادم
    /// (نطاق المالك)، ولا في نصّ `/help` لأي قارئ، **ولا هو أمرٌ يُنفَّذ**:
    /// رسالةٌ نصّها `/stop` لا تُلغي مهمّة — يُقال له «لا أعرف الأمر».
    ///
    /// والمُفسَد الذي يُسقطه: إضافة `("stop", …)` إلى `COMMANDS` ⇒ يسقط شقُّ
    /// التسجيل، أو جعل `/stop` ينادي الإلغاء ⇒ يسقط شقُّ السلوك.
    #[test]
    fn t10_no_stop_command_in_any_scope_and_it_never_cancels() {
        let _g = state_lock();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        // النصّ الممنوع يُبنى مقطّعاً حتى لا يجد الحارس نفسه في المصدر
        // (نفس صنيع حارس م٤: مسبارٌ خام كان يسقط على توثيقه هو).
        let banned = concat!("/st", "op");

        // ① ما سُجّل فعلاً على الخادم: صفر `/stop` في القائمة الكاملة.
        register_commands(&cfg);
        let bodies = bot.bodies("setMyCommands");
        assert_eq!(bodies.len(), 1, "قائمة واحدة تُسجَّل");
        let v: Value = serde_json::from_str(&bodies[0]).unwrap();
        let names: Vec<String> = v["commands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["command"].as_str().unwrap_or("").to_string())
            .collect();
        let banned_name = concat!("st", "op");
        assert!(
            !names
                .iter()
                .any(|n| n.to_ascii_lowercase().contains(banned_name)),
            "أمر ممنوع في النطاق المُسجَّل: {names:?}"
        );
        // ② ولا في نصّ القائمة لأي قارئ.
        for is_owner in [true, false] {
            assert!(
                !help_text_for(is_owner).contains(banned),
                "ظهر {banned} في /help (مالك: {is_owner})"
            );
        }

        // ③ **وسلوكاً**: رسالة `/stop` لا تُلغي شيئاً — والجواب يسمّيه مجهولاً.
        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, _rx) = chan();
        let before = tg_job_states_for_test(7).len();
        handle_update(&cfg, &mut poll, &ov, &text_msg(7, 900, banned), &tx);
        let texts = sent_texts(&bot);
        assert!(
            texts.iter().any(|t| t.contains("لا أعرف الأمر")),
            "لم يُقل إن الأمر مجهول: {texts:?}"
        );
        assert!(
            !texts
                .iter()
                .any(|t| t.contains("أُلغيت") || t.contains("لا مهمّة جارية")),
            "نُفِّذ إلغاء من أمر ممنوع: {texts:?}"
        );
        assert_eq!(before, tg_job_states_for_test(7).len(), "تغيّرت حالة مهامّ");
    }

    /// **ت٦/ت٧ في المنتج**: زرّ «📊 إحصاءات» يُرسل **رسالة واحدة لكل ضغطة**
    /// ونصُّها **من الملف وحده** (الاسم · الـID · العدد · الحجم)، ولا يمرّ من
    /// مسار التعديل التجميلي (`editMessageText`) أصلاً.
    #[test]
    fn the_stats_button_sends_exactly_one_message_from_the_file_alone() {
        let _serial = crate::paths::serial_guard();
        let _env = crate::paths::env_restore("HARAMLITE_DATA_DIR");
        let _g = state_lock();
        let base = temp_dir("m5_stats");
        std::env::set_var("HARAMLITE_DATA_DIR", &base);
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        // سجلٌّ مكتوب من **الكاتب الوحيد** (تسليمٌ ناجح) — مفتاحه الـID.
        crate::tg_stats::note_delivery(&base, 7, "المالك", 2 * 1024 * 1024).unwrap();

        let mut poll = PollState::default();
        let ov = new_oversize_store();
        let (tx, _rx) = chan();

        // ① `/stats` من صاحبه: نصٌّ من الملف + زرّه.
        handle_update(&cfg, &mut poll, &ov, &text_msg(7, 950, "/stats"), &tx);
        let sent = sent_to(&bot, 7);
        assert_eq!(sent.len(), 1, "أكثر من رسالة لأمر واحد: {sent:?}");
        let text = sent[0]["text"].as_str().unwrap_or("");
        for want in ["المالك", "المعرّف: 7", "الملفات: 1", "2.0 م.ب"] {
            assert!(text.contains(want), "ناقص «{want}» في نصّ الإحصاءات: {text}");
        }
        assert_eq!(
            sent[0].pointer("/reply_markup/inline_keyboard/0/0/callback_data"),
            Some(&json!(STATS_CALLBACK)),
            "الزرّ ليس زرّ الإحصاءات: {sent:?}"
        );

        // ② ضغطة على الزرّ ⇒ **رسالة واحدة** (لا تعديل، ولا رسالتان).
        let before_msgs = bot.count("sendMessage");
        let before_edits = bot.count("editMessageText");
        let press = json!({
            "callback_query": {
                "id": "cb-stats",
                "from": { "id": 7 },
                "data": STATS_CALLBACK,
                "message": { "message_id": 950, "chat": { "id": 7, "type": "private" } }
            }
        });
        handle_update(&cfg, &mut poll, &ov, &press, &tx);
        assert_eq!(
            bot.count("sendMessage") - before_msgs,
            1,
            "الضغطة لم تُرسل رسالة واحدة بالضبط"
        );
        assert_eq!(
            bot.count("editMessageText") - before_edits,
            0,
            "الزرّ مرّ من مسار التعديل التجميلي"
        );
        assert_eq!(
            bot.count("answerCallbackQuery"),
            1,
            "الضغطة لم تُجَب (يدور مؤشّر العميل)"
        );
        // والنصّ الثاني هو نفسه: **من الملف** لا من عدّادٍ حيّ.
        let sent = sent_to(&bot, 7);
        assert_eq!(
            sent.last().unwrap()["text"].as_str().unwrap_or(""),
            text,
            "نصّ الضغطة ≠ نصّ الأمر (فليس من الملف وحده)"
        );

        // ③ ومستخدمٌ بلا سجلّ: تُقال الحقيقة بدل أصفارٍ مُختلقة.
        handle_update(&cfg, &mut poll, &ov, &text_msg(7, 951, "/stats"), &tx);
        let rec = crate::tg_stats::load(&base, 8);
        assert!(rec.is_none(), "لا سجلّ لمستخدمٍ لم يجرِ له تسليم");
        let none_text = stats_reply(&base, 8);
        assert!(none_text.contains("لا سجلّ"), "{none_text}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// **الأوامر تُضبَط من الواجهة بنتيجة صريحة** (م٥/٤) — والمسار هو نفسه
    /// الذي بناه م٤: **صفر أوامر عامة** ونطاق محادثة المالك، ولا نسخة ثانية.
    #[test]
    fn applying_the_commands_from_the_panel_reports_the_same_two_calls() {
        let _g = state_lock();
        let bot = FakeBot::start();
        let cfg = bot.cfg(7);
        let n = apply_bot_commands(&cfg).expect("الضبط يجب أن ينجح");
        assert_eq!(n, COMMANDS.len(), "عدد المُسجَّل ≠ عدد المعلَن");
        assert_eq!(bot.count("deleteMyCommands"), 1, "صفر أوامر عامة");
        assert_eq!(bot.count("setMyCommands"), 1, "قائمة المالك وحدها");
        let v: Value = serde_json::from_str(&bot.bodies("setMyCommands")[0]).unwrap();
        assert_eq!(
            v.pointer("/scope/type").and_then(Value::as_str),
            Some("chat")
        );
        assert_eq!(
            v.pointer("/scope/chat_id").and_then(Value::as_i64),
            Some(7),
            "النطاق ليس محادثة المالك"
        );

        // وبلا مالك: الإفراغ يقع والقائمة **لا** تُسجَّل، والنتيجة **خطأ مُسمّى**
        // لا «نجح، صفر أوامر» (فالصفر هنا ليس إنجازاً بل غياب نطاق).
        bot.clear();
        let mut anon = bot.cfg(7);
        anon.owner_id = None;
        match apply_bot_commands(&anon) {
            Err(BotSetupError::NotConfigured(e)) => {
                assert!(e.contains("مالك"), "السبب لا يسمّي العلّة: {e}")
            }
            other => panic!("بلا مالك يجب أن يُعلَن السبب، جاء: {other:?}"),
        }
        assert_eq!(bot.count("setMyCommands"), 0, "سُجّلت قائمة بلا نطاق");
        assert_eq!(bot.count("deleteMyCommands"), 1);

        // والفشل يُعلَن: `setMyCommands` مرفوض ⇒ خطأ مُسمّى لا `Ok`.
        bot.clear();
        bot.reject_method("setMyCommands");
        match apply_bot_commands(&cfg) {
            Err(BotSetupError::Commands(e)) => {
                assert!(e.contains("setMyCommands"), "الخطأ لا يسمّي النداء: {e}")
            }
            other => panic!("رفض setMyCommands يجب أن يُعلَن، جاء: {other:?}"),
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ش-١ · حارس نصوص البوت: لا نجمتَي Markdown حرفيّتين
    //  (عطل المالك 2026-09-23: رسالة سؤال الوضع وصلت وفيها `**أغنية**` حرفيّة)
    // ═══════════════════════════════════════════════════════════════════════

    /// **مصدر هذا الملف** يُقرأ عند التصريف ⇒ الحارس يقيس **النصّ المشحون**، لا
    /// قائمةً مكتوبةً بيدٍ تتقادم بصمت.
    const SELF_SOURCE: &str = include_str!("telegram.rs");

    /// يستخرج **النصوص الحرفيّة** من مصدر Rust: يتخطّى التعليقات (`//`،
    /// و`/* */` المتداخلة)، والنصوص الخام (`r"…"` · `r#"…"#`)، **ومحارف `'…'`**.
    ///
    /// **والفخّ مسمّى**: ماسحٌ لا يميّز `'"'` يظنّه فاتحَ نصّ ⇒ **ينقلب التكافؤ**
    /// ⇒ يقرأ الكود نصّاً والنصّ كوداً، ويمرّ التشخيص **كذباً**. ولهذا يقيس
    /// [`the_literal_scanner_sees_what_it_claims`] الماسحَ نفسه على نصٍّ مصنوع
    /// فيه `'"'` **قبل** أن يُبنى عليه أيّ حكم.
    fn string_literals(src: &str) -> Vec<String> {
        let b = src.as_bytes();
        let n = b.len();
        let mut out: Vec<String> = Vec::new();
        let mut i = 0usize;
        while i < n {
            match b[i] {
                b'/' if b.get(i + 1) == Some(&b'/') => {
                    i = b[i..].iter().position(|c| *c == b'\n').map_or(n, |p| i + p);
                }
                b'/' if b.get(i + 1) == Some(&b'*') => {
                    let mut depth = 1usize;
                    i += 2;
                    while i < n && depth > 0 {
                        if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                            depth += 1;
                            i += 2;
                        } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                            depth -= 1;
                            i += 2;
                        } else {
                            i += 1;
                        }
                    }
                }
                b'\'' => {
                    // `'\x'` محرف مهروب · `'x'` محرف · `'a` عمرُ نوعٍ (بلا إغلاق).
                    if b.get(i + 1) == Some(&b'\\') {
                        i = b[i + 2..]
                            .iter()
                            .position(|c| *c == b'\'')
                            .map_or(n, |p| i + 3 + p);
                    } else if b.get(i + 2) == Some(&b'\'') {
                        i += 3;
                    } else {
                        i += 1;
                    }
                }
                b'r' if b.get(i + 1) == Some(&b'"') || b.get(i + 1) == Some(&b'#') => {
                    let hashes = b[i + 1..].iter().take_while(|c| **c == b'#').count();
                    let open = i + 1 + hashes;
                    if b.get(open) != Some(&b'"') {
                        i += 1;
                        continue;
                    }
                    let close = (open + 1..n).find(|k| {
                        b[*k] == b'"' && (1..=hashes).all(|t| b.get(k + t) == Some(&b'#'))
                    });
                    let end = close.unwrap_or(n);
                    out.push(String::from_utf8_lossy(&b[open + 1..end]).into_owned());
                    i = end + 1 + hashes;
                }
                b'"' => {
                    let mut j = i + 1;
                    let mut escaped = false;
                    let mut close = None;
                    while j < n {
                        let c = b[j];
                        if escaped {
                            escaped = false;
                        } else if c == b'\\' {
                            escaped = true;
                        } else if c == b'"' {
                            close = Some(j);
                            break;
                        }
                        j += 1;
                    }
                    let end = close.unwrap_or(n);
                    out.push(String::from_utf8_lossy(&b[i + 1..end]).into_owned());
                    i = end + 1;
                }
                _ => i += 1,
            }
        }
        out
    }

    /// **حارس على الماسح نفسه**: نصٌّ مصنوع فيه الفخّ الذي يُفسد ماسحاً لا يميّز
    /// المحرف `'"'`، ونصٌّ خامّ، وتعليقان يحملان النجمة — فلا يُبنى حكمٌ على
    /// ماسحٍ لم يُقَس.
    ///
    /// (المُفسَد: إسقاط فرع المحرف `'…'` ⇒ يقرأ `'"'` فاتحَ نصّ ⇒ يسقط هذا الفحص.)
    #[test]
    fn the_literal_scanner_sees_what_it_claims() {
        // النجمة تُبنى وقت التشغيل عمداً: لو كُتبت في المصدر لصار الماسح يقيس نفسه.
        let stars: String = ['*', '*'].iter().collect();
        let sample = [
            "// تعليق فيه ",
            stars.as_str(),
            " و\"نصّ زائف\"\n",
            "/* كتلة فيها ",
            stars.as_str(),
            " و\"نصّ زائف\" */\n",
            "fn f() { let q = '\"'; let s = \"ع ",
            stars.as_str(),
            " ع\"; let r = r#\"خ ",
            stars.as_str(),
            " خ\"#; }\n",
        ]
        .concat();
        let lits = string_literals(&sample);
        assert_eq!(
            lits.len(),
            2,
            "الماسح قرأ تعليقاً أو أضاع نصّاً (فخّ `'\"'`): {lits:?}"
        );
        assert!(
            lits.iter().all(|l| l.contains(&stars)),
            "النصّان الصحيحان وحدهما يُقرآن: {lits:?}"
        );
        assert!(
            lits.iter().any(|l| l.starts_with("خ")),
            "النصّ الخامّ لم يُقرأ: {lits:?}"
        );
        // وضابط: النصّ العاديّ يُقرأ بلا نجوم أيضاً (فالماسح لا يخترع نجوماً).
        let plain = string_literals("let a = \"س\"; let b = \"ص\";");
        assert_eq!(plain, vec!["س".to_string(), "ص".to_string()]);
    }

    /// **الحارس (عطل ٢٠٢٦-٠٩-٢٣)**: لا `**` في أي نصٍّ حرفيّ في هذا الملف.
    ///
    /// **العطل المقيس**: نصوص البوت كانت تحمل تأكيد Markdown (`**أغنية**`)،
    /// و`parse_mode` غير مضبوط في أي موضع من هذا الملف (قياس: ٨ نتائج لكلمة
    /// `parse_mode` كلّها لدالّة تحليل `callback_data`، وصفر موضع تنسيق) ⇒ تصل
    /// النجمتان **حرفيّتين** إلى الشاشة — وهي صورة المالك نفسها.
    ///
    /// **والحدّ أوسع من المطلوب عمداً**: يشمَل نصوص الاختبارات أيضاً، فلا
    /// يُخترق الحارس بنقل نصٍّ بين `mod tests` والإنتاج.
    ///
    /// (المُفسَد: إعادة `**` إلى نصّ سؤال الوضع ⇒ يسقط هذا الفحص.)
    #[test]
    fn no_bot_text_carries_literal_markdown_stars() {
        let lits = string_literals(SELF_SOURCE);
        assert!(
            lits.len() > 1500,
            "الماسح لم يقرأ الملف ({} نصّاً حرفيّاً) — وحارسٌ على مدخلٍ فارغ يمرّ كذباً",
            lits.len()
        );
        assert!(
            lits.iter().any(|l| l.contains("جارٍ التنزيل")),
            "الماسح لا يرى نصوص حالة التنزيل — فهو لا يرى ما يدّعي حراسته"
        );
        let stars: String = ['*', '*'].iter().collect();
        let bad: Vec<&String> = lits.iter().filter(|l| l.contains(&stars)).collect();
        assert!(
            bad.is_empty(),
            "نجمتا Markdown حرفيّتان في {} نصّاً يصل إلى تلغرام: {bad:?}",
            bad.len()
        );
    }
}
