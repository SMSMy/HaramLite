/* ── م٤ · وضوح رسائل المجموعة: عنصر واحد · قيمتان · تطبيع واحد · دفع واحد ────
 *
 * قرار المالك: **الخيار للمستخدم في الإعدادات** لا قرار مبرمج. وهذا الملف يقيس
 * نصف الواجهة من العقد المشترك (نصف Rust يملكه عامل آخر) على **كود الإنتاج
 * نفسه** مقابل DOM مأخوذ من `index.html` نفسه، وحدّ Tauri مُستبدَل بدالّة وهمية:
 *
 *   ١) العنصر `#tg-group-mode` **داخل `#settings-menu`** وفي قسم تلغرام منه،
 *      بخيارين لا ثالث (`mentions` · `all`)، وقيمتاهما هي القيم المخزَّنة بعينها.
 *   ٢) تخزين `hl.tg_group_mode`: القيمة غير المعروفة ⇒ `mentions` في **العرض
 *      والكتابة معاً** (لا قيمة ثالثة)، و`mentions` هي الافتراضيّ عند الغياب.
 *   ٣) `collectSettings().telegram_group_mode` **مطبَّع** كذلك — فالمعروض =
 *      المُرسَل إلى الخلف.
 *   ٤) التغيير يُخزِّن **ويُدفع** إلى الخلف (`set_settings`) عبر مهلة 300ms.
 *   ٥) صدق النصّ: لا وعد بميزة م٤ غير المنفَّذة (تحويل الرابط للمالك للموافقة ·
 *      «اسمح دائماً»)، ويُقال ما يفعله تلغرام نفسه (privacy mode). ومع ذلك
 *      **النصّ مربوط بالكود لا بالذاكرة**: الفحص يقرأ `src-tauri/src/settings.rs`
 *      فيسقط إن وُجد فيه `telegram_group_mode` (أي إن دُمج نصف Rust) مطالِباً
 *      بتحرير النصّ — فلا يبقى نصٌّ يزعم غياب ميزة بعد وجودها.
 *
 * **ما لا يقيسه** (بصراحة): لا يشغّل بوت تلغرام ولا Rust — الحجب الفعلي
 * («بالمنشن فقط») وحده يمكن قياسه في نصف Rust، وهو غير موجود في هذه الشجرة
 * (مُثبَت أدناه بقراءة الملف نفسه). ولا متصفّح: لا حكم بصري على القائمة.
 *
 * **مُفسَداته** (انظر التقرير، كلٌّ بخروجه الحرفي): نصّ تلميح يَعِد بالميزة ·
 * مفتاح ترجمة غير موجود في الجدول · قيمة خيار `every` بدل `all` · إسقاط
 * `pushSettings()` من مستمع التغيير · إسقاط تطبيع `collectSettings`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';
import settingsRs from '../../src-tauri/src/settings.rs?raw';

const h = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => ({})),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

/** DOM التطبيق الحقيقي (بلا سكربتات: innerHTML لا يُنفّذ وسم script). */
function mountApp(): void {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
}

const LS_KEY = 'hl.tg_group_mode';

/** يُركّب DOM التطبيق على تخزين مُعدّ سلفاً، ثم يربط مستمعي الإعدادات. */
async function mountWith(stored: string | null): Promise<HTMLSelectElement> {
  mountApp();
  localStorage.clear();
  if (stored !== null) localStorage.setItem(LS_KEY, stored);
  const { wireSettings } = await import('../settingsPanel');
  wireSettings();
  const sel = document.getElementById('tg-group-mode');
  expect(sel, '#tg-group-mode موجود في index.html').not.toBeNull();
  return sel as HTMLSelectElement;
}

const select = (): HTMLSelectElement =>
  document.getElementById('tg-group-mode') as HTMLSelectElement;

beforeEach(() => {
  h.invoke.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '';
});

/* ── ١) العنصر: مكانه وقيمتاه ─────────────────────────────────────────────── */
describe('م٤ · العنصر في قسم الإعدادات وقيمتاه هما قيمتا التخزين', () => {
  it('يقع داخل #settings-menu وفي قسم تلغرام منه (لا في الواجهة الرئيسية)', async () => {
    await mountWith(null);

    const menu = document.getElementById('settings-menu');
    expect(menu, '#settings-menu موجود').not.toBeNull();
    expect(menu!.contains(select()), 'القائمة داخل قسم الإعدادات').toBe(true);

    // قسم تلغرام = الحاوية التي تحمل زرّ فتح لوحة البوت ونصّ `tg_title`.
    const tgTitle = [...menu!.querySelectorAll('[data-i18n="tg_title"]')];
    expect(tgTitle.length, 'قسم تلغرام مسمّى في القائمة').toBeGreaterThan(0);
    const tgSection = tgTitle[0].closest('div');
    expect(tgSection, 'حاوية قسم تلغرام').not.toBeNull();
    expect(tgSection!.contains(select()), 'القائمة داخل قسم تلغرام').toBe(true);

    // وليس في الواجهة الرئيسية: لا نسخة ثانية خارج القائمة.
    expect(document.querySelectorAll('#tg-group-mode')).toHaveLength(1);
  });

  it('خياران لا ثالث، وقيمتاهما هي ما يُخزَّن بعينه', async () => {
    await mountWith(null);

    const opts = [...select().options];
    expect(opts.map((o) => o.value)).toEqual(['mentions', 'all']);
    // ولا قيمة مخزَّنة تشير إلى غير هذين (لا `mixed` ولا `every`).
    expect(opts.every((o) => o.value === 'mentions' || o.value === 'all')).toBe(true);
    // الافتراضيّ المعلَن في الترميز نفسه: `selected` على mentions وحدها.
    const preselected = opts.filter((o) => o.hasAttribute('selected'));
    expect(preselected.map((o) => o.value)).toEqual(['mentions']);
  });

  it('التسمية والعنصران والتلميح مربوطة بمفاتيح الترجمة الأربعة المتفَق عليها', () => {
    const html = indexHtml as unknown as string;
    for (const key of [
      'settings_group_mode',
      'settings_group_mode_mentions',
      'settings_group_mode_all',
      'settings_group_mode_hint',
    ]) {
      expect(html, `index.html يحمل data-i18n="${key}"`).toContain(`data-i18n="${key}"`);
    }
    // والتلميح **مرئي** لا مفتاح يتيم في الجدول: عنصر يحمل المفتاح داخل القائمة.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const menu = doc.getElementById('settings-menu')!;
    expect(menu.querySelector('[data-i18n="settings_group_mode_hint"]')).not.toBeNull();
    expect(menu.querySelector('[data-i18n="settings_group_mode"]')).not.toBeNull();
  });
});

/* ── ٢) التخزين: قيمة واحدة معروفة، وغير المعروفة تُردّ إلى mentions ───────── */
describe('م٤ · hl.tg_group_mode: قيمتان ولا ثالثة', () => {
  it('غائب ⇒ mentions معروضاً', async () => {
    await mountWith(null);
    expect(select().value).toBe('mentions');
  });

  it("'all' محفوظة ⇒ all معروضاً (لا تُردّ إلى الافتراضيّ)", async () => {
    await mountWith('all');
    expect(select().value).toBe('all');
  });

  it("قيمة غير معروفة ('every') ⇒ mentions معروضاً", async () => {
    await mountWith('every');
    expect(select().value).toBe('mentions');
  });

  it("اختيار 'all' يُخزّن 'all' ثم اختيار 'mentions' يُخزّن 'mentions'", async () => {
    await mountWith(null);

    select().value = 'all';
    select().dispatchEvent(new Event('change'));
    expect(localStorage.getItem(LS_KEY)).toBe('all');

    select().value = 'mentions';
    select().dispatchEvent(new Event('change'));
    expect(localStorage.getItem(LS_KEY)).toBe('mentions');
  });

  it('قيمة دخيلة تُدسّ في DOM تُصحَّح إلى mentions قبل أن تُخزَّن', async () => {
    await mountWith(null);

    // خيار ثالث مزروع برمجياً: المستمع لا يثق بـ`select.value`.
    const bogus = document.createElement('option');
    bogus.value = 'every';
    bogus.textContent = 'كل شيء';
    select().append(bogus);
    select().value = 'every';
    select().dispatchEvent(new Event('change'));

    expect(localStorage.getItem(LS_KEY), 'لا قيمة ثالثة في التخزين').toBe('mentions');
    expect(select().value, 'والمعروض تبعها').toBe('mentions');
  });
});

/* ── ٣) الدفع إلى الخلف: التطبيع نفسه، والقيمة تصل ─────────────────────────── */
describe('م٤ · collectSettings يطبّع، والتغيير يُدفع إلى set_settings', () => {
  it('collectSettings().telegram_group_mode = المخزَّن حين يكون صالحاً', async () => {
    await mountWith('all');
    const { collectSettings } = await import('../settings');
    expect(collectSettings().telegram_group_mode).toBe('all');
    expect(localStorage.getItem(LS_KEY)).toBe('all');
  });

  it('collectSettings() يطبّع غير المعروف إلى mentions (المعروض = المُرسَل)', async () => {
    await mountWith('every');
    const { collectSettings } = await import('../settings');
    expect(collectSettings().telegram_group_mode).toBe('mentions');
    expect(select().value).toBe(collectSettings().telegram_group_mode);
  });

  it("تغيير المستخدم يصل الخلف: set_settings بحقل telegram_group_mode='all'", async () => {
    vi.useFakeTimers();
    await mountWith(null);
    h.invoke.mockClear();

    select().value = 'all';
    select().dispatchEvent(new Event('change'));
    // مهلة الدفع المُخنوقة (300ms) — لا يصل شيء قبلها.
    expect(h.invoke, 'لا نداء قبل انقضاء المهلة').not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    const call = h.invoke.mock.calls.find((c) => c[0] === 'set_settings');
    expect(call, 'set_settings نودي').toBeTruthy();
    const args = call![1] as { value: Record<string, unknown> };
    expect(args.value.telegram_group_mode).toBe('all');
    // ولا قيمة ثالثة تُرسل في أي حال.
    expect(['mentions', 'all']).toContain(args.value.telegram_group_mode);
  });
});

/* ── ٤) البذرة من الخلف: مطبَّعة أيضاً ────────────────────────────────────── */
describe('م٤ · seedSettings ينقل قيمة الخلف مطبَّعة', () => {
  it("telegram_group_mode='all' من الخلف ⇒ 'all' في التخزين", async () => {
    mountApp();
    localStorage.clear();
    h.invoke.mockImplementation(async (cmd: string) =>
      cmd === 'get_settings'
        ? { telegram_group_mode: 'all', lang: 'ar' }
        : {});
    const { seedSettings } = await import('../settings');
    await seedSettings();
    expect(localStorage.getItem(LS_KEY)).toBe('all');
  });

  it("قيمة غريبة من الخلف ('mixed') ⇒ 'mentions' في التخزين (لا ثالثة تدخل)", async () => {
    mountApp();
    localStorage.clear();
    h.invoke.mockImplementation(async (cmd: string) =>
      cmd === 'get_settings'
        ? { telegram_group_mode: 'mixed', lang: 'ar' }
        : {});
    const { seedSettings } = await import('../settings');
    await seedSettings();
    expect(localStorage.getItem(LS_KEY)).toBe('mentions');
  });

  it('ووجود قيمة في المستخدم يمنع الكتابة فوقها (البذرة مرة واحدة)', async () => {
    mountApp();
    localStorage.clear();
    localStorage.setItem(LS_KEY, 'mentions');
    h.invoke.mockImplementation(async (cmd: string) =>
      cmd === 'get_settings'
        ? { telegram_group_mode: 'all', lang: 'ar' }
        : {});
    const { seedSettings } = await import('../settings');
    await seedSettings();
    expect(localStorage.getItem(LS_KEY)).toBe('mentions');
  });
});

/* ── ٥) صدق النصّ: مربوط بالكود لا بالذاكرة ────────────────────────────────── */
describe('م٤ · النصّ لا يَعِد بميزة غير منفَّذة', () => {
  /** نصّ التلميح من الجدول الحقيقي (ar و en)، لا نسخة في الاختبار. */
  async function hints(): Promise<{ ar: string; en: string }> {
    const { i18n } = await import('../i18n');
    return { ar: i18n.ar.settings_group_mode_hint, en: i18n.en.settings_group_mode_hint };
  }

  it('يذكر المنشن وprivacy mode — الشرطان التقنيان الحقيقيان', async () => {
    const { ar, en } = await hints();
    expect(ar).toContain('منشن');
    expect(ar).toContain('privacy mode');
    expect(en.toLowerCase()).toContain('mention');
    expect(en.toLowerCase()).toContain('privacy mode');
  });

  it('لا يَعِد بتحويل الرابط إلى المالك ولا بـ«اسمح دائماً» ولا بأي موافقة', async () => {
    const { ar, en } = await hints();
    for (const s of [ar, en]) {
      expect(s).not.toContain('اسمح دائماً');
      expect(s).not.toContain('allow always');
      expect(s).not.toContain('يُحوَّل');
      expect(s).not.toContain('للموافقة');
      expect(s.toLowerCase()).not.toContain('approval');
      expect(s.toLowerCase()).not.toContain('approved');
    }
  });

  it('النصّ مربوط بالكود: يسقط إن دُمج نصف Rust (settings.rs فيه telegram_group_mode)', () => {
    // يقرأ الملف المشحون لحظة التشغيل — لا ثابت مكتوب هنا.
    // `(?:^|\n)[ \t]*` يشترط أن يكون `pub` **أول ما في السطر** بعد فراغ: فسطر
    // مُعلَّق (`// pub telegram_group_mode`) لا يُحتسب. قِيس الفرق فعلاً: النمط
    // بلا الشرط كان يطابق المعلَّق ⇒ إنزالٌ كاذب للنصّ بدل تنبيه حقيقي.
    const merged = /(?:^|\n)[ \t]*pub\s+telegram_group_mode\s*:/.test(settingsRs as unknown as string);
    expect(
      merged,
      'نصف Rust دُمج (telegram_group_mode في Settings) ⇒ نصّ التلميح أعلاه صار ' +
        'يَصِف ميزة قائمة جزئياً: حرِّر settings_group_mode_hint في i18n.ts ' +
        'ليذكر ما يفعله المفتاح فعلاً (والحجب في «بالمنشن فقط») بدل أن يترك ' +
        'المستخدم يظنّ أن الخيار لا يفعل شيئاً، ثم أزِل هذا الفحص.',
    ).toBe(false);
  });

  it('وشرط الفحص نفسه مقيس على الصورتين (لا نمط أعمى)', () => {
    // يُقاس النمط على محتوى حقيقي: الملف المشحون (لا شيء) وصورة مضافاً فيها
    // الحقل (يُطابق) وصورة الحقل معلَّقاً فيها (لا يُطابق). وهذا يقيس **النمط**
    // لا الملف، فوسم نصف Rust بنفسه لا يُقاس هنا (خارج نطاق هذا العامل).
    const rs = settingsRs as unknown as string;
    const withField = rs.replace('    pub telegram_audio_only: bool,',
      '    pub telegram_audio_only: bool,\n    pub telegram_group_mode: String,');
    const commented = rs.replace('    pub telegram_audio_only: bool,',
      '    pub telegram_audio_only: bool,\n    // pub telegram_group_mode: String,');
    const re = /(?:^|\n)[ \t]*pub\s+telegram_group_mode\s*:/;
    expect(re.test(withField), 'الحقل مضافاً ⇒ يُطابق').toBe(true);
    expect(re.test(commented), 'الحقل معلَّقاً ⇒ لا يُطابق').toBe(false);
  });

  it('والبوّابة ليست باطلة: العنصر والتلميح مرئيان فعلاً في DOM المُركَّب', async () => {
    await mountWith(null);
    const menu = document.getElementById('settings-menu')!;
    expect(select().options.length, 'خياران').toBe(2);
    expect(menu.querySelector('[data-i18n="settings_group_mode_hint"]')).not.toBeNull();
    expect(menu.querySelector('[data-i18n="settings_group_mode"]')).not.toBeNull();
  });
});
