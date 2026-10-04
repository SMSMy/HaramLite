/* ── د2 · تسمية زرّ الفصل حيّة بعد إعادة البناء ───────────────────────────
 *
 * **العلّة المقيسة** (بلاغ د2 على `8b2295a`): `wireModes` كانت تلتقط
 * `#sep-label` مرة واحدة عند الربط، بينما `queue.ts:994-997` يعيد بناء زرّ
 * الفصل بـ`innerHTML` بعد كل دفعة ⇒ عقدة جديدة، والعقدة الملتقَطة ميتة ⇒
 * بعد أول دفعة يحدّث تبديل الوضع عقدةً يتيمة وتبقى التسمية المعروضة مجمّدة
 * حتى إعادة التحميل.
 *
 * **ما يقيسه**: نقر بطاقة وضع ⇒ التسمية تتغير؛ ثم **إعادة بناء الزرّ بنفس
 * ما يبنيه `queue.ts`** (سلسلة `innerHTML` نفسها، بمفتاح قديم متعمَّد)؛ ثم
 * نقر الوضع الأخرى ⇒ **عقدة `#sep-label` الجديدة** هي التي يجب أن تتغير.
 * قبل الإصلاح يُحدَّث اليتيم وحده فتسقط الحالة الثالثة.
 *
 * **ما لا يقيسه (بصراحة)**: تشغيل دفعة فصل حقيقية (نموذج/ملفات) — إعادة
 * البناء هنا مطبوعة من سلسلة `queue.ts` نفسها؛ ولا يقيس الرسم.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));

import { i18n, t } from '../i18n';
import { wireModes } from '../modes';

const songCard = (): HTMLElement => document.querySelector<HTMLElement>('.mode-card[data-mode="song"]')!;
const clipCard = (): HTMLElement => document.querySelector<HTMLElement>('.mode-card[data-mode="clip"]')!;
const label = (): HTMLElement => document.getElementById('sep-label')!;

/** نفس سلسلة إعادة البناء التي يكتبها `queue.ts` نهاية كل دفعة (وقيمة
 *  المفتاح متعمَّدة على ما كان قبل النقر — هذه هي «التسمية المجمّدة»). */
function rebuildSepButtonLikeQueueDoes(key: 'btn_sep_song' | 'btn_sep_clip'): void {
  document.getElementById('btn-separate')!.innerHTML =
    `<span class="material-symbols-outlined transition-transform duration-300 apple-ease group-hover:rotate-12 group-hover:scale-110" data-icon="content_cut">content_cut</span>
     <span id="sep-label" data-i18n="${key}">${t(key)}</span>`;
}

describe('د2 · تبديل الوضع يحدّث #sep-label الحيّة لا العقدة الميتة', () => {
  beforeEach(() => {
    h.invoke.mockClear();
    document.body.innerHTML = `
      <button class="mode-card" data-mode="song">song</button>
      <button class="mode-card" data-mode="clip">clip</button>
      <button id="btn-separate">
        <span id="sep-label" data-i18n="btn_sep_song">${i18n.ar.btn_sep_song}</span>
      </button>`;
    wireModes();
  });

  it('قبل أي دفعة: النقر يبدّل التسمية والعقدة المختارة', () => {
    clipCard().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(label().dataset.i18n).toBe('btn_sep_clip');
    expect(label().innerHTML).toBe(i18n.ar.btn_sep_clip);
    songCard().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(label().dataset.i18n).toBe('btn_sep_song');
  });

  it('وبعد إعادة بناء الزرّ كما تفعل الدفعة: العقدة الجديدة هي التي تتغير', () => {
    clipCard().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(label().dataset.i18n).toBe('btn_sep_clip');
    // نهاية «الدفعة»: عقدة جديدة تُبنى والمفتاح المطبوع عليها هو آخر ما كان.
    rebuildSepButtonLikeQueueDoes('btn_sep_clip');
    expect(label().dataset.i18n, 'إعادة البناء لم تقع — الفحص باطل').toBe('btn_sep_clip');

    songCard().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(label().dataset.i18n, 'التسمية مجمّدة على عقدة ميتة بعد الدفعة').toBe('btn_sep_song');
    expect(label().innerHTML).toBe(i18n.ar.btn_sep_song);
  });
});
