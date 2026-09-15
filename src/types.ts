/* ── أنواع الرسائل المتبادلة مع الخلفية (Rust) ─────────────────────────────
 * نُقلت من src/main.ts كما هي حرفياً — لا حقل واحد تغيّر اسمه أو نوعه:
 *   - LogLine: سطر سجل واحد (يُستهلك في src/log.ts وفي حدث `log-line`)
 *   - MediaInfo: ناتج أمر `probe_media`
 *   - SepResult: ناتج أمر الفصل
 * الهدف: كسر أي استيراد دائري بين main.ts ووحداته — تُستورَد من هنا.
 */

export type LogLine = { ts: string; level: string; target: string; message: string };
export type MediaInfo = {
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
export type SepResult = {
  vocals: string;
  instrumental: string | null;
  video: string | null;
  seconds: number;
};
