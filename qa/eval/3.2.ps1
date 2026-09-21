#Requires -Version 7
<#
  صفّ 3.2 [إلزامي] — امتداد خاطئ: فيديو حقيقي باسم `.mp3`
  =====================================================
  سند الصفّ من الكود:
    · `src-tauri/src/media.rs:328-340` — التصنيف يعتمد على **المحتوى** لا الامتداد:
      `container_is_video` يُفحَص على اسم الحاوية **وعلى الامتداد معاً**، و
      `audio_disguised_as_video` تُشتقّ من التيارات المقروءة فعلاً.
    · `src-tauri/src/media.rs:322-326` — `attached_pic` مُستثنى من «فيديو حقيقي».
    · `src-tauri/src/output naming` — `pipeline.rs:850` / `media.rs:428`.

  ما يقيسه هذا المُقيِّم:
    ① حاوية فيديو حقيقية (‏`mpeg4`+`aac`) أُعيد تسميتها `.mp3`.
    ② رمز الخروج 0 — أي أنها **عُوملت** ولم تُرفض بسبب الامتداد.
    ③ الناتج `video_renamed_(Vocals)_haramlite.flac`: **صوت** لا فيديو، وبجانب المصدر.
    ④ لا ناتج فيديو (`*_(Clean)_haramlite.mp4`) — الوضع «أغنية» لا ينتج فيديو.

  حدّ مقيس ومعلَن: راية `audio_disguised_as_video` نفسها **لا تُطبع في السجلّ**
  (لا سطر `tracing` لها في مسار الإنتاج)، ونصّ `--probe` غير قابل للالتقاط
  (`lib.rs:62-85`). فالحكم — كما في جولة المصفوفة السابقة — من **نتيجة المعالجة**.
  والفرق الذي يترتّب على ذلك: ملف فيه مسار فيديو حقيقي تُبقى رايته `false`
  (لأن `real_videos` غير فارغة) ومع ذلك يُعامل كصوت في وضع «أغنية» — وهو المقيس.

  الاستعمال:  pwsh -NoProfile -File qa/eval/3.2.ps1 [-Exe <path>]
#>
[CmdletBinding()]
param([string]$Exe)

. (Join-Path $PSScriptRoot '_common.ps1')

$row = '3.2'
$sandbox = New-EvalSandbox -Row $row
$exe = Resolve-EvalExe -Exe $Exe
$ffmpeg = Resolve-EvalFfmpeg -Exe $exe

$source = Join-Path $sandbox.In 'clip.mp4'
New-EvalToneClip -Ffmpeg $ffmpeg -OutPath $source -Seconds 3
$renamed = Join-Path $sandbox.In 'video_renamed.mp3'
Move-Item -LiteralPath $source -Destination $renamed

$run = Invoke-HaramLite -Exe $exe -Sandbox $sandbox -Arguments @($renamed, '-m', 'song')
$log = Get-EvalLog -Sandbox $sandbox
$provider = Get-EvalProvider -Log $log

$expected = Join-Path $sandbox.In 'video_renamed_(Vocals)_haramlite.flac'
$product = Get-EvalFileInfo -Path $expected
$outs = @()
if ($product) { $outs += $product }
$videoOut = @(Get-ChildItem -LiteralPath $sandbox.In -File | Where-Object { $_.Name -like '*_(Clean)_haramlite.*' })

$A = New-EvalAssert
Assert-Eval $A ($run.exit -eq 0) "exit = 0 والمقيس $($run.exit)"
Assert-Eval $A ($null -ne $product -and $product.bytes -gt 0) "ناتج صوتي باسم video_renamed_(Vocals)_haramlite.flac والمقيس $(if ($product) { $product.bytes } else { 0 }) بايت"
Assert-Eval $A ($videoOut.Count -eq 0) "لا ناتج فيديو في وضع «أغنية» والمقيس $($videoOut.Count)"
Assert-Eval $A ($log -match [regex]::Escape('video_renamed.mp3')) "السجلّ يسمّي المصدر بامتداده المضلِّل"

$ok = ($A.Fail.Count -eq 0)
$notes = Format-EvalNotes -A $A -NotMeasured 'راية audio_disguised_as_video في نصّ --probe (لا سطر سجلّ لها، والطباعة على الشاشة مُعاد ربطها بـCONOUT$)'

$null = Write-EvalArtifact -Sandbox $sandbox -Exe $exe -Run $run -Outputs $outs -Verdict $(if ($ok) { 'pass' } else { 'fail' }) `
    -Notes $notes -Provider $provider `
    -Extra ([ordered]@{
        input           = (Get-EvalFileInfo -Path $renamed)
        expected_path   = $expected
        product_outputs = @($outs | ForEach-Object { $_.path })
        log_bytes       = $log.Length
        stdout_bytes    = $run.stdout.Length
        stderr_bytes    = $run.stderr.Length
    })
Complete-Eval -Ok $ok -Sandbox $sandbox
