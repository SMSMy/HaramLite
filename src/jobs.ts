/* ── سِجلّ المهامّ الخلفية: الهويّة والمطابقة والإلغاء (م٢) ───────────────────
 * العطل المقيس الذي وُلد هذا الملف منه: زرّ الإلغاء في بطاقة الملف
 * (`src/queue.ts:242`) كان ينادي `cancel_process` — **علمٌ عامّ لكل التطبيق**
 * لا يعرف أيّ مهمّة يقصد ⇒ إمّا يُلغي كل شيء وإمّا لا يُلغي شيئاً. والخلفية
 * صارت تُعرِّف كل مهمّة (`JobInfo`) بـ`id` و`label` و`path` (مسار الإدخال)،
 * فالواجهة تقدر أن تطلب إلغاء **مهمّة بعينها**.
 *
 * **العقد المُجمَّد** (الخلف، `src-tauri/src/slots.rs` + أوامر Tauri):
 *   struct JobInfo { id: u64, label: String, path: Option<String>, started_ms: u64 }
 *   active_jobs()      -> Vec<JobInfo>
 *   cancel_job(id)     -> bool      (false = لا مهمّة بهذا المعرّف)
 *   cancel_all_jobs()  -> usize
 * و`label` ∈ "gui" | "cli" | "bridge" | "watch" | "telegram"، و`path` هو **مسار
 * الإدخال** ⇒ تُطابَق عناصر الطابور بالمهامّ عبر المسار.
 *
 * **ما هذا الملف**: منطق نقيّ بلا DOM وبلا استيراد (لا `invoke` ولا `t`):
 * تطبيع المسار · اختيار المهمّة التي يخصّها صفّ الطابور · تحديد هدف زرّ
 * الإيقاف · قراءة السِجلّ (بحالة فشل صريحة) · طلب الإلغاء **لمهمّة واحدة**
 * · وترجمة النتيجة إلى مفتاح رسالة. وكل نداء للخلف يمرّ عبر `JobInvoker`
 * مُمرَّر، فيُختبر السلوك بنداء وهمي بلا تشغيل التطبيق.
 *
 * **حدّ صريح**: هذا الملف لا يعرف شيئاً عن DOM ولا عن الطابور المحلي — الربط
 * في `src/queue.ts`، والاختبار الحيّ للواجهة (نقر حقيقي على الزر في تطبيق
 * عامل) **لم يُجرَ** (لا تشغيل للتطبيق في هذه الجولة).
 */

/** صورة مهمّة نشطة. الحقول غير المعرّفة optional عن قصد: نسخة خلفية قديمة لا
 *  تُرسل `path`، وغيابه يجب أن يُقرأ «لا أعرف مساره» لا «يطابق كل مسار». */
export interface JobInfo {
  id: number;
  label: string;
  /** مسار الإدخال — وعاؤه هو ما يُطابَق مع عناصر الطابور. */
  path?: string | null;
  /** طابع البدء (ميلي ثانية): يشمل زمن انتظار فتحة الفصل. */
  started_ms?: number;
}

/** وسوم المصدر في العقد المجمَّد. */
export type JobLabel = 'gui' | 'cli' | 'bridge' | 'watch' | 'telegram';

/* ── تطبيع المسار ────────────────────────────────────────────────────────
 * ويندوز لا يفرّق بين `C:\Music\a.mp3` و`c:/music/A.MP3` — وهما **الملف
 * نفسه**. والخلفية والواجهة قد تختلفان في الشكل: الواجهة تأخذ المسار من
 * مربّع النصّ/الإفلات، والخلفية من `PathBuf` الذي قد يخرج بفواصل مائلة أو
 * بادئة مسار موسَّع (`\\?\`). فالمقارنة الحرفية تفشل في الحالات الواقعية كلها
 * تقريباً ⇒ التطبيع خطوة لازمة لا تجميل.
 *
 * **ما لا يفعله التطبيع (بصراحة)**: لا يحلّ الروابط الرمزية ولا يوحّد `8.3`
 * ولا المسار النسبي مقابل المطلق، ولا يزيل النقطة/المسافة الطرفية التي
 * يتجاهلها ويندوز. فمساران لنفس الملف بصيغتين غير مغطّاتين هنا لا يتطابقان.
 */
export function normalizeJobPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  let p = raw.trim();
  if (!p) return '';
  // بادئة المسار الموسَّع: \\?\C:\x و//?/C:/x هما C:\x نفسه.
  p = p.replace(/^\\\\\?\\/, '').replace(/^\/\/\?[\\/]/, '');
  // فاصل واحد موحّد (خلفي) — يشمل الفواصل المكرّرة.
  p = p.replace(/[\\/]+/g, '\\');
  // فاصل أخير زائد: C:\Music\ = C:\Music (والجذر "C:\" يصير "c:")
  p = p.replace(/\\+$/, '');
  // ويندوز لا يفرّق في حالة الأحرف. toLowerCase() في JS غير متعلّقة باللغة
  // (بخلاف toLocaleLowerCase) فلا تفخّخ بحسب لغة النظام.
  return p.toLowerCase();
}

/** هل الإدخال مهمّة صالحة للاستعمال (معرّف رقمي)؟ */
function asJobInfo(raw: unknown): JobInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'number' ? o.id : Number(o.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    label: typeof o.label === 'string' ? o.label : '',
    path: typeof o.path === 'string' ? o.path : null,
    started_ms: typeof o.started_ms === 'number' ? o.started_ms : undefined,
  };
}

/** هل هذه مهمّة الواجهة (الطابور يملكها)؟ الوسم يُقارَن بلا حساسية لحالة الأحرف. */
export function isGuiJob(job: JobInfo | null | undefined): boolean {
  return String(job?.label ?? '').toLowerCase() === 'gui';
}

function jobsArray(jobs: readonly JobInfo[] | null | undefined): JobInfo[] {
  return Array.isArray(jobs) ? jobs.filter((j): j is JobInfo => asJobInfo(j) !== null) : [];
}

/** المهمّة التي تخصّ هذا المسار — أو `null` بصراحة إن لم توجد.
 *
 * عند تعدّد المطابقات يُقدَّم **وسم `gui`** (مهمّة الطابور نفسها) على غيره،
 * ثم **الأقدم بدءاً** (أصغر `id`) — فالقرار حتميّ لا يعتمد على ترتيب القراءة.
 * ومسار غائب/فارغ لا يطابق شيئاً أبداً (وإلا صار كل صفٍّ بلا مسار مطابقاً
 * لكل مهمّة بلا مسار). */
export function jobForPath(
  jobs: readonly JobInfo[] | null | undefined,
  path: string | null | undefined,
): JobInfo | null {
  const want = normalizeJobPath(path);
  if (!want) return null;
  const matches = jobsArray(jobs).filter((j) => normalizeJobPath(j.path) === want);
  if (!matches.length) return null;
  const gui = matches.filter(isGuiJob);
  const pool = gui.length ? gui : matches;
  return pool.slice().sort((a, b) => a.id - b.id)[0];
}

/** المهمّة التي يستهدفها **زرّ الإيقاف الثابت**.
 *
 * القاعدة: المهمّة **المعروضة** أولاً (مسار الصفّ الجاري أو مسار التشغيل
 * المفرد) — وهي التي يسمّيها الشريط في `#stop-target` — وإلا **أقدم مهمّة
 * نشطة** (فيسمّيها الشريط أيضاً، فلا يُلغي زرٌّ مهمّةً لم تُعرَض على المستخدم).
 * وهذا ما يجعل «الزر يُلغي المهمّة المعروضة» صادقاً في الحالتين. */
export function stopTarget(
  jobs: readonly JobInfo[] | null | undefined,
  displayedPath: string | null | undefined,
): JobInfo | null {
  const all = jobsArray(jobs).slice().sort((a, b) => a.id - b.id);
  if (!all.length) return null;
  return jobForPath(all, displayedPath) ?? all[0];
}

/** اسم مختصر للمهمّة يُعرض في الشريط: الوسم + اسم الملف (أو «بلا مسار»). */
export function jobDisplayName(job: JobInfo | null | undefined): string {
  if (!job) return '';
  const label = String(job.label || '?');
  const p = typeof job.path === 'string' ? job.path : '';
  if (!p.trim()) return label;
  const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return base ? `${label} · ${base}` : label;
}

/* ── قراءة السِجلّ ───────────────────────────────────────────────────────
 * الفشل **حالة صريحة** لا صفر مهمّات: واجهة تقول «لا مهامّ» لأن النداء فشل
 * تكذب على المستخدم، وهو ما يمنعه هذا النوع. */
export type JobsRead = { ok: true; jobs: JobInfo[] } | { ok: false; error: string };

/** ينادي `active_jobs()`: ينجح بمصفوفة، أو يفشل برسالة صريحة.
 * (ردّ غير مصفوفة = فشل أيضاً: العقد يقول `Vec<JobInfo>`.) */
export async function fetchActiveJobs(
  invoker: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<JobsRead> {
  try {
    const raw = await invoker('active_jobs');
    if (!Array.isArray(raw)) {
      return { ok: false, error: `active_jobs returned ${raw === null ? 'null' : typeof raw}` };
    }
    return { ok: true, jobs: raw.map(asJobInfo).filter((j): j is JobInfo => j !== null) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** دالة النداء للخلف — يمرّرها المستدعي (وفي الاختبار: دالة وهمية تُسجّل النداءات). */
export type JobInvoker = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** نتيجة طلب الإلغاء — أربع حالات صريحة، ولا واحدة منها «نجاح» بلا دليل. */
export type CancelOutcome =
  /** مهمّة بعينها: `requested` = ما قالته الخلفية (`true` طُلب، `false` انتهت قبل الطلب). */
  | { kind: 'job'; id: number; requested: boolean }
  /** لا مهمّة خلفية لهذا المسار ⇒ إلغاء محلي، **بلا** أي إلغاء عام. */
  | { kind: 'local' }
  /** تعذّرت قراءة السِجلّ ⇒ لا نعرف، ولا ندّعي. */
  | { kind: 'registry-error'; error: string }
  /** عُرفت المهمّة وفشل نداء الإلغاء نفسه. */
  | { kind: 'cancel-error'; id: number; error: string };

/** إلغاء مهمّة **بمعرّفها** — للهدف الذي يسمّيه الشريط بلا صفّ يقابله.
 *  ولا `cancel_process` هنا أيضاً: إلغاء معرّف لا يعني إلغاء التطبيق. */
export async function cancelJobById(invoker: JobInvoker, id: number): Promise<CancelOutcome> {
  if (!Number.isFinite(id)) return { kind: 'local' };
  try {
    const ok = await invoker('cancel_job', { id });
    return { kind: 'job', id, requested: ok === true };
  } catch (e) {
    return { kind: 'cancel-error', id, error: String(e) };
  }
}

/** طلب إلغاء **مهمّة واحدة** تخصّ هذا المسار.
 *
 * الترتيب: اقرأ السِجلّ ⇒ طابِق المسار ⇒ `cancel_job(id)`.
 * ولا يُنادى `cancel_process` العامّ في أي فرع — لا عند غياب المهمّة ولا عند
 * فشل النداء (وإلا صار إلغاء صفٍّ واحد إلغاءً لكل التطبيق). */
export async function cancelPath(
  invoker: JobInvoker,
  path: string | null | undefined,
): Promise<CancelOutcome> {
  const reg = await fetchActiveJobs(invoker);
  if (!reg.ok) return { kind: 'registry-error', error: reg.error };
  const job = jobForPath(reg.jobs, path);
  if (!job) return { kind: 'local' };
  return cancelJobById(invoker, job.id);
}

/* ── ترجمة النتيجة إلى رسالة (المفاتيح كلها في `src/i18n.ts` بالجدولين) ── */
export type CancelMessageKey =
  | 'stop_requested'
  | 'stop_job_gone'
  | 'stop_local_queued'
  | 'stop_registry_failed'
  | 'stop_cancel_failed';

export interface CancelMessage {
  key: CancelMessageKey;
  vars: Record<string, string | number>;
  tone: 'ok' | 'warn' | 'error';
}

/** رسالة كل حالة — بلا تلطيف: الفشل يُقال، وغياب المهمّة يُقال، والنجاح
 *  يُقال بحدوده («جارٍ الإيقاف…» لا «أُوقف»: الطلب سُجِّل، والتنفيذ على
 *  مرحلتين في الخلف). */
export function cancelMessage(outcome: CancelOutcome): CancelMessage {
  switch (outcome.kind) {
    case 'job':
      return outcome.requested
        ? { key: 'stop_requested', vars: {}, tone: 'ok' }
        : { key: 'stop_job_gone', vars: {}, tone: 'warn' };
    case 'local':
      return { key: 'stop_local_queued', vars: {}, tone: 'warn' };
    case 'registry-error':
      return { key: 'stop_registry_failed', vars: { error: outcome.error }, tone: 'error' };
    case 'cancel-error':
      return { key: 'stop_cancel_failed', vars: { error: outcome.error }, tone: 'error' };
  }
}

/* ── سقف الإيقاف المُعلَن ─────────────────────────────────────────────────
 * الإلغاء **على مرحلتين** (قرار المالك، `ARCHIVE/m2-design.md` §١): العمليات
 * المنفصلة (`ffmpeg`/`yt-dlp`) تُقتل فوراً، ونداء الاستدلال داخل العملية
 * **لا يُقطع** بل يُهجَر عند أول حدّ. فالواجهة تقول حدّاً، ولا تقول «فوراً».
 *
 * الرقم **مقيس لا مخترع**: أطول نداء استدلال مسجَّل في المشروع 140.208 ث
 * (`inference_ms=140208`، سجلّ المالك، منقول في `ARCHIVE/m2-design.md:15`)
 * ⇒ 141 ث بترفيع إلى الثانية الصحيحة. ولذلك نصّ الواجهة يقول «أطول ما قيس».
 *
 * **حدّ أمانة**: هذا أطول ما قيس، **لا حدّ رياضي** — نداء استدلال أطول
 * (ملفّ أطول، أو بناء تصحيح: قيس 33.5 ث لملف 60 ث مقابل 3.7 ث في بناء
 * الإصدار) يتجاوزه. فالرقم سقف على المقيس، والصدق في وصفه لا في الرقم وحده. */
export const STOP_CEILING_SECS = 141;

/* ── مواءمة حالة صفّ الطابور مع السِجلّ ───────────────────────────────────
 * العطل المقيس: حالة الصفّ محليّة بحتة (`batchStatus` + `hl.batch`)، والخلفية
 * لا تُسأل. فصفٌّ حُفظ `run` وبقيت مهمّته حيّة (إعادة تحميل الواجهة، أو انقطاع
 * الواجهة وحدها) يُعاد بناؤه «في الانتظار» (`queue.ts:170-172` تكتب pending
 * لكل الصفوف) — أي أن الشاشة تقول غير ما في الخلفية. وبالعكس: صفٌّ يبقى `run`
 * بنسبته الأخيرة بعد أن ماتت مهمّته لا يُصحّحه شيء، لأن النسبة لا تُرسم إلا
 * على حدث `sep-progress` (`queue.ts:356-374`). */
export type QueueItemState = 'pending' | 'run' | 'ok' | 'fail';

export interface ReconcileResult {
  /** الحالة التي يجب أن تُعرض. */
  state: QueueItemState;
  /** هل تغيّرت عن الحالة المحليّة؟ */
  changed: boolean;
  /** صفٌّ ادّعى أنه يعمل ولا مهمّة له ⇒ تُصفَّر نسبته المعروضة. */
  stale: boolean;
}

/** الحالة الصحيحة للصفّ: `hasJob` من السِجلّ، و`inFlight` = نداء الفصل لهذا
 *  الملف ما زال معلّقاً في الواجهة (فبين `markBatchItem('run')` وتسجيل
 *  المهمّة في الخلف نافذة زمنية لا يجوز أن تُقرأ «انتهت»).
 *
 * حالات لا تُمسّ (بصراحة): الصفّ `ok`/`fail` نهائي ولا يُرجَع إلى `run` ولو
 * وُجدت مهمّة بنفس المسار — فقد تكون مهمّة جديدة لمهمّة ملفٍّ أُعيد تشغيله. */
export function reconcileItemState(
  local: QueueItemState,
  hasJob: boolean,
  inFlight: boolean,
): ReconcileResult {
  if (hasJob && local === 'pending') return { state: 'run', changed: true, stale: false };
  if (!hasJob && local === 'run' && !inFlight) return { state: 'pending', changed: true, stale: true };
  return { state: local, changed: false, stale: false };
}
