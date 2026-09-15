/* ── اختيار الملف: الحكم، الفحص، وأدوات عناصره ───────────────────────────
 * نُقل من src/main.ts كما هو حرفياً:
 *   - setVerdict()/setVerdictHtml() وverdictHtml() — سطر الحكم أسفل الملف
 *   - probeEl/sepResultEl/pathInputEl/sepBtnEl — مُوصِّلات عناصر الملف
 *   - validatePath() وrunProbe() — التحقق قبل أي نداء للخلفية ثم الفحص
 *   - outDirOf() — مجلد المسار (يستعمله الفصل والتنزيل وفتح المجلد)
 * لم يتغيّر أي معرّف DOM (#media-verdict، #sep-result، #media-path،
 * #btn-separate، #kind-video، #kind-audio، .kind-card.selected، #q-wrap،
 * #quality-select) ولا أي أمر (`path_exists`، `path_is_dir`، `probe_media`،
 * `push_log`) ولا نصّ رسالة ولا مفتاح ترجمة (err_not_found، err_is_dir،
 * err_no_audio، probe_flag_disguised، probe_flag_cover، quality_same،
 * out_type_label، out_video، out_audio). الوحيد المضاف: `export`.
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import { sanitizePath } from './util';
import * as session from './session';
import type { MediaInfo } from './types';

/** Render a verdict line as PLAIN TEXT. Never accepts markup: error messages
 *  embed backend text / file paths (e.g. failed probe_media), so innerHTML
 *  here is an XSS sink — a file named `<img onerror=...>.mp3` would execute
 *  in the WebView. */
export function setVerdict(el: HTMLElement | null, text: string, isBad = false): void {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('text-error', isBad);
  el.classList.toggle('text-on-surface-variant', !isBad);
}

/** Rich verdict variant — ONLY for static, trusted markup written in this
 *  file. Callers must never interpolate user/backend data into `html`. */
export function setVerdictHtml(el: HTMLElement | null, html: string, isBad = false): void {
  if (!el) return;
  el.innerHTML = html;
  el.classList.toggle('text-error', isBad);
  el.classList.toggle('text-on-surface-variant', !isBad);
}

export function probeEl() { return document.getElementById('media-verdict'); }
export function sepResultEl() { return document.getElementById('sep-result'); }
export function pathInputEl() { return document.getElementById('media-path') as HTMLInputElement; }
export function sepBtnEl() { return document.getElementById('btn-separate') as HTMLButtonElement; }

/** The «نوع الإخراج: فيديو» verdict line. Markup is static and trusted (never
 *  interpolates backend data); both the label and the value span carry a
 *  data-i18n key so applyLang keeps them translated after a later rebuild. */
export function verdictHtml(outKind: 'audio' | 'video'): string {
  const key = outKind === 'video' ? 'out_video' : 'out_audio';
  // text-primary-fixed-dim (#ffb59d) instead of text-clay-accent: the clay
  // chip background lifts the panel, and clay-on-clay only reached 4.17:1
  // (this token is 7.62:1) — measured, see the audit in the report.
  return `<span data-i18n="out_type_label">${t('out_type_label')}</span> <span class="bg-clay-accent/20 text-primary-fixed-dim px-1.5 py-0.5 rounded font-bold mr-1 inline-block" data-i18n="${key}">${t(key)}</span>`;
}

/** Validate a pasted/dropped path BEFORE any backend call. Returns cleaned path or null. */
export async function validatePath(rawPath: string): Promise<{ ok: true; path: string } | { ok: false }> {
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

export async function runProbe(rawPath?: string): Promise<MediaInfo | null> {
  const target = rawPath ?? pathInputEl().value;
  const validated = await validatePath(target);
  const v = probeEl();
  session.setLastProbeOk(false);
  sepBtnEl().disabled = true;

  if (!validated.ok) return null;
  session.setCurrentMediaPath(validated.path);

  try {
    const info = await invoke<MediaInfo>('probe_media', { path: session.getCurrentMediaPath() });
    if (!info.has_audio) {
      setVerdict(v!, t('err_no_audio'), true);
      return null;
    }
    const flags: string[] = [];
    if (info.audio_disguised_as_video) flags.push('⚠ ' + t('probe_flag_disguised'));
    if (info.video_is_cover_art) flags.push('ℹ ' + t('probe_flag_cover'));

    // Auto-switch UI based on media type
    if (info.has_video && !info.video_is_cover_art) {
        document.getElementById('kind-video')?.click();
    } else {
        document.getElementById('kind-audio')?.click();
    }

    const kindSel = document.querySelector<HTMLElement>('.kind-card.selected');
    const outKind = (kindSel?.dataset.kind as 'audio' | 'video') ?? 'video';
    setVerdictHtml(v!, verdictHtml(outKind), false);

    session.setLastProbeOk(true);
    sepBtnEl().disabled = false;

    invoke('push_log', { level: 'info', message: `probe ok: ${session.getCurrentMediaPath()}` });
    return info;
  } catch (e) {
    setVerdict(v!, String(e), true);
    invoke('push_log', { level: 'error', message: `probe failed: ${e}` });
    return null;
  }
}

export function outDirOf(p: string): string {
  return p.replace(/[\\/]+[^\\/]+$/, '');
}
