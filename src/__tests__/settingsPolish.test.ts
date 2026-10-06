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
import { i18n } from '../i18n';

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

describe('٢-ب · العمود الجانبي 18rem', () => {
  it('grid-template-columns يبدأ بـ18rem لا 16rem', () => {
    const m = stylesCss.match(/grid-template-columns:\s*(\d+)rem\s+minmax/);
    expect(m, 'grid-template-columns موجود في styles.css').not.toBeNull();
    expect(m![1], 'العمود الجانبي').toBe('18');
  });

  it('nav#settings-tabs عرضه w-72 (18rem) لا w-64 (16rem)', () => {
    const nav = indexHtml.match(/<nav[^>]*id="settings-tabs"[^>]*>/);
    expect(nav, 'nav#settings-tabs موجود').not.toBeNull();
    expect(nav![0], 'w-72 على التنقّل').toContain('w-72');
    expect(nav![0], 'لا w-64 قديم').not.toContain('w-64');
  });
});

describe('٢-ج · كتلة تيليجرام مفكّكة إلى بنود برموز', () => {
  it('settings_group_mode_hint ليس فقرة متصلة — فيه بنود مفصولة', () => {
    const ar = i18n.ar.settings_group_mode_hint;
    const en = i18n.en.settings_group_mode_hint;
    const isSplit = (s: string): boolean =>
      s.includes('<li') || s.includes('<br') || (s.match(/\n/g) ?? []).length >= 2;
    expect(isSplit(ar), 'التلميح ar متصل بلا بنود').toBe(true);
    expect(isSplit(en), 'التلميح en متصل بلا بنود').toBe(true);
  });

  it('لكل بند رمز في أوّله (لا نصّ عارٍ)', () => {
    const hasLeadingSymbol = (s: string): boolean => {
      const items = s.split(/<li[^>]*>/).slice(1).map((x) => x.replace(/<\/li>[\s\S]*/, ''));
      if (items.length < 2) return false;
      const withSymbol = items.filter((it) => {
        const t = it.replace(/<[^>]+>/g, '').trim();
        return /^[\p{S}\p{P}✓✅❌♾️⚠️▶•→🎯📢🔒💬]/u.test(t);
      });
      return withSymbol.length >= items.length;
    };
    expect(hasLeadingSymbol(i18n.ar.settings_group_mode_hint), 'بنود ar بلا رموز').toBe(true);
    expect(hasLeadingSymbol(i18n.en.settings_group_mode_hint), 'بنود en بلا رموز').toBe(true);
  });

  it('المحتوى المطلوب باقٍ — مربوط باختبارات tgGroupMode', () => {
    const ar = i18n.ar.settings_group_mode_hint;
    const en = i18n.en.settings_group_mode_hint;
    for (const needle of [
      'منشن', 'privacy mode', 'اسمح دائماً', 'بطاقة موافقة', 'قائمة السماح',
      'لا يعالج البوت إلا ما وُجِّه إليه',
    ] as const) {
      expect(ar, needle).toContain(needle);
    }
    expect(en).toContain('mention');
    expect(en).toContain('privacy mode');
    expect(en).toContain('Always allow');
    expect(en).toContain('approval card');
    expect(en).toContain('allow list');
    expect(en.toLowerCase()).toMatch(/cannot start a private chat/);
    expect(ar).toMatch(/حدّ.*لا يبدأ محادثة خاصة/);
  });
});
