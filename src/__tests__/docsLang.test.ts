/* ── عيب مرأي: تبديل اللغة يهدم غلاف الفيديو في docs/bridge.html ─────────────
 * docs/assets/lang.js كان يكتب `el.textContent = fill(t)` على **كل** عنصر
 * `[data-i18n-ar]`. وبعضها له أبناء عنصرية — وأظهرها `div.video-shell` في
 * bridge.html:284، وهو يحمل `data-i18n-attr="aria-label"` ويحتوي `<img>` و
 * `<span class="video-play">`. فالكتابة عليه تمحو `<img>` و`<span>` وتترك
 * نصّاً عارياً: غلاف الفيديو يُهدم عند أول تبديل لغة.
 *
 * والاختبار يقرأ **الملف المشحون نفسه** (‏docs/assets/lang.js) لا نسخة منه،
 * ويشغّله في jsdom على صفحة حقيقية من المستودع — فلا يمرّ إن تغيّر الملف.
 * ويحرس الوجهين: بقاء الترميز، وبقاء النصّ مطابقاً لقيمة السمة (وهي التي
 * تحمل وسم `<b>`/`<code>` في TRANSPARENCY.html، فكانت تُعرض حرفية قبل الإصلاح).
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import LANG_JS from '../../docs/assets/lang.js?raw';
import BRIDGE_HTML from '../../docs/bridge.html?raw';
import TRANSPARENCY_HTML from '../../docs/TRANSPARENCY.html?raw';

/** يشغّل lang.js داخل الصفحة المعطاة ويعيد نافذتها. */
function mount(html: string, storedLang: 'ar' | 'en'): Window {
  const dom = new JSDOM(html, { url: 'https://haramlite.com/', runScripts: 'outside-only' });
  dom.window.localStorage.setItem('hl.lang', storedLang);
  (dom.window as unknown as { eval: (code: string) => void }).eval(LANG_JS);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom.window as unknown as Window;
}

const norm = (s: string | null): string => (s || '').replace(/\s+/g, ' ').trim();
const plain = (s: string | null): string => norm((s || '').replace(/<[^>]*>/g, ''));

/** عقد النصّ المباشرة (لا المجمَّعة من الأبناء) — وهي ما كانت الكتابة القديمة
 *  تُنشئه فتهدم الأبناء. `textContent` يجمع نصّ الأبناء أيضاً، فلا يصلح دليلاً
 *  على وجود نصّ مقحَم داخل الغلاف. */
const directTextNodes = (el: Element): ChildNode[] =>
  [...el.childNodes].filter((n) => n.nodeType === 3 && (n.nodeValue || '').trim() !== '');

describe('lang.js · غلاف الفيديو في bridge.html يبقى سليماً عند تبديل اللغة', () => {
  it('بالإنجليزية: يحفظ <img> و<span> ولا يكتب عليه نصّاً', () => {
    const win = mount(BRIDGE_HTML, 'en');
    const shell = win.document.querySelector('.video-shell');
    expect(shell, '.video-shell مفقود من bridge.html — الفحص باطل').not.toBeNull();
    expect(shell!.querySelector('img')).not.toBeNull();
    expect(shell!.querySelector('.video-play')).not.toBeNull();
    expect(shell!.querySelectorAll('img, span')).toHaveLength(2);
    expect(directTextNodes(shell!)).toEqual([]);
  });

  it('بالعربية: نفس الحفظ (التبديل ذهاباً وإياباً لا يهدم)', () => {
    const win = mount(BRIDGE_HTML, 'ar');
    const shell = win.document.querySelector('.video-shell')!;
    expect(shell.querySelector('img')).not.toBeNull();
    expect(shell.querySelector('.video-play')).not.toBeNull();
    expect(directTextNodes(shell)).toEqual([]);
  });

  it('ويُترجم aria-label فعلاً (الإصلاح لم يعطّل التسمية)', () => {
    const win = mount(BRIDGE_HTML, 'en');
    const shell = win.document.querySelector('.video-shell')!;
    expect(shell.getAttribute('aria-label')).toBe('Play the walkthrough video');

    const arWin = mount(BRIDGE_HTML, 'ar');
    const arShell = arWin.document.querySelector('.video-shell')!;
    expect(arShell.getAttribute('aria-label')).toBe('تشغيل فيديو الشرح');
  });

  it('وضابط: الكتابة بـtextContent كانت تهدمه فعلاً (العيب مُعاد إنتاجه)', () => {
    const win = mount(BRIDGE_HTML, 'en');
    const shell = win.document.querySelector('.video-shell')!;
    // نحاكي السطر القديم حرفياً: el.textContent = fill(t)
    shell.textContent = shell.getAttribute('data-i18n-en')!;
    expect(shell.querySelector('img')).toBeNull();
    expect(shell.querySelector('.video-play')).toBeNull();
    expect(shell.children).toHaveLength(0);
  });
});

describe('lang.js · عناصر TRANSPARENCY ذات <b>/<code> تُترجم ولا تُعرض حرفية', () => {
  const richElements = (win: Window): Element[] =>
    [...win.document.querySelectorAll('[data-i18n-ar]')].filter((el) => el.children.length > 0);

  it('الصفحة فيها عناصر غنيّة فعلاً (الفحص ليس باطلاً)', () => {
    const win = mount(TRANSPARENCY_HTML, 'en');
    expect(richElements(win).length).toBeGreaterThan(5);
  });

  it('لا يرث نصّاً يحمل `<b>` حرفياً، والوسم يبقى عنصراً', () => {
    const win = mount(TRANSPARENCY_HTML, 'en');
    const literal = richElements(win).filter((el) => el.textContent!.indexOf('<b>') !== -1
      || el.textContent!.indexOf('<code>') !== -1);
    expect(literal.map((el) => el.tagName + ':' + norm(el.textContent).slice(0, 40))).toEqual([]);
  });

  it('ونصّ العناصر التي تحمل وسماً يطابق سمتها (ar و en)', () => {
    for (const lang of ['ar', 'en'] as const) {
      const attr = lang === 'ar' ? 'data-i18n-ar' : 'data-i18n-en';
      const win = mount(TRANSPARENCY_HTML, lang);
      // العناصر المقصودة بالترجمة النصّية: قيمتها تحمل وسماً صريحاً
      const translated = richElements(win).filter((el) => el.getAttribute(attr)!.includes('<'));
      expect(translated.length, `[${lang}] لا عناصر ذات وسم — الفحص باطل`).toBeGreaterThan(5);
      const mismatched = translated
        .filter((el) => plain(el.getAttribute(attr)) !== norm(el.textContent))
        .map((el) => `${el.tagName} want="${plain(el.getAttribute(attr)).slice(0, 50)}" got="${norm(el.textContent).slice(0, 50)}"`);
      expect(mismatched, `[${lang}] عناصر لا يطابق نصّها سمتها`).toEqual([]);
    }
  });

  it('والعنصر الذي لا وسم في قيمته يُترك بناؤه كما هو (js-release-tag)', () => {
    // TRANSPARENCY.html:72 — السمة «تدقيق من الشيفرة · 0.2.7» بلا وسوم،
    // والابن `js-release-tag` يحمل الرقم الحيّ. لا وسم ⇒ لا شيء يُبنى، فيُترك
    // الابن كما هو ولا يُمحى (وهو ما كان يمحوه الإصلاح الأول لهذا العيب).
    for (const lang of ['ar', 'en'] as const) {
      const win = mount(TRANSPARENCY_HTML, lang);
      const el = [...win.document.querySelectorAll('[data-i18n-ar]')]
        .find((e) => e.firstElementChild?.classList.contains('js-release-tag'));
      expect(el, 'عنصر js-release-tag مفقود — الفحص باطل').not.toBeUndefined();
      expect(el!.children).toHaveLength(1);
      expect(el!.firstElementChild!.classList.contains('js-release-tag')).toBe(true);
      expect(norm(el!.firstElementChild!.textContent)).toBe('0.2.7');
    }
  });
});

describe('lang.js · قيمة ترجمة تحمل وسماً خطِراً لا تُنشئ عنصراً', () => {
  it('يُطرح <img onerror> نصّاً ولا يظهر عنصر img ولا سمة onerror', () => {
    const win = mount(BRIDGE_HTML, 'ar');
    const doc = win.document;
    const host = doc.createElement('p');
    doc.body.appendChild(host);
    // عنصر له ابن عنصري **وعقدة نصّ** (لينفّذ مسار الكتابة على عقد النصّ).
    // bridge.html ليست نسخة إنجليزية (لا data-i18n-edition)، فالمسار العربي
    // يقرأ data-i18n-ar — وهو ما نريد اختبار كتابته.
    host.setAttribute('data-i18n-ar', 'قبل <img src=x onerror="window.__pwned=1"> بعد');
    host.setAttribute('data-i18n-en', 'before <img src=x onerror="window.__pwned=1"> after');
    host.innerHTML = 'نصّ قديم <b>ابن</b>';

    win.HaramLiteLang.apply('ar');

    expect(host.querySelector('img')).toBeNull();
    expect(host.innerHTML).not.toContain('onerror');
    expect((win as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(norm(host.textContent)).toBe('قبل بعد');
  });

  it('والوسم المسموح (<b>) يبقى عنصراً بلا سمات', () => {
    const win = mount(BRIDGE_HTML, 'ar');
    const doc = win.document;
    const host = doc.createElement('p');
    doc.body.appendChild(host);
    host.setAttribute('data-i18n-ar', 'جهة واحدة فقط: <b onclick="x()">GitHub</b> — والنهاية.');
    host.setAttribute('data-i18n-en', 'One destination only: <b onclick="x()">GitHub</b> — and that is it.');
    host.innerHTML = 'نصّ قديم <b>ابن</b>';

    win.HaramLiteLang.apply('ar');

    const b = host.querySelector('b');
    expect(b).not.toBeNull();
    expect(b!.hasAttribute('onclick')).toBe(false);
    expect(norm(b!.textContent)).toBe('GitHub');
    expect(norm(host.textContent)).toBe('جهة واحدة فقط: GitHub — والنهاية.');
  });

  it('وعنصر موجَّه إلى data-i18n-attr وحده لا يُكتب عليه نصّ (video-shell)', () => {
    const win = mount(BRIDGE_HTML, 'en');
    const shell = win.document.querySelector('.video-shell')!;
    expect(shell.hasAttribute('data-i18n-attr')).toBe(true);
    expect(shell.querySelector('img')).not.toBeNull();
    expect(shell.querySelector('.video-play')).not.toBeNull();
    expect(shell.querySelectorAll('img, span')).toHaveLength(2);
    // لا نصّ مقحَم على الغلاف: عقد النصّ المباشرة بياض تنسيق فقط
    expect(directTextNodes(shell)).toEqual([]);
  });
});
