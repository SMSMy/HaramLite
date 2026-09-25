/* ── حارس تبويبات شاشة الإعدادات — **الخريطة والظهور، لا الوجود** ─────────────
 *
 * **العلّة الميدانية التي وُلد منها** (بلاغ المالك): «قسم الأداء والمعالجة يمتلك
 * زرّ CUDA فقط، أما باقي الأقسام فارغة». والسبب المقيس: الحاويات السبع كانت
 * **متداخلة** لا متجاورة — حاوية `performance` لم تُغلق في `index.html`، فصار كل
 * تبويب ابناً للذي قبله؛ و`showTab` تُخفي كل حاوية `data-tab !== tab`، فإخفاء
 * `performance` كان يُخفي **الشجرة كلها**.
 *
 * **وعلّة المنهج التي يُغلقها هذا الملف**: الحارس القديم («تكافؤ الشاشة» في
 * settingsScreen.test.ts) كان يقيس **وجود المعرّف في DOM** — `getElementById(id)
 * !== null` — فقال «٦١ من ٦١» والعطب قائم. فالوجود في DOM لا يعني **العرض في
 * التبويب الصحيح**. وهذا الملف يقيس ثلاثة أشياء لا يقيسها ذاك:
 *   ١) **الخريطة**: `المعرّف ⇒ التبويب المتوقَّع` معلَنة في `src/settingsTabMap.ts`،
 *      وتُقارن بـ`closest('.settings-tab-panel')?.dataset.tab` ⇒ معرّف في تبويب
 *      آخر **يُسقط** الحارس.
 *   ٢) **مسار الإظهار**: عند تفعيل تبويب، لا يجوز أن يكون أيُّ معرّف من معرّفات
 *      هذا التبويب محجوباً بـ`hidden` على **حاوية تبويب أب** (وهو بالضبط شكل
 *      العطب: حاوية سلف مخفيّة، لا العنصر نفسه).
 *   ٣) **`<main>`**: لا يحوي أي معرّف من الخريطة (وهي `display:none` في وضع
 *      الإعدادات، فما بداخلها لا يُرى).
 *
 * **وما لا يقيسه بصراحة**: jsdom **لا يرسم** — فـ`getBoundingClientRect()` فيه
 * أصفار دائماً، ولا `offsetHeight`. فالحكم هنا **بنيوي** (شجرة DOM وسمة `hidden`)،
 * والقياس **الهندسي** (`getBoundingClientRect().height > 0` لكل معرّف بعد تفعيل
 * تبويبه) في `scripts/check-layout.cjs` على متصفّح حقيقي — وهو الموضع الثاني
 * لنفس الخريطة، فلا يُدَّعى أن هذا الملف وحده يُثبت الظهور.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';
import {
  SETTINGS_MENU_CHROME,
  SETTINGS_OUTSIDE_TABS,
  SETTINGS_TAB_MAP,
} from '../settingsTabMap';
import { SETTINGS_TABS } from '../settingsScreen';

/** DOM التطبيق المشحون (بلا تنفيذ سكربتات: `innerHTML` لا يُنفّذ `script`). */
function mountApp(): void {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
  document.body.className = '';
}

/** يركّب ويُدخل وضع الإعدادات من الـhash (بديل الاختبار المعلَن في الوحدة). */
async function mountInSettingsMode(): Promise<typeof import('../settingsScreen')> {
  mountApp();
  const url = new URL(window.location.href);
  url.hash = 'settings';
  window.history.replaceState({}, '', url.toString());
  const screen = await import('../settingsScreen');
  screen.wireSettingsScreen();
  return screen;
}

const MAP_IDS: readonly string[] = Object.keys(SETTINGS_TAB_MAP);

/** الحاويات التي تحمل المعرّف حين يكون تبويبها مفعّلاً. */
function activate(tab: string): void {
  const btn = document.querySelector<HTMLElement>(`[data-tab-btn="${tab}"]`);
  if (!btn) throw new Error(`لا زرّ تبويب بالاسم «${tab}»`);
  btn.click();
}

/**
 * **مسار الإظهار**: يعود بسلسلة أسباب الحجب — فارغة إن كان العنصر معروضاً.
 * ويُقاس **ما يقيسه المتصفّح فعلاً**: سمة `hidden` (وهي وحدها ما تُبدّله
 * `showTab`) على العنصر أو على أي سلف حتى `#settings-menu`، و`settings-mode`
 * على `<body>` (وبدونها يُخفى `<main>` — لكن **الشاشة لا تُعرض** أيضاً).
 */
function hiddenChain(el: Element): string[] {
  const blockers: string[] = [];
  const body = document.body;
  if (!body.classList.contains('settings-mode')) blockers.push('body ليست في settings-mode (الشاشة مطويّة)');
  const menu = document.getElementById('settings-menu');
  if (menu && menu.hasAttribute('hidden')) blockers.push('#settings-menu عليها hidden');
  for (let p: Element | null = el; p && p !== menu; p = p.parentElement) {
    if (!(p instanceof HTMLElement)) continue;
    if (p.hasAttribute('hidden')) {
      const tab = p.dataset.tab ? `[data-tab=${p.dataset.tab}]` : '';
      blockers.push(`${p.id || p.tagName.toLowerCase()}${tab} عليها hidden`);
    }
  }
  return blockers;
}

afterEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  document.body.className = '';
  window.history.replaceState({}, '', window.location.pathname);
});

/* ── ٠) الخريطة نفسها غير باطلة ───────────────────────────────────────────── */
describe('خريطة تبويبات الإعدادات · الخريطة معلَنة وغير باطلة', () => {
  it('كل تبويب من السبعة له معرّفات، والخريطة ليست صغيرة ولا مكرّرة', () => {
    // حارس ضد الخريطة الفارغة/الناقصة: «كل المعرّفات في تبويبها» تصير صحيحة
    // بلا معنى لو كانت الخريطة فارغة.
    expect(MAP_IDS.length, 'عدد المعرّفات في الخريطة').toBeGreaterThanOrEqual(40);
    expect(new Set(MAP_IDS).size, 'لا معرّف مكرّر').toBe(MAP_IDS.length);
    for (const tab of SETTINGS_TABS) {
      const n = MAP_IDS.filter((id) => SETTINGS_TAB_MAP[id] === tab).length;
      // eslint-disable-next-line no-console
      console.log(`  ${tab}: ${n} معرّفاً`);
      expect(n, `التبويب «${tab}» بلا أي معرّف — تبويب فارغ في الخريطة`).toBeGreaterThan(0);
    }
    // وكل قيمة في الخريطة اسم تبويب حقيقي (لا خطأ إملائي يمرّ صامتاً).
    for (const id of MAP_IDS) {
      expect(SETTINGS_TABS.includes(SETTINGS_TAB_MAP[id]), `${id} ⇒ ${SETTINGS_TAB_MAP[id]}`).toBe(true);
    }
    // والقوائم المعلَنة الأخرى لا تتقاطع مع الخريطة (لا عنصر يصنَّف مرّتين).
    for (const id of SETTINGS_MENU_CHROME) expect(MAP_IDS.includes(id), `${id} في الخريطة وأيضاً في chrome`).toBe(false);
    for (const { id } of SETTINGS_OUTSIDE_TABS) expect(MAP_IDS.includes(id), `${id} في الخريطة وأيضاً في outside`).toBe(false);
  });
});

/* ── ١) حارس الخريطة: المعرّف في تبويبه المتوقَّع ──────────────────────────── */
describe('حارس الخريطة · كل معرّف داخل حاويته المعلَنة (لا في غيرها)', () => {
  it('يقارن closest(.settings-tab-panel).dataset.tab بالخريطة، ويطبع جدول التوزيع', async () => {
    await mountInSettingsMode();

    const wrong: string[] = [];
    const missing: string[] = [];
    const rows: string[] = [];
    for (const id of MAP_IDS) {
      const all = document.querySelectorAll(`#${CSS.escape(id)}`);
      if (all.length !== 1) { missing.push(`${id}(${all.length} نسخة)`); continue; }
      const el = all[0];
      const panel = el.closest('.settings-tab-panel') as HTMLElement | null;
      const actual = panel?.dataset.tab ?? 'none';
      const expected = SETTINGS_TAB_MAP[id];
      rows.push(`  ${id.padEnd(22)} ${String(actual).padEnd(12)} ${actual === expected ? '=' : '≠'} ${expected}`);
      if (actual !== expected) wrong.push(`${id}: في «${actual}» والمتوقَّع «${expected}»`);
    }
    // eslint-disable-next-line no-console
    console.log('  id                     panel        التوقّع');
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(r);
    }
    expect(missing, `معرّفات غائبة أو مكرّرة: ${missing.join(' · ')}`).toEqual([]);
    // **وبه يسقط نقل معرّف إلى تبويب آخر** — وهذا هو العطب الذي مرّ من الحارس القديم.
    expect(wrong, `معرّفات في غير تبويبها: ${wrong.join(' · ')}`).toEqual([]);
  });

  it('حاوية كل تبويب ابنة مباشرة لـ#settings-menu (لا حاوية داخل حاوية)', async () => {
    await mountInSettingsMode();
    const menu = document.getElementById('settings-menu')!;
    const panels = Array.from(document.querySelectorAll<HTMLElement>('.settings-tab-panel'));
    expect(panels.map((p) => p.dataset.tab), 'التبويبات السبعة بترتيبها').toEqual([...SETTINGS_TABS]);
    const nested = panels
      .filter((p) => p.parentElement !== menu)
      .map((p) => `${p.dataset.tab} داخل <${p.parentElement?.tagName.toLowerCase()}${p.parentElement?.id ? '#' + p.parentElement.id : ''}>`);
    // هذا هو **جذر العطب**: حاوية `performance` لم تُغلق فصارت الحاويات متداخلة،
    // و`showTab` يُخفي السلف فيُخفي الشجرة كلها.
    expect(nested, `حاويات متداخلة (لا متجاورة): ${nested.join(' · ')}`).toEqual([]);
  });
});

/* ── ٢) حارس الظهور: عند تفعيل تبويب، لا معرّف محجوب بحاوية أب ─────────────── */
describe('حارس الظهور · تفعيل تبويب يُظهر كل معرّفاته المجموعة', () => {
  it('لكل تبويب: كل معرّفاته معروضة، و<main> لا تحوي أي معرّف من الخريطة', async () => {
    const screen = await mountInSettingsMode();
    expect(screen.settingsScreenIsOn(), 'الوضع من الـhash').toBe(true);

    const report: string[] = [];
    const failures: string[] = [];
    for (const tab of SETTINGS_TABS) {
      activate(tab);
      const shown = Array.from(document.querySelectorAll<HTMLElement>('.settings-tab-panel')).filter((p) => !p.hidden);
      if (shown.length !== 1 || shown[0].dataset.tab !== tab) {
        failures.push(`«${tab}»: المعروض ${shown.map((p) => p.dataset.tab).join(',') || 'لا شيء'} لا واحداً`);
      }
      let visible = 0;
      for (const id of MAP_IDS.filter((i) => SETTINGS_TAB_MAP[i] === tab)) {
        const el = document.getElementById(id);
        if (!el) { failures.push(`«${tab}»: ${id} غير موجود`); continue; }
        const blockers = hiddenChain(el);
        if (blockers.length) failures.push(`«${tab}»: ${id} محجوب بـ ${blockers.join(' + ')}`);
        else visible += 1;
      }
      report.push(`  ${tab.padEnd(12)} ${visible}/${MAP_IDS.filter((i) => SETTINGS_TAB_MAP[i] === tab).length} معروضاً`);
    }
    // eslint-disable-next-line no-console
    console.log('  التبويب       معروض');
    for (const r of report) {
      // eslint-disable-next-line no-console
      console.log(r);
    }
    expect(failures, `معرّفات محجوبة عن تبويبها: ${failures.join(' · ')}`).toEqual([]);

    // و`<main>` (وهي `display:none` في وضع الإعدادات) لا تحوي أي معرّف من الخريطة.
    const main = document.querySelector('main')!;
    const inMain = MAP_IDS.filter((id) => {
      const el = document.getElementById(id);
      return el !== null && main.contains(el);
    });
    expect(inMain, `معرّفات إعدادات داخل <main> (تختفي معها): ${inMain.join(' · ')}`).toEqual([]);
  });

  it('لا معرّف داخل #settings-menu يفلت من التصنيف', async () => {
    await mountInSettingsMode();
    const menu = document.getElementById('settings-menu')!;
    const inside = Array.from(menu.querySelectorAll<HTMLElement>('[id]')).map((el) => el.id);
    const unclassified = inside.filter(
      (id) => !MAP_IDS.includes(id) && !SETTINGS_MENU_CHROME.includes(id),
    );
    expect(
      unclassified,
      `معرّفات داخل الشاشة وغير مصنَّفة (أضِفها إلى SETTINGS_TAB_MAP أو SETTINGS_MENU_CHROME): ${unclassified.join(' · ')}`,
    ).toEqual([]);
  });

  it('المعرّفات المستثناة خارج التبويبات معلَنة بسببها وليست داخل <main>', async () => {
    await mountInSettingsMode();
    const main = document.querySelector('main')!;
    const bad: string[] = [];
    for (const { id, why } of SETTINGS_OUTSIDE_TABS) {
      const el = document.getElementById(id);
      if (!el) { bad.push(`${id} غير موجود`); continue; }
      if (why.trim().length < 10) bad.push(`${id} بلا سبب معلَن`);
      if (main.contains(el)) bad.push(`${id} داخل <main>`);
    }
    expect(bad, `استثناءات غير صالحة: ${bad.join(' · ')}`).toEqual([]);
    expect(SETTINGS_OUTSIDE_TABS.length, 'قائمة الاستثناءات معلَنة').toBeGreaterThan(20);
  });
});
