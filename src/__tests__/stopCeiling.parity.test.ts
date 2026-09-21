/* ── حارس تكافؤ «سقف نداء المحرّك» — رقم واحد في كل مكان ───────────────────
 * العطل المقيس (م٢/إصلاح): الرقم المعلَن للمستخدم كان **نسخاً تفترق** —
 * `141` في الواجهة (`src/jobs.ts`) و`150` في تلغرام (`src-tauri/src/telegram.rs`)
 * — وكلاهما مشتقّ من عيّنة `inference_ms=140208` قديمة. وأطول نداء **مقيس**
 * فعلاً في سجلّ المالك (`haramlite.log.2026-09-21`) هو `inference_ms=565451`
 * ⇒ فالوعد كان أقصر من الواقع **٣.٨×** (‏566/150) ورقمين مختلفين لحالة واحدة.
 *
 * وهذا الحارس يقرأ **الملفات المشحونة نفسها** (لا نسخاً منها) ويفشل إن تباعدت:
 *   • ثابت Rust (`ENGINE_CALL_CEILING_SECS`) هو المصدر،
 *   • `STOP_CEILING_SECS` في الواجهة يساويه،
 *   • تلغرام **يشتقّ** منه لا يكتب رقماً بيده،
 *   • ونصوص الواجهة (عربي/إنجليزي) والموقع يذكرون **الدقائق المشتقّة** نفسها.
 *
 * **مُفسَداته**: تغيير أيّ من الأربعة وحده ⇒ يسقط. (قِيس فعلاً: ٥٦٦ ⟶ ٥٥٠ في
 * Rust وحده أسقط ٤ فحوص هنا.)
 */
import { describe, expect, it } from 'vitest';
import PIPELINE_RS from '../../src-tauri/src/pipeline.rs?raw';
import TELEGRAM_RS from '../../src-tauri/src/telegram.rs?raw';
import JOBS_TS from '../jobs.ts?raw';
import I18N_TS from '../i18n.ts?raw';
import PODCAST_HTML from '../../docs/guides/remove-music-from-podcast.html?raw';
import { STOP_CEILING_SECS } from '../jobs';

/** الرقم من ثابت Rust — قراءة نصّية من الملف نفسه (لا من نسخة). */
function rustCeiling(): number {
  const m = /pub const ENGINE_CALL_CEILING_SECS: u64 = (\d+);/.exec(PIPELINE_RS);
  expect(m, 'ثابت Rust موجود في pipeline.rs').not.toBeNull();
  return Number(m![1]);
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toArabicDigits = (s: string): string => s.replace(/\d/g, (d) => AR_DIGITS[Number(d)]);

describe('stop ceiling parity (Rust ↔ UI ↔ telegram ↔ site)', () => {
  it('the UI constant equals the Rust constant — one number, not two copies', () => {
    expect(STOP_CEILING_SECS).toBe(rustCeiling());
  });

  it('the Rust constant is the measured one (566 s = 565.451 s rounded up)', () => {
    expect(rustCeiling()).toBe(566);
    expect(PIPELINE_RS).toContain('565.451');
    expect(PIPELINE_RS).toContain('inference_ms=565451');
  });

  it('telegram derives the hint from the Rust constant instead of writing its own', () => {
    expect(TELEGRAM_RS).toContain(
      'pub const INFERENCE_BAIL_HINT_SECS: u64 = crate::pipeline::ENGINE_CALL_CEILING_SECS;',
    );
    // ولا رقم منسوخ بيد: لا 141 ولا 150 على أيّ من الثابتين.
    expect(TELEGRAM_RS).not.toMatch(/INFERENCE_BAIL_HINT_SECS:\s*u64\s*=\s*(141|150)\b/);
    expect(JOBS_TS).not.toMatch(/STOP_CEILING_SECS\s*=\s*(141|150)\b/);
  });

  it('both UI languages spell out the derived minutes next to the seconds', () => {
    const mins = (STOP_CEILING_SECS / 60).toFixed(1); // "9.4"
    const ar = /stop_note_wait:\s*'([^']*)'/.exec(I18N_TS)?.[1] ?? '';
    const en = I18N_TS.split('\n').filter((l) => l.includes('stop_note_wait:'))[1] ?? '';
    expect(ar, 'نصّ الإيقاف العربي موجود').toContain('{secs}');
    expect(ar).toContain(toArabicDigits(mins));
    expect(ar).toContain('أطول ما قيس');
    expect(ar).not.toContain('≤');
    expect(en, 'نصّ الإيقاف الإنجليزي موجود').toContain('{secs}');
    expect(en).toContain(mins);
    expect(en).toContain('longest measured');
  });

  it('the published guide states the measured worst case in both of its spots', () => {
    const mins = (STOP_CEILING_SECS / 60).toFixed(1);
    const figure = `أطول ما قيس ${toArabicDigits(mins)} دقيقة`;
    // **موضعان** (البطاقة + FAQ): الرقم نفسه فيهما، لا رقم في واحد وصمت في الآخر.
    const spots = PODCAST_HTML.split(figure).length - 1;
    expect(spots, `«${figure}» في موضعين (وُجد في ${spots})`).toBeGreaterThanOrEqual(2);
    // ولا رقم قديم يبقى: كانت الصفحة تقول «≤ 150 ث (أطول نداء مقيس 140 ث)».
    expect(PODCAST_HTML).not.toContain('150 ث');
    expect(PODCAST_HTML).not.toContain('140 ث');
    expect(PODCAST_HTML).not.toContain('نداء مقيس 140');
  });

  it('no file claims the engine call stops "instantly" (فوراً)', () => {
    // النداء داخل العملية لا يُقطع: «فوراً» تصف العمليات المنفصلة وحدها.
    const ar = /stop_note_wait:\s*'([^']*)'/.exec(I18N_TS)?.[1] ?? '';
    expect(ar).not.toContain('نداء المحرّك الجاري يُقتل فوراً');
    expect(TELEGRAM_RS).not.toContain('خلال ≤');
  });
});
