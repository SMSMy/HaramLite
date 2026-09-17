/* حاكم المُفسَدات — البوابة السلبية لحارس مزامنة الإضافة.
 *   node scripts/check-extension-mutants.cjs
 *   node scripts/check-extension-mutants.cjs --root <dir>
 *   node scripts/check-extension-mutants.cjs --spec <file.cjs>
 *
 * يقرأ `browser-extension/content.js` و`scripts/check-extension-sync.cjs`، ثم يُطبّق
 * على المحتوى **مُفسَداً واحداً في كل مرة** (تغيير سلوكي حقيقي) ويُشغّل الحارس عليه
 * **في الذاكرة** (بلا عمليات فرعية وبلا ملفات مؤقتة).
 *
 * القاعدة المحروسة: **كل مُفسَد يجب أن يُسقط الحارس**. مُفسَد يمرّ = ثقب مؤكَّد في
 * الحارس، لا مجرد ملاحظة. وهذا هو الدرس الذي تكرّر في هذه الجلسة: حارس أخضر لا يعني
 * أنه يرى؛ الدليل أن يسقط على نصّ مُخرَّب.
 *
 * المُفسَدات مستخرجة من قياس فعلي (المشرف + مُكذِّبَين مستقلّين، 2026-09-15)؛ ومصدر
 * كل عائلة مذكور في التعليق. الأداة **لا تعدّل أي ملف**: كل شيء في الذاكرة.
 *
 * ── تحصين هذه الجولة (ثلاثة عيوب مُقاسة، أُعيد إنتاجها جميعاً) ────────────────
 * ① **المُفسَد الرامي كان يُصنَّف خطأً على الوجهين**: الحارس الذي يموت باستثناء
 *    داخلي لم يُصدر حكماً أصلاً، فنتيجته **غير معروفة**؛ وكان:
 *      · رسالة الاستثناء بلا «✗» ⇒ يُصنَّف «مرّ ← ثقب في الحارس» (ثقب كاذب)،
 *      · ورسالة الاستثناء تحمل «✗» ⇒ يُصنَّف «سقط» (اصطياد كاذب، وهو الأخطر:
 *        انهيار يُحسب قدرةَ كشف).
 *    الآن للانهيار **تصنيف ثالث مستقل** (`انهيار`) لا يُحتسب اصطياداً، ويُسقط
 *    الحاكم نفسه (exit 1) لأن القياس غير صالح.
 * ② **`THREW` لم يكن يُطبَع إطلاقاً** في المسار الذي لا يحمل «✗» — فيبقى سبب
 *    الموت مخفياً. الآن سبب الانهيار يُطبَع مع كل مُفسَد.
 * ③ **صفر مُفسَد مُطبَّق** (نصّ مستهدف غير موجود في هذه النسخة) كان يُنتج
 *    «✓ لا ثقب» و exit 0 — نجاح فارغ. الآن صفر مُطبَّق ⇒ فشل مسمّى.
 * و④ الكعب `require('fs')` كان يُعيد نصّ المحتوى **لأي** ملف يُقرأ (يتجاهل
 *    المسار)، فإن قرأ الحارس ملفاً ثانياً رَأى المحتوى المُفسَد مكانه. الآن
 *    الملف المشحون وحده يُستبدل، وغيره يُقرأ من القرص.
 *
 * `--spec <file.cjs>` يوصّل الحاكم ببيئة مصنوعة: يُصدّر
 *   `module.exports = { content, guard, mutants: [[label, fn], …] }`
 * وهو ما تستعمله بوّابة `pnpm guards:selfcheck` لتزرع مُفسَداً وضابطاً للحاكم
 * نفسه. وبدونه يعمل على المستودع كما كان.
 */
const fs = require('fs');
const path = require('path');

/* ── الوسائط ──────────────────────────────────────────────────────────────── */
function usage(msg) {
  console.error('✗ ' + msg);
  console.error('  الاستعمال: node scripts/check-extension-mutants.cjs [--root <dir>] [--spec <file.cjs>]');
  process.exit(2);
}
let rootArg = null, specArg = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root' || a === '--spec') {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) usage('العلم ' + a + ' يحتاج قيمة');
    if (a === '--root') rootArg = argv[++i]; else specArg = argv[++i];
  } else usage('وسيط غير معروف: ' + a);
}

const ROOT_DEFAULT = path.resolve(__dirname, '..');

/* ── المُفسَدات المدمجة ──────────────────────────────────────────────────────── */
// [الوصف · المُفسَد · عائلته]
const BUILTIN_MUTANTS = [
  // عائلة: بوابة موضع الصوت الواحدة (الجولة الثالثة)
  ['إضافة كتابة ثالثة لموضع الصوت',
    (s) => s.replace(/(const gapTick = \(boundary, landing\) => \{\n)/, '$1      audio.currentTime = 0;\n')],
  ['قلب بوابة السحب للخلف (allowBack مقلوب)',
    (s) => s.replace('if (!allowBack && !audio.paused && delta > 0.05)', 'if (allowBack && !audio.paused && delta > 0.05)')],

  // عائلة: القفزة (الجولة الثانية) — وسم قفزتنا قبل الإسناد
  ['حذف وسم قفزتنا (selfSeek) من gapTick',
    (s) => s.replace('      w.selfSeek = Date.now();    // قفزتنا', '      // (مُفسَد: بلا وسم)')],
  ['إعادة إرساء الصوت بوسيط مُزاح',
    (s) => s.replace('reanchorAudio(target);', 'reanchorAudio(target + 0.1);')],
  ['حذف تصفير الاحتجاز من فرع w.held في gapTick',
    (s) => s.replace("        reanchorAudio(target);\n        w.held = false;\n", '        reanchorAudio(target);\n')],

  // عائلة: القياس (الخطوة ١) — سطر load وحقوله
  ['حذف حمولة hist/keptBefore من سطر load',
    (s) => {
      const i = s.indexOf(' hist=[${st.hist.join');
      if (i < 0) return s;
      const j = s.indexOf('}}`);', i);
      return j < 0 ? s : s.slice(0, i) + s.slice(j + 2);
    }],
  ['الوسيط الزوجي يأخذ العنصر الأعلى',
    (s) => s.replace('(befores[mid - 1] + befores[mid]) / 2', 'befores[mid]')],
  ['الفجوة الأمامية تُدخل صفراً في before',
    (s) => s.replace('if (prevLen > 0) befores.push(prevLen);', 'befores.push(prevLen);')],
  ['الفجوات دون 0.5 تدخل المدرّج',
    (s) => s.replace('if (g >= 0.5) {', 'if (g >= 0) {')],
  ['smallestGap يصير آخر فجوة لا أصغرها',
    (s) => s.replace('if (!out.smallestGap || g < out.smallestGap) out.smallestGap = g;', 'out.smallestGap = g;')],
  ['فجوة 0.5 بالضبط تخرج من smallGaps',
    (s) => s.replace('if (g <= jumpThreshold) { out.smallGaps++; out.smallSeconds += g; }', 'if (g < jumpThreshold) { out.smallGaps++; out.smallSeconds += g; }')],

  // عائلة: قرار الفجوة (الخطوة ٣)
  ['دقّة المعدّل toFixed(2) ⟶ toFixed(1)',
    (s) => s.replace("return { mode: 'speed', rate: +rate.toFixed(2) };", "return { mode: 'speed', rate: +rate.toFixed(1) };")],
  ['حدّ الصغر < ⟶ <=',
    (s) => s.replace('if (gap < cfg.cutBelow) return', 'if (gap <= cfg.cutBelow) return')],

  // عائلة: الإجباريّ (الخطوة ٦)
  ['إعادة إشارة إلى مفتاح الخيار المحذوف',
    (s) => s.replace(/(const T = \{)/, "$1\n  const LEGACY_SKIP_KEY = 'hl.skipgaps';\n")],

  // عائلة: وضع التسريع (الخطوة ٤) — الأعطال التي رصدها المشرف والمُكذِّبان
  ['مؤقّت الخروج في w.gapTimer بدل w.paceTimer',
    (s) => s.replace("w.paceTimer = setTimeout(() => paceExit('timer')", "w.gapTimer = setTimeout(() => paceExit('timer')")],
  ['حذف احتضار الصوت من paceEnter (w.held)',
    (s) => s.replace('      w.held = true;\n      try { audio.pause(); } catch { /* gone */ }\n', '')],
  ['تصفير w.pace مفقود في paceExit (تعطيل المُصحّح الدوري)',
    (s) => s.replace('      w.pace = null;\n      w.selfRate = null;\n      try { video.playbackRate = w.prevRate', '      w.selfRate = null;\n      try { video.playbackRate = w.prevRate')],
  ['كتابة معدّل التسريع في w.prevRate',
    (s) => s.replace('      w.selfRate = rate;', "      w['prev' + 'Rate'] = rate;\n      w.selfRate = rate;")],
  ['حراسة w.pace مفقودة في نبضة الانحراف',
    (s) => s.replace('      if (w.pace) return;\n', '')],
  ['حراسة w.pace مفقودة في kickAudio',
    (s) => s.replace(/(const kickAudio = \(\) => \{[\s\S]*?)if \(w\.pace && w\.paceTimer\)/, '$1if (false)')],
  ['مصدر at في شبكة الأمان ثابت',
    (s) => s.replace('const at = video.currentTime || 0;', 'const at = -1;')],
  ['نداء paceExit في معالج seeking داخل فرع ميت',
    (s) => s.replace("      paceExit('seeking');", '      if (w.never) paceExit(\'seeking\');')],
  ['تعليق audio.play() الحيّ في paceExit',
    (s) => s.replace(/\n(\s*)audio\.play\(\)\.catch\(\(\) => \{ w\.held = true; \}\);\n(\s*)trace\('pace-exit'/, '\n$1if (w.never) audio.play().catch(() => { w.held = true; });\n$2trace(\'pace-exit\'')],
  ['نداء pacePlan مفقود من الماسح (الوصل نفسه)',
    (s) => s.replace('      pacePlan(boundary, landing);\n', '')],

  // عائلة: الثوابت العامة (لا كود ميت ولا وصول محسوب ولا مجدول جديد)
  ['مؤقّت جديد بلا داعٍ',
    (s) => s.replace(/(const gapTick = \(boundary, landing\) => \{\n)/, '$1      setInterval(() => {}, 5000);\n')],
  ['وصول محسوب إلى الكائن العام',
    (s) => s.replace(/(const gapTick = \(boundary, landing\) => \{\n)/, '$1      void globalThis[["plan","Gap"].join("")];\n')],
  ['بوابة كاذبة محلية تُخفي احتضار الصوت',
    (s) => s.replace('      w.pace = { boundary, landing, rate };\n      w.held = true;\n', '      const NEVER = false;\n      if (NEVER) { w.held = true; }\n      w.pace = { boundary, landing, rate };\n')],
];

/* ── الحلّ: بيئة مصنوعة أو المستودع ─────────────────────────────────────────── */
function resolveTarget() {
  if (specArg) {
    const p = path.resolve(specArg);
    if (!fs.existsSync(p)) usage('ملف الوصف غير موجود: ' + p);
    let spec;
    try { spec = require(p); } catch (e) { usage('تعذّر تحميل ملف الوصف: ' + e.message); }
    const need = ['content', 'guard', 'mutants'];
    for (const k of need) {
      if (!spec || !spec[k]) usage('ملف الوصف ناقص: يحتاج `' + k + '`');
    }
    if (!Array.isArray(spec.mutants) || spec.mutants.length === 0) {
      usage('ملف الوصف: `mutants` يجب أن يكون مصفوفة غير فارغة');
    }
    return { CONTENT: path.resolve(spec.content), GUARD: path.resolve(spec.guard), MUTANTS: spec.mutants, mode: 'spec:' + path.basename(p) };
  }
  const root = rootArg ? path.resolve(rootArg) : ROOT_DEFAULT;
  return {
    CONTENT: path.join(root, 'browser-extension', 'content.js'),
    GUARD: path.join(root, 'scripts', 'check-extension-sync.cjs'),
    MUTANTS: BUILTIN_MUTANTS,
    mode: root,
  };
}

const { CONTENT, GUARD, MUTANTS, mode } = resolveTarget();
for (const [p, label] of [[CONTENT, 'browser-extension/content.js'], [GUARD, 'scripts/check-extension-sync.cjs']]) {
  if (!fs.existsSync(p)) {
    console.error('✗ حاكم المُفسَدات: بنية غير صالحة — ' + label + ' غير موجود عند ' + p);
    process.exit(2);
  }
}

const base = fs.readFileSync(CONTENT, 'utf8');
const guardSrc = fs.readFileSync(GUARD, 'utf8');

/* ── تشغيل الحارس في الذاكرة ───────────────────────────────────────────────
   الحارس يُنفَّذ بـ`new Function` مع كعب لـfs يُبدّل **الملف المشحون وحده**
   بالمُفسَد؛ أي ملف آخر يُقرأ من القرص كما هو (العيب ④: الكعب كان يتجاهل
   المسار فيُعيد نصّ المحتوى لأي قراءة). */
function runGuard(srcText) {
  const out = [];
  let exitCode = null;
  let crashed = null;
  const consoleStub = {
    log: (...a) => out.push(a.map(String).join(' ')),
    error: (...a) => out.push(a.map(String).join(' ')),
  };
  const processStub = {
    exit: (c) => { exitCode = c; throw new Error('__EXIT__'); },
    argv: [], env: process.env, cwd: () => process.cwd(),
  };
  const fsStub = Object.create(fs);
  fsStub.readFileSync = (p, ...rest) =>
    (path.resolve(String(p)) === path.resolve(CONTENT) ? srcText : fs.readFileSync(p, ...rest));
  const requireStub = (m) => {
    if (m === 'fs') return fsStub;
    if (m.startsWith('.') || path.isAbsolute(m)) return require(path.resolve(path.dirname(GUARD), m));
    return require(m);
  };
  try {
    new Function('require', 'console', 'process', '__dirname', guardSrc)(
      requireStub, consoleStub, processStub, path.dirname(GUARD)
    );
  } catch (e) {
    // خروج مقصود ≠ انهيار. والانهيار **لا يدخل `out`** حتى لا تُحتسب رسالته
    // سطر فشل إن حملت «✗» — وهذا هو الاصطياد الكاذب الذي أُصلح.
    if (!e || e.message !== '__EXIT__') crashed = (e && e.message) ? e.message : String(e);
  }
  const fails = out.filter((l) => l.includes('✗')).map((l) => l.trim());
  return { exitCode, fails, crashed, summary: (out.find((l) => l.includes('فحصاً ناجحاً')) || '').trim() };
}

/* ── التشغيل ─────────────────────────────────────────────────────────────────── */
console.log('حاكم المُفسَدات · الهدف: ' + mode);
const clean = runGuard(base);
if (clean.crashed) {
  console.error('✗ الحارس انهار على الملف المشحون نفسه — لا معنى لقياس المُفسَدات قبل إصلاحه.');
  console.error('     الاستثناء: ' + clean.crashed);
  process.exit(2);
}
console.log('الحارس على الملف المشحون: ' + (clean.summary || '(بلا ملخّص)'));
if (clean.fails.length) {
  console.error('✗ الحارس أحمر على الملف المشحون أصلاً — لا معنى لقياس المُفسَدات قبل إصلاحه.');
  process.exit(2);
}

let caught = 0, survived = 0, skipped = 0, crashedN = 0;
const holes = [];
const crashes = [];
console.log('\nمُفسَد | الحارس يسقط؟ | أول فحصين ساقطين');
for (const [label, fn] of MUTANTS) {
  let mut;
  try {
    mut = fn(base);
  } catch (e) {
    // مُفسَد نفسه رمى: عيب في أداة القياس لا في الحارس ⇒ يُسقط الحاكم.
    console.log(`  ⚠ مُفسَد معطوب  ${label}  (رمى: ${e && e.message})`);
    crashes.push(label + ' — دالة المُفسَد رمَت: ' + (e && e.message));
    crashedN++;
    continue;
  }
  if (typeof mut !== 'string' || mut === base) {
    console.log(`  – مُتخطّى  ${label}  (النصّ المستهدف غير موجود في هذه النسخة)`);
    skipped++;
    continue;
  }
  const r = runGuard(mut);
  if (r.crashed) {
    // الانهيار ليس حكماً: لا يُحتسب اصطياداً ولا ثقباً، بل قياساً غير صالح.
    crashedN++;
    crashes.push(label + ' — انهار الحارس: ' + r.crashed);
    console.log(`  ⚠ انهار   ${label}  ← THREW: ${String(r.crashed).slice(0, 110)}`);
    continue;
  }
  const dropped = (r.exitCode !== null && r.exitCode !== 0) || r.fails.length > 0;
  if (dropped) {
    caught++;
    const how = r.fails.length ? r.fails.length + ' ملاحظة' : 'exit=' + r.exitCode + ' بلا ✗';
    console.log(`  ✅ سقط   ${label}  (${how})  ${r.fails.slice(0, 2).join(' | ').slice(0, 110)}`);
  } else {
    survived++;
    holes.push(label);
    console.log(`  ❌ مرّ    ${label}  ← ثقب في الحارس`);
  }
}

const applied = caught + survived;
console.log(`\nالحصيلة: أسقط ${caught} · مرّ ${survived} · انهار ${crashedN} · متخطّى ${skipped} (من ${MUTANTS.length})`);

let bad = false;
if (crashedN) {
  console.error('✗ قياس غير صالح — ' + crashedN + ' مُفسَداً انهار عليه الحارس (الانهيار ليس اصطياداً):');
  crashes.forEach((h) => console.error('   - ' + h));
  bad = true;
}
if (survived) {
  console.error('✗ ثقوب مؤكَّدة (مُفسَد يمرّ من الحارس):');
  holes.forEach((h) => console.error('   - ' + h));
  bad = true;
}
if (applied === 0) {
  console.error('✗ صفر مُفسَد مُطبَّق على هذه النسخة — لا شيء قيس، فلا يجوز إعلان «لا ثقب».');
  bad = true;
}
if (bad) process.exit(1);
console.log('✓ لا ثقب: كل مُفسَد أسقط الحارس (' + applied + ' مُطبَّقاً).');
