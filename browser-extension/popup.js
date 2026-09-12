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
};

const STAGE_AR = {
  download: 'التنزيل',
  normalize: 'توحيد الصوت',
  separate: 'فصل الصوت',
  effects: 'المؤثرات',
  encode: 'الترميز',
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
  el.statusTitle.textContent = 'متصل بتطبيق HaramLite';
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
    el.statusTitle.textContent = 'غير متصل بالجسر المحلي';
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
      if (!settled) { settled = true; reject(new Error('انتهت المهلة')); }
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
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'تعذر الوصول إلى الجسر');
    return resp.resp || {};
  });
}

function native(message) {
  return ask({ type: 'native', message }).then((resp) => {
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'فشل الاتصال');
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
      el.sendResult.textContent = 'هذه الصفحة لا يمكن إرسالها — افتح صفحة فيديو أو صفحة ويب عادية.';
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
  el.jobPhase.textContent = (STAGE_AR[st.running.stage] || st.running.stage || 'معالجة')
    + (q > 0 ? ' · في الطابور: ' + q : '');
  el.jobHw.textContent = provider ? String(provider) : '';
}

function renderCompleted(last, provider) {
  setState('completed');
  el.completedText.textContent = last.ok
    ? 'اكتملت المعالجة بنجاح خلال ' + (last.seconds || 0).toFixed(1) + ' ثانية!'
    : 'فشلت المعالجة: ' + (last.error || 'خطأ غير معروف');
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
  hint('جارٍ الإرسال…', true);
  chrome.runtime.sendMessage({ type: 'send', url, mode }, (resp) => {
    el.send.disabled = false;
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      hint('فشل الإرسال — شغّل HaramLite وفعّل التكامل مع المتصفح.', false);
      return;
    }
    hint('✓ أُرسلت الصفحة — المعالجة جارية', true);
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
    hint(ok ? '▶ بدأت المشاهدة المفلترة في الصفحة' : 'افتح الفيديو في يوتيوب ثم اضغط «شاهد مفلتراً» في المشغّل',
         !!ok);
    if (ok) window.close();
  });
});

// ── الإقلاع ────────────────────────────────────────────────────────────────
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
