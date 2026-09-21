#Requires -Version 7
<#
  صفّ 3.8 [إلزامي] — مسار فيه مسافات
  =================================
  سند الصفّ من الكود:
    · `src-tauri/src/media.rs:130-165` — الوسائط تُبنى كعناصر `Vec` وتُمرَّر
      **كوسيط واحد لكل عنصر** إلى `Command::args` (لا سلسلة تُقسَّم على المسافات).
    · `src-tauri/src/pipeline.rs:850` — اسم الناتج من اسم المصدر.

  ما يقيسه هذا المُقيِّم:
    ① دليل باسم `My Videos 2026` (مسافتان) وملف داخله.
    ② رمز الخروج 0 — ولو قُسِّمت السلسلة على المسافات لصار المسار «`My`» فسقط.
    ③ الناتج `My Videos 2026\clip_(Vocals)_haramlite.flac` مطابقاً حرفاً بحرف.
    ④ السجلّ يحمل المسار الكامل بالمسافات في سطر واحد غير مقطوع.

  ملاحظة: هذا المُقيِّم لا يمرّر الوسائط عبر الصدفة أصلاً — `_common.ps1` تبنيها
  عبر `ProcessStartInfo.ArgumentList`، فالمسار يصل عنصراً واحداً كما في الإنتاج.
  ومع ذلك يبقى القياس صالحاً: أي تقسيم داخل التطبيق نفسه يُسقط الفحص ②/③.

  الاستعمال:  pwsh -NoProfile -File qa/eval/3.8.ps1 [-Exe <path>]
#>
[CmdletBinding()]
param([string]$Exe)

. (Join-Path $PSScriptRoot '_common.ps1')

$row = '3.8'
$sandbox = New-EvalSandbox -Row $row
$exe = Resolve-EvalExe -Exe $Exe
$ffmpeg = Resolve-EvalFfmpeg -Exe $exe

$dirName = 'My Videos 2026'
$mediaDir = Join-Path $sandbox.In $dirName
$inputPath = Join-Path $mediaDir 'clip.mp4'
New-EvalToneClip -Ffmpeg $ffmpeg -OutPath $inputPath -Seconds 2

$run = Invoke-HaramLite -Exe $exe -Sandbox $sandbox -Arguments @($inputPath, '-m', 'song')
$log = Get-EvalLog -Sandbox $sandbox
$provider = Get-EvalProvider -Log $log

$expected = Join-Path $mediaDir 'clip_(Vocals)_haramlite.flac'
$product = Get-EvalFileInfo -Path $expected
$outs = @()
if ($product) { $outs += $product }

$logHasWholePath = $log -match [regex]::Escape($inputPath)

$A = New-EvalAssert
Assert-Eval $A ($run.exit -eq 0) "exit = 0 والمقيس $($run.exit)"
Assert-Eval $A ($null -ne $product) "الناتج داخل «My Videos 2026»"
Assert-Eval $A ($product -and $product.bytes -gt 0) "الناتج غير فارغ والمقيس $(if ($product) { $product.bytes } else { 0 }) بايت"
Assert-Eval $A ($product -and $product.path -eq $expected) "المسار المقيس مطابق حرفاً بحرف للمتوقَّع"
Assert-Eval $A $logHasWholePath "السجلّ يحمل المسار الكامل بالمسافات في سطر واحد"

$ok = ($A.Fail.Count -eq 0)
$notes = Format-EvalNotes -A $A -NotMeasured 'لا شيء خارج طبقة الـCLI في هذا الصفّ'

$null = Write-EvalArtifact -Sandbox $sandbox -Exe $exe -Run $run -Outputs $outs -Verdict $(if ($ok) { 'pass' } else { 'fail' }) `
    -Notes $notes -Provider $provider `
    -Extra ([ordered]@{
        input           = (Get-EvalFileInfo -Path $inputPath)
        expected_path   = $expected
        product_outputs = @($outs | ForEach-Object { $_.path })
        log_bytes       = $log.Length
        stdout_bytes    = $run.stdout.Length
        stderr_bytes    = $run.stderr.Length
    })
Complete-Eval -Ok $ok -Sandbox $sandbox
