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
   الاستعمال: node scripts/check-site-links.cjs */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const guidesDir = path.join(root, 'docs/guides');
const problems = [];

/* ── القاعدة 1: بطاقات داخل المحتوى تشير إلى الرئيسية ── */
const CONTENT_CARD = /<a\b[^>]*class="[^"]*(rounded-xl|rounded-lg)[^"]*"[^>]*href="\.\.\/"[^>]*>/g;
/* أزرار الإجراء المشروعة التي تذهب إلى الرئيسية عن قصد: «البناء من المصدر»
   و«مستودع GitHub» و«الإبلاغ عن مشكلة» أهدافها أقسام في الصفحة الرئيسية،
   لا مقالات. تُستثنى بنصّها لا بمظهرها. */
const INTENTIONAL_CTA = /(CLI ومستودع GitHub|البناء من المصدر|مستودع GitHub|الإبلاغ عن مشكلة|Star|نجمة)/;
for (const f of fs.readdirSync(guidesDir).filter(x => x.endsWith('.html'))) {
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

/* ── القاعدة 2: data-path بلا صفحة تقابله ── */
const pages = fs.readdirSync(guidesDir).filter(x => x.endsWith('.html'));
/* وجهات مشروعة: أقسام الرئيسية، وصفحات الجذر، وفهرس الأدلة نفسه */
const ROOT_DESTS = ['../bridge.html', '../PRIVACY.html', '../#dev', '../#download',
  '../#features', '../#privacy', '../#whatsnew', '../#start', '../#', './', './index.html'];
const NAV_DATA_PATHS = new Set(['home', 'guides', 'download', 'features', 'whats-new',
  'privacy', 'developers', 'browser-extension', 'docs']);
for (const f of fs.readdirSync(guidesDir).filter(x => x.endsWith('.html'))) {
  const t = fs.readFileSync(path.join(guidesDir, f), 'utf8');
  for (const m of t.matchAll(/data-path="([^"]+)"\s+href="([^"]*)"/g)) {
    const [, dp, href] = m;
    if (/^https?:/.test(href) || href.startsWith('#')) continue;
    if (ROOT_DESTS.includes(href)) continue;
    if (href.endsWith('.html') && pages.includes(path.basename(href))) continue;
    // مسارات التنقّل المعروفة تُقبل كما هي (home → ../  ·  guides → ./)
    if (NAV_DATA_PATHS.has(dp) && (href === '../' || href === './')) continue;
    if (href === '../') {
      problems.push('guides/' + f + ' data-path="' + dp + '" يشير إلى الرئيسية بلا مرساة');
    } else if (!pages.includes(path.basename(href))) {
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
})(path.join(root, 'src-tauri/src'));
const rustAll = rust.join('\n');

const htmlFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/assets/.test(p)) walk(p); }
    else if (e.name.endsWith('.html')) htmlFiles.push(p);
  }
})(path.join(root, 'docs'));

for (const f of htmlFiles) {
  const t = fs.readFileSync(f, 'utf8');
  const rel = path.relative(path.join(root, 'docs'), f).replace(/\\/g, '/');
  // أي منفذ مذكور في الموقع يجب أن يوجد في كود Rust
  for (const m of t.matchAll(/localhost:(\d{2,5})|127\.0\.0\.1:(\d{2,5})/g)) {
    const port = m[1] || m[2];
    if (!rustAll.includes(port)) {
      problems.push(rel + ': يذكر المنفذ ' + port + ' وهو غير موجود في كود src-tauri');
    }
  }
  // منصّات لا يدعمها المنتج (SITE.md: ويندوز 10/11 x64 فقط)
  for (const os of ['Apple M-Series', 'macOS', 'Linux desktop']) {
    if (t.includes(os)) problems.push(rel + ': يدّعي منصّة غير مدعومة — «' + os + '»');
  }
}

console.log('  حارس الروابط والادّعاءات: ' + htmlFiles.length + ' صفحة');
if (problems.length) {
  console.error('  ✗ ' + problems.length + ' ملاحظة:');
  [...new Set(problems)].forEach(p => console.error('     - ' + p));
  process.exit(1);
}
console.log('  ✓ لا بطاقة محتوى تشير إلى الرئيسية، ولا وجهة مفقودة، ولا ادّعاء منفذ أو منصّة باطل');
