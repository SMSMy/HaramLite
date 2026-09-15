/* ── مجلد المراقبة (Sprint D2) ─────────────────────────────────────────────
 * نُقل من src/main.ts كما هو حرفياً: wireWatchSettings() بكاملها — قراءة
 * الحالة من localStorage، واختيار المجلد عبر dialog.open، ودفع الإعدادات،
 * وأحداث الخلفية (watch-skip و watch-done)، وتسجيل خطّاف الرسم عبر
 * setRefreshWatchUi.
 * لم يتغيّر أي معرّف DOM (#setting-watch، #watch-options، #watch-path،
 * #watch-status، #watch-mode، #watch-max-size، #watch-rescan،
 * #btn-watch-folder، #btn-watch-cancel)، ولا أي مفتاح localStorage
 * (hl.watch، hl.watch_path، hl.watch_mode، hl.watch_max_mb،
 * hl.watch_rescan، hl.notify)، ولا اسم أي أمر (cancel_watch_file،
 * push_log)، ولا فلاتر نافذة الاختيار. الوحيد المضاف: export.
 */

import { listen } from '@tauri-apps/api/event';
import * as dialog from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import { pushSettings, setRefreshWatchUi } from './settings';
import { playDing, showToast } from './util';

/* ── watch folder wiring (Sprint D2) ────────────────────────────────── */
export function wireWatchSettings(): void {
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

  setRefreshWatchUi(sync);
  sync();
}
