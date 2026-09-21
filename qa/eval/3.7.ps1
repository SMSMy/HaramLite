#Requires -Version 7
<#
  صفّ 3.7 [إلزامي] — مسار فيه قوس مربّع `[`
  ========================================
  سند الصفّ من الكود:
    · `src-tauri/src/yt_dlp.rs:648-651` — تسمية الخانة تُحسب عندنا بلا `[` (العطل
      القديم في `docs/AUDIT.md:80-93`، حين كان `[` يُقرأ نطاقاً في قالب yt-dlp).
    · `src-tauri/src/yt_dlp.rs:805-808` — التعرّف لا يقرأ أسماء الملفات من stdout.
    · `src-tauri/src/pipeline.rs:850` — اسم الناتج يُبنى من اسم المصدر كما هو.

  ما يقيسه هذا المُقيِّم:
    ① دليل باسم `[Archive]` وملف داخله.
    ② رمز الخروج 0 (لا فشل في فتح المسار ذي القوس).
    ③ الناتج `[Archive]\clip_(Vocals)_haramlite.flac` — المسار مطابق حرفاً بحرف.
    ④ السجلّ يحمل المسار الكامل بالقوس كما هو (لا تقسيم ولا تجويف).

  ما لم يُقَس (معلَن): «بلا إعادة تنزيل» في مسار الإضافة (عنوان يوتيوب فيه
  `[Official]`) — يحتاج شبكة ومتصفّحاً؛ والقياس هنا على ملف محلي.

  الاستعمال:  pwsh -NoProfile -File qa/eval/3.7.ps1 [-Exe <path>]
#>
[CmdletBinding()]
param([string]$Exe)

. (Join-Path $PSScriptRoot '_common.ps1')

$row = '3.7'
$sandbox = New-EvalSandbox -Row $row
$exe = Resolve-EvalExe -Exe $Exe
$ffmpeg = Resolve-EvalFfmpeg -Exe $exe

$dirName = '[Archive]'
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

$A = New-EvalAssert
Assert-Eval $A ($run.exit -eq 0) "exit = 0 والمقيس $($run.exit)"
Assert-Eval $A ($null -ne $product) "الناتج داخل [Archive]"
Assert-Eval $A ($product -and $product.bytes -gt 0) "الناتج غير فارغ والمقيس $(if ($product) { $product.bytes } else { 0 }) بايت"
Assert-Eval $A ($product -and $product.path -eq $expected) "المسار المقيس مطابق حرفاً بحرف للمتوقَّع"
Assert-Eval $A ($log -match [regex]::Escape($dirName)) "السجلّ يحمل القوس المربّع كما هو"

$ok = ($A.Fail.Count -eq 0)
$notes = Format-EvalNotes -A $A -NotMeasured 'مسار الإضافة: عنوان فيه [Official] بلا إعادة تنزيل (يحتاج شبكة ومتصفّحاً)'

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
