#!/usr/bin/env node
/* بوّابة **خطوط الأساس لبوّابات Rust**: تحوّل رقمين يُقالان بالعين إلى بابٍ يُغلق البناء.
 *
 *   node scripts/check-rust-baselines.cjs [--baseline=<path>] [--update] [--quiet]
 *
 * **العطل الذي تعالجه** (كشفه جاسوس مستقل في تدقيق م٥، 2026-09-21): كان CI يشغّل
 * `cargo clippy --all-targets` **بلا `-D warnings`** و`cargo test --quiet` **بلا أي قيد على العدد**،
 * فكان `١٤ تحذيراً` و`٣٤٩ ناجحاً` **إعلانين يُقاسان بالعين لا بوّابتين** — تحذير جديد يمرّ أخضر،
 * وحذف عشرة اختبارات يمرّ أخضر، والرقم المعلَن في التقارير يبقى صحيحاً حتى اللحظة التي يكفّ فيها.
 * فهذه البوّابة تقرأ الرقمين من تشغيل حقيقي وتقابلهما بخطّ أساس **مكتوب ومُراجَع**:
 *
 *   ① **تحذيرات clippy**: تُعدّ **المواضع الفريدة** (`--message-format=json`: رمز التشخيص + ملف + سطر)
 *      — لا أسطر المخرَج، لأن cargo تطبع سطرَي ملخّص يبدآن بـ`warning:` أيضاً (خطأ قِسته على نفسي).
 *   ② **اختبارات Rust**: تُجمَع نتائج كل الأهداف، ويُشترط **صفر فاشل** و**ألّا يقلّ الناجح عن الأساس**.
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

/** نسخة الأداة: أساسٌ قِيس على clippy آخر لا يعني الشيء نفسه (لينت جديد يُضاف بين إصدارين). */
const toolchain = (() => {
  const c = cargoRun(['--version']);
  const cl = cargoRun(['clippy', '--version']);
  const pick = (s) => (s || '').trim().split(/\r?\n/)[0];
  return { cargo: pick(c.stdout), clippy: pick(cl.stdout) };
})();

/* ── ① تحذيرات clippy: مواضع فريدة من JSON ───────────────────────────────── */
/** **بلا `--quiet`**: التشخيصات تُكتب JSON على stdout، و`--quiet` جُرِّب فأعطى رقماً خاطئاً (١٢ بدل ١٥)
 *  — والقياس الموثوق يُكتب إلى **ملف** ثم يُقرأ، لا عبر أنبوب مع `--quiet`. */
function clippyUniqueWarnings() {
  const r = cargoRun(['clippy', '--all-targets', '--manifest-path', MANIFEST, '--message-format=json'],
    { maxBuffer: 512 * 1024 * 1024 });
  if (r.error) return { error: r.error.message };
  const out = r.stdout || '';
  const seen = new Map();
  let parsed = 0;
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let j; try { j = JSON.parse(t); } catch { continue; }
    if (j.reason !== 'compiler-message' || !j.message) continue;
    if (j.message.level !== 'warning') continue;
    parsed++;
    const code = j.message.code?.code || '(بلا رمز)';
    const span = (j.message.spans || []).find((s) => s.is_primary) || (j.message.spans || [])[0] || {};
    seen.set(`${code}|${span.file_name || '?'}|${span.line_start || 0}|${span.column_start || 0}`, true);
  }
  if (parsed === 0) return { error: 'لم يُقرأ تشخيص واحد من clippy (لا JSON في المخرَج)' };
  return { unique: seen.size, keys: [...seen.keys()].sort(), raw: parsed, status: r.status };
}

/* ── ② اختبارات Rust: مجموع نتائج كل الأهداف ─────────────────────────────── */
function rustTestTotals() {
  const r = cargoRun(['test', '--quiet', '--manifest-path', MANIFEST],
    { maxBuffer: 256 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.error) return { error: r.error.message };
  let passed = 0, failed = 0, ignored = 0, results = 0;
  for (const m of out.matchAll(/test result:\s*(\w+)\.\s*(\d+) passed;\s*(\d+) failed;\s*(\d+) ignored/g)) {
    results++; passed += Number(m[2]); failed += Number(m[3]); ignored += Number(m[4]);
  }
  if (results === 0) return { error: 'لم يُقرأ سطر «test result:» واحد — لا نتيجة تُقاس' };
  return { passed, failed, ignored, results, status: r.status };
}

const clippy = clippyUniqueWarnings();
const tests = rustTestTotals();
if (clippy.error || tests.error) {
  console.error('✗ صفر مدخل: ' + (clippy.error || tests.error));
  process.exit(2);
}

if (update) {
  const data = {
    why: 'خطّ أساس مقيس لبوّابات Rust — يُحدَّث بـ--update بعد مراجعة السبب، ولا يُخفَّض لتُمرَّر بوّابة.',
    clippy_unique_warnings: clippy.unique,
    tests_passed: tests.passed,
    tests_ignored: tests.ignored,
    toolchain,
    measured_at: new Date().toISOString().slice(0, 10) + ' · ' + (process.env.HL_BASELINE_NOTE || 'قياس محلي'),
  };
  fs.writeFileSync(baselinePath, JSON.stringify(data, null, 2) + '\n');
  console.log('✓ حُدِّث خطّ الأساس: ' + baselinePath);
  console.log(`  clippy=${clippy.unique} · tests_passed=${tests.passed} · ignored=${tests.ignored}`);
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
for (const k of ['clippy_unique_warnings', 'tests_passed']) {
  if (typeof base[k] !== 'number') { console.error('✗ صفر مدخل: حقل «' + k + '» مفقود من خطّ الأساس'); process.exit(2); }
}

const reasons = [];
if (clippy.unique > base.clippy_unique_warnings) {
  reasons.push(`تحذيرات clippy: ${clippy.unique} موضعاً فريداً > الأساس ${base.clippy_unique_warnings} — تحذير جديد لم يُراجَع`);
}
if (tests.failed > 0) reasons.push(`اختبارات فاشلة: ${tests.failed} (يجب صفر)`);
if (tests.passed < base.tests_passed) {
  reasons.push(`اختبارات ناجحة: ${tests.passed} < الأساس ${base.tests_passed} — نقصٌ لا يُقبل بلا تفسير (اختبارات حُذفت أو أُهملت؟)`);
}

if (reasons.length) {
  for (const r of reasons) console.error('✗ ' + r);
  if (clippy.unique > base.clippy_unique_warnings) {
    console.error('  مواضع clippy المقيسة (راجع الجديد منها):');
    for (const k of clippy.keys) console.error('   · ' + k);
  }
  console.error('✗ خطّ أساس بوّابات Rust مخروق — لا تُمرَّر البوّابة بتخفيض الرقم؛ راجع السبب أو حدِّث بـ--update بعد المراجعة.');
  process.exit(1);
}
if (!quiet) {
  console.log(`✓ خطّ أساس بوّابات Rust سليم: clippy ${clippy.unique}/${base.clippy_unique_warnings} موضعاً فريداً · ` +
    `اختبارات ${tests.passed} ناجح (الأساس ${base.tests_passed}) · ${tests.failed} فاشل · ${tests.ignored} مُهمَل`);
  if (base.toolchain?.clippy && base.toolchain.clippy !== toolchain.clippy) {
    console.log(`  ⚠ الأداة مختلفة عن التي قِيس عليها الأساس:\n     الأساس: ${base.toolchain.clippy}\n     الآن  : ${toolchain.clippy}` +
      '\n     ⇒ رقم أعلى قد يكون **لينتاً جديداً في الأداة** لا عطلاً في الشيفرة: راجع الفرق ثم حدِّث بـ--update.');
  }
  if (clippy.unique < base.clippy_unique_warnings || tests.passed > base.tests_passed) {
    console.log('  (تحسّن عن الأساس — حدِّثه بـ--update ليصير الوضع الجديد هو المرجع)');
  }
}
process.exit(0);
