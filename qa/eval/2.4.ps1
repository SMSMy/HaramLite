#Requires -Version 7
<#
  صفّ 2.4 [إلزامي] — CUDA Runtime غائب: ينقص ملف واحد من الـ16
  ===========================================================
  سند الصفّ من الكود:
    · `src-tauri/src/cuda_runtime.rs:166-169` — `bin_dir() = <مجلد التنفيذي>\bin`
      (لا متغيّر بيئة يغيّره) ⇒ «غياب ملف» يُصنع بمجلد تنفيذي مصنوع.
    · `src-tauri/src/cuda_runtime.rs:325-336` — «ينقص n من 16 ملفاً (أسماء)».
    · `src-tauri/src/cuda_runtime.rs:316-320` — سقوط معلَن إلى DirectML ثم CPU.
    · `src-tauri/src/cuda_runtime.rs:339-341` — `attempt_cuda()` تشترط `Ready`،
      فالعدّ 15/16 يمنع بناء مزوّد CUDA أصلاً.

  ما يقيسه هذا المُقيِّم:
    ① مجلد تنفيذي **مصنوع** (رابط صلب للثنائي وللـ`bin/` وللـ`models/`) ينقصه
       `cufft64_11.dll` وحده — بلا لمس `bin/` الحقيقي ولا حذف أي ملف منه.
    ② رمز الخروج 0 والناتج موجود: **المعالجة تكمل** رغم النقص.
    ③ السجلّ: «ينقص 1 من 16 ملفاً» واسم الملف `cufft64_11.dll` صريحاً.
    ④ السجلّ: «DirectML ثم CPU» (سقوط مُعلَن لا فشل صامت).
    ⑤ المنفّذ الفعّال **ليس** CUDA (ليس ادّعاء CUDA بلا مكتبات).

  ما لم يُقَس (معلَن): ظهور الخيار «غير متاح» في الواجهة، وإعادة التنزيل عند
  إعادة تفعيل CUDA — يحتاجان واجهة وشبكة.

  الاستعمال:  pwsh -NoProfile -File qa/eval/2.4.ps1 [-Exe <path>]
#>
[CmdletBinding()]
param([string]$Exe)

. (Join-Path $PSScriptRoot '_common.ps1')

$row = '2.4'
$sandbox = New-EvalSandbox -Row $row
$exe = Resolve-EvalExe -Exe $Exe
$ffmpeg = Resolve-EvalFfmpeg -Exe $exe

# ── مجلد تنفيذي مصنوع: الثنائي + bin (ناقص ملفاً واحداً) + models ──────────
$realDir = Split-Path -Parent $exe
$realBin = Join-Path $realDir 'bin'
$realModels = Join-Path $realDir 'models'
if (-not (Test-Path -LiteralPath $realBin)) { Fail-Eval "لا مجلد bin بجانب الثنائي («$realBin») — لا يمكن بناء حالة النقص" }
$missingName = 'cufft64_11.dll'
if (-not (Test-Path -LiteralPath (Join-Path $realBin $missingName))) {
    Fail-Eval "«$missingName» غير موجود في «$realBin» — الصفّ يقيس **غياب** ملف من مجموعة كاملة، ولا مجموعة هنا"
}

$appDir = Join-Path $sandbox.Root 'app'
$appBin = Join-Path $appDir 'bin'
$appModels = Join-Path $appDir 'models'
New-Item -ItemType Directory -Force -Path $appBin, $appModels | Out-Null

$linkKinds = [ordered]@{ exe = (New-EvalLinkOrCopy -Target $exe -Path (Join-Path $appDir 'HaramLite.exe')) }
$binLinked = 0
$binSkipped = @()
foreach ($f in Get-ChildItem -LiteralPath $realBin -File) {
    if ($f.Name -ieq $missingName) { $binSkipped += $f.Name; continue }
    $null = New-EvalLinkOrCopy -Target $f.FullName -Path (Join-Path $appBin $f.Name)
    $binLinked += 1
}
foreach ($f in Get-ChildItem -LiteralPath $realModels -File) {
    $null = New-EvalLinkOrCopy -Target $f.FullName -Path (Join-Path $appModels $f.Name)
}
$appExe = Join-Path $appDir 'HaramLite.exe'
if ($binSkipped.Count -ne 1) { Fail-Eval "المصنوع لم يُنقص ملفاً واحداً بالضبط (المُسقَط: $($binSkipped -join ',')) — البيئة غير صالحة للقياس" }

# ── المدخل والتشغيل ─────────────────────────────────────────────────────────
$inputPath = Join-Path $sandbox.In 'clip.mp4'
New-EvalToneClip -Ffmpeg $ffmpeg -OutPath $inputPath -Seconds 2

$run = Invoke-HaramLite -Exe $appExe -Sandbox $sandbox -Arguments @($inputPath, '-m', 'song', '--cuda')
$log = Get-EvalLog -Sandbox $sandbox
$provider = Get-EvalProvider -Log $log
$diag = Get-EvalCudaDiagnosis -Log $log

$expected = Join-Path $sandbox.In 'clip_(Vocals)_haramlite.flac'
$product = Get-EvalFileInfo -Path $expected
$outs = @()
if ($product) { $outs += $product }

$providerJson = ''
$pjPath = Join-Path $sandbox.Data 'provider.json'
if (Test-Path -LiteralPath $pjPath) { $providerJson = (Get-Content -LiteralPath $pjPath -Raw).Trim() }

$A = New-EvalAssert
Assert-Eval $A ($run.exit -eq 0) "exit = 0 والمقيس $($run.exit)"
Assert-Eval $A ($null -ne $product -and $product.bytes -gt 0) "الناتج موجود وغير فارغ والمقيس $(if ($product) { $product.bytes } else { 0 }) بايت"
Assert-Eval $A ($log -match 'ينقص 1 من 16 ملفاً') "السجلّ: «ينقص 1 من 16 ملفاً»"
Assert-Eval $A ($log -match [regex]::Escape($missingName)) "السجلّ يسمّي الملف الناقص «$missingName»"
Assert-Eval $A ($log -match 'DirectML ثم CPU') "السجلّ: سقوط مُعلَن «DirectML ثم CPU»"
Assert-Eval $A ($provider -ne 'CUDA') "المنفّذ الفعّال ليس CUDA والمقيس «$provider»"
Assert-Eval $A ($providerJson -notmatch '"provider"\s*:\s*"CUDA"') "provider.json ليس CUDA والمقيس «$providerJson»"

$ok = ($A.Fail.Count -eq 0)
$notes = Format-EvalNotes -A $A -NotMeasured 'الواجهة: ظهور الخيار «غير متاح» وإعادة التنزيل عند إعادة التفعيل'

$null = Write-EvalArtifact -Sandbox $sandbox -Exe $appExe -Run $run -Outputs $outs -Verdict $(if ($ok) { 'pass' } else { 'fail' }) `
    -Notes $notes -Provider $provider -ExeSha256 (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash `
    -Extra ([ordered]@{
        input             = (Get-EvalFileInfo -Path $inputPath)
        exe               = $exe
        exe_at            = $appExe
        link_kinds        = $linkKinds
        bin_linked_count  = $binLinked
        bin_removed       = @($binSkipped)
        cuda_diagnosis    = $diag
        provider_json     = $providerJson
        log_bytes         = $log.Length
        stdout_bytes      = $run.stdout.Length
        stderr_bytes      = $run.stderr.Length
        product_outputs   = @($outs | ForEach-Object { $_.path })
    })
Complete-Eval -Ok $ok -Sandbox $sandbox
