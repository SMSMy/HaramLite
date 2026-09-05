import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as dialog from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import dingUrl from './assets/ding.wav';

type LogLine = { ts: string; level: string; target: string; message: string };
type MediaInfo = {
  container: string;
  duration_secs: number;
  has_audio: boolean;
  has_video: boolean;
  video_is_cover_art: boolean;
  audio_disguised_as_video: boolean;
  audio_codec: string | null;
  sample_rate: number | null;
  height: number | null;
};
type SepResult = {
  vocals: string;
  instrumental: string | null;
  video: string | null;
  seconds: number;
};

const i18n = {
  ar: {
    actions_title: 'تشخيص',
    btn_info: 'INFO تجريبي',
    btn_error: 'ERROR تجريبي',
    btn_panic: 'التقاط panic اختباري',
    btn_clear: 'تفريغ العرض',
    log_title: 'سجل الأحداث (حي)',
    autoscroll: 'تلقائي التمرير',
    media_title: 'الملف',
    mode_title: 'الوضع',
    mode_song: 'أغنية',
    mode_song_desc: 'إذا كنت تعزل الموسيقى عن أغنية، اختر هذا الخيار؛ سضيف قطع الصمت ويزيل كتمة الصوت.',
    mode_clip: 'مقطع عادي',
    mode_clip_desc: 'للمقاطع التي تحتوي على متحدثين: لن يقطع الصمت، وسيزيل الموسيقى فقط.',
    fmt_label: 'صيغة الإخراج:',
    btn_probe: 'فحص',
    btn_sep_song: 'عزل <span class="kashida-text">الموسيقى</span> وإضافة المؤثرات',
    kind_audio: 'صوت MP3',
    kind_audio_desc: 'الغناء المعالَج ملفاً صوتياً',
    kind_video: 'فيديو MP4',
    kind_video_desc: 'نفس الصورة بصوت معالج',
    btn_sep_clip: 'إزالة الموسيقى فقط',
    url_title: 'تحميل من رابط (YouTube ونحوها)',
    btn_download: 'تنزيل',
    drop_hint: 'اسحب الملفات وأفلتها هنا — أو',
    btn_browse: 'اختيار من الجهاز',
    err_not_found: '✗ المسار غير موجود — تأكد من الصحة',
    err_is_dir: '✗ هذا مجلد وليس ملفاً — اختر ملفاً داخل المجلد',
    err_no_audio: '⚠ لا يوجد مسار صوتي في هذا الملف',
    set_notify: 'إشعارات الانتهاء + صوت خفيف',
    btn_about: 'حول البرنامج',
    btn_report: 'الإبلاغ عن مشكلة',
    about_title: 'حول HaramLite',
    about_ok: 'حسناً',
    about_dev: 'التطوير: فريق HaramMute',
    about_credits: 'أهل الفضل',
    about_ok_modal: 'حسناً',
    preview_label: 'معاينة سريعة',
    preview_hint_song: '⚠ عينة جودة الفصل فقط — لا تمثل قصّ الصمت النهائي',
    preview_hint_clip: 'عينة مطابقة للمخرج النهائي',
    notify_done: 'اكتملت المعالجة',
    notify_fail: 'فشلت المعالجة',
    notify_batch_done: 'اكتملت الدفعة',
    btn_repair: 'فحص وإصلاح المكونات',
    btn_upd: 'التحقق من التحديثات',
    repair_title: 'مكوّنات ناقصة',
    repair_desc: 'بعض مكوّنات التشغيل مفقودة (حذف يدوي أو نسخة محمولة). سيتم تنزيلها تلقائياً من GitHub والتحقق من بصمتها قبل التثبيت.',
    repair_all: 'إصلاح الكل',
    repair_later: 'لاحقاً',
    repair_one: 'إصلاح',
    repair_done: 'تم الإصلاح بنجاح',
    repair_all_ok: 'كل المكونات موجودة ✓',
    upd_checking: 'جارٍ التحقق من التحديثات...',
    upd_none: 'أنت على أحدث إصدار ✓',
    upd_avail: 'يتوفر تحديث جديد:',
    upd_ask: 'تنزيله وتثبيته الآن؟',
    upd_downloaded: 'تم تثبيت التحديث — أعد تشغيل التطبيق',
    upd_error: 'تعذر التحقق من التحديث',
    upd_portable_note: 'ملاحظة: التحديث الذاتي والإشعارات النظامية يتطلبان التثبيت عبر المثبت — النسخة المحمولة تستخدم صفحة الإصدارات.',
    watch_enable: 'تفعيل مجلد المراقبة',
    watch_pick: 'اختيار المجلد',
    watch_mode_label: 'وضع المعالجة:',
    watch_size_label: 'حجم أقصى للمراقبة (MB):',
    watch_rescan_label: 'فاصل المسح الدوري (ثانية):',
    watch_status_on: 'نشطة',
    watch_status_off: 'غير مفعّلة',
    watch_no_folder: 'اختر مجلداً أولاً',
    watch_toast_done: 'اكتملت معالجة ملف مراقَب',
    watch_toast_fail: 'فشلت معالجة ملف مراقَب',
    btn_bridge: 'تفعيل التكامل مع المتصفح',
    cuda_missing_text: 'كرت NVIDIA لديك مدعوم، لكن مكتبات تسريع CUDA غير منزّلة. فعّل الخيار وسينزّلها التطبيق تلقائياً.',
    cuda_ready: '✓ بيئة CUDA جاهزة — المعالجة ستكون أسرع على الكرت',
    cuda_downloading: 'جارٍ تنزيل مكتبات تسريع CUDA…',
    cuda_download_failed: 'تعذر تنزيل مكتبات CUDA — سيبقى DirectML نشطاً. أعد المحاولة لاحقاً',
    cuda_banner_enable: 'كرت NVIDIA لديك مدعوم! فعّل تسريع CUDA من الإعدادات — سيُنزّل التطبيق المكتبات تلقائياً (تنزيل لمرة واحدة).',
  },
  en: {
    actions_title: 'Diagnostics',
    btn_info: 'Test INFO log',
    btn_error: 'Test ERROR log',
    btn_panic: 'Trigger test panic',
    btn_clear: 'Clear view',
    log_title: 'Live event log',
    autoscroll: 'Auto-scroll',
    media_title: 'File',
    mode_title: 'Mode',
    mode_song: 'Song',
    mode_song_desc: 'separate + revival FX + silence cut',
    mode_clip: 'Normal clip',
    mode_clip_desc: 'music removal only — faster',
    fmt_label: 'Output format:',
    btn_probe: 'Probe',
    btn_sep_song: 'Isolate music & add FX',
    kind_audio: 'MP3 Audio',
    kind_audio_desc: 'processed vocals as an audio file',
    kind_video: 'MP4 Video',
    kind_video_desc: 'same picture with processed audio',
    btn_sep_clip: 'Remove music only',
    url_title: 'Download from link (YouTube etc.)',
    btn_download: 'Download',
    drop_hint: 'Drag & drop files here — or',
    btn_browse: 'Browse files',
    err_not_found: '✗ Path not found — please verify',
    err_is_dir: '✗ That is a folder — pick a file inside it',
    err_no_audio: '⚠ No audio track in this file',
    set_notify: 'Completion notifications + sound',
    btn_about: 'About',
    btn_report: 'Report an issue',
    about_title: 'About HaramLite',
    about_ok: 'OK',
    about_dev: 'Developed by the HaramMute team',
    about_credits: 'Credits',
    about_ok_modal: 'OK',
    preview_label: 'Quick preview',
    preview_hint_song: '⚠ Separation quality sample only — not the final silence cut',
    preview_hint_clip: 'Sample identical to the final output',
    notify_done: 'Processing complete',
    notify_fail: 'Processing failed',
    notify_batch_done: 'Batch complete',
    btn_repair: 'Check & repair components',
    btn_upd: 'Check for updates',
    repair_title: 'Missing components',
    repair_desc: 'Some runtime components are missing (manual deletion or a portable copy). They will be downloaded from GitHub and hash-verified before installation.',
    repair_all: 'Repair all',
    repair_later: 'Later',
    repair_one: 'Repair',
    repair_done: 'Repaired successfully',
    repair_all_ok: 'All components present ✓',
    upd_checking: 'Checking for updates…',
    upd_none: 'You are up to date ✓',
    upd_avail: 'Update available:',
    upd_ask: 'Download and install now?',
    upd_downloaded: 'Update installed — restart the app',
    upd_error: 'Update check failed',
    upd_portable_note: 'Note: self-update and system notifications require the installer build — portable copies use the releases page.',
    watch_enable: 'Enable watch folder',
    watch_pick: 'Choose folder',
    watch_mode_label: 'Processing mode:',
    watch_size_label: 'Max watch file size (MB):',
    watch_rescan_label: 'Periodic rescan (seconds):',
    watch_status_on: 'Active',
    watch_status_off: 'Disabled',
    watch_no_folder: 'Pick a folder first',
    watch_toast_done: 'Watched file processed',
    watch_toast_fail: 'Watched file failed',
    btn_bridge: 'Enable browser integration',
    cuda_missing_text: 'Your NVIDIA GPU is supported, but the CUDA acceleration libraries are not downloaded yet. Enable the option and the app will download them automatically.',
    cuda_ready: '✓ CUDA is ready — processing will be faster on the GPU',
    cuda_downloading: 'Downloading CUDA acceleration libraries…',
    cuda_download_failed: 'Could not download the CUDA libraries — DirectML stays active. Try again later',
    cuda_banner_enable: 'Your NVIDIA GPU is supported! Enable CUDA acceleration in Settings — the app downloads the libraries automatically (one-time download).',
  },
} as const;

let lang: 'ar' | 'en' = localStorage.getItem('hl.lang') === 'en' ? 'en' : 'ar';

function t(key: keyof (typeof i18n)['ar']): string {
  return i18n[lang][key];
}

function applyLang(): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as keyof (typeof i18n)['ar'];
    el.innerHTML = i18n[lang][key];
  });
}

/* ── path sanitization (B1/B2 root cause) ─────────────────────────── */
function sanitizePath(raw: string): string {
  let p = raw.trim();
  // strip ONE pair of surrounding quotes (Explorer "copy as path")
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).trim();
  }
  return p;
}

const view = document.getElementById('log-view') as HTMLDivElement;
const autoscroll = document.getElementById('autoscroll') as HTMLInputElement;

/* UI freeze fix: the old code repainted up to 500 rows on EVERY log event
 * (ORT emits dozens/sec during inference). Now: incremental append capped at
 * MAX_RENDERED_ROWS, coalesced to one paint per animation frame. */
const MAX_RENDERED_ROWS = 150;
let logTotal = 0; // ever-incrementing id of buffered lines
let renderedUpTo = 0; // logTotal already painted
let logFrameQueued = false;
function logLineNode(line: LogLine): HTMLDivElement {
  const div = document.createElement('div');
  const lvl = document.createElement('span');
  lvl.className = `lv-${line.level}`;
  lvl.textContent = `${line.ts} ${line.level.padEnd(5)} `;
  const body = document.createElement('span');
  body.textContent = `[${line.target}] ${line.message}`;
  div.append(lvl, body);
  return div;
}
function renderLogs(lines: LogLine[]): void {
  // Full repaint of the visible tail (drawer open / manual refresh).
  const tail = lines.slice(-MAX_RENDERED_ROWS);
  const frag = document.createDocumentFragment();
  for (const line of tail) frag.appendChild(logLineNode(line));
  view.replaceChildren(frag);
  renderedUpTo = logTotal;
  if (autoscroll.checked) view.scrollTop = view.scrollHeight;
}
function scheduleLogPaint(): void {
  if (logFrameQueued || !logOpen) return;
  logFrameQueued = true;
  requestAnimationFrame(() => {
    logFrameQueued = false;
    if (!logOpen) return;
    if (renderedUpTo > logTotal) { renderLogs(logBuffer); return; }
    const stick = nearBottom();
    const have = logTotal - renderedUpTo;
    const inBuf = Math.min(have, logBuffer.length);
    const startIdx = logBuffer.length - inBuf;
    const frag = document.createDocumentFragment();
    for (let i = startIdx; i < logBuffer.length; i++) frag.appendChild(logLineNode(logBuffer[i]));
    view.appendChild(frag);
    renderedUpTo = logTotal;
    while (view.childElementCount > MAX_RENDERED_ROWS) view.firstElementChild?.remove();
    if (stick && autoscroll.checked) view.scrollTop = view.scrollHeight;
  });
}

function nearBottom(): boolean {
  return view.scrollHeight - view.scrollTop - view.clientHeight < 40;
}

let logOpen = localStorage.getItem('hl.log_open') === '1';

// Audit F-1: the backend pushes new lines via the `log-line` event; this
// local buffer is the rendering source of truth (no more 700ms polling).
const logBuffer: LogLine[] = [];

async function refresh(): Promise<void> {
  if (!logOpen) return;
  try {
    const fresh = await invoke<LogLine[]>('get_recent_logs', { limit: 500 });
    logBuffer.length = 0;
    logBuffer.push(...fresh);
    logTotal += fresh.length;
    renderLogs(logBuffer);
  } catch (e) {
    console.error('get_recent_logs failed', e);
  }
}

function pushLogLine(line: LogLine): void {
  if (!logOpen) return;
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.splice(0, logBuffer.length - 500);
  logTotal += 1;
  scheduleLogPaint();
}

function wireLogToggle(): void {
  const card = document.getElementById('logcard');
  const toggle = document.getElementById('log-toggle');
  const icon = toggle?.querySelector('span[data-icon="expand_less"]') as HTMLElement;
  const sync = () => {
    view.classList.toggle('hidden', !logOpen);
    card?.classList.toggle('collapsed', !logOpen);
    if (icon) {
       icon.textContent = logOpen ? 'expand_more' : 'expand_less';
    }
    if (logOpen) void refresh();
  };
  toggle?.addEventListener('click', (ev) => {
    // don't toggle if clicking on autoscroll
    if ((ev.target as HTMLElement).closest('.autoscroll')) return;
    logOpen = !logOpen;
    localStorage.setItem('hl.log_open', logOpen ? '1' : '0');
    sync();
  });
  sync();
}

/* ── global state ───────────────────────────────────────────────────── */
let currentMediaPath = '';
let lastProbeOk = false;
let currentMode: 'song' | 'clip' = 'song';
let batchQueue: string[] = [];
let batchRunning = false;
let singleRunning = false; // F-4: the separate button doubles as cancel

/* ── quick preview (Sprint B1) ──────────────────────────────────────── */
let previewEnabled = false;
let previewSeconds = 15;
let appVersion = '';

/* ── notifications (Sprint B2) ──────────────────────────────────────── */
let toastTimer: number | undefined;
function showToast(msg: string): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), 5000);
}
// F-7: one reusable Audio element — avoid leaking a new object per ding.
const ding = new Audio(dingUrl);
function playDing(): void {
  try {
    ding.currentTime = 0;
    void ding.play();
  } catch {
    /* sound is a nicety — never let it break the flow */
  }
}
/** System notification + soft sound; falls back to an in-app toast when
 *  the OS notification is unavailable (e.g. portable Windows without an
 *  AUMID/Start Menu shortcut). */
async function notify(title: string, body: string): Promise<void> {
  if (localStorage.getItem('hl.notify') !== '1') return;
  playDing();
  try {
    await invoke('notify_done', { title, body });
  } catch {
    showToast(`${title} — ${body}`);
  }
}
function fileBaseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/* ── UI freeze forensics ────────────────────────────────────────────── */
// If the renderer event loop ever stalls, leave a dated trace in the backend
// log — turns future "the app froze" reports into quantified data (when and
// how long) instead of guesses. Costs one timer tick per second.
function startStallDetector(): void {
  let lastBeat = Date.now();
  window.setInterval(() => {
    const now = Date.now();
    const gap = now - lastBeat;
    lastBeat = now;
    if (gap > 5000) {
      invoke('push_log', { level: 'warn', message: `UI thread stalled ~${Math.round(gap / 1000)}s` });
    }
  }, 1000);
}

/* ── smart CUDA hint (Sprint C2-style UX) ───────────────────────────── */
function showCudaHint(text: string): void {
  const hint = document.getElementById('cuda-hint');
  if (!hint) return;
  if (text) {
    const span = document.getElementById('cuda-hint-text');
    if (span) span.textContent = text;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
}

/** Permanent green banner above the mode cards: shown as long as an NVIDIA
 *  GPU is supported and the CUDA toggle is OFF. The libraries self-download
 *  on first enable, so the message is the same whether they're ready or not. */
async function updateCudaBanner(): Promise<void> {
  const banner = document.getElementById('cuda-banner');
  const text = document.getElementById('cuda-banner-text');
  if (!banner || !text) return;
  const cudaOn = localStorage.getItem('hl.cuda') === '1';
  if (cudaOn) {
    banner.classList.add('hidden');
    return;
  }
  const st = await invoke<{ nvidia: boolean; cuda: boolean }>('cuda_status').catch(() => null);
  if (st && st.nvidia) {
    text.textContent = t('cuda_banner_enable');
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

/* ── visible pipeline stages (Sprint C2) ────────────────────────────── */
const STAGE_NAMES: Record<string, { ar: string; en: string }> = {
  normalize: { ar: 'توحيد الصوت', en: 'Normalizing' },
  separate: { ar: 'فصل الصوت', en: 'Separating' },
  effects: { ar: 'المؤثرات', en: 'Effects' },
  encode: { ar: 'الترميز', en: 'Encoding' },
};
function hideStageLine(): void {
  document.getElementById('stage-line')?.classList.add('hidden');
}

/* ── unified settings sync (Sprint D1) ──────────────────────────────── */
type RustSettings = Record<string, unknown>;
let settingsSyncTimer: number | undefined;
/** Hook filled by wireWatchSettings so external settings changes can repaint. */
let refreshWatchUi: (() => void) | null = null;
function collectSettings(): RustSettings {
  return {
    lang,
    cuda: localStorage.getItem('hl.cuda') === '1',
    notify: localStorage.getItem('hl.notify') === '1',
    preview: localStorage.getItem('hl.preview') === '1',
    preview_seconds: Number(localStorage.getItem('hl.preview_seconds')) || 15,
    keep_instrumental: localStorage.getItem('hl.keep_inst') === '1',
    log_open: logOpen,
    watch_enabled: localStorage.getItem('hl.watch') === '1',
    watch_path: localStorage.getItem('hl.watch_path') || null,
    watch_mode: localStorage.getItem('hl.watch_mode') || 'song',
    watch_out_kind: 'auto',
    watch_max_size_mb: Number(localStorage.getItem('hl.watch_max_mb')) || 2048,
    watch_rescan_secs: Number(localStorage.getItem('hl.watch_rescan')) || 60,
  };
}
function pushSettings(): void {
  if (settingsSyncTimer) window.clearTimeout(settingsSyncTimer);
  settingsSyncTimer = window.setTimeout(() => {
    invoke('set_settings', { value: collectSettings() }).catch((e) =>
      console.error('set_settings failed', e));
  }, 300);
}

/** One-time seed: Rust settings → localStorage (fresh installs / migration). */
async function seedSettings(): Promise<void> {
  try {
    const s = await invoke<RustSettings>('get_settings');
    if (!s || typeof s !== 'object') return;
    const bools: [keyof RustSettings, string][] = [
      ['cuda', 'hl.cuda'], ['notify', 'hl.notify'], ['preview', 'hl.preview'],
      ['keep_instrumental', 'hl.keep_inst'], ['watch_enabled', 'hl.watch'],
    ];
    for (const [k, ls] of bools) {
      if (localStorage.getItem(ls) === null && s[k] !== undefined) {
        localStorage.setItem(ls, s[k] ? '1' : '0');
      }
    }
    const strs: [keyof RustSettings, string][] = [
      ['watch_mode', 'hl.watch_mode'], ['lang', 'hl.lang'],
    ];
    for (const [k, ls] of strs) {
      if (localStorage.getItem(ls) === null && typeof s[k] === 'string') {
        localStorage.setItem(ls, s[k] as string);
      }
    }
    const nums: [keyof RustSettings, string][] = [
      ['preview_seconds', 'hl.preview_seconds'], ['watch_max_size_mb', 'hl.watch_max_mb'],
      ['watch_rescan_secs', 'hl.watch_rescan'],
    ];
    for (const [k, ls] of nums) {
      if (localStorage.getItem(ls) === null && typeof s[k] === 'number') {
        localStorage.setItem(ls, String(s[k]));
      }
    }
    if (localStorage.getItem('hl.watch_path') === null && typeof s.watch_path === 'string') {
      localStorage.setItem('hl.watch_path', s.watch_path as string);
    }
  } catch {
    /* browser dev / backend unavailable */
  }
}

/* ── watch folder wiring (Sprint D2) ────────────────────────────────── */
function wireWatchSettings(): void {
  const cb = document.getElementById('setting-watch') as HTMLInputElement | null;
  if (!cb) return;
  const opts = document.getElementById('watch-options');
  const pathEl = document.getElementById('watch-path');
  const statusEl = document.getElementById('watch-status');
  const modeSel = document.getElementById('watch-mode') as HTMLSelectElement | null;
  const maxInput = document.getElementById('watch-max-size') as HTMLInputElement | null;
  const rescanInput = document.getElementById('watch-rescan') as HTMLInputElement | null;

  const sync = () => {
    const on = cb.checked;
    const path = localStorage.getItem('hl.watch_path') || '';
    opts?.classList.toggle('hidden', !on);
    document.getElementById('btn-watch-cancel')?.classList.toggle('hidden', !on);
    if (pathEl) pathEl.textContent = path || (on ? t('watch_no_folder') : '');
    if (statusEl) {
      const hasPath = !!path;
      statusEl.textContent = on
        ? (hasPath ? `${t('watch_status_on')} ✓` : t('watch_no_folder'))
        : t('watch_status_off');
      statusEl.className = on && hasPath
        ? 'font-label-sm text-label-sm text-tertiary'
        : 'font-label-sm text-label-sm text-warn-yellow';
    }
  };

  cb.checked = localStorage.getItem('hl.watch') === '1';
  cb.addEventListener('change', () => {
    localStorage.setItem('hl.watch', cb.checked ? '1' : '0');
    pushSettings();
    sync();
  });

  document.getElementById('btn-watch-folder')?.addEventListener('click', async () => {
    const picked = await dialog.open({ directory: true });
    if (typeof picked === 'string' && picked) {
      localStorage.setItem('hl.watch_path', picked);
      pushSettings();
      sync();
    }
  });

  if (modeSel) {
    modeSel.value = localStorage.getItem('hl.watch_mode') || 'song';
    modeSel.addEventListener('change', () => {
      localStorage.setItem('hl.watch_mode', modeSel.value);
      pushSettings();
    });
  }
  if (maxInput) {
    maxInput.value = localStorage.getItem('hl.watch_max_mb') || '2048';
    maxInput.addEventListener('change', () => {
      localStorage.setItem('hl.watch_max_mb', maxInput.value || '2048');
      pushSettings();
    });
  }
  if (rescanInput) {
    rescanInput.value = localStorage.getItem('hl.watch_rescan') || '60';
    rescanInput.addEventListener('change', () => {
      localStorage.setItem('hl.watch_rescan', rescanInput.value || '60');
      pushSettings();
    });
  }

  document.getElementById('btn-watch-cancel')?.addEventListener('click', () => {
    invoke('cancel_watch_file').catch((e) => console.error('cancel_watch_file failed', e));
  });

  // live events from the Rust watch service
  void listen<{ path: string; reason: string }>('watch-skip', (ev) => {
    showToast(`⏭ ${ev.payload.path} — ${ev.payload.reason}`);
    invoke('push_log', { level: 'warn', message: `watch skip: ${ev.payload.path}: ${ev.payload.reason}` });
  });
  void listen<{ path: string; ok: boolean; seconds?: number; error?: string }>('watch-done', (ev) => {
    const p = ev.payload;
    showToast(p.ok ? `✓ ${t('watch_toast_done')}: ${p.path}` : `✗ ${t('watch_toast_fail')}: ${p.path}`);
    if (localStorage.getItem('hl.notify') === '1') playDing();
    invoke('push_log', {
      level: p.ok ? 'info' : 'error',
      message: p.ok ? `watch done: ${p.path} (${p.seconds?.toFixed(1)}s)` : `watch failed: ${p.path}: ${p.error}`,
    });
  });

  refreshWatchUi = sync;
  sync();
}

/** Render a verdict line as PLAIN TEXT. Never accepts markup: error messages
 *  embed backend text / file paths (e.g. failed probe_media), so innerHTML
 *  here is an XSS sink — a file named `<img onerror=...>.mp3` would execute
 *  in the WebView. */
function setVerdict(el: HTMLElement | null, text: string, isBad = false): void {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('text-error', isBad);
  el.classList.toggle('text-on-surface-variant', !isBad);
}

/** Rich verdict variant — ONLY for static, trusted markup written in this
 *  file. Callers must never interpolate user/backend data into `html`. */
function setVerdictHtml(el: HTMLElement | null, html: string, isBad = false): void {
  if (!el) return;
  el.innerHTML = html;
  el.classList.toggle('text-error', isBad);
  el.classList.toggle('text-on-surface-variant', !isBad);
}

function probeEl() { return document.getElementById('media-verdict'); }
function sepResultEl() { return document.getElementById('sep-result'); }
function pathInputEl() { return document.getElementById('media-path') as HTMLInputElement; }
function sepBtnEl() { return document.getElementById('btn-separate') as HTMLButtonElement; }

/** Validate a pasted/dropped path BEFORE any backend call. Returns cleaned path or null. */
async function validatePath(rawPath: string): Promise<{ ok: true; path: string } | { ok: false }> {
  const p = sanitizePath(rawPath);
  const v = probeEl();
  if (!p) {
    setVerdict(v, t('err_not_found'), true);
    return { ok: false };
  }
  let exists = false;
  let isDir = false;
  try {
    exists = await invoke<boolean>('path_exists', { path: p });
    if (exists) isDir = await invoke<boolean>('path_is_dir', { path: p });
  } catch {
    exists = false;
  }
  if (!exists) {
    setVerdict(v, t('err_not_found'), true);
    invoke('push_log', { level: 'error', message: `مسار غير موجود: ${p}` });
    return { ok: false };
  }
  if (isDir) {
    setVerdict(v, t('err_is_dir'), true);
    invoke('push_log', { level: 'error', message: `مجلد وليس ملفاً: ${p}` });
    return { ok: false };
  }
  pathInputEl().value = p;
  return { ok: true, path: p };
}

async function runProbe(rawPath?: string): Promise<MediaInfo | null> {
  const target = rawPath ?? pathInputEl().value;
  const validated = await validatePath(target);
  const v = probeEl();
  lastProbeOk = false;
  sepBtnEl().disabled = true;

  if (!validated.ok) return null;
  currentMediaPath = validated.path;

  try {
    const info = await invoke<MediaInfo>('probe_media', { path: currentMediaPath });
    if (!info.has_audio) {
      setVerdict(v!, t('err_no_audio'), true);
      return null;
    }
    const flags: string[] = [];
    if (info.audio_disguised_as_video) flags.push('⚠ ' + 'صوت متنكّر في حاوية فيديو — سنعالجه كصوت');
    if (info.video_is_cover_art) flags.push('ℹ الفيديو مجرد صورة غلاف');

    // Auto-switch UI based on media type
    if (info.has_video && !info.video_is_cover_art) {
        document.getElementById('kind-video')?.click();
    } else {
        document.getElementById('kind-audio')?.click();
    }

    const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
    const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'video';
    const word = outKind === 'video' ? 'فيديو' : 'صوت';
    setVerdictHtml(v!, `نوع الإخراج: <span class="bg-clay-accent/20 text-clay-accent px-1.5 py-0.5 rounded font-bold mr-1 inline-block">${word}</span>`, false);

    lastProbeOk = true;
    sepBtnEl().disabled = false;

    invoke('push_log', { level: 'info', message: `probe ok: ${currentMediaPath}` });
    return info;
  } catch (e) {
    setVerdict(v!, String(e), true);
    invoke('push_log', { level: 'error', message: `probe failed: ${e}` });
    return null;
  }
}

function outDirOf(p: string): string {
  return p.replace(/[\\/]+[^\\/]+$/, '');
}

/* ── wiring ─────────────────────────────────────────────────────────── */

function wireLang(): void {
  document.getElementById('lang-toggle')?.addEventListener('click', () => {
    lang = lang === 'ar' ? 'en' : 'ar';
    localStorage.setItem('hl.lang', lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    location.reload(); // simplest reliable full relabel
  });
}

function wireSecretSettings(): void {
  const badge = document.getElementById('version-badge');
  if (!badge) return;
  let taps = 0;
  let firstTapAt = 0;

  badge.addEventListener('click', () => {
    const now = Date.now();
    if (now - firstTapAt > 4000) {
      taps = 0;
      firstTapAt = now;
    }
    taps += 1;
    if (taps === 3 && badge) {
      badge.style.opacity = '0.55';
      setTimeout(() => (badge.style.opacity = ''), 250);
    }
    if (taps >= 6) {
      taps = 0;
      const advContainer = document.getElementById('advanced-panel-container');
      advContainer?.classList.toggle('open');
      invoke('push_log', { level: 'warn', message: 'DEV PANEL toggled (hidden settings)' });
    }
  });

  const cb = document.getElementById('keep-inst') as HTMLInputElement | null;
  if (cb) {
    cb.checked = localStorage.getItem('hl.keep_inst') === '1';
    cb.addEventListener('change', () => {
      localStorage.setItem('hl.keep_inst', cb.checked ? '1' : '0');
      pushSettings();
      invoke('push_log', { level: 'info', message: `keep_instrumental = ${cb.checked}` });
    });
  }
}

function wireModes(): void {
  const cards = document.querySelectorAll<HTMLElement>('.mode-card');
  const sepLabel = document.getElementById('sep-label');
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      currentMode = (card.dataset.mode as 'song' | 'clip') ?? 'song';
      cards.forEach((c) => c.classList.toggle('selected', c === card));
      if (sepLabel) {
        const key = currentMode === 'song' ? 'btn_sep_song' : 'btn_sep_clip';
        sepLabel.dataset.i18n = key;
        sepLabel.innerHTML = t(key);
      }
      invoke('push_log', { level: 'info', message: `mode → ${currentMode}` });
      refreshPreviewHint();
    });
  });
}

/* ── quick preview controls (Sprint B1) ─────────────────────────────── */
function refreshPreviewHint(): void {
  const toggle = document.getElementById('preview-toggle') as HTMLInputElement | null;
  const sel = document.getElementById('preview-duration') as HTMLSelectElement | null;
  const hint = document.getElementById('preview-hint');
  if (!toggle || !sel || !hint) return;
  sel.classList.toggle('hidden', !toggle.checked);
  hint.textContent = toggle.checked
    ? (currentMode === 'song' ? t('preview_hint_song') : t('preview_hint_clip'))
    : '';
}
function wirePreview(): void {
  const toggle = document.getElementById('preview-toggle') as HTMLInputElement | null;
  const sel = document.getElementById('preview-duration') as HTMLSelectElement | null;
  if (!toggle || !sel) return;
  toggle.addEventListener('change', () => {
    previewEnabled = toggle.checked;
    localStorage.setItem('hl.preview', previewEnabled ? '1' : '0');
    pushSettings();
    refreshPreviewHint();
  });
  sel.addEventListener('change', () => {
    previewSeconds = Number(sel.value) || 15;
    localStorage.setItem('hl.preview_seconds', String(previewSeconds));
    pushSettings();
  });
  // restore persisted state
  toggle.checked = localStorage.getItem('hl.preview') === '1';
  previewEnabled = toggle.checked;
  const saved = Number(localStorage.getItem('hl.preview_seconds'));
  if (saved === 10 || saved === 15 || saved === 30) {
    sel.value = String(saved);
    previewSeconds = saved;
  }
  refreshPreviewHint();
}

function wireKinds(): void {
  const cards = document.querySelectorAll<HTMLElement>('.kind-card');
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      if (card.classList.contains('dimmed')) return;
      cards.forEach((c) => c.classList.toggle('selected', c === card));
      
      const v = document.getElementById('media-verdict');
      if (v) {
        const word = card.dataset.kind === 'video' ? 'فيديو' : 'صوت';
        setVerdictHtml(v, `نوع الإخراج: <span class="bg-clay-accent/20 text-clay-accent px-1.5 py-0.5 rounded font-bold mr-1 inline-block">${word}</span>`);
      }
      
      invoke('push_log', { level: 'info', message: `kind → ${card.dataset.kind}` });
    });
  });
}

function wireDropzone(): void {
  const dz = document.getElementById('dropzone');
  dz?.addEventListener('click', async () => {
    const picked = await dialog.open({
      multiple: true,
      filters: [
        { name: 'Media', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'] },
      ],
    });
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    await ingestFiles(files);
  });

  const win = getCurrentWebviewWindow();
  void win.onDragDropEvent((ev) => {
    if (ev.payload.type === 'over') dz?.classList.add('dragging');
    else dz?.classList.remove('dragging');
    if (ev.payload.type === 'drop') {
      const paths = ev.payload.paths;
      if (paths.length) void ingestFiles(paths);
    }
  });
}

/** Handle one or many files: single → fill+probe; many → queue for batch. */
async function ingestFiles(files: string[]): Promise<void> {
  if (files.length === 0) return;
  
  if (files.length === 1) {
    await stopBatch();
    const info = await runProbe(files[0]);
    if (info) updateQualityOptions(info.has_video ? info.height ?? null : null);
    // Add to batch queue to show history visually
    batchQueue = [files[0]];
    renderBatchList();
    return;
  }
  
  batchQueue = [...files];
  renderBatchList();
  setBatchCounter(0, batchQueue.length);
  const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
  const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'video';
  const word = outKind === 'video' ? 'فيديو' : 'صوت';
  setVerdictHtml(probeEl(), `نوع الإخراج: <span class="bg-clay-accent/20 text-clay-accent px-1.5 py-0.5 rounded font-bold mr-1 inline-block">${word}</span>`, false);
  invoke('push_log', { level: 'info', message: `batch queued: ${batchQueue.length} files` });
}

function updateQualityOptions(srcHeight: number | null): void {
  const wrap = document.getElementById('q-wrap');
  const sel = document.getElementById('quality-select') as HTMLSelectElement | null;
  const videoCard = document.getElementById('kind-video');

  // Video kind only makes sense for real video inputs; dim it otherwise.
  // This MUST run before any early return: the Lite UI has no
  // `quality-select`, so the old `if (!wrap || !sel || !videoCard) return;`
  // skipped the dimming entirely and let users pick MP4 video for audio-only
  // files (guaranteed ffmpeg failure).
  if (videoCard) videoCard.classList.toggle('dimmed', srcHeight === null);
  if (!wrap || !sel) return;

  if (srcHeight === null) {
    sel.replaceChildren();
    return;
  }

  const ladder = [srcHeight, 1080, 720, 480, 360]
    .filter((h) => h > 0 && h <= srcHeight)
    .filter((h, i, arr) => arr.indexOf(h) === i)
    .sort((a, b) => b - a);

  sel.replaceChildren(
    ...ladder.map((h, idx) => {
      const o = document.createElement('option');
      o.value = String(h);
      o.textContent = idx === 0 ? `نفس الجودة (${h}p)` : `${h}p`;
      return o;
    }),
  );
  sel.value = String(ladder[0] ?? '');
}

/* ── batch engine (F5): sequential, continue-on-fail ────────────────── */
let batchAbort = false;
/** Stop the batch AND the backend job behind it. Without cancel_process the
 *  Rust pipeline keeps grinding (ghost processing) and `batchRunning` stays
 *  true until it finishes — the next "فصل" click then cancels instead of
 *  starting. */
async function stopBatch(): Promise<void> {
  batchAbort = true;
  batchQueue = [];
  batchStatus.clear();
  localStorage.removeItem('hl.batch');
  document.getElementById('batch-list')?.classList.add('hidden');
  document.getElementById('batch-counter')?.classList.add('hidden');
  // Phantom-cancel fix: stopBatch runs on EVERY single-file ingest, and it
  // used to fire cancel_process (and its scary backend WARN line) even with
  // nothing running. Only signal when a job actually exists to abort.
  if (!batchRunning && !singleRunning) return;
  try {
    await invoke('cancel_process');
  } catch (e) {
    console.error('cancel_process failed', e);
  }
}
function setBatchCounter(done: number, total: number): void {
  const el = document.getElementById('batch-counter');
  if (!el) return;
  el.classList.remove('hidden');
  el.textContent = `📦 الدفعة: ${done}/${total}`;
}
/** Batch rows must never shrink inside the flex column (30 files squeezed
 *  into slivers) and off-screen rows skip rendering (content-visibility). */
function styleBatchItem(div: HTMLElement): void {
  div.classList.add('shrink-0');
  div.style.contentVisibility = 'auto';
  div.style.containIntrinsicSize = 'auto 96px';
}
function renderBatchList(): void {
  const ul = document.getElementById('batch-list');
  if (!ul) return;
  ul.classList.remove('hidden');
  ul.replaceChildren(
    ...batchQueue.map((f) => {
      const div = document.createElement('div');
      div.dataset.file = f;
      div.className = 'batch-item bg-coal-surface/40 border border-border-muted rounded p-stack-sm flex flex-col gap-unit opacity-60 transition-all duration-300 apple-ease cursor-default relative overflow-hidden';
      styleBatchItem(div);
      
      const progBg = document.createElement('div');
      progBg.className = 'absolute inset-0 bg-clay-accent/10 w-0 transition-all duration-1000 ease-linear batch-prog-bg hidden';
      
      const headerDiv = document.createElement('div');
      headerDiv.className = 'flex justify-between items-center relative z-10';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'font-label-sm text-label-sm text-cream-text truncate font-semibold';
      nameSpan.dir = 'ltr';
      nameSpan.textContent = f.split(/[\\/]/).pop() ?? f;
      const pctSpan = document.createElement('span');
      pctSpan.className = 'batch-pct font-label-sm text-label-sm text-clay-accent font-bold drop-shadow-sm hidden';
      pctSpan.textContent = '0%';
      headerDiv.append(nameSpan, pctSpan);
      
      const progWrap = document.createElement('div');
      progWrap.className = 'h-1.5 bg-border-muted rounded-full overflow-hidden relative z-10 shadow-inner batch-prog-wrap hidden';
      const progBar = document.createElement('div');
      progBar.className = 'batch-prog-bar h-full bg-clay-accent w-0 rounded-full relative transition-all duration-1000 ease-linear shadow-[0_0_10px_rgba(218,119,86,0.8)]';
      progWrap.appendChild(progBar);
      
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'batch-actions flex gap-2 z-10 hidden mt-1';
      
      const statusSpan = document.createElement('span');
      statusSpan.className = 'status-text font-label-sm text-label-sm text-on-surface-variant relative z-10 flex-1';
      statusSpan.textContent = 'في الانتظار';
      
      const bottomRow = document.createElement('div');
      bottomRow.className = 'flex justify-between items-center w-full relative z-10';
      bottomRow.append(statusSpan, actionsDiv);
      
      div.append(progBg, headerDiv, progWrap, bottomRow);
      return div;
    }),
  );
  batchStatus.clear();
  for (const f of batchQueue) batchStatus.set(f, 'pending');
  saveBatchState();
}

/* ── batch persistence (functional gap: memory-only queue) ──────────── */
// The queue (+ per-item status) survives close/crash; completion or an
// explicit stop clears it. Resume re-queues only pending/failed items —
/// never reprocesses finished ones.
type BatchItemState = 'pending' | 'run' | 'ok' | 'fail';
const batchStatus = new Map<string, BatchItemState>();
function saveBatchState(): void {
  try {
    if (batchQueue.length) {
      localStorage.setItem('hl.batch', JSON.stringify(
        batchQueue.map((f) => ({ f, s: batchStatus.get(f) ?? 'pending' })),
      ));
    } else localStorage.removeItem('hl.batch');
  } catch { /* storage full/blocked — queue simply stays volatile */ }
}
function restoreBatchState(): void {
  let items: { f: string; s: BatchItemState }[] = [];
  try {
    const raw = localStorage.getItem('hl.batch');
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [];
      items = arr
        .map((it) => typeof it === 'string'
          ? { f: it, s: 'pending' as BatchItemState }
          : { f: (it as { f?: unknown }).f, s: (it as { s?: unknown }).s })
        .filter((it): it is { f: string; s: BatchItemState } =>
          typeof it.f === 'string' && (it.s === 'pending' || it.s === 'run' || it.s === 'fail' || it.s === 'ok'));
    }
  } catch { items = []; }
  const files = items.filter((it) => it.s !== 'ok').map((it) => it.f);
  const skipped = items.length - files.length;
  if (!files.length) {
    if (items.length) localStorage.removeItem('hl.batch');
    return;
  }
  batchQueue = files;
  renderBatchList();
  setBatchCounter(0, batchQueue.length);
  showToast(`⏸ دفعة منقطعة (${files.length}${skipped ? `، تخطي ${skipped} منجزة` : ''}) — اضغط فصل للاستئناف`);
  invoke('push_log', { level: 'warn', message: `batch restored after restart: ${files.length} files (${skipped} done skipped)` });
}
function markBatchItem(file: string, status: 'ok' | 'fail' | 'run', resultPath?: string): void {
  batchStatus.set(file, status);
  const item = document.querySelector<HTMLElement>(`#batch-list div[data-file="${CSS.escape(file)}"]`);
  if (!item) { saveBatchState(); return; }
  styleBatchItem(item); // className swaps below wipe classes — re-apply after each
  
  const statusSpan = item.querySelector('.status-text') as HTMLElement;
  const actionsDiv = item.querySelector('.batch-actions') as HTMLElement;
  
  if (status === 'run') {
      item.className = 'batch-item running-item bg-coal-surface/80 border border-clay-accent/40 rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden shadow-[0_4px_12px_-4px_rgba(218,119,86,0.2)] transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.remove('hidden');
      item.querySelector('.batch-pct')?.classList.remove('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.remove('hidden');
      if (statusSpan) {
          statusSpan.textContent = 'جاري المعالجة...';
          statusSpan.className = 'status-text font-label-sm text-label-sm text-clay-accent animate-pulse relative z-10 flex-1';
      }
      if (actionsDiv) {
          actionsDiv.innerHTML = `<button class="text-error hover:text-red-400 p-1" title="إلغاء المعالجة"><span class="material-symbols-outlined text-sm" data-icon="cancel">cancel</span></button>`;
          actionsDiv.classList.remove('hidden');
          actionsDiv.querySelector('button')?.addEventListener('click', () => {
              invoke('cancel_process').catch(console.error);
          });
      }
  } else if (status === 'ok') {
      item.className = 'batch-item bg-tertiary-container/20 border border-tertiary/40 rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.add('hidden');
      item.querySelector('.batch-pct')?.classList.add('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.add('hidden');
      if (statusSpan) {
          statusSpan.textContent = previewEnabled ? '✓ مكتمل (عينة)' : '✓ مكتمل';
          statusSpan.className = 'status-text font-label-sm text-label-sm text-tertiary relative z-10 flex-1';
      }
      if (actionsDiv && resultPath) {
          const folderPath = outDirOf(resultPath);
          actionsDiv.innerHTML = `
            <button class="btn-play text-tertiary hover:text-green-300 p-1 bg-surface-container rounded" title="فتح الملف">
              <span class="material-symbols-outlined text-sm" data-icon="play_arrow">play_arrow</span>
            </button>
            <button class="btn-folder text-tertiary hover:text-green-300 p-1 bg-surface-container rounded" title="فتح المجلد">
              <span class="material-symbols-outlined text-sm" data-icon="folder_open">folder_open</span>
            </button>
          `;
          actionsDiv.classList.remove('hidden');
          actionsDiv.querySelector('.btn-play')?.addEventListener('click', () => invoke('open_file', { path: resultPath }).catch(console.error));
          actionsDiv.querySelector('.btn-folder')?.addEventListener('click', () => invoke('open_folder', { path: folderPath }).catch(console.error));
      } else if (actionsDiv) {
          actionsDiv.classList.add('hidden');
      }
  } else if (status === 'fail') {
      item.className = 'batch-item bg-error-container/20 border border-error/40 rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.add('hidden');
      item.querySelector('.batch-pct')?.classList.add('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.add('hidden');
      if (statusSpan) {
          statusSpan.textContent = '✗ فشل';
          statusSpan.className = 'status-text font-label-sm text-label-sm text-error relative z-10 flex-1';
      }
      // Functional gap: a transient failure used to be a dead end — offer
      // a per-item retry instead of forcing a manual queue rebuild.
      if (actionsDiv) {
          actionsDiv.innerHTML = `<button class="text-tertiary hover:text-green-300 p-1 bg-surface-container rounded" title="إعادة المحاولة"><span class="material-symbols-outlined text-sm" data-icon="refresh">refresh</span></button>`;
          actionsDiv.classList.remove('hidden');
          actionsDiv.querySelector('button')?.addEventListener('click', () => void retryBatchItem(file));
      }
  }
  styleBatchItem(item); // className swaps above wipe it — restore last
  saveBatchState();
}

/** Re-run one failed batch item with the last used separation options. */
let lastSepOpts: SepOpts | null = null;
async function retryBatchItem(file: string): Promise<void> {
  const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
  const o: SepOpts = lastSepOpts ?? {
    outKind: (kindSel?.dataset.kind as 'audio' | 'video') ?? 'audio',
  };
  const keepInst = (document.getElementById('keep-inst') as HTMLInputElement)?.checked ?? false;
  const result = sepResultEl();
  if (!result) return;
  markBatchItem(file, 'run');
  await runOne(file, keepInst, o, result);
}

/* ── separation (single + batch) ────────────────────────────────────── */
// Coalesce high-frequency backend events to one DOM paint per frame.
const rafPending = new Set<string>();
function coalesceRaf(key: string, fn: () => void): void {
  if (rafPending.has(key)) return;
  rafPending.add(key);
  requestAnimationFrame(() => {
    rafPending.delete(key);
    fn();
  });
}
type SepOpts = { outKind: 'audio' | 'video'; quality?: number; advFmt?: string };

async function runSeparationFor(path: string, keepInst: boolean, o: SepOpts): Promise<SepResult> {
  const useCuda = localStorage.getItem('hl.cuda') === '1';
  const res = await invoke<SepResult>('separate_file', {
    path,
    outDir: outDirOf(path),
    mode: currentMode,
    kind: o.outKind,
    quality: o.quality ?? null,
    format: o.advFmt ?? null,
    keepInstrumental: keepInst,
    useCuda: useCuda,
    previewSeconds: previewEnabled ? previewSeconds : null,
  });
  return res;
}

function wireSeparate(): void {
  const result = sepResultEl();
  let stageHideTimer: number | undefined; // F-5: one pending hide at a time

  // F-2: cache the active batch item + its children — sep-progress fires at
  // very high frequency and used to run 4 DOM queries per event.
  let cachedItem: HTMLElement | null = null;
  let cachedBg: HTMLElement | null = null;
  let cachedBar: HTMLElement | null = null;
  let cachedText: HTMLElement | null = null;
  let lastSepPct = 0;
  let lastStage: { stage: string; pct: number } | null = null;
  const paintSepProgress = () => {
    const pct = Math.round(lastSepPct * 100);
    const activeItem = document.querySelector<HTMLElement>('.batch-item.running-item');
    if (activeItem !== cachedItem) {
      cachedItem = activeItem;
      cachedBg = activeItem ? activeItem.querySelector<HTMLElement>('.batch-prog-bg') : null;
      cachedBar = activeItem ? activeItem.querySelector<HTMLElement>('.batch-prog-bar') : null;
      cachedText = activeItem ? activeItem.querySelector<HTMLElement>('.batch-pct') : null;
    }
    if (cachedBg) cachedBg.style.inlineSize = `${pct}%`;
    if (cachedBar) cachedBar.style.inlineSize = `${pct}%`;
    if (cachedText) cachedText.textContent = `${pct}%`;
    if (lastSepPct >= 1.0) {
      // F-5: clear any pending hide so the NEXT batch file's stage line
      // isn't hidden by the PREVIOUS file's 1200ms timer.
      if (stageHideTimer) window.clearTimeout(stageHideTimer);
      stageHideTimer = window.setTimeout(hideStageLine, 1200);
    }
  };
  void listen<number>('sep-progress', (ev) => {
    lastSepPct = ev.payload;
    coalesceRaf('sep-progress', paintSepProgress);
  });

  // Sprint C2: visible pipeline stages (توحيد ← فصل ← مؤثرات ← ترميز)
  const paintSepStage = () => {
    if (!lastStage) return;
    const line = document.getElementById('stage-line');
    const name = document.getElementById('stage-name');
    const bar = document.getElementById('stage-bar');
    const pctEl = document.getElementById('stage-pct');
    if (!line || !name || !bar || !pctEl) return;
    line.classList.remove('hidden');
    const pct = Math.round(lastStage.pct * 100);
    name.textContent = STAGE_NAMES[lastStage.stage]?.[lang] ?? lastStage.stage;
    bar.style.inlineSize = `${pct}%`;
    pctEl.textContent = `${pct}%`;
  };
  void listen<{ stage: string; pct: number }>('sep-stage', (ev) => {
    lastStage = ev.payload;
    coalesceRaf('sep-stage', paintSepStage);
  });

  sepBtnEl()?.addEventListener('click', async () => {
    if (batchRunning) {
      // F-3: abort the file being processed NOW, not just the ones after it
      batchAbort = true;
      void invoke('cancel_process');
      return;
    }
    if (singleRunning) {
      // F-4: the separate button doubles as a cancel button for single runs
      void invoke('cancel_process');
      return;
    }
    const keepInst = (document.getElementById('keep-inst') as HTMLInputElement)?.checked ?? false;
    const advFmt = (document.getElementById('fmt-select') as HTMLSelectElement)?.value;
    const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
    const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'audio';
    const qSel = document.getElementById('quality-select') as HTMLSelectElement | null;
    const quality = outKind === 'video' && qSel?.value ? Number(qSel.value) : undefined;

    // single-file fast path
    if (batchQueue.length <= 1) {
      if (!lastProbeOk || !currentMediaPath) {
        setVerdict(probeEl(), 'أفلت ملفاً أو اختره أولاً — سيُفحص تلقائياً', true);
        return;
      }
      lastSepOpts = { outKind, quality, advFmt };
      await runOne(currentMediaPath, keepInst, { outKind, quality, advFmt }, result!);
      return;
    }

    // batch path
    lastSepOpts = { outKind, quality, advFmt };
    batchRunning = true;
    batchAbort = false;
    sepBtnEl().textContent = '⏸ إيقاف';
    const failures: string[] = [];
    const total = batchQueue.length;
    let done = 0;
    for (const f of batchQueue) {
      if (batchAbort) break;
      markBatchItem(f, 'run');
      setBatchCounter(done, total);
      try {
        const res = await runSeparationFor(f, keepInst, { outKind, quality, advFmt });
        const resultPath = res.video || res.vocals || res.instrumental || undefined;
        markBatchItem(f, 'ok', resultPath);
        void notify(t('notify_done'), fileBaseName(f));
      } catch (e) {
        markBatchItem(f, 'fail');
        failures.push(`${f} — ${e}`);
        invoke('push_log', { level: 'error', message: `batch item failed: ${f}: ${e}` });
        void notify(t('notify_fail'), fileBaseName(f));
      }
      done += 1;
      setBatchCounter(done, total);
    }
    batchRunning = false;
    sepBtnEl().disabled = false;
    const key = currentMode === 'song' ? 'btn_sep_song' : 'btn_sep_clip';
    sepBtnEl().innerHTML =
      `<span class="material-symbols-outlined transition-transform duration-300 apple-ease group-hover:rotate-12 group-hover:scale-110" data-icon="content_cut">content_cut</span>
       <span id="sep-label" data-i18n="${key}">${t(key)}</span>`;
    if (result) {
      result.textContent = failures.length
        ? `اكتملت الدفعة: ${total - failures.length}/${total} نجح\nفشل:\n${failures.join('\n')}`
        : `اكتملت الدفعة: ${total}/${total} ✓`;
      result.classList.remove('hidden');
    }
    invoke('push_log', {
      level: failures.length ? 'warn' : 'info',
      message: `batch finished: ${total - failures.length}/${total}`,
    });
    // A finished batch (even partially failed — failures keep retry buttons)
    // is no longer "interrupted": drop the persisted queue.
    if (batchAbort || failures.length === 0) localStorage.removeItem('hl.batch');
    else saveBatchState();
    void notify(t('notify_batch_done'), `${total - failures.length}/${total} ✓`);
  });

}

async function runOne(
  path: string,
  keepInst: boolean,
  o: SepOpts,
  result: HTMLElement,
): Promise<void> {
  const btn = sepBtnEl();
  singleRunning = true;
  const prevHtml = btn.innerHTML;
  btn.disabled = false; // F-4: stays clickable — it is now the cancel button
  btn.textContent = '⏹ إلغاء';
  result.classList.add('hidden');
  markBatchItem(path, 'run');
  try {
    const res = await runSeparationFor(path, keepInst, o);
    const lines = [`تم الفصل خلال ${res.seconds.toFixed(1)}s`];
    if (res.vocals) lines.push(`صوت: ${res.vocals}`);
    if (res.instrumental) lines.push(`موسيقى: ${res.instrumental}`);
    if (res.video) lines.push(`فيديو: ${res.video}`);
    result.textContent = lines.join('\n');
    result.classList.remove('hidden');
    const resultPath = res.video || res.vocals || res.instrumental || undefined;
    markBatchItem(path, 'ok', resultPath);
    void notify(t('notify_done'), fileBaseName(path));
  } catch (e) {
    const msg = String(e);
    result.textContent = msg.includes('إلغاء') ? 'أُلغيت المعالجة.' : `فشل الفصل: ${e}`;
    result.classList.remove('hidden');
    markBatchItem(path, 'fail');
    invoke('push_log', { level: 'error', message: `separate failed: ${e}` });
    void notify(t('notify_fail'), fileBaseName(path));
  } finally {
    singleRunning = false;
    btn.disabled = false;
    btn.innerHTML = prevHtml;
  }
}

/* ── URL download (M5 UI) ───────────────────────────────────────────── */
function wireUrlDownload(): void {
  const btn = document.getElementById('btn-download') as HTMLButtonElement;
  const input = document.getElementById('url-input') as HTMLInputElement;
  const wrap = document.getElementById('dl-progress-wrap');
  const bar = document.getElementById('dl-progress');
  const res = document.getElementById('dl-result');
  const upd = document.getElementById('btn-upd-ytdlp') as HTMLButtonElement;

  let lastDlPct = 0;
  void listen<number>('dl-progress', (ev) => {
    lastDlPct = ev.payload;
    coalesceRaf('dl-progress', () => {
      if (bar) bar.style.inlineSize = `${Math.round(lastDlPct * 100)}%`;
    });
  });

  btn?.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url || !wrap || !bar || !res) return;
    btn.disabled = true;
    wrap.classList.remove('hidden');
    bar.style.inlineSize = '2%';
    res.classList.add('hidden');
    try {
      const outDir = pathInputEl().value
        ? outDirOf(pathInputEl().value)
        : '';
      const file = await invoke<string>('download_media_cmd', { url, outDir });
      res.textContent = `تم التنزيل: ${file}`;
      res.classList.remove('hidden');
      await ingestFiles([file]); // auto-fill + probe the downloaded file
    } catch (e) {
      res.textContent = `فشل التنزيل: ${e}`;
      res.classList.remove('hidden');
    } finally {
      bar.style.inlineSize = '100%';
      setTimeout(() => wrap.classList.add('hidden'), 600);
      btn.disabled = false;
    }
  });

  upd?.addEventListener('click', async () => {
    upd.disabled = true;
    try {
      const r = await invoke<{ updated: boolean; message: string }>('update_ytdlp');
      if (res) {
        res.textContent = r.message;
        res.classList.remove('hidden');
      }
    } finally {
      upd.disabled = false;
    }
  });
}

/* ── init ───────────────────────────────────────────────────────────── */
function wireOpenFolder(): void {
  const btn = document.getElementById('btn-open-folder');
  btn?.addEventListener('click', async () => {
    try {
      let outDir = currentMediaPath ? outDirOf(currentMediaPath) : '';
      await invoke('open_folder', { path: outDir });
      invoke('push_log', { level: 'info', message: `Opened folder: ${outDir}` });
    } catch (e) {
      invoke('push_log', { level: 'error', message: `Failed to open folder: ${e}` });
    }
  });
}

function wireSettings(): void {
  const btnSettings = document.getElementById('btn-settings');
  const menu = document.getElementById('settings-menu');
  const cudaCheckbox = document.getElementById('setting-cuda') as HTMLInputElement;
  const notifyCheckbox = document.getElementById('setting-notify') as HTMLInputElement;

  // CUDA_RUNTIME_PLAN: progress + completion of the self-download.
  void listen<{ file: string; pct: number }>('cuda-install', (ev) => {
    showCudaHint(`${t('cuda_downloading')} ${ev.payload.file} — ${Math.round(ev.payload.pct * 100)}%`);
  });
  void listen<{ ok: boolean; error?: string }>('cuda-install-done', (ev) => {
    const cb = document.getElementById('setting-cuda') as HTMLInputElement | null;
    if (ev.payload.ok) {
      localStorage.setItem('hl.cuda', '1');
      if (cb) cb.checked = true;
      showCudaHint(t('cuda_ready'));
      invoke('push_log', { level: 'info', message: 'مكتبات CUDA ثُبّتت بنجاح ✓' });
    } else {
      // condition 3: fallback — DirectML stays active, nothing breaks.
      // Show the backend's own explanation (e.g. "not published yet").
      localStorage.setItem('hl.cuda', '0');
      if (cb) cb.checked = false;
      showCudaHint(ev.payload.error || t('cuda_download_failed'));
      invoke('push_log', { level: 'error', message: `فشل تنزيل CUDA: ${ev.payload.error}` });
    }
    if (cb) cb.disabled = false;
    pushSettings();
    void updateCudaBanner();
  });

  if (cudaCheckbox) {
    cudaCheckbox.checked = localStorage.getItem('hl.cuda') === '1';
    cudaCheckbox.addEventListener('change', async (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      if (checked) {
        const st = await invoke<{ nvidia: boolean; cuda: boolean }>('cuda_status').catch(() => null);
        if (st && !st.nvidia) {
          cudaCheckbox.checked = false;
          localStorage.setItem('hl.cuda', '0');
          showCudaHint('');
          pushSettings();
          return;
        }
        if (st && st.cuda) {
          showCudaHint(t('cuda_ready'));
          localStorage.setItem('hl.cuda', '1');
          pushSettings();
          void updateCudaBanner();
          return;
        }
        // runtime missing → one-time self-download, box stays checked while disabled
        cudaCheckbox.disabled = true;
        showCudaHint(`${t('cuda_downloading')} 0%`);
        invoke('install_cuda_runtime').catch((err) => {
          cudaCheckbox.disabled = false;
          cudaCheckbox.checked = false;
          localStorage.setItem('hl.cuda', '0');
          showCudaHint(t('cuda_download_failed'));
          pushSettings();
          console.error('install_cuda_runtime failed', err);
        });
        return;
      }
      showCudaHint('');
      localStorage.setItem('hl.cuda', '0');
      pushSettings();
      void updateCudaBanner();
    });
  }

  if (notifyCheckbox) {
    notifyCheckbox.checked = localStorage.getItem('hl.notify') === '1';
    notifyCheckbox.addEventListener('change', (e) => {
      localStorage.setItem('hl.notify', (e.target as HTMLInputElement).checked ? '1' : '0');
      pushSettings();
    });
  }

  if (btnSettings && menu) {
    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target as Node) && !btnSettings.contains(e.target as Node)) {
        menu.classList.add('hidden');
      }
    });
  }

  // Functional gap: `settings-changed` was emitted but never listened to, so
  // an external edit of settings.json was silently clobbered. Converge the
  // read-only indicators on backend truth (safe with the 300ms push
  // debounce: rapid local toggles collapse into one push before any echo).
  void listen<RustSettings>('settings-changed', (ev) => {
    const s = ev.payload;
    if (!s || typeof s !== 'object') return;
    if (typeof s.cuda === 'boolean') {
      localStorage.setItem('hl.cuda', s.cuda ? '1' : '0');
      const cb = document.getElementById('setting-cuda') as HTMLInputElement | null;
      if (cb) cb.checked = s.cuda;
      void updateCudaBanner();
    }
    if (typeof s.notify === 'boolean') {
      localStorage.setItem('hl.notify', s.notify ? '1' : '0');
      const cb = document.getElementById('setting-notify') as HTMLInputElement | null;
      if (cb) cb.checked = s.notify;
    }
    if (typeof s.watch_enabled === 'boolean') {
      localStorage.setItem('hl.watch', s.watch_enabled ? '1' : '0');
      const cb = document.getElementById('setting-watch') as HTMLInputElement | null;
      if (cb) cb.checked = s.watch_enabled;
    }
    if (typeof s.watch_path === 'string') localStorage.setItem('hl.watch_path', s.watch_path);
    refreshWatchUi?.();
  });
}

/* ── unified external-jobs feed (functional gap: invisible externals) ─── */
type ExtKind = 'bridge' | 'watch';
interface ExtRow { kind: ExtKind; name: string; detail: string; pct: number | null }
const extJobs = new Map<string, ExtRow>();
let extSig = '';
function renderExtJobs(): void {
  const list = document.getElementById('ext-list');
  if (!list) return;
  const sig = [...extJobs.values()]
    .map((j) => `${j.kind}|${j.name}|${j.detail}|${j.pct === null ? '-' : Math.round(j.pct * 100)}`)
    .join('~');
  if (sig === extSig) return; // progress ticks at high frequency — skip no-ops
  extSig = sig;
  list.replaceChildren();
  if (!extJobs.size) {
    const s = document.createElement('span');
    s.id = 'ext-empty';
    s.className = 'font-label-sm text-label-sm text-on-surface-variant opacity-60';
    s.textContent = 'لا وظائف خارجية جارية';
    list.appendChild(s);
    return;
  }
  for (const job of extJobs.values()) {
    const row = document.createElement('div');
    row.className = 'bg-coal-surface/40 border border-border-muted rounded p-stack-sm flex flex-col gap-unit';
    const top = document.createElement('div');
    top.className = 'flex justify-between items-center gap-unit';
    const name = document.createElement('span');
    name.className = 'font-label-sm text-label-sm text-cream-text truncate flex-1';
    name.dir = 'ltr';
    name.textContent = `${job.kind === 'bridge' ? '🌐' : '📁'} ${job.name}`;
    const cancel = document.createElement('button');
    cancel.className = 'text-error hover:text-red-400 p-1 flex-shrink-0 font-label-sm text-label-sm';
    cancel.title = 'إلغاء';
    cancel.textContent = '⏹';
    cancel.addEventListener('click', () => {
      invoke(job.kind === 'bridge' ? 'cancel_bridge_job' : 'cancel_watch_file')
        .catch((e) => console.error('ext cancel failed', e));
    });
    top.append(name, cancel);
    row.appendChild(top);
    if (job.pct !== null) {
      const wrap = document.createElement('div');
      wrap.className = 'h-1.5 bg-border-muted rounded-full overflow-hidden';
      const bar = document.createElement('div');
      bar.className = 'h-full bg-clay-accent rounded-full';
      bar.style.inlineSize = `${Math.round(job.pct * 100)}%`;
      wrap.appendChild(bar);
      row.appendChild(wrap);
    }
    const detail = document.createElement('span');
    detail.className = 'font-label-sm text-label-sm text-on-surface-variant';
    detail.textContent = job.detail;
    row.appendChild(detail);
    list.appendChild(row);
  }
}
function wireExtJobs(): void {
  void listen<{ name: string; queue?: number }>('bridge-start', (ev) => {
    extJobs.set(`bridge:${ev.payload.name}`, {
      kind: 'bridge', name: ev.payload.name,
      detail: `تنزيل/فصل عبر المتصفح…${ev.payload.queue ? ` (في الطابور: ${ev.payload.queue})` : ''}`,
      pct: null,
    });
    renderExtJobs();
  });
  void listen<{ name: string }>('bridge-done', () => {
    for (const key of [...extJobs.keys()]) {
      if (key.startsWith('bridge:')) extJobs.delete(key);
    }
    renderExtJobs();
  });
  // Global progress bars also move during bridge jobs — mirror them unless a
  // GUI job owns the bar right now (avoids cross-talk on overlap).
  void listen<number>('dl-progress', (ev) => {
    if (singleRunning || batchRunning) return;
    for (const job of extJobs.values()) {
      if (job.kind === 'bridge' && job.pct === null) job.pct = ev.payload * 0.2;
    }
    renderExtJobs();
  });
  void listen<number>('sep-progress', (ev) => {
    if (singleRunning || batchRunning) return;
    for (const job of extJobs.values()) {
      if (job.kind === 'bridge') job.pct = 0.2 + ev.payload * 0.8;
    }
    renderExtJobs();
  });
  void listen<{ path: string }>('watch-start', (ev) => {
    extJobs.set(`watch:${ev.payload.path}`, {
      kind: 'watch', name: ev.payload.path, detail: 'معالجة ملف مراقب…', pct: 0,
    });
    renderExtJobs();
  });
  void listen<{ path: string; pct: number }>('watch-progress', (ev) => {
    const job = extJobs.get(`watch:${ev.payload.path}`);
    if (job) {
      job.pct = ev.payload.pct;
      job.detail = 'معالجة ملف مراقب…';
      renderExtJobs();
    }
  });
  void listen<{ path: string }>('watch-done', (ev) => {
    extJobs.delete(`watch:${ev.payload.path}`);
    renderExtJobs();
  });
  renderExtJobs();
}

/* ── about + report (Sprint B3/B4) ──────────────────────────────────── */
function fillAbout(): void {
  const body = document.getElementById('about-body');
  if (!body) return;
  const credits = [
    'UVR-MDX-NET-Voc_FT — نموذج الفصل (63MB، تشغيل محلي كامل)',
    'ONNX Runtime — محرك الاستدلال (CPU / DirectML / CUDA)',
    'FFmpeg / ffprobe — الفحص والمعالجة والترميز',
    'yt-dlp — تنزيل الوسائط',
    'Thmanyah Typeface — الخط العربي',
    'Material Symbols — الأيقونات',
  ];
  body.innerHTML = `
    <div class="flex items-center gap-unit">
      <span class="font-bold text-clay-accent">HaramLite</span>
      <span id="about-version" class="bg-clay-accent/20 text-clay-accent px-1.5 py-0.5 rounded font-bold">v${appVersion || '—'}</span>
    </div>
    <p>${t('about_dev')} — أداة رأي تعمل محلياً 100% حفاظاً على الخصوصية.</p>
    <div class="mt-2">
      <div class="font-bold text-on-surface-variant mb-1">${t('about_credits')}:</div>
      <ul class="flex flex-col gap-unit text-on-surface-variant text-xs leading-relaxed">
        ${credits.map((c) => `<li>• ${c}</li>`).join('')}
      </ul>
    </div>`;
}
function wireAbout(): void {
  const overlay = document.getElementById('about-overlay');
  const open = () => {
    fillAbout();
    overlay?.classList.remove('hidden');
  };
  document.getElementById('btn-about')?.addEventListener('click', open);
  document.getElementById('about-close')?.addEventListener('click', () => overlay?.classList.add('hidden'));
  document.getElementById('about-ok')?.addEventListener('click', () => overlay?.classList.add('hidden'));
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
}
function wireReport(): void {
  document.getElementById('btn-report')?.addEventListener('click', () => {
    void openUrl('https://github.com/SMSMy/HaramLite/issues/new').catch((e) =>
      console.error('open issues page failed', e));
  });
}

/* ── repair wizard (Sprint C1) ──────────────────────────────────────── */
type HealthRow = { key: string; label: string; ok: boolean; path: string | null };

async function fetchHealth(): Promise<HealthRow[]> {
  try {
    const r = await invoke<HealthRow[]>('health_check_cmd');
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

async function renderRepairList(): Promise<HealthRow[]> {
  const list = document.getElementById('repair-list');
  const rows = await fetchHealth();
  if (!list) return rows;
  list.replaceChildren(...rows.map((row) => {
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between gap-unit font-body-sm text-sm';
    const left = document.createElement('span');
    left.textContent = (row.ok ? '✓ ' : '✗ ') + row.label;
    left.className = row.ok ? 'text-tertiary' : 'text-error';
    div.appendChild(left);
    if (!row.ok) {
      const btn = document.createElement('button');
      btn.textContent = t('repair_one');
      btn.className = 'text-clay-accent hover:text-primary-container font-label-sm text-label-sm cursor-pointer';
      btn.addEventListener('click', () => void repairOne(row.key));
      div.appendChild(btn);
    }
    return div;
  }));
  return rows;
}

async function repairOne(key: string): Promise<void> {
  const wrap = document.getElementById('repair-progress-wrap');
  const bar = document.getElementById('repair-progress');
  const res = document.getElementById('repair-result');
  wrap?.classList.remove('hidden');
  if (bar) bar.style.inlineSize = '0%';
  try {
    await invoke<string>('repair_component', { key });
    if (res) {
      res.textContent = `✓ ${t('repair_done')}`;
      res.className = 'font-body-sm text-sm text-tertiary';
      res.classList.remove('hidden');
    }
    await renderRepairList();
  } catch (e) {
    if (res) {
      res.textContent = `✗ ${String(e).slice(0, 200)}`;
      res.className = 'font-body-sm text-sm text-error';
      res.classList.remove('hidden');
    }
    invoke('push_log', { level: 'error', message: `repair failed: ${e}` });
  } finally {
    if (bar) bar.style.inlineSize = '100%';
    window.setTimeout(() => wrap?.classList.add('hidden'), 800);
  }
}

async function repairAll(): Promise<void> {
  const rows = await fetchHealth();
  const missing = rows.filter((r) => !r.ok);
  for (const row of missing) {
    await repairOne(row.key);
  }
  const after = await fetchHealth();
  if (after.length && after.every((r) => r.ok)) {
    showToast(t('repair_all_ok'));
    document.getElementById('repair-overlay')?.classList.add('hidden');
    void notify(t('repair_all_ok'), '');
  }
}

function wireRepair(): void {
  const overlay = document.getElementById('repair-overlay');
  const open = async () => {
    const rows = await renderRepairList();
    if (rows.some((r) => !r.ok)) overlay?.classList.remove('hidden');
    else showToast(t('repair_all_ok'));
  };
  document.getElementById('btn-repair-open')?.addEventListener('click', () => void open());
  document.getElementById('repair-close')?.addEventListener('click', () => overlay?.classList.add('hidden'));
  document.getElementById('repair-cancel')?.addEventListener('click', () => overlay?.classList.add('hidden'));
  document.getElementById('repair-all')?.addEventListener('click', () => void repairAll());
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
  void listen<number>('repair-progress', (ev) => {
    const bar = document.getElementById('repair-progress');
    const wrap = document.getElementById('repair-progress-wrap');
    if (bar && wrap) {
      wrap.classList.remove('hidden');
      bar.style.inlineSize = `${Math.round(ev.payload * 100)}%`;
    }
  });
}

/** Startup gate: if any component is missing, open the repair wizard. */
async function autoHealthCheck(): Promise<void> {
  const rows = await fetchHealth();
  if (rows.length === 0) return; // backend unavailable (e.g. browser dev) — skip
  if (rows.some((r) => !r.ok)) {
    await renderRepairList();
    document.getElementById('repair-overlay')?.classList.remove('hidden');
    invoke('push_log', {
      level: 'warn',
      message: `مكونات ناقصة: ${rows.filter((r) => !r.ok).map((r) => r.key).join(', ')}`,
    });
  }
}

/* ── auto-updater (Sprint C2) ───────────────────────────────────────── */
let updateCheckRunning = false;
async function manualUpdateCheck(): Promise<void> {
  if (updateCheckRunning) return;
  updateCheckRunning = true;
  showToast(t('upd_checking'));
  try {
    const update = await checkUpdate();
    if (!update) {
      showToast(t('upd_none'));
      return;
    }
    const ok = window.confirm(`${t('upd_avail')} v${update.version}\n\n${t('upd_ask')}`);
    if (!ok) return;
    showToast(t('upd_checking'));
    let received = 0;
    let total = 0;
    await update.downloadAndInstall((ev) => {
      if (ev.event === 'Started') {
        total = (ev.data as { contentLength?: number }).contentLength ?? 0;
      } else if (ev.event === 'Progress') {
        received += (ev.data as { chunkLength: number }).chunkLength;
        const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
        showToast(`${t('upd_checking')} ${pct}%`);
      }
    });
    showToast(t('upd_downloaded'));
  } catch (e) {
    const msg = String(e);
    invoke('push_log', { level: 'warn', message: `update check failed: ${msg}` });
    showToast(`${t('upd_error')}: ${msg.slice(0, 100)}`);
  } finally {
    updateCheckRunning = false;
  }
}
async function silentUpdateCheck(): Promise<void> {
  try {
    const update = await checkUpdate();
    if (update) {
      showToast(`${t('upd_avail')} v${update.version}`);
      invoke('push_log', { level: 'info', message: `update available: v${update.version}` });
    }
  } catch (e) {
    // dev / portable builds — expected, never fatal
    invoke('push_log', { level: 'debug', message: `update check unavailable: ${String(e).slice(0, 120)}` });
  }
}
function wireUpdater(): void {
  document.getElementById('btn-check-update')?.addEventListener('click', () => void manualUpdateCheck());
}

/* ── browser integration (Sprint E2) ────────────────────────────────── */
function wireBridge(): void {
  let bridgeCardTimer: number | undefined; // F-5: one pending hide at a time
  document.getElementById('btn-bridge')?.addEventListener('click', async () => {
    // Audit 2026-09-03: register every supported browser — the backend
    // accepts 'firefox' but the UI hardcoded 'chrome', leaving Firefox
    // users with no way to enable the integration.
    try {
      const r1 = await invoke<string>('register_native_host', { browser: 'chrome' });
      const r2 = await invoke<string>('register_native_host', { browser: 'firefox' });
      showToast(`${r1}\n${r2}`);
      invoke('push_log', { level: 'info', message: `${r1} / ${r2}` });
    } catch (e) {
      showToast(`✗ ${String(e).slice(0, 120)}`);
      invoke('push_log', { level: 'error', message: `native host registration failed: ${e}` });
    }
  });
  void listen<{ name: string; ok: boolean; seconds?: number; error?: string }>('bridge-done', (ev) => {
    const p = ev.payload;
    showToast(p.ok
      ? `✓ ${p.name} (${p.seconds?.toFixed(1)}s)`
      : `✗ ${p.name}: ${String(p.error ?? '').slice(0, 80)}`);
    // completion sound for browser-initiated jobs (notification setting)
    if (localStorage.getItem('hl.notify') === '1') playDing();
    // completion card with a quick "open results folder" action
    const card = document.getElementById('bridge-card');
    const cardText = document.getElementById('bridge-card-text');
    if (card && cardText) {
      cardText.textContent = p.ok
        ? `${p.name} — تم في ${p.seconds?.toFixed(1)}s`
        : `${p.name} — ${String(p.error ?? '').slice(0, 120)}`;
      cardText.className = p.ok
        ? 'font-body-sm text-sm text-cream-text'
        : 'font-body-sm text-sm text-error';
      const openBtn = document.getElementById('bridge-card-open');
      if (openBtn) openBtn.style.display = p.ok ? '' : 'none';
      card.classList.remove('hidden');
      // F-5: two jobs finishing back to back must not let the FIRST
      // job's 8s timer hide the SECOND job's card early.
      if (bridgeCardTimer) window.clearTimeout(bridgeCardTimer);
      bridgeCardTimer = window.setTimeout(() => card.classList.add('hidden'), 8000);
    }
  });
  const bridgeCard = document.getElementById('bridge-card');
  document.getElementById('bridge-card-close')?.addEventListener('click', () => bridgeCard?.classList.add('hidden'));
  document.getElementById('bridge-card-open')?.addEventListener('click', () => {
    invoke('open_folder', { path: '' }).catch(console.error);
  });
}

function wire(): void {
  startStallDetector();
  wireLang();
  wireSettings();

  window.addEventListener('error', (ev) =>
    invoke('push_log', { level: 'error', message: `JS error: ${ev.message}` }));
  window.addEventListener('unhandledrejection', (ev) =>
    invoke('push_log', { level: 'error', message: `JS unhandled rejection: ${String(ev.reason)}` }));

  wireModes();
  wireKinds();
  wireDropzone();
  wireSeparate();
  wireUrlDownload();
  wireLogToggle();
  wireOpenFolder();
  wirePreview();
  wireAbout();
  wireReport();
  wireRepair();
  wireUpdater();
  wireWatchSettings();
  wireBridge();
  wireExtJobs();
}

async function init(): Promise<void> {
  // Sprint D1: seed localStorage from the Rust settings store (fresh installs)
  await seedSettings();

  applyLang();

  wire();
  wireSecretSettings();
  restoreBatchState();
  try {
    const info = await invoke<{ app: string; version: string }>('ping');
    appVersion = info.version;
    const badge = document.getElementById('version-badge');
    if (badge) badge.title = `HaramLite ${info.version}`;
    if (badge) badge.textContent = `v${info.version}`;
  } catch (e) {
    console.error(e);
  }
  
  // Audit 2026-09-03: no forced yt-dlp update here — the backend
  // `ytdlp-update` thread already checks on its 24h cadence, and a second
  // forced updater raced it on the same files at every boot. Manual updates
  // stay on the yt-dlp button (wireUrlDownload).
  void 0;

  // Sprint C1: missing components → repair wizard; Sprint C2: silent update check
  void autoHealthCheck();
  void silentUpdateCheck();

  // Smart CUDA advice: permanent green banner while NVIDIA is supported
  // and the CUDA toggle is off (updates itself on every settings change)
  void updateCudaBanner();

  // Audit F-1: live log lines arrive as pushed events — no polling.
  void listen<LogLine>('log-line', (ev) => pushLogLine(ev.payload));

  await refresh();
}

void init();
