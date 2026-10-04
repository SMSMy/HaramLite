/* ── بطاقات الوضع (song/clip) وتسمية زرّ الفصل ────────────────────────────
 * نُقلت `wireModes` من `src/main.ts` كما هي حرفياً (م٠ · خطة 0.3.0، بند د2)
 * كي يقيس اختبار دائم سلوكها: `queue.ts` يعيد بناء زرّ الفصل بـ`innerHTML`
 * بعد كل دفعة فيولّد عقدة `#sep-label` جديدة، والعقدة الملتقَطة عند الربط
 * تموت — فالتسمية تتجمد على ما قبل الدفعة الأولى حتى إعادة التحميل.
 */
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import * as session from './session';

export function wireModes(): void {
  const cards = document.querySelectorAll<HTMLElement>('.mode-card');
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      session.setCurrentMode((card.dataset.mode as 'song' | 'clip') ?? 'song');
      cards.forEach((c) => c.classList.toggle('selected', c === card));
      // د2: الاستعلام **داخل المعالج** — `queue.ts` يعيد بناء زرّ الفصل بـ
      // `innerHTML` بعد كل دفعة فيولّد عقدة `#sep-label` جديدة، والتقاطها
      // عند الربط يحدّث عقدة ميتة ويجمد التسمية.
      const sepLabel = document.getElementById('sep-label');
      if (sepLabel) {
        const key = session.getCurrentMode() === 'song' ? 'btn_sep_song' : 'btn_sep_clip';
        sepLabel.dataset.i18n = key;
        sepLabel.innerHTML = t(key);
      }
      invoke('push_log', { level: 'info', message: `mode → ${session.getCurrentMode()}` });
    });
  });
}
