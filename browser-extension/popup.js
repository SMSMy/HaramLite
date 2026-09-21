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
  version: $('version-tag'),
};

/* ── i18n: كائن ثابت، لا بناء ديناميكي ──────────────────────────────────────
 * نفس نمط `content.js` (جولة م٦-أ) حرفياً: جدول ثابت بمفاتيح `ar`/`en`
 * **متكافئة في الاتجاهين**، واختيار اللغة من `navigator.languages` — أي **لغة
 * واجهة المتصفّح** لا لغة الصفحة — والاتجاه (‏`rtl`/`ltr`) مشتقّ من اللغة
 * المُختارة لا من الصفحة المعروضة.
 *
 * ولا آلية تعريب ثانية في هذه النافذة: لا `chrome.i18n` ولا `_locales` هنا —
 * و`_locales` في هذا المستودع **مقصورة على ما يعرضه المتصفّح من المانيفست**
 * (اسم الإضافة ووصفها) لأنه لا يمرّ بكود أصلاً. ولا مفتاح تخزين جديد:
 * `MODE_KEY` وحده كما كان، والحارس يعدّ مفاتيح `localStorage` بعدد لكل ملف.
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
const LANG = pickLang(
  (typeof navigator !== 'undefined' && navigator.languages && navigator.languages.length)
    ? navigator.languages
    : [(typeof navigator !== 'undefined' && navigator.language) || 'en']
);
/** اتجاه الواجهة **مشتقّ من اللغة** لا من الصفحة. */
const RTL = LANG === 'ar';
/** نصّ الواجهة بمفتاحه. مفتاح مجهول ⇒ العربية (المرجع) لا فراغ. */
function t(key) {
  const row = I18N[LANG] || I18N.ar;
  return (key in row) ? row[key] : I18N.ar[key];
}
/** {q} · {s} · {e} — استبدال موضعي لنصّ **من الجدول**، بلا تركيب نصّ جديد. */
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/* ── ربط نصوص الصفحة الثابتة، واتجاهها ─────────────────────────────────────
 * الموضعان الوحيدان في هذا الملف اللذان يُنادى فيهما `t` بمفتاح **محسوب**
 * (مفتاحٌ من السمة لا من الشيفرة). والمسوّغ أنهما **مجموعة مغلقة مُتحقَّق منها**:
 * كل `data-i18n`/`data-i18n-attr` في `popup.html` يُفحص وجوده في هذا الجدول في
 * اللغتين، فالمحسوب هنا مقيَّد لا مجهول — والحارس يعدّ الموضعين بعدد وتعليل.
 */
function applyI18n() {
  const root = document.documentElement;
  root.lang = LANG;
  root.dir = RTL ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    const spec = node.getAttribute('data-i18n-attr');
    const at = spec.indexOf(':');
    node.setAttribute(spec.slice(0, at), t(spec.slice(at + 1)));
  });
}

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

function setState(state) {
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

function status() {
  return ask({ type: 'status' }).then((resp) => {
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || t('err.bridgeUnreachable'));
    return resp.resp || {};
  });
}

function native(message) {
  return ask({ type: 'native', message }).then((resp) => {
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || t('err.connectFailed'));
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
  // localStorage لا chrome.storage: مانيفست الإضافة لا يطلب صلاحية `storage`،
  // وطلبها كان سيضيف صلاحية إلى قائمة المتجر بلا داعٍ لتفضيل واحد.
  try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* ignore */ }
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
  setState('completed');
  el.completedText.textContent = last.ok
    ? fill(t('done.okSeconds'), { s: (last.seconds || 0).toFixed(1) })
    : fill(t('done.failed'), { e: last.error || t('err.unknown') });
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
// نصوص الصفحة الثابتة والاتجاه أولاً، ثم رقم الإصدار من المانيفست نفسه (فلا
// يتقادم الوسم في الترويسة صامتاً عند رفع الإصدار)، ثم الحالة.
applyI18n();
try {
  if (el.version && chrome.runtime.getManifest) {
    el.version.textContent = 'v' + chrome.runtime.getManifest().version;
  }
} catch (e) { /* يبقى الوسم الثابت في الصفحة */ }

try {
  const savedMode = localStorage.getItem(MODE_KEY);
  if (savedMode === 'song' || savedMode === 'clip') mode = savedMode;
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
