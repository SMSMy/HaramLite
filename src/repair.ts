/* ── معالج المكوّنات الناقصة (Sprint C1) ───────────────────────────────────
 * نُقل من src/main.ts كما هو حرفياً: HealthRow وfetchHealth() و
 * renderRepairList() وrepairOne() وrepairAll() وحالة repairRelease ومُحرِّره
 * showRepairDialog()/hideRepairDialog() وwireRepair() وautoHealthCheck().
 * لم يتغيّر أي معرّف DOM (‎#repair-*‎ و#health-*) ولا أي أمر (`health_check`،
 * `repair_component`، `open_folder`، `push_log`) ولا أي مفتاح ترجمة
 * (repair_title/desc/all/later/one/done/all_ok) ولا حصر التركيز (trapFocus)
 * في نافذة الإصلاح. الوحيد المضاف: `export` على ما تناديه main.ts
 * (wireRepair، autoHealthCheck) وعلى ما يناديه المُحرِّر نفسه.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { errText, t } from './i18n';
import { notify, showToast, trapFocus } from './util';

/* ── repair wizard (Sprint C1) ──────────────────────────────────────── */
type HealthRow = { key: string; label: string; ok: boolean; path: string | null };

export async function fetchHealth(): Promise<HealthRow[]> {
  try {
    const r = await invoke<HealthRow[]>('health_check_cmd');
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

export async function renderRepairList(): Promise<HealthRow[]> {
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

export async function repairOne(key: string): Promise<void> {
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
      res.textContent = `✗ ${errText(e).slice(0, 200)}`;
      res.className = 'font-body-sm text-sm text-error';
      res.classList.remove('hidden');
    }
    invoke('push_log', { level: 'error', message: `repair failed: ${e}` });
  } finally {
    if (bar) bar.style.inlineSize = '100%';
    window.setTimeout(() => wrap?.classList.add('hidden'), 800);
  }
}

export async function repairAll(): Promise<void> {
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
export function showRepairDialog(): void {
  const overlay = document.getElementById('repair-overlay');
  overlay?.classList.remove('hidden');
  if (overlay && repairRelease === null) repairRelease = trapFocus(overlay);
}
export function hideRepairDialog(): void {
  document.getElementById('repair-overlay')?.classList.add('hidden');
  repairRelease?.();
  repairRelease = null;
}

export function wireRepair(): void {
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
export async function autoHealthCheck(): Promise<void> {
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
