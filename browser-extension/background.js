// HaramLite Bridge — MV3 service worker.
// Sends links to the desktop app through Native Messaging only.
// No trackers, no analytics, no network requests besides the host.

const HOST = 'com.harammute.haramlite';
const MENU_LINK = 'hl-send-link';
const MENU_PAGE = 'hl-send-page';
const MENU_VIDEO = 'hl-send-video';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: 'أرسل الرابط إلى HaramLite',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: 'أرسل هذه الصفحة إلى HaramLite',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_VIDEO,
      title: 'أرسل الفيديو إلى HaramLite',
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
        setTimeout(() => {
          const i = replyQueue.findIndex((entry) => entry.resolve === resolve);
          if (i >= 0) {
            replyQueue.splice(i, 1);
            reject(new Error('host reply timeout'));
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
    sendNative({ type: 'link', url: msg.url, ts: Date.now() })
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
