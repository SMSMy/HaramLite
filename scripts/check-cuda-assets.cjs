/* حارس أصول CUDA — يمنع نشر DLL ناقصاً، ويمنع عودة استثناء الاسم الواحد.

   **العيب المقيس** (`.github/workflows/cuda-assets.yml`، المراجعة الأمنية
   لـ0.2.7): حارس الحجم في خطوة تجميع مزوّدي ORT كان
       if ($src.Length -lt 10KB -and $dll -ne 'onnxruntime_providers_shared.dll') { throw … }
   أي أنه **يستثني ملفاً بالاسم** من الفحص الوحيد الموجود — فبقي
   `onnxruntime_providers_shared.dll` (وهو إلزامي: `CUDA_FILES` يشترطه، والتطبيق
   يرفض منفستاً ينقصه اسم) بلا أي فحص: دمية 0 بايت أو تنزيل منقطع يمرّ.

   **وما يفعله هذا الحارس**، ثلاثة أجزاء:

     ① **دrift بين القائمتين**: `CUDA_FILES` في `cuda_runtime.rs` مقابل
        `$EXPECTED` في السير. السير بلا checkout فالقائمة مكرّرة فيه **عمداً**؛
        والتكرار بلا حارس يصير افتراقاً صامتاً يُنتج منفستاً يرفضه كل تطبيق
        مثبَّت («ينقص المنفست: …»). هذا الجزء يقيس التكرار ويلزمه.
     ② **القاعدة الواحدة بلا استثناء**: نصّ الحارس في السير يجب أن يخلو من أي
        استثناء حجم بالاسم، وأن يحمل وسمي `CUDA_ASSET_GUARD` (فالنصّ المقيس هو
        النصّ المشحون، لا نسخة ثانية هنا).
     ③ **الحارس نفسه يُقاس بمُفسَداته**: يُستخرج نصّ الدالة **من ملف السير
        حرفياً** ويُشغَّل في pwsh على عيّنات مصنوعة: PE كامل يمرّ، ومبتور يسقط،
        ودمية 0 بايت تسقط، ومجلد فارغ **يفشل** (حارس لم يرَ شيئاً لا يُثبت
        شيئاً). لو صارت القاعدة لا تمسك المبتور، سقط هذا الحارس نفسه.

   الاستعمال: node scripts/check-cuda-assets.cjs [--root <dir>] */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BEGIN = '# >>> CUDA_ASSET_GUARD:BEGIN';
const END = '# <<< CUDA_ASSET_GUARD:END';

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

/** PE صغير **كامل** (رؤوس متّسقة وطول يطابق ما تعلنه): عيّنة ضابط لا تعتمد
 *  على ملفات النظام، فيعمل الحارس على مستودع نظيف. الحارس يقيس الاكتمال لا
 *  صلاحية التحميل، فلا كود في الأقسام. */
function minimalPe(rawSize = 0x200) {
  const peOff = 0x80;
  const optSize = 0xf0;
  const opt = peOff + 24;
  const sec = opt + optSize;
  const total = 0x400;
  const b = Buffer.alloc(total, 0);
  b.write('MZ', 0, 'ascii');
  b.writeUInt32LE(peOff, 0x3c);
  b.write('PE\0\0', peOff, 'binary');
  b.writeUInt16LE(0x8664, peOff + 4); // Machine = AMD64
  b.writeUInt16LE(1, peOff + 6); // NumberOfSections
  b.writeUInt16LE(optSize, peOff + 20); // SizeOfOptionalHeader
  b.writeUInt16LE(0x2022, peOff + 22); // Characteristics
  b.writeUInt16LE(0x20b, opt); // PE32+
  b.writeUInt32LE(0x200, opt + 60); // SizeOfHeaders
  b.write('.text', sec, 'ascii');
  b.writeUInt32LE(rawSize, sec + 16); // SizeOfRawData
  b.writeUInt32LE(0x200, sec + 20); // PointerToRawData
  return b;
}

/** نصّ الحارس من ملف السير: بين الوسمين، وقد أُزيلت إزاحة YAML. */
function extractGuard(yaml) {
  const lines = yaml.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() === BEGIN);
  const j = lines.findIndex((l) => l.trim() === END);
  if (i < 0 || j < 0 || j <= i) return null;
  const block = lines.slice(i + 1, j);
  const indents = block.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return block.map((l) => l.slice(cut)).join('\n');
}

/** الأسماء من `pub const CUDA_FILES` في cuda_runtime.rs (حتى `];`). */
function cudaFilesFromRust(src) {
  const at = src.indexOf('pub const CUDA_FILES');
  if (at < 0) return null;
  const end = src.indexOf('];', at);
  if (end < 0) return null;
  return [...src.slice(at, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** الأسماء من `$EXPECTED = @( … )` في السير. */
function expectedFromWorkflow(yaml) {
  const at = yaml.indexOf('$EXPECTED');
  if (at < 0) return null;
  const open = yaml.indexOf('@(', at);
  const close = yaml.indexOf(')', open);
  if (open < 0 || close < 0) return null;
  return [...yaml.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** pwsh واحد، بلا نافذة: يشغّل النصّ المستخرج على عيّنات مصنوعة ويسقط إن مرّ
 *  مُفسَد. صفر عمليات مُطلقة سوى pwsh واحد (وقاعدة السلامة في المستودع). */
function runRuleSelfcheck(guardText, verbose) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-cuda-guard-'));
  const mk = (name, buf) => {
    const p = path.join(work, name);
    fs.writeFileSync(p, buf);
    return p;
  };
  const ctrl = path.join(work, 'control');
  fs.mkdirSync(ctrl, { recursive: true });
  const good = [];
  for (const n of ['cudart64_12.dll', 'onnxruntime_providers_shared.dll', 'cufft64_11.dll']) {
    good.push(mk(path.join('control', n), minimalPe()));
  }
  const trunc = mk('trunc.dll', minimalPe().subarray(0, 0x300));
  const stub = mk('stub.dll', Buffer.alloc(0));
  const empty = path.join(work, 'empty');
  fs.mkdirSync(empty, { recursive: true });

  const ps = (p) => "'" + p.replace(/'/g, "''") + "'";
  const driver = [
    // الإخراج يُقرأ من أنبوب: بلا هذا السطر يرمّز pwsh العربية إلى '?'.
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'Stop'",
    '$bin = ' + ps(ctrl),
    guardText, // ① الضابط: ثلاثة PE كاملة ⇒ يمرّ
    'try { Test-CompletePe -File (Get-Item ' + ps(trunc) + '); ' +
      'Write-Host "✗ المُفسَد المبتور مرّ"; exit 1 } ' +
      'catch { Write-Host ("✓ المُفسَد المبتور سقط: " + $_.Exception.Message) }',
    'try { Test-CompletePe -File (Get-Item ' + ps(stub) + '); ' +
      'Write-Host "✗ دمية الـ0 بايت مرّت"; exit 1 } ' +
      'catch { Write-Host ("✓ دمية الـ0 بايت سقطت: " + $_.Exception.Message) }',
    '$bin = ' + ps(empty),
    'try { ' + guardText + '; Write-Host "✗ مجلد فارغ مرّ"; exit 1 } ' +
      'catch { Write-Host ("✓ المجلد الفارغ فشل: " + $_.Exception.Message) }',
    'Write-Host "✓ مُفسَدات قاعدة PE سقطت جميعاً"',
  ].join('\n');
  const driverPath = path.join(work, 'driver.ps1');
  fs.writeFileSync(driverPath, driver);

  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', driverPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  fs.rmSync(work, { recursive: true, force: true });
  if (verbose) for (const l of out.split(/\r?\n/)) if (l.trim()) console.log('   ' + l.trim());
  if (r.error) die('تعذّر تشغيل pwsh لقياس قاعدة PE: ' + r.error.message);
  if (r.status !== 0) {
    die('قاعدة PE في السير لا تُسقط مُفسَدها (exit=' + r.status + '):\n' + out.trim());
  }
  for (const need of ['المُفسَد المبتور سقط', 'دمية الـ0 بايت سقطت', 'المجلد الفارغ فشل']) {
    if (!out.includes(need)) die('قاعدة PE لم تُقَس كما ينبغي — المفقود: ' + need + '\n' + out);
  }
  const checked = (out.match(/✓ .* كامل \(\d+ bytes\)/g) || []).length;
  if (checked !== good.length) {
    die('الضابط لم يمرّ على كل العيّنات: ' + checked + ' من ' + good.length);
  }
  return checked;
}

function main() {
  const argv = process.argv.slice(2);
  let rootArg = null;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
        console.error('✗ العلم --root يحتاج مساراً — مثال: --root /tmp/fixture');
        process.exit(2);
      }
      rootArg = argv[++i];
    } else if (argv[i] === '--verbose') {
      verbose = true;
    } else {
      console.error('✗ وسيط غير معروف: ' + argv[i] + ' — الاستعمال: [--root <dir>] [--verbose]');
      process.exit(2);
    }
  }
  const root = rootArg ? path.resolve(rootArg) : path.join(__dirname, '..');

  const rsPath = path.join(root, 'src-tauri', 'src', 'cuda_runtime.rs');
  const wfPath = path.join(root, '.github', 'workflows', 'cuda-assets.yml');
  if (!fs.existsSync(rsPath)) die('بنية غير صالحة: cuda_runtime.rs غير موجود عند ' + rsPath);
  if (!fs.existsSync(wfPath)) die('بنية غير صالحة: cuda-assets.yml غير موجود عند ' + wfPath);
  const yaml = fs.readFileSync(wfPath, 'utf8');

  // ② القاعدة الواحدة بلا استثناء اسم بعينه.
  if (/-lt\s+\d+\s*KB\s+-and/i.test(yaml)) {
    die(
      'استثناء حجم عاد إلى السير: شرط من صيغة «-lt 10KB -and …» يستثني ملفاً ' +
        'بالاسم من الفحص — وهو العيب الأصلي. القاعدة يجب أن تمرّ على كل ملف.'
    );
  }
  if (/-ne\s+'onnxruntime_providers_shared\.dll'/.test(yaml)) {
    die(
      "الاستثناء بالاسم ما زال في السير: -ne 'onnxruntime_providers_shared.dll' — " +
        'الملف الوحيد الذي لا يفحصه شيء هو العيب نفسه'
    );
  }
  const guardText = extractGuard(yaml);
  if (!guardText) die('وسما ' + BEGIN + ' / ' + END + ' غير موجودين في السير — لا نصّ يُقاس');
  if (!/function\s+Test-CompletePe/.test(guardText)) {
    die('نصّ الحارس المستخرج لا يعرّف Test-CompletePe — الوسم يحيط نصاً آخر');
  }

  // ① افراق القائمتين.
  const names = cudaFilesFromRust(fs.readFileSync(rsPath, 'utf8'));
  const expected = expectedFromWorkflow(yaml);
  if (!names || names.length === 0) die('CUDA_FILES غير مقروء أو فارغ في ' + rsPath);
  if (!expected || expected.length === 0) die('$EXPECTED غير مقروء أو فارغ في ' + wfPath);
  const a = [...names].sort();
  const b = [...expected].sort();
  const missing = a.filter((x) => !b.includes(x));
  const extra = b.filter((x) => !a.includes(x));
  if (missing.length || extra.length) {
    die(
      'افتراق بين CUDA_FILES والسير — ناقص في السير: [' +
        missing.join(', ') +
        '] · زائد في السير: [' +
        extra.join(', ') +
        '] — حدّث القائمتين معاً'
    );
  }

  // ③ الحارس يُقاس بمُفسَداته (والنصّ هو المشحون حرفياً).
  const checked = runRuleSelfcheck(guardText, verbose);

  console.log(
    '✓ حارس أصول CUDA: ' +
      a.length +
      ' اسماً متطابقة بين CUDA_FILES والسير · وقاعدة PE أسقطت مُفسَدَيها (' +
      checked +
      ' عيّنة ضابط مرّت)'
  );
}

if (require.main === module) main();

module.exports = { minimalPe, extractGuard, cudaFilesFromRust, expectedFromWorkflow };
