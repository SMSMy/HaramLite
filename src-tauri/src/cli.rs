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

const VERSION: &str = env!("CARGO_PKG_VERSION");

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
}

fn print_help() {
    println!(
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
  -h, --help         هذه الشاشة
  -V, --version      رقم الإصدار

أمثلة:
  haramlite song.mp4 -m song
  haramlite a.wav b.wav -m clip --out ./cleaned
  haramlite --probe weird.mp4"
    );
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
            "--video" => o.video = true,
            "--video-h" => {
                i += 1;
                let v = args.get(i).ok_or("--video-h يحتاج رقماً (مثل 720)")?.clone();
                o.video_height =
                    Some(v.parse().map_err(|_| format!("ارتفاع غير صالح: {v}"))?);
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
            println!("صوت: {} ({})", info.has_audio, info.audio_codec.clone().unwrap_or_default());
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
        println!("{mark} {name} {}", if detail.is_empty() { "" } else { &detail });
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
            pipeline::OutKind::Video { max_height: o.video_height }
        } else {
            pipeline::OutKind::Audio { fmt: o.format }
        };
        match pipeline::process_file(path, &out_dir, o.mode, kind, o.keep_both || o.keep_inst_only, !o.keep_inst_only, false, None, &|p| {
            let pct = (p * 100.0) as u32;
            if pct > last_pct.get() + 4 {
                last_pct.set(pct);
                eprint!("\r  [{:>3}%]", pct.min(100));
            }
            true
        }, &|_, _| {}) {
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
    let opts = match parse_args(args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("خطأ: {e}\n");
            print_help();
            return 2;
        }
    };

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
        return if updated || msg.contains("محدّث") { 0 } else { 1 };
    }
    if let Some(url) = &opts.url {
        let out_dir = opts.out_dir.clone().unwrap_or_else(|| ".".into());
        eprintln!("▶ تنزيل: {url}");
        match crate::yt_dlp::download_media(url, Path::new(&out_dir), &|p| {
            eprint!("\r  [{:>3}%]", (p * 100.0) as u32);
            true
        }) {
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
