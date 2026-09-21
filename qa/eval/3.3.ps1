#Requires -Version 7
<#
  صفّ 3.3 [إلزامي] — فيديو بلا مسار صوتي
  =====================================
  سند الصفّ من الكود:
    · `src-tauri/src/media.rs:302-314` — مدخل بلا تيارات مقروءة ⇒ `InvalidOutput`.
    · `src-tauri/src/media.rs:316-341` — `has_audio=false` تُشتقّ من التيارات.
    · `src-tauri/src/cli.rs:272-276` — الفشل يُطبع «فشلت المعالجة» ويُحتسب في
      `failed` ⇒ رمز الخروج 1.

  ما يقيسه هذا المُقيِّم:
    ① فيديو مبنيّ بـ`-an` (لا مسار صوتي أصلاً).
    ② رمز الخروج ≠ 0 (رفض، لا تعليق).
    ③ **لا ملف ناتج** — لا ملف صوتي ولا ملف **فارغ** يُترك بلا إشارة.
    ④ شاهد الرفض: ملف السجلّ مكتوب ويحمل سطر الفشل.

  حدّ مقيس ومعلَن (وهو نفسه المسجَّل في المصفوفة جولةً سابقة): الرسالة الظاهرة
  رسالة ffmpeg مترجَمة، **لا رسالة عربية مخصّصة لغياب المسار الصوتي** — تحسين UX
  مسجَّل ولا يُدَّعى هنا. لذلك لا يُشترط نصّ بعينه، بل يُقاس **الرفض** و**غياب الناتج**.

  الاستعمال:  pwsh -NoProfile -File qa/eval/3.3.ps1 [-Exe <path>]
#>
[CmdletBinding()]
param([string]$Exe)

. (Join-Path $PSScriptRoot '_common.ps1')

$row = '3.3'
$sandbox = New-EvalSandbox -Row $row
$exe = Resolve-EvalExe -Exe $Exe
$ffmpeg = Resolve-EvalFfmpeg -Exe $exe

$silent = Join-Path $sandbox.In 'silent.mp4'
New-EvalSilentVideo -Ffmpeg $ffmpeg -OutPath $silent -Seconds 3

# تحقّق مستقل من أن المدخل **فعلاً** بلا صوت — وإلا لكان الصفّ يقيس شيئاً آخر.
$probeJson = & $ffmpeg -hide_banner -loglevel error -i $silent -f null - 2>&1 | Out-String
$probeStreams = (& (Join-Path (Split-Path -Parent $ffmpeg) 'ffprobe.exe') -v error -show_entries stream=codec_type -of csv=p=0 $silent 2>&1 | Out-String).Trim()
$audioStreams = @($probeStreams -split "`n" | Where-Object { $_.Trim() -eq 'audio' }).Count

$run = Invoke-HaramLite -Exe $exe -Sandbox $sandbox -Arguments @($silent, '-m', 'song')
$log = Get-EvalLog -Sandbox $sandbox
$provider = Get-EvalProvider -Log $log

$produced = @(Get-ChildItem -LiteralPath $sandbox.In -File |
    Where-Object { $_.Name -like 'silent_*' -or $_.Name -like '*_haramlite.*' })

$witness = Get-EvalLogFileInfo -Sandbox $sandbox
$outs = @()
if ($witness) { $outs += $witness }

$A = New-EvalAssert
Assert-Eval $A ($audioStreams -eq 0) "المدخل بلا مسار صوتي فعلاً (تيارات audio = $audioStreams)"
Assert-Eval $A ($run.exit -ne 0 -and $null -ne $run.exit) "exit ≠ 0 والمقيس $($run.exit)"
Assert-Eval $A ($produced.Count -eq 0) "لا ملف ناتج ولا ملف فارغ والمقيس $($produced.Count) ملفاً"
Assert-Eval $A ($null -ne $witness) "شاهد الرفض: ملف السجلّ مكتوب ($(if ($witness) { $witness.bytes } else { 0 }) بايت)"
# نصّ الرفض في **السجلّ** هو `ERROR pipe: مخرجات غير صالحة: …` (‏`media.rs:81`).
# و«فشلت المعالجة» نصّ stderr من `cli.rs:273` لا يمرّ بالـtracing.
Assert-Eval $A ($log -match 'مخرجات غير صالحة') "السجلّ يسمّي سبب الرفض («مخرجات غير صالحة»)"
Assert-Eval $A ($log -match 'ERROR media: ffmpeg failed') "السجلّ يحمل خطأ الأداة بمستوى ERROR"
Assert-Eval $A ($log -notmatch 'panic') "السجلّ خالٍ من panic"

$ok = ($A.Fail.Count -eq 0)
$notes = Format-EvalNotes -A $A -NotMeasured 'رسالة عربية مخصّصة لغياب المسار الصوتي (المقيس أن الرفض يقع بلا ناتج؛ نصّ الرسالة من ffmpeg — تحسين UX مسجَّل)'

$null = Write-EvalArtifact -Sandbox $sandbox -Exe $exe -Run $run -Outputs $outs -Verdict $(if ($ok) { 'pass' } else { 'fail' }) `
    -Notes $notes -Provider $provider `
    -Extra ([ordered]@{
        input           = (Get-EvalFileInfo -Path $silent)
        audio_streams   = $audioStreams
        product_outputs = @()
        observed_dir    = @($produced | ForEach-Object { $_.Name })
        log_bytes       = $log.Length
        stdout_bytes    = $run.stdout.Length
        stderr_bytes    = $run.stderr.Length
        outputs_kind    = 'log-witness'
    })
Complete-Eval -Ok $ok -Sandbox $sandbox
