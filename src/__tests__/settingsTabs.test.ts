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
  SETTINGS_GROUP_HEADING_KEYS,
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
          !Array.from(a.box.querySelectorAll<HTMLElement>('[id]')).some((el) =>
            MAP_IDS.includes(el.id),
          ),
      )
      .map((a) => {
        const where = a.box
          ? `<${a.box.tagName.toLowerCase()}${a.box.id ? `#${a.box.id}` : ''}>`
          : '(بلا أب)';
        return `${a.key} داخل ${where} بلا أي معرّف من الخريطة`;
      });
    expect(dead, `لوحات إعدادات ميتة (عنوان بلا عنصر): ${dead.join(' · ')}`).toEqual([]);
  });

  it('لا عنصر للوحة المحذوفة في DOM (ولا صنفها)', async () => {
    await mountInSettingsMode();
    expect(document.getElementById('advanced-panel'), 'element #advanced-panel').toBeNull();
    expect(
      document.getElementById('advanced-panel-container'),
      'element #advanced-panel-container',
    ).toBeNull();
    expect(
      document.querySelectorAll('.spring-panel, .spring-panel-content').length,
      'عناصر .spring-panel في DOM',
    ).toBe(0);
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
    // `src/*.ts` (‏مقيس 2026-09-25 بعد تنظيف الجولتين الثالثة والرابعة: ١٣٧).
    // ونقصانه يعني أن مساراً أُزيل، فيُحدَّث الرقم عمداً بدل أن يمرّ الفحص بلا معنى.
    expect(total, 'عدد مسارات getElementById المقروءة من src/*.ts').toBeGreaterThanOrEqual(137);

    // **ولا قائمة استثناء** — وكانت هنا واحدة على `main.ts`. وثلاثتها حُذفت
    // (`preview-toggle` · `preview-duration` · `preview-hint`)، **والقائمة معها**:
    // قائمة استثناء تبقى بعد زوال سببها تصير **غطاءً لعطب قادم**. ثم وُسِّع النطاق
    // إلى كل `src/*.ts`، وهو ما كشف `q-wrap` · `quality-select` في `queue.ts`.
    expect(
      missing,
      `مسارات ميتة في src/*.ts (تنادي عناصر غير موجودة في index.html): ${missing.join(' · ')}`,
    ).toEqual([]);
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
