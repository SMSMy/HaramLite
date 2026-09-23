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
 * **وم٦-ج: مسار خطأ `content.js` يُقاس في DOM حقيقي كذلك** (`measureContent`):
 * العطل المقيس كان أن **نصوص التطبيق** تصل عربية فتُعرض في واجهة إنجليزية. فالمقيس
 * هنا المسار المشحون نفسه: يُنفَّذ `content.js` المشحون في صفحة يوتيوب مصنوعة،
 * ويُنقر زرّ المعالجة (`#haramlite-yt-proc`)، ويُردّ على رسالة `link` بحمولة خطأ
 * تحمل `code` — ثم يُقرأ **نصّ التوست المعروض واتجاهه**:
 *   (أ) `code: duplicate_link` بواجهة إنجليزية ⇒ المعروض **إنجليزي** والاتجاه `ltr`
 *       (وبالعربية ⇒ العربي و`rtl`: التكافؤ).
 *   (ب) رمز **مجهول** ⇒ النصّ الخام كما هو (توافق خلفي)، والاتجاه يبقى اتجاه اللغة.
 * والنصّ الخام للرمز المعلوم **يُقرأ من `src-tauri/src/bridge.rs` نفسه** (نصّ
 * التطبيق المشحون لا نصّ مكتوب بيد)، وغيابه **يُسقط** القياس بصوت عالٍ.
 * **ومسار الاستطلاع** (`poll()` ← `st.last.error`) يُقاس حيّاً كذلك لأنه أحد
 * مسارَي العطل الأصلي: ردّ `link` بالنجاح ثم حالة جسر فاشلة تحمل `code`.
 * **وبطاقة الاكتمال في المنبثقة** (`popup.js:412`) تُقاس بتشغيل الدالّة المشحونة
 * `renderCompleted` على مستند جديد وقراءة البطاقة.
 * ومُفسَدات هذا القياس خمسة: فرع الرمز المعلوم محذوف · الرمز المجهول لم يعد يقع
 * على النصّ الخام · والاتجاه ثُبِّت `rtl` · **ومسار الاستطلاع يقرأ النصّ الخام**
 * (مُفسَد الجاسوس Ⓓ) · **وبطاقة الاكتمال تقرأ النصّ الخام** (مُفسَد الجاسوس Ⓖ).
 *
 * **وحدّ مُعلَن**: هذا قياس **DOM لا متصفّح**. لا يرسم خطوطاً، ولا يختبر CSP،
 * ولا `chrome.*` الحقيقية، ولا تحميل الإضافة، ولا `content.js` على يوتيوب حقيقي.
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
/* وقياس مسار خطأ المحتوى: مصدره المشحون + نصّ التطبيق الخام من الرست. */
const CONTENT = { js: fs.readFileSync(path.join(EXT, 'content.js'), 'utf8') };
const RUST_DUP_MSG = (() => {
  const src = fs.readFileSync(path.join(REPO, 'src-tauri', 'src', 'bridge.rs'), 'utf8');
  const m = /err_last\(E_DUPLICATE_LINK,\s*&url,\s*"([^"]+)"\)/.exec(src);
  return m ? m[1] : null;
})();
/* ونصّ فشل `result_file` الخام — من الرست المشحون لا مكتوباً بيد: هو ما يردّه التطبيق
 * حين لا يكون في `state.last` صوت صفحة مكتمل (`serve_page_audio_slice`)، وهو أرض
 * العطل الذي كان يُعرض «رد فارغ من التطبيق» بدل سببه (بلاغ المالك 2026-09-23). */
const RUST_NO_PAGE_AUDIO_MSG = (() => {
  const src = fs.readFileSync(path.join(REPO, 'src-tauri', 'src', 'bridge.rs'), 'utf8');
  const m = /ok_or_else\(\|\|\s*"([^"]+)"\.to_string\(\)\)/.exec(src);
  return m ? m[1] : null;
})();
/** رمز لا يعرفه هذا الإصدار من الإضافة — يحاكي تطبيقاً أحدث منها. */
const UNKNOWN_CODE = 'a_code_from_a_newer_app';
/* **صفحة يوتيوب** (بالمحدِّد التاريخي) و**صفحة يوتيوب-ميوزيك**: الثانية بلا
 * `.ytp-right-controls` إطلاقاً — وهذا **مقيس حيّاً** على صفحة
 * `music.youtube.com/watch?v=…` حقيقية في كروم 153 (`querySelectorAll
 * ('.ytp-right-controls').length === 0`)، والحاضن فيها `ytmusic-player-bar`
 * وداخله `.right-controls`. والصفحتان مصنوعتان في jsdom لتُقاس **بنية الحقن**
 * في كل أصل؛ والقياس الحيّ يبقى هو الأصل (‏ARCHIVE/x1-*.mjs). */
const CONTENT_PAGE = '<!doctype html><html><body><div id="movie_player">' +
  '<video></video><div class="ytp-right-controls"></div></div></body></html>';
const CONTENT_PAGE_YTMUSIC = '<!doctype html><html><body><div id="movie_player"><video></video></div>' +
  '<ytmusic-player-bar><div class="left-controls"></div><div class="middle-controls"></div>' +
  '<div class="right-controls"></div></ytmusic-player-bar></body></html>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** شيم `chrome.storage.local` — **بمفاتيح حقيقية لا فراغ**: يُقاس به أن التفضيل
 *  المخزَّن (`hl.lang` · `hl.popup.mode`) يُقرأ فعلاً عند الإقلاع، وأن الكتابة
 *  تقع بالمفتاح الصحيح. والقراءة **تزامنية** كما ينصّ العقد المُعلَن في الشيمين
 *  (‏`content.js`/`popup.js` كلاهما بأسلوب النداء الراجع)، فيبقى القياس الحيّ
 *  لترتيب الربط الثابت صالحاً كما كان. */
function storageShim(store, writes, listeners) {
  return {
    local: {
      get: (keys, cb) => {
        const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
        const out = {};
        for (const k of list) if (k in store) out[k] = store[k];
        if (typeof cb === 'function') cb(out);
      },
      set: (obj, cb) => {
        Object.assign(store, obj);
        writes.push(Object.assign({}, obj));
        if (typeof cb === 'function') cb();
      },
    },
    /* **والمستمعون يُسجَّلون فعلاً** (لا `() => {}`): يلزم لقياس «الصفحة تتبع تبديل
     * النافذة حيّاً» — وهو ما يقيس عطل `repaintBar` (نصّ جديد واتجاه قديم). */
    onChanged: { addListener: (fn) => { if (typeof fn === 'function') listeners.push(fn); } },
  };
}
const textOf = (w, sel) => { const n = w.document.querySelector(sel); return n ? n.textContent : null; };

/* **نوافذ jsdom تُغلَق في النهاية** — عيب أداة قِيس على هذه الجولة نفسها:
 * بند x1 يضاعف عدد النوافذ (‏~20 قياساً لكل مُفسَد × 22 تشغيلاً)، وكل نافذة
 * يُشغَّل فيها `content.js` تترك `setInterval` إعادة الحقن حيّاً (حتى ١٢٠ محاولة)
 * ⇒ انتهى القياس وطبع حكمه، **والعملية لم تنتهِ**: `pnpm ext:i18n:live` يتعلّق
 * فلا يصلح بوّابة. والعلاج مركزيّ: كل نافذة تُنشأ تُسجَّل هنا وتُغلق قبل الحكم. */
const OPEN_WINDOWS = [];
function closeAllWindows() {
  let n = 0;
  for (const w of OPEN_WINDOWS) { try { w.close(); n++; } catch (e) { /* أُغلقت */ } }
  OPEN_WINDOWS.length = 0;
  return n;
}

/** الجدول يُستخرج من الملف المشحون نفسه — فلا نصّ متوقَّع مكتوب بيد. */
function parseTable(jsSrc) {
  const t = findTable(jsSrc);
  return t ? new Function(t.literal + '\nreturn I18N;')() : null;
}

/** يُنشئ الصفحة بواجهة `chrome` مصنوعة و`navigator.languages` مطلوبة، ثم يُنفّذ
 *  `popup.js` داخلها. `opts.down` = الجسر لا يردّ فيُقاس مسار الانقطاع. */
function render(src, languages, opts) {
  const down = !!(opts && opts.down);
  const store = Object.assign({}, (opts && opts.store) || {});
  const writes = [];
  const listeners = [];
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
    storage: storageShim(store, writes, listeners),
    tabs: {
      query: (_q, cb) => cb([{ id: 1, url: 'https://www.youtube.com/watch?v=abc', title: 'Example video' }]),
      sendMessage: (_id, _m, cb) => cb({ ok: true }),
    },
  };
  w.__store = store;
  w.__storeWrites = writes;
  w.eval(src.js);
  OPEN_WINDOWS.push(w);
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
    textOf(ar, '.version-tag') === 'v' + src.version, 'وُجد ' + JSON.stringify(textOf(ar, '.version-tag')));

  /* **بطاقة الاكتمال** (`popup.js:412` — `last.error`): ثالث مسار عرض لم يكن
   * يحرسه شيء (مُفسَد الجاسوس Ⓖ مرّ على الحارسين). فتُنادى الدالّة **المشحونة**
   * `renderCompleted` مباشرةً على مستند جديد، وتُقرأ البطاقة — بلا مؤقّتات،
   * فالمقيس هو الدالّة والجدول والاتجاه في DOM حقيقي. */
  const expectFailed = (lang, e) => String(I18N[lang]['done.failed']).replace('{e}', e);
  const cardEn = render(src, ['en-US', 'ar']);
  const cardAr = render(src, ['ar-SA', 'en']);
  cardEn.renderCompleted({ ok: false, error: RUST_DUP_MSG, code: 'duplicate_link' }, null);
  const cardEnKnown = textOf(cardEn, '#completed-text');
  report('بطاقة الاكتمال (en): رمز معلوم ⇒ نصّ الجدول بلغته لا النصّ الخام',
    cardEnKnown === expectFailed('en', I18N.en['code.duplicate_link']), 'وُجد ' + JSON.stringify(cardEnKnown));
  report('والبطاقة الإنجليزية بصفر محرف عربي',
    ![...String(cardEnKnown)].some((c) => AR.test(c)), 'وُجد ' +
    [...String(cardEnKnown)].filter((c) => AR.test(c)).length + ' محرفاً');
  cardEn.renderCompleted({ ok: false, error: RUST_DUP_MSG, code: UNKNOWN_CODE }, null);
  report('بطاقة الاكتمال (en): رمز مجهول ⇒ النصّ الخام كما هو (توافق خلفي)',
    textOf(cardEn, '#completed-text') === expectFailed('en', RUST_DUP_MSG),
    'وُجد ' + JSON.stringify(textOf(cardEn, '#completed-text')));
  cardAr.renderCompleted({ ok: false, error: RUST_DUP_MSG, code: 'duplicate_link' }, null);
  report('بطاقة الاكتمال (ar): رمز معلوم ⇒ نصّ الجدول العربي (تكافؤ)',
    textOf(cardAr, '#completed-text') === expectFailed('ar', I18N.ar['code.duplicate_link']),
    'وُجد ' + JSON.stringify(textOf(cardAr, '#completed-text')));

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

/* ── أدوات المُفسَدات: كلها في الذاكرة ───────────────────────────────────── */function sub(src, re, repl) {
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

/* ══ م٦-ج: قياس مسار خطأ `content.js` في DOM حقيقي ═════════════════════════
 * صفحة يوتيوب مصنوعة + واجهة `chrome` مصنوعة ⇒ يُنفَّذ `content.js` المشحون،
 * ويُشتقّ الزرّ (بحدث `yt-navigate-finish` كما في يوتيوب)، ثم يُنقر فيُرسل
 * `{type:'link'}` ويُردّ بحمولة خطأ تحمل `code` — ويُقرأ نصّ التوست واتجاهه. */
function renderContent(jsSrc, languages, replyFn, opts) {
  const store = Object.assign({}, (opts && opts.store) || {});
  const writes = [];
  const listeners = [];
  const page = (opts && opts.page) || CONTENT_PAGE;
  const sent = [];
  const dom = new JSDOM(page, { url: 'https://www.youtube.com/watch?v=abc', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(w.navigator, 'language', { value: languages[0] || 'en', configurable: true });
  w.chrome = {
    runtime: {
      lastError: null,
      // كل ردّ هو ردّ الجسر: `{ok:true, resp:<الحمولة>}` كما يمرّ عبر background.js.
      // والردّ **دالّة على الرسالة** فتُقاس مسارات مختلفة (الإرسال · الاستطلاع) في نافذة واحدة.
      sendMessage: (msg, cb) => {
        sent.push((msg && msg.message) || msg || {});
        if (cb) setTimeout(() => cb({ ok: true, resp: replyFn(msg) }), 0);
      },
      onMessage: { addListener: () => {} },
    },
    storage: storageShim(store, writes, listeners),
  };
  /* ── محاكاة Trusted Types (يوتيوب يفرضها) ────────────────────────────────────
   * **العطل الميداني المقيس**: في كروم 153 على يوتيوب حقيقي، `menu.innerHTML = …`
   * يرمي `TypeError: … This document requires 'TrustedHTML' assignment.` ⇒ القوائم
   * المنبثقة من الصفحة لم تكن تُفتح إطلاقاً. **ولم يرَ ذلك أيّ حارس jsdom** لأن
   * jsdom لا يفرض السياسة. فهذه المحاكاة تُقارب الشرط الحقيقي: أي إسناد `innerHTML`
   * يرمي بنصّ الخطأ نفسه المُلتقَط حيّاً ⇒ صفوف «القائمة تُفتح» تسقط على الانحراف.
   * (والمحاكاة **مُعلَنة**: ليست فرضاً كاملاً للسياسة — لا `TrustedHTML` ولا CSP.) */
  try {
    const proto = w.Element.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
    if (d && d.set) {
      Object.defineProperty(proto, 'innerHTML', {
        configurable: true,
        get: d.get,
        set() {
          throw new w.TypeError("Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment.");
        },
      });
    }
  } catch (e) { /* بلا محاكاة — تبقى الفحوص البنيوية وحدها */ }
  w.__sent = sent;
  w.__fireStorage = (changes) => { for (const fn of listeners) { try { fn(changes); } catch (e) { /* مستمع رمى */ } } };
  w.__store = store;
  w.__storeWrites = writes;
  w.eval(jsSrc);
  OPEN_WINDOWS.push(w);
  return w;
}

/** ينقر زرّ المعالجة ويردّ بحمولة خطأ، ثم يُعيد [نصّ التوست، اتجاهه]. */
async function contentError(jsSrc, languages, reply) {
  let w = null;
  try { w = renderContent(jsSrc, languages, () => reply); } catch (e) { return { why: 'تنفيذ content.js رمى: ' + (e && e.message ? e.message : e) }; }
  w.dispatchEvent(new w.Event('yt-navigate-finish'));   // مسار الحقن الحقيقي في SPA
  await sleep(320);
  const btn = w.document.getElementById('haramlite-yt-proc');
  if (!btn) return { why: 'الزرّ لم يُحقن (#haramlite-yt-proc غائب)' };
  btn.click();
  await sleep(120);
  const el = w.document.getElementById('haramlite-toast');
  if (!el) return { why: 'التوست لم يظهر' };
  return { text: el.textContent, dir: el.style.direction };
}

/* **مسار الاستطلاع** (`poll()` — `content.js:513`): هذا هو المسار الذي قِيس عليه
 * العطل الأصلي (`ARCHIVE/m6j-brief.md` §١ يسمّي `st.last.error`)، وكان **بلا حارس**
 * حتى مُفسَد الجاسوس Ⓓ. فيُقاس حيّاً هنا: ردّ `link` بالنجاح فيبدأ الاستطلاع،
 * ثم تُردّ حالة جسر فاشلة تحمل `code` — ويُقرأ نصّ التوست واتجاهه بعد دورة
 * الاستطلاع (1500ms). و`last.url` هو رابط الصفحة نفسه ليطابق `sameVideo`. */
async function contentPollError(jsSrc, languages, last) {
  const videoUrl = 'https://www.youtube.com/watch?v=abc';
  // الردّ يُبنى من **الرسالة الداخلية**: `content.js` يُغلّفها
  // `{type:'native', message:{type:'link'|'status'|…}}` كما يفعل مع العامل.
  const replyFor = (env) => {
    const message = (env && env.message) || env || {};
    const type = message.type;
    if (type === 'link') return { ok: true };
    if (type === 'status') return { state: { running: null, last } };
    return {};
  };
  let w = null;
  try { w = renderContent(jsSrc, languages, replyFor); } catch (e) { return { why: 'تنفيذ content.js رمى: ' + (e && e.message ? e.message : e) }; }
  w.dispatchEvent(new w.Event('yt-navigate-finish'));
  await sleep(320);
  const btn = w.document.getElementById('haramlite-yt-proc');
  if (!btn) return { why: 'الزرّ لم يُحقن (#haramlite-yt-proc غائب)' };
  btn.click();
  await sleep(1750);                                   // دورة الاستطلاع 1500ms
  const el = w.document.getElementById('haramlite-toast');
  if (!el) return { why: 'توست الاستطلاع لم يظهر' };
  return { text: el.textContent, dir: el.style.direction, url: videoUrl };
}

/** القياس كاملاً على مصدر `content.js` مُمرَّر (فالمُفسَدات في الذاكرة). */
async function measureContent(src, report) {
  const I18N = parseTable(src.js);
  if (!I18N) { report('جدول الترجمة في content.js مقروء', false, 'لا `const I18N = {`'); return; }
  /* صفر مدخل: النصّ الخام يأتي من الرست المشحون — لو غاب فالمقيس نصٌّ مكتوب بيد. */
  report('صفر مدخل: نصّ التطبيق الخام (`duplicate_link`) مقروء من bridge.rs',
    typeof RUST_DUP_MSG === 'string' && RUST_DUP_MSG.length > 0,
    'لم أقرأ نصّ `err_last(E_DUPLICATE_LINK, …)` من bridge.rs');
  if (typeof RUST_DUP_MSG !== 'string' || !RUST_DUP_MSG) return;

  const both = [
    { lang: 'en', langs: ['en-US', 'ar'], dir: 'ltr' },
    { lang: 'ar', langs: ['ar-SA', 'en'], dir: 'rtl' },
  ];
  for (const L of both) {
    /* (أ) رمز معلوم ⇒ نصّ الجدول بلغته، والاتجاه اتجاه اللغة. */
    const known = await contentError(src.js, L.langs, { ok: false, error: RUST_DUP_MSG, code: 'duplicate_link' });
    const want = I18N[L.lang] ? I18N[L.lang]['code.duplicate_link'] : null;
    if (!known.text) {
      report(`[${L.lang}] صفر مدخل: الزرّ حُقن والتوست ظهر (رمز معلوم)`, false, known.why);
    } else {
      report(`[${L.lang}] رمز معلوم (\`duplicate_link\`) ⇒ نصّ الجدول بلغته، لا النصّ العربي الخام`,
        typeof want === 'string' && known.text === '✗ ' + want, 'وُجد ' + JSON.stringify(known.text));
      report(`[${L.lang}] والاتجاه اتجاه اللغة (${L.dir}) لا اتجاه النصّ`,
        known.dir === L.dir, 'وُجد ' + JSON.stringify(known.dir));
      if (L.lang === 'en') {
        const arChars = [...known.text].filter((c) => AR.test(c)).length;
        report('والمعروض في الواجهة الإنجليزية بصفر محرف عربي', arChars === 0, 'وُجد ' + arChars + ' محرفاً');
      }
    }
    /* (ب) رمز مجهول ⇒ النصّ الخام كما هو (توافق خلفي)، والاتجاه يتبع اللغة. */
    const unknown = await contentError(src.js, L.langs, { ok: false, error: RUST_DUP_MSG, code: UNKNOWN_CODE });
    if (!unknown.text) {
      report(`[${L.lang}] صفر مدخل: الزرّ حُقن والتوست ظهر (رمز مجهول)`, false, unknown.why);
    } else {
      report(`[${L.lang}] رمز مجهول ⇒ النصّ الخام كما هو (توافق خلفي: تطبيق أحدث من الإضافة)`,
        unknown.text === '✗ ' + RUST_DUP_MSG, 'وُجد ' + JSON.stringify(unknown.text));
      report(`[${L.lang}] والاتجاه يبقى اتجاه اللغة (${L.dir}) ولو كان النصّ عربياً`,
        unknown.dir === L.dir, 'وُجد ' + JSON.stringify(unknown.dir));
    }
    /* (ج) ولا `code` أصلاً (تطبيق أقدم من الإضافة) ⇒ النصّ الخام كما هو: هذا هو
       الصفّ 4.12 في `qa/TEST-MATRIX.md`، ويُقاس هنا في مساره البرمجي نفسه. */
    const legacy = await contentError(src.js, L.langs, { ok: false, error: RUST_DUP_MSG });
    if (!legacy.text) {
      report(`[${L.lang}] صفر مدخل: الزرّ حُقن والتوست ظهر (بلا code)`, false, legacy.why);
    } else {
      report(`[${L.lang}] ولا \`code\` أصلاً (تطبيق أقدم) ⇒ النصّ الخام كما هو`,
        legacy.text === '✗ ' + RUST_DUP_MSG, 'وُجد ' + JSON.stringify(legacy.text));
    }
  }

  /* (د) **مسار الاستطلاع** (`poll()` — `content.js:513`، وهو أحد مسارَي العطل
     الأصلي): حالة جسر فاشلة تحمل `code` ⇒ التوست يعرض الترجمة، والاتجاه اتجاه
     اللغة. و`url` هو رابط الصفحة نفسه ليطابق `sameVideo` فيُقبل `last`. */
  const pollEn = await contentPollError(src.js, ['en-US', 'ar'], {
    ok: false, url: 'https://www.youtube.com/watch?v=abc', error: RUST_DUP_MSG, code: 'duplicate_link',
  });
  if (!pollEn.text) {
    report('[en] صفر مدخل: زرّ الاستطلاع نُقر والتوست ظهر', false, pollEn.why);
  } else {
    report('[en] الاستطلاع (`st.last` فاشل برمز) ⇒ نصّ الجدول بلغته لا النصّ الخام',
      pollEn.text === '✗ ' + I18N.en['code.duplicate_link'], 'وُجد ' + JSON.stringify(pollEn.text));
    report('[en] واتجاه توست الاستطلاع اتجاه اللغة (ltr) ولو كان النصّ الخام عربياً',
      pollEn.dir === 'ltr', 'وُجد ' + JSON.stringify(pollEn.dir));
  }
}

/* ══ x1-ext: بندا ٣ و٤ في DOM حقيقي ══════════════════════════════════════════
 * يُقاس هنا ما لم يكن مقيساً أصلاً:
 *   (أ) **زرّ الوضع** يُحقن في **الأصلين**: صفحة يوتيوب (‏`.ytp-right-controls`) وصفحة
 *       يوتيوب-ميوزيك (‏`ytmusic-player-bar > .right-controls`، وبلا
 *       `.ytp-right-controls` إطلاقاً) — والثانية هي عطل المالك المقيس: لم يكن
 *       يُحقن فيها زرّ أصلاً.
 *   (ب) **اختيار الوضع** من الصفحة: نقرة الوضع تفتح القائمة، والنقر على مدخل يرسل
 *       `mode` المختار في حمولة الطلب — ولا يُرسل `'watch'` بعد اليوم (الوضع صار
 *       اختيار المستخدم كما يرسله المنبثق).
 *   (ج) **فشل `result_file` المسمّى** (`{ok:false, code:'engine_error'}`) يُعرض
 *       بترجمته لا بـ«رد فارغ من التطبيق» — وهو نصّ بلاغ المالك؛ ويبقى `emptyReply`
 *       لغياب الردّ فعلاً (لا `file` أصلاً).
 *   (د) **مبدّل اللغة**: الافتراضيّ لغة المتصفّح (كما كان)، والتفضيل المخزَّن يغلبها،
 *       والنقر يبدّل الواجهة كلها ويحفظ بالمفتاح `hl.lang`.
 */
const REPLY_START = (msg) => {
  const m = (msg && msg.message) || msg || {};
  if (m.type === 'link') return { ok: true };
  if (m.type === 'status') return { state: { running: null, last: null } };
  return {};
};
const PAGE_OF = (which) => (which === 'music' ? CONTENT_PAGE_YTMUSIC : CONTENT_PAGE);
const HOST_OF = (which) => (which === 'music' ? 'ytmusic-player-bar .right-controls' : '.ytp-right-controls');
const LAST_READY = { ok: true, url: 'https://www.youtube.com/watch?v=abc', seconds: 3, kept: null };

/** ينقر زرّ الوضع ثم مدخل الوضع المطلوب، ويُعيد ما أُرسل من طلبات + نصّ الزرّ. */
async function contentModePick(jsSrc, languages, which, entry) {
  let w = null;
  try { w = renderContent(jsSrc, languages, REPLY_START, { page: PAGE_OF(which) }); } catch (e) { return { why: 'تنفيذ content.js رمى: ' + (e && e.message ? e.message : e) }; }
  w.dispatchEvent(new w.Event('yt-navigate-finish'));
  await sleep(320);
  const host = w.document.querySelector(HOST_OF(which));
  const btn = w.document.getElementById('haramlite-yt-mode');
  const out = {
    hostFound: !!host,
    inHost: !!(host && host.querySelector('#haramlite-yt-proc') && host.querySelector('#haramlite-yt-mode') && host.querySelector('#haramlite-yt-watch')),
    alsoNoLegacyHost: which === 'music' ? !w.document.querySelector('.ytp-right-controls') : true,
    modeText: textOf(w, '#haramlite-yt-mode'),
  };
  if (!btn) { out.why = 'زرّ الوضع غير مُحقَن (#haramlite-yt-mode)'; return out; }
  // «صفر مدخل» قبل النقر: لا مدخلَ وضع في الصفحة قبل أن تُفتح القائمة — وإلا فالمقيس
  // ليس فتحَ القائمة بل وجودَ عنصر دائم.
  out.entriesBefore = !!(w.document.getElementById('hl-ext-mode-song') || w.document.getElementById('hl-ext-mode-clip'));
  btn.click();
  await sleep(20);
  out.menuOpen = !!w.document.getElementById('hl-ext-mode-song') && !!w.document.getElementById('hl-ext-mode-clip');
  const item = w.document.getElementById(entry === 'song' ? 'hl-ext-mode-song' : 'hl-ext-mode-clip');
  if (!item) { out.why = 'مدخل الوضع غير موجود في القائمة'; return out; }
  item.click();
  await sleep(120);
  out.sentModes = w.__sent.filter((m) => m && m.type === 'link').map((m) => m.mode);
  out.payloads = w.__sent.filter((m) => m && m.type === 'link');
  out.persisted = w.__store['hl.popup.mode'] || null;
  return out;
}

/** يقود **زرّ المعالجة/المشاهدة** (`makeProcBtn`) ويُعيد حمولة الطلب — العقد الذي
 *  يعيد المسار المؤقّت (`watch:true` بلا `mode`، قرار المالك 2026-09-23). */
async function contentWatchStart(jsSrc, languages) {
  let w = null;
  try { w = renderContent(jsSrc, languages, REPLY_START); } catch (e) { return { why: 'تنفيذ content.js رمى: ' + (e && e.message ? e.message : e) }; }
  w.dispatchEvent(new w.Event('yt-navigate-finish'));
  await sleep(320);
  const btn = w.document.getElementById('haramlite-yt-proc');
  if (!btn) return { why: 'زرّ المعالجة غير مُحقَن' };
  btn.click();
  await sleep(150);
  const links = w.__sent.filter((m) => m && m.type === 'link');
  if (!links.length) return { why: 'لا طلب أُرسل' };
  return { payload: links[0], count: links.length };
}

/** يقود «معالجة كاملة» من **قائمة النقر الأيمن** ويُعيد حمولة الطلب. */
async function contentReprocess(jsSrc, languages) {
  let w = null;
  try { w = renderContent(jsSrc, languages, REPLY_START); } catch (e) { return { why: 'تنفيذ content.js رمى: ' + (e && e.message ? e.message : e) }; }
  w.dispatchEvent(new w.Event('yt-navigate-finish'));
  await sleep(320);
  const watch = w.document.getElementById('haramlite-yt-watch');
  if (!watch) return { why: 'زرّ المشاهدة غير مُحقَن' };
  watch.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await sleep(40);
  const entry = w.document.getElementById('hl-ext-reprocess');
  if (!entry) return { why: 'مدخل «معالجة كاملة» لم يظهر' };
  entry.click();
  await sleep(150);
  const links = w.__sent.filter((m) => m && m.type === 'link');
  if (!links.length) return { why: 'لا طلب أُرسل' };
  return { payload: links[0] };
}

/** يقود مسار جلب الصوت: يردّ `status` بمهمّة ناجحة ثم يردّ `result_file` بالردّ المُمرَّر. */
async function contentFetchReply(jsSrc, languages, resultReply) {
  const replyFor = (env) => {
    const m = (env && env.message) || env || {};
    if (m.type === 'link') return { ok: true };
    if (m.type === 'status') return { state: { running: null, last: LAST_READY } };
    if (m.type === 'result_file') return resultReply;
    return {};
  };
  let w = null;
  try { w = renderContent(jsSrc, languages, replyFor); } catch (e) { return { why: 'تنفيذ content.js رمى: ' + (e && e.message ? e.message : e) }; }
  w.dispatchEvent(new w.Event('yt-navigate-finish'));
  await sleep(320);
  const watch = w.document.getElementById('haramlite-yt-watch');
  if (!watch) return { why: 'زرّ المشاهدة غير مُحقَن' };
  if (watch.disabled) return { why: 'زرّ المشاهدة معطَّل — حالة `last` لم تُقبل' };
  watch.click();
  await sleep(200);
  const el = w.document.getElementById('haramlite-toast');
  return { text: el ? el.textContent : null, dir: el ? el.style.direction : null };
}

const attrOf = (w, sel, at) => { const n = w.document.querySelector(sel); return n ? n.getAttribute(at) : null; };

/** قياس مبدّل اللغة: يُنشئ النافذة بتفضيل مخزَّن ولغة متصفّح مُمرَّرين. */
function popupLang(src, languages, store) {
  const w = render(src, languages, { store: store || {} });
  return {
    w,
    dir: w.document.documentElement.dir,
    lang: w.document.documentElement.lang,
    arPressed: attrOf(w, '#lang-ar', 'aria-pressed'),
    enPressed: attrOf(w, '#lang-en', 'aria-pressed'),
    headerSub: textOf(w, '[data-i18n="header.sub"]'),
    sendLabel: textOf(w, '[data-i18n="send.button"]'),
  };
}

/** يقود **قائمة النقر الأيمن** (‏`toggleWatchMenu`) — القائمة التي كانت **لا تُفتح
 *  إطلاقاً** على يوتيوب الحقيقي قبل إصلاح Trusted Types، ولم يكن يقيسها أيّ حارس:
 *  فمُفسَدا الثقبين (㉓ `menu['innerHTML']` · ㉔ `menu.setHTMLUnsafe`) يمرّان بلا أن
 *  يلمسهما القياس إن لم تُفتح هذه القائمة صراحةً. */
async function contentWatchMenu(jsSrc, languages) {
  let w = null;
  try { w = renderContent(jsSrc, languages, REPLY_START); } catch (e) { return { why: 'تنفيذ content.js رمى: ' + (e && e.message ? e.message : e) }; }
  w.dispatchEvent(new w.Event('yt-navigate-finish'));
  await sleep(320);
  const watch = w.document.getElementById('haramlite-yt-watch');
  if (!watch) return { why: 'زرّ المشاهدة غير مُحقَن' };
  const before = !!w.document.getElementById('hl-ext-reprocess');
  watch.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await sleep(40);
  const entry = w.document.getElementById('hl-ext-reprocess');
  return {
    before,
    open: !!entry,
    text: entry ? entry.textContent : null,
    dir: entry && entry.parentElement ? entry.parentElement.style.direction : null,
  };
}

/** القياس كاملاً لبندَي x1 (٣ و٤). و`src` = `{ content, popup, html }` — **مصدران
 *  منفصلان**: مُفسَدات بند ٣ تُطبَّق على `content` وحدها ومُفسَدات بند ٤ على `popup`
 *  وحدها، فلا يُقيَّم نصّ Popup في صفحة المشغّل ولا العكس. */
async function measureX1(src, report) {
  const contentJs = src.content;
  const I18N = parseTable(contentJs);
  const popupTable = parseTable(src.popup.js);
  const popupHtml = src.popup.html;
  report('صفر مدخل: جدولا الترجمة مقروءان (content.js · popup.js)',
    !!I18N && !!popupTable, 'جدول مفقود');
  if (!I18N || !popupTable) return;
  report('صفر مدخل: نصّ فشل `result_file` الخام مقروء من bridge.rs',
    typeof RUST_NO_PAGE_AUDIO_MSG === 'string' && RUST_NO_PAGE_AUDIO_MSG.length > 0,
    'لم أقرأ `"لا يوجد صوت صفحة مكتمل بعد"` من `serve_page_audio_slice`');

  /* (أ) و(ب) زرّ الوضع والاختيار — على الأصلين. */
  for (const which of ['youtube', 'music']) {
    for (const entry of ['song', 'clip']) {
      const r = await contentModePick(contentJs, ['en-US', 'ar'], which, entry);
      const tag = `[${which}/${entry}]`;
      if (!r.hostFound) { report(`${tag} صفر مدخل: الحضن يقع في ${HOST_OF(which)}`, false, r.why || 'الحاضن مفقود أو الزرّ لم يُحقن'); continue; }
      report(`${tag} الأزرار الثلاثة مُدرَجة داخل ${HOST_OF(which)}`, r.inHost === true,
        r.why || ('inHost=' + r.inHost));
      if (which === 'music') {
        report(`${tag} وصفحة يوتيوب-ميوزيك بلا \`.ytp-right-controls\` إطلاقاً (وإلا فالمقيس ليس موضع العطل)`,
          r.alsoNoLegacyHost === true, 'وُجد المحدِّد التاريخي في الصفحة');
      }
      if (!r.sentModes) { report(`${tag} نقرة الوضع أرسلت طلباً`, false, r.why || 'لا طلب'); continue; }
      report(`${tag} القائمة **تُفتح** بنقرة زرّ الوضع ولم تكن مفتوحة قبلها`,
        r.menuOpen === true && r.entriesBefore === false,
        'قبل=' + r.entriesBefore + ' بعد=' + r.menuOpen);
      report(`${tag} والوضع المُرسل في الحمولة \`${entry}\``, r.sentModes[0] === entry,
        'وُجد ' + JSON.stringify(r.sentModes));
      report(`${tag} ولا يُرسل \`watch\` كوضع (الوضع صار اختيار المستخدم)`, !r.sentModes.includes('watch'),
        'وُجد ' + JSON.stringify(r.sentModes));
      report(`${tag} والاختيار يُحفظ في \`hl.popup.mode\``, r.persisted === entry, 'وُجد ' + JSON.stringify(r.persisted));
    }
  }
  /* نصّ زرّ الوضع يعكس الوضع المخزَّن (لا نصّ ثابت). */
  {
    const song = await contentModePick(contentJs, ['en-US'], 'youtube', 'clip');
    const stored = await (async () => {
      let w = null;
      try { w = renderContent(contentJs, ['en-US'], REPLY_START, { store: { 'hl.popup.mode': 'song' } }); } catch (e) { return null; }
      w.dispatchEvent(new w.Event('yt-navigate-finish'));
      await sleep(320);
      return textOf(w, '#haramlite-yt-mode');
    })();
    report('نصّ زرّ الوضع بالمخزَّن (`song`) يخالف نصّه بالافتراضيّ (`clip`)',
      !!song.modeText && !!stored && song.modeText !== stored,
      'clip=' + JSON.stringify(song.modeText) + ' · stored=' + JSON.stringify(stored));
    report('ونصّه هو مدخل الجدول بلغته (`btn.mode.song`)',
      stored === I18N.en['btn.mode.song'], 'وُجد ' + JSON.stringify(stored));
  }

  /* (ج) فشل `result_file` المسمّى + غياب الردّ فعلاً. */
  const failEn = await contentFetchReply(contentJs, ['en-US', 'ar'], { ok: false, code: 'engine_error', error: RUST_NO_PAGE_AUDIO_MSG });
  const wantEngine = '✗ ' + I18N.en['code.engine_error'].replace('{e}', RUST_NO_PAGE_AUDIO_MSG);
  if (!failEn.text) {
    report('[en] صفر مدخل: زرّ المشاهدة نُقر وردّ `result_file` فاشلاً فظهر توست', false, failEn.why);
  } else {
    report('[en] فشل `result_file` المسمّى (`engine_error`) ⇒ نصّ الرمز المترجَم لا «رد فارغ»',
      failEn.text === wantEngine, 'وُجد ' + JSON.stringify(failEn.text));
    report('[en] ولا يظهر نصّ `fetch.emptyReply` على ردٍّ مسمّى',
      failEn.text !== '✗ ' + I18N.en['fetch.emptyReply'], 'ظهر «رد فارغ» على ردّ يحمل رمزاً');
  }
  const emptyEn = await contentFetchReply(contentJs, ['en-US', 'ar'], {});
  report('[en] وغياب الردّ فعلاً (لا `file` أصلاً) ⇒ `fetch.emptyReply` كما كان',
    emptyEn.text === '✗ ' + I18N.en['fetch.emptyReply'], 'وُجد ' + JSON.stringify(emptyEn.text));

  /* (ج٢) **قائمة النقر الأيمن** تُفتح فعلاً — الصفّ الذي يمسك ثقبَي Trusted Types
     (‏`menu['innerHTML']` و`menu.setHTMLUnsafe`) سلوكياً، لا بنمط نصّي وحده. */
  for (const L of [{ lang: 'en', langs: ['en-US', 'ar'] }, { lang: 'ar', langs: ['ar-SA', 'en'] }]) {
    const wm = await contentWatchMenu(contentJs, L.langs);
    if (!wm.open) {
      report(`[watchmenu/${L.lang}] صفر مدخل: النقر الأيمن على زرّ المشاهدة يفتح القائمة`, false, wm.why || 'القائمة لم تُفتح');
    } else {
      report(`[watchmenu/${L.lang}] القائمة **تُفتح** ويظهر مدخلها «معالجة كاملة» ولم تكن مفتوحة قبلها`,
        wm.before === false && wm.text === I18N[L.lang]['menu.reprocess'],
        'before=' + wm.before + ' text=' + JSON.stringify(wm.text));
      report(`[watchmenu/${L.lang}] واتجاه القائمة اتجاه اللغة (${L.lang === 'ar' ? 'rtl' : 'ltr'})`,
        wm.dir === (L.lang === 'ar' ? 'rtl' : 'ltr'), 'وُجد ' + JSON.stringify(wm.dir));
    }
  }

  /* (ز) **عقدا المدخلين** (قرار المالك 2026-09-23): المشاهدة بعلمها بلا `mode`،
     والحفظ باختيار الوضع بلا علم مشاهدة — وهو ما يعيد المسار المؤقّت (`page-audio`)
     فلا تتراكم ملفات في `~/Videos/HaramLite` من زرّ المشاهدة. */
  {
    const ws = await contentWatchStart(contentJs, ['en-US', 'ar']);
    if (!ws.payload) {
      report('[watch] صفر مدخل: زرّ المعالجة/المشاهدة أرسل طلباً', false, ws.why || 'لا طلب');
    } else {
      report('[watch] يرسل `watch:true` — فيأخذ التطبيق المسار المؤقّت (`page_audio_dir`)',
        ws.payload.watch === true, 'الحمولة=' + JSON.stringify(ws.payload));
      report('[watch] و**بلا `mode`** (العلم منفصل عن الوضع، والعقد القديم `mode:"watch"` لا يعود)',
        !('mode' in ws.payload), 'الحمولة=' + JSON.stringify(ws.payload));
      report('[watch] وطلب واحد لا أكثر من نقرة واحدة', ws.count === 1, 'عدد الطلبات=' + ws.count);
    }
    for (const which of ['youtube', 'music']) {
      for (const entry of ['song', 'clip']) {
        const r = await contentModePick(contentJs, ['en-US', 'ar'], which, entry);
        const p = (r.payloads || [])[0];
        if (!p) { report(`[save/${which}/${entry}] صفر مدخل: طلب وضع أُرسل`, false, r.why || 'لا طلب'); continue; }
        report(`[save/${which}/${entry}] يرسل \`mode:"${entry}"\``, p.mode === entry, 'الحمولة=' + JSON.stringify(p));
        report(`[save/${which}/${entry}] و**بلا علم مشاهدة** ⇒ مسار الحفظ الكامل في مجلد المستخدم`,
          !('watch' in p), 'الحمولة=' + JSON.stringify(p));
      }
    }
    const rp = await contentReprocess(contentJs, ['en-US', 'ar']);
    if (!rp.payload) {
      report('[save/reprocess] صفر مدخل: «معالجة كاملة» أرسلت طلباً', false, rp.why || 'لا طلب');
    } else {
      report('[save/reprocess] «معالجة كاملة» ⇒ `mode` بلا علم مشاهدة (مسار الحفظ)',
        typeof rp.payload.mode === 'string' && !('watch' in rp.payload), 'الحمولة=' + JSON.stringify(rp.payload));
    }
  }

  /* (د) مبدّل اللغة. */
  const defAr = popupLang(src.popup, ['ar-SA', 'en-US'], {});  report('[lang] الافتراضيّ يبقى لغة المتصفّح (‏ar-SA ⇒ rtl/ar)', defAr.dir === 'rtl' && defAr.lang === 'ar',
    'dir=' + defAr.dir + ' lang=' + defAr.lang);
  report('[lang] والمختار مُعلَن بـ`aria-pressed` (‏ar)', defAr.arPressed === 'true' && defAr.enPressed === 'false',
    'ar=' + defAr.arPressed + ' en=' + defAr.enPressed);
  const storedEn = popupLang(src.popup, ['ar-SA', 'en-US'], { 'hl.lang': 'en' });
  report('[lang] تفضيل مخزَّن `en` يغلب لغة المتصفّح العربية', storedEn.dir === 'ltr' && storedEn.lang === 'en',
    'dir=' + storedEn.dir + ' lang=' + storedEn.lang);
  report('[lang] وعلامة الزرّ تتبع المخزَّن لا المتصفّح', storedEn.arPressed === 'false' && storedEn.enPressed === 'true',
    'ar=' + storedEn.arPressed + ' en=' + storedEn.enPressed);
  const storedAr = popupLang(src.popup, ['en-US', 'ar'], { 'hl.lang': 'ar' });
  report('[lang] وتفضيل مخزَّن `ar` يغلب لغة متصفّح إنجليزية', storedAr.dir === 'rtl' && storedAr.lang === 'ar',
    'dir=' + storedAr.dir + ' lang=' + storedAr.lang);
  const bogus = popupLang(src.popup, ['ar-SA', 'en-US'], { 'hl.lang': 'fr' });
  report('[lang] وقيمة مخزَّنة غريبة (`fr`) ⇒ لغة المتصفّح لا انهيار',
    bogus.dir === 'rtl' && bogus.lang === 'ar', 'dir=' + bogus.dir + ' lang=' + bogus.lang);

  /* النقر: يبدّل الواجهة كلها (لا نصوصاً بعضها عربيّ وبعضها إنجليزي) ويحفظ. */
  const click = popupLang(src.popup, ['ar-SA', 'en-US'], {});
  const enBtn = click.w.document.getElementById('lang-en');
  if (!enBtn) { report('[lang] صفر مدخل: زرّ `#lang-en` موجود', false, 'الزرّ مفقود'); }
  else {
    enBtn.click();
    await sleep(20);
    report('[lang] نقرة «English» ⇒ المستند ltr/en', click.w.document.documentElement.dir === 'ltr' && click.w.document.documentElement.lang === 'en',
      'dir=' + click.w.document.documentElement.dir + ' lang=' + click.w.document.documentElement.lang);
    /* **صفر محرف عربي في كل نصّ مربوط** — لا مطابقة جدول: آلة الحالة تكتب موضع
       `status.*` بعد الربط (وهو فخّ مُعلَن في هذا الملف)، فالمطابقة الحرفية على
       كل المواضع تُسقط ضابطاً سليماً. والمقيس هو المعنى: لا عربية في واجهة إنجليزية. */
    const bound = [...popupHtml.matchAll(/\bdata-i18n="([^"]*)"/g)].map((m) => m[1]);
    const withArabic = bound.filter((k) => {
      const tx = textOf(click.w, '[data-i18n="' + k + '"]');
      return tx && AR.test(tx);
    });
    report('[lang] وكل نصّ مربوط صار إنجليزياً — صفر محرف عربي (' + bound.length + ' موضعاً)',
      withArabic.length === 0, 'يحمل عربية: ' + withArabic.join(' · '));
    report('[lang] ونصوص الصفحة الثابتة بلغتها الجديدة (`header.sub` · `send.button`)',
      textOf(click.w, '[data-i18n="header.sub"]') === popupTable.en['header.sub']
      && textOf(click.w, '[data-i18n="send.button"]') === popupTable.en['send.button'],
      'sub=' + JSON.stringify(textOf(click.w, '[data-i18n="header.sub"]')));
    report('[lang] والزرّان انقلبا (‏en مضغوط)', attrOf(click.w, '#lang-en', 'aria-pressed') === 'true'
      && attrOf(click.w, '#lang-ar', 'aria-pressed') === 'false',
      'ar=' + attrOf(click.w, '#lang-ar', 'aria-pressed') + ' en=' + attrOf(click.w, '#lang-en', 'aria-pressed'));
    report('[lang] والاختيار يُحفظ بمفتاح `hl.lang`',
      click.w.__store['hl.lang'] === 'en' && click.w.__storeWrites.some((o) => o['hl.lang'] === 'en'),
      'store=' + JSON.stringify(click.w.__store) + ' writes=' + JSON.stringify(click.w.__storeWrites));
    const arBtn = click.w.document.getElementById('lang-ar');
    if (arBtn) {
      arBtn.click();
      await sleep(20);
      report('[lang] ثم نقرة «العربية» ⇒ rtl/ar ويُحفظ `ar`',
        click.w.document.documentElement.dir === 'rtl' && click.w.document.documentElement.lang === 'ar'
        && click.w.__store['hl.lang'] === 'ar',
        'dir=' + click.w.document.documentElement.dir + ' store=' + JSON.stringify(click.w.__store));
    }
  }

  /* (هـ) **تبديل حيّ**: النصّ **والاتجاه** معاً — عطل قِيس بجاسوس مستقلّ على `2b1d8c2`:
     `barBtnBase()` تُسند `direction` في مواضع الإنشاء وحدها، فإعادة الرسم كانت تُغيّر
     النصّ وتترك الاتجاه القديم ⇒ نصّ إنجليزي في حاوية `rtl`. */
  {
    const dirsOf = (w) => {
      const d = (id) => {
        const n = w.document.getElementById(id);
        return n ? n.style.direction : null;
      };
      return { proc: d('haramlite-yt-proc'), mode: d('haramlite-yt-mode'), watch: d('haramlite-yt-watch') };
    };
    let w = null;
    try { w = renderContent(contentJs, ['en-US', 'en'], REPLY_START, { store: { 'hl.lang': 'ar' } }); } catch (e) { w = null; }
    if (!w || !w.__fireStorage) {
      report('[switch] صفر مدخل: نافذة الصفحة مع مستمع `onChanged`', false, 'لم تُنشأ أو لا مستمع');
    } else {
      w.dispatchEvent(new w.Event('yt-navigate-finish'));
      await sleep(320);
      const arDirs = dirsOf(w);
      const arTexts = { proc: textOf(w, '#haramlite-yt-proc'), mode: textOf(w, '#haramlite-yt-mode') };
      report('[switch] إقلاع بمخزَّن `ar` على متصفّح إنجليزي ⇒ الأزرار الثلاثة `rtl` ونصّها عربي',
        arDirs.proc === 'rtl' && arDirs.mode === 'rtl' && arDirs.watch === 'rtl'
        && arTexts.proc === I18N.ar['btn.proc.idle'] && arTexts.mode === I18N.ar['btn.mode.clip'],
        'dirs=' + JSON.stringify(arDirs) + ' texts=' + JSON.stringify(arTexts));
      // التبديل الحيّ إلى `en` عبر `chrome.storage.onChanged` (المسار الحقيقي).
      w.__fireStorage({ 'hl.lang': { newValue: 'en' } });
      await sleep(60);
      const enDirs = dirsOf(w);
      const enTexts = { proc: textOf(w, '#haramlite-yt-proc'), mode: textOf(w, '#haramlite-yt-mode') };
      report('[switch] وتبديل حيّ إلى `en` ⇒ النصّ **والاتجاه** معاً (`ltr`)، لا نصّ جديد باتجاه قديم',
        enDirs.proc === 'ltr' && enDirs.mode === 'ltr' && enDirs.watch === 'ltr'
        && enTexts.proc === I18N.en['btn.proc.idle'] && enTexts.mode === I18N.en['btn.mode.clip'],
        'dirs=' + JSON.stringify(enDirs) + ' texts=' + JSON.stringify(enTexts));
      w.__fireStorage({ 'hl.lang': { newValue: 'ar' } });
      await sleep(60);
      const backDirs = dirsOf(w);
      report('[switch] ورجوع حيّ إلى `ar` ⇒ الاتجاهات `rtl` والنصّ عربي',
        backDirs.proc === 'rtl' && backDirs.mode === 'rtl' && backDirs.watch === 'rtl'
        && textOf(w, '#haramlite-yt-proc') === I18N.ar['btn.proc.idle'],
        'dirs=' + JSON.stringify(backDirs));
    }
  }

  /* (و) **نقرة مزدوجة سريعة ⇒ طلب واحد**: `BUSY` يُسند بعد `await`، فبين النقرة وردّ
     الجرس لا شيء يمنع طلباً ثانياً. قِيس بجاسوس مستقلّ على `2b1d8c2`: نقرتان بفرق
     ٥٫٤ مللي ⇒ `link` ثم `link`. والقفل (`STARTING`) يُسند متزامنةً قبل الـ`await`. */
  {
    let w = null;
    try { w = renderContent(contentJs, ['en-US'], REPLY_START); } catch (e) { w = null; }
    if (!w) { report('[double] صفر مدخل: نافذة الصفحة للقياس', false, 'لم تُنشأ'); }
    else {
      w.dispatchEvent(new w.Event('yt-navigate-finish'));
      await sleep(320);
      const btn = w.document.getElementById('haramlite-yt-proc');
      if (!btn) { report('[double] صفر مدخل: زرّ المعالجة مُحقَن', false, 'مفقود'); }
      else {
        // نقرتان في **النبضة نفسها**: أقصر فارق ممكن، وأقصى ما يبلغه سباق ما قبل `BUSY`.
        btn.click();
        btn.click();
        await sleep(200);
        const links = w.__sent.filter((m) => m && m.type === 'link');
        report('[double] نقرتان متتاليتان ⇒ **طلب واحد** لا طلبان (قفل البدء قبل `await`)',
          links.length === 1, 'عدد الطلبات=' + links.length + ' · الأوضاع=' + JSON.stringify(links.map((m) => m.mode)));
      }
    }
  }
}

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

  console.log('\n=== قياس حيّ (jsdom) لمسار خطأ content.js: النصّ والاتجاه ===');
  await measureContent(CONTENT, ok);

  console.log('\n=== قياس حيّ (jsdom) لبندَي x1: زرّ الوضع على الأصلين · مبدّل اللغة · فشل `result_file` ===');
  await measureX1({ content: CONTENT.js, popup: SHIPPED }, ok);

  console.log('\n=== مُفسَدات هذا القياس (في الذاكرة — لا ملف مؤقت) ===');
  const AR_SUB = grab(SHIPPED.js, /'header\.sub':\s*'([^']+)'/, 1);
  const CASES = [
    ['① `RTL` ثابت بدل الاشتقاق من اللغة ⇒ الإنجليزية يجب أن تسقط',
      { ...SHIPPED, js: sub(SHIPPED.js, /let RTL = LANG === 'ar';/, 'let RTL = true;') }, 'fall'],
    ['② `lang` ثابت `ar` ⇒ الإنجليزية يجب أن تسقط',
      { ...SHIPPED, js: sub(SHIPPED.js, /document\.documentElement\.lang = LANG;/, "document.documentElement.lang = 'ar';") }, 'fall'],
    ['③ مفتاح الربط في الصفحة أُفسد ⇒ العنصر يعرض `undefined`',
      { ...SHIPPED, html: sub(SHIPPED.html, /data-i18n="header\.sub"/, 'data-i18n="header.sub.typo"') }, 'fall'],
    ['④ الربط الثابت مقطوع (‏`applyI18n()` نُزع من الإقلاع) ⇒ النصّ يجب أن يسقط',
      { ...SHIPPED, js: sub(SHIPPED.js, /\n  applyI18n\(\);\n  try \{\n    if \(el\.version/, '\n  try {\n    if (el.version') }, 'fall'],
    ['⑤ صفّ اللغة صار العربية دائماً ⇒ المستند الإنجليزي يجب أن يسقط',
      { ...SHIPPED, js: sub(SHIPPED.js, /const row = I18N\[LANG\] \|\| I18N\.ar;/, 'const row = I18N.ar;') }, 'fall'],
    ['ض١ تعليق HTML يحمل عربية — يجب ألّا يُسقط',
      { ...SHIPPED, html: sub(SHIPPED.html, /<body>/, (m) => m + '\n<!-- ' + AR_SUB + ' -->') }, 'pass'],
    ['ض٢ قيمة إنجليزية مُبدَّلة في الجدول (والصفحة تقرأ منه) — يجب ألّا يُسقط',
      { ...SHIPPED, js: sub(SHIPPED.js, /'footer\.install': '([^']+)'/, "'footer.install': 'Setup guide ⚙'") }, 'pass'],
    /* Ⓖ مُفسَد الجاسوس: **بطاقة الاكتمال** تقرأ `last.error` خامّاً — كان يمرّ على
       الحارسين معاً قبل قاعدة العرض. */
    ['⑩ بطاقة الاكتمال تقرأ `last.error` خامّاً بدل `errText` (مُفسَد الجاسوس Ⓖ)',
      { ...SHIPPED, js: sub(SHIPPED.js, /fill\(t\('done\.failed'\), \{ e: errText\(last, t\('err\.unknown'\)\) \}\);/, "fill(t('done.failed'), { e: String(last.error || '') });") }, 'fall'],
  ];

  /* ── مُفسَدات مسار خطأ `content.js` (م٦-ج): كلها في الذاكرة ─────────────── */
  const CONTENT_CASES = [
    ['⑥ فرع الرمز المعلوم محذوف من `errText` ⇒ العربية الخام تُعرض في واجهة إنجليزية',
      { js: sub(CONTENT.js, /      case 'duplicate_link': return t\('code\.duplicate_link'\);\n/, '') }, 'fall'],
    ['⑦ الرمز المجهول لم يعد يقع على النصّ الخام (سقط إلى نصّ عام من الجدول)',
      { js: sub(CONTENT.js, /      default: return raw;/, "      default: return t('poll.failed');") }, 'fall'],
    ['⑧ الاتجاه ثُبِّت `rtl` بدل الاشتقاق من اللغة ⇒ الواجهة الإنجليزية تسقط',
      { js: sub(CONTENT.js, /el\.style\.direction = RTL \? 'rtl' : 'ltr';/, "el.style.direction = 'rtl';") }, 'fall'],
    /* Ⓓ مُفسَد الجاسوس: **الاستطلاع** يقرأ النصّ الخام مباشرةً — كان يمرّ على
       حارس الرموز وحارس jsdom معاً قبل قاعدة العرض، والاستطلاع أحد مسارَي العطل الأصلي. */
    ['⑨ الاستطلاع يقرأ `st.last.error` خامّاً بدل `errText` (مُفسَد الجاسوس Ⓓ)',
      { js: sub(CONTENT.js, /toast\('✗ ' \+ errText\(st\.last, t\('poll\.failed'\)\), 4000\);/, "toast('✗ ' + String(st.last.error), 4000);") }, 'fall'],
  ];

  /* ── مُفسَدات بندَي x1 (٣ و٤): كلها في الذاكرة ───────────────────────────────
   * وكلٌّ منها **إعادة تمثيل لعطل مقيس أو لانحراف يمحو الإصلاح**، لا مُفسَد شكليّ. */
  const X1_CASES = [
    /* ⑪ المحدِّد رجع إلى `.ytp-right-controls` وحده ⇒ لا زرّ على يوتيوب-ميوزيك
       (وهو عطل المالك الحرفي: الرابط `music.youtube.com/watch?v=…` بلا أيّ زرّ). */
    ['⑪ محرّك الحقن رجع إلى `.ytp-right-controls` وحده ⇒ صفر زرّ على يوتيوب-ميوزيك',
      { content: sub(CONTENT.js, /const HOST_SELECTORS = \['\.ytp-right-controls', 'ytmusic-player-bar \.right-controls'\];/,
        "const HOST_SELECTORS = ['.ytp-right-controls'];") }, 'fall'],
    /* ⑫ مدخل القائمة يرسل الوضع الآخر دائماً ⇒ اختيار «أغنية» لا يصل. */
    ['⑫ مدخل «أغنية» يرسل `clip` دائماً ⇒ الوضع المُرسل لا يطابق المختار',
      { content: sub(CONTENT.js, /function chooseMode\(next\) \{\n    MODE = next === 'song' \? 'song' : 'clip';/,
        "function chooseMode(next) {\n    MODE = 'clip';") }, 'fall'],
    /* ⑬ الحمولة عادت تحمل `'watch'` بدل اختيار المستخدم في **مسار الحفظ**. */
    ['⑬ مسار الحفظ يعود بـ`mode: \'watch\'` بدل الوضع المختار',
      { content: sub(CONTENT.js, /mode: MODE \}/, "mode: 'watch' }") }, 'fall'],
    /* ㉕/㉖ عقدا المدخلين (قرار المالك): العلم لا يُنزع من المشاهدة ولا يُضاف إلى الحفظ. */
    ['㉕ زرّ المشاهدة فقد علمه ⇒ يعود مسار الحفظ وتتراكم ملفات في مجلد المستخدم',
      { content: sub(CONTENT.js, /: \{ type: 'link', url: location\.href, watch: true \};/,
        ": { type: 'link', url: location.href };") }, 'fall'],
    ['㉖ مسار الحفظ اكتسب علم مشاهدة ⇒ ناتج الوضع لا يُحفظ',
      { content: sub(CONTENT.js, /\? \{ type: 'link', url: location\.href, mode: MODE \}/,
        "? { type: 'link', url: location.href, mode: MODE, watch: true }") }, 'fall'],
    /* ⑭ زرّ الوضع لم يُحقن ⇒ لا سبيل لاختيار الوضع من الصفحة. */
    ['⑭ زرّ الوضع لم يُحقن (#haramlite-yt-mode مفقود)',
      { content: sub(CONTENT.js, /    controls\.prepend\(mb\);\n/, '') }, 'fall'],
    /* ⑮ ردّ `result_file` المسمّى عاد يُعرض «رد فارغ» (عطل المالك الحرفي). */
    ['⑮ الفشل المسمّى من `result_file` يُعرض «رد فارغ» بدل رمزه (عطل المالك)',
      { content: sub(CONTENT.js, /      if \(r && r\.ok === false\) throw bridgeError\(r\);\n/, '') }, 'fall'],
    /* ⑯ التفضيل المخزَّن للغة لم يُقرأ ⇒ المبدّل لا يغلب لغة المتصفّح. */
    ['⑯ التفضيل المخزَّن للغة مُهمَل ⇒ `hl.lang` لا يغلب لغة المتصفّح',
      { popup: { ...SHIPPED, js: sub(SHIPPED.js, /const saved = storedLang\(got && got\[LANG_KEY\]\);/, 'const saved = null;') } }, 'fall'],
    /* ⑰ الاختيار لم يُحفظ ⇒ لا يتبعه `content.js` ولا يبقى بين الفتحات. */
    ['⑰ المبدّل يبدّل بلا حفظ ⇒ `hl.lang` لا يُكتب',
      { popup: { ...SHIPPED, js: sub(SHIPPED.js, /chrome\.storage\.local\.set\(\{ \[LANG_KEY\]: LANG \}\);/, ';') } }, 'fall'],
    /* ⑱ النقر لا يبدّل اللغة فعلاً (المعالج مُبدَّل بزرّ آخر). */
    ['⑱ زرّا المبدّل يعرضان ولا يبدّلان (المعالج لا ينادي `setLang`)',
      { popup: { ...SHIPPED, js: sub(SHIPPED.js, /if \(el\.langEn\) el\.langEn\.addEventListener\('click', \(\) => setLang\('en', true\)\);/,
        "if (el.langEn) el.langEn.addEventListener('click', () => setLang('ar', true));") } }, 'fall'],
    /* ⑲ علامة الزرّ المختار لا تُرسم ⇒ لا يُعرف أيّ لغة مفعّلة. */
    ['⑲ علامة الزرّ المختار لا تُرسم (`paintLang` لا تُنادى من `applyI18n`)',
      { popup: { ...SHIPPED, js: sub(SHIPPED.js, /  \/\/ وعلامة الزرّ المختار جزء من الرسم نفسه: لا تُترك لنداء منفصل يُنسى\.\n  paintLang\(\);\n/, '') } }, 'fall'],
    ['⑳ مدخل جدول اللغة محذوف ⇒ الزرّ يعرض `undefined`',
      { popup: { ...SHIPPED, js: sub(SHIPPED.js, /    'lang\.en': 'English',\n/, '') } }, 'fall'],
    /* ㉑ عطل الجاسوس على 2b1d8c2: إعادة الرسم تُغيّر النصّ **ولا تُسند الاتجاه**
       (‏`barBtnBase` تُسنده في مواضع الإنشاء وحدها) ⇒ نصّ إنجليزي في حاوية `rtl`. */
    ['㉑ `repaintBar` بلا إسناد اتجاه ⇒ التبديل الحيّ يترك النصّ الجديد باتجاه قديم',
      { content: sub(CONTENT.js, /    for \(const b of \[procBtn, watchBtn, modeBtn\]\) \{\n      if \(b\) b\.style\.direction = dirNow\(\);\n    \}\n/, '') }, 'fall'],
    /* ㉒ عطل الجاسوس (نقرة مزدوجة ٥٫٤ مللي ⇒ طلبان): نزع قفل البدء. */
    ['㉒ قفل البدء منزوع ⇒ نقرتان متتاليتان ترسلان طلبين',
      { content: sub(CONTENT.js, /    if \(BUSY \|\| STARTING\) return;/, '    if (BUSY) return;') }, 'fall'],
    /* ㉓/㉔ ثقبا قسم ٣٣ — يُقاسان هنا **سلوكياً** أيضاً: محاكاة Trusted Types تُسقط
       فتح القائمة كما تُسقطه في كروم (والنمط البنيوي يمسكهما في حارس المزامنة). */
    ['㉓ `menu[innerHTML] = …` (وصول محسوب) ⇒ القائمة لا تُفتح (Trusted Types)',
      { content: sub(CONTENT.js, /    const reprocess = mkNode\('button', null, t\('menu\.reprocess'\)\);/,
        "    menu['innerHTML'] = t('menu.reprocess');\n    const reprocess = mkNode('button', null, t('menu.reprocess'));") }, 'fall'],
    ['㉔ `menu.setHTMLUnsafe(…)` (معالج كروم ١٢٤+) ⇒ القائمة لا تُفتح',
      { content: sub(CONTENT.js, /    const reprocess = mkNode\('button', null, t\('menu\.reprocess'\)\);/,
        "    menu.setHTMLUnsafe(t('menu.reprocess'));\n    const reprocess = mkNode('button', null, t('menu.reprocess'));") }, 'fall'],
  ];

  let caught = 0, survived = 0, passed = 0, badPass = 0, skipped = 0;
  const holes = [], regressions = [];
  const ALL = CASES.map((c) => [c[0], c[1], c[2], 'popup'])
    .concat(CONTENT_CASES.map((c) => [c[0], c[1], c[2], 'content']))
    .concat(X1_CASES.map((c) => [c[0], c[1], c[2], 'x1']));
  for (const [label, src, want, kind] of ALL) {
    let r = null;
    const run = kind === 'content' ? measureContent : (kind === 'x1' ? measureX1 : measure);
    // مُفسَدات x1 تُطبَّق على مصدرها وحدها: `content` لبند ٣ و`popup` لبند ٤، والآخر يُمرَّر مشحوناً.
    const input = kind === 'x1'
      ? { content: (src && src.content) || CONTENT.js, popup: (src && src.popup) || SHIPPED }
      : src;
    try { r = { checks: 0, failures: [] }; await run(input, (l, c, d) => { r.checks++; if (!c) r.failures.push(d ? l + ' — ' + d : l); }); } catch (e) { r = null; }
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
  // إغلاق كل نوافذ القياس **قبل** الحكم — وإلا بقيت مؤقّتات إعادة الحقن حيّة وتعلّقت
  // العملية بعد طباعة حكمها (عيب أداة قِيس وأُصلح: انظر تعليق `OPEN_WINDOWS`).
  console.log('  نوافذ القياس أُغلقت: ' + closeAllWindows() + ' (بلا إغلاق تبقى المؤقّتات حيّة وتُعلّق العملية)');
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
  /* **خروج صريح بعد طباعة الحكم كاملاً** — عيب أداة قِيس على هذه الجولة: بعد أن
   * توسّع القياس إلى بندَي x1 (‏118 نافذة jsdom) صار الحارس **يطبع حكمه ثم لا
   * تنتهي عمليته**، فـ`pnpm ext:i18n:live` يتعلّق ولا يصلح بوّابة. وأُغلق كل نافذة
   * قبل الحكم (`closeAllWindows`) فلم يزل التعلّق ⇒ فالباقي مقبض لا نعرفه في
   * jsdom، **ولم أُثبته** (حدّ مُعلَن): قِيس أن نافذة واحدة تُغلق وتنتهي العملية في
   * 2.4 ثانية (`ARCHIVE/x1-handle-probe.cjs`)، فالأثر تراكميّ لا مفرد.
   * والخروج الصريح هو نمط هذا الملف نفسه في مسار الفشل (`process.exit(1)` أعلاه)،
   * وكل المخرجات مطبوعة قبله (‏stdout إلى أنبوب على ويندوز متزامن). */
  process.exit(0);
}

main();
