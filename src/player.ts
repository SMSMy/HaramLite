/* ── سطح التشغيل المباشر (نطاق أغاني v1) ──────────────────────────────────
 * نُقل من src/main.ts كما هو حرفياً: الكتلة كاملة بين تعليقَي القسم —
 *   - واجهة الخريطة: PL_CARD_VISIBLE وapplyPlCardVisibility() (اللافتة مخفية
 *     بقرار D1؛ الإظهار بجعلها true — لم يُلمس القرار ولا قيمته)
 *   - الرسم: plFmt/plStateLabel/plBdiRange/plAppendRanges/plRangeAt/plCurPos
 *     وpaintPills/paintDetail/paintCur/paintTicks
 *   - الصوت: PL_DUCK_GAIN/PL_RAMP_SECS/PL_UI_SYNC_MS والحالة plAudio/plCtx/
 *     plGain/plAudioSrc/plPlaying/plRaf/plLastGain/plLastUiSync وplMappedEnd/
 *     plGainAt/plPlayLabel/plStopLoop/plStopAudio/plSyncSlider/plTick/
 *     plTogglePlay/renderPlayer/wirePlayer
 * لم يتغيّر أي معرّف DOM (‎#pl-container و#pl-*‎) ولا أي أمر (`player_open`،
 * `player_prepare`، `player_status`، `livemap`، `decide`، `push_log`) ولا
 * ثابت واحد (0.251 / 0.015 / 250). الوحيد المضاف: `export` على wirePlayer
 * وplStopAudio (الأخيرة يناديها مسار الإعدادات)، وبيانات الاستيراد.
 */

import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import * as dialog from '@tauri-apps/plugin-dialog';
import { currentLang, t } from './i18n';
import type { MediaInfo } from './types';

/* ── live player surface (v1 songs scope) ─────────────────────────── */
// DECISION 2026-09-06 (D1 — hide, never delete): the field verdict is that
// the file pipeline is fast enough (14.5 min in 91s) and the watch path is
// excellent — the live need dropped. The card is hidden behind this flag;
// backend (livemap/decide/player/session/player_prepare), tests and strings
// stay green untouched. Fully reversible: set PL_CARD_VISIBLE = true.
const PL_CARD_VISIBLE = false;
function applyPlCardVisibility(): void {
  if (!PL_CARD_VISIBLE) {
    document.getElementById('pl-container')?.classList.add('hidden');
  }
}
// Session state + REAL precomputed maps (player_prepare) + audio output
// through the map (mute 0 / duck −12 dB / pass 1, 50ms anti-click ramps).
// The surface plays the user's own file only — no live-extension path,
// no system-WASAPI path (both closed until further notice).
type PlChunkMap = {
  index: number;
  start_sec: number;
  len_sec: number;
  muted_ranges_sec: [number, number][];
  ducked_ranges_sec: [number, number][];
  timing_ms: number;
};
let plSession: number | null = null;
let plDuration = 0;
let plMap: PlChunkMap[] = [];
let plSelected: number | null = null;
let plLastStates: string[] = [];
let plLastChunk: number | null = null;
function plFmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}
function plStateLabel(s: string): string {
  const k = s.toLowerCase();
  if (k === 'ready') return t('pl_ready');
  if (k === 'consumed') return t('pl_consumed');
  return t('pl_pending');
}
/** One time range, bidi-isolated: digits+colon must not reorder inside RTL. */
function plBdiRange(parent: HTMLElement, a: number, b: number): void {
  const el = document.createElement('bdi');
  el.dir = 'ltr';
  el.textContent = `${plFmt(a)}–${plFmt(b)}`;
  parent.appendChild(el);
}
function plAppendRanges(parent: HTMLElement, ranges: [number, number][]): void {
  if (!ranges.length) {
    parent.appendChild(document.createTextNode(t('pl_none')));
    return;
  }
  const sep = currentLang() === 'ar' ? '، ' : ', ';
  ranges.forEach(([a, b], i) => {
    if (i > 0) parent.appendChild(document.createTextNode(sep));
    plBdiRange(parent, a, b);
  });
}
/** Mute/duck range containing pos, mute wins on overlap. */
function plRangeAt(pos: number): { kind: 'mute' | 'duck'; range: [number, number] } | null {
  for (const c of plMap) {
    for (const r of c.muted_ranges_sec) {
      if (pos >= r[0] && pos < r[1]) return { kind: 'mute', range: r };
    }
  }
  for (const c of plMap) {
    for (const r of c.ducked_ranges_sec) {
      if (pos >= r[0] && pos < r[1]) return { kind: 'duck', range: r };
    }
  }
  return null;
}
function plCurPos(): number {
  const seekEl = document.getElementById('pl-seek') as HTMLInputElement | null;
  if (!seekEl || plDuration <= 0) return 0;
  return (Number(seekEl.value) / 100) * plDuration;
}
function paintPills(): void {
  const wrap = document.getElementById('pl-chunks');
  if (!wrap) return;
  wrap.replaceChildren(...plLastStates.map((s, i) => {
    const k = s.toLowerCase();
    const base = 'w-7 h-7 flex items-center justify-center rounded border text-xs font-bold cursor-pointer transition-all apple-ease hover:scale-110 active:scale-95 ';
    const stateCls = k === 'ready'
      ? 'bg-clay-accent/20 text-clay-accent border-clay-accent/40'
      : (k === 'consumed' ? 'opacity-40 text-on-surface-variant border-border-muted' : 'text-on-surface-variant border-border-muted');
    const selCls = i === plSelected ? ' ring-2 ring-[#da7756] scale-110' : '';
    const curCls = i === plLastChunk ? ' underline underline-offset-2' : '';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(i + 1);
    b.title = `${t('pl_chunk')} ${i + 1} — ${plStateLabel(s)}`;
    b.setAttribute('aria-pressed', i === plSelected ? 'true' : 'false');
    b.className = base + stateCls + selCls + curCls;
    b.addEventListener('click', () => {
      plSelected = i;
      paintPills();
      paintDetail();
    });
    return b;
  }));
}
function paintDetail(): void {
  const el = document.getElementById('pl-detail');
  if (!el) return;
  el.replaceChildren();
  if (plSelected === null) {
    el.textContent = plLastStates.length ? t('pl_detail_pick') : '';
    return;
  }
  const idx = plSelected;
  const state = plLastStates[idx] !== undefined ? plStateLabel(plLastStates[idx]) : t('pl_none');
  const m = plMap[idx];
  el.append(
    `${t('pl_detail_title')} ${t('pl_chunk')} ${idx + 1} · ${t('pl_state')}: ${state} · ${t('pl_mute_ranges')}: `,
  );
  plAppendRanges(el, m ? m.muted_ranges_sec : []);
  el.append(` · ${t('pl_duck_ranges')}: `);
  plAppendRanges(el, m ? m.ducked_ranges_sec : []);
  const cost = document.createElement('bdi');
  cost.dir = 'ltr';
  cost.textContent = m ? `${m.timing_ms.toFixed(1)}ms` : t('pl_none');
  el.append(` · ${t('pl_cost')}: `, cost);
}
function paintCur(pos: number): void {
  const el = document.getElementById('pl-cur');
  if (!el) return;
  if (plDuration <= 0 || plLastChunk === null) {
    el.textContent = plDuration > 0 ? plFmt(pos) : '';
    return;
  }
  const hit = plRangeAt(pos);
  const label = hit === null
    ? t('pl_in_pass')
    : (hit.kind === 'mute'
      ? `${t('pl_in_mute')} ${plFmt(hit.range[0])}–${plFmt(hit.range[1])}`
      : `${t('pl_in_duck')} ${plFmt(hit.range[0])}–${plFmt(hit.range[1])}`);
  el.textContent = `${t('pl_chunk')} ${plLastChunk + 1} · ${plFmt(pos)} · ${label}`;
}
function paintTicks(): void {
  const box = document.getElementById('pl-ticks');
  if (!box) return;
  box.replaceChildren();
  if (plDuration <= 0 || !plMap.length) return;
  const total = plDuration;
  const add = (a: number, b: number, color: string, title: string): void => {
    if (!(b > a) || a >= total || b <= 0) return;
    const left = Math.max(0, (a / total) * 100);
    const width = Math.max(0.6, ((Math.min(b, total) - Math.max(a, 0)) / total) * 100);
    const d = document.createElement('div');
    d.className = 'absolute top-0 h-full rounded';
    d.style.left = `${left}%`;
    d.style.width = `${width}%`;
    d.style.background = color;
    d.title = title;
    box.appendChild(d);
  };
  for (const c of plMap) {
    for (const [a, b] of c.ducked_ranges_sec) add(a, b, 'rgba(255,193,7,0.55)', t('pl_in_duck'));
  }
  for (const c of plMap) {
    for (const [a, b] of c.muted_ranges_sec) add(a, b, 'rgba(224,49,49,0.8)', t('pl_in_mute'));
  }
}

/* ── live audio output (v1 songs scope, end-to-end slice) ─────────────── */
// The user's own file plays through the precomputed map: mute → 0,
// duck → −12 dB (≈0.251), pass → 1, with fast ramps (no clicks).
// Positions past the mapped end freeze silent — never raw unfiltered audio.
const PL_DUCK_GAIN = 0.251;
const PL_RAMP_SECS = 0.015;
const PL_UI_SYNC_MS = 250;
let plAudio: HTMLAudioElement | null = null;
let plCtx: AudioContext | null = null;
let plGain: GainNode | null = null;
let plAudioSrc = '';
let plPlaying = false;
let plRaf = 0;
let plLastGain = -1;
let plLastUiSync = 0;
function plMappedEnd(): number {
  const last = plMap[plMap.length - 1];
  return last ? last.start_sec + last.len_sec : 0;
}
/** Output gain at pos. Mute wins on overlap; past the map → 0 (freeze). */
function plGainAt(pos: number): number {
  if (plMappedEnd() <= 0 || pos < 0 || pos >= plMappedEnd()) return 0;
  const hit = plRangeAt(pos);
  if (hit === null) return 1;
  return hit.kind === 'mute' ? 0 : PL_DUCK_GAIN;
}
function plPlayLabel(): void {
  const btn = document.getElementById('pl-play') as HTMLButtonElement | null;
  if (btn) btn.textContent = plPlaying ? t('pl_pause') : t('pl_play');
}
function plStopLoop(): void {
  if (plRaf) cancelAnimationFrame(plRaf);
  plRaf = 0;
}
export function plStopAudio(): void {
  plStopLoop();
  try {
    plAudio?.pause();
  } catch { /* already stopped */ }
  if (plPlaying) {
    plPlaying = false;
    plPlayLabel();
  }
  plLastGain = -1;
}
function plSyncSlider(pos: number): void {
  const seekEl = document.getElementById('pl-seek') as HTMLInputElement | null;
  if (seekEl && plDuration > 0 && document.activeElement !== seekEl) {
    seekEl.value = String((pos / plDuration) * 100);
  }
  const sel = document.getElementById('pl-pos');
  if (sel) sel.textContent = plFmt(pos);
  paintCur(pos);
}
function plTick(): void {
  plRaf = 0;
  if (!plPlaying || !plAudio || !plCtx || !plGain) return;
  const pos = plAudio.currentTime;
  const g = plGainAt(pos);
  if (g !== plLastGain) {
    plLastGain = g;
    plGain.gain.setTargetAtTime(g, plCtx.currentTime, PL_RAMP_SECS);
  }
  plSyncSlider(pos);
  const now = performance.now();
  if (now - plLastUiSync >= PL_UI_SYNC_MS) {
    plLastUiSync = now;
    void renderPlayer(pos);
    if (plSession !== null) {
      invoke<unknown>('player_advance', { id: plSession, pos }).catch(() => {});
    }
  }
  if (pos >= plMappedEnd()) {
    // Map exhausted → freeze silent at the edge, never raw audio.
    plStopAudio();
    void renderPlayer(Math.min(pos, plMappedEnd()));
    return;
  }
  plRaf = requestAnimationFrame(plTick);
}
async function plTogglePlay(plPath: string): Promise<void> {
  const mapEl = document.getElementById('pl-map');
  if (plPlaying) {
    plStopAudio();
    if (plAudio) void renderPlayer(plAudio.currentTime);
    return;
  }
  if (!plPath || plSession === null || plMap.length === 0 || plDuration <= 0) {
    if (mapEl) {
      mapEl.textContent = t('pl_nomap');
      mapEl.classList.remove('hidden');
    }
    return;
  }
  try {
    if (!plAudio) {
      plAudio = new Audio();
      plAudio.preload = 'auto';
      plAudio.addEventListener('ended', () => {
        plStopAudio();
        plSyncSlider(plMappedEnd());
        void renderPlayer(plMappedEnd());
      });
      plAudio.addEventListener('error', () => {
        plStopAudio();
        if (mapEl) {
          mapEl.textContent = `✗ ${t('pl_audio_err')}`;
          mapEl.classList.remove('hidden');
        }
        invoke('push_log', { level: 'error', message: 'player audio element error' });
      });
    }
    if (!plCtx || !plGain) {
      plCtx = new AudioContext();
      const src = plCtx.createMediaElementSource(plAudio);
      plGain = plCtx.createGain();
      plGain.gain.value = 0;
      src.connect(plGain).connect(plCtx.destination);
    }
    if (plCtx.state === 'suspended') await plCtx.resume();
    const wantSrc = convertFileSrc(plPath);
    if (plAudioSrc !== wantSrc) {
      plAudioSrc = wantSrc;
      plAudio.src = wantSrc;
    }
    const start = Math.min(Math.max(plCurPos(), 0), Math.max(plMappedEnd() - 0.05, 0));
    plAudio.currentTime = start;
    plLastGain = -1;
    plLastUiSync = 0;
    await plAudio.play();
    plPlaying = true;
    plPlayLabel();
    plRaf = requestAnimationFrame(plTick);
    invoke('push_log', { level: 'info', message: `player play from ${start.toFixed(1)}s` });
  } catch (e) {
    plStopAudio();
    if (mapEl) {
      mapEl.textContent = `✗ ${t('pl_audio_err')}`;
      mapEl.classList.remove('hidden');
    }
    invoke('push_log', { level: 'error', message: `player play failed: ${e}` });
  }
}
async function renderPlayer(pos: number): Promise<void> {
  if (plSession === null || plDuration <= 0) return;
  try {
    const st = await invoke<{
      chunks: number; chunk: number | null; states: string[];
      can_start: boolean; frozen: boolean; next_needed: number | null;
    }>('player_status', { id: plSession, pos });
    plLastStates = st.states;
    plLastChunk = st.chunk;
    if (plSelected !== null && plSelected >= plLastStates.length) plSelected = null;
    paintPills();
    paintDetail();
    paintCur(pos);
    const sel = document.getElementById('pl-pos');
    if (sel) sel.textContent = plFmt(pos);
    const line = document.getElementById('pl-status');
    if (line) {
      line.textContent = st.frozen
        ? `⏸ ${t('pl_frozen')}`
        : `${st.chunks} ${t('pl_chunks')} · ${t('pl_ready')}: ${st.states.filter((s) => s.toLowerCase() === 'ready').length} · ${t('pl_ready_inspect')}`;
    }
  } catch (e) {
    invoke('push_log', { level: 'error', message: `player status failed: ${e}` });
  }
}
export function wirePlayer(): void {
  applyPlCardVisibility(); // D1: card hidden behind PL_CARD_VISIBLE, wiring intact
  let plPath = '';
  const fileBtn = document.getElementById('pl-file-btn');
  const prepBtn = document.getElementById('pl-prepare') as HTMLButtonElement | null;
  const playBtn = document.getElementById('pl-play') as HTMLButtonElement | null;
  const nameEl = document.getElementById('pl-file-name');
  const mapEl = document.getElementById('pl-map');
  const seekEl = document.getElementById('pl-seek') as HTMLInputElement | null;

  fileBtn?.addEventListener('click', async () => {
    const picked = await dialog.open({
      multiple: false,
      filters: [
        { name: 'Media', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'] },
      ],
    });
    if (!picked || Array.isArray(picked)) return;
    try {
      const info = await invoke<MediaInfo>('probe_media', { path: picked });
      if (!info.has_audio) return;
      plStopAudio();
      if (plSession !== null) await invoke('player_close', { id: plSession }).catch(() => {});
      plSession = await invoke<number>('player_open', { totalSecs: info.duration_secs, chunkSecs: 60 });
      plPath = picked;
      plDuration = info.duration_secs;
      plMap = [];
      plSelected = null;
      plLastStates = [];
      plLastChunk = null;
      if (playBtn) playBtn.disabled = true;
      plPlayLabel();
      if (nameEl) nameEl.textContent = picked.split(/[\\/]/).pop() ?? picked;
      if (mapEl) mapEl.classList.add('hidden');
      if (seekEl) { seekEl.value = '0'; }
      paintTicks();
      paintDetail();
      paintCur(0);
      await renderPlayer(0);
      invoke('push_log', { level: 'info', message: `player session ${plSession} opened (${plDuration.toFixed(0)}s)` });
    } catch (e) {
      invoke('push_log', { level: 'error', message: `player open failed: ${e}` });
    }
  });

  prepBtn?.addEventListener('click', async () => {
    if (!plPath || plSession === null || !prepBtn || !mapEl) {
      if (mapEl) {
        mapEl.textContent = t('pl_nomap');
        mapEl.classList.remove('hidden');
      }
      return;
    }
    plStopAudio();
    prepBtn.disabled = true;
    mapEl.textContent = t('pl_preparing');
    mapEl.classList.remove('hidden');
    try {
      const rep = await invoke<{
        total_secs: number; chunks: PlChunkMap[];
        muted_fraction: number; ducked_fraction: number; minute_cost_ms: number;
        marked_ready: number;
      }>('player_prepare', { id: plSession, path: plPath, chunkSecs: 60 });
      plMap = rep.chunks;
      if (rep.total_secs > 0) plDuration = rep.total_secs;
      plSelected = null;
      paintTicks();
      if (playBtn) playBtn.disabled = false;
      const muted = rep.chunks.reduce((n, c) => n + c.muted_ranges_sec.length, 0);
      mapEl.textContent =
        `${rep.chunks.length} ${t('pl_chunks')} · ${muted} ${t('pl_muted')} · ${(rep.minute_cost_ms).toFixed(1)}ms/min`;
      mapEl.classList.remove('hidden');
      // Backend marked every chunk Ready — re-read status so the line stops
      // showing the stale freeze and reports readiness truthfully.
      await renderPlayer(plCurPos());
      invoke('push_log', { level: 'info', message: `player map ready: ${muted} muted ranges, ${rep.marked_ready} ready` });
    } catch (e) {
      mapEl.textContent = `✗ ${e}`;
      mapEl.classList.remove('hidden');
    } finally {
      prepBtn.disabled = false;
    }
  });

  seekEl?.addEventListener('input', () => {
    if (plDuration <= 0) return;
    const pos = (Number(seekEl.value) / 100) * plDuration;
    if (plPlaying && plAudio) {
      plAudio.currentTime = Math.min(pos, Math.max(plMappedEnd() - 0.05, 0));
      plLastGain = -1;
    }
    void renderPlayer(pos);
    if (plSession !== null) {
      invoke<unknown>('player_seek', { id: plSession, pos }).catch(console.error);
    }
  });

  playBtn?.addEventListener('click', () => void plTogglePlay(plPath));
}
