#!/usr/bin/env node
/* مُقيِّم صفوف المتصفّح (م٧ — الطبقة ج) — node scripts/check-browser-rows.mjs
 *
 * **القاعدة الحاكمة في م٧**: «لا ائتمان بلا أثر مُعاد إنتاجه». فلكل صفّ هنا
 * **مكافأة رقمية** تُطبع بجانبه، ولكل ادّعاء **مُفسَد** يجب أن يُسقطه
 * (`--self-check`)، ولا يُقاس شيء بتخمين.
 *
 * والصفوف الثلاثة (خطة 0.2.9 §١٠ الطبقة ج):
 *   ① `browser.popup`  — المنبثقة: تُحمَّل `popup.html` مع `popup.js` **المشحونين**
 *      في DOM حقيقي (‏jsdom) بواجهة `chrome` مصنوعة ⇒ الاتجاه والنصّ **المعروضان**
 *      وعدد الحقول/الأزرار المقيسة من المستند نفسه (لا من عدّ نصّي في الملف)،
 *      **واختيار الوضع بنقرتين حقيقيّتين**: ما يُعلنه الزرّ وما يُرسَل فعلاً.
 *   ② `browser.youtube` — مشغّل يوتيوب: **صفحة مُحاكاة** تُصنع هنا وتُقدَّم على
 *      خادم محلّي، وتُفتح عبر **مسار CDP القائم** (`scripts/check-layout.cjs`
 *      نفسه: `--headless=new` + `DevToolsActivePort` + WebSocket)، وتُحقن فيها
 *      **الدوال النقية المستخرجة من `content.js` المشحون** نصّاً (`mapFullToCut`
 *      · `isGap` · `skipVideoGaps` · `nextGapStart` · `gapStats` ·
 *      `keptStretchAround`) مع `pageVideo` نفسه. و**الفيديو المُضلِّل يأتي قبل
 *      المشغّل** فيكشف `pageVideo` الساقطة إلى المحدِّد العام (ثقب مقيس أُغلق).
 *      ثم يُمشى الخط الزمني كما يمشيه المشغّل: تسليح بـ`nextGapStart`، وقفزة عند
 *      كل فجوة، وإعادة إرساء بـ`mapFullToCut`، وقياس ما يحيط الفجوة
 *      بـ`keptStretchAround` — فالدوال الستّ **حاملة** لا محقونة فقط.
 *      **ولا وسائط تُحمَّل ولا تُشغَّل** (`<video>` بلا `src`).
 *   ③ `browser.song-clip` — فرق song/clip على **عقدين**: عقد الجسر في الرست
 *      (`mode` و`page_kept` في `last`) **يُقاس بتشغيل اختبارَي العقد** القائمين
 *      (`cargo test --lib`، بذاكرة مربوطة ببصمة المصادر)، وعقد الإضافة **يُقاس
 *      بتشغيل `background.js` المشحون فعلاً** (قيمتان تعبران وما سواهما لا).
 *      **ونقص استهلاك الصفحة للحقلين يُعلَن** بعدّه (‏`page_kept` في الإضافة = 0)
 *      ولا يُسكَت عنه.
 *
 * **حدّ مُعلَن يجب أن يُحترم**: كروم ١٥٣ **لا يحترم `--load-extension`** ⇒
 * **تحميل الإضافة في متصفّح حقيقي غير مقيس هنا**، ولا يُدّعى. المقيس: **حقن عبر
 * CDP** في صفحة مُحاكاة (المشغّل) · **jsdom** (المنبثقة وعقد الأوضاع) · **تشغيل
 * اختبارَي عقد الجسر في الرست**. ولا يُشغَّل صوت ولا فيديو حقيقي في أيّ صفّ.
 *
 * الاستعمال:
 *   node scripts/check-browser-rows.mjs                    # الصفوف الثلاثة + آثارها
 *   node scripts/check-browser-rows.mjs --engine=jsdom      # بديل معلَن (يُسمّى في الأثر)
 *   node scripts/check-browser-rows.mjs --rust=skip         # بلا تشغيل عقد الجسر ⇒ ٨.٣ غير مقيَّم
 *   node scripts/check-browser-rows.mjs --require-clip      # عقد clip شرطٌ صريح
 *   node scripts/check-browser-rows.mjs --self-check        # ١٠ مُفسَدات + ٥ ضوابط
 *   node scripts/check-browser-rows.mjs --no-out            # بلا كتابة آثار
 *
 * **والافتراضيّ صارم**: غياب متصفّح Chromium فشل صريح (لا سقوط صامت إلى jsdom
 * فيُوسَم ✅ بلا قياس في متصفّح)؛ والبديل يُطلب صراحةً بـ`--engine=jsdom`.
 *
 * رموز الخروج: 0 = كل ما قيس مرّ · 1 = فحص ساقط أو غياب مطلوب · 2 = استعمال/بنية.
 *
 * لا اعتماديات جديدة: `jsdom` وحدها (موجودة في `node_modules` للإضافة) عبر
 * `createRequire`، وباقي الأدوات من `node:` وحده.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { findTable } = require('./check-extension-i18n.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/* ── الوسائط ──────────────────────────────────────────────────────────── */

const USAGE = `الاستعمال: node scripts/check-browser-rows.mjs [خيارات]

  --root=<dir>        جذر المقيس (افتراضاً جذر المستودع) — لبيئة مصنوعة/مُفسَدة
  --engine=cdp|jsdom  محرّك المشغّل: CDP في صفحة مُحاكاة (افتراضاً) أو jsdom
                      (‏jsdom **اختيار صريح**، ويُسمّى في مخرَج الصفّ وأثره)
  --require-clip      غياب عقد clip فشل صريح (والافتراضي اليوم: العقد مقيس)
  --rust=auto|run|skip  عقد الجسر: قياس مخزون ببصمة المصادر (افتراضاً) · تشغيل · ترك
  --rust-timeout=<ms> مهلة كل نداء cargo (افتراضاً 900000)
  --self-check        يشغّل المُفسَدات والضوابط على **نسخ مؤقّتة** ويسقط عليها
  --json              مخرَج آلة
  --out=<dir>         مجلد آثار الصفوف (افتراضاً qa/browser-rows) — لكل صفّ <رقمه>.json
  --no-out            لا يكتب آثاراً
  --keep              يُبقي مجلد العمل المؤقّت للتفتيش
  --quiet             لا يطبع تفاصيل الفحوص الساقطة

**وأثر الصفّ هو شرطه**: بوّابة المصفوفة (matrix-check.cjs) ترفض وسم ✅ في صفّ
من §٨ بلا أثر مطابق في مجلد الآثار. والأثر **مُلتزَم** ليكون الدليل في الشجرة لا
على قرص عامل واحد؛ وتكتبه هذه الأداة من جديد عند كل تغيير في سطح القياس.
`;

function parseArgs(argv) {
  const o = {
    root: REPO, engine: 'cdp', json: false, quiet: false, selfCheck: false,
    requireClip: false, keep: false, out: path.join(REPO, 'qa', 'browser-rows'), noOut: false,
    rust: 'auto', rustTimeoutMs: 900000, help: false,
  };
  // الصيغتان مقبولتان: `--root=<dir>` و`--root <dir>` — بوّابة الحرّاس تُمرّر
  // المسار **منفصلاً** (`['--root', dir]`) كما في كل حرّاس هذا المستودع، ومُقيِّم
  // لا يقبل إلا صيغةً واحدة يفشل بـ2 على بيئة سليمة (قِيس فعلاً في أول ربط).
  const VALUE_FLAGS = new Set(['--root', '--engine', '--out', '--rust', '--rust-timeout']);
  for (let i = 0; i < argv.length; i++) {
    let raw = argv[i];
    if (VALUE_FLAGS.has(raw)) {
      if (argv[i + 1] === undefined) { process.stderr.write(`وسيط بلا قيمة: ${raw}\n`); o.help = true; continue; }
      raw = `${raw}=${argv[++i]}`;
    }
    if (raw === '--json') o.json = true;
    else if (raw === '--quiet') o.quiet = true;
    else if (raw === '--self-check') o.selfCheck = true;
    else if (raw === '--require-clip') o.requireClip = true;
    else if (raw === '--no-out') o.noOut = true;
    else if (raw === '--keep') o.keep = true;
    else if (raw === '--help' || raw === '-h') o.help = true;
    else if (raw.startsWith('--root=')) o.root = path.resolve(raw.slice(7));
    else if (raw.startsWith('--engine=')) o.engine = raw.slice(9);
    else if (raw.startsWith('--out=')) o.out = path.resolve(raw.slice(6));
    else if (raw.startsWith('--rust=')) o.rust = raw.slice(7);
    else if (raw.startsWith('--rust-timeout=')) o.rustTimeoutMs = Number(raw.slice(15)) || 900000;
    else { process.stderr.write(`وسيط غير معروف: ${raw}\n`); o.help = true; }
  }
  if (!['cdp', 'jsdom'].includes(o.engine)) {
    process.stderr.write(`--engine يقبل cdp|jsdom، وورد «${o.engine}»\n`);
    o.help = true;
  }
  if (!['auto', 'run', 'skip'].includes(o.rust)) {
    process.stderr.write(`--rust يقبل auto|run|skip، وورد «${o.rust}»\n`);
    o.help = true;
  }
  return o;
}

/* ── تسجيل الفحوص ─────────────────────────────────────────────────────── */

class ZeroInput extends Error {}

/**
 * مُبلِّغ بثلاث حِمال: `checks` كل الفحوص · `failures` الساقط **فعلاً** ·
 * `expected` ما سقط لأن شرطه **لم يُبنَ بعد** على هذا الفرع (‏`page_kept`).
 * والفصل مقصود ولا يجوز دمجه: لو حُسب المتوقَّع ساقطاً لصار الفرع أحمر دائماً،
 * ولو حُسب ساقطاً **غير** متوقَّع لصار ثقباً (حُذف صفّ clip من الحكم كاملاً في
 * أول نسخة من هذا المُقيِّم، فمرّ مُفسَد بوّابة الأوضاع — وهو الثقب الذي أغلقه
 * هذا الفصل: الفشل المتوقَّع **واحد بعينه** يُستثنى، لا الصفّ كلّه).
 */
function makeReporter() {
  const checks = [];
  const failures = [];
  const expected = [];
  const push = (label, cond, detail, bucket) => {
    checks.push({ label, ok: !!cond, detail: detail === undefined ? null : String(detail), expected: bucket === expected });
    if (!cond) bucket.push(detail ? `${label} — ${detail}` : label);
  };
  return {
    checks, failures, expected,
    ok(label, cond, detail) { push(label, cond, detail, failures); },
    /** فحص شرطه غير قائم بعد على هذا الفرع: سقوطه **معلَن** لا يُسقط المُقيِّم. */
    expect(label, cond, detail) { push(label, cond, detail, expected); },
    count: () => checks.length,
  };
}

const log = (...a) => process.stdout.write(`${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── تحميل المشحون ────────────────────────────────────────────────────── */

const NEEDED = ['popup.html', 'popup.js', 'content.js', 'background.js', 'manifest.json'];

function loadSources(root) {
  const ext = path.join(root, 'browser-extension');
  if (!fs.existsSync(ext)) {
    throw new ZeroInput(`صفر مدخل: مجلد browser-extension غير موجود في «${ext}» — لا شيء يُقاس`);
  }
  const missing = NEEDED.filter((f) => !fs.existsSync(path.join(ext, f)));
  if (missing.length) {
    throw new ZeroInput(
      `صفر مدخل: ملفات الإضافة المشحونة ناقصة في «${ext}» — مفقود: ${missing.join(' · ')}`,
    );
  }
  const read = (f) => fs.readFileSync(path.join(ext, f), 'utf8');
  const src = {
    root, ext,
    popupHtml: read('popup.html'),
    popupJs: read('popup.js'),
    contentJs: read('content.js'),
    backgroundJs: read('background.js'),
    manifest: JSON.parse(read('manifest.json')),
    files: Object.fromEntries(NEEDED.map((f) => [f, read(f)])),
  };
  if (!src.manifest || typeof src.manifest.version !== 'string') {
    throw new ZeroInput('صفر مدخل: manifest.json بلا حقل version — لا إصدار يُقاس');
  }
  return src;
}

/** كتلة بموازنة الأقواس من نصّ الملف المشحون (الآلية نفسها في `check-extension-sync.cjs`). */
function extractBlock(text, opener) {
  const i = text.indexOf(opener);
  if (i < 0) return null;
  const start = text.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return { body: text.slice(start + 1, j), full: text.slice(i, j + 1) }; }
  }
  return null;
}

/** يُفرّغ التعليقات بمسافات (الإزاحات محفوظة) — لقراءة **حياة** العبارة لا وجود نصّها. */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; }
      if (i < text.length) { out += '  '; i += 2; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') { out += text[i]; i++; if (i < text.length) { out += text[i]; i++; } continue; }
        out += text[i]; i++;
      }
      if (i < text.length) { out += text[i]; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/* ── الصفحة المُحاكاة + مُسبق الحقن ───────────────────────────────────── */

export const RUNNER_FIXTURE = {
  duration: 80,
  // الخريطة **معطاة** كما يُعطى `LAST.kept` من مسار المعالجة (‏bridge.rs ← kept_ranges).
  kept: [[0, 10], [10.5, 20], [22, 30], [33, 40], [48, 60], [69, 80]],
  jumpThreshold: 0.5, // نفسه المشحون: gapStats(kept, 0.5)
  step: 0.05,         // خطوة المشية (50ms — نبضة المشغّل 40ms في الملف المشحون)
  scanStep: 0.005,    // خطوة المسح الزمني (5ms) — كل حدود الخريطة من مضاعفاتها
};

/** الأرقام المتوقَّعة محسوبة **يدوياً** من الخريطة أعلاه (لا من الدوال المقيسة):
 *  المقاطع المحفوظة 10 · 9.5 · 8 · 7 · 12 · 11 ⇒ keptSum = 57.5
 *  والفجوات 0.5 · 2 · 3 · 8 · 9 ⇒ خمس فجوات، ومجموعها 22.5 = 80 − 57.5 ✓
 *  والمدرّج hist [1,0,2,0,2] (نطاقات 0.5–1 · 1–2 · 2–4 · 4–8 · ≥8)،
 *  وطول ما يحيط كل فجوة: قبلها [10, 9.5, 8, 7, 12] وبعدها [9.5, 8, 7, 12, 11]. */
export const RUNNER_EXPECTED = {
  gaps: 5,
  keptSum: 57.5,
  gapSeconds: 22.5,
  jumps: 5,
  hist: [1, 0, 2, 0, 2],
  gapLens: [0.5, 2, 3, 8, 9],
  stretchBefore: [10, 9.5, 8, 7, 12],
  stretchAfter: [9.5, 8, 7, 12, 11],
};

/**
 * أوراكل **مستقلّ** في المُقيِّم (تنفيذ ثانٍ في Node لا في الصفحة) لنفس القوانين
 * المعلنة: مجموع المحفوظ · عدد الفجوات · ثواني الفجوات · القفزات · مدرّج
 * النطاقات الخمسة · وطول ما يحيط كل فجوة. وهو يقابل **كل** رقم في المكافأة،
 * فلا يبقى رقم مقيس بلا شاهد ثانٍ (وما يخالف الأوراكل يسقط الصفّ).
 */
function oracleOf(kept, duration, jumpThreshold) {
  const valid = kept.map((p) => [Number(p[0]), Number(p[1])]).filter(([a, b]) => b > a);
  const keptSum = valid.reduce((s, [a, b]) => s + (b - a), 0);
  const gaps = [];
  let prevEnd = 0;
  for (let i = 0; i < valid.length; i++) {
    const [a, b] = valid[i];
    if (a > prevEnd) {
      const before = i > 0 ? valid[i - 1][1] - valid[i - 1][0] : 0;
      gaps.push({ len: a - prevEnd, before, after: b - a });
    }
    prevEnd = b;
  }
  const hist = [0, 0, 0, 0, 0];
  let smallGaps = 0, smallSeconds = 0;
  for (const g of gaps) {
    if (g.len <= jumpThreshold) { smallGaps++; smallSeconds += g.len; }
    if (g.len < 0.5) continue;
    if (g.len < 1) hist[0]++;
    else if (g.len < 2) hist[1]++;
    else if (g.len < 4) hist[2]++;
    else if (g.len < 8) hist[3]++;
    else hist[4]++;
  }
  const r6 = (x) => +x.toFixed(6);
  return {
    gaps: gaps.length,
    keptSum: r6(keptSum),
    gapSeconds: r6(duration - keptSum),
    jumps: gaps.length,
    hist,
    smallGaps,
    smallSeconds: r6(smallSeconds),
    gapLens: gaps.map((g) => r6(g.len)),
    stretchBefore: gaps.map((g) => r6(g.before)),
    stretchAfter: gaps.map((g) => r6(g.after)),
  };
}

/**
 * الصفحة المُحاكاة.
 *
 * **ترتيب الفيديو المُضلِّل مقصود ومُقاس**: المُضلِّل يأتي **قبل** `#movie_player`،
 * فـ`document.querySelector('video')` يعيده هو لا فيديو المشغّل. ولو جاء بعده
 * (كما كان في أول نسخة) لكان `querySelector('video')` يعيد **فيديو المشغّل نفسه**
 * ⇒ `pageVideo` الساقطة إلى المحدِّد العام تمرّ بلا كشف — وهو ثقب مقيس أثبته
 * الجاسوس المستقلّ (`ARCHIVE/m7c-browser-spy.md` و-١). والمُسبار يقيس الترتيب
 * صراحةً (`firstVideoId`) فلا يبقى الاعتماد على قراءة النصّ.
 */
const SIM_PAGE = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><title>HaramLite — صفحة يوتيوب مُحاكاة</title></head>
<body>
  <!-- الفيديو المُضلِّل **أوّلاً**: يكشف مُحدِّداً يسقط إلى document.querySelector('video') -->
  <video id="hl-decoy-video" width="160" height="90" muted></video>
  <div id="movie_player">
    <video id="hl-sim-video" width="640" height="360" muted playsinline></video>
  </div>
  <p id="hl-sim-note">صفحة مُحاكاة: لا وسائط تُحمَّل ولا تُشغَّل (video بلا src).</p>
</body>
</html>
`;

/** الدوال النقية المستخرجة من `content.js` المشحون — بالنصّ لا بإعادة كتابة. */
const PURE_NAMES = ['mapFullToCut', 'isGap', 'skipVideoGaps', 'nextGapStart', 'gapStats', 'keptStretchAround'];

function buildPrelude(contentJs) {
  const blocks = [];
  for (const n of PURE_NAMES) {
    const b = extractBlock(contentJs, `function ${n}(`);
    if (!b) throw new ZeroInput(`صفر مدخل: تعذّر استخراج الدالّة النقية «${n}» من content.js المشحون`);
    blocks.push(b.full);
  }
  const pv = extractBlock(contentJs, 'function pageVideo()');
  if (!pv) throw new ZeroInput('صفر مدخل: تعذّر استخراج pageVideo() من content.js المشحون');
  blocks.push(pv.full);
  return `${blocks.join('\n')}\nwindow.__hlPure = { ${[...PURE_NAMES, 'pageVideo'].join(', ')} };\ntrue;`;
}

/** المُسبار: يُمشى الخط الزمني كما يمشيه المشغّل. يُشغَّل في الصفحة (CDP) أو في jsdom. */
function runnerProbe(args) {
  const P = window.__hlPure;
  if (!P) return { error: 'الدوال المحقونة غائبة عن الصفحة' };
  const { kept, duration, step, scanStep, jumpThreshold } = args;

  // ① مُحدِّد المشغّل نفسه: هل يجد فيديو المشغّل لا الفيديو المُضلِّل الموضوع خارج المشغّل؟
  let picked = null;
  try { picked = P.pageVideo ? P.pageVideo() : null; } catch (e) { return { error: `pageVideo رمى: ${e && e.message}` }; }

  // ② إحصاء المشغّل للخريطة (المكافأة المعلنة في الخطة: عدد الفجوات · keptSum)
  const st = P.gapStats(kept, jumpThreshold);

  // ③ مسح زمني مستقلّ: كم ثانية يحكم عليها isGap بأنها فجوة؟
  let gapSamples = 0;
  for (let t = 0; t < duration; t = +(t + scanStep).toFixed(9)) if (P.isGap(t, kept)) gapSamples++;

  // ④ المشية كما يمشيها المشغّل: ماسح `armGapJump` يقرأ الحدّ بـ`nextGapStart`
  //    (`content.js`: `const boundary = nextGapStart(now, kept);`)، وعند بلوغ الحدّ
  //    يقفز `skipVideoGaps` إلى بداية المقطع المحفوظ التالي، والموضع يُعاد إرساؤه
  //    بـ`mapFullToCut`، وطول ما يحيط الفجوة يُقاس بـ`keptStretchAround` (وهو ما
  //    يقرأه `pacePlan`). فالدوال الستّ كلها **حاملة** في هذا المشهد لا محقونة فقط.
  let t = 0, jumps = 0, stalled = false, monotone = true, steps = 0, boundary = null;
  const landings = [], audioAfterJump = [], landingsInKept = [], stretches = [];
  let prev = P.mapFullToCut(0, kept);
  let guard = 0;
  while (t < duration && guard++ < 2000000) {
    if (boundary !== null && t >= boundary - 1e-9) {
      const land = P.skipVideoGaps(t, kept);
      if (!(land > t)) { stalled = true; break; }
      const around = P.keptStretchAround(kept, boundary, land);
      stretches.push({ before: +Number(around.before).toFixed(6), after: +Number(around.after).toFixed(6) });
      jumps++;
      landings.push(+Number(land).toFixed(6));
      landingsInKept.push(!P.isGap(land, kept));
      audioAfterJump.push(+Number(P.mapFullToCut(land, kept)).toFixed(6));
      t = +Number(land).toFixed(9);
      prev = P.mapFullToCut(t, kept);
      boundary = null;
      continue;
    }
    const a = P.mapFullToCut(t, kept);
    if (a < prev - 1e-9) monotone = false;
    prev = a;
    steps++;
    t = +(t + step).toFixed(9);
    const armed = P.nextGapStart(t, kept);
    if (armed !== null && (boundary === null || armed < boundary)) boundary = armed;
  }

  const playerVideo = document.querySelector('#movie_player video');
  const firstVideo = document.querySelector('video');
  return {
    pickedVideo: picked
      ? { id: picked.id || null, tag: picked.tagName, inPlayer: !!(picked.closest && picked.closest('#movie_player')) }
      : null,
    videoCount: document.querySelectorAll('video').length,
    firstVideoId: firstVideo ? (firstVideo.id || null) : null,
    playerVideoId: playerVideo ? (playerVideo.id || null) : null,
    gaps: st.gaps,
    keptSum: +Number(st.keptSum).toFixed(6),
    hist: st.hist,
    smallGaps: st.smallGaps,
    smallSeconds: +Number(st.smallSeconds).toFixed(6),
    gapSecondsScanned: +(gapSamples * scanStep).toFixed(6),
    scanSamples: Math.round(duration / scanStep),
    jumps, stalled, monotone, steps,
    landings, audioAfterJump, landingsInKept, stretches,
    audioFinal: +Number(P.mapFullToCut(duration, kept)).toFixed(6),
    audioAtZero: +Number(P.mapFullToCut(0, kept)).toFixed(6),
  };
}

/* ── متصفّح CDP (نفس مسار `check-layout.cjs`) ─────────────────────────── */

function findBrowser() {
  const isFile = (p) => { try { return Boolean(p) && fs.statSync(p).isFile(); } catch { return false; } };
  const cands = [
    process.env.HARAMLITE_BROWSER, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) if (isFile(c)) return c;
  return null;
}

function killTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status === 0;
    }
    process.kill(pid, 'SIGKILL');
    return true;
  } catch { return false; }
}

function pidsOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
      const pids = new Set();
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        const cols = line.trim().split(/\s+/);
        if ((cols[1] || '').endsWith(`:${port}`)) { const pid = Number(cols[cols.length - 1]); if (pid) pids.add(pid); }
      }
      return [...pids];
    }
    const r = spawnSync('lsof', ['-t', `-i:${port}`], { encoding: 'utf8' });
    return String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
  } catch { return []; }
}

function pidsByProfile(dir, exeBase) {
  try {
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process -Filter "Name='${exeBase}'" | Where-Object { $_.CommandLine -like '*${dir}*' } | Select-Object -ExpandProperty ProcessId`;
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
      return String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
    }
    const r = spawnSync('pgrep', ['-f', dir], { encoding: 'utf8' });
    return String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
  } catch { return []; }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    ws.addEventListener('close', () => {
      for (const [, p] of this.pending) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot open CDP socket ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }
  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`CDP ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
      const fns = this.listeners.get(key);
      if (fns) for (const fn of fns.slice()) fn(msg.params);
    }
  }
  on(key, fn) {
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(fn);
    return () => { const a = this.listeners.get(key) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  }
  once(key, timeoutMs) {
    return new Promise((resolve, reject) => {
      const off = this.on(key, (params) => { off(); clearTimeout(timer); resolve(params); });
      const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${key}`)); }, timeoutMs);
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function launchBrowser(exe) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hl-browser-rows-'));
  const portFile = path.join(dir, 'DevToolsActivePort');
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--metrics-recording-only', '--mute-audio', '--hide-scrollbars',
    '--allow-insecure-localhost', '--window-size=1280,800', 'about:blank',
  ];
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const deadline = Date.now() + 30000;
  let port = 0;
  while (Date.now() < deadline) {
    try {
      const txt = await fs.promises.readFile(portFile, 'utf8');
      const first = txt.split(/\r?\n/)[0].trim();
      if (first) { port = Number(first); break; }
    } catch { /* not written yet */ }
    await sleep(120);
  }
  if (!port) {
    killTree(child.pid);
    throw new Error(`المتصفّح لم يُبلّغ منفذ DevTools خلال 30s\n${stderr.trim()}`);
  }
  let version = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* not up yet */ }
    await sleep(150);
  }
  if (!version) {
    killTree(child.pid);
    for (const pid of pidsOnPort(port)) killTree(pid);
    throw new Error('نقطة DevTools HTTP لم تُجب');
  }

  const cleanup = async () => {
    const exeBase = path.basename(exe);
    const report = { killed: [], profileRemoved: false, profile: dir, leaked: false };
    if (child.exitCode === null && child.signalCode === null) { if (killTree(child.pid)) report.killed.push(child.pid); }
    for (const pid of pidsByProfile(dir, exeBase)) { killTree(pid); report.killed.push(pid); }
    for (const pid of pidsOnPort(port)) { if (!report.killed.includes(pid)) report.killed.push(pid); killTree(pid); }
    for (let i = 0; i < 15; i++) {
      try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* locked */ }
      if (!fs.existsSync(dir)) { report.profileRemoved = true; break; }
      await sleep(200);
    }
    report.leaked = !report.profileRemoved || pidsOnPort(port).length > 0;
    return report;
  };
  const cleanupSync = () => {
    if (child.exitCode === null && child.signalCode === null) killTree(child.pid);
    for (const pid of pidsByProfile(dir, path.basename(exe))) killTree(pid);
    for (const pid of pidsOnPort(port)) killTree(pid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { child, port, version, cleanup, cleanupSync };
}

/* ── خادم ثابت للصفحة المُحاكاة ───────────────────────────────────────── */

function startStaticServer(root) {
  const notFound = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
      const file = path.join(root, rel);
      const relCheck = path.relative(root, file);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) { res.writeHead(403).end('forbidden'); return; }
      let body = null;
      try { body = await fs.promises.readFile(file); } catch { body = null; }
      if (body === null) { notFound.push(rel); res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`not here: ${rel}`); return; }
      res.writeHead(200, { 'content-type': rel.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) { res.writeHead(500).end(String(err && err.message)); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port, address } = server.address();
      if (address !== '127.0.0.1') { server.close(); reject(new Error(`server bound to ${address}`)); return; }
      resolve({ server, port, origin: `http://127.0.0.1:${port}`, notFound });
    });
  });
}

/** يشغّل المُسبار في هدف جديد عبر CDP (المسار القائم في `check-layout.cjs`). */
async function runProbeOverCdp(cdp, pageUrl, prelude, args) {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    const loaded = cdp.once(`${sessionId}:Page.loadEventFired`, 30000);
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    await loaded;
    const pre = await cdp.send('Runtime.evaluate', { expression: prelude, returnByValue: true, awaitPromise: true }, sessionId);
    if (pre.exceptionDetails) {
      throw new Error(`حقن الدوال النقية رمى: ${pre.exceptionDetails.text} ${(pre.exceptionDetails.exception || {}).description || ''}`);
    }
    const res = await cdp.send('Runtime.evaluate', {
      expression: `(${runnerProbe.toString()})(${JSON.stringify(args)})`,
      returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (res.exceptionDetails) {
      throw new Error(`مُسبار المشغّل رمى: ${res.exceptionDetails.text} ${(res.exceptionDetails.exception || {}).description || ''}`);
    }
    return res.result.value;
  } finally {
    try { await cdp.send('Target.closeTarget', { targetId: target.targetId }); } catch { /* ignore */ }
  }
}

/** البديل المعلَن: المُسبار نفسه في jsdom (يُسمّى صراحةً في مخرَج الصفّ). */
function runProbeOverJsdom(prelude, args) {
  const dom = new JSDOM(SIM_PAGE, { url: 'https://haramlite.test/sim-watch.html', runScripts: 'outside-only' });
  const w = dom.window;
  try {
    w.eval(prelude);
    return w.eval(`(${runnerProbe.toString()})(${JSON.stringify(args)})`);
  } finally { w.close(); }
}

/* ── الصفّ ①: المنبثقة ────────────────────────────────────────────────── */

function popupTable(popupJs) {
  const t = findTable(popupJs);
  if (!t) throw new ZeroInput('صفر مدخل: جدول الترجمة `const I18N = {` غير مقروء من popup.js');
  return new Function(`${t.literal}\nreturn I18N;`)();
}

/**
 * يُصيّر المنبثقة المشحونة في jsdom بواجهة `chrome` مصنوعة، ويُرجع النافذة
 * **وما أرسله السكربت فعلاً** (`sent`). الرسائل مسجَّلة لأن اختيار الوضع يُقاس
 * بما **يُرسَل** لا بحالة الزرّ وحدها (و-٣ في تقرير الجاسوس المستقلّ).
 */
function renderPopup(src, languages) {
  const dom = new JSDOM(src.popupHtml, { url: 'https://haramlite.test/popup.html', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(w.navigator, 'language', { value: languages[0] || 'en', configurable: true });
  const sent = [];
  w.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: src.manifest.version }),
      sendMessage: (msg, cb) => { sent.push(msg); if (cb) setTimeout(() => cb({ ok: true, resp: { state: {} } }), 0); },
    },
    tabs: {
      query: (_q, cb) => cb([{ id: 1, url: 'https://www.youtube.com/watch?v=abc', title: 'Example video' }]),
      sendMessage: (_id, _m, cb) => cb({ ok: true }),
    },
  };
  w.eval(src.popupJs);
  return { w, sent };
}

/**
 * قياس **اختيار الوضع**: نقرتان حقيقيّتان على عنصري البطاقة، وقراءة ما يترتّب
 * عليهما في DOM وفي التخزين **وفي الرسالة المُرسَلة**. (الحالة الابتدائية وحدها
 * لا تكشف «لا أستطيع اختيار وضع الأغنية» — ثقب مقيس أثبته الجاسوس.)
 */
function measureModeChoice(src) {
  return (async () => {
    const { w, sent } = renderPopup(src, ['ar-SA']);
    const q = (s) => w.document.querySelector(s);
    const aria = () => ({ clip: q('#mode-clip').getAttribute('aria-pressed'), song: q('#mode-song').getAttribute('aria-pressed') });
    const stored = () => { try { return w.localStorage.getItem('hl.popup.mode'); } catch { return null; } };
    const lastSend = () => {
      const m = sent.filter((x) => x && x.type === 'send').pop();
      return m ? (Object.prototype.hasOwnProperty.call(m, 'mode') ? m.mode : null) : undefined;
    };
    const out = { afterSongClick: null, afterClipClick: null, sentModeSong: null, sentModeClip: null, storedSong: null, storedClip: null, sendCount: 0 };
    try {
      q('#mode-song').click();
      out.afterSongClick = aria();
      out.storedSong = stored();
      q('#btn-send-page').click();                       // يُرسل {type:'send', url, mode}
      out.sentModeSong = lastSend();
      // زرّ الإرسال يُعطَّل حتى ردّ الخلفية (‏`el.send.disabled = true`)، فننتظر
      // دورة الأحداث قبل النقرة الثانية — وإلا فنقرة على زرّ معطَّل لا تقع أصلاً
      // (قِيس: النقرة الثانية لم تُرسل شيئاً فبقي الوضع المرصود song).
      await sleep(10);

      q('#mode-clip').click();
      out.afterClipClick = aria();
      out.storedClip = stored();
      q('#btn-send-page').click();
      out.sentModeClip = lastSend();
      out.sendCount = sent.filter((x) => x && x.type === 'send').length;
    } finally { w.close(); }
    return out;
  })();
}

function measurePopup(src, r) {
  return (async () => {
  const I18N = popupTable(src.popupJs);
  const arR = renderPopup(src, ['ar-SA', 'en-US']);
  const enR = renderPopup(src, ['en-US', 'ar']);
  const ar = arR.w;
  const en = enR.w;

  // **لقطة متزامنة قبل أي `await`**: آلة الحالة تكتب بعد دورة الأحداث
  // (`status()` ثم `setState`)، فقراءة النصّ بعد الانتظار تقيس ما كتبته الحالة
  // لا ما ربطه `applyI18n` — وهو خطأ مقيس في أول نسخة من قياس النقر.
  const boundNodes = [...ar.document.querySelectorAll('[data-i18n]')];
  const bound = boundNodes.map((n) => n.getAttribute('data-i18n'));
  const textAr = boundNodes.map((n) => n.textContent);
  const textEn = [...en.document.querySelectorAll('[data-i18n]')].map((n) => n.textContent);
  const undefSnapshot = [...ar.document.querySelectorAll('[data-i18n]'), ...en.document.querySelectorAll('[data-i18n]')]
    .filter((n) => /undefined/.test(n.textContent)).map((n) => n.getAttribute('data-i18n'));
  const arCharsSnapshot = [...en.document.body.textContent].filter((c) => /[\u0600-\u06FF]/.test(c)).length;
  const initialAria = {
    clip: (ar.document.querySelector('#mode-clip') || {}).getAttribute ? ar.document.querySelector('#mode-clip').getAttribute('aria-pressed') : null,
    song: (ar.document.querySelector('#mode-song') || {}).getAttribute ? ar.document.querySelector('#mode-song').getAttribute('aria-pressed') : null,
  };
  const versionTag = (ar.document.querySelector('.version-tag') || {}).textContent;
  // العدّ **القديم** (‏`data-i18n="…"`) يُحسب ويُعرَض للمقابلة لا للحكم: هو يفوت
  // ربطاً باقتباس مفرد، فيُرى الفرق في الأثر نفسه (وضابط C4 يثبته).
  const boundNaive = (src.popupHtml.match(/\bdata-i18n="/g) || []).length;
  const nCtl = ar.document.querySelectorAll('button, input, select, textarea, [role="button"]').length;
  const nBtn = ar.document.querySelectorAll('button').length;
  const nRole = ar.document.querySelectorAll('[role="button"]').length;
  const modeItems = ar.document.querySelectorAll('#card-modes [role="button"]').length;

  const modes = await measureModeChoice(src);
  const reward = {
    fields: nCtl, buttons: nBtn, roleButtons: nRole,
    i18nBoundNodes: boundNodes.length,
    i18nBoundNodesNaiveRegex: boundNaive,
    dirAr: ar.document.documentElement.dir, langAr: ar.document.documentElement.lang,
    dirEn: en.document.documentElement.dir, langEn: en.document.documentElement.lang,
    modeItems, initialAria,
    clipAfterSongClick: modes.afterSongClick, clipAfterClipClick: modes.afterClipClick,
    sentModeSong: modes.sentModeSong, sentModeClip: modes.sentModeClip,
    storedModeSong: modes.storedSong, storedModeClip: modes.storedClip,
  };

  r.ok('المنبثقة تُحمَّل وتُصيَّر، ولها حقول مقيسة في DOM حقيقي', nCtl > 0, `الحقول المقيسة=${nCtl}`);
  r.ok('العربية ⇒ direction=rtl و lang=ar', reward.dirAr === 'rtl' && reward.langAr === 'ar', `${reward.dirAr}/${reward.langAr}`);
  r.ok('الإنجليزية ⇒ direction=ltr و lang=en', reward.dirEn === 'ltr' && reward.langEn === 'en', `${reward.dirEn}/${reward.langEn}`);
  r.ok('الاتجاه مشتقّ من اللغة (المستندان مختلفان)', reward.dirAr !== reward.dirEn);
  r.ok('الحقول المقيسة = أزرار + عناصر بدور زر (لا نوع آخر غير محسوب)',
    nCtl === nBtn + nRole, `${nCtl} ≠ ${nBtn}+${nRole}`);
  r.ok('بطاقة الوضع تحمل عنصرين اثنين بدور زر (song/clip)', reward.modeItems === 2, `وُجد ${reward.modeItems}`);
  r.ok('عُقد الربط تُقاس من DOM (لا يقلّ عددها عن عدّ `data-i18n="` النصّي)',
    reward.i18nBoundNodes >= reward.i18nBoundNodesNaiveRegex && reward.i18nBoundNodes > 0,
    `DOM=${reward.i18nBoundNodes} · العدّ النصّي=${reward.i18nBoundNodesNaiveRegex}`);

  // ── اختيار الوضع: نقرتان حقيقيّتان وما يترتّبان عليهما ────────────────────
  r.ok('نقرة على #mode-song ⇒ الزرّان يعلنان song (‏aria-pressed)',
    !!modes.afterSongClick && modes.afterSongClick.song === 'true' && modes.afterSongClick.clip === 'false',
    JSON.stringify(modes.afterSongClick));
  r.ok('ونقرة song تُرسَل فعلاً بوضع song في رسالة الإرسال',
    modes.sentModeSong === 'song', `mode=${JSON.stringify(modes.sentModeSong)} · رسائل send=${modes.sendCount}`);
  r.ok('والاختيار يُحفظ (hl.popup.mode = song)', modes.storedSong === 'song', JSON.stringify(modes.storedSong));
  r.ok('نقرة على #mode-clip ⇒ الزرّان يعلنان clip (العكس)',
    !!modes.afterClipClick && modes.afterClipClick.clip === 'true' && modes.afterClipClick.song === 'false',
    JSON.stringify(modes.afterClipClick));
  r.ok('ونقرة clip تُرسَل فعلاً بوضع clip في رسالة الإرسال',
    modes.sentModeClip === 'clip', `mode=${JSON.stringify(modes.sentModeClip)}`);
  r.ok('والاختيار يُحفظ (hl.popup.mode = clip)', modes.storedClip === 'clip', JSON.stringify(modes.storedClip));

  const wrongAr = bound.filter((k, i) => textAr[i] !== I18N.ar[k]);
  const wrongEn = bound.filter((k, i) => textEn[i] !== I18N.en[k]);
  r.ok(`كل عقدة ربط تعرض قيمتها العربية (${bound.length} عقدة من DOM، لقطة قبل أي await)`,
    wrongAr.length === 0, `مخالف: ${wrongAr.join(' · ')}`);
  r.ok(`كل عقدة ربط تعرض قيمتها الإنجليزية (${bound.length} عقدة من DOM، لقطة قبل أي await)`,
    wrongEn.length === 0, `مخالف: ${wrongEn.join(' · ')}`);

  r.ok('لا عنصر مربوط يعرض `undefined` (مفتاح مفقود من الجدول)', undefSnapshot.length === 0, undefSnapshot.join(' · '));
  r.ok('المستند الإنجليزي المعروض بصفر محرف عربي', arCharsSnapshot === 0, `وُجد ${arCharsSnapshot}`);
  r.ok('الوضع الابتدائي المعروض = clip (‏aria-pressed قبل أي نقر)',
    reward.initialAria.clip === 'true' && reward.initialAria.song === 'false',
    JSON.stringify(reward.initialAria));
  r.ok(`وسم الإصدار في الصفحة = إصدار المانيفست (${src.manifest.version})`,
    versionTag === `v${src.manifest.version}`, `وُجد ${JSON.stringify(versionTag)}`);

  ar.close(); en.close();
  return reward;
  })();
}

/* ── الصفّ ②: مشغّل يوتيوب ────────────────────────────────────────────── */

function measureRunner(src, r, probeResult, engineNote) {
  const F = RUNNER_FIXTURE;
  const E = RUNNER_EXPECTED;
  const oracle = oracleOf(F.kept, F.duration, F.jumpThreshold);
  const reward = { engine: engineNote, ...probeResult };

  // الأوراكل يقابل **كل** رقم في المكافأة (لا gaps وkeptSum وحدهما): ثواني
  // الفجوات والقفزات والمدرّج وطول ما يحيط كل فجوة — وكلّها محسوبة في Node.
  const oracleMismatch = [];
  if (oracle.gaps !== E.gaps) oracleMismatch.push(`gaps ${oracle.gaps}≠${E.gaps}`);
  if (Math.abs(oracle.keptSum - E.keptSum) > 1e-9) oracleMismatch.push(`keptSum ${oracle.keptSum}≠${E.keptSum}`);
  if (Math.abs(oracle.gapSeconds - E.gapSeconds) > 1e-9) oracleMismatch.push(`gapSeconds ${oracle.gapSeconds}≠${E.gapSeconds}`);
  if (oracle.jumps !== E.jumps) oracleMismatch.push(`jumps ${oracle.jumps}≠${E.jumps}`);
  if (JSON.stringify(oracle.hist) !== JSON.stringify(E.hist)) oracleMismatch.push(`hist ${JSON.stringify(oracle.hist)}≠${JSON.stringify(E.hist)}`);
  if (JSON.stringify(oracle.stretchBefore) !== JSON.stringify(E.stretchBefore)) oracleMismatch.push('stretchBefore');
  if (JSON.stringify(oracle.stretchAfter) !== JSON.stringify(E.stretchAfter)) oracleMismatch.push('stretchAfter');
  r.ok('الأوراكل المستقلّ يوافق الأرقام المكتوبة بيد (‏gaps · keptSum · gapSeconds · jumps · hist · ما يحيط كل فجوة)',
    oracleMismatch.length === 0, oracleMismatch.join(' · '));
  if (!probeResult || probeResult.error) {
    r.ok('المُسبار أعاد قياساً (لا خطأ)', false, probeResult ? probeResult.error : 'بلا نتيجة');
    return reward;
  }

  r.ok('الفيديو المُضلِّل **قبل** المشغّل فعلاً (‏querySelector العام يعيده هو لا فيديو المشغّل)',
    probeResult.firstVideoId === 'hl-decoy-video', `أول فيديو=${JSON.stringify(probeResult.firstVideoId)}`);
  r.ok('مُحدِّد المشغّل `pageVideo()` يجد فيديو المشغّل في الصفحة المُحاكاة (لا الفيديو المُضلِّل خارجها)',
    !!probeResult.pickedVideo && probeResult.pickedVideo.id === 'hl-sim-video' && probeResult.pickedVideo.inPlayer === true,
    `وُجد ${JSON.stringify(probeResult.pickedVideo)} · عدد الفيديوهات=${probeResult.videoCount}`);
  r.ok('والصفحة المُحاكاة فيها فعلاً أكثر من فيديو (فالسقوط إلى `video` العام كان سيُخطئ)',
    probeResult.videoCount === 2, `عدد الفيديوهات=${probeResult.videoCount}`);

  r.ok(`عدد الفجوات التي حسبها المشغّل = ${E.gaps}`, probeResult.gaps === E.gaps, `وُجد ${probeResult.gaps}`);
  r.ok(`مجموع ما حُفظ keptSum = ${E.keptSum}`,
    Math.abs(probeResult.keptSum - E.keptSum) < 1e-9, `وُجد ${probeResult.keptSum}`);
  r.ok('وكل رقم في المكافأة يطابق الأوراكل المستقلّ (‏keptSum · hist · smallGaps · smallSeconds)',
    Math.abs(probeResult.keptSum - oracle.keptSum) < 1e-9
      && JSON.stringify(probeResult.hist) === JSON.stringify(oracle.hist)
      && probeResult.smallGaps === oracle.smallGaps
      && Math.abs(probeResult.smallSeconds - oracle.smallSeconds) < 1e-6,
    `المقيس keptSum=${probeResult.keptSum} hist=${JSON.stringify(probeResult.hist)} smallGaps=${probeResult.smallGaps}/${probeResult.smallSeconds} · الأوراكل ${oracle.keptSum}/${JSON.stringify(oracle.hist)}/${oracle.smallGaps}/${oracle.smallSeconds}`);

  r.ok(`عدد القفزات في المشية = عدد الفجوات (${E.jumps})`, probeResult.jumps === E.jumps, `وُجد ${probeResult.jumps}`);
  r.ok('المشية لم تتجمّد (كل قفزة تقدّمت للأمام)', probeResult.stalled === false, 'تجمّدت: skipVideoGaps لم يتقدّم');
  r.ok(`موضع الصوت عند نهاية الخط الزمني = keptSum (${E.keptSum}) — هوية mapFullToCut(المدة) = مجموع المحفوظ`,
    Math.abs(probeResult.audioFinal - E.keptSum) < 1e-6,
    `audioFinal=${probeResult.audioFinal} وkeptSum=${probeResult.keptSum}`);
  r.ok('وخريطة الموضع غير متنازلة على المشية (لا رجوع للخلف)', probeResult.monotone === true);
  r.ok(`ثواني الفجوات بالمسح الزمني = المدة − keptSum (${E.gapSeconds})`,
    Math.abs(probeResult.gapSecondsScanned - E.gapSeconds) < 1e-6,
    `وُجد ${probeResult.gapSecondsScanned} (عينات=${probeResult.scanSamples})`);
  r.ok('كل موضع هبوط بعد القفزة داخل مقطع محفوظ (‏isGap كاذب)',
    Array.isArray(probeResult.landingsInKept) && probeResult.landingsInKept.length === probeResult.jumps
      && probeResult.landingsInKept.every(Boolean),
    `الهبوطات=${JSON.stringify(probeResult.landings)} · داخل المحفوظ=${JSON.stringify(probeResult.landingsInKept)}`);
  r.ok('مدرّج الفجوات hist = ما يحسبه الأوراكل (نطاقات 0.5–1 · 1–2 · 2–4 · 4–8 · ≥8)',
    JSON.stringify(probeResult.hist) === JSON.stringify(oracle.hist),
    `المقيس=${JSON.stringify(probeResult.hist)} · الأوراكل=${JSON.stringify(oracle.hist)}`);
  // `nextGapStart` يقود التسليح و`keptStretchAround` يقيس ما يحيط كل فجوة —
  // فالدالتان **حاملتان** في المشهد لا محقونتان فقط (كانتا لا تُنادىان: و-٥).
  const sb = (probeResult.stretches || []).map((s) => s.before);
  const sa = (probeResult.stretches || []).map((s) => s.after);
  r.ok('ما يحيط كل فجوة (‏keptStretchAround عند كل قفزة) = الأوراكل، وموضع كل هبوط يليه مقطع محفوظ',
    JSON.stringify(sb) === JSON.stringify(oracle.stretchBefore) && JSON.stringify(sa) === JSON.stringify(oracle.stretchAfter),
    `before=${JSON.stringify(sb)} · after=${JSON.stringify(sa)} · الأوراكل ${JSON.stringify(oracle.stretchBefore)}/${JSON.stringify(oracle.stretchAfter)}`);

  return reward;
}

/* ── الصفّ ③: فرق song/clip ───────────────────────────────────────────── */

function renderBackground(src, languages, opts) {
  const o = opts || {};
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://haramlite.test/sw.html', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(w.navigator, 'language', { value: languages[0] || 'en', configurable: true });
  const sent = [];
  const createLog = o.createLog || [];
  const errors = [];
  const installed = [];
  const onChange = [];
  const store = Object.assign({}, o.store || {});
  w.console = Object.assign({}, w.console, {
    error: (...a) => { errors.push(a.map((x) => (x && x.message) || String(x)).join(' ')); },
    warn: () => {}, log: () => {},
  });
  let onMessage = null;
  const port = {
    onMessage: { addListener() { /* المُقيِّم لا يردّ: يُقاس ما يُرسَل لا ما يُستقبل */ } },
    onDisconnect: { addListener() { /* ignore */ } },
    postMessage(m) { sent.push(m); },
    disconnect() { /* ignore */ },
  };
  w.chrome = {
    runtime: {
      lastError: null,
      onInstalled: { addListener(fn) { installed.push(fn); } },
      connectNative: () => port,
      onMessage: { addListener(fn) { onMessage = fn; } },
      getManifest: () => ({ version: '0.0.0' }),
    },
    contextMenus: {
      // **غير متزامنة كما في المتصفّح**: النداء الراجع بعد دورة الحدث، فيتقاطع بناءان
      // إن لم يكن في الكود بوابة. (وبلا هذه المحاكاة لا يُقاس العطل أصلاً.)
      removeAll(cb) { if (o.removeAllAsync) setTimeout(() => { if (cb) cb(); }, 0); else if (cb) cb(); },
      create(props, cb) {
        createLog.push({ id: props && props.id, title: props && props.title });
        if (o.failCreate) w.chrome.runtime.lastError = { message: 'duplicate id ' + (props && props.id) };
        else w.chrome.runtime.lastError = null;
        if (cb) cb();                        // الكود يقرأ `lastError` داخل النداء الراجع
        w.chrome.runtime.lastError = null;   // ولا يتسرّب إلى نداءٍ تالٍ
      },
      onClicked: { addListener() {} },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          if (typeof cb === 'function') cb(out);
        },
        set: (obj, cb) => { Object.assign(store, obj); if (typeof cb === 'function') cb(); },
      },
      onChanged: { addListener(fn) { onChange.push(fn); } },
    },
  };
  w.eval(src.backgroundJs);
  return {
    w, sent, createLog, errors,
    onMessage: () => onMessage,
    fireInstalled: () => { for (const fn of installed) { try { fn({ reason: 'install' }); } catch { /* ignore */ } } },
    fireStorage: (changes) => { for (const fn of onChange) { try { fn(changes); } catch { /* ignore */ } } },
    installedCount: installed.length,
    onChangeCount: onChange.length,
  };
}

const MODE_REQUESTS = [
  { label: 'clip', msg: { type: 'send', url: 'https://youtu.be/1', mode: 'clip' }, want: 'clip' },
  { label: 'song', msg: { type: 'send', url: 'https://youtu.be/2', mode: 'song' }, want: 'song' },
  { label: 'garbage', msg: { type: 'send', url: 'https://youtu.be/3', mode: 'nonsense' }, want: null },
  { label: 'absent', msg: { type: 'send', url: 'https://youtu.be/4' }, want: null },
];

const ROW_IDS = { popup: 'browser.popup', runner: 'browser.youtube', clip: 'browser.song-clip' };

/** ربط صفوف المُقيِّم بأرقامها في `qa/TEST-MATRIX.md` §٨ — وهو ما تقرأه بوّابة
 *  المصفوفة (`matrix-check.cjs`): أثر كل صفّ اسمه `<رقم الصف>.json`. */
const MATRIX_ROW = { [ROW_IDS.popup]: '8.1', [ROW_IDS.runner]: '8.2', [ROW_IDS.clip]: '8.3' };

/* ── عقد الجسر: `mode` و`page_kept` في `last` — يُقاس بالتشغيل لا بالقراءة ────
 *
 * بند `clip` دُمج: `last_ok_payload` (‏`bridge.rs`) يحمل `mode` (`song`/`clip`)
 * و`page_kept` (خريطة صوت الصفحة في `clip`، وفارغة في `song`)، و`kept` يبقى خريطة
 * **الملف المُسلَّم**؛ وفي `pipeline.rs` يذهب قصّ صوت الصفحة في `clip` إلى
 * `page_kept` وتبقى `kept_ranges` **فارغة** (ملف المستخدم كامل الطول). وهذه
 * الدالّة **تُشغّل اختبارَي العقد القائمين في المستودع** وتقرأ سطريهما المُوسَمين —
 * فلا شيفرة تُقرأ ولا تعليق يُصدَّق، بل العقد نفسه يُقاس.
 *
 * **وحدّها المعلَن**: تقيس **عقد السلك في الرست** لا استهلاكه في الصفحة — والإضافة
 * لا تقرأ `page_kept` بعد (عدد إشاراته يُقاس ويُعلَن في المكافأة، فلا يُسكَت عنه).
 */
const RUST_SOURCES = [
  'src-tauri/src/bridge.rs',
  'src-tauri/src/pipeline.rs',
  'src-tauri/src/m6b_clip_guard.rs',
];
const RUST_TESTS = [
  { key: 'wire', filter: 'the_wire_contract_distinguishes_modes_and_page_kept_mirrors_kept_in_clip', tag: 'M6B-SPY' },
  { key: 'clip', filter: 'the_clip_contract_carries_page_kept_and_keeps_kept_ranges_empty', tag: 'M6B-GUARD' },
];
const RUST_CACHE = path.join('qa', 'eval', 'out', 'bridge-contract.json');

/**
 * **سطح القياس** لكل صفّ: الملفات التي يقرأها قياسه فيتغيّر الحكم بتغيّرها.
 * بصمة كل ملف تُكتب في الأثر، و`matrix-check.cjs` **يعيد حسابها من الشجرة** —
 * فتغيّر ملف واحد يجعل الأثر بائتاً فيسقط الصفّ حتى يُعاد القياس. وهذا العقد
 * يناسب صفّ متصفّح (لا ثنائي يُربَط ببصمته كما في الطبقة أ) ويجعل «لا ائتمان بلا
 * أثر مُعاد إنتاجه» قائماً في §٨ لا استثناءً منه.
 */
const ROW_SURFACE = {
  [ROW_IDS.popup]: [
    'browser-extension/popup.html', 'browser-extension/popup.js',
    'browser-extension/manifest.json', 'scripts/check-browser-rows.mjs',
  ],
  [ROW_IDS.runner]: ['browser-extension/content.js', 'scripts/check-browser-rows.mjs'],
  [ROW_IDS.clip]: [
    'browser-extension/background.js', 'browser-extension/content.js',
    'browser-extension/popup.js', 'browser-extension/popup.html',
    'scripts/check-browser-rows.mjs', ...RUST_SOURCES,
  ],
};

/**
 * يكتب **أثر كل صفّ** باسم رقمه في المصفوفة، وهو ما تقرأه `matrix-check.cjs`.
 * والأثر **مُلتزَم** ليكون الدليل في الشجرة لا على قرص عامل واحد، ولذلك لا يحمل
 * طابعاً زمنياً ولا التزاماً ولا إصدار متصفّح: كل ما فيه **مشتقّ من الشجرة**،
 * فإعادة تشغيله على شجرة لم تتغيّر تُنتج الملف نفسه بايتاً بايت (فلا يوسّخ git).
 */
function writeRowArtifacts(res, opts) {
  const written = [];
  for (const row of res.rows) {
    const num = MATRIX_ROW[row.id];
    if (!num) continue;
    // **صفٌّ لم يُقَس لا يُكتب له أثر**: لا يُقال «pass» ولا «fail» عن قياس لم
    // يقع (‏`--rust=skip` مثلاً). والأثر القديم يبقى — وهو شهادة قياس سابق
    // بالمُقيِّم نفسه على السطح نفسه. أمّا صفٌّ قيس وسقط فيُكتب أثره `fail`
    // فيوسّخ الشجرة ويُسقط البوّابة: العطل يُرى ولا يُسكَت.
    if (row.clipUnmeasured) {
      if (!opts.json) log(`أثر الصفّ ${num}: لم يُكتب — الصفّ غير مقيَّم في هذا التشغيل`);
      continue;
    }
    const surface = ROW_SURFACE[row.id].map((rel) => ({ path: rel, sha256: sha256File(path.join(opts.root, rel)) }));
    const outputs = Object.entries(flattenReward(row.reward))
      // `bridgeState`/`bridgeWhy` يصفان **كيف** جرى التشغيل (تشغيل أو ذاكرة مطابقة)
      // لا **ما** قيس — ولو دخلا الأثر لتغيّر ملفّه بين تشغيلين على شجرة واحدة
      // (فيوسّخ git بلا تغيير حقيقي). و`engine` كذلك: يُسجَّل حقلاً مستقلاً في
      // الأثر (`engine`) وتُشترط قيمته لكل صفّ في البوّابة، فلا يدخل بصمة المكافأة
      // فيتغيّر الرقم بتغيّر المحرّك بينما القيم المقيسة هي هي.
      .filter(([key, v]) => v !== null && v !== undefined && !/^(bridge(State|Why)|engine)$/.test(key))
      .map(([key, value]) => ({ key, value }));
    const artifact = {
      row: num,
      id: row.id,
      title: row.title,
      evaluator: 'scripts/check-browser-rows.mjs',
      evaluator_sha256: sha256File(path.join(opts.root, 'scripts/check-browser-rows.mjs')),
      engine: row.engine,
      measured: true,
      verdict: row.failures.length === 0 ? 'pass' : 'fail',
      outputs,
      // بصمة المكافأة: تُنسخ في خانة الصفّ بالمصفوفة (`مكافأة:<٨ محارف>`) وتُقابَل
      // هناك — فلا تمرّ أرقامٌ مكتوبة بيد ولو وُجد أثر (و-٢).
      outputs_sha256: sha256(JSON.stringify(outputs)),
      surface,
    };
    const file = path.join(opts.out, `${num}.json`);
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
    written.push({ file, token: artifact.outputs_sha256.slice(0, 8) });
  }
  return written;
}

/** يُسطّح كائن المكافأة إلى مسطح `مفتاح ⇒ قيمة` (بلا كائنات متداخلة) ليكون
 *  `outputs` في الأثر قابلاً للقراءة والمقابلة. */
function flattenReward(reward, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(reward || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenReward(v, key));
    else out[key] = v;
  }
  return out;
}

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** بصمة مصادر العقد: تغيّر أيّها يُبطل القياس المخزون فيُعاد التشغيل. */
function rustKey(root) {
  const parts = [];
  for (const rel of RUST_SOURCES) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return null;
    parts.push(`${rel}:${sha256File(full)}`);
  }
  return { key: sha256(parts.join('\n')), files: parts };
}

/** قيمة من سطر موسوم `k=v` مع تجريد الأقواس التي يطبعها `serde_json::Value`. */
function taggedValue(line, k) {
  const m = new RegExp(`(?:^|\\s)${k}=("[^"]*"|\\S+)`).exec(line);
  return m ? m[1].replace(/^"|"$/g, '') : null;
}

/**
 * يشغّل اختبارَي العقد ويقرأ سطورهما. `opts.rust`:
 *   `auto` (افتراضاً) يعيد القياس المخزون إن طابقت بصمة المصادر، وإلا شغّل؛
 *   `run` يشغّل دائماً؛ `skip` لا يشغّل (فيقول الصفّ «غير مقيس» ولا يقول ✅).
 * وغياب cargo أو المصادر **يُعلَن** ولا يُسكَت.
 */
/** مسار أدوات الشحن: `cargo` في `%USERPROFILE%\.cargo\bin` لا على PATH دائماً
 *  (قِيس: `spawnSync('cargo')` بلا هذا السطر يقول «غير متاح» والأداة موجودة). */
const CARGO_ENV = (() => {
  const bin = path.join(os.homedir(), '.cargo', 'bin');
  const env = { ...process.env };
  env.PATH = fs.existsSync(bin) ? `${bin}${path.delimiter}${env.PATH || ''}` : env.PATH;
  return env;
})();

function bridgeContract(root, opts) {
  const rust = rustKey(root);
  if (!rust) return { state: 'unavailable', why: `مصادر العقد غائبة عن «${root}» (لا src-tauri/src أو ناقصة)` };
  if (opts.rust === 'skip') return { state: 'skipped', why: '‏--rust=skip: لم يُشغَّل اختبار العقد' };

  const cacheFile = path.join(root, RUST_CACHE);
  if (opts.rust === 'auto' && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && cached.rust_sha256 === rust.key && cached.lines) {
        return { state: 'cached', rust, lines: cached.lines, why: 'قياس مخزون ببصمة مصادر مطابقة' };
      }
    } catch { /* ذاكرة تالفة ⇒ يُعاد التشغيل */ }
  }

  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', windowsHide: true, env: CARGO_ENV });
  if (cargo.status !== 0 || !/cargo\s+\d/.test(String(cargo.stdout || ''))) {
    return { state: 'unavailable', why: 'cargo غير متاح (لا على PATH ولا في %USERPROFILE%\\.cargo\\bin) — لا قياس لعقد الجسر' };
  }
  const lines = {};
  const raw = [];
  for (const t of RUST_TESTS) {
    const res = spawnSync('cargo', ['test', '--lib', t.filter, '--', '--nocapture'], {
      cwd: path.join(root, 'src-tauri'), encoding: 'utf8', windowsHide: true, env: CARGO_ENV,
      maxBuffer: 1 << 26, timeout: opts.rustTimeoutMs,
    });
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    raw.push(`--- ${t.filter} (exit ${res.status}) ---\n${out.trim()}`);
    if (res.status !== 0) {
      return { state: 'failed', why: `اختبار العقد «${t.filter}» خرج بـ${res.status === null ? 'مهلة' : res.status}`, raw: raw.join('\n') };
    }
    const line = out.split(/\r?\n/).find((l) => l.includes(t.tag) && l.includes('result='));
    if (!line) return { state: 'failed', why: `سطر ${t.tag} الموسوم غائب عن مخرَج «${t.filter}»`, raw: raw.join('\n') };
    lines[t.key] = line.trim();
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify({ rust_sha256: rust.key, lines, at: new Date().toISOString() }, null, 2)}\n`);
  } catch { /* الذاكرة تحسين لا شرط */ }
  return { state: 'ran', rust, lines, raw: raw.join('\n') };
}


/* ── قياس بناء قائمة النقر الأيمن: نداءان متقاربان ⇒ خمسة عناصر لا عشرة ────────
 * **العطل الميداني** (البناء التكاملي 1.1.9، متصفّح المالك):
 *   `Unchecked runtime.lastError: Cannot create item with duplicate id hl-send-link`
 *   ومعه الأربعة الباقية. والسبب: `removeAll` غير متزامنة، ومساران (‏`onInstalled`
 *   وتبديل اللغة) ينشئان الخمسة كلٌّ بعد `removeAll` ⇒ معرّفات مكرّرة.
 * والمقيس هنا ثلاثة أوجه: **العدد** (‏٥ لا ١٠) · **تفرّد المعرّفات** · **اللغة النهائية**
 * (فلا يكون «الإسقاط» صامتاً بل يحمل أحدث لغة) · و**إعلان الفشل** لا كتمه.
 */
async function measureMenus(src, r) {
  const createLog = [];
  const bg = renderBackground(src, ['en-US', 'en'], { createLog, removeAllAsync: true, store: { 'hl.lang': 'ar' } });
  // «صفر مدخل»: البيئة سجّلت المسارين فعلاً وإلا فالمقيس وهم.
  const wired = bg.installedCount === 1 && bg.onChangeCount === 1;
  r.ok('قائمة النقر الأيمن: البيئة سجّلت مسارَي البناء (onInstalled · storage.onChanged)',
    wired, 'onInstalled=' + bg.installedCount + ' · onChanged=' + bg.onChangeCount);

  // بناء الإقلاع (من `hl.lang` المخزَّن) يقع عند التقييم؛ ننتظره ثمّ نصفّر العدّاد
  // ليكون القياس على **النداءين المتقاربين** وحدهما.
  await sleep(30);
  const bootCreates = createLog.length;
  createLog.length = 0;

  // **نداءان متقاربان**: التثبيت ثم تبديل اللغة **قبل** أن يقع ردّ `removeAll`.
  // **تبديل إلى لغة مختلفة** (`en` بعد أن ضبط الإقلاع `ar`): وإلا فالمستمع يرى
  // `next === LANG` فلا ينادي البناء ⇒ لا بناءان متقاربان، والقياس يقيس الفراغ
  // (وهو ثقب قِيس فعلاً: مُفسَد إزالة البوابة مرّ قبل هذا التصحيح).
  bg.fireInstalled();
  bg.fireStorage({ 'hl.lang': { newValue: 'en' } });
  await sleep(60);

  const ids = createLog.map((c) => c.id);
  const uniq = [...new Set(ids)];
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  const titles = createLog.map((c) => c.title);
  const AR_CHAR = /[\u0600-\u06FF]/;
  // البناء الناتج بلغة `en` (آخر لغة طُلبت) ⇒ **صفر محرف عربي** في العناوين.
  const arabicLeft = titles.filter((x) => AR_CHAR.test(x));

  r.ok('نداءان متقاربان (تثبيت + تبديل لغة) ⇒ **بناء واحد** = خمسة عناصر',
    createLog.length === 5, 'عدد الإنشاءات=' + createLog.length + ' · المعرّفات=' + JSON.stringify(ids));
  r.ok('ولا معرّف مكرّر (وهو نصّ عطل المالك حرفياً)',
    dupes.length === 0, 'مكرّر: ' + JSON.stringify(dupes));
  r.ok('والمعرّفات الخمسة هي المداخل المُعلَنة',
    ['hl-send-link', 'hl-send-page', 'hl-send-video', 'hl-send-song', 'hl-send-clip'].every((x) => uniq.includes(x)),
    JSON.stringify(uniq));
  // **المقيس**: كلّ عنوان من الصفّ العربي (لا أن تتطابق العناوين — فهي خمسة مداخل مختلفة).
  r.ok('**والبناء الناتج بلغة المستخدم الجديدة** (فالإسقاط ليس صمتاً: العناوين تُحسب في ردّ removeAll)',
    titles.length === 5 && arabicLeft.length === 0, 'بقي عربي: ' + JSON.stringify(arabicLeft) + ' · العناوين=' + JSON.stringify(titles));
  bg.w.close();

  // **إعلان الفشل لا كتمه**: إن فشل create فعلاً يُقرأ `lastError` ويُعلَن في السجلّ.
  const failing = renderBackground(src, ['en-US', 'en'], { removeAllAsync: false, failCreate: true });
  await sleep(20);
  failing.fireInstalled();
  await sleep(20);
  const announced = failing.errors.filter((e) => e.includes('contextMenus.create failed')).length;
  r.ok('وفشل إنشاء فعلاً **يُعلَن** في السجلّ ولا يُكتَم (‏lastError مقروء لا «غير مُلتقَط»)',
    announced === 5, 'إعلانات=' + announced + ' · النصّ=' + JSON.stringify(failing.errors.slice(0, 2)));
  failing.w.close();

  return { bootCreates, closeCreates: createLog.length, dupes: dupes.length, announced };
}

async function measureSongClip(src, r, bridge) {
  const menus = await measureMenus(src, r);
  const bg = renderBackground(src, ['ar-SA']);
  const listener = bg.onMessage();
  const forward = [];
  if (typeof listener === 'function') {
    for (const q of MODE_REQUESTS) {
      const before = bg.sent.length;
      try { listener(q.msg, null, () => { /* الردّ غير لازم للقياس */ }); } catch { /* يُقاس الأثر لا الاستثناء */ }
      await sleep(5);
      const out = bg.sent.slice(before);
      forward.push({
        label: q.label, want: q.want, forwardedCount: out.length,
        mode: out.length && Object.prototype.hasOwnProperty.call(out[0], 'mode') ? out[0].mode : null,
        url: out.length ? out[0].url : null,
        type: out.length ? out[0].type : null,
      });
    }
  }
  bg.w.close();

  // استهلاك الصفحة للحقلين: يُقاس على **الكود الحيّ** (التعليقات مُجرَّدة).
  const liveRefs = (re) => {
    const hits = [];
    for (const [f, text] of Object.entries(src.files)) {
      const n = (stripComments(text).match(re) || []).length;
      if (n) hits.push(`${f}×${n}`);
    }
    return hits;
  };
  const pageKeptHits = liveRefs(/page_kept/g);
  const modeFieldHits = liveRefs(/last\.mode|last\['mode'\]/g);

  // مصدر خريطة الصفحة في content.js: تعريف واحد، ومن `LAST.kept` لا من خريطة أخرى.
  const live = stripComments(src.contentJs);
  const keptBindings = (live.match(/(?:const|let|var)\s+kept\b/g) || []).length;
  const keptFromLast = live.includes('const kept = LAST.kept;');

  // عقد الجسر: ما طُبع فعلاً من الاختبارين المُشغَّلين.
  const wire = bridge.lines ? bridge.lines.wire : null;
  const clipLine = bridge.lines ? bridge.lines.clip : null;
  const wireVals = wire
    ? {
        modeSong: taggedValue(wire, 'mode_song'), modeClip: taggedValue(wire, 'mode_clip'),
        mirrors: taggedValue(wire, 'clip_kept_eq_page_kept'), songEmpty: taggedValue(wire, 'song_page_kept_empty'),
        result: taggedValue(wire, 'result'),
      }
    : null;
  const clipVals = clipLine
    ? {
        pageKept: Number(taggedValue(clipLine, 'page_kept_ranges')), kept: Number(taggedValue(clipLine, 'kept_ranges')),
        result: taggedValue(clipLine, 'result'),
      }
    : null;

  const withMode = forward.filter((f) => f.mode !== null);
  const reward = {
    // محسوبة لا مكتوبة: أسماء الأوضاع التي **عبرت فعلاً**، وعددها، وعدد ما رُفض.
    modesForwarded: withMode.map((f) => f.mode).sort().join(','),
    modesAccepted: withMode.length,
    modesRejected: forward.filter((f) => f.mode === null).length,
    requestsDriven: forward.length,
    pageKeptRefsInExtension: pageKeptHits.length,
    lastModeRefsInExtension: modeFieldHits.length,
    keptBindings,
    keptFromLast,
    bridgeState: bridge.state,
    bridgeWhy: bridge.why || null,
    bridgeWire: wireVals,
    bridgeClip: clipVals,
    // بناء قائمة النقر الأيمن: خمسة لا عشرة، وصفر معرّف مكرّر، وخمسة إعلانات فشل مُختبَرة
    menusCloseCreates: menus.closeCreates,
    menusDupes: menus.dupes,
    menusFailAnnounced: menus.announced,
  };

  r.ok(`حقل \`mode\` يُقاس بتشغيل background.js المشحون (${MODE_REQUESTS.length} طلباً دُفع فعلاً)`,
    forward.length === MODE_REQUESTS.length && forward.every((f) => f.forwardedCount === 1 && f.type === 'link'),
    JSON.stringify(forward));
  r.ok('القيمتان المقبولتان حصراً تعبران: clip و song',
    withMode.length === 2 && reward.modesForwarded === 'clip,song',
    `عبر: ${JSON.stringify(withMode.map((f) => f.mode))}`);
  r.ok('وما سواهما لا يعبر: وضع مُفسَد ووضع غائب ⇒ بلا حقل mode (فالتطبيق يحتفظ بإعداده)',
    reward.modesRejected === 2, JSON.stringify(forward.map((f) => `${f.label}:${f.mode}`)));
  r.ok('خريطة الصفحة في content.js تُعرَّف مرة واحدة ومن `LAST.kept`',
    keptBindings === 1 && keptFromLast, `تعريفات=${keptBindings} · من LAST=${keptFromLast}`);

  // ── عقد الجسر (`mode` و`page_kept`) ───────────────────────────────────────
  if (!wireVals || !clipVals) {
    r.expect('عقد الجسر مقيس بالتشغيل (اختبارا الرست خرجا بسطر موسوم)', false,
      `${bridge.state}: ${bridge.why || 'بلا سطور موسومة'}`);
  } else {
    r.ok('عقد الجسر مُشغَّل: الاختباران خرجا بـ`result=PASS`',
      wireVals.result === 'PASS' && clipVals.result === 'PASS', `${wireVals.result}/${clipVals.result}`);
    r.ok('و`mode` يميّز المسارين على السلك: song مقابل clip',
      wireVals.modeSong === 'song' && wireVals.modeClip === 'clip',
      `mode_song=${wireVals.modeSong} · mode_clip=${wireVals.modeClip}`);
    r.ok('و`page_kept` يحمل خريطة الصفحة في clip (مطابقة لـ`kept`) وفارغ في song',
      wireVals.mirrors === 'true' && wireVals.songEmpty === 'true',
      `clip_kept_eq_page_kept=${wireVals.mirrors} · song_page_kept_empty=${wireVals.songEmpty}`);
    r.ok('ومسار clip **لا** يمرّر خريطته إلى `kept_ranges` (ملف المستخدم كامل الطول) وخريطة الصفحة غير فارغة',
      clipVals.kept === 0 && clipVals.pageKept > 0,
      `kept_ranges=${clipVals.kept} · page_kept_ranges=${clipVals.pageKept}`);
  }

  // **نقص الاستهلاك يُعلَن ولا يُسكَت**: العقد قائم، والصفحة تقرأ `LAST.kept` وحدها.
  r.ok('استهلاك الصفحة للحقلين مُعلَن: إمّا يقرأهما، أو يُصرَّح بأنه لا يقرأهما بعد',
    reward.pageKeptRefsInExtension > 0 || keptFromLast === true,
    `page_kept في الإضافة=${reward.pageKeptRefsInExtension} · last.mode=${reward.lastModeRefsInExtension} · kept من LAST=${keptFromLast}`);

  return reward;
}

/* ── تشغيل الصفوف الثلاثة ─────────────────────────────────────────────── */

async function runRows(src, opts) {
  const rows = [];
  const engine = { requested: opts.engine, used: null, browser: null, note: null };

  // ① المنبثقة (jsdom: النصّ والاتجاه المعروضان)
  const r1 = makeReporter();
  let reward1;
  try { reward1 = await measurePopup(src, r1); }
  catch (e) { r1.ok('قياس المنبثقة اكتمل', false, String(e && e.message)); reward1 = { error: String(e && e.message) }; }
  rows.push({ id: ROW_IDS.popup, matrixRow: MATRIX_ROW[ROW_IDS.popup], title: 'المنبثقة (popup.html + popup.js)', engine: 'jsdom', reward: reward1, ...r1 });

  // ② مشغّل يوتيوب: صفحة مُحاكاة (CDP، وإلا فبديل jsdom معلَن)
  const r2 = makeReporter();
  const F = RUNNER_FIXTURE;
  const args = { kept: F.kept, duration: F.duration, step: F.step, scanStep: F.scanStep, jumpThreshold: F.jumpThreshold };
  let prelude = null;
  try { prelude = buildPrelude(src.contentJs); }
  catch (e) { r2.ok('استخراج الدوال النقية من content.js المشحون', false, String(e && e.message)); }

  let probe = null;
  if (prelude) {
    if (opts.__cdp) {
      engine.used = 'cdp';
      engine.browser = opts.__browserVersion;
      try { probe = await runProbeOverCdp(opts.__cdp, opts.__pageUrl, prelude, args); }
      catch (e) { r2.ok('مُسبار المشغّل عبر CDP اكتمل', false, String(e && e.message)); }
    } else {
      engine.used = 'jsdom';
      engine.note = 'لا متصفّح مستعمل — القياس بديل jsdom معلَن';
      try { probe = runProbeOverJsdom(prelude, args); }
      catch (e) { r2.ok('مُسبار المشغّل في jsdom اكتمل', false, String(e && e.message)); }
    }
  }
  const engineNote = engine.used === 'cdp' ? `cdp (${engine.browser || 'chromium'})` : 'jsdom (بديل معلَن)';
  const reward2 = measureRunner(src, r2, probe, engineNote);
  rows.push({ id: ROW_IDS.runner, matrixRow: MATRIX_ROW[ROW_IDS.runner], title: 'مشغّل يوتيوب (صفحة مُحاكاة)', engine: engineNote, reward: reward2, ...r2 });

  // ③ فرق song/clip: عقد الجسر (يُشغَّل) + عقد الإضافة (يُدفع فعلاً)
  const r3 = makeReporter();
  let reward3;
  const bridge = opts.__bridge || bridgeContract(src.root, opts);
  try { reward3 = await measureSongClip(src, r3, bridge); }
  catch (e) { r3.ok('قياس فرق song/clip اكتمل', false, String(e && e.message)); reward3 = { error: String(e && e.message) }; }
  const clipUnmeasured = r3.expected.length > 0;
  rows.push({
    id: ROW_IDS.clip, matrixRow: MATRIX_ROW[ROW_IDS.clip], title: 'فرق song/clip (عقد الجسر + عقد الإضافة)',
    engine: 'rust-test + jsdom + مسح المصدر', reward: reward3, clipUnmeasured, ...r3,
  });

  return { rows, engine, bridge };
}

/* ── العرض ────────────────────────────────────────────────────────────── */

function fmtReward(row) {
  const w = row.reward || {};
  if (row.id === ROW_IDS.popup) {
    return `حقول=${w.fields} (أزرار=${w.buttons} · أدوار=${w.roleButtons}) · عُقد ربط=${w.i18nBoundNodes} · ar=${w.dirAr}/${w.langAr} · en=${w.dirEn}/${w.langEn} · نقرة song⇒${JSON.stringify(w.sentModeSong)} · نقرة clip⇒${JSON.stringify(w.sentModeClip)}`;
  }
  if (row.id === ROW_IDS.runner) {
    return `فجوات=${w.gaps} · keptSum=${w.keptSum} · قفزات=${w.jumps} · ثواني الفجوات=${w.gapSecondsScanned} · موضع الصوت النهائي=${w.audioFinal} · hist=${JSON.stringify(w.hist)} · محرّك=${w.engine}`;
  }
  const bw = w.bridgeWire || {};
  const bc = w.bridgeClip || {};
  return `أوضاع معبَّرة=${w.modesForwarded} (${w.modesAccepted}/${w.requestsDriven}) · عقد الجسر=${w.bridgeState}` +
    (bw.modeSong ? ` [mode ${bw.modeSong}/${bw.modeClip} · page_kept في clip=${bw.mirrors} · فارغ في song=${bw.songEmpty}]` : '') +
    (bc.result ? ` · kept_ranges في clip=${bc.kept} · page_kept_ranges=${bc.pageKept}` : '') +
    ` · استهلاك الإضافة: page_kept=${w.pageKeptRefsInExtension} · last.mode=${w.lastModeRefsInExtension}`;
}

function printReport(res, opts) {
  log('');
  log('═══ صفوف المتصفّح (م٧ — الطبقة ج) ═══');
  log(`الجذر: ${opts.root}`);
  log(`المحرّك: ${res.engine.used || opts.engine}${res.engine.note ? ` — ${res.engine.note}` : ''}`);
  log('');
  log('  الصفّ                الحكم          المكافأة الرقمية');
  for (const row of res.rows) {
    const failed = row.failures.length;
    const verdict = failed ? `✗ ساقط(${failed})` : (row.clipUnmeasured ? '⚠ غير مقيَّم' : '✅ مرّ');
    log(`  ${row.id.padEnd(20)} ${verdict.padEnd(14)} ${fmtReward(row)}`);
    if (!opts.quiet) {
      for (const c of row.checks) if (!c.ok) log(`      ↳ ${c.expected ? '⚠ غير قائم' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    }
  }
  log('');
  const total = res.rows.reduce((n, r) => n + r.count(), 0);
  const failed = res.rows.reduce((n, r) => n + r.failures.length, 0);
  log(`صفوف: ${res.rows.length} · فحوص: ${total} · فاشل: ${failed}`);
}

/* ── المُفسَدات والضوابط ──────────────────────────────────────────────── */

/** كل مُفسَد: الملف + نصّ **قبل/بعد** حرفيّين — وهذا هو مولِّد المُفسَد، يُعاد إنتاجه. */
const MUTANTS = [
  {
    id: 'M1', file: 'content.js', row: ROW_IDS.runner,
    label: 'قلب `acc` في mapFullToCut (مُفسَد الطبقة المعلَن في خطة 0.2.9 §١٠)',
    from: '      acc += Math.min(t, b) - a;',
    to: '      acc -= Math.min(t, b) - a;',
  },
  {
    id: 'M2', file: 'content.js', row: ROW_IDS.runner,
    label: 'إزاحة isGap نصف ثانية (آخر 0.5s من كل فجوة تُحسب محفوظة)',
    from: '      if (t >= a && t < b) return false;',
    to: '      if (t >= a - 0.5 && t < b) return false;',
  },
  {
    id: 'M3', file: 'background.js', row: ROW_IDS.clip,
    label: 'رفع بوّابة القيمتين: كل وضع يعبر إلى التطبيق (وضع مُفسَد يُمرَّر)',
    from: "    if (msg.mode === 'song' || msg.mode === 'clip') link.mode = msg.mode;",
    to: '    if (msg.mode) link.mode = msg.mode;',
  },
  {
    id: 'M4', file: 'popup.js', row: ROW_IDS.popup,
    label: 'تثبيت الاتجاه LTR (‏RTL لم يُعد مشتقّاً من اللغة)',
    from: "let RTL = LANG === 'ar';",
    to: 'let RTL = false;',
  },
  {
    id: 'M5', file: 'content.js', row: ROW_IDS.runner,
    label: 'pageVideo تسقط إلى المحدِّد العام (الفيديو المُضلِّل يكشفها) — ثقب و-١ نفسه',
    from: "return document.querySelector('#movie_player video') || document.querySelector('video');",
    to: "return document.querySelector('video');",
  },
  {
    id: 'M6', file: 'popup.js', row: ROW_IDS.popup,
    label: 'وضع song لا يُختار أبداً (‏chooseMode يسقط إلى clip) — ثقب و-٣/أ',
    from: "  mode = next === 'song' ? 'song' : 'clip';",
    to: "  mode = next === 'song' ? 'clip' : 'clip';",
  },
  {
    id: 'M7', file: 'popup.js', row: ROW_IDS.popup,
    label: 'زرّ song بلا مستمع نقر (‏addEventListener محذوف) — ثقب و-٣/ب',
    from: "el.modeSong.addEventListener('click', () => chooseMode('song'));\n",
    to: '',
  },
  {
    id: 'M8', file: 'popup.js', row: ROW_IDS.popup,
    label: 'كل نقرة تمرّر song (‏chooseMode ثابت على song) — ثقب و-٣/ج',
    from: "  mode = next === 'song' ? 'song' : 'clip';",
    to: "  mode = 'song';",
  },
  {
    id: 'M11', file: 'background.js', row: ROW_IDS.clip,
    label: 'بوابة البناء الواحد منزوعة (‏menusBuilding) ⇒ نداءان متقاربان ينشئان عشرة بمعرّفات مكرّرة — عطل المالك',
    from: '  if (menusBuilding) return;   //',
    to: '  if (false) return;   //',
  },
  {
    id: 'M9', kind: 'bridge', row: ROW_IDS.clip,
    label: 'خريطة clip تُمرَّر إلى kept_ranges (عقد الجسر: kept_ranges ≠ 0) — مُفسَد الصفّ ٨.٣',
    forge: (lines) => ({ ...lines, clip: 'M6B-GUARD claim=contract result=PASS page_kept_ranges=4 kept_ranges=9' }),
  },
  {
    id: 'M10', kind: 'bridge', row: ROW_IDS.clip,
    label: 'حقل mode لا يميّز المسارين (‏mode_song=clip) — مُفسَد الصفّ ٨.٣',
    forge: (lines) => ({
      ...lines,
      wire: 'M6B-SPY claim=b2 result=PASS mode_song="clip" mode_clip="clip" clip_kept_eq_page_kept=true song_page_kept_empty=true',
    }),
  },
];

const CONTROLS = [
  {
    id: 'C1', file: 'content.js',
    label: 'تعليق يذكر page_kept — يجب ألّا يُغيّر شيئاً (القياس يقرأ الكود الحيّ لا التعليق)',
    from: '  function mapFullToCut(t, kept) {',
    to: '  // ملاحظة: page_kept غير مستعمل هنا بعد (تعليق لا كود)\n  function mapFullToCut(t, kept) {',
  },
  {
    id: 'C2', file: 'content.js',
    label: 'إعادة تنسيق مسافات مشروعة داخل الدالّة النقية — يجب ألّا تُسقط شيئاً',
    from: '      acc += Math.min(t, b) - a;',
    to: '      acc  +=  Math.min(t, b) - a;',
  },
  {
    id: 'C3', file: 'popup.js',
    label: 'قيمة إنجليزية مُبدَّلة في جدول الترجمة (والصفحة تقرأ منه) — يجب ألّا تُسقط',
    from: "'footer.install': 'Install guide ⚙'",
    to: "'footer.install': 'Setup guide ⚙'",
  },
  {
    id: 'C4', file: 'popup.html',
    label: 'ربط باقتباس مفرد (HTML صالح) — يجب أن يُرى في DOM فيبقى العدّ 23 (بعد زرّي اللغة؛ والعدّ النصّي القديم يقول 22)',
    from: 'data-i18n="header.sub"',
    to: "data-i18n='header.sub'",
    expect: (res) => {
      const w = res.rows.find((r) => r.id === ROW_IDS.popup).reward;
      return w.i18nBoundNodes === 23 && w.i18nBoundNodesNaiveRegex === 22;
    },
    expectLabel: 'DOM=23 · العدّ النصّي=22',
  },
];

function applyEdit(files, file, from, to) {
  const text = files[file];
  if (text === undefined) throw new Error(`الملف ${file} ليس ضمن المقيس`);
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`النمط يطابق ${n} مرة في ${file} (المطلوب مرة واحدة): ${JSON.stringify(from).slice(0, 90)}`);
  const out = text.replace(from, to);
  if (out === text) throw new Error(`الاستبدال لم يغيّر ${file}`);
  return out;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** يُنشئ نسخة مؤقّتة من الإضافة (تحت مجلد العمل)، ويطبّق التعديل عليها إن وُجد.
 *  وتُنسخ معها **مصادر عقد الجسر الثلاثة** وبصمتها، فالقياس على النسخة يمرّ
 *  بمسار العقد نفسه بلا cargo: يُكتب قياس العقد المخزون ببصمة المصادر المطابقة.
 *  ومُفسَد `kind: 'bridge'` يستبدل **سطور العقد المقروءة** (‏`forge`) فيسقط الصفّ
 *  إن كانت قوانينه حيّة — وهو ما يُقاس بلا لمس الرست ولا إعادة بنائه. */
function copyToTemp(workDir, slug, src, edit, bridgeLines) {
  const root = path.join(workDir, slug);
  fs.mkdirSync(path.join(root, 'browser-extension'), { recursive: true });
  const files = { ...src.files };
  if (edit && edit.file) files[edit.file] = applyEdit(files, edit.file, edit.from, edit.to);
  for (const [f, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'browser-extension', f), text);
  }
  const rust = rustKey(src.root);
  if (rust) {
    for (const rel of RUST_SOURCES) {
      const dst = path.join(root, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(src.root, rel), dst);
    }
    if (bridgeLines) {
      const lines = edit && edit.forge ? edit.forge(bridgeLines) : bridgeLines;
      const cache = path.join(root, RUST_CACHE);
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, `${JSON.stringify({ rust_sha256: rust.key, lines, at: 'selfcheck' }, null, 2)}\n`);
    }
  }
  return root;
}

async function runRowsQuiet(root, opts, ctx) {
  const src = loadSources(root);
  return runRows(src, { ...opts, __cdp: ctx.cdp, __pageUrl: ctx.pageUrl, __browserVersion: ctx.browserVersion, quiet: true });
}

/** كل فحص ساقط **فعلاً** — بلا استثناء صفّ: الفشل المتوقَّع (`page_kept` غائب) لا
 *  يدخل `failures` أصلاً (انظر `makeReporter.expect`)، فلا يُستثنى صفٌّ كامل. */
const realFailures = (res) => res.rows.flatMap((row) => row.failures.map((f) => `${row.id}: ${f}`));

/* ── الفحص الذاتي: المُفسَدات تُسقط، والضوابط تمرّ، والشجرة الحقيقية لا تُلمس ── */

async function selfCheck(src, opts, ctx) {
  const { workDir, shippedHashes } = ctx;
  let caught = 0, holes = 0, passed = 0, badPass = 0, skipped = 0;
  const problems = [];

  log('═══ فحص ذاتي: المُفسَدات (على نسخ مؤقّتة — الشجرة الحقيقية لا تُلمس) ═══');
  log(`مجلد العمل: ${workDir}`);
  log('  المولِّد: كل مُفسَد استبدال نصّي حرفيّ واحد (قبل ⟶ بعد) في نسخة من الملف.');
  log('');

  const pristineRoot = copyToTemp(workDir, 'pristine', src, null, ctx.bridgeLines);
  const pristine = await runRowsQuiet(pristineRoot, opts, ctx);
  const pristineFails = realFailures(pristine);
  if (pristineFails.length === 0) {
    passed++;
    log(`  ✅ ضابط: النسخة السليمة (مصنوعة) تمرّ بلا فشل (${pristine.rows.length} صفوف · ${pristine.rows.reduce((n, r) => n + r.count(), 0)} فحصاً)`);
  } else {
    badPass++; problems.push(`ضابط الصفر سقط: ${pristineFails.join(' | ')}`);
    log(`  ❌ ضابط الصفر سقط: ${pristineFails[0]}`);
  }

  for (const m of MUTANTS) {
    let res = null;
    if (m.kind === 'bridge' && !ctx.bridgeLines) {
      skipped++;
      problems.push(`${m.id} لم يُطبَّق: عقد الجسر غير مقيس على هذا الجذر`);
      log(`  ⚠ ${m.id} لم يُطبَّق — عقد الجسر غير مقيس على هذا الجذر (‏--rust=skip؟)`);
      continue;
    }
    try {
      const root = copyToTemp(workDir, `mut-${m.id}`, src, m, ctx.bridgeLines);
      res = await runRowsQuiet(root, opts, ctx);
    } catch (e) { skipped++; problems.push(`${m.id} لم يُطبَّق: ${e.message}`); log(`  ⚠ ${m.id} لم يُطبَّق — ${e.message}`); continue; }
    const fails = realFailures(res);
    if (fails.length > 0) {
      caught++;
      log(`  ✅ سقط  ${m.id} — ${m.label}`);
      if (m.kind === 'bridge') {
        const forged = m.forge(ctx.bridgeLines);
        const changed = Object.keys(forged).filter((k) => forged[k] !== ctx.bridgeLines[k]);
        for (const k of changed) log(`       سطر ${k} في نسخة العقد:  ${JSON.stringify(forged[k])}`);
      } else {
        log(`       ${m.file}:  ${JSON.stringify(m.from)}`);
        log(`                 ⟶ ${JSON.stringify(m.to)}`);
      }
      log(`       ↳ ${fails[0].replace(/\s+/g, ' ').slice(0, 150)}`);
      log(`       ↳ مجموع الساقط: ${fails.length}`);
    } else {
      holes++;
      problems.push(`${m.id} مرّ من القياس (ثقب): ${m.label}`);
      log(`  ❌ مرّ   ${m.id} — ${m.label} | ثقب`);
    }
  }

  log('');
  log('  ── الضوابط: تعديل مشروع يجب ألّا يُسقط شيئاً ──');
  for (const c of CONTROLS) {
    let res = null;
    try {
      const root = copyToTemp(workDir, `ctl-${c.id}`, src, c, ctx.bridgeLines);
      res = await runRowsQuiet(root, opts, ctx);
    } catch (e) { skipped++; problems.push(`${c.id} لم يُطبَّق: ${e.message}`); log(`  ⚠ ${c.id} لم يُطبَّق — ${e.message}`); continue; }
    const fails = realFailures(res);
    // ضابط بقيمة متوقَّعة: لا يكفي ألّا يسقط — بل يُقاس **الرقم** الذي يجعل
    // القياس صحيحاً (وإلا مرّ ضابط «لم ينظر» كما مرّت الثقوب).
    let expectOk = true;
    if (typeof c.expect === 'function') {
      try { expectOk = c.expect(res) === true; } catch { expectOk = false; }
    }
    if (fails.length === 0 && expectOk) { passed++; log(`  ✅ مرّ   ${c.id} — ${c.label}${c.expectLabel ? ` [${c.expectLabel}]` : ''}`); }
    else if (fails.length > 0) { badPass++; problems.push(`${c.id} اصطياد كاذب: ${fails.join(' | ')}`); log(`  ❌ سقط   ${c.id} — ${c.label} | ${fails[0].slice(0, 120)}`); }
    else { badPass++; problems.push(`${c.id} لم يحقّق قيمته المتوقَّعة (${c.expectLabel || 'expect'})`); log(`  ❌ قيمة  ${c.id} — ${c.label} | القيمة المتوقَّعة لم تتحقّق`); }
  }

  // الشجرة الحقيقية: بصمات الملفات المشحونة قبل الفحص وبعده.
  const after = Object.fromEntries(NEEDED.map((f) => [f, sha256(fs.readFileSync(path.join(src.ext, f), 'utf8'))]));
  const drifted = Object.keys(shippedHashes).filter((f) => shippedHashes[f] !== after[f]);
  log('');
  if (drifted.length === 0) {
    log(`  ✅ الشجرة الحقيقية سليمة: بصمات ${NEEDED.length} ملفاً مشحوناً لم تتغيّر (${Object.values(shippedHashes).map((h) => h.slice(0, 8)).join(' · ')})`);
  } else {
    problems.push(`الشجرة الحقيقية تغيّرت: ${drifted.join(' · ')}`);
    log(`  ❌ الشجرة الحقيقية تغيّرت: ${drifted.join(' · ')}`);
  }

  log('');
  log('═══ الأحكام ═══');
  log(`  المُفسَدات: أسقط ${caught} من ${MUTANTS.length} · الضوابط: مرّ ${passed} · ثقوب ${holes} · اصطياد كاذب ${badPass} · لم يُطبَّق ${skipped}`);
  for (const p of problems) process.stderr.write(`✗ ${p}\n`);
  let code = 0;
  if (problems.length) code = 1;
  if (skipped) code = 2;
  if (caught !== MUTANTS.length) { process.stderr.write(`✗ ${MUTANTS.length - caught} مُفسَداً لم يُسقط القياس — قياس ناقص\n`); code = 1; }
  return code;
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE); return 2; }

  let src;
  try { src = loadSources(opts.root); }
  catch (e) {
    if (e instanceof ZeroInput) { process.stderr.write(`✗ ${e.message}\n`); return 2; }
    throw e;
  }

  const shippedHashes = Object.fromEntries(Object.entries(src.files).map(([f, t]) => [f, sha256(t)]));

  // متصفّح؟ (مسار CDP القائم). **والافتراضيّ صارم**: غياب المتصفّح فشل صريح لا
  // نجاح مع تحذير (قرار المشرف — كان يُسقط إلى jsdom فيُوسَم الصفّ ✅ وهو لم يُقَس
  // في متصفّح). و`--engine=jsdom` بديل **يطلبه المستعمل صراحةً** ويُسمّى في الأثر.
  const exe = opts.engine === 'cdp' ? findBrowser() : null;
  if (opts.engine === 'cdp' && !exe) {
    process.stderr.write(
      '✗ لا متصفّح Chromium: قياس مشغّل يوتيوب عبر CDP شرطٌ (لا سقوط صامت إلى jsdom).\n' +
      '   ثبّت Chrome/Edge أو اضبط HARAMLITE_BROWSER، أو اطلب البديل صراحةً: --engine=jsdom\n',
    );
    return 1;
  }

  let browser = null;
  let cdp = null;
  let page = null;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-browser-rows-'));
  const exitHook = () => { if (browser) browser.cleanupSync(); };
  process.once('exit', exitHook);

  let code = 0;
  try {
    let pageUrl = null;
    let browserVersion = null;
    if (exe) {
      browser = await launchBrowser(exe);
      browserVersion = browser.version.Browser || 'chromium';
      cdp = await Cdp.connect(browser.version.webSocketDebuggerUrl);
      const simDir = path.join(workDir, 'sim');
      fs.mkdirSync(simDir, { recursive: true });
      fs.writeFileSync(path.join(simDir, 'index.html'), SIM_PAGE);
      page = await startStaticServer(simDir);
      pageUrl = `${page.origin}/index.html`;
      log(`المتصفّح: ${exe} — ${browserVersion} · الصفحة المُحاكاة: ${pageUrl}`);
    }

    if (opts.selfCheck) {
      // قياس العقد **مرّة** على الجذر الحقيقي، ثم تُبنى النسخ المؤقّتة على سطوره
      // (فتُقاس قوانين العقد ومُفسَداته بلا cargo في كل نسخة).
      const bridge = bridgeContract(src.root, opts);
      if (!bridge.lines) {
        process.stderr.write(`⚠ عقد الجسر غير مقيس على هذا الجذر (${bridge.state}: ${bridge.why}) — مُفسَدا العقد M9/M10 لن يُطبَّقا\n`);
      }
      code = await selfCheck(src, opts, { cdp, pageUrl, browserVersion, workDir, shippedHashes, bridgeLines: bridge.lines || null });
    } else {
      const res = await runRows(src, { ...opts, __cdp: cdp, __pageUrl: pageUrl, __browserVersion: browserVersion });
      if (opts.json) {
        log(JSON.stringify({
          engine: res.engine,
          rows: res.rows.map((r) => ({ id: r.id, engine: r.engine, reward: r.reward, checks: r.count(), failures: r.failures })),
        }, null, 2));
      } else {
        printReport(res, opts);
      }
      const hard = res.rows.reduce((n, r) => n + r.failures.length, 0);
      const clipUnmeasured = res.rows.some((r) => r.clipUnmeasured);
      if (hard > 0) {
        process.stderr.write(`\n✗ صفوف المتصفّح: ${hard} فحصاً ساقطاً\n`);
        for (const row of res.rows) for (const f of row.failures) process.stderr.write(`   - ${row.id}: ${f}\n`);
        code = 1;
      } else if (opts.requireClip && clipUnmeasured) {
        process.stderr.write('✗ --require-clip: عقد clip غير مقيس (‏--rust=skip أو مصادر غائبة؟)\n');
        code = 1;
      } else if (!opts.json) {
        log('');
        log(clipUnmeasured
          ? '⚠ المقيس مرّ، وصفّ فرق song/clip **غير مقيَّم**: عقد الجسر لم يُشغَّل — شغّله بلا --rust=skip (أو --require-clip ليصير فشلاً).'
          : '✓ كل صفوف المتصفّح مرّت.');
      }
      if (!opts.noOut) {
        const written = writeRowArtifacts(res, opts);
        const lines = written.map((w) => `أثر الصفّ: ${w.file} — انسخ في خانة المصفوفة: مكافأة:${w.token}`);
        if (!opts.json) for (const l of lines) log(l);
        else process.stderr.write(`${lines.join('\n')}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`✗ خطأ غير متوقَّع: ${(e && e.stack) || e}\n`);
    code = 2;
  } finally {
    if (cdp) cdp.close();
    if (page) page.server.close();
    if (browser) {
      const rep = await browser.cleanup();
      if (rep.leaked) process.stderr.write(`⚠ تنظيف المتصفّح: تسريب — الملف الشخصي ${rep.profile} أو منفذ حيّ\n`);
    }
    if (!opts.keep) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    else log(`مجلد العمل مُبقى: ${workDir}`);
  }
  return code;
}

main().then((c) => { process.exitCode = c; }).catch((e) => {
  process.stderr.write(`✗ خطأ غير متوقّع: ${(e && e.stack) || e}\n`);
  process.exitCode = 2;
});
