/* ── سجل الأحداث (drawer) ────────────────────────────────────────────────
 * نُقل من src/main.ts كما هو حرفياً: كتلة السجل كاملة. ونوع `LogLine`
 * انتقل إلى src/types.ts (يحتاجه main.ts أيضاً في حدث `log-line`).
 * مصدر الحقيقة مخزن محلّي (`logBuffer`) تُغذّيه أحداث `log-line` من الخلفية
 * (Audit F-1: لا استطلاع دوري)، مع طلاء متزايد مُجمَّع في إطار واحد وحدّ
 * MAX_RENDERED_ROWS. معرّفات DOM (#log-view، #autoscroll، #logcard،
 * #log-toggle) وصيغة localStorage ('hl.log_open') لم تتغيّر.
 * الوحيد المضاف: `export` على ما يحتاجه main.ts، ومُوصِّلان (logOpenState /
 * setLogOpen) كي تبقى حالة الفتح هنا — يقرأها collectSettings في main.ts،
 * تماماً كما كان يقرأ المتغيّر نفسه.
 */
import { invoke } from '@tauri-apps/api/core';
import type { LogLine } from './types';

const view = document.getElementById('log-view') as HTMLDivElement;
const autoscroll = document.getElementById('autoscroll') as HTMLInputElement;

/* UI freeze fix: the old code repainted up to 500 rows on EVERY log event
 * (ORT emits dozens/sec during inference). Now: incremental append capped at
 * MAX_RENDERED_ROWS, coalesced to one paint per animation frame. */
const MAX_RENDERED_ROWS = 150;
let logTotal = 0; // ever-incrementing id of buffered lines
let renderedUpTo = 0; // logTotal already painted
let logFrameQueued = false;
export function logLineNode(line: LogLine): HTMLDivElement {
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

export async function refresh(): Promise<void> {
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

export function pushLogLine(line: LogLine): void {
  if (!logOpen) return;
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.splice(0, logBuffer.length - 500);
  logTotal += 1;
  scheduleLogPaint();
}

export function wireLogToggle(): void {
  const card = document.getElementById('logcard');
  const toggle = document.getElementById('log-toggle');
  const icon = toggle?.querySelector('span[data-icon="expand_less"]') as HTMLElement;
  const sync = () => {
    view.classList.toggle('hidden', !logOpen);
    card?.classList.toggle('collapsed', !logOpen);
    if (icon) {
       icon.textContent = logOpen ? 'expand_more' : 'expand_less';
    }
    // the toggle no longer wraps the autoscroll checkbox, so its expanded state
    // is announced instead of implied by nesting
    toggle?.setAttribute('aria-expanded', logOpen ? 'true' : 'false');
    if (logOpen) void refresh();
  };
  toggle?.addEventListener('click', (ev) => {
    // the autoscroll checkbox is a SIBLING of the toggle now (it used to be
    // nested inside the button — invalid HTML), so its clicks never reach here.
    if ((ev.target as HTMLElement).closest('.autoscroll')) return;
    logOpen = !logOpen;
    localStorage.setItem('hl.log_open', logOpen ? '1' : '0');
    sync();
  });
  sync();
}

/* ── حالة فتح السجل ─────────────────────────────────────────────────────── */
export function logOpenState(): boolean {
  return logOpen;
}

export function setLogOpen(next: boolean): void {
  logOpen = next;
}
