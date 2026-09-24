/* ── شاشة الإعدادات في نافذتها المستقلة: أربعة حرّاس ────────────────────────
 *
 * قرار المالك (2026-09-23): «القائمة المنسدلة أصبحت طويلة» ⇒ **نافذة مستقلة**
 * فيها **شاشة كاملة** بسبعة تبويبات. وهذا الملف يقيس الأربعة التي طُلب قياسها:
 *
 *   ١) **تُفتح**: في وضع نافذة الإعدادات تظهر الشاشة (`#settings-menu` بلا
 *      `hidden`، و`body.settings-mode`) **ويُعرض تبويب واحد** من السبعة
 *      (`hidden` على البقية) — فالتبويبات تعمل لا تُزيّن.
 *   ٢) **التكافؤ بالعدّ**: كل عنصر تحكّم كان في القائمة المنسدلة **موجود في
 *      الشاشة** — يُعدّ ويُطبع «N من N»، ويسقط إن نقص واحد.
 *   ٣) **أثر التغيير في الرئيسية (مصدر حالة واحد)**: تغيير قيمة في الشاشة يمرّ
 *      من **مسار الدفع القائم** (`set_settings`)، وحدث `settings-changed`
 *      القائم يعيد القيمة إلى نفس العنصر — فليس للشاشة مخزن ثانٍ.
 *   ٤) **لا مسار ثانٍ**: في النافذة الرئيسية **لا تُعرض الشاشة أبداً**، وزرّ
 *      الإعدادات ينادي `open_settings` (يفتح نافذة) **ولا يُظهر الحاوية** —
 *      فالمقياس على **المعنى** (نافذة تُفتح · لا قائمة تُفتح) لا على المعرّف.
 *
 * **ما لا يقيسه** (بصراحة): لا يشغّل نافذة WebView2 حقيقية ولا يرسم — فتحُ
 * النافذة فعلاً يقيسه في الرست
 * `open_settings_creates_the_settings_window_over_ipc_and_reuses_it` (عبر IPC
 * و`mock_runtime`، ثم تُفحَص النافذة نفسها). وهنا **بنية DOM على `index.html`
 * المشحون نفسه** (‏`?raw`)، لا نسخة منه.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => ({})),
  listeners: new Map<string, (ev: { payload: unknown }) => void>(),
  label: { value: null as string | null },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (ev: { payload: unknown }) => void) => {
    h.listeners.set(name, cb);
    return () => {};
  }),
}));
// اللابل يُستبدل عند الحدّ: الشاشة تقرؤه من الواجهة الرسمية، والاختبار يقرّر
// أيّ نافذة نحن (وإلا لم يُقَس الوضعان معاً).
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: h.label.value }),
}));

/** DOM التطبيق المشحون (بلا تنفيذ سكربتات: `innerHTML` لا يُنفّذ `script`). */
function mountApp(): void {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
  document.body.className = '';
}

/**
 * **جرد التكافؤ** — كل عنصر تحكّم كان في القائمة المنسدلة، بمجموعاته الأربع
 * عشرة. والقائمة **مكتوبة صراحةً** (لا تُشتقّ من الصفحة) — وإلا لكانت الحارس
 * يقرأ ما يقيسه فيمرّ دائماً: المُفسَد المراد كشفه هو **نقص عنصر من الشاشة**.
 */
const REQUIRED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['الأداء (cuda + hint + سقف الفصول)', ['setting-cuda', 'cuda-hint', 'cuda-hint-text', 'max-jobs']],
  ['الفصل والمزوّد', ['cuda-provider']],
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
  'btn-report',
  'btn-about',
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

/** كل المعرّفات المطلوبة (المجموعتان) — بها يُعلن «N من N». */
const ALL_REQUIRED: readonly string[] = [
  ...REQUIRED.flatMap(([, ids]) => ids),
  ...OUTSIDE.filter((id) => !REQUIRED.some(([, ids]) => ids.includes(id))),
];

const TABS = ['performance', 'engine', 'watch', 'bridge', 'telegram', 'update', 'about'];

/** يركّب DOM ويطبّق وضع نافذة الإعدادات عبر كود الإنتاج نفسه. */
async function mountSettingsWindow(): Promise<void> {
  mountApp();
  h.label.value = 'settings';
  const { wireSettingsScreen } = await import('../settingsScreen');
  wireSettingsScreen();
}

/** يركّب DOM ويطبّق وضع النافذة الرئيسية. */
async function mountMainWindow(): Promise<void> {
  mountApp();
  h.label.value = 'main';
  const { wireSettingsScreen } = await import('../settingsScreen');
  wireSettingsScreen();
}

beforeEach(() => {
  h.invoke.mockClear();
  h.listeners.clear();
  h.label.value = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '';
  document.body.className = '';
});

/* ── ١) تُفتح: الشاشة ظاهرة وتبويب واحد معروض ─────────────────────────────── */
describe('شاشة الإعدادات · تُفتح في نافذتها وتُبدَّل تبويباتها', () => {
  it('في نافذة settings: الشاشة ظاهرة وسبعة تبويبات لسبع حاويات، والمعروض واحد', async () => {
    await mountSettingsWindow();
    const screen = document.getElementById('settings-menu');
    expect(screen, '#settings-menu موجود في index.html').not.toBeNull();
    expect(screen!.classList.contains('hidden'), 'الشاشة ظاهرة في نافذتها').toBe(false);
    expect(document.body.classList.contains('settings-mode'), 'وضع الشاشة مُعلَن على body').toBe(
      true,
    );

    const btns = Array.from(document.querySelectorAll('[data-tab-btn]'));
    const panels = Array.from(document.querySelectorAll('.settings-tab-panel'));
    expect(btns.map((b) => (b as HTMLElement).dataset.tabBtn)).toEqual(TABS);
    expect(panels.map((p) => (p as HTMLElement).dataset.tab)).toEqual(TABS);
    // **والمعروض واحد بالضبط**: البقية `hidden` — فالتبويبات تعمل لا تُزيّن.
    const shown = panels.filter((p) => !(p as HTMLElement).hidden);
    expect(shown.length, 'تبويب واحد معروض').toBe(1);
    expect((shown[0] as HTMLElement).dataset.tab).toBe('performance');
    expect(
      btns.filter((b) => b.getAttribute('aria-selected') === 'true').length,
      'زرّ واحد مُعلَن نشطاً',
    ).toBe(1);
  });

  it('النقر على تبويب يُظهر حاويته وحدها', async () => {
    await mountSettingsWindow();
    const watchBtn = document.querySelector<HTMLElement>('[data-tab-btn="watch"]')!;
    watchBtn.click();
    const shown = Array.from(document.querySelectorAll<HTMLElement>('.settings-tab-panel')).filter(
      (p) => !p.hidden,
    );
    expect(shown.map((p) => p.dataset.tab)).toEqual(['watch']);
    expect(watchBtn.getAttribute('aria-selected')).toBe('true');
    // والعناصر داخل التبويب المعروض هي عناصر التحكّم الحقيقيّة (لا نسخة).
    const panel = document.querySelector<HTMLElement>('[data-tab="watch"]')!;
    expect(panel.contains(document.getElementById('setting-watch'))).toBe(true);
    expect(panel.contains(document.getElementById('btn-watch-folder'))).toBe(true);
  });
});

/* ── ٢) التكافؤ بالعدّ: N من N ────────────────────────────────────────────── */
describe('تكافؤ الشاشة · كل عنصر في القائمة القديمة موجود في الشاشة', () => {
  it('يُعدّ العناصر ويطبع N من N — ويسقط إن نقص واحد', async () => {
    await mountSettingsWindow();
    const missing: string[] = [];
    const outsideScreen: string[] = [];
    const screen = document.getElementById('settings-menu')!;
    for (const id of ALL_REQUIRED) {
      const el = document.getElementById(id);
      if (!el) missing.push(id);
      else if (!screen.contains(el) && !document.body.contains(el)) outsideScreen.push(id);
    }
    expect(missing, `عناصر غائبة عن الشاشة: ${missing.join(' · ')}`).toEqual([]);
    expect(outsideScreen, `عناصر خارج الصفحة: ${outsideScreen.join(' · ')}`).toEqual([]);

    // **والعدّ لكل مجموعة** — يُطبع ليكون دليلاً حيّاً (‏`--reporter=verbose`).
    let n = 0;
    for (const [group, ids] of REQUIRED) {
      const found = ids.filter((id) => document.getElementById(id) !== null);
      // eslint-disable-next-line no-console
      console.log(`  ${group}: ${found.length} من ${ids.length}`);
      expect(found.length, `مجموعة «${group}»`).toBe(ids.length);
      n += ids.length;
    }
    const outsideFound = OUTSIDE.filter(
      (id) => document.getElementById(id) !== null && !ALL_REQUIRED.slice(0, n).includes(id),
    ).length;
    // eslint-disable-next-line no-console
    console.log(
      `تكافؤ شاشة الإعدادات: ${n + outsideFound} من ${ALL_REQUIRED.length} (خمسة عشر في الحاوية القائمة · إصلاح · تلغرام · اللغة)`,
    );
    expect(n + outsideFound, 'N من N').toBe(ALL_REQUIRED.length);
  });
});

/* ── ٣) مصدر حالة واحد: تغيير في الشاشة يبلغ الرئيسية ─────────────────────── */
describe('مصدر حالة واحد · الشاشة تكتب من مسار الدفع القائم', () => {
  it('تغيير #max-jobs في الشاشة يُدفع إلى الخلف، وحدث settings-changed يعيده', async () => {
    vi.useFakeTimers();
    await mountSettingsWindow();
    const { wireSettings } = await import('../settingsPanel');
    wireSettings();

    const select = document.getElementById('max-jobs') as HTMLSelectElement;
    expect(select, '#max-jobs موجود').not.toBeNull();
    select.value = '2';
    select.dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(400); // مهلة الدفع 300ms (قائمة)

    const pushed = h.invoke.mock.calls.find((c) => c[0] === 'set_settings');
    expect(pushed, 'الشاشة تدفع عبر set_settings القائم (لا مخزن ثانٍ)').toBeTruthy();
    // الشكل من `settings.ts:144` نفسه: `invoke('set_settings', { value: ... })`،
    // والحقل باسم عقد Rust (`max_concurrent_jobs`) لا باسم خزين الواجهة.
    const payload = (pushed![1] as { value?: { max_concurrent_jobs?: number } }).value;
    expect(payload?.max_concurrent_jobs, 'القيمة الجديدة بلغت الخلف').toBe(2);

    // **والرئيسية تتبع الحدث القائم**: نفس المستمع يعيد القيمة إلى العنصر.
    // والحِمل بأسماء **عقد Rust** (`max_concurrent_jobs`) كما يرسله الخلف —
    // لا بأسماء خزين الواجهة، وإلا لقيس الاختبار حملاً لا وجود له.
    const listener = h.listeners.get('settings-changed');
    expect(listener, 'مستمع settings-changed مسجَّل (نفس الوحدة)').toBeTruthy();
    select.value = '1';
    listener!({ payload: { max_concurrent_jobs: 2 } });
    expect(select.value, 'القيمة عادت من الحدث إلى نفس العنصر').toBe('2');
    expect(localStorage.getItem('hl.max_jobs'), 'وبنفس مفتاح settings.ts').toBe('2');
  });
});

/* ── ٤) لا مسار ثانٍ: الرئيسية لا تُظهر الشاشة، والزرّ يفتح نافذة ─────────── */
describe('لا مسار ثانٍ · في الرئيسية لا تُفتح الشاشة أبداً', () => {
  it('الشاشة مخفيّة في الرئيسية، وزرّ الإعدادات ينادي open_settings ولا يُظهرها', async () => {
    await mountMainWindow();
    const screen = document.getElementById('settings-menu')!;
    expect(screen.classList.contains('hidden'), 'مخفيّة في الرئيسية').toBe(true);
    expect(document.body.classList.contains('settings-mode'), 'لا وضع شاشة في الرئيسية').toBe(
      false,
    );

    // الزرّ الحقيقي: الربط من كود الإنتاج.
    const { wireSettings } = await import('../settingsPanel');
    wireSettings();
    const btn = document.getElementById('btn-settings')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const opened = h.invoke.mock.calls.filter((c) => c[0] === 'open_settings');
    expect(opened.length, 'الزرّ ينادي open_settings (نافذة مستقلّة)').toBe(1);
    expect(
      screen.classList.contains('hidden'),
      '**ولا يُظهر الحاوية**: لا مسار ثانٍ للإعدادات في الرئيسية',
    ).toBe(true);
    expect(btn.getAttribute('aria-expanded'), 'لا قائمة تُعلَن مفتوحة').toBe('false');
  });

  it('وضع الشاشة يسقط إذا لم نكن في نافذة settings', async () => {
    const { isSettingsMode } = await import('../settingsScreen');
    expect(isSettingsMode('settings')).toBe(true);
    expect(isSettingsMode('main')).toBe(false);
    expect(isSettingsMode(null, '#settings'), 'بديل الـhash صريح').toBe(true);
    expect(isSettingsMode(null, '#anything')).toBe(false);
  });
});
