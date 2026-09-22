#!/usr/bin/env node
/**
 * بوابة المصفوفة — تحقّق من وجود سجلّ في صفوف الاختبار اليدوي الإلزامية.
 *
 * البند: 0.2.7 ج-١١. القاعدة: «البوابة التي ليست في CI ليست بوابة».
 * الصفوف تُنفَّذ يداً بيد المالك على عتاد حقيقي، فهذه البوابة لا تُنفّذ اختباراً —
 * بل تمنع المرور ما دام صفّ إلزامي بلا **سجل**.
 *
 * تعريف «مملوء» المعتمد (خطة 0.2.7): العمود الأخير من الصفّ يحمل
 *   تاريخاً (YYYY-MM-DD) + جهازاً (رمز/اسم) + نتيجة (نصّ غير فارغ).
 * ونقص أيٍّ من الثلاثة ⇒ الصفّ فارغ.
 *
 * رموز الخروج:
 *   0 = كل الصفوف الإلزامية مملوءة · 1 = بقي صفّ ناقص · 2 = خطأ بنية/استعمال
 *   (‏2 عمداً: «صفر صفّ إلزامي» و«الملف مفقود» ليسا نجاحاً — حارس لا يرى ليس حارساً.)
 *
 * بلا اعتماديات npm: `node:fs` و`node:path` وحدهما.
 * الاستعمال: node scripts/matrix-check.cjs [--file=<path>] [--quiet]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FILE = path.join('qa', 'TEST-MATRIX.md');
const MANDATORY_RE = /\[إلزامي\]/;

const EXIT = { PASS: 0, INCOMPLETE: 1, MISUSE: 2 };

// ---------------------------------------------------------------------------
// جدول الربط: صفّ «قابل للتقييم» ← منطقة كوده
// ---------------------------------------------------------------------------
//
// **الخطوة الحاسمة** في خطة 0.2.9 §١٠: «لا ائتمان بلا أثر مُعاد إنتاجه». سجلٌّ
// مكتوب في المصفوفة (`✅ · <تاريخ> · <جهاز>`) كان يمرّ بمجرّد **وجوده**؛ وبعد هذا
// الجدول لا يمرّ صفٌّ ادّعى النجاح إلا وأثرُ مُقيِّمه موجود في `qa/eval/out/<رقم>.json`
// ويحقّق ستّة شروط (انظر `inspectRowArtifact`).
//
// **مصدر المسارات**: عمود «النتيجة المتوقَّعة (بسندها من الكود)» في `qa/TEST-MATRIX.md`
// — كل مسار هنا مأخوذ من سند الصفّ نفسه، لا مُخترَع:
//   1.1 → `main.rs:2` (النظام الفرعي) · `media.rs` (الأدوات بلا نافذة) ·
//         `pipeline.rs` (المراحل) · `slots.rs` (المهمّة)
//   1.4 → `pipeline.rs:850` (اسم الناتج) · `media.rs:428` · `yt_dlp.rs:671-673` (الترميز)
//   2.1 → `cuda_runtime.rs:81-83` (16 ملفاً) · `separator.rs:378-458` (السلسلة والمزوّد)
//   2.4 → `cuda_runtime.rs:166-169` (`bin_dir`) · `:325-336` (وصف النقص) · `separator.rs`
//   3.1 → `media.rs:63-71` · `:302-314` (الإصلاح `33638a4`) · `cli.rs:135-158` (`--probe`)
//   3.2 → `media.rs:328-340` (التصنيف بالمحتوى لا بالامتداد)
//   3.3 → `media.rs:302-341` · `cli.rs:272-279` (الفشل يُحتسب)
//   3.7 → `yt_dlp.rs:648-651` · `:805-808` · `pipeline.rs:850`
//   3.8 → `media.rs:130-165` (وسيط لكل عنصر لا سلسلة تُقسَّم)
//   3.9 → `pipeline.rs:850` · `media.rs:428`
//
// **صفوف الطبقة (أ) العشرة** من خطة 0.2.9 §١٠ حرفياً. والقائمة صريحة لا مشتقّة:
// حذف صفٍّ منها لتخفيض الشرط **فشل بنيوي** (رمز 2) لا نجاح.
const LAYER_A_ROWS = ['1.1', '1.4', '2.1', '2.4', '3.1', '3.2', '3.3', '3.7', '3.8', '3.9'];

/**
 * **صفوف المتصفّح (الطبقة ج من م٧ §١٠)** — القسم ٨ في المصفوفة.
 *
 * وُجدت هذه البوّابة لأن جاسوساً مستقلّاً أثبت (**و-٢** في
 * `ARCHIVE/m7c-browser-spy.md`) أن `✅ · <تاريخ> · <جهاز> · <أي نصّ>` كان يمرّ في
 * أيّ صفّ خارج `ROW_AREAS` العشري **بلا أي أثر مُعاد إنتاجه** — حتى مع الوسم
 * `[إلزامي]` (مقيس: «21 من 21 مملوء» وexit 0، والصفوف غير الإلزامية لا تدخل
 * `assessed` أصلاً). وهو نقض مباشر لسطر الخطة ٢١٧ لأيّ صفّ «قابل للتقييم».
 *
 * **والعقد الذي يناسب صفّ متصفّح** ليس عقد الطبقة (أ): لا ثنائي هنا حتى تُربَط
 * بصمته. فالعقد هنا: أثر لكل صفّ اسمه `<رقم الصف>.json` في `qa/browser-rows/`
 * يحمل `row` و`verdict=pass` و`outputs` غير فارغة **و`surface`**: قائمة ملفات
 * بسطور بصماتها. والبوّابة **تعيد حساب بصمة كل ملف من الشجرة** — فتغيّر ملف من
 * سطح الصفّ (المُقيِّم · ملفات الإضافة المقيسة · مصادر عقد الجسر) يجعل الأثر
 * **بائتاً** فيسقط الصفّ حتى يُعاد القياس (`pnpm browser:rows`). ولا حاجة إلى git
 * ولا إلى ثنائي — فالأثر **مُلتزَم في الشجرة** ليكون الدليل حيث يُقرأ.
 *
 * **والغياب هنا فشل لا تسامُل**: خلافاً للطبقة (أ) — حيث الغياب بيئيّ (لا ثنائي
 * على عدّاء CI) — فأثر صفّ المتصفّح يُعاد إنتاجه بأمر واحد على أيّ جهاز. فصفٌّ
 * يقول ✅ بلا أثر مطابق = ادّعاء بلا دليل، وهو عين ما مُنعت البوّابة لأجله.
 */
const BROWSER_ROWS = ['8.1', '8.2', '8.3'];
/** مجلد آثار صفوف المتصفّح (نسبةً إلى جذر المستودع) — مُلتزَم لا مُتجاهَل. */
const BROWSER_OUT = path.join('qa', 'browser-rows');
/**
 * **المحرّك المشترط لكل صفّ** — يُقابَل بحقل `engine` في الأثر: ٨.١ المنبثقة
 * تُصيَّر في jsdom بحكم التصميم · ٨.٢ المشغّل **يُشترط** أن يكون قياسه في متصفّح
 * حقيقي عبر CDP (فلا يُقبل أثر من بديل jsdom) · ٨.٣ عقد الجسر يُشترط أن يكون
 * **مُشغَّلاً** (‏cargo test) لا مقروءاً. وهذا هو «الافتراضيّ صارم» في محلّه الذي
 * يُقرأ: لا في نيّة العامل بل في الأثر المُلتزَم.
 */
const BROWSER_ENGINE_REQUIRED = { '8.1': /^jsdom/, '8.2': /^cdp/, '8.3': /^rust-test/ };

const ROW_AREAS = {
  '1.1': ['src-tauri/src/main.rs', 'src-tauri/src/media.rs', 'src-tauri/src/pipeline.rs', 'src-tauri/src/slots.rs'],
  '1.4': ['src-tauri/src/media.rs', 'src-tauri/src/pipeline.rs', 'src-tauri/src/yt_dlp.rs'],
  '2.1': ['src-tauri/src/cuda_runtime.rs', 'src-tauri/src/separator.rs'],
  '2.4': ['src-tauri/src/cuda_runtime.rs', 'src-tauri/src/separator.rs'],
  '3.1': ['src-tauri/src/cli.rs', 'src-tauri/src/media.rs'],
  '3.2': ['src-tauri/src/media.rs'],
  '3.3': ['src-tauri/src/cli.rs', 'src-tauri/src/media.rs'],
  '3.7': ['src-tauri/src/pipeline.rs', 'src-tauri/src/yt_dlp.rs'],
  '3.8': ['src-tauri/src/media.rs'],
  '3.9': ['src-tauri/src/media.rs', 'src-tauri/src/pipeline.rs'],
};

/**
 * يفحص جدول الربط بنيوياً. حارسٌ لا يرى ليس حارساً: جدول غائب أو صفرُ صفّ أو صفٌّ
 * من الطبقة (أ) بلا منطقة ⇒ **فشل بصوت عالٍ**، لا مرورٌ لأن الجدول فارغ.
 * @param {unknown} areas
 * @returns {string|null} سبب الفشل، أو null إن كان الجدول صالحاً.
 */
function validateRowAreas(areas) {
  if (!areas || typeof areas !== 'object' || Array.isArray(areas)) {
    return 'جدول الربط ليس كائناً (object)';
  }
  if (Object.keys(areas).length === 0) return 'جدول الربط صفر صفّ';
  const missing = LAYER_A_ROWS.filter((r) => !Object.prototype.hasOwnProperty.call(areas, r));
  if (missing.length > 0) return `صفوف الطبقة (أ) بلا منطقة: ${missing.join(' · ')}`;
  for (const r of LAYER_A_ROWS) {
    const a = areas[r];
    if (!Array.isArray(a) || a.length === 0) return `صفّ ${r}: منطقة فارغة أو ليست قائمة`;
    for (const p of a) {
      if (typeof p !== 'string' || p.trim() === '') return `صفّ ${r}: مسار منطقة غير صالح`;
    }
  }
  return null;
}

/** جذر المستودع للالتزام HEAD: من مجلد المصفوفة، ثم cwd. */
function gitToplevel(fromDir) {
  const r = spawnGit(['rev-parse', '--show-toplevel'], fromDir);
  if (r.status === 0 && r.stdout.trim()) {
    // git يطبع مساراً بشرطات مائلة أمامية على ويندوز أيضاً.
    return r.stdout.trim().replace(/\//g, path.sep);
  }
  return null;
}

function spawnGit(args, cwd) {
  const { spawnSync } = require('node:child_process');
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function gitHeadSha(repo) {
  const r = spawnGit(['rev-parse', 'HEAD'], repo);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * هل أثر الصفّ صالح؟ الشروط الستّة (خطة 0.2.9 §١٠):
 *   ① `row` مطابق   ② `verdict = pass`   ③ `outputs` غير فارغة
 *   ④ `exe_sha256` غير فارغ   ⑤ `commit` سلفٌ لـHEAD
 *   ⑥ لم تتغيّر منطقة الصفّ بين ذلك الالتزام وHEAD (`git diff --quiet`)
 *
 * وشرط سابع من عندنا يمنع منطقة **فارغة الحكم**: كل مسار في منطقة الصفّ يجب أن
 * يوجد فعلاً — وإلا فـ`git diff` على مسار غير موجود ينجح دائماً، فيصير الفحص
 * السادس تجاوزاً صامتاً (ثقب مُغلَق هنا لا مُهمَل).
 *
 * **والحكم ثلاثة لا اثنان**: `ok` · `missing` (لا ملف أصلاً) · `rejected` (ملف
 * موجود ولم يجتز). والتمييز مقصود: الغياب حالة **بيئية** (عدّاء CI بلا ffmpeg ولا
 * نموذج — انظر `emitMissingNotice`)، والرفض حالة **دلالية** (بائت أو مخالف).
 * فالغياب يُتسامح معه في الوضع الافتراضي، والرفض **يسقط في الوضعين**.
 *
 * @returns {{state:'ok'|'missing'|'rejected', why:string|null}}
 */
function inspectRowArtifact(row, areas, repo, evalOut, binary) {
  const file = path.join(evalOut, `${row}.json`);
  const rel = path.relative(repo, file) || file;
  // مسار خارج المستودع يُعرض مطلقاً: `..\..\..\windows\TEMP\…` اسمٌ لا يدلّ أحداً.
  const shown = rel.startsWith('..') ? file : rel;
  if (!fs.existsSync(file)) {
    return { state: 'missing', why: `بلا أثر: ${shown} مفقود — شغّل «pwsh qa/eval/${row}.ps1»` };
  }
  const rejected = (why) => ({ state: 'rejected', why });
  let art;
  try {
    art = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return rejected(`الأثر ${shown} ليس JSON صالحاً — ${err.message}`);
  }
  if (String(art.row) !== row) return rejected(`row في الأثر «${art.row}» لا يطابق الصفّ ${row}`);
  if (art.verdict !== 'pass') return rejected(`verdict في الأثر «${art.verdict}» وليس pass`);
  if (!Array.isArray(art.outputs) || art.outputs.length === 0) return rejected('outputs فارغة في الأثر');
  if (typeof art.exe_sha256 !== 'string' || art.exe_sha256.trim() === '') {
    return rejected('exe_sha256 فارغ في الأثر');
  }
  const commit = typeof art.commit === 'string' ? art.commit.trim() : '';
  if (!commit) return rejected('commit فارغ في الأثر');

  const head = gitHeadSha(repo);
  if (!head) return rejected(`تعذّر قراءة HEAD في «${repo}» — لا سند للأثر`);
  const anc = spawnGit(['merge-base', '--is-ancestor', commit, 'HEAD'], repo);
  if (anc.status !== 0) {
    return rejected(`commit ${commit.slice(0, 8)} ليس سلفاً لـHEAD (${head.slice(0, 8)})`);
  }
  for (const p of areas) {
    if (!fs.existsSync(path.join(repo, p))) return rejected(`منطقة الصفّ لا وجود لها: ${p}`);
  }
  const diff = spawnGit(['diff', '--quiet', commit, 'HEAD', '--', ...areas], repo);
  if (diff.status !== 0) {
    return rejected(
      `منطقة الصفّ تغيّرت بين ${commit.slice(0, 8)} وHEAD — الأثر بائت، أعد تشغيل «pwsh qa/eval/${row}.ps1»`
    );
  }

  // ── ارتباط الدليل بالمُخرَج المُسلَّم ─────────────────────────────────────
  // الفحص الأخير والأخطر: أثرٌ يشهد على ثنائي **غيره** أسوأ من لا أثر — لأنه يبدو
  // دليلاً. وترتيبه **بعد** فحوص الإسناد مقصود: أثر بائت أو مخالف يُبلَّغ بعلّته
  // الحقيقية حتى في بيئة بلا ثنائي، فلا تُبتلع العلّة الدلالية بحجّة بيئية.
  const recorded = art.exe_sha256.trim().toUpperCase();
  if (!binary.sha256) {
    return {
      state: 'unbound',
      why: `الثنائي غير موجود فلا يُربط الأثر بالمُخرَج المُسلَّم — جُرِّب: ${binary.searched.join(' · ')}`,
    };
  }
  if (recorded !== binary.sha256.toUpperCase()) {
    return rejected(
      `exe_sha256 في الأثر (${recorded.slice(0, 12)}…) لا يطابق الثنائي المُسلَّم ` +
        `(${binary.sha256.slice(0, 12)}… في ${binary.path}) — أُعيد بناء الثنائي بعد القياس، أعد تشغيل «pwsh qa/eval/${row}.ps1»`
    );
  }
  return { state: 'ok', why: null };
}

/**
 * هل أثر صفّ متصفّح صالح؟ **العقد الذي يناسب هذا القسم** (انظر `BROWSER_ROWS`):
 *   ① الملف `<رقم>.json` موجود في مجلد الآثار
 *   ② `row` مطابق   ③ `verdict = pass`   ④ `outputs` غير فارغة
 *   ⑤ `surface` قائمة غير فارغة، و**كل بصمة فيها تُعاد حسابها من الشجرة** —
 *      فملف تغيّر أو غاب ⇒ الأثر بائت ⇒ مرفوض
 *   ⑥ `evaluator_sha256` يطابق بصمة `evaluator` في الشجرة (فحص صريح للمُقيِّم،
 *      ولو كان ضمن `surface` — لأن الادّعاء «هذا الأثر من هذا المُقيِّم» يستحقّ
 *      سطراً يُقرأ في المخرَج لا استنتاجاً)
 *
 * والغياب **مرفوض أيضاً** (لا «غياب بيئيّ»): الأثر مُلتزَم ويُعاد إنتاجه بأمر واحد.
 *
 * @returns {{state:'ok'|'missing'|'rejected', why:string|null}}
 */
function inspectBrowserRowArtifact(row, outDir, repo, cell) {
  const file = path.join(outDir, `${row}.json`);
  const rel = path.relative(repo, file) || file;
  const shown = rel.startsWith('..') ? file : rel;
  const rejected = (why) => ({ state: 'rejected', why });
  if (!fs.existsSync(file)) {
    return {
      state: 'missing',
      why: `بلا أثر: ${shown} مفقود — شغّل «pnpm browser:rows» ثم التزم الناتج`,
    };
  }
  let art;
  try {
    art = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return rejected(`الأثر ${shown} ليس JSON صالحاً — ${err.message}`);
  }
  if (String(art.row) !== row) return rejected(`row في الأثر «${art.row}» لا يطابق الصفّ ${row}`);
  if (art.verdict !== 'pass') return rejected(`verdict في الأثر «${art.verdict}» وليس pass`);
  if (art.measured !== true) return rejected('measured في الأثر ليست true — الصفّ غير مقيَّم');
  const wantEngine = BROWSER_ENGINE_REQUIRED[row];
  if (wantEngine && !wantEngine.test(String(art.engine || ''))) {
    return rejected(
      `engine في الأثر «${art.engine}» لا يطابق المشترط لهذا الصفّ (${wantEngine}) — ` +
        'المشغّل يُقاس في متصفّح حقيقي عبر CDP، وعقد الجسر يُشغَّل لا يُقرأ'
    );
  }
  if (!Array.isArray(art.outputs) || art.outputs.length === 0) return rejected('outputs فارغة في الأثر');
  if (!Array.isArray(art.surface) || art.surface.length === 0) return rejected('surface فارغة في الأثر — لا سطح قياس فلا دليل');

  // بصمة المكافأة في **خانة الصفّ** نفسها: تربط الأرقام المكتوبة بالأرقام المقيسة،
  // فلا تمرّ أرقام مُلفَّقة ولو وُجد أثر (وهو وجه «مطابق» في «صفّ ✅ بلا أثر مطابق»).
  const token = typeof art.outputs_sha256 === 'string' ? art.outputs_sha256.slice(0, 8).toLowerCase() : '';
  if (!/^[0-9a-f]{8}$/.test(token)) return rejected('outputs_sha256 غائب أو ليس بصمة في الأثر');
  const claimed = /مكافأة\s*:\s*([0-9a-fA-F]{8})/.exec(cell || '');
  if (!claimed) {
    return rejected(`خانة الصفّ لا تحمل بصمة المكافأة (‏مكافأة:${token}) — انسخها من مخرَج «pnpm browser:rows»`);
  }
  if (claimed[1].toLowerCase() !== token) {
    return rejected(`بصمة المكافأة في الصفّ (${claimed[1].toLowerCase()}) لا تطابق الأثر (${token}) — أرقام الصفّ ليست أرقام الأثر`);
  }

  for (const entry of art.surface) {
    const p = entry && entry.path;
    if (typeof p !== 'string' || p.trim() === '') return rejected('مدخل surface بلا مسار');
    const full = path.resolve(repo, p);
    const inside = path.relative(repo, full);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return rejected(`مسار سطح خارج المستودع: ${p}`);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return rejected(`ملف من سطح الصفّ لا وجود له: ${p}`);
    const want = String(entry.sha256 || '').toUpperCase();
    const got = sha256Of(full).toUpperCase();
    if (want !== got) {
      return rejected(`سطح الصفّ تغيّر بعد القياس: ${p} (الأثر ${want.slice(0, 12)}… ≠ الشجرة ${got.slice(0, 12)}…) — أعد «pnpm browser:rows»`);
    }
  }

  const evalRel = typeof art.evaluator === 'string' ? art.evaluator : '';
  if (!evalRel) return rejected('evaluator فارغ في الأثر');
  const evalFull = path.resolve(repo, evalRel);
  const evalInside = path.relative(repo, evalFull);
  if (evalInside.startsWith('..') || path.isAbsolute(evalInside)) return rejected(`مسار المُقيِّم خارج المستودع: ${evalRel}`);
  if (!fs.existsSync(evalFull)) return rejected(`المُقيِّم لا وجود له: ${evalRel}`);
  if (String(art.evaluator_sha256 || '').toUpperCase() !== sha256Of(evalFull).toUpperCase()) {
    return rejected(`المُقيِّم تغيّر بعد القياس: ${evalRel} — أعد «pnpm browser:rows»`);
  }
  return { state: 'ok', why: null };
}

/**
 * نصّ نداء السطر الصارخ — **عقدٌ مع الفحص الذاتي** لا سطر ميت: الحالة Ⓠ تحذف هذا
 * السطر بعينه من **نسخة** من هذا الملف، وتثبت أن حالة Ⓞ تسقط حينها. فإن تغيّر
 * نصّ النداء في `main` ولم يتغيّر هذا الثابت، **يفشل الفحص الذاتي بصوت عالٍ**
 * («مُفسَد لم يغيّر الحارس») بدل أن يمرّ المُفسَد صامتاً.
 */
const MISSING_NOTICE_CALL = 'emitMissingNotice(missingIds, gatedClaiming);';

/** ما يُوضع مكان النداء في نسخة الحالة Ⓠ — تعليق لا يُنفَّذ، فيبقى الحارس سليماً إلا من السطر. */
const MISSING_NOTICE_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ) */';

/**
 * **السطر الصارخ** — يُطبع في الوضع المتسامح وحده، حين يوجد **غياب بيئيّ**:
 * آثار غائبة، أو ثنائي غير موجود فلا يُربط الأثر بالمُخرَج المُسلَّم.
 *
 * لماذا هو **شرط** لا تجميل: الوضع الافتراضي هو وضع CI، وCI **لا يستطيع** تشغيل
 * المُقيِّمات أصلاً — مهمّة `windows-latest` تُنشئ `bin/` و`models/` كـstubs فارغة
 * (`.github/workflows/ci.yml:61-68` و`:289-290`)، ولا ثنائي في `src-tauri/target/`
 * (مُتجاهَل). فغياب الأثر والثنائي هناك **خاصية بيئة لا عطل**. ولو أسقطنا الحارس
 * عليه لصار CI أحمر دائماً بلا سبب قابل للإصلاح. ولو سكتنا عنه لَقُرئ `exit 0`
 * **شهادةَ قبول** وهو ليس كذلك. فالتسامح يخصّ **الغياب البيئيّ وحده**، ويُعلَن
 * بصوت عالٍ في كل مرة. أما الرفض (بائت · مخالف · بصمة ثنائي لا تطابق) فيسقط في
 * الوضعين.
 *
 * ووجوده محروس لا تجميلي: `--selfcheck` يشغّل نسخةً من هذا الملف حُذف منها نداء
 * هذه الدالة، **ويثبت أن حالة الفحص تسقط** حينها (الحالة Ⓠ).
 */
const ENV_NOTICE_CALL = 'emitEnvironmentalNotices(envGaps, gatedClaiming);';

/** ما يُوضع مكان النداء في نسخة الحالة Ⓠ — تعليق لا يُنفَّذ، فيبقى الحارس سليماً إلا من السطر. */
const ENV_NOTICE_CALL_REMOVED = '/* حذفه الفحص الذاتي (الحالة Ⓠ) */';

function emitEnvironmentalNotices(gaps, claiming) {
  const lines = [];
  if (gaps.missingIds.length > 0) {
    lines.push(
      `\n⚠ غياب آثار — ${gaps.missingIds.length} من ${claiming} صفّاً قابلاً للتقييم بلا أثر في هذا التشغيل:`
    );
    lines.push(`   ${gaps.missingIds.join(' · ')}`);
  }
  if (gaps.binarySearched) {
    lines.push(
      `\n⚠ ثنائي غير موجود — ${gaps.unboundIds.length} من ${claiming} صفّاً أثرُه غير مربوط بالمُخرَج المُسلَّم:`
    );
    lines.push(`   ${gaps.unboundIds.join(' · ')}`);
    lines.push('   جُرِّب:');
    for (const p of gaps.binarySearched) lines.push(`     ${p}`);
  }
  lines.push('   هذه ليست شهادة قبول: القبول النهائي يشترط `--require-artifacts`');
  lines.push('   (‏node scripts/matrix-check.cjs --require-artifacts) بعد «pwsh qa/eval/run-all.ps1».');
  lines.push('   سبب التسامح مقيس: مهمّة CI على windows-latest تُنشئ bin/ و models/ كـstubs فارغة');
  lines.push('   (‏ci.yml:61-68 و:289-290)، فالعدّاء لا يملك ffmpeg ولا النموذج ولا يستطيع تشغيل المُقيِّمات.');
  process.stdout.write(`${lines.join('\n')}\n`);
  // صدى على stderr أيضاً: من يقرأ مخرَج الأخطاء وحده لا يجوز أن يفوته التحذير.
  const brief = [];
  if (gaps.missingIds.length > 0) brief.push(`${gaps.missingIds.length} بلا أثر (${gaps.missingIds.join(' · ')})`);
  if (gaps.binarySearched) brief.push(`لا ثنائي ⇒ ${gaps.unboundIds.length} أثراً غير مربوط`);
  process.stderr.write(`⚠ ${brief.join(' · ')} — القبول النهائي يشترط --require-artifacts\n`);
}

/** هل خانة النتيجة **تدّعي** نجاحاً (`✅` أو `⚠️`)؟ الصفوف `—`/`❌` لا تدّعي شيئاً. */
function claimsSuccess(verdict) {
  return /^(✅|⚠️?)$/.test(verdict && verdict.result ? verdict.result : '');
}

/** مسار الثنائي المُسلَّم داخل الشجرة: `src-tauri/target/release/HaramLite.exe`. */
function defaultBinaryPath(repo) {
  return path.join(repo, 'src-tauri', 'target', 'release', 'HaramLite.exe');
}

/**
 * يحلّ **الثنائي المُسلَّم** ويقيس بصمته — الطرف الثاني في سلسلة الدليل.
 *
 * لماذا هذا الفحص أصلاً: الأثر يوثّق `exe_sha256` للثنائي **الذي قاسه**، وبلا
 * مقارنةٍ بالثنائي الحالي يبقى أثرٌ قديم «مقبولاً» بعد إعادة بناء ⇒ تشهد الأدلّة
 * على نسخة غير التي تُسلَّم، وهو نقض «لا ائتمان بلا أثر **مُعاد إنتاجه**» في أهمّ
 * نقطة: ارتباط الدليل بالمُخرَج. (الثقب كشفه الدمج: القياس كان يمرّ بعد إعادة
 * البناء لأن الحقل كان يُفحَص **غير فارغ** لا **مطابقاً**.)
 *
 * الترتيب: `--exe` ← `<المستودع>/src-tauri/target/release/HaramLite.exe` ←
 * الشجرة الشقيقة `../haramlite-rs/...` (‏تخطيط شجرات العمل في هذا المستودع، وهو
 * نفس ما تحلّه المُقيِّمات في `qa/eval/_common.ps1`، فلا يشهد الحارس على ثنائي
 * غير الذي قاسته المُقيِّمات). والمسار المستعمل **يُطبع دائماً** فلا إبهام.
 *
 * وغياب الثنائي **غياب بيئيّ** لا عطل: استنساخ نظيف وعدّاء CI لا ثنائي فيهما
 * (‏`src-tauri/target/` مُتجاهَل). فيُتسامح معه في الوضع الافتراضي ويُسقط في
 * `--require-artifacts` — كغياب الأثر سواء.
 *
 * @returns {{path:string|null, sha256:string|null, searched:string[]}}
 */
function resolveBinary(repo, explicit) {
  const candidates = [];
  const searched = [];
  if (explicit) {
    // مسار صريح **لا يسقط إلى غيره**: من سمّى ثنائياً بعينه فقد قال على أيّ
    // مُخرَج يشهد، والسقوط الصامت إلى ثنائي آخر يجعل الشهادة على غير المطلوب.
    const full = path.resolve(explicit);
    searched.push(full);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return { path: full, sha256: sha256Of(full), searched };
    }
    return { path: null, sha256: null, searched };
  }
  candidates.push(defaultBinaryPath(repo));
  candidates.push(path.join(repo, '..', 'haramlite-rs', 'src-tauri', 'target', 'release', 'HaramLite.exe'));
  for (const c of candidates) {
    const full = path.resolve(c);
    if (searched.includes(full)) continue;
    searched.push(full);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return { path: full, sha256: sha256Of(full), searched };
    }
  }
  return { path: null, sha256: null, searched };
}

/** بصمة ملف بلا تحميله كاملاً في الذاكرة (الثنائي 39MB). */
function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}


// ---------------------------------------------------------------------------
// تحليل صفوف Markdown
// ---------------------------------------------------------------------------

/**
 * يقسم سطر جدول إلى خاناته. يحترم `\|` (شرطة مائلة عكسية تسبق الأنبوب) كأنبوب
 * حرفي داخل الخانة — فالملف يوثّق قالب الصفّ بهذه الصيغة.
 *
 * الطرفان يُطرحان **بالقياس لا بالموضع**: ما قبل أول `|` فارغٌ دائماً فيُطرح،
 * وأما الخانة الأخيرة فتُطرح **فقط إن كان الصفّ منتهياً بأنبوب**. و`slice(1,-1)`
 * كان يطرحها دائماً، فصفٌّ صحيح في Markdown بلا أنبوب ختامي
 * (`| 9.9 **[إلزامي]** | ... | ✅ · 2026-09-17 · جهاز |`) يفقد خانته الأخيرة
 * ⇒ يُقيَّم عمودٌ آخر (عطل مُعاد إنتاجه: طُبع «فارغ بلا تاريخ · بلا نتيجة»).
 * @param {string} line
 * @returns {string[]|null} الخانات مقصوصة، أو null إن لم يكن سطر جدول.
 */
function splitRow(line) {
  if (!/^\s*\|/.test(line)) return null;
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  // اطرح الطرفين الفارغين (قبل أول `|` وبعد آخر `|`).
  if (cells.length < 2) return null;
  const body = cells.slice(1);
  // `cur` هو ما تلا آخر أنبوب: فارغاً (أو مسافات) ⇒ الصفّ منتهٍ بأنبوب.
  const endedWithPipe = cur.trim() === '';
  return (endedWithPipe ? body.slice(0, -1) : body).map((c) => c.trim());
}

/** هل الخانة فاصل ترويسة (`---`, `:--:`, …)؟ */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^[-:\s]+$/.test(c) && c !== '');
}

/**
 * يستخرج صفوف البيانات من نصّ المصفوفة.
 *
 * الجدول يُعرَّف بالبنية لا بعنوان الخانة: العنوان يختلف فعلاً بين أقسام الملف
 * («النتيجة المتوقَّعة (بسندها من الكود)» مقابل «النتيجة المتوقَّعة»)، فالاعتماد
 * على نصّه كان سيُسقط أقساماً كاملة بصمت.
 *
 * كل جدول: سطر ترويسة (يُسقَط) ← سطر فاصل ← صفوف البيانات.
 *
 * الخانات تُقرأ **بالموضع** من الطرفين: الأولى هي `#` والأخيرة هي النتيجة. عدُّ
 * الخانات لا يصلح حَكماً — صفّ نتيجته فارغة يُكتب `| |` فيُقرأ ستّ خانات، وصفّ
 * نتيجة مُملوءة يُقرأ خمساً؛ فالحكم بالموضع يستوعب الحالتين.
 *
 * @param {string} text
 * @returns {Array<{line:number,mandatory:boolean,id:string,resultCell:string}>}
 */
function parseRows(text) {
  const lines = text.split(/\r?\n/);

  // المرحلة ١: مواقع أسطر الجداول، وأيُّ سطر يسبق فاصلاً مباشرةً (فهو ترويسة).
  const tableRows = []; // { index, raw }
  const headerIndexes = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const raw = splitRow(lines[i]);
    if (!raw) continue;
    if (isSeparatorRow(raw)) {
      // السطر السابق للفاصل هو ترويسة الجدول — يُسقَط بمقارنة الموضع،
      // ولا يُحذف بالعدّ من المصفوفة (وهو ما أكل آخر صفٍّ في كل جدول).
      for (let k = tableRows.length - 1; k >= 0; k -= 1) {
        if (tableRows[k].index === i - 1) {
          headerIndexes.add(tableRows[k].index);
          break;
        }
      }
      continue;
    }
    tableRows.push({ index: i, raw });
  }

  // المرحلة ٢: صفوف المصفوفة = ما بقي بعد إسقاط الترويسات، ويبدأ بمعرّف رقمي.
  const rows = [];
  for (const { index, raw } of tableRows) {
    if (headerIndexes.has(index)) continue;
    if (raw.length < 3) continue; // ليس صفّ مصفوفة (جدول من عمودين)
    if (!/^\d+(?:\.\d+)*/.test(raw[0])) continue;

    rows.push({
      line: index + 1,
      // الوسم يُفحَص على الخانة الخام قبل إسقاط `**` — الصفوف تكتب `**[إلزامي]**`.
      mandatory: MANDATORY_RE.test(raw[0]),
      id: (raw[0].match(/^\d+(?:\.\d+)*/) || [''])[0],
      resultCell: raw[raw.length - 1],
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// الحكم على «مملوء»
// ---------------------------------------------------------------------------

/** يوحّد الأرقام العربية-الهندية والفارسية إلى لاتينية. */
function normalizeDigits(s) {
  return s
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

/**
 * يبحث عن تاريخ في الخانة. يستقبل `YYYY-MM-DD` وأخواتها (`YYYY/MM/DD`، `YYYY.MM.DD`)
 * والأرقام العربية-الهندية، وكذلك `YYYY-MM` (سنة وشهر — أدقّ من لا شيء ومقبول).
 * @param {string} cell
 * @returns {string|null} التاريخ كما وُجد، أو null.
 */
function findDate(cell) {
  const norm = normalizeDigits(cell);
  const full = norm.match(/(?:^|[^\d])(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?![\d])/);
  if (full) return full[1];
  const ym = norm.match(/(?:^|[^\d])(\d{4}[-/.]\d{1,2})(?![\d])/);
  if (ym) return ym[1];
  return null;
}

/** يسقط التاريخ من الخانة (ليُفحَص الباقي: نتيجة وجهاز). */
function stripDates(cell) {
  return normalizeDigits(cell).replace(/\d{4}[-/.]\d{1,2}([-/.]\d{1,2})?/g, ' ');
}

/** علامات النتيجة المسموحة (فهرس «كيف تُملأ المصفوفة»). */
const RESULT_RE = /^(✅|❌|⚠️?|—|-{1,2})$/;
/** علامة «لم يُنفَّذ» — حالةٌ مسجَّلة، لا خانة فارغة. تُقبل نصّاً حرّاً. */
const NOT_RUN_RE = /^(—|-{1,2}|لم\s*(?:يُ|ي)?نفَّذ|لم\s*ينفذ)$/;

/** يفصل الخانة إلى خانات فرعية على الفواصل `·` أو `|`. */
function splitSlots(cell) {
  return normalizeDigits(cell)
    .split(/[·|]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** هل النصّ يصلح رمزاً/اسماً لجهاز؟ (ليس علامة نتيجة، وليس مجرّد رقم) */
function isDeviceToken(s) {
  if (!s) return false;
  if (RESULT_RE.test(s)) return false;
  if (!/\p{L}/u.test(s)) return false; // لا حروف ⇒ ليس اسماً (يرفض «12.3s» و«3060»)
  if (/^\d+(\.\d+)*$/.test(s)) return false;
  return true;
}

/**
 * يحكم على خانة النتيجة: هل فيها **تاريخ + جهاز + نتيجة**؟
 *
 * الثلاثة شرط متّصل: نقص أيٍّ منها ⇒ الصفّ فارغ (تعريف خطة 0.2.7).
 * @param {string} cell
 * @returns {{ok:boolean,date:string|null,device:string|null,result:string|null,missing:string[]}}
 */
function assessCell(cell) {
  const raw = (cell || '').trim();
  if (raw === '') {
    return { ok: false, date: null, device: null, result: null, missing: ['تاريخ', 'جهاز', 'نتيجة'] };
  }

  const date = findDate(raw);
  const slots = splitSlots(stripDates(raw));

  // مرشَّحو الجهاز: كل خانة ليست علامة نتيجة. الجهاز أول خانة تحمل حروفاً.
  const deviceSlots = slots.filter((s) => !RESULT_RE.test(s));
  const namedDevice = deviceSlots.find(isDeviceToken);
  const device = deviceSlots.length > 0 ? (namedDevice !== undefined ? namedDevice : deviceSlots[0]) : null;

  // النتيجة: علامة صريحة، أو نصّ حرّ (آخر خانة تحمل حروفاً وليست الجهاز).
  let result = slots.find((s) => RESULT_RE.test(s)) || null;
  const notRun = NOT_RUN_RE.test(raw);
  if (result === null && !notRun) {
    const free = deviceSlots.filter((s) => s !== device && /\p{L}/u.test(s));
    if (free.length > 0) result = free[free.length - 1];
  }

  const missing = [];
  if (date === null) missing.push('تاريخ');
  if (device === null) missing.push('جهاز');
  if (result === null) missing.push('نتيجة');

  return { ok: missing.length === 0, date, device, result, missing };
}

// ---------------------------------------------------------------------------
// التشغيل
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    file: DEFAULT_FILE,
    quiet: false,
    help: false,
    repo: null,
    evalOut: null,
    rowAreas: null,
    browserOut: null,
    exe: null,
    requireArtifacts: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--require-artifacts') opts.requireArtifacts = true;
    else if (arg.startsWith('--file=')) opts.file = arg.slice('--file='.length);
    else if (arg.startsWith('--repo=')) opts.repo = arg.slice('--repo='.length);
    else if (arg.startsWith('--eval-out=')) opts.evalOut = arg.slice('--eval-out='.length);
    else if (arg.startsWith('--browser-out=')) opts.browserOut = arg.slice('--browser-out='.length);
    else if (arg.startsWith('--row-areas=')) opts.rowAreas = arg.slice('--row-areas='.length);
    else if (arg.startsWith('--exe=')) opts.exe = arg.slice('--exe='.length);
    else if (!arg.startsWith('-')) opts.file = arg;
    else {
      process.stderr.write(`وسيط غير معروف: ${arg}\n`);
      opts.help = true;
    }
  }
  return opts;
}

const USAGE = `الاستعمال: node scripts/matrix-check.cjs [--file=<path>] [--quiet] [--require-artifacts] [--exe=<path>]

  --file=<path>       مسار المصفوفة (افتراضاً qa/TEST-MATRIX.md)
  --eval-out=<dir>    مجلد آثار المُقيِّمين (افتراضاً <المستودع>/qa/eval/out)
  --browser-out=<dir> مجلد آثار صفوف المتصفّح §٨ (افتراضاً <المستودع>/qa/browser-rows)
  --repo=<dir>        جذر المستودع لالتزام HEAD (افتراضاً: جذر المصفوفة ثم cwd)
  --exe=<path>        الثنائي المُسلَّم الذي تُربط به الآثار
                      (افتراضاً <المستودع>/src-tauri/target/release/HaramLite.exe)
  --row-areas=<file>  جدول ربط بديل (JSON: صفّ ← [مسارات]) — للفحص الذاتي أساساً
  --require-artifacts وضع التسليم: غياب أثر أو غياب ثنائي **فشل**
  --quiet             لا تطبع إلا الملخّص وسطور النقص
  --selfcheck         يفحص الحارس نفسه على مصفوفات وآثار مصنوعة
  --help              هذه الرسالة

يرجع 0 إن اكتملت كل الصفوف الإلزامية ومرّ أثر كل صفّ قابل للتقييم ·
1 إن بقي صفّ ناقص أو أثر مرفوض · 2 عند خطأ بنية/استعمال.

**لا ائتمان بلا أثر مُعاد إنتاجه** (خطة 0.2.9 §١٠): صفٌّ «قابل للتقييم» (‏طبقة أ:
1.1 · 1.4 · 2.1 · 2.4 · 3.1 · 3.2 · 3.3 · 3.7 · 3.8 · 3.9) نتيجته ✅ أو ⚠️ لا
يُقبل إلا بأثر في \`qa/eval/out/<رقم>.json\` يحقّق **ثمانية** شروط: row مطابق ·
verdict=pass · outputs غير فارغة · exe_sha256 غير فارغ · commit سلفٌ لـHEAD ·
منطقة الصفّ لم تتغيّر بين ذلك الالتزام وHEAD · و**exe_sha256 يطابق بصمة الثنائي
المُسلَّم** (فأثرٌ يشهد على ثنائي غيره ليس دليلاً). وفي الصفوف السلبية (3.1 · 3.3)
يكون \`outputs\` هو **ملف السجلّ** — منتجُ العملية الحقيقي عند الرفض — و
\`product_outputs\` فارغة صريحةً، فلا يُدَّعى ناتج لم يُنتج. التفصيل في \`qa/eval/README.md\`.

**ووضعان صريحان، ولا تُسكَت البوّابة في أيّهما**:
  · **الافتراضيّ (وضع CI)**: **غياب بيئيّ** (أثر غائب · ثنائي غير موجود) ⇒ يُذكر
    بسطر صارخ ويبقى 0؛ وأثر موجود لكنه **بائت أو مخالف أو بصمته لا تطابق الثنائي**
    ⇒ **فشل دائماً**. والتسامح بيئيّ لا دلاليّ: مهمّة CI لا ثنائي فيها ولا tools
    (‏bin/ و models/ كـstubs فارغة — ci.yml:61-68 · :289-290). و\`exit 0\` هنا
    **ليس** شهادة قبول.
  · **\`--require-artifacts\` (وضع التسليم)**: غياب أي أثر أو غياب الثنائي **فشل**
    يسمّي الصفوف والمسارات المفقودة. وهو شرط التسليم قبل كل نسخة تُسلَّم.`;

/* ---------------------------------------------------------------------------
// الفحص الذاتي: الحارس يُسقط على نصّ مُخرَّب، ويمرّ على نصّ سليم رآه فعلاً
// ---------------------------------------------------------------------------
// العطل الذي وُلد هذا الفحص لأجله: `slice(1,-1)` كان يطرح الخانة الأخيرة من
// صفٍّ **بلا أنبوب ختامي** — وهو صفّ صحيح في Markdown — فيقرأ عموداً آخر
// ويطبع «فارغ بلا تاريخ · بلا نتيجة» عن صفٍّ مملوء. فالفحص يشغّل هذا الملف
// نفسه (لا دواله وحده) على مصفوفات مصنوعة، ويحكم على رمز الخروج وعلى النصّ:
//
//   ① **ضابط بلا أنبوب**: صفّ مملوء بلا أنبوب ختامي ⇒ يجب أن يمرّ (0)
//      **وقد رأى تاريخه وجهازه ونتيجته** — وإلا مرّ لأنه لم ينظر.
//   ② **تكافؤ**: الصفّ نفسه بأنبوب ختامي ⇒ نفس الحكم ونفس السبب المطبوع.
//   ③ **مُفسَد**: صفّ إلزامي بخانة نتيجة فارغة ⇒ يجب أن يُسقط الحارس (1).
//   ④ **صفر مدخل**: مصفوفة بلا صفّ إلزامي ⇒ يجب أن تفشل بصوت عالٍ (2).
//
// كل عمليات الخادم/الطفل تُطلق بلا نافذة (`windowsHide`)، والمجلد المصنوع
// تحت `os.tmpdir()` ويُحذف في النهاية. */

/* ---------------------------------------------------------------------------
// الفحص الذاتي الثاني: بوّابة الأثر تُسقط كل مُفسَد، وتمرّ على الضابط
// ---------------------------------------------------------------------------
// البوّابة الجديدة تقول «لا ائتمان بلا أثر مُعاد إنتاجه»؛ والدليل أنها **ترى**
// أن تُبنى لها بيئة مصنوعة فيها مستودع git حقيقي، وأثر حقيقي، ثم تُخرَّب واحدةً
// واحدة. ولكل حالة **خرج فشل حرفي** متوقَّع، و**ضابط** يمرّ. وثلاثة منها تخصّ
// البنية (رمز 2) لا الأثر: جدول ربط مفقود · صفر صفّ · صفّ غائب عن المصفوفة.
//
//   Ⓐ  ضابط: عشرة آثار سليمة عند HEAD ⇒ 0
//   Ⓐ′ ضابط الوضع الصارم: الآثار العشرة + `--require-artifacts` ⇒ 0
//   Ⓑ  أثر غائب في الوضع الافتراضي ⇒ 0 **مع السطر الصارخ** يسمّي الصفّ
//   Ⓑ′ الأثر نفسه في وضع التسليم ⇒ 1
//   Ⓒ  أثر بائت: تغيّر `media.rs` بعد الأثر ⇒ تسقط صفوف منطقة `media.rs` وحدها،
//      و**لا** يسقط صفّ منطقته `cuda_runtime.rs` (‏الفحص لكل صفّ لا شامل)
//   Ⓓ  أثر بـ`verdict=fail` والصفّ ✅ ⇒ يسقط (في الوضعين)
//   Ⓔ  أثر بـ`outputs` فارغة ⇒ يسقط
//   Ⓕ  أثر بـ`exe_sha256` فارغ ⇒ يسقط
//   Ⓖ  أثر بـ`row` مخالف ⇒ يسقط
//   Ⓗ  `commit` ليس سلفاً لـHEAD ⇒ يسقط
//   Ⓘ  منطقة الصفّ غير موجودة على القرص (تغيير غير مُلتزم) ⇒ يسقط — وهو ما
//      يمنع «منطقة يتيمة» تجعل `git diff` ينجح دائماً فيصير الشرط تجاوزاً
//   Ⓙ  جدول ربط صفر صفّ ⇒ 2   Ⓚ صفّ من الطبقة (أ) بلا منطقة ⇒ 2
//   Ⓛ  جدول ربط غير موجود ⇒ 2  Ⓜ صفّ من الطبقة (أ) غائب عن المصفوفة ⇒ 2
//   Ⓞ  الوضع الافتراضي ومجلد آثار فارغ ⇒ 0 **مع السطر الصارخ** (عدد · صفوف ·
//      «القبول النهائي يشترط --require-artifacts»)
//   Ⓟ  الوضع الصارم ومجلد آثار فارغ ⇒ 1 يسمّي العشر ومسار كل أثر مفقود
//   Ⓠ  **مُفسَد على الحارس نفسه**: نسخة من هذا الملف حُذف منها نداء السطر
//      الصارخ ⇒ متوقَّعات Ⓞ **تسقط كلها** عليها، وتمرّ على الحارس السليم.
//      فهو الدليل أن السطر محروس لا تجميلي، وأن حذفه يُسقط فحصاً.
//   Ⓗ′ ضابط الربط: الآثار تحمل بصمة الثنائي المصنوع ⇒ 0 في الوضعين
//   Ⓘ′ أثر ببصمة **ثنائي آخر** (٦٤ تسعة) والثنائي موجود ⇒ يسقط **في الوضعين**
//      (‏وهذا هو الثقب الذي كشفه الدمج: الحقل كان يُفحَص غير فارغ لا مطابقاً)
//   Ⓙ′ الثنائي غير موجود (غياب بيئيّ) + الافتراضيّ ⇒ 0 مع سطر صارخ يسمّي
//      الصفوف غير المربوطة وجذور البحث
//   Ⓙ″ نفسه + `--require-artifacts` ⇒ 1 يسمّي الصفوف */
function selfcheckArtifacts(workDir) {
  const fsMod = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const cases = [];

  const git = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  const mkIn = (dir, rel, text) => {
    const p = path.join(dir, rel);
    fsMod.mkdirSync(path.dirname(p), { recursive: true });
    fsMod.writeFileSync(p, text);
  };
  const headOf = (dir) => git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  const branchOf = (dir) => git(dir, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();

  /** صفوف §٨ في البيئة المصنوعة: **بلا ادّعاء** (`—`) فلا يُطلب لها أثر — إلا في
   *  الحالات التي تُبنى لها آثار مصنوعة صراحةً. وهي لازمة البنية: البوّابة ترفض
   *  غياب صفوف المتصفّح (رمز 2)، فبيئة بلا §٨ ليست بيئة مصفوفة واقعية. */
  const BROWSER_MATRIX_ROWS = BROWSER_ROWS.map(
    (id) => `| ${id} | بيئة مصنوعة | خطوات مصنوعة | نتيجة متوقَّعة | — · 2026-09-17 · جهاز-مصنوع · لم يُقَس |`
  );

  function initFixture(dir) {
    const header = ['| # | البيئة | الخطوات | النتيجة المتوقَّعة | النتيجة |', '| --- | --- | --- | --- | --- |'];
    const rows = LAYER_A_ROWS.map(
      (id) => `| ${id} **[إلزامي]** | بيئة مصنوعة | خطوات مصنوعة | نتيجة متوقَّعة | ✅ · 2026-09-17 · جهاز-مصنوع · نصّ |`
    );
    mkIn(dir, path.join('qa', 'TEST-MATRIX.md'), `${header.join('\n')}\n${[...rows, ...BROWSER_MATRIX_ROWS].join('\n')}\n`);
    for (const id of LAYER_A_ROWS) {
      for (const rel of ROW_AREAS[id]) mkIn(dir, rel, '// منطقة الصفّ المصنوعة\n');
    }
    // سطح صفوف §٨ المصنوع: مُقيِّم مصنوع وملف مقيس مصنوع.
    mkIn(dir, path.join('scripts', 'check-browser-rows.mjs'), BROWSER_EVAL_STUB);
    mkIn(dir, BROWSER_SURFACE_REL, BROWSER_SURFACE_BODY);
    // ثنائي مصنوع في موضعه المُسلَّم: الأثر يشهد على بصمته، وغيابه غياب بيئيّ.
    mkIn(dir, path.join('src-tauri', 'target', 'release', 'HaramLite.exe'), 'MZ-stub-HaramLite\n');
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'selfcheck@local']);
    git(dir, ['config', 'user.name', 'selfcheck']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'init']);
    return headOf(dir);
  }

  const BROWSER_EVAL_STUB = '// مُقيِّم صفوف المتصفّح المصنوع (بصمته تُقابَل)\nexport const x = 1;\n';
  const BROWSER_SURFACE_REL = path.join('browser-extension', 'content.js');
  const BROWSER_SURFACE_BODY = '// سطح القياس المصنوع (تغيّره يُبطل الأثر)\n';

  /** أثر صفّ متصفّح مصنوع بالعقد الذي تقرأه البوّابة: `row` · `verdict` ·
   *  `outputs` · `outputs_sha256` · `surface` (بصمات تُعاد حسابها) · `evaluator`. */
  function putBrowserArtifact(dir, row, over) {
    const sha = (rel) => crypto.createHash('sha256').update(fsMod.readFileSync(path.join(dir, rel))).digest('hex');
    const outputs = [{ key: 'gaps', value: 5 }, { key: 'keptSum', value: 57.5 }];
    // محرّك مصنوع **مطابق للمشترط في كل صفّ** — وإلا رُفض الأثر قبل الفحص المقصود.
    const engine = { '8.1': 'jsdom', '8.2': 'cdp (مصنوع)', '8.3': 'rust-test + jsdom (مصنوع)' }[row];
    const art = {
      row,
      id: `browser.${row}`,
      evaluator: path.join('scripts', 'check-browser-rows.mjs'),
      evaluator_sha256: sha(path.join('scripts', 'check-browser-rows.mjs')),
      engine,
      measured: true,
      verdict: 'pass',
      outputs,
      outputs_sha256: crypto.createHash('sha256').update(JSON.stringify(outputs)).digest('hex'),
      surface: [{ path: BROWSER_SURFACE_REL, sha256: sha(BROWSER_SURFACE_REL) }],
      ...over,
    };
    mkIn(dir, path.join('qa', 'browser-rows', `${row}.json`), JSON.stringify(art, null, 2));
    return art.outputs_sha256.slice(0, 8);
  }

  /** مصفوفة موسومة فيها صفّ بمُعطى ✅ + بصمة مكافأة — أساس حالات بوابة الأثر. */
  function browserClaimingFixture(dir, row, cell) {
    initFixture(dir);
    const p = path.join(dir, 'qa', 'TEST-MATRIX.md');
    const text = fsMod.readFileSync(p, 'utf8');
    const re = new RegExp(`^\\| ${row.replace('.', '\\.')} \\|[^\\n]*$`, 'm');
    const replaced = text.replace(re, `| ${row} | بيئة مصنوعة | خطوات مصنوعة | نتيجة متوقَّعة | ${cell} |`);
    if (replaced === text) throw new Error(`صفّ ${row} لم يُعثر عليه في البيئة المصنوعة`);
    fsMod.writeFileSync(p, replaced);
  }
  /** بصمة المكافأة تُشتقّ من الأثر نفسه في البيئة — فلا رقم مكتوب بيد هنا. */
  function claimedCell(dir, token, note) {
    return `✅ · 2026-09-17 · جهاز-مصنوع · مكافأة:${token}${note ? ` · ${note}` : ''}`;
  }

  const FIXTURE_BIN_REL = path.join('src-tauri', 'target', 'release', 'HaramLite.exe');
  /** بصمة الثنائي المصنوع — هي ما يجب أن تحمله `exe_sha256` في أثر سليم. */
  function fixtureBinarySha(dir) {
    const p = path.join(dir, FIXTURE_BIN_REL);
    return crypto.createHash('sha256').update(fsMod.readFileSync(p)).digest('hex');
  }

  function putArtifact(dir, row, over) {
    const art = {
      row,
      commit: headOf(dir),
      dirty: false,
      app_version: '0.0.0-مصنوع',
      exe_sha256: fixtureBinarySha(dir),
      command: 'مصنوع',
      exit: 0,
      wall_ms: 1,
      outputs: [{ path: 'x', bytes: 1, sha256: 'A'.repeat(64) }],
      verdict: 'pass',
      notes: 'مصنوع للفحص الذاتي',
      ...over,
    };
    mkIn(dir, path.join('qa', 'eval', 'out', `${row}.json`), JSON.stringify(art, null, 2));
  }

  function allArtifacts(dir, over) {
    for (const id of LAYER_A_ROWS) putArtifact(dir, id, over || {});
  }

  function run(dir, extraArgs, scriptPath) {
    const args = [
      scriptPath || __filename,
      `--file=${path.join(dir, 'qa', 'TEST-MATRIX.md')}`,
      `--repo=${dir}`,
      `--eval-out=${path.join(dir, 'qa', 'eval', 'out')}`,
      ...(extraArgs || []),
    ];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, cwd: dir });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
  }

  /**
   * متوقَّعات **السطر الصارخ وحده** — كل نصّ هنا لا يُطبعه غيره، فسقوط واحد منها
   * يعني أن السطر غاب. (ولهذا لا تُستعمل فيه ألفاظ تظهر في الملخّص أيضاً مثل
   * «1.1» أو «9 من 10»: توكيل الحكم إليها يجعل المُفسَد Ⓠ يمرّ.)
   * وتُقاس بها الحالة Ⓞ، ويُقاس بها المُفسَد Ⓠ على نسخةٍ من الحارس.
   */
  const NOTICE_EXPECT = [
    'غياب آثار',
    '10 من 10 صفّاً قابلاً للتقييم بلا أثر',
    'ليست شهادة قبول',
    'القبول النهائي يشترط `--require-artifacts`',
    'سبب التسامح مقيس',
    'stubs فارغة',
  ];
  /** الصفوف العشرة مسماةً في الملخّص — يفحصها Ⓞ منفصلةً عن ألفاظ السطر الصارخ. */
  const TEN_ROWS_LIST = '1.1 · 1.4 · 2.1 · 2.4 · 3.1 · 3.2 · 3.3 · 3.7 · 3.8 · 3.9';
  function noticeMissingFrom(out) {
    return NOTICE_EXPECT.filter((t) => !out.includes(t));
  }

  function caseRun(label, build, extraArgs, expect) {
    const dir = fsMod.mkdtempSync(path.join(workDir, 'art-'));
    const info = build(dir) || {};
    const res = run(dir, typeof extraArgs === 'function' ? extraArgs(dir, info) : extraArgs);
    const problems = [];
    if (res.status !== expect.status) problems.push(`رمز الخروج ${res.status} بدل ${expect.status}`);
    for (const t of expect.text || []) if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    for (const t of expect.notText || []) if (res.out.includes(t)) problems.push(`المخرَج يحوي «${t}» وهو ممنوع`);
    cases.push({ label, ok: problems.length === 0, detail: problems.join(' · '), out: res.out });
  }

  const freshFixture = (dir) => { initFixture(dir); allArtifacts(dir); };

  // Ⓐ الضابط
  caseRun('Ⓐ ضابط: عشرة آثار سليمة عند HEAD ⇒ 0', (d) => freshFixture(d), null, {
    status: EXIT.PASS,
    text: ['آثار: 10 من 10 مقبولة'],
  });
  // Ⓑ أثر غائب في الوضع الافتراضي: يُعلَن بالسطر الصارخ ولا يُسقط
  caseRun('Ⓑ الوضع الافتراضي: أثر صفّ واحد غائب ⇒ 0 مع السطر الصارخ يسمّيه', (d) => {
    freshFixture(d);
    fsMod.rmSync(path.join(d, 'qa', 'eval', 'out', '3.2.json'), { force: true });
  }, ['--quiet'], {
    status: EXIT.PASS,
    text: ['3.2', 'غياب آثار', '1 من 10', 'آثار: 9 من 10 مقبولة', 'الغائب: 3.2', '--require-artifacts'],
  });
  // Ⓑ′ الأثر نفسه في وضع التسليم ⇒ يسقط
  caseRun('Ⓑ′ وضع التسليم: أثر صفّ واحد غائب ⇒ 1 يسمّيه', (d) => {
    freshFixture(d);
    fsMod.rmSync(path.join(d, 'qa', 'eval', 'out', '3.2.json'), { force: true });
  }, ['--require-artifacts'], {
    status: EXIT.INCOMPLETE,
    text: ['وضع التسليم', '3.2', path.join('qa', 'eval', 'out', '3.2.json'), 'مفقود'],
    notText: ['غياب آثار —'],
  });
  // Ⓒ بائت — ويميّز بالمنطقة
  caseRun('Ⓒ أثر بائت: تغيّر media.rs ⇒ يسقط صفوف media.rs وحدها', (d) => {
    freshFixture(d);
    mkIn(d, path.join('src-tauri', 'src', 'media.rs'), '// تغيير بعد الأثر\n');
    git(d, ['add', '-A']);
    git(d, ['commit', '-qm', 'change media.rs']);
  }, null, {
    status: EXIT.INCOMPLETE,
    text: ['3.2', 'بائت', '2.1'],
    // 2.1 منطقتها cuda_runtime.rs · separator.rs — لم تتغيّر، فيجب ألّا تُرفض.
    notText: ['2.1: منطقة الصفّ تغيّرت'],
  });
  // Ⓓ verdict=fail
  caseRun('Ⓓ أثر verdict=fail والصفّ ✅ ⇒ يسقط', (d) => {
    freshFixture(d);
    putArtifact(d, '1.4', { verdict: 'fail' });
  }, null, { status: EXIT.INCOMPLETE, text: ['1.4', 'verdict في الأثر «fail»'] });
  // Ⓔ outputs فارغة
  caseRun('Ⓔ أثر outputs فارغة ⇒ يسقط', (d) => {
    freshFixture(d);
    putArtifact(d, '2.4', { outputs: [] });
  }, null, { status: EXIT.INCOMPLETE, text: ['2.4', 'outputs فارغة'] });
  // Ⓕ exe_sha256 فارغ
  caseRun('Ⓕ أثر exe_sha256 فارغ ⇒ يسقط', (d) => {
    freshFixture(d);
    putArtifact(d, '3.8', { exe_sha256: '   ' });
  }, null, { status: EXIT.INCOMPLETE, text: ['3.8', 'exe_sha256 فارغ'] });
  // Ⓖ row مخالف
  caseRun('Ⓖ أثر row مخالف ⇒ يسقط', (d) => {
    freshFixture(d);
    putArtifact(d, '3.9', { row: '9.9' });
  }, null, { status: EXIT.INCOMPLETE, text: ['3.9', 'لا يطابق الصفّ'] });
  // Ⓗ commit ليس سلفاً لـHEAD
  caseRun('Ⓗ commit ليس سلفاً لـHEAD ⇒ يسقط', (d) => {
    freshFixture(d);
    const base = branchOf(d);
    git(d, ['checkout', '-qb', 'other']);
    mkIn(d, path.join('other.txt'), 'x\n');
    git(d, ['add', '-A']);
    git(d, ['commit', '-qm', 'other']);
    const other = headOf(d);
    git(d, ['checkout', '-q', base]);
    putArtifact(d, '1.1', { commit: other });
  }, null, { status: EXIT.INCOMPLETE, text: ['1.1', 'ليس سلفاً لـHEAD'] });
  // Ⓘ منطقة الصفّ غير موجودة (تغيير غير مُلتزم) — يسدّ ثقب «منطقة يتيمة»
  caseRun('Ⓘ منطقة الصفّ غير موجودة على القرص ⇒ يسقط', (d) => {
    freshFixture(d);
    fsMod.rmSync(path.join(d, 'src-tauri', 'src', 'media.rs'), { force: true });
  }, null, { status: EXIT.INCOMPLETE, text: ['3.2', 'منطقة الصفّ لا وجود لها'] });
  // Ⓙ Ⓚ Ⓛ جدول الربط: بنية ⇒ 2
  caseRun('Ⓙ جدول ربط صفر صفّ ⇒ فشل بصوت عالٍ (2)', (d) => freshFixture(d), (d) => {
    mkIn(d, 'empty-areas.json', '{}');
    return [`--row-areas=${path.join(d, 'empty-areas.json')}`];
  }, { status: EXIT.MISUSE, text: ['جدول الربط صفر صفّ'] });
  caseRun('Ⓚ صفّ من الطبقة (أ) بلا منطقة ⇒ فشل بصوت عالٍ (2)', (d) => freshFixture(d), (d) => {
    mkIn(d, 'partial-areas.json', JSON.stringify({ '1.1': ['src-tauri/src/main.rs'] }));
    return [`--row-areas=${path.join(d, 'partial-areas.json')}`];
  }, { status: EXIT.MISUSE, text: ['صفوف الطبقة (أ) بلا منطقة', '3.9'] });
  caseRun('Ⓛ جدول ربط غير موجود ⇒ فشل بصوت عالٍ (2)', (d) => freshFixture(d), (d) => [
    `--row-areas=${path.join(d, 'no-such-areas.json')}`,
  ], { status: EXIT.MISUSE, text: ['تعذّرت قراءة جدول الربط'] });
  caseRun('Ⓜ صفّ من الطبقة (أ) غائب عن المصفوفة ⇒ فشل بصوت عالٍ (2)', (d) => {
    initFixture(d);
    allArtifacts(d);
    const p = path.join(d, 'qa', 'TEST-MATRIX.md');
    const kept = fsMod
      .readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\|\s*3\.7\s/.test(l))
      .join('\n');
    fsMod.writeFileSync(p, kept);
  }, null, { status: EXIT.MISUSE, text: ['غائبة عن المصفوفة', '3.7'] });

  /* ── §٨ — بوابة أثر صفوف المتصفّح (ثقب و-٢ الذي أثبته الجاسوس) ─────────────
   * الثقب المقيس: `✅ · <تاريخ> · <جهاز> · <أي نصّ>` كان يمرّ في أيّ صفّ خارج
   * `ROW_AREAS` العشري **بلا أثر** — حتى مع `[إلزامي]` («21 من 21 مملوء»، exit 0).
   * وهذه الحالات تُثبت أن البوّابة الجديدة ترى: ضابط يمرّ بأثر مطابق، ومُفسَدات
   * تسقط (غياب الأثر · سطح تغيّر · verdict=fail · مُقيِّم تغيّر · صفّ مُلفَّق)،
   * وحالتا بنية (خانة فارغة · صفّ محذوف) تفشلان بصوت عالٍ (2). */
  caseRun('§٨-① ضابط: صفّ ٨.١ بـ✅ وبصمة مكافأة مطابقة وأثر مطابق ⇒ 0', (d) => {
    initFixture(d);
    const token = putBrowserArtifact(d, '8.1');
    browserClaimingFixture(d, '8.1', claimedCell(d, token));
  }, null, { status: EXIT.PASS, text: ['آثار المتصفّح (§٨): 1 من 1 مقبولة'] });

  caseRun('§٨-② مُفسَد: صفّ ٨.٢ بـ✅ وأرقام ملفَّقة **بلا أثر** ⇒ 1 (كان exit 0 قبل الإصلاح)', (d) => {
    browserClaimingFixture(d, '8.2', '✅ · 2026-09-17 · جهاز-وهمي · فجوات 999 · keptSum 12345');
  }, null, {
    status: EXIT.INCOMPLETE,
    text: ['8.2', 'بلا أثر', 'pnpm browser:rows'],
  });

  caseRun('§٨-③ مُفسَد: أثر مطابق لكن **أرقام الصفّ ملفَّقة** (بصمة مكافأة مخالفة) ⇒ 1', (d) => {
    initFixture(d);
    const token = putBrowserArtifact(d, '8.1');
    const wrong = token === '00000000' ? '11111111' : '00000000';
    browserClaimingFixture(d, '8.1', claimedCell(d, wrong, 'فجوات 999 · keptSum 12345'));
  }, null, { status: EXIT.INCOMPLETE, text: ['8.1', 'بصمة المكافأة في الصفّ', 'ليست أرقام الأثر'] });

  caseRun('§٨-④ مُفسَد: صفّ مُلفَّق داخل القسم ٨ (٨.٩) بـ✅ بلا أثر ⇒ 1', (d) => {
    const p = path.join(d, 'qa', 'TEST-MATRIX.md');
    initFixture(d);
    fsMod.writeFileSync(p, `${fsMod.readFileSync(p, 'utf8')}| 8.9 | بيئة مصنوعة | خطوات مصنوعة | نتيجة متوقَّعة | ✅ · 2026-09-17 · جهاز-مصنوع · مكافأة:deadbeef |\n`);
  }, null, { status: EXIT.INCOMPLETE, text: ['8.9', 'بلا أثر'] });

  caseRun('§٨-⑤ مُفسَد: الأثر موجود لكن سطح الصفّ تغيّر بعده ⇒ 1 (أثر بائت)', (d) => {
    initFixture(d);
    const token = putBrowserArtifact(d, '8.1');
    browserClaimingFixture(d, '8.1', claimedCell(d, token));
    mkIn(d, BROWSER_SURFACE_REL, `${BROWSER_SURFACE_BODY}// تغيير بعد القياس\n`);
  }, null, { status: EXIT.INCOMPLETE, text: ['8.1', 'سطح الصفّ تغيّر بعد القياس'] });

  caseRun('§٨-⑥ مُفسَد: أثر الصفّ بـverdict=fail ⇒ 1', (d) => {
    initFixture(d);
    const token = putBrowserArtifact(d, '8.1', { verdict: 'fail' });
    browserClaimingFixture(d, '8.1', claimedCell(d, token));
  }, null, { status: EXIT.INCOMPLETE, text: ['8.1', 'verdict في الأثر «fail»'] });

  caseRun('§٨-⑦ مُفسَد: المُقيِّم تغيّر بعد القياس ⇒ 1', (d) => {
    initFixture(d);
    const token = putBrowserArtifact(d, '8.1');
    browserClaimingFixture(d, '8.1', claimedCell(d, token));
    mkIn(d, path.join('scripts', 'check-browser-rows.mjs'), `${BROWSER_EVAL_STUB}// نسخة أحدث\n`);
  }, null, { status: EXIT.INCOMPLETE, text: ['8.1', 'المُقيِّم تغيّر بعد القياس', 'check-browser-rows.mjs'] });

  caseRun('§٨-⑧ مُفسَد: صفّ ٨.٢ بأثر قِيس في بديل jsdom لا في متصفّح ⇒ 1', (d) => {
    initFixture(d);
    const token = putBrowserArtifact(d, '8.2', { engine: 'jsdom (بديل معلَن)' });
    browserClaimingFixture(d, '8.2', claimedCell(d, token));
  }, null, { status: EXIT.INCOMPLETE, text: ['8.2', 'engine في الأثر', 'لا يطابق المشترط'] });

  caseRun('§٨-⑨ بنية: صفّ متصفّح بخانة نتيجة فارغة ⇒ 2', (d) => {    browserClaimingFixture(d, '8.1', '');
  }, null, { status: EXIT.MISUSE, text: ['صفوف المتصفّح بلا سجلّ', '8.1'] });

  caseRun('§٨-⑩ بنية: صفّ ٨.٣ محذوف من المصفوفة ⇒ 2', (d) => {
    initFixture(d);
    const p = path.join(d, 'qa', 'TEST-MATRIX.md');
    fsMod.writeFileSync(
      p,
      fsMod.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => !/^\|\s*8\.3\s/.test(l)).join('\n')
    );
  }, null, { status: EXIT.MISUSE, text: ['صفوف المتصفّح غائبة عن المصفوفة', '8.3'] });

  /* ── الوضعان: التسليم (صارم) والافتراضيّ (متسامح مع الغياب وحده) ─────────── */

  // Ⓐ′ ضابط الوضع الصارم: الآثار العشرة موجودة ⇒ 0 في الوضعين أيضاً
  caseRun('Ⓐ′ ضابط الوضع الصارم: عشرة آثار سليمة + --require-artifacts ⇒ 0', (d) => {
    freshFixture(d);
  }, ['--require-artifacts'], {
    status: EXIT.PASS,
    text: ['آثار: 10 من 10 مقبولة', 'الوضع: التسليم'],
    notText: ['غياب آثار'],
  });

  // Ⓞ الافتراضيّ + مجلد آثار فارغ ⇒ 0 **مع السطر الصارخ** (وبـ`--quiet` كما في CI)
  caseRun('Ⓞ الافتراضيّ + لا آثار (‏--quiet كما في CI) ⇒ 0 مع السطر الصارخ المسمّى', (d) => {
    initFixture(d);
  }, ['--quiet'], {
    status: EXIT.PASS,
    text: [
      ...NOTICE_EXPECT,
      'آثار: 0 من 10 مقبولة',
      `الغائب: ${TEN_ROWS_LIST}`,
      'الوضع: الافتراضيّ/CI',
    ],
  });

  // Ⓟ الوضع الصارم + مجلد آثار فارغ ⇒ 1 يسمّي العشر ومسار الأثر
  caseRun('Ⓟ --require-artifacts + لا آثار ⇒ 1 يسمّي العشر', (d) => {
    initFixture(d);
  }, ['--require-artifacts'], {
    status: EXIT.INCOMPLETE,
    text: ['وضع التسليم', '1.1', '2.4', '3.9', path.join('qa', 'eval', 'out', '3.9.json'), 'مفقود'],
    notText: ['غياب آثار —'],
  });

  // Ⓠ مُفسَد على الحارس نفسه: نسخة بلا نداء السطر الصارخ ⇒ متوقَّعات Ⓞ تسقط.
  //    وهذا هو الدليل أن السطر **محروس** لا تجميلي: لو حُذف من الحارس لسقط فحص.
  {
    const label = 'Ⓠ مُفسَد: نسخة بلا السطر الصارخ ⇒ متوقَّعات Ⓞ تسقط (فالسطر محروس)';
    const dir = fsMod.mkdtempSync(path.join(workDir, 'art-notice-'));
    initFixture(dir);
    const problems = [];
    let mutantSrc = null;
    try {
      const src = fsMod.readFileSync(__filename, 'utf8');
      if (!src.includes(ENV_NOTICE_CALL)) {
        throw new Error('مُفسَد لم يغيّر الحارس — نصّ نداء السطر الصارخ لا يطابق');
      }
      mutantSrc = src.split(ENV_NOTICE_CALL).join(ENV_NOTICE_CALL_REMOVED);
      if (mutantSrc === src) throw new Error('مُفسَد لم يغيّر الحارس');
    } catch (err) {
      problems.push(err.message);
    }
    if (mutantSrc !== null) {
      const mutant = path.join(dir, 'matrix-check-no-notice.cjs');
      fsMod.writeFileSync(mutant, mutantSrc);
      const res = run(dir, null, mutant);
      if (res.status !== EXIT.PASS) {
        problems.push(`رمز الخروج ${res.status} بدل ${EXIT.PASS} — النسخة المطموسة يجب أن تبقى متسامحة`);
      }
      if (res.out.includes('غياب آثار')) problems.push('النسخة المطموسة ما زالت تطبع السطر الصارخ');
      const missed = noticeMissingFrom(res.out);
      if (missed.length !== NOTICE_EXPECT.length) {
        problems.push(`متوقَّعات Ⓞ لم تسقط كلها على النسخة المطموسة (سقط ${missed.length} من ${NOTICE_EXPECT.length})`);
      }
      // والضابط المقابل: نفس المتوقَّعات **تمرّ** على الحارس السليم (حالة Ⓞ أعلاه).
      const ok = run(dir, null, __filename);
      const missedOk = noticeMissingFrom(ok.out);
      if (missedOk.length > 0) problems.push(`متوقَّعات Ⓞ لا تمرّ على الحارس السليم: ${missedOk.join(' · ')}`);
    }
    cases.push({ label, ok: problems.length === 0, detail: problems.join(' · '), out: '' });
  }

  /* ── ارتباط الدليل بالمُخرَج المُسلَّم (‏exe_sha256 ← بصمة الثنائي) ─────────── */

  // Ⓗ′ ضابط: الثنائي المصنوع موجود وآثاره تحمل بصمته ⇒ 0 في الوضعين
  caseRun('Ⓗ′ ضابط الربط: بصمة الأثر = بصمة الثنائي ⇒ 0 في الوضعين', (d) => {
    freshFixture(d);
  }, ['--require-artifacts'], {
    status: EXIT.PASS,
    text: ['آثار: 10 من 10 مقبولة', 'الثنائي المُسلَّم:', 'الوضع: التسليم'],
    notText: ['ثنائي غير موجود'],
  });

  // Ⓘ′ مُفسَد: أثر ببصمة ثنائي آخر (٦٤ تسعة) والثنائي موجود ⇒ فشل في الوضعين
  for (const [tag, args] of [['الافتراضيّ', null], ['التسليم', ['--require-artifacts']]]) {
    caseRun(
      `Ⓘ′ مُفسَد (${tag}): exe_sha256 من ٦٤ تسعة والثنائي موجود ⇒ يسقط`,
      (d) => {
        freshFixture(d);
        putArtifact(d, '2.1', { exe_sha256: '9'.repeat(64) });
      },
      args,
      {
        status: EXIT.INCOMPLETE,
        text: ['2.1', 'لا يطابق الثنائي المُسلَّم', 'آثار: 9 من 10 مقبولة'],
        notText: ['غياب آثار —'],
      }
    );
  }

  // Ⓙ′ غياب بيئيّ: الثنائي غير موجود ⇒ الافتراضيّ 0 + السطر الصارخ، والتسليم 1
  caseRun('Ⓙ′ الثنائي غير موجود + الافتراضيّ ⇒ 0 مع السطر الصارخ للثنائي', (d) => {
    freshFixture(d);
    fsMod.rmSync(path.join(d, FIXTURE_BIN_REL), { force: true });
  }, ['--quiet'], {
    status: EXIT.PASS,
    text: [
      'ثنائي غير موجود',
      'غير مربوط بالمُخرَج المُسلَّم',
      '1.1',
      '3.9',
      'ليست شهادة قبول',
      'القبول النهائي يشترط `--require-artifacts`',
      `غير مربوط بالثنائي: ${TEN_ROWS_LIST}`,
      'الثنائي المُسلَّم: غير موجود',
    ],
  });
  caseRun('Ⓙ″ الثنائي غير موجود + --require-artifacts ⇒ 1 يسمّيه', (d) => {
    freshFixture(d);
    fsMod.rmSync(path.join(d, FIXTURE_BIN_REL), { force: true });
  }, ['--require-artifacts'], {
    status: EXIT.INCOMPLETE,
    text: ['وضع التسليم', 'لا ثنائي يُربط به', '2.4', '3.9', 'غير موجود فلا يُربط'],
    notText: ['⚠ ثنائي غير موجود'],
  });

  return cases;
}

const FIXTURE_HEADER = [
  '| # | البيئة | الخطوات | النتيجة المتوقَّعة | النتيجة |',
  '| --- | --- | --- | --- | --- |',
].join('\n');

/** صفوف §٨ في المصنوعات: بلا ادّعاء (`—`) فلا يُطلب لها أثر — لكنها **حاضرة**
 *  لأن البوّابة ترفض غيابها (رمز 2)، فبيئة بلا §٨ ليست مصفوفة واقعية. */
const BROWSER_FIXTURE_ROWS = BROWSER_ROWS.map(
  (id) => `| ${id} | بيئة مصنوعة | خطوات مصنوعة | نتيجة متوقَّعة | — · 2026-09-17 · جهاز-مصنوع |`
);

/** صفّ مصفوفة مصنوع. `tail` = خانة النتيجة، و`close` = الأنبوب الختامي. */
function fixtureRow(result, close) {
  const head = '| 9.9 **[إلزامي]** | بيئة مصنوعة | خطوات مصنوعة | نتيجة متوقَّعة |';
  return close ? `${head} ${result} |` : `${head} ${result}`;
}

function selfcheck() {
  const fsMod = require('node:fs');
  const osMod = require('node:os');
  const { spawnSync } = require('node:child_process');
  const dir = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'hl-matrix-selfcheck-'));
  const failures = [];
  const FILLED = '✅ · 2026-09-17 · Win11-26200/i9-10850K/RTX3070 · نصّ النتيجة';
  const cases = [
    {
      label: '① ضابط: صفّ مملوء بلا أنبوب ختامي يُقيَّم مملوءاً',
      rows: [fixtureRow(FILLED, false)],
      expectStatus: EXIT.PASS,
      expectText: ['1 من 1 مملوء', '2026-09-17', 'Win11-26200/i9-10850K/RTX3070'],
      forbidText: ['بلا تاريخ'],
    },
    {
      label: '② تكافؤ: الصفّ نفسه بأنبوب ختامي يعطي نفس الحكم',
      rows: [fixtureRow(FILLED, true)],
      expectStatus: EXIT.PASS,
      expectText: ['1 من 1 مملوء', '2026-09-17', 'Win11-26200/i9-10850K/RTX3070'],
      forbidText: ['بلا تاريخ'],
    },
    {
      label: '③ مُفسَد: خانة نتيجة فارغة تُسقط الحارس (1)',
      rows: [fixtureRow('', true)],
      expectStatus: EXIT.INCOMPLETE,
      expectText: ['9.9', 'بلا'],
      forbidText: [],
    },
    {
      label: '④ صفر مدخل: بلا صفّ إلزامي ⇒ فشل بصوت عالٍ (2)',
      rows: ['| 9.9 | بيئة مصنوعة | خطوات | نتيجة متوقَّعة | ✅ · 2026-09-17 · جهاز · نصّ |'],
      expectStatus: EXIT.MISUSE,
      expectText: ['صفر صفّ إلزامي'],
      forbidText: [],
    },
  ];

  for (const c of cases) {
    const file = path.join(dir, `case-${cases.indexOf(c)}.md`);
    /* المصنوعة تحمل صفوف الطبقة (أ) العشرة **غير إلزامية**: بوّابة الأثر تشترط
       أن يكون كل صفّ في جدول الربط حاضراً في المصفوفة (وإلا صار حذف الصفّ إسقاطاً
       للشرط)، والمصنوعة هنا تحكي مصفوفةً واقعية الشكل. وهي غير إلزامية كي تبقى
       توقّعات الحالات القائمة كما هي («1 من 1 مملوء»). */
    const present = LAYER_A_ROWS.map(
      (id) => `| ${id} | بيئة مصنوعة | خطوات مصنوعة | نتيجة متوقَّعة | — · 2026-09-17 · جهاز-مصنوع |`
    ).concat(BROWSER_FIXTURE_ROWS);
    fsMod.writeFileSync(file, `${FIXTURE_HEADER}\n${[...c.rows, ...present].join('\n')}\n`, 'utf8');
    const r = spawnSync(process.execPath, [__filename, `--file=${file}`], {
      encoding: 'utf8',
      windowsHide: true,
      cwd: dir,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const problems = [];
    if (r.status !== c.expectStatus) {
      problems.push(`رمز الخروج ${r.status} بدل ${c.expectStatus}`);
    }
    for (const t of c.expectText) {
      if (!out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    for (const t of c.forbidText) {
      if (out.includes(t)) problems.push(`المخرَج يحوي «${t}» وهو ممنوع`);
    }
    if (problems.length === 0) {
      process.stdout.write(`✅ ${c.label}\n`);
    } else {
      failures.push(`${c.label} — ${problems.join(' · ')}\n${out.trim()}`);
      process.stdout.write(`✗ ${c.label} — ${problems.join(' · ')}\n`);
    }
  }

  // الفحص الذاتي الثاني: بوّابة الأثر (لا ائتمان بلا أثر مُعاد إنتاجه).
  const artCases = selfcheckArtifacts(dir);
  for (const c of artCases) {
    if (c.ok) {
      process.stdout.write(`✅ ${c.label}\n`);
    } else {
      failures.push(`${c.label} — ${c.detail}\n${c.out.trim()}`);
      process.stdout.write(`✗ ${c.label} — ${c.detail}\n`);
    }
  }

  try {
    fsMod.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* مجلد مؤقت: فشل حذفه لا يُسقط الفحص */
  }

  const total = cases.length + artCases.length;
  if (failures.length > 0) {
    process.stderr.write(`\n✗ الفحص الذاتي: ${failures.length} حالة فشلت\n`);
    return EXIT.MISUSE;
  }
  process.stdout.write(`\n✓ الفحص الذاتي: ${total} من ${total} حالة سليمة\n`);
  return EXIT.PASS;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.MISUSE;
  }

  const file = path.resolve(opts.file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`خطأ: تعذّرت قراءة المصفوفة «${file}» — ${err.message}\n`);
    return EXIT.MISUSE;
  }

  const rows = parseRows(text);
  const mandatory = rows.filter((r) => r.mandatory);

  // حارس لا يرى ليس حارساً: صفر صفّ إلزامي = بنية الملف تغيّرت ⇒ فشل بصوت عالٍ.
  if (mandatory.length === 0) {
    process.stderr.write(
      'خطأ بنية: صفر صفّ إلزامي.\n' +
        `الملف: ${file}\n` +
        `صفوف الجدول المكتشفة: ${rows.length}\n` +
        'توقّف الحارس: «صفر صفّ إلزامي» ليس نجاحاً — تحقّق أن الوسم [إلزامي] ما زال في الخانة الأولى،\n' +
        'وأن الجدول ما زال خمس خانات، وأن الملف هو المصفوفة المقصودة.\n'
    );
    return EXIT.MISUSE;
  }

  const assessed = mandatory.map((r) => ({ ...r, verdict: assessCell(r.resultCell) }));
  const filled = assessed.filter((r) => r.verdict.ok);
  const incomplete = assessed.filter((r) => !r.verdict.ok);

  // ── جدول الربط: صفوف «قابلة للتقييم» ← منطقة كودها ───────────────────────
  let areas = ROW_AREAS;
  let areasSource = 'مدمج في الحارس (ROW_AREAS)';
  if (opts.rowAreas) {
    const p = path.resolve(opts.rowAreas);
    try {
      areas = JSON.parse(fs.readFileSync(p, 'utf8'));
      areasSource = p;
    } catch (err) {
      process.stderr.write(
        `خطأ بنية: تعذّرت قراءة جدول الربط «${p}» — ${err.message}\n` +
          'توقّف الحارس: جدول ربط لا يُقرأ ليس جدولاً، ولا ائتمان بلا جدول.\n'
      );
      return EXIT.MISUSE;
    }
  }
  const areasProblem = validateRowAreas(areas);
  if (areasProblem) {
    process.stderr.write(
      `خطأ بنية: جدول الربط غير صالح — ${areasProblem}\n` +
        `المصدر: ${areasSource}\n` +
        'توقّف الحارس: صفٌّ «قابل للتقييم» بلا منطقة كود لا يمكن التحقّق من أثره،\n' +
        'وحارس بلا جدول يمرّ لأنه لا ينظر. (خطة 0.2.9 §١٠ — الطبقة أ: ' +
        `${LAYER_A_ROWS.join(' · ')})\n`
    );
    return EXIT.MISUSE;
  }

  const repo = path.resolve(opts.repo || gitToplevel(path.dirname(file)) || process.cwd());
  const evalOut = path.resolve(opts.evalOut || path.join(repo, 'qa', 'eval', 'out'));
  // الطرف الثاني في سلسلة الدليل: الثنائي المُسلَّم الذي تُربط به الآثار.
  const binary = resolveBinary(repo, opts.exe);

  // صفٌّ في الجدول وغائب عن المصفوفة = شرط أُسقط بحذف الصفّ لا بتحقيقه.
  const goneFromMatrix = LAYER_A_ROWS.filter((id) => !rows.some((r) => r.id === id));
  if (goneFromMatrix.length > 0) {
    process.stderr.write(
      `خطأ بنية: صفوف «قابلة للتقييم» غائبة عن المصفوفة: ${goneFromMatrix.join(' · ')}\n` +
        `الملف: ${file}\n` +
        'توقّف الحارس: غياب الصفّ ليس إسقاطاً للشرط — أعِد الصفّ أو أعِد النظر في جدول الربط.\n'
    );
    return EXIT.MISUSE;
  }

  // ── صفوف المتصفّح (§٨): البنية أولاً — صفٌّ غائب أو بلا سجلّ فشلٌ بصوت عالٍ ──
  // الغياب أو الفراغ ليس إسقاطاً للشرط: صفّ يُحذف أو تُفرَّغ خانته كان يفلت من
  // كل فحص (‏`assessed` تُبنى من الإلزامية وحدها) — فيُقاس هنا صراحةً.
  const browserGone = BROWSER_ROWS.filter((id) => !rows.some((r) => r.id === id));  if (browserGone.length > 0) {
    process.stderr.write(
      `خطأ بنية: صفوف المتصفّح غائبة عن المصفوفة: ${browserGone.join(' · ')}\n` +
        `الملف: ${file}\n` +
        `توقّف الحارس: القسم ٨ يحمل مُقيِّماً (‏pnpm browser:rows) فلا يجوز حذف صفوفه — ` +
        'وإسقاط الشرط بحذف الصفّ ليس تحقيقه.\n'
    );
    return EXIT.MISUSE;
  }
  const browserOut = path.resolve(opts.browserOut || path.join(repo, BROWSER_OUT));
  // **كل صفّ في القسم ٨** — لا الثلاثة المعلَنة وحدها: صفٌّ جديد يُضاف موسوماً ✅
  // يجب أن يحمل أثره هو أيضاً، وإلا صار القسم ٨ باباً خلفياً لادّعاء بلا دليل
  // (وهو ما قِيس على صفّ ٨.٩ مُلفَّق: كان يمرّ بلا أثر).
  const sectionEight = [...new Set([...BROWSER_ROWS, ...rows.filter((r) => /^8\./.test(r.id)).map((r) => r.id)])].sort();
  const browserAssessed = sectionEight.map((id) => {
    const r = rows.find((x) => x.id === id);
    return { ...r, verdict: assessCell(r.resultCell) };
  });
  const browserEmpty = browserAssessed.filter((r) => !r.verdict.ok);
  if (browserEmpty.length > 0) {
    process.stderr.write(
      `خطأ بنية: صفوف المتصفّح بلا سجلّ (تاريخ · جهاز · نتيجة): ${browserEmpty.map((r) => r.id).join(' · ')}\n` +
        `الملف: ${file}\n` +
        'توقّف الحارس: خانة نتيجة فارغة في صفّ متصفّح ليست «لم يُقَس» — هي صفٌّ هرب من الأثر.\n'
    );
    return EXIT.MISUSE;
  }

  // ── أثر صفوف المتصفّح: **الغياب فشل**، والبائت فشل (عقد `BROWSER_ROWS`) ────
  const browserRowsOut = [];
  const browserProblems = []; // غائب أو مرفوض ⇒ فشل في الوضعين
  for (const r of browserAssessed) {
    if (!claimsSuccess(r.verdict)) {
      browserRowsOut.push({ id: r.id, state: 'بلا ادّعاء', detail: 'الخانة لا تدّعي نجاحاً (— أو ❌) فلا أثر مطلوب' });
      continue;
    }
    const { state, why } = inspectBrowserRowArtifact(r.id, browserOut, repo, r.resultCell);
    if (state === 'ok') {
      browserRowsOut.push({ id: r.id, state: 'مقبول', detail: `سطح: ${BROWSER_OUT}\\${r.id}.json` });
    } else {
      browserRowsOut.push({ id: r.id, state: state === 'missing' ? 'غائب' : 'مرفوض', detail: why });
      browserProblems.push({ id: r.id, why, missing: state === 'missing' });
    }
  }

  const gated = assessed.filter((r) => Object.prototype.hasOwnProperty.call(areas, r.id));

  // ── الأثر: لا يُقبل ✅/⚠️ في صفّ قابل للتقييم إلا بمسار مخرَج المُقيِّم ─────
  const artifactRows = [];
  const artifactProblems = []; // موجود ولم يجتز ⇒ فشل في الوضعين
  const artifactMissing = []; // لا ملف أصلاً ⇒ غياب بيئيّ: فشل في وضع التسليم وحده
  const artifactUnbound = []; // موجود، لكن لا ثنائي يُربط به ⇒ غياب بيئيّ مثله
  for (const r of gated) {
    if (!claimsSuccess(r.verdict)) {
      artifactRows.push({ id: r.id, state: 'بلا ادّعاء', detail: 'الخانة لا تدّعي نجاحاً (— أو ❌)' });
      continue;
    }
    const { state, why } = inspectRowArtifact(r.id, areas[r.id], repo, evalOut, binary);
    if (state === 'ok') {
      artifactRows.push({ id: r.id, state: 'مقبول', detail: `منطقة: ${areas[r.id].join(' · ')}` });
    } else if (state === 'missing') {
      artifactRows.push({ id: r.id, state: 'غائب', detail: why });
      artifactMissing.push({ id: r.id, why });
    } else if (state === 'unbound') {
      artifactRows.push({ id: r.id, state: 'غير مربوط', detail: why });
      artifactUnbound.push({ id: r.id, why });
    } else {
      artifactRows.push({ id: r.id, state: 'مرفوض', detail: why });
      artifactProblems.push({ id: r.id, why });
    }
  }
  const missingIds = artifactMissing.map((a) => a.id);
  const unboundIds = artifactUnbound.map((a) => a.id);
  const envGaps = {
    missingIds,
    unboundIds,
    // كتلة «لا ثنائي» تُطبع **فقط** إن كان للغياب أثر فعليّ (أثرٌ موجود بلا ثنائي)،
    // ولا تُطبع «0 من 10» بلا معنى — كتلة «غياب آثار» وحدها تحكي الحالة حينها.
    binarySearched: unboundIds.length > 0 ? binary.searched : null,
  };
  const hasEnvGap = missingIds.length > 0 || unboundIds.length > 0;

  const out = [];
  if (!opts.quiet) {
    out.push(`المصفوفة: ${file}`);
    out.push(`صفوف الجدول: ${rows.length} · الإلزامية: ${mandatory.length}`);
    out.push('');
    for (const r of assessed) {
      const status = r.verdict.ok ? 'مملوء' : 'فارغ';
      const reason = r.verdict.ok
        ? `${r.verdict.result} · ${r.verdict.date} · ${r.verdict.device}`
        : `بلا ${r.verdict.missing.join(' · بلا ')}`;
      out.push(`  ${r.id.padEnd(6)} ${status.padEnd(6)} ${reason}`);
    }
    out.push('');
  } else if (incomplete.length > 0) {
    for (const r of incomplete) {
      out.push(`  ${r.id.padEnd(6)} فارغ   بلا ${r.verdict.missing.join(' · بلا ')}`);
    }
    out.push('');
  }

  if (!opts.quiet) {
    out.push(`آثار المُقيِّمين: ${evalOut}`);
    out.push(`جدول الربط: ${areasSource}`);
    for (const a of artifactRows) {
      out.push(`  ${a.id.padEnd(6)} ${a.state.padEnd(9)} ${a.detail}`);
    }
    out.push('');
    out.push(`آثار صفوف المتصفّح (§٨): ${browserOut}`);
    for (const a of browserRowsOut) {
      out.push(`  ${a.id.padEnd(6)} ${a.state.padEnd(9)} ${a.detail}`);
    }
    out.push('');
  } else if (artifactProblems.length > 0 || hasEnvGap) {
    for (const a of artifactProblems) out.push(`  ${a.id.padEnd(6)} مرفوض     ${a.why}`);
    for (const a of artifactMissing) out.push(`  ${a.id.padEnd(6)} غائب      ${a.why}`);
    for (const a of artifactUnbound) out.push(`  ${a.id.padEnd(6)} غير مربوط ${a.why}`);
    out.push('');
  }

  const gatedClaiming = gated.filter((r) => claimsSuccess(r.verdict)).length;
  out.push(`الملخّص: ${filled.length} من ${mandatory.length} مملوء`);
  if (incomplete.length > 0) {
    out.push(`الناقص: ${incomplete.map((r) => r.id).join(' · ')}`);
  }
  out.push(
    `آثار: ${gatedClaiming - artifactProblems.length - missingIds.length - unboundIds.length} من ${gatedClaiming} مقبولة` +
      (artifactProblems.length > 0 ? ` — المرفوض: ${artifactProblems.map((a) => a.id).join(' · ')}` : '') +
      (missingIds.length > 0 ? ` — الغائب: ${missingIds.join(' · ')}` : '') +
      (unboundIds.length > 0 ? ` — غير مربوط بالثنائي: ${unboundIds.join(' · ')}` : '')
  );
  const browserClaiming = browserAssessed.filter((r) => claimsSuccess(r.verdict)).length;
  out.push(
    `آثار المتصفّح (§٨): ${browserClaiming - browserProblems.length} من ${browserClaiming} مقبولة` +
      (browserProblems.length > 0 ? ` — المرفوض/الغائب: ${browserProblems.map((a) => a.id).join(' · ')}` : '') +
      ` — المجلد: ${path.relative(repo, browserOut) || browserOut}`
  );
  // سطر الثنائي يُطبع دائماً — في الوضعين وفي `--quiet`: كل تشغيل يقول على أيّ
  // مُخرَج يشهد. ولا يُطبع في السطور المختصرة وحدها لئلا يغيب عن العين.
  out.push(
    binary.path
      ? `الثنائي المُسلَّم: ${binary.path} · sha256 ${binary.sha256.slice(0, 16)}…`
      : `الثنائي المُسلَّم: غير موجود — جُرِّب: ${binary.searched.join(' · ')}`
  );
  out.push(`الوضع: ${opts.requireArtifacts ? 'التسليم (--require-artifacts: الغياب فشل)' : 'الافتراضيّ/CI (الغياب يُعلَن ولا يُسقط)'}`);
  process.stdout.write(`${out.join('\n')}\n`);

  if (artifactProblems.length > 0) {
    process.stderr.write(
      `\n✗ لا ائتمان بلا أثر مُعاد إنتاجه — ${artifactProblems.length} صفّاً ادّعى النجاح وأثره **موجود ومرفوض**:\n`
    );
    for (const a of artifactProblems) process.stderr.write(`   - ${a.id}: ${a.why}\n`);
  }

  // صفوف المتصفّح: **الغياب فشل** لا غيابٌ بيئيّ — الأثر مُلتزَم ويُعاد إنتاجه
  // بأمر واحد على أيّ جهاز، فصفٌّ يقول ✅ بلا أثر مطابق ادّعاءٌ بلا دليل.
  if (browserProblems.length > 0) {
    process.stderr.write(
      `\n✗ لا ائتمان بلا أثر مُعاد إنتاجه (§٨ — صفوف المتصفّح): ${browserProblems.length} صفّاً ادّعى النجاح بلا أثر مطابق:\n`
    );
    for (const a of browserProblems) process.stderr.write(`   - ${a.id}: ${a.why}\n`);
    process.stderr.write('   الأمر: pnpm browser:rows — ثم التزم الآثار في qa/browser-rows/\n');
  }

  if (hasEnvGap) {
    if (opts.requireArtifacts) {
      // وضع التسليم: الغياب البيئيّ فشل — ويُسمّى بمساره لا بالرقم وحده.
      if (missingIds.length > 0) {
        process.stderr.write(
          `\n✗ وضع التسليم (--require-artifacts): ${missingIds.length} صفّاً قابلاً للتقييم بلا أثر:\n`
        );
        for (const a of artifactMissing) process.stderr.write(`   - ${a.id}: ${a.why}\n`);
      }
      if (unboundIds.length > 0) {
        process.stderr.write(
          `\n✗ وضع التسليم (--require-artifacts): لا ثنائي يُربط به ${unboundIds.length} أثراً — ` +
            'الدليل يجب أن يشهد على المُخرَج المُسلَّم:\n'
        );
        for (const a of artifactUnbound) process.stderr.write(`   - ${a.id}: ${a.why}\n`);
      }
    } else {
      emitEnvironmentalNotices(envGaps, gatedClaiming);
    }
  }

  const fails =
    incomplete.length > 0 ||
    artifactProblems.length > 0 ||
    browserProblems.length > 0 ||
    (opts.requireArtifacts && hasEnvGap);
  return fails ? EXIT.INCOMPLETE : EXIT.PASS;
}

if (require.main === module) {
  // `--selfcheck` قبل parseArgs: هو ليس مساراً ولا وسيطاً للمصفوفة.
  process.exitCode = process.argv.includes('--selfcheck')
    ? selfcheck()
    : main(process.argv);
}

module.exports = {
  parseRows,
  assessCell,
  findDate,
  splitRow,
  main,
  selfcheck,
  selfcheckArtifacts,
  validateRowAreas,
  inspectRowArtifact,
  inspectBrowserRowArtifact,
  claimsSuccess,
  resolveBinary,
  defaultBinaryPath,
  emitEnvironmentalNotices,
  ENV_NOTICE_CALL,
  ENV_NOTICE_CALL_REMOVED,
  ROW_AREAS,
  LAYER_A_ROWS,
  BROWSER_ROWS,
  BROWSER_OUT,
};
