#!/usr/bin/env node
/* تعديل آلي على صفحات الموقع (2026-09-15، بطلب المالك):
 *
 * ١) تصحيح عبارة التذييل: كانت تُقرأ «مبني على أساس مشروع المشروع الأصلي»
 *    (تكرار «مشروع» + اسم الرابط)، والصواب أن HaramMute **الملهِم الأول** لا
 *    أساسٌ بنيوي — فحصُ الكود أثبت أن المشترك هو الفكرة وأدوات الطرف الثالث
 *    فقط (المشروع الأصلي بايثون + torch + audio-separator + نماذج Roformer،
 *    وهذا رست + Tauri + MDX-Net، وصفر معرّفات من عندهم في مستودعنا).
 *
 * ٢) شارة في الشريط الأعلى تؤدي إلى المستودع مباشرة (قبل زرّ التحميل).
 *
 * ٣) في الرئيسية وحدها: يُنقل إسناد UVR من التذييل إلى قسم المطورين (يُتمّ
 *    هناك يدوياً) فيبقى التذييل سطراً واحداً قصيراً.
 *
 * الاستعمال: node scripts/site-footer-and-repo-badge.cjs [--check]
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const docs = path.join(root, 'docs');
const checkOnly = process.argv.includes('--check');

const OLD = '<span data-i18n-ar="مبني على أساس مشروع" data-i18n-en="Built on the">مبني على أساس مشروع</span> <a class="text-clay-accent hover:underline" href="https://github.com/alganzory" rel="noreferrer" target="_blank" data-i18n-ar="المشروع الأصلي" data-i18n-en="The original project">المشروع الأصلي</a>';
const NEW = '<span data-i18n-ar="الملهِم الأول:" data-i18n-en="First inspiration:">الملهِم الأول:</span> <a class="text-clay-accent hover:underline" href="https://github.com/alganzory" rel="noreferrer" target="_blank" title="HaramMute — المشروع الأصلي (بايثون)" data-i18n-ar="مشروع HaramMute" data-i18n-en="the HaramMute project">مشروع HaramMute</a>';

// إسناد UVR يُنقل إلى قسم المطورين في الرئيسية
const OLD_UVR = ' · <span data-i18n-ar="نموذج الفصل من Ultimate Vocal Remover (Anjok07 و aufr33) بترخيص MIT" data-i18n-en="Separation model by Ultimate Vocal Remover (Anjok07 &amp; aufr33), MIT-licensed">نموذج الفصل من Ultimate Vocal Remover (Anjok07 و aufr33) بترخيص MIT</span>';

const BADGE = '<a class="inline-flex items-center gap-1 px-3 py-unit rounded border border-border-muted font-label-sm text-label-sm text-on-surface-variant hover:text-cream-text hover:border-outline transition-colors" href="https://github.com/SMSMy/HaramLite" target="_blank" rel="noopener" aria-label="الكود المصدري على GitHub" title="github.com/SMSMy/HaramLite"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg><span data-i18n-ar="الكود المصدري" data-i18n-en="Source code">الكود المصدري</span></a>';

const files = [
  ...fs.readdirSync(docs).filter((f) => f.endsWith('.html')).map((f) => path.join(docs, f)),
  ...fs.readdirSync(path.join(docs, 'guides')).filter((f) => f.endsWith('.html')).map((f) => path.join(docs, 'guides', f)),
];

const report = [];
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  let html = fs.readFileSync(file, 'utf8');
  const before = html;
  const notes = [];

  if (html.includes(OLD)) { html = html.replace(OLD, NEW); notes.push('التذييل'); }
  if (html.includes(OLD_UVR)) { html = html.replace(OLD_UVR, ''); notes.push('نُقل إسناد UVR'); }

  // شارة المستودع قبل زرّ التحميل (يُستدلّ عليه بنصّه المترجم)
  if (!html.includes('github.com/SMSMy/HaramLite" target="_blank" rel="noopener"')) {
    const cta = html.indexOf('data-i18n-ar="تحميل التطبيق"');
    if (cta >= 0) {
      const at = html.lastIndexOf('<a ', cta);
      if (at >= 0) { html = html.slice(0, at) + BADGE + html.slice(at); notes.push('الشارة'); }
    }
  }

  if (html !== before) {
    if (!checkOnly) fs.writeFileSync(file, html);
    report.push([rel, notes.join(' + ')]);
  }
}

console.log(checkOnly ? '  (وضع التحقّق — لا كتابة)' : '  عُدّلت الملفات:');
for (const [f, n] of report) console.log(`    ${f.padEnd(44)} ${n}`);
console.log(`  المجموع: ${report.length} ملفاً من ${files.length}`);
