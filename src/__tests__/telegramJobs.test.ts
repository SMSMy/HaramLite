/* ── م٣ — صفوف تلغرام في «وظائف خارجية»: الحالة ⇒ النصّ · الترتيب · الحدّ · الإزالة ─
 * هذا الملف يقيس **المنطق النقيّ** (`src/telegramJobs.ts`) بلا DOM: صفوف العرض
 * تُبنى من لقطة بنفس شكل العقد المُجمَّد، ونصّها يُركَّب بـ`t()` من الجدول
 * الحقيقي — فيُقاس النصّ الذي يراه المستخدم لا اسم مفتاح فقط.
 *
 * **المُفسَدان المطلوبان** (انظر التقرير):
 *   (أ) اعرض «دورك: 1» دائماً ⇒ يسقط اختبار «دورك: 2» (واختبار الموضع المجهول).
 *   (ب) اعرض «0%» حين `pct === null` ⇒ يسقط اختبار «لا نسبة كاذبة».
 * ومعهما ثلاثة مُفسَدات من عندي: إسقاط الحدّ الأقصى، وإلغاء الإزالة بعد
 * الانتهاء، وقراءة الحمولة غير المقروءة «لا مهامّ».
 *
 * **ما لا يقيسه**: البوت الحقيقي ولا حدث Tauri حقيقي — لا تشغيل لتطبيق في هذه
 * الجولة؛ الربط بالحدث يقيسه `src/__tests__/extJobsFeed.test.ts` بلقطة مزيّفة.
 */
import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_FINISHED_TTL_MS,
  TELEGRAM_MAX_ROWS,
  applyTelegramSnapshot,
  asTelegramJob,
  expireTelegramRows,
  isFinishedState,
  nextTelegramExpiry,
  percentOf,
  telegramKey,
  telegramRowOf,
  telegramSignature,
  visibleTelegramRows,
} from '../telegramJobs';
import type { TelegramJob, TelegramRow } from '../telegramJobs';
import { pendingQueuePositions } from '../jobs';
import { i18n, t } from '../i18n';

/** مهمّة صالحة، ويُغيَّر منها ما يخصّ الاختبار فقط. */
function job(over: Partial<TelegramJob> = {}): TelegramJob {
  return {
    chat_id: 42,
    user: 'Ali',
    file: 'track 01.mp3',
    state: 'queued',
    position: 1,
    total: 1,
    pct: null,
    ...over,
  };
}

/** نصّ التفصيل كما سيُعرض فعلاً (المفتاح + الوسائط عبر جدول الترجمة). */
function detailText(j: TelegramJob): string {
  const row = telegramRowOf(j, 0);
  return t(row.detailKey, row.vars);
}

describe('م٣ · الحالة ⇒ النصّ (المطلوب الحرفي)', () => {
  it('queued at position 2 says the real turn: «في قائمة الانتظار — دورك: 2»', () => {
    expect(detailText(job({ state: 'queued', position: 2 }))).toBe('في قائمة الانتظار — دورك: 2');
  });

  it('uses the owner’s wording in both tables — «قائمة الانتظار» and «دورك», never «طابور»', () => {
    for (const table of [i18n.ar, i18n.en] as const) {
      const s = table.queue_wait_position;
      expect(s).toContain('{n}');
      expect(s).not.toContain('طابور'); // اللفظ الذي رفضه المالك
    }
    expect(i18n.ar.queue_wait_position).toContain('قائمة الانتظار');
    expect(i18n.ar.queue_wait_position).toContain('دورك:');
    expect(t('queue_wait_position', { n: 7 })).toContain('7');
    expect(t('queue_wait_position', { n: 7 })).not.toContain('{n}');
  });

  it('a queued job with no usable position keeps the wording and invents no rank', () => {
    for (const position of [undefined, Number.NaN, 0, -3] as const) {
      const row = telegramRowOf(job({ state: 'queued', position: position as number }), 0);
      const text = t(row.detailKey, row.vars);
      expect(row.position, `position=${String(position)}`).toBeNull();
      expect(text).toBe('في قائمة الانتظار');
      expect(text).not.toMatch(/\d/); // لا رقم بلا قياس
      expect(text).not.toContain('دورك');
    }
  });

  it('running with pct === null says it is processing and shows NO percentage at all', () => {
    const row = telegramRowOf(job({ state: 'running', pct: null }), 0);
    expect(row.pct).toBeNull();
    expect(t(row.detailKey, row.vars)).toBe('جارٍ المعالجة');
    expect(t(row.detailKey, row.vars)).not.toContain('%');
    expect(t(row.detailKey, row.vars)).not.toContain('0');
  });

  it('running with a real percentage shows it — 0 is shown when 0 is what was measured', () => {
    // الضابط غير الباطل لاختبار «لا نسبة كاذبة»: الصفر **الحقيقي** يُعرض.
    expect(percentOf(0)).toBe(0);
    expect(detailText(job({ state: 'running', pct: 0 }))).toBe('جارٍ المعالجة — 0%');
    expect(detailText(job({ state: 'running', pct: 0.5 }))).toBe('جارٍ المعالجة — 50%');
    expect(detailText(job({ state: 'running', pct: 50 }))).toBe('جارٍ المعالجة — 50%');
    expect(telegramRowOf(job({ state: 'running', pct: 0.5 }), 0).pct).toBe(50);
  });

  it('done and failed say the result explicitly — and neither is the running text', () => {
    const done = detailText(job({ state: 'done' }));
    const failed = detailText(job({ state: 'failed' }));
    const running = detailText(job({ state: 'running', pct: null }));
    expect(done).toContain('اكتملت');
    expect(failed).toContain('فشل');
    expect(done).not.toBe(failed);
    expect([done, failed]).not.toContain(running);
    expect(isFinishedState('done')).toBe(true);
    expect(isFinishedState('failed')).toBe(true);
    expect(isFinishedState('queued')).toBe(false);
    expect(isFinishedState('running')).toBe(false);
  });

  it('percentOf never turns a missing value into a number', () => {
    expect(percentOf(null)).toBeNull();
    expect(percentOf(undefined)).toBeNull();
    expect(percentOf(Number.NaN)).toBeNull();
    expect(percentOf('50')).toBeNull();
    expect(percentOf(1)).toBe(100);
    expect(percentOf(-0.5)).toBe(0);
    expect(percentOf(250)).toBe(100);
  });
});

describe('م٣ · الترتيب: النشطة بموضعها (1 = التالي) ثم المنتهية', () => {
  const snap = (jobs: TelegramJob[], now = 0): TelegramRow[] => applyTelegramSnapshot([], jobs, now);

  it('orders the active rows by their real position, not by the order they arrived', () => {
    const rows = snap([
      job({ file: 'c.mp3', position: 3 }),
      job({ file: 'a.mp3', position: 1 }),
      job({ file: 'b.mp3', position: 2 }),
    ]);
    expect(rows.map((r) => r.file)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
    // الضابط: ترتيب الوصول مختلف فعلاً، فالتطابق أعلاه ليس حاصلاً بلا ترتيب.
    expect([3, 1, 2]).not.toEqual([1, 2, 3]);
  });

  it('puts finished rows after the active ones whatever their position claims', () => {
    const rows = snap([
      job({ file: 'done.mp3', state: 'done', position: 1 }),
      job({ file: 'queued.mp3', state: 'queued', position: 9 }),
    ]);
    expect(rows.map((r) => r.file)).toEqual(['queued.mp3', 'done.mp3']);
  });

  it('is deterministic for equal or missing positions (snapshot order wins)', () => {
    const rows = snap([
      job({ file: 'first.mp3', position: Number.NaN }),
      job({ file: 'second.mp3', position: Number.NaN }),
      job({ file: 'third.mp3', position: 1 }),
    ]);
    expect(rows.map((r) => r.file)).toEqual(['third.mp3', 'first.mp3', 'second.mp3']);
  });

  it('at an equal position, what is running now comes before what is still waiting', () => {
    const rows = snap([
      job({ file: 'waiting.mp3', state: 'queued', position: 1 }),
      job({ file: 'working.mp3', state: 'running', position: 1, pct: 0.1 }),
    ]);
    expect(rows.map((r) => r.file)).toEqual(['working.mp3', 'waiting.mp3']);
  });
});

describe('م٣ · الإزالة بعد الانتهاء — لا صفوف عالقة', () => {
  const doneAt0 = (): TelegramRow[] =>
    applyTelegramSnapshot([], [job({ file: 'x.mp3', state: 'done' })], 0);

  it('keeps the finished row long enough to read the result, then removes it', () => {
    const rows = doneAt0();
    expect(rows).toHaveLength(1);
    expect(rows[0].finishedAt).toBe(0);
    expect(expireTelegramRows(rows, TELEGRAM_FINISHED_TTL_MS - 1)).toHaveLength(1);
    expect(expireTelegramRows(rows, TELEGRAM_FINISHED_TTL_MS)).toHaveLength(0);
  });

  it('reports the next removal deadline (a single timer can be armed from it)', () => {
    expect(nextTelegramExpiry(doneAt0())).toBe(TELEGRAM_FINISHED_TTL_MS);
    expect(nextTelegramExpiry(applyTelegramSnapshot([], [job({ state: 'running' })], 0))).toBeNull();
    const two = applyTelegramSnapshot(
      applyTelegramSnapshot([], [job({ file: 'a', state: 'done' })], 500),
      [job({ file: 'b', state: 'failed' })],
      1500,
    );
    expect(two).toHaveLength(2);
    expect(nextTelegramExpiry(two)).toBe(500 + TELEGRAM_FINISHED_TTL_MS); // الأقرب
  });

  it('a finished row that vanishes from the next snapshot stays (the result was not read yet)', () => {
    const rows = doneAt0();
    const after = applyTelegramSnapshot(rows, [], 1000);
    expect(after.map((r) => r.file)).toEqual(['x.mp3']);
    // ولا تُعاد المهلة من جديد: الإزالة تبقى عند المهلة الأصلية.
    expect(after[0].finishedAt).toBe(0);
  });

  it('a finished row still present in the next snapshot does not restart its deadline', () => {
    const rows = doneAt0();
    const again = applyTelegramSnapshot(rows, [job({ file: 'x.mp3', state: 'done' })], 7000);
    expect(again).toHaveLength(1);
    expect(again[0].finishedAt).toBe(0);
    expect(expireTelegramRows(again, TELEGRAM_FINISHED_TTL_MS)).toHaveLength(0);
  });

  it('an ACTIVE row that vanishes from the snapshot is dropped immediately', () => {
    const rows = applyTelegramSnapshot([], [job({ file: 'gone.mp3', state: 'queued', position: 1 })], 0);
    expect(rows).toHaveLength(1);
    expect(applyTelegramSnapshot(rows, [], 10)).toHaveLength(0);
  });

  it('a job that runs again after finishing gets a fresh deadline and a fresh text', () => {
    const rows = doneAt0();
    const back = applyTelegramSnapshot(rows, [job({ file: 'x.mp3', state: 'running', pct: 0.25 })], 100);
    expect(back[0].state).toBe('running');
    expect(back[0].finishedAt).toBeNull();
    expect(t(back[0].detailKey, back[0].vars)).toBe('جارٍ المعالجة — 25%');
    expect(expireTelegramRows(back, 10 ** 9)).toHaveLength(1);
  });
});

describe('م٣ · اللقطة: «لا أعرف» ليست «لا مهامّ»', () => {
  const one = (): TelegramRow[] => applyTelegramSnapshot([], [job()], 0);

  it('an unreadable payload leaves the previous rows untouched (same reference)', () => {
    const prev = one();
    for (const junk of [null, undefined, 'nope', 3, {}, { jobs: [] }]) {
      expect(applyTelegramSnapshot(prev, junk, 5), `payload ${JSON.stringify(junk)}`).toBe(prev);
    }
  });

  it('an array whose entries are all unreadable is «I do not know», not «no jobs»', () => {
    const prev = one();
    expect(applyTelegramSnapshot(prev, [null, 7, 'x', {}], 5)).toBe(prev);
  });

  it('an empty array IS «no Telegram jobs» — the rows are cleared', () => {
    expect(applyTelegramSnapshot(one(), [], 5)).toHaveLength(0);
  });

  it('drops only the malformed entries and keeps the readable ones', () => {
    const rows = applyTelegramSnapshot([], [null, { nope: 1 }, job({ file: 'kept.mp3' })], 0);
    expect(rows.map((r) => r.file)).toEqual(['kept.mp3']);
  });

  it('a valid entry is rejected only when it cannot be described at all', () => {
    expect(asTelegramJob(job())).not.toBeNull();
    expect(asTelegramJob({ ...job(), state: 'unknown' })).toBeNull();
    expect(asTelegramJob({ ...job(), state: 'QUEUED' })).toBeNull(); // العقد بأحرف صغيرة
    expect(asTelegramJob({ ...job(), user: '  ', file: '   ' })).toBeNull();
    // وغياب `user` وحده لا يُسقط الصفّ: اسم الملف يكفي للتعريف.
    const noUser = asTelegramJob({ ...job(), user: '' });
    expect(noUser).not.toBeNull();
    expect(telegramRowOf(noUser as TelegramJob, 0).name).toBe('track 01.mp3');
  });

  it('two jobs with the same chat and file name keep two distinct rows', () => {
    const rows = applyTelegramSnapshot([], [job({ position: 1 }), job({ position: 2 })], 0);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(rows.map((r) => r.position)).toEqual([1, 2]);
  });

  it('a row is updated in place when its state changes (no duplicate row)', () => {
    const rows = applyTelegramSnapshot([], [job({ state: 'queued', position: 1 })], 0);
    const running = applyTelegramSnapshot(rows, [job({ state: 'running', pct: 0.5 })], 100);
    expect(running).toHaveLength(1);
    expect(running[0].state).toBe('running');
    expect(running[0].key).toBe(rows[0].key);
  });
});

describe('م٣ · الحدّ الأقصى للصفوف والإشارة إلى المخفيّ', () => {
  const many = (n: number): TelegramRow[] =>
    applyTelegramSnapshot([], Array.from({ length: n }, (_, i) => job({ file: `f${i}.mp3`, position: i + 1 })), 0);

  it('shows five Telegram rows and points at the rest with a count', () => {
    expect(TELEGRAM_MAX_ROWS).toBe(5);
    const six = many(6);
    const v = visibleTelegramRows(six);
    expect(v.shown).toHaveLength(TELEGRAM_MAX_ROWS);
    expect(v.hidden).toBe(1);
    expect(t('ext_more', { n: v.hidden })).toBe('+1 أخرى');
    expect(t('ext_more', { n: 3 })).toContain('3');
  });

  it('shows everything (and claims nothing hidden) up to the ceiling', () => {
    expect(visibleTelegramRows(many(5)).hidden).toBe(0);
    expect(visibleTelegramRows(many(5)).shown).toHaveLength(5);
    expect(visibleTelegramRows([])).toEqual({ shown: [], hidden: 0 });
  });

  it('keeps the first rows — the ones at the front of the waiting list', () => {
    expect(visibleTelegramRows(many(7)).shown.map((r) => r.file)).toEqual(
      ['f0.mp3', 'f1.mp3', 'f2.mp3', 'f3.mp3', 'f4.mp3'],
    );
    expect(visibleTelegramRows(many(7), 2).hidden).toBe(5);
    expect(visibleTelegramRows(many(7), 0)).toEqual({ shown: [], hidden: 7 });
  });
});

describe('م٣ · الخصوصية: الملف بلا مسار و`chat_id` لا يُعرض', () => {
  it('shows only the last segment of a path that arrives whole', () => {
    const row = telegramRowOf(job({ file: 'C:\\Users\\Ali\\Videos\\clip 01.mp4' }), 0);
    expect(row.file).toBe('clip 01.mp4');
    expect(row.file).not.toContain('\\');
    expect(row.file).not.toContain('C:');
    expect(telegramRowOf(job({ file: '/home/ali/x.mp3' }), 0).file).toBe('x.mp3');
  });

  it('never renders the chat id — it lives in the key only', () => {
    const row = telegramRowOf(job({ chat_id: 987654321, file: 'a.mp3' }), 0);
    expect(row.key).toContain('987654321');
    const shown = [row.name, row.file, t(row.detailKey, row.vars)].join(' ');
    expect(shown).not.toContain('987654321');
    expect(telegramKey(job({ chat_id: Number.NaN, file: 'a.mp3' }))).toContain('?');
  });
});

describe('م٣ · بصمة الرسم', () => {
  const rows = (pct: number | null, state: TelegramJob['state'] = 'running'): TelegramRow[] =>
    applyTelegramSnapshot([], [job({ state, pct })], 0);

  it('is identical for an unchanged list and different for any change shown', () => {
    expect(telegramSignature(rows(0.5))).toBe(telegramSignature(rows(0.5)));
    expect(telegramSignature(rows(0.5))).not.toBe(telegramSignature(rows(0.6)));
    expect(telegramSignature(rows(null))).not.toBe(telegramSignature(rows(0)));
    expect(telegramSignature(rows(null, 'running'))).not.toBe(telegramSignature(rows(null, 'failed')));
    expect(telegramSignature([])).toBe('');
  });
});

describe('م٣ · موضع صفوف قائمة انتظار الواجهة (نفس «دورك: N»)', () => {
  it('ranks only the waiting rows, 1 = the next to run', () => {
    expect(pendingQueuePositions(['pending', 'run', 'pending', 'pending', 'ok']))
      .toEqual([1, null, 2, 3, null]);
    expect(pendingQueuePositions(['run', 'fail', 'pending'])).toEqual([null, null, 1]);
    expect(pendingQueuePositions(['pending', 'pending', 'pending'])).toEqual([1, 2, 3]);
    expect(pendingQueuePositions([])).toEqual([]);
  });

  it('the same wording key is used for the UI queue and for Telegram rows', () => {
    // مفتاح واحد ⇒ الصياغة لا تفترق بين السطحين.
    const telegram = telegramRowOf(job({ state: 'queued', position: 2 }), 0);
    expect(telegram.detailKey).toBe('queue_wait_position');
    expect(t(telegram.detailKey, telegram.vars)).toBe(t('queue_wait_position', { n: 2 }));
  });
});
