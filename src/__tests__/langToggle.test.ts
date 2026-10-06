/* ── ج-١ · زرّا اللغة يختاران ولا يقلبان ──────────────────────────────────
 *
 * **العلّة المقيسة** (بلاغ ج-١ على `fix/m0`): معالج `#lang-toggle` مسجَّل على
 * **الحاوية** ويقلب اللغة دائماً (`lang = lang === 'ar' ? 'en' : 'ar'`) ⇒
 * (١) الضغط على «AR» وأنت عربي **يحوّلك للإنجليزية**، و(٢) لا كود يحدّث حالة
 * الزرّين — «AR» مضيء بحرف في الترميز فيبقى مضيئاً بعد التبديل فيبدو الزرّ
 * معطّلاً.
 *
 * **ما يقيسه** (jsdom على index.html المشحون): الضغط على الزرّ يضع اللغة
 * **الذي اسمه** (`data-lang`) في `hl.lang` و`documentElement`؛ والتلوين
 * النشط يتبع اللغة الحالية؛ والضغط على اللغة الحالية **لا يقلبها**.
 *
 * **ما لا يقيسه (بصراحة)**: إعادة التحميل نفسها (`location.reload()` لا
 * تعمل في jsdom فعلياً) — المقيس الحالةُ قبلها: التخزين والجذر والتلوين.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: h.listen }));

import { wireLang } from '../i18n';

const btn = (lang: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`#lang-toggle button[data-lang="${lang}"]`)!;
const click = (el: HTMLElement): void => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
const stored = (): string | null => localStorage.getItem('hl.lang');
const isActive = (el: HTMLElement): boolean =>
  el.classList.contains('text-clay-accent') && el.classList.contains('font-bold');

describe('ج-١ · زرّا اللغة يختاران ولا يقلبان', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML =
      (new DOMParser().parseFromString(indexHtml as string, 'text/html')).body.innerHTML;
    wireLang();
  });

  it('الضغط على EN يضع الإنجليزية، والضغط على AR يضع العربية', () => {
    click(btn('en'));
    expect(stored(), 'النقر على EN وضع شيئاً آخر').toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    click(btn('ar'));
    expect(stored(), 'النقر على AR وضع شيئاً آخر').toBe('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('والتلوين النشط يتبع اللغة الحالية لا ترميزاً ثابتاً', () => {
    // الترميز يبدأ بعربية مضيئة (الافتراضي) — والنقر على EN يقلب التلوين.
    expect(isActive(btn('ar'))).toBe(true);
    click(btn('en'));
    expect(isActive(btn('en')), 'EN لم تتلوّن بعد التبديل للإنجليزية').toBe(true);
    expect(isActive(btn('ar')), 'AR بقيت مضيئة بعد التبديل للإنجليزية').toBe(false);
    click(btn('ar'));
    expect(isActive(btn('ar'))).toBe(true);
    expect(isActive(btn('en'))).toBe(false);
  });

  it('والضغط على اللغة الحالية لا يقلبها (لا قلب أعمى)', () => {
    click(btn('ar')); // عربي أصلاً — الزرّ نفسه: لا انقلاب ولا كتابة
    expect(stored(), '«AR» وأنت عربي قلبك للإنجليزية').not.toBe('en');
    click(btn('en'));
    click(btn('en')); // إنجليزي الآن — الزرّ نفسه
    expect(stored(), '«EN» وأنت إنجليزي قلبك للعربية').toBe('en');
  });

  it('والنقر داخل الحاوية خارج الزرّين لا يغيّر شيئاً', () => {
    const container = document.getElementById('lang-toggle')!;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(stored()).toBeNull();
  });
});
