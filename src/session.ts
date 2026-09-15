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

/* ── quick preview (Sprint B1) ──────────────────────────────────────── */
let previewEnabled = false;
let previewSeconds = 15;
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

export function setBatchRunning(next: boolean): void {
  batchRunning = next;
}

export function getSingleRunning(): boolean {
  return singleRunning;
}

export function setSingleRunning(next: boolean): void {
  singleRunning = next;
}

export function getPreviewEnabled(): boolean {
  return previewEnabled;
}

export function setPreviewEnabled(next: boolean): void {
  previewEnabled = next;
}

export function getPreviewSeconds(): number {
  return previewSeconds;
}

export function setPreviewSeconds(next: number): void {
  previewSeconds = next;
}

export function getAppVersion(): string {
  return appVersion;
}

export function setAppVersion(next: string): void {
  appVersion = next;
}

