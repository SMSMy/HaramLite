#!/usr/bin/env node
/* حارس تعريب الإضافة — node scripts/check-extension-i18n.cjs [--file <مسار>]
 *
 * الخطة: ARCHIVE/0.2.9PLAN.md §٩-أ. والمانيفست **لا يفحصه هذا الحارس** — المقيس
 * `browser-extension/content.js` وحده (كما في check-extension-sync.cjs:16).
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
 * **مُفسَدات هذا الحارس** بيد المستخدم في `ARCHIVE`؟ لا — بل في
 * `scripts/check-extension-i18n-mutants.cjs`، تُشغَّل في الذاكرة بلا ملفات مؤقتة،
 * ويُسجّلها `pnpm guards:selfcheck` كحالة مستقلة (ضابط + مُفسَدات + صفر مدخل).
 *
 * `--file` للتشغيل على نسخة أخرى (يستعمله اختبار «الشيفرة قبل التعريب»). ويُقبل
 * `--root` أيضاً على نمط بقية الحرّاس. والأعلام **معلنة كلها** فوسيط مجهول يُسقط
 * الحارس بـ2 ولا يُتجاهل صامتاً.
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

/* ══ النواة: تُقاس على نصّ مُمرَّر (فتعمل المُفسَدات في الذاكرة) ═════════════ */
function audit(text, label) {
  const res = { checks: 0, failures: [], counts: {}, langs: [], arabic: 0 };

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

  /* ── ⑤ لا مفتاح مكرَّر (المكرَّر يُسقط الذي قبله صامتاً) ────────────────── */
  const dup = [];
  const raw = table.literal;
  for (const L of ['ar', 'en']) {
    const lm = new RegExp('\\b' + L + '\\s*:\\s*\\{').exec(raw);
    if (!lm) continue;
    const b = balancedBlock(raw, raw.indexOf('{', lm.index));
    if (!b) continue;
    const seen = new Set();
    for (const l of scanLiterals(b.body, false)) {
      if (l.kind !== 'str') continue;
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
  if (computed.length) {
    res.failures.push('✗ ' + computed.length + ' نداءً لـ`t(` بمفتاح غير نصّ حرفي — ' + label +
      ' (أسطر: ' + computed.join(' · ') + ') — المفتاح المحسوب يخالف §٢٦ ويُخفي النصّ عن الحارس.');
  }

  res.counts.commentArabic = commentArabic;
  res.counts.commentLines = commentLines;

  /* ── ⑪ عربية **بلا نصّ حرفيّ**: `String.fromCharCode(0x…)` / `codePointAt` ──
   * ثقب قيس فعلاً: `toast(String.fromCharCode(0x639, 0x634))` لا يحمل نصّاً
   * حرفياً فيه عربية، فيمرّ من كل فحص نصّي أعلاه — وهو **بناء ديناميكي للنصّ**،
   * أي مخالفة §٢٦ بعينها لا مجرّد التفاف على المرشّح. */
  res.checks++;
  const dynArab = [];
  const fcRe = /\bfromCharCode\s*\(([^)]*)\)|\bfromCodePoint\s*\(([^)]*)\)/g;
  let fm;
  while ((fm = fcRe.exec(noCom)) !== null) {
    const args = (fm[1] !== undefined ? fm[1] : fm[2]) || '';
    const nums = args.match(/0[xX][0-9a-fA-F]+|\b\d+\b/g) || [];
    const hit = nums.map((x) => parseInt(x, /^0[xX]/.test(x) ? 16 : 10))
      .filter((cp) => cp >= 0x0600 && cp <= 0x06FF);
    if (hit.length) {
      dynArab.push(lineOf(text, fm.index) + ' (' + hit.map((c) => 'U+' + c.toString(16).toUpperCase()).join(' ') + ')');
    }
  }
  if (dynArab.length) {
    res.failures.push('✗ ' + dynArab.length + ' موضعاً يبني عربية بلا نصّ حرفيّ (' + label + '): ' +
      dynArab.join(' · ') + ' — النصّ لا يُبنى ديناميكياً (§٢٦)، ويُخفى عن هذا الحارس.');
  }

  /* ── ⑫ عربية **مُرمَّزة** (base64 ⇒ atob / Buffer.from) ────────────────────
   * ثقب قيس بمحاولة إخفاء: `toast(atob('2YbYtSDYudix2KjZig=='))` — لا محرف عربي
   * في الشيفرة إطلاقاً، فيمرّ من كل فحص أعلاه. والعلاج: يُفكّ كل نصّ حرفيّ يُمرَّر
   * إلى `atob(` أو `Buffer.from(…,'base64')`، ويُقاس الناتج. */
  res.checks++;
  const decoded = [];
  {
    const decRe = /\b(?:atob|btoa)\s*\(\s*(['"])([A-Za-z0-9+/=\s]{8,})\1|\bBuffer\s*\.\s*from\s*\(\s*(['"])([A-Za-z0-9+/=\s]{8,})\3\s*,\s*(['"])base64\5/gs;
    let dm;
    while ((dm = decRe.exec(noCom)) !== null) {
      const b64 = (dm[2] !== undefined ? dm[2] : dm[4]) || '';
      let txt = '';
      try { txt = Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { txt = ''; }
      if (AR.test(txt)) decoded.push(lineOf(text, dm.index) + ' ⇒ «' + txt.slice(0, 40) + '»');
    }
  }
  if (decoded.length) {
    res.failures.push('✗ ' + decoded.length + ' نصّاً عربياً **مُرمَّزاً** (base64) في ' + label + ': ' +
      decoded.join(' · ') + ' — الإخفاء بالترميز لا يُعفي النصّ من الجدول.');
  }

  return res;
}

function lineOf(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
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

module.exports = { audit, scanLiterals, stripComments, balancedBlock, commentRanges, findTable, AR };

if (MAIN) main();
