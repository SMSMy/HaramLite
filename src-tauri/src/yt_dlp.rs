//! yt-dlp integration: bundled fallback binary + safe self-update
//! + URL download with progress.
//!
//! Update safety design (fixes HaramMute BUG-02 class by construction):
//!   1. stream download → `<target>.download` while hashing SHA-256
//!   2. verify against the official signed-checksums digest
//!   3. only then rename to `<target>.new`
//!   4. back up active binary → `.previous`, atomic-swap `.new` into place
//!   5. run `--version`; on ANY failure restore `.previous`
//!
//! No tokens are embedded — public API only.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn make_cmd<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd
}

const RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const ASSET_NAME: &str = "yt-dlp.exe";
const USER_AGENT: &str = concat!("HaramLite/", env!("CARGO_PKG_VERSION"));
const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

// ─────────────────────────────────────────────────────────────────────
// و-٨ — فحص الرابط قبل تمريره إلى yt-dlp
// ─────────────────────────────────────────────────────────────────────
//
// **قرار هندسي (مرفوض: قائمة مضيفين بيضاء صارمة).** الواجهة وREADME تعد
// المستخدم بـ«يوتيوب أو أي موقع آخر»، وهي وظيفة قائمة: قائمة بيضاء تُكسر
// بكل موقع لا نعرفه (Vimeo · SoundCloud · Bandcamp · موقع جامعي…) فتُبطل
// ميزة معلنة. المرفوض إذن ليس الفحص بل *تضييق قائمة المواقع*.
//
// **التهديد المقصود بالمنع** (منصوص في نموذج التهديد و-٨): استعمال تطبيقنا
// كأداة استطلاع داخل الشبكة. الرابط يأتي من الإضافة/الواجهة/تيليجرام/الـCLI،
// وyt-dlp يتّصل به؛ فطلبٌ إلى `127.0.0.1:8081` أو `192.168.1.1` أو
// `169.254.169.254` يجعل العمليّة **نفسها** تكلّم خدمة داخلية — وهو أثر لا
// علاقة له بتنزيل وسائط. المنع هنا: مخطّطان فقط + رفض كل مضيف محلي/خاص +
// رفض ما ليس مضيفاً صالحاً. كل ما تبقّى من الشبكة العامة يبقى مسموحاً.

/// فحص الرابط قبل أي اتصال. `Ok` = يُمرَّر إلى yt-dlp، و`Err` = رسالة عربية
/// تسمّي السبب (لا رفض صامت).
pub fn validate_download_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("الرابط فارغ — الصق رابط فيديو أو صوت".to_string());
    }

    // 1) المخطّط: http/https فقط. `file:` يقرأ القرص المحلي، و`data:`/`javascript:`
    //    لا شبكة لهما أصلاً — وكلها لا تعني «تنزيل وسائط».
    let rest = if let Some(r) = strip_scheme(url, "https://") {
        r
    } else if let Some(r) = strip_scheme(url, "http://") {
        r
    } else {
        let shown = url.split(':').next().unwrap_or(url);
        return Err(format!(
            "الرابط يجب أن يبدأ بـ http:// أو https:// — المخطّط «{shown}:» غير مدعوم"
        ));
    };

    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err("الرابط بلا اسم مضيف — تأكد من نسخه كاملاً".to_string());
    }
    // إزرار المستخدم: النص قبل @ ليس جزءاً من المضيف.
    let hostport = authority.rsplit('@').next().unwrap_or(authority);

    let host = if let Some(close) = hostport.find(']') {
        // IPv6 في صيغة [..]: الرمز ] يغلق العنوان، وما بعده منفذ.
        if !hostport.starts_with('[') {
            return Err("عنوان IPv6 غير صالح في الرابط".to_string());
        }
        &hostport[1..close]
    } else {
        match hostport.find(':') {
            Some(i) => &hostport[..i], // مضيف:منفذ
            None => hostport,
        }
    };

    let host = host.trim_end_matches('.');
    if host.is_empty() {
        return Err("الرابط بلا اسم مضيف — تأكد من نسخه كاملاً".to_string());
    }

    // 2) رفض المحلي والخاص (loopback · link-local · شبكات داخلية · IPv6 مقابل).
    if let Some(scope) = private_scope(host) {
        return Err(format!(
            "رابط إلى «{host}» مرفوض: عنوان {scope} — \
             HaramLite ينزّل من مواقع الإنترنت العامة فقط"
        ));
    }

    // 3) المضيف نفسه: اسم صالح أو IPv6 صالح. خانة تالفة مثل `[ ::1 ]`
    //    أو `..` تُرفض هنا لا في yt-dlp.
    if !is_ipv6_literal(host) && !is_valid_hostname(host) && !is_ipv4(host) {
        return Err(format!("اسم المضيف «{host}» غير صالح في هذا الرابط"));
    }

    Ok(())
}

/// إزالة بادئة المخطّط بلا اعتبار لحالة الأحرف (`HTTPS://` رابط صالح).
fn strip_scheme<'a>(url: &'a str, scheme: &str) -> Option<&'a str> {
    let head = url.get(..scheme.len())?;
    head.eq_ignore_ascii_case(scheme)
        .then(|| &url[scheme.len()..])
}

/// المضيف محلي أو خاص؟ `Some(وصف عربي)` = مرفوض، و`None` = شبكة عامة.
///
/// التغطية مقصودة بالكامل: `127.0.0.0/8` · `10.0.0.0/8` · `172.16.0.0/12` ·
/// `192.168.0.0/16` · `169.254.0.0/16` (ومنها `169.254.169.254` لبيانات
/// الميتا) · `0.0.0.0` · `::1` · `fc00::/7` · `fe80::/10`، ثم `localhost`
/// و`*.local` و`*.localhost` و`*.internal` وأسماء بلا نقطة (مضيف جهاز واحد).
pub fn private_scope(host: &str) -> Option<&'static str> {
    let h = host.trim_end_matches('.').to_ascii_lowercase();

    // العنوان المُغلَّف بـ[] صار مجرّداً قبل النداء، لكن نتحوّط لمَن يستدعي
    // الدالة مباشرة من الاختبار.
    let h = h
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(&h);

    // أسماء مطلقة: لا لبس فيها.
    if h == "localhost" || h == "localhost.localdomain" {
        return Some("محلي (localhost)");
    }

    let mut labels: Vec<&str> = h.split('.').collect();
    // IPv4-مُضمَّن في IPv6: `::ffff:127.0.0.1` يصل إلى 127.0.0.1 فعلاً.
    if h.contains(':') {
        if let Some(tail) = h.rsplit(':').next() {
            if is_ipv4(tail) {
                labels = tail.split('.').collect();
            }
        }
    }

    if let Some(scope) = ipv4_scope(&labels) {
        return Some(scope);
    }
    // صيغة عنوان IPv4 مبسّطة أو غير عشرية (`127.1` · `0x7f.0.0.1` ·
    // `0177.0.0.1` · `2130706433`): في مترجمات C — ومنها `inet_addr` التي
    // يبنى عليها curl وPython — كل هذه **تُقرأ عنواناً** يصل إلى الحلقة
    // المحلية، بينما فحصُنا العشري لا يعرفها. نرفضها هنا بدل أن نثق بأن
    // yt-dlp سيخطئ، فيسدّ التهريب من أصله.
    if is_ipv4_shorthand(&labels) {
        return Some("صيغة عنوان IPv4 غير قياسية (تهريب محتمل إلى عنوان محلي)");
    }
    if let Some(scope) = ipv6_scope(h) {
        return Some(scope);
    }

    // `*.local` (mDNS — سطح مكتبك) و`*.localhost` و`*.internal` (شبكة داخلية).
    if labels.len() >= 2 {
        let tld = labels[labels.len() - 1];
        if tld == "local" || tld == "localhost" || tld == "internal" {
            return Some("اسم محلي/داخلي (نطاق .local أو .internal)");
        }
    }
    // اسم بلا نقطة = مضيف على الجهاز نفسه (`http://nas/`).
    if !h.contains('.') && !h.contains(':') {
        return Some("اسم جهاز على الشبكة المحلية (بلا نطاق)");
    }
    None
}

/// أربع خانات عشرية كلها أرقام؟ (لا يعتمد على `Ipv4Addr` حتى يبقى الفحص نقياً.)
fn is_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// كل الخانات أرقام عشرية صرفة (`127` · `127.1` · `2130706433`).
fn all_labels_decimal(parts: &[&str]) -> bool {
    parts
        .iter()
        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// شكل عنوان IPv4 غير قياسي: رقم واحد، أو خانة أولى رقمية، أو أربع خانات
/// إحداها غير عشرية (`0x7f`) — كلها صيغ يقرؤها `inet_addr` عنواناً.
/// الأسماء الحقيقية لا تبدأ بخانة رقمية صرفة في هذا الاستعمال.
fn is_ipv4_shorthand(parts: &[&str]) -> bool {
    if parts.is_empty() {
        return false;
    }
    if all_labels_decimal(parts) {
        return true; // 127 · 127.1 · 2130706433 · 1.2.3.4
    }
    let labels_are_alnum = parts
        .iter()
        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric()));
    if !labels_are_alnum {
        return false;
    }
    // `0x7f.0.0.1` · `0177.0.0.1` · `1a.b.c.1`: آخر خانة عشرية صرفة وإحداها لا.
    if parts.len() == 4
        && parts[3].bytes().all(|b| b.is_ascii_digit())
        && parts.iter().any(|p| !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return true;
    }
    // `0x7f` وحدها (بلا نقاط) صيغة مختصرة كذلك.
    parts.len() == 1
        && parts[0].bytes().all(|b| b.is_ascii_alphanumeric())
        && parts[0].bytes().any(|b| b.is_ascii_digit())
}

/// وصف النطاق الخاص لـIPv4، أو `None` إن كان عنواناً عاماً.
fn ipv4_scope(parts: &[&str]) -> Option<&'static str> {
    if parts.len() != 4 {
        return None;
    }
    let mut octet = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        octet[i] = p.parse::<u8>().ok()?;
    }
    ipv4_octets_scope(octet)
}

/// التصنيف من **القيمة** لا من النصّ — نقطة واحدة تخدم IPv4 نصّياً وIPv4
/// المُضمَّن في IPv6 (`::ffff:127.0.0.1`) والـ6to4/NAT64.
fn ipv4_octets_scope(octet: [u8; 4]) -> Option<&'static str> {
    let [a, b, _, _] = octet;
    match (a, b) {
        (127, _) => Some("حلقة محلية (127.0.0.0/8)"),
        (10, _) => Some("شبكة خاصة (10.0.0.0/8)"),
        (172, 16..=31) => Some("شبكة خاصة (172.16.0.0/12)"),
        (192, 168) => Some("شبكة خاصة (192.168.0.0/16)"),
        (169, 254) => Some("عنوان link-local (169.254.0.0/16) — ومنه بيانات الميتا"),
        (0, _) => Some("عنوان غير محدَّد (0.0.0.0)"),
        _ => None,
    }
}

/// نطاقات IPv6 المحلية — **من القيمة المحلَّلة لا من بادئة النصّ**.
///
/// كان الفحص السابق يقارن النصّ (`host == "::1"` وبادئات `fc`/`fd`/`fe8`)،
/// فمرّت منه **ثلاث صور متكافئة للحلقة المحلية** كشفها هجوم المشرف بعد الدمج:
/// `[0:0:0:0:0:0:0:1]` (الصيغة الكاملة) · `[::]` (غير محدَّد) ·
/// `[::ffff:7f00:1]` (‏IPv4 مُضمَّن بالست عشرية — والصيغة المنقوطة وحدها كانت
/// مغطّاة). الآن يُحلَّل العنوان إلى ثماني مجموعات ثم يُصنَّف، فالصور المتكافئة
/// تُصنَّف تصنيفاً واحداً.
fn ipv6_scope(host: &str) -> Option<&'static str> {
    let g = parse_ipv6(host)?;

    // `::` غير محدَّد (يقابل 0.0.0.0 في IPv4).
    if g.iter().all(|x| *x == 0) {
        return Some("عنوان غير محدَّد (::)");
    }
    // `::1` الحلقة المحلية، بأي صيغة كُتبت.
    if g[..7].iter().all(|x| *x == 0) && g[7] == 1 {
        return Some("حلقة محلية (::1)");
    }
    // IPv4 مُضمَّن: `::ffff:a.b.c.d` أو `::ffff:hhhh:hhhh` (الصيغتان متكافئتان).
    if g[..5].iter().all(|x| *x == 0) && g[5] == 0xffff {
        let v4 = [(g[6] >> 8) as u8, g[6] as u8, (g[7] >> 8) as u8, g[7] as u8];
        if let Some(scope) = ipv4_octets_scope(v4) {
            return Some(scope);
        }
    }
    // 6to4 (`2002:V4V4::/16`) و NAT64 (`64:ff9b::V4V4/96`): كلاهما يحمل IPv4
    // داخله، فتُستخرج القيمة وتُصنَّف بدل أن تمرّ باسم «شبكة عامة».
    if g[0] == 0x2002 {
        let v4 = [(g[1] >> 8) as u8, g[1] as u8, (g[2] >> 8) as u8, g[2] as u8];
        if let Some(scope) = ipv4_octets_scope(v4) {
            return Some(scope);
        }
    }
    if g[0] == 0x0064 && g[1] == 0xff9b && g[2..6].iter().all(|x| *x == 0) {
        let v4 = [(g[6] >> 8) as u8, g[6] as u8, (g[7] >> 8) as u8, g[7] as u8];
        if let Some(scope) = ipv4_octets_scope(v4) {
            return Some(scope);
        }
    }
    let first = g[0];
    if first & 0xfe00 == 0xfc00 {
        return Some("شبكة محلية فريدة (fc00::/7)");
    }
    if first & 0xffc0 == 0xfe80 {
        return Some("عنوان link-local (fe80::/10)");
    }
    if first & 0xff00 == 0xff00 {
        return Some("عنوان multicast (ff00::/8)");
    }
    None
}

/// يحلّل عنوان IPv6 نصّياً إلى ثماني مجموعات: يدعم `::` مرة واحدة، ويقبل
/// الصيغة العشرية المنقوطة في الموضع الأخير (`::ffff:127.0.0.1`).
/// `None` = ليس عنوان IPv6 صالحاً (فيُرفض لاحقاً كاسم مضيف غير صالح).
fn parse_ipv6(text: &str) -> Option<[u16; 8]> {
    if !text.contains(':') {
        return None;
    }
    let (head, tail, gap) = match text.split_once("::") {
        Some((h, t)) => (h, t, true),
        None => (text, "", false),
    };
    if gap && tail.contains("::") {
        return None; // `::` مرتين
    }
    let mut groups: Vec<u16> = Vec::new();
    let mut parts = 0usize;
    if !head.is_empty() {
        for p in head.split(':') {
            push_ipv6_part(p, &mut groups)?;
            parts += 1;
        }
    }
    let mut tail_groups: Vec<u16> = Vec::new();
    if gap && !tail.is_empty() {
        for p in tail.split(':') {
            push_ipv6_part(p, &mut tail_groups)?;
            parts += 1;
        }
    }
    if !gap {
        if parts != 8 {
            return None;
        }
    } else {
        // `::` يمثّل مجموعة واحدة على الأقل.
        if groups.len() + tail_groups.len() > 7 {
            return None;
        }
        while groups.len() + tail_groups.len() < 8 {
            groups.push(0);
        }
    }
    groups.extend(tail_groups);
    if groups.len() != 8 {
        return None;
    }
    let mut out = [0u16; 8];
    out.copy_from_slice(&groups);
    Some(out)
}

/// يدفع مقطعاً واحداً (ست عشري، أو عنوان IPv4 منقوط يُنتج مجموعتين).
fn push_ipv6_part(part: &str, groups: &mut Vec<u16>) -> Option<()> {
    if part.is_empty() {
        return None;
    }
    if part.contains('.') {
        let oct: Vec<&str> = part.split('.').collect();
        if oct.len() != 4 {
            return None;
        }
        let mut b = [0u8; 4];
        for (i, o) in oct.iter().enumerate() {
            if o.is_empty() || o.len() > 3 || !o.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            b[i] = o.parse::<u8>().ok()?;
        }
        groups.push(u16::from_be_bytes([b[0], b[1]]));
        groups.push(u16::from_be_bytes([b[2], b[3]]));
        return Some(());
    }
    if part.len() > 4 || !part.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    groups.push(u16::from_str_radix(part, 16).ok()?);
    Some(())
}

/// عنوان IPv6 صالح؟ الحكم **بالمحلّل** لا بشكل المحارف، فالصيغة الكاملة
/// (`0:0:0:0:0:0:0:1`) صالحة كـ`::1` تماماً — وهو ما كان يسقط سابقاً.
fn is_ipv6_literal(host: &str) -> bool {
    parse_ipv6(host).is_some()
}

/// اسم مضيف صالح (RFC 1123 مبسّط): كل لاحقة من [A-Za-z0-9-] ولا تبدأ/تنتهي
/// بشرطة، والاسم كله بلا فراغ ولا محرف غريب. أسماء يونيكود (IDN) تُرفض هنا
/// عن قصد: yt-dlp لا يفهمها بلا ترميز Punycode، والفحص لا يخمّن.
fn is_valid_hostname(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

#[derive(Debug)]
pub enum YtError {
    NotFound,
    Net(String),
    Verify(String),
    Io(String),
    /// و-٨: الرابط نفسه مرفوض قبل أي اتصال (مخطّط غير مدعوم، مضيف محلي/خاص،
    /// أو اسم مضيف غير صالح). نصّه عربي جاهز للعرض كما هو.
    Rejected(String),
    /// **فشل عمليّة التنزيل نفسها** — لا قراءة/كتابة ملف: خروج yt-dlp برمز
    /// غير صفر، جمود، انقطاع أنبوبه، إلغاء، أو «نجح دون ملف ناتج».
    ///
    /// **ولماذا وُجد (بلاغ المالك 2026-09-23)**: كان كل هذا يُمرَّر من باب
    /// `YtError::Io` فيُعرَض **«ملفات: yt-dlp خرج بـexit code: 1»** على فشل
    /// شبكي/موقعي — تسميةٌ خاطئة حيّرت المالك (بحث عن عطل ملفات ولا ملفَّ هنا).
    /// ورسائله **تصف نفسها** (تسمّي yt-dlp أو التنزيل)، فلا تُسبَق بوسمٍ عام
    /// يُكرّر «فشل التنزيل:» الذي يضيفه كل مستدعٍ (‏`cli.rs` · `telegram.rs`) —
    /// وهذا هو الفرق الوحيد في العرض عن `Io`، ولا يُغيَّر به أي رمز `E_*`.
    Process(String),
}

impl std::fmt::Display for YtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "لا يوجد yt-dlp محلياً ولا يمكن تنزيله"),
            Self::Net(e) => write!(f, "شبكة: {e}"),
            Self::Verify(e) => write!(f, "فشل التحقق: {e}"),
            Self::Io(e) => write!(f, "ملفات: {e}"),
            Self::Rejected(e) => write!(f, "{e}"),
            Self::Process(e) => write!(f, "{e}"),
        }
    }
}

/// **منفذ الاختبار الوحيد في هذا الملف**: مسار ثنائيّ مزيّف لدور yt-dlp.
///
/// **ولماذا هو أمين ولا يقيس تمثيلاً**: لا يغيّر إلا **من أين يُقرأ الثنائي** —
/// وكل ما بعده كود الإنتاج بعينه: بناء الأمر · `spawn` · **تسجيل المقبض** ·
/// حلقة الإلغاء · قراءة التقدّم · الحصاد. فالحارس الذي يستعمله يمرّ من
/// `download_media` نفسها (نقطة العبور الوحيدة لكل تنزيل رابط)، لا من بديل
/// يشبهها — وهو الدرس المقيس في م٣/إصلاح٢: الحارس القديم شغّل `ping` عبر
/// `proc::run_cancellable` (المسار **المسجَّل**) بينما yt-dlp يسلك مساراً
/// آخر ⇒ حارس أخضر ومنتج معطوب.
///
/// **ولا يُقرأ في الإنتاج**: `#[cfg(test)]` كاملاً، فلا يصل إلى بناء الإصدار.
#[cfg(test)]
pub(crate) fn ytdlp_test_override() -> &'static Mutex<Option<PathBuf>> {
    static OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);
    &OVERRIDE
}

/// Resolve bundled/local yt-dlp.exe. Order mirrors ffmpeg resolver plus the
/// per-user tools dir used by updates.
pub fn resolve_ytdlp() -> Option<PathBuf> {
    #[cfg(test)]
    if let Ok(g) = ytdlp_test_override().lock() {
        if let Some(p) = g.as_ref() {
            return Some(p.clone());
        }
    }
    let exe = ASSET_NAME;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("HARAMLITE_TOOLS_DIR") {
        candidates.push(PathBuf::from(&dir).join(exe));
        candidates.push(PathBuf::from(dir).join("tools").join("yt-dlp").join(exe));
    }
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(base)
                .join("com.harammute.haramlite")
                .join("tools")
                .join("yt-dlp")
                .join(exe),
        );
    }
    if let Ok(cur) = std::env::current_exe() {
        if let Some(parent) = cur.parent() {
            candidates.push(parent.join("bin").join(exe));
            for ancestor in parent.ancestors().skip(1) {
                candidates.push(ancestor.join("bin").join(exe));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("../bin").join(exe));
        candidates.push(cwd.join("bin").join(exe));
    }
    candidates.into_iter().find(|c| c.is_file())
}

fn state_path() -> PathBuf {
    // Audit 2026-09-03: overridable so unit tests never touch (or leave
    // stale) the user's real update state.
    if let Ok(dir) = std::env::var("HARAMLITE_YTDLP_STATE_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir).join("update_state.json");
        }
    }
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("com.harammute.haramlite")
        .join("tools")
        .join("yt-dlp")
        .join("update_state.json")
}

/// Last `n` captured stdout lines, oldest first — attached to download
/// failures so the #1 recurring user error is diagnosable (audit 2026-09-03).
fn tail_text(tail: &VecDeque<String>, n: usize) -> String {
    tail.iter()
        .skip(tail.len().saturating_sub(n))
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

/// **كم سطراً من `stderr` نحفظه للفشل — معلن لا ضمنيّ** (ونظير stdout: ٤٠ سطراً).
///
/// **ولماذا وُجد (عطل ميداني، بلاغ المالك 2026-09-23)**: `yt-dlp` يكتب التقدّم
/// على **stdout** ويكتب `ERROR: …` على **stderr**. وكان stderr يُصرَّف في خيط
/// **إلى بالوعة تُرمى** (`while let Ok(n) = r.read(&mut sink)`)، وذيل الفشل
/// يُبنى من stdout وحده ⇒ فشلٌ يصل المستخدم والسجلّ **بلا سببه إطلاقاً**:
/// «التنزيل بلغ ١٠٠٪ ثم `exit code: 1`» ولا سطر خطأ واحد. فصار stderr يُجمَع
/// في **نفس خيط التصريف** (لا خيط ثانٍ لأنبوب واحد) وبحدّ سطور صريح.
const STDERR_TAIL_LINES: usize = 40;

/// سقف بايتات **السطر الواحد** من stderr: سطرٌ ضخم (تفريغ صفحة أو تتبّع طويل)
/// لا يبتلع الذاكرة بلا حدّ. الزائد يُقصّ ويُوسَم في نصّ السطر نفسه.
const STDERR_LINE_CAP: usize = 4096;

/// **مهلة انتظار انتهاء تصريف stderr** قبل بناء نصّ الفشل: بايتات yt-dlp تكون
/// في الأنبوب عند خروجه، ويقرؤها خيط التصريف بعد أن يُجدوَل — فالانتظار يجعل
/// نصّ الفشل يحمل السبب المكتوب **قبل** الخروج لا ما وصل منه صدفةً.
///
/// **وهي محدودة عن قصد**: `yt-dlp.exe` عمليّتان (مُشغّل ← عامل، مقيس)، وعاملٌ
/// ناجٍ قد يمسك الأنبوب الموروث مفتوحاً بعد موت مُشغّله — فلا نُعلّق تقرير
/// الفشل لأجله (يُبنى النصّ بما قُرئ حتى تلك اللحظة).
const STDERR_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_millis(1000);

/// ما يُكتب مكان ذيلٍ فارغ: **معلن** لأن [`is_transient_failure`] يميّز به
/// «سببٌ مكتوب» من «لا سبب» — فلا يُقرأ الفراغ سبباً عابراً.
const EMPTY_STDERR: &str = "(فارغ)";

/// **ذيل stderr المحدود**: يملؤه خيط التصريف، ويُقرأ عند الفشل.
struct StderrTail {
    lines: Arc<Mutex<VecDeque<String>>>,
    /// إشارة انتهاء خيط التصريف — تُؤخذ **مرّة واحدة** في [`StderrTail::text`]
    /// فلا يُنتظر مرّتين في المسار نفسه.
    done: Option<std::sync::mpsc::Receiver<()>>,
}

impl StderrTail {
    /// آخر `n` سطراً من stderr — و`"(فارغ)"` إن لم يكتب yt-dlp شيئاً عليها
    /// (نصٌّ صريح خير من خانة بيضاء تُقرأ كأنها لم تُفحَص).
    fn text(&mut self, n: usize) -> String {
        if let Some(rx) = self.done.take() {
            let _ = rx.recv_timeout(STDERR_DRAIN_GRACE);
        }
        let g = self.lines.lock().unwrap_or_else(|p| p.into_inner());
        if g.is_empty() {
            EMPTY_STDERR.to_string()
        } else {
            tail_text(&g, n)
        }
    }
}

/// يُضيف سطراً إلى ذيل stderr بحدّيه المعلنين: [`STDERR_TAIL_LINES`] سطراً
/// و[`STDERR_LINE_CAP`] بايتاً للسطر الواحد.
fn push_stderr_line(lines: &Mutex<VecDeque<String>>, raw: &[u8], cut: bool) {
    // السقف يُفرض **هنا أيضاً** لا على القارئ وحده: أي مستدعٍ يمرّر سطراً أطول
    // من [`STDERR_LINE_CAP`] يُقصّ ويُوسَم — فالحدّ معلن في مكان واحد.
    let over = raw.len() > STDERR_LINE_CAP;
    let raw = if over { &raw[..STDERR_LINE_CAP] } else { raw };
    let mut line = String::from_utf8_lossy(raw).trim().to_string();
    if line.is_empty() {
        return; // سطر فارغ لا يحمل سبباً ولا يستحقّ خانةً في الذيل
    }
    if cut || over {
        line.push_str(&format!(" …[قُصَّ: تجاوز سطرٌ واحد {STDERR_LINE_CAP} بايت]"));
    }
    if let Ok(mut g) = lines.lock() {
        g.push_back(line);
        while g.len() > STDERR_TAIL_LINES {
            g.pop_front();
        }
    }
}

/// **تصريف stderr + حفظ ذيله المحدود — في خيط واحد** (لا خيطان لأنبوب واحد).
///
/// التصريف ليس ترفاً: أنبوب stderr غير المقروء يمتلئ (~64KB) فيُوقف الطفل في
/// منتصف التنزيل. والحفظ هو ما كان مفقوداً: كان هذا الخيط `while let Ok(n) =
/// r.read(&mut sink)` — يقرأ **ليرمي**، فيضيع `ERROR: …` كاملاً.
fn drain_stderr<R: std::io::Read>(
    mut r: R,
    lines: Arc<Mutex<VecDeque<String>>>,
    done: std::sync::mpsc::Sender<()>,
) {
    let mut chunk = [0u8; 8192];
    // السطر الجاري: الأنبوب يُقرأ قطعاً، والسطر قد يمتدّ على قطع كثيرة.
    let mut partial: Vec<u8> = Vec::new();
    let mut cut = false;
    loop {
        match r.read(&mut chunk) {
            // Err كذلك نهاية الطريق: الأنبوب كُسر ⇒ لا مزيد من الأسطر.
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &b in &chunk[..n] {
                    if b == b'\n' {
                        push_stderr_line(&lines, &partial, cut);
                        partial.clear();
                        cut = false;
                    } else if partial.len() < STDERR_LINE_CAP {
                        partial.push(b);
                    } else {
                        cut = true; // أطول من السقف ⇒ يُقصّ ويُوسَم
                    }
                }
            }
        }
    }
    // سطر أخير بلا `\n` (yt-dlp قد يختم بلا سطر جديد، وقصُّ الخروج يفقد آخره).
    if !partial.is_empty() || cut {
        push_stderr_line(&lines, &partial, cut);
    }
    let _ = done.send(());
}

/// **ذيل الفشل بوسم صريح يفصل القناتين**: `stdout` تقدّمٌ و`stderr` هو السبب.
/// وهو **نصّ واحد** يذهب إلى السجلّ وإلى رسالة المستخدم معاً، فلا يعرف أحدهما
/// ما يجهله الآخر (وهو ما وقع: المستخدم رأى «exit code: 1» بلا سبب).
fn failure_tail(stdout_tail: &VecDeque<String>, stderr_tail: &mut StderrTail, n: usize) -> String {
    let so = tail_text(stdout_tail, n);
    let so = if so.is_empty() {
        "(فارغ)".to_string()
    } else {
        so
    };
    format!(
        "— stdout (آخر {n} سطراً):\n{so}\n— stderr (آخر {n} سطراً):\n{}",
        stderr_tail.text(n)
    )
}

/// **سقف المحاولات**: محاولة واحدة + **إعادة واحدة** — لا حلقة إعادة.
/// والرقم مقيس: الفشل الميداني (‏403) عابر (١ من ٣ محاولات)، وإعادةٌ واحدة
/// كانت تُنجحها؛ وما بعدها إعادةٌ على فشلٍ يتكرّر ⇒ انتظارٌ وباندويث بلا سبب.
const DOWNLOAD_ATTEMPTS: u32 = 2;

/// **نصوص الفشل الدائم** كما تكتبها yt-dlp على stderr — لا إعادة عليها مهما
/// كان الشكل: الإعادة على «Video unavailable» انتظارٌ مقابل نتيجةٍ محتومة.
const PERMANENT_FAILURES: &[&str] = &[
    "Video unavailable",
    "Private video",
    "Sign in to confirm",
    "This video is not available",
    "requested format is not available",
];

/// **هل يُعاد على هذا الفشل؟** شرطان معاً:
/// ① **سببٌ مكتوب** على stderr (`"(فارغ)"` ليس سبباً — فلا إعادة على عمى)،
/// ② **ولا نصَّ فشل دائم** من [`PERMANENT_FAILURES`].
///
/// **وحدّ الصدق فيه**: ما لم يُذكر في القائمة يُعدّ عابراً ⇒ يُعاد عليه مرّة.
/// والمقيس أن الفشل الميداني (‏403) ليس في القائمة، وأن نصوص yt-dlp الدائمة
/// المعروفة فيها.
fn is_transient_failure(stderr_text: &str) -> bool {
    let t = stderr_text.trim();
    if t.is_empty() || t == EMPTY_STDERR {
        return false;
    }
    !PERMANENT_FAILURES.iter().any(|p| t.contains(p))
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
pub struct UpdateState {
    pub checked_at: u64,
    pub version: String,
}

fn read_state() -> UpdateState {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_state(st: &UpdateState) -> Result<(), YtError> {
    let p = state_path();
    // و-٦: tmp + `sync_all` + rename عبر المساعد الموحّد. اسم المؤقت لم
    // يتغيّر (`update_state.json.tmp`) والسلوك الظاهر واحد.
    let body = serde_json::to_string_pretty(st).unwrap_or_default();
    crate::atomic::write_atomic_str(&p, &body, "json").map_err(|e| YtError::Io(e.to_string()))
}

pub fn local_version() -> Option<String> {
    let exe = resolve_ytdlp()?;
    let out = make_cmd(&exe).arg("--version").output().ok()?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .to_string()
        .into()
}

/// True when a check is due (24h cadence or forced).
pub fn is_check_due(force: bool) -> bool {
    if force {
        return true;
    }
    let st = read_state();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now.saturating_sub(st.checked_at) >= CHECK_INTERVAL_SECS
}

// ─────────────────────────────────────────────────────────────────────
// Release metadata (GitHub public API — no tokens)
// ─────────────────────────────────────────────────────────────────────

struct Release {
    tag: String,
    exe_url: String,
    sums_url: String,
}

fn fetch_release() -> Result<Release, YtError> {
    let resp = ureq::get(RELEASE_API)
        .timeout(std::time::Duration::from_secs(30))
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| YtError::Net(e.to_string()))?;
    let v: serde_json::Value = resp.into_json().map_err(|e| YtError::Net(e.to_string()))?;

    let tag = v["tag_name"]
        .as_str()
        .ok_or_else(|| YtError::Net("release بدون tag_name".into()))?
        .to_string();
    let assets = v["assets"].as_array().cloned().unwrap_or_default();

    let pick = |name: &str| -> Option<String> {
        assets.iter().find_map(|a| {
            if a["name"].as_str()? == name {
                a["browser_download_url"].as_str().map(str::to_string)
            } else {
                None
            }
        })
    };

    Ok(Release {
        sums_url: format!("https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/SHA2-256SUMS"),
        exe_url: pick(ASSET_NAME)
            .ok_or_else(|| YtError::Net("أصل yt-dlp.exe مفقود من الإصدار".into()))?,
        tag,
    })
}

fn fetch_text(url: &str) -> Result<String, YtError> {
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(60))
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| YtError::Net(e.to_string()))?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut resp.into_reader(), &mut buf)
        .map_err(|e| YtError::Net(e.to_string()))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Extract <sha>  yt-dlp.exe line from official SHA2-256SUMS content.
pub fn parse_sums_for(content: &str, filename: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let digest = parts.next()?;
        let name = parts.next()?;
        (name == filename && digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| digest.to_lowercase())
    })
}

/// Stream url to disk while hashing; verify digest BEFORE promoting file.
fn download_verified(
    url: &str,
    dest: &Path,
    expected: &str,
    progress: &dyn Fn(f32),
) -> Result<(), YtError> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(30))
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| YtError::Net(e.to_string()))?;

    let total = resp
        .header("Content-Length")
        .and_then(|h| h.parse::<u64>().ok())
        .unwrap_or(0);

    let tmp = dest.with_extension("download");
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| YtError::Io(format!("{}: {e}", tmp.display())))?;
    let mut hasher = Sha256::new();
    let mut reader = resp.into_reader();
    let mut gotten: u64 = 0;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = std::io::Read::read(&mut reader, &mut chunk)
            .map_err(|e| YtError::Net(e.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
        file.write_all(&chunk[..read])
            .map_err(|e| YtError::Io(e.to_string()))?;
        gotten += read as u64;
        if total > 0 {
            progress(gotten as f32 / total as f32);
        }
    }
    file.flush().ok();
    drop(file);

    let actual = format!("{:x}", hasher.finalize());
    if actual != expected.to_lowercase() {
        let _ = std::fs::remove_file(&tmp);
        return Err(YtError::Verify(format!(
            "بصمة التنزيل لا تطابق المجاميع الرسمية: {actual}"
        )));
    }
    // verified → promote to .new (atomic rename on same volume)
    std::fs::rename(&tmp, dest).map_err(|e| YtError::Io(e.to_string()))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Safe update orchestration
// ─────────────────────────────────────────────────────────────────────

/// Ensure the local yt-dlp is current (24h cadence). Never fatal:
/// the bundled fallback keeps working regardless. Returns (updated, message).
pub fn ensure_updated(force: bool, progress: &dyn Fn(f32)) -> (bool, String) {
    if !is_check_due(force) {
        return (false, "لم يحن موعد فحص التحديث".into());
    }

    let release = match fetch_release() {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("تخطي التحديث: {e}");
            tracing::warn!(target: "ytdlp", "{msg}");
            return (false, msg);
        }
    };

    if let Some(v) = local_version() {
        if v == release.tag {
            let ver = v.clone();
            let _ = write_state(&UpdateState {
                checked_at: now_secs(),
                version: ver,
            });
            return (false, format!("yt-dlp محدّث بالفعل ({v})"));
        }
        tracing::info!(target: "ytdlp", "update available: {v} → {}", release.tag);
    } else {
        tracing::info!(target: "ytdlp", "no local yt-dlp — bootstrapping {}", release.tag);
    }

    // official checksum for the exe asset
    let sums = match fetch_text(&release.sums_url) {
        Ok(s) => s,
        Err(e) => return (false, format!("تعذر جلب المجاميع الموقعة: {e}")),
    };
    let expected = match parse_sums_for(&sums, ASSET_NAME) {
        Some(d) => d,
        None => return (false, "SHA2-256SUMS لا يحتوي yt-dlp.exe".into()),
    };

    // target path = per-user tools dir (writable even for installed builds)
    let target = std::env::var("LOCALAPPDATA")
        .map(|b| {
            PathBuf::from(b)
                .join("com.harammute.haramlite")
                .join("tools")
                .join("yt-dlp")
                .join(ASSET_NAME)
        })
        .unwrap_or_else(|_| PathBuf::from("tools").join("yt-dlp").join(ASSET_NAME));
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let new_path = target.with_extension("new");
    let dl_progress = |p: f32| progress(p * 0.9); // reserve 10% for verify/swap
    if let Err(e) = download_verified(&release.exe_url, &new_path, &expected, &dl_progress) {
        let msg = format!("فشل تنزيل التحديث (أبقينا النسخة العاملة): {e}");
        tracing::warn!(target: "ytdlp", "{msg}");
        return (false, msg);
    }

    // backup → swap → sanity probe → rollback on failure
    let active = resolve_ytdlp();
    let backup = target.with_extension("exe.previous");
    if let Some(active_path) = &active {
        let _ = std::fs::copy(active_path, &backup);
    }

    if let Err(e) = std::fs::rename(&new_path, &target) {
        let msg = format!("فشل تبديل الملف الجديد: {e}");
        tracing::warn!(target: "ytdlp", "{msg}");
        return (false, msg);
    }
    let probe = make_cmd(&target).arg("--version").output();
    match probe {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if ver != release.tag {
                tracing::warn!(target: "ytdlp", "post-install version mismatch: {ver} != {}", release.tag);
            }
            if let Some(_ap) = &active {
                let _ = std::fs::remove_file(&backup);
            }
            write_state(&UpdateState {
                checked_at: now_secs(),
                version: ver.clone(),
            })
            .ok();
            progress(1.0);
            (true, format!("تم تحديث yt-dlp إلى {ver}"))
        }
        other => {
            // rollback
            if let Some(ap) = &active {
                if ap.exists() && backup.exists() {
                    let _ = std::fs::copy(&backup, ap);
                }
            }
            let reason = other
                .map(|o| format!("status={}", o.status))
                .unwrap_or_else(|e| e.to_string());
            let msg = format!("فشل فحص النسخة الجديدة ({reason}) — استرجعنا السابقة");
            tracing::warn!(target: "ytdlp", "{msg}");
            (false, msg)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// Media download via yt-dlp
// ─────────────────────────────────────────────────────────────────────

/// Download `url` media (full video `bv*+ba/b` muxed to mp4; no playlists)
/// into out_dir. Returns the finished file path. Progress parsed from
/// `--newline` output.
/// The progress closure returns false to abort; `cancel` is polled by a
/// monitor thread so cancellation also works while yt-dlp is MERGING
/// (no progress lines during that phase).
pub fn download_media(
    url: &str,
    out_dir: &Path,
    progress: &dyn Fn(f32) -> bool,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<PathBuf, YtError> {
    download_media_inner(url, out_dir, progress, cancel, false)
}

/// Watch-temp download: audio only (`ba/b`, small + fast) for in-page
/// listening — no video stream is ever fetched or saved.
pub fn download_audio(
    url: &str,
    out_dir: &Path,
    progress: &dyn Fn(f32) -> bool,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<PathBuf, YtError> {
    download_media_inner(url, out_dir, progress, cancel, true)
}

/// Pure format selector (unit-tested): temp listens take audio only.
pub fn format_selector(audio_only: bool) -> &'static str {
    if audio_only {
        "ba/b"
    } else {
        "bv*+ba/b"
    }
}

/// How long a download may go without a single stdout line before it is
/// declared stalled, killed and failed (functional gap: stall watchdog).
const STALL_SECS: u64 = 15 * 60;

/// Video metadata needed before any byte moves: a safe deterministic slot
/// plus a pretty display name.
struct VideoMeta {
    id: String,
    title: String,
}

/// سقف قراءة بيانات الفيديو الوصفية: الردّ **يُحلَّل كاملاً** بـ`serde_json`،
/// وقِيس على هذه الآلة أن فيديو واحداً (‏4K بعشرات الترجمات) أعاد
/// **٦٦٣٬٤٩٥ بايتاً** ⇒ فالسقف الافتراضي لذيل الأدوات (٢٥٦KB) كان سيقصّ أوّله
/// فيصير غير مقروء. والحدّ هنا **معلن وواسع** (٢٤ ضعف المقيس) لا بلا حدّ.
const META_CAP: usize = 16 * 1024 * 1024;

/// One metadata-only call. Cheap (~1s) and it decides everything downstream:
/// without a trustworthy id there is no safe slot, so fail here loudly
/// instead of downloading blindly into a name we cannot re-identify.
///
/// **وقابليتها للقتل (م٣/إصلاح٢)**: كانت `.output()` — حجبٌ أعمى **بلا مقبض
/// وبلا رمز إلغاء**، وهي **أوّل عملية في مهمّة الرابط**: إلغاءٌ يقع فيها لم يكن
/// يوقف شيئاً حتى تنتهي (‏`--socket-timeout 20` لكل عملية شبكة، ومهلة النداء
/// كاملاً قد تطول على شبكة متعثّرة). فصارت تمرّ بـ
/// [`crate::proc::run_cancellable_with_cap`]: مقبض مسجَّل ⇒ `cancel_job` يقتلها
/// مع شجرتها، وحلقة استطلاع تقرأ الرمز.
fn fetch_meta(
    exe: &Path,
    url: &str,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<VideoMeta, YtError> {
    let token = crate::proc::CancelToken::from_flag(cancel.clone());
    let out = crate::proc::run_cancellable_with_cap(
        exe,
        // Arabic titles: force yt-dlp's stdout to UTF-8 instead of the Windows
        // console codepage (cp1256 on this machine) — keeps logs exact.
        &[("PYTHONIOENCODING", "utf-8")],
        &[
            "--no-playlist",
            "--skip-download",
            "--socket-timeout",
            "20",
            "--dump-single-json",
            url,
        ],
        Some(&token),
        META_CAP,
    )
    .map_err(|e| {
        // الإلغاء ليس فشل شبكة: نصّه العربي يصل كما هو (والمستدعي يختار نصّ
        // «🛑 أُلغيت» بعلم الإلغاء لا بنصّ الخطأ) — وليس فشل **ملفات** أيضاً
        // (كان `Io` فيُعرَض «ملفات: أُلغي التنزيل…»).
        if e == crate::proc::CANCELLED {
            YtError::Process(e)
        } else {
            YtError::Net(e)
        }
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let lines: Vec<&str> = stderr.lines().collect();
        let start = lines.len().saturating_sub(5);
        return Err(YtError::Net(format!(
            "تعذر قراءة بيانات الفيديو: {}",
            lines[start..].join(" | ")
        )));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| YtError::Net(format!("بيانات غير مقروءة: {e}")))?;
    let id = v
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(YtError::Net("تعذر تحديد معرف الفيديو".into()));
    }
    let title = v
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(VideoMeta {
        title: if title.is_empty() { id.clone() } else { title },
        id,
    })
}

/// Our own filename sanitizer, applied ONCE to a name WE then write via
/// rename — by construction the computed name always equals the disk name.
/// This ends the whole class where yt-dlp PRINTS `Just A Dream` but SAVES
/// `＂Just A Dream＂` (U+FF02 one-way sanitizing on Windows): we never read
/// yt-dlp's mind again, we only match our deterministic `hl_<id>_*` slot.
pub fn sanitize_title(title: &str, fallback_id: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    // Windows forbids trailing dots/spaces (also after truncation below).
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    let s = s.trim().to_string();
    // Leave headroom for collision suffix + extension.
    let mut s: String = s.chars().take(180).collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() {
        format!("video_{fallback_id}")
    } else {
        s
    }
}

/// Unique-per-attempt slot stem. The id part keeps every attempt of one video
/// findable; the suffix keeps concurrent attempts from sharing one file
/// (same URL from bridge + GUI at once degrades to redundant work, never to
/// a corrupted shared file or an overwrite of user data).
fn slot_stem(video_id: &str) -> String {
    static ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("hl_{video_id}_{}_{n}", std::process::id())
}

/// Our slot files for this video (any attempt suffix), newest first.
/// Skips transient junk (`.part`/`.ytdl`/`.tmp`) — those are never complete.
fn find_slots(out_dir: &Path, video_id: &str) -> Vec<PathBuf> {
    let prefix = format!("hl_{video_id}_");
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(out_dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with(&prefix) || !p.is_file() {
                continue;
            }
            if name.ends_with(".part") || name.ends_with(".ytdl") || name.ends_with(".tmp") {
                continue;
            }
            let m = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            found.push((m, p));
        }
    }
    found.sort_by_key(|b| std::cmp::Reverse(b.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// A pre-existing slot file is only reusable when it is a REAL complete
/// media file: killed mid-merge runs leave corrupt slot files behind, so
/// non-empty plus a valid probe with positive duration is required.
fn slot_usable(p: &Path) -> bool {
    if std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) == 0 {
        return false;
    }
    crate::media::probe(p)
        .map(|info| info.has_audio && info.duration_secs > 0.0)
        .unwrap_or(false)
}

/// Delete our stale slot files and transient junk (crash leftovers).
/// Only `hl_<id>_*` matches — user files are never touched.
fn clear_slots(out_dir: &Path, video_id: &str) {
    let prefix = format!("hl_{video_id}_");
    if let Ok(rd) = std::fs::read_dir(out_dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with(&prefix) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

/// Promote a slot file to its pretty user-facing name (computed by OUR
/// sanitizer, so the rename target is exactly what lands on disk).
/// Collisions resolve with the unique id suffix — never overwrite user data.
/// A redundant twin (same video downloaded twice concurrently) is dropped in
/// favor of the existing file.
fn promote_slot(slot: &Path, out_dir: &Path, meta: &VideoMeta) -> Result<PathBuf, YtError> {
    let ext = slot.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    let stem = sanitize_title(&meta.title, &meta.id);
    let mut dest = out_dir.join(format!("{stem}.{ext}"));
    if dest != slot && dest.is_file() {
        dest = out_dir.join(format!("{stem} [{}].{ext}", meta.id));
    }
    if dest == slot {
        return Ok(dest);
    }
    if dest.is_file() {
        let _ = std::fs::remove_file(slot);
        return Ok(dest);
    }
    std::fs::rename(slot, &dest).map_err(|e| YtError::Io(format!("تعذر التسمية النهائية: {e}")))?;
    Ok(dest)
}

fn download_media_inner(
    url: &str,
    out_dir: &Path,
    progress: &dyn Fn(f32) -> bool,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    audio_only: bool,
) -> Result<PathBuf, YtError> {
    use std::sync::atomic::Ordering;
    // و-٨: رفض الرابط قبل أي اتصال، برسالته العربية كما هي (بلا غلاف
    // «فشل التحقق») لأن نصّه يسمّي السبب للمستخدم مباشرة.
    validate_download_url(url).map_err(YtError::Rejected)?;
    let exe = resolve_ytdlp().ok_or(YtError::NotFound)?;
    std::fs::create_dir_all(out_dir).map_err(|e| YtError::Io(e.to_string()))?;

    // P1 autopsy: the program download path had ZERO log lines, so a stall
    // here was indistinguishable from a dead process. This guard logs timed
    // boundaries (start / first progress / last progress / end + line count)
    // on EVERY exit path via Drop — including cancel, stall-kill and errors.
    struct DlSpan {
        t0: std::time::Instant,
        first_progress: Option<std::time::Instant>,
        last_progress: std::time::Instant,
        lines: u64,
        url_host: String,
    }
    impl Drop for DlSpan {
        fn drop(&mut self) {
            let total = self.t0.elapsed().as_secs_f32();
            match self.first_progress {
                Some(f) => tracing::info!(
                    target: "ytdlp",
                    "download span: {} lines, first-progress +{:.1}s, last +{:.1}s, end +{:.1}s ({})",
                    self.lines,
                    f.duration_since(self.t0).as_secs_f32(),
                    self.last_progress.duration_since(self.t0).as_secs_f32(),
                    total,
                    self.url_host,
                ),
                None => tracing::warn!(
                    target: "ytdlp",
                    "download span: NO progress lines in {:.1}s ({})",
                    total, self.url_host,
                ),
            }
        }
    }
    let host = url.split('/').nth(2).unwrap_or("url").to_string();
    let mut span = DlSpan {
        t0: std::time::Instant::now(),
        first_progress: None,
        last_progress: std::time::Instant::now(),
        lines: 0,
        url_host: host,
    };
    tracing::info!(target: "ytdlp", "download start: {}", url);

    // 1) metadata first: no id → no safe slot → fail loudly before downloading.
    let meta = fetch_meta(&exe, url, cancel)?;

    // 2) fast paths with zero network beyond metadata: a usable slot from an
    // earlier run, or a legacy title-named file from the pre-slot era.
    if let Some(slot) = find_slots(out_dir, &meta.id)
        .into_iter()
        .find(|p| slot_usable(p))
    {
        return promote_slot(&slot, out_dir, &meta);
    }
    let legacy = out_dir.join(format!("{}.mp4", sanitize_title(&meta.title, &meta.id)));
    if legacy.is_file() && slot_usable(&legacy) {
        return Ok(legacy);
    }

    // ── **إعادة محاولة واحدة على فشل عابر — مقيسة لا مُفترَضة** ──────────────
    //
    // **القياس الذي برّرها**: نفس أمر التطبيق ونفس الرابط (٣ محاولات في عمليّات
    // مستقلّة على هذه الآلة) ⇒ **١ فشل من ٣** خرج بـ1 بعد بلوغ ١٠٠٪ بسبب
    // `ERROR: unable to download video data: HTTP Error 403: Forbidden` على
    // stderr — وهو فشل **عابر من موقع يوتيوب** لا من عندنا (نفس الأمر نجح في
    // المحاولتين الأخريين، وفي ٨ محاولات أخرى لي: ٨/٨ نجاح). والمحاولة
    // الإضافية الواحدة كانت ستُنجح تلك المحاولة.
    //
    // **وحدودها المعلنة**: محاولة **واحدة** إضافية لا حلقة (`DOWNLOAD_ATTEMPTS`)،
    // ولا إعادة على فشل دائم ([`is_transient_failure`])، والإعادة **تُسجَّل**،
    // والخانة تُكنَس قبلها (‏`clear_slots` في رأس الحلقة)، والإلغاء يبقى نافذاً.
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        // 3) fresh unique slot; stale crash leftovers of ours go first.
        clear_slots(out_dir, &meta.id);
        let stem = slot_stem(&meta.id);
        let tmpl = out_dir.join(format!("{stem}.%(ext)s"));
        let mut cmd = make_cmd(&exe);
        // NOTE: no `--windows-filenames` and no title in `-o` anymore — the slot
        // is id-safe by construction, so yt-dlp's sanitizer has nothing to mangle.
        let args: Vec<String> = vec![
            "--newline".into(),
            // **`--no-quiet` ليس تزييناً — وهو عطل مقيس (م٣/إصلاح٢)**:
            // `--print` في yt-dlp **يعني `--quiet`**، فكان stdout فارغاً تماماً
            // طوال التنزيل. قِيس على هذه الآلة بنفس الأمر ونفس الرابط ونفس المدة
            // (٤٥ ث): **٠ سطراً** بالأمر الإنتاجي مقابل **٢٥٨ سطراً** بـ`--no-quiet`،
            // ومنها ١٩٨ سطر `[download]  x%` في ٤٠ ث. وأثره ثلاثة:
            //   (أ) رسالة الحالة تبقى «📥 جارٍ التنزيل… 0%» **طوال التنزيل** (وهو
            //       بعينه ما رصده المدقّق)، والواجهة لا يصلها `dl-progress`؛
            //   (ب) فرع الإلغاء داخل قراءة التقدّم (`if !progress(p)`) لا يُنفَّذ أبداً؛
            //   (ج) حارس الجمود يقيس «آخر مخرج» ⇒ لا يرى مخرجاً **إطلاقاً** فيقتل
            //       تنزيلاً سليماً بعد `STALL_SECS` (١٥ دقيقة) كجمود كاذب —
            //       وذيل الفشل الذي من أجله أُضيف `--print` يصير فارغاً أيضاً.
            "--no-quiet".into(),
            "--no-playlist".into(),
            "-f".into(),
            format_selector(audio_only).into(),
            "--merge-output-format".into(),
            "mp4".into(),
            "--socket-timeout".into(),
            "20".into(),
            "-o".into(),
            tmpl.to_string_lossy().into_owned(),
            // forensics only: what yt-dlp THINKS it wrote (unsanitized — feeds
            // the failure tail, never trusted for identification).
            "--print".into(),
            "after_move:HARAMLITE_OUT:%(filepath)s".into(),
            url.to_string(),
        ];
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        cmd.args(&arg_refs);
        // Arabic titles: force yt-dlp's stdout to UTF-8 instead of the Windows
        // console codepage (cp1256 on this machine) — keeps logs exact.
        cmd.env("PYTHONIOENCODING", "utf-8");

        let child = cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| YtError::Process(format!("تعذّر تشغيل yt-dlp: {e}")))?;

        // ── **التسجيل + القاتل: عطل م٣/إصلاح٢** ────────────────────────────────
        //
        // كان هنا `spawn()` مباشر **بلا تسجيل**: فالطفل خارج `ctx.children`،
        // فيجد `proc::kill_children` صفراً ويعود `/kill` بـ«قُتلت 0 عملية فرعية
        // حيّة» — والحارس الداخلي وحده يحمل عبء القتل.
        //
        // **والقاتل [`proc::ChildHandle`] يحمل معه مهمّة نواة** تحيط بشجرة yt-dlp،
        // وهذا هو ما يغلق العطل الميداني: `yt-dlp.exe` **عمليّتان** (مُشغّل + عامل،
        // مقيس)، و`taskkill /T /F /PID <المُشغّل>` قد يقتل المُشغّل وحده إن وقع في
        // لحظة إنشاء العامل (قِيس: ١ من ٤ تشغيلات عند ٢٠٠ مللي) — والعامل الناجي
        // يبقي الأنبوب مفتوحاً فتبقى المهمّة معلّقة بلا نهاية. والـJob تقتل **كل
        // أعضاءها** ولو مات المُشغّل.
        let child_pid = child.id();
        let killer = crate::proc::prepare_child(&child);
        let registered = match killer.as_ref() {
            Some(k) => crate::proc::register_child(k),
            None => 0,
        };
        // **متى ينصرف الحارس: عند انتهاء هذه الدالة** — لا عند خروج الطفل المباشر.
        //
        // **ولماذا (م٣/إصلاح٢)**: `yt-dlp.exe` عمليّتان، والمُشغّل يخرج أحياناً قبل
        // عامله (أو يُقتل وحده في نافذة سباق مقيسة) — فانصرافُ الحارس عند موت
        // المُشغّل يترك **عاملاً حيّاً بلا حارس** يمسك الأنبوب، فتبقى المهمّة معلّقة
        // والإلغاء بعدها لا يجده أحد. وهذا هو مسار الواجهة بعينه: `download_media_cmd`
        // ينادي `download_media` على خيط `spawn_blocking` **بلا سياق مهمّة**، فلا
        // يسجّل مقبضاً ولا يجد `cancel_job` ما يقتله — فالحارس وحده هو القاتل هناك.
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _unregister = UnregisterOnDrop(registered, finished.clone());
        // **القاتل الواحد** لكل أبواب هذه الدالة: مهمّة النواة (تقتل الشجرة
        // والأحفاد)، وإلا `taskkill /T /F` — لا نسختان تفترقان.
        let kill_now = || match killer.as_ref() {
            Some(k) => k.kill(),
            None => crate::proc::kill_tree(child_pid),
        };
        let child = Arc::new(Mutex::new(child));
        // Last stdout line instant — the stall watchdog below kills a download
        // that goes silent for STALL_SECS (no output at all, not even slow
        // progress), so one hung subprocess can never wedge the bridge queue.
        let activity = Arc::new(Mutex::new(std::time::Instant::now()));
        let stalled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            // the monitor holds its OWN Arc — the flag stays alive for as long
            // as the watcher runs, whatever the caller does afterwards
            let cancel_flag = cancel.clone();
            let watch_killer = killer.clone();
            let watch_activity = activity.clone();
            let watch_stalled = stalled.clone();
            let watch_finished = finished.clone();
            std::thread::Builder::new()
            .name("ytdlp-cancel-watch".into())
            .spawn(move || {
                // **سبب واحد يُثبَّت مرّة** (وإلا تكرّر السطر كل ٢٠٠ مللي)،
                // **وسطر صريح يقول أيّ الفرعين عمل** — كان فرع الإلغاء بلا سطر
                // أصلاً (ع٣) فلا يُعرف من السجلّ أيّهما فشل.
                let mut reason: Option<&'static str> = None;
                let mut attempts: u32 = 0;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    if watch_finished.load(Ordering::SeqCst) {
                        break;
                    }
                    if reason.is_none() {
                        if cancel_flag.load(Ordering::SeqCst) {
                            reason = Some("إلغاء المستخدم");
                        } else {
                            let idle = watch_activity
                                .lock()
                                .map(|t| t.elapsed().as_secs() >= STALL_SECS)
                                .unwrap_or(false);
                            if idle {
                                watch_stalled.store(true, Ordering::SeqCst);
                                reason = Some("جمود التنزيل (لا مخرجات)");
                            }
                        }
                        if let Some(why) = reason {
                            tracing::warn!(
                                target: "ytdlp",
                                "قتل بسبب «{why}»: شجرة yt-dlp {child_pid} (مهمّة نواة تحيط بها: {})",
                                watch_killer.is_some()
                            );
                        }
                    }
                    if reason.is_some() {
                        // **يُعاد القتل كل دورة حتى تنتهي الدالة** — لا `break`
                        // بعد محاولة واحدة (تلك كانت نافذة الفلتان المقيسة)،
                        // **ويُنادى بعد موت المُشغّل أيضاً**: فقد يحمل الوعاء
                        // عاملاً ناجياً لا يُدرَك بمعرّف أبيه.
                        attempts += 1;
                        match watch_killer.as_ref() {
                            Some(k) => k.kill(),
                            None => crate::proc::kill_tree(child_pid),
                        }
                        if attempts.is_multiple_of(25) {
                            tracing::warn!(
                                target: "ytdlp",
                                "الشجرة (pid={child_pid}) لم تمت بعد {attempts} محاولة قتل — تُعاد المحاولة"
                            );
                        }
                    }
                }
            })
            .ok();
        }

        // Drain stderr on a side thread: an undrained pipe fills (~64KB) and
        // deadlocks the child mid-download.
        //
        // **ولماذا لم يبقَ بالوعةً (عطل ميداني — بلاغ المالك 2026-09-23)**: كان
        // هذا الخيط يقرأ **ليرمي** (`while let Ok(n) = r.read(&mut sink)`)، وذيل
        // الفشل يُبنى من stdout وحده. وyt-dlp يكتب `[download]` على stdout ويكتب
        // `ERROR: …` على stderr ⇒ فشلٌ يبلغ فيه التنزيل ١٠٠٪ ثم `exit code: 1`
        // **بلا سطر خطأ واحد** في السجلّ ولا في واجهة المستخدم. والمقيس على هذه
        // الآلة (نفس الأمر ونفس الرابط): المحاولة الفاشلة كتبت على stderr
        // `ERROR: unable to download video data: HTTP Error 403: Forbidden` —
        // فصار **التصريف والحفظ في الخيط نفسه** ([`drain_stderr`]).
        let stderr_lines: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        let (stderr_done_tx, stderr_done_rx) = std::sync::mpsc::channel::<()>();
        let mut stderr_tail = StderrTail {
            lines: stderr_lines.clone(),
            done: Some(stderr_done_rx),
        };
        match child.lock().ok().and_then(|mut c| c.stderr.take()) {
            Some(stderr) => {
                let lines = stderr_lines.clone();
                std::thread::spawn(move || drain_stderr(stderr, lines, stderr_done_tx));
            }
            // لا أنبوب ⇒ لا انتظار: إسقاط الطرف يُرجع `recv_timeout` فوراً.
            None => drop(stderr_done_tx),
        }

        use std::io::BufRead;
        // Audit 2026-09-15 (٢.أ): كان `.expect("stdout piped")` في مسار الإنتاج —
        // أي تغيير لاحق في `spawn` (إسقاط `.stdout(Stdio::piped())` مثلاً) يحوّل
        // خطأً معالَجاً إلى panic في واجهة المستخدم. صار خطأً نظيفاً، ومع قتل
        // الشجرة أولاً بنفس قاعدة مسار خطأ القراءة أدناه: لا نُيتّم yt-dlp أبداً.
        let stdout = match child.lock().ok().and_then(|mut c| c.stdout.take()) {
            Some(s) => s,
            None => {
                if let Ok(mut c) = child.lock() {
                    kill_now();
                    let _ = c.wait();
                }
                return Err(YtError::Process(
                    "stdout غير موصول — راجع stdio في spawn".into(),
                ));
            }
        };
        let mut reader = std::io::BufReader::new(stdout);

        // Raw byte lines + lossy decode: YouTube titles / console codepages break
        // strict UTF-8 readers.
        let mut raw: Vec<u8> = Vec::with_capacity(256);
        // Retain a tail of stdout so failures carry evidence.
        let mut tail: VecDeque<String> = VecDeque::with_capacity(41);
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) => {
                    // Never orphan the child (yt-dlp + its ffmpeg merger) —
                    // the old code returned here and leaked both burning CPU.
                    if let Ok(mut c) = child.lock() {
                        kill_now();
                        let _ = c.wait();
                    }
                    // القناة الثانية تُرفَق هنا أيضاً: انكسار أنبوب stdout ليس سبباً
                    // في ذاته، وسببُ yt-dlp يكون مكتوباً على stderr.
                    return Err(YtError::Process(format!(
                        "انقطع أنبوب مخرجات yt-dlp: {e}\n{}",
                        failure_tail(&tail, &mut stderr_tail, 12)
                    )));
                }
            }
            let line = String::from_utf8_lossy(&raw);
            let trimmed = line.trim();
            tail.push_back(trimmed.to_string());
            while tail.len() > 40 {
                tail.pop_front();
            }
            // P1: feed the span guard (line count + first/last progress instants).
            span.lines += 1;
            let now_line = std::time::Instant::now();
            if span.first_progress.is_none() {
                span.first_progress = Some(now_line);
            }
            span.last_progress = now_line;
            // Any output at all resets the stall watchdog.
            if let Ok(mut t) = activity.lock() {
                *t = std::time::Instant::now();
            }
            // Identification no longer reads filenames from stdout AT ALL (the
            // sanitization drift made every printed name untrustworthy) — only
            // percentage progress is parsed here; the slot file below is proof.
            if let Some(rest) = line.strip_prefix("[download]") {
                let pct_txt = rest
                    .split_whitespace()
                    .find(|t| t.ends_with('%'))
                    .unwrap_or("");
                if let Ok(p) = pct_txt.trim_end_matches('%').parse::<f32>() {
                    let p = (p / 100.0).clamp(0.0, 1.0);
                    if !progress(p) {
                        if let Ok(mut c) = child.lock() {
                            kill_now();
                            let _ = c.wait();
                        }
                        return Err(YtError::Process("أُلغي التنزيل من قبل المستخدم".into()));
                    }
                }
            }
        }

        let status = child
            .lock()
            .map_err(|e| YtError::Process(format!("فشل انتظار yt-dlp: {e}")))?
            .wait()
            .map_err(|e| YtError::Process(format!("فشل انتظار yt-dlp: {e}")))?;
        if stalled.load(Ordering::SeqCst) {
            let tail_txt = failure_tail(&tail, &mut stderr_tail, 30);
            tracing::warn!(target: "ytdlp", "توقف التنزيل لانقطاع التقدم ({url}) — ذيل المخرجات:\n{tail_txt}");
            return Err(YtError::Process(format!(
                "توقف التنزيل: لا تقدم منذ {} دقيقة — قد يكون الاتصال متجمداً\n{}",
                STALL_SECS / 60,
                failure_tail(&tail, &mut stderr_tail, 12)
            )));
        }
        if !status.success() {
            // نصّ stderr **بلا وسم** للتصنيف (فالتصنيف يبحث عن نصوص yt-dlp
            // الحرفية)، والوسم للعرض على المستخدم وفي السجلّ.
            let reason = stderr_tail.text(30);
            let cancelled = cancel.load(Ordering::SeqCst);
            if attempt < DOWNLOAD_ATTEMPTS && !cancelled && is_transient_failure(&reason) {
                tracing::warn!(
                    target: "ytdlp",
                    "المحاولة {attempt} فشلت بخطأ **عابر** ({url}) — أُعيدت مرّة واحدة بعد تنظيف الخانة. نصّ stderr:\n{}",
                    stderr_tail.text(3)
                );
                continue;
            }
            let tail_txt = failure_tail(&tail, &mut stderr_tail, 30);
            tracing::warn!(target: "ytdlp", "yt-dlp خرج بـ{status} لـ {url} — ذيل المخرجات:\n{tail_txt}");
            return Err(YtError::Process(format!(
                "yt-dlp خرج بـ{status}\n{}",
                failure_tail(&tail, &mut stderr_tail, 12)
            )));
        }

        // The slot file is the ONLY proof of success — no printed name, no
        // merger line, no folder guessing. It must exist and be a real media
        // file; anything else is a genuine failure with the tail attached.
        //
        // **ولا يُقبَل ملفٌ في الخانة حين يخرج yt-dlp بخطأ**: السياسة («الخانة هي
        // الدليل الوحيد») تُطبَّق على **الخروج الناجح** وحده — وهو ما يجعل الملف
        // الناقص من 403 لا يُسلَّم للمستخدم (وهو الصواب)، وثمنه أن ملفاً كاملاً
        // لو تركه فشلٌ بعد اكتماله لا يُقبَل في تلك المحاولة (انظر التقرير).
        if let Some(slot) = find_slots(out_dir, &meta.id)
            .into_iter()
            .find(|p| slot_usable(p))
        {
            return promote_slot(&slot, out_dir, &meta);
        }
        let tail_txt = failure_tail(&tail, &mut stderr_tail, 30);
        tracing::warn!(target: "ytdlp", "نجح yt-dlp دون ملف صالح في الخانة ({url}) — ذيل المخرجات:\n{tail_txt}");
        return Err(YtError::Process(format!(
            "yt-dlp نجح دون ملف ناتج صالح — أعد المحاولة\n{}",
            failure_tail(&tail, &mut stderr_tail, 12)
        )));
    }
}

/// **حارس نهاية التنزيل**: يُخرج مقبض التنزيل من سِجلّ المهمّة ويُعلن انتهاء
/// الدالة على **كل باب خروج** (نجاح · خطأ · ذعر) — فلا يقتل إلغاءٌ لاحق مقبضاً
/// ميتاً، ولا يبقى حارس يستطلع بعد انتهاء التنزيل. وهو أيضاً ما يُغلق **مهمّة
/// النواة** (وعندها يُقتل كل من بقي فيها بـ`KILL_ON_JOB_CLOSE`).
struct UnregisterOnDrop(u32, std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for UnregisterOnDrop {
    fn drop(&mut self) {
        crate::proc::unregister_phase(self.0);
        self.1.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

// ─────────────────────────────────────────────────────────────────────
// now_secs + tests
// ─────────────────────────────────────────────────────────────────────

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn sums_parser_extracts_official_digest() {
        let fixture = "aaaabbbbccccdddd0000111122223333aaaabbbbccccdddd000011112222333  yt-dlp_arm64.exe\n\
                       66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a  yt-dlp.exe\n";
        let got = parse_sums_for(fixture, "yt-dlp.exe").expect("digest");
        assert_eq!(
            got,
            "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a"
        );
        assert!(parse_sums_for("short  yt-dlp.exe", "yt-dlp.exe").is_none());
    }

    #[test]
    fn sanitize_title_kills_forbidden_chars() {
        // The reported killer: ASCII quotes must not survive (yt-dlp would
        // save them as U+FF02 on disk while printing them raw).
        assert_eq!(
            sanitize_title("Just \"A\" Dream", "abc123"),
            "Just _A_ Dream"
        );
        assert_eq!(
            sanitize_title("a<b>c:d/e\\f|g?h*i", "x"),
            "a_b_c_d_e_f_g_h_i"
        );
        // Windows trailing dots/spaces
        assert_eq!(sanitize_title("song...   ", "x"), "song");
        // empty/blank → deterministic fallback
        assert_eq!(sanitize_title("   ", "abc123"), "video_abc123");
        assert_eq!(sanitize_title("", "abc123"), "video_abc123");
        // length cap leaves room for suffix + extension
        let long = "a".repeat(500);
        assert!(sanitize_title(&long, "x").chars().count() <= 180);
    }

    /// Field #3: temp watch-listens must never fetch a video stream.
    #[test]
    fn watch_format_is_audio_only() {
        assert_eq!(format_selector(true), "ba/b");
        assert_eq!(format_selector(false), "bv*+ba/b");
    }

    #[test]
    fn slot_stem_is_unique_and_prefixed() {
        let a = slot_stem("dQw4w9WgXcQ");
        let b = slot_stem("dQw4w9WgXcQ");
        assert_ne!(a, b);
        assert!(a.starts_with("hl_dQw4w9WgXcQ_"));
    }

    #[test]
    fn slots_find_newest_and_skip_partials() {
        let dir = std::env::temp_dir().join(format!("hl_ytdlp_slots_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("other.mp4"), b"x").unwrap();
        std::fs::write(dir.join("hl_abc_1_0.mp4.part"), b"partial").unwrap();
        std::fs::write(dir.join("hl_abc_1_0.mp4"), b"old").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("hl_abc_2_1.mp4"), b"new").unwrap();

        let found = find_slots(&dir, "abc");
        assert_eq!(
            found.len(),
            2,
            "partials and foreign files must be excluded"
        );
        assert!(found[0].ends_with("hl_abc_2_1.mp4"), "newest first");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_cadence_respects_state() {
        // Audit 2026-09-03: isolate from the user's REAL update state.
        // The variable is process-wide while the harness runs tests on parallel
        // threads, so the crate-wide env lock is taken first and the previous
        // value restored on the way out — including if this test panics.
        let _serial = crate::paths::serial_guard();
        let _env = crate::paths::env_restore("HARAMLITE_YTDLP_STATE_DIR");
        let dir = std::env::temp_dir().join(format!("hl_ytdlp_state_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HARAMLITE_YTDLP_STATE_DIR", &dir);

        // fresh state in the future → not due (force=false)
        write_state(&UpdateState {
            checked_at: now_secs(),
            version: "x".into(),
        })
        .ok();
        assert!(!is_check_due(false));
        assert!(is_check_due(true));
        // stale state → due
        write_state(&UpdateState {
            checked_at: now_secs().saturating_sub(CHECK_INTERVAL_SECS + 1),
            version: String::new(),
        })
        .ok();
        assert!(is_check_due(false));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_text_keeps_last_n_lines() {
        let mut tail: VecDeque<String> = VecDeque::new();
        for i in 0..5 {
            tail.push_back(format!("line{i}"));
        }
        assert_eq!(tail_text(&tail, 2), "line3\nline4");
        assert_eq!(tail_text(&tail, 99).lines().count(), 5);
        assert_eq!(tail_text(&VecDeque::new(), 12), "");
    }

    /// **ذيل stderr محدود بحدّيه المعلنين**، ويحفظ سطراً أخيراً بلا `\n`،
    /// ويوسم السطر المقصوص — فحفظٌ بلا حدّ عطلٌ آخر لا إصلاح.
    #[test]
    fn stderr_tail_is_bounded_and_keeps_a_last_line_without_newline() {
        // ① التصريف: سطر أخير بلا `\n` يُحفظ، والإشارة تُرسَل عند الانتهاء.
        let lines = Arc::new(Mutex::new(VecDeque::new()));
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        drain_stderr(
            std::io::Cursor::new(b"WARNING: no JS runtime\nERROR: boom".to_vec()),
            lines.clone(),
            tx,
        );
        assert!(rx.try_recv().is_ok(), "خيط التصريف لم يُشِر بالانتهاء");
        {
            let g = lines.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(g.len(), 2);
            assert_eq!(g[1], "ERROR: boom");
        }

        // ② عدد السطور: لا يُحفظ إلا آخر `STDERR_TAIL_LINES` سطراً.
        let lines = Arc::new(Mutex::new(VecDeque::new()));
        for i in 0..(STDERR_TAIL_LINES + 5) {
            push_stderr_line(&lines, format!("ERROR: سطر {i}").as_bytes(), false);
        }
        {
            let g = lines.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(g.len(), STDERR_TAIL_LINES);
            let first = "ERROR: سطر 5";
            let last = format!("ERROR: سطر {}", STDERR_TAIL_LINES + 4);
            assert_eq!(g.front().map(String::as_str), Some(first));
            assert_eq!(g.back().map(String::as_str), Some(last.as_str()));
        }

        // ③ سطر أطول من السقف يُقصّ ويُوسَم، والسطر الفارغ لا يأخذ خانة.
        let lines = Arc::new(Mutex::new(VecDeque::new()));
        let long = vec![b'x'; STDERR_LINE_CAP * 3];
        push_stderr_line(&lines, &long, true);
        push_stderr_line(&lines, b"   ", false);
        let g = lines.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(g.len(), 1, "سطر فارغ أخذ خانة في الذيل");
        let only = g.front().cloned().unwrap_or_default();
        assert!(only.contains("قُصَّ"), "القصّ غير موسوم: {only}");
        assert!(
            only.len() < STDERR_LINE_CAP + 80,
            "السطر المحفوظ تجاوز السقف المعلن: {} بايت",
            only.len()
        );
    }

    /// **وسم القناتين**: نصّ الفشل يفصل stdout عن stderr، ويسمّي الفارغ فارغاً —
    /// فلا يُقرأ غياب السبب كأنه سبب.
    #[test]
    fn failure_tail_labels_both_channels() {
        let mut stdout_tail: VecDeque<String> = VecDeque::new();
        stdout_tail.push_back("[download] 100% of 129.03MiB".into());
        let lines = Arc::new(Mutex::new(VecDeque::new()));
        push_stderr_line(
            &lines,
            b"ERROR: unable to download video data: HTTP Error 403: Forbidden",
            false,
        );
        let mut stderr_tail = StderrTail {
            lines: lines.clone(),
            done: None,
        };
        let text = failure_tail(&stdout_tail, &mut stderr_tail, 12);
        assert!(text.contains("stdout"), "لا وسم stdout: {text}");
        assert!(text.contains("stderr"), "لا وسم stderr: {text}");
        assert!(text.contains("[download] 100%"), "ذيل stdout ضاع: {text}");
        assert!(
            text.contains("HTTP Error 403: Forbidden"),
            "ذيل stderr ضاع: {text}"
        );

        // الذيل الفارغ يُسمّى «(فارغ)» بدل خانة بيضاء.
        let mut empty = StderrTail {
            lines: Arc::new(Mutex::new(VecDeque::new())),
            done: None,
        };
        let text = failure_tail(&VecDeque::new(), &mut empty, 12);
        assert_eq!(
            text.matches("(فارغ)").count(),
            2,
            "الفارغ لم يُسمَّ في القناتين: {text}"
        );
    }

    /// و-٨ سلبي (الجدول المطلوب حرفياً): **كل** مضيف محلي/خاص يُرفض.
    /// الاختبار يفشل بمجرد أن يمرّ صفّ واحد — أي إضعاف للفحص يظهر هنا.
    #[test]
    fn local_and_private_targets_are_rejected() {
        for url in [
            "http://localhost/x",
            "http://LocalHost:8080/x",
            "http://127.0.0.1/x",
            "http://127.0.0.1:48765/",
            "http://10.0.0.5/x",
            "http://192.168.1.1:8081/x",
            "http://172.16.0.1/x",
            "http://172.31.255.254/x",
            "http://[::1]/x",
            "http://[::1]:8081/x",
            "http://169.254.169.254/latest/meta-data/",
            "http://0.0.0.0:1420/",
            "file:///etc/passwd",
            "file://C:/Windows/win.ini",
            "ftp://example.com/x",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(1)",
            "http://nas/",
            "http://printer.local/x",
            "http://router.internal/x",
            "http://[fd00::1]/x",
            "http://[fe80::1]/x",
            // تهريب عبر مرادفات: IPv4 مُضمَّن في IPv6، وأصفار بادئة، ونطاقات
            // محلية، ومضيف تالف لا يجوز أن يُمرَّر إلى yt-dlp.
            "http://[::ffff:127.0.0.1]/x",
            "http://[::ffff:192.168.1.5]/x",
            "http://0x7f.0.0.1/x",
            "http://127.1/x",
            "https://www.youtube.com.evil.local/x",
            "http://evil_host/x",
            "https://[fe80::1%25eth0]/x",
            // صور IPv6 **متكافئة** كشفها هجوم المشرف بعد الدمج: كان الفحص يقارن
            // بادئة النصّ فمرّت هذه الثلاث — الصيغة الكاملة للحلقة، و`::` غير
            // المحدَّد، وIPv4 المُضمَّن بالست عشرية بلا نقاط.
            "http://[0:0:0:0:0:0:0:1]/x",
            "http://[::]/x",
            "http://[::ffff:7f00:1]/x",
            "http://[::ffff:c0a8:105]/x",
            "http://[0:0:0:0:0:0:0:0]/x",
            // 6to4 و NAT64 يحملان IPv4 داخلهما، و multicast ليس عنواناً عاماً.
            "http://[2002:7f00:1::]/x",
            "http://[64:ff9b::127.0.0.1]/x",
            "http://[ff02::1]/x",
            // عدد عشري صرف: `2130706433` = 127.0.0.1 و`2852039166` = 169.254.169.254
            // عند `inet_addr`.
            "http://2130706433/x",
            "http://2852039166/x",
        ] {
            let got = validate_download_url(url);
            assert!(got.is_err(), "الرابط يجب أن يُرفض ولم يُرفض: {url} ⇒ {got:?}");
            // الرسالة تسمّي السبب — لا رفض صامت.
            let msg = got.unwrap_err();
            assert!(!msg.is_empty(), "رسالة الرفض فارغة لـ{url}");
        }

        // سبب الرفض صريح في كل عائلة من العائلات الثلاث.
        assert!(validate_download_url("http://127.0.0.1/a")
            .unwrap_err()
            .contains("حلقة محلية"));
        assert!(validate_download_url("http://10.1.2.3/a")
            .unwrap_err()
            .contains("شبكة خاصة"));
        assert!(validate_download_url("http://169.254.169.254/a")
            .unwrap_err()
            .contains("link-local"));
        assert!(validate_download_url("file:///etc/passwd")
            .unwrap_err()
            .contains("http"));
        assert!(validate_download_url("http://localhost/a")
            .unwrap_err()
            .contains("localhost"));
        // IPv4 مُضمَّن في IPv6 يُصنَّف بحلقة محلية لا بخطأ عام.
        assert!(validate_download_url("http://[::ffff:127.0.0.1]/a")
            .unwrap_err()
            .contains("حلقة محلية"));
    }

    /// و-٨ سلبي (الجدول المطلوب حرفياً): المواقع العامة تُقبل — الوعد المعلن
    /// «يوتيوب أو أي موقع آخر» يبقى قائماً (لا قائمة بيضاء).
    #[test]
    fn public_targets_are_accepted() {
        for url in [
            "https://www.youtube.com/watch?v=x",
            "https://vimeo.com/1",
            "https://youtu.be/dQw4w9WgXcQ",
            "http://soundcloud.com/a/b",
            "https://example.com/path?q=1#frag",
            "HTTPS://WWW.YouTube.COM/watch?v=x",
            "https://user:pw@www.youtube.com/watch?v=x",
            "https://www.youtube.com:443/watch?v=x",
            " https://www.youtube.com/watch?v=x ",
            "https://[2606:4700::1111]/x",
        ] {
            let got = validate_download_url(url);
            assert!(got.is_ok(), "الرابط العام يجب أن يُقبل: {url} ⇒ {got:?}");
        }
    }

    /// و-٨ سلبي: المداخل الفارغة/التالفة تُرفض ولا تصل إلى yt-dlp.
    #[test]
    fn malformed_urls_are_rejected_before_any_process_runs() {
        for url in [
            "",
            "   ",
            "youtube.com/watch?v=x",
            "https://",
            "///x",
            "http://",
        ] {
            assert!(
                validate_download_url(url).is_err(),
                "رابط تالف يجب أن يُرفض: {url:?}"
            );
        }
    }

    /// الفحص يقع في نقطة العبور الوحيدة: لا `fetch_meta` ولا تشغيل لـyt-dlp
    /// قبل التحقق (الرابط المرفوض يُعاد قبل `resolve_ytdlp`).
    #[test]
    fn the_guard_sits_before_the_process_is_resolved() {
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let err = download_media(
            "http://169.254.169.254/x",
            Path::new("."),
            &|_| true,
            &cancel,
        )
        .expect_err("must be rejected");
        assert!(
            matches!(err, YtError::Rejected(_)),
            "الرفض يجب أن يسبق أي عمل شبكي: {err:?}"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // مسار التنزيل: الإلغاء يقتل yt-dlp **فعلاً** (م٣/إصلاح٢)
    // ─────────────────────────────────────────────────────────────────────

    /// مصدر الثنائي المزيّف الذي يقوم بدور yt-dlp:
    /// * دور البيانات الوصفية (`--dump-single-json`) ⇒ JSON صالح على stdout،
    /// * دور التنزيل ⇒ يسجّل معرّفه ثم **ينام ٦٠٠ ث** — فالمهمّة جارية في
    ///   التنزيل، وهي الحالة التي يقع فيها الإلغاء المقيس.
    ///
    /// **وصورتان لمسار التنزيل** — تختارهما **أسماء المجلدات** لا وسيط في
    /// المنتج (فلا يُغيَّر شيء في المنتج لأجل الاختبار):
    /// * مجلد عادي ⇒ **عملية واحدة** (نموذج مبسّط)،
    /// * مجلد اسمه يحوي `twoproc` ⇒ **عمليّتان كما في yt-dlp الحقيقي** (مقيس
    ///   بـ`Win32_Process`: مُشغّل ← عامل): المُشغّل يُنشئ عاملاً يرث الأنبوب
    ///   **ثم يخرج فوراً** — وهي بعينها الصورة التي نجا فيها العامل بعد
    ///   `taskkill /T /F` (١ من ٤ تشغيلات، مقيسة على yt-dlp الحقيقي).
    ///
    /// بلا اعتماديات (يُبنى بـ`rustc` مباشرةً) وبلا شبكة: الحارس محكم على أي جهاز.
    #[cfg(windows)]
    const FAKE_YTDLP_SRC: &str = r#"
use std::io::Write;

/// عدّاد النداءات في مجلد الخرج: يميّز المحاولة الأولى من التي بعدها (فيقيس
/// الحارس «محاولةً إضافية واحدة» لا حلقة إعادة).
fn bump_calls(dir: Option<&std::path::Path>) -> u32 {
    let Some(d) = dir else { return 1 };
    let p = d.join("calls.txt");
    let n = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0)
        + 1;
    let _ = std::fs::write(&p, n.to_string());
    n
}

/// ملف وسائط **حقيقي** (‏WAV PCM بسيط): الخانة لا تُقبل إلا بوسائط يقرؤها
/// ffprobe (صوت + مدة موجبة)، فنجاحٌ مزعوم بملف فارغ لا يمرّ من `slot_usable`.
fn write_wav(path: &std::path::Path) {
    let rate: u32 = 8000;
    let data_len: u32 = (rate / 5) * 2; // ٠.٢ ثانية · أحادي · ١٦ بت
    let mut v: Vec<u8> = Vec::new();
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_len).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&rate.to_le_bytes());
    v.extend_from_slice(&(rate * 2).to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_len.to_le_bytes());
    v.resize(v.len() + data_len as usize, 0);
    let _ = std::fs::write(path, v);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let has = |needle: &str| args.iter().any(|a| a == needle);

    // ① البيانات الوصفية: ما يقرؤه fetch_meta.
    if has("--dump-single-json") {
        print!("{{\"id\":\"faketest1\",\"title\":\"Fake\"}}");
        let _ = std::io::stdout().flush();
        return;
    }

    // مجلد الخرج من قالب `-o` (وسيط إنتاجي، لا وسيط اختبار).
    let mut tmpl: Option<String> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "-o" {
            tmpl = it.next().cloned();
        }
    }
    let dir = tmpl
        .as_deref()
        .and_then(|t| std::path::Path::new(t).parent().map(|p| p.to_path_buf()));

    // **محاكاة `--quiet` المقيسة في yt-dlp**: `--print` يعني `--quiet`، فلا
    // أسطر تقدّم أصلاً. فالمزيّف يحاكيها: لا يُخرج `[download]` إلا مع
    // `--no-quiet` — فيصير غياب العلم عطلاً يراه الحارس لا نصّاً يُقرأ.
    let quiet = !has("--no-quiet");
    let progress = |label: &str| {
        if !quiet {
            println!("[download]  {:>5.1}% of ~1.00MiB {label}", 5.0);
            let _ = std::io::stdout().flush();
        }
    };

    // اسم مجلد الثنائي يقرّر الصورة: عملية واحدة · مُشغّل+عامل · فشلٌ يحمل سببه.
    let dir_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .and_then(|d| d.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let two_proc = dir_name.contains("twoproc");
    let stderr_fail = dir_name.contains("stderr_fail");
    let retry_always = dir_name.contains("retry_always");
    let retry_mode = retry_always || dir_name.contains("retry_once");
    let permanent_fail = dir_name.contains("permanent_fail");
    let valid_leftover = dir_name.contains("valid_leftover");
    let transient_after_valid = dir_name.contains("transient_after_valid");

    // ② **العامل** في الصورة ذات العمليتين: يسجّل معرّفه وينام (يمسك الأنبوب
    //    الموروث من مُشغّله — ولهذا تبقى المهمّة معلّقة إن نجا).
    if has("--hl-worker") {
        if let Some(d) = dir.as_ref() {
            let _ = std::fs::write(d.join("worker.pid"), std::process::id().to_string());
        }
        for i in 1..=3 {
            progress(&format!("step {i}"));
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        std::thread::sleep(std::time::Duration::from_secs(600));
        return;
    }

    // ③ **المُشغّل** في الصورة ذات العمليتين: يُنشئ العامل ثم **يخرج فوراً**
    //    (لا ينتظره) — فيبقى العامل حيّاً بعد موت مُشغّله، وهو العطل المقيس.
    if two_proc {
        if let Some(d) = dir.as_ref() {
            let _ = std::fs::write(d.join("launcher.pid"), std::process::id().to_string());
        }
        // مهلة قصيرة **تحاكي زمن بثّ yt-dlp نفسه** (مقيس ≥٢٠٠ مللي)، وفيها
        // يُسند المنفذ الطفل إلى مهمّة النواة قبل أن يُنشئ عامله.
        std::thread::sleep(std::time::Duration::from_millis(150));
        if let Ok(exe) = std::env::current_exe() {
            let mut c = std::process::Command::new(exe);
            c.args(std::env::args().skip(1)).arg("--hl-worker");
            c.stdin(std::process::Stdio::null());
            let _ = c.spawn();
        }
        return;
    }

    // ③.ب **صورة «الفشل الذي يحمل سببه»** — العطل الميداني المقيس (بلاغ المالك
    //    2026-09-23): التقدّم كله على stdout، و`ERROR:` وحده على stderr. والمزيّف
    //    يكتب النصّ الحرفي المقيس على هذه الآلة، ولا يكتب السبب على stdout أبداً
    //    — فظهوره في رسالة الفشل دليلٌ على أن stderr قُرئ لا على أنه طُبع.
    if stderr_fail {
        for i in 1..=3 {
            progress(&format!("step {i}"));
        }
        eprintln!("WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled by default");
        eprintln!("ERROR: unable to download video data: HTTP Error 403: Forbidden");
        let _ = std::io::stderr().flush();
        let _ = std::io::stdout().flush();
        std::process::exit(1);
    }

    // ③.ج **إعادة المحاولة**: المحاولة الأولى تفشل بـ403 (فشل **عابر** مقيس)،
    //    والثانية تنجح وتكتب خانةً صالحة (‏WAV حقيقي يقرؤه ffprobe) — أو تفشل
    //    دائماً في صورة `retry_always` (لقياس «محاولة واحدة لا حلقة»).
    if retry_mode {
        let n = bump_calls(dir.as_deref());
        if n == 1 {
            // نصفُ ملفٍ في الخانة، كما يترك 403 الحقيقي (`…​.f616.mp4`): يقيس
            // الحارس أن الإعادة **تكنس الخانة** قبل المحاولة الثانية.
            if let Some(t) = tmpl.as_deref() {
                let _ = std::fs::write(t.replace("%(ext)s", "f616.mp4"), b"partial-fragment");
            }
            for i in 1..=2 {
                progress(&format!("step {i}"));
            }
            eprintln!("ERROR: unable to download video data: HTTP Error 403: Forbidden");
            let _ = std::io::stderr().flush();
            let _ = std::io::stdout().flush();
            std::process::exit(1);
        }
        if retry_always {
            eprintln!("ERROR: unable to download video data: HTTP Error 403: Forbidden");
            let _ = std::io::stderr().flush();
            let _ = std::io::stdout().flush();
            std::process::exit(1);
        }
        for i in 1..=3 {
            progress(&format!("step {i}"));
        }
        if let Some(t) = tmpl.as_deref() {
            let out = t.replace("%(ext)s", "wav");
            write_wav(std::path::Path::new(&out));
            println!("HARAMLITE_OUT:{out}");
        }
        let _ = std::io::stdout().flush();
        return;
    }

    // ③.د **فشل دائم بنصّه**: لا إعادة عليه إطلاقاً.
    if permanent_fail {
        let _ = bump_calls(dir.as_deref());
        for i in 1..=2 {
            progress(&format!("step {i}"));
        }
        eprintln!("ERROR: [youtube] AJOOve4s0_8: Video unavailable");
        let _ = std::io::stderr().flush();
        let _ = std::io::stdout().flush();
        std::process::exit(1);
    }

    // ③.هـ **ملفٌ صالح في الخانة ثم خروجٌ بخطأ دائم**: لقياس السياسة — هل
    //    يُسلَّم ما تركه فشلٌ في الخانة؟ والنداء الثاني يخرج بـ0 **بلا كتابة
    //    شيء**، فيميّز عدّادُ النداءات المسارَ السريع (بلا تشغيل) من تنزيل جديد.
    if valid_leftover {
        let n = bump_calls(dir.as_deref());
        if n == 1 {
            if let Some(t) = tmpl.as_deref() {
                write_wav(std::path::Path::new(&t.replace("%(ext)s", "wav")));
            }
            eprintln!("ERROR: [youtube] AJOOve4s0_8: Video unavailable");
            let _ = std::io::stderr().flush();
            let _ = std::io::stdout().flush();
            std::process::exit(1);
        }
        let _ = std::io::stdout().flush();
        return;
    }

    // ③.و **خانةٌ صالحة ثم فشلٌ عابر**: يقيس **ثمن** تنظيف الخانة قبل الإعادة —
    //    ملفٌّ كامل تركه الفشل الأول يُكنَس، والثانية تخرج بـ0 بلا كتابة ⇒
    //    لا خانة ⇒ فشلٌ بنصّ «نجح دون ملف ناتج صالح». (قياسٌ لا حكم.)
    if transient_after_valid {
        let n = bump_calls(dir.as_deref());
        if n == 1 {
            if let Some(t) = tmpl.as_deref() {
                write_wav(std::path::Path::new(&t.replace("%(ext)s", "wav")));
            }
            eprintln!("ERROR: unable to download video data: HTTP Error 403: Forbidden");
            let _ = std::io::stderr().flush();
            let _ = std::io::stdout().flush();
            std::process::exit(1);
        }
        let _ = std::io::stdout().flush();
        return;
    }

    // ④ الصورة المبسّطة: العملية نفسها هي التي تنزّل.
    if let Some(d) = dir.as_ref() {
        let _ = std::fs::write(d.join("fake.pid"), std::process::id().to_string());
    }
    for i in 1..=3 {
        progress(&format!("step {i}"));
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    std::thread::sleep(std::time::Duration::from_secs(600));
}
"#;

    /// هل العملية بهذا المعرّف حيّة الآن؟ بنفس البدائية التي يستعملها
    /// [`crate::proc::ChildHandle`] (`WaitForSingleObject` على مقبض مفتوح) —
    /// فالحكم على العملية نفسها لا على اسم ولا على ملف.
    #[cfg(windows)]
    fn pid_is_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
        const SYNCHRONIZE: u32 = 0x0010_0000;
        unsafe {
            let h: HANDLE = OpenProcess(SYNCHRONIZE, 0, pid);
            if h.is_null() {
                return false; // لا مقبض ⇒ لا عملية (أو انتهت)
            }
            let alive = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
            CloseHandle(h);
            alive
        }
    }

    /// مسار `rustc` — يُبنى به الثنائي المزيّف. `None` ⇒ الحارس **يفشل بصوت
    /// عالٍ** ولا يتخطّى صامتاً (حارس يتخطّى نفسه ليس حارساً).
    #[cfg(windows)]
    fn find_rustc() -> Option<PathBuf> {
        let mut cands: Vec<PathBuf> = Vec::new();
        if let Ok(cargo) = std::env::var("CARGO") {
            if let Some(dir) = Path::new(&cargo).parent() {
                cands.push(dir.join("rustc.exe"));
            }
        }
        if let Ok(ch) = std::env::var("CARGO_HOME") {
            cands.push(Path::new(&ch).join("bin").join("rustc.exe"));
        }
        for key in ["USERPROFILE", "HOME"] {
            if let Ok(h) = std::env::var(key) {
                cands.push(Path::new(&h).join(".cargo").join("bin").join("rustc.exe"));
            }
        }
        if let Some(found) = cands.into_iter().find(|c| c.is_file()) {
            return Some(found);
        }
        // آخر ما يُجرَّب: `PATH` نفسه.
        let ok = Command::new("rustc")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        ok.then(|| PathBuf::from("rustc"))
    }

    /// **يقتل العملية عند سقوط الاختبار** — فلا يتسرّب عامل نائم ٦٠٠ ث إذا
    /// سقط الحارس (والسقوط هو الحالة التي نريد قياسها، فلا نُلوّث الجهاز بها).
    #[cfg(windows)]
    struct KillOnDrop(u32);

    #[cfg(windows)]
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            if self.0 != 0 {
                crate::proc::kill_tree(self.0);
            }
        }
    }

    /// قياس واحد لدورة إلغاء في **مسار التنزيل الإنتاجي**.
    #[cfg(windows)]
    struct CancelProbe {
        /// العملية التي نراقب موتها (العاملة في صورة العمليتين).
        watched: u32,
        /// كم مقبضاً حيّاً وجده القتل المباشر (`proc::DIRECT_KILLS`).
        direct: usize,
        /// زمن انتهاء المهمّة من لحظة طلب الإلغاء.
        ended: std::time::Duration,
        /// هل عادت `download_media` بخطأ (لا نجاح كاذب)؟
        failed: bool,
        /// كم مرّة نودي نداء التقدّم (`progress`) — يقيس أن yt-dlp **يتكلّم**:
        /// بصدفه الفارغة (‏`--print` يعني `--quiet`) يبقى صفراً، فتبقى رسالة
        /// الحالة عند 0% ويفقد حارس الجمود إشارته.
        progress_calls: usize,
    }

    /// **دورة إلغاء كاملة على مسار المنتج**: ثنائي مزيّف ⇒ `download_media`
    /// ⇒ إلغاء (من السِجلّ كما يفعل تلغرام/`/kill`، أو بالعلم وحده كما تفعل
    /// الواجهة) ⇒ قياس.
    ///
    /// `with_ctx=false` يحاكي **مسار الواجهة**: `lib.rs::download_media_cmd`
    /// ينادي `download_media` على خيط `spawn_blocking` **بلا `register_early`**
    /// (لا سياق مهمّة ⇒ لا تسجيل)، وإلغاؤه ضبطُ علم الإلغاء وحده.
    #[cfg(windows)]
    fn cancel_probe(fake: &Path, tag: &str, with_ctx: bool) -> CancelProbe {
        use std::sync::atomic::Ordering;
        use std::time::{Duration, Instant};

        let tmp = std::env::temp_dir().join(format!("hl_ytdlp_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("مجلد القياس");
        let out_dir = tmp.join("out");
        std::fs::create_dir_all(&out_dir).expect("مجلد الخرج");

        // المنفذ الوحيد: **مسار الثنائي** — وكل ما بعده كود المنتج.
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(fake.to_path_buf());

        let (tx_id, rx_id) = std::sync::mpsc::channel::<u64>();
        let (tx_done, rx_done) = std::sync::mpsc::channel::<()>();
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag_in = flag.clone();
        let progress_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let progress_in = progress_calls.clone();
        let worker_out = out_dir.clone();
        let worker = std::thread::spawn(move || {
            // التسجيل **على خيط المهمّة** (كما يفعل تلغرام/الجسر) حين نطلب
            // ذلك؛ ومسار الواجهة لا يسجّل شيئاً (لا سياق على خيطه).
            let early =
                with_ctx.then(|| crate::slots::register_early("telegram:cancel-probe", None));
            let _ = tx_id.send(early.as_ref().map(|e| e.id()).unwrap_or(0));
            let cancel = match early.as_ref() {
                Some(e) => e.cancel_flag(),
                None => flag_in,
            };
            let dl = |_p: f32| {
                progress_in.fetch_add(1, Ordering::SeqCst);
                true
            };
            let r = download_media(
                "https://www.youtube.com/watch?v=faketest1",
                &worker_out,
                &dl,
                &cancel,
            );
            let _ = tx_done.send(());
            r.is_err()
        });
        let job_id = rx_id
            .recv_timeout(Duration::from_secs(120))
            .expect("معرّف المهمّة");

        // انتظر دخول مرحلة التنزيل فعلاً: العاملة تسجّل معرّفها، والمُشغّل كذلك.
        let watched_file = out_dir.join("worker.pid");
        let single_file = out_dir.join("fake.pid");
        let wait_by = Instant::now() + Duration::from_secs(120);
        while !watched_file.is_file() && !single_file.is_file() && Instant::now() < wait_by {
            std::thread::sleep(Duration::from_millis(25));
        }
        let pid_file = if watched_file.is_file() {
            watched_file
        } else {
            single_file
        };
        assert!(
            pid_file.is_file(),
            "المزيّف لم يبدأ التنزيل خلال ١٢٠ ث — القياس باطل (لا مهمّة جارية في التنزيل)"
        );
        let watched: u32 = std::fs::read_to_string(&pid_file)
            .unwrap_or_default()
            .trim()
            .parse()
            .expect("معرّف المزيّف");
        let _cleanup = KillOnDrop(watched);
        assert!(pid_is_alive(watched), "المزيّف يجب أن يكون حيّاً قبل الإلغاء");

        // الإلغاء: من السِجلّ (تلغرام/`/kill`) أو بالعلم (الواجهة).
        let before = crate::proc::DIRECT_KILLS.load(Ordering::SeqCst);
        let t_cancel = Instant::now();
        if with_ctx {
            assert!(
                crate::slots::cancel_job(job_id),
                "cancel_job على مهمّة جارية"
            );
        } else {
            flag.store(true, Ordering::SeqCst);
        }
        let direct = crate::proc::DIRECT_KILLS.load(Ordering::SeqCst) - before;

        // المهمّة تنتهي (وهذا **قلب العطل**: بلا قتل تبقى معلّقة على الأنبوب).
        rx_done
            .recv_timeout(Duration::from_secs(60))
            .expect("المهمّة لم تنتهِ بعد الإلغاء (العطل الأصلي: تنتظر خروج yt-dlp إلى الأبد)");
        let ended = t_cancel.elapsed();
        let failed = worker.join().expect("خيط المهمّة");

        // الحكم على العملية: موت فعلي في مهلة.
        let dead_by = Instant::now() + Duration::from_secs(10);
        while pid_is_alive(watched) && Instant::now() < dead_by {
            std::thread::sleep(Duration::from_millis(25));
        }
        let probe = CancelProbe {
            watched,
            direct,
            ended,
            failed,
            progress_calls: progress_calls.load(Ordering::SeqCst),
        };
        eprintln!(
            "م٣/إلغاء التنزيل [{tag}]: المراقَب pid={} حيّ بعد الإلغاء: {} · قتل مباشر: {} مقبضاً · \
             زمن انتهاء المهمّة: {:?} · نداءات التقدّم: {}",
            probe.watched,
            pid_is_alive(probe.watched),
            probe.direct,
            probe.ended,
            probe.progress_calls
        );
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        let _ = std::fs::remove_dir_all(&tmp);
        probe
    }

    /// يبني الثنائي المزيّف **مرّة** وينسخه إلى مجلدين: صورة عملية واحدة،
    /// وصورة العمليتين (اسم المجلد هو الذي يختار الصورة).
    #[cfg(windows)]
    fn build_fake_ytdlp(root: &Path) -> (PathBuf, PathBuf) {
        let rustc = find_rustc()
            .expect("rustc غير موجود — لا يُبنى الثنائي المزيّف. الحارس يفشل بصوت عالٍ ولا يتخطّى صامتاً");
        std::fs::create_dir_all(root).expect("مجلد البناء");
        let src = root.join("fake_ytdlp.rs");
        std::fs::write(&src, FAKE_YTDLP_SRC).expect("كتابة مصدر المزيّف");
        let built_exe = root.join(ASSET_NAME);
        let built = Command::new(&rustc)
            .arg("--edition=2021")
            .arg("-A")
            .arg("warnings")
            .arg("-o")
            .arg(&built_exe)
            .arg(&src)
            .status()
            .expect("تشغيل rustc");
        assert!(built.success(), "بناء الثنائي المزيّف فشل ({built})");
        let mut out = Vec::new();
        for name in ["single", "twoproc"] {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).expect("مجلد الصورة");
            let dest = dir.join(ASSET_NAME);
            std::fs::copy(&built_exe, &dest).expect("نسخ الثنائي المزيّف");
            out.push(dest);
        }
        (out[0].clone(), out[1].clone())
    }

    /// **صورة ثالثة فأكثر للمزيّف** — تُبنى بنفس المصدر وتُنسخ إلى مجلد **اسمه
    /// يختار الصورة** (نمط `twoproc` القائم: لا وسيط اختبار في المنتج أبداً).
    #[cfg(windows)]
    fn fake_variant(root: &Path, name: &str) -> PathBuf {
        let (single, _two) = build_fake_ytdlp(root);
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).expect("مجلد الصورة");
        let dest = dir.join(ASSET_NAME);
        std::fs::copy(&single, &dest).expect("نسخ الثنائي المزيّف");
        dest
    }

    /// **مصيدة السجلّ**: طبقة تُخزّن كل حدث `tracing` في ذاكرة مشتركة — فيُقاس
    /// **ما كُتب في السجلّ فعلًا** (لا ما نوينا كتابته). وهي لازمة هنا لأن نصّ
    /// الفشل يذهب إلى مكانين: رسالة المستخدم وسطر `warn!` — والمقيس في بلاغ
    /// المالك أن **الاثنين** كانا بلا سبب.
    #[cfg(windows)]
    struct CaptureLayer(Arc<Mutex<Vec<String>>>);

    #[cfg(windows)]
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CaptureLayer {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            struct Msg(String);
            impl tracing::field::Visit for Msg {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    if field.name() == "message" {
                        self.0 = format!("{value:?}");
                    }
                }
            }
            let mut m = Msg(String::new());
            event.record(&mut m);
            if !m.0.is_empty() {
                if let Ok(mut g) = self.0.lock() {
                    g.push(m.0);
                }
            }
        }
    }

    /// يُشغّل `f` ويردّ `(نتيجته, كل سطور السجلّ المُلتقَطة)`.
    #[cfg(windows)]
    fn with_captured_log<T>(f: impl FnOnce() -> T) -> (T, Vec<String>) {
        use tracing_subscriber::prelude::__tracing_subscriber_SubscriberExt;
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let sub = tracing_subscriber::registry().with(CaptureLayer(logs.clone()));
        let out = tracing::subscriber::with_default(sub, f);
        let lines = logs.lock().map(|g| g.clone()).unwrap_or_default();
        (out, lines)
    }

    /// **قياس زمن الإلغاء في مسار التنزيل الإنتاجي** — بالثواني.
    ///
    /// **لمن**: حارس نصّ الإلغاء في `telegram.rs`
    /// (`the_prepare_phase_cancel_reply_carries_a_measured_number`) ينادي هذه
    /// لا أداةً نائمة خارج المسار — وهو **إعادة بناء الحارس** بعد أن قِيس أن
    /// القديم شغّل `ping` (‏المسار المسجَّل) بينما yt-dlp كان يسلك مساراً آخر.
    ///
    /// **ولا يأخذ `registry_test_lock`**: مستدعيه يملكه (‏Mutex غير تراكبي).
    ///
    /// **ويقيس على صورة العمليتين** (‏مُشغّل + عامل — صورة yt-dlp الحقيقية
    /// المقيسة): فبها يسقط القياس إن عاد المسار إلى `spawn` مباشر أو فُقدت مهمّة
    /// النواة، بخلاف صورة العملية الواحدة التي يقتلها `taskkill` وحده.
    #[cfg(windows)]
    pub(crate) fn measure_download_cancel_secs() -> f64 {
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let (_single, two) = build_fake_ytdlp(&root);
        let probe = cancel_probe(&two, "measure", true);
        assert!(
            !pid_is_alive(probe.watched),
            "القياس باطل: العملية المزيّفة لم تمت (pid={})",
            probe.watched
        );
        assert!(probe.failed, "الإلغاء عاد نجاحاً كاذباً");
        probe.ended.as_secs_f64()
    }

    /// **حارس مسار التنزيل (١): الإلغاء يقتل yt-dlp فعلاً — بقياس على العملية.**
    ///
    /// **العطل (م٣/إصلاح٢، مُثبَت حيّاً بمدقّق مستقلّ)**: `download_media` كانت
    /// تُشغّل yt-dlp بـ`Command::spawn()` مباشرةً ⇒ الطفل **لا يُسجَّل** في
    /// `ctx.children` فيجد `proc::kill_children` صفراً، وحارسها الداخلي
    /// (`ytdlp-cancel-watch`) يقتل **مرّة واحدة ثم `break`** ⇒ بقيت `yt-dlp`
    /// حيّة والمهمّة بلا نهاية (قِيس: `/status` بعد ١٤٣ ث «▶ يعمل الآن… طُلب
    /// إلغاؤها»، والسجلّ «قُتلت 0 عملية فرعية حيّة»).
    ///
    /// **ولماذا هذا الحارس يرى العطل والقديم لا يراه**: القديم شغّل `ping` عبر
    /// `proc::run_cancellable` — وهو **المسار المسجَّل المُستطلَع** — بينما
    /// yt-dlp يسلك مساراً آخر. فهذا الحارس **يسلك مسار المنتج**: يبني ثنائياً
    /// مزيّفاً بدور yt-dlp، ثم ينادي **`download_media` نفسها**، ثم يُلغي **من
    /// السِجلّ** (`slots::cancel_job` — نفس ما يفعله زرّ تلغرام و`/kill`).
    ///
    /// **وما يُثبته بأربعة قيود**:
    /// (أ) العملية المزيّفة **ماتت فعلاً** بمعرّفها (`WaitForSingleObject`)،
    /// (ب) والقتل المباشر **وجد مقبضاً مسجَّلاً** (`proc::DIRECT_KILLS` يزيد) —
    ///     وهذا هو القيد الذي **يسقط بإسقاط التسجيل**،
    /// (ج) والمهمّة **انتهت** في زمن محدود،
    /// (د) والنتيجة **ليست نجاحاً** (إلغاء لا نجاة).
    #[cfg(windows)]
    #[test]
    fn a_cancelled_url_download_really_kills_ytdlp() {
        use std::time::Duration;
        let _reg = crate::slots::registry_test_lock();
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let (single, _two) = build_fake_ytdlp(&root);

        let probe = cancel_probe(&single, "single", true);
        assert!(
            !pid_is_alive(probe.watched),
            "yt-dlp ما زال حيّاً (pid={}) بعد الإلغاء — العطل الأصلي بعينه",
            probe.watched
        );
        assert!(
            probe.direct >= 1,
            "القتل المباشر لم يجد مقبضاً مسجَّلاً (قتل {}) — الطفل غير مسجَّل في سياق المهمّة",
            probe.direct
        );
        assert!(
            probe.ended < Duration::from_secs(20),
            "المهمّة لم تنتهِ في زمن الإلغاء: {:?}",
            probe.ended
        );
        assert!(probe.failed, "الإلغاء عاد نجاحاً كاذباً");
        // **حارس التقدّم**: المزيّف يحاكي `--quiet` المقيسة في yt-dlp (`--print`
        // يعنيها) فلا يُخرج `[download]` إلا مع `--no-quiet`؛ فسقوط العلم يُصفّر
        // هذا العدّ ⇒ رسالة حالة واقفة عند 0% وحارس جمود أعمى.
        assert!(
            probe.progress_calls > 0,
            "لا نداء تقدّم واحد: yt-dlp يبقى صامتاً (‏`--print` يعني `--quiet`) — \
             الحالة تبقى 0% وحارس الجمود لا يرى مخرجاً"
        );
    }

    /// **حارس مسار التنزيل (٢): عاملٌ يبقى حيّاً بعد موت مُشغّله.**
    ///
    /// **وهذا هو العطل المقيس على الأداة الحقيقية**: `yt-dlp.exe` **عمليّتان**
    /// (مُشغّل ← عامل)، و`taskkill /T /F /PID <المُشغّل>` يقتل الشجرة **التي
    /// يراها في لحظتها**: قِيس على هذه الآلة أن قتلاً بعد **٢٠٠ مللي** من
    /// الإطلاق يترك العامل حيّاً في **١ من ٤** تشغيلات (وصفر من ٤ عند ١٢٠ و٣٠٠
    /// و٩٠٠ مللي). والعامل الناجي يمسك الأنبوب الموروث فيبقى قارئ المهمّة
    /// محجوباً **بلا نهاية** — وهو ما رصده المدقّق حيّاً بعد ١٤٣ ث.
    ///
    /// والحارس يثبّت تلك الصورة **حتميّاً** لا بالسباق: المُشغّل يخرج فوراً بعد
    /// إنشاء عامله، فالطفل المسجَّل ميت والعامل حيّ — فمُطاردة الشجرة بمعرّف
    /// أبيه لا تُدركه، ولا يُدركه إلا **وعاء النواة** (مهمّة الـJob).
    ///
    /// (مُفسَد محروس: إسقاط الـJob من [`crate::proc::ChildHandle`] ⇒ يبقى العامل
    /// حيّاً ولا تنتهي المهمّة ⇒ يسقط هذا الاختبار.)
    #[cfg(windows)]
    #[test]
    fn a_cancelled_url_download_kills_the_worker_that_outlives_its_launcher() {
        use std::time::Duration;
        let _reg = crate::slots::registry_test_lock();
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let (_single, two) = build_fake_ytdlp(&root);

        let probe = cancel_probe(&two, "twoproc", true);
        assert!(
            !pid_is_alive(probe.watched),
            "عامل yt-dlp الناجي من موت مُشغّله ما زال حيّاً (pid={}) — نافذة الفلتان مفتوحة",
            probe.watched
        );
        assert!(
            probe.ended < Duration::from_secs(20),
            "المهمّة لم تنتهِ بعد الإلغاء: {:?} — العامل الناجي يمسك الأنبوب",
            probe.ended
        );
        assert!(probe.failed, "الإلغاء عاد نجاحاً كاذباً");
    }

    /// **حارس مسار التنزيل (٣): مسار الواجهة — بلا سياق مهمّة، والعلم وحده.**
    ///
    /// `lib.rs::download_media_cmd` ينادي `download_media` على خيط
    /// `spawn_blocking` **بلا `slots::register_early`** ⇒ لا سياق ⇒
    /// `register_child` يعيد صفراً ولا يجد `cancel_job` ما يقتله، وإلغاء
    /// الواجهة **ضبطُ علم** (`state.cancel_flag`) لا نداء سِجلّ.
    ///
    /// فهذا الحارس يفصل **الحارس الداخلي** عن التسجيل: هو وحده من يقتل هنا.
    /// ومع صورة العمليتين (مُشغّل يخرج وعامل يبقى) لا يكفي حارسٌ ينصرف عند موت
    /// الطفل المباشر — وهو ما كان يقع.
    ///
    /// (مُفسَد محروس: إعادة الانصراف عند موت الطفل المباشر، أو إسقاط القتل بعد
    /// موته ⇒ يبقى العامل حيّاً ولا تنتهي المهمّة ⇒ يسقط هذا الاختبار.)
    #[cfg(windows)]
    #[test]
    fn the_gui_path_cancel_kills_ytdlp_without_any_job_context() {
        use std::time::Duration;
        let _reg = crate::slots::registry_test_lock();
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let (_single, two) = build_fake_ytdlp(&root);

        let probe = cancel_probe(&two, "twoproc_nogui", false);
        assert_eq!(
            probe.direct, 0,
            "مسار الواجهة لا يمرّ بـcancel_job — فتسجيل مقبض هنا يعني أن القياس ليس قياسه"
        );
        assert!(
            !pid_is_alive(probe.watched),
            "عامل yt-dlp ما زال حيّاً (pid={}) — الحارس الداخلي وحده كان يجب أن يقتله",
            probe.watched
        );
        assert!(
            probe.ended < Duration::from_secs(20),
            "المهمّة لم تنتهِ بعد إلغاء الواجهة: {:?}",
            probe.ended
        );
        assert!(probe.failed, "الإلغاء عاد نجاحاً كاذباً");
    }

    /// النصّ **الحرفي** المقيس على هذه الآلة في محاولة فاشلة حقيقية (٣ محاولات
    /// بنفس أمر التطبيق: ٢ نجحت و١ فشلت بهذا السطر على stderr).
    #[cfg(windows)]
    const MEASURED_403: &str = "ERROR: unable to download video data: HTTP Error 403: Forbidden";

    /// **حارس (٤): الفشل يحمل سببه — ذيل `stderr` لا يُرمى.**
    ///
    /// **العطل الميداني (بلاغ المالك 2026-09-23)**: التنزيل يبلغ ١٠٠٪ ثم
    /// `✗ فشل التنزيل: ملفات: yt-dlp خرج بـexit code: 1` **بلا أي سطر خطأ** —
    /// لأن stderr كان يُصرَّف **إلى بالوعة تُرمى** وذيل الفشل يُبنى من stdout
    /// وحده، و`ERROR: …` في yt-dlp **على stderr**. فالمستخدم والسجلّ كلاهما
    /// كان أعمى عن السبب.
    ///
    /// **والمزيّف** (صورة `stderr_fail`) يكتب التقدّم على stdout والسطر الحرفي
    /// أعلاه على stderr ثم يخرج بـ1. فالحارس يشترط ظهور ذلك النصّ **في رسالة
    /// الفشل وفي سطر السجلّ معاً**، ووسمَ القناتين — وهو **يسقط بإعادة البالوعة**
    /// (المُفسَد المُنفَّذ، انظر التقرير).
    #[cfg(windows)]
    #[test]
    fn a_failed_download_carries_the_stderr_reason() {
        let _reg = crate::slots::registry_test_lock();
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let fake = fake_variant(&root, "stderr_fail");
        let tmp = std::env::temp_dir().join(format!("hl_stderr_reason_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("مجلد القياس");

        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(fake);
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (r, logs) = with_captured_log(|| {
            download_media(
                "https://www.youtube.com/watch?v=AJOOve4s0_8",
                &tmp,
                &|_p| true,
                &cancel,
            )
        });
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;

        let err = match r {
            Ok(p) => panic!(
                "المزيّف خرج بـ1 فيجب أن تفشل المهمّة، ونجحت بـ{}",
                p.display()
            ),
            Err(e) => format!("{e}"),
        };
        assert!(
            err.contains(MEASURED_403),
            "رسالة الفشل لا تحمل سطر السبب الحقيقي:\n{err}"
        );
        assert!(
            err.contains("stdout") && err.contains("stderr"),
            "وسم القناتين (stdout/stderr) مفقود من رسالة الفشل:\n{err}"
        );
        let log = logs.join("\n");
        eprintln!("x2-dl/حارس stderr — رسالة الفشل:\n{err}\n— وسطر السجلّ المكتوب:\n{log}");
        assert!(
            log.contains(MEASURED_403),
            "سطر `tracing::warn!` لا يحمل سبب الفشل — وهو ما رآه المالك في السجلّ:\n{log}"
        );
        assert!(
            log.contains("yt-dlp خرج بـ"),
            "لم يُكتب سطر فشل الخروج في السجلّ أصلاً:\n{log}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **حارس (٥): `clear_slots` يكنس مخلفاتنا ولا يلمس ملف المستخدم.**
    ///
    /// **لماذا يُقاس**: الفشل العابر (‏403) يترك نصفَ ملفٍ في مجلد نتائج
    /// المستخدم — قِيس على هذه الآلة **135,300,271 بايت** (`slot.f616.mp4`)
    /// باقيةً بعد الخروج بـ1. والسؤال: هل تُكنَس في المحاولة التالية لنفس
    /// الفيديو؟ الجواب في هذه الدالة، وهي **شرط مُسبق** لإعادة المحاولة
    /// (بند ٢: لا يتراكم نصف ملف).
    #[test]
    fn clear_slots_sweeps_our_junk_and_spares_user_files() {
        let dir = std::env::temp_dir().join(format!("hl_clear_slots_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("مجلد القياس");
        let ours = [
            "hl_abc123_999_0.f616.mp4",
            "hl_abc123_999_0.f251.webm",
            "hl_abc123_999_0.mp4.part",
        ];
        for n in ours {
            std::fs::write(dir.join(n), b"junk").expect("كتابة مخلفاتنا");
        }
        // ملف المستخدم وملفُ فيديو آخر: لا يُمسّان.
        let keep = ["My Song.mp4", "hl_OTHERID_1_0.f616.mp4"];
        for n in keep {
            std::fs::write(dir.join(n), b"user").expect("كتابة ملف المستخدم");
        }

        clear_slots(&dir, "abc123");

        for n in ours {
            assert!(!dir.join(n).exists(), "مخلّفنا لم يُكنَس: {n}");
        }
        for n in keep {
            assert!(dir.join(n).exists(), "مُسَّ ملفٌ ليس لنا: {n}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// نداءات المزيّف في هذه المحاولة (`calls.txt` — عدّادٌ يكتبه المزيّف).
    #[cfg(windows)]
    fn fake_calls(out_dir: &Path) -> u32 {
        std::fs::read_to_string(out_dir.join("calls.txt"))
            .unwrap_or_default()
            .trim()
            .parse()
            .unwrap_or(0)
    }

    /// **حارس (٦): الفشل العابر يُعاد عليه مرّة واحدة — وينجح.**
    ///
    /// **القياس الذي برّره**: ٣ محاولات بنفس أمر التطبيق ونفس الرابط ⇒ ١ فشل
    /// من ٣ بـ`ERROR: unable to download video data: HTTP Error 403: Forbidden`
    /// **بعد بلوغ ١٠٠٪** (فشل موقعي عابر لا علاقة له بنا)، والمحاولة الإضافية
    /// الواحدة كانت ستُنجحه. والمزيّف (صورة `retry_once`): النداء الأول يفشل
    /// بـ403 **ويترك نصفَ ملفٍ في الخانة**، والثاني ينجح ويكتب خانةً صالحة
    /// (‏WAV حقيقي يقرؤه ffprobe — فلا نجاح مزعوم بملف فارغ).
    ///
    /// **ويشترط**: نجاح المهمّة · **ونداءين بالضبط** (إعادة واحدة لا حلقة) ·
    /// **وخانةً منظّفة** من نصف ملف المحاولة الأولى (شرط الإعادة) · **وسطر
    /// إعادة صادقاً** في السجلّ يحمل نصّ stderr.
    /// (مُفسَد محروس: إسقاط الإعادة ⇒ يسقط — مُنفَّذ، انظر التقرير.)
    #[cfg(windows)]
    #[test]
    fn a_transient_failure_is_retried_once_and_succeeds() {
        let _reg = crate::slots::registry_test_lock();
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let fake = fake_variant(&root, "retry_once");
        let tmp = std::env::temp_dir().join(format!("hl_retry_ok_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("مجلد القياس");

        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(fake);
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (r, logs) = with_captured_log(|| {
            download_media(
                "https://www.youtube.com/watch?v=AJOOve4s0_8",
                &tmp,
                &|_p| true,
                &cancel,
            )
        });
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;

        let calls = fake_calls(&tmp);
        eprintln!(
            "x2-dl/حارس الإعادة — نداءات yt-dlp المزيّف: {calls} · النتيجة: {}",
            match &r {
                Ok(p) => format!("نجاح: {}", p.display()),
                Err(e) => format!("فشل: {e}"),
            }
        );
        assert_eq!(
            calls, 2,
            "الإعادة يجب أن تكون **مرّة واحدة** (نداءات: {calls})"
        );
        let out = match r {
            Ok(p) => p,
            Err(e) => panic!("المحاولة الثانية نجحت في المزيّف فيجب أن تنجح المهمّة: {e}"),
        };
        assert!(
            out.is_file(),
            "الملف المُعاد ليس على القرص: {}",
            out.display()
        );
        let leftovers: Vec<String> = std::fs::read_dir(&tmp)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.contains("f616"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "نصف الملف من المحاولة الفاشلة بقي في المجلد (الإعادة لم تُنظّف الخانة): {leftovers:?}"
        );
        let log = logs.join("\n");
        assert!(
            log.contains("أُعيدت مرّة واحدة"),
            "الإعادة لم تُسجَّل بصدق في السجلّ:\n{log}"
        );
        assert!(
            log.contains(MEASURED_403),
            "سطر الإعادة لا يحمل نصّ سبب الفشل:\n{log}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **حارس (٧): «محاولة إضافية واحدة» — لا حلقة إعادة.**
    ///
    /// المزيّف (صورة `retry_always`) يفشل بـ403 في **كل** نداء: فيجب أن يتوقّف
    /// عند نداءين اثنين ويعود بخطأ يحمل السبب — لا أن يُعيد إلى ما لا نهاية.
    #[cfg(windows)]
    #[test]
    fn a_transient_failure_that_keeps_failing_is_retried_only_once() {
        let _reg = crate::slots::registry_test_lock();
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let fake = fake_variant(&root, "retry_always");
        let tmp = std::env::temp_dir().join(format!("hl_retry_still_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("مجلد القياس");

        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(fake);
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let r = download_media(
            "https://www.youtube.com/watch?v=AJOOve4s0_8",
            &tmp,
            &|_p| true,
            &cancel,
        );
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;

        let calls = fake_calls(&tmp);
        assert_eq!(
            calls, 2,
            "فشلٌ عابر متكرّر يجب أن يُعيد **مرّة واحدة** لا حلقة (نداءات: {calls})"
        );
        let err = match r {
            Ok(p) => panic!("فشلان متتاليان لا يجوز أن يعودا نجاحاً: {}", p.display()),
            Err(e) => format!("{e}"),
        };
        assert!(err.contains(MEASURED_403), "الخطأ النهائي بلا سببه:\n{err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **حارس (٨): الفشل الدائم لا يُعاد عليه — بنصّه.**
    ///
    /// المزيّف (صورة `permanent_fail`) يكتب `ERROR: [youtube] … Video unavailable`
    /// ويخرج بـ1 ⇒ **نداء واحد** لا اثنان، والخطأ يعود بنصّه.
    /// (مُفسَد محروس: إسقاط شرط الفشل الدائم ⇒ يسقط — مُنفَّذ، انظر التقرير.)
    #[cfg(windows)]
    #[test]
    fn a_permanent_failure_is_never_retried() {
        let _reg = crate::slots::registry_test_lock();
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let fake = fake_variant(&root, "permanent_fail");
        let tmp = std::env::temp_dir().join(format!("hl_retry_perm_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("مجلد القياس");

        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(fake);
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let r = download_media(
            "https://www.youtube.com/watch?v=AJOOve4s0_8",
            &tmp,
            &|_p| true,
            &cancel,
        );
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;

        let calls = fake_calls(&tmp);
        let err = match r {
            Ok(p) => panic!("فشلٌ دائم لا يجوز أن يعود نجاحاً: {}", p.display()),
            Err(e) => format!("{e}"),
        };
        assert_eq!(
            calls, 1,
            "أُعيد على فشل **دائم** (Video unavailable) — لا إعادة على الدائم (نداءات: {calls})\n{err}"
        );
        assert!(err.contains("Video unavailable"), "النصّ الدائم ضاع:\n{err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **قياس (١١): ثمن تنظيف الخانة قبل الإعادة — بالأرقام لا بالرأي.**
    ///
    /// شرطُ الإعادة المُلزِم («نظّف خانة الفشل كي لا يتراكم نصف ملف») له ثمن
    /// مقيس هنا: لو ترك الفشلُ العابر **ملفاً كاملاً صالحاً** في الخانة، فإن
    /// `clear_slots` في رأس المحاولة الثانية **يكنسه**، فتخرج الثانية بـ0 دون
    /// كتابة ⇒ لا خانة ⇒ فشل «نجح دون ملف ناتج صالح» — أي أن ملفاً كان صالحاً
    /// يُهدَر مقابل ضمان ألّا يتراكم نصفُ ملف.
    ///
    /// **ولا يُغيَّر السلوك بهذا القياس**: البديل (تشجيع الملف الصالح قبل الإعادة)
    /// تغييرُ سياسة «الخانة هي الدليل الوحيد» ولا يُنفَّذ بلا إذن المالك.
    #[cfg(windows)]
    #[test]
    fn the_retry_sweeps_a_valid_leftover_from_the_failed_attempt() {
        let _reg = crate::slots::registry_test_lock();
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let fake = fake_variant(&root, "transient_after_valid");
        let tmp = std::env::temp_dir().join(format!("hl_retry_sweep_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("مجلد القياس");

        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(fake);
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let r = download_media(
            "https://www.youtube.com/watch?v=AJOOve4s0_8",
            &tmp,
            &|_p| true,
            &cancel,
        );
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;

        let calls = fake_calls(&tmp);
        let slots: Vec<String> = std::fs::read_dir(&tmp)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with("hl_faketest1_"))
            .collect();
        let err = match r {
            Ok(p) => panic!("الثانية خرجت بـ0 بلا خانة فيجب أن تفشل: {}", p.display()),
            Err(e) => format!("{e}"),
        };
        eprintln!(
            "x2-dl/قياس كنس الخانة — نداءات: {calls} · ملفات الخانة بعدها: {slots:?} · نتيجة المهمّة: {err}"
        );
        assert_eq!(calls, 2, "الإعادة وقعت مرّة (نداءات: {calls})");
        assert!(
            slots.is_empty(),
            "الملف الصالح من المحاولة الفاشلة بقي في الخانة — القياس باطل: {slots:?}"
        );
        assert!(
            err.contains("نجح دون ملف ناتج صالح"),
            "النتيجة ليست نصّ «نجح دون ملف ناتج صالح»: {err}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **تصنيف العابر من الدائم — بلا شبكة وبلا عمليّة.**
    #[test]
    fn permanent_failures_are_never_retried_but_a_written_cause_is() {
        assert!(!is_transient_failure(EMPTY_STDERR), "«(فارغ)» ليس سبباً");
        assert!(!is_transient_failure("   "), "الفراغ ليس سبباً");
        assert!(
            is_transient_failure("ERROR: unable to download video data: HTTP Error 403: Forbidden"),
            "الفشل المقيس (403) عابر فيجب أن يُعاد عليه"
        );
        for p in PERMANENT_FAILURES {
            let text = format!("ERROR: [youtube] {p}");
            assert!(!is_transient_failure(&text), "يُعاد على فشل دائم: {p}");
        }
        // **والقائمة نفسها محروسة**: إفراغها **مُفسَد** مرّ من هذا الاختبار أوّلاً
        // (حلقةٌ على قائمة فارغة «تنجح» بلا فحص — مُفسَد باطل يُعطي نجاحاً كاذباً)،
        // فصار النصّ المتوقّع مكتوباً هنا: حذفُ نصٍّ أو إضافةُ نصٍّ يسقط.
        let expected = [
            "Video unavailable",
            "Private video",
            "Sign in to confirm",
            "This video is not available",
            "requested format is not available",
        ];
        assert_eq!(
            PERMANENT_FAILURES, expected,
            "قائمة الفشل الدائم تغيّرت — كل نصّ فيها حدٌّ على إعادة المحاولة"
        );
    }

    /// **قياس (٩) — لا تغيير سياسة: ماذا لو ترك فشلٌ ملفاً *صالحاً* في الخانة؟**
    ///
    /// السؤال المطروح على المالك: هل يُقبَل الملف الذي يبقى في الخانة بعد خروج
    /// yt-dlp بـ1؟ والقياس هنا بثلاثة أرقام: (أ) المحاولة الفاشلة **لا** تُسلِّم
    /// الملف (السياسة: الخانة دليلٌ على **النجاح**)، (ب) الملف **يبقى** في الخانة،
    /// (ج) المحاولة التالية تقبله من **المسار السريع بلا تشغيل yt-dlp إطلاقاً**
    /// (‏عدّاد النداءات يبقى 1 — وهو ما يميّز المسار السريع من تنزيلٍ جديد).
    #[cfg(windows)]
    #[test]
    fn a_valid_file_left_by_a_failed_run_is_not_delivered_now_but_reused_next_time() {
        let _reg = crate::slots::registry_test_lock();
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let fake = fake_variant(&root, "valid_leftover");
        let tmp = std::env::temp_dir().join(format!("hl_valid_left_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("مجلد القياس");
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // ① خروج بـ1 مع ملفٍ صالح في الخانة.
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(fake.clone());
        let r1 = download_media(
            "https://www.youtube.com/watch?v=AJOOve4s0_8",
            &tmp,
            &|_p| true,
            &cancel,
        );
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        assert!(
            r1.is_err(),
            "خروجٌ بـ1 مع ملفٍ صالح في الخانة عاد **نجاحاً** — السياسة تغيّرت بلا إذن: {:?}",
            r1.map(|p| p.display().to_string())
        );
        let slot: Vec<String> = std::fs::read_dir(&tmp)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with("hl_faketest1_"))
            .collect();
        assert_eq!(
            slot.len(),
            1,
            "الملف الصالح الذي تركه الفشل ليس في الخانة — القياس باطل: {slot:?}"
        );

        // ② المحاولة التالية: المسار السريع.
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(fake);
        let r2 = download_media(
            "https://www.youtube.com/watch?v=AJOOve4s0_8",
            &tmp,
            &|_p| true,
            &cancel,
        );
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        let calls = fake_calls(&tmp);
        eprintln!(
            "x2-dl/قياس الخانة بعد فشل — نداءات yt-dlp: {calls} · نتيجة المحاولة التالية: {}",
            match &r2 {
                Ok(p) => format!("نجاح: {}", p.display()),
                Err(e) => format!("فشل: {e}"),
            }
        );
        assert_eq!(
            calls, 1,
            "المحاولة التالية شغّلت yt-dlp (نداءات: {calls}) — القياس عن المسار السريع باطل"
        );
        let out = r2.expect("المسار السريع كان يجب أن يقبل الملف الصالح المتروك");
        assert!(
            out.is_file(),
            "الملف المُسلَّم ليس على القرص: {}",
            out.display()
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **حارس (١٠): فشل التنزيل لا يُوسَم «ملفات:» — ولا يفقد اسمه.**
    ///
    /// **العطب الميداني**: نصّ الفشل الذي وصل المالك في تلغرام كان
    /// `✗ فشل التنزيل: ملفات: yt-dlp خرج بـexit code: 1` — و«ملفات:» تسمية
    /// **خاطئة** لعطل شبكي/موقعي (‏403 مقيس)، فبحث المالك عن عطل ملفات ولا
    /// ملفَّ هنا. والسبب: فرع خروج العمليّة كان يُمرَّر من باب `YtError::Io`
    /// (‏`:424` في ذلك الوقت) الذي يُعرض «ملفات: {e}».
    ///
    /// **والمزيّف نفسه** (صورة `stderr_fail`) يخرج بـ1 بعد كتابة السبب على
    /// stderr ⇒ فالنصّ المقيس هنا هو نصّ المستخدم بعينه.
    /// (مُفسَد محروس: إعادة الفرع إلى `YtError::Io` ⇒ يسقط — مُنفَّذ.)
    #[cfg(windows)]
    #[test]
    fn a_download_exit_failure_names_the_download_not_a_file_error() {
        let _reg = crate::slots::registry_test_lock();
        let root = std::env::temp_dir().join(format!("hl_fakebuild_{}", std::process::id()));
        let fake = fake_variant(&root, "stderr_fail");
        let tmp = std::env::temp_dir().join(format!("hl_label_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("مجلد القياس");

        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(fake);
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let r = download_media(
            "https://www.youtube.com/watch?v=AJOOve4s0_8",
            &tmp,
            &|_p| true,
            &cancel,
        );
        *ytdlp_test_override()
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;

        let err = match r {
            Ok(p) => panic!(
                "المزيّف خرج بـ1 فيجب أن تفشل المهمّة، ونجحت بـ{}",
                p.display()
            ),
            Err(e) => format!("{e}"),
        };
        eprintln!("x2-dl/وسم الفشل — نصّ المستخدم:\n✗ فشل التنزيل: {err}");
        assert!(
            !err.starts_with("ملفات:"),
            "فشل التنزيل وُسم «ملفات:» — تسمية خاطئة لعطل شبكي/موقعي:\n{err}"
        );
        assert!(
            err.contains("yt-dlp خرج بـexit code: 1"),
            "النصّ لا يسمّي ما جرى (خروج yt-dlp برمز):\n{err}"
        );
        assert!(
            err.contains(MEASURED_403),
            "ونصّ السبب المقيس يجب أن يبقى:\n{err}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **ووسم `Io` يبقى لما هو ملفّي حقاً** — فلا يُفرَّغ الباب الآخر بالغلط.
    #[test]
    fn only_real_file_failures_are_labelled_as_file_errors() {
        let process = YtError::Process("yt-dlp خرج بـexit code: 1".into());
        assert_eq!(format!("{process}"), "yt-dlp خرج بـexit code: 1");
        let cancel = YtError::Process("أُلغي التنزيل من قبل المستخدم".into());
        assert_eq!(format!("{cancel}"), "أُلغي التنزيل من قبل المستخدم");
        let io = YtError::Io("تعذر إنشاء مجلد النتائج".into());
        assert_eq!(format!("{io}"), "ملفات: تعذر إنشاء مجلد النتائج");
    }

    /// أبناء `yt-dlp.exe` الأحياء الآن (بالاسم — جرد حقيقي لا استنتاج).
    #[cfg(windows)]
    fn ytdlp_pids() -> Vec<u32> {
        let out = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-Process yt-dlp -ErrorAction SilentlyContinue).Id",
            ])
            .output();
        match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .filter_map(|t| t.parse::<u32>().ok())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// **معايرة الرقم: زمن الإلغاء الحقيقي في مرحلة التنزيل — على الأداة
    /// الحقيقية وشبكة حقيقية.**
    ///
    /// **لماذا معزول (`#[ignore]`)**: يحتاج شبكة، فلا يصلح بوابةً تمرّ في CI.
    /// ويُشغَّل صراحةً بـ:
    /// `cargo test --lib live_cancel -- --ignored --nocapture --test-threads=1`
    ///
    /// **وما يقيسه**: مهمّة رابط **جارية فعلاً في التنزيل** (شاهدها: عملية
    /// `yt-dlp.exe` حيّة، وأول سطر تقدّم وصل) ⇒ إلغاء من السِجلّ
    /// (`slots::cancel_job` — نفس مسار زرّ تلغرام و`/kill`) ⇒ **زمن انتهاء
    /// المهمّة**، و**جرد** العمليات بعدها.
    ///
    /// **وحارس على القياس نفسه**: إن لم تكن `yt-dlp` حيّة قبل الإلغاء فالقياس
    /// باطل (لعلّه خرج بخطأ شبكة — وهي العلّة التي أبطلت الرقم السابق ٣.٦ ث:
    /// قِيس أنه كان **خروجاً طبيعياً** لا قتلاً).
    #[cfg(windows)]
    #[ignore = "يحتاج شبكة: تنزيل حقيقي من يوتيوب"]
    #[test]
    fn live_cancel_during_a_real_download_measures_the_true_kill_time() {
        use std::sync::atomic::Ordering;
        use std::time::{Duration, Instant};

        let _reg = crate::slots::registry_test_lock();
        let real = resolve_ytdlp().expect("yt-dlp حقيقي (‏../bin/yt-dlp.exe من src-tauri)");
        assert!(
            !real.to_string_lossy().contains("hl_ytdlp"),
            "الثنائي المُقاس هو الحقيقي لا المزيّف: {}",
            real.display()
        );
        let tmp = std::env::temp_dir().join(format!("hl_live_cancel_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("مجلد القياس");
        let out_dir = tmp.join("out");
        std::fs::create_dir_all(&out_dir).expect("مجلد الخرج");

        let (tx_id, rx_id) = std::sync::mpsc::channel::<u64>();
        // يُرسل عند **أول سطر تقدّم** (أي: التنزيل جارٍ فعلاً).
        let (tx_started, rx_started) = std::sync::mpsc::channel::<()>();
        let (tx_done, rx_done) = std::sync::mpsc::channel::<String>();
        let worker_out = out_dir.clone();
        let worker = std::thread::spawn(move || {
            let early = crate::slots::register_early("telegram:live-cancel", None);
            let _ = tx_id.send(early.id());
            let cancel = early.cancel_flag();
            let announced = std::sync::atomic::AtomicBool::new(false);
            let dl = |p: f32| {
                // أي سطر تقدّم = التنزيل بدأ فعلاً (أول سطر يقول 0.0%).
                if !announced.swap(true, Ordering::SeqCst) {
                    let _ = tx_started.send(());
                }
                let _ = p;
                true
            };
            let r = download_media(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                &worker_out,
                &dl,
                &cancel,
            );
            let _ = tx_done.send(match &r {
                Ok(p) => format!("نجح: {}", p.display()),
                Err(e) => format!("{e}"),
            });
            r
        });
        let job_id = rx_id
            .recv_timeout(Duration::from_secs(180))
            .expect("معرّف المهمّة");

        if rx_started.recv_timeout(Duration::from_secs(300)).is_err() {
            let why = rx_done
                .recv_timeout(Duration::from_secs(30))
                .unwrap_or_else(|_| "(لا نتيجة)".into());
            panic!("التنزيل لم يبدأ خلال ٥ دقائق — القياس باطل. نتيجة download_media: {why}");
        }
        let before = ytdlp_pids();
        assert!(
            !before.is_empty(),
            "لا عملية yt-dlp حيّة قبل الإلغاء — القياس باطل (لعله خرج بخطأ شبكة: وهو ما أبطل الرقم ٣.٦ ث)"
        );

        let t0 = Instant::now();
        assert!(
            crate::slots::cancel_job(job_id),
            "cancel_job على مهمّة جارية"
        );
        let killed_at_cancel = ytdlp_pids();
        let outcome = rx_done
            .recv_timeout(Duration::from_secs(120))
            .expect("المهمّة لم تنتهِ بعد الإلغاء");
        let measured = t0.elapsed();
        let _ = worker.join();
        // الجرد بعد الانتهاء: لا yt-dlp من هذه العمليّة.
        let mut after = ytdlp_pids();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !after.is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
            after = ytdlp_pids();
        }
        eprintln!(
            "م٣/قياس حيّ: yt-dlp قبل الإلغاء {before:?} · عند عودة cancel_job {killed_at_cancel:?} · \
             بعد الانتهاء {after:?} · الزمن المقيس من طلب الإلغاء إلى انتهاء المهمّة: {measured:?} \
             ({:.0} مللي) · نتيجة المهمّة: {outcome}",
            measured.as_secs_f64() * 1000.0
        );
        assert!(
            after.is_empty(),
            "بقيت عمليات yt-dlp حيّة بعد الإلغاء: {after:?} — العطل الأصلي بعينه"
        );
        // **والرقم المعلن في نصّ البوت يغطّي هذا القياس الحقيقي** (وهو مرجعه).
        assert!(
            measured.as_secs_f64() <= crate::telegram::CANCEL_PREPARE_WORST_SECS,
            "القياس الحيّ {measured:?} تجاوز الرقم المعلَن {} ث",
            crate::telegram::CANCEL_PREPARE_WORST_SECS
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
