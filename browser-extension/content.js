// HaramLite Bridge — YouTube content script.
// Two bar buttons, no panels, no questions asked:
//   1. Download+Process — idle ("حمّل وعالج") → click starts (video paused,
//      live % on the button) → click while busy cancels + resets → done dims
//      ("تم التجهيز") and enables Watch.
//   2. Watch — disabled until ready → enabled ("شاهد مفلتراً") → click
//      applies the filter and plays (active color) → second click stops and
//      restores the original. Manual only — nothing auto-applies.
// Filtered watching: page video muted + filtered audio element, playback
// rate pinned at 1x on both sides (+ player API guard). The removed stretches
// — the silence left by muting the music — are SKIPPED: the page video jumps
// over each one while the filtered audio (which contains no such stretch)
// plays on untouched, so both stay in step. Unticking the option holds the
// audio at the seam instead and lets the picture play the silent stretch
// through. Drift backstop without forced sync while stopped, clean restore.
// Right-click Watch for options (gap-skip default on + full reprocess).
// 2s fading toast.
// No chunk streaming, no time-stretching, no telemetry — local only.
// No trackers. All communication goes through Native Messaging.

(() => {
  const BTN_PROC = 'haramlite-yt-proc';
  const BTN_WATCH = 'haramlite-yt-watch';
  const MENU_ID = 'haramlite-yt-watchmenu';
  const TOAST_ID = 'haramlite-toast';

  const T = {
    panel: 'rgba(31,29,27,0.97)', border: '#2E2C29',
    accent: '#DA7756', text: '#F5F2ED', sub: '#A38C85', ok: '#5DDAC8', err: '#FFB4AB',
  };

  let procBtn = null;
  let watchBtn = null;
  let menuCloser = null;
  let toastTimer = 0;
  let BUSY = false;
  let LAST = null;
  let WATCH = null;
  let SENT_URL = null;

  // Match a completion to THIS page by video identity — output FILE names
  // derive from video titles (not ids), so name-matching would misfire.
  function vidOf(u) {
    if (!u || typeof u !== 'string') return null;
    let m = u.match(/[?&]v=([^&#]+)/);
    if (m) return m[1];
    m = u.match(/youtu\.be\/([^?&#/]+)/);
    if (m) return m[1];
    m = u.match(/\/(shorts|embed|live)\/([^?&#/]+)/);
    if (m) return m[2];
    return null;
  }
  function sameVideo(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const va = vidOf(a);
    const vb = vidOf(b);
    return !!va && va === vb;
  }

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

  /* ── fading toast ──────────────────────────────────────────────── */
  function toast(msg, ms) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      el.style.cssText =
        `position:fixed;bottom:72px;right:16px;z-index:2147483002;max-width:min(360px,90vw);` +
        `background:rgba(21,19,17,.96);border:1px solid ${T.border};border-radius:10px;` +
        `padding:8px 12px;color:${T.text};font-family:Roboto,Arial,sans-serif;` +
        `font-size:12px;direction:rtl;transition:opacity .4s;`;
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, ms || 2000);
  }

  /* ── bar buttons ───────────────────────────────────────────────── */
  function barBtnBase() {
    return 'display:inline-flex;align-items:center;justify-content:center;' +
      'font-family:Roboto,Arial,sans-serif;font-size:13px;font-weight:600;white-space:nowrap;' +
      'border:1px solid transparent;border-radius:16px;padding:0 14px;margin:0 4px;cursor:pointer;' +
      'width:auto;height:32px;vertical-align:middle;box-sizing:border-box;transition:all 0.2s;' +
      'background:rgba(21,19,17,.94);box-shadow:0 1px 8px rgba(0,0,0,.55);' +
      'text-shadow:0 1px 2px rgba(0,0,0,.7);';
  }
  function makeProcBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_PROC;
    btn.type = 'button';
    btn.className = 'ytp-button';
    btn.setAttribute('aria-label', 'HaramLite: download and process');
    btn.style.cssText = barBtnBase();
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (BUSY) doCancel();
      else void startFull();
    });
    return btn;
  }
  function makeWatchBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_WATCH;
    btn.type = 'button';
    btn.className = 'ytp-button';
    btn.setAttribute('aria-label', 'HaramLite: watch filtered');
    btn.style.cssText = barBtnBase();
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (WATCH) stopWatch();
      else void startWatch();
    });
    // Options live on right-click: visible gap-skip + full reprocess.
    btn.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleWatchMenu(btn);
    });
    return btn;
  }
  function setProc(state, pct) {
    if (!procBtn) return;
    if (state === 'working') {
      procBtn.disabled = false;
      procBtn.style.opacity = '';
      procBtn.style.background = 'rgba(21,19,17,.94)';
      procBtn.style.borderColor = T.accent;
      procBtn.style.color = '#fff';
      procBtn.textContent = `${Math.round((pct || 0) * 100)}%`;
      procBtn.title = 'HaramLite — جارٍ العمل (نقرة للإلغاء)';
    } else if (state === 'done') {
      procBtn.disabled = true;
      procBtn.style.opacity = '0.55';
      procBtn.style.background = 'rgba(21,19,17,.94)';
      procBtn.style.borderColor = T.accent;
      procBtn.style.color = T.text;
      procBtn.textContent = 'تم التجهيز ✓';
      procBtn.title = 'HaramLite — جاهز للمشاهدة';
    } else {
      procBtn.disabled = false;
      procBtn.style.opacity = '';
      procBtn.style.background = 'rgba(21,19,17,.94)';
      procBtn.style.borderColor = T.accent;
      procBtn.style.color = T.text;
      procBtn.textContent = 'حمّل وعالج ⬇';
      procBtn.title = 'HaramLite — حمّل وعالج هذا الفيديو';
    }
  }
  function setWatchBtn(state) {
    if (!watchBtn) return;
    if (state === 'ready') {
      watchBtn.disabled = false;
      watchBtn.style.opacity = '';
      watchBtn.style.background = 'rgba(21,19,17,.94)';
      watchBtn.style.borderColor = T.accent;
      watchBtn.style.color = '#ffb59d';
      watchBtn.textContent = 'شاهد مفلتراً ▶';
      watchBtn.title = 'HaramLite — مشاهدة مفلترة';
    } else if (state === 'watching') {
      watchBtn.disabled = false;
      watchBtn.style.opacity = '';
      watchBtn.style.background = 'rgba(218,119,86,.6)';
      watchBtn.style.borderColor = T.accent;
      watchBtn.style.color = '#fff';
      watchBtn.textContent = '⏸ إيقاف';
      watchBtn.title = 'HaramLite — إيقاف المشاهدة المفلترة';
    } else if (state === 'fetching') {
      watchBtn.disabled = true;
      watchBtn.style.opacity = '0.75';
      watchBtn.style.background = 'rgba(21,19,17,.94)';
      watchBtn.style.borderColor = T.accent;
      watchBtn.textContent = 'جارٍ الجلب…';
      watchBtn.title = 'HaramLite — جلب الصوت المفلتر';
    } else {
      watchBtn.disabled = true;
      watchBtn.style.opacity = '0.55';
      watchBtn.style.background = 'rgba(21,19,17,.94)';
      watchBtn.style.borderColor = '#5a544f';
      watchBtn.style.color = '#d8d2cc';
      watchBtn.textContent = 'شاهد مفلتراً ▶';
      watchBtn.title = 'HaramLite — يفعَّل بعد التجهيز';
    }
  }
  function resetBar() {
    BUSY = false;
    LAST = null;
    setProc('idle');
    setWatchBtn('disabled');
  }

  /* ── watch secondary menu (right-click): options ───────────────── */
  function closeWatchMenu() {
    document.getElementById(MENU_ID)?.remove();
    if (menuCloser) {
      document.removeEventListener('click', menuCloser);
      menuCloser = null;
    }
  }
  function toggleWatchMenu(anchor) {
    if (document.getElementById(MENU_ID)) { closeWatchMenu(); return; }
    const r = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.style.cssText =
      `position:fixed;bottom:${window.innerHeight - r.top + 8}px;right:${window.innerWidth - r.right}px;` +
      `min-width:210px;background:${T.panel};border:1px solid ${T.border};border-radius:10px;` +
      `box-shadow:0 10px 28px rgba(0,0,0,.55);padding:8px;z-index:2147483003;` +
      `font-family:Roboto,Arial,sans-serif;font-size:12px;direction:rtl;color:${T.text};`;
    menu.innerHTML =
      `<label style="display:flex;align-items:center;gap:8px;padding:8px 6px;cursor:pointer;">` +
      `<input type="checkbox" id="hl-ext-skipgaps" style="accent-color:${T.accent};" />` +
      `<span>تخطي الصمت (قفز الفيديو فوقه)</span></label>` +
      `<button id="hl-ext-reprocess" style="width:100%;padding:8px 6px;background:transparent;border:none;` +
      `border-top:1px solid ${T.border};color:${T.sub};font-size:12px;text-align:right;cursor:pointer;">` +
      `↻ معالجة كاملة</button>`;
    document.body.appendChild(menu);
    const skipBox = menu.querySelector('#hl-ext-skipgaps');
    skipBox.checked = SKIP_GAPS;
    skipBox.addEventListener('change', () => setSkipGaps(skipBox.checked));
    menu.querySelector('#hl-ext-reprocess').addEventListener('click', () => {
      closeWatchMenu();
      stopWatch(true);
      resetBar();
      void startFull();
    });
    setTimeout(() => {
      if (!menu.isConnected) return;
      menuCloser = (e) => { if (!menu.contains(e.target)) closeWatchMenu(); };
      document.addEventListener('click', menuCloser);
    }, 0);
  }
  // Gap-skip is a real, PERSISTED option. Reading the menu checkbox alone was
  // silently wrong: the menu is removed when it closes, so an untick survived
  // only until the next click outside.
  let SKIP_GAPS = true;
  try { SKIP_GAPS = localStorage.getItem('hl.skipgaps') !== '0'; } catch { /* storage blocked */ }
  function skipChecked() { return SKIP_GAPS; }
  function setSkipGaps(v) {
    SKIP_GAPS = !!v;
    try { localStorage.setItem('hl.skipgaps', SKIP_GAPS ? '1' : '0'); } catch { /* storage blocked */ }
  }

  /* ── request + poll (buttons only, no panels) ──────────────────── */
  let pollTimer = null;
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function startFull() {
    if (BUSY) return;
    stopWatch(true);
    resetBar();
    // Pause the page at once — the goal is hearing no music. Failures leave
    // it paused with a message (YouTube's own play button resumes the
    // original); completion waits for the manual watch button.
    const pv = pageVideo();
    if (pv) { try { pv.pause(); } catch { /* gone */ } }
    SENT_URL = location.href;
    let r = null;
    try {
      r = await native({ type: 'link', url: location.href, mode: 'watch' });
    } catch (e) {
      toast('⚠ ' + (e && e.message ? e.message : 'فشل الإرسال'), 4000);
      return;
    }
    if (!r || !r.ok) {
      toast('✗ ' + ((r && r.error) || 'فشل الإرسال'), 4000);
      return;
    }
    BUSY = true;
    setProc('working', 0);
    toast('✓ استُلم الرابط — بدء التنزيل...');
    poll();
  }

  function doCancel() {
    native({ type: 'cancel' }).catch(() => {});
    stopPoll();
    resetBar();
    toast('⏹ أُلغيت المعالجة — اضغط للبدء من جديد');
  }

  function poll() {
    let sawRunning = false; // never show an OLD job's terminal state
    let fails = 0;
    pollTimer = setInterval(async () => {
      try {
        const r = await native({ type: 'status' });
        fails = 0; // healthy again
        const st = (r && r.state) || {};
        if (!BUSY) return; // foreign jobs never touch our buttons
        if (st.running) {
          sawRunning = true;
          setProc('working', (st.running && st.running.pct) || 0);
        } else if (st.last && (sawRunning || sameVideo(SENT_URL, st.last.url))) {
          // Fast jobs can finish between 1.5s polls unseen — the recorded
          // request URL (not the title-derived filename) proves ownership.
          stopPoll();
          stopPoll();
          BUSY = false;
          if (st.last.ok) {
            LAST = {
              seconds: st.last.seconds || 0,
              kept: Array.isArray(st.last.kept) ? st.last.kept : null,
            };
            setProc('done');
            setWatchBtn('ready');
            toast('تم التجهيز ✓ — شاهد مفلتراً ▶');
          } else {
            resetBar();
            toast('✗ ' + (st.last.error || 'فشلت المعالجة'), 4000);
          }
        }
      } catch {
        // Give up after 8 consecutive failures instead of polling forever
        // against a dead bridge.
        fails += 1;
        if (fails >= 8) {
          stopPoll();
          resetBar();
          toast('⚠ انقطع الاتصال بتطبيق HaramLite — شغّل التطبيق وفعّل التكامل ثم أعد المحاولة', 4000);
        }
      }
    }, 1500);
  }

  /* ── filtered watching (no video jumping) ──────────────────────── */
  // The finished pipeline left page-audio on the desktop; the page fetches
  // it ONCE (bounded slices, size-verified — file DELIVERY, never live or
  // chunked streaming) into an <audio> element synced to the page <video>.
  // Rate pinned at 1x on both sides (+ player API guard). Muted gaps hold
  // the audio with edge-snapped resume; the drift backstop never forces a
  // sync while stopped. Restore is total.

  function hexToBytes(hex) {
    const n = hex.length / 2;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
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

  // True while the position sits inside a muted gap (kept-ranges known).
  function isGap(t, kept) {
    if (!kept || !kept.length) return false;
    for (const pair of kept) {
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!(b > a)) continue;
      if (t >= a && t < b) return false;
    }
    return true;
  }

  // Where the page video must jump: inside a kept range it stays put, inside a
  // removed stretch (music-only — the silence muting the music leaves behind)
  // it jumps to the next kept start, past the last range it stays. Jumping the
  // PICTURE is what makes the skip real: the filtered audio has the stretch
  // cut out of it, so mapping the audio alone just loops the seam.
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

  function pinPlayerRate() {
    try {
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.setPlaybackRate === 'function') mp.setPlaybackRate(1);
    } catch { /* gone */ }
  }

  async function fetchPageAudio(onProg) {
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
      if (onProg) onProg(total > 0 ? offset / total : 0);
      if (f.done) break;
      if (total > 0 && offset >= total) break; // safety net
    }
    const flat = parts.join('');
    if (total > 0 && flat.length / 2 !== total) throw new Error('ملف ناقص — أعد المحاولة');
    return URL.createObjectURL(new Blob([hexToBytes(flat)], { type: 'audio/mpeg' }));
  }

  function watchLine() {
    return `▶ مشاهدة مفلترة — الصوت من المعالجة المحلية${LAST && LAST.seconds ? ` (عولجت في ${LAST.seconds.toFixed(1)} ث)` : ''}`;
  }

  async function startWatch() {
    if (WATCH) return;
    if (!LAST) {
      toast('✗ ابنِ الخريطة أولاً — اضغط «حمّل وعالج»', 4000);
      return;
    }
    const video = pageVideo();
    if (!video) {
      toast('✗ لم يُعثر على فيديو الصفحة', 4000);
      return;
    }
    setWatchBtn('fetching');
    let url = null;
    try {
      url = await fetchPageAudio((p) => {
        if (watchBtn) watchBtn.textContent = `جارٍ الجلب… ${Math.round(p * 100)}%`;
      });
    } catch (e) {
      setWatchBtn('ready');
      toast('✗ ' + (e && e.message ? e.message : 'تعذر الجلب'), 4000);
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
      setWatchBtn('ready');
      toast('✗ ' + e.message, 4000);
      return;
    }
    // Duration gate: song outputs mirror silence cuts (mapped via kept);
    // without kept-ranges the timelines must coincide.
    const kept = LAST.kept;
    if ((!kept || !kept.length) && video.duration && audio.duration &&
        Math.abs(video.duration - audio.duration) > 2) {
      URL.revokeObjectURL(url);
      setWatchBtn('ready');
      toast('✗ إخراج مقصوص الصمت بلا خريطة — اطلب المعالجة من جديد', 4000);
      return;
    }
    const w = {
      audio, url, video,
      prevMuted: video.muted,
      prevRate: video.playbackRate || 1,
      handlers: [],
      drift: 0,
      held: false,
    };
    const on = (el, ev, fn) => { el.addEventListener(ev, fn); w.handlers.push([el, ev, fn]); };
    const audioPos = () => {
      const t = mapFullToCut(video.currentTime || 0, kept);
      return Math.min(Math.max(t, 0), Math.max(audio.duration - 0.05, 0));
    };
    const kickAudio = () => {
      audio.currentTime = audioPos();
      audio.play().then(() => {
        if (WATCH) toast(watchLine());
      }).catch(() => {
        // No user activation (timer-started autoplay): the next press of
        // play IS a gesture and retries through the play-handler below.
        if (WATCH) toast('▶ اضغط تشغيل لبدء الصوت المفلتر', 4000);
      });
    };
    on(video, 'play', () => {
      // The page player fights mute — pin it on every play.
      if (video.muted === false) { try { video.muted = true; } catch { /* gone */ } }
      kickAudio();
    });
    on(video, 'pause', () => { audio.pause(); });
    on(video, 'seeking', () => {
      const now = video.currentTime || 0;
      if (isGap(now, kept)) {
        w.held = true;
        try { audio.pause(); } catch { /* gone */ }
      } else {
        w.held = false;
        const want = audioPos();
        // Same tolerance as the drift backstop, and for the same reason: our
        // own gap jump moves the picture over time the cut audio does not
        // contain, so the mapped position barely moves — re-anchoring there
        // would rewind ~0.2s of sound at every gap edge. Only a real seek
        // lands far enough away to need correcting.
        if (Math.abs(audio.currentTime - want) > 0.35) audio.currentTime = want;
      }
    });
    on(video, 'ratechange', () => {
      // Guard both sides at 1.0 for the whole watch (anti-2x).
      if (video.playbackRate !== 1) { try { video.playbackRate = 1; } catch { /* gone */ } }
      pinPlayerRate();
      audio.playbackRate = 1;
    });
    on(video, 'volumechange', () => {
      // Volume gestures unmute the page player — pin it, then mirror.
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
    // Declared mute + 1x clamp on both sides (+ player API guard).
    video.muted = true;
    try { video.playbackRate = 1; } catch { /* gone */ }
    pinPlayerRate();
    audio.playbackRate = 1;
    audio.volume = video.volume;
    WATCH = w;
    w.drift = setInterval(() => {
      if (!WATCH) return;
      // The page player fights mute — pin it every tick.
      if (video.muted === false) { try { video.muted = true; } catch { /* gone */ } }
      const gap = isGap(video.currentTime || 0, kept);
      const skipping = skipChecked();
      if (gap && !skipping && !audio.paused) {
        // Skip is off: hold the filtered audio at the seam while the picture
        // plays the silent stretch through, so the sound cannot run ahead.
        audio.pause();
        w.held = true;
      } else if (w.held && !video.paused) {
        w.held = false;
        audio.currentTime = audioPos();
        audio.play().catch(() => { w.held = true; });
      }
      // No forced sync while stopped (paused or held) — that fight is what
      // looped the seams. Correct only a freely playing audio.
      if (audio.paused) return;
      const expect = audioPos();
      if (Math.abs(audio.currentTime - expect) > 0.35) audio.currentTime = expect;
    }, 1000);
    // The skip itself (option, default on): the page video jumps over every
    // removed stretch while the filtered audio — which has those stretches cut
    // out of it — keeps playing untouched, so picture and sound stay in step.
    // 250ms cadence and >0.15s jumps, so a play/pause toggle or a pause mid
    // gap never triggers a stray seek, and the map has already dropped every
    // sliver under 100ms.
    w.gap = setInterval(() => {
      if (!WATCH || video.paused) return;
      if (!skipChecked()) return;
      const now = video.currentTime || 0;
      const target = skipVideoGaps(now, kept);
      if (Math.abs(target - now) > 0.15) {
        try { video.currentTime = target; } catch { /* gone */ }
        if (w.held) {
          // A seek landed inside a removed stretch and the jump just left it:
          // release the hold here instead of waiting up to a second.
          w.held = false;
          audio.currentTime = audioPos();
          audio.play().catch(() => { w.held = true; });
        }
      }
    }, 250);
    setWatchBtn('watching');
    toast(watchLine());
    // The video was paused at request time — resume both together.
    try { await video.play(); } catch { toast('▶ اضغط تشغيل الفيديو لبدء المشاهدة', 4000); }
    kickAudio();
  }

  function stopWatch(quiet) {
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
    try { w.video.playbackRate = w.prevRate; } catch { /* gone */ }
    pinPlayerRateRestore(w.prevRate);
    try { URL.revokeObjectURL(w.url); } catch { /* gone */ }
    if (LAST) setWatchBtn('ready');
    else setWatchBtn('disabled');
    if (!quiet) toast('⏹ توقفت المشاهدة — عاد صوت الصفحة الأصلي');
  }

  function pinPlayerRateRestore(rate) {
    try {
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.setPlaybackRate === 'function') mp.setPlaybackRate(rate || 1);
    } catch { /* gone */ }
  }

  /* ── injection (SPA-safe, per-video reset) ─────────────────────── */
  let currentVideoUrl = null;

  // Status check decoupled from injection: SPA navigation often KEEPS the
  // bar buttons alive, so tryInject's early-return used to skip the check
  // forever (watch stayed disabled on every navigated video). This runs on
  // every distinct URL whether the buttons persisted or were just created.
  function checkStatusForCurrentVideo() {
    setProc('idle');
    setWatchBtn('disabled');
    native({ type: 'status' }).then((r) => {
      const st = r && r.state;
      const last = st && st.last;
      if (last && last.ok && sameVideo(location.href, last.url)) {
        LAST = {
          seconds: last.seconds || 0,
          kept: Array.isArray(last.kept) ? last.kept : null,
        };
        setProc('done');
        setWatchBtn('ready');
        return;
      }
      // A download-phase job of THIS video still running → track it (the
      // running name is the request URL there; later phases rename it).
      const run = st && st.running;
      if (run && typeof run.name === 'string' && sameVideo(location.href, run.name) && !BUSY) {
        BUSY = true;
        setProc('working', run.pct || 0);
        poll();
      }
    }).catch(() => {});
  }

  function tryInject() {
    const isNewVideo = (currentVideoUrl !== location.href);
    // Buttons persisted across an SPA navigation: still re-check the video.
    if (document.getElementById(BTN_PROC)) {
      if (isNewVideo) {
        currentVideoUrl = location.href;
        checkStatusForCurrentVideo();
      }
      return true;
    }
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return false;
    const wb = makeWatchBtn();
    const pb = makeProcBtn();
    controls.prepend(wb);
    controls.prepend(pb);
    procBtn = pb;
    watchBtn = wb;
    currentVideoUrl = location.href;
    checkStatusForCurrentVideo();
    return true;
  }

  // Audit E-3: YouTube is an SPA — navigation rebuilds the player controls
  // and the buttons vanish. Re-inject on `yt-navigate-finish` AND watch the
  // player container (NOT document.body — a body-wide subtree observer fires
  // on every progress-bar/comment mutation and drains CPU). Fall back to body
  // only if the player isn't there yet. A new video always resets the bar.
  let injectScheduled = false;
  function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = true;
    setTimeout(() => {
      injectScheduled = false;
      tryInject();
    }, 200);
  }
  window.addEventListener('yt-navigate-finish', () => {
    stopPoll(); // orphaned polls must not drive the new page's buttons
    stopWatch(true);
    resetBar();
    scheduleInject();
  });
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

// ── رسالة من نافذة الإضافة: تشغيل/إيقاف المشاهدة المفلترة ────────────────────
// النافذة لا تعرف الفيديو ولا حالة المشغّل؛ هذه الصفحة هي التي تعرفها، فتُنفّذ
// الطلب هنا وتُبلغ النافذة بالنتيجة. لا تُقرأ أي بيانات ولا يُرسل شيء للخارج.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'watch-toggle') return false;
  try {
    if (typeof WATCH !== 'undefined' && WATCH) {
      stopWatch();
      sendResponse({ ok: true, watching: false });
    } else if (typeof startWatch === 'function') {
      void startWatch();
      sendResponse({ ok: true, watching: true });
    } else {
      sendResponse({ ok: false, error: 'watch unavailable on this page' });
    }
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
  return true; // الرد متزامن لكن إبقاء القناة مفتوحة آمن
});
