/* حارس مزامنة الإضافة — يُشغَّل: node scripts/check-extension-sync.cjs
 *
 * العطل الميداني (بلاغ المالك 2026-09-15): عند قفزة الصورة فوق فجوة (صمت) كان
 * الصوت يُسحَب للخلف فيُسمع أول المقطع التالي **مرّتين**. ثم بعد الإصلاح الأول
 * بقي عطلان في الفجوات **المتقاربة** و**المتباعدة**:
 *   ١) الصوت يتقدّم على الصورة ثم «يصحّح نفسه بعد فترات» — لأن مؤقّت الحدّ كان
 *      يُطلق قبل الحدّ ببضعة أجزاء من الثانية فيجد الموضع داخل المقطع المحفوظ
 *      ⇒ لا يقفز ولا يُعيد التسليح ⇒ يعود العمل للماسح 250ms فيتراكم تقدّم.
 *   ٢) تكرار الكلمة حتى ثلاث مرات — لأن قفزتنا نفسها تُطلق `seeking` بالموضع
 *      القديم داخل الفجوة، فيُضبط `w.held` **ويُوقف الصوت**، ثم يُرسيه المؤقّت.
 *
 * هذا الملف يقرأ **نصّ الملف المشحون** لا نسخة معاد كتابتها، ويشمل اختبارات
 * سلبية داخلية: يبني نسخاً مُفسَدة تُعيد كل عطل ويتأكد أن الحارس يسقط عليها.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'browser-extension', 'content.js');
const src = fs.readFileSync(FILE, 'utf8');

let checks = 0;
const failures = [];
function ok(label, cond, detail) {
  checks++;
  if (!cond) failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
}

/** يستخرج كتلة بموازنة الأقواس من نصّ الملف المشحون. */
function extractBlock(text, opener) {
  const i = text.indexOf(opener);
  if (i < 0) return null;
  const start = text.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: text.slice(start + 1, j), full: text.slice(i, j + 1), from: i, to: j };
    }
  }
  return null;
}

/** كتلة `if (<cond>) {` الأولى بعد موضع معيّن، مع مداها. */
function ifBlockRange(body, cond) {
  const at = body.indexOf(cond);
  if (at < 0) return null;
  const open = body.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < body.length; j++) {
    if (body[j] === '{') depth++;
    else if (body[j] === '}') { depth--; if (depth === 0) return { start: at, end: j }; }
  }
  return null;
}

/** هل كل ورود لـneedle داخل كتلة الحارس في الكتلة المسمّاة؟ */
function callIsGated(text, blockOpener, guardCond, needle) {
  const block = extractBlock(text, blockOpener);
  if (!block) return false;
  const body = block.body;
  const range = ifBlockRange(body, guardCond);
  if (!range) return false;
  let at = body.indexOf(needle);
  if (at < 0) return false;
  while (at >= 0) {
    if (!(at > range.start && at < range.end)) return false;   // ورود خارج البوابة
    at = body.indexOf(needle, at + 1);
  }
  return true;
}

console.log('=== ١) الدوال النقية تُستخرج من الملف المشحون ===');
const names = ['mapFullToCut', 'isGap', 'skipVideoGaps', 'nextGapStart'];
for (const n of names) ok(`وُجدت ${n}`, !!extractBlock(src, `function ${n}(`));
if (failures.length) { console.error('✗ تعذّر الاستخراج'); process.exit(1); }
const sandbox = new Function(`${names.map((n) => extractBlock(src, `function ${n}(`).full).join('\n')}
  return { ${names.join(', ')} };`)();
const { mapFullToCut, isGap, skipVideoGaps, nextGapStart } = sandbox;

console.log('\n=== ٢) الثابت الذي يبرّر ترك الصوت بلا لمس: الخريطة مسطّحة داخل الفجوة ===');
const leading = [[12, 30]];
const mid = [[0, 10], [20, 30]];
ok('mapFullToCut(0) == mapFullToCut(12)', mapFullToCut(0, leading) === mapFullToCut(12, leading));
ok('mapFullToCut(0.2) == 0', mapFullToCut(0.2, leading) === 0);
ok('يتقدّم داخل مقطع محفوظ', mapFullToCut(20, leading) === 8);
ok('isGap: 0 صحيح و13 كاذب', isGap(0, leading) === true && isGap(13, leading) === false);

console.log('\n=== ٣) القفز وحدوده ===');
ok('فجوة أمامية: skipVideoGaps(0.2) ⟶ 12', skipVideoGaps(0.2, leading) === 12);
ok('فجوة وسطى: skipVideoGaps(15) ⟶ 20', skipVideoGaps(15, mid) === 20);
ok('داخل محفوظ: لا قفز', skipVideoGaps(5, mid) === 5);
ok('nextGapStart(0) ⟶ 12', nextGapStart(0, leading) === 12);
ok('nextGapStart(5, mid) ⟶ 10', nextGapStart(5, mid) === 10);
ok('مقاطع متلاصقة: null', nextGapStart(5, [[0, 10], [10, 20]]) === null);
ok('بعد الأخير: null', nextGapStart(35, mid) === null);
ok('بلا خريطة: null', nextGapStart(5, []) === null && nextGapStart(5, null) === null);
ok('داخل فجوة: يسلّم نقطة الهبوط', nextGapStart(15, mid) === 20);
// نقطة الهبوط المحسوبة مسبقاً في armGapJump
ok('landing = skipVideoGaps(حدّ + ε) ⟶ 12', skipVideoGaps(10 + 1e-6, mid) === 20);

console.log('\n=== ٤) حارس الانحدار ١: الصوت لا يُسحَب للخلف بعد قفزة تلقائية ===');
ok('reanchorAudio(target) محصور في كتلة w.held', callIsGated(src, 'const gapTick = (boundary, landing) =>', 'if (w.held)', 'reanchorAudio(target)'));
ok('لا إسناد لموضع الصوت في gapTick مطلقاً', !/audio\.currentTime\s*=/.test(extractBlock(src, 'const gapTick = (boundary, landing) =>').body));

console.log('\n=== ٥) حارس الانحدار ٢: قفزتنا لا تُعدّ قفزة مستخدم ===');
const seekBlock = extractBlock(src, "on(video, 'seeking', () =>");
ok('معالج seeking موجود', !!seekBlock);
ok('يتجاهل قفزتنا عبر selfSeek', /Date\.now\(\)\s*-\s*\(w\.selfSeek \|\| 0\)\s*<\s*\d+/.test(seekBlock.body));
ok('القفزة تُعلَن قبل الإسناد في gapTick', (() => {
  // قياس بالفهرس لا بنمط: أسطر الأثر أُدرجت بينهما لاحقاً فكسرت نمطاً ترتيبياً صارماً.
  const g = src.slice(src.indexOf('const gapTick ='));
  const stamp = g.indexOf('w.selfSeek = Date.now()');
  const assign = g.indexOf('try { video.currentTime = target; }');
  return stamp >= 0 && assign >= 0 && stamp < assign;
})());
ok('selfSeek مُهيَّأة في كائن الحالة', /selfSeek: 0,/.test(src));

console.log('\n=== ٦) حارس الانحدار ٣: الحدّ الدقيق أو إعادة التسليح (لا «لا شيء») ===');
const gapBody = extractBlock(src, 'const gapTick = (boundary, landing) =>').body;
const armBody = extractBlock(src, 'const armGapJump = () =>').body;
ok('gapTick تستقبل (boundary, landing)', /const gapTick = \(boundary, landing\)/.test(src));
ok('عند الإطلاق المبكر تُعيد التسليح', /now < boundary/.test(gapBody) && /gapTick\(boundary, landing\)/.test(gapBody));
ok('الهبوط محسوب مسبقاً في armGapJump', /const landing = skipVideoGaps\(boundary \+ 1e-6, kept\)/.test(armBody));
ok('الجدولة تمرّر (boundary, landing)', /gapTick\(boundary, landing\)/.test(armBody));
ok('النبضة 250ms باقية شبكة أمان', /w\.gap = setInterval\(armGapJump, 250\)/.test(src));
ok('المؤقّت يُحرَّر عند الإيقاف', /if \(w\.gapTimer\) clearTimeout\(w\.gapTimer\)/.test(src));
ok('فجوة أمامية تُقلب فوراً عند play', /kickAudio\(\);\s*\n\s*gapTick\(\);/.test(src));

console.log('\n=== ٧) الاختبارات السلبية: كل نسخة مُفسَدة يجب أن تُسقط حارسها ===');
const mutA = src.replace(/if \(w\.held\) \{\n(\s*)\/\/ A seek landed inside a removed stretch[\s\S]*?reanchorAudio\(target\);/, 'reanchorAudio(target);\n      if (w.held) {');
ok('مُفسَد أ: النداء خارج البوابة', mutA !== src);
ok('  والحارس يسقط عليه', callIsGated(mutA, 'const gapTick = (boundary, landing) =>', 'if (w.held)', 'reanchorAudio(target)') === false);

// مُفسَد د: إسناد صريح لموضع الصوت داخل gapTick (خارج البوابة) — هذا ما يحرسه
// فحص «لا إسناد للصوت»، فالمُفسَد (أ) ينقل نداءً لا إسناداً ولا يخصّه.
const mutD = src.replace(
  /(w\.selfSeek = Date\.now\(\);[^\n]*\n)/,
  '$1      audio.currentTime = 0;\n'
);
ok('مُفسَد د: إسناد صريح لموضع الصوت', mutD !== src);
ok('  والحارس يسقط عليه', /audio\.currentTime\s*=/.test(extractBlock(mutD, 'const gapTick = (boundary, landing) =>').body));

const mutB = src.replace(/if \(Date\.now\(\) - \(w\.selfSeek \|\| 0\) < 600\) return;/, '');
ok('مُفسَد ب: بلا حارس selfSeek', mutB !== src);
ok('  والحارس يسقط عليه', /Date\.now\(\)\s*-\s*\(w\.selfSeek \|\| 0\)\s*<\s*\d+/.test(extractBlock(mutB, "on(video, 'seeking', () =>").body) === false);

const mutC = src.replace(/if \(now < boundary\) \{[\s\S]*?return;\n        \}/, '');
ok('مُفسَد ج: بلا إعادة تسليح عند الإطلاق المبكر', mutC !== src);
ok('  والحارس يسقط عليه', /now < boundary/.test(extractBlock(mutC, 'const gapTick = (boundary, landing) =>').body) === false);

console.log('\n=== ٨) حُرّاس المُسجّل (trace) وإحصاء الفجوات — جولة القياس ===');
// ٨.١ المواضع الخمسة المكتوبة لموضع الصوت تبقى خمسة: أي مسار سادس للسحب للخلف يُكشف
const writes = src.match(/audio\.currentTime\s*=/g) || [];
ok(`عدد كتابات موضع الصوت = 5 (وجد ${writes.length})`, writes.length === 5);
// ٨.٢ المُسجّل مبوَّب: لا يعمل إلّا عند الطلب
ok('trace موجودة ومبوَّبة بـ w.synclog', /const trace = \(site, extra\) => \{\s*\n\s*if \(!w\.synclog\) return;/.test(src));
ok('حلقة الأثر محدودة السعة (4000 + shift)', /ring\.length > 4000\) ring\.shift\(\)/.test(src));
ok('علم المُسجّل يُقرأ من localStorage مرة واحدة', /synclog: \(\(\) => \{ try \{ return localStorage\.getItem\('hl\.synclog'\) === '1'; \} catch/.test(src));
ok('العيّنة 50ms تُنشأ فقط عند التفعيل', (() => {
  // قياس بالفهرس داخل كتلة التفعيل نفسها (النافذة السابقة 400 حرف قصُر عنها سطر load).
  const i = src.indexOf("if (w.synclog) {");
  if (i < 0) return false;
  const j = src.indexOf("w.sample = setInterval(", i);
  if (j < 0) return false;
  const between = src.slice(i, j);
  return between.includes("trace('load'") && !/\n    \}\n/.test(between);
})());
ok('العيّنة تُحرَّر **داخل** stopWatch (احتواء لا وجود)', (() => {
  // الدرس: حارس «الوجود» مرّ سابقاً والعيّنة تُحرَّر في المكان الخطأ (داخل gapTick).
  const sw = extractBlock(src, 'function stopWatch(');
  return !!sw && /clearInterval\(w\.sample\)/.test(sw.body);
})());
ok('ولا تُحرَّر العيّنة داخل gapTick', (() => {
  const g = extractBlock(src, 'const gapTick = (boundary, landing) =>');
  return !!g && !/clearInterval\(w\.sample\)/.test(g.body);
})());
// ٨.٣ نداءات الأثر عند المواضع الخمسة والقفزة
for (const site of ['2-kick-before', '3-seeking-before', '4-hold-release-before', '5-drift-periodic-before', '1-reanchor-before', 'gap-jump']) {
  ok(`نداء أثر: ${site}`, src.includes(`'${site}'`));
}
// ٨.٤ دالة إحصاء الفجوات (نقية، وتكشف «تسريب الفجوات تحت العتبة»)
const gsFn = extractBlock(src, 'function gapStats(');
ok('gapStats موجودة', !!gsFn);
const gapStats = new Function(`${gsFn.full} return gapStats;`)();
const gEmpty = gapStats(null, 0.15);
ok('بلا خريطة: أصفار', gEmpty.keptSum === 0 && gEmpty.gaps === 0 && gEmpty.smallGaps === 0);
const gContig = gapStats([[0, 10], [10, 20]], 0.15);
ok('مقاطع متلاصقة: لا فجوات', gContig.gaps === 0 && Math.abs(gContig.keptSum - 20) < 1e-9);
const gLead = gapStats([[12, 30]], 0.15);
ok('فجوة أمامية 12s: فجوة واحدة كبيرة', gLead.gaps === 1 && gLead.smallGaps === 0 && Math.abs(gLead.largestGap - 12) < 1e-9);
// الحالة التي تكشف العطل: فجوة أقصر من عتبة القفز ⇒ لا تُقفز والصوت يسبق بمقدارها
const gSmall = gapStats([[0, 10], [10.08, 20], [20.05, 30]], 0.15);
ok('فجوتان صغيرتان (80ms و50ms) تُحسبان', gSmall.smallGaps === 2 && Math.abs(gSmall.smallSeconds - 0.13) < 1e-9);
ok('مجموع المحفوظ صحيح مع الفجوات الصغيرة', Math.abs(gSmall.keptSum - 29.87) < 1e-9);
// ٨.٥ اختبار سلبي: إزالة بوابة المُسجّل تُسقط الحارس
const mutT = src.replace(/const trace = \(site, extra\) => \{\s*\n\s*if \(!w\.synclog\) return;/, 'const trace = (site, extra) => {');
ok('مُفسَد هـ: بلا بوابة synclog', mutT !== src);
ok('  والحارس يسقط عليه', /const trace = \(site, extra\) => \{\s*\n\s*if \(!w\.synclog\) return;/.test(mutT) === false);

console.log('\n=== ٩) احتواء كل أثر في موضعه (الدرس: الوجود ≠ الموضع) ===');
// ٩.١ ev-pause داخل معالج الإيقاف لا في جسم startWatch
ok('ev-pause داخل معالج pause', /on\(video, 'pause', \(\) => \{[^}]*trace\('ev-pause'\)/.test(src));
// ٩.٢ آثار الموضع ٢ حول كتابة kickAudio وحدها
const kick = extractBlock(src, 'const kickAudio = () =>');
ok('kickAudio موجودة', !!kick);
ok('2-kick-before/after داخلها', !!kick && /trace\('2-kick-before'\)/.test(kick.body) && /trace\('2-kick-after'\)/.test(kick.body));
ok('ولا أثر 4-* داخلها (كان موضوعاً خطأً)', !!kick && !/4-hold-release/.test(kick.body));
// ٩.٣ آثار الموضع ٤ داخل نبضة الانحراف (تحرير الاحتجاز) لا في kickAudio
const drift = extractBlock(src, 'w.drift = setInterval(');
ok('نبضة الانحراف موجودة', !!drift);
ok('4-hold-release-before/after داخلها', !!drift && /trace\('4-hold-release-before'\)/.test(drift.body) && /trace\('4-hold-release-after'\)/.test(drift.body));
ok('4-hold-release-before قبل تحرير الاحتجاز', !!drift && drift.body.indexOf("trace('4-hold-release-before')") < drift.body.indexOf('w.held = false'));
// ٩.٤ حقلا الحكم الجديدان في دالة trace
ok('حقل dv محسوب من صفّ الـ-before', /row\.dv = \+\(row\.a - ring\[k\]\.a\)\.toFixed\(3\)/.test(src));
ok('حقل sinceJump من وسم آخر قفزة', /row\.sinceJump = w\.selfSeek \? Math\.round\(performance\.now\(\) - w\.selfSeek\) : -1/.test(src));
// ٩.٥ العتبة الفعلية 0.5s (الحدّ من مسار Rust: min_silence 800ms − 2×keep 150ms = 500ms)
ok('العتبة في سطر load = 0.5s لا 0.15', /gapStats\(kept, 0\.5\)/.test(src) && !/gapStats\(kept, 0\.15\)/.test(src));
ok('gapStats تُرجع smallestGap', /smallestGap: 0 \}/.test(src) && /if \(!out\.smallestGap \|\| g < out\.smallestGap\)/.test(src));
ok('سطر load يطبع smallestGap و belowHalfSeconds', /smallestGap=\$\{st\.smallestGap\.toFixed\(3\)\}/.test(src) && /belowHalfSeconds=/.test(src));
// ٩.٦ اختبارات سلبية للاحتواء
const mutP = src.replace("on(video, 'pause', () => { trace('ev-pause'); audio.pause(); });", "on(video, 'pause', () => { audio.pause(); });\n    trace('ev-pause');");
ok('مُفسَد و: ev-pause خارج معالجه', mutP !== src);
ok('  والحارس يسقط عليه', /on\(video, 'pause', \(\) => \{[^}]*trace\('ev-pause'\)/.test(mutP) === false);
const mutK = src.replace(/(const kickAudio = \(\) => \{\n)/, "$1      trace('4-hold-release-before');\n");
ok('مُفسَد ح: أثر 4-* داخل kickAudio', mutK !== src);
ok('  والحارس يسقط عليه', /4-hold-release/.test(extractBlock(mutK, 'const kickAudio = () =>').body));

// مُفسَد ز: نقل تحرير العيّنة إلى داخل gapTick (حيث كان فعلاً) يجب أن يُسقط حارس الاحتواء
const mutS = src.replace(/\n    if \(w\.sample\) clearInterval\(w\.sample\);/, '').replace(
  /(\n      if \(w\.gapTimer\) clearTimeout\(w\.gapTimer\);\n)(\s+)w\.gapTimer = setTimeout/,
  '$1$2if (w.sample) clearInterval(w.sample);\n$2w.gapTimer = setTimeout'
);
ok('مُفسَد ز: تحرير العيّنة داخل gapTick', mutS !== src);
ok('  والحارس يسقط عليه', (() => {
  const sw = extractBlock(mutS, 'function stopWatch(');
  return !!sw && !/clearInterval\(w\.sample\)/.test(sw.body);
})());

console.log('');
if (failures.length) {
  console.error(`✗ فشل ${failures.length} من ${checks} فحصاً:`);
  failures.forEach((f) => console.error(`   - ${f}`));
  process.exit(1);
}
console.log(`✓ ${checks} فحصاً ناجحاً / 0 فاشل — مزامنة الإضافة محروسة على الحالتين (فجوة مفردة وفجوات متقاربة).`);
