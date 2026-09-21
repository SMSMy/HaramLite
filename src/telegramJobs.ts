/* ── مهامّ بوت تيليجرام في «وظائف خارجية» (م٣-واجهة) ────────────────────────
 * العطل المقيس الذي وُلد هذا الملف منه: قسم «وظائف خارجية» كان يعرض مهمّات
 * الجسر والمراقبة وحدهما (`src/integration.ts:27` — `ExtKind = 'bridge' | 'watch'`)
 * وبوت تيليجرام **لا يُصدِر أي حدث لهذه القائمة** ⇒ مهامّ البوت — ومعها قائمة
 * انتظارها كاملة — **غير مرئية في الواجهة إطلاقاً**. شكوى المالك:
 * «قائمة وظائف خارجية لإضافة المتصفح فقط؟! المفترض أنها تضمّ أيضاً عمليات تلغرام
 * مع قائمة الانتظار بالكامل».
 *
 * **العقد المُجمَّد** (يبثّه Rust على الحدث `telegram-jobs`):
 *   type TelegramJob = {
 *     chat_id: number; user: string; file: string;
 *     state: 'queued' | 'running' | 'done' | 'failed';
 *     position: number; total: number; pct: number | null;
 *   };
 *   listen<TelegramJob[]>('telegram-jobs', …)   ← **لقطة كاملة** عند كل تغيّر
 *                                                 حالة فعلي، لا فرق تراكمي
 *
 * **ما هذا الملف**: منطق نقيّ بلا DOM وبلا `t` (على نمط `src/jobs.ts`): يحوّل
 * اللقطة إلى صفوف عرض، نصّها **مفتاح ترجمة + وسائطه** (والرسم في
 * `src/integration.ts`)، ويحكم الترتيب والحدّ الأقصى والإزالة بعد الانتهاء.
 * والوقت يُمرَّر (`now`) فلا مؤقّت داخل الدوال النقيّة — المؤقّت في integration.ts.
 *
 * **ثلاثة قرارات صريحة** (لأن العقد ساكت عنها):
 *   ١) سلّم `pct`: العقد لا يقول أكسرٌ هو (0..1) أم نسبة مئوية (0..100).
 *      والقائم في هذا التطبيق كسورٌ (`dl-progress`/`sep-progress` تُرسل 0..1
 *      وRust يقصّها بـ`clamp(0.0, 1.0)`، و`telegram.rs:1355` يحسب العرض من كسر)
 *      ⇒ ما ≤ 1 يُقرأ كسراً، وما > 1 يُقرأ نسبةً مئوية جاهزة. ولا رقم يُخترع عند
 *      `null`: الغياب يعني «لا نسبة» فلا يُطبع صفر.
 *   ٢) المفتاح: `chat_id` + اسم الملف (وبلا `chat_id` يُستعمل `?`)، وتكرار المفتاح
 *      داخل اللقطة يُلحَق بـ`#2` و`#3` فلا تُدمج مهمّتان في صفّ واحد.
 *   ٣) `chat_id` **لا يُعرض أبداً** (معلومة داخليّة)، واسم الملف يُقصّ إلى آخر
 *      مقطع من المسار — الخصوصية وعدٌ في العقد، فيُنفَّذ هنا لا في الرسم.
 *
 * **حدّ صريح**: لا شيء هنا يقيس البوت الحقيقي — لا تشغيل لتطبيق في هذه الجولة،
 * والعقد مُختبَر بلقطة مزيّفة بنفس شكله (انظر `src/__tests__/extJobsFeed.test.ts`).
 */

/** حالات المهمّة في العقد المجمَّد. */
export type TelegramJobState = 'queued' | 'running' | 'done' | 'failed';

/** مهمّة واحدة كما تبثّها الخلفية — **بلا تغيير**. */
export interface TelegramJob {
  chat_id: number;
  /** اسم مُرسِل الملف (أو معرّفه النصّي). */
  user: string;
  /** اسم الملف المعروض (بلا مسار كامل). */
  file: string;
  state: TelegramJobState;
  /** موضعه في قائمة الانتظار (1 = التالي). */
  position: number;
  /** عدد مهامّ تلك المحادثة. */
  total: number;
  /** تقدّم المعالجة إن كانت جارية (والغياب يعني «لا نسبة»). */
  pct: number | null;
}

/** مفاتيح نصوص التفصيل — كلها موجودة في جدولَي الترجمة (`src/i18n.ts`). */
export type TelegramDetailKey =
  | 'queue_wait_position'
  | 'queue_wait_unknown'
  | 'ext_tg_running'
  | 'ext_tg_running_pct'
  | 'ext_tg_done'
  | 'ext_tg_failed';

/** صفّ معروض في «وظائف خارجية» — مشتقّ من مهمّة، وبلا `chat_id`. */
export interface TelegramRow {
  /** مفتاح ثابت للصفّ (يمنع تكراره ويُتيح تحديثه في مكانه). */
  key: string;
  /** الاسم المعروض: مُرسِل الملف. */
  name: string;
  /** اسم الملف المعروض — بلا مسار. */
  file: string;
  state: TelegramJobState;
  detailKey: TelegramDetailKey;
  vars: Record<string, string | number>;
  /** نسبة معروضة (0..100) أو `null` — ولا صفر مكان الغياب. */
  pct: number | null;
  /** الموضع الصالح (1 فأكثر) أو `null` — فلا «دورك: 1» بلا موضع مقيس. */
  position: number | null;
  /** زمن أول رؤية للحالة النهائية (للإزالة بعد مهلة)، أو `null` لصفٍّ نشط. */
  finishedAt: number | null;
}

/** أقصى عدد صفوف تلغرام معروضة (والباقي يُشار إليه بـ«+N أخرى») — قائمة
 *  الواجهة ضيّقة، والقائمة التي تنمو بلا حدّ تدفع بقية القسم خارج الشاشة. */
export const TELEGRAM_MAX_ROWS = 5;

/** مهلة بقاء الصفّ المنتهي على الشاشة: تكفي لقراءة النتيجة، ثم يُزال. */
export const TELEGRAM_FINISHED_TTL_MS = 8000;

const STATES: readonly TelegramJobState[] = ['queued', 'running', 'done', 'failed'];

/** هل هذه الحالة نهائية (نجحت أو فشلت)؟ */
export function isFinishedState(state: TelegramJobState): boolean {
  return state === 'done' || state === 'failed';
}

/** آخر مقطع من مسار — **ولا شيء غيره**: مسارٌ يصل كاملاً بالخطأ لا يُعرض. */
export function displayedFileName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  const cut = s.replace(/[\\/]+$/, '');
  return cut.split(/[\\/]/).pop() ?? '';
}

/** النسبة المعروضة (0..100 عدداً صحيحاً) أو `null` عند الغياب/اللاصلاحية.
 *  `null` ليست صفراً: لا يُطبع «0%» لما لا نسبة له (ولا العكس). */
export function percentOf(pct: unknown): number | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const v = pct <= 1 ? pct * 100 : pct; // كسر 0..1 (القائم في التطبيق) أو نسبة جاهزة
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** الموضع الصالح (1 = التالي) أو `null`: صفر/NaN/غائب لا يُترجَم إلى «دورك: 1». */
export function rankOf(job: TelegramJob): number | null {
  const p = job.position;
  return typeof p === 'number' && Number.isFinite(p) && p >= 1 ? Math.floor(p) : null;
}

/** يقرأ مهمّة من حِمل الحدث — أو `null` بصراحة إن كانت غير مقروءة.
 *  وغياب حقل واحد يُسقط **الصفّ وحده**، لا اللقطة كلها. */
export function asTelegramJob(raw: unknown): TelegramJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.state !== 'string' || !STATES.includes(o.state as TelegramJobState)) return null;
  const chat = typeof o.chat_id === 'number' ? o.chat_id : Number(o.chat_id);
  const user = typeof o.user === 'string' ? o.user.trim() : '';
  const file = displayedFileName(o.file);
  if (!user && !file) return null; // صفٌّ بلا اسم ولا ملف لا يقول شيئاً لأحد
  return {
    chat_id: Number.isFinite(chat) ? chat : Number.NaN,
    user,
    file,
    state: o.state as TelegramJobState,
    position: typeof o.position === 'number' ? o.position : Number(o.position),
    total: typeof o.total === 'number' ? o.total : Number(o.total),
    pct: typeof o.pct === 'number' ? o.pct : null,
  };
}

/** مفتاح الصفّ: المحادثة والملف (و`chat_id` غائب ⇒ `?`) — داخليّ لا يُعرض. */
export function telegramKey(job: TelegramJob): string {
  const chat = Number.isFinite(job.chat_id) ? String(job.chat_id) : '?';
  return `telegram:${chat}:${job.file || job.user}`;
}

/** نصّ التفصيل: مفتاح + وسائطه — **بلا نسبة كاذبة وبلا موضع مُخترع**. */
function detailOf(job: TelegramJob, pct: number | null): Pick<TelegramRow, 'detailKey' | 'vars'> {
  switch (job.state) {
    case 'queued': {
      const n = rankOf(job);
      return n === null
        ? { detailKey: 'queue_wait_unknown', vars: {} }
        : { detailKey: 'queue_wait_position', vars: { n } };
    }
    case 'running':
      return pct === null
        ? { detailKey: 'ext_tg_running', vars: {} }
        : { detailKey: 'ext_tg_running_pct', vars: { pct } };
    case 'done':
      return { detailKey: 'ext_tg_done', vars: {} };
    case 'failed':
      return { detailKey: 'ext_tg_failed', vars: {} };
  }
}

/** صفّ عرض من مهمّة. `prevFinishedAt` يُمرَّر للصفّ نفسه كي **لا تُعاد** مهلة
 *  الإزالة مع كل لقطة تحتويه (وإلا بقي على الشاشة أبداً). */
export function telegramRowOf(job: TelegramJob, now: number, prevFinishedAt: number | null = null): TelegramRow {
  const pct = job.state === 'running' ? percentOf(job.pct) : null;
  // القصّ إلى آخر مقطع يُعاد هنا أيضاً (لا عند القراءة فقط): وعد الخصوصية لا
  // يجوز أن يعتمد على أن المستدعي مرّر مهمّة مُطبَّعة.
  const file = displayedFileName(job.file);
  return {
    key: telegramKey(job),
    name: job.user || file,
    file,
    state: job.state,
    ...detailOf(job, pct),
    pct,
    position: rankOf(job),
    finishedAt: isFinishedState(job.state) ? (prevFinishedAt ?? now) : null,
  };
}

/** أولوية الحالة عند **تساوي الموضع**: ما يقع الآن قبل ما ينتظر. (لا يُقاس
 *  هذا الترتيب إلا عند التساوي: الموضع من العقد هو الفاصل الأول.) */
const STATE_ORDER: Record<TelegramJobState, number> = { running: 0, queued: 1, done: 2, failed: 3 };

/** ترتيب العرض: **النشطة أولاً بموضعها** (1 = التالي)، ثم المنتهية (نتيجتها
 *  تُقرأ آخر القائمة). وعند تساوي الموضع يُقدَّم ما يعمل الآن، ثم ترتيب اللقطة —
 *  فالقرار حتميّ لا يعتمد على محرّك الترتيب. */
export function orderTelegramRows(rows: readonly TelegramRow[]): TelegramRow[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const fa = a.row.finishedAt === null ? 0 : 1;
      const fb = b.row.finishedAt === null ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const pa = a.row.position ?? Number.MAX_SAFE_INTEGER;
      const pb = b.row.position ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      const sa = STATE_ORDER[a.row.state];
      const sb = STATE_ORDER[b.row.state];
      if (sa !== sb) return sa - sb;
      return a.i - b.i;
    })
    .map((x) => x.row);
}

/** يطبّق **لقطة كاملة** على الحالة السابقة ويعيد الحالة الجديدة.
 *
 *  قواعد «لا ندّعي ما لا نعلم»:
 *   • حمولة غير مصفوفة ⇒ الحالة السابقة كما هي (لا تفريغ ⇒ لا «لا مهامّ» كاذبة).
 *   • مصفوفة فيها عناصر وكلّها غير مقروءة ⇒ كذلك (لا أعرف ≠ لا مهامّ).
 *   • مصفوفة فارغة ⇒ لا مهامّ تلغرام فعلاً، فتُفرَّغ صفوفه.
 *   • صفٌّ انتهى ثم غاب عن اللقطة **يبقى** حتى المهلة (كي تُرى النتيجة)، وصفٌّ
 *     نشط غاب عنها يُزال فوراً (مهمّته لم تبقَ). */
export function applyTelegramSnapshot(prev: TelegramRow[], payload: unknown, now: number): TelegramRow[] {
  if (!Array.isArray(payload)) return prev;
  const valid = payload.map(asTelegramJob).filter((j): j is TelegramJob => j !== null);
  if (payload.length > 0 && valid.length === 0) return prev;

  const before = new Map(prev.map((r) => [r.key, r] as const));
  const seen = new Set<string>();
  const next: TelegramRow[] = [];
  for (const job of valid) {
    // مهمّتان بالاسم نفسه في المحادثة نفسها: لكلٍّ صفّه (وإلا ضاعت إحداهما).
    const base = telegramKey(job);
    let key = base;
    for (let n = 2; seen.has(key); n++) key = `${base}#${n}`;
    seen.add(key);
    const old = before.get(key);
    const keepFinished = old !== undefined && old.state === job.state && old.finishedAt !== null
      ? old.finishedAt
      : null;
    next.push({ ...telegramRowOf(job, now, keepFinished), key });
  }
  for (const row of prev) {
    if (seen.has(row.key)) continue;
    if (isFinishedState(row.state)) next.push(row);
  }
  return orderTelegramRows(next);
}

/** يُزيل الصفوف المنتهية التي انقضت مهلتها — **لا صفوف عالقة**. */
export function expireTelegramRows(rows: TelegramRow[], now: number): TelegramRow[] {
  return rows.filter((r) => r.finishedAt === null || now - r.finishedAt < TELEGRAM_FINISHED_TTL_MS);
}

/** أقرب موعد إزالة (زمن مطلق) أو `null` إن لم يكن في القائمة صفٌّ منتهٍ. */
export function nextTelegramExpiry(rows: readonly TelegramRow[]): number | null {
  let soonest: number | null = null;
  for (const row of rows) {
    if (row.finishedAt === null) continue;
    const at = row.finishedAt + TELEGRAM_FINISHED_TTL_MS;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

/** ما يُعرض فعلاً: أول `max` صفوف + عدد المخفيّ (**يُشار إليه بـ«+N أخرى»**). */
export function visibleTelegramRows(
  rows: readonly TelegramRow[],
  max: number = TELEGRAM_MAX_ROWS,
): { shown: TelegramRow[]; hidden: number } {
  const limit = Number.isFinite(max) && max >= 0 ? Math.floor(max) : rows.length;
  const shown = rows.slice(0, limit);
  return { shown, hidden: Math.max(0, rows.length - shown.length) };
}

/** بصمة الصفوف: تُسكت إعادة الرسم حين لا يتغيّر شيء، وتُعيدها حين يتغيّر أي
 *  حقل معروض (الحالة · النصّ · النسبة · المهلة). */
export function telegramSignature(rows: readonly TelegramRow[]): string {
  return rows
    .map((r) => [
      r.key, r.name, r.file, r.state, r.detailKey,
      Object.values(r.vars).join(','), r.pct ?? '-', r.finishedAt ?? '-',
    ].join('|'))
    .join('~');
}
