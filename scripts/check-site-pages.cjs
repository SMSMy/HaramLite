#!/usr/bin/env node
/* حارس إضافي لصفحات الموقع: العنوان والوصف والأيقونة والروابط الميتة.
   السبب: أربع عشرة صفحة دليل نُشرت بلا <title> ولا description بعد استبدال
   التصاميم، ولم يكتشف ذلك فحصي (كان يفحص canonical و lang فقط) بل تقرير خارجي.
   ويُشغَّل مع حارس CSS:  pnpm site:check */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const guidesDir = path.join(root, 'docs/guides');
const guides = fs.readdirSync(guidesDir).filter(f => f.endsWith('.html'));
const rootPages = ['docs/index.html', 'docs/bridge.html', 'docs/PRIVACY.html', 'docs/bridge-privacy.html', 'docs/404.html'];
const fails = [];
const ok = [];

function check(rel, { title = true, desc = true, icon = true, canonical = true, anchors = true } = {}) {
  const t = fs.readFileSync(path.join(root, rel), 'utf8');
  const name = path.basename(rel);
  // اسم مميّز يمنع خلط تقارير الصفحات المتشابهة الأسماء (index.html في مجلدين)
  const label = path.relative(path.join(root, 'docs'), path.join(root, rel)).replace(/\\/g, '/');
  if (title && !/<title>[^<]{5,}<\/title>/i.test(t)) fails.push(label + ': بلا <title>');
  if (desc && !/name="description"[^>]*content="[^"]{10,}"/i.test(t) && !/content="[^"]{10,}"[^>]*name="description"/i.test(t)) fails.push(label + ': بلا meta description');
  if (icon && !/rel="icon"/i.test(t)) fails.push(label + ': بلا أيقونة مفضّلة');
  if (canonical && !/rel="canonical"/i.test(t)) fails.push(label + ': بلا canonical');
  if (/href="#"/.test(t)) fails.push(label + ': رابط ميت href="#"');

  // سمة مكرّرة أو ملتصقة: class="class="…"" يُهملها المتصفح فيختفي التنسيق كاملاً.
  // (سبب الإضافة: تحويل بطاقات الفهرس من div إلى a أنتج class مزدوجاً، ومرّ من كل
  //  الحراس لأن توازن الوسوم والروابط لا يتأثران به، ولم يظهر إلا في صورة المستخدم.)
  for (const bad of [/class="\s*class=/g, /href="\s*href=/g, /class="[^"]*""/g, /id="\s*id=/g]) {
    const m = t.match(bad);
    if (m) fails.push(label + ': سمة مكرّرة أو مكسورة → ' + m[0].slice(0, 40));
  }
  // عنصر بمظهر بطاقة قابل للنقر بلا أي تنقّل: onclick وحده لا ينقل الزائر.
  // يُستثنى ما له href، وما هو زر فلترة/بحث/إغلاق مقصود.
  for (const m of t.matchAll(/<(div|span|section|article)\b[^>]*\bonclick="([^"]{0,120})"[^>]*>/g)) {
    const tag = m[0];
    const code = m[2];
    const navigates = /location\.href|window\.open|\.submit\(/.test(code);
    const isControl = /setCategory|filterGuides|clearSearch|closeGuideModal|toggle|openModal|showTab|selectTab/i.test(code);
    if (!navigates && !isControl && !/href=/.test(tag)) {
      fails.push(label + ': عنصر قابل للنقر بلا تنقّل → onclick="' + code.slice(0, 50) + '"');
    }
  }
  // روابط داخلية مكسورة
  for (const m of t.matchAll(/href="([^"#:][^"]*)"/g)) {
    const href = m[1].split('#')[0];
    if (!href || /^(https?:|mailto:)/.test(href)) continue;
    const target = href.startsWith('/') ? path.join(root, 'docs', href) : path.join(path.dirname(path.join(root, rel)), href);
    if (!fs.existsSync(target)) fails.push(label + ': رابط مكسور → ' + m[1]);
  }
  // مراسي داخلية موجودة
  if (anchors) {
    for (const m of t.matchAll(/href="#([a-zA-Z][\w-]*)"/g)) {
      if (!t.includes('id="' + m[1] + '"')) fails.push(label + ': مرساة غير موجودة → #' + m[1]);
    }
  }
  if (!fails.some(f => f.startsWith(label))) ok.push(label);
}

for (const f of guides) check('docs/guides/' + f);
for (const p of rootPages) check(p, { canonical: p !== 'docs/404.html' });
/* صفحة الجذر تُرمَز إلى / ⇒ لا مراسي داخلية فيها (href="#x" يشير إلى صفحة أخرى) */
check('docs/index.html', { anchors: false });

// sitemap: كل صفحة عامة مذكورة
const sm = fs.readFileSync(path.join(root, 'docs/sitemap.xml'), 'utf8');
for (const f of guides) {
  if (f === 'index.html') { if (!sm.includes('/guides/')) fails.push('sitemap: ينقص /guides/'); continue; }
  if (!sm.includes(f)) fails.push('sitemap: ينقص ' + f);
}
// الاستثناءات: ملفات داخلية لا تُنشر
const cfg = fs.readFileSync(path.join(root, 'docs/_config.yml'), 'utf8');
for (const internal of ['AUDIT.md', 'STORE.md', 'SITE.md', 'CONTRIBUTING.md']) {
  if (!cfg.includes(internal)) fails.push('_config.yml: لا يستثني ' + internal);
}

console.log('  حارس الصفحات: ' + ok.length + ' صفحة سليمة');
if (fails.length) {
  console.error('  ✗ فشل الحارس (' + fails.length + '):');
  [...new Set(fails)].forEach(f => console.error('     - ' + f));
  process.exit(1);
}
console.log('  ✓ العناوين والأوصاف والأيقونات والروابط والمراسي سليمة');
