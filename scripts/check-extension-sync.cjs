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
const names = ['mapFullToCut', 'isGap', 'skipVideoGaps', 'nextGapStart', 'gapStats'];
const got = {};
for (const n of names) { got[n] = extractBlock(src, `function ${n}(`); ok(`وُجدت ${n}`, !!got[n]); }
if (failures.length) { console.error('✗ تعذّر الاستخراج'); process.exit(1); }
const sb = new Function(`${names.map((n) => got[n].full).join('\n')} return { ${names.join(', ')} };`)();
const { mapFullToCut, isGap, skipVideoGaps, nextGapStart, gapStats } = sb;

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
ok('تتجاهل أثناء وجود الصورة في فجوة مع التخطي', /if \(skipping && isGap\(video\.currentTime \|\| 0, kept\)\) return;/.test(drift.body));
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
ok('العيّنة 40ms مبوَّبة بـ slog', /if \(slog\) w\.tracePulse = setInterval\(/.test(src));
ok('العيّنة تُحرَّر **داخل** stopWatch', has(extractBlock(src, 'function stopWatch('), 'clearInterval(w.tracePulse)'));
ok('أثر الإيقاف داخل معالج pause', /on\(video, 'pause', \(\) => \{ trace\('pause'\); audio\.pause\(\); \}\)/.test(src));
ok('المُسجّل معطّل افتراضياً', /localStorage\.getItem\('hl\.synclog'\) === '1'/.test(src));
ok('حلقة الأثر محدودة السعة', /window\.__hlSync\.length > 4000\) window\.__hlSync\.shift\(\)/.test(src));

console.log('\n=== ١١) الاختبارات السلبية: كل مُفسَد يجب أن يُسقط حارسه ===');
const muts = [
  ['أ: حذف الحارس البنيوي (سحب للخلف مسموح)', src.replace(/if \(!allowBack && !audio\.paused && delta > 0\.05\) \{/, 'if (false) {'),
    (s) => !/if \(!allowBack && !audio\.paused && delta > 0\.05\)/.test(s)],
  ['ب: جعل النبضة متماثلة (سحب للخلف)', src.replace(/lead < -0\.35/, 'Math.abs(lead) > 0.35'),
    (s) => /Math\.abs\(lead\) > 0\.35/.test(s)],
  ['ج: إزالة بوابة kickAudio', src.replace(/trace\('kick-skip', 'selfSeek'\);/, ''),
    (s) => !/trace\('kick-skip', 'selfSeek'\)/.test(s)],
  ['د: إخراج أثر الإيقاف من معالجه', src.replace("on(video, 'pause', () => { trace('pause'); audio.pause(); });", "on(video, 'pause', () => { audio.pause(); });\n    trace('pause');"),
    (s) => !/on\(video, 'pause', \(\) => \{ trace\('pause'\)/.test(s)],
  ['هـ: إزالة تحرير العيّنة من stopWatch', src.replace(/\n    if \(w\.tracePulse\) clearInterval\(w\.tracePulse\);/, ''),
    (s) => !/clearInterval\(w\.tracePulse\)/.test(s)],
  ['و: إضافة كتابة ثالثة لموضع الصوت', src.replace(/(const gapTick = \(boundary, landing\) => \{\n)/, '$1      audio.currentTime = 0;\n'),
    (s) => (s.match(/audio\.currentTime\s*=/g) || []).length !== 2],
];
for (const [label, mutant, trips] of muts) {
  ok(`مُفسَد ${label}`, mutant !== src);
  ok('  والحارس يسقط عليه', mutant !== src && trips(mutant) === true);
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

console.log('');
if (failures.length) {
  console.error(`✗ فشل ${failures.length} من ${checks} فحصاً:`);
  failures.forEach((f) => console.error(`   - ${f}`));
  process.exit(1);
}
console.log(`✓ ${checks} فحصاً ناجحاً / 0 فاشل — بوابة واحدة، ولا سحب للخلف، وإلحاق أمامي فقط.`);
