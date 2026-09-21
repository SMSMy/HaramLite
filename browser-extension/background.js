// HaramLite Bridge — MV3 service worker.
// Sends links to the desktop app through Native Messaging only.
// No trackers, no analytics, no network requests besides the host.

const HOST = 'com.harammute.haramlite';
const MENU_LINK = 'hl-send-link';
const MENU_PAGE = 'hl-send-page';
const MENU_VIDEO = 'hl-send-video';

/* ── i18n: كائن ثابت، لا بناء ديناميكي ──────────────────────────────────────
 * نفس نمط `content.js` (جولة م٦-أ) و`popup.js`: جدول ثابت بمفاتيح `ar`/`en`
 * متكافئة، واختيار اللغة من `navigator.languages` — **لغة واجهة المتصفّح** لا
 * لغة الصفحة. وهذه هي النصوص الوحيدة في هذا الملف: عناوين قائمة النقر الأيمن.
 *
 * ولا اتجاه هنا: القائمة عنصر **من المتصفّح** لا من الصفحة، فيرسمها المتصفّح
 * باتجاه واجهته تبعاً للغة نفسها التي اخترناها — فلا `dir` نُسنده ولا `RTL`
 * ميت نتركه.
 *
 * وحدّ مُعلَن: العناوين تُبنى في `onInstalled` وحده (كما كان قبل التعريب، بلا
 * تغيير سلوك)، فمن غيّر لغة متصفّحه بعد التثبيت بقيت قائمته بلغتها القديمة حتى
 * تحديث الإضافة أو إعادة تثبيتها.
 */
const I18N = {
  ar: {
    'menu.link': 'أرسل الرابط إلى HaramLite',
    'menu.page': 'أرسل هذه الصفحة إلى HaramLite',
    'menu.video': 'أرسل الفيديو إلى HaramLite',
  },
  en: {
    'menu.link': 'Send the link to HaramLite',
    'menu.page': 'Send this page to HaramLite',
    'menu.video': 'Send the video to HaramLite',
  },
};

/* اختيار اللغة: دالّة **نقية** (قائمة لغات ⇒ لغة مدعومة) ليستخرجها الحارس
 * ويختبرها بمدخلات مصنوعة بلا متصفّح — كما في `content.js` و`popup.js`.
 * والقائمة تُقرأ بترتيب المتصفّح، وأول لغة مدعومة فيها تفوز، وما ليس عربياً
 * ولا إنجليزياً ينتهي إلى الإنجليزية. */
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
// في عامل الخدمة `navigator` هو `WorkerNavigator` و`languages` متاحة فيه.
const LANG = pickLang(
  (typeof navigator !== 'undefined' && navigator.languages && navigator.languages.length)
    ? navigator.languages
    : [(typeof navigator !== 'undefined' && navigator.language) || 'en']
);
/** نصّ الواجهة بمفتاحه. مفتاح مجهول ⇒ العربية (المرجع) لا فراغ. */
function t(key) {
  const row = I18N[LANG] || I18N.ar;
  return (key in row) ? row[key] : I18N.ar[key];
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: t('menu.link'),
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: t('menu.page'),
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_VIDEO,
      title: t('menu.video'),
      contexts: ['video'],
    });
  });
});

// Audit E-1: ONE persistent Native Messaging port (connectNative) reused for
// every message, instead of spawning and killing a host process on every
// 1.5-second poll (sendNativeMessage). The MV3 service worker may unload at
// any time — the port dies with it and is lazily reconnected on next use.
let port = null;
const replyQueue = []; // the host answers in order → FIFO of {resolve, reject}

function getPort() {
  return new Promise((resolve, reject) => {
    if (port) {
      resolve(port);
      return;
    }
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      port = null;
      reject(new Error((e && e.message) || 'host unavailable'));
      return;
    }
    port.onMessage.addListener((resp) => {
      const entry = replyQueue.shift();
      if (entry) entry.resolve(resp);
    });
    port.onDisconnect.addListener(() => {
      const err =
        (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
        'host disconnected';
      port = null;
      while (replyQueue.length) {
        replyQueue.shift().reject(new Error(err));
      }
    });
    resolve(port);
  });
}

function sendNative(message) {
  return new Promise((resolve, reject) => {
    getPort()
      .then((p) => {
        replyQueue.push({ resolve, reject });
        // Safety net: a hung host must not leave callers waiting forever.
        // Audit: on timeout the host may STILL reply later — a late reply
        // would be dequeued by the NEXT request (reply-order desync). Kill
        // the port so onDisconnect drains and rejects the whole queue, and
        // the next call reconnects fresh.
        setTimeout(() => {
          const i = replyQueue.findIndex((entry) => entry.resolve === resolve);
          if (i >= 0) {
            replyQueue.splice(i, 1);
            reject(new Error('host reply timeout'));
            try {
              port.disconnect();
            } catch {
              /* already gone */
            }
            port = null;
          }
        }, 10000);
        try {
          p.postMessage(message);
        } catch (e) {
          const i = replyQueue.findIndex((entry) => entry.resolve === resolve);
          if (i >= 0) replyQueue.splice(i, 1);
          port = null; // force a reconnect on the next call
          reject(new Error((e && e.message) || 'postMessage failed'));
        }
      })
      .catch(reject);
  });
}

// Audit E-5: debounce rapid duplicate context-menu clicks — one accidental
// double-click must not enqueue the same URL twice (the backend dedups, but
// the second process spawn/download attempt is pure waste).
const lastSend = new Map();

chrome.contextMenus.onClicked.addListener((info) => {
  let url = null;
  if (info.menuItemId === MENU_LINK) url = info.linkUrl;
  else if (info.menuItemId === MENU_PAGE) url = info.pageUrl;
  else if (info.menuItemId === MENU_VIDEO) url = info.srcUrl || info.pageUrl;
  if (!url) return;
  const key = `${info.menuItemId}|${url}`;
  const now = Date.now();
  if (now - (lastSend.get(key) || 0) < 1500) return;
  lastSend.set(key, now);
  sendNative({ type: 'link', url, ts: Date.now() })
    .then((r) => console.log('[HaramLite Bridge] sent:', r))
    .catch((e) => console.error('[HaramLite Bridge] failed:', e.message));
});

// The popup asks whether the desktop bridge is reachable.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'status') {
    sendNative({ type: 'ping', ts: Date.now() })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep the channel open for the async reply
  }
  if (msg && msg.type === 'send') {
    // The popup may state a per-request mode (song/clip). Only those two travel:
    // anything else — absent, garbage — lets the app keep its own setting.
    const link = { type: 'link', url: msg.url, ts: Date.now() };
    if (msg.mode === 'song' || msg.mode === 'clip') link.mode = msg.mode;
    sendNative(link)
      .then((r) => sendResponse({ ok: true, reply: r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  // Relay for content scripts: sendNativeMessage is NOT exposed to content
  // scripts — they proxy arbitrary host messages through this worker.
  if (msg && msg.type === 'native' && msg.message) {
    sendNative(msg.message)
      .then((r) => sendResponse({ ok: true, resp: r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return undefined;
});
