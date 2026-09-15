/* حاكم المُفسَدات — البوابة السلبية لحارس مزامنة الإضافة.
 *   node scripts/check-extension-mutants.cjs
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
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'browser-extension', 'content.js');
const GUARD = path.join(ROOT, 'scripts', 'check-extension-sync.cjs');

const base = fs.readFileSync(CONTENT, 'utf8');
const guardSrc = fs.readFileSync(GUARD, 'utf8');

/** يُشغّل الحارس في الذاكرة على نصّ محتوى مُعطى. */
function runGuard(srcText) {
  const out = [];
  let exitCode = null;
  const consoleStub = {
    log: (...a) => out.push(a.map(String).join(' ')),
    error: (...a) => out.push(a.map(String).join(' ')),
  };
  const processStub = {
    exit: (c) => { exitCode = c; throw new Error('__EXIT__'); },
    argv: [], env: process.env, cwd: () => process.cwd(),
  };
  // كل قراءة لـcontent.js تُعاد بالنصّ المُعطى (الحارس يقرأ ملفاً واحداً).
  const requireStub = (m) => (m === 'fs' ? { readFileSync: () => srcText } : require(m));
  try {
    new Function('require', 'console', 'process', '__dirname', guardSrc)(
      requireStub, consoleStub, processStub, path.dirname(GUARD)
    );
  } catch (e) { if (e.message !== '__EXIT__') out.push('THREW: ' + e.message); }
  const fails = out.filter((l) => l.includes('✗')).map((l) => l.trim());
  return { exitCode, fails, summary: (out.find((l) => l.includes('فحصاً ناجحاً')) || '').trim() };
}

// ── المُفسَدات ────────────────────────────────────────────────────────────────
// [الوصف · المُفسَد · عائلته]
const MUTANTS = [
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

// ── التشغيل ───────────────────────────────────────────────────────────────────
const clean = runGuard(base);
console.log('الحارس على الملف المشحون: ' + (clean.summary || '(بلا ملخّص)'));
if (clean.fails.length) {
  console.error('✗ الحارس أحمر على الملف المشحون أصلاً — لا معنى لقياس المُفسَدات قبل إصلاحه.');
  process.exit(2);
}

let caught = 0, survived = 0, skipped = 0;
const holes = [];
console.log('\nمُفسَد | الحارس يسقط؟ | أول فحصين ساقطين');
for (const [label, fn] of MUTANTS) {
  const mut = fn(base);
  if (mut === base) { console.log(`  – مُتخطّى  ${label}  (النصّ المستهدف غير موجود في هذه النسخة)`); skipped++; continue; }
  const r = runGuard(mut);
  const dropped = r.exitCode === 1 || r.fails.length > 0;
  if (dropped) { caught++; console.log(`  ✅ سقط   ${label}  (${r.fails.length})  ${r.fails.slice(0, 2).join(' | ').slice(0, 120)}`); }
  else { survived++; holes.push(label); console.log(`  ❌ مرّ    ${label}  ← ثقب في الحارس`); }
}

console.log(`\nالحصيلة: أسقط ${caught} · مرّ ${survived} · متخطّى ${skipped} (من ${MUTANTS.length})`);
if (survived) {
  console.error('✗ ثقوب مؤكَّدة (مُفسَد يمرّ من الحارس):');
  holes.forEach((h) => console.error('   - ' + h));
  process.exit(1);
}
console.log('✓ لا ثقب: كل مُفسَد أسقط الحارس.');
