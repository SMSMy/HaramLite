/* ── تشريح تجمّد الواجهة (UI freeze forensics) ────────────────────────────
 * نُقل من src/main.ts كما هو حرفياً (بدءاً من تعليق "UI freeze forensics"):
 *   - startLongtaskWatch(): PerformanceObserver('longtask') — كل مهمة > 200ms
 *     تُسمّى في سجل الخلفية عبر `push_log` (بحدّ إغراق 20 لكل 30 ثانية).
 *   - startStallDetector(): يراقب إشارتَي التجمّد (نبضة المؤقّت + إطارات rAF)،
 *     ولا يبلّغ أبداً والنافذة مخفية/مغطّاة، ويترك أثراً لا يعتمد على قناة
 *     الخلفية: شارة #stall-badge مرئية + console.error + محاولة تسجيل.
 * لم يتغيّر أي مؤقّت (1000ms)، ولا عتبة (5000ms / 200ms)، ولا معرّف #stall-badge،
 * ولا نصّ أي رسالة. الوحيد المضاف: `export`.
 */
import { invoke } from '@tauri-apps/api/core';

/* ── UI freeze forensics ────────────────────────────────────────────── */
// If the renderer event loop ever stalls, leave a dated trace in the backend
// log — turns future "the app froze" reports into quantified data (when and
// how long) instead of guesses. Costs one timer tick per second.
// P1 click-freeze tool: PerformanceObserver('longtask') names EVERY task
// >200ms (duration + attribution) into the backend log. A click that wedges
// the window MUST appear here on recovery (buffered) — if a black freeze
// leaves no longtask at all, the culprit is below JS (GPU/driver) and the
// escalation path is defined instead of guessed.
export function startLongtaskWatch(): void {
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
export function startStallDetector(): void {
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
