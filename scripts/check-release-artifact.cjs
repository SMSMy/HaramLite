#!/usr/bin/env node
/* بوّابة **نسب نسخة الإصدار** — تُشغَّل قبل تسليم أي ثنائي للمالك.
 *
 *   node scripts/check-release-artifact.cjs [--root <dir>] [--exe <path>]
 *                                          [--slack <ثوانٍ>] [--self-test] [--quiet]
 *
 * **ما تحكمه**: أن الثنائي الذي يُسلَّم **هو** بناء هذه الشيفرة، لا بناء أقدم.
 * فتقيس شيئين لا يُقاسان بالنظر إلى اسم الملف ولا إلى وقته:
 *
 *   ① **الحداثة**: لا يجوز أن يكون الثنائي أقدم من أحدث ملف مصدر يشارك في بنائه
 *      (بهامش `--slack` ثوانٍ، افتراضيّ ٠) — فالدمج يُبطل الثنائي حتى يُعاد بناؤه.
 *   ② **السلوك الحيّ**: يُشغَّل الثنائي نفسه على مسار التنزيل الإنتاجي
 *      (`--url`) و`yt-dlp` **مزيّف** يسجّل وسائطه، ثم تُفحَص الوسائط المسجَّلة:
 *      هل تمرّرت الأعلام التي في الشيفرة المدموجة فعلاً؟ (‏`--no-quiet` ·
 *      `--newline` · `--print after_move:HARAMLITE_OUT:`). فالمقيس **سلوك الثنائي**
 *      لا وجود نصّ في ملف.
 *
 * **ولماذا السلوك لا البايتات — قياس 2026-09-21**: أُولى صور هذه البوّابة كانت
 * تبحث عن الأعلام **بايتاً بايتاً** داخل الثنائي، فأسقطت ثنائياً سليماً بالإجماع
 * من ثلاث أدوات (‏`node` · ‏.NET · ‏`findstr`) لأن `--no-quiet` و`--newline`
 * **لا توجد بايتاتهما المتّصلة في الصورة النهائية** بينما هما — بالقياس الحيّ —
 * **تُمرَّران فعلاً** إلى `yt-dlp`؛ والـ`rlib` قبل الربط يحويهما. أي أن الحارس
 * كان يقيس **تمثيلاً** لا واقعاً: يمرّ على العطب ويسقط على السليم. وهذا بعينه ما
 * تمنعه قاعدة «الحارس يقيس واقعاً» في هذا المستودع. فاستُبدل بالمناداة الحيّة.
 *
 * `--self-test` يشغّل الحالتين معاً: **ضابط** (الثنائي الحقيقي يمرّ) و**مُفسَد**
 * (برنامج لا يمرّر الأعلام ⇒ البوّابة **تسقط**) — فلا تكون البوّابة عمياء.
 *
 * رموز الخروج: ٠ سليم · ١ عطل مُسمّى · ٢ **صفر مدخل** (لا مصدر واحد من الجدول
 * موجود، أو `rustc` مفقود لبناء المزيّف ⇒ لا يُعلن نجاح فارغ).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/* ── الوسائط ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
let root = path.resolve(__dirname, '..');
let exeArg = null;
let slackSec = 0;
let selfTest = false;
let quiet = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') { root = path.resolve(argv[++i] ?? die('--root يحتاج مساراً')); }
  else if (a === '--exe') { exeArg = path.resolve(argv[++i] ?? die('--exe يحتاج مساراً')); }
  else if (a === '--slack') {
    slackSec = Number(argv[++i] ?? die('--slack يحتاج عدداً'));
    if (!Number.isFinite(slackSec) || slackSec < 0) die('--slack لا بدّ أن يكون عدداً ≥ ٠');
  } else if (a === '--self-test') { selfTest = true; }
  else if (a === '--quiet') { quiet = true; }
  else die('وسيط غير معروف: ' + a);
}
function die(msg) { console.error('✗ ' + msg); process.exit(2); }

const EXE = exeArg || path.join(root, 'src-tauri', 'target', 'release', 'HaramLite.exe');

/* ── الجدول: كل عَلَم مربوط بملف مصدره (فحص الانحراف) ────────────────────── */
const FLAGS = [
  { lit: '--no-quiet', src: 'src-tauri/src/yt_dlp.rs',
    why: 'يمنع صمت yt-dlp (‏`--print` يعني `--quiet`) ⇒ بغيابه يقف شريط التقدّم عند ٠٪' },
  { lit: '--newline', src: 'src-tauri/src/yt_dlp.rs',
    why: 'تقدّم التنزيل سطراً سطراً' },
  { lit: 'after_move:HARAMLITE_OUT:', src: 'src-tauri/src/yt_dlp.rs',
    why: 'ذيل الفشل (forensics)' },
];

const FAKE_SRC = `// yt-dlp مزيّف: يسجّل وسائطه الحقيقية ثم يفشل. يُبنى بـrustc بلا اعتماديات.
use std::io::Write;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Ok(p) = std::env::var("HL_ARGV_LOG") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(f, "ARGV[{}]: {}", args.len(), args.join(" "));
        }
    }
    if args.iter().any(|a| a == "--dump-single-json") {
        print!("{{\\"id\\":\\"probe1\\",\\"title\\":\\"Probe\\",\\"ext\\":\\"mp4\\"}}");
        let _ = std::io::stdout().flush();
        return;
    }
    std::process::exit(1);
}
`;

/* ── ① المصادر: هل الجدول ما زال مطابقاً للشيفرة؟ ────────────────────────── */
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const reasons = [];
const anchors = FLAGS.filter((f) => exists(path.join(root, f.src)));
if (anchors.length === 0) {
  die('صفر مدخل: لا ملف مصدر واحد من جدول الأعلام موجود تحت ' + root +
      '\n  (المتوقَّع: ' + FLAGS.map((f) => f.src).join(' · ') + ')');
}
for (const f of FLAGS) {
  const p = path.join(root, f.src);
  if (!exists(p)) { reasons.push('انحراف الجدول: ملف المصدر مفقود ' + f.src + ' (العَلَم «' + f.lit + '» — ' + f.why + ')'); continue; }
  if (!fs.readFileSync(p, 'utf8').includes(f.lit)) {
    reasons.push('انحراف العَلَم: «' + f.lit + '» لم يبقَ في ' + f.src + ' ⇒ إمّا أُزيل سلوكه (فحدِّث الجدول بوعي) وإمّا نُقل (فصحّح المسار)');
  }
}

/* ── ② الثنائي موجود · والحداثة ──────────────────────────────────────────── */
let exeStat = null;
if (!exists(EXE)) {
  reasons.push('نسخة الإصدار مفقودة: ' + EXE + ' — لا يُتحقَّق من نسب ثنائي غير موجود');
} else {
  exeStat = fs.statSync(EXE);
  const set = [];
  for (const rel of ['src-tauri/src', 'src-tauri/capabilities', 'src']) {
    const dir = path.join(root, rel);
    if (exists(dir)) {
      const stack = [dir];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const p = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(p); else set.push(p);
        }
      }
    }
  }
  for (const rel of ['index.html', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml']) {
    if (exists(path.join(root, rel))) set.push(path.join(root, rel));
  }
  /* من `dist` تُقاس الشيفرة المبنيّة وحدها (‏index.html وjs/css): الخطوط
     والأصوات المنقولة تُحدَّث مع كل بناء واجهة فتُشوّش اسم «أحدث مصدر». */
  const distDir = path.join(root, 'dist');
  if (exists(path.join(distDir, 'index.html'))) set.push(path.join(distDir, 'index.html'));
  for (const p of (exists(path.join(distDir, 'assets')) ? fs.readdirSync(path.join(distDir, 'assets')) : [])) {
    if (/\.(?:js|css)$/.test(p)) set.push(path.join(distDir, 'assets', p));
  }
  let newest = null;
  for (const p of set) {
    const st = fs.statSync(p);
    if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: p, mtimeMs: st.mtimeMs };
  }
  if (newest && exeStat.mtimeMs + slackSec * 1000 < newest.mtimeMs) {
    reasons.push('الثنائي أقدم من الشيفرة: ' + path.relative(root, newest.path) + ' أحدث منه بـ' +
      ((newest.mtimeMs - exeStat.mtimeMs) / 60000).toFixed(1) + ' دقيقة ⇒ أَعِد البناء (الدمج يُبطل الثنائي)');
  }
}

/* ── ③ القياس الحيّ: ما الذي يمرّره الثنائي إلى yt-dlp فعلاً؟ ────────────── */
/** `rustc` ليس على PATH في هذا المستودع بالضرورة (كما `cargo`) — فيُطلَب صراحةً. */
function rustcPath() {
  const probe = spawnSync('rustc', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (!probe.error && probe.status === 0) return 'rustc';
  const home = process.env.USERPROFILE;
  if (home) {
    const p = path.join(home, '.cargo', 'bin', 'rustc.exe');
    if (exists(p)) return p;
  }
  return null;
}

function buildFake(toolsDir) {
  const rustc = rustcPath();
  if (!rustc) return { error: 'rustc غير موجود (لا على PATH ولا في %USERPROFILE%\\.cargo\\bin) — لا سبيل لبناء yt-dlp المزيّف، فلا يُعلن نجاح' };
  fs.mkdirSync(toolsDir, { recursive: true });
  const src = path.join(toolsDir, 'fake_ytdlp.rs');
  fs.writeFileSync(src, FAKE_SRC);
  const exe = path.join(toolsDir, 'yt-dlp.exe');
  const r = spawnSync(rustc, ['-O', '--edition', '2021', '-o', exe, src],
    { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) {
    return { error: 'rustc: ' + (r.error ? r.error.message : (r.stdout || '') + (r.stderr || '')) };
  }
  return { exe };
}

function probe(exe, workDir) {
  const tools = path.join(workDir, 'tools');
  const out = path.join(workDir, 'out');
  fs.mkdirSync(out, { recursive: true });
  const built = buildFake(tools);
  if (built.error) return { error: built.error };
  const log = path.join(workDir, 'argv.log');
  fs.rmSync(log, { force: true });
  const r = spawnSync(exe, ['--url', 'https://www.youtube.com/watch?v=abcdefghijk', '--out', out], {
    encoding: 'utf8', windowsHide: true, timeout: 90000,
    env: {
      ...process.env,
      HARAMLITE_TOOLS_DIR: tools,
      HL_ARGV_LOG: log,
      HARAMLITE_DATA_DIR: path.join(workDir, 'data'),
    },
  });
  if (r.error) return { error: 'تشغيل الثنائي: ' + r.error.message };
  const text = exists(log) ? fs.readFileSync(log, 'utf8') : '';
  if (!text.trim()) {
    return { error: 'الثنائي لم ينادِ yt-dlp المزيّف ولا مرّة (خرج الثنائي=' + r.status + ')' };
  }
  /* نأخذ سطر التنزيل (الأطول) لا سطر قراءة البيانات الوصفية. */
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith('ARGV['));
  const dl = lines.sort((a, b) => b.length - a.length)[0] || '';
  const missing = FLAGS.filter((f) => !dl.includes(f.lit));
  return { argv: dl, missing, calls: lines.length };
}

if (exeStat && !reasons.length) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-relverify-'));
  const res = probe(EXE, work);
  if (res.error) reasons.push('القياس الحيّ فشل: ' + res.error);
  else if (res.missing.length) {
    reasons.push('الثنائي لم يمرّر ' + res.missing.map((m) => '«' + m.lit + '» (' + m.why + ')').join(' · ') +
      ' ⇒ مبنيّ من شيفرة غير هذه');
  } else if (!quiet) {
    console.log('  نُودي yt-dlp المزيّف ' + res.calls + ' مرّة · التنزيل: ' + res.argv.slice(0, 200));
  }
  fs.rmSync(work, { recursive: true, force: true });
}

/* ── الخرج ───────────────────────────────────────────────────────────────── */
function report(ok, prefix) {
  const size = exeStat ? (exeStat.size / (1024 * 1024)).toFixed(1) + ' MiB' : '—';
  const d = exeStat ? new Date(exeStat.mtimeMs - new Date().getTimezoneOffset() * 60000) : null;
  const when = d ? d.toISOString().replace('T', ' ').slice(0, 16) : '—';
  if (ok) {
    if (!quiet) console.log(prefix + '✓ نسب نسخة الإصدار مُثبَت: ' + FLAGS.length + ' أعلام مُقاسة حيّاً · ' + size + ' · ' + when);
    return true;
  }
  for (const r of reasons) console.error(prefix + '✗ ' + r);
  console.error(prefix + '✗ نسب نسخة الإصدار غير مُثبَت (' + reasons.length + ' سبباً) — لا تُسلَّم هذه النسخة.');
  return false;
}

if (!selfTest) process.exit(report(reasons.length === 0, '') ? 0 : 1);

/* ── الاختبار الذاتي: ضابط يمرّ + مُفسَد يسقط ───────────────────────────── */
console.log('اختبار ذاتي للبوّابة — ضابط ومُفسَد:');
const control = reasons.length === 0;
report(control, '  [ضابط] ');
if (!control) { console.error('  [ضابط] ✗ الثنائي الحقيقي يجب أن يمرّ — فلا معنى لاختبار مُفسَد.'); process.exit(1); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-relverify-mut-'));
const tools = path.join(work, 'tools');
const built = buildFake(tools);
if (built.error) { console.error('  [مُفسَد] ✗ ' + built.error); process.exit(2); }
/* المُفسَد: «نسخة قديمة» = برنامج لا يمرّر أعلام التنزيل (نقطة انطلاقه المزيّف نفسه). */
const fakeAsApp = path.join(work, 'HaramLite-old.exe');
fs.copyFileSync(built.exe, fakeAsApp);
const res = probe(fakeAsApp, path.join(work, 'run'));
const failedAsExpected = !!res.missing && res.missing.length > 0;
if (failedAsExpected) {
  console.log('  [مُفسَد] ✓ برنامج لا يمرّر الأعلام أسقط البوّابة: ' +
    res.missing.map((m) => m.lit).join(' · '));
} else {
  console.error('  [مُفسَد] ✗ البوّابة مرّت على برنامج لا يمرّر الأعلام ⇒ حارس أعمى.');
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(failedAsExpected ? 0 : 1);
