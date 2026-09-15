/* تحديث الموقع إلى 0.2.5 — سكربت لمرّة واحدة مثل سابقيه (‏site-version-0.2.4.cjs).
   القاعدة الموروثة من 0.2.4: كل استبدال يُعَدّ، وإن لم يجد السكربت ما يتوقّعه **يفشل بصوت عالٍ**
   بدل أن يمرّ صامتاً (وهو ما حدث في 0.2.4 حين أخطأ `String.replace` موضعاً فبقي شارة قديمة). */
const fs = require('fs');
const path = require('path');

const docs = path.resolve(__dirname, '..', 'docs');
const V = '0.2.5';
const OLD = '0.2.4';
const EXE = `HaramLite_${V}_x64-setup.exe`;
const MSI = `HaramLite_${V}_x64_en-US.msi`;
/* المقاسات المقيسة على بناء الإصدار (‏pnpm tauri build بنفس الكود والأدوات):
   188.0 MB للـsetup و371.4 MB للـmsi. تُراجَع من الأصول المنشورة بعد الرفع. */
const EXE_SIZE = '188.0 MB';
const MSI_SIZE = '371.4 MB';

let failures = [];
function must(label, cond) {
  if (!cond) failures.push(label);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
}
function replaceAll(file, from, to, expectAtLeast = 1) {
  const p = path.join(docs, file);
  let t = fs.readFileSync(p, 'utf8');
  const n = t.split(from).length - 1;
  if (n < expectAtLeast) { failures.push(`${file}: «${from}» وُجد ${n} مرة (المتوقّع ≥ ${expectAtLeast})`); return; }
  t = t.split(from).join(to);
  fs.writeFileSync(p, t);
  console.log(`  ${file}: ${n}× «${from.slice(0, 46)}…» ⟶ «${to.slice(0, 46)}…»`);
}

// ── ١) قسم «الجديد» كاملاً ────────────────────────────────────────────────
const SECTION = `<!-- 6. WHAT'S NEW IN ${V} (#whatsnew) -->
<section class="max-w-7xl mx-auto px-margin-mobile lg:px-margin-desktop mb-24 scroll-mt-20" id="whatsnew">
<div class="bg-surface-container-high rounded-xl p-stack-lg sm:p-12 shadow-lg">
<div class="flex flex-col md:flex-row md:items-center justify-between gap-stack-md mb-8 pb-stack-md border-b border-border-muted">
<div>
<div class="inline-flex items-center gap-stack-sm px-stack-sm py-0.5 rounded bg-clay-accent/15 text-clay-accent font-mono-code text-mono-code font-bold mb-2">
سجل التغييرات • الإصدار <span class="js-version-text">${V}</span>
</div>
<h2 class="font-headline-xl text-headline-xl text-cream-text" data-i18n-ar="الجديد في إصدار {v}" data-i18n-en="What&#39;s New in v{v}">الجديد في إصدار ${V}</h2>
</div>
<a class="inline-flex items-center gap-stack-sm font-label-md text-label-md text-clay-accent hover:underline" href="https://github.com/SMSMy/HaramLite/releases/tag/v${V}" rel="noreferrer" target="_blank">
<span data-i18n-ar="عرض تقرير الإصدار في GitHub" data-i18n-en="View release on GitHub">عرض تقرير الإصدار في GitHub</span>
<span class="material-symbols-outlined text-[16px]">arrow_outward</span>
</a>
</div>
<div class="grid grid-cols-1 lg:grid-cols-2 gap-stack-lg">

<div class="space-y-stack-sm">
<div class="flex items-center gap-stack-sm text-cream-text font-bold font-label-md text-label-md">
<span class="material-symbols-outlined text-clay-accent">movie</span>
<span data-i18n-ar="المحرّك صار بناءً متوافقاً مع LGPLv3" data-i18n-en="The media engine is now an LGPLv3 build">المحرّك صار بناءً متوافقاً مع LGPLv3</span>
</div>
<p class="font-body-md text-body-md text-on-surface-variant leading-relaxed" data-i18n-ar="لم يبقَ في الكود أي اعتماد على مكتبة بترخيص GPL، فصار المثبّت أصغر: 220.2 ⟶ 188.0 ميجابايت للمثبّت الذكي، و431.2 ⟶ 371.4 للملف MSI." data-i18n-en="No GPL-licensed library remains in the code, and the installer got smaller: 220.2 &rarr; 188.0 MB for the setup and 431.2 &rarr; 371.4 MB for the MSI.">لم يبقَ في الكود أي اعتماد على مكتبة بترخيص GPL، فصار المثبّت أصغر: 220.2 ⟶ 188.0 ميجابايت للمثبّت الذكي، و431.2 ⟶ 371.4 للملف MSI.</p>
</div>

<div class="space-y-stack-sm">
<div class="flex items-center gap-stack-sm text-cream-text font-bold font-label-md text-label-md">
<span class="material-symbols-outlined text-clay-accent">bolt</span>
<span data-i18n-ar="الجودة أولاً: المُرمِّز الجديد مكافئ أو أفضل" data-i18n-en="Quality first: the new encoder matches or beats the old one">الجودة أولاً: المُرمِّز الجديد مكافئ أو أفضل</span>
</div>
<p class="font-body-md text-body-md text-on-surface-variant leading-relaxed" data-i18n-ar="قيس على ثلاثة محتويات حقيقية: الجودة مكافئة أو أفضل قليلاً، لكن حجم الملف قد يكبر على محتوى معيّن — والاختيار كان الجودة على الحجم." data-i18n-en="Measured on three real clips: quality matches or is slightly better, while the output file may grow on some content — quality was chosen over size.">قيس على ثلاثة محتويات حقيقية: الجودة مكافئة أو أفضل قليلاً، لكن حجم الملف قد يكبر على محتوى معيّن — والاختيار كان الجودة على الحجم.</p>
</div>

<div class="space-y-stack-sm">
<div class="flex items-center gap-stack-sm text-cream-text font-bold font-label-md text-label-md">
<span class="material-symbols-outlined text-clay-accent">download</span>
<span data-i18n-ar="زرّ التحقق من التحديثات عاد — ويعمل" data-i18n-en="The update check button is back, and it works">زرّ التحقق من التحديثات عاد — ويعمل</span>
</div>
<p class="font-body-md text-body-md text-on-surface-variant leading-relaxed" data-i18n-ar="من الإعدادات: يقرأ آخر إصدار منشور ويخبرك إن كان أحدث، ويفتح صفحة التنزيل. وكل مسار فشل له رسالة واضحة، بلا زرّ يفشل بصمت." data-i18n-en="From Settings: it reads the latest published version, tells you if one is newer, and opens the download page. Every failure path shows a clear message.">من الإعدادات: يقرأ آخر إصدار منشور ويخبرك إن كان أحدث، ويفتح صفحة التنزيل. وكل مسار فشل له رسالة واضحة، بلا زرّ يفشل بصمت.</p>
</div>

<div class="space-y-stack-sm">
<div class="flex items-center gap-stack-sm text-cream-text font-bold font-label-md text-label-md">
<span class="material-symbols-outlined text-clay-accent">graphic_eq</span>
<span data-i18n-ar="قائمة إعدادات أوضح: معتمة وبلا رموز تعبيرية" data-i18n-en="A clearer settings menu: opaque, no emoji">قائمة إعدادات أوضح: معتمة وبلا رموز تعبيرية</span>
</div>
<p class="font-body-md text-body-md text-on-surface-variant leading-relaxed" data-i18n-ar="كانت زجاجية فيظهر ما خلفها تحت النصوص؛ صارت معتمة مع إبقاء الإطار والظل، وأُزيلت الرموز التعبيرية وحلّت محلها أيقونات موحّدة." data-i18n-en="It used to be glassy, letting content show through the labels; it is now opaque with the border and shadow kept, and the emoji are replaced by consistent icons.">كانت زجاجية فيظهر ما خلفها تحت النصوص؛ صارت معتمة مع إبقاء الإطار والظل، وأُزيلت الرموز التعبيرية وحلّت محلها أيقونات موحّدة.</p>
</div>

<div class="space-y-stack-sm">
<div class="flex items-center gap-stack-sm text-cream-text font-bold font-label-md text-label-md">
<span class="material-symbols-outlined text-clay-accent">check_circle</span>
<span data-i18n-ar="أول تشغيل لم يكن متجمّداً — بل كان ترتيباً خاطئاً في الملف" data-i18n-en="The frozen first play was a file-layout problem">أول تشغيل لم يكن متجمّداً — بل كان ترتيباً خاطئاً في الملف</span>
</div>
<p class="font-body-md text-body-md text-on-surface-variant leading-relaxed" data-i18n-ar="كان فهرس الملف في آخره، فالمشغّل الذي يقرأ تدريجياً (تيليجرام أو المتصفح) لا يبدأ حتى يكتمل التنزيل. الآن الفهرس في المقدمة." data-i18n-en="The file index sat at the end, so a progressively-reading player (Telegram, a browser) could not start until the download finished. The index now comes first.">كان فهرس الملف في آخره، فالمشغّل الذي يقرأ تدريجياً (تيليجرام أو المتصفح) لا يبدأ حتى يكتمل التنزيل. الآن الفهرس في المقدمة.</p>
</div>

<div class="space-y-stack-sm">
<div class="flex items-center gap-stack-sm text-cream-text font-bold font-label-md text-label-md">
<span class="material-symbols-outlined text-clay-accent">build</span>
<span data-i18n-ar="صيانة: تبعيات منظّمة وتنظيف بلا تغيير سلوك" data-i18n-en="Maintenance: tidier dependencies, behaviour-preserving cleanup">صيانة: تبعيات منظّمة وتنظيف بلا تغيير سلوك</span>
</div>
<p class="font-body-md text-body-md text-on-surface-variant leading-relaxed" data-i18n-ar="سياسة تحديث التبعيات أُحكمت (طلب واحد للدنيا والرقعة لكل نظام، وتجاهل الترقيات الكبرى)، ونُظّفت تحذيرات التحليل الساكن مع توثيق كل استثناء بسببه." data-i18n-en="The dependency policy is tighter (one minor/patch PR per ecosystem, majors ignored), and the static-analysis warnings were cleaned with every exception documented.">سياسة تحديث التبعيات أُحكمت (طلب واحد للدنيا والرقعة لكل نظام، وتجاهل الترقيات الكبرى)، ونُظّفت تحذيرات التحليل الساكن مع توثيق كل استثناء بسببه.</p>
</div>

</div>
</div>
</section>

`;
{
  const p = path.join(docs, 'index.html');
  let t = fs.readFileSync(p, 'utf8');
  const s = t.indexOf("<!-- 6. WHAT'S NEW");
  const e = t.indexOf('<!-- 7. STRICT');
  must('قسم «الجديد»: العلامتان موجودتان', s >= 0 && e > s);
  if (s >= 0 && e > s) {
    t = t.slice(0, s) + SECTION + t.slice(e);
    fs.writeFileSync(p, t);
    console.log(`  index.html: قُطِع القسم القديم (${e - s} حرفاً) واستُبدل بقسم ${V}`);
  }
}

// ── ٢) أرقام الإصدار في كل موضع ───────────────────────────────────────────
console.log('\n=== أرقام الإصدار ===');
replaceAll('index.html', `"softwareVersion": "${OLD}"`, `"softwareVersion": "${V}"`);
replaceAll('index.html', `version: '${OLD}'`, `version: '${V}'`);
replaceAll('index.html', `tag: 'v${OLD}'`, `tag: 'v${V}'`);
replaceAll('index.html', `releases/download/v${OLD}/HaramLite_${OLD}_x64-setup.exe`, `releases/download/v${V}/${EXE}`, 2);
replaceAll('index.html', `releases/download/v${OLD}/HaramLite_${OLD}_x64_en-US.msi`, `releases/download/v${V}/${MSI}`, 2);
replaceAll('index.html', `js-release-tag">v${OLD}<`, `js-release-tag">v${V}<`);
replaceAll('index.html', `<span class="js-version-text">${OLD}</span>`, `<span class="js-version-text">${V}</span>`, 3);
replaceAll('index.html', `تحميل المثبّت الذكي (${OLD})`, `تحميل المثبّت الذكي (${V})`, 1);
replaceAll('index.html', `التحديث في الإصدار ${OLD}`, `التحديث في الإصدار ${V}`, 1);
replaceAll('index.html', `في الإصدار ${OLD} نظراً`, `في الإصدار ${V} نظراً`, 2);
replaceAll('index.html', `paused in ${OLD} due`, `paused in ${V} due`, 1);
replaceAll('bridge.html', `(${OLD})`, `(${V})`, 3);
replaceAll('assets/lang.js', `return '${OLD}';`, `return '${V}';`);

// ── ٣) المقاسات المنشورة ──────────────────────────────────────────────────
console.log('\n=== المقاسات (تُراجَع من الأصول المنشورة بعد الرفع) ===');
{
  const p = path.join(docs, 'index.html');
  let t = fs.readFileSync(p, 'utf8');
  const before = t;
  t = t.replace(/<span class="js-exe-size[^>]*>\s*[\d.]+ MB\s*<\/span>/, `<span class="js-exe-size block text-clay-accent font-mono-code text-mono-code">${EXE_SIZE}</span>`);
  t = t.replace(/<span class="js-msi-size[^>]*>\s*[\d.]+ MB\s*<\/span>/, `<span class="js-msi-size block text-clay-accent font-mono-code text-mono-code">${MSI_SIZE}</span>`);
  must('كُتب حجم الـsetup', t !== before && t.includes(EXE_SIZE));
  must('كُتب حجم الـmsi', t.includes(MSI_SIZE));
  fs.writeFileSync(p, t);
  console.log(`  index.html: الحجم ⟶ ${EXE_SIZE} / ${MSI_SIZE}`);
}

// ── ٤) الأيقونات المستعملة يجب أن تكون في القائمة المُلتزمة ────────────────
console.log('\n=== حراسة الأيقونات (نفس حارس الموقع) ===');
{
  const subsetPath = path.join(docs, 'assets', 'icons-subset.txt');
  const subset = fs.readFileSync(subsetPath, 'utf8');
  const idx = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
  const used = new Set([...idx.matchAll(/material-symbols-outlined[^>]*>\s*([a-z_0-9]+)\s*</g)].map((m) => m[1]));
  for (const icon of used) must(`الأيقونة «${icon}» موجودة في القائمة`, subset.includes(icon));
}

console.log('');
if (failures.length) {
  console.error(`✗ فشل ${failures.length} فحصاً:`);
  failures.forEach((f) => console.error(`   - ${f}`));
  process.exit(1);
}
console.log(`✓ الموقع محدَّث إلى ${V} وكل الفحوص خضراء.`);
