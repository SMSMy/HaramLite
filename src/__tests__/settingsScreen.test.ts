/* ── شاشة الإعدادات **داخل نافذة التطبيق**: الحرّاس ────────────────────────
 *
 * قرار المالك النهائي (2026-09-24): **إلغاء النافذة المستقلة** — فقد صارت هي
 * **نافذة العملية الرئيسية** (`MainWindowTitle = "HaramLite — الإعدادات"`)،
 * وبيضاء، و**بقيت عالقة بعد إغلاق التطبيق** حتى أُنهيت عملياته يدوياً
 * (`HaramLite = 0`). والإعدادات الآن **شاشة داخل النافذة الواحدة**.
 *
 * **وما يقيسه هذا الملف**:
 *   ١) **الزرّ يبدّل إلى وضع الإعدادات**، والشاشة تُعرض بتبويباتها السبعة
 *      (المعروض واحد بالضبط) — والمقياس **قيمةُ الوضع** من الوحدة لا الباني.
 *   ٢) **زرّ الرجوع** يُعيد العرض الرئيسي ويُخفي الشاشة، **والحالة محفوظة**:
 *      التبويب المختار يعود كما كان، وقيمةٌ في حقل لم تُحفظ لا تُفقد.
 *   ٣) **التكافؤ بالعدّ**: كل عنصر كان في القائمة القديمة موجود في الشاشة —
 *      «N من N» (‏61 من 61)، ويسقط إن نقص واحد.
 *   ٤) **لا نافذة ثانية**: تُقرأ `src-tauri/src/lib.rs` وملف القدرة **بنصّهما
 *      المشحون** فلا يبقى باني نافذة في الإنتاج ولا لابل `settings` ولا أمر
 *      `open_settings`، والقدرة على `main` وحدها.
 *   ٥) **ولا قراءة لابل نافذة إطلاقاً** في وحدة الشاشة (المصدر حالة داخلية).
 *
 * **ما لا يقيسه** (بصراحة): لا يشغّل نافذة WebView2 حقيقية ولا يرسم — فدورة حياة
 * العملية (صفر نافذة عالقة بعد الإنهاء) تُقاس على الثنائي المدموج في التسليم
 * الكامل بالأمر المذكور في التقرير (§١٣). وهنا **بنية DOM ونصّ الشيفرة
 * المشحونين**، لا نسخة منهما.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';
import libRs from '../../src-tauri/src/lib.rs?raw';
import capJson from '../../src-tauri/capabilities/default.json?raw';
import screenTs from '../settingsScreen.ts?raw';
import { SETTINGS_TAB_MAP } from '../settingsTabMap';
// **استيراد نوعيّ محض** (يُمحى في البناء): قائمة التبويبات تُشتقّ من المصدر
// الواحد بدل نسخة نصّية رابعة تتقادم بصمت — وكانت هنا كذلك حتى الدمج.
import type { SettingsTab } from '../settingsScreen';

const h = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => ({})),
  listeners: new Map<string, (ev: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (ev: { payload: unknown }) => void) => {
    h.listeners.set(name, cb);
    return () => {};
  }),
}));

/** DOM التطبيق المشحون (بلا تنفيذ سكربتات: `innerHTML` لا يُنفّذ `script`). */
function mountApp(): void {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
  document.body.className = '';
}

/**
 * **جرد التكافؤ** — كل عنصر تحكّم كان في القائمة المنسدلة، بمجموعاته.
 * والقائمة **مكتوبة صراحةً** (لا تُشتقّ من الصفحة) — وإلا لكان الحارس يقرأ ما
 * يقيسه فيمرّ دائماً: المُفسَد المراد كشفه هو **نقص عنصر من الشاشة**.
 */
const REQUIRED: ReadonlyArray<readonly [string, readonly string[], string?]> = [
  [
    'الأداء (cuda + hint + سقف الفصول)',
    ['setting-cuda', 'cuda-hint', 'cuda-hint-text', 'max-jobs'],
    'performance',
  ],
  ['الفصل والمزوّد', ['cuda-provider'], 'engine'],
  [
    'المراقبة التلقائية',
    [
      'setting-watch',
      'watch-options',
      'watch-mode',
      'watch-path',
      'watch-max-size',
      'btn-watch-folder',
      'btn-watch-cancel',
      'watch-rescan',
      'watch-status',
    ],
  ],
  ['الجسر', ['setting-bridge', 'bridge-ext-status', 'bridge-ext-link']],
  [
    'تيليغرام',
    [
      'btn-telegram',
      'tg-badge',
      'tg-group-mode',
      'tg-bot-identity',
      'tg-identity-note',
      'tg-set-commands',
      'tg-commands-note',
      'tg-stats',
      'tg-stats-body',
    ],
  ],
  [
    'التحديث والصيانة',
    [
      'setting-autostart',
      'setting-notify',
      'btn-update-check',
      'update-status',
      'btn-update-download',
      'setting-ytdlp-auto',
      'btn-upd-ytdlp',
      'ytdlp-auto-status',
      'ytdlp-local-version',
      'btn-repair-open',
    ],
  ],
  ['عن البرنامج', ['btn-report', 'btn-about']],
];

/** المجموعات المطلوبة **خارج** الحاوية: لوحة تلغرام والإصلاح وزرّ اللغة. */
const OUTSIDE: readonly string[] = [
  'tg-overlay',
  'tg-close',
  'tg-ok',
  'tg-token',
  'tg-owner',
  'tg-api-id',
  'tg-api-hash',
  'tg-local-url',
  'tg-audio-only',
  'tg-pair-row',
  'tg-pair-code',
  'tg-pair-new',
  'tg-pair-copy',
  'tg-pair-hint',
  'tg-status',
  'repair-overlay',
  'repair-list',
  'repair-all',
  'repair-cancel',
  'repair-close',
  'repair-progress',
  'repair-result',
  'lang-toggle',
];

const ALL_REQUIRED: readonly string[] = [
  ...REQUIRED.flatMap(([, ids]) => ids),
  ...OUTSIDE.filter((id) => !REQUIRED.some(([, ids]) => ids.includes(id))),
];

// **والقائمة تُشتقّ من الخريطة المعلَنة**، فلا تُكتب التبويبات مرّتين في هذا
// الملف (كانت مكتوبة نصّاً فبقيت سبعة بعد أن صارت في الشجرة سبعة فعلاً — والنسخة
// النصّية هي أول ما يتقادم). والترتيب يأتي من ترتيب المفاتيح في الخريطة، ووجوده
// في واجهة المستخدم يقيسه `settingsTabs.test.ts` مقابل `[data-tab-btn]` الحقيقي.
const TABS: readonly SettingsTab[] = [...new Set(Object.values(SETTINGS_TAB_MAP))];

/**
 * **التبويب المتوقَّع لمعرّفات محدّدة** — فلا يكفي أن يكون العنصر «في الشاشة»،
 * بل **في تبويبه المُعلَن**. وهذا توسيعٌ **مقصود لا حصر** (المطلوب الكامل: كل
 * معرّف بتبويبه)، ويكفي لكشف الخطأ الذي وقع فعلاً: `#max-jobs` كان في `engine`
 * والمتوقَّع `performance` — **مقيس** بـ`closest('.settings-tab-panel').dataset.tab`.
 * **مُفسَده**: نقل أيّ معرّف هنا إلى تبويب آخر ⇒ يسقط.
 *
 * ⚠ **وثلاثة أسطر من هذا الجدول صُحّحت في الدمج (لا نُقلت كما هي)**، لأن الفرع
 * المدموج كان مبنيّاً على `5e5ce0f` **قبل** `10d8dfa` الذي نقل أربعة عناصر:
 * `#cuda-provider` · `#setting-notify` · `#btn-report` (و`#max-jobs`). والقياس
 * الحرفي قبل التصحيح من `pnpm test:web`:
 * `عناصر في غير تبويبها: cuda-provider: متوقَّع engine · مقيس performance ·
 *  setting-notify: متوقَّع update · مقيس performance ·
 *  btn-report: متوقَّع about · مقيس update`.
 * ⇒ القيم هنا الآن **مطابقة للخريطة المعلَنة** في `src/settingsTabMap.ts`،
 * ويُشترَط ذلك صراحةً في الحارس أدناه (فلا يعود جدولٌ ثانٍ يكذب في صمت).
 */
const EXPECTED_TAB: Record<string, string> = {
  'setting-cuda': 'performance',
  'cuda-hint': 'performance',
  'cuda-hint-text': 'performance',
  'max-jobs': 'performance',
  'cuda-provider': 'performance',
  'setting-watch': 'watch',
  'watch-options': 'watch',
  'setting-bridge': 'bridge',
  'btn-telegram': 'telegram',
  'tg-group-mode': 'telegram',
  'setting-autostart': 'update',
  'setting-notify': 'performance',
  'btn-repair-open': 'update',
  'btn-report': 'update',
  'btn-about': 'about',
};

/** يركّب DOM ويربط الشاشة (والوضع الأوّلي من الـhash — بديل الاختبار). */
async function mount(initialHash = ''): Promise<typeof import('../settingsScreen')> {
  mountApp();
  const url = new URL(window.location.href);
  url.hash = initialHash;
  window.history.replaceState({}, '', url.toString());
  const screen = await import('../settingsScreen');
  screen.wireSettingsScreen();
  return screen;
}

beforeEach(() => {
  h.invoke.mockClear();
  h.listeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '';
  document.body.className = '';
});

/* ── ١) الزرّ يبدّل إلى وضع الإعدادات، والشاشة تُعرض بتبويباتها ───────────── */
describe('شاشة الإعدادات داخل النافذة · تُفتح بالزرّ', () => {
  it('النقر على #btn-settings يبدّل الوضع ويُظهر الشاشة وتبويباً واحداً', async () => {
    const screen = await mount();
    expect(screen.settingsScreenIsOn(), 'قبل: الوضع مطفأ (التطبيق يبدأ على العرض الرئيسي)').toBe(
      false,
    );
    const container = document.getElementById('settings-menu')!;
    expect(container.classList.contains('hidden'), 'قبل: الشاشة مخفيّة').toBe(true);

    const { wireSettings } = await import('../settingsPanel');
    wireSettings();
    document
      .getElementById('btn-settings')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // **المقياس قيمةُ الوضع** (لا وجود باني نافذة)، ويوافقه الـDOM:
    expect(screen.settingsScreenIsOn(), 'بعد: الوضع مُعلَن في الوحدة').toBe(true);
    expect(document.body.classList.contains('settings-mode'), 'و`main` تُخفى به').toBe(true);
    expect(container.classList.contains('hidden'), 'والشاشة ظاهرة').toBe(false);
    const panels = Array.from(document.querySelectorAll<HTMLElement>('.settings-tab-panel'));
    expect(panels.map((p) => p.dataset.tab)).toEqual(TABS);
    expect(panels.filter((p) => !p.hidden).length, 'تبويب واحد معروض').toBe(1);
    expect(document.querySelectorAll('[data-tab-btn]').length, 'سبعة أزرار تبويب').toBe(
      TABS.length,
    );
    // **ولا نافذة ثانية تُطلب**: الزرّ لا ينادي أي أمر نوافذ.
    expect(
      h.invoke.mock.calls.filter(
        (c) => String(c[0]).includes('window') || c[0] === 'open_settings',
      ).length,
      'لا نداء فتح نافذة',
    ).toBe(0);
  });

  it('النقر على تبويب يُظهر حاويته وحدها', async () => {
    const screen = await mount();
    screen.openSettingsScreen();
    const watchBtn = document.querySelector<HTMLElement>('[data-tab-btn="watch"]')!;
    watchBtn.click();
    const shown = Array.from(document.querySelectorAll<HTMLElement>('.settings-tab-panel')).filter(
      (p) => !p.hidden,
    );
    expect(shown.map((p) => p.dataset.tab)).toEqual(['watch']);
    expect(watchBtn.getAttribute('aria-selected')).toBe('true');
    expect(
      document
        .querySelector<HTMLElement>('[data-tab="watch"]')!
        .contains(document.getElementById('setting-watch')),
    ).toBe(true);
  });
});

/* ── ٢) زرّ الرجوع: يعيد العرض الرئيسي والحالة محفوظة ─────────────────────── */
describe('زرّ الرجوع · يعيد العرض الرئيسي ولا يفقد الحالة', () => {
  it('النقر على #settings-close يطفئ الوضع ويُخفي الشاشة، والتبويب يبقى محفوظاً', async () => {
    const screen = await mount('#settings'); // بديل الاختبار للوضع الأوّلي
    expect(screen.settingsScreenIsOn(), 'الوضع الأوّلي من الـhash').toBe(true);

    // يختار المستخدم تبويباً غير الأوّل، ويكتب قيمة في حقل لم تُحفظ بعد.
    document.querySelector<HTMLElement>('[data-tab-btn="telegram"]')!.click();
    expect(screen.settingsScreenTab()).toBe('telegram');
    const token = document.getElementById('tg-token') as HTMLInputElement | null;
    if (token) token.value = 'قيمة-غير-محفوظة';

    // الرجوع:
    document.getElementById('settings-close')!.dispatchEvent(new MouseEvent('click'));
    expect(screen.settingsScreenIsOn(), 'بعد: الوضع مطفأ').toBe(false);
    expect(document.body.classList.contains('settings-mode'), 'و`main` تعود').toBe(false);
    expect(
      document.getElementById('settings-menu')!.classList.contains('hidden'),
      'والشاشة مخفيّة',
    ).toBe(true);

    // **والحالة محفوظة**: العودة تُظهر نفس التبويب (لا تُصفّره إلى الأوّل)،
    // والقيمة التي لم تُحفظ باقية (لا إخفاء نافذة ولا تدمير).
    screen.openSettingsScreen();
    expect(screen.settingsScreenTab(), 'التبويب المختار محفوظ').toBe('telegram');
    const shown = Array.from(document.querySelectorAll<HTMLElement>('.settings-tab-panel')).filter(
      (p) => !p.hidden,
    );
    expect(shown.map((p) => p.dataset.tab), 'والمعروض هو المحفوظ').toEqual(['telegram']);
    if (token) expect(token.value, 'وقيمة الحقل لم تُفقد').toBe('قيمة-غير-محفوظة');
  });
});

/* ── ٣) التكافؤ بالعدّ: N من N ────────────────────────────────────────────── */
describe('تكافؤ الشاشة · كل عنصر في القائمة القديمة موجود في الشاشة', () => {
  it('يُعدّ العناصر ويطبع N من N — ويسقط إن نقص واحد', async () => {
    await mount('#settings');
    const screen = document.getElementById('settings-menu')!;
    const missing: string[] = [];
    for (const id of ALL_REQUIRED) {
      const el = document.getElementById(id);
      if (!el) missing.push(id);
      else if (!screen.contains(el) && !document.body.contains(el)) missing.push(`${id}(خارج)`);
    }
    expect(missing, `عناصر غائبة عن الشاشة: ${missing.join(' · ')}`).toEqual([]);

    let n = 0;
    for (const [group, ids] of REQUIRED) {
      const found = ids.filter((id) => document.getElementById(id) !== null);
      // eslint-disable-next-line no-console
      console.log(`  ${group}: ${found.length} من ${ids.length}`);
      expect(found.length, `مجموعة «${group}»`).toBe(ids.length);
      n += ids.length;
    }
    const outsideFound = OUTSIDE.filter((id) => document.getElementById(id) !== null).length;
    // **والتبويب المتوقَّع** (لا مجرّد الوجود): كل معرّف في `EXPECTED_TAB` يجب أن
    // يكون في تبويبه المُعلَن — وهو ما يكشف خطأ التقسيم (`#max-jobs`).
    //
    // **وشرطان يمنعان جدولاً ثانياً يكذب بصمت** (وهو ما وقع في الدمج: جاء الجدول
    // من فرع مبنيّ على شجرة أقدم، فخالف الخريطة المعلَنة في ثلاثة معرّفات):
    //   ① كل مفتاح في `EXPECTED_TAB` **معلَن** في `SETTINGS_TAB_MAP`،
    //   ② وقيمته فيه **مطابقة** لقيمة الخريطة — فلا مصدران للحقيقة يفترقان.
    const notDeclared: string[] = [];
    const disagree: string[] = [];
    for (const [id, tab] of Object.entries(EXPECTED_TAB)) {
      const declared = SETTINGS_TAB_MAP[id];
      if (declared === undefined) notDeclared.push(id);
      else if (declared !== tab) disagree.push(`${id}: هنا «${tab}» وفي الخريطة «${declared}»`);
    }
    expect(
      notDeclared,
      `معرّفات في الجدول وغير معلَنة في src/settingsTabMap.ts: ${notDeclared.join(' · ')}`,
    ).toEqual([]);
    expect(
      disagree,
      `جدولان يفترقان عن الخريطة المعلَنة: ${disagree.join(' · ')}`,
    ).toEqual([]);
    const misplaced: string[] = [];
    for (const [id, tab] of Object.entries(EXPECTED_TAB)) {
      const el = document.getElementById(id);
      if (!el) continue; // غيابه يُكشف أعلاه
      const got = el.closest<HTMLElement>('.settings-tab-panel')?.dataset.tab ?? '(خارج التبويبات)';
      if (got !== tab) misplaced.push(`${id}: متوقَّع ${tab} · مقيس ${got}`);
    }
    expect(misplaced, `عناصر في غير تبويبها: ${misplaced.join(' · ')}`).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`التبويب المتوقَّع: ${Object.keys(EXPECTED_TAB).length} معرّفاً في تبويبها الصحيح`);
    // eslint-disable-next-line no-console
    console.log(`تكافؤ شاشة الإعدادات: ${n + outsideFound} من ${ALL_REQUIRED.length}`);
    expect(n + outsideFound, 'N من N').toBe(ALL_REQUIRED.length);
  });
});

/* ── ٤) لا نافذة ثانية: قياس بنيوي على الشيفرة المشحونة ───────────────────── */
describe('لا نافذة ثانية · النافذة واحدة والوضع من حالة داخلية', () => {
  it('الإنتاج لا يبني نافذة، ولا لابل `settings`، والقدرة على main وحدها', async () => {
    const cap = JSON.parse(capJson) as { windows: string[] };
    expect(cap.windows, 'قدرة نافذة واحدة (لا `settings`)').toEqual(['main']);
    // **ولا باني نافذة في الإنتاج**: `WebviewWindowBuilder` لا يبقى إلا في
    // اختبارات الرست (نافذة `main` المصنوعة للقياس) — فيُحكم بحدّ الشيفرة.
    const prodPart = libRs.split('#[cfg(test)]')[0];
    expect(
      prodPart.includes('WebviewWindowBuilder'),
      'لا بناء نافذة في شيفرة الإنتاج (المسار الثاني أُزيل)',
    ).toBe(false);
    expect(prodPart.includes('"settings"'), 'ولا لابل `settings` في الإنتاج').toBe(false);
    expect(
      prodPart.includes('fn open_settings'),
      'ولا أمر `open_settings` (صار تبديل وضع داخل النافذة)',
    ).toBe(false);
  });

  it('وحدة الشاشة لا تقرأ لابل نافذة إطلاقاً (المصدر حالة داخلية)', () => {
    for (const forbidden of [
      'getCurrentWebviewWindow',
      'getCurrentWindow',
      'currentWindowLabel',
      '__TAURI_INTERNALS__',
    ]) {
      expect(
        screenTs.includes(forbidden),
        `الوحدة لا تذكر «${forbidden}» — الوضع من حالة داخلية لا من لابل`,
      ).toBe(false);
    }
  });
});
