/* ── اللوحة المتقدّمة المخفيّة: ٦ نقرات على شارة الإصدار ────────────────────
 *
 * **قرار المالك (جولة settings2)**: «بلى، خلف ٦ نقرات — يوافق هدف البرنامج
 * وسياسته منذ البداية». فـ`#keep-inst` (الاحتفاظ بالموسيقى) و`#fmt-select`
 * (صيغة الصوت) **مخفيّان عن الواجهة العادية عن قصد**، داخل
 * `#advanced-panel-container` (`.spring-panel`) في `<main>`، ويُفتحان بعدّاد
 * نقرات على `#version-badge`: يصفَّر إن تجاوز الفارق ٤ ثوانٍ، ووميض خفيف عند
 * الثالثة، وفتح/طيّ عند ≥٦. والعدّاد **مسترجَع حرفياً** من الالتزام الذي حذفه
 * (`f2114a5^`) لا من الذاكرة.
 *
 * **ولماذا وحدة مستقلّة**: كانت في `src/main.ts`، و`main.ts` تُنفّذ `init()` عند
 * الاستيراد، فاستيرادها في اختبار يشغّل التطبيق كلّه. وهذه الوحدة تُستورَد وحدها
 * فيقيس حارسها السلوك على DOM المشحون بلا آثار جانبية.
 *
 * **وحرّاسه** في `src/__tests__/settingsTabs.test.ts`:
 *   (١) حارس «لا مسار ميت» على كل `src/*.ts` يشترط أن يكون `#advanced-panel-container`
 *       **موجوداً** في `index.html` (فلو أُزيل الترميز سقط فوراً) — **بلا أي
 *       قائمة استثناء**؛
 *   (٢) حارس اللوحة: موجودة + `.spring-panel` + داخل `<main>` + **هي** الحاملة
 *       للمعرّفين المعلَنين في `SETTINGS_HIDDEN_SURFACES` + **مقيسة سلوكياً**:
 *       خمس نقرات لا تفتح، والسادسة تفتح، وستّ جديدة تطوي.
 */
import { invoke } from '@tauri-apps/api/core';
import { pushSettings } from './settings';

/** يربط عدّاد النقر الستّ على `#version-badge`، وربط `#keep-inst`. */
export function wireHiddenAdvancedPanel(): void {
  const badge = document.getElementById('version-badge');
  if (badge) {
    let taps = 0;
    let firstTapAt = 0;
    badge.addEventListener('click', () => {
      const now = Date.now();
      if (now - firstTapAt > 4000) {
        taps = 0;
        firstTapAt = now;
      }
      taps += 1;
      if (taps === 3) {
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
  }

  const cb = document.getElementById('keep-inst') as HTMLInputElement | null;
  if (cb) {
    cb.checked = localStorage.getItem('hl.keep_inst') === '1';
    cb.addEventListener('change', () => {
      localStorage.setItem('hl.keep_inst', cb.checked ? '1' : '0');
      pushSettings();
      invoke('push_log', { level: 'info', message: `keep_instrumental = ${cb.checked}` });
    });
  }
}
