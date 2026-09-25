/* ── الطابور والفصل والتنزيل ───────────────────────────────────────────────
 * نُقل من src/main.ts كما هو حرفياً، وهو وحدة واحدة لأن هذه الأجزاء تشترك في
 * حالة واحدة ولا تنفصل بلا كسر:
 *   - استقبال الملفات: ingestFiles() وupdateQualityOptions()
 *   - محرّك الدفعة: batchAbort/stopBatch/renderBatchList/setBatchCounter/
 *     styleBatchItem وحفظ/استرجاع الطابور (batchStatus + hl.batch)
 *   - الفصل: runSeparationFor/wireSeparate/runOne/retryBatchItem/lastSepOpts
 *   - تنزيل الرابط: wireUrlDownload (يشترك في coalesceRaf وingestFiles)
 * (الحالة المشتركة مثل batchQueue/currentMode كانت متغيّرات في main.ts،
 * واليوم تُقرأ من src/session.ts — نفس القيم ونفس الترتيب.)
 * لم يُنقل outDirOf() هنا: بقي في src/media.ts حيث يخدم الفصل والتنزيل وفتح
 * المجلد معاً، فلا نسخة ثانية منه.
 * لم يتغيّر أي معرّف DOM ولا صيغة localStorage (hl.batch) ولا اسم أي أمر
 * (separate_file، download_media_cmd، update_ytdlp، push_log)
 * ولا حقل واحد في حِمل separate_file. والوحيد المضاف: export على ما تحتاجه
 * main.ts (ingestFiles، stopBatch، wireSeparate، wireUrlDownload،
 * restoreBatchState، updateQualityOptions).
 *
 * **م٢ — الإلغاء الحقيقي**: لم يبقَ في هذا الملف نداءٌ لـ`cancel_process`
 * (العلم العامّ لكل التطبيق). كل زرّ إلغاء يستهدف **مهمّته**: يُقرأ سِجلّ
 * الخلفية (`active_jobs`) ويُطابَق مسار المهمّة بمسار الصفّ (`src/jobs.ts`)،
 * ثم `cancel_job(id)`. وإن لم توجد مهمّة ⇒ إلغاء **محلي** بلا أي إلغاء عام.
 * والاستثناء الوحيد المسمّى صراحةً: `stopBatch()` (إفراغ الطابور قبل تشغيل
 * جديد) ⇒ `cancel_all_jobs()` — وهو نفس ما كان يفعله العلم العامّ سابقاً،
 * بعقد صريح يعيد العدد. وإضافةً إلى ذلك: شريط إيقاف ثابت (`#stop-bar`) خارج
 * منطقة تمرير الطابور، واستطلاع كل ثانية **أثناء وجود مهامّ** يُوائم حالة
 * الصفوف مع السِجلّ (فلا يبقى صفٌّ «يعمل» بنسبة قديمة بعد أن ماتت مهمّته).
 *
 * **م٣ — موضع الصفّ المنتظر**: صفٌّ في الانتظار يعرض اليوم **موضعه** في قائمة
 * الانتظار («في قائمة الانتظار — دورك: N»، 1 = التالي) بدل «في الانتظار»
 * المجرّدة، بنفس صياغة صفوف تلغرام (`src/i18n.ts` — مفتاح `queue_wait_position`
 * واحد للسطحين). والموضع **مقيس من القائمة نفسها** (`session.getBatchQueue()`
 * و`batchStatus`) لا مخترع، ويُعاد حسابه بعد كل تغيّر حالة فلا يبقى رقم بائت.
 * (تغيير سلوك مقصود ومُعلَن: النصّ القديم `queue_pending` بقي مفتاحاً في الجدول
 * وفي هيكل index.html، ولم يبقَ نصّ الصفوف الحيّ.)
 */

import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { currentLang, errText, t } from './i18n';
import { STAGE_NAMES, hideStageLine } from './cuda';
import { fileBaseName, notify, showToast } from './util';
import type { SepResult } from './types';
import { outDirOf, pathInputEl, probeEl, runProbe, sepBtnEl, sepResultEl, setVerdict, setVerdictHtml, verdictHtml } from './media';
import * as session from './session';
import { refreshYtdlpUpdateUi } from './ytdlpUi';
import {
  STOP_CEILING_SECS,
  cancelJobById,
  cancelMessage,
  cancelPath,
  fetchActiveJobs,
  jobDisplayName,
  jobForPath,
  pendingQueuePositions,
  reconcileItemState,
  stopTarget,
} from './jobs';
import type { CancelOutcome, JobInfo, JobInvoker } from './jobs';

/** Handle one or many files: single → fill+probe; many → queue for batch. */
export async function ingestFiles(files: string[]): Promise<void> {
  if (files.length === 0) return;
  
  if (files.length === 1) {
    await stopBatch();
    const info = await runProbe(files[0]);
    if (info) updateQualityOptions(info.has_video ? info.height ?? null : null);
    // Add to batch queue to show history visually
    session.setBatchQueue([files[0]]);
    renderBatchList();
    return;
  }
  
  session.setBatchQueue([...files]);
  renderBatchList();
  setBatchCounter(0, session.getBatchQueue().length);
  const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
  const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'video';
  setVerdictHtml(probeEl(), verdictHtml(outKind), false);
  invoke('push_log', { level: 'info', message: `batch queued: ${session.getBatchQueue().length} files` });
}

export function updateQualityOptions(srcHeight: number | null): void {
  const videoCard = document.getElementById('kind-video');

  // Video kind only makes sense for real video inputs; dim it otherwise.
  // This MUST run before any early return: the Lite UI has no
  // `quality-select`, so the old `if (!wrap || !sel || !videoCard) return;`
  // skipped the dimming entirely and let users pick MP4 video for audio-only
  // files (guaranteed ffmpeg failure).
  if (videoCard) videoCard.classList.toggle('dimmed', srcHeight === null);

  /* **وما بعد هذا كان ميتاً فحُذف** (الجولة الرابعة): بناء «سلّم الجودة» في
   * `#quality-select` داخل `#q-wrap` — والمعرّفان **غير موجودين**: لا في
   * `index.html` (ولا كلمة `quality` فيه إطلاقاً) ولا في `dist/`، ولا يُنشئهما
   * أي مسار (`createElement`/`innerHTML` في `src/**` = صفر). فكان
   * `if (!wrap || !sel) return;` **يعود دائماً**، والسلّم و`sel.replaceChildren`
   * و`sel.value` **لا تُنفَّذ قطّ**.
   * ⇒ فالأثر الحيّ الوحيد لهذه الدالة هو تعتيم بطاقة `#kind-video` أعلاه، وهو
   * محفوظ **حرفياً وفي موضعه نفسه** — وهو إصلاح عطب مسجَّل في `docs/AUDIT.md:243`
   * (التعتيم كان يُتخطّى لأن `sel` دائماً `null`)، وصار له **حارس سلوكي** في
   * `src/__tests__/settingsTabs.test.ts` ⇒ «لا مسار ميت».
   * **ومفتاح الترجمة `quality_same` صار بلا مستعمِل** — نصٌّ لا مسار، تُرك معلَناً. */
}

/* ── batch engine (F5): sequential, continue-on-fail ────────────────── */
let batchAbort = false;
/** مسار الملف الذي **نداء فصله معلَّق الآن** في الواجهة (null حين لا تشغيل).
 *  ضروريّ لثلاثة أشياء: أن يعرف زرّ الإيقاف مهمّته، وأن يُمنع وسم صفٍّ «ميت»
 *  بين `markBatchItem('run')` وتسجيل المهمّة في الخلف (نافذة زمنية حقيقية)،
 *  وأن يُسمّى الهدف في شريط الإيقاف. */
let runInFlightPath: string | null = null;

/** Stop the batch AND the backend jobs behind it. Without cancelling them the
 *  Rust pipeline keeps grinding (ghost processing) and `batchRunning` stays
 *  true until it finishes — the next "فصل" click then cancels instead of
 *  starting.
 *
 *  م٢: كان هنا `cancel_process` — **علمٌ عامّ** يُلغي كل شيء بلا هويّة. وصار
 *  النداء `cancel_all_jobs()` الصريح الذي يعيد **عدد** ما سُجِّل إلغاؤه، فما
 *  كان يُدَّعى صار يُقاس. والعرض نفسه (كل المهامّ) مقصود: هذا مسار «أفرِغ
 *  الطابور قبل تشغيل جديد»، وهو ما كان العلم العامّ يفعله بالحرف. */
export async function stopBatch(): Promise<void> {
  batchAbort = true;
  session.setBatchQueue([]);
  batchStatus.clear();
  localStorage.removeItem('hl.batch');
  // ع١ (جولة الجاسوس): الصفوف **المنتظرة/الجارية** تُمحى لأنها لم تعد تقابل
  // شيئاً في القائمة — وكانت تبقى مرسومة تقول «دورك: 1» و«دورك: 2» (أرقام
  // بائتة) **مع** رسالة «لا ملفات في الطابور بعد». والحكم بحالة الصفّ المُعلَنة
  // (`data-state`، يكتبها `setBatchItemState`) لا بنصّه: مطابقة النصّ تتفرّق عن
  // الحقيقة بأول صياغة جديدة. وصفوف `ok`/`fail` تبقى عن قصد: سِجلّ ما جرى حتى
  // الرسم التالي (موثَّق في ترويسة `stopBatch`).
  // عطل ميداني 2026-09-21: `'cancelled'` **حالة انتهاء** كـ`ok`/`fail` لا حالة
  // عمل ⇒ تُضاف إلى `finished`، وإلا مُحي الصفّ الملغى من الشاشة عند الإفراغ
  // بينما يبقى الفاشل (قِيس: `rowCount:0` لصفٍّ `data-state="cancelled"`).
  const finished = new Set<BatchItemState>(['ok', 'fail', 'cancelled']);
  for (const row of visibleBatchRows()) {
    if (!finished.has((row.dataset.state ?? 'pending') as BatchItemState)) row.remove();
  }
  // 2026-09-21: كانت هذه تُخفي `#batch-list` كلها — وحالة الفراغ تعيش داخلها
  // فكان الإفراغ يُخفيها هي أيضاً (شاشة صامتة). واليوم الحالة الفارغة تُعلَن.
  updateBatchEmptyState();
  document.getElementById('batch-counter')?.classList.add('hidden');
  // Phantom-cancel fix: stopBatch runs on EVERY single-file ingest, and it
  // used to fire the cancel command (and its scary backend WARN line) even
  // with nothing running. Only signal when a job actually exists to abort.
  if (!session.getBatchRunning() && !session.getSingleRunning()) return;
  try {
    const n = await invoke<number>('cancel_all_jobs');
    invoke('push_log', {
      level: n ? 'warn' : 'info',
      message: `batch stop: cancel_all_jobs → ${n}`,
    });
  } catch (e) {
    console.error('cancel_all_jobs failed', e);
    invoke('push_log', { level: 'error', message: `batch stop: cancel_all_jobs failed: ${e}` });
  }
}

function setBatchCounter(done: number, total: number): void {
  const el = document.getElementById('batch-counter');
  if (!el) return;
  el.classList.remove('hidden');
  el.textContent = `${t('batch_label')} ${done}/${total}`;
}
/** Batch rows must never shrink inside the flex column (30 files squeezed
 *  into slivers) and off-screen rows skip rendering (content-visibility). */
function styleBatchItem(div: HTMLElement): void {
  div.classList.add('shrink-0');
  div.style.contentVisibility = 'auto';
  div.style.containIntrinsicSize = 'auto 96px';
}
/** يكتب في كل صفٍّ منتظر **موضعه** في قائمة انتظار الواجهة («دورك: N»).
 *
 *  الموضع يُقرأ من `session.getBatchQueue()` مع `batchStatus` (لا من DOM)، ويُعاد
 *  حسابه بعد كل تغيّر حالة — ترقية صفٍّ إلى «يعمل» أو إعادته إلى الانتظار — فلا
 *  يبقى رقم بائت على الشاشة (وإلا بقي الصفّ الثاني «دورك: 3» بعد أن صار التالي).
 *  و`except` لصفٍّ كُتب فيه نصٌّ صريح أهمّ من الرقم (صفٌّ أُعيد إلى الانتظار لأن
 *  مهمّته ماتت ⇒ `stop_row_stale`)، فلا يُدهَس. */
function refreshWaitingPositions(except?: HTMLElement | null): void {
  const list = document.getElementById('batch-list');
  if (!list) return;
  const queue = session.getBatchQueue();
  const positions = pendingQueuePositions(queue.map((f) => itemStateOf(f)));
  const at = new Map(queue.map((f, i) => [f, positions[i]] as const));
  list.querySelectorAll<HTMLElement>('div[data-file]').forEach((row) => {
    if (row === except) return;
    const n = at.get(row.dataset.file ?? '');
    if (typeof n !== 'number') return; // يعمل/انتهى: لا موضع يُقال
    const span = row.querySelector<HTMLElement>('.status-text');
    if (span) span.textContent = t('queue_wait_position', { n });
  });
}

function renderBatchList(): void {
  const ul = document.getElementById('batch-list');
  if (!ul) return;
  ul.classList.remove('hidden');
  // 2026-09-21: `replaceChildren` كانت تمحو **كل** أولاد `#batch-list` — ومنهم
  // `#batch-empty` الثابت — فيختفي عنصر الحالة الفارغة من DOM بعد أول رسم
  // (قيست: `getElementById('batch-empty')` ⟶ null بعد `renderBatchList`).
  // فالإزالة اليوم تخصّ **الصفوف** (`div[data-file]`) وحدها، والحالة تبقى.
  ul.querySelectorAll('div[data-file]').forEach((row) => row.remove());
  ul.append(...batchRows(session.getBatchQueue()));
  updateBatchEmptyState();
  batchStatus.clear();
  for (const f of session.getBatchQueue()) setBatchItemState(f, 'pending');
  refreshWaitingPositions(); // م٣: كل صفٍّ منتظر يقول موضعه لا «في الانتظار» فقط
  saveBatchState();
}

/** صفوف الطابور — **المنشئ الوحيد** لصفوف `#batch-list`.
 *
 *  العطل الميداني 2026-09-21: كان في `index.html` ترميز تصميمي ثابت (صفّ
 *  `track_01_vocals.mp3` بنسبة 33% وشريط تقدّم و«1/3 جاري المعالجة...»، وصفّ
 *  `podcast_ep44.wav` «في الانتظار») يبقى ظاهراً متى كان الطابور فارغاً، فيُقرأ
 *  كعمل جارٍ لا وجود له. وسببه المقيس أن `restoreBatchState()` تُرجع مبكراً عند
 *  غياب `hl.batch` ولا تمسّ DOM. فالعلاج بنيوي: **لا صفّ ملف في الترميز أصلاً**،
 *  والصفوف تُبنى هنا وحدها من قائمة الجلسة. */
function batchRows(queue: readonly string[]): HTMLElement[] {
  return queue.map((f) => {
    const div = document.createElement('div');
    div.dataset.file = f;
    div.className = 'batch-item bg-coal-surface/40 border border-border-muted rounded p-stack-sm flex flex-col gap-unit opacity-60 transition-all duration-300 apple-ease cursor-default relative overflow-hidden';
    styleBatchItem(div);

    const progBg = document.createElement('div');
    progBg.className = 'absolute inset-0 bg-clay-accent/10 w-0 transition-all duration-1000 ease-linear batch-prog-bg hidden';

    const headerDiv = document.createElement('div');
    headerDiv.className = 'flex justify-between items-center relative z-10';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'font-label-sm text-label-sm text-cream-text truncate font-semibold';
    nameSpan.dir = 'ltr';
    nameSpan.textContent = f.split(/[\\/]/).pop() ?? f;
    const pctSpan = document.createElement('span');
    pctSpan.className = 'batch-pct font-label-sm text-label-sm text-clay-accent font-bold drop-shadow-sm hidden';
    pctSpan.textContent = '0%';
    headerDiv.append(nameSpan, pctSpan);

    const progWrap = document.createElement('div');
    progWrap.className = 'h-1.5 bg-border-muted rounded-full overflow-hidden relative z-10 shadow-inner batch-prog-wrap hidden';
    const progBar = document.createElement('div');
    progBar.className = 'batch-prog-bar h-full bg-clay-accent w-0 rounded-full relative transition-all duration-1000 ease-linear shadow-[0_0_10px_rgba(218,119,86,0.8)]';
    progWrap.appendChild(progBar);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'batch-actions flex gap-2 z-10 hidden mt-1';

    const statusSpan = document.createElement('span');
    statusSpan.className = 'status-text font-label-sm text-label-sm text-on-surface-variant relative z-10 flex-1';
    statusSpan.textContent = t('queue_pending');

    const bottomRow = document.createElement('div');
    bottomRow.className = 'flex justify-between items-center w-full relative z-10';
    bottomRow.append(statusSpan, actionsDiv);

    div.append(progBg, headerDiv, progWrap, bottomRow);
    return div;
  });
}

/** حالة الفراغ — **مصدر واحد للحقيقة**، لا علامة في الترميز.
 *
 *  الجولة الثانية (جاسوس مستقل، 2026-09-21) كشفت أن الدالة كانت تقرأ **طول
 *  الطابور وحده**، فوقع ازدواجان مقيسان:
 *    • **ع١**: بعد `stopBatch()` تُفرَّغ القائمة **وتبقى الصفوف مرسومة** ⇒ رسالة
 *      «لا ملفات في الطابور بعد» مع صفّين يقولان «دورك: 1» و«دورك: 2» (أرقام
 *      بائتة لقائمة لم تعد موجودة).
 *    • **ع٢**: طابور واجهة فارغ ومهمّة **حيّة في السِجلّ** (تلغرام/الجسر/إعادة
 *      تحميل أثناء عمل Rust) ⇒ الواجهة تقول «لا شيء، ابدأ المعالجة» وشريط
 *      الإيقاف فوقها يقول «المهامّ النشطة: 1».
 *
 *  فالشرط اليوم ثلاثة معاً: **لا انتظار في القائمة** · **لا صفّ مرسوم** ·
 *  **لا مهمّة حيّة**. وهذا يجعل الإعلان مشتقّاً من الشاشة نفسها فلا يمكن أن
 *  يناقضها (`visibleBatchRows()` تقرأ DOM لا وسيطاً).
 *
 *  والنصّ يتبع الحالة: مهمّة حيّة بطابور فارغ ⇒ «مهمّة جارية من الخلفية» لا
 *  «لا ملفات». ولا يُلمس مُفتاح الترجمة الثابت: النصّ يُكتب من `t()` كالريندر. */
function updateBatchEmptyState(): void {
  const empty = document.getElementById('batch-empty');
  if (!empty) return;
  const noQueue = session.getBatchQueue().length === 0;
  const noRows = visibleBatchRows().length === 0;
  // **ثلاث حالات لا ثنائية** (جولة ثالثة): «يعمل» / «خامل» / **«مجهول»**.
  // كان `liveBackendJob` منطقياً يُبنى على قراءة ناجحة، فالشرط الثلاثي يتقلّص
  // إلى شرطين حين تُفقد المعرفة ⇒ تُعلن اللوحة «لا ملفات … لتبدأ المعالجة» في
  // اللحظة التي يقول فيها شريط الإيقاف «✗ تعذّرت قراءة المهامّ النشطة». والخمول
  // **ادّعاء معرفة** لا يجوز إطلاقه بلا دليل، كما لا يجوز إطلاق «يعمل».
  const busy = noQueue && noRows && jobKnowledge === 'running';
  const unknown = noQueue && noRows && jobKnowledge === 'unknown';
  empty.classList.toggle('hidden', !(noQueue && noRows));
  const main = empty.querySelector<HTMLElement>('[data-i18n="queue_empty"]');
  const add = empty.querySelector<HTMLElement>('[data-i18n="queue_empty_add"]');
  // والمجهول لا يَعِد بشيء: لا دعوة لبدء المعالجة (قد تكون هناك مهمّة)، ولا
  // ادّعاء عمل (لم نُثبته) — بل نصّ يقول إن الحالة غير معروفة.
  const mainKey = unknown ? 'queue_empty_unknown' : busy ? 'queue_empty_running' : 'queue_empty';
  const addKey = unknown ? 'queue_empty_unknown_hint' : busy ? 'queue_empty_running_hint' : 'queue_empty_add';
  if (main) main.textContent = t(mainKey);
  if (add) add.textContent = t(addKey);
}
/** صفوف الطابور المرسومة فعلاً — **تُقرأ من DOM**، فلا تفترق عن الشاشة. */
function visibleBatchRows(): HTMLElement[] {
  const list = document.getElementById('batch-list');
  return list ? [...list.querySelectorAll<HTMLElement>('div[data-file]')] : [];
}
/** ما نعرفه عن مهامّ الخلفية — **أربع حالات**، والمعروض ثلاث:
 *
 *  • `'unchecked'` — **الابتداء**: لم نقرأ بعد. لا ادّعاء عمل ولا ادّعاء جهل:
 *    «لا ملفات … ابدأ المعالجة» صادقة عن **طابور الواجهة** (وهو ما يقيسه هذا
 *    السطر)، ولا تُناقض شيئاً لأن الشريط لم يقل شيئاً بعد.
 *  • `'idle'`    — قراءة **ناجحة** قالت: لا مهامّ.
 *  • `'running'` — قراءة **ناجحة** قالت: ثمّة مهامّ.
 *  • `'unknown'` — **فشلت قراءة** (بعد أن كان ثمّة محاولة) ⇒ لا «لا ملفات» ولا
 *    «مهمّة جارية»، بل تصريح بالجهل.
 *
 *  والفرق بين `'unchecked'` و`'unknown'` جوهري ومقيس: الأول لا يعلم أحدٌ أنه
 *  سُئل، والثاني **سُئل وفشل** — والشريط حينها يقول «✗ تعذّرت قراءة المهامّ»،
 *  فلا يجوز أن تناقضه اللوحة. (وكان الأول يُعرض «مجهول» فيُفزع كل إقلاع سليم —
 *  أسقطه الحارس فأُصلح.)
 *
 *  ولا يُحفظ شيء من قراءة قديمة: كل دورة استطلاع **تكتب** هذه القيمة من نتيجتها
 *  (نجاح ⇒ idle/running، فشل ⇒ unknown)، فزوال المعرفة يُعلَن في الدورة نفسها
 *  ولا يبقى ادّعاء عمل أبديّاً بعد أن رُئيت مهمّة مرّة (وهو لاتش مقيس في الجولة
 *  الثالثة: `P2c failing {"claimsRunning":true}`). */
let jobKnowledge: 'unchecked' | 'idle' | 'running' | 'unknown' = 'unchecked';
function setJobKnowledge(next: 'unchecked' | 'idle' | 'running' | 'unknown'): void {
  if (jobKnowledge === next) return;
  jobKnowledge = next;
  updateBatchEmptyState();
}

/* ── batch persistence (functional gap: memory-only queue) ──────────── */
// The queue (+ per-item status) survives close/crash; completion or an
// explicit stop clears it. Resume re-queues only pending/failed items —
/// never reprocesses finished ones.
type BatchItemState = 'pending' | 'run' | 'ok' | 'fail' | 'cancelled';
const batchStatus = new Map<string, BatchItemState>();

/** **من أين جاء الإلغاء؟** — موضع واحد يقرأ العلامة في رسالة الخلف.
 *
 *  كان في هذا الملف مسارٌ يميّزها أصلاً (`msg.includes('إلغاء')` في `runOne`)،
 *  ومسار الدفعة **لا** يميّزها فيُوسم الصفّ `fail` ويُسجَّل ERROR مع أن الخلف
 *  يقول `أُلغيت: true` (عطل ميداني مقيس بتشغيل التطبيق 2026-09-21). فوُحّد
 *  التمييز هنا، **والدالّة صافية** (نصّ ⟶ منطقي) فتُختبر بلا DOM ولا تطبيق. */
export function isCancellation(message: unknown): boolean {
  return String(message).includes('إلغاء');
}
/** الحالة تُخزَّن في **موضعين متلازمين**: الخريطة (المصدر المنطقي) و`data-state`
 *  على الصفّ (المصدر الذي تقرأه `stopBatch` والفحوص). ولا تُكتب إحداهما دون
 *  الأخرى — وإلا صار الحكم على الصفّ بالنصّ المعروض، وهو ما يتفرّق عن الحقيقة
 *  بأول تغيير صياغة (وهو أصل ع١ في جولة الجاسوس). */
function setBatchItemState(file: string, state: BatchItemState): void {
  batchStatus.set(file, state);
  const row = document.querySelector<HTMLElement>(`#batch-list div[data-file="${CSS.escape(file)}"]`);
  if (row) row.dataset.state = state;
}
/** حالة الصفّ المخزَّنة (والافتراض `pending` كالسابق). */
function itemStateOf(file: string): BatchItemState {
  return batchStatus.get(file) ?? 'pending';
}
function saveBatchState(): void {
  try {
    if (session.getBatchQueue().length) {
      localStorage.setItem('hl.batch', JSON.stringify(
        session.getBatchQueue().map((f) => ({ f, s: itemStateOf(f) })),
      ));
    } else localStorage.removeItem('hl.batch');
  } catch { /* storage full/blocked — queue simply stays volatile */ }
}
/** **الموضع الواحد** لقرار «هل يُستأنف هذا الصفّ عند الإقلاع؟».
 *
 *  القاعدة في التخطيط: «الاستئناف يعيد ترتيب **المعلّق والفاشل**، ولا يعيد
 *  معالجة **المنتهي**». والملغى يقع مع المنتهي **عن قصد**: هو عملٌ أوقفه المستخدم
 *  بيده، فإعادته عند كل إقلاع تناقض إرادته المعلَنة (وقد تُعيد عملاً أوقفه بلا
 *  أن يطلبه). ويبقى له **زرّ إعادة المحاولة** فيعيده متى شاء.
 *  ولو قُلب القرار فالبقية تعمل: `restoreBatchState` تُبني على هذه الدالة وحدها. */
function restorable(it: { f: string; s: BatchItemState }): boolean {
  return it.s !== 'ok' && it.s !== 'cancelled';
}
export function restoreBatchState(): void {
  let items: { f: string; s: BatchItemState }[] = [];
  try {
    const raw = localStorage.getItem('hl.batch');
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [];
      items = arr
        .map((it) => typeof it === 'string'
          ? { f: it, s: 'pending' as BatchItemState }
          : { f: (it as { f?: unknown }).f, s: (it as { s?: unknown }).s })
        .filter((it): it is { f: string; s: BatchItemState } =>
          typeof it.f === 'string'
          && (it.s === 'pending' || it.s === 'run' || it.s === 'fail' || it.s === 'ok' || it.s === 'cancelled'));
    }
  } catch { items = []; }
  const files = items.filter(restorable).map((it) => it.f);
  const skipped = items.length - files.length;
  if (!files.length) {
    if (items.length) localStorage.removeItem('hl.batch');
    // 2026-09-21: كان هنا `return` وحده — فلا يُمَسّ DOM ويبقى ترميز الصفوف
    // الوهمي من `index.html` معروضاً كعمل جارٍ في كل إقلاع بطابور فارغ.
    // واليوم الحالة الفارغة تُعلَن صراحةً من قائمة الجلسة (وهي فارغة هنا).
    updateBatchEmptyState();
    return;
  }
  session.setBatchQueue(files);
  renderBatchList();
  // ع٤ (جولة الجاسوس): `renderBatchList` تكتب `pending` لكل الصفوف، فكان صفٌّ
  // مُستعاد بحالة `fail` (مهمّة انقطعت) أو `run` (إعادة تحميل أثناء عمل مهمّة)
  // يُقرأ «دورك: 1» ويُمحى فشله من التخزين معه. واليوم الحالة المخزَّنة تُعاد
  // **بعد** الرسم: `fail` يعلن فشله (`markBatchItem('fail')`)، و`run` يُعلن
  // تشغيله، ثم يصحّحه استطلاع السِجلّ أدناه (`reconcileBatchRows`): مهمّة حيّة
  // ⇒ يبقى يعمل، ولا مهمّة ⇒ `stop_row_stale` («أُعيد إلى الانتظار») — فلا
  // تُدّعى مهمّة ولا يُكتم انقطاع.
  for (const it of items) {
    if (it.s === 'fail' || it.s === 'run' || it.s === 'cancelled') markBatchItem(it.f, it.s);
  }
  setBatchCounter(0, session.getBatchQueue().length);
  // م٢: الصفوف المُستعادة تُبنى «في الانتظار» (`renderBatchList` تكتب pending
  // لكل الصفوف)، وقد تكون مهمّة أحدها **حيّة في الخلف** (إعادة تحميل الواجهة
  // لا تقتل مهمّة Rust). فالاستطلاع يسأل السِجلّ ويصحّح العرض بدل أن تدّعي
  // الشاشة غير ما في الخلفية.
  startJobsPolling();
  showToast(t('batch_restored', {
    count: files.length,
    skipped: skipped ? t('batch_restored_skipped', { skipped }) : '',
  }));
  invoke('push_log', { level: 'warn', message: `batch restored after restart: ${files.length} files (${skipped} done skipped)` });
}

function markBatchItem(file: string, status: 'ok' | 'fail' | 'run' | 'cancelled', resultPath?: string): void {
  setBatchItemState(file, status);
  const item = document.querySelector<HTMLElement>(`#batch-list div[data-file="${CSS.escape(file)}"]`);
  if (!item) { refreshWaitingPositions(); saveBatchState(); return; }
  styleBatchItem(item); // className swaps below wipe classes — re-apply after each
  
  const statusSpan = item.querySelector('.status-text') as HTMLElement;
  const actionsDiv = item.querySelector('.batch-actions') as HTMLElement;
  
  if (status === 'run') {
      item.className = 'batch-item running-item bg-coal-surface/80 border border-clay-accent/40 rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden shadow-[0_4px_12px_-4px_rgba(218,119,86,0.2)] transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.remove('hidden');
      item.querySelector('.batch-pct')?.classList.remove('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.remove('hidden');
      if (statusSpan) {
          statusSpan.textContent = t('queue_processing');
          // full-strength clay, no opacity: clay at 70% on this running row
          // measured 3.48:1; full strength is 5.87:1 (AA needs 4.5:1 at 12px)
          statusSpan.className = 'status-text font-label-sm text-label-sm text-clay-accent animate-pulse relative z-10 flex-1';
      }
      if (actionsDiv) {
          actionsDiv.innerHTML = `<button class="text-error hover:text-red-400 p-1" title="${t('cancel_processing')}"><span class="material-symbols-outlined text-sm" data-icon="cancel">cancel</span></button>`;
          actionsDiv.classList.remove('hidden');
          // م٢: هذا الزرّ كان ينادي `cancel_process` (علم عامّ) — فيُلغي كل
          // شيء أو لا يُلغي شيئاً، ولا يعرف أيّ مهمّة يقصد. واليوم يستهدف
          // مهمّة هذا الصفّ وحدها عبر مساره (والمنطق كله في cancelQueueItem).
          actionsDiv.querySelector('button')?.addEventListener('click', () => {
              void cancelQueueItem(file);
          });
      }
  } else if (status === 'ok') {
      item.className = 'batch-item bg-tertiary-container/20 border border-tertiary/40 rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.add('hidden');
      item.querySelector('.batch-pct')?.classList.add('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.add('hidden');
      if (statusSpan) {
          // (كان: `session.getPreviewEnabled() ? t('sep_done_preview') : t('sep_done_short')`
          // — وحُذف الفرع الأول مع «المعاينة السريعة» في جولة settings2 الرابعة:
          // `getPreviewEnabled()` كانت `false` دائماً، فالمعروض ما كان إلا
          // `sep_done_short` أصلاً.)
          statusSpan.textContent = t('sep_done_short');
          statusSpan.className = 'status-text font-label-sm text-label-sm text-tertiary relative z-10 flex-1';
      }
      if (actionsDiv && resultPath) {
          const folderPath = outDirOf(resultPath);
          actionsDiv.innerHTML = `
            <button class="btn-play text-tertiary hover:text-green-300 p-1 bg-surface-container rounded" title="${t('open_file')}">
              <span class="material-symbols-outlined text-sm" data-icon="play_arrow">play_arrow</span>
            </button>
            <button class="btn-folder text-tertiary hover:text-green-300 p-1 bg-surface-container rounded" title="${t('open_folder')}">
              <span class="material-symbols-outlined text-sm" data-icon="folder_open">folder_open</span>
            </button>
          `;
          actionsDiv.classList.remove('hidden');
          actionsDiv.querySelector('.btn-play')?.addEventListener('click', () => invoke('open_file', { path: resultPath }).catch(console.error));
          actionsDiv.querySelector('.btn-folder')?.addEventListener('click', () => invoke('open_folder', { path: folderPath }).catch(console.error));
      } else if (actionsDiv) {
          actionsDiv.classList.add('hidden');
      }
  } else if (status === 'fail') {
      item.className = 'batch-item bg-error-container/20 border border-error/40 rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.add('hidden');
      item.querySelector('.batch-pct')?.classList.add('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.add('hidden');
      if (statusSpan) {
          statusSpan.textContent = t('sep_failed_short');
          statusSpan.className = 'status-text font-label-sm text-label-sm text-error relative z-10 flex-1';
      }
      // Functional gap: a transient failure used to be a dead end — offer
      // a per-item retry instead of forcing a manual queue rebuild.
      if (actionsDiv) {
          actionsDiv.innerHTML = `<button class="text-tertiary hover:text-green-300 p-1 bg-surface-container rounded" title="${t('retry')}"><span class="material-symbols-outlined text-sm" data-icon="refresh">refresh</span></button>`;
          actionsDiv.classList.remove('hidden');
          actionsDiv.querySelector('button')?.addEventListener('click', () => void retryBatchItem(file));
      }
  } else if (status === 'cancelled') {
      // عطل ميداني 2026-09-21: الإلغاء **ليس فشلاً** — والخلف يقول `أُلغيت: true`.
      // فاللون محايد (`surface-container`/`on-surface-variant`) لا `error`،
      // والنصّ «⏹ أُلغيت» لا «✗ فشل». وزرّ إعادة المحاولة كما هو في الفشل:
      // الإلغاء قرار المستخدم، وإعادة التشغيل قراره أيضاً.
      item.className = 'batch-item bg-surface-container/40 border border-border-muted rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.add('hidden');
      item.querySelector('.batch-pct')?.classList.add('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.add('hidden');
      if (statusSpan) {
          statusSpan.textContent = t('sep_cancelled_short');
          statusSpan.className = 'status-text font-label-sm text-label-sm text-on-surface-variant relative z-10 flex-1';
      }
      if (actionsDiv) {
          actionsDiv.innerHTML = `<button class="text-tertiary hover:text-green-300 p-1 bg-surface-container rounded" title="${t('retry')}"><span class="material-symbols-outlined text-sm" data-icon="refresh">refresh</span></button>`;
          actionsDiv.classList.remove('hidden');
          actionsDiv.querySelector('button')?.addEventListener('click', () => void retryBatchItem(file));
      }
  }
  styleBatchItem(item); // className swaps above wipe it — restore last
  refreshWaitingPositions(); // م٣: ترقية صفٍّ تُحرّك مواضع مَن بعده
  saveBatchState();
}

/* ── م٢: إلغاء مهمّة بعينها + شريط الإيقاف الثابت + مواءمة الطابور ─────────
 * ثلاث وظائف مترابطة تعيش هنا لأنها تلمس حالة الطابور (`batchStatus` ·
 * `runInFlightPath` · DOM الصفوف)، وكل القرارات النقية في `src/jobs.ts`:
 *   ١) cancelQueueItem()   — زرّ الصفّ: مهمّته وحدها، وإلا إلغاء محلي.
 *   ٢) wireStopBar()       — الزرّ الثابت + إلغاء الكل (منفصل ومسمّى).
 *   ٣) استطلاع كل ثانية    — يوائم الصفوف مع سِجلّ الخلفية أثناء وجود مهامّ.
 * ولا `cancel_process` العامّ في أي مسار هنا. */

/** مستوى السجلّ للنصّ الذي يُكتب في الواجهة — الألوان دلالية لا تجميلية. */
function toneClass(tone: 'ok' | 'warn' | 'error'): string {
  return tone === 'error' ? 'text-error' : tone === 'warn' ? 'text-warn-yellow' : 'text-clay-accent';
}

/** يكتب نتيجة طلب الإلغاء في مكانين: سطر حالة الصفّ (إن وُجد)، وسطر شريط
 *  الإيقاف. النصّ يأتي من `cancelMessage()` (تغطية كل حالة صريحة)، وسقف
 *  الانتظار يُضاف **فقط** في حالة النجاح — حيث يُسأل «متى يتوقّف؟». */
function reportCancelOutcome(outcome: CancelOutcome, file: string): void {
  const m = cancelMessage(outcome);
  const text = t(m.key, m.vars);
  const cls = toneClass(m.tone);
  const item = document.querySelector<HTMLElement>(`#batch-list div[data-file="${CSS.escape(file)}"]`);
  const statusSpan = item?.querySelector<HTMLElement>('.status-text') ?? null;
  if (statusSpan) {
    statusSpan.textContent = text;
    statusSpan.className = `status-text font-label-sm text-label-sm ${cls} relative z-10 flex-1`;
  }
  const note = document.getElementById('stop-note');
  if (note) {
    note.textContent = m.tone === 'ok'
      ? `${text} ${t('stop_note_wait', { secs: STOP_CEILING_SECS })}`
      : text;
    note.className = `font-label-sm text-label-sm ${cls} leading-relaxed`;
    noteHoldUntil = Date.now() + NOTE_HOLD_MS;
  }
  invoke('push_log', {
    level: m.tone === 'error' ? 'error' : 'info',
    message: `cancel [${outcome.kind}] ${file || '(no path)'}`,
  });
}

/** إلغاء صفٍّ واحد من الطابور: **مهمّته وحدها** إن كانت مسجَّلة في الخلف
 *  (`cancel_job`)، وإلا إلغاء **محلي** (تُوقف حلقة الدفعة) — ولا `cancel_process`
 *  العامّ في أي فرع. ويعيد النتيجة كي يقيسها الاختبار ويُبلّغها النداء.
 *
 *  والمُدخَل `invoker` يُمرَّر (افتراضه `invoke` الحقيقي) فيُختبر السلوك بنداء
 *  وهمي يُسجّل الأوامر — بلا تشغيل التطبيق. */
export async function cancelQueueItem(
  file: string,
  invoker: JobInvoker = invoke,
): Promise<CancelOutcome> {
  const outcome = await cancelPath(invoker, file);
  if (outcome.kind === 'local') {
    // المهمّة لم تبدأ بعد (أو انتهت للتوّ): الإلغاء محلي — نفس ما يفعله
    // مسار F-3 في زرّ الفصل، ولا إلغاء عامّ.
    batchAbort = true;
  }
  reportCancelOutcome(outcome, file);
  return outcome;
}

/** إلغاء المهمّة التي **تخصّ التشغيل الجاري في الواجهة** — يستعمله زرّ الفصل
 *  حين يعمل كزرّ إلغاء (F-3/F-4)، فيستهدف مهمّته بدل كل التطبيق. */
async function cancelRunningPath(): Promise<void> {
  const file = runInFlightPath;
  if (!file) {
    // لا مسار معروف ⇒ لا نخمّن مهمّة ولا نقتل عريضاً: نقول ما نعرفه فقط.
    const note = document.getElementById('stop-note');
    if (note) {
      note.textContent = t('stop_local_queued');
      note.className = `font-label-sm text-label-sm ${toneClass('warn')} leading-relaxed`;
    }
    batchAbort = true;
    return;
  }
  await cancelQueueItem(file);
}

/* ── استطلاع السِجلّ ومواءمة الصفوف ────────────────────────────────────── */
let jobsPollTimer: number | undefined;
/** آخر قراءة موفَّقة (أو فارغة عند الفشل) — يقرأها رسم الشريط. */
let lastJobs: JobInfo[] = [];
/** رسالة فشل القراءة، أو null إن نجحت — «لا نعرف» حالة صريحة لا صفر مهامّ. */
let lastJobsError: string | null = null;
let failedPolls = 0;
/** بعد هذا العدد من القراءات الفاشلة المتتالية يتوقّف الاستطلاع (ويبقى نصّ
 *  الفشل معروضاً): لا نُنفق نداءً فاشلاً كل ثانية إلى الأبد. وأي ضغط على زرّ
 *  إيقاف أو بدء تشغيل يُعيد التسليح. */
const FAILED_POLL_LIMIT = 30;
/** بصمة آخر رسم — تمنع الكتابة في DOM كل ثانية بلا تغيّر (نفس نمط extSig). */
let stopBarSig = '';
/** نتيجة آخر ضغط من المستخدم تبقى معروضة هذه المدّة على الأقل، فلا يمحوها
 *  الاستطلاع بعد ثانية قبل أن يقرأها. */
const NOTE_HOLD_MS = 8000;
let noteHoldUntil = 0;

/** يسحب المهامّ النشطة مرّة، ويوائم الصفوف، ويرسم الشريط، ويوقف نفسه حين
 *  يخلو السِجلّ ولا تشغيل في الواجهة. */
async function syncJobsOnce(): Promise<void> {
  const reg = await fetchActiveJobs(invoke);
  if (reg.ok) {
    failedPolls = 0;
    lastJobsError = null;
    lastJobs = reg.jobs;
    reconcileBatchRows(reg.jobs);
  } else {
    failedPolls += 1;
    lastJobs = [];
    if (lastJobsError !== reg.error) {
      // يُسجَّل مرّة لكل خطأ مختلف — الفشل لا يُبتلع بصمت.
      invoke('push_log', { level: 'error', message: `active_jobs failed: ${reg.error}` });
    }
    lastJobsError = reg.error;
  }
  renderStopBar();
  // ع٢ (جولة الجاسوس): الحالة الفارغة تُشتقّ من **الطابور والسِجلّ معاً** —
  // فمهمّة حيّة بطابور واجهة فارغ (تلغرام/الجسر/إعادة تحميل أثناء عمل Rust)
  // لا يجوز أن تُقرأ «لا ملفات في الطابور بعد … ابدأ المعالجة».
  // والجولة الثالثة: **كل دورة تكتب المعرفة من نتيجتها** — فشل ⇒ «مجهول»
  // (لا «خامل»)، فلا يتقلّص الشرط الثلاثي إلى شرطين عند فقد المعرفة.
  setJobKnowledge(reg.ok ? (reg.jobs.length > 0 ? 'running' : 'idle') : 'unknown');
  if (reg.ok && !reg.jobs.length && session.isIdle() && !runInFlightPath) {
    stopJobsPolling();
  } else if (!reg.ok && failedPolls >= FAILED_POLL_LIMIT && session.isIdle() && !runInFlightPath) {
    stopJobsPolling(); // يبقى نصّ الفشل معروضاً، ويكفي أن نتوقّف عن الإلحاح
  }
}

/** يبدأ (أو يُعيد تسليح) الاستطلاع: قراءة فورية ثم كل ثانية أثناء وجود مهامّ.
 *  وإعادة التسليح تمسح أي مؤقّت قائم أولاً — فالنداء متكرّر (بداية كل صفٍّ في
 *  الدفعة) ولا يجوز أن يتراكم مؤقّتان يقرآن السِجلّ مرّتين في الثانية. */
export function startJobsPolling(): void {
  if (jobsPollTimer !== undefined) window.clearInterval(jobsPollTimer);
  jobsPollTimer = window.setInterval(() => { void syncJobsOnce(); }, 1000);
  void syncJobsOnce();
}

function stopJobsPolling(): void {
  if (jobsPollTimer === undefined) return;
  window.clearInterval(jobsPollTimer);
  jobsPollTimer = undefined;
}

/** يوائم حالة كل صفّ طابور مع السِجلّ: صفٌّ مهمّته حيّة يُعرض «يعمل» (وهذا
 *  إصلاح صفٍّ مُستعاد من `hl.batch` بعد إعادة تحميل الواجهة كان يقول «في
 *  الانتظار» ومهمّته تعمل)، وصفٌّ ادّعى العمل ولا مهمّة له تُصفَّر نسبته
 *  ويُعاد إلى الانتظار برسالة صريحة — فلا تبقى نسبة قديمة على الشاشة. */
function reconcileBatchRows(jobs: readonly JobInfo[]): void {
  const queue = session.getBatchQueue();
  if (!queue.length) return;
  for (const f of queue) {
    const local = itemStateOf(f);
    const hasJob = jobForPath(jobs, f) !== null;
    const r = reconcileItemState(local, hasJob, runInFlightPath === f);
    if (!r.changed) continue;
    if (r.stale) {
      setBatchItemState(f, 'pending');
      const item = document.querySelector<HTMLElement>(`#batch-list div[data-file="${CSS.escape(f)}"]`);
      if (item) resetBatchItemProgress(item, t('stop_row_stale'));
      // الرسالة الصريحة أهمّ من الرقم، فلا تُدهَس في صفّها — وبقية الصفوف تُحدَّث
      refreshWaitingPositions(item);
      saveBatchState();
      invoke('push_log', { level: 'warn', message: `queue row reset to pending (no backend job): ${f}` });
      continue;
    }
    markBatchItem(f, 'run');
    invoke('push_log', { level: 'info', message: `queue row marked running from active_jobs: ${f}` });
  }
}

/** يُعيد صفاً إلى شكل «في الانتظار» **ويصفّر نسبته المعروضة** — الاسم وحده
 *  لا يكفي: النسبة كانت تُرسم على حدث `sep-progress` ولا يمحوها شيء إذا ماتت
 *  المهمّة، فتبقى على الشاشة كأن العمل جارٍ. */
function resetBatchItemProgress(item: HTMLElement, note: string): void {
  item.className = 'batch-item bg-coal-surface/40 border border-border-muted rounded p-stack-sm flex flex-col gap-unit opacity-60 transition-all duration-300 apple-ease cursor-default relative overflow-hidden';
  item.querySelector('.batch-prog-bg')?.classList.add('hidden');
  item.querySelector('.batch-pct')?.classList.add('hidden');
  item.querySelector('.batch-prog-wrap')?.classList.add('hidden');
  const bg = item.querySelector<HTMLElement>('.batch-prog-bg');
  if (bg) bg.style.inlineSize = '0%';
  const bar = item.querySelector<HTMLElement>('.batch-prog-bar');
  if (bar) bar.style.inlineSize = '0%';
  const pct = item.querySelector<HTMLElement>('.batch-pct');
  if (pct) pct.textContent = '0%';
  const statusSpan = item.querySelector<HTMLElement>('.status-text');
  if (statusSpan) {
    statusSpan.textContent = note;
    statusSpan.className = 'status-text font-label-sm text-label-sm text-on-surface-variant relative z-10 flex-1';
  }
  item.querySelector('.batch-actions')?.classList.add('hidden');
  styleBatchItem(item);
}

/** يرسم شريط الإيقاف: الظهور والهدف والعدّاد ونصّ الفشل.
 *  قاعدة الظهور: يظهر ما دام في السِجلّ مهمّة، أو في الواجهة تشغيل جارٍ، أو
 *  فشلت القراءة (فلا ندّعي «لا مهامّ»). */
function renderStopBar(): void {
  const bar = document.getElementById('stop-bar');
  if (!bar) return;
  const target = stopTarget(lastJobs, runInFlightPath);
  const busy = runInFlightPath !== null || session.getActiveRun() !== null;
  const visible = lastJobsError !== null || lastJobs.length > 0 || busy;
  const sig = `${visible}|${lastJobsError ?? ''}|${lastJobs.length}|${target?.id ?? '-'}|${runInFlightPath ?? '-'}`;
  bar.classList.toggle('hidden', !visible);
  if (!visible) { stopBarSig = sig; return; }
  if (sig === stopBarSig) return; // لا كتابة في DOM بلا تغيّر
  stopBarSig = sig;
  const count = document.getElementById('stop-count');
  if (count) count.textContent = lastJobsError ? '?' : t('stop_count', { n: lastJobs.length });
  const targetEl = document.getElementById('stop-target');
  if (targetEl) {
    targetEl.textContent = target
      ? t('stop_target_line', { name: jobDisplayName(target) })
      : t('stop_target_none'); // «لا مهمّة معروفة» ≠ رسالة الإلغاء المحلي: لم يُلغَ شيء بعد
  }
  const note = document.getElementById('stop-note');
  if (note && lastJobsError) {
    note.textContent = t('stop_registry_failed', { error: lastJobsError });
    note.className = `font-label-sm text-label-sm ${toneClass('error')} leading-relaxed`;
  } else if (note && Date.now() >= noteHoldUntil) {
    note.textContent = '';
    note.className = 'font-label-sm text-label-sm text-on-surface-variant leading-relaxed';
  }
}

/** إلغاء الكل — زرّ منفصل ومسمّى صراحةً، لا يفعل ما يفعله زرّ المهمّة. */
async function stopAllJobs(): Promise<void> {
  const note = document.getElementById('stop-note');
  const write = (text: string, tone: 'ok' | 'warn' | 'error'): void => {
    if (!note) return;
    note.textContent = text;
    note.className = `font-label-sm text-label-sm ${toneClass(tone)} leading-relaxed`;
    noteHoldUntil = Date.now() + NOTE_HOLD_MS;
  };
  try {
    const n = await invoke<number>('cancel_all_jobs');
    write(n ? t('stop_all_result', { n }) : t('stop_all_none'), n ? 'ok' : 'warn');
    invoke('push_log', { level: n ? 'warn' : 'info', message: `cancel_all_jobs → ${n}` });
  } catch (e) {
    write(t('stop_all_failed', { error: errText(e) }), 'error');
    invoke('push_log', { level: 'error', message: `cancel_all_jobs failed: ${e}` });
  }
}

/** إيقاف المهمّة المعروضة: مهمّة الصفّ الجاري إن وُجد، وإلا **المهمّة التي
 *  يسمّيها الشريط** — وهي أقدم مهمّة نشطة، ومعروضة نصّاً في `#stop-target`
 *  فلا يُلغي الزرّ شيئاً لم يره المستخدم. */
async function stopDisplayedJob(): Promise<void> {
  if (runInFlightPath) {
    await cancelQueueItem(runInFlightPath);
    return;
  }
  const target = stopTarget(lastJobs, null);
  if (!target) {
    // لا مهمّة معروفة: إلغاء محلي فقط + رسالة صريحة (ولا إلغاء عامّ).
    const outcome: CancelOutcome = { kind: 'local' };
    reportCancelOutcome(outcome, '');
    return;
  }
  const outcome = await cancelJobById(invoke, target.id);
  reportCancelOutcome(outcome, typeof target.path === 'string' ? target.path : '');
}

/** ربط شريط الإيقاف (يُنادى من main.ts بعد الإقلاع). */
export function wireStopBar(): void {
  document.getElementById('btn-stop-job')?.addEventListener('click', () => { void stopDisplayedJob(); });
  document.getElementById('btn-stop-all')?.addEventListener('click', () => { void stopAllJobs(); });
  startJobsPolling();
}

/** Re-run one failed batch item with the last used separation options.
 *
 * The retry button is rendered INSIDE the batch list, so it is on screen while
 * the batch loop is still working on another file. Clicking it used to start a
 * second separator beside the one in flight (`batchRunning` and
 * `singleRunning` both true — the state `integration.ts:101/108` reads to keep
 * the two progress channels apart). The click now goes through the same
 * gate as every other run: no lease, no second run. */
let lastSepOpts: SepOpts | null = null;
async function retryBatchItem(file: string): Promise<void> {
  const result = sepResultEl();
  if (!result) return;
  if (!session.isIdle()) {
    // Say why nothing happened instead of starting a racing job.
    result.textContent = t('sep_busy');
    result.classList.remove('hidden');
    invoke('push_log', {
      level: 'warn',
      message: `retry ignored: a ${session.getActiveRun() ?? 'unknown'} run is in progress (${file})`,
    });
    return;
  }
  const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
  const o: SepOpts = lastSepOpts ?? {
    outKind: (kindSel?.dataset.kind as 'audio' | 'video') ?? 'audio',
  };
  const keepInst = (document.getElementById('keep-inst') as HTMLInputElement)?.checked ?? false;
  markBatchItem(file, 'run');
  await runOne(file, keepInst, o, result);
}

/* ── separation (single + batch) ────────────────────────────────────── */
type SepOpts = { outKind: 'audio' | 'video'; quality?: number; advFmt?: string };

async function runSeparationFor(path: string, keepInst: boolean, o: SepOpts): Promise<SepResult> {
  const useCuda = localStorage.getItem('hl.cuda') === '1';
  const res = await invoke<SepResult>('separate_file', {
    path,
    outDir: outDirOf(path),
    mode: session.getCurrentMode(),
    kind: o.outKind,
    quality: o.quality ?? null,
    format: o.advFmt ?? null,
    keepInstrumental: keepInst,
    useCuda: useCuda,
    // (كان هنا `previewSeconds: …` — وحُذف مع «المعاينة السريعة»: كان `null`
    // دائماً، والرست لم يعد يقبل الحقل أصلاً.)
  });
  return res;
}

export function wireSeparate(): void {
  const result = sepResultEl();
  let stageHideTimer: number | undefined; // F-5: one pending hide at a time

  // F-2: cache the active batch item + its children — sep-progress fires at
  // very high frequency and used to run 4 DOM queries per event.
  let cachedItem: HTMLElement | null = null;
  let cachedBg: HTMLElement | null = null;
  let cachedBar: HTMLElement | null = null;
  let cachedText: HTMLElement | null = null;
  let lastSepPct = 0;
  let lastStage: { stage: string; pct: number } | null = null;
  const paintSepProgress = () => {
    const pct = Math.round(lastSepPct * 100);
    const activeItem = document.querySelector<HTMLElement>('.batch-item.running-item');
    if (activeItem !== cachedItem) {
      cachedItem = activeItem;
      cachedBg = activeItem ? activeItem.querySelector<HTMLElement>('.batch-prog-bg') : null;
      cachedBar = activeItem ? activeItem.querySelector<HTMLElement>('.batch-prog-bar') : null;
      cachedText = activeItem ? activeItem.querySelector<HTMLElement>('.batch-pct') : null;
    }
    if (cachedBg) cachedBg.style.inlineSize = `${pct}%`;
    if (cachedBar) cachedBar.style.inlineSize = `${pct}%`;
    if (cachedText) cachedText.textContent = `${pct}%`;
    if (lastSepPct >= 1.0) {
      // F-5: clear any pending hide so the NEXT batch file's stage line
      // isn't hidden by the PREVIOUS file's 1200ms timer.
      if (stageHideTimer) window.clearTimeout(stageHideTimer);
      stageHideTimer = window.setTimeout(hideStageLine, 1200);
    }
  };
  void listen<number>('sep-progress', (ev) => {
    lastSepPct = ev.payload;
    session.coalesceRaf('sep-progress', paintSepProgress);
  });

  // Sprint C2: visible pipeline stages (توحيد ← فصل ← مؤثرات ← ترميز)
  const paintSepStage = () => {
    if (!lastStage) return;
    const line = document.getElementById('stage-line');
    const name = document.getElementById('stage-name');
    const bar = document.getElementById('stage-bar');
    const pctEl = document.getElementById('stage-pct');
    if (!line || !name || !bar || !pctEl) return;
    line.classList.remove('hidden');
    const pct = Math.round(lastStage.pct * 100);
    name.textContent = STAGE_NAMES[lastStage.stage]?.[currentLang()] ?? lastStage.stage;
    bar.style.inlineSize = `${pct}%`;
    pctEl.textContent = `${pct}%`;
  };
  void listen<{ stage: string; pct: number }>('sep-stage', (ev) => {
    lastStage = ev.payload;
    session.coalesceRaf('sep-stage', paintSepStage);
  });

  sepBtnEl()?.addEventListener('click', async () => {
    if (session.getBatchRunning()) {
      // F-3: abort the file being processed NOW, not just the ones after it.
      // م٢: والإلغاء يستهدف **مهمّة الملف الجاري** (cancel_job بمسارها) بدل
      // العلم العامّ الذي كان يُلغي كل شيء ولا يعرف أيّ مهمّة يقصد.
      batchAbort = true;
      await cancelRunningPath();
      return;
    }
    if (session.getSingleRunning()) {
      // F-4: the separate button doubles as a cancel button for single runs
      await cancelRunningPath();
      return;
    }
    const keepInst = (document.getElementById('keep-inst') as HTMLInputElement)?.checked ?? false;
    const advFmt = (document.getElementById('fmt-select') as HTMLSelectElement)?.value;
    const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
    const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'audio';
    /* «الجودة» لكل تشغيل: مصدرها الوحيد كان `#quality-select` وهو غير موجود،
       فكانت `qSel?.value` دائماً `undefined` ⇒ `quality` **دائماً `undefined`**.
       ولا قيمة إعداد هنا: **لا حقل `quality` في `Settings`/`settings.json`**
       (مقيس: صفر مطابقة في `settings.ts` · `session.ts` · `settings.rs`)، وإنما
       هو خيار لكل تشغيل في `SepOpts`. والحقل **باقٍ كما هو** (`quality?: number`)
       فيبقى ما يُرسل إلى الرست بايتاً بايتاً كما كان: `o.quality ?? null` = `null`. */
    const quality: number | undefined = undefined;

    // single-file fast path
    if (session.getBatchQueue().length <= 1) {
      if (!session.getLastProbeOk() || !session.getCurrentMediaPath()) {
        setVerdict(probeEl(), t('sep_need_file'), true);
        return;
      }
      lastSepOpts = { outKind, quality, advFmt };
      await runOne(session.getCurrentMediaPath(), keepInst, { outKind, quality, advFmt }, result!);
      return;
    }

    // batch path
    lastSepOpts = { outKind, quality, advFmt };
    // Same lease as the single path: if anything already owns the engine the
    // loop must not start (the button guards above, this is the chokepoint).
    if (!session.setBatchRunning(true)) {
      setVerdict(probeEl(), t('sep_busy'), true);
      return;
    }
    batchAbort = false;
    sepBtnEl().textContent = t('toggle_pause');
    const failures: string[] = [];
    const cancelled: string[] = [];
    const total = session.getBatchQueue().length;
    let done = 0;
    for (const f of session.getBatchQueue()) {
      if (batchAbort) break;
      markBatchItem(f, 'run');
      runInFlightPath = f; // م٢: مسار المهمّة الجارية — يقرؤه زرّ الإيقاف والمواءمة
      startJobsPolling();
      setBatchCounter(done, total);
      try {
        const res = await runSeparationFor(f, keepInst, { outKind, quality, advFmt });
        const resultPath = res.video || res.vocals || res.instrumental || undefined;
        markBatchItem(f, 'ok', resultPath);
        void notify(t('notify_done'), fileBaseName(f));
      } catch (e) {
        // الإلغاء ليس فشلاً (عطل ميداني 2026-09-21): الخلف يقول `أُلغيت: true`،
        // فالصفّ يُوسم `cancelled` بنصّه المحايد، **ولا يُحصى في `failures`**،
        // **ولا يُسجَّل ERROR** — والإلغاء قرار المستخدم لا عطل.
        if (isCancellation(e)) {
          markBatchItem(f, 'cancelled');
          cancelled.push(f);
          invoke('push_log', { level: 'info', message: `batch item cancelled by user: ${f}` });
        } else {
          markBatchItem(f, 'fail');
          failures.push(`${f} — ${errText(e)}`);
          invoke('push_log', { level: 'error', message: `batch item failed: ${f}: ${e}` });
          void notify(t('notify_fail'), fileBaseName(f));
        }
      } finally {
        // النداء انتهى: لا «تشغيل معلَّق» بعد الآن (فلا تُقرأ مهمّة لم تُسجَّل
        // بعد ولا يُمنع وسم صفٍّ ميت بأنه يعمل).
        if (runInFlightPath === f) runInFlightPath = null;
      }
      done += 1;
      setBatchCounter(done, total);
    }
    session.endRun('batch');
    sepBtnEl().disabled = false;
    const key = session.getCurrentMode() === 'song' ? 'btn_sep_song' : 'btn_sep_clip';
    sepBtnEl().innerHTML =
      `<span class="material-symbols-outlined transition-transform duration-300 apple-ease group-hover:rotate-12 group-hover:scale-110" data-icon="content_cut">content_cut</span>
       <span id="sep-label" data-i18n="${key}">${t(key)}</span>`;
    if (result) {
      // ملخّص الدفعة يميّز الملغى (عطل ميداني 2026-09-21): كان يقول `1/2` ويُحصي
      // الملغى **فشلاً**. واليوم يقول المنجَز من المجموع، ويسمّي الملغى وحده في
      // سطر مستقل، ويسرد الفاشل وحده — فلا يُخلط قرارُ المستخدم بعطل.
      const parts = [`${t('batch_done')} ${total - failures.length - cancelled.length}/${total}`];
      if (cancelled.length) parts.push(t('batch_cancelled', { n: cancelled.length }));
      if (failures.length) parts.push(`${t('batch_failed_list')}\n${failures.join('\n')}`);
      if (!cancelled.length && !failures.length) parts[0] += ' ✓';
      result.textContent = parts.join('\n');
      result.classList.remove('hidden');
    }
    invoke('push_log', {
      level: failures.length ? 'warn' : 'info',
      message: `batch finished: ${total - failures.length - cancelled.length}/${total}`
        + (cancelled.length ? ` · cancelled ${cancelled.length}` : '')
        + (failures.length ? ` · failed ${failures.length}` : ''),
    });
    // A finished batch (even partially failed — failures keep retry buttons)
    // is no longer "interrupted": drop the persisted queue.
    // (والملغى كذلك: قرار المستخدم أُعلن في السِجلّ، فلا يبقى الطابور «مقاطعاً».)
    if (batchAbort || (failures.length === 0 && cancelled.length === 0)) localStorage.removeItem('hl.batch');
    else saveBatchState();
    void notify(t('notify_batch_done'), `${total - failures.length - cancelled.length}/${total} ✓`);
  });

}

async function runOne(
  path: string,
  keepInst: boolean,
  o: SepOpts,
  result: HTMLElement,
): Promise<void> {
  const btn = sepBtnEl();
  // The single gate for "may a run start now": the same lease the batch loop
  // and the retry button take (session.ts). Without it a caller that skipped
  // the button guard could still start a second separator on the same engine.
  if (!session.setSingleRunning(true)) {
    result.textContent = t('sep_busy');
    result.classList.remove('hidden');
    invoke('push_log', {
      level: 'warn',
      message: `run refused: ${session.getActiveRun() ?? 'another'} run in progress (${path})`,
    });
    return;
  }
  const prevHtml = btn.innerHTML;
  btn.disabled = false; // F-4: stays clickable — it is now the cancel button
  btn.textContent = t('toggle_cancel');
  result.classList.add('hidden');
  markBatchItem(path, 'run');
  runInFlightPath = path; // م٢: هويّة مهمّته — يقرؤها زرّ الإيقاف والمواءمة
  startJobsPolling();
  try {
    const res = await runSeparationFor(path, keepInst, o);
    const lines = [t('sep_done_secs', { secs: res.seconds.toFixed(1) })];
    if (res.vocals) lines.push(`${t('sep_out_audio')} ${res.vocals}`);
    if (res.instrumental) lines.push(`${t('sep_out_music')} ${res.instrumental}`);
    if (res.video) lines.push(`${t('sep_out_video')} ${res.video}`);
    result.textContent = lines.join('\n');
    result.classList.remove('hidden');
    const resultPath = res.video || res.vocals || res.instrumental || undefined;
    markBatchItem(path, 'ok', resultPath);
    void notify(t('notify_done'), fileBaseName(path));
  } catch (e) {
    // الإلغاء ليس فشلاً: النصّ موجود أصلاً في هذا المسار (`sep_cancelled`)،
    // والناقص كان **الحالة والسجلّ** — كان يُوسم `fail` ويُسجَّل ERROR.
    const cancelled = isCancellation(e);
    result.textContent = cancelled ? t('sep_cancelled') : `${t('sep_failed')} ${errText(e)}`;
    result.classList.remove('hidden');
    markBatchItem(path, cancelled ? 'cancelled' : 'fail');
    invoke('push_log', {
      level: cancelled ? 'info' : 'error',
      message: cancelled ? `separate cancelled by user: ${path}` : `separate failed: ${e}`,
    });
    if (!cancelled) void notify(t('notify_fail'), fileBaseName(path));
  } finally {
    session.endRun('single');
    if (runInFlightPath === path) runInFlightPath = null;
    btn.disabled = false;
    btn.innerHTML = prevHtml;
  }
}

/* ── URL download (M5 UI) ───────────────────────────────────────────── */
export function wireUrlDownload(): void {
  const btn = document.getElementById('btn-download') as HTMLButtonElement;
  const input = document.getElementById('url-input') as HTMLInputElement;
  const wrap = document.getElementById('dl-progress-wrap');
  const bar = document.getElementById('dl-progress');
  const res = document.getElementById('dl-result');
  const upd = document.getElementById('btn-upd-ytdlp') as HTMLButtonElement;

  let lastDlPct = 0;
  void listen<number>('dl-progress', (ev) => {
    lastDlPct = ev.payload;
    session.coalesceRaf('dl-progress', () => {
      if (bar) bar.style.inlineSize = `${Math.round(lastDlPct * 100)}%`;
    });
  });

  btn?.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url || !wrap || !bar || !res) return;
    btn.disabled = true;
    wrap.classList.remove('hidden');
    bar.style.inlineSize = '2%';
    res.classList.add('hidden');
    try {
      const outDir = pathInputEl().value
        ? outDirOf(pathInputEl().value)
        : '';
      const file = await invoke<string>('download_media_cmd', { url, outDir });
      res.textContent = `${t('dl_done')} ${file}`;
      res.classList.remove('hidden');
      await ingestFiles([file]); // auto-fill + probe the downloaded file
    } catch (e) {
      res.textContent = `${t('dl_failed')} ${errText(e)}`;
      res.classList.remove('hidden');
    } finally {
      bar.style.inlineSize = '100%';
      setTimeout(() => wrap.classList.add('hidden'), 600);
      btn.disabled = false;
    }
  });

  upd?.addEventListener('click', async () => {
    upd.disabled = true;
    try {
      // force=true (الأمر نفسه منذ M5): يعمل حتى مع إطفاء التحديث التلقائي،
      // فهو طلب صريح من المستخدم لا فحصاً خلفياً. وبعد النجاح يُعاد قراءة
      // الإصدار المعروض في الإعدادات (ق-١) فلا يبقى الرقم قديماً.
      //
      // **والعرض عبر `errText` لا `r.message`** (ط-٤ · البند ٣): `message` هو
      // النصّ الخام من `yt_dlp.rs` — **عربي دائماً** — فكان يُعرض كما هو لقارئ
      // الواجهة الإنجليزية. و`code` (`U_*`) هو ما يُترجم إلى `u.*` بلغة القارئ،
      // **و`detail` الخام يبقى في الحمولة وفي سجلّ الخلف** فلا يُفقد سبب.
      const r = await invoke<{ updated: boolean; code?: string; detail?: string; message?: string }>(
        'update_ytdlp',
      );
      if (res) {
        res.textContent = errText({ code: r.code, error: r.detail ?? r.message ?? '' });
        res.classList.remove('hidden');
      }
      refreshYtdlpUpdateUi();
    } finally {
      upd.disabled = false;
    }
  });
}
