//! M1 — media pipeline: probe, classify, repair, extract, normalize.
//!
//! All functions are pure path-in/path-out so they are unit-testable without
//! a running Tauri app; thin `#[tauri::command]` wrappers live in lib.rs.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Pixel format pinned on every encoder: `h264_mf` accepts only
/// `nv12/yuv420p/d3d11`, and while ffmpeg does insert the conversion on its own,
/// stating it keeps the output format a decision rather than a property of
/// whatever the source happened to be.
const MP4_PIX_FMT: &str = "yuv420p";

/// The byte budget for [`transcode_to_bitrate`], derived once from the target
/// video bitrate so the arithmetic lives in one place (and is unit-tested):
/// 1.5× headroom on peaks, 3× buffer. Constant quality has no place here —
/// this path exists to land a file under a messaging cap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BitrateBudget {
    pub bitrate: String,
    pub maxrate: String,
    pub bufsize: String,
}

impl BitrateBudget {
    pub fn from_video_kbps(video_kbps: u32) -> Self {
        Self {
            bitrate: format!("{}k", video_kbps.max(1)),
            maxrate: format!("{}k", (video_kbps as f64 * 1.5) as u32),
            bufsize: format!("{}k", (video_kbps as f64 * 3.0) as u32),
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct MediaInfo {
    pub container: String,
    pub duration_secs: f64,
    pub has_audio: bool,
    pub has_video: bool,
    /// Video stream that is really a cover image (mp3 with album art etc.).
    pub video_is_cover_art: bool,
    /// "Weird file" repair verdict: video container that carries audio only.
    pub audio_disguised_as_video: bool,
    pub audio_codec: Option<String>,
    pub video_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
}

#[derive(Debug)]
pub enum MediaError {
    ToolMissing(String),
    SpawnFailed(String),
    InvalidOutput(String),
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ToolMissing(t) => write!(f, "أداة مفقودة: {t} — ضعها في مجلد bin بجانب التطبيق"),
            Self::SpawnFailed(e) => write!(f, "فشل تشغيل العملية: {e}"),
            Self::InvalidOutput(e) => write!(f, "مخرجات غير صالحة: {e}"),
        }
    }
}

impl std::error::Error for MediaError {}

/// Resolve bundled tools. Order: env override → exe_dir/bin → project bin.
pub fn resolve_tool(tool: &str) -> Result<PathBuf, MediaError> {
    let exe_name = if cfg!(windows) { format!("{tool}.exe") } else { tool.to_string() };

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = std::env::var("HARAMLITE_TOOLS_DIR") {
        candidates.push(PathBuf::from(dir).join(&exe_name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("bin").join(&exe_name));
            // dev layout: src-tauri/target/debug → walk up to project bin/
            for ancestor in parent.ancestors().skip(1) {
                candidates.push(ancestor.join("bin").join(&exe_name));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("bin").join(&exe_name));
        candidates.push(cwd.join("../bin").join(&exe_name));
    }

    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }
    Err(MediaError::ToolMissing(tool.to_string()))
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn make_cmd<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd
}

fn run_tool(tool_path: &Path, args: &[&str]) -> Result<String, MediaError> {
    let out = make_cmd(tool_path)
        .args(args)
        .output()
        .map_err(|e| MediaError::SpawnFailed(e.to_string()))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&out.stderr).into_owned();
    }
    Ok(text)
}

#[derive(Default)]
struct StreamLite {
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    pix_fmt: Option<String>,
    disposition_attached_pic: bool,
    width: Option<u32>,
    height: Option<u32>,
    sample_rate: Option<u32>,
    channels: Option<u32>,
}

/// Minimal ffprobe JSON reader — only the fields we actually need.
fn parse_ffprobe_json(json: &str) -> Result<(String, f64, Vec<StreamLite>), MediaError> {
    use serde_json::Value;
    let v: Value = serde_json::from_str(json)
        .map_err(|e| MediaError::InvalidOutput(format!("ffprobe json: {e}")))?;

    let format_name = v["format"]["format_name"].as_str().unwrap_or_default().to_string();
    let duration_secs = v["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| v["format"]["duration"].as_f64())
        .unwrap_or(0.0);

    let mut streams = Vec::new();
    if let Some(arr) = v["streams"].as_array() {
        for s in arr {
            streams.push(StreamLite {
                codec_type: s["codec_type"].as_str().map(str::to_string),
                codec_name: s["codec_name"].as_str().map(str::to_string),
                profile: s["profile"].as_str().map(str::to_string),
                pix_fmt: s["pix_fmt"].as_str().map(str::to_string),
                disposition_attached_pic: s["disposition"]["attached_pic"].as_i64() == Some(1),
                width: s["width"].as_u64().map(|w| w as u32),
                height: s["height"].as_u64().map(|h| h as u32),
                sample_rate: s["sample_rate"].as_str().and_then(|r| r.parse().ok()),
                channels: s["channels"].as_u64().map(|c| c as u32),
            });
        }
    }
    Ok((format_name, duration_secs, streams))
}

/// Probe + classify any input, including the "weird file" verdicts:
/// - audio inside a video container (`audio_disguised_as_video`)
/// - video stream that is merely cover art (`video_is_cover_art`)
pub fn probe(input: &Path) -> Result<MediaInfo, MediaError> {
    let ffprobe = resolve_tool("ffprobe")?;
    let input_str = input.to_string_lossy().into_owned();
    let json = run_tool(
        &ffprobe,
        &["-v", "error", "-print_format", "json", "-show_format", "-show_streams", &input_str],
    )?;

    let (container, duration_secs, streams) = parse_ffprobe_json(&json)?;

    let audio = streams.iter().find(|s| s.codec_type.as_deref() == Some("audio"));
    let videos: Vec<&StreamLite> =
        streams.iter().filter(|s| s.codec_type.as_deref() == Some("video")).collect();
    let real_videos: Vec<&&StreamLite> =
        videos.iter().filter(|v| !v.disposition_attached_pic).collect();

    // "Weird file": audio-only content inside a *video* container.
    let video_containers = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "ts", "flv"];
    let container_name = container.to_ascii_lowercase();
    let container_is_video = video_containers.iter().any(|c| container_name.contains(c))
        || video_containers.contains(&ext_lower(input).as_str());

    Ok(MediaInfo {
        container,
        duration_secs,
        has_audio: audio.is_some(),
        has_video: !real_videos.is_empty(),
        video_is_cover_art: !videos.is_empty() && real_videos.is_empty(),
        audio_disguised_as_video: audio.is_some() && real_videos.is_empty() && container_is_video,
        audio_codec: audio.and_then(|a| a.codec_name.clone()),
        video_codec: real_videos.first().and_then(|v| v.codec_name.clone()),
        width: real_videos.first().and_then(|v| v.width),
        height: real_videos.first().and_then(|v| v.height),
        sample_rate: audio.and_then(|a| a.sample_rate),
        channels: audio.and_then(|a| a.channels),
    })
}

fn ext_lower(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Always produce the clean 44.1 kHz stereo WAV the separation engine
/// consumes, whatever mess came in (drops fake/cover video streams).
/// (Exercised by tests; the pipeline uses [`normalize_for_engine_limited`].)
#[cfg(test)]
pub fn normalize_for_engine(input: &Path, work_dir: &Path) -> Result<PathBuf, MediaError> {
    normalize_for_engine_limited(input, work_dir, None)
}

/// Same as [`normalize_for_engine`] but optionally truncated to the first
/// `max_seconds` of audio (Sprint B1 — quick preview). The ffmpeg `-t`
/// limit sits before the output argument so only the head is decoded.
pub fn normalize_for_engine_limited(
    input: &Path,
    work_dir: &Path,
    max_seconds: Option<f32>,
) -> Result<PathBuf, MediaError> {
    let ffmpeg = resolve_tool("ffmpeg")?;
    std::fs::create_dir_all(work_dir).map_err(|e| MediaError::SpawnFailed(e.to_string()))?;
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "input".into());
    // Functional gap: scratch must be recognizable as ours — the old
    // `normalized_*` name passed the watch folder's `candidate_ok` filter,
    // so a killed run's leftovers were reprocessed as fresh inputs.
    let out = work_dir.join(format!("_haramlite_normalized_{stem}.wav"));
    let input_str = input.to_string_lossy().into_owned();
    let out_str = out.to_string_lossy().into_owned();

    let t_arg = max_seconds.map(|s| format!("{s:.3}"));
    let mut args: Vec<&str> = vec![
        "-y", "-v", "error",
        "-i", &input_str,
    ];
    if let Some(t) = &t_arg {
        args.push("-t");
        args.push(t.as_str());
    }
    args.extend_from_slice(&["-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le"]);
    args.push(&out_str);

    run_ffmpeg(&ffmpeg, &args)?;
    if !out.is_file() {
        return Err(MediaError::InvalidOutput(format!("لم يُنتج ffmpeg ملفًا: {}", out.display())));
    }
    Ok(out)
}

/// Extract the audio track of any media into `format` (mp3/wav/flac).
pub fn extract_audio(input: &Path, format: &str, out_dir: &Path) -> Result<PathBuf, MediaError> {
    match format.to_ascii_lowercase().as_str() {
        "mp3" | "wav" | "flac" => {}
        other => return Err(MediaError::InvalidOutput(format!("صيغة غير مدعومة: {other}"))),
    }
    let ffmpeg = resolve_tool("ffmpeg")?;
    std::fs::create_dir_all(out_dir).map_err(|e| MediaError::SpawnFailed(e.to_string()))?;
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "audio".into());
    let out = out_dir.join(format!("{stem}_haramlite.{format}"));

    let codec_args: &[&str] = match format {
        "mp3" => &["-c:a", "libmp3lame", "-b:a", "320k"],
        "flac" => &["-c:a", "flac"],
        _ => &["-c:a", "pcm_s16le"],
    };

    let input_str = input.to_string_lossy().into_owned();
    let out_str = out.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["-y", "-v", "error", "-i", &input_str, "-vn"];
    args.extend_from_slice(codec_args);
    args.push(&out_str);

    run_ffmpeg(&ffmpeg, &args)?;
    if !out.is_file() {
        return Err(MediaError::InvalidOutput(format!("لم يُنتج ffmpeg ملفًا: {}", out.display())));
    }
    Ok(out)
}

/// Rebuild an MP4 keeping the original video stream and replacing its audio.
pub fn remux_video_with_audio(input: &Path, audio_wav: &Path, out_path: &Path) -> Result<PathBuf, MediaError> {
    let ffmpeg = resolve_tool("ffmpeg")?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| MediaError::SpawnFailed(e.to_string()))?;
    }
    run_ffmpeg(
        &ffmpeg,
        &[
            "-y", "-v", "error",
            "-i", &input.to_string_lossy(),
            "-i", &audio_wav.to_string_lossy(),
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "256k",
            "-shortest",
            &out_path.to_string_lossy(),
        ],
    )?;
    if !out_path.is_file() {
        return Err(MediaError::InvalidOutput(format!("لم يُنتج ffmpeg ملفًا: {}", out_path.display())));
    }
    Ok(out_path.to_path_buf())
}

fn run_ffmpeg(ffmpeg: &Path, args: &[&str]) -> Result<(), MediaError> {
    let out = make_cmd(ffmpeg)
        .args(args)
        .output()
        .map_err(|e| MediaError::SpawnFailed(e.to_string()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        tracing::error!(target: "media", "ffmpeg failed: {err}");
        return Err(MediaError::InvalidOutput(err.lines().last().unwrap_or_default().to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools_available() -> bool {
        resolve_tool("ffmpeg").is_ok() && resolve_tool("ffprobe").is_ok()
    }

    fn make_samples(dir: &Path) -> (PathBuf, PathBuf) {
        let ffmpeg = resolve_tool("ffmpeg").unwrap();
        std::fs::create_dir_all(dir).unwrap();

        let wav = dir.join("tone.wav");
        let status = make_cmd(&ffmpeg)
            .args([
                "-y", "-v", "error",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                "-ac", "2", &wav.to_string_lossy(),
            ])
            .status()
            .unwrap();
        assert!(status.success());

        let mp4_audio_only = dir.join("fake_video.mp4");
        let status = make_cmd(&ffmpeg)
            .args([
                "-y", "-v", "error",
                "-i", &wav.to_string_lossy(),
                "-c:a", "aac",
                &mp4_audio_only.to_string_lossy(),
            ])
            .status()
            .unwrap();
        assert!(status.success(), "mp4 (audio-only) sample creation");

        (wav, mp4_audio_only)
    }

    #[test]
    fn probe_detects_weird_mp4_audio_only() {
        if !tools_available() {
            // A checkout without the gitignored bin/ (CI, or a fresh clone) has
            // no bundled tools: skip explicitly instead of failing the suite —
            // the same pattern separator.rs uses for its live CUDA smoke test.
            eprintln!("skipping: ffmpeg/ffprobe not found in bin/");
            return;
        }
        let tmp = std::env::temp_dir().join(format!("hl_m1_{}", std::process::id()));
        let (_wav, mp4) = make_samples(&tmp);

        let info = probe(&mp4).expect("probe");
        assert!(info.has_audio, "must see the audio stream");
        assert!(!info.has_video, "no real video stream");
        assert!(info.audio_disguised_as_video, "weird-file verdict must fire");
        assert!(info.audio_codec.as_deref() == Some("aac"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn extract_and_normalize_produce_valid_files() {
        if !tools_available() {
            // A checkout without the gitignored bin/ (CI, or a fresh clone) has
            // no bundled tools: skip explicitly instead of failing the suite —
            // the same pattern separator.rs uses for its live CUDA smoke test.
            eprintln!("skipping: ffmpeg/ffprobe not found in bin/");
            return;
        }
        let tmp = std::env::temp_dir().join(format!("hl_m1x_{}", std::process::id()));
        let (wav, _mp4) = make_samples(&tmp);

        let mp3_dir = tmp.join("out");
        let mp3 = extract_audio(&wav, "mp3", &mp3_dir).expect("extract mp3");
        assert!(mp3.is_file());
        assert!(std::fs::metadata(&mp3).unwrap().len() > 1000);

        let norm = normalize_for_engine(&mp3, &tmp.join("work")).expect("normalize");
        let info = probe(&norm).expect("probe normalized");
        assert_eq!(info.sample_rate, Some(44100));
        assert_eq!(info.channels, Some(2));
        assert!(!info.audio_disguised_as_video && !info.has_video);

        std::fs::remove_dir_all(&tmp).ok();
    }

    // P3 tests share one process-wide env var (HARAMLITE_VIDEO_ENCODER),
    // and Rust runs tests in parallel threads — so all three run inside ONE
    // #[test] driver, strictly serial. Never split them apart.
    fn p3_selection() {
        // Env override is authoritative in both directions ...
        // 0.2.5: `x264` is the LEGACY spelling and must still mean the
        // software path (now `h264_mf`) — owner notes and older measurement
        // scripts carry it, and silently changing its meaning is the failure
        // mode this assertion exists to prevent.
        std::env::set_var("HARAMLITE_VIDEO_ENCODER", "x264");
        assert_eq!(choose_video_encoder(true), VideoEncoder::Mf);
        assert_eq!(choose_video_encoder(false), VideoEncoder::Mf);
        std::env::set_var("HARAMLITE_VIDEO_ENCODER", "mf");
        assert_eq!(choose_video_encoder(true), VideoEncoder::Mf);
        std::env::set_var("HARAMLITE_VIDEO_ENCODER", "NVENC");
        assert_eq!(choose_video_encoder(false), VideoEncoder::Nvenc);
        std::env::set_var("HARAMLITE_VIDEO_ENCODER", "nvenc");
        assert_eq!(choose_video_encoder(false), VideoEncoder::Nvenc);
        // ... otherwise hardware decides; garbage == auto.
        std::env::set_var("HARAMLITE_VIDEO_ENCODER", "auto");
        assert_eq!(choose_video_encoder(true), VideoEncoder::Nvenc);
        assert_eq!(choose_video_encoder(false), VideoEncoder::Mf);
        std::env::set_var("HARAMLITE_VIDEO_ENCODER", "bogus-value!!");
        assert_eq!(choose_video_encoder(true), VideoEncoder::Nvenc);
        // An unknown value must keep behaving exactly as it did before the
        // rename: hardware when present, software otherwise — never an error.
        assert_eq!(choose_video_encoder(false), VideoEncoder::Mf);
        std::env::remove_var("HARAMLITE_VIDEO_ENCODER");
    }

    fn p3_probe_cached() {
        if !tools_available() {
            // A checkout without the gitignored bin/ (CI, or a fresh clone) has
            // no bundled tools: skip explicitly instead of failing the suite —
            // the same pattern separator.rs uses for its live CUDA smoke test.
            eprintln!("skipping: ffmpeg/ffprobe not found in bin/");
            return;
        }
        // No assert on the VALUE (CPU runners legitimately report false) —
        // only that probing is total, cached, and deterministic.
        assert_eq!(has_nvenc(), has_nvenc(), "cached probe must be stable");
        assert_eq!(has_h264_mf(), has_h264_mf(), "cached probe must be stable");
    }

    /// P3 driver (serial by construction — see note above): selection rules,
    /// probe stability, then the RTX field measurement. `-- --nocapture`
    /// prints ENCODER-BENCH lines.
    #[test]
    fn p3_encoder_paths() {
        p3_selection();
        p3_probe_cached();
        if !tools_available() {
            // A checkout without the gitignored bin/ (CI, or a fresh clone) has
            // no bundled tools: skip explicitly instead of failing the suite —
            // the same pattern separator.rs uses for its live CUDA smoke test.
            eprintln!("skipping: ffmpeg/ffprobe not found in bin/");
            return;
        }
        let ffmpeg = resolve_tool("ffmpeg").unwrap();
        let tmp = std::env::temp_dir().join(format!("hl_nvenc_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // 10s 1080p30 test pattern + silent stereo track (self-contained).
        // Encoded with `mpeg4`, NOT libx264: the fixture only has to be a
        // video source, and libx264 does not exist in the LGPL build we ship
        // from 0.2.5 on — a fixture that needs a GPL encoder breaks the whole
        // driver on the very build under test.
        let src = tmp.join("src.mp4");
        let st = make_cmd(&ffmpeg)
            .args([
                "-y", "-v", "error",
                "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=10",
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo:d=10",
                "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac",
                "-shortest", &src.to_string_lossy(),
            ])
            .status()
            .unwrap();
        assert!(st.success(), "fixture generation");

        let wav = tmp.join("a.wav");
        let st = make_cmd(&ffmpeg)
            .args(["-y", "-v", "error", "-i", &src.to_string_lossy(), "-vn", &wav.to_string_lossy()])
            .status()
            .unwrap();
        assert!(st.success(), "audio extraction");

        // 0.2.5: the software iteration is `mf` (was `x264` before the LGPL
        // swap) — the same forced path the owner's field report exercises.
        for forced in ["nvenc", "mf"] {
            std::env::set_var("HARAMLITE_VIDEO_ENCODER", forced);
            // NOTE: on a GPU-less box the nvenc-forced iteration exercises
            // the AUTOMATIC FALLBACK path (still a valid MP4 out) — by design.
            let out = tmp.join(format!("cut_{forced}.mp4"));
            let t0 = std::time::Instant::now();
            let res = export_video_with_cuts(&src, &wav, &[(1.0, 9.0)], None, &out);
            let dt = t0.elapsed().as_secs_f32();
            match res {
                Ok(p) => {
                    let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    assert!(len > 50_000, "valid cut mp4 expected: {forced}");
                    let (profile, pix_fmt) = probe_video_profile_pix_fmt(&p);
                    assert_eq!(pix_fmt, "yuv420p", "exported pixel format must be fixed: {forced}");
                    // The cut must actually be APPLIED, not merely "a file came
                    // out". A filtergraph whose output nobody consumes either
                    // errors out or silently keeps the whole timeline, so the
                    // duration is the assertion that distinguishes the two.
                    let kept_secs = 8.0_f64;
                    let out_secs = probe(&p).map(|i| i.duration_secs).unwrap_or(0.0);
                    assert!(
                        (out_secs - kept_secs).abs() < 0.5,
                        "{forced}: exported duration {out_secs:.3}s != kept range {kept_secs:.3}s \
                         — the select filter was not applied"
                    );
                    println!(
                        "ENCODER-BENCH {forced} ok in {dt:.1}s ({len} bytes, dur={out_secs:.3}s, \
                         profile={profile}, pix_fmt={pix_fmt})"
                    );
                }
                Err(e) => panic!("{forced} path must never hard-fail (fallback exists): {e}"),
            }
        }
        std::env::remove_var("HARAMLITE_VIDEO_ENCODER");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

/// P3: video encoder choice. NVENC offloads the re-encode from the CPU
/// (the old all-core x264 path starved the window compositor); any NVENC
/// failure falls back to the software encoder automatically — never a fatal
/// error. `Mf` (Media Foundation) is that software encoder: 0.2.5 moved off
/// libx264/GPL onto the LGPL build's `h264_mf`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoEncoder {
    Nvenc,
    Mf,
}

/// Names the missing piece for a Windows **N/KN** edition (no Media Feature
/// Pack ⇒ no Media Foundation H.264 encoder at all). Used verbatim in the
/// user-facing error so the fix is stated, not hinted.
const MEDIA_FEATURE_PACK_HINT: &str = "حزمة ميزات الوسائط (Media Feature Pack)";

/// Pure selection (unit-tested): explicit override wins, otherwise hardware
/// when available. `HARAMLITE_VIDEO_ENCODER=auto|nvenc|mf` (default auto)
/// doubles as the measurement hook for encoder benchmarks. The **legacy
/// spelling `x264`** still maps to the software path (`Mf`): the owner's notes
/// and our own measurement scripts carry it, and after the 0.2.5 encoder swap
/// it means exactly the same thing, so it must not break — silently or loudly.
pub fn choose_video_encoder(nvenc_available: bool) -> VideoEncoder {
    match std::env::var("HARAMLITE_VIDEO_ENCODER")
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        // "x264" = the pre-0.2.5 name for the software path: same meaning, kept.
        "x264" | "mf" => VideoEncoder::Mf,
        "nvenc" => VideoEncoder::Nvenc,
        _ => {
            if nvenc_available {
                VideoEncoder::Nvenc
            } else {
                VideoEncoder::Mf
            }
        }
    }
}

/// Probe the bundled ffmpeg for h264_nvenc (cached — one subprocess ever).
/// False on missing ffmpeg, on CPU-only machines, and in containers without
/// a GPU: every caller must treat Nvenc as an optimization, never a need.
pub fn has_nvenc() -> bool {
    static CACHED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHED.get_or_init(|| {
        let Ok(ffmpeg) = resolve_tool("ffmpeg") else {
            return false;
        };
        let out = make_cmd(&ffmpeg)
            .args(["-hide_banner", "-encoders"])
            .output();
        match out {
            Ok(o) => {
                let text = String::from_utf8_lossy(&o.stdout);
                text.lines().any(|l| l.contains("h264_nvenc"))
            }
            Err(_) => false,
        }
    })
}

/// Probe the bundled ffmpeg for `h264_mf`, the software H.264 encoder of the
/// LGPL build (cached — one subprocess ever). False on missing ffmpeg and on
/// Windows **N/KN** editions, where Media Foundation ships without its media
/// features: every caller must treat it exactly like `has_nvenc` — a fact to
/// check, never an assumption.
pub fn has_h264_mf() -> bool {
    static CACHED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHED.get_or_init(|| {
        let Ok(ffmpeg) = resolve_tool("ffmpeg") else {
            return false;
        };
        let out = make_cmd(&ffmpeg)
            .args(["-hide_banner", "-encoders"])
            .output();
        match out {
            Ok(o) => {
                let text = String::from_utf8_lossy(&o.stdout);
                text.lines().any(|l| l.contains("h264_mf"))
            }
            Err(_) => false,
        }
    })
}

/// Refuse aloud when the bundled build can encode H.264 neither in hardware
/// nor in software. Windows **N/KN** editions ship without the Media Feature
/// Pack, so `h264_mf` is genuinely absent there and the message has to name it
/// — a bare "encoder not found" sends the owner hunting for the wrong thing.
fn ensure_h264_encoder_available() -> Result<(), MediaError> {
    if has_nvenc() || has_h264_mf() {
        return Ok(());
    }
    Err(MediaError::InvalidOutput(format!(
        "لا مُرمِّز H.264 متاح في هذه النسخة من ffmpeg: \
         لا h264_nvenc (يلزم معالج رسومات NVIDIA) ولا h264_mf. \
         على إصدارات ويندوز N/KN السبب غالباً غياب {MEDIA_FEATURE_PACK_HINT}."
    )))
}

/// `(codec_name, profile, pix_fmt)` of the first real video stream of `path`.
/// `None` when ffprobe is missing, fails, or the file has no video — the
/// caller is a best-effort diagnostic and must degrade, never fail, on it.
fn ffprobe_video_encoder_info(path: &Path) -> Option<StreamLite> {
    let ffprobe = resolve_tool("ffprobe").ok()?;
    let json = run_tool(
        &ffprobe,
        &[
            "-v", "error", "-print_format", "json", "-show_streams",
            &path.to_string_lossy(),
        ],
    )
    .ok()?;
    let raw: serde_json::Value = serde_json::from_str(&json).ok()?;
    raw["streams"]
        .as_array()?
        .iter()
        .find(|s| {
            s["codec_type"].as_str() == Some("video")
                && s["disposition"]["attached_pic"].as_i64() != Some(1)
        })
        .map(|s| StreamLite {
            codec_type: s["codec_type"].as_str().map(str::to_string),
            codec_name: s["codec_name"].as_str().map(str::to_string),
            profile: s["profile"].as_str().map(str::to_string),
            pix_fmt: s["pix_fmt"].as_str().map(str::to_string),
            ..Default::default()
        })
}

/// How many encoder threads to hand the software encoder. Shared so the
/// window compositor stays alive on both encode paths (see `export_video_with_cuts`).
fn encoder_threads_str() -> String {
    crate::separator::inference_threads(
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4),
    )
    .to_string()
}

/// Video-encoder flags for [`VideoEncoder::Mf`] — **quality** mode, the only
/// mode worth using: at its defaults `h264_mf` produced VMAF 53–64, a collapse
/// invisible in the file size (measured 2026-09-15, AUDIT).
///
/// `-pix_fmt yuv420p` is **pinned, not required**: `h264_mf` accepts only
/// `nv12/yuv420p/d3d11`, and while ffmpeg does insert the conversion on its own
/// for 10-bit and 4:2:2 input (measured — both encoded fine without this flag),
/// relying on automatic negotiation makes the output format a property of the
/// source instead of a decision. The flag states it.
fn mf_quality_args(threads: &str) -> Vec<String> {
    vec![
        "-c:v".into(),
        "h264_mf".into(),
        "-rate_control".into(),
        "quality".into(),
        "-quality".into(),
        "85".into(),
        "-pix_fmt".into(),
        MP4_PIX_FMT.into(),
        "-threads".into(),
        threads.to_string(),
    ]
}

/// Video-encoder flags for [`VideoEncoder::Mf`] on the **byte-budget** path.
/// Rate-constrained on purpose: `transcode_to_bitrate` exists to land a file
/// under a cap, and constant quality would overshoot it (measured +83.5% on
/// content C). `-pix_fmt yuv420p` for the same reason as above.
fn mf_bitrate_args(budget: &BitrateBudget, threads: &str) -> Vec<String> {
    vec![
        "-c:v".into(),
        "h264_mf".into(),
        "-rate_control".into(),
        "cbr".into(),
        "-b:v".into(),
        budget.bitrate.clone(),
        "-maxrate".into(),
        budget.maxrate.clone(),
        "-bufsize".into(),
        budget.bufsize.clone(),
        "-pix_fmt".into(),
        MP4_PIX_FMT.into(),
        "-threads".into(),
        threads.to_string(),
    ]
}

/// One place that turns an encoder choice into ffmpeg flags, so the flags are
/// unit-testable **without** running ffmpeg (each encoder's own flags come from
/// the pure builders above). `threads` caps libx264-style CPU spinners; it is
/// passed through for every encoder so the two paths cannot drift apart.
fn video_encoder_args(enc: VideoEncoder, threads: &str) -> Vec<String> {
    match enc {
        VideoEncoder::Nvenc => vec![
            "-c:v".into(),
            "h264_nvenc".into(),
            "-preset".into(),
            "p4".into(),
            "-cq".into(),
            "20".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ],
        VideoEncoder::Mf => mf_quality_args(threads),
    }
}

/// Shared front half of an H.264 encode: everything up to (not including) the
/// video-encoder flags. Kept separate so both production paths build it once.
///
/// `video_map` is **not** decoration. The export path feeds the filtergraph
/// output `[v]`; mapping the raw `0:v:0` instead leaves the filtergraph's
/// output unconsumed, which ffmpeg rejects outright (`Error binding filtergraph
/// inputs/outputs`) — and were it tolerated, the cut and the downscale would
/// silently vanish from every export. The byte-budget path uses `-vf`, which
/// transforms the video stream in place, so there `0:v:0` is the correct input.
fn input_args(video: &str, audio: &str, filter: Option<&str>, video_map: &str) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-v".into(),
        "error".into(),
        "-i".into(),
        video.to_string(),
        "-i".into(),
        audio.to_string(),
    ];
    if let Some(f) = filter {
        args.extend(["-filter_complex".to_string(), f.to_string()]);
    }
    args.extend([
        "-map".to_string(),
        video_map.to_string(),
        "-map".to_string(),
        "1:a:0".to_string(),
    ]);
    args
}

/// Full ffmpeg argument list for the **normal export** path (fixed quality).
/// Pure, so the flag guard test can assert on it without spawning ffmpeg:
/// adding or dropping a quality flag must fail a test, not a user's export.
fn export_args(
    enc: VideoEncoder,
    video: &str,
    audio: &str,
    filter: &str,
    out: &str,
    threads: &str,
) -> Vec<String> {
    let mut args = input_args(video, audio, Some(filter), "[v]");
    args.extend(video_encoder_args(enc, threads));
    // `+faststart` moves `moov` ahead of `mdat`: without it a player that
    // fetches the file progressively (Telegram, a browser) cannot start until
    // the whole download finishes — the "frozen first play" the owner saw.
    args.extend([
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "256k".to_string(),
        "-shortest".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        out.to_string(),
    ]);
    args
}

/// Rebuild a video keeping ONLY the given time ranges (seconds) of the video
/// track (frame-accurate via select filter, re-encoded) with `audio` muxed in.
/// `max_height`: None keeps source resolution; Some(h) downscales (even, no upscale).
pub fn export_video_with_cuts(
    video: &Path,
    audio: &Path,
    kept_ranges_secs: &[(f64, f64)],
    max_height: Option<u32>,
    out_path: &Path,
) -> Result<PathBuf, MediaError> {
    if kept_ranges_secs.is_empty() {
        // no cuts → stream-copy remux path; scaling requires re-encode so only
        // honor max_height when cuts exist (quality-preserving default).
        return remux_video_with_audio(video, audio, out_path);
    }

    let ffmpeg = resolve_tool("ffmpeg")?;
    // Refuse before writing anything when the build can encode neither way.
    ensure_h264_encoder_available()?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| MediaError::SpawnFailed(e.to_string()))?;
    }

    // build select expression: between(t,a,b)+between(t,c,d)+...
    let expr_parts: Vec<String> = kept_ranges_secs
        .iter()
        .map(|(a, b)| format!("between(t,{:.3},{:.3})", a, b))
        .collect();
    let mut chain =
        format!("select='{}',setpts=N/FRAME_RATE/TB", expr_parts.join("+"));
    if let Some(h) = max_height {
        chain.push_str(&format!(",scale=-2:{h}:flags=lanczos"));
    }

    let video_str = video.to_string_lossy().into_owned();
    let audio_str = audio.to_string_lossy().into_owned();
    let out_str = out_path.to_string_lossy().into_owned();
    let fc = format!("[0:v]{chain}[v]");
    // Same breathing room as ORT inference: an uncapped software encoder
    // starved the window compositor into blackouts during long exports.
    let enc_threads_str = encoder_threads_str();

    // P3: NVENC first when available (preset p4 + cq 20 ≈ veryfast/crf18
    // class), `h264_mf` otherwise or on ANY nvenc failure (automatic fallback).
    let first = choose_video_encoder(has_nvenc());
    let encoders: &[VideoEncoder] = match first {
        VideoEncoder::Nvenc => &[VideoEncoder::Nvenc, VideoEncoder::Mf],
        VideoEncoder::Mf => &[VideoEncoder::Mf],
    };
    let mut last_err = String::new();
    for enc in encoders {
        let args = export_args(*enc, &video_str, &audio_str, &fc, &out_str, &enc_threads_str);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let t0 = std::time::Instant::now();
        let status = make_cmd(&ffmpeg)
            .args(&arg_refs)
            .output()
            .map_err(|e| MediaError::SpawnFailed(e.to_string()))?;

        if status.status.success() {
            let fell_back = *enc != first;
            if fell_back {
                tracing::warn!(
                    target: "media",
                    "NVENC failed ({last_err}) — fell back to the software encoder (h264_mf)"
                );
            }
            log_encoder_diagnostic(&args, &out_str, t0.elapsed().as_secs_f32(), fell_back);
            return Ok(out_path.to_path_buf());
        }
        last_err = String::from_utf8_lossy(&status.stderr)
            .lines()
            .last()
            .unwrap_or_default()
            .to_string();
        tracing::warn!(target: "media", "video encode with {enc:?} failed: {last_err}");
    }

    tracing::error!(target: "media", "video cuts failed: {last_err}");
    Err(MediaError::InvalidOutput(
        last_err.lines().last().unwrap_or_default().into(),
    ))
}

/// One copyable line answering "**who encoded this file?**" — the owner's
/// field report (ب.٦) has to be evidence, not a recollection, so the encoder
/// choice, whether it was a fallback, the measured size/duration and the actual
/// `profile`/`pix_fmt` all go to the log in one line.
///
/// `profile`/`pix_fmt` are read back from the finished file with ffprobe — the
/// requested pixel format and the encoded one are not the same claim, and the
/// 0.2.5 encoder swap is exactly the kind of change where they diverge.
fn log_encoder_diagnostic(args: &[String], out: &str, secs: f32, fell_back: bool) {
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
            .unwrap_or("?")
    };
    let encoder = match flag("-c:v") {
        "h264_nvenc" => "nvenc",
        "h264_mf" => "mf",
        other => other,
    };
    let bytes = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    let (profile, pix_fmt) = probe_video_profile_pix_fmt(Path::new(out));
    tracing::info!(
        target: "media",
        "encoder={encoder} fallback={fell_back} rate={rate} quality={quality} \
         time={secs:.1}s size={bytes}B profile={profile} pix_fmt={pix_fmt}",
        rate = flag("-rate_control"),
        quality = flag("-quality"),
    );
}

/// `(profile, pix_fmt)` of the first real video stream, best-effort: the
/// diagnostic must never turn a successful export into a failure, so any
/// problem (missing ffprobe, unparsable JSON, absent field) reports `"?"`.
fn probe_video_profile_pix_fmt(path: &Path) -> (String, String) {
    let Some(encoder) = ffprobe_video_encoder_info(path) else {
        return ("?".into(), "?".into());
    };
    (encoder.profile.unwrap_or_else(|| "?".into()), encoder.pix_fmt.unwrap_or_else(|| "?".into()))
}

// ── Sprint T1: fitting a result into a messaging cap (Telegram) ─────────────

/// Below this the picture is not worth sending at all — the caller sends the
/// audio instead and says why, rather than shipping an unwatchable smear.
pub const MIN_WATCHABLE_VIDEO_KBPS: u32 = 300;

/// The video bitrate that fits `target_mb` into `duration_secs`: the owner's
/// formula `(target_mb × 8192) / seconds` made exact — it yields the TOTAL
/// bitrate, so the audio track and a small container margin come off the top
/// (otherwise the file lands just over the cap and the upload is rejected).
/// Pure and unit-tested; returns 0 when the budget cannot even carry audio.
pub fn target_video_kbps(duration_secs: f64, target_mb: f64, audio_kbps: u32) -> u32 {
    if !(duration_secs > 0.0) || !(target_mb > 0.0) {
        return 0;
    }
    let total_kbps = (target_mb * 8192.0) / duration_secs;
    // 4% headroom for the container (mp4 boxes, timestamps, index).
    let usable = total_kbps * 0.96;
    let video = usable - f64::from(audio_kbps);
    if video <= 0.0 {
        0
    } else {
        video as u32
    }
}

/// Full ffmpeg argument list for the **byte-budget** path. Pure, so the flag
/// guard test can assert the rate constraint and the pixel format without
/// spawning ffmpeg.
fn transcode_args(
    enc: VideoEncoder,
    input: &str,
    out: &str,
    budget: &BitrateBudget,
    audio_kbps: u32,
    scale: Option<&str>,
    threads: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["-y".into(), "-v".into(), "error".into(), "-i".into(), input.into()];
    if let Some(s) = scale {
        args.extend(["-vf".to_string(), s.to_string()]);
    }
    args.extend(match enc {
        VideoEncoder::Nvenc => vec![
            "-c:v".into(),
            "h264_nvenc".into(),
            "-preset".into(),
            "p4".into(),
            "-cq".into(),
            "20".into(),
            "-pix_fmt".into(),
            MP4_PIX_FMT.into(),
            "-b:v".into(),
            budget.bitrate.clone(),
            "-maxrate".into(),
            budget.maxrate.clone(),
            "-bufsize".into(),
            budget.bufsize.clone(),
        ],
        VideoEncoder::Mf => mf_bitrate_args(budget, threads),
    });
    args.extend([
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        format!("{}k", audio_kbps.max(32)),
        "-movflags".to_string(),
        "+faststart".to_string(),
        out.to_string(),
    ]);
    args
}

/// Re-encode a finished result at a target video bitrate so it fits the cap.
/// Deliberately **rate-constrained** (`h264_mf -rate_control cbr` with
/// `-b:v/-maxrate/-bufsize`) — the whole point here is landing under a byte
/// budget, and constant quality overshoots it. `max_height` only ever
/// downscales, and the thread cap keeps the window compositor alive.
pub fn transcode_to_bitrate(
    input: &Path,
    out_path: &Path,
    video_kbps: u32,
    audio_kbps: u32,
    max_height: Option<u32>,
) -> Result<PathBuf, MediaError> {
    let ffmpeg = resolve_tool("ffmpeg")?;
    // Check before touching the filesystem: a caller must be able to tell
    // "cannot encode here" from "encoding failed", and must not be handed a
    // half-written artifact to send.
    ensure_h264_encoder_available()?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| MediaError::SpawnFailed(e.to_string()))?;
    }
    let budget = BitrateBudget::from_video_kbps(video_kbps);
    let threads = encoder_threads_str();
    // Literal height (computed by the caller from probe) — no filter
    // expressions, so there is no comma to escape.
    let scale = max_height.map(|h| format!("scale=-2:{h}"));

    let in_str = input.to_string_lossy().into_owned();
    let out_str = out_path.to_string_lossy().into_owned();
    let args = transcode_args(
        choose_video_encoder(has_nvenc()),
        &in_str,
        &out_str,
        &budget,
        audio_kbps,
        scale.as_deref(),
        &threads,
    );
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let t0 = std::time::Instant::now();
    let out = make_cmd(&ffmpeg)
        .args(&arg_refs)
        .output()
        .map_err(|e| MediaError::SpawnFailed(e.to_string()))?;
    if !out.status.success() {
        let last = String::from_utf8_lossy(&out.stderr)
            .lines()
            .last()
            .unwrap_or_default()
            .to_string();
        tracing::error!(target: "media", "size-targeted transcode failed: {last}");
        return Err(MediaError::InvalidOutput(last));
    }
    // Same "who encoded this?" line as the export path — the cap path is the
    // one whose output size decides whether the file can be sent at all.
    log_encoder_diagnostic(&args, &out_str, t0.elapsed().as_secs_f32(), false);
    Ok(out_path.to_path_buf())
}

#[cfg(test)]
mod telegram_size_tests {
    use super::*;

    #[test]
    fn target_bitrate_matches_the_owner_formula() {
        // 40MB over 600s ⇒ 546 kbps total; the audio track comes off the top.
        let k = target_video_kbps(600.0, 40.0, 96);
        assert!((k as i64 - 428).abs() <= 4, "got {k}");
        // The raw formula (no audio subtraction) is the upper bound.
        assert!(k < ((40.0 * 8192.0) / 600.0) as u32);
    }

    #[test]
    fn an_hour_cannot_fit_a_watchable_picture() {
        // 1h into 40MB ⇒ ~91 kbps total — under the audio budget: 0, and the
        // caller must fall back to audio-only.
        let k = target_video_kbps(3600.0, 40.0, 96);
        assert_eq!(k, 0);
        assert!(k < MIN_WATCHABLE_VIDEO_KBPS);
    }

    #[test]
    fn short_clips_get_generous_bitrate() {
        // 3 minutes into 40MB ⇒ ~1747 kbps video: comfortable 720p.
        let k = target_video_kbps(180.0, 40.0, 96);
        assert!(k > 1500 && k < 1800, "got {k}");
    }

    #[test]
    fn degenerate_inputs_never_panic_or_overflow() {
        assert_eq!(target_video_kbps(0.0, 40.0, 96), 0);
        assert_eq!(target_video_kbps(-5.0, 40.0, 96), 0);
        assert_eq!(target_video_kbps(60.0, 0.0, 96), 0);
        assert_eq!(target_video_kbps(f64::NAN, 40.0, 96), 0);
    }
}

/// ب.٢.٣ — the flag guard. These tests watch the **ffmpeg flags**, not the
/// encoder name: the 0.2.5 swap is exactly the kind of change where a flag can
/// vanish unnoticed and still "work" (a plausible-looking MP4 that is 3× too
/// big, or one Telegram refuses). Each of these exists to fail loudly when a
/// flag is dropped, so the guard is only as good as its ability to fail — the
/// deliberate-break run is recorded in `docs/AUDIT.md`.
#[cfg(test)]
mod video_flag_guard {
    use super::*;

    /// Index of `name` in `args`, with the message saying what went missing
    /// rather than only that an Option was None.
    fn index_of(args: &[String], name: &str) -> usize {
        match args.iter().position(|a| a == name) {
            Some(i) => i,
            None => panic!("flag {name} is missing from: {}", args.join(" ")),
        }
    }

    /// The value right after `name` — panics naming the flag when absent.
    fn value_of<'a>(args: &'a [String], name: &str) -> &'a str {
        let i = index_of(args, name);
        match args.get(i + 1) {
            Some(v) => v.as_str(),
            None => panic!("flag {name} has no value in: {}", args.join(" ")),
        }
    }

    fn export_args_for(enc: VideoEncoder) -> Vec<String> {
        export_args(
            enc,
            "in.mp4",
            "a.wav",
            "[0:v]select='between(t,0.000,1.000)',setpts=N/FRAME_RATE/TB[v]",
            "out.mp4",
            "4",
        )
    }

    fn transcode_args_for(enc: VideoEncoder) -> Vec<String> {
        transcode_args(
            enc,
            "in.mp4",
            "out.mp4",
            &BitrateBudget::from_video_kbps(428),
            96,
            Some("scale=-2:720"),
            "4",
        )
    }

    #[test]
    fn export_path_pins_quality_and_pixel_format() {
        let args = export_args_for(VideoEncoder::Mf);
        // The whole reason `h264_mf` is usable at all: at its defaults it
        // measured VMAF 53–64, a collapse the file size hides.
        assert_eq!(value_of(&args, "-c:v"), "h264_mf", "{}", args.join(" "));
        assert_eq!(value_of(&args, "-rate_control"), "quality", "{}", args.join(" "));
        assert_eq!(value_of(&args, "-quality"), "85", "{}", args.join(" "));
        assert_eq!(value_of(&args, "-pix_fmt"), "yuv420p", "{}", args.join(" "));
        // ب.٢.ب — `moov` must precede `mdat` for a file that streams.
        assert_eq!(value_of(&args, "-movflags"), "+faststart", "{}", args.join(" "));
    }

    /// The filtergraph must actually be **wired up**. Pinning the *text* of
    /// `-filter_complex` is not enough: mapping `0:v:0` while the graph emits
    /// `[v]` makes ffmpeg refuse the whole command (`Error binding filtergraph
    /// inputs/outputs`), and anything laxer than a hard error would drop the
    /// cut and the downscale from every export while still writing a file.
    /// This test asserts the graph's output is consumed, not how it is spelled.
    #[test]
    fn export_path_consumes_the_filtergraph_output() {
        let args = export_args_for(VideoEncoder::Mf);
        let fc = value_of(&args, "-filter_complex");
        assert!(fc.ends_with("[v]"), "the graph must label its output [v]: {fc}");
        let mapped: Vec<&str> = args
            .windows(2)
            .filter(|w| w[0] == "-map")
            .map(|w| w[1].as_str())
            .collect();
        assert!(
            mapped.contains(&"[v]"),
            "the filtergraph output [v] is consumed by nothing (maps: {mapped:?}) — \
             the cut would be silently ignored: {}",
            args.join(" ")
        );
        assert_eq!(value_of(&args, "-c:a"), "aac", "{}", args.join(" "));
        assert_eq!(value_of(&args, "-b:a"), "256k", "{}", args.join(" "));
    }

    /// The byte-budget path uses `-vf`, which rewrites the video stream in
    /// place, so — exactly as before 0.2.5 — it maps nothing explicitly and
    /// lets ffmpeg pick the streams (video + first audio). What this test
    /// guards is that no `-filter_complex`/`[v]` wiring leaked over from the
    /// export path: a filtergraph here would leave `[v]` unconsumed, which
    /// ffmpeg refuses outright.
    #[test]
    fn bitrate_path_uses_vf_and_no_filtergraph() {
        let args = transcode_args_for(VideoEncoder::Mf);
        assert!(args.iter().any(|a| a == "-vf"), "{}", args.join(" "));
        assert!(
            !args.iter().any(|a| a == "-filter_complex"),
            "the cap path must use -vf, not a filtergraph: {}",
            args.join(" ")
        );
        assert!(
            !args.iter().any(|a| a == "[v]"),
            "no filtergraph label may leak into the cap path: {}",
            args.join(" ")
        );
    }

    #[test]
    fn export_path_never_asks_for_the_gpl_encoder() {
        // 0.2.5 ships an LGPL build: `libx264` does not exist there, so a
        // surviving reference would fail at run time on every machine.
        for enc in [VideoEncoder::Nvenc, VideoEncoder::Mf] {
            let joined = export_args_for(enc).join(" ");
            assert!(!joined.contains("libx264"), "{enc:?} still asks for libx264: {joined}");
        }
    }

    #[test]
    fn bitrate_path_stays_rate_constrained() {
        let args = transcode_args_for(VideoEncoder::Mf);
        let budget = BitrateBudget::from_video_kbps(428);
        // Constant quality here would defeat the function's only purpose:
        // landing a file under a byte cap (measured +83.5% on content C).
        assert_eq!(value_of(&args, "-rate_control"), "cbr", "{}", args.join(" "));
        assert_eq!(value_of(&args, "-b:v"), budget.bitrate.as_str(), "{}", args.join(" "));
        assert_eq!(value_of(&args, "-maxrate"), budget.maxrate.as_str(), "{}", args.join(" "));
        assert_eq!(value_of(&args, "-bufsize"), budget.bufsize.as_str(), "{}", args.join(" "));
        assert_eq!(value_of(&args, "-pix_fmt"), MP4_PIX_FMT, "{}", args.join(" "));
        assert!(
            !args.iter().any(|a| a == "-quality"),
            "the cap path must not fall back to constant quality: {}",
            args.join(" ")
        );
    }

    #[test]
    fn bitrate_path_keeps_the_scale_and_audio_and_faststart() {
        let args = transcode_args_for(VideoEncoder::Mf);
        assert_eq!(value_of(&args, "-vf"), "scale=-2:720", "{}", args.join(" "));
        assert_eq!(value_of(&args, "-b:a"), "96k", "{}", args.join(" "));
        assert_eq!(value_of(&args, "-movflags"), "+faststart", "{}", args.join(" "));
        // The output path stays the last argument on both paths — ffmpeg reads
        // trailing options as output options, so anything after it is a bug.
        assert_eq!(args.last().map(String::as_str), Some("out.mp4"), "{}", args.join(" "));
    }

    #[test]
    fn encoder_availability_error_names_the_fix() {
        // The message is the whole deliverable on a Windows N/KN machine, so
        // the test pins the part that tells the owner what to install.
        let msg = MediaError::InvalidOutput(format!(
            "لا مُرمِّز H.264 متاح في هذه النسخة من ffmpeg: \
             لا h264_nvenc (يلزم معالج رسومات NVIDIA) ولا h264_mf. \
             على إصدارات ويندوز N/KN السبب غالباً غياب {MEDIA_FEATURE_PACK_HINT}."
        ))
        .to_string();
        assert!(msg.contains("h264_mf"), "{msg}");
        assert!(msg.contains("Media Feature Pack"), "{msg}");
        assert!(msg.contains("N/KN"), "{msg}");
    }
}
