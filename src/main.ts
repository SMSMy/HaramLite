import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as dialog from '@tauri-apps/plugin-dialog';
import { applyLang, t, wireLang } from './i18n';
import { trapFocus } from './util';
import { pushLogLine, refresh, wireLogToggle } from './log';
import type { LogLine } from './types';
import { startLongtaskWatch, startStallDetector } from './diagnostics';
import { showCudaHint, updateCudaBanner } from './cuda';
import {
  notifyWatchUiChanged,
  pushSettings,
  seedSettings,
  type RustSettings,
} from './settings';
import { wireWatchSettings } from './watch';
import * as session from './session';
import { outDirOf, setVerdictHtml, verdictHtml } from './media';
import { ingestFiles, restoreBatchState, wireSeparate, wireUrlDownload } from './queue';
import { wirePlayer } from './player';
import { askAutostartOnce, refreshAutostart, refreshBridgeExt, wireAutostart, wireBridge, wireExtJobs, wireTelegram } from './integration';
import { autoHealthCheck, wireRepair } from './repair';
import { silentUpdateCheck, wireAbout, wireReport, wireUpdateCheck } from './aboutUpdate';


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
