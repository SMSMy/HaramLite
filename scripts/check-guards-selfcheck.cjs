#!/usr/bin/env node
/* البوّابة الخامسة عشرة: **تحرس الحرّاس أنفسهم**.
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
/** التزام المستودع المصنوع — يُقرأ بعد `initRepo` ليُبنى عليه `GITHUB_SHA`. */
function headSha(dir) {
  const r = runGit(['rev-parse', 'HEAD'], dir);
  return r.status === 0 ? r.stdout.trim() : null;
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
    { label: 'تعليق HTML غير مغلق (يبتلع قسماً كاملاً حتى --> التالي)',
      apply: (dir) => mk(dir, 'docs/bad.html',
        '<!doctype html><html><body>\n' +
        '<!-- Transparent System Limitations (<section class="x">\n' +
        '<p>قسم كامل يبتلعه التعليق</p>\n' +
        '</section>\n' +
        '<!-- تعليق سليم -->\n' +
        '<div>بقية الصفحة</div>\n' +
        '</body></html>\n') },
    { label: '--> شارد بلا <!-- يقابله',
      apply: (dir) => mk(dir, 'docs/bad.html', '<!doctype html><html><body><p>نصّ</p>-->\n</body></html>\n') },
  ],
  zero: { label: 'docs فارغ',
    apply: (dir) => { fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'docs'), { recursive: true }); } },
});

/* ═══ ٢ب) حارس CSS المشحون (رموز مقحَمة في المستوى الأعلى) ═════════════════ */
const EXT_HTML = '<!doctype html><html><head><link rel="stylesheet" href="popup.css"></head>' +
  '<body><div class="mode-item"></div></body></html>\n';
const EXT_CSS_OK = '/* ok */\n@font-face { font-family: "T"; src: url(a.otf); }\n' +
  '.a { color: #da7756; }\n.b,\n.c { color: red; }\n' +
  ".after\\:content-\\[\\'\\'\\]:after { content: \"\"; }\n";
CASES.push({
  name: 'check-css-toplevel.cjs',
  script: S('check-css-toplevel.cjs'),
  build(dir) {
    mk(dir, 'browser-extension/popup.html', EXT_HTML);
    mk(dir, 'browser-extension/popup.css', EXT_CSS_OK);
  },
  controlArgs: (dir) => ['--root', dir],
  saw: (dir, res) => { const m = res.out.match(/CSS المشحون: (\d+) ملفاً/); return m ? Number(m[1]) : 0; },
  mutants: [
    { label: 'سطر عربي عارٍ (# بلا محرِّف) في ملف CSS',
      apply: (dir) => mk(dir, 'browser-extension/popup.css',
        EXT_CSS_OK + '# أنماط تستخدمها النافذة الجديدة\n.x { color: red; }\n') },
    { label: "بداية here-string باورشل ($extra = @')",
      apply: (dir) => mk(dir, 'browser-extension/popup.css',
        EXT_CSS_OK + "$extra = @'\n.x { color: red; }\n") },
    { label: 'علامة تنصيص شاردة تعبر الأسطر (العيب الأصلي)',
      apply: (dir) => mk(dir, 'browser-extension/popup.css',
        EXT_CSS_OK + "'\n\n# أنماط\n$extra = @'\n\n.x { color: red; }\n") },
    { label: 'نصّ في المستوى الأعلى لا يصلح محدِّداً',
      apply: (dir) => mk(dir, 'browser-extension/popup.css',
        EXT_CSS_OK + 'echo hello world;\n') },
    { label: '«}» بلا «{» يقابلها',
      apply: (dir) => mk(dir, 'browser-extension/popup.css', EXT_CSS_OK + '}\n') },
  ],
  zero: { label: 'لا ملف CSS مشحون',
    apply: (dir) => mk(dir, 'browser-extension/popup.html',
      '<!doctype html><html><head></head><body></body></html>\n') },
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

/* ═══ ٥ب) حارس تعريب الإضافة (م٦-أ) ═════════════════════════════════════════
 * البيئة المصنوعة تحمل `browser-extension/content.js` مصنوعاً و`scripts/` فيه
 * حارس التعريب. والضابط يشترط أن **يرى** الحارس مدخلاً غير صفري: عدد النصوص
 * العربية داخل الجدول ⇒ يوازي `sawExpected`.
 * والمُفسَدات مكتوبة **هنا** كبقية الحرّاس (لا تُشغَّل عبر حاكم مُفسَدات التعريب؛
 * فذاك له بوّابته `pnpm ext:mutants`). و«صفر مدخل» = ملف فارغ ⇒ سقوط مسمّى. */
const I18N_OK = "const I18N = {\n  ar: { 'a.one': 'نصّ عربي {n}' },\n  en: { 'a.one': 'English {n}' },\n};\n" +
  "function pickLang(list) {\n" +
  "  const arr = Array.isArray(list) ? list : [list];\n" +
  "  for (const raw of arr) {\n" +
  "    if (typeof raw !== 'string') continue;\n" +
  "    const tag = raw.toLowerCase();\n" +
  "    if (tag === 'ar' || tag.indexOf('ar-') === 0) return 'ar';\n" +
  "    if (tag === 'en' || tag.indexOf('en-') === 0) return 'en';\n" +
  "  }\n" +
  "  return 'en';\n" +
  "}\n" +
  "(function () {\n" +
  "  const t = (k) => I18N.ar[k];\n" +
  "  toast(t('a.one'));\n" +
  "})();\n";
CASES.push({
  name: 'check-extension-i18n.cjs',
  script: S('check-extension-i18n.cjs'),
  build(dir) {
    mk(dir, 'browser-extension/content.js', I18N_OK);
    copyInto(dir, 'scripts/check-extension-i18n.cjs', S('check-extension-i18n.cjs'));
  },
  controlArgs: (dir) => ['--root', dir],
  /* مثبَّتة على **السطر** لا على أول ظهور للعبارة: المطابقة السابقة
   * (`/المدخل المقيس\D+(\d+)/`) كانت تُطابق عنوان القسم ثم تعبر بـ`\D+` الجشع
   * إلى أول أرقام بعده — هشّة وإن كانت لا تُستغلّ. هنا السطر بعينه يُلتقط ويُقاس
   * ما بعده مباشرة. */
  saw: (dir, res) => {
    const m = res.out.match(/^\s*نصّ عربي \*\*داخل الجدول\*\*[^\n]*?:\s*(\d+)\s*$/m);
    return m ? Number(m[1]) : 0;
  },
  sawExpected: 1,
  mutants: [
    { label: 'نصّ عربي خام خارج جدول الترجمة (toast)',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("  toast(t('a.one'));", "  toast('نصّ عربي خام');")),
      mustMatch: /خارج جدول الترجمة/ },
    // القسم `en` يبقى **غير فارغ** والمفتاح وحده يُحذف: لو أُفرغ القسم لسقط فحص
    // آخر («صفر مدخل» / وجود القسمين) فلا يُقاس تكافؤ المفاتيح — وهو المقصود هنا.
    { label: 'مفتاح في ar غائب من en (والقسم قائم وغير فارغ)',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("  en: { 'a.one': 'English {n}' },", "  en: { 'b.keep': 'Kept' },")),
      mustMatch: /بلا مقابل في `en`/ },
    { label: 'قيمة إنجليزية فارغة',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("'English {n}'", "''")),
      mustMatch: /قيمة فارغة/ },
    // الجولة الثانية: الثقوب التي أثبتها جاسوس مستقلّ بمُفسَدات مرّت
    { label: 'قيمة إنجليزية تحمل عربية (ثقب مقيس أُغلق)',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("'English {n}'", "'نصّ عربي {n}'")),
      mustMatch: /قيمة إنجليزية تحمل عربية/ },
    { label: 'نداء بمفتاح غير موجود في الجدول (توست فارغ صامت)',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("toast(t('a.one'));", "toast(t('a.one.typo'));")),
      mustMatch: /مفتاح غير موجود/ },
    { label: 'عنصر نائب {n} في ar وحده',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("'English {n}'", "'English'")),
      mustMatch: /عناصر نائبة غير متطابقة/ },
    { label: 'بناء نصّ ديناميكي: decodeURIComponent (ثقب مقيس أُغلق)',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("toast(t('a.one'));", "toast(decodeURIComponent('%D9%86'));")),
      mustMatch: /بناء نصّ ديناميكي/ },
    { label: 'عربية بلا نصّ حرفيّ: String.fromCharCode (ثقب مقيس أُغلق)',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("toast(t('a.one'));", 'toast(String.fromCharCode(0x639));')),
      mustMatch: /بناء نصّ ديناميكي/ },
    { label: 'عربية داخل تعبير نمطي (شرط على نصّ معروض)',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("toast(t('a.one'));", "if (/نصّ/.test(String(1))) toast(t('a.one'));")),
      mustMatch: /عربية داخل تعبير نمطي/ },
    { label: 'مفتاح مكرَّر داخل قسم (يُسقط المتقدّم صامتاً)',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("  ar: { 'a.one': 'نصّ عربي {n}' },",
          "  ar: { 'a.one': 'أول {n}', 'a.one': 'نصّ عربي {n}' },")),
      mustMatch: /مفتاح مكرَّر/ },
    { label: 'عربية مفكوكة بالمفاتيح \\u0600 (ثقب مقيس أُغلق)',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace("toast(t('a.one'));", "toast('\\u0646\\u0635');")),
      mustMatch: /خارج جدول الترجمة/ },
    { label: 'جدول الترجمة محذوف كاملاً',
      apply: (dir) => mk(dir, 'browser-extension/content.js',
        I18N_OK.replace(/const I18N = \{[\s\S]*?\n\};\n/, '')),
      mustMatch: /جدول الترجمة/ },
  ],
  zero: { label: 'content.js فارغ تماماً',
    apply: (dir) => mk(dir, 'browser-extension/content.js', '') },
});

/* ═══ ٥ج) حارس رموز خطأ الجسر (م٦-ج) ═════════════════════════════════════════
 * البيئة المصنوعة تحمل **الملفات المشحونة نفسها** (`src-tauri/src/bridge.rs`
 * والجدولين `content.js` و`popup.js`)، والحارس يُنادى بـ`--root=<البيئة>` فيقرأها.
 * والضابط يشترط أن **يرى** مدخلاً غير صفري: عدد الرموز المُصدَرة (٧ اليوم).
 * والمُفسَدات هنا **مستقلّة** عن مُفسَدات `--selfcheck` الداخلية للحارس: هذه تُثبت
 * أن البوّابة ترى الحارس يسقط، وتلك تُثبت أن الحارس يرى العيب نفسه.
 * والبيئة تحمل **ملفات التشغيل الثلاثة** (`content.js` · `popup.js` ·
 * `background.js`) لأن قاعدة العرض تقيس الثلاثة — ونقصان واحد يُسقط الحارس بـ2
 * (وهو ما قِيس فعلاً في أول تشغيل: البيئة بنسخ ملفين فقط ⇒ «صفر مدخل»). */
CASES.push({
  name: 'check-bridge-codes.cjs',
  script: S('check-bridge-codes.cjs'),
  build(dir) {
    copyInto(dir, 'src-tauri/src/bridge.rs', path.join(REPO, 'src-tauri', 'src', 'bridge.rs'));
    for (const f of ['content.js', 'popup.js', 'background.js']) {
      copyInto(dir, 'browser-extension/' + f, path.join(REPO, 'browser-extension', f));
    }
  },
  controlArgs: (dir) => ['--root=' + dir],
  saw: (dir, res) => { const m = res.out.match(/(\d+) رمزاً مُصدَراً/); return m ? Number(m[1]) : 0; },
  sawExpected: 7,
  mutants: [
    { label: 'رمز جديد في bridge.rs بلا مدخل في جدول الإضافة',
      apply: (dir) => fs.appendFileSync(path.join(dir, 'src-tauri/src/bridge.rs'),
        '\npub const E_PROBE_GUARD: &str = "probe_guard_code";\n' +
        'fn probe_guard() {\n    reply_err(E_PROBE_GUARD, "probe");\n}\n'),
      mustMatch: /probe_guard_code/ },
    { label: 'مدخل الرمز محذوف من جدول content.js (والرمز ما زال يُصدَر)',
      apply: (dir) => {
        const p = path.join(dir, 'browser-extension/content.js');
        const s = fs.readFileSync(p, 'utf8');
        const out = s.replace("      'code.duplicate_link': 'هذا الرابط طُلب من قبل في هذه الجلسة — تخطي المكرر',\n", '');
        if (out === s) throw new Error('مُفسَد لم يغيّر content.js');
        fs.writeFileSync(p, out);
      },
      mustMatch: /duplicate_link/ },
    { label: 'موضع خطأ يمرّر نصّاً بدل الرمز',
      apply: (dir) => {
        const p = path.join(dir, 'src-tauri/src/bridge.rs');
        const s = fs.readFileSync(p, 'utf8');
        const out = s.replace('reply_err(E_BAD_INPUT, "empty url");', 'reply_err("bad_input", "empty url");');
        if (out === s) throw new Error('مُفسَد لم يغيّر bridge.rs');
        fs.writeFileSync(p, out);
      },
      mustMatch: /الوسيط الأول/ },
    /* ث١ (جاسوس م٦-ج): **مسار عرض يقرأ النصّ الخام** — كان يمرّ على حارس الرموز
       وحارس jsdom معاً؛ فالمُفسَد هنا يُثبت أن البوّابة ترى القاعدة الجديدة تسقط. */
    { label: 'مسار عرض (الاستطلاع) يقرأ st.last.error خامّاً (ث١)',
      apply: (dir) => {
        const p = path.join(dir, 'browser-extension/content.js');
        const s = fs.readFileSync(p, 'utf8');
        const out = s.replace("toast('✗ ' + errText(st.last, t('poll.failed')), 4000);",
          "toast('✗ ' + String(st.last.error), 4000);");
        if (out === s) throw new Error('مُفسَد لم يغيّر content.js');
        fs.writeFileSync(p, out);
      },
      mustMatch: /غير مُعلَنة/ },
    /* ث٢: حالة `case` قائمة لا تُرجع ترجمتها. */
    { label: 'حالة في errText لا تُرجع ترجمتها (ث٢)',
      apply: (dir) => {
        const p = path.join(dir, 'browser-extension/content.js');
        const s = fs.readFileSync(p, 'utf8');
        const out = s.replace("      case 'duplicate_link': return t('code.duplicate_link');",
          "      case 'duplicate_link': return raw;");
        if (out === s) throw new Error('مُفسَد لم يغيّر content.js');
        fs.writeFileSync(p, out);
      },
      mustMatch: /لا تُرجع/ },
    /* ث١ على **مسار لا يُقاس حيّاً** (جلب الصوت): مُفسَد الجاسوس Ⓕ — يقيسه حارس
       الرموز وحده، لأن قيادته حيّاً تحتاج `Audio`/decode حقيقيين. */
    { label: 'مسار جلب الصوت يقرأ e.message خامّاً (مُفسَد الجاسوس Ⓕ)',
      apply: (dir) => {
        const p = path.join(dir, 'browser-extension/content.js');
        const s = fs.readFileSync(p, 'utf8');
        const out = s.replace("toast('✗ ' + errText(e, t('fetch.failed')), 4000);",
          "toast('✗ ' + String(e && e.message), 4000);");
        if (out === s) throw new Error('مُفسَد لم يغيّر content.js');
        fs.writeFileSync(p, out);
      },
      mustMatch: /غير مُعلَنة/ },
  ],
  zero: { label: 'bridge.rs غائب عن البيئة',
    apply: (dir) => fs.rmSync(path.join(dir, 'src-tauri'), { recursive: true, force: true }) },
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
  /* البيئة المصنوعة تحمل مستودع git مصنوعاً (فـ`git rev-parse HEAD` يُقاس ولا
     يُخترع)، فيجب أن تحمل **هوية CI متّسقة معه**. السبب عطل مُقاس في CI وحده:
     عدّاء GitHub يضبط `GITHUB_SHA` على التزام المستودع الحقيقي، و`build-info.cjs`
     يقابل `GITHUB_SHA` بـ`git rev-parse HEAD` **قبل أن يكتب** ويرفض إن اختلفا
     (وهو حارس صحيح: إسناد يشير إلى غير مصدره كذب). وهنا HEAD التزام **مصنوع**
     لا يمكن أن يطابق `GITHUB_SHA` الموروث أبداً ⇒ exit 1 على العدّاء، و0 على
     الجهاز (حيث لا `GITHUB_SHA`) — أي بيئة **غير سليمة** مرّت محلياً وسقطت في CI.
     فالتصحيح في البيئة لا في الحارس: تُشتقّ هوية CI من الالتزام المصنوع نفسه.
     وتُبنى **صريحة بلا وراثة** حتى تكون البيئة واحدة على الجهاز والعدّاء جميعاً
     (لا مسار يعمل عندنا ويسقط هناك). */
  childEnv(dir) {
    return {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: headSha(dir),
      GITHUB_RUN_ID: '0000000000',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_WORKFLOW: 'selfcheck',
      GITHUB_REPOSITORY: 'selfcheck/fixture',
      GITHUB_REF: 'refs/heads/selfcheck',
    };
  },
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
    /* يُثبت أن مقابلة `GITHUB_SHA` بـHEAD **مشتغلة وملزِمة** في هذه البيئة، لا
       مُتجاوَزة: `childEnv` هنا يُدخل sha مخالفاً عمداً (والضابط في الحالتين
       يشتقّ sha مطابقاً) ⇒ الحارس يجب أن يرفض ولا يكتب. وهذا يحرس العطل نفسه من
       الطرف الآخر: لو أُفرغت البيئة من `GITHUB_SHA` ليُسكَت الفحص، سقط هذا
       المُفسَد — فالبيئة لا تُصلَح بإسكات شرط، بل بتحقيقه. */
    { label: 'هوية CI مخالفة للالتزام المقيس (GITHUB_SHA مزحوم) ⇒ يُرفض ولا يُكتب',
      env: { GITHUB_SHA: '0000000000000000000000000000000000000000' },
      mustMatch: /GITHUB_SHA/,
      alsoCheck: (dir) => !fs.existsSync(path.join(dir, 'out/build-info.json')) },
  ],
  zero: { label: 'لا ملفات إصدار أصلاً',
    apply: (dir) => { for (const f of ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) fs.rmSync(path.join(dir, f), { force: true }); } },
});

/* ═══ 9) حارس أصول CUDA (DLL ناقص · افتراق القائمتين) ═══════════════════════ */
/* البيئة تحمل السير الحقيقي و`CUDA_FILES` الحقيقية، والحارس يبني عيّنات PE
   المصنوعة بنفسه (لا ملف ثنائي في المستودع ولا في البيئة). */
const cudaGuard = require('./check-cuda-assets.cjs');
const CUDA_NAMES = cudaGuard.cudaFilesFromRust(
  fs.readFileSync(path.join(REPO, 'src-tauri/src/cuda_runtime.rs'), 'utf8')
);
const CUDA_WF = path.join(REPO, '.github/workflows/cuda-assets.yml');
const cudaWfPath = (dir) => path.join(dir, '.github/workflows/cuda-assets.yml');
/* `editCudaWf` تفشل بصوت عالٍ إن لم يطابق نمط الاستبدال شيئاً: مُفسَد لم يغيّر
   ملفه «يمرّ» فيُعلن الحارس معطوباً وهو سليم (وقع فعلاً في أول تشغيل). */
const editCudaWf = (dir, fn) => {
  const p = cudaWfPath(dir);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error('مُفسَد لم يغيّر السير — نمط الاستبدال لا يطابق');
  fs.writeFileSync(p, after);
};
CASES.push({
  name: 'check-cuda-assets.cjs',
  script: S('check-cuda-assets.cjs'),
  build(dir) {
    mk(dir, 'src-tauri/src/cuda_runtime.rs',
      'pub const CUDA_FILES: &[&str] = &[\n' +
      CUDA_NAMES.map((n) => '    "' + n + '",').join('\n') +
      '\n];\n');
    copyInto(dir, '.github/workflows/cuda-assets.yml', CUDA_WF);
  },
  controlArgs: (dir) => ['--root', dir],
  saw: (dir, res) => { const m = res.out.match(/حارس أصول CUDA: (\d+)/); return m ? Number(m[1]) : 0; },
  sawExpected: CUDA_NAMES.length,
  mutants: [
    { label: 'اسم أُسقط من $EXPECTED في السير ⇒ افتراق عن CUDA_FILES',
      apply: (dir) => editCudaWf(dir, (s) => s.replace("'cufft64_11.dll',", '')),
      mustMatch: /افتراق/ },
    { label: 'استثناء الحجم بالاسم عاد إلى السير (العيب الأصلي)',
      apply: (dir) => editCudaWf(dir, (s) => s.replace(
        "            if (-not $src) { throw \"ORT gpu zip missing $dll\" }",
        "            if (-not $src) { throw \"ORT gpu zip missing $dll\" }\n" +
        "            if ($src.Length -lt 10KB -and $dll -ne 'onnxruntime_providers_shared.dll') { throw \"stub\" }")),
      mustMatch: /استثناء|الاستثناء/ },
    { label: 'قاعدة PE عُطّلت في السير ⇒ الملف المبتور يمرّ',
      apply: (dir) => editCudaWf(dir, (s) => s.replace(
        'if ($len -lt $need) { throw', 'if ($false -and ($len -lt $need)) { throw')),
      mustMatch: /قاعدة PE/ },
  ],
  zero: { label: 'لا cuda_runtime.rs (لا قائمة تُقاس)',
    apply: (dir) => fs.rmSync(path.join(dir, 'src-tauri/src/cuda_runtime.rs'), { force: true }) },
});

/* ═══ 10) حارس مدخل الفصل الواحد (0.2.9) ═══════════════════════════════════ */
/* البيئة المصنوعة تحمل **شكل ما بعد م١**: مدخل المنتج الوحيد يحمله الغلاف
   (`slots.rs`)، والموضعان المباشران الباقيان في الاختبارات (`pipeline.rs`
   تعريف+اختبار · `separator.rs`) ⇒ الضابط يمرّ وقد رأى **ثلاثة**. والملفات
   الخمسة القديمة (`bridge` · `cli` · `lib` · `telegram` · `watch_service`)
   **لم تعد مسموحة**: بعد نقل مداخلها إلى الغلاف صار أي نداء مباشر فيها مخالفة،
   وله مُفسَد صريح أدناه. والمُفسَدات الثلاثة الأولى تخصّ **المطابقة** لا العدّ:
   مرادفة (`as p`) ونداء عارٍ بعد `use` ومؤشّر دالة — وكلٌّ منها يُفلت من حارس
   يقيس صيغة `pipeline::process_file(` بعينها. */
const SEP_CALL = (mod) => 'pub fn run() {\n    let _ = ' + mod + '::process_file(Path::new("a"));\n}\n';
function sepFixture(dir) {
  // الغلاف الوحيد المسموح في مسار المنتج (محدِّد م١).
  mk(dir, 'src-tauri/src/slots.rs', SEP_CALL('pipeline'));
  // `pipeline.rs` يحمل **التعريف** (لا يُعدّ مدخلاً) واختبار وحدة (يُعدّ).
  mk(dir, 'src-tauri/src/pipeline.rs',
    'pub fn process_file(a: u8) -> u8 { a }\n\n' +
    '#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { let _ = process_file(1); }\n}\n');
  mk(dir, 'src-tauri/src/separator.rs', 'pub fn run() { let _ = crate::pipeline::process_file(a); }\n');
  // حارسة تفنيد م٦-ب: وحدة اختبار مسموحة بـ**موضعين مثبَّتين** (أُدرجت 2026-09-22 بعد أن
  // أسقط الحارسُ الحقيقيُّ الملفَ على `main` وأنا أظنّ البوّابات خضراء). البيئة المصنوعة
  // تحمل الموضعين نفسهما، وإلا عدّ الحارس «موضعاً موعوداً غاب» فسقط **الضابط** لا المُفسَد.
  mk(dir, 'src-tauri/src/m6b_clip_guard.rs',
    'pub fn a() { let _ = crate::pipeline::process_file(a); }\n' +
    'pub fn b() { let _ = crate::pipeline::process_file(b); }\n');
}
CASES.push({
  name: 'check-separation-entry.cjs',
  script: S('check-separation-entry.cjs'),
  build(dir) { sepFixture(dir); },
  controlArgs: (dir) => ['--root', dir],
  saw: (dir, res) => { const m = res.out.match(/(\d+) مواضع مسموحة/); return m ? Number(m[1]) : 0; },
  sawExpected: 5,
  mutants: [
    { label: 'مدخل سادس في ملف جديد غير مسموح ⇒ يُسمّى الملف والسطر',
      apply: (dir) => mk(dir, 'src-tauri/src/downloader.rs', SEP_CALL('pipeline')),
      mustMatch: /downloader\.rs:2/ },
    { label: 'مدخل مباشر في ملف منتج قديم (cli.rs) بعد نقله إلى الغلاف ⇒ مخالفة',
      apply: (dir) => mk(dir, 'src-tauri/src/cli.rs', SEP_CALL('pipeline')),
      mustMatch: /cli\.rs:2/ },
    { label: 'مرادفة: use crate::pipeline as p; ثم p::process_file( ⇒ لا تُفلت',
      apply: (dir) => mk(dir, 'src-tauri/src/alias.rs', 'use crate::pipeline as p;\n\n' + SEP_CALL('p')),
      mustMatch: /alias\.rs:4/ },
    { label: 'مؤشّر دالة بلا نداء: let f = pipeline::process_file; ⇒ مدخل أيضاً',
      apply: (dir) => mk(dir, 'src-tauri/src/ptr.rs',
        'pub fn run() {\n    let f = pipeline::process_file;\n    let _ = f;\n}\n'),
      mustMatch: /ptr\.rs:2/ },
    { label: 'نداء ثانٍ داخل ملف مسموح (separator.rs) ⇒ العدد المتوقَّع لا يُتجاوز',
      apply: (dir) => fs.appendFileSync(path.join(dir, 'src-tauri/src/separator.rs'), '\n' + SEP_CALL('crate::pipeline')),
      mustMatch: /separator\.rs/ },
    { label: 'غلافان يحملان المدخل (slots.rs وjobs.rs) ⇒ المطلوب غلاف واحد',
      apply: (dir) => {
        mk(dir, 'src-tauri/src/jobs.rs', SEP_CALL('pipeline'));
      },
      mustMatch: /غلاف/ },
    { label: 'صفر مدخل: المصادر موجودة والاسم غائب ⇒ فشل بصوت عالٍ (2) لا نجاح',
      apply: (dir) => {
        fs.rmSync(path.join(dir, 'src-tauri/src'), { recursive: true, force: true });
        mk(dir, 'src-tauri/src/only.rs', 'pub fn noop() {}\n');
      },
      mustMatch: /صفر مدخل/ },
  ],
  zero: { label: 'مجلد المصادر مفقود',
    apply: (dir) => fs.rmSync(path.join(dir, 'src-tauri'), { recursive: true, force: true }) },
});

/* ═══ ١١) مُقيِّم صفوف المتصفّح (م٧ — الطبقة ج) ══════════════════════════════
 * البيئة المصنوعة تحمل **ملفات الإضافة المشحونة نفسها** (‏المقيس هو المشحون لا
 * نسخة منه)، والحارس يُنادى بـ`--root=<البيئة>` و`--engine=jsdom` فلا يلزم
 * متصفّح في البوّابة (والمسار الافتراضيّ CDP يُقاس في تشغيل المُقيِّم نفسه،
 * ومُفسَداته الكاملة في `--self-check`).
 * والضابط يشترط أن **يرى** مدخلاً غير صفري: عدد الصفوف المطبوعة (٣).
 * والمُفسَدات هنا **مستقلّة** عن مُفسَدات المُقيِّم الداخلية: هذه تُثبت أن
 * البوّابة ترى المُقيِّم يسقط، وتلك تُثبت أن المُقيِّم يرى العيب. */
const EXT_SHIPPED = ['popup.html', 'popup.js', 'content.js', 'background.js', 'manifest.json'];
function editExt(dir, file, from, to) {
  const p = path.join(dir, 'browser-extension', file);
  const before = fs.readFileSync(p, 'utf8');
  const n = before.split(from).length - 1;
  if (n !== 1) throw new Error(`مُفسَد لم يطابق مرة واحدة في ${file} (طابق ${n}): ${from}`);
  fs.writeFileSync(p, before.replace(from, to));
}
CASES.push({
  name: 'check-browser-rows.mjs',
  script: S('check-browser-rows.mjs'),
  build(dir) {
    for (const f of EXT_SHIPPED) {
      copyInto(dir, 'browser-extension/' + f, path.join(REPO, 'browser-extension', f));
    }
  },
  controlArgs: (dir) => ['--root', dir, '--engine=jsdom', '--no-out'],
  saw: (dir, res) => { const m = res.out.match(/صفوف: (\d+)/); return m ? Number(m[1]) : 0; },
  sawExpected: 3,
  mutants: [
    { label: 'قلب `acc` في mapFullToCut (مُفسَد الطبقة) ⇒ keptSum والموضع النهائي يسقطان',
      apply: (dir) => editExt(dir, 'content.js', 'acc += Math.min(t, b) - a;', 'acc -= Math.min(t, b) - a;'),
      mustMatch: /audioFinal=-57\.5/ },
    { label: 'إزاحة isGap نصف ثانية ⇒ ثواني الفجوات أو عدد القفزات يخالف',
      apply: (dir) => editExt(dir, 'content.js', 'if (t >= a && t < b) return false;', 'if (t >= a - 0.5 && t < b) return false;'),
      mustMatch: /عدد القفزات|ثواني الفجوات/ },
    { label: 'رفع بوّابة الوضعين في background.js ⇒ وضع مُفسَد يعبر',
      apply: (dir) => editExt(dir, 'background.js', "if (msg.mode === 'song' || msg.mode === 'clip') link.mode = msg.mode;", 'if (msg.mode) link.mode = msg.mode;'),
      mustMatch: /القيمتان المقبولتان/ },
    { label: 'تثبيت الاتجاه LTR في popup.js ⇒ العربية تفقد rtl',
      // `let` بدل `const`: اللغة صارت قابلة للتبديل من مبدّل ظاهر (بند ٤، جولة x1-ext).
      apply: (dir) => editExt(dir, 'popup.js', "let RTL = LANG === 'ar';", 'let RTL = false;'),
      mustMatch: /direction=rtl/ },
    { label: 'pageVideo تسقط إلى المحدِّد العام ⇒ الفيديو المُضلِّل يكشفها (ثقب و-١)',
      apply: (dir) => editExt(dir, 'content.js',
        "return document.querySelector('#movie_player video') || document.querySelector('video');",
        "return document.querySelector('video');"),
      mustMatch: /مُحدِّد المشغّل/ },
    { label: 'وضع song لا يُختار في المنبثقة ⇒ نقرة song لا تصل (ثقب و-٣)',
      apply: (dir) => editExt(dir, 'popup.js', "  mode = next === 'song' ? 'song' : 'clip';", "  mode = next === 'song' ? 'clip' : 'clip';"),
      mustMatch: /نقرة على #mode-song/ },
  ],
  zero: { label: 'browser-extension غائب عن البيئة',
    apply: (dir) => fs.rmSync(path.join(dir, 'browser-extension'), { recursive: true, force: true }) },
});

/* ── نسب نسخة الإصدار: الثنائي المُسلَّم يثبت أنه من هذه الشيفرة (درس 2026-09-21).
 *
 *    والدرس الثاني في اليوم نفسه: أول صورة لهذا الحارس بحثت عن الأعلام **بايتاً
 *    بايتاً** داخل الثنائي، فأسقطت ثنائياً **سليماً** (الأعلام تُمرَّر فعلاً —
 *    مقيسة بالمناداة الحيّة — بينما لا توجد بايتاتها المتّصلة في الصورة النهائية).
 *    فصارت البوّابة تقيس **سلوك الثنائي**: تشغّله على مسار التنزيل الإنتاجي مع
 *    yt-dlp مزيّف يسجّل وسائطه. وهذه الحالات المصنوعة تُثبت أنها تسقط على «نسخة
 *    قديمة» وتمرّ على «نسخة مطابقة» — والاثنتان تُبنيان بـrustc هنا. ─────────── */
const REL_FLAGS = ['--no-quiet', '--newline', 'after_move:HARAMLITE_OUT:'];
const REL_EXE = (dir) => path.join(dir, 'src-tauri', 'target', 'release', 'HaramLite.exe');
const REL_APP_HEAD = `
use std::process::Command;
fn spawn(flags: &[&str]) {
    let tools = std::env::var("HARAMLITE_TOOLS_DIR").unwrap_or_default();
    let exe = format!("{tools}/yt-dlp.exe");
    let _ = Command::new(&exe).args(flags).status();
}
`;
const REL_GOOD_APP = REL_APP_HEAD + `
fn main() {
    spawn(&["--newline", "--no-quiet", "--no-playlist", "-f", "bv*+ba/b",
            "--print", "after_move:HARAMLITE_OUT:%(filepath)s", "--dump-single-json"]);
}
`;
const REL_OLD_APP = REL_APP_HEAD + `
fn main() { spawn(&["--no-playlist", "--dump-single-json"]); }
`;
const REL_SILENT_APP = `fn main() { std::process::exit(0); }`;

/** يبني «تطبيقاً» مصنوعاً بـrustc في موضع الثنائي (فشل البناء يُترك ليصرخ عبر البوّابة). */
function relCompile(dir, body) {
  const src = path.join(dir, 'appstub.rs');
  fs.writeFileSync(src, body);
  const exe = REL_EXE(dir);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  let rustc = null;
  const p = spawnSync('rustc', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (!p.error && p.status === 0) rustc = 'rustc';
  else if (process.env.USERPROFILE) {
    const c = path.join(process.env.USERPROFILE, '.cargo', 'bin', 'rustc.exe');
    if (fs.existsSync(c)) rustc = c;
  }
  if (!rustc) { fs.writeFileSync(exe, 'rustc مفقود'); return { ok: false }; }
  const r = spawnSync(rustc, ['-O', '--edition', '2021', '-o', exe, src], { encoding: 'utf8', windowsHide: true });
  const ok = r.status === 0 && fs.existsSync(exe);
  if (!ok) fs.writeFileSync(exe, 'فشل بناء المصنوع: ' + (r.stdout || '') + (r.stderr || ''));
  return { ok };
}

CASES.push({
  name: 'check-release-artifact.cjs',
  script: S('check-release-artifact.cjs'),
  build(dir) {
    mk(dir, 'src-tauri/src/yt_dlp.rs',
      'let args: Vec<String> = vec![\n' + REL_FLAGS.map((m) => '    "' + m + '".into(),').join('\n') + '\n];\n');
    mk(dir, 'src/index.ts', 'export const x = 1;\n');
    mk(dir, 'index.html', '<html></html>\n');
    mk(dir, 'package.json', '{"name":"fixture"}\n');
    mk(dir, 'src-tauri/tauri.conf.json', '{}\n');
    relCompile(dir, REL_GOOD_APP);
    /* الحداثة: كل مصدر قبل ساعة · والثنائي الآن (الطوابع تُحفظ عبر `cpSync` — مقيس) */
    const old = new Date(Date.now() - 3600e3);
    for (const rel of ['src-tauri/src/yt_dlp.rs', 'src/index.ts', 'index.html', 'package.json',
      'src-tauri/tauri.conf.json']) fs.utimesSync(path.join(dir, rel), old, old);
  },
  controlArgs: (dir) => ['--root', dir],
  saw: (dir, res) => { const m = res.out.match(/(\d+) أعلام/); return m ? Number(m[1]) : 0; },
  sawExpected: 3,
  mutants: [
    { label: 'نسخة قديمة: تطبيق لا يمرّر أعلام التنزيل (وهو العطل الواقعيّ) ⇒ يسقط',
      apply: (dir) => { relCompile(dir, REL_OLD_APP); },
      mustMatch: /لم يمرّر/ },
    { label: 'تطبيق لا ينادي yt-dlp أصلاً ⇒ «لم ينادِ» لا نجاح فارغ',
      apply: (dir) => { relCompile(dir, REL_SILENT_APP); },
      mustMatch: /لم ينادِ/ },
    { label: 'الثنائي أقدم من الشيفرة (بُني قبل آخر تغيير) ⇒ «أقدم من الشيفرة»',
      apply: (dir) => fs.utimesSync(REL_EXE(dir), new Date(Date.now() - 10800e3), new Date(Date.now() - 10800e3)),
      mustMatch: /أقدم من الشيفرة/ },
    { label: 'انحراف العَلَم: أُزيل من المصدر وبقي في الجدول ⇒ فشل مُسمّى',
      apply: (dir) => {
        const p = path.join(dir, 'src-tauri/src/yt_dlp.rs');
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('--newline', '--nl'));
      },
      mustMatch: /انحراف العَلَم/ },
    { label: 'لا ثنائي أصلاً ⇒ فشل مُسمّى لا انهيار',
      apply: (dir) => fs.rmSync(REL_EXE(dir), { force: true }),
      mustMatch: /مفقودة/ },
  ],
  zero: { label: 'لا مصدر واحد من جدول الأعلام',
    apply: (dir) => fs.rmSync(path.join(dir, 'src-tauri'), { recursive: true, force: true }) },
});

/* ── بوّابة خطوط أساس Rust: الرقمان المعلَنان (اختبارات · مواضع clippy) صارا باباً ──────
 *    تُقاس **مقارنتها** لا cargo: بيئة مصنوعة فيها `cargo.cmd` مزيّف يطبع ما تتوقّعه البوّابة،
 *    فالمُفسَدات تُشغَّل في أجزاء الثانية بدل دقيقتين، ويبقى المقيس منطق البوّابة نفسه
 *    (القياس من cargo، والحكم منها). ─────────────────────────────────────────── */
function relFakeCargo(dir, { warnings, passed, failed = 0, ignored = 4, silent = false }) {
  const jsonLines = [];
  for (let i = 0; i < warnings; i++) {
    jsonLines.push(JSON.stringify({
      reason: 'compiler-message',
      message: {
        level: 'warning', code: { code: 'clippy::probe' },
        spans: [{ is_primary: true, file_name: 'src\\probe' + i + '.rs', line_start: i + 1, column_start: 1 }],
      },
    }));
  }
  const lines = [
    '@echo off',
    'if "%1"=="--version" ( echo cargo 1.95.0-probe & exit /b 0 )',
    'if "%1"=="clippy" if "%2"=="--version" ( echo clippy 0.1.95-probe & exit /b 0 )',
    'if "%1"=="clippy" (',
  ];
  if (!silent) for (const l of jsonLines) lines.push('  echo ' + l.replace(/\^/g, '^^').replace(/[<>|&]/g, '^$&'));
  lines.push('  exit /b 0', ')');
  lines.push('if "%1"=="test" ( echo test result: ok. ' + passed + ' passed; ' + failed + ' failed; ' + ignored + ' ignored & exit /b 0 )');
  lines.push('exit /b 0');
  mk(dir, 'fakebin/cargo.cmd', lines.join('\r\n'));
}
function relBaseline(dir, clippy, tests) {
  mk(dir, 'qa/rust-baselines.json',
    JSON.stringify({ clippy_unique_warnings: clippy, tests_passed: tests, tests_ignored: 4 }, null, 2) + '\n');
}

CASES.push({
  name: 'check-rust-baselines.cjs',
  script: S('check-rust-baselines.cjs'),
  build(dir) {
    mk(dir, 'src-tauri/Cargo.toml', '[package]\nname = "probe"\nversion = "0.0.0"\n');
    relFakeCargo(dir, { warnings: 15, passed: 349 });
    relBaseline(dir, 15, 349);
  },
  controlArgs: (dir) => ['--root', dir],
  /* `USERPROFILE` موجَّه إلى مجلد مصنوع بلا `.cargo` حتى **يسقط البديل** أيضاً:
     وإلا فحالة «صفر مدخل» تنادي cargo الحقيقي فتُشغّل clippy والاختبارات (دقيقتان) داخل الحارس. */
  childEnv: (dir) => ({
    PATH: path.join(dir, 'fakebin') + path.delimiter + process.env.PATH,
    USERPROFILE: path.join(dir, 'nohome'),
  }),
  saw: (dir, res) => { const m = res.out.match(/(\d+) ناجح/); return m ? Number(m[1]) : 0; },
  sawExpected: 349,
  mutants: [
    { label: 'تحذير clippy جديد فوق الأساس ⇒ يسقط ويسمّي المواضع',
      apply: (dir) => { relFakeCargo(dir, { warnings: 17, passed: 349 }); },
      mustMatch: /تحذيرات clippy: 17 .*الأساس 15/ },
    { label: 'اختبار فاشل ⇒ يسقط ويذكر العدد',
      apply: (dir) => { relFakeCargo(dir, { warnings: 15, passed: 348, failed: 1 }); },
      mustMatch: /اختبارات فاشلة: 1/ },
    { label: 'نقص اختبارات عن الأساس (حُذفت) ⇒ يسقط ولا يمرّ صامتاً',
      apply: (dir) => { relFakeCargo(dir, { warnings: 15, passed: 340 }); },
      mustMatch: /اختبارات ناجحة: 340 < الأساس 349/ },
    { label: 'صفر تشخيص (لا JSON) ⇒ صفر مدخل لا نجاح فارغ',
      apply: (dir) => { relFakeCargo(dir, { warnings: 15, passed: 349, silent: true }); },
      mustMatch: /صفر مدخل/ },
    { label: 'خطّ أساس مفقود ⇒ صفر مدخل يسمّي الملف',
      apply: (dir) => fs.rmSync(path.join(dir, 'qa', 'rust-baselines.json'), { force: true }),
      mustMatch: /خطّ الأساس مفقود/ },
  ],
  zero: { label: 'لا cargo ولا بديل ⇒ صفر مدخل',
    apply: (dir) => fs.rmSync(path.join(dir, 'fakebin'), { recursive: true, force: true }) },
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
        /* `c.childEnv` تُبنى أوّلاً ثم يُطمَس منها ما يزحُمه المُفسَد (`m.env`)،
           فالمُفسَد يغيّر البيئة **فوق** السليمة لا بدلاً منها. */
        const env = c.childEnv ? c.childEnv(dir) : {};
        const res = runNode(c.needsScriptCopy ? path.join(dir, 'scripts', c.name) : c.script, args, dir,
          m.env ? { ...env, ...m.env } : (c.childEnv ? env : undefined));
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
