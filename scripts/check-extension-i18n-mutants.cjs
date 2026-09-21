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

/** كتلة بموازنة أقواس مع تجاوز النصوص والتعليقات — تُعيد {end} مطلقاً. */
function blockAt(text, openIdx) {
  let depth = 0, i = openIdx;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; } i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { end: i + 1 }; }
    i++;
  }
  return null;
}

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

  /* ── الجولة الثانية: ثقوب أثبتها جاسوس مستقلّ بمُفسَدات مرّت ────────────── */
  ['⑪ قيمة إنجليزية تحمل عربية (ترجمة ناقصة)',
    (s) => s.replace("      'fetch.failed': 'Fetch failed',", "      'fetch.failed': 'تعذر الجلب',"), 'fall'],

  ['⑫ نداء t() بمفتاح غير موجود في الجدول (توست فارغ صامت)',
    (s) => s.replace("    toast(t('cancel.done'));", "    toast(t('cancel.done.typo'));"), 'fall'],

  ['⑬ عنصر نائب في en وحده ({pct} أُزيل من ar)',
    (s) => s.replace("      'btn.watch.fetchingPct': 'جارٍ الجلب… {pct}%',", "      'btn.watch.fetchingPct': 'جارٍ الجلب…',"), 'fall'],

  ['⑭ عنصر نائب في en وحده ({pct} زِيد في en)',
    (s) => s.replace("      'btn.watch.fetchingPct': 'Fetching… {pct}%',", "      'btn.watch.fetchingPct': 'Fetching… {pct}{pct}%',"), 'fall'],
  ['⑭ب عنصر نائب مختلف الرسم بين اللغتين ({s} مقابل {sec})',
    (s) => s.replace("      'watch.lineAgo': '▶ Filtered watching — audio from local processing (processed in {s}s)',",
      "      'watch.lineAgo': '▶ Filtered watching — audio from local processing (processed in {sec}s)',"), 'fall'],

  /* بناء نصّ ديناميكي — كل طريقة من العشر التي أفلتت من النسخة السابقة */
  ['⑮ atob (base64) — موضع جديد خارج القائمة',
    (s) => s.replace("    toast(t('cancel.done'));", "    toast(atob('2YbYtQ=='));"), 'fall'],
  ['⑯ decodeURIComponent — موضع جديد خارج القائمة',
    (s) => s.replace("    toast(t('cancel.done'));", "    toast(decodeURIComponent('%D9%86'));"), 'fall'],
  ['⑰ unescape — موضع جديد خارج القائمة',
    (s) => s.replace("    toast(t('cancel.done'));", "    toast(unescape('%u0646'));"), 'fall'],
  ['⑱ JSON.parse — موضع جديد خارج القائمة',
    (s) => s.replace("    toast(t('cancel.done'));", "    toast(JSON.parse('\"\\\\u0646\"'));"), 'fall'],
  ['⑲ Buffer.from(hex) — موضع جديد خارج القائمة',
    (s) => s.replace("    toast(t('cancel.done'));", "    toast(Buffer.from('d986','hex').toString('utf8'));"), 'fall'],
  ['⑳ String.fromCharCode عبر مصفوفة متغيّر (لا أرقام في النداء)',
    (s) => s.replace("    toast(t('cancel.done'));",
      "    const cp = [0x639, 0x634];\n    toast(String.fromCharCode(...cp));"), 'fall'],
  ['㉑ String.fromCodePoint — موضع جديد خارج القائمة',
    (s) => s.replace("    toast(t('cancel.done'));", "    toast(String.fromCodePoint(0x639));"), 'fall'],
  ['㉒ eval — موضع جديد خارج القائمة (و§٢٦ يمنعه)',
    (s) => s.replace("    toast(t('cancel.done'));", "    eval('void 0');\n    toast(t('cancel.done'));"), 'fall'],
  ['㉓ عربية داخل تعبير نمطي (شرط على نصّ معروض ينكسر بالإنجليزية)',
    (s) => s.replace("      if (BUSY) doCancel();",
      "      if (/جاهز|تم التجهيز/.test(procBtn.textContent)) return;\n      if (BUSY) doCancel();"), 'fall'],

  /* ── ضوابط: يجب أن تمرّ ─────────────────────────────────────────────────── */
  ['ض١ تعليق يحمل عربية (لا يُعدّ نصّ واجهة) — يجب ألّا يُسقط',
    (s) => s.replace("  /* ── fading toast ─",
      "  // تعليق جديد فيه نصّ عربي خام: عالج هذا الفيديو\n  /* ── fading toast ─"), 'pass'],

  /* ض٢: يبقى النداء بالمفتاح **قائماً** (فلا يُتّهم مفتاحٌ بالموت) ويُضاف نصّ
   * إنجليزي خام لا يراه المرشّح الواسع — وهذا هو المقصود بالضبط. */
  ['ض٢ نصّ إنجليزي خام خارج الجدول (المرشّح الواسع لا يراه) — يجب ألّا يُسقط',
    (s) => s.replace("    toast(t('cancel.done'));",
      "    toast(t('cancel.done'));\n    toast('raw english ui text');"), 'pass'],

  /* ض٣: المفتاح الجديد يُضاف في اللغتين **ويُستعمل**، وإلا اتُّهم بالموت —
   * وهو حكم صحيح لكنه ليس ما يقيسه هذا الضابط. */
  ['ض٣ إضافة مفتاح في اللغتين معاً — يجب ألّا يُسقط',
    (s) => s.replace("      'cancel.done': '⏹ أُلغيت المعالجة — اضغط للبدء من جديد',",
      "      'cancel.done': '⏹ أُلغيت المعالجة — اضغط للبدء من جديد',\n      'extra.new': 'نصّ جديد',")
      .replace("      'cancel.done': '⏹ Processing cancelled — press to start again',",
        "      'cancel.done': '⏹ Processing cancelled — press to start again',\n      'extra.new': 'New text',")
      .replace("    toast(t('cancel.done'));",
        "    toast(t('cancel.done'));\n    toast(t('extra.new'));"), 'pass'],

  /* **ضابطان لعطب مقيس**: النسخة السابقة كانت تعدّ القيم مفاتيح، فقيمة مشتركة بين
   * مفتاحين تُرفض برسالة «مفتاح مكرَّر» — اصطياد كاذب. وهذان يُثبّتان الإصلاح:
   * قيمة **مكرّرة** لمفتاحين مختلفين يجب أن تمرّ.
   * (والقيمة المستعملة هنا **ليست** موجودة قبلاً في القسم، وإلا كان التغيير
   * **مفتاحاً مكرّراً حقيقياً** — وهو ما وقع في أول كتابة لهذين الضابطين فأُصلح.) */
  ['ض٤ قيمة إنجليزية مكرّرة لمفتاحين مختلفين — يجب ألّا يُسقط (اصطياد كاذب أُصلح)',
    (s) => s.replace("      'btn.watch.disabledTitle': 'HaramLite — enabled after processing',",
      "      'btn.watch.disabledTitle': 'Fetch failed',"), 'pass'],

  ['ض٥ قيمة عربية مكرّرة لمفتاحين مختلفين — يجب ألّا يُسقط',
    (s) => s.replace("      'watch.line': '▶ مشاهدة مفلترة — الصوت من المعالجة المحلية',",
      "      'watch.line': '▶ اضغط تشغيل لبدء الصوت المفلتر',"), 'pass'],
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

/* ── حالة «الشيفرة قبل التعريب» ────────────────────────────────────────────────
 * تُبنى **داخل هذا الملف** بلا اعتماد على ملف خارجي: تُنزع كتلة `const I18N = {…}`
 * من نصّ الملف نفسه ⇒ يبقى كل نصّ واجهة عربياً خارج الجدول، وهو **عطب ما قبل
 * التعريب** بعينه. والتحقق من أن البناء غير عبثي شرطٌ قبل الحكم (نصّ تغيّر،
 * والكتلة غابت فعلاً) — وإلا كان «السقوط» عن عدم تغيير لا عن كشف.
 * و`--before <ملف>` يبقى للتشغيل على نسخة محفوظة (تحقّق خارجي مستقلّ). */
function synthPreI18n(src) {
  const m = /const\s+I18N\s*=\s*\{/.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  const b = blockAt(src, open);
  if (!b) return null;
  return src.slice(0, m.index) + 'const I18N = null;' + src.slice(b.end);
}

/* ── (١) البناء الداخلي: يُقاس دائماً، بلا ملف خارجي وبلا علم ──────────────── */
{
  console.log('\n── حالة «الشيفرة قبل التعريب» (مبنية داخلياً) ──');
  const syn = synthPreI18n(base);
  const okSynth = syn !== null && syn !== base && !/const\s+I18N\s*=\s*\{/.test(syn);
  console.log('  البناء غير عبثي (النصّ تغيّر والكتلة غابت): ' + (okSynth ? '✓ نعم' : '✗ لا'));
  console.log('  بصمة البناء: ' + (syn ? sha256(syn).slice(0, 16) + '… (≠ الأصل ✓)' : '—'));
  if (!okSynth) {
    survived++; holes.push('بناء «قبل التعريب» عبثي — لم تُقَس الحالة');
    console.log('  ❌ البناء لم يغيّر شيئاً — لا قياس');
  } else {
    const rs = audit(syn, 'content.js');
    if (rs.failures.length) {
      caught++;
      console.log('  ✅ سقط    الشيفرة قبل التعريب (مبنية)                     | سقوط   | ' + rs.failures.length + ' ملاحظة');
      rs.failures.forEach((f) => console.log('       ↳ ' + f.replace(/\s+/g, ' ').slice(0, 240)));
    } else {
      survived++; holes.push('الشيفرة قبل التعريب (مبنية داخلياً)');
      console.log('  ❌ مرّ     الشيفرة قبل التعريب — الحارس لا يرى العطب الأصلي');
    }
  }
}

/* ── (٢) نسخة محفوظة خارج الشجرة، إن مُرِّر `--before` ────────────────────── */
if (beforeArg) {
  const p = path.resolve(beforeArg);
  if (!fs.existsSync(p)) {
    console.error('✗ --before: الملف غير موجود عند ' + p);
    process.exit(1);
  }
  const before = fs.readFileSync(p, 'utf8');
  const bSha = sha256(before);
  console.log('\n── نسخة محفوظة خارج الشجرة (`--before`) ──');
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
  console.log('\n  · --before غير مُمرَّر: النسخة الخارجية لم تُقَس (والحالة المبنية داخلياً أعلاه قِيست).');
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
