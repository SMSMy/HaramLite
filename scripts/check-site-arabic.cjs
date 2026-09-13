#!/usr/bin/env node
/* حارس العربية: يمنع رجوع الأخطاء التي أُصلحت في هذه الجولة.
   أربعة أنواع، كل واحد منها بسبب واقعي مقيس:
   1) عنوان مقطوع   — ثلاثة عناوين كانت 70 حرفاً بالضبط وتنتهي بنصف كلمة.
   2) وصف مقطوع     — أحد عشر وصفاً قُصّ عند 155 حرفاً في منتصف كلمة.
   3) إنجليزي زينة  — عناوين كبيرة بلا معنى وظيفي في صفحة عربية.
   4) أخطاء معجمة   — كلمات أُصلحت فعلاً (نقحرة وأخطاء مطبعية).
   الاستعمال: node scripts/check-site-arabic.cjs */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/* ما يُقبل بالإنجليزية: أسماء المنتجات والبروتوكولات والامتدادات.
   نطابق «كلمة» لا «جملة»: الجملة الإنجليزية المتروكة هي المشكلة. */
const ALLOWED_LATIN = new Set([
  'haramlite', 'haramlite.com', 'bridge', 'youtube', 'github', 'windows', 'chrome', 'edge',
  'firefox', 'ffmpeg', 'yt-dlp', 'onnx', 'gpu', 'cpu', 'cuda', 'directml', 'sha-256', 'sha256',
  'gpo', 'msi', 'nsis', 'mdm', 'intune', 'drm', 'mp3', 'mp4', 'wav', 'flac', 'opus', 'mkv', 'webm',
  'm4a', 'id3', 'cli', 'api', 'json', 'ld', 'html', 'css', 'js', 'ts', 'vite', 'tauri', 'rust',
  'onnxruntime', 'uvr', 'mdx', 'mdx-net', 'voc', 'ft', 'demucs', 'pytorch', 'android', 'ios',
  'syncthing', 'nextcloud', 'tailscale', 'safari', 'macos', 'linux', 'x64', 'avx2', 'dpapi',
  'localappdata', 'appdata', 'stdin', 'stdout', 'native', 'messaging', 'manifest', 'v3', 'v2',
  'popup', 'tos', 'ai', 'url', 'oss', 'http', 'https', 'localhost', 'sqlite', 'json-ld',
  'readdirectorychangesw', 'passthrough', 'lossless', 'gap-skip', 'samplerate', 'tight', 'sync',
  'screenshots', 'telegram', 'bot', 'botfather', 'markdown', 'yaml', 'xml', 'svg', 'png', 'jpg',
  'cookie', 'cookies', 'cache', 'lufs', 'bs.1770', 'itu-r', 'stft', 'bfcarena', 'graphtransformer',
  'oncecell', 'mutex', 'rayon', 'serde', 'npm', 'pnpm', 'node', 'cargo', 'webview2', 'wix', 'msi',
  'autostart', 'registry', 'hkcu', 'run', 'hidden-start', 'uuid', 'pid', 'tcp', 'udp', 'ip', 'dns'
]);

/* عناوين إنجليزية زينة: لا تحمل معلومة للمستخدم العربي. */
const DECOR = [
  'ARCHITECTURE SNAPSHOT', 'VERIFIED WORKFLOW', 'LOSSLESS-STREAM-MUXING',
  'Local Security Model', 'Zero-Trust Tunneling', 'Acoustic Decision Matrix',
  'Acoustic Compass', 'OPERATIONAL MODES CHEAT SHEET', 'READY TO DEPLOY',
  'READY TO PURIFY YOUR AUDIO', 'KNOWLEDGE BASE', 'Interactive Infographic',
  'Google DeepMind', 'Acoustic Decision', 'SYSTEM CAPABILITY', 'TECHNICAL DEEP DIVE'
];

/* أخطاء أُصلحت: نقحرة وأخطاء مطبعية وكلمات موضوعة في غير موضعها. */
const BAD_WORDS = [
  'التيراكبير', 'InTune', 'إعدام الملف', 'سعات الاستلام',
  'تقع عاتق', 'التقنيات كلاهما', 'سيادة البيانات', 'الـ الربط', 'رمز الرمز',
  'Designed with Charcoal', 'Skip to the content', 'بت إلى السحابة',
  'توفير وقت الرندرة', 'قدرات متقدمة للمستخدمين المتقدمين', 'المتصفح الذكي',
  'هدوء واحترافية', 'الصريحة الكاملة', 'كود مصدري نقي', 'خط إنتاج المستودع',
  'نقاء يصل إلى', 'تلف بنسبة', 'vocal-clarity', 'offline-mode', 'export-format',
  'isolate-speech', 'Volumes/Storage'
];

/* ادعاءات ممنوعة: صيغ أُزيلت لأنها باطلة أو مبالغ فيها، وتعود مع كل إعادة
   تصميم إن لم يمنعها حارس (درس Demucs التي عادت بعد إزالتها).
   تُفحص بلا حساسية لحالة الأحرف لأنها تظهر Frame-Accurate وFRAME-ACCURATE. */
const FORBIDDEN_CLAIMS = [
  'frame-accurate', 'بدقة الإطار', 'الإطاري الدقيق', 'مفعل تلقائياً',
  'لا يغادران حاسوبك إطلاقاً', 'لا يغادر حاسوبك', '100% دون تأخير'
];

/* ما يُشبه الخطأ وليس خطأً — مُتحقَّق من المصدر:
   · com.harammute.haramlite هو اسم مضيف الاتصال الفعلي (src-tauri/src/bridge.rs:33)
     ويظهر في مسار البيانات، فلا يجوز «تصحيحه».
   · Intune هي الكتابة الرسمية لخدمة مايكروسوفت (والخطأ كان InTune). */
const EXPECTED = [/com\.harammute\.haramlite/g, /\bIntune\b/g];

const problems = [];
const files = [];
/* ملف إثبات ملكية قوقل ليس صفحة موقع: قوقل يجلبه من الجذر للتحقق فقط
   (SITE.md: لا يُنقل ولا يُعدَّل). */
const NOT_A_PAGE = /google[0-9a-f]+\.html$/i;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|assets|rebuild|\.git/.test(p)) walk(p); }
    else if (e.name.endsWith('.html') && !NOT_A_PAGE.test(e.name)) files.push(p);
  }
})(path.join(root, 'docs'));

/* الوسوم التي تُستثنى من فحص الإنجليزية: الشيفرة وأسماء الملفات والمسارات،
   وكتل الطرفية (pre/terminal): مخرجات الأمر الحقيقية تبقى بلغتها، وترجمتها
   تعني عرض نص لا يراه المستخدم فعلاً. */
function stripCode(html) {
  return html
    .replace(/<code[\s\S]*?<\/code>/gi, ' ')
    .replace(/<pre[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/* 5) كتلة إنجليزية كاملة داخل صفحة عربية.
   لا نحكم على الصفحة كلها — PRIVACY.html فيه نسخة إنجليزية مشروعة. نحكم على
   كل قسم وحده: إن غلب اللاتيني على العربي في كتلة فيها نص كافٍ، فهي كتلة
   متروكة بلا تعريب. */
const AR = /[\u0600-\u06FF]/g;
const LAT = /[A-Za-z]/g;
function latinHeavy(html) {
  const text = stripCode(html).replace(/\s+/g, ' ').trim();
  const ar = (text.match(AR) || []).length;
  const la = (text.match(LAT) || []).length;
  if (la < 60) return null;          // نص قصير: لا نحكم (شارة/اسم ملف)
  if (ar === 0) return { la, ar, ratio: 1 };
  return la / (la + ar) > 0.7 ? { la, ar, ratio: la / (la + ar) } : null;
}

for (const f of files.sort()) {
  const rel = path.relative(root, f);
  const raw = fs.readFileSync(f, 'utf8');

  // 1) العنوان
  const tm = raw.match(/<title>([\s\S]*?)<\/title>/i);
  if (!tm) problems.push(rel + ': بلا <title>');
  else {
    const title = tm[1].trim();
    if (title.length > 65) problems.push(rel + ': العنوان ' + title.length + ' حرفاً (الحدّ 65) — «' + title + '»');
    // ينتهي بحرف ربط ⇒ جملة مقطوعة
    if (/(على|من|في|إلى|مع|عن|التي|الذي|أن|و)\s*\|\s*HaramLite$/i.test(title))
      problems.push(rel + ': العنوان ينتهي بحرف ربط قبل | HaramLite — مقطوع');
    if (/(الموسيقي|الصوتي|الموسيق|الكامل)\s*\|\s*HaramLite$/i.test(title))
      problems.push(rel + ': العنوان ينتهي بكلمة ناقصة (تاء مربوطة ساقطة؟)');
  }

  // 2) الوصف
  const dm = raw.match(/name="description"\s+content="([^"]*)"/i) || raw.match(/content="([^"]*)"\s+name="description"/i);
  if (!dm) problems.push(rel + ': بلا meta description');
  else {
    const d = dm[1].trim();
    if (d.length > 165) problems.push(rel + ': الوصف ' + d.length + ' حرفاً (الحدّ 165)');
    // آخر «كلمة» بلا نهاية جملة ⇒ قصّ
    if (!/[.؟!»)]$/.test(d)) problems.push(rel + ': الوصف لا ينتهي بجملة تامة — «…' + d.slice(-22) + '»');
  }

  // 3) إنجليزي زينة
  const text = stripCode(raw);
  for (const phrase of DECOR) {
    if (text.includes(phrase)) problems.push(rel + ': عنوان إنجليزي زينة — «' + phrase + '»');
  }

  // 4) أخطاء معجمة (مع استثناء ما هو صحيح ومُتحقَّق منه)
  let scannable = text;
  for (const ok of EXPECTED) scannable = scannable.replace(ok, ' ');
  for (const bad of BAD_WORDS) {
    if (scannable.includes(bad)) problems.push(rel + ': صياغة مرفوضة — «' + bad + '»');
  }

  // 4ب) ادعاءات ممنوعة (بلا حساسية لحالة الأحرف)
  const lowered = scannable.toLowerCase();
  for (const bad of FORBIDDEN_CLAIMS) {
    if (lowered.includes(bad.toLowerCase())) problems.push(rel + ': ادعاء ممنوع — «' + bad + '»');
  }

  // 5) كتل متروكة بلا تعريب
  const blocks = raw.split(/(?=<section\b)|(?=<footer\b)|(?=<nav\b)|(?=<aside\b)/i);
  blocks.forEach((b, i) => {
    const hit = latinHeavy(b);
    if (!hit) return;
    const sample = stripCode(b).replace(/\s+/g, ' ').trim().slice(0, 64);
    problems.push(rel + ': كتلة بلا تعريب (' + Math.round(hit.ratio * 100) + '% لاتيني) — «' + sample + '…»');
  });
}

console.log('  حارس العربية: فحص ' + files.length + ' صفحة');
if (problems.length) {
  console.error('  ✗ ' + problems.length + ' ملاحظة:');
  [...new Set(problems)].forEach(p => console.error('     - ' + p));
  process.exit(1);
}
console.log('  ✓ العناوين والأوصاف تامة، ولا إنجليزي زينة ولا صياغة مرفوضة');
