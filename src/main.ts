import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as dialog from '@tauri-apps/plugin-dialog';
import { applyLang, t, wireLang } from './i18n';
import { pushLogLine, refresh, wireLogToggle } from './log';
import type { LogLine } from './types';
import { startLongtaskWatch, startStallDetector } from './diagnostics';
import {
  pushSettings,
  seedSettings,
} from './settings';
import { wireWatchSettings } from './watch';
import * as session from './session';
import { outDirOf, setVerdictHtml, verdictHtml } from './media';
import { ingestFiles, restoreBatchState, wireSeparate, wireStopBar, wireUrlDownload } from './queue';
import { wirePlayer } from './player';
import { wireAutostart, wireBridge, wireExtJobs, wireTelegram } from './integration';
import { autoHealthCheck, wireRepair } from './repair';
import { updateCudaBanner, refreshProviderLine } from './cuda';
import { silentUpdateCheck, wireAbout, wireReport, wireUpdateCheck } from './aboutUpdate';
import { wireSettings } from './settingsPanel';
import { wireSettingsScreen } from './settingsScreen';


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

/* ربط «الاحتفاظ بالموسيقى» (`#keep-inst`) — وهو اليوم كل ما في هذه الدالة.
 *
 * **وكان معه مسار ثانٍ** (واسم الدالة `wireSecretSettings`): عدّاد ستّ نقرات على
 * `#version-badge` يفتح لوحة «الإعدادات المتقدمة» (`#advanced-panel-container`
 * بـ`.spring-panel`) وفيها `#keep-inst` · `#fmt-select` · `#watch-max-size` ·
 * `#watch-rescan`. وعناصرها الأربعة انتقلت إلى تبويبي «الفصل والصيغة» و«المراقبة»
 * في شاشة الإعدادات، فبقي الصندوق بعنوانه بلا عنصر.
 * **فحُذف المسار كاملاً** (قرار المالك، جولة settings2): الترميز في `index.html`،
 * والعدّاد هنا، وقواعد `.spring-panel` في `src/styles.css` ⇒ **لا مسار يفتح لوحة
 * غير موجودة، ولا عدّاد نقرات على الشارة**. والشارة نفسها باقية: `init()` يعرض
 * عليها الإصدار من `ping` (`#version-badge`).
 * **وحرّاسه** في `src/__tests__/settingsTabs.test.ts` ⇒ «لا مسار ميت»: (١) كل
 * `getElementById` في هذا الملف يشير إلى معرّف موجود في `index.html` — وهو الحارس
 * الذي يمنع عودة عدّادٍ يفتح لوحة غير موجودة؛ (٢) لا عنصر للوحة في DOM.
 *
 * **وحدّ مُعلَن**: ثلاث دقائق **قائمة قبلي** في هذا الملف تشير إلى معرّفات غير
 * موجودة (`preview-toggle` · `preview-duration` · `preview-hint` — `refreshPreviewHint`
 * و`wirePreview`)، ومسجَّلة في `docs/AUDIT.md:647` («الـ`dist` خالٍ من
 * `preview-toggle` مؤكد»). **لم أحذفها**: مسار «المعاينة السريعة» ليس لوحة
 * `#advanced-panel`، وحذفه تغيير سلوك لم يُطلب. وهي معلَنة بالاسم في
 * `PRE_EXISTING_DEAD_MAIN_TS_IDS` كي لا يمرّ **مسار ميت جديد** بصمت. */
function wireKeepInstrumental(): void {
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


function wire(): void {
  startStallDetector();
  startLongtaskWatch();
  wireContextMenu();
  wireLang();
  // **وضع الشاشة قبل ربط اللوحة**: نافذة `settings` تُظهر شاشة الإعدادات وحدها،
  // والرئيسية تُبقيها مخفيّة **دائماً** (لا مسار ثانٍ للقائمة القديمة).
  wireSettingsScreen();
  wireSettings();

  window.addEventListener('error', (ev) =>
    invoke('push_log', { level: 'error', message: `JS error: ${ev.message}` }));
  window.addEventListener('unhandledrejection', (ev) =>
    invoke('push_log', { level: 'error', message: `JS unhandled rejection: ${String(ev.reason)}` }));

  wireModes();
  wireKinds();
  wireDropzone();
  wireSeparate();
  wireStopBar(); // م٢: الزرّ الثابت لوقف المهمّة المعروضة (خارج تمرير الطابور)
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
  wireKeepInstrumental();
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

  // ن-٣: «المزوّد الفعّال» في قسم الإعدادات — حقيقة آخر جلسة فصل من
  // `provider.json`، و«غير معروف» حين لم تُجرَّ جلسة بعد.
  void refreshProviderLine();

  // Audit F-1: live log lines arrive as pushed events — no polling.
  void listen<LogLine>('log-line', (ev) => pushLogLine(ev.payload));

  await refresh();
}

void init();
