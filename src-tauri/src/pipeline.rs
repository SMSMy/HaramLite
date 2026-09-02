//! Shared processing pipeline used by BOTH the GUI (Tauri commands) and the
//! CLI entrypoint. Single source of truth — no duplicated logic.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{media, separator};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// أغنية: فصل + مؤثرات إعادة حياة + قص صمت
    Song,
    /// مقطع عادي: إزالة موسيقى فقط
    Clip,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "song" | "music" | "اغنية" | "أغاني" => Some(Self::Song),
            "clip" | "normal" | "مقطع" => Some(Self::Clip),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutFormat {
    Wav,
    Flac,
    Mp3,
}

impl OutFormat {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "wav" => Some(Self::Wav),
            "flac" => Some(Self::Flac),
            "mp3" => Some(Self::Mp3),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Mp3 => "mp3",
        }
    }
}

/// Simplified user-facing output choice (M4 spec: فيديو أو صوت).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutKind {
    /// MP4 with processed audio; optional height cap (None = same as source).
    Video { max_height: Option<u32> },
    /// Audio file in the given container (MP3 default for simple users).
    Audio { fmt: OutFormat },
}

#[derive(Debug)]
pub struct PipelineError(String);

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for PipelineError {}

fn err<E: std::fmt::Display>(e: E) -> PipelineError {
    tracing::error!(target: "pipe", "{e}");
    PipelineError(e.to_string())
}

pub struct PipelineOutput {
    pub vocals: Option<PathBuf>,
    /// None unless the hidden "keep instrumental" option is enabled.
    pub instrumental: Option<PathBuf>,
    /// MP4 with processed audio (and cut-mirrored video) for video inputs.
    pub video: Option<PathBuf>,
    pub seconds: f32,
}

/// Process one media file end-to-end.
///
/// Stages (per approved plan):
/// 1. probe/normalize any input → clean 44.1k stereo WAV   [M1 ✓]
/// 2. MDX-Net separation → vocals/instrumental stems       [M2 ✓]
/// 3. (M3) song-mode effect chain + silence cut            [hook below]
/// 4. (M4/M5) encode to requested container                [wav native now]
pub fn process_file(
    input: &Path,
    out_dir: &Path,
    mode: Mode,
    kind: OutKind,
    keep_instrumental: bool,
    keep_vocals: bool,
    use_cuda: bool,
    preview_seconds: Option<f32>,
    progress: &dyn Fn(f32) -> bool,
    stage: &dyn Fn(&str, f32),
) -> Result<PipelineOutput, PipelineError> {
    let started = std::time::Instant::now();
    let work_dir = out_dir.join("_haramlite_work");
    // Sprint B1: preview = quality sample of the first N seconds; every
    // output file carries the `_preview` tag so it can never be mistaken
    // for the final artifact.
    let name_tag = if preview_seconds.is_some() { "_preview" } else { "" };

    // Stage 1 — repair & normalize whatever came in (Sprint C2: visible stages)
    stage("normalize", 0.0);
    if !progress(0.02) { return Err(err("تم إلغاء المعالجة من قبل المستخدم.")); }
    let normalized =
        media::normalize_for_engine_limited(input, &work_dir, preview_seconds).map_err(err)?;
    stage("normalize", 1.0);
    tracing::info!(target: "pipe", "normalized: {}", normalized.display());

    // Stage 2 — separation
    let sep_progress = |p: f32| {
        stage("separate", p);
        progress(0.05 + p * 0.85)
    };
    let stems =
        separator::separate(&normalized, out_dir, use_cuda, &sep_progress).map_err(err)?;
    stage("separate", 1.0);
    let _ = std::fs::remove_dir_all(&work_dir);

    // Stage 3 — song mode: enhancement chain (M3) applied ONTO the vocals stem
    let mut vocals_path = stems.vocals.clone();
    let mut kept_ranges: Vec<(f64, f64)> = Vec::new();
    if matches!(mode, Mode::Song) {
        if !progress(0.92) { return Err(err("تم إلغاء المعالجة من قبل المستخدم.")); }
        stage("effects", 0.0);
        tracing::info!(target: "pipe", "Starting DSP phase (CPU bound) for audio enhancement...");
        let tmp_enhanced = out_dir.join("_haramlite_enhanced.wav");
        kept_ranges = crate::effects::enhance_song_file(&stems.vocals, &tmp_enhanced, &Default::default())
            .map_err(err)?;
        // replace raw vocals with the enhanced version
        std::fs::rename(&tmp_enhanced, &vocals_path).map_err(err)?;
        stage("effects", 1.0);
    }

    // Probe the ORIGINAL input once for video routing decisions.
    let input_info = media::probe(input).ok();
    let has_video = input_info.as_ref().map(|i| i.has_video).unwrap_or(false);

    // Stage 4 — instrumental handling (hidden opt-in; default = vocals only)
    let mut instrumental_path: Option<PathBuf> = if keep_instrumental {
        Some(stems.instrumental.clone())
    } else {
        let _ = std::fs::remove_file(&stems.instrumental);
        None
    };

    // Cosmetic: stems inherit the ORIGINAL file name, not the scratch wav.
    let orig_stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "audio".into());
    {
        let new_vocals = vocals_path.with_file_name(format!("{orig_stem}_(Vocals)_haramlite{name_tag}.wav"));
        if new_vocals != vocals_path {
            std::fs::rename(&vocals_path, &new_vocals).map_err(err)?;
            vocals_path = new_vocals;
        }
        if let Some(ip) = &mut instrumental_path {
            let new_i = ip.with_file_name(format!("{orig_stem}_(Instrumental)_haramlite{name_tag}.wav"));
            if new_i != *ip {
                std::fs::rename(&*ip, &new_i).map_err(err)?;
                *ip = new_i;
            }
        }
    }

    // Stage 5/6 — delivery per simplified OutKind (فيديو / صوت)
    let mut actual_kind = kind;
    if matches!(kind, OutKind::Video { .. }) && (!has_video || input_info.as_ref().map(|i| i.video_is_cover_art).unwrap_or(false)) {
        tracing::info!(target: "pipe", "Smart fallback: input lacks video, switching to Audio (mp3)");
        actual_kind = OutKind::Audio { fmt: OutFormat::Mp3 };
    }

    let mut video_out: Option<PathBuf> = None;
    let mut final_vocals: Option<PathBuf> = Some(vocals_path.clone());
    match actual_kind {
        OutKind::Video { max_height } => {
            if !progress(0.97) { return Err(err("تم إلغاء المعالجة من قبل المستخدم.")); }
            stage("encode", 0.0);
            let vid_target = out_dir.join(format!("{orig_stem}_(Clean)_haramlite{name_tag}.mp4"));
            let ranges_for_video: &[(f64, f64)] =
                if matches!(mode, Mode::Song) { &kept_ranges } else { &[] };
            media::export_video_with_cuts(
                input,
                &vocals_path,
                ranges_for_video,
                max_height,
                &vid_target,
            )
            .map_err(err)?;
            let _ = std::fs::remove_file(&vocals_path);
            stage("encode", 1.0);
            tracing::info!(target: "pipe", "video output: {}", vid_target.display());
            video_out = Some(vid_target);
            final_vocals = None;
        }
        OutKind::Audio { fmt } => {
            if fmt != OutFormat::Wav {
                if !progress(0.96) { return Err(err("تم إلغاء المعالجة من قبل المستخدم.")); }
                stage("encode", 0.0);
                let encode_one = |p: &mut PathBuf| -> Result<(), PipelineError> {
                    let encoded = media::extract_audio(p, fmt.as_str(), out_dir).map_err(err)?;
                    let _ = std::fs::remove_file(&*p);
                    let clean = p.with_extension(fmt.as_str());
                    if encoded != clean {
                        std::fs::rename(&encoded, &clean).map_err(err)?;
                        *p = clean;
                    } else {
                        *p = encoded;
                    }
                    Ok(())
                };
                
                if keep_vocals {
                    encode_one(&mut vocals_path)?;
                    final_vocals = Some(vocals_path);
                } else {
                    let _ = std::fs::remove_file(&vocals_path);
                    final_vocals = None;
                }
                
                if let Some(ip) = &mut instrumental_path {
                    encode_one(ip)?;
                }
                stage("encode", 1.0);
                tracing::info!(target: "pipe", "encoded stems to {}", fmt.as_str());
            } else {
                if !keep_vocals {
                    let _ = std::fs::remove_file(&vocals_path);
                    final_vocals = None;
                }
            }
        }
    }

    let seconds = started.elapsed().as_secs_f32();
    progress(1.0);
    tracing::info!(target: "pipe", "pipeline done in {seconds:.1}s");

    Ok(PipelineOutput {
        vocals: final_vocals,
        instrumental: instrumental_path,
        video: video_out,
        seconds,
    })
}

/// Quick health check used by `--check` (CLI) and startup diagnostics (GUI).
pub fn health_check() -> Result<Vec<(String, bool, String)>, String> {
    let mut rows = Vec::new();

    for tool in ["ffmpeg", "ffprobe", "yt-dlp"] {
        let ok = media::resolve_tool(tool).is_ok();
        rows.push((tool.to_string(), ok, String::new()));
    }

    match crate::separator::resolve_model_pub() {
        Ok(p) => rows.push(("model".into(), true, p.display().to_string())),
        Err(_) => rows.push(("model".into(), false, String::new())),
    }

    Ok(rows)
}
