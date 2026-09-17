#!/usr/bin/env node
/* حارس تكافؤ الإعدادات (البند ١.١٠).
   العلّة التي يمنع عودتها: collectSettings() (كان في src/main.ts، وهو الآن في
   وحدة مستقلة بعد البند ١٢) كان يرسل 21 حقلاً
   من أصل 22 في settings::Settings، والغائب (autostart_asked) كانت
   #[serde(default)] تعيده false مع كل دفع غير متعلّق ⇒ سؤال «التشغيل مع
   ويندوز» يعود في كل إقلاع. أي فرق جديد بين الجهتين يُفشل هذا الحارس.
   الاستعمال: pnpm settings:parity (ويُشغَّل في سير ci.yml).

   ما أُصلح هنا (كان في الاستخراج أربع طرق هروب وإنذاران كاذبان):
   كان الحارس `ts.indexOf('return', fnIdx)` ثم يقسم النصّ سطراً سطراً ويقتطع
   `//` من كل سطر:
     • معرّف محلّي اسمه `returnedDefaults` يختطف `indexOf('return')` ⇒ حذف
       `autostart_asked` يمرّ 23·23.
     • مفتاح داخل كائن متداخل يُقرأ كمفتاح أعلى ⇒ يخفي حقلاً غائباً فعلاً.
     • `//` داخل قيمة نصّية يقتطع بقيّة السطر ⇒ يخفي حقلاً زائداً.
     • `...spread` يجعل المفاتيح غير معروفة ⇒ يخفي زائداً.
   ومقابلها كان يُبلّغ «ناقص» عن مفاتيح موجودة (مفتاحان في سطر، أو مفتاح بعد
   `//` في قيمة نصّية).
   والآن: تُفرَّغ التعليقات والنصوص في هيكل بنفس الطول، ثم يُقرأ **جسم الدالة**
   و**return في مستواها الأعلى** و**مفاتيح الكائن في مستواه الأعلى** بمسح بنيوي
   (لا `indexOf` على النصّ الخام)، وأي بنية لا يمكن الجزم بها (spread · مفتاح
   محسوب · return غير كائن · أكثر من return · صفر مفاتيح) تُفشل الحارس صارخاً. */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const problems = [];

/* ── ١) هيكل بنفس الطول: تُفرَّغ فيه التعليقات والنصوص ومحتوى regex ────────
   يبقى كل محرف في موضعه فتصلح الفهارس على النصّ الأصلي، لكن لا يستطيع تعليق
   ولا نصّ أن يخدع البحث البنيوي. */
function maskCode(src) {
  const out = Array.from(src);
  const blank = (i) => {
    if (i >= 0 && i < out.length && out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  };
  let prevSig = '('; // آخر محرف معتبر: يقرّر إن كانت `/` بداية regex أم قسمة
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { blank(i); i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i++; }
      blank(i); blank(i + 1); i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        if (src[i] === q) { i++; break; }
        blank(i); i++;
      }
      prevSig = 'x'; // بعد نصّ: `/` قسمة لا regex
      continue;
    }
    if (c === '/' && /[([{,:;=!&|?+\-*%~^<>]/.test(prevSig)) {
      // regex فقط إن وُجد إغلاق غير مُهرَّب في السطر نفسه (وإلا فهي قسمة).
      let j = i + 1;
      let inClass = false;
      let closed = -1;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = j; break; }
        j++;
      }
      if (closed > 0) {
        for (let k = i; k <= closed; k++) blank(k);
        i = closed + 1;
        prevSig = 'x';
        continue;
      }
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out.join('');
}

/** موازنة قوس من فتحة معيّنة على الهيكل. */
function matchBracket(mask, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < mask.length; i++) {
    if (mask[i] === open) depth++;
    else if (mask[i] === close) {
      depth--;
      if (depth === 0) return { start: openIdx, end: i };
    }
  }
  return null;
}

/** جسم `function <name>(...) { ... }` على الهيكل (null إن لم تُعرَّف). */
function findFunctionBody(mask, name) {
  const needle = `function ${name}(`;
  const decl = mask.indexOf(needle);
  if (decl === -1) return null;
  const params = matchBracket(mask, decl + needle.length - 1, '(', ')');
  if (!params) return null;
  const open = mask.indexOf('{', params.end);
  if (open === -1) return null;
  const body = matchBracket(mask, open, '{', '}');
  if (!body) return null;
  return { decl, bodyStart: open + 1, bodyEnd: body.end };
}

/** `return` ككلمة في المستوى الأعلى من مدى (لا داخل معرّف ولا في دالة متداخلة). */
function topLevelReturns(mask, from, to) {
  const found = [];
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = mask[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (
      depth === 0 && c === 'r' && mask.startsWith('return', i) &&
      !/[A-Za-z0-9_$.]/.test(mask[i - 1] || '') && !/[A-Za-z0-9_$]/.test(mask[i + 6] || '')
    ) {
      found.push(i);
      i += 5;
    }
  }
  return found;
}

/**
 * مفاتيح كائن حرفي: مقاطع المستوى الأعلى فقط، مع كشف spread والمفاتيح المحسوبة.
 * يحكم على البنية لا على السطور: مفتاحان في سطر واحد يُقرآن معاً، و`//` في قيمة
 * نصّية لم يعد يقتطع شيئاً (النصّ مُفرَّغ في الهيكل أصلاً).
 */
function objectLiteralKeys(mask, orig, openIdx) {
  const span = matchBracket(mask, openIdx, '{', '}');
  if (!span) return { error: 'تعذّر موازنة أقواس كائن الـreturn' };
  const keys = new Set();
  const spreads = [];
  const computed = [];
  const invalid = [];
  const parseSegment = (start, end) => {
    if (end <= start) return; // فاصلة أخيرة
    const seg = mask.slice(start, end);
    const raw = orig.slice(start, end).trim();
    if (!raw) return;
    const t = seg.trim();
    if (!t) return;
    if (t.startsWith('...')) { spreads.push(raw.replace(/\s+/g, ' ').slice(0, 60)); return; }
    if (t.startsWith('[')) { computed.push(raw.replace(/\s+/g, ' ').slice(0, 60)); return; }
    if (raw[0] === '"' || raw[0] === "'") {
      const q = raw[0];
      let j = 1;
      let name = '';
      while (j < raw.length) {
        if (raw[j] === '\\') { name += raw[j + 1]; j += 2; continue; }
        if (raw[j] === q) break;
        name += raw[j];
        j++;
      }
      const rest = raw.slice(j + 1).trim();
      if (rest === '' || rest.startsWith(':')) keys.add(name);
      else invalid.push(raw.replace(/\s+/g, ' ').slice(0, 60));
      return;
    }
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(t);
    if (!m) { invalid.push(raw.replace(/\s+/g, ' ').slice(0, 60)); return; }
    const rest = t.slice(m[1].length).trimStart();
    // `key:` · `key,` (اختصار) · `key` (اختصار في آخر مقطع) · `key() {}` (ميثود)
    if (rest === '' || rest.startsWith(':') || rest.startsWith(',') || rest.startsWith('(')) {
      keys.add(m[1]);
      return;
    }
    invalid.push(raw.replace(/\s+/g, ' ').slice(0, 60));
  };
  let segStart = openIdx + 1;
  let depth = 0;
  for (let i = openIdx + 1; i < span.end; i++) {
    const c = mask[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) { parseSegment(segStart, i); segStart = i + 1; }
  }
  parseSegment(segStart, span.end);
  return { keys, spreads, computed, invalid };
}

/* ── ٢) حقول Rust: `pub <name>:` داخل `pub struct Settings` فقط. ─────────── */
const rustFields = new Set();
{
  const rsPath = path.join(root, 'src-tauri/src/settings.rs');
  let rs = '';
  try {
    rs = fs.readFileSync(rsPath, 'utf8');
  } catch (err) {
    problems.push('settings.rs: تعذّرت قراءته — ' + ((err && err.message) || err));
  }
  if (rs) {
    const mask = maskCode(rs);
    const structIdx = mask.indexOf('pub struct Settings');
    if (structIdx === -1) {
      problems.push('settings.rs: لم يُعثر على `pub struct Settings`');
    } else {
      const open = mask.indexOf('{', structIdx);
      const body = open === -1 ? null : matchBracket(mask, open, '{', '}');
      if (!body) {
        problems.push('settings.rs: تعذّر موازنة أقواس `struct Settings`');
      } else {
        for (const m of mask.slice(body.start + 1, body.end).matchAll(/(?:^|\n)\s*pub\s+([A-Za-z0-9_]+)\s*:/g)) {
          rustFields.add(m[1]);
        }
        if (rustFields.size === 0) {
          problems.push('settings.rs: صفر حقول `pub` داخل struct Settings — الاستخراج فاشل');
        }
      }
    }
  }
}

/* ── ٣) مفاتيح collectSettings(): كائن الـreturn في المستوى الأعلى ──────────
   البند ١٢ (تقسيم src/main.ts) نقل الدالة إلى وحدة أخرى، فأصبح الحارس يتبعها
   في src/*.ts بدل تثبيت مسار واحد — وهذا أقوى لا أضعف: صفر تعريفات يُفشل
   الحارس، وأكثر من تعريف واحد يُفشله أيضاً (لا نسخة مكرّرة تفلت من المقارنة). */
const tsFiles = [];
(function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && e.name.endsWith('.ts')) tsFiles.push(full);
  }
})(path.join(root, 'src'));
tsFiles.sort();

const owners = [];
const ownerMasks = new Map();
for (const f of tsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const mask = maskCode(src);
  if (findFunctionBody(mask, 'collectSettings')) {
    owners.push(f);
    ownerMasks.set(f, mask);
  }
}
if (owners.length === 0) {
  problems.push('src/*.ts: لم يُعثر على تعريف `function collectSettings()` في أي ملف');
} else if (owners.length > 1) {
  problems.push('src/*.ts: `function collectSettings()` معرَّفة في أكثر من ملف: ' + owners.map((f) => path.relative(root, f)).join(' · '));
}

const tsKeys = new Set();
if (owners.length === 1) {
  const owner = owners[0];
  const ownerRel = path.relative(root, owner);
  const ts = fs.readFileSync(owner, 'utf8');
  const mask = ownerMasks.get(owner);
  const fn = findFunctionBody(mask, 'collectSettings');
  const returns = topLevelReturns(mask, fn.bodyStart, fn.bodyEnd);
  if (returns.length === 0) {
    problems.push(`${ownerRel}: لا \`return\` في المستوى الأعلى من collectSettings() — تعذّر استخراج المفاتيح`);
  } else if (returns.length > 1) {
    problems.push(`${ownerRel}: ${returns.length} عبارات \`return\` في المستوى الأعلى من collectSettings() — مصدر الحقيقة غامض، فوحّده في كائن واحد`);
  } else {
    const objIdx = mask.indexOf('{', returns[0] + 6);
    const gap = objIdx === -1 ? null : mask.slice(returns[0] + 6, objIdx).trim();
    if (objIdx === -1 || gap !== '') {
      const shown = ts.slice(returns[0] + 6, returns[0] + 70).replace(/\s+/g, ' ').trim();
      problems.push(`${ownerRel}: \`return\` في collectSettings() ليس كائنًا حرفيًا (${shown}) — لا يمكن الجزم بالمفاتيح`);
    } else {
      const parsed = objectLiteralKeys(mask, ts, objIdx);
      if (parsed.error) {
        problems.push(`${ownerRel}: ${parsed.error}`);
      } else {
        if (parsed.spreads.length) {
          problems.push(`${ownerRel}: كائن الـreturn يستعمل spread (${parsed.spreads.join(' · ')}) — مفاتيحه لا تُقرأ نصّاً فيتعذّر ضمان التكافؤ`);
        }
        if (parsed.computed.length) {
          problems.push(`${ownerRel}: كائن الـreturn فيه مفتاح محسوب (${parsed.computed.join(' · ')}) — لا يمكن الجزم باسمه`);
        }
        if (parsed.invalid.length) {
          problems.push(`${ownerRel}: مقاطع لم تُقرأ كمفاتيح في كائن الـreturn: ${parsed.invalid.join(' · ')}`);
        }
        for (const k of parsed.keys) tsKeys.add(k);
        if (tsKeys.size === 0) {
          problems.push(`${ownerRel}: صفر مفاتيح مستخرجة من كائن الـreturn — الاستخراج فاشل`);
        }
      }
    }
  }
}

/* ── ٤) المقارنة في الاتجاهين. ───────────────────────────────────────────── */
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
