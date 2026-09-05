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

// Functional fix: ORT reports execution-provider load failures ONLY as
// tracing ERROR events while the session builder still returns Ok — the old
// code then logged "CUDA ✓" and silently ran on CPU. This thread-local flag
// captures the truth per build attempt via a scoped dispatcher override
// (thread-local, so concurrent separations cannot race each other).
thread_local! {
    static EP_LOAD_FAILED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static EP_FIRST_ERROR: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Minimal field grabber so the FIRST ort error survives for diagnostics
/// (the watcher intentionally hides the per-build chatter from the log).
struct EpFieldGrab(String);

impl tracing::field::Visit for EpFieldGrab {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        use std::fmt::Write;
        let _ = write!(self.0, "{}={:?} ", field.name(), value);
    }
}

struct EpWatchLayer;

impl<S> tracing_subscriber::Layer<S> for EpWatchLayer
where
    S: tracing::Subscriber + for<'span> tracing_subscriber::registry::LookupSpan<'span>,
{
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        if *event.metadata().level() == tracing::Level::ERROR
            && event.metadata().target().starts_with("ort")
        {
            EP_LOAD_FAILED.with(|f| f.set(true));
            EP_FIRST_ERROR.with(|slot| {
                if slot.borrow().is_none() {
                    let mut v = EpFieldGrab(String::new());
                    event.record(&mut v);
                    *slot.borrow_mut() =
                        Some(format!("{} {}", event.metadata().target(), v.0));
                }
            });
        }
    }
}

/// The first captured ort error text (if any) from the last watched span.
fn ep_first_error() -> Option<String> {
    EP_FIRST_ERROR.with(|slot| slot.borrow().clone())
}

/// Run `f` with provider-load errors watched. Returns `(result, ep_failed)`.
/// NOTE: events emitted inside `f` go only to the watcher (the global log
/// loses the noisy per-build ORT chatter — errors that matter surface as the
/// flag plus explicit warn logs by the caller).
fn watch_ep_errors<T>(f: impl FnOnce() -> T) -> (T, bool) {
    use tracing_subscriber::prelude::__tracing_subscriber_SubscriberExt;
    EP_LOAD_FAILED.with(|f| f.set(false));
    EP_FIRST_ERROR.with(|slot| *slot.borrow_mut() = None);
    let sub = tracing_subscriber::registry().with(EpWatchLayer);
    let dispatch = tracing::dispatcher::Dispatch::new(sub);
    let _guard = tracing::dispatcher::set_default(&dispatch);
    let r = f();
    (r, EP_LOAD_FAILED.with(|f| f.get()))
}

/// Audit R-2 (corrected): commit the ORT environment ONCE at startup with NO
/// env-level providers. Session-level `with_execution_providers` takes
/// precedence over the environment's anyway (ort docs), and registering the
/// same provider at BOTH levels made every DML session fail with
/// "already been registered" → silent CPU fallback. Session-level
/// registration is per-session-options, so it is repeatable across files and
/// picks CUDA/DML exactly where the original working code did it.
static ORT_ENV_INIT: std::sync::Once = std::sync::Once::new();

/// Commit the ORT environment once (idempotent). Call at startup BEFORE any
/// separation — including the watch folder's first sweep.
pub fn init_ort_env() {
    ORT_ENV_INIT.call_once(|| {
        match ort::init().commit() {
            Ok(_) => tracing::info!(target: "sep", "ORT environment committed"),
            Err(e) => tracing::error!(target: "sep", "ORT environment commit failed: {e}"),
        }
    });
}

/// UI-starvation guard: ORT inference used to take ALL logical cores while
/// x264 + DSP burned the rest, blacking out the window (DWM starvation).
/// Keep two cores of breathing room; tiny boxes keep at least four threads
/// so inference itself never collapses.
pub(crate) fn inference_threads(total: usize) -> usize {
    if total <= 4 {
        total.max(1)
    } else {
        total - 2
    }
}

impl MdxSession {
    fn load(use_cuda: bool) -> Result<Self, SepError> {
        let model_path = resolve_model()?;
        let threads = inference_threads(
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4),
        );

        // Audit R-2 (corrected): the environment is committed once at startup
        // with NO providers; every session registers its own (CUDA/DML) on its
        // own options — no conflicts. CUDA_RUNTIME_PLAN (condition 3): only
        // attempt CUDA when the self-downloaded runtime DLLs actually exist —
        // otherwise skip straight to DirectML with an honest warning (a CUDA
        // session build would "succeed" on CPU while the log claimed CUDA).
        let try_cuda = use_cuda && crate::cuda_runtime::is_available();
        if use_cuda && !try_cuda {
            tracing::warn!(
                target: "sep",
                "CUDA طُلبت لكن مكتبات تشغيل CUDA غير مثبتة — سيُستخدم DirectML"
            );
        }
        let build = |provider_type: &str| -> Result<ort::session::Session, SepError> {
            let mut b = ort::session::Session::builder()
                .map_err(|e| SepError::Inference(e.to_string()))?
                .with_intra_threads(threads)
                .map_err(|e| SepError::Inference(e.to_string()))?
                .with_log_level(ort::logging::LogLevel::Error)
                .map_err(|e| SepError::Inference(e.to_string()))?;

            if provider_type == "cuda" {
                use ort::execution_providers::CUDAExecutionProvider;
                b = b.with_execution_providers([CUDAExecutionProvider::default().build()])
                    .map_err(|e| SepError::Inference(e.to_string()))?;
            } else if provider_type == "dml" {
                use ort::execution_providers::DirectMLExecutionProvider;
                b = b
                    .with_execution_providers([DirectMLExecutionProvider::default().build()])
                    .map_err(|e| SepError::Inference(e.to_string()))?
                    .with_memory_pattern(false)
                    .map_err(|e| SepError::Inference(e.to_string()))?;
            }

            b.commit_from_file(&model_path)
                .map_err(|e| SepError::Inference(format!("{}: {e}", model_path.display())))
        };

        let t_session = std::time::Instant::now();
        let mut provider_name = "CPU";

        // A provider counts ONLY if ORT truly registered it: a builder Ok
        // with a load ERROR underneath used to masquerade CPU as CUDA.
        let attempt = |provider_type: &str| -> Option<ort::session::Session> {
            let (res, ep_failed) = watch_ep_errors(|| build(provider_type));
            match res {
                Ok(s) if !ep_failed => Some(s),
                Ok(s) => {
                    drop(s);
                    tracing::warn!(
                        target: "sep",
                        "{provider_type} بدا ناجحاً لكن مزوده لم يُحمّل — يُتجاهل بصراحة{}",
                        ep_first_error().map(|e| format!(": {e}")).unwrap_or_default()
                    );
                    None
                }
                Err(e) => {
                    tracing::warn!(target: "sep", "فشل تهيئة {provider_type} ({e})");
                    None
                }
            }
        };
        let ready = |label: &str| {
            tracing::info!(
                target: "sep",
                "execution provider: {label} ✓ ({:.1}s)",
                t_session.elapsed().as_secs_f32()
            );
        };

        let session = if try_cuda {
            if let Some(s) = attempt("cuda") {
                ready("CUDA (NVIDIA GPU)");
                provider_name = "CUDA";
                s
            } else if let Some(s) = attempt("dml") {
                tracing::warn!(target: "sep", "CUDA غير صالح — التراجع لـ DirectML");
                ready("DirectML (GPU)");
                provider_name = "DirectML";
                s
            } else {
                tracing::warn!(target: "sep", "DirectML غير صالح — التراجع لـ CPU");
                let s = attempt("cpu").ok_or_else(|| {
                    SepError::Inference("تعذر إنشاء جلسة الاستدلال حتى على CPU".into())
                })?;
                ready("CPU");
                s
            }
        } else if let Some(s) = attempt("dml") {
            ready("DirectML (GPU)");
            provider_name = "DirectML";
            s
        } else {
            tracing::warn!(target: "sep", "DirectML init failed — falling back to CPU");
            let s = attempt("cpu").ok_or_else(|| {
                SepError::Inference("تعذر إنشاء جلسة الاستدلال حتى على CPU".into())
            })?;
            ready("CPU");
            s
        };

        let _ = ACTIVE_PROVIDER.set(provider_name.to_string());
        tracing::info!(target: "sep", "ONNX session ready in {:.1}s: {}", t_session.elapsed().as_secs_f32(), model_path.display());
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
fn demix(
    session: &mut MdxSession,
    mix: &[Vec<f32>; 2],
    progress: &dyn Fn(f32) -> bool,
) -> Result<[Vec<f32>; 2], SepError> {
    let mixture_len = mix[0].len();
    let n = mixture_len;

    // pad exactly TRIM samples on both ends (MDX-Net requirement)
    let padded_len = mixture_len + 2 * TRIM;
    let mut mixture = [vec![0.0f32; padded_len], vec![0.0f32; padded_len]];
    for c in 0..2 {
        mixture[c][TRIM..TRIM + n].copy_from_slice(&mix[c]);
    }

    let step = ((1.0 - OVERLAP) * CHUNK_SIZE as f64) as usize;
    let total_steps = (padded_len + step - 1) / step;

    // hanning window over the ACTUAL chunk length (np.hanning = symmetric)
    let mut result = [vec![0.0f32; padded_len], vec![0.0f32; padded_len]];
    let mut divider = vec![0.0f32; padded_len];

    let mut done = 0usize;
    let mut i = 0usize;
    while i < padded_len {
        let end = (i + CHUNK_SIZE).min(padded_len);
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
        if !progress(done as f32 / total_steps as f32) {
            return Err(SepError::Inference("تم إلغاء المعالجة من قبل المستخدم.".into()));
        }
        i += step;
    }

    let mut source = [vec![0.0f32; n], vec![0.0f32; n]];
    for c in 0..2 {
        for j in 0..n {
            let p = TRIM + j;
            let d = divider[p];
            source[c][j] = if d > 1e-9 { result[c][p] / d } else { 0.0 };
        }
    }
    Ok(source)
}

/// Full separation: normalized stereo WAV in → vocals + instrumental WAVs out.
pub fn separate(
    input_wav: &Path,
    out_dir: &Path,
    use_cuda: bool,
    progress: &dyn Fn(f32) -> bool,
) -> Result<StemPaths, SepError> {
    let (left, right, sample_rate) = read_wav_stereo(input_wav)?;
    tracing::info!(target: "sep", "mix loaded: {} samples @{}", left.len(), sample_rate);

    let mut mix = [left, right];
    let peak = normalize(&mut mix);

    let mut session = MdxSession::load(use_cuda)?;
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
        let stems = separate(&wav_path, &out_dir, false, &|p| {
            tracing::debug!(target: "sep_test", "progress {:.0}%", p * 100.0);
            true
        })
        .expect("separation failed");

        for stem in [&stems.vocals, &stems.instrumental] {
            let (cl, _cr, sr) = read_wav_stereo(stem).unwrap();
            assert_eq!(sr, 44100);
            assert_eq!(cl.len(), len, "{} length mismatch", stem.display());
            let energy: f32 = cl.iter().map(|v| v * v).sum();
            assert!(energy.is_finite() && energy > 0.0, "{} silent/non-finite", stem.display());
        }

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// Breathing room for the UI thread: 20→18, 8→6, tiny boxes untouched.
    #[test]
    fn inference_threads_leaves_air() {
        assert_eq!(inference_threads(20), 18);
        assert_eq!(inference_threads(8), 6);
        assert_eq!(inference_threads(4), 4);
        assert_eq!(inference_threads(2), 2);
        assert_eq!(inference_threads(1), 1);
    }

    /// Functional fix: the EP watcher must catch ORT error events (the exact
    /// signal a silently-failing CUDA registration emits) and stay quiet
    /// otherwise — no GPU needed to prove the plumbing.
    #[test]
    fn ep_watcher_catches_ort_errors() {
        let (_, failed) = watch_ep_errors(|| {
            tracing::error!(target: "ort::execution_providers", "synthetic load failure");
        });
        assert!(failed, "watcher must flag ort ERROR events");
        let (_, failed) = watch_ep_errors(|| {
            tracing::info!(target: "sep", "quiet build");
        });
        assert!(!failed, "watcher must stay quiet without ort errors");
    }

    /// Live proof (needs the full 10-file runtime beside the test binary +
    /// an NVIDIA GPU + the model; otherwise it skips loudly, never fails):
    /// a CUDA session must build AND register with zero ort errors — this is
    /// what caught the missing-cufft / stub-shadowing era.
    #[test]
    fn cuda_ep_registers_with_shipped_runtime() {
        // Mirror production (`ensure_dll_path`): sweep exe-dir stubs recreated
        // by every cargo build, and put our bin on the loader search path via
        // SetDllDirectory (thread-safe API — never `set_var(PATH)` next to
        // the harness's parallel test threads).
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                crate::cuda_runtime::sweep_provider_stubs_in(exe_dir);
                #[cfg(target_os = "windows")]
                {
                    use windows_sys::Win32::System::LibraryLoader::SetDllDirectoryW;
                    let bin = exe_dir.join("bin");
                    let wide: Vec<u16> = bin.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
                    unsafe {
                        let _ = SetDllDirectoryW(wide.as_ptr());
                    }
                }
            }
        }
        if !crate::cuda_runtime::is_available() {
            eprintln!("skipping live CUDA registration: runtime absent beside test binary");
            return;
        }
        if !crate::cuda_runtime::nvidia_gpu_present() {
            eprintln!("skipping live CUDA registration: no NVIDIA GPU");
            return;
        }
        let model = match resolve_model() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("skipping live CUDA registration: model file absent");
                return;
            }
        };
        let (res, failed) = watch_ep_errors(|| {
            (|| -> Result<ort::session::Session, SepError> {
                let b = ort::session::Session::builder()
                    .map_err(|e| SepError::Inference(e.to_string()))?;
                let b = b
                    .with_execution_providers([
                        ort::execution_providers::CUDAExecutionProvider::default().build(),
                    ])
                    .map_err(|e| SepError::Inference(e.to_string()))?;
                b.commit_from_file(&model)
                    .map_err(|e| SepError::Inference(e.to_string()))
            })()
        });
        assert!(res.is_ok(), "CUDA session must build with the full runtime");
        assert!(
            !failed,
            "CUDA EP must register with zero ort errors, got: {}",
            ep_first_error().unwrap_or_default()
        );
    }

    /// Live end-to-end proof on real GPU silicon (ignored by default — needs
    /// GPU + model + the 16-file runtime + ~1min). Run explicitly:
    /// `cargo test --lib cuda_full_separation_smoke -- --ignored --nocapture`.
    /// This is what finally closed the "slow CPU" report: honest CUDA ✓.
    #[test]
    #[ignore]
    fn cuda_full_separation_smoke() {
        if !crate::cuda_runtime::is_available() {
            eprintln!("skipping smoke: no CUDA runtime beside test binary");
            return;
        }
        if !crate::cuda_runtime::nvidia_gpu_present() {
            eprintln!("skipping smoke: no NVIDIA GPU");
            return;
        }
        let tmp = std::env::temp_dir().join(format!("hl_cuda_smoke_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let sr = 44100u32;
        let len = sr as usize * 12;
        let mut l = Vec::with_capacity(len);
        let mut r = Vec::with_capacity(len);
        for n in 0..len {
            let t = n as f32 / sr as f32;
            l.push(0.3 * (2.0 * std::f32::consts::PI * 220.0 * t).sin());
            r.push(0.3 * (2.0 * std::f32::consts::PI * 330.0 * t).sin());
        }
        let wav = tmp.join("mix.wav");
        write_wav_stereo_f32(&wav, &l, &r, sr).unwrap();
        let t0 = std::time::Instant::now();
        let stems = separate(&wav, &tmp.join("out"), true, &|_| true).expect("CUDA separation");
        eprintln!("SMOKE: 12s audio separated on CUDA in {:.1}s", t0.elapsed().as_secs_f32());
        for stem in [&stems.vocals, &stems.instrumental] {
            let (cl, _, _) = read_wav_stereo(stem).unwrap();
            let energy: f32 = cl.iter().map(|v| v * v).sum();
            assert!(energy.is_finite() && energy > 0.0, "{} bad stem", stem.display());
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// CUDA_RUNTIME_PLAN (condition 3): requesting CUDA on a machine without
    /// the runtime DLLs must yield a WORKING session (DirectML/CPU fallback),
    /// never a panic or a CUDA-flavored failure.
    #[test]
    fn cuda_request_without_runtime_falls_back_gracefully() {
        if crate::cuda_runtime::is_available() {
            // machine HAS the runtime: plain CUDA session should also work
            match MdxSession::load(true) {
                Ok(_) => {}
                Err(e) => panic!("cuda session failed on a cuda-ready machine: {e}"),
            }
        } else {
            match MdxSession::load(true) {
                Ok(_) => {} // DML or CPU — fine
                Err(SepError::Inference(e)) if e.to_lowercase().contains("cuda") => {
                    panic!("must fall back, not fail with a CUDA error: {e}")
                }
                Err(e) => panic!("unexpected error: {e}"),
            }
        }
    }
}
