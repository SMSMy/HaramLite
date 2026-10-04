#!/usr/bin/env node
/* حارس استثناءات وثائق النشر (م٠ · خطة 0.3.0 — بند ز2)
 *
 * **العلّة المقيسة**: قائمة `exclude` في `docs/_config.yml` توقفت عند
 * `RELEASE-0.2.8.md` — فالوثائق الداخلية المضافة بعدها (`RELEASE-0.2.9.md`
 * و`PLAN-*` و`EXT-*` و`THREAT-MODEL.md` و`REVIEW-AREAS.md`) كانت ستُخدم
 * على haramlite.com كما هي، لا يحميها شيء.
 *
 * **ما يقيسه**: كل ملف `docs/*.md` **متتبَّع** يجب أن يكون إما مستثنى في
 * `docs/_config.yml` (فلا يُنسخ إلى `_site`) أو مُدرجا صراحة في `PUBLISHED`
 * أدناه (وثيقة قرر المالك نشرها على الموقع). أي ملف يدخل `docs/` بلا قرار
 * ⇒ يسقط الحارس حتى يُحسم موقعه، فلا يتكرر ثقب `RELEASE-0.2.9`.
 *
 * **حدود معلنة**: يقيس ملفات `*.md` حصراً (صفحات الموقع HTML لها حراسها في
 * `site:check`)، ولا يقيس سلوك بناء Jekyll نفسه — النشر الفعلي يُقاس بـ
 * `pages build and deployment` على GitHub. وتحليل `exclude` هنا يقرأ قائمة
 * YAML المسطّحة في `_config.yml` (عناصر `- item`) لا محلّلاً YAML كاملاً —
 * كافٍ لشكل الملف، وينهار بصوت عالٍ إن تغيّر الشكل.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** وثائق مُخدَمة على الموقع عمداً — كل إدخال هنا قرار مُعلَن لا سهواً.
 *  اليوم: صفر — كل docs/*.md المتتبعة وثائق داخلية. */
const PUBLISHED = [];

/** يقرأ عناصر قائمة `exclude:` من _config.yml (سطور `- item` حتى نهاية الكتلة). */
function readExcludeEntries(configPath) {
  const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
  const out = [];
  let inExclude = false;
  for (const line of lines) {
    if (/^exclude:\s*$/.test(line)) {
      inExclude = true;
      continue;
    }
    if (!inExclude) continue;
    if (line.trim() === '') continue;
    const item = line.match(/^\s+-\s*(.+?)\s*$/);
    if (item) {
      out.push(item[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    break; // أول سطر خارج القائمة ⇒ انتهت الكتلة
  }
  return out;
}

/** مطابقة نمط Jekyll المبسّط: `*` أي تسلسل بلا `/` داخل المسار النسبي. */
function patternMatches(pattern, rel) {
  if (pattern === rel) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$',
  );
  return re.test(rel);
}

let tracked = [];
try {
  tracked = execSync('git ls-files -- docs/', { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((f) => f.endsWith('.md'));
} catch (e) {
  console.error('check-docs-exclusions: git ls-files فشل: ' + e.message);
  process.exit(2);
}
if (tracked.length === 0) {
  console.error('check-docs-exclusions: صفر ملفات docs/*.md متتبعة — «صفر مدخل ليس نجاحاً»');
  process.exit(2);
}

const excludes = readExcludeEntries(path.join('docs', '_config.yml'));
if (excludes.length === 0) {
  console.error('check-docs-exclusions: قائمة exclude فارغة أو غير مقروءة في docs/_config.yml');
  process.exit(2);
}

const unaccounted = tracked
  .map((f) => f.replace(/^docs\//, ''))
  .filter((rel) => !excludes.some((pat) => patternMatches(pat, rel)) && !PUBLISHED.includes(rel));

if (unaccounted.length > 0) {
  console.error('check-docs-exclusions: وثائق متتبعة ستُخدم على الموقع بلا قرار:');
  for (const f of unaccounted) {
    console.error('  - docs/' + f);
  }
  console.error('⇒ أضف كل واحدة إلى exclude في docs/_config.yml، أو إلى PUBLISHED في هذا الحارس بقرار معلن.');
  process.exit(1);
}

console.log(
  `check-docs-exclusions: ${tracked.length} docs/*.md متتبعة وكلها محسوبة ` +
    `(${excludes.length} نمط استثناء · PUBLISHED: ${PUBLISHED.length})`,
);
