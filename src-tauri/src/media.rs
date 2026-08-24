//! M1 — media pipeline: probe, classify, repair, extract, normalize.
//!
//! All functions are pure path-in/path-out so they are unit-testable without
//! a running Tauri app; thin `#[tauri::command]` wrappers live in lib.rs.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

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

struct StreamLite {
    codec_type: Option<String>,
    codec_name: Option<String>,
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
pub fn normalize_for_engine(input: &Path, work_dir: &Path) -> Result<PathBuf, MediaError> {
    let ffmpeg = resolve_tool("ffmpeg")?;
    std::fs::create_dir_all(work_dir).map_err(|e| MediaError::SpawnFailed(e.to_string()))?;
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "input".into());
    let out = work_dir.join(format!("normalized_{stem}.wav"));

    run_ffmpeg(
        &ffmpeg,
        &[
            "-y", "-v", "error",
            "-i", &input.to_string_lossy(),
            "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le",
            &out.to_string_lossy(),
        ],
    )?;
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
            panic!("ffmpeg/ffprobe not found in bin/");
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
            panic!("ffmpeg/ffprobe not found in bin/");
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
        assert!(info.audio_disguised_as_video == false && !info.has_video);

        std::fs::remove_dir_all(&tmp).ok();
    }
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

    let status = make_cmd(&ffmpeg)
        .args([
            "-y", "-v", "error",
            "-i", &video_str,
            "-i", &audio_str,
            "-filter_complex", &fc,
            "-map", "[v]", "-map", "1:a",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-c:a", "aac", "-b:a", "256k",
            "-shortest",
            &out_str,
        ])
        .output()
        .map_err(|e| MediaError::SpawnFailed(e.to_string()))?;

    if !status.status.success() {
        let err = String::from_utf8_lossy(&status.stderr);
        tracing::error!(target: "media", "video cuts failed: {err}");
        return Err(MediaError::InvalidOutput(err.lines().last().unwrap_or_default().into()));
    }
    Ok(out_path.to_path_buf())
}
