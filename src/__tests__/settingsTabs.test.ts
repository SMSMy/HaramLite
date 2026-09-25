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

/* مِحوَرات Tauri: هذا الملف يستورد وحدات تنادي `invoke` (‏`queue.ts` في حارس
 * `updateQualityOptions`، و`hiddenPanel.ts` في حارس النقر الستّ). بلا محوَل
 * يفشل النداء **بعد** انتهاء الاختبار فيُحسب خطأً غير معالَج ويُسقِط الملف كلّه
 * (وقع فعلاً: `Test Files 21 passed` مع `Errors 6` و`EXIT=1`). */
const h = vi.hoisted(() => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import indexHtml from '../../index.html?raw';
import settingsRs from '../../src-tauri/src/settings.rs?raw';
/* **مصدرا الرموز** لحارس «لا مفتاح بلا مستهلك» (الشرط ② أدناه): يُقرآن آلياً
 * من الرست، فلا يُعلَن رمزٌ بيد. و`errorTextSurface` نصّاً للشرط ③. */
import bridgeRs from '../../src-tauri/src/bridge.rs?raw';
import ytDlpRs from '../../src-tauri/src/yt_dlp.rs?raw';
import errorTextSurfaceSrc from './errorTextSurface.test.ts?raw';
import { i18n } from '../i18n';
import {
  SETTINGS_FIELD_CONTROL,
  SETTINGS_FIELDS_WITHOUT_CONTROL,
  SETTINGS_GROUP_HEADING_KEYS,
  SETTINGS_HIDDEN_SURFACES,
  SETTINGS_MENU_CHROME,
  SETTINGS_OUTSIDE_TABS,
  SETTINGS_TAB_MAP,
} from '../settingsTabMap';
import { SETTINGS_TABS } from '../settingsScreen';

/**
 * **كل** وحدات `src/*.ts` كنصّ — لأن حارس «لا مسار ميت» يجب أن يرى الوحدة كلها
 * لا `main.ts` وحده. والمسح الشامل هو ما كشف `q-wrap`/`quality-select` في
 * `queue.ts` (ولم يكن `main.ts` ليراه).
 */
const SRC_MODULES = import.meta.glob('../*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** كل وحدات `src/**` (ومعها الاختبارات) — لمستهلكي مفاتيح الترجمة. */
const ALL_SRC_MODULES = import.meta.glob('../**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * يُزيل التعليقات كي لا يُحسَب **ذكر** المفتاح في نصّ شرحٍ مستهلكاً له.
 *
 * **ويتوقّف عن الإزالة داخل نصوص المحارف**: نسخة أولى كانت تُزيل من `//` إلى
 * آخر السطر **دون نظرٍ إلى السياق**، فقصّت `https://github.com/…` داخل قالب
 * نصّي في `aboutUpdate.ts` ومحَت معها `${t('about_dev_rest')}` ⇒ أعلنت مفتاحاً
 * **مستعمَلاً** يتيماً. ولم يكشفه إلا `tsc` (‏`t()` مقيَّدة بمجموعة المفاتيح).
 * فالقاعدة هنا: داخل `'`/`"`/`` ` `` لا تعليقات.
 */
function stripComments(text: string, isHtml: boolean): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const d = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += d ?? '';
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    if (isHtml && c === '<' && d === '!') {
      const e = text.indexOf('-->', i);
      i = e < 0 ? text.length : e + 2;
      continue;
    }
    if (c === '/' && d === '/') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? text.length : e;
      continue;
    }
    if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i);
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    out += c;
  }
  return out;
}

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

/** معرّفات **الأسطح المخفيّة المعلَنة** (اللوحة المتقدّمة خلف ٦ نقرات) — مُصنَّفة
 *  تصنيفاً صريحاً، لكنها ليست في تبويب ولذلك لا تدخل `MAP_IDS`. */
const HIDDEN_IDS: readonly string[] = SETTINGS_HIDDEN_SURFACES.map((h) => h.id);

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
    // بلا معنى لو كانت الخريطة فارغة. والحدّ **مقيس**: ٣٩ معرّفاً بعد أن خرج
    // `keep-inst`/`fmt-select` إلى الأسطح المخفيّة ودخل `watch-out-kind`.
    expect(MAP_IDS.length, 'عدد المعرّفات في الخريطة').toBeGreaterThanOrEqual(39);
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

/* ── ٣) لا مسار ميت: لا لوحة إعدادات بلا عنصر، ولا نداء إلى عنصر غير موجود ────
 *
 * **العلّة التي وُلد منها**: لوحة «الإعدادات المتقدمة» (`#advanced-panel-container`
 * بـ`.spring-panel`) كانت تُفتح بستّ نقرات على شارة الإصدار، وفيه أربعة عناصر.
 * وبعد نقلها إلى تبويبات الشاشة بقيت **صندوقاً بعنوان بلا عنصر**، وبقي معالج
 * النقر الستّ ينادي عنصراً لا معنى له. وهي «صفحة ميتة»: سطح موجود للمستخدم لا
 * يفعل شيئاً. وحُذف المسار كاملاً (ترميزه في `index.html`، ومعالجه في
 * `src/main.ts`، وأنماطه في `src/styles.css`).
 *
 * **وما يقيسه هذا القسم** (ثلاثة، ولا واحد منها يكفي وحده):
 *   ١) **لا حاوية إعدادات مُعنونة بلا عنصر**: كل عنوان من `SETTINGS_GROUP_HEADING_KEYS`
 *      يجب أن يكون في حاويته **معرّف واحد على الأقل من الخريطة** ⇒ إعادة كتلة
 *      `#advanced-panel` وحدها تُسقطه (عنوان `dlg_advanced` بلا عناصر).
 *   ٢) **لا عنصر للوحة المحذوفة في DOM** ⇒ إعادة الكتلة تُسقطه أيضاً.
 *   ٣) **لا نداء إلى عنصر غير موجود في `src/main.ts`**: كل `getElementById('…')`
 *      فيه يجب أن يجد معرّفه في `index.html` ⇒ إعادة معالج النقر الستّ **وحده**
 *      (ينادي `advanced-panel-container`) تُسقطه، وكذلك أي مسار ميت جديد.
 *      والثلاثة القائمة قبلي معلَنة بالاسم، والقائمة نفسها تُفحَص ضد التقادم.
 */
describe('لا مسار ميت · لا لوحة إعدادات بلا عنصر، ولا نداء إلى عنصر غير موجود', () => {
  it('لا حاوية إعدادات مُعنونة بلا أي معرّف من الخريطة', async () => {
    await mountInSettingsMode();
    // **الالتقاط بالمفتاح لا بالوسم**: `data-i18n` قد يكون على `<h4>` نفسه (وهو
    // حال العناوين الحيّة) وقد يكون على `<span>` داخل العنوان (وهو حال
    // `dlg_advanced` في اللوحة المحذوفة). والالتقاط بـ`h1..h6` وحدها كان **أعمى
    // عن الحالة التي كُتب من أجلها**: مُفسَد «أعِد كتلة اللوحة وحدها» أسقط حارس
    // الوجود في DOM ولم يُسقط هذا. فالصيد الآن بالمفتاح، ثم يُصعد إلى أقرب عنوان.
    const anchors: { key: string; box: HTMLElement | null }[] = [];
    for (const key of SETTINGS_GROUP_HEADING_KEYS) {
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>(`[data-i18n="${key}"]`),
      )) {
        // **وشرط «داخل عنوان» ليس زخرفة**: المفاتيح نفسها تُستعمل **تسمياتٍ لأزرار
        // التبويب** في `#settings-tabs` كذلك (`data-tab-btn="performance"` نصّه
        // `set_group_perf`) — ولو التقيناها لسألنا عن `nav#settings-tabs` هل فيه
        // عنصر من الخريطة، فسقط الحارس على شجرة سليمة (وقع فعلاً: ٤ إنذارات كاذبة).
        // والقاعدة: مفتاح **يُعنوِن** صندوقاً يلزمه عنصر؛ ومفتاح **يُسمّي زرّاً**
        // ليس عنواناً.
        const heading = el.closest<HTMLElement>('h1,h2,h3,h4,h5,h6');
        if (!heading) continue;
        anchors.push({ key, box: heading.parentElement });
      }
    }
    // عدم البطلان: لو حُذفت العناوين كلها لمرّ الفحص بلا معنى.
    expect(anchors.length, 'عناوين مجموعات الإعدادات الموجودة في index.html').toBeGreaterThanOrEqual(6);

    const dead = anchors
      .filter(
        (a) =>
          !a.box ||
          // «معرّف مُصنَّف» = في خريطة التبويبات **أو** سطح مخفيّ مُعلَن (اللوحة
          // المتقدّمة خلف ٦ نقرات) — فالتصريح لا يُسقِط الحارس، وحاويةٌ بلا أي
          // معرّف مُصنَّف تبقى عطباً.
          !Array.from(a.box.querySelectorAll<HTMLElement>('[id]')).some(
            (el) => MAP_IDS.includes(el.id) || HIDDEN_IDS.includes(el.id),
          ),
      )
      .map((a) => {
        const where = a.box
          ? `<${a.box.tagName.toLowerCase()}${a.box.id ? `#${a.box.id}` : ''}>`
          : '(بلا أب)';
        return `${a.key} داخل ${where} بلا أي معرّف مُصنَّف`;
      });
    expect(dead, `لوحات إعدادات ميتة (عنوان بلا عنصر): ${dead.join(' · ')}`).toEqual([]);
  });

  /* اللوحة المتقدّمة: **سطح مقصود** بقرار المالك (٦ نقرات على شارة الإصدار)،
   * لا مسار ميت. وهذا الحارس يقيس ثلاثة أشياء: أنها موجودة، وأنها **هي** الحاملة
   * للمعرّفين المعلَنين، وأنها تُفتح بالنقر الستّ **فعلاً** ولا تُفتح بخمس —
   * فالتصريح لا يصير غطاءً: لو نُقل المعرّف إلى تبويب، أو نُزع المعالج، سقط. */
  it('اللوحة المتقدّمة موجودة، وتحمل المعرّفين المعلَنين، وتُفتح بستّ نقرات لا بخمس', async () => {
    const screen = await mountInSettingsMode();
    expect(screen.settingsScreenIsOn(), 'الشاشة مفتوحة (وضع الإعدادات)').toBe(true);

    const panel = document.getElementById('advanced-panel-container');
    expect(panel, '#advanced-panel-container موجود').not.toBeNull();
    expect(panel!.classList.contains('spring-panel'), 'صنف .spring-panel عليه').toBe(true);
    expect(
      document.querySelector('main')!.contains(panel!),
      'اللوحة داخل <main> (سطح العرض الرئيسي لا شاشة الإعدادات)',
    ).toBe(true);
    // ومطويّة افتراضياً: بلا `.open` لا يُرى محتواها (والنمط في styles.css).
    expect(panel!.classList.contains('open'), 'مطويّة قبل النقر').toBe(false);

    const menu = document.getElementById('settings-menu')!;
    for (const { id, container } of SETTINGS_HIDDEN_SURFACES) {
      const el = document.getElementById(id);
      expect(el, `#${id} موجود`).not.toBeNull();
      expect(
        document.getElementById(container)!.contains(el!),
        `#${id} داخل #${container}`,
      ).toBe(true);
      expect(menu.contains(el!), `#${id} **ليس** في شاشة الإعدادات`).toBe(false);
    }

    // **والفتح مقيس سلوكياً**: النقر على الشارة ستّاً يفتح، وخمساً لا تفتح.
    const { wireHiddenAdvancedPanel } = await import('../hiddenPanel');
    wireHiddenAdvancedPanel();
    const badge = document.getElementById('version-badge')!;
    for (let i = 0; i < 5; i++) badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(panel!.classList.contains('open'), 'خمس نقرات لا تفتح').toBe(false);
    badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(panel!.classList.contains('open'), 'السادسة تفتح').toBe(true);
    // والعدّاد **يُصفَّر عند ٦** (سلوك مسترجَع من `f2114a5^` حرفياً)، فالطيّ يلزمه
    // ستّ نقرات **جديدة** لا واحدة: خمسٌ لا تطوي، والسادسة تطوي.
    for (let i = 0; i < 5; i++) badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(panel!.classList.contains('open'), 'خمس نقرات بعد الفتح لا تطوي').toBe(true);
    badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(panel!.classList.contains('open'), 'وستّ نقرات جديدة تطوي').toBe(false);
  });

  /* **«حول البرنامج» يُعرض مباشرة، لا في مودال** (قرار المالك، جولة settings2):
   * كان زرّ `#btn-about` يفتح `#about-overlay`. والمحتوى انتقل إلى `#about-body`
   * **داخل تبويب «حول البرنامج»**. وهذا الحارس يمنع عودة المودال: لا عنصر
   * `#about-overlay`، ولا زرّ فتح `#btn-about`، و`#about-body` **داخل التبويب**
   * ومملوء فعلاً (‏`fillAbout()` كتبت فيه) — فلا يبقى مودال ولا سطح فارغ. */
  it('لا مودال «حول البرنامج»: المتن داخل تبويبه ومملوء', async () => {
    await mountInSettingsMode();
    expect(document.getElementById('about-overlay'), '#about-overlay').toBeNull();
    expect(document.getElementById('btn-about'), '#btn-about').toBeNull();
    expect(document.getElementById('about-close'), '#about-close').toBeNull();
    expect(document.getElementById('about-ok'), '#about-ok').toBeNull();

    const body = document.getElementById('about-body');
    expect(body, '#about-body موجود').not.toBeNull();
    const panel = document.querySelector('.settings-tab-panel[data-tab="about"]');
    expect(panel, 'تبويب «حول البرنامج» موجود').not.toBeNull();
    expect(panel!.contains(body!), '#about-body **داخل** تبويب about').toBe(true);
    // وفي DOM المشحون هو فارغ (يملؤه `fillAbout()` عند الإقلاع) — فيُقاس أن
    // الملء **يعمل** على هذا الموضع بعينه، لا أن يُدَّعى.
    const { wireAbout } = await import('../aboutUpdate');
    wireAbout();
    expect((body!.textContent || '').trim().length, 'المتن مملوء بعد wireAbout').toBeGreaterThan(20);
    expect(body!.querySelectorAll('[data-open-url]').length, 'روابط الائتمان تعمل في موضعها الجديد').toBeGreaterThan(0);
  });

  it('كل getElementById في src/*.ts يشير إلى معرّف موجود — بلا أي قائمة استثناء', async () => {
    await mountInSettingsMode();
    const files = Object.keys(SRC_MODULES).sort();
    // عدم البطلان: لو لم تُقرأ الوحدات لمرّ الفحص بلا معنى.
    expect(files.length, 'وحدات src/*.ts المقروءة كنصّ').toBeGreaterThanOrEqual(15);
    expect(
      files.some((f) => f.endsWith('/main.ts')),
      'main.ts داخل المسح (وإلا اتّسع النطاق وضاع ما كان محروساً)',
    ).toBe(true);
    expect(files.some((f) => f.endsWith('/queue.ts')), 'queue.ts داخل المسح').toBe(true);

    const missing: string[] = [];
    const perFile: string[] = [];
    let total = 0;
    for (const f of files) {
      const ids = [
        ...new Set(
          [...SRC_MODULES[f].matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
        ),
      ];
      total += ids.length;
      const bad = ids.filter((id) => document.getElementById(id) === null);
      perFile.push(`  ${f.replace('../', '').padEnd(20)} ${String(ids.length).padStart(2)} id(s)${bad.length ? `  MISSING -> ${bad.join(', ')}` : '  all resolve'}`);
      for (const id of bad) missing.push(`${f.replace('../', '')}: ${id}`);
    }
    // eslint-disable-next-line no-console
    console.log('  وحدة                 مسارات');
    for (const r of perFile) {
      // eslint-disable-next-line no-console
      console.log(r);
    }

    // **الحدّ مقيس لا مُدوَّر**: عدد المعرّفات الفريدة التي تُحلّ فعلاً في
    // `src/*.ts` — **١٣٦** بعد جولة settings2 الرابعة (كان ١٣٧): حذف مودال «حول»
    // أزال أربعة مسارات (`about-overlay` · `btn-about` · `about-close` ·
    // `about-ok`)، ونقل اللوحة المتقدّمة إلى `src/hiddenPanel.ts` نقل معرّفين
    // معها، ودخل `watch-out-kind` سطحاً جديداً. ونقصانه يعني أن مساراً أُزيل،
    // فيُحدَّث الرقم عمداً بدل أن يمرّ الفحص بلا معنى.
    expect(total, 'عدد مسارات getElementById المقروءة من src/*.ts').toBeGreaterThanOrEqual(136);

    // **ولا قائمة استثناء** — وكانت هنا واحدة على `main.ts`. وثلاثتها حُذفت
    // (`preview-toggle` · `preview-duration` · `preview-hint`)، **والقائمة معها**:
    // قائمة استثناء تبقى بعد زوال سببها تصير **غطاءً لعطب قادم**. ثم وُسِّع النطاق
    // إلى كل `src/*.ts`، وهو ما كشف `q-wrap` · `quality-select` في `queue.ts`.
    expect(
      missing,
      `مسارات ميتة في src/*.ts (تنادي عناصر غير موجودة في index.html): ${missing.join(' · ')}`,
    ).toEqual([]);
    // **وصفر استثناء** — وهذه ليست زخرفة: بعد إعادة اللوحة المتقدّمة (قرار
    // المالك) صار معرّفها **موجوداً** فحلّ الحارس بلا حاجة إلى قائمة استثناء.
    // ولو أُزيل ترميز اللوحة يوماً لبقي الحارس ساقطاً كما كان. (والحارس على
    // `src/main.ts` وحده لا يكفي: المسح الشامل هو ما كشف `q-wrap` في `queue.ts`.)
    expect(SETTINGS_HIDDEN_SURFACES.length, 'الأسطح المخفيّة مصرَّح بها').toBeGreaterThan(0);
  });

  /* **لا تبويب بلا معرّف**: العلّة التي أُغلقت مرّتين — تبويب معروض ولا شيء فيه.
   * `engine` صار بلا أي معرّف بعد أن أُعيد `#keep-inst`/`#fmt-select` إلى اللوحة
   * المتقدّمة، فحُذف التبويب. وهذا الحارس يمنع عودة الصنف: أي تبويب في
   * `SETTINGS_TABS` بلا معرّف واحد ⇒ يسقط. */
  it('لا تبويب بلا أي معرّف في الخريطة', async () => {
    await mountInSettingsMode();
    const empty: string[] = [];
    const counts: string[] = [];
    for (const tab of SETTINGS_TABS) {
      const n = MAP_IDS.filter((id) => SETTINGS_TAB_MAP[id] === tab).length;
      counts.push(`  ${tab.padEnd(12)} ${n}`);
      if (n === 0) empty.push(tab);
    }
    // eslint-disable-next-line no-console
    console.log('  التبويب       معرّفات');
    for (const c of counts) {
      // eslint-disable-next-line no-console
      console.log(c);
    }
    expect(empty, `تبويبات بلا أي معرّف (تبويب فارغ = عطب): ${empty.join(' · ')}`).toEqual([]);
    // والبنية تُطابقه: زرّ وحاوية لكل تبويب معلَن، ولا تبويب زائد في الترميز.
    const btns = Array.from(document.querySelectorAll<HTMLElement>('[data-tab-btn]')).map((b) => b.dataset.tabBtn);
    const panels = Array.from(document.querySelectorAll<HTMLElement>('.settings-tab-panel')).map((p) => p.dataset.tab);
    expect(btns, 'أزرار التبويب = SETTINGS_TABS').toEqual([...SETTINGS_TABS]);
    expect(panels, 'حاويات التبويب = SETTINGS_TABS').toEqual([...SETTINGS_TABS]);
  });

  /* الأثر المقيس لحذف ربط `#q-wrap`/`#quality-select`: **صفر** — وهذا يقيسه
   * سلوكياً لا بالقراءة. الفرضية أولاً (`المعرّفان غير موجودين`)، ثم الأثر الحيّ
   * الوحيد (`تعتيم #kind-video`) يعمل في الاتجاهين. ولو حُذف التعتيم مع الميت
   * لسقط هذا — وهو إصلاح عطب مسجَّل في `docs/AUDIT.md:243` ولم يكن له حارس. */
  it('updateQualityOptions: الأثر الحيّ (تعتيم #kind-video) يعمل، ولا سطح جودة يُنشأ', async () => {
    await mountInSettingsMode();
    // **الفرضية**: المفتاحان غائبان ⇒ كان `if (!wrap || !sel) return;` يحقّق دائماً
    // ⇒ سلّم الجودة و`sel.replaceChildren` لم يُنفَّذا قطّ.
    expect(document.getElementById('q-wrap'), '#q-wrap').toBeNull();
    expect(document.getElementById('quality-select'), '#quality-select').toBeNull();

    const videoCard = document.getElementById('kind-video');
    expect(videoCard, '#kind-video موجود').not.toBeNull();
    videoCard!.classList.remove('dimmed');

    const { updateQualityOptions } = await import('../queue');
    updateQualityOptions(null); // ملف صوتيّ: لا ارتفاع ⇒ البطاقة تُعتَّم
    expect(videoCard!.classList.contains('dimmed'), 'ملف صوتيّ ⇒ معتمة').toBe(true);
    updateQualityOptions(1080); // فيديو حقيقيّ ⇒ تُرفع العتمة
    expect(videoCard!.classList.contains('dimmed'), 'فيديو ⇒ غير معتمة').toBe(false);

    // ولا يُنشأ سطح جودة من العدم، ولا يُضاف خيار إلى قائمة أخرى.
    expect(document.getElementById('q-wrap'), 'بعد النداء').toBeNull();
    expect(document.getElementById('quality-select'), 'بعد النداء').toBeNull();
    expect(document.querySelectorAll('#kind-video option').length, 'لا خيارات داخل بطاقة النوع').toBe(0);
  });
});

/* ── ٤) لا إعداد بلا سطح، ولا مفتاح ترجمة بلا مستهلك ────────────────────────
 *
 * **الأول** يمنع الصنف الذي جاءت منه هذه الجولة كلها: كان في `Settings` حقلان
 * (`preview` · `preview_seconds`) بلا أي سطح في الواجهة، فكان تحرير
 * `settings.json` يُغيّر ما ينفّذه `pipeline.rs` — **لغم لا ميزة**. ويُقاس بقراءة
 * `pub <field>:` من `src-tauri/src/settings.rs` نصّاً (نفس نمط قراءة `lib.rs`
 * في `settingsScreen.test.ts`).
 *
 * **والثاني** يمنع تراكم نصوص ترجمة لا يعرضها أحد: قياس الجولة الرابعة وجد
 * **٢٧** مفتاحاً بلا مستهلك (٥ منها من جولاتنا، و٢٢ من عهود سابقة) — وحُذفت
 * كلها، وهذا الحارس يمنع عودتها. و«مستهلك» = `data-i18n*` في `index.html` أو
 * ذكر المفتاح في أي وحدة `src/**` **بعد إزالة التعليقات** (وإلا لكفى شرحٌ يذكره
 * ليُبقيه حيّاً)، و`src/i18n.ts` نفسه ليس مستهلكاً لمفاتيحه.
 */
describe('لا إعداد بلا سطح · ولا مفتاح ترجمة بلا مستهلك', () => {
  it('كل حقل في Settings له سطح تحكّم موجود في index.html', async () => {
    await mountInSettingsMode();
    // `pub <field>:` في جسم `struct Settings` وحده.
    const body = settingsRs.slice(
      settingsRs.indexOf('pub struct Settings'),
      settingsRs.indexOf('impl Default for Settings'),
    );
    const fields = [...new Set([...body.matchAll(/^\s*pub\s+([a-z0-9_]+)\s*:/gm)].map((m) => m[1]))];
    expect(fields.length, 'حقول Settings المقروءة من settings.rs').toBeGreaterThanOrEqual(24);

    const declaredNoControl = SETTINGS_FIELDS_WITHOUT_CONTROL.map((x) => x.field);
    const unmapped: string[] = [];
    const missingControl: string[] = [];
    let withControl = 0;
    for (const f of fields) {
      const id = SETTINGS_FIELD_CONTROL[f];
      if (!id) {
        if (!declaredNoControl.includes(f)) unmapped.push(f);
        continue;
      }
      withControl += 1;
      if (document.getElementById(id) === null) missingControl.push(`${f} -> #${id} غير موجود`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `  حقول Settings: ${fields.length} · لها سطح: ${withControl} · بلا سطح مُعلَنة: ${declaredNoControl.length}`,
    );
    expect(
      unmapped,
      `حقول Settings بلا سطح تحكّم وبلا سبب معلَن (أضِفها إلى SETTINGS_FIELD_CONTROL أو SETTINGS_FIELDS_WITHOUT_CONTROL): ${unmapped.join(' · ')}`,
    ).toEqual([]);
    expect(missingControl, `سطح معلَن وغير موجود في index.html: ${missingControl.join(' · ')}`).toEqual([]);
    // وعدم البطلان: الأغلبية لها سطح فعلاً، فلا يمرّ الحارس بقائمة «بلا سطح» ضخمة.
    expect(withControl, 'حقول لها سطح').toBeGreaterThanOrEqual(20);

    // والأسباب مكتوبة فعلاً (لا سطر فارغ يُسكِت الحارس).
    const thin = SETTINGS_FIELDS_WITHOUT_CONTROL.filter((x) => x.why.trim().length < 40);
    expect(thin.map((x) => x.field), 'حقول بلا سطح بسبب غير مقنع').toEqual([]);

    // والاستثناءان مُستعملان: لو حُذف الحقل من الرست صار السبب قديماً ⇒ يُضاف.
    const stale = declaredNoControl.filter((f) => !fields.includes(f));
    expect(stale, `حقول في SETTINGS_FIELDS_WITHOUT_CONTROL لم تبقَ في Settings — أزلها: ${stale.join(' · ')}`).toEqual([]);
  });

  it('كل مفتاح ترجمة له مستهلك واحد على الأقل', async () => {
    await mountInSettingsMode();
    const keys = Object.keys(i18n.ar);
    expect(keys.length, 'مفاتيح جدول ar').toBeGreaterThanOrEqual(200);
    expect(Object.keys(i18n.en).length, 'تساوي en').toBe(keys.length);

    // المستهلكون: index.html (بلا تعليقاته) + كل وحدات src/** عدا جدول الترجمة.
    const sources: { f: string; t: string }[] = [
      { f: 'index.html', t: stripComments(indexHtml, true) },
      ...Object.entries(ALL_SRC_MODULES)
        .filter(([f]) => !f.endsWith('/i18n.ts'))
        .map(([f, t]) => ({ f, t: stripComments(t, false) })),
    ];
    expect(sources.length, 'ملفات المستهلكين المقروءة').toBeGreaterThanOrEqual(15);

    /* ── **المفاتيح المركَّبة**: مساحتا `code.*` و`u.*` تُبنى أسماؤهما وقت التشغيل ──
     *
     * **العطل الذي وُلدت منه هذه القاعدة (مقيس)**: `src/i18n.ts:703` تقرأ
     * `for (const key of [\`code.${code}\`, \`u.${code}\`])` — أي أن **اسم المفتاح
     * يُبنى من رمز يصل من الرست**، فلا يظهر حرفيّاً في أي ملف. فحارسٌ يقيس
     * **الإشارة الحرفيّة** كان يُسقط **١٣ مفتاحاً حيّاً** (`5 code.* + 8 u.*`)
     * بذريعة «يتيم» — وهو **عطل في الحارس لا في الشجرة**.
     *
     * **وهذه ليست قائمة استثناء** (الاستثناء يتقادم ويمرّ صامتاً)، بل **قاعدة
     * مُشتقّة يُتحقّق من مبرّرها آلياً في كل تشغيل**، بثلاثة شروط **كلّها لازمة**:
     *   ① المفتاح له مدخل في **الجدولين** (‏ar وen) — كما هو الشرط القائم.
     *   ② **وله رمزٌ مقابل في الرست، مقروءاً من الملفين لا مُعلَناً بيد**:
     *      `code.<x>` ⇒ `pub const E_<…> = "<x>"` في `bridge.rs` ·
     *      و`u.<x>` ⇒ `pub const U_<…> = "<x>"` في `yt_dlp.rs`.
     *   ③ **وأن يكون حارس التقابل حيّاً**: `src/__tests__/errorTextSurface.test.ts`
     *      موجود **ويقيس الاتجاهين** (`code.*` لكل `E_*` · و`u.*` لكل `U_*`).
     *      فإن غاب أو نُزع قياسه ⇒ **يسقط هذا الحارس**.
     * ⇒ فلا منفذ إخفاء: مفتاح مركَّب **لا يُقبل** إلا ومعه رمزه في الرست ومدخله في
     * الجدولين **وحارسُ تقابلٍ حيّ**. **وأي مفتاح مركّب آخر (لا `code.`/`u.`)
     * يبقى يسقط كما كان** — لأن الفرع أدناه لا يُدخله أصلاً.
     */
    const rustText = `${bridgeRs}\n${ytDlpRs}`;
    const rustCodes = new Set(
      [...rustText.matchAll(/pub const [EU]_[A-Z0-9_]+\s*:\s*&str\s*=\s*"([^"]+)";/g)].map((m) => m[1]),
    );
    // الشرط ③: الحارس المقابل حيّ — يُقرأ نصّه ويُشترط أن يذكر المساحتين وثوابت الرست.
    const counterpartLive =
      /pub const E_/.test(errorTextSurfaceSrc) &&
      /code\./.test(errorTextSurfaceSrc) &&
      /U_/.test(errorTextSurfaceSrc) &&
      /u\./.test(errorTextSurfaceSrc) &&
      /i18n\.(ar|en)/.test(errorTextSurfaceSrc);
    expect(
      counterpartLive,
      'حارس التقابل `errorTextSurface.test.ts` غير حيّ (يقيس `code.*`⇄`E_*` و`u.*`⇄`U_*`) — ' +
        'فالمفاتيح المركَّبة لا يجوز أن تُقبل بلا حارسٍ يقيس تقابلها',
    ).toBe(true);

    const composed: string[] = [];
    const composedNoRustCode: string[] = [];
    const composedNoEn: string[] = [];
    for (const k of keys) {
      const m = /^(code|u)\.(.+)$/.exec(k);
      if (!m) continue;
      composed.push(k);
      if (!rustCodes.has(m[2])) composedNoRustCode.push(k);
      if (!Object.prototype.hasOwnProperty.call(i18n.en, k)) composedNoEn.push(k);
    }
    expect(composedNoEn, `مفاتيح مركَّبة بلا مدخل في جدول en: ${composedNoEn.join(' · ')}`).toEqual([]);
    expect(
      composedNoRustCode,
      `مفاتيح مركَّبة بلا رمز مقابل في الرست (‏pub const E_*/U_* في bridge.rs/yt_dlp.rs): ${composedNoRustCode.join(' · ')}`,
    ).toEqual([]);

    /* **والاتجاه الثاني — وهو ما يمنع «قاعدةً » فارغة**: لو حُذف مفتاح من الجدولين
     * مع بقاء رمزه في الرست، كان الفرع أعلاه **لا يراه** (لأنه يمسح مفاتيح الجدول
     * لا رموز الرست) فيمرّ الحارس كذباً. **وقد وقع هذا فعلاً في مُفسَدي الأول**:
     * حذفتُ `'code.bad_input'` من الجدولين فبقي `14 passed` — أي أن القاعدة كانت
     * تُقاس في اتجاه واحد. فالآن يُقاس **التقابل في الاتجاهين**، ومعه **ضابطان
     * للحدّين**: لكل مساحة رمزٌ في الرست، وله مدخلٌ في الجدولين. */
    const tableCodes = new Set(
      Object.keys(i18n.ar).filter((k) => /^(code|u)\./.test(k)).map((k) => k.replace(/^(code|u)\./, '')),
    );
    const rustOnly: string[] = [...rustCodes].filter((c) => !tableCodes.has(c));
    expect(
      rustOnly,
      `رموز في الرست بلا مدخل في الجدولين (تُعرض عندها بالعربية الخام في واجهة إنجليزية): ${rustOnly.join(' · ')}`,
    ).toEqual([]);
    // وضابطان: المساحتان ليستا فارغتين، ولا واحدة منهما ابتلعت الأخرى.
    expect([...rustCodes].filter((c) => c === 'duplicate_link').length, 'رمز E_ معروف في الرست').toBe(1);
    expect(tableCodes.size, 'رموز مقابلة في الجداول').toBeGreaterThanOrEqual(10);
    expect(rustCodes.size, 'رموز E_*/U_* المقروءة من الرست').toBeGreaterThanOrEqual(tableCodes.size);
    // وضابط: القاعدة مُستعملة فعلاً — لو صارت صفر مفتاح لكانت شرطاً ميتاً يمرّ كذباً.
    expect(composed.length, 'مفاتيح مركَّبة مقبولة بهذه القاعدة').toBeGreaterThanOrEqual(10);

    const orphans: string[] = [];
    for (const k of keys) {
      if (composed.includes(k)) continue; // قاعدتها أعلاه مُشتقّة ومُتحقَّق منها
      const re = new RegExp(`(^|[^A-Za-z0-9_])${k}([^A-Za-z0-9_]|$)`);
      if (!sources.some((s) => re.test(s.t))) orphans.push(k);
    }
    expect(
      orphans,
      `مفاتيح ترجمة بلا مستهلك (لا data-i18n في index.html ولا ذكر في src/** بعد إزالة التعليقات): ${orphans.join(' · ')}`,
    ).toEqual([]);
  });
});
