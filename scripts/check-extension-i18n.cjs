#!/usr/bin/env node
/* حارس تعريب الإضافة — node scripts/check-extension-i18n.cjs
 *
 * ثلاث طبقات، وكلٌّ منها تُسقط الحارس برسالة **تسمّي الملف والسطر**:
 *
 *   ① **لا نصّ واجهة عربي خارج جدول الترجمة** — بعد `stripComments`، وبالمرشّح
 *      **الواسع**: أي نصّ حرفيّ يحمل محرفاً عربياً واحداً على الأقل. والواسع هو
 *      المعتمد لا الضيّق، لأن المختلط («HaramLite — جاهز للمشاهدة») يبقى عربياً
 *      عند مستخدم إنجليزي. والقوالب تُفحص كذلك، **و`${…}` يُجرَّد منها** فيُقاس
 *      النصّ الظاهر وحده (وإلا حُسب كود التعبير نصّاً عربياً).
 *   ② **تكافؤ مفاتيح `ar`/`en` في الاتجاهين** — كل مفتاح في العربية له إنجليزيّ
 *      وبالعكس، ولا قيمة فارغة/بيضاء، ولا مفتاح مكرَّر (المكرَّر يُسقط الذي قبله
 *      صامتاً في JS فهو عطب لا تكرار).
 *   ③ **صفر مدخل يفشل بصوت عالٍ** — لو لم يرَ الحارس نصّاً عربياً واحداً (ملف
 *      مُفرَّغ · جدول حُذف · مسار خاطئ) فهو **يسقط** ولا يعلن نجاحاً فارغاً.
 *
 * واختيار اللغة يُقاس سلوكياً: تُستخرج `pickLang` النقية وتُختبر بمدخلات مصنوعة
 * بلا متصفّح، فيُثبت أن الاختيار مشتغل وأن غير العربية/الإنجليزية ينتهي للإنجليزية.
 *
 * **نطاق المسح (توسيع م٦-ب)**: كان الحارس يقيس `content.js` وحده (كما في
 * `check-extension-sync.cjs:16`). والآن يقيس **كل ملفات تشغيل الإضافة**، ولكل
 * نوع قواعده المُعلَنة:
 *
 *   · `content.js` · `popup.js` · `background.js` — الطبقات ①②③ كما هي، **وبقي
 *     `content.js` على ٢٣ فحصاً بالضبط**: القيود الجديدة تُعلَن لكل ملف على حِدة
 *     (`opts.declared`) و`content.js` لا يُعلن منها شيئاً، فلم يُحذف ولم يُغيَّر
 *     فحص واحد من فحوصه.
 *   · `popup.html` — **صفر محرف عربي خارج تعليقات HTML** (لا جدول فيه أصلاً:
 *     كل نصّ واجهة مربوط بمفتاح `data-i18n`)، وكل مفتاح مربوط **يُفحص وجوده في
 *     جدول `popup.js`** في اللغتين، وعدد مواضع الربط **بعدد معلَن** — فموضع ربط
 *     جديد أو مفتاح مجهول يُسقط الحارس مسمّياً الملف والمفتاح.
 *   · `manifest.json` + `_locales/<لغة>/messages.json` — الاتجاه معكوس: المانيفست
 *     **صفر عربية**، والعربية في جدول `_locales`. ويُقاس: تكافؤ مفاتيح اللغات في
 *     الاتجاهين · لا عربية في قيم `en` · عربية في قيم `ar` · كل `__MSG_x__` في
 *     المانيفست **معرَّف** في كل لغة (وإلا عرض المتصفّح `__MSG_x__` حرفياً) · وكل
 *     مفتاح في `messages.json` **مستعمل** (`__MSG_x__` غير معرَّف = عطب، ومفتاح
 *     غير مستعمل = وهم تغطية) · `default_locale` قائم فعلاً.
 *
 * **وموضعان محسوبان لـ`t(` في `popup.js`** (قارئا `data-i18n`) مسموحان بعدد
 * وتعليل — على نمط `DYN_SITES` نفسه: المحسوب هناك **مجموعة مغلقة** يفحص
 * `auditHtml` وجود كل عنصرها في الجدول، فلا يُخترق بمفتاح لم يُفكَّر به.
 *
 * **ووضعان للتوافق** يُبقيان المقيس الواحد كما كان حرفياً، لأنهما يستعملهما
 * `check-guards-selfcheck.cjs` و`check-extension-i18n-mutants.cjs`:
 *   `--file <مسار>` ملف واحد · `--root <مجلد>` ⇒ `<المجلد>/browser-extension/content.js`.
 * والمسح الموسَّع هو **الافتراضي** (بلا علم) — وهو ما يشغّله `pnpm ext:guard`.
 * والأعلام **معلنة كلها** فوسيط مجهول يُسقط الحارس بـ2 ولا يُتجاهل صامتاً.
 */
const fs = require('fs');
const path = require('path');

const AR = /[\u0600-\u06FF]/;

/* ── الوسائط ───────────────────────────────────────────────────────────────
 * تُقرأ **عند التشغيل المباشر وحده**: هذا الملف يُستورَد أيضاً من
 * `check-extension-i18n-mutants.cjs` (ليأخذ `audit`)، ولو قرأ `process.argv`
 * عند الاستيراد لرأى أعلام الحاكم وأسقطه بـ«وسيط غير معروف». */
const MAIN = require.main === module;
const REPO = path.resolve(__dirname, '..');
let FILE = path.join(REPO, 'browser-extension', 'content.js');
/* هل طُلب **المقيس الواحد** صراحةً؟ (`--file` أو `--root`). وإن لم يُطلب فالمسح
 * الموسَّع على كل ملفات التشغيل هو الافتراضي — فبوّابة `pnpm ext:guard` لا تبقى
 * عمياء عن `popup.js`/`popup.html`/`background.js`/`manifest.json`. */
let EXPLICIT = false;

if (MAIN) {
  const argv = process.argv.slice(2);
  let fileArg = null, rootArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '--root') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
        console.error('✗ العلم ' + a + ' يحتاج قيمة');
        process.exit(2);
      }
      if (a === '--file') fileArg = argv[++i]; else rootArg = argv[++i];
    } else {
      console.error('✗ وسيط غير معروف: ' + a);
      process.exit(2);
    }
  }
  EXPLICIT = !!(fileArg || rootArg);
  FILE = fileArg
    ? path.resolve(fileArg)
    : path.join(rootArg ? path.resolve(rootArg) : REPO, 'browser-extension', 'content.js');
}

/* ── عدّاد الفحوص ────────────────────────────────────────────────────────── */
let checks = 0;
const failures = [];
function ok(label, cond, detail) {
  checks++;
  if (!cond) failures.push(detail ? label + ' — ' + detail : label);
  console.log('  ' + (cond ? '✓' : '✗') + ' ' + label);
}

/* ══ مُحلِّل النصوص الحرفية ══════════════════════════════════════════════════
 * يمشي على النصّ محرفاً محرفاً فيعرف: التعليقات (// و /* *​/)، والهروب `\x`،
 * والنصوص المفردة/المزدوجة، والقوالب `` ` `` **بتعبيراتها المتداخلة** (`${…}`
 * وما فيها من نصوص وقوالب وقويسات متوازنة). ويعيد لكل نصّ حرفيّ: نوعه، وسطر
 * بدايته، وإزاحته، ونصّه الخام.
 *
 * ولماذا مُحلِّل ولا تعبير نمطي: القالب ذو التعبير المتداخل (`${a ? `x${b}` : ''}`)
 * لا يُطابقه تعبير نمطي أمين، والمقيس في هذا الملف قالب متداخل فعلاً (سطر
 * watchLine قبل التعريب). وكل حكم هنا **مبنيّ على هذا المُحلِّل**، فيجب أن يكون أميناً.
 *
 * `keepExpr` = false ⇒ يُستبدل كل `${…}` بـ'' فيُقاس النصّ الظاهر وحده.
 * و**الهروب يُفكّ** (`\u0646` ⇒ `ن` · `\x41` ⇒ `A`): بدونه كان نصّ عربي مكتوب
 * بالمفاتيح يُفلت من المرشّح — وهو ثقب قيس فعلاً بمُفسَد (⑧) قبل هذا الإصلاح.
 */

/** يفكّ هروباً واحداً ابتداءً من `i` (الذي يشير إلى `\`)، ويعيد [المحرف، الطول]. */
function decodeEscape(text, i) {
  const c = text[i + 1];
  if (c === undefined) return ['\\', 1];
  if (c === 'u') {
    if (text[i + 2] === '{') {
      const close = text.indexOf('}', i + 3);
      if (close > 0) {
        const hex = text.slice(i + 3, close);
        if (/^[0-9a-fA-F]+$/.test(hex)) {
          const cp = parseInt(hex, 16);
          if (cp <= 0x10FFFF) return [String.fromCodePoint(cp), close - i + 1];
        }
      }
      return ['u', 2];
    }
    const hex = text.substr(i + 2, 4);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) return [String.fromCharCode(parseInt(hex, 16)), 6];
    return ['u', 2];
  }
  if (c === 'x') {
    const hex = text.substr(i + 2, 2);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) return [String.fromCharCode(parseInt(hex, 16)), 4];
    return ['x', 2];
  }
  if (c === 'n') return ['\n', 2];
  if (c === 'r') return ['\r', 2];
  if (c === 't') return ['\t', 2];
  if (c === '0') return ['\0', 2];
  // `\'` · `\"` · `` \` `` · `\\` · وأي محرف آخر ⇒ المحرف نفسه بلا الشرطة المائلة.
  return [c, 2];
}

function scanLiterals(text, keepExpr) {
  const out = [];
  let i = 0, line = 1;
  const n = text.length;
  /* آخر رمز ذي دلالة — يميّز بداية **تعبير نمطي** من **قسمة**. بدونه كان
   * `/نصّ/` يُقرأ بداية سلسلة فيبتلع نصَّين حرفيين حتى القوس التالي، فتُفقد
   * عربية حقيقية (قيس بمحاولتَي إخفاء في تعبير نمطي). */
  let prev = '';

  const push = (rec) => out.push(rec);
  /** هل يصلح `/` هنا بداية تعبير نمطي؟ (قاعدة معروفة: يسبقه عامل أو فاتح أو كلمة مفتاحية) */
  const regexAllowed = () => prev === '' || /[=(,:[!&|?{};+\-*%^~<>]/.test(prev) ||
    /^(?:return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)$/.test(prev);

  while (i < n) {
    const c = text[i], d = text[i + 1];

    if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; prev = ';'; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; } i += 2; continue; }

    if (c === '/' && regexAllowed()) {
      // تعبير نمطي: يُتخطّى كاملاً (صنف المحارف `[…]` يحمي `/` داخله، والهروب `\/`)
      i++;
      let inClass = false;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/.test(text[i])) i++;   // الأعلام g i m s u y d
      prev = ')';                                   // نتاجه قيمة
      continue;
    }

    if (c === "'" || c === '"') {
      const q = c, startLine = line, start = i;
      let s = c; i++;
      while (i < n && text[i] !== q) {
        if (text[i] === '\\') { const [ch, len] = decodeEscape(text, i); s += ch; i += len; continue; }
        s += text[i]; i++;
      }
      if (i < n) { s += text[i]; i++; }
      push({ kind: 'str', text: s, start, end: i, line: startLine });
      prev = ')';
      continue;
    }

    if (c === '`') {
      /* القالب يُقرأ **بتعبيراته**: كل `${…}` يُمسح مسحاً كاملاً (بتوازن الأقواس
       * وبمعرفة النصوص والتعليقات والقوالب المتداخلة داخله) فتُلتقط النصوص
       * الحرفية التي فيه **كتسجيلات مستقلة**. وهذا بالضبط ما كان يسقط: صيغة سابقة
       * كانت تُنكر القالب المتداخل داخل `${…}` فتفقد عربيته (قيس بمحاولة إخفاء
       * `toast(\`${x ? \`نصّ عربي\` : ''}\`)` ⇒ أفلتت). */
      const startLine = line, start = i;
      let s = '`';
      i++;
      for (;;) {
        if (i >= n) break;
        const e = text[i], f = text[i + 1];
        if (e === '\\') {
          const [ch, len] = decodeEscape(text, i);
          s += ch;                        // الهروب يُفكّ دائماً في نصّ القالب
          i += len;
          continue;
        }
        if (e === '`') { s += '`'; i++; break; }
        if (e === '$' && f === '{') {
          if (keepExpr) s += '${';
          i += 2;
          /* جسم التعبير: يُمسح بنفس المُحلِّل فيُلتقط كل نصّ حرفيّ فيه، وتُحفظ
           * الأسطر. والمصدر الأصلي هو المرجع لأرقام الأسطر، فالإزاحة تُزاد. */
          const exprStart = i;
          let depth = 1;
          while (i < n && depth > 0) {
            const cc = text[i], dd = text[i + 1];
            if (cc === '\n') { line++; i++; continue; }
            if (cc === '/' && dd === '/') { while (i < n && text[i] !== '\n') i++; continue; }
            if (cc === '/' && dd === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; } i += 2; continue; }
            if (cc === "'" || cc === '"' || cc === '`') {
              const q = cc;
              i++;
              if (q === '`') {
                let d2 = 0;
                while (i < n) {
                  const g = text[i], h = text[i + 1];
                  if (g === '\\') { i += 2; continue; }
                  if (g === '`' && d2 === 0) { i++; break; }
                  if (g === '$' && h === '{') { d2++; i += 2; continue; }
                  if (g === '}' && d2 > 0) { d2--; i++; continue; }
                  if (g === '\n') line++;
                  i++;
                }
              } else {
                while (i < n && text[i] !== q) { if (text[i] === '\\') i++; i++; }
                i++;
              }
              continue;
            }
            if (cc === '(' || cc === '[' || cc === '{') depth++;
            else if (cc === ')' || cc === ']' || cc === '}') { depth--; if (depth === 0) { i++; break; } }
            i++;
          }
          /* النصوص الحرفية داخل التعبير تُسجَّل مستقلة (بإزاحة حقيقية في المصدر). */
          const inner = scanLiterals(text.slice(exprStart, i - 1), false);
          for (const rec of inner) {
            push({ kind: rec.kind, text: rec.text, start: exprStart + rec.start, end: exprStart + rec.end, line: rec.line });
          }
          if (keepExpr) s += text.slice(exprStart, i - 1) + '}';
          continue;
        }
        if (e === '\n') line++;
        s += e; i++;
      }
      push({ kind: 'tpl', text: s, start, end: i, line: startLine });
      prev = ')';
      continue;
    }

    // تحديث «آخر رمز» لاكتشاف بداية التعبير النمطي في الدورة التالية.
    if (c === '\n') { line++; i++; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      prev = text.slice(i, j);
      i = j;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** يُفرّغ التعليقات **بمسافات** ويُبقي النصوص والأسطر كما هي (فتبقى الإزاحات
 *  وأرقام الأسطر صالحة). نسخة مطابقة لمنطق check-extension-sync.cjs. */
function stripComments(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; }
      if (i < text.length) { out += '  '; i += 2; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += c; i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') { out += text[i]; i++; if (i < text.length) { out += text[i]; i++; } continue; }
        out += text[i]; i++;
      }
      if (i < text.length) { out += text[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** مفاتيح `localStorage` في نصّ **بلا تعليقات** — تُقرأ **بالاسم** لا بالعدد،
 *  وإلا مرّ استبدال مفتاح بمفتاح. والمفتاح نصّ حرفيّ مباشر أو ثابت
 *  (`const MODE_KEY = 'hl.popup.mode'`) يُحلّ إلى قيمته؛ وما لم يُحلّ يظهر في
 *  الرسالة باسمه (`<UNRESOLVED:…>`) فلا يمرّ صامتاً كأنه لا مفتاح. */
function storageKeys(noCom) {
  const out = [];
  const add = (k) => { if (!out.includes(k)) out.push(k); };
  const lit = /localStorage\s*\.\s*(?:get|set|remove)Item\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = lit.exec(noCom)) !== null) add(m[2]);
  const idr = /localStorage\s*\.\s*(?:get|set|remove)Item\s*\(\s*([A-Za-z_$][\w$]*)/g;
  while ((m = idr.exec(noCom)) !== null) {
    const cm = new RegExp('(?:const|let|var)\\s+' + m[1] + '\\s*=\\s*([\'"])((?:\\\\.|(?!\\1).)*)\\1').exec(noCom);
    add(cm ? cm[2] : '<UNRESOLVED:' + m[1] + '>');
  }
  return out;
}

/** كتلة بموازنة الأقواس — **مع تجاوز النصوص والتعليقات** (خلافاً لنسخة
 *  sync التي تعمل على نصّ بلا تعليقات). تُستعمل لالتقاط جسم `I18N` كاملاً. */
function balancedBlock(text, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = text.length;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < n && text[i] !== q) { if (text[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { start: openIdx, end: i + 1, body: text.slice(openIdx + 1, i) }; }
    i++;
  }
  return null;
}

/** حدود جدول الترجمة `const I18N = { … }` — إزاحات في النصّ الخام. */
function findTable(text) {
  const m = /const\s+I18N\s*=\s*\{/.exec(text);
  if (!m) return null;
  const open = text.indexOf('{', m.index);
  const blk = balancedBlock(text, open);
  if (!blk) return null;
  return { start: m.index, open, end: blk.end, literal: text.slice(m.index, blk.end) };
}

/** مدى كل تعليق [start, end) في النصّ الخام — مع تجاوز النصوص الحرفية، فلا
 *  يُظنّ `//` داخل نصّ بداية تعليق. */
function commentRanges(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') {
      const s = i;
      while (i < n && text[i] !== '\n') i++;
      out.push([s, i]);
      continue;
    }
    if (c === '/' && d === '*') {
      const s = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      out.push([s, i]);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < n && text[i] !== q) { if (text[i] === '\\') i++; i++; }
      i++; continue;
    }
    i++;
  }
  return out;
}

/* ══ النواة: تُقاس على نصّ مُمرَّر (فتعمل المُفسَدات في الذاكرة) ═════════════
 * `opts.declared` = القيود **المُعلَنة لهذا الملف** (مفاتيح تخزين · اتجاه ومصدر
 * اللغة · عدد مواضع `t(` المحسوبة). وملف بلا `opts` — وهو `content.js` — يمرّ على
 * الطبقات ①②③ وحدها بعدد فحوصه القديم **بالضبط**.
 * `opts.externalKeys` = مفاتيح تُستعمل **خارج هذا الملف** (‏`data-i18n` في
 * `popup.html`) فتُحسب استعمالاً وتُخرج صاحبها من عداد المفاتيح الميتة. */
function audit(text, label, opts) {
  const res = { checks: 0, failures: [], counts: {}, langs: [], arabic: 0 };
  const D = (opts && opts.declared) || null;
  const externalKeys = (opts && opts.externalKeys) || [];

  const table = findTable(text);
  if (!table) {
    res.failures.push('✗ جدول الترجمة `const I18N = { … }` مفقود من ' + label +
      ' — لا شيء يُقاس، فلا نجاح.');
    return res;
  }

  /* ── ① تقييم الجدول ───────────────────────────────────────────────────── */
  let I18N = null, evalErr = null;
  try {
    I18N = new Function(table.literal + '\nreturn I18N;')();
  } catch (e) { evalErr = e && e.message ? e.message : String(e); }

  res.checks++;
  if (evalErr) {
    res.failures.push('✗ تعذّر تقييم جدول الترجمة في ' + label + ' — ' + evalErr);
    return res;
  }
  const langs = Object.keys(I18N || {});
  res.langs = langs;

  /* ── ② صفر مدخل: جدول بلا مدخلات ⇒ فشل بصوت عالٍ (§③) ─────────────────── */
  const rowsOf = (L) => (I18N[L] && typeof I18N[L] === 'object') ? I18N[L] : null;
  const ar = rowsOf('ar'), en = rowsOf('en');
  res.checks++;
  if (!ar || !en) {
    res.failures.push('✗ جدول الترجمة في ' + label + ' لا يحمل القسمين `ar` و`en` معاً (وجد: ' +
      (langs.join(' · ') || 'لا شيء') + ') — صفر مدخل، فلا نجاح.');
    return res;
  }
  const arKeys = Object.keys(ar), enKeys = Object.keys(en);
  res.counts = { ar: arKeys.length, en: enKeys.length, langs: langs.length };
  res.checks++;
  if (arKeys.length === 0 && enKeys.length === 0) {
    res.failures.push('✗ صفر مدخل: جدول الترجمة في ' + label + ' فارغ من اللغتين — لا شيء قيس.');
    return res;
  }

  /* ── ③ تكافؤ المفاتيح في الاتجاهين ────────────────────────────────────── */
  const missingEn = arKeys.filter((k) => !(k in en));
  const missingAr = enKeys.filter((k) => !(k in ar));
  res.checks++;
  if (missingEn.length) {
    res.failures.push('✗ ' + missingEn.length + ' مفتاحاً في `ar` بلا مقابل في `en` (' + label + '): ' +
      missingEn.join(' · '));
  }
  res.checks++;
  if (missingAr.length) {
    res.failures.push('✗ ' + missingAr.length + ' مفتاحاً في `en` بلا مقابل في `ar` (' + label + '): ' +
      missingAr.join(' · '));
  }

  /* ── ④ لا قيمة فارغة ولا بيضاء ───────────────────────────────────────── */
  const blank = [];
  for (const L of ['ar', 'en']) {
    for (const k of Object.keys(I18N[L])) {
      const v = I18N[L][k];
      if (typeof v !== 'string' || v.trim() === '') blank.push(L + '.' + k);
    }
  }
  res.checks++;
  if (blank.length) {
    res.failures.push('✗ قيمة فارغة أو غير نصّية في ' + label + ': ' + blank.join(' · '));
  }

  /* ── ④ب لا محرف عربي في قيمة **إنجليزية** ──────────────────────────────────
   * ثقب أثبته جاسوس مستقلّ بمُفسَد مرّ: تكافؤ **المفاتيح** كان يُقاس، وتكافؤ
   * **القيم** لا — فقيمة `en` عربية (ترجمة ناقصة) تمرّ صامتة، فيرى مستخدم
   * إنجليزي عربية في منتصف واجهته. */
  const arInEn = enKeys.filter((k) => typeof en[k] === 'string' && AR.test(en[k]));
  res.checks++;
  if (arInEn.length) {
    res.failures.push('✗ ' + arInEn.length + ' قيمة إنجليزية تحمل عربية في ' + label + ' (ترجمة ناقصة): ' +
      arInEn.map((k) => 'en.' + k + ' = «' + en[k].slice(0, 40) + '»').join(' · '));
  }

  /* ── ④ج **مجموعة مواضع العناصر النائبة** متطابقة بين ar وen ───────────────
   * `{pct}` و`{s}` تُستبدل بـ`fill`. لو غاب العنصر من إحدى اللغتين لظهرت
   * النتيجة ناقصة («جارٍ الجلب… %» بلا رقم) — أو ظهر `{pct}` حرفياً. والمقارنة
   * **مجموعةً** لا ترتيباً، فترتيب العناصر حرّ بين اللغات. */
  const holders = (s) => {
    const m = new Map();
    for (const x of String(s).matchAll(/\{(\w+)\}/g)) m.set(x[1], (m.get(x[1]) || 0) + 1);
    return m;
  };
  const phMismatch = [];
  for (const k of arKeys) {
    if (!(k in en)) continue;
    const a = holders(ar[k]), b = holders(en[k]);
    const names = new Set([...a.keys(), ...b.keys()]);
    const bad = [...names].filter((x) => (a.get(x) || 0) !== (b.get(x) || 0))
      .map((x) => x + ' (ar×' + (a.get(x) || 0) + ' · en×' + (b.get(x) || 0) + ')');
    if (bad.length) phMismatch.push(k + ': ' + bad.join(' · '));
  }
  res.checks++;
  if (phMismatch.length) {
    res.failures.push('✗ عناصر نائبة غير متطابقة بين ar وen في ' + label + ': ' +
      phMismatch.join(' · ') + ' — كل عنصر في إحدى اللغتين يجب أن يقابله مثله في الأخرى.');
  }
  res.counts.placeholderKeys = arKeys.filter((k) => holders(ar[k]).size > 0).length;
  /* «صفر عنصر نائب» **عطب** في ملف يستعملها (`content.js` يستعمل `{pct}` و`{s}`)،
   * و**وضع مشروع** في ملف لا يستعملها (`background.js`: ثلاثة عناوين قائمة بلا
   * رقم واحد). فصار العدد **مُعلَناً لكل ملف**؛ وملف بلا إعلان يبقى على السلوك
   * القديم حرفياً (صفر ⇒ فشل بصوت عالٍ) فلا يرخى شيء في `content.js`. */
  if (D && D.placeholders) {
    if (res.counts.placeholderKeys !== D.placeholders.n) {
      res.failures.push('✗ عدد المفاتيح ذات العناصر النائبة في ' + label + ': المتوقَّع ' +
        D.placeholders.n + ' ووُجد ' + res.counts.placeholderKeys +
        ' — تعليل المُعلَن: ' + D.placeholders.why + '.');
    }
  } else if (res.counts.placeholderKeys === 0) {
    res.failures.push('✗ صفر مدخل: لا مفتاح واحد بعنصر نائب في ' + label +
      ' — فحص التطابق لم يقس شيئاً (والملف يستعمل {pct} و{s}).');
  }

  /* ── ⑤ لا مفتاح مكرَّر (المكرَّر يُسقط الذي قبله صامتاً) ──────────────────
   * **عطب مقيس أصلحه جاسوس مستقلّ**: النسخة السابقة كانت تعدّ **كل** نصّ حرفيّ
   * في القسم مفتاحاً — والمفاتيح والقيم معاً — فقيمة واحدة لمفتاحين تُرفض برسالة
   * «مفتاح مكرَّر» تسمّي عطلاً غير الذي وقع (اصطياد كاذب). والصواب: يُقرأ المفتاح
   * من **موضعه** (نصّ حرفيّ يليه `:`) لا من النصّ الخام. */
  const dup = [];
  const raw = table.literal;
  for (const L of ['ar', 'en']) {
    const lm = new RegExp('\\b' + L + '\\s*:\\s*\\{').exec(raw);
    if (!lm) continue;
    const b = balancedBlock(raw, raw.indexOf('{', lm.index));
    if (!b) continue;
    const seen = new Set();
    for (const l of scanLiterals(b.body, true)) {
      if (l.kind !== 'str') continue;
      // المفتاح يليه `:` والقيمة تليها `,` أو `}`. والمقارنة على **النصّ الخام**
      // لا على شريحة الجسم: شريحة الجسم تبدأ بعد `{` بمحرف، فكان الفرق محرفاً
      // واحداً يُفسد التصنيف في الاتجاهين (قيمة تُقرأ مفتاحاً ومفتاحٌ يُفلت) —
      // عطب قيس بمُفسَدين: ضابط قيمة مكرّرة سقط كذباً، ومُفسَد مفتاح مكرّر مرّ.
      const after = raw.slice(b.start + 1 + l.end);
      if (!/^\s*:/.test(after)) continue;
      const key = l.text.slice(1, -1);
      if (seen.has(key)) dup.push(L + '.' + key);
      seen.add(key);
    }
  }
  res.checks++;
  if (dup.length) {
    res.failures.push('✗ مفتاح مكرَّر داخل القسم نفسه في ' + label + ' (المتأخّر يُسقط المتقدّم صامتاً): ' +
      dup.join(' · '));
  }

  /* ── ⑥ القيم العربية تحمل عربياً (المرجع عربي، وقيمة بلا عربية = عطب نقل) ─ */
  const arBlank = arKeys.filter((k) => !AR.test(String(ar[k])));
  res.checks++;
  if (arBlank.length) {
    res.failures.push('✗ قيمة في `ar` بلا أيّ محرف عربي (يُرجَّح نقل خاطئ) في ' + label + ': ' +
      arBlank.join(' · '));
  }

  /* ── ⑦ لا نصّ واجهة عربي خارج الجدول (المرشّح الواسع · بعد stripComments) ── */
  const noCom = stripComments(text);
  // نُفرّغ منطقة الجدول وحدها بمسافات (الطول ثابت ⇒ الأسطر صالحة)، وما بقي
  // يُمسح بالمرشّح الواسع. التعليقات سُجلت فراغاً قبل ذلك فلا تُحسب نصّاً.
  const outside = noCom.slice(0, table.start) + ' '.repeat(table.end - table.start) + noCom.slice(table.end);
  res.checks++;
  const sameLen = outside.length === noCom.length;
  if (!sameLen) res.failures.push('✗ خلل داخلي في الحارس: تجريد الجدول غيّر الطول');

  const lits = scanLiterals(outside, false);
  const offenders = lits.filter((l) => AR.test(l.text));

  /* التعليقات التي تحمل عربية: تُعدّ **لا نصّ** — تُقاس للتقرير وحده، ولا تُسقط.
   * والقياس بمدى التعليقات لا بفرق مجموعتين: `scanLiterals` يتخطّى التعليقات
   * أصلاً، فالنصّ الحرفيّ **داخل** تعليق لا يظهر كنصّ حرفيّ في النصّ الخام إطلاقاً
   * — فمقارنة مجموعتين كانت تُعيد صفراً دائماً (وهو عيب قيس في هذه الجولة: أعلن
   * «٠ نصّ عربي في تعليق» في ملفّ فيه ١٦٩ سطراً منها). هنا يُمسح النصّ الخام
   * ويُسأل عن كل محرف عربي: أيقع داخل مدى تعليق؟ */
  const cmts = commentRanges(text);
  const tableEnd = table.end;
  let commentArabic = 0;
  let commentLines = 0;
  {
    let runLine = -1;
    for (let i = 0; i < text.length; i++) {
      if (!AR.test(text[i])) continue;
      const inside = cmts.some(([s, e]) => i >= s && i < e);
      if (!inside) continue;
      commentArabic++;
      const ln = lineOf(text, i);
      if (ln !== runLine) { commentLines++; runLine = ln; }
    }
  }
  const tableAr = scanLiterals(text.slice(table.start, tableEnd), false).filter((l) => AR.test(l.text));
  res.arabic = tableAr.length;
  res.counts.tableAr = tableAr.length;

  /* جرد بنيوي: «الوحدة النصّية» = سلسلة كاملة، أو **شظية قالب** بين `${…}`.
   * وهذا هو المقياس الذي يفسّر الأرقام المنشورة: السلسلة/القالب الكامل يعطي
   * عدداً آخر لأن قالباً واحداً قد يحمل شظيتين عربيتين. */
  const unitList = (src) => unitsOf(src);
  const outUnits = unitList(outside).filter((u) => AR.test(u.t));
  const tblUnits = unitList(text.slice(table.start, tableEnd)).filter((u) => AR.test(u.t));
  const arVals = arKeys.map((k) => String(ar[k]));
  const uniqAr = new Set(arVals).size;
  res.counts.outsideUnits = outUnits.length;
  res.counts.tableUnits = tblUnits.length;
  res.counts.uniqueAr = uniqAr;
  const m = new Map();
  for (const u of outUnits) m.set(u.t, (m.get(u.t) || 0) + 1);
  res.counts.dupPairs = [...m.entries()].filter(([, n]) => n > 1)
    .map(([t, n]) => '«' + t.slice(0, 34) + '»×' + n);

  /* ── ⑧ صفر مدخل: لا نصّ عربي في الجدول ⇒ فشل بصوت عالٍ ───────────────── */
  res.checks++;
  if (tableAr.length === 0) {
    res.failures.push('✗ صفر مدخل: جدول الترجمة في ' + label +
      ' لا يحمل نصّاً عربياً واحداً — لا شيء قيس، فلا يجوز إعلان السلامة.');
  }

  res.checks++;
  if (offenders.length) {
    const where = offenders.map((l) => lineOf(text, l.start) + ':' + l.text.replace(/\n/g, '\\n').slice(0, 60));
    res.failures.push('✗ ' + offenders.length + ' نصّ واجهة عربي خارج جدول الترجمة — ' +
      label + ' (سطر:النصّ): ' + where.join(' · '));
  }

  /* ── ⑨ اختيار اللغة: pickLang نقية ومقيسة سلوكياً ─────────────────────── */
  res.checks++;
  const blk = /function\s+pickLang\s*\(/.exec(noCom);
  if (!blk) {
    res.failures.push('✗ دالّة اختيار اللغة `pickLang(` مفقودة من ' + label + ' — لا آلية اختيار، فلا تعريب.');
  } else {
    let pick = null, perr = null;
    try {
      const b = balancedBlock(text, text.indexOf('{', blk.index));
      pick = new Function('return (' + text.slice(blk.index, b.end) + ');')();
    } catch (e) { perr = e && e.message ? e.message : String(e); }
    res.checks++;
    if (typeof pick !== 'function') {
      res.failures.push('✗ تعذّر استخراج `pickLang` من ' + label + (perr ? ' — ' + perr : ''));
    } else {
      const cases = [
        [['ar'], 'ar'], [['ar-SA'], 'ar'], [['en'], 'en'], [['en-US'], 'en'],
        [['fr-FR'], 'en'], [['tr'], 'en'], [['zh-CN'], 'en'],
        // ترتيب المتصفح مُحترَم: أول لغة **مدعومة** في القائمة تفوز.
        [['fr', 'ar-EG'], 'ar'], [['de', 'en'], 'en'], [['de'], 'en'],
        [[], 'en'], [['AR'], 'ar'], [['EN-gb'], 'en'], [['ar', 'en'], 'ar'], [['en', 'ar'], 'en'],
      ];
      const wrong = cases.filter(([inp, want]) => pick(inp) !== want)
        .map(([inp, want]) => JSON.stringify(inp) + '⇒' + pick(inp) + ' (المتوقّع ' + want + ')');
      res.checks++;
      if (wrong.length) {
        res.failures.push('✗ اختيار اللغة مخالف في ' + label + ': ' + wrong.join(' · '));
      }
      // لغة غير عربية/إنجليزية يجب أن تنتهي إلى مدخل قائم فعلاً في الجدول.
      res.checks++;
      const fb = pick(['fr-FR']);
      if (!(fb in I18N)) res.failures.push('✗ الاختيار الافتراضي «' + fb + '» ليس لغة في الجدول');
    }
  }

  /* ── ⑩ النصّ المُركَّب: كل نداء `t(` مفتاحه نصّ حرفيّ (وصول محسوب ⇒ §٢٦) ───
   * البحث بمُحلِّل النصوص لا بتعبير نمطي: `\bt\s*\(` يطابق `.split(` و`\t(`
   * أيضاً (حدّ كلمة بعد نقطة)، فيُسقط الحارس على شيفرة سليمة — وهو الاصطياد الكاذب.
   * هنا: كل موضع `t` **ليس جزءاً من معرّف أطول**، ويليه `(`، ثم يُفحص ما بعد القوس.
   * ويُستثنى **تعريف** الدالّة نفسه (`function t(` · `const t = (` · `let t = (`) —
   * فهو معرّف لا نداء، وإلا أسقط الحارس شيفرةً سليمة. */
  res.checks++;
  const computed = [];
  for (let i = 0; i < noCom.length; i++) {
    if (noCom[i] !== 't') continue;
    const prev = i > 0 ? noCom[i - 1] : '';
    if (/[A-Za-z0-9_$.]/.test(prev)) continue;      // `tt` · `.t` · `_t` ⇒ ليست دالّة t
    const head = noCom.slice(Math.max(0, i - 24), i);
    if (/\bfunction\s+$/.test(head)) continue;      // function t(key) { … }
    if (/\b(?:const|let|var)\s+$/.test(head)) continue;  // const t = (…)
    let j = i + 1;
    while (j < noCom.length && (noCom[j] === ' ' || noCom[j] === '\t')) j++;
    if (noCom[j] !== '(') continue;
    j++;
    while (j < noCom.length && (noCom[j] === ' ' || noCom[j] === '\t' || noCom[j] === '\n')) j++;
    if (noCom[j] !== "'" && noCom[j] !== '"') computed.push(lineOf(text, i));
  }
  /* المواضع المحسوبة **بعدد معلَن وتعليل** — نمط `DYN_SITES`: موضع جديد أو عدد
   * متغيّر يُسقط الحارس. والمسوّغ الوحيد المشروع اليوم هو قارئا `data-i18n` في
   * `popup.js`، ومفاتيحهما مجموعة مغلقة يفحصها `auditHtml` وجوداً في الجدول. */
  const computedAllow = (D && D.computedT) ? D.computedT.n : 0;
  if (computed.length !== computedAllow) {
    res.failures.push('✗ نداءات `t(` بمفتاح غير نصّ حرفي — ' + label + ': المتوقَّع ' +
      computedAllow + ' ووُجد ' + computed.length +
      (computed.length ? ' (أسطر: ' + computed.join(' · ') + ')' : '') +
      (computedAllow && D && D.computedT ? ' — تعليل المسموح: ' + D.computedT.why : '') +
      ' — المفتاح المحسوب يخالف §٢٦ ويُخفي النصّ عن الحارس إن لم يكن مجموعة مغلقة مُتحقَّقاً منها.');
  }

  res.counts.commentArabic = commentArabic;
  res.counts.commentLines = commentLines;

  /* ── ⑪ بناء نصّ ديناميكي: **قائمة سماح بعدد لكل موضع** ────────────────────
   * **لماذا قائمة سماح ولا ملاحقة فكّ الترميز**: جاسوس مستقلّ أثبت **عشر طرق**
   * تُنتج عربية بلا نصّ عربي، وكلّ ملاحقةٍ لفكّ ترميز تُخترق بالحادية عشرة
   * (`decodeURIComponent` · `unescape` · `JSON.parse` بمفتاح مزدوج الهروب ·
   * `Buffer.from(…,'hex')` · `atob` مجزّأ بحشو · `Array.from` + متغيّر ·
   * `parseInt('639',16)` …). والصواب **نمط `check-separation-entry.cjs` نفسه**:
   * كل موضع **يستطيع** بناء نصّ ديناميكي مُسجَّل صراحةً بعدد متوقَّع وتعليل، فموضع
   * جديد أو عدد متغيّر **يُسقط الحارس مسمّياً الملف والسطر والعدد المتوقَّع**.
   * فالعدّ هو المحروس لا نتيجة الفكّ — فلا يُخترق بطريقة لم تُفكّر بها. */
  res.checks++;
  const DYN_SITES = [
    { name: 'atob(', re: /\batob\s*\(/g, sites: 0, why: 'لا موضع: لا فكّ base64 في هذا الملف' },
    { name: 'btoa(', re: /\bbtoa\s*\(/g, sites: 0, why: 'لا موضع: لا ترميز base64' },
    { name: 'decodeURIComponent(', re: /\bdecodeURIComponent\s*\(/g, sites: 0, why: 'لا موضع: لا فكّ ترميز URI (وهو أشيع طرق الإخفاء)' },
    { name: 'decodeURI(', re: /\bdecodeURI\s*\(/g, sites: 0, why: 'لا موضع' },
    { name: 'encodeURIComponent(', re: /\bencodeURIComponent\s*\(/g, sites: 0, why: 'لا موضع: الإضافة لا تبني معاملات URL (كل شيء عبر Native Messaging)' },
    { name: 'unescape(', re: /\bunescape\s*\(/g, sites: 0, why: 'لا موضع (ودالّة مهجورة)' },
    { name: 'escape(', re: /\bescape\s*\(/g, sites: 0, why: 'لا موضع (ودالّة مهجورة)' },
    { name: 'String.fromCharCode(', re: /\bString\s*\.\s*fromCharCode\s*\(/g, sites: 0, why: 'لا موضع: لا يُبنى نصّ من رموز' },
    { name: 'String.fromCodePoint(', re: /\bString\s*\.\s*fromCodePoint\s*\(/g, sites: 0, why: 'لا موضع' },
    { name: 'String.raw', re: /\bString\s*\.\s*raw\b/g, sites: 0, why: 'لا موضع: القوالب هنا عادية (والهروب يفكّه المُحلِّل)' },
    { name: 'JSON.parse(', re: /\bJSON\s*\.\s*parse\s*\(/g, sites: 0, why: 'لا موضع: لا يُحلَّل JSON في الصفحة — الردود كائنات جاهزة من الجسر' },
    { name: 'Buffer.from(', re: /\bBuffer\s*\.\s*from\s*\(/g, sites: 0, why: 'لا موضع: لا Buffer في سياق صفحة (وهو أصلاً غير متاح في المتصفّح)' },
    { name: 'eval(', re: /\beval\s*\(/g, sites: 0, why: 'لا موضع (و§٢٦ يمنعه أصلاً)' },
  ];
  const dynViolations = [];
  for (const p of DYN_SITES) {
    const n = (noCom.match(p.re) || []).length;
    if (n !== p.sites) {
      const first = noCom.search(p.re);
      dynViolations.push(p.name + ': المتوقَّع ' + p.sites + ' ووُجد ' + n +
        (first >= 0 ? ' (أول موضع: سطر ' + lineOf(text, first) + ')' : '') + ' — تعليل المسموح: ' + p.why);
    }
  }
  if (dynViolations.length) {
    res.failures.push('✗ بناء نصّ ديناميكي خارج القائمة المسموحة — ' + label + ': ' +
      dynViolations.join(' · ') +
      ' — سجّل الموضع بعدده وتعليله إن كان مشروعاً، وإلا فلا يُبنى النصّ (§٢٦).');
  }
  res.counts.dynPatterns = DYN_SITES.length;

  /* ── ⑫ عربية داخل **تعبير نمطي** ───────────────────────────────────────────
   * جاسوس مستقلّ أظهر أن `if (/جاهز|تم التجهيز/.test(procBtn.textContent))` يمرّ
   * من الحارس: المُحلِّل يتخطّى التعبير النمطي (فلا يراه نصّاً)، وهو **نصّ واجهة
   * مقارَن به** فينكسر بالإنجليزية. وقائمة سماح بعدد كالموضع ⑪. */
  res.checks++;
  const AR_IN_REGEX = 0;   // لا موضع: لا تعبير نمطي فيه عربية في هذا الملف
  const regexArabic = [];
  {
    const re = /\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g;
    let m;
    while ((m = re.exec(noCom)) !== null) {
      if (AR.test(m[0])) regexArabic.push(lineOf(text, m.index) + ':' + m[0].slice(0, 40));
    }
  }
  if (regexArabic.length !== AR_IN_REGEX) {
    res.failures.push('✗ عربية داخل تعبير نمطي — ' + label + ': المتوقَّع ' + AR_IN_REGEX +
      ' ووُجد ' + regexArabic.length + ' (' + regexArabic.join(' · ') +
      ') — المقارنة بنصّ معروض تنكسر بالإنجليزية؛ سجّلها في القائمة أو أخرجها من الشيفرة.');
  }

  /* ── ⑬ **وجود المفتاح**: كل `t('…')` في الملف له مدخل في الجدول ──────────
   * عطل مقيس أثبته جاسوس مستقلّ في jsdom: `t('cancel.done.typo')` يمرّ من الحارس،
   * و`t()` تُرجع `undefined` ⇒ **توست فارغ بلا أيّ خطأ**، و`fill(undefined, …)`
   * ترمي `TypeError` فيُسقط مسار جلب الصوت. والحارس كان يقيس **المفاتيح الميتة**
   * (المعرفة وغير المستعملة) ولا يقيس **المستعملة وغير المعرفة** — وهو الاتجاه
   * الذي يظهر على الشاشة.
   * والمفاتيح تُستخرج من نداءات `t(` بمفتاح نصّ حرفيّ (المحسوب يُسقطه الفحص ⑩). */
  res.checks++;
  const tKeys = [];
  for (let i = 0; i < noCom.length; i++) {
    if (noCom[i] !== 't') continue;
    const prev = i > 0 ? noCom[i - 1] : '';
    if (/[A-Za-z0-9_$.]/.test(prev)) continue;
    const head = noCom.slice(Math.max(0, i - 24), i);
    if (/\bfunction\s+$/.test(head) || /\b(?:const|let|var)\s+$/.test(head)) continue;
    let j = i + 1;
    while (noCom[j] === ' ' || noCom[j] === '\t' || noCom[j] === '\n') j++;
    if (noCom[j] !== '(') continue;
    j++;
    while (noCom[j] === ' ' || noCom[j] === '\t' || noCom[j] === '\n') j++;
    const q = noCom[j];
    if (q !== "'" && q !== '"') continue;
    let k = j + 1, s = '';
    while (k < noCom.length && noCom[k] !== q) { if (noCom[k] === '\\') { k++; } s += noCom[k]; k++; }
    tKeys.push({ key: s, line: lineOf(text, i) });
  }
  const unknown = tKeys.filter((x) => !(x.key in ar) || !(x.key in en));
  if (unknown.length) {
    res.failures.push('✗ ' + unknown.length + ' نداءً بمفتاح غير موجود في الجدول — ' + label + ': ' +
      unknown.map((x) => 'سطر ' + x.line + ': t(\'' + x.key + '\')').join(' · ') +
      ' — `t()` تُرجع undefined فيظهر توست فارغ أو يرمي fill.');
  }
  res.counts.tCalls = tKeys.length;
  res.counts.tKeysUnique = new Set(tKeys.map((x) => x.key)).size;
  res.checks++;
  if (tKeys.length === 0) {
    res.failures.push('✗ صفر مدخل: لا نداء `t(` واحد في ' + label + ' — فحص وجود المفاتيح لم يقس شيئاً.');
  }
  /* المفاتيح المستعملة = نداءات `t(` الحرفية **زائد** ما يُستعمل من خارج الملف
   * (‏`data-i18n` في الصفحة). وبلا هذا الجمع كان كل نصّ واجهة في `popup.html`
   * يُتّهم بالموت — وهو حكم كاذب على تغطية قائمة فعلاً. */
  const usedKeys = new Set(tKeys.map((x) => x.key));
  for (const k of externalKeys) usedKeys.add(k);
  res.counts.externalKeys = externalKeys.length;
  const dead = arKeys.filter((k) => !usedKeys.has(k));
  res.counts.deadKeys = dead.length;
  res.checks++;
  if (dead.length) {
    res.failures.push('✗ ' + dead.length + ' مفتاحاً معرَّفاً ولا يُستعمل في ' + label + ': ' +
      dead.join(' · ') + ' — مفتاح ميت يُوهم بتغطية غير قائمة.');
  }

  /* ── ⑭–⑰ قيود **مُعلَنة لكل ملف** (ولا يمرّ عليها `content.js` فلا يتغيّر
   * عدد فحوصه). كل قيد يُعلن في `TARGETS` بجانب الملف، فإضافة مفتاح تخزين أو
   * نزع اشتقاق الاتجاه تُسقط الحارس بدل أن تمرّ صامتة. */
  if (D) {
    /* ⑭ لا مفتاح `localStorage` جديد: المجموعة تُقارن بالمُعلَن **بالاسم** لا
     * بالعدد وحده، وإلا مرّ استبدال مفتاح بمفتاح. */
    res.checks++;
    const found = storageKeys(noCom);
    const want = (D.storage && D.storage.keys) || [];
    const added = found.filter((k) => !want.includes(k));
    const gone = want.filter((k) => !found.includes(k));
    res.counts.storageKeys = found.length;
    if (added.length || gone.length) {
      res.failures.push('✗ مفاتيح `localStorage` مخالفة للمُعلَن في ' + label + ': ' +
        (added.length ? 'زائد [' + added.join(' · ') + ']' : '') +
        (added.length && gone.length ? ' · ' : '') +
        (gone.length ? 'ناقص [' + gone.join(' · ') + ']' : '') +
        ' — المُعلَن [' + (want.join(' · ') || 'لا شيء') + ']؛ أي مفتاح جديد يُعلَن هنا أولاً (§٢٧).');
    }

    /* ⑮ الاتجاه مشتقّ من اللغة المُختارة، لا من الصفحة ولا من قيمة ثابتة. */
    if (D.direction) {
      res.checks++;
      if (!/const\s+RTL\s*=\s*LANG\s*===\s*'ar'\s*;/.test(noCom)) {
        res.failures.push('✗ الاتجاه غير مشتقّ من اللغة في ' + label +
          ' — المطلوب `const RTL = LANG === \'ar\';` حرفياً.');
      }
      /* ⑯ ويُسند فعلاً إلى المستند: اشتقاقٌ لا يُستعمل لا يُعرّب شيئاً. */
      res.checks++;
      const hasDir = /documentElement\s*\.\s*dir\s*=\s*RTL\s*\?\s*'rtl'\s*:\s*'ltr'/.test(noCom);
      const hasLang = /documentElement\s*\.\s*lang\s*=\s*LANG/.test(noCom);
      if (!hasDir || !hasLang) {
        res.failures.push('✗ الاتجاه/اللغة لا يُسندان إلى المستند في ' + label + ': ' +
          (hasDir ? '' : '`documentElement.dir = RTL ? \'rtl\' : \'ltr\'` مفقود') +
          (hasDir && !hasLang ? ' · ' : '') +
          (hasLang ? '' : '`documentElement.lang = LANG` مفقود') +
          ' — نصّ معرَّب في مستند باتجاه الصفحة يبقى مقلوباً.');
      }
    }

    /* ⑰ اللغة تُقرأ من **لغة واجهة المتصفّح** (`navigator.languages`) لا من
     * لغة الصفحة المعروضة. */
    if (D.navigatorLang) {
      res.checks++;
      if (!/navigator\s*\.\s*languages/.test(noCom)) {
        res.failures.push('✗ اللغة لا تُقرأ من `navigator.languages` في ' + label +
          ' — لغة الصفحة ليست لغة الواجهة (مستخدم إنجليزي يشاهد فيديو عربياً يجب أن يرى واجهة إنجليزية).');
      }
    }
  }

  res.arKeys = arKeys;
  res.enKeys = enKeys;
  return res;
}

function lineOf(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/** شظايا جسم قالب بين `${…}` المتوازنة (والهروب يُحترم). */
function templateChunks(body) {
  const chunks = [];
  let cur = '', i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') { cur += body.substr(i, 2); i += 2; continue; }
    if (c === '$' && body[i + 1] === '{') {
      chunks.push(cur); cur = '';
      let d = 1, str = null;
      i += 2;
      while (i < body.length && d > 0) {
        const e = body[i];
        if (str) { if (e === '\\') { i += 2; continue; } if (e === str) str = null; i++; continue; }
        if (e === "'" || e === '"' || e === '`') { str = e; i++; continue; }
        if (e === '{') d++;
        if (e === '}') d--;
        i++;
      }
      continue;
    }
    cur += c; i++;
  }
  chunks.push(cur);
  return chunks;
}

/** وحدات النصّ في مقطع مصدر: سلسلة كاملة = وحدة · قالب = وحدة لكل شظيّة. */
function unitsOf(src) {
  const out = [];
  for (const l of scanLiterals(src, false)) {
    if (l.kind === 'str') { out.push({ t: l.text.slice(1, -1), line: l.line, kind: 'str' }); continue; }
    if (l.kind === 'inner' || l.kind === 'tpl') {
      if (l.kind === 'inner') continue;
      for (const ch of templateChunks(src.slice(l.start + 1, l.end - 1))) {
        if (ch) out.push({ t: ch, line: l.line, kind: 'tpl-chunk' });
      }
    }
  }
  return out;
}

/* ══ HTML: صفر عربية، وكل مفتاح مربوط موجود في جدول الصفحة ═════════════════ */

/** يُفرّغ `<!-- … -->` **بمسافات** (الطول ثابت ⇒ أرقام الأسطر تبقى صالحة). */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** مواضع الربط في صفحة: `data-i18n="مفتاح"` و`data-i18n-attr="سمة:مفتاح"`. */
function htmlBindings(text) {
  const out = { text: [], attr: [] };
  let m;
  const reText = /\bdata-i18n="([^"]*)"/g;
  while ((m = reText.exec(text)) !== null) out.text.push({ key: m[1], at: m.index });
  const reAttr = /\bdata-i18n-attr="([^"]*)"/g;
  while ((m = reAttr.exec(text)) !== null) out.attr.push({ key: m[1], at: m.index });
  return out;
}

/** قارئ `data-i18n-attr` يفصل السمة عن المفتاح (`alt:header.iconAlt`). */
const attrKeyOf = (spec) => (spec.indexOf(':') >= 0 ? spec.slice(spec.indexOf(':') + 1) : spec);

function auditHtml(text, label, opts) {
  const res = { checks: 0, failures: [], counts: {} };
  const arKeys = (opts && opts.arKeys) || [];
  const enKeys = (opts && opts.enKeys) || [];
  const decl = (opts && opts.declared) || {};
  const noCom = stripHtmlComments(text);

  /* ① صفر محرف عربي خارج تعليقات HTML — **ولا جدول في هذه الصفحة أصلاً**:
   * كل نصّ واجهة مربوط بمفتاح، فالمقيس هنا أضيق من «لا عربية خارج الجدول». */
  res.checks++;
  const offenders = [];
  for (let i = 0; i < noCom.length; i++) {
    if (AR.test(noCom[i])) offenders.push(lineOf(text, i) + ':' + noCom.slice(i, i + 22).replace(/\n/g, '\\n'));
  }
  res.counts.htmlArabic = offenders.length;
  if (offenders.length) {
    res.failures.push('✗ ' + offenders.length + ' محرفاً عربياً خارج تعليقات HTML في ' + label +
      ' (سطر:النصّ): ' + offenders.slice(0, 8).join(' · ') +
      ' — الصفحة تحمل **مفاتيح** `data-i18n` وحدها، ونصوصها في جدول popup.js.');
  }

  const b = htmlBindings(noCom);
  res.counts.htmlBindings = b.text.length;
  res.counts.htmlAttrBindings = b.attr.length;

  /* ② صفر مدخل: صفحة بلا موضع ربط واحد ⇒ لا شيء يُقاس، فلا نجاح. */
  res.checks++;
  if (b.text.length === 0 && b.attr.length === 0) {
    res.failures.push('✗ صفر مدخل: لا موضع `data-i18n` ولا `data-i18n-attr` في ' + label +
      ' — فحص وجود المفاتيح لم يقس شيئاً.');
  }

  /* ③ العدد **مُعلَن** — موضع ربط جديد يُسقط الحارس ولا يمرّ صامتاً. */
  res.checks++;
  const wantT = decl.bindings ? decl.bindings.text : 0;
  const wantA = decl.bindings ? decl.bindings.attr : 0;
  if (b.text.length !== wantT || b.attr.length !== wantA) {
    res.failures.push('✗ عدد مواضع الربط مخالف للمُعلَن في ' + label + ': `data-i18n` المتوقَّع ' + wantT +
      ' ووُجد ' + b.text.length + ' · `data-i18n-attr` المتوقَّع ' + wantA + ' ووُجد ' + b.attr.length +
      (decl.bindings && decl.bindings.why ? ' — تعليل المُعلَن: ' + decl.bindings.why : '') +
      ' — سجّل الموضع الجديد في الحارس مع تعليله.');
  }

  /* ④ كل مفتاح مربوط **موجود في الجدول باللغتين** — وهذا بعينه ما يجعل الموضعين
   * المحسوبين في `popup.js` (قارئَي `data-i18n`) **مجموعةً مغلقة** لا مجهولة. */
  res.checks++;
  const bad = [];
  for (const x of b.text.concat(b.attr)) {
    const key = attrKeyOf(x.key);
    if (!arKeys.includes(key) || !enKeys.includes(key)) bad.push('سطر ' + lineOf(text, x.at) + ': ' + x.key);
  }
  if (bad.length) {
    res.failures.push('✗ ' + bad.length + ' مفتاحاً مربوطاً في ' + label +
      ' وغير موجود في جدول popup.js (أو في إحدى اللغتين): ' + bad.join(' · ') +
      ' — `t()` تُرجع undefined فيبقى العنصر فارغاً بلا أيّ خطأ.');
  }

  /* ⑤ المصدر الثابت للّغة والاتجاه على `<html>`: يُصحّحه الكود عند الإقلاع، لكن
   * غيابه يعني أن تعذّر تنفيذ السكربت يترك الصفحة بلا لغة ولا اتجاه معلَنين. */
  res.checks++;
  const hasLang = /<html[^>]*\blang="[^"]+"/.test(noCom);
  const hasDir = /<html[^>]*\bdir="(?:rtl|ltr)"/.test(noCom);
  if (!hasLang || !hasDir) {
    res.failures.push('✗ وسم `<html>` في ' + label + ' بلا `lang` و`dir` ثابتين (' +
      (hasLang ? '' : 'lang مفقود') + (!hasLang && !hasDir ? ' · ' : '') + (hasDir ? '' : 'dir مفقود') +
      ') — القيمة الثابتة هي ما يراه المستخدم إن لم يُنفَّذ السكربت.');
  }

  return res;
}

/* ══ المانيفست + `_locales`: العربية في الجدول، والمانيفست صفر عربية ════════ */

/** عناصر `_locales` النائبة بصيغة كروم: `$1` · `$NAME$` · `$$`. */
const msgHolders = (s) => {
  const m = new Map();
  for (const x of String(s).matchAll(/\$(?:\$|\d|[A-Za-z_][A-Za-z0-9_]*\$)/g)) m.set(x[0], (m.get(x[0]) || 0) + 1);
  return m;
};

function auditManifest(text, label, opts) {
  const res = { checks: 0, failures: [], counts: {} };
  const decl = (opts && opts.declared) || {};
  const locales = (opts && opts.locales) || [];

  /* ① المانيفست نفسه: **صفر عربية**. لا تعليقات في JSON، فكل محرف عربي فيه
   * نصّ يعرضه المتصفّح — ومكانه `_locales`. */
  res.checks++;
  const offenders = [];
  for (let i = 0; i < text.length; i++) {
    if (AR.test(text[i])) offenders.push(lineOf(text, i) + ':' + text.slice(i, i + 22).replace(/\n/g, '\\n'));
  }
  res.counts.manifestArabic = offenders.length;
  if (offenders.length) {
    res.failures.push('✗ ' + offenders.length + ' محرفاً عربياً في ' + label +
      ' (سطر:النصّ): ' + offenders.slice(0, 6).join(' · ') +
      ' — ما يعرضه المتصفّح من المانيفست يُعرَّب بـ`_locales` و`__MSG_x__`، لا بنصّ عربي هنا.');
  }

  let mf = null, perr = null;
  try { mf = JSON.parse(text); } catch (e) { perr = e && e.message ? e.message : String(e); }
  res.checks++;
  if (!mf || typeof mf !== 'object') {
    res.failures.push('✗ تعذّر تحليل ' + label + ' كـJSON' + (perr ? ' — ' + perr : '') + ' — لا شيء يُقاس.');
    return res;
  }

  /* ② مراجع `__MSG_x__` — بعدد معلَن، والاسم لا يُبنى ولا يُخمَّن. */
  const refs = [];
  for (const m of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) if (!refs.includes(m[1])) refs.push(m[1]);
  res.counts.msgRefs = refs.length;
  res.checks++;
  const wantRefs = decl.msgRefs ? decl.msgRefs.n : 0;
  if (refs.length !== wantRefs) {
    res.failures.push('✗ مراجع `__MSG_x__` في ' + label + ': المتوقَّع ' + wantRefs + ' ووُجد ' + refs.length +
      ' [' + (refs.join(' · ') || 'لا شيء') + ']' +
      (decl.msgRefs && decl.msgRefs.why ? ' — تعليل المُعلَن: ' + decl.msgRefs.why : '') +
      ' — يُعرَّب من المانيفست ما يعرضه المتصفّح وحده، ويُسجَّل الحقل هنا.');
  }

  /* ③ `default_locale` معلَن وقائم فعلاً في `_locales/`. */
  res.checks++;
  const def = mf.default_locale;
  if (typeof def !== 'string' || !locales.some((l) => l.locale === def)) {
    res.failures.push('✗ `default_locale` في ' + label + ' = ' + JSON.stringify(def) +
      ' وليس لغة قائمة في `_locales` (القائم: ' + (locales.map((l) => l.locale).join(' · ') || 'لا شيء') +
      ') — وبدونه يرفض المتصفّح `__MSG_` كلياً.');
  }

  /* ④ كل لغة: تُحلَّل، ومدخلاتها غير فارغة. */
  res.checks++;
  const L = [];
  for (const loc of locales) {
    let j = null, e = null;
    try { j = JSON.parse(loc.text); } catch (err) { e = err && err.message ? err.message : String(err); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      res.failures.push('✗ تعذّر تحليل `_locales/' + loc.locale + '/messages.json`' + (e ? ' — ' + e : '') + '.');
      continue;
    }
    const keys = Object.keys(j);
    const blank = keys.filter((k) => !j[k] || typeof j[k].message !== 'string' || j[k].message.trim() === '');
    if (blank.length) {
      res.failures.push('✗ `_locales/' + loc.locale + '`: ' + blank.length + ' مدخلاً بلا `message` نصّي غير فارغ: ' +
        blank.join(' · '));
    }
    L.push({ locale: loc.locale, keys, table: j });
  }
  if (L.length !== locales.length) return res;

  /* ⑤ صفر مدخل: لا مفتاح واحد في أي لغة ⇒ لا شيء يُقاس. */
  res.checks++;
  if (L.every((l) => l.keys.length === 0)) {
    res.failures.push('✗ صفر مدخل: `_locales` في ' + label + ' فارغة من كل اللغات — لا شيء قيس.');
    return res;
  }

  /* ⑥ تكافؤ المفاتيح بين اللغات **في الاتجاهين**. */
  res.checks++;
  const first = L[0];
  const mism = [];
  for (const l of L.slice(1)) {
    const missingHere = first.keys.filter((k) => !l.keys.includes(k));
    const extraHere = l.keys.filter((k) => !first.keys.includes(k));
    if (missingHere.length) mism.push('في ' + l.locale + ' بلا مقابل من ' + first.locale + ': ' + missingHere.join(' · '));
    if (extraHere.length) mism.push('في ' + l.locale + ' زائد على ' + first.locale + ': ' + extraHere.join(' · '));
  }
  if (mism.length) {
    res.failures.push('✗ تكافؤ مفاتيح `_locales` مخالف في ' + label + ': ' + mism.join(' · ') +
      ' — مفتاح بلا مقابل في لغة يعني نصّاً مفقوداً لمستخدم تلك اللغة.');
  }
  res.counts.localeKeys = first.keys.length;

  /* ⑦ كل `__MSG_x__` **معرَّف في كل لغة** — وإلا عرض المتصفّح `__MSG_x__` حرفياً. */
  res.checks++;
  const undef = [];
  for (const k of refs) for (const l of L) if (!l.keys.includes(k)) undef.push('__MSG_' + k + '__ في المانيفست وغير معرَّف في ' + l.locale);
  if (undef.length) {
    res.failures.push('✗ ' + undef.length + ' مرجعاً غير معرَّف في ' + label + ': ' + undef.join(' · ') +
      ' — المتصفّح يعرض `__MSG_x__` حرفياً اسماً للإضافة.');
  }

  /* ⑧ وكل مفتاح في `_locales` **مستعمل** — مفتاح زائد وهم تغطية. */
  res.checks++;
  const unused = [];
  for (const l of L) for (const k of l.keys) if (!refs.includes(k)) unused.push(l.locale + '.' + k);
  if (unused.length) {
    res.failures.push('✗ ' + unused.length + ' مفتاحاً في `_locales` ولا يستعمله المانيفست في ' + label + ': ' +
      unused.join(' · ') + ' — ترجمة لا يراها أحد توهم بتغطية غير قائمة.');
  }

  /* ⑨ عناصر نائبة متطابقة بين اللغات (‏`$1` · `$NAME$`)، وبعدد معلَن. */
  res.checks++;
  const phBad = [];
  for (const k of first.keys) {
    const a = msgHolders(first.table[k].message);
    for (const l of L.slice(1)) {
      if (!l.table[k]) continue;
      const b = msgHolders(l.table[k].message);
      const names = new Set([...a.keys(), ...b.keys()]);
      const bad = [...names].filter((x) => (a.get(x) || 0) !== (b.get(x) || 0))
        .map((x) => x + ' (' + first.locale + '×' + (a.get(x) || 0) + ' · ' + l.locale + '×' + (b.get(x) || 0) + ')');
      if (bad.length) phBad.push(k + ': ' + bad.join(' · '));
    }
  }
  if (phBad.length) {
    res.failures.push('✗ عناصر نائبة غير متطابقة بين لغات `_locales` في ' + label + ': ' + phBad.join(' · '));
  }
  const phCount = first.keys.reduce((n, k) => n + msgHolders(first.table[k].message).size, 0);
  res.counts.msgPlaceholders = phCount;
  res.checks++;
  const wantPh = decl.placeholders ? decl.placeholders.n : 0;
  if (phCount !== wantPh) {
    res.failures.push('✗ عناصر نائبة في `_locales` — ' + label + ': المتوقَّع ' + wantPh + ' ووُجد ' + phCount +
      (decl.placeholders && decl.placeholders.why ? ' — تعليل المُعلَن: ' + decl.placeholders.why : '') +
      ' — سجّل الموضع بعدده وتعليله.');
  }

  /* ⑩ لا عربية في لغة غير العربية، وعربية في العربية (عموم اللغات لا `en` وحدها). */
  res.checks++;
  const scriptBad = [];
  for (const l of L) {
    for (const k of l.keys) {
      const v = l.table[k].message;
      if (l.locale === 'ar') { if (!AR.test(v)) scriptBad.push('ar.' + k + ' بلا أيّ محرف عربي'); }
      else if (AR.test(v)) scriptBad.push(l.locale + '.' + k + ' = «' + String(v).slice(0, 40) + '» يحمل عربية');
    }
  }
  if (scriptBad.length) {
    res.failures.push('✗ كتابة مخالفة في `_locales` — ' + label + ': ' + scriptBad.join(' · ') +
      ' — قيمة إنجليزية تحمل عربية (ترجمة ناقصة)، أو قيمة عربية بلا عربية (نقل خاطئ).');
  }

  return res;
}

/* ══ الملفات المُعلَنة: ما يمسحه المسح الموسَّع، ومعه قيود كل ملف ═════════════
 * كل قيد هنا **بعدد وتعليل** على نمط `DYN_SITES`: إضافة مفتاح تخزين، أو نزع
 * اشتقاق الاتجاه، أو موضع ربط جديد في الصفحة، أو حقل `__MSG_` جديد — كلها
 * تُسقط الحارس حتى تُسجَّل هنا. و`content.js` **بلا `declared`** عمداً: جولته
 * (م٦-أ) قِيست وأُغلقت، فبقي على ٢٣ فحصاً بالضبط ولم يُحذف منه فحص واحد. */
const TARGETS = [
  { rel: 'browser-extension/content.js', kind: 'js', label: 'content.js' },
  {
    rel: 'browser-extension/popup.js', kind: 'js', label: 'popup.js',
    externalKeysFrom: 'browser-extension/popup.html',
    declared: {
      /* §٢٧ يقفل مفتاح التخزين: `MODE_KEY` وحده كما كان قبل هذه الجولة. */
      storage: { keys: ['hl.popup.mode'], why: 'تفضيل الوضع الوحيد؛ صفر مفتاح تخزين جديد في م٦-ب' },
      direction: true,
      navigatorLang: true,
      placeholders: { n: 3, why: '{q} في الطابور · {s} الثواني · {e} نصّ الخطأ' },
      computedT: {
        n: 2,
        why: 'موضعان في applyI18n() يقرآن المفتاح من data-i18n/data-i18n-attr؛ والمفاتيح مجموعة مغلقة يفحص auditHtml وجود كل عنصرها في الجدول باللغتين',
      },
    },
  },
  {
    rel: 'browser-extension/background.js', kind: 'js', label: 'background.js',
    declared: {
      storage: { keys: [], why: 'عامل الخدمة لا يخزّن شيئاً' },
      direction: false,   // لا واجهة يرسمها: عناوين قائمة النقر الأيمن يرسمها المتصفّح باتجاهه
      navigatorLang: true,
      placeholders: { n: 0, why: 'ثلاثة عناوين قائمة لا تحمل رقماً ولا متغيّراً — فلا عنصر نائب أصلاً' },
      computedT: { n: 0, why: 'ثلاثة نداءات كلها بمفتاح نصّ حرفيّ' },
    },
  },
  {
    rel: 'browser-extension/popup.html', kind: 'html', label: 'popup.html',
    tableFrom: 'browser-extension/popup.js',
    declared: {
      bindings: {
        text: 21, attr: 1,
        why: 'كل نصّ واجهة في الصفحة مربوط بمفتاح: ٢١ نصّاً وسمة alt واحدة (‏`alt:header.iconAlt`)',
      },
    },
  },
  {
    rel: 'browser-extension/manifest.json', kind: 'manifest', label: 'manifest.json',
    locales: [
      { locale: 'ar', rel: 'browser-extension/_locales/ar/messages.json' },
      { locale: 'en', rel: 'browser-extension/_locales/en/messages.json' },
    ],
    declared: {
      msgRefs: { n: 2, why: 'الحقلان الوحيدان اللذان يعرضهما المتصفّح من المانيفست: الاسم والوصف' },
      placeholders: { n: 0, why: 'اسم الإضافة ووصفها بلا عناصر نائبة (لا $1 ولا $NAME$)' },
    },
  },
];

/* ══ المسح الموسَّع — **دالّة نقية على خريطة ملفات** ═════════════════════════
 * تُقاس **في الذاكرة**: `mainMulti` تقرأ من القرص ثم تناديها، ومُفسَدات م٦-ب
 * تناديها على خريطة مُفسَدة بلا ملف مؤقت ولا كتابة على القرص ولا عملية فرعية. */
function auditAll(texts) {
  const res = { checks: 0, failures: [], results: [], missing: [] };

  /* صفر مدخل: كل ملف مُعلَن — ومعه ملفات `_locales` — موجود وغير فارغ، وإلا
   * **فشل بصوت عالٍ** لا تخطٍّ صامت. */
  const need = [];
  for (const t of TARGETS) {
    need.push(t.rel);
    for (const l of t.locales || []) need.push(l.rel);
  }
  for (const rel of need) {
    const s = texts[rel];
    if (typeof s !== 'string' || s.trim() === '') res.missing.push(rel);
  }
  if (res.missing.length) {
    res.failures.push('✗ صفر مدخل: ' + res.missing.length + ' ملفاً مُعلَناً مفقوداً أو فارغاً (' +
      res.missing.join(' · ') + ') — المسح الموسَّع لا يعلن نجاحاً ناقصاً.');
    return res;
  }

  /* محتوى الصفحة يُقرأ أولاً: مفاتيحه هي ما يجعل موضعَي `t(` المحسوبين في
   * popup.js مجموعةً مغلقة، فهي **مدخل** لقياس popup.js لا نتيجة له. */
  const html = texts['browser-extension/popup.html'];
  const htmlKeys = htmlBindings(stripHtmlComments(html));
  const externalKeys = htmlKeys.text.concat(htmlKeys.attr).map((x) => attrKeyOf(x.key));

  const add = (rel, r) => { res.results.push({ rel, r }); };
  for (const t of TARGETS) {
    const text = texts[t.rel];
    if (t.kind === 'js') {
      add(t.rel, audit(text, t.label, {
        declared: t.declared,
        externalKeys: t.externalKeysFrom ? externalKeys : [],
      }));
    } else if (t.kind === 'html') {
      const src = res.results.find((x) => x.rel === t.tableFrom);
      add(t.rel, auditHtml(text, t.label, {
        declared: t.declared,
        arKeys: (src && src.r.arKeys) || [],
        enKeys: (src && src.r.enKeys) || [],
      }));
    } else if (t.kind === 'manifest') {
      const locales = (t.locales || []).map((l) => ({ locale: l.locale, rel: l.rel, text: texts[l.rel] }));
      add(t.rel, auditManifest(text, t.label, { declared: t.declared, locales }));
    }
  }

  for (const { r } of res.results) {
    res.checks += r.checks;
    for (const f of r.failures) res.failures.push(f);
  }
  return res;
}

/* ══ التشغيل الموسَّع (الافتراضي) ═══════════════════════════════════════════ */
function mainMulti() {
  console.log('=== حارس تعريب الإضافة: مسح موسَّع على ملفات التشغيل ===');
  console.log('  الملفات المُعلَنة: ' + TARGETS.length + ' (' +
    TARGETS.map((t) => t.label).join(' · ') + ')');

  const texts = {};
  const all = [];
  for (const t of TARGETS) {
    all.push(t.rel);
    for (const l of t.locales || []) all.push(l.rel);
  }
  for (const rel of all) {
    const p = path.join(REPO, rel);
    if (fs.existsSync(p)) texts[rel] = fs.readFileSync(p, 'utf8');
  }

  const r = auditAll(texts);
  if (r.missing.length) {
    for (const m of r.missing) console.error('✗ صفر مدخل: الملف المُعلَن ' + m + ' مفقود أو فارغ.');
    console.error('✗ حارس التعريب (مسح موسَّع): ' + r.missing.length + ' ملفاً مُعلَناً لم يُقَس.');
    process.exit(1);
  }

  console.log('');
  for (const { rel, r: x } of r.results) {
    const c = x.counts || {};
    const bits = [];
    if (c.tableAr !== undefined) {
      bits.push('نصّ عربي **داخل الجدول** (المدخل المقيس): ' + c.tableAr);
      bits.push('مواضع عربية خارج الجدول (المطلوب 0): ' + (c.outsideUnits === undefined ? '—' : c.outsideUnits));
      bits.push('مفاتيح ar=' + c.ar + ' · en=' + c.en + ' · ميتة=' + c.deadKeys +
        ' · نداءات t()=' + c.tCalls + ' · مفاتيح من خارج الملف=' + c.externalKeys +
        ' · مفاتيح تخزين=' + c.storageKeys);
    }
    if (c.htmlBindings !== undefined) {
      bits.push('مواضع ربط: data-i18n=' + c.htmlBindings + ' · data-i18n-attr=' + c.htmlAttrBindings +
        ' · محارف عربية خارج التعليقات=' + c.htmlArabic);
    }
    if (c.manifestArabic !== undefined) {
      bits.push('عربية في المانيفست (المطلوب 0): ' + c.manifestArabic + ' · مراجع __MSG_=' + c.msgRefs +
        ' · مفاتيح _locales=' + c.localeKeys + ' · عناصر نائبة=' + c.msgPlaceholders);
    }
    console.log('--- ' + rel + ' — ' + x.checks + ' فحصاً · ' + x.failures.length + ' فاشل ---');
    for (const s of bits) console.log('  ' + s);
  }

  console.log('\n=== الأحكام ===');
  if (r.failures.length) {
    for (const f of r.failures) console.error(f);
    console.error('✗ حارس التعريب (مسح موسَّع): فشل ' + r.failures.length + ' من ' + Math.max(r.checks, 1) + ' فحصاً.');
    process.exit(1);
  }
  if (r.checks === 0) {
    console.error('✗ صفر مدخل: لم يُنفَّذ فحص واحد — لا نجاح فارغ.');
    process.exit(1);
  }
  console.log('✓ ' + r.checks + ' فحصاً ناجحاً / 0 فاشل على ' + r.results.length + ' ملفات (' +
    r.results.map((x) => x.rel.replace('browser-extension/', '') + ' ' + x.r.checks).join(' · ') + ')');
}

/* ══ التشغيل ═══════════════════════════════════════════════════════════════ */
function main() {
  console.log('=== حارس تعريب الإضافة: ' + path.relative(REPO, FILE).replace(/\\/g, '/') + ' ===');
  if (!fs.existsSync(FILE)) {
    console.error('✗ صفر مدخل: الملف غير موجود عند ' + FILE + ' — لا شيء يُقاس.');
    process.exit(1);
  }
  const text = fs.readFileSync(FILE, 'utf8');
  if (text.trim() === '') {
    console.error('✗ صفر مدخل: الملف فارغ عند ' + FILE + ' — لا شيء يُقاس.');
    process.exit(1);
  }

  const r = audit(text, path.basename(FILE));

  console.log('\n=== ١) جدول الترجمة: وجوده وتكافؤ مفاتيحه ===');
  console.log('  اللغات: ' + (r.langs.join(' · ') || '—') +
    ' · مفاتيح ar=' + (r.counts.ar === undefined ? '—' : r.counts.ar) +
    ' · en=' + (r.counts.en === undefined ? '—' : r.counts.en));
  console.log('\n=== ٢) النصوص العربية والمدخل المقيس ===');
  console.log('  نصّ عربي **داخل الجدول** (المدخل المقيس): ' + (r.counts.tableAr === undefined ? 0 : r.counts.tableAr));
  console.log('  محارف عربية **داخل تعليق** (لا تُعدّ نصّ واجهة): ' + (r.counts.commentArabic === undefined ? 0 : r.counts.commentArabic) +
    ' على ' + (r.counts.commentLines === undefined ? 0 : r.counts.commentLines) + ' سطراً');
  /* الجرد **بنيوي ومحسوب من هذا الملف** — لا من سكربت خارجي مثبَّت على شجرة أخرى.
   * والسطر صريح بالمقياس المستعمل ومقارنته بالمقياس الآخر، لأن «١٨/٣٥» المنشور
   * يخلط مقياسين: السلسلة/القالب **كاملة** (ما يعدّه ARCHIVE/count-arabic.cjs)
   * مقابل **الوحدة النصّية** (شظية القالب بين `${…}` معدودةً وحدها) — والفرق
   * بينهما مطابقة عابرة في تعبير ARCHIVE لا نصوص حقيقية. */
  console.log('  جرد بنيوي: مواضع عربية خارج الجدول = ' + (r.counts.outsideUnits === undefined ? '—' : r.counts.outsideUnits) +
    ' (المطلوب 0) · مواضع عربية داخل الجدول = ' + (r.counts.tableUnits === undefined ? '—' : r.counts.tableUnits) +
    ' · قيم فريدة = ' + (r.counts.uniqueAr === undefined ? '—' : r.counts.uniqueAr) +
    ' · مفاتيح = ' + (r.counts.ar === undefined ? '—' : r.counts.ar));
  if (r.counts.dupPairs && r.counts.dupPairs.length) {
    console.log('  أزواج عربية متطابقة (تفسّر فرق المواضع/الفريد): ' + r.counts.dupPairs.join(' · '));
  }
  console.log('  نداءات t() = ' + (r.counts.tCalls === undefined ? '—' : r.counts.tCalls) +
    ' · مفاتيح فريدة مستعملة = ' + (r.counts.tKeysUnique === undefined ? '—' : r.counts.tKeysUnique) +
    ' · مفاتيح ميتة = ' + (r.counts.deadKeys === undefined ? '—' : r.counts.deadKeys) +
    ' · مفاتيح بعناصر نائبة = ' + (r.counts.placeholderKeys === undefined ? '—' : r.counts.placeholderKeys));
  console.log('  قائمة السماح لبناء النصّ الديناميكي: ' + (r.counts.dynPatterns === undefined ? '—' : r.counts.dynPatterns) +
    ' نمطاً، كلّها بعدد 0 موضعاً');
  console.log('\n=== ٣) الأحكام ===');

  const shown = Math.max(r.checks, 1);
  /* الترتيب مقصود: **الأحكام المُسمّاة أولاً**، ثم بوابة «صفر فحص». لو قُدّمت
   * بوابة الصفر لطمست الرسالة المسمّاة: قيس ذلك على نسخة ما قبل التعريب — الحارس
   * كان يقول «صفر مدخل: لم يُنفَّذ فحص واحد» وهو يخفي السبب الحقيقي («جدول الترجمة
   * مفقود»)، ورسالة لا تسمّي العيب تُخالف §③ من بوّابة الحرّاس. */
  if (r.failures.length) {
    for (const f of r.failures) console.error(f);
    console.error('✗ حارس التعريب: فشل ' + r.failures.length + ' من ' + shown + ' فحصاً.');
    process.exit(1);
  }
  if (r.checks === 0) {
    console.error('✗ صفر مدخل: لم يُنفَّذ فحص واحد — لا نجاح فارغ.');
    process.exit(1);
  }
  console.log('✓ ' + r.checks + ' فحصاً ناجحاً / 0 فاشل — ' +
    r.counts.tableAr + ' نصّ عربي كلّه داخل جدول الترجمة، ومفاتيح ar/en متكافئة (' +
    r.counts.ar + ' مفتاحاً)، والنصوص داخل التعليقات لا تُحسب.');
}

module.exports = {
  audit, auditAll, auditHtml, auditManifest, htmlBindings, stripHtmlComments, storageKeys, attrKeyOf,
  TARGETS, scanLiterals, stripComments, balancedBlock, commentRanges, findTable, AR,
};

if (MAIN) {
  /* `--file`/`--root` = المقيس الواحد (توافقاً مع مُفسَدات م٦-أ وبوّابة الحرّاس). */
  if (EXPLICIT) main(); else mainMulti();
}
