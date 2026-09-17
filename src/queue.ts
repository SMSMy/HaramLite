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
 * (separate_file، cancel_process، download_media_cmd، update_ytdlp، push_log)
 * ولا حقل واحد في حِمل separate_file. الوحيد المضاف: export على ما تحتاجه
 * main.ts (ingestFiles، stopBatch، wireSeparate، wireUrlDownload،
 * restoreBatchState، updateQualityOptions).
 */

import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { currentLang, t } from './i18n';
import { STAGE_NAMES, hideStageLine } from './cuda';
import { fileBaseName, notify, showToast } from './util';
import type { SepResult } from './types';
import { outDirOf, pathInputEl, probeEl, runProbe, sepBtnEl, sepResultEl, setVerdict, setVerdictHtml, verdictHtml } from './media';
import * as session from './session';
import { refreshYtdlpUpdateUi } from './ytdlpUi';

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
  const wrap = document.getElementById('q-wrap');
  const sel = document.getElementById('quality-select') as HTMLSelectElement | null;
  const videoCard = document.getElementById('kind-video');

  // Video kind only makes sense for real video inputs; dim it otherwise.
  // This MUST run before any early return: the Lite UI has no
  // `quality-select`, so the old `if (!wrap || !sel || !videoCard) return;`
  // skipped the dimming entirely and let users pick MP4 video for audio-only
  // files (guaranteed ffmpeg failure).
  if (videoCard) videoCard.classList.toggle('dimmed', srcHeight === null);
  if (!wrap || !sel) return;

  if (srcHeight === null) {
    sel.replaceChildren();
    return;
  }

  const ladder = [srcHeight, 1080, 720, 480, 360]
    .filter((h) => h > 0 && h <= srcHeight)
    .filter((h, i, arr) => arr.indexOf(h) === i)
    .sort((a, b) => b - a);

  sel.replaceChildren(
    ...ladder.map((h, idx) => {
      const o = document.createElement('option');
      o.value = String(h);
      o.textContent = idx === 0 ? t('quality_same', { h }) : `${h}p`;
      return o;
    }),
  );
  sel.value = String(ladder[0] ?? '');
}

/* ── batch engine (F5): sequential, continue-on-fail ────────────────── */
let batchAbort = false;
/** Stop the batch AND the backend job behind it. Without cancel_process the
 *  Rust pipeline keeps grinding (ghost processing) and `batchRunning` stays
 *  true until it finishes — the next "فصل" click then cancels instead of
 *  starting. */
export async function stopBatch(): Promise<void> {
  batchAbort = true;
  session.setBatchQueue([]);
  batchStatus.clear();
  localStorage.removeItem('hl.batch');
  document.getElementById('batch-list')?.classList.add('hidden');
  document.getElementById('batch-counter')?.classList.add('hidden');
  // Phantom-cancel fix: stopBatch runs on EVERY single-file ingest, and it
  // used to fire cancel_process (and its scary backend WARN line) even with
  // nothing running. Only signal when a job actually exists to abort.
  if (!session.getBatchRunning() && !session.getSingleRunning()) return;
  try {
    await invoke('cancel_process');
  } catch (e) {
    console.error('cancel_process failed', e);
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
function renderBatchList(): void {
  const ul = document.getElementById('batch-list');
  if (!ul) return;
  ul.classList.remove('hidden');
  ul.replaceChildren(
    ...session.getBatchQueue().map((f) => {
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
    }),
  );
  batchStatus.clear();
  for (const f of session.getBatchQueue()) batchStatus.set(f, 'pending');
  saveBatchState();
}

/* ── batch persistence (functional gap: memory-only queue) ──────────── */
// The queue (+ per-item status) survives close/crash; completion or an
// explicit stop clears it. Resume re-queues only pending/failed items —
/// never reprocesses finished ones.
type BatchItemState = 'pending' | 'run' | 'ok' | 'fail';
const batchStatus = new Map<string, BatchItemState>();
function saveBatchState(): void {
  try {
    if (session.getBatchQueue().length) {
      localStorage.setItem('hl.batch', JSON.stringify(
        session.getBatchQueue().map((f) => ({ f, s: batchStatus.get(f) ?? 'pending' })),
      ));
    } else localStorage.removeItem('hl.batch');
  } catch { /* storage full/blocked — queue simply stays volatile */ }
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
          typeof it.f === 'string' && (it.s === 'pending' || it.s === 'run' || it.s === 'fail' || it.s === 'ok'));
    }
  } catch { items = []; }
  const files = items.filter((it) => it.s !== 'ok').map((it) => it.f);
  const skipped = items.length - files.length;
  if (!files.length) {
    if (items.length) localStorage.removeItem('hl.batch');
    return;
  }
  session.setBatchQueue(files);
  renderBatchList();
  setBatchCounter(0, session.getBatchQueue().length);
  showToast(t('batch_restored', {
    count: files.length,
    skipped: skipped ? t('batch_restored_skipped', { skipped }) : '',
  }));
  invoke('push_log', { level: 'warn', message: `batch restored after restart: ${files.length} files (${skipped} done skipped)` });
}

function markBatchItem(file: string, status: 'ok' | 'fail' | 'run', resultPath?: string): void {
  batchStatus.set(file, status);
  const item = document.querySelector<HTMLElement>(`#batch-list div[data-file="${CSS.escape(file)}"]`);
  if (!item) { saveBatchState(); return; }
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
          actionsDiv.querySelector('button')?.addEventListener('click', () => {
              invoke('cancel_process').catch(console.error);
          });
      }
  } else if (status === 'ok') {
      item.className = 'batch-item bg-tertiary-container/20 border border-tertiary/40 rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.add('hidden');
      item.querySelector('.batch-pct')?.classList.add('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.add('hidden');
      if (statusSpan) {
          statusSpan.textContent = session.getPreviewEnabled() ? t('sep_done_preview') : t('sep_done_short');
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
  }
  styleBatchItem(item); // className swaps above wipe it — restore last
  saveBatchState();
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
    previewSeconds: session.getPreviewEnabled() ? session.getPreviewSeconds() : null,
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
      // F-3: abort the file being processed NOW, not just the ones after it
      batchAbort = true;
      void invoke('cancel_process');
      return;
    }
    if (session.getSingleRunning()) {
      // F-4: the separate button doubles as a cancel button for single runs
      void invoke('cancel_process');
      return;
    }
    const keepInst = (document.getElementById('keep-inst') as HTMLInputElement)?.checked ?? false;
    const advFmt = (document.getElementById('fmt-select') as HTMLSelectElement)?.value;
    const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
    const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'audio';
    const qSel = document.getElementById('quality-select') as HTMLSelectElement | null;
    const quality = outKind === 'video' && qSel?.value ? Number(qSel.value) : undefined;

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
    const total = session.getBatchQueue().length;
    let done = 0;
    for (const f of session.getBatchQueue()) {
      if (batchAbort) break;
      markBatchItem(f, 'run');
      setBatchCounter(done, total);
      try {
        const res = await runSeparationFor(f, keepInst, { outKind, quality, advFmt });
        const resultPath = res.video || res.vocals || res.instrumental || undefined;
        markBatchItem(f, 'ok', resultPath);
        void notify(t('notify_done'), fileBaseName(f));
      } catch (e) {
        markBatchItem(f, 'fail');
        failures.push(`${f} — ${e}`);
        invoke('push_log', { level: 'error', message: `batch item failed: ${f}: ${e}` });
        void notify(t('notify_fail'), fileBaseName(f));
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
      result.textContent = failures.length
        ? `${t('batch_done')} ${total - failures.length}/${total}\n${t('batch_failed_list')}\n${failures.join('\n')}`
        : `${t('batch_done')} ${total}/${total} ✓`;
      result.classList.remove('hidden');
    }
    invoke('push_log', {
      level: failures.length ? 'warn' : 'info',
      message: `batch finished: ${total - failures.length}/${total}`,
    });
    // A finished batch (even partially failed — failures keep retry buttons)
    // is no longer "interrupted": drop the persisted queue.
    if (batchAbort || failures.length === 0) localStorage.removeItem('hl.batch');
    else saveBatchState();
    void notify(t('notify_batch_done'), `${total - failures.length}/${total} ✓`);
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
    const msg = String(e);
    result.textContent = msg.includes('إلغاء') ? t('sep_cancelled') : `${t('sep_failed')} ${e}`;
    result.classList.remove('hidden');
    markBatchItem(path, 'fail');
    invoke('push_log', { level: 'error', message: `separate failed: ${e}` });
    void notify(t('notify_fail'), fileBaseName(path));
  } finally {
    session.endRun('single');
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
      res.textContent = `${t('dl_failed')} ${e}`;
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
      const r = await invoke<{ updated: boolean; message: string }>('update_ytdlp');
      if (res) {
        res.textContent = r.message;
        res.classList.remove('hidden');
      }
      refreshYtdlpUpdateUi();
    } finally {
      upd.disabled = false;
    }
  });
}
