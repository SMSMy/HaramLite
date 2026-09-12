#!/usr/bin/env node
/* حارس بناء CSS.
   السبب: ثلاث مرات استُبدل مفتاح كامل في إعداد Tailwind بدل دمجه، فاختفت أصناف
   خطوط أو تغيّر لون صفحة الإضافة بصمت — ولم يظهر ذلك إلا بلقطة المستخدم.
   المنطق: Tailwind يحذف الأصناف غير المستخدمة، فلا نطالب بكل الرموز، بل بكل
   صنف خطّ **مستخدم فعلاً** في صفحات الموقع + رموز الألوان الحرجة + ملفات الخطوط. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cfg = require(path.join(root, 'site.tailwind.config.cjs'));
const css = fs.readFileSync(path.join(root, 'docs/assets/site.css'), 'utf8');
const ok = [];
const fails = [];

// Tailwind يجمع المحدِّدات أحياناً: «‎.a,.b{…}» — فيكفي أن يتبع الاسم فاصلة أو قوس أو نقطتان.
// (فحص نصّي بسيط بدل تعبير نمطي: التهريب داخل سكربتات البناء أفسد الفحص مرتين.)
function hasClass(name) {
  for (const ch of [',', '{', ':']) {
    if (css.includes(name + ch)) return true;
  }
  return false;
}

// ── ١) أصناف الخطوط المستخدمة فعلاً في صفحات الموقع ─────────────────────────
const contentFiles = ['docs/index.html', 'docs/bridge.html', 'docs/PRIVACY.html', 'docs/404.html']
  .concat(fs.readdirSync(path.join(root, 'docs/guides')).filter(f => f.endsWith('.html')).map(f => 'docs/guides/' + f));

const used = new Set();
for (const rel of contentFiles) {
  const t = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const m of t.matchAll(/font-([a-z0-9-]+)/g)) used.add(m[1]);
}
const fontKeys = Object.keys(cfg.theme.extend.fontFamily || {});
for (const k of used) {
  if (!fontKeys.includes(k)) continue;                 // ليس رمز خطّ في الإعداد (مثل font-bold)
  if (hasClass('.font-' + k)) ok.push('.font-' + k);
  else fails.push(`صنف خطّ مستخدم لكنه غير مولَّد: .font-${k} ⇒ النصّ سيسقط إلى خطّ النظام`);
}
if (used.size === 0) fails.push('لم أقرأ أي صنف خطّ من الصفحات (خطأ في الحارس نفسه)');

// ── ٢) الخطوط المحلية: الملفات موجودة ومسنَدة ───────────────────────────────
for (const m of css.matchAll(/url\(([^)]+\.woff2)\)/g)) {
  const f = path.join(root, 'docs/assets', m[1]);
  if (fs.existsSync(f)) ok.push(m[1] + ' (' + Math.round(fs.statSync(f).size / 1024) + 'KB)');
  else fails.push('ملف خطّ مفقود: docs/assets/' + m[1]);
}
for (const fam of ['Thmanyah Sans', 'Thmanyah Serif Display']) {
  if (css.includes(fam)) ok.push('مُسنَد: ' + fam);
  else fails.push('خطّ غير مسنَد في CSS: ' + fam);
}

// ── ٣) رموز ألوان حرجة: لا تتغيّر بصمت بفعل دمج خاطئ ────────────────────────
const must = [
  ['clay.hover', () => cfg.theme.extend.colors.clay.hover, '#ea8361'],
  ['clay.DEFAULT', () => cfg.theme.extend.colors.clay.DEFAULT, '#da7756'],
  ['coal.900', () => cfg.theme.extend.colors.coal[900], '#151311'],
  ['cream.muted', () => cfg.theme.extend.colors.cream.muted, '#a38c85'],
];
for (const [label, get, expected] of must) {
  const actual = String(get()).toLowerCase();
  if (actual === expected) ok.push(label + '=' + actual);
  else fails.push(`رمز تغيّر: ${label} = ${actual} (المتوقّع ${expected})`);
}

// ── ٤) أصناف التصميم التي تعتمد عليها صفحات الأدلة والبطاقات ────────────────
for (const cls of ['.bg-coal-card', '.border-coal-border', '.text-cream-muted', '.entry-card__front', '.border-glow-clay']) {
  if (hasClass(cls)) ok.push(cls);
  else fails.push('صنف مفقود: ' + cls);
}

console.log(`  حارس CSS: ${ok.length} فحصاً ناجحاً`);
if (fails.length) {
  console.error('  ✗ فشل الحارس (' + fails.length + '):');
  fails.forEach(f => console.error('     - ' + f));
  process.exit(1);
}
console.log('  ✓ الخطوط والألوان والأصناف سليمة');
