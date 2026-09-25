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
 * It then measures a SEVENTH state the box sweep cannot see: the settings
 * SCREEN in settings mode (`body.settings-mode`, entered from `#settings`).
 * There it asserts four conditions — no intersection between the screen's tab
 * bar and the log card; every tab button drawn with a non-empty label; the
 * container not scrolling unintentionally (`scrollHeight == clientHeight`); and
 * the frame holding its own tab bar and its panels as DIRECT children (siblings,
 * never nested) — plus, for each of the seven tabs, that activating it draws
 * every id the DECLARED map in `src/settingsTabMap.ts` assigns to that tab at
 * `getBoundingClientRect().height > 0`, and that `<main>` (display:none in this
 * mode) holds none of them. Read `runSettingsProbe` for why that state had to
 * exist: nested tab panels passed every other check.
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
const SETTINGS_TAB_MAP_TS = path.join(ROOT, 'src', 'settingsTabMap.ts');

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

/* ── the declared settings-tab map (read from the product source) ──────── */

/**
 * Brace/bracket-match an `Object.freeze({…})` / `Object.freeze([…])` literal
 * that follows `marker`, skipping strings and comments, then evaluate it.
 * Returns null (never throws) when it cannot be recovered.
 */
function extractFrozenLiteral(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const fz = src.indexOf('Object.freeze(', at);
  if (fz < 0) return null;
  let i = src.indexOf('(', fz) + 1;
  while (i < src.length && /\s/.test(src[i])) i++;
  const openCh = src[i];
  if (openCh !== '{' && openCh !== '[') return null;
  const stack = [openCh === '{' ? '}' : ']'];
  let quote = null;
  for (i += 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i); i = end < 0 ? src.length : end + 1; continue; }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack[stack.length - 1] !== c) return null;
      stack.pop();
      if (!stack.length) {
        try {
          // eslint-disable-next-line no-new-func
          return new Function(`return (${src.slice(src.indexOf('(', fz) + 1, i + 1)});`)();
        } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Read the DECLARED settings-tab contract out of `src/settingsTabMap.ts`.
 *
 * The contract has to come from the product source, not from the page: a guard
 * that derives "which tab should hold #max-jobs" from the page can only ever
 * confirm that the page agrees with itself. Returns null when unreadable and
 * the caller turns that into a loud failure.
 */
function loadSettingsTabMap() {
  let src;
  try { src = fs.readFileSync(SETTINGS_TAB_MAP_TS, 'utf8'); } catch { return null; }
  // الأنماط تبدأ بـ`export const`: الاسم وحده يظهر في تعليق الملف قبل تصريحه،
  // فالبحث بالاسم المجرّد يلتقط التعليق ثم يقرأ `Object.freeze(` التالي (وهو
  // خريطة أخرى) ⇒ فشل استخراج كاذب. (وقع فعلاً في أول تشغيل: FAIL عند الإقلاع.)
  const map = extractFrozenLiteral(src, 'export const SETTINGS_TAB_MAP');
  const chrome = extractFrozenLiteral(src, 'export const SETTINGS_MENU_CHROME');
  const outside = extractFrozenLiteral(src, 'export const SETTINGS_OUTSIDE_TABS');
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  if (!Array.isArray(chrome) || !Array.isArray(outside)) return null;
  const ids = Object.keys(map);
  // **بوّابة عدم بطلان لا عدّاد دقيق**: الحدّ فضفاض (٣٥) عن قصد؛ فالعدد الدقيق
  // (٣٩ اليوم) يحرسه `src/__tests__/settingsTabs.test.ts`. ولو ثبّتناه هنا لسقط
  // هذا الحارس عند كل تغيير مشروع في الخريطة — ووقع فعلاً: ٤٠ ⇒ ٣٩ بعد نقل
  // `keep-inst`/`fmt-select` إلى الأسطح المخفيّة المُعلَنة.
  if (ids.length < 35 || chrome.length < 3 || outside.length < 20) return null; // vacuity gate
  if (!outside.every((o) => o && typeof o.id === 'string' && typeof o.why === 'string')) return null;
  return { map, chrome, outside, ids };
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

  // ── **حالة الإعدادات الداخلية** — الحالة التي يفتحها المستخدم فعلاً ─────────
  // العطب الذي وُلدت منه (ميداني، مقيس): الرأس يحمل `.glass-effect` وفيه
  // `backdrop-filter: blur(16px)`، و`backdrop-filter` غير `none` يجعل العنصر
  // **كتلةً حاوية** لـ`position: fixed` بداخله ⇒ فالشاشة (`#settings-menu`، وهي
  // داخل `<header>`) انكمشت إلى **67.2px** عند y=23، ووقع شريط التبويبات (y=154)
  // والحاويات (y=213) **خارجها** فقصّها `overflow:auto` — وكان الحارس يمرّ لأنه
  // يقيس صندوق القائمة بلا `body.settings-mode`، **فلا يرى الحالة التي يفتحها
  // المستخدم**. وهذا ما تُصلحه هذه الكتلة: تُقاس الحالة نفسها في كل عرض واتجاه.
  let settings = null;
  {
    const screen = document.getElementById('settings-menu');
    const tabbar = document.getElementById('settings-tabs');
    if (screen && tabbar) {
      const priorMode = document.body.classList.contains('settings-mode');
      const priorHidden = screen.classList.contains('hidden');
      const panels = Array.from(document.querySelectorAll('.settings-tab-panel'));
      const priorHiddenPanels = panels.map((p) => p.hidden);
      document.body.classList.add('settings-mode');
      screen.classList.remove('hidden');
      const active = panels.find((p) => !p.hidden) || panels[0];
      panels.forEach((p) => { p.hidden = p !== active; });

      const sb = screen.getBoundingClientRect();
      const tb = tabbar.getBoundingClientRect();
      const inside = (c, p) => c.top >= p.top - 1 && c.bottom <= p.bottom + 1 && c.left >= p.left - 1 && c.right <= p.right + 1;
      // ما يرسم فوق شريط التبويبات من خارج الشاشة (‏`#logcard` كان يفعلها).
      const overTabs = [];
      if (tb.width > 4 && tb.height > 4) {
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          if (screen.contains(el)) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 50 || r.height < 8) continue;
          if (!(r.right <= tb.left || r.left >= tb.right || r.bottom <= tb.top || r.top >= tb.bottom)) {
            overTabs.push(el.id || el.tagName.toLowerCase());
          }
        }
      }
      const firstTab = tabbar.querySelector('[data-tab-btn]');
      const ftb = firstTab ? firstTab.getBoundingClientRect() : null;
      settings = {
        screenW: +sb.width.toFixed(1),
        screenH: +sb.height.toFixed(1),
        screenBox: [+sb.left.toFixed(1), +sb.top.toFixed(1), +sb.right.toFixed(1), +sb.bottom.toFixed(1)],
        tabBox: [+tb.left.toFixed(1), +tb.top.toFixed(1), +tb.right.toFixed(1), +tb.bottom.toFixed(1)],
        activeBox: active ? (([c]) => [+c.left.toFixed(1), +c.top.toFixed(1), +c.right.toFixed(1), +c.bottom.toFixed(1)])([active.getBoundingClientRect()]) : null,
        tabH: +tb.height.toFixed(1),
        tabW: +tb.width.toFixed(1),
        tabsInsideScreen: inside(tb, sb),
        activeInsideScreen: active ? inside(active.getBoundingClientRect(), sb) : false,
        firstTabLabel: firstTab ? (firstTab.textContent || '').trim() : '',
        firstTabBox: ftb ? +ftb.height.toFixed(1) : 0,
        elementsOverTabs: overTabs,
        pageScrollable: document.documentElement.scrollHeight > window.innerHeight + 2,
        screenScrolls: screen.scrollHeight > screen.clientHeight + 2,
      };

      // لا تُترك الصفحة في وضع لم تكن فيه (فلا يتأثّر ما بعده).
      panels.forEach((p, i) => { p.hidden = priorHiddenPanels[i]; });
      if (!priorMode) document.body.classList.remove('settings-mode');
      if (priorHidden) screen.classList.add('hidden');
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
      settings,
      rows,
      skipped,
    };
  })();
}

/* ── the seventh state: the settings SCREEN in settings mode ──────────── */

/**
 * `runSettingsProbe` is stringified and evaluated in the page, exactly like
 * `runProbe` — self-contained, no closures.
 *
 * WHY A SEVENTH STATE
 * -------------------
 * Every state `runProbe` measures un-hides `#settings-menu` and measures it as
 * the 256px DROPDOWN it used to be. The screen the owner actually uses —
 * `body.settings-mode`, `position: fixed; inset: 0` — was measured by nothing.
 * That is how a screen whose seven tab panels were NESTED (each one a child of
 * the previous, so activating any tab hid the whole subtree) passed every
 * guard: the boxes were all inside the window, and "the element exists in the
 * DOM" was read as "the tab shows its controls".
 *
 * WHAT IT ASSERTS (the four conditions, plus the per-tab geometry)
 *   (أ) the screen's tab bar and the event-log card do not intersect;
 *   (ب) every one of the seven tab buttons is rendered, > minTabHeight tall,
 *       and carries a non-empty label;
 *   (ج) the container does not scroll unintentionally (scrollHeight == clientHeight);
 *   (د) the frame holds its own bar and its panels: #settings-tabs and every
 *       .settings-tab-panel sit inside #settings-menu, the panels are DIRECT
 *       children (siblings — not nested), and the frame is not a degenerate
 *       strip (this is the 67.2px failure: `backdrop-filter` on <header> makes
 *       it the containing block of `position: fixed`, so `inset: 0` resolved
 *       against the 76.2px header and the screen became a 67.2px band whose
 *       tabs and panels fell OUTSIDE it and were clipped by `overflow: auto`).
 *   (هـ) per tab: activating it leaves exactly one panel shown, that panel has
 *       height > 0, and **every** id the declared map assigns to that tab has
 *       `getBoundingClientRect().height > 0` and its nearest
 *       `.settings-tab-panel` is that tab. Ids suppressed by a *state gate*
 *       strictly below the active panel (`hidden` on `#watch-options` before
 *       watching is on, on `#update-status` before an update check, …) are
 *       revealed for the measurement and restored immediately after; how many
 *       were revealed is reported. An id suppressed by a TAB panel can never be
 *       revealed this way, because the gates considered stop at the active panel.
 *
 * It never fixes anything and never writes to the page except the temporary
 * gate reveal described above, which is restored before the next tab.
 */
function runSettingsProbe(args) {
  return (async () => {
    const { map, tabs, dir, lang, table, minTabHeight, minScreenHeight } = args;
    const problems = [];
    const out = {
      dir, lang, problems, notes: [],
      menuRect: null, tabsBarRect: null, logcardRect: null,
      menuClientHeight: null, menuScrollHeight: null,
      menuTop: null, tabsBarTop: null, drawnTabs: [], perTab: [], mainIds: [],
      revealedByStateGate: [], filledEmptySurfaces: [], panelParents: [],
    };
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return {
        left: +b.left.toFixed(2), top: +b.top.toFixed(2),
        right: +b.right.toFixed(2), bottom: +b.bottom.toFixed(2),
        width: +b.width.toFixed(2), height: +b.height.toFixed(2),
      };
    };
    const intersects = (a, b) =>
      a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const nameOf = (el) => (el.id ? `#${el.id}` : (el.dataset && el.dataset.tab ? `[data-tab=${el.dataset.tab}]` : el.tagName.toLowerCase()));

    document.documentElement.setAttribute('dir', dir);
    document.documentElement.setAttribute('lang', lang);
    if (table) {
      const dict = table[lang] || {};
      document.querySelectorAll('[data-i18n]').forEach((el) => {
        const k = el.getAttribute('data-i18n');
        if (dict[k] !== undefined) el.innerHTML = String(dict[k]);
      });
    }

    if (!document.body.classList.contains('settings-mode')) {
      problems.push('(تمهيد) body.settings-mode غير مفعّلة — الشاشة ليست في وضع الإعدادات، فالقياس كله باطل');
      return out;
    }
    const menu = document.getElementById('settings-menu');
    const tabsBar = document.getElementById('settings-tabs');
    const logcard = document.getElementById('logcard');
    const main = document.querySelector('main');
    if (!menu || !tabsBar) {
      problems.push(`(تمهيد) ${!menu ? '#settings-menu' : '#settings-tabs'} غير موجود في DOM`);
      return out;
    }

    // Deterministic measurement point: entry animations done (.fade-in-up moves
    // the screen 15px for 0.6s), then the rects stop changing.
    try {
      if (document.getAnimations) {
        const anims = document.getAnimations();
        if (anims.length) {
          await Promise.race([
            Promise.allSettled(anims.map((a) => a.finished)).then(() => true),
            sleep(5000),
          ]);
        }
      }
    } catch { /* best-effort */ }
    let prev = null;
    for (let i = 0; i < 40; i++) {
      const snap = [menu, tabsBar, logcard, document.querySelector('.settings-tab-panel:not([hidden])')]
        .map((e) => (e ? JSON.stringify(box(e)) : '-')).join('|');
      if (snap === prev) break;
      prev = snap;
      await sleep(60);
    }

    out.menuRect = box(menu);
    out.tabsBarRect = box(tabsBar);
    out.logcardRect = logcard ? box(logcard) : null;
    out.menuClientHeight = menu.clientHeight;
    out.menuScrollHeight = menu.scrollHeight;
    out.menuTop = out.menuRect.top;
    out.tabsBarTop = out.tabsBarRect.top;

    /* (أ) لا تقاطع بين شريط تبويبات الشاشة وبطاقة سجلّ الأحداث */
    if (out.logcardRect && intersects(out.tabsBarRect, out.logcardRect)) {
      problems.push(
        `(أ) شريط التبويبات يتقاطع مع بطاقة السجلّ: tabs=${JSON.stringify(out.tabsBarRect)} logcard=${JSON.stringify(out.logcardRect)}`,
      );
    }

    /* (ب) تبويب ظاهر: الأزرار السبعة مرسومة بارتفاع كافٍ ونصّ غير فارغ */
    const btns = Array.from(document.querySelectorAll('[data-tab-btn]'));
    out.drawnTabs = btns.map((b) => ({
      tab: b.dataset.tabBtn,
      height: box(b).height,
      display: getComputedStyle(b).display,
      text: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
    }));
    if (btns.length !== tabs.length) {
      problems.push(`(ب) عدد أزرار التبويب ${btns.length} لا ${tabs.length}`);
    }
    const badTabs = out.drawnTabs.filter((t) => t.display === 'none' || t.height <= minTabHeight || !t.text);
    if (badTabs.length) {
      problems.push(
        `(ب) ${badTabs.length} زرّ تبويب غير مرسوم/فارغ: ${badTabs.map((t) => `${t.tab}(h=${t.height},display=${t.display},نصّ="${t.text}")`).join(' · ')}`,
      );
    }

    /* (ج) لا سمرولة غير مقصودة: scrollHeight == clientHeight للحاوية */
    if (out.menuScrollHeight !== out.menuClientHeight) {
      problems.push(
        `(ج) حاوية الشاشة تُمرَّر بلا قصد: scrollHeight=${out.menuScrollHeight} ≠ clientHeight=${out.menuClientHeight}`,
      );
    }

    /* (د) الإطار يحوي شريطه وحاوياته، وليس شريطاً منكمشاً */
    const panels = Array.from(document.querySelectorAll('.settings-tab-panel'));
    out.panelParents = panels.map((p) => ({
      tab: p.dataset.tab || '(بلا data-tab)',
      parent: p.parentElement ? `${p.parentElement.tagName.toLowerCase()}${p.parentElement.id ? '#' + p.parentElement.id : ''}` : '(بلا أب)',
      directChildOfFrame: p.parentElement === menu,
    }));
    const notDirect = out.panelParents.filter((p) => !p.directChildOfFrame);
    if (notDirect.length) {
      problems.push(
        `(د) ${notDirect.length} حاوية تبويب ليست ابناً مباشراً للشاشة (حاويات متداخلة): ` +
        notDirect.map((p) => `${p.tab} داخل ${p.parent}`).join(' · '),
      );
    }
    if (!menu.contains(tabsBar)) problems.push('(د) شريط التبويبات ليس داخل #settings-menu');
    const outsideFrame = panels.filter((p) => !menu.contains(p)).map((p) => p.dataset.tab);
    if (outsideFrame.length) problems.push(`(د) حاويات خارج #settings-menu: ${outsideFrame.join(', ')}`);
    if (out.menuRect.height < minScreenHeight) {
      problems.push(
        `(د) الشاشة شريطٌ منكمش: ارتفاعها ${out.menuRect.height}px < ${minScreenHeight}px ` +
        `(هندسة «67.2px»: كتلة حاوية لـposition:fixed على الرأس أو ما يشبهها)`,
      );
    }
    if (out.tabsBarRect.top < out.menuRect.top - 0.5 || out.tabsBarRect.bottom > out.menuRect.bottom + 0.5) {
      problems.push(
        `(د) شريط التبويبات خارج حدود الشاشة: bar=[${out.tabsBarRect.top}…${out.tabsBarRect.bottom}] frame=[${out.menuRect.top}…${out.menuRect.bottom}]`,
      );
    }

    /* (هـ) الهندسة لكل تبويب: كل معرّف في خريطته بارتفاع > 0 */
    for (const t of tabs) {
      const btn = btns.find((b) => b.dataset.tabBtn === t);
      const ids = Object.keys(map).filter((id) => map[id] === t);
      const entry = { tab: t, ids: ids.length, measured: 0, zero: [], revealed: [], filled: [] };
      if (!btn) {
        problems.push(`(هـ) لا زرّ تبويب «${t}»`);
        out.perTab.push(entry);
        continue;
      }
      btn.click();
      await sleep(60);
      const shown = panels.filter((p) => !p.hidden);
      if (shown.length !== 1 || shown[0].dataset.tab !== t) {
        problems.push(
          `(هـ) تفعيل «${t}»: المعروض ${shown.map((p) => p.dataset.tab).join(',') || 'لا شيء'} — والمطلوب حاوية واحدة باسم التبويب`,
        );
      }
      const panel = document.querySelector(`.settings-tab-panel[data-tab="${t}"]`);
      if (!panel) { problems.push(`(هـ) لا حاوية للتبويب «${t}»`); out.perTab.push(entry); continue; }
      const panelBox = box(panel);
      if (panelBox.height <= 0) {
        problems.push(`(هـ) حاوية «${t}» بارتفاع ${panelBox.height}px بعد تفعيلها ⇒ التبويب فارغ`);
      }
      for (const id of ids) {
        const all = document.querySelectorAll(`#${CSS.escape(id)}`);
        if (all.length !== 1) {
          problems.push(`(هـ) ${id}: ${all.length} نسخة في DOM (المطلوب واحدة)`);
          continue;
        }
        const el = all[0];
        const owner = el.closest('.settings-tab-panel');
        if (!owner || owner.dataset.tab !== t) {
          problems.push(`(هـ) ${id}: داخل «${owner ? owner.dataset.tab : 'لا حاوية تبويب'}» والمتوقَّع «${t}»`);
          continue;
        }
        if (main && main.contains(el)) {
          problems.push(`(هـ) ${id}: داخل <main> وهي display:none في وضع الإعدادات ⇒ لا يُرى`);
          continue;
        }
        // (١) بوّابات الحالة **دون** الحاوية النشطة (لا تُلمس حاوية تبويب أبداً):
        // `hidden` على `#watch-options` قبل تفعيل المراقبة، وعلى `#update-status`
        // قبل أول فحص… تُزال للقياس ثم تُعاد. ولو أُزيلت بوّابة **حاوية تبويب**
        // لكان الحارس يُصلح العطب بيده ويمرّ — ولذلك يتوقف المسح عند `panel`.
        const gates = [];
        for (let p = el; p && p !== panel; p = p.parentElement) {
          if (typeof HTMLElement === 'undefined' || !(p instanceof HTMLElement)) continue;
          if (p.hasAttribute('hidden') || p.classList.contains('hidden')) gates.push(p);
        }
        const savedGates = gates.map((g) => ({ g, attr: g.hasAttribute('hidden'), cls: g.classList.contains('hidden') }));
        for (const { g } of savedGates) { g.removeAttribute('hidden'); g.classList.remove('hidden'); }
        if (savedGates.length) await sleep(0);
        let b = box(el);
        // (٢) **سطح حالة فارغ**: `#cuda-hint-text` · `#watch-path` · `#tg-badge`
        // · `#update-status`… عناصر نصّية يملؤها الكود عند الحالة، فالفارغ منها
        // **ارتفاعه صفر بحق** (لا صندوق لعنصر بلا محتوى) — وهذا ليس عطلاً.
        // فبدل تخفيف الشرط يُكتب فيه محرف قياس مؤقّت: إن ظهر صندوقه فالسطح
        // موجود ويُرسم؛ وإن بقي صفراً فالعطب في الوعاء لا في الفراغ.
        // **وترتيب العمليتين مقصود**: كشف البوّابة أولاً ثم المحرف — وقياسُ
        // المحرف بعد إعادة البوّابة كان يعطي صفراً كاذباً (وقع في أول تشغيل:
        // خمسة معرّفات بقيت 0 لأن أباها أُعيد إلى `hidden` قبل القياس).
        const emptySurface =
          el.children.length === 0 &&
          (el.textContent || '').trim() === '' &&
          !/^(INPUT|SELECT|TEXTAREA|BUTTON|IMG)$/.test(el.tagName);
        let probeNode = null;
        if (b.height <= 0 && emptySurface) {
          probeNode = document.createTextNode('x');
          el.appendChild(probeNode);
          await sleep(0);
          b = box(el);
        }
        if (probeNode) probeNode.remove();
        for (const { g, attr, cls } of savedGates) {
          if (attr) g.setAttribute('hidden', '');
          if (cls) g.classList.add('hidden');
        }
        if (b.height > 0) {
          entry.measured += 1;
          if (savedGates.length) { entry.revealed.push(id); out.revealedByStateGate.push(id); }
          if (probeNode) { entry.filled.push(id); out.filledEmptySurfaces.push(id); }
          continue;
        }
        entry.zero.push(
          `${id}(height=${b.height}` +
          `${savedGates.length ? `، أُظهرت ${savedGates.length} بوّابة حالة` : ''}` +
          `${emptySurface ? '، وكُتب فيه محرف قياس' : ''}` +
          `${!savedGates.length && !emptySurface ? '، وبلا بوّابة حالة ⇒ محجوب بحاوية تبويب' : ''})`,
        );
      }
      out.perTab.push(entry);
      if (entry.zero.length) {
        problems.push(`(هـ) «${t}»: ${entry.zero.length} معرّف بارتفاع صفر — ${entry.zero.join(' · ')}`);
      }
    }

    /* و<main> لا تحوي أي معرّف من الخريطة */
    out.mainIds = main
      ? Object.keys(map).filter((id) => { const el = document.getElementById(id); return el !== null && main.contains(el); })
      : [];
    if (out.mainIds.length) {
      problems.push(`<main> تحوي ${out.mainIds.length} معرّفاً من الخريطة (تختفي معها): ${out.mainIds.join(', ')}`);
    }

    return out;
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

  // العقد المعلَن لتبويبات الإعدادات: يُقرأ من مصدر المنتج لا من الصفحة. بلا
  // خريطة لا يمكن السؤال «هل #max-jobs في تبويبه؟» — والمقارنة بالصفحة نفسها
  // تُصادق على أي ترتيب. فغيابه فشل صريح لا تخطٍّ صامت.
  const tabContract = loadSettingsTabMap();
  if (!tabContract) {
    fatal(
      `cannot read the settings-tab contract from ${SETTINGS_TAB_MAP_TS} ` +
      '(SETTINGS_TAB_MAP / SETTINGS_MENU_CHROME / SETTINGS_OUTSIDE_TABS) — measuring the ' +
      'settings screen without a declared map cannot fail, so this run is refused.',
      1,
    );
  }
  const TAB_NAMES = ['performance', 'watch', 'bridge', 'telegram', 'update', 'about'];

  log('HaramLite layout guard');
  log(`  browser : ${exe}`);
  log(`  dist    : ${DIST}`);
  log(`  windows : ${opts.widths.join(', ')} x ${opts.height}   dirs: ${opts.dirs.join(', ')}`);
  log(`  i18n    : ${i18nNote}`);
  log(`  tabs    : ${tabContract.ids.length} mapped id(s) over ${TAB_NAMES.length} tab(s), read from src/settingsTabMap.ts`);
  if (preScript) log(`  pre-script: ${preScript.length} byte(s) of page JS will run before measurement`);
  log('');

  const { server, origin, notFound, probes } = await startServer();
  let browser = null;
  let cdp = null;
  const allRows = [];
  const settingsStates = [];
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

          // ── **حالة الإعدادات**: أربعة شروط تقيس ما يراه المستخدم ────────────
          // (وهي التي كانت غائبة فمرّ العطب: الشاشة 67.2px والتبويبات خارجها.)
          if (data.settings) {
            const s = data.settings;
            note(
              `settings-mode: screen ${s.screenW}x${s.screenH} ${JSON.stringify(s.screenBox)} · tabs ${s.tabW}x${s.tabH} ${JSON.stringify(s.tabBox)} ` +
              `· active ${JSON.stringify(s.activeBox)} "${s.firstTabLabel}" ` +
              `· inside=${s.tabsInsideScreen}/${s.activeInsideScreen} · over-tabs=[${s.elementsOverTabs.join(', ')}] ` +
              `· pageScroll=${s.pageScrollable} · screenScroll=${s.screenScrolls}`,
            );
            // (د) الحاوية تحوي شريطها وحاويتها النشطة.
            if (!s.tabsInsideScreen) {
              problems.push(
                `${dir}@${width}: شريط تبويبات الشاشة **خارج** حاويتها (الشاشة ${s.screenW}x${s.screenH} · الشريط ${s.tabW}x${s.tabH}) ` +
                '— الصنف المقيس: كتلة حاوية لـ`position:fixed` (‏backdrop-filter على الرأس) أو حاوية بلا ارتفاع',
              );
            }
            if (!s.activeInsideScreen) {
              problems.push(`${dir}@${width}: حاوية التبويب النشطة خارج الشاشة — محتواها مقصوص`);
            }
            // (ب) تبويب ظاهر بارتفاع معقول ونصّه غير فارغ ⇒ «مقروء».
            if (!(s.tabH > 20 && s.firstTabBox > 8 && s.firstTabLabel)) {
              problems.push(
                `${dir}@${width}: تبويب الشاشة غير مقروء (ارتفاع الشريط ${s.tabH}px · أول زرّ ${s.firstTabBox}px · نصّه "${s.firstTabLabel}")`,
              );
            }
            // (أ) لا عنصر من خارج الشاشة يتقاطع مع شريط التبويبات.
            if (s.elementsOverTabs.length) {
              problems.push(
                `${dir}@${width}: عناصر ترسم **فوق** شريط تبويبات الشاشة: ${s.elementsOverTabs.join(', ')} — الشريط مقطوع بصرياً`,
              );
            }
            // (ج) لا سمرولة غير مقصودة (ولا قصّ داخل الشاشة نفسها).
            if (s.pageScrollable) {
              problems.push(`${dir}@${width}: الصفحة تُمرَّر في وضع الإعدادات — سمرولة غير مقصودة`);
            }
            if (s.screenScrolls) {
              note('   ملاحظة: الشاشة تُمرَّر داخلياً (محتواها أطول من مساحتها) — مسموح لا عطب');
            }
          } else {
            problems.push(
              `${dir}@${width}: **لم تُقَس حالة الإعدادات** (لا #settings-menu أو لا #settings-tabs) — ` +
              'فحص لا يقيس الحالة التي يفتحها المستخدم ليس فحصاً',
            );
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

    /* ── الحالة السابعة: **شاشة الإعدادات في وضع الإعدادات فعلاً** ──────────
     * كل حالات الأعلى تقيس `#settings-menu` وهي **منسدلة** 256px (تُزال عنها
     * `hidden` وحدها). أما الوضع الذي يستعمله المالك — `body.settings-mode`
     * و`position: fixed; inset: 0` — فلم يكن يقيسه شيء، وهو الموضع الذي مرّ منه
     * عطب «التبويبات فارغة» وعطب «الشاشة 67.2px». والوضع يُفعَّل من `#settings`
     * (بديل الاختبار المعلَن في `src/settingsScreen.ts`)، لا بحقن صنف. */
    for (const width of opts.widths) {
      for (const dir of opts.dirs) {
        const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        try {
          await cdp.send('Page.enable', {}, sessionId);
          await cdp.send('Runtime.enable', {}, sessionId);
          await cdp.send('Network.enable', {}, sessionId);
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width, height: opts.height, deviceScaleFactor: 1, mobile: false,
          }, sessionId);
          await cdp.send('Network.setBlockedURLs',
            { urls: ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'] }, sessionId);

          const loaded = cdp.once(`${sessionId}:Page.loadEventFired`, opts.timeoutMs);
          await cdp.send('Page.navigate', { url: `${origin}/index.html#settings` }, sessionId);
          await loaded;
          await cdp.send('Runtime.evaluate', {
            expression: 'document.fonts && document.fonts.ready ? document.fonts.ready.then(()=>true) : true',
            awaitPromise: true, returnByValue: true,
          }, sessionId, opts.timeoutMs);
          await sleep(120);

          const probeArgs = {
            map: tabContract.map,
            tabs: TAB_NAMES,
            chrome: tabContract.chrome,
            dir,
            lang: dir === 'rtl' ? 'ar' : 'en',
            table,
            minTabHeight: 20,
            minScreenHeight: 200,
          };
          const res = await cdp.send('Runtime.evaluate', {
            expression: `(${runSettingsProbe.toString()})(${JSON.stringify(probeArgs)})`,
            returnByValue: true,
            awaitPromise: true,
          }, sessionId, opts.timeoutMs);
          if (res.exceptionDetails) {
            throw new Error(`in-page settings probe threw: ${res.exceptionDetails.text} ${JSON.stringify((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || '')}`);
          }
          const data = res.result.value;
          if (!data) throw new Error('in-page settings probe returned nothing');

          settingsStates.push({ width, dir, data });
          log(`── settings screen · ${dir} @ ${width}x${opts.height} ──`);
          log(`   frame #settings-menu  top=${data.menuTop} height=${data.menuRect.height}  clientHeight=${data.menuClientHeight} scrollHeight=${data.menuScrollHeight}`);
          log(`   tabs  #settings-tabs  top=${data.tabsBarTop} height=${data.tabsBarRect.height}`);
          log(`   logcard ${data.logcardRect ? JSON.stringify(data.logcardRect) : '(not in DOM)'}`);
          for (const t of data.perTab) {
            log(`   tab ${t.tab.padEnd(12)} ${String(t.measured).padStart(2)}/${String(t.ids).padStart(2)} drawn` +
              (t.revealed.length ? `  (state gate revealed: ${t.revealed.join(', ')})` : '') +
              (t.filled.length ? `  (empty surface filled for measurement: ${t.filled.join(', ')})` : '') +
              (t.zero.length ? `  ZERO: ${t.zero.join(', ')}` : ''));
          }
          note(`tab buttons drawn: ${data.drawnTabs.map((t) => `${t.tab}(${t.height})`).join(' ')}`);
          if (data.mainIds.length) note(`mapped ids inside <main>: ${data.mainIds.join(', ')}`);

          for (const p of data.problems) problems.push(`settings@${width}/${dir}: ${p}`);
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
    log(JSON.stringify({ ok: !driverError && problems.length === 0, driverError, problems, notFound, probes, cleanup: cleanupReport, rows: allRows, settingsStates }, null, 2));
  } else if (driverError) {
    // عدّ القياس لا يُطبَع حين لم يكتمل القياس: كان «measured 0 floating
    // box(es)» يُطبَع قبل FAIL فيُقرأ كأن الصفحة بلا صناديق (تفسير «صفر صندوق»).
    log('the measurement did not complete — no box counts are reported (zeros here would be an artefact, not a finding).');
  } else {
    const tauriMin = 820;
    if (opts.widths.includes(tauriMin)) log(`tauri minWidth ${tauriMin} was covered.`);
    log(`measured ${allRows.length} floating box(es) across ${opts.widths.length * opts.dirs.length} window state(s).`);
    // الحالة السابعة تُعدّ **وحدها** ولا تُخلط بعدد الحالات الستّ: ذاك الرقم
    // (١٢ صندوقاً) يقيس المنسدلة، وهذا يقيس الشاشة — وخلطهما يجعل الرقمين كذبة.
    if (settingsStates.length) {
      const idsDrawn = settingsStates.reduce((n, s) => n + s.data.perTab.reduce((m, t) => m + t.measured, 0), 0);
      const idsTotal = settingsStates.reduce((n, s) => n + s.data.perTab.reduce((m, t) => m + t.ids, 0), 0);
      const revealed = settingsStates.reduce((n, s) => n + s.data.revealedByStateGate.length, 0);
      const filled = settingsStates.reduce((n, s) => n + s.data.perTab.reduce((m, t) => m + t.filled.length, 0), 0);
      log(
        `settings screen (body.settings-mode): ${settingsStates.length} state(s) measured · ` +
        `${idsDrawn}/${idsTotal} tab-id measurement(s) drawn (height > 0)` +
        (revealed ? `, ${revealed} after revealing a state gate (restored)` : '') +
        (filled ? `, ${filled} empty status surface(s) given a probe character (restored)` : '') +
        ` · frame heights ${settingsStates.map((s) => s.data.menuRect.height).join('/')}` +
        ` · frame top ${settingsStates.map((s) => s.data.menuRect.top).join('/')}`,
      );
    }
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
  log('\nOK: every measured floating box stayed inside the window, and the settings screen held its own tab bar and panels.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFAIL: unexpected error — ${(err && err.stack) || err}`);
  process.exit(1);
});
