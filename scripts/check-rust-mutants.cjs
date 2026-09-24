#!/usr/bin/env node
/* **بوّابة المُفسَدات السالبة لحرّاس رست** — نظير `pnpm ext:mutants` لكن للجانب الرست.
 *
 *   node scripts/check-rust-mutants.cjs [--root <dir>] [--target <dir>] [--keep]
 *                                       [--only <رقم|اسم>] [--quiet] [--self-test] [--list]
 *
 * **العطل الذي تعالجه** (أعلنه عاملان في تقاريرهما): مُفسَدات رست كانت **موثَّقة في
 * التقارير فقط** ولا تُشغَّل آلياً — أي أن كل «مُفسَد أثبت أن الحارس يرى» في التوثيق
 * **دعوى سابقة** لا شيء يعيد إنتاجها. وحارسٌ لا يُشغَّل مُفسَدُه لا يُعرف أنه يرى.
 *
 * **المنهج** (عقد البوّابة، لا وصف):
 *   ① سجلّ صريح من ثلاثيات: `ملف` · `تحويلة نصّية مُعلَنة` · `اختبار يجب أن يسقط`.
 *      والتحويلة **حرفية ومُعلَنة** (لا AST ولا تخمين)، وتفشل بصوت عالٍ إن لم تطابق
 *      **مرة واحدة بالضبط** — فمُفسَد لم يغيّر شيئاً يعطي «نجاحاً» كاذباً (فخّ §٣).
 *   ② **التشغيل في نسخة، لا في شجرة العمل**: تُنسخ المصادر إلى مجلد مؤقّت، والتحويلة
 *      تُطبَّق هناك، ويُشغَّل **الاختبار المعنيّ وحده**، ويُشترط **سقوطه**. وشجرة العمل
 *      **لا تُمَسّ**: تُقاس بـ`git status --porcelain` قبل وبعد، والزائد عن وسخها
 *      السابق فشل.
 *   ③ **وضابط إيجابي**: كل تحويلة يقابلها تشغيل **قبل** التطبيق على النسخة النظيفة،
 *      ويُشترط نجاح الاختبار. فسقوطٌ بعد التحويلة يعني أن التحويلة هي السبب، لا أن
 *      الاختبار كان ساقطاً من أصله — وهو الفرق بين قياس ودعوى.
 *
 * **الكلفة** (مقيسة، لا مقدَّرة): كل تحويلة تُعيد تصريف الحزمة وربط ثنائي الاختبار ثم
 * تشغّل اختباراً واحداً. والزمن يُطبع لكل تحويلة وللمجموع، ويُحكم على وصلها بـCI
 * **بالرقم** لا بالرأي.
 *
 * **`--self-test`** يقيس البوّابة نفسها على بيئة مصنوعة صغيرة (بلا رست): ثقب · تحويلة
 * لا تطابق · ضابط ساقط · اسم اختبار شبح · شجرة تُمَسّ · وتحويلة حقيقية تمرّ. فتُثبت
 * **الاتجاهين**: ترى العيب، وتمرّ على السليم.
 *
 * رموز الخروج: ٠ سليم · ١ ثقب/فشل مُسمّى · ٢ صفر مدخل (لا cargo · سجلّ فارغ · تحويلة لا تطابق).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(argOf('root', path.resolve(__dirname, '..')));
const quiet = argv.includes('--quiet');
const keep = argv.includes('--keep');
const only = argOf('only', null);
/** `--sandbox <dir>` يثبّت موضع النسخة بدل مجلد مؤقّت عشوائي.
 *  **ولماذا هو لازم لا رفاهية**: قياس البوّابة على نفسها (`--self-test`) يضع
 *  «cargo» مزيّفاً يقرأ ملف الحارس **في النسخة**؛ وبمجلد عشوائي لا يعرف المزيّف
 *  موضعها إلا بمسار يُمرَّر (وقِيس أن تمريره عبر `cwd` يتضاعف وعبر وسيط سطر الأوامر
 *  يتقطّع). فالتثبيت يجعل الموضع معروفاً بنيوياً، وهو ما يجعل حالة «تحويلة تُسقط
 *  الاختبار ⇒ البوّابة تمرّ» قابلة للقياس أصلاً. */
const sandboxArg = argOf('sandbox', null);
const listOnly = argv.includes('--list');
const selfTest = argv.includes('--self-test');

/* ── سجلّ الثلاثيات: ملف · تحويلة · اختبار يجب أن يسقط ───────────────────────
 *
 * كل مدخل **ثلاثيّ صريح**، والتحويلة نصّان حرفيان، والاختبار باسمه الكامل كما
 * يطبعه cargo ويعمل مع `--lib --exact`.
 *
 * **وحدّ الاختيار معلَن**: المدخل يُقبل فقط إن كان **قابلاً للتكذيب** — أي أن هناك
 * اختباراً مسمّى يسقط حتماً على التحويلة. فلا يُدرَج هنا ما لا يُكذّبه الطقم:
 *   · تعطيل خيط تصريف `stderr` في `yt_dlp.rs` **ينجح** على الطقم — لأن اختباره لا
 *     ينفّذ العملية، فالانتظار يقع على `wait()` لا على إغلاق الأنبوب ⇒ إدراجه كان
 *     يعطي ثقباً دائماً لا حارساً.
 *   · وماسح النصوص الحرفية في تلغرام (`string_literals` · `the_literal_scanner_…`)
 *     **ليس في `main`**: قِيس أنه في شجرة أخرى (527,023 بايت مقابل 433,330 في
 *     `main`، وصفر مطابقة لـ`literal` في ملف `main`). وهذه البوّابة تقيس `main`.
 */
const MUTANTS = [
  {
    id: 'pipeline-finish-run-guard',
    file: 'src-tauri/src/pipeline.rs',
    why: 'حارس الإلغاء النهائي (`finish_run`) — قلب شرطه يجعل الإلغاء «نجاحاً» ويمنع حذف الناتج',
    from: '    if progress(1.0) {\n        return Ok(());\n    }',
    to: '    if !progress(1.0) {\n        return Ok(());\n    }',
    test: 'a_final_cancel_fails_the_run_and_removes_the_output',
    hits: 'الاختبار يشترط أن الإلغاء النهائي **يفشل** التشغيل ويحذف ما كتبه؛ والقلب يجعله ينجح ويُبقي الملف',
  },
  {
    id: 'proc-cancel-token',
    file: 'src-tauri/src/proc.rs',
    why: 'رمز الإلغاء نفسه: «لا إلغاء أبداً» — وهو العطل الأصلي في م١ (رمز يُضبط ولا يراه القارئ)',
    from: '    pub fn is_cancelled(&self) -> bool {\n        self.0.load(Ordering::SeqCst)\n    }',
    to: '    pub fn is_cancelled(&self) -> bool {\n        let _ = self.0.load(Ordering::SeqCst);\n        false\n    }',
    test: 'cloned_tokens_share_one_flag',
    hits: 'الاختبار يضبط الرمز ثم يشترط أن النسخ تراه؛ ومع `false` دائماً يسقط على أول تأكيد',
  },
  {
    id: 'separator-inference-threads',
    file: 'src-tauri/src/separator.rs',
    why: 'حارس تجويع الواجهة: عتبة هامش الأنوية — قلبها يجعل كل ما فوق أربع أنوية يأخذ الرقم الخطأ',
    from: '    if total <= 4 {\n        total.max(1)\n    } else {\n        total - 2\n    }',
    to: '    if total > 4 {\n        total.max(1)\n    } else {\n        total - 2\n    }',
    test: 'inference_threads_leaves_air',
    hits: 'الاختبار يثبّت ٢٠⇒١٨ و٨⇒٦ و٤⇒٤؛ والقلب يعطي ٢٠⇒٢٠ و٨⇒٨ ويسقط على أول تأكيد',
  },
];

/* `HL_RUST_MUTANTS_SPEC` — ملف JSON بالثلاثيات نفسها، يُستعمل في **قياس البوّابة على
 * نفسها** (`--self-test`) فلا تُشغَّل تحويلات رست الحقيقية هناك. وهو **لذلك وحده**:
 * ليس مخرجاً لتخطّي سجلّ البوّابة في CI (ولا يُضبط في `ci.yml`). */
if (process.env.HL_RUST_MUTANTS_SPEC) {
  const p = path.resolve(process.env.HL_RUST_MUTANTS_SPEC);
  try {
    const spec = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(spec) || spec.length === 0) throw new Error('الجرد ليس مصفوفة غير فارغة');
    for (const m of spec) {
      for (const k of ['file', 'from', 'to', 'test']) {
        if (typeof m[k] !== 'string' || !m[k]) throw new Error('حقل «' + k + '» مفقود في مدخل الجرد');
      }
    }
    MUTANTS.length = 0;
    MUTANTS.push(...spec);
  } catch (e) {
    console.error('✗ صفر مدخل: جرد المُفسَدات في HL_RUST_MUTANTS_SPEC غير مقروء (' + e.message + ')');
    process.exit(2);
  }
}

if (listOnly) {
  for (const m of MUTANTS) console.log(`${m.id}\n  ${m.file}\n  الاختبار: ${m.test}\n  ${m.why}`);
  process.exit(0);
}

/* ── cargo ───────────────────────────────────────────────────────────────── */
const cargo = (() => {
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8', windowsHide: true, shell: true });
  if (process.env.HL_DEBUG_CARGO) {
    console.log('[cargo probe] status=' + probe.status + ' err=' + (probe.error && probe.error.message) +
      '\n  out=' + JSON.stringify((probe.stdout || '') + (probe.stderr || '')) +
      '\n  PATH=' + String(process.env.PATH || '').slice(0, 260));
  }
  if (!probe.error && probe.status === 0) return 'cargo';
  const home = process.env.USERPROFILE;
  const p = home ? path.join(home, '.cargo', 'bin', 'cargo.exe') : null;
  return p && fs.existsSync(p) ? p : null;
})();

function gitStatus() {
  const r = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return (r.stdout || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => l.trim()).sort();
}

/* ── البيئة المؤقّتة: نسخة من المصادر، لا شجرة العمل ──────────────────────── */
const TMP_BASE = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir();
const COPY_TOP = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'hooks.nsh', 'test-comctl32.manifest'];
const COPY_DIRS = ['src', '.cargo', 'capabilities', 'icons'];
/** **موارد تُقرأ وقت التصريف** — وكلٌّ منها قِيس بفشل تصريف فعلي حين غاب:
 *   · `licenses/` — يتحقّق منها `tauri_build` من `bundle.resources`
 *     (`resource path ..\licenses doesn't exist`).
 *   · `IMG/` — `telegram.rs:162` يقرأ `include_bytes!("../../IMG/…")`
 *     (`could not compile … due to 1 previous error`).
 *  وكلاهما صغير. **والدرس**: «نسخة المصادر» تعني كل ما يقرؤه التصريف، لا `src/` وحدها. */
const COPY_RESOURCE_DIRS = ['licenses', 'IMG'];

function linkOrCopy(srcAbs, dstAbs) {
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  try { fs.linkSync(srcAbs, dstAbs); }
  catch { fs.copyFileSync(srcAbs, dstAbs); }
}

/** **نسخ لا وصل — للمصادر وحدها**. وهذا شرط صحّة لا تحسين: وصلة صلبة تعني **الملف
 *  نفسه**، فالكتابة في النسخة تكتب في شجرة العمل — وهو بالحرف ما تمنعه هذه البوّابة.
 *  وقد وقع قياسه: أول صورة استعملت الوصل في المصادر فكتبت التحويلة في
 *  `src-tauri/src/guard.rs` **في شجرة العمل**، فأسقط الحارس نفسه بحكم «شجرة العمل
 *  تغيّرت» — أي أنه أمسك عيباً في ذاته. والمصادر ~4 م.ب فنسخها لا يُقاس. */
function copyFileInto(srcAbs, dstAbs) {
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.copyFileSync(srcAbs, dstAbs);
}

function mirrorSrcDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) mirrorSrcDir(a, b);
    else if (e.isFile()) copyFileInto(a, b);
  }
}

/** نسخة من هدف التصريف (hardlink): لا تُحرَّر أبداً، فالوصل مأمون ونسخ البايتات كلفته
 *  عشرات الجيجابايت. */
function mirrorTargetDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) mirrorTargetDir(a, b);
    else if (e.isFile()) linkOrCopy(a, b);
  }
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else if (e.isFile()) n++;
  }
  return n;
}

/** هدف التصريف: **المجلدات التي يعيد cargo استعمالها فقط**.
 *
 *  ولا يُنسخ `target/` كاملاً: قِيس **47,516 م.ب** في `debug/` وحده (منها `deps`
 *  **24,591 م.ب**) — ونسخُ شجرة بهذا الحجم لكل تحويلة يكلّف أكثر من التصريف الذي
 *  يُوفّره. فيُوصل `deps` (الـrlibs وثنائي الاختبار) و`.fingerprint` (بصمات الطزاجة)
 *  و`build` (مخرجات سكربتات البناء) — وهي ما يقرؤه cargo ليقرّر ألّا يعيد التصريف.
 *  وأي نقص لا يُفسد قياساً: cargo يعيد بناء ما يلزمه، والزمن يُقاس ويُطبع. */
const TARGET_SUBDIRS = ['debug/deps', 'debug/.fingerprint', 'debug/build'];
function seedTarget(targetDir, dstTarget) {
  let files = 0;
  for (const s of TARGET_SUBDIRS) {
    const a = path.join(targetDir, s);
    if (!fs.existsSync(a)) continue;
    files += countFiles(a);
    mirrorTargetDir(a, path.join(dstTarget, s));
  }
  const lock = path.join(targetDir, 'debug', '.cargo-lock');
  if (fs.existsSync(lock)) {
    fs.mkdirSync(path.join(dstTarget, 'debug'), { recursive: true });
    fs.copyFileSync(lock, path.join(dstTarget, 'debug', '.cargo-lock'));
  }
  return files;
}

function buildSandbox(dst, targetDir) {
  const st = path.join(ROOT, 'src-tauri');
  for (const f of COPY_TOP) {
    const a = path.join(st, f);
    if (fs.existsSync(a)) copyFileInto(a, path.join(dst, 'src-tauri', f));
  }
  for (const d of COPY_DIRS) {
    const a = path.join(st, d);
    if (fs.existsSync(a)) mirrorSrcDir(a, path.join(dst, 'src-tauri', d));
  }
  /* موارد الحزمة: `tauri_build` في `build.rs` يتحقّق من مسارات `bundle.resources`
     **قبل** التصريف ويفشل إن غابت (`resource path ..\bin doesn't exist`). وهي
     متجاهَلة في git ⇒ تُوصل من شجرة العمل، وإن غابت تُصنع stubs (وهو ما يفعله CI
     بالحرف). و`models/` لا تُنسخ (‏63MB): اختبارات المحرّك تتخطّى نفسها صامتة
     بغيابها، وهذا **مقبول ومُعلَن** لأن تحويلات هذه البوّابة لا تلمس المحرّك. */
  for (const d of COPY_RESOURCE_DIRS) {
    const src = path.join(ROOT, d);
    if (fs.existsSync(src)) mirrorSrcDir(src, path.join(dst, d));
  }
  for (const d of ['bin', 'models']) {
    const src = path.join(ROOT, d);
    const out = path.join(dst, d);
    fs.mkdirSync(out, { recursive: true });
    const entries = fs.existsSync(src) ? fs.readdirSync(src).filter((n) => n !== '.stub') : [];
    let linked = 0;
    for (const n of entries) {
      const a = path.join(src, n);
      if (fs.statSync(a).isFile()) { linkOrCopy(a, path.join(out, n)); linked++; }
    }
    if (!linked) fs.writeFileSync(path.join(out, '.stub'), '');
  }
  const red = path.join(dst, 'src-tauri', 'vc_redist.x64.exe');
  const redSrc = path.join(st, 'vc_redist.x64.exe');
  if (fs.existsSync(redSrc)) linkOrCopy(redSrc, red);
  else fs.writeFileSync(red, '');
  /* هدف التصريف: يُوصل من شجرة العمل فيُعيد cargo استعمال ما بُني فعلاً (توفير
     دقائق)، وإن لم يوجد يُبنى من الصفر داخل البيئة. */
  if (targetDir) seedTarget(targetDir, path.join(dst, 'src-tauri', 'target'));
}

/** تطبيق تحويلة نصّية: تفشل بصوت عالٍ إن لم تطابق **مرة واحدة**. */
function applyMutation(absFile, from, to) {
  const before = fs.readFileSync(absFile, 'utf8');
  const n = before.split(from).length - 1;
  if (n !== 1) {
    const e = new Error(`التحويلة لم تطابق مرة واحدة في ${path.basename(absFile)} (طابق ${n})`);
    e.code = 'NOMATCH';
    throw e;
  }
  fs.writeFileSync(absFile, before.replace(from, to));
}

/** تشغيل اختبار واحد وحده في البيئة. */
function runOneTest(sandbox, testName, timeoutMs) {
  /* **بلا `--exact`**: مرشِّح cargo يقابل **المسار الكامل** (`tests::اسم`) لا الاسم
     وحده، فـ`--exact` بـ`اسم` **لا يطابق شيئاً** ويطبع `398 filtered out` مع exit=0 —
     أي «نجاح» على اختبار لم يُنفَّذ. وقد قِيس بالحرف. والتحقّق من أن الاختبار **جرى**
     يقع بعده على سطر نتيجته باسمه (`ran`)، فلا يُقبل ترشيحٌ مطابقٌ لغير المقصود. */
  const line = [cargo, 'test', '--lib', '--manifest-path',
    path.join(sandbox, 'src-tauri', 'Cargo.toml'), testName]
    .map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  const t0 = Date.now();
  const r = spawnSync(line, [], {
    encoding: 'utf8', windowsHide: true, shell: true,
    maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs || 30 * 60e3,
    cwd: path.join(sandbox, 'src-tauri'),
    /* **موضع النسخة يُعلَن للأداة المُشغَّلة** (‏`HL_SANDBOX_DIR`): به يعرف «cargo»
       المزيّف في قياس البوّابة على نفسها **أيّ** نسخة يُحكم عليها. وهذا هو الشرط
       المقيس: أداة تحكم على الأصل لا على النسخة تُنتج «اصطياداً» كاذباً. */
    env: { ...process.env, HL_SANDBOX_DIR: sandbox },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/test result:\s*\w+\.\s*(\d+) passed;\s*(\d+) failed;\s*(\d+) ignored/);
  const esc = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    ms: Date.now() - t0,
    status: r.status,
    passed: m ? Number(m[1]) : null,
    failed: m ? Number(m[2]) : null,
    ignored: m ? Number(m[3]) : null,
    /* «الاختبار جرى فعلاً»: سطر نتيجته باسمه — وإلا فالترشيح لم يطابق شيئاً،
       وسقوطٌ بلا تنفيذ ليس اصطياداً (ولا نجاحاً).
       **وcargo يطبع المسار الكامل** (`test tests::cloned_tokens_share_one_flag ... ok`)
       والاسم هنا بلا `tests::` — فالمطابقة تسمح بمسار قبله. وقد قِيس الخطأ مرّتين:
       بلا هذا السماح كان اختبار **جرى فعلاً ونجح** (`1 passed … 397 filtered out`)
       يُقرأ «لم يُنفَّذ» ⇒ ضابط ساقط كاذب في كل تحويلة. */
    ran: new RegExp('^test\\s+(?:[A-Za-z0-9_:]*::)?' + esc + '\\s+\\.\\.\\.', 'm').test(out),
    compileError: /^error(\[|:)/m.test(out) || /error: could not compile/m.test(out),
    out,
  };
}

function tail(s, n) {
  const lines = String(s || '').trim().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/* ═══ التشغيل ═══════════════════════════════════════════════════════════════ */
function main() {
  const t0 = Date.now();
  if (!cargo) { console.error('✗ صفر مدخل: cargo غير موجود (لا على PATH ولا في %USERPROFILE%\\.cargo\\bin)'); process.exit(2); }
  if (MUTANTS.length === 0) { console.error('✗ صفر مدخل: سجلّ المُفسَدات فارغ — لا شيء يُقاس'); process.exit(2); }

  const before = gitStatus();
  if (before === null) {
    console.error('✗ صفر مدخل: جذر القياس ليس مستودع git (' + ROOT + ') — ولا سبيل لإثبات أن شجرة العمل لم تُمَسّ');
    process.exit(2);
  }

  const targetArg = argOf('target', path.join(ROOT, 'src-tauri', 'target'));
  const targetDir = targetArg && fs.existsSync(targetArg) ? targetArg : null;

  const WORK = sandboxArg ? path.resolve(sandboxArg) : fs.mkdtempSync(path.join(TMP_BASE, 'hl-rust-mutants-'));
  if (sandboxArg) { fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true }); }
  const sandbox = path.join(WORK, 'tree');
  console.log('بوّابة المُفسَدات السلبية لرست — ' + MUTANTS.length + ' تحويلة');
  console.log('البيئة المؤقّتة: ' + sandbox);
  console.log('هدف التصريف المُوصل: ' + (targetDir || '(بلا — بناء من الصفر)'));

  const tCopy = Date.now();
  buildSandbox(sandbox, targetDir);
  const copyMs = Date.now() - tCopy;
  console.log('نسخ البيئة: ' + (copyMs / 1000).toFixed(1) + ' ث\n');

  const results = [];
  let holes = 0, errors = 0;

  for (const [i, mu] of MUTANTS.entries()) {
    if (only && only !== String(i + 1) && only !== mu.id) continue;

    const abs = path.join(sandbox, mu.file);
    const rec = { id: mu.id, test: mu.test, hole: false, err: null };
    console.log(`[${i + 1}/${MUTANTS.length}] ${mu.id}`);
    console.log('  الملف: ' + mu.file);
    console.log('  الاختبار: ' + mu.test);

    /* ③ الضابط: النسخة النظيفة يجب أن **تنجح** — وإلا فسقوطٌ لاحق لا يُنسب للتحويلة. */
    const control = runOneTest(sandbox, mu.test);
    rec.controlMs = control.ms;
    if (!control.ran) {
      console.log('  ✗ ضابط: الاختبار لم يُنفَّذ إطلاقاً (الاسم لا يطابق شيئاً) — ' + (control.ms / 1000).toFixed(1) + ' ث');
      console.log('     ' + tail(control.out, 4).replace(/\n/g, '\n     '));
      rec.err = 'الاختبار «' + mu.test + '» لم يُنفَّذ في البيئة النظيفة';
      errors++; results.push(rec); continue;
    }
    if (control.status !== 0 || control.failed) {
      console.log('  ✗ ضابط: الاختبار **ساقط في البيئة النظيفة** (' + control.passed + ' ناجح · ' + control.failed + ' فاشل) — لا يُنسب سقوطٌ بعده للتحويلة');
      console.log('     ' + tail(control.out, 6).replace(/\n/g, '\n     '));
      rec.err = 'الاختبار ساقط أصلاً في البيئة النظيفة';
      errors++; results.push(rec); continue;
    }
    console.log('  ضابط: نجح (' + (control.ms / 1000).toFixed(1) + ' ث)');

    /* ① التحويلة تُطبَّق في **النسخة**. */
    try { applyMutation(abs, mu.from, mu.to); }
    catch (e) {
      console.log('  ✗ صفر مدخل: ' + e.message);
      rec.err = e.message; errors++; results.push(rec);
      /* **صفر مدخل ⇒ رمز 2** لا 1: «لا شيء قيس» ليس «ثقباً» ولا «عطلاً»، والتمييز
         يهمّ من يقرأ المخرَج آلياً (وهو نفسه التمييز المعلَن في ترويسة البوّابة). */
      rec.noInput = true;
      continue;
    }

    /* ② الاختبار المعنيّ وحده يجب أن **يسقط**. */
    const after = runOneTest(sandbox, mu.test);
    rec.mutantMs = after.ms;
    if (!after.ran) {
      console.log('  ⚠ بعد التحويلة: الاختبار لم يُنفَّذ — يُحسب ثقباً لا اصطياداً (' + (after.ms / 1000).toFixed(1) + ' ث)');
      rec.hole = true; holes++;
    } else if (after.status === 0 && !after.failed) {
      console.log('  ✗ **ثقب**: التحويلة طُبِّقت والاختبار مرّ (' + after.passed + ' ناجح) — الحارس لا يرى هذا العيب');
      console.log('     ' + mu.hits);
      rec.hole = true; holes++;
    } else if (after.compileError && !/assertion|panicked|test result/.test(after.out)) {
      console.log('  ✗ سقط بالتصريف لا بالاختبار — التحويلة غير صالحة كتحويلة سلوكية');
      console.log('     ' + tail(after.out, 6).replace(/\n/g, '\n     '));
      rec.err = 'سقط بالتصريف'; errors++; results.push(rec); continue;
    } else {
      const line = (after.out.match(/^test\s+\S+\s+\.\.\.\s+FAILED.*$/m) || [''])[0];
      console.log('  ✓ سقط كما يجب (' + (after.ms / 1000).toFixed(1) + ' ث) ' + (line ? '· ' + line.trim() : ''));
      rec.ok = true;
    }
    rec.mutationMs = rec.controlMs + (rec.mutantMs || 0);
    results.push(rec);
  }

  /* ── سلامة شجرة العمل: لا وسخ جديد ───────────────────────────────────────── */
  /* **خطّافان اختباريان مُعلَنان** (لا يُضبطان في `ci.yml`): `HL_PAUSE_BEFORE_STATUS_MS`
     مهلة محدودة، و`HL_TOUCH_BEFORE_STATUS` ملفٌ يُكتب أثناءها. وبهما يُقاس **الاتجاه
     الآخر** لفحص الركود: أن البوّابة **تسقط** حين تُمَسّ الشجرة فعلاً، لا أنه فحصٌ لا
     ينظر. وقِيس أن اللجوء إلى سباق توقيت (مُشغِّل خارجي يكتب بعد ٢.٥ ث) **لا يصلح**:
     القياس يسبقه فيمرّ الفحص لأن الشجرة كانت نظيفة. */
  const pauseMs = Number(process.env.HL_PAUSE_BEFORE_STATUS_MS || 0);
  if (pauseMs > 0) {
    const until = Date.now() + pauseMs;
    while (Date.now() < until) { /* انتظار مقصود ومحدود */ }
  }
  const touch = process.env.HL_TOUCH_BEFORE_STATUS;
  if (touch) { try { fs.writeFileSync(touch, 'x'); } catch { /* يُترك للفحص */ } }
  const after = gitStatus();
  const newDirt = after === null ? ['(تعذّر قراءة git status)']
    : after.filter((l) => !before.includes(l));
  const treeClean = newDirt.length === 0;

  const totalMs = Date.now() - t0;
  const measured = results.filter((r) => r.mutationMs);
  const perMutant = measured.length ? measured.reduce((a, r) => a + r.mutationMs, 0) / measured.length : 0;
  console.log('\n── الحصيلة ──');
  console.log('  تحويلات: ' + results.length + ' · اصطياد: ' + results.filter((r) => r.ok).length +
    ' · ثقوب: ' + holes + ' · أخطاء: ' + errors);
  console.log('  الزمن: نسخ ' + (copyMs / 1000).toFixed(1) + ' ث · تحويلة ' +
    (perMutant / 1000).toFixed(1) + ' ث وسطياً · المجموع ' + (totalMs / 1000).toFixed(1) + ' ث');
  console.log('  شجرة العمل: ' + (treeClean ? 'لم تُمَسّ (لا وسخ جديد في git status)' : 'تغيّرت! ' + newDirt.length + ' سطراً جديداً'));
  if (!quiet) {
    console.log('\n  التفصيل (ث):');
    for (const r of results) {
      console.log('   · ' + r.id.padEnd(34) + ' ضابط ' + ((r.controlMs || 0) / 1000).toFixed(1) +
        ' · مُفسَد ' + ((r.mutantMs || 0) / 1000).toFixed(1) + '  ' +
        (r.hole ? 'ثقب' : r.err ? 'خطأ: ' + r.err : 'اصطياد'));
    }
  }

  if (!keep) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* gone */ } }
  else console.log('  (البيئة مُبقاة: ' + WORK + ')');

  if (!treeClean) {
    console.error('✗ شجرة العمل تغيّرت أثناء القياس — البوّابة تعمل في نسخة ولا تمسّها. الفرق:');
    for (const l of newDirt) console.error('   ' + l);
    process.exit(1);
  }
  if (errors) {
    const noInput = results.some((r) => r.noInput);
    console.error('✗ ' + errors + ' خطأ قياس (ضابط ساقط أو تحويلة لا تطابق) — لا يُقرأ هذا نجاحاً.');
    process.exit(noInput ? 2 : 1);
  }
  if (holes) { console.error('✗ ' + holes + ' ثقباً مؤكَّداً: تحويلة طُبِّقت وحارسها لم يسقط.'); process.exit(1); }
  if (results.length === 0) { console.error('✗ صفر مدخل: لم تُقَس تحويلة واحدة.'); process.exit(2); }
  console.log('✓ كل تحويلة أسقطت اختبارها المعنيّ · وكل ضابط مرّ · وشجرة العمل لم تُمَسّ.');
  process.exit(0);
}

/* ═══ --self-test: قياس البوّابة نفسها على بيئة مصنوعة (بلا رست) ═══════════ */
function selfTestRun() {
  /* البيئة المصنوعة: مستودع git صغير فيه «حزمة رست» مصنوعة، و«cargo» مزيّف يقرأ
     ملفاً نصّياً ويسقط/ينجح بحسب محتواه — فيُقاس **منطق البوّابة** في أجزاء الثانية:
     هل تُسقط نفسها على ثقب؟ هل ترى تحويلة لا تطابق؟ هل ترى ضابطاً ساقطاً؟ وهل تمرّ
     على تحويلة حقيقية؟ (كلها على نسخ منفصلة، فلا يزحم قرارُ حالةٍ غيرَها.) */
  const SELF = fs.mkdtempSync(path.join(TMP_BASE, 'hl-rust-mutants-self-'));
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  const mkIn = (root, rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const results = [];
  const record = (label, ok, detail, out) => { results.push({ label, ok, detail, out }); };

  /* **مزيّف cargo في Node لا في batch**: أول صورة كتبته `cargo.cmd` بـ`findstr`
     داخل `if (...)`، فابتلعت الأقواس الحرفَ `!` (توسيع متأخّر) ولم يرَ التحويلة —
     فمرّت حالة «تحويلة حقيقية» **ثقباً**. والقاعدة المسجَّلة في المستودع: لا نصّ
     معقّد في صدفة ويندوز. فالآن: `cargo.cmd` سطران ينادِيان `probe.cjs` والمنطق في
     Node، **وملف الحكم يجده المسبار بنفسه** من `__dirname` (`fakebin\..\src-tauri\…`):
     لا مسار يُمرَّر ولا `cwd` يُعتمد عليه — وقد قِيس أنّ الاعتماد على أيهما يُفسد
     القياس (مسار مطلق ⇐ «مفقود» دائماً، و`cwd` ⇐ مسار متضاعف، ووسيط سطر الأوامر ⇐
     تقطيع عند فراغات مسار المستودع). */
  const FAKE_PROBE_CJS =
    "const fs=require('fs');\n" +
    "if(process.argv.includes('--version')){console.log('cargo 1.95.0-probe');process.exit(0);}\n" +
    "const p=require('path').resolve(String(process.env.HL_SANDBOX_DIR||''),'src-tauri','src','guard.rs');\n" +
    "if(!p||!fs.existsSync(p)){console.error('probe: مفقود '+p);process.exit(2);}\n" +
    "const s=fs.readFileSync(p,'utf8');\n" +
    "if(s.includes('assert!(false')){\n" +
    "  console.log('test probe::guard ... FAILED');\n" +
    "  console.log('test result: FAILED. 0 passed; 1 failed; 0 ignored');\n" +
    "  process.exit(101);\n" +
    "}\n" +
    "console.log('test probe::guard ... ok');\n" +
    "console.log('test result: ok. 1 passed; 0 failed; 0 ignored');\n" +
    "process.exit(0);\n";
  /* سطران بلا منطق: لا `!` ولا `(` تخضع لتوسيع الصدفة — **ولا مسار مطلق**:
     `process.execPath` قد يكون في `C:\Program Files\nodejs\` وفيه فراغ، فتُكتب `node`
     وحدها (وهي على PATH حيث يعمل هذا السكربت أصلاً). وقد سقط الاختبار كلّه بسبب ذلك:
     كل الحالات أعلنت «cargo غير موجود» لأن الصدفة لم تجد المزيّف. */
  const FAKE_CARGO =
    '@echo off\r\n' +
    'node "%~dp0probe.cjs" %*\r\n' +
    'exit /b %ERRORLEVEL%\r\n';

  function fixture(name, guardBody, specEntry) {
    const root = path.join(SELF, name);
    mkIn(root, 'src-tauri/Cargo.toml', '[package]\nname = "probe"\nversion = "0.0.0"\n');
    mkIn(root, 'src-tauri/src/lib.rs', 'pub fn x() {}\n');
    mkIn(root, 'src-tauri/src/guard.rs', guardBody);
    mkIn(root, 'bin/.stub', '');
    mkIn(root, 'models/.stub', '');
    mkIn(root, 'fakebin/cargo.cmd', FAKE_CARGO);
    mkIn(root, 'fakebin/probe.cjs', FAKE_PROBE_CJS);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'self@local']);
    git(root, ['config', 'user.name', 'self']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'init']);
    const spec = path.join(root, 'spec.json');
    fs.writeFileSync(spec, JSON.stringify([specEntry]));
    /* **حدّان مقيسان في هذا السطر الواحد**:
       · أوّل صورة حسبت مساراً مطلقاً `root/tree/...` — وهو **موضع النسخة** لا موضع
         البيئة، فكان المزيّف يعلن «مفقود» دائماً.
       · والثانية حسبت `root/src-tauri/...` (البيئة السليمة) — فصار المزيّف يقرأ
         **الأصل لا النسخة**، فمرّت «تحويلة حقيقية» **ثقباً كاذباً**.
       فالمسار الآن **نسبيّ** ويُحلّ من `cwd` الذي تضبطه البوّابة على `<النسخة>/src-tauri` (و`cwd` هي، فالمسار نسبيّ منها)
       — أي أن المسبار يقيس الملف الذي قِيس فعلاً، وهو الشرط كله. */
    return { root, spec, probe: path.join('tree', 'src-tauri', 'src', 'guard.rs') };
  }
  const GUARD_OK = 'pub fn guard() { assert!(true, "حارس مصنوع"); }\n';
  const GUARD_BAD = 'pub fn guard() { assert!(false, "ساقط من أصله"); }\n';
  const fakeEnv = (root) => ({
    PATH: path.join(root, 'fakebin') + path.delimiter + process.env.PATH,
    USERPROFILE: path.join(root, 'nohome'),
  });
  const gateEnv = (f) => ({ ...process.env, ...fakeEnv(f.root), HL_RUST_MUTANTS_SPEC: f.spec });
  /** تشغيل البوّابة على بيئة مصنوعة، ونسختها في موضع **معلوم** (`<SELF>/sb-<اسم>`).
   *  والموضع **خارج مستودع البيئة** عمداً: وسخُ النسخة داخل المستودع يُسقط فحص
   *  «شجرة العمل لم تُمَسّ» (قِيس: `?? sb/`). */
  const sbDir = (name) => path.join(SELF, 'sb-' + name);
  const runGate = (f, name) => {
    const r = spawnSync(process.execPath,
      [__filename, '--root', f.root, '--quiet', '--sandbox', sbDir(name || 'default')], {
        encoding: 'utf8', windowsHide: true, env: gateEnv(f),
      });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };

  try {
    /* ① الثقب: تحويلة تُطبَّق والاختبار **يمرّ** ⇒ البوّابة تسقط وتسمّي الثقب. */
    {
      const f = fixture('hole', GUARD_OK, {
        id: 'no-op', file: 'src-tauri/src/guard.rs', why: 'تحويلة لا تُغيّر السلوك',
        from: 'assert!(true', to: 'assert!(true', test: 'probe::guard', hits: 'لا شيء',
      });
      const res = runGate(f, 'hole');
      record('ثقب: تحويلة لا تُسقط الاختبار ⇒ البوّابة تسقط وتسمّي الثقب',
        res.status === 1 && /ثقب/.test(res.out), 'exit=' + res.status, res.out);
    }

    /* ② تحويلة لا تطابق النصّ ⇒ صفر مدخل لا نجاح فارغ. */
    {
      const f = fixture('nomatch', GUARD_OK, {
        id: 'wrong-text', file: 'src-tauri/src/guard.rs', why: 'نصّ لا وجود له',
        from: 'assert!(MISSING', to: 'assert!(false', test: 'probe::guard', hits: 'x',
      });
      const res = runGate(f, 'nomatch');
      record('تحويلة لا تطابق النصّ ⇒ صفر مدخل مسمّى (لا «نجاح» كاذب)',
        res.status === 2 && /صفر مدخل/.test(res.out), 'exit=' + res.status, res.out);
    }

    /* ③ الضابط الساقط: الاختبار ساقط في البيئة **النظيفة** ⇒ خطأ قياس لا اصطياد. */
    {
      const f = fixture('control-fails', GUARD_BAD, {
        id: 'fine', file: 'src-tauri/src/guard.rs', why: 'تحويلة على اختبار ساقط أصلاً',
        from: 'assert!(false', to: 'assert!(false', test: 'probe::guard', hits: 'x',
      });
      const res = runGate(f, 'ctrl');
      record('ضابط ساقط في البيئة النظيفة ⇒ خطأ قياس مسمّى (لا يُنسب للتحويلة)',
        res.status === 1 && /ضابط/.test(res.out), 'exit=' + res.status, res.out);
    }

    /* ④ الاتجاه الآخر: تحويلة **تُسقط** الاختبار ⇒ البوّابة تمرّ. */
    {
      const f = fixture('ok', GUARD_OK, {
        id: 'real', file: 'src-tauri/src/guard.rs', why: 'تحويلة حقيقية',
        from: 'assert!(true', to: 'assert!(false', test: 'probe::guard', hits: 'x',
      });
      const res = runGate(f, 'ok');
      record('الاتجاه الآخر: تحويلة تُسقط الاختبار ⇒ البوّابة تمرّ (exit 0)',
        res.status === 0 && /كل تحويلة أسقطت/.test(res.out), 'exit=' + res.status, res.out);
    }

    /* ⑤ اسم اختبار لا وجود له ⇒ ليس اصطياداً: «لم يُنفَّذ» خطأ مسمّى. */
    {
      const f = fixture('ghost-test', GUARD_OK, {
        id: 'ghost', file: 'src-tauri/src/guard.rs', why: 'اسم اختبار لا وجود له',
        from: 'assert!(true', to: 'assert!(false', test: 'probe::no_such_test', hits: 'x',
      });
      const res = runGate(f, 'ghost');
      record('اسم اختبار لا وجود له ⇒ «لم يُنفَّذ» لا اصطياد (وإلا كُسب اصطياد كاذب)',
        res.status === 1 && /لم يُنفَّذ/.test(res.out), 'exit=' + res.status, res.out);
    }

    /* ⑥ شجرة العمل تُمَسّ ⇒ البوّابة تسقط (النسخ لا يكفي إن عُدِّل الأصل). والوسخ
       يُحدث **بعد** قراءة البوّابة للحالة الأولى وقبل حكمها — وهذا ما يجب أن تراه. */
    {
      const f = fixture('tree-dirty', GUARD_OK, {
        id: 'real', file: 'src-tauri/src/guard.rs', why: 'تحويلة حقيقية + وسخ في الشجرة',
        from: 'assert!(true', to: 'assert!(false', test: 'probe::guard', hits: 'x',
      });
      const dirtyAt = path.join(f.root, 'untracked-after.txt');
      /* **كيف يُقاس هذا؟** لا بسباق توقيت: قِيس أن مُشغِّلاً خارجياً يكتب بعد ٢.٥ ث
         **يسبقه** القياس فيمرّ الفحص (ويكون «لم تُمَسّ» صدقاً لا نظراً). فالبوّابة
         نفسها تكتب الملف في الخطّاف المُعلَن، **بين** قراءة الحالة الأولى والحكم. */
      const res = spawnSync(process.execPath,
        [__filename, '--root', f.root, '--quiet', '--sandbox', sbDir('dirty')], {
          encoding: 'utf8', windowsHide: true,
          env: { ...gateEnv(f), HL_TOUCH_BEFORE_STATUS: dirtyAt },
        });
      const out = (res.stdout || '') + (res.stderr || '');
      fs.rmSync(dirtyAt, { force: true });
      record('شجرة العمل تُمَسّ أثناء القياس ⇒ البوّابة تسقط (لا تصمت)',
        res.status === 1 && /شجرة العمل/.test(out), 'exit=' + res.status, out);
    }
  } finally {
    if (!keep) { try { fs.rmSync(SELF, { recursive: true, force: true }); } catch { /* gone */ } }
  }

  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + ' — ' + r.detail);
    if (!r.ok && r.out) console.log('      ┌ ' + String(r.out).trim().split(/\r?\n/).join('\n      │ '));
  }
  console.log('\nالحصيلة: ' + (results.length - bad.length) + '/' + results.length + ' حالة');
  if (bad.length) { console.error('✗ البوّابة لا ترى عيوب نفسها (' + bad.length + ')'); process.exit(1); }
  console.log('✓ البوّابة ترى الثقب · والتحويلة الباطلة · والضابط الساقط · والاختبار الشبح · وشجرة موسخة · وتمرّ على التحويلة الحقيقية.');
  process.exit(0);
}

if (selfTest) selfTestRun();
else main();
