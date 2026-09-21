#Requires -Version 7
<#
  صفّ 1.1 [إلزامي] — ويندوز 11: الإقلاع بلا نافذة كونسول · المعالجة تكتمل · السجل بلا panic
  =====================================================================================
  سند الصفّ من الكود:
    · `src-tauri/src/main.rs:2` — `windows_subsystem = "windows"` في الإصدار ⇒
      النظام الفرعي للثنائي GUI (2)، فلا نافذة كونسول عند الإقلاع.
    · `src-tauri/src/pipeline.rs` — مراحل `stage normalize|separate|effects|encode`
      ثم `pipeline done` (وهي «سطور media/separator» المطلوبة في الصفّ).
    · `src-tauri/src/media.rs` — كل نداء أداة بلا نافذة (`creation_flags`).
    · `src-tauri/src/slots.rs` — المهمّة تُفتح وتُغلق (`بدأت المهمة` / `انتهت المهمة`).

  ما يقيسه هذا المُقيِّم (لا شيء غيره):
    ① النظام الفرعي لترويسة PE للثنائي = 2 (GUI).
    ② رمز خروج المعالجة = 0.
    ③ ملف الغناء `clip_(Vocals)_haramlite.flac` موجود وغير فارغ (بايت + SHA-256).
    ④ السجلّ يحوي `stage separate` و`stage encode` و`pipeline done`.
    ⑤ السجلّ خالٍ من `panic`.

  ما لم يُقَس (معلَن): الثبات على ويندوز 11 المثبَّت بالمثبّت الرسمي — هذا القياس
  على ثنائي شجرة التطوير، وتثبيت 0.2.7 سُجّل في المصفوفة جولةً سابقة.

  الاستعمال:  pwsh -NoProfile -File qa/eval/1.1.ps1 [-Exe <path>]
#>
[CmdletBinding()]
param([string]$Exe)

. (Join-Path $PSScriptRoot '_common.ps1')

$row = '1.1'
$sandbox = New-EvalSandbox -Row $row
$exe = Resolve-EvalExe -Exe $Exe
$ffmpeg = Resolve-EvalFfmpeg -Exe $exe

# المدخل الحتمي: 3 ثوانٍ · نغمات جيبية ستيريو + فيديو صغير (بلا شبكة).
$inputPath = Join-Path $sandbox.In 'clip.mp4'
New-EvalToneClip -Ffmpeg $ffmpeg -OutPath $inputPath -Seconds 3

$run = Invoke-HaramLite -Exe $exe -Sandbox $sandbox -Arguments @($inputPath, '-m', 'song')
$log = Get-EvalLog -Sandbox $sandbox
$provider = Get-EvalProvider -Log $log

$expected = Join-Path $sandbox.In 'clip_(Vocals)_haramlite.flac'
$product = Get-EvalFileInfo -Path $expected
$outs = @()
if ($product) { $outs += $product }

$subsystem = Get-EvalPeSubsystem -Path $exe

$A = New-EvalAssert
Assert-Eval $A ($subsystem -eq 2) "النظام الفرعي PE = 2 (GUI) والمقيس $subsystem"
Assert-Eval $A ($run.exit -eq 0) "exit = 0 والمقيس $($run.exit)"
Assert-Eval $A ($null -ne $product) "المخرَج موجود: clip_(Vocals)_haramlite.flac"
Assert-Eval $A ($product -and $product.bytes -gt 0) "المخرَج غير فارغ والمقيس $(if ($product) { $product.bytes } else { 0 }) بايت"
Assert-Eval $A ($log -match 'stage separate') "السجلّ يحوي stage separate"
Assert-Eval $A ($log -match 'stage encode') "السجلّ يحوي stage encode"
Assert-Eval $A ($log -match 'pipeline done in') "السجلّ يحوي pipeline done in"
Assert-Eval $A ($log -notmatch 'panic') "السجلّ خالٍ من panic"

$ok = ($A.Fail.Count -eq 0)
$notes = Format-EvalNotes -A $A -NotMeasured 'التثبيت الرسمي بالمثبّت وويندوز 11 المثبَّت (القياس على ثنائي شجرة التطوير)'

$null = Write-EvalArtifact -Sandbox $sandbox -Exe $exe -Run $run -Outputs $outs -Verdict $(if ($ok) { 'pass' } else { 'fail' }) `
    -Notes $notes -Provider $provider -AppVersion (Get-Item -LiteralPath $exe).VersionInfo.FileVersion `
    -Extra ([ordered]@{
        input        = (Get-EvalFileInfo -Path $inputPath)
        pe_subsystem = $subsystem
        log_bytes    = $log.Length
        stdout_bytes = $run.stdout.Length
        stderr_bytes = $run.stderr.Length
        log_tail     = (($log -split "`n" | Where-Object { $_ -match 'pipeline done|execution provider|انتهت المهمة' }) -join "`n")
    })
Complete-Eval -Ok $ok -Sandbox $sandbox
