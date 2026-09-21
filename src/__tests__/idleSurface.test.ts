/* ── الردهة الخاملة — لا ادّعاء بلا مصدر (جولة الجاسوس الثانية، 2026-09-21) ────
 *
 * **القاعدة التي يحرسها هذا الملف**: في الحالة الخاملة (طابور فارغ · لا مهامّ ·
 * لا سجلّات) لا تعرض الواجهة **أي** ادّعاء: لا خطأ · لا نسبة · لا اسم ملف لا
 * وجود له · لا عدّاد · ولا نسخة تخالف نسخة البناء. وما كان ترميزاً تصميمياً
 * للعرض يُزال أو يُستبدل بحالة انتظار صادقة.
 *
 * **وهو مسح للشاشة المُصيَّرة لا فحوص عنصر بعنصر**: يقرأ نصوص `body` المرئية
 * (بعد استثناء ما هو `hidden` فعلاً بالحساب لا بالصنف وحده) ويحكم على الصنف
 * كله. فحين يُضاف سطح جديد من الصنف نفسه يسقط بلا أن يُسمّى هنا.
 *
 * **أعطال مقيسة أُصلحت وعنها يحرس** (كلها مقيسة بنفسي قبل الإصلاح وبعده):
 *   • ع١ — بعد `stopBatch()`: صفّان «دورك: 1» و«دورك: 2» **مع** «لا ملفات في
 *     الطابور بعد»: `P1.after {queueLen:0, rows:2, emptyVisible:true, bothAtOnce:true}`.
 *   • ع٢ — طابور فارغ ومهمّة حيّة: `P5c {rows:0, emptyVisible:true,
 *     stopBarVisible:true, stopCount:"المهامّ النشطة: 1"}` — خمولٌ مُعلَن و عملٌ قائم.
 *   • ع٣ — `#log-view` بأربعة سطور ثابتة فيها `[ERROR] Failed to locate model
 *     weights…`، تبقى عند فشل `get_recent_logs` (`afterFailedRefresh`).
 *   • ع٤ — صفّ مُستعاد `run`/`fail` يُعرض «دورك: 1» ويُمحى فشله من التخزين.
 *   • ع٥ — `#version-badge` ثابت `v0.2.0` و`package.json` يقول `0.2.8`.
 *   • **صندوق كامن من عندي**: `#stage-pct` نصّه `0%` و`#stage-name` «فصل الصوت»
 *     في الترميز — لم يُسمّه الجاسوس، وكشفه المسح الشامل.
 *
 * **ما لا يقيسه** (بصراحة): لا تطبيق Tauri ولا Rust — الوكلاء وهميون. و«مرئي»
 * هنا = **ليس `hidden` ولا داخل `hidden`** بالحساب؛ و`jsdom` بلا تخطيط، فلا
 * لقطة بصرية ولا حكم على `display` من CSS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';
import pkg from '../../package.json';

const h = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => null),
  listeners: new Map<string, (ev: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (ev: { payload: unknown }) => void) => {
    h.listeners.set(name, cb);
    return () => {};
  }),
}));

vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

import { ingestFiles, restoreBatchState, startJobsPolling, stopBatch } from '../queue';
import { i18n } from '../i18n';
import * as session from '../session';
import type { JobInfo } from '../jobs';

const A = 'C:\\Music\\Album\\track 01.mp3';
const B = 'D:\\Podcasts\\ep 44.wav';

/** أسماء لا وجود لها في هذه الجلسة — ظهورها ادّعاء ملفّ. */
const PHANTOM = ['track_01_vocals.mp3', 'podcast_ep44.wav'] as const;

function mountApp(): void {
  const doc = new DOMParser().parseFromString(indexHtml as unknown as string, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
}

/* ── أدوات المسح ─────────────────────────────────────────────────────────── */

/** هل العنصر **مرئي فعلاً**؟ يُحسب الصعود في الشجرة: صنف `hidden` على العنصر
 *  أو على أيّ أصل يُخفيه. (لا نكتفي بفحص `display` — لا تخطيط في jsdom.) */
function isVisible(el: Element | null): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.classList.contains('hidden')) return false;
  }
  return el !== null;
}

/** نصّ الشاشة **المرئي** وحده: كل عقدة نصّ ليس أصلها مخفياً. */
function visibleText(): string {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (isVisible(n.parentElement)) parts.push(n.nodeValue ?? '');
  }
  return parts.join('\n');
}

const list = (): HTMLElement => document.getElementById('batch-list') as HTMLElement;
const emptyEl = (): HTMLElement => document.getElementById('batch-empty') as HTMLElement;
const rows = (): HTMLElement[] => [...list().querySelectorAll<HTMLElement>('div[data-file]')];
const emptyVisible = (): boolean => isVisible(emptyEl());
const rowStatuses = (): string[] =>
  rows().map((r) => r.querySelector('.status-text')?.textContent ?? '');

/* ── الحالة الخاملة: طابور فارغ · لا مهامّ · لا سجلّات ────────────────────── */
async function idleBoot(): Promise<void> {
  mountApp();
  session.endRun('batch');
  session.endRun('single');
  session.setBatchQueue([]);
  localStorage.clear();
  h.invoke.mockImplementation(async () => null); // لا مهامّ في السِجلّ
  restoreBatchState();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.invoke.mockImplementation(async () => null);
});
afterEach(async () => {
  h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [] : null));
  await vi.advanceTimersByTimeAsync(1500);
  document.body.innerHTML = '';
  localStorage.clear();
  vi.resetModules();
});

/* ══ ١) المسح الشامل: الحالة الخاملة لا تحمل ادّعاءً ═══════════════════════ */
describe('الردهة الخاملة · مسح الشاشة المُصيَّرة', () => {
  it('لا نصّ خطأ معروض في الحالة الخاملة', async () => {
    await idleBoot();
    const text = visibleText();
    expect(text, 'نصّ [ERROR] في شاشة خاملة').not.toContain('[ERROR]');
    expect(text).not.toContain('[WARN]');
    expect(text).not.toContain('ERROR');
    expect(text.toLowerCase()).not.toContain('failed to');
  });

  it('ولا نسبة مئوية معروضة', async () => {
    await idleBoot();
    expect(visibleText(), 'نمط نسبة في شاشة خاملة').not.toMatch(/\d{1,3}\s*%/);
    // ولا شريط تقدّم معروض.
    const shownBars = [...document.querySelectorAll<HTMLElement>('.batch-prog-wrap, .batch-prog-bg, #stage-line')]
      .filter(isVisible);
    expect(shownBars, 'شريط تقدّم معروض بلا عمل').toEqual([]);
  });

  it('ولا اسم ملف، ولا عدّاد، ولا صفّ طابور', async () => {
    await idleBoot();
    const text = visibleText();
    for (const name of PHANTOM) expect(text, `اسم وهمي «${name}»`).not.toContain(name);
    expect(rows(), 'صفوف في طابور فارغ').toHaveLength(0);
    expect(isVisible(document.getElementById('batch-counter')), 'عدّاد بلا طابور').toBe(false);
    expect(isVisible(document.getElementById('stop-bar')), 'شريط إيقاف بلا مهمّة').toBe(false);
  });

  it('والحالة الفارغة تُعلَن بنصّها الصادق (لا شاشة صامتة)', async () => {
    await idleBoot();
    expect(emptyVisible()).toBe(true);
    const text = visibleText();
    expect(text).toContain(i18n.ar.queue_empty);
    expect(text).toContain(i18n.ar.queue_empty_add);
    // ولا ادّعاء عمل في النصّ الخامل.
    expect(text).not.toContain(i18n.ar.queue_empty_running);
    expect(text).not.toContain(i18n.ar.queue_processing);
  });

  it('ولا نسخة تخالف نسخة البناء', async () => {
    await idleBoot();
    const badge = document.getElementById('version-badge')!;
    const shown = (badge.textContent ?? '').trim();
    // إما لا نسخة (لم تصل من الخلفية) أو نسخة الخلفية — ولا رقم مخترَع.
    expect(shown === '' || shown === `v${pkg.version}`, `الشارة «${shown}»`).toBe(true);
    // والنسخة القديمة المحفورة لا تعود.
    expect(indexHtml as unknown as string).not.toContain('>v0.2.0<');
  });
});

/* ══ ٢) ع١: الإفراغ لا يترك صفوفاً بائتة مع رسالة فراغ ═════════════════════ */
describe('ع١ · الإفراغ يُصفّي الصفوف التي لم تعد في القائمة', () => {
  it('بعد stopBatch: صفر صفّ · لا «دورك: N» · ورسالة الفراغ وحدها', async () => {
    await idleBoot();
    await ingestFiles([A, B]);
    expect(rows()).toHaveLength(2);
    expect(rowStatuses()[0]).toContain('دورك: 1');

    await stopBatch();

    expect(session.getBatchQueue()).toEqual([]);
    expect(rows(), 'صفوف بائتة بعد الإفراغ').toHaveLength(0);
    const text = visibleText();
    expect(text).not.toContain('دورك:');
    expect(text).toContain(i18n.ar.queue_empty);
    // ولا ازدواج: لا نصّ صفّ مع نصّ فراغ.
    expect(text).not.toContain(i18n.ar.queue_pending);
  });

  it('والحكم بحالة الصفّ المُعلَنة لا بنصّه (data-state)', async () => {
    await idleBoot();
    await ingestFiles([A, B]);
    for (const r of rows()) expect(r.dataset.state).toBe('pending');
    await stopBatch();
    expect(rows()).toHaveLength(0);
  });

  it('وصفوف ok/fail تبقى سِجلاً — ولا رسالة فراغ فوقها', async () => {
    // التمييز مقصود: `stopBatch` تمحو **المنتظر/الجاري** (لا مقابل له في
    // القائمة بعد الإفراغ) وتُبقي **المنتهي** (ok/fail) سِجلاً لما جرى حتى
    // الرسم التالي. والمهمّ أنهما لا يجتمعان مع ادّعاء الفراغ أبداً — وهو
    // الثابت الذي كان مكتوباً في تعليق الحارس القديم ثم يُنقض في سطوره.
    mountApp();
    session.setBatchQueue([]);
    localStorage.clear();
    h.invoke.mockImplementation(async () => null);
    localStorage.setItem('hl.batch', JSON.stringify([{ f: A, s: 'fail' }]));
    restoreBatchState();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].dataset.state).toBe('fail');
    expect(emptyVisible()).toBe(false);

    await stopBatch(); // إفراغ القائمة: الصفّ المنتهي يبقى، والفراغ لا يُعلَن

    expect(rows(), 'صفّ منتهٍ باقٍ سِجلاً').toHaveLength(1);
    expect(rows()[0].dataset.state).toBe('fail');
    expect(emptyVisible(), 'فراغ مُعلَن وصفوف معروضة').toBe(false);
    expect(visibleText()).not.toContain(i18n.ar.queue_empty);
  });
});

/* ══ ٣) ع٢: مهمّة حيّة بطابور فارغ ⇒ لا يُعلَن خمول ════════════════════════ */
describe('ع٢ · مهمّة حيّة بطابور واجهة فارغ', () => {
  it('النصّ يقول «مهمّة جارية» ولا يقول «ابدأ المعالجة»', async () => {
    await idleBoot();
    const job: JobInfo = { id: 4, label: 'bridge', path: 'C:\\z\\w.mp3' };
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [job] : null));
    startJobsPolling();
    await vi.advanceTimersByTimeAsync(1200);

    // شريط الإيقاف يقول إنّ ثمّة مهمّة ⇒ فلا يجوز أن تقول اللوحة «لا شيء».
    expect(isVisible(document.getElementById('stop-bar')), 'شريط الإيقاف ظاهر').toBe(true);
    const text = visibleText();
    expect(text, 'خمول مُعلَن وعمل قائم').not.toContain(i18n.ar.queue_empty_add);
    expect(text).toContain(i18n.ar.queue_empty_running);
    expect(text).toContain(i18n.ar.queue_empty_running_hint);
  });

  it('وبلا مهمّة يعود النصّ إلى حالة الفراغ العادية (الاتجاهان مقيسان)', async () => {
    await idleBoot();
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [{ id: 4, label: 'gui', path: 'C:\\z\\w.mp3' }] : null));
    startJobsPolling();
    await vi.advanceTimersByTimeAsync(1200);
    expect(visibleText()).toContain(i18n.ar.queue_empty_running);

    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [] : null));
    await vi.advanceTimersByTimeAsync(1200);
    expect(visibleText()).toContain(i18n.ar.queue_empty_add);
    expect(visibleText()).not.toContain(i18n.ar.queue_empty_running);
  });
});

/* ══ ٤) ع٤: صفّ مُستعاد بحالة run/fail يعلن حالته ═════════════════════════ */
describe('ع٤ · الاستعادة لا تمحو «الفشل» ولا «التشغيل»', () => {
  it('fail مخزَّن ⇒ الصفّ يقول فشل، ولا يُكتب فوقه pending', async () => {
    mountApp();
    session.setBatchQueue([]);
    localStorage.clear();
    localStorage.setItem('hl.batch', JSON.stringify([{ f: A, s: 'fail' }]));
    restoreBatchState();

    expect(rows()).toHaveLength(1);
    expect(rowStatuses()[0]).toBe(i18n.ar.sep_failed_short);
    expect(rowStatuses()[0]).not.toContain('دورك:');
    expect(localStorage.getItem('hl.batch'), 'الحالة المخزَّنة لا تُمحى').toContain('"s":"fail"');
    expect(rows()[0].dataset.state).toBe('fail');
  });

  it('run مخزَّن بلا مهمّة ⇒ يعلن تشغيله ثم يُصحّحه السِجلّ برسالة صريحة', async () => {
    mountApp();
    session.setBatchQueue([]);
    localStorage.clear();
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [] : null));
    localStorage.setItem('hl.batch', JSON.stringify([{ f: A, s: 'run' }]));
    restoreBatchState();

    // لحظة الرسم: يعلن تشغيله (لا «دورك: 1» كاذباً).
    expect(rowStatuses()[0]).toBe(i18n.ar.queue_processing);

    // ثم يصحّحه الاستطلاع: لا مهمّة ⇒ «أُعيد إلى الانتظار» صراحةً.
    await vi.advanceTimersByTimeAsync(1200);
    expect(rowStatuses()[0]).toBe(i18n.ar.stop_row_stale);
    expect(localStorage.getItem('hl.batch')).toContain('"s":"pending"');
  });
});

/* ══ ٥) ع٣: السجلّ لا يعرض خطأً لم يقع ════════════════════════════════════ */
describe('ع٣ · سجلّ الأحداث يقول الحقيقة عند الفراغ والفشل', () => {
  it('الترميز لا يحمل سطر سجلّ واحداً (والمفاتيح المشروعة باقية في الجدول)', () => {
    const doc = new DOMParser().parseFromString(indexHtml as unknown as string, 'text/html');
    const view = doc.getElementById('log-view')!;
    expect(view.children, 'سطور ثابتة في #log-view').toHaveLength(0);
    expect(view.textContent?.trim(), 'نصّ ثابت في #log-view').toBe('');
    // والمفاتيح التي كانت لهذه السطور باقية — تُستعمل في مواضع أخرى مشروعة.
    for (const k of ['log_demo_info', 'log_demo_warn', 'log_demo_error', 'log_demo_ready'] as const) {
      expect(i18n.ar[k]).toBeTruthy();
      expect(i18n.en[k]).toBeTruthy();
    }
    void pkg;
  });

  it('فشل get_recent_logs ⇒ رسالة فشل صريحة، لا خطأ مُختلق ولا فراغ صامت', async () => {
    mountApp();
    localStorage.setItem('hl.log_open', '1');
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'get_recent_logs') throw new Error('ipc down');
      return null;
    });
    const log = await import('../log');
    log.setLogOpen(true);
    await log.refresh();

    const view = document.getElementById('log-view')!;
    const text = view.textContent ?? '';
    expect(text, 'إنذار كاذب عن أوزان النموذج').not.toContain('model weights');
    expect(text).not.toContain('[ERROR]');
    expect(text).toContain(i18n.ar.log_unavailable);
    expect(view.querySelector('[data-log-notice="log_unavailable"]'), 'سطر الحالة معلَّم').not.toBeNull();
  });

  it('نجاح بلا سطور ⇒ «لا سطور بعد»؛ ونجاح بسطور ⇒ السطور الحقيقية وحدها', async () => {
    mountApp();
    h.invoke.mockImplementation(async (cmd) => (cmd === 'get_recent_logs' ? [] : null));
    vi.resetModules();
    const log = await import('../log');
    log.setLogOpen(true);
    await log.refresh();
    expect(document.getElementById('log-view')!.textContent).toContain(i18n.ar.log_empty);

    h.invoke.mockImplementation(async (cmd) =>
      cmd === 'get_recent_logs'
        ? [{ ts: 'T', level: 'INFO' as const, target: 'x', message: 'REAL-LINE' }]
        : null);
    await log.refresh();
    const text = document.getElementById('log-view')!.textContent ?? '';
    expect(text).toContain('REAL-LINE');
    expect(text).not.toContain(i18n.ar.log_empty);
    expect(text).not.toContain('[ERROR]');
  });
});

/* ══ ٦) ع٥: شارة الإصدار ══════════════════════════════════════════════════ */
describe('ع٥ · شارة الإصدار لا تكذب ولا لحظة', () => {
  it('الترميز لا يحمل أي نسخة — تُكتب من الخلفية وحدها', async () => {
    const doc = new DOMParser().parseFromString(indexHtml as unknown as string, 'text/html');
    const node = doc.getElementById('version-badge')!;
    expect((node.textContent ?? '').trim(), 'نسخة محفورة في الترميز').toBe('');
    // ولا رقم نسخة في سمة أو نصّ الشارة (الشكل `v` + أرقام).
    expect((node.outerHTML.match(/v\d+\.\d+/g) ?? []), 'نمط نسخة في عُقدة الشارة').toEqual([]);
    // والنسخة التي كانت محفورة (ثمانية إصدارات خلف البناء) لا تعود.
    expect(indexHtml as unknown as string).not.toContain('>v0.2.0<');

    // والمسار الوحيد الذي يكتبها هو `ping` في main.ts — مقيس على النصّ المشحون.
    const mainSrc = await import('../main.ts?raw');
    expect(mainSrc.default as unknown as string).toContain("invoke<{ app: string; version: string }>('ping')");
    expect(mainSrc.default as unknown as string).toContain('badge.textContent = `v${info.version}`');
  });

  it('وقبل وصول النسخة (فشل ping أو تأخّره) الشارة فارغة — لا ادّعاء', async () => {
    mountApp(); // تركيب خامل: لا `init()` ولا `ping` أصلاً — أسوأ من الفشل
    expect((document.getElementById('version-badge')!.textContent ?? '').trim()).toBe('');
    expect((document.getElementById('version-badge')!.textContent ?? '').trim()).not.toBe(`v${pkg.version}`);
  });
});

/* ══ ٧) الصندوق الكامن: #stage-pct ════════════════════════════════════════ */
describe('الصندوق الكامن · شريط المراحل لا يحمل رقماً محفوراً', () => {
  it('الترميز خالٍ من نسبة ومرحلة، ويُملأ من الكود عند حدث حقيقي', () => {
    const doc = new DOMParser().parseFromString(indexHtml as unknown as string, 'text/html');
    expect(doc.getElementById('stage-pct')!.textContent?.trim()).toBe('');
    expect(doc.getElementById('stage-name')!.textContent?.trim()).toBe('');
    expect(doc.getElementById('stage-line')!.classList.contains('hidden')).toBe(true);
  });

  it('وحدث sep-stage حقيقي يملؤه — الضابط الذي يثبت أن الإفراغ لم يُعطّله', async () => {
    mountApp();
    const { wireSeparate } = await import('../queue');
    wireSeparate();
    h.listeners.get('sep-stage')?.({ payload: { stage: 'separate', pct: 0.42 } });
    await vi.advanceTimersByTimeAsync(50);

    const line = document.getElementById('stage-line')!;
    expect(line.classList.contains('hidden'), 'السطر ظهر بحدث حقيقي').toBe(false);
    expect(document.getElementById('stage-pct')!.textContent).toBe('42%');
    expect(document.getElementById('stage-name')!.textContent?.trim()).not.toBe('');
  });
});
