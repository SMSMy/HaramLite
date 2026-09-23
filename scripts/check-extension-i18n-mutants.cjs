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
 *
 * **وقسم ثانٍ (م٦-ب)** يقيس **المسح الموسَّع**: خريطة **سبعة ملفات** في الذاكرة
 * (`content.js` · `popup.js` · `popup.html` · `background.js` · `manifest.json` ·
 * `_locales/ar|en/messages.json`)، ومُفسَداتها: نصّ عربي في الصفحة أو في سمة ·
 * مفتاح مربوط غير موجود · موضع ربط جديد · `dir` نُزع · مفتاح تخزين جديد ·
 * `RTL` ثابت · `dir` لا يُسند · موضع `t(` محسوب ثالث · اللغة لم تعد من
 * `navigator.languages` · `__MSG_x__` بلا مفتاح · `default_locale` مجهول ·
 * عربية في المانيفست أو في قيمة إنجليزية · مفتاح زائد/ناقص في لغة · وملف مُعلَن
 * مفقود. **ونصّ كل مُفسَد يُستخرج من الملف نفسه بتعبير نمطي** (`sub`/`grab`) لا
 * يُكتب بيد، و`sub` يرمي إن لم يطابق فيُسجَّل «لم يُطبَّق» ويسقط الحاكم — فلا
 * «نجاح» من صفر تغيير (درس AGENT.md §٣).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const FILE = path.join(REPO, 'browser-extension', 'content.js');
const { audit, auditAll } = require('./check-extension-i18n.cjs');

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

/* ══════════════════════════════════════════════════════════════════════════
 * القسم الثاني (م٦-ب): **المسح الموسَّع** — خريطة ملفات في الذاكرة أيضاً.
 *
 * كل مُفسَد هنا يعمل على **خريطة نصوص** لا على القرص: لا ملف مؤقت ولا عملية
 * فرعية ولا كتابة. والنصّ المُفسَد **يُستخرج من الملف نفسه بتعبير نمطي** لا
 * يُكتب بيد (درس AGENT.md §٣: نصٌّ مكتوب بيد حمل `**` وشرطة ناعمة U+00AD فسقط
 * مُفسَده مرّتين بلا سبب) — فـ`sub` يرمي إن لم يطابق النمط، و`grab` يلتقط النصّ
 * العربي الحقيقي من الجدول ليُحقن. ومُفسَد يرمي ⇒ «لم يُطبَّق» ⇒ الحاكم يسقط.
 * ══════════════════════════════════════════════════════════════════════════ */
const EXT = 'browser-extension/';
const RELS = [
  'content.js', 'popup.js', 'popup.html', 'background.js',
  'manifest.json', '_locales/ar/messages.json', '_locales/en/messages.json',
].map((r) => EXT + r);
const K = {
  P: EXT + 'popup.js', H: EXT + 'popup.html', B: EXT + 'background.js',
  M: EXT + 'manifest.json', AR: EXT + '_locales/ar/messages.json', EN: EXT + '_locales/en/messages.json',
};
const FILES = {};
for (const rel of RELS) FILES[rel] = fs.readFileSync(path.join(REPO, rel), 'utf8');
const mapSha = (m) => sha256(RELS.map((r) => r + '\u0000' + m[r]).join('\u0001'));
const baseMapSha = mapSha(FILES);

/** استبدال بنمط: يرمي إن لم يطابق أو إن لم يغيّر شيئاً (فلا «نجاح» من صفر تغيير). */
function sub(src, re, repl) {
  if (!re.test(src)) throw new Error('النمط لا يطابق: ' + re);
  const out = src.replace(re, repl);
  if (out === src) throw new Error('الاستبدال لم يغيّر شيئاً: ' + re);
  return out;
}
/** التقاط نصّ **من الملف نفسه** (لا كتابة بيد). */
function grab(src, re, n) {
  const m = re.exec(src);
  if (!m) throw new Error('الالتقاط فشل: ' + re);
  return m[n === undefined ? 1 : n];
}
const dropJsonKey = (t, k) => { const j = JSON.parse(t); delete j[k]; return JSON.stringify(j, null, 2) + '\n'; };
const addJsonKey = (t, k, msg) => { const j = JSON.parse(t); j[k] = { message: msg }; return JSON.stringify(j, null, 2) + '\n'; };

const withFile = (rel, fn) => (F) => { const c = { ...F }; c[rel] = fn(F[rel], F); return c; };

/* نصوص عربية حقيقية تُلتقط من الجداول لتُحقن في موضع المُفسَد. */
const AR_SUB = grab(FILES[K.P], /'header\.sub':\s*'([^']+)'/, 1);
const AR_ICON = grab(FILES[K.P], /'header\.iconAlt':\s*'([^']+)'/, 1);
const AR_MENU = grab(FILES[K.B], /'menu\.link':\s*'([^']+)'/, 1);
const AR_APP = grab(FILES[K.AR], /"appName":\s*\{\s*"message":\s*"([^"]+)"/, 1);

/* ── الضابط: الحارس الموسَّع أخضر على الخريطة المشحونة ─────────────────────── */
console.log('\n── القسم الثاني: المسح الموسَّع (٧ ملفات في الذاكرة) ──');
console.log('  ملفات: ' + RELS.length + ' · بصمة الخريطة: ' + baseMapSha.slice(0, 16) + '…');
{
  const r0 = auditAll(FILES);
  if (r0.failures.length) {
    console.error('✗ الحارس الموسَّع أحمر على الملفات المشحونة — لا معنى لقياس المُفسَدات قبل إصلاحه.');
    r0.failures.forEach((f) => console.error('   ' + f));
    process.exit(2);
  }
  console.log('  الضابط: ' + r0.checks + ' فحصاً · 0 فاشل · 7 ملفات — أخضر\n');
}

const CASES2 = [
  /* ── popup.html ─────────────────────────────────────────────────────────── */
  ['① صفحة: مفتاح مربوط غير موجود في جدول popup.js',
    withFile(K.H, (s) => sub(s, /data-i18n="header\.sub"/, 'data-i18n="header.sub.typo"')), 'fall'],
  ['② صفحة: نصّ عربي عاد إلى متن الصفحة',
    withFile(K.H, (s) => sub(s, /(<p class="sub" data-i18n="header\.sub"><\/p>)/,
      (m) => m.replace('></p>', '>' + AR_SUB + '</p>'))), 'fall'],
  ['③ صفحة: عربية في **سمة** (alt) لا في المتن',
    withFile(K.H, (s) => sub(s, /alt="" data-i18n-attr="alt:header\.iconAlt"/,
      'alt="' + AR_ICON + '" data-i18n-attr="alt:header.iconAlt"')), 'fall'],
  ['④ صفحة: موضع ربط جديد (العدد المُعلَن)',
    withFile(K.H, (s) => sub(s, /(<span data-i18n="footer\.privacy"><\/span>)/,
      (m) => m + '<span data-i18n="footer.privacy"></span>')), 'fall'],
  ['⑤ صفحة: `dir` الثابت نُزع من وسم <html>',
    withFile(K.H, (s) => sub(s, /<html lang="en" dir="ltr">/, '<html lang="en">')), 'fall'],
  /* عطب وقع فعلاً في هذه الجولة: أُضيف `id` بعد `class="version-tag"` فتغيّر
   * شكل الوسم ورفض `pack-extension.js` الحزم («no .version-tag found»). */
  ['⑤ب صفحة: سمة أُضيفت بعد `class="version-tag"` ⇒ شكل الوسم انكسر والحازم يرفض',
    withFile(K.H, (s) => sub(s, /class="version-tag">/, 'class="version-tag" id="version-tag">')), 'fall'],
  ['⑤ج صفحة: وسم الإصدار الثابت خالف إصدار المانيفست',
    withFile(K.H, (s) => sub(s, /class="version-tag">v([\d.]+)</, (m, v) => m.replace(v, '1.1.6'))), 'fall'],
  ['ض١ صفحة: تعليق HTML يحمل عربية — يجب ألّا يُسقط',
    withFile(K.H, (s) => sub(s, /<body>/, (m) => m + '\n<!-- ' + AR_SUB + ' -->')), 'pass'],

  /* ── popup.js ───────────────────────────────────────────────────────────── */
  ['⑥ popup.js: نصّ عربي خارج الجدول (المرشّح الواسع على ملف جديد)',
    withFile(K.P, (s) => sub(s, /applyI18n\(\);/, (m) => m + "\nel.statusChannel.textContent = '" + AR_SUB + "';")), 'fall'],
  ['⑦ popup.js: مفتاح localStorage جديد (§٢٧)',
    withFile(K.P, (s) => sub(s, /localStorage\.setItem\(MODE_KEY, mode\)/,
      "localStorage.setItem('hl.popup.extra', mode)")), 'fall'],
  ['⑧ popup.js: الاتجاه لم يعد مشتقّاً من اللغة (RTL ثابت)',
    // `let` مقبولة كما `const` منذ جولة x1-ext (اللغة صارت قابلة للتبديل من مبدّل
    // ظاهر) — والمُفسَد يثبّت الاشتقاق على `true` فيسقط بالفحص ⑮ أيّاً كان نوع الإعلان.
    withFile(K.P, (s) => sub(s, /let RTL = LANG === 'ar';/, 'let RTL = true;')), 'fall'],
  ['⑨ popup.js: الاتجاه لا يُسند إلى المستند (نُزع سطر dir)',
    withFile(K.P, (s) => sub(s, /document\.documentElement\.dir = RTL \? 'rtl' : 'ltr';\n/, '')), 'fall'],
  ['⑩ popup.js: موضع `t(` محسوب ثالث خارج العدد المُعلَن',
    withFile(K.P, (s) => sub(s, /applyI18n\(\);/, (m) => m + "\nconst zk = 'header.sub';\nel.jobName.textContent = t(zk);")), 'fall'],
  /* ⑩أ/⑩ب — قاعدة ⑱ (جولة x1-ext): مفاتيح `chrome.storage.local` تُعلَن بالاسم،
     والصلاحية شرط عملها. مُفسَدان لكلٍّ من الاتجاهين. */
  ['⑩أ popup.js: مفتاح `chrome.storage.local` حرفيّ غير مُعلَن',
    withFile(K.P, (s) => sub(s, /chrome\.storage\.local\.set\(\{ \[LANG_KEY\]: LANG \}\);/,
      "chrome.storage.local.set({ 'hl.ghost': 1 });")), 'fall'],
  ['⑩ب manifest.json: صلاحية `storage` نُزعت وهناك ملفات تستعمل `chrome.storage.local`',
    withFile(K.M, (s) => sub(s, /"permissions": \[([^\]]*)\]/, (m, g) => '"permissions": [' + g.replace(/,\s*"storage"/, '') + ']')), 'fall'],
  ['⑪ popup.js: مفتاح مربوط في الصفحة حُذف من الجدول (اللغتين)',
    withFile(K.P, (s) => sub(s, /'footer\.install': '[^']*',\n/g, '')), 'fall'],
  /* ⑪أ–⑪ج — قاعدة اللغة الواحدة ⑲ (قرار المالك 2026-09-23، والجرد في الحارس). */
  ['⑪أ popup.js: عربية داخل قيمة إنجليزية (خلط يُصلَح)',
    withFile(K.P, (s) => sub(s, /'send\.button': 'Send this page to HaramLite'/,
      "'send.button': 'Send this page " + AR_SUB + "'")), 'fall'],
  ['⑪ب popup.js: رمز لاتيني غير مُعلَن داخل قيمة عربية (خلط يُصلَح)',
    withFile(K.P, (s) => sub(s, /'send\.button': '[^']*'/,
      "'send.button': 'أرسل هذه الصفحة إلى HaramLite (Send page)'")), 'fall'],
  ['⑪ج ضابط: مصطلحات القائمة البيضاء داخل نصّ عربي — يجب ألّا تُسقط',
    withFile(K.P, (s) => sub(s, /'send\.button': '[^']*'/,
      "'send.button': 'أرسل هذه الصفحة إلى HaramLite — HaramLite Bridge — chrome://extensions'")), 'pass'],
  ['ض٢ popup.js: تعليق يحمل عربية — يجب ألّا يُسقط',
    withFile(K.P, (s) => sub(s, /applyI18n\(\);/, (m) => '// ' + AR_SUB + '\n' + m)), 'pass'],

  /* ── background.js ──────────────────────────────────────────────────────── */
  ['⑫ background.js: اللغة لم تعد من `navigator.languages`',
    withFile(K.B, (s) => sub(s, /navigator\.languages/g, 'navigator.language')), 'fall'],
  ['⑬ background.js: عربية خارج الجدول (المرشّح الواسع)',
    withFile(K.B, (s) => sub(s, /const HOST = 'com\.harammute\.haramlite';/,
      (m) => m + "\nconst NOTE = '" + AR_MENU + "';")), 'fall'],
  ['⑭ background.js: قيمة إنجليزية تحمل عربية (ترجمة ناقصة)',
    withFile(K.B, (s) => sub(s, /'menu\.link': 'Send the link to HaramLite'/, "'menu.link': '" + AR_MENU + "'")), 'fall'],

  /* ── manifest.json + _locales ───────────────────────────────────────────── */
  ['⑮ المانيفست: `__MSG_appName__` بلا مفتاح مقابل في `_locales`',
    withFile(K.M, (s) => sub(s, /__MSG_appName__/, '__MSG_appNameTypo__')), 'fall'],
  ['⑯ المانيفست: نصّ عربي عاد إليه (مكانه `_locales`)',
    withFile(K.M, (s) => sub(s, /"name": "__MSG_appName__"/, '"name": "' + AR_APP + '"')), 'fall'],
  ['⑰ المانيفست: `default_locale` لا يقابل لغة قائمة',
    withFile(K.M, (s) => sub(s, /"default_locale": "en"/, '"default_locale": "zz"')), 'fall'],
  ['⑱ _locales/en: قيمة إنجليزية تحمل عربية',
    withFile(K.EN, (s) => sub(s, /"message": "[^"]*"/, '"message": "' + AR_APP + '"')), 'fall'],
  ['⑲ `_locales`: مفتاح في `ar` بلا مقابل في `en`',
    withFile(K.EN, (s) => dropJsonKey(s, 'appDesc')), 'fall'],
  ['⑳ `_locales`: مفتاح زائد لا يستعمله المانيفست',
    (F) => {
      const c = { ...F };
      c[K.AR] = addJsonKey(F[K.AR], 'orphan', 'نصّ عربي لا يستعمله المانيفست');
      c[K.EN] = addJsonKey(F[K.EN], 'orphan', 'Text the manifest never uses');
      return c;
    }, 'fall'],
  ['ض٣ `_locales/ar`: تغيير نصّ الرسالة العربية (تبقى عربية) — يجب ألّا يُسقط',
    withFile(K.AR, (s) => sub(s, /"message": "[^"]*"/, '"message": "' + AR_APP + ' —"')), 'pass'],
  ['ض٤ `_locales/en`: تغيير نصّ الرسالة الإنجليزية — يجب ألّا يُسقط',
    withFile(K.EN, (s) => sub(s, /"message": "[^"]*"/, '"message": "HaramLite Bridge — a bridge"')), 'pass'],

  /* ── «صفر مدخل» على الخريطة ─────────────────────────────────────────────── */
  ['㉑ ملف مُعلَن مفقود من الخريطة ⇒ فشل بصوت عالٍ',
    (F) => { const c = { ...F }; delete c[K.P]; return c; }, 'fall'],
  ['㉒ `_locales/ar/messages.json` فارغ ⇒ فشل بصوت عالٍ',
    (F) => ({ ...F, [K.AR]: '' }), 'fall'],
];

let caught2 = 0, survived2 = 0, passed2 = 0, badPass2 = 0, skipped2 = 0;
const holes2 = [], regressions2 = [];

console.log('  الحالة                                                  | متوقّع | النتيجة');
console.log('  ' + '-'.repeat(96));
for (const [label, fn, want] of CASES2) {
  let mut;
  try { mut = fn(FILES); } catch (e) { mut = FILES; }
  if (mut === FILES) {
    skipped2++;
    console.log('  ⚠ لم يُطبَّق  ' + label);
    continue;
  }
  const mSha = mapSha(mut);
  const r = auditAll(mut);
  const fell = r.failures.length > 0;
  if (want === 'fall') {
    if (fell) {
      caught2++;
      console.log('  ✅ سقط    ' + label.slice(0, 52).padEnd(52) + ' | سقوط   | ' + r.failures.length + ' ملاحظة');
      console.log('       ↳ بصمة الخريطة: ' + mSha.slice(0, 16) + '… (≠ الأصل ✓)');
      r.failures.forEach((f) => console.log('       ↳ ' + f.replace(/\s+/g, ' ').slice(0, 200)));
    } else {
      survived2++; holes2.push(label);
      console.log('  ❌ مرّ     ' + label.slice(0, 52).padEnd(52) + ' | سقوط   | ثقب في الحارس');
    }
  } else {
    if (!fell) {
      passed2++;
      console.log('  ✅ مرّ     ' + label.slice(0, 52).padEnd(52) + ' | مرور   | ' + r.checks + ' فحصاً · 0 فاشل');
      console.log('       ↳ بصمة الخريطة: ' + mSha.slice(0, 16) + '… (≠ الأصل ✓)');
    } else {
      badPass2++; regressions2.push(label);
      console.log('  ❌ سقط     ' + label.slice(0, 52).padEnd(52) + ' | مرور   | اصطياد كاذب');
      r.failures.forEach((f) => console.log('       ↳ ' + f.replace(/\s+/g, ' ').slice(0, 200)));
    }
  }
}

const total2 = caught2 + survived2 + badPass2 + passed2;
console.log('\nحصيلة القسم الثاني: أسقط ' + caught2 + ' · مرّ ضابطاً ' + passed2 + ' · ثقوب ' + survived2 +
  ' · اصطياد كاذب ' + badPass2 + ' · لم يُطبَّق ' + skipped2);

/* ── إثبات أن القرص لم يُمَسّ — content.js **وكل ملفات الخريطة** ──────────── */
const afterSha = sha256(fs.readFileSync(FILE, 'utf8'));
console.log('\nبصمة content.js بعد كل المُفسَدات: ' + afterSha);
console.log('عادت كما كانت (لم يُمَسّ الملف): ' + (afterSha === baseSha ? '✓ نعم' : '✗ لا'));

const onDisk = {};
for (const rel of RELS) onDisk[rel] = fs.readFileSync(path.join(REPO, rel), 'utf8');
const afterMapSha = mapSha(onDisk);
console.log('بصمة خريطة الملفات السبعة على القرص: ' + afterMapSha);
console.log('عادت كما كانت (لم يُمَسّ منها ملف): ' + (afterMapSha === baseMapSha ? '✓ نعم' : '✗ لا'));

const total = caught + survived + badPass + passed;
console.log('\nالحصيلة: أسقط ' + caught + ' · مرّ ضابطاً ' + passed + ' · ثقوب ' + survived +
  ' · اصطياد كاذب ' + badPass + ' · لم يُطبَّق ' + skipped);
console.log('الحصيلة الكاملة: أسقط ' + (caught + caught2) + ' · مرّ ضابطاً ' + (passed + passed2) +
  ' · ثقوب ' + (survived + survived2) + ' · اصطياد كاذب ' + (badPass + badPass2) +
  ' · لم يُطبَّق ' + (skipped + skipped2));

let bad = false;
if (afterSha !== baseSha) { console.error('✗ الملف تغيّر على القرص — القياس غير صالح'); bad = true; }
if (afterMapSha !== baseMapSha) { console.error('✗ ملف من الخريطة تغيّر على القرص — القياس غير صالح'); bad = true; }
const skippedAll = skipped + skipped2;
if (skippedAll) { console.error('✗ ' + skippedAll + ' مُفسَداً لم يُطبَّق (نمط الاستبدال لا يطابق) — قياس ناقص'); bad = true; }
const holesAll = holes.concat(holes2);
if (holesAll.length) { console.error('✗ ثقوب مؤكَّدة (مُفسَد مرّ من الحارس):'); holesAll.forEach((h) => console.error('   - ' + h)); bad = true; }
const regAll = regressions.concat(regressions2);
if (regAll.length) { console.error('✗ اصطياد كاذب (ضابط سقط):'); regAll.forEach((h) => console.error('   - ' + h)); bad = true; }
if (total + total2 === 0) { console.error('✗ صفر حالة مُطبَّقة — لا شيء قيس'); bad = true; }
if (bad) process.exit(1);
console.log('✓ لا ثقب: كل مُفسَد أسقط الحارس، وكل ضابط مرّ، والملفات على القرص لم تُمَسّ.');
