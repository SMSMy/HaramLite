/* محقّق توازن الوسوم — المرجع النهائي.
   HTML يسمح بإغفال </p> و</li> … فنتجاهلها. ونفحص الباقي بمكدس حقيقي.

   تحصين هذه الجولة (عيب مُقاس: «✓ توازن الوسوم سليم في 0 صفحة» و exit 0 على
   مجلد فارغ): صفر مدخل · مجلد مفقود · ملف صريح مفقود ⇒ **فشل مسمّى**، لا نجاح
   صامت ولا stack trace.

   الاستعمال: node scripts/check-site-tags.cjs [ملف] [--root <dir>] */
const fs = require('fs');
const path = require('path');

const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const OPTIONAL_END = new Set(['p','li','dt','dd','td','th','tr','thead','tbody','tfoot','option','optgroup','rt','rp','colgroup','caption']);

function audit(file) {
  let t = fs.readFileSync(file, 'utf8');
  const raw = t;
  // إخفاء ما ليس وسوم HTML حقيقية (سكربتات/أنماط/تعليقات) مع حفظ أرقام الأسطر
  t = t.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
  t = t.replace(/<script[\s\S]*?<\/script>/gi, m => m.replace(/[^\n]/g, ' '));
  t = t.replace(/<style[\s\S]*?<\/style>/gi, m => m.replace(/[^\n]/g, ' '));
  const lineAt = i => (t.slice(0, i).match(/\n/g) || []).length + 1;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  const stack = [];
  const problems = [];
  while ((m = re.exec(t))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (VOID.has(tag) || /\/\s*$/.test(m[3] || '')) continue;
    const line = lineAt(m.index);
    if (!closing) { stack.push({ tag, line }); continue; }
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { idx = i; break; }
    if (idx === -1) {
      if (!OPTIONAL_END.has(tag)) problems.push('</' + tag + '> شارد عند السطر ' + line);
      continue;
    }
    const inside = stack.slice(idx + 1).filter(s => !OPTIONAL_END.has(s.tag));
    if (inside.length) {
      problems.push('</' + tag + '> عند السطر ' + line + ' وفي داخله مفتوح: ' +
        inside.map(s => '<' + s.tag + '>@' + s.line).join(' '));
    }
    stack.length = idx;
  }
  const left = stack.filter(s => !OPTIONAL_END.has(s.tag));
  if (left.length) problems.push('لم تُغلق: ' + left.map(s => '<' + s.tag + '>@' + s.line).join(' '));
  return { problems, raw };
}

function die(msg) {
  console.error('✗ حارس الوسوم: ' + msg);
  process.exit(1);
}

const argv = process.argv.slice(2);
let rootArg = null, only = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      console.error('✗ العلم --root يحتاج مساراً — مثال: --root /tmp/fixture');
      process.exit(2);
    }
    rootArg = argv[++i];
  } else if (argv[i].startsWith('--')) {
    console.error('✗ وسيط غير معروف: ' + argv[i] + ' — الاستعمال: [ملف] [--root <dir>]');
    process.exit(2);
  } else if (only === null) {
    only = argv[i];
  } else {
    console.error('✗ مرّر ملفاً واحداً على الأكثر — الاستعمال: [ملف] [--root <dir>]');
    process.exit(2);
  }
}

const root = rootArg ? path.resolve(rootArg) : path.join(__dirname, '..');
const files = [];
if (only) {
  const p = path.resolve(only);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) die('الملف المطلوب غير موجود: ' + p);
  files.push(p);
} else {
  const docs = path.join(root, 'docs');
  if (!fs.existsSync(docs) || !fs.statSync(docs).isDirectory()) {
    die('بنية غير صالحة: docs/ غير موجود عند ' + docs);
  }
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|assets|rebuild|\.git/.test(p)) walk(p); }
      else if (e.name.endsWith('.html')) files.push(p);
    }
  })(docs);
  if (files.length === 0) {
    die('صفر صفحة HTML في ' + docs + ' — لا شيء يُفحص، فلا يجوز إعلان النجاح.');
  }
}

let bad = 0;
for (const f of files.sort()) {
  const { problems, raw } = audit(f);
  if (problems.length) {
    bad++;
    console.log('✗ ' + path.relative(root, f) + '  (' + raw.length + ' بايت)');
    problems.forEach(x => console.log('     ' + x));
  }
}
console.log(bad === 0 ? '✓ توازن الوسوم سليم في ' + files.length + ' صفحة'
                      : '✗ ' + bad + ' صفحة فيها خلل من ' + files.length);
process.exit(bad ? 1 : 0);
