#!/usr/bin/env node
/**
 * check-layout.cjs — a headless layout guard for the HaramLite web UI.
 *
 * WHY THIS EXISTS (the measured bug it was born from)
 * ---------------------------------------------------
 * `#settings-menu` was anchored with the PHYSICAL class `left-0`, while its
 * containing block (`div.relative` in the top app bar) sits at the RIGHT edge
 * of the bar. In English (`dir=ltr`) that pushed the 256px panel 208px past the
 * right edge of a 1084px viewport — the panel rendered cut off. Anchoring it
 * logically (`end-0` / `inset-inline-end: 0`) makes the overflow zero in BOTH
 * directions while Arabic keeps its previous geometry (16…272).
 *
 * WHAT IT CHECKS
 * --------------
 * It serves the built UI from `dist/`, opens it in a headless browser, and for
 * every floating box it can find (`position: absolute` / `fixed`, extracted
 * from the live DOM — not a hardcoded list) asserts that the box's bounds stay
 * inside the window: `rect.left >= 0 && rect.right <= innerWidth` (and the
 * vertical axis when checkable). It sweeps both writing directions and several
 * window widths. This makes the guard general: any floating element that leaves
 * the window fails it, not just the settings panel that motivated it.
 *
 * WHAT IT IS NOT
 * --------------
 * It never builds anything; `dist/` must exist (`pnpm build:web`). It measures
 * the RUNNING page (it never greps the source for class names), so it is blind
 * to `hidden` boxes — an element that is `display:none` in the shipped state is
 * not measured (see `--include-hidden`). Findings are reported, never fixed.
 *
 * WHAT IT REFUSES TO DO (each of these used to be a way to get a green run out
 * of a page that was never measured):
 *   • It will not serve the SPA shell in place of a missing ASSET. A request for
 *     `*.js`/`*.css`/… that is not in `dist/` gets 404 and is recorded; any such
 *     404 fails the run. `dist/index.html` is also checked up front against the
 *     files it references. (Previously: a deleted bundle answered `200 text/html`
 *     with the shell, and the guard said OK.)
 *   • It will not report a `display:none` ANCESTOR's child as measured. Hidden
 *     boxes are revealed WITH their `display:none` ancestors, and a box that is
 *     still 0×0 afterwards is reported as unmeasurable and fails the run.
 *     (Previously: 0×0 with `revealed: true` ⇒ exit 0, while the same geometry
 *     visible ⇒ exit 1.)
 *   • It will not treat the launcher process's exit as a browser failure. On
 *     Windows `chrome.exe` hands off and exits 0 while the browser lives and
 *     answers CDP; the guard waits for the DevTools port/endpoint instead.
 *   • It will not print box counts when the measurement did not complete.
 *     (Previously: `measured 0 floating box(es)` was printed before FAIL, which
 *     is how "zero boxes" was read as a finding.)
 *   • It will not leave the profile directory or the browser behind: cleanup
 *     kills the process tree AND whoever listens on the CDP port, waits for the
 *     exit, deletes the profile and verifies it is gone.
 *
 * USAGE
 * -----
 *   node scripts/check-layout.cjs                       # default sweep
 *   node scripts/check-layout.cjs --skip-if-no-browser  # exit 0 w/ loud notice
 *   node scripts/check-layout.cjs --widths=1084,820 --dirs=ltr,rtl
 *   node scripts/check-layout.cjs --include-hidden      # also measure hidden
 *   node scripts/check-layout.cjs --no-vertical         # horizontal axis only
 *   node scripts/check-layout.cjs --json                # machine-readable
 *   node scripts/check-layout.cjs --pre-script="<js>"   # inject page state first
 *   node scripts/check-layout.cjs --pre-script-file=attacks/foo.js
 *     (the injection hook exists so the guard can be ATTACKED: plant a floating
 *      box, force a window size, and confirm the guard still catches it. The
 *      file form is the reliable one — a shell mangles multi-line JS. It
 *      evaluates arbitrary JS in the page: pass only script you wrote.)
 *
 * Exit code 0 = OK, 1 = a measured overflow / driver failure, 2 = usage error.
 *
 * No npm dependencies: only Node's stdlib (`node:http`, `node:fs`, `node:net`,
 * `node:child_process`, `node:crypto`) plus the global `WebSocket` (Node >= 22).
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const I18N_TS = path.join(ROOT, 'src', 'i18n.ts');

/* ── CLI ──────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const opts = {
    widths: [1084, 820, 1920],
    height: 800, // src-tauri/tauri.conf.json "height"
    dirs: ['ltr', 'rtl'],
    includeHidden: false,
    checkVertical: true,
    skipIfNoBrowser: false,
    browserPath: null,
    json: false,
    preScript: null,
    preScriptFile: null,
    timeoutMs: 60000,
  };
  for (const raw of argv) {
    const [flag, value] = raw.startsWith('--') ? raw.slice(2).split('=') : [raw, undefined];
    switch (flag) {
      case 'skip-if-no-browser': opts.skipIfNoBrowser = true; break;
      case 'include-hidden': opts.includeHidden = true; break;
      case 'no-vertical': opts.checkVertical = false; break;
      case 'json': opts.json = true; break;
      case 'browser': opts.browserPath = value; break;
      case 'height': opts.height = Number(value); break;
      case 'timeout': opts.timeoutMs = Number(value); break;
      case 'pre-script': opts.preScript = value === undefined ? '' : value; break;
      case 'pre-script-file': opts.preScriptFile = value; break;
      case 'widths': opts.widths = String(value).split(',').map(Number).filter(Boolean); break;
      case 'dirs': opts.dirs = String(value).split(',').map((d) => d.trim()).filter(Boolean); break;
      default:
        console.error(`unknown option: ${raw}`);
        process.exit(2);
    }
  }
  if (!opts.widths.length) { console.error('--widths must list at least one width'); process.exit(2); }
  for (const d of opts.dirs) {
    if (d !== 'ltr' && d !== 'rtl') { console.error(`--dirs accepts ltr/rtl, got "${d}"`); process.exit(2); }
  }
  return opts;
}

/* ── tiny logging ─────────────────────────────────────────────────────── */

const log = (...a) => console.log(...a);
const note = (...a) => console.log('  ', ...a);
function fatal(msg, code = 1) { console.error(`FAIL: ${msg}`); process.exit(code); }

/* ── static server for dist/ (IPv4 explicitly) ────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

function startServer() {
  // كل مسار لم يوجد في dist/ يُسجَّل هنا. الحارس يفشل إن لم يكن فارغاً: سقوط
  // SPA على أصل مفقود كان يجيب `200 text/html` على حزمة JS محذوفة فيقيس
  // الحارس هيكلاً فارغاً ويقول OK.
  const notFound = [];
  // طلبات تلقائية من المتصفّح نفسه (لا مرجع لها في dist/index.html): تُسجَّل
  // في probes ولا تُفشل — وإلا لصار غياب favicon فشلاً كاذباً في كل تشغيل.
  const BROWSER_PROBES = new Set(['/favicon.ico']);
  const probes = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
      const file = path.join(DIST, rel);
      const relCheck = path.relative(DIST, file);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      let body = null;
      try {
        body = await fsp.readFile(file);
      } catch {
        body = null;
      }
      if (body === null) {
        // سقوط SPA للتنقّل فقط: مسار بلا امتداد يطلبه المتصفّح كصفحة. أمّا
        // أصل بامتداد (js/css/font/png…) فمفقوده 404 صريح — لا هيكل مكانه.
        const looksLikeAsset = /\.[A-Za-z0-9]+$/.test(rel);
        const wantsHtml = String(req.headers.accept || '').includes('text/html');
        if (!looksLikeAsset && wantsHtml) {
          body = await fsp.readFile(path.join(DIST, 'index.html'));
          rel = '/index.html';
        } else if (BROWSER_PROBES.has(rel)) {
          // طلبات يطلقها المتصفّح من تلقاء نفسه (لا تشير إليها الصفحة): غيابها
          // ليس أصلاً مفقوداً، ويُسجَّل للمعلومة لا للفشل.
          probes.push(rel);
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`browser probe, not in dist/: ${rel}`);
          return;
        } else {
          notFound.push(rel);
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`not in dist/: ${rel}`);
          return;
        }
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err && err.message));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 explicitly: binding the IPv6 loopback (::1) has failed here
    // before with EACCES, so the guard does not rely on "localhost" resolving.
    server.listen(0, '127.0.0.1', () => {
      const { port, address } = server.address();
      if (address !== '127.0.0.1') {
        server.close();
        reject(new Error(`server bound to ${address}, expected 127.0.0.1`));
        return;
      }
      resolve({ server, port, origin: `http://127.0.0.1:${port}`, notFound, probes });
    });
  });
}

/**
 * فحص سبق القياس: كل ما يشير إليه dist/index.html من أصول محلّية يجب أن يكون
 * موجوداً في dist/. الحزمة المحذوفة تُكتشف هنا قبل إطلاق المتصفّح — لا بعد أن
 * يقيس الحارس هيكلاً فارغاً ويقول OK.
 */
function missingReferencedAssets() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const refs = new Set();
  for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const u = m[1].trim();
    if (!u || u.startsWith('#') || u.startsWith('data:') || /^[a-z]+:/i.test(u)) continue;
    refs.add(u.split('?')[0].split('#')[0]);
  }
  const missing = [];
  for (const ref of refs) {
    const rel = ref.replace(/^\/+/, '');
    if (!rel) continue;
    if (!fs.existsSync(path.join(DIST, rel))) missing.push(ref);
  }
  return missing.sort();
}

/* ── browser discovery / launch ───────────────────────────────────────── */

function findBrowser(explicit) {
  const isFile = (p) => {
    try { return Boolean(p) && fs.statSync(p).isFile(); } catch { return false; }
  };
  // An explicit choice wins, and is not silently replaced by a default install:
  // `--browser=/nope/chrome` must fail, not quietly measure with another binary.
  if (explicit) return isFile(explicit) ? explicit : null;
  const candidates = [
    process.env.HARAMLITE_BROWSER,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) if (isFile(c)) return c;
  return null;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** يقتل شجرة عمليّة على ويندوز (taskkill /T) أو عمليّة واحدة على غيره. */
function killTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status === 0;
    }
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/**
 * عمليّات تستمع على منفذ CDP. على ويندوز يخرج مُشغِّل chrome.exe فوراً بينما
 * المتصفّح الحقيقي يبقى حيّاً (وحينها لا يفيد PID الذي أطلقناه) — فيُقتل صاحب
 * المنفذ. هذه هي نفس الطريقة التي أُغلقت بها المتصفّحات المتسرّبة سابقاً.
 * كل محاولة تُسجَّل في lastPortProbe حتى يقول تقرير التنظيف ماذا رأى بالضبط.
 */
let lastPortProbe = null;
function pidsOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
      const pids = new Set();
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        const cols = line.trim().split(/\s+/);
        if ((cols[1] || '').endsWith(`:${port}`)) {
          const pid = Number(cols[cols.length - 1]);
          if (pid) pids.add(pid);
        }
      }
      lastPortProbe = { port, how: 'netstat', status: r.status, error: r.error ? r.error.code : null, stdoutBytes: String(r.stdout || '').length, found: [...pids] };
      return [...pids];
    }
    const r = spawnSync('lsof', ['-t', `-i:${port}`], { encoding: 'utf8' });
    const pids = String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
    lastPortProbe = { port, how: 'lsof', status: r.status, error: r.error ? r.error.code : null, stdoutBytes: String(r.stdout || '').length, found: pids };
    return pids;
  } catch (err) {
    lastPortProbe = { port, how: 'threw', error: String((err && err.message) || err), found: [] };
    return [];
  }
}

/**
 * عمليّات المتصفّح التي تحمل مجلد ملفّنا الشخصي في سطر أمرها. هذا تعريف لا
 * يخطئ: المجلد اسمه عشوائي خاص بهذه التشغيلة، فكل من يحمله هو متصفّحنا — حتى
 * لو خرج المُشغِّل وتغيّر الـPID أو تعذّر العثور على المنفذ.
 */
function pidsByProfile(dir, exeBase) {
  try {
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process -Filter "Name='${exeBase}'" | Where-Object { $_.CommandLine -like '*${dir}*' } | Select-Object -ExpandProperty ProcessId`;
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
      return String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
    }
    const r = spawnSync('pgrep', ['-f', dir], { encoding: 'utf8' });
    return String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
  } catch {
    return [];
  }
}

/** هل ما زال الطرف الآخر يجيب على منفذ CDP؟ (تحقّق وظيفي لا يعتمد على sنظام) */
async function cdpStillAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

async function launchBrowser(exe, opts) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'haramlite-layout-'));
  const portFile = path.join(dir, 'DevToolsActivePort');
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    `--window-size=${opts.widths[0]},${opts.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
    '--allow-insecure-localhost',
    'about:blank',
  ];
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  // مُشغِّل chrome.exe على ويندوز يسلّم الأمر ثم يخرج بـ0 والمتصفّح يبقى حيّاً
  // ويجيب CDP. لذلك خروج المُشغِّل ليس فشلاً بذاته: الفشل هو ألّا يظهر منفذ.
  let launcherExit = null;
  child.once('exit', (code, signal) => { launcherExit = { code, signal }; });

  const deadline = Date.now() + 30000;
  let port = 0;
  while (Date.now() < deadline) {
    try {
      const txt = await fsp.readFile(portFile, 'utf8');
      const first = txt.split(/\r?\n/)[0].trim();
      if (first) { port = Number(first); break; }
    } catch { /* not written yet */ }
    await sleep(120);
  }
  if (!port) {
    await killTree(child.pid);
    const why = launcherExit ? ` (the launcher process exited with code ${launcherExit.code}${launcherExit.signal ? `/${launcherExit.signal}` : ''} and no browser took over)` : '';
    throw new Error(`browser never reported a DevTools port within 30s${why}\n${stderr.trim()}`);
  }

  // Wait for the HTTP endpoint to answer as well — this, not the launcher's exit
  // code, is what proves a browser is actually there to measure with.
  let version = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* not up yet */ }
    await sleep(150);
  }
  if (!version) {
    await killTree(child.pid);
    for (const pid of pidsOnPort(port)) killTree(pid);
    throw new Error('DevTools HTTP endpoint did not become reachable');
  }

  /**
   * تنظيف حقيقي: اقتل شجرة المُشغِّل إن كانت حيّة، ثم أصحاب منفذ CDP (المتصفّح
   * يبقى بعد خروج المُشغِّل)، وانتظر خروج العمليّة فعلاً، ثم احذف مجلد الملف
   * الشخصي وتحقّق من زواله. كل خطوة تُبلَّغ، والفشل يُرفع إلى main() فيُفشل
   * الحارس — لا يُترك أثر صامت (كان 9/9 تشغيلات تترك ~340 ملفاً وعمليّات حيّة).
   */
  const cleanup = async () => {
    const exeBase = path.basename(exe);
    const report = { profileRemoved: false, killed: [], profilePath: dir, remainingPids: [], childExited: true, endpointAlive: false, byProfile: [], byPort: [] };
    if (child.exitCode === null && child.signalCode === null) {
      if (killTree(child.pid)) report.killed.push(child.pid);
      report.childExited = await waitForExit(child, 10000);
    }
    // (١) تعريف لا يخطئ: كل عمليّة تحمل مجلد ملفّنا الشخصي، (٢) ثم صاحب منفذ CDP.
    report.byProfile = pidsByProfile(dir, exeBase);
    for (const pid of report.byProfile) {
      killTree(pid);
      report.killed.push(pid);
    }
    report.byPort = pidsOnPort(port);
    for (const pid of report.byPort) {
      if (!report.killed.includes(pid)) report.killed.push(pid);
      killTree(pid);
    }
    report.endpointAlive = await cdpStillAlive(port);
    for (let attempt = 0; attempt < 15; attempt++) {
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* locked: retry */ }
      if (!fs.existsSync(dir)) { report.profileRemoved = true; break; }
      await sleep(200);
    }
    if (!report.profileRemoved) {
      // محاولة أخيرة: اقتل كل من يحمل المجلد أو المنفذ، ثم احذف.
      for (const pid of [...pidsByProfile(dir, exeBase), ...pidsOnPort(port)]) killTree(pid);
      await sleep(400);
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* reported below */ }
      report.profileRemoved = !fs.existsSync(dir);
    }
    report.remainingPids = pidsOnPort(port);
    report.endpointAlive = (await cdpStillAlive(port)) || report.remainingPids.length > 0 || pidsByProfile(dir, exeBase).length > 0;
    report.portProbe = lastPortProbe;
    return report;
  };

  /** تنظيف متزامن لخطّاف الخروج: لا يترك متصفّحاً حيّاً إن انهار الحارس. */
  const cleanupSync = () => {
    if (child.exitCode === null && child.signalCode === null) killTree(child.pid);
    for (const pid of pidsByProfile(dir, path.basename(exe))) killTree(pid);
    for (const pid of pidsOnPort(port)) killTree(pid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  return { child, port, version, cleanup, cleanupSync, stderrText: () => stderr, launcherExit: () => launcherExit };
}

/* ── minimal CDP client over the global WebSocket ─────────────────────── */

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
    return () => {
      const arr = this.listeners.get(key) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* ── i18n table extraction (real strings, not class-name guessing) ────── */

/**
 * Pull the `const i18n = { ar: {...}, en: {...} }` object literal out of
 * src/i18n.ts without a TypeScript toolchain: brace-match the literal, cut a
 * trailing `as const`, and evaluate it. Returns null (never throws) when the
 * table cannot be recovered — the caller then measures geometry only and says
 * so in its output, because a guard that silently invents label text is worse
 * than one that admits it measured geometry alone.
 */
function loadI18nTable() {
  let src;
  try { src = fs.readFileSync(I18N_TS, 'utf8'); } catch { return null; }
  const start = src.indexOf('const i18n');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;

  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        let literal = src.slice(open, i + 1);
        literal = literal.replace(/\}\s*as\s+const\s*$/, '}');
        try {
          // eslint-disable-next-line no-new-func
          const table = new Function(`return (${literal});`)();
          if (table && table.ar && table.en) return table;
          return null;
        } catch { return null; }
      }
    }
  }
  return null;
}

/* ── the in-page probe (runs inside the browser) ──────────────────────── */

/**
 * `runProbe` is stringified and evaluated in the page. It is deliberately
 * self-contained (no closures) so `Runtime.evaluate` can carry it.
 */
function runProbe(args) {
  return (async () => {
    const { dir, lang, table, includeHidden, checkVertical } = args;

  document.documentElement.setAttribute('dir', dir);
  document.documentElement.setAttribute('lang', lang);

  // Apply real UI strings, exactly as the app's applyLang() does. Injection is
  // guarded per element: a missing key leaves the shipped markup untouched.
  let applied = 0;
  let missingKeys = 0;
  if (table) {
    const dict = table[lang] || {};
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (dict[key] === undefined) { missingKeys++; return; }
      el.innerHTML = String(dict[key]);
      applied++;
    });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria');
      if (dict[key] !== undefined) el.setAttribute('aria-label', String(dict[key]));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (dict[key] !== undefined) el.setAttribute('title', String(dict[key]));
    });
  }

  // The settings panel is `hidden` in a plain browser (no Tauri IPC to open it).
  // Only the `hidden` visibility utility is removed — the panel's own geometry
  // classes are left to do the work, because injecting `end-0` here would mask
  // the exact regression this guard exists to catch. The built bundle inlines
  // every module and exports nothing, so the app's own open-settings routine is
  // not reachable from the page; removing one class is the closest honest
  // equivalent and it changes no geometry class.
  const menu = document.getElementById('settings-menu');
  let menuVisible = false;
  let menuProblem = null;
  let menuPosition = null;
  if (menu) {
    menu.classList.remove('hidden');
    const cs = getComputedStyle(menu);
    menuPosition = cs.position;
    menuVisible = cs.display !== 'none' && menu.getBoundingClientRect().width > 0;
    if (cs.position !== 'absolute' && cs.position !== 'fixed') {
      menuVisible = false;
      menuProblem = `#settings-menu is position:${cs.position} in the built CSS — it is not anchored at all, so its overflow cannot be measured`;
    }
  } else {
    menuProblem = '#settings-menu was not found in the DOM';
  }

  // Un-hiding the panel starts its entry animation (`.fade-in-up`: opacity 0 →
  // 1 with a 15px translateY, .6s forwards). Measuring mid-flight reports a box
  // that is still 15px low and still transparent — so the guard first waits for
  // every animation, then for the geometry to stop moving. Two independent
  // gates, because `getAnimations()` misses CSS transitions and an element can
  // keep drifting after its animation reports finished.
  try {
    if (document.getAnimations) {
      const anims = document.getAnimations();
      if (anims.length) {
        await Promise.race([
          Promise.allSettled(anims.map((a) => a.finished)).then(() => true),
          new Promise((r) => setTimeout(() => r(false), 5000)),
        ]);
      }
    }
  } catch { /* animation waiting is best-effort */ }

  const floatersAll = () => Array.from(document.querySelectorAll('body *')).filter((el) => {
    const p = getComputedStyle(el).position;
    return p === 'absolute' || p === 'fixed';
  });
  const snapshot = () => floatersAll().map((el) => {
    const r = el.getBoundingClientRect();
    return `${el.id}|${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}|${getComputedStyle(el).opacity}`;
  }).join('#');

  let settled = false;
  try {
    let prev = snapshot();
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 80));
      const next = snapshot();
      if (next === prev) { settled = true; break; }
      prev = next;
    }
  } catch { /* settling is best-effort */ }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const label = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  // Readable identity for the report: id first, else a data-i18n key, else the
  // first utility class that is not a layout primitive, else the tag.
  const describe = (el) => {
    if (el.id) return el.id;
    const k = el.getAttribute('data-i18n-aria') || el.getAttribute('data-i18n');
    if (k) return k;
    const generic = /^(absolute|fixed|relative|sticky|static|hidden|block|flex|inline|grid|z-|inset-|top-|left-|right-|bottom-|w-|h-|p-|m-|opacity-|pointer-|transform|translate|-translate|text-|font-|items-|justify-|gap-|rounded|mx-|my-|mt-|mb-|ml-|mr-)/;
    const cls = (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter((c) => c && !c.includes(':') && !generic.test(c));
    if (cls.length) return cls[0];
    return (label(el) || el.tagName.toLowerCase());
  };
  const floaters = floatersAll();
  const inlineBlockOverflowX = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  const inFixedAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).position === 'fixed') return true;
    }
    return false;
  };

  const rows = [];
  const skipped = [];
  // المرحلة ١: صفوف ظاهرة. صفوف مخفيّة/صفرية تُؤجَّل: إظهارها يغيّر التخطيط،
  // فيُقاس الظاهر أولاً كما هو مشحون، ثم تُظهر المخفيّات كلها، ثم تُقاس.
  const deferred = [];
  const finishRow = (row, el) => {
    const overflowLeft = Math.max(0, -row.left);
    const overflowRight = Math.max(0, row.right - vw);
    const overflowTop = Math.max(0, -row.top);
    const overflowBottom = Math.max(0, row.bottom - vh);
    row.overflowX = +Math.max(overflowLeft, overflowRight).toFixed(2);
    row.overflowY = +Math.max(overflowTop, overflowBottom).toFixed(2);
    // A box inside a scroll container is clipped and scrollable by design: it is
    // reported, never counted as a violation. Same for anything inside a
    // position:fixed subtree (that ancestor is the box the guard already gates).
    row.clipped = inlineBlockOverflowX(el) || inFixedAncestor(el);
    row.violation = row.overflowX > 0.5 || (checkVertical && row.overflowY > 0.5);
    row.gated = row.violation && !row.clipped;
    rows.push(row);
  };

  for (const el of floaters) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // An already-transparent box still occupies space and can still leave the
    // window: only `display:none` (no box) and `visibility:hidden` (no paint,
    // but a box) are excluded by default, and they are reported as skipped. A
    // zero-area box cannot overflow either. opacity:0 is deliberately NOT a
    // skip — that is the state of a panel mid-entry-animation.
    const hidden = cs.display === 'none' || cs.visibility === 'hidden';
    const tiny = r.width < 1 || r.height < 1;
    const row = {
      name: describe(el),
      tag: el.tagName.toLowerCase(),
      position: cs.position,
      dir: dir,
      hidden,
      tiny,
      inFixedAncestor: inFixedAncestor(el),
      inlineScrollAncestor: inlineBlockOverflowX(el),
      left: +r.left.toFixed(2),
      right: +r.right.toFixed(2),
      top: +r.top.toFixed(2),
      bottom: +r.bottom.toFixed(2),
      width: +r.width.toFixed(2),
      height: +r.height.toFixed(2),
    };
    if (hidden || tiny) {
      if (!includeHidden) { skipped.push({ name: row.name, why: hidden ? 'hidden' : 'zero-size' }); continue; }
      deferred.push({ el, row });
      continue;
    }
    finishRow(row, el);
  }

  if (deferred.length) {
    // الإظهار أولاً لكل العناصر، ثم القياس: الفصل يضمن أن كل قياس رآه الحالة
    // نفسها (وإلا أثّر إظهار عنصر على قياس عنصر آخر).
    const revealedAncestors = new Map();
    for (const { el } of deferred) {
      let n = 0;
      // إظهار العنصر وحده لا يكفي: صندوق داخل حاوية display:none يبقى بلا
      // صندوق (0×0) فيُقاس صفراً ويُقال `revealed` — وهذا كان يمرّ OK.
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.display === 'none') { p.style.setProperty('display', 'block', 'important'); n++; continue; }
        if (pcs.visibility === 'hidden') { p.style.setProperty('visibility', 'visible', 'important'); n++; }
      }
      revealedAncestors.set(el, n);
    }
    for (const { el, row } of deferred) {
      const cs2 = getComputedStyle(el);
      el.style.setProperty('display', cs2.display === 'none' ? 'block' : cs2.display, 'important');
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('opacity', '1', 'important');
      const r2 = el.getBoundingClientRect();
      const measurable = r2.width >= 1 && r2.height >= 1;
      // `revealed` بشرط: لا يُقال «أُظهر» لصندوق لم يصر له صندوق.
      row.revealed = measurable;
      row.revealedAncestors = revealedAncestors.get(el) || 0;
      row.unmeasurable = !measurable;
      row.left = +r2.left.toFixed(2); row.right = +r2.right.toFixed(2);
      row.top = +r2.top.toFixed(2); row.bottom = +r2.bottom.toFixed(2);
      row.width = +r2.width.toFixed(2); row.height = +r2.height.toFixed(2);
      row.tiny = !measurable;
      finishRow(row, el);
    }
  }

  // Geometry probe, independent of the rendered box: where WOULD this element
  // sit if it were anchored to the box's start edge? This is what makes the
  // guard falsifiable — it predicts the corruption instead of merely tolerating
  // it. The clone is inserted into the REAL offsetParent of the live panel (the
  // containing block that decides those percentages), so 100%/0% land where the
  // shipped element lands; only the physical side is swapped.
  let probe = null;
  let probeError = null;
  if (menu) {
    let clone = null;
    try {
      const host = menu.offsetParent || menu.parentElement;
      const menuCs = getComputedStyle(menu);
      clone = menu.cloneNode(true);
      clone.id = '__hl_layout_probe__';
      clone.classList.remove('hidden');
      clone.style.display = 'block';
      clone.style.visibility = 'hidden';
      clone.style.pointerEvents = 'none';
      clone.style.zIndex = '-1';
      if (/^\d/.test(menuCs.top)) clone.style.top = menuCs.top;
      host.appendChild(clone);

      const measure = (inlineStartSide) => {
        // `dir` on the box is what decides which physical side `start` means.
        clone.setAttribute('dir', dir);
        // Logical insets, set explicitly on BOTH sides: the clone still carries
        // the shipped class (`end-0` -> inset-inline-end: 0), so leaving the
        // other side untouched let the class win and pushed the clone out of the
        // window. Setting physical left/right is not enough either — a physical
        // `left:0` does not cancel a logical `end-0` in RTL.
        if (inlineStartSide) {
          clone.style.insetInlineStart = '0px';
          clone.style.insetInlineEnd = 'auto';
        } else {
          clone.style.insetInlineStart = 'auto';
          clone.style.insetInlineEnd = '0px';
        }
        const r = clone.getBoundingClientRect();
        const parentRect = host.getBoundingClientRect();
        return {
          left: r.left, right: r.right, width: r.width,
          computedLeft: getComputedStyle(clone).left,
          computedRight: getComputedStyle(clone).right,
          hostLeft: parentRect.left, hostRight: parentRect.right,
        };
      };

      const start = measure(true);
      const end = measure(false);
      const vwProbe = window.innerWidth;
      probe = {
        panelWidth: +start.width.toFixed(2),
        containingBlockLeft: +start.hostLeft.toFixed(2),
        containingBlockRight: +start.hostRight.toFixed(2),
        startEdgeLeft: +start.left.toFixed(2),
        startEdgeRight: +start.right.toFixed(2),
        endEdgeLeft: +end.left.toFixed(2),
        endEdgeRight: +end.right.toFixed(2),
        startEdgeComputed: { left: start.computedLeft, right: start.computedRight },
        endEdgeComputed: { left: end.computedLeft, right: end.computedRight },
        predictedOverflowAtStartEdge: +Math.max(0, start.right - vwProbe).toFixed(2),
        predictedOverflowAtEndEdge: +Math.max(0, end.right - vwProbe).toFixed(2),
      };
    } catch (err) {
      probeError = String((err && err.message) || err);
    } finally {
      if (clone) clone.remove();
    }
  }

  const menuRow = rows.find((r) => r.name === 'settings-menu') || null;
  return {
    viewport: { width: vw, height: vh },
    dir,
    lang,
    settled,
    appliedStrings: applied,
    missingStringKeys: missingKeys,
      i18nApplied: Boolean(table) && applied > 0,
      floatingCount: floaters.length,
      measuredCount: rows.length,
      menuFound: Boolean(menu),
      menuVisible,
      menuPosition,
      menuProblem,
      menuRow,
      probe,
      probeError,
      rows,
      skipped,
    };
  })();
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    fatal(`dist/index.html not found at ${DIST}. Build it first:  pnpm build:web`, 1);
  }
  // لا قياس على أصول غير موجودة: لو حُذفت الحزمة لبقي الهيكل وحده، وسقوط SPA
  // كان يجيب 200 text/html فيقول الحارس OK على صفحة لم تُشغَّل أصلاً.
  const missingAssets = missingReferencedAssets();
  if (missingAssets.length) {
    fatal(
      `dist/index.html يشير إلى ${missingAssets.length} أصلاً غير موجود في dist/: ${missingAssets.join(', ')} — ` +
      'القياس على هيكل بلا حزمته لا يعني شيئاً. أعِد البناء:  pnpm build:web', 1,
    );
  }

  const exe = findBrowser(opts.browserPath);
  if (!exe) {
    const msg =
      'no Chromium-based browser found (looked for Chrome/Edge in their default ' +
      'install paths and $HARAMLITE_BROWSER / $CHROME_PATH)';
    if (opts.skipIfNoBrowser) {
      log(`SKIPPED: ${msg} — --skip-if-no-browser was passed, so this run does not block.`);
      process.exit(0);
    }
    fatal(`${msg}. Pass --skip-if-no-browser to downgrade this to a skip.`, 1);
  }

  const table = loadI18nTable();
  let i18nNote = table
    ? 'i18n table read from src/i18n.ts — real ar/en strings injected'
    : 'i18n table NOT readable from src/i18n.ts — measuring GEOMETRY ONLY (labels stay as shipped)';

  // Prefer the file form: passing multi-line JS through a shell mangles it
  // (PowerShell in particular strips quotes inside `--pre-script=...`), and a
  // mangled attack that throws would look exactly like a guard that missed it.
  let preScript = opts.preScript;
  if (opts.preScriptFile) {
    try {
      preScript = fs.readFileSync(path.resolve(process.cwd(), opts.preScriptFile), 'utf8');
    } catch (err) {
      fatal(`cannot read --pre-script-file ${opts.preScriptFile}: ${(err && err.message) || err}`, 2);
    }
  }

  log('HaramLite layout guard');
  log(`  browser : ${exe}`);
  log(`  dist    : ${DIST}`);
  log(`  windows : ${opts.widths.join(', ')} x ${opts.height}   dirs: ${opts.dirs.join(', ')}`);
  log(`  i18n    : ${i18nNote}`);
  if (preScript) log(`  pre-script: ${preScript.length} byte(s) of page JS will run before measurement`);
  log('');

  const { server, origin, notFound, probes } = await startServer();
  let browser = null;
  let cdp = null;
  const allRows = [];
  const problems = [];
  let driverError = null;
  let cleanupReport = null;
  // خطّاف خروج: لا يُترك متصفّح حيّ ومجلد ملف شخصي إن انهار الحارس في المنتصف.
  const exitHook = () => { if (browser) browser.cleanupSync(); };
  process.once('exit', exitHook);

  try {
    browser = await launchBrowser(exe, opts);
    cdp = await Cdp.connect(browser.version.webSocketDebuggerUrl);

    for (const width of opts.widths) {
      for (const dir of opts.dirs) {
        const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        try {
          await cdp.send('Page.enable', {}, sessionId);
          await cdp.send('Runtime.enable', {}, sessionId);
          await cdp.send('Network.enable', {}, sessionId);
          // The layout viewport is set through CDP emulation rather than
          // --window-size: Target.createTarget rejects explicit sizes ("position
          // can only be set for new windows") and a real OS window would need a
          // browser restart per width. CSS layout depends on the viewport box,
          // not on how it was produced, and the measured innerWidth is asserted
          // against the requested width below.
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width,
            height: opts.height,
            deviceScaleFactor: 1,
            mobile: false,
          }, sessionId);
          // Nothing external is needed (fonts ship in dist/); blocking the
          // remote font CDNs keeps the measurement immune to network flakiness.
          await cdp.send('Network.setBlockedURLs',
            { urls: ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'] }, sessionId);

          const loaded = cdp.once(`${sessionId}:Page.loadEventFired`, opts.timeoutMs);
          await cdp.send('Page.navigate', { url: `${origin}/index.html` }, sessionId);
          await loaded;

          // Deterministic measurement point: layout settled + fonts done.
          await cdp.send('Runtime.evaluate', {
            expression: 'document.fonts && document.fonts.ready ? document.fonts.ready.then(()=>true) : true',
            awaitPromise: true,
            returnByValue: true,
          }, sessionId, opts.timeoutMs);
          await sleep(120);

          const probeArgs = { dir, lang: dir === 'rtl' ? 'ar' : 'en', table, includeHidden: opts.includeHidden, checkVertical: opts.checkVertical };
          if (preScript) {
            // Injectable page state, for self-testing the guard by attacking it
            // (a planted floating box, a forced window size, ...). It runs in
            // the page context: only pass script you wrote. Its result and any
            // exception are printed — a silently-failing attack would look
            // exactly like a guard that failed to notice.
            const pre = await cdp.send('Runtime.evaluate', {
              expression: preScript, returnByValue: true, awaitPromise: true,
            }, sessionId, opts.timeoutMs);
            const preVal = pre.result && pre.result.value;
            note(`pre-script → ${pre.exceptionDetails ? `THREW: ${pre.exceptionDetails.text} ${(pre.exceptionDetails.exception || {}).description || ''}` : JSON.stringify(preVal)}`);
          }
          const res = await cdp.send('Runtime.evaluate', {
            expression: `(${runProbe.toString()})(${JSON.stringify(probeArgs)})`,
            returnByValue: true,
            awaitPromise: true, // the probe awaits animations before measuring
          }, sessionId, opts.timeoutMs);

          if (res.exceptionDetails) {
            throw new Error(`in-page probe threw: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description || '')}`);
          }
          const data = res.result.value;
          if (!data) throw new Error('in-page probe returned nothing');

          if (!data.i18nApplied && table) {
            problems.push(`${dir}@${width}: i18n table loaded but no data-i18n node accepted a string (labels may not be the app's own)`);
          }
          if (data.missingStringKeys) {
            note(`note: ${data.missingStringKeys} [data-i18n] node(s) had no key in the ${data.lang} table`);
          }
          if (Math.abs(data.viewport.width - width) > 1) {
            problems.push(`${dir}@${width}: window.innerWidth is ${data.viewport.width}, not ${width} — this row measured a different width`);
          }
          if (!data.menuFound || !data.menuVisible) {
            problems.push(`${dir}@${width}: ${data.menuProblem || '#settings-menu could not be made visible'}`);
          }
          // The measured panel and the probe's end-edge prediction must agree:
          // if they do not, the probe is not modelling the shipped geometry and
          // its predicted-overflow number cannot be trusted either.
          if (data.menuRow && data.probe) {
            const drift = Math.abs(data.menuRow.left - data.probe.endEdgeLeft);
            if (drift > 1) {
              problems.push(`${dir}@${width}: measured #settings-menu left=${data.menuRow.left} but the end-edge probe predicts ${data.probe.endEdgeLeft} (drift ${drift.toFixed(2)}px) — probe and page disagree`);
            }
          }

          log(`── ${dir} @ ${data.viewport.width}x${data.viewport.height} (requested ${width}) ──`);
          log('   element                        dir  width    left      right     overflowX  overflowY');
          const ordered = data.rows.slice().sort((a, b) => b.overflowX - a.overflowX || a.name.localeCompare(b.name));
          for (const r of ordered) {
            const flag = r.violation ? (r.clipped ? ' [clipped-by-scroll-container]' : ' [OUT OF WINDOW]') : '';
            const tag = r.unmeasurable ? ' [UNMEASURABLE]' : (r.revealed ? ` [was-hidden${r.revealedAncestors ? `, +${r.revealedAncestors} ancestor(s) revealed` : ''}]` : '');
            log(
              `   ${r.name.padEnd(30).slice(0, 30)} ${r.dir}  ${String(r.width).padStart(7)}  ${String(r.left).padStart(8)}  ${String(r.right).padStart(8)}  ${String(r.overflowX).padStart(9)}  ${String(r.overflowY).padStart(9)}${flag}${tag}`,
            );
          }
          if (data.skipped.length) {
            const names = data.skipped.map((s) => `${s.name}(${s.why})`).join(', ');
            note(`not measured (not rendered in this state): ${names}`);
          }
          if (!data.settled) {
            note('WARNING: the page never stopped moving within 3s — the numbers below may be a mid-flight reading');
          }
          if (data.probe) {
            note(`probe: panel ${data.probe.panelWidth}px in containing block [${data.probe.containingBlockLeft}…${data.probe.containingBlockRight}] · start-edge(left-0) right=${data.probe.startEdgeRight} ⇒ predicted overflow ${data.probe.predictedOverflowAtStartEdge}px · end-edge(right-0) right=${data.probe.endEdgeRight} ⇒ predicted overflow ${data.probe.predictedOverflowAtEndEdge}px`);
            if (width === 1084 && dir === 'ltr' && data.probe.predictedOverflowAtStartEdge < 50) {
              problems.push(`ltr@1084: the start-edge (left-0) probe predicts only ${data.probe.predictedOverflowAtStartEdge}px of overflow — the guard's own premise is no longer true, investigate before trusting a green run`);
            }
          } else if (data.probeError) {
            note(`probe unavailable: ${data.probeError}`);
          }

          for (const r of data.rows) {
            allRows.push({ ...r, requestedWidth: width });
            if (r.unmeasurable) {
              // صندوق لم يصر له صندوق حتى بعد إظهاره: لا يُقال عنه «قِيس» ولا
              // يُمرَّر بصمت — هذا هو الموضع الذي كان يخرج 0×0 مع revealed=true.
              problems.push(
                `${r.name} (${r.position}) at ${data.viewport.width}px/${r.dir}: قُيس 0×0 حتى بعد إظهاره ` +
                `(أُظهر ${r.revealedAncestors || 0} وعاءً) — هندسته غير قابلة للقياس فحكم «داخل النافذة» باطل`,
              );
            }
            if (r.gated) {
              problems.push(
                `${r.name} (${r.position}) leaves the ${r.dir} window at ${data.viewport.width}px: ` +
                `left=${r.left} right=${r.right} overflowX=${r.overflowX}px`,
              );
            }
          }
          log('');
        } finally {
          try { await cdp.send('Target.closeTarget', { targetId: target.targetId }); } catch { /* ignore */ }
        }
      }
    }
  } catch (err) {
    driverError = String((err && err.message) || err);
  } finally {
    if (cdp) cdp.close();
    if (browser) {
      cleanupReport = await browser.cleanup();
      if (!cleanupReport.profileRemoved) {
        problems.push(`تعذّر حذف مجلد الملف الشخصي ${cleanupReport.profilePath} — أثر متروك (قتلنا ${cleanupReport.killed.length} عمليّة)`);
      }
      if (cleanupReport.endpointAlive) {
        problems.push(`متصفّح ما زال حيّاً بعد التنظيف (منفذ CDP ${browser.port} يجيب أو عمليّات باقية) — تسريب`);
      }
      if (!cleanupReport.childExited) {
        problems.push(`عمليّة المتصفّح ${browser.child.pid} لم تنتهِ خلال 10s بعد القتل`);
      }
    }
    server.close();
  }

  // أي طلب لأصل غير موجود يعني أن ما قيس ليس ما شُحن.
  if (notFound.length) {
    const uniq = [...new Set(notFound)];
    driverError = driverError || `طلبات لأصول غير موجودة في dist/ أُجيبت 404 (${uniq.length}): ${uniq.join(', ')}`;
  }

  if (opts.json) {
    log(JSON.stringify({ ok: !driverError && problems.length === 0, driverError, problems, notFound, probes, cleanup: cleanupReport, rows: allRows }, null, 2));
  } else if (driverError) {
    // عدّ القياس لا يُطبَع حين لم يكتمل القياس: كان «measured 0 floating
    // box(es)» يُطبَع قبل FAIL فيُقرأ كأن الصفحة بلا صناديق (تفسير «صفر صندوق»).
    log('the measurement did not complete — no box counts are reported (zeros here would be an artefact, not a finding).');
  } else {
    const tauriMin = 820;
    if (opts.widths.includes(tauriMin)) log(`tauri minWidth ${tauriMin} was covered.`);
    log(`measured ${allRows.length} floating box(es) across ${opts.widths.length * opts.dirs.length} window state(s).`);
    if (cleanupReport) {
      log(
        `cleanup: killed ${cleanupReport.killed.length} process(es) [byProfile ${cleanupReport.byProfile.length}, byPort ${cleanupReport.byPort.length}], ` +
        `profile ${cleanupReport.profileRemoved ? 'removed' : `LEFT AT ${cleanupReport.profilePath}`}, ` +
        `endpoint ${cleanupReport.endpointAlive ? 'STILL ALIVE' : 'down'}${cleanupReport.portProbe ? `, port probe ${JSON.stringify(cleanupReport.portProbe)}` : ''}.`,
      );
    }
    if (probes.length) note(`browser probes (not page assets, ignored): ${[...new Set(probes)].join(', ')}`);
  }

  if (driverError) {
    // Loud, never a silent pass: a guard that cannot drive a browser has not
    // verified anything.
    console.error(`\nFAIL: could not complete the measurement — ${driverError}`);
    if (problems.length) {
      console.error('problems recorded during the attempt:');
      for (const p of problems) console.error(`  - ${p}`);
    }
    process.exit(1);
  }
  if (problems.length) {
    console.error('\nFAIL: layout guard found problems:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  log('\nOK: every measured floating box stayed inside the window.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFAIL: unexpected error — ${(err && err.stack) || err}`);
  process.exit(1);
});
