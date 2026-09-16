#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// fetch-resources.cjs — بند 0.2.7 و-٨: جالب الموارد المحلية للمطوّر.
//
// Why: `bin/` and `models/` are gitignored, so a fresh clone cannot run
// `cargo test` (the tests need `bin/` and `models/`) nor build the app until
// someone copies four large files by hand (docs/CONTRIBUTING.md §الملفات
// المستثناة). This script is that step, automated and *verified*.
//
// Trust model — the fingerprint comes from the SOURCE, never from the network:
//   • the four core assets are read at runtime from `src-tauri/src/repair.rs`
//     → `pub const COMPONENTS` → fields `key`, `asset`, `local`, `sha256`,
//       `subdir` (the same compile-time anchor the in-app repair wizard and
//       release CI trust: و-٣, `download_and_verify`).
//   • the 16 CUDA DLLs are read at runtime from `src-tauri/src/cuda_runtime.rs`
//     → `pub const CUDA_FILES` (names) and `pub const CUDA_FILE_SHA256`
//       (name, sha256) pairs — و-٢ pins them in the binary *because* the
//       remote `cuda-runtime-manifest.json` is self-describing and therefore
//       NOT a trust anchor. The manifest is fetched only for names/URLs and is
//       cross-checked against the pins; a manifest that disagrees is refused.
// Reading the pins from the Rust source (instead of copying them here) means
// this script cannot silently drift from what the shipped binary enforces.
//
// Writes ONLY into `<repo>/bin/` and `<repo>/models/`. No npm dependencies —
// Node standard library only.
//
// Usage:  node scripts/fetch-resources.cjs [options]
//   --verify-only     تحقّق من الملفات الموجودة بلا أي تنزيل (للمطوّر وللبوابة)
//   --cuda            اجلب أيضاً مكتبات CUDA الست عشرة (~2.3GB) — ثقيل، اختياري
//   --list            اطبع ما سيُجلب ثم اخرج (بلا شبكة)
//   --only=<names>    اقتصر على أصول بعينها (key أو اسم محلي أو اسم الأصل)، بفواصل
//   --force           أعد التنزيل حتى لو كان الملف موجوداً (لإصلاح ملف تالف)
//   --help, -h        هذه الرسالة
//
// Exit code: 0 = كل ما طُلب موجود ومطابق · 1 = أي فشل (نزول/تحقّق/استعمال).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// ── Constants (mirrors src-tauri/src/repair.rs & .github/workflows/ci.yml) ───
const REPO = 'SMSMy/HaramLite';
const TAG = 'assets-v1';
const ASSET_BASE = `https://github.com/${REPO}/releases/download/${TAG}`;
// Direct release URL by design: `gh` is NOT assumed to exist (release CI uses
// it, a dev machine may not). GitHub answers this URL with a 302 to the asset
// host, which httpGet() follows — no CLI, no token, no npm package.
const ROOT = path.resolve(__dirname, '..');
const REPAIR_RS = path.join(ROOT, 'src-tauri', 'src', 'repair.rs');
const CUDA_RS = path.join(ROOT, 'src-tauri', 'src', 'cuda_runtime.rs');
const USER_AGENT = 'HaramLite-fetch-resources/0.2';
const SHA_RE = /^[0-9a-f]{64}$/;
// Mirror of cuda_runtime.rs::asset_name_ok — every name we join onto bin/ must
// be a bare filename, so a hostile manifest can never escape bin/ or models/.
const SAFE_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const ALLOWED_SUBDIRS = new Set(['bin', 'models']);
const REDIRECTS = 5;

// ── CLI ─────────────────────────────────────────────────────────────────────
const USAGE = `الاستعمال: node scripts/fetch-resources.cjs [خيارات]

  --verify-only     تحقّق من الملفات الموجودة بلا تنزيل
  --cuda            اجلب أيضاً مكتبات CUDA الست عشرة (~2.3GB)
  --list            اطبع ما سيُجلب ثم اخرج (بلا شبكة)
  --only=<names>    اقتصر على أصول بعينها (key أو اسم محلي أو اسم الأصل)
  --force           أعد التنزيل حتى لو كان الملف موجوداً
  --help, -h        هذه الرسالة`;

function parseArgs(argv) {
  const opts = { verifyOnly: false, cuda: false, list: false, force: false, help: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    let value = eq === -1 ? null : raw.slice(eq + 1);
    if (value === null && (name === '--only') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[++i];
    }
    switch (name) {
      case '--verify-only': opts.verifyOnly = true; break;
      case '--cuda': opts.cuda = true; break;
      case '--list': opts.list = true; break;
      case '--force': opts.force = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--only':
        if (!value) usageError('--only يحتاج قيمة، مثال: --only=yt-dlp');
        opts.only = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (opts.only.length === 0) usageError('--only يحتاج قيمة غير فارغة');
        break;
      default:
        usageError(`خيار غير معروف: ${raw}`);
    }
  }
  return opts;
}

function usageError(msg) {
  console.error(`✖ ${msg}\n\n${USAGE}`);
  process.exit(1);
}

// ── Reading the pinned fingerprints out of the Rust source ──────────────────
function sliceConst(source, decl) {
  const start = source.indexOf(decl);
  if (start === -1) fail(`لم أجد «${decl}» — هل تغيّر اسم الثابت في الكود؟`);
  const end = source.indexOf('\n];', start);
  if (end === -1) fail(`لم أجد نهاية المصفوفة بعد «${decl}»`);
  return source.slice(start, end);
}

function field(block, name) {
  const m = new RegExp(`\\b${name}\\s*:\\s*"([^"]*)"`).exec(block);
  return m ? m[1] : null;
}

/** The four core assets: repair.rs → COMPONENTS (fields key/asset/local/sha256/subdir). */
function readComponents() {
  const src = fs.readFileSync(REPAIR_RS, 'utf8');
  const block = sliceConst(src, 'pub const COMPONENTS');
  const comps = [];
  for (const m of block.matchAll(/Component\s*\{([\s\S]*?)\}/g)) {
    const body = m[1];
    const c = {
      key: field(body, 'key'),
      asset: field(body, 'asset'),
      local: field(body, 'local'),
      sha256: field(body, 'sha256'),
      subdir: field(body, 'subdir'),
    };
    for (const [k, v] of Object.entries(c)) {
      if (!v) fail(`COMPONENTS (${REPAIR_RS}): حقل «${k}» ناقص أو غير مقروء`);
    }
    comps.push(c);
  }
  if (comps.length === 0) fail(`لم أقرأ أي مكوّن من ${REPAIR_RS}`);
  return comps;
}

/** The 16 CUDA names + pinned digests: cuda_runtime.rs → CUDA_FILES / CUDA_FILE_SHA256. */
function readCudaPins() {
  const src = fs.readFileSync(CUDA_RS, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const names = [...sliceConst(src, 'pub const CUDA_FILES').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const pins = new Map();
  for (const m of sliceConst(src, 'pub const CUDA_FILE_SHA256').matchAll(
    /\(\s*"([^"]+)"\s*,\s*"([0-9a-f]{64})"\s*,?\s*\)/g,
  )) {
    pins.set(m[1], m[2]);
  }
  return { names, pins };
}

/** Sanity-check the parsed pins before anything touches the disk. */
function validatePins(components, cuda) {
  for (const c of components) {
    if (!SHA_RE.test(c.sha256)) fail(`بصمة ${c.key} في ${REPAIR_RS} ليست SHA-256 سداسية عشرية`);
    if (!ALLOWED_SUBDIRS.has(c.subdir)) fail(`مجلد ${c.key} غير مسموح: ${c.subdir} (المسموح bin|models)`);
    if (!SAFE_NAME_RE.test(c.local) || !SAFE_NAME_RE.test(c.asset)) fail(`اسم غير آمن في ${c.key}`);
  }
  for (const n of cuda.names) {
    if (!SAFE_NAME_RE.test(n)) fail(`اسم CUDA غير آمن: ${n}`);
  }
  if (cuda.names.length !== cuda.pins.size) {
    fail(`CUDA_FILES (${cuda.names.length}) و CUDA_FILE_SHA256 (${cuda.pins.size}) غير متطابقين — راجع ${CUDA_RS}`);
  }
  const dupes = new Set();
  for (const c of components) {
    if (dupes.has(c.sha256)) fail(`بصمة مكرّرة في COMPONENTS: ${c.sha256}`);
    dupes.add(c.sha256);
  }
}

// ── Filesystem + hashing ────────────────────────────────────────────────────
function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function targetPath(subdir, local) {
  const dest = path.join(ROOT, subdir, local);
  const rel = path.relative(ROOT, dest);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail(`مسار خارج المستودع مرفوض: ${dest}`);
  if (!ALLOWED_SUBDIRS.has(path.dirname(rel).split(path.sep)[0])) fail(`مسار خارج bin/ أو models/ مرفوض: ${dest}`);
  return dest;
}

// ── HTTP (node:https, manual redirects — GitHub release → objects host) ─────
function httpGet(url, redirectsLeft = REDIRECTS) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) { reject(new Error('تحويلات كثيرة جداً (redirects)')); return; }
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        httpGet(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} من ${url}`));
        return;
      }
      resolve(res);
    }).on('error', (err) => reject(new Error(`شبكة: ${err.message} (${url})`)));
  });
}

function httpGetText(url) {
  return httpGet(url).then((res) => new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  }));
}

/**
 * Stream `url` into `<dest>.download` hashing as it goes, verify SHA-256, then
 * promote atomically. A partial or mismatching file NEVER becomes `dest` and is
 * deleted — the same invariant as repair.rs::download_and_verify (و-٣).
 */
async function downloadVerified(url, dest, expectSha, label) {
  const tmp = `${dest}.download`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let received = 0;
  let seen = 0;
  const cleanTmp = () => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } };
  try {
    const res = await httpGet(url);
    const total = Number(res.headers['content-length'] ?? 0);
    const hash = crypto.createHash('sha256');
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct >= seen + 25) { seen = pct - (pct % 25); console.log(`    … ${seen}% (${received}/${total} bytes)`); }
        }
        cb(null, chunk);
      },
    });
    await pipeline(res, meter, fs.createWriteStream(tmp));
    const actual = hash.digest('hex');
    if (actual !== expectSha) {
      cleanTmp();
      throw new Error(
        `بصمة ${label} لا تطابق المثبَّت (SHA-256)\n`
        + `    المتوقَّع: ${expectSha}\n`
        + `    المقروء:  ${actual}\n`
        + `    الحجم:    ${received} bytes — حُذف الملف الجزئي، ولم يُعتمد شيء`,
      );
    }
    fs.renameSync(tmp, dest); // atomic promote
    return { sha256: actual, size: received };
  } catch (err) {
    cleanTmp();
    throw err;
  }
}

// ── Core: fetch (or verify) the four repair.rs components ───────────────────
function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

async function handleComponent(c, opts, results) {
  const dest = targetPath(c.subdir, c.local);
  const relPath = rel(dest);
  const exists = fs.existsSync(dest);
  // --verify-only never writes, so --force cannot override it: with both set we
  // still verify the file that is there instead of claiming it is missing.
  if (exists && (!opts.force || opts.verifyOnly)) {
    const actual = await sha256File(dest);
    const size = fs.statSync(dest).size;
    if (actual === c.sha256) {
      console.log(`✔ ${relPath} — موجود ومطابق · ${size} bytes · sha256 ${actual}`);
      results.ok.push({ label: relPath, size, sha256: actual, action: 'موجود ومطابق' });
      return;
    }
    results.bad.push(relPath);
    console.error(
      `✖ ${relPath} — بصمة SHA-256 لا تطابق المثبَّت\n`
      + `    المتوقَّع: ${c.sha256}\n`
      + `    المقروء:  ${actual}\n`
      + `    الحجم:    ${size} bytes\n`
      + `    الملف الموجود لم يُلمس. للإصلاح: node scripts/fetch-resources.cjs --force --only=${c.key}`,
    );
    return;
  }
  if (opts.verifyOnly) {
    results.bad.push(relPath);
    console.error(`✖ ${relPath} — مفقود (المتوقَّع sha256 ${c.sha256})`);
    return;
  }
  const url = `${ASSET_BASE}/${c.asset}`;
  console.log(`↓ ${c.asset} → ${relPath}`);
  try {
    const { sha256, size } = await downloadVerified(url, dest, c.sha256, `${c.asset} → ${relPath}`);
    console.log(`✔ ${relPath} — نُزّل وتحقّق · ${size} bytes · sha256 ${sha256}`);
    results.ok.push({ label: relPath, size, sha256, action: 'نُزّل وتحقّق' });
  } catch (err) {
    results.bad.push(relPath);
    console.error(`✖ فشل جلب ${relPath}\n    من: ${url}\n    ${err.message}`);
  }
}

// ── Optional: CUDA runtime (16 DLLs, ~2.3GB) ────────────────────────────────
async function fetchCudaManifest(pins) {
  const url = `${ASSET_BASE}/cuda-runtime-manifest.json`;
  console.log(`↓ cuda-runtime-manifest.json (للأسماء والروابط فقط — البصمات من ${rel(CUDA_RS)})`);
  let parsed;
  try {
    parsed = JSON.parse(await httpGetText(url));
  } catch (err) {
    fail(`تعذّر جلب/قراءة منفست CUDA من ${url}\n    ${err.message}\n    (‏--cuda يحتاج المنفست للأسماء؛ والبصمات تبقى من الكود)`);
  }
  const files = Array.isArray(parsed?.files) ? parsed.files : null;
  if (!files) fail('منفست CUDA لا يحوي مصفوفة files');
  const listed = new Set();
  for (const f of files) {
    const name = f?.name;
    if (typeof name !== 'string' || !SAFE_NAME_RE.test(name)) fail(`اسم غير آمن في منفست CUDA: ${JSON.stringify(name)}`);
    const pinned = pins.pins.get(name);
    if (!pinned) fail(`منفست CUDA يذكر ${name} وهو ليس من الستة عشر المثبَّتة في ${rel(CUDA_RS)} — أُلغيت العملية`);
    if (String(f.sha256).toLowerCase() !== pinned) {
      fail(`منفست CUDA يخالف البصمة المثبَّتة في التنفيذي لـ${name}\n`
        + `    في الكود:    ${pinned}\n`
        + `    في المنفست:  ${f.sha256}\n`
        + `    المنفست ليس مرساة ثقة (و-٢) — أُلغيت العملية`);
    }
    listed.add(name);
  }
  for (const n of pins.names) {
    if (!listed.has(n)) fail(`منفست CUDA لا يذكر ${n} — الستة عشر غير مكتملة، أُلغيت العملية`);
  }
  console.log(`✔ المنفست مطابق للبصمات المثبَّتة في الكود (${listed.size} ملفاً)`);
  return [...listed].sort();
}

async function handleCuda(names, pins, opts, results) {
  if (names.length > 1) {
    console.log(`ℹ جلب CUDA: ${names.length} ملفاً (~2.3GB للمجموعة الكاملة) — ثقيل، قد يستغرق دقائق`);
  }
  for (const name of names) {
    const dest = targetPath('bin', name);
    const expect = pins.pins.get(name);
    const relPath = rel(dest);
    const exists = fs.existsSync(dest);
    if (exists && (!opts.force || opts.verifyOnly)) {
      const actual = await sha256File(dest);
      const size = fs.statSync(dest).size;
      if (actual === expect) {
        console.log(`✔ ${relPath} — موجود ومطابق · ${size} bytes · sha256 ${actual}`);
        results.ok.push({ label: relPath, size, sha256: actual, action: 'موجود ومطابق' });
      } else {
        results.bad.push(relPath);
        console.error(`✖ ${relPath} — بصمة SHA-256 لا تطابق المثبَّت\n    المتوقَّع: ${expect}\n    المقروء:  ${actual}\n    الحجم:    ${size} bytes`);
      }
      continue;
    }
    if (opts.verifyOnly) {
      results.bad.push(relPath);
      console.error(`✖ ${relPath} — مفقود (المتوقَّع sha256 ${expect})`);
      continue;
    }
    console.log(`↓ ${name} → ${relPath}`);
    try {
      const { sha256, size } = await downloadVerified(`${ASSET_BASE}/${name}`, dest, expect, `${name} → ${relPath}`);
      console.log(`✔ ${relPath} — نُزّل وتحقّق · ${size} bytes · sha256 ${sha256}`);
      results.ok.push({ label: relPath, size, sha256, action: 'نُزّل وتحقّق' });
    } catch (err) {
      results.bad.push(relPath);
      console.error(`✖ فشل جلب ${relPath}\n    ${err.message}`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────
/** Names accepted by --only: core key/local/asset, plus CUDA filenames under --cuda. */
function validateOnly(only, components, cudaNames) {
  if (!only) return;
  const core = components.flatMap((c) => [c.key, c.local, c.asset]).map((s) => s.toLowerCase());
  const known = new Set([...core, ...cudaNames.map((n) => n.toLowerCase())]);
  for (const want of only) {
    if (!known.has(want)) {
      fail(`--only=${want} لا يطابق أي أصل معروف\n`
        + `    الأصول الأربعة: ${components.map((c) => c.key).join(', ')}\n`
        + `    وأسماء CUDA تمرّ مع --cuda فقط (${cudaNames.length} اسماً)`);
    }
  }
}

function selectComponents(components, only) {
  if (!only) return components;
  return components.filter((c) => only.includes(c.key.toLowerCase())
    || only.includes(c.local.toLowerCase()) || only.includes(c.asset.toLowerCase()));
}

function selectCuda(names, only) {
  if (!only) return names;
  return names.filter((n) => only.includes(n.toLowerCase()));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }

  // Source of truth must exist before we claim to verify anything.
  for (const f of [REPAIR_RS, CUDA_RS]) {
    if (!fs.existsSync(f)) fail(`لم أجد ${f} — شغّل السكربت من داخل المستودع`);
  }
  const components = readComponents();
  const cuda = readCudaPins();
  validatePins(components, cuda);
  console.log(`ℹ البصمات: ${components.length} من ${rel(REPAIR_RS)} (COMPONENTS: key/asset/local/sha256/subdir)`
    + ` · ${cuda.pins.size} من ${rel(CUDA_RS)} (CUDA_FILES + CUDA_FILE_SHA256)`);

  const picked = selectComponents(components, opts.only);
  const cudaNames = opts.cuda ? selectCuda(cuda.names, opts.only) : [];
  validateOnly(opts.only, components, opts.cuda ? cuda.names : []);

  if (opts.list) {
    console.log(`\nسيُجلب من ${REPO}@${TAG} (${ASSET_BASE}/<name>):`);
    for (const c of picked) console.log(`  [core] ${c.asset}  →  ${c.subdir}/${c.local}`);
    for (const n of cudaNames) console.log(`  [cuda] ${n}  →  bin/${n}`);
    if (!opts.cuda) console.log('  (CUDA الستة عشر مستثناة — أضف --cuda لجلبها، ~2.3GB)');
    console.log(`\nالإجمالي: ${picked.length + cudaNames.length} أصلاً · الوضع: ${opts.verifyOnly ? 'تحقّق فقط' : 'جلب + تحقّق'}`);
    return;
  }

  const results = { ok: [], bad: [] };
  for (const c of picked) await handleComponent(c, opts, results);
  if (opts.cuda) await handleCuda(cudaNames, cuda, opts, results);
  else if (!opts.only) console.log('ℹ CUDA الستة عشر لم تُطلب (--cuda للجلب الاختياري، ~2.3GB)');

  const total = results.ok.reduce((n, r) => n + r.size, 0);
  console.log(`\n── الخلاصة: ${results.ok.length} سليماً (${total} bytes) · ${results.bad.length} فاشلاً`
    + ` · الوضع: ${opts.verifyOnly ? 'تحقّق فقط' : 'جلب + تحقّق'}`);
  if (results.bad.length > 0) {
    console.error(`✖ فشل: ${results.bad.join(' · ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`✖ ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
