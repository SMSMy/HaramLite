/* ── م٢ — سلوك الواجهة: زرّ الشريط الثابت وزرّ الصفّ ومواءمة العرض ─────────
 * هذا الملف يشغّل **كود الإنتاج** (`src/queue.ts`) مقابل DOM حقيقي مأخوذ من
 * `index.html` نفسه، وحدّ النداء للخلف مُستبدَل بدالّة وهمية تُسجّل الأوامر —
 * فيُقاس ما نودي به فعلاً، ويُقاس ما كُتب في الشاشة فعلاً.
 *
 * **ما يقيسه بالضبط** (وكلّه عطل أو شرط من تكليف م٢):
 *   ١) زرّ الصفّ يستهدف **مهمّة صفّه** (`cancel_job` بمعرّفها) ولا ينادي
 *      `cancel_process` العامّ أبداً — وهو المُفسَد الثاني المطلوب.
 *   ٢) زرّ الإيقاف الثابت يقع **خارج** منطقة تمرير الطابور (فحص بنيوي على
 *      `index.html`)، ويسمّي هدفه، ويُلغي المهمّة التي سمّاها.
 *   ٣) المواءمة مع سِجلّ الخلفية: صفٌّ مُستعاد «في الانتظار» ومهمّته حيّة
 *      يُعرض «يعمل»، وصفٌّ ماتت مهمّته **تُصفَّر نسبته المعروضة** ويُعاد
 *      إلى الانتظار برسالة صريحة (العطل المقيس: نسبة قديمة تبقى على الشاشة).
 *   ٤) فشل `active_jobs` يُعرض فشلاً صريحاً ولا يُعرض أبداً «لا مهامّ».
 *
 * **ما لا يقيسه**: التطبيق العامل نفسه — لا نافذة ولا WebView هنا؛ النداء
 * الحقيقي إلى Rust لم يُجرَ (العقد في `src-tauri/src/slots.rs` يُبنى في شجرة
 * أخرى). فالمقيس سلوك الواجهة عند حدّ الـIPC، لا المهمّة الحيّة.
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

import { cancelQueueItem, restoreBatchState, startJobsPolling, stopBatch, wireSeparate, wireStopBar } from '../queue';
import { t } from '../i18n';
import * as session from '../session';
import type { JobInfo } from '../jobs';

const A = 'C:\\Music\\Album\\track 01.mp3';
const B = 'D:\\Podcasts\\ep 44.wav';

/** DOM التطبيق الحقيقي (بلا سكربتات: innerHTML لا يُنفّذ وسم script). */
function mountApp(): void {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
}

/** نفس محدِّد الإنتاج (queue.ts) — فلا يفحص الاختبار شيئاً غير الذي يقرؤه التطبيق. */
function rowOf(file: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#batch-list div[data-file="${CSS.escape(file)}"]`);
}

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** يفرّغ الميكرو-مهامّ التي ينتظرها الاستطلاع (بلا تمرير وقت). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** كل الأوامر التي نودي بها، بترتيبها. */
function cmds(): string[] {
  return h.invoke.mock.calls.map((c) => String(c[0]));
}

/** الوسائط التي نودي بها لأمر بعينه. */
function argsOf(cmd: string): Array<Record<string, unknown> | undefined> {
  return h.invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Record<string, unknown> | undefined);
}

function restoreQueue(files: string[]): void {
  localStorage.setItem('hl.batch', JSON.stringify(files.map((f) => ({ f, s: 'pending' }))));
  restoreBatchState();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mountApp();
  session.endRun('batch');
  session.endRun('single');
  session.setBatchQueue([]);
  localStorage.clear();
  h.invoke.mockImplementation(async () => null);
});

afterEach(async () => {
  // أفرِغ السِجلّ ونبضة استطلاع حتى يُوقف المُستطلِع نفسه — فلا يبقى مؤقّت
  // مشتعل بين الاختبارات (الحالة وحدها على مستوى الوحدة).
  h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [] : null));
  await vi.advanceTimersByTimeAsync(1000);
  vi.useRealTimers();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('م٢ · زرّ الإيقاف الثابت — بنية index.html', () => {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');

  it('exists, with the two clearly separated buttons', () => {
    expect(doc.getElementById('stop-bar')).not.toBeNull();
    expect(doc.getElementById('btn-stop-job')).not.toBeNull();
    expect(doc.getElementById('btn-stop-all')).not.toBeNull();
    expect(doc.getElementById('stop-target')).not.toBeNull();
    expect(doc.getElementById('stop-note')).not.toBeNull();
  });

  it('is NOT inside the scrolling queue list — it cannot scroll out of view', () => {
    const bar = doc.getElementById('stop-bar');
    const list = doc.getElementById('batch-list');
    expect(list?.className).toContain('overflow-y-auto'); // القائمة هي التي تتحرّك
    expect(list?.contains(bar as Node)).toBe(false); // والزرّ ليس داخلها
    expect(bar?.closest('.overflow-y-auto')).toBeNull(); // ولا داخل أي حاوية تمرير
  });

  it('is not inside the settings dropdown either', () => {
    const bar = doc.getElementById('stop-bar');
    expect(doc.getElementById('settings-menu')?.contains(bar as Node)).toBe(false);
  });

  it('carries translated labels for both buttons (keys the parity test also checks)', () => {
    const bar = doc.getElementById('stop-bar');
    expect(bar?.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-aria]').length ?? 0)
      .toBeGreaterThanOrEqual(4);
    for (const id of ['btn-stop-job', 'btn-stop-all']) {
      const node = doc.getElementById(id);
      const keys = [node?.getAttribute('data-i18n-title'), node?.getAttribute('data-i18n-aria')].filter(Boolean);
      expect(keys.length, `${id} بلا نصّ مربوط بالترجمة`).toBeGreaterThan(0);
    }
    expect(doc.getElementById('stop-note')?.getAttribute('role')).toBe('status');
  });
});

describe('م٢ · مواءمة صفوف الطابور مع سِجلّ الخلفية', () => {
  it('a restored row whose job is alive is shown as running (not "waiting")', async () => {
    const job: JobInfo = { id: 7, label: 'gui', path: A.toUpperCase(), started_ms: 1 };
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [job] : null));

    restoreQueue([A]);
    await settle();

    const row = rowOf(A);
    expect(row, 'الصفّ لم يُرسم من hl.batch').not.toBeNull();
    expect(row?.className).toContain('running-item');
    expect(row?.querySelector('.status-text')?.textContent).toBe(t('queue_processing'));
    // وشريط الإيقاف ظهر لأن السِجلّ فيه مهمّة، وسمّى هدفه باسم ملفّه
    expect(el('stop-bar')?.classList.contains('hidden')).toBe(false);
    expect(el('stop-target')?.textContent?.toLowerCase()).toContain('track 01.mp3');
  });

  it('a running row whose job is gone is reset — and its painted percentage is zeroed', async () => {
    h.invoke.mockImplementation(async (cmd) =>
      cmd === 'active_jobs' ? [{ id: 7, label: 'gui', path: A, started_ms: 1 }] : null);
    restoreQueue([A]);
    wireSeparate(); // يربط مستمع sep-progress الحقيقي (paintSepProgress)
    await settle();

    const row = rowOf(A);
    expect(row?.className).toContain('running-item');

    // النسبة تُرسم من كود الإنتاج نفسه: نبضة sep-progress كما تصل من الخلفية.
    h.listeners.get('sep-progress')?.({ payload: 0.77 });
    await vi.advanceTimersByTimeAsync(50); // نافذة إطار واحد للطَلاء (coalesceRaf)
    expect(row?.querySelector('.batch-pct')?.textContent).toBe('77%');
    expect(row?.querySelector<HTMLElement>('.batch-prog-bar')?.style.inlineSize).toBe('77%');

    // ثم تختفي المهمّة من السِجلّ **بلا حدث إغلاق** يمحو الرسم — وهي الحالة
    // المقيسة: النسبة تبقى على الشاشة كأن العمل جارٍ.
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [] : null));
    await vi.advanceTimersByTimeAsync(1000); // نبضة استطلاع واحدة

    const after = rowOf(A);
    expect(after?.className).not.toContain('running-item');
    expect(after?.querySelector('.status-text')?.textContent).toBe(t('stop_row_stale'));
    expect(after?.querySelector('.batch-pct')?.textContent).toBe('0%');
    expect(after?.querySelector('.batch-pct')?.classList.contains('hidden')).toBe(true);
    expect(after?.querySelector<HTMLElement>('.batch-prog-bar')?.style.inlineSize).toBe('0%');
  });

  it('a failing active_jobs is reported — never displayed as "no jobs"', async () => {
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'active_jobs') throw new Error('command active_jobs not found');
      return null;
    });

    startJobsPolling();
    await settle();

    expect(el('stop-bar')?.classList.contains('hidden')).toBe(false);
    expect(el('stop-note')?.textContent).toContain('active_jobs not found');
    // وليس صفراً صامتاً: العدّاد «؟» لا «0»
    expect(el('stop-count')?.textContent).toBe('?');
    // والفشل يُسجَّل في السجلّ أيضاً، فلا يُبتلع
    expect(cmds()).toContain('push_log');
  });
});

describe('م٢ · زرّ إلغاء الصفّ يستهدف مهمّته وحدها', () => {
  async function promoteRowWith(cmdImpl: (cmd: string, args?: Record<string, unknown>) => unknown): Promise<void> {
    h.invoke.mockImplementation(async (cmd, args) => cmdImpl(cmd, args));
    restoreQueue([A]);
    await settle();
  }

  it('calls cancel_job with the id of ITS path — and never the app-wide cancel', async () => {
    const jobs: JobInfo[] = [
      { id: 3, label: 'watch', path: B },
      { id: 7, label: 'gui', path: 'C:/Music/Album/Track 01.MP3' },
    ];
    await promoteRowWith((cmd) => (cmd === 'active_jobs' ? jobs : true));

    const btn = rowOf(A)?.querySelector<HTMLElement>('.batch-actions button');
    expect(btn, 'زرّ الإلغاء لم يُرسم على الصفّ الجاري').not.toBeNull();
    btn?.click();
    await settle();

    expect(argsOf('cancel_job')).toEqual([{ id: 7 }]);
    expect(cmds()).not.toContain('cancel_process');
    expect(rowOf(A)?.querySelector('.status-text')?.textContent).toContain(t('stop_requested'));
    expect(el('stop-note')?.textContent).toContain(String(141)); // السقف المعلن
  });

  it('when the job is gone by the time of the click it cancels nothing globally and says so', async () => {
    await promoteRowWith((cmd) => (cmd === 'active_jobs' ? [{ id: 7, label: 'gui', path: A }] : true));
    // المهمّة انتهت بين الترقية والضغط: القراءة التالية فارغة
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [] : null));

    rowOf(A)?.querySelector<HTMLElement>('.batch-actions button')?.click();
    await settle();

    expect(cmds()).not.toContain('cancel_job');
    expect(cmds()).not.toContain('cancel_process');
    expect(rowOf(A)?.querySelector('.status-text')?.textContent).toBe(t('stop_local_queued'));
  });

  it('reports a failing cancel call in the row instead of swallowing it', async () => {
    await promoteRowWith((cmd) => {
      if (cmd === 'active_jobs') return [{ id: 7, label: 'gui', path: A }];
      if (cmd === 'cancel_job') throw new Error('slot poisoned');
      return null;
    });

    rowOf(A)?.querySelector<HTMLElement>('.batch-actions button')?.click();
    await settle();

    expect(rowOf(A)?.querySelector('.status-text')?.textContent).toContain('slot poisoned');
    expect(cmds()).not.toContain('cancel_process');
  });

  it('cancelQueueItem returns the outcome it acted on (single job, by id)', async () => {
    const rec = vi.fn(async (cmd: string) => (cmd === 'active_jobs' ? [{ id: 11, label: 'gui', path: A }] : true));
    const outcome = await cancelQueueItem(A, rec as unknown as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>);
    expect(outcome).toEqual({ kind: 'job', id: 11, requested: true });
    expect(rec.mock.calls.map((c) => c[0])).toEqual(['active_jobs', 'cancel_job']);
  });
});

describe('م٢ · زرّ الإيقاف الثابت وزرّ إلغاء الكل', () => {
  it('cancels exactly the job the bar names (and never the app-wide cancel)', async () => {
    const jobs: JobInfo[] = [
      { id: 5, label: 'bridge', path: B },
      { id: 6, label: 'watch', path: 'Z:\\other\\x.mp4' },
    ];
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? jobs : true));

    wireStopBar();
    await settle();
    expect(el('stop-target')?.textContent).toContain('ep 44.wav'); // الأقدم، وهو المسمّى

    el('btn-stop-job')?.click();
    await settle();

    expect(argsOf('cancel_job')).toEqual([{ id: 5 }]);
    expect(cmds()).not.toContain('cancel_process');
    expect(el('stop-note')?.textContent).toContain(String(141));
    expect(el('stop-note')?.textContent).toContain(t('stop_requested'));
  });

  it('"cancel all" is its own button and calls cancel_all_jobs, reporting the count', async () => {
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'active_jobs') return [{ id: 5, label: 'bridge', path: B }];
      if (cmd === 'cancel_all_jobs') return 2;
      return null;
    });

    wireStopBar();
    await settle();
    el('btn-stop-all')?.click();
    await settle();

    expect(cmds()).toContain('cancel_all_jobs');
    expect(cmds()).not.toContain('cancel_job'); // ليس هو زرّ المهمّة
    expect(el('stop-note')?.textContent).toBe(t('stop_all_result', { n: 2 }));
  });

  it('a failing "cancel all" is reported, not hidden', async () => {
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'active_jobs') return [{ id: 5, label: 'bridge', path: B }];
      if (cmd === 'cancel_all_jobs') throw new Error('no such command');
      return null;
    });

    wireStopBar();
    await settle();
    el('btn-stop-all')?.click();
    await settle();

    expect(el('stop-note')?.textContent).toContain('no such command');
  });

  it('the bar disappears once the registry is empty and nothing is running', async () => {
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [{ id: 5, label: 'gui', path: A }] : null));
    wireStopBar();
    await settle();
    expect(el('stop-bar')?.classList.contains('hidden')).toBe(false);

    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [] : null));
    await vi.advanceTimersByTimeAsync(1000);
    expect(el('stop-bar')?.classList.contains('hidden')).toBe(true);
  });

  it('stays visible for a run whose job is not registered yet, and says the target is unknown', async () => {
    // نافذة حقيقية: الزرّ ضُغط وبدأ التشغيل، والمهمّة لم تُسجَّل في الخلف بعد.
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [] : null));
    expect(session.setBatchRunning(true)).toBe(true);

    startJobsPolling();
    await settle();

    expect(el('stop-bar')?.classList.contains('hidden')).toBe(false);
    expect(el('stop-target')?.textContent).toBe(t('stop_target_none'));
    // ولا يدّعي إلغاءً لم يقع: رسالة الإلغاء المحلي مكانٌ آخر ولم تُكتب بعد
    expect(el('stop-note')?.textContent).not.toBe(t('stop_local_queued'));
    session.endRun('batch');
  });

  it('stopBatch asks for cancel_all_jobs (by name) and never the app-wide cancel_process', async () => {
    h.invoke.mockImplementation(async (cmd) => (cmd === 'cancel_all_jobs' ? 2 : null));
    // مسار الإفراغ يعمل فقط إذا كان في الواجهة تشغيل معلَن
    expect(session.setBatchRunning(true)).toBe(true);

    await stopBatch();

    expect(argsOf('cancel_all_jobs')).toEqual([undefined]);
    expect(cmds()).not.toContain('cancel_process');
    // والعدد المقيس يُسجَّل، فلا يُدَّعى إلغاء لم يُقَس
    expect(h.invoke.mock.calls.some((c) => c[0] === 'push_log' && JSON.stringify(c[1]).includes('→ 2'))).toBe(true);
    session.endRun('batch');
  });
});
