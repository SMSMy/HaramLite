/* ── حالة الجلسة المشتركة بين وحدات الواجهة ───────────────────────────────
 * كانت هذه المتغيّرات التسعة في أعلى src/main.ts، وكانت وحدات عدّة (الفصل،
 * الطابور، المعاينة، الأوضاع، الفحص، التنزيل) تشترك فيها؛ فنُقلت إلى هنا مع
 * مُوصِّلات صريحة getX()/setX(). القيمة الابتدائية حرفياً كما كانت، ولا منطق
 * في أي مُوصِّل — تمرير فقط.
 * وكل استعمال في main.ts أُعيد كتابته صراحةً واحداً واحداً (لا استنتاج آلي):
 * القراءة صارت getX() والكتابة setX(...) بنفس القيمة ونفس الترتيب.
 *
 * coalesceRaf() نُقلت بكاملها كما هي: تجميع أحداث الخلفية عالية التردّد إلى
 * طلاء واحد لكل إطار. مخزنها rafPending هنا، ولم يكن يُقرأ خارجها في main.ts.
 */

/* ── global state ───────────────────────────────────────────────────── */
let currentMediaPath = '';
let lastProbeOk = false;
let currentMode: 'song' | 'clip' = 'song';
let batchQueue: string[] = [];
let batchRunning = false;
let singleRunning = false; // F-4: the separate button doubles as cancel

/* (كان هنا `previewEnabled` و`previewSeconds` لـ«المعاينة السريعة» — جولة
 * settings2 الرابعة: حُذفا مع الميزة كلها. وكانا **ميتين قبل الحذف**: لا شيء
 * يرفع `previewEnabled` عن `false`، فـ`queue.ts` كان يرسل `previewSeconds: null`
 * دائماً. فالحذف لا يغيّر سلوكاً مرصوداً.) */
let appVersion = '';

// Coalesce high-frequency backend events to one DOM paint per frame.
const rafPending = new Set<string>();
export function coalesceRaf(key: string, fn: () => void): void {
  if (rafPending.has(key)) return;
  rafPending.add(key);
  requestAnimationFrame(() => {
    rafPending.delete(key);
    fn();
  });
}
/* ── مُوصِّلات الحالة ─────────────────────────────────────────────────────
 * مكتوبة صراحةً (لا انعكاس ولا سحر) كي يراها المراجع واحدة واحدة: كل زوج
 * يقرأ/يكتب نفس المتغيّر بنفس النوع، بلا أي تحقق أو تحويل أو منطق. */

export function getCurrentMediaPath(): string {
  return currentMediaPath;
}

export function setCurrentMediaPath(next: string): void {
  currentMediaPath = next;
}

export function getLastProbeOk(): boolean {
  return lastProbeOk;
}

export function setLastProbeOk(next: boolean): void {
  lastProbeOk = next;
}

export function getCurrentMode(): 'song' | 'clip' {
  return currentMode;
}

export function setCurrentMode(next: 'song' | 'clip'): void {
  currentMode = next;
}

export function getBatchQueue(): string[] {
  return batchQueue;
}

export function setBatchQueue(next: string[]): void {
  batchQueue = next;
}

export function getBatchRunning(): boolean {
  return batchRunning;
}

export function setBatchRunning(next: boolean): boolean {
  if (!next) {
    endRun('batch');
    return true;
  }
  return tryBeginRun('batch');
}

export function getSingleRunning(): boolean {
  return singleRunning;
}

export function setSingleRunning(next: boolean): boolean {
  if (!next) {
    endRun('single');
    return true;
  }
  return tryBeginRun('single');
}

/* ── حجز التشغيل: تشغيلٌ واحد في كل لحظة ──────────────────────────────────
 * العلَمَان أعلاه وصفٌ لحالة، لا بوابة: أي مستدعٍ كان يستطيع أن يرفع
 * `singleRunning` بينما `batchRunning` مرفوع، فتوجد «رايتان صحيحتان معاً» —
 * حلقة الدفعة ما زالت تعمل على ملف، وزرّ إعادة المحاولة داخل قائمة الدفعة
 * (queue.ts) يُطلق `retryBatchItem` ⇒ `runOne` ⇒ `separate_file` ثانياً في
 * الوقت نفسه. والنتيجة عمليتان على نفس المحرّك، وإلغاء متبادل، ومخرجات
 * متداخلة. الحجز أدناه هو **البوابة الواحدة**: من أراد أن يبدأ تشغيلاً
 * يأخذه أولاً، ومن لم يأخذه لا يبدأ. و`integration.ts` يقرأ العلَمَين
 * ليمنع تداخل أشرطة التقدّم (الأسطر 101/108)، فبقاؤهما صادقين شرطٌ لعمل ذلك.
 *
 * `activeRun` هو مصدر الحقيقة، والعلَمَان يُشتقّان منه ولا يُرفعان إلا معه،
 * فحالة «الاثنان معاً» غير قابلة للوصول من هذا الملف. */
export type RunKind = 'batch' | 'single';
let activeRun: RunKind | null = null;

/** ما نوع التشغيل الجاري، أو null إن كان المحرّك حرّاً. */
export function getActiveRun(): RunKind | null {
  return activeRun;
}

/** هل المحرّك حرّ؟ (الحارس نفسه الذي يقرأه integration.ts للفصل بين الأشرطة) */
export function isIdle(): boolean {
  return activeRun === null && !batchRunning && !singleRunning;
}

/** يحاول حجز التشغيل لصالح `kind`. false ⇒ تشغيلٌ آخر جارٍ، فلا تبدأ. */
export function tryBeginRun(kind: RunKind): boolean {
  if (activeRun !== null || batchRunning || singleRunning) return false;
  activeRun = kind;
  if (kind === 'batch') batchRunning = true;
  else singleRunning = true;
  return true;
}

/** يُطلق الحجز. مُسامِح بالتصميم: تحرير غير المحجوز لا يُفسد شيئاً. */
export function endRun(kind: RunKind): void {
  if (kind === 'batch') batchRunning = false;
  else singleRunning = false;
  if (activeRun === kind) activeRun = null;
}

export function getAppVersion(): string {
  return appVersion;
}

export function setAppVersion(next: string): void {
  appVersion = next;
}

