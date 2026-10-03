#!/usr/bin/env node
/* حارس: **`--only` يتراكم ولا يُستبدل** — ومُفسَدُه هو الإسناد نفسه.
 *
 * **العطل المُقاس (2026-10-03)**: كان `fetch-resources.cjs` يُسند `opts.only` في كل راية
 * ⇒ `--only=model --only=ffmpeg` يُبقي **الأخير وحده** و**يُسقط الأول صامتاً**، والسكربت
 * **يخرج بـ`0`** ويطبع «١ سليماً» ⇒ **نقص تجهيز صامت**: طلبٌ لم يُنفَّذ ويبدو ناجحاً.
 * ومثله في CI = أداةٌ لا تُجلب ثم اختبارات تسقط بلا سبب ظاهر.
 *
 * **كيف يقيس بلا شبكة ولا تنزيل**: يُشغَّل السكربت بـ`--verify-only` على **أربعة أسماء
 * موجودة** (‏`model` · `ffmpeg` · `ffprobe` · `yt-dlp`) ويُقرأ **من مخرَجه** ما جمعه.
 *   · ضابط: كل الأسماء المُمرَّرة تُحصى (وتُطابَق بالعدّ **وبالأسماء**).
 *   · مُفسَد Ⓜ: نسخة من السكربت أُعيد فيها `opts.only = ...` إسناداً ⇒ **يجب أن يسقط**؛
 *     وإن مرّ فالحارس أعمى.
 *   · ضابط سالب: بلا `--only` إطلاقاً ⇒ **لا تقييد** (المكوّنات الأربعة كلها) — فلا يمرّ
 *     الحارس لأن السكربت «لا يعرض شيئاً أبداً».
 *   · زائد: `--only=بلا-اسم` ⇒ خروج غير صفر (المسار الذي يسمّي المجهول).
 *
 * **وحدّ مُعلَن**: يحتاج الملفات الأربعة **موجودة** على القرص (هي مستبعدة من git)، فإن
 * غابت **يفشل الحارس بصوت عالٍ ولا يتخطّى** — حارس يتخطّى نفسه ليس حارساً.
 *
 * الاستعمال: node scripts/check-fetch-only.cjs [--root <dir>]
 * رموز الخروج: ٠ سليم · ١ فشل · ٢ بنية/استعارة.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXIT = { PASS: 0, FAIL: 1, MISUSE: 2 };
const argv = process.argv.slice(2);
let rootArg = null;
let scriptArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
      console.error('✗ --root يحتاج مساراً');
      process.exit(EXIT.MISUSE);
    }
    rootArg = argv[++i];
  } else if (argv[i] === '--script') {
    /* **لحارس الحرّاس**: يسمح بأن يُقاس **نسخة مُفسَدة** من السكربت (‏`guard-of-guards` يكتب
     * نسخته في مجلد مؤقّت). وبلا هذا الوسيط كان المُفسَد يجب أن يُكتب **داخل `scripts/`**،
     * وهو ما لا يفعله الإطار. والمقارنة تبقى على الموارد في `--root` نفسه. */
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
      console.error('✗ --script يحتاج مساراً');
      process.exit(EXIT.MISUSE);
    }
    scriptArg = argv[++i];
  } else {
    console.error(`✗ وسيط غير معروف: ${argv[i]}`);
    process.exit(EXIT.MISUSE);
  }
}
const root = rootArg ? path.resolve(rootArg) : path.resolve(__dirname, '..');
const script = scriptArg ? path.resolve(scriptArg) : path.join(root, 'scripts', 'fetch-resources.cjs');
if (!fs.existsSync(script)) {
  console.error(`✗ بنية غير صالحة: ${script} غير موجود`);
  process.exit(EXIT.MISUSE);
}

const REQUIRED = [
  ['models/UVR-MDX-NET-Voc_FT.onnx', 'model', 'النموذج'],
  ['bin/ffmpeg.exe', 'ffmpeg', 'ffmpeg'],
  ['bin/ffprobe.exe', 'ffprobe', 'ffprobe'],
  ['bin/yt-dlp.exe', 'yt-dlp', 'yt-dlp'],
];
const missingFiles = REQUIRED.filter(([rel]) => !fs.existsSync(path.join(root, rel)));
if (missingFiles.length && !scriptArg) {
  console.error('✗ بنية غير صالحة: ملفات الحارس غير موجودة على القرص — لا يُقاس الترابط:');
  for (const [rel] of missingFiles) console.error('   · ' + rel);
  console.error('  (هي مستبعدة من git: اجلبها بـ`node scripts/fetch-resources.cjs` ثم أعد الحارس)');
  process.exit(EXIT.MISUSE);
}

/** يُشغّل السكربت ويُعيد المخرَج ورمزه. `cwd` = مجلد السكربت، لأن السكربت يُحلّ مساراته
 *  من `__dirname` (فنسخةٌ في مجلد مؤقّت تعمل ما دامت هي المُشغَّلة). */
function run(scriptPath, args) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.dirname(path.resolve(scriptPath)),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status };
}

/** الأصول التي طبعها السكربت سليمة/مُتحقَّقة — تُقرأ من أسطره لا من نيّتنا. */
function reported(out) {
  const names = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/✔\s+(\S+)\s+—/);
    if (m) names.push(m[1].replace(/\\/g, '/').toLowerCase());
  }
  return names;
}

const cases = [];
const record = (label, ok, detail) => cases.push({ label, ok, detail: detail || '' });

/* Ⓐ ضابط موجب: **ثلاث رايات متكرّرة** ⇒ الثلاثة تُجمَع (وهو العطل المقيس بعينه). */
{
  const r = run(script, ['--verify-only', '--only=model', '--only=ffmpeg', '--only=ffprobe']);
  const got = reported(r.out);
  const want = ['models/uvr-mdx-net-voc_ft.onnx', 'bin/ffmpeg.exe', 'bin/ffprobe.exe'];
  const problems = [];
  if (r.code !== 0) problems.push(`رمز الخروج ${r.code} بدل 0`);
  for (const w of want) if (!got.includes(w)) problems.push(`«${w}» لم يُطلب/يُقرأ (المقروء: ${got.join(', ') || 'لا شيء'})`);
  if (got.length !== want.length) problems.push(`العدد ${got.length} بدل ${want.length} — رايةٌ أُسقطت صامتة`);
  record('Ⓐ ضابط: ثلاث رايات `--only` متكرّرة ⇒ الثلاثة تُجمَع', problems.length === 0, problems.join(' · '));
}

/* Ⓑ ضابط: علَم واحد بقيم مفصولة بفواصل = الصيغة المعتمدة في ci.yml ⇒ الثلاثة أيضاً. */
{
  const r = run(script, ['--verify-only', '--only=model,ffmpeg,ffprobe']);
  const got = reported(r.out);
  const problems = [];
  if (r.code !== 0) problems.push(`رمز الخروج ${r.code} بدل 0`);
  if (got.length !== 3) problems.push(`العدد ${got.length} بدل 3 (المقروء: ${got.join(', ') || 'لا شيء'})`);
  record('Ⓑ ضابط: `--only=a,b,c` (صيغة ci.yml) ⇒ الثلاثة', problems.length === 0, problems.join(' · '));
}

/* Ⓒ ضابط سالب: بلا `--only` ⇒ **بلا تقييد** (الأربعة) — فلا يمرّ الحارس لأن السكربت لا يعرض شيئاً. */
{
  const r = run(script, ['--verify-only']);
  const got = reported(r.out);
  const problems = [];
  if (r.code !== 0) problems.push(`رمز الخروج ${r.code} بدل 0`);
  if (got.length !== 4) problems.push(`بلا تقييد يجب أن تُقرأ الأربعة، قُرئ ${got.length}`);
  record('Ⓒ ضابط: بلا `--only` ⇒ الأربعة (لا تقييد)', problems.length === 0, problems.join(' · '));
}

/* Ⓓ مُفسَد المسار: اسم مجهول ⇒ **خروج غير صفر** (المسار الذي يسمّي المجهول بدل صمته). */
{
  const r = run(script, ['--verify-only', '--only=بلا-اسم-كهذا']);
  const problems = [];
  if (r.code === 0) problems.push('خرج بـ0 على اسم مجهول — نقص تجهيز صامت');
  if (!/لا يطابق أي أصل معروف/.test(r.out)) problems.push('لم يسمّ الاسم المجهول في مخرَجه');
  record('Ⓓ مُفسَد: اسم مجهول ⇒ خروج ≠ ٠ ورسالة تسمّيه', problems.length === 0, problems.join(' · '));
}

/* Ⓜ مُفسَد الحارس نفسه: نسخة أُعيد فيها الإسناد ⇒ يجب أن **يُسقط** الحارس.
   (بلا هذا لا يُعرف أن الحارس يرى العطل أصلًا.)
   **وموضع النسخة مقصود ومُتحقَّق**: السكربت يُحلّ مساراته من `__dirname` لا من `cwd`
   (مقيس: نسخة في مجلد مؤقّت ماتت بـ«لم أجد …src-tauri\\src\\repair.rs — شغّل السكربت من
   داخل المستودع»)، ⇒ فتُكتب النسخة **بجانب السكربت المُقاس** باسم مؤقّت خاصّ بها
   **وتُحذف في `finally`**.
   ⚠ **وعطل أُصلح هنا وأُعلن**: كان المُفسَد يُكتَب على **مسار `--script` نفسه** حين
   يُمرَّر (فحاول الحارس محوَ الملف الذي طُلب قياسه!) — أي أن الحارس كان **يهدم ما يقيسه**.
   الآن يُبنى المُفسَد من **السكربت المُقاس** ويُكتب على **اسم مؤقّت لا يمسّ المُدخَل**. */
{
  const mutantScript = path.join(path.dirname(script), '.mutant-fetch-only.cjs');
  let src = fs.readFileSync(script, 'utf8');
  const ACC = 'opts.only = [...(opts.only || []), ...parts];';
  const MUT = 'opts.only = parts;';
  const occurrences = src.split(ACC).length - 1;
  const problems = [];
  try {
    if (occurrences !== 1) {
      /* حين يُقاس **مُدخَل مُفسَد جاهز** (`--script` من حارس الحرّاس) لا يوجد نصّ التجميع
         أصلاً ⇒ فذلك **ليس عطلاً في الحارس** بل دليل أن المُدخَل مُفسَد فعلاً. ويُقال صراحةً
         بدل أن يُسجَّل فشلاً كاذباً. وحين يُقاس السكربت الحقيقي يبقى الشرط عطلاً حقيقياً. */
      problems.push(scriptArg
        ? `السكربت المُقاس لا يتراكم: نصّ التجميع غائب (${occurrences} مرة) ⇒ الطلب يُسقَط صامتاً`
        : `نصّ التجميع يظهر ${occurrences} مرة — لا أستطيع طمسه (المُفسَد باطل)`);
    } else {
      src = src.split(ACC).join(MUT);
      if (!src.includes(MUT)) problems.push('الطمس لم يقع');
      fs.writeFileSync(mutantScript, src, 'utf8');
      if (path.resolve(mutantScript) === path.resolve(script)) {
        problems.push('المُفسَد كُتب على مسار السكربت المُقاس — لا يجوز');
      } else {
        const r = run(mutantScript, ['--verify-only', '--only=model', '--only=ffmpeg', '--only=ffprobe']);
        const got = reported(r.out);
        /* المُفسَد يجب أن يُسقط الحارس: عدد المجموع **أقل من ٣**، والقياس أعطى **١**
           (‏`ffprobe` وحده — الراية الأخيرة)، وهو العطل المقيس بعينه. */
        if (got.length === 3) {
          problems.push('النسخة المُفسَدة جمعت الثلاثة — فالحارس لا يرى العطل');
        } else if (got.length !== 1) {
          problems.push(`المُفسَد أعطى ${got.length} بدل ١ (رمز الخروج ${r.code}) — راجع المُفسَد`);
        }
      }
    }
  } finally {
    try { fs.rmSync(mutantScript, { force: true }); } catch (e) {}
    if (fs.existsSync(mutantScript)) problems.push('النسخة المؤقّتة لم تُحذف — تُركت في الشجرة');
  }
  record('Ⓜ مُفسَد: إعادة الإسناد (`opts.only = parts`) ⇒ الحارس يرى الفرق (١ بدل ٣)', problems.length === 0, problems.join(' · '));
}

const bad = cases.filter((c) => !c.ok);
console.log(`حالات القياس — ${cases.length}:`);
for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : `\n      ${c.detail}`}`);
if (bad.length) {
  console.error(`\n✗ فشل ${bad.length} من ${cases.length} — «--only» قد يُسقط طلباً صامتاً`);
  process.exit(EXIT.FAIL);
}
console.log('✓ «--only» يتراكم: الرايات المتكرّرة والفواصل تُجمعان، والمجهول يُسمّى بخروج ≠ ٠.');
process.exit(EXIT.PASS);
