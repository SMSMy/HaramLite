#!/usr/bin/env node
/* رافع الإصدار — يكتب الإصدار في الملفات الأربعة التي يفرضها حارس الإصدار
 * (`pnpm versions:check`)، ويطبع ما يجب تعديله يدوياً في الموقع (لا يلمسه).
 *
 * الاستعمال: node scripts/bump-version.cjs 0.2.4 [--root <dir>]
 *
 * لا يلمس `browser-extension/manifest.json`: للإضافة دورة نشر مستقلة في متجر
 * كروم (‏1.1.x) ولا تُساوى بإصدار التطبيق.
 *
 * ── تحصين هذه الجولة (عيبان مُقاسان، أُعيد إنتاجهما) ────────────────────────
 * ① **كتابة غير ذرّية بلا نسخة احتياطية**: كان يكتب الملفات واحداً واحداً
 *    بـ`writeFileSync` مباشرةً على ملفات **متتبَّعة**. عند EPERM على الملف
 *    الثالث (مُحاكى بقفل `Cargo.toml`) وقع بالقياس: `package.json` و
 *    `tauri.conf.json` صارا `0.2.1` و`Cargo.toml` و`Cargo.lock` بقيا `0.2.0`
 *    ⇒ **شجرة نصف مرتفعة**، **و0 نسخة احتياطية**، والعملية ماتت بانهيار غير
 *    مسمّى. الآن: تُخطَّط الكتابات كلها أولاً، ثم تُكتب كلها إلى ملفات مؤقتة
 *    وتُستبدل بـ`rename` (ذرّي على نفس القسم)، مع نسخة احتياطية لكل ملف قبل
 *    لمسه؛ وأي فشل ⇒ **استرجاع كامل** ورسالة مسمّاة وexit 1.
 * ② **لا-عمل صامت في مسار `Cargo.lock`**: كان `done = true` يُضبط حتى إن لم
 *    تُطابق regex شيئاً ولا استُبدل حرف. بقفل `0.2.0-beta.1` وقع بالقياس:
 *    «تم رفع الإصدار» و exit 0 **والقفل بلا تغيير** ⇒ إصدار موحّد كاذب يمرّ من
 *    حارس الإصدار لاحقاً. الآن: كتلة `haramlite-rs` تُقرأ صراحةً، وإصدارها إن
 *    لم يطابق `x.y.z` ⇒ **فشل يسمّي الإصدار المخالف**، ولا يُكتب أي ملف.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ── الوسائط ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
let next = null, rootArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      console.error('✗ العلم --root يحتاج مساراً.');
      process.exit(2);
    }
    rootArg = argv[++i];
  } else if (next === null) {
    next = argv[i];
  } else {
    console.error('✗ وسيط غير معروف: ' + argv[i] + ' — الاستعمال: node scripts/bump-version.cjs x.y.z [--root <dir>]');
    process.exit(2);
  }
}
const root = rootArg ? path.resolve(rootArg) : path.resolve(__dirname, '..');

if (!/^\d+\.\d+\.\d+$/.test(next || '')) {
  console.error('✗ مرّر إصداراً صحيحاً بالصيغة x.y.z — مثال: node scripts/bump-version.cjs 0.2.4');
  process.exit(2);
}

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

/* ── ١) مرحلة التخطيط: لا يُكتب شيء قبل أن تُخطَّط الملفات الأربعة كلها ────── */
const plan = [];   // [{ rel, before, after, was }]

function planRegex(rel, re, label) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) die('ملف مفقود: ' + rel + ' (' + label + ')');
  const before = fs.readFileSync(p, 'utf8');
  const m = before.match(re);
  if (!m) die('لم أجد الإصدار في ' + rel + ' (' + label + ')');
  const was = m[1];
  const after = was === next ? before : before.replace(re, (s) => s.replace(was, next));
  plan.push({ rel, before, after, was });
}

planRegex('package.json', /"version":\s*"(\d+\.\d+\.\d+)"/, 'top-level version');
planRegex('src-tauri/tauri.conf.json', /"version":\s*"(\d+\.\d+\.\d+)"/, 'top-level version');
planRegex('src-tauri/Cargo.toml', /^version\s*=\s*"(\d+\.\d+\.\d+)"/m, '[package] version');

/* Cargo.lock — كتلة haramlite-rs وحدها، وإصدارها يُقرأ صراحةً.
   (العيب ②: الإصدار ما قبل الإصدار `0.2.0-beta.1` لم يُطابق regex الكتابة
   فمرّ الأمر «ناجحاً» والقفل بلا تغيير.) */
{
  const rel = 'src-tauri/Cargo.lock';
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) die('ملف مفقود: ' + rel);
  const before = fs.readFileSync(p, 'utf8');
  const parts = before.split('[[package]]');
  let idx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (/name\s*=\s*"haramlite-rs"/.test(parts[i])) { idx = i; break; }
  }
  if (idx === -1) die('لم أجد كتلة haramlite-rs في Cargo.lock — لا شيء كُتب.');
  const vm = parts[idx].match(/version\s*=\s*"([^"]+)"/);
  if (!vm) die('كتلة haramlite-rs في Cargo.lock بلا سطر version — لا شيء كُتب.');
  const was = vm[1];
  if (!/^\d+\.\d+\.\d+$/.test(was)) {
    die('إصدار Cargo.lock لحزمة haramlite-rs هو «' + was + '» ولا يطابق الصيغة x.y.z.\n' +
        '     الكتابة عليه لكانت مرّت **صامتة** بلا تغيير مع إعلان النجاح.\n' +
        '     صحّحه (مثال: sh cargo update -p haramlite-rs) ثم أعد المحاولة. **لم يُكتب أي ملف.**');
  }
  if (was === next) {
    plan.push({ rel, before, after: before, was });
  } else {
    const replaced = parts[idx].replace(/version\s*=\s*"([^"]+)"/, (s, v) => s.replace(v, next));
    parts[idx] = replaced;
    plan.push({ rel, before, after: parts.join('[[package]]'), was });
  }
}

const changed = plan.filter((x) => x.after !== x.before);
if (changed.length === 0) {
  console.log('  الإصدار ' + next + ' مضبوط أصلاً في الملفات الأربعة — لا تغيير.');
  for (const x of plan) console.log(`    ${x.was}   ${x.rel}`);
  process.exit(0);
}

/* ── ٢) مرحلة الكتابة: نسخة احتياطية ثم ملف مؤقت ثم rename ذرّي ───────────── */
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-bump-'));
const done = [];      // [rel] التي استُبدلت فعلاً
const temps = [];     // مسارات مؤقتة للتنظيف

function restore() {
  const restored = [];
  for (const rel of done) {
    const bak = path.join(backupDir, rel);
    try { fs.copyFileSync(bak, path.join(root, rel)); restored.push(rel); } catch { /* يُبلَّغ أدناه */ }
  }
  return restored;
}
function cleanup() {
  for (const t of temps) { try { fs.unlinkSync(t); } catch { /* gone */ } }
}

let finished = false;
process.on('exit', () => { if (done.length && !finished) cleanup(); });

for (const x of changed) {
  const target = path.join(root, x.rel);
  try {
    // (أ) نسخة احتياطية **قبل** أي لمس — كانت صفراً في العيب المُقاس.
    const bak = path.join(backupDir, x.rel);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(target, bak);
    // (ب) كتابة إلى ملف مؤقت في المجلد نفسه (نفس القسم ⇒ rename ذرّي).
    const tmp = path.join(path.dirname(target), '.' + path.basename(target) + '.hltmp-' + process.pid);
    temps.push(tmp);
    fs.writeFileSync(tmp, x.after);
    // (ج) الاستبدال الذرّي.
    fs.renameSync(tmp, target);
    temps.pop();
    done.push(x.rel);
  } catch (e) {
    const restored = restore();
    cleanup();
    console.error('✗ فشلت كتابة ' + x.rel + ' — ' + (e && e.code ? e.code + ': ' : '') + (e && e.message));
    console.error('  استُرجعت من النسخة الاحتياطية: ' + (restored.length ? restored.join(' · ') : '(لا شيء)'));
    console.error('  لم تُلمس: ' + plan.filter((y) => !done.includes(y.rel)).map((y) => y.rel).join(' · '));
    console.error('  النسخ الاحتياطية محفوظة في: ' + backupDir);
    console.error('  الشجرة الآن كما كانت قبل الأمر (لا نصف رفع).');
    process.exit(1);
  }
}

finished = true;
try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* يبقى مجلد مؤقت */ }

console.log('  تم رفع الإصدار إلى ' + next + ' (كتابة ذرّية · نسخة احتياطية لكل ملف قبل لمسه):');
for (const x of plan) {
  const mark = x.after === x.before ? '(بلا تغيير)' : x.was + ' → ' + next;
  console.log(`    ${mark}   ${x.rel}`);
}
console.log('\n  يبقى يدوياً في الموقع (لا يُشتقّ من package.json):');
console.log('    docs/index.html — "softwareVersion" في JSON-LD، و HaramLiteState.version،');
console.log('    وروابط releases/tag إن أُضيفت. (حارس الموقع يستثني index.html من فحص الشارات.)');
console.log('  ثم: pnpm versions:check && pnpm site:check');
