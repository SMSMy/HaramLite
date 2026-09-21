#Requires -Version 7
<#
  مُشغِّل مُقيِّمات الطبقة (أ) — صفّاً صفّاً، **واحداً في كل مرة**.
  ==============================================================
  لماذا واحداً في كل مرة: كل مُقيِّم يشغّل الفصل الحقيقي على البطاقة، والسقف
  المقيس على هذا الجهاز فتحتان (‏`slots.rs:179-186`: فصلان بلغا 97% من ذاكرة
  البطاقة). والتشغيل المتوازي يخلط الزمن المقيس بانتظار فتحة — وهو بالضبط ما
  يجعل «المكافأة الرقمية» بلا معنى. فالترتيب مقصود لا اتفاقي.

  الاستعمال:
    pwsh -NoProfile -File qa/eval/run-all.ps1                 # العشرة
    pwsh -NoProfile -File qa/eval/run-all.ps1 -Row 3.1,3.3    # صفوف بعينها
    pwsh -NoProfile -File qa/eval/run-all.ps1 -Exe <path>     # ثنائي آخر
#>
[CmdletBinding()]
param(
    [string[]]$Row = @('1.1', '1.4', '2.1', '2.4', '3.1', '3.2', '3.3', '3.7', '3.8', '3.9'),
    [string]$Exe
)
$ErrorActionPreference = 'Stop'

$results = @()
$t0 = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($r in $Row) {
    $script = Join-Path $PSScriptRoot ($r + '.ps1')
    if (-not (Test-Path -LiteralPath $script)) {
        Write-Host ("{0}  لا مُقيِّم: {1}" -f $r, $script)
        $results += [pscustomobject]@{ row = $r; exit = 127; wall_ms = 0 }
        continue
    }
    $args = @('-NoProfile', '-File', $script)
    if ($Exe) { $args += @('-Exe', $Exe) }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & pwsh @args
    $code = $LASTEXITCODE
    $sw.Stop()
    $results += [pscustomobject]@{ row = $r; exit = $code; wall_ms = [int]$sw.ElapsedMilliseconds }
}
$t0.Stop()

Write-Host ''
Write-Host 'الصفّ   رمز   زمن الجدار (ms)'
foreach ($x in $results) {
    Write-Host ("{0,-6}  {1,-4}  {2}" -f $x.row, $x.exit, $x.wall_ms)
}
$bad = @($results | Where-Object { $_.exit -ne 0 })
Write-Host ("المجموع: {0} صفّاً في {1:N1} ث · ناجح {2} · فاشل {3}" -f `
    $results.Count, ($t0.ElapsedMilliseconds / 1000), ($results.Count - $bad.Count), $bad.Count)
if ($bad.Count -gt 0) {
    Write-Host ("الفاشل: " + (($bad | ForEach-Object { $_.row }) -join ' · '))
    exit 1
}
exit 0
