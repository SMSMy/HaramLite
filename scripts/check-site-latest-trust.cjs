#!/usr/bin/env node
/* حارس «لا ثقة بـlatest» — البند ن-٦ في خطة 0.2.9 §١١.
 *
 * **العطل المقيس** (2026-09-17): نشرة أخرى في المستودع — قناة أصول الإصلاح
 * `assets-v1` — صارت «Latest» نحو **دقيقة**، وكانت الصفحة تقرأ
 * `releases/latest` وتثق بـ`tag_name` **بلا تحقّق من الصيغة**، فعرضت `assets-v1`
 * إصداراً للتطبيق: شارة الهيرو، وأسماء الملفات، ونصوص الأزرار، ورابط البصمات.
 * حُصّن المنطق في `docs/index.html` (تحقّق صيغة الوسم + بناء رابط البصمات من
 * الوسم لا من `latest`، بعد أن أعاد `latest/download/SHA256SUMS.txt` **404**
 * مقاساً بلا مصادقة). **وهذا الحارس يمنع عودة العطل**.
 *
 * **كيف يقيس**: لا يقرأ تعبيراً نمطياً على المصدر ولا ينسخ المنطق، بل:
 *   ① يستخرج من `docs/index.html` **كتلة السكربت المشحونة** التي تعرّف
 *      `window.HaramLiteState` (من `<script>` إلى `</script>`) — النصّ المشحون
 *      حرفياً، لا نسخة ثانية هنا.
 *   ② يحمّلها في مستند **jsdom** حقيقي للصفحة نفسها (‏`runScripts: 'outside-only'`
 *      فلا يُنفَّذ شيء من الصفحة من تلقاء نفسه؛ ونادِ `fetchLatestRelease` صراحةً
 *      كما تفعل الصفحة عند `DOMContentLoaded`).
 *   ③ يستبدل `fetch` وحدها بواجهة مصنوعة (بلا شبكة إطلاقاً) — لأن `latest` نفسه
 *      هو المُدخَل الذي يجب ألّا يُوثق به.
 *
 * **والحالات**: وسم دلالي ⇒ يُعرض ويُبنى رابط البصمات **من الوسم** (ضابط يثبت أن
 * الآلية تعمل، فلا يمرّ الحارس لأن الصفحة لا تعرض شيئاً أبداً) · وسم غير دلالي
 * (`assets-v1` عطلَ 0.2.8 نفسه · `latest` · `nightly` · `v1.2` · `v0.2.9.1` ·
 * `v0.2.8-rc.1` · `../evil` · فارغ · غائب) ⇒ **لا يتغيّر شيء في الصفحة**: لا شارة،
 * ولا اسم ملف، ولا عنوان، ولا رابط بصمات.
 *
 * **والحارس يُقاس بنفسه** (`--selfcheck`): نسخة من الكتلة المستخرجة **حُذف منها
 * التحقّق** ⇒ وسم `assets-v1` **يُعرض** عليها، أي أن الحذف يُسقط فحصاً — فالفحص
 * محروس لا تجميلي. (وهذا هو الدليل على أن حالات الرفض ليست «لا شيء يحدث دائماً».)
 *
 * **وحدّ صريح**: هذه محاكاة في jsdom لا متصفّح حقيقي — لا أرسم الصفحة ولا أرى
 * بعيني؛ المقيس منطق القراءة نفسه. واعتماد على `jsdom` (اعتمادية تطوير قائمة).
 *
 * الاستعمال: node scripts/check-site-latest-trust.cjs [--repo=<dir>] [--selfcheck]
 * رموز الخروج: 0 = سليم · 1 = فشل · 2 = بنية/استعمال.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXIT = { PASS: 0, FAIL: 1, MISUSE: 2 };
const ROOT = path.resolve(__dirname, '..');
const PAGE_REL = path.join('docs', 'index.html');
const TAG = 'window.HaramLiteState';
/** التحقّق المشحون من صيغة الوسم — وجوده شرط بنيوي، وحذفه هو المُفسَد Ⓠ. */
const TAG_FORMAT_CHECK = 'if (!/^v?\\d+\\.\\d+\\.\\d+$/.test(String(tag))) return;';
const ANCHOR = 'https://github.com/SMSMy/HaramLite/releases/download';

class GuardError extends Error {
  constructor(message, code = EXIT.MISUSE) {
    super(message);
    this.code = code;
  }
}

/** يستخرج كتلة السكربت المشحونة التي تعرّف الحالة (بلا نسخ منطق). */
function extractStateScript(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const hit = blocks.filter((b) => b.includes(TAG));
  if (hit.length !== 1) {
    throw new GuardError(
      `لم أجد كتلة سكربت واحدة تعرّف ${TAG} في ${PAGE_REL} (وجدت ${hit.length}) — ` +
        'لا نصّ مشحون أقيسه، وهذا فشل بنيوي لا نجاح.'
    );
  }
  const src = hit[0];
  if (!src.includes(TAG_FORMAT_CHECK)) {
    throw new GuardError(
      `كتلة السكربت المشحونة لا تحوي التحقّق من صيغة الوسم:\n    ${TAG_FORMAT_CHECK}\n` +
        '    إمّا نُقل التحقّق إلى موضع آخر (فحدِّث هذا الحارس) أو حُذف — وكلاهما لا يمرّ صامتاً.'
    );
  }
  return src;
}

/** عناصر الصفحة التي يجب أن توجد، وإلا فالحارس يقيس الفراغ. */
const WATCHED = [
  '.js-release-tag',
  '.js-version-text',
  '.js-sums-link',
  '.js-exe-name',
  '.js-exe-sha',
  '.js-msi-name',
];

function loadJsdom() {
  try {
    // eslint-disable-next-line global-require
    return require('jsdom');
  } catch (err) {
    throw new GuardError(
      `تعذّر تحميل jsdom (${err.message}) — والحارس لا يمرّ بلا DOM. شغّل pnpm install.`
    );
  }
}

/**
 * يبني مستنداً للصفحة الحقيقية، ويحمّل الكتلة المشحونة (أو نسخة مُخرَّبة منها)،
 * ويستبدل `fetch` وحدها بسجلّ مصنوع. **بلا شبكة**.
 *
 * ومستمع `DOMContentLoaded` الذي تسجّله الكتلة يُعطَّل قبل التحميل: jsdom يُطلق
 * الحدث **بعد** انتهاء البناء، فكانت الصفحة تنادي `fetchLatestRelease` من تلقائها
 * **مرة ثانية** فوق ندائي الصريح (قيس: نداءان لا واحد)، فيصير القياس غير حتميّ.
 * والمقيس هنا **الدالة نفسها** كما تناديها الصفحة عند الجاهزية — فلا حاجة إلى
 * المستمع، وتعطيله لا يمسّ منطق القراءة.
 * @returns {Promise<{window:object, document:object, call:Function, snapshot:Function, fetchCalls:string[]}>}
 */
async function openPage(html, scriptText, releaseRecord) {
  const { JSDOM } = loadJsdom();
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://haramlite.example/' });
  const { window } = dom;
  const fetchCalls = [];
  window.fetch = (url) => {
    fetchCalls.push(String(url));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(releaseRecord),
    });
  };
  // انظر أعلاه: بلا هذا السطر يُنادى fetchLatestRelease مرتين ويصير القياس ضبابياً.
  window.document.addEventListener = () => {};
  window.eval(scriptText);
  const state = window.HaramLiteState;
  if (!state || typeof state.fetchLatestRelease !== 'function') {
    throw new GuardError('الكتلة المشحونة لم تُعرّف fetchLatestRelease — لا دالة أقيسها');
  }
  const doc = window.document;
  for (const sel of WATCHED) {
    if (doc.querySelectorAll(sel).length === 0) {
      throw new GuardError(`الصفحة لا تحوي عنصراً للمحدِّد «${sel}» — الحارس سيقيس الفراغ، وهذا فشل لا نجاح.`);
    }
  }
  const snapshot = () => ({
    title: doc.title,
    tag: [...doc.querySelectorAll('.js-release-tag')].map((e) => e.textContent),
    version: [...doc.querySelectorAll('.js-version-text')].map((e) => e.textContent),
    sums: [...doc.querySelectorAll('.js-sums-link')].map((e) => e.getAttribute('href')),
    exeName: [...doc.querySelectorAll('.js-exe-name')].map((e) => e.textContent),
    exeSha: [...doc.querySelectorAll('.js-exe-sha')].map((e) => e.textContent),
    msiName: [...doc.querySelectorAll('.js-msi-name')].map((e) => e.textContent),
  });
  const call = async () => {
    await state.fetchLatestRelease();
  };
  return { window, document: doc, call, snapshot, fetchCalls };
}

// ---------------------------------------------------------------------------
// الحالات
// ---------------------------------------------------------------------------

/** سجلّ نشرة مصنوع: اسم الأصل ومقاسه وبصمته. */
function record(tag, { withAssets = true } = {}) {
  const ver = String(tag).replace(/^v/i, '');
  return {
    tag_name: tag,
    assets: withAssets
      ? [
          {
            name: `HaramLite_${ver}_x64-setup.exe`,
            size: 197105521,
            digest: `sha256:${'ab'.repeat(32)}`,
            browser_download_url: `${ANCHOR}/${tag}/HaramLite_${ver}_x64-setup.exe`,
          },
          {
            name: `HaramLite_${ver}_x64_en-US.msi`,
            size: 389496832,
            digest: `sha256:${'cd'.repeat(32)}`,
            browser_download_url: `${ANCHOR}/${tag}/HaramLite_${ver}_x64_en-US.msi`,
          },
        ]
      : [],
  };
}

/** الأوسمة غير الدلالية — أولها العطل المقيس نفسه. */
const NON_SEMVER_TAGS = ['assets-v1', 'latest', 'nightly', 'v1.2', 'v0.2.9.1', 'v0.2.8-rc.1', '../evil', '', null];

async function runChecks() {
  const pagePath = path.join(ROOT, PAGE_REL);
  if (!fs.existsSync(pagePath)) throw new GuardError(`بنية غير صالحة: ${PAGE_REL} غير موجود عند ${pagePath}`);
  const html = fs.readFileSync(pagePath, 'utf8');
  const scriptText = extractStateScript(html);

  const cases = [];
  const record2 = (label, ok, detail) => {
    cases.push({ label, ok, detail: detail || '' });
  };

  /* Ⓐ ضابط: وسم دلالي ⇒ يُعرض، ورابط البصمات يُبنى من الوسم لا من latest. */
  for (const tag of ['v0.2.8', '0.2.9']) {
    const page = await openPage(html, scriptText, record(tag));
    const before = page.snapshot();
    await page.call();
    const after = page.snapshot();
    const raw = tag.replace(/^v/i, '');
    const problems = [];
    if (!after.tag.every((t) => t === tag)) problems.push(`الشارة «${after.tag[0]}» بدل «${tag}»`);
    if (!after.version.every((t) => t === raw)) problems.push(`نصّ الإصدار «${after.version[0]}» بدل «${raw}»`);
    const wantSums = `${ANCHOR}/${tag}/SHA256SUMS.txt`;
    if (!after.sums.every((h) => h === wantSums)) {
      problems.push(`رابط البصمات «${after.sums[0]}» بدل «${wantSums}» (يُبنى من الوسم لا من latest)`);
    }
    if (after.sums.some((h) => /\/latest\//.test(String(h)))) problems.push('رابط البصمات صار من مسار latest');
    if (!after.exeName[0].includes(raw)) problems.push(`اسم المثبّت «${after.exeName[0]}» لا يحمل الإصدار`);
    if (!after.exeSha[0] || /^sha256:/i.test(after.exeSha[0])) {
      problems.push(`البصمة «${after.exeSha[0]}» فارغة أو ببادئة sha256:`);
    }
    if (page.fetchCalls.length !== 1) problems.push(`الصفحة نادت fetch ${page.fetchCalls.length} مرة بدل مرة`);
    if (page.fetchCalls[0] && !/\/releases\/latest$/.test(page.fetchCalls[0])) {
      problems.push(`الرابط المقروء «${page.fetchCalls[0]}» ليس releases/latest`);
    }
    // العنوان لا يحمل إصداراً في هذه الصفحة (مقيس: `<title>HaramLite — …</title>`)
    // فالسطر `document.title.replace(...)` في المنطق لا يغيّر شيئاً اليوم — ولا
    // يُشترط تغيّره؛ والمقيس هو **سطح عرض الإصدار** الفعلي: `.js-version-text`.
    if (after.title !== before.title) problems.push(`تغيّر عنوان الصفحة بلا سبب: «${after.title}»`);
    record2(`Ⓐ ضابط: وسم دلالي ${tag} ⇒ يُعرض ورابط البصمات منه`, problems.length === 0, problems.join(' · '));
  }

  /* Ⓑ مُفسَدات ن-٦: كل وسم غير دلالي ⇒ **لا يتغيّر شيء**. */
  {
    const problems = [];
    const details = [];
    for (const tag of NON_SEMVER_TAGS) {
      const page = await openPage(html, scriptText, record(tag));
      const before = page.snapshot();
      await page.call();
      const after = page.snapshot();
      const changed = Object.keys(before).filter(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])
      );
      if (changed.length > 0) {
        details.push(`${JSON.stringify(tag)}: تغيّر ${changed.join(' · ')} (قبل/بعد: ${JSON.stringify(before[changed[0]])} → ${JSON.stringify(after[changed[0]])})`);
      }
    }
    if (details.length > 0) problems.push(...details);
    record2(
      `Ⓑ مُفسَدات: ${NON_SEMVER_TAGS.length} وسماً غير دلالي ⇒ لا يتغيّر شيء في الصفحة (ولا إصدار كاذب)`,
      problems.length === 0,
      problems.join(' · ')
    );
  }

  /* Ⓒ مُفسَد: وسم غير دلالي **مع أصول تخصّه** — الأسوأ: النشرة تحمل ملفات باسمها،
     فلا يكفي غياب الأصل كحماية؛ الحماية هي رفض الوسم نفسه. */
  {
    const page = await openPage(html, scriptText, record('assets-v1'));
    const before = page.snapshot();
    await page.call();
    const after = page.snapshot();
    const problems = [];
    if (after.tag.join() !== before.tag.join()) problems.push(`الشارة عرضت «${after.tag[0]}»`);
    if (after.exeName.join() !== before.exeName.join()) problems.push(`اسم المثبّت عرض «${after.exeName[0]}»`);
    if (after.sums.join() !== before.sums.join()) problems.push(`رابط البصمات تغيّر إلى «${after.sums[0]}»`);
    const shown = JSON.stringify(after);
    if (shown.includes('assets-v1')) {
      // العنوان وحده مسموح أن يحمل الوسم؟ لا: لا شيء في الصفحة يجوز أن يعرضه.
      problems.push('وسم assets-v1 ظهر في الصفحة بعد القراءة');
    }
    record2('Ⓒ مُفسَد: وسم assets-v1 (عطل 0.2.8) وأصول باسمه ⇒ لا يُعرض', problems.length === 0, problems.join(' · '));
  }

  /* Ⓓ مُفسَد: نشرة بلا أصول (كالمسودّة بصفر أصول) مع وسم دلالي ⇒ لا انهيار:
     الإصدار يُعرض من الوسم، وأسماء الملفات تبقى ما كتبته الصفحة. */
  {
    const page = await openPage(html, scriptText, record('v0.3.0', { withAssets: false }));
    const before = page.snapshot();
    let threw = null;
    try {
      await page.call();
    } catch (err) {
      threw = err;
    }
    const after = page.snapshot();
    const problems = [];
    if (threw) problems.push(`انهارت القراءة: ${threw.message}`);
    if (!after.tag.every((t) => t === 'v0.3.0')) problems.push(`الشارة «${after.tag[0]}» بدل v0.3.0`);
    if (after.exeName.join() !== before.exeName.join()) problems.push('اسم المثبّت تغيّر بلا أصل يخصّه');
    record2('Ⓓ ضابط: نشرة دلالية بلا أصول ⇒ لا انهيار ولا اسم ملف كاذب', problems.length === 0, problems.join(' · '));
  }

  const bad = cases.filter((c) => !c.ok);
  console.log(`حالات القياس — ${cases.length} (الوسوم غير الدلالية: ${NON_SEMVER_TAGS.length}):`);
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : `\n      ${c.detail}`}`);
  if (bad.length > 0) {
    console.error(`\n✗ فشل ${bad.length} فحصاً من ${cases.length} — الموقع قد يعرض إصداراً كاذباً من latest`);
    return EXIT.FAIL;
  }
  return EXIT.PASS;
}

// ---------------------------------------------------------------------------
// الفحص الذاتي: نسخة من الكتلة بلا تحقّق الوسم يجب أن تُسقط الحالات
// ---------------------------------------------------------------------------

async function selfcheck() {
  const pagePath = path.join(ROOT, PAGE_REL);
  const html = fs.readFileSync(pagePath, 'utf8');
  const scriptText = extractStateScript(html);
  const cases = [];

  const occurrences = scriptText.split(TAG_FORMAT_CHECK).length - 1;
  if (occurrences !== 1) {
    throw new GuardError(
      `مُفسَد باطل: نصّ التحقّق من صيغة الوسم يظهر ${occurrences} مرة في الكتلة المشحونة — لا أستطيع طمسه`
    );
  }
  const mutant = scriptText.split(TAG_FORMAT_CHECK).join('/* حذفه الفحص الذاتي (Ⓠ) */');
  if (mutant === scriptText) throw new GuardError('مُفسَد لم يغيّر الحارس — الطمس لم يقع');

  /* Ⓠ بلا التحقّق: الوسم غير الدلالي **يُعرض** ⇒ فحوص الرفض ترى الفرق فعلاً. */
  {
    const page = await openPage(html, mutant, record('assets-v1'));
    const before = page.snapshot();
    await page.call();
    const after = page.snapshot();
    const problems = [];
    if (after.tag.join() === before.tag.join()) {
      problems.push('النسخة المطموسة عرضت القيمة نفسها — أي أن الحالات لا ترى الفرق، فالحارس أعمى');
    }
    if (!after.tag.some((t) => t === 'assets-v1')) {
      problems.push(`النسخة المطموسة لم تعرض «assets-v1» (عرضت «${after.tag[0]}») — المُفسَد ليس هو العطل المقيس`);
    }
    cases.push({
      label: 'Ⓠ نسخة بلا تحقّق صيغة الوسم ⇒ assets-v1 يُعرض عليها (فحص الرفض يرى الفرق)',
      ok: problems.length === 0,
      detail: problems.join(' · '),
    });
  }

  /* Ⓠ′ الضابط: النسخة المطموسة **تعمل** على وسم دلالي — فالطمس لم يُعطّل القراءة. */
  {
    const page = await openPage(html, mutant, record('v0.4.1'));
    await page.call();
    const after = page.snapshot();
    const problems = [];
    if (!after.tag.every((t) => t === 'v0.4.1')) problems.push(`النسخة المطموسة عرضت «${after.tag[0]}» على وسم دلالي`);
    cases.push({ label: 'Ⓠ′ ضابط: النسخة المطموسة تعمل على وسم دلالي v0.4.1', ok: problems.length === 0, detail: problems.join(' · ') });
  }

  const bad = cases.filter((c) => !c.ok);
  console.log(`\nالفحص الذاتي — ${cases.length} حالة:`);
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : `\n      ${c.detail}`}`);
  if (bad.length > 0) {
    console.error(`\n✗ الفحص الذاتي سقط في ${bad.length} حالة`);
    return EXIT.FAIL;
  }
  console.log('✓ التحقّق المشحون هو ما يمنع عرض الوسم غير الدلالي — وحذفه يُسقط فحصاً.');
  return EXIT.PASS;
}

const USAGE = `الاستعمال: node scripts/check-site-latest-trust.cjs [--selfcheck] [--help]

  --selfcheck   يفحص الحارس نفسه: نسخة من الكتلة المشحونة بلا تحقّق صيغة الوسم
  --help        هذه الرسالة

يقيس كتلة السكربت **المشحونة** في docs/index.html داخل jsdom وبلا شبكة:
وسم دلالي ⇒ يُعرض ورابط البصمات يُبنى منه · وسم غير دلالي (assets-v1 · latest ·
nightly · v1.2 · v0.2.9.1 · v0.2.8-rc.1 · ../evil · فارغ · غائب) ⇒ لا يتغيّر شيء.
0 = سليم · 1 = فشل · 2 = بنية/استعمال.`;

async function main() {
  const argv = process.argv.slice(2);
  let selfcheckMode = false;
  for (const a of argv) {
    if (a === '--selfcheck') selfcheckMode = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return EXIT.PASS;
    } else throw new GuardError(`وسيط غير معروف: ${a}`);
  }
  if (selfcheckMode) return selfcheck();
  const code = await runChecks();
  if (code === EXIT.PASS) {
    console.log('✓ الموقع لا يثق بـlatest: كل وسم غير دلالي يُهمَل بلا عرض إصدار كاذب.');
  }
  return code;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`✗ ${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = err instanceof GuardError ? err.code : EXIT.FAIL;
    });
}

module.exports = { extractStateScript, TAG_FORMAT_CHECK, NON_SEMVER_TAGS };
