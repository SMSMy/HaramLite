import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as dialog from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { applyLang, currentLang, t, wireLang } from './i18n';
import { fileBaseName, notify, playDing, sanitizePath, showToast, trapFocus } from './util';
import { logOpenState, pushLogLine, refresh, wireLogToggle } from './log';
import type { LogLine, MediaInfo, SepResult } from './types';

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

/* ── UI freeze forensics ────────────────────────────────────────────── */
// If the renderer event loop ever stalls, leave a dated trace in the backend
// log — turns future "the app froze" reports into quantified data (when and
// how long) instead of guesses. Costs one timer tick per second.
// P1 click-freeze tool: PerformanceObserver('longtask') names EVERY task
// >200ms (duration + attribution) into the backend log. A click that wedges
// the window MUST appear here on recovery (buffered) — if a black freeze
// leaves no longtask at all, the culprit is below JS (GPU/driver) and the
// escalation path is defined instead of guessed.
function startLongtaskWatch(): void {
  try {
    const W = window as unknown as {
      PerformanceObserver?: new (cb: (list: { getEntries(): unknown[] }) => void) => {
        observe(o: { type: string; buffered: boolean }): void;
      };
    };
    if (!W.PerformanceObserver) return;
    let windowStart = Date.now();
    let reported = 0;
    const obs = new W.PerformanceObserver((list) => {
      try {
        for (const raw of list.getEntries()) {
          const e = raw as { duration?: number; name?: string; attribution?: unknown };
          const dur = typeof e.duration === 'number' ? e.duration : 0;
          if (dur < 200) continue;
          const now = Date.now();
          if (now - windowStart > 30000) {
            windowStart = now;
            reported = 0;
          }
          reported += 1;
          if (reported > 20) continue; // flood cap: 20 per 30s, rest counted silently
          let attr = '';
          try {
            attr = JSON.stringify(e.attribution ?? []).slice(0, 300);
          } catch { attr = 'unserializable'; }
          const msg = `longtask ${Math.round(dur)}ms name=${String(e.name ?? '?').slice(0, 80)} attr=${attr}`;
          console.error(`[longtask] ${msg}`);
          invoke('push_log', { level: 'warn', message: msg }).catch(() => {});
        }
      } catch { /* observer must never break the app */ }
    });
    obs.observe({ type: 'longtask', buffered: true });
  } catch { /* unsupported WebView — detector pair still covers stalls */ }
}

// P1 autopsy fix — the old detector was blind BY CONSTRUCTION to the exact
// P1 autopsy fix — the old detector was blind BY CONSTRUCTION to the exact
// freeze signature we hit: a compositor/GPU stall kills rAF frames while JS
// timers keep ticking (no setInterval gap, hence the silence during a
// confirmed freeze), and background-tab throttling made the old 5s gap lie.
// This one watches BOTH signals, never reports while hidden/covered, and
// leaves evidence that does NOT depend on the (possibly wedged) backend
// channel: a visible badge + console.error + best-effort backend log.
function startStallDetector(): void {
  let lastBeat = Date.now();
  let lastFrame = Date.now();
  let bodyVisible = true;
  try {
    new IntersectionObserver((es) => {
      bodyVisible = es.some((e) => e.isIntersecting);
    }).observe(document.body);
  } catch { /* IO unavailable — assume visible */ }
  const frame = (): void => {
    lastFrame = Date.now();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  let badge: HTMLElement | null = null;
  const report = (kind: string, secs: number): void => {
    const msg = `${kind} stalled ~${secs}s`;
    console.error(`[stall-detector] ${msg}`);
    try {
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'stall-badge';
        badge.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:9999;background:#3a0d0d;color:#ffb4ab;border:1px solid #93000a;border-radius:8px;padding:6px 10px;font-size:12px;direction:ltr;';
        document.body.appendChild(badge);
      }
      badge.textContent = `⚠ ${msg}`;
      badge.style.display = '';
      window.setTimeout(() => { badge?.style.setProperty('display', 'none'); }, 10000);
    } catch { /* DOM gone — console keeps the evidence */ }
    invoke('push_log', { level: 'warn', message: `UI thread stalled ~${secs}s (${kind})` }).catch(() => {});
  };

  window.setInterval(() => {
    const now = Date.now();
    if (document.hidden) {
      // Background tab: timers lie (throttled) and rAF sleeps — say nothing.
      lastBeat = now;
      lastFrame = now;
      return;
    }
    const gap = now - lastBeat;
    lastBeat = now;
    if (gap > 5000) {
      report('UI thread', Math.round(gap / 1000));
    } else if (bodyVisible && now - lastFrame > 5000 && gap <= 1500) {
      report('Compositor/GPU (frames dead, timers alive)', Math.round((now - lastFrame) / 1000));
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
/** Telegram secrets live in memory only — never in localStorage (a second
 *  plaintext copy at rest, which also defeated sealing them in settings.json).
 *  `null` = "unknown" and tells the backend to keep what it already has. */
let tgToken: string | null = null;
let tgApiHash: string | null = null;
/** Mirror of the backend's `autostart_asked` (1.10): it lives in Rust only
 *  (no localStorage copy, like the autostart truth itself), so every
 *  unrelated pushSettings() keeps resending the known value instead of
 *  letting #[serde(default)] silently reset it to false. */
let autostartAsked = false;
let settingsSyncTimer: number | undefined;
/** Hook filled by wireWatchSettings so external settings changes can repaint. */
let refreshWatchUi: (() => void) | null = null;
function collectSettings(): RustSettings {
  return {
    lang: currentLang(),
    cuda: localStorage.getItem('hl.cuda') === '1',
    notify: localStorage.getItem('hl.notify') === '1',
    preview: localStorage.getItem('hl.preview') === '1',
    preview_seconds: Number(localStorage.getItem('hl.preview_seconds')) || 15,
    keep_instrumental: localStorage.getItem('hl.keep_inst') === '1',
    bridge_enabled: localStorage.getItem('hl.bridge') === '1',
    // Sprint T1: Telegram bot (token + pairing live in Rust settings too).
    telegram_enabled: localStorage.getItem('hl.tg') === '1',
    // Secrets are NOT kept in localStorage (a second plaintext copy at rest,
    // which also defeated sealing them in settings.json). `null` ⇒ the backend
    // keeps its stored value; the panel loads them from Rust into memory.
    telegram_token: tgToken,
    telegram_user_id: localStorage.getItem('hl.tg_owner') || '',
    telegram_audio_only: localStorage.getItem('hl.tg_audio') === '1',
    telegram_local_url: localStorage.getItem('hl.tg_local') || '',
    telegram_api_id: localStorage.getItem('hl.tg_api_id') || '',
    telegram_api_hash: tgApiHash,
    log_open: logOpenState(),
    // 1.10: the only field with no localStorage copy — the module mirror above
    // keeps unrelated pushes from resetting it to false via #[serde(default)].
    autostart_asked: autostartAsked,
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
    // 1.10: seed the autostart_asked mirror from backend truth (Rust-only field).
    if (typeof s.autostart_asked === 'boolean') autostartAsked = s.autostart_asked;
    const bools: [keyof RustSettings, string][] = [
      ['cuda', 'hl.cuda'], ['notify', 'hl.notify'], ['preview', 'hl.preview'],
      ['keep_instrumental', 'hl.keep_inst'], ['watch_enabled', 'hl.watch'],
      ['bridge_enabled', 'hl.bridge'],
      ['telegram_enabled', 'hl.tg'], ['telegram_audio_only', 'hl.tg_audio'],
    ];
    for (const [k, ls] of bools) {
      if (localStorage.getItem(ls) === null && s[k] !== undefined) {
        localStorage.setItem(ls, s[k] ? '1' : '0');
      }
    }
    const strs: [keyof RustSettings, string][] = [
      ['watch_mode', 'hl.watch_mode'], ['lang', 'hl.lang'],
      ['telegram_user_id', 'hl.tg_owner'],
      ['telegram_local_url', 'hl.tg_local'], ['telegram_api_id', 'hl.tg_api_id'],
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

/** The «نوع الإخراج: فيديو» verdict line. Markup is static and trusted (never
 *  interpolates backend data); both the label and the value span carry a
 *  data-i18n key so applyLang keeps them translated after a later rebuild. */
function verdictHtml(outKind: 'audio' | 'video'): string {
  const key = outKind === 'video' ? 'out_video' : 'out_audio';
  // text-primary-fixed-dim (#ffb59d) instead of text-clay-accent: the clay
  // chip background lifts the panel, and clay-on-clay only reached 4.17:1
  // (this token is 7.62:1) — measured, see the audit in the report.
  return `<span data-i18n="out_type_label">${t('out_type_label')}</span> <span class="bg-clay-accent/20 text-primary-fixed-dim px-1.5 py-0.5 rounded font-bold mr-1 inline-block" data-i18n="${key}">${t(key)}</span>`;
}

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
    if (info.audio_disguised_as_video) flags.push('⚠ ' + t('probe_flag_disguised'));
    if (info.video_is_cover_art) flags.push('ℹ ' + t('probe_flag_cover'));

    // Auto-switch UI based on media type
    if (info.has_video && !info.video_is_cover_art) {
        document.getElementById('kind-video')?.click();
    } else {
        document.getElementById('kind-audio')?.click();
    }

    const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
    const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'video';
    setVerdictHtml(v!, verdictHtml(outKind), false);

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
  setVerdictHtml(probeEl(), verdictHtml(outKind), false);
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
      o.textContent = idx === 0 ? t('quality_same', { h }) : `${h}p`;
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
  el.textContent = `${t('batch_label')} ${done}/${total}`;
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
      statusSpan.textContent = t('queue_pending');
      
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
  showToast(t('batch_restored', {
    count: files.length,
    skipped: skipped ? t('batch_restored_skipped', { skipped }) : '',
  }));
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
          statusSpan.textContent = t('queue_processing');
          // full-strength clay, no opacity: clay at 70% on this running row
          // measured 3.48:1; full strength is 5.87:1 (AA needs 4.5:1 at 12px)
          statusSpan.className = 'status-text font-label-sm text-label-sm text-clay-accent animate-pulse relative z-10 flex-1';
      }
      if (actionsDiv) {
          actionsDiv.innerHTML = `<button class="text-error hover:text-red-400 p-1" title="${t('cancel_processing')}"><span class="material-symbols-outlined text-sm" data-icon="cancel">cancel</span></button>`;
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
          statusSpan.textContent = previewEnabled ? t('sep_done_preview') : t('sep_done_short');
          statusSpan.className = 'status-text font-label-sm text-label-sm text-tertiary relative z-10 flex-1';
      }
      if (actionsDiv && resultPath) {
          const folderPath = outDirOf(resultPath);
          actionsDiv.innerHTML = `
            <button class="btn-play text-tertiary hover:text-green-300 p-1 bg-surface-container rounded" title="${t('open_file')}">
              <span class="material-symbols-outlined text-sm" data-icon="play_arrow">play_arrow</span>
            </button>
            <button class="btn-folder text-tertiary hover:text-green-300 p-1 bg-surface-container rounded" title="${t('open_folder')}">
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
          statusSpan.textContent = t('sep_failed_short');
          statusSpan.className = 'status-text font-label-sm text-label-sm text-error relative z-10 flex-1';
      }
      // Functional gap: a transient failure used to be a dead end — offer
      // a per-item retry instead of forcing a manual queue rebuild.
      if (actionsDiv) {
          actionsDiv.innerHTML = `<button class="text-tertiary hover:text-green-300 p-1 bg-surface-container rounded" title="${t('retry')}"><span class="material-symbols-outlined text-sm" data-icon="refresh">refresh</span></button>`;
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
    name.textContent = STAGE_NAMES[lastStage.stage]?.[currentLang()] ?? lastStage.stage;
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
        setVerdict(probeEl(), t('sep_need_file'), true);
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
    sepBtnEl().textContent = t('toggle_pause');
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
        ? `${t('batch_done')} ${total - failures.length}/${total}\n${t('batch_failed_list')}\n${failures.join('\n')}`
        : `${t('batch_done')} ${total}/${total} ✓`;
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
  btn.textContent = t('toggle_cancel');
  result.classList.add('hidden');
  markBatchItem(path, 'run');
  try {
    const res = await runSeparationFor(path, keepInst, o);
    const lines = [t('sep_done_secs', { secs: res.seconds.toFixed(1) })];
    if (res.vocals) lines.push(`${t('sep_out_audio')} ${res.vocals}`);
    if (res.instrumental) lines.push(`${t('sep_out_music')} ${res.instrumental}`);
    if (res.video) lines.push(`${t('sep_out_video')} ${res.video}`);
    result.textContent = lines.join('\n');
    result.classList.remove('hidden');
    const resultPath = res.video || res.vocals || res.instrumental || undefined;
    markBatchItem(path, 'ok', resultPath);
    void notify(t('notify_done'), fileBaseName(path));
  } catch (e) {
    const msg = String(e);
    result.textContent = msg.includes('إلغاء') ? t('sep_cancelled') : `${t('sep_failed')} ${e}`;
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
      res.textContent = `${t('dl_done')} ${file}`;
      res.classList.remove('hidden');
      await ingestFiles([file]); // auto-fill + probe the downloaded file
    } catch (e) {
      res.textContent = `${t('dl_failed')} ${e}`;
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
      <span id="about-version" class="bg-clay-accent/20 text-clay-accent px-1.5 py-0.5 rounded font-bold">v${appVersion || '—'}</span>
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

/* ── live player surface (v1 songs scope) ─────────────────────────── */
// DECISION 2026-09-06 (D1 — hide, never delete): the field verdict is that
// the file pipeline is fast enough (14.5 min in 91s) and the watch path is
// excellent — the live need dropped. The card is hidden behind this flag;
// backend (livemap/decide/player/session/player_prepare), tests and strings
// stay green untouched. Fully reversible: set PL_CARD_VISIBLE = true.
const PL_CARD_VISIBLE = false;
function applyPlCardVisibility(): void {
  if (!PL_CARD_VISIBLE) {
    document.getElementById('pl-container')?.classList.add('hidden');
  }
}
// Session state + REAL precomputed maps (player_prepare) + audio output
// through the map (mute 0 / duck −12 dB / pass 1, 50ms anti-click ramps).
// The surface plays the user's own file only — no live-extension path,
// no system-WASAPI path (both closed until further notice).
type PlChunkMap = {
  index: number;
  start_sec: number;
  len_sec: number;
  muted_ranges_sec: [number, number][];
  ducked_ranges_sec: [number, number][];
  timing_ms: number;
};
let plSession: number | null = null;
let plDuration = 0;
let plMap: PlChunkMap[] = [];
let plSelected: number | null = null;
let plLastStates: string[] = [];
let plLastChunk: number | null = null;
function plFmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}
function plStateLabel(s: string): string {
  const k = s.toLowerCase();
  if (k === 'ready') return t('pl_ready');
  if (k === 'consumed') return t('pl_consumed');
  return t('pl_pending');
}
/** One time range, bidi-isolated: digits+colon must not reorder inside RTL. */
function plBdiRange(parent: HTMLElement, a: number, b: number): void {
  const el = document.createElement('bdi');
  el.dir = 'ltr';
  el.textContent = `${plFmt(a)}–${plFmt(b)}`;
  parent.appendChild(el);
}
function plAppendRanges(parent: HTMLElement, ranges: [number, number][]): void {
  if (!ranges.length) {
    parent.appendChild(document.createTextNode(t('pl_none')));
    return;
  }
  const sep = currentLang() === 'ar' ? '، ' : ', ';
  ranges.forEach(([a, b], i) => {
    if (i > 0) parent.appendChild(document.createTextNode(sep));
    plBdiRange(parent, a, b);
  });
}
/** Mute/duck range containing pos, mute wins on overlap. */
function plRangeAt(pos: number): { kind: 'mute' | 'duck'; range: [number, number] } | null {
  for (const c of plMap) {
    for (const r of c.muted_ranges_sec) {
      if (pos >= r[0] && pos < r[1]) return { kind: 'mute', range: r };
    }
  }
  for (const c of plMap) {
    for (const r of c.ducked_ranges_sec) {
      if (pos >= r[0] && pos < r[1]) return { kind: 'duck', range: r };
    }
  }
  return null;
}
function plCurPos(): number {
  const seekEl = document.getElementById('pl-seek') as HTMLInputElement | null;
  if (!seekEl || plDuration <= 0) return 0;
  return (Number(seekEl.value) / 100) * plDuration;
}
function paintPills(): void {
  const wrap = document.getElementById('pl-chunks');
  if (!wrap) return;
  wrap.replaceChildren(...plLastStates.map((s, i) => {
    const k = s.toLowerCase();
    const base = 'w-7 h-7 flex items-center justify-center rounded border text-xs font-bold cursor-pointer transition-all apple-ease hover:scale-110 active:scale-95 ';
    const stateCls = k === 'ready'
      ? 'bg-clay-accent/20 text-clay-accent border-clay-accent/40'
      : (k === 'consumed' ? 'opacity-40 text-on-surface-variant border-border-muted' : 'text-on-surface-variant border-border-muted');
    const selCls = i === plSelected ? ' ring-2 ring-[#da7756] scale-110' : '';
    const curCls = i === plLastChunk ? ' underline underline-offset-2' : '';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(i + 1);
    b.title = `${t('pl_chunk')} ${i + 1} — ${plStateLabel(s)}`;
    b.setAttribute('aria-pressed', i === plSelected ? 'true' : 'false');
    b.className = base + stateCls + selCls + curCls;
    b.addEventListener('click', () => {
      plSelected = i;
      paintPills();
      paintDetail();
    });
    return b;
  }));
}
function paintDetail(): void {
  const el = document.getElementById('pl-detail');
  if (!el) return;
  el.replaceChildren();
  if (plSelected === null) {
    el.textContent = plLastStates.length ? t('pl_detail_pick') : '';
    return;
  }
  const idx = plSelected;
  const state = plLastStates[idx] !== undefined ? plStateLabel(plLastStates[idx]) : t('pl_none');
  const m = plMap[idx];
  el.append(
    `${t('pl_detail_title')} ${t('pl_chunk')} ${idx + 1} · ${t('pl_state')}: ${state} · ${t('pl_mute_ranges')}: `,
  );
  plAppendRanges(el, m ? m.muted_ranges_sec : []);
  el.append(` · ${t('pl_duck_ranges')}: `);
  plAppendRanges(el, m ? m.ducked_ranges_sec : []);
  const cost = document.createElement('bdi');
  cost.dir = 'ltr';
  cost.textContent = m ? `${m.timing_ms.toFixed(1)}ms` : t('pl_none');
  el.append(` · ${t('pl_cost')}: `, cost);
}
function paintCur(pos: number): void {
  const el = document.getElementById('pl-cur');
  if (!el) return;
  if (plDuration <= 0 || plLastChunk === null) {
    el.textContent = plDuration > 0 ? plFmt(pos) : '';
    return;
  }
  const hit = plRangeAt(pos);
  const label = hit === null
    ? t('pl_in_pass')
    : (hit.kind === 'mute'
      ? `${t('pl_in_mute')} ${plFmt(hit.range[0])}–${plFmt(hit.range[1])}`
      : `${t('pl_in_duck')} ${plFmt(hit.range[0])}–${plFmt(hit.range[1])}`);
  el.textContent = `${t('pl_chunk')} ${plLastChunk + 1} · ${plFmt(pos)} · ${label}`;
}
function paintTicks(): void {
  const box = document.getElementById('pl-ticks');
  if (!box) return;
  box.replaceChildren();
  if (plDuration <= 0 || !plMap.length) return;
  const total = plDuration;
  const add = (a: number, b: number, color: string, title: string): void => {
    if (!(b > a) || a >= total || b <= 0) return;
    const left = Math.max(0, (a / total) * 100);
    const width = Math.max(0.6, ((Math.min(b, total) - Math.max(a, 0)) / total) * 100);
    const d = document.createElement('div');
    d.className = 'absolute top-0 h-full rounded';
    d.style.left = `${left}%`;
    d.style.width = `${width}%`;
    d.style.background = color;
    d.title = title;
    box.appendChild(d);
  };
  for (const c of plMap) {
    for (const [a, b] of c.ducked_ranges_sec) add(a, b, 'rgba(255,193,7,0.55)', t('pl_in_duck'));
  }
  for (const c of plMap) {
    for (const [a, b] of c.muted_ranges_sec) add(a, b, 'rgba(224,49,49,0.8)', t('pl_in_mute'));
  }
}

/* ── live audio output (v1 songs scope, end-to-end slice) ─────────────── */
// The user's own file plays through the precomputed map: mute → 0,
// duck → −12 dB (≈0.251), pass → 1, with fast ramps (no clicks).
// Positions past the mapped end freeze silent — never raw unfiltered audio.
const PL_DUCK_GAIN = 0.251;
const PL_RAMP_SECS = 0.015;
const PL_UI_SYNC_MS = 250;
let plAudio: HTMLAudioElement | null = null;
let plCtx: AudioContext | null = null;
let plGain: GainNode | null = null;
let plAudioSrc = '';
let plPlaying = false;
let plRaf = 0;
let plLastGain = -1;
let plLastUiSync = 0;
function plMappedEnd(): number {
  const last = plMap[plMap.length - 1];
  return last ? last.start_sec + last.len_sec : 0;
}
/** Output gain at pos. Mute wins on overlap; past the map → 0 (freeze). */
function plGainAt(pos: number): number {
  if (plMappedEnd() <= 0 || pos < 0 || pos >= plMappedEnd()) return 0;
  const hit = plRangeAt(pos);
  if (hit === null) return 1;
  return hit.kind === 'mute' ? 0 : PL_DUCK_GAIN;
}
function plPlayLabel(): void {
  const btn = document.getElementById('pl-play') as HTMLButtonElement | null;
  if (btn) btn.textContent = plPlaying ? t('pl_pause') : t('pl_play');
}
function plStopLoop(): void {
  if (plRaf) cancelAnimationFrame(plRaf);
  plRaf = 0;
}
function plStopAudio(): void {
  plStopLoop();
  try {
    plAudio?.pause();
  } catch { /* already stopped */ }
  if (plPlaying) {
    plPlaying = false;
    plPlayLabel();
  }
  plLastGain = -1;
}
function plSyncSlider(pos: number): void {
  const seekEl = document.getElementById('pl-seek') as HTMLInputElement | null;
  if (seekEl && plDuration > 0 && document.activeElement !== seekEl) {
    seekEl.value = String((pos / plDuration) * 100);
  }
  const sel = document.getElementById('pl-pos');
  if (sel) sel.textContent = plFmt(pos);
  paintCur(pos);
}
function plTick(): void {
  plRaf = 0;
  if (!plPlaying || !plAudio || !plCtx || !plGain) return;
  const pos = plAudio.currentTime;
  const g = plGainAt(pos);
  if (g !== plLastGain) {
    plLastGain = g;
    plGain.gain.setTargetAtTime(g, plCtx.currentTime, PL_RAMP_SECS);
  }
  plSyncSlider(pos);
  const now = performance.now();
  if (now - plLastUiSync >= PL_UI_SYNC_MS) {
    plLastUiSync = now;
    void renderPlayer(pos);
    if (plSession !== null) {
      invoke<unknown>('player_advance', { id: plSession, pos }).catch(() => {});
    }
  }
  if (pos >= plMappedEnd()) {
    // Map exhausted → freeze silent at the edge, never raw audio.
    plStopAudio();
    void renderPlayer(Math.min(pos, plMappedEnd()));
    return;
  }
  plRaf = requestAnimationFrame(plTick);
}
async function plTogglePlay(plPath: string): Promise<void> {
  const mapEl = document.getElementById('pl-map');
  if (plPlaying) {
    plStopAudio();
    if (plAudio) void renderPlayer(plAudio.currentTime);
    return;
  }
  if (!plPath || plSession === null || plMap.length === 0 || plDuration <= 0) {
    if (mapEl) {
      mapEl.textContent = t('pl_nomap');
      mapEl.classList.remove('hidden');
    }
    return;
  }
  try {
    if (!plAudio) {
      plAudio = new Audio();
      plAudio.preload = 'auto';
      plAudio.addEventListener('ended', () => {
        plStopAudio();
        plSyncSlider(plMappedEnd());
        void renderPlayer(plMappedEnd());
      });
      plAudio.addEventListener('error', () => {
        plStopAudio();
        if (mapEl) {
          mapEl.textContent = `✗ ${t('pl_audio_err')}`;
          mapEl.classList.remove('hidden');
        }
        invoke('push_log', { level: 'error', message: 'player audio element error' });
      });
    }
    if (!plCtx || !plGain) {
      plCtx = new AudioContext();
      const src = plCtx.createMediaElementSource(plAudio);
      plGain = plCtx.createGain();
      plGain.gain.value = 0;
      src.connect(plGain).connect(plCtx.destination);
    }
    if (plCtx.state === 'suspended') await plCtx.resume();
    const wantSrc = convertFileSrc(plPath);
    if (plAudioSrc !== wantSrc) {
      plAudioSrc = wantSrc;
      plAudio.src = wantSrc;
    }
    const start = Math.min(Math.max(plCurPos(), 0), Math.max(plMappedEnd() - 0.05, 0));
    plAudio.currentTime = start;
    plLastGain = -1;
    plLastUiSync = 0;
    await plAudio.play();
    plPlaying = true;
    plPlayLabel();
    plRaf = requestAnimationFrame(plTick);
    invoke('push_log', { level: 'info', message: `player play from ${start.toFixed(1)}s` });
  } catch (e) {
    plStopAudio();
    if (mapEl) {
      mapEl.textContent = `✗ ${t('pl_audio_err')}`;
      mapEl.classList.remove('hidden');
    }
    invoke('push_log', { level: 'error', message: `player play failed: ${e}` });
  }
}
async function renderPlayer(pos: number): Promise<void> {
  if (plSession === null || plDuration <= 0) return;
  try {
    const st = await invoke<{
      chunks: number; chunk: number | null; states: string[];
      can_start: boolean; frozen: boolean; next_needed: number | null;
    }>('player_status', { id: plSession, pos });
    plLastStates = st.states;
    plLastChunk = st.chunk;
    if (plSelected !== null && plSelected >= plLastStates.length) plSelected = null;
    paintPills();
    paintDetail();
    paintCur(pos);
    const sel = document.getElementById('pl-pos');
    if (sel) sel.textContent = plFmt(pos);
    const line = document.getElementById('pl-status');
    if (line) {
      line.textContent = st.frozen
        ? `⏸ ${t('pl_frozen')}`
        : `${st.chunks} ${t('pl_chunks')} · ${t('pl_ready')}: ${st.states.filter((s) => s.toLowerCase() === 'ready').length} · ${t('pl_ready_inspect')}`;
    }
  } catch (e) {
    invoke('push_log', { level: 'error', message: `player status failed: ${e}` });
  }
}
function wirePlayer(): void {
  applyPlCardVisibility(); // D1: card hidden behind PL_CARD_VISIBLE, wiring intact
  let plPath = '';
  const fileBtn = document.getElementById('pl-file-btn');
  const prepBtn = document.getElementById('pl-prepare') as HTMLButtonElement | null;
  const playBtn = document.getElementById('pl-play') as HTMLButtonElement | null;
  const nameEl = document.getElementById('pl-file-name');
  const mapEl = document.getElementById('pl-map');
  const seekEl = document.getElementById('pl-seek') as HTMLInputElement | null;

  fileBtn?.addEventListener('click', async () => {
    const picked = await dialog.open({
      multiple: false,
      filters: [
        { name: 'Media', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'] },
      ],
    });
    if (!picked || Array.isArray(picked)) return;
    try {
      const info = await invoke<MediaInfo>('probe_media', { path: picked });
      if (!info.has_audio) return;
      plStopAudio();
      if (plSession !== null) await invoke('player_close', { id: plSession }).catch(() => {});
      plSession = await invoke<number>('player_open', { totalSecs: info.duration_secs, chunkSecs: 60 });
      plPath = picked;
      plDuration = info.duration_secs;
      plMap = [];
      plSelected = null;
      plLastStates = [];
      plLastChunk = null;
      if (playBtn) playBtn.disabled = true;
      plPlayLabel();
      if (nameEl) nameEl.textContent = picked.split(/[\\/]/).pop() ?? picked;
      if (mapEl) mapEl.classList.add('hidden');
      if (seekEl) { seekEl.value = '0'; }
      paintTicks();
      paintDetail();
      paintCur(0);
      await renderPlayer(0);
      invoke('push_log', { level: 'info', message: `player session ${plSession} opened (${plDuration.toFixed(0)}s)` });
    } catch (e) {
      invoke('push_log', { level: 'error', message: `player open failed: ${e}` });
    }
  });

  prepBtn?.addEventListener('click', async () => {
    if (!plPath || plSession === null || !prepBtn || !mapEl) {
      if (mapEl) {
        mapEl.textContent = t('pl_nomap');
        mapEl.classList.remove('hidden');
      }
      return;
    }
    plStopAudio();
    prepBtn.disabled = true;
    mapEl.textContent = t('pl_preparing');
    mapEl.classList.remove('hidden');
    try {
      const rep = await invoke<{
        total_secs: number; chunks: PlChunkMap[];
        muted_fraction: number; ducked_fraction: number; minute_cost_ms: number;
        marked_ready: number;
      }>('player_prepare', { id: plSession, path: plPath, chunkSecs: 60 });
      plMap = rep.chunks;
      if (rep.total_secs > 0) plDuration = rep.total_secs;
      plSelected = null;
      paintTicks();
      if (playBtn) playBtn.disabled = false;
      const muted = rep.chunks.reduce((n, c) => n + c.muted_ranges_sec.length, 0);
      mapEl.textContent =
        `${rep.chunks.length} ${t('pl_chunks')} · ${muted} ${t('pl_muted')} · ${(rep.minute_cost_ms).toFixed(1)}ms/min`;
      mapEl.classList.remove('hidden');
      // Backend marked every chunk Ready — re-read status so the line stops
      // showing the stale freeze and reports readiness truthfully.
      await renderPlayer(plCurPos());
      invoke('push_log', { level: 'info', message: `player map ready: ${muted} muted ranges, ${rep.marked_ready} ready` });
    } catch (e) {
      mapEl.textContent = `✗ ${e}`;
      mapEl.classList.remove('hidden');
    } finally {
      prepBtn.disabled = false;
    }
  });

  seekEl?.addEventListener('input', () => {
    if (plDuration <= 0) return;
    const pos = (Number(seekEl.value) / 100) * plDuration;
    if (plPlaying && plAudio) {
      plAudio.currentTime = Math.min(pos, Math.max(plMappedEnd() - 0.05, 0));
      plLastGain = -1;
    }
    void renderPlayer(pos);
    if (plSession !== null) {
      invoke<unknown>('player_seek', { id: plSession, pos }).catch(console.error);
    }
  });

  playBtn?.addEventListener('click', () => void plTogglePlay(plPath));
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
        tgToken = s.telegram_token;
      }
      if (typeof s.telegram_api_hash === 'string' && apiHash && !apiHash.value) {
        apiHash.value = s.telegram_api_hash;
        tgApiHash = s.telegram_api_hash;
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
    tgToken = token.value.trim();
    pushSettings();
  });
  apiHash?.addEventListener('input', () => {
    tgApiHash = apiHash.value.trim();
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
    autostartAsked = true;
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
      autostartAsked = true; // 1.10: the backend now holds true — mirror it.
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
