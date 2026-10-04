#!/usr/bin/env node
/* حارس أوامر الوثائق (م٠ · خطة 0.3.0 — البند الأخير)
 *
 * **العلّة المقيسة**: أوامر كُتبت من الذاكرة لا من package.json وصلت إلى وثائق
 * معتمدة (‏`pnpm test` بدل `pnpm test:web`، و`pnpm i18n` الذي لا وجود له — سجل
 * المراجعة 2 في `docs/PLAN-0.3.0.md`). صنف خطأ يتكرر لأن كاتِب الوثيقة يذكر
 * أمراً سمعه ولا شيء يتحقق منه.
 *
 * **ما يقيسه**: كل رمز بصيغة `pnpm <token>` داخل **span شرطتين خلفيتين في سطر
 * واحد** أو **سطر داخل كتلة شيفرة مسوَّرة** — في كل ملف `*.md` **متتبَّع**،
 * وزيادة عليه **محلياً** في `docs/PLAN-*.md` (غير متتبَّعة فلا يراها CI).
 * الرمز سليم إن كان مفتاح سكربت في `package.json` أو من قائمة أوامر pnpm
 * المدمجة أدناه. ويُشترط **صفر لا يمر**: إن لم يُستخرج أي رمز فذلك خلل في
 * المستخرج لا نجاح (قاعدة «صفر مدخل ليس نجاحاً»).
 *
 * **كيف يميّز «أمراً سقط سهواً» من «أمراً مذكوراً كمثال سلبي» — بلا قراءة نية:**
 * الحارس يقيس **رمز الأمر** لا الحكاية حوله، ولا يوجد للإعفاء علامة داخلية
 * ولا قائمة استثناءات بالاسم — لأن أي علامة من هذه سيُطبَّق عليها يوماً خطأ
 * حقيقي فتُعاد فتح الصنف الذي أُغلق. فالتمييز قرارُ الوثيقة يُبيّنه **بصياغة
 * رمزه**: المثال السلبي يُكتب **مكسور الرمز** — «السكربت المسمى `i18n`» أو
 * «‏`pnpm` بسكربت اسمه `test`» — فيبقى نقدُ الخطأ سليماً في النثر ولا يشكّل
 * دعوى وجود أمر. والنص العادي (غير المسوَّر) خارج النطاق عمداً: قِيس أن
 * الوثائق المتتبعة تحوي نثراً مثل «كاش pnpm 20MB» و«pnpm 10 · node 20» في
 * `docs/AUDIT.md:1213` و`:1444` — فحص النثر كان سيُسقط الحارس على وثيقة سليمة.
 *
 * **حدود معلنة**: يقيس `pnpm` وحده (لا cargo ولا node) — صنف العلّة المقيسة
 * هو أوامر pnpm السكربتية. و`pnpm exec`/`pnpm dlx`/`pnpm run` تُقبل رمزاً
 * أولًا بأي وسيط (حدّ معلن أدناه)، والرمز الذي لا يشبه اسم أمر (مثل `pnpm <x>`
 * — مُفسِد بيد في وثيقة الخطة) **نثر لا رمز** بالنحو أدناه.
 *
 * **محلي فقط عمداً**: سكربت `package.json` (`pnpm doc:commands`)، لا خطوة في
 * `ci.yml` ولا صف في جدول البوّابات — كي يبقى العدّ ستة عشر (قيَس المالك).
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** أوامر pnpm المدمجة التي لا تحيل إلى سكربت المشروع. **لا** تشمل مختصرات
 *  `run` (`test` · `start` · `stop` · `restart`) عمداً: `pnpm test` ينفّذ
 *  سكربت `test` إن وُجد — وهو بالضبط صنف الخطأ المقيس، فيُقاس كسكربت. */
const BUILTINS = new Set([
  'install', 'i', 'add', 'update', 'up', 'remove', 'rm', 'uninstall', 'unlink',
  'link', 'import', 'dlx', 'exec', 'run', 'create', 'init', 'env', 'setup',
  'store', 'prune', 'why', 'list', 'ls', 'la', 'll', 'outdated', 'rebuild',
  'audit', 'licenses', 'bin', 'patch', 'patch-commit', 'patch-remove',
  'approve-builds', 'config', 'root', 'help', 'completion', 'self-update',
  'recursive', 'publish', 'pack', 'info', 'view', 'test-interactive',
]);

/** الرمز يجب أن **يشبه اسم أمر**: حرف/رقم أولاً، ثم أحرف وأرقام و `: @ . _ / -`.
 *  هذا يُسقط `pnpm <x>` (مُفسِد النثر) و`pnpm 20MB` لو وصل حرفياً لا يمرّ
 *  لأن `20MB` يبدأ برقم… فيُقبَل نحوياً ويُقاس كسكربت — والسطران المقيسان في
 *  AUDIT.md نثر خارج النطاق أصلاً. */
const TOKEN = /^[a-z0-9][a-z0-9:@._/-]*$/i;

function collectFiles() {
  const tracked = execSync('git ls-files -- "*.md"', { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const local = execSync('git ls-files --others --ignored --exclude-standard -- "docs/PLAN-*.md"', {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean);
  return [...new Set([...tracked, ...local])];
}

/** يعيد [{file, line, token}] لكل `pnpm <token>` داخل span أو كتلة مسوَّرة. */
function extractCommands(file, text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // كتلة مسوَّرة: كل ذكر `pnpm <token>` في السطر دعوى أمر. الالتقاط أول
      // رمز شبيه بأمر يلي `pnpm`، والحكم عليه بالنحو والقوائم أدناه.
      for (const m of line.matchAll(/pnpm\s+([A-Za-z0-9][A-Za-z0-9:@._/-]*)/g)) {
        out.push({ file, line: i + 1, token: m[1], where: 'fence' });
      }
      continue;
    }
    // span سطري واحد: `pnpm <token>`
    for (const span of line.matchAll(/`([^`\n]+)`/g)) {
      const m = span[1].match(/^pnpm\s+(\S+?)[.,;:!?]?$/);
      if (m) out.push({ file, line: i + 1, token: m[1], where: 'span' });
    }
  }
  return out;
}

const pkg = JSON.parse(fs.readFileSync(path.join('package.json'), 'utf8'));
const scripts = new Set(Object.keys(pkg.scripts || {}));

/** مسارات مُمرَّرة يدوياً ⇒ فحصها وحدها (للتشغيل الموجَّه، مثل الأمر المعلَن
 *  في خطة 0.3.0 على ملف الخطة نفسه). بلا وسائط ⇒ الجرد الكامل المعلَن أعلاه. */
const argvFiles = process.argv.slice(2);
const files = argvFiles.length > 0 ? argvFiles.slice() : collectFiles();
if (files.length === 0) {
  console.error('check-doc-commands: صفر ملفات .md — «صفر مدخل ليس نجاحاً»');
  process.exit(2);
}

let commands = [];
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  commands = commands.concat(extractCommands(file, fs.readFileSync(file, 'utf8')));
}
if (commands.length === 0) {
  console.error('check-doc-commands: لم يُستخرج أي رمز بصيغة pnpm-token — المستخرج مكسور، أو الملف المُمرَّر يدوياً لا يحمل أوامر pnpm أصلاً');
  process.exit(2);
}

/** `pnpm run <x>` و`pnpm exec <bin>`: رمزها الأول أمر مدمج فيُقبل، **ووسيطها
 *  لا يُقاس — حدّ معلن** (الوسيط في وسط الـspan ولا يصلح استخراجه موثوقاً من
 *  كل الصيغ). والقياس: لا وثيقة متتبعة تستعمل `pnpm run <x>` اليوم. */
const unknown = [];
for (const c of commands) {
  // نحو الرمز أولاً: ما لا يشبه اسم أمر (`pnpm <x>` — مُفسِد نثري) ليس دعوى
  // أمر فيُتخطى لا يُفشل.
  if (!TOKEN.test(c.token)) continue;
  if (BUILTINS.has(c.token)) continue;
  if (scripts.has(c.token)) continue;
  unknown.push(c);
}

if (unknown.length > 0) {
  console.error(`check-doc-commands: ${unknown.length} أمر pnpm بلا سكربت ولا أمر مدمج:`);
  const seen = new Set();
  for (const c of unknown) {
    const key = `${c.file}:${c.line}:${c.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`  - ${c.file}:${c.line} (${c.where}) → pnpm ${c.token}`);
  }
  console.error('⇒ صحّح الرمز إلى سكربت موجود في package.json، أو اذكر الأمر كسرد لا كرمز: «السكربت المسمى `<x>`».');
  process.exit(1);
}

const unique = new Set(commands.map((c) => c.token));
console.log(
  'check-doc-commands: ' + commands.length + ' رمزاً بصيغة pnpm-token في ' + files.length +
    ' ملف md (' + unique.size + ' فريداً) — كلها سكربتات أو أوامر pnpm مدمجة',
);
