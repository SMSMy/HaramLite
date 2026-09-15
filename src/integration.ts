/* ── التكامل الخارجي: الوظائف الخارجية، تيليجرام، المتصفح، التشغيل مع ويندوز ─
 * نُقل من src/main.ts كما هو حرفياً، وهو وحدة واحدة لأن هذه الأسطح تشترك في
 * نفس الواجهة ونفس الأحداث:
 *   - تغذية الوظائف الخارجية: ExtKind/extJobs/extSig وrenderExtJobs()
 *     وwireExtJobs() (أحداث bridge-* وwatch-*)
 *   - تيليجرام: wireTelegram() (بما فيها حذف النسختين القديمتين من
 *     localStorage وإدارة رمز الاقتران)
 *   - المتصفح: wireBridge() وBridgeExt/renderBridgeExt()/refreshBridgeExt()
 *   - التشغيل مع ويندوز: refreshAutostart/applyAutostart/wireAutostart/
 *     askAutostartOnce وautostartTrap (ومُحرِّره)
 * لم يتغيّر أي معرّف DOM (#ext-*، #tg-*، #bridge-*، #setting-autostart،
 * #autostart-overlay/-yes/-no) ولا أي أمر (`get_settings`، `set_settings`،
 * `autostart_status`، `set_autostart`، `bridge_status`، `tg_*`، `push_log`)
 * ولا مفتاح localStorage (hl.tg*، hl.bridge، hl.watch_*)، ولا حُذف أي سطر من
 * كود حذف الأسرار القديمة. الوحيد المضاف: `export` على ما تناديه main.ts.
 */

import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { currentLang, t } from './i18n';
import { pushSettings, setAutostartAsked, setTelegramApiHash, setTelegramToken } from './settings';
import { playDing, showToast, trapFocus } from './util';
import * as session from './session';
import type { RustSettings } from './settings';

/* ── unified external-jobs feed (functional gap: invisible externals) ─── */
type ExtKind = 'bridge' | 'watch';
interface ExtRow { kind: ExtKind; name: string; detail: string; pct: number | null }
const extJobs = new Map<string, ExtRow>();
let extSig = '';
export function renderExtJobs(): void {
  const list = document.getElementById('ext-list');
  if (!list) return;
  const sig = [...extJobs.values()]
    .map((j) => `${j.kind}|${j.name}|${j.detail}|${j.pct === null ? '-' : Math.round(j.pct * 100)}`)
    .join('~');
  if (sig === extSig) return; // progress ticks at high frequency — skip no-ops
  extSig = sig;
  list.replaceChildren();
  if (!extJobs.size) {
    const s = document.createElement('span');
    s.id = 'ext-empty';
    s.className = 'font-label-sm text-label-sm text-on-surface-variant opacity-80';
    s.textContent = t('ext_empty');
    list.appendChild(s);
    return;
  }
  for (const job of extJobs.values()) {
    const row = document.createElement('div');
    row.className = 'bg-coal-surface/40 border border-border-muted rounded p-stack-sm flex flex-col gap-unit';
    const top = document.createElement('div');
    top.className = 'flex justify-between items-center gap-unit';
    const name = document.createElement('span');
    name.className = 'font-label-sm text-label-sm text-cream-text truncate flex-1';
    name.dir = 'ltr';
    name.textContent = `${job.kind === 'bridge' ? '🌐' : '📁'} ${job.name}`;
    const cancel = document.createElement('button');
    cancel.className = 'text-error hover:text-red-400 p-1 flex-shrink-0 font-label-sm text-label-sm';
    cancel.title = t('ext_cancel');
    cancel.textContent = '⏹';
    cancel.addEventListener('click', () => {
      invoke(job.kind === 'bridge' ? 'cancel_bridge_job' : 'cancel_watch_file')
        .catch((e) => console.error('ext cancel failed', e));
    });
    top.append(name, cancel);
    row.appendChild(top);
    if (job.pct !== null) {
      const wrap = document.createElement('div');
      wrap.className = 'h-1.5 bg-border-muted rounded-full overflow-hidden';
      const bar = document.createElement('div');
      bar.className = 'h-full bg-clay-accent rounded-full';
      bar.style.inlineSize = `${Math.round(job.pct * 100)}%`;
      wrap.appendChild(bar);
      row.appendChild(wrap);
    }
    const detail = document.createElement('span');
    detail.className = 'font-label-sm text-label-sm text-on-surface-variant';
    detail.textContent = job.detail;
    row.appendChild(detail);
    list.appendChild(row);
  }
}
export function wireExtJobs(): void {
  void listen<{ name: string; queue?: number }>('bridge-start', (ev) => {
    extJobs.set(`bridge:${ev.payload.name}`, {
      kind: 'bridge', name: ev.payload.name,
      detail: `${t('ext_bridge_detail')}${ev.payload.queue ? t('ext_bridge_queued', { n: ev.payload.queue }) : ''}`,
      pct: null,
    });
    renderExtJobs();
  });
  void listen<{ name: string }>('bridge-done', () => {
    for (const key of [...extJobs.keys()]) {
      if (key.startsWith('bridge:')) extJobs.delete(key);
    }
    renderExtJobs();
  });
  // Global progress bars also move during bridge jobs — mirror them unless a
  // GUI job owns the bar right now (avoids cross-talk on overlap).
  void listen<number>('dl-progress', (ev) => {
    if (session.getSingleRunning() || session.getBatchRunning()) return;
    for (const job of extJobs.values()) {
      if (job.kind === 'bridge' && job.pct === null) job.pct = ev.payload * 0.2;
    }
    renderExtJobs();
  });
  void listen<number>('sep-progress', (ev) => {
    if (session.getSingleRunning() || session.getBatchRunning()) return;
    for (const job of extJobs.values()) {
      if (job.kind === 'bridge') job.pct = 0.2 + ev.payload * 0.8;
    }
    renderExtJobs();
  });
  void listen<{ path: string }>('watch-start', (ev) => {
    extJobs.set(`watch:${ev.payload.path}`, {
      kind: 'watch', name: ev.payload.path, detail: t('ext_watch_detail'), pct: 0,
    });
    renderExtJobs();
  });
  void listen<{ path: string; pct: number }>('watch-progress', (ev) => {
    const job = extJobs.get(`watch:${ev.payload.path}`);
    if (job) {
      job.pct = ev.payload.pct;
      job.detail = t('ext_watch_detail');
      renderExtJobs();
    }
  });
  void listen<{ path: string }>('watch-done', (ev) => {
    extJobs.delete(`watch:${ev.payload.path}`);
    renderExtJobs();
  });
  renderExtJobs();
}

/* ── browser integration (Sprint E3: persistent checkbox) ───────────── */
/* ── Telegram bot (Sprint T1) ───────────────────────────────────────── */
interface TgStatus {
  running: boolean;
  last_error: string;
  last_activity: string;
  processed: number;
  queue: number;
  paired_id: number | null;
  pairing_code_active: boolean;
}
interface TgPairCode {
  code: string;
  expires_in_secs: number;
  fails_left: number;
  paired: boolean;
}

export function wireTelegram(): void {
  const overlay = document.getElementById('tg-overlay');
  const openBtn = document.getElementById('btn-telegram');
  const badge = document.getElementById('tg-badge');
  // The panel is its own window: the settings dropdown is too narrow, and the
  // token field used to sit inside the block its own toggle kept hidden — a
  // dead end the owner hit on the first try (2026-09-11).
  if (!overlay || !openBtn) return;
  const enable = document.getElementById('setting-telegram') as HTMLInputElement | null;
  const token = document.getElementById('tg-token') as HTMLInputElement | null;
  const owner = document.getElementById('tg-owner') as HTMLInputElement | null;
  const audioOnly = document.getElementById('tg-audio-only') as HTMLInputElement | null;
  const localUrl = document.getElementById('tg-local-url') as HTMLInputElement | null;
  const apiId = document.getElementById('tg-api-id') as HTMLInputElement | null;
  const apiHash = document.getElementById('tg-api-hash') as HTMLInputElement | null;
  const codeEl = document.getElementById('tg-pair-code');
  const statusEl = document.getElementById('tg-status');
  const btnNew = document.getElementById('tg-pair-new');
  const btnCopy = document.getElementById('tg-pair-copy');

  // Seed the non-secret fields from the cache; the settings echo keeps them
  // reconciled after.
  if (owner) owner.value = localStorage.getItem('hl.tg_owner') || '';
  if (localUrl) localUrl.value = localStorage.getItem('hl.tg_local') || '';
  if (apiId) apiId.value = localStorage.getItem('hl.tg_api_id') || '';
  if (audioOnly) audioOnly.checked = localStorage.getItem('hl.tg_audio') === '1';
  if (enable) enable.checked = localStorage.getItem('hl.tg') === '1';

  // The two secrets come from the backend ONCE, into memory and the field —
  // and any copy an older build left in localStorage is deleted here.
  try {
    localStorage.removeItem('hl.tg_token');
    localStorage.removeItem('hl.tg_api_hash');
  } catch { /* storage blocked */ }
  void (async () => {
    try {
      const s = await invoke<RustSettings>('get_settings');
      if (typeof s.telegram_token === 'string' && token && !token.value) {
        token.value = s.telegram_token;
        setTelegramToken(s.telegram_token);
      }
      if (typeof s.telegram_api_hash === 'string' && apiHash && !apiHash.value) {
        apiHash.value = s.telegram_api_hash;
        setTelegramApiHash(s.telegram_api_hash);
      }
    } catch { /* dev/portable builds — backend unavailable */ }
  })();

  const bindText = (key: string, el: HTMLInputElement | null): void => {
    el?.addEventListener('input', () => {
      localStorage.setItem(key, el.value.trim());
      pushSettings();
    });
  };
  // Secrets: memory only, and the value is what the backend stores.
  token?.addEventListener('input', () => {
    setTelegramToken(token.value.trim());
    pushSettings();
  });
  apiHash?.addEventListener('input', () => {
    setTelegramApiHash(apiHash.value.trim());
    pushSettings();
  });
  bindText('hl.tg_owner', owner);
  bindText('hl.tg_local', localUrl);
  bindText('hl.tg_api_id', apiId);

  audioOnly?.addEventListener('change', () => {
    localStorage.setItem('hl.tg_audio', audioOnly.checked ? '1' : '0');
    pushSettings();
  });

  let lastCode = '';
  async function refresh(withCode: boolean): Promise<void> {
    try {
      const st = await invoke<TgStatus>('telegram_status');
      if (statusEl) {
        const bits: string[] = [st.running ? t('tg_on') : t('tg_off')];
        bits.push(st.paired_id ? `${t('tg_paired')}: ${st.paired_id}` : t('tg_pairing'));
        if (st.queue) bits.push(`⏳ ${st.queue}`);
        if (st.last_error) bits.push(`⚠ ${String(st.last_error).slice(0, 70)}`);
        statusEl.textContent = bits.join(' · ');
        statusEl.className = st.last_error
          ? 'font-label-sm text-label-sm text-error'
          : 'font-label-sm text-label-sm text-on-surface-variant';
      }
      if (badge) {
        badge.textContent = st.running ? t('tg_on') : t('tg_off');
        badge.className = st.running
          ? 'ms-auto font-label-sm text-label-sm text-tertiary'
          : 'ms-auto font-label-sm text-label-sm text-on-surface-variant';
      }
      if (!codeEl || !withCode) return;
      // Paired: the pairing instructions and the code row are noise — the
      // owner's own request (2026-09-11). The status line already says who.
      const pairRow = document.getElementById('tg-pair-row');
      const pairHint = document.getElementById('tg-pair-hint');
      pairRow?.classList.toggle('hidden', !!st.paired_id);
      pairHint?.classList.toggle('hidden', !!st.paired_id);
      if (st.paired_id) {
        codeEl.textContent = '✓';
        lastCode = '';
        return;
      }
      const pc = await invoke<TgPairCode>('telegram_pairing_code', { force: false });
      lastCode = pc.code;
      codeEl.textContent = pc.code;
    } catch { /* dev/portable builds — backend unavailable */ }
  }

  // Never a dead end: the token field is visible in this same panel, so say
  // what is missing and put the cursor in it rather than refusing the toggle
  // (the old inline layout hid the field behind the very switch it gated).
  enable?.addEventListener('change', () => {
    localStorage.setItem('hl.tg', enable.checked ? '1' : '0');
    if (enable.checked && !(token?.value || '').trim()) {
      if (statusEl) {
        statusEl.textContent = `⚠ ${t('tg_need_token')}`;
        statusEl.className = 'font-label-sm text-label-sm text-tertiary leading-relaxed';
      }
      token?.focus();
    }
    pushSettings();
    void refresh(true);
  });

  const isOpen = (): boolean => !overlay.classList.contains('hidden');
  let release: (() => void) | null = null;
  const closePanel = (): void => {
    overlay.classList.add('hidden');
    release?.();
    release = null;
  };
  openBtn.addEventListener('click', () => {
    // The settings dropdown is a narrow strip — get it out of the way.
    document.getElementById('settings-menu')?.classList.add('hidden');
    overlay.classList.remove('hidden');
    if (release === null) release = trapFocus(overlay);
    void refresh(true);
  });
  document.getElementById('tg-close')?.addEventListener('click', closePanel);
  document.getElementById('tg-ok')?.addEventListener('click', closePanel);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closePanel();
  });

  btnNew?.addEventListener('click', () => {
    void (async () => {
      try {
        const pc = await invoke<TgPairCode>('telegram_pairing_code', { force: true });
        lastCode = pc.code;
        if (codeEl) codeEl.textContent = pc.code;
      } catch { /* dev */ }
    })();
  });

  btnCopy?.addEventListener('click', () => {
    if (!lastCode) return;
    void navigator.clipboard?.writeText(lastCode).then(
      () => showToast(`✓ ${t('tg_code_copied')}`),
      () => { /* clipboard blocked — the code is on screen anyway */ },
    );
  });

  // The worker emits on exit/restart; the poll is the safety net for a pairing
  // completed in Telegram (Rust writes settings.json behind our back). It only
  // runs while the panel is actually open.
  void listen('telegram-status', () => { void refresh(true); });
  window.setInterval(() => {
    if (document.hidden || !isOpen()) return;
    void refresh(true);
  }, 5000);
  void refresh(false);
}

export function wireBridge(): void {
  let bridgeCardTimer: number | undefined; // F-5: one pending hide at a time
  const cb = document.getElementById('setting-bridge') as HTMLInputElement | null;

  async function applyBridge(on: boolean): Promise<void> {
    try {
      if (on) {
        // Same backend enable path as before — both browser groups.
        const r1 = await invoke<string>('register_native_host', { browser: 'chrome' });
        const r2 = await invoke<string>('register_native_host', { browser: 'firefox' });
        showToast(`${r1}\n${r2}`);
        invoke('push_log', { level: 'info', message: `${r1} / ${r2}` });
      } else {
        const r = await invoke<string>('unregister_native_host');
        showToast(r);
        invoke('push_log', { level: 'info', message: r });
      }
      localStorage.setItem('hl.bridge', on ? '1' : '0');
      if (cb) cb.checked = on;
      pushSettings();
    } catch (e) {
      // Revert the checkbox to backend truth — never display a lie.
      try {
        const st = await invoke<{ enabled: boolean }>('bridge_status');
        if (cb) cb.checked = st.enabled;
      } catch { /* dev builds — leave as-is */ }
      showToast(`✗ ${String(e).slice(0, 120)}`);
      invoke('push_log', { level: 'error', message: `bridge toggle failed: ${e}` });
    }
  }

  cb?.addEventListener('change', () => void applyBridge(!!cb.checked));

  // Init: backend ground truth wins over any stale cache — status known at
  // a glance and reconciled into settings so it survives restarts truthfully.
  void (async () => {
    try {
      const st = await invoke<{ enabled: boolean }>('bridge_status');
      if (cb) cb.checked = st.enabled;
      if ((localStorage.getItem('hl.bridge') === '1') !== st.enabled) {
        localStorage.setItem('hl.bridge', st.enabled ? '1' : '0');
        pushSettings();
        invoke('push_log', { level: 'info', message: `bridge checkbox reconciled to ${st.enabled}` });
      }
    } catch { /* dev/portable builds — leave unchecked */ }
  })();
  void listen<{ name: string; ok: boolean; seconds?: number; error?: string }>('bridge-done', (ev) => {
    const p = ev.payload;
    showToast(p.ok
      ? `✓ ${p.name} (${p.seconds?.toFixed(1)}s)`
      : `✗ ${p.name}: ${String(p.error ?? '').slice(0, 80)}`);
    // completion sound for browser-initiated jobs (notification setting)
    if (localStorage.getItem('hl.notify') === '1') playDing();
    // completion card with a quick "open results folder" action
    const card = document.getElementById('bridge-card');
    const cardText = document.getElementById('bridge-card-text');
    if (card && cardText) {
      cardText.textContent = p.ok
        ? `${p.name} — ${t('bridge_done_in', { secs: p.seconds?.toFixed(1) ?? '0' })}`
        : `${p.name} — ${String(p.error ?? '').slice(0, 120)}`;
      cardText.className = p.ok
        ? 'font-body-sm text-sm text-cream-text'
        : 'font-body-sm text-sm text-error';
      const openBtn = document.getElementById('bridge-card-open');
      if (openBtn) openBtn.style.display = p.ok ? '' : 'none';
      card.classList.remove('hidden');
      // F-5: two jobs finishing back to back must not let the FIRST
      // job's 8s timer hide the SECOND job's card early.
      if (bridgeCardTimer) window.clearTimeout(bridgeCardTimer);
      bridgeCardTimer = window.setTimeout(() => card.classList.add('hidden'), 8000);
    }
  });
  const bridgeCard = document.getElementById('bridge-card');
  document.getElementById('bridge-card-close')?.addEventListener('click', () => bridgeCard?.classList.add('hidden'));
  document.getElementById('bridge-card-open')?.addEventListener('click', () => {
    invoke('open_folder', { path: '' }).catch(console.error);
  });
}

/* ── هل إضافة المتصفح موجودة؟ ─────────────────────────────────────────────
   تطبيق مكتبي لا يستطيع تعداد إضافات المتصفح، لكن مضيف Native Messaging
   يسجّل أصل كل إضافة تتصل به (كروم وفايرفوكس يمرّران الأصل كوسيط أول).
   سجلّ حديث ⇒ الإضافة موجودة؛ لا سجلّ أو سجلّ قديم ⇒ «لا نعرف»، فنعرض رابط
   صفحة الإضافة بدل أن نترك المستخدم يخمّن. لا يُستنتج الغياب من سجلّ قديم
   أبداً: إضافة أُزيلت تترك آخر اتصالها خلفها. */
type BridgeExt = { extension_seen: boolean; extension_days_ago: number | null };

function renderBridgeExt(info: BridgeExt | null): void {
  const status = document.getElementById('bridge-ext-status');
  const link = document.getElementById('bridge-ext-link');
  if (status) {
    if (!info) {
      status.textContent = '';
    } else if (info.extension_seen) {
      const d = info.extension_days_ago ?? 0;
      status.textContent = currentLang() === 'ar'
        ? (d <= 0 ? '✓ الإضافة متصلة الآن' : `✓ الإضافة متصلة — آخر اتصال قبل ${d} يوم`)
        : (d <= 0 ? '✓ Extension connected now' : `✓ Extension connected — last call ${d} day(s) ago`);
      status.className = 'font-label-sm text-label-sm text-tertiary leading-relaxed px-unit';
    } else {
      status.textContent = currentLang() === 'ar'
        ? 'لم يتصل أي متصفح بعد. إن لم تكن الإضافة مثبَّتة فثبّتها من هنا:'
        : 'No browser has called yet. If the extension is not installed, get it here:';
      status.className = 'font-label-sm text-label-sm text-on-surface-variant leading-relaxed px-unit';
    }
  }
  if (link) {
    const show = !info || !info.extension_seen;
    link.classList.toggle('hidden', !show);
    link.classList.toggle('flex', show);
  }
}

export async function refreshBridgeExt(): Promise<void> {
  try {
    const r = await invoke<BridgeExt>('bridge_status');
    renderBridgeExt(r);
  } catch {
    renderBridgeExt(null);
  }
}

/* ── التشغيل مع بدء تشغيل ويندوز ───────────────────────────────────────────
   المصدر الوحيد للحقيقة هو الريجستري (لا حقل مقابل في الإعدادات)، فنقرأ
   الحالة منه بعد كل تغيير بدل أن نفترض أن الكتابة نجحت. والغرض من الخيار
   بقاء الخلفية — البوت وتكامل المتصفح — لا فتح نافذة عند الإقلاع. */
export async function refreshAutostart(): Promise<void> {
  const cb = document.getElementById('setting-autostart') as HTMLInputElement | null;
  if (!cb) return;
  try {
    const r = await invoke<{ enabled: boolean }>('autostart_status');
    cb.checked = !!r.enabled;
  } catch {
    cb.checked = false;
  }
}

async function applyAutostart(on: boolean): Promise<void> {
  const cb = document.getElementById('setting-autostart') as HTMLInputElement | null;
  try {
    const r = await invoke<{ enabled: boolean }>('set_autostart', { on });
    if (cb) cb.checked = !!r.enabled; // نعكس الريجستري لا ما طلبناه
    // 1.10: an explicit user decision fulfills "ask once" — keep the mirror
    // in sync so a later unrelated push cannot resurrect the question.
    setAutostartAsked(true);
  } catch (e) {
    showToast(`${t('autostart_failed')} ${String(e)}`);
    await refreshAutostart();
  }
}

/** Release handle for the autostart dialog's focus trap; the dialog can be opened
 *  from wireAutostart's own buttons or by askAutostartOnce at startup. */
let autostartTrap: (() => void) | null = null;
export function releaseAutostartTrap(): void {
  autostartTrap?.();
  autostartTrap = null;
}

export function wireAutostart(): void {
  const cb = document.getElementById('setting-autostart') as HTMLInputElement | null;
  cb?.addEventListener('change', () => { void applyAutostart(!!cb.checked); });

  const overlay = document.getElementById('autostart-overlay');
  const closeAsk = async (enable: boolean | null): Promise<void> => {
    overlay?.classList.add('hidden');
    releaseAutostartTrap();
    if (enable !== null) await applyAutostart(enable);
    try {
      // set_settings reads `value` (lib.rs), not `patch` — and Settings is
      // #[serde(default)], so a partial object would reset every other field:
      // read-modify-write the full object instead (same pattern as pushSettings).
      const cur: any = await invoke('get_settings');
      await invoke('set_settings', { value: { ...cur, autostart_asked: true } });
      setAutostartAsked(true); // 1.10: the backend now holds true — mirror it.
    } catch { /* ignore */ }
  };
  document.getElementById('autostart-yes')?.addEventListener('click', () => { void closeAsk(true); });
  document.getElementById('autostart-no')?.addEventListener('click', () => { void closeAsk(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) void closeAsk(null);
  });
}

/** يُسأل مرة واحدة فقط: إن لم يُسأل بعد ولم يكن الخيار مفعّلاً. */
export function askAutostartOnce(asked: boolean, alreadyOn: boolean): void {
  const overlay = document.getElementById('autostart-overlay');
  if (!overlay || asked || alreadyOn) return;
  overlay.classList.remove('hidden');
  if (autostartTrap === null) autostartTrap = trapFocus(overlay);
}
