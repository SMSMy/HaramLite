#!/usr/bin/env node
/* قياس حيّ للنافذة المنبثقة في DOM — node scripts/check-extension-i18n-jsdom.cjs
 *
 * **لماذا jsdom ولا متصفّح حقيقي**: كروم ١٥٣ لم يعد يحترم `--load-extension`
 * (جُرِّب `--disable-features=DisableLoadExtensionCommandLineSwitch`
 * و`--enable-unsafe-extension-debugging` فلم يتغيّر شيء) ⇒ **تحميل الإضافة في
 * متصفّح حقيقي غير مقيس في هذه البيئة ولا يُدّعى**. فالمقيس هنا: الصفحة المشحونة
 * نفسها (`popup.html`) مع **السكربت المشحون نفسه** (`popup.js`) داخل DOM حقيقي
 * (‏jsdom) بواجهة `chrome` مصنوعة — فيُقاس **النصّ المعروض والاتجاه** لا الشيفرة
 * وحدها. ومثل هذه البوابة كانت مستحيلة على حارس ثابت.
 *
 * **ما يقيسه**: أربع حالات لغات، ولا نصّ متوقَّع مكتوب بيد — الجدول يُستخرج من
 * `popup.js` بـ`findTable` نفسه الذي يستعمله الحارس:
 *   ① العربية ⇒ `dir=rtl` و`lang=ar`، وكل `data-i18n` يحمل قيمته العربية.
 *   ② الإنجليزية ⇒ `dir=ltr` و`lang=en`، والمستند المعروض **بصفر محرف عربي**.
 *   ③ لغة غير مدعومة (`fr-FR`) ⇒ الافتراضي إنجليزي. ④ `[fr, ar-EG]` ⇒ عربية.
 * ويُقاس كذلك: سمة `alt` المربوطة · رقم الإصدار من المانيفست · مسار **الاتصال**
 * (‏`status.connected`) ومسار **الانقطاع** (بطاقة التشخيص بنصّها العربي).
 *
 * **ومُفسَداته معه**: بوابة بلا مُفسَد ليست بوابة. فبعد الضابط تُقاس **أربعة
 * مُفسَدات في الذاكرة** (‏`RTL` ثابت · `lang` ثابت · قيمة جدول مُبدَّلة · الربط
 * مقطوع) و**ضابط سالب** (تعليق عربي، وتغيير قيمة إنجليزية في اللغتين معاً) —
 * بلا ملف مؤقت ولا كتابة على القرص ولا عملية فرعية.
 *
 * **وحدّ مُعلَن**: هذا قياس **DOM لا متصفّح**. لا يرسم خطوطاً، ولا يختبر CSP،
 * ولا `chrome.*` الحقيقية، ولا تحميل الإضافة، ولا `content.js` على يوتيوب.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { findTable, AR } = require('./check-extension-i18n.cjs');

const REPO = path.resolve(__dirname, '..');
const EXT = path.join(REPO, 'browser-extension');
const SHIPPED = {
  html: fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8'),
  js: fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8'),
  version: JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (w, sel) => { const n = w.document.querySelector(sel); return n ? n.textContent : null; };

/** الجدول يُستخرج من الملف المشحون نفسه — فلا نصّ متوقَّع مكتوب بيد. */
function parseTable(jsSrc) {
  const t = findTable(jsSrc);
  return t ? new Function(t.literal + '\nreturn I18N;')() : null;
}

/** يُنشئ الصفحة بواجهة `chrome` مصنوعة و`navigator.languages` مطلوبة، ثم يُنفّذ
 *  `popup.js` داخلها. `opts.down` = الجسر لا يردّ فيُقاس مسار الانقطاع. */
function render(src, languages, opts) {
  const down = !!(opts && opts.down);
  const dom = new JSDOM(src.html, { url: 'https://haramlite.test/popup.html', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(w.navigator, 'language', { value: languages[0] || 'en', configurable: true });
  w.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: src.version }),
      sendMessage: (msg, cb) => {
        if (!cb) return;
        setTimeout(() => {
          if (down) w.chrome.runtime.lastError = { message: 'no host' };
          cb(down ? undefined : { ok: true, resp: { state: {} } });
        }, 0);
      },
    },
    tabs: {
      query: (_q, cb) => cb([{ id: 1, url: 'https://www.youtube.com/watch?v=abc', title: 'Example video' }]),
      sendMessage: (_id, _m, cb) => cb({ ok: true }),
    },
  };
  w.eval(src.js);
  return w;
}

/** القياس كاملاً على مصدر مُمرَّر. `report(label, cond, detail)` هو المبلِّغ. */
async function measure(src, report) {
  const I18N = parseTable(src.js);
  if (!I18N) { report('جدول الترجمة في popup.js مقروء', false, 'لا `const I18N = {`'); return; }
  const bound = [...src.html.matchAll(/\bdata-i18n="([^"]*)"/g)].map((m) => m[1]);
  const attrBound = [...src.html.matchAll(/\bdata-i18n-attr="([^"]*)"/g)].map((m) => m[1]);
  report('صفر مدخل: الصفحة تحمل مواضع ربط مقيسة (' + bound.length + ' نصّاً · ' + attrBound.length + ' سمة)',
    bound.length > 0 && attrBound.length > 0);

  /* **ترتيب مقصود**: الربط الثابت (`applyI18n`) يُنفَّذ **تزامناً** عند تقييم
   * `popup.js`، وآلة الحالة تكتب بعده (‏`setState`) — فتُقاس قيم الربط **قبل**
   * أول `await`، وإلا قِيس موضعٌ كتبته الحالة لا موضعَ الربط. (وهو خطأ وقع فعلاً
   * في أول كتابة لهذا الملف: `status.checking` أُبلغ «مخالفاً» وهو مربوط صحيحاً
   * ثم استُبدل بنصّ الحالة عن قصد — أُعلن وأُصلح.) */
  const ar = render(src, ['ar-SA', 'en-US']);
  const en = render(src, ['en-US', 'ar']);
  const fr = render(src, ['fr-FR']);
  const frAr = render(src, ['fr', 'ar-EG']);

  report('عربية ⇒ direction=rtl', ar.document.documentElement.dir === 'rtl',
    'وُجد ' + JSON.stringify(ar.document.documentElement.dir));
  report('عربية ⇒ lang=ar', ar.document.documentElement.lang === 'ar',
    'وُجد ' + JSON.stringify(ar.document.documentElement.lang));
  report('إنجليزية ⇒ direction=ltr', en.document.documentElement.dir === 'ltr',
    'وُجد ' + JSON.stringify(en.document.documentElement.dir));
  report('إنجليزية ⇒ lang=en', en.document.documentElement.lang === 'en',
    'وُجد ' + JSON.stringify(en.document.documentElement.lang));
  report('الاتجاه **مشتقّ من اللغة** (المستندان مختلفان)',
    ar.document.documentElement.dir !== en.document.documentElement.dir);

  const arWrong = [], enWrong = [];
  for (const k of bound) {
    if (textOf(ar, '[data-i18n="' + k + '"]') !== I18N.ar[k]) arWrong.push(k);
    if (textOf(en, '[data-i18n="' + k + '"]') !== I18N.en[k]) enWrong.push(k);
  }
  report('كل نصّ مربوط يعرض قيمته العربية (' + bound.length + ' موضعاً)',
    arWrong.length === 0, 'مخالف: ' + arWrong.join(' · '));
  report('كل نصّ مربوط يعرض قيمته الإنجليزية (' + bound.length + ' موضعاً)',
    enWrong.length === 0, 'مخالف: ' + enWrong.join(' · '));

  const img = ar.document.querySelector('[data-i18n-attr]');
  report('سمة `alt` المربوطة تُسند من الجدول', !!img && img.getAttribute('alt') === I18N.ar['header.iconAlt'],
    img ? 'وُجد ' + JSON.stringify(img.getAttribute('alt')) : 'لا عنصر');

  /* مفتاح مربوط غير موجود ⇒ `t()` تُرجع `undefined` فتُكتب حرفياً على الشاشة.
   * وهذا هو العطب **المرئي** الذي يقع إن انزاح مفتاح بين الصفحة والجدول، فيُقاس
   * صراحةً ولا يُترك لفحص القيمة وحده. */
  const undef = [];
  for (const w of [ar, en]) {
    for (const n of w.document.querySelectorAll('[data-i18n]')) {
      if (/undefined/.test(n.textContent)) undef.push(n.getAttribute('data-i18n'));
    }
  }
  report('لا عنصر مربوط يعرض `undefined` (مفتاح مفقود من الجدول)', undef.length === 0, undef.join(' · '));

  const arInEn = [...en.document.body.textContent].filter((c) => AR.test(c)).length;
  report('المستند الإنجليزي المعروض بصفر محرف عربي', arInEn === 0, 'وُجد ' + arInEn + ' محرفاً');

  /* تغطية **السطح الثابت** بأكمله. ولا يُطلب ذلك من مفاتيح الحالات العابرة
   * (`err.*` · `stage.*` · `send.*` · `watch.*`) فهي لا تُعرض إلا عند وقوعها —
   * فاقتُصر الفحص على المفاتيح **المربوطة**، وهو ما يجعل الادّعاء مقيساً. */
  const missingAr = bound.filter((k) => !ar.document.body.textContent.includes(I18N.ar[k]));
  const missingEn = bound.filter((k) => !en.document.body.textContent.includes(I18N.en[k]));
  report('لا مفتاح مربوط غائب عن المستند العربي المعروض', missingAr.length === 0, 'غائب: ' + missingAr.join(' · '));
  report('لا مفتاح مربوط غائب عن المستند الإنجليزي المعروض', missingEn.length === 0, 'غائب: ' + missingEn.join(' · '));

  report('وسم الإصدار = إصدار المانيفست (' + src.version + ')',
    textOf(ar, '#version-tag') === 'v' + src.version, 'وُجد ' + JSON.stringify(textOf(ar, '#version-tag')));

  /* ثم تُترك آلة الحالة تكتب: مسار الاتصال، ثم مسار الانقطاع. */
  await sleep(30);
  report('مسار الاتصال: الحالة تُعرض بنصّ الجدول (status.connected)',
    textOf(ar, '#status-title') === I18N.ar['status.connected'], 'وُجد ' + JSON.stringify(textOf(ar, '#status-title')));
  report('التبويب النشط يُعرض (عنوان الصفحة)', textOf(ar, '#target-title') === 'Example video',
    'وُجد ' + JSON.stringify(textOf(ar, '#target-title')));

  const down = render(src, ['ar'], { down: true });
  await sleep(30);
  report('مسار الانقطاع: بطاقة التشخيص تُعرض بنصّها العربي',
    textOf(down, '#status-title') === I18N.ar['status.disconnected'] &&
    !down.document.querySelector('#card-offline').classList.contains('hidden'),
    'وُجد ' + JSON.stringify(textOf(down, '#status-title')));

  report('لغة غير مدعومة (fr-FR) ⇒ ltr/en (الافتراضي المعلَن)',
    fr.document.documentElement.dir === 'ltr' && fr.document.documentElement.lang === 'en',
    'وُجد ' + fr.document.documentElement.dir + '/' + fr.document.documentElement.lang);
  report('ترتيب المتصفّح محترَم ([fr, ar-EG]) ⇒ rtl/ar',
    frAr.document.documentElement.dir === 'rtl' && frAr.document.documentElement.lang === 'ar',
    'وُجد ' + frAr.document.documentElement.dir + '/' + frAr.document.documentElement.lang);
}

/* ── أدوات المُفسَدات: كلها في الذاكرة ───────────────────────────────────── */
function sub(src, re, repl) {
  if (!re.test(src)) throw new Error('النمط لا يطابق: ' + re);
  const out = src.replace(re, repl);
  if (out === src) throw new Error('الاستبدال لم يغيّر شيئاً: ' + re);
  return out;
}
const grab = (src, re, n) => {
  const m = re.exec(src);
  if (!m) throw new Error('الالتقاط فشل: ' + re);
  return m[n === undefined ? 1 : n];
};

async function main() {
  let checks = 0;
  const failures = [];
  const ok = (label, cond, detail) => {
    checks++;
    if (!cond) failures.push(detail ? label + ' — ' + detail : label);
    console.log('  ' + (cond ? '✓' : '✗') + ' ' + label);
  };

  console.log('=== قياس حيّ (jsdom) للنافذة المنبثقة: النصّ والاتجاه ===');
  await measure(SHIPPED, ok);

  console.log('\n=== مُفسَدات هذا القياس (في الذاكرة — لا ملف مؤقت) ===');
  const AR_SUB = grab(SHIPPED.js, /'header\.sub':\s*'([^']+)'/, 1);
  const CASES = [
    ['① `RTL` ثابت بدل الاشتقاق من اللغة ⇒ الإنجليزية يجب أن تسقط',
      { ...SHIPPED, js: sub(SHIPPED.js, /const RTL = LANG === 'ar';/, 'const RTL = true;') }, 'fall'],
    ['② `lang` ثابت `ar` ⇒ الإنجليزية يجب أن تسقط',
      { ...SHIPPED, js: sub(SHIPPED.js, /document\.documentElement\.lang = LANG;/, "document.documentElement.lang = 'ar';") }, 'fall'],
    ['③ مفتاح الربط في الصفحة أُفسد ⇒ العنصر يعرض `undefined`',
      { ...SHIPPED, html: sub(SHIPPED.html, /data-i18n="header\.sub"/, 'data-i18n="header.sub.typo"') }, 'fall'],
    ['④ الربط الثابت مقطوع (‏`applyI18n()` نُزع) ⇒ النصّ يجب أن يسقط',
      { ...SHIPPED, js: sub(SHIPPED.js, /\napplyI18n\(\);/, '\n') }, 'fall'],
    ['⑤ صفّ اللغة صار العربية دائماً ⇒ المستند الإنجليزي يجب أن يسقط',
      { ...SHIPPED, js: sub(SHIPPED.js, /const row = I18N\[LANG\] \|\| I18N\.ar;/, 'const row = I18N.ar;') }, 'fall'],
    ['ض١ تعليق HTML يحمل عربية — يجب ألّا يُسقط',
      { ...SHIPPED, html: sub(SHIPPED.html, /<body>/, (m) => m + '\n<!-- ' + AR_SUB + ' -->') }, 'pass'],
    ['ض٢ قيمة إنجليزية مُبدَّلة في الجدول (والصفحة تقرأ منه) — يجب ألّا يُسقط',
      { ...SHIPPED, js: sub(SHIPPED.js, /'footer\.install': '([^']+)'/, "'footer.install': 'Setup guide ⚙'") }, 'pass'],
  ];

  let caught = 0, survived = 0, passed = 0, badPass = 0, skipped = 0;
  const holes = [], regressions = [];
  for (const [label, src, want] of CASES) {
    let r = null;
    try { r = { checks: 0, failures: [] }; await measure(src, (l, c, d) => { r.checks++; if (!c) r.failures.push(d ? l + ' — ' + d : l); }); } catch (e) { r = null; }
    if (!r) { skipped++; console.log('  ⚠ لم يُطبَّق  ' + label); continue; }
    const fell = r.failures.length > 0;
    if (want === 'fall') {
      if (fell) { caught++; console.log('  ✅ سقط    ' + label.slice(0, 50).padEnd(50) + ' | ' + r.failures.length + ' ملاحظة'); console.log('       ↳ ' + r.failures[0].replace(/\s+/g, ' ').slice(0, 150)); }
      else { survived++; holes.push(label); console.log('  ❌ مرّ     ' + label.slice(0, 50).padEnd(50) + ' | ثقب'); }
    } else {
      if (!fell) { passed++; console.log('  ✅ مرّ     ' + label.slice(0, 50).padEnd(50) + ' | ' + r.checks + ' فحصاً'); }
      else { badPass++; regressions.push(label); console.log('  ❌ سقط     ' + label.slice(0, 50).padEnd(50) + ' | اصطياد كاذب'); }
    }
  }

  console.log('\n=== الأحكام ===');
  console.log('  القياس: ' + checks + ' فحصاً · ' + failures.length + ' فاشل');
  console.log('  المُفسَدات: أسقط ' + caught + ' · مرّ ضابطاً ' + passed + ' · ثقوب ' + survived +
    ' · اصطياد كاذب ' + badPass + ' · لم يُطبَّق ' + skipped);
  let bad = failures.length > 0;
  if (failures.length) for (const f of failures) console.error('✗ ' + f);
  if (skipped) { console.error('✗ ' + skipped + ' مُفسَداً لم يُطبَّق — قياس ناقص'); bad = true; }
  if (survived) { console.error('✗ ثقوب: مُفسَد مرّ من القياس'); holes.forEach((h) => console.error('   - ' + h)); bad = true; }
  if (badPass) { console.error('✗ اصطياد كاذب: ضابط سقط'); regressions.forEach((h) => console.error('   - ' + h)); bad = true; }
  if (checks === 0) { console.error('✗ صفر مدخل: لم يُنفَّذ فحص واحد'); bad = true; }
  if (bad) process.exit(1);
  console.log('✓ ' + checks + ' فحصاً ناجحاً / 0 فاشل، و' + caught + '/' + caught + ' مُفسَداً أسقط القياس — ' +
    'النصّ والاتجاه مقيسان في DOM حقيقي (‏jsdom) على الملفات المشحونة.');
  console.log('  **وتحميل الإضافة في متصفّح حقيقي غير مقيس** (كروم ١٥٣ لا يحترم --load-extension).');
}

main();
