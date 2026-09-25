//! Headless CLI mode — same binary, no GUI, exit-code driven.
//!
//! ```text
//! haramlite <files...> [-m song|clip] [--out DIR] [--both|--inst-only] [--fmt flac|mp3|wav]
//! haramlite --probe FILE
//! haramlite --check
//! haramlite --version
//! ```

use std::path::Path;
use std::time::Instant;

use crate::pipeline::{self, Mode};
use crate::slots;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// ن-٣: قيمة `--provider` كما كُتبت على سطر الأوامر.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderFlag {
    Cuda,
    Dml,
    Cpu,
}

impl ProviderFlag {
    fn parse(v: &str) -> Option<Self> {
        match v.to_ascii_lowercase().as_str() {
            "cuda" => Some(Self::Cuda),
            // `directml` مقبول كمرادف لأن الاسم في السجلّ و`provider.json`
            // كذلك — والخطأ في قيمة صحيحة أسوأ من قبول مرادف.
            "dml" | "directml" => Some(Self::Dml),
            "cpu" => Some(Self::Cpu),
            _ => None,
        }
    }

    fn forced(self) -> crate::cuda_runtime::ForcedChain {
        match self {
            Self::Cuda => crate::cuda_runtime::ForcedChain::Cuda,
            Self::Dml => crate::cuda_runtime::ForcedChain::Dml,
            Self::Cpu => crate::cuda_runtime::ForcedChain::Cpu,
        }
    }
}

/// يحوّل (‏`--cuda`، `--provider`) إلى: هل تُجرَّب CUDA؟ وما الفرض الصريح؟
///
/// **قاعدة التوافق**: غياب العَلَم = السلوك الحالي حرفياً — `(cuda_flag, None)`.
/// و`--provider` أكثر تحديداً فيسبق `--cuda` عند اجتماعهما (لا خطأ: الطلب
/// الأصرح يفوز، ويُطبع في السجلّ ما فاز).
fn resolve_provider(
    cuda_flag: bool,
    provider: Option<ProviderFlag>,
) -> (bool, Option<crate::cuda_runtime::ForcedChain>) {
    match provider {
        Some(p) => (p == ProviderFlag::Cuda, Some(p.forced())),
        None => (cuda_flag, None),
    }
}

struct CliOpts {
    files: Vec<String>,
    mode: Mode,
    out_dir: Option<String>,
    keep_both: bool,
    keep_inst_only: bool,
    probe: Option<String>,
    check: bool,
    format: pipeline::OutFormat,
    video: bool,
    video_height: Option<u32>,
    url: Option<String>,
    update_ytdlp: bool,
    /// ROADMAP §٧.ب بند ٩: طلب CUDA من سطر الأوامر، ليكون مسار السقوط
    /// (CUDA ← DirectML ← CPU) قابلاً للاختبار بلا واجهة.
    cuda: bool,
    /// ن-٣: فرض سلسلة المزوّد صراحةً (`--provider cuda|dml|cpu`). `None` = لا
    /// فرض ⇒ السلوك الحالي حرفياً. و`cpu` هو ما كان معطَّلاً: تعطيل CUDA
    /// وDirectML معاً لقياس مسار CPU على جهاز فيه كرت (صفّ المصفوفة 2.2).
    provider: Option<ProviderFlag>,
}

/// نصّ شاشة المساعدة — **دالة** لا `println!` مباشر، كي يقيسها اختبار
/// (`help_mentions_the_provider_flag`) على النصّ نفسه الذي يراه المستخدم، لا على
/// نسخةٍ منه في المصدر.
fn help_text() -> String {
    format!(
        "HaramLite v{VERSION} — إزالة الموسيقى بالذكاء الاصطناعي (Rust)

الاستخدام:
  haramlite [الملفات...] [خيارات]

الأوضاع:
  -m song            وضع الأغاني: فصل + مؤثرات + قص صمت   (المؤثرات: M3)
  -m clip            وضع المقطع: إزالة موسيقى فقط

الخيارات:
  --out DIR          مجلد الإخراج (افتراضي: بجانب الملف)
  --both             الاحتفاظ بملف الموسيقى أيضاً (الافتراضي: غناء فقط)
  --inst-only        حفظ الموسيقى فقط
  --probe FILE       فحص ملف وطباعة تصنيفه ثم الخروج
  --check            فحص صحة الأدوات والنموذج ثم الخروج
  --cuda             محاولة تسريع CUDA أولاً (تسقط إلى DirectML ثم CPU تلقائياً)
  --provider P       فرض سلسلة المزوّد: cuda (‏CUDA ثم DirectML ثم CPU) · dml (‏DirectML ثم CPU)
                     · cpu (‏CPU وحده — لا تُجرَّب CUDA ولا DirectML؛ لقياس مسار المعالج على جهاز فيه كرت)
                     غياب العَلَم = السلوك الافتراضي (‏--cuda وحده يقرّر)، و`--provider` يسبقه إن اجتمعا
  -h, --help         هذه الشاشة
  -V, --version      رقم الإصدار

أمثلة:
  haramlite song.mp4 -m song
  haramlite a.wav b.wav -m clip --out ./cleaned
  haramlite --probe weird.mp4"
    )
}

fn print_help() {
    println!("{}", help_text());
}

fn parse_args(args: &[String]) -> Result<CliOpts, String> {
    let mut o = CliOpts {
        files: vec![],
        mode: Mode::Song,
        out_dir: None,
        keep_both: false,
        keep_inst_only: false,
        probe: None,
        check: false,
        format: pipeline::OutFormat::Flac,
        video: false,
        video_height: None,
        url: None,
        update_ytdlp: false,
        cuda: false,
        provider: None,
    };

    let mut i = 0usize;
    while i < args.len() {
        let a = &args[i];
        match a.as_str() {
            "-m" | "--mode" => {
                i += 1;
                let v = args.get(i).ok_or("‏-m يحتاج قيمة song أو clip")?;
                o.mode = Mode::parse(v).ok_or_else(|| format!("وضع غير معروف: {v}"))?;
            }
            "--out" | "-o" => {
                i += 1;
                o.out_dir = Some(args.get(i).ok_or("--out يحتاج مساراً")?.clone());
            }
            "--both" => o.keep_both = true,
            "--inst-only" => o.keep_inst_only = true,
            "--probe" => {
                i += 1;
                o.probe = Some(args.get(i).ok_or("--probe يحتاج مساراً")?.clone());
            }
            "--check" => o.check = true,
            "-u" | "--url" => {
                i += 1;
                o.url = Some(args.get(i).ok_or("-u يحتاج رابطاً")?.clone());
            }
            "--update-ytdlp" => o.update_ytdlp = true,
            "--cuda" => o.cuda = true,
            "--provider" => {
                i += 1;
                let v = args.get(i).ok_or("--provider يحتاج قيمة cuda|dml|cpu")?;
                o.provider = Some(
                    ProviderFlag::parse(v)
                        .ok_or_else(|| format!("مزوّد غير معروف: {v} (المسموح cuda|dml|cpu)"))?,
                );
            }
            "--video" => o.video = true,
            "--video-h" => {
                i += 1;
                let v = args.get(i).ok_or("--video-h يحتاج رقماً (مثل 720)")?.clone();
                o.video_height = Some(v.parse().map_err(|_| format!("ارتفاع غير صالح: {v}"))?);
            }
            "--fmt" => {
                i += 1;
                let v = args.get(i).ok_or("--fmt يحتاج wav|flac|mp3")?.clone();
                o.format = pipeline::OutFormat::parse(&v)
                    .ok_or_else(|| format!("صيغة غير معروفة: {v}"))?;
            }
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("HaramLite v{VERSION}");
                std::process::exit(0);
            }
            other if other.starts_with('-') => return Err(format!("خيار غير معروف: {other}")),
            other => o.files.push(other.to_string()),
        }
        i += 1;
    }
    Ok(o)
}

fn run_probe(path: &str) -> i32 {
    match crate::media::probe(Path::new(path)) {
        Ok(info) => {
            println!("الحاوية: {}", info.container);
            println!("المدة: {:.2}s", info.duration_secs);
            println!(
                "صوت: {} ({})",
                info.has_audio,
                info.audio_codec.clone().unwrap_or_default()
            );
            println!("فيديو حقيقي: {}", info.has_video);
            if info.audio_disguised_as_video {
                println!("⚠ صوت متنكّر في حاوية فيديو — سيُعامل كصوت");
            }
            if info.video_is_cover_art {
                println!("ℹ فيديو = صورة غلاف فقط");
            }
            0
        }
        Err(e) => {
            eprintln!("فشل الفحص: {e}");
            1
        }
    }
}

fn run_check() -> i32 {
    let rows = pipeline::health_check().unwrap_or_default();
    let mut bad = false;
    for (name, ok, detail) in rows {
        let mark = if ok { "✓" } else { "✗" };
        if !ok {
            bad = true;
        }
        println!(
            "{mark} {name} {}",
            if detail.is_empty() { "" } else { &detail }
        );
    }
    if bad {
        1
    } else {
        println!("كل المكوّنات جاهزة.");
        0
    }
}

fn run_files(o: &CliOpts) -> i32 {
    if o.files.is_empty() {
        eprintln!("لا توجد ملفات. استخدم --help");
        return 1;
    }

    let total = Instant::now();
    let mut failed = Vec::new();

    for f in &o.files {
        let path = Path::new(f);
        if !path.is_file() {
            eprintln!("✗ غير موجود: {f}");
            failed.push(f.clone());
            continue;
        }

        let out_dir = match &o.out_dir {
            Some(d) => std::path::PathBuf::from(d),
            None => path.parent().map(|p| p.to_path_buf()).unwrap_or_default(),
        };

        eprintln!("▶ معالجة: {f} (وضع: {:?})", o.mode);
        let t0 = Instant::now();
        let last_pct = std::cell::Cell::new(0u32);

        let kind = if o.video {
            pipeline::OutKind::Video {
                max_height: o.video_height,
            }
        } else {
            pipeline::OutKind::Audio { fmt: o.format }
        };
        // م١: CLI عملية منفصلة، وهي بالضبط ما يجعل محدِّداً داخل العملية
        // بلا قيمة — فالفتحة هنا mutex نواة يراه التطبيق أيضاً.
        //
        // **ولا سطر «بانتظار فتحة فصل…» هنا**: كان يُطبع **قبل** الطلب دائماً
        // فيكذب على مهمّة أخذت الفتحة فوراً (قِيس: مهمّة حرّة انتهت في 433ms
        // وطُبع السطر). والإعلان الصادق يأتي من طبقة الفتحات وحدها
        // (`slots::run_registered_with`) **حين يقع انتظار فعلي**، ومعه زمن
        // الانتظار المقيس؛ وهو يصل شاشة CLI عبر طبقة `stderr` التي ينصبها
        // `logging::init_cli` (هدف `slots` عند مستوى `info`).
        //
        // ## **حدّ معلَن: لا وسيلة إلغاء خارجية لمسار CLI (م٢/إصلاح — بند ٦ب)**
        //
        // `slots::run_separation` تُنشئ رمز إلغاء داخلياً وتملأ السِجلّ (فتظهر
        // المهمّة في `active_jobs` بوسم `cli`)، لكن **لا واجهة ولا بوت يستطيع
        // الوصول إليها**: `cancel_job` يحتاج معرّف المهمّة، ولا قناة بين عملية
        // CLI وهذه العملية. فالنتيجة العملية: **`Ctrl+C` في الطرفية هو الإلغاء
        // الوحيد**، وهو يقتل العملية كلها (بلا `Drop` ⇒ يبقى القفل حتى يفحصه
        // مسترجع لاحق ⇒ الاسترجاع يعمل بعد الإصلاح الأوّل في م٢).
        //
        // **ولماذا لا يُضاف الآن**: يحتاج قناة تحكّم (منفذ/أنبوب/ملف أوامر)
        // — وهي **سطح هجوم جديد** وتغيير سلوك لم يُطلب. فالتوثيق هنا صادق،
        // والبديل المعلَن لمن يريد الإلغاء: الواجهة أو تلغرام (`/kill`)، أو
        // إشارة النظام على العملية.
        match slots::run_separation(
            "cli",
            path,
            &out_dir,
            o.mode,
            kind,
            o.keep_both || o.keep_inst_only,
            !o.keep_inst_only,
            o.cuda,
            &|p| {
                let pct = (p * 100.0) as u32;
                if pct > last_pct.get() + 4 {
                    last_pct.set(pct);
                    eprint!("\r  [{:>3}%]", pct.min(100));
                }
                true
            },
            &|_, _| {},
        ) {
            Ok(out) => {
                eprintln!("\r  [100%] تم في {:.1}s", t0.elapsed().as_secs_f32());
                if !o.keep_inst_only {
                    if let Some(voc) = &out.vocals {
                        println!("🎤:     {}", voc.display());
                    }
                }
                if let Some(inst) = &out.instrumental {
                    println!("موسيقى:   {}", inst.display());
                }
                if let Some(vid) = &out.video {
                    println!("فيديو:    {}", vid.display());
                }
            }
            Err(e) => {
                eprintln!("\r✗ فشلت المعالجة: {e}");
                failed.push(f.clone());
            }
        }
    }

    let code = if failed.is_empty() { 0 } else { 1 };
    if o.files.len() > 1 || !failed.is_empty() {
        println!(
            "\nالنتيجة: {}/{} نجح",
            o.files.len() - failed.len(),
            o.files.len()
        );
    }
    let _ = total.elapsed();
    code
}

/// CLI entrypoint — returns process exit code.
/// (Logging is initialized by lib::cli_entry before calling us.)
pub fn entry(args: &[String]) -> i32 {
    let mut opts = match parse_args(args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("خطأ: {e}\n");
            print_help();
            return 2;
        }
    };

    // ن-٣: الفرض يُحلّ مرة واحدة هنا ثم **يُثبَّت في العملية** قبل أي خيط وقبل
    // أي فصل. و`opts.cuda` يصير القيمة الفعّالة (لا العلم الخام) فيمرّ إلى
    // `slots::run_separation` بالوسيط نفسه وبالمعنى نفسه كما كان حرفياً.
    let (use_cuda, forced) = resolve_provider(opts.cuda, opts.provider);
    crate::cuda_runtime::set_forced_chain(forced);
    opts.cuda = use_cuda;

    if let Some(p) = &opts.probe {
        return run_probe(p);
    }
    if opts.check {
        return run_check();
    }
    if opts.update_ytdlp {
        let (updated, msg) = crate::yt_dlp::ensure_updated(true, &|p| {
            eprint!("\r  تنزيل [{:>3}%]", (p * 100.0) as u32);
        });
        eprintln!();
        println!("{msg}");
        return if updated || msg.contains("محدّث") {
            0
        } else {
            1
        };
    }
    if let Some(url) = &opts.url {
        let out_dir = opts.out_dir.clone().unwrap_or_else(|| ".".into());
        eprintln!("▶ تنزيل: {url}");
        let never_cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        match crate::yt_dlp::download_media(
            url,
            Path::new(&out_dir),
            &|p| {
                eprint!("\r  [{:>3}%]", (p * 100.0) as u32);
                true
            },
            &never_cancel,
            crate::yt_dlp::Source::Local,
        ) {
            Ok(path) => {
                eprintln!("\r  [100%]");
                println!("تم التنزيل: {}", path.display());
                // auto-fill: process it right away with the chosen mode
                let path2 = path.clone();
                let o2 = CliOpts {
                    files: vec![path2.to_string_lossy().into_owned()],
                    mode: opts.mode,
                    out_dir: opts.out_dir.clone(),
                    ..opts
                };
                return run_files(&o2);
            }
            Err(e) => {
                eprintln!("✗ فشل التنزيل: {e}");
                return 1;
            }
        }
    }
    run_files(&opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    /// **قاعدة التوافق**: غياب `--provider` = السلوك الحالي حرفياً — `--cuda`
    /// وحده يقرّر، ولا فرض. لو صار الغياب يفرض شيئاً لسقط هذا الاختبار.
    #[test]
    fn provider_flag_absent_keeps_todays_behaviour() {
        assert_eq!(resolve_provider(false, None), (false, None));
        assert_eq!(resolve_provider(true, None), (true, None));
    }

    /// **مُفسَد**: الفرض لكل قيمة يقود إلى سلسلته — و`cpu` هي الحالة التي كانت
    /// متعذّرة (لا وسيلة لتعطيل CUDA وDirectML معاً).
    #[test]
    fn provider_flag_forces_the_named_chain() {
        use crate::cuda_runtime::ForcedChain;
        assert_eq!(
            resolve_provider(false, Some(ProviderFlag::Cuda)),
            (true, Some(ForcedChain::Cuda))
        );
        assert_eq!(
            resolve_provider(true, Some(ProviderFlag::Cuda)),
            (true, Some(ForcedChain::Cuda))
        );
        assert_eq!(
            resolve_provider(false, Some(ProviderFlag::Dml)),
            (false, Some(ForcedChain::Dml))
        );
        // `--cuda --provider cpu`: الأصرح يفوز — و`use_cuda=false` أي أن CUDA
        // لا تُجرَّب أصلاً (فرق مقيس عن `--cuda` وحده).
        assert_eq!(
            resolve_provider(true, Some(ProviderFlag::Cpu)),
            (false, Some(ForcedChain::Cpu))
        );
        assert_eq!(
            resolve_provider(false, Some(ProviderFlag::Cpu)),
            (false, Some(ForcedChain::Cpu))
        );
    }

    /// التحليل: القيم الثلاث تُقبل (و`directml` مرادف)، وغيرها يُرفض برسالة
    /// تسمّي المسموح — لا سقوط صامت إلى الافتراضي.
    #[test]
    fn provider_values_are_parsed_and_bad_ones_refused() {
        assert_eq!(ProviderFlag::parse("cuda"), Some(ProviderFlag::Cuda));
        assert_eq!(ProviderFlag::parse("DML"), Some(ProviderFlag::Dml));
        assert_eq!(ProviderFlag::parse("directml"), Some(ProviderFlag::Dml));
        assert_eq!(ProviderFlag::parse("CPU"), Some(ProviderFlag::Cpu));
        assert_eq!(ProviderFlag::parse("gpu"), None);
        assert_eq!(ProviderFlag::parse(""), None);

        let o = parse_args(&args(&["--provider", "cpu", "a.mp4"])).expect("--provider cpu يُقبل");
        assert_eq!(o.provider, Some(ProviderFlag::Cpu));
        assert_eq!(o.files, vec!["a.mp4".to_string()]);

        // بلا قيمة، وبقيمة غير معروفة: كلاهما خطأ صريح (لا افتراضي صامت).
        assert!(parse_args(&args(&["--provider"])).is_err());
        let err = if let Err(e) = parse_args(&args(&["--provider", "tpu"])) {
            e
        } else {
            panic!("--provider tpu يجب أن يُرفض — لا سقوط صامت إلى الافتراضي");
        };
        assert!(err.contains("tpu"), "الرسالة تسمّي القيمة: {err}");
        assert!(err.contains("cuda|dml|cpu"), "وتسمّي المسموح: {err}");
    }

    /// الخطاف كما يراه المستخدم: `--help` يعلن العَلَم وقيمه الثلاث، ويعلن أن
    /// غيابه = السلوك الافتراضي. (النصّ المقيس هو نصّ `help_text()` نفسه الذي
    /// يُطبع — لا نسخةً منه في المصدر.)
    #[test]
    fn help_mentions_the_provider_flag() {
        let help = help_text();
        let at = help
            .find("--provider P")
            .expect("العَلَم --provider في شاشة المساعدة");
        // كتلة العَلَم ثلاثة أسطر (القيم الثلاث موزّعة عليها) — تُقاس ككثلة واحدة.
        let block = help[at..].lines().take(3).collect::<Vec<_>>().join(" ");
        for v in ["cuda", "dml", "cpu"] {
            assert!(block.contains(v), "القيمة {v} معلَنة في --help: {block}");
        }
        assert!(
            help.contains("غياب العَلَم = السلوك الافتراضي"),
            "التوافق معلَن في الشاشة (غياب العَلَم لا يغيّر شيئاً)"
        );
        // ولا يدّعي العَلَم ما ليس فيه: الأسماء الحقيقية للمزوّدين مذكورة.
        for name in ["CUDA", "DirectML", "CPU"] {
            assert!(help.contains(name), "الاسم {name} مذكور");
        }
    }
}
