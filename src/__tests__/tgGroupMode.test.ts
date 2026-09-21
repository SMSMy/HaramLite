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
 *   ٥) صدق النصّ: التلميح يذكر **ما نُفِّذ فعلاً** (الموافقة · «اسمح دائماً» ·
 *      قائمة السماح · الحجب في «بالمنشن فقط») ويذكر الحدّ التقني كحدّ. ومربوط
 *      بالكود **في الاتجاهين**: إن وعد النصّ بميزة فليكن الكود ينفّذها.
 *
 * **ما لا يقيسه** (بصراحة):
 *   • **لا يشغّل بوت تلغرام ولا Rust**: لا حكم على سلوك حقيقي، ولا على أن
 *     الرسالة غير الموجَّهة تُسكَت فعلاً. واختبارات Rust التي تُثبت ذلك
 *     (`mentions_only_silences_a_group_message_that_does_not_address_the_bot`
 *     وأخواتها) **لا تُشغَّل هنا**: بناء `cargo test` في هذه البيئة يفشل عند
 *     `tauri_build` بـ`resource path vc_redist.x64.exe doesn't exist` (فخّ
 *     مسجَّل في AGENT.md §١٥، وCI يتجاوزه بـStub للموارد).
 *   • **الفحوص الساكنة تقيس البنية لا السلوك**: «البوابة موجودة وتقرأ الوضع»
 *     ليست «البوابة تحجب». ومُفسَد قِيس: `if !addressed { → if false {` لم
 *     يُسقط شيئاً — **ثقب مُعلَن** لا مخفيّ. ولا يدّعي هذا الملف سدّه.
 *   • ولا متصفّح: لا حكم بصري على القائمة.
 *
 * **مُفسَداته** (انظر التقرير، كلٌّ بخروجه الحرفي): نصّ تلميح يَعِد بميزة غير
 * منفَّذة (ر٣) · إزالة `apv:always` من دالّة الزرّ (ر١) · مفتاح ترجمة غير موجود ·
 * قيمة خيار `every` بدل `all` · إسقاط `pushSettings()` · إسقاط تطبيع
 * `collectSettings` · إسقاط إعلان الفراغ.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';
import telegramRs from '../../src-tauri/src/telegram.rs?raw';
import I18N_TS from '../i18n.ts?raw';

/** نصّ التلميح **من الملف المشحون** (لا من نسخة في الاختبار): يُقرأ بـ`?raw`
 *  فلا حاجة إلى تصدير جديد في `i18n.ts`، ويُقرأ **لحظة التشغيل** فحين يُحرَّر
 *  النصّ يتبعه الفحص بلا وسيط. والقسمان `ar` و`en` يُفصلان بموضع `en: {`. */
const HINT_OF = (lang: 'ar' | 'en'): string => {
  const src = I18N_TS as unknown as string;
  const enAt = src.indexOf('\n  en: {');
  expect(enAt, 'قسم `en` موجود في i18n.ts').toBeGreaterThan(0);
  const region = lang === 'ar' ? src.slice(0, enAt) : src.slice(enAt);
  const m = /settings_group_mode_hint:\s*'((?:[^'\\]|\\.)*)'/.exec(region);
  if (!m) throw new Error(`settings_group_mode_hint غير موجود في ${lang}`);
  return m[1].replace(/\\'/g, "'");
};
/** جسد دالّة من `telegram.rs` بموازنة أقواس — لقياس **ما تفعله الدالّة** لا ما
 *  يذكره الملف. وسبب الحاجة مقيس: `#[cfg(test)]` في هذا الملف **١٩ موضعاً**،
 *  أكثرها دوالّ مساعدة **داخل كود الإنتاج** (لا كتلة `mod tests` واحدة في
 *  الآخر)، فالقطع عند أول موضع — أو عند آخر كتلة — يهدم كود الإنتاج. */
function fnBody(src: string, needle: string): string {
  const at = src.indexOf(needle);
  if (at === -1) return '';
  let i = src.indexOf('{', at);
  if (i === -1) return '';
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

/** من `needle` إلى الفاصلة المنقوطة التي تُنهيه — **بموازنة الأقواس** كي لا
 *  تنتهي عند فاصلة داخل نداء. (`let addressed = …` يمتدّ عدّة أسطر وينتهي
 *  بـ`;`، فموازنة الأقواس وحدها تُخرج جسد `if` التالي — وهذا قِيس فعلاً.) */
function exprFrom(src: string, needle: string): string {
  const at = src.indexOf(needle);
  if (at === -1) return '';
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return src.slice(at, i + 1);
  }
  return '';
}

/** زرُ الموافقة ووسم «اسمح دائماً»: يُقاسان في **دالّتيهما** لا في الملف. */
const APPROVAL_KEYBOARD = fnBody(telegramRs as unknown as string, 'fn approval_keyboard(');
const ACCESS_ALLOW = fnBody(telegramRs as unknown as string, 'fn allow(&mut self');
const ADDRESS_GATE = exprFrom(telegramRs as unknown as string, 'let addressed =');
const TG_RS = telegramRs as unknown as string;

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

/* ── ٤ب) مرآة `settings-changed`: القائمة تتبع حقيقة الخلف ─────────────────────
 * أُضيفت هذه الكتلة بعد **مُفسَد ناجٍ**: تعطيل كتلة المرآة كاملة لم يُسقط شيئاً
 * (19/19 مرّت)، أي أن سلوكاً مشحوناً بلا حارس. فالفحص الآن يشغّل المستمع
 * المسجَّل بحِمل بنفس شكل عقد Tauri ويقيس الخزين والعرض معاً. */
describe('م٤ · settings-changed يُحدِّث القائمة والخزين (مُفسَد M6 سابقاً)', () => {
  it("حِمل telegram_group_mode='all' ⇒ الصندوق all والخزين 'all'", async () => {
    await mountWith(null);
    expect(select().value, 'قبل: الافتراضيّ').toBe('mentions');

    const cb = h.listeners.get('settings-changed');
    expect(cb, 'المستمع settings-changed مسجَّل').toBeTruthy();
    cb!({ payload: { telegram_group_mode: 'all' } });

    expect(select().value).toBe('all');
    expect(localStorage.getItem(LS_KEY)).toBe('all');
  });

  it("حِمل غريب 'mixed' ⇒ mentions في العرض والخزين (لا قيمة ثالثة تدخل)", async () => {
    await mountWith('all');
    expect(select().value, 'قبل: all من الخزين').toBe('all');

    h.listeners.get('settings-changed')!({ payload: { telegram_group_mode: 'mixed' } });

    expect(select().value).toBe('mentions');
    expect(localStorage.getItem(LS_KEY)).toBe('mentions');
  });

  it('حِمل بلا الحقل لا يمسّ الخيار', async () => {
    await mountWith('all');
    h.listeners.get('settings-changed')!({ payload: { notify: true } });
    expect(select().value).toBe('all');
    expect(localStorage.getItem(LS_KEY)).toBe('all');
  });
});

/* ── ٥) صدق النصّ: مربوط بالكود لا بالذاكرة ────────────────────────────────── */
describe('م٤ · النصّ لا يَعِد بميزة غير منفَّذة', () => {
  /** نصّ التلميح من الجدول الحقيقي (ar و en)، لا نسخة في الاختبار. */
  async function hints(): Promise<{ ar: string; en: string }> {
    const { i18n } = await import('../i18n');
    return { ar: i18n.ar.settings_group_mode_hint, en: i18n.en.settings_group_mode_hint };
  }

  it('التلميح نفسه يذكر المنشن وprivacy mode — الشرطان التقنيان', () => {
    // **تصحيح مقيس**: كان هذا الفحص يقرأ `i18n.ar.settings_group_mode_hint`،
    // لكن الفحوص المجاورة تستعمل `hints()` التي تقرأ **التسميات** — فحذفُ كلمة
    // المنشن من نصّ التلميح **لم يُسقط شيئاً** (24/24) لأن الكلمة باقية في وسم
    // «بالمنشن فقط». فالقياس اليوم على **نصّ التلميح** من الملف المشحون.
    //
    // **وحدّه مقيس أيضاً**: هذا التأكيد قريب من العبث في اتجاه واحد — التلميح
    // **يجب** أن يسمّي الوضع، واسمه «بالمنشن فقط» يحوي «منشن» بالضرورة ⇒ فلا
    // يمكن إسقاطه بحذف الكلمة وحدها. فهو يمنع تلميحاً **لا يسمّي الوضع**، ولا
    // يدّعي أكثر: أن الكود يحجب فعلاً **لا يقيسه فحص ساكن** (انظر §«ما لا يقيسه
    // هذا الملف» في رأس الملف).
    for (const lang of ['ar', 'en'] as const) {
      const h = HINT_OF(lang);
      expect(h.length, `التلميح (${lang}) مقروء`).toBeGreaterThan(80);
      expect(h, `الوضع مسمّى في تلميح ${lang}`).toContain(lang === 'ar' ? 'منشن' : 'mention');
      expect(h, `privacy mode في تلميح ${lang}`).toContain('privacy mode');
    }
  });

  /* ── الفخّ مقلوباً (جولة الدمج 2026-09-21) ────────────────────────────────
   * كان هذا الفحص **يمنع** ذكر الموافقة و«اسمح دائماً» لأنها لم تكن منفَّذة.
   * وقد هبط نصف Rust، فصار الكود يُصدر `apv:<yes|no|always>` ويُضيف الزوج إلى
   * قائمة السماح عند `always` ⇒ **منعُ ذكرها اليوم هو الخطأ**، وصار الفحص
   * **يطلبها**. ولم يبقَ ممنوعاً إلا ما بقي غير صحيح فعلاً: أن يَعِد النصّ بأن
   * البوت **يبدأ** محادثة خاصة (وهو ما لا يفعله). */
  it('يذكر ما نُفِّذ: الموافقة و«اسمح دائماً» — لأن الكود يفعلها (عكس الفحص السابق)', async () => {
    const { ar, en } = await hints();
    expect(ar, 'اسمح دائماً').toContain('اسمح دائماً');
    expect(ar, 'بطاقة الموافقة').toContain('بطاقة موافقة');
    expect(ar, 'لا معالجة قبل الضغطة').toContain('لا معالجة قبل ضغطته');
    expect(ar, 'قائمة السماح').toContain('قائمة السماح');
    expect(en).toContain('Always allow');
    expect(en).toContain('approval card');
    expect(en).toContain('allow list');
  });

  it('ولا يَعِد إلا بما يفعله الكود: لا ادّعاء بأن البوت يبدأ محادثة خاصة', async () => {
    const { ar, en } = await hints();
    // حجب «بالمنشن فقط» مذكور كفعل بوت لا كشرط تلغرام وحده.
    expect(ar).toContain('لا يعالج البوت إلا ما وُجِّه إليه');
    // والحدّ التقني مذكور **كحدّ**.
    expect(ar).toMatch(/حدّ.*لا يبدأ محادثة خاصة/);
    expect(en.toLowerCase()).toContain('cannot start a private chat');
    // ولا وعد بأن البوت يبدأ محادثة.
    expect(ar).not.toMatch(/يبدأ البوت محادثة/);
    expect(en.toLowerCase()).not.toMatch(/the bot (starts|will start|can start) a private chat/);
  });

  /* ── الفخّ معكوساً: النصّ مربوط بالكود في **الاتجاهين** ────────────────────
   * الفحصان السابقان هنا كانا فخّاً **باتجاه واحد**: «إن دُمج نصف Rust فسقط
   * الفحص مطالِباً بتحرير النصّ»، و«النمط ليس أعمى». وقد أدّيا دورهما: سقطا
   * لحظة الدمج، وحُرِّر النصّ، **وحُذفا** (وهو ما كان تعليقهما يأمر به).
   *
   * وموضعهما فحصٌ يقيس **اقتران النصّ بالميزة** لا وجودَ حقل: إن ذُكرت الموافقة
   * في التلميح فليكن الكود يُصدر `apv:always`، وإن ذُكر حجب «بالمنشن فقط»
   * فليكن الكود يحمل منطق الإسكات. فيسقط الفحص إن حُذفت الميزة من الكود وبقي
   * النصّ يَعِد بها — وهو ما لا يمنعه اتجاهٌ واحد. */
  it('النصّ ↔ الكود: كل ما يَعِد به النصّ موجودٌ في الدالّة التي تنفّذه', () => {
    // المقيس **جسد الدالّة** لا الملف: البحث في الملف كان يمرّ لأن اختبارات
    // Rust ودوالّها المساعدة تذكر الرموز نفسها — وثقب مُقاس: إزالة `apv:always`
    // من الإنتاج لم تُسقط شيئاً (24/24) والحرف باقٍ في `#[cfg(test)]`.
    expect(APPROVAL_KEYBOARD.length, 'جسد approval_keyboard مقروء').toBeGreaterThan(50);
    expect(ACCESS_ALLOW.length, 'جسد access.allow مقروء').toBeGreaterThan(50);
    expect(ADDRESS_GATE, 'بوابة addressed مقروءة').not.toBe('');
    const hintAr = HINT_OF('ar');
    const hintEn = HINT_OF('en');
    // ① الموافقة و«اسمح دائماً»: النصّ يذكرهما ⇒ الزرّ يُصدر `apv:always`.
    expect(hintAr.includes('اسمح دائماً') || hintEn.includes('Always allow'),
      'النصّ يَعِد بـ«اسمح دائماً»').toBe(true);
    expect(hintAr.includes('بطاقة موافقة') || hintEn.includes('approval card'),
      'النصّ يذكر بطاقة الموافقة').toBe(true);
    expect(APPROVAL_KEYBOARD, 'لا زرّ apv:always والنصّ يَعِد به').toContain('apv:always');
    expect(APPROVAL_KEYBOARD, 'لا زرّ apv:no').toContain('apv:no');
    expect(APPROVAL_KEYBOARD, 'لا زرّ apv:yes').toContain('apv:yes');
    // ② «اسمح دائماً» تُضيف إلى قائمة السماح: مذكورة ⇒ `access.allow` تُوسّعها.
    expect(hintAr.includes('قائمة السماح') || hintEn.includes('allow list')).toBe(true);
    expect(ACCESS_ALLOW, 'allow() لا تُضيف إلى المجموعة').toMatch(/insert|push/);
    // ③ الحجب في «بالمنشن فقط»: النصّ يقول «لا يعالج البوت إلا ما وُجِّه إليه»
    //    ⇒ بوابة `addressed` تقرأ الوضع قبل أي معالجة، و`mentions_bot` تحسبها.
    const claimsGating = hintAr.includes('لا يعالج البوت إلا ما وُجِّه إليه')
      || hintEn.includes('processes only what is addressed to it');
    expect(claimsGating, 'النصّ يدّعي الحجب').toBe(true);
    expect(ADDRESS_GATE, 'البوابة لا تقرأ الوضع').toContain('GroupMode::All');
    expect(TG_RS, 'لا حساب للمنشن في الكود').toContain('fn mentions_bot(');
    // ④ والحدّ التقني: مذكور كحدّ في النصّين.
    expect(hintAr.includes('لا يبدأ محادثة خاصة'), 'الحدّ في العربي').toBe(true);
    expect(hintEn.toLowerCase()).toContain('cannot start a private chat');
  });

  it('والبوّابة ليست باطلة: العنصر والتلميح مرئيان فعلاً في DOM المُركَّب', async () => {
    await mountWith(null);
    const menu = document.getElementById('settings-menu')!;
    expect(select().options.length, 'خياران').toBe(2);
    expect(menu.querySelector('[data-i18n="settings_group_mode_hint"]')).not.toBeNull();
    expect(menu.querySelector('[data-i18n="settings_group_mode"]')).not.toBeNull();
  });
});

/* ── ٥ب) التسميتان تقولان ما تعنيه القيمتان ──────────────────────────────────
 * أُضيفت بعد **مُفسَد ناجٍ**: قلب قيمتي `settings_group_mode_mentions` و
 * `settings_group_mode_all` في الجدول (فصار «بالمنشن فقط» اسماً لـ`all`)
 * لم يُسقط شيئاً (22/22 مرّت) — أي أن المستخدم كان سيقرأ العكس تماماً. */
describe('م٤ · التسمية تطابق القيمة (لا انقلاب صامت)', () => {
  it('«بالمنشن فقط» لـmentions و«كل الرسائل» لـall — في الجدول وفي DOM', async () => {
    const { i18n } = await import('../i18n');
    expect(i18n.ar.settings_group_mode_mentions, 'تسمية mentions').toContain('منشن');
    expect(i18n.ar.settings_group_mode_all, 'تسمية all').not.toContain('منشن');
    expect(i18n.en.settings_group_mode_mentions.toLowerCase()).toContain('mention');
    expect(i18n.en.settings_group_mode_all.toLowerCase()).not.toContain('mention');

    await mountWith(null);
    const label = (v: string): string =>
      select().querySelector(`option[value="${v}"]`)!.textContent!.trim();
    expect(label('mentions')).toContain('منشن');
    expect(label('all')).not.toContain('منشن');
    expect(label('mentions')).not.toBe(label('all'));
  });

  it('التلميح يعرّف الوضعين معاً فلا يبقى اسم بلا شرح', async () => {
    const { i18n } = await import('../i18n');
    const ar = i18n.ar.settings_group_mode_hint;
    expect(ar).toContain(i18n.ar.settings_group_mode_mentions);
    expect(ar).toContain(i18n.ar.settings_group_mode_all);
    const en = i18n.en.settings_group_mode_hint;
    expect(en).toContain(i18n.en.settings_group_mode_mentions);
    expect(en).toContain(i18n.en.settings_group_mode_all);
  });
});
