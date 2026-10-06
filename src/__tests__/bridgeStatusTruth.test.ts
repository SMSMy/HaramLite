/* ── ١-ب + ١-د · حالة الجسر تعرض الحقيقة لا «✓ متصلة الآن» ─────────────────
 *
 * **العلّة المقيسة**: المفتاح **معطَّل** ويُعرض «✓ الإضافة متصلة الآن».
 * سببان: (أ) `MONTH_SECS = 30 يوم` ⇒ أي اتصال خلال شهر يُعدّ «الآن»؛
 * (ب) `bridge_status` يُعيد `enabled` ولا يقرؤه العميل.
 *
 * **المطلوب**: حدّ «الآن» **دقائق** لا شهر · وعند `enabled=false` تُعرض
 * «الجسر موقوف» ويُخفى `#bridge-ext-link` · ولا يبقى `#bridge-ext-status`
 * فارغاً عند التركيب (١-د).
 *
 * **ممنوع**: مسّ منطق `host_seen` — «إضافة أُزيلت تترك آخر اتصالها خلفها»
 * مقصودة. الإصلاح في العرض لا التسجيل.
 *
 * **المُفسِد**: إرجاع العرض القديم (‏`enabled` متجاهَل + «الآن» لشهر) ⇒
 * يُسقط الاختبارات أدناه.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { renderBridgeExt, wireBridge } from '../integration';

function mountApp(): void {
  document.body.innerHTML = (new DOMParser().parseFromString(indexHtml as string, 'text/html')).body.innerHTML;
}

const status = (): HTMLElement => document.getElementById('bridge-ext-status') as HTMLElement;
const link = (): HTMLElement => document.getElementById('bridge-ext-link') as HTMLElement;

const OFF = {
  enabled: false,
  extension_now: true,
  extension_seen: true,
  extension_minutes_ago: 1,
  extension_days_ago: 0,
};
const NOW = {
  enabled: true,
  extension_now: true,
  extension_seen: true,
  extension_minutes_ago: 1,
  extension_days_ago: 0,
};
const AGO = {
  enabled: true,
  extension_now: false,
  extension_seen: true,
  extension_minutes_ago: 60 * 24 * 10,
  extension_days_ago: 10,
};
const NEVER = {
  enabled: true,
  extension_now: false,
  extension_seen: false,
  extension_minutes_ago: null,
  extension_days_ago: null,
};

describe('١-ب · العرض يقرأ enabled وحدّ «الآن» دقائق', () => {
  beforeEach(() => {
    h.invoke.mockClear();
    mountApp();
  });

  it('enabled=false ⇒ «الجسر موقوف» والرابط مخفي — حتى لو extension_now', () => {
    // المُفسِد القديم: يقرأ extension_seen وحده ⇒ «✓ متصلة الآن».
    renderBridgeExt(OFF as never);
    expect(status().textContent, 'لا يجوز ادّعاء اتصال والمفتاح معطَّل').toContain('الجسر موقوف');
    expect(status().textContent).not.toContain('متصلة الآن');
    expect(link().classList.contains('hidden'), 'الرابط يجب أن يُخفى عند تعطيل الجسر').toBe(true);
  });

  it('enabled + extension_now ⇒ «✓ الإضافة متصلة الآن» والرابط مخفي', () => {
    renderBridgeExt(NOW as never);
    expect(status().textContent).toContain('متصلة الآن');
    expect(link().classList.contains('hidden'), 'لا حاجة لرابط التثبيت عند الاتصال الفوري').toBe(true);
  });

  it('enabled + seen قديم (10 أيام) ⇒ «آخر اتصال» بلا «الآن» والرابط ظاهر', () => {
    // المُفسِد (أ): الشهر كان يجعل هذا «متصل الآن» أو ✓ مضلِّلاً.
    renderBridgeExt(AGO as never);
    expect(status().textContent).not.toContain('الآن');
    expect(status().textContent).toContain('آخر اتصال');
    expect(status().textContent).toContain('10');
    expect(link().classList.contains('hidden'), 'مسار إعادة الربط يبقى ظاهراً').toBe(false);
  });

  it('لا سجلّ أبداً ⇒ «لم يتصل بعد» والرابط ظاهر', () => {
    renderBridgeExt(NEVER as never);
    expect(status().textContent).toContain('لم يتصل');
    expect(link().classList.contains('hidden')).toBe(false);
  });
});

describe('١-د · #bridge-ext-status لا يبقى فارغاً', () => {
  beforeEach(() => {
    mountApp();
  });

  it('في الترميز نفسه (قبل أي render) الفقرة ليست فارغة', () => {
    // الفقرة الفارغة لا تنتج صفاً في flex-col ⇒ القسم متقلّص.
    expect(status(), 'العنصر غاب').not.toBeNull();
    expect((status().textContent ?? '').trim(), 'النصّ الافتراضي فارغ — القسم يتقلّص').not.toBe('');
  });

  it('renderBridgeExt(null) يكتب رسالة لا يمسح النصّ', () => {
    renderBridgeExt(null);
    expect((status().textContent ?? '').trim(), 'render(null) ترك الفقرة فارغة').not.toBe('');
  });

  it('كل الحالات الأربع تُنتج نصّاً غير فارغ', () => {
    for (const info of [OFF, NOW, AGO, NEVER]) {
      renderBridgeExt(info as never);
      expect((status().textContent ?? '').trim(), `حالة ${JSON.stringify(info)} فارغة`).not.toBe('');
    }
    renderBridgeExt(null);
    expect((status().textContent ?? '').trim()).not.toBe('');
  });
});

describe('١-ج (تحضير) · wireBridge يقرأ bridge_status عند الإقلاع', () => {
  it('الحالة المُعادة تُعرض بعد wireBridge', async () => {
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') return { ...NOW, enabled: false };
      return null;
    });
    mountApp();
    wireBridge();
    // دع الـasync init في wireBridge يكتمل.
    await new Promise((r) => setTimeout(r, 0));
    expect(status().textContent, 'wireBridge لم يعرض حالة backend').toContain('الجسر موقوف');
  });
});
