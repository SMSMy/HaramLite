#!/usr/bin/env node
/* حارس بناء CSS.
   السبب: ثلاث مرات استُبدل مفتاح كامل في إعداد Tailwind بدل دمجه، فاختفت أصناف
   خطوط أو تغيّر لون صفحة الإضافة بصمت — ولم يظهر ذلك إلا بلقطة المستخدم.
   المنطق: Tailwind يحذف الأصناف غير المستخدمة، فلا نطالب بكل الرموز، بل بكل
   صنف خطّ **مستخدم فعلاً** في صفحات الموقع + رموز الألوان الحرجة + ملفات الخطوط.

   ── تحصين هذه الجولة ──
   العيب المُقاس: إسقاط فرع لوني كامل (`clay: undefined`) كان يُنتج
   `TypeError: Cannot read properties of undefined (reading 'hover')` عند سطر
   الرموز الحرجة، **فيموت الحارس بانهيار** بدل أن يسمّي الرمز المفقود — وهو
   بالضبط العطل الذي وُجد الحارس من أجله. الآن كل وصول رمزي يمرّ بـ`pick()`
   فيُسمّى **الفرع الغائب**، والوصول يستمر فلا يُخفي عيباً آخر خلفه.
   وكذلك: بنية ناقصة (docs/ · site.css · الإعداد · مجلد الأدلة) ⇒ فشل مسمّى لا
   stack trace.

   الاستعمال: node scripts/check-site-css.cjs [--root <dir>] */
const fs = require('fs');
const path = require('path');

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
const ok = [];
const fails = [];

function die(msg) {
  console.error('✗ حارس CSS: ' + msg);
  process.exit(1);
}

/* البنية أولاً: غياب أي مدخل ⇒ فشل مسمّى، لا انهيار ولا نجاح صامت. */
const cfgPath = path.join(root, 'site.tailwind.config.cjs');
const cssPath = path.join(root, 'docs/assets/site.css');
for (const [p, label] of [[path.join(root, 'docs'), 'docs/'],
                           [path.join(root, 'docs/guides'), 'docs/guides/'],
                           [cssPath, 'docs/assets/site.css'],
                           [cfgPath, 'site.tailwind.config.cjs']]) {
  if (!fs.existsSync(p)) die('بنية غير صالحة: ' + label + ' غير موجود عند ' + p);
}

let cfg;
try {
  cfg = require(cfgPath);
} catch (e) {
  die('تعذّر تحميل site.tailwind.config.cjs — ' + e.message);
}
const css = fs.readFileSync(cssPath, 'utf8');

/* وصول آمن إلى رمز متداخل: يُرجع الفرع الغائب بدل أن يرمي TypeError.
   العيب الذي وُلد هذا الحارس له هو إسقاط فرع لوني كامل، فالفشل هنا يجب أن
   **يسمّي الفرع** لا أن يُسقط العملية. */
function pick(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || typeof cur !== 'object' || !(parts[i] in cur)) {
      return { ok: false, missingAt: parts.slice(0, i + 1).join('.'), at: parts[i] };
    }
    cur = cur[parts[i]];
  }
  return { ok: true, value: cur };
}

// Tailwind يجمع المحدِّدات أحياناً: «‎.a,.b{…}» — فيكفي أن يتبع الاسم فاصلة أو قوس أو نقطتان.
// (فحص نصّي بسيط بدل تعبير نمطي: التهريب داخل سكربتات البناء أفسد الفحص مرتين.)
function hasClass(name) {
  for (const ch of [',', '{', ':']) {
    if (css.includes(name + ch)) return true;
  }
  return false;
}

// ── ١) أصناف الخطوط المستخدمة فعلاً في صفحات الموقع ─────────────────────────
const ROOT_PAGES = ['docs/index.html', 'docs/bridge.html', 'docs/PRIVACY.html', 'docs/bridge-privacy.html', 'docs/TRANSPARENCY.html', 'docs/404.html'];
for (const rel of ROOT_PAGES) {
  if (!fs.existsSync(path.join(root, rel))) die('صفحة جذرية مفقودة: ' + rel + ' (القائمة المرجعية للصفحات ناقصة)');
}
const contentFiles = ROOT_PAGES
  .concat(fs.readdirSync(path.join(root, 'docs/guides')).filter(f => f.endsWith('.html')).map(f => 'docs/guides/' + f));
if (contentFiles.length === 0) {
  die('صفر صفحة محتوى — لا شيء يُفحص، فلا يجوز إعلان النجاح.');
}

const used = new Set();
for (const rel of contentFiles) {
  const t = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const m of t.matchAll(/font-([a-z0-9-]+)/g)) used.add(m[1]);
}
const fontFam = pick(cfg, 'theme.extend.fontFamily');
if (!fontFam.ok) {
  fails.push(`فرع الخطوط مفقود: «${fontFam.missingAt}» غير موجود في site.tailwind.config.cjs ⇒ كل أصناف الخطوط تسقط إلى خطّ النظام`);
}
const fontKeys = fontFam.ok ? Object.keys(fontFam.value || {}) : [];
if (fontFam.ok && fontKeys.length === 0) {
  fails.push('فرع الخطوط موجود لكنه فارغ: theme.extend.fontFamily بلا مفاتيح');
}
for (const k of used) {
  if (!fontKeys.includes(k)) continue;                 // ليس رمز خطّ في الإعداد (مثل font-bold)
  if (hasClass('.font-' + k)) ok.push('.font-' + k);
  else fails.push(`صنف خطّ مستخدم لكنه غير مولَّد: .font-${k} ⇒ النصّ سيسقط إلى خطّ النظام`);
}
if (used.size === 0) fails.push('لم أقرأ أي صنف خطّ من الصفحات (خطأ في الحارس نفسه)');

// ── ٢) الخطوط المحلية: الملفات موجودة ومسنَدة ───────────────────────────────
let fontFileHits = 0;
for (const m of css.matchAll(/url\(([^)]+\.woff2|'([^']+\.woff2)'|"([^"]+\.woff2)")\)/g)) {
  const name = (m[1] || '').replace(/['"]/g, '');
  const f = path.join(root, 'docs/assets', name);
  fontFileHits++;
  if (fs.existsSync(f)) ok.push(name + ' (' + Math.round(fs.statSync(f).size / 1024) + 'KB)');
  else fails.push('ملف خطّ مفقود: docs/assets/' + name);
}
if (fontFileHits === 0) {
  fails.push('لا مرجع خطّ محلّي (url(…woff2)) في docs/assets/site.css ⇒ الملف فارغ أو أُعيد توليده بلا خطوط');
}
for (const fam of ['Thmanyah Sans', 'Thmanyah Serif Display']) {
  if (css.includes(fam)) ok.push('مُسنَد: ' + fam);
  else fails.push('خطّ غير مسنَد في CSS: ' + fam);
}

// ── ٣) رموز ألوان حرجة: لا تتغيّر بصمت بفعل دمج خاطئ ────────────────────────
// كل صفّ: [التسمية المعروضة · المسار الكامل في الإعداد · المتوقّع].
// الوصول عبر pick() ⇒ الفرع الغائب يُسمّى، ولا انهيار يحجب بقية الفحص.
const must = [
  ['clay.hover', 'theme.extend.colors.clay.hover', '#ea8361'],
  ['clay.DEFAULT', 'theme.extend.colors.clay.DEFAULT', '#da7756'],
  ['coal.900', 'theme.extend.colors.coal.900', '#151311'],
  ['cream.muted', 'theme.extend.colors.cream.muted', '#a38c85'],
];
for (const [label, dotted, expected] of must) {
  const r = pick(cfg, dotted);
  if (!r.ok) {
    // يُسمّى **الرمز الغائب نفسه** (clay) لا أبوه: العطل الواقع هو إسقاط فرع كامل.
    fails.push(`رمز مفقود: ${label} — «${r.missingAt}» غير موجود في site.tailwind.config.cjs (فرع لوني أُسقط أو أُعيد تسميته بدل دمجه)`);
    continue;
  }
  const actual = String(r.value).toLowerCase();
  if (actual === expected) ok.push(label + '=' + actual);
  else fails.push(`رمز تغيّر: ${label} = ${actual} (المتوقّع ${expected})`);
}

// ── ٤) أصناف التصميم التي تعتمد عليها صفحات الأدلة والبطاقات ────────────────
for (const cls of ['.bg-coal-card', '.border-coal-border', '.text-cream-muted', '.entry-card__front', '.border-glow-clay']) {
  if (hasClass(cls)) ok.push(cls);
  else fails.push('صنف مفقود: ' + cls);
}

// ── ٥) الأيقونات: كل أيقونة مستخدمة يجب أن تكون في المجموعة المضغوطة ────────
// (سبب الإضافة: أيقونات جديدة ظهرت كنصّ «GRAPHIC_EQ» ومربّعات فارغة لأن ملف
//  الأيقونات قُلّص قبل إضافتها، ولم يكتشف ذلك إلا بلقطة المستخدم.)
const iconList = path.join(root, 'docs/assets/icons-subset.txt');
if (!fs.existsSync(iconList)) {
  fails.push('ملف قائمة الأيقونات مفقود: docs/assets/icons-subset.txt');
} else {
  const available = new Set(fs.readFileSync(iconList, 'utf8').split(/\s+/).filter(Boolean));
  if (available.size === 0) fails.push('قائمة الأيقونات فارغة: docs/assets/icons-subset.txt بلا أي رمز');
  const usedIcons = new Set();
  for (const rel of contentFiles) {
    const t = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of t.matchAll(/material-symbols-outlined[^>]*>\s*([a-z_0-9]+)\s*</g)) usedIcons.add(m[1]);
    // صنف ثانٍ يعرض خط الأيقونات نفسه (بطاقات المداخل): مسحه واجب وإلا نكّر
    // عطل widgets — أيقونة مستخدمة غائبة عن الخط المضغوط لا يراها الفحص.
    for (const m of t.matchAll(/entry-card__icon[^>]*>\s*([a-z_0-9]+)\s*</g)) usedIcons.add(m[1]);
  }
  const missing = [...usedIcons].filter(i => !available.has(i));
  if (missing.length) fails.push('أيقونات مستخدمة وغير موجودة في الخط المضغوط: ' + missing.join(' · ') + ' ⇒ ستظهر كنصّ أو مربّع فارغ');
  else ok.push('الأيقونات: ' + usedIcons.size + ' مستخدمة وكلها متوفّرة');
}

console.log(`  حارس CSS: ${ok.length} فحصاً ناجحاً`);
if (fails.length) {
  console.error('  ✗ فشل الحارس (' + fails.length + '):');
  fails.forEach(f => console.error('     - ' + f));
  process.exit(1);
}
console.log('  ✓ الخطوط والألوان والأصناف والأيقونات سليمة');
