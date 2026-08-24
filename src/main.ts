import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as dialog from '@tauri-apps/plugin-dialog';

type LogLine = { ts: string; level: string; target: string; message: string };
type MediaInfo = {
  container: string;
  duration_secs: number;
  has_audio: boolean;
  has_video: boolean;
  video_is_cover_art: boolean;
  audio_disguised_as_video: boolean;
  audio_codec: string | null;
  sample_rate: number | null;
  height: number | null;
};
type SepResult = {
  vocals: string;
  instrumental: string | null;
  video: string | null;
  seconds: number;
};

const i18n = {
  ar: {
    actions_title: 'تشخيص',
    btn_info: 'INFO تجريبي',
    btn_error: 'ERROR تجريبي',
    btn_panic: 'التقاط panic اختباري',
    btn_clear: 'تفريغ العرض',
    log_title: 'سجل الأحداث (حي)',
    autoscroll: 'تلقائي التمرير',
    media_title: 'الملف',
    mode_title: 'الوضع',
    mode_song: 'أغنية',
    mode_song_desc: 'إذا كنت تعزل الموسيقى عن أغنية، اختر هذا الخيار؛ سضيف قطع الصمت ويزيل كتمة الصوت.',
    mode_clip: 'مقطع عادي',
    mode_clip_desc: 'للمقاطع التي تحتوي على متحدثين: لن يقطع الصمت، وسيزيل الموسيقى فقط.',
    fmt_label: 'صيغة الإخراج:',
    btn_probe: 'فحص',
    btn_sep_song: 'عزل <span class="kashida-text">الموسيقى</span> وإضافة المؤثرات',
    kind_audio: 'صوت MP3',
    kind_audio_desc: 'الغناء المعالَج ملفاً صوتياً',
    kind_video: 'فيديو MP4',
    kind_video_desc: 'نفس الصورة بصوت معالج',
    btn_sep_clip: 'إزالة الموسيقى فقط',
    url_title: 'تحميل من رابط (YouTube ونحوها)',
    btn_download: 'تنزيل',
    drop_hint: 'اسحب الملفات وأفلتها هنا — أو',
    btn_browse: 'اختيار من الجهاز',
    err_not_found: '✗ المسار غير موجود — تأكد من الصحة',
    err_is_dir: '✗ هذا مجلد وليس ملفاً — اختر ملفاً داخل المجلد',
    err_no_audio: '⚠ لا يوجد مسار صوتي في هذا الملف',
  },
  en: {
    actions_title: 'Diagnostics',
    btn_info: 'Test INFO log',
    btn_error: 'Test ERROR log',
    btn_panic: 'Trigger test panic',
    btn_clear: 'Clear view',
    log_title: 'Live event log',
    autoscroll: 'Auto-scroll',
    media_title: 'File',
    mode_title: 'Mode',
    mode_song: 'Song',
    mode_song_desc: 'separate + revival FX + silence cut',
    mode_clip: 'Normal clip',
    mode_clip_desc: 'music removal only — faster',
    fmt_label: 'Output format:',
    btn_probe: 'Probe',
    btn_sep_song: 'Isolate music & add FX',
    kind_audio: 'MP3 Audio',
    kind_audio_desc: 'processed vocals as an audio file',
    kind_video: 'MP4 Video',
    kind_video_desc: 'same picture with processed audio',
    btn_sep_clip: 'Remove music only',
    url_title: 'Download from link (YouTube etc.)',
    btn_download: 'Download',
    drop_hint: 'Drag & drop files here — or',
    btn_browse: 'Browse files',
    err_not_found: '✗ Path not found — please verify',
    err_is_dir: '✗ That is a folder — pick a file inside it',
    err_no_audio: '⚠ No audio track in this file',
  },
} as const;

let lang: 'ar' | 'en' = localStorage.getItem('hl.lang') === 'en' ? 'en' : 'ar';

function t(key: keyof (typeof i18n)['ar']): string {
  return i18n[lang][key];
}

function applyLang(): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as keyof (typeof i18n)['ar'];
    el.innerHTML = i18n[lang][key];
  });
}

/* ── path sanitization (B1/B2 root cause) ─────────────────────────── */
function sanitizePath(raw: string): string {
  let p = raw.trim();
  // strip ONE pair of surrounding quotes (Explorer "copy as path")
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).trim();
  }
  return p;
}

const view = document.getElementById('log-view') as HTMLDivElement;
const autoscroll = document.getElementById('autoscroll') as HTMLInputElement;

function renderLogs(lines: LogLine[]): void {
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const div = document.createElement('div');
    const lvl = document.createElement('span');
    lvl.className = `lv-${line.level}`;
    lvl.textContent = `${line.ts} ${line.level.padEnd(5)} `;
    const body = document.createElement('span');
    body.textContent = `[${line.target}] ${line.message}`;
    div.append(lvl, body);
    frag.appendChild(div);
  }
  const stick = autoscroll.checked && nearBottom();
  view.replaceChildren(frag);
  if (stick || autoscroll.checked) view.scrollTop = view.scrollHeight;
}

function nearBottom(): boolean {
  return view.scrollHeight - view.scrollTop - view.clientHeight < 40;
}

let logOpen = localStorage.getItem('hl.log_open') === '1';

async function refresh(): Promise<void> {
  if (!logOpen) return;
  try {
    renderLogs(await invoke<LogLine[]>('get_recent_logs', { limit: 500 }));
  } catch (e) {
    console.error('get_recent_logs failed', e);
  }
}

function wireLogToggle(): void {
  const card = document.getElementById('logcard');
  const toggle = document.getElementById('log-toggle');
  const icon = toggle?.querySelector('span[data-icon="expand_less"]') as HTMLElement;
  const sync = () => {
    view.classList.toggle('hidden', !logOpen);
    card?.classList.toggle('collapsed', !logOpen);
    if (icon) {
       icon.textContent = logOpen ? 'expand_more' : 'expand_less';
    }
    if (logOpen) void refresh();
  };
  toggle?.addEventListener('click', (ev) => {
    // don't toggle if clicking on autoscroll
    if ((ev.target as HTMLElement).closest('.autoscroll')) return;
    logOpen = !logOpen;
    localStorage.setItem('hl.log_open', logOpen ? '1' : '0');
    sync();
  });
  sync();
}

/* ── global state ───────────────────────────────────────────────────── */
let currentMediaPath = '';
let lastProbeOk = false;
let currentMode: 'song' | 'clip' = 'song';
let batchQueue: string[] = [];
let batchRunning = false;

function setVerdict(el: HTMLElement | null, html: string, isBad = false): void {
  if (!el) return;
  el.innerHTML = html;
  el.classList.toggle('text-error', isBad);
  el.classList.toggle('text-on-surface-variant', !isBad);
}

function probeEl() { return document.getElementById('media-verdict'); }
function sepResultEl() { return document.getElementById('sep-result'); }
function pathInputEl() { return document.getElementById('media-path') as HTMLInputElement; }
function sepBtnEl() { return document.getElementById('btn-separate') as HTMLButtonElement; }

/** Validate a pasted/dropped path BEFORE any backend call. Returns cleaned path or null. */
async function validatePath(rawPath: string): Promise<{ ok: true; path: string } | { ok: false }> {
  const p = sanitizePath(rawPath);
  const v = probeEl();
  if (!p) {
    setVerdict(v, t('err_not_found'), true);
    return { ok: false };
  }
  let exists = false;
  let isDir = false;
  try {
    exists = await invoke<boolean>('path_exists', { path: p });
    if (exists) isDir = await invoke<boolean>('path_is_dir', { path: p });
  } catch {
    exists = false;
  }
  if (!exists) {
    setVerdict(v, t('err_not_found'), true);
    invoke('push_log', { level: 'error', message: `مسار غير موجود: ${p}` });
    return { ok: false };
  }
  if (isDir) {
    setVerdict(v, t('err_is_dir'), true);
    invoke('push_log', { level: 'error', message: `مجلد وليس ملفاً: ${p}` });
    return { ok: false };
  }
  pathInputEl().value = p;
  return { ok: true, path: p };
}

async function runProbe(rawPath?: string): Promise<MediaInfo | null> {
  const target = rawPath ?? pathInputEl().value;
  const validated = await validatePath(target);
  const v = probeEl();
  lastProbeOk = false;
  sepBtnEl().disabled = true;

  if (!validated.ok) return null;
  currentMediaPath = validated.path;

  try {
    const info = await invoke<MediaInfo>('probe_media', { path: currentMediaPath });
    if (!info.has_audio) {
      setVerdict(v!, t('err_no_audio'), true);
      return null;
    }
    const flags: string[] = [];
    if (info.audio_disguised_as_video) flags.push('⚠ ' + 'صوت متنكّر في حاوية فيديو — سنعالجه كصوت');
    if (info.video_is_cover_art) flags.push('ℹ الفيديو مجرد صورة غلاف');

    // Auto-switch UI based on media type
    if (info.has_video && !info.video_is_cover_art) {
        document.getElementById('kind-video')?.click();
    } else {
        document.getElementById('kind-audio')?.click();
    }

    const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
    const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'video';
    const word = outKind === 'video' ? 'فيديو' : 'صوت';
    setVerdict(v!, `نوع الإخراج: <span class="bg-clay-accent/20 text-clay-accent px-1.5 py-0.5 rounded font-bold mr-1 inline-block">${word}</span>`, false);

    lastProbeOk = true;
    sepBtnEl().disabled = false;

    // F4: MP4 option only for real video inputs
    const mp4opt = document.querySelector<HTMLSelectElement>('#fmt-select option[value="mp4video"]');
    if (mp4opt) mp4opt.disabled = !info.has_video;

    invoke('push_log', { level: 'info', message: `probe ok: ${currentMediaPath}` });
    return info;
  } catch (e) {
    setVerdict(v!, String(e), true);
    invoke('push_log', { level: 'error', message: `probe failed: ${e}` });
    return null;
  }
}

function outDirOf(p: string): string {
  return p.replace(/[\\/]+[^\\/]+$/, '');
}

/* ── wiring ─────────────────────────────────────────────────────────── */

function wireLang(): void {
  document.getElementById('lang-toggle')?.addEventListener('click', () => {
    lang = lang === 'ar' ? 'en' : 'ar';
    localStorage.setItem('hl.lang', lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    location.reload(); // simplest reliable full relabel
  });
}

function wireSecretSettings(): void {
  const badge = document.getElementById('version-badge');
  if (!badge) return;
  let taps = 0;
  let firstTapAt = 0;

  badge.addEventListener('click', () => {
    const now = Date.now();
    if (now - firstTapAt > 4000) {
      taps = 0;
      firstTapAt = now;
    }
    taps += 1;
    if (taps === 3 && badge) {
      badge.style.opacity = '0.55';
      setTimeout(() => (badge.style.opacity = ''), 250);
    }
    if (taps >= 6) {
      taps = 0;
      const advContainer = document.getElementById('advanced-panel-container');
      advContainer?.classList.toggle('open');
      invoke('push_log', { level: 'warn', message: 'DEV PANEL toggled (hidden settings)' });
    }
  });

  const cb = document.getElementById('keep-inst') as HTMLInputElement | null;
  if (cb) {
    cb.checked = localStorage.getItem('hl.keep_inst') === '1';
    cb.addEventListener('change', () => {
      localStorage.setItem('hl.keep_inst', cb.checked ? '1' : '0');
      invoke('push_log', { level: 'info', message: `keep_instrumental = ${cb.checked}` });
    });
  }
}

function wireModes(): void {
  const cards = document.querySelectorAll<HTMLElement>('.mode-card');
  const sepLabel = document.getElementById('sep-label');
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      currentMode = (card.dataset.mode as 'song' | 'clip') ?? 'song';
      cards.forEach((c) => c.classList.toggle('selected', c === card));
      if (sepLabel) {
        const key = currentMode === 'song' ? 'btn_sep_song' : 'btn_sep_clip';
        sepLabel.dataset.i18n = key;
        sepLabel.innerHTML = t(key);
      }
      invoke('push_log', { level: 'info', message: `mode → ${currentMode}` });
    });
  });
}

function wireKinds(): void {
  const cards = document.querySelectorAll<HTMLElement>('.kind-card');
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      if (card.classList.contains('dimmed')) return;
      cards.forEach((c) => c.classList.toggle('selected', c === card));
      
      const v = document.getElementById('media-verdict');
      if (v) {
        const word = card.dataset.kind === 'video' ? 'فيديو' : 'صوت';
        v.innerHTML = `نوع الإخراج: <span class="bg-clay-accent/20 text-clay-accent px-1.5 py-0.5 rounded font-bold mr-1 inline-block">${word}</span>`;
      }
      
      invoke('push_log', { level: 'info', message: `kind → ${card.dataset.kind}` });
    });
  });
}

function wireDropzone(): void {
  const dz = document.getElementById('dropzone');
  dz?.addEventListener('click', async () => {
    const picked = await dialog.open({
      multiple: true,
      filters: [
        { name: 'Media', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'] },
      ],
    });
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    await ingestFiles(files);
  });

  const win = getCurrentWebviewWindow();
  void win.onDragDropEvent((ev) => {
    if (ev.payload.type === 'over') dz?.classList.add('dragging');
    else dz?.classList.remove('dragging');
    if (ev.payload.type === 'drop') {
      const paths = ev.payload.paths;
      if (paths.length) void ingestFiles(paths);
    }
  });
}

/** Handle one or many files: single → fill+probe; many → queue for batch. */
async function ingestFiles(files: string[]): Promise<void> {
  if (files.length === 0) return;
  
  if (files.length === 1) {
    stopBatch();
    const info = await runProbe(files[0]);
    if (info) updateQualityOptions(info.has_video ? info.height ?? null : null);
    // Add to batch queue to show history visually
    batchQueue = [files[0]];
    renderBatchList();
    return;
  }
  
  batchQueue = [...files];
  renderBatchList();
  setBatchCounter(0, batchQueue.length);
  const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
  const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'video';
  const word = outKind === 'video' ? 'فيديو' : 'صوت';
  setVerdict(probeEl(), `نوع الإخراج: <span class="bg-clay-accent/20 text-clay-accent px-1.5 py-0.5 rounded font-bold mr-1 inline-block">${word}</span>`, false);
  invoke('push_log', { level: 'info', message: `batch queued: ${batchQueue.length} files` });
}

function updateQualityOptions(srcHeight: number | null): void {
  const wrap = document.getElementById('q-wrap');
  const sel = document.getElementById('quality-select') as HTMLSelectElement | null;
  const videoCard = document.getElementById('kind-video');
  if (!wrap || !sel || !videoCard) return;

  // Video kind only makes sense for real video inputs; dim it otherwise.
  videoCard.classList.toggle('dimmed', srcHeight === null);
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
      o.textContent = idx === 0 ? `نفس الجودة (${h}p)` : `${h}p`;
      return o;
    }),
  );
  sel.value = String(ladder[0] ?? '');
}

/* ── batch engine (F5): sequential, continue-on-fail ────────────────── */
let batchAbort = false;
function stopBatch(): void {
  batchAbort = true;
  batchQueue = [];
  document.getElementById('batch-list')?.classList.add('hidden');
  document.getElementById('batch-counter')?.classList.add('hidden');
}
function setBatchCounter(done: number, total: number): void {
  const el = document.getElementById('batch-counter');
  if (!el) return;
  el.classList.remove('hidden');
  el.textContent = `📦 الدفعة: ${done}/${total}`;
}
function renderBatchList(): void {
  const ul = document.getElementById('batch-list');
  if (!ul) return;
  ul.classList.remove('hidden');
  ul.replaceChildren(
    ...batchQueue.map((f) => {
      const div = document.createElement('div');
      div.dataset.file = f;
      div.className = 'batch-item bg-coal-surface/40 border border-border-muted rounded p-stack-sm flex flex-col gap-unit opacity-60 transition-all duration-300 apple-ease cursor-default relative overflow-hidden';
      
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
      
      const statusSpan = document.createElement('span');
      statusSpan.className = 'status-text font-label-sm text-label-sm text-on-surface-variant relative z-10';
      statusSpan.textContent = 'في الانتظار';
      
      div.append(progBg, headerDiv, progWrap, statusSpan);
      return div;
    }),
  );
}
function markBatchItem(file: string, status: 'ok' | 'fail' | 'run'): void {
  const item = document.querySelector<HTMLElement>(`#batch-list div[data-file="${CSS.escape(file)}"]`);
  if (!item) return;
  
  const statusSpan = item.querySelector('.status-text') as HTMLElement;
  
  if (status === 'run') {
      item.className = 'batch-item running-item bg-coal-surface/80 border border-clay-accent/40 rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden shadow-[0_4px_12px_-4px_rgba(218,119,86,0.2)] transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.remove('hidden');
      item.querySelector('.batch-pct')?.classList.remove('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.remove('hidden');
      if (statusSpan) {
          statusSpan.textContent = 'جاري المعالجة...';
          statusSpan.className = 'status-text font-label-sm text-label-sm text-clay-accent animate-pulse relative z-10';
      }
  } else if (status === 'ok') {
      item.className = 'batch-item bg-tertiary-container/20 border border-tertiary/40 rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.add('hidden');
      item.querySelector('.batch-pct')?.classList.add('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.add('hidden');
      if (statusSpan) {
          statusSpan.textContent = '✓ مكتمل';
          statusSpan.className = 'status-text font-label-sm text-label-sm text-tertiary relative z-10';
      }
  } else if (status === 'fail') {
      item.className = 'batch-item bg-error-container/20 border border-error/40 rounded p-stack-sm flex flex-col gap-unit relative overflow-hidden transition-all duration-300 opacity-100';
      item.querySelector('.batch-prog-bg')?.classList.add('hidden');
      item.querySelector('.batch-pct')?.classList.add('hidden');
      item.querySelector('.batch-prog-wrap')?.classList.add('hidden');
      if (statusSpan) {
          statusSpan.textContent = '✗ فشل';
          statusSpan.className = 'status-text font-label-sm text-label-sm text-error relative z-10';
      }
  }
}

/* ── separation (single + batch) ────────────────────────────────────── */
type SepOpts = { outKind: 'audio' | 'video'; quality?: number; advFmt?: string };

async function runSeparationFor(path: string, keepInst: boolean, o: SepOpts): Promise<SepResult> {
  const res = await invoke<SepResult>('separate_file', {
    path,
    outDir: outDirOf(path),
    mode: currentMode,
    kind: o.outKind,
    quality: o.quality ?? null,
    format: o.advFmt ?? null,
    keepInstrumental: keepInst,
  });
  return res;
}

function wireSeparate(): void {
  const result = sepResultEl();

  void listen<number>('sep-progress', (ev) => {
    const pct = Math.round(ev.payload * 100);
    const activeItem = document.querySelector<HTMLElement>('.batch-item.running-item');
    if (activeItem) {
      const bg = activeItem.querySelector('.batch-prog-bg') as HTMLElement;
      const bar = activeItem.querySelector('.batch-prog-bar') as HTMLElement;
      const text = activeItem.querySelector('.batch-pct') as HTMLElement;
      if (bg) bg.style.inlineSize = `${pct}%`;
      if (bar) bar.style.inlineSize = `${pct}%`;
      if (text) text.textContent = `${pct}%`;
    }
  });

  sepBtnEl()?.addEventListener('click', async () => {
    if (batchRunning) {
      batchAbort = true;
      return;
    }
    const keepInst = (document.getElementById('keep-inst') as HTMLInputElement)?.checked ?? false;
    const advFmt = (document.getElementById('fmt-select') as HTMLSelectElement)?.value;
    const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
    const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'audio';
    const qSel = document.getElementById('quality-select') as HTMLSelectElement | null;
    const quality = outKind === 'video' && qSel?.value ? Number(qSel.value) : undefined;

    // single-file fast path
    if (batchQueue.length <= 1) {
      if (!lastProbeOk || !currentMediaPath) {
        setVerdict(probeEl(), 'أفلت ملفاً أو اختره أولاً — سيُفحص تلقائياً', true);
        return;
      }
      await runOne(currentMediaPath, keepInst, { outKind, quality, advFmt }, result!);
      return;
    }

    // batch path
    batchRunning = true;
    batchAbort = false;
    sepBtnEl().textContent = '⏸ إيقاف';
    const failures: string[] = [];
    const total = batchQueue.length;
    let done = 0;
    for (const f of batchQueue) {
      if (batchAbort) break;
      markBatchItem(f, 'run');
      setBatchCounter(done, total);
      try {
        await runSeparationFor(f, keepInst, { outKind, quality, advFmt });
        markBatchItem(f, 'ok');
      } catch (e) {
        markBatchItem(f, 'fail');
        failures.push(`${f} — ${e}`);
        invoke('push_log', { level: 'error', message: `batch item failed: ${f}: ${e}` });
      }
      done += 1;
      setBatchCounter(done, total);
    }
    batchRunning = false;
    sepBtnEl().disabled = false;
    const key = currentMode === 'song' ? 'btn_sep_song' : 'btn_sep_clip';
    sepBtnEl().innerHTML =
      `<span class="material-symbols-outlined transition-transform duration-300 apple-ease group-hover:rotate-12 group-hover:scale-110" data-icon="content_cut">content_cut</span>
       <span id="sep-label" data-i18n="${key}">${t(key)}</span>`;
    if (result) {
      result.textContent = failures.length
        ? `اكتملت الدفعة: ${total - failures.length}/${total} نجح\nفشل:\n${failures.join('\n')}`
        : `اكتملت الدفعة: ${total}/${total} ✓`;
      result.classList.remove('hidden');
    }
    invoke('push_log', {
      level: failures.length ? 'warn' : 'info',
      message: `batch finished: ${total - failures.length}/${total}`,
    });
  });

}

async function runOne(
  path: string,
  keepInst: boolean,
  o: SepOpts,
  result: HTMLElement,
): Promise<void> {
  const btn = sepBtnEl();
  btn.disabled = true;
  result.classList.add('hidden');
  markBatchItem(path, 'run');
  try {
    const res = await runSeparationFor(path, keepInst, o);
    const lines = [`تم الفصل خلال ${res.seconds.toFixed(1)}s`];
    if (res.vocals) lines.push(`صوت: ${res.vocals}`);
    if (res.instrumental) lines.push(`موسيقى: ${res.instrumental}`);
    if (res.video) lines.push(`فيديو: ${res.video}`);
    result.textContent = lines.join('\n');
    result.classList.remove('hidden');
    markBatchItem(path, 'ok');
  } catch (e) {
    result.textContent = `فشل الفصل: ${e}`;
    result.classList.remove('hidden');
    markBatchItem(path, 'fail');
    invoke('push_log', { level: 'error', message: `separate failed: ${e}` });
  } finally {
    btn.disabled = false;
  }
}

/* ── URL download (M5 UI) ───────────────────────────────────────────── */
function wireUrlDownload(): void {
  const btn = document.getElementById('btn-download') as HTMLButtonElement;
  const input = document.getElementById('url-input') as HTMLInputElement;
  const wrap = document.getElementById('dl-progress-wrap');
  const bar = document.getElementById('dl-progress');
  const res = document.getElementById('dl-result');
  const upd = document.getElementById('btn-upd-ytdlp') as HTMLButtonElement;

  void listen<number>('dl-progress', (ev) => {
    if (bar) bar.style.inlineSize = `${Math.round(ev.payload * 100)}%`;
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
      res.textContent = `تم التنزيل: ${file}`;
      res.classList.remove('hidden');
      await ingestFiles([file]); // auto-fill + probe the downloaded file
    } catch (e) {
      res.textContent = `فشل التنزيل: ${e}`;
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
      const r = await invoke<{ updated: boolean; message: string }>('update_ytdlp');
      if (res) {
        res.textContent = r.message;
        res.classList.remove('hidden');
      }
    } finally {
      upd.disabled = false;
    }
  });
}

/* ── init ───────────────────────────────────────────────────────────── */
function wireOpenFolder(): void {
  const btn = document.getElementById('btn-open-folder');
  btn?.addEventListener('click', async () => {
    try {
      let outDir = currentMediaPath ? outDirOf(currentMediaPath) : '';
      await invoke('open_folder', { path: outDir });
      invoke('push_log', { level: 'info', message: `Opened folder: ${outDir}` });
    } catch (e) {
      invoke('push_log', { level: 'error', message: `Failed to open folder: ${e}` });
    }
  });
}

function wire(): void {
  wireLang();

  window.addEventListener('error', (ev) =>
    invoke('push_log', { level: 'error', message: `JS error: ${ev.message}` }));
  window.addEventListener('unhandledrejection', (ev) =>
    invoke('push_log', { level: 'error', message: `JS unhandled rejection: ${String(ev.reason)}` }));

  // auto-probe on Enter or paste (probe button removed — B1 simplification)
  const autoProbe = async () => {
    const p = pathInputEl().value;
    if (!p.trim()) return;
    const info = await runProbe();
    if (info) updateQualityOptions(info.has_video ? (info.height ?? null) : null);
    else updateQualityOptions(null);
  };
  pathInputEl().addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void autoProbe();
  });
  pathInputEl().addEventListener('change', () => void autoProbe());
  pathInputEl().addEventListener('paste', () => setTimeout(() => void autoProbe(), 60));

  wireModes();
  wireKinds();
  wireDropzone();
  wireSeparate();
  wireUrlDownload();
  wireLogToggle();
  wireOpenFolder();
}

async function init(): Promise<void> {
  applyLang();

  wire();
  wireSecretSettings();
  try {
    const info = await invoke<{ app: string; version: string }>('ping');
    const badge = document.getElementById('version-badge');
    if (badge) badge.title = `HaramLite ${info.version}`;
    if (badge) badge.textContent = `v${info.version}`;
  } catch (e) {
    console.error(e);
  }
  
  // Auto-update yt-dlp in the background
  invoke<{ updated: boolean; message: string }>('update_ytdlp').then((r) => {
    invoke('push_log', { level: 'info', message: r.message });
  }).catch((e) => {
    invoke('push_log', { level: 'error', message: `yt-dlp auto-update failed: ${e}` });
  });

  await refresh();
  setInterval(refresh, 700);
}

void init();
