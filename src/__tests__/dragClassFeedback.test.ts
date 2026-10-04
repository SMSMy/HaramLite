/* ── د3 · الصنف المُبدَّل أثناء السحب معرَّف في CSS ────────────────────────
 *
 * **العلّة المقيسة** (بلاغ د3 على `8b2295a`): `wireDropzone` يبدّل صنف
 * `dragging` على `#dropzone`، و`src/styles.css` يعرّف `.drag-over` وحده
 * (لا `.dragging` في styles.css ولا في tailwind.config.cjs) ⇒ نبض
 * `pulse-drag` وإبراز منطقة الإفلات ميتان — لا تغذية بصرية أثناء السحب.
 *
 * **ما يقيسه**: فحص نصّي بحدّه المعلَن (هكذا شرط قبول البند) — يستخرج أصناف
 * `classList.add/remove/toggle` من مقطع معالج السحب في `src/main.ts` ويشترط
 * أن يكون كلٌّ منها معرَّفاً في `src/styles.css`، حيث تسكن تغذية السحب
 * (`pulse-drag` وحدودها وتكبيرها).
 *
 * **ما لا يقيسه (بصراحة)**: الرسم الفعلي — jsdom لا يحسب أنماطاً ولا
 * `getBoundingClientRect` بقيم حيّة؛ المقيس أن الاسم موحَّد بين المُبدِّل
 * والمعرِّف. وحدّ ثانٍ: الفحص مقصور على أصناف معالج السحب (أصناف tailwind
 * المولَّدة خارج نطاقه عمداً).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import mainTs from '../main.ts?raw';

/** styles.css يُقرأ من القرص لا بـ`?raw`: قِيس أن `?raw` على ملف `.css` يعود
 *  **سلسلة فارغة** في vitest (خط معالجة CSS يتدخّل قبل محوّل الأصول) — ونمط
 *  القراءة من الجذر نفسه المعتمد في `i18nConsumers.test.ts` لتفادي قصّ المسار
 *  عند الفراغ في اسم المجلد. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stylesCss = readFileSync(join(REPO_ROOT, 'src', 'styles.css'), 'utf8');

describe('د3 · صنف التغذية البصرية للسحب موحَّد مع CSS', () => {
  it('كل صنف يبدّله معالج السحب في main.ts معرَّف في styles.css', () => {
    const start = mainTs.indexOf('onDragDropEvent');
    expect(start, 'معالج السحب غاب من main.ts — الفحص باطل').toBeGreaterThan(-1);
    const scope = mainTs.slice(start, mainTs.indexOf('});', start) + 3);
    const classes = [...scope.matchAll(/classList\.(?:add|remove|toggle)\('([a-z-]+)'\)/g)].map((m) => m[1]);
    expect(classes.length, 'لا أصناف مُبدَّلة في معالج السحب — الفحص باطل').toBeGreaterThan(0);
    const undefinedClasses = classes.filter((c) => !new RegExp(`\\.${c}[\\s,{:\\[.]`).test(stylesCss));
    expect(undefinedClasses, 'أصناف مُبدَّلة بلا تعريف في styles.css').toEqual([]);
  });

  it('وتغذية السحب نفسها موجودة في CSS (تعريف .drag-over ونبضها)', () => {
    expect(stylesCss).toMatch(/\.drag-over\s*{[^}]*pulse-drag/);
  });
});
