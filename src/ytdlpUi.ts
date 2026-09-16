/* ── ق-١: واجهة تحديث yt-dlp (مفتاح + زرّ + سطر حالة) ─────────────────────
 * لماذا وحدة مستقلة: الزرّ يُوصَل في queue.ts (wireUrlDownload) وسطر الحالة
 * في settingsPanel.ts (wireSettings)، وكلاهما يحتاج قراءة الحالة نفسها —
 * فمصدر واحد للقراءة أفضل من نسختين تفترقان. ولا تعتمد هذه الوحدة على أي
 * وحدة واجهة أخرى، فلا تنشئ دورة استيراد بين الاثنتين.
 */
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';

/** الحالة المخزّنة: '1' تشغيل · '0' إطفاء · لا شيء ⇒ تشغيل (الافتراضي في Rust). */
export function ytdlpAutoUpdateOn(): boolean {
  return localStorage.getItem('hl.ytdlp_auto') !== '0';
}

/** يحرس صفّ yt-dlp في الإعدادات:
 *  - زرّ التحديث اليدوي **يبقى متاحاً في الحالتين** (تصحيح بعد المراجعة): كان
 *    معطَّلاً ما دام التلقائي مشتعلاً، بينما سطر بطاقة التنزيل يقول للمستخدم
 *    «إن فشل التنزيل، حدّث yt-dlp من الإعدادات» — فيصل إلى زرّ ميت. والتحديث
 *    اليدوي ذو معنى في الحالتين: الأمر `update_ytdlp` بـ`force=true` **يتجاوز
 *    كاش الـ24 ساعة**، فينتفع به من يريد النسخة الأحدث الآن لا بعد يوم. (ولا
 *    يُعطَّل إلا أثناء التنفيذ نفسه — حماية من النقر المزدوج، في `queue.ts`.)
 *  - عند الإطفاء يُظهر سطر التحذير (ثمن التعطيل) ويعرض **إصدار النسخة
 *    المحلية** من الأمر `ytdlp_local_version` — قراءة حقيقية من `--version`،
 *    لا رقم مكتوب بيد.
 *  - عند التشغيل يُخفي السطر كاملاً: لا تحذير بلا سبب. */
export function refreshYtdlpUpdateUi(): void {
  const auto = ytdlpAutoUpdateOn();
  const status = document.getElementById('ytdlp-auto-status');
  if (!status) return;
  if (auto) {
    status.classList.add('hidden');
    return;
  }
  status.classList.remove('hidden');
  void invoke<string | null>('ytdlp_local_version')
    .then((v) => {
      const slot = document.getElementById('ytdlp-local-version');
      if (!slot) return;
      const ver = (v || '').trim();
      slot.textContent = ver ? t('ytdlp_local_version', { version: ver }) : t('ytdlp_local_missing');
    })
    .catch(() => {
      // بلا backend (تطوير المتصفح) لا ندّعي إصداراً — نترك السطر فارغاً.
      const slot = document.getElementById('ytdlp-local-version');
      if (slot) slot.textContent = '';
    });
}
