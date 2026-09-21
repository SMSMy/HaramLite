/* ── م٣ — تكامل خفيف: حدث `telegram-jobs` ⇒ صفوف «وظائف خارجية» ──────────────
 * هذا الملف يشغّل **كود الإنتاج** (`src/integration.ts` → `wireExtJobs`) مقابل
 * DOM مأخوذ من `index.html` نفسه، وحدّ Tauri مُستبدَل بدالّة وهمية: فيُقاس ما
 * كُتب في الشاشة فعلاً عند وصول لقطة بنفس شكل العقد المُجمَّد.
 *
 * **ما يقيسه بالضبط**:
 *   ١) أن المستمع `telegram-jobs` مسجَّل، وأن الصفوف تظهر بترتيب الموضع.
 *   ٢) النصّ لكل حالة: «في قائمة الانتظار — دورك: N» · «جارٍ المعالجة» (بلا
 *      نسبة عند `pct: null`) · نتيجة صريحة عند الانتهاء.
 *   ٣) الإزالة بعد مهلة الانتهاء (لا صفوف عالقة)، والحدّ الأقصى مع «+N أخرى».
 *   ٤) حفظ السلوك القائم: صفّا الجسر والمراقبة وزرّ الإلغاء كما كانا.
 *   ٥) اللقطة غير المقروءة لا تُفرّغ القائمة ولا تدّعي «لا مهامّ».
 *
 * **ما لا يقيسه**: تطبيق Tauri عامل ولا بوت تلغرام حقيقي — لا تشغيل للتطبيق في
 * هذه الجولة؛ العقد مُختبَر بلقطة مزيّفة، والحدث الحقيقي من Rust لا يُقاس هنا.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (ev: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (ev: { payload: unknown }) => void) => {
    h.listeners.set(name, cb);
    return () => {};
  }),
}));

import { wireExtJobs } from '../integration';
import { t } from '../i18n';
import { TELEGRAM_FINISHED_TTL_MS, TELEGRAM_MAX_ROWS } from '../telegramJobs';

/* المؤقّت الوهمي يُثبَّت **مرّة واحدة للملف** لا في كل اختبار: `useFakeTimers`
 * يعيد ضبط الساعة إلى زمن التركيب، فلو أُعيد في كل اختبار لتراجعت `Date.now()`
 * عمّا سُجِّل في الاختبار السابق (زمن انتهاء صفٍّ سابق يصير في المستقبل) فلا
 * ينقضي أجله أبداً. وساعة واحدة متّصلة تُبقي الزمن متزايداً — وهو ما يجعل
 * «الصفّ المنتهي يُزال بعد مهلته» قابلاً للقياس بين الاختبارات أيضاً. */
vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

/** DOM التطبيق الحقيقي (بلا سكربتات: innerHTML لا يُنفّذ وسم script). */
function mountApp(): void {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
}

/** يغذّي المستمع المسجَّل — بنفس شكل حِمل Tauri (`{ payload }`). */
function emit(name: string, payload: unknown): void {
  h.listeners.get(name)?.({ payload });
}

function list(): HTMLElement | null {
  return document.getElementById('ext-list');
}

/** كل صفوف مصدر بعينها بترتيبها في الشاشة. */
function rowsOf(kind: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`#ext-list [data-ext-kind="${kind}"]`)];
}

function telegramRows(): HTMLElement[] {
  return rowsOf('telegram');
}

/** تفصيل الصفّ كما يراه المستخدم. */
function detailOf(row: HTMLElement): string {
  return row.querySelector('.ext-detail')?.textContent ?? '';
}

/** لقطة تلغرام: مهامّ الجدول بعددها — بترتيب وصول مبعثر عمداً (الترتيب المعروض
 *  يجب أن يكون بالموضع لا بالوصول)، وفيها مسار كامل يصل بالخطأ. */
function snapshot(): Array<Record<string, unknown>> {
  return [
    { chat_id: 7, user: 'Sara', file: 'b.mp3', state: 'queued', position: 3, total: 3, pct: null },
    { chat_id: 7, user: 'Omar', file: 'a.mp3', state: 'queued', position: 2, total: 3, pct: null },
    { chat_id: 8, user: 'Lina', file: 'C:\\Users\\Lina\\Videos\\c.mp4', state: 'running', position: 1, total: 1, pct: null },
    { chat_id: 9, user: 'Zaid', file: 'd.wav', state: 'failed', position: 0, total: 1, pct: null },
  ];
}

beforeEach(async () => {
  vi.clearAllMocks();
  mountApp();
  localStorage.clear();
  h.invoke.mockImplementation(async () => null);
  wireExtJobs();
  // حالة الوحدة (extJobs/tgRows/extSig) تعيش على مستوى الوحدة لا لكل اختبار:
  // تُصفَّر هنا **بأحداث حقيقية** (لا بلمس دواخلها) كي لا يتسرّب اختبار إلى
  // الذي بعده. واللقطة الزائفة ثم الفارغة تضمنان أن الرسم وقع فعلاً بعد تركيب
  // DOM الجديد (وإلا لَما رسمت بصمةٌ مطابقة للبصمة السابقة شيئاً). وتقديم
  // المؤقّت بمهلة الانتهاء يُزيل صفّاً منتهياً ورثه الاختبار السابق — فالصفّ
  // المنتهي **يبقى حتى مهلته** بحكم التصميم لا بحكم النسيان.
  emit('telegram-jobs', [
    { chat_id: -1, user: '__reset__', file: '__reset__.mp3', state: 'queued', position: 1, total: 1, pct: null },
  ]);
  emit('telegram-jobs', []);
  emit('bridge-done', { name: '' });
  emit('watch-done', { path: '' });
  emit('watch-done', { path: 'D:\\in\\song.wav' });
  await vi.advanceTimersByTimeAsync(TELEGRAM_FINISHED_TTL_MS);
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('م٣ · التسجيل والحالة الفارغة', () => {
  it('registers a telegram-jobs listener', () => {
    expect(h.listeners.has('telegram-jobs')).toBe(true);
  });

  it('shows no empty section and no false zero when there are no rows', () => {
    expect(telegramRows()).toHaveLength(0);
    expect(rowsOf('bridge')).toHaveLength(0);
    expect(list()?.querySelector('#ext-more')).toBeNull();
    expect(list()?.textContent).toBe(t('ext_empty'));
  });

  it('index.html ships that one empty line only (no second empty block was added)', () => {
    const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
    const extList = doc.getElementById('ext-list');
    expect(extList?.children).toHaveLength(1);
    expect(extList?.children[0].id).toBe('ext-empty');
    expect(extList?.children[0].getAttribute('data-i18n')).toBe('ext_empty');
  });
});

describe('م٣ · اللقطة ⇒ الصفوف والنصوص', () => {
  it('renders one row per job, ordered by position, active before finished', () => {
    emit('telegram-jobs', snapshot());

    const rows = telegramRows();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.querySelector('.ext-name')?.textContent)).toEqual([
      '✈️ Lina', '✈️ Omar', '✈️ Sara', '✈️ Zaid',
    ]);
    // ترتيب الوصول كان [Sara(3) · Omar(2) · Lina(1) · Zaid] — فالمعروض مرتّب
    // بالموضع فعلاً، والمنتهية آخرةً (والضابط: الترتيبان مختلفان).
    expect(['Sara', 'Omar', 'Lina', 'Zaid']).not.toEqual(['Lina', 'Omar', 'Sara', 'Zaid']);
    expect(new Set(rows.map((r) => r.dataset.extKey)).size).toBe(4);
  });

  it('queued rows say the real turn; running says processing; failed says it failed', () => {
    emit('telegram-jobs', snapshot());
    const [lina, omar, sara, zaid] = telegramRows();
    expect(detailOf(omar)).toBe('في قائمة الانتظار — دورك: 2');
    expect(detailOf(sara)).toBe('في قائمة الانتظار — دورك: 3');
    expect(detailOf(lina)).toBe('جارٍ المعالجة');
    expect(detailOf(zaid)).toBe('✗ فشلت المعالجة');
  });

  it('never paints a percentage while pct is null, and paints the real one when it exists', () => {
    emit('telegram-jobs', snapshot());
    const lina = (): HTMLElement => telegramRows()[0];
    expect(lina().textContent).not.toContain('%');
    expect(lina().querySelector('.h-1\\.5')).toBeNull(); // ولا شريط تقدّم بلا نسبة

    emit('telegram-jobs', snapshot().map((j) => (j.user === 'Lina' ? { ...j, pct: 0.42 } : j)));
    expect(detailOf(lina())).toBe('جارٍ المعالجة — 42%');
    expect(lina().querySelector<HTMLElement>('.h-1\\.5 div')?.style.inlineSize).toBe('42%');
  });

  it('shows the file name without any path, and never the chat id', () => {
    emit('telegram-jobs', snapshot());
    expect(telegramRows()[0].querySelector('.ext-tg-file')?.textContent).toBe('c.mp4');
    const shown = list()?.textContent ?? '';
    expect(shown).not.toContain('C:\\');
    expect(shown).not.toContain('Users');
    for (const chat of ['7', '8', '9']) {
      expect(shown, `chat_id ${chat} ظهر على الشاشة`).not.toContain(chat);
    }
  });

  it('updates a row in place instead of duplicating it', () => {
    emit('telegram-jobs', snapshot().filter((j) => j.state !== 'failed'));
    const key = telegramRows()[0].dataset.extKey;
    emit('telegram-jobs', [
      { chat_id: 8, user: 'Lina', file: 'c.mp4', state: 'running', position: 1, total: 1, pct: 0.1 },
    ]);
    expect(telegramRows()).toHaveLength(1);
    expect(telegramRows()[0].dataset.extKey).toBe(key);
    expect(detailOf(telegramRows()[0])).toBe('جارٍ المعالجة — 10%');
  });
});

describe('م٣ · الحذف بعد الانتهاء والحدّ الأقصى', () => {
  it('keeps a finished row for its result, then removes it — no stuck rows', async () => {
    emit('telegram-jobs', snapshot());
    // المهمّة الفاشلة غابت عن اللقطة التالية: النتيجة تبقى حتى المهلة
    emit('telegram-jobs', snapshot().filter((j) => j.state !== 'failed'));
    expect(telegramRows()).toHaveLength(4);
    expect(detailOf(telegramRows()[3])).toBe('✗ فشلت المعالجة');

    await vi.advanceTimersByTimeAsync(TELEGRAM_FINISHED_TTL_MS);
    expect(telegramRows()).toHaveLength(3);
    expect(telegramRows().every((r) => detailOf(r) !== '✗ فشلت المعالجة')).toBe(true);
  });

  it('shows five telegram rows and points at the rest with «+N أخرى»', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      chat_id: 1, user: `u${i}`, file: `f${i}.mp3`, state: 'queued', position: i + 1, total: 6, pct: null,
    }));
    emit('telegram-jobs', many);

    expect(telegramRows()).toHaveLength(TELEGRAM_MAX_ROWS);
    expect(list()?.querySelector('#ext-more')?.textContent).toBe(t('ext_more', { n: 1 }));
    // والمخفيّ صفٌّ حقيقي لا وهم: الستّة كلها في اللقطة، والخامس هو آخر المعروض
    expect(telegramRows()[4].querySelector('.ext-tg-file')?.textContent).toBe('f4.mp3');
  });
});

describe('م٣ · سلوك القائمة القائم لم يُكسر', () => {
  it('keeps the bridge and watch rows, their texts and their cancel buttons', () => {
    emit('bridge-start', { name: 'clip.mp4', queue: 2 });
    emit('watch-start', { path: 'D:\\in\\song.wav' });
    emit('telegram-jobs', snapshot());

    const bridge = rowsOf('bridge');
    const watch = rowsOf('watch');
    expect(bridge).toHaveLength(1);
    expect(watch).toHaveLength(1);
    expect(bridge[0].textContent).toContain('clip.mp4');
    expect(bridge[0].textContent).toContain(t('ext_bridge_queued', { n: 2 }));
    expect(bridge[0].querySelector('button')?.textContent).toBe('⏹');
    expect(watch[0].textContent).toContain('song.wav');
    expect(telegramRows()).toHaveLength(4); // والصفوف الثلاثة أنواعها معاً

    bridge[0].querySelector<HTMLElement>('button')?.click();
    expect(h.invoke.mock.calls.map((c) => String(c[0]))).toContain('cancel_bridge_job');

    emit('bridge-done', { name: 'clip.mp4', ok: true, seconds: 3 });
    expect(rowsOf('bridge')).toHaveLength(0);
    expect(telegramRows()).toHaveLength(4); // إغلاق مهمّة جسر لا يمحو صفوف تلغرام
  });

  it('the Telegram rows carry no cancel button (the contract has no such command)', () => {
    emit('telegram-jobs', snapshot());
    for (const row of telegramRows()) expect(row.querySelector('button')).toBeNull();
    expect(h.invoke.mock.calls.map((c) => String(c[0]))).not.toContain('cancel_bridge_job');
  });
});

describe('م٣ · حمولة غير مقروءة: لا «لا مهامّ» كاذبة', () => {
  it('leaves the rows exactly as they were', () => {
    emit('telegram-jobs', snapshot());
    const before = list()?.textContent;
    for (const junk of [null, undefined, 'nope', 3, {}, { jobs: [] }]) {
      emit('telegram-jobs', junk);
      expect(telegramRows(), `payload ${JSON.stringify(junk)}`).toHaveLength(4);
      expect(list()?.textContent).toBe(before);
    }
  });

  it('drops only the unreadable entries and keeps the readable ones', () => {
    emit('telegram-jobs', [
      null,
      { user: 'NoState', file: 'x.mp3' },
      { chat_id: 3, user: 'Real', file: 'ok.mp3', state: 'queued', position: 1, total: 1, pct: null },
    ]);
    expect(telegramRows()).toHaveLength(1);
    expect(telegramRows()[0].querySelector('.ext-tg-file')?.textContent).toBe('ok.mp3');
  });

  it('an empty snapshot clears the waiting rows at once and the finished one at its deadline', async () => {
    emit('telegram-jobs', snapshot());
    emit('telegram-jobs', []);
    // النتيجة تُقرأ أولاً: الصفّ المنتهي وحده باقٍ بعد اختفاء المنتظرين
    expect(telegramRows()).toHaveLength(1);
    expect(detailOf(telegramRows()[0])).toBe('✗ فشلت المعالجة');

    await vi.advanceTimersByTimeAsync(TELEGRAM_FINISHED_TTL_MS);
    expect(telegramRows()).toHaveLength(0);
    expect(list()?.textContent).toBe(t('ext_empty'));
  });
});
