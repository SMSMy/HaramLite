#!/usr/bin/env node
/* حارس رموز خطأ الجسر (م٦-ج) — node scripts/check-bridge-codes.cjs [--root=<dir>] [--selfcheck]
 *
 * **العطل الذي وُلد لأجله**: رسائل الخطأ التي يصوغها **التطبيق** كانت تصل الإضافة
 * نصّاً عربياً جاهزاً، فتُعرض في واجهة إنجليزية كما هي (قاسه جاسوس م٦-أ في jsdom:
 * `⚠ هذا الرابط طُلب من قبل…` بـ`direction="ltr"`). والعلاج رمزٌ مستقرّ `code` في
 * الجسر تُترجمه الإضافة. وهذا الحارس يمنع **افتراق الرمز عن جدول الترجمة**:
 * رمزٌ جديد في الرست بلا مدخل في الإضافة = نصّ عربي يعود إلى واجهة إنجليزية
 * صامتاً، وهو العطل نفسه من بابه الثاني.
 *
 * **ما يقيسه — من المصدر لا من رأس أحد**:
 *   ① من `src-tauri/src/bridge.rs`: كل ثابت `pub const E_X: &str = "…";` هو **رمز
 *      معلَن**، وكل موضع نداء لـ`err_last(` أو `reply_err(` هو **موضع خطأ**. ويُشترط:
 *      كل موضع خطأ يمرّر **أول وسيط** رمزاً معلَناً (لا نصّاً ولا متغيّراً)، وكل رمز
 *      معلَن **يُصدره الملف فعلاً** (رمز معلَن ولا يُصدر = عقد وهمي).
 *   ② من `browser-extension/content.js` و`popup.js`: مدخلات `code.<رمز>` في جدول
 *      `I18N` (باللغتين) **و**حالات `switch` داخل `errText` — فمدخلٌ في الجدول بلا
 *      حالةٍ لا يُترجم شيئاً، وحالةٌ بلا مدخل تُرجع `undefined`.
 *   ③ **التقابل في الاتجاهين**: مجموعة الرموز المُصدَرة = مجموعة مدخلات الجدول =
 *      مجموعة الحالات، في كل ملف. **رمز في الرست بلا مقابل ⇒ سقوط**، **ومفتاح في
 *      الجدول بلا رمز في الرست ⇒ سقوط** (اختيار مُعلَن: مدخل ميت يوهم بتغطية غير
 *      قائمة، وهو حكم `check-extension-i18n.cjs` نفسه على المفاتيح الميتة).
 *
 * **وما لا يقيسه**: جودة الترجمة (يشترط الوجود والتكافؤ لا المعنى)، ولا أن التطبيق
 * يعرض النصّ فعلاً — ذاك يقيسه `check-extension-i18n-jsdom.cjs` على DOM حقيقي.
 *
 * **والفحص الذاتي** (`--selfcheck`) يقيس الحارس نفسه في مجلد مؤقت تحت `%TEMP%`:
 * ضابط (الشجرة المشحونة تمرّ، **وقد رأى مدخلاً غير صفري**) · مُفسَد رمز جديد في
 * `bridge.rs` بلا جدول ⇒ يسقط · مُفسَد مدخل محذوف من الجدول ⇒ يسقط · مُفسَد مدخل
 * زائد في الجدول بلا رمز ⇒ يسقط · مُفسَد موضع خطأ يمرّر نصّاً بدل الرمز ⇒ يسقط ·
 * وصفر مدخل (bridge.rs مفقود أو فارغ) ⇒ فشل بنيوي مسمّى (2).
 *
 * بلا اعتماديات npm: `node:fs` · `node:os` · `node:path` · `node:child_process`،
 * ومُحلِّل جدول الترجمة من `check-extension-i18n.cjs` (المصدر نفسه، لا نسخة ثانية).
 *
 * الاستعمال: 0 = سليم · 1 = فشل (افتراق مُسمّى) · 2 = بنية/استعمال (صفر مدخل).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findTable, balancedBlock } = require('./check-extension-i18n.cjs');

const EXIT = { PASS: 0, FAIL: 1, MISUSE: 2 };
const ROOT_DEFAULT = path.resolve(__dirname, '..');
const BRIDGE_REL = path.join('src-tauri', 'src', 'bridge.rs');
const TABLE_RELS = [
  path.join('browser-extension', 'content.js'),
  path.join('browser-extension', 'popup.js'),
];
/** شكل الرمز: ASCII صغير بـ`snake_case` — فيصلح مفتاحاً `code.<رمز>` بلا هروب. */
const CODE_RE = /^[a-z][a-z0-9_]*$/;
/** ثابت الرمز في الرست: `pub const E_X: &str = "value";` */
const CONST_RE = /pub const (E_[A-Z0-9_]+)\s*:\s*&str\s*=\s*"([^"]*)";/g;
/** مواضع بناء حمولة الخطأ — الوحيدان المسموحان بهما. */
const CALL_NAMES = ['err_last', 'reply_err'];

/** خطأ بنية/استعمال: يُطبع بـ`✗` ويرجع 2 (لا صفر، ولا انهيار بـstack). */
class GuardError extends Error {
  constructor(message, code = EXIT.MISUSE) {
    super(message);
    this.code = code;
  }
}

/* ══ ① قراءة الرست: الرموز المعلَنة ومواضع الإصدار ═══════════════════════════ */

/** يُفرّغ تعليقات Rust **بمسافات** (الأسطر كما هي) مع **تجاوز النصوص الحرفية**:
 *  `"https://…"` يحمل `//` وليس تعليقاً — لو قُصّ لابتلع بقية السطر (وثائق هذا
 *  الملف مكتوبة بالعربية داخل `///` فالتعليقات كثيفة، والخطأ هنا صامت). */
function stripRustComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '"') {
      out += c;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          out += src[i];
          i++;
          if (i < src.length) { out += src[i]; i++; }
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < src.length) { out += src[i]; i++; }
      continue;
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < src.length) { out += '  '; i += 2; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** جسم دالّة Rust بموازنة الأقواس (تجاوز النصوص الحرفية). */
function rustFnBody(src, name) {
  const at = src.indexOf('fn ' + name + '(');
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
    i++;
  }
  return null;
}

/** الوسيط الأول لنداء يبدأ قوسه عند `openIdx` (تجاوز النصوص والأقواس المتداخلة). */
function firstArg(text, openIdx) {
  let i = openIdx + 1;
  let depth = 0;
  const start = i;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' ) { if (depth === 0) break; depth--; }
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) break;
    i++;
  }
  return text.slice(start, i).trim();
}

/**
 * يقرأ من `bridge.rs`: الرموز المعلَنة (اسم الثابت ⇒ قيمته) وكل موضع خطأ ووسيطه الأول.
 * @returns {{declared:Map<string,string>, sites:Array<{fn:string,arg:string,line:number}>}}
 */
function readBridgeCodes(src) {
  const clean = stripRustComments(src);
  const declared = new Map();
  const order = [];
  let m;
  CONST_RE.lastIndex = 0;
  while ((m = CONST_RE.exec(clean)) !== null) {
    if (declared.has(m[1])) throw new GuardError(`ثابت الرمز ${m[1]} معرَّف مرتين في ${BRIDGE_REL}`);
    declared.set(m[1], m[2]);
    order.push(m[1]);
  }

  const sites = [];
  for (const fn of CALL_NAMES) {
    const re = new RegExp('\\b' + fn + '\\s*\\(', 'g');
    let c;
    while ((c = re.exec(clean)) !== null) {
      // تعريف الدالّة نفسه ليس موضع إصدار: `fn reply_err(code: &str, msg: &str) {`
      const head = clean.slice(Math.max(0, c.index - 4), c.index);
      if (/\bfn\s$/.test(head)) continue;
      const open = c.index + c[0].length - 1;
      sites.push({ fn, arg: firstArg(clean, open), line: lineOf(src, c.index) });
    }
  }
  return { declared, order, sites };
}

/** رقم السطر (1-based) لإزاحة في النصّ الأصلي. */
function lineOf(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/* ══ ② قراءة الإضافة: مدخلات `code.*` وحالات `errText` ══════════════════════ */

/** مدخلات `code.<رمز>` في جدول `I18N` — بالمُحلِّل نفسه الذي يستعمله حارس التعريب. */
function readTableCodes(src) {
  const table = findTable(src);
  if (!table) throw new GuardError('جدول الترجمة `const I18N = { … }` مفقود — لا مدخلات أُقابلها');
  let I18N;
  try {
    I18N = new Function(table.literal + '\nreturn I18N;')();
  } catch (e) {
    throw new GuardError('تعذّر تقييم جدول الترجمة: ' + (e && e.message ? e.message : e));
  }
  const pick = (row) => (row && typeof row === 'object' ? Object.keys(row) : null);
  const arKeys = pick(I18N.ar);
  const enKeys = pick(I18N.en);
  if (!arKeys || !enKeys) throw new GuardError('جدول الترجمة بلا القسمين `ar` و`en` معاً');
  const codesOf = (keys) => keys.filter((k) => /^code\.[a-z][a-z0-9_]*$/.test(k)).map((k) => k.slice('code.'.length));
  const textOf = (row, code) => {
    const v = row['code.' + code];
    return typeof v === 'string' ? v : null;
  };
  return {
    ar: codesOf(arKeys),
    en: codesOf(enKeys),
    text: { ar: (c) => textOf(I18N.ar, c), en: (c) => textOf(I18N.en, c) },
  };
}

/** حالات `switch` داخل `errText` — من النصّ لا من الجدول. */
function readSwitchCases(src) {
  const at = /function\s+errText\s*\(/.exec(src);
  if (!at) return null;
  const open = src.indexOf('{', at.index);
  const blk = balancedBlock(src, open);
  if (!blk) return null;
  const out = [];
  for (const m of blk.body.matchAll(/case\s+'([a-z][a-z0-9_]*)'\s*:/g)) out.push(m[1]);
  return out;
}

/* ══ ③ القياس ══════════════════════════════════════════════════════════════ */

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const diff = (a, b) => a.filter((x) => !b.includes(x));

function read(root, rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) throw new GuardError(`صفر مدخل: ${rel} غير موجود عند ${p} — لا شيء يُقاس`);
  const text = fs.readFileSync(p, 'utf8');
  if (text.trim() === '') throw new GuardError(`صفر مدخل: ${rel} فارغ — لا شيء يُقاس`);
  return text;
}

/**
 * القياس كاملاً على جذر مُمرَّر. يُعيد `{ failures, checks, codes, sites }`.
 * وكل حكم **مسمّى بموضعه**: رمزٌ بلا مقابل يُطبع باسمه وبالملف الذي ينقصه.
 */
function audit(root, log) {
  const say = log || (() => {});
  const checks = [];
  const failures = [];
  const ok = (label, cond, detail) => {
    checks.push(label);
    say('  ' + (cond ? '✓' : '✗') + ' ' + label);
    if (!cond) failures.push(detail ? label + ' — ' + detail : label);
  };

  const bridgeSrc = read(root, BRIDGE_REL);
  const tableSrc = {};
  for (const rel of TABLE_RELS) tableSrc[rel] = read(root, rel);

  const { declared, order, sites } = readBridgeCodes(bridgeSrc);

  /* صفر مدخل: رموز معلَنة ومواضع خطأ — وإلا فالحارس يمرّ لأنه لم ينظر. */
  if (declared.size === 0) {
    throw new GuardError(
      `صفر مدخل: لا ثابت رمز واحد (\`pub const E_X: &str = "…";\`) في ${BRIDGE_REL} — لا شيء يُقاس`
    );
  }
  if (sites.length === 0) {
    throw new GuardError(
      `صفر مدخل: لا موضع نداء واحد لـ${CALL_NAMES.join('/')} في ${BRIDGE_REL} — لا موضع خطأ يُقاس`
    );
  }
  for (const fn of CALL_NAMES) {
    if (!sites.some((s) => s.fn === fn)) {
      throw new GuardError(
        `صفر مدخل: لا موضع خطأ يستعمل \`${fn}(\` في ${BRIDGE_REL} — نصف العقد غير مقيس`
      );
    }
  }

  /* ① شكل الرمز وقيمته غير المكرّرة. */
  const badShape = order.filter((n) => !CODE_RE.test(declared.get(n)));
  ok(
    `شكل كل رمز ASCII بـsnake_case (${declared.size} رمزاً)`,
    badShape.length === 0,
    badShape.map((n) => `${n} = "${declared.get(n)}"`).join(' · ')
  );
  const values = order.map((n) => declared.get(n));
  const dupValues = values.filter((v, i) => values.indexOf(v) !== i);
  ok('لا قيمة رمز مكرَّرة بين ثابتين', dupValues.length === 0, dupValues.join(' · '));

  /* ② كل موضع خطأ يمرّر رمزاً معلَناً بوسيطه الأول (لا نصّاً ولا متغيّراً). */
  const literals = sites.filter((s) => !/^E_[A-Z0-9_]+$/.test(s.arg));
  ok(
    `كل موضع خطأ يمرّر رمزاً بوسيطه الأول (${sites.length} موضعاً)`,
    literals.length === 0,
    literals.map((s) => `${s.fn}(…) سطر ${s.line}: الوسيط الأول «${s.arg}»`).join(' · ')
  );
  const undeclaredUse = sites.filter((s) => /^E_[A-Z0-9_]+$/.test(s.arg) && !declared.has(s.arg));
  ok(
    'ولا وسيط يشير إلى رمز غير معلَن',
    undeclaredUse.length === 0,
    undeclaredUse.map((s) => `سطر ${s.line}: ${s.arg}`).join(' · ')
  );

  /* ③ كل رمز معلَن يُصدره الملف فعلاً — وإلا فعقدٌ وهمي يُلزم الإضافة بترجمة لا تُعرض. */
  const emittedNames = new Set(sites.map((s) => s.arg));
  const neverEmitted = order.filter((n) => !emittedNames.has(n));
  ok(
    `كل رمز معلَن يُصدره ${BRIDGE_REL} فعلاً (${order.length} رمزاً)`,
    neverEmitted.length === 0,
    neverEmitted.map((n) => `${n} معلَن ولا موضع خطأ يمرّره`).join(' · ')
  );
  /* والرموز المُصدَرة: المعلَنة ∩ المستعملة (يرتّبها ترتيب الإعلان). */
  const emitted = order.filter((n) => emittedNames.has(n));

  /* ④ الحمولتان تُصدران `code` فعلاً — لا تكفي وسيطة باسم رمز. */
  const payloadHasCode = (name) => {
    const body = rustFnBody(bridgeSrc, name);
    return !!body && /"error"\s*:\s*msg/.test(body) && /"code"\s*:\s*code/.test(body);
  };
  const builders = CALL_NAMES.filter((n) => !payloadHasCode(n));
  ok(
    `حمولتا ${CALL_NAMES.join(' و')} تحملان \`"error": msg\` و\`"code": code\``,
    builders.length === 0,
    builders.map((n) => `${n} لا يُصدر الحقلين`).join(' · ')
  );

  /* ⑤ التقابل في الاتجاهين: الرست ⇄ جدول الإضافة ⇄ حالات `errText`. */
  const codes = emitted.map((n) => declared.get(n));
  const tables = [];
  for (const rel of TABLE_RELS) {
    const t = readTableCodes(tableSrc[rel]);
    const cases = readSwitchCases(tableSrc[rel]);
    const short = rel.replace(/\\/g, '/');
    tables.push({ rel: short, ...t, cases });

    ok(
      `[${short}] لكل رمز مُصدَر مدخل \`code.<رمز>\` في الجدول (${codes.length} رمزاً)`,
      diff(codes, t.ar).length === 0,
      'ينقص الجدول: ' + (diff(codes, t.ar).join(' · ') || '—')
    );
    ok(
      `[${short}] ولا مدخل في الجدول بلا رمز مُصدَر (اختيار: مدخل ميت = سقوط)`,
      diff(t.ar, codes).length === 0,
      'مدخل بلا رمز في الرست: ' + (diff(t.ar, codes).join(' · ') || '—')
    );
    ok(
      `[${short}] المدخل قائم في اللغتين (ar/en)`,
      sameSet(t.ar, t.en),
      'فرق: ' + (diff(t.ar, t.en).concat(diff(t.en, t.ar)).join(' · ') || '—')
    );
    ok(
      `[${short}] وكل مدخل له حالة في \`errText\` (وإلا تُرجع undefined)`,
      Array.isArray(cases) && sameSet(cases, t.ar),
      !Array.isArray(cases)
        ? 'دالّة `errText` أو حالاتها غير مقروءة'
        : 'فرق الحالات: ' + (diff(t.ar, cases).concat(diff(cases, t.ar)).join(' · ') || '—')
    );
  }

  const allCheckCount = checks.length;
  return { checks: allCheckCount, failures, codes, declared, order, sites, tables };
}

/* ══ ④ العرض ═══════════════════════════════════════════════════════════════ */

function printTable(r) {
  console.log('\nجدول الرموز (الرست ⇒ جدول الإضافة):');
  const content = r.tables[0];
  for (const code of r.codes) {
    const ar = content ? content.text.ar(code) : null;
    const en = content ? content.text.en(code) : null;
    console.log(`   ${code.padEnd(20)} | ${String(ar).slice(0, 44)} | ${String(en).slice(0, 52)}`);
  }
  console.log(`   (${r.codes.length} رمزاً مُصدَراً · ${r.sites.length} موضع خطأ في ${BRIDGE_REL})`);
}

function run(root, quiet) {
  if (!quiet) {
    console.log('=== حارس رموز خطأ الجسر: الرست ⇄ جدول ترجمة الإضافة ===');
    console.log(`  الجذر: ${root}`);
    console.log(`  الرست: ${BRIDGE_REL} · الجدولان: ${TABLE_RELS.map((p) => p.replace(/\\/g, '/')).join(' · ')}\n`);
  }
  const r = audit(root, quiet ? () => {} : undefined);
  if (!quiet) printTable(r);
  if (r.failures.length) {
    console.error(`\n✗ فشل حارس رموز الجسر (${r.failures.length} من ${r.checks} فحصاً):`);
    for (const f of r.failures) console.error('   - ' + f);
    return EXIT.FAIL;
  }
  if (r.checks === 0) {
    console.error('✗ صفر مدخل: لم يُنفَّذ فحص واحد — لا نجاح فارغ.');
    return EXIT.FAIL;
  }
  console.log(
    `\n✓ رموز الجسر متطابقة: ${r.codes.length} رمزاً مُصدَراً في ${r.sites.length} موضع خطأ، ` +
      `ولكلٍّ مدخل وحالة ترجمة في ${TABLE_RELS.length} ملفات إضافة (${r.checks} فحصاً · 0 فاشل).`
  );
  return EXIT.PASS;
}

/* ══ ⑤ الفحص الذاتي: الحارس يُقاس بضابطه ومُفسَداته وصفر مدخله ═══════════════ */

/** جذر مصنوع: نسخ **الملفات المشحونة نفسها** (المقيس هو المشحون لا نسخة منه). */
function writeFixture(root, { noBridge = false, emptyBridge = false } = {}) {
  const copies = [
    [BRIDGE_REL, path.join(ROOT_DEFAULT, BRIDGE_REL)],
    ...TABLE_RELS.map((rel) => [rel, path.join(ROOT_DEFAULT, rel)]),
  ];
  for (const [rel, src] of copies) {
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (rel === BRIDGE_REL && noBridge) continue;
    if (rel === BRIDGE_REL && emptyBridge) { fs.writeFileSync(dst, '\n'); continue; }
    fs.copyFileSync(src, dst);
  }
  return root;
}

/** تعديل ملف في الجذر المصنوع — **يرمي** إن لم يطابق، فلا «مُفسَد» بلا تغيير. */
function edit(root, rel, from, to) {
  const p = path.join(root, rel);
  const before = fs.readFileSync(p, 'utf8');
  const n = before.split(from).length - 1;
  if (n !== 1) throw new Error(`مُفسَد لم يطابق مرة واحدة في ${rel} (طابق ${n})`);
  fs.writeFileSync(p, before.replace(from, to));
}

function runChild(root) {
  const r = spawnSync(process.execPath, [__filename, '--root=' + root, '--quiet'], {
    cwd: ROOT_DEFAULT,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function selfcheck() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-bridge-codes-'));
  const cases = [];
  const add = (label, expected, res, mustText) => {
    const problems = [];
    if (res.status !== expected) problems.push(`رمز الخروج ${res.status} بدل ${expected}`);
    for (const t of mustText || []) if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    cases.push({ label, ok: problems.length === 0, detail: problems.join(' · ') });
    return problems.length === 0;
  };

  try {
    /* Ⓐ ضابط: الشجرة المشحونة كما هي ⇒ 0، **وقد رأى رموزاً** (لا مرور بالعمى). */
    {
      const dir = writeFixture(path.join(work, 'control'));
      const res = runChild(dir);
      const m = /(\d+) رمزاً مُصدَراً/.exec(res.out);
      const seen = m ? Number(m[1]) : 0;
      const problems = [];
      if (res.status !== EXIT.PASS) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.PASS}`);
      if (seen < 1) problems.push(`رأى ${seen} رمزاً — نجاح لأنه لم ينظر`);
      cases.push({
        label: 'Ⓐ ضابط: الشجرة المشحونة (الرست + الجدولان) ⇒ 0 وقد رأى رموزاً',
        ok: problems.length === 0,
        detail: problems.length ? problems.join(' · ') : `exit=0 · رأى ${seen} رمزاً`,
      });
    }

    /* Ⓑ مُفسَد (أ): رمز جديد في `bridge.rs` يُصدره موضع خطأ ولا مدخل له في الجدول
       ⇒ يجب أن يسقط **مسمّياً الرمز**. وهذا هو العطل نفسه من بابه الثاني. */
    {
      const dir = writeFixture(path.join(work, 'mutant-new-code'));
      fs.appendFileSync(
        path.join(dir, BRIDGE_REL),
        '\npub const E_FUTURE_PROBE: &str = "future_probe_code";\n' +
          'fn probe_future() {\n    reply_err(E_FUTURE_PROBE, "probe");\n}\n'
      );
      const res = runChild(dir);
      add(
        'Ⓑ مُفسَد (أ): رمز جديد في bridge.rs بلا مدخل في جدول الإضافة ⇒ يسقط مسمّياً',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'future_probe_code', 'ينقص الجدول']
      );
    }

    /* Ⓑ′ مُفسَد (ب): مدخل `code.duplicate_link` محذوف من جدول content.js (والرمز
       ما زال يُصدَر) ⇒ يسقط بالاتجاه الأول للتقابل. */
    {
      const dir = writeFixture(path.join(work, 'mutant-drop-entry'));
      edit(dir, TABLE_RELS[0], "      'code.duplicate_link': 'هذا الرابط طُلب من قبل في هذه الجلسة — تخطي المكرر',\n", '');
      const res = runChild(dir);
      add(
        'Ⓑ′ مُفسَد (ب): مدخل الرمز محذوف من الجدول ⇒ يسقط (رمز في الرست بلا مقابل)',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'duplicate_link', 'ينقص الجدول']
      );
    }

    /* Ⓑ″ مُفسَد (ج): مدخل زائد في الجدول بلا رمز في الرست ⇒ يسقط (الاختيار المُعلَن:
       مدخل ميت يوهم بتغطية غير قائمة). */
    {
      const dir = writeFixture(path.join(work, 'mutant-extra-entry'));
      edit(dir, TABLE_RELS[0], "      'code.bad_input': 'طلب غير صالح',",
        "      'code.bad_input': 'طلب غير صالح',\n      'code.ghost_probe': 'مدخل بلا رمز',");
      edit(dir, TABLE_RELS[0], "      'code.bad_input': 'Invalid request',",
        "      'code.bad_input': 'Invalid request',\n      'code.ghost_probe': 'entry without a code',");
      edit(dir, TABLE_RELS[0], "      case 'bad_input': return t('code.bad_input');",
        "      case 'bad_input': return t('code.bad_input');\n      case 'ghost_probe': return t('code.ghost_probe');");
      const res = runChild(dir);
      add(
        'Ⓑ″ مُفسَد (ج): مدخل في الجدول بلا رمز مُصدَر ⇒ يسقط (مدخل ميت)',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'ghost_probe', 'مدخل بلا رمز في الرست']
      );
    }

    /* Ⓑ‴ مُفسَد (د): موضع خطأ يمرّر نصّاً بدل الرمز ⇒ يسقط (وإلا فخطأ جديد يمرّ
       بلا تصنيف ما دام نصّه معروضاً). */
    {
      const dir = writeFixture(path.join(work, 'mutant-literal'));
      edit(dir, BRIDGE_REL, 'reply_err(E_BAD_INPUT, "empty url");', 'reply_err("bad_input", "empty url");');
      const res = runChild(dir);
      add(
        'Ⓑ‴ مُفسَد (د): موضع خطأ يمرّر نصّاً بدل الرمز ⇒ يسقط',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'الوسيط الأول']
      );
    }

    /* Ⓒ/Ⓒ′ صفر مدخل: `bridge.rs` مفقود ثم فارغ ⇒ فشل بنيوي مسمّى (2) لا نجاح فارغ. */
    {
      const folder = path.join(work, 'zero-missing');
      fs.mkdirSync(folder, { recursive: true });
      const dir = writeFixture(folder, { noBridge: true });
      add('Ⓒ صفر مدخل: bridge.rs مفقود ⇒ فشل بنيوي (2)', EXIT.MISUSE, runChild(dir), ['✗', 'صفر مدخل']);
      const dir2 = writeFixture(path.join(work, 'zero-empty'), { emptyBridge: true });
      add('Ⓒ′ صفر مدخل: bridge.rs فارغ ⇒ فشل بنيوي (2)', EXIT.MISUSE, runChild(dir2), ['✗', 'صفر مدخل']);
    }

    /* Ⓓ مُفسَد (هـ): موضع خطأ بنصّ عربي بلا رمز في الرست — الحالة التي وُلد الحارس
       لأجلها (نصّ التطبيق يصل الإضافة جاهزاً فلا يُترجم). */
    {
      const dir = writeFixture(path.join(work, 'mutant-raw'));
      edit(dir, BRIDGE_REL, 'pub const E_BAD_INPUT: &str = "bad_input";',
        'pub const E_BAD_INPUT: &str = "bad_input";\npub const E_PROBE_ONLY: &str = "probe_only";');
      edit(dir, BRIDGE_REL, 'reply_err(E_BAD_INPUT, "empty url");', 'reply_err(E_PROBE_ONLY, "empty url");');
      const res = runChild(dir);
      add(
        'Ⓓ مُفسَد (هـ): رمز مُبدَّل في موضع قائم بلا مدخل ⇒ يسقط',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'probe_only']
      );
    }
  } catch (e) {
    cases.push({ label: 'بناء حالات الفحص الذاتي', ok: false, detail: (e && e.message) || String(e) });
  }

  const bad = cases.filter((c) => !c.ok);
  console.log(`\nالفحص الذاتي لحارس رموز الجسر — ${cases.length} حالة:`);
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : `\n      ${c.detail}`}`);
  fs.rmSync(work, { recursive: true, force: true });
  if (bad.length) {
    console.error(`\n✗ الفحص الذاتي سقط في ${bad.length} حالة من ${cases.length}`);
    return EXIT.FAIL;
  }
  console.log('✓ الحارس يمرّ على الضابط ويسقط على كل مُفسَد — وفيها رمز جديد بلا جدول (العطل نفسه من بابه الثاني).');
  return EXIT.PASS;
}

/* ══ ⑥ التشغيل ═════════════════════════════════════════════════════════════ */

const USAGE = `الاستعمال: node scripts/check-bridge-codes.cjs [خيارات]

  --root=<dir>   جذر المستودع (افتراضاً جذر هذا الملف) — للفحص الذاتي
  --quiet        لا تطبع إلا الملخّص والمشكلات
  --selfcheck    يفحص الحارس نفسه: ضابط · مُفسَدات · صفر مدخل
  --help         هذه الرسالة

يقيس: كل رمز يُصدره src-tauri/src/bridge.rs له مدخل \`code.<رمز>\` في جدول
ترجمة content.js وpopup.js وحالة في errText — والعكس. 0 = سليم · 1 = فشل · 2 = بنية.`;

function main() {
  const argv = process.argv.slice(2);
  let root = ROOT_DEFAULT;
  let quiet = false;
  let self = false;
  for (const a of argv) {
    if (a === '--help' || a === '-h') { console.log(USAGE); return EXIT.PASS; }
    else if (a === '--quiet') quiet = true;
    else if (a === '--selfcheck') self = true;
    else if (a.startsWith('--root=')) root = path.resolve(a.slice('--root='.length));
    else throw new GuardError(`وسيط غير معروف: ${a}`);
  }
  if (self) return selfcheck();
  return run(root, quiet);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`✗ ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = err instanceof GuardError ? err.code : EXIT.FAIL;
  }
}

module.exports = { audit, readBridgeCodes, readTableCodes, readSwitchCases, stripRustComments, BRIDGE_REL, TABLE_RELS };
