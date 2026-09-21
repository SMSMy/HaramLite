#Requires -Version 7
<#
  صفّ 3.1 [إلزامي] — ملف 0 بايت
  =============================
  سند الصفّ من الكود:
    · `src-tauri/src/media.rs:63-71` — `InvalidOutput` تُترجَم إلى «مخرجات غير صالحة: …».
    · `src-tauri/src/media.rs:302-314` — **الإصلاح** (`33638a4`): «نتيجة فارغة = فشل»،
      لأن ffprobe يطبع `{}` على stdout ويخرج بـ1 فيُحلَّل بنجاح. فـ`--probe` صار
      يخرج **1** لملف صفر/مفقود بعد أن كان يخرج **0** ويطبع تصنيفاً فارغاً.
    · `src-tauri/src/cli.rs:135-158` — `run_probe` يُرجع 1 عند `Err`.

  ما يقيسه هذا المُقيِّم (أربعة أقيسة، وفيها ضابط يمنع «الفشل الدائم»):
    ① `--probe` لملف **0 بايت** ⇒ exit 1.
    ② `--probe` لملف **مفقود** ⇒ exit 1.
    ③ **الضابط**: `--probe` لملف سليم ⇒ exit 0 (وإلا لمرّ ① و② لأن كل فحص يفشل).
    ④ المعالجة (`-m song`) للملف الصفري ⇒ exit ≠ 0 و**لا ملف ناتج** ولا ملف فارغ.

  ملاحظة مقيسة: نصّ `--probe` على الشاشة **غير قابل للالتقاط** — الثنائي يعيد ربط
  stdout بـ`CONOUT$` عمداً (`lib.rs:62-85`)، والحكم هنا من **رمز الخروج** وحده.

  الاستعمال:  pwsh -NoProfile -File qa/eval/3.1.ps1 [-Exe <path>]
#>
[CmdletBinding()]
param([string]$Exe)

. (Join-Path $PSScriptRoot '_common.ps1')

$row = '3.1'
$sandbox = New-EvalSandbox -Row $row
$exe = Resolve-EvalExe -Exe $Exe
$ffmpeg = Resolve-EvalFfmpeg -Exe $exe

$emptyPath = Join-Path $sandbox.In 'empty.mp4'
$missingPath = Join-Path $sandbox.In 'does-not-exist.mp4'
$goodPath = Join-Path $sandbox.In 'good.mp4'
New-EvalEmptyFile -OutPath $emptyPath
New-EvalToneClip -Ffmpeg $ffmpeg -OutPath $goodPath -Seconds 2

# ①②③ الاستطلاع (شاهد على أن الإصلاح يعمل في الاتجاهين، لا في اتجاه واحد).
$probeEmpty = Invoke-HaramLite -Exe $exe -Sandbox $sandbox -Arguments @('--probe', $emptyPath)
$probeMissing = Invoke-HaramLite -Exe $exe -Sandbox $sandbox -Arguments @('--probe', $missingPath)
$probeGood = Invoke-HaramLite -Exe $exe -Sandbox $sandbox -Arguments @('--probe', $goodPath)

# ④ المعالجة: الرفض النظيف — وهي القياس الأساسي لهذا الأثر.
$run = Invoke-HaramLite -Exe $exe -Sandbox $sandbox -Arguments @($emptyPath, '-m', 'song')
$log = Get-EvalLog -Sandbox $sandbox
$provider = Get-EvalProvider -Log $log

# «لا ناتج» تُقاس بمسح مجلد المدخل بعد التشغيل لا بالنظر إلى اسم متوقَّع.
$produced = @(Get-ChildItem -LiteralPath $sandbox.In -File |
    Where-Object { $_.Name -like 'empty_*' -or $_.Name -like '*_haramlite.*' })

$witness = Get-EvalLogFileInfo -Sandbox $sandbox
$outs = @()
if ($witness) { $outs += $witness }

$A = New-EvalAssert
Assert-Eval $A ($probeEmpty.exit -eq 1) "--probe لملف 0 بايت ⇒ exit 1 والمقيس $($probeEmpty.exit)"
Assert-Eval $A ($probeMissing.exit -eq 1) "--probe لملف مفقود ⇒ exit 1 والمقيس $($probeMissing.exit)"
Assert-Eval $A ($probeGood.exit -eq 0) "الضابط: --probe لملف سليم ⇒ exit 0 والمقيس $($probeGood.exit)"
Assert-Eval $A ($run.exit -ne 0 -and $null -ne $run.exit) "المعالجة ترفض ⇒ exit ≠ 0 والمقيس $($run.exit)"
Assert-Eval $A ($produced.Count -eq 0) "لا ملف ناتج ولا ملف فارغ والمقيس $($produced.Count) ملفاً"
Assert-Eval $A ($null -ne $witness) "شاهد الرفض: ملف السجلّ مكتوب ($(if ($witness) { $witness.bytes } else { 0 }) بايت)"
# نصّ الرفض في **السجلّ** هو `ERROR pipe: مخرجات غير صالحة: …` (‏`media.rs:81` عبر
# هدف `pipe`). و«فشلت المعالجة» نصّ stderr من `cli.rs:273` ولا يمرّ بالـtracing،
# فطلبُه في السجلّ كان فحصاً عن نصّ لا يُكتب هناك — عطل في الفحص لا في التطبيق.
Assert-Eval $A ($log -match 'مخرجات غير صالحة') "السجلّ يسمّي سبب الرفض («مخرجات غير صالحة»)"
Assert-Eval $A ($log -match 'ERROR media: ffmpeg failed') "السجلّ يحمل خطأ الأداة بمستوى ERROR"
Assert-Eval $A ($log -notmatch 'panic') "السجلّ خالٍ من panic"

$ok = ($A.Fail.Count -eq 0)
$notes = Format-EvalNotes -A $A -NotMeasured 'نصّ رسالة الرفض على الشاشة (stdout مُعاد ربطه بـCONOUT$ عمداً — يُقاس رمز الخروج وحده)'

$null = Write-EvalArtifact -Sandbox $sandbox -Exe $exe -Run $run -Outputs $outs -Verdict $(if ($ok) { 'pass' } else { 'fail' }) `
    -Notes $notes -Provider $provider `
    -Extra ([ordered]@{
        input            = (Get-EvalFileInfo -Path $emptyPath)
        probe_exits      = [ordered]@{ empty = $probeEmpty.exit; missing = $probeMissing.exit; good = $probeGood.exit }
        probe_wall_ms    = [ordered]@{ empty = $probeEmpty.wall_ms; missing = $probeMissing.wall_ms; good = $probeGood.wall_ms }
        product_outputs  = @()
        observed_dir     = @($produced | ForEach-Object { $_.Name })
        log_bytes        = $log.Length
        stdout_bytes     = $run.stdout.Length
        stderr_bytes     = $run.stderr.Length
        outputs_kind     = 'log-witness'
    })
Complete-Eval -Ok $ok -Sandbox $sandbox
