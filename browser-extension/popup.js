// HaramLite Bridge popup — status check + send-current-page + live progress.
const dot = document.getElementById('status-dot');
const text = document.getElementById('status-text');
const errorCard = document.getElementById('error-card');
const errorText = document.getElementById('error-text');
const sendBtn = document.getElementById('send-page');
const sendResult = document.getElementById('send-result');
const progCard = document.getElementById('popup-progress');
const progName = document.getElementById('popup-name');
const progBar = document.getElementById('popup-bar');
const progStatus = document.getElementById('popup-status');
const cancelBtn = document.getElementById('popup-cancel');
const openBtn = document.getElementById('popup-open');

const STAGE_AR = {
  download: 'التنزيل', normalize: 'توحيد الصوت', separate: 'فصل الصوت',
  effects: 'المؤثرات', encode: 'الترميز',
};

function native(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'native', message: msg }, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!resp || !resp.ok) reject(new Error((resp && resp.error) || 'فشل الاتصال'));
      else resolve(resp.resp || {});
    });
  });
}

chrome.runtime.sendMessage({ type: 'status' }, (resp) => {
  if (chrome.runtime.lastError || !resp || !resp.ok) {
    dot.className = 'dot bad';
    text.textContent = 'تطبيق HaramLite غير متصل';
    errorCard.classList.remove('hidden');
    errorText.textContent = resp && resp.error ? resp.error : 'تعذر الوصول إلى الجسر المحلي.';
  } else {
    dot.className = 'dot ok';
    text.textContent = 'متصل بتطبيق HaramLite ✓';
  }
});

function showResult(msg, ok) {
  sendResult.textContent = msg;
  sendResult.className = 'hint result ' + (ok ? 'ok' : 'bad');
}

let pollTimer = null;
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function pollProgress() {
  stopPoll();
  progCard.classList.remove('hidden');
  cancelBtn.style.display = 'block';
  openBtn.style.display = 'none';
  let done = false;
  let sawRunning = false; // E-6: only accept a "done" state after seeing THIS job run
  let fails = 0;
  pollTimer = setInterval(async () => {
    try {
      const r = await native({ type: 'status' });
      fails = 0; // healthy again
      const st = (r && r.state) || {};
      if (st.running) {
        sawRunning = true;
        progName.textContent = st.running.name || '';
        progBar.style.width = `${Math.round((st.running.pct || 0) * 100)}%`;
        const q = st.queue || 0;
        progStatus.textContent = `${STAGE_AR[st.running.stage] || st.running.stage || 'معالجة'} — ${Math.round((st.running.pct || 0) * 100)}%` +
          (q > 0 ? ` · في الطابور بعد هذا: ${q}` : '');
        progStatus.style.color = '#f5f2ed';
      } else if (st.last && sawRunning && !done) {
        done = true;
        stopPoll();
        progBar.style.width = '100%';
        cancelBtn.style.display = 'none';
        if (st.last.ok) {
          progStatus.textContent = `✓ اكتملت المعالجة في ${(st.last.seconds || 0).toFixed(1)} ثانية`;
          progStatus.style.color = '#5ddac8';
          openBtn.style.display = 'block';
        } else {
          progStatus.textContent = '✗ ' + (st.last.error || 'فشلت المعالجة');
          progStatus.style.color = '#ffb4ab';
        }
      }
    } catch {
      // Audit E-2: stop after 8 consecutive failures instead of polling forever.
      fails += 1;
      if (fails >= 8) {
        stopPoll();
        progStatus.textContent = '⚠ انقطع الاتصال بتطبيق HaramLite — شغّل التطبيق وفعّل التكامل';
        progStatus.style.color = '#ffb4ab';
      }
    }
  }, 1500);
}

sendBtn.addEventListener('click', () => {
  sendBtn.disabled = true;
  showResult('جارٍ الإرسال...', true);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0] && tabs[0].url;
    if (!url || url.startsWith('chrome://')) {
      showResult('هذه الصفحة لا يمكن إرسالها', false);
      sendBtn.disabled = false;
      return;
    }
    chrome.runtime.sendMessage({ type: 'send', url }, (resp) => {
      sendBtn.disabled = false;
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        showResult('فشل الإرسال — شغّل HaramLite وفعّل التكامل', false);
      } else {
        showResult('✓ أُرسلت الصفحة — المعالجة جارية', true);
        pollProgress();
      }
    });
  });
});

cancelBtn.addEventListener('click', () => {
  cancelBtn.disabled = true;
  native({ type: 'cancel' }).catch(() => {});
  setTimeout(() => { cancelBtn.disabled = false; }, 2000);
});

openBtn.addEventListener('click', () => {
  native({ type: 'open_folder' }).catch(() => {});
});

// if a job is already running when the popup opens, show its progress too;
// otherwise show the LAST completed result (audit: opening right after a
// finished job used to show only the bare "connected" status).
native({ type: 'status' })
  .then((r) => {
    const st = (r && r.state) || {};
    if (st.running) {
      pollProgress();
      return;
    }
    if (st.last && st.last.ok) {
      progCard.classList.remove('hidden');
      progBar.style.width = '100%';
      progName.textContent = st.last.name || '';
      cancelBtn.style.display = 'none';
      progStatus.textContent = `✓ آخر معالجة: اكتملت في ${(st.last.seconds || 0).toFixed(1)} ثانية`;
      progStatus.style.color = '#5ddac8';
      openBtn.style.display = 'block';
    }
  })
  .catch(() => {});
