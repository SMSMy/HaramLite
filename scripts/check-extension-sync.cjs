/* حارس مزامنة الإضافة — node scripts/check-extension-sync.cjs
 *
 * البنية المحروسة (بعد دمج إصدار المراجعة في content.js):
 *   • كتابة موضع الصوت **موضعان فقط**: setAudioTime (بوابة واحدة) و reanchorAudio
 *     (القفزة اليدوية، بكتم لحظي عبر seeked). أي كتابة ثالثة = فشل الحارس.
 *   • setAudioTime **ترفض أي سحب للخلف على صوت يعمل** ما لم تكن قفزة مستخدم.
 *   • kickAudio مبوَّبة: لا تُرسي صوتاً يعمل، وتتجاهل play داخل نافذة selfSeek.
 *   • النبضة الدورية **تلحق للأمام فقط** (قفزة للأمام لا تُسمع، وسحب للخلف كلمة مكررة).
 *   • طبقة قياس: gapStats + سطر load + عيّنة 40ms (tracePulse) عند التفعيل فقط.
 *
 * يقرأ **نصّ الملف المشحون** ويستخرج دواله النقية ويختبرها، ولكل ثابت مُفسَد يجب أن يُسقطه.
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

/** كتلة بموازنة الأقواس من نصّ الملف المشحون. */
function extractBlock(text, opener) {
  const i = text.indexOf(opener);
  if (i < 0) return null;
  const start = text.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return { body: text.slice(start + 1, j), full: text.slice(i, j + 1) }; }
  }
  return null;
}
const has = (block, needle) => !!block && block.body.includes(needle);

console.log('=== ١) الدوال النقية تُستخرج من الملف المشحون ===');
const names = ['mapFullToCut', 'isGap', 'skipVideoGaps', 'nextGapStart', 'gapStats', 'keptStretchAround'];
const got = {};
for (const n of names) { got[n] = extractBlock(src, `function ${n}(`); ok(`وُجدت ${n}`, !!got[n]); }
if (failures.length) { console.error('✗ تعذّر الاستخراج'); process.exit(1); }
const sb = new Function(`${names.map((n) => got[n].full).join('\n')} return { ${names.join(', ')} };`)();
const { mapFullToCut, isGap, skipVideoGaps, nextGapStart, gapStats, keptStretchAround } = sb;

console.log('\n=== ٢) الثابت الذي يبرّر «لا سحب للخلف»: الخريطة مسطّحة داخل الفجوة ===');
const leading = [[12, 30]];
const mid = [[0, 10], [20, 30]];
ok('mapFullToCut(0) == mapFullToCut(12)', mapFullToCut(0, leading) === mapFullToCut(12, leading));
ok('mapFullToCut(0.2) == 0', mapFullToCut(0.2, leading) === 0);
ok('يتقدّم داخل مقطع محفوظ', mapFullToCut(20, leading) === 8);
ok('isGap(0) صحيح و isGap(13) كاذب', isGap(0, leading) === true && isGap(13, leading) === false);

console.log('\n=== ٣) القفز وحدوده وإحصاء الفجوات ===');
ok('فجوة أمامية: skipVideoGaps(0.2) ⟶ 12', skipVideoGaps(0.2, leading) === 12);
ok('فجوة وسطى: skipVideoGaps(15) ⟶ 20', skipVideoGaps(15, mid) === 20);
ok('داخل محفوظ: لا قفز', skipVideoGaps(5, mid) === 5);
ok('nextGapStart(0) ⟶ 12', nextGapStart(0, leading) === 12);
ok('nextGapStart(5, mid) ⟶ 10', nextGapStart(5, mid) === 10);
ok('مقاطع متلاصقة: null', nextGapStart(5, [[0, 10], [10, 20]]) === null);
ok('بعد الأخير: null', nextGapStart(35, mid) === null);
ok('بلا خريطة: null', nextGapStart(5, []) === null && nextGapStart(5, null) === null);
const g0 = gapStats(null, 0.5);
ok('gapStats بلا خريطة: أصفار', g0.keptSum === 0 && g0.gaps === 0 && g0.smallestGap === 0);
const g1 = gapStats([[0, 10], [10, 20]], 0.5);
ok('مقاطع متلاصقة: لا فجوات', g1.gaps === 0 && Math.abs(g1.keptSum - 20) < 1e-9);
const g2 = gapStats([[0, 10], [10.3, 20], [20.2, 30]], 0.5);
ok('فجوتان (300ms و200ms) تُحسبان', g2.gaps === 2 && Math.abs(g2.smallestGap - 0.2) < 1e-9);
ok('أكبر فجوة تُرصَد', Math.abs(g2.largestGap - 0.3) < 1e-9);
// الخطوة ١ (مدرّج القياس): حقولها الجديدة كانت **غير محروسة إطلاقاً** — أثبتَ المشرف
// الثقب بمُفسَد فعلي: حذف حمولة `hist`/`keptBefore` كاملة من سطر load أبقى الحارس
// أخضر (131/0). هذه فحوص **سلوكية** على الحقول نفسها لا على وجود نصّها.
const g3 = gapStats([[0, 10], [10.5, 20], [22, 30], [33, 40], [48, 60], [69, 80]], 0.5);
ok('hist: خمسة نطاقات نصف مفتوحة [0.5,1) [1,2) [2,4) [4,8) ≥8',
  JSON.stringify(g3.hist) === JSON.stringify([1, 0, 2, 0, 2]));
ok('before: أدنى ووسيط المقطع المحفوظ السابق (7 و 9.5)',
  Math.abs(g3.before.min - 7) < 1e-9 && Math.abs(g3.before.median - 9.5) < 1e-9);
const g4 = gapStats([[12, 30], [33, 40]], 0.5);
ok('فجوة أمامية: تُحصى في hist ولا تُدخل صفراً مُصطنعاً في before',
  g4.hist[4] === 1 && g4.hist[2] === 1 && Math.abs(g4.before.min - 18) < 1e-9 && Math.abs(g4.before.median - 18) < 1e-9);
const g5 = gapStats([[0, 10], [10.5, 20], [22, 30]], 0.5);
ok('وسيط العدّ الزوجي = متوسط العنصرين الأوسطين (9.75)',
  Math.abs(g5.before.median - 9.75) < 1e-9);

console.log('\n=== ٤) بوابة واحدة: كتابتان فقط لموضع الصوت ===');
const writes = src.match(/audio\.currentTime\s*=/g) || [];
ok(`عدد كتابات موضع الصوت = 2 (وجد ${writes.length})`, writes.length === 2);
const gate = extractBlock(src, 'const setAudioTime = (site, want, allowBack) =>');
const reanchor = extractBlock(src, 'const reanchorAudio = (fullT) =>');
ok('setAudioTime موجودة', !!gate);
ok('reanchorAudio موجودة', !!reanchor);
ok('كتابة داخل setAudioTime', has(gate, 'audio.currentTime = want'));
ok('كتابة داخل reanchorAudio', has(reanchor, 'audio.currentTime = want'));
ok('kickAudio لا تكتب مباشرة', !has(extractBlock(src, 'const kickAudio = () =>'), 'audio.currentTime ='));
ok('gapTick لا تكتب الصوت', !has(extractBlock(src, 'const gapTick = (boundary, landing) =>'), 'audio.currentTime ='));

console.log('\n=== ٥) الحارس البنيوي: لا سحب للخلف على صوت يعمل ===');
ok('شرط الرفض موجود (allowBack + paused + delta)', /if \(!allowBack && !audio\.paused && delta > 0\.05\)/.test(gate.body));
ok('الرفض يسبق الكتابة (ترتيب بالفهرس)', gate.body.indexOf('!allowBack && !audio.paused') < gate.body.indexOf('audio.currentTime = want'));
ok('الرفض يُسجَّل في الأثر', /trace\(site \+ '-skip', 'no-rewind'\)/.test(gate.body));
ok('الفرق المُوقَّع يُسجَّل عند البوابة', /trace\(site, `d=\$\{delta\.toFixed\(3\)\}`\)/.test(gate.body));
ok('تسامح 0.05s قبل الكتابة', /!\(Math\.abs\(delta\) > 0\.05\)/.test(gate.body));

console.log('\n=== ٦) مواضع النداء وأعلام السماح بالرجوع ===');
ok('kick: allowBack=false', /setAudioTime\('kick', audioPos\(\), false\)/.test(src));
ok('seeking: allowBack=true (قفزة مستخدم)', /setAudioTime\('seeking', want, true\)/.test(src));
ok('held-release: allowBack=true', /setAudioTime\('held-release', audioPos\(\), true\)/.test(src));
ok('drift: allowBack=false', /setAudioTime\('drift', expect, false\)/.test(src));
ok('نداء kick داخل kickAudio', has(extractBlock(src, 'const kickAudio = () =>'), "setAudioTime('kick'"));

console.log('\n=== ٧) kickAudio مبوَّبة ===');
const kick = extractBlock(src, 'const kickAudio = () =>');
ok('تتجاهل play داخل نافذة selfSeek', /Date\.now\(\) - \(w\.selfSeek \|\| 0\) < SELF_SEEK_MS/.test(kick.body));
ok('تُرسي فقط صوتاً متوقفاً', /else if \(audio\.paused\)/.test(kick.body));
ok('تسجّل تخطّي الإرساء على صوت يعمل', /trace\('kick-skip', 'playing'\)/.test(kick.body));

console.log('\n=== ٨) نبضة الانحراف غير متماثلة: تلحق للأمام فقط ===');
const drift = extractBlock(src, 'w.drift = setInterval(');
ok('تتجاهل صوتاً متوقفاً', /if \(audio\.paused\) return;/.test(drift.body));
ok('تتجاهل ما بعد قفزتنا (نافذة selfSeek)', /Date\.now\(\) - \(w\.selfSeek \|\| 0\) < SELF_SEEK_MS\) return;/.test(drift.body));
ok('تتجاهل أثناء وجود الصورة في فجوة (التخطي إجباريّ: بلا شرط خيار)', /if \(isGap\(video\.currentTime \|\| 0, kept\)\) return;/.test(drift.body) && !/skipping/.test(drift.body));
ok('شرط الإلحاق أمامي فقط (lead < -0.35)', /const lead = audio\.currentTime - expect;/.test(drift.body) && /lead < -0\.35/.test(drift.body));
ok('لا يوجد شرط متماثل يكتب للخلف', !/Math\.abs\(audio\.currentTime - expect\)/.test(drift.body));

console.log('\n=== ٩) نافذة selfSeek موحّدة 1200ms ===');
ok('SELF_SEEK_MS = 1200 معرّفة', /const SELF_SEEK_MS = 1200;/.test(src));
ok('تُستعمل في معالج seeking', /if \(Date\.now\(\) - \(w\.selfSeek \|\| 0\) < SELF_SEEK_MS\) return;/.test(extractBlock(src, "on(video, 'seeking', () =>").body));
ok('وتُستعمل في kickAudio وفي النبضة', (src.match(/SELF_SEEK_MS/g) || []).length >= 4);

console.log('\n=== ١٠) طبقة القياس: load · gapStats · عيّنة 40ms ===');
ok('العتبة 0.5s (الحدّ من Rust: 800 − 2×150)', /gapStats\(kept, 0\.5\)/.test(src));
ok('سطر load يطبع smallestGap', /smallestGap=\$\{st\.smallestGap\.toFixed\(3\)\}/.test(src));
ok('سطر load يطبع diff مقابل مدة الصوت', /diff=\$\{\(st\.keptSum - ad\)\.toFixed\(3\)\}/.test(src));
ok('سطر load يطبع مدرّج الفجوات hist', /hist=\[\$\{st\.hist\.join\(','\)\}\]/.test(src));
ok('سطر load يطبع keptBefore (أدنى ووسيط)', /keptBefore=\{min:\$\{st\.before\.min\.toFixed\(3\)\},med:\$\{st\.before\.median\.toFixed\(3\)\}\}/.test(src));
ok('العيّنة 40ms مبوَّبة بـ slog', /if \(slog\) w\.tracePulse = setInterval\(/.test(src));
ok('العيّنة تُحرَّر **داخل** stopWatch', has(extractBlock(src, 'function stopWatch('), 'clearInterval(w.tracePulse)'));
ok('أثر الإيقاف داخل معالج pause (قبل إيقاف الصوت)', (() => {
  const p = extractBlock(src, "on(video, 'pause', () =>");
  return has(p, "trace('pause')") && p.body.indexOf("trace('pause')") < p.body.indexOf('audio.pause()');
})());
ok('المُسجّل معطّل افتراضياً', /localStorage\.getItem\('hl\.synclog'\) === '1'/.test(src));
ok('حلقة الأثر محدودة السعة', /window\.__hlSync\.length > 4000\) window\.__hlSync\.shift\(\)/.test(src));

console.log('\n=== ١٠-أ) عود trace: لا نداء ذاتي إلّا ببوابة علم تُضبط قبل النداء ===');
// العطل المُقاس (دخل في 89c78e1): نصّ سطر القياس load كان موضوعاً في جسم trace
// **بلا بوابة**، فكان trace ينادي نفسه أبداً حتى RangeError: Maximum call stack
// size exceeded، ولا يصل صفّ واحد إلى window.__hlSync. الحارس يجعل العود
// مستحيلاً بالبناء لا مجرّد «غير موجود الآن»، على ثلاث طبقات:
//   (١) بنيوية: كل نداء trace داخل جسم trace مقترن بصيغة البوابة الواحدة،
//       والعلم يُضبط **قبل** النداء (وإلا فالبوابة بعده ⇒ عود في أي مسار متداخل).
//   (٢) مجال: loadLogged معرَّف في كائن الحالة w داخل startWatch ⇒ يُصفَّر مع كل
//       جلسة مشاهدة جديدة، فلا يمنع الإصلاحُ سطرَ load في الجلسة التالية.
//   (٣) سلوكية: نُنفّذ نصّ trace المستخرج فعلياً في Node بـ slog=true، ونعدّ
//       تنفيذات جسم القياس والصفوف. طبقة تسقط مُفسَداً بنيوياً معقّداً لا يراه
//       التعبير النمطي وحده (مثل بوابة تُقرأ بعد النداء أو علم لا يُقفل أبداً).
const trBlock = extractBlock(src, 'const trace = (site, extra) =>');
ok('استُخرج جسم trace', !!trBlock);
const trBody = trBlock ? trBlock.body : '';
// النداء الذاتي الوحيد المسموح هو سطر القياس load، ويجب أن يكون **داخل** مدى بوابة
// العلم (لا قبله ولا بعد إغلاقها): البوابة تغلّف جسم السطر كاملاً، وهو أعمق من أن
// يكفي فيه الجوار المباشر. المدى يُحسب بموازنة الأقواس من `{` البوابة.
function braceEnd(text, openIdx) {
  let depth = 0;
  for (let j = openIdx; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}
const GATE_RE = /if \(slog && !w\.loadLogged && isFinite\(audio\.duration\) && audio\.duration > 0\) \{/g;
const gateHits = [];
let gm;
while ((gm = GATE_RE.exec(trBody)) !== null) {
  gateHits.push({ start: gm.index, end: braceEnd(trBody, gm.index + gm[0].length - 1) });
}
const selfCallCount = (trBody.match(/trace\(/g) || []).length;
// نداء داخل مدى البوابة: بدايته بعد `{` البوابة وقبل `}` الخاص بها.
const enclosed = (at) => gateHits.some((h) => at > h.start && h.end > at);
const allEnclosed = (() => {
  let at = -1;
  while ((at = trBody.indexOf('trace(', at + 1)) >= 0) if (!enclosed(at)) return false;
  return true;
})();
ok('كل نداء ذاتي داخل trace يقع **داخل** بوابة العلم', allEnclosed,
  `نداءات ذاتية=${selfCallCount} بوابات=${gateHits.length} محاطة=${gateHits.filter((h) => h.end > 0).length}`);
ok('البوابة تشترط !w.loadLogged (لا تُقرأ بعد النداء)', /if \(slog && !w\.loadLogged/.test(trBody));
// شرط الصلاحية: `!w.loadLogged` وحده يُقفل العلم على أول نداء — وقد يسبق جهوزية
// المدة فيُصدَر audioDur=0 وdiff=keptSum (رقم مضلِّل) ولا يُعاد السطر أبداً في
// الجلسة. فالفحص يطلب مقارنة موجبة صريحة على audio.duration، ويرفض القلب (< 0).
const gateCond = (trBody.match(/if \(slog[^{]*\) \{/) || [''])[0];
ok('البوابة تشترط صلاحية مدة الصوت audio.duration > 0', /audio\.duration\s*>\s*0/.test(gateCond) || /audio\.duration\s*>=\s*1/.test(gateCond),
  `الشرط=${gateCond.trim()}`);
ok('ولا تقبل قلب الشرط (audio.duration < 0 ونحوه)', !/audio\.duration\s*(<|<=)/.test(gateCond));
ok('صيغة بوابة واحدة بلا تكرار أو تبديل ترتيب', gateHits.length === 1 && gateHits[0].end > 0);
ok('العلم يُضبط **قبل** النداء الذاتي', (() => {
  const set = trBody.indexOf('w.loadLogged = true;');
  const call = trBody.indexOf("trace('load'");
  return set >= 0 && call > set;
})());
ok('loadLogged معرَّف في كائن الحالة', /loadLogged:\s*false,/.test(src));
ok('وتعريفه داخل startWatch (يُصفَّر كل جلسة، لا حالة عامة)', /async function startWatch\(\)[\s\S]*loadLogged: false,/.test(src));

// دليل تشغيلي: نُنفّذ نصّ trace نفسه مع بدائل بسيطة، والمعطّل مفعَّل (slog=true).
// ملاحظة: extractBlock.body هو ما **بين** القوسين، فالتوقيع `(site, extra) => {`
// يعاد بناؤه هنا صراحةً — وبدونه لا تُعرَّف site فيسقط الدليل بخطأ لا علاقة له بالعطل.
const buildTrace = new Function('guard', [
  'const kept = guard.kept;',
  'const audio = guard.audio;',
  'const video = guard.video;',
  'const w = guard.w;',
  'const slog = guard.slog;',
  'const window = guard.window;',
  'const console = guard.console;',
  'const gapStats = guard.gapStats;',
  'const isGap = guard.isGap;',
  'const audioPos = () => { const t = (video.currentTime || 0) - 20; return Math.min(Math.max(t, 0), Math.max(audio.duration - 0.05, 0)); };',
  'const trace = (site, extra) => {',
  trBody.replace('const st = gapStats(kept, 0.5);', 'const st = guard.statsCount();'),
  '};',
  'return { trace, w };',
].join('\n'));
let rtErr = null, rtBodies = 0, rtRows = 0, rtLoads = 0, rtFirst = '';
const ring = [];
const stats = { keptSum: 30, gaps: 1, smallestGap: 0.4, smallGaps: 1, smallSeconds: 0.4, largestGap: 0.4, hist: [1, 0, 0, 0, 0], before: { min: 3, median: 3 } };
const mkGuard = (dur) => ({
  kept: [[0, 10]],
  audio: { currentTime: 3, duration: dur },
  video: { currentTime: 23, duration: 30 },
  w: { held: false, selfSeek: 0, loadLogged: false },
  slog: true,
  window: { __hlSync: ring },
  console: { log() {} },
  gapStats: () => stats,
  isGap: () => false,
  statsCount: () => { rtBodies++; return stats; },
});
try {
  const made = buildTrace(mkGuard(30));
  made.trace('startup', 'boot');                       // أول نداء في الجلسة
  for (let i = 0; i < 25; i++) made.trace('tick');      // نبضات دورية بعده
  rtRows = ring.length;
  rtLoads = ring.filter((r) => r.site === 'load').length;
  rtFirst = ring.length ? ring[0].site : '';
} catch (e) { rtErr = e; }
ok('لا RangeError: أثر trace المفعَّل لا ينادي نفسه أبداً', rtErr === null, rtErr ? String(rtErr.message) : '');
ok('جسم القياس يُنفَّذ **مرّة واحدة** في الجلسة', rtBodies === 1, `تنفيذات=${rtBodies}`);
ok('صفّ load واحد بالضبط في window.__hlSync', rtLoads === 1, `load=${rtLoads}`);
ok('بلا صفوف مكرّرة من العود (27 نداءً ⇒ 27 صفّاً)', rtRows === 27, `صفوف=${rtRows}`);
ok('وسطر load هو أول صفّ يُصدَر', rtFirst === 'load', `أول صفّ=${rtFirst}`);

// حالة عدم الجهوزية: المدة صفر في أول نداء ثم تصير 30 في نداء لاحق. البوابة يجب أن
// **تنتظر** ولا تُقفل العلم على قياس صفري (audioDur=0 وdiff=keptSum رقم مضلِّل).
const ring2 = [];
let rtBodies2 = 0;
let waitErr = null, waitLoads = 0, waitDur = null, waitBodies = 0, waitRows = 0, waitFirstAt = -1;
try {
  const g2 = mkGuard(0);
  g2.window = { __hlSync: ring2 };
  g2.statsCount = () => { rtBodies2++; return stats; };
  const made2 = buildTrace(g2);
  for (let i = 0; i < 5; i++) made2.trace('tick-zero');   // مدة = 0 ⇒ لا سطر قياس
  waitRows = ring2.length;
  made2.trace('still-zero');                              // ما زالت صفراً
  waitRows = ring2.length;
  g2.audio.duration = 30;                                 // صارت المدة صالحة
  made2.trace('now-ready');
  made2.trace('after');
  waitRows = ring2.length;
  const waitLoadsRows = ring2.filter((r) => r.site === 'load');
  waitLoads = waitLoadsRows.length;
  waitDur = waitLoadsRows.length ? /audioDur=([\d.]+)/.exec(waitLoadsRows[0].drift || '') : null;
  waitDur = waitDur ? waitDur[1] : null;
  waitBodies = rtBodies2;
  waitFirstAt = ring2.findIndex((r) => r.site === 'load');
} catch (e) { waitErr = e; }
ok('مدة صفرية: لا يُصدَر سطر load ولا يُقفل العلم', waitErr === null && waitRows > 0 && ring2.filter((r) => r.site === 'load').length <= 1,
  waitErr ? String(waitErr.message) : `صفوف=${waitRows} load=${ring2.filter((r) => r.site === 'load').length}`);
ok('مدة صفرية: جسم القياس لا يُنفَّذ ولو مرّة قبل الجهوزية', (() => {
  // نعيد المشهد ونفحص قبل إتاحة المدة
  const ring3 = [];
  const g3 = mkGuard(0);
  g3.window = { __hlSync: ring3 };
  let bodies3 = 0;
  g3.statsCount = () => { bodies3++; return stats; };
  const made3 = buildTrace(g3);
  for (let i = 0; i < 5; i++) made3.trace('zero');
  return bodies3 === 0 && ring3.filter((r) => r.site === 'load').length === 0;
})());
ok('ثم مدة صالحة: صفّ load واحد فقط (لم يُهدر)', waitLoads === 1, `load=${waitLoads}`);
ok('والصفّ يحمل audioDur غير صفري (30.000)', waitDur === '30.000', `audioDur=${waitDur}`);
ok('ووقعت عند أول نداء بعد الجهوزية', waitFirstAt > 0, `index=${waitFirstAt}`);
ok('ولا تكرار للقياس بعد الجهوزية (تنفيذ واحد)', waitBodies === 1, `تنفيذات=${waitBodies}`);

console.log('\n=== ١٠-ب) الخطوة ١ (مدرّج القياس): مُفسَدات يجب أن تُسقط فحوص حقولها ===');
// الثقب المُثبَت (قبل هذا القسم): حمولة `hist`/`keptBefore` تُحذف كاملة من سطر load
// ويبقى الحارس أخضر. فحص السقوط هنا **سلوكي**: يُعاد استخراج gapStats من نصّ المُفسَد
// ويُشغَّل على ثلاث خرائط معروفة، مع فحص نصّي لحمولة سطر load.
const stepOneFell = (text) => {
  const bad = [];
  if (!/hist=\[\$\{st\.hist\.join\(','\)\}\]/.test(text)) bad.push('سطر load بلا hist');
  if (!/keptBefore=\{min:/.test(text)) bad.push('سطر load بلا keptBefore');
  const b = extractBlock(text, 'function gapStats(');
  if (!b) return bad.concat('تعذّر استخراج gapStats');
  let f;
  try { f = new Function(`${b.full} return gapStats;`)(); } catch { return bad.concat('تعذّر بناء gapStats'); }
  const g = f([[0, 10], [10.5, 20], [22, 30], [33, 40], [48, 60], [69, 80]], 0.5);
  if (JSON.stringify(g.hist) !== JSON.stringify([1, 0, 2, 0, 2])) bad.push('hist');
  if (!(Math.abs(g.before.min - 7) < 1e-9 && Math.abs(g.before.median - 9.5) < 1e-9)) bad.push('before');
  const ge = f([[0, 10], [10.5, 20], [22, 30]], 0.5);
  if (!(Math.abs(ge.before.median - 9.75) < 1e-9)) bad.push('وسيط زوجي');
  const gl = f([[12, 30], [33, 40]], 0.5);
  if (!(Math.abs(gl.before.min - 18) < 1e-9 && Math.abs(gl.before.median - 18) < 1e-9)) bad.push('فجوة أمامية');
  return bad;
};
const stepOneMuts = [
  ['ح: حذف حمولة hist/keptBefore من سطر load', src.replace(/ hist=\[\$\{st\.hist\.join\(','\)\}\] keptBefore=\{min:\$\{st\.before\.min\.toFixed\(3\)\},med:\$\{st\.before\.median\.toFixed\(3\)\}\}/, '')],
  ['خ: الوسيط الزوجي يأخذ العنصر الأعلى وحده', src.replace(/\(befores\[mid - 1\] \+ befores\[mid\]\) \/ 2/, 'befores[mid]')],
  ['ذ: توسيع النطاق الثاني ليبتلع 2–3 ثوان', src.replace(/else if \(g < 2\) out\.hist\[1\]\+\+;/, 'else if (g < 3) out.hist[1]++;')],
  ['ر: الفجوة الأمامية تُدخل صفراً مُصطنعاً في before', src.replace(/if \(prevLen > 0\) befores\.push\(prevLen\);/, 'befores.push(prevLen);')],
];
for (const [label, mutant] of stepOneMuts) {
  const fell = mutant !== src ? stepOneFell(mutant) : [];
  ok(`مُفسَد ${label}`, mutant !== src);
  ok(`  والحارس يسقط عليه (سقط: ${fell.join(' · ') || 'لا شيء'})`, mutant !== src && fell.length > 0);
}

console.log('\n=== ١١) الاختبارات السلبية: كل مُفسَد يجب أن يُسقط حارسه ===');
const muts = [
  ['أ: حذف الحارس البنيوي (سحب للخلف مسموح)', src.replace(/if \(!allowBack && !audio\.paused && delta > 0\.05\) \{/, 'if (false) {'),
    (s) => !/if \(!allowBack && !audio\.paused && delta > 0\.05\)/.test(s)],
  ['ب: جعل النبضة متماثلة (سحب للخلف)', src.replace(/lead < -0\.35/, 'Math.abs(lead) > 0.35'),
    (s) => /Math\.abs\(lead\) > 0\.35/.test(s)],
  ['ج: إزالة بوابة kickAudio', src.replace(/trace\('kick-skip', 'selfSeek'\);/, ''),
    (s) => !/trace\('kick-skip', 'selfSeek'\)/.test(s)],
  ['د: إخراج أثر الإيقاف من معالجه', src.replace(
    "      trace('pause');\n      paceExit('pause');\n      audio.pause();\n",
    "      paceExit('pause');\n      audio.pause();\n    });\n    trace('pause');\n    on(video, 'pause', () => {\n"),
    (s) => !has(extractBlock(s, "on(video, 'pause', () =>"), "trace('pause')")],
  ['هـ: إزالة تحرير العيّنة من stopWatch', src.replace(/\n    if \(w\.tracePulse\) clearInterval\(w\.tracePulse\);/, ''),
    (s) => !/clearInterval\(w\.tracePulse\)/.test(s)],
  ['م: عود غير مقيَّد — إزالة بوابة العلم كلها عن النداء الذاتي', src.replace(/if \(slog && !w\.loadLogged && isFinite\(audio\.duration\) && audio\.duration > 0\) \{\n\s*w\.loadLogged = true;\n/, 'if (slog) {\n'),
    // الحارس يسقط: انعدام بوابة ⇒ لا مدى يُحاط به النداء الذاتي (قياس ١٠-أ نفسه).
    (s, body) => {
      const hits = [...body.matchAll(/if \(slog && !w\.loadLogged[^{]*\) \{/g)];
      const at = body.indexOf("trace('load'");
      return at >= 0 && !hits.some((h) => at > h.index && braceEnd(body, h.index + h[0].length - 1) > at);
    }],
  ['ص: إزالة شرط صلاحية المدة — العلم يُقفل على قياس صفري مضلِّل', src.replace(/ && isFinite\(audio\.duration\) && audio\.duration > 0/, ''),
    (s, body) => {
      // الحارس يسقط: الشرط بلا مقارنة موجبة على مدة الصوت ⇒ يقبل audioDur=0.
      const cond = (body.match(/if \(slog[^{]*\) \{/) || [''])[0];
      return !/audio\.duration\s*>\s*0/.test(cond) && !/audio\.duration\s*>=\s*1/.test(cond);
    }],
  ['ق: قلب شرط الصلاحية (audio.duration < 0 يقبل الصفر)', src.replace(/audio\.duration > 0\) \{/, 'audio.duration < 0) {'),
    (s, body) => /audio\.duration\s*(<|<=)/.test((body.match(/if \(slog[^{]*\) \{/) || [''])[0])],
  ['ن: تعطيل الإصلاح — العلم يُضبط false أبداً فلا تُقفل البوابة', src.replace(/w\.loadLogged = true;/, 'w.loadLogged = false;'),
    (s) => (s.match(/w\.loadLogged = true;/g) || []).length !== 1],
  ['س: ترتيب مقلوب — إسناد العلم هبط تحت النداء (أو غاب)', src.replace(/\n\s*w\.loadLogged = true;/, ''),
    // الحارس يسقط: الإسناد إمّا غائب (indexOf = −1) أو يقع بعد النداء ⇒ البوابة
    // لا تُقفل قبل النداء في أي مسار متداخل، وهو عين العود المُقاس.
    (s, body) => { const set = body.indexOf('w.loadLogged = true;'); return set < 0 || set > body.indexOf("trace('load'"); }],
  ['ع: حذف حقل loadLogged من كائن الحالة', src.replace(/\n\s*loadLogged: false, \/\/[^\n]*/, ''),
    (s) => /loadLogged:\s*false,/.test(s) === false],
  ['و: إضافة كتابة ثالثة لموضع الصوت', src.replace(/(const gapTick = \(boundary, landing\) => \{\n)/, '$1      audio.currentTime = 0;\n'),
    (s) => (s.match(/audio\.currentTime\s*=/g) || []).length !== 2],
];
for (const [label, mutant, trips] of muts) {
  ok(`مُفسَد ${label}`, mutant !== src);
  const mt = mutant !== src ? extractBlock(mutant, 'const trace = (site, extra) =>') : null;
  const mb = mt ? mt.body : '';
  ok('  والحارس يسقط عليه', mutant !== src && trips(mutant, mb) === true);
}

console.log('\n=== ١٢) تجمّد المشغّل: احتجاز الصوت ثم إرساؤه (بلاغ «الفيديو يقف قليلاً بعد التخطي») ===');
ok('حقل stalled في الحالة', /stalled: false,/.test(src));
ok('حقل pendingLead في الحالة', /pendingLead: null,/.test(src));
ok('معالج waiting يُحتجز', /on\(video, 'waiting', stallHold\)/.test(src));
ok('معالج stalled يُحتجز', /on\(video, 'stalled', stallHold\)/.test(src));
ok('معالج playing يُرسي ويستأنف', /on\(video, 'playing', stallRelease\)/.test(src));
const stallFn = extractBlock(src, 'const stallHold = () =>');
ok('الاحتجاز يوقف الصوت ويسجّل', has(stallFn, 'audio.pause()') && has(stallFn, "trace('stall', 'hold')"));
const releaseFn = extractBlock(src, 'const stallRelease = () =>');
ok('الإرساء يُسمح فيه بالسحب للخلف (الموضع الوحيد بلا قفزة مستخدم)', /setAudioTime\('stall-release', audioPos\(\), true\)/.test(releaseFn ? releaseFn.body : ''));
ok('الإرساء يستأنف التشغيل', has(releaseFn, 'audio.play()'));

console.log('\n=== ١٣) التقدّم المستمر: تصحيح خلفي **مؤكَّد** فقط ===');
const drift2 = extractBlock(src, 'w.drift = setInterval(');
ok('النبضة تتجاهل زمن التجمّد', /if \(w\.stalled\) return;/.test(drift2.body));
ok('التجمّد يُفحص **قبل** حساب الموضع المتوقّع', drift2.body.indexOf('if (w.stalled) return;') < drift2.body.indexOf('const expect = audioPos()'));
ok('إلحاق أمامي بلا سماح بالرجوع', /setAudioTime\('drift', expect, false\)/.test(drift2.body));
ok('السحب للخلف مشروط بتكرار التقدّم', /w\.pendingLead && Math\.abs\(lead - w\.pendingLead\) < 0\.35/.test(drift2.body));
ok('والمؤكَّد يُسمح له بالرجوع ويُوسَم', /setAudioTime\('drift-confirmed', expect, true\)/.test(drift2.body) && /confirmed-backward/.test(drift2.body));
ok('التقدّم غير المؤكَّد يُسجَّل ولا يُنفَّذ', /pending-lead/.test(drift2.body) && /w\.pendingLead = lead;/.test(drift2.body));

console.log('\n=== ١٤) اختبارات سلبية للوقفة والتقدّم ===');
const m1 = src.replace(/    on\(video, 'waiting', stallHold\);\n/, '');
ok('مُفسَد ط: بلا احتجاز عند التجمّد', m1 !== src);
ok('  والحارس يسقط عليه', /on\(video, 'waiting', stallHold\)/.test(m1) === false);
const m2 = src.replace(/      if \(w\.stalled\) return;   \/\/ الصورة متجمّدة[^\n]*\n/, '');
ok('مُفسَد ي: النبضة تعمل أثناء التجمّد', m2 !== src);
ok('  والحارس يسقط عليه', /if \(w\.stalled\) return;/.test(extractBlock(m2, 'w.drift = setInterval(').body) === false);
const m3 = src.replace(/w\.pendingLead && Math\.abs\(lead - w\.pendingLead\) < 0\.35/, 'true');
ok('مُفسَد ك: تصحيح خلفي بلا تأكيد', m3 !== src);
ok('  والحارس يسقط عليه', /w\.pendingLead && Math\.abs\(lead - w\.pendingLead\) < 0\.35/.test(m3) === false);

console.log('\n=== ١٥) السلوك إجباريّ: صفر إشارة إلى خيار المستخدم المحذوف ===');
// قرار المالك «اجباري لكل مستخدم لا خيار لتعديلها»: لا صندوق `hl-ext-skipgaps`،
// ولا مفتاح تخزين `hl.skipgaps`، ولا ثابت `SKIP_GAPS` ولا بوابة `skipChecked`
// في الملف المشحون — وعودة أيٍّ منها تُسقط هذا الفحص.
const NO_OPTION = /hl-ext-skipgaps|hl\.skipgaps|SKIP_GAPS|skipChecked/;
ok('صفر إشارة إلى خيار تخطي الفجوات (صندوق · مفتاح · ثابت · بوابة)', !NO_OPTION.test(src));
const m4 = src.replace(/(const T = \{)/, "$1\n  const LEGACY_SKIP_KEY = 'hl.skipgaps';\n");
ok('مُفسَد ل: إعادة إشارة إلى خيار المستخدم', m4 !== src);
ok('  والحارس يسقط عليه', m4 !== src && NO_OPTION.test(m4) === true);

console.log('\n=== ١٦) planGap: دالة قرار نقية لكل فجوة (الخطوة ٣ — وموصولة في ٤) ===');
// الاستخراج بآلية extractBlock القائمة نفسها، بلا تغيير فيها: توقيع planGap يجعل أول
// قوس في نصّها قوسَ متنها (والتفكيك داخل الجسم) فتُستخرج استدعاءً واحداً كما تُستخرج
// بقية الدوال النقية. (وسائط مفكَّكة تجعل أول قوس قوسَ الوسائط، فيعود الاستخراج نصّاً
// غير صالح ويُسقط الحارس كله بـSyntaxError — قيس ذلك فعلاً.)
function buildPlanGap(text) {
  const block = extractBlock(text, 'function planGap(');
  if (!block) return null;
  try { return new Function(`return ${block.full};`)(); } catch { return null; }
}
// القواعد الأربع بنصّها المشحون — لفحص ترتيبها (١٦) وللمُفسَدات (١٧).
const RULE1 = "if (gap < cfg.cutBelow) return { mode: 'cut', reason: 'tiny' };";
const RULE2 = "if (keptBefore >= cfg.isolated && keptAfter >= cfg.isolated) return { mode: 'cut', reason: 'isolated' };";
const RULE3 = "if (gap > cfg.maxSpeedGap) return { mode: 'cut', reason: 'long' };";
const RULE4 = "if (gap / rate > cfg.maxDwell) return { mode: 'cut', reason: 'dwell' };\n";
const planSig = extractBlock(src, 'function planGap(');
const sigHead = planSig ? planSig.full.slice(0, 60).replace(/\s+/g, ' ') : 'لا شيء';
ok(`التوقيع المستخرج **جسم الدالة** لا قوس الوسائط — أوله: ${sigHead}`,
  !!planSig && /^function planGap\(input, cfg\) \{/.test(planSig.full) && planSig.full.length > 60);
ok('التفكيك داخل الجسم (عقد النداء كما في §٣: كائن الفجوة { gap, keptBefore, keptAfter } ثم cfg)',
  !!planSig && planSig.body.includes('const { gap, keptBefore, keptAfter } = input;'));
ok('القواعد الأربع بترتيبها في المتن (١ < ٢ < ٣ < ٤)', (() => {
  const at = [RULE1, RULE2, RULE3, RULE4].map((r) => planSig.body.indexOf(r));
  return at.every((v) => v >= 0) && at.every((v, i) => i === 0 || at[i - 1] < v);
})());
const planGap = buildPlanGap(src);
ok('planGap تُبنى دالةً من نصّ الملف المشحون', typeof planGap === 'function');
if (typeof planGap !== 'function') { console.error('✗ تعذّر بناء planGap من الملف المشحون'); process.exit(1); }
// وعد الخطوة ٣ انتهى بوصله في الخطوة ٤: الدالة **تُنادى** والثابت **يُقرأ** — وفحوص
// الوصل الحقيقية (من أين يُنادى، ومَن يقرأ العتبات، وهل بقيت الدالة نقية) في القسم ١٨.
ok('الوصل وقع: planGap لها نداء (تعريف + نداء = 2) وPACE_CFG يُقرأ (تعريف + قراءة = 2)',
  (src.match(/planGap\(/g) || []).length === 2 && (src.match(/PACE_CFG/g) || []).length === 2);

// العتبات: تُستخرج من الملف المشحون، وتُطابَق بالقيم الابتدائية المعتمدة حرفياً.
// (‏extractBlock تُرجع المتن في `body` و`full` يحمل بادئة `const PACE_CFG = ` ⇒ يُقرأ المتن.)
const cfgOf = (text) => {
  const block = extractBlock(text, 'const PACE_CFG =');
  if (!block) return null;
  try { return new Function(`return ({${block.body}});`)(); } catch { return null; }
};
const shippedCfg = cfgOf(src);
const CFG = { cutBelow: 0.6, isolated: 20, maxSpeedGap: 6, targetDwell: 1.0, rate: 3.0, maxDwell: 1.5 };
ok('PACE_CFG يُستخرج كائناً من الملف المشحون', !!shippedCfg && typeof shippedCfg === 'object');
if (!shippedCfg) { console.error('✗ تعذّر استخراج PACE_CFG'); process.exit(1); }
ok('cutBelow: 0.6 حرفياً', /cutBelow: 0\.6,/.test(src));
ok('isolated: 20 حرفياً', /isolated: 20,/.test(src));
ok('maxSpeedGap: 6 حرفياً', /maxSpeedGap: 6,/.test(src));
ok('targetDwell: 1.0 حرفياً', /targetDwell: 1\.0,/.test(src));
ok('rate: 3.0 حرفياً (قرار المالك ٣×)', /rate: 3\.0,/.test(src));
ok('maxDwell: 1.5 حرفياً', /maxDwell: 1\.5,/.test(src));
ok('المستخرج = المعتمد (تطابق تام، ولا مفتاح زائد)', Object.keys(shippedCfg).length === Object.keys(CFG).length
  && Object.keys(CFG).every((k) => shippedCfg[k] === CFG[k]));

// حالات القرار: المدخل ⇒ المخرج (بالعتبات المستخرجة من الملف المشحون نفسه).
const fmt = (r) => (!r ? 'undefined' : r.mode === 'speed' ? `speed ${r.rate}` : `${r.mode}/${r.reason}`);
const eq = (got, want) => !!got && got.mode === want.mode
  && (want.mode === 'speed' ? got.rate === want.rate && got.reason === undefined : got.reason === want.reason);
const CASES = [
  ['١) صغيرة 0.4s محفوظ 5/5 ⇒ cut/tiny', 0.4, 5, 5, { mode: 'cut', reason: 'tiny' }],
  ['٢) القاعدة ١ تسبق ٢: صغيرة ومعزولة 0.4s محفوظ 60/60 ⇒ cut/tiny', 0.4, 60, 60, { mode: 'cut', reason: 'tiny' }],
  ['٣) معزولة 2s محفوظ 20/20 ⇒ cut/isolated', 2, 20, 20, { mode: 'cut', reason: 'isolated' }],
  ['٤) طويلة 7s محفوظ 3/3 ⇒ cut/long', 7, 3, 3, { mode: 'cut', reason: 'long' }],
  ['٥) طويلة ومعزولة 7s محفوظ 25/25 ⇒ cut/isolated (‏٢ تسبق ٣ نصّاً — والوسم cut في الحالتين)', 7, 25, 25, { mode: 'cut', reason: 'isolated' }],
  ['٦) متوسطة متقاربة 2.4s محفوظ 2/2 ⇒ speed 2.4 (‏2.4 ÷ targetDwell 1.0)', 2.4, 2, 2, { mode: 'speed', rate: 2.4 }],
  ['٧) على الحدّ تماماً: gap === cutBelow (0.6s) ⇒ لا tiny بل speed 1.2', 0.6, 0, 0, { mode: 'speed', rate: 1.2 }],
  ['٨) على الحدّ تماماً: keptBefore === isolated و keptAfter أقل (20/19) ⇒ لا isolated بل speed 2', 2, 20, 19, { mode: 'speed', rate: 2 }],
  ['٩) أرضية التسريع: 1s ⇒ rate 1.2 لا 1.0', 1, 0, 0, { mode: 'speed', rate: 1.2 }],
  ['١٠) سقف التسريع: 3s ⇒ rate 3.0 لا أكثر', 3, 0, 0, { mode: 'speed', rate: 3 }],
  ['١١) قاعدة ٤ dwell: 5s محفوظ 1/1 ⇒ cut/dwell (‏5÷3 = 1.667 > 1.5)', 5, 1, 1, { mode: 'cut', reason: 'dwell' }],
];
for (const [label, gap, keptBefore, keptAfter, want] of CASES) {
  const got = planGap({ gap, keptBefore, keptAfter }, shippedCfg);
  ok(label, eq(got, want), `أعاد ${fmt(got)} والمتوقَّع ${fmt(want)}`);
}

// شبكة قيم: الثابتان المطلوبان + الصيغة المعلنة + شكل القرار (وشبكة غير فارغة).
const GRID_GAPS = [];
for (let g = 0.6; g <= 6.0001; g += 0.1) GRID_GAPS.push(+g.toFixed(2));
const GRID_KEPT = [[0, 0], [1, 1], [19, 19], [20, 19], [20, 20], [60, 60]];
const GRID = [];
for (const g of GRID_GAPS) for (const [b, a] of GRID_KEPT) GRID.push([g, planGap({ gap: g, keptBefore: b, keptAfter: a }, shippedCfg)]);
const speeds = GRID.filter(([, r]) => r && r.mode === 'speed');
const nG = GRID.length;
ok(`الشبكة ${nG} حالة غير فارغة: speed ${speeds.length} و cut ${nG - speeds.length}`, speeds.length > 0 && speeds.length < nG);
ok(`الشبكة ${nG} حالة: rate <= cfg.rate (3.0) دائماً`, speeds.every(([, r]) => r.rate <= shippedCfg.rate));
ok(`الشبكة ${nG} حالة: rate >= 1.2 دائماً`, speeds.every(([, r]) => r.rate >= 1.2));
ok(`الشبكة ${nG} حالة: rate = +min(rate, max(1.2, gap/targetDwell)).toFixed(2) دائماً`,
  speeds.every(([g, r]) => r.rate === +Math.min(shippedCfg.rate, Math.max(1.2, g / shippedCfg.targetDwell)).toFixed(2)));
ok(`الشبكة ${nG} حالة: شكل القرار — مفتاحان فقط، و cut بأحد الأسباب الأربعة، و speed بلا reason`,
  GRID.every(([, r]) => !!r && Object.keys(r).length === 2
    && (r.mode === 'cut' ? ['tiny', 'isolated', 'long', 'dwell'].includes(r.reason)
      : r.mode === 'speed' && typeof r.rate === 'number' && r.reason === undefined)));

console.log('\n=== ١٧) اختبارات سلبية لقرار الفجوة: كل مُفسَد يجب أن يُسقط الحارس ===');
// «سقوط الحارس» = أن يفشل فحص واحد على الأقل من فحوص القسم ١٦ على نصّ المُفسَد نفسه:
// فحوص العتبات (النصّية والمستخرجة) وفحوص القرار — لا مطابقة نصّية وحدها.
const fellChecks = (text) => {
  const out = [];
  if (!/cutBelow: 0\.6,/.test(text)) out.push('فحص cutBelow النصّي');
  if (!/rate: 3\.0,/.test(text)) out.push('فحص rate النصّي');
  const cfg = cfgOf(text);
  if (!cfg || !Object.keys(CFG).every((k) => cfg[k] === CFG[k])) out.push('مطابقة العتبات المستخرجة بالمعتمدة');
  const f = buildPlanGap(text);
  if (!f || !cfg) return out.concat('تعذّر بناء planGap من نصّ المُفسَد');
  return out.concat(CASES.filter(([, gap, keptBefore, keptAfter, want]) => !eq(f({ gap, keptBefore, keptAfter }, cfg), want)).map(([label]) => label));
};
const planMuts = [
  ['ل: تبديل ترتيب القاعدة ١ والقاعدة ٣', src.replace(
    /if \(gap < cfg\.cutBelow\) return \{ mode: 'cut', reason: 'tiny' \};([\s\S]*?)if \(gap > cfg\.maxSpeedGap\) return \{ mode: 'cut', reason: 'long' \};/,
    (_m, between) => RULE3 + between + RULE1), (s) => fellChecks(s).length > 0],
  ['م: حذف قاعدة maxSpeedGap وحدها', src.replace(RULE3 + '\n', ''), (s) => fellChecks(s).length > 0],
  ['ع: حذف قاعدة maxSpeedGap وشبكة maxDwell معاً ⇒ فجوة 7s تُسرَّع 3× بدل أن تُقطع',
    src.replace(RULE3 + '\n', '').replace(RULE4, ''), (s) => fellChecks(s).length > 0],
  ['ن: حذف شبكة maxDwell وحدها ⇒ فجوة 5s تُسرَّع 3× بدل أن تُقطع', src.replace(RULE4, ''), (s) => fellChecks(s).length > 0],
  ['س: إبطال عتبة الصغر (cutBelow = 0.0)', src.replace('cutBelow: 0.6,', 'cutBelow: 0.0,'), (s) => fellChecks(s).length > 0],
];
for (const [label, mutant, trips] of planMuts) {
  const fell = fellChecks(mutant);
  ok(`مُفسَد ${label}`, mutant !== src);
  ok(`  والحارس يسقط عليه (سقط: ${fell.join(' · ') || 'لا شيء'})`, mutant !== src && trips(mutant) === true);
}

console.log('\n=== ١٨) وصل وضع التسريع (الخطوة ٤): القرار يُحسب من الخريطة ويُنفَّذ ===');
// بديل صريح لفحص «وعد الخطوة ٣» (الذي كان يشترط ألّا تُنادى planGap ولا يُقرأ PACE_CFG):
// الوصل الحقيقي = نداء واحد للدالة من مسار التخطيط، وقراءة العتبات هناك، والقرار يُخزَّن
// في w.pace وينفّذه فرع التسريع. ونقاء الدالة نفسها يُختبر في الرمل المعزول (القسم ١٦).
const bodyOf = (b) => (b ? b.body : '');
const driftBlock = extractBlock(src, 'w.drift = setInterval(');
const armBlock = extractBlock(src, 'const armGapJump = () =>');
const gapBlock = extractBlock(src, 'const gapTick = (boundary, landing) =>');
const wBlock = extractBlock(src, 'const w = {');
const planBlock = extractBlock(src, 'const pacePlan = (gapStart, gapEnd) =>');
const enterBlock = extractBlock(src, 'const paceEnter = (boundary, landing, rate) =>');
const exitBlock = extractBlock(src, 'const paceExit = (why) =>');
const rejectBlock = extractBlock(src, 'const paceReject = () =>');
const stopBlock = extractBlock(src, 'function stopWatch(');
const ksaBlock = extractBlock(src, 'function keptStretchAround(');
const rateBlock = extractBlock(src, "on(video, 'ratechange', () =>");
const planB = bodyOf(planBlock);
const enterB = bodyOf(enterBlock);
const exitB = bodyOf(exitBlock);
const rejectB = bodyOf(rejectBlock);
const armB = bodyOf(armBlock);
const gapB = bodyOf(gapBlock);
const driftB = bodyOf(driftBlock);
const stopB = bodyOf(stopBlock);
const rateB = bodyOf(rateBlock);
const ksaB = bodyOf(ksaBlock);
ok('كتل التسريع كلها تُستخرج من الملف المشحون',
  [driftBlock, armBlock, gapBlock, wBlock, planBlock, enterBlock, exitBlock, rejectBlock, stopBlock, ksaBlock, rateBlock].every(Boolean));
ok('planGap تُنادى — مرة واحدة — من pacePlan (مسار التخطيط)',
  (src.match(/planGap\(/g) || []).length === 2
  && /planGap\(\{ gap: gapEnd - gapStart, keptBefore: st\.before, keptAfter: st\.after \}, PACE_CFG\)/.test(planB));
ok('وPACE_CFG يُقرأ في نداء pacePlan نفسه (تعريف + قراءة = 2)', (src.match(/PACE_CFG/g) || []).length === 2 && planB.includes('PACE_CFG'));
ok('طول المقطع المحيط يُقاس بالدالة النقية keptStretchAround', /const st = keptStretchAround\(kept, gapStart, gapEnd\);/.test(planB));
ok('والقرار يُخزَّن في w.pace: كائن للسرعة وnull للقطع',
  /w\.pace = plan\.mode === 'speed' \? \{ boundary: gapStart, landing: gapEnd, rate: plan\.rate \} : null;/.test(planB));
ok('الماسح armGapJump يطلب القرار عند التسليح', /pacePlan\(boundary, landing\);/.test(armB));
ok('وgapTick يطلب القرار للفجوة الحالية إن دخلناها بلا تسليح', /pace = pacePlan\(now, land\);/.test(gapB));
ok('صفّ pace-plan يطبع mode · rate · gap · keptBefore · reason معاً',
  /trace\('pace-plan',/.test(planB) && /mode=\$\{plan\.mode\}/.test(planB) && /rate=\$\{plan\.rate \|\| 0\}/.test(planB)
  && /gap=\$\{\(gapEnd - gapStart\)\.toFixed\(3\)\}/.test(planB) && /keptBefore=\$\{st\.before\.toFixed\(3\)\}/.test(planB)
  && /reason=\$\{plan\.reason \|\| '-'/.test(planB));
ok('والصفّ يُصدَر عند تغيّر القرار فقط (لا ~٦ صفوف متطابقة لكل فجوة)',
  /\n      if \(key !== pacePlanKey\) \{/.test(planB) && /const key = `\$\{plan\.mode\}/.test(planB));
ok('صفوف pace-enter وpace-exit وpace-reject موضوعة في مواضعها',
  /trace\('pace-enter'/.test(enterB) && /trace\('pace-exit'/.test(exitB) && /trace\('pace-reject'/.test(rejectB));

console.log('\n=== ١٩) keptStretchAround: نقية مكتفية بذاتها ومُختبرة في رمل معزول ===');
const sMid = keptStretchAround([[0, 10], [20, 30]], 10, 20);
ok('فجوة وسطى [10,20): before = 10 و after = 10', sMid.before === 10 && sMid.after === 10);
const sAdj = keptStretchAround([[0, 5], [8, 20], [25, 40]], 20, 25);
ok('الملاصق لا الأبعد: before = 12 (لا 5) و after = 15', sAdj.before === 12 && sAdj.after === 15);
const sNone = keptStretchAround([[12, 30]], 12, 30);
ok('فجوة أمامية بلا مقطع سابق: before = 0', sNone.before === 0 && sNone.after === 0);
ok('بلا خريطة: صفران', keptStretchAround(null, 10, 20).before === 0 && keptStretchAround([], 10, 20).after === 0);
const sTouch = keptStretchAround([[0, 10], [10, 20]], 10, 10);
ok('مقاطع متلاصقة (فجوة صفرية): 10 و10', sTouch.before === 10 && sTouch.after === 10);
const sInside = keptStretchAround([[0, 10], [10, 10.2], [12, 30]], 10, 12);
ok('مقطع محفوظ داخل مدى الفجوة لا يُحسب محيطاً: before = 10 و after = 18', sInside.before === 10 && sInside.after === 18);
// النقاء: تُبنى من نصّها وحدها وتُنادى في رمل بلا أي مرجع خارجي — لو أشارت إلى حالة أو
// عنصر لرمت ReferenceError هنا (وهي آلية buildPlanGap نفسها).
const buildPure = (text, opener) => {
  const b = extractBlock(text, opener);
  if (!b) return null;
  try { return new Function(`return ${b.full};`)(); } catch { return null; }
};
const loneKsa = (text) => {
  const f = buildPure(text, 'function keptStretchAround(');
  if (typeof f !== 'function') return null;
  try { return f([[0, 10], [20, 30]], 10, 20); } catch { return null; }
};
const lone = loneKsa(src);
ok('تُبنى وتُنادى معزولة: نتيجة صحيحة بلا أي مرجع خارجي', !!lone && lone.before === 10 && lone.after === 10);
ok('ولا اسم خارجي في متنها (عنصر أو حالة أو أثر)', !/\b(video|audio|WATCH|document|window|localStorage|trace|PACE_CFG)\b/.test(ksaB) && !/w\./.test(ksaB));

console.log('\n=== ٢٠) حقول حالة التسريع — وحظر الكتابة في w.prevRate ===');
ok('الحقول الثلاثة في كائن w نفسه (سطر واحد متجاور)', has(wBlock, 'pace: null, paceTimer: 0, selfRate: null,'));
ok('وw.prevRate لا يُسنَد إليه في أي موضع من الملف', !/w\.prevRate\s*=/.test(src));
ok('وprevRate يبقى مُلتقَطاً عند بدء المراقبة كما كان', /prevRate: video\.playbackRate \|\| 1,/.test(src));

console.log('\n=== ٢١) مؤقّت الخروج في w.paceTimer — لا في w.gapTimer الذي يمسحه الماسح ===');
ok('الكتابة في w.paceTimer داخل paceEnter (بزمن (left / rate) * 1000)', /w\.paceTimer = setTimeout\(\(\) => paceExit\('timer'\), \(left \/ rate\) \* 1000\);/.test(enterB));
ok('ولا مؤقّت خروج في w.gapTimer في أي موضع', !/w\.gapTimer = setTimeout\(\(\) => paceExit/.test(src));
ok('والماسح ما زال يمسح w.gapTimer (مؤقّت الحدّ قائم)', /if \(w\.gapTimer\) \{ clearTimeout\(w\.gapTimer\); w\.gapTimer = 0; \}/.test(armB));

console.log('\n=== ٢٢) المواضع الثلاثة تعود مبكراً عند وجود w.pace (احتواء داخل الكتلة) ===');
ok('نبضة الانحراف: خروج مبكر داخل كتلتها', /if \(w\.pace\) return;/.test(driftB));
ok('وقبل فرع إطلاق الاحتجاز (وإلا أطلق الصوت على صورة مسرَّعة)',
  driftB.indexOf('if (w.pace) return;') >= 0 && driftB.indexOf('if (w.pace) return;') < driftB.indexOf('if (w.held && !video.paused)'));
ok('gapTick: خروج مبكر عند تسريع فعّال داخل كتلتها', /if \(w\.pace && w\.paceTimer\) return;/.test(gapB));
ok('armGapJump: خروج مبكر عند تسريع فعّال داخل كتلتها', /if \(w\.pace && w\.paceTimer\) \{/.test(armB));
ok('وفي armGapJump قبل مسح مؤقّت الحدّ (وإلا لم يُدخَل التسريع أبداً)',
  armB.indexOf('if (w.pace && w.paceTimer) {') >= 0 && armB.indexOf('if (w.pace && w.paceTimer) {') < armB.indexOf('clearTimeout(w.gapTimer)'));
ok('وتحرير التجمّد لا يُطلق الصوت أثناء التسريع',
  /if \(w\.pace && w\.paceTimer\) return;/.test(bodyOf(extractBlock(src, 'const stallRelease = () =>'))));
ok('وkickAudio لا تُرسي ولا تستأنف أثناء التسريع الفعّال (وهي تنتهي بـplay غير مشروط)',
  /if \(w\.pace && w\.paceTimer\) \{ trace\('kick-skip', 'pace'\); return; \}/.test(kick.body)
  && kick.body.indexOf('if (w.pace && w.paceTimer)') < kick.body.indexOf('audio.play()'));

console.log('\n=== ٢٣) فرع التسريع لا يقفز — وgapTick تبقى بلا كتابة للصوت (فحص قائم) ===');
const paceBranch = 'if (pace) { paceEnter(pace.boundary, pace.landing, pace.rate); return; }';
const hasPaceBranch = (text) => bodyOf(extractBlock(text, 'const gapTick = (boundary, landing) =>')).includes(paceBranch);
ok('فرع التسريع يدخل ثم يعود قبل أي كتابة لموضع الصورة',
  hasPaceBranch(src) && gapB.indexOf(paceBranch) < gapB.indexOf('video.currentTime = target'));
ok('وgapTick ما زالت خالية من كتابة موضع الصوت', !has(gapBlock, 'audio.currentTime ='));
ok('وكتابة موضع الصورة في gapTick واحدة (القفزة وحدها)', (gapB.match(/video\.currentTime\s*=/g) || []).length === 1);

console.log('\n=== ٢٤) ratechange واعٍ بمعدّلنا · سقوط إلى القطع · stopWatch تُصفّر وتُعيد ===');
ok('يميّز معدّلنا بتسامح 0.05 ويتجاهل الحدث', /if \(w\.selfRate && Math\.abs\(video\.playbackRate - w\.selfRate\) < 0\.05\) \{ trace\('rate', 'ours'\); return; \}/.test(rateB));
ok('ويسقط إلى القطع لهذه الفجوة (وسم rejected→cut · paceReject · gapTick بالحدّ والهبوط)',
  /trace\('rate', 'rejected→cut'\);/.test(rateB) && /paceReject\(\);/.test(rateB) && /gapTick\(b, l\);/.test(rateB));
ok('ويعيد التثبيت كالقائم (1× للصورة + pinPlayerRate + 1× للصوت)',
  /video\.playbackRate = 1/.test(rateB) && /pinPlayerRate\(\)/.test(rateB) && /audio\.playbackRate = 1;/.test(rateB));
ok('paceReject تُصفّر المؤقّت والقرار والمعدّل الموسوم',
  /w\.paceTimer = 0;/.test(rejectB) && /w\.pace = null;/.test(rejectB) && /w\.selfRate = null;/.test(rejectB));
ok('stopWatch تُصفّر مؤقّت الخروج وتمسح القرار — وإعادة المعدّل قائمة فيها',
  /if \(w\.paceTimer\) clearTimeout\(w\.paceTimer\);/.test(stopB) && /w\.paceTimer = 0;/.test(stopB)
  && /w\.pace = null;/.test(stopB) && /w\.video\.playbackRate = w\.prevRate/.test(stopB) && /pinPlayerRateRestore\(w\.prevRate\)/.test(stopB));
// الحالتان معاً: وقفة (`video.paused`) وتجمّد مشغّل (`w.stalled` — و`video.paused` كاذب
// فيه، فاستئناف الصوت على صورة واقفة يتراكم تقدّماً ثم يُسحَب للخلف في stallRelease).
const exitNoResume = /if \(video\.paused \|\| w\.stalled\) \{\n        trace\('pace-exit', `\$\{why \|\| 'end'\} \$\{video\.paused \? 'paused' : 'stalled'\}`\);\n        return;\n      \}/;
ok('paceExit لا تستأنف الصوت إن كانت الصورة متوقّفة **أو متجمّدة** (الحالتان معاً)',
  exitNoResume.test(exitB) && exitB.indexOf('if (video.paused') < exitB.indexOf('audio.play()'));
// نظافة المعدّلات: أسندات video.playbackRate كلها إمّا 1× أو استعادة w.prevRate أو معدّل
// القرار (في paceEnter وحده)، وأسندات الصوت كلها 1 — والقياس بالمجموع لا بالعدد وحده.
// والاستخراج سطريّ (`[^;\n]+`) كي لا يبتلع تعليقاً يذكر إسناداً بلا فاصلة منقوطة.
const rateWrites = (text, kind) => {
  const re = new RegExp(`${kind}\\.playbackRate\\s*=\\s*([^;\\n]+);`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
};
const WANT_V = ['1', '1', 'w.prevRate', 'w.prevRate || 1', 'rate'];
const vRateOk = (text) => { const w = rateWrites(text, 'video'); return w.length === WANT_V.length && [...w].sort().join('|') === [...WANT_V].sort().join('|'); };
const aRateOk = (text) => { const w = rateWrites(text, 'audio'); return w.length === 2 && w.every((v) => v === '1'); };
const vWrites = rateWrites(src, 'video');
const aWrites = rateWrites(src, 'audio');
ok(`إسنادات video.playbackRate = ${vWrites.length}: 1× (تثبيت) · w.prevRate (استعادة) · معدّل القرار — وجميعها (${vWrites.join(' · ')})`, vRateOk(src));
ok(`إسنادات audio.playbackRate = ${aWrites.length} وكلها 1 حصراً (${aWrites.join(' · ')})`, aRateOk(src));
const WANT_BACK = ['seeking', 'held-release', 'stall-release', 'drift-confirmed', 'pace-release'];
const backSitesOf = (text) => {
  const re = /setAudioTime\('([a-z-]+)',[^;]*?(true|false)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) if (m[2] === 'true') out.push(m[1]);
  return out.sort();
};
const backOk = (text) => backSitesOf(text).join('|') === [...WANT_BACK].sort().join('|');
ok(`مواضع السحب للخلف = المواضع المسموحة في §٥ حصراً (${backSitesOf(src).join(' · ')})`, backOk(src));
ok('ومواضع setAudioTime = 7 كلها بأعلامها المعروفة', (src.match(/setAudioTime\(/g) || []).length === 7);
ok('وpace-release بـallowBack=true حصراً', /setAudioTime\('pace-release', audioPos\(\), true\)/.test(exitB));

console.log('\n=== ٢٥) اختبارات سلبية للتسريع: كل مُفسَد يجب أن يُسقط حارسه ===');
const paceMuts = [
  ['ص: keptStretchAround تشير إلى حالة خارجية', src.replace(
    'function keptStretchAround(kept, gapStart, gapEnd) {\n  const out = { before: 0, after: 0 };',
    'function keptStretchAround(kept, gapStart, gapEnd) {\n  const out = { before: w.prevRate, after: 0 };'),
    (s) => loneKsa(s) === null],
  ['ق: تفكيك الوسائط في keptStretchAround (يُسقط الاستخراج)', src.replace(
    'function keptStretchAround(kept, gapStart, gapEnd) {', 'function keptStretchAround({ kept, gapStart, gapEnd }) {'),
    (s) => loneKsa(s) === null],
  ['ر: حذف حقول حالة التسريع من w', src.replace('      pace: null, paceTimer: 0, selfRate: null,\n', ''),
    (s) => !has(extractBlock(s, 'const w = {'), 'pace: null, paceTimer: 0, selfRate: null,')],
  ['ش: كتابة معدّل التسريع في w.prevRate', src.replace('      w.selfRate = rate;\n', '      w.selfRate = rate;\n      w.prevRate = rate;\n'),
    (s) => /w\.prevRate\s*=/.test(s)],
  ['ت: مؤقّت الخروج في w.gapTimer (يمحوه الماسح خلال ربع ثانية)', src.replace(
    "      w.paceTimer = setTimeout(() => paceExit('timer'), (left / rate) * 1000);",
    "      w.gapTimer = setTimeout(() => paceExit('timer'), (left / rate) * 1000);"),
    (s) => !/w\.paceTimer = setTimeout/.test(s)],
  ['ث: إزالة خروج نبضة الانحراف المبكر عند التسريع', src.replace(
    '      if (w.pace) return;\n      if (w.held && !video.paused) {', '      if (w.held && !video.paused) {'),
    (s) => !/if \(w\.pace\) return;/.test(bodyOf(extractBlock(s, 'w.drift = setInterval(')))],
  ['خ: إزالة خروج gapTick المبكر عند التسريع', src.replace(
    '      if (w.pace && w.paceTimer) return;      // تسريع فعّال: لا قفز (الماسح ينادي كل 250ms)\n', ''),
    (s) => !/if \(w\.pace && w\.paceTimer\) return;/.test(bodyOf(extractBlock(s, 'const gapTick = (boundary, landing) =>')))],
  ['ذ: إزالة خروج armGapJump المبكر (فيُعاد القفز كل نبضة)',
    src.replace('      if (w.pace && w.paceTimer) {\n        const at = video.currentTime || 0;\n        if (!isGap(at, kept) || at >= w.pace.landing) paceExit(\'net\');\n        return;\n      }\n', ''),
    (s) => !/if \(w\.pace && w\.paceTimer\) \{/.test(bodyOf(extractBlock(s, 'const armGapJump = () =>')))],
  ['ض: إزالة نداء pacePlan من الماسح (فيصير القرار غير موصول)', src.replace('      pacePlan(boundary, landing);\n', ''),
    (s) => !/pacePlan\(boundary, landing\);/.test(bodyOf(extractBlock(s, 'const armGapJump = () =>')))],
  ['ظ: التسريع يدخل ثم يسقط إلى القفزة (بلا return)', src.replace(
    'if (pace) { paceEnter(pace.boundary, pace.landing, pace.rate); return; }',
    'if (pace) { paceEnter(pace.boundary, pace.landing, pace.rate); }'),
    (s) => hasPaceBranch(s) === false],
  ['غ: إسناد معدّل ≠ 1 للصوت', src.replace('      audio.playbackRate = 1;\n', '      audio.playbackRate = 1;\n      audio.playbackRate = 2;\n'),
    (s) => aRateOk(s) === false],
  ['ف: معدّل تسريع مكتوب صراحةً خارج القرار (1.7×)', src.replace(
    '      try { video.playbackRate = rate; } catch { /* gone */ }', '      try { video.playbackRate = 1.7; } catch { /* gone */ }'),
    (s) => vRateOk(s) === false],
  ['ح: إسقاط pace-release إلى allowBack=false (سحب للخلف ممنوع عند الخروج)',
    src.replace("setAudioTime('pace-release', audioPos(), true)", "setAudioTime('pace-release', audioPos(), false)"),
    (s) => backOk(s) === false],
  ['ط: إزالة تصفير مؤقّت الخروج من stopWatch', src.replace('    if (w.paceTimer) clearTimeout(w.paceTimer);\n', ''),
    (s) => !/if \(w\.paceTimer\) clearTimeout\(w\.paceTimer\);/.test(bodyOf(extractBlock(s, 'function stopWatch(')))],
  ['ي: استئناف الصوت في paceExit بلا شرط (play ثم pause فوراً)', src.replace(
    "      if (video.paused || w.stalled) {\n        trace('pace-exit', `${why || 'end'} ${video.paused ? 'paused' : 'stalled'}`);\n        return;\n      }\n", ''),
    (s) => exitNoResume.test(bodyOf(extractBlock(s, 'const paceExit = (why) =>'))) === false],
  ['ن٢: إسقاط شرط التجمّد وحده (استئناف على صورة مجمّدة ⇒ كلمة مكررة لاحقاً)',
    src.replace('if (video.paused || w.stalled) {', 'if (video.paused) {'),
    (s) => exitNoResume.test(bodyOf(extractBlock(s, 'const paceExit = (why) =>'))) === false],
  ['ع٢: إزالة حراسة kickAudio أثناء التسريع (استئناف الصوت على صورة مسرَّعة)',
    src.replace("      if (w.pace && w.paceTimer) { trace('kick-skip', 'pace'); return; }\n", ''),
    (s) => !/if \(w\.pace && w\.paceTimer\) \{ trace\('kick-skip', 'pace'\); return; \}/.test(bodyOf(extractBlock(s, 'const kickAudio = () =>')))],
  ['ك: إسقاط تمايز selfRate في ratechange (فيُفرض 1× داخل الفجوة)',
    src.replace("if (w.selfRate && Math.abs(video.playbackRate - w.selfRate) < 0.05) { trace('rate', 'ours'); return; }\n      ", ''),
    (s) => !/if \(w\.selfRate && Math\.abs\(video\.playbackRate - w\.selfRate\) < 0\.05\)/.test(bodyOf(extractBlock(s, "on(video, 'ratechange', () =>")))],
  ['ل٢: إلغاء إصدار pace-plan عند تغيّر القرار فقط (ضجيج الأثر)', src.replace('      if (key !== pacePlanKey) {', '      if (true) {'),
    (s) => !/\n      if \(key !== pacePlanKey\) \{/.test(bodyOf(extractBlock(s, 'const pacePlan = (gapStart, gapEnd) =>')))],
];
for (const [label, mutant, trips] of paceMuts) {
  ok(`مُفسَد ${label}`, mutant !== src);
  ok('  والحارس يسقط عليه', mutant !== src && trips(mutant) === true);
}

console.log('');
if (failures.length) {
  console.error(`✗ فشل ${failures.length} من ${checks} فحصاً:`);
  failures.forEach((f) => console.error(`   - ${f}`));
  process.exit(1);
}
console.log(`✓ ${checks} فحصاً ناجحاً / 0 فاشل — بوابة واحدة: لا سحب للخلف على صوت يعمل إلا بتأكيد، وإلحاق أمامي فقط.`);
