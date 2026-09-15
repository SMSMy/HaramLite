#!/usr/bin/env node
/* تحديث ذكر الإصدار في الموقع إلى 0.2.4 — 2026-09-15.
 *
 * العطل الذي أبلغ عنه المالك: بعد نشر 0.2.4 بقي الموقع يقول 0.2.3 في ثلاثة
 * مواضع، لأن:
 *   (١) شريحة «سجل التغييرات • الإصدار 0.2.3» عنصر بلا أي خطّاف JS،
 *   (٢) عنوانا «الجديد» و«التنبيه الشفاف» يحملان الرقم داخل نصّ الترجمة بلا
 *       `{v}`، فآلية fill() لا تصل إليهما،
 *   (٣) وبنود قسم «الجديد» تصف تغييرات 0.2.3 فعلاً.
 * فالإصلاح: `{v}` في النصوص المترجَمة (فيُستبدل حيّاً)، و`js-version-text`
 * للشريحة، وإعادة كتابة بنود القسم لتطابق 0.2.4، وتحديث ما تبقّى من ذكرى
 * زخرفية في صفحات الأدلة.
 *
 * الاستعمال: node scripts/site-version-0.2.4.cjs
 */
const fs = require('fs');
const path = require('path');

const docs = path.resolve(__dirname, '..', 'docs');
const V = '0.2.4';

// ── ١) قسم «الجديد» كاملاً: من تعليقه إلى قسم الخصوصية ────────────────────
const SECTION = `<!-- 6. WHAT'S NEW IN ${V} (#whatsnew) -->
  <section class="max-w-7xl mx-auto px-margin-mobile lg:px-margin-desktop mb-24 scroll-mt-20" id="whatsnew">
    <div class="bg-surface-container-high rounded-xl p-stack-lg sm:p-12 shadow-lg">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-stack-md mb-8 pb-stack-md border-b border-border-muted">
        <div>
          <div class="inline-flex items-center gap-stack-sm px-stack-sm py-0.5 rounded bg-clay-accent/15 text-clay-accent font-mono-code text-mono-code font-bold mb-2">
            سجل التغييرات • الإصدار <span class="js-version-text">${V}</span>
          </div>
          <h2 class="font-headline-xl text-headline-xl text-cream-text" data-i18n-ar="الجديد في إصدار {v}" data-i18n-en="What's New in v{v}">الجديد في إصدار ${V}</h2>
        </div>
        <a class="inline-flex items-center gap-stack-sm font-label-md text-label-md text-clay-accent hover:underline" href="https://github.com/SMSMy/HaramLite/releases/latest" rel="noreferrer" target="_blank">
          <span data-i18n-ar="عرض تقرير الإصدار في GitHub" data-i18n-en="View release on GitHub">عرض تقرير الإصدار في GitHub</span>
          <span class="material-symbols-outlined text-[16px]">arrow_outward</span>
        </a>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-stack-lg">

        <div class="space-y-stack-sm">
          <div class="flex items-center gap-stack-sm text-cream-text font-bold font-label-md text-label-md">
            <span class="material-symbols-outlined text-clay-accent">content_cut</span>
            <span data-i18n-ar="قصّ الصمت لم يعد يُتلف الملف" data-i18n-en="Silence trimming can no longer shred a file">قصّ الصمت لم يعد يُتلف الملف</span>
          </div>
          <p class="font-body-md text-body-md text-on-surface-variant leading-relaxed" data-i18n-ar="إذا حمل الملف قيماً غير منتهية (NaN أو Inf) في نحو 10% من نوافذ القياس، صارت العتبة التكيفية لا نهائية فاعتُبرت كل نافذة سليمة «صامتة» وقُصّ الملف إلى شذرات. صارت العتبة تُحسب من النوافذ السليمة وحدها، وإن لم توجد نافذة سليمة فلا قصّ إطلاقاً." data-i18n-en="When a file carried non-finite samples (NaN or Inf) in roughly 10% of the measurement windows, the adaptive threshold became infinite: every healthy window counted as silence and the file was cut into slivers. The threshold is now computed from healthy windows only, and when none exists nothing is trimmed at all.">إذا حمل الملف قيماً غير منتهية (NaN أو Inf) في نحو 10% من نوافذ القياس، صارت العتبة التكيفية لا نهائية فاعتُبرت كل نافذة سليمة «صامتة» وقُصّ الملف إلى شذرات. صارت العتبة تُحسب من النوافذ السليمة وحدها، وإن لم توجد نافذة سليمة فلا قصّ إطلاقاً.</p>
        </div>

        <div class="space-y-stack-sm">
          <div class="flex items-center gap-stack-sm text-cream-text font-bold font-label-md text-label-md">
            <span class="material-symbols-outlined text-clay-accent">cancel</span>
            <span data-i18n-ar="زرّ الإلغاء صار يوقف الترميز فعلاً" data-i18n-en="Cancel now actually stops the encode">زرّ الإلغاء صار يوقف الترميز فعلاً</span>
          </div>
          <p class="font-body-md text-body-md text-on-surface-variant leading-relaxed" data-i18n-ar="كان التطبيق يتجاهل نتيجة فحص الإلغاء الأخير: فيُنهي ترميز الفيديو ويُعلن النجاح ثم يمضي في مسار يحذف المصدر المنزَّل. الآن الإلغاء يُلغي المهمة، ويحذف ما كُتب منها، ويُعلن الإلغاء." data-i18n-en="The app ignored the result of its final cancel check: it finished encoding the video, reported success, and then walked the path that deletes the downloaded source. Cancelling now ends the job, removes what it wrote, and reports the cancellation.">كان التطبيق يتجاهل نتيجة فحص الإلغاء الأخير: فيُنهي ترميز الفيديو ويُعلن النجاح ثم يمضي في مسار يحذف المصدر المنزَّل. الآن الإلغاء يُلغي المهمة، ويحذف ما كُتب منها، ويُعلن الإلغاء.</p>
        </div>

        <div class="space-y-stack-sm">
          <div class="flex items-center gap-stack-sm text-cream-text font-bold font-label-md text-label-md">
            <span class="material-symbols-outlined text-clay-accent">accessibility_new</span>
            <span data-i18n-ar="واجهة معرَّبة بالكامل وأسهل وصولاً" data-i18n-en="A fully translated, more accessible interface">واجهة معرَّبة بالكامل وأسهل وصولاً</span>
          </div>
          <p class="font-body-md text-body-md text-on-surface-variant leading-relaxed" data-i18n-ar="التعريب صار كاملاً (192 مفتاحاً في كل لغة)، فلا يبقى نصّ عربي في الواجهة الإنجليزية. والتباين صار يمرّ بمعيار AA على 129 عنصراً بعد أن كان يفشل على 12، ومنطقة الإفلات تعمل بلوحة المفاتيح، والحوارات لها أدوارها وتُغلق بـEsc." data-i18n-en="Translation is now complete (192 keys per language), so no Arabic remains in the English interface. Contrast passes AA on 129 elements after failing on 12, the drop zone works from the keyboard, and the dialogs carry their roles and close with Escape.">التعريب صار كاملاً (192 مفتاحاً في كل لغة)، فلا يبقى نصّ عربي في الواجهة الإنجليزية. والتباين صار يمرّ بمعيار AA على 129 عنصراً بعد أن كان يفشل على 12، ومنطقة الإفلات تعمل بلوحة المفاتيح، والحوارات لها أدوارها وتُغلق بـEsc.</p>
        </div>

        <div class="space-y-stack-sm">
          <div class="flex items-center gap-stack-sm text-cream-text font-bold font-label-md text-label-md">
            <span class="material-symbols-outlined text-clay-accent">memory</span>
            <span data-i18n-ar="ذاكرة أقل إلى النصف في قراءة الصوت" data-i18n-en="Half the memory when reading audio">ذاكرة أقل إلى النصف في قراءة الصوت</span>
          </div>
          <p class="font-body-md text-body-md text-on-surface-variant leading-relaxed" data-i18n-ar="قياس على ملف ستيريو 300 ثانية (105.8 MB): الذروة انخفضت من 213.5 MB إلى 112.5 MB — أي نحو 100.9 MB (47%). والبيانات لم تتغيّر: بصمة القناتين متطابقة، وتكافؤ بتّي مُثبَت مع الطريقة القديمة." data-i18n-en="Measured on a 300 second stereo file (105.8 MB): peak memory fell from 213.5 MB to 112.5 MB, about 100.9 MB (47%). The data is unchanged - the channel hashes match, and bit-for-bit equality with the old reader was proven.">قياس على ملف ستيريو 300 ثانية (105.8 MB): الذروة انخفضت من 213.5 MB إلى 112.5 MB — أي نحو 100.9 MB (47%). والبيانات لم تتغيّر: بصمة القناتين متطابقة، وتكافؤ بتّي مُثبَت مع الطريقة القديمة.</p>
        </div>

      </div>
      <p class="mt-6 font-body-md text-body-md text-on-surface-variant">
        <span data-i18n-ar="ملاحظة: وضع «أغنية» ما زال يطبّق سلسلة التحسين بعده — قصّ الصمت والتطبيع إلى −14 LUFS — وهو سلوك مقصود، لا أثر جانبي." data-i18n-en="Note: Song mode still applies its enhancement chain afterwards — silence trimming and normalisation to −14 LUFS — which is intended behaviour, not a side effect.">ملاحظة: وضع «أغنية» ما زال يطبّق سلسلة التحسين بعده — قصّ الصمت والتطبيع إلى −14 LUFS — وهو سلوك مقصود، لا أثر جانبي.</span>
        <a class="font-label-md text-label-md text-clay-accent hover:underline" href="https://github.com/SMSMy/HaramLite/releases" target="_blank" rel="noreferrer"><span data-i18n-ar="تفاصيل الإصدارات السابقة" data-i18n-en="Earlier release details">تفاصيل الإصدارات السابقة</span></a>
      </p>
    </div>
  </section>

  `;

const indexPath = path.join(docs, 'index.html');
let idx = fs.readFileSync(indexPath, 'utf8');

const start = idx.indexOf("<!-- 6. WHAT'S NEW");
const end = idx.indexOf('<!-- 7. STRICT');
if (start < 0 || end < 0 || end < start) {
  console.error('✗ لم أجد حدود قسم «الجديد»');
  process.exit(1);
}
idx = idx.slice(0, start) + SECTION + idx.slice(end + '<!-- 7. STRICT'.length - '<!-- 7. STRICT'.length);
// (نُبقي تعليق القسم السابع كما هو: القطع يبدأ من تعليق السادس حتى تعليق السابع)
idx = idx.slice(0, start) + SECTION + idx.slice(end);
fs.writeFileSync(indexPath, idx);
console.log('  ✓ قسم «الجديد» أُعيد بناؤه ليطابق 0.2.4');

// ── ٢) التنبيه الشفاف: الرقم صار {v} فيُستبدل حيّاً ────────────────────────
let html = fs.readFileSync(indexPath, 'utf8');
const before = html;
html = html
  .replace('data-i18n-ar="تنبيه شفاف بخصوص التحديث في الإصدار 0.2.3"', 'data-i18n-ar="تنبيه شفاف بخصوص التحديث في الإصدار {v}"')
  .replace('data-i18n-en="Transparent Notice Regarding v0.2.3 Auto-Updates"', 'data-i18n-en="Transparent Notice Regarding v{v} Auto-Updates"')
  .replace('>تنبيه شفاف بخصوص التحديث في الإصدار 0.2.3<', '>تنبيه شفاف بخصوص التحديث في الإصدار 0.2.4<');
if (html !== before) { fs.writeFileSync(indexPath, html); console.log('  ✓ عنوان التنبيه الشفاف صار {v}'); }

// ── ٣) ما تبقّى من ذكرى 0.2.3 في كل صفحات الموقع ──────────────────────────
const files = [
  ...fs.readdirSync(docs).filter((f) => f.endsWith('.html')).map((f) => path.join(docs, f)),
  ...fs.readdirSync(path.join(docs, 'guides')).filter((f) => f.endsWith('.html')).map((f) => path.join(docs, 'guides', f)),
];
let touched = 0, total = 0;
for (const f of files) {
  let t = fs.readFileSync(f, 'utf8');
  const n = (t.match(/0\.2\.3/g) || []).length;
  if (!n) continue;
  t = t.replace(/0\.2\.3/g, V);
  fs.writeFileSync(f, t);
  touched++; total += n;
  console.log(`    ${path.relative(docs, f).padEnd(44)} ${n}`);
}
console.log(`  ✓ ${total} ذكراً في ${touched} ملفاً صارت ${V}`);
