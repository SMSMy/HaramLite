# =============================================================================
# أساس مُقيِّمات الطبقة (أ) — «تُقاس بالـCLI» (خطة 0.2.9 §١٠)
# =============================================================================
# يُستدعى بالتنقيط (dot-source) من `qa/eval/<رقم>.ps1`، ولا يُشغَّل وحده.
#
# **لماذا هذا الملف موجود**: كل مُقيِّم يحتاج الأربعة نفسها — حلّ الثنائي، وحلّ
# ffmpeg، وبيئة معزولة، وقياس (زمن/رمز خروج/بصمة) — وتكرارها عشر مرّات يجعل
# تصحيح عطل واحد تصحيحاً في عشرة مواضع. أمّا **بناء المدخل** فليس هنا: كل مُقيِّم
# يبنيه بنفسه بأعلامه الصريحة، فيبقى المدخل جزءاً من المُقيِّم لا من الأساس.
#
# ---------------------------------------------------------------------------
# ثلاث حقائق مقيسة تحكم التصميم كلّه (لا افتراضات):
# ---------------------------------------------------------------------------
# ١) **مخرَج stdout غير قابل للالتقاط عمداً.** الثنائي يعيد ربط stdout/stderr
#    بـ`CONOUT$` عند وجود وسائط CLI (`lib.rs:62-85`) ليرى المستخدم الطباعة في
#    طرفيته رغم أن النظام الفرعي `windows`. فخطّ الأنابيب يبقى فارغاً. **وقد
#    قِيس فعلاً**: `HaramLite.exe -V` عبر `pwsh` أعاد `exit=0` في 57ms وصفر
#    سطر. لذلك الحكم هنا من **ثلاثة مصادر لا من الطباعة**:
#      · رمز الخروج                     · ملفات المخرَج (بايت + SHA-256)
#      · ملف السجلّ (`<بيانات>\logs\haramlite.log.<تاريخ>`)
#
# ٢) **السجلّ لا يقرأ `HARAMLITE_DATA_DIR`.** `logging::init_cli` يبني مساره من
#    `LOCALAPPDATA` مباشرةً (`logging.rs:177-183`)، بينما بقية المسارات تقرأ
#    `HARAMLITE_DATA_DIR` (`paths.rs:20-26`). فتمرير الأول وحده **يكتب في سجلّ
#    المستخدم الحقيقي** — وقد وقع هذا فعلاً في أول تشغيل استكشافي (٣ أسطر في
#    `haramlite.log.2026-09-21`). فالعزل هنا يضبط **الاثنين**.
#
# ٣) **`HARAMLITE_SLOTS_NAME` يمنح ميزانية فتحات منفصلة.** التحديد معلَّق على
#    اسم جسم النواة لا على التطبيق (`slots.rs:115-120`)، فالاسم الخاص يجعل
#    تشغيل المُقيِّم لا ينتظر خلف مهامّ المالك ولا يزاحمها.
#
# ---------------------------------------------------------------------------
# الحدود المعلَنة (لا تُخفى):
# ---------------------------------------------------------------------------
# · القياس **لا** يشمل ما يحتاج واجهة أو متصفّحاً أو عتاداً آخر — كل صفّ يسمّي
#   في `notes` ما لم يُقَس منه.
# · الزمن صنف قياس على جهاز مشغول: يُنقل كنقطة، ولا يُقارَن بين صفّين كأنه ثابت.
# · `exit` هو رمز خروج العملية كما أعاده ويندوز (int32 موقّع).

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# اسم الفتحات الخاص بالمُقيِّمين — ميزانية منفصلة عن تطبيق المالك (حقيقة ٣).
$script:EvalSlotsName = 'HaramLite-Eval-Slots'

# الجذر الافتراضي للثنائي: شجرة المستودع الرئيس بجوار شجرة العمل هذه.
# (يعمل كذلك لمن يستنسخ المستودع وحده: `-Exe` أو `HARAMLITE_EVAL_EXE` يحلّانها.)
$script:EvalDefaultExeCandidates = @(
    (Join-Path $PSScriptRoot '..\..\..\haramlite-rs\src-tauri\target\release\HaramLite.exe'),
    (Join-Path $PSScriptRoot '..\..\src-tauri\target\release\HaramLite.exe')
)

function Get-EvalRepoRoot {
    <# جذر المستودع الذي يحوي `qa/eval` (وهو موضع `git rev-parse`). #>
    return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Fail-Eval {
    <# فشل بصوت عالٍ: رسالة مسمّاة على stderr ورمز خروج ≠ 0. لا نجاح فارغ. #>
    param(
        [Parameter(Mandatory)][string]$Message,
        [int]$Code = 2
    )
    [Console]::Error.WriteLine("✗ $Message")
    exit $Code
}

function Resolve-EvalExe {
    <#
      .SYNOPSIS حلّ الثنائي: `-Exe` ← `HARAMLITE_EVAL_EXE` ← الافتراضي في المستودع.
      .DESCRIPTION لا يبني شيئاً ولا يبحث في PATH: ثنائي مُصادَق عليه بالمسار والبصمة.
    #>
    param([string]$Exe)
    $candidates = @()
    if ($Exe) { $candidates += $Exe }
    if ($env:HARAMLITE_EVAL_EXE) { $candidates += $env:HARAMLITE_EVAL_EXE }
    $candidates += $script:EvalDefaultExeCandidates
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }
    Fail-Eval ("لا ثنائي HaramLite.exe. جُرِّب:`n  " + ($candidates -join "`n  ") +
        "`n  مرّر `-Exe <path>` أو اضبط HARAMLITE_EVAL_EXE. لا قياس بلا ثنائي.")
}

function Resolve-EvalFfmpeg {
    <#
      .SYNOPSIS ffmpeg المرفق بالمستودع (بلا شبكة وبلا PATH).
      .DESCRIPTION يبحث بجوار الثنائي في `bin/` ثم في `bin/` بشجرة العمل.
    #>
    param([Parameter(Mandatory)][string]$Exe)
    $exeDir = Split-Path -Parent $Exe
    $candidates = @(
        (Join-Path $exeDir 'bin\ffmpeg.exe'),
        (Join-Path $exeDir '..\..\..\bin\ffmpeg.exe'),
        (Join-Path (Get-EvalRepoRoot) 'bin\ffmpeg.exe')
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c -PathType Leaf) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }
    Fail-Eval ("لا ffmpeg.exe — لا مدخل حتمي، فلا قياس. جُرِّب:`n  " + ($candidates -join "`n  "))
}

function New-EvalSandbox {
    <#
      .SYNOPSIS بيئة تشغيل معزولة تحت %TEMP% لصفّ واحد.
      .DESCRIPTION يعيد كائناً بمسارات: Root · In (المدخل والمخرَج) · Data
      (`HARAMLITE_DATA_DIR`) · LocalAppData (مسار السجلّ فعلاً — حقيقة ٢) · Out
      (مجلد الأثر). يُنظَّف في البداية ويُبقى في النهاية ليُفتَّش عند الفشل.
    #>
    param([Parameter(Mandatory)][string]$Row)
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ("hl-eval\" + $Row)
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    $in = Join-Path $root 'in'
    $data = Join-Path $root 'data'
    $lad = Join-Path $root 'localappdata'
    $outDir = Join-Path (Get-EvalRepoRoot) 'qa\eval\out'
    foreach ($d in @($in, $data, $lad, $outDir)) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
    }
    return [pscustomobject]@{
        Row         = $Row
        Root        = $root
        In          = $in
        Data        = $data
        LocalAppData = $lad
        LogsDir     = Join-Path $lad 'com.harammute.haramlite\logs'
        OutDir      = $outDir
        Artifact    = Join-Path $outDir ($Row + '.json')
    }
}

function Invoke-HaramLite {
    <#
      .SYNOPSIS يشغّل الثنائي الحقيقي بوسائط، ويقيس الزمن ورمز الخروج.
      .DESCRIPTION البيئة المعزولة تُبنى صريحة **بلا وراثة** للثلاثة المحرّكة
      (`HARAMLITE_DATA_DIR` · `HARAMLITE_SLOTS_NAME` · `LOCALAPPDATA`) — فلا
      يتسرّب إعداد من الصدفة إلى القياس.
      الوسائط تُمرَّر عبر `ArgumentList` (‏.NET) لا كسلسلة: المسارات العربية
      وذات المسافات والأقواس المربّعة تصل كوسيط واحد بلا تقسيم (وهو ما يقيسه
      صفّ 3.8 أصلاً).
    #>
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][object]$Sandbox,
        [Parameter(Mandatory)][string[]]$Arguments,
        [int]$TimeoutMs = 300000
    )
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $Exe
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.WorkingDirectory = $Sandbox.In
    foreach ($a in $Arguments) { $psi.ArgumentList.Add($a) }
    $psi.EnvironmentVariables['HARAMLITE_DATA_DIR'] = $Sandbox.Data
    $psi.EnvironmentVariables['HARAMLITE_SLOTS_NAME'] = $script:EvalSlotsName
    $psi.EnvironmentVariables['LOCALAPPDATA'] = $Sandbox.LocalAppData

    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $null = $proc.Start()
    # القراءة غير المتزامنة تبدأ فوراً وإلا امتلأ الأنبوب وتعلّق الطفل.
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    $timedOut = -not $proc.WaitForExit($TimeoutMs)
    if ($timedOut) {
        try { $proc.Kill($true) } catch { }
        $null = $proc.WaitForExit(15000)
    }
    $sw.Stop()
    $proc.WaitForExit()
    $stdout = ''
    $stderr = ''
    try { $stdout = $outTask.GetAwaiter().GetResult() } catch { }
    try { $stderr = $errTask.GetAwaiter().GetResult() } catch { }
    $exit = if ($timedOut) { $null } else { $proc.ExitCode }
    $proc.Dispose()

    # سطر الأمر كما أُعطي حرفياً — يُكتب في الأثر ليُعاد إنتاجه بلا تخمين.
    $cmdline = ($Arguments | ForEach-Object { if ($_ -match '[\s\[\]]') { '"' + $_ + '"' } else { $_ } }) -join ' '
    return [pscustomobject]@{
        exit     = $exit
        timedOut = $timedOut
        wall_ms  = [int]$sw.ElapsedMilliseconds
        command  = ('"' + $Exe + '" ' + $cmdline).Trim()
        stdout   = $stdout
        stderr   = $stderr
    }
}

function Get-EvalLog {
    <#
      .SYNOPSIS نصّ سجلّ التشغيل المعزول ('' إن لم يُكتب سجلّ).
      .DESCRIPTION تقاطع الأسطر: `tracing_appender::rolling::daily` يكتب ملفاً
      واحداً لكل يوم باسم `haramlite.log.<YYYY-MM-DD>`.
    #>
    param([Parameter(Mandatory)][object]$Sandbox)
    if (-not (Test-Path -LiteralPath $Sandbox.LogsDir)) { return '' }
    $files = Get-ChildItem -LiteralPath $Sandbox.LogsDir -File -ErrorAction SilentlyContinue
    if (-not $files) { return '' }
    return (($files | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n")
}

function Get-EvalProvider {
    <# المنفّذ الفعّال كما نطق به السجلّ: CUDA · DirectML · CPU · '' إن لم يُذكر. #>
    param([Parameter(Mandatory)][string]$Log)
    if ($Log -match 'execution provider:\s*([A-Za-z]+)') { return $Matches[1] }
    return ''
}

function Get-EvalCudaDiagnosis {
    <# سطر تشخيص CUDA كما طُبع (يحمل العدّ 16/16 أو النقص بالاسم). #>
    param([Parameter(Mandatory)][string]$Log)
    $m = [regex]::Matches($Log, 'تشخيص CUDA: ([^\r\n|]+)')
    if ($m.Count -eq 0) { return '' }
    return $m[$m.Count - 1].Groups[1].Value.Trim()
}

function Get-EvalFileInfo {
    <# بايت + SHA-256 لملف مخرَج — المكافأة الرقمية المطلوبة. #>
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $Path
    $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    return [pscustomobject]@{
        path   = $item.FullName
        bytes  = [long]$item.Length
        sha256 = $hash
    }
}

function Get-EvalTreeInfo {
    <# بايت + SHA-256 لكل ملف تحت مجلد (مرتَّب بالمسار) — لمقارنة «ماذا أُنتج». #>
    param([Parameter(Mandatory)][string]$Dir)
    if (-not (Test-Path -LiteralPath $Dir)) { return @() }
    return @(Get-ChildItem -LiteralPath $Dir -Recurse -File |
        Sort-Object FullName |
        ForEach-Object { Get-EvalFileInfo -Path $_.FullName })
}

function New-EvalToneClip {
    <#
      .SYNOPSIS مدخل حتمي: مقطع صغير (فيديو + ستيريو نغمي) بلا شبكة.
      .DESCRIPTION «حتمي» = طول ونمط ثابتان **وبايتات ثابتة**: `-bitexact` يمنع
      كتابة طابع الإنشاء في الحاوية. النمط نغمات جيبية (موسيقي الكثافة) لا صمت،
      لأن بوابة الكثافة في `decide.rs` تتخطّى الفصل على مقطع رخو.
      الوسائط صريحة من المُقيِّم لا مخفيّة هنا.
    #>
    param(
        [Parameter(Mandatory)][string]$Ffmpeg,
        [Parameter(Mandatory)][string]$OutPath,
        [int]$Seconds = 3,
        [int]$Width = 160,
        [int]$Height = 120,
        [int]$Rate = 10,
        [int]$Tone1 = 440,
        [int]$Tone2 = 660
    )
    $dir = Split-Path -Parent $OutPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $ffArgs = @(
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', "sine=frequency=$Tone1`:duration=$Seconds",
        '-f', 'lavfi', '-i', "sine=frequency=$Tone2`:duration=$Seconds",
        '-f', 'lavfi', '-i', "testsrc=size=$Width`x$Height`:rate=$Rate`:duration=$Seconds",
        '-filter_complex', '[0:a][1:a]amerge=inputs=2[a]',
        '-map', '[a]', '-map', '2:v',
        '-c:v', 'mpeg4', '-q:v', '12', '-c:a', 'aac', '-b:a', '64k',
        '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
        '-shortest', $OutPath
    )
    & $Ffmpeg @ffArgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutPath)) {
        Fail-Eval "ffmpeg فشل في بناء المدخل الحتمي «$OutPath» (exit=$LASTEXITCODE)"
    }
}

function New-EvalSilentVideo {
    <# مدخل صفّ 3.3: فيديو بلا مسار صوتي أصلاً (`-an`). #>
    param(
        [Parameter(Mandatory)][string]$Ffmpeg,
        [Parameter(Mandatory)][string]$OutPath,
        [int]$Seconds = 3
    )
    & $Ffmpeg -hide_banner -loglevel error -y -f lavfi `
        -i "testsrc=size=160x120:rate=10:duration=$Seconds" `
        -an -c:v mpeg4 -q:v 12 `
        -fflags +bitexact -flags:v +bitexact `
        $OutPath 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutPath)) {
        Fail-Eval "ffmpeg فشل في بناء فيديو بلا صوت «$OutPath» (exit=$LASTEXITCODE)"
    }
}

function New-EvalEmptyFile {
    <# مدخل صفّ 3.1: ملف 0 بايت بالاسم المطلوب. #>
    param([Parameter(Mandatory)][string]$OutPath)
    $dir = Split-Path -Parent $OutPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllBytes($OutPath, [byte[]]@())
}

function New-EvalLinkOrCopy {
    <#
      .SYNOPSIS يضع ملفاً في مسار جديد برابط صلب، ويسقط إلى النسخ إن تعذّر.
      .DESCRIPTION الرابط الصلب فوري وبلا مساحة (نفس الحجم)، وهو ما يجعل بناء
      «مجلد تنفيذي مصنوع» لمُقيِّم 2.4 ممكناً بلا نسخ ≈1.5GB من مكتبات CUDA.
      ويعيد أيّهما وقع فعلاً — ليُكتب في الأثر لا ليُفترض.
    #>
    param(
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][string]$Path
    )
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    try {
        New-Item -ItemType HardLink -Path $Path -Target $Target -ErrorAction Stop | Out-Null
        return 'hardlink'
    } catch {
        Copy-Item -LiteralPath $Target -Destination $Path -Force
        return 'copy'
    }
}

function New-EvalAssert {
    <# حصيلة فحوص صفّ: ما مرّ وما سقط، ليُكتب كلاهما في الأثر بلا تجميل. #>
    return [pscustomobject]@{
        Pass = [System.Collections.Generic.List[string]]::new()
        Fail = [System.Collections.Generic.List[string]]::new()
    }
}

function Assert-Eval {
    <# يسجّل فحصاً واحداً: يمرّ أو يسقط، **ونصّه يحمل الرقم المقيس** لا الحكم وحده. #>
    param(
        [Parameter(Mandatory)][object]$A,
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Label
    )
    if ($Condition) { $A.Pass.Add($Label) } else { $A.Fail.Add($Label) }
}

function Format-EvalNotes {
    <# يبني خانة `notes`: المقيس، ثم ما لم يُقَس صراحةً، ثم الساقط إن وُجد. #>
    param(
        [Parameter(Mandatory)][object]$A,
        [string]$NotMeasured = ''
    )
    $parts = @()
    if ($A.Fail.Count -gt 0) { $parts += ('سقط: ' + ($A.Fail -join '؛ ')) }
    if ($A.Pass.Count -gt 0) { $parts += ('قيس ومرّ: ' + ($A.Pass -join '؛ ')) }
    if ($NotMeasured) { $parts += ('لم يُقَس: ' + $NotMeasured) }
    return ($parts -join ' | ')
}

function Get-EvalPeSubsystem {
    <#
      .SYNOPSIS النظام الفرعي في ترويسة PE: 2 = GUI (بلا نافذة كونسول) · 3 = CONSOLE.
      .DESCRIPTION يقيس «الإقلاع بلا نافذة كونسول» (صفّ 1.1) على الثنائي نفسه:
      يُقرأ `IMAGE_OPTIONAL_HEADER.Subsystem` من القرص بلا تشغيل.
    #>
    param([Parameter(Mandatory)][string]$Path)
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $br = [System.IO.BinaryReader]::new($fs)
        $fs.Position = 0x3C
        $peOffset = $br.ReadInt32()
        $fs.Position = $peOffset
        if ($br.ReadUInt32() -ne 0x00004550) { return -1 }   # 'PE\0\0'
        $fs.Position = $peOffset + 24 + 68                    # OptionalHeader.Subsystem
        return $br.ReadUInt16()
    } finally { $fs.Dispose() }
}

function Get-EvalLogFileInfo {
    <#
      .SYNOPSIS ملف السجلّ نفسه كدليل (بايت + SHA-256)، أو null إن لم يُكتب.
      .DESCRIPTION الصفوف السلبية (3.1 · 3.3) لا تُنتج ملف ناتج **عن قصد** — ومنتجها
      الحقيقي هو **الرفض**. وشاهد الرفض هو ملف السجلّ الذي كتبته العملية فعلاً:
      ملف حقيقي على القرص ببايت وبصمة، لا ادّعاء في نصّ. فـ`outputs` في أثر تلك
      الصفوف تحمل السجلّ، و`product_outputs` تحمل `[]` صريحةً. الاتفاق موثَّق في
      رأس `scripts/matrix-check.cjs` وفي `qa/eval/README.md`.
    #>
    param([Parameter(Mandatory)][object]$Sandbox)
    if (-not (Test-Path -LiteralPath $Sandbox.LogsDir)) { return $null }
    $f = Get-ChildItem -LiteralPath $Sandbox.LogsDir -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1
    if (-not $f) { return $null }
    return (Get-EvalFileInfo -Path $f.FullName)
}

function Get-EvalGitInfo {
    <# commit = git rev-parse HEAD في شجرة المُقيِّم · dirty = هل الشجرة غير نظيفة. #>
    $repo = Get-EvalRepoRoot
    $commit = (& git -C $repo rev-parse HEAD 2>$null | Select-Object -First 1)
    if (-not $commit) { $commit = '' } else { $commit = $commit.Trim() }
    $porcelain = (& git -C $repo status --porcelain 2>$null | Out-String).Trim()
    return [pscustomobject]@{ commit = $commit; dirty = [bool]($porcelain -ne '') }
}

function Write-EvalArtifact {
    <#
      .SYNOPSIS يكتب أثر JSON في `qa/eval/out/<رقم>.json` ويطبع سطراً واحداً.
      .DESCRIPTION الحقول الإلزامية في العقد: row · commit · dirty · app_version ·
      exe_sha256 · command · exit · wall_ms · outputs · verdict · notes. وما زاد
      عليها (provider · log_tail · sandbox …) دليلٌ إضافي لا يغيّر الحكم.
      الكتابة بـUTF-8 **بلا BOM** كي يقرأه `JSON.parse` في Node مباشرة.
    #>
    param(
        [Parameter(Mandatory)][object]$Sandbox,
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][object]$Run,
        [Parameter(Mandatory)][AllowEmptyCollection()][array]$Outputs,
        [Parameter(Mandatory)][ValidateSet('pass', 'fail')][string]$Verdict,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Notes,
        [string]$Provider = '',
        [string]$AppVersion = '',
        [string]$ExeSha256 = '',
        [hashtable]$Extra = @{}
    )
    $git = Get-EvalGitInfo
    if (-not $AppVersion) {
        try { $AppVersion = (Get-Item -LiteralPath $Exe).VersionInfo.FileVersion } catch { $AppVersion = '' }
        if (-not $AppVersion) { $AppVersion = 'غير متوفّر' }
    }
    if (-not $ExeSha256) {
        try { $ExeSha256 = (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash } catch { $ExeSha256 = '' }
    }
    $outList = @()
    foreach ($o in $Outputs) {
        if ($null -eq $o) { continue }
        $outList += [ordered]@{ path = $o.path; bytes = $o.bytes; sha256 = $o.sha256 }
    }
    $rec = [ordered]@{
        row         = $Sandbox.Row
        commit      = $git.commit
        dirty       = $git.dirty
        app_version = $AppVersion
        exe_sha256  = $ExeSha256
        command     = $Run.command
        exit        = $Run.exit
        wall_ms     = $Run.wall_ms
        outputs     = $outList
        verdict     = $Verdict
        notes       = $Notes
        provider    = $Provider
        exe         = $Exe
        sandbox     = $Sandbox.Root
    }
    foreach ($k in $Extra.Keys) { $rec[$k] = $Extra[$k] }

    $json = $rec | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($Sandbox.Artifact, $json, [System.Text.UTF8Encoding]::new($false))

    $bytes = 0
    foreach ($o in $outList) { $bytes += [long]$o.bytes }
    $shaShort = if ($outList.Count -gt 0) { $outList[0].sha256.Substring(0, 12) } else { '-' }
    $prov = if ($Provider) { $Provider } else { '—' }
    $line = "{0}  {1}  exit={2}  wall={3}ms  outputs={4} ({5} B)  sha={6}  provider={7}" -f `
        $Sandbox.Row, $Verdict, $Run.exit, $Run.wall_ms, $outList.Count, $bytes, $shaShort, $prov
    # `Write-Host` لا `Write-Output`: المستدعي يكتب `$null = Write-EvalArtifact …`
    # فيبتلع مجرى المخرجات كلّه — وقد وقع فعلاً (ثلاثة مُقيِّمات طُبعت صامتة).
    Write-Host $line
    if ($Verdict -ne 'pass') { Write-Host ("  السبب: " + $Notes) }
    return ($Verdict -eq 'pass')
}

function Complete-Eval {
    <# يختم المُقيِّم: 0 إن نجح، 1 إن فشل القياس (والأثر مكتوب في الحالتين). #>
    param([Parameter(Mandatory)][bool]$Ok, [Parameter(Mandatory)][object]$Sandbox)
    if ($Ok) { exit 0 }
    [Console]::Error.WriteLine("✗ فشل المُقيِّم — الأثر: " + $Sandbox.Artifact)
    exit 1
}
