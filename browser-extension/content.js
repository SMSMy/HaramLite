// HaramLite Bridge — YouTube content script (B4 hybrid).
// 1. A HaramLite button inside the player control bar (next to quality/CC).
// 2. Click → themed menu: «معالجة كاملة وحفظ» + «استماع مباشر (قريباً)».
// 3. Full processing → a themed mini panel pinned to the bottom of THIS
//    video page with a live progress bar (polls the desktop bridge state).
// No trackers. All communication goes through Native Messaging.

(() => {
  const HOST = 'com.harammute.haramlite';
  const BTN_ID = 'haramlite-yt-btn';
  const MENU_ID = 'haramlite-yt-menu';
  const PANEL_ID = 'haramlite-panel';

  const T = {
    bg: '#151311', panel: 'rgba(31,29,27,0.97)', border: '#2E2C29',
    accent: '#DA7756', text: '#F5F2ED', sub: '#A38C85', ok: '#5DDAC8', err: '#FFB4AB',
  };
  const STAGE_AR = {
    download: 'التنزيل', normalize: 'توحيد الصوت', separate: 'فصل الصوت',
    effects: 'المؤثرات', encode: 'الترميز',
  };
  const NOTE_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff" aria-hidden="true">' +
    '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

  function native(msg) {
    return new Promise((resolve, reject) => {
      // sendNativeMessage is not available to content scripts — proxy
      // through the background service worker.
      chrome.runtime.sendMessage({ type: 'native', message: msg }, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!resp || !resp.ok) reject(new Error((resp && resp.error) || 'فشل الاتصال'));
        else resolve(resp.resp || {});
      });
    });
  }

  /* ── player button ─────────────────────────────────────────────── */
  function makeButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'ytp-button';
    btn.title = 'HaramLite — عالج هذا الفيديو';
    btn.setAttribute('aria-label', 'HaramLite');
    btn.innerHTML = NOTE_SVG;
    btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;opacity:0.9;';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      toggleMenu(btn);
    });
    return btn;
  }

  /* ── themed menu (two options) ─────────────────────────────────── */
  let menuCloser = null;
  function closeMenu() {
    document.getElementById(MENU_ID)?.remove();
    // E-7: remove the document-level click listener too — no leaks.
    if (menuCloser) {
      document.removeEventListener('click', menuCloser);
      menuCloser = null;
    }
  }

  function toggleMenu(btn) {
    const existing = document.getElementById(MENU_ID);
    if (existing) { existing.remove(); return; }
    const r = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.style.cssText =
      `position:fixed;bottom:${window.innerHeight - r.top + 10}px;right:${window.innerWidth - r.right}px;` +
      `width:232px;background:${T.panel};border:1px solid ${T.border};border-radius:10px;` +
      `box-shadow:0 10px 28px rgba(0,0,0,.55);padding:6px;z-index:2147483001;` +
      `font-family:Roboto,Arial,sans-serif;direction:rtl;`;
    menu.innerHTML =
      `<button id="hl-menu-full" style="width:100%;padding:10px 10px;background:transparent;border:none;` +
      `color:${T.text};font-size:13px;font-weight:600;text-align:right;cursor:pointer;border-radius:6px;display:flex;gap:8px;align-items:center;">` +
      `💾 معالجة كاملة وحفظ</button>` +
      `<button id="hl-menu-live" style="width:100%;padding:10px 10px;background:transparent;border:none;` +
      `color:${T.sub};font-size:13px;text-align:right;cursor:pointer;border-radius:6px;display:flex;gap:8px;align-items:center;justify-content:space-between;">` +
      `<span>🎧 استماع مباشر بلا موسيقى</span>` +
      `<span style="font-size:10px;background:${T.border};color:${T.sub};padding:2px 7px;border-radius:8px;">قريباً</span></button>`;
    document.body.appendChild(menu);
    document.getElementById('hl-menu-full').addEventListener('click', () => {
      closeMenu();
      void startFull();
    });
    document.getElementById('hl-menu-live').addEventListener('click', () => {
      closeMenu();
      showPanel('ميزة الاستماع المباشر قيد البناء — ستتوفر في التحديث القادم إن شاء الله', true);
    });
    // outside click closes
    setTimeout(() => {
      if (!menu.isConnected) return; // menu already gone
      menuCloser = (e) => { if (!menu.contains(e.target)) closeMenu(); };
      document.addEventListener('click', menuCloser);
    }, 0);
  }

  /* ── themed mini panel (bottom of THIS page only) ──────────────── */
  let panelEls = null;
  function showPanel(statusText, isInfo = false) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.style.cssText =
        `position:fixed;bottom:16px;right:16px;width:320px;max-width:92vw;` +
        `background:${T.panel};border:1px solid ${T.border};border-radius:12px;` +
        `box-shadow:0 12px 32px rgba(0,0,0,.6);z-index:2147483000;padding:14px;` +
        `font-family:Roboto,Arial,sans-serif;direction:rtl;color:${T.text};`;
      panel.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">` +
        `<span style="font-weight:700;color:${T.accent};font-size:13px;">🎵 HaramLite</span>` +
        `<button id="hl-panel-close" style="background:none;border:none;color:${T.sub};cursor:pointer;font-size:16px;">✕</button></div>` +
        `<div id="hl-panel-name" style="font-size:12px;color:${T.sub};margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>` +
        `<div style="height:6px;background:${T.border};border-radius:3px;overflow:hidden;margin-bottom:6px;">` +
        `<div id="hl-panel-bar" style="height:100%;width:0%;background:${T.accent};transition:width .45s;"></div></div>` +
        `<div id="hl-panel-status" style="font-size:12px;color:${T.text};min-height:16px;"></div>` +
        `<div style="display:flex;gap:6px;margin-top:8px;">` +
        `<button id="hl-panel-open" style="display:none;flex:1;padding:8px;border-radius:8px;` +
        `border:1px solid ${T.accent};background:rgba(218,119,86,.15);color:#ffb59d;cursor:pointer;font-size:12px;font-weight:600;">` +
        `📂 فتح مجلد النتائج</button>` +
        `<button id="hl-panel-open-file" style="display:none;flex:1;padding:8px;border-radius:8px;` +
        `border:1px solid ${T.ok};background:rgba(93,218,200,.15);color:${T.ok};cursor:pointer;font-size:12px;font-weight:600;">` +
        `▶ فتح الفيديو</button>` +
        `<button id="hl-panel-cancel" style="display:none;flex:1;padding:8px;border-radius:8px;` +
        `border:1px solid ${T.err};background:rgba(255,180,171,.1);color:${T.err};cursor:pointer;font-size:12px;font-weight:600;">` +
        `⏹ إلغاء المعالجة</button></div>`;
      document.body.appendChild(panel);
      document.getElementById('hl-panel-close').addEventListener('click', () => {
        panel.remove();
        panelEls = null; // E-4: release the cached element refs for GC
      });
      document.getElementById('hl-panel-open').addEventListener('click', () => {
        native({ type: 'open_folder' }).catch(() => {});
      });
      document.getElementById('hl-panel-open-file').addEventListener('click', () => {
        native({ type: 'open_file' }).catch(() => {});
      });
      document.getElementById('hl-panel-cancel').addEventListener('click', () => {
        native({ type: 'cancel' }).catch(() => {});
      });
    }
    panelEls = {
      name: panel.querySelector('#hl-panel-name'),
      bar: panel.querySelector('#hl-panel-bar'),
      status: panel.querySelector('#hl-panel-status'),
      open: panel.querySelector('#hl-panel-open'),
      openFile: panel.querySelector('#hl-panel-open-file'),
      cancel: panel.querySelector('#hl-panel-cancel'),
    };
    panelEls.name.textContent = '';
    panelEls.bar.style.width = '0%';
    panelEls.status.textContent = statusText;
    panelEls.status.style.color = isInfo ? T.sub : T.text;
    panelEls.open.style.display = 'none';
    panelEls.openFile.style.display = 'none';
    panelEls.cancel.style.display = 'none';
  }

  /* ── full processing flow + live status polling ────────────────── */
  let pollTimer = null;
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function startFull() {
    stopPoll();
    showPanel('جاري الإرسال إلى HaramLite...');
    try {
      const r = await native({ type: 'link', url: location.href });
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'فشل الإرسال');
      if (panelEls) {
        panelEls.status.textContent = '✓ استُلم الرابط — بدء التنزيل...';
        panelEls.status.style.color = T.ok;
        panelEls.cancel.style.display = 'block';
      }
      poll();
    } catch (e) {
      stopPoll();
      if (panelEls) {
        panelEls.status.textContent = '⚠ ' + e.message;
        panelEls.status.style.color = T.err;
        panelEls.cancel.style.display = 'none'; // nothing is running
      }
    }
  }

  function poll() {
    let shownDone = false;
    let sawRunning = false; // E-6: never show an OLD job's "done" state
    let fails = 0;
    pollTimer = setInterval(async () => {
      try {
        const r = await native({ type: 'status' });
        fails = 0; // healthy again
        const st = (r && r.state) || {};
        if (st.running) {
          sawRunning = true;
          const { name, stage, pct } = st.running;
          const q = st.queue || 0;
          if (panelEls) {
            panelEls.name.textContent = name || '';
            panelEls.bar.style.width = `${Math.round((pct || 0) * 100)}%`;
            panelEls.status.textContent =
              `${STAGE_AR[stage] || stage || 'معالجة'} — ${Math.round((pct || 0) * 100)}%` +
              (q > 0 ? ` · في الطابور بعد هذا: ${q}` : '');
            panelEls.status.style.color = T.text;
          }
        } else if (st.last && sawRunning && !shownDone) {
          shownDone = true;
          stopPoll();
          if (panelEls) {
            panelEls.bar.style.width = '100%';
            // completed — a cancel button makes no sense here
            panelEls.cancel.style.display = 'none';
            if (st.last.ok) {
              panelEls.status.textContent = `✓ اكتملت المعالجة في ${(st.last.seconds || 0).toFixed(1)} ثانية`;
              panelEls.status.style.color = T.ok;
              panelEls.open.style.display = 'block';
              panelEls.openFile.style.display = 'block';
            } else {
              panelEls.status.textContent = '✗ ' + (st.last.error || 'فشلت المعالجة');
              panelEls.status.style.color = T.err;
            }
          }
        }
      } catch {
        // Audit E-2: give up after 8 consecutive failures instead of
        // polling forever against a dead bridge.
        fails += 1;
        if (fails >= 8) {
          stopPoll();
          if (panelEls) {
            panelEls.status.textContent =
              '⚠ انقطع الاتصال بتطبيق HaramLite — شغّل التطبيق وفعّل التكامل ثم أعد المحاولة';
            panelEls.status.style.color = T.err;
          }
        }
      }
    }, 1500);
  }

  /* ── injection loop (SPA-safe) ─────────────────────────────────── */
  function tryInject() {
    if (document.getElementById(BTN_ID)) return true;
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return false;
    controls.prepend(makeButton());
    return true;
  }

  // Audit E-3: YouTube is an SPA — navigation rebuilds the player controls
  // and the button vanishes. Re-inject on `yt-navigate-finish` AND watch the
  // player container (NOT document.body — a body-wide subtree observer fires
  // on every progress-bar/comment mutation and drains CPU). Fall back to body
  // only if the player isn't there yet.
  let injectScheduled = false;
  function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = true;
    setTimeout(() => {
      injectScheduled = false;
      tryInject();
    }, 200);
  }
  window.addEventListener('yt-navigate-finish', scheduleInject);
  window.addEventListener('yt-page-data-updated', scheduleInject);
  const watchRoot = document.querySelector('#movie_player') || document.body;
  const domObserver = new MutationObserver(scheduleInject);
  domObserver.observe(watchRoot, { childList: true, subtree: true });

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (tryInject() || tries > 120) clearInterval(timer);
  }, 1000);
})();
