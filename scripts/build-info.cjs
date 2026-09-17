#!/usr/bin/env node
/* إسناد الإصدار: يولّد `build-info.json` (ومعه SBOM) — البند ب-٢ في خطة 0.2.7.
 *
 * الغرض المعلن: أن يستطيع المستخدم أو المراجع **ربط الملف المنشور بمصدره** —
 * التزام · وسم · إصدارات الأدوات · وقت البناء · بصمات الأصول. وهو البديل الرخيص
 * للتوقيع في جانب الإسناد. والقاعدة الحاكمة في هذا المستودع: **لا ادّعاء بلا
 * قياس** — فملف يقول شيئاً غير صحيح أسوأ من عدم وجوده. ولذلك:
 *
 *   • كل حقل مقيس بأمر مذكور في `measured_by`، ولا حقل مُخمَّن.
 *   • ما لم يُقس يُكتب `null` **مع سبب مكتوب** — لا قيمة مخترعة. وعلى هذه الشجرة
 *     ‏`v0.2.7` لم يُوسَم بعد، فـ`git_tag` = null و`git_tag_reason` يشرح لماذا.
 *   • إصدار غير متّسق ⇒ **فشل** لا تمرير: ملف إسناد يحمل إصداراً يخالف المثبّت
 *     والبصمة هو كذب موثَّق. الفحص يحاكي `scripts/verify-versions.cjs` (بوابة
 *     الإصدار) ويسمّي الملفين والقيمتين.
 *
 * **أين يُكتب؟** الافتراضي `dist/release-metadata/` لا جذر المستودع:
 *   1. الغرض أن يُرفَق الملف **مع الإصدار** (`gh release upload`)، لا أن يُشحن
 *      داخل التطبيق ولا أن يُلتزم في المستودع فيتقادم.
 *   2. `dist/` مُتجاهَل في `.gitignore` (سطر 11)، فالتوليد لا يُوسّخ الشجرة؛ ولو
 *      كُتب في الجذر لصار كل تشغيل يُقلب `git_dirty` إلى true — قياس يُفسد نفسه.
 *   ويُغيَّر بـ`--out <dir>` عند الحاجة.
 *
 * التشغيل:
 *   node scripts/build-info.cjs                    # يكتب الاثنين في dist/release-metadata
 *   node scripts/build-info.cjs --out some/dir     # مسار آخر
 *   node scripts/build-info.cjs --assets <dir>     # جذر أصول إضافي (يتكرّر)
 *   node scripts/build-info.cjs --no-sbom          # ‏build-info.json وحده
 *
 * لا اعتماديات npm: `node:*` وحده.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sbomMod = require('./sbom.cjs');

const SCHEMA = 'haramlite.build-info/1';

class BuildInfoError extends Error {}

function fail(msg) {
  throw new BuildInfoError(msg);
}

const root = path.resolve(__dirname, '..');

/* ── 1) الإصدار: قياس + *حارس الاتساق* ─────────────────────────────────── */

/** يقرأ الإصدارات الأربعة بنفس منطق `scripts/verify-versions.cjs` (بوابة
 *  الإصدار المعتمدة) حتى لا يفترق حارسان على الملف نفسه. */
function readVersions() {
  /* عيب مُقاس: قراءة مباشرة بـ`readFileSync` ⇒ ملف إصدار مفقود أو JSON فاسد
     كان يُسقط العملية بـstack trace (`ENOENT`/`SyntaxError`) لا برسالة تسمّي
     الملف. هذه أوّل خطوة في السكربت، فهي أول ما يجب أن يفشل بصوت عالٍ. */
  const readText = (p) => {
    const abs = path.join(root, p);
    if (!fs.existsSync(abs)) {
      fail(`ملف إصدار مفقود: ${p} — لا سبيل لقياس الإصدار ولا لكتابة إسناد صحيح.\n` +
           `     الجذر المقيس: ${root}`);
    }
    return fs.readFileSync(abs, 'utf8');
  };
  const fromJson = (p) => {
    let j;
    try { j = JSON.parse(readText(p)); }
    catch (e) { fail(`ملف إصدار غير صالح (JSON): ${p} — ${e.message}`); }
    if (!j || typeof j.version !== 'string' || !j.version) fail(`ملف إصدار بلا حقل version نصّي: ${p}`);
    return j.version;
  };

  const cargoToml = readText('src-tauri/Cargo.toml').match(/^\s*version\s*=\s*"([^"]+)"/m);

  let cargoLock = null;
  for (const b of readText('src-tauri/Cargo.lock').split('[[package]]')) {
    if (/name\s*=\s*"haramlite-rs"/.test(b)) {
      const m = b.match(/version\s*=\s*"([^"]+)"/);
      if (m) cargoLock = m[1];
    }
  }

  return {
    app: {
      'package.json': fromJson('package.json'),
      'src-tauri/tauri.conf.json': fromJson('src-tauri/tauri.conf.json'),
      'src-tauri/Cargo.toml': cargoToml ? cargoToml[1] : null,
      'src-tauri/Cargo.lock (haramlite-rs)': cargoLock,
    },
    ext: fromJson('browser-extension/manifest.json'),
  };
}

/** حارس الاتساق. يسقط عند أي انحراف — ولا يكتب ملف إسناد متناقضاً. */
function assertVersionsConsistent(v) {
  const problems = [];
  for (const [file, val] of Object.entries(v.app)) {
    if (!val) problems.push(`${file}: لم أستطع قراءة الإصدار (القيمة: ${JSON.stringify(val)})`);
  }
  const uniq = [...new Set(Object.values(v.app).filter(Boolean))];
  if (uniq.length > 1) {
    problems.push(
      'إصدارات التطبيق مختلفة — ملف الإسناد سيحمل إصداراً يخالف ما يُبنى فعلاً:\n' +
        Object.entries(v.app)
          .map(([f, val]) => `      ${f} = ${val}`)
          .join('\n') +
        '\n      وحّدها (‏`pnpm versions:check` يفرض ذلك) ثم أعد التشغيل.'
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(v.ext || '')) {
    problems.push(`browser-extension/manifest.json = ${JSON.stringify(v.ext)} (إصدار غير صالح)`);
  }
  if (problems.length) fail('رفضت توليد ملف الإسناد:\n  - ' + problems.join('\n  - '));
  return { app: uniq[0], ext: v.ext };
}

/* ── 2) git: قياس لا اختراع ────────────────────────────────────────────── */

function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.error) fail(`تعذّر تشغيل git: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    fail(`فشل \`git ${args.join(' ')}\` (exit ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function readGit(outDir) {
  const commit = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });

  // الوسم الدقيق: إن لم يوجد فـnull وسبب مكتوب — لا «أقرب وسم» يُقدَّم كأنه وسم الإصدار.
  const exact = git(['describe', '--tags', '--exact-match', 'HEAD'], { allowFail: true });
  let tag = null;
  let tagReason;
  if (exact.ok) {
    tag = exact.out;
    tagReason = null;
  } else {
    tagReason =
      `\`git describe --tags --exact-match HEAD\` فشل (exit ${exact.status}): ` +
      `${exact.err || exact.out || 'لا مخرج'}\n` +
      `      ⇒ الالتزام ${commit.out.slice(0, 12)} غير موسوم. الإصدار ${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version} ` +
      'لم يُوسَم بعد على هذه الشجرة، فلا يُخترع وسم ولا يُنسب إليها وسم إصدار سابق.';
  }

  // للمعلومة فقط، ومسمّى بما ليس فيه لبس: أقرب وسم سابق + عدد الالتزامات بعده.
  const describe = git(['describe', '--tags', '--always'], { allowFail: true });
  const nearest = git(['describe', '--tags', '--abbrev=0'], { allowFail: true });

  // النظافة: تُقاس **قبل** كتابة مخرجاتنا، وتُستثنى مسارات مخرجاتنا صراحةً حتى
  // لا يُفسد القياسَ ما نكتبه نحن (وإلا صار كل تشغيل يعلن الشجرة متسخة).
  const outRel = path.relative(root, outDir).split(path.sep).join('/');
  const st = git(['status', '--porcelain']);
  const entries = st.out ? st.out.split('\n').filter(Boolean) : [];
  const foreign = entries.filter((line) => {
    const p = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
    if (!outRel || outRel.startsWith('..')) return true;
    return !(p === outRel || p.startsWith(outRel + '/'));
  });

  return {
    commit: commit.out,
    branch: branch.ok ? branch.out : null,
    tag,
    tagReason,
    describe: describe.ok ? describe.out : null,
    nearestTag: nearest.ok ? nearest.out : null,
    dirty: foreign.length > 0,
    dirtyEntries: foreign,
    excludedFromDirty: outRel,
  };
}

/* ── 3) الأدوات ───────────────────────────────────────────────────────── */

function toolVersion(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr || '').trim().split('\n')[0];
}

/* ── 4) بصمات الأصول المنشورة ──────────────────────────────────────────── */

function walk(dir) {
  const out = [];
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) out.push(...walk(full));
    else if (it.isFile()) out.push(full);
  }
  return out;
}

/** بصمات SHA-256 لأصول `bundle/`. إن لم توجد أصول ⇒ مصفوفة فارغة **وسبب
 *  مكتوب** — لا مصفوفة صامتة توهم أن لا أصول في الإصدار. */
function readAssets(assetRoots) {
  const files = [];
  for (const r of assetRoots) {
    if (!fs.existsSync(r)) continue;
    files.push(...walk(r));
  }
  files.sort();
  const assets = files.map((f) => {
    const buf = fs.readFileSync(f);
    // المسار نسبةً إلى الجذر ما دام داخله (الحالة الواقعية: bundle/)، وإلا
    // فالمسار المطلق — مسار يبدأ بـ`../..` لا يدلّ المراجع على ملف.
    let rel = path.relative(root, f).split(path.sep).join('/');
    if (rel.startsWith('..')) rel = f.split(path.sep).join('/');
    return {
      path: rel,
      size_bytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
  });
  let reason = null;
  if (!assets.length) {
    const missing = assetRoots.filter((r) => !fs.existsSync(r));
    reason =
      'لا ملفات في مواضع الأصول المفحوصة ⇒ لا بصمات. ' +
      `المفحوص: ${assetRoots.map((r) => path.relative(root, r) || '.').join(' · ')}. ` +
      (missing.length === assetRoots.length
        ? 'لا مسار منها موجود على هذه الشجرة (لم يُبنَ إصدار هنا)، فالنتيجة «لا أصول» لا «أصول بلا بصمة».'
        : 'المسارات موجودة لكنها فارغة.');
  }
  return { assets, reason, scanned: assetRoots.map((r) => path.relative(root, r) || '.') };
}

/* ── 5) البناء ─────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const opts = { out: null, assets: [], sbom: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    /* عيب مُقاس: `--out` في الآخر بلا قيمة كان يُتجاهل **بصمت** (`argv[++i]`
       يُرجع undefined فيسقط إلى المسار الافتراضي) ⇒ الأمر يعمل ويخرج 0 وقد
       كتب في غير الموضع المطلوب، و`--assets` في الآخر كان يرمي
       `ERR_INVALID_ARG_TYPE` بstack trace. الآن كل علم ذي قيمة يُطالب بها. */
    if (a === '--out' || a === '--assets') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        fail(`العلم ${a} يحتاج قيمة${v === undefined ? '' : ' (وجدت العلم ' + v + ' مكانها)'} — مثال: ` +
             (a === '--out' ? 'node scripts/build-info.cjs --out dist/release-metadata'
                            : 'node scripts/build-info.cjs --assets src-tauri/target/release/bundle'));
      }
      if (a === '--out') opts.out = v; else opts.assets.push(v);
      i++;
    }
    else if (a === '--no-sbom') opts.sbom = false;
    else fail(`وسيط غير معروف: ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = opts.out ? path.resolve(root, opts.out) : path.join(root, 'dist', 'release-metadata');
  const infoPath = path.join(outDir, 'build-info.json');

  console.log('  إسناد الإصدار (ب-٢ · د-٦):');

  // (1) الإصدار + الحارس — أولاً، فهو الأرخص والأخطر.
  const versions = readVersions();
  const unified = assertVersionsConsistent(versions);
  console.log(`    إصدار التطبيق: ${unified.app} (متّسق في ${Object.keys(versions.app).length} ملفات) · الإضافة: ${unified.ext} (دورة مستقلة)`);

  // (2) git — يُقاس قبل أن نكتب شيئاً.
  const g = readGit(outDir);
  console.log(`    git: ${g.commit.slice(0, 12)}${g.branch ? ' (' + g.branch + ')' : ''} · الوسم الدقيق: ${g.tag ?? 'لا يوجد — مسجّل بسبب'} · متسخة: ${g.dirty}`);

  // (3) الأدوات.
  const env = process.env;
  const rustc = toolVersion('rustc', ['--version']);
  const cargoV = toolVersion('cargo', ['--version']);
  if (!rustc) {
    console.log('    تنبيه: `rustc` غير موجود في PATH — سيُسجَّل null مع سبب (فخّ مسجَّل: ~/.cargo/bin).');
  }

  // اتساق إضافي: في CI يجب أن يطابق GITHUB_SHA الالتزام المقيس، وإلا فالإسناد
  // يصف شجرة غير التي بُنيت منها.
  if (env.GITHUB_SHA && env.GITHUB_SHA !== g.commit) {
    fail(
      'رفضت توليد ملف الإسناد:\n' +
        `  - GITHUB_SHA = ${env.GITHUB_SHA}\n` +
        `    git rev-parse HEAD = ${g.commit}\n` +
        '      البيئة تبني من التزام مخالف لما أقيسه ⇒ الإسناد سيشير إلى غير مصدره.'
    );
  }

  // (4) الأصول.
  const assetRoots = [
    path.join(root, 'src-tauri', 'target', 'release', 'bundle'),
    ...opts.assets.map((a) => path.resolve(root, a)),
  ];
  const assetInfo = readAssets(assetRoots);
  console.log(`    الأصول: ${assetInfo.assets.length} ملفاً مبصوماً${assetInfo.assets.length ? '' : ' (لا وجود لها — مسجّل بسبب)'}`);

  // (5) SBOM.
  let sbomInfo = { generated: false, reason: 'معطَّل بـ--no-sbom' };
  let tauriVersion = null;
  let tauriCli = null;
  if (opts.sbom) {
    console.log('  SBOM:');
    const { sbom, counts } = sbomMod.buildSbom({ root, appVersion: unified.app, log: console.log });
    const sbomPath = path.join(outDir, 'sbom.cdx.json');
    sbomMod.writeSbom(sbomPath, sbom);
    const v = sbomMod.verifySbomFile(sbomPath, counts);
    const raw = fs.readFileSync(sbomPath);
    sbomInfo = {
      generated: true,
      file: path.relative(root, sbomPath).split(path.sep).join('/'),
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      components: { cargo: counts.cargo, node: counts.node, total: counts.total },
      cross_checks: {
        cargo_metadata_vs_cargo_lock: `${counts.cargo} == ${counts.cargoLockBlocks}`,
        components_in_file_vs_measured: `${v.components} == ${counts.total}`,
        components_digest_sha256: counts.componentsDigest,
      },
      license_coverage: { cargo: counts.cargoLicensed, node: counts.nodeLicensed },
      components_digest_sha256: counts.componentsDigest,
    };
    tauriVersion = counts.tauriVersion ?? null;
    tauriCli = counts.tauriCliVersion ?? null;
    console.log(`  ✓ كُتب ${sbomInfo.file} — ${v.components} مكوّناً (تحقّق: ${JSON.stringify(sbomInfo.cross_checks.components_in_file_vs_measured)})`);
  }

  // إن امتنع SBOM (--no-sbom) يبقى إصدار tauri مقيساً من الشجرة المقفلة نفسها.
  if (tauriVersion == null || tauriCli == null) {
    const j = spawnSync('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml')], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (j.status === 0) {
      try {
        const p = JSON.parse(j.stdout).packages.find((x) => x.name === 'tauri');
        tauriVersion = p ? p.version : null;
      } catch {
        tauriVersion = null;
      }
    }
    if (tauriCli == null) {
      const tauriCliPkg = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json');
      if (fs.existsSync(tauriCliPkg)) {
        try {
          tauriCli = JSON.parse(fs.readFileSync(tauriCliPkg, 'utf8')).version || null;
        } catch {
          tauriCli = null;
        }
      }
    }
  }

  // (6) الملف.
  const info = {
    schema: SCHEMA,
    version: unified.app,

    git_commit: g.commit,
    git_tag: g.tag,
    git_tag_reason: g.tagReason,
    git_dirty: g.dirty,
    git_dirty_entries: g.dirtyEntries,
    git_branch: g.branch,
    git_describe: g.describe,
    git_nearest_tag: g.nearestTag,

    rust_version: rustc,
    cargo_version: cargoV,
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    tauri_version: tauriVersion,
    tauri_cli_version: tauriCli,

    app_version_ext: unified.ext,
    app_version_ext_source: 'browser-extension/manifest.json',
    app_version_ext_release_cycle: 'independent',
    app_version_sources: versions.app,

    built_at_utc: new Date().toISOString(),

    ci_run_id: env.GITHUB_RUN_ID || null,
    ci_run_id_reason: env.GITHUB_RUN_ID
      ? null
      : 'لا GITHUB_RUN_ID في البيئة ⇒ بناء محلي (أو بيئة CI غير GitHub Actions)، فالبناء غير منسوب إلى تشغيل آلي.',
    ci: env.GITHUB_ACTIONS
      ? {
          provider: 'github-actions',
          run_id: env.GITHUB_RUN_ID || null,
          run_attempt: env.GITHUB_RUN_ATTEMPT || null,
          workflow: env.GITHUB_WORKFLOW || null,
          repository: env.GITHUB_REPOSITORY || null,
          ref: env.GITHUB_REF || null,
          sha: env.GITHUB_SHA || null,
        }
      : null,

    assets: assetInfo.assets,
    assets_reason: assetInfo.reason,
    assets_scanned_paths: assetInfo.scanned,

    sbom: sbomInfo,

    measured_by: {
      version: 'package.json (مقابَل بثلاثة ملفات + حارس اتساق)',
      git_commit: 'git rev-parse HEAD',
      git_tag: 'git describe --tags --exact-match HEAD',
      git_dirty: 'git status --porcelain (تُستثنى مسارات المخرجات)',
      rust_version: 'rustc --version',
      cargo_version: 'cargo --version',
      node_version: 'process.version (Node نفسه الذي شغّل السكربت)',
      tauri_version: 'cargo metadata --format-version 1 --locked → packages[name=tauri]',
      tauri_cli_version: 'node_modules/@tauri-apps/cli/package.json',
      app_version_ext: 'browser-extension/manifest.json',
      assets: 'SHA-256 على ملفات bundle/',
      sbom: 'scripts/sbom.cjs — cargo metadata + pnpm-lock.yaml',
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2) + '\n', 'utf8');

  // التحقّق من الملف **المكتوب** لا من كائن في الذاكرة.
  const back = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  const head = git(['rev-parse', 'HEAD']).out;
  if (back.git_commit !== head) fail(`الملف المكتوب يحمل git_commit=${back.git_commit} وHEAD=${head}`);
  if (back.version !== versions.app['package.json']) fail('الملف المكتوب يخالف إصدار package.json');
  if (!back.built_at_utc || Number.isNaN(Date.parse(back.built_at_utc))) fail('built_at_utc غير صالح');

  console.log(`  ✓ كُتب ${path.relative(root, infoPath).split(path.sep).join('/')} — يُحلَّل، وgit_commit مطابق لـHEAD (${head.slice(0, 12)})`);
}

module.exports = { readVersions, assertVersionsConsistent };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    if (e instanceof BuildInfoError || e instanceof sbomMod.SbomError) {
      console.error('✗ ' + e.message);
      process.exit(1);
    }
    throw e;
  }
}
