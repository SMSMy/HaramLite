/* ── د11 · هوامش منطقية لا فيزيائية ──────────────────────────────────────
 *
 * **العلّة المقيسة** (بلاغ د11 على `8b2295a`): هوامش فيزيائية في
 * `index.html:373,462` و`src/media.ts:57` **تنعكس في RTL** بينما بقية
 * الملفات تستعمل المنطقية (`ms-auto`) ⇒ فجوات تختفي أو تنقلب بحسب اللغة.
 * أسماء الأصناف الفيزيائية **لا تُكتب حرفاً هنا** كي لا يطابق grep شرط
 * القبول هذا الملفَ ذاته.
 *
 * **ما يقيسه**: لا صنف هوامش فيزيائي في `index.html` ولا في أي وحدة تحت
 * `src/` — شرط قبول البند نفسه (grep) جُعل حارساً دائماً.
 *
 * **ما لا يقيسه (بصراحة)**: المعاينة البصرية للفجوات في الاتجاهين (بلاغ
 * المراجعة نفسه يصنّفها «غير مقيسة») — المقيس أن الأصناف الفيزيائية زالت.
 */
import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';

const SRC_MODULES = import.meta.glob('../**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** نمط صنف الهوامش الفيزيائية (بادئة `mr` أو `ml` يليها شرطة ورقم أو كلمة) —
 *  و«timer-» لا تطابق: `\b` يمنع المطابقة بعد حرف كلمة. */
const PHYSICAL = /\b(?:mr|ml)-[a-z0-9]/;

describe('د11 · هوامش منطقية لا فيزيائية', () => {
  it('لا أصناف هوامش فيزيائية في index.html ولا في أي وحدة تحت src/', () => {
    const offenders: string[] = [];
    if (PHYSICAL.test(indexHtml)) offenders.push('index.html');
    for (const [path, src] of Object.entries(SRC_MODULES)) {
      if (PHYSICAL.test(src)) offenders.push(path);
    }
    expect(offenders, 'هوامش فيزيائية تنعكس عند تغيير الاتجاه').toEqual([]);
  });

  it('والفحص غير فارغ: الاستبدال المنطقي (ms-*) موجود فعلاً', () => {
    expect(indexHtml).toMatch(/\bms-(auto|1)\b/);
  });
});
