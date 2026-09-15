#!/usr/bin/env node
/* رافع الإصدار — يكتب الإصدار في الملفات الأربعة التي يفرضها حارس الإصدار
 * (`pnpm versions:check`)، ويطبع ما يجب تعديله يدوياً في الموقع (لا يلمسه).
 *
 * الاستعمال: node scripts/bump-version.cjs 0.2.4
 *
 * لا يلمس `browser-extension/manifest.json`: للإضافة دورة نشر مستقلة في متجر
 * كروم (‏1.1.x) ولا تُساوى بإصدار التطبيق.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const next = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(next || '')) {
  console.error('✗ مرّر إصداراً صحيحاً بالصيغة x.y.z — مثال: node scripts/bump-version.cjs 0.2.4');
  process.exit(2);
}

const changes = [];
function patch(rel, re, label) {
  const p = path.join(root, rel);
  const before = fs.readFileSync(p, 'utf8');
  const m = before.match(re);
  if (!m) {
    console.error(`✗ لم أجد الإصدار في ${rel} (${label})`);
    process.exit(1);
  }
  const after = before.replace(re, (s) => s.replace(m[1], next));
  if (after !== before) {
    fs.writeFileSync(p, after);
    changes.push([rel, m[1]]);
  } else {
    changes.push([rel, m[1] + ' (بلا تغيير)']);
  }
}

// package.json — الإصدار العلوي وحده (أول ظهور بعد "private")
patch('package.json', /"version":\s*"(\d+\.\d+\.\d+)"/, 'top-level version');
// tauri.conf.json — الإصدار العلوي (قبل أي "version" داخل plugins)
patch('src-tauri/tauri.conf.json', /"version":\s*"(\d+\.\d+\.\d+)"/, 'top-level version');
// Cargo.toml — سطر version المستقل في [package] (تبعيات الملف مكتوبة داخل أقواس)
patch('src-tauri/Cargo.toml', /^version\s*=\s*"(\d+\.\d+\.\d+)"/m, '[package] version');
// Cargo.lock — كتلة haramlite-rs
{
  const p = path.join(root, 'src-tauri/Cargo.lock');
  const before = fs.readFileSync(p, 'utf8');
  const parts = before.split('[[package]]');
  let done = false;
  for (let i = 0; i < parts.length; i++) {
    if (/name\s*=\s*"haramlite-rs"/.test(parts[i])) {
      parts[i] = parts[i].replace(/version\s*=\s*"(\d+\.\d+\.\d+)"/, (s, v) => {
        changes.push(['src-tauri/Cargo.lock', v]);
        return s.replace(v, next);
      });
      done = true;
      break;
    }
  }
  if (!done) { console.error('✗ لم أجد كتلة haramlite-rs في Cargo.lock'); process.exit(1); }
  fs.writeFileSync(p, parts.join('[[package]]'));
}

console.log('  تم رفع الإصدار إلى ' + next + ':');
for (const [f, was] of changes) console.log(`    ${was} → ${next}   ${f}`);
console.log('\n  يبقى يدوياً في الموقع (لا يُشتقّ من package.json):');
console.log('    docs/index.html — "softwareVersion" في JSON-LD، و HaramLiteState.version،');
console.log('    وروابط releases/tag إن أُضيفت. (حارس الموقع يستثني index.html من فحص الشارات.)');
console.log('  ثم: pnpm versions:check && pnpm site:check');
