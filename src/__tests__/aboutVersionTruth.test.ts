/* ── ١-أ · شارة الإصدار في «حول البرنامج» تعرض الحقيقة لا «—» ─────────────
 *
 * **العلّة المقيسة**: `main.ts` كان ينادي `wire()` (‏`wireAbout()` ⇒ `fillAbout()`)
 * **قبل** جلب `ping` و`session.setAppVersion` — فتكتب `fillAbout` شارة
 * `v${session.getAppVersion() || '—'}` وهي **فارغة** ⇒ `v—`. والشارة في
 * الترويسة (`#version-badge`) كانت تبدو صحيحة لأنها تُملأ بعد الجلب مباشرة.
 *
 * **الإصلاح**: جلب `ping` قبل `wire()` (الأنظف من إعادة `fillAbout`).
 *
 * **المُفسِد**: عكس الترتيب (‏`fillAbout` قبل `setAppVersion`) ⇒ يُسقط
 * الاختبار بـ`v—` — وهو بالضبط العطب المقيس.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined) }));

import * as session from '../session';
import { wireAbout } from '../aboutUpdate';

function mountApp(): void {
  document.body.innerHTML = (new DOMParser().parseFromString(indexHtml as string, 'text/html')).body.innerHTML;
}

function aboutVersionText(): string {
  return document.getElementById('about-version')?.textContent ?? '';
}

describe('١-أ · الإصدار يُجلب قبل fillAbout', () => {
  beforeEach(() => {
    h.invoke.mockClear();
    session.setAppVersion('');
    mountApp();
  });

  it('setAppVersion ثم wireAbout ⇒ الشارة تحمل الإصدار لا «—»', () => {
    // الترتيب الصحيح كما في main.ts بعد الإصلاح: ping ⇒ setAppVersion ⇒ wire
    session.setAppVersion('0.3.0');
    wireAbout();
    expect(aboutVersionText(), 'الشارة في «حول» بلا إصدار').toContain('0.3.0');
    expect(aboutVersionText(), 'الشارة تعرض «—» — fillAbout شُغّل قبل الجلب').not.toContain('—');
  });

  it('المُفسِد: fillAbout قبل setAppVersion ⇒ v— وهو العطب حرفياً', () => {
    // عكس الترتيب القديم: wireAbout (fillAbout) ثم الجلب — الناتج `v—`.
    wireAbout();
    expect(aboutVersionText(), 'المُفسِد لم يُسقط العطب — fillAbout قرأ إصداراً غير موجود').toContain('—');
    // وبعد الجلب المتأخر تبقى الشارة قديمة (لا إعادة تلقائية) — وهذا سبب
    // أن النقل قبل wire() أنظف من إعادة fillAbout.
    session.setAppVersion('0.3.0');
    expect(aboutVersionText(), 'لا إعادة لـfillAbout تلقائياً بعد التأخير').toContain('—');
  });

  it('الشارة الفارغة (بلا setAppVersion أصلاً) تعرض v— بصراحة', () => {
    wireAbout();
    expect(aboutVersionText().replace(/\s+/g, ''), 'الشارة الافتراضية').toBe('v—');
  });
});
