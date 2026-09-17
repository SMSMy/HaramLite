/* ── بند ٥: لا تشغيلان معاً (حجز التشغيل في session.ts) ────────────────────
 * العيب المُثبَت: زرّ إعادة المحاولة يُرسم **داخل** قائمة الدفعة، فيبقى على
 * الشاشة وحلقة الدفعة ما زالت تعمل. الضغط عليه كان يمرّ إلى
 * `retryBatchItem` ⇒ `runOne` ⇒ `separate_file` ثانياً، فتصير الحالة
 * `batchRunning === true` و`singleRunning === true` معاً — وهي بالضبط الحالة
 * التي يقرؤها `integration.ts:101/108` ليفصل بين شريطَي التقدّم. الاثنان
 * «صحيحان» كلٌّ على حدة، ومجموعهما مستحيل.
 *
 * الاختبار يقف على المصدر: العلَمَان لم يعودا يُكتبان مباشرة، بل يُشتقّان من
 * حجز واحد (`tryBeginRun`)؛ فالسطر الذي كان يُنتج الحالة صار مرفوضاً.
 * ويسقط قبل الإصلاح: `setSingleRunning(true)` كان يرفع العلَم ويُرجع void.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as session from '../session';

/** أعِد المحرّك إلى حالة الحرّ قبل كل اختبار (الحالة وحدة على مستوى الوحدة). */
function resetRuns(): void {
  session.endRun('batch');
  session.endRun('single');
}

describe('بند ٥ · حجز التشغيل يمنع تشغيلين متزامنين', () => {
  beforeEach(resetRuns);

  it('المسار المُثبَت: إعادة محاولة أثناء دفعة جارية لا تبدأ تشغيلاً ثانياً', () => {
    // حلقة الدفعة بدأت وحجزت المحرّك.
    expect(session.setBatchRunning(true)).toBe(true);
    expect(session.getActiveRun()).toBe('batch');

    // ثم ضغط المستخدم زرّ إعادة المحاولة على صفّ فاشل:
    // retryBatchItem ⇒ runOne ⇒ setSingleRunning(true).
    expect(session.setSingleRunning(true)).toBe(false);

    // الحالة المستحيلة لا توجد.
    expect(session.getBatchRunning()).toBe(true);
    expect(session.getSingleRunning()).toBe(false);
    expect(session.getBatchRunning() && session.getSingleRunning()).toBe(false);
    expect(session.isIdle()).toBe(false);
  });

  it('والعكس: دفعة لا تبدأ فوق تشغيل مفرد جارٍ', () => {
    expect(session.setSingleRunning(true)).toBe(true);
    expect(session.getActiveRun()).toBe('single');

    expect(session.setBatchRunning(true)).toBe(false);
    expect(session.getBatchRunning()).toBe(false);
    expect(session.getSingleRunning()).toBe(true);
  });

  it('تشغيلان مفردان معاً مرفوضان أيضاً (ضغطتان على الزرّ نفسه)', () => {
    expect(session.tryBeginRun('single')).toBe(true);
    expect(session.tryBeginRun('single')).toBe(false);
    expect(session.getActiveRun()).toBe('single');
  });

  it('الإطلاق يحرّر الحجز فيمكن تشغيل التالي', () => {
    expect(session.setSingleRunning(true)).toBe(true);
    session.endRun('single');
    expect(session.isIdle()).toBe(true);
    expect(session.getActiveRun()).toBe(null);
    expect(session.setBatchRunning(true)).toBe(true);
    session.endRun('batch');
    expect(session.getSingleRunning()).toBe(false);
    expect(session.getBatchRunning()).toBe(false);
  });

  it('الحارس الذي يقرؤه integration.ts يعكس الحجز بدقّة', () => {
    // integration.ts:101/108 ⇒ إن كان أيٌّ من العلَمَين مرفوعاً تُتجاهل
    // أحداث التقدّم. فالعلَم الراجع عن حجز مرفوض يجب أن يبقى مطفأً، وإلا
    // ظنّت الواجهة أن تشغيلاً يملك الشريط وهي لا تملكه.
    expect(session.setBatchRunning(true)).toBe(true);
    session.setSingleRunning(true); // مرفوض
    const guard = session.getSingleRunning() || session.getBatchRunning();
    expect(guard).toBe(true);
    session.endRun('batch');
    expect(session.getSingleRunning() || session.getBatchRunning()).toBe(false);
  });
});
