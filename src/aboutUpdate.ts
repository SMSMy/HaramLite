/* ── «حول البرنامج» والإبلاغ، وفحص التحديثات ──────────────────────────────
 * نُقل من src/main.ts كما هو حرفياً — قسمان متجاوران يخدمان نافذة واحدة:
 *   - about + report: Credit وfillAbout() وwireAbout() وwireReport()
 *   - update check: UpdateStatus وUPDATE_PAGE_FALLBACK وsetUpdRow()
 *     وsetUpdDownload() وrunUpdateCheck() وsilentUpdateCheck()
 *     وwireUpdateCheck()
 * لم يتغيّر أي معرّف DOM (#about-*، #btn-about، #btn-report، #update-status،
 * #btn-update-check، #btn-update-download) ولا أي أمر (`ping`، `open_url`،
 * `check_update_cmd`/`update_status` كما هي، `push_log`) ولا رابط صفحة
 * التنزيل الاحتياطي، ولا مفاتيح الترجمة (about_*، btn_about، btn_report،
 * upd_*، dlg_close). الوحيد المضاف: `export` على ما تناديه main.ts
 * (wireAbout، wireReport، wireUpdateCheck، silentUpdateCheck).
 */

import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { currentLang, t } from './i18n';
import { showToast } from './util';
import * as session from './session';

/* ── about + report (Sprint B3/B4) ──────────────────────────────────── */
type Credit = { name: string; url?: string; ar: string; en: string };
function fillAbout(): void {
  const body = document.getElementById('about-body');
  if (!body) return;
  const credits: Credit[] = [
    { name: 'UVR-MDX-NET-Voc_FT — Ultimate Vocal Remover', url: 'https://github.com/Anjok07/ultimatevocalremovergui', ar: 'نموذج الفصل (63MB، تشغيل محلي كامل) من Ultimate Vocal Remover — Anjok07 و aufr33، بترخيص MIT', en: 'separation model (63MB, fully local) by Ultimate Vocal Remover — Anjok07 & aufr33, MIT-licensed' },
    { name: 'ONNX Runtime', ar: 'محرك الاستدلال (CPU / DirectML / CUDA)', en: 'inference engine (CPU / DirectML / CUDA)' },
    { name: 'FFmpeg / ffprobe', ar: 'الفحص والمعالجة والترميز', en: 'probing, processing and encoding' },
    { name: 'yt-dlp', ar: 'تنزيل الوسائط', en: 'media downloads' },
    { name: 'Thmanyah Typeface', ar: 'الخط العربي', en: 'Arabic typeface' },
    { name: 'Material Symbols', ar: 'الأيقونات', en: 'icons' },
    { name: 'HaramMute', url: 'https://github.com/alganzory', ar: 'الملهم الأول', en: 'The first inspiration' },
  ];
  const desc = (c: Credit): string => (currentLang() === 'ar' ? c.ar : c.en);
  const link = (text: string, url: string): string =>
    `<span class="about-link" data-open-url="${url}">${text}</span>`;
  body.innerHTML = `
    <div class="flex items-center gap-unit">
      <span class="font-bold text-clay-accent">HaramLite</span>
      <span id="about-version" class="bg-clay-accent/20 text-clay-accent px-1.5 py-0.5 rounded font-bold">v${session.getAppVersion() || '—'}</span>
    </div>
    <p>${t('about_dev')} ${link('smsmy', 'https://github.com/SMSMy/HaramLite')} — ${t('about_dev_rest')}</p>
    <div class="mt-2">
      <div class="font-bold text-on-surface-variant mb-1">${t('about_credits')}:</div>
      <ul class="flex flex-col gap-unit text-on-surface-variant text-xs leading-relaxed">
        ${credits.map((c) => `<li>• ${c.url ? link(c.name, c.url) : c.name} — ${desc(c)}</li>`).join('')}
      </ul>
    </div>`;
}
/** **«حول البرنامج» يُعرض مباشرة في تبويبه** (قرار المالك، جولة settings2).
 *
 * كان مودالاً (`#about-overlay`) يُفتح بزرّ `#btn-about`، وفيه `fillAbout()`
 * وحبسُ تركيز (trapFocus) وإغلاقٌ بـESC. والمحتوى انتقل إلى `#about-body`
 * **داخل تبويب «حول البرنامج»** في شاشة الإعدادات، فلم يبقَ مودال ولا زرّ فتح
 * ولا حبسُ تركيز (لا حوار يُحبس فيه التركيز).
 *
 * **وأثر التغيير على الفتح مقيس**: الروابط تُفتح بالمُوصِّل المفوَّض على
 * `#about-body` نفسه، وهو باقٍ هنا كما كان — **يتغيّر موضعه لا آلية عمله**. */
export function wireAbout(): void {
  fillAbout();
  // External links in the credits (dev credit, inspiring projects):
  // delegated once on the stable container — innerHTML re-renders freely.
  // data-open-url only (never raw href — href would navigate the WebView
  // itself out of the app and break it).
  document.getElementById('about-body')?.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest?.('[data-open-url]') as HTMLElement | null;
    const url = el?.getAttribute('data-open-url');
    if (url) void openUrl(url).catch((err) => console.error('openUrl failed', err));
  });
}
export function wireReport(): void {
  document.getElementById('btn-report')?.addEventListener('click', () => {
    void openUrl('https://github.com/SMSMy/HaramLite/issues/new').catch((e) =>
      console.error('open issues page failed', e));
  });
}

/* ── update check (هـ) ───────────────────────────────────────────────
 * 0.2.4 أزالت زرّ «التحقق من التحديثات» لأن نداء `tauri-plugin-updater` كان
 * يفشل دائماً: لا `latest.json` يُنشر ما دام `createUpdaterArtifacts:false`.
 * القناة الجديدة (الخيار ١) تسأل واجهة GitHub العامة عن `releases/latest`
 * عبر أمر Rust واحد (‏`check_update`) وتقارن دلالياً بإصدار الحزمة نفسه.
 * قاعدة هذا الصفّ: **لا زرّ يفشل بصمت** — كل خروج إما نصّ نتيجة أو نصّ خطأ
 * عربي في `#update-status`، ومعها سطر في السجل. */
type UpdateStatus = {
  current: string;
  latest: string | null;
  update_available: boolean;
  download_url: string;
  error: string | null;
  from_cache: boolean;
};

const UPDATE_PAGE_FALLBACK = 'https://github.com/SMSMy/HaramLite/releases/latest';

/** نصّ الصفّ: نجاحاً أو فشلاً. `isError` يلوّنه ويعلن سبب الخطأ للقارئ. */
function setUpdRow(text: string, isError: boolean): void {
  const el = document.getElementById('update-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('text-error', isError);
  el.classList.toggle('text-on-surface-variant', !isError);
  el.classList.remove('hidden');
}

/** زرّ صفحة التنزيل يظهر عند وجود أحدث فقط، ويحمل رابطه في `data-url`. */
function setUpdDownload(url: string | null): void {
  const btn = document.getElementById('btn-update-download');
  if (!btn) return;
  btn.classList.toggle('hidden', !url);
  btn.classList.toggle('flex', !!url);
  if (url) btn.dataset.url = url;
  else delete btn.dataset.url;
}

/**
 * الفحص. `force=true` هو الزرّ: نداء حقيقي دائماً ونتيجته **ظاهرة دائماً**
 * (نصّ في الصفّ، وإشعار، وسطر في السجل) — نجاحاً أو فشلاً، فلا زرّ يفشل بصمت.
 * و`force=false` هو الفحص الصامت عند الإقلاع (كاش ٢٤ ساعة في الرست — هـ.٤):
 * لا يكتب في الواجهة إلا حين يوجد أحدث فعلاً، وإلا فسطر في السجل وحده — فلا
 * يصير «خطأ إطلاق صامت» يزعج المستخدم في كل إقلاع بلا شبكة.
 */
async function runUpdateCheck(force: boolean): Promise<UpdateStatus | null> {
  const btn = document.getElementById('btn-update-check') as HTMLButtonElement | null;
  if (force) {
    if (btn) btn.disabled = true;
    setUpdRow(t('upd_checking'), false);
  }
  try {
    const st = await invoke<UpdateStatus>('check_update', { force });

    if (st.error) {
      // مسار الفشل: بلا شبكة · بلا إصدارات منشورة · استجابة غير متوقعة · JSON مشوّه
      if (force) {
        setUpdRow(`${t('upd_failed')} — ${st.error}`, true);
        setUpdDownload(null);
        showToast(`${t('upd_failed')} — ${st.error}`);
      }
      invoke('push_log', { level: force ? 'warn' : 'debug', message: `update check failed: ${st.error}` });
      return st;
    }

    if (st.update_available && st.latest) {
      setUpdRow(t('upd_found', { v: st.latest }), false);
      setUpdDownload(st.download_url || UPDATE_PAGE_FALLBACK);
      invoke('push_log', {
        level: 'info',
        message: `update available: v${st.latest} (current v${st.current}${st.from_cache ? ', cached' : ''})`,
      });
      if (force) showToast(`${t('upd_avail')} v${st.latest}`);
      return st;
    }

    if (force) {
      setUpdRow(t('upd_uptodate', { v: st.current }), false);
      setUpdDownload(null);
      showToast(t('upd_uptodate', { v: st.current }));
    }
    invoke('push_log', { level: 'debug', message: `update check: v${st.current} is the latest` });
    return st;
  } catch (e) {
    // حتى فشل الأمر نفسه (ثنائي قديم بلا الأمر، أو خطأ داخلي) له نصّ ظاهر.
    const msg = String(e);
    if (force) {
      setUpdRow(`${t('upd_failed')} — ${msg}`, true);
      setUpdDownload(null);
      showToast(`${t('upd_failed')} — ${msg}`);
    }
    invoke('push_log', { level: force ? 'warn' : 'debug', message: `update check command failed: ${msg}` });
    return null;
  } finally {
    if (force && btn) btn.disabled = false;
  }
}

/** الفحص الصامت عند الإقلاع (كان نداء `tauri-plugin-updater` يفشل دائماً). */
export async function silentUpdateCheck(): Promise<void> {
  await runUpdateCheck(false);
}

export function wireUpdateCheck(): void {
  document.getElementById('btn-update-check')?.addEventListener('click', () => void runUpdateCheck(true));
  document.getElementById('btn-update-download')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-update-download');
    const url = btn?.dataset.url || UPDATE_PAGE_FALLBACK;
    // فشل الفتح أيضاً لا يمرّ بصمت: نصّ في الصفّ + إشعار + سطر في السجل.
    void openUrl(url).catch((e) => {
      setUpdRow(`${t('upd_open_failed')} — ${String(e)}`, true);
      showToast(t('upd_open_failed'));
      invoke('push_log', { level: 'warn', message: `open download page failed: ${String(e)}` });
    });
  });
}
