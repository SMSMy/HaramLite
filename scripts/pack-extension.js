#!/usr/bin/env node
/**
 * Package the browser extension for a store upload.
 *
 * Why this exists (field error, 2026-09-11): the Chrome Web Store rejected the
 * zip with "The `key` field is not allowed in the manifest file". The store
 * assigns an item's id itself, so the `key` we keep in the repo manifest (it
 * pins the id of an UNPACKED build, which is what local development and the
 * desktop bridge use) must not be shipped in the upload.
 *
 * So: the repo keeps the key, the upload drops it. Same for the Firefox-only
 * `browser_specific_settings`, which Chrome does not need.
 *
 * Usage:
 *   node scripts/pack-extension.js [--target chrome|firefox] [--out <path>]
 *
 * No dependencies: the zip is written by hand (deflate + CRC32 from node's zlib),
 * so packaging works on any machine with node and produces a deterministic file.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'browser-extension');
/** Runtime files only — README.md and anything else stays out of the upload. */
const FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'thmanyah-sans-regular.otf', 'thmanyah-sans-medium.otf', 'thmanyah-sans-bold.otf', 'icon16.png',
  'icon48.png',
  'icon128.png',
];

function parseArgs(argv) {
  const out = { target: 'chrome', out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') out.target = String(argv[++i] || 'chrome').toLowerCase();
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  if (!['chrome', 'firefox'].includes(out.target)) {
    console.error(`unknown --target ${out.target} (expected chrome|firefox)`);
    process.exit(2);
  }
  return out;
}

/** CRC32 (zip's checksum — node exposes deflate but not this). */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Minimal, deterministic zip writer (DOS date fixed to 1980-01-01). */
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(EXT_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // The popup shows its own version string (#49: it once showed v1.1.0 while
  // the manifest said 1.1.1). Refuse to pack a build that displays a
  // different number than the one the store will publish.
  const popupHtml = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
  const vm = popupHtml.match(/class="version-tag">v?([^<\s]+)</);
  if (!vm) {
    console.error('pack: no .version-tag found in popup.html');
    process.exit(1);
  }
  if (vm[1] !== manifest.version) {
    console.error(`pack: version mismatch — manifest ${manifest.version} vs popup ${vm[1]}`);
    process.exit(1);
  }

  // Store-compliant manifest: no `key` (the store owns the id) and no
  // Firefox-only block on a Chrome upload.
  delete manifest.key;
  if (args.target === 'chrome') delete manifest.browser_specific_settings;

  const entries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
  ];
  for (const f of FILES) {
    if (f === 'manifest.json') continue;
    entries.push({ name: f, data: fs.readFileSync(path.join(EXT_DIR, f)) });
  }

  /* **`_locales/**` تُشحن كاملة** (تصحيح 2026-09-22): القائمة أعلاه **مسطَّحة** فلا تستطيع
   *  التعبير عن شجرة لغات، وكان المانيفست يستعمل `__MSG_appName__` ⇒ لولا هذا المشي المتكرّر
   *  لَشُحنت حزمة متجر **اسمها `__MSG_appName__`** (وهو عطل صامت لا يراه أحد حتى يقرأه المشتري). */
  const localesDir = path.join(EXT_DIR, '_locales');
  const localeFiles = [];
  if (fs.existsSync(localesDir)) {
    const walk = (dir, prefix) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(abs, rel);
        else localeFiles.push({ name: `_locales/${rel}`, abs });
      }
    };
    walk(localesDir, '');
  }
  for (const f of localeFiles) entries.push({ name: f.name, data: fs.readFileSync(f.abs) });

  /* وكل `__MSG_key__` في المانيفست يجب أن يكون **معرَّفاً** في لغة الافتراض — وإلا فالمتصفّح
   *  يعرض الرمز كما هو. والفشل هنا **بصوت عالٍ** لا تحذيراً. */
  const defaultLocale = manifest.default_locale;
  const msgs = {};
  if (defaultLocale) {
    const p = path.join(localesDir, defaultLocale, 'messages.json');
    if (!fs.existsSync(p)) {
      console.error(`pack: default_locale=${defaultLocale} بلا _locales/${defaultLocale}/messages.json`);
      process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [k, v] of Object.entries(raw)) msgs[k] = v && v.message;
  }
  const msgRefs = [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((m) => m[1]);
  const undefinedRefs = [...new Set(msgRefs)].filter((k) => !msgs[k]);
  if (undefinedRefs.length) {
    console.error('pack: __MSG_ في المانيفست بلا تعريف في لغة الافتراض: ' + undefinedRefs.join(', '));
    process.exit(1);
  }
  /** ما يراه المراجع فعلاً: الرمز مُستبدَلاً برسالة لغة الافتراض. */
  const resolvedName = String(manifest.name).replace(/__MSG_([A-Za-z0-9_@]+)__/g, (_, k) => msgs[k] ?? `__MSG_${k}__`);

  const out =
    args.out ||
    path.join(ROOT, 'src-tauri', 'target', 'store', `HaramLite-Bridge-${manifest.version}-${args.target}.zip`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zip(entries));

  // Report what a reviewer will actually see.
  const drop = ['key', 'browser_specific_settings'].filter((k) => args.target === 'chrome' || k === 'key');
  console.log(`packed ${entries.length} files → ${out}`);
  console.log(`  version:      ${manifest.version}`);
  console.log(`  name:         ${resolvedName}${msgRefs.length ? ` (من _locales/${defaultLocale})` : ''}`);
  if (localeFiles.length) console.log(`  locales:      ${localeFiles.map((f) => f.name).join(', ')}`);
  console.log(`  permissions:  ${(manifest.permissions || []).join(', ')}`);
  console.log(`  host scope:   ${(manifest.content_scripts || []).flatMap((c) => c.matches || []).join(', ')}`);
  console.log(`  stripped:     ${drop.join(', ') || '(nothing)'}`);
  console.log(`  size:         ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
}

main();
