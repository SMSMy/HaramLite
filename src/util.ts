/* ── أدوات مشتركة: حصر التركيز، تنقية المسار، الإشعارات ──────────────────
 * نُقلت من src/main.ts كما هي حرفياً (لا تغيير في أي سطر منطقي):
 *   - trapFocus()    (WCAG 2.4.3 / 2.1.2)   — كان في main.ts 29–61
 *   - sanitizePath() (B1/B2 root cause)     — كان في main.ts 62–71
 *   - showToast/playDing/notify/fileBaseName — كان في main.ts 192–226
 * الوحيد المضاف: `export` وبيانات الاستيراد أعلاه.
 */
import { invoke } from '@tauri-apps/api/core';
import dingUrl from './assets/ding.wav';

/* ── modal focus containment (WCAG 2.4.3 / 2.1.2) ──────────────────────
 * The dialogs were reachable but focus could walk out of them with Tab, and
 * «حول»/«الإصلاح» could not be dismissed from the keyboard at all. */
export function trapFocus(overlay: HTMLElement): () => void {
  const prev = document.activeElement as HTMLElement | null;
  const list = (): HTMLElement[] => Array.from(
    overlay.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.classList.contains('hidden') && el.getBoundingClientRect().width + el.getBoundingClientRect().height > 0);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Tab') return;
    const items = list();
    if (!items.length) { ev.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (ev.shiftKey && (active === first || !overlay.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (active === last || !overlay.contains(active))) {
      ev.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  const first = list()[0];
  if (first) first.focus();
  return () => {
    document.removeEventListener('keydown', onKey, true);
    if (prev && document.contains(prev)) prev.focus();
  };
}

/* ── path sanitization (B1/B2 root cause) ─────────────────────────── */
export function sanitizePath(raw: string): string {
  let p = raw.trim();
  // strip ONE pair of surrounding quotes (Explorer "copy as path")
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).trim();
  }
  return p;
}
/* ── notifications (Sprint B2) ──────────────────────────────────────── */
let toastTimer: number | undefined;
export function showToast(msg: string): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), 5000);
}
// F-7: one reusable Audio element — avoid leaking a new object per ding.
const ding = new Audio(dingUrl);
export function playDing(): void {
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
export async function notify(title: string, body: string): Promise<void> {
  if (localStorage.getItem('hl.notify') !== '1') return;
  playDing();
  try {
    await invoke('notify_done', { title, body });
  } catch {
    showToast(`${title} — ${body}`);
  }
}
export function fileBaseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
