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
 * **وعقد ثانٍ أُضيف في 0.2.9 — قناة CUDA** (`assets-v1` تحمل ٢١ أصلاً لا أربعة):
 * كان هذا الحارس **صادقاً على قائمة ناقصة**: بنى توقّعاته من `repair::COMPONENTS`
 * وحده (أربعة)، ولم يعرف أن **التطبيق يطلب أيضاً** `cuda-runtime-manifest.json`
 * ثم **ستة عشر** ملف CUDA بأعيانها. فمرّ الحارس بقناة **مانيفستها 404** وكل
 * دلّالات CUDA فيها 404 ⇒ **زرّ CUDA معطّل لكل مستخدم جديد** (عطل القناة المقيس ·
 * `docs/AUDIT.md` 2026-09-22). والآن يُقاس عقد CUDA كما يفرضه التطبيق:
 *   ⑥ `src-tauri/src/cuda_runtime.rs` ← `pub const CUDA_FILES` (**أسماء** الملفات
 *      الستة عشر) و`pub const CUDA_FILE_SHA256` (**البصمات المثبَّتة في التنفيذي**)
 *      و`MANIFEST_ASSET` (اسم المانيفست). جدول فارغ · اسم بلا بصمة · ترتيب مختلف
 *      عن `CUDA_FILES` ⇒ **فشل بنيوي (2)** — نفس عقد اختبار Rust
 *      `pinned_hashes_cover_the_file_list`.
 *   ⑦ **المانيفست**: يُجلب من `{ASSET_BASE}/<MANIFEST_ASSET>` (نفس المنبع الذي
 *      يقرؤه التطبيق) ⇒ **200 · JSON صالح بحقل `files[].name`**؛ و404 هنا هو
 *      العطل نفسه («مكتبات التسريع لم تُنشر بعد» ⇒ الزرّ معطّل). ومانيفست تالف
 *      أو بلا `files[]` **سقوط** كذلك: التطبيق يردّ «منفست تالف» ولا ينزّل شيئاً.
 *   ⑧ **الاكتمال والقبول**: كل اسم في `CUDA_FILES` **حاضر** في المانيفست (وإلا
 *      «ينقص المنفست: …»)، وكل مدخل في `files[]` له **بصمة مثبَّتة** في التطبيق
 *      (`pinned_sha` — وإلا «ملف في المنفست بلا بصمة مثبَّتة في التطبيق»)، واسمه
 *      اسم ملف مجرّد. ولاستحالة تنزيل ٢٫٣ جيجابايت في CI، تُقابَل **البصمة
 *      المعلنة** (`sha256` في المانيفست و`asset.digest` في السجلّ — كلتاهما من
 *      GitHub على البايتات المرفوعة) بالمثبَّتة، ويُقابَل طول `HEAD` بالحجم
 *      المعلَن: ثلاث إشارات مستقلّة على البايتات بلا تنزيل بايت واحد منها.
 *   ⑨ **الحياة**: `HEAD` على كل اسم من `CUDA_FILES` ⇒ **200** بالضبط.
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
 * **ومُفسَدات عقد CUDA** (كلها بخادم محلي بلا شبكة): مانيفست **ناقص اسماً** ⇒ سقوط ·
 * مانيفست يحمل اسماً **زائداً بلا بصمة مثبَّتة** ⇒ سقوط · ملف من الستة عشر **404** ⇒
 * سقوط · مانيفست **بلا `files`** أو **JSON تالف** ⇒ سقوط · مانيفست **404** ⇒ سقوط
 * (وهو العطل الأصلي بعينه) · **حجم مخالف** للإعلان ⇒ سقوط · وكلها سليمة ⇒ مرور
 * (الضابط). وأربعة مُفسَدات على الحارس نفسه تحذف فحصاً واحداً لكل واحد (اكتمال
 * المانيفست · قبول مداخله · تصنيف نتيجة جلبه · حياة الستة عشر) وتُثبت أن المُفسَد
 * المعنيّ **يمرّ** عليها.
 *
 * **و`CUDA_SHA_GUARD` في السير** يُقاس **بنصّه المشحون**: يُستخرج من
 * `.github/workflows/cuda-assets.yml` (كما يفعل `check-cuda-assets.cjs` مع قاعدة
 * PE) ويُشغَّل في pwsh على مستودع مصنوع: ضابط يمرّ · بايت منحرف يسقط · ملف ناقص
 * يسقط · جدول بصمات غائب يسقط · مجلد فارغ يسقط. وهذا **لا** يجعل السير مُشغَّلاً في
 * Actions (ذاك يحتاج دفعاً) — لكنه يقيس أن النصّ المشحون يفعل ما وُعد به.
 *
 * بلا اعتماديات npm: `node:fs` · `node:path` · `node:http` · `node:crypto` ·
 * `node:child_process` و`fetch` المدمج وحدهما.
 *
 * الاستعمال: node scripts/check-release-assets.cjs [خيارات]
 *   0 = سليم (أو غياب بيئيّ في الوضع المتسامح) · 1 = فشل · 2 = بنية/استعمال.
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const EXIT = { PASS: 0, FAIL: 1, MISUSE: 2 };

const ROOT = path.resolve(__dirname, '..');
const REPAIR_RS_REL = path.join('src-tauri', 'src', 'repair.rs');
const CUDA_RS_REL = path.join('src-tauri', 'src', 'cuda_runtime.rs');
const WORKFLOW_REL = path.join('.github', 'workflows', 'cuda-assets.yml');
const SHA_RE = /^[0-9a-f]{64}$/;
/** اسم أصل آمن = اسم ملف مجرّد (نفس قاعدة `cuda_runtime.rs::asset_name_ok`). */
const SAFE_NAME_RE = /^[A-Za-z0-9_.-]+$/;
/** مدخل بصمة في `CUDA_FILE_SHA256`: يتحمّل فاصلة أخيرة وسطراً جديداً بين الطرفين. */
const CUDA_SHA_TUPLE_RE = /\(\s*"([^"]+)"\s*,\s*"([0-9a-fA-F]{64})"\s*,?\s*\)/g;
/** وسما نصّ حارس البصمات في السير — يُقاس النصّ المشحون لا نسخة ثانية هنا. */
const SHA_GUARD_BEGIN = '# >>> CUDA_SHA_GUARD:BEGIN';
const SHA_GUARD_END = '# <<< CUDA_SHA_GUARD:END';
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
 * @param {string} root جذر المستودع.
 * @param {{skipComponents?:boolean}} [o] `skipComponents` (وضع `--cuda-only`) يعطي
 *   `expected: []` بلا مطالبة بجدول COMPONENTS — فما لا يُقاس لا يُشترط.
 * @returns {{channel:object, expected:Array<{key:string,asset:string,local:string,subdir:string,sha256:string}>}}
 */
function readExpectations(root, o = {}) {
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
  if (o.skipComponents) return { channel, expected: [] };

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
// ①ب مصدر قائمة CUDA: cuda_runtime.rs (العقد الذي لم يعرفه الحارس قبل 0.2.9)
// ---------------------------------------------------------------------------

/**
 * يقرأ من `cuda_runtime.rs` ما **يطلبه التطبيق فعلاً**:
 *   · `CUDA_FILES` — الأسماء الستة عشر التي يشترطها `install()` في المانيفست.
 *   · `CUDA_FILE_SHA256` — البصمات المثبَّتة في التنفيذي (`pinned_sha`): كل مدخل
 *     في المانيفست بلا واحدة منها يرفضه التطبيق.
 *   · `MANIFEST_ASSET` — اسم المانيفست على القناة.
 *
 * والأربعة الأخلاقية محفوظة كما في `repair::COMPONENTS`: **من الكود لا من رأس
 * أحد**، وجدول فارغ أو مشوّه ⇒ **فشل بنيوي (2)** لا مرور.
 *
 * @returns {{files:string[], pinned:Map<string,string>, ordered:Array<[string,string]>, manifestAsset:string}}
 */
function readCudaExpectations(root) {
  const rsPath = path.join(root, CUDA_RS_REL);
  if (!fs.existsSync(rsPath)) {
    throw new GuardError(`بنية غير صالحة: ${CUDA_RS_REL} غير موجود عند ${rsPath}`);
  }
  const src = fs.readFileSync(rsPath, 'utf8');

  const filesBlock = sliceConst(src, 'pub const CUDA_FILES');
  if (filesBlock === null) {
    throw new GuardError(
      `لم أقرأ CUDA_FILES من ${CUDA_RS_REL} — تغيّر اسم الثابت؟ لا أسماء أفحصها، فلا نجاح.`
    );
  }
  const files = [...filesBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (files.length === 0) {
    // «صفر اسم متوقَّع» ليس قناةً سليمة: حارس لا يرى ليس حارساً (كما في COMPONENTS).
    throw new GuardError(
      `CUDA_FILES في ${CUDA_RS_REL} صفر اسم — لا شيء أتحقّق منه، وهذا فشل بنيوي لا نجاح.`
    );
  }

  const pinnedBlock = sliceConst(src, 'pub const CUDA_FILE_SHA256');
  if (pinnedBlock === null) {
    throw new GuardError(
      `لم أقرأ CUDA_FILE_SHA256 من ${CUDA_RS_REL} — بلا البصمات المثبَّتة لا أعرف ما يقبله التطبيق.`
    );
  }
  const ordered = [...pinnedBlock.matchAll(CUDA_SHA_TUPLE_RE)].map((m) => [m[1], m[2].toLowerCase()]);
  if (ordered.length === 0) {
    throw new GuardError(
      `CUDA_FILE_SHA256 في ${CUDA_RS_REL} صفر بصمة — جدول فارغ لا يقبل مدخلاً واحداً، فلا نجاح.`
    );
  }
  const pinned = new Map(ordered);

  const manifestMatch = /\bMANIFEST_ASSET\s*:\s*&str\s*=\s*"([^"]+)"/.exec(src);
  if (!manifestMatch) {
    throw new GuardError(
      `لم أقرأ MANIFEST_ASSET من ${CUDA_RS_REL} — لا أعرف أي ملف مانيفست أجلب من القناة.`
    );
  }
  const manifestAsset = manifestMatch[1];

  const seenFiles = new Set();
  for (const name of files) {
    if (!SAFE_NAME_RE.test(name)) throw new GuardError(`اسم غير آمن في CUDA_FILES: ${name}`);
    if (seenFiles.has(name)) throw new GuardError(`اسم مكرَّر في CUDA_FILES: ${name}`);
    seenFiles.add(name);
    // عقد `pinned_sha`: بلا بصمة مثبَّتة يرفض التطبيق الملف مهما كان اسمه.
    if (!pinned.has(name)) {
      throw new GuardError(
        `CUDA_FILES يطلب «${name}» ولا بصمة له في CUDA_FILE_SHA256 — التطبيق سيرفض هذا المدخل ` +
          '(`install()` يردّ: «ملف في المنفست بلا بصمة مثبَّتة في التطبيق»)، فلا نجاح بنيوي هنا.'
      );
    }
  }
  const seenPinned = new Set();
  for (const [name, sha] of ordered) {
    if (!SAFE_NAME_RE.test(name)) throw new GuardError(`اسم غير آمن في CUDA_FILE_SHA256: ${name}`);
    if (!SHA_RE.test(sha)) throw new GuardError(`بصمة «${name}» ليست SHA-256 سداسية عشرية: ${sha}`);
    if (seenPinned.has(name)) throw new GuardError(`اسم مكرَّر في CUDA_FILE_SHA256: ${name}`);
    if (!seenFiles.has(name)) {
      throw new GuardError(
        `CUDA_FILE_SHA256 يحمل «${name}» وليس في CUDA_FILES — بصمة بلا مالك: جدولان افترقا.`
      );
    }
    seenPinned.add(name);
  }
  // الترتيب جزء من العقد في التطبيق نفسه: اختبار `pinned_hashes_cover_the_file_list`
  // يشترط تطابق `CUDA_FILE_SHA256[i].0` مع `CUDA_FILES[i]` — فالافتراق هنا فشل بنيوي.
  for (const [i, name] of files.entries()) {
    if (ordered[i][0] !== name) {
      throw new GuardError(
        `ترتيب CUDA_FILE_SHA256 لا يطابق CUDA_FILES عند ${i}: «${ordered[i][0]}» مقابل «${name}» — ` +
          'واختبار Rust يشترط التطابق، فهو فشل بنيوي لا تحذير.'
      );
    }
  }
  return { files, pinned, ordered, manifestAsset };
}

/**
 * نصّ كتلة بين وسمين، بإزالة الإزاحة — يُقاس **النصّ المشحون** لا نسخة ثانية هنا
 * (نفس ما يفعله `check-cuda-assets.cjs` مع قاعدة PE).
 * @returns {string|null}
 */
function extractMarkerBlock(text, begin, end) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() === begin);
  const j = lines.findIndex((l) => l.trim() === end);
  if (i < 0 || j < 0 || j <= i) return null;
  const block = lines.slice(i + 1, j);
  const indents = block.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return block.map((l) => l.slice(cut)).join('\n');
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

/** حقيبة نتائج واحدة — النداء الواحد لكل كتلة (إصلاح · CUDA) بحقيبته. */
function newBag() {
  return {
    problems: [],
    env: [],
    members: [],
    digests: [],
    live: [],
    notes: [],
    stats: { manifestNames: 0, manifestAccepted: 0, manifestSha: 0, recordSha: 0, sizeOk: 0 },
  };
}

/** يضمّ حقيبة كتلة CUDA إلى حقيبة التقرير — موضع واحد، فلا نتيجة تُنسى. */
function mergeBags(into, from) {
  for (const k of ['problems', 'env', 'members', 'digests', 'live', 'notes']) into[k].push(...from[k]);
}

/**
 * `HEAD` واحد. `redirect: 'follow'` لأن GitHub يردّ 302 إلى مضيف الكائنات،
 * و`AbortSignal.timeout` لأن تعليق الاتصال يجب أن يُسمّى مهلة لا أن يُعلّق البوّابة.
 * @returns {{status:number|null, contentLength:number|null, why:string|null}}
 */
async function headStatus(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = res.headers.get('content-length');
    const contentLength = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
    // الجسم لا يُقرأ في HEAD؛ إغلاق صريح يمنع تسريب مقبض.
    try {
      await res.body?.cancel();
    } catch {
      /* لا جسم */
    }
    return { status: res.status, contentLength, why: null };
  } catch (err) {
    const why = err && err.name === 'TimeoutError' ? `مهلة ${timeoutMs}ms` : `شبكة: ${err.message}`;
    return { status: null, contentLength: null, why };
  }
}

/**
 * زيارة كل أصل متوقَّع: 200 مرور · 404 سقوط · أي رمز آخر سقوط · خطأ شبكة غياب بيئيّ.
 * وإن حمل المدخل `declaredSize` (حجم الأصل في سجلّ النشرة) قوبل بطول `HEAD`: البايتات
 * المشحونة ليست التي وُصفت ⇒ سقوط. ولا يُنزَّل جسم — الطول وحده يكفي ليكذّب إعلاناً.
 */
async function checkLiveness(expected, urls, opts, out) {
  for (const c of expected) {
    const url = urls.get(c.asset);
    const { status, contentLength, why } = await headStatus(url, opts.timeoutMs);
    if (status === 200) {
      out.live.push({ name: c.asset, status, url, contentLength });
      if (typeof c.declaredSize === 'number') {
        if (contentLength === null) {
          out.notes.push({ name: c.asset, why: 'ردّ 200 بلا Content-Length — لم أستطع مقابلة الحجم المعلَن' });
        } else if (contentLength !== c.declaredSize) {
          out.problems.push({
            kind: 'حجم مخالف',
            name: c.asset,
            why:
              `طول الرابط ${contentLength} bytes والحجم المعلَن في السجلّ ${c.declaredSize} bytes — ` +
              `الإعلان لا يصف المخدوم، والأصل تغيّر أو الرابط ليس هو (${url})`,
          });
        } else {
          out.stats.sizeOk += 1;
        }
      }
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
// ⑦⑧⑨ عقد CUDA: المانيفست ثم الأسماء ثم البصمات ثم الحياة
// ---------------------------------------------------------------------------

/**
 * يجلب المانيفست ويتحقّق من **شكله** وحده (العضوية في الدوال التالية).
 * والتمييز مقصود كما في سجلّ النشرة:
 *   · 200 + `files[]` بأسماء نصّية ⇒ `ok`.
 *   · **404 ⇒ `missing`** — وهذا **العطل المقيس بعينه**: التطبيق يردّ «مكتبات
 *     التسريع لم تُنشر بعد» وزرّ CUDA يبقى معطّلاً عند كل مستخدم جديد. سقوط في الوضعين.
 *   · 200 وجسم **تالف** أو بلا `files[]` أو مدخل بلا `name` ⇒ `malformed` — سقوط
 *     أيضاً: التطبيق يردّ «منفست تالف» ولا ينزّل ملفاً واحداً.
 *   · 403/429/5xx/شبكة/مهلة ⇒ **غياب بيئيّ** (يُعلَن، ويسقط في `--strict`).
 */
async function fetchManifest(url, opts) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  // الرمز (إن حضر) يرفع حدّ المعدّل وحده؛ ولا يُطبع في أي مخرَج.
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    const why = err && err.name === 'TimeoutError' ? `مهلة ${opts.timeoutMs}ms` : `شبكة: ${err.message}`;
    return { state: 'env', source: url, why: `${why} (${url})` };
  }
  if (res.status === 404) {
    return { state: 'missing', source: url, why: 'HTTP 404 — المانيفست غير موجود على القناة' };
  }
  if (res.status !== 200) {
    const hint =
      res.status === 403 || res.status === 429
        ? `حدّ معدّل/منع (المتبقّي: ${res.headers.get('x-ratelimit-remaining') ?? 'غير معلوم'})`
        : res.status >= 500
          ? 'عطل خادم مؤقّت'
          : 'استجابة غير متوقَّعة';
    return { state: 'env', source: url, why: `HTTP ${res.status} — ${hint}` };
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    return { state: 'env', source: url, why: `انقطع جسم الردّ: ${err.message}` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { state: 'malformed', source: url, why: `الجسم ليس JSON صالحاً: ${err.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.files)) {
    const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw).join(' · ') : typeof raw;
    return { state: 'malformed', source: url, why: `لا حقل files[] في المانيفست (الموجود: ${keys || 'لا شيء'})` };
  }
  const files = [];
  for (const [i, e] of raw.files.entries()) {
    if (!e || typeof e !== 'object' || typeof e.name !== 'string' || e.name === '') {
      return { state: 'malformed', source: url, why: `المدخل ${i} بلا حقل name نصّي` };
    }
    files.push({ name: e.name, sha256: typeof e.sha256 === 'string' ? e.sha256.toLowerCase() : null });
  }
  if (files.length === 0) {
    return { state: 'malformed', source: url, why: 'files[] فارغ — مانيفست بلا ملف واحد' };
  }
  return { state: 'ok', source: url, manifest: { files } };
}

/**
 * يحوّل نتيجة الجلب إلى حكم — **نداء واحد** يقاس بطمسه في الفحص الذاتي: طمسُه
 * يجعل مانيفست 404/تالف **يمرّ** صامتاً، فيُثبت أن هذا النداء هو ما يمسك العطل.
 */
function reportManifestFetch(res, out) {
  if (res.state === 'ok') return;
  if (res.state === 'env') {
    out.env.push({ name: 'مانيفست CUDA', url: res.source, why: res.why });
    return;
  }
  const missing = res.state === 'missing';
  out.problems.push({
    kind: missing ? 'مانيفست مفقود' : 'مانيفست تالف',
    name: res.source,
    why: missing
      ? `${res.why} — التطبيق يردّ «مكتبات التسريع لم تُنشر بعد في المستودع (assets-v1)» ` +
        'وزرّ CUDA يبقى معطّلاً لكل مستخدم جديد (وهذا عطل القناة المقيس · docs/AUDIT.md 2026-09-22)'
      : `${res.why} — التطبيق يردّ «منفست تالف: …» ولا ينزّل ملفاً واحداً`,
  });
}

/** ⑧أ كل اسم في `CUDA_FILES` حاضر في المانيفست — وإلا «ينقص المنفست: …» عند التطبيق. */
function checkManifestCoversFiles(manifest, cuda, out) {
  const present = new Set(manifest.files.map((e) => e.name));
  for (const name of cuda.files) {
    if (present.has(name)) {
      out.stats.manifestNames += 1;
      continue;
    }
    out.problems.push({
      kind: 'مانيفست ناقص',
      name,
      why:
        `المانيفست لا يحمل هذا الاسم المتوقَّع من CUDA_FILES (${CUDA_RS_REL}) — ` +
        `التطبيق يردّ «ينقص المنفست: ${name}» ولا ينزّل شيئاً`,
    });
  }
}

/**
 * ⑧ب كل مدخل في `files[]` **يقبله التطبيق**: اسم ملف مجرّد (`asset_name_ok`) ثم
 * بصمة مثبَّتة (`pinned_sha`) — والثانية هي ما يمنع مانيفستاً مُلغَّماً بأسماء زائدة
 * (`cuda_runtime.rs:734-735`).
 */
function checkManifestEntriesAccepted(manifest, cuda, out) {
  for (const e of manifest.files) {
    if (!SAFE_NAME_RE.test(e.name)) {
      out.problems.push({
        kind: 'اسم مرفوض في المانيفست',
        name: e.name,
        why: `ليس اسم ملف مجرّداً (قاعدة asset_name_ok) — التطبيق يردّ «اسم ملف مرفوض في المنفست: ${e.name}»`,
      });
      continue;
    }
    if (!cuda.pinned.has(e.name)) {
      out.problems.push({
        kind: 'مانيفست بلا بصمة مثبَّتة',
        name: e.name,
        why:
          'مدخل في المانيفست ليس في CUDA_FILE_SHA256 — التطبيق يرفضه: «ملف في المنفست بلا ' +
          `بصمة مثبَّتة في التطبيق: ${e.name}» (cuda_runtime.rs:734-735)`,
      });
      continue;
    }
    out.stats.manifestAccepted += 1;
  }
}

/**
 * ⑧ج بصمة المانيفست المعلنة (`sha256`) مقابل المثبَّتة. التطبيق **لا يقرأ** هذه
 * البصمة (المرجع ثوابته)، لكن افتراقها دليل على أن المانيفست من **مجموعة بايتات
 * أخرى** — أو أن الثوابت تغيّرت — فأحدهما ليس ما سيُثبَّت. غيابها إشعار لا حكم.
 */
function checkManifestDigestsMatchPinned(manifest, cuda, out) {
  for (const e of manifest.files) {
    const pinned = cuda.pinned.get(e.name);
    if (!pinned) continue; // سبق أن سقط بعدم القبول
    if (e.sha256 === null) {
      out.notes.push({
        name: e.name,
        why: 'المانيفست لا يعلن sha256 لهذا المدخل — لا بصمة إعلان أقابلها (لا حكم)',
      });
      continue;
    }
    if (e.sha256 === pinned) {
      out.stats.manifestSha += 1;
      continue;
    }
    out.problems.push({
      kind: 'بصمة مانيفست مخالفة',
      name: e.name,
      why:
        `المانيفست يعلن ${e.sha256.slice(0, 16)}… والمثبَّت في CUDA_FILE_SHA256 ` +
        `${pinned.slice(0, 16)}… — المانيفست وصفُ مجموعة بايتات أخرى غير التي يقبلها التطبيق`,
    });
  }
}

/**
 * ⑧د بصمة السجلّ المعلنة (`asset.digest` — تحسبها GitHub على البايتات المرفوعة)
 * مقابل المثبَّتة: أقرب إشارة إلى **البايتات المخدومة** بلا تنزيل ٢٫٣ جيجابايت.
 * غياب الإعلان إشعار لا حكم (نفس قاعدة ④ على أصول الإصلاح).
 */
function checkCudaRecordDigests(record, cuda, out) {
  if (!record) return;
  const published = new Map();
  for (const a of record.assets) if (!published.has(a.name)) published.set(a.name, a);
  for (const name of cuda.files) {
    const asset = published.get(name);
    if (!asset) {
      out.notes.push({ name, why: 'السجلّ لا يعلن هذا الأصل — عضويته تُقاس من المانيفست وحياته من الرابط' });
      continue;
    }
    const digest = asset.digest ? asset.digest.replace(/^sha256:/i, '').toLowerCase() : null;
    const pinned = cuda.pinned.get(name);
    if (digest === null) {
      out.notes.push({ name, why: 'السجلّ لا يعلن digest لهذا الأصل — لم أستطع مقابلة البصمة (لا حكم)' });
    } else if (digest !== pinned) {
      out.problems.push({
        kind: 'بصمة السجلّ مخالفة',
        name,
        why:
          `sha256 المعلن في النشرة (${digest.slice(0, 16)}…) لا يطابق المثبَّت في cuda_runtime.rs ` +
          `(${pinned.slice(0, 16)}…) — البايتات المشحونة ليست التي يتحقّق منها التطبيق`,
      });
    } else {
      out.stats.recordSha += 1;
    }
  }
}

/**
 * ⑨ حياة الأسماء الستة عشر. والقياس **مستقلّ عن المانيفست**: ملف يجيب 404 دليل
 * مباشر على عطل القناة، ولو كان المانيفست نفسه غائباً أو تالفاً. و`declaredSizes`
 * خريطة الحجم المعلَن من سجلّ النشرة (قد تكون فارغة) — تُقابَل بطول `HEAD`.
 */
async function checkCudaLiveness(cuda, urls, opts, out, declaredSizes) {
  const entries = cuda.files.map((name) => ({
    key: name,
    asset: name,
    sha256: cuda.pinned.get(name),
    declaredSize: declaredSizes ? declaredSizes.get(name) : undefined,
  }));
  await checkLiveness(entries, urls, opts, out);
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
const ENV_NOTICE_CALL = 'emitEnvironmentalNotice(out.env, opts, expected.length + cuda.files.length);';
const ENV_NOTICE_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ″) */';

/** نداء فحص الحياة — يُحذف في الحالة Ⓠ لقياس أن الحياة هي ما يمسك الرابط الميت. */
const LIVENESS_CALL = 'await checkLiveness(expected, urls, opts, out);';
const LIVENESS_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ) */';

/** نداء فحص المسودّة — يُحذف في الحالة Ⓠ″. */
const DRAFT_CALL = "if (record.draft === true) out.problems.push(draftProblem(record));";
const DRAFT_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ″) */';

/* ونداءات عقد CUDA الأربعة — كل واحد يُحذف في نسخة، ويُقاس أن المُفسَد الذي يمسكه
   **يمرّ** على النسخة المطموسة: فحص بلا مُفسَد يقيسه زينة، وفحص لا يسقط عليه شيء
   ليس حارساً. (ونصّ كل نداء يظهر مرتين: إعلاناً هنا وموضع نداء في `run` — وهو
   شرط البنية في حلقة المُفسَدات أدناه.) */
const MANIFEST_FETCH_CALL = 'reportManifestFetch(manifestRes, cudaOut);';
const MANIFEST_FETCH_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ‴) */';
const MANIFEST_COVERS_CALL = 'checkManifestCoversFiles(cudaManifest, cuda, cudaOut);';
const MANIFEST_COVERS_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ⁗) */';
const MANIFEST_ENTRIES_CALL = 'checkManifestEntriesAccepted(cudaManifest, cuda, cudaOut);';
const MANIFEST_ENTRIES_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ⁵) */';
const CUDA_LIVENESS_CALL = 'await checkCudaLiveness(cuda, cudaUrls, opts, cudaOut, declaredSizes);';
const CUDA_LIVENESS_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ⁶) */';

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
    cudaOnly: false,
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
    else if (arg === '--cuda-only') opts.cudaOnly = true;
    else if (arg.startsWith('--selfcheck-dump=')) opts.selfcheckDump = arg.slice('--selfcheck-dump='.length);
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
  --cuda-only              اقصر على عقد CUDA (المانيفست + الأسماء الستة عشر) وتجاهل COMPONENTS
  --quiet                  لا تطبع إلا الملخّص والمشكلات
  --selfcheck              يفحص الحارس نفسه: ضابط · مُفسَدات · صفر مدخل · ومُفسَدان عليه
  --selfcheck-dump=<file>  يكتب مع الفحص الذاتي ملفاً بمخرَج كل حالة حرفياً (دليل مراجعة)
  --help                   هذه الرسالة

يقيس: النشرة **ليست مسودّة** · كل أصل متوقَّع في COMPONENTS (‏repair.rs) **معلَن**
في النشرة · بصمته المعلنة تطابق المثبَّتة · ورابطه العلني يردّ **200**.
**وعقد CUDA**: المانيفست (‏MANIFEST_ASSET من cuda_runtime.rs) يجيب 200 ويحمل **كل**
اسم من CUDA_FILES · وكل مدخل فيه له بصمة مثبَّتة في CUDA_FILE_SHA256 · وبصمته المعلنة
وحجمه المعلَن يطابقان المخدوم · وكل اسم من الستة عشر يجيب **200**.
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
  const { channel, expected } = readExpectations(opts.repo, { skipComponents: opts.cudaOnly });
  // عقد CUDA يُقرأ دائماً: قناته هي `ASSET_BASE` نفسه، وقائمته من cuda_runtime.rs.
  const cuda = readCudaExpectations(opts.repo);
  const apiUrl = opts.apiUrl ?? `https://api.github.com/repos/${channel.owner}/${channel.repo}/releases/tags/${channel.tag}`;
  const urlBase = opts.assetUrlBase ?? channel.assetBase;
  const urls = new Map(expected.map((c) => [c.asset, assetUrl(urlBase, c.asset)]));
  const cudaUrls = new Map(cuda.files.map((name) => [name, assetUrl(urlBase, name)]));
  const manifestUrl = assetUrl(urlBase, cuda.manifestAsset);

  if (!opts.quiet) {
    console.log(
      `ℹ القناة: ${channel.owner}/${channel.repo}@${channel.tag} — ` +
        (opts.cudaOnly
          ? `وضع CUDA فقط (لم أقِس COMPONENTS)`
          : `${expected.length} أصلاً متوقَّعاً من ${REPAIR_RS_REL} (COMPONENTS)`) +
        ` · و${cuda.files.length} اسماً من ${CUDA_RS_REL} (CUDA_FILES) + المانيفست ${cuda.manifestAsset}`
    );
    console.log(`ℹ الوضع: ${opts.strict ? 'التسليم (--strict)' : 'الافتراضيّ/CI'} · السجلّ: ${apiUrl}`);
  }

  const out = newBag();
  const cudaOut = newBag();
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
  // عدد روابط كتلة الإصلاح **قبل** ضمّ كتلة CUDA: الملخّص يفصل الكتلتين فلا يخلط
  // أربعة بستة عشر (وهو الخلط الذي أخفى العطل أول مرة).
  const repairLive = out.live.length;

  // ⑥⑦⑧⑨ عقد CUDA — يقاس ولو تعذّر سجلّ النشرة: المانيفست والروابط تُقرأ من
  //    القناة مباشرة، وغياب القياس لا يبرّر إسكات قناة نصف التطبيق.
  const declaredSizes = new Map();
  if (record) for (const a of record.assets) if (!declaredSizes.has(a.name)) declaredSizes.set(a.name, a.size);

  const manifestRes = await fetchManifest(manifestUrl, opts);
  reportManifestFetch(manifestRes, cudaOut);
  const cudaManifest = manifestRes.manifest ?? null;
  if (cudaManifest) {
    checkManifestCoversFiles(cudaManifest, cuda, cudaOut);
    checkManifestEntriesAccepted(cudaManifest, cuda, cudaOut);
    checkManifestDigestsMatchPinned(cudaManifest, cuda, cudaOut);
  }
  await checkCudaLiveness(cuda, cudaUrls, opts, cudaOut, declaredSizes);
  checkCudaRecordDigests(record, cuda, cudaOut);
  mergeBags(out, cudaOut);

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
    console.log(
      `ℹ كتلة CUDA: ${cuda.files.length} اسماً · المانيفست ${cuda.manifestAsset} — ` +
        `${manifestRes.state === 'ok' ? 'مقروء' : `**${manifestRes.state}**: ${manifestRes.why}`}`
    );
    const manifestNames = new Set(cudaManifest ? cudaManifest.files.map((e) => e.name) : []);
    for (const name of cuda.files) {
      const l = cudaOut.live.find((x) => x.name === name);
      const inManifest = cudaManifest ? (manifestNames.has(name) ? 'في المانيفست' : '**غائب عن المانيفست**') : 'بلا مانيفست';
      console.log(
        `   ${name}: ${inManifest} · ${cuda.pinned.get(name) ? `بصمة مثبَّتة ${cuda.pinned.get(name).slice(0, 12)}…` : '**بلا بصمة مثبَّتة**'} · ` +
          `${l ? `HEAD ${l.status}${l.contentLength === null ? '' : ` (${l.contentLength} bytes)`}` : 'بلا قياس حياة'}`
      );
    }
    for (const n of out.notes) console.log(`   ⚠ ${n.name}: ${n.why}`);
  }

  if (out.env.length > 0) emitEnvironmentalNotice(out.env, opts, expected.length + cuda.files.length);

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
  const s = cudaOut.stats;
  const cudaClause =
    `كتلة CUDA: ${s.manifestNames}/${cuda.files.length} اسماً في المانيفست · ` +
    `${s.manifestAccepted} مدخلاً ببصمة مثبَّتة · ${cudaOut.live.length} رابطاً يردّ 200` +
    (s.sizeOk > 0 ? ` · ${s.sizeOk} حجماً مطابقاً للإعلان` : '') +
    (s.recordSha > 0 ? ` · ${s.recordSha} بصمة سجلّ مطابقة` : '') +
    (s.manifestSha > 0 ? ` · ${s.manifestSha} بصمة مانيفست مطابقة` : '');
  if (opts.cudaOnly) {
    console.log(`✓ قناة أصول CUDA سليمة: ${record.tag ?? channel.tag} ليست مسودّة · ${cudaClause}`);
    return EXIT.PASS;
  }
  console.log(
    `✓ قناة الأصول سليمة: ${record.tag ?? channel.tag} ليست مسودّة · ${out.members.length}/${expected.length} أصلاً معلَناً · ` +
      `${out.digests.length} بصمة مطابقة للمثبَّت في repair.rs · ${repairLive} رابطاً يردّ 200 · ${cudaClause}`
  );
  return EXIT.PASS;
}

// ---------------------------------------------------------------------------
// الفحص الذاتي: الحارس يُقاس بمُفسَداته وبضابطه وبصفر مدخله
// ---------------------------------------------------------------------------

/** مستودع مصنوع: `repair.rs` بمكوّنات يعطيها النداء (+ `cuda_runtime.rs` مصنوع).
 *  `noComponents` ⇒ جدول **فارغ** (`&[` ثم `];` — كجدول حقيقي أُفرغ)،
 *  و`absentComponents` ⇒ الكتلة **غائبة** أصلاً، و`noBase` ⇒ بلا ASSET_BASE.
 *  و`base` أساس القناة المصنوع (الخادم المحلي) ليكون **نفس المنبع** الذي يقرؤه
 *  التطبيق — فلا حالة قياس تتسرب إلى الشبكة الحقيقية. ويُكتب **بشكل قناة إصدار**
 *  (`<base>/Fixture/Repo/releases/download/assets-v1`) لأن `parseChannel` يرفض أي
 *  شكل آخر بصوت عالٍ: فالبيئة المصنوعة تمرّ من نفس البوّابة التي يمرّ منها الحقيقي.
 *  و`cuda` خيارات ملف CUDA المصنوع (انظر `writeFixtureCuda`). */
function writeFixtureRepo(
  dir,
  components,
  { noComponents = false, absentComponents = false, noBase = false, base = null, cuda = {} } = {}
) {
  const assetBase = base
    ? `${String(base).replace(/\/$/, '')}/Fixture/Repo/releases/download/assets-v1`
    : 'https://github.com/Fixture/Repo/releases/download/assets-v1';
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
  const src = (noBase ? '' : `pub const ASSET_BASE: &str = "${assetBase}";\n\n`) + table;
  const p = path.join(dir, REPAIR_RS_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, src);
  writeFixtureCuda(dir, cuda);
  return dir;
}

/**
 * `cuda_runtime.rs` مصنوع — الثوابت الثلاثة التي يقرؤها الحارس (والتطبيق).
 * و`absent` ⇒ الملف غير موجود أصلاً · `noFiles` ⇒ `CUDA_FILES` فارغ ·
 * `noPinned` ⇒ `CUDA_FILE_SHA256` فارغ · `noManifest` ⇒ MANIFEST_ASSET غائب ·
 * `swapPinned` ⇒ نفس البصمات بترتيب مختلف (افتراق الترتيب الذي يشترطه اختبار Rust).
 */
function writeFixtureCuda(
  dir,
  { files = [], pinned = [], manifestAsset = 'cuda-runtime-manifest.json', absent = false, noFiles = false, noPinned = false, noManifest = false, swapPinned = false } = {}
) {
  if (absent) return dir;
  const p = path.join(dir, CUDA_RS_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const list = noFiles ? [] : files;
  const pairs = noPinned ? [] : swapPinned && pinned.length > 1 ? [pinned[1], pinned[0], ...pinned.slice(2)] : pinned;
  const fileLines = list.map((n) => `    "${n}",`).join('\n');
  const pinnedLines = pairs.map(([n, s]) => `    (\n        "${n}",\n        "${s}",\n    ),`).join('\n');
  const src =
    `pub const CUDA_FILES: &[&str] = &[\n${fileLines}\n];\n\n` +
    (noManifest ? '' : `const MANIFEST_ASSET: &str = "${manifestAsset}";\n\n`) +
    `pub const CUDA_FILE_SHA256: &[(&str, &str)] = &[\n${pinnedLines}\n];\n`;
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

/* الأسماء الستة عشر **الحقيقية** في البيئة المصنوعة: الأسماء هي ما يقرؤه التطبيق من
   `CUDA_FILES`، فلو قاس الحارس أسماء مُختلقة لما قاس العقد الذي يسقط عنده الزرّ.
   والبصمات مصنوعة ثابتة (لا ملف حقيقي في المستودع ولا في البيئة). */
const FIXTURE_CUDA_FILES = [
  'cudart64_12.dll',
  'cublas64_12.dll',
  'cublasLt64_12.dll',
  'cufft64_11.dll',
  'cudnn64_9.dll',
  'cudnn_ops64_9.dll',
  'cudnn_cnn64_9.dll',
  'cudnn_adv64_9.dll',
  'cudnn_graph64_9.dll',
  'cudnn_heuristic64_9.dll',
  'cudnn_engines_precompiled64_9.dll',
  'cudnn_engines_runtime_compiled64_9.dll',
  'cudnn_engines_tensor_ir64_9.dll',
  'cudnn_ext64_9.dll',
  'onnxruntime_providers_shared.dll',
  'onnxruntime_providers_cuda.dll',
];
const FIXTURE_MANIFEST = 'cuda-runtime-manifest.json';
/** مضاعف فهرسه سداسياً ٦٤ مرة: بصمة مصنوعة مميَّزة لكل اسم (بلا اعتماد على تشفير). */
const shaN = (i) => (i + 1).toString(16).padStart(2, '0').repeat(32);
const FIXTURE_CUDA_PINNED = new Map(FIXTURE_CUDA_FILES.map((n, i) => [n, shaN(i)]));
const CUDA_PINNED_PAIRS = FIXTURE_CUDA_FILES.map((n) => [n, FIXTURE_CUDA_PINNED.get(n)]);
/** عقد CUDA سليم في البيئة المصنوعة — كل حالة تخرب منه ما تشاء. */
const CUDA_FIXTURE_HEALTHY = { files: FIXTURE_CUDA_FILES, pinned: CUDA_PINNED_PAIRS };
/** اسم من الستة عشر يمثّل «الملف الذي غاب عن أرشيف NVIDIA» في المُفسَدات. */
const CUDA_VICTIM = 'cudnn_engines_tensor_ir64_9.dll';

/** مانيفست مصنوع بالأسماء المعطاة (`over` يخرب ما يشاء: `raw` · `body`). */
function fixtureManifest(names = FIXTURE_CUDA_FILES) {
  return JSON.stringify(
    { files: names.map((n) => ({ name: n, sha256: FIXTURE_CUDA_PINNED.get(n) ?? sha('b') })) },
    null,
    2
  );
}

/** سجلّ نشرة مصنوع **للبيئتين**: الأربعة + الستة عشر + المانيفست (٢١ أصلاً كالقناة
 *  الحقيقية)، وبصمات الكتلتين مطابقة فتمرّ مقابلة البصمة، والحجم 1024 كالخادم. */
function fixtureRecordHealthy(over = {}) {
  const names = [...FIXTURE_COMPONENTS.map((c) => c.asset), ...FIXTURE_CUDA_FILES, FIXTURE_MANIFEST];
  const digestFor = { ...FIXTURE_DIGESTS, ...Object.fromEntries(FIXTURE_CUDA_PINNED), [FIXTURE_MANIFEST]: sha('e') };
  return fixtureRecord(names, { digestFor, ...over });
}

/** سجلّ نشرة مصنوع: `over` يخرب ما يشاء (`draft` · `digestFor` · `assets`). */
function fixtureRecord(names, over = {}) {
  const digestFor = over.digestFor || {};
  const assets =
    over.assets ||
    names.map((n) => ({ name: n, size: 1024, digest: `sha256:${digestFor[n] ?? 'a'.repeat(64)}` }));
  return JSON.stringify({ draft: false, prerelease: false, tag_name: 'assets-v1', ...over, assets });
}

/**
 * خادم أصول محلي **قابل للتغيير بين الحالات**: `alive` أسماء تردّ 200 وغيرها 404،
 * و`bodies` أجسام GET (المانيفست)، و`sizes` أطوال معلَنة بدل 1024. والعائد يحمل
 * `state` ليغيّره الفحص الذاتي حالةً حالة بلا إعادة تشغيل الخادم.
 * والاسم يُقرأ من **آخر مقطع** في المسار: فالروابط المصنوعة بشكل قناة إصدار
 * (`/<owner>/<repo>/releases/download/<tag>/<name>`) والروابط المسطّحة (`/<name>`)
 * كلتاهما تصل إلى نفس الملف.
 */
function startAssetServer({ alive = [], bodies = new Map(), sizes = new Map() } = {}) {
  const state = { alive: new Set(alive), bodies: new Map(bodies), sizes: new Map(sizes) };
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(String(req.url || '').split('?')[0].split('/').pop() || '');
      hits.push(`${req.method} ${name}`);
      if (!state.alive.has(name)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = state.bodies.has(name) ? state.bodies.get(name) : null;
      const size = state.sizes.has(name) ? state.sizes.get(name) : body === null ? 1024 : Buffer.byteLength(body, 'utf8');
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(size) });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(size) });
      res.end(body === null ? '' : body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits, state }));
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

/** يشغّل ملف pwsh ويرد رمز الخروج والمخرَج (بيئة مُعطاة صريحاً). */
function runPwsh(scriptPath, env) {
  return new Promise((resolve) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (out += d.toString('utf8')));
    child.on('error', (err) => resolve({ status: null, out: `spawn error: ${err.message}` }));
    child.on('close', (status) => resolve({ status, out }));
  });
}

/**
 * يقيس **نصّ حارس انحراف البصمات المشحون في السير** (لا نسخة ثانية هنا) — بنفس نمط
 * `check-cuda-assets.cjs` مع قاعدة PE: النصّ يُستخرج من بين وسمَي `CUDA_SHA_GUARD`
 * ويُشغَّل في pwsh على مستودع مصنوع (جدول بصمات حقيقي محسوب لملفات مصنوعة):
 * ضابط يمرّ · بايت منحرف يسقط · ملف ناقص يسقط · جدول بصمات فارغ يسقط · مجلد فارغ
 * يسقط. **وهذا لا يجعل السير مُشغَّلاً في Actions** — ذاك يحتاج دفعاً — لكنه يقيس
 * أن النصّ يفعل ما وُعد به قبل أن يُدفع، فلا يُدفع نصّ لم يُقَس ولا مرة.
 */
async function shaGuardCases(work, cases) {
  const add = (label, ok, detail, out) => cases.push({ label, ok, detail, out: out || '' });
  const yamlPath = path.join(ROOT, WORKFLOW_REL);
  if (!fs.existsSync(yamlPath)) {
    add('Ⓢ حارس البصمات في السير: الملف موجود', false, `بنية غير صالحة: ${WORKFLOW_REL} غير موجود عند ${yamlPath}`);
    return;
  }
  const block = extractMarkerBlock(fs.readFileSync(yamlPath, 'utf8'), SHA_GUARD_BEGIN, SHA_GUARD_END);
  if (!block) {
    add(
      'Ⓢ حارس البصمات في السير: النصّ موجود بين وسمَي CUDA_SHA_GUARD',
      false,
      `لم أجد كتلة ${SHA_GUARD_BEGIN} … ${SHA_GUARD_END} في ${WORKFLOW_REL} — لا نصّ أقيس، وهذا فشل لا مرور`
    );
    return;
  }

  const repo = path.join(work, 'sha-repo');
  const temp = path.join(work, 'sha-temp');
  const emptyTemp = path.join(work, 'sha-empty-temp');
  const bin = path.join(temp, 'cuda-runtime', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(emptyTemp, 'cuda-runtime', 'bin'), { recursive: true });

  // ١٦ ملفاً مصنوعاً بأطوال مختلفة، والجدول المصنوع بصماتها **الحقيقية** — فلا يعتمد
  // القياس على أي ثابت مكتوب هنا: البصمة تُحسب من البايتات كما يفعل السير.
  const contents = new Map();
  for (const [i, name] of FIXTURE_CUDA_FILES.entries()) {
    const buf = Buffer.concat([Buffer.from(`PE-مصنوع:${name}\n`, 'utf8'), Buffer.alloc(600 + i * 7, 0x41)]);
    contents.set(name, buf);
    fs.writeFileSync(path.join(bin, name), buf);
  }
  const realPinned = FIXTURE_CUDA_FILES.map((n) => [n, crypto.createHash('sha256').update(contents.get(n)).digest('hex')]);
  const writeRepo = (over = {}) => writeFixtureCuda(repo, { files: FIXTURE_CUDA_FILES, pinned: realPinned, ...over });
  writeRepo();

  const script = path.join(work, 'cuda-sha-guard.ps1');
  fs.writeFileSync(script, block);
  const run = (runnerTemp = temp) => runPwsh(script, { GITHUB_WORKSPACE: repo, RUNNER_TEMP: runnerTemp });

  /* ضابط: النصّ المشحون يمرّ على مجموعة سليمة — وقد رأى ستة عشر ملفاً. */
  {
    const res = await run();
    const problems = [];
    if (res.status !== 0) problems.push(`رمز الخروج ${res.status} بدل 0 — النصّ المشحون لا يمرّ على مجموعة سليمة`);
    for (const t of ['✓ بصمات CUDA مطابقة تماماً', '16']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    add('Ⓢ ضابط: نصّ السير المشحون يمرّ على 16 ملفاً بصماتها تطابق الجدول المصنوع', problems.length === 0, problems.join(' · '), res.out);
  }

  /* مُفسَد: بايت واحد منحرف في ملف واحد ⇒ يسقط ويسمّي الملف (وهو انحراف NVIDIA). */
  {
    const victim = path.join(bin, CUDA_VICTIM);
    const original = fs.readFileSync(victim);
    const flipped = Buffer.from(original);
    flipped[Math.floor(flipped.length / 2)] ^= 0xff;
    fs.writeFileSync(victim, flipped);
    const res = await run();
    fs.writeFileSync(victim, original);
    const problems = [];
    if (res.status === 0) problems.push('البايت المنحرف مرّ — الحارس لا يقارن البصمات فعلاً');
    for (const t of [CUDA_VICTIM, 'انحراف بصمات']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يسمّي «${t}»`);
    }
    add('Ⓢ مُفسَد: بايت واحد منحرف في ملف واحد ⇒ يسقط ويسمّي الملف', problems.length === 0, problems.join(' · '), res.out);
  }

  /* مُفسَد: ملف من الستة عشر غائب عن bin/ ⇒ يسقط ويسمّيه (لا يكفي فحص الموجود). */
  {
    const victim = path.join(bin, CUDA_VICTIM);
    const original = fs.readFileSync(victim);
    fs.rmSync(victim);
    const res = await run();
    fs.writeFileSync(victim, original);
    const problems = [];
    if (res.status === 0) problems.push('الملف الناقص مرّ — الحارس لا يقيس الاتجاه الآخر');
    for (const t of [CUDA_VICTIM, 'انحراف بصمات']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يسمّي «${t}»`);
    }
    add('Ⓢ مُفسَد: ملف من الستة عشر غائب عن bin/ ⇒ يسقط ويسمّيه', problems.length === 0, problems.join(' · '), res.out);
  }

  /* صفر مدخل: جدول البصمات فارغ في المصدر ⇒ فشل بنيوي مسمّى (لا مرور بلا مرجع). */
  {
    writeRepo({ pinned: [], noPinned: true });
    const res = await run();
    writeRepo();
    const problems = [];
    if (res.status === 0) problems.push('جدول بصمات فارغ مرّ — لا شيء يُقابَل فلا نجاح');
    if (!res.out.includes('CUDA_FILE_SHA256')) problems.push('المخرَج لا يسمّي الجدول الفارغ');
    add('Ⓢ صفر مدخل: CUDA_FILE_SHA256 فارغ ⇒ فشل بنيوي مسمّى', problems.length === 0, problems.join(' · '), res.out);
  }

  /* صفر مدخل: لا DLL في bin/ ⇒ فشل مسمّى (حارس لم يرَ شيئاً لا يُثبت شيئاً). */
  {
    const res = await run(emptyTemp);
    const problems = [];
    if (res.status === 0) problems.push('مجلد فارغ مرّ — لا شيء يُفحص فلا نجاح');
    if (!res.out.includes('لا DLL')) problems.push('المخرَج لا يسمّي المجلد الفارغ');
    add('Ⓢ صفر مدخل: مجلد bin فارغ ⇒ يسقط بصوت عالٍ', problems.length === 0, problems.join(' · '), res.out);
  }
}

async function selfcheck(opts = {}) {
  const os = require('node:os');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-release-assets-'));
  const cases = [];
  const names = FIXTURE_COMPONENTS.map((c) => c.asset);
  const { server, port, hits, state } = await startAssetServer({
    alive: [...names, ...FIXTURE_CUDA_FILES, FIXTURE_MANIFEST],
    bodies: new Map([[FIXTURE_MANIFEST, fixtureManifest()]]),
  });
  const urlBase = `http://127.0.0.1:${port}`;
  const alive = () => hits.length > 0;
  const before = hits.length;

  /**
   * حالة الخادم لكل حالة قياس: الكتلتان والمانيفست بأسمائهما الحقيقية، ثم يُخرب
   * ما يشاء النداء (`cudaAlive` اسم غائب ⇒ 404 · `manifest` جسم آخر/تالف ·
   * `manifestAlive:false` ⇒ المانيفست نفسه 404 · `sizes` طول مخالف للإعلان).
   * والتغيير **بين** الحالات لا داخلها: كل حالة تضبط حالتها ثم تُشغّل الحارس.
   */
  const serve = ({ cudaAlive = FIXTURE_CUDA_FILES, manifest = fixtureManifest(), manifestAlive = true, sizes = {} } = {}) => {
    state.alive = new Set([...names, ...cudaAlive, ...(manifestAlive ? [FIXTURE_MANIFEST] : [])]);
    state.bodies = new Map([[FIXTURE_MANIFEST, manifest]]);
    state.sizes = new Map(Object.entries(sizes));
  };

  const addCase = (label, expected, res, mustText) => {
    const problems = [];
    if (res.status !== expected) problems.push(`رمز الخروج ${res.status} بدل ${expected}`);
    for (const t of mustText || []) if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    cases.push({ label, ok: problems.length === 0, detail: problems.join(' · '), out: res.out });
    return problems.length === 0;
  };

  /** مستودع مصنوع: `repair.rs` بمكوّنات النداء **و`cuda_runtime.rs` سليم** افتراضاً
   *  (فالحارس يقرأ العقدين دائماً)، و`flags.cuda` يخرب ما يشاء من عقد CUDA. */
  const mkRepo = (name, components = FIXTURE_COMPONENTS, flags = {}) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    writeFixtureRepo(dir, components, {
      ...flags,
      base: urlBase,
      cuda: { ...CUDA_FIXTURE_HEALTHY, ...(flags.cuda || {}) },
    });
    return dir;
  };
  const mkJson = (name, text) => {
    const p = path.join(work, name);
    fs.writeFileSync(p, text);
    return p;
  };
  const baseArgs = (dir, json) => [`--repo=${dir}`, `--asset-url-base=${urlBase}`, `--release-json=${json}`, '--quiet'];

  try {
    /* Ⓐ/(د) ضابط: العقدان سليمان — 4 أصول إصلاح + مانيفست كامل + 16 دلالة CUDA
       بروابط 200 وبصمات مطابقة ⇒ 0، **وقد رأى 21 طلباً** (4+16+مانيفست)، فلا مرور
       بالعمى. وهذا هو الضابط المطلوب (د): «كل شيء سليم ⇒ يمرّ». */
    {
      serve();
      const dir = mkRepo('control');
      const json = mkJson('control.json', fixtureRecordHealthy());
      const h0 = hits.length;
      const res = await runGuard(__filename, baseArgs(dir, json));
      const seen = hits.length - h0;
      const problems = [];
      if (res.status !== EXIT.PASS) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.PASS}`);
      for (const t of [
        'قناة الأصول سليمة',
        '4/4 أصلاً معلَناً',
        '4 بصمة مطابقة',
        '4 رابطاً يردّ 200',
        '16/16 اسماً في المانيفست',
        '16 مدخلاً ببصمة مثبَّتة',
        '16 رابطاً يردّ 200',
        '16 حجماً مطابقاً للإعلان',
        '16 بصمة سجلّ مطابقة',
        '16 بصمة مانيفست مطابقة',
      ]) {
        if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
      }
      if (seen !== 21) problems.push(`الخادم رأى ${seen} طلباً بدل 21 — الحارس لم يزر كل أصل (4 إصلاح + 16 CUDA + مانيفست)`);
      cases.push({
        label: 'Ⓐ/(د) ضابط: 4 أصول إصلاح + مانيفست كامل + 16 دلالة CUDA (روابط 200 وبصمات وحجوم مطابقة) ⇒ 0',
        ok: problems.length === 0,
        detail: problems.join(' · '),
        out: res.out,
      });
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

    /* ═══ مُفسَدات عقد CUDA (المانيفست + الستة عشر) — كلها بخادم محلي بلا شبكة ═══
       البيئة المصنوعة تحمل **الأسماء الستة عشر الحقيقية** من `CUDA_FILES`، والمُفسَد
       يُسمّى في المخرَج: لا سقوط جماعيّ برسالة عامة. */

    /* Ⓒ″ مُفسَد (أ): مانيفست **ناقص اسماً** من الستة عشر ⇒ يسقط بمسمّاه.
       (والتطبيق يردّ على هذا بعينه: «ينقص المنفست: …» فلا ينزّل شيئاً.) */
    {
      serve({ manifest: fixtureManifest(FIXTURE_CUDA_FILES.filter((n) => n !== CUDA_VICTIM)) });
      const dir = mkRepo('cuda-manifest-missing');
      const json = mkJson('cuda-manifest-missing.json', fixtureRecordHealthy());
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase(
        'Ⓒ″ مُفسَد (أ): مانيفست ناقص اسماً من الستة عشر ⇒ يسقط بمسمّاه',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس قناة الأصول', `[مانيفست ناقص] ${CUDA_VICTIM}`, `ينقص المنفست: ${CUDA_VICTIM}`]
      );
    }

    /* Ⓒ‴ مُفسَد (ب): مانيفست يحمل اسماً **زائداً بلا بصمة مثبَّتة** ⇒ يسقط: التطبيق
       يرفض مدخلاً لا يجد له `pinned_sha` (‏cuda_runtime.rs:734-735). */
    {
      const extra = 'cudnn_bogus64_9.dll';
      serve({ manifest: fixtureManifest([...FIXTURE_CUDA_FILES, extra]) });
      const dir = mkRepo('cuda-manifest-extra');
      const json = mkJson('cuda-manifest-extra.json', fixtureRecordHealthy());
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase(
        'Ⓒ‴ مُفسَد (ب): مانيفست يحمل اسماً زائداً بلا بصمة مثبَّتة ⇒ يسقط بمسمّاه',
        EXIT.FAIL,
        res,
        [
          '✗ فشل حارس قناة الأصول',
          `[مانيفست بلا بصمة مثبَّتة] ${extra}`,
          'ملف في المنفست بلا بصمة مثبَّتة في التطبيق',
        ]
      );
    }

    /* Ⓒ⁗ مُفسَد (ج): ملف من الستة عشر **404** على القناة ⇒ يسقط بفحص الحياة. */
    {
      serve({ cudaAlive: FIXTURE_CUDA_FILES.filter((n) => n !== CUDA_VICTIM) });
      const dir = mkRepo('cuda-file-404');
      const json = mkJson('cuda-file-404.json', fixtureRecordHealthy());
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase(
        'Ⓒ⁗ مُفسَد (ج): ملف من الستة عشر يردّ 404 ⇒ يسقط بفحص الحياة بمسمّاه',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس قناة الأصول', `[رابط ميت] ${CUDA_VICTIM}`, 'HTTP 404']
      );
    }

    /* Ⓒ⁵/Ⓒ⁶ مُفسَد (هـ): مانيفست **بلا حقل files** أو **JSON تالف** ⇒ يسقط: التطبيق
       يردّ «منفست تالف» ولا ينزّل ملفاً واحداً، فمروره هنا كذب. */
    {
      serve({ manifest: JSON.stringify({ entries: [] }) });
      const dir = mkRepo('cuda-manifest-nofiles');
      const json = mkJson('cuda-manifest-nofiles.json', fixtureRecordHealthy());
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase(
        'Ⓒ⁵ مُفسَد (هـ): مانيفست بلا حقل files ⇒ يسقط (منفست تالف)',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس قناة الأصول', '[مانيفست تالف]', 'لا حقل files[]']
      );
      serve({ manifest: '{ "files": [' });
      const res2 = await runGuard(__filename, baseArgs(dir, json));
      addCase(
        'Ⓒ⁶ مُفسَد (هـ′): مانيفست JSON تالف ⇒ يسقط (منفست تالف)',
        EXIT.FAIL,
        res2,
        ['✗ فشل حارس قناة الأصول', '[مانيفست تالف]', 'ليس JSON صالحاً']
      );
    }

    /* Ⓒ⁷ مُفسَد: **المانيفست نفسه 404** — وهو عطل القناة المقيس بعينه (زرّ CUDA معطّل لكل
       مستخدم جديد) ⇒ يسقط في الوضعين، ولا يُسكته أن الدلّالات الستة عشر سليمة. */
    {
      serve({ manifestAlive: false });
      const dir = mkRepo('cuda-manifest-404');
      const json = mkJson('cuda-manifest-404.json', fixtureRecordHealthy());
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase(
        'Ⓒ⁷ مُفسَد: مانيفست CUDA يردّ 404 (عطل القناة المقيس) ⇒ يسقط ولو كانت الستة عشر سليمة',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس قناة الأصول', '[مانيفست مفقود]', 'لم تُنشر بعد في المستودع', 'زرّ CUDA']
      );
    }

    /* Ⓒ⁸ مُفسَد (و): طول الرابط يخالف **الحجم المعلَن** في السجلّ ⇒ يسقط بلا تنزيل
       بايت واحد — الإعلان لا يصف المخدوم. */
    {
      serve({ sizes: { [CUDA_VICTIM]: 999 } });
      const dir = mkRepo('cuda-size-mismatch');
      const json = mkJson('cuda-size-mismatch.json', fixtureRecordHealthy());
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase(
        'Ⓒ⁸ مُفسَد (و): طول الرابط يخالف الحجم المعلَن في السجلّ ⇒ يسقط بمسمّاه',
        EXIT.FAIL,
        res,
        ['✗ فشل حارس قناة الأصول', `[حجم مخالف] ${CUDA_VICTIM}`, 'والحجم المعلَن في السجلّ 1024 bytes']
      );
    }

    /* Ⓒ⁹/Ⓒ¹⁰/Ⓒ¹¹ صفر مدخل في عقد CUDA: الملف غائب · الأسماء فارغة · الترتيب مخالف
       ⇒ فشل بنيوي (2) مسمّى. والواجهة موجَّهة إلى منفذ ميت: لو تجاوز الحارس البنية
       إلى الشبكة لبان. */
    {
      const dead = '--api-url=http://127.0.0.1:1/x';
      const dirAbsent = mkRepo('cuda-no-file', FIXTURE_COMPONENTS, { cuda: { absent: true } });
      const resAbsent = await runGuard(__filename, [`--repo=${dirAbsent}`, dead, '--quiet']);
      addCase('Ⓒ⁹ صفر مدخل: cuda_runtime.rs غائب ⇒ فشل بنيوي (2)', EXIT.MISUSE, resAbsent, [
        '✗',
        `${CUDA_RS_REL} غير موجود`,
      ]);
      const dirEmpty = mkRepo('cuda-empty-files', FIXTURE_COMPONENTS, { cuda: { files: [], pinned: [] } });
      const resEmpty = await runGuard(__filename, [`--repo=${dirEmpty}`, dead, '--quiet']);
      addCase('Ⓒ¹⁰ صفر مدخل: CUDA_FILES فارغ ⇒ فشل بنيوي (2)', EXIT.MISUSE, resEmpty, [
        '✗',
        'CUDA_FILES في',
        'صفر اسم',
      ]);
      const dirOrder = mkRepo('cuda-order-swap', FIXTURE_COMPONENTS, {
        cuda: { files: FIXTURE_CUDA_FILES, pinned: CUDA_PINNED_PAIRS, swapPinned: true },
      });
      const resOrder = await runGuard(__filename, [`--repo=${dirOrder}`, dead, '--quiet']);
      addCase('Ⓒ¹¹ صفر مدخل: ترتيب CUDA_FILE_SHA256 مخالف لـCUDA_FILES ⇒ 2', EXIT.MISUSE, resOrder, [
        '✗',
        'ترتيب CUDA_FILE_SHA256 لا يطابق',
      ]);
      const dirNoPinned = mkRepo('cuda-no-pinned', FIXTURE_COMPONENTS, { cuda: { files: FIXTURE_CUDA_FILES, pinned: [], noPinned: true } });
      const resNoPinned = await runGuard(__filename, [`--repo=${dirNoPinned}`, dead, '--quiet']);
      addCase('Ⓒ¹² صفر مدخل: CUDA_FILE_SHA256 فارغ ⇒ فشل بنيوي (2)', EXIT.MISUSE, resNoPinned, [
        '✗',
        'صفر بصمة',
      ]);
    }

    /* Ⓒ¹³ **إعادة تمثيل العطل المقيس**: قناة تحمل الأربعة فقط — لا مانيفست
       ولا ملف CUDA واحد (وهي الحال التي مرّ عليها الحارس القديم بقوله «سليمة»).
       الآن يسقط الحارس، ويسمّي المانيفست **والستة عشر** لا المانيفست وحده. */
    {
      serve({ cudaAlive: [], manifestAlive: false });
      const dir = mkRepo('cuda-incident-replay');
      const json = mkJson('cuda-incident-replay.json', fixtureRecordHealthy());
      const res = await runGuard(__filename, baseArgs(dir, json));
      addCase(
        'Ⓒ¹³ إعادة تمثيل عطل القناة المقيس: قناة بالأربعة وحدها (لا مانيفست ولا CUDA) ⇒ يسقط ولو كانت الأربعة 200',
        EXIT.FAIL,
        res,
        [
          '✗ فشل حارس قناة الأصول',
          '[مانيفست مفقود]',
          '[رابط ميت] cudart64_12.dll',
          `[رابط ميت] ${CUDA_VICTIM}`,
          '17 مشكلة',
        ]
      );
    }

    /* Ⓒ¹⁴ ضابط وضع `--cuda-only` (وأمره `pnpm release:assets:cuda`): عقد CUDA سليم
       و`COMPONENTS` **غائب** ⇒ يمرّ. فالوضع يقيس كتلة CUDA وحدها ولا يشترط جدولاً
       لا يقيسه — ولو اشترطه لسقط على مستودع لا شأن له بعطله. */
    {
      serve();
      const dir = mkRepo('cuda-only', FIXTURE_COMPONENTS, { absentComponents: true });
      const json = mkJson('cuda-only.json', fixtureRecordHealthy());
      const res = await runGuard(__filename, [...baseArgs(dir, json), '--cuda-only']);
      addCase(
        'Ⓒ¹⁴ ضابط --cuda-only: CUDA سليم و COMPONENTS غائب ⇒ يمرّ (لا يشترط ما لا يقيسه)',
        EXIT.PASS,
        res,
        ['✓ قناة أصول CUDA سليمة', '16/16 اسماً في المانيفست', '16 رابطاً يردّ 200']
      );
    }

    /* Ⓕ/Ⓖ الوضعان بلا شبكة: واجهة على منفذ لا يخدمه أحد (127.0.0.1:1).
       (والحالة تُعاد سليمةً عمداً: الغياب المقيس هنا هو غياب **سجلّ النشرة** وحده،
       وكتلة CUDA حيّة — فلا يُنسب إلى الشبكة عطلٌ ليس منها.) */
    {
      serve();
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
       النسخة المطموسة سببٌ للسقوط غير الفحص المحذوف — وهذا يشمل عقد CUDA: كل حالة
       تضبط حالة الخادم (`serve`) لتكون **سليمة إلا من المُفسَد المعنيّ**. */
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
      {
        label: 'Ⓠ‴ نسخة بلا تصنيف نتيجة جلب المانيفست ⇒ المُفسَد (هـ: مانيفست بلا files) يمرّ عليها',
        call: MANIFEST_FETCH_CALL,
        replacement: MANIFEST_FETCH_CALL_REMOVED,
        serve: () => serve({ manifest: JSON.stringify({ entries: [] }) }),
        json: () => fixtureRecordHealthy(),
        forbid: ['مانيفست تالف'],
      },
      {
        label: 'Ⓠ⁗ نسخة بلا فحص اكتمال المانيفست ⇒ المُفسَد (أ: اسم ناقص) يمرّ عليها',
        call: MANIFEST_COVERS_CALL,
        replacement: MANIFEST_COVERS_CALL_REMOVED,
        serve: () => serve({ manifest: fixtureManifest(FIXTURE_CUDA_FILES.filter((n) => n !== CUDA_VICTIM)) }),
        json: () => fixtureRecordHealthy(),
        forbid: ['مانيفست ناقص'],
      },
      {
        label: 'Ⓠ⁵ نسخة بلا فحص قبول مداخل المانيفست ⇒ المُفسَد (ب: اسم زائد بلا بصمة) يمرّ عليها',
        call: MANIFEST_ENTRIES_CALL,
        replacement: MANIFEST_ENTRIES_CALL_REMOVED,
        serve: () => serve({ manifest: fixtureManifest([...FIXTURE_CUDA_FILES, 'cudnn_bogus64_9.dll']) }),
        json: () => fixtureRecordHealthy(),
        forbid: ['بلا بصمة مثبَّتة'],
      },
      {
        label: 'Ⓠ⁶ نسخة بلا فحص حياة أسماء CUDA ⇒ المُفسَد (ج: ملف 404) يمرّ عليها',
        call: CUDA_LIVENESS_CALL,
        replacement: CUDA_LIVENESS_CALL_REMOVED,
        serve: () => serve({ cudaAlive: FIXTURE_CUDA_FILES.filter((n) => n !== CUDA_VICTIM) }),
        json: () => fixtureRecordHealthy(),
        forbid: ['[رابط ميت]'],
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
        const dir = mkRepo(`mutant-repo-${cases.length}`, m.repo || FIXTURE_COMPONENTS);
        if (m.serve) m.serve(); else serve();
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

    /* Ⓢ حارس انحراف البصمات في السير: يُقاس **بنصّه المشحون** (انظر الدالة أدناه). */
    await shaGuardCases(work, cases);
  } finally {
    server.close();
  }

  const bad = cases.filter((c) => !c.ok);
  console.log(`\nالفحص الذاتي لحارس قناة الأصول — ${cases.length} حالة:`);
  for (const c of cases) {
    if (c.ok) {
      console.log(`  ✓ ${c.label}`);
      continue;
    }
    console.log(`  ✗ ${c.label}\n      ${c.detail}`);
    // ذيل مخرَج الحالة الساقطة: بلا هذا السطر يبقى «رمز الخروج 2 بدل 1» بلا سبب،
    // والسبب مكتوب أصلاً في مخرَج الحارس — فلا يُخفى.
    const tail = String(c.out || '')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-3);
    if (tail.length) console.log(`      المخرَج: ${tail.join(' | ')}`);
  }
  // مُفرَّغ المراجعة: مخرَج كل حالة حرفياً (وليس التأكيدات وحدها) — فيبقى الدليل
  // قابلاً للقراءة بعد انتهاء التشغيل، ويُرفع أثراً في CI عند الطلب.
  if (opts.selfcheckDump) {
    const dumpPath = path.resolve(opts.selfcheckDump);
    const lines = [`الفحص الذاتي لحارس قناة الأصول — ${cases.length} حالة · ${bad.length} ساقطة`, ''];
    for (const c of cases) {
      lines.push(`${c.ok ? '✓' : '✗'} ${c.label}`);
      if (!c.ok) lines.push(`    (${c.detail})`);
      for (const l of String(c.out || '').split(/\r?\n/)) if (l.trim()) lines.push(`    | ${l}`);
      lines.push('');
    }
    fs.writeFileSync(dumpPath, `${lines.join('\n')}\n`);
    console.log(`ℹ مُفرَّغ بمخرَج كل حالة: ${dumpPath}`);
  }
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
  if (opts.selfcheck) return selfcheck(opts);
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
  readCudaExpectations,
  extractMarkerBlock,
  normalizeRecord,
  assetUrl,
  shaGuardCases,
  LIVENESS_CALL,
  DRAFT_CALL,
  ENV_NOTICE_CALL,
  MANIFEST_FETCH_CALL,
  MANIFEST_COVERS_CALL,
  MANIFEST_ENTRIES_CALL,
  CUDA_LIVENESS_CALL,
};
