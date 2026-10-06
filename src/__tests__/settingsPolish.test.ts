/* ── الدفعة ٢ · fix/settings-polish ────────────────────────────────────────
 *
 * ٢-أ: تسميات التبويبات تلتفّ سطرين ⇒ whitespace-nowrap على التسميات.
 *
 * CSS يُقرأ من القرص لا بـ`?raw` (ف`?raw` على `.css` يعود فارغاً في vitest —
 * درس مقيس في dragClassFeedback.test.ts). وكل فحص **يسقط قبل العلاج**.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stylesCss = readFileSync(join(REPO_ROOT, 'src', 'styles.css'), 'utf8');

describe('٢-أ · تسميات التبويبات لا تلتفّ سطرين', () => {
  it('كل تسمية تبويب محميّة بـwhitespace-nowrap (HTML أو CSS على .settings-tab)', () => {
    const btns = [...indexHtml.matchAll(/<button[^>]*class="[^"]*settings-tab[^"]*"[^>]*>/g)];
    expect(btns.length, 'ستة أزرار تبويب').toBe(6);
    // العلاج: whitespace-nowrap على التسميات. إمّا صنف على span.flex-1
    // وإمّا قاعدة CSS على .settings-tab (تبقى بعد applyLang الذي يمسح span).
    const htmlHasNowrap = /flex-1\s+whitespace-nowrap|whitespace-nowrap\s+flex-1/.test(indexHtml);
    const cssHasNowrap = /settings-tab[^{]*{[^}]*white-space:\s*nowrap/.test(stylesCss);
    expect(
      htmlHasNowrap || cssHasNowrap,
      'لا whitespace-nowrap على تسميات التبويبات (HTML ولا CSS)',
    ).toBe(true);
  });

  it('زرّ update (أطول تسمية عربية) محميّ — صنف على الزرّ أو التسمية أو قاعدة CSS', () => {
    const updateBtn = indexHtml.match(
      /<button[^>]*data-tab-btn="update"[^>]*>([\s\S]*?)<\/button>/,
    );
    expect(updateBtn, 'زرّ update موجود').not.toBeNull();
    const inner = updateBtn![1];
    const htmlHas = inner.includes('whitespace-nowrap');
    const cssOnTab = /settings-tab[^{]*{[^}]*white-space:\s*nowrap/.test(stylesCss);
    expect(htmlHas || cssOnTab, 'التسمية تلتفّ — لا nowrap').toBe(true);
  });

  it('لا text-overflow: ellipsis على التبويبات (يخفي العلّة)', () => {
    expect(stylesCss, 'ellipsis ممنوع على .settings-tab').not.toMatch(
      /settings-tab[^{]*{[^}]*text-overflow:\s*ellipsis/,
    );
    expect(indexHtml, 'ellipsis ممنوع في أزرار التبويب').not.toMatch(
      /settings-tab[^"]*text-overflow/,
    );
  });
});
