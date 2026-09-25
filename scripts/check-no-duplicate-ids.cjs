#!/usr/bin/env node
/* حارس «لا معرّف مكرَّر في الترميز».
 *
 * ── العطل الذي وُلد منه (مقيس في هذه الجلسة، لا مفترض) ──────────────────────
 * دمجُ فرعٍ **متخلّفٍ لا متقدّم** (`agent/x4-cancel`، قاعدته `5e5ce0f` والشجرة
 * أمامه 40 التزاماً) مرّ **بلا علامة تعارض واحدة** في `index.html`، ثم تبيّن أن
 * الشجرة المدمجة تحمل **حاويتي `engine` بنفس `data-tab`** و**نسختين من
 * `#cuda-provider`**. والكاشف الوحيد كان حارس تبويبات في jsdom برسالة
 * `cuda-provider(2 نسخة)`. ⇒ **غياب علامات التعارض ليس دليل صحّة دمج**، والصحة
 * تُقاس **بنيوياً**.
 *
 * ── لماذا هذا العطل خطير فعلاً لا شكلياً ───────────────────────────────────
 * `document.getElementById('cuda-provider')` و`querySelector('#id')` يعيدان
 * **أوّل** عنصر بالمطابقة، وكل ما بعده **لا يصل إليه أحد**: الكود يكتب على الأول
 * ويقرأ منه، والثاني يبقى ظاهراً في الواجهة **لا يحدّثه شيء**. فهو ليس تكراراً
 * جمالياً بل **سطح حالة ميت يبدو حيّاً** — وهو الصنف الذي يسقطه `AGENT.md` (لا
 * ادّعاء حالة بلا مصدر حالة).
 *
 * ── القاعدة: قيمة لا تمثيل؛ وحدّها المُعلَن ─────────────────────────────────
 * تُقرأ **سمات `id="…"` الحقيقية** في ملفات HTML المشحونة، **بعد تجريد تعليقات
 * HTML** (فمعرّفٌ في تعليق لا عنصر، وعدّه تكراراً كان سيُسقط الحارس على كود
 * سليم). **وحدّها المُعلَن**: الماسح **نصّي على سمة `id`**، فلا يرى معرّفاً
 * يكتبه JS وقت التشغيل (`el.id = 'x'`) ولا يرى مكرَّراً ناتجاً عن `innerHTML`
 * لاحق — وهذا مقصود: الترميز هو ما يمكن قياسه ساكناً، وموضعه الساكن هو هنا.
 *
 * ── القاعدة التي يفحصها (وهي التي كشفت العطل) ─────────────────────────────
 *   ① كل ملف HTML مشحون: صفر معرّف مكرَّر.
 *   ② وكل ملف **موجود** يُقاس (لا تخطّي صامت): عدد السمات المقروءة يُعلَن لكل
 *      ملف، وملفٌّ بلا معرّف واحد لا يُحتسب فحصاً ناجحاً بل يُعلَن كصفر.
 *   ③ و`index.html` (ترميز التطبيق) **إلزاميّ** وله حدّ أدنى للمدخل: لو فُقد أو
 *      فرغ، فالحارس يسقط — «حارسٌ على مدخلٍ فارغ يمرّ كذباً» (‶AGENT.md‶ §٣).
 *
 * الاستعمال: node scripts/check-no-duplicate-ids.cjs [--root <dir>] */
const fs = require('fs');
const path = require('path');

/* ── 0) الجذر والوسائط: فشل بصوت عالٍ ─────────────────────────────────────── */
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

function die(msg) {
  console.error('✗ حارس المعرّفات المكرّرة: ' + msg);
  process.exit(1);
}

/**
 * الملفات المشحونة التي تُقاس — **معلَنة بالاسم لا بالاكتشاف**:
 * `index.html` ترميز التطبيق (تصل إليه الواجهة بـgetElementById)، و
 * `browser-extension/popup.html` ترميز المنبثقة (تصل إليه popup.js كذلك).
 * وصفحات `docs/` **ليست هنا عن قصد**: هي موقع تسويقي بلا سكربت يقرأ المعرّف،
 * وتُقاس بنيوياً بحرّاسها (`site:check`).
 */
const TARGETS = [
  { rel: 'index.html', required: true, minIds: 50 },
  { rel: 'browser-extension/popup.html', required: false, minIds: 1 },
];

/* ── 1) تجريد تعليقات HTML — يحفظ أسطر الملف ─────────────────────────────── */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** كل سمات `id` الحقيقية في ملف، مع رقم السطر (1-based). */
function idAttributes(raw) {
  const text = stripHtmlComments(raw);
  const out = [];
  const re = /\bid\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = m[1].trim();
    if (!value) continue;
    out.push({ value, line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

/* ── 2) الفحص ─────────────────────────────────────────────────────────────── */
const problems = [];
const perFile = [];
let totalIds = 0;

for (const t of TARGETS) {
  const abs = path.join(root, t.rel);
  if (!fs.existsSync(abs)) {
    if (t.required) die('بنية غير صالحة: ' + t.rel + ' غير موجود عند ' + abs + ' — لا قياس، فلا نجاح.');
    perFile.push({ rel: t.rel, state: 'غائب (اختياري)', ids: 0, unique: 0 });
    continue;
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const attrs = idAttributes(raw);
  const counts = new Map();
  for (const a of attrs) {
    if (!counts.has(a.value)) counts.set(a.value, []);
    counts.get(a.value).push(a.line);
  }
  const dups = [...counts.entries()].filter(([, lines]) => lines.length > 1);

  if (attrs.length < t.minIds) {
    problems.push(
      `${t.rel}: ${attrs.length} معرّفاً فقط والمتوقَّع ≥ ${t.minIds} — الماسح لم يقرأ الترميز ` +
      '(أو الملف صار فارغاً/جزءاً)، وحارسٌ على مدخلٍ فارغ يمرّ كذباً',
    );
  }
  for (const [id, lines] of dups.sort((a, b) => a[0].localeCompare(b[0]))) {
    problems.push(
      `${t.rel}: المعرّف «${id}» مكرَّر ×${lines.length} في الأسطر ${lines.join(' · ')} — ` +
      'getElementById يعيد الأول وحده، فالبقية أسطح حالة ميتة تبدو حيّة',
    );
  }
  totalIds += attrs.length;
  perFile.push({
    rel: t.rel,
    state: dups.length ? '✗ مكرَّر' : '✓ سليم',
    ids: attrs.length,
    unique: counts.size,
  });
}

if (totalIds === 0) {
  die('صفر معرّف مقروء في كل الملفات — لا شيء يُفحص، فلا يجوز إعلان النجاح.');
}

/* ── 3) الإعلان ───────────────────────────────────────────────────────────── */
console.log('  الملف                                  سمات id  فريدة   الحالة');
for (const f of perFile) {
  console.log('  ' + f.rel.padEnd(38) + String(f.ids).padStart(5) + String(f.unique).padStart(8) + '   ' + f.state);
}

if (problems.length) {
  console.error('\n✗ حارس المعرّفات المكرّرة: ' + problems.length + ' مشكلة:');
  for (const p of problems) console.error('   - ' + p);
  process.exit(1);
}

console.log(`✓ لا معرّف مكرَّر: ${totalIds} سمة id في ${perFile.filter((f) => f.ids > 0).length} ملفاً، كلها فريدة داخله (تعليقات HTML مجرَّدة قبل العدّ)`);
