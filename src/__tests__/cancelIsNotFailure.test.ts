/* ── عطل ميداني 2026-09-21 — «المهمّة الملغاة تُعرض ✗ فشل» ────────────────────
 *
 * **العطل مقيس بتشغيل التطبيق الحقيقي** (لا بفحص ساكن): طابور حقيقي بملفّين
 * وسقف ١، ثم إلغاء المهمّة وهي تعمل. خطّ DOM من التطبيق:
 * ```
 * 8.0s  uitest_long.wav 2% جاري المعالجة... [cancel]   ← ضغط المستخدم «إيقاف المهمّة»
 * 9.5s  uitest_long.wav ✗ فشل  ·  uitest_next.wav 90% جاري معالجة...
 * ```
 * وسجلّ الخلف في اللحظة نفسها يقول: `انتهت المهمة #5 (gui) بعد 1453ms — أُلغيت: true`
 * وواجهته تسجّل `ERROR frontend: batch item failed: … تم إلغاء المعالجة من قبل المستخدم.`
 * ⇒ **الإلغاء كان يُعرض ويُسجَّل فشلاً**، والخلف صادق. و`BatchItemState` لم تكن
 * فيه حالة إلغاء أصلاً، بينما مسار آخر في الملف نفسه يميّزها (`runOne`).
 *
 * **ما يحرسه هذا الملف**:
 *   ١) `isCancellation` تميّز رسالة الإلغاء عن الخطأ الحقيقي (دالّة صافية).
 *   ٢) الصفّ الملغى يُعرض **«⏹ أُلغيت»** ولا يُعرض «✗ فشل»، ولونه **غير أحمر**.
 *   ٣) نداء السجلّ له **`info`** لا `error`، ونصّه يقول إن المستخدم ألغى.
 *   ٤) الخطأ الحقيقي **يبقى** `fail` + `error` (فالإصلاح لم يُعمِ الرسالة).
 *   ٥) ملخّص الدفعة يميّز الملغى («ملغى 1») ولا يُحصيه فشلاً.
 *   ٦) **القرار الموثَّق**: الملغى **لا يُستأنَف** عند الإقلاع، ويبقى ظاهراً
 *      بوسم «أُلغيت» مع زرّ إعادة المحاولة.
 *
 * **ما لا يقيسه**: لا يشغّل التطبيق ولا Rust — النداءات وكلاء، والرسالة تُحاكى
 * بالحرف الذي قِيس في سجلّ المالك. ولا لقطة بصرية: «غير أحمر» = غياب صنف
 * `text-error`/`border-error`، لا حكم على اللون المعروض.
 *
 * ── مصدر العيّنة: **مربوطة بالكود، لا محفوظة من سجلّ** (ط-٤) ─────────────────
 * الجملة أعلاه كانت مثبَّتة كـ«مقيسة في سجلّ المالك (2026-09-21)» — أي **مرجع
 * تاريخي**: لو تغيّر نصّ الخلف لبقي الاختبار أخضر وهو يقيس نصّاً لم يعد يُصدَر.
 * فصارت العيّنة مربوطة بمصدرها بقياس (كتلة «العيّنة مطابقة لما يبنيه الرست»):
 *
 * | الحدّ | الموضع | ما يبنيه |
 * |---|---|---|
 * | بناء الإلغاء | `src-tauri/src/separator.rs:656-662` | `if !progress(…) { return Err(SepError::Cancelled); }` |
 * | ذراع العرض | `src-tauri/src/separator.rs:59` | `Self::Cancelled => write!(f, "{}", crate::pipeline::CANCELLED_BY_USER)` |
 * | نصّ الثابت | `src-tauri/src/pipeline.rs:76` | `pub const CANCELLED_BY_USER: &str = "تم إلغاء المعالجة من قبل المستخدم.";` |
 *
 * والثالث هو `CANCEL_MSG` **حرفياً**. فالحارس يسقط **باسم الموضع** إن غُيّر أحد
 * الحدود الثلاثة، بدل أن يشيخ بصمت.
 *
 * ── وكان السقوط الموعود قد وقع فعلاً (ط-٤، قياس 2026-09-25) ────────────────────
 * جدول الحدّين أعلاه كان `SepError::Inference("<الجملة>")` + بادئة
 * `Self::Inference(e) => write!(f, "خطأ استدلال النموذج: {e}")`، وكتبتُ عنده:
 * «`agent/x4-cancel` يُبدّل … ⇒ يسقط هذا الحارس حين يُدمج». وقد دُمج
 * (`rehearsal/owner-test` @ `0db0ade`) فسقط الحالتان **باسمهما**: الاشتقاق أعاد
 * `null` لأن البناء صار `return Err(SepError::Cancelled)` بلا نصّ، والبندول
 * `write!(f, "{}", …)` بلا بادئة. فالربط هنا **أُعيد إلى المصدر الجديد** ولم
 * يُرخَ: ثلاثة حدود مربوطة بدل حدّين، ولا واحد منها نصٌّ مكتوب بيد.
 *
 * **وحدّ معلَن**: كتلة الربط تقرأ **نصّ** الملف لا سلوكه — تحويلٌ ملتوٍ (اسم
 * مستعار، أو بناء الجملة في دالّة وسيطة) لا تراه، وهو موكول إلى المراجعة.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => null),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

import { ingestFiles, isCancellation, restoreBatchState, wireSeparate } from '../queue';
import { i18n } from '../i18n';
import * as session from '../session';

const A = 'C:\\Music\\Album\\uitest_long.wav';
const B = 'C:\\Music\\Album\\uitest_next.wav';

/** رسالة الخلف **كما هي اليوم** — لا «كما قيست في سجلّ المالك 2026-09-21» فقط:
 *  مُشتقّة من `src-tauri/src/separator.rs` (بناء `demix` + ذراع `Display`) ومن
 *  `src-tauri/src/pipeline.rs` (نصّ الثابت المطبوع)، وكتلة «العيّنة مطابقة لما
 *  يبنيه الرست» أسفل هذا الملف تُثبت التطابق عند **كل تشغيل** — فالعيّنة لا
 *  تشيخ بصمت. */
const CANCEL_MSG = 'تم إلغاء المعالجة من قبل المستخدم.';
const REAL_MSG = 'ffmpeg exited with code 1';

function mountApp(): void {
  document.body.innerHTML = (new DOMParser().parseFromString(indexHtml as string, 'text/html')).body.innerHTML;
}
const row = (f: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#batch-list div[data-file="${CSS.escape(f)}"]`);
const statusOf = (f: string): string => row(f)?.querySelector('.status-text')?.textContent ?? '';
/** كل نداءات السجلّ، بشكلها المُرسَل فعلاً. */
const logCalls = (): Array<{ level: string; message: string }> =>
  h.invoke.mock.calls
    .filter((c) => c[0] === 'push_log')
    .map((c) => c[1] as { level: string; message: string });

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
afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

/* ── ١) التمييز: دالّة صافية تُقاس على النصّين ─────────────────────────────── */
describe('الإلغاء يُميَّز عن الفشل — على النصّ نفسه', () => {
  it('رسالة الإلغاء المقيسة ⇒ تُعرف، ورسالة العطل ⇒ لا', () => {
    // رسالة الخلف الحقيقية من السجلّ، حرفياً:
    expect(isCancellation(CANCEL_MSG)).toBe(true);
    expect(isCancellation(REAL_MSG)).toBe(false);
    // وصور أخرى معقولة لكلمة الإلغاء (الخلف يبنيها بالعربية).
    expect(isCancellation('تم إلغاء المعالجة')).toBe(true);
    expect(isCancellation('Error: cancelled by user')).toBe(false); // إنجليزي: لا يُخمَّن
    expect(isCancellation(new Error(CANCEL_MSG))).toBe(true);
    expect(isCancellation(undefined)).toBe(false);
    expect(isCancellation(null)).toBe(false);
  });
});

/* ── ٢) الصفّ الملغى في طابور حقيقي ──────────────────────────────────────── */
describe('صفّ ملغى في دفعة حقيقية ⇒ «أُلغيت» لا «فشل»', () => {
  /** يشغّل دفعة على [A,B]، وأول نداء فصل يرمي الرسالة المعطاة.
   *  والمسار حقيقي: `ingestFiles([A,B])` تُبنى بها القائمة **ورowsها** ثم زرّ
   *  الفصل — وهو ما كان ينقص نسخة أولى فلم تُرسم صفوف أصلاً (أسقطها الحارس:
   *  `expected '' to be '⏹ أُلغيت'`، أي أن الحارس أمسك عطلاً في اختباري أنا). */
  async function runBatchWith(firstError: string): Promise<void> {
    wireSeparate();
    let call = 0;
    h.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'separate_file') {
        call += 1;
        if (call === 1) throw new Error(firstError);
        return { seconds: 1, vocals: `${A}.vocals.mp3` };
      }
      if (cmd === 'active_jobs') return [];
      return null;
    });
    await ingestFiles([A, B]);
    expect(row(A), 'صفّ الطابور مرسوم').not.toBeNull();
    document.getElementById('btn-separate')!.click();
    await vi.advanceTimersByTimeAsync(50);
  }

  it('النصّ «⏹ أُلغيت» · الحالة `cancelled` · ولا صنف خطأ', async () => {
    await runBatchWith(CANCEL_MSG);

    expect(statusOf(A), 'الصفّ الملغى').toBe(i18n.ar.sep_cancelled_short);
    expect(statusOf(A)).not.toContain(i18n.ar.sep_failed_short);
    expect(row(A)?.dataset.state, 'حالة الصفّ المُعلَنة').toBe('cancelled');
    // واللون **غير الأحمر**: لا صنف خطأ على الصفّ ولا على نصّ حالته.
    const span = row(A)?.querySelector('.status-text') as HTMLElement;
    expect(row(A)?.className).not.toContain('error');
    expect(span.className).not.toContain('text-error');
    // وزرّ إعادة المحاولة كما هو.
    expect(row(A)?.querySelector('.batch-actions button'), 'زرّ إعادة المحاولة').not.toBeNull();
  });

  it('ونداء السجلّ `info` بنصّ «أُلغيت من قبل المستخدم» — لا ERROR', async () => {
    await runBatchWith(CANCEL_MSG);

    const itemLogs = logCalls().filter((l) => l.message.includes(A));
    expect(itemLogs, 'سطر سجلّ للصفّ الملغى').toHaveLength(1);
    expect(itemLogs[0].level, 'مستوى السجلّ').toBe('info');
    expect(itemLogs[0].message).toContain('cancelled by user');
    // ولا سطر ERROR واحد في الدفعة كلها (الملف الثاني نجح).
    expect(logCalls().filter((l) => l.level === 'error'), 'لا ERROR على إلغاء').toEqual([]);
  });

  it('وملخّص الدفعة يميّز الملغى ولا يُحصيه فشلاً', async () => {
    await runBatchWith(CANCEL_MSG);

    const summary = logCalls().find((l) => l.message.startsWith('batch finished'));
    expect(summary, 'سطر ملخّص الدفعة').toBeTruthy();
    expect(summary!.message).toContain('1/2'); // المنجَز من المجموع
    expect(summary!.message).toContain('cancelled 1');
    expect(summary!.message).not.toContain('failed');
    expect(summary!.level, 'ملخّص بلا فشل ⇒ info').toBe('info');
    // والمعلومة نفسها في نصّ الواجهة.
    expect(document.getElementById('sep-result')?.textContent ?? '')
      .toContain(i18n.ar.batch_cancelled.replace('{n}', '1'));
  });

  it('والملف التالي يعمل: الطابور تقدّم ولم يتوقّف على الملغى', async () => {
    await runBatchWith(CANCEL_MSG);

    expect(statusOf(B), 'الملف التالي أُكمل').toBe(i18n.ar.sep_done_short);
    expect(row(B)?.dataset.state).toBe('ok');
  });

  it('ضابط: الخطأ الحقيقي يبقى `fail` + `error` (الإصلاح لم يُعمِ الرسالة)', async () => {
    await runBatchWith(REAL_MSG);

    expect(statusOf(A)).toBe(i18n.ar.sep_failed_short);
    expect(statusOf(A)).not.toContain(i18n.ar.sep_cancelled_short);
    expect(row(A)?.dataset.state).toBe('fail');
    const err = logCalls().find((l) => l.message.includes(`batch item failed: ${A}`));
    expect(err, 'سطر الخطأ الحقيقي').toBeTruthy();
    expect(err!.level).toBe('error');
    // والملخّص يحصيه فشلاً لا إلغاءً.
    const summary = logCalls().find((l) => l.message.startsWith('batch finished'));
    expect(summary!.message).toContain('failed 1');
    expect(summary!.message).not.toContain('cancelled');
  });
});

/* ── ٣) القرار الموثَّق: الملغى لا يُستأنَف ───────────────────────────────── */
describe('الاستعادة: الملغى لا يُستأنَف (قرار صريح موثَّق)', () => {
  it('ملغى مخزَّن ⇒ لا يدخل قائمة الاستئناف · ويُعرض «أُلغيت» · وزرّ إعادة المحاولة', () => {
    localStorage.setItem('hl.batch', JSON.stringify([{ f: A, s: 'cancelled' }]));
    restoreBatchState();

    // لا يدخل قائمة الجلسة ⇒ لا يُشغَّل عند الإقلاع.
    expect(session.getBatchQueue(), 'الملغى لا يُستأنَف').toEqual([]);
    // ولا يبقى في التخزين (انتهى دوره).
    expect(localStorage.getItem('hl.batch')).toBeNull();
    // ورسالة الفراغ تُعلَن (لا صفوف).
    expect(document.getElementById('batch-empty')?.classList.contains('hidden')).toBe(false);
  });

  it('والفاشل **يُستأنَف** — فالقرار يخصّ الملغى وحده', () => {
    localStorage.setItem('hl.batch', JSON.stringify([{ f: A, s: 'fail' }]));
    restoreBatchState();

    expect(session.getBatchQueue(), 'الفاشل يُستأنَف').toEqual([A]);
    expect(statusOf(A)).toBe(i18n.ar.sep_failed_short);
  });

  it('وخلط الحالتين: يُستأنَف الفاشل وحده، والملغى يُعرض بوسمه', () => {
    localStorage.setItem('hl.batch', JSON.stringify([
      { f: A, s: 'cancelled' }, { f: B, s: 'fail' },
    ]));
    restoreBatchState();

    expect(session.getBatchQueue(), 'الفاشل وحده').toEqual([B]);
    expect(localStorage.getItem('hl.batch')).toContain('"s":"fail"');
    expect(localStorage.getItem('hl.batch')).not.toContain('cancelled');
  });
});

/* ── ٤) العيّنة مطابقة لما يبنيه الرست (ط-٤): لا تشيخ بصمت ────────────────────
 *
 * **المُفسَد**: غيّر جملة الإلغاء في `src-tauri/src/separator.rs:644` (أو بادئة
 * `Display` في `:44`) بحرف واحد ⇒ تسقط الحالتان أدناه، الأولى باسم الموضع
 * والثانية بأن `isCancellation` لم تعد تعرف النصّ المُشتقّ.
 *
 * **ولماذا كتلة اختبار لا ثابت**: الثابت المكتوب بيد يشيخ بصمت — وهذا هو العطل
 * نفسه (النصّ تغيّر والتعليق بقي تاريخياً). فالاشتقاق من الملف هو ما يجعل
 * «كما هي اليوم» **دعوى مقيسة** لا جملة في تعليق.
 */
describe('العيّنة «كما هي اليوم» مُشتقّة من كود الرست', () => {
  /** جذر المستودع — **يُحسب من مسار الملف بلا `new URL`**، ولا يُبنى عنوان
   *  داخل حالة. وهو **ليس تجميلاً**: هذا الملف كان يستعمل
   *  `new URL(…, import.meta.url)` وقِيس في هذه البيئة أن الشكل الواحد يعطي
   *  ثلاثة نتائج مختلفة (‏2026-09-25 · `agent/texts2`):
   *
   *  | الصيغة | الموضع | المقيس |
   *  |---|---|---|
   *  | `new URL('../../' + RS, import.meta.url)` | متن `describe` | `file:///…/src-tauri/src/separator.rs` ✅ |
   *  | `new URL('../../', import.meta.url)` | متن `describe` | **مخطّط غير `file`** ⇒ `fileURLToPath` يرمي |
   *  | ``new URL(`../../src-tauri/src/${m}.rs`, import.meta.url)`` | داخل حالة | `file:///C:/src-tauri/src/pipeline.rs` ❌ |
   *
   *  والثالث هو العطب المقيس: الأساس المطبوع كان سليماً
   *  (`file:///C:/Code-backup/HaramMute%20Desktop%20III/wt-texts2/src/__tests__/…`)
   *  لكن `../../` حُسبت من `/C:/Code-backup/HaramMute` — أي أن الأساس انقطع عند
   *  **أول فراغ** في مسار المستودع. فصار `readFileSync` يفشل بـ`ENOENT`، **وكان
   *  `catch` يُعيد `null` صامتاً** فيظهر العطل كأنه «الحدّ تغيّر» لا كأنه «المسار
   *  خُطئ» — وهو أسوأ ما في حارس يشيخ (وأخذ هذا التشخيص أربع تشغيلات، لأن الأثر
   *  الظاهر كان مضلِّلاً).
   *
   *  **فالعلاج اثنان معاً**: المسار يُحسب من `import.meta.url` بـ`fileURLToPath`
   *  و`path` (لا `new URL`)، **والقراءة لا تُبتلع**: فشلُها يُسقط بـ`ENOENT` يسمّي
   *  الملف لا بـ`null` غامض. */
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  /** النصف الإنتاجي من `separator.rs` — كتلة `mod tests` تتكلّم عن الإلغاء
   *  بالضرورة (وفيها البناء المُفسَد)، فلا تُقرأ معه. */
  const SEPARATOR_RS = 'src-tauri/src/separator.rs';
  const src = readFileSync(join(REPO_ROOT, SEPARATOR_RS), 'utf8');
  const cut = src.indexOf('\nmod tests {');
  const production = cut < 0 ? src : src.slice(0, cut);

  const PIPELINE_RS = 'src-tauri/src/pipeline.rs';

  /** **النصّ الذي يبنيه الرست اليوم** — مُشتقّاً من الملفات لا مكتوباً بيد.
   *
   * الحدود الثلاثة المربوطة (ولا رابع):
   *   ① **بناء الإلغاء في `demix`**: البناء الذي يقول «نداء التقدّم قال توقّف»
   *      — `if !progress(…) { … return Err(SepError::<البديل>); }`.
   *      والربط **بالبناء لا بالجملة**: لولا `!progress` لطابقنا أول
   *      `SepError::Io(…)` في الملف. والبديل صار **بلا نصّ** بعد `0db0ade`
   *      (وهذا بعينه ما كان يُسقط الربط القديم)، فالالتقاط هنا **بلا وسيط**:
   *      `return Err(SepError::([A-Za-z]+));` — فلو أُعيد النصّ إلى البناء
   *      (وهو العطب الأصلي الذي أُصلح) لم يطابق نمطُنا ⇒ `null` ⇒ سقوط بالاسم.
   *   ② **ذراع العرض للبديل نفسه**: `Self::<البديل> => write!(f, "{}", <مسار ثابت>)`
   *      — بصيغة `{}` **وحدها وبلا بادئة**. فلو عادت بادئة
   *      «خطأ استدلال النموذج: {e}» (وهي التي جعلت الإلغاء يُقرأ عطباً) لم
   *      يطابق النمط ⇒ `null` ⇒ سقوط بالاسم.
   *   ③ **نصّ الثابت المطبوع** في `pipeline.rs` (`pub const … : &str = "…"`)
   *      — فالجملة تُقرأ من عرّافها لا من ذراع العرض.
   *
   * وتُرجع `null` إن لم يعد أحد الحدود قائماً — فيسقط الاختبار **برسالة تُسمّي
   * ما يُعاد قياسه** بدل نجاح فارغ. */
  function deriveCancelMessage(): { variant: string; constant: string; text: string } | null {
    // ① موضع الإلغاء: `!progress(…)` ⇒ `return Err(SepError::<البديل>);` بلا نصّ.
    const built = /if\s*!progress\([^)]*\)\s*\{[\s\S]{0,400}?return Err\(SepError::([A-Za-z]+)\);/
      .exec(production);
    if (!built) return null;
    const variant = built[1];

    // ② ذراع العرض: يطبع `{}` من مسار ثابت، بلا بادئة.
    const arm = new RegExp(
      `Self::${variant}\\s*=>\\s*write!\\(f,\\s*"\\{\\}"\\s*,\\s*([A-Za-z_][A-Za-z0-9_:]*)\\)`,
    ).exec(production);
    if (!arm) return null;

    // المسار المطبوع ⇒ (وحدة، ثابت). والثابت يُشترط أن يكون باسم ثابت
    // (`SCREAMING_SNAKE`) — وإلا لطابقنا نداء دالّة صغيرة وقرأنا منها نصّاً.
    const path = arm[1];
    const constant = path.split('::').pop() ?? '';
    if (!/^[A-Z][A-Z0-9_]*$/.test(constant)) return null;
    const modulePath = path.replace(/^crate::/, '').split('::').slice(0, -1);
    if (modulePath.length === 0) return null;

    // ③ نصّ الثابت من عرّافه. والقراءة **بلا `catch`**: مسارٌ خاطئ يجب أن يُسقط
    //    بـ`ENOENT` يسمّي الملف، لا بـ`null` يُقرأ «الحدّ تغيّر».
    const constSrc = readFileSync(join(REPO_ROOT, 'src-tauri/src', ...modulePath) + '.rs', 'utf8');
    const decl = new RegExp(`pub const ${constant}\\s*:\\s*&str\\s*=\\s*"([^"]*)";`).exec(constSrc);
    if (!decl) return null;

    return { variant, constant, text: decl[1] };
  }

  it('النصّ المُشتقّ من separator.rs وpipeline.rs هو CANCEL_MSG نفسه (وإلا فقد شيخ)', () => {
    const r = deriveCancelMessage();
    expect(
      r,
      `لم يُشتقّ نصّ الإلغاء من ${SEPARATOR_RS} + ${PIPELINE_RS} — تغيّر أحد الحدود ` +
        'الثلاثة: بناء الخطأ عند حدّ الإلغاء في `demix` (‏`!progress` ⇒ ' +
        '`return Err(SepError::…);` بلا نصّ)، أو ذراع `Display` لبديله (‏`write!(f, ' +
        '"{}", <مسار ثابت>)` بلا بادئة)، أو نصّ الثابت في `pipeline.rs`. ' +
        'أعِد قراءة الملفين وحدّث CANCEL_MSG واشتقاق هذا الاختبار معه.',
    ).not.toBeNull();
    expect(
      r!.text,
      `النصّ الذي يبنيه الرست اليوم (${SEPARATOR_RS} · SepError::${r!.variant} ⇒ ` +
        `${PIPELINE_RS} · ${r!.constant})`,
    ).toBe(CANCEL_MSG);
  });

  it('و`isCancellation` تعرف النصّ المُشتقّ — عقد الواجهة مع الخلف', () => {
    const r = deriveCancelMessage();
    expect(r, `الاشتقاق من ${SEPARATOR_RS} (انظر الحالة السابقة)`).not.toBeNull();
    // نصّ الخلف **بلا بادئة بعد `0db0ade`**، وهو نفسه ما يُصدره `pipeline` في
    // كل مسارات الإلغاء (`CANCELLED_BY_USER` ثابتٌ واحد) ⇒ نصّ واحد يُعرف إلغاءً.
    expect(isCancellation(r!.text), 'نصّ الخلف كما يبنيه اليوم').toBe(true);
  });
});
