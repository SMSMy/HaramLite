#!/usr/bin/env node
/* حارس تكافؤ أصول الإصدار — البند ن-٥ في خطة 0.2.9 §١١.
 *
 * **العطل المقيس**: `v0.2.7` نُشرت بـ**٥** أصول (`HaramLite_0.2.7_x64-setup.exe` ·
 * `HaramLite_0.2.7_x64_en-US.msi` · `SHA256SUMS.txt` · `build-info.json` ·
 * `sbom.cdx.json`) و`v0.2.8` بـ**٣** فقط — قياسٌ مباشر بـ`gh release view --json
 * assets` في 2026-09-21. والسبب أن هذين الملفين كانا يُرفعان **يدوياً** من جهاز
 * المالك (`docs/CONTRIBUTING.md` §إصدار جديد · خطوة ٩ وما بعدها)، فلا يفرضهما
 * السير ولا يلاحظ غيابهما شيء. والنتيجة: ملف إسناد ناقص، وموقع/README يشيران إلى
 * `releases/latest/download/SHA256SUMS.txt` وهو منشور بلا ضامن.
 *
 * **وما يقيسه هذا الحارس**: يقرأ **ما يرفعه `release.yml` فعلاً** ويقابله بالمطلوب
 * **٥** — ولكل دور مصدره المُعلَن، لا تخميناً:
 *
 *   · **المثبّتان** (NSIS `-setup.exe` و MSI): من خطوة `tauri-apps/tauri-action`
 *     في السير (شرط: ليست مسودّة) **مع** `bundle.targets` في `tauri.conf.json`.
 *     والأسماء تُشتقّ للعرض والقراءة الحيّة: `<productName>_<version>_x64-setup.exe`
 *     و`<productName>_<version>_x64_en-US.msi` — وهي **مقيسة** على `v0.2.7` و`v0.2.8`
 *     المنشورتين، لا مفترضة. والحكم على السير لا على الأسماء: لو غيّر Tauri نمط
 *     التسمية لبقي الحكم صحيحاً (الدور هو المقيس).
 *   · **`SHA256SUMS.txt` · `build-info.json` · `sbom.cdx.json`**: يجب أن تُذكر
 *     **حرفياً** في أمر رفع إلى نشرة الإصدار (`gh release upload`) — والرفع إلى
 *     قناة أخرى (`assets-v1`) **لا يُحتسب**: تلك قناة الإصلاح الذاتي لا نشرة الإصدار.
 *
 * **والقراءة الحيّة قراءة لا حكم**: إن توفّر `gh` قرأ آخر إصدار وطبع ما يحمله
 * (وما ينقصه)، **ولا يفشل** على إصدار قديم ناقص — الحكم على السير. ويُعطَّل بـ
 * `--no-live` (وهو ما يفعله الفحص الذاتي: لا شبكة ولا `gh`).
 *
 * **والحارس يُقاس بنفسه** (`--selfcheck`): بيئات مصنوعة بسير مصنوع، وحالات:
 * ضابط (٥/٥) يمرّ · سير بلا إسناد (عطل 0.2.8) يسقط ويسمّي الثلاثة · إسناد جزئي
 * يسقط ويسمّي الناقص وحده · مسودّة تسقط · أهداف حزمة بلا NSIS تسقط · بلا خطوة
 * `tauri-action` يسقط · رفعٌ إلى `assets-v1` وحده **لا يُحتسب** فيسقط · وسير/تهيئة
 * غائبة ⇒ فشل بنيوي (2) · وجدول الأدوار مُفرَّغ في نسخة من الحارس ⇒ فشل بنيوي
 * («صفر مدخل في البوّابة نفسها ليس نجاحاً»).
 *
 * الاستعمال: node scripts/check-release-parity.cjs [--repo=<dir>] [--no-live]
 * رموز الخروج: 0 = سليم · 1 = فشل · 2 = بنية/استعمال.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXIT = { PASS: 0, FAIL: 1, MISUSE: 2 };
const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_REL = path.join('.github', 'workflows', 'release.yml');
const TAURI_CONF_REL = path.join('src-tauri', 'tauri.conf.json');
const REPO_SLUG = 'SMSMy/HaramLite';

/**
 * الأدوار الخمسة المطلوبة في كل نشرة إصدار — والقائمة **صريحة** لا مشتقّة: حذف
 * دور منها لتخفيض الشرط **فشل بنيوي (2)** لا نجاح. (وهي القائمة المقيسة على
 * `v0.2.7`: ثلاثة أصول من السير + إسنادان رُفعا يدوياً — وصارا الآن من السير.)
 */
const REQUIRED_ROLES = ['nsis', 'msi', 'sha256sums', 'build-info', 'sbom'];
const REQUIRED_COUNT = 5;
/** الأسماء الحرفية التي يُشترط ظهورها في أمر رفع إلى نشرة الإصدار. */
const ROLE_ASSETS = {
  sha256sums: 'SHA256SUMS.txt',
  'build-info': 'build-info.json',
  sbom: 'sbom.cdx.json',
};

class GuardError extends Error {
  constructor(message, code = EXIT.MISUSE) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// قراءة السير والتهيئة
// ---------------------------------------------------------------------------

function readTauriConf(root) {
  const p = path.join(root, TAURI_CONF_REL);
  if (!fs.existsSync(p)) throw new GuardError(`بنية غير صالحة: ${TAURI_CONF_REL} غير موجود عند ${p}`);
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new GuardError(`${TAURI_CONF_REL} ليس JSON صالحاً: ${err.message}`);
  }
  const productName = conf.productName;
  const version = conf.version;
  if (typeof productName !== 'string' || productName.trim() === '') {
    throw new GuardError(`${TAURI_CONF_REL}: productName مفقود — لا أستطيع اشتقاق أسماء المثبّتَين`);
  }
  if (typeof version !== 'string' || version.trim() === '') {
    throw new GuardError(`${TAURI_CONF_REL}: version مفقود — لا أستطيع اشتقاق أسماء المثبّتَين`);
  }
  const targets = conf.bundle ? conf.bundle.targets : undefined;
  return { productName, version, targets };
}

/** أهداف الحزمة: `"all"` على ويندوز تعني NSIS و MSI معاً (tauri.conf.json المقيس). */
function bundleTargets(targets) {
  if (targets === 'all') return { nsis: true, msi: true, how: '"all"' };
  if (Array.isArray(targets)) {
    return { nsis: targets.includes('nsis'), msi: targets.includes('msi'), how: JSON.stringify(targets) };
  }
  return { nsis: false, msi: false, how: `غير مقروء (${JSON.stringify(targets)})` };
}

/**
 * خطوة `tauri-action`: وجودها + `releaseDraft` (المسودّة لا تنشر شيئاً علناً) +
 * `tagName`. والقراءة سطريّة كما في `check-cuda-assets.cjs` (بلا مكتبة YAML).
 */
function readTauriAction(yaml) {
  const lines = yaml.split(/\r?\n/);
  const at = lines.findIndex((l) => /uses:\s*tauri-apps\/tauri-action@/.test(l));
  if (at < 0) return null;
  // نافذة الخطوة: حتى أقرب سطر بنفس الإزاحة يبدأ بـ`- name:` أو حتى آخر الملف.
  const indent = lines[at].match(/^\s*/)[0].length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)-\s/);
    if (m && m[1].length < indent) {
      end = i;
      break;
    }
  }
  const block = lines.slice(at, end);
  const withBlock = block.find((l) => /^\s*with:\s*$/.test(l));
  if (!withBlock) return { hasWith: false, draft: null, tag: null, line: at + 1 };
  const wIndent = withBlock.match(/^\s*/)[0].length;
  let draft = null;
  let tag = null;
  for (let i = block.indexOf(withBlock) + 1; i < block.length; i += 1) {
    const l = block[i];
    if (l.trim() === '') continue;
    const ind = l.match(/^\s*/)[0].length;
    if (ind <= wIndent) break;
    const d = /^\s*releaseDraft:\s*(\S+)/.exec(l);
    if (d) draft = d[1].replace(/['"]/g, '');
    const t = /^\s*tagName:\s*(\S+)/.exec(l);
    if (t) tag = t[1].replace(/['"]/g, '');
  }
  return { hasWith: true, draft, tag, line: at + 1 };
}

/**
 * أوامر الرفع إلى نشرة الإصدار. وتُعرَف **صيغتا YAML** الحيّتان:
 *   · كتلة نصّية:      `          gh release upload <tag> …`   (بداية السطر)
 *   · سطرية:           `        run: gh release upload <tag> …`
 * ولا يُحتسب **ذكر** العبارة داخل رسالة/تعليق: أول نسخة من هذا الحارس عدّت سطر
 * `throw "gh release upload فشل …"` أمرَ رفع فأنتجت إيجابية كاذبة («الرفع إلى
 * مختار ثابت فشل»)، ثم كشف المُفسَد Ⓖ أن الصيغة السطرية كانت تُفوَّت (سلبية كاذبة).
 * فالقاعدة الآن: الأمر يبدأ السطر (بعد `- ` و`run:` الاختياريين)، والذكر لا يُحتسب.
 * والصيغتان مقيسَتان في الفحص الذاتي (Ⓐ كتلة · Ⓖ″ سطرية · Ⓖ′ ذكر · Ⓖ قناة أخرى).
 *
 * ويُستبعد ما يرفع إلى قناة أخرى (`assets-v1` — قناة الإصلاح الذاتي) لأن تلك
 * ليست نشرة الإصدار ولا تُحتسب في تكافؤها.
 * @returns {Array<{line:number, selector:string, args:string, skipped:boolean}>}
 */
function readReleaseUploads(yaml) {
  const out = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*(?:-\s*)?(?:run:\s*)?gh\s+release\s+(upload|create)\s+(\S+)\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const selector = m[2];
    const args = m[3] || '';
    out.push({
      line: i + 1,
      selector,
      args,
      skipped: selector.includes('assets-v1'),
    });
  }
  return out;
}

/**
 * يقابل ما يرفعه السير بالمطلوب.
 * @returns {{rows:Array<{role:string,label:string,published:boolean,how:string}>, problems:string[]}}
 */
function evaluate(root, roles = REQUIRED_ROLES) {
  if (!Array.isArray(roles) || roles.length === 0) {
    // «صفر دور مطلوب» ليس تكافؤاً: حارس لا يطالب بشيء ليس حارساً.
    throw new GuardError('جدول الأدوار المطلوبة صفر — لا شيء أطالب به، وهذا فشل بنيوي لا نجاح.');
  }
  for (const r of Object.keys(ROLE_ASSETS)) {
    if (!roles.includes(r)) throw new GuardError(`جدول الأدوار ينقصه دور «${r}» — تخفيض الشرط فشل لا نجاح.`);
  }
  const wfPath = path.join(root, WORKFLOW_REL);
  if (!fs.existsSync(wfPath)) throw new GuardError(`بنية غير صالحة: ${WORKFLOW_REL} غير موجود عند ${wfPath}`);
  const yaml = fs.readFileSync(wfPath, 'utf8');
  const conf = readTauriConf(root);
  const targets = bundleTargets(conf.targets);
  const action = readTauriAction(yaml);
  const uploads = readReleaseUploads(yaml);
  const versioned = uploads.filter((u) => !u.skipped);

  const problems = [];
  const rows = [];

  /* ── المثبّتان: من خطوة tauri-action + أهداف الحزمة ── */
  const draft = action ? action.draft : null;
  const publishes = action !== null && draft !== 'true';
  if (action === null) {
    problems.push(
      `لا خطوة tauri-apps/tauri-action في ${WORKFLOW_REL} — لا شيء ينشر المثبّتَين (setup.exe · msi) إلى نشرة الإصدار`
    );
  } else if (!publishes) {
    problems.push(
      `خطوة tauri-action تنشر **مسودّة** (releaseDraft: ${draft}) — والمسودّة لا يراها أحد: ` +
        'تُنشأ بلا أصول علنية حتى تُنشر يدوياً'
    );
  } else if (draft === null) {
    problems.push(
      `خطوة tauri-action بلا releaseDraft صريح (السطر ${action.line}) — لا أستطيع إثبات أنها تنشر لا تُسوّد`
    );
  }
  for (const [role, label, ok] of [
    ['nsis', `${conf.productName}_${conf.version}_x64-setup.exe`, targets.nsis],
    ['msi', `${conf.productName}_${conf.version}_x64_en-US.msi`, targets.msi],
  ]) {
    rows.push({
      role,
      label,
      published: ok && publishes,
      how: ok ? `tauri-action (أهداف الحزمة ${targets.how})` : `أهداف الحزمة ${targets.how} لا تحوي ${role}`,
    });
    if (!ok) problems.push(`bundle.targets = ${targets.how} لا تحوي «${role}» — المثبّت المطلوب لا يُبنى أصلاً`);
  }

  /* ── الإسناد الثلاثي: أسماء حرفية في أمر رفع إلى نشرة الإصدار ── */
  for (const [role, name] of Object.entries(ROLE_ASSETS)) {
    const hit = versioned.find((u) => u.args.includes(name));
    const onlyElsewhere = !hit && uploads.some((u) => u.skipped && u.args.includes(name));
    rows.push({
      role,
      label: name,
      published: Boolean(hit),
      how: hit
        ? `${WORKFLOW_REL}:${hit.line} (gh release ${hit.selector})`
        : onlyElsewhere
          ? 'مذكور في رفع إلى assets-v1 وحده — لا يُحتسب (تلك قناة الإصلاح لا نشرة الإصدار)'
          : 'لا يُرفع في السير',
    });
    if (!hit) {
      problems.push(
        onlyElsewhere
          ? `${name} يُرفع إلى assets-v1 فقط، ولا يُرفع إلى نشرة الإصدار — وهذا سبب نقص أصول 0.2.8`
          : `${name} لا يُرفع إلى نشرة الإصدار في ${WORKFLOW_REL} — و0.2.8 نُشرت بثلاثة أصول لهذا السبب`
      );
    }
  }

  // الرفع يجب أن يكون **إلى وسم الإصدار** لا إلى اسم ثابت (وإلا رفعت كل نسخة إلى نشرة واحدة).
  for (const u of versioned) {
    if (!/\$|__VERSION__|v\d/.test(u.selector)) {
      problems.push(
        `${WORKFLOW_REL}:${u.line}: الرفع إلى مختار ثابت «${u.selector}» — يُشترط أن يكون الوسم بحسب الإصدار`
      );
    }
  }

  if (rows.filter((r) => r.published).length > REQUIRED_COUNT) {
    problems.push(`أدوار منشورة أكثر من المطلوب (${rows.length} > ${REQUIRED_COUNT}) — راجع الجدول`);
  }
  return { rows, problems, versioned, uploads };
}

// ---------------------------------------------------------------------------
// القراءة الحيّة (قراءة لا حكم)
// ---------------------------------------------------------------------------

function liveRead(roles) {
  const r = spawnSync('gh', ['release', 'view', '-R', REPO_SLUG, '--json', 'tagName,isDraft,assets'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 25000,
  });
  if (r.error) return { ok: false, why: `تعذّر تشغيل gh: ${r.error.message}` };
  if (r.status !== 0) {
    return { ok: false, why: `gh رجع ${r.status}: ${(r.stderr || '').trim().split('\n')[0] || 'بلا رسالة'}` };
  }
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch (err) {
    return { ok: false, why: `مخرَج gh ليس JSON: ${err.message}` };
  }
  const names = Array.isArray(data.assets) ? data.assets.map((a) => a.name) : [];
  const missing = [];
  // مطابقة الأسماء المشتقّة (للقراءة): تُقرأ من الأدوار لا تُحكم.
  for (const row of roles) {
    if (row.role === 'nsis' || row.role === 'msi') {
      const suffix = row.role === 'nsis' ? '-setup.exe' : '.msi';
      if (!names.some((n) => n.endsWith(suffix))) missing.push(row.label);
    } else if (!names.includes(row.label)) missing.push(row.label);
  }
  return { ok: true, tag: data.tagName, draft: data.isDraft === true, names, missing };
}

// ---------------------------------------------------------------------------
// التشغيل
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { repo: ROOT, live: true, selfcheck: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--no-live') opts.live = false;
    else if (arg === '--selfcheck') opts.selfcheck = true;
    else if (arg.startsWith('--repo=')) opts.repo = path.resolve(arg.slice('--repo='.length));
    else throw new GuardError(`وسيط غير معروف: ${arg}`);
  }
  return opts;
}

const USAGE = `الاستعمال: node scripts/check-release-parity.cjs [--repo=<dir>] [--no-live]

  --repo=<dir>   جذر المستودع (افتراضاً جذر هذا الملف) — للفحص الذاتي
  --no-live      لا تقرأ آخر إصدار من GitHub (بلا شبكة ولا gh)
  --selfcheck    يفحص الحارس نفسه على سير مصنوع (ضابط · مُفسَدات · صفر مدخل)
  --help         هذه الرسالة

يقيس: ما يرفعه release.yml فعلاً مقابل **${REQUIRED_COUNT}** أدوار إلزامية في كل نشرة إصدار
(المثبّتان من tauri-action + SHA256SUMS.txt · build-info.json · sbom.cdx.json من
\`gh release upload\`) — ويفشل عند النقص. والقراءة الحيّة لآخر إصدار **قراءة لا حكم**.
0 = سليم · 1 = فشل · 2 = بنية/استعمال.`;

function runChecks(root, opts) {
  const { rows, problems, versioned, uploads } = evaluate(root);
  const published = rows.filter((r) => r.published).length;
  console.log(`ℹ السير: ${WORKFLOW_REL} · أوامر gh release: ${uploads.length} (منها إلى نشرة الإصدار: ${versioned.length})`);
  for (const r of rows) {
    console.log(`   ${r.published ? '✓' : '✗'} ${r.role}: ${r.label} — ${r.how}`);
  }
  console.log(`ℹ المنشور من المطلوب: ${published}/${REQUIRED_COUNT}`);

  if (opts.live) {
    const live = liveRead(rows);
    if (!live.ok) {
      console.log(`   (قراءة حيّة متعذّرة — قراءة لا حكم: ${live.why})`);
    } else {
      console.log(
        `   (قراءة لا حكم) آخر إصدار: ${live.tag} — ${live.names.length} أصلاً` +
          `${live.draft ? ' · **مسودّة**' : ''}` +
          `${live.missing.length > 0 ? ` · ينقصه: ${live.missing.join(' · ')}` : ' · لا ينقصه شيء'}`
      );
      console.log('   وهذه قراءة لا تُسقط الحارس: إصدار قديم ناقص لا يُصلَح بإعادة كتابة التاريخ — الحكم على السير.');
    }
  }

  if (problems.length > 0) {
    console.error(`\n✗ فشل تكافؤ أصول الإصدار (${problems.length} مشكلة):`);
    for (const p of problems) console.error(`   - ${p}`);
    return EXIT.FAIL;
  }
  console.log(`✓ تكافؤ أصول الإصدار: ${published}/${REQUIRED_COUNT} أدوار منشورة من ${WORKFLOW_REL} — لا نقص.`);
  return EXIT.PASS;
}

// ---------------------------------------------------------------------------
// الفحص الذاتي: سير مصنوع، وحالات، ومُفسَد على الحارس نفسه
// ---------------------------------------------------------------------------

const FIXTURE_WITH_ALL = `name: Release
on:
  workflow_dispatch:
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build & publish Tauri release
        uses: tauri-apps/tauri-action@v0
        with:
          tagName: v__VERSION__
          releaseDraft: false
          prerelease: false
      - name: Publish release metadata
        shell: pwsh
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          \$ver = (Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
          \$tag = "v\$ver"
          gh release upload \$tag -R \$env:GITHUB_REPOSITORY 'SHA256SUMS.txt' 'dist/release-metadata/build-info.json' 'dist/release-metadata/sbom.cdx.json' --clobber
`;

/** سير مصنوع بتبديلات: يُستبدل نصّ فيه ليُقاس سقوط الحارس على العيب بعينه. */
function fixtureWorkflow({ dropUpload = false, uploads = null, draft = false, keepAction = true } = {}) {
  let yaml = FIXTURE_WITH_ALL;
  if (dropUpload) {
    yaml = yaml.split('\n').filter((l) => !/gh release upload/.test(l)).join('\n');
  } else if (uploads !== null) {
    yaml = yaml.replace(/gh release upload[^\n]*/, `gh release upload $tag -R $env:GITHUB_REPOSITORY ${uploads} --clobber`);
  }
  if (draft) yaml = yaml.replace('releaseDraft: false', 'releaseDraft: true');
  if (!keepAction) {
    yaml = yaml
      .split('\n')
      .filter((l) => !/tauri-action/.test(l) && !/tagName:/.test(l) && !/releaseDraft:/.test(l) && !/prerelease:/.test(l))
      .join('\n');
  }
  return yaml;
}

function writeFixture(root, yaml, conf) {
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  fs.writeFileSync(path.join(root, WORKFLOW_REL), yaml);
  fs.writeFileSync(
    path.join(root, TAURI_CONF_REL),
    JSON.stringify(conf || { productName: 'HaramLite', version: '1.2.3', bundle: { targets: 'all' } }, null, 2)
  );
  return root;
}

function selfcheck(work) {
  const cases = [];
  const run = (args) => {
    const r = spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', windowsHide: true });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const add = (label, res, expectStatus, mustText, forbidText) => {
    const problems = [];
    if (res.status !== expectStatus) problems.push(`رمز الخروج ${res.status} بدل ${expectStatus}`);
    for (const t of mustText || []) if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    for (const t of forbidText || []) if (res.out.includes(t)) problems.push(`المخرَج يحوي «${t}» وهو ممنوع`);
    cases.push({ label, ok: problems.length === 0, detail: problems.join(' · ') });
  };
  const mk = (name, opts, conf) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    writeFixture(dir, fixtureWorkflow(opts), conf);
    return dir;
  };
  const args = (dir) => [`--repo=${dir}`, '--no-live'];

  /* Ⓐ ضابط: خمسة أدوار منشورة ⇒ 0، وقد رأى الخمسة. */
  add(
    'Ⓐ ضابط: مثبّتان + إسناد ثلاثي ⇒ 0 (5/5)',
    run(args(mk('control', {}))),
    EXIT.PASS,
    ['5/5', '✓ nsis', '✓ msi', '✓ sha256sums', '✓ build-info', '✓ sbom', 'لا نقص']
  );

  /* Ⓑ عطل 0.2.8 نفسه: السير ينشر المثبّتَين فقط ⇒ يسقط ويسمّي الثلاثة. */
  add(
    'Ⓑ مُفسَد (عطل 0.2.8): بلا رفع إسناد ⇒ يسقط ويسمّي الثلاثة',
    run(args(mk('no-metadata', { dropUpload: true }))),
    EXIT.FAIL,
    ['✗ فشل تكافؤ', 'SHA256SUMS.txt لا يُرفع', 'build-info.json لا يُرفع', 'sbom.cdx.json لا يُرفع', '0.2.8']
  );

  /* Ⓒ إسناد جزئي: build-info وحده ⇒ يسقط ويسمّي الناقصَين وحدهما. */
  add(
    'Ⓒ مُفسَد: إسناد جزئي (build-info وحده) ⇒ يسقط بالناقصين وحدهما',
    run(args(mk('partial', { uploads: "'dist/release-metadata/build-info.json'" }))),
    EXIT.FAIL,
    ['✗ فشل تكافؤ', 'SHA256SUMS.txt لا يُرفع', 'sbom.cdx.json لا يُرفع'],
    ['build-info.json لا يُرفع']
  );

  /* Ⓓ مسودّة: لا يراها أحد. */
  add(
    'Ⓓ مُفسَد: tauri-action تنشر مسودّة ⇒ يسقط',
    run(args(mk('draft', { draft: true }))),
    EXIT.FAIL,
    ['✗ فشل تكافؤ', 'مسودّة']
  );

  /* Ⓔ أهداف حزمة بلا NSIS ⇒ المثبّت لا يُبنى أصلاً. */
  add(
    'Ⓔ مُفسَد: bundle.targets = ["msi"] ⇒ يسقط (لا NSIS)',
    run(args(mk('no-nsis', {}, { productName: 'HaramLite', version: '1.2.3', bundle: { targets: ['msi'] } }))),
    EXIT.FAIL,
    ['✗ فشل تكافؤ', 'لا تحوي «nsis»']
  );

  /* Ⓕ بلا خطوة tauri-action ⇒ لا ناشر للمثبّتَين. */
  add(
    'Ⓕ مُفسَد: بلا خطوة tauri-action ⇒ يسقط',
    run(args(mk('no-action', { keepAction: false }))),
    EXIT.FAIL,
    ['✗ فشل تكافؤ', 'لا خطوة tauri-apps/tauri-action']
  );

  /* Ⓖ رفع إلى assets-v1 وحده لا يُحتسب (قناة الإصلاح ليست نشرة الإصدار). */
  {
    const dir = mk('assets-channel-only', { dropUpload: true });
    const yaml = fs.readFileSync(path.join(dir, WORKFLOW_REL), 'utf8');
    fs.writeFileSync(
      path.join(dir, WORKFLOW_REL),
      `${yaml}      - name: assets\n        run: gh release upload assets-v1 'SHA256SUMS.txt' 'build-info.json' 'sbom.cdx.json' --clobber\n`
    );
    add(
      'Ⓖ مُفسَد: الرفع إلى assets-v1 وحده لا يُحتسب ⇒ يسقط',
      run(args(dir)),
      EXIT.FAIL,
      ['✗ فشل تكافؤ', 'assets-v1 فقط']
    );
  }

  /* Ⓖ′ مُفسَد: الأسماء الثلاثة **مذكورة** في رسالة خطأ لا في أمر رفع ⇒ لا تُحتسب.
     (هذه العلّة بعينها أنتجت إيجابية كاذبة في أول نسخة من هذا الحارس: سطر
     `throw "gh release upload فشل …"` عُدّ أمرَ رفع.) */
  {
    const dir = mk('mention-not-upload', { dropUpload: true });
    const yaml = fs.readFileSync(path.join(dir, WORKFLOW_REL), 'utf8');
    fs.writeFileSync(
      path.join(dir, WORKFLOW_REL),
      `${yaml}      - name: assets\n        run: |\n          if ($LASTEXITCODE -ne 0) { throw "gh release upload فشل — SHA256SUMS.txt build-info.json sbom.cdx.json" }\n`
    );
    add(
      'Ⓖ′ مُفسَد: الأسماء مذكورة في رسالة خطأ لا في أمر رفع ⇒ لا تُحتسب فيسقط',
      run(args(dir)),
      EXIT.FAIL,
      ['✗ فشل تكافؤ', 'SHA256SUMS.txt لا يُرفع']
    );
  }

  /* Ⓖ″ ضابط للصيغة السطرية `run: gh release upload …` — كشف المُفسَد Ⓖ أن أول
     نسخة من المحلّل كانت تفوّتها (سلبية كاذبة: سير يرفع فيُحكم عليه بأنه لا يرفع). */
  {
    const dir = mk('inline-run-form', { dropUpload: true });
    const yaml = fs.readFileSync(path.join(dir, WORKFLOW_REL), 'utf8');
    fs.writeFileSync(
      path.join(dir, WORKFLOW_REL),
      `${yaml}      - name: assets\n        run: gh release upload $tag -R $env:GITHUB_REPOSITORY 'SHA256SUMS.txt' 'dist/release-metadata/build-info.json' 'dist/release-metadata/sbom.cdx.json' --clobber\n`
    );
    add('Ⓖ″ ضابط: الصيغة السطرية (run: gh release upload) تُحتسب ⇒ 0', run(args(dir)), EXIT.PASS, ['5/5', 'لا نقص']);
  }

  /* Ⓗ صفر مدخل: سير غائب · تهيئة غائبة · جدول أدوار مُفرَّغ في نسخة من الحارس. */
  {
    const dir = path.join(work, 'no-workflow');
    fs.mkdirSync(path.join(dir, 'src-tauri'), { recursive: true });
    fs.writeFileSync(path.join(dir, TAURI_CONF_REL), '{"productName":"X","version":"1.0.0"}');
    add('Ⓗ صفر مدخل: release.yml غائب ⇒ فشل بنيوي (2)', run(args(dir)), EXIT.MISUSE, ['✗', 'بنية غير صالحة']);

    const dir2 = path.join(work, 'no-conf');
    fs.mkdirSync(path.join(dir2, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir2, WORKFLOW_REL), fixtureWorkflow({}));
    add('Ⓘ صفر مدخل: tauri.conf.json غائب ⇒ فشل بنيوي (2)', run(args(dir2)), EXIT.MISUSE, ['✗', 'بنية غير صالحة']);

    const dir3 = mk('bad-conf', {}, { productName: '', version: '1.2.3' });
    add('Ⓘ′ صفر مدخل: productName فارغ ⇒ فشل بنيوي (2)', run(args(dir3)), EXIT.MISUSE, ['✗', 'productName مفقود']);
  }

  /* Ⓠ مُفسَد على الحارس نفسه: نسخة جدول أدوارها مُفرَّغ ⇒ يجب أن تفشل بصوت عالٍ
     (وليس أن تمرّ لأنها لا تطالب بشيء). */
  {
    const problems = [];
    let src = null;
    try {
      src = fs.readFileSync(__filename, 'utf8');
    } catch (err) {
      problems.push(err.message);
    }
    if (src !== null) {
      const decl = `const REQUIRED_ROLES = [${REQUIRED_ROLES.map((r) => `'${r}'`).join(', ')}];`;
      const n = src.split(decl).length - 1;
      if (n !== 1) {
        problems.push(`مُفسَد باطل: سطر جدول الأدوار لا يطابق النصّ المتوقَّع (وجوده ${n} مرة)`);
      } else {
        const mutant = path.join(work, 'parity-empty-roles.cjs');
        fs.writeFileSync(mutant, src.split(decl).join('const REQUIRED_ROLES = [];'));
        const r = spawnSync(process.execPath, [mutant, ...args(mk('mutant-control', {}))], {
          encoding: 'utf8',
          windowsHide: true,
        });
        if (r.status !== EXIT.MISUSE) {
          problems.push(`نسخة الجدول المُفرَّغ رجعت ${r.status} بدل ${EXIT.MISUSE} — صفر مطالبة مرّ كنجاح`);
        }
        if (!`${r.stdout}${r.stderr}`.includes('صفر')) {
          problems.push('نسخة الجدول المُفرَّغ لم تسمِّ السبب («صفر»)... القياس بلا رسالة مسمّاة');
        }
      }
    }
    cases.push({ label: 'Ⓠ نسخة بجدول أدوار مُفرَّغ ⇒ فشل بنيوي بصوت عالٍ (لا نجاح فارغ)', ok: problems.length === 0, detail: problems.join(' · ') });
  }

  return cases;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return EXIT.PASS;
  }
  if (opts.selfcheck) {
    const work = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hl-release-parity-'));
    let cases;
    try {
      cases = selfcheck(work);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    const bad = cases.filter((c) => !c.ok);
    console.log(`\nالفحص الذاتي لحارس تكافؤ الأصول — ${cases.length} حالة:`);
    for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : `\n      ${c.detail}`}`);
    if (bad.length > 0) {
      console.error(`\n✗ الفحص الذاتي سقط في ${bad.length} حالة من ${cases.length}`);
      return EXIT.FAIL;
    }
    console.log('✓ الحارس يمرّ على الضابط ويسقط على كل نقص — وفي نسخة جدوله المُفرَّغ فشل بنيوي.');
    return EXIT.PASS;
  }
  return runChecks(opts.repo, opts);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`✗ ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = err instanceof GuardError ? err.code : EXIT.FAIL;
  }
}

module.exports = { evaluate, readReleaseUploads, readTauriAction, bundleTargets, REQUIRED_ROLES, REQUIRED_COUNT };
