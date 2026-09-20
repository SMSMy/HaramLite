#!/usr/bin/env node
/* حارس **مدخل الفصل الواحد** — node scripts/check-separation-entry.cjs [--root <dir>] [--quiet]
 *
 *   رموز الخروج:  0 = كل موضع مسموح مطابق · 1 = مخالفة (مدخل جديد/عدد متغيّر)
 *                 2 = خطأ بنية/عمى (لا مصادر · صفر موضع · قائمة فاسدة · وسيط مجهول)
 *                 (‏2 عمداً: «صفر مدخل» و«مجلد مفقود» ليسا نجاحاً — على درس
 *                  `scripts/matrix-check.cjs:380-390`.)
 *
 * **لماذا وُجد** (السياق المقيس): الحماية القادمة في 0.2.9 — محدِّد فتحات الفصل
 * عبر العمليات — تقوم كلها على أن **كل** مداخل الفصل تمرّ عبر **غلاف واحد**.
 * واليوم توجد سبعة مواضع تنادي `pipeline::process_file` مباشرة (خمسة في مسار
 * المنتج واثنان في الاختبارات)، وهي مبعثَرة في ستّة ملفات. فحارسٌ يمنع **الثامن**
 * (والسادس في مسار المنتج) أرخص اليوم من اكتشافه بعد أن يُبنى المحدِّد على مدخل
 * لم يُحصَ. القياس الذي وُلد منه (‏2026-09-17، `git grep -n process_file`) في
 * جدول `docs/CONTRIBUTING.md`.
 *
 * **كيف يقرّر** — على **النصّ بعد نزع التعليقات** لا على النصّ الخام:
 *   ① كل ملف `.rs` تحت `src-tauri/` (بلا `target/`) يُقرأ، ويُنزع منه التعليق
 *      ونصّ السلسلة (تبقى الإزاحات وأرقام الأسطر صالحة).
 *   ② «الموضع» = **كل ذكر حيّ** للمعرّف `process_file` في ما بقي — لا صيغةً
 *      بعينها (`pipeline::process_file(` مثلاً). وهذا **أوسع عمداً**: حارس يقيس
 *      تمثيلاً نصّياً يُخترق بمرادفة واحدة (‏AGENT.md §٧): `use crate::pipeline as p;`
 *      ثم `p::process_file(` · `Self::process_file(` · أو نداء عارٍ بعد
 *      `use crate::pipeline::process_file;` — كلها تُمسك. ويُستثنى اثنان:
 *      • **تعريف الدالة** (`pub fn process_file(`) — ليس مدخلاً.
 *      • **سطر استيراد** يبدأ بـ`use` — إعلانٌ لا مدخل، ويُطبع عدّه صراحةً فلا
 *        يسقط شيء بصمت.
 *   ③ تُقابَل المواضع لكل ملف بـ**القائمة المسموحة** أدناه (ملف + عدد متوقَّع).
 *
 * **العدد متوقَّع لا حدّ أقصى** عمداً: زيادته = مدخل جديد لم يُسجَّل ⇒ فشل؛ ونقصه
 * = القائمة تقادمت (نُقل مدخل أو حُذف) ⇒ فشل أيضاً، وعلاجه **تحديث القائمة في
 * الالتزام نفسه** — فالحارس يقيس عقداً مُعلَناً ولا يعارض تغييراً؛ يمنع فقط أن
 * يمرّ التغيير **صامتاً**.
 *
 * **حدّ أمانة**: هذا حارس **بنيوي ساكن** — يقيس وجود المداخل وعددها لا سلوكها
 * ولا أنها تمرّ عبر الغلاف فعلاً (ذاك عمل 0.2.9 نفسه). ولا يرى نداءً غير مباشر
 * لا يذكر الاسم (مؤشّر دالة مُعاد تسميته، مثلاً) — والمراد منه أن يجعل **الثامن**
 * مستحيلاً بلا إعلان، لا أن يُثبت أن كل مسار محميّ.
 *
 * الاستعمال: node scripts/check-separation-entry.cjs [--root <dir>] [--quiet] [--help]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* ── رموز الخروج ─────────────────────────────────────────────────────────── */
const EXIT = { PASS: 0, VIOLATION: 1, MISUSE: 2 };

/** الاسم الوحيد المقيس: نقطة الدخول إلى محرّك الفصل. */
const ENTRY = 'process_file';

/* ── القائمة المسموحة — صريحة: ملف + عدد المواضع المتوقَّع ──────────────────
 * `role` للحصيلة، و`why` سطرُ تعليل يُطبع مع المخالفة ليعرف القارئ ما الذي كسره. */
const ALLOWED = [
  { file: 'src-tauri/src/bridge.rs', sites: 1, role: 'منتج', why: 'الجسر: معالجة ملف قادم من الواجهة/الإضافة' },
  { file: 'src-tauri/src/cli.rs', sites: 1, role: 'منتج', why: 'سطر الأوامر' },
  { file: 'src-tauri/src/lib.rs', sites: 1, role: 'منتج', why: 'غلاف الأوامر المشترك بين CLI والواجهة' },
  { file: 'src-tauri/src/telegram.rs', sites: 1, role: 'منتج', why: 'روبوت تيليجرام' },
  { file: 'src-tauri/src/watch_service.rs', sites: 1, role: 'منتج', why: 'مجلد المراقبة (المسح الدوري والأحداث)' },
  { file: 'src-tauri/src/pipeline.rs', sites: 1, role: 'اختبار', why: 'تعريف الدالة (لا يُعدّ) + اختبار وحدة' },
  { file: 'src-tauri/src/separator.rs', sites: 1, role: 'اختبار', why: 'اختبار فصل داخل الوحدة' },
];

/** غلاف العامل القادم (0.2.9): **واحد** يحمل المدخل، ووجوده اختياري اليوم.
 *  `max` لا `sites`: الغلاف قد يوجد بلا نداء بعد (محدِّد صافٍ) فيُسمح بذلك،
 *  ويُمنع أن يحمل الغلافان معاً مدخلاً — فالمطلوب غلاف **واحد** لا اثنان. */
const WRAPPERS = [
  { file: 'src-tauri/src/slots.rs', max: 1 },
  { file: 'src-tauri/src/jobs.rs', max: 1 },
];

/* ── نزع التعليقات ───────────────────────────────────────────────────────── */

/** يُفرّغ التعليقات ونصوص السلاسل والمحارف **بمسافات** — و«الأسطر كما هي»
 *  فتبقى الإزاحات وأرقام الأسطر صالحة للاستخراج والرسائل.
 *
 *  منطق الجولة مأخوذ من `scripts/check-extension-sync.cjs:44-73` (مُختبَر هناك،
 *  ولم يُعدَّل: هو حارس الإضافة ولا شأن له بـRust)، ومُعدَّل هنا لأجل **Rust**.
 *  والقياس (2026-09-20) يقول أيّ التعديلات **عطلٌ مقيس** وأيّها **احتياط لغوي**:
 *
 *   • **العلامة العمرية `'static` — عطل مقيس، وهو المبرّر الحقيقي**: الموروث
 *     يعدّ `'` فتحَ سلسلة، وشيفرة Rust مليئة بالأعمار (٢٢٨ علامة عمرية في ٣٧
 *     ملفاً) ⇒ **٦٨ فتحاً في غير موضعه**، و**٩٩٬٠٣٠ محرفاً** داخلها، و**٤٠** منها
 *     تحوي بداية تعليق و**٢** تحوي الاسم. والأثر المقيس: ذكر التعليق في
 *     `src-tauri/src/lib.rs:518` (`/// … pipeline::process_file …`) **لا يُنزع**
 *     فيُعدّ مدخلاً ثانياً في ملف مسموح بواحد ⇒ **إنذار كاذب دائم** على شجرة
 *     نظيفة. (واتّجاهه **إنذار لا عمى**: الموروث لا يحذف نصاً بل يُصنّف، والمواضع
 *     السبعة كلها تنجو فيه — قياس: ٧/٧، وانحراف الطول والأسطر **صفر**.)
 *   • **السلاسل الخام `r#"…"#` — عطل مقيس في مجمَعه**: الموروث يقفل عند أول `"`
 *     والتطبيق يستعمل ٢٨ سلسلة خامة بهاشات **كلّها** (٢٨/٢٨) جسمها يحوي `"` داخلي
 *     ⇒ الانغلاق عند `"` داخلي فتصير بقيّة الجسم «كوداً حيّاً»؛ و**٢** من أجسامها
 *     تحوي `//` (منها `src-tauri/src/bridge.rs:1786` في سطر الانغلاق نفسه) ⇒ يمكن
 *     أن يُبتلع ما بعدها في السطر كتعليق — أي **عمى** لا إنذار. ولم يقع اليوم أن
 *     أُخفي أحد المواضع السبعة بهذا (٠/٧) — فهو **خطر مقيس الحدّ لا عطل واقع**.
 *   • **تعليقات الكتلة المتداخلة** (Rust تُداخلها) و**تفريغ نصوص السلاسل**: هما
 *     **احتياط لغوي** لا عطل مقيس — قياس الشجرة: ٠ تعليق كتلي متداخل، و٠ ذكر
 *     للاسم داخل نصّ سلسلة. ويُثبت سلوكهما مُفسَد مصنوع في بوّابة الحرّاس.
 *  والاقتباس المائل `` ` `` (يُعالجه الأصل لأجل JS) لا وجود له في Rust ⇒ أُسقط. */
function stripRustComments(text) {
  const n = text.length;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  let out = '';
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];

    // ① تعليق سطري — حتى نهاية السطر (يبقى السطر نفسه).
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') { out += ' '; i++; }
      continue;
    }

    // ② تعليق كتلي، ويُعدّ الأعماق (Rust تُداخل الكتل).
    if (c === '/' && d === '*') {
      let depth = 0;
      while (i < n) {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; out += '  '; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === '/') {
          depth--; out += '  '; i += 2;
          if (depth === 0) break;
          continue;
        }
        out += blank(text[i]); i++;
      }
      continue;
    }

    // ③ سلسلة: خام `r#"…"#` أو عادية `"…"` (وبادئات b/c)، ونصّها يُفرَّغ
    //    (فذكر الاسم داخل رسالة ليس مدخلاً).
    const st = stringStartAt(text, i);
    if (st) {
      out += text.slice(i, i + st.open.length);
      i += st.open.length;
      if (st.raw) {
        const closer = '"' + '#'.repeat(st.hashes);
        while (i < n) {
          if (text.startsWith(closer, i)) { out += closer; i += closer.length; break; }
          out += blank(text[i]); i++;
        }
      } else {
        while (i < n && text[i] !== '"') {
          // الهروب يُفرَّغ **إلا إن كان استمرارَ سطر** (`\` في آخر السطر داخل
          // سلسلة — وهي صيغة مستعملة في هذا المستودع في نصوص عربية طويلة):
          // إسقاط السطر يزحزح كل أرقام الأسطر بعده فيُبلَّغ عن السطر الخطأ.
          // (وقع فعلاً في **النسخة الأولى من هذا الحارس**: ٣٣ سطراً في سبعة ملفات.
          //  والمنزِّع الموروث **بريء** منه — انحراف أسطره صفر في ٣٧ ملفاً.)
          if (text[i] === '\\' && i + 1 < n) {
            if (text[i + 1] === '\r' && text[i + 2] === '\n') { out += ' \r\n'; i += 3; continue; }
            out += text[i + 1] === '\n' ? ' \n' : '  ';
            i += 2;
            continue;
          }
          out += blank(text[i]); i++;
        }
        if (i < n) { out += '"'; i++; }
      }
      continue;
    }

    // ④ محرف `'x'` — وإلا فهو عمر (`'a`) فلا يُبتلع شيء.
    if (c === "'") {
      const m = /^'(?:\\[^\n]|[^\\'\n])'/.exec(text.slice(i, i + 8));
      if (m) { out += "'" + ' '.repeat(m[0].length - 2) + "'"; i += m[0].length; continue; }
      out += "'"; i++;
      continue;
    }

    out += c; i++;
  }
  return out;
}

/** بداية سلسلة عند `i`؟ تُعيد { open, raw, hashes } أو null. */
function stringStartAt(text, i) {
  const prev = text[i - 1];
  if (prev !== undefined && /[A-Za-z0-9_]/.test(prev)) return null; // جزء من معرّف
  let j = i;
  if (text[j] === 'b' || text[j] === 'c') j++; // b"…" · c"…"
  if (text[j] === 'r') {
    j++;
    let hashes = 0;
    while (text[j] === '#') { hashes++; j++; }
    if (text[j] !== '"') return null;
    return { open: text.slice(i, j + 1), raw: true, hashes };
  }
  if (text[j] === '"') return { open: text.slice(i, j + 1), raw: false, hashes: 0 };
  return null;
}

/* ── استخراج المواضع ─────────────────────────────────────────────────────── */

/** دليل إزاحة ⟶ رقم سطر (بحث ثنائي على بدايات الأسطر). */
function lineIndexer(live) {
  const starts = [0];
  for (let i = 0; i < live.length; i++) if (live[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * مواضع الاسم في ملف Rust واحد، على النصّ الحيّ (بلا تعليقات ولا نصوص سلاسل).
 * @returns {{sites: Array<{line:number,code:string,raw:string}>, imports: Array<{line:number,raw:string}>}}
 */
function findSites(text) {
  const live = stripRustComments(text);
  const at = lineIndexer(live);
  const rawLines = text.split(/\r?\n/);
  const liveLines = live.split(/\r?\n/);
  const sites = [];
  const imports = [];
  const re = new RegExp('\\b' + ENTRY + '\\b', 'g');
  let m;
  while ((m = re.exec(live)) !== null) {
    // تعريف الدالة ليس مدخلاً: `pub fn process_file(` · `async fn process_file(`.
    if (/\bfn\s+$/.test(live.slice(Math.max(0, m.index - 24), m.index))) continue;
    const line = at(m.index);
    const raw = (rawLines[line - 1] || '').trim();
    // سطر استيراد (`use …`) إعلانٌ لا مدخل — ويُعدّ ويُطبع صراحةً.
    if (/^use\b/.test((liveLines[line - 1] || '').trim())) { imports.push({ line, raw }); continue; }
    sites.push({ line, code: (liveLines[line - 1] || '').trim(), raw });
  }
  return { sites, imports };
}

/** كل ملفات `.rs` تحت جذر — بلا `target/` ولا مجلدات مخفيّة.
 *  `rel` تُبنى **نسبةً إلى جذر الشجرة** (`prefix` = موضع جذر المسح داخل الجذر)،
 *  فمفاتيح القائمة المسموحة ومسار المسح على **جذر واحد** — وهذا عطل مقيس: مسحٌ
 *  يُسمّي `src/bridge.rs` وقائمةٌ تُسمّي `src-tauri/src/bridge.rs` تُنتج مخالفة
 *  لكل موضع (‏14 = 7 مواضع + 7 قوائم «ناقصة») على شجرة **سليمة**. */
function listRustSources(root, prefix) {
  const found = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (e.name === 'target' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), childRel);
      } else if (e.isFile() && e.name.endsWith('.rs')) {
        found.push({ abs: path.join(dir, e.name), rel: (prefix ? prefix + '/' : '') + childRel });
      }
    }
  };
  walk(root, '');
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

/* ── الوسائط ─────────────────────────────────────────────────────────────── */
const USAGE = `الاستعمال: node scripts/check-separation-entry.cjs [--root <dir>] [--quiet] [--help]

  --root <dir>  جذر الشجرة المقيسة (افتراضاً جذر المستودع)
  --quiet       الحصيلة والمخالفات فقط
  --help        هذه الرسالة

يرجع 0 إن طابق كل موضع القائمة المسموحة · 1 عند مدخل جديد أو عدد متغيّر
· 2 عند مجلد مصادر مفقود أو صفر موضع أو قائمة فاسدة (لا قياس، فلا نجاح).`;

function parseArgs(argv) {
  const opts = { root: null, quiet: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
        process.stderr.write('✗ العلم --root يحتاج مساراً — مثال: --root /tmp/fixture\n');
        opts.bad = true;
        return opts;
      }
      opts.root = argv[++i];
    } else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      process.stderr.write('✗ وسيط غير معروف: ' + a + ' — الاستعمال: [--root <dir>] [--quiet]\n');
      opts.bad = true;
      return opts;
    }
  }
  return opts;
}

/* ── التشغيل ─────────────────────────────────────────────────────────────── */
function main(argv) {
  const opts = parseArgs(argv);
  if (opts.bad) return EXIT.MISUSE;
  if (opts.help) { process.stdout.write(USAGE + '\n'); return EXIT.MISUSE; }

  const die = (msg) => { process.stderr.write('✗ ' + msg + '\n'); return EXIT.MISUSE; };

  const root = opts.root ? path.resolve(opts.root) : path.join(__dirname, '..');
  const scanRoot = path.join(root, 'src-tauri');
  const allowedByFile = new Map(ALLOWED.map((e) => [e.file, e]));
  const wrapperByFile = new Map(WRAPPERS.map((e) => [e.file, e]));

  /* ① البنية: بلا مصادر لا قياس — ولا يُقال «نجح» على فراغ. */
  if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
    return die('مجلد المصادر مفقود: ' + scanRoot + ' — لا شيء يُقاس (وليس نجاحاً).');
  }
  if (ALLOWED.length === 0) {
    return die('القائمة المسموحة فارغة — حارس بلا قائمة لا يقيس شيئاً.');
  }
  const files = listRustSources(scanRoot, 'src-tauri');
  if (files.length === 0) {
    return die('صفر ملف Rust تحت ' + scanRoot + ' — لا مصادر تُقاس، فلا نجاح.');
  }

  /* ② القياس */
  const perFile = new Map(); // rel ⟶ { sites, imports }
  for (const f of files) {
    const r = findSites(fs.readFileSync(f.abs, 'utf8'));
    if (r.sites.length || r.imports.length) perFile.set(f.rel, r);
  }
  let totalSites = 0;
  let totalImports = 0;
  for (const r of perFile.values()) { totalSites += r.sites.length; totalImports += r.imports.length; }

  /* ③ العمى: صفر موضع في الشجرة كلها ⇒ بنية تغيّرت أو الاسم تبدّل. */
  if (totalSites === 0) {
    return die(
      'صفر مدخل: لا موضع واحد للمعرّف «' + ENTRY + '» في ' + files.length + ' ملف Rust تحت ' + scanRoot + '.\n' +
      '  «صفر مدخل» ليس نجاحاً: إما أن الاسم تبدّل أو أن المصادر ليست المقصودة — راجع القائمة المسموحة والمسار.'
    );
  }

  /* ④ المقابلة بالقائمة */
  const violations = [];
  const note = (kind, file, line, raw, detail) =>
    violations.push({ kind, file, line, raw, detail });

  for (const [rel, r] of perFile) {
    const n = r.sites.length;
    const allowed = allowedByFile.get(rel);
    const wrapper = wrapperByFile.get(rel);
    if (allowed) {
      if (n > allowed.sites) {
        note('زيادة', rel, r.sites[allowed.sites].line, r.sites[allowed.sites].raw,
          'المتوقَّع ' + allowed.sites + ' ووُجد ' + n + ' — مدخل جديد في ملف مسموح');
      } else if (n < allowed.sites) {
        note('نقص', rel, r.sites.length ? r.sites[0].line : 0, r.sites.length ? r.sites[0].raw : '',
          'المتوقَّع ' + allowed.sites + ' ووُجد ' + n + ' — موضع موعود غاب (نُقل أو حُذف؟)');
      }
    } else if (wrapper) {
      if (n > wrapper.max) {
        note('غلاف', rel, r.sites[wrapper.max].line, r.sites[wrapper.max].raw,
          'غلاف العامل يُسمح بواحد ووُجد ' + n);
      }
    } else {
      note('جديد', rel, r.sites[0].line, r.sites[0].raw,
        'ملف غير مسموح يحمل مدخل فصل مباشر — مرّره عبر الغلاف الواحد أو سجّله في القائمة');
    }
  }
  for (const e of ALLOWED) {
    if (!perFile.has(e.file) || perFile.get(e.file).sites.length === 0) {
      note('نقص', e.file, 0, '', 'ملف مسموح بلا موضع (المتوقَّع ' + e.sites + ') — القائمة تقادمت');
    }
  }
  const wrappersWithSite = WRAPPERS.filter((e) => {
    const r = perFile.get(e.file);
    return r && r.sites.length > 0;
  });
  if (wrappersWithSite.length > 1) {
    note('غلاف', wrappersWithSite.map((e) => e.file).join(' + '), 0, '',
      'أكثر من غلاف واحد يحمل مدخل الفصل — المطلوب غلاف واحد');
  }

  /* ⑤ العرض */
  const product = ALLOWED.filter((e) => e.role === 'منتج')
    .reduce((s, e) => s + (perFile.get(e.file) ? perFile.get(e.file).sites.length : 0), 0);
  const tests = ALLOWED.filter((e) => e.role === 'اختبار')
    .reduce((s, e) => s + (perFile.get(e.file) ? perFile.get(e.file).sites.length : 0), 0);

  const out = [];
  if (!opts.quiet) {
    out.push('حارس مدخل الفصل الواحد — المصادر: ' + scanRoot + ' (' + files.length + ' ملف Rust)');
    out.push('القائمة المسموحة (' + ALLOWED.length + ' مدخلاً · ' + WRAPPERS.length + ' غلاف اختياري):');
    for (const e of ALLOWED) {
      const r = perFile.get(e.file);
      const n = r ? r.sites.length : 0;
      out.push('  ' + (n === e.sites ? '✓' : '✗') + ' ' + e.file.padEnd(34) + n + '/' + e.sites + '  ' + e.role + ' — ' + e.why);
      if (r) for (const s of r.sites) out.push('        · سطر ' + s.line + ': ' + s.raw);
    }
    for (const e of WRAPPERS) {
      const r = perFile.get(e.file);
      const n = r ? r.sites.length : 0;
      out.push('  ' + (r ? '✓' : '·') + ' ' + e.file.padEnd(34) + n + '/≤' + e.max + '  غلاف العامل' +
        (r ? '' : ' — غائب بعد (يُسمح بموضع واحد عند وجوده)'));
    }
    const strays = [...perFile.keys()].filter((k) => !allowedByFile.has(k) && !wrapperByFile.has(k));
    if (strays.length) out.push('ملفات خارج القائمة تحمل الاسم: ' + strays.join(' · '));
    out.push('خارج العدّ: استيراد `use` ' + totalImports + ' · تعريف `fn` مُستثنى');
    out.push('');
  }
  // المخالفات تُطبع **دائماً** — و`--quiet` يُخفي القائمة لا سبب السقوط.
  for (const v of violations) {
    out.push('✗ ' + (v.line ? v.file + ':' + v.line + ' — ' : v.file + ' — ') + v.detail);
    if (v.raw) out.push('      ' + v.raw);
  }

  if (violations.length) {
    const lines = out.slice();
    lines.push('✗ فشل الحارس: ' + violations.length + ' مخالفة — كل مدخل للفصل يمرّ عبر الغلاف الواحد ويُسجَّل صراحةً في القائمة المسموحة.');
    lines.push('  (وإن كان النقص مقصوداً — نُقل مدخل إلى الغلاف — فحدِّث القائمة في الالتزام نفسه.)');
    process.stderr.write(lines.join('\n') + '\n');
    return EXIT.VIOLATION;
  }

  out.push('✓ ' + totalSites + ' مواضع مسموحة · 0 غير مسموح — منها ' + product + ' في مسار المنتج و' + tests +
    ' في الاختبارات · أغلفة العامل: ' + wrappersWithSite.length);
  process.stdout.write(out.join('\n') + '\n');
  return EXIT.PASS;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { stripRustComments, findSites, listRustSources, stringStartAt, ALLOWED, WRAPPERS, ENTRY, EXIT };
