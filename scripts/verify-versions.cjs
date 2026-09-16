#!/usr/bin/env node
/* حارس تطابق الإصدار — بوابة الإصدار في ARCHIVE/ROADMAP.md §6 البند 2.
 *
 * الإصدار يُكتب في أربعة ملفات، وأي انحراف بينها يُنتج إصداراً يقول شيئاً
 * ويحمل غيره (المثبّت · شارة الواجهة · اسم أصل النشرة). هذا الحارس يفرض
 * تطابقها ويطبع القيم، ويفشل فوراً عند أي اختلاف.
 *
 * ملاحظة مقصودة: نسخة **إضافة المتصفح** (`browser-extension/manifest.json`)
 * مستقلة — لها دورة نشرها في متجر كروم — فلا تُشترط مساوية للتطبيق، لكنها
 * تُطبع هنا لأنها تُرفع يدوياً، وفحص صلاحيتها واجب.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function fromJson(p) {
  return JSON.parse(read(p)).version;
}
function fromCargoToml() {
  const m = read('src-tauri/Cargo.toml').match(/^\s*version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}
function fromCargoLock() {
  // [[package]] name = "haramlite-rs" ثم سطر version الخاص به
  const blocks = read('src-tauri/Cargo.lock').split('[[package]]');
  for (const b of blocks) {
    if (/name\s*=\s*"haramlite-rs"/.test(b)) {
      const m = b.match(/version\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
  }
  return null;
}

const app = {
  'package.json': fromJson('package.json'),
  'src-tauri/tauri.conf.json': fromJson('src-tauri/tauri.conf.json'),
  'src-tauri/Cargo.toml': fromCargoToml(),
  'src-tauri/Cargo.lock (haramlite-rs)': fromCargoLock(),
};
const ext = fromJson('browser-extension/manifest.json');

const problems = [];
for (const [file, v] of Object.entries(app)) {
  if (!v) problems.push(`${file}: لم أستطع قراءة الإصدار`);
}
const values = Object.values(app).filter(Boolean);
const uniq = [...new Set(values)];
if (uniq.length > 1) {
  problems.push(
    'إصدارات التطبيق مختلفة: ' +
      Object.entries(app).map(([f, v]) => `${f}=${v}`).join(' · ')
  );
}
if (!/^\d+\.\d+\.\d+$/.test(ext || '')) problems.push(`browser-extension/manifest.json: إصدار غير صالح «${ext}»`);

console.log('  حارس الإصدار:');
for (const [file, v] of Object.entries(app)) console.log(`    ${v ?? '—'}  ${file}`);
console.log(`    ${ext}  browser-extension/manifest.json  (دورة نشر مستقلة)`);

if (problems.length) {
  for (const p of problems) console.error('✗ ' + p);
  process.exit(1);
}
console.log(`  ✓ إصدار التطبيق موحّد: ${uniq[0]}`);
