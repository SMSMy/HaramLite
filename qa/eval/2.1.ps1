#Requires -Version 7
<#
  صفّ 2.1 [إلزامي] — NVIDIA حديثة + تعريف حديث: CUDA
  =================================================
  سند الصفّ من الكود:
    · `src-tauri/src/cuda_runtime.rs:81-83` — التوفّر شرطه وجود **16 ملفاً**
      كاملة في `bin/` بجانب التنفيذي (`bin_dir()` في `:166-169`).
    · `src-tauri/src/separator.rs:378-401` — تشخيص CUDA يُطبع، والسلسلة
      `CUDA -> DirectML -> CPU` معلَنة قبل المحاولة.
    · `src-tauri/src/separator.rs:452-458` — `execution provider: <label> ✓`،
      ولا يُحتسب مزوّد إلا إن سجّله ORT فعلاً (`:431-435`).
    · `src-tauri/src/separator.rs:215` — `provider.json` في مجلد البيانات.

  ما يقيسه هذا المُقيِّم:
    ① الثنائي يُشغَّل بـ`--cuda` (المسار الذي يجعل السلسلة قابلة للاختبار بلا واجهة).
    ② رمز الخروج 0 والناتج موجود (الفصل ينجح فعلاً لا أنه «لم يفشل»).
    ③ السجلّ: تشخيص «CUDA مكتملة (16/16 ملفاً)».
    ④ السجلّ: `execution provider: CUDA`.
    ⑤ `provider.json` = `{"provider":"CUDA"}`.

  ما لم يُقَس (معلَن): خطوة الواجهة (تفعيل الخيار + انتظار تنزيل ≈2.9GB بعدّاد
  تقدّم) — تحتاج واجهة وشبكة؛ وثُبِّت وجود الستة عشر في `bin/` قياساً هنا.

  الاستعمال:  pwsh -NoProfile -File qa/eval/2.1.ps1 [-Exe <path>]
#>
[CmdletBinding()]
param([string]$Exe)

. (Join-Path $PSScriptRoot '_common.ps1')

$row = '2.1'
$sandbox = New-EvalSandbox -Row $row
$exe = Resolve-EvalExe -Exe $Exe
$ffmpeg = Resolve-EvalFfmpeg -Exe $exe

$inputPath = Join-Path $sandbox.In 'clip.mp4'
New-EvalToneClip -Ffmpeg $ffmpeg -OutPath $inputPath -Seconds 2

$run = Invoke-HaramLite -Exe $exe -Sandbox $sandbox -Arguments @($inputPath, '-m', 'song', '--cuda')
$log = Get-EvalLog -Sandbox $sandbox
$provider = Get-EvalProvider -Log $log
$diag = Get-EvalCudaDiagnosis -Log $log

$expected = Join-Path $sandbox.In 'clip_(Vocals)_haramlite.flac'
$product = Get-EvalFileInfo -Path $expected
$outs = @()
if ($product) { $outs += $product }

# مكتبات التشغيل: عدد الملفات وحجمها الكلّي في `bin/` بجانب التنفيذي (قراءة فقط).
$binDir = Join-Path (Split-Path -Parent $exe) 'bin'
$binFiles = @()
if (Test-Path -LiteralPath $binDir) { $binFiles = @(Get-ChildItem -LiteralPath $binDir -File) }
$binBytes = 0
foreach ($f in $binFiles) { $binBytes += [long]$f.Length }

$providerJson = ''
$pjPath = Join-Path $sandbox.Data 'provider.json'
if (Test-Path -LiteralPath $pjPath) { $providerJson = (Get-Content -LiteralPath $pjPath -Raw).Trim() }

$A = New-EvalAssert
Assert-Eval $A ($run.exit -eq 0) "exit = 0 والمقيس $($run.exit)"
Assert-Eval $A ($null -ne $product -and $product.bytes -gt 0) "الناتج موجود وغير فارغ والمقيس $(if ($product) { $product.bytes } else { 0 }) بايت"
Assert-Eval $A ($provider -eq 'CUDA') "execution provider = CUDA والمقيس «$provider»"
Assert-Eval $A ($log -match 'CUDA مكتملة \(16/16 ملفاً\)') "تشخيص السجلّ: CUDA مكتملة (16/16 ملفاً)"
Assert-Eval $A ($providerJson -match '"provider"\s*:\s*"CUDA"') "provider.json = CUDA والمقيس «$providerJson»"
Assert-Eval $A ($binFiles.Count -ge 16) "bin/ بجانب التنفيذي يحوي $($binFiles.Count) ملفاً (المطلوب ≥16)"

$ok = ($A.Fail.Count -eq 0)
$notes = Format-EvalNotes -A $A -NotMeasured 'خطوة الواجهة: تفعيل الخيار وعدّاد تنزيل مكوّنات CUDA (≈2.9GB)'

$null = Write-EvalArtifact -Sandbox $sandbox -Exe $exe -Run $run -Outputs $outs -Verdict $(if ($ok) { 'pass' } else { 'fail' }) `
    -Notes $notes -Provider $provider `
    -Extra ([ordered]@{
        input             = (Get-EvalFileInfo -Path $inputPath)
        cuda_diagnosis    = $diag
        provider_json     = $providerJson
        bin_file_count    = $binFiles.Count
        bin_total_bytes   = $binBytes
        log_bytes         = $log.Length
        stdout_bytes      = $run.stdout.Length
        stderr_bytes      = $run.stderr.Length
        product_outputs   = @($outs | ForEach-Object { $_.path })
    })
Complete-Eval -Ok $ok -Sandbox $sandbox
