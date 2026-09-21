/* ── م٢ — منطق الإلغاء: تطبيع المسار · المطابقة · الهدف · النداء · النصّ ────
 * كل ما هنا **بلا واجهة**: الدوال في `src/jobs.ts` نقيّة، والنداء للخلف يمرّ
 * عبر دالّة وهمية تُسجّل الأوامر — فيُقاس **ما نودي به فعلاً** لا ما نويناه.
 *
 * والمُفسَدان المطلوبان لهذين الاختبارين (انظر التقرير):
 *   (١) مقارنة المسار **حرفياً** في `jobForPath` ⇒ تسقط اختبارات «فواصل/حالة
 *       أحرف مختلفة تُطابَق» (ولذلك فيها ضابط غير باطل يقيس أن الصيغتين
 *       مختلفتان نصّاً: وإلا لكان التطابق حاصلاً بلا تطبيع).
 *   (٢) جعل مسار الإلغاء ينادي `cancel_process` العامّ ⇒ تسقط اختبارات
 *       «يستهدف مهمّته وحدها» (لأنها تُثبّت قائمة الأوامر المُناداة بالضبط).
 */
import { describe, expect, it } from 'vitest';
import {
  STOP_CEILING_SECS,
  cancelJobById,
  cancelMessage,
  cancelPath,
  fetchActiveJobs,
  isGuiJob,
  jobDisplayName,
  jobForPath,
  normalizeJobPath,
  reconcileItemState,
  stopTarget,
} from '../jobs';
import type { CancelOutcome, JobInfo } from '../jobs';
import { i18n, t } from '../i18n';

type Invoker = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** نداء وهمي يسجّل الأمر ووسائطه ثم يجيب بما يُطلب منه. */
function recorder(answer: (cmd: string, args?: Record<string, unknown>) => unknown): {
  calls: Array<{ cmd: string; args?: Record<string, unknown> }>;
  invoker: Invoker;
} {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoker: Invoker = async (cmd, args) => {
    calls.push({ cmd, args });
    const out = answer(cmd, args);
    if (out instanceof Error) throw out;
    return out;
  };
  return { calls, invoker };
}

const A = 'C:\\Music\\Album\\track 01.mp3';
const B = 'D:\\Podcasts\\ep 44.wav';

describe('م٢ · normalizeJobPath — فواصل موحّدة وحالة أحرف موحّدة', () => {
  it.each([
    ['backslashes stay backslashes', 'C:\\Music\\A.mp3', 'c:\\music\\a.mp3'],
    ['forward slashes fold to backslashes', 'C:/Music/A.mp3', 'c:\\music\\a.mp3'],
    ['mixed separators fold', 'C:\\Music/Album\\A.mp3', 'c:\\music\\album\\a.mp3'],
    ['doubled separators collapse', 'C:\\\\Music\\\\A.mp3', 'c:\\music\\a.mp3'],
    ['letter case folds (upper → lower)', 'C:\\MUSIC\\A.MP3', 'c:\\music\\a.mp3'],
    ['a trailing separator is dropped', 'C:\\Music\\A.mp3\\', 'c:\\music\\a.mp3'],
    ['surrounding whitespace is trimmed', '  C:\\Music\\A.mp3  ', 'c:\\music\\a.mp3'],
    ['the extended-length prefix is dropped', '\\\\?\\C:\\Music\\A.mp3', 'c:\\music\\a.mp3'],
    ['a forward-slash extended prefix is dropped', '//?/C:/Music/A.mp3', 'c:\\music\\a.mp3'],
    ['Arabic letters are untouched by the ASCII fold', 'C:\\موسيقى\\Track.MP3', 'c:\\موسيقى\\track.mp3'],
  ])('%s', (_label, input, expected) => {
    expect(normalizeJobPath(input)).toBe(expected);
  });

  it('path-less, empty and non-string inputs normalize to the empty string', () => {
    for (const raw of [null, undefined, '', '   ']) {
      expect(normalizeJobPath(raw)).toBe('');
    }
    expect(normalizeJobPath(123 as unknown as string)).toBe('');
  });

  it('UNC: the leading double separator collapses too — symmetrically on both spellings', () => {
    // تبسيط مُعلَن: التطبيع يوحّد الفواصل كلها (ومنها فصلَا بداية مسار الشبكة).
    // المهمّ أنه **متماثل**، فالمقارنة لا تتأثّر بالشكل الذي جاء به الطرفان.
    expect(normalizeJobPath('\\\\Server\\Share\\A.mp3')).toBe('\\server\\share\\a.mp3');
    expect(normalizeJobPath('\\\\Server\\Share\\A.mp3')).toBe(normalizeJobPath('//Server/Share/A.mp3'));
  });
});

describe('م٢ · jobForPath — أيّ مهمّة تخصّ هذا المسار', () => {
  const jobs: JobInfo[] = [
    // مهمّة تيليجرام على الملف نفسه بحالة أحرف مختلفة
    { id: 1, label: 'telegram', path: 'C:\\Music\\Album\\Track 01.MP3' },
    // مهمّة الواجهة على الملف نفسه بفواصل مائلة
    { id: 2, label: 'gui', path: 'c:/music/album/track 01.mp3' },
    { id: 3, label: 'watch', path: B },
  ];

  it('matches a job whose path differs only in separators and letter case', () => {
    expect(jobForPath(jobs, A)?.id).toBe(2);
  });

  it('control: the raw spellings really differ — so the match above is not vacuous', () => {
    // لو كانت السلسلتان متطابقتين حرفياً لكان «التطابق» حاصلاً بلا تطبيع،
    // ولما أثبت الاختبار شيئاً. هذا الضابط يقيس أن الفرق موجود فعلاً.
    expect(jobs[1].path).not.toBe(A);
    expect(jobs[1].path).not.toBe(jobs[0].path);
    expect(normalizeJobPath(jobs[1].path)).toBe(normalizeJobPath(A));
  });

  it('prefers the gui job when several jobs share the path (the queue owns it)', () => {
    expect(jobForPath(jobs, A)?.label).toBe('gui');
  });

  it('picks the oldest of several matching gui jobs — deterministic, not read-order', () => {
    const gui: JobInfo[] = [
      { id: 9, label: 'gui', path: A },
      { id: 4, label: 'gui', path: 'C:/MUSIC/album/TRACK 01.mp3' },
    ];
    expect(jobForPath(gui, A)?.id).toBe(4);
    expect(jobForPath([...gui].reverse(), A)?.id).toBe(4);
  });

  it('does not match a different file in the same folder', () => {
    expect(jobForPath(jobs, 'C:\\Music\\Album\\track 02.mp3')).toBeNull();
  });

  it('does not match a path that is only a prefix of the job path', () => {
    expect(jobForPath(jobs, 'C:\\Music\\Album')).toBeNull();
    expect(jobForPath(jobs, 'C:\\Music\\Album\\track 01.mp3.bak')).toBeNull();
  });

  it('a job with no path never matches (ignorance is not a match)', () => {
    expect(jobForPath([{ id: 9, label: 'bridge', path: null }], A)).toBeNull();
    expect(jobForPath([{ id: 9, label: 'bridge' }], A)).toBeNull();
  });

  it('an empty or absent local path never matches', () => {
    expect(jobForPath(jobs, '')).toBeNull();
    expect(jobForPath(jobs, '   ')).toBeNull();
    expect(jobForPath(jobs, null)).toBeNull();
    expect(jobForPath(jobs, undefined)).toBeNull();
  });

  it('an empty job path does not match an empty local path', () => {
    expect(jobForPath([{ id: 9, label: 'telegram', path: '' }], '  ')).toBeNull();
  });

  it('skips malformed registry entries instead of crashing (and does not match on them)', () => {
    const bad = [{ id: 'x', label: 'gui', path: A }] as unknown as JobInfo[];
    expect(jobForPath(bad, A)).toBeNull();
    expect(jobForPath([...bad, jobs[2]], A)).toBeNull();
  });

  it('is safe on a null/undefined registry and on an empty one', () => {
    expect(jobForPath(null, A)).toBeNull();
    expect(jobForPath(undefined, A)).toBeNull();
    expect(jobForPath([], A)).toBeNull();
  });
});

describe('م٢ · stopTarget — مهمّة زرّ الإيقاف الثابت', () => {
  const jobs: JobInfo[] = [
    { id: 5, label: 'bridge', path: 'C:\\Other\\x.mp4' },
    { id: 6, label: 'gui', path: A },
  ];

  it('targets the job of the path the queue is displaying', () => {
    expect(stopTarget(jobs, A)?.id).toBe(6);
  });

  it('falls back to the oldest active job when nothing is displayed', () => {
    // والشريط يسمّي هذه المهمّة نصّاً في #stop-target، فلا يُلغي الزرّ ما لم يُعرَض.
    expect(stopTarget(jobs, null)?.id).toBe(5);
    expect(stopTarget(jobs, 'Z:\\nothing\\here.mp3')?.id).toBe(5);
  });

  it('is null when nothing is active', () => {
    expect(stopTarget([], A)).toBeNull();
    expect(stopTarget(null, A)).toBeNull();
  });
});

describe('م٢ · fetchActiveJobs — «لا أعرف» ليست «لا مهامّ»', () => {
  it('returns the jobs when the backend answers with an array', async () => {
    const reg = recorder(() => [{ id: 1, label: 'gui', path: A, started_ms: 10 }]);
    const read = await fetchActiveJobs(reg.invoker);
    expect(read).toEqual({ ok: true, jobs: [{ id: 1, label: 'gui', path: A, started_ms: 10 }] });
    expect(reg.calls.map((c) => c.cmd)).toEqual(['active_jobs']);
  });

  it('reports a failure when the call rejects — it never claims "no jobs"', async () => {
    const reg = recorder(() => new Error('command active_jobs not found'));
    const read = await fetchActiveJobs(reg.invoker);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain('not found');
  });

  it('reports a failure when the answer is not an array', async () => {
    for (const junk of [null, undefined, 0, 'nope', { 0: 'x' }]) {
      const reg = recorder(() => junk);
      const read = await fetchActiveJobs(reg.invoker);
      expect(read.ok, `answer ${JSON.stringify(junk)} must be a failure`).toBe(false);
    }
  });

  it('drops malformed entries but keeps the valid ones', async () => {
    const reg = recorder(() => [null, { nope: 1 }, { id: 3, label: 'watch', path: B }]);
    const read = await fetchActiveJobs(reg.invoker);
    expect(read).toEqual({ ok: true, jobs: [{ id: 3, label: 'watch', path: B, started_ms: undefined }] });
  });
});

describe('م٢ · cancelPath / cancelJobById — مهمّته وحدها، ولا إلغاء عامّ', () => {
  const jobs: JobInfo[] = [
    { id: 1, label: 'telegram', path: 'C:\\Music\\Album\\Track 01.MP3' },
    { id: 2, label: 'gui', path: 'c:/music/album/track 01.mp3' },
    { id: 3, label: 'watch', path: B },
  ];

  it('reads the registry, then cancels exactly the matched id — and nothing else', async () => {
    const reg = recorder((cmd) => (cmd === 'active_jobs' ? jobs : true));
    const outcome = await cancelPath(reg.invoker, A);
    expect(reg.calls).toEqual([
      { cmd: 'active_jobs', args: undefined },
      { cmd: 'cancel_job', args: { id: 2 } },
    ]);
    expect(outcome).toEqual({ kind: 'job', id: 2, requested: true });
  });

  it('never calls the app-wide cancel_process — not even as a fallback', async () => {
    const reg = recorder((cmd) => (cmd === 'active_jobs' ? jobs : true));
    await cancelPath(reg.invoker, A);
    expect(reg.calls.map((c) => c.cmd)).not.toContain('cancel_process');
  });

  it('says the job was gone when the backend refuses the id (it finished first)', async () => {
    const reg = recorder((cmd) => (cmd === 'active_jobs' ? jobs : false));
    const outcome = await cancelPath(reg.invoker, A);
    expect(outcome).toEqual({ kind: 'job', id: 2, requested: false });
    expect(cancelMessage(outcome).key).toBe('stop_job_gone');
  });

  it('cancels nothing at all when no job matches the path (local cancel only)', async () => {
    const reg = recorder(() => [jobs[2]]); // مهمّة واحدة على مسار آخر
    const outcome = await cancelPath(reg.invoker, A);
    expect(outcome).toEqual({ kind: 'local' });
    expect(reg.calls.map((c) => c.cmd)).toEqual(['active_jobs']); // لا cancel_job ولا سواه
  });

  it('reports an unreadable registry explicitly instead of pretending there is no job', async () => {
    const reg = recorder(() => new Error('ipc down'));
    const outcome = await cancelPath(reg.invoker, A);
    expect(outcome).toEqual({ kind: 'registry-error', error: expect.stringContaining('ipc down') });
    expect(reg.calls.map((c) => c.cmd)).toEqual(['active_jobs']);
  });

  it('reports a failing cancel call instead of swallowing it', async () => {
    const reg = recorder((cmd) => (cmd === 'active_jobs' ? jobs : new Error('slot poisoned')));
    const outcome = await cancelPath(reg.invoker, A);
    expect(outcome).toEqual({ kind: 'cancel-error', id: 2, error: expect.stringContaining('slot poisoned') });
  });

  it('cancelJobById targets the id it was given and never the app-wide cancel', async () => {
    const reg = recorder(() => true);
    const outcome = await cancelJobById(reg.invoker, 42);
    expect(reg.calls).toEqual([{ cmd: 'cancel_job', args: { id: 42 } }]);
    expect(outcome).toEqual({ kind: 'job', id: 42, requested: true });
  });

  it('cancelJobById refuses a non-numeric id instead of calling with garbage', async () => {
    const reg = recorder(() => true);
    const outcome = await cancelJobById(reg.invoker, Number('abc'));
    expect(outcome).toEqual({ kind: 'local' });
    expect(reg.calls).toEqual([]);
  });
});

describe('م٢ · reconcileItemState — مواءمة الصفّ مع السِجلّ', () => {
  it.each([
    ['a restored pending row whose job is alive becomes running', 'pending', true, false, { state: 'run', changed: true, stale: false }],
    ['a running row with a live job stays as it is', 'run', true, false, { state: 'run', changed: false, stale: false }],
    ['a running row whose job is gone is reset (stale)', 'run', false, false, { state: 'pending', changed: true, stale: true }],
    ['a running row whose invoke is still pending is NOT reset', 'run', false, true, { state: 'run', changed: false, stale: false }],
    ['a pending row with no job stays pending', 'pending', false, false, { state: 'pending', changed: false, stale: false }],
    ['a finished row is not resurrected by a later job on the same path', 'ok', true, false, { state: 'ok', changed: false, stale: false }],
    ['a failed row is not resurrected either', 'fail', true, false, { state: 'fail', changed: false, stale: false }],
  ] as const)('%s', (_label, local, hasJob, inFlight, expected) => {
    expect(reconcileItemState(local, hasJob, inFlight)).toEqual(expected);
  });
});

describe('م٢ · نصوص الحالات الجديدة في الجدولين', () => {
  const cases: Array<[string, CancelOutcome, 'ok' | 'warn' | 'error']> = [
    ['stop_requested', { kind: 'job', id: 1, requested: true }, 'ok'],
    ['stop_job_gone', { kind: 'job', id: 1, requested: false }, 'warn'],
    ['stop_local_queued', { kind: 'local' }, 'warn'],
    ['stop_registry_failed', { kind: 'registry-error', error: 'boom' }, 'error'],
    ['stop_cancel_failed', { kind: 'cancel-error', id: 1, error: 'boom' }, 'error'],
  ];

  it.each(cases)('%s — mapped, translated in both tables, and not identical', (key, outcome, tone) => {
    const m = cancelMessage(outcome);
    expect(m.key).toBe(key);
    expect(m.tone).toBe(tone);
    expect((i18n.ar as Record<string, string>)[key]).toBeTruthy();
    expect((i18n.en as Record<string, string>)[key]).toBeTruthy();
    expect((i18n.ar as Record<string, string>)[key]).not.toBe((i18n.en as Record<string, string>)[key]);
  });

  it('substitutes the backend error text into the failure messages', () => {
    const m = cancelMessage({ kind: 'registry-error', error: 'command active_jobs not found' });
    const text = t(m.key, m.vars);
    expect(text).toContain('command active_jobs not found');
    expect(text).not.toContain('{error}');
  });

  it('the stop note shows the measured ceiling and calls it the longest measured', () => {
    const ar = t('stop_note_wait', { secs: STOP_CEILING_SECS });
    expect(ar).toContain(String(STOP_CEILING_SECS));
    expect(ar).toContain('قيس'); // القيد الأخلاقي: «أطول ما قيس» لا «فوراً»
    expect(ar).not.toContain('{secs}');
    // والنصّ الإنجليزي يُركَّب يدوياً لأن لغة الجلسة عربية (localStorage فارغ
    // في jsdom) — والفحص على القالب نفسه: يحمل الرقم ولا يترك {secs}.
    const en = i18n.en.stop_note_wait.replace('{secs}', String(STOP_CEILING_SECS));
    expect(en).toContain(String(STOP_CEILING_SECS));
    expect(en).toContain('measured');
    expect(i18n.en.stop_note_wait).toContain('{secs}');
  });

  it('the ceiling is at least the longest measured inference call (140208 ms)', () => {
    // القياس: inference_ms=140208 (سجلّ المالك، منقول في ARCHIVE/m2-design.md:15)
    // ⇒ السقف المعلن لا يجوز أن يقلّ عن 141 ث، وإلا صار الوعد أقصر من المقيس.
    expect(STOP_CEILING_SECS).toBeGreaterThanOrEqual(141);
  });

  it('the success message is in the progressive, not a completion claim', () => {
    // «جارٍ الإيقاف…» لا «أُوقف»: الطلب سُجِّل، والتنفيذ على مرحلتين في الخلف.
    expect(i18n.ar.stop_requested).toContain('جارٍ الإيقاف');
    expect(i18n.en.stop_requested.toLowerCase()).toContain('stopping');
  });

  it('every new key of the stop bar exists in both tables', () => {
    const keys = [
      'stop_bar_title', 'stop_count', 'stop_target_line', 'stop_target_none', 'stop_button_label',
      'stop_button_hint', 'stop_all_button_label', 'stop_all_hint', 'stop_note_wait',
      'stop_requested', 'stop_job_gone', 'stop_local_queued', 'stop_registry_failed',
      'stop_cancel_failed', 'stop_all_result', 'stop_all_none', 'stop_all_failed',
      'stop_row_stale',
    ];
    const missing = keys.filter((k) => !((k in i18n.ar) && (k in i18n.en)));
    expect(missing, 'مفاتيح جديدة غائبة من أحد الجدولين').toEqual([]);
    const empty = keys.filter((k) => !(i18n.ar as Record<string, string>)[k]?.trim() || !(i18n.en as Record<string, string>)[k]?.trim());
    expect(empty, 'مفاتيح جديدة بقيمة فارغة').toEqual([]);
  });
});

describe('م٢ · isGuiJob وjobDisplayName', () => {
  it('recognises the queue’s own jobs whatever the case of the label', () => {
    expect(isGuiJob({ id: 1, label: 'gui' })).toBe(true);
    expect(isGuiJob({ id: 1, label: 'GUI' })).toBe(true);
    expect(isGuiJob({ id: 1, label: 'watch' })).toBe(false);
    expect(isGuiJob(null)).toBe(false);
  });

  it('names a job by its label and the input file, and says so when it has no path', () => {
    expect(jobDisplayName({ id: 1, label: 'gui', path: A })).toBe('gui · track 01.mp3');
    expect(jobDisplayName({ id: 1, label: 'watch', path: 'C:\\a\\b\\' })).toBe('watch · b');
    expect(jobDisplayName({ id: 1, label: 'bridge', path: null })).toBe('bridge');
    expect(jobDisplayName({ id: 1, label: 'bridge', path: '   ' })).toBe('bridge');
    expect(jobDisplayName(null)).toBe('');
  });
});
