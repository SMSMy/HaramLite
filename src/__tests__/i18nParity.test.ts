/* ── ج-١٠ — تكافؤ جدولَي الترجمة وكل مفتاح في index.html ───────────────────
 * ثلاث جهات يجب أن تتقاطع: i18n.ar · i18n.en · وسوم data-i18n* في index.html.
 * مفتاح في الواجهة وليس في الجدول ⇒ applyLang() يكتب `undefined` في العنصر
 * (نصّ حرفي «undefined» مكان التسمية)، ومفتاح في `ar` وحده ⇒ واجهة عربية
 * بإنجليزية ناقصة. والاختبار يفحص أسماء المتغيّرات {…} أيضاً: مفتاح ناقص
 * المتغيّر يعرض «{secs}» للمستخدم بلا استبدال.
 */
import { describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import indexHtml from '../../index.html?raw';

type Table = Record<string, string>;
const ar = i18n.ar as unknown as Table;
const en = i18n.en as unknown as Table;

/** Keys carried by one `data-i18n*` attribute family in index.html. The
 *  pattern cannot cross families: `data-i18n` is followed by `=`, while
 *  `data-i18n-aria` continues with `-`. */
function attrKeys(html: string, attr: string): string[] {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'g');
  return [...html.matchAll(re)].map((m) => m[1]);
}

const htmlKeys = attrKeys(indexHtml, 'data-i18n');
const ariaKeys = attrKeys(indexHtml, 'data-i18n-aria');
const titleKeys = attrKeys(indexHtml, 'data-i18n-title');

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('ج-١٠ · i18n.ar and i18n.en carry the same key set', () => {
  it('every Arabic key exists in English', () => {
    const missing = Object.keys(ar).filter((k) => !(k in en));
    expect(missing, 'keys present in i18n.ar but missing from i18n.en').toEqual([]);
  });

  it('every English key exists in Arabic', () => {
    const missing = Object.keys(en).filter((k) => !(k in ar));
    expect(missing, 'keys present in i18n.en but missing from i18n.ar').toEqual([]);
  });

  it('has no key whose value is empty or whitespace only', () => {
    const emptyAr = Object.keys(ar).filter((k) => ar[k].trim() === '');
    const emptyEn = Object.keys(en).filter((k) => en[k].trim() === '');
    expect(emptyAr, 'empty values in i18n.ar').toEqual([]);
    expect(emptyEn, 'empty values in i18n.en').toEqual([]);
  });

  it('uses the same {placeholders} in both languages for every key', () => {
    const mismatched = Object.keys(ar)
      .filter((k) => k in en)
      .map((k) => ({ k, a: placeholders(ar[k]).join(','), e: placeholders(en[k]).join(',') }))
      .filter(({ a, e }) => a !== e)
      .map(({ k, a, e }) => `${k}: ar=[${a}] en=[${e}]`);
    expect(mismatched, 'placeholder sets differ between i18n.ar and i18n.en').toEqual([]);
  });
});

describe('ج-١٠ · every data-i18n key used by index.html is in both tables', () => {
  it('data-i18n', () => {
    const offenders = [...new Set(htmlKeys)]
      .filter((k) => !(k in ar) || !(k in en))
      .map((k) => `${k} (ar:${k in ar ? 'yes' : 'MISSING'} en:${k in en ? 'yes' : 'MISSING'})`);
    expect(offenders, 'index.html labels bound to a key the tables do not have').toEqual([]);
  });

  it('data-i18n-aria and data-i18n-title', () => {
    const offenders = [...new Set([...ariaKeys, ...titleKeys])]
      .filter((k) => !(k in ar) || !(k in en))
      .map((k) => `${k} (ar:${k in ar ? 'yes' : 'MISSING'} en:${k in en ? 'yes' : 'MISSING'})`);
    expect(offenders, 'index.html aria/title labels bound to a missing key').toEqual([]);
  });
});

describe('ج-١٠ · the parity checks are not vacuous', () => {
  it('read a plausible amount of both sources', () => {
    // If the table or the extraction ever yields (nearly) nothing, the checks
    // above would pass by emptiness — this is the guard against that.
    expect(Object.keys(ar).length).toBeGreaterThan(100);
    expect(Object.keys(en).length).toBe(Object.keys(ar).length);
    expect(new Set(htmlKeys).size).toBeGreaterThan(50);
    expect(new Set([...ariaKeys, ...titleKeys]).size).toBeGreaterThan(5);
  });
});
