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
  const st = await invoke<{ nvidia: boolean; cuda: boolean }>('cuda_status').catch(() => null);
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
