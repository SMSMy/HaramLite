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
 *
 * عقد الخروج (كان غائباً: كان `--check` يعلن انحراف عشرين صفحة ثم يخرج 0):
 *   0 = لا انحراف (وفي وضع الكتابة: كل ما كُتب استقرّ) — 1 = انحراف/عيب بنيوي
 *   — 2 = استعمال خاطئ.
 *
 * وثلاث ضمانات تُنفَّذ هنا لا تُوعَد:
 *   • **لا تحذف الكتابة شيئاً**: كل رابط في التذييل القائم وكل سمةٍ عليه يجب أن
 *     تبقى في الكتلة الجديدة؛ أي فقد ⇒ رفض الكتابة وفشل صارخ (كان القالب بلا
 *     رابط TRANSPARENCY.html فكان يمحوه من ١٩ صفحة، وينزع noopener من عشرين).
 *   • **كتابة تكراريّة**: بعد كل كتابة يُعاد التمرير في الذاكرة ويُشترط ألّا
 *     يغيّر شيئاً (كان `aria-label` ينمو ١→٢→٣ مع كل تشغيل).
 *   • **فشل بصوت عالٍ**: صفر صفحات · عنصر مفقود · بنية غير صالحة — كلها تفشل.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const docs = path.join(root, 'docs');
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
for (const a of argv) {
  if (a !== '--check') {
    console.error(`unknown option: ${a}\nusage: node scripts/site-footer-and-icon-buttons.cjs [--check]`);
    process.exit(2);
  }
}

const LINK = 'class="font-label-sm text-label-sm text-on-surface-variant hover:text-cream-text transition-colors"';
const HEAD = 'class="font-label-sm text-label-sm uppercase tracking-widest text-clay-accent font-bold mb-1"';

// ── التذييل الجديد ────────────────────────────────────────────────────────
// ‏@HOME_REL@ يُملأ من الصفحة نفسها (رموز rel التي تحملها فعلاً) حتى لا ينزع
// القالب رمزاً أضافته الصفحة؛ والافتراضي في القالب `noreferrer`.
const FOOTER = `<footer class="w-full bg-surface-container-lowest border-t border-border-muted py-stack-lg">
<div class="max-w-7xl mx-auto px-margin-mobile lg:px-margin-desktop grid gap-stack-lg sm:grid-cols-3 items-start text-center sm:text-start">
<div class="flex flex-col items-center sm:items-start gap-stack-sm">
<div class="flex items-center gap-stack-sm"><img src="@ICON@" alt="" width="20" height="20" class="w-5 h-5 rounded-sm"><span class="font-serif font-bold text-sm tracking-wide text-cream-text">Haram<span class="text-clay italic">Lite</span></span></div>
<p class="font-mono-code text-mono-code text-on-surface-variant"><span data-i18n-ar="الملهِم الأول:" data-i18n-en="First inspiration:">الملهِم الأول:</span> <a class="text-clay-accent hover:underline" href="https://github.com/alganzory" rel="@HOME_REL@" target="_blank" title="HaramMute — المشروع الأصلي (بايثون)" data-i18n-ar="مشروع HaramMute" data-i18n-en="the HaramMute project">مشروع HaramMute</a></p>
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
<a ${LINK} href="@TR@" data-i18n-ar="الشفافية" data-i18n-en="Transparency">الشفافية</a>
<a ${LINK} href="@LC@" data-i18n-ar="الرخصة" data-i18n-en="License">الرخصة</a>
<a ${LINK} href="https://github.com/SMSMy/HaramLite/issues/new" data-i18n-ar="هل واجهت مشكلة أو لديك اقتراح؟" data-i18n-en="Found a problem or have a suggestion?">هل واجهت مشكلة أو لديك اقتراح؟</a>
</nav>
</div>
<div class="max-w-7xl mx-auto px-margin-mobile lg:px-margin-desktop mt-stack-md pt-stack-md border-t border-border-muted text-center font-label-sm text-label-sm text-on-surface-variant" data-i18n-ar="صُنع بحبٍّ ليخدم كل من أراد محتواه خاليًا من الموسيقى — وكل شيء هنا مفتوح المصدر، ويمكنك استخدامه وتطويره بحرية." data-i18n-en="Made with care for anyone who wants their content clean — and everything here is open source, free to use and build on.">صُنع بحبٍّ ليخدم كل من أراد محتواه خاليًا من الموسيقى — وكل شيء هنا مفتوح المصدر، ويمكنك استخدامه وتطويره بحرية.</div>
</footer>`;

const BADGE_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

/* ملفات `.html` في docs/ ليست كلها صفحات موقع: هذا ملف تحقّق ملكية لجوجل
   (سطر نصّي واحد بلا أي وسم). يُستثنى بالاسم — وأي ملف آخر لا يحمل `<html`
   يُعدّ بنية غير صالحة فيُفشل الحارس (لا يُتجاهل بصمت). */
const NON_PAGE = new Set(['google30b5f3c41dd37016.html']);

const problems = []; // عيوب بنيوية: تُفشل الحارس في الوضعين
const report = []; // صفحات انحرفت (كُتبت، أو كانت ستُكتب في --check)

function listHtml(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => path.join(dir, f));
}

/** سمات كل <a> في نصّ: [{href, attrs}] — مسح بنيوي لا indexOf. */
function anchorsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<a\s([^>]*)>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g)) {
      attrs[a[1].toLowerCase()] = a[2];
    }
    out.push({ href: attrs.href, attrs });
  }
  return out;
}

/** رموز rel التي تحملها الصفحة فعلاً على رابط المشروع الأصلي (لا تُحذف). */
function homeRelTokens(html) {
  const tokens = new Set();
  for (const a of anchorsOf(html)) {
    if (a.href !== 'https://github.com/alganzory') continue;
    for (const t of String(a.attrs.rel || '').split(/\s+/)) if (t) tokens.add(t);
  }
  return tokens;
}

/** ما الذي ستفقده الكتلة الجديدة من التذييل القائم؟ (رابط أو سمة) */
function lossesIn(oldFooter, newBlock) {
  const lost = [];
  const next = anchorsOf(newBlock);
  for (const a of anchorsOf(oldFooter)) {
    if (!a.href) continue;
    const same = next.find((n) => n.href === a.href);
    if (!same) {
      lost.push(`الرابط ${a.href}`);
      continue;
    }
    for (const [k, v] of Object.entries(a.attrs)) {
      if (same.attrs[k] !== v) lost.push(`السمة ${k}="${v}" على ${a.href}`);
    }
  }
  return lost;
}

/** التمرير الوحيد: نصّ الصفحة ⇒ نصّها بعد التعديل + ما تغيّر. */
function transform(html, rel) {
  const inGuides = rel.includes('/guides/');
  const pre = inGuides ? '../' : '';
  const notes = [];
  let out = html;

  // (١) التذييل: استبدال الكتلة كاملة (متماثلة في كل الصفحات)
  const fs0 = out.indexOf('<footer');
  const fe = out.indexOf('</footer>', fs0);
  if (fs0 < 0 || fe < fs0) {
    return { html: out, notes, missingFooter: fs0 < 0, brokenFooter: fs0 >= 0 };
  }
  const oldFooter = out.slice(fs0, fe + 9);
  const homeRel = [...homeRelTokens(oldFooter)].reduce(
    (acc, t) => (acc.includes(t) ? acc : acc + ' ' + t),
    'noreferrer',
  );
  const block = FOOTER
    .replace('@ICON@', pre + 'assets/icon-32.png')
    .replace('@DL@', inGuides ? '../#download' : '#download')
    .replace('@FT@', inGuides ? '../#features' : '#features')
    .replace('@WN@', inGuides ? '../#whatsnew' : '#whatsnew')
    .replace('@PV@', inGuides ? '../#privacy' : '#privacy')
    .replace('@DV@', inGuides ? '../#dev' : '#dev')
    .replace('@BR@', pre + 'bridge.html')
    .replace('@PP@', pre + 'PRIVACY.html')
    .replace('@TR@', pre + 'TRANSPARENCY.html')
    .replace('@LC@', pre + 'LICENSE.txt')
    .replace('@HOME_REL@', homeRel);
  const lost = lossesIn(oldFooter, block);
  if (lost.length) {
    return { html: out, notes, lost };
  }
  if (oldFooter !== block) {
    out = out.slice(0, fs0) + block + out.slice(fe + 9);
    notes.push('التذييل');
  }

  // (٢) شارة المستودع: أيقونة فقط
  const badgeStart = out.indexOf('href="https://github.com/SMSMy/HaramLite" target="_blank" rel="noopener"');
  if (badgeStart >= 0) {
    const aStart = out.lastIndexOf('<a ', badgeStart);
    const aEnd = out.indexOf('</a>', badgeStart);
    if (aStart >= 0 && aEnd > aStart) {
      const inner = out.slice(aStart, aEnd);
      const stripped = inner.replace(/<span data-i18n-ar="الكود المصدري"[\s\S]*?<\/span>/, '');
      if (stripped !== inner) {
        out = out.slice(0, aStart) + stripped + out.slice(aEnd);
        notes.push('الشارة أيقونية');
      }
    }
  }

  // (٣) زرّ التحميل في الشريط الأعلى: أيقونة تنزيل فقط.
  // ‏aria-label/title يُضافان مرّة واحدة فقط: كان `.replace('href="#download"')`
  // يطابق دائماً فيضيف زوجاً جديداً كل تشغيل (1→2→3→4).
  const cta = out.indexOf('data-i18n-ar="تحميل التطبيق"');
  if (cta >= 0) {
    const aStart = out.lastIndexOf('<a ', cta);
    const aEnd = out.indexOf('</a>', cta);
    if (aStart >= 0 && aEnd > aStart) {
      const inner = out.slice(aStart, aEnd);
      let newInner = inner
        .replace(/<span data-i18n-ar="تحميل التطبيق"[\s\S]*?<\/span>/, '<span class="material-symbols-outlined text-[20px]" aria-hidden="true">download</span>')
        .replace(/<a class="hidden sm:inline-flex/, '<a class="inline-flex')
        .replace(/px-stack-md py-unit/, 'p-unit');
      if (!/\saria-label\s*=/.test(newInner)) {
        newInner = newInner.replace('href="#download"', 'href="#download" aria-label="تحميل التطبيق" title="تحميل التطبيق"');
      } else if (!/\stitle\s*=/.test(newInner)) {
        newInner = newInner.replace('href="#download"', 'href="#download" title="تحميل التطبيق"');
      }
      if (newInner !== inner) {
        out = out.slice(0, aStart) + newInner + out.slice(aEnd);
        notes.push('زرّ التنزيل أيقوني');
      }
    }
  }
  return { html: out, notes };
}

const files = [...listHtml(docs), ...listHtml(path.join(docs, 'guides'))];
if (files.length === 0) {
  console.error(`  ✗ صفر صفحات: لا ملفات .html في ${path.relative(root, docs)} — حارس لا يرى ليس حارساً`);
  process.exit(1);
}

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const base = path.basename(file);
  const html = fs.readFileSync(file, 'utf8');

  if (!/<html[\s>]/i.test(html)) {
    if (!NON_PAGE.has(base)) {
      problems.push(`${rel}: بنية غير صالحة — لا <html> في الملف (وليس في قائمة الاستثناء)`);
    }
    continue;
  }

  const first = transform(html, rel);
  if (first.missingFooter) {
    problems.push(`${rel}: عنصر مفقود — لا <footer> في الصفحة`);
    continue;
  }
  if (first.brokenFooter) {
    problems.push(`${rel}: بنية غير صالحة — <footer> بلا </footer>`);
    continue;
  }
  if (first.lost) {
    problems.push(
      `${rel}: الكتابة كانت ستحذف من التذييل: ${first.lost.join(' · ')} — رُفضت الكتابة`,
    );
    continue;
  }
  if (first.html === html) continue;

  // ضمان التكراريّة: تمريرة ثانية على الناتج يجب ألّا تغيّر شيئاً.
  const second = transform(first.html, rel);
  if (second.html !== first.html) {
    problems.push(`${rel}: الكتابة غير تكراريّة — تمريرة ثانية تُغيّر: ${second.notes.join(' + ') || 'بلا ملاحظة'}`);
    continue;
  }

  if (!checkOnly) fs.writeFileSync(file, first.html);
  report.push([rel, first.notes.join(' + ')]);
}

console.log(checkOnly ? '  (وضع التحقّق — لا كتابة)' : '  عُدّلت:');
for (const [f, n] of report) console.log(`    ${f.padEnd(46)} ${n}`);
console.log(`  المجموع: ${report.length} من ${files.length}`);

if (problems.length) {
  console.error(`  ✗ ${problems.length} عيباً بنيوياً:`);
  for (const p of problems) console.error(`     - ${p}`);
  process.exit(1);
}
if (checkOnly && report.length) {
  console.error(`  ✗ ${report.length} من ${files.length} صفحة منحرفة عن القالب — أعِد التشغيل بلا --check للكتابة`);
  process.exit(1);
}
process.exit(0);
