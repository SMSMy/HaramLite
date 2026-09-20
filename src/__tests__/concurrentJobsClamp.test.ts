/* ── م١/هـ — clampConcurrentJobs() في src/settings.ts ─────────────────────
 * سقف الفصول المتزامنة مداه **1..=2** (نفس `slots::MAX_LIMIT` في الخلف).
 *
 * العطل المقيس الذي يثبّته هذا الاختبار: القيمة كانت تُمرَّر كما هي من
 * `localStorage` (`Number(...) || 1`)، فقيمة دخيلة مثل `'9'` تُدفع إلى الخلف
 * فيقصّها `slots::clamp_limit` إلى **2**، بينما القائمة (`settingsPanel.ts`)
 * تعرض **1** لأنها تقرأ `'2'` بالتساوي فقط ⇒ الواجهة تعرض غير ما ينفّذه
 * التطبيق. فالتطبيع صار في الواجهة أيضاً: المعروض = المُرسَل.
 *
 * والقيمة الخارجة تُردّ إلى **1** (الافتراضيّ الآمن، وهو ما تختاره القائمة
 * لقيمة غير صالحة) لا إلى 2 — فلا رفع صامت إلى الطرف الذي يستهلك هامش
 * البطاقة (245 م.ب في أسوأ ما قيس).
 */
import { describe, expect, it } from 'vitest';
import { clampConcurrentJobs } from '../settings';

describe('م١/هـ · clampConcurrentJobs keeps the cap inside 1..=2', () => {
  it.each([
    ['the explicit maximum stays', 2, 2],
    ['the default stays', 1, 1],
    ['the spurious 9 is not passed through', 9, 1],
    ['zero is not a cap (it was raised to 1 in the backend too)', 0, 1],
    ['a negative value falls back to the safe side', -3, 1],
    ['NaN (unparsable storage) falls back to the safe side', Number('abc'), 1],
    ['a fractional value is not rounded up to the maximum', 1.5, 1],
  ])('%s', (_label, input, expected) => {
    expect(clampConcurrentJobs(input)).toBe(expected);
  });

  it('never returns a value the backend would have to clamp', () => {
    // الضابط الموجب: كل قيمة تمرّ عبر التطبيع تقع في المدى الذي يقبله
    // `slots::clamp_limit` بلا تغيير — فلا فرق بين المعروض والمنفَّذ.
    for (const raw of [-1, 0, 0.4, 1, 1.9, 2, 2.1, 5, 1e9, NaN]) {
      const v = clampConcurrentJobs(raw);
      expect([1, 2]).toContain(v);
    }
  });
});
