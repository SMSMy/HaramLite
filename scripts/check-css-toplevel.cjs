/* حارس CSS المشحون — يمنع رموزاً لا تصلح CSS في **المستوى الأعلى**.

   العيب المقيس (popup.css، عيب مرأي عند المستخدم): كُتبت في الملف أسطر من
   باورشل وسطر عربي عارٍ —
       '
       # أنماط تستخدمها النافذة الجديدة
       $extra = @'
   — وهي ليست CSS. محلّل CSS المتساهل لا يسقط: يقرأ حتى `{` التالي ويطرح ما
   قبله، فتضيع معه القواعد التي بين الرمز والمحدِّد التالي (سقطت فعلاً
   `.action-hint` و`.action-hint.ok` و`.action-hint.bad` و`.result-pill.bad`
   وحُجبت `.mode-item[aria-pressed="true"]`)، بلا خطأ ظاهر. فالحارس يقرأ
   الملف كما يقرؤه المحلّل: عمق الأقواس، والتعليقات، والسلاسل النصّية
   (بالهروب `\` كما تنصّ القواعد)، ويسقط على:

     ١) سلسلة نصّية لا تُغلق أو تعبر الأسطر  ⇒ علامة نصّ مقحَم لا CSS؛
     ٢) `#` لا يتبعها محرِّف في محدِّد المستوى الأعلى ⇒ لا محدِّد معرِّف
        ولا لوناً (لون لا يقع في مقدّمة محدِّد)؛
     ٣) رمز في المستوى الأعلى لا ينتهي بـ`{` (كـ`echo hello`)؛
     ٤) «}» بلا «{» يقابلها في المستوى الأعلى.

   وهذا الضبط مقصود بعد قياس: القاعدة «مقدّمة تعبر الأسطر ⇒ خلل» أسقطت
   **CSS سليماً** — `.b,\n.c {…}` قائمة محدِّدات على سطرين، وهي مستعملة في
   popup.css نفسه. فالحارس يقيس صنف العيب (نصّ مقحَم) لا مجرّد الأسطر،
   وقاعدتا (١) و(٢) تكفيان لالتقاط العيب الأصلي.

   ولا يُدّعى هنا أن الحارس محلّل CSS كامل — يُدّعى أنه يمنع صنف العيب
   المقيس، وهو مُفسَد ومُختبَر في check-guards-selfcheck.cjs.

   الاستعمال: node scripts/check-css-toplevel.cjs [--root <dir>] */
const fs = require('fs');
const path = require('path');

/** محرِّف CSS فعلي: حرف/رقم/شرطة سفلية/شرطة/عربي وما فوقه. و`-` مطلوبة لأن
 *  `#-x` و`#a1` محدِّدان صالحان. */
const ID_CHAR = /[A-Za-z0-9_\-\u00A0-\uFFFF]/;

const countNl = (s) => (s.match(/\n/g) || []).length;
const show = (s, n) => JSON.stringify(s.slice(0, n));

/** يقرأ CSS قراءة بنيوية: يعمّق على `{`، ويخرج على `}`، ويخفي التعليقات
 *  والسلاسل — ويعيد قائمة أوصاف الخلل لا أوّل خلل، ليعرف القارئ المدى. */
function scanCss(text) {
  const bad = [];
  let i = 0;
  let depth = 0;
  let line = 1;

  while (i < text.length) {
    // فاصل أو سطر جديد بين القواعد: لا شيء يُبلَّغ عنه
    if (/[\s;]/.test(text[i])) {
      if (text[i] === '\n') line++;
      i++;
      continue;
    }
    if (text[i] === '}') {
      if (depth === 0) bad.push('السطر ' + line + ': «}» بلا «{» يقابلها في المستوى الأعلى');
      else depth--;
      i++;
      continue;
    }

    // نجمع البيان كاملاً حتى `{` أو `}` أو `;`
    let j = i;
    let seg = '';
    let problem = null;
    while (j < text.length && text[j] !== '{' && text[j] !== '}' && text[j] !== ';') {
      if (text[j] === '\\') { seg += text[j] + (text[j + 1] || ''); j += 2; continue; }
      if (text[j] === '/' && text[j + 1] === '*') {
        const end = text.indexOf('*/', j + 2);
        const cmt = text.slice(j, end === -1 ? text.length : end + 2);
        line += countNl(cmt); // سطور التعليق تُحسب، لكن محتواه لا يدخل المقدّمة
        j = end === -1 ? text.length : end + 2;
        continue;
      }
      if (text[j] === '"' || text[j] === "'") {
        const q = text[j];
        let k = j + 1;
        while (k < text.length && text[k] !== q) { if (text[k] === '\\') k++; k++; }
        if (k >= text.length) {
          problem = 'سلسلة نصّية غير مغلقة (' + q + '): ' + show(text.slice(j), 40);
          j = text.length;
          break;
        }
        const raw = text.slice(j, k + 1);
        if (countNl(raw) > 0) {
          problem = 'سلسلة نصّية تعبر الأسطر (نصّ مقحَم لا CSS): ' + show(raw, 40);
          j = k + 1;
          break;
        }
        seg += raw;
        j = k + 1;
        continue;
      }
      seg += text[j];
      j++;
    }

    if (problem) {
      if (depth === 0) bad.push('السطر ' + line + ': ' + problem);
      i = j;
      continue;
    }

    const t = seg.trim();
    if (j < text.length && text[j] === '{') {
      if (depth === 0) {
        if (/#(?![A-Za-z0-9_\-\u00A0-\uFFFF])/.test(t)) {
          bad.push('السطر ' + line + ': «#» لا يتبعها محرِّف في محدِّد المستوى الأعلى: ' + show(t, 50));
        }
      }
      depth++;
      i = j + 1;
      continue;
    }

    if (depth === 0 && t && !t.startsWith('@')) {
      bad.push('السطر ' + line + ': رمز في المستوى الأعلى لا يصلح محدِّداً: «' + t.slice(0, 60) + '»');
    }
    i = j;
  }
  return bad;
}

function die(msg) {
  console.error('✗ حارس CSS المشحون: ' + msg);
  process.exit(1);
}

const argv = process.argv.slice(2);
let rootArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      console.error('✗ العلم --root يحتاج مساراً — مثال: --root /tmp/fixture');
      process.exit(2);
    }
    rootArg = argv[++i];
  } else {
    console.error('✗ وسيط غير معروف: ' + argv[i] + ' — الاستعمال: [--root <dir>]');
    process.exit(2);
  }
}

const root = rootArg ? path.resolve(rootArg) : path.join(__dirname, '..');
const extDir = path.join(root, 'browser-extension');
if (!fs.existsSync(extDir) || !fs.statSync(extDir).isDirectory()) {
  die('بنية غير صالحة: browser-extension/ غير موجود عند ' + extDir);
}

/** ملفات CSS المشحونة فعلاً: ما يقرؤه popup.html وحدها تُبنى منه القائمة،
 *  فيسقط الحارس لو أُضيف ملف CSS ولم يُشحن، ولا يفحص ملفاً غير مشحون. */
const popupHtml = path.join(extDir, 'popup.html');
if (!fs.existsSync(popupHtml)) die('popup.html غير موجود عند ' + popupHtml);
const html = fs.readFileSync(popupHtml, 'utf8');
const hrefs = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+\.css)["']/gi)].map((m) => m[1]);
const files = [...new Set(hrefs)].map((h) => path.join(extDir, h.split('/').pop()));
if (files.length === 0) {
  die('صفر ملف CSS في <link> داخل popup.html — لا شيء يُفحص، فلا يجوز إعلان النجاح.');
}
for (const f of files) {
  if (!fs.existsSync(f)) die('ملف CSS مشحون وغير موجود: ' + path.relative(root, f));
}

let bad = 0;
for (const f of files.sort()) {
  const problems = scanCss(fs.readFileSync(f, 'utf8'));
  if (problems.length) {
    bad++;
    console.log('✗ ' + path.relative(root, f));
    problems.forEach((x) => console.log('     ' + x));
  }
}
console.log(bad === 0
  ? '✓ CSS المشحون: ' + files.length + ' ملفاً بلا رموز مقحَمة في المستوى الأعلى'
  : '✗ ' + bad + ' ملف CSS فيه رموز مقحَمة من ' + files.length);
process.exit(bad ? 1 : 0);
