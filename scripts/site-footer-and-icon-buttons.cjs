#!/usr/bin/env node
/* تعديل آلي على صفحات الموقع (2026-09-15، طلب المالك الثاني):
 *
 * ١) الشريط السفلي كان صفّاً واحداً يخلط هوية المشروع وتسعة روابط بأطوال مختلفة
 *    وفقرة، فيبدو عشوائياً. صار ثلاثة أعمدة معنونة (الهوية · الموقع · مساعدة
 *    وقانوني) والفقرة سطراً منفصلاً أسفلها.
 *
 * ٢) شارة المستودع في الشريط الأعلى: **أيقونة فقط** (كانت أيقونة + كلمة
 *    «الكود المصدري»)، مع إبقاء الاسم المفهوم لقارئ الشاشة والتلميح.
 *
 * ٣) زرّ «تحميل التطبيق» في الشريط الأعلى: **أيقونة تنزيل فقط** بنفس المنطق.
 *
 * الاستعمال: node scripts/site-footer-and-icon-buttons.cjs [--check]
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const docs = path.join(root, 'docs');
const checkOnly = process.argv.includes('--check');

const LINK = 'class="font-label-sm text-label-sm text-on-surface-variant hover:text-cream-text transition-colors"';
const HEAD = 'class="font-label-sm text-label-sm uppercase tracking-widest text-clay-accent font-bold mb-1"';

// ── التذييل الجديد ────────────────────────────────────────────────────────
const FOOTER = `<footer class="w-full bg-surface-container-lowest border-t border-border-muted py-stack-lg">
<div class="max-w-7xl mx-auto px-margin-mobile lg:px-margin-desktop grid gap-stack-lg sm:grid-cols-3 items-start text-center sm:text-start">
<div class="flex flex-col items-center sm:items-start gap-stack-sm">
<div class="flex items-center gap-stack-sm"><img src="@ICON@" alt="" width="20" height="20" class="w-5 h-5 rounded-sm"><span class="font-serif font-bold text-sm tracking-wide text-cream-text">Haram<span class="text-clay italic">Lite</span></span></div>
<p class="font-mono-code text-mono-code text-on-surface-variant"><span data-i18n-ar="الملهِم الأول:" data-i18n-en="First inspiration:">الملهِم الأول:</span> <a class="text-clay-accent hover:underline" href="https://github.com/alganzory" rel="noreferrer" target="_blank" title="HaramMute — المشروع الأصلي (بايثون)" data-i18n-ar="مشروع HaramMute" data-i18n-en="the HaramMute project">مشروع HaramMute</a></p>
</div>
<nav class="flex flex-col items-center sm:items-start gap-unit">
<span ${HEAD} data-i18n-ar="الموقع" data-i18n-en="Site">الموقع</span>
<a ${LINK} data-path="download" href="@DL@" data-i18n-ar="التحميل" data-i18n-en="Download">التحميل</a>
<a ${LINK} data-path="features" href="@FT@" data-i18n-ar="المميزات" data-i18n-en="Features">المميزات</a>
<a ${LINK} data-path="whats-new" href="@WN@" data-i18n-ar="الجديد" data-i18n-en="What&#39;s new">الجديد</a>
<a ${LINK} data-path="privacy" href="@PV@" data-i18n-ar="الخصوصية" data-i18n-en="Privacy">الخصوصية</a>
<a ${LINK} data-path="developers" href="@DV@" data-i18n-ar="للمطورين" data-i18n-en="Developers">للمطورين</a>
</nav>
<nav class="flex flex-col items-center sm:items-start gap-unit">
<span ${HEAD} data-i18n-ar="مساعدة وقانوني" data-i18n-en="Help &amp; legal">مساعدة وقانوني</span>
<a ${LINK} href="@BR@" data-i18n-ar="إضافة المتصفح" data-i18n-en="Browser extension">إضافة المتصفح</a>
<a ${LINK} href="@PP@" data-i18n-ar="سياسة الخصوصية" data-i18n-en="Privacy policy">سياسة الخصوصية</a>
<a ${LINK} href="@LC@" data-i18n-ar="الرخصة" data-i18n-en="License">الرخصة</a>
<a ${LINK} href="https://github.com/SMSMy/HaramLite/issues/new" data-i18n-ar="هل واجهت مشكلة أو لديك اقتراح؟" data-i18n-en="Found a problem or have a suggestion?">هل واجهت مشكلة أو لديك اقتراح؟</a>
</nav>
</div>
<div class="max-w-7xl mx-auto px-margin-mobile lg:px-margin-desktop mt-stack-md pt-stack-md border-t border-border-muted text-center font-label-sm text-label-sm text-on-surface-variant" data-i18n-ar="صُنع بحبٍّ ليخدم كل من أراد محتواه خاليًا من الموسيقى — وكل شيء هنا مفتوح المصدر، ويمكنك استخدامه وتطويره بحرية." data-i18n-en="Made with care for anyone who wants their content clean — and everything here is open source, free to use and build on.">صُنع بحبٍّ ليخدم كل من أراد محتواه خاليًا من الموسيقى — وكل شيء هنا مفتوح المصدر، ويمكنك استخدامه وتطويره بحرية.</div>
</footer>`;

const BADGE_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

const files = [
  ...fs.readdirSync(docs).filter((f) => f.endsWith('.html')).map((f) => path.join(docs, f)),
  ...fs.readdirSync(path.join(docs, 'guides')).filter((f) => f.endsWith('.html')).map((f) => path.join(docs, 'guides', f)),
];

const report = [];
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const inGuides = rel.includes('/guides/');
  let html = fs.readFileSync(file, 'utf8');
  const before = html;
  const notes = [];

  // (١) التذييل: استبدال الكتلة كاملة (متماثلة في كل الصفحات)
  const fs0 = html.indexOf('<footer');
  const fe = html.indexOf('</footer>', fs0);
  if (fs0 >= 0 && fe > fs0) {
    const pre = inGuides ? '../' : '';
    const block = FOOTER
      .replace('@ICON@', pre + 'assets/icon-32.png')
      .replace('@DL@', inGuides ? '../#download' : '#download')
      .replace('@FT@', inGuides ? '../#features' : '#features')
      .replace('@WN@', inGuides ? '../#whatsnew' : '#whatsnew')
      .replace('@PV@', inGuides ? '../#privacy' : '#privacy')
      .replace('@DV@', inGuides ? '../#dev' : '#dev')
      .replace('@BR@', pre + 'bridge.html')
      .replace('@PP@', pre + 'PRIVACY.html')
      .replace('@LC@', pre + 'LICENSE.txt');
    if (html.slice(fs0, fe + 9) !== block) {
      html = html.slice(0, fs0) + block + html.slice(fe + 9);
      notes.push('التذييل');
    }
  }

  // (٢) شارة المستودع: أيقونة فقط
  const badgeStart = html.indexOf('href="https://github.com/SMSMy/HaramLite" target="_blank" rel="noopener"');
  if (badgeStart >= 0) {
    const aStart = html.lastIndexOf('<a ', badgeStart);
    const aEnd = html.indexOf('</a>', badgeStart);
    if (aStart >= 0 && aEnd > aStart) {
      const inner = html.slice(aStart, aEnd);
      const stripped = inner.replace(/<span data-i18n-ar="الكود المصدري"[\s\S]*?<\/span>/, '');
      if (stripped !== inner) {
        html = html.slice(0, aStart) + stripped + html.slice(aEnd);
        notes.push('الشارة أيقونية');
      }
    }
  }

  // (٣) زرّ التحميل في الشريط الأعلى: أيقونة تنزيل فقط
  const cta = html.indexOf('data-i18n-ar="تحميل التطبيق"');
  if (cta >= 0) {
    const aStart = html.lastIndexOf('<a ', cta);
    const aEnd = html.indexOf('</a>', cta);
    if (aStart >= 0 && aEnd > aStart) {
      const inner = html.slice(aStart, aEnd);
      const newInner = inner
        .replace(/<span data-i18n-ar="تحميل التطبيق"[\s\S]*?<\/span>/, '<span class="material-symbols-outlined text-[20px]" aria-hidden="true">download</span>')
        .replace(/<a class="hidden sm:inline-flex/, '<a class="inline-flex')
        .replace(/px-stack-md py-unit/, 'p-unit')
        .replace('href="#download"', 'href="#download" aria-label="تحميل التطبيق" title="تحميل التطبيق"');
      if (newInner !== inner) {
        html = html.slice(0, aStart) + newInner + html.slice(aEnd);
        notes.push('زرّ التنزيل أيقوني');
      }
    }
  }

  if (html !== before) {
    if (!checkOnly) fs.writeFileSync(file, html);
    report.push([rel, notes.join(' + ')]);
  }
}

console.log(checkOnly ? '  (وضع التحقّق — لا كتابة)' : '  عُدّلت:');
for (const [f, n] of report) console.log(`    ${f.padEnd(46)} ${n}`);
console.log(`  المجموع: ${report.length} من ${files.length}`);
