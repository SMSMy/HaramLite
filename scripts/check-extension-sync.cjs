/* حارس مزامنة الإضافة — يُشغَّل: node scripts/check-extension-sync.cjs
 *
 * سبب وجوده (عطل ميداني 2026-09-15، أبلغ عنه المالك): عند قفزة الصورة فوق فجوة
 * (صمت 0→12s) كان الصوت يُسحَب للخلف δ (زمن اكتشاف النبضة، حتى 250ms) فيُسمع
 * أول δ من الجملة **مرّتين**. الجذر: mapFullToCut **مسطّحة داخل الفجوة**، فالصوت
 * الممتدّ أصلاً في الخطوة الصحيحة، وإعادة إرسائه تسحبه للخلف على صوت سُمِع فعلاً.
 * الإصلاح: reanchorAudio لا تُنادى إلا في حالة `w.held` (قفزة **يدوية** هبطت داخل
 * فجوة)، وقفزة الحدّ تُجدوَل بمؤقّت دقيق بدل انتظار نبضة 250ms.
 *
 * هذا الملف يقرأ **نصّ الملف المشحون** لا نسخة معاد كتابتها، ويشمل اختباراً
 * سلبياً داخلياً: يبني نسخة مُفسَدة (تعيد العطل القديم) ويتأكد أن الحارس يسقط عليها.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'browser-extension', 'content.js');
const src = fs.readFileSync(FILE, 'utf8');

let checks = 0;
let failures = [];
function ok(label, cond, detail) {
  checks++;
  if (!cond) failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
}

/** يستخرج دالة نصّية بموازنة الأقواس من نصّ الملف المشحون. */
function extractFn(text, opener) {
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

console.log('=== ١) الدوال النقية تُستخرج من الملف المشحون ===');
const names = ['mapFullToCut', 'isGap', 'skipVideoGaps', 'nextGapStart'];
const fns = {};
for (const n of names) {
  const got = extractFn(src, `function ${n}(`);
  fns[n] = got;
  ok(`وُجدت ${n}`, !!got);
}
if (failures.length) { console.error('✗ تعذّر الاستخراج'); process.exit(1); }

// sandbox: الدوال الأربع فقط
const sandbox = new Function(`${names.map((n) => fns[n].full).join('\n')}
  return { ${names.join(', ')} };`)();
const { mapFullToCut, isGap, skipVideoGaps, nextGapStart } = sandbox;

console.log('\n=== ٢) الثابت الذي يبرّر الإصلاح: الخريطة مسطّحة داخل الفجوة ===');
const leading = [[12, 30]];                       // فجوة أمامية 0→12 (حالة المالك)
ok('mapFullToCut(0) == mapFullToCut(12) عند فجوة أمامية', mapFullToCut(0, leading) === mapFullToCut(12, leading));
ok('mapFullToCut(0.2) == 0 (الصوت في الخطوة الصحيحة وهو داخل الصوت المسموع)', mapFullToCut(0.2, leading) === 0);
ok('mapFullToCut يتقدّم داخل مقطع محفوظ', mapFullToCut(20, leading) === 8);
ok('isGap(0) صحيح و isGap(13) كاذب', isGap(0, leading) === true && isGap(13, leading) === false);

console.log('\n=== ٣) القفز يقع على حدّ الفجوة ===');
const mid = [[0, 10], [20, 30]];
ok('فجوة أمامية: skipVideoGaps(0.2) ⟶ 12', skipVideoGaps(0.2, leading) === 12);
ok('فجوة وسطى: skipVideoGaps(15) ⟶ 20', skipVideoGaps(15, mid) === 20);
ok('داخل مقطع محفوظ: لا قفز', skipVideoGaps(5, mid) === 5);

console.log('\n=== ٤) جدولة الحدّ (nextGapStart) ===');
ok('فجوة أمامية: nextGapStart(0) ⟶ 12', nextGapStart(0, leading) === 12);
ok('نهاية مقطع يتبعها فجوة: nextGapStart(5, mid) ⟶ 10', nextGapStart(5, mid) === 10);
ok('مقاطع متلاصقة: لا حدّ (null)', nextGapStart(5, [[0, 10], [10, 20]]) === null);
ok('بعد آخر مقطع: null', nextGapStart(35, mid) === null);
ok('بلا خريطة (وضع clip): null', nextGapStart(5, []) === null && nextGapStart(5, null) === null);
ok('داخل مقطع محفوظ يتبعه فجوة: nextGapStart(3, mid) ⟶ 10 (حدّ القفز)', nextGapStart(3, mid) === 10);
ok('داخل فجوة حقيقية: nextGapStart(15, mid) ⟶ 20 (نقطة الهبوط)', nextGapStart(15, mid) === 20);

console.log('\n=== ٥) حارس الانحدار: الصوت لا يُسحَب للخلف بعد قفزة تلقائية ===');
/** يرجع true إذا كان نداء reanchorAudio(target) داخل كتلة `if (w.held) {` في gapTick. */
function audioReseatIsHeldGated(text) {
  const gap = extractFn(text, 'const gapTick = () =>');
  if (!gap) return false;
  const body = gap.body;
  const call = body.indexOf('reanchorAudio(target)');
  if (call < 0) return false;
  const guard = body.indexOf('if (w.held)');
  if (guard < 0 || guard > call) return false;
  // كتلة الحارس تمتد حتى إغلاق قوسها
  const open = body.indexOf('{', guard);
  let depth = 0;
  for (let j = open; j < body.length; j++) {
    if (body[j] === '{') depth++;
    else if (body[j] === '}') { depth--; if (depth === 0) return call < j; }
  }
  return false;
}
ok('نداء reanchorAudio محصور في كتلة w.held', audioReseatIsHeldGated(src));
ok('المؤقّت الدقيق موجود ويستعمل nextGapStart', /w\.gapTimer = setTimeout\(/.test(src) && /const next = nextGapStart\(/.test(src));
ok('النبضة 250ms باقية كشبكة أمان', /w\.gap = setInterval\(armGapJump, 250\)/.test(src));
ok('المؤقّت يُحرَّر عند الإيقاف', /if \(w\.gapTimer\) clearTimeout\(w\.gapTimer\)/.test(src));
ok('الفجوة الأمامية تُقلب فوراً عند play', /kickAudio\(\);\s*\n\s*gapTick\(\);/.test(src));

console.log('\n=== ٦) الاختبار السلبي: نسخة مُفسَدة تُعيد العطل القديم يجب أن تُسقط الحارس ===');
const mutant = src.replace(
  /(\n\s*)if \(w\.held\) \{\n(\s*)\/\/ A seek landed inside a removed stretch[\s\S]*?reanchorAudio\(target\);/,
  '$1reanchorAudio(target);$1if (w.held) {'
);
ok('بُنيت النسخة المُفسَدة (النداء خارج البوابة)', mutant !== src);
ok('الحارس يسقط على النسخة المُفسَدة (كما يجب)', audioReseatIsHeldGated(mutant) === false);

console.log('');
if (failures.length) {
  console.error(`✗ فشل ${failures.length} من ${checks} فحصاً:`);
  failures.forEach((f) => console.error(`   - ${f}`));
  process.exit(1);
}
console.log(`✓ ${checks} فحصاً ناجحاً / 0 فاشل — مزامنة الإضافة محروسة.`);
