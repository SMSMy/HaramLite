#!/usr/bin/env node
/* مولّد SBOM بصيغة CycloneDX JSON — البند د-٦ في خطة 0.2.7.
 *
 * الغرض: أن يستطيع المراجع ربط **الملف المنشور** بقائمة مكوّناته المقيسة، ثم
 * يغذّي بها ماسح ثغرات (osv-scanner). ولهذا فالقاعدة الحاكمة هنا: **لا مكوّن
 * مُخمَّن**. كل مكوّن يأتي من قياس فعلي:
 *
 *   Cargo → `cargo metadata --format-version 1 --locked` (الشجرة المقفلة فعلاً)
 *   Node  → `pnpm-lock.yaml` قسم `packages:` (ما عُزل فعلاً، لا ما طُلب)
 *
 * وتُقابَل الأرقام قبل الكتابة: عدد حزم Cargo من `cargo metadata` يجب أن يساوي
 * عدد كتل `[[package]]` في `Cargo.lock`؛ فإن اختلفا فالشجرة والملف المقفل
 * افترقا، وSBOM يوصف بهما معاً كذب. الحارس يفشل ولا يكتب.
 *
 * لا اعتماديات npm: `node:*` وحده. محلّل YAML مكتوب هنا بالحدّ الأدنى الذي
 * تحتاجه بنية `pnpm-lock.yaml` v9 فقط (لا محلّل عام).
 *
 * يمكن استعماله سكربتاً مستقلاً أو وحدةً (`require`) من `build-info.cjs`.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SPEC_VERSION = '1.5';
const TOOL_NAME = 'haramlite-sbom';
const TOOL_VERSION = '1.0.0';

class SbomError extends Error {}

/* ── أدوات مساعدة ──────────────────────────────────────────────────────── */

function fail(msg) {
  throw new SbomError(msg);
}

/** مسار `cargo`: من PATH، وإلا من موضع التثبيت الافتراضي على ويندوز.
 *  (فخّ بيئي مسجَّل في AGENT.md: الصدفة الجديدة لا تعرف ~/.cargo/bin.) */
function resolveCargo() {
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8', shell: false });
  if (!probe.error && probe.status === 0) return 'cargo';
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    const cand = path.join(process.env.USERPROFILE, '.cargo', 'bin', 'cargo.exe');
    if (fs.existsSync(cand)) {
      const p2 = spawnSync(cand, ['--version'], { encoding: 'utf8' });
      if (!p2.error && p2.status === 0) return cand;
    }
  }
  return null;
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) fail(`تعذّر تشغيل «${bin} ${args.join(' ')}»: ${r.error.message}`);
  return r;
}

/* ── Cargo ─────────────────────────────────────────────────────────────── */

/** الشجرة المقفلة من cargo. ترمي عند أي فشل — لا نسخة جزئية. */
function readCargoGraph(root) {
  const cargo = resolveCargo();
  if (!cargo) {
    fail(
      'لم أجد `cargo` لا في PATH ولا في %USERPROFILE%\\.cargo\\bin.\n' +
        '  SBOM ناقص الصلة أسوأ من لا SBOM: أضف cargo إلى PATH ثم أعد المحاولة.'
    );
  }
  const manifest = path.join(root, 'src-tauri', 'Cargo.toml');
  if (!fs.existsSync(manifest)) fail(`لا أجد ${manifest}`);
  const r = run(cargo, ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifest], {
    cwd: root,
  });
  if (r.status !== 0) {
    fail(
      `فشل \`cargo metadata --locked\` (exit ${r.status}).\n` +
        `  stderr: ${(r.stderr || '').trim().split('\n').slice(0, 5).join('\n          ')}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    fail(`خرج cargo metadata ليس JSON صالحاً: ${e.message}`);
  }
  if (!Array.isArray(parsed.packages)) fail('خرج cargo metadata بلا مصفوفة packages');
  return { packages: parsed.packages, cargoBin: cargo };
}

/** كتل `[[package]]` في Cargo.lock: البصمات وعدد الحزم — قياس ثانٍ مستقلّ
 *  يُقابَل به cargo metadata (قاعدة AGENT.md §2: قياسان أفضل من قياس). */
function readCargoLock(root) {
  const lockPath = path.join(root, 'src-tauri', 'Cargo.lock');
  const text = fs.readFileSync(lockPath, 'utf8');
  const blocks = text.split('[[package]]').slice(1);
  const byKey = new Map();
  for (const b of blocks) {
    const n = b.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const v = b.match(/^\s*version\s*=\s*"([^"]+)"/m);
    const c = b.match(/^\s*checksum\s*=\s*"([^"]+)"/m);
    if (!n || !v) continue;
    byKey.set(`${n[1]}@${v[1]}`, { checksum: c ? c[1] : null });
  }
  return { count: byKey.size, byKey };
}

/* ── Node / pnpm ───────────────────────────────────────────────────────── */

/** محلّل حدّي لقسم `packages:` في pnpm-lock.yaml (v9).
 *  المفاتيح بصيغة `'@scope/name@1.2.3':` بإزاحة سطرين. */
function readPnpmLock(root) {
  const lockPath = path.join(root, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockPath)) return { packages: [], lockfileVersion: null };
  const lines = fs.readFileSync(lockPath, 'utf8').split(/\r?\n/);
  const lv = (lines.find((l) => /^lockfileVersion:/.test(l)) || '').replace(/[^0-9.]/g, '');
  const out = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break; // انتهى القسم
    if (!inPackages) continue;
    const m = line.match(/^ {2}'?(\S.*?)'?:\s*$/);
    if (!m) continue;
    const key = m[1];
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    // لقطات v9 قد تحمل لاحقة أقران `(peer@x)`؛ قسم packages لا يحملها،
    // لكن نُطبّع احتياطاً حتى لا يدخل اسمٌ مشوَّه في SBOM.
    if (!/^\d/.test(version)) continue;
    out.push({ name, version });
  }
  return { packages: out, lockfileVersion: lv };
}

/** رخصة حزمة Node من نسختها المثبّتة فعلاً في مخزن pnpm.
 *  تُعاد `null` إن لم تكن مثبّتة (حزم منصّات أخرى) — ولا تُخترع رخصة. */
function nodeLicense(root, name, version) {
  const dir = path.join(
    root,
    'node_modules',
    '.pnpm',
    `${name.replace(/\//g, '+')}@${version}`,
    'node_modules',
    ...name.split('/'),
    'package.json'
  );
  if (!fs.existsSync(dir)) return { license: null, source: null };
  try {
    const pkg = JSON.parse(fs.readFileSync(dir, 'utf8'));
    let lic = pkg.license;
    if (!lic && Array.isArray(pkg.licenses)) lic = pkg.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean).join(' OR ');
    if (lic && typeof lic === 'object') lic = lic.type || null;
    return { license: typeof lic === 'string' && lic.trim() ? lic.trim() : null, source: 'node_modules package.json' };
  } catch {
    return { license: null, source: null };
  }
}

/* ── الترخيص: SPDX صالح أو اسم حرفي، ولا ثالث ─────────────────────────── */

/** هل النص تعبير SPDX بصيغة صحيحة؟ القياس المهم: ‏Cargo يستعمل صوراً غير
 *  SPDX مثل `MIT/Apache-2.0` (‏35 حزمة هنا) — والشرطة المائلة ليست معاملاً في
 *  SPDX، فإدخالها في `expression` يُنتج SBOM **غير صالح بنيوياً**. تلك تُكتب
 *  `license.name` حرفيةً كما وردت. */
function isSpdxExpression(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const tokens = value.replace(/[()]/g, ' ').trim().split(/\s+/);
  if (!tokens.length) return false;
  let sawId = false;
  for (const t of tokens) {
    if (t === 'AND' || t === 'OR' || t === 'WITH') continue;
    if (/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(t)) {
      sawId = true;
      continue;
    }
    return false; // ‏`MIT/Apache-2.0` و`SEE LICENSE IN ...` تسقط هنا
  }
  return sawId;
}

function licenseEntry(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  return isSpdxExpression(v) ? { expression: v } : { license: { name: v } };
}

/* ── بناء الـSBOM ──────────────────────────────────────────────────────── */

function cargoRef(name, version) {
  return `pkg:cargo/${name}@${version}`;
}
/** ‏purl لمكوّن npm: الاسم ذو النطاق يُرمَّز `%40` (مثال: pkg:npm/%40tauri-apps/api@2.11.1) */
function npmRef(name, version) {
  return `pkg:npm/${name.startsWith('@') ? '%40' + name.slice(1) : name}@${version}`;
}

function buildSbom({ root, appVersion, verifyCounts = true, log = () => {} }) {
  const cargo = readCargoGraph(root);
  const lock = readCargoLock(root);
  const pnpm = readPnpmLock(root);

  log(`  قياس Cargo: cargo metadata=${cargo.packages.length} حزمة · Cargo.lock=${lock.count} كتلة`);
  log(`  قياس Node : pnpm-lock packages=${pnpm.packages.length} حزمة (lockfileVersion ${pnpm.lockfileVersion})`);

  // ── الحارس: لا SBOM بمصدرين متناقضين ──
  if (verifyCounts && cargo.packages.length !== lock.count) {
    fail(
      'تناقض في شجرة Cargo: cargo metadata يرى ' +
        `${cargo.packages.length} حزمة بينما Cargo.lock فيه ${lock.count} كتلة [[package]].\n` +
        '  الشجرة المقفلة والملف المقفل افترقا ⇒ أي SBOM يوصف بهما معاً كذب.\n' +
        '  عالج السبب (`cargo update --locked` أو أعد توليد Cargo.lock) ثم أعد التشغيل.'
    );
  }

  const components = [];

  // ── Cargo ──
  const sortedCargo = [...cargo.packages].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)
  );
  let cargoLicensed = 0;
  for (const p of sortedCargo) {
    const comp = {
      type: p.name === 'haramlite-rs' ? 'application' : 'library',
      'bom-ref': cargoRef(p.name, p.version),
      name: p.name,
      version: p.version,
      purl: cargoRef(p.name, p.version),
      scope: 'required',
    };
    const lic = licenseEntry(p.license);
    if (lic) {
      comp.licenses = [lic];
      cargoLicensed++;
    }
    const cs = lock.byKey.get(`${p.name}@${p.version}`);
    if (cs && cs.checksum && /^[0-9a-f]{64}$/i.test(cs.checksum)) {
      comp.hashes = [{ alg: 'SHA-256', content: cs.checksum.toLowerCase() }];
    }
    if (p.description) comp.description = String(p.description).slice(0, 300);
    components.push(comp);
  }

  // ── Node ──
  const sortedNode = [...pnpm.packages].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)
  );
  let nodeLicensed = 0;
  for (const p of sortedNode) {
    const { license, source } = nodeLicense(root, p.name, p.version);
    const comp = {
      type: 'library',
      'bom-ref': npmRef(p.name, p.version),
      name: p.name,
      version: p.version,
      purl: npmRef(p.name, p.version),
      scope: 'required',
    };
    const lic = licenseEntry(license);
    if (lic) {
      comp.licenses = [lic];
      nodeLicensed++;
    } else {
      // إفصاح لا صمت: الرخصة غير معروفة لأن الحزمة غير مثبّتة على هذا الجهاز.
      comp.properties = [{ name: 'haramlite:license_status', value: 'unknown (package not present in node_modules)' }];
    }
    if (source) comp.properties = [...(comp.properties || []), { name: 'haramlite:license_source', value: source }];
    components.push(comp);
  }

  // بصمة مجموعة المكوّنات: تُثبت أن المجموعة نفسها في كل تشغيل، وإن اختلف
  // serialNumber/timestamp (وهما الوحيدان غير القابلين للتكرار).
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(components.map((c) => [c['bom-ref'], c.licenses || null])))
    .digest('hex');

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: SPEC_VERSION,
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: 'HaramLite', name: TOOL_NAME, version: TOOL_VERSION }],
      component: {
        type: 'application',
        'bom-ref': cargoRef('haramlite-rs', appVersion),
        name: 'haramlite-rs',
        version: appVersion,
        purl: cargoRef('haramlite-rs', appVersion),
        licenses: licenseEntry('MIT') ? [{ license: { id: 'MIT' } }] : undefined,
      },
      properties: [
        { name: 'haramlite:cargo_components', value: String(sortedCargo.length) },
        { name: 'haramlite:node_components', value: String(sortedNode.length) },
        { name: 'haramlite:total_components', value: String(components.length) },
        { name: 'haramlite:cargo_measured_by', value: 'cargo metadata --format-version 1 --locked' },
        { name: 'haramlite:cargo_cross_checked_against', value: `src-tauri/Cargo.lock [[package]] == ${lock.count}` },
        { name: 'haramlite:node_measured_by', value: `pnpm-lock.yaml packages: (lockfileVersion ${pnpm.lockfileVersion})` },
        { name: 'haramlite:components_digest_sha256', value: digest },
        { name: 'haramlite:license_coverage', value: `cargo ${cargoLicensed}/${sortedCargo.length}, node ${nodeLicensed}/${sortedNode.length}` },
        { name: 'haramlite:dependency_edges', value: 'omitted by design (components-only SBOM; see scripts/sbom.cjs header)' },
      ],
    },
    components,
  };

  // إصدار tauri يُقرأ من الشجرة المقفلة نفسها التي بُني منها الـSBOM — لا من
  // regex على ملف آخر، فلا يفترق القياسان. ويُعاد ليستهلكه build-info.cjs
  // بلا تشغيل cargo metadata مرّتين.
  const tauriPkg = cargo.packages.find((p) => p.name === 'tauri');
  const tauriCliPath = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json');
  let tauriCliVersion = null;
  if (fs.existsSync(tauriCliPath)) {
    try {
      tauriCliVersion = JSON.parse(fs.readFileSync(tauriCliPath, 'utf8')).version || null;
    } catch {
      tauriCliVersion = null;
    }
  }

  const counts = {
    cargo: sortedCargo.length,
    node: sortedNode.length,
    total: components.length,
    cargoLockBlocks: lock.count,
    cargoLicensed,
    nodeLicensed,
    componentsDigest: digest,
    lockfileVersion: pnpm.lockfileVersion,
    tauriVersion: tauriPkg ? tauriPkg.version : null,
    tauriCliVersion,
  };
  return { sbom, counts };
}

function writeSbom(sbomPath, sbom) {
  fs.mkdirSync(path.dirname(sbomPath), { recursive: true });
  fs.writeFileSync(sbomPath, JSON.stringify(sbom, null, 2) + '\n', 'utf8');
}

/** يتحقّق من الملف **المكتوب على القرص** (لا من كائن في الذاكرة): يُحلَّل
 *  بـJSON.parse ويُقارَن عدد مكوّناته بالعدد المقيس. */
function verifySbomFile(sbomPath, counts) {
  const raw = fs.readFileSync(sbomPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`الملف المكتوب ${sbomPath} لا يُحلَّل بـJSON.parse: ${e.message}`);
  }
  const problems = [];
  if (parsed.bomFormat !== 'CycloneDX') problems.push(`bomFormat=${parsed.bomFormat} (المتوقّع CycloneDX)`);
  if (!parsed.specVersion) problems.push('specVersion مفقود');
  if (!parsed.metadata || !parsed.metadata.component) problems.push('metadata.component مفقود');
  if (!Array.isArray(parsed.components)) problems.push('components ليست مصفوفة');
  else if (parsed.components.length !== counts.total) {
    problems.push(`عدد components في الملف=${parsed.components.length} والمقيس=${counts.total}`);
  }
  for (const c of parsed.components || []) {
    if (!c.name || !c.version || !c.purl) {
      problems.push(`مكوّن بلا name/version/purl: ${JSON.stringify(c).slice(0, 120)}`);
      break;
    }
  }
  const df = parsed.metadata && parsed.metadata.properties
    ? parsed.metadata.properties.find((p) => p.name === 'haramlite:components_digest_sha256')
    : null;
  if (!df || df.value !== counts.componentsDigest) problems.push('بصمة المكوّنات في الملف لا تطابق المحسوبة');
  if (problems.length) fail('التحقّق من SBOM المكتوب فشل:\n  - ' + problems.join('\n  - '));
  return { components: parsed.components.length, bytes: Buffer.byteLength(raw, 'utf8') };
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const opts = { out: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--check') opts.check = true;
    else fail(`وسيط غير معروف: ${a}`);
  }
  return opts;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const opts = parseArgs(process.argv.slice(2));
  const outDir = opts.out ? path.resolve(root, opts.out) : path.join(root, 'dist', 'release-metadata');
  const sbomPath = path.join(outDir, 'sbom.cdx.json');
  const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

  if (opts.check) {
    const { counts } = buildSbom({ root, appVersion, log: console.log });
    console.log(`  ✓ القياسات متّسقة: cargo=${counts.cargo} (Cargo.lock ${counts.cargoLockBlocks}) · node=${counts.node} · total=${counts.total}`);
    return;
  }

  console.log('  SBOM (CycloneDX ' + SPEC_VERSION + '):');
  const { sbom, counts } = buildSbom({ root, appVersion, log: console.log });
  writeSbom(sbomPath, sbom);
  const v = verifySbomFile(sbomPath, counts);
  console.log(`  ✓ كُتب ${path.relative(root, sbomPath)} — ${v.components} مكوّناً (${v.bytes} بايت) حُلِّل وتحقّق`);
  console.log(`    ترخيص معروف: cargo ${counts.cargoLicensed}/${counts.cargo} · node ${counts.nodeLicensed}/${counts.node}`);
  console.log(`    بصمة المكوّنات: ${counts.componentsDigest.slice(0, 16)}…`);
}

module.exports = { buildSbom, writeSbom, verifySbomFile, readPnpmLock, readCargoLock, isSpdxExpression, licenseEntry, SbomError };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    if (e instanceof SbomError) {
      console.error('✗ ' + e.message);
      process.exit(1);
    }
    throw e;
  }
}
