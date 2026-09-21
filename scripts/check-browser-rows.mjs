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
 *      وعدد الحقول/الأزرار المقيسة من المستند نفسه (لا من عدّ نصّي في الملف).
 *   ② `browser.youtube` — مشغّل يوتيوب: **صفحة مُحاكاة** تُصنع هنا وتُقدَّم على
 *      خادم محلّي، وتُفتح عبر **مسار CDP القائم** (‏`scripts/check-layout.cjs`
 *      نفسه: `--headless=new` + `DevToolsActivePort` + WebSocket)، وتُحقن فيها
 *      **الدوال النقية المستخرجة من `content.js` المشحون** نصّاً (‏`mapFullToCut`
 *      · `isGap` · `skipVideoGaps` · `nextGapStart` · `gapStats` ·
 *      `keptStretchAround`) مع `pageVideo` نفسه (فيُقاس أن محدِّد المشغّل يجد
 *      فيديو الصفحة المُحاكاة لا فيديو مُضلِّل موضوع خارجها). ثم يُمشى الخط
 *      الزمني كما يمشيه المشغّل: قفزة عند كل فجوة، والموضع يُعاد إرساؤه بالخريطة.
 *      **ولا وسائط تُحمَّل ولا تُشغَّل** (‏`<video>` بلا `src`).
 *   ③ `browser.song-clip` — فرق song/clip: على مستوى **العقد/الخريطة**. اليوم
 *      المقيس: حقل `mode` (قيمتان مقبولتان حصراً، وما سواهما لا يعبر — يُقاس
 *      بتشغيل `background.js` المشحون فعلاً في jsdom مع واجهة مصنوعة) وعدد
 *      المواضع التي تُعرِّف خريطة الصفحة في `content.js` (‏`LAST.kept`).
 *      و**حقل `page_kept` غير موجود بعد على هذا الفرع** ⇒ الصفّ يقول
 *      «**غائب — غير مقيَّم**» ولا يقول ✅، ويُكمل القياس على الحقلين متى وُجدا
 *      (‏`--require-clip` يجعل الغياب فشلاً صريحاً بعد دمج بند clip).
 *
 * **حدّ مُعلَن يجب أن يُحترم**: كروم ١٥٣ **لا يحترم `--load-extension`** ⇒
 * **تحميل الإضافة في متصفّح حقيقي غير مقيس هنا**، ولا يُدّعى. المقيس إمّا
 * **حقن عبر CDP** في صفحة مُحاكاة (المشغّل) أو **jsdom** (المنبثقة والعقد).
 * ولا يُشغَّل صوت ولا فيديو حقيقي في أيٍّ من الصفّين.
 *
 * الاستعمال:
 *   node scripts/check-browser-rows.mjs                    # الصفوف الثلاثة
 *   node scripts/check-browser-rows.mjs --engine=jsdom      # بلا متصفّح (بديل معلَن)
 *   node scripts/check-browser-rows.mjs --require-browser   # لا بديل: غياب المتصفّح فشل
 *   node scripts/check-browser-rows.mjs --require-clip      # غياب page_kept فشل
 *   node scripts/check-browser-rows.mjs --self-check        # المُفسَدات + الضوابط
 *   node scripts/check-browser-rows.mjs --json --out=qa/eval/out/browser-rows.json
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
  --require-browser   غياب المتصفّح فشل صريح (لا بديل jsdom)
  --require-clip      غياب الحقل page_kept فشل صريح (بعد دمج بند clip)
  --self-check        يشغّل المُفسَدات والضوابط على **نسخ مؤقّتة** ويسقط عليها
  --json              مخرَج آلة
  --out=<path>        يكتب أثراً JSON (بلا كتابة إن لم يُمرَّر)
  --keep              يُبقي مجلد العمل المؤقّت للتفتيش
  --quiet             لا يطبع تفاصيل الفحوص الساقطة
`;

function parseArgs(argv) {
  const o = {
    root: REPO, engine: 'cdp', json: false, quiet: false, selfCheck: false,
    requireBrowser: false, requireClip: false, keep: false, out: null, help: false,
  };
  // الصيغتان مقبولتان: `--root=<dir>` و`--root <dir>` — بوّابة الحرّاس تُمرّر
  // المسار **منفصلاً** (`['--root', dir]`) كما في كل حرّاس هذا المستودع، ومُقيِّم
  // لا يقبل إلا صيغةً واحدة يفشل بـ2 على بيئة سليمة (قِيس فعلاً في أول ربط).
  const VALUE_FLAGS = new Set(['--root', '--engine', '--out']);
  for (let i = 0; i < argv.length; i++) {
    let raw = argv[i];
    if (VALUE_FLAGS.has(raw)) {
      if (argv[i + 1] === undefined) { process.stderr.write(`وسيط بلا قيمة: ${raw}\n`); o.help = true; continue; }
      raw = `${raw}=${argv[++i]}`;
    }
    if (raw === '--json') o.json = true;
    else if (raw === '--quiet') o.quiet = true;
    else if (raw === '--self-check') o.selfCheck = true;
    else if (raw === '--require-browser') o.requireBrowser = true;
    else if (raw === '--require-clip') o.requireClip = true;
    else if (raw === '--keep') o.keep = true;
    else if (raw === '--help' || raw === '-h') o.help = true;
    else if (raw.startsWith('--root=')) o.root = path.resolve(raw.slice(7));
    else if (raw.startsWith('--engine=')) o.engine = raw.slice(9);
    else if (raw.startsWith('--out=')) o.out = path.resolve(raw.slice(6));
    else { process.stderr.write(`وسيط غير معروف: ${raw}\n`); o.help = true; }
  }
  if (!['cdp', 'jsdom'].includes(o.engine)) {
    process.stderr.write(`--engine يقبل cdp|jsdom، وورد «${o.engine}»\n`);
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
 *  والفجوات 0.5 · 2 · 3 · 8 · 9 ⇒ خمس فجوات، ومجموعها 22.5 = 80 − 57.5 ✓ */
export const RUNNER_EXPECTED = { gaps: 5, keptSum: 57.5, gapSeconds: 22.5, jumps: 5 };

/** أوراكل مستقلّ (تنفيذ ثانٍ في المُقيِّم لا في الصفحة) — يُقابَل بالمقيس فيُكشف
 *  أي انزياح في التوقّعات المكتوبة بيدي. */
function oracleOf(kept) {
  let keptSum = 0, gaps = 0, prevEnd = 0;
  for (const pair of kept) {
    const a = Number(pair[0]); const b = Number(pair[1]);
    if (!(b > a)) continue;
    keptSum += b - a;
    if (a > prevEnd) gaps++;
    prevEnd = b;
  }
  return { keptSum, gaps };
}

const SIM_PAGE = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><title>HaramLite — صفحة يوتيوب مُحاكاة</title></head>
<body>
  <div id="movie_player">
    <video id="hl-sim-video" width="640" height="360" muted playsinline></video>
  </div>
  <!-- فيديو مُضلِّل **خارج** المشغّل: يكشف مُحدِّداً يسقط إلى document.querySelector('video') -->
  <video id="hl-decoy-video" width="160" height="90" muted></video>
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

  // ④ المشية: قفزة عند كل فجوة، والموضع يُعاد إرساؤه بـmapFullToCut (كما في gapTick/reanchorAudio)
  let t = 0, jumps = 0, stalled = false, monotone = true, steps = 0;
  const landings = [], audioAfterJump = [], landingsInKept = [];
  let prev = P.mapFullToCut(0, kept);
  let guard = 0;
  while (t < duration && guard++ < 2000000) {
    if (P.isGap(t, kept)) {
      const land = P.skipVideoGaps(t, kept);
      if (!(land > t)) { stalled = true; break; }
      jumps++;
      landings.push(+Number(land).toFixed(6));
      landingsInKept.push(!P.isGap(land, kept));
      audioAfterJump.push(+Number(P.mapFullToCut(land, kept)).toFixed(6));
      t = +Number(land).toFixed(9);
      prev = P.mapFullToCut(t, kept);
      continue;
    }
    const a = P.mapFullToCut(t, kept);
    if (a < prev - 1e-9) monotone = false;
    prev = a;
    steps++;
    t = +(t + step).toFixed(9);
  }

  const playerVideo = document.querySelector('#movie_player video');
  return {
    pickedVideo: picked
      ? { id: picked.id || null, tag: picked.tagName, inPlayer: !!(picked.closest && picked.closest('#movie_player')) }
      : null,
    videoCount: document.querySelectorAll('video').length,
    playerVideoId: playerVideo ? (playerVideo.id || null) : null,
    gaps: st.gaps,
    keptSum: +Number(st.keptSum).toFixed(6),
    hist: st.hist,
    gapSecondsScanned: +(gapSamples * scanStep).toFixed(6),
    scanSamples: Math.round(duration / scanStep),
    jumps, stalled, monotone, steps,
    landings, audioAfterJump, landingsInKept,
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

function renderPopup(src, languages) {
  const dom = new JSDOM(src.popupHtml, { url: 'https://haramlite.test/popup.html', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(w.navigator, 'language', { value: languages[0] || 'en', configurable: true });
  w.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: src.manifest.version }),
      sendMessage: (msg, cb) => { if (cb) setTimeout(() => cb({ ok: true, resp: { state: {} } }), 0); },
    },
    tabs: {
      query: (_q, cb) => cb([{ id: 1, url: 'https://www.youtube.com/watch?v=abc', title: 'Example video' }]),
      sendMessage: (_id, _m, cb) => cb({ ok: true }),
    },
  };
  w.eval(src.popupJs);
  return w;
}

function measurePopup(src, r) {
  const I18N = popupTable(src.popupJs);
  const ar = renderPopup(src, ['ar-SA', 'en-US']);
  const en = renderPopup(src, ['en-US', 'ar']);

  const bound = [...src.popupHtml.matchAll(/\bdata-i18n="([^"]*)"/g)].map((m) => m[1]);
  const nCtl = ar.document.querySelectorAll('button, input, select, textarea, [role="button"]').length;
  const nBtn = ar.document.querySelectorAll('button').length;
  const nRole = ar.document.querySelectorAll('[role="button"]').length;
  const reward = {
    fields: nCtl, buttons: nBtn, roleButtons: nRole,
    i18nBoundNodes: bound.length,
    dirAr: ar.document.documentElement.dir, langAr: ar.document.documentElement.lang,
    dirEn: en.document.documentElement.dir, langEn: en.document.documentElement.lang,
    modeItems: ar.document.querySelectorAll('#card-modes [role="button"]').length,
  };

  r.ok('المنبثقة تُحمَّل وتُصيَّر، ولها حقول مقيسة في DOM حقيقي', nCtl > 0, `الحقول المقيسة=${nCtl}`);
  r.ok('العربية ⇒ direction=rtl و lang=ar', reward.dirAr === 'rtl' && reward.langAr === 'ar', `${reward.dirAr}/${reward.langAr}`);
  r.ok('الإنجليزية ⇒ direction=ltr و lang=en', reward.dirEn === 'ltr' && reward.langEn === 'en', `${reward.dirEn}/${reward.langEn}`);
  r.ok('الاتجاه مشتقّ من اللغة (المستندان مختلفان)', reward.dirAr !== reward.dirEn);
  r.ok('الحقول المقيسة = أزرار + عناصر بدور زر (لا نوع آخر غير محسوب)',
    nCtl === nBtn + nRole, `${nCtl} ≠ ${nBtn}+${nRole}`);
  r.ok('بطاقة الوضع تحمل عنصرين اثنين بدور زر (song/clip)', reward.modeItems === 2, `وُجد ${reward.modeItems}`);

  const wrongAr = bound.filter((k) => {
    const n = ar.document.querySelector(`[data-i18n="${k}"]`);
    return !n || n.textContent !== I18N.ar[k];
  });
  const wrongEn = bound.filter((k) => {
    const n = en.document.querySelector(`[data-i18n="${k}"]`);
    return !n || n.textContent !== I18N.en[k];
  });
  r.ok(`كل نصّ مربوط يعرض قيمته العربية (${bound.length} موضعاً)`, wrongAr.length === 0, `مخالف: ${wrongAr.join(' · ')}`);
  r.ok(`كل نصّ مربوط يعرض قيمته الإنجليزية (${bound.length} موضعاً)`, wrongEn.length === 0, `مخالف: ${wrongEn.join(' · ')}`);

  const undef = [];
  for (const w of [ar, en]) {
    for (const n of w.document.querySelectorAll('[data-i18n]')) if (/undefined/.test(n.textContent)) undef.push(n.getAttribute('data-i18n'));
  }
  r.ok('لا عنصر مربوط يعرض `undefined` (مفتاح مفقود من الجدول)', undef.length === 0, undef.join(' · '));

  const arChars = [...en.document.body.textContent].filter((c) => /[\u0600-\u06FF]/.test(c)).length;
  r.ok('المستند الإنجليزي المعروض بصفر محرف عربي', arChars === 0, `وُجد ${arChars}`);

  const clip = ar.document.querySelector('#mode-clip');
  const song = ar.document.querySelector('#mode-song');
  r.ok('الوضع الافتراضي المعروض = clip (‏aria-pressed)',
    !!clip && !!song && clip.getAttribute('aria-pressed') === 'true' && song.getAttribute('aria-pressed') === 'false',
    `clip=${clip && clip.getAttribute('aria-pressed')} song=${song && song.getAttribute('aria-pressed')}`);
  const vt = ar.document.querySelector('.version-tag');
  r.ok(`وسم الإصدار في الصفحة = إصدار المانيفست (${src.manifest.version})`,
    !!vt && vt.textContent === `v${src.manifest.version}`, `وُجد ${JSON.stringify(vt && vt.textContent)}`);

  ar.close(); en.close();
  return reward;
}

/* ── الصفّ ②: مشغّل يوتيوب ────────────────────────────────────────────── */

function measureRunner(src, r, probeResult, engineNote) {
  const F = RUNNER_FIXTURE;
  const E = RUNNER_EXPECTED;
  const oracle = oracleOf(F.kept);
  const reward = { engine: engineNote, ...probeResult };

  r.ok('أوراكل المُقيِّم المستقلّ يوافق الأرقام المكتوبة بيد (‏gaps · keptSum)',
    oracle.gaps === E.gaps && Math.abs(oracle.keptSum - E.keptSum) < 1e-9,
    `oracle=${JSON.stringify(oracle)} مقابل ${JSON.stringify({ gaps: E.gaps, keptSum: E.keptSum })}`);
  if (!probeResult || probeResult.error) {
    r.ok('المُسبار أعاد قياساً (لا خطأ)', false, probeResult ? probeResult.error : 'بلا نتيجة');
    return reward;
  }

  r.ok('مُحدِّد المشغّل `pageVideo()` يجد فيديو المشغّل في الصفحة المُحاكاة (لا الفيديو المُضلِّل خارجها)',
    !!probeResult.pickedVideo && probeResult.pickedVideo.id === 'hl-sim-video' && probeResult.pickedVideo.inPlayer === true,
    `وُجد ${JSON.stringify(probeResult.pickedVideo)} · عدد الفيديوهات=${probeResult.videoCount}`);
  r.ok('والصفحة المُحاكاة فيها فعلاً أكثر من فيديو (فالسقوط إلى `video` العام كان سيُخطئ)',
    probeResult.videoCount === 2, `عدد الفيديوهات=${probeResult.videoCount}`);

  r.ok(`عدد الفجوات التي حسبها المشغّل = ${E.gaps}`, probeResult.gaps === E.gaps, `وُجد ${probeResult.gaps}`);
  r.ok(`مجموع ما حُفظ keptSum = ${E.keptSum}`,
    Math.abs(probeResult.keptSum - E.keptSum) < 1e-9, `وُجد ${probeResult.keptSum}`);

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
  r.ok('مدرّج الفجوات hist = [1,0,2,0,2] (من gapStats المشحون)',
    JSON.stringify(probeResult.hist) === JSON.stringify([1, 0, 2, 0, 2]), JSON.stringify(probeResult.hist));

  return reward;
}

/* ── الصفّ ③: فرق song/clip ───────────────────────────────────────────── */

function renderBackground(src, languages) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://haramlite.test/sw.html', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(w.navigator, 'language', { value: languages[0] || 'en', configurable: true });
  const sent = [];
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
      onInstalled: { addListener() { /* ignore */ } },
      connectNative: () => port,
      onMessage: { addListener(fn) { onMessage = fn; } },
    },
    contextMenus: { removeAll(cb) { if (cb) cb(); }, create() {}, onClicked: { addListener() {} } },
  };
  w.eval(src.backgroundJs);
  return { w, sent, onMessage: () => onMessage };
}

const MODE_REQUESTS = [
  { label: 'clip', msg: { type: 'send', url: 'https://youtu.be/1', mode: 'clip' }, want: 'clip' },
  { label: 'song', msg: { type: 'send', url: 'https://youtu.be/2', mode: 'song' }, want: 'song' },
  { label: 'garbage', msg: { type: 'send', url: 'https://youtu.be/3', mode: 'nonsense' }, want: null },
  { label: 'absent', msg: { type: 'send', url: 'https://youtu.be/4' }, want: null },
];

const ROW_IDS = { popup: 'browser.popup', runner: 'browser.youtube', clip: 'browser.song-clip' };

async function measureSongClip(src, r) {
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

  // حقل `page_kept`: يُقاس على **الكود الحيّ** (التعليقات مُجرَّدة) في كل ملفات الإضافة.
  const pageKeptHits = [];
  for (const [f, text] of Object.entries(src.files)) {
    const n = (stripComments(text).match(/page_kept/g) || []).length;
    if (n) pageKeptHits.push(`${f}×${n}`);
  }
  const pageKeptPresent = pageKeptHits.length > 0;

  // مصدر خريطة الصفحة في content.js: تعريف واحد، ومن `LAST.kept` لا من خريطة أخرى.
  const live = stripComments(src.contentJs);
  const keptBindings = (live.match(/(?:const|let|var)\s+kept\b/g) || []).length;
  const keptFromLast = live.includes('const kept = LAST.kept;');

  const withMode = forward.filter((f) => f.mode !== null);
  const reward = {
    modeValues: 2,
    forwardedWithMode: withMode.length,
    modesSeen: withMode.map((f) => f.mode).sort().join(','),
    forwardedWithoutMode: forward.filter((f) => f.mode === null).length,
    pageKept: pageKeptPresent ? `موجود (${pageKeptHits.join(' · ')})` : 'غائب',
    keptBindings,
    keptFromLast,
  };

  r.ok(`حقل \`mode\` يُقاس بتشغيل background.js المشحون (${MODE_REQUESTS.length} طلباً دُفع فعلاً)`,
    forward.length === MODE_REQUESTS.length && forward.every((f) => f.forwardedCount === 1 && f.type === 'link'),
    JSON.stringify(forward));
  r.ok('القيمتان المقبولتان حصراً تعبران: clip و song',
    withMode.length === 2 && withMode.map((f) => f.mode).sort().join(',') === 'clip,song',
    `عبر: ${JSON.stringify(withMode.map((f) => f.mode))}`);
  r.ok('وما سواهما لا يعبر: وضع مُفسَد ووضع غائب ⇒ بلا حقل mode (فالتطبيق يحتفظ بإعداده)',
    forward.filter((f) => f.mode === null).length === 2,
    JSON.stringify(forward.map((f) => `${f.label}:${f.mode}`)));
  r.ok('خريطة الصفحة في content.js تُعرَّف مرة واحدة ومن `LAST.kept` (لا خريطة ثانية)',
    keptBindings === 1 && keptFromLast, `تعريفات=${keptBindings} · من LAST=${keptFromLast}`);

  if (!pageKeptPresent) {
    r.expect('حقل `page_kept` موجود في الإضافة (شرط قياس فرق song/clip كاملاً)', false,
      'غائب عن هذا الفرع — القياس مؤجَّل إلى ما بعد دمج بند clip (‏--require-clip يجعله فشلاً)');
  } else {
    r.ok('حقل `page_kept` موجود — ويُقاس عليه عقد clip: خريطته لا تمرّ إلى kept_ranges',
      keptFromLast === false || keptBindings > 1,
      `page_kept=${pageKeptHits.join(' · ')} · تعريفات kept=${keptBindings} · من LAST=${keptFromLast}`);
  }
  return reward;
}

/* ── تشغيل الصفوف الثلاثة ─────────────────────────────────────────────── */

async function runRows(src, opts) {
  const rows = [];
  const engine = { requested: opts.engine, used: null, browser: null, note: null };

  // ① المنبثقة (jsdom: النصّ والاتجاه المعروضان)
  const r1 = makeReporter();
  let reward1;
  try { reward1 = measurePopup(src, r1); }
  catch (e) { r1.ok('قياس المنبثقة اكتمل', false, String(e && e.message)); reward1 = { error: String(e && e.message) }; }
  rows.push({ id: ROW_IDS.popup, title: 'المنبثقة (popup.html + popup.js)', engine: 'jsdom', reward: reward1, ...r1 });

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
  rows.push({ id: ROW_IDS.runner, title: 'مشغّل يوتيوب (صفحة مُحاكاة)', engine: engineNote, reward: reward2, ...r2 });

  // ③ فرق song/clip
  const r3 = makeReporter();
  let reward3;
  try { reward3 = await measureSongClip(src, r3); }
  catch (e) { r3.ok('قياس فرق song/clip اكتمل', false, String(e && e.message)); reward3 = { error: String(e && e.message) }; }
  const clipUnmeasured = r3.expected.length > 0;
  rows.push({
    id: ROW_IDS.clip, title: 'فرق song/clip (العقد/الخريطة)', engine: 'jsdom+مسح المصدر',
    reward: reward3, clipUnmeasured, ...r3,
  });

  return { rows, engine };
}

/* ── العرض ────────────────────────────────────────────────────────────── */

function fmtReward(row) {
  const w = row.reward || {};
  if (row.id === ROW_IDS.popup) {
    return `حقول=${w.fields} (أزرار=${w.buttons} · أدوار=${w.roleButtons}) · نصوص مربوطة=${w.i18nBoundNodes} · ar=${w.dirAr}/${w.langAr} · en=${w.dirEn}/${w.langEn}`;
  }
  if (row.id === ROW_IDS.runner) {
    return `فجوات=${w.gaps} · keptSum=${w.keptSum} · قفزات=${w.jumps} · ثواني الفجوات=${w.gapSecondsScanned} · موضع الصوت النهائي=${w.audioFinal} · محرّك=${w.engine}`;
  }
  return `أوضاع معبَّرة=${w.modesSeen} (${w.forwardedWithMode}/${w.forwardedWithMode + w.forwardedWithoutMode}) · حقل page_kept=${w.pageKept} · تعريفات kept=${w.keptBindings} · من LAST.kept=${w.keptFromLast}`;
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
    from: "const RTL = LANG === 'ar';",
    to: 'const RTL = false;',
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

/** يُنشئ نسخة مؤقّتة من الإضافة (تحت مجلد العمل)، ويطبّق التعديل عليها إن وُجد. */
function copyToTemp(workDir, slug, src, edit) {
  const root = path.join(workDir, slug);
  fs.mkdirSync(path.join(root, 'browser-extension'), { recursive: true });
  const files = { ...src.files };
  if (edit) files[edit.file] = applyEdit(files, edit.file, edit.from, edit.to);
  for (const [f, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'browser-extension', f), text);
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

  const pristineRoot = copyToTemp(workDir, 'pristine', src, null);
  const pristine = await runRowsQuiet(pristineRoot, opts, ctx);
  const pristineFails = realFailures(pristine);
  if (pristineFails.length === 0) {
    passed++;
    log(`  ✅ ضابط: النسخة السليمة (مصنوعة) تمرّ بلا فشل في الصفّين المقيسين (${pristine.rows.length} صفوف · ${pristine.rows.reduce((n, r) => n + r.count(), 0)} فحصاً)`);
  } else {
    badPass++; problems.push(`ضابط الصفر سقط: ${pristineFails.join(' | ')}`);
    log(`  ❌ ضابط الصفر سقط: ${pristineFails[0]}`);
  }

  for (const m of MUTANTS) {
    let res = null;
    try {
      const root = copyToTemp(workDir, `mut-${m.id}`, src, m);
      res = await runRowsQuiet(root, opts, ctx);
    } catch (e) { skipped++; problems.push(`${m.id} لم يُطبَّق: ${e.message}`); log(`  ⚠ ${m.id} لم يُطبَّق — ${e.message}`); continue; }
    const fails = realFailures(res);
    if (fails.length > 0) {
      caught++;
      log(`  ✅ سقط  ${m.id} — ${m.label}`);
      log(`       ${m.file}:  ${JSON.stringify(m.from)}`);
      log(`                 ⟶ ${JSON.stringify(m.to)}`);
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
      const root = copyToTemp(workDir, `ctl-${c.id}`, src, c);
      res = await runRowsQuiet(root, opts, ctx);
    } catch (e) { skipped++; problems.push(`${c.id} لم يُطبَّق: ${e.message}`); log(`  ⚠ ${c.id} لم يُطبَّق — ${e.message}`); continue; }
    const fails = realFailures(res);
    if (fails.length === 0) { passed++; log(`  ✅ مرّ   ${c.id} — ${c.label}`); }
    else { badPass++; problems.push(`${c.id} اصطياد كاذب: ${fails.join(' | ')}`); log(`  ❌ سقط   ${c.id} — ${c.label} | ${fails[0].slice(0, 120)}`); }
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

  // متصفّح؟ (مسار CDP القائم). غيابه: بديل jsdom معلَن، أو فشل صريح مع --require-browser.
  const exe = opts.engine === 'cdp' ? findBrowser() : null;
  if (opts.engine === 'cdp' && !exe) {
    if (opts.requireBrowser) {
      process.stderr.write('✗ لا متصفّح Chromium (‏--require-browser): لا قياس لمشغّل يوتيوب عبر CDP\n');
      return 1;
    }
    process.stderr.write('⚠ لا متصفّح Chromium — مشغّل يوتيوب سيُقاس في jsdom (بديل معلَن في مخرَج الصفّ)\n');
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
      code = await selfCheck(src, opts, { cdp, pageUrl, browserVersion, workDir, shippedHashes });
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
        process.stderr.write('✗ --require-clip: حقل page_kept غائب ⇒ فرق song/clip غير مقيَّم\n');
        code = 1;
      } else if (!opts.json) {
        log('');
        log(clipUnmeasured
          ? '⚠ المقيس مرّ، وصفّ فرق song/clip **غير مقيَّم**: حقل page_kept غائب عن هذا الفرع — يُكتمل بعد دمج بند clip (أو --require-clip ليصير فشلاً).'
          : '✓ كل صفوف المتصفّح مرّت.');
      }
      if (opts.out) {
        const artifact = {
          evaluator: 'scripts/check-browser-rows.mjs',
          generated_utc: new Date().toISOString(),
          commit: (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true }).stdout || '').trim() || null,
          root: opts.root,
          engine: res.engine,
          browser: browserVersion,
          rows: res.rows.map((r) => ({
            id: r.id, title: r.title, engine: r.engine, reward: r.reward,
            checks: r.count(), failures: r.failures,
            measured: !r.clipUnmeasured,
          })),
          verdict: code === 0 ? 'pass' : 'fail',
        };
        fs.mkdirSync(path.dirname(opts.out), { recursive: true });
        fs.writeFileSync(opts.out, `${JSON.stringify(artifact, null, 2)}\n`);
        // مع `--json` يبقى stdout JSON خالصاً: سطر الأثر يذهب إلى stderr.
        (opts.json ? process.stderr : process.stdout).write(`أثر: ${opts.out}\n`);
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
