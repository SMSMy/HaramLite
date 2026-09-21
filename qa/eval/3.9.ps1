#Requires -Version 7
<#
  صفّ 3.9 [إلزامي] — مسار عربي
  ===========================
  سند الصفّ من الكود:
    · `src-tauri/src/pipeline.rs:850` — اسم الناتج `<stem>_(Vocals)_haramlite<tag>`
      يُبنى بـ`with_file_name` من اسم المصدر (لا تحويل ترميز).
    · `src-tauri/src/media.rs:428` — الترميز النهائي إلى `<stem>_haramlite.<fmt>`.
    · `src-tauri/src/yt_dlp.rs:671-673` — `PYTHONIOENCODING=utf-8` (مسار الإضافة).

  ما يقيسه هذا المُقيِّم — وهو **الإعادة الحرفية لما سُجّل في المصفوفة**:
    ① دليل `فيديوهات` وملف `clip.mp4` (اسم لاتيني في دليل عربي، كما في السجلّ).
    ② رمز الخروج 0.
    ③ الناتج `فيديوهات\clip_(Vocals)_haramlite.flac` بجانب المصدر، بلا تشويه.
    ④ السجلّ يحمل اسم الدليل العربي سليماً وبلا `???`.

  ما لم يُقَس (معلَن): مسار الإضافة (رابط عنوانه عربي) — متصفّح وشبكة، خارج الـCLI.

  الاستعمال:  pwsh -NoProfile -File qa/eval/3.9.ps1 [-Exe <path>]
#>
[CmdletBinding()]
param([string]$Exe)

. (Join-Path $PSScriptRoot '_common.ps1')

$row = '3.9'
$sandbox = New-EvalSandbox -Row $row
$exe = Resolve-EvalExe -Exe $Exe
$ffmpeg = Resolve-EvalFfmpeg -Exe $exe

$dirName = 'فيديوهات'
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
Assert-Eval $A ($null -ne $product) "الناتج داخل «فيديوهات»"
Assert-Eval $A ($product -and $product.bytes -gt 0) "الناتج غير فارغ والمقيس $(if ($product) { $product.bytes } else { 0 }) بايت"
Assert-Eval $A ($product -and $product.path -eq $expected) "اسم الناتج سليم بلا تشويه — مطابق حرفاً بحرف"
Assert-Eval $A ($log -match [regex]::Escape($dirName)) "السجلّ يحمل «$dirName» سليماً"
Assert-Eval $A ($log -notmatch '\?\?\?') "السجلّ بلا استبدال ??? (ترميز UTF-8 سليم)"

$ok = ($A.Fail.Count -eq 0)
$notes = Format-EvalNotes -A $A -NotMeasured 'مسار الإضافة: رابط عنوانه عربي (يحتاج متصفّحاً وشبكة)'

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
