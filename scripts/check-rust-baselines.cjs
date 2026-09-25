#!/usr/bin/env node
/* بوّابة **خطوط الأساس لبوّابات Rust**: تحوّل الأرقام التي تُقال بالعين إلى بابٍ يُغلق البناء.
 *
 *   node scripts/check-rust-baselines.cjs [--baseline=<path>] [--update] [--quiet]
 *
 * **العطل الذي تعالجه** (كشفه جاسوس مستقل في تدقيق م٥، 2026-09-21): كان CI يشغّل
 * `cargo clippy --all-targets` **بلا `-D warnings`** و`cargo test --quiet` **بلا أي قيد على العدد**،
 * فكان `١٤ تحذيراً` و`٣٤٩ ناجحاً` **إعلانين يُقاسان بالعين لا بوّابتين** — تحذير جديد يمرّ أخضر،
 * وحذف عشرة اختبارات يمرّ أخضر، والرقم المعلَن في التقارير يبقى صحيحاً حتى اللحظة التي يكفّ فيها.
 * فهذه البوّابة تقرأ الأرقام من تشغيل حقيقي وتقابلها بخطّ أساس **مكتوب ومُراجَع**:
 *
 *   ① **تحذيرات clippy**: تُعدّ **المواضع الفريدة** (`--message-format=json`: رمز التشخيص + ملف + سطر)
 *      — لا أسطر المخرَج، لأن cargo تطبع سطرَي ملخّص يبدآن بـ`warning:` أيضاً (خطأ قِسته على نفسي).
 *   ② **جرد أسماء اختبارات Rust** (ثقبان مقيسان أُغلقا — دفعة البوّابات، 2026-09-23): المقارنة
 *      **مجموعةً لا عدداً**. العدّ وحده **لا يعرف أيّ الاختبارات تعمل**: جاسوس مستقلّ أعطى حارساً
 *      **معطَّلاً بـ`return` مبكّر** ⇒ `exit=0` أخضر (`407 ناجح · 0 فاشل · 5 مُهمَل`) وهو **لا يعمل**؛
 *      ونزع حارساً ووضع **اختباراً تافهاً مكانه** ⇒ `exit=0` أيضاً (العدد كما هو). فصار في خطّ
 *      الأساس **جرد أسماء مرتَّب** (`tests`)، والمقارنة على المجموعة:
 *        · اختبار في الأساس **غاب من التشغيل** (حُذف · أُهمل بـ`#[ignore]` · أُبدل باسم آخر) ⇒ **يسقط**.
 *        · اختبار **جديد** لم يكن في الأساس ⇒ **يُقبل** بتصريح: يُسمّى ويُطلب `--update` ليثبت.
 *        · والعدد يبقى **مؤشّراً إضافياً**: صفر فاشل · والناجح لا يقلّ عن الأساس.
 *   ③ **وحدُّ الجرد معلَن لا مخفيّ**: الاسم الباقي لا يعني أن **جسم** الاختبار ما زال يعمل. فحارسٌ
 *      مُعطَّل بـ`return` **داخل جسم اختباره** يبقى باسمه و«ينجح» — والجرد **لا يراه** (قيستُه فلم
 *      يُمكن كشفه بالجرد، ولم أدّعِ خلافه). المقياس الذي يراه هو البوّابة السلبية
 *      `scripts/check-rust-mutants.cjs`: تُحقن تحويلة في الشيفرة التي يحرسها الاختبار ويُشترط
 *      **سقوطه**؛ فالاختبار المُعطَّل يمرّ عليها ⇒ تُسمّى ثقباً.
 *   ④ **والاختبارات المُهمَلة** (`tests_ignored`): كان الرقم يُكتَب ويُطبَع **ولا يُقارَن** ⇒ حارسٌ يُنزَع
 *      بـ`#[ignore]` واختبارٌ تافه يُضاف مكانه يعطي العدد نفسه و«٠ فاشل» فيمرّ **أخضر وحارسُه لا يعمل**
 *      (الثقب قِيس في بيئة مصنوعة، وكشفه جاسوس مستقلّ). فيُسقط الآن **زيادةُ** المُهمَل عن الأساس.
 *   ⑤ **وأخطاء clippy** (`level:"error"`): كان العدّ يقبل `level === "warning"` **وحده** ويُسقط ما سواه
 *      ⇒ كودٌ يرفضه clippy (لا تحذيراً عليه) يمرّ **أخضر**. والثقب المقيس: `error: invisible character
 *      detected` من محرف `U+200B` قائم في الشجرة، و`pnpm rust:gates` قال «✓ سليم» بينما
 *      `cargo clippy --all-targets` **exit 1** (كشفه وكيل `dl2` من قياسه هو). فيُسقط الآن:
 *      (أ) **أي** تشخيص `level:"error"` — **ويُسمّى** رمزُه وموضعُه ونصُّه · (ب) و**رمز خروج clippy
 *      غير الصفر** (فخطأُ بناءٍ بلا تشخيص مفصَّل يسقط أيضاً) · (ج) و`build-finished.success === false`.
 *      (**وهذا البند ⑤ هو ثمرة دمج `agent/dl2`** — وقد جُمع مع ② لا بدلاً منه: الطرفان يقيسان
 *      عطلين مختلفين، فإسقاط أحدهما كان سيُرخي حارساً لا يُقوّيه.)
 *
 * `--update` يكتب خطّ الأساس من التشغيل الحالي (تعديل واعٍ يُراجَع في الالتزام، لا صمت).
 * و`--baseline=<path>` للاختبار (فيُقاس الحارس نفسه على خطّ أساس مُصطنع).
 *
 * رموز الخروج: ٠ سليم · ١ خرق الأساس (مُسمّى) · ٢ **صفر مدخل** (لا cargo · لا ملف أساس · لا نتيجة مقروءة).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
/** `--root` كنمط بقية حرّاس المستودع: يسمح بقياس البوّابة على بيئة مصنوعة (اختبارها بنفسها). */
const ROOT = path.resolve(argOf('root', path.resolve(__dirname, '..')));
const MANIFEST = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const baselinePath = path.resolve(argOf('baseline', path.join(ROOT, 'qa', 'rust-baselines.json')));
const update = argv.includes('--update');
const quiet = argv.includes('--quiet');

const cargo = (() => {
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8', windowsHide: true, shell: true });
  if (!probe.error && probe.status === 0) return 'cargo';
  const home = process.env.USERPROFILE;
  const p = home ? path.join(home, '.cargo', 'bin', 'cargo.exe') : null;
  return p && fs.existsSync(p) ? p : null;
})();
if (!cargo) { console.error('✗ صفر مدخل: cargo غير موجود (لا على PATH ولا في %USERPROFILE%\\.cargo\\bin)'); process.exit(2); }

/** **نداء cargo عبر صدفة** (‏`shell: true`) لسببين مقيسين: (١) في ويندوز قد يكون `cargo.cmd`
 *  لا `.exe`، والـ`spawnSync` بلا صدفة **يرفض `.cmd`** (جُرِّب في بيئة الحارس المصنوعة فسقط
 *  «صفر مدخل»)، (٢) وبه يصير الحارس نفسه قابلاً للاختبار بـ`cargo` مزيّف. والوسائط كلها من عندنا
 *  بلا مدخل مستخدم، وتُقتبس صراحةً إن حملت فراغاً (مسار المستودع يحمل «HaramMute Desktop III»). */
function cargoRun(args, opts = {}) {
  const line = [cargo, ...args].map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  return spawnSync(line, [], { encoding: 'utf8', windowsHide: true, shell: true, ...opts });
}

/** **الركود شرط قياس لا إعلام** (درس تكرّر خمس مرّات في يوم واحد): قياس خطّ أساس على شجرة
 *  **تُحرَّر** يعطي رقماً عن جسم متحرّك — ورقمٌ كهذا يبدو دليلاً وهو ليس كذلك. فإن كانت الشجرة
 *  مستودعَ git وفيه تعديلات غير ملتزَمة ⇒ **تُرفض البوّابة** (رمز 2) إلا بـ`--allow-dirty`.
 *  ومجلد ليس مستودعاً (بيئة مصنوعة في حارس الحرّاس) يمرّ بلا فحص. */
function assertQuiescent() {
  if (argv.includes('--allow-dirty')) return { dirty: false, skipped: true };
  const probe = spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'],
    { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0 || !/true/.test(probe.stdout || '')) return { dirty: false, skipped: true };
  const st = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  const lines = (st.stdout || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length) {
    console.error('✗ صفر مدخل: الشجرة غير نظيفة (' + lines.length + ' ملفاً) — قياس خطّ الأساس يتطلب شجرة ساكنة وملتزَمة،');
    console.error('  وإلا فالرقم عن جسم متحرّك. انتظر انتهاء من يُحرّرها، أو مرّر `--allow-dirty` إن كنت تفحص عمداً.');
    for (const l of lines.slice(0, 8)) console.error('   ' + l.trim());
    process.exit(2);
  }
  return { dirty: false, skipped: false };
}
const quiescence = assertQuiescent();
/** نسخة الأداة: أساسٌ قِيس على clippy آخر لا يعني الشيء نفسه (لينت جديد يُضاف بين إصدارين). */
const toolchain = (() => {
  const c = cargoRun(['--version']);
  const cl = cargoRun(['clippy', '--version']);
  const pick = (s) => (s || '').trim().split(/\r?\n/)[0];
  return { cargo: pick(c.stdout), clippy: pick(cl.stdout) };
})();

/* ── ① تحذيرات clippy: مواضع فريدة من JSON ───────────────────────────────── */
/** **بلا `--quiet`**: التشخيصات تُكتب JSON على stdout، و`--quiet` جُرِّب فأعطى رقماً خاطئاً (١٢ بدل ١٥)
 *  — والقياس الموثوق يُكتب إلى **ملف** ثم يُقرأ، لا عبر أنبوب مع `--quiet`.
 *
 *  **والمخرَج الخام يُقرأ لا الملخّص**: كل سطر JSON على حدة، ولا حكم من سطرَي cargo الختاميّين.
 *  وتُجمَع **الأخطاء** (`level:"error"`) بأسمائها — لا تُطوى في العدّ. */
function clippyUniqueWarnings() {
  const r = cargoRun(['clippy', '--all-targets', '--manifest-path', MANIFEST, '--message-format=json'],
    { maxBuffer: 512 * 1024 * 1024 });
  if (r.error) return { error: r.error.message };
  const out = r.stdout || '';
  const seen = new Map();
  const errors = [];
  let parsed = 0;
  let sawDiagnostic = 0;
  let buildOk = null;
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let j; try { j = JSON.parse(t); } catch { continue; }
    if (j.reason === 'build-finished') { buildOk = j.success !== false; continue; }
    if (j.reason !== 'compiler-message' || !j.message) continue;
    sawDiagnostic++;
    const code = j.message.code?.code || '(بلا رمز)';
    const span = (j.message.spans || []).find((s) => s.is_primary) || (j.message.spans || [])[0] || {};
    const where = `${span.file_name || '?'}:${span.line_start || 0}:${span.column_start || 0}`;
    if (j.message.level === 'error') {
      // **يُسمّى**: الرمز + الموضع + نصّ الخطأ (أول سطر منه) — لا «فشل clippy» مبهمة.
      const first = String(j.message.message || '').split('\n')[0].trim();
      errors.push(`${code} @ ${where} — ${first}`);
      continue;
    }
    if (j.message.level !== 'warning') continue;
    parsed++;
    seen.set(`${code}|${where}`, true);
  }
  if (sawDiagnostic === 0) return { error: 'لم يُقرأ تشخيص واحد من clippy (لا JSON في المخرَج)' };
  return { unique: seen.size, keys: [...seen.keys()].sort(), raw: parsed, status: r.status, errors, buildOk };
}

/* ── ② اختبارات Rust: مجموع نتائج كل الأهداف + **جرد الأسماء** ───────────── */
/** **بلا `--quiet`** (وهذا شرط الجرد لا تفضيل): `--quiet` يُخفي سطور `test <name> ... ok`
 *  الفردية فلا يبقى إلا سطر الملخّص — ولا أسماء تُقابَل. قِيس فعلاً: `cargo test --quiet`
 *  أعطى `0` سطر اختبار في المخرَج وثلاثة أسطر «test result:» وحدها، أي أن العدّ يعمل
 *  والجرد **أعمى**. فالنداء يُترك صاخباً، والمخرَج كله يُقرأ مرةً واحدة. */
function rustTestTotals() {
  const r = cargoRun(['test', '--manifest-path', MANIFEST],
    { maxBuffer: 256 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.error) return { error: r.error.message };
  let passed = 0, failed = 0, ignored = 0, results = 0;
  for (const m of out.matchAll(/test result:\s*(\w+)\.\s*(\d+) passed;\s*(\d+) failed;\s*(\d+) ignored/g)) {
    results++; passed += Number(m[2]); failed += Number(m[3]); ignored += Number(m[4]);
  }
  if (results === 0) return { error: 'لم يُقرأ سطر «test result:» واحد — لا نتيجة تُقاس' };

  /** أسماء الاختبارات التي **جرت ونجحت** (جاهزة للمقابلة بالاسم الواحد). */
  const live = new Set();
  const ignoredNames = [];
  const extraFlagged = [];   // خرجت بـ`ok` ومعه عَلم ⇒ ليست نجاحاً عارياً
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^test\s+(\S+)\s+\.\.\.\s+(\w+)(.*)$/);
    if (!m) continue;
    const [, name, verdict, rest] = m;
    if (verdict === 'ok') {
      if (rest.trim()) extraFlagged.push(name + ' — ' + rest.trim());
      else live.add(name);
    } else if (verdict === 'ignored') {
      ignoredNames.push(name);
    } else if (verdict !== 'FAILED') {
      extraFlagged.push(name + ' — ' + verdict);
    }
  }
  if (live.size === 0) return { error: 'لم يُقرأ سطر اختبار واحد («test … ... ok») — لا جرد يُقاس' };
  return { passed, failed, ignored, results, status: r.status, live, ignoredNames, extraFlagged };
}

const clippy = clippyUniqueWarnings();
const tests = rustTestTotals();
if (clippy.error || tests.error) {
  console.error('✗ صفر مدخل: ' + (clippy.error || tests.error));
  process.exit(2);
}
const liveNames = [...tests.live].sort();

if (update) {
  // **ولا يُكتَب خطّ أساس على شجرة يرفضها clippy**: وإلا صار الخطأُ نفسه هو «المرجع» المُقارَن به.
  if ((clippy.errors && clippy.errors.length) || clippy.buildOk === false || clippy.status !== 0) {
    console.error('✗ لا يُحدَّث خطّ الأساس: clippy أخرج أخطاءً أو انتهى برمز غير صفر');
    for (const e of (clippy.errors || []).slice(0, 10)) console.error('   · ' + e);
    process.exit(1);
  }
  const data = {
    why: 'خطّ أساس مقيس لبوّابات Rust — يُحدَّث بـ--update بعد مراجعة السبب، ولا يُخفَّض لتُمرَّر بوّابة.',
    clippy_unique_warnings: clippy.unique,
    tests_passed: tests.passed,
    tests_ignored: tests.ignored,
    tests: liveNames,
    toolchain,
    measured_at: new Date().toISOString().slice(0, 10) + ' · ' + (process.env.HL_BASELINE_NOTE || 'قياس محلي'),
  };
  fs.writeFileSync(baselinePath, JSON.stringify(data, null, 2) + '\n');
  console.log('✓ حُدِّث خطّ الأساس: ' + baselinePath);
  console.log(`  clippy=${clippy.unique} · tests_passed=${tests.passed} · ignored=${tests.ignored} · جرد=${liveNames.length} اسماً`);
  console.log('  الأداة: ' + toolchain.clippy);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error('✗ صفر مدخل: ملف خطّ الأساس مفقود: ' + baselinePath + ' — أنشئه بـ--update بعد مراجعة');
  process.exit(2);
}
let base;
try { base = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch (e) {
  console.error('✗ صفر مدخل: خطّ الأساس غير مقروء: ' + e.message); process.exit(2);
}
for (const k of ['clippy_unique_warnings', 'tests_passed', 'tests_ignored']) {
  if (typeof base[k] !== 'number') { console.error('✗ صفر مدخل: حقل «' + k + '» مفقود من خطّ الأساس'); process.exit(2); }
}
/** **جرد الأسماء شرط قياس لا زيادة**: بلا `tests` لا تُقاس المجموعة، فيبقى الثقب
 *  الذي أغلقته هذه النسخة مفتوحاً («اختبار تافه مكان الحارس» يمرّ). فلا يُقبل
 *  خطّ أساس قديم بصمت — يُسمّى ويُطلب `--update`. */
let baseNames = null;
if (Array.isArray(base.tests)) {
  if (base.tests.some((n) => typeof n !== 'string') || base.tests.length === 0) {
    console.error('✗ صفر مدخل: حقل «tests» في خطّ الأساس ليس جرداً صالحاً (‏' + base.tests.length + ' مدخلاً)');
    process.exit(2);
  }
  baseNames = new Set(base.tests);
}

const reasons = [];
/* **أخطاء clippy تسقط البوّابة أولاً** (البند ④): بوّابةٌ تُخضرّ على كودٍ يرفضه clippy ليست بوّابة.
 * والثلاثة معاً: تشخيصات `level:"error"` بأسمائها · رمز خروج clippy · و`build-finished.success`. */
if (clippy.errors && clippy.errors.length) {
  reasons.push(`clippy أخرج **${clippy.errors.length} خطأ** (‏level:"error") — كودٌ يرفضه clippy لا يمرّ:\n` +
    clippy.errors.slice(0, 10).map((e) => '     · ' + e).join('\n') +
    (clippy.errors.length > 10 ? `\n     · … و${clippy.errors.length - 10} أخرى` : ''));
}
if (clippy.buildOk === false) {
  reasons.push('clippy: `build-finished.success === false` — البناء نفسه فشل (وأي تشخيص مفصَّل مذكور أعلاه إن وُجد)');
}
if (clippy.status !== 0) {
  reasons.push(`clippy انتهى برمز خروج ${clippy.status} (المطلوب ٠) — حتى بلا تشخيص مُفصَّل لا تُقبَل البوّابة`);
}
if (clippy.unique > base.clippy_unique_warnings) {
  reasons.push(`تحذيرات clippy: ${clippy.unique} موضعاً فريداً > الأساس ${base.clippy_unique_warnings} — تحذير جديد لم يُراجَع`);
}
if (tests.failed > 0) reasons.push(`اختبارات فاشلة: ${tests.failed} (يجب صفر)`);
if (tests.passed < base.tests_passed) {
  reasons.push(`اختبارات ناجحة: ${tests.passed} < الأساس ${base.tests_passed} — نقصٌ لا يُقبل بلا تفسير (اختبارات حُذفت أو أُهملت؟)`);
}
/** ② **المقارنة بالاسم**: الغائب يسقط · والجديد يُصرَّح به. */
const missing = baseNames ? base.tests.filter((n) => !tests.live.has(n)) : [];
const added = baseNames ? liveNames.filter((n) => !baseNames.has(n)) : [];
if (baseNames && missing.length) {
  reasons.push(`اختبارات غابت عن التشغيل: ${missing.length} من ${base.tests.length} في الأساس` +
    ' — اختبار مفقود يعني حارساً نُزع أو أُهمل أو أُبدل باسم آخر؛ لا يُقبل بلا تفسير');
}
if (tests.extraFlagged.length) {
  reasons.push(`اختبارات نُفِّذت بعَلَم لا «ok» عارياً: ${tests.extraFlagged.length} — راجعها بالاسم أدناه`);
}
/* **والاختبارات المُهمَلة تُقارَن أيضاً** (ثقب قائم قبل هذا العمل، كشفه جاسوس مستقلّ):
 * البوّابة كانت تكتب `tests_ignored` و**تطبعه** ولا **تقارنه** ⇒ حارسٌ يُنزَع بـ`#[ignore]`
 * واختبارٌ تافه يُضاف مكانه يعطي العدد نفسه و«٠ فاشل» ⇒ **أخضر مع حارسٍ لا يعمل**.
 * والمقارنة هنا **بالزيادة فقط**: نقصُ المُهمَل (تشغيلُ اختبار كان مُهمَلاً) تحسّنٌ لا خرق.
 * (**ثمرة دمج `agent/dl2`**: أُضيف هذا الشرط إلى مقارنة الأسماء أعلاه لا بدلاً منها.) */
if (tests.ignored > base.tests_ignored) {
  reasons.push(`اختبارات مُهمَلة: ${tests.ignored} > الأساس ${base.tests_ignored} — حارسٌ نُزع بـ#[ignore] بلا مراجعة (العدد الكلي يبقى سليماً فيمرّ صامتاً)`);
}

if (reasons.length) {
  for (const r of reasons) console.error('✗ ' + r);
  if (missing.length) {
    console.error('  الأسماء الغائبة (أوّل ٢٠):');
    for (const n of missing.slice(0, 20)) console.error('   · ' + n);
    if (missing.length > 20) console.error('   … و' + (missing.length - 20) + ' غيرها');
  }
  if (tests.extraFlagged.length) {
    console.error('  اختبارات بأعلام (أوّل ١٠):');
    for (const n of tests.extraFlagged.slice(0, 10)) console.error('   · ' + n);
  }
  if (clippy.unique > base.clippy_unique_warnings) {
    console.error('  مواضع clippy المقيسة (راجع الجديد منها):');
    for (const k of clippy.keys) console.error('   · ' + k);
  }
  console.error('✗ خطّ أساس بوّابات Rust مخروق — لا تُمرَّر البوّابة بتخفيض الرقم؛ راجع السبب أو حدِّث بـ--update بعد المراجعة.');
  process.exit(1);
}
if (!quiet) {
  console.log(`✓ خطّ أساس بوّابات Rust سليم: clippy ${clippy.unique}/${base.clippy_unique_warnings} موضعاً فريداً · ` +
    `اختبارات ${tests.passed} ناجح (الأساس ${base.tests_passed}) · ${tests.failed} فاشل · ${tests.ignored} مُهمَل · ` +
    (baseNames ? `الجرد ${tests.live.size}/${base.tests.length} اسماً والغائب صفر` : 'الجرد غير موجود في الأساس'));
  if (tests.ignoredNames.length) {
    console.log('  مُهمَل بالاسم: ' + tests.ignoredNames.join(' · '));
  }
  /* **وضبط المُهمَل يُطبع صراحةً** (ثمرة `agent/dl2`): الرقم وحده لا يقول هل قُورن بالأساس،
   * والمقارنة هي الحارس — فتُعلَن لا تُفترَض. */
  console.log(`  والمُهمَل مُقابَل بالأساس: ${tests.ignored} ≤ ${base.tests_ignored} (الزيادة تُسقط)`);
  if (!baseNames) {
    console.log('  ⚠ خطّ الأساس بلا جرد أسماء ⇒ المقارنة بالعدد وحده، وثقب «اختبار تافه مكان الحارس» مفتوح.' +
      '\n     حدِّثه بـ--update ليكتب الجرد (‏' + liveNames.length + ' اسماً مقيساً الآن).');
  }
  if (added.length) {
    console.log(`  ＋ اختبارات جديدة لم تكن في الأساس: ${added.length} — مقبولة، وحدِّث بـ--update ليثبت الجرد الجديد:`);
    for (const n of added.slice(0, 10)) console.log('     · ' + n);
    if (added.length > 10) console.log('     … و' + (added.length - 10) + ' غيرها');
  }
  if (base.toolchain?.clippy && base.toolchain.clippy !== toolchain.clippy) {
    console.log(`  ⚠ الأداة مختلفة عن التي قِيس عليها الأساس:\n     الأساس: ${base.toolchain.clippy}\n     الآن  : ${toolchain.clippy}` +
      '\n     ⇒ رقم أعلى قد يكون **لينتاً جديداً في الأداة** لا عطلاً في الشيفرة: راجع الفرق ثم حدِّث بـ--update.');
  }
  if (clippy.unique < base.clippy_unique_warnings || tests.passed > base.tests_passed || tests.ignored < base.tests_ignored) {
    console.log('  (تحسّن عن الأساس — حدِّثه بـ--update ليصير الوضع الجديد هو المرجع)');
  }
}
process.exit(0);
