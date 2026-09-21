#!/usr/bin/env node
/* حارس قناة الإصلاح الذاتي (`assets-v1`) — البند ن-١ في خطة 0.2.9 §١١.
 *
 * **العطل الذي وُلد هذا الحارس لأجله** (مقيس في 0.2.8): كانت القناة **مسودّة
 * بصفر أصول**، فكل رابط عام يردّ **404** ⇒ معالج الإصلاح الذاتي معطّل عند كل
 * مستخدم مثبَّت، **ولا شيء في المستودع كان يسقط**: `cuda-assets.yml` أنشأ الإصدار،
 * وخطوة `pwsh` لا تفشل إذا فشل أمرها، ولا حارس يسأل «هل يردّ الرابط العلني 200؟».
 *
 * **ما يقيسه**، وقائمته من **الكود لا من رأس أحد**:
 *   ① `src-tauri/src/repair.rs` ← `pub const ASSET_BASE` (المالك · المستودع · الوسم)
 *      و`pub const COMPONENTS` (أسماء الأصول المتوقَّعة + بصماتها المثبَّتة في
 *      التنفيذي). جدول فارغ أو غير مقروء ⇒ **فشل بنيوي (2)**، لا مرور.
 *   ② سجلّ النشرة: **مسودّة أم لا** — من واجهة GitHub العامة بـ`fetch` (بلا `gh`:
 *      وجوده غير مفترض، كما في `fetch-resources.cjs`)، أو من ملف يُعطى
 *      بـ`--release-json` (فيصلح للقياس بلا شبكة).
 *   ③ **العضوية**: كل أصل متوقَّع مذكور في أصول النشرة المعلنة.
 *   ④ **البصمة المعلنة** (`asset.digest`) تطابق المثبَّتة في التنفيذي. غيابها من
 *      السجلّ **إشعار** لا حكم (واجهة أقدم)، وحضورها مخالفةً **سقوط**.
 *   ⑤ **الحياة**: `HEAD` على الرابط العلني لكل أصل ⇒ **200** بالضبط (و404 سقوط).
 *
 * **ووضعان** (نمط `matrix-check.cjs` المعتمد في هذا المستودع):
 *   · **الافتراضيّ**: الغياب **البيئيّ** (لا شبكة · مهلة · 403/429 حدّ معدّل ·
 *     5xx) يُذكر بسطر صارخ ويبقى 0 — و`exit 0` هنا **ليس** شهادة قبول.
 *   · **`--strict`** (وضع التسليم): الغياب البيئيّ نفسه **فشل** يسمّي سببه.
 *   و**404** (وسم مفقود · أصل مفقود · رابط ميت) و**المسودّة** و**البصمة المخالفة**
 *   تسقط في **الوضعين**: هي أدلّة على عطل القناة لا على عطل الشبكة.
 *
 * **والحارس يُقاس بمُفسَداته** (`--selfcheck`): خادم محلي على منفذ 0 ومستودع
 * مصنوع وتسع حالات — ضابط يمرّ · اسم مُختلق يسقط بالعضوية · اسم مُختلق يُعلنه
 * السجلّ ورابطه 404 فيسقط بالحياة · مسودّة تسقط · بصمة مخالفة تسقط · بلا شبكة +
 * افتراضيّ = 0 مع السطر الصارخ · بلا شبكة + `--strict` = 1 · جدول مكوّنات فارغ = 2 ·
 * وسجلّ نشرة غير مقروء = 2. ومُفسَدان على الحارس نفسه (نسخة بلا فحص الحياة ·
 * نسخة بلا فحص المسودّة) يُثبتان أن هذين الفحصين هما ما يمسك العطل.
 *
 * بلا اعتماديات npm: `node:fs` · `node:path` · `node:http` · `node:child_process`
 * و`fetch` المدمج وحدهما.
 *
 * الاستعمال: node scripts/check-release-assets.cjs [خيارات]
 *   0 = سليم (أو غياب بيئيّ في الوضع المتسامح) · 1 = فشل · 2 = بنية/استعمال.
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const EXIT = { PASS: 0, FAIL: 1, MISUSE: 2 };

const ROOT = path.resolve(__dirname, '..');
const REPAIR_RS_REL = path.join('src-tauri', 'src', 'repair.rs');
const SHA_RE = /^[0-9a-f]{64}$/;
/** اسم أصل آمن = اسم ملف مجرّد (نفس قاعدة `cuda_runtime.rs::asset_name_ok`). */
const SAFE_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const USER_AGENT = 'HaramLite-release-assets-guard/0.2';
const DEFAULT_TIMEOUT_MS = 20000;

/** خطأ بنية/استعمال — يُطبع بـ`✗` ويرجع 2 (لا صفر، ولا انهيار بـstack). */
class GuardError extends Error {
  constructor(message, code = EXIT.MISUSE) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// ① مصدر القائمة: repair.rs (نفس مرساة الثقة التي يقرأها التنفيذي والجالب)
// ---------------------------------------------------------------------------

/** يقتطع كتلة ثابت من مصدر Rust حتى `\n];` — نفس نمط `fetch-resources.cjs`. */
function sliceConst(source, decl) {
  const start = source.indexOf(decl);
  if (start < 0) return null;
  const end = source.indexOf('\n];', start);
  if (end < 0) return null;
  return source.slice(start, end);
}

function field(block, name) {
  const m = new RegExp(`\\b${name}\\s*:\\s*"([^"]*)"`).exec(block);
  return m ? m[1] : null;
}

/**
 * المالك والمستودع والوسم من `ASSET_BASE` في repair.rs.
 *
 * الشكل المتوقَّع (مقيس في المصدر): `https://github.com/<owner>/<repo>/releases/download/<tag>`
 * — ويُرفض أي شكل آخر بصوت عالٍ بدل تخمين قناة.
 * @returns {{assetBase:string, owner:string, repo:string, tag:string}}
 */
function parseChannel(assetBase) {
  let url;
  try {
    url = new URL(assetBase);
  } catch {
    throw new GuardError(`ASSET_BASE في repair.rs ليس رابطاً صالحاً: ${assetBase}`);
  }
  const m = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) {
    throw new GuardError(
      `ASSET_BASE لا يطابق شكل قناة إصدار: ${assetBase}\n` +
        '    المتوقَّع: https://github.com/<owner>/<repo>/releases/download/<tag>'
    );
  }
  return { assetBase: assetBase.replace(/\/$/, ''), owner: m[1], repo: m[2], tag: m[3] };
}

/**
 * يقرأ من `repair.rs`: القناة + الأصول الأربعة المتوقَّعة (اسم الأصل · البصمة ·
 * الاسم المحلي · المجلد). والأسماء هنا هي **ما يطلبه التطبيق فعلاً**، لا نسخة ثانية
 * في هذا الملف تفترق عنه بصمت.
 * @returns {{channel:object, expected:Array<{key:string,asset:string,local:string,subdir:string,sha256:string}>}}
 */
function readExpectations(root) {
  const rsPath = path.join(root, REPAIR_RS_REL);
  if (!fs.existsSync(rsPath)) {
    throw new GuardError(`بنية غير صالحة: ${REPAIR_RS_REL} غير موجود عند ${rsPath}`);
  }
  const src = fs.readFileSync(rsPath, 'utf8');
  const baseMatch = /pub const ASSET_BASE\s*:\s*&str\s*=\s*"([^"]+)"/.exec(src);
  if (!baseMatch) {
    throw new GuardError(
      `لم أقرأ ASSET_BASE من ${REPAIR_RS_REL} — تغيّر اسم الثابت؟ لا قناة أفحصها، فلا نجاح.`
    );
  }
  const channel = parseChannel(baseMatch[1]);

  const block = sliceConst(src, 'pub const COMPONENTS');
  if (block === null) {
    throw new GuardError(
      `لم أقرأ COMPONENTS من ${REPAIR_RS_REL} — جدول الأصول المتوقَّعة غير موجود، وهذا فشل لا مرور.`
    );
  }
  const expected = [];
  for (const m of block.matchAll(/Component\s*\{([\s\S]*?)\}/g)) {
    const body = m[1];
    const c = {
      key: field(body, 'key'),
      asset: field(body, 'asset'),
      local: field(body, 'local'),
      subdir: field(body, 'subdir'),
      sha256: field(body, 'sha256'),
    };
    for (const [k, v] of Object.entries(c)) {
      if (!v) throw new GuardError(`COMPONENTS في ${REPAIR_RS_REL}: حقل «${k}» ناقص أو غير مقروء`);
    }
    expected.push(c);
  }
  if (expected.length === 0) {
    // «صفر أصل متوقَّع» ليس قناةً سليمة: حارس لا يرى ليس حارساً.
    throw new GuardError(
      `COMPONENTS في ${REPAIR_RS_REL} صفر مكوّن — لا شيء أتحقّق منه، وهذا فشل بنيوي لا نجاح.`
    );
  }
  const seen = new Set();
  for (const c of expected) {
    if (!SAFE_NAME_RE.test(c.asset)) throw new GuardError(`اسم أصل غير آمن في COMPONENTS: ${c.asset}`);
    if (!SHA_RE.test(c.sha256)) throw new GuardError(`بصمة ${c.key} ليست SHA-256 سداسية عشرية: ${c.sha256}`);
    if (seen.has(c.asset)) throw new GuardError(`اسم أصل مكرَّر في COMPONENTS: ${c.asset}`);
    seen.add(c.asset);
  }
  return { channel, expected };
}

// ---------------------------------------------------------------------------
// ② سجلّ النشرة: مسودّة؟ وأي أصول يعلنها؟
// ---------------------------------------------------------------------------

/**
 * يوحّد شكل السجلّ بين واجهة REST (`draft` · `tag_name` · `assets[].name`) وبين
 * مخرَج `gh release view --json` (`isDraft` · `tagName` · `assets[].name`) —
 * فيصلح الملف المُعطى للقياس من المصدرين.
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GuardError('سجلّ النشرة ليس كائناً JSON');
  }
  const draft = raw.draft === true || raw.isDraft === true;
  const tag = raw.tag_name ?? raw.tagName ?? null;
  const assets = Array.isArray(raw.assets) ? raw.assets : null;
  if (assets === null) throw new GuardError('سجلّ النشرة بلا مصفوفة assets');
  return {
    draft,
    tag: tag === null ? null : String(tag),
    assets: assets.map((a) => ({
      name: String((a && a.name) || ''),
      size: typeof a?.size === 'number' ? a.size : null,
      digest: a && a.digest ? String(a.digest) : null,
    })),
  };
}

async function fetchJson(url, token, timeoutMs) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' };
  // الرمز (إن حضر) يرفع حدّ المعدّل وحده؛ ولا يُطبع في أي مخرَج.
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { status: res.status, text, rateLimit: res.headers.get('x-ratelimit-remaining') };
}

/**
 * يجلب سجلّ النشرة. والتمييز مقصود:
 *   · 200 ⇒ سجلّ.
 *   · **404 ⇒ وسم مفقود** — دلاليّ، يسقط في الوضعين.
 *   · 403/429/5xx/شبكة/مهلة/JSON مشوَّه ⇒ **غياب بيئيّ** — يُعلَن، ويسقط في `--strict`.
 */
async function readReleaseRecord(opts) {
  if (opts.releaseJson) {
    const p = path.resolve(opts.releaseJson);
    if (!fs.existsSync(p)) throw new GuardError(`--release-json=<file>: الملف غير موجود: ${p}`);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      throw new GuardError(`--release-json=<file>: ليس JSON صالحاً (${p}): ${err.message}`);
    }
    return { state: 'ok', record: normalizeRecord(raw), source: `ملف: ${p}` };
  }
  const url = opts.apiUrl;
  let res;
  try {
    res = await fetchJson(url, opts.token, opts.timeoutMs);
  } catch (err) {
    const why = err && err.name === 'TimeoutError' ? `مهلة ${opts.timeoutMs}ms` : `شبكة: ${err.message}`;
    return { state: 'env', why: `${why} (${url})`, source: url };
  }
  if (res.status === 404) return { state: 'missing-tag', source: url, why: `HTTP 404 — الوسم غير موجود` };
  if (res.status === 200) {
    let raw;
    try {
      raw = JSON.parse(res.text);
    } catch (err) {
      return { state: 'env', why: `ردّ 200 لكن الجسم ليس JSON: ${err.message}`, source: url };
    }
    try {
      return { state: 'ok', record: normalizeRecord(raw), source: url };
    } catch (err) {
      return { state: 'env', why: `سجلّ غير مقروء: ${err.message}`, source: url };
    }
  }
  const hint =
    res.status === 403 || res.status === 429
      ? `حدّ معدّل/منع (المتبقّي: ${res.rateLimit ?? 'غير معلوم'})`
      : res.status >= 500
        ? 'عطل خادم مؤقّت'
        : 'استجابة غير متوقَّعة';
  return { state: 'env', why: `HTTP ${res.status} — ${hint}`, source: url };
}

// ---------------------------------------------------------------------------
// ⑤ الحياة: HEAD على الرابط العلني
// ---------------------------------------------------------------------------

/** رابط الأصل العلني — من `ASSET_BASE` نفسه، فلا مسار ثانٍ يفترق عنه. */
function assetUrl(base, name) {
  return `${base.replace(/\/$/, '')}/${name}`;
}

/**
 * `HEAD` واحد. `redirect: 'follow'` لأن GitHub يردّ 302 إلى مضيف الكائنات،
 * و`AbortSignal.timeout` لأن تعليق الاتصال يجب أن يُسمّى مهلة لا أن يُعلّق البوّابة.
 * @returns {{status:number|null, why:string|null}}
 */
async function headStatus(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // الجسم لا يُقرأ في HEAD؛ إغلاق صريح يمنع تسريب مقبض.
    try {
      await res.body?.cancel();
    } catch {
      /* لا جسم */
    }
    return { status: res.status, why: null };
  } catch (err) {
    const why = err && err.name === 'TimeoutError' ? `مهلة ${timeoutMs}ms` : `شبكة: ${err.message}`;
    return { status: null, why };
  }
}

/** زيارة كل أصل متوقَّع: 200 مرور · 404 سقوط · أي رمز آخر سقوط · خطأ شبكة غياب بيئيّ. */
async function checkLiveness(expected, urls, opts, out) {
  for (const c of expected) {
    const url = urls.get(c.asset);
    const { status, why } = await headStatus(url, opts.timeoutMs);
    if (status === 200) {
      out.live.push({ name: c.asset, status, url });
      continue;
    }
    if (status === null) {
      out.env.push({ name: c.asset, url, why: `تعذّر الطلب — ${why}` });
      continue;
    }
    out.problems.push({
      kind: 'رابط ميت',
      name: c.asset,
      why: `الرابط العلني يردّ HTTP ${status} (المتوقَّع 200) — ${url}`,
    });
  }
}

// ---------------------------------------------------------------------------
// السطر الصارخ — عقدٌ مع الفحص الذاتي لا سطر ميت
// ---------------------------------------------------------------------------

/**
 * نصّ نداء السطر الصارخ. الحالة Ⓠ″ تحذف هذا السطر بعينه من **نسخة** من هذا الملف
 * وتثبت أن الحالة Ⓕ (بلا شبكة في الوضع الافتراضيّ) تسقط حينها؛ فإن تغيّر النصّ
 * هنا ولم يتغيّر **موضع النداء** **يفشل الفحص الذاتي بصوت عالٍ** («النصّ يظهر مرة
 * واحدة» — فلا موضع نداء يطابقه) بدل أن يمرّ المُفسَد صامتاً. وهذا ليس تفصيلاً:
 * أول نسخة من هذا الملف حملت نصّاً لا يطابق موضع النداء (`out.env` مقابل `env`)
 * فطُمس الإعلان وحده **وبقي السطر الصارخ يُطبع** — كشفه هذا الشرط نفسه.
 */
const ENV_NOTICE_CALL = 'emitEnvironmentalNotice(out.env, opts, expected.length);';
const ENV_NOTICE_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ″) */';

/** نداء فحص الحياة — يُحذف في الحالة Ⓠ لقياس أن الحياة هي ما يمسك الرابط الميت. */
const LIVENESS_CALL = 'await checkLiveness(expected, urls, opts, out);';
const LIVENESS_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ) */';

/** نداء فحص المسودّة — يُحذف في الحالة Ⓠ″. */
const DRAFT_CALL = "if (record.draft === true) out.problems.push(draftProblem(record));";
const DRAFT_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ″) */';

function draftProblem(record) {
  return {
    kind: 'مسودّة',
    name: record.tag ? `الوسم ${record.tag}` : '(بلا وسم)',
    why:
      'النشرة **مسودّة** (draft) ⇒ روابطها تردّ 404 لكل من ليس مالكاً، ' +
      'فالإصلاح الذاتي معطّل عند كل مستخدم مثبَّت — وَهذا هو عطل 0.2.8 نفسه',
  };
}

/** نصّ ثابت يُطبع مرة واحدة في الوضع المتسامح — ولا يُطبعه غيره. */
function emitEnvironmentalNotice(env, opts, expectedCount) {
  const lines = [];
  lines.push(`\n⚠ غياب بيئيّ — لم أستطع قياس القناة (${env.length} موضعاً):`);
  for (const e of env) lines.push(`   · ${e.name}: ${e.why}`);
  lines.push(`   الأصول المتوقَّعة من الكود: ${expectedCount} — ولم يُقَس منها شيء في هذا التشغيل.`);
  lines.push('   هذه ليست شهادة قبول: القبول يشترط `--strict` (والشبكة حاضرة).');
  lines.push('   سبب التسامح: الوضع الافتراضيّ هو وضع CI، وغياب الشبكة/حدّ المعدّل عطل بيئة لا عطل قناة.');
  lines.push('   و404 والمسودّة والبصمة المخالفة **تسقط في الوضعين** — التسامح بيئيّ لا دلاليّ.');
  process.stdout.write(`${lines.join('\n')}\n`);
  process.stderr.write(`⚠ لم تُقَس القناة (${env.length} موضعاً) — القبول النهائي يشترط --strict\n`);
}

// ---------------------------------------------------------------------------
// التشغيل
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    strict: false,
    quiet: false,
    help: false,
    selfcheck: false,
    repo: ROOT,
    releaseJson: null,
    apiUrl: null,
    assetUrlBase: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--selfcheck') opts.selfcheck = true;
    else if (arg.startsWith('--repo=')) opts.repo = path.resolve(arg.slice('--repo='.length));
    else if (arg.startsWith('--release-json=')) opts.releaseJson = arg.slice('--release-json='.length);
    else if (arg.startsWith('--api-url=')) opts.apiUrl = arg.slice('--api-url='.length);
    else if (arg.startsWith('--asset-url-base=')) opts.assetUrlBase = arg.slice('--asset-url-base='.length);
    else if (arg.startsWith('--timeout=')) {
      const n = Number(arg.slice('--timeout='.length));
      if (!Number.isFinite(n) || n <= 0) throw new GuardError(`--timeout يحتاج عدداً موجباً (ملي ثانية)`);
      opts.timeoutMs = n;
    } else throw new GuardError(`وسيط غير معروف: ${arg}`);
  }
  return opts;
}

const USAGE = `الاستعمال: node scripts/check-release-assets.cjs [خيارات]

  --strict                 وضع التسليم: الغياب البيئيّ (لا شبكة · مهلة · 403/429 · 5xx) **فشل**
  --repo=<dir>             جذر المستودع (افتراضاً جذر هذا الملف) — للفحص الذاتي
  --release-json=<file>    اقرأ سجلّ النشرة من ملف بدل الشبكة (قياس بلا شبكة)
  --api-url=<url>          تجاوز رابط واجهة النشرة (افتراضاً مشتقّ من repair.rs)
  --asset-url-base=<url>   تجاوز أساس روابط الأصول (افتراضاً ASSET_BASE من repair.rs)
  --timeout=<ms>           مهلة كل طلب (افتراضاً ${DEFAULT_TIMEOUT_MS})
  --quiet                  لا تطبع إلا الملخّص والمشكلات
  --selfcheck              يفحص الحارس نفسه: ضابط · مُفسَدات · صفر مدخل · ومُفسَدان عليه
  --help                   هذه الرسالة

يقيس: النشرة **ليست مسودّة** · كل أصل متوقَّع في COMPONENTS (‏repair.rs) **معلَن**
في النشرة · بصمته المعلنة تطابق المثبَّتة · ورابطه العلني يردّ **200**.
0 = سليم أو غياب بيئيّ متسامح · 1 = فشل · 2 = بنية/استعمال.`;

/** يبني قائمة المشكلات من سجلّ النشرة + الأصول المتوقَّعة. */
function inspectRecord(record, expected, out, opts) {
  // ③ المسودّة أولاً: رسالتها هي سبب 404 الجماعي، فلا تُدفن تحت أثرها.
  if (record.draft === true) out.problems.push(draftProblem(record));

  const published = new Map();
  for (const a of record.assets) {
    if (!published.has(a.name)) published.set(a.name, a);
  }
  for (const c of expected) {
    const asset = published.get(c.asset);
    if (!asset) {
      out.problems.push({
        kind: 'أصل مفقود',
        name: c.asset,
        why:
          `النشرة ${record.tag ?? ''} لا تعلن هذا الأصل (المعلَن: ${record.assets.length}: ` +
          `${record.assets.map((a) => a.name).join(' · ') || 'لا شيء'}) — التطبيق يطلبه بـ sha256 ${c.sha256.slice(0, 12)}…`,
      });
      continue;
    }
    out.members.push({ name: c.asset, size: asset.size });
    // ④ البصمة المعلنة: حضورها مخالفةً سقوط، وغيابها إشعار (واجهة أقدم).
    const digest = asset.digest ? asset.digest.replace(/^sha256:/i, '').toLowerCase() : null;
    if (digest === null) {
      out.notes.push({ name: c.asset, why: 'النشرة لا تعلن digest لهذا الأصل — لم أستطع مقابلة البصمة (لا حكم)' });
    } else if (digest !== c.sha256) {
      out.problems.push({
        kind: 'بصمة مخالفة',
        name: c.asset,
        why:
          `بصمة الأصل المعلنة (${digest.slice(0, 16)}…) لا تطابق المثبَّتة في repair.rs ` +
          `(${c.sha256.slice(0, 16)}…) — البايتات المشحونة ليست التي يتحقّق منها التطبيق`,
      });
    } else {
      out.digests.push({ name: c.asset, digest });
    }
  }
}

async function run(opts) {
  const { channel, expected } = readExpectations(opts.repo);
  const apiUrl = opts.apiUrl ?? `https://api.github.com/repos/${channel.owner}/${channel.repo}/releases/tags/${channel.tag}`;
  const urlBase = opts.assetUrlBase ?? channel.assetBase;
  const urls = new Map(expected.map((c) => [c.asset, assetUrl(urlBase, c.asset)]));

  if (!opts.quiet) {
    console.log(
      `ℹ القناة: ${channel.owner}/${channel.repo}@${channel.tag} — ${expected.length} أصلاً متوقَّعاً من ` +
        `${REPAIR_RS_REL} (COMPONENTS)`
    );
    console.log(`ℹ الوضع: ${opts.strict ? 'التسليم (--strict)' : 'الافتراضيّ/CI'} · السجلّ: ${apiUrl}`);
  }

  const out = { problems: [], env: [], members: [], digests: [], live: [], notes: [] };
  const result = await readReleaseRecord({ ...opts, apiUrl });

  let record = null;
  if (result.state === 'ok') {
    record = result.record;
  } else if (result.state === 'missing-tag') {
    out.problems.push({
      kind: 'وسم مفقود',
      name: `${channel.owner}/${channel.repo}@${channel.tag}`,
      why: `${result.why} — القناة التي ينزّل منها التطبيق غير موجودة (${apiUrl})`,
    });
  } else {
    out.env.push({ name: 'سجلّ النشرة', url: result.source, why: result.why });
  }

  if (record) {
    inspectRecord(record, expected, out, opts);
    // ⑤ الحياة تُقاس لكل أصل معلن — ولو نقص أصل فالرابط المفقود يُقاس أيضاً،
    //    لأن 404 هو الدليل المباشر على العطل الذي وُلد الحارس لأجله.
    await checkLiveness(expected, urls, opts, out);
  }

  if (!opts.quiet) {
    if (record) {
      console.log(
        `ℹ السجلّ: مسودّة=${record.draft} · أصول معلنة=${record.assets.length}` +
          `${record.tag ? ` · الوسم=${record.tag}` : ''}`
      );
      for (const c of expected) {
        const m = out.members.find((x) => x.name === c.asset);
        const l = out.live.find((x) => x.name === c.asset);
        const d = out.digests.find((x) => x.name === c.asset);
        console.log(
          `   ${c.asset}: ${m ? `معلَن (${m.size ?? '?'} bytes)` : '**غير معلَن**'} · ` +
            `${d ? 'بصمة مطابقة' : 'بلا مقابلة بصمة'} · ${l ? `HEAD ${l.status}` : 'بلا قياس حياة'}`
        );
      }
    }
    for (const n of out.notes) console.log(`   ⚠ ${n.name}: ${n.why}`);
  }

  if (out.env.length > 0) emitEnvironmentalNotice(out.env, opts, expected.length);

  if (out.problems.length > 0) {
    console.error(`\n✗ فشل حارس قناة الأصول (${out.problems.length} مشكلة) — القناة التي ينزّل منها التطبيق معطوبة:`);
    for (const p of out.problems) console.error(`   - [${p.kind}] ${p.name}: ${p.why}`);
    return EXIT.FAIL;
  }
  if (out.env.length > 0) {
    if (opts.strict) {
      console.error(`\n✗ وضع التسليم (--strict): لم أستطع قياس القناة (${out.env.length} موضعاً) — وغياب القياس ليس نجاحاً.`);
      for (const e of out.env) console.error(`   - ${e.name}: ${e.why}`);
      return EXIT.FAIL;
    }
    return EXIT.PASS;
  }
  console.log(
    `✓ قناة الأصول سليمة: ${record.tag ?? channel.tag} ليست مسودّة · ${out.members.length}/${expected.length} أصلاً معلَناً · ` +
      `${out.digests.length} بصمة مطابقة للمثبَّت في repair.rs · ${out.live.length} رابطاً يردّ 200`
  );
  return EXIT.PASS;
}

// ---------------------------------------------------------------------------
// الفحص الذاتي: الحارس يُقاس بمُفسَداته وبضابطه وبصفر مدخله
// ---------------------------------------------------------------------------

/** مستودع مصنوع: `repair.rs` بمكوّنات يعطيها النداء.
 *  `noComponents` ⇒ جدول **فارغ** (`&[` ثم `];` — كجدول حقيقي أُفرغ)،
 *  و`absentComponents` ⇒ الكتلة **غائبة** أصلاً، و`noBase` ⇒ بلا ASSET_BASE. */
function writeFixtureRepo(dir, components, { noComponents = false, absentComponents = false, noBase = false } = {}) {
  const base = 'https://github.com/Fixture/Repo/releases/download/assets-v1';
  const entries = components
    .map(
      (c) =>
        `    Component {\n        key: "${c.key}",\n        asset: "${c.asset}",\n` +
        `        local: "${c.local}",\n        sha256: "${c.sha256}",\n        subdir: "${c.subdir}",\n` +
        `        label: "مصنوع",\n    },`
    )
    .join('\n');
  const table = absentComponents
    ? 'pub const SOMETHING_ELSE: &[Component] = &[];\n'
    : noComponents
      ? 'pub const COMPONENTS: &[Component] = &[\n];\n'
      : `pub const COMPONENTS: &[Component] = &[\n${entries}\n];\n`;
  const src = (noBase ? '' : `pub const ASSET_BASE: &str = "${base}";\n\n`) + table;
  const p = path.join(dir, REPAIR_RS_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, src);
  return dir;
}

function sha(seed) {
  // بصمة مصنوعة ثابتة (64 خانة) — لا علاقة لها بأي ملف حقيقي.
  return seed.repeat(64).slice(0, 64);
}

const FIXTURE_COMPONENTS = [
  { key: 'ffmpeg', asset: 'ffmpeg-lgpl.exe', local: 'ffmpeg.exe', subdir: 'bin', sha256: sha('a') },
  { key: 'ffprobe', asset: 'ffprobe-lgpl.exe', local: 'ffprobe.exe', subdir: 'bin', sha256: sha('b') },
  { key: 'yt-dlp', asset: 'yt-dlp.exe', local: 'yt-dlp.exe', subdir: 'bin', sha256: sha('c') },
  { key: 'model', asset: 'UVR-MDX-NET-Voc_FT.onnx', local: 'UVR-MDX-NET-Voc_FT.onnx', subdir: 'models', sha256: sha('d') },
];

/** بصمات المكوّنات المصنوعة — السجلّ السليم يعلنها، فتمرّ مقابلة البصمة. */
const FIXTURE_DIGESTS = Object.fromEntries(FIXTURE_COMPONENTS.map((c) => [c.asset, c.sha256]));

/** سجلّ نشرة مصنوع: `over` يخرب ما يشاء (`draft` · `digestFor` · `assets`). */
function fixtureRecord(names, over = {}) {
  const digestFor = over.digestFor || {};
  const assets =
    over.assets ||
    names.map((n) => ({ name: n, size: 1024, digest: `sha256:${digestFor[n] ?? 'a'.repeat(64)}` }));
  return JSON.stringify({ draft: false, prerelease: false, tag_name: 'assets-v1', ...over, assets });
}

/** خادم أصول محلي: 200 لكل اسم في `alive`، و404 لغيره. */
function startAssetServer(alive) {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(String(req.url || '').replace(/^\/+/, ''));
      hits.push(`${req.method} ${name}`);
      if (alive.has(name)) {
        res.writeHead(200, { 'content-length': '1024' });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits }));
  });
}

/** يشغّل هذا الملف (أو نسخة منه) ويرد رمز الخروج والمخرَج — بلا حجب حلقة الأحداث. */
function runGuard(scriptPath, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: cwd || ROOT,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (out += d.toString('utf8')));
    child.on('error', (err) => resolve({ status: null, out: `spawn error: ${err.message}` }));
    child.on('close', (status) => resolve({ status, out }));
  });
}

async function selfcheck() {
  const os = require('node:os');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-release-assets-'));
  const cases = [];
  const names = FIXTURE_COMPONENTS.map((c) => c.asset);
  const { server, port, hits } = await startAssetServer(new Set(names));
  const urlBase = `http://127.0.0.1:${port}`;
  const alive = () => hits.length > 0;
  const before = hits.length;

  const addCase = (label, expected, res, mustText) => {
    const problems = [];
    if (res.status !== expected) problems.push(`رمز الخروج ${res.status} بدل ${expected}`);
    for (const t of mustText || []) if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    cases.push({ label, ok: problems.length === 0, detail: problems.join(' · '), out: res.out });
    return problems.length === 0;
  };

  const mkRepo = (name, components, flags) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    writeFixtureRepo(dir, components, flags);
    return dir;
  };
  const mkJson = (name, text) => {
    const p = path.join(work, name);
    fs.writeFileSync(p, text);
    return p;
  };
  const baseArgs = (dir, json) => [`--repo=${dir}`, `--asset-url-base=${urlBase}`, `--release-json=${json}`, '--quiet'];

  try {
    /* Ⓐ ضابط: أربعة أصول معلنة بروابط حيّة ⇒ 0، **وقد رأى أربعة** (لا مرور بالعمى). */
    {
      const dir = mkRepo('control', FIXTURE_COMPONENTS);
      const json = mkJson('control.json', fixtureRecord(names, { digestFor: FIXTURE_DIGESTS }));
      const h0 = hits.length;
      const res = await runGuard(__filename, baseArgs(dir, json));
      const seen = hits.length - h0;
      const problems = [];
      if (res.status !== EXIT.PASS) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.PASS}`);
      for (const t of ['قناة الأصول سليمة', '4/4 أصلاً معلَناً', '4 بصمة مطابقة', '4 رابطاً يردّ 200']) {
        if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
      }
      if (seen !== 4) problems.push(`الخادم رأى ${seen} طلباً بدل 4 — الحارس لم يزر كل أصل`);
      cases.push({ label: 'Ⓐ ضابط: 4 أصول معلنة بروابط 200 وبصمات مطابقة ⇒ 0', ok: problems.length === 0, detail: problems.join(' · '), out: res.out });
    }

    /* Ⓑ مُفسَد (أ): اسم أصل مُختلق يُضاف إلى القائمة المتوقَّعة (والسجلّ لا يعلنه)
       ⇒ يسقط بالعضوية. والمُفسَد حقيقي: الجدول في repair.rs هو ما تغيّر. */
    {
      const bogus = { key: 'bogus', asset: 'ffmpeg-bogus.exe', local: 'bogus.exe', subdir: 'bin', sha256: sha('e') };
      const dir = mkRepo('bogus-membership', [...FIXTURE_COMPONENTS, bogus]);
      const json = mkJson('bogus.json', fixtureRecord(names));
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase(
        'Ⓑ مُفسَد (أ): اسم أصل مُختلق في القائمة المتوقَّعة والسجلّ لا يعلنه ⇒ يسقط',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس قناة الأصول', '[أصل مفقود] ffmpeg-bogus.exe', 'لا تعلن هذا الأصل']
      );
    }

    /* Ⓑ′ مُفسَد: الاسم المُختلق **يُعلنه السجلّ** (فالعضوية تمرّ) ورابطه 404
       ⇒ لا يسقطه إلا **فحص الحياة** — وهو عطل 0.2.8 نفسه (قناة تعلن ولا تُخدَم). */
    {
      const bogus = { key: 'bogus', asset: 'nope-404.exe', local: 'bogus.exe', subdir: 'bin', sha256: sha('e') };
      const dir = mkRepo('bogus-live', [...FIXTURE_COMPONENTS, bogus]);
      const json = mkJson('bogus-live.json', fixtureRecord([...names, 'nope-404.exe'], { digestFor: { ...FIXTURE_DIGESTS, 'nope-404.exe': sha('e') } }));
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase(
        'Ⓑ′ مُفسَد: أصل معلَن ورابطه 404 (عطل 0.2.8 نفسه) ⇒ يسقط بفحص الحياة',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس قناة الأصول', '[رابط ميت] nope-404.exe', 'HTTP 404']
      );
    }

    /* Ⓒ مُفسَد (ب): محاكاة مسودّة — كل الأصول معلنة وروابطها 200، والمسودّة وحدها
       هي العطل ⇒ يجب أن يسقط في **الوضعين** (المسودّة ليست غياباً بيئياً). */
    {
      const dir = mkRepo('draft', FIXTURE_COMPONENTS);
      const json = mkJson('draft.json', fixtureRecord(names, { draft: true, digestFor: FIXTURE_DIGESTS }));
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase('Ⓒ مُفسَد (ب): النشرة مسودّة ⇒ يسقط في الوضع الافتراضيّ', EXIT.FAIL, res, ['[مسودّة]', 'مسودّة']);
      const resStrict = await runGuard(__filename, [...baseArgs(dir, json), '--strict']);
      addCase('Ⓒ′ المسودّة نفسها في --strict ⇒ تسقط أيضاً', EXIT.FAIL, resStrict, ['[مسودّة]']);
    }

    /* Ⓔ مُفسَد: بصمة معلنة مخالفة للمثبَّتة (البايتات المشحونة ليست التي يتحقّق منها
       التطبيق) ⇒ يسقط. والثلاثة الأخرى مطابقة عمداً: ليكون السقوط بسبب البصمة وحدها. */
    {
      const dir = mkRepo('digest', FIXTURE_COMPONENTS);
      const json = mkJson('digest.json', fixtureRecord(names, { digestFor: { ...FIXTURE_DIGESTS, 'yt-dlp.exe': sha('f') } }));
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase('Ⓔ مُفسَد: بصمة معلنة مخالفة للمثبَّتة ⇒ يسقط', EXIT.FAIL, res, ['[بصمة مخالفة] yt-dlp.exe']);
    }

    /* Ⓕ/Ⓖ الوضعان بلا شبكة: واجهة على منفذ لا يخدمه أحد (127.0.0.1:1). */
    {
      const dir = mkRepo('offline', FIXTURE_COMPONENTS);
      const dead = 'http://127.0.0.1:1/api/releases/tags/assets-v1';
      const args = [`--repo=${dir}`, `--api-url=${dead}`, `--asset-url-base=${urlBase}`, '--quiet', '--timeout=4000'];
      const soft = await runGuard(__filename, args);
      addCase(
        'Ⓕ مُفسَد (د): بلا شبكة + الوضع الافتراضيّ ⇒ 0 **مع السطر الصارخ**',
        EXIT.PASS,
        soft,
        ['⚠ غياب بيئيّ', 'لم أستطع قياس القناة', 'ليست شهادة قبول', 'القبول يشترط `--strict`', 'التسامح بيئيّ لا دلاليّ']
      );
      const strict = await runGuard(__filename, [...args, '--strict']);
      addCase('Ⓖ مُفسَد (ج): بلا شبكة + --strict ⇒ يسقط', EXIT.FAIL, strict, ['✗ وضع التسليم', 'غياب القياس ليس نجاحاً']);
    }

    /* Ⓗ/Ⓘ صفر مدخل: جدول مكوّنات فارغ · وغياب ASSET_BASE ⇒ فشل بنيوي مسمّى (2).
       والواجهة موجَّهة إلى منفذ ميت عمداً: لو تجاوز الحارس البنية إلى الشبكة لبان. */
    {
      const dead = '--api-url=http://127.0.0.1:1/x';
      const dir = mkRepo('empty-table', [], { noComponents: true });
      const res = await runGuard(__filename, [`--repo=${dir}`, dead, '--quiet']);
      addCase('Ⓗ صفر مدخل: COMPONENTS فارغ ⇒ فشل بنيوي (2)', EXIT.MISUSE, res, ['✗', 'صفر مكوّن']);
      const dirTable = mkRepo('no-table', FIXTURE_COMPONENTS, { absentComponents: true });
      const resTable = await runGuard(__filename, [`--repo=${dirTable}`, dead, '--quiet']);
      addCase('Ⓗ′ صفر مدخل: كتلة COMPONENTS غائبة ⇒ فشل بنيوي (2)', EXIT.MISUSE, resTable, ['✗', 'لم أقرأ COMPONENTS']);
      const dir2 = mkRepo('no-base', FIXTURE_COMPONENTS, { noBase: true });
      const res2 = await runGuard(__filename, [`--repo=${dir2}`, dead, '--quiet']);
      addCase('Ⓘ صفر مدخل: ASSET_BASE غائب ⇒ فشل بنيوي (2)', EXIT.MISUSE, res2, ['✗', 'لم أقرأ ASSET_BASE']);
    }

    /* Ⓠ مُفسَدات على الحارس نفسه: كل واحد يحذف **فحصاً واحداً** من نسخة، ويُقاس أن
       الحالة التي يمسكها ذلك الفحص **تمرّ** على النسخة المطموسة — أي أن حذف الفحص
       يُسقط فحصاً، فهو محروس لا تجميلي. (نمط Ⓠ في `matrix-check.cjs`.)
       وبيانات كل حالة مضبوطة عمداً: البصمات مطابقة والمواقع حيّة، فلا يبقى في
       النسخة المطموسة سببٌ للسقوط غير الفحص المحذوف. */
    const MUTANTS = [
      {
        label: 'Ⓠ نسخة بلا فحص الحياة ⇒ المُفسَد (رابط 404) يمرّ عليها',
        call: LIVENESS_CALL,
        replacement: LIVENESS_CALL_REMOVED,
        repo: [...FIXTURE_COMPONENTS, { key: 'bogus', asset: 'nope-404.exe', local: 'bogus.exe', subdir: 'bin', sha256: sha('e') }],
        json: () => fixtureRecord([...names, 'nope-404.exe'], { digestFor: { ...FIXTURE_DIGESTS, 'nope-404.exe': sha('e') } }),
        forbid: [],
      },
      {
        label: 'Ⓠ′ نسخة بلا فحص المسودّة ⇒ المُفسَد (مسودّة) يمرّ عليها',
        call: DRAFT_CALL,
        replacement: DRAFT_CALL_REMOVED,
        repo: FIXTURE_COMPONENTS,
        json: () => fixtureRecord(names, { draft: true, digestFor: FIXTURE_DIGESTS }),
        forbid: [],
      },
      {
        label: 'Ⓠ″ نسخة بلا السطر الصارخ ⇒ الغياب البيئيّ يُسكَت (والوضع يبقى 0)',
        call: ENV_NOTICE_CALL,
        replacement: ENV_NOTICE_CALL_REMOVED,
        repo: FIXTURE_COMPONENTS,
        json: null, // بلا سجلّ نشرة: الحالة Ⓕ نفسها (لا شبكة)
        forbid: ['غياب بيئيّ', 'ليست شهادة قبول'],
      },
    ];
    const src = fs.readFileSync(__filename, 'utf8');
    for (const m of MUTANTS) {
      const problems = [];
      // شرط البنية: النصّ يجب أن يظهر **مرتين على الأقل** — إعلاناً و**موضع نداء**.
      // ظهوره مرة واحدة يعني أنه نصّ في الإعلان لا يطابق أي نداء، فطمسه لا يغيّر
      // سلوك الحارس ويصير «مُفسَداً باطلاً» يُثبت نجاحاً كاذباً (وقع فعلاً هنا).
      const occurrences = src.split(m.call).length - 1;
      if (occurrences < 2) {
        problems.push(
          `مُفسَد باطل — النصّ «${m.call}» يظهر ${occurrences} مرة، ولا بدّ من إعلان + موضع نداء`
        );
      } else {
        const mutant = path.join(work, `mutant-${cases.length}.cjs`);
        const text = src.split(m.call).join(m.replacement);
        if (text === src) problems.push('مُفسَد لم يغيّر الحارس');
        fs.writeFileSync(mutant, text);
        const dir = mkRepo(`mutant-repo-${cases.length}`, m.repo);
        const args = m.json
          ? baseArgs(dir, mkJson(`mutant-${cases.length}.json`, m.json()))
          : [`--repo=${dir}`, '--api-url=http://127.0.0.1:1/x', '--quiet', '--timeout=4000'];
        const res = await runGuard(mutant, args);
        if (res.status !== EXIT.PASS) {
          problems.push(
            `النسخة المطموسة رجعت ${res.status} بدل ${EXIT.PASS} — أي أن الفحص المحذوف ليس هو ما يمسك العطل`
          );
        }
        for (const t of m.forbid) {
          if (res.out.includes(t)) problems.push(`النسخة المطموسة ما زالت تطبع «${t}» — الحذف لم يقع`);
        }
      }
      cases.push({ label: m.label, ok: problems.length === 0, detail: problems.join(' · '), out: '' });
    }
  } finally {
    server.close();
  }

  const bad = cases.filter((c) => !c.ok);
  console.log(`\nالفحص الذاتي لحارس قناة الأصول — ${cases.length} حالة:`);
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : `\n      ${c.detail}`}`);
  if (!alive()) {
    console.error('✗ الفحص الذاتي لم يزر الخادم المحلي ولا مرة — القياس لم يقع');
    fs.rmSync(work, { recursive: true, force: true });
    return EXIT.MISUSE;
  }
  console.log(`  (الخادم المحلي رأى ${hits.length - before} طلباً — فالقياس وقع فعلاً)`);
  fs.rmSync(work, { recursive: true, force: true });
  if (bad.length > 0) {
    console.error(`\n✗ الفحص الذاتي سقط في ${bad.length} حالة من ${cases.length}`);
    return EXIT.FAIL;
  }
  console.log('✓ الحارس يمرّ على الضابط ويسقط على كل مُفسَد — وفيه مُفسَد على نفسه.');
  return EXIT.PASS;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return EXIT.PASS;
  }
  if (opts.selfcheck) return selfcheck();
  return run(opts);
}

if (require.main === module) {
  main()
    .then((code) => {
      // `process.exitCode` لا `process.exit()`: الخروج بـ`exit` و`fetch` معلّق
      // يُسقط Node على ويندوز بـlibuv assertion (فخّ مسجَّل في AGENT.md §١٥).
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`✗ ${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = err instanceof GuardError ? err.code : EXIT.FAIL;
    });
}

module.exports = {
  parseChannel,
  readExpectations,
  normalizeRecord,
  assetUrl,
  LIVENESS_CALL,
  DRAFT_CALL,
  ENV_NOTICE_CALL,
};
