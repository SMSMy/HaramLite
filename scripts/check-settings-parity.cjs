#!/usr/bin/env node
/* حارس تكافؤ الإعدادات (البند ١.١٠).
   العلّة التي يمنع عودتها: collectSettings() في src/main.ts كان يرسل 21 حقلاً
   من أصل 22 في settings::Settings، والغائب (autostart_asked) كانت
   #[serde(default)] تعيده false مع كل دفع غير متعلّق ⇒ سؤال «التشغيل مع
   ويندوز» يعود في كل إقلاع. أي فرق جديد بين الجهتين يُفشل هذا الحارس.
   الاستعمال: pnpm settings:parity (ويُشغَّل في سير ci.yml). */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const problems = [];

/* يوازن الأقواس من فهرس فتحة معيّنة ويعيد نصّ ما داخلها. */
function balanced(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/* 1) حقول Rust: `pub <name>:` داخل `pub struct Settings` فقط. */
const rs = fs.readFileSync(path.join(root, 'src-tauri/src/settings.rs'), 'utf8');
const structIdx = rs.indexOf('pub struct Settings');
if (structIdx === -1) problems.push('settings.rs: لم يُعثر على `pub struct Settings`');
let rustFields = new Set();
if (structIdx !== -1) {
  const body = balanced(rs, rs.indexOf('{', structIdx));
  if (body === null) {
    problems.push('settings.rs: تعذّر موازنة أقواس `struct Settings`');
  } else {
    for (const m of body.matchAll(/^\s*pub\s+([A-Za-z0-9_]+)\s*:/gm)) {
      rustFields.add(m[1]);
    }
  }
}

/* 2) مفاتيح collectSettings(): كائن الـreturn في src/main.ts. */
const ts = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const fnIdx = ts.indexOf('function collectSettings()');
if (fnIdx === -1) problems.push('main.ts: لم يُعثر على `function collectSettings()`');
let tsKeys = new Set();
if (fnIdx !== -1) {
  const retIdx = ts.indexOf('return', fnIdx);
  const objIdx = retIdx === -1 ? -1 : ts.indexOf('{', retIdx);
  const body = objIdx === -1 ? null : balanced(ts, objIdx);
  if (body === null) {
    problems.push('main.ts: تعذّر موازنة أقواس كائن الـreturn في collectSettings()');
  } else {
    for (let line of body.split('\n')) {
      line = line.replace(/\/\/.*$/, ''); // تعليقات // (لا روابط داخل هذا الكائن)
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*[:,]/);
      if (m) tsKeys.add(m[1]);
    }
  }
}

/* 3) المقارنة في الاتجاهين. */
if (problems.length === 0) {
  for (const f of [...rustFields].sort()) {
    if (!tsKeys.has(f)) {
      problems.push('ناقص من collectSettings(): ‏`' + f + '‏` (سيدفعه pushSettings ناقصاً فتعيده serde(default) إلى قيمته الافتراضية)');
    }
  }
  for (const k of [...tsKeys].sort()) {
    if (!rustFields.has(k)) {
      problems.push('زائد في collectSettings() بلا مقابل في Settings: ‏`' + k + '‏`');
    }
  }
}

console.log('  حارس تكافؤ الإعدادات: حقول Rust=' + rustFields.size + ' · مفاتيح collectSettings=' + tsKeys.size);
if (problems.length) {
  console.error('  ✗ ' + problems.length + ' فرقاً:');
  [...new Set(problems)].forEach(p => console.error('     - ' + p));
  process.exit(1);
}
console.log('  ✓ كل حقل في Settings له مقابل في collectSettings() وبالعكس');
