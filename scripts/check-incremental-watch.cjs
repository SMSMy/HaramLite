#!/usr/bin/env node
/* حارس الدفعة ب — الجلب التدريجي وطبقة الأولوية (node scripts/check-incremental-watch.cjs)
 *
 * **ما يقيسه** (على `content.js` **المشحون نفسه** داخل jsdom بواجهة `chrome`
 * مصنوعة وMediaSource مصنوع — كروم ١٥٣ لا يحترم تحميل الإضافة فلا متصفحاً حقيقياً يُدَّعى):
 *   ① **النموّ**: حلقة الجلب لا تكسر عند `total` المتنامي — شريحته الأولى
 *      (`done:false`, total=2) يتبعها ثانٍ (total=4, `done:true`) ⇒ الناتج
 *      **4 بايتات** كاملة، والسلوك القديم كان يكسر عند `offset >= total`
 *      فيرمي `partialFile` (العلّة نفسها).
 *   ② **الاستسلام المسمّى**: صمتُ كاتبٍ لا ينتهي ⇒ رفض بمفتاح `fetch.stalled`
 *      بعد السقف المعلن (`FETCH_LIMITS.polls` — يُقَصَّر في القياس لا في المنتج).
 *   ③ **إلحاق MSE بالترتيب**: أول `done:false` ⇒ مسار `mse`، والشرائح تُلحق
 *      **بترتيبها** `[1,2]` ثم `[3,4]` و`endOfStream` عند الاكتمال.
 *   ④ **حارس الامتلاء**: `QuotaExceededError` على الإلحاق ⇒ حذف
 *      `[0, التشغيل − 30ث]` **ثم** إعادة الإلحاق (الموضع 45 ⇒ الحذف حتى 15).
 *   ⑤ **التراجع الآمن**: بلا MediaSource ⇒ مسار `full` (انتظار الكامل) رغم
 *      `done:false` — لا استثناء يفلت.
 *   ⑥ **طبقة الأولوية**: `showPriorityOverlay` تبني الطبقة بأيقونة ونصّ وزرّ،
 *      والنقر يرسل `prioritize_page_audio` برقم المقطع ويخفيها.
 *
 * **ما لا يقيسه (بصراحة)**: لا متصفحاً حقيقياً ولا يوتيوباً حقيقياً؛ ولا تشغيل
 * المزامنة الكاملة (`startWatch`) على ملف نامٍ — مسار `mse` **ساكن** حتى يُشحن
 * مُنتِج المقاطع (المرحلة ٤)، وتفاعله الحيّ مع آلة المزامنة من نصيب تجربة
 * المالك. وخطّاف `seeking` داخل `startWatch` يقاس بالبنية (عدّاد `on(` في
 * `check-extension-sync`) لا بسلوك هنا.
 *
 * **ومُفسِداته** في `check-extension-mutants.cjs` (عائلة «الدفعة ب»): الكسر
 * المبكر المعاد · الإلحاق المعكوس · برميز أولوية محرَّف.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.resolve(__dirname, '..');
const CONTENT = fs.readFileSync(path.join(REPO, 'browser-extension', 'content.js'), 'utf8');
const PAGE = '<!doctype html><html><body><div id="movie_player"><video></video>' +
  '<div class="ytp-right-controls"></div></div></body></html>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

let pass = 0;
let fail = 0;
const failures = [];
function report(name, ok, why) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; failures.push(name); console.log('  ✗ ' + name + (why ? ' — ' + why : '')); }
}

/** نسخ MediaSource المصنوعة — تُنشأ داخل نطاق content.js فلا يبلغها القياس
 *  إلّا بالتتبّع من الفئة نفسها (مُنشئها يسجّل `this`). */
const MS_LOG = [];

class FakeSB {
  constructor() {
    this.updating = false;
    this.appended = [];
    this.anchors = [];   // ٤أ/٣: مرساة كل إلحاق (ts + حدود النافذة لحظتها)
    this.removed = [];
    this.throwOnce = false;
    this.buffered = { length: 1, end: () => 10 };
    this.timestampOffset = 0;
    this.appendWindowStart = 0;
    this.appendWindowEnd = Infinity;
    this._l = {};
  }
  addEventListener(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); }
  _fire(ev) { (this._l[ev] || []).slice().forEach((f) => f({})); }
  appendBuffer(bytes) {
    if (this.throwOnce) { this.throwOnce = false; const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
    this.appended.push(Array.from(bytes));
    this.anchors.push({ ts: this.timestampOffset, ws: this.appendWindowStart, we: this.appendWindowEnd });
    this.updating = true;
    queueMicrotask(() => { this.updating = false; this._fire('updateend'); });
  }
  remove(a, b) {
    this.removed.push([a, b]);
    this.updating = true;
    queueMicrotask(() => { this.updating = false; this._fire('updateend'); });
  }
}

class FakeMS {
  constructor() {
    this.readyState = 'closed';
    this.duration = 0;
    this.ended = false;
    this.sourceBuffer = null;
    this._l = {};
    MS_LOG.push(this);
  }
  addEventListener(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); }
  _fire(ev) { (this._l[ev] || []).slice().forEach((f) => f({})); }
  static isTypeSupported(mime) { return mime === 'audio/mpeg'; }
  addSourceBuffer() {
    this.sourceBuffer = new FakeSB();
    this.readyState = 'open';
    return this.sourceBuffer;
  }
  endOfStream() { this.ended = true; }
}

/** يبني نافذة يوتيوب مصنوعة، ويحقن `chrome` بـresponder يقيس، ثم يُنفّذ
 *  content.js المشحون ويعيد النافذة وسطح القياس والمُلتقِطات. */
async function makeWindow({ responder, withMSE, src }) {
  MS_LOG.length = 0;
  const dom = new JSDOM(PAGE, { url: 'https://www.youtube.com/watch?v=abc', runScripts: 'outside-only' });
  const w = dom.window;
  const sent = [];
  w.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => 'chrome-extension://fake/' + p,
      onMessage: { addListener: () => {} },
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (msg && msg.type === 'native' && responder) {
          Promise.resolve().then(() => responder(msg.message)).then((hostPayload) => {
            cb({ ok: true, resp: hostPayload });
          });
          return;
        }
        cb({ ok: true, resp: { ok: true } });
      },
    },
    storage: {
      local: {
        get: (keys, cb) => { if (typeof cb === 'function') cb({}); },
        set: (obj, cb) => { if (typeof cb === 'function') cb(); },
      },
      onChanged: { addListener: () => {} },
    },
  };
  if (withMSE) w.MediaSource = FakeMS;
  // jsdom لا ينفّذ createObjectURL — يُستبدل بمُلتقِط يسجّل حجم Blob.
  const blobs = [];
  w.URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:fake-' + blobs.length; };
  w.eval(src || CONTENT);
  await sleep(0);
  return { w, sent, blobs };
}


/* ── المُفسِدات (بوابة سالبة — النجاح فيها هو أن يسقط الحارس) ──────────────
 * ثلاثة مُفسِدات على content.js **في الذاكرة**، كلٌّ يجب أن يُسقط فحصاً
 * بعينه، وضابطٌ واحد لكلٍّ على النسخ النظيفة مرّ في الأعلى:
 *   م1: الكسر المبكر المعاد (‏`offset >= total ⇒ break`) ⇒ ① يرمي partialFile.
 *   م2: الإلحاق المعكوس ⇒ ③ يرى الترتيب مقلوباً.
 *   م3: رمز الأولوية محرَّف إلى 1 ⇒ ⑥ يقرأ غير ما أرسلته الصفحة.
 *  والتحقق أن المُفسِد غيّر شيئاً فعلاً إلزامي (مُفسِد باطل = نجاح كاذب). */
const MUST_CHANGE = (s2, from, to) => {
  if (!s2.includes(from)) throw new Error('مُفسِد باطل: النصّ الأساس غاب — `' + from.slice(0, 40) + `...`);
  const out = s2.split(from).join(to);
  if (out === s2) throw new Error('مُفسِد باطل: الاستبدال لم يغيّر شيئاً');
  return out;
};
const MUTANTS_B = [
  ['م1: الكسر المبكر المعاد على ملف نامٍ',
    (s2) => MUST_CHANGE(s2,
      '    while (!done) {\n      const f = await sliceAt(offset);',
      '    while (!done) {\n      if (total > 0 && offset >= total) break; // مُفسَد\n      const f = await sliceAt(offset);'),
    async (w2, sent2, blobs2) => { let url2 = null; try { url2 = await hl(w2).fetchPageAudio(null); } catch { return true; }
      void url2;
      // العلّة ليست رمياً بالضرورة: القطع **الصامت** — الطولان متساويان على النصف الأول
      // فلا فحص يُمسكه؛ الدليل الحاسم هو حجم الناتج أقل من الكامل.
      return blobs2.length === 0 || blobs2[0].size !== 4; }],
  ['م2: الإلحاق المعكوس في المضخّة',
    (s2) => MUST_CHANGE(s2, 'await appendWithQuotaGuard(sb, hexToBytes(f.data), frontSecs);',
      'await appendWithQuotaGuard(sb, hexToBytes(f.data).reverse(), frontSecs);'),
    async (w2) => { const grow = (offset) => (offset === 0
        ? { ok: true, file: { total: 2, offset: 0, data: hex([1, 2]), done: false } }
        : { ok: true, file: { total: 4, offset: 2, data: hex([3, 4]), done: true } });
      const opened = await hl(w2).openPageAudio(null, () => 0, () => 30);
      MS_LOG[0]._fire('sourceopen');
      await opened.pump;
      return JSON.stringify(MS_LOG[0].sourceBuffer.appended) !== '[[1,2],[3,4]]'; }],
  ['م3: رمز الأولوية يصل محرَّفاً إلى 1',
    (s2) => MUST_CHANGE(s2, "type: 'prioritize_page_audio', segment }",
      "type: 'prioritize_page_audio', segment: 1 }"),
    async (w2, sent2) => { const video = w2.document.querySelector('video');
      hl(w2).showPriorityOverlay(video, 3);
      const btn = w2.document.querySelector('#haramlite-priority-overlay button');
      btn.click(); await sleep(20);
      const prio = sent2.find((m) => m.type === 'native' && m.message && m.message.type === 'prioritize_page_audio');
      return !!prio && prio.message.segment !== 3; }],
  ['م4: مرساة الوحدة مشتقّة من نهاية المخزن لا من الشبكة',
    (s2) => MUST_CHANGE(s2,
      '        sb.timestampOffset = anchor;',
      '        sb.timestampOffset = (() => { try { return sb.buffered.end(sb.buffered.length - 1); } catch (e) { return anchor; } })(); // مُفسَد: الاشتقاق من السابق'),
    async (w2) => { const video = w2.document.querySelector('video'); video.currentTime = 0;
      const p = await hl(w2).pumpUnits(video, null, () => 0, () => 30);
      MS_LOG[0]._fire('sourceopen');
      await p.pump;
      const A = MS_LOG[0].sourceBuffer.anchors;
      const U = hl(w2).UNIT_SECS;
      return A.length !== 2 || A[0].ts !== 0 || A[1].ts !== U; }],
  ['م5: إعادة فحص الحال عند المشاهدة مُزالة (بقي سباق الإقلاع)',
    (s2) => MUST_CHANGE(s2,
      '      await checkStatusForCurrentVideo();',
      '      // مُفسَد: لا إعادة فحص — الرفض الصامت بقي'),
    async (w2) => {
      // الزرّ يُحقَن على مهل.
      for (let i = 0; i < 25; i++) { if (w2.document.querySelector('#haramlite-yt-watch')) break; await sleep(200); }
      try { w2.document.querySelector('#haramlite-yt-watch').click(); } catch { return true; }
      await sleep(600);
      const toast = w2.document.getElementById('haramlite-toast');
      const txt = toast ? toast.textContent : '';
      return txt.includes('Build the map first') || txt.includes('ابنِ الخريطة');
    }],
];

async function selfcheck() {
  let caught = 0;
  for (const [label, mutate, expectFall] of MUTANTS_B) {
    const mutated = mutate(CONTENT);
    let unitsQueries = 0;
    let statusCalls = 0;
    const { w: w2, sent: sent2, blobs: blobs2 } = await makeWindow({ responder: async (m) => {
      if (m.type === 'status') {
        statusCalls += 1;
        // أول نداء حالة يفشل — محاكاة سباق إقلاع المضيف (مقيسة حيّاً).
        if (statusCalls === 1) return { ok: false, error: 'cold-start' };
        return { ok: true, state: { last: { ok: true, url: 'https://www.youtube.com/watch?v=abc', seconds: 10, kept: [] } } };
      }
      if (m.type === 'page_units') {
        unitsQueries += 1;
        return { ok: true, units: [
          { k: 1, total: 2, done: true },
          { k: 2, total: 2, done: true },
        ], runDone: unitsQueries > 2 };
      }
      if (m.type === 'page_unit') {
        return { ok: true, unit: { k: m.k, total: 2, offset: m.offset, data: m.offset > 0 ? '' : hex([0xA0 + m.k, 0x0B + m.k]), done: m.offset > 0 } };
      }
      return m.offset === 0
        ? { ok: true, file: { total: 2, offset: 0, data: hex([1, 2]), done: false } }
        : { ok: true, file: { total: 4, offset: 2, data: hex([3, 4]), done: true } };
    }, withMSE: true, src: mutated });
    const fell = await expectFall(w2, sent2, blobs2);
    w2.close();
    if (fell) { caught += 1; console.log('  ✅ سقط   ' + label); }
    else { console.log('  ❌ مرّ    ' + label + '  ← ثقب في الحارس'); }
  }
  console.log('الحصيلة السلبية: أسقط ' + caught + ' من ' + MUTANTS_B.length);
  if (caught !== MUTANTS_B.length) { console.error('✗ ثقب: مُفسَد يمرّ من الحارس'); process.exit(1); }
}

const hl = (w) => w.__hlIncremental;

async function main() {

  /* ① النموّ: لا كسر عند total المتنامي — الناتج كامل البايتات. */
  {
    const grow = (offset) => (offset === 0
      ? { ok: true, file: { total: 2, offset: 0, data: hex([1, 2]), done: false } }
      : { ok: true, file: { total: 4, offset: 2, data: hex([3, 4]), done: true } });
    const { w, blobs } = await makeWindow({ responder: async (m) => grow(m.offset) });
    let threw = null;
    let url = null;
    try { url = await hl(w).fetchPageAudio(null); } catch (e) { threw = e; }
    report('① نموّ total بين النداءين ⇒ الناتج كامل (4 بايتات) بلا partialFile',
      !threw && url !== null && blobs.length === 1 && blobs[0].size === 4,
      threw ? ('رمى: ' + threw.message) : ('blobs=' + blobs.length + ' size=' + (blobs[0] && blobs[0].size)));
    w.close();
  }

  /* ② الاستسلام المسمّى: كاتب صامت ⇒ fetch.stalled بعد السقف (مقصوص للقياس). */
  {
    const { w } = await makeWindow({
      responder: async () => ({ ok: true, file: { total: 2, offset: 2, data: '', done: false } }),
    });
    hl(w).FETCH_LIMITS.polls = 2;
    hl(w).FETCH_LIMITS.ms = 1;
    let msg = null;
    try { await hl(w).fetchPageAudio(null); } catch (e) { msg = e.message; }
    report('② كاتب صامت بعد السقف ⇒ رفض بمفتاح fetch.stalled (بلا تعليق)',
      typeof msg === 'string' && (msg.includes('توقّف إنتاج صوت الصفحة') || msg.includes('stopped growing')),
      'وُجد: ' + JSON.stringify(msg));
    w.close();
  }

  /* ③ إلحاق MSE بالترتيب + endOfStream عند الاكتمال. */
  {
    const grow = (offset) => (offset === 0
      ? { ok: true, file: { total: 2, offset: 0, data: hex([1, 2]), done: false } }
      : { ok: true, file: { total: 4, offset: 2, data: hex([3, 4]), done: true } });
    const { w } = await makeWindow({ responder: async (m) => grow(m.offset), withMSE: true });
    const opened = await hl(w).openPageAudio(null, () => 0, () => 30);
    report('③ أول done:false + MediaSource ⇒ مسار mse', !!opened && opened.mode === 'mse',
      'وُجد ' + (opened && opened.mode));
    if (opened && opened.mode === 'mse') {
      const ms = MS_LOG[0];
      ms._fire('sourceopen'); // المستدعي الحقيقي يضبط audio.src فيطلقه المتصفح
      await opened.pump;
      const sb = ms.sourceBuffer;
      report('③ والشرائح تُلحق بترتيبها [1,2] ثم [3,4] وتُنهى القناة',
        !!sb && JSON.stringify(sb.appended) === '[[1,2],[3,4]]' && ms.ended === true,
        sb ? ('append=' + JSON.stringify(sb.appended) + ' ended=' + ms.ended) : 'لا SourceBuffer');
    }
    w.close();
  }

  /* ④ حارس الامتلاء: QuotaExceeded ⇒ حذف [0, تشغيل − 30] ثم إعادة الإلحاق. */
  {
    // الشريحة الثانية متأخّرة قليلاً ليُضبط الرمي بعد اكتمال الإلحاق الأول:
    // الرمي على الإلحاق الثاني (حلقة المضخّة) لا الأول.
    const grow = (offset) => (offset === 0
      ? Promise.resolve({ ok: true, file: { total: 2, offset: 0, data: hex([1, 2]), done: false } })
      : sleep(30).then(() => ({ ok: true, file: { total: 4, offset: 2, data: hex([3, 4]), done: true } })));
    const { w } = await makeWindow({ responder: async (m) => grow(m.offset), withMSE: true });
    const opened = await hl(w).openPageAudio(null, () => 35, () => 30);
    if (opened && opened.mode === 'mse') {
      const ms = MS_LOG[0];
      ms._fire('sourceopen');
      await sleep(10); // الإلحاق الأول اكتمل والمضخّة تنتظر الشريحة الثانية
      ms.sourceBuffer.throwOnce = true; // إلحاق الشريحة الثانية يرمي الامتلاء
      await opened.pump;
      const sb = ms.sourceBuffer;
      // نهاية المخزن المصنوع = 10 والحذف حتى (التشغيل 35 − الهامش 30) = 5
      report('④ امتلاء المخزن ⇒ حذف [0,5] (التشغيل 35 − الهامش 30، أقل من النهاية) ثم الإلحاق كاملاً',
        JSON.stringify(sb.removed) === '[[0,5]]' && JSON.stringify(sb.appended) === '[[1,2],[3,4]]',
        'removed=' + JSON.stringify(sb.removed) + ' append=' + JSON.stringify(sb.appended));
    } else {
      report('④ امتلاء المخزن ⇒ حذف ثم إعادة إلحاق', false, 'المسار ليس mse');
    }
    w.close();
  }

  /* ⑤ التراجع الآمن: بلا MediaSource ⇒ مسار full رغم done:false. */
  {
    const grow = (offset) => (offset === 0
      ? { ok: true, file: { total: 2, offset: 0, data: hex([5, 6]), done: false } }
      : { ok: true, file: { total: 4, offset: 2, data: hex([7, 8]), done: true } });
    const { w, blobs } = await makeWindow({ responder: async (m) => grow(m.offset), withMSE: false });
    let opened = null;
    let threw = null;
    try { opened = await hl(w).openPageAudio(null, () => 0, () => 0); } catch (e) { threw = e; }
    report('⑤ بلا MediaSource ⇒ مسار full والناتج كامل (4 بايتات) بلا استثناء',
      !threw && !!opened && opened.mode === 'full' && blobs.length === 1 && blobs[0].size === 4,
      threw ? ('رمى: ' + threw.message) : JSON.stringify(opened && opened.mode));
    w.close();
  }

  /* ⑥ طبقة الأولوية: البناء + الرسالة برقم المقطع + الإخفاء بعد النقر. */
  {
    const { w, sent } = await makeWindow({ responder: async () => ({ ok: true, order: [3, 4, 5, 6, 1, 2] }) });
    const video = w.document.querySelector('video');
    hl(w).showPriorityOverlay(video, 3);
    const ov = w.document.getElementById('haramlite-priority-overlay');
    const btn = ov ? ov.querySelector('button') : null;
    report('⑥ الطبقة تُبنى بأيقونة ونصّ وزرّ',
      !!ov && !!ov.querySelector('img') && !!btn && (ov.textContent.includes('المعالجة لم تصل إلى هنا بعد') || ov.textContent.includes('Processing has not reached this point yet')),
      ov ? 'بنية ناقصة' : 'الطبقة غائبة');
    if (btn) btn.click();
    await sleep(20);
    const prio = sent.find((m) => m.type === 'native' && m.message && m.message.type === 'prioritize_page_audio');
    report('⑥ والنقر يرسل prioritize_page_audio برقم المقطع ويخفي الطبقة',
      !!prio && prio.message.segment === 3 && !w.document.getElementById('haramlite-priority-overlay'),
      prio ? JSON.stringify(prio.message) : 'لا رسالة');
    w.close();
  }

  /* ⑦ وضع الوحدات (٤أ/٣): المراسي **مطلقة من الشبكة** (`ts` = (k−1)·UNIT_SECS
     لا مشتقّة من نهاية سابقة)، ونوافذ الحدود تُضبط قبل كل إلحاق (قتطاع حشو
     الإطار ~20.8ms مُقيس)، والقناة تُنهى عند `runDone` لا عند صمتٍ ظالم. */
  {
    let unitsQueries = 0;
    const responder = async (m) => {
      if (m.type === 'page_units') {
        unitsQueries += 1;
        return { ok: true, units: [
          { k: 1, total: 2, done: true },
          { k: 2, total: 2, done: true },
        ], runDone: unitsQueries > 2 };
      }
      if (m.type === 'page_unit') {
        return { ok: true, unit: { k: m.k, total: 2, offset: m.offset, data: m.offset > 0 ? '' : hex([0xA0 + m.k, 0x0B + m.k]), done: m.offset > 0 } };
      }
      return { ok: true };
    };
    const { w } = await makeWindow({ responder, withMSE: true });
    const video = w.document.querySelector('video');
    video.currentTime = 0;
    const p = await hl(w).pumpUnits(video, null, () => 0, () => 30);
    const ms = MS_LOG[0];
    ms._fire('sourceopen');
    await p.pump;
    const sb = ms.sourceBuffer;
    const U = hl(w).UNIT_SECS;
    const A = sb.anchors;
    report('⑦ الوحدات تُلحق بمراسٍ مطلقة [0, U] ونوافذ الحدود تُضبط والقناة تُنهى عند runDone',
      A.length === 2 && A[0].ts === 0 && A[1].ts === U
      && A[0].ws === 0 && A[0].we === U && A[1].ws === U && A[1].we === 2 * U
      && JSON.stringify(sb.appended) === JSON.stringify([[0xA1, 0x0C], [0xA2, 0x0D]])
      && ms.ended === true,
      'anchors=' + JSON.stringify(A) + ' appended=' + JSON.stringify(sb.appended) + ' ended=' + ms.ended);
    w.close();
  }

  /* ⑧ سباق إقلاع المضيف (مُقاس حيّاً 2026-10-07): فحصُ الحال عند تحميل الصفحة
     يسقط قبل جهوزية قناة الـnative ⇒ مهمّة مكتملة موجودة والمشاهدة تموت
     بـneedMap. الضابط: النقر يعيد فحص الحال فتُفتح المشاهدة رغم السقوط الأول. */
  {
    let statusCalls = 0;
    const responder = async (m) => {
      if (m.type === 'status') {
        statusCalls += 1;
        if (statusCalls === 1) return { ok: false, error: 'cold-start' }; // سباق الإقلاع
        return { ok: true, state: { last: { ok: true, url: 'https://www.youtube.com/watch?v=abc', seconds: 10, kept: [] } } };
      }
      if (m.type === 'result_file') {
        return { ok: true, file: { total: 2, offset: m.offset || 0, data: hex([1, 2]), done: true } };
      }
      if (m.type === 'page_units') return { ok: true, units: [], runDone: true };
      return { ok: true };
    };
    const { w, blobs } = await makeWindow({ responder, withMSE: false });
    await sleep(600); // فحصُ التحميل الساقط تم هنا
    let clickErr = null;
    // الزرّ يُحقَن على مهل — انتظر حتى 5 ثوانٍ.
    let btnSeen = false;
    for (let i = 0; i < 25; i++) {
      if (w.document.querySelector('#haramlite-yt-watch')) { btnSeen = true; break; }
      await sleep(200);
    }
    if (!btnSeen) { report('⑧ سباق إقلاع المضيف ⇒ النقر يعيد فحص الحال فتُفتح المشاهدة', false, 'الزرّ لم يُحقَن'); w.close(); return; }
    try { w.document.querySelector('#haramlite-yt-watch').click(); } catch (e) { clickErr = e; }
    let samples = [];
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      samples.push({
        btn: ((w.document.querySelector('#haramlite-yt-watch') || { textContent: '' }).textContent || '').slice(0, 24),
        toast: ((w.document.getElementById('haramlite-toast') || { textContent: '' }).textContent || '').slice(0, 50),
        blobs: blobs.length,
        audio: w.document.querySelectorAll('audio').length,
      });
    }
    const lastS = samples[samples.length - 1];
    const toast = w.document.getElementById('haramlite-toast');
    const toastTxt = toast ? toast.textContent : '';
    report('⑧ سباق إقلاع المضيف ⇒ النقر يعيد فحص الحال فتُفتح المشاهدة (بلا needMap)',
      clickErr === null && blobs.length === 1 && !toastTxt.includes('Build the map first') && !toastTxt.includes('ابنِ الخريطة'),
      JSON.stringify({ samples, err: clickErr && clickErr.message }));
    w.close();
  }

  console.log('');
  console.log(`الحصيلة: ${pass} ناجحاً · ${fail} فاشلاً`);
  if (fail > 0) {
    console.error('✗ ساقط: ' + failures.join(' · '));
    process.exit(1);
  }
  console.log('✓ الجلب التدريجي وطبقة الأولوية مقيسة على الملف المشحون (jsdom).');
}

const argvSelf = process.argv.includes('--selfcheck');
const run = argvSelf ? selfcheck().catch((e) => { console.error('انهار الحارس: ' + (e && e.stack || e)); process.exit(2); }) : main().catch((e) => { console.error('انهار الحارس: ' + (e && e.stack || e)); process.exit(2); });
void run;
