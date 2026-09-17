#!/usr/bin/env node
/* حارس الروابط والادّعاءات.
   سبب وجوده: أربعة حراس (CSS · الصفحات · الوسوم · العربية) مرّت جميعاً على
   بطاقات محتوى تشير إلى الرئيسية href="../" بدل الدليل المقصود، وعلى ادّعاء
   «يفتح المنفذ المحلي الآمن localhost:9191» وهو منفذ لا ذكر له في الكود
   إطلاقاً. لا حارس منها يقرأ النيّة، فهذا الحارس يقرأها بثلاث قواعد:

   1) بطاقة محتوى تشير إلى الرئيسية: رابط داخل <main> (لا تنقّل، لا فتات خبز)
      وhref="../" بلا مرساة ⇒ الزائر يُرسَل إلى الرئيسية بدل المقال.
   2) data-path يصف دليلاً لا وجود له ⇒ إمّا رابط مكسور أو صفحة ناقصة.
   3) ادّعاءات معمارية مُتحقَّق منها ضد الكود: أي «منفذ محلي» في الموقع يجب
      أن يوجد في src-tauri؛ والمعمارية الفعلية Native Messaging (stdin/stdout).

   ── تحصين هذه الجولة (عيوب مُقاسة سابقاً، أعيد إنتاجها جميعاً قبل الإصلاح) ──
   · «0 صفحة ⇒ نفس سطر ✓ و exit 0»: كانت الشجرة الفارغة تُنتج نجاحاً. الآن كل
     مدخل صفري وكل بنية ناقصة **تُسقط الحارس برسالة مسمّاة** لا بـstack trace.
   · `rustAll.includes(port)`: مطابقة جزئية ⇒ «9191» يمرّ لأن «91910» بادئة له،
     ويمرّ إن كان الرقم في **تعليق** Rust. الآن تُجرَّد التعليقات ويُطابَق الرقم
     **رمزةً كاملة** بحدود رقمية.
   · `pages.includes(path.basename(href))`: مطابقة بالاسم الأساسي وحده ⇒
     `does-not-exist/x.html` يمرّ لوجود `x.html`. الآن يُحلّ الهدف نسبةً إلى
     مجلد الصفحة نفسها ويُشترط وجوده فعلاً **داخل docs/**.

   الاستعمال: node scripts/check-site-links.cjs [--root <dir>] */
const fs = require('fs');
const path = require('path');

/* ── 0) الجذر والبنية: فشل بصوت عالٍ ─────────────────────────────────────── */
const argv = process.argv.slice(2);
let rootArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      console.error('✗ العلم --root يحتاج مساراً — مثال: --root /tmp/fixture');
      process.exit(2);
    }
    rootArg = argv[++i];
  } else {
    console.error('✗ وسيط غير معروف: ' + argv[i] + ' — الاستعمال: [--root <dir>]');
    process.exit(2);
  }
}
const root = rootArg ? path.resolve(rootArg) : path.join(__dirname, '..');
const docsDir = path.join(root, 'docs');
const guidesDir = path.join(docsDir, 'guides');
const rustDir = path.join(root, 'src-tauri/src');

function die(msg) {
  console.error('✗ حارس الروابط والادّعاءات: ' + msg);
  process.exit(1);
}
for (const [dir, label] of [[root, 'جذر المشروع'], [docsDir, 'docs/'], [guidesDir, 'docs/guides/'], [rustDir, 'src-tauri/src/']]) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    die('بنية غير صالحة: ' + label + ' غير موجود عند ' + dir);
  }
}

const guideFiles = fs.readdirSync(guidesDir).filter(x => x.endsWith('.html'));
if (guideFiles.length === 0) {
  die('صفر صفحة دليل في ' + guidesDir + ' — لا شيء يُفحص، فلا يجوز إعلان النجاح.');
}

const problems = [];

/* ── القاعدة 1: بطاقات داخل المحتوى تشير إلى الرئيسية ── */
const CONTENT_CARD = /<a\b[^>]*class="[^"]*(rounded-xl|rounded-lg)[^"]*"[^>]*href="\.\.\/"[^>]*>/g;
/* أزرار الإجراء المشروعة التي تذهب إلى الرئيسية عن قصد: «البناء من المصدر»
   و«مستودع GitHub» و«الإبلاغ عن مشكلة» أهدافها أقسام في الصفحة الرئيسية،
   لا مقالات. تُستثنى بنصّها لا بمظهرها. */
const INTENTIONAL_CTA = /(CLI ومستودع GitHub|البناء من المصدر|مستودع GitHub|الإبلاغ عن مشكلة|Star|نجمة)/;
for (const f of guideFiles) {
  const t = fs.readFileSync(path.join(guidesDir, f), 'utf8');
  const NAVISH = /(data-path="home"|>\s*(الرئيسية|Haram\s*Lite)\s*<)/;
  for (const m of t.matchAll(CONTENT_CARD)) {
    const line = (t.slice(0, m.index).match(/\n/g) || []).length + 1;
    const after = t.slice(m.index + m[0].length);
    const inner = after.slice(0, after.indexOf('</a>') < 0 ? 160 : after.indexOf('</a>'));
    if (NAVISH.test(inner)) continue;
    // بطاقة المحتوى تحمل عنواناً ووصفاً؛ زر الإجراء المشروع يُستثنى بنصّه
    const stripped = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (INTENTIONAL_CTA.test(stripped)) continue;
    const label = stripped.slice(0, 46);
    problems.push('guides/' + f + ':' + line + ' بطاقة محتوى تشير إلى الرئيسية — «' + label + '»');
  }
}

/* ── القاعدة 2: data-path بلا وجهة حقيقية تقابله ──
   الوجهة تُحلّ نسبةً إلى **مجلد الصفحة نفسها**، لا بالاسم الأساسي؛ فمطابقة
   `path.basename` كانت تمرّر `does-not-exist/x.html` لوجود `x.html`.
   ومسارات التنقّل المعروفة (home → ../  ·  guides → ./) تُقبل كما هي. */
const NAV_DATA_PATHS = new Set(['home', 'guides', 'download', 'features', 'whats-new',
  'privacy', 'developers', 'browser-extension', 'docs']);
for (const f of guideFiles) {
  const t = fs.readFileSync(path.join(guidesDir, f), 'utf8');
  const pageDir = guidesDir;
  for (const m of t.matchAll(/data-path="([^"]+)"\s+href="([^"]*)"/g)) {
    const [, dp, href] = m;
    if (/^https?:/i.test(href)) continue;            // خارجي: لا يُحلّ محلياً
    if (href.startsWith('#')) continue;              // مرساة داخلية
    if (dp === 'open-source-github') continue;       // مرساة خارجية معلنة
    const filePart = href.split('#')[0];
    const hasAnchor = href.includes('#');
    if (filePart === '') continue;                   // مرساة فقط
    // التنقّل المعلن إلى الرئيسية أو إلى فهرس الأدلة: مقبول كما هو
    if (NAV_DATA_PATHS.has(dp) && (filePart === '../' || filePart === './')) continue;
    if (filePart === '../' && !hasAnchor) {
      problems.push('guides/' + f + ' data-path="' + dp + '" يشير إلى الرئيسية بلا مرساة');
      continue;
    }
    const target = path.resolve(pageDir, filePart);
    const insideDocs = target === docsDir || target.startsWith(docsDir + path.sep);
    if (!insideDocs) {
      problems.push('guides/' + f + ' data-path="' + dp + '" → وجهة خارج docs/: ' + href);
    } else if (!fs.existsSync(target)) {
      problems.push('guides/' + f + ' data-path="' + dp + '" → وجهة غير موجودة: ' + href);
    }
  }
}

/* ── القاعدة 3: ادّعاءات معمارية ضد الكود ── */
const rust = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.rs')) rust.push(fs.readFileSync(p, 'utf8'));
  }
})(rustDir);
/* التعليقات تُجرَّد قبل المطابقة: رقم في تعليق ليس دليلاً على وجود منفذ.
   (العيب المُقاس: «9191» كان يمرّ لأن «91910» ورد في تعليق.) */
const rustAll = rust.join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
/** هل الرقم رمزٌ كامل في الكود — لا بادئةً لرقم أطول ولا جزءاً من اسم؟ */
function portDeclared(port) {
  return new RegExp('(^|[^0-9A-Za-z_])' + port + '($|[^0-9A-Za-z_])').test(rustAll);
}

const htmlFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/assets/.test(p)) walk(p); }
    else if (e.name.endsWith('.html')) htmlFiles.push(p);
  }
})(docsDir);
if (htmlFiles.length === 0) {
  die('صفر صفحة HTML في ' + docsDir + ' — لا شيء يُفحص، فلا يجوز إعلان النجاح.');
}

for (const f of htmlFiles) {
  const t = fs.readFileSync(f, 'utf8');
  const rel = path.relative(docsDir, f).replace(/\\/g, '/');
  // أي منفذ مذكور في الموقع يجب أن يوجد في كود Rust
  for (const m of t.matchAll(/localhost:(\d{2,5})|127\.0\.0\.1:(\d{2,5})/g)) {
    const port = m[1] || m[2];
    if (!portDeclared(port)) {
      problems.push(rel + ': يذكر المنفذ ' + port + ' وهو غير موجود في كود src-tauri');
    }
  }
  // منصّات لا يدعمها المنتج (SITE.md: ويندوز 10/11 x64 فقط)
  for (const os of ['Apple M-Series', 'macOS', 'Linux desktop']) {
    if (t.includes(os)) problems.push(rel + ': يدّعي منصّة غير مدعومة — «' + os + '»');
  }
}

/* ── القاعدة 4: شارة إصدار ثابتة ──
   صفحة تعرض رقماً مكتوباً في HTML لا يواكب النشر القادم. الرقم يجب أن يحمل
   صنف js-release-tag (يمزنه سكربت من نفس مصدر الرئيسية) أو data-version-fallback. */
for (const f of htmlFiles) {
  const t = fs.readFileSync(f, 'utf8');
  const rel = path.relative(docsDir, f).replace(/\\/g, '/');
  if (rel === 'index.html') continue;   // الرئيسية تملك السكربت والوسوم أصلاً
  for (const m of t.matchAll(/<span[^>]*>\s*v?\d+\.\d+\.\d+\s*<\/span>/g)) {
    if (/js-release-tag|data-version-fallback/.test(m[0])) continue;
    problems.push(rel + ': شارة إصدار ثابتة بلا js-release-tag — «' + m[0].replace(/<[^>]+>/g, '').trim() + '»');
  }
}

/* ── القاعدة 5: الحكم على العتاد نيابة عن الزائر ──
   ذكر «Intel Core i5» كشرط نظام مشروع. الخطأ الذي وقع فعلاً هو «GPU: RTX 4070
   READY» — حالة تُنسب إلى جهاز الزائر، ولا سبيل لموقع وثائقي أن يعرفها.
   فنبحث عن نمط الحالة لا عن اسم الطراز، ونتجاهل مسارات SVG (إحداثياتها تبدأ
   بحرف M مثل أسماء شرائح آبل). */
const HARDWARE_CLAIM = /\b(?:GPU|VRAM|RAM|CPU)\s*[:=]\s*[A-Za-z0-9][\w .-]{0,24}(?:READY|ACTIVE|DETECTED|OK|100%|GB)/i;
for (const f of htmlFiles) {
  const t = fs.readFileSync(f, 'utf8');
  const rel = path.relative(docsDir, f).replace(/\\/g, '/');
  const m = t.match(HARDWARE_CLAIM);
  if (m) problems.push(rel + ': حالة عتاد تُنسب إلى جهاز الزائر — «' + m[0].trim() + '»');
}

console.log('  حارس الروابط والادّعاءات: ' + htmlFiles.length + ' صفحة · ' + guideFiles.length + ' دليل');
if (problems.length) {
  console.error('  ✗ ' + problems.length + ' ملاحظة:');
  [...new Set(problems)].forEach(p => console.error('     - ' + p));
  process.exit(1);
}
console.log('  ✓ لا بطاقة محتوى تشير إلى الرئيسية · لا وجهة مفقودة · لا ادّعاء منفذ أو منصّة أو عتاد · لا شارة إصدار ثابتة');
