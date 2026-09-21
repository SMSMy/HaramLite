#!/usr/bin/env node
/* مُفسَدات حارس التعريب — node scripts/check-extension-i18n-mutants.cjs
 *
 * القاعدة التي يحرسها هذا الملف: **كل مُفسَد يجب أن يُسقط الحارس**، و**كل ضابط
 * يجب أن يمرّ**. ومُفسَد يمرّ = ثقب مؤكَّد في الحارس لا ملاحظة.
 *
 * وكل شيء **في الذاكرة**: لا ملف مؤقت ولا عملية فرعية ولا كتابة على القرص. ودليل
 * أن المُفسَد طُبِّق فعلاً (لا أنه صفر تغيير فيمرّ عبثاً) بصمة SHA256 للنصّ
 * المُفسَد تُقارن ببصمة الأصل، **وبصمة الأصل تُعاد قياسها في النهاية** لتُثبت أن
 * شيئاً من هذا لم يمسّ `content.js`.
 *
 * والمُفسَدات:
 *   ① نصّ عربي خام خارج الجدول (`toast('نصّ عربي خام')`) ⇒ يسقط.
 *   ② مفتاح موجود في `ar` وغائب من `en` ⇒ يسقط.
 *   ③ قيمة إنجليزية فارغة ⇒ يسقط.
 *   ④ مفتاح محسوب في نداء `t(` (يخالف §٢٦ ويُخفي النصّ) ⇒ يسقط.
 *   ⑤ مفتاح مكرَّر داخل القسم ⇒ يسقط.
 *   ⑥ عربية **مُخفيّة بلا نصّ حرفيّ**: من `String.fromCharCode` ⇒ يسقط (المرشّح
 *      النصّي وحده لا يراها، والفحص ⑩ هو الذي يمسكها).
 *   ⑦ عربية مجزّأة بقالب نصّي + متغيّر ⇒ يسقط.
 *   ⑧ عربية مفكوكة بالمفتاح `\u0600` ⇒ يسقط (المُحلِّل يفكّ الهروب فيقيس المحرف).
 *   ⑨ القيم `ar` كلها إنجليزية (جدول مُفرَّغ من العربية) ⇒ يسقط.
 *   ض١ **تعليق يحمل عربية** ⇒ **يمرّ** (لا مُفسَد بل ضابط: الحارس لا يحكم على
 *      التعليقات، ولو أسقطها لحكم على ٢٢٠ سطراً منها في الملف نفسه).
 *   ض٢ شيفرة **قبل التعريب** محفوظة في ARCHIVE؟ لا — تُمرَّر بمسار `--before`
 *      اختياري: نسخة `content.js` قبل هذه الجولة يجب أن **تُسقط** الحارس.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const FILE = path.join(REPO, 'browser-extension', 'content.js');
const { audit } = require('./check-extension-i18n.cjs');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase();

const argv = process.argv.slice(2);
let beforeArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--before') {
    if (argv[i + 1] === undefined) { console.error('✗ العلم --before يحتاج مساراً'); process.exit(2); }
    beforeArg = argv[++i];
  } else { console.error('✗ وسيط غير معروف: ' + argv[i]); process.exit(2); }
}

const base = fs.readFileSync(FILE, 'utf8');
const baseSha = sha256(base);
console.log('حاكم مُفسَدات التعريب · الهدف: browser-extension/content.js');
console.log('بصمة الأصل SHA256: ' + baseSha);
console.log('بصمة الملف على القرص مطابقة للنصّ المقروء: ' + (sha256(fs.readFileSync(FILE, 'utf8')) === baseSha));

/* ── الضابط الأوّل: الحارس أخضر على الملف المشحون ─────────────────────────── */
const clean = audit(base, 'content.js');
if (clean.failures.length) {
  console.error('✗ الحارس أحمر على الملف المشحون أصلاً — لا معنى لقياس المُفسَدات قبل إصلاحه.');
  clean.failures.forEach((f) => console.error('   ' + f));
  process.exit(2);
}
console.log('الحارس على الملف المشحون: ' + clean.checks + ' فحصاً · 0 فاشل · المدخل المقيس ' +
  clean.counts.tableAr + ' نصّاً عربياً في الجدول\n');

/* ── المُفسَدات والضوابط ──────────────────────────────────────────────────── */
const CASES = [
  ['① نصّ عربي خام خارج الجدول: toast(\'نصّ عربي خام\')',
    (s) => s.replace("    toast(t('cancel.done'));",
      "    toast('نصّ عربي خام');"), 'fall'],

  ['② مفتاح في ar غائب من en',
    (s) => s.replace("      'cancel.done': '⏹ Processing cancelled — press to start again',\n", ''), 'fall'],

  ['③ قيمة إنجليزية فارغة',
    (s) => s.replace("      'fetch.failed': 'Fetch failed',", "      'fetch.failed': '',"), 'fall'],

  ['④ مفتاح محسوب في نداء t( (يخالف §٢٦)',
    (s) => s.replace("    toast(t('cancel.done'));",
      "    const k = 'cancel.done';\n    toast(t(k));"), 'fall'],

  ['⑤ مفتاح مكرَّر داخل قسم ar (يُسقط المتقدّم صامتاً)',
    (s) => s.replace("      'cancel.done': '⏹ أُلغيت المعالجة — اضغط للبدء من جديد',",
      "      'cancel.done': 'أول',\n      'cancel.done': '⏹ أُلغيت المعالجة — اضغط للبدء من جديد',"), 'fall'],

  ['⑥ عربية بلا نصّ حرفيّ: String.fromCharCode(0x639) داخل toast',
    (s) => s.replace("    toast(t('cancel.done'));",
      "    toast(String.fromCharCode(0x639, 0x634));"), 'fall'],

  ['⑦ عربية مجزّأة بقالب نصّي: `نصّ` + متغيّر',
    (s) => s.replace("    toast(t('cancel.done'));",
      "    const x = '!';\n    toast(`نصّ عربي خام ${x}`);"), 'fall'],

  ['⑧ عربية مفكوكة بالمفتاح \\u0600 (الهروب لا يُخفيها)',
    (s) => s.replace("    toast(t('cancel.done'));",
      "    toast('\\u0646\\u0635 \\u0639\\u0631\\u0628\\u064a');"), 'fall'],

  ['⑨ كل قيم ar إنجليزية (جدول مُفرَّغ من العربية)',
    (s) => {
      const i = s.indexOf('    ar: {');
      const j = s.indexOf('    en: {');
      if (i < 0 || j < 0) return s;
      return s.slice(0, i) + s.slice(i, j).replace(/[\u0600-\u06FF]/g, 'x') + s.slice(j);
    }, 'fall'],

  ['⑩ قيمة ar بلا أيّ محرف عربي (نقل خاطئ)',
    (s) => s.replace("      'fetch.failed': 'تعذر الجلب',", "      'fetch.failed': 'Fetch failed',"), 'fall'],

  /* ── ضوابط: يجب أن تمرّ ─────────────────────────────────────────────────── */
  ['ض١ تعليق يحمل عربية (لا يُعدّ نصّ واجهة) — يجب ألّا يُسقط',
    (s) => s.replace("  /* ── fading toast ─",
      "  // تعليق جديد فيه نصّ عربي خام: عالج هذا الفيديو\n  /* ── fading toast ─"), 'pass'],

  ['ض٢ نصّ إنجليزي خام خارج الجدول (المرشّح الواسع لا يراه) — يجب ألّا يُسقط',
    (s) => s.replace("    toast(t('cancel.done'));",
      "    toast('raw english ui text');"), 'pass'],

  ['ض٣ إضافة مفتاح في اللغتين معاً — يجب ألّا يُسقط',
    (s) => s.replace("      'cancel.done': '⏹ أُلغيت المعالجة — اضغط للبدء من جديد',",
      "      'cancel.done': '⏹ أُلغيت المعالجة — اضغط للبدء من جديد',\n      'extra.new': 'نصّ جديد',")
      .replace("      'cancel.done': '⏹ Processing cancelled — press to start again',",
        "      'cancel.done': '⏹ Processing cancelled — press to start again',\n      'extra.new': 'New text',"), 'pass'],
];

let caught = 0, survived = 0, passed = 0, badPass = 0, skipped = 0;
const holes = [], regressions = [];

console.log('  الحالة                                                  | متوقّع | النتيجة');
console.log('  ' + '-'.repeat(96));
for (const [label, fn, want] of CASES) {
  let mut;
  try { mut = fn(base); } catch (e) { mut = base; }
  if (mut === base) {
    // تغيير لم يُطبَّق = لا قياس. يُسقط الحاكم (لا يُتخطّى بصمت).
    skipped++;
    console.log('  ⚠ لم يُطبَّق  ' + label);
    continue;
  }
  const mSha = sha256(mut);
  const r = audit(mut, 'content.js');
  const fell = r.failures.length > 0;
  if (want === 'fall') {
    if (fell) {
      caught++;
      console.log('  ✅ سقط    ' + label.slice(0, 52).padEnd(52) + ' | سقوط   | ' + r.failures.length + ' ملاحظة');
      console.log('       ↳ بصمة المُفسَد: ' + mSha.slice(0, 16) + '… (≠ الأصل ✓)');
      r.failures.forEach((f) => console.log('       ↳ ' + f.replace(/\s+/g, ' ').slice(0, 220)));
    } else {
      survived++; holes.push(label);
      console.log('  ❌ مرّ     ' + label.slice(0, 52).padEnd(52) + ' | سقوط   | ثقب في الحارس');
    }
  } else {
    if (!fell) {
      passed++;
      console.log('  ✅ مرّ     ' + label.slice(0, 52).padEnd(52) + ' | مرور   | ' + r.checks + ' فحصاً · 0 فاشل');
      console.log('       ↳ بصمة المُفسَد: ' + mSha.slice(0, 16) + '… (≠ الأصل ✓)');
    } else {
      badPass++; regressions.push(label);
      console.log('  ❌ سقط     ' + label.slice(0, 52).padEnd(52) + ' | مرور   | اصطياد كاذب');
      r.failures.forEach((f) => console.log('       ↳ ' + f.replace(/\s+/g, ' ').slice(0, 220)));
    }
  }
}

/* ── حالة «الشيفرة قبل التعريب»: تُقاس من نسخة محفوظة خارج الشجرة ──────────── */
if (beforeArg) {
  const p = path.resolve(beforeArg);
  if (!fs.existsSync(p)) {
    console.error('✗ --before: الملف غير موجود عند ' + p);
    process.exit(1);
  }
  const before = fs.readFileSync(p, 'utf8');
  const bSha = sha256(before);
  console.log('\n── حالة «الشيفرة قبل التعريب» ──');
  console.log('  الملف: ' + p);
  console.log('  SHA256: ' + bSha + (bSha === baseSha ? '  ⚠ مطابق للأصل — ليست نسخة قبل التعريب!' : '  (≠ الأصل ✓)'));
  const rb = audit(before, path.basename(p));
  const fell = rb.failures.length > 0;
  if (fell) {
    caught++;
    console.log('  ✅ سقط    الشيفرة قبل التعريب                              | سقوط   | ' + rb.failures.length + ' ملاحظة');
    rb.failures.forEach((f) => console.log('       ↳ ' + f.replace(/\s+/g, ' ').slice(0, 300)));
  } else {
    survived++; holes.push('الشيفرة قبل التعريب');
    console.log('  ❌ مرّ     الشيفرة قبل التعريب — الحارس لا يرى العطب الأصلي');
  }
} else {
  console.log('\n  ⚠ --before غير مُمرَّر: حالة «الشيفرة قبل التعريب» **لم تُقَس**.');
}

/* ── إثبات أن القرص لم يُمَسّ ─────────────────────────────────────────────── */
const afterSha = sha256(fs.readFileSync(FILE, 'utf8'));
console.log('\nبصمة content.js بعد كل المُفسَدات: ' + afterSha);
console.log('عادت كما كانت (لم يُمَسّ الملف): ' + (afterSha === baseSha ? '✓ نعم' : '✗ لا'));

const total = caught + survived + badPass + passed;
console.log('\nالحصيلة: أسقط ' + caught + ' · مرّ ضابطاً ' + passed + ' · ثقوب ' + survived +
  ' · اصطياد كاذب ' + badPass + ' · لم يُطبَّق ' + skipped);

let bad = false;
if (afterSha !== baseSha) { console.error('✗ الملف تغيّر على القرص — القياس غير صالح'); bad = true; }
if (skipped) { console.error('✗ ' + skipped + ' مُفسَداً لم يُطبَّق (نمط الاستبدال لا يطابق) — قياس ناقص'); bad = true; }
if (survived) { console.error('✗ ثقوب مؤكَّدة (مُفسَد مرّ من الحارس):'); holes.forEach((h) => console.error('   - ' + h)); bad = true; }
if (badPass) { console.error('✗ اصطياد كاذب (ضابط سقط):'); regressions.forEach((h) => console.error('   - ' + h)); bad = true; }
if (total === 0) { console.error('✗ صفر حالة مُطبَّقة — لا شيء قيس'); bad = true; }
if (bad) process.exit(1);
console.log('✓ لا ثقب: كل مُفسَد أسقط الحارس، وكل ضابط مرّ، والملف على القرص لم يُمَسّ.');
