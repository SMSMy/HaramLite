/* ── م٣ — «دورك: N» في قائمة انتظار الواجهة (نفس صياغة مهامّ تلغرام) ────────
 * هذا الملف يشغّل **كود الإنتاج** (`src/queue.ts` مقابل DOM من `index.html`)،
 * ويقيس أمراً واحداً: الصفّ المنتظر يعرض **موضعه الحقيقي**، ويُعاد حسابه عند كل
 * تغيّر حالة — فلا يبقى رقم بائت على الشاشة.
 *
 * **المُفسَد المقصود**: نصّ ثابت («دورك: 1» لكل صفٍّ منتظر) يُسقط اختبار
 * الترتيب أدناه، وعدم إعادة الحساب بعد ترقية صفٍّ يُسقط اختبار «الموضع يتقدّم».
 *
 * **ما لا يقيسه**: تطبيق Tauri عامل (لا نافذة ولا Rust هنا) — المقيس سلوك
 * الواجهة عند حدّ الـIPC، وموضع «قائمة انتظار الواجهة» لا مُجدوِل الخلفية
 * (الحدّ مذكور في `pendingQueuePositions` بـ`src/jobs.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { restoreBatchState } from '../queue';
import { t } from '../i18n';
import * as session from '../session';
import type { JobInfo } from '../jobs';

const A = 'C:\\Music\\Album\\track 01.mp3';
const B = 'D:\\Podcasts\\ep 44.wav';
const C = 'E:\\More\\third.flac';

function mountApp(): void {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
}

function statusOf(file: string): string {
  const row = document.querySelector<HTMLElement>(`#batch-list div[data-file="${CSS.escape(file)}"]`);
  return row?.querySelector('.status-text')?.textContent ?? '';
}

function restore(files: string[]): void {
  localStorage.setItem('hl.batch', JSON.stringify(files.map((f) => ({ f, s: 'pending' }))));
  restoreBatchState();
}

/** نبضة استطلاع واحدة (قراءة السِجلّ ثم مواءمة الصفوف). */
async function poll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1000);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mountApp();
  session.endRun('batch');
  session.endRun('single');
  session.setBatchQueue([]);
  localStorage.clear();
  h.invoke.mockImplementation(async () => null);
  await vi.advanceTimersByTimeAsync(0);
});

afterEach(async () => {
  h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [] : null));
  await vi.advanceTimersByTimeAsync(1000); // يُوقف المُستطلِع فلا يبقى مؤقّت مشتعل
  vi.useRealTimers();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('م٣ · موضع الصفّ المنتظر في قائمة انتظار الواجهة', () => {
  it('numbers the waiting rows from 1 (the next to run), not all with the same number', () => {
    restore([A, B, C]);
    expect(statusOf(A)).toBe(t('queue_wait_position', { n: 1 }));
    expect(statusOf(B)).toBe(t('queue_wait_position', { n: 2 }));
    expect(statusOf(C)).toBe(t('queue_wait_position', { n: 3 }));
    // اللفظ المطلوب حرفياً (والمُفسَد: نصّ واحد للجميع)
    expect(statusOf(A)).toBe('في قائمة الانتظار — دورك: 1');
    const shown = [statusOf(A), statusOf(B), statusOf(C)];
    expect(new Set(shown).size).toBe(3);
    expect(shown.join(' ')).not.toContain('طابور');
  });

  it('recomputes the ranks when a row starts running — no stale number is left', async () => {
    const jobA: JobInfo = { id: 1, label: 'gui', path: A };
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [jobA] : null));

    restore([A, B, C]);
    await poll();

    expect(statusOf(A)).toBe(t('queue_processing')); // تقدّم إلى «يعمل»
    expect(statusOf(B)).toBe('في قائمة الانتظار — دورك: 1'); // كان 2 ⇒ صار التالي
    expect(statusOf(C)).toBe('في قائمة الانتظار — دورك: 2'); // كان 3
  });

  it('a row reset to waiting gets its explicit message, and the rest keep true ranks', async () => {
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [{ id: 1, label: 'gui', path: A }] : null));
    restore([A, B]);
    await poll();
    expect(statusOf(B)).toBe('في قائمة الانتظار — دورك: 1');

    // مهمّة الصفّ الأول ماتت بلا حدث إغلاق ⇒ يُعاد إلى الانتظار برسالة صريحة
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [] : null));
    await poll();

    expect(statusOf(A)).toBe(t('stop_row_stale')); // الرسالة أهمّ من الرقم فلا تُدهَس
    expect(statusOf(B)).toBe('في قائمة الانتظار — دورك: 2'); // A عاد أمامه في القائمة
  });

  it('a single-file queue says «دورك: 1» — it is the next one, truthfully', () => {
    restore([A]);
    expect(statusOf(A)).toBe('في قائمة الانتظار — دورك: 1');
  });
});
