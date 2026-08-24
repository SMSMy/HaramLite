//! M2 — MDX-Net separation engine.
//!
//! Surgical port of audio-separator's `mdx_separator.py` + `uvr_lib_v5/stft.py`
//! for the UVR-MDX-NET-Voc_FT model. Constants are the exact values
//! audio-separator resolves at runtime for this model file:
//!
//! ```text
//! compensate=1.021, dim_f=3072, segment_size=256 (2^8), n_fft=7680
//! hop_length=1024, overlap=0.25 → chunk=261120, trim=3840, gen=253440
//! normalization_threshold=0.9, amplification_threshold=0.0
//! ```

use std::path::{Path, PathBuf};

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};

use crate::stft::{DIM_F, HOP, StftPlan};

pub const MODEL_FILENAME: &str = "UVR-MDX-NET-Voc_FT.onnx";

const COMPENSATE: f32 = 1.021;
const DIM_T: usize = 256; // time frames per chunk (2^8, == segment_size)
const CHUNK_SIZE: usize = HOP * (DIM_T - 1); // 261120
const TRIM: usize = crate::stft::TRIM; // 3840
const OVERLAP: f64 = 0.25;
const NORMALIZATION_THRESHOLD: f32 = 0.9;

#[derive(Debug)]
pub enum SepError {
    ModelMissing,
    Io(String),
    Inference(String),
    InvalidInput(String),
}

impl std::fmt::Display for SepError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ModelMissing => write!(f, "نموذج الفصل {MODEL_FILENAME} غير موجود في مجلد models"),
            Self::Io(e) => write!(f, "خطأ ملفات: {e}"),
            Self::Inference(e) => write!(f, "خطأ استدلال النموذج: {e}"),
            Self::InvalidInput(e) => write!(f, "مدخل غير صالح: {e}"),
        }
    }
}

impl From<std::io::Error> for SepError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

pub struct StemPaths {
    pub vocals: PathBuf,
    pub instrumental: PathBuf,
}

fn resolve_model() -> Result<PathBuf, SepError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("HARAMLITE_MODELS_DIR") {
        candidates.push(PathBuf::from(dir).join(MODEL_FILENAME));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("models").join(MODEL_FILENAME));
            for ancestor in parent.ancestors().skip(1) {
                candidates.push(ancestor.join("models").join(MODEL_FILENAME));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("../models").join(MODEL_FILENAME));
        candidates.push(cwd.join("models").join(MODEL_FILENAME));
    }
    candidates.into_iter().find(|c| c.is_file()).ok_or(SepError::ModelMissing)
}

/// Public wrapper for health checks (pipeline.rs).
pub fn resolve_model_pub() -> Result<PathBuf, SepError> {
    resolve_model()
}

/// Read a PCM WAV into stereo f32 channel buffers.
pub fn read_wav_stereo(path: &Path) -> Result<(Vec<f32>, Vec<f32>, u32), SepError> {
    let reader =
        WavReader::open(path).map_err(|e| SepError::InvalidInput(format!("{}: {e}", path.display())))?;
    let spec = reader.spec();
    if spec.channels != 2 {
        return Err(SepError::InvalidInput(format!(
            "المحرك يتطلب ستيريو (بعد التوحيد عبر normalize_for_engine)، الملف {}: {} قناة",
            path.display(),
            spec.channels
        )));
    }

    let flat: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => reader
            .into_samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| SepError::InvalidInput(e.to_string()))?,
        SampleFormat::Int => {
            let maxv = (1i64 << (spec.bits_per_sample.saturating_sub(1))) as f32;
            reader
                .into_samples::<i32>()
                .map(|s| s.map(|v| v as f32 / maxv))
                .collect::<Result<_, _>>()
                .map_err(|e| SepError::InvalidInput(e.to_string()))?
        }
    };

    let mut left = Vec::with_capacity(flat.len() / 2);
    let mut right = Vec::with_capacity(flat.len() / 2);
    for ch in flat.chunks(2) {
        left.push(ch[0]);
        right.push(*ch.get(1).unwrap_or(&ch[0]));
    }
    Ok((left, right, spec.sample_rate))
}

fn write_wav_stereo_f32(path: &Path, l: &[f32], r: &[f32], sr: u32) -> Result<(), SepError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let spec = WavSpec {
        channels: 2,
        sample_rate: sr,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut w = WavWriter::create(path, spec).map_err(|e| SepError::Io(format!("{}: {e}", path.display())))?;
    for (a, b) in l.iter().zip(r.iter()) {
        w.write_sample(*a).map_err(|e| SepError::Io(e.to_string()))?;
        w.write_sample(*b).map_err(|e| SepError::Io(e.to_string()))?;
    }
    w.finalize().map_err(|e| SepError::Io(e.to_string()))?;
    Ok(())
}

/// Public writer for sibling modules (effects.rs).
pub fn write_wav_stereo_f32_pub(path: &Path, l: &[f32], r: &[f32], sr: u32) -> Result<(), SepError> {
    write_wav_stereo_f32(path, l, r, sr)
}

/// spec_utils.normalize — scale peak down to threshold (never up; min_peak=0).
fn normalize(mix: &mut [Vec<f32>; 2]) -> f32 {
    let peak = mix
        .iter()
        .flat_map(|c| c.iter())
        .fold(0.0f32, |m, v| m.max(v.abs()));
    if peak > NORMALIZATION_THRESHOLD && peak > 0.0 {
        let g = NORMALIZATION_THRESHOLD / peak;
        for c in mix.iter_mut() {
            for v in c.iter_mut() {
                *v *= g;
            }
        }
    }
    peak
}

struct MdxSession {
    session: ort::session::Session,
    plan: StftPlan,
}

/// Name of the execution provider the active session uses ("DirectML"/"CPU").
pub static ACTIVE_PROVIDER: std::sync::OnceLock<String> = std::sync::OnceLock::new();

impl MdxSession {
    fn load() -> Result<Self, SepError> {
        let model_path = resolve_model()?;
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);

        // Globally initialize ORT with DirectML support (only succeeds the first time)
        use ort::execution_providers::{DirectMLExecutionProvider, ExecutionProvider};
        let _ = ort::init()
            .with_execution_providers([DirectMLExecutionProvider::default().build()])
            .commit();

        // GPU-first: DirectML works on ANY DX12 GPU (NVIDIA/AMD/Intel) with a
        // single lightweight DLL; CPU EP ships in the same binary as fallback.
        // If the DML session fails to initialize we rebuild a pure-CPU one.
        let build = |use_dml: bool| -> Result<ort::session::Session, SepError> {
            let mut b = ort::session::Session::builder()
                .map_err(|e| SepError::Inference(e.to_string()))?
                .with_intra_threads(threads)
                .map_err(|e| SepError::Inference(e.to_string()))?
                // silence ONNX Runtime's chatty session logs
                .with_log_level(ort::logging::LogLevel::Error)
                .map_err(|e| SepError::Inference(e.to_string()))?;
            if use_dml {
                use ort::execution_providers::{DirectMLExecutionProvider, ExecutionProvider};
                b = b
                    .with_execution_providers([DirectMLExecutionProvider::default().build()])
                    .map_err(|e| SepError::Inference(e.to_string()))?
                    // memory patterns are unsupported on DML
                    .with_memory_pattern(false)
                    .map_err(|e| SepError::Inference(e.to_string()))?;
            }
            b.commit_from_file(&model_path)
                .map_err(|e| SepError::Inference(format!("{}: {e}", model_path.display())))
        };

        let (session, provider) = match build(true) {
            Ok(s) => {
                tracing::info!(target: "sep", "execution provider: DirectML (GPU) ✓");
                (s, "DirectML")
            }
            Err(dml_err) => {
                tracing::warn!(target: "sep", "DirectML init failed ({dml_err}) — falling back to CPU");
                (build(false)?, "CPU")
            }
        };
        let _ = ACTIVE_PROVIDER.set(provider.to_string());
        tracing::info!(target: "sep", "ONNX session ready: {}", model_path.display());
        Ok(Self { session, plan: StftPlan::new() })
    }

    /// run_model(): STFT → zero bins<3 → ONNX → ISTFT. Chunk in/out [L,R].
    fn run_model(&mut self, chunk: &[Vec<f32>; 2]) -> Result<[Vec<f32>; 2], SepError> {
        let frames = DIM_T;

        // spek tensor [1,4,DIM_F,DIM_T]: rows ch0_re, ch0_im, ch1_re, ch1_im
        let mut spek = vec![0.0f32; 4 * DIM_F * frames];
        for c in 0..2 {
            let (re, im) = self.plan.forward(&chunk[c]);
            for (k, rowset) in [&re, &im].into_iter().enumerate() {
                for f in 3..DIM_F {
                    // bins <3 zeroed exactly like python (`spek[:,:,:3,:]*=0`)
                    let base = ((c * 2 + k) * DIM_F + f) * frames;
                    spek[base..base + frames].copy_from_slice(&rowset[f]);
                }
            }
        }

        let input = ort::value::Tensor::from_array(([1usize, 4, DIM_F, frames], spek))
            .map_err(|e| SepError::Inference(e.to_string()))?;
        let outputs = self
            .session
            .run(ort::inputs!["input" => input])
            .map_err(|e| SepError::Inference(e.to_string()))?;
        let (shape, pred) = outputs["output"]
            .try_extract_tensor::<f32>()
            .map_err(|e| SepError::Inference(e.to_string()))?;
        if shape.as_ref() != [1i64, 4, DIM_F as i64, frames as i64] {
            return Err(SepError::Inference(format!("unexpected output shape {shape:?}")));
        }

        let mut out = [
            vec![0.0f32; CHUNK_SIZE],
            vec![0.0f32; CHUNK_SIZE],
        ];
        for c in 0..2 {
            let mut re = vec![vec![0.0f32; frames]; DIM_F];
            let mut im = vec![vec![0.0f32; frames]; DIM_F];
            for (k, rowset) in [&mut re, &mut im].into_iter().enumerate() {
                for f in 0..DIM_F {
                    let base = ((c * 2 + k) * DIM_F + f) * frames;
                    rowset[f].copy_from_slice(&pred[base..base + frames]);
                }
            }
            out[c] = self.plan.inverse(&re, &im, frames);
        }
        Ok(out)
    }
}

/// demix(): overlapping-window accumulation loop, exact port of python demix.
fn demix(session: &mut MdxSession, mix: &[Vec<f32>; 2], progress: &dyn Fn(f32)) -> Result<Vec<Vec<f32>>, SepError> {
    let n = mix[0].len();
    let gen_size = CHUNK_SIZE - 2 * TRIM;
    let pad = gen_size + TRIM - (n % gen_size);

    let mixture_len = TRIM + n + pad;
    let mut mixture = [
        vec![0.0f32; mixture_len],
        vec![0.0f32; mixture_len],
    ];
    for c in 0..2 {
        mixture[c][TRIM..TRIM + n].copy_from_slice(&mix[c]);
    }

    let step = ((1.0 - OVERLAP) * CHUNK_SIZE as f64) as usize;
    let total_steps = (mixture_len + step - 1) / step;

    // hanning window over the ACTUAL chunk length (np.hanning = symmetric)
    let mut result = [vec![0.0f32; mixture_len], vec![0.0f32; mixture_len]];
    let mut divider = vec![0.0f32; mixture_len];

    let mut done = 0usize;
    let mut i = 0usize;
    while i < mixture_len {
        let end = (i + CHUNK_SIZE).min(mixture_len);
        let actual = end - i;

        // np.hanning(actual): symmetric hann
        let window: Vec<f32> = (0..actual)
            .map(|k| 0.5f32 - 0.5 * (2.0 * std::f32::consts::PI * k as f32 / actual as f32).cos())
            .collect();

        // zero-pad tail to CHUNK_SIZE
        let mut part = [vec![0.0f32; CHUNK_SIZE], vec![0.0f32; CHUNK_SIZE]];
        for c in 0..2 {
            part[c][..actual].copy_from_slice(&mixture[c][i..end]);
        }

        let tar = session.run_model(&part)?;

        for c in 0..2 {
            for k in 0..actual {
                result[c][i + k] += tar[c][k] * window[k];
            }
        }
        for k in 0..actual {
            divider[i + k] += window[k];
        }

        done += 1;
        progress(done as f32 / total_steps as f32);
        i += step;
    }

    // result/divider then drop trim on both ends and crop to original length
    let mut source = [vec![0.0f32; n], vec![0.0f32; n]];
    for c in 0..2 {
        for j in 0..n {
            let p = TRIM + j;
            let d = divider[p];
            source[c][j] = if d > 1e-9 { result[c][p] / d } else { 0.0 };
        }
    }
    Ok(source.into_iter().map(|c| c).collect())
}

/// Full separation: normalized stereo WAV in → vocals + instrumental WAVs out.
pub fn separate(
    input_wav: &Path,
    out_dir: &Path,
    progress: &dyn Fn(f32),
) -> Result<StemPaths, SepError> {
    let (left, right, sample_rate) = read_wav_stereo(input_wav)?;
    tracing::info!(target: "sep", "mix loaded: {} samples @{}", left.len(), sample_rate);

    let mut mix = [left, right];
    let peak = normalize(&mut mix);

    let mut session = MdxSession::load()?;
    let vocals_src = demix(&mut session, &mix, &progress)?;

    // restore original scale, build secondary stem by subtraction
    let stem_name = input_wav
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "audio".into());

    let mut vocals = [vec![0.0f32; vocals_src[0].len()], vec![0.0f32; vocals_src[1].len()]];
    for c in 0..2 {
        for (v, s) in vocals[c].iter_mut().zip(vocals_src[c].iter()) {
            *v = s * peak;
        }
    }

    let instrumental = [
        (0..mix[0].len())
            .map(|j| mix[0][j] - vocals[0][j] * COMPENSATE)
            .collect::<Vec<_>>(),
        (0..mix[1].len())
            .map(|j| mix[1][j] - vocals[1][j] * COMPENSATE)
            .collect::<Vec<_>>(),
    ];

    std::fs::create_dir_all(out_dir)?;
    let vocals_path = out_dir.join(format!("{stem_name}_(Vocals)_haramlite.wav"));
    let instr_path = out_dir.join(format!("{stem_name}_(Instrumental)_haramlite.wav"));

    write_wav_stereo_f32(&vocals_path, &vocals[0], &vocals[1], sample_rate)?;
    write_wav_stereo_f32(&instr_path, &instrumental[0], &instrumental[1], sample_rate)?;

    tracing::info!(target: "sep", "stems written:\n  {}\n  {}", vocals_path.display(), instr_path.display());
    Ok(StemPaths { vocals: vocals_path, instrumental: instr_path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_tone_mixture_end_to_end() {
        let tmp = std::env::temp_dir().join(format!("hl_sep_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();

        // fake "song": low bass + mid tone (music-ish) across both channels
        let len = CHUNK_SIZE + HOP * 7; // forces multiple chunks incl. partial
        let mut l = Vec::with_capacity(len);
        let mut r = Vec::with_capacity(len);
        for n in 0..len {
            let t = n as f32 / 44100.0;
            let bass = 0.3 * (2.0 * std::f32::consts::PI * 90.0 * t).sin();
            let lead = 0.25 * (2.0 * std::f32::consts::PI * 880.0 * t).sin();
            l.push((bass + lead).min(0.95));
            r.push((bass * 0.9 + lead * 0.95).min(0.95));
        }
        let wav_path = tmp.join("mix.wav");
        write_wav_stereo_f32(&wav_path, &l, &r, 44100).unwrap();

        let out_dir = tmp.join("out");
        let stems = separate(&wav_path, &out_dir, &|p| {
            tracing::debug!(target: "sep_test", "progress {:.0}%", p * 100.0)
        })
        .expect("separation failed");

        for stem in [&stems.vocals, &stems.instrumental] {
            let (cl, cr, sr) = read_wav_stereo(stem).unwrap();
            assert_eq!(sr, 44100);
            assert_eq!(cl.len(), len, "{} length mismatch", stem.display());
            let energy: f32 = cl.iter().map(|v| v * v).sum();
            assert!(energy.is_finite() && energy > 0.0, "{} silent/non-finite", stem.display());
        }

        std::fs::remove_dir_all(&tmp).ok();
    }
}
