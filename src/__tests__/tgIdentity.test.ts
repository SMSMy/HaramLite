/* ── م٥ · هوية البوت والأوامر والإحصاءات — الواقع لا النيّة ───────────────────
 *
 * **ما يحرسه هذا الملف** (كله على كود الإنتاج `src/integration.ts` مقابل DOM من
 * `index.html` نفسه، وحدّ Tauri مُستبدَل بدالّة وهمية):
 *   ١) مربّع الهوية يُقرأ من **`telegram_status().identity.applied`** — واقعٌ من
 *      القرص في الخلف — **لا من localStorage** (التخزين يحمل ما أراده المستخدم،
 *      والمربّع يعرض ما جرى).
 *   ٢) التغيير: الحكم من ردّ `telegram_set_bot_identity`، ثم يُثبَّت من الحالة.
 *   ٣) **الفشل لا يترك تفاؤلاً كاذباً**: المربّع يعود إلى حالته السابقة، ويُعلن
 *      السبب (`Err` بنصّه).
 *   ٤) فشل القراءة عند التركيب ⇒ لا ادّعاء: المربّع مُعطَّل ونصّ «لا نعرف».
 *   ٥) زرّ الأوامر: عدد الأوامر عند النجاح، وسبب الفشل عند الفشل.
 *   ٦) الإحصاءات: الاسم · الـID · الملفات · الحجم عند `known:true`، و**نصّ صادق
 *      بلا أصفار** عند `known:false` (وهو صنف «سطح يدّعي حالة»).
 *
 * **ما لا يقيسه** (بصراحة): لا يشغّل التطبيق ولا Rust — النداءات وكلاء، وأشكال
 * الردود مأخوذة **من الشيفرة المدموجة** (`telegram.rs:2464` للحالة،
 * `:2503-2520` للنتيجة، `lib.rs:1016` للإحصاءات) لا من تشغيل حقيقي. ولا حكم
 * بصري: «مُعطَّل» و«مُعلَّم» صفتان على العنصر، لا لقطة.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => null),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

import { wireTelegram } from '../integration';
import { i18n } from '../i18n';

function mountApp(): void {
  document.body.innerHTML = (new DOMParser().parseFromString(indexHtml as string, 'text/html')).body.innerHTML;
}
const box = (): HTMLInputElement => document.getElementById('tg-bot-identity') as HTMLInputElement;
const note = (): HTMLElement => document.getElementById('tg-identity-note') as HTMLElement;
const cmdNote = (): HTMLElement => document.getElementById('tg-commands-note') as HTMLElement;
const statsBody = (): HTMLElement => document.getElementById('tg-stats-body') as HTMLElement;

/** حالة تلغرام بشكلها المدموج (`telegram.rs:2464`). */
function status(identity: { applied: boolean; name: string; error: string }): unknown {
  return { running: true, last_error: '', last_activity: '', processed: 0, queue: 0,
    paired_id: 7, pairing_code_active: false, identity };
}
/** إحصاءات بشكلها المدموج (`lib.rs:1016`). */
const statsKnown = { id: 7, name: 'Ali', files: 12, bytes: 3 * 1024 * 1024, known: true, text: '…' };

/** يركّب التطبيق ويربط تلغرام، ثم ينتظر قراءة الحالة الأولى. */
async function mountWired(): Promise<void> {
  mountApp();
  wireTelegram();
  await vi.advanceTimersByTimeAsync(0);
}
/** ينقر ويترك وعود النداء تُحلّ. */
async function click(el: HTMLElement | null): Promise<void> {
  el?.click();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.invoke.mockImplementation(async (cmd) => (cmd === 'telegram_status' ? status({ applied: false, name: 'HaramLite', error: '' }) : null));
});
afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

/* ── ١) الحالة تعكس الواقع لا النيّة ─────────────────────────────────────── */
describe('م٥ · مربّع الهوية يقرأ الواقع', () => {
  it('applied=true ⇒ مُعلَّم، وapplied=false ⇒ غير مُعلَّم — مهما قال التخزين', async () => {
    // التخزين يقول «مطلوب» والواقع يقول «لا» ⇒ المربّع يتبع الواقع.
    localStorage.setItem('hl.tg_identity', '1');
    await mountWired();
    expect(box().checked, 'الواقع لا النيّة').toBe(false);
    expect(note().textContent).toContain(i18n.ar.tg_identity_off);

    // والعكس: التخزين فارغ والواقع مطبَّق.
    localStorage.clear();
    h.invoke.mockImplementation(async (cmd) => (cmd === 'telegram_status' ? status({ applied: true, name: 'HaramLite', error: '' }) : null));
    await mountWired();
    expect(box().checked).toBe(true);
    expect(note().textContent).toContain('HaramLite');
  });

  it('وخطأ حالة مخزَّن يُعرض بصدق (`identity.error`)', async () => {
    h.invoke.mockImplementation(async (cmd) => (cmd === 'telegram_status'
      ? status({ applied: false, name: 'HaramLite', error: 'توكن مرفوض' }) : null));
    await mountWired();
    expect(box().checked).toBe(false);
    expect(note().textContent).toContain('توكن مرفوض');
  });

  it('وفشل قراءة الحالة ⇒ لا ادّعاء: مُعطَّل ونصّ «لا نعرف»', async () => {
    h.invoke.mockImplementation(async () => { throw new Error('ipc down'); });
    await mountWired();
    expect(box().checked, 'لا يُعلن تطبيقاً لم يُقرأ').toBe(false);
    expect(box().disabled).toBe(true);
    expect(note().textContent).toContain('لا نعرف');
  });
});

/* ── ٢) التغيير: النتيجة من الردّ، والفشل يُعاد ───────────────────────────── */
describe('م٥ · التغيير بنتيجة صريحة', () => {
  async function armEnableOk(): Promise<void> {
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return status({ applied: false, name: 'HaramLite', error: '' });
      if (cmd === 'telegram_set_bot_identity') return { applied: true, changed: true, name: 'HaramLite', previous_name: 'Old', photo_bytes: 1234 };
      return null;
    });
    await mountWired();
  }

  it('نجاح ⇒ المربّع مُعلَّم والتخزين يُكتب والملاحظة تقول الاسم', async () => {
    await armEnableOk();
    box().checked = true;
    box().dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(box().checked).toBe(true);
    expect(localStorage.getItem('hl.tg_identity')).toBe('1');
    expect(note().textContent).toContain('HaramLite');
    expect(h.invoke.mock.calls.some((c) => c[0] === 'telegram_set_bot_identity')).toBe(true);
  });

  it('فشل النداء ⇒ المربّع **يعود** إلى حالته ولا تفاؤل كاذب', async () => {
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return status({ applied: false, name: 'HaramLite', error: '' });
      if (cmd === 'telegram_set_bot_identity') throw new Error('لا توكن للبوت');
      return null;
    });
    await mountWired();
    expect(box().checked).toBe(false);

    box().checked = true; // المستخدم طلب التفعيل
    box().dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(box().checked, 'تفاؤل كاذب بعد فشل').toBe(false);
    expect(note().textContent).toContain('لا توكن للبوت');
    // والتخزين لا يُكتب على الفشل (فلا يبقى اختيار لم يقع).
    expect(localStorage.getItem('hl.tg_identity')).not.toBe('1');
  });

  it('وردّ يقول applied=false ⇒ المربّع لا يُعلن التطبيق', async () => {
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return status({ applied: false, name: 'HaramLite', error: '' });
      if (cmd === 'telegram_set_bot_identity') return { applied: false, changed: true, name: 'HaramLite' };
      return null;
    });
    await mountWired();
    box().checked = true;
    box().dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(box().checked, 'الردّ لم يُثبت التطبيق').toBe(false);
    expect(localStorage.getItem('hl.tg_identity')).toBe('0');
  });
});

/* ── ٣) زرّ الأوامر ──────────────────────────────────────────────────────── */
describe('م٥ · زرّ «اضبط الأوامر»', () => {
  it('نجاح ⇒ عدد الأوامر؛ وفشل ⇒ السبب', async () => {
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return status({ applied: false, name: 'HaramLite', error: '' });
      if (cmd === 'telegram_set_commands') return { commands: 5, scope_chat: 7 };
      return null;
    });
    await mountWired();
    await click(document.getElementById('tg-set-commands'));
    expect(cmdNote().textContent).toContain('5');

    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return status({ applied: false, name: 'HaramLite', error: '' });
      if (cmd === 'telegram_set_commands') throw new Error('شبكة');
      return null;
    });
    await click(document.getElementById('tg-set-commands'));
    expect(cmdNote().textContent).toContain('شبكة');
    expect(cmdNote().className).toContain('text-error');
  });
});

/* ── ٤) الإحصاءات: أرقام حقيقية أو نصّ صادق ──────────────────────────────── */
describe('م٥ · الإحصاءات', () => {
  it('known=true ⇒ الاسم والـID والملفات والحجم', async () => {
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return status({ applied: false, name: 'HaramLite', error: '' });
      if (cmd === 'telegram_stats') return statsKnown;
      return null;
    });
    await mountWired();
    await click(document.getElementById('tg-stats'));

    const body = statsBody().textContent ?? '';
    expect(body).toContain('Ali');
    expect(body).toContain('7');
    expect(body).toContain('12');
    expect(body).toMatch(/3\.0 م\.ب/);
  });

  it('known=false ⇒ **نصّ صادق بلا أصفار** (لا «0 ملف · 0 بايت»)', async () => {
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return status({ applied: false, name: 'HaramLite', error: '' });
      if (cmd === 'telegram_stats') return { id: 7, name: '', files: 0, bytes: 0, known: false, text: '…' };
      return null;
    });
    await mountWired();
    await click(document.getElementById('tg-stats'));

    const body = statsBody().textContent ?? '';
    expect(body).toContain('لا سجلّ');
    // ولا رقم يُقرأ قياساً: لا «0 ملف» ولا «0 بايت» ولا نسبة.
    expect(body).not.toMatch(/\b0\b/);
    expect(body).not.toMatch(/\d\s*%/);
  });

  it('وقبل أي ضغطة تبقى فارغة (لا أرقام محفورة في الترميز)', async () => {
    await mountWired();
    expect(statsBody().textContent?.trim()).toBe('');
  });

  it('وفشل القراءة يُعلَن بدل صمت', async () => {
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return status({ applied: false, name: 'HaramLite', error: '' });
      if (cmd === 'telegram_stats') throw new Error('no stats');
      return null;
    });
    await mountWired();
    await click(document.getElementById('tg-stats'));
    expect(statsBody().textContent).toBe(i18n.ar.tg_stats_failed);
  });
});

/* ── ٥) الترميز: العناصر والأوامر والحدّ ─────────────────────────────────── */
describe('م٥ · الترميز والترجمة', () => {
  it('العناصر الأربعة داخل #settings-menu وفي قسم تلغرام', async () => {
    await mountWired();
    const menu = document.getElementById('settings-menu')!;
    for (const id of ['tg-bot-identity', 'tg-set-commands', 'tg-stats', 'tg-identity-note', 'tg-commands-note', 'tg-stats-body']) {
      const el = document.getElementById(id);
      expect(el, `${id} موجود`).not.toBeNull();
      expect(menu.contains(el), `${id} داخل قسم الإعدادات`).toBe(true);
    }
    // ولا نصّ «0» محفور في سطح الإحصاءات.
    expect(statsBody().textContent?.trim()).toBe('');
  });

  it('وكل مفتاح ترجمة جديد في الجدولين', () => {
    for (const k of ['tg_identity', 'tg_identity_hint', 'tg_identity_on', 'tg_identity_off',
      'tg_identity_failed', 'tg_identity_unknown', 'tg_identity_working', 'tg_set_commands',
      'tg_commands_ok', 'tg_commands_failed', 'tg_stats', 'tg_stats_working', 'tg_stats_unknown',
      'tg_stats_failed', 'tg_stats_body', 'tg_stats_no_name'] as const) {
      expect(i18n.ar[k], `${k} عربي`).toBeTruthy();
      expect(i18n.en[k], `${k} إنجليزي`).toBeTruthy();
    }
  });

  it('ولا نصّ يَعِد بتغيير معرّف البوت — يُذكر كحدّ', () => {
    const hint = i18n.ar.tg_identity_hint;
    expect(hint).toContain('@BotFather');
    expect(hint).toContain('وحده');
    expect(hint).not.toMatch(/يُغيَّر المعرّف|تغيير المعرّف/);
  });
});
