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
 * **وطبقة ثانية: الرموز الفرعية (`subcode` — ط-١٢ · البند ٤)**
 * **العطل الذي وُلدت لأجله**: `code.engine_error` وحده لا يقول **أيّ** عطل، فكان
 * `{e}` يُملأ بـ`detail` الخام — وهو **عربي دائماً** (التطبيق يصوغه) ⇒ «Engine
 * failed: أداة مفقودة: ffmpeg» عربيةٌ داخل جملة إنجليزية. والرست يُصدر معه
 * **`subcode`** من تسعة (`SUB_ENGINE_*`) و`detail` صريحاً. وهذا الحارس يقيس
 * الطبقة كما يقيس الأولى:
 *   · من `bridge.rs`: كتلة `pub const SUB_ENGINE_*` ومُصنِّفها `engine_subcode`
 *     — كل رمز معلَن **يُرجعه المُصنِّف** (وإلا فعقد وهمي)، ولا ثابت يُرجعه بلا
 *     إعلان · و`subcode`/`detail` **تحت `code == E_ENGINE` وحده** (فلا يُدّعى
 *     تصنيف لعطل ليس عطل محرّك، ولا يُفقد السبب).
 *   · من الجدولين: مدخلات **`sub.*`** — **مساحة أسماء ثانية لا `code.*`** عمداً:
 *     إدخال التسعة في `code.*` كان سيخالف الثابت ③ أعلاه (الرموز التسعة ليست
 *     `code` مُصدَراً) فيُرخيه أو يُخالقه. ويُقاس فيها نفس التقابل في الاتجاهين.
 *   · وخريطة **`SUB_TEXT`** الثابتة: تغطّي التسعة، وقيمها نداءاتٌ بمفاتيح
 *     **حرفية** (`() => t('sub.…')`) — لا `t(subKey)` محسوباً: المحسوب يخالف §٢٦
 *     **ويُسقط حارس «لا مفتاح بلا مستهلك»** فيعدّ التسعة ميتة (قِيس ذلك فعلاً عند
 *     أول تطبيق، والمُفسَد Ⓛ′ يمنع الرجوع إليه).
 *   · وأن `errText` **تستهلك** `subcode` فعلاً — الحالة والمفاتيح قد تقوم جميعاً
 *     وتبقى `return fill(t('code.engine_error'), {e: raw})` فتعود العربية.
 *   · ومفتاح الوقوع `err.engine_untranslated` (تفصيل عربي بلا رمز فرعي وقارئ غير
 *     عربي) قائم في اللغتين **ونصّه الإنجليزي بلا محرف عربي**.
 *
 * **وما يقيسه القياس الحيّ لا هذا الحارس**: أن الرمز **يصل** إلى `errText` —
 * فموضع الربط `bridgeError` في الإضافة كان ينسخ `code` وحده و**يُسقط
 * `subcode`/`detail`**، فمرّت كل الفحوص البنيوية هنا وضاع الرمز عند أول حدّ.
 * ذاك يقيسه `check-extension-i18n-jsdom.cjs` في DOM حقيقي (وهو ما كشفه).
 *
 * **وما لا يقيسه**: جودة الترجمة (يشترط الوجود والتكافؤ لا المعنى)، ولا أن التطبيق
 * يعرض النصّ فعلاً — ذاك يقيسه `check-extension-i18n-jsdom.cjs` على DOM حقيقي.
 *
 * **والفحص الذاتي** (`--selfcheck`) يقيس الحارس نفسه في مجلد مؤقت تحت `%TEMP%`:
 * ضابط (الشجرة المشحونة تمرّ، **وقد رأى مدخلاً غير صفري**) · مُفسَد رمز جديد في
 * `bridge.rs` بلا جدول ⇒ يسقط · مُفسَد مدخل محذوف من الجدول ⇒ يسقط · مُفسَد مدخل
 * زائد في الجدول بلا رمز ⇒ يسقط · مُفسَد موضع خطأ يمرّر نصّاً بدل الرمز ⇒ يسقط ·
 * وخمسة على طبقة `subcode` (مدخل محذوف · مدخل زائد · رمز غائب من `SUB_TEXT` ·
 * حالة لا تستهلك الرمز · قيمة رمز مُبدَّلة في الرست) · وصفر مدخل (bridge.rs مفقود
 * أو فارغ) ⇒ فشل بنيوي مسمّى (2).
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
const { findTable, balancedBlock, stripComments } = require('./check-extension-i18n.cjs');

const EXIT = { PASS: 0, FAIL: 1, MISUSE: 2 };
const ROOT_DEFAULT = path.resolve(__dirname, '..');
const BRIDGE_REL = path.join('src-tauri', 'src', 'bridge.rs');
const TABLE_RELS = [
  path.join('browser-extension', 'content.js'),
  path.join('browser-extension', 'popup.js'),
];
/** ملفات التشغيل التي تُعرَض فيها نصوص الخطأ — وفيها `background.js` ناقلاً أيضاً. */
const RUNTIME_RELS = TABLE_RELS.concat([path.join('browser-extension', 'background.js')]);
/** الدالّتان الوحيدتان المسموح لهما بقراءة النصّ الخام (وما عداهما يُعلَن). */
const SANCTIONED_FNS = ['errText', 'bridgeError'];
/** قراءة حقل خطأ: `.error` أو `.message` — والعدّ **جارف** (يشمل ما في نصّ حرفيّ).
 *  واستُثني ما يتبعه قوس (`console.error(`) لأنه **استدعاء دالّة** لا قراءة حقل —
 *  وقراءة الحقل لا تُتبع بقوس في أي صيغة هنا. */
const RAW_READ_RE = /\.\s*(?:error|message)\b(?!\s*\()/g;
/** شكل الرمز: ASCII صغير بـ`snake_case` — فيصلح مفتاحاً `code.<رمز>` بلا هروب. */
const CODE_RE = /^[a-z][a-z0-9_]*$/;
/** ثابت الرمز في الرست: `pub const E_X: &str = "value";` */
const CONST_RE = /pub const (E_[A-Z0-9_]+)\s*:\s*&str\s*=\s*"([^"]*)";/g;
/** ثابت **الرمز الفرعي**: `pub const SUB_ENGINE_X: &str = "engine_x";`
 *  (ط-١٢/البند ٤) — مساحة أسماء ثانية، ويقابلها في الإضافة `sub.*` لا `code.*`. */
const SUB_CONST_RE = /pub const (SUB_ENGINE_[A-Z0-9_]+)\s*:\s*&str\s*=\s*"([^"]*)";/g;
/** مُصنِّف الرمز الفرعي في الرست. */
const SUB_CLASSIFIER = 'engine_subcode';
/** مفتاح النصّ الاحتياطي حين يكون `detail` عربياً ولا رمز فرعي معروف. */
const UNTRANSLATED_KEY = 'err.engine_untranslated';
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

  /* الرموز **الفرعية** (ط-١٢): كتلة `SUB_ENGINE_*` — تُقرأ كما تُقرأ `E_*`. */
  const subDeclared = new Map();
  const subOrder = [];
  SUB_CONST_RE.lastIndex = 0;
  while ((m = SUB_CONST_RE.exec(clean)) !== null) {
    if (subDeclared.has(m[1])) throw new GuardError(`ثابت الرمز الفرعي ${m[1]} معرَّف مرتين في ${BRIDGE_REL}`);
    subDeclared.set(m[1], m[2]);
    subOrder.push(m[1]);
  }

  /* ومُصنِّفها: أيُّ ثابت **يُرجعه** فعلاً — رمزٌ معلَن ولا يُرجعه المُصنِّف
     عقدٌ وهمي (يُلزم الإضافة بترجمة لا تُعرض)، وثابتٌ يُرجعه ولا إعلان له خطأ. */
  const classifier = rustFnBody(clean, SUB_CLASSIFIER);
  const subReturned = classifier
    ? [...new Set([...classifier.matchAll(/\b(SUB_ENGINE_[A-Z0-9_]+)\b/g)].map((x) => x[1]))]
    : null;

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
  return { declared, order, sites, subDeclared, subOrder, subReturned };
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
  const subsOf = (keys) => keys.filter((k) => /^sub\.[a-z][a-z0-9_]*$/.test(k)).map((k) => k.slice('sub.'.length));
  const textOf = (row, code) => {
    const v = row['code.' + code];
    return typeof v === 'string' ? v : null;
  };
  const subTextOf = (row, sub) => {
    const v = row['sub.' + sub];
    return typeof v === 'string' ? v : null;
  };
  const anyOf = (row, key) => (typeof row[key] === 'string' ? row[key] : null);
  return {
    ar: codesOf(arKeys),
    en: codesOf(enKeys),
    subAr: subsOf(arKeys),
    subEn: subsOf(enKeys),
    text: { ar: (c) => textOf(I18N.ar, c), en: (c) => textOf(I18N.en, c) },
    subText: { ar: (s) => subTextOf(I18N.ar, s), en: (s) => subTextOf(I18N.en, s) },
    untranslated: { ar: anyOf(I18N.ar, UNTRANSLATED_KEY), en: anyOf(I18N.en, UNTRANSLATED_KEY) },
  };
}

/** خريطة `const SUB_TEXT = { <رمز فرعي>: () => t('<مفتاح>') }` — **جدول ثابت
 *  بمفاتيح حرفية**. تُقرأ بالنصّ (لا بتقييم الملف): الملف كله IIFE بمتغيّرات
 *  متصفّح فلا يُقيَّم في Node، و`findTable` وحدها هي التي تُقيَّم لعزلها.
 *
 *  **ولماذا الدالّة لا المفتاح نصّاً**: `t(subKey)` مفتاحٌ محسوب يخالف §٢٦
 *  ويُسقط حارس «لا مفتاح بلا مستهلك» (فيدّعي أن التسعة ميتة) — قِيس ذلك فعلاً
 *  عند أول تطبيق. فالقيمة نداءٌ بمفتاح حرفيّ: يُستهلك المفتاح **ويُرى**. */
function readSubMap(src) {
  const at = /const\s+SUB_TEXT\s*=\s*\{/.exec(src);
  if (!at) return null;
  const open = src.indexOf('{', at.index);
  const blk = balancedBlock(src, open);
  if (!blk) return null;
  const map = new Map();
  for (const m of blk.body.matchAll(/([a-z][a-z0-9_]*)\s*:\s*\(\s*\)\s*=>\s*t\('([^']+)'\)/g)) {
    map.set(m[1], m[2]);
  }
  return map;
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

/** مدى جسم دالّة في نصّ JS: `[بداية القوس, نهايته)` — بتجاوز النصوص والتعليقات. */
function fnSpan(text, name) {
  const at = new RegExp('function\\s+' + name + '\\s*\\(').exec(text);
  if (!at) return null;
  const open = text.indexOf('{', at.index);
  if (open < 0) return null;
  const blk = balancedBlock(text, open);
  return blk ? { start: open, end: blk.end, body: blk.body } : null;
}

/** جُسَيْمات حالات `switch` داخل `errText`: الرمز ⇒ نصّ ما بينه وبين الحالة التالية. */
function caseChunks(src) {
  const span = fnSpan(src, 'errText');
  if (!span) return null;
  const re = /(?:case\s+'([a-z][a-z0-9_]*)'|(default))\s*:/g;
  const marks = [];
  let m;
  while ((m = re.exec(span.body)) !== null) marks.push({ code: m[1] || null, at: re.lastIndex });
  return marks.map((mk, i) => ({
    code: mk.code,
    body: span.body.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : span.body.length),
  }));
}

/* ── قاعدة العرض: لا قراءة خامّة خارج المصرَّح ───────────────────────────────
 * **ث١ (جاسوس م٦-ج)**: ثلاثة مسارات عرض — `content.js` الاستطلاع (`st.last.error`)
 * وجلب الصوت · `popup.js` بطاقة الاكتمال (`last.error`) — كانت تقرأ النصّ الخام
 * مباشرةً، فمُفسَدات الجاسوس Ⓓ/Ⓕ/Ⓖ **مرّت على حارس الرموز وحارس jsdom معاً**،
 * وأخطرها **الاستطلاع** لأنه أحد مسارَي العطل الأصلي (`ARCHIVE/m6j-brief.md` §١).
 * فالقاعدة: **كل قراءة لـ`.error`/`.message` في ملفات التشغيل خارج `errText`
 * و`bridgeError` يجب أن تكون مُعلَنة هنا باسمها وعددها وتعليلها** — وقراءة جديدة
 * (أو زيادة في عدد قائم) تُسقط الحارس. والبديل الصحيح لمن كتب عرضاً جديداً:
 * يمرّره بـ`errText`.
 *
 * والعدّ **جارف** (يشمل ما وقع داخل نصّ حرفيّ) عمداً: الجارف لا يُفلت قراءة حقيقية،
 * والزائد **يُسمّى بموضعه** فيُعلَن أو يُزال — بخلاف عدّ يحتاج تجريد النصوص فيُخفي
 * ما فيه. والنصوص المعلَنة أدناه كلها **ليست من نصّ التطبيق**: أخطاء المتصفّح نفسه،
 * وحقل الطلب، وأخطاء النقل في الناقل — و`background.js` يمرّر حمولة الجسر خامّة
 * (`sendResponse({ ok: true, resp: r })`) فلا يُسقط `code`.
 */
const RAW_READS = [
  {
    file: 'content.js', n: 1, re: /chrome\.runtime\.lastError\.message/,
    why: 'خطأ المتصفّح نفسه عند فشل `sendMessage` — نصّ كروم الإنجليزي، ولا رمز جسر له',
  },
  {
    file: 'content.js', n: 1, re: /String\(\(e && e\.message\) \|\| e\)/,
    why: 'ردّ رسالة `watch-toggle` إلى النافذة (`sendResponse`) — لا يُعرض: النافذة تعرض نصّها من جدولها (`watch.needPlayer`)',
  },
  {
    file: 'popup.js', n: 1, re: /chrome\.runtime\.lastError\.message/,
    why: 'خطأ المتصفّح نفسه في `ask()` — لا نصّ التطبيق',
  },
  {
    file: 'background.js', n: 1, re: /chrome\.runtime\.lastError\.message/,
    why: 'خطأ المتصفّح عند انقطاع منفذ المضيف — لا نصّ حمولة',
  },
  /* ويُقدَّم على `e.message` العامّ عمداً: المطابقة تأخذ **أوّل إعلان** يطابق السياق،
   * فالإعلان الأخصّ يجب أن يسبق الأعمّ وإلا حُسبت قراءتان على مدخل الستّة فسقط العدّ. */
  {
    file: 'background.js', n: 2, re: /\(err && err\.message\)/,
    why: 'خطأ `contextMenus` من المتصفّح نفسه (`chrome.runtime.lastError` في `removeAll` و`create`) — لا نصّ حمولة؛ ويُقرأ **داخل النداء الراجع** لئلا يبقى «غير مُلتقَط»، ويُعلَن في السجلّ (`console.error`) ولا يُكتَم — وهو إصلاح عطل «Cannot create item with duplicate id» الميداني',
  },
  {
    file: 'background.js', n: 2, re: /msg\.message/,
    why: 'حقل **الطلب** (`msg.message`) لا الخطأ: الرسالة المُرسَلة إلى المضيف',
  },
  {
    file: 'background.js', n: 6, re: /e\.message/,
    why: 'أخطاء **النقل** في الناقل (منفذ مقطوع · مهلة · `postMessage`) — تُمرَّر للنافذة/السجلّ ولا نصّ حمولة فيها',
  },
];

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
  const runtimeSrc = {};
  for (const rel of RUNTIME_RELS) runtimeSrc[rel] = read(root, rel);

  const { declared, order, sites, subDeclared, subOrder, subReturned } = readBridgeCodes(bridgeSrc);

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
  /* وصفر مدخل في طبقة الرموز الفرعية: كتلة `SUB_ENGINE_*` ومُصنِّفها — وإلا
     كان «كل رمز فرعي له ترجمة» صحيحاً بلا معنى (المجموعة فارغة). */
  if (subDeclared.size === 0) {
    throw new GuardError(
      `صفر مدخل: لا ثابت رمز فرعي واحد (\`pub const SUB_ENGINE_X: &str = "…";\`) في ${BRIDGE_REL} — لا شيء يُقاس`
    );
  }
  if (subReturned === null) {
    throw new GuardError(
      `صفر مدخل: دالّة \`${SUB_CLASSIFIER}\` غير مقروءة في ${BRIDGE_REL} — نصف العقد (التصنيف) غير مقيس`
    );
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

  /* ══ ④ب طبقة الرموز الفرعية (ط-١٢ · البند ٤) ══════════════════════════════
   * **العطل الذي وُلدت لأجله**: `code.engine_error` وحده لا يقول **أيّ** عطل،
   * فكان `{e}` يُملأ بـ`detail` الخام العربي ⇒ عربيةٌ داخل جملة إنجليزية. فالحرس
   * هنا يقيس الطبقة الثانية كما يقيس الأولى: تسعة رموز في الرست ⇄ مدخلات
   * `sub.*` في جدولَي الإضافة **بالاتجاهين** ⇄ خريطة `SUB_KEYS` الثابتة. */

  /* شكل الرمز الفرعي وقيمته غير المكرّرة. */
  const badSubShape = subOrder.filter((n) => !CODE_RE.test(subDeclared.get(n)));
  ok(
    `شكل كل رمز فرعي ASCII بـsnake_case (${subDeclared.size} رمزاً)`,
    badSubShape.length === 0,
    badSubShape.map((n) => `${n} = "${subDeclared.get(n)}"`).join(' · ')
  );
  const subValues = subOrder.map((n) => subDeclared.get(n));
  const dupSubValues = subValues.filter((v, i) => subValues.indexOf(v) !== i);
  ok('لا قيمة رمز فرعي مكرَّرة بين ثابتين', dupSubValues.length === 0, dupSubValues.join(' · '));

  /* وكل رمز فرعي معلَن **يُرجعه المُصنِّف** — وإلا فعقدٌ وهمي. */
  const neverReturned = subOrder.filter((n) => !subReturned.includes(n));
  ok(
    `كل رمز فرعي معلَن يُرجعه \`${SUB_CLASSIFIER}\` فعلاً (${subOrder.length} رمزاً)`,
    neverReturned.length === 0,
    neverReturned.map((n) => `${n} معلَن ولا يُرجعه المُصنِّف`).join(' · ')
  );
  /* والعكس: لا ثابت يُرجعه المُصنِّف بلا إعلان (خطأ تصريف أصلاً، لكن يُسمّى). */
  const returnedUndeclared = subReturned.filter((n) => !subDeclared.has(n));
  ok(
    `ولا ثابت يُرجعه المُصنِّف بلا إعلان (${subReturned.length} مُرجَعاً)`,
    returnedUndeclared.length === 0,
    returnedUndeclared.join(' · ')
  );

  /* و`subcode`/`detail` يُضافان **لعطل المحرّك وحده**: لو أُضيفا لكل رمز لصار
   * الرمز الفرعي يدّعي تصنيفاً لا معنى له، ولو حُذفا لضاع السبب. */
  const subUnderEngine = CALL_NAMES.filter((n) => {
    const body = rustFnBody(bridgeSrc, n);
    if (!body) return true;
    return !/if\s+code\s*==\s*E_ENGINE\s*\{[\s\S]*?"subcode"[\s\S]*?"detail"[\s\S]*?\}/.test(body);
  });
  ok(
    `حمولتا ${CALL_NAMES.join(' و')} تُضيفان \`subcode\` و\`detail\` تحت \`code == E_ENGINE\` وحده`,
    subUnderEngine.length === 0,
    subUnderEngine.map((n) => `${n} لا يقيّد الحقلين بـE_ENGINE`).join(' · ')
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

    /* ④ج كل حالة **تُرجع ترجمتها** (`t('code.<نفسها>')`) — لا `raw` ولا نصّاً عامّاً.
     * عطب أثبته الجاسوس (Ⓒ): المدخل قائم والحالة قائمة، لكن جسمها يُرجع النصّ
     * الخام ⇒ العربية تعود إلى الواجهة الإنجليزية، وحارس الرموز وحده **يمرّ**. */
    const chunks = caseChunks(tableSrc[rel]);
    const silent = (chunks || []).filter((c) => c.code && !c.body.includes(`t('code.${c.code}')`));
    ok(
      `[${short}] وكل حالة في \`errText\` تُرجع ترجمتها (\`t('code.<نفسها>')\`)`,
      Array.isArray(chunks) && chunks.length > 0 && silent.length === 0,
      !Array.isArray(chunks) || chunks.length === 0
        ? 'دالّة `errText` أو حالاتها غير مقروءة'
        : silent.map((c) => `الحالة \`${c.code}\` لا تُرجع \`t('code.${c.code}')\``).join(' · ')
    );

    /* ── ④د طبقة الرموز الفرعية: الرست ⇄ `sub.*` ⇄ خريطة `SUB_KEYS` ────────── */
    const subCodes = subOrder.map((n) => subDeclared.get(n));
    ok(
      `[${short}] لكل رمز فرعي مُرجَع مدخل \`sub.<رمز>\` في الجدول (${subCodes.length} رمزاً)`,
      diff(subCodes, t.subAr).length === 0,
      'ينقص الجدول: ' + (diff(subCodes, t.subAr).join(' · ') || '—')
    );
    ok(
      `[${short}] ولا مدخل \`sub.*\` بلا رمز فرعي في الرست (زائد = سقوط)`,
      diff(t.subAr, subCodes).length === 0,
      'مدخل بلا رمز في الرست: ' + (diff(t.subAr, subCodes).join(' · ') || '—')
    );
    ok(
      `[${short}] مدخل الرمز الفرعي قائم في اللغتين (ar/en)`,
      sameSet(t.subAr, t.subEn),
      'فرق: ' + (diff(t.subAr, t.subEn).concat(diff(t.subEn, t.subAr)).join(' · ') || '—')
    );

    /* وخريطة `SUB_TEXT`: مفاتيحها هي الرموز، وقيمها مفاتيح نصّ **حرفية** قائمة
     * فعلاً — فلا رمزٌ بلا مدخل في الخريطة، ولا قيمة تشير إلى مفتاح غير موجود
     * (تُرجع `undefined` فتُعرض فاضلة في واجهة المستخدم)، ولا مفتاح محسوب. */
    const subMap = readSubMap(tableSrc[rel]);
    ok(
      `[${short}] خريطة \`SUB_TEXT\` الثابتة تغطّي الرموز التسعة (${subCodes.length})`,
      subMap !== null && sameSet([...subMap.keys()], subCodes),
      subMap === null
        ? 'خريطة `SUB_TEXT` غير مقروءة'
        : 'فرق: ' + (diff(subCodes, [...subMap.keys()]).concat(diff([...subMap.keys()], subCodes)).join(' · ') || '—')
    );
    const dangling = subMap
      ? [...subMap.entries()].filter(([code, key]) => key !== `sub.${code}` || !t.subAr.includes(code))
      : [];
    ok(
      `[${short}] وكل قيمة في \`SUB_TEXT\` مفتاحها \`sub.<رمزها>\` وهو قائم في الجدول`,
      subMap !== null && dangling.length === 0,
      dangling.map(([k, v]) => `${k} ⇒ ${v}`).join(' · ') || (subMap === null ? 'خريطة `SUB_TEXT` غير مقروءة' : '—')
    );
    /* وكل مفتاح `sub.*` **يُستهلك فعلاً** بمفتاح حرفيّ في الملف — وإلا فهو مدخل
     * ميت يوهم بتغطية غير قائمة (وهو ما كان سيقع لو كُتبت القيمة `t(subKey)`). */
    const noCom = stripComments(tableSrc[rel]);
    const unread = t.subAr.filter((code) => !noCom.includes(`t('sub.${code}')`));
    ok(
      `[${short}] وكل مفتاح \`sub.*\` يُستهلك بنداء \`t('sub.<رمز>')\` حرفيّ (${t.subAr.length} مفتاحاً)`,
      unread.length === 0,
      'بلا مستهلك: ' + (unread.join(' · ') || '—')
    );

    /* و`errText` **تستهلك** الرمز الفرعي فعلاً: الحالة قائمة والمدخلات قائمة،
     * لكن لو بقيت `case 'engine_error': return fill(t('code.engine_error'), {e: raw})`
     * لمرّ كل ما سبق والعربية تعود إلى الواجهة الإنجليزية — وهو العطب نفسه. */
    const engineChunk = (chunks || []).find((c) => c.code === 'engine_error');
    const consumes = !!engineChunk
      && /\bsubcode\b/.test(engineChunk.body)
      && /\bSUB_TEXT\b/.test(engineChunk.body)
      && engineChunk.body.includes(`t('code.engine_error')`);
    ok(
      `[${short}] حالة \`engine_error\` تستهلك \`subcode\` عبر \`SUB_TEXT\` (وتبقي النصّ الخام احتياطاً)`,
      consumes,
      !engineChunk
        ? 'لا حالة `engine_error` في `errText`'
        : 'الحالة لا تقرأ `subcode`/`SUB_TEXT`، أو أسقطت `t(\'code.engine_error\')` الاحتياطية'
    );

    /* ومفتاح الوقوع الاحتياطي (تفصيل عربي بلا رمز ⇒ جملة إنجليزية) قائم في
     * اللغتين — وإلا عرضت الحالة مفتاحاً غير معرَّف فسقطت إلى العربية. */
    ok(
      `[${short}] مفتاح الوقوع \`${UNTRANSLATED_KEY}\` قائم في اللغتين`,
      typeof t.untranslated.ar === 'string' && t.untranslated.ar !== ''
        && typeof t.untranslated.en === 'string' && t.untranslated.en !== '',
      `ar=${JSON.stringify(t.untranslated.ar)} en=${JSON.stringify(t.untranslated.en)}`
    );
    /* والقيمة الإنجليزية **بلا محرف عربي**: هي بعينها الجملة التي تُعرض لقارئ
     * إنجليزي حين لا رمز فرعي — فلو حملت عربية لعاد العطل من بابه الرابع. */
    ok(
      `[${short}] ونصّها الإنجليزي بلا محرف عربي`,
      typeof t.untranslated.en === 'string' && !/[\u0600-\u06FF]/.test(t.untranslated.en),
      `en=${JSON.stringify(t.untranslated.en)}`
    );
  }

  /* ④ب قاعدة العرض: لا قراءة `.error`/`.message` خارج `errText`/`bridgeError`
   * إلّا بما هو **مُعلَن بالاسم والعدد والتعليل** في `RAW_READS` (ث١). */
  const readReport = [];
  for (const rel of RUNTIME_RELS) {
    const short = rel.replace(/\\/g, '/').replace('browser-extension/', '');
    const noCom = stripComments(runtimeSrc[rel]);
    const sanctioned = SANCTIONED_FNS
      .map((n) => fnSpan(noCom, n))
      .filter(Boolean)
      .map((s) => [s.start, s.end]);
    const inside = (at) => sanctioned.some(([a, b]) => at > a && at < b);
    const outside = [];
    for (const m of noCom.matchAll(RAW_READ_RE)) {
      if (!inside(m.index)) outside.push({ at: m.index, line: lineOf(runtimeSrc[rel], m.index), text: m[0] });
    }
    const declared = RAW_READS.filter((d) => d.file === short);
    const unmatched = [];
    const counts = new Map(declared.map((d) => [d, 0]));
    for (const hit of outside) {
      const d = declared.find((x) => x.re.test(noCom.slice(Math.max(0, hit.at - 60), hit.at + 60)));
      const ctx = runtimeSrc[rel].slice(Math.max(0, hit.at - 24), hit.at + 14).replace(/\s+/g, ' ');
      if (!d) unmatched.push(`سطر ${hit.line}: …${ctx}…`);
      else counts.set(d, counts.get(d) + 1);
    }
    const wrong = [...counts.entries()].filter(([d, n]) => n !== d.n)
      .map(([d, n]) => `${d.re} — المتوقَّع ${d.n} ووُجد ${n}`);
    ok(
      `[${short}] كل قراءة \`.error\`/\`.message\` خارج ${SANCTIONED_FNS.join('/')} مُعلَنة بالاسم والعدد (${outside.length} قراءة · ${declared.length} إعلاناً)`,
      unmatched.length === 0 && wrong.length === 0,
      [unmatched.length ? 'غير مُعلَنة: ' + unmatched.join(' · ') : '', wrong.length ? 'عدد مخالف: ' + wrong.join(' · ') : '']
        .filter(Boolean).join(' — ')
    );
    readReport.push({ file: short, outside: outside.length, declared: declared.length });
  }

  /* وصفر مدخل في القاعدة نفسها: الدالّتان المصرَّح بهما موجودتان فعلاً — وإلا
   * فالقاعدة تقيس الفراغ (لا موضع مصرَّح ⇒ كل قراءة «خارج» ⇒ سقوط كاذب، أو العكس). */
  for (const rel of TABLE_RELS) {
    const short = rel.replace(/\\/g, '/').replace('browser-extension/', '');
    const missing = SANCTIONED_FNS.filter((n) => !fnSpan(stripComments(runtimeSrc[rel]), n));
    ok(`[${short}] الدالّتان المصرَّح بهما قائمتان (${SANCTIONED_FNS.join(' · ')})`,
      missing.length === 0, 'مفقودة: ' + (missing.join(' · ') || '—'));
  }

  const allCheckCount = checks.length;
  return { checks: allCheckCount, failures, codes, declared, order, sites, tables, readReport };
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
  const r = audit(root, quiet ? () => {} : (line) => console.log(line));
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

/** جذر مصنوع: نسخ **الملفات المشحونة نفسها** (المقيس هو المشحون لا نسخة منه) —
 *  الرست + ملفات التشغيل الثلاثة (`content.js` · `popup.js` · `background.js`). */
function writeFixture(root, { noBridge = false, emptyBridge = false } = {}) {
  const copies = [
    [BRIDGE_REL, path.join(ROOT_DEFAULT, BRIDGE_REL)],
    ...RUNTIME_RELS.map((rel) => [rel, path.join(ROOT_DEFAULT, rel)]),
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
    /* Ⓔ مُفسَد (و): **قراءة خامّة في مسار عرض** — الاستطلاع يعرض `st.last.error`
       مباشرةً بدل `errText` (وهو مُفسَد الجاسوس Ⓓ بعينه: مرّ على حارس الرموز
       وحارس jsdom معاً قبل هذه القاعدة). ⇒ يسقط بموضعه. */
    {
      const dir = writeFixture(path.join(work, 'mutant-raw-read'));
      edit(dir, TABLE_RELS[0],
        "toast('✗ ' + errText(st.last, t('poll.failed')), 4000);",
        "toast('✗ ' + String(st.last.error), 4000);");
      const res = runChild(dir);
      add(
        'Ⓔ مُفسَد (و): مسار عرض يقرأ `.error` خامّاً خارج errText ⇒ يسقط بموضعه',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'غير مُعلَنة', 'st.last.error']
      );
    }

    /* Ⓕ مُفسَد (ز): حالة `case` قائمة لا تُرجع ترجمتها (مُفسَد الجاسوس Ⓒ:
       حارس الرموز وحده كان يمرّ عليه). ⇒ يسقط مسمّياً الحالة. */
    {
      const dir = writeFixture(path.join(work, 'mutant-silent-case'));
      edit(dir, TABLE_RELS[0],
        "      case 'duplicate_link': return t('code.duplicate_link');",
        "      case 'duplicate_link': return raw;");
      const res = runChild(dir);
      add(
        'Ⓕ مُفسَد (ز): حالة في errText لا تُرجع ترجمتها ⇒ يسقط مسمّياً الحالة',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'لا تُرجع', 'duplicate_link']
      );
    }
    /* Ⓖ مُفسَد (ح): **مسار لا يمكن قيادته حيّاً** — جلب الصوت (`content.js:781`)
       يقرأ `e.message` خامّاً. مُفسَد الجاسوس Ⓕ كان يمرّ على الحارسين معاً، وهذا
       المسار يحتاج `Audio`/decode حقيقيين فلا يقوده القياس الحيّ: فالقاعدة
       البنيوية هي وحدها ما يمسكه، ولهذا لها مُفسَد دائم هنا. */
    {
      const dir = writeFixture(path.join(work, 'mutant-raw-read-fetch'));
      edit(dir, TABLE_RELS[0],
        "toast('✗ ' + errText(e, t('fetch.failed')), 4000);",
        "toast('✗ ' + String(e && e.message), 4000);");
      const res = runChild(dir);
      add(
        'Ⓖ مُفسَد (ح): جلب الصوت يقرأ `e.message` خامّاً (مسار لا يُقاس حيّاً) ⇒ يسقط',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'غير مُعلَنة', 'e.message']
      );
    }

    /* Ⓗ مُفسَد (ط): **بطاقة الاكتمال في النافذة** (`popup.js` — `renderCompleted`)
       تقرأ `last.error` خامّاً. وهو مُفسَد الجاسوس Ⓖ بعينه: مرّ على حارس الرموز
       وحارس jsdom معاً قبل قاعدة العرض. فالمواضع الثلاثة التي سمّاها الجاسوس صار
       لكلٍّ منها مُفسَد دائم هنا (Ⓔ الاستطلاع · Ⓖ جلب الصوت · Ⓗ بطاقة الاكتمال)
       — وهي بعينها «ط-١٠» في `docs/BACKLOG-0.3.md`، والحارس صار يراها كلها. */
    {
      const dir = writeFixture(path.join(work, 'mutant-raw-read-completed'));
      edit(dir, TABLE_RELS[1],
        "    : fill(t('done.failed'), { e: errText(last, t('err.unknown')) });",
        "    : fill(t('done.failed'), { e: String(last.error || '') });");
      const res = runChild(dir);
      add(
        'Ⓗ مُفسَد (ط): بطاقة الاكتمال في popup.js تقرأ `last.error` خامّاً (مُفسَد الجاسوس Ⓖ) ⇒ يسقط',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'غير مُعلَنة', 'last.error']
      );
    }

    /* ── طبقة الرموز الفرعية (`subcode` — ط-١٢ · البند ٤) ─────────────────────
     * أربعة مُفسَدات تقابل الأربعة التي تحرسها الطبقة: ناقص · زائد · خريطة
     * ناقصة · وحالة لا تستهلك الرمز. ولولاها لكان التوسيع **زينة**: يمرّ على
     * الشجرة السليمة ولا يرى عطباً. */

    /* Ⓘ مُفسَد (ي): مدخل `sub.engine_io` محذوف من جدول content.js والرمز ما زال
       يُرجعه المُصنِّف ⇒ يسقط بالاتجاه الأول (الرست ⇐ الجدول). */
    {
      const dir = writeFixture(path.join(work, 'mutant-drop-sub'));
      edit(dir, TABLE_RELS[0], "      'sub.engine_io': 'خطأ ملفات أثناء الفصل',\n", '');
      const res = runChild(dir);
      add(
        'Ⓘ مُفسَد (ي): مدخل `sub.*` محذوف من الجدول ⇒ يسقط (رمز فرعي بلا مقابل)',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'ينقص الجدول', 'engine_io']
      );
    }

    /* Ⓙ مُفسَد (ك): مدخل `sub.ghost_probe` زائد بلا رمز فرعي في الرست ⇒ يسقط
       (مدخل ميت يوهم بتغطية غير قائمة). */
    {
      const dir = writeFixture(path.join(work, 'mutant-extra-sub'));
      edit(dir, TABLE_RELS[0], "      'sub.engine_other': 'عطل محرّك غير مصنَّف',",
        "      'sub.engine_other': 'عطل محرّك غير مصنَّف',\n      'sub.ghost_probe': 'مدخل بلا رمز',");
      const res = runChild(dir);
      add(
        'Ⓙ مُفسَد (ك): مدخل `sub.*` زائد بلا رمز فرعي في الرست ⇒ يسقط',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'مدخل بلا رمز في الرست', 'ghost_probe']
      );
    }

    /* Ⓚ مُفسَد (ل): رمز غاب من خريطة `SUB_TEXT` ⇒ يسقط مسمّياً الرمز. */
    {
      const dir = writeFixture(path.join(work, 'mutant-sub-map'));
      edit(dir, TABLE_RELS[0], "    engine_io: () => t('sub.engine_io'),\n", '');
      const res = runChild(dir);
      add(
        'Ⓚ مُفسَد (ل): رمز فرعي غائب من خريطة `SUB_TEXT` ⇒ يسقط مسمّياً',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'SUB_TEXT', 'engine_io']
      );
    }

    /* Ⓛ مُفسَد (م): الحالة تعود إلى `{ e: raw }` فلا تستهلك الرمز الفرعي —
       **وهو العطب الأصلي بعينه** (عربية داخل جملة إنجليزية). كل الفحوص الأخرى
       تمرّ عليه: المدخلات قائمة والخريطة قائمة والحالات قائمة. */
    {
      const dir = writeFixture(path.join(work, 'mutant-sub-unused'));
      edit(dir, TABLE_RELS[0],
        "        const say = SUB_TEXT[String((err && err.subcode) || '')];\n        if (say) return say();\n",
        '');
      const res = runChild(dir);
      add(
        'Ⓛ مُفسَد (م): حالة `engine_error` لا تستهلك `subcode` (العطب الأصلي) ⇒ يسقط',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'تستهلك']
      );
    }

    /* Ⓛ′ مُفسَد (م′): الخريطة موجودة والمفاتيح قائمة، لكن قيمةً صارت `t(subKey)`
       **مفتاحاً محسوباً** — وهي الصيغة التي كُتبت أولاً وسقطت على §٢٦ وحارس
       المفتاح الميت. فهذا مُفسَد دائم يمنع الرجوع إليها. */
    {
      const dir = writeFixture(path.join(work, 'mutant-sub-computed'));
      edit(dir, TABLE_RELS[0],
        "    engine_io: () => t('sub.engine_io'),",
        "    engine_io: () => t('sub.' + 'engine_io'),");
      const res = runChild(dir);
      add(
        'Ⓛ′ مُفسَد (م′): قيمة الخريطة بمفتاح محسوب ⇒ يسقط (مفتاح غير مستهلك + §٢٦)',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر']
      );
    }

    /* Ⓜ مُفسَد (ن): قيمة رمز فرعي في الرست مُبدَّلة بحرف ⇒ يسقط (الرست ⇄ الجدول
       يُقاس **بالقيمة** لا بالاسم، وإلا مرّ تبديل قيمة صامتاً). */
    {
      const dir = writeFixture(path.join(work, 'mutant-sub-value'));
      edit(dir, BRIDGE_REL, 'pub const SUB_ENGINE_IO: &str = "engine_io";',
        'pub const SUB_ENGINE_IO: &str = "engine_io_probe";');
      const res = runChild(dir);
      add(
        'Ⓜ مُفسَد (ن): قيمة رمز فرعي مُبدَّلة في الرست ⇒ يسقط (القياس بالقيمة)',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس رموز الجسر', 'engine_io_probe']
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
