import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as dialog from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { applyLang, currentLang, t, wireLang } from './i18n';
import { notify, playDing, showToast, trapFocus } from './util';
import { pushLogLine, refresh, wireLogToggle } from './log';
import type { LogLine } from './types';
import { startLongtaskWatch, startStallDetector } from './diagnostics';
import { showCudaHint, updateCudaBanner } from './cuda';
import {
  notifyWatchUiChanged,
  pushSettings,
  seedSettings,
  setAutostartAsked,
  setTelegramApiHash,
  setTelegramToken,
  type RustSettings,
} from './settings';
import { wireWatchSettings } from './watch';
import * as session from './session';
import { outDirOf, setVerdictHtml, verdictHtml } from './media';
import { ingestFiles, restoreBatchState, wireSeparate, wireUrlDownload } from './queue';
import { wirePlayer } from './player';


/* ── production hardening: silence the WebView default context menu ── */
// Release builds ship no devtools (tauri features=[] — verified, no
// open_devtools anywhere), but WebView2 still pops its default menu
// (Back/Refresh/More tools…) on right-click. Suppress it app-wide EXCEPT
// inside genuinely editable fields, where the native menu carries cut/copy/
// paste. Read-only/disabled fields fall through to suppression.
function wireContextMenu(): void {
  window.addEventListener('contextmenu', (ev) => {
    const t = ev.target as HTMLElement | null;
    const field = t?.closest?.('input, textarea, [contenteditable="true"], [contenteditable=""]') as (HTMLInputElement | HTMLTextAreaElement | HTMLElement) | null;
    if (field) {
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        if (!field.readOnly && !field.disabled) return;
      } else {
        return; // contenteditable host itself
      }
    }
    ev.preventDefault();
  });
}

/* ── wiring ─────────────────────────────────────────────────────────── */

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
      session.setCurrentMode((card.dataset.mode as 'song' | 'clip') ?? 'song');
      cards.forEach((c) => c.classList.toggle('selected', c === card));
      if (sepLabel) {
        const key = session.getCurrentMode() === 'song' ? 'btn_sep_song' : 'btn_sep_clip';
        sepLabel.dataset.i18n = key;
        sepLabel.innerHTML = t(key);
      }
      invoke('push_log', { level: 'info', message: `mode → ${session.getCurrentMode()}` });
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
    ? (session.getCurrentMode() === 'song' ? t('preview_hint_song') : t('preview_hint_clip'))
    : '';
}
function wirePreview(): void {
  const toggle = document.getElementById('preview-toggle') as HTMLInputElement | null;
  const sel = document.getElementById('preview-duration') as HTMLSelectElement | null;
  if (!toggle || !sel) return;
  toggle.addEventListener('change', () => {
    session.setPreviewEnabled(toggle.checked);
    localStorage.setItem('hl.preview', session.getPreviewEnabled() ? '1' : '0');
    pushSettings();
    refreshPreviewHint();
  });
  sel.addEventListener('change', () => {
    session.setPreviewSeconds(Number(sel.value) || 15);
    localStorage.setItem('hl.preview_seconds', String(session.getPreviewSeconds()));
    pushSettings();
  });
  // restore persisted state
  toggle.checked = localStorage.getItem('hl.preview') === '1';
  session.setPreviewEnabled(toggle.checked);
  const saved = Number(localStorage.getItem('hl.preview_seconds'));
  if (saved === 10 || saved === 15 || saved === 30) {
    sel.value = String(saved);
    session.setPreviewSeconds(saved);
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
        setVerdictHtml(v, verdictHtml(card.dataset.kind === 'video' ? 'video' : 'audio'));
      }
      
      invoke('push_log', { level: 'info', message: `kind → ${card.dataset.kind}` });
    });
  });
}

function wireDropzone(): void {
  const dz = document.getElementById('dropzone');
  const pickFiles = async (): Promise<void> => {
    const picked = await dialog.open({
      multiple: true,
      filters: [
        { name: 'Media', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'] },
      ],
    });
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    await ingestFiles(files);
  };
  dz?.addEventListener('click', () => { void pickFiles(); });
  // #dropzone is a div with role="button"/tabindex="0": activate it with Enter
  // or Space exactly like a click. Space is prevented from scrolling, and both
  // keys are ignored when they come from the inner «تصفح الملفات» button, which
  // already turns Enter/Space into a click of its own (no double dialog).
  dz?.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    if ((ev.target as HTMLElement | null)?.closest('button')) return;
    ev.preventDefault();
    void pickFiles();
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


/* ── init ───────────────────────────────────────────────────────────── */
function wireOpenFolder(): void {
  const btn = document.getElementById('btn-open-folder');
  btn?.addEventListener('click', async () => {
    try {
      let outDir = session.getCurrentMediaPath() ? outDirOf(session.getCurrentMediaPath()) : '';
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
    let menuRelease: (() => void) | null = null;
    const closeMenu = (): void => {
      menu.classList.add('hidden');
      menuRelease?.();
      menuRelease = null;
    };
    btnSettings.setAttribute('aria-expanded', menu.classList.contains('hidden') ? 'false' : 'true');
    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = menu.classList.contains('hidden');
      if (willOpen) {
        menu.classList.remove('hidden');
        if (menuRelease === null) menuRelease = trapFocus(menu);
      } else {
        closeMenu();
      }
      btnSettings.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target as Node) && !btnSettings.contains(e.target as Node)) {
        closeMenu();
        btnSettings.setAttribute('aria-expanded', 'false');
      }
    });
    // the settings popup counts as one of the app's dialogs — ESC closes it
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
        closeMenu();
        btnSettings.setAttribute('aria-expanded', 'false');
        btnSettings.focus();
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
    if (typeof s.bridge_enabled === 'boolean') {
      localStorage.setItem('hl.bridge', s.bridge_enabled ? '1' : '0');
      const cb = document.getElementById('setting-bridge') as HTMLInputElement | null;
      if (cb) cb.checked = s.bridge_enabled;
  void refreshBridgeExt();
  void refreshAutostart();
  void invoke<{ enabled: boolean }>('autostart_status')
    .then((r) => askAutostartOnce(s.autostart_asked === true, !!r.enabled))
    .catch(() => { /* لا سؤال إن تعذّرت القراءة */ });
    }
    // Sprint T1: the Telegram worker rewrites these itself on a successful
    // pairing, so the panel must follow backend truth (never a stale cache).
    if (typeof s.telegram_enabled === 'boolean') {
      localStorage.setItem('hl.tg', s.telegram_enabled ? '1' : '0');
      const cb = document.getElementById('setting-telegram') as HTMLInputElement | null;
      if (cb) cb.checked = s.telegram_enabled;
    }
    if (typeof s.telegram_user_id === 'string') {
      localStorage.setItem('hl.tg_owner', s.telegram_user_id);
      const inp = document.getElementById('tg-owner') as HTMLInputElement | null;
      if (inp && inp.value !== s.telegram_user_id) inp.value = s.telegram_user_id;
    }
    if (typeof s.watch_path === 'string') localStorage.setItem('hl.watch_path', s.watch_path);
    notifyWatchUiChanged();
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
    s.className = 'font-label-sm text-label-sm text-on-surface-variant opacity-80';
    s.textContent = t('ext_empty');
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
    cancel.title = t('ext_cancel');
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
      detail: `${t('ext_bridge_detail')}${ev.payload.queue ? t('ext_bridge_queued', { n: ev.payload.queue }) : ''}`,
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
    if (session.getSingleRunning() || session.getBatchRunning()) return;
    for (const job of extJobs.values()) {
      if (job.kind === 'bridge' && job.pct === null) job.pct = ev.payload * 0.2;
    }
    renderExtJobs();
  });
  void listen<number>('sep-progress', (ev) => {
    if (session.getSingleRunning() || session.getBatchRunning()) return;
    for (const job of extJobs.values()) {
      if (job.kind === 'bridge') job.pct = 0.2 + ev.payload * 0.8;
    }
    renderExtJobs();
  });
  void listen<{ path: string }>('watch-start', (ev) => {
    extJobs.set(`watch:${ev.payload.path}`, {
      kind: 'watch', name: ev.payload.path, detail: t('ext_watch_detail'), pct: 0,
    });
    renderExtJobs();
  });
  void listen<{ path: string; pct: number }>('watch-progress', (ev) => {
    const job = extJobs.get(`watch:${ev.payload.path}`);
    if (job) {
      job.pct = ev.payload.pct;
      job.detail = t('ext_watch_detail');
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
type Credit = { name: string; url?: string; ar: string; en: string };
function fillAbout(): void {
  const body = document.getElementById('about-body');
  if (!body) return;
  const credits: Credit[] = [
    { name: 'UVR-MDX-NET-Voc_FT — Ultimate Vocal Remover', url: 'https://github.com/Anjok07/ultimatevocalremovergui', ar: 'نموذج الفصل (63MB، تشغيل محلي كامل) من Ultimate Vocal Remover — Anjok07 و aufr33، بترخيص MIT', en: 'separation model (63MB, fully local) by Ultimate Vocal Remover — Anjok07 & aufr33, MIT-licensed' },
    { name: 'ONNX Runtime', ar: 'محرك الاستدلال (CPU / DirectML / CUDA)', en: 'inference engine (CPU / DirectML / CUDA)' },
    { name: 'FFmpeg / ffprobe', ar: 'الفحص والمعالجة والترميز', en: 'probing, processing and encoding' },
    { name: 'yt-dlp', ar: 'تنزيل الوسائط', en: 'media downloads' },
    { name: 'Thmanyah Typeface', ar: 'الخط العربي', en: 'Arabic typeface' },
    { name: 'Material Symbols', ar: 'الأيقونات', en: 'icons' },
    { name: 'HaramMute', url: 'https://github.com/alganzory', ar: 'الملهم الأول', en: 'The first inspiration' },
  ];
  const desc = (c: Credit): string => (currentLang() === 'ar' ? c.ar : c.en);
  const link = (text: string, url: string): string =>
    `<span class="about-link" data-open-url="${url}">${text}</span>`;
  body.innerHTML = `
    <div class="flex items-center gap-unit">
      <span class="font-bold text-clay-accent">HaramLite</span>
      <span id="about-version" class="bg-clay-accent/20 text-clay-accent px-1.5 py-0.5 rounded font-bold">v${session.getAppVersion() || '—'}</span>
    </div>
    <p>${t('about_dev')} ${link('smsmy', 'https://github.com/SMSMy/HaramLite')} — ${t('about_dev_rest')}</p>
    <div class="mt-2">
      <div class="font-bold text-on-surface-variant mb-1">${t('about_credits')}:</div>
      <ul class="flex flex-col gap-unit text-on-surface-variant text-xs leading-relaxed">
        ${credits.map((c) => `<li>• ${c.url ? link(c.name, c.url) : c.name} — ${desc(c)}</li>`).join('')}
      </ul>
    </div>`;
}
function wireAbout(): void {
  const overlay = document.getElementById('about-overlay');
  let release: (() => void) | null = null;
  const close = (): void => {
    overlay?.classList.add('hidden');
    release?.();
    release = null;
  };
  const open = () => {
    fillAbout();
    overlay?.classList.remove('hidden');
    if (overlay) release = trapFocus(overlay);
  };
  // External links inside the modal (dev credit, inspiring projects):
  // delegated once on the stable container — innerHTML re-renders freely.
  // data-open-url only (never raw href — href would navigate the WebView
  // itself out of the app and break it).
  document.getElementById('about-body')?.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest?.('[data-open-url]') as HTMLElement | null;
    const url = el?.getAttribute('data-open-url');
    if (url) void openUrl(url).catch((err) => console.error('openUrl failed', err));
  });
  document.getElementById('btn-about')?.addEventListener('click', open);
  document.getElementById('about-close')?.addEventListener('click', close);
  document.getElementById('about-ok')?.addEventListener('click', close);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  // ESC must dismiss this dialog too (the Telegram panel already did).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) close();
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
    hideRepairDialog();
    void notify(t('repair_all_ok'), '');
  }
}

/** The overlay + focus trap live in wireRepair(); these two thin wrappers let the
 *  startup auto-check open the wizard (and repairAll() close it) without
 *  duplicating the trap bookkeeping. */
let repairRelease: (() => void) | null = null;
function showRepairDialog(): void {
  const overlay = document.getElementById('repair-overlay');
  overlay?.classList.remove('hidden');
  if (overlay && repairRelease === null) repairRelease = trapFocus(overlay);
}
function hideRepairDialog(): void {
  document.getElementById('repair-overlay')?.classList.add('hidden');
  repairRelease?.();
  repairRelease = null;
}

function wireRepair(): void {
  const overlay = document.getElementById('repair-overlay');
  const show = showRepairDialog;
  const close = hideRepairDialog;
  const open = async () => {
    const rows = await renderRepairList();
    if (rows.some((r) => !r.ok)) show();
    else showToast(t('repair_all_ok'));
  };
  document.getElementById('btn-repair-open')?.addEventListener('click', () => void open());
  document.getElementById('repair-close')?.addEventListener('click', close);
  document.getElementById('repair-cancel')?.addEventListener('click', close);
  document.getElementById('repair-all')?.addEventListener('click', () => void repairAll());
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) close();
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
    showRepairDialog();
    invoke('push_log', {
      level: 'warn',
      message: `مكونات ناقصة: ${rows.filter((r) => !r.ok).map((r) => r.key).join(', ')}`,
    });
  }
}

/* ── update check (هـ) ───────────────────────────────────────────────
 * 0.2.4 أزالت زرّ «التحقق من التحديثات» لأن نداء `tauri-plugin-updater` كان
 * يفشل دائماً: لا `latest.json` يُنشر ما دام `createUpdaterArtifacts:false`.
 * القناة الجديدة (الخيار ١) تسأل واجهة GitHub العامة عن `releases/latest`
 * عبر أمر Rust واحد (‏`check_update`) وتقارن دلالياً بإصدار الحزمة نفسه.
 * قاعدة هذا الصفّ: **لا زرّ يفشل بصمت** — كل خروج إما نصّ نتيجة أو نصّ خطأ
 * عربي في `#update-status`، ومعها سطر في السجل. */
type UpdateStatus = {
  current: string;
  latest: string | null;
  update_available: boolean;
  download_url: string;
  error: string | null;
  from_cache: boolean;
};

const UPDATE_PAGE_FALLBACK = 'https://github.com/SMSMy/HaramLite/releases/latest';

/** نصّ الصفّ: نجاحاً أو فشلاً. `isError` يلوّنه ويعلن سبب الخطأ للقارئ. */
function setUpdRow(text: string, isError: boolean): void {
  const el = document.getElementById('update-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('text-error', isError);
  el.classList.toggle('text-on-surface-variant', !isError);
  el.classList.remove('hidden');
}

/** زرّ صفحة التنزيل يظهر عند وجود أحدث فقط، ويحمل رابطه في `data-url`. */
function setUpdDownload(url: string | null): void {
  const btn = document.getElementById('btn-update-download');
  if (!btn) return;
  btn.classList.toggle('hidden', !url);
  btn.classList.toggle('flex', !!url);
  if (url) btn.dataset.url = url;
  else delete btn.dataset.url;
}

/**
 * الفحص. `force=true` هو الزرّ: نداء حقيقي دائماً ونتيجته **ظاهرة دائماً**
 * (نصّ في الصفّ، وإشعار، وسطر في السجل) — نجاحاً أو فشلاً، فلا زرّ يفشل بصمت.
 * و`force=false` هو الفحص الصامت عند الإقلاع (كاش ٢٤ ساعة في الرست — هـ.٤):
 * لا يكتب في الواجهة إلا حين يوجد أحدث فعلاً، وإلا فسطر في السجل وحده — فلا
 * يصير «خطأ إطلاق صامت» يزعج المستخدم في كل إقلاع بلا شبكة.
 */
async function runUpdateCheck(force: boolean): Promise<UpdateStatus | null> {
  const btn = document.getElementById('btn-update-check') as HTMLButtonElement | null;
  if (force) {
    if (btn) btn.disabled = true;
    setUpdRow(t('upd_checking'), false);
  }
  try {
    const st = await invoke<UpdateStatus>('check_update', { force });

    if (st.error) {
      // مسار الفشل: بلا شبكة · بلا إصدارات منشورة · استجابة غير متوقعة · JSON مشوّه
      if (force) {
        setUpdRow(`${t('upd_failed')} — ${st.error}`, true);
        setUpdDownload(null);
        showToast(`${t('upd_failed')} — ${st.error}`);
      }
      invoke('push_log', { level: force ? 'warn' : 'debug', message: `update check failed: ${st.error}` });
      return st;
    }

    if (st.update_available && st.latest) {
      setUpdRow(t('upd_found', { v: st.latest }), false);
      setUpdDownload(st.download_url || UPDATE_PAGE_FALLBACK);
      invoke('push_log', {
        level: 'info',
        message: `update available: v${st.latest} (current v${st.current}${st.from_cache ? ', cached' : ''})`,
      });
      if (force) showToast(`${t('upd_avail')} v${st.latest}`);
      return st;
    }

    if (force) {
      setUpdRow(t('upd_uptodate', { v: st.current }), false);
      setUpdDownload(null);
      showToast(t('upd_uptodate', { v: st.current }));
    }
    invoke('push_log', { level: 'debug', message: `update check: v${st.current} is the latest` });
    return st;
  } catch (e) {
    // حتى فشل الأمر نفسه (ثنائي قديم بلا الأمر، أو خطأ داخلي) له نصّ ظاهر.
    const msg = String(e);
    if (force) {
      setUpdRow(`${t('upd_failed')} — ${msg}`, true);
      setUpdDownload(null);
      showToast(`${t('upd_failed')} — ${msg}`);
    }
    invoke('push_log', { level: force ? 'warn' : 'debug', message: `update check command failed: ${msg}` });
    return null;
  } finally {
    if (force && btn) btn.disabled = false;
  }
}

/** الفحص الصامت عند الإقلاع (كان نداء `tauri-plugin-updater` يفشل دائماً). */
async function silentUpdateCheck(): Promise<void> {
  await runUpdateCheck(false);
}

function wireUpdateCheck(): void {
  document.getElementById('btn-update-check')?.addEventListener('click', () => void runUpdateCheck(true));
  document.getElementById('btn-update-download')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-update-download');
    const url = btn?.dataset.url || UPDATE_PAGE_FALLBACK;
    // فشل الفتح أيضاً لا يمرّ بصمت: نصّ في الصفّ + إشعار + سطر في السجل.
    void openUrl(url).catch((e) => {
      setUpdRow(`${t('upd_open_failed')} — ${String(e)}`, true);
      showToast(t('upd_open_failed'));
      invoke('push_log', { level: 'warn', message: `open download page failed: ${String(e)}` });
    });
  });
}


/* ── browser integration (Sprint E3: persistent checkbox) ───────────── */
/* ── Telegram bot (Sprint T1) ───────────────────────────────────────── */
interface TgStatus {
  running: boolean;
  last_error: string;
  last_activity: string;
  processed: number;
  queue: number;
  paired_id: number | null;
  pairing_code_active: boolean;
}
interface TgPairCode {
  code: string;
  expires_in_secs: number;
  fails_left: number;
  paired: boolean;
}

function wireTelegram(): void {
  const overlay = document.getElementById('tg-overlay');
  const openBtn = document.getElementById('btn-telegram');
  const badge = document.getElementById('tg-badge');
  // The panel is its own window: the settings dropdown is too narrow, and the
  // token field used to sit inside the block its own toggle kept hidden — a
  // dead end the owner hit on the first try (2026-09-11).
  if (!overlay || !openBtn) return;
  const enable = document.getElementById('setting-telegram') as HTMLInputElement | null;
  const token = document.getElementById('tg-token') as HTMLInputElement | null;
  const owner = document.getElementById('tg-owner') as HTMLInputElement | null;
  const audioOnly = document.getElementById('tg-audio-only') as HTMLInputElement | null;
  const localUrl = document.getElementById('tg-local-url') as HTMLInputElement | null;
  const apiId = document.getElementById('tg-api-id') as HTMLInputElement | null;
  const apiHash = document.getElementById('tg-api-hash') as HTMLInputElement | null;
  const codeEl = document.getElementById('tg-pair-code');
  const statusEl = document.getElementById('tg-status');
  const btnNew = document.getElementById('tg-pair-new');
  const btnCopy = document.getElementById('tg-pair-copy');

  // Seed the non-secret fields from the cache; the settings echo keeps them
  // reconciled after.
  if (owner) owner.value = localStorage.getItem('hl.tg_owner') || '';
  if (localUrl) localUrl.value = localStorage.getItem('hl.tg_local') || '';
  if (apiId) apiId.value = localStorage.getItem('hl.tg_api_id') || '';
  if (audioOnly) audioOnly.checked = localStorage.getItem('hl.tg_audio') === '1';
  if (enable) enable.checked = localStorage.getItem('hl.tg') === '1';

  // The two secrets come from the backend ONCE, into memory and the field —
  // and any copy an older build left in localStorage is deleted here.
  try {
    localStorage.removeItem('hl.tg_token');
    localStorage.removeItem('hl.tg_api_hash');
  } catch { /* storage blocked */ }
  void (async () => {
    try {
      const s = await invoke<RustSettings>('get_settings');
      if (typeof s.telegram_token === 'string' && token && !token.value) {
        token.value = s.telegram_token;
        setTelegramToken(s.telegram_token);
      }
      if (typeof s.telegram_api_hash === 'string' && apiHash && !apiHash.value) {
        apiHash.value = s.telegram_api_hash;
        setTelegramApiHash(s.telegram_api_hash);
      }
    } catch { /* dev/portable builds — backend unavailable */ }
  })();

  const bindText = (key: string, el: HTMLInputElement | null): void => {
    el?.addEventListener('input', () => {
      localStorage.setItem(key, el.value.trim());
      pushSettings();
    });
  };
  // Secrets: memory only, and the value is what the backend stores.
  token?.addEventListener('input', () => {
    setTelegramToken(token.value.trim());
    pushSettings();
  });
  apiHash?.addEventListener('input', () => {
    setTelegramApiHash(apiHash.value.trim());
    pushSettings();
  });
  bindText('hl.tg_owner', owner);
  bindText('hl.tg_local', localUrl);
  bindText('hl.tg_api_id', apiId);

  audioOnly?.addEventListener('change', () => {
    localStorage.setItem('hl.tg_audio', audioOnly.checked ? '1' : '0');
    pushSettings();
  });

  let lastCode = '';
  async function refresh(withCode: boolean): Promise<void> {
    try {
      const st = await invoke<TgStatus>('telegram_status');
      if (statusEl) {
        const bits: string[] = [st.running ? t('tg_on') : t('tg_off')];
        bits.push(st.paired_id ? `${t('tg_paired')}: ${st.paired_id}` : t('tg_pairing'));
        if (st.queue) bits.push(`⏳ ${st.queue}`);
        if (st.last_error) bits.push(`⚠ ${String(st.last_error).slice(0, 70)}`);
        statusEl.textContent = bits.join(' · ');
        statusEl.className = st.last_error
          ? 'font-label-sm text-label-sm text-error'
          : 'font-label-sm text-label-sm text-on-surface-variant';
      }
      if (badge) {
        badge.textContent = st.running ? t('tg_on') : t('tg_off');
        badge.className = st.running
          ? 'ms-auto font-label-sm text-label-sm text-tertiary'
          : 'ms-auto font-label-sm text-label-sm text-on-surface-variant';
      }
      if (!codeEl || !withCode) return;
      // Paired: the pairing instructions and the code row are noise — the
      // owner's own request (2026-09-11). The status line already says who.
      const pairRow = document.getElementById('tg-pair-row');
      const pairHint = document.getElementById('tg-pair-hint');
      pairRow?.classList.toggle('hidden', !!st.paired_id);
      pairHint?.classList.toggle('hidden', !!st.paired_id);
      if (st.paired_id) {
        codeEl.textContent = '✓';
        lastCode = '';
        return;
      }
      const pc = await invoke<TgPairCode>('telegram_pairing_code', { force: false });
      lastCode = pc.code;
      codeEl.textContent = pc.code;
    } catch { /* dev/portable builds — backend unavailable */ }
  }

  // Never a dead end: the token field is visible in this same panel, so say
  // what is missing and put the cursor in it rather than refusing the toggle
  // (the old inline layout hid the field behind the very switch it gated).
  enable?.addEventListener('change', () => {
    localStorage.setItem('hl.tg', enable.checked ? '1' : '0');
    if (enable.checked && !(token?.value || '').trim()) {
      if (statusEl) {
        statusEl.textContent = `⚠ ${t('tg_need_token')}`;
        statusEl.className = 'font-label-sm text-label-sm text-tertiary leading-relaxed';
      }
      token?.focus();
    }
    pushSettings();
    void refresh(true);
  });

  const isOpen = (): boolean => !overlay.classList.contains('hidden');
  let release: (() => void) | null = null;
  const closePanel = (): void => {
    overlay.classList.add('hidden');
    release?.();
    release = null;
  };
  openBtn.addEventListener('click', () => {
    // The settings dropdown is a narrow strip — get it out of the way.
    document.getElementById('settings-menu')?.classList.add('hidden');
    overlay.classList.remove('hidden');
    if (release === null) release = trapFocus(overlay);
    void refresh(true);
  });
  document.getElementById('tg-close')?.addEventListener('click', closePanel);
  document.getElementById('tg-ok')?.addEventListener('click', closePanel);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closePanel();
  });

  btnNew?.addEventListener('click', () => {
    void (async () => {
      try {
        const pc = await invoke<TgPairCode>('telegram_pairing_code', { force: true });
        lastCode = pc.code;
        if (codeEl) codeEl.textContent = pc.code;
      } catch { /* dev */ }
    })();
  });

  btnCopy?.addEventListener('click', () => {
    if (!lastCode) return;
    void navigator.clipboard?.writeText(lastCode).then(
      () => showToast(`✓ ${t('tg_code_copied')}`),
      () => { /* clipboard blocked — the code is on screen anyway */ },
    );
  });

  // The worker emits on exit/restart; the poll is the safety net for a pairing
  // completed in Telegram (Rust writes settings.json behind our back). It only
  // runs while the panel is actually open.
  void listen('telegram-status', () => { void refresh(true); });
  window.setInterval(() => {
    if (document.hidden || !isOpen()) return;
    void refresh(true);
  }, 5000);
  void refresh(false);
}

function wireBridge(): void {
  let bridgeCardTimer: number | undefined; // F-5: one pending hide at a time
  const cb = document.getElementById('setting-bridge') as HTMLInputElement | null;

  async function applyBridge(on: boolean): Promise<void> {
    try {
      if (on) {
        // Same backend enable path as before — both browser groups.
        const r1 = await invoke<string>('register_native_host', { browser: 'chrome' });
        const r2 = await invoke<string>('register_native_host', { browser: 'firefox' });
        showToast(`${r1}\n${r2}`);
        invoke('push_log', { level: 'info', message: `${r1} / ${r2}` });
      } else {
        const r = await invoke<string>('unregister_native_host');
        showToast(r);
        invoke('push_log', { level: 'info', message: r });
      }
      localStorage.setItem('hl.bridge', on ? '1' : '0');
      if (cb) cb.checked = on;
      pushSettings();
    } catch (e) {
      // Revert the checkbox to backend truth — never display a lie.
      try {
        const st = await invoke<{ enabled: boolean }>('bridge_status');
        if (cb) cb.checked = st.enabled;
      } catch { /* dev builds — leave as-is */ }
      showToast(`✗ ${String(e).slice(0, 120)}`);
      invoke('push_log', { level: 'error', message: `bridge toggle failed: ${e}` });
    }
  }

  cb?.addEventListener('change', () => void applyBridge(!!cb.checked));

  // Init: backend ground truth wins over any stale cache — status known at
  // a glance and reconciled into settings so it survives restarts truthfully.
  void (async () => {
    try {
      const st = await invoke<{ enabled: boolean }>('bridge_status');
      if (cb) cb.checked = st.enabled;
      if ((localStorage.getItem('hl.bridge') === '1') !== st.enabled) {
        localStorage.setItem('hl.bridge', st.enabled ? '1' : '0');
        pushSettings();
        invoke('push_log', { level: 'info', message: `bridge checkbox reconciled to ${st.enabled}` });
      }
    } catch { /* dev/portable builds — leave unchecked */ }
  })();
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
        ? `${p.name} — ${t('bridge_done_in', { secs: p.seconds?.toFixed(1) ?? '0' })}`
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

/* ── هل إضافة المتصفح موجودة؟ ─────────────────────────────────────────────
   تطبيق مكتبي لا يستطيع تعداد إضافات المتصفح، لكن مضيف Native Messaging
   يسجّل أصل كل إضافة تتصل به (كروم وفايرفوكس يمرّران الأصل كوسيط أول).
   سجلّ حديث ⇒ الإضافة موجودة؛ لا سجلّ أو سجلّ قديم ⇒ «لا نعرف»، فنعرض رابط
   صفحة الإضافة بدل أن نترك المستخدم يخمّن. لا يُستنتج الغياب من سجلّ قديم
   أبداً: إضافة أُزيلت تترك آخر اتصالها خلفها. */
type BridgeExt = { extension_seen: boolean; extension_days_ago: number | null };

function renderBridgeExt(info: BridgeExt | null): void {
  const status = document.getElementById('bridge-ext-status');
  const link = document.getElementById('bridge-ext-link');
  if (status) {
    if (!info) {
      status.textContent = '';
    } else if (info.extension_seen) {
      const d = info.extension_days_ago ?? 0;
      status.textContent = currentLang() === 'ar'
        ? (d <= 0 ? '✓ الإضافة متصلة الآن' : `✓ الإضافة متصلة — آخر اتصال قبل ${d} يوم`)
        : (d <= 0 ? '✓ Extension connected now' : `✓ Extension connected — last call ${d} day(s) ago`);
      status.className = 'font-label-sm text-label-sm text-tertiary leading-relaxed px-unit';
    } else {
      status.textContent = currentLang() === 'ar'
        ? 'لم يتصل أي متصفح بعد. إن لم تكن الإضافة مثبَّتة فثبّتها من هنا:'
        : 'No browser has called yet. If the extension is not installed, get it here:';
      status.className = 'font-label-sm text-label-sm text-on-surface-variant leading-relaxed px-unit';
    }
  }
  if (link) {
    const show = !info || !info.extension_seen;
    link.classList.toggle('hidden', !show);
    link.classList.toggle('flex', show);
  }
}

async function refreshBridgeExt(): Promise<void> {
  try {
    const r = await invoke<BridgeExt>('bridge_status');
    renderBridgeExt(r);
  } catch {
    renderBridgeExt(null);
  }
}

/* ── التشغيل مع بدء تشغيل ويندوز ───────────────────────────────────────────
   المصدر الوحيد للحقيقة هو الريجستري (لا حقل مقابل في الإعدادات)، فنقرأ
   الحالة منه بعد كل تغيير بدل أن نفترض أن الكتابة نجحت. والغرض من الخيار
   بقاء الخلفية — البوت وتكامل المتصفح — لا فتح نافذة عند الإقلاع. */
async function refreshAutostart(): Promise<void> {
  const cb = document.getElementById('setting-autostart') as HTMLInputElement | null;
  if (!cb) return;
  try {
    const r = await invoke<{ enabled: boolean }>('autostart_status');
    cb.checked = !!r.enabled;
  } catch {
    cb.checked = false;
  }
}

async function applyAutostart(on: boolean): Promise<void> {
  const cb = document.getElementById('setting-autostart') as HTMLInputElement | null;
  try {
    const r = await invoke<{ enabled: boolean }>('set_autostart', { on });
    if (cb) cb.checked = !!r.enabled; // نعكس الريجستري لا ما طلبناه
    // 1.10: an explicit user decision fulfills "ask once" — keep the mirror
    // in sync so a later unrelated push cannot resurrect the question.
    setAutostartAsked(true);
  } catch (e) {
    showToast(`${t('autostart_failed')} ${String(e)}`);
    await refreshAutostart();
  }
}

/** Release handle for the autostart dialog's focus trap; the dialog can be opened
 *  from wireAutostart's own buttons or by askAutostartOnce at startup. */
let autostartTrap: (() => void) | null = null;
function releaseAutostartTrap(): void {
  autostartTrap?.();
  autostartTrap = null;
}

function wireAutostart(): void {
  const cb = document.getElementById('setting-autostart') as HTMLInputElement | null;
  cb?.addEventListener('change', () => { void applyAutostart(!!cb.checked); });

  const overlay = document.getElementById('autostart-overlay');
  const closeAsk = async (enable: boolean | null): Promise<void> => {
    overlay?.classList.add('hidden');
    releaseAutostartTrap();
    if (enable !== null) await applyAutostart(enable);
    try {
      // set_settings reads `value` (lib.rs), not `patch` — and Settings is
      // #[serde(default)], so a partial object would reset every other field:
      // read-modify-write the full object instead (same pattern as pushSettings).
      const cur: any = await invoke('get_settings');
      await invoke('set_settings', { value: { ...cur, autostart_asked: true } });
      setAutostartAsked(true); // 1.10: the backend now holds true — mirror it.
    } catch { /* ignore */ }
  };
  document.getElementById('autostart-yes')?.addEventListener('click', () => { void closeAsk(true); });
  document.getElementById('autostart-no')?.addEventListener('click', () => { void closeAsk(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) void closeAsk(null);
  });
}

/** يُسأل مرة واحدة فقط: إن لم يُسأل بعد ولم يكن الخيار مفعّلاً. */
function askAutostartOnce(asked: boolean, alreadyOn: boolean): void {
  const overlay = document.getElementById('autostart-overlay');
  if (!overlay || asked || alreadyOn) return;
  overlay.classList.remove('hidden');
  if (autostartTrap === null) autostartTrap = trapFocus(overlay);
}

function wire(): void {
  startStallDetector();
  startLongtaskWatch();
  wireContextMenu();
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
  wireUpdateCheck();
  wireWatchSettings();
  wireBridge();
  wireAutostart();
  wireTelegram();
  wireExtJobs();
  wirePlayer();
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
    session.setAppVersion(info.version);
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
