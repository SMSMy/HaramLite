// HaramLite Bridge — YouTube content script.
// Decision 3 (2026-09-06): ONE button in the page requesting the file
// pipeline (the old two-item menu, including the dead "live" entry, is
// gone with the hidden live card). On completion the page can watch the
// FILTERED output in sync (simplified dual-player: page video muted +
// filtered audio element, rate/volume mirrored, clean restore).
// No chunk streaming, no time-stretching, no telemetry — local only.
// 1. A HaramLite button inside the player control bar (next to quality/CC).
// 2. Click → the desktop file pipeline (download + full processing).
// 3. Done → a themed mini panel: watch filtered in-page, or open results.
// No trackers. All communication goes through Native Messaging.

(() => {
  const HOST = 'com.harammute.haramlite';
  const BTN_ID = 'haramlite-yt-btn';
  const PANEL_ID = 'haramlite-panel';
  const BADGE_ID = 'haramlite-watch-badge';

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
      // Decision 3: one button → the file pipeline directly.
      void startFull();
    });
    return btn;
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
        `<div id="hl-panel-prov" style="font-size:11px;color:${T.sub};min-height:14px;"></div>` +
        `<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">` +
        `<button id="hl-panel-watch" style="display:none;flex:1;padding:8px;border-radius:8px;` +
        `border:1px solid ${T.accent};background:rgba(218,119,86,.2);color:#ffb59d;cursor:pointer;font-size:12px;font-weight:700;">` +
        `▶ مشاهدة مفلترة في الصفحة</button>` +
        `<button id="hl-panel-reprocess" style="display:none;flex:1;padding:8px;border-radius:8px;` +
        `border:1px solid ${T.border};background:transparent;color:${T.sub};cursor:pointer;font-size:12px;">` +
        `↻ معالجة كاملة</button>` +
        `<button id="hl-panel-stopwatch" style="display:none;flex:1;padding:8px;border-radius:8px;` +
        `border:1px solid ${T.err};background:rgba(255,180,171,.1);color:${T.err};cursor:pointer;font-size:12px;font-weight:600;">` +
        `⏹ إيقاف المشاهدة</button>` +
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
      document.getElementById('hl-panel-watch').addEventListener('click', () => {
        void startWatch();
      });
      document.getElementById('hl-panel-reprocess').addEventListener('click', () => {
        stopWatch();
        void startFull();
      });
      document.getElementById('hl-panel-stopwatch').addEventListener('click', () => {
        stopWatch();
      });
    }
    panelEls = {
      name: panel.querySelector('#hl-panel-name'),
      bar: panel.querySelector('#hl-panel-bar'),
      status: panel.querySelector('#hl-panel-status'),
      prov: panel.querySelector('#hl-panel-prov'),
      open: panel.querySelector('#hl-panel-open'),
      openFile: panel.querySelector('#hl-panel-open-file'),
      cancel: panel.querySelector('#hl-panel-cancel'),
      watch: panel.querySelector('#hl-panel-watch'),
      reprocess: panel.querySelector('#hl-panel-reprocess'),
      stopwatch: panel.querySelector('#hl-panel-stopwatch'),
    };
    panelEls.name.textContent = '';
    panelEls.bar.style.width = '0%';
    panelEls.status.textContent = statusText;
    panelEls.status.style.color = isInfo ? T.sub : T.text;
    panelEls.prov.textContent = '';
    panelEls.open.style.display = 'none';
    panelEls.openFile.style.display = 'none';
    panelEls.cancel.style.display = 'none';
    panelEls.watch.style.display = 'none';
    panelEls.reprocess.style.display = 'none';
    panelEls.stopwatch.style.display = 'none';
  }

  /* ── full processing flow + live status polling ────────────────── */
  let pollTimer = null;
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function startFull() {
    stopPoll();
    stopWatch();
    LAST = null;
    // Field #1/#4: pause the page at once — the goal is hearing no music.
    // Failures leave it paused with a message (YouTube's own play button
    // resumes the original); success auto-watches (see poll).
    const pv = pageVideo();
    WANT_AUTO = true;
    SENT_URL = location.href;
    if (pv) { try { pv.pause(); } catch { /* gone */ } }
    showPanel('جاري الإرسال إلى HaramLite...');
    try {
      const r = await native({ type: 'link', url: location.href, mode: 'watch' });
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
        // Decision 3 + expert D2د: provider badge (CPU honesty — no live
        // inference exists, file watching works the same; durations measured).
        if (panelEls && panelEls.prov) {
          const prov = r && r.provider ? String(r.provider) : '';
          panelEls.prov.textContent = prov === 'CPU'
            ? 'وضع CPU — المعالجة أبطأ، والمدة المقاسة تُعلن عند الاكتمال'
            : (prov ? `المزود: ${prov}` : '');
        }
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
              // Decision 3: watch-filtered + manual full-process side by side.
              LAST = {
                seconds: st.last.seconds || 0,
                kept: Array.isArray(st.last.kept) ? st.last.kept : null,
              };
              // Field #1: our own job on this same page → watch at once,
              // no questions asked. Foreign jobs keep the manual buttons.
              if (WANT_AUTO && location.href === SENT_URL) {
                WANT_AUTO = false;
                void startWatch();
              } else {
                WANT_AUTO = false;
                panelEls.watch.style.display = 'block';
                panelEls.reprocess.style.display = 'block';
              }
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

  /* ── simplified dual-player: muted page video + filtered audio ──── */
  // The finished file pipeline left page-audio on the desktop; the page
  // fetches it ONCE (bounded slices, size-verified — file DELIVERY, never
  // live/chunked streaming) and plays it through an <audio> element synced
  // to the page <video>: play/pause/seek/rate/volume mirror + drift fix.
  // Song outputs carry kept-ranges so mirrored silence cuts stay mapped;
  // without them the timelines must coincide (±2s) or watching is refused
  // with a clear message + file fallback. Restore is total.
  let LAST = null;
  let WATCH = null;
  // Field issues #1/#4: this page auto-watches ITS OWN completed job only.
  let WANT_AUTO = false;
  let SENT_URL = null;

  function hexToBytes(hex) {
    const n = hex.length / 2;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function setWatchStatus(msg, color) {
    if (panelEls) {
      panelEls.status.textContent = msg;
      panelEls.status.style.color = color || T.text;
    }
  }

  // Full-timeline seconds → cut-timeline seconds through kept ranges.
  function mapFullToCut(t, kept) {
    if (!kept || !kept.length) return t;
    let acc = 0;
    for (const pair of kept) {
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!(b > a)) continue;
      if (t <= a) break;
      acc += Math.min(t, b) - a;
    }
    return acc;
  }

  // Field #6: where the page video must jump — inside a kept range it stays,
  // inside a muted gap it jumps to the next kept start, past the end stays.
  function skipVideoGaps(t, kept) {
    if (!kept || !kept.length) return t;
    for (const pair of kept) {
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!(b > a)) continue;
      if (t >= a && t < b) return t;
      if (t < a) return a;
    }
    return t;
  }

  function pageVideo() {
    return document.querySelector('#movie_player video') || document.querySelector('video');
  }

  async function fetchPageAudio() {
    const parts = [];
    let offset = 0;
    let total = 0;
    for (;;) {
      const r = await native({ type: 'result_file', offset, len: 262144 });
      const f = r && r.file;
      if (!f || typeof f.data !== 'string') throw new Error('رد فارغ من التطبيق — أعد المحاولة');
      total = f.total || 0;
      parts.push(f.data);
      offset = f.offset + f.data.length / 2;
      if (panelEls) panelEls.bar.style.width = `${total > 0 ? Math.round((offset / total) * 100) : 0}%`;
      if (f.done) break;
      if (total > 0 && offset >= total) break; // safety net
    }
    const flat = parts.join('');
    if (total > 0 && flat.length / 2 !== total) throw new Error('ملف ناقص — أعد المحاولة');
    return URL.createObjectURL(new Blob([hexToBytes(flat)], { type: 'audio/mpeg' }));
  }

  function showBadge(show) {
    let badge = document.getElementById(BADGE_ID);
    if (show) {
      if (!badge) {
        badge = document.createElement('div');
        badge.id = BADGE_ID;
        badge.style.cssText =
          `position:fixed;top:64px;right:16px;z-index:2147483002;background:rgba(21,19,17,.95);` +
          `border:1px solid ${T.accent};border-radius:10px;padding:8px 12px;color:${T.text};` +
          `font-family:Roboto,Arial,sans-serif;font-size:12px;direction:rtl;`;
        document.body.appendChild(badge);
      }
      badge.textContent = '🔇 الفيديو الأصلي مكتوم — الصوت المفلتر يعمل (كتم معلن)';
      badge.style.display = '';
    } else if (badge) {
      badge.remove();
    }
  }

  async function startWatch() {
    if (WATCH) return;
    const video = pageVideo();
    if (!video) {
      setWatchStatus('✗ لم يُعثر على فيديو الصفحة', T.err);
      return;
    }
    setWatchStatus('جارٍ جلب الصوت المفلتر من التطبيق...');
    if (panelEls) {
      panelEls.watch.style.display = 'none';
      panelEls.bar.style.width = '0%';
    }
    let url = null;
    try {
      url = await fetchPageAudio();
    } catch (e) {
      setWatchStatus('✗ ' + (e && e.message ? e.message : 'تعذر الجلب'), T.err);
      if (panelEls) panelEls.watch.style.display = 'block';
      return;
    }
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = url;
    try {
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('تعذر قراءة الصوت المفلتر')), 15000);
        audio.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
        audio.addEventListener('error', () => { clearTimeout(to); reject(new Error('صيغة غير مدعومة في المتصفح')); }, { once: true });
      });
    } catch (e) {
      URL.revokeObjectURL(url);
      setWatchStatus('✗ ' + e.message, T.err);
      if (panelEls) panelEls.watch.style.display = 'block';
      return;
    }
    // Duration gate: song outputs mirror silence cuts (mapped via kept);
    // without kept-ranges the timelines must coincide.
    const kept = LAST && LAST.kept;
    if ((!kept || !kept.length) && video.duration && audio.duration &&
        Math.abs(video.duration - audio.duration) > 2) {
      URL.revokeObjectURL(url);
      setWatchStatus('✗ إخراج مقصوص الصمت بلا خريطة — افتح الملف بدلاً من ذلك', T.err);
      if (panelEls) {
        panelEls.watch.style.display = 'none';
        panelEls.openFile.style.display = 'block';
      }
      return;
    }
    const w = {
      audio, url, video,
      prevMuted: video.muted,
      handlers: [],
      drift: 0,
      gap: 0,
    };
    const on = (el, ev, fn) => { el.addEventListener(ev, fn); w.handlers.push([el, ev, fn]); };
    const audioPos = () => {
      const t = mapFullToCut(video.currentTime || 0, kept);
      return Math.min(Math.max(t, 0), Math.max(audio.duration - 0.05, 0));
    };
    on(video, 'play', () => {
      // Field #2: the page player fights mute — pin it on every play.
      if (video.muted === false) { try { video.muted = true; } catch { /* gone */ } }
      kickAudio();
    });
    on(video, 'pause', () => { audio.pause(); });
    on(video, 'seeking', () => { audio.currentTime = audioPos(); });
    on(video, 'ratechange', () => { audio.playbackRate = video.playbackRate || 1; });
    on(video, 'volumechange', () => {
      // Field #2: volume gestures unmute the page player — pin it, then mirror.
      if (video.muted === false) { try { video.muted = true; } catch { /* gone */ } }
      audio.volume = video.volume;
    });
    on(audio, 'ended', () => {
      // Filtered audio over: stop the picture too, or the tail would run on
      // and restore into unmuted original audio past the map.
      try { video.pause(); } catch { /* gone */ }
      stopWatch();
    });
    on(video, 'ended', () => { stopWatch(); });
    // Declared mute (expert D2د): the ORIGINAL stays muted, announced.
    video.muted = true;
    showBadge(true);
    audio.playbackRate = video.playbackRate || 1;
    audio.volume = video.volume;
    const watchLine = () => `▶ مشاهدة مفلترة — الصوت من المعالجة المحلية${LAST && LAST.seconds ? ` (عولجت في ${LAST.seconds.toFixed(1)} ث)` : ''}`;
    const kickAudio = () => {
      audio.currentTime = audioPos();
      audio.play().then(() => {
        if (WATCH) setWatchStatus(watchLine(), T.ok);
      }).catch(() => {
        // No user activation (timer-started autoplay): the next press of
        // play IS a gesture and retries through the play-handler above.
        if (WATCH) setWatchStatus('▶ اضغط تشغيل لبدء الصوت المفلتر', T.sub);
      });
    };
    audio.currentTime = audioPos();
    WATCH = w;
    w.drift = setInterval(() => {
      if (!WATCH || audio.paused) return;
      // Field #2, second pin: scripts can unmute at any time.
      if (video.muted === false) { try { video.muted = true; } catch { /* gone */ } }
      const expect = audioPos();
      if (Math.abs(audio.currentTime - expect) > 0.35) audio.currentTime = expect;
    }, 1000);
    // Field #6: TRUE skipping — the page video itself jumps over muted gaps
    // (mapping audio alone only loops the seam). >0.15s jumps, 250ms cadence.
    w.gap = setInterval(() => {
      if (!WATCH || video.paused) return;
      const target = skipVideoGaps(video.currentTime || 0, kept);
      if (Math.abs(target - (video.currentTime || 0)) > 0.15) {
        try { video.currentTime = target; } catch { /* gone */ }
      }
    }, 250);
    if (panelEls) {
      panelEls.stopwatch.style.display = 'block';
      panelEls.watch.style.display = 'none';
    }
    setWatchStatus(watchLine(), T.ok);
    // Field #1/#4: resume both together (the video was paused at request).
    try { await video.play(); } catch { setWatchStatus('▶ اضغط تشغيل الفيديو لبدء المشاهدة', T.sub); }
    kickAudio();
  }

  function stopWatch() {
    const w = WATCH;
    WATCH = null;
    if (!w) return;
    if (w.drift) clearInterval(w.drift);
    if (w.gap) clearInterval(w.gap);
    for (const [el, ev, fn] of w.handlers) {
      try { el.removeEventListener(ev, fn); } catch { /* gone */ }
    }
    try { w.audio.pause(); } catch { /* gone */ }
    try { w.video.muted = w.prevMuted; } catch { /* gone */ }
    try { URL.revokeObjectURL(w.url); } catch { /* gone */ }
    showBadge(false);
    if (panelEls) {
      panelEls.stopwatch.style.display = 'none';
      if (LAST) panelEls.watch.style.display = 'block';
      setWatchStatus('⏹ توقفت المشاهدة — عاد صوت الصفحة الأصلي', T.sub);
    }
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
  window.addEventListener('yt-navigate-finish', stopWatch);
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
