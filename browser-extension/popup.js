// HaramLite Bridge popup — status, per-request mode, send, live progress,
// completion, and the offline diagnostic. Talks to the desktop app only
// through background.js (Native Messaging); it makes no network request.
//
// The four states are the ones the design specifies:
//   ready · processing · completed · disconnected
// Nothing here uses inline handlers: the extension CSP is script-src 'self'.

const $ = (id) => document.getElementById(id);

const el = {
  indicator: $('status-indicator'),
  statusTitle: $('status-title'),
  statusChannel: $('status-channel'),
  offline: $('card-offline'),
  target: $('card-target'),
  targetTitle: $('target-title'),
  targetUrl: $('target-url'),
  modes: $('card-modes'),
  modeClip: $('mode-clip'),
  modeSong: $('mode-song'),
  action: $('card-action'),
  send: $('btn-send-page'),
  sendResult: $('send-result'),
  progress: $('card-progress'),
  jobName: $('job-name'),
  jobPct: $('job-pct-val'),
  jobBar: $('job-progress-bar'),
  jobPhase: $('job-phase-txt'),
  jobHw: $('job-hw-mode'),
  cancel: $('btn-cancel'),
  completed: $('card-completed'),
  completedText: $('completed-text'),
  completedActions: $('card-completed-actions'),
  watch: $('btn-watch'),
  openFolder: $('btn-open-folder'),
  ytNotice: $('card-yt-notice'),
  langAr: $('lang-ar'),
  langEn: $('lang-en'),
  // بالمُحدِّد الصنفي لا بمعرّف: `scripts/pack-extension.js` يقرأ الوسم بنمط
  // `class="version-tag">v?([^<\s]+)<` ويرفض الحزم إن تغيّر شكله (سمةٌ بعد
  // `class` تُفسده) — فالشكل **عقد** مع الحازم، ولا يُضاف إليه معرّف.
  version: document.querySelector('.version-tag'),
};

/* ── i18n: كائن ثابت، لا بناء ديناميكي ──────────────────────────────────────
 * نفس نمط `content.js` (جولة م٦-أ) حرفياً: جدول ثابت بمفاتيح `ar`/`en`
 * **متكافئة في الاتجاهين**، واختيار اللغة من `navigator.languages` — أي **لغة
 * واجهة المتصفّح** لا لغة الصفحة — والاتجاه (‏`rtl`/`ltr`) مشتقّ من اللغة
 * المُختارة لا من الصفحة المعروضة.
 *
 * **والافتراضيّ بقي لغة المتصفّح كما كان بالضبط** (بند ٤): التفضيل الصريح من
 * المبدّل الظاهر يغلبه، ومخزَّنه `chrome.storage.local['hl.lang']` — لا
 * `localStorage`، لأن `content.js` يعمل في أصل **الصفحة** (`youtube.com`) فلا
 * يقرأ ما تكتبه النافذة في أصل الإضافة. ومانيفست الإضافة صار يطلب `storage`
 * لهذا الغرض وحده (صلاحية بلا تحذير للمستخدم)، و`localStorage` بقي لمفتاح
 * الوضع `MODE_KEY` وحده كما كان (§٢٧ لم يُنقَض: المفتاح القديم قائم، والجديد
 * مُعلَن بالاسم في `TARGETS` بحارسه).
 *
 * ولا آلية تعريب ثانية في هذه النافذة: لا `chrome.i18n` ولا `_locales` هنا —
 * و`_locales` في هذا المستودع **مقصورة على ما يعرضه المتصفّح من المانيفست**
 * (اسم الإضافة ووصفها) لأنه لا يمرّ بكود أصلاً.
 *
 * ونصوص `popup.html` لا تسكن هناك: الصفحة تحمل مفاتيح `data-i18n` وحدها بلا
 * نصّ عربي، وهذا الجدول مصدرها الوحيد — وكل مفتاح مربوط في الصفحة يُفحص وجوده
 * هنا وفي اللغتين معاً.
 */
const I18N = {
  ar: {
    // الترويسة
    'header.sub': 'الجسر المحلي للمتصفح',
    'header.iconAlt': 'أيقونة HaramLite',
    // حالة الاتصال
    'status.connected': 'متصل بتطبيق HaramLite',
    'status.disconnected': 'غير متصل بالجسر المحلي',
    'status.checking': 'جارٍ الفحص…',
    // أخطاء الجسر
    'err.timeout': 'انتهت المهلة',
    'err.bridgeUnreachable': 'تعذر الوصول إلى الجسر',
    'err.connectFailed': 'فشل الاتصال',
    'err.unknown': 'خطأ غير معروف',
    // بطاقة التشخيص عند عدم الاتصال
    'offline.title': 'تطبيق HaramLite المكتبي غير متصل',
    'offline.step1': 'شغّل برنامج HaramLite على حاسوبك.',
    'offline.step2': 'من الإعدادات: فعّل',
    'offline.step2code': 'التكامل مع المتصفح',
    'offline.step3': 'أعد فتح هذه القائمة للاتصال الفوري بالجسر.',
    // التبويب النشط
    'target.label': 'التبويب النشط حالياً:',
    // اختيار الوضع
    'mode.clip.title': 'مقطع عادي',
    'mode.clip.desc': 'إزالة الموسيقى فقط وحفظ صفاء الحوار',
    'mode.song.title': 'وضع أغنية',
    'mode.song.desc': 'فصل كامل + تحسين الصوت + قصّ الصمت',
    // الإرسال
    'send.button': 'أرسل هذه الصفحة إلى HaramLite',
    'send.unsendable': 'هذه الصفحة لا يمكن إرسالها — افتح صفحة فيديو أو صفحة ويب عادية.',
    'send.sending': 'جارٍ الإرسال…',
    'send.failed': 'فشل الإرسال — شغّل HaramLite وفعّل التكامل مع المتصفح.',
    'send.sent': '✓ أُرسلت الصفحة — المعالجة جارية',
    // المعالجة الجارية — مراحل وخطوط
    'stage.download': 'التنزيل',
    'stage.normalize': 'توحيد الصوت',
    'stage.separate': 'فصل الصوت',
    'stage.effects': 'المؤثرات',
    'stage.encode': 'الترميز',
    'stage.other': 'معالجة',
    'progress.queued': ' · في الطابور: {q}',
    'cancel.button': '⏹ إلغاء المعالجة',
    // الاكتمال
    'done.text': 'اكتملت المعالجة بنجاح.',
    'done.okSeconds': 'اكتملت المعالجة بنجاح خلال {s} ثانية!',
    'done.failed': 'فشلت المعالجة: {e}',
    'done.watch': '▶ تشغيل المشاهدة المفلترة',
    'done.results': '📂 النتائج',
    // المشاهدة المفلترة
    'watch.started': '▶ بدأت المشاهدة المفلترة في الصفحة',
    'watch.needPlayer': 'افتح الفيديو في يوتيوب ثم اضغط «شاهد مفلتراً» في المشغّل',
    // تنبيه أزرار يوتيوب
    'yt.title': 'ملاحظة:',
    'yt.body': 'أزرار التحكم المباشر (عالج هذا الفيديو / شاهد بعد إزالة الموسيقى) مدمجة تلقائياً في شريط يوتيوب داخل الصفحة.',
    // التذييل
    'footer.privacy': 'معالجة محلية 100% · بلا سحابة',
    'footer.install': 'دليل التثبيت ⚙',
    // مبدّل اللغة (بند ٤) — النصّان من الجدول، ومعروضهما يُعلَن بـ`aria-pressed`.
    // واسم اللغة **بلغتها المعروضة** لا بلغة الطرف الآخر: في الواجهة العربية
    // «العربية / الإنجليزية»، وفي الإنجليزية «Arabic / English» — وبهذا لا تحمل
    // قيمة إنجليزية محرفاً عربياً (وهو ما يرفضه حارس الكتابة) ولا قيمة عربية بلا عربية.
    'lang.ar': 'العربية',
    'lang.en': 'الإنجليزية',
    'lang.title': 'لغة الواجهة',
    // رموز خطأ التطبيق المستقرّة (`code` في عقد الجسر — م٦-ج): النافذة تعرض
    // `last.error`، وهو نصّ يصوغه التطبيق بالعربية ⇒ يُترجم برمزه لا بنصّه.
    // ويحرس التقابل في الاتجاهين `scripts/check-bridge-codes.cjs`.
    'code.duplicate_link': 'هذا الرابط طُلب من قبل في هذه الجلسة — تخطي المكرر',
    'code.cancelled_by_user': 'أُلغيت المعالجة من قبل المستخدم',
    'code.download_cancelled': 'أُلغي التنزيل من قبل المستخدم',
    'code.internal_error': 'عطل داخلي — أعد المحاولة',
    'code.engine_error': 'فشل المحرّك: {e}',
    'code.unknown_message': 'رسالة غير معروفة بين الإضافة والتطبيق',
    'code.bad_input': 'طلب غير صالح',
  },
  en: {
    'header.sub': 'The local bridge for your browser',
    'header.iconAlt': 'HaramLite icon',
    'status.connected': 'Connected to the HaramLite app',
    'status.disconnected': 'Not connected to the local bridge',
    'status.checking': 'Checking…',
    'err.timeout': 'Timed out',
    'err.bridgeUnreachable': 'Could not reach the bridge',
    'err.connectFailed': 'Connection failed',
    'err.unknown': 'Unknown error',
    'offline.title': 'The HaramLite desktop app is not connected',
    'offline.step1': 'Run the HaramLite program on your computer.',
    'offline.step2': 'In Settings, enable',
    'offline.step2code': 'browser integration',
    'offline.step3': 'Reopen this popup to connect to the bridge instantly.',
    'target.label': 'Current active tab:',
    'mode.clip.title': 'Normal clip',
    'mode.clip.desc': 'Remove music only, keeping the dialogue clean',
    'mode.song.title': 'Song mode',
    'mode.song.desc': 'Full separation + audio enhancement + silence trimming',
    'send.button': 'Send this page to HaramLite',
    'send.unsendable': 'This page cannot be sent — open a video page or a normal web page.',
    'send.sending': 'Sending…',
    'send.failed': 'Send failed — run HaramLite and enable the browser integration.',
    'send.sent': '✓ Page sent — processing is running',
    'stage.download': 'Downloading',
    'stage.normalize': 'Normalising audio',
    'stage.separate': 'Separating audio',
    'stage.effects': 'Effects',
    'stage.encode': 'Encoding',
    'stage.other': 'Processing',
    'progress.queued': ' · queued: {q}',
    'cancel.button': '⏹ Cancel processing',
    'done.text': 'Processing finished successfully.',
    'done.okSeconds': 'Processing finished successfully in {s}s!',
    'done.failed': 'Processing failed: {e}',
    'done.watch': '▶ Start filtered watching',
    'done.results': '📂 Results',
    'watch.started': '▶ Filtered watching started in the page',
    'watch.needPlayer': 'Open the video on YouTube, then press «Watch filtered» in the player',
    'yt.title': 'Note:',
    'yt.body': 'The inline controls (process this video / watch without music) are injected automatically into the YouTube bar inside the page.',
    'footer.privacy': '100% local processing · no cloud',
    'footer.install': 'Install guide ⚙',
    'lang.ar': 'Arabic',
    'lang.en': 'English',
    'lang.title': 'Interface language',
    'code.duplicate_link': 'This link was already requested in this session — skipping the duplicate',
    'code.cancelled_by_user': 'Processing was cancelled by the user',
    'code.download_cancelled': 'The download was cancelled by the user',
    'code.internal_error': 'Internal error — try again',
    'code.engine_error': 'Engine failed: {e}',
    'code.unknown_message': 'Unknown message between the extension and the app',
    'code.bad_input': 'Invalid request',
  },
};

/* اختيار اللغة: دالّة **نقية** (قائمة لغات ⇒ لغة مدعومة) ليستخرجها الحارس
 * ويختبرها بمدخلات مصنوعة بلا متصفّح — كما في `content.js`.
 *
 * والقائمة تُقرأ **بترتيب المتصفّح** (`navigator.languages` مرتَّبة بتفضيل
 * المستخدم) فيُختار أول لغة مدعومة فيها. ومقصود: من ضبط [fr, ar] لا نُلبسه
 * الإنجليزية وهو قد أعلن أنه يقرأ العربية؛ ومن ضبط [de, en] يأخذ الإنجليزية.
 * وإن لم تكن في القائمة عربية ولا إنجليزية ⇒ **الإنجليزية**.
 */
function pickLang(list) {
  const arr = Array.isArray(list) ? list : [list];
  for (const raw of arr) {
    if (typeof raw !== 'string') continue;
    const tag = raw.toLowerCase();
    if (tag === 'ar' || tag.indexOf('ar-') === 0) return 'ar';
    if (tag === 'en' || tag.indexOf('en-') === 0) return 'en';
  }
  return 'en';
}
const LANG_DEFAULT = pickLang(
  (typeof navigator !== 'undefined' && navigator.languages && navigator.languages.length)
    ? navigator.languages
    : [(typeof navigator !== 'undefined' && navigator.language) || 'en']
);
/* اللغة المعروضة: تبدأ بلغة المتصفّح (السلوك القائم) ويغلبها التفضيل المخزَّن إن
 * وُجد — والقراءة **قبل أول رسم**، فلا وميض لغة ثم تبديلها. */
let LANG = LANG_DEFAULT;
let RTL = LANG === 'ar';
/** تفضيل مخزَّن صالح: `ar`/`en` فقط؛ وأي شيء آخر (أو غياب) ⇒ لغة المتصفّح. */
function storedLang(value) {
  return (value === 'ar' || value === 'en') ? value : null;
}
/** نصّ الواجهة بمفتاحه. مفتاح مجهول ⇒ العربية (المرجع) لا فراغ. */
function t(key) {
  const row = I18N[LANG] || I18N.ar;
  return (key in row) ? row[key] : I18N.ar[key];
}
/** {q} · {s} · {e} — استبدال موضعي لنصّ **من الجدول**، بلا تركيب نصّ جديد. */
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/* نصّ خطأ التطبيق: **الترجمة برمزه المستقرّ** `code`، وإلا فالنصّ الخام كما هو.
 * نفس الدالّة في `content.js` حرفياً (والجدول نفسه)، لأن العقد واحد: التطبيق
 * يُصدر `{ ok:false, error:<نصّه>, code:<رمز> }`، والقارئ القديم يقرأ `error`
 * ويتجاهل ما لا يعرفه. ورمز **مجهول** (تطبيق أحدث من الإضافة) يقع على `error`
 * الخام: توافق خلفي بلا فراغ. والربط جدول ثابت بمفاتيح نصّ حرفية (§٢٦)، ويحرس
 * التقابل في الاتجاهين `scripts/check-bridge-codes.cjs`. */
function errText(err, fallback) {
  const raw = String((err && (err.message || err.error)) || fallback || '');
  switch ((err && err.code) || '') {
    case 'duplicate_link': return t('code.duplicate_link');
    case 'cancelled_by_user': return t('code.cancelled_by_user');
    case 'download_cancelled': return t('code.download_cancelled');
    case 'internal_error': return t('code.internal_error');
    case 'engine_error': return fill(t('code.engine_error'), { e: raw });
    case 'unknown_message': return t('code.unknown_message');
    case 'bad_input': return t('code.bad_input');
    default: return raw;
  }
}

/* ── ربط نصوص الصفحة الثابتة، واتجاهها ─────────────────────────────────────
 * الموضعان الوحيدان في هذا الملف اللذان يُنادى فيهما `t` بمفتاح **محسوب**
 * (مفتاحٌ من السمة لا من الشيفرة). والمسوّغ أنهما **مجموعة مغلقة مُتحقَّق منها**:
 * كل `data-i18n`/`data-i18n-attr` في `popup.html` يُفحص وجوده في هذا الجدول في
 * اللغتين، فالمحسوب هنا مقيَّد لا مجهول — والحارس يعدّ الموضعين بعدد وتعليل.
 */
function applyI18n() {
  document.documentElement.lang = LANG;
  document.documentElement.dir = RTL ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    const spec = node.getAttribute('data-i18n-attr');
    const at = spec.indexOf(':');
    node.setAttribute(spec.slice(0, at), t(spec.slice(at + 1)));
  });
  // وعلامة الزرّ المختار جزء من الرسم نفسه: لا تُترك لنداء منفصل يُنسى.
  paintLang();
}

/* ── مبدّل اللغة (بند ٤) ────────────────────────────────────────────────────
 * بلاغ المالك: «زر اللغة بالإضافة لم أجده حتى أحوّله إلى اللغة الإنجليزية».
 * فالزرّان **ظاهران دائماً** في الترويسة، والمختار منهما يُعلَن بـ`aria-pressed`
 * (فيُقاس في DOM لا بالنظر)، والاختيار يُحفظ في `chrome.storage.local['hl.lang']`
 * فيتبعه `content.js` (يقرأ المفتاح نفسه ويستمع `chrome.storage.onChanged`).
 */
const LANG_KEY = 'hl.lang';

/** يعلّم الزرّ المختار. يُنادى من `applyI18n` بعد كل رسم. */
function paintLang() {
  if (el.langAr) el.langAr.setAttribute('aria-pressed', String(LANG === 'ar'));
  if (el.langEn) el.langEn.setAttribute('aria-pressed', String(LANG === 'en'));
}

/** يبدّل اللغة: يعيد رسم الصفحة كلها بلغتها، ثم يحفظ التفضيل. */
function setLang(next, persist) {
  const l = (next === 'ar' || next === 'en') ? next : null;
  if (!l) return;
  LANG = l;
  RTL = l === 'ar';
  applyI18n();
  paintLang();
  // إعادة رسم ما هو معروض الآن (الحالة والوضع وبطاقة الاكتمال) — لا إنشاء جديد.
  setState(STATE);
  paintMode();
  if (DONE_VIEW) renderCompleted(DONE_VIEW.last, DONE_VIEW.provider);
  if (persist) {
    try {
      if (chrome.storage && chrome.storage.local) chrome.storage.local.set({ [LANG_KEY]: LANG });
    } catch (e) { /* بلا تخزين: التبديل يبقى لهذه النافذة */ }
  }
}
if (el.langAr) el.langAr.addEventListener('click', () => setLang('ar', true));
if (el.langEn) el.langEn.addEventListener('click', () => setLang('en', true));

/* مراحل المعالجة: خريطة دوالّ بمفاتيح **حرفية**. ولا تُبنى بالمزج
 * (`'stage.' + s`) لأن §٢٦ يمنع تركيب النصّ، وتركيب المفتاح يُخفي وجوده عن
 * الحارس فيصير «مفتاح غير موجود» لا يُرى. */
const STAGE_LABEL = {
  download: () => t('stage.download'),
  normalize: () => t('stage.normalize'),
  separate: () => t('stage.separate'),
  effects: () => t('stage.effects'),
  encode: () => t('stage.encode'),
};

const MODE_KEY = 'hl.popup.mode';

function show(node, on) { node.classList.toggle('hidden', !on); }

/* الحالة المعروضة وبطاقة الاكتمال **مسجَّلتان**: تبديل اللغة يعيد رسمهما بلغتها
 * الجديدة بلا انتظار دورة استطلاع (بند ٤). */
let STATE = 'ready';
let DONE_VIEW = null;

function setState(state) {
  STATE = state;   // مسجَّلة ليُعاد رسمها عند تبديل اللغة (بند ٤)
  // Reset to the ready layout, then narrow it down for the current state.
  show(el.offline, false);
  show(el.progress, false);
  show(el.completed, false);
  show(el.completedActions, false);
  show(el.target, true);
  show(el.modes, true);
  show(el.action, true);
  show(el.ytNotice, true);
  el.send.disabled = false;
  el.indicator.className = 'status-dot ok';
  el.statusTitle.textContent = t('status.connected');
  el.statusChannel.textContent = 'Native Messaging';

  if (state === 'processing') {
    show(el.modes, false);
    show(el.action, false);
    show(el.progress, true);
  } else if (state === 'completed') {
    show(el.modes, false);
    show(el.action, false);
    show(el.completed, true);
    show(el.completedActions, true);
  } else if (state === 'disconnected') {
    el.indicator.className = 'status-dot bad';
    el.statusTitle.textContent = t('status.disconnected');
    el.statusChannel.textContent = '';
    show(el.offline, true);
    show(el.modes, false);
    show(el.ytNotice, false);
    el.send.disabled = true;
  }
}

// ── الجسر ──────────────────────────────────────────────────────────────────
// مهلة قصوى: لو لم يردّ العامل (خدمة خلفية لم تستيقظ، مضيف لم يُسجَّل) فلا
// تبقى النافذة عالقة على «جارٍ الفحص…» أبداً — تُعلن الانقطاع وتُظهر الخطوات.
const REPLY_TIMEOUT_MS = 4000;

function ask(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(t('err.timeout'))); }
    }, REPLY_TIMEOUT_MS);
    chrome.runtime.sendMessage(message, (resp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

/* خطأ الجسر المرميّ: النصّ كما هو ومعَه رمزه المستقرّ `code` إن حمله الردّ.
 * ونظيرتها في `content.js` حرفياً: بناء الخطأ في موضع واحد يجعل `code` لا يسقط
 * في الطريق، والحارس البنيوي في `scripts/check-bridge-codes.cjs` يعدّ كل قراءة
 * خامّة **خارج** هذه الدالّة و`errText` ويشترط أن تكون مُعلَنة باسمها. */
function bridgeError(resp, fallback) {
  const e = new Error((resp && resp.error) || fallback);
  if (resp && typeof resp.code === 'string') e.code = resp.code;
  return e;
}

function status() {
  return ask({ type: 'status' }).then((resp) => {
    if (!resp || !resp.ok) throw bridgeError(resp, t('err.bridgeUnreachable'));
    return resp.resp || {};
  });
}

function native(message) {
  return ask({ type: 'native', message }).then((resp) => {
    if (!resp || !resp.ok) throw bridgeError(resp, t('err.connectFailed'));
    return resp.resp || {};
  });
}

// ── الوضع المختار ──────────────────────────────────────────────────────────
let mode = 'clip';

function paintMode() {
  el.modeClip.classList.toggle('selected', mode === 'clip');
  el.modeSong.classList.toggle('selected', mode === 'song');
  el.modeClip.setAttribute('aria-pressed', String(mode === 'clip'));
  el.modeSong.setAttribute('aria-pressed', String(mode === 'song'));
}

function chooseMode(next) {
  mode = next === 'song' ? 'song' : 'clip';
  paintMode();
  // `localStorage` يبقى للمفتاح القديم (توافق مع من اختار وضعه قبل 1.1.9)،
  // ومعه **مِرآة إلى `chrome.storage.local` بالمفتاح نفسه**: `content.js` لا يقرأ
  // `localStorage` (أصل الصفحة ليس أصل الإضافة)، وبها يتفق زرّ الصفحة والنافذة
  // على تفضيل واحد بدل تفضيلين يتناقضان (بند ٣).
  try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* ignore */ }
  try {
    if (chrome.storage && chrome.storage.local) chrome.storage.local.set({ [MODE_KEY]: mode });
  } catch (e) { /* ignore */ }
}

el.modeClip.addEventListener('click', () => chooseMode('clip'));
el.modeSong.addEventListener('click', () => chooseMode('song'));
[el.modeClip, el.modeSong].forEach((node) => {
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      chooseMode(node === el.modeSong ? 'song' : 'clip');
    }
  });
});

// ── التبويب النشط ──────────────────────────────────────────────────────────
let activeTab = null;

function loadTarget() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    activeTab = (tabs && tabs[0]) || null;
    const url = activeTab && activeTab.url ? activeTab.url : '';
    const sendable = /^https?:/i.test(url);
    el.targetTitle.textContent = (activeTab && activeTab.title) || '—';
    el.targetUrl.textContent = url || '';
    if (!sendable) {
      el.send.disabled = true;
      el.sendResult.textContent = t('send.unsendable');
      el.sendResult.className = 'action-hint bad';
      show(el.sendResult, true);
    }
  });
}

// ── الإرسال والمتابعة ──────────────────────────────────────────────────────
function hint(msg, ok) {
  el.sendResult.textContent = msg;
  el.sendResult.className = 'action-hint ' + (ok ? 'ok' : 'bad');
  show(el.sendResult, true);
}

let pollTimer = null;
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function renderProgress(st, provider) {
  el.jobName.textContent = st.running.name || '';
  const pct = Math.round((st.running.pct || 0) * 100);
  el.jobBar.style.width = pct + '%';
  el.jobPct.textContent = pct + '%';
  const q = st.queue || 0;
  const stage = STAGE_LABEL[st.running.stage];
  el.jobPhase.textContent = (stage ? stage() : t('stage.other'))
    + (q > 0 ? fill(t('progress.queued'), { q }) : '');
  el.jobHw.textContent = provider ? String(provider) : '';
}

function renderCompleted(last, provider) {
  DONE_VIEW = { last, provider };
  setState('completed');
  el.completedText.textContent = last.ok
    ? fill(t('done.okSeconds'), { s: (last.seconds || 0).toFixed(1) })
    : fill(t('done.failed'), { e: errText(last, t('err.unknown')) });
  el.completed.classList.toggle('bad', !last.ok);
  el.jobHw.textContent = provider ? String(provider) : '';
  // لا معنى لزر المشاهدة إن فشلت المعالجة، ولا لفتح مجلد نتائج فارغ.
  show(el.watch, !!last.ok);
  if (!last.ok) { el.watch.disabled = true; }
}

function pollProgress() {
  stopPoll();
  setState('processing');
  let done = false;
  let sawRunning = false; // لا نقبل «انتهى» قبل أن نرى هذه المهمة تعمل فعلاً
  let fails = 0;
  pollTimer = setInterval(() => {
    native({ type: 'status' }).then((r) => {
      fails = 0;
      const st = (r && r.state) || {};
      const provider = r && r.provider;
      if (st.running) {
        sawRunning = true;
        renderProgress(st, provider);
      } else if (st.last && sawRunning && !done) {
        done = true;
        stopPoll();
        renderCompleted(st.last, provider);
      }
    }).catch(() => {
      fails += 1;
      if (fails >= 8) {
        stopPoll();
        setState('disconnected');
      }
    });
  }, 1500);
}

el.send.addEventListener('click', () => {
  const url = activeTab && activeTab.url;
  if (!url) return;
  el.send.disabled = true;
  hint(t('send.sending'), true);
  chrome.runtime.sendMessage({ type: 'send', url, mode }, (resp) => {
    el.send.disabled = false;
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      hint(t('send.failed'), false);
      return;
    }
    hint(t('send.sent'), true);
    pollProgress();
  });
});

el.cancel.addEventListener('click', () => {
  el.cancel.disabled = true;
  native({ type: 'cancel' }).catch(() => {});
  stopPoll();
  setState('ready');
  setTimeout(() => { el.cancel.disabled = false; }, 1500);
});

el.openFolder.addEventListener('click', () => {
  native({ type: 'open_folder' }).catch(() => {});
});

el.watch.addEventListener('click', () => {
  // المشغّل داخل الصفحة هو من يعرف الفيديو؛ نطلب منه تشغيل المشاهدة المفلترة.
  if (!activeTab || !activeTab.id) return;
  chrome.tabs.sendMessage(activeTab.id, { type: 'watch-toggle' }, (resp) => {
    const ok = !chrome.runtime.lastError && resp && resp.ok;
    hint(ok ? t('watch.started') : t('watch.needPlayer'), !!ok);
    if (ok) window.close();
  });
});

// ── الإقلاع ────────────────────────────────────────────────────────────────
// **الترتيب مقصود** (بند ٤): تُقرأ التفضيلات المخزَّنة (`hl.lang` · `hl.popup.mode`)
// **قبل أول رسم**، فلا تُرسم الواجهة بلغة ثم تُقلب إلى أخرى (وميض). وإن غاب
// `chrome.storage` (بيئة قياس) أو تعذّرت قراءته فالافتراضيّ لغة المتصفّح كما كان
// بالضبط — لا فراغ ولا تعطّل.
function boot(got) {
  const saved = storedLang(got && got[LANG_KEY]);
  if (saved) { LANG = saved; RTL = saved === 'ar'; }
  applyI18n();
  try {
    if (el.version && chrome.runtime.getManifest) {
      el.version.textContent = 'v' + chrome.runtime.getManifest().version;
    }
  } catch (e) { /* يبقى الوسم الثابت في الصفحة */ }

  try {
    const m = got && got[MODE_KEY];
    if (m === 'song' || m === 'clip') mode = m;
    else {
      // توافق: من اختار وضعه قبل 1.1.9 فتفضيله في `localStorage` وحده.
      const savedMode = localStorage.getItem(MODE_KEY);
      if (savedMode === 'song' || savedMode === 'clip') mode = savedMode;
    }
  } catch (e) { /* ignore */ }
  paintMode();

  loadTarget();
  status().then((r) => {
    const st = (r && r.state) || {};
    if (st.running) { pollProgress(); return; }
    if (st.last && st.last.ok) {
      renderCompleted(st.last, r.provider);
      return;
    }
    setState('ready');
  }).catch(() => setState('disconnected'));
}

function readPrefs(keys, cb) {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) { cb({}); return; }
    chrome.storage.local.get(keys, (got) => cb(got || {}));
  } catch (e) {
    cb({});
  }
}
readPrefs([LANG_KEY, MODE_KEY], boot);
