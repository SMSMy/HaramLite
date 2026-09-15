// HaramLite Bridge — YouTube content script.
// Two bar buttons, no panels, no questions asked:
//   1. Process — idle ("عالج هذا الفيديو") → click starts (video paused,
//      live % on the button) → click while busy cancels + resets → done dims
//      ("تم التجهيز") and enables Watch.
//   2. Watch — disabled until ready → enabled ("شاهد بعد إزالة الموسيقى") → click
//      applies the filter and plays (active color) → second click stops and
//      restores the original. Manual only — nothing auto-applies.
// Filtered watching: page video muted + filtered audio element, playback
// rate pinned at 1x on both sides (+ player API guard). The removed stretches
// — the silence left by muting the music — are SKIPPED: the page video jumps
// over each one while the filtered audio (which contains no such stretch)
// plays on untouched, so both stay in step. Skipping is MANDATORY: there is
// no user option to turn it off. Drift backstop without forced sync while
// stopped, clean restore.
// 1.1.4: never rewind freely-playing audio (kickAudio was ungated on every
// play — YouTube fires play around our gap jumps; mapFullToCut is flat at the
// seam, so that write repeats the next words). Asymmetric drift. 1200ms selfSeek.
// Optional HL-SYNC tracer: localStorage['hl.synclog']='1'.
// Right-click Watch for options (gap-skip is mandatory + full reprocess).
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
    // Options live on right-click: full reprocess (gap-skip is mandatory).
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
      procBtn.textContent = 'عالج هذا الفيديو';
      procBtn.title = 'HaramLite — معالجة هذا الفيديو على جهازك';
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
      watchBtn.textContent = 'شاهد بعد إزالة الموسيقى ▶';
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
      watchBtn.textContent = 'شاهد بعد إزالة الموسيقى ▶';
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
    // لا خيار للمستخدم: قفز الفجوات إجباريّ (قرار المالك «اجباري لكل مستخدم لا خيار
    // لتعديلها») — حُذف الصندوق، والقائمة فيها «معالجة كاملة» وحدها.
    menu.innerHTML =
      `<button id="hl-ext-reprocess" style="width:100%;padding:8px 6px;background:transparent;border:none;` +
      `color:${T.sub};font-size:12px;text-align:right;cursor:pointer;">` +
      `↻ معالجة كاملة</button>`;
    document.body.appendChild(menu);
    menu.querySelector('#hl-ext-reprocess').addEventListener('click', () => {
      closeWatchMenu();
      // نُبقي الإنهاء الصريح هنا: startFull() ينصرف فوراً إن كان BUSY، فلا تبقى مشاهدة قائمة.
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
            toast('تم التجهيز ✓ — شاهد بعد إزالة الموسيقى ▶');
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

// The boundary where the picture must jump next: the end of the kept range
// containing t, provided a removed stretch follows it. null when there is
// nothing to jump (inside a gap already, after the last range, or contiguous
// ranges). Pure, so scripts/check-extension-sync.cjs can extract and test it.
function nextGapStart(t, kept) {
  if (!kept || !kept.length) return null;
  for (let i = 0; i < kept.length; i++) {
    const a = Number(kept[i][0]);
    const b = Number(kept[i][1]);
    if (!(b > a)) continue;
    if (t < a) return a;                 // t sits in the stretch before this range
    if (t >= a && t < b) {
      const nxt = kept[i + 1];
      if (!nxt) return null;
      const na = Number(nxt[0]);
      return na > b ? b : null;          // a removed stretch follows this range
    }
  }
  return null;
}

// إحصاء فجوات الخريطة. أسقطه إصدار المراجعة فأُعيد: يقيس (أ) مجموع المحفوظ مقابل
// مدة الصوت المُسلَّم (فرضية الانزياح الثابت)، (ب) أصغر فجوة وأكبر فجوة وعدد ما
// دون نصف ثانية — والحدّ الفعلي من مسار Rust: min_silence 800ms − 2×keep 150ms.
// وأُضيف قياسان لضبط عتبات خطة «المشاهدة الأسلس» (نطاق 0.5–8s وحيث المقطع السابق
// طويل): hist مدرّج أطوال الفجوات، و before أدنى ووسيط طول المقطع المحفوظ السابق
// للفجوة — حساب خالص فوق kept، لا سلوك ولا مؤقّت ولا مستمع.
function gapStats(kept, jumpThreshold) {
  const out = {
    keptSum: 0, gaps: 0, smallGaps: 0, smallSeconds: 0, largestGap: 0, smallestGap: 0,
    // عدد الفجوات في خمس نطاقات بالثواني: 0.5–1 ثم 1–2 ثم 2–4 ثم 4–8 ثم 8 فأكثر.
    // وما دون نصف ثانية لا نطاق له هنا — يُقرأ من smallGaps/smallSeconds أعلاه.
    hist: [0, 0, 0, 0, 0],
    // طول المقطع المحفوظ السابق لكل فجوة: أدناه (min) ووسيطه (median) بالثواني.
    before: { min: 0, median: 0 },
  };
  if (!kept || !kept.length) return out;
  const befores = [];
  let prevEnd = 0;
  let prevLen = 0;                        // طول المقطع المحفوظ السابق، لا موضعه
  for (const pair of kept) {
    const a = Number(pair[0]);
    const b = Number(pair[1]);
    if (!(b > a)) continue;
    out.keptSum += b - a;
    if (a > prevEnd) {
      const g = a - prevEnd;
      out.gaps++;
      if (g > out.largestGap) out.largestGap = g;
      if (!out.smallestGap || g < out.smallestGap) out.smallestGap = g;
      if (g <= jumpThreshold) { out.smallGaps++; out.smallSeconds += g; }
      if (g >= 0.5) {
        if (g < 1) out.hist[0]++;
        else if (g < 2) out.hist[1]++;
        else if (g < 4) out.hist[2]++;
        else if (g < 8) out.hist[3]++;
        else out.hist[4]++;
      }
      // الفجوة الأولى — أي قبل أول مقطع محفوظ — لا مقطع سابق لها يُقاس، فتُهمَل
      // هنا وحدها: إدخال صفر مُصطنع كان سيسحب الأدنى والوسيط إلى الصفر.
      if (prevLen > 0) befores.push(prevLen);
    }
    prevEnd = b;
    prevLen = b - a;
  }
  if (befores.length) {
    befores.sort((x, y) => x - y);
    const mid = befores.length >> 1;
    out.before.min = befores[0];
    out.before.median = (befores.length % 2) ? befores[mid] : (befores[mid - 1] + befores[mid]) / 2;
  }
  return out;
}

// ── خطة «المشاهدة الأسلس» §٣ (docs/EXT-SMOOTH-PLAN.md): دالة قرار نقية لكل فجوة ──
// الخطوة ٣: تُضاف الدالة وحدها، **غير موصولة بعد — الخطوة ٤ هي التي ستستدعيها** من
// ماسح الفجوات/gapTick. لا نداء لها في هذا الملف، ولا حالة، ولا مؤقّت، ولا مستمع،
// ولا تغيير في أي مسار تنفيذ قائم: **صفر سلوك** حتى تُوصَل.
// العتبات: `rate` = ٣× **قرار المالك رقم ٣** («*3 وقد تزيد لاحقا او تنقص حسب التجربه»)،
// والبقية **ابتدائية تُضبط بالتجربة** («نجرب الى ان نصل المناسب») — ولا يُقال عن رقم
// إنه «مقيس» قبل قياسه فعلاً على مقاطع حقيقية (§٣ سياسة الضبط).
const PACE_CFG = {
  cutBelow: 0.6,     // أقصر من ذلك: قفزة غير محسوسة، والتسريع لا يوفّر شيئاً يُذكر
  isolated: 20,      // ما قبلها وما بعدها بهذا الطول ⇒ قفزة واحدة نظيفة وتوفير أقصى
  maxSpeedGap: 6,    // تسريع 6s عند 3× = ثانيتان مشاهدة؛ الأطول منها ⇒ اقطع
  targetDwell: 1.0,  // زمن المشاهدة المستهدف لفجوة تُسرَّع (ثوان)
  rate: 3.0,         // سقف التسريع — قرار المالك (٣×) لا ابتدائي
  maxDwell: 1.5,     // شبكة أمان: إن تجاوز التسريع هذا الزمن ⇒ اقطع
};

// قرار فجوة واحدة من الخريطة وحدها: نقية، بلا حالة وبلا `video`/`audio`، وكل عتباتها
// من `cfg` وحدها (لا مرجع إلى ثوابت الجدول داخلها) ⇒ يستخرجها الحارس ويختبرها معزولة
// بلا متصفّح. لا تُنادى من أي مكان هنا — الوصل في الخطوة ٤.
// **عقد النداء كما في §٣**: يُمرَّر كائن الفجوة `{ gap, keptBefore, keptAfter }` ثم `cfg`.
// والتفكيك **داخل الجسم** لا في الوسائط، ليبقى أول قوس في نصّ الدالة قوسَ متنها
// فتستخرجها آلية الحارس القائمة (extractBlock) كما تُستخرج بقية الدوال النقية — بلا
// أي تغيير في الآلية (وسائط مفكَّكة تُخرج قوس الوسائط فيسقط بناء الحارس بـSyntaxError).
//   gap        : طول الفجوة بالثواني
//   keptBefore : طول المقطع المحفوظ الذي سبقها (منذ نهاية الفجوة السابقة)
//   keptAfter  : طول المقطع المحفوظ الذي يليها
function planGap(input, cfg) {
  const { gap, keptBefore, keptAfter } = input;
  // ١) فجوة قصيرة جداً: قفزة غير محسوسة، والتسريع لا يوفّر شيئاً يُذكر.
  if (gap < cfg.cutBelow) return { mode: 'cut', reason: 'tiny' };
  // ٢) فجوة معزولة: ما قبلها وما بعدها طويلان ⇒ قفزة واحدة نظيفة وتوفير أقصى.
  if (keptBefore >= cfg.isolated && keptAfter >= cfg.isolated) return { mode: 'cut', reason: 'isolated' };
  // ٣) فجوة طويلة: تسريعها يعني مشاهدة تسريع طويل ⇒ القطع أرحم.
  if (gap > cfg.maxSpeedGap) return { mode: 'cut', reason: 'long' };
  // ٤) وإلا: تسريع بمعدّل ثابت، مع سقف زمن مشاهدة.
  const rate = Math.min(cfg.rate, Math.max(1.2, gap / cfg.targetDwell));
  if (gap / rate > cfg.maxDwell) return { mode: 'cut', reason: 'dwell' };
  return { mode: 'speed', rate: +rate.toFixed(2) };
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
      toast('✗ ابنِ الخريطة أولاً — اضغط «عالج هذا الفيديو»', 4000);
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
      gapTimer: 0,
      selfSeek: 0,   // طابع آخر قفزة صنعناها (لتمييزها عن قفزة المستخدم)
      held: false,
      stalled: false,   // المشغّل يتجمّد (إعادة تخزين بعد قفزتنا) والصوت يجب أن يُحتجَز
      pendingLead: null, // تقدّم ظهر مرة؛ لا يُصحَّح للخلف إلّا إن تكرّر
      loadLogged: false, // بوابة لمرّة واحدة: سطر قياس load لا يُصدَر إلّا مرة لكل جلسة مشاهدة
    };
    const SELF_SEEK_MS = 1200; // كان 600؛ مشغّل ثقيل قد يتأخّر play أكثر من ذلك
    const on = (el, ev, fn) => { el.addEventListener(ev, fn); w.handlers.push([el, ev, fn]); };
    const audioPos = () => {
      const t = mapFullToCut(video.currentTime || 0, kept);
      return Math.min(Math.max(t, 0), Math.max(audio.duration - 0.05, 0));
    };
    const slog = (() => { try { return localStorage.getItem('hl.synclog') === '1'; } catch { return false; } })();
    const trace = (site, extra) => {
      if (!slog) return;
      const row = {
        t: Date.now() % 60000, site,
        v: +((video.currentTime || 0).toFixed(3)),
        a: +(audio.currentTime.toFixed(3)),
        want: +(audioPos().toFixed(3)),
        gap: isGap(video.currentTime || 0, kept),
        held: w.held,
        selfMs: Date.now() - (w.selfSeek || 0),
        drift: extra || '',
      };
      // بوابة لمرّة واحدة (إصلاح عود لا نهائي دخل في 89c78e1): نصّ هذا السطر كان
      // موضوعاً في جسم trace بلا بوابة، فكان trace ينادي نفسه أبداً حتى
      // RangeError ولا يصل صفّ إلى window.__hlSync. العلم في كائن الحالة w فهو
      // يُصفَّر مع كل جلسة مشاهدة جديدة، **ويُضبط قبل النداء** ليكون النداء واحداً
      // بالضبط حتى لو أطلق مسارٌ ما نداءً متداخلاً.
      // وشرط الصلاحية audio.duration > 0: بلا قفل العلم على قياس **صالِح** كان
      // أول نداء (وقد يسبق جهوزية المدة) يُصدِر audioDur=0 وdiff=keptSum، فيُقفل
      // العلم على رقم مضلِّل ويضيع القياس الميداني أبداً. الشرط هنا على مدة الصوت
      // وحدها لأن diff = keptSum − audioDur هو الرقم الذي يحسم مطابقة الخريطة؛
      // vDur قد يبقى 0 ولا يضرّ (يُقاس 0 في السطر نفسه أدناه).
      if (slog && !w.loadLogged && isFinite(audio.duration) && audio.duration > 0) {
        w.loadLogged = true;
        // سطر قياس واحد: يحسم «هل الخريطة تطابق الملف المُسلَّم» و«هل توجد فجوة أصغر
        // من عتبة القفز» (وهو ما أسقط الفرضية الخامسة: الحدّ الفعلي 500ms).
        const st = gapStats(kept, 0.5);
        const ad = isFinite(audio.duration) ? audio.duration : 0;
        const vd = isFinite(video.duration) ? video.duration : 0;
        // والحقول المضافة: hist مدرّج الفجوات (خمسة نطاقات) و keptBefore أدنى/وسيط
        // طول المقطع المحفوظ السابق للفجوة — لضبط عتبات قرار التسريع/القطع بالتجربة.
        trace('load', `keptSum=${st.keptSum.toFixed(3)} audioDur=${ad.toFixed(3)} vDur=${vd.toFixed(3)} diff=${(st.keptSum - ad).toFixed(3)} gaps=${st.gaps} smallestGap=${st.smallestGap.toFixed(3)} belowHalf=${st.smallGaps} belowHalfSeconds=${st.smallSeconds.toFixed(3)} largestGap=${st.largestGap.toFixed(3)} hist=[${st.hist.join(',')}] keptBefore={min:${st.before.min.toFixed(3)},med:${st.before.median.toFixed(3)}}`);
      }
      (window.__hlSync = window.__hlSync || []).push(row);
      if (window.__hlSync.length > 4000) window.__hlSync.shift();
      try { console.log('HL-SYNC', JSON.stringify(row)); } catch { /* gone */ }
    };
    // لا سحب للخلف على صوت يعمل: الخريطة مسطّحة داخل الفجوة، فأي إرساء من
    // video.currentTime عند الحدّ يعيد كلمات سُمعت. قفزة المستخدم وحدها مسموحة.
    const setAudioTime = (site, want, allowBack) => {
      const cur = audio.currentTime;
      const delta = cur - want;
      trace(site, `d=${delta.toFixed(3)}`);
      if (!allowBack && !audio.paused && delta > 0.05) {
        trace(site + '-skip', 'no-rewind');
        return;
      }
      if (!(Math.abs(delta) > 0.05)) return;
      try { audio.currentTime = want; } catch { /* gone */ }
    };
    // إعادة إرساء الصوت على موضع القفزة نفسها.
    // السبب (عطل ميداني موصوف): الصورة تقفز وحدها بـcurrentTime، والصوت عنصر
    // آخر يواصل مكانه، فلا يُصحَّح إلا بتسامح 0.35s كل ثانية ⇒ يُسمع ذيل المقطع
    // المحذوف (كلمة مكررة) ثم يعود فجأة. الهدف يُحسب من الهدف المقصود لا من
    // video.currentTime، لأن قراءته بعد الإسناد غير موثوقة (القفز غير متزامن).
    const reanchorAudio = (fullT) => {
      const want = Math.min(Math.max(mapFullToCut(fullT, kept), 0), Math.max(audio.duration - 0.05, 0));
      if (!(Math.abs(audio.currentTime - want) > 0.05)) return;
      let done = false;
      const unmute = () => {
        if (done) return;
        done = true;
        try { audio.muted = false; } catch { /* gone */ }
        audio.removeEventListener('seeked', unmute);
      };
      // كتم لحظي يعبر القفزة: يقطع الذيل المسموع بين الإسناد ووصول seeked
      try { audio.muted = true; } catch { /* gone */ }
      try { audio.currentTime = want; } catch { /* gone */ }
      audio.addEventListener('seeked', unmute);
      setTimeout(unmute, 120);   // شبكة أمان إن لم يصل seeked
      trace('reanchor', `full=${fullT.toFixed(3)}`);
    };
    const kickAudio = () => {
      // play حول قفزتنا: يوتيوب يطلق play/playing بعد الإسناد. الخريطة مسطّحة
      // عند الحدّ ⇒ audioPos() = الدرزة، والصوت قد تقدّم ⇒ سحب للخلف = تكرار.
      // لا نُرسي إلا صوتاً متوقفاً وخارج نافذة selfSeek (بدء المشاهدة / قفزة مستخدم).
      if (Date.now() - (w.selfSeek || 0) < SELF_SEEK_MS) {
        trace('kick-skip', 'selfSeek');
      } else if (audio.paused) {
        setAudioTime('kick', audioPos(), false);
      } else {
        trace('kick-skip', 'playing');
      }
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
      trace('play', audio.paused ? 'paused' : 'playing');
      kickAudio();
      gapTick();   // فجوة أمامية (فيديو يبدأ بموسيقى): اقلبها فوراً لا بعد 250ms
    });
    on(video, 'pause', () => { trace('pause'); audio.pause(); });
    // وقفة المشغّل ليست إيقافاً: بعد قفزتنا يُعيد يوتيوب التخزين فيتجمّد عدّاد
    // الصورة بينما الصوت يواصل ⇒ ينشأ **تقدّم** لا يُصحّحه الانحراف الأمامي أبداً
    // (بلاغ المالك 2026-09-15: «الفيديو قد يقف قليلاً بعد التخطي» + تقدّم قوي).
    // فتُحتجَز هنا كما في فجوة الصمت، وتُرسى عند الاستئناف — وهو الموضع الوحيد
    // الذي يُسمح فيه بالسحب للخلف بلا قفزة مستخدم، ولهذا يُوسَم في الأثر.
    const stallHold = () => {
      if (!WATCH || video.paused || w.stalled) return;
      w.stalled = true;
      try { audio.pause(); } catch { /* gone */ }
      trace('stall', 'hold');
    };
    const stallRelease = () => {
      if (!WATCH || !w.stalled) return;
      w.stalled = false;
      setAudioTime('stall-release', audioPos(), true);
      audio.play().catch(() => { w.stalled = true; });
      trace('stall', 'release');
    };
    on(video, 'waiting', stallHold);
    on(video, 'stalled', stallHold);
    on(video, 'playing', stallRelease);
    on(video, 'seeking', () => {
      // قفزة صنعناها نحن هي إسنادٌ لـcurrentTime، والصفحة تُطلق seeking لها
      // والموضع القديم لا يزال داخل الفجوة. معالجتها كقفزة مستخدم كان يضبط
      // w.held ويوقف الصوت، ثم يُرسيه المؤقّت فيُعاد سماع ما سُمِع (تكرار حتى
      // ثلاث مرات مع الفجوات المتقاربة — بلاغ المالك 2026-09-15). فتُتجاهل هنا.
      if (Date.now() - (w.selfSeek || 0) < SELF_SEEK_MS) return;
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
        if (Math.abs(audio.currentTime - want) > 0.35) {
          // قفزة مستخدم حقيقية فقط. السماح بالرجوع لأن المستخدم طلب موضعاً أقدم.
          setAudioTime('seeking', want, true);
        }
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
      // التخطي إجباريّ (لا خيار للمستخدم): لا فرع «احتجاز عند الدرزة» — كان مخصّصاً
      // لحالة إطفاء الخيار. وw.held يبقى حيّاً: قفزة المستخدم داخل فجوة تُحتجزه
      // (معالج seeking)، فيُرسى هنا عند الاستئناف.
      if (w.held && !video.paused) {
        w.held = false;
        setAudioTime('held-release', audioPos(), true);
        audio.play().catch(() => { w.held = true; });
      }
      // No forced sync while stopped (paused or held) — that fight is what
      // looped the seams. Correct only a freely playing audio.
      // Asymmetric: catch up FORWARD if audio lags; never rewind a lead —
      // a 0.35s skip is inaudible, a 0.35s rewind is a repeated word.
      if (audio.paused) return;
      if (Date.now() - (w.selfSeek || 0) < SELF_SEEK_MS) return;
      if (isGap(video.currentTime || 0, kept)) return;
      if (w.stalled) return;   // الصورة متجمّدة: الاحتجاز يعالجها لا النبضة
      const expect = audioPos();
      // أمامي افتراضاً: السحب للخلف يُسمع كلمة مكررة. لكن تقدّماً **يستمر** هو
      // انزياح حقيقي (وقفة لم نرها، أو فرق ساعة بين العنصرين)، والقاعدة الأمامية
      // وحدها تتركه ينمو بلا حدّ — ولهذا يُسمح بالسحب للخلف فقط إذا تكرّر التقدّم
      // بنفس الاتجاه والمقدار في نبضتين متتاليتين (فارق ~ثانية).
      const lead = audio.currentTime - expect;
      if (lead > 0.35) {
        const confirmed = w.pendingLead && Math.abs(lead - w.pendingLead) < 0.35;
        if (confirmed) {
          w.pendingLead = null;
          trace('drift', `confirmed-backward d=${lead.toFixed(3)}`);
          setAudioTime('drift-confirmed', expect, true);
        } else {
          w.pendingLead = lead;
          trace('drift', `pending-lead d=${lead.toFixed(3)}`);
        }
      } else if (lead < -0.35) {
        w.pendingLead = null;
        setAudioTime('drift', expect, false);   // إلحاق أمامي — لا يُسمع
      } else {
        w.pendingLead = null;
      }
    }, 1000);
    // The skip itself (mandatory — no user option): the page video jumps over
    // every removed stretch while the filtered audio — which has those stretches
    // cut out of it — keeps playing untouched, so picture and sound stay in step.
    // 250ms cadence and >0.15s jumps, so a play/pause toggle or a pause mid
    // gap never triggers a stray seek, and the map has already dropped every
    // sliver under 100ms.
    const gapTick = (boundary, landing) => {
      if (!WATCH || video.paused) return;
      const now = video.currentTime || 0;
      let target = null;
      if (typeof boundary === 'number' && typeof landing === 'number' && now >= boundary - 0.12) {
        if (now < boundary) {
          // أطلقت بضعة أجزاء من الثانية قبل الحدّ (تقريب المؤقّت). نُعيد التسليح
          // للباقي بدل القفز الآن (القفز المبكر يقصّ محتوى محفوظاً) وبدل لا شيء
          // (وهو ما كان يُرجع العمل للماسح 250ms فيتقدّم الصوت على الصورة عند كل
          // فجوة ولا يُصحَّح إلا بعد تراكم 0.35s — بلاغ المالك 2026-09-15).
          if (w.gapTimer) clearTimeout(w.gapTimer);
          w.gapTimer = setTimeout(() => { w.gapTimer = 0; gapTick(boundary, landing); }, (boundary - now) * 1000);
          return;
        }
        target = landing;         // وصلنا الحدّ: نقطة الهبوط محسوبة مسبقاً
      }
      if (target === null) target = skipVideoGaps(now, kept);
      if (!(Math.abs(target - now) > 0.15)) return;
      w.selfSeek = Date.now();    // قفزتنا: تُعلَن كي لا يعدّها معالج seeking قفزة مستخدم
      trace('gapTick', `→${target.toFixed(3)}`);
      try { video.currentTime = target; } catch { /* gone */ }
      if (w.held) {
        // A seek landed inside a removed stretch and the jump just left it: the
        // audio was paused at the seam, so it must be re-seated — and the hold
        // is released here instead of waiting up to a second for the scanner.
        reanchorAudio(target);
        w.held = false;
        audio.play().catch(() => { w.held = true; });
      }
      // Otherwise the audio is deliberately NOT touched. mapFullToCut is FLAT
      // across a removed stretch, so continuously playing audio is already in
      // step with the picture after the jump; re-seating it would drag it
      // BACKWARDS over sound that was legitimately heard. That drag is the
      // repeated-word artefact reported 2026-09-15 (silence 0..12s: the first
      // ~0.2s of the next segment was heard twice, then corrected). Only the
      // held case — a real seek into a gap — needs a re-seat.
    };
    // The 250ms scanner below only DISCOVERS a removed stretch, up to a quarter
    // second after the picture entered it — and in that window the filtered
    // audio plays on while the picture still shows silence, so the sound leads
    // the picture by that much at every seam. This arms a one-shot timer for
    // the exact boundary (with the landing point precomputed, since reading
    // currentTime right after a jump is not trustworthy); the scanner stays as
    // the safety net and re-arms it on every tick, and a play that starts inside
    // a gap jumps immediately.
    const armGapJump = () => {
      if (w.gapTimer) { clearTimeout(w.gapTimer); w.gapTimer = 0; }
      if (!WATCH || video.paused) return;
      const now = video.currentTime || 0;
      if (isGap(now, kept)) { gapTick(); return; }
      const boundary = nextGapStart(now, kept);
      if (boundary === null) return;
      const dt = (boundary - now) * 1000;
      if (!(dt >= 0) || dt > 1500) return;   // only the imminent boundary
      const landing = skipVideoGaps(boundary + 1e-6, kept);
      w.gapTimer = setTimeout(() => { w.gapTimer = 0; gapTick(boundary, landing); }, dt);
    };
    w.gap = setInterval(armGapJump, 250);
    if (slog) w.tracePulse = setInterval(() => { if (WATCH) trace('tick'); }, 40);
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
    if (w.tracePulse) clearInterval(w.tracePulse);
    if (w.gapTimer) clearTimeout(w.gapTimer);
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
})();
