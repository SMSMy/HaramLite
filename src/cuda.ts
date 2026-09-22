/* ── تسريع CUDA ومراحل المعالجة الظاهرة ──────────────────────────────────
 * نُقل من src/main.ts كما هو حرفياً:
 *   - showCudaHint()      : التلميح الذكي أسفل الإعدادات (#cuda-hint / #cuda-hint-text)
 *   - updateCudaBanner()  : اللافتة الخضراء الدائمة (#cuda-banner / #cuda-banner-text)
 *                           تظهر ما دام الكرت مدعوماً والخيار مُطفأ
 *   - STAGE_NAMES         : أسماء المراحل الأربع (توحيد ← فصل ← مؤثرات ← ترميز)
 *   - hideStageLine()     : إخفاء #stage-line عند انتهاء المعالجة
 * لم يتغيّر أي معرّف DOM ولا مفتاح ترجمة (cuda_banner_enable، cuda_downloading،
 * cuda_ready، cuda_download_failed، cuda_missing_text) ولا مفتاح localStorage
 * ('hl.cuda') ولا الأمر (`cuda_status`). الوحيد المضاف: `export`.
 *
 * ن-٣ (2026-09-22) أضاف: `#cuda-provider` (سطح حالة دائم، معرّف واحد بسبب
 * مذكور في index.html) + ثلاث مفاتيح ترجمة (ar/en متكافئة) + `providerLine()`
 * النقية و`refreshProviderLine()`. ولم يُلمس شيء ممّا سبق: التلميح واللافتة
 * والأمر كما هما، و`cuda_status` **وُسِّع** بحقلين (`provider` · `provider_known`)
 * فما كان يقرأه قارئ قديم ما زال يقرأه.
 */
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';

/* ── smart CUDA hint (Sprint C2-style UX) ───────────────────────────── */
export function showCudaHint(text: string): void {
  const hint = document.getElementById('cuda-hint');
  if (!hint) return;
  if (text) {
    const span = document.getElementById('cuda-hint-text');
    if (span) span.textContent = text;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
}

/** عقد `cuda_status` كما يبنيه الرست (lib.rs ← cuda_status_payload).
 *  `provider` = المزوّد الفعّال في **آخر جلسة فصل**، مقروءاً من `provider.json`
 *  (لا من `ACTIVE_PROVIDER`: ذاك `OnceLock` فأول جلسة في العملية تفوز، والملف
 *  يُكتب في كل جلسة). و`provider_known=false` تعني **لم يُقَس بعد** — لا «CPU». */
export interface CudaStatus {
  nvidia: boolean;
  cuda: boolean;
  provider: string | null;
  provider_known: boolean;
}

/** نصّ سطر المزوّد وحالته — دالة نقية: تُختبر بلا DOM وبلا IPC.
 *  ثلاثة نتائج لا اثنتان: معروف (اسمه) · CPU (تحذير صريح) · **غير معروف**. */
export function providerLine(
  st: Pick<CudaStatus, 'provider' | 'provider_known'> | null,
): { text: string; warn: boolean } {
  const name = typeof st?.provider === 'string' ? st.provider.trim() : '';
  if (!st || st.provider_known !== true || name === '') {
    return { text: t('cuda_provider_unknown'), warn: false };
  }
  if (name.toUpperCase() === 'CPU') return { text: t('cuda_provider_cpu_warn'), warn: true };
  return { text: t('cuda_provider_label', { name }), warn: false };
}

/** يرسم سطر «المزوّد الفعّال» من حقيقة الخلف. **لا يكتب شيئاً إن تعذّر النداء**:
 *  السطر يبقى على نصّه الصادق السابق («غير معروف») بدل ادّعاء حالة لم تُقرأ. */
export async function refreshProviderLine(): Promise<void> {
  const el = document.getElementById('cuda-provider');
  if (!el) return;
  const st = await invoke<CudaStatus>('cuda_status').catch(() => null);
  if (st === null) return;
  const line = providerLine(st);
  el.textContent = line.text;
  el.classList.toggle('text-error', line.warn);
  el.classList.toggle('text-on-surface-variant', !line.warn);
}

/** Permanent green banner above the mode cards: shown as long as an NVIDIA
 *  GPU is supported and the CUDA toggle is OFF. The libraries self-download
 *  on first enable, so the message is the same whether they're ready or not. */
export async function updateCudaBanner(): Promise<void> {
  const banner = document.getElementById('cuda-banner');
  const text = document.getElementById('cuda-banner-text');
  if (!banner || !text) return;
  const cudaOn = localStorage.getItem('hl.cuda') === '1';
  if (cudaOn) {
    banner.classList.add('hidden');
    return;
  }
  const st = await invoke<CudaStatus>('cuda_status').catch(() => null);
  if (st && st.nvidia) {
    text.textContent = t('cuda_banner_enable');
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

/* ── visible pipeline stages (Sprint C2) ────────────────────────────── */
export const STAGE_NAMES: Record<string, { ar: string; en: string }> = {
  normalize: { ar: 'توحيد الصوت', en: 'Normalizing' },
  separate: { ar: 'فصل الصوت', en: 'Separating' },
  effects: { ar: 'المؤثرات', en: 'Effects' },
  encode: { ar: 'الترميز', en: 'Encoding' },
};
export function hideStageLine(): void {
  document.getElementById('stage-line')?.classList.add('hidden');
}
