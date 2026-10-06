/* ── ١-ج · تبديل مفتاح الجسر يُحدّث الحالة فوراً ──────────────────────────
 *
 * **العلّة المقيسة**: `applyBridge` (integration.ts) كانت لا تنادي
 * `refreshBridgeExt` بعد التبديل ⇒ الحالة تبقى على قراءة قديمة حتى
 * الإقلاع التالي (أو فتح تبويب يستدعي refresh).
 *
 * **الإصلاح**: `await refreshBridgeExt()` بعد نجاح التبديل **و** بعد
 * مسار الفشل (الحالة الحقيقية بعد محاولة التراجع).
 *
 * **المُفسِد**: إزالة نداء `refreshBridgeExt` من `applyBridge` ⇒ يُسقط
 * الاختبار (الحالة لا تتحدّث عند التبديل).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  // بلا نوع مُستنتَج: `vi.fn(async () => null)` يستنتج `Promise<null>` فيرفض
  // `mockImplementation` التي تعيد حمولات أخرى — خطأ `tsc` لم تُسقطه vitest.
  invoke: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: h.listen }));

import { wireBridge } from '../integration';

function mountApp(): void {
  document.body.innerHTML = (new DOMParser().parseFromString(indexHtml as string, 'text/html')).body.innerHTML;
}

const status = (): HTMLElement => document.getElementById('bridge-ext-status') as HTMLElement;
const cb = (): HTMLInputElement => document.getElementById('setting-bridge') as HTMLInputElement;

describe('١-ج · applyBridge تستدعي refreshBridgeExt بعد التبديل', () => {
  beforeEach(() => {
    h.invoke.mockClear();
    localStorage.clear();
    mountApp();
  });

  it('تبديل المفتاح من 0 إلى 1 ⇒ الحالة تتحدّث (نداء bridge_status بعد التبديل)', async () => {
    // الحالة قبل التبديل: موقوف.
    const before = {
      enabled: false,
      extension_now: false,
      extension_seen: false,
      extension_minutes_ago: null,
      extension_days_ago: null,
    };
    const after = {
      enabled: true,
      extension_now: true,
      extension_seen: true,
      extension_minutes_ago: 0,
      extension_days_ago: 0,
    };
    let phase: 'before' | 'after' = 'before';
    let statusCalls = 0;
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') {
        statusCalls += 1;
        return phase === 'before' ? before : after;
      }
      return 'ok';
    });

    wireBridge();
    await new Promise((r) => setTimeout(r, 0)); // init async
    expect(status().textContent, 'الحالة الابتدائية').toContain('الجسر موقوف');

    // التبديل: المفتاح على، والحالة ستُقرأ بعدها.
    phase = 'after';
    const callsBeforeToggle = statusCalls;
    cb().checked = true;
    cb().dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(
      statusCalls,
      'لا نداء bridge_status بعد التبديل — refreshBridgeExt غير مُستدعاة',
    ).toBeGreaterThan(callsBeforeToggle);
    expect(status().textContent, 'الحالة لم تتحدّث بعد التبديل').toContain('متصلة الآن');
  });

  it('المُفسِد: بلا refresh بعد التبديل تبقى الحالة «موقوف» رغم enabled=true', async () => {
    // هذا يثبت أن التحديث يأتي من refresh بعد applyBridge لا من مكان آخر.
    const off = {
      enabled: false,
      extension_now: false,
      extension_seen: false,
      extension_minutes_ago: null,
      extension_days_ago: null,
    };
    const on = {
      enabled: true,
      extension_now: true,
      extension_seen: true,
      extension_minutes_ago: 0,
      extension_days_ago: 0,
    };
    let phase: 'off' | 'on' = 'off';
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') return phase === 'off' ? off : on;
      return 'ok';
    });
    wireBridge();
    await new Promise((r) => setTimeout(r, 0));
    expect(status().textContent).toContain('الجسر موقوف');

    phase = 'on';
    cb().checked = true;
    cb().dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // لو نُزع refreshBridgeExt من applyBridge سيبقى النصّ «الجسر موقوف» —
    // وهذا هو المُفسِد: الاختبار الأول يطلبه «متصلة الآن» فيسقط.
    expect(status().textContent, 'المُفسِد: الحالة قديمة بعد التبديل').not.toContain('الجسر موقوف');
    expect(status().textContent).toContain('متصلة الآن');
  });
});
