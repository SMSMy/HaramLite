#!/usr/bin/env node
/* شارات زمن القراءة في docs/guides/index.html — تُحسب من نصوص الأدلة نفسها.
 *
 * الأساس: 180 كلمة/دقيقة، وهو المعدّل الذي يعتمده الموقع نفسه (بطاقة
 * best-tool تقول «قراءة متأنية: 7 دقائق» لـ1255 كلمة = 6.97 دقيقة).
 *
 * الاستعمال:
 *   node scripts/fix-reading-times.cjs          # اكتب الشارات
 *   node scripts/fix-reading-times.cjs --check  # تحقّق فقط (يفشل عند أي انحراف)
 *
 * العدّ داخل main بعد حذف التعليقات وscript/style/nav/header/footer/svg.
 *
 * درس من أول تشغيل: الاستبدال على النصّ الكامل بـ`String.replace` فشل صامتاً في
 * بطاقة واحدة (اختلاف مسافات)، فبقيت شارة قديمة. الآن يُبنى المستند قطعةً قطعة
 * (كل بطاقة وحدها) ويُفشل السكربت نفسه إن لم يتغيّر ما يجب أن يتغيّر.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs', 'guides');
const indexPath = path.join(dir, 'index.html');
const WPM = 180;
const checkOnly = process.argv.includes('--check');

function bodyTokens(file) {
  let html = fs.readFileSync(file, 'utf8');
  html = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  const main = html.match(/<main[\s\S]*?<\/main>/i);
  const text = (main ? main[0] : html).replace(/<[^>]+>/g, ' ');
  return (text.match(/[\p{L}\p{N}]+/gu) || []).length;
}

function label(tokens) {
  const minutes = tokens / WPM;
  const n = Math.round(minutes);
  return { text: `${n} ${n >= 3 && n <= 10 ? 'دقائق' : 'دقيقة'}`, minutes: Math.round(minutes * 10) / 10 };
}

const html = fs.readFileSync(indexPath, 'utf8');
const parts = html.split(/(?=<article class="guide-card)/);

const rows = [];
let changed = 0, problems = 0;

for (let i = 0; i < parts.length; i++) {
  if (!parts[i].startsWith('<article class="guide-card')) continue;
  const card = parts[i];
  const href = card.match(/href="([a-z0-9-]+\.html)"/i);
  // الشارة نصّ صريح بعد الأيقونة (الصيغة القديمة) أو داخل وسم يحمل title (الجديدة)
  const badge = card.match(/(schedule<\/span>)\s*(?:<span[^>]*>)?([^<]*)/);
  if (!href || !badge) {
    console.error('✗ بطاقة بلا رابط أو بلا شارة — توقّفت');
    process.exit(1);
  }
  const guide = path.join(dir, href[1]);
  if (!fs.existsSync(guide)) {
    console.error('✗ الدليل غير موجود: ' + href[1]);
    process.exit(1);
  }
  const tokens = bodyTokens(guide);
  const { text, minutes } = label(tokens);
  const was = badge[2].trim();
  rows.push([href[1], tokens, minutes, was, text]);

  const replacement = `${badge[1]} <span title="مقيس على ${tokens} كلمة بمعدّل ${WPM} كلمة/دقيقة">${text}</span>`;

  if (checkOnly) {
    if (was !== text) problems++;
    continue;
  }
  if (card.includes(replacement)) continue; // صحيح أصلاً
  const next = card.replace(badge[0], replacement);
  if (next === card) {
    console.error(`✗ لم يتغيّر شيء في بطاقة ${href[1]} — المطابقة فشلت، الشارة القديمة «${was}»`);
    process.exit(1);
  }
  parts[i] = next;
  changed++;
}

console.log('  الدليل                                كلمات  دقائق   الشارة');
for (const [file, tokens, minutes, was, text] of rows) {
  console.log(`    ${file.padEnd(36)} ${String(tokens).padStart(5)} ${String(minutes).padStart(6)}   ${was} → ${text}`);
}
const avgTokens = Math.round(rows.reduce((a, r) => a + r[1], 0) / rows.length);
const avgMin = Math.round((rows.reduce((a, r) => a + r[2], 0) / rows.length) * 10) / 10;
console.log(`    المتوسط: ${avgTokens} كلمة ⇒ ${avgMin} دقيقة (${rows.length} دليلاً)`);

if (checkOnly) {
  if (problems) {
    console.error(`✗ ${problems} شارة لا تطابق قياس دليلها`);
    process.exit(1);
  }
  console.log('  ✓ كل شارة تطابق عدد كلمات دليلها');
} else {
  fs.writeFileSync(indexPath, parts.join(''));
  console.log(`  عُدّلت ${changed} شارة في docs/guides/index.html`);
}
