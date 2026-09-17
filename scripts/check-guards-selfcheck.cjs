#!/usr/bin/env node
/* البوّابة الثالثة عشرة: **تحرس الحرّاس أنفسهم**.
 *
 *   node scripts/check-guards-selfcheck.cjs [--keep] [--only <اسم>]
 *
 * لماذا: الدرس الذي تكرّر في هذا المستودع أن «حارساً أخضر لا يعني أنه يرى»؛
 * والدليل الوحيد أن يسقط على نصّ مُخرَّب. وقد قِيس فعلاً أن ثمانية حرّاس كانوا
 * يمرّون على مدخل فارغ، أو يُسقطهم عيب لا يُسمّونه، أو يُصنّفون انهيار الحارس
 * اصطياداً. فهذه البوّابة تُعيد إنتاج الحالتين معاً لكل حارس، في بيئة مصنوعة،
 * وتفشل إن اختلّ واحد من ثلاثة:
 *
 *   ① **مُفسَد مرّ**: بيئة فيها العيب يجب أن يُسقط الحارس (exit ≠ 0 و«✗»).
 *   ② **ضابط فشل**: بيئة سليمة يجب أن يمرّ عليها الحارس (exit 0) **وقد رأى
 *      مدخلاً غير صفري** — وإلا فالحارس يمرّ لأنه لم ينظر، لا لأنه نظر فسلم.
 *   ③ **صفر مدخل**: بيئة بلا مدخلات يجب أن **تُسقط** الحارس برسالة مسمّاة،
 *      لا أن تعلن نجاحاً فارغاً ولا أن تنهار بـstack trace.
 *
 * البيئة المصنوعة تُبنى تحت `%LOCALAPPDATA%\Temp\` (أو `os.tmpdir()`) وتُحذف
 * في النهاية؛ و`--keep` يُبقيها للتفتيش.
 *
 * سلامة التشغيل: كل عمليات الخادم تُطلق بـ`windowsHide` وبلا نافذة، واحداً في
 * كل مرة، ويُوقَف قبل الانتقال، وبمنفذ 0 (منفذ حرّ يختاره النظام) فلا يصطدم
 * بشيء يعمل على الجهاز.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const net = require('net');

const REPO = path.resolve(__dirname, '..');
const S = (n) => path.join(REPO, 'scripts', n);

/* ── الوسائط ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
let keep = false, only = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--keep') keep = true;
  else if (argv[i] === '--only') {
    if (argv[i + 1] === undefined) { console.error('✗ --only يحتاج اسماً'); process.exit(2); }
    only = argv[++i];
  } else { console.error('✗ وسيط غير معروف: ' + argv[i]); process.exit(2); }
}

const TMP_BASE = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Temp')
  : os.tmpdir();
const WORK = fs.mkdtempSync(path.join(TMP_BASE, 'hl-guards-selfcheck-'));

/* ── أدوات ───────────────────────────────────────────────────────────────── */
function mk(dir, rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
function copyInto(dst, rel, srcAbs) {
  const p = path.join(dst, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.copyFileSync(srcAbs, p);
}
function readVer(p) {
  try {
    const m = fs.readFileSync(p, 'utf8').match(/"?version"?\s*[:=]\s*"([^"]+)"|\{\s*"version"\s*:\s*"([^"]+)"/);
    return m ? (m[1] || m[2]) : '(لا شيء)';
  } catch { return '(مفقود)'; }
}
function runNode(script, args, cwd, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: cwd || REPO, encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function runGit(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}
function initRepo(dir) {
  runGit(['init', '-q'], dir);
  runGit(['config', 'user.email', 'selfcheck@local'], dir);
  runGit(['config', 'user.name', 'selfcheck'], dir);
  runGit(['add', '-A'], dir);
  runGit(['commit', '-qm', 'init'], dir);
}
/** طلب HTTP خام بلا تطبيع للمسار (سوكيت مباشر) — يقيس ما يصل الخادم فعلاً. */
function rawGet(port, target, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '', done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch { /* gone */ } resolve(v); } };
    s.setTimeout(timeoutMs, () => fin({ status: 'TIMEOUT', body: '' }));
    s.on('connect', () => s.write('GET ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
    s.on('data', (d) => { buf += d.toString('latin1'); });
    s.on('close', () => {
      const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
      fin({ status: m ? m[1] : (buf ? '???' : 'NO-RESPONSE'), body: buf.split('\r\n\r\n').slice(1).join('\r\n\r\n') });
    });
    s.on('error', (e) => fin({ status: 'ERR ' + (e.code || e.message), body: '' }));
  });
}

/* ── الحالات: بيئة سليمة · مُفسَدات · صفر مدخل ───────────────────────────── */

const CASES = [];

/* ═══ 1) حارس الروابط والادّعاءات ═══════════════════════════════════════════ */
CASES.push({
  name: 'check-site-links.cjs',
  script: S('check-site-links.cjs'),
  build(dir) {
    mk(dir, 'docs/guides/g.html',
      '<!doctype html><html dir="rtl"><body><main>' +
      '<a data-path="guide-a" href="a.html">دليل أ</a>' +
      '<p>يفتح على localhost:9191 للمعاينة</p>' +
      '</main></body></html>\n');
    mk(dir, 'docs/guides/a.html', '<!doctype html><html><body><main>أ</main></body></html>\n');
    mk(dir, 'src-tauri/src/lib.rs', 'pub const PORT: u16 = 9191;\n');
  },
  controlArgs: (dir) => ['--root', dir],
  saw: (dir, res) => { const m = res.out.match(/حارس الروابط والادّعاءات: (\d+) صفحة/); return m ? Number(m[1]) : 0; },
  mutants: [
    { label: 'منفذ يمرّ ببادئة رقم أطول (91910 يشمل 9191)',
      apply: (dir) => mk(dir, 'src-tauri/src/lib.rs', 'pub const DEV_FALLBACK: u32 = 91910;\n') },
    { label: 'منفذ موجود في تعليق Rust فقط',
      apply: (dir) => mk(dir, 'src-tauri/src/lib.rs', '// منفذ 9191 الاحتياطي\npub fn noop() {}\n') },
    { label: 'وجهة بالاسم الأساسي فقط (does-not-exist/a.html مع وجود a.html)',
      apply: (dir) => mk(dir, 'docs/guides/g.html',
        '<!doctype html><html><body><main><a data-path="deep" href="does-not-exist/a.html">بطاقة</a></main></body></html>\n') },
  ],
  zero: { label: 'docs/guides فارغ',
    apply: (dir) => { fs.rmSync(path.join(dir, 'docs/guides'), { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'docs/guides'), { recursive: true }); } },
});

/* ═══ 2) حارس توازن الوسوم ══════════════════════════════════════════════════ */
CASES.push({
  name: 'check-site-tags.cjs',
  script: S('check-site-tags.cjs'),
  build(dir) {
    mk(dir, 'docs/ok.html', '<!doctype html><html><body><div><span></span></div></body></html>\n');
  },
  controlArgs: (dir) => ['--root', dir],
  saw: (dir, res) => { const m = res.out.match(/سليم في (\d+) صفحة/); return m ? Number(m[1]) : 0; },
  mutants: [
    { label: 'وسم غير مغلق داخل وسم مغلق',
      apply: (dir) => mk(dir, 'docs/bad.html', '<!doctype html><html><body><div><span></div></body></html>\n') },
    { label: 'وسم شارد بلا فاتح',
      apply: (dir) => mk(dir, 'docs/bad.html', '<!doctype html><html><body></article></body></html>\n') },
  ],
  zero: { label: 'docs فارغ',
    apply: (dir) => { fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'docs'), { recursive: true }); } },
});

/* ═══ 3) حارس العربية ═══════════════════════════════════════════════════════ */
const AR_PAGE = (title, desc) =>
  '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
  '<title>' + title + '</title>' +
  '<meta name="description" content="' + desc + '">' +
  '</head><body><main><p>نصّ عربي قصير.</p></main></body></html>\n';
CASES.push({
  name: 'check-site-arabic.cjs',
  script: S('check-site-arabic.cjs'),
  build(dir) {
    mk(dir, 'docs/ok.html', AR_PAGE('دليل تجريبي لموقع HaramLite', 'وصف تجريبي تام الجملة.'));
  },
  controlArgs: (dir) => ['--root', dir],
  saw: (dir, res) => { const m = res.out.match(/فحص (\d+) صفحة/); return m ? Number(m[1]) : 0; },
  mutants: [
    { label: 'عنوان أطول من الحدّ (مقطوع)',
      apply: (dir) => mk(dir, 'docs/bad.html', AR_PAGE('د'.repeat(70), 'وصف تجريبي تام الجملة.')) },
    { label: 'وصف لا ينتهي بجملة تامة',
      apply: (dir) => mk(dir, 'docs/bad.html', AR_PAGE('عنوان سليم', 'وصف مقطوع في منتصف كلمة')) },
    { label: 'صياغة مرفوضة عادت',
      apply: (dir) => mk(dir, 'docs/bad.html', AR_PAGE('عنوان سليم', 'وصف تام الجملة.') .replace('نصّ عربي قصير.', 'توفير وقت الرندرة')) },
  ],
  zero: { label: 'docs فارغ',
    apply: (dir) => { fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'docs'), { recursive: true }); } },
});

/* ═══ 4) حارس CSS ═══════════════════════════════════════════════════════════ */
const CSS_CFG =
  'module.exports = { theme: { extend: {\n' +
  '  fontFamily: { sans: ["Thmanyah Sans"], display: ["Thmanyah Serif Display"] },\n' +
  '  colors: { clay: { DEFAULT: "#da7756", hover: "#ea8361" }, coal: { 900: "#151311" }, cream: { muted: "#a38c85" } }\n' +
  '} } };\n';
const CSS_FILE =
  "@font-face{font-family:'Thmanyah Sans';src:url(sans.woff2)}\n" +
  "@font-face{font-family:'Thmanyah Serif Display';src:url(display.woff2)}\n" +
  ".font-sans{font-family:'Thmanyah Sans'}\n" +
  ".bg-coal-card{}\n.border-coal-border{}\n.text-cream-muted{}\n.entry-card__front{}\n.border-glow-clay{}\n";
CASES.push({
  name: 'check-site-css.cjs',
  script: S('check-site-css.cjs'),
  build(dir) {
    mk(dir, 'site.tailwind.config.cjs', CSS_CFG);
    mk(dir, 'docs/assets/site.css', CSS_FILE);
    mk(dir, 'docs/assets/sans.woff2', 'FONT');
    mk(dir, 'docs/assets/display.woff2', 'FONT');
    mk(dir, 'docs/assets/icons-subset.txt', 'play_arrow\n');
    for (const p of ['index', 'bridge', 'PRIVACY', 'bridge-privacy', 'TRANSPARENCY', '404']) {
      mk(dir, 'docs/' + p + '.html',
        '<!doctype html><html><body class="font-sans"><span class="material-symbols-outlined">play_arrow</span></body></html>\n');
    }
    fs.mkdirSync(path.join(dir, 'docs/guides'), { recursive: true });
  },
  controlArgs: (dir) => ['--root', dir],
  saw: (dir, res) => { const m = res.out.match(/(\d+) فحصاً ناجحاً/); return m ? Number(m[1]) : 0; },
  mutants: [
    { label: 'فرع لوني كامل مُسقط (clay) ⇒ يجب أن يسمّيه لا أن ينهار',
      apply: (dir) => mk(dir, 'site.tailwind.config.cjs', CSS_CFG.replace(
        'clay: { DEFAULT: "#da7756", hover: "#ea8361" }, ', '')),
      mustMatch: /clay/i },
    { label: 'صنف تصميم مفقود من CSS',
      apply: (dir) => mk(dir, 'docs/assets/site.css', CSS_FILE.replace('.border-glow-clay{}\n', '')) },
    { label: 'أيقونة مستخدمة غير موجودة في الخط المضغوط',
      apply: (dir) => mk(dir, 'docs/404.html',
        '<!doctype html><html><body><span class="material-symbols-outlined">graphic_eq</span></body></html>\n') },
  ],
  zero: { label: 'صفحات الجذر الست غائبة',
    apply: (dir) => { for (const p of ['index', 'bridge', 'PRIVACY', 'bridge-privacy', 'TRANSPARENCY', '404']) fs.rmSync(path.join(dir, 'docs/' + p + '.html'), { force: true }); } },
});

/* ═══ 5) حاكم المُفسَدات (يُقاس بـ--spec على حارس مصنوع) ═══════════════════ */
const STUB_GUARD =
  "const fs = require('fs');\n" +
  "const path = require('path');\n" +
  "const s = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');\n" +
  "if (s.includes('BOOM')) throw new Error('بنية غير متوقّعة: تعذّر الاستخراج');\n" +
  "if (s.includes('BOOMX')) throw new Error('✗ تعذّر الاستخراج إطلاقاً');\n" +
  "if (!s.includes('const A = 1;')) { console.error('✗ A مفقود'); process.exit(1); }\n" +
  "console.log('✓ الحارس المصنوع سليم');\n";
function stubSpec(dir, mutantsSrc) {
  return "const path = require('path');\n" +
    "module.exports = {\n" +
    "  content: path.join(__dirname, 'content.js'),\n" +
    "  guard: path.join(__dirname, 'guard.cjs'),\n" +
    "  mutants: " + mutantsSrc + ",\n" +
    "};\n";
}
CASES.push({
  name: 'check-extension-mutants.cjs',
  script: S('check-extension-mutants.cjs'),
  build(dir) {
    mk(dir, 'content.js', 'const A = 1;\n');
    mk(dir, 'guard.cjs', STUB_GUARD);
    // الضابط: مُفسَد صالح يُسقط الحارس ⇒ الحاكم يمرّ بعدّ اصطياد ≥ 1.
    // (تُكتب المواصفة هنا لا في `controlArgs`: تلك تُنادى لكل حالة، فكانت تدهس
    //  مواصفة المُفسَد قبل تشغيله — عيب في البوّابة نفسها أمسكه تشغيلها الأول.)
    mk(dir, 'spec.cjs', stubSpec(dir, "[['حذف A', (s) => s.replace('const A = 1;', '')]]"));
  },
  controlArgs: (dir) => ['--spec', path.join(dir, 'spec.cjs')],
  saw: (dir, res) => { const m = res.out.match(/أسقط (\d+)/); return m ? Number(m[1]) : 0; },
  mutants: [
    { label: 'مُفسَد يُسقط الحارس برمي استثناء بلا ✗ ⇒ الحاكم يفشل (لا يُحتسب اصطياداً)',
      apply: (dir) => mk(dir, 'spec.cjs', stubSpec(dir, "[['رمي بلا ✗', (s) => s.replace('const A = 1;', 'BOOM')]]")),
      mustMatch: /THREW/ },
    { label: 'مُفسَد يُسقط الحارس برمي استثناء رسالته تحمل ✗ ⇒ لا يُحتسب اصطياداً',
      apply: (dir) => mk(dir, 'spec.cjs', stubSpec(dir, "[['رمي بـ✗', (s) => s.replace('const A = 1;', 'BOOMX')]]")),
      mustMatch: /THREW/ },
    { label: 'مُفسَد يمرّ فعلاً ⇒ ثقب يُعلن',
      apply: (dir) => mk(dir, 'spec.cjs', stubSpec(dir, "[['تغيير لا يراه', (s) => s + '// tail\\n']]")),
      mustMatch: /ثقب/ },
  ],
  zero: { label: 'صفر مُفسَد مُطبَّق (كل المُفسَدات متخطّاة)',
    apply: (dir) => mk(dir, 'spec.cjs', stubSpec(dir, "[['لا ينطبق', (s) => s]]")),
    args: (dir) => ['--spec', path.join(dir, 'spec.cjs')] },
});

/* ═══ 6) خادم المعاينة ══════════════════════════════════════════════════════ */
const SERVE_MARK = 'OUTSIDE-DOCS-SECRET';
CASES.push({
  name: 'serve-site.cjs',
  script: S('serve-site.cjs'),
  server: true,
  build(dir) {
    mk(dir, 'site/index.html', 'INSIDE-OK\n');
    mk(dir, 'site-qa-probe/marker.txt', SERVE_MARK + '\n');
    fs.mkdirSync(path.join(dir, 'site'), { recursive: true });
  },
  controlRequest: { target: '/index.html', expectStatus: '200', expectBody: /INSIDE-OK/, forbidBody: new RegExp(SERVE_MARK) },
  mutants: [
    { label: 'تجواز: /../site-qa-probe/marker.txt لا يُسرّب خارج الجذر',
      request: { target: '/../site-qa-probe/marker.txt' }, forbidBody: new RegExp(SERVE_MARK) },
    { label: 'تجواز مُرمَّز: /%2e%2e/site-qa-probe/marker.txt',
      request: { target: '/%2e%2e/site-qa-probe/marker.txt' }, forbidBody: new RegExp(SERVE_MARK) },
    { label: 'طلب مشوّه: /% يُردّ 400 ولا يُسقط العملية',
      request: { target: '/%' }, expectStatusAfter: '400' },
  ],
  zero: { label: 'جذر غير موجود',
    run: (dir) => runNode(S('serve-site.cjs'), ['--root', path.join(dir, 'no-such-dir')]) },
});

/* ═══ 7) رافع الإصدار ═══════════════════════════════════════════════════════ */
const BUMP_FILES = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
function bumpFixture(dir, lockVer) {
  mk(dir, 'package.json', '{\n  "name": "x",\n  "private": true,\n  "version": "0.2.0"\n}\n');
  mk(dir, 'src-tauri/tauri.conf.json', '{\n  "version": "0.2.0"\n}\n');
  mk(dir, 'src-tauri/Cargo.toml', '[package]\nname = "haramlite-rs"\nversion = "0.2.0"\n');
  mk(dir, 'src-tauri/Cargo.lock',
    'version = 4\n\n[[package]]\nname = "haramlite-rs"\nversion = "' + lockVer + '"\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\n');
}
CASES.push({
  name: 'bump-version.cjs',
  script: S('bump-version.cjs'),
  build(dir) { bumpFixture(dir, '0.2.0'); },
  /* النسخ الاحتياطية للرافع تُكتب في `os.tmpdir()` وتبقى عند الفشل (وهو المقصود:
     هي مصدر الاسترجاع ودليل المستخدم). وفي هذه البوّابة الفشل **مزروع عمداً**،
     فنُحوّل TEMP/TMP للطفل إلى داخل بيئة البوّابة حتى تُحذف معها ولا تتراكم. */
  childEnv(dir) {
    const t = path.join(dir, 'tmp');
    fs.mkdirSync(t, { recursive: true });
    return { TEMP: t, TMP: t };
  },
  controlArgs: (dir) => ['0.2.1', '--root', dir],
  // الضابط: الأربعة كلها تصل الإصدار الجديد معاً (لا نصف رفع).
  saw: (dir) => BUMP_FILES.filter((f) => readVer(path.join(dir, f)) === '0.2.1').length,
  sawExpected: BUMP_FILES.length,
  mutants: [
    { label: 'قفل بإصدار ما-قبل-الإصدار (0.2.0-beta.1) كان يمرّ صامتاً',
      apply: (dir) => bumpFixture(dir, '0.2.0-beta.1'),
      mustMatch: /beta\.1/,
      alsoCheck: (dir) => BUMP_FILES.every((f) => readVer(path.join(dir, f)) === (f.endsWith('Cargo.lock') ? '0.2.0-beta.1' : '0.2.0')) },
    { label: 'قطع الكتابة على الملف الثالث ⇒ استرجاع كامل لا شجرة نصف مرتفعة',
      apply: (dir) => fs.chmodSync(path.join(dir, 'src-tauri/Cargo.toml'), 0o444),
      alsoCheck: (dir) => BUMP_FILES.every((f) => readVer(path.join(dir, f)) === '0.2.0'),
      cleanup: (dir) => { try { fs.chmodSync(path.join(dir, 'src-tauri/Cargo.toml'), 0o666); } catch { /* gone */ } } },
  ],
  zero: { label: 'لا ملفات إصدار أصلاً',
    apply: (dir) => { for (const f of BUMP_FILES) fs.rmSync(path.join(dir, f), { force: true }); } },
});

/* ═══ 8) مُسنِد البناء ══════════════════════════════════════════════════════ */
CASES.push({
  name: 'build-info.cjs',
  script: S('build-info.cjs'),
  // السكربت يُحلّ جذره من __dirname ⇒ يُنسخ إلى scripts/ داخل البيئة.
  needsScriptCopy: true,
  build(dir) {
    mk(dir, 'package.json', '{\n  "name": "x",\n  "private": true,\n  "version": "0.2.0"\n}\n');
    mk(dir, 'src-tauri/tauri.conf.json', '{\n  "version": "0.2.0"\n}\n');
    mk(dir, 'src-tauri/Cargo.toml', '[package]\nname = "haramlite-rs"\nversion = "0.2.0"\n');
    mk(dir, 'src-tauri/Cargo.lock', '[[package]]\nname = "haramlite-rs"\nversion = "0.2.0"\n');
    mk(dir, 'browser-extension/manifest.json', '{\n  "version": "1.1.5"\n}\n');
    initRepo(dir);
  },
  controlArgs: (dir) => ['--no-sbom', '--out', 'out'],
  // الضابط: الملف كُتب فعلاً في الموضع المطلوب.
  saw: (dir) => (fs.existsSync(path.join(dir, 'out/build-info.json')) ? 1 : 0),
  sawExpected: 1,
  mutants: [
    { label: '--out في الآخر بلا قيمة كان يُتجاهل بصمت',
      args: (dir) => ['--no-sbom', '--out'],
      mustMatch: /--out/,
      alsoCheck: (dir) => !fs.existsSync(path.join(dir, 'out/build-info.json')) },
    { label: '--assets في الآخر بلا قيمة كان ينهار بـstack trace',
      args: (dir) => ['--no-sbom', '--assets'],
      mustMatch: /--assets/ },
  ],
  zero: { label: 'لا ملفات إصدار أصلاً',
    apply: (dir) => { for (const f of ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) fs.rmSync(path.join(dir, f), { force: true }); } },
});

/* ═══ التشغيل ═══════════════════════════════════════════════════════════════ */

const results = [];   // { case, kind, label, ok, detail }
function record(c, kind, label, ok, detail) { results.push({ case: c.name, kind, label, ok, detail }); }

function copyBase(base, dst) { fs.cpSync(base, dst, { recursive: true }); }

/** يشغّل الخادم على منفذ 0، ينفّذ الطلبات، ثم يوقفه — واحداً في كل مرة. */
async function serveRun(dir, requests) {
  const ch = spawn(process.execPath, [S('serve-site.cjs'), '0', '--root', path.join(dir, 'site')],
    { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  ch.stdout.on('data', (d) => { out += d.toString(); });
  ch.stderr.on('data', (d) => { out += d.toString(); });
  const port = await new Promise((res) => {
    const t = setInterval(() => {
      const m = out.match(/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(t); res(Number(m[1])); }
    }, 40);
    ch.on('exit', () => { clearInterval(t); res(null); });
    setTimeout(() => { clearInterval(t); res(null); }, 8000);
  });
  const answers = [];
  if (port) {
    for (const target of requests) answers.push(await rawGet(port, target));
  }
  const alive = ch.exitCode === null;
  try { ch.kill(); } catch { /* gone */ }
  await new Promise((r) => setTimeout(r, 250));
  return { port, answers, alive, out };
}

async function main() {
  const t0 = Date.now();
  console.log('بوّابة الحرّاس (selfcheck) — ' + CASES.length + ' حارساً');
  console.log('البيئة المصنوعة: ' + WORK + '\n');

  for (const c of CASES) {
    if (only && c.name !== only) continue;

    /* بناء البيئة السليمة (نسخة واحدة تُنسخ لكل حالة) */
    const base = path.join(WORK, c.name, 'base');
    fs.mkdirSync(base, { recursive: true });
    c.build(base);
    if (c.needsScriptCopy) {
      copyInto(base, 'scripts/build-info.cjs', S('build-info.cjs'));
      copyInto(base, 'scripts/sbom.cjs', S('sbom.cjs'));
    }

    /* ② الضابط: البيئة السليمة يجب أن تمرّ، وقد رأت مدخلاً غير صفري */
    {
      const dir = path.join(WORK, c.name, 'control');
      copyBase(base, dir);
      let res, ok = true, detail = '';
      if (c.server) {
        const r = await serveRun(dir, [c.controlRequest.target]);
        const a = r.answers[0] || { status: 'NO-ANSWER', body: '' };
        const want = c.controlRequest;
        ok = a.status === want.expectStatus && want.expectBody.test(a.body)
          && (!want.forbidBody || !want.forbidBody.test(a.body)) && r.alive;
        detail = 'HTTP ' + a.status + (r.alive ? ' · الخادم حيّ' : ' · الخادم مات');
        res = { status: ok ? 0 : 1, out: detail };
      } else {
        const args = c.controlArgs ? c.controlArgs(dir) : ['--root', dir];
        res = runNode(c.needsScriptCopy ? path.join(dir, 'scripts', c.name) : c.script, args, dir, c.childEnv ? c.childEnv(dir) : undefined);
        const saw = c.saw ? c.saw(dir, res) : 0;
        const want = c.sawExpected === undefined ? 1 : c.sawExpected;
        if (res.status !== 0) { ok = false; detail = 'exit=' + res.status + ' (يجب 0)'; }
        else if (saw < want) { ok = false; detail = 'رأى ' + saw + ' من مدخل، والمطلوب ≥ ' + want + ' (نجاح لأنه لم ينظر)'; }
        else { detail = 'exit=0 · رأى ' + saw + ' مدخلاً'; }
      }
      record(c, 'ضابط', 'البيئة السليمة تمرّ', ok, detail);
      if (!ok) console.log('  ✗ ضابط ' + c.name + ': ' + detail);
    }

    /* ① المُفسَدات: كل واحد يجب أن يُسقط الحارس */
    for (const [i, m] of (c.mutants || []).entries()) {
      const dir = path.join(WORK, c.name, 'mutant-' + (i + 1));
      copyBase(base, dir);
      if (m.apply) m.apply(dir);
      if (m.cleanup) { /* يُنظَّف بعد التشغيل */ }

      let ok = true, detail = '';
      if (c.server) {
        const r = await serveRun(dir, [m.request.target, '/index.html']);
        const a = r.answers[0] || { status: 'NO-ANSWER', body: '' };
        const after = r.answers[1] || { status: 'NO-ANSWER', body: '' };
        if (m.expectStatusAfter) {
          ok = a.status === m.expectStatusAfter && after.status === '200' && r.alive;
          detail = 'HTTP ' + a.status + ' · ثم /index.html ← ' + after.status + (r.alive ? ' · الخادم حيّ' : ' · الخادم مات');
        } else {
          const leaked = m.forbidBody && m.forbidBody.test(a.body);
          ok = !leaked && after.status === '200' && r.alive;
          detail = 'HTTP ' + a.status + (leaked ? ' · تسريب محتوى خارج الجذر' : ' · لا تسريب') + ' · الخادم حيّ=' + r.alive;
        }
        if (m.cleanup) m.cleanup(dir);
      } else {
        const args = m.args ? m.args(dir) : (c.controlArgs ? c.controlArgs(dir) : ['--root', dir]);
        const res = runNode(c.needsScriptCopy ? path.join(dir, 'scripts', c.name) : c.script, args, dir, c.childEnv ? c.childEnv(dir) : undefined);
        const named = /✗/.test(res.out);
        if (res.status === 0) { ok = false; detail = 'exit=0 ← مرّ المُفسَد'; }
        else if (!named) { ok = false; detail = 'exit=' + res.status + ' بلا رسالة «✗» مسمّاة'; }
        else if (m.mustMatch && !m.mustMatch.test(res.out)) { ok = false; detail = 'سقط لكن لم يسمِّ العيب (المتوقّع ' + m.mustMatch + ')'; }
        else if (m.alsoCheck && !m.alsoCheck(dir)) { ok = false; detail = 'سقط لكن ترك الشجرة في حالة خاطئة'; }
        else { detail = 'exit=' + res.status + ' · رسالة مسمّاة'; }
        if (m.cleanup) m.cleanup(dir);
      }
      record(c, 'مُفسَد', m.label, ok, detail);
      if (!ok) console.log('  ✗ مُفسَد ' + c.name + ' / ' + m.label + ': ' + detail);
    }

    /* ③ صفر مدخل: يجب أن يسقط برسالة مسمّاة */
    {
      const dir = path.join(WORK, c.name, 'zero');
      copyBase(base, dir);
      if (c.zero.apply) c.zero.apply(dir);
      let ok = true, detail = '';
      if (c.zero.run) {
        const res = c.zero.run(dir);
        ok = res.status !== 0 && /✗/.test(res.out);
        detail = 'exit=' + res.status + ' · ' + (ok ? 'رسالة مسمّاة' : 'لم يسمِّ السبب');
      } else if (c.server) {
        const r = await serveRun(dir, []);
        detail = 'exit=' + (r.port === null ? '≠0' : '0');
        ok = r.port === null;
      } else {
        const args = c.zero.args ? c.zero.args(dir) : (c.controlArgs ? c.controlArgs(dir) : ['--root', dir]);
        const res = runNode(c.needsScriptCopy ? path.join(dir, 'scripts', c.name) : c.script, args, dir, c.childEnv ? c.childEnv(dir) : undefined);
        const named = /✗/.test(res.out);
        const crashed = /^\s*at .*\(node:|Node\.js v\d/m.test(res.out);
        if (res.status === 0) { ok = false; detail = 'exit=0 ← نجاح على صفر مدخل'; }
        else if (!named) { ok = false; detail = 'exit=' + res.status + ' بلا رسالة مسمّاة' + (crashed ? ' (انهيار بـstack trace)' : ''); }
        else { detail = 'exit=' + res.status + ' · ' + (res.out.match(/✗[^\n]*/) || [''])[0].trim().slice(0, 80); }
      }
      record(c, 'صفر مدخل', c.zero.label, ok, detail);
      if (!ok) console.log('  ✗ صفر مدخل ' + c.name + ': ' + detail);
    }
  }

  /* ── الحصيلة ── */
  const byKind = (k) => results.filter((r) => r.kind === k);
  const bad = results.filter((r) => !r.ok);
  console.log('\n  الحارس'.padEnd(34) + 'ضابط  مُفسَد  صفر');
  for (const c of CASES) {
    if (only && c.name !== only) continue;
    const g = (k) => byKind(k).filter((r) => r.case === c.name);
    const mark = (k) => { const a = g(k); return a.length === 0 ? ' –  ' : (a.every((r) => r.ok) ? ' ✓  ' : ' ✗  '); };
    console.log('  ' + c.name.padEnd(32) + mark('ضابط') + '  ' + mark('مُفسَد') + '   ' + mark('صفر مدخل'));
  }
  const nCtrl = byKind('ضابط').length, nMut = byKind('مُفسَد').length, nZero = byKind('صفر مدخل').length;
  console.log('\nالحصيلة: ضوابط ' + byKind('ضابط').filter((r) => r.ok).length + '/' + nCtrl +
    ' · مُفسَدات ' + byKind('مُفسَد').filter((r) => r.ok).length + '/' + nMut +
    ' · صفر مدخل ' + byKind('صفر مدخل').filter((r) => r.ok).length + '/' + nZero +
    ' — في ' + Math.round((Date.now() - t0) / 100) / 10 + ' ث');

  if (nCtrl === 0 || nMut === 0 || nZero === 0) {
    console.error('✗ صفر مدخل في البوّابة نفسها (' + nCtrl + ' ضابط · ' + nMut + ' مُفسَد · ' + nZero + ' صفر) — لا قياس، فلا نجاح.');
    process.exit(1);
  }
  if (bad.length) {
    console.error('\n✗ فشل ' + bad.length + ' فحصاً:');
    for (const r of bad) console.error('   - [' + r.kind + '] ' + r.case + ' / ' + r.label + ' — ' + r.detail);
    if (!keep) fs.rmSync(WORK, { recursive: true, force: true });
    process.exit(1);
  }
  if (!keep) fs.rmSync(WORK, { recursive: true, force: true });
  console.log('✓ كل ضابط مرّ · كل مُفسَد أسقط حارسه · وكل صفر مدخل فشل بصوت عالٍ.');
}

main().catch((e) => {
  console.error('✗ انهيار البوّابة: ' + (e && e.stack ? e.stack : e));
  if (!keep) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* gone */ } }
  process.exit(1);
});
