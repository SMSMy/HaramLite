#Requires -Version 7
<#
  صفّ 1.4 [إلزامي] — عربي/اتجاه RTL: مسار عربي فيه مسافات
  ======================================================
  سند الصفّ من الكود:
    · `src-tauri/src/pipeline.rs:850` — اسم الناتج يُبنى `<stem>_(Vocals)_haramlite<tag>`.
    · `src-tauri/src/media.rs:428` — الترميز النهائي يكتب `<stem>_haramlite.<fmt>`.
    · `src-tauri/src/yt_dlp.rs:671-673` — `PYTHONIOENCODING=utf-8` تُفرض للعملية
      الفرعية كي لا يُشوَّه العربي في مخرجات yt-dlp.

  ما يقيسه هذا المُقيِّم:
    ① دليل باسم **عربي فيه مسافات** (`فيديوهات 2026`) وملف باسم عربي فيه مسافة.
    ② رمز الخروج 0.
    ③ اسم الناتج **مطابق حرفاً بحرف** للمتوقَّع: `مقطع تجريبي_(Vocals)_haramlite.flac`
       بجانب المصدر — لا تشويه ولا استبدال حرف.
    ④ السجلّ (ملف UTF-8) يحمل الاسم العربي **سليماً** ولا يحمل `???`.

  ما لم يُقَس (معلَن): مسار الإضافة (`yt_dlp.rs:671-673`) — إرسال رابط عنوانه عربي
  يحتاج متصفّحاً وشبكة، وهو خارج طبقة الـCLI (سُجّل في المصفوفة جولةً سابقة).

  الاستعمال:  pwsh -NoProfile -File qa/eval/1.4.ps1 [-Exe <path>]
#>
[CmdletBinding()]
param([string]$Exe)

. (Join-Path $PSScriptRoot '_common.ps1')

$row = '1.4'
$sandbox = New-EvalSandbox -Row $row
$exe = Resolve-EvalExe -Exe $Exe
$ffmpeg = Resolve-EvalFfmpeg -Exe $exe

$dirName = 'فيديوهات 2026'
$stem = 'مقطع تجريبي'
$mediaDir = Join-Path $sandbox.In $dirName
$inputPath = Join-Path $mediaDir ($stem + '.mp4')
New-EvalToneClip -Ffmpeg $ffmpeg -OutPath $inputPath -Seconds 3

$run = Invoke-HaramLite -Exe $exe -Sandbox $sandbox -Arguments @($inputPath, '-m', 'song')
$log = Get-EvalLog -Sandbox $sandbox
$provider = Get-EvalProvider -Log $log

$expected = Join-Path $mediaDir ($stem + '_(Vocals)_haramlite.flac')
$product = Get-EvalFileInfo -Path $expected
$outs = @()
if ($product) { $outs += $product }

$A = New-EvalAssert
Assert-Eval $A ($run.exit -eq 0) "exit = 0 والمقيس $($run.exit)"
Assert-Eval $A ($null -ne $product) "الناتج باسمه العربي الكامل بجانب المصدر"
Assert-Eval $A ($product -and $product.bytes -gt 0) "الناتج غير فارغ والمقيس $(if ($product) { $product.bytes } else { 0 }) بايت"
Assert-Eval $A ($product -and $product.path -eq $expected) "المسار المقيس مطابق حرفاً بحرف للمتوقَّع"
Assert-Eval $A ($log -match [regex]::Escape($dirName)) "السجلّ يحمل اسم الدليل العربي سليماً"
Assert-Eval $A ($log -match [regex]::Escape($stem)) "السجلّ يحمل اسم الملف العربي سليماً"
Assert-Eval $A ($log -notmatch '\?\?\?') "السجلّ بلا استبدال ??? (ترميز UTF-8 سليم)"

$ok = ($A.Fail.Count -eq 0)
$notes = Format-EvalNotes -A $A -NotMeasured 'مسار الإضافة: رابط فيديو عنوانه عربي (يحتاج متصفّحاً وشبكة)'

$null = Write-EvalArtifact -Sandbox $sandbox -Exe $exe -Run $run -Outputs $outs -Verdict $(if ($ok) { 'pass' } else { 'fail' }) `
    -Notes $notes -Provider $provider `
    -Extra ([ordered]@{
        input          = (Get-EvalFileInfo -Path $inputPath)
        expected_path  = $expected
        log_bytes      = $log.Length
        stdout_bytes   = $run.stdout.Length
        stderr_bytes   = $run.stderr.Length
        product_outputs = @($outs | ForEach-Object { $_.path })
    })
Complete-Eval -Ok $ok -Sandbox $sandbox
