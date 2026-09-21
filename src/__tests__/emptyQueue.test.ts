/* ── العطل الميداني 2026-09-21 — طابور فارغ يعلن عملاً لا وجود له ────────────
 *
 * **العطل المقيس**: عند فتح التطبيق بطابور فارغ كانت تظهر في «طابور المعالجة»
 * صفوف وهمية تقرأ كعمل جارٍ: `track_01_vocals.mp3` بنسبة `33%` وشريط تقدّم
 * و«1/3 جاري المعالجة...»، و`podcast_ep44.wav` «في الانتظار».
 *
 * **سببه المقيس** (لا بحدس): `index.html` كان يحمل صفَّي طابور **ترميزاً تصميمياً
 * ثابتاً**، و`restoreBatchState()` في `src/queue.ts` تُرجع مبكراً عند غياب
 * `hl.batch` **بلا أن تمسّ DOM** ⇒ فلا شيء يمحو الترميز، فيبقى ظاهراً في كل
 * إقلاع بطابور فارغ. والفرضية البديلة (استعادة من `hl.batch`) منفيّة بقياس:
 * سجلّ التطبيق لا يحوي سطر `batch restored after restart`، ولا مهمّة تعمل.
 *
 * **ما يقيسه هذا الملف** (كود الإنتاج `src/queue.ts` مقابل DOM من `index.html`):
 *   ١) ترميز الطابور لا يحمل **أي** اسم ملف ولا نسبة ولا نصّ معالجة.
 *   ٢) إقلاع بطابور فارغ ⇒ حالة فراغ صريحة، **وصفر** صفوف، وصفر «جارٍ المعالجة».
 *   ٣) نصّ الحالة الفارغة من جدول الترجمة (ar و en) لا محفوراً في الترميز.
 *   ٤) الإفراغ (`stopBatch`) يعلن الفراغ بدل شاشة صامتة.
 *   ٥) طابور حقيقي (ملفّان) ⇒ الصفوف الحقيقية وحدها، **ولا 33%** ولا نصّ معالجة
 *      لحالة انتظار (فالحالة الفارغة تُخفى، ولا يبقى ترميز وهمي).
 *
 * **ما لا يقيسه**: لا تطبيق Tauri عامل ولا Rust — المقيس سلوك الواجهة عند حدّ
 * الـIPC بطابور فارغ/حقيقي، لا مُجدوِل الخلفية. ولا لقطة بصرية (لا متصفّح هنا).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { ingestFiles, restoreBatchState, stopBatch } from '../queue';
import { i18n } from '../i18n';
import * as session from '../session';
import type { JobInfo } from '../jobs';

const A = 'C:\\Music\\Album\\track 01.mp3';
const B = 'D:\\Podcasts\\ep 44.wav';

/** أسماء/نسب الترميز الوهمي القديم — يجب ألّا تظهر في أي حالة. */
const PHANTOM = ['track_01_vocals.mp3', 'podcast_ep44.wav', '1/3', '33%'] as const;

function mountApp(): void {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
}

const list = (): HTMLElement => document.getElementById('batch-list') as HTMLElement;
const empty = (): HTMLElement => document.getElementById('batch-empty') as HTMLElement;
/** صفوف الطابور الحقيقية وحدها: `div[data-file]` (الحالة الفارغة ليست صفاً). */
const rows = (): HTMLElement[] => [...list().querySelectorAll<HTMLElement>('div[data-file]')];
const emptyVisible = (): boolean => !empty().classList.contains('hidden');
const text = (): string => list().textContent ?? '';
/** الترميز المشحون كما هو — يُقرأ في موضع التركيب وقبل أي `mountApp()`، فلا
 *  تكون كشوف الترميز ملوّثة بحالة اختبار سابق. (تقيس `indexHtml` المُستورَد
 *  لا الشجرة الحيّة — أُعلن ذلك في «ما لا يقيسه».) */
const staticDoc = (): Document =>
  new DOMParser().parseFromString(indexHtml as unknown as string, 'text/html');

vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

beforeEach(async () => {
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
  await vi.advanceTimersByTimeAsync(1200); // يُوقف المُستطلِع فلا يبقى مؤقّت مشتعل
  document.body.innerHTML = '';
  localStorage.clear();
});

/* ── ١) الترميز: لا صفّ ملف مكتوب بيد ─────────────────────────────────────── */
describe('ترميز طابور المعالجة لا يحمل صفّ ملف', () => {
  it('index.html لا يحمل أي صفّ طابور — الصفوف يبنيها renderBatchList وحده', () => {
    const doc = staticDoc();
    // الشرط على **العُقد** لا على النصّ الخام: تعليق يشرح العطل القديم يذكر
    // الأسماء الوهمية، ومحاسبته على تعليق ليست حارساً على ما يراه المستخدم.
    expect(doc.querySelectorAll('#batch-list div[data-file]')).toHaveLength(0);
    // ولا صفَّ بأي صنف طابور في الترميز (الترميز لا يبني صفوفاً أصلاً).
    expect(doc.querySelectorAll('#batch-list .batch-item')).toHaveLength(0);
    // ولا شريط تقدّم محفور (كان `#progress-bg` و`#progress-bar`).
    expect(doc.getElementById('progress-bg')).toBeNull();
    expect(doc.getElementById('progress-bar')).toBeNull();
  });

  it('ولا اسم ملف ولا نسبة محفورة في نصّ الترميز الظاهر (تعليقات HTML مستثناة)', () => {
    const doc = staticDoc();
    // النصّ الذي يراه المستخدم فعلاً = textContent للعُقد (لا يشمل التعليقات).
    const rendered = doc.getElementById('batch-list')!.textContent ?? '';
    for (const needle of PHANTOM) {
      expect(rendered, `«${needle}» في نصّ الطابور المحفور`).not.toContain(needle);
    }
    // وبالمثل في كامل الصفحة المحفورة ما عدا عناصر الترجمة التي يملؤها applyLang.
    const body = doc.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll('[data-i18n]').forEach((el) => el.replaceChildren());
    for (const needle of PHANTOM) {
      expect(body.textContent ?? '', `«${needle}» محفور في الصفحة`).not.toContain(needle);
    }
  });

  it('وحالة الفراغ موجودة في الترميز، ونصّها مربوط بالترجمة لا محفور', () => {
    const doc = staticDoc();
    const node = doc.getElementById('batch-empty');
    expect(node, '#batch-empty في الترميز').not.toBeNull();
    // الحالة **داخل قائمة الطابور** (مكانها الذي يراه المستخدم).
    expect(doc.getElementById('batch-list')!.contains(node)).toBe(true);
    // سطرا الحالة مربوطان بمفتاحَي ترجمة موجودَين في الجدولين.
    for (const key of ['queue_empty', 'queue_empty_add']) {
      expect(
        node!.querySelector(`[data-i18n="${key}"]`),
        `عنصر مربوط بـ${key}`,
      ).not.toBeNull();
      expect(i18n.ar[key as 'queue_empty']).toBeTruthy();
      expect(i18n.en[key as 'queue_empty']).toBeTruthy();
    }
    // والنصّ المطلوب حرفياً في العربية.
    expect(i18n.ar.queue_empty).toBe('لا ملفات في الطابور بعد');
    expect(i18n.ar.queue_empty_add).toMatch(/أفلت|رابط/);
  });
});

/* ── ٢) إقلاع بطابور فارغ: حالة فراغ صريحة وصفر ادّعاء ────────────────────── */
describe('إقلاع بطابور فارغ ⇒ حالة فراغ صريحة لا عمل وهمي', () => {
  it('لا صفّ، ولا نسبة، ولا «جارٍ المعالجة» — والحالة الفارغة ظاهرة', () => {
    restoreBatchState(); // ما يناديه init() عند كل إقلاع

    expect(rows(), 'صفر صفّ ملف').toHaveLength(0);
    expect(emptyVisible(), 'الحالة الفارغة ظاهرة').toBe(true);
    expect(text()).toContain(i18n.ar.queue_empty);
    expect(text()).toContain(i18n.ar.queue_empty_add);
    for (const needle of PHANTOM) {
      expect(text(), `«${needle}» في الطابور الفارغ`).not.toContain(needle);
    }
    // ولا ادّعاء عمل: لا نصّ معالجة ولا نصّ انتظار.
    expect(text()).not.toContain(i18n.ar.queue_processing);
    expect(text()).not.toContain(i18n.ar.queue_pending);
    // ولا شريط تقدّم (كان `#progress-bg` و`#progress-bar` في الترميز الوهمي).
    expect(document.getElementById('progress-bg')).toBeNull();
    expect(document.getElementById('progress-bar')).toBeNull();
  });

  it('ومهما تكرّر الإقلاع/الإفراغ لا يعود صفّ وهمي', async () => {
    restoreBatchState();
    restoreBatchState();
    await stopBatch();

    expect(rows()).toHaveLength(0);
    expect(emptyVisible(), 'بعد الإفراغ: الحالة الفارغة معروضة لا شاشة صامتة').toBe(true);
    for (const needle of PHANTOM) expect(text()).not.toContain(needle);
  });

  it('طابور فارغ ⇒ لا نسبة مئوية معروضة ولا شريط تقدّم في DOM الحيّ', () => {
    restoreBatchState();

    // النسب **المعروضة** (لا المخفيّة): صفّ وهمي بنسبة يكشفه هذا.
    const shownPct = [...list().querySelectorAll<HTMLElement>('.batch-pct')]
      .filter((el) => !el.classList.contains('hidden'))
      .map((el) => el.textContent);
    expect(shownPct, 'نسبة مئوية معروضة بطابور فارغ').toEqual([]);

    // شريط تقدّم معروض (كان `#progress-bg` و`#progress-bar` في الترميز الوهمي).
    expect(list().querySelectorAll('#progress-bg, #progress-bar')).toHaveLength(0);
    const shownBars = [...list().querySelectorAll<HTMLElement>('.batch-prog-wrap, .batch-prog-bg')]
      .filter((el) => !el.classList.contains('hidden'));
    expect(shownBars, 'شريط تقدّم معروض بطابور فارغ').toEqual([]);

    // ولا نمط نسبة مئوية في نصّ الطابور الظاهر (١-٣ أرقام + %).
    expect(text()).not.toMatch(/\d{1,3}\s*%/);
  });

  it('لا نصّ حالة لصفٍّ في طابور فارغ (وإن كان لصفٍّ حقيقي نصّه)', () => {
    restoreBatchState();
    expect(text()).not.toContain(i18n.ar.queue_pending);
    expect(text()).not.toContain(i18n.ar.queue_processing);

    // ضابط: القائمة نفسها **تقول** نصّ صفٍّ حقيقي لمّا يكون هناك صفّ حقيقي.
    // (والصفّ المنتظر يقول موضعه «دورك: 1» لا «في الانتظار» وحدها — م٣.)
    localStorage.setItem('hl.batch', JSON.stringify([{ f: A, s: 'pending' }]));
    restoreBatchState();
    expect(rows()).toHaveLength(1);
    expect(text()).toContain(i18n.ar.queue_wait_position.replace('{n}', '1'));
  });
});

/* ── ٣) الطابور الحقيقي كما هو: صفوفه وحدها، ولا 33% ──────────────────────── */
describe('طابور حقيقي ⇒ الصفوف الحقيقية وحدها', () => {
  it('ملفّان ⇒ صفّان باسمَيهما، والحالة الفارغة مُخفاة، ولا 33%', () => {
    localStorage.setItem('hl.batch', JSON.stringify([
      { f: A, s: 'pending' }, { f: B, s: 'pending' },
    ]));
    restoreBatchState();

    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.dataset.file)).toEqual([A, B]);
    expect(rows()[0].textContent).toContain('track 01.mp3');
    expect(rows()[1].textContent).toContain('ep 44.wav');
    expect(emptyVisible(), 'الحالة الفارغة مُخفاة مع وجود صفوف').toBe(false);
    // ولا النسبة الوهمية: صفّ منتظر لا نسبة له أصلاً.
    expect(text()).not.toContain('33%');
    // والنسبة في الصفوف **مخفية** ما لم تصل نسبة حقيقية من الخلف.
    expect(rows()[0].querySelector('.batch-pct')?.classList.contains('hidden')).toBe(true);
  });

  it('إفلات ملفّين حقيقيين ⇒ طابور بلا صفّ وهمي واحد', async () => {
    await ingestFiles([A, B]);

    expect(rows()).toHaveLength(2);
    expect(emptyVisible()).toBe(false);
    for (const needle of PHANTOM) expect(text()).not.toContain(needle);
    // والعدّاد يقول العدد الحقيقي (2) لا «1/3» الوهمي.
    const counter = document.getElementById('batch-counter');
    expect(counter?.textContent).toContain('2');
    expect(counter?.textContent).not.toContain('3');
  });

  it('مهمّة حيّة على صفٍّ حقيقي: النصّ «جارٍ المعالجة» يخصّه هو', async () => {
    const jobA: JobInfo = { id: 9, label: 'gui', path: A };
    h.invoke.mockImplementation(async (cmd) => (cmd === 'active_jobs' ? [jobA] : null));

    localStorage.setItem('hl.batch', JSON.stringify([{ f: A, s: 'pending' }]));
    restoreBatchState();
    await vi.advanceTimersByTimeAsync(1200); // نبضة استطلاع

    const row = rows()[0];
    expect(row.textContent).toContain('track 01.mp3');
    expect(row.textContent).toContain(i18n.ar.queue_processing);
    // والنصّ في صفٍّ **له مسار حقيقي** — لا في صفٍّ وهمي بلا مصدر.
    expect(row.dataset.file).toBe(A);
  });
});

/* ── ٤) الترجمة: الحالة الفارغة تتبع اللغة المختارة ───────────────────────── */
describe('نصّ الحالة الفارغة يتبع اللغة', () => {
  it('بالعربية: النصّ العربي؛ وبالإنجليزية: النصّ الإنجليزي', async () => {
    vi.resetModules();
    localStorage.setItem('hl.lang', 'en');
    const { applyLang, i18n: en } = await import('../i18n');
    applyLang();
    expect(empty().textContent).toContain(en.en.queue_empty);
    expect(empty().textContent).not.toContain(en.ar.queue_empty);

    vi.resetModules();
    localStorage.setItem('hl.lang', 'ar');
    const { applyLang: applyAr, i18n: ar } = await import('../i18n');
    applyAr();
    expect(empty().textContent).toContain(ar.ar.queue_empty);
  });
});
