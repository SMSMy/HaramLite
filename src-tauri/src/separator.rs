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
use crate::{decide, livemap, silence};

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

/// فصل قناتَي المزيج الستيريو أثناء القراءة (يُستدعى من `read_wav_stereo`).
///
/// Audit 2026-09-15 (٤.ج): فصل القناتين **أثناء** القراءة.
///
/// قبل: يُقرأ المزيج كاملاً في `flat` (N) ثم يُوزَّع على `left`/`right` (N/2+N/2)
/// ⇒ ثلاث نسخ حيّة في الذروة = عيّنتان لكل عيّنة مدخل (2N). بعد: قناتان فقط
/// (N) — والبيانات المُعادة مطابقة تماماً، بما فيها العيّنة الأخيرة اليتيمة
/// (طول فردي) التي كانت `ch.get(1).unwrap_or(&ch[0])` تنسخها للقناتين.
///
/// القياس الفعلي (ذروة مجموعة عمل العملية، ملف ستيريو ٥ دقائق float32 =
/// ‏105.8MB حمولة، rustc 1.95 على ويندوز): ‏213.5MB ← ‏112.5MB، وبصمة المحتوى
/// (fnv1a على القناتين) مطابقة قبل وبعد.
fn deinterleave<I>(samples: I, per_channel: usize) -> Result<(Vec<f32>, Vec<f32>), SepError>
where
    I: Iterator<Item = Result<f32, hound::Error>>,
{
    let mut it = samples;
    let mut left = Vec::with_capacity(per_channel);
    let mut right = Vec::with_capacity(per_channel);
    while let Some(a) = it.next() {
        let a = a.map_err(|e| SepError::InvalidInput(e.to_string()))?;
        match it.next() {
            Some(b) => right.push(b.map_err(|e| SepError::InvalidInput(e.to_string()))?),
            None => right.push(a),
        }
        left.push(a);
    }
    Ok((left, right))
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

    // `len()` = عدد القيم في الملف (المدة × القنوات): حجز مسبق لكل قناة بدل
    // النمو التدريجي (وهو ما كان `with_capacity(flat.len()/2)` يفعله).
    let per_channel = reader.len() as usize / 2;
    let (left, right) = match spec.sample_format {
        SampleFormat::Float => deinterleave(reader.into_samples::<f32>(), per_channel)?,
        SampleFormat::Int => {
            let maxv = (1i64 << (spec.bits_per_sample.saturating_sub(1))) as f32;
            deinterleave(
                reader.into_samples::<i32>().map(|s| s.map(|v| v as f32 / maxv)),
                per_channel,
            )?
        }
    };

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
    if peak > NORMALIZATION_THRESHOLD {
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

/// Expert D2د: provider truth for the bridge status (CPU-only policy).
/// Written best-effort on every session load; the native host (a separate
/// process that cannot see ACTIVE_PROVIDER) reads this file to announce the
/// provider — and honest durations — to the extension page.
pub fn provider_file() -> PathBuf {
    provider_file_in(&crate::paths::data_dir())
}

/// Pure path join (unit-tested); production passes the app-data base.
pub fn provider_file_in(base: &Path) -> PathBuf {
    base.join("provider.json")
}

pub fn record_provider_in(base: &Path, name: &str) {
    let p = provider_file_in(base);
    if std::fs::create_dir_all(base).is_err() {
        return;
    }
    let _ = std::fs::write(&p, serde_json::json!({ "provider": name }).to_string());
}

pub fn record_provider(name: &str) {
    if let Some(base) = provider_file().parent().map(|p| p.to_path_buf()) {
        record_provider_in(&base, name);
    }
}

/// None on missing/corrupt file — the page treats unknown as unannounced.
pub fn read_provider_in(path: &Path) -> Option<String> {
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&s)
        .ok()?
        .get("provider")?
        .as_str()
        .map(|s| s.to_string())
}

pub fn read_provider() -> Option<String> {
    read_provider_in(&provider_file())
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
        //
        // ROADMAP §٧.ب بند ٩: the single `is_available()` gate conflated three
        // different causes (no NVIDIA card / no driver / incomplete or
        // mismatched libraries) into one line that named none of them. The
        // diagnosis below names the actual cause; the CHAIN ITSELF IS UNCHANGED
        // (CUDA → DirectML → CPU, or DirectML → CPU when CUDA cannot be
        // attempted).
        //
        // ONE deliberate behaviour delta, pinned by
        // `complete_runtime_attempts_cuda_and_defers_failure_to_the_chain`: the
        // old gate looked at the sixteen files ONLY, so a machine with a
        // complete runtime and no NVIDIA driver (`nvcuda.dll` absent from
        // System32) still built a CUDA provider that could never register, then
        // fell back. That doomed build is no longer attempted. The final
        // provider is the same (DirectML), one wasted build is saved, and the
        // log now names the real cause. AUDIT.md records this delta as the only
        // behaviour change of item ٩.
        let diag = crate::cuda_runtime::current_diagnosis(use_cuda);
        let cuda_plan = crate::cuda_runtime::plan(&diag);
        let try_cuda = cuda_plan.attempt_cuda;
        if use_cuda {
            // `warn` (not `info`) when CUDA was asked for and will not be
            // attempted: that is the case the user must be able to find, and it
            // is the level the previous single-line message used. A ready CUDA
            // is the expected outcome and stays at `info`.
            if cuda_plan.attempt_cuda {
                tracing::info!(
                    target: "sep",
                    "تشخيص CUDA: {} | السلسلة: {}",
                    diag.message(),
                    cuda_plan.provider_chain
                );
            } else {
                tracing::warn!(
                    target: "sep",
                    "تشخيص CUDA: {} | السلسلة: {}",
                    diag.message(),
                    cuda_plan.provider_chain
                );
            }
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
                tracing::warn!(
                    target: "sep",
                    "CUDA غير صالحة على هذا الجهاز (تعريف أقدم أو cuDNN غير مطابق أو تهيئة فاشلة) — التراجع إلى DirectML، والمعالجة تكمل بلا توقف"
                );
                ready("DirectML (GPU)");
                provider_name = "DirectML";
                s
            } else {
                tracing::warn!(
                    target: "sep",
                    "DirectML غير صالحة أيضاً — التراجع إلى CPU، والمعالجة تكمل بلا توقف"
                );
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
            tracing::warn!(
                target: "sep",
                "تعذّر تحميل DirectML — التراجع إلى CPU، والمعالجة تكمل بلا توقف"
            );
            let s = attempt("cpu").ok_or_else(|| {
                SepError::Inference("تعذر إنشاء جلسة الاستدلال حتى على CPU".into())
            })?;
            ready("CPU");
            s
        };

        let _ = ACTIVE_PROVIDER.set(provider_name.to_string());
        record_provider(provider_name);
        tracing::info!(target: "sep", "ONNX session ready in {:.1}s: {}", t_session.elapsed().as_secs_f32(), model_path.display());
        Ok(Self { session, plan: StftPlan::new() })
    }

    /// run_model(): STFT → zero bins<3 → ONNX → ISTFT. Chunk in/out [L,R].
    fn run_model(&mut self, chunk: &[Vec<f32>; 2]) -> Result<[Vec<f32>; 2], SepError> {
        let frames = DIM_T;

        // spek tensor [1,4,DIM_F,DIM_T]: rows ch0_re, ch0_im, ch1_re, ch1_im
        let mut spek = vec![0.0f32; 4 * DIM_F * frames];
        for (c, chan) in chunk.iter().enumerate() {
            let (re, im) = self.plan.forward(chan);
            for (k, rowset) in [&re, &im].into_iter().enumerate() {
                for (f, row) in rowset.iter().enumerate().skip(3) {
                    // bins <3 zeroed exactly like python (`spek[:,:,:3,:]*=0`)
                    let base = ((c * 2 + k) * DIM_F + f) * frames;
                    spek[base..base + frames].copy_from_slice(row);
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
        for (c, out_c) in out.iter_mut().enumerate() {
            let mut re = vec![vec![0.0f32; frames]; DIM_F];
            let mut im = vec![vec![0.0f32; frames]; DIM_F];
            for (k, rowset) in [&mut re, &mut im].into_iter().enumerate() {
                for (f, row) in rowset.iter_mut().enumerate() {
                    let base = ((c * 2 + k) * DIM_F + f) * frames;
                    row.copy_from_slice(&pred[base..base + frames]);
                }
            }
            *out_c = self.plan.inverse(&re, &im, frames);
        }
        Ok(out)
    }
}

/// UVR5 separate.py:560 padding (pure, unit-tested):
/// `pad = gen_size + trim - (L % gen_size)`, `padded = trim + L + pad`.
fn demix_padding(n: usize) -> (usize, usize) {
    let gen_size = CHUNK_SIZE - 2 * TRIM;
    let pad = gen_size + TRIM - (n % gen_size);
    (pad, TRIM + n + pad)
}

/// demix(): overlapping-window accumulation loop, exact port of python demix.
fn demix(
    session: &mut MdxSession,
    mix: &[Vec<f32>; 2],
    progress: &dyn Fn(f32) -> bool,
) -> Result<[Vec<f32>; 2], SepError> {
    let mixture_len = mix[0].len();
    let n = mixture_len;

    // UVR5 separate.py:560 + audio-separator mdx_separator.py:342:
    // pad = gen_size + trim - (L % gen_size); mixture = zeros(trim) + mix + zeros(pad).
    // (The old 2*TRIM-only tail under-padded file tails vs the reference.)
    let (_pad, padded_len) = demix_padding(n);
    let mut mixture = [vec![0.0f32; padded_len], vec![0.0f32; padded_len]];
    for c in 0..2 {
        mixture[c][TRIM..TRIM + n].copy_from_slice(&mix[c]);
    }

    let step = ((1.0 - OVERLAP) * CHUNK_SIZE as f64) as usize;
    let total_steps = padded_len.div_ceil(step);

    // hanning window over the ACTUAL chunk length (np.hanning = symmetric)
    let mut result = [vec![0.0f32; padded_len], vec![0.0f32; padded_len]];
    let mut divider = vec![0.0f32; padded_len];

    let mut done = 0usize;
    let mut i = 0usize;
    // Audit 2026-09-15 (٤.ج): نافذة الهانين كانت تُبنى من جديد في كل تكرار
    // (CHUNK_SIZE = 261120 × 4 بايت = 1,044,480 بايت ≈ 1020 KiB لكل مقطع — لا
    // 261KB كما قيل في الطلب — أي عشرات الميغابايت تخصيصاً/تحريراً على ملف
    // طويل). المخزن الآن واحد خارج الحلقة، ويُعاد حساب أول `actual` عنصر فيه
    // فقط — ونفس القيم بالحساب نفسه، والعناصر بعد `actual` لا تُقرأ أصلاً
    // (`window[k]` يُستخدم لـ `k < actual` وحده).
    let mut window = vec![0.0f32; CHUNK_SIZE];
    while i < padded_len {
        let end = (i + CHUNK_SIZE).min(padded_len);
        let actual = end - i;

        // np.hanning(actual): symmetric hann
        for (k, w) in window.iter_mut().enumerate().take(actual) {
            *w = 0.5f32 - 0.5 * (2.0 * std::f32::consts::PI * k as f32 / actual as f32).cos();
        }

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
    for (c, source_c) in source.iter_mut().enumerate() {
        for (j, s) in source_c.iter_mut().enumerate() {
            let p = TRIM + j;
            let d = divider[p];
            *s = if d > 1e-9 { result[c][p] / d } else { 0.0 };
        }
    }
    Ok(source)
}

/// Expert D2أ/D2ب: whole-mix analysis from the normalized WAV (seconds
/// against MDX minutes — always logged by the caller, never silent).
/// - `dense`: sustained-music gate (≥6 consecutive conf>0.5 windows) → the
///   clip deserves FULL MDX; sparser mixes go detect-then-mute.
/// - `suspect`: kept (non-silence) spans ± [`SUSPECT_PAD_SECS`] padding,
///   merged and clamped — diagnostics only since step-1 (A); separate()
///   infers on the whole file per UVR5 :499. The clip density gate in
///   pipeline.rs still reads `dense`/`suspect` for its own routing.
pub struct MixAnalysis {
    pub dense: bool,
    pub suspect: Vec<(usize, usize)>,
    pub scored_windows: usize,
}

/// Padding around every suspect span so MDX context (STFT windows, model
/// receptive field) never starves at the edges.
pub const SUSPECT_PAD_SECS: f64 = 2.0;

pub fn analyze_mix(l: &[f32], r: &[f32], sr: u32) -> MixAnalysis {
    let n = l.len().min(r.len());
    let mut out = MixAnalysis { dense: false, suspect: Vec::new(), scored_windows: 0 };
    if n == 0 || sr == 0 {
        return out;
    }
    // Suspect spans from the silence map (sample-exact kept ranges).
    let kept = silence::compute_kept_ranges(l, r, sr, &silence::SilenceConfig::default());
    let pad = (SUSPECT_PAD_SECS * sr as f64) as usize;
    let mut spans: Vec<(usize, usize)> = kept
        .into_iter()
        .map(|(a, b)| (a.saturating_sub(pad), (b + pad).min(n)))
        .filter(|(a, b)| b > a)
        .collect();
    spans.sort();
    for (a, b) in spans {
        if let Some(last) = out.suspect.last_mut() {
            if a <= last.1 {
                last.1 = last.1.max(b);
                continue;
            }
        }
        out.suspect.push((a, b));
    }
    // Density confidences over the whole unit in 60s scoring chunks.
    let total_secs = n as f64 / sr as f64;
    let dcfg = decide::DecideConfig::default();
    let mcfg = livemap::MapConfig::default();
    let mut confs: Vec<f32> = Vec::new();
    for (idx, start, len) in livemap::split_plan(total_secs, 60.0) {
        let a = ((start * sr as f64) as usize).min(n);
        let b = (((start + len) * sr as f64) as usize).min(n);
        if b <= a {
            continue;
        }
        let m = livemap::map_chunk_silence(&l[a..b], &r[a..b], sr, idx, start, &mcfg);
        for s in decide::score_windows(&l[a..b], &r[a..b], sr, &m, &dcfg) {
            confs.push(s.confidence);
        }
    }
    out.scored_windows = confs.len();
    out.dense = decide::sustained_music(&confs);
    out
}

/// The analysis `separate` logs, plus what obtaining it cost.
///
/// Audit 2026-09-15 (٤.ب.٧): pipeline.rs scans the whole mix anyway for the
/// clip density gate, so a scan handed in is reused as-is instead of scanning
/// the entire file a second time; `0.0s` in the log line means exactly that.
/// `fallback` is the caller's local the returned reference points into
/// whenever the analysis had to be scanned here.
fn mix_analysis<'a>(
    given: Option<&'a MixAnalysis>,
    fallback: &'a mut Option<MixAnalysis>,
    l: &[f32],
    r: &[f32],
    sr: u32,
) -> (&'a MixAnalysis, f32) {
    match given {
        Some(a) => (a, 0.0),
        None => {
            let t_scan = std::time::Instant::now();
            let scanned: &MixAnalysis = fallback.insert(analyze_mix(l, r, sr));
            (scanned, t_scan.elapsed().as_secs_f32())
        }
    }
}

/// Full separation: normalized stereo WAV in → vocals + instrumental WAVs out.
///
/// UVR5 separate.py:499 (`source = self.demix(mix)`): inference runs on the
/// WHOLE file — no content gate. `analyze_mix` stays as diagnostics only
/// (logged above, never branching). Padding follows UVR5 :560.
///
/// `analysis` is the caller's own scan when it already has one (٤.ب.٧);
/// `None` ⇒ this call scans once, only to fill the log line.
pub fn separate(
    input_wav: &Path,
    out_dir: &Path,
    use_cuda: bool,
    progress: &dyn Fn(f32) -> bool,
    analysis: Option<&MixAnalysis>,
) -> Result<StemPaths, SepError> {
    let (left, right, sample_rate) = read_wav_stereo(input_wav)?;
    tracing::info!(target: "sep", "mix loaded: {} samples @{}", left.len(), sample_rate);

    let mut mix = [left, right];
    let peak = normalize(&mut mix);
    tracing::info!(
        target: "sep",
        "level: peak={peak:.4} ({:.2} dBFS) attenuated={}",
        if peak > 0.0 { 20.0 * peak.log10() } else { -120.0 },
        peak > 0.9
    );
    let n = mix[0].len();

    // Expert scan: seconds against MDX minutes — always logged, never silent.
    let mut scanned = None;
    let (analysis, scan_secs) = mix_analysis(analysis, &mut scanned, &mix[0], &mix[1], sample_rate);
    let suspect_len: usize = analysis.suspect.iter().map(|(a, b)| b - a).sum();
    tracing::info!(
        target: "sep",
        "mix analysis: suspect_spans={} coverage={:.2} dense={} scored_windows={} ({scan_secs:.1}s scan)",
        analysis.suspect.len(),
        suspect_len as f64 / n.max(1) as f64,
        analysis.dense,
        analysis.scored_windows
    );

    // Expert D2ب A/B split: session build timed APART from inference.
    let t_build = std::time::Instant::now();
    let mut session = MdxSession::load(use_cuda)?;
    let build_ms = t_build.elapsed().as_secs_f32() * 1000.0;

    // UVR5 :499 — whole-file inference; the analysis above is diagnostics only.
    let t_inf = std::time::Instant::now();
    let vocals_src = demix(&mut session, &mix, &|p| progress(p))?;
    let inference_ms = t_inf.elapsed().as_secs_f32() * 1000.0;
    tracing::info!(
        target: "sep",
        "SEPARATE-AB-REPORT session_build_ms={build_ms:.0} inference_ms={inference_ms:.0} spans={} coverage={:.2}",
        1,
        1.00
    );

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

    // ───────────────────── Item 5 — measurable E2E on a generated sample ─────
    //
    // ROADMAP §٧.ب بند ٥. Nothing here is shipped or downloaded: the fixture is
    // SYNTHESISED in-process, so it carries no licence question and CI can run
    // it from a bare checkout. No timing is asserted anywhere — a slow machine
    // changes how long this takes, never whether it passes.

    /// The exact output contract (ROADMAP §٧.ب ٥ب): 32-bit float stereo WAV at
    /// the input's sample rate, sample-exact in length.
    const E2E_CHANNELS: u16 = 2;
    const E2E_BITS: u16 = 32;
    const E2E_SR: u32 = 44100;
    const E2E_SECS: f32 = 6.0;

    /// Measured with the fixture below (2026-09-15, DirectML/CPU session,
    /// `--nocapture`, three runs — the printed line each run):
    ///   E2E-BANDS music_drop=63.07 dB voice_drop=11.67 dB voice_peak=0.1902
    /// The thresholds keep ~2.5× headroom on the voice side and sit far below
    /// the measured music suppression, so an engine regression that stops
    /// removing the bed (or stops keeping the voice) trips them instead of
    /// passing. Re-measure and update these three numbers if the checkpoint or
    /// the fixture ever changes.
    const E2E_MUSIC_DROP_DB: f32 = 40.0; // measured 63.07
    const E2E_VOICE_KEEP_DB: f32 = 30.0; // measured 11.67
    const E2E_VOICE_FLOOR_DB: f32 = 20.0; // anti-vacuous floor on the retained band
    const E2E_VOICE_PEAK_MIN: f32 = 0.01; // measured 0.1902

    /// Item 5 fixture — a synthetic stereo "song" whose music and voice content
    /// are measurably disjoint:
    ///
    /// * **music** — a 55 Hz sub-bass with a 2 Hz tremolo. 55 Hz sits ~4
    ///   octaves below the vocal band, so the two are separated by any
    ///   band-pass, and no singing voice occupies it.
    /// * **voice** — 800 Hz at −11 dBFS under a 4 Hz syllabic envelope. Both
    ///   numbers are the result of measurement, not taste: a per-frequency
    ///   probe of this checkpoint showed the vocals stem retaining 800 Hz at
    ///   −18 dB while 250/500/900/1000 Hz collapsed to ≤ −70 dB, and that a
    ///   110/220/330 Hz harmonic bed made the model route everything to the
    ///   instrumental (a 55 Hz bed does not).
    ///
    /// A synthetic fixture can only show that the ENGINE keeps band A and drops
    /// band B on this input — it is not evidence about speech on real music.
    /// The `#[ignore]`d pipeline test below carries the real media path.
    fn e2e_synthetic_mix(sr: u32, secs: f32) -> (Vec<f32>, Vec<f32>) {
        let n = (sr as f32 * secs) as usize;
        let mut l = Vec::with_capacity(n);
        let mut r = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f32 / sr as f32;
            let tau = std::f32::consts::TAU;
            let music = 0.45 * (tau * 55.0 * t).sin() * (0.75 + 0.25 * (tau * 2.0 * t).sin());
            let env = 0.35 + 0.65 * (0.5 + 0.5 * (tau * 4.0 * t).sin());
            let voice = env * 0.28 * (tau * 800.0 * t).sin();
            l.push((music + voice).clamp(-0.95, 0.95));
            // deliberate stereo asymmetry: neither channel is a copy of the other
            r.push((music * 0.92 + voice * 0.98).clamp(-0.95, 0.95));
        }
        (l, r)
    }

    /// RBJ second-order band-pass, applied forward AND backward so the
    /// measurement has zero phase shift and its gain is a pure magnitude.
    struct Biquad {
        b0: f32,
        b1: f32,
        b2: f32,
        a1: f32,
        a2: f32,
    }

    impl Biquad {
        fn bandpass(sr: f32, f0: f32, q: f32) -> Self {
            let w0 = std::f32::consts::TAU * f0 / sr;
            let (sn, cs) = w0.sin_cos();
            let alpha = sn / (2.0 * q);
            let a0 = 1.0 + alpha;
            Self {
                b0: alpha / a0,
                b1: 0.0,
                b2: -alpha / a0,
                a1: -2.0 * cs / a0,
                a2: (1.0 - alpha) / a0,
            }
        }

        fn apply(&self, x: &[f32]) -> Vec<f32> {
            let mut y = vec![0.0f32; x.len()];
            let (mut x1, mut x2, mut y1, mut y2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
            for (i, &v) in x.iter().enumerate() {
                let o = self.b0 * v + self.b1 * x1 + self.b2 * x2 - self.a1 * y1 - self.a2 * y2;
                x2 = x1;
                x1 = v;
                y2 = y1;
                y1 = o;
                y[i] = o;
            }
            y
        }
    }

    /// Zero-phase band energy of a stereo pair in relative dB (10·log10 of the
    /// summed squares). Only DIFFERENCES between the same band of two signals
    /// are used, so the absolute constant of the filter cancels out.
    fn band_db(l: &[f32], r: &[f32], sr: u32, lo: f32, hi: f32) -> f32 {
        let f0 = (lo * hi).sqrt();
        let f = Biquad::bandpass(sr as f32, f0, f0 / (hi - lo));
        let mut sum = 0.0f64;
        for ch in [l, r] {
            let mut y = f.apply(ch);
            y.reverse();
            let mut y = f.apply(&y);
            y.reverse();
            sum += y.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>();
        }
        (10.0 * sum.max(1e-30).log10()) as f32
    }

    /// (music band, voice band): 55 Hz ±, and 800 Hz ±10% — neither filter
    /// reaches the other's component (the 12 dB/oct roll-off leaves the voice
    /// filter 89 dB down at 55 Hz).
    const E2E_MUSIC_BAND: (f32, f32) = (40.0, 90.0);
    const E2E_VOICE_BAND: (f32, f32) = (740.0, 880.0);

    /// Never-finite check used by both E2E tests: `min`/`max` via `total_cmp`
    /// so a NaN can never panic the fold (the project's NaN-guard rule).
    fn assert_finite_and_unclipped(name: &str, l: &[f32], r: &[f32]) {
        let peak = l
            .iter()
            .chain(r.iter())
            .map(|v| v.abs())
            .fold(0.0f32, f32::max);
        assert!(
            peak.is_finite(),
            "{name}: output contains NaN/Inf (peak={peak}) — non-finite audio must never be written"
        );
        assert!(
            l.iter().chain(r.iter()).all(|v| v.is_finite()),
            "{name}: a non-finite sample survived into the stem"
        );
        assert!(
            peak <= 1.0,
            "{name}: clipping — peak {peak:.4} exceeds full scale"
        );
    }

    /// Item 5 (أ + ب + ج) — the real separation engine, end to end, on a sample
    /// generated in this test:
    ///
    /// * **أ** the vocals stem keeps the voice band (≤ 30 dB down) while the
    ///   music band drops ≥ 40 dB — i.e. the pipeline is measurably selective,
    ///   not merely "a file came out".
    /// * **ب** the output contract: 32-bit float, stereo, 44.1 kHz, sample-exact
    ///   duration.
    /// * **ج** no NaN/Inf and no clipping (≤ 1.0).
    ///
    /// Requires only the separation model (63.7MB); no ffmpeg, no GPU, no disk
    /// fixture. Skipped loudly when the model is absent — the same pattern the
    /// live CUDA smoke test uses, so a bare checkout stays green.
    #[test]
    fn e2e_separation_is_measurable_on_generated_sample() {
        let (l, r) = e2e_synthetic_mix(E2E_SR, E2E_SECS);

        let tmp = std::env::temp_dir().join(format!("hl_e2e_bands_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let mix_path = tmp.join("mix.wav");
        write_wav_stereo_f32(&mix_path, &l, &r, E2E_SR).unwrap();

        let stems = separate(&mix_path, &tmp.join("out"), false, &|_| true, None)
            .expect("separation must succeed on a generated 44.1k stereo WAV");
        let (vl, vr, vsr) = read_wav_stereo(&stems.vocals).expect("vocals stem must be readable");
        let (il, ir, isr) = read_wav_stereo(&stems.instrumental)
            .expect("instrumental stem must be readable");

        // (ب) output contract, read back from the files the engine wrote.
        for (name, sr) in [("vocals", vsr), ("instrumental", isr)] {
            assert_eq!(sr, E2E_SR, "{name}: sample rate must be preserved");
            let spec = WavReader::open(if name == "vocals" { &stems.vocals } else { &stems.instrumental })
                .unwrap()
                .spec();
            assert_eq!(spec.channels, E2E_CHANNELS, "{name}: must stay stereo");
            assert_eq!(spec.bits_per_sample, E2E_BITS, "{name}: must stay 32-bit float");
            assert_eq!(
                spec.sample_format,
                SampleFormat::Float,
                "{name}: must stay float PCM"
            );
        }
        assert_eq!(vl.len(), l.len(), "vocals must be sample-exact in length");
        assert_eq!(il.len(), l.len(), "instrumental must be sample-exact in length");

        // (ج) no NaN/Inf, no clipping.
        assert_finite_and_unclipped("vocals", &vl, &vr);
        assert_finite_and_unclipped("instrumental", &il, &ir);

        // (أ) the measured claim.
        let in_music = band_db(&l, &r, E2E_SR, E2E_MUSIC_BAND.0, E2E_MUSIC_BAND.1);
        let in_voice = band_db(&l, &r, E2E_SR, E2E_VOICE_BAND.0, E2E_VOICE_BAND.1);
        let v_music = band_db(&vl, &vr, E2E_SR, E2E_MUSIC_BAND.0, E2E_MUSIC_BAND.1);
        let v_voice = band_db(&vl, &vr, E2E_SR, E2E_VOICE_BAND.0, E2E_VOICE_BAND.1);
        let music_drop = in_music - v_music;
        let voice_drop = in_voice - v_voice;
        let v_peak = vl.iter().chain(vr.iter()).fold(0.0f32, |m, v| m.max(v.abs()));
        println!(
            "E2E-BANDS music_drop={music_drop:.2} dB voice_drop={voice_drop:.2} dB \
             voice_peak={v_peak:.4} (thresholds: music≥{E2E_MUSIC_DROP_DB} voice≤{E2E_VOICE_KEEP_DB})"
        );

        assert!(
            music_drop >= E2E_MUSIC_DROP_DB,
            "the music bed must be removed from the vocals stem: dropped only {music_drop:.2} dB \
             (need ≥ {E2E_MUSIC_DROP_DB})"
        );
        assert!(
            voice_drop <= E2E_VOICE_KEEP_DB,
            "the voice band must survive in the vocals stem: dropped {voice_drop:.2} dB \
             (need ≤ {E2E_VOICE_KEEP_DB})"
        );
        // Anti-vacuous: a zeroed vocals stem satisfies "music dropped" trivially,
        // so the retained band is also pinned in absolute terms and by peak.
        assert!(
            voice_drop <= E2E_VOICE_FLOOR_DB,
            "vocals stem is effectively empty ({voice_drop:.2} dB down) — the band assertion \
             above would be vacuous"
        );
        assert!(
            v_peak >= E2E_VOICE_PEAK_MIN,
            "vocals peak {v_peak:.5} is below the {E2E_VOICE_PEAK_MIN} floor — output is degenerate"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Item 5 (release gate) — the SAME generated sample driven through the full
    /// media pipeline (`pipeline::process_file`), so ffmpeg's normalize step and
    /// the delivery stage are exercised too, not just the engine.
    ///
    /// Ignored by default for cost, not for flakiness: it needs ffmpeg/ffprobe
    /// (434MB, deliberately not fetched by the push gate), so it is the
    /// documented pre-release command instead — `pnpm e2e:release` (see
    /// package.json) or the `e2e-release-gate` job in `.github/workflows/ci.yml`
    /// (workflow_dispatch). Assertions are identical in kind to the test above.
    #[test]
    #[ignore = "needs ffmpeg/ffprobe — run before a release via `pnpm e2e:release`"]
    fn e2e_full_pipeline_through_ffmpeg() {
        if crate::media::resolve_tool("ffmpeg").is_err() || crate::media::resolve_tool("ffprobe").is_err() {
            eprintln!("skipping full-pipeline E2E: ffmpeg/ffprobe not found (set HARAMLITE_TOOLS_DIR)");
            return;
        }
        if resolve_model().is_err() {
            eprintln!("skipping full-pipeline E2E: separation model absent");
            return;
        }
        let (l, r) = e2e_synthetic_mix(E2E_SR, E2E_SECS);
        let tmp = std::env::temp_dir().join(format!("hl_e2e_full_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // A real MP4 container — not a WAV renamed — so ffmpeg actually decodes.
        let src = tmp.join("mix.wav");
        write_wav_stereo_f32(&src, &l, &r, E2E_SR).unwrap();
        let mp4 = tmp.join("input.mp4");
        let ffmpeg = crate::media::resolve_tool("ffmpeg").unwrap();
        let src_s = src.to_string_lossy().into_owned();
        let mp4_s = mp4.to_string_lossy().into_owned();
        let st = std::process::Command::new(&ffmpeg)
            .args(["-y", "-v", "error", "-i", &src_s, "-c:a", "aac", "-b:a", "192k", &mp4_s])
            .status()
            .expect("ffmpeg spawn");
        assert!(st.success(), "fixture mp4 generation failed");

        let out_dir = tmp.join("out");
        std::fs::create_dir_all(&out_dir).unwrap();
        let res = crate::pipeline::process_file(
            &mp4,
            &out_dir,
            crate::pipeline::Mode::Clip,
            crate::pipeline::OutKind::Audio { fmt: crate::pipeline::OutFormat::Wav },
            true,  // keep the instrumental too
            true,  // keep vocals
            false, // CPU/DirectML — the GPU paths have their own live tests
            None,
            &|_| true,
            &|_, _| {},
        )
        .expect("full pipeline must succeed on a generated mp4");

        let vocals = res.vocals.expect("vocals stem expected");
        let instrumental = res.instrumental.expect("instrumental stem expected");
        let (vl, vr, vsr) = read_wav_stereo(&vocals).expect("vocals readable");
        let (il, ir, isr) = read_wav_stereo(&instrumental).expect("instrumental readable");
        assert_eq!(vsr, E2E_SR, "normalize must yield 44.1 kHz");
        assert_eq!(isr, E2E_SR, "normalize must yield 44.1 kHz");
        assert_finite_and_unclipped("pipeline vocals", &vl, &vr);
        assert_finite_and_unclipped("pipeline instrumental", &il, &ir);

        let in_music = band_db(&l, &r, E2E_SR, E2E_MUSIC_BAND.0, E2E_MUSIC_BAND.1);
        let in_voice = band_db(&l, &r, E2E_SR, E2E_VOICE_BAND.0, E2E_VOICE_BAND.1);
        let music_drop = in_music - band_db(&vl, &vr, E2E_SR, E2E_MUSIC_BAND.0, E2E_MUSIC_BAND.1);
        let voice_drop = in_voice - band_db(&vl, &vr, E2E_SR, E2E_VOICE_BAND.0, E2E_VOICE_BAND.1);
        println!(
            "E2E-FULL music_drop={music_drop:.2} dB voice_drop={voice_drop:.2} dB \
             vocals_len={} input_len={}",
            vl.len(),
            l.len()
        );
        assert!(
            music_drop >= E2E_MUSIC_DROP_DB,
            "full pipeline: music bed survived in vocals ({music_drop:.2} dB down)"
        );
        assert!(
            voice_drop <= E2E_VOICE_KEEP_DB,
            "full pipeline: voice band lost from vocals ({voice_drop:.2} dB down)"
        );
        // Duration: AAC priming means a few ms of slack, never a different file.
        let drift = (vl.len() as f32 / E2E_SR as f32 - E2E_SECS).abs();
        assert!(drift < 0.1, "duration drifted by {drift:.3}s through the media path");
        let _ = std::fs::remove_dir_all(&tmp);
    }

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
        let stems = separate(
            &wav_path,
            &out_dir,
            false,
            &|p| {
                tracing::debug!(target: "sep_test", "progress {:.0}%", p * 100.0);
                true
            },
            None,
        )
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

    /// Step-1 (A): UVR5 :560 tail padding — the old 2*TRIM tail under-padded
    /// every file whose length was not an exact multiple of gen_size.
    #[test]
    fn demix_padding_matches_uvr5_reference() {
        let gen = CHUNK_SIZE - 2 * TRIM; // 253440
        for n in [1usize, 44100, 268288, 441000, gen, gen + 1, 2 * gen] {
            let (pad, padded) = demix_padding(n);
            assert_eq!(pad, gen + TRIM - (n % gen), "pad formula for n={n}");
            assert_eq!(padded, TRIM + n + pad, "padded length for n={n}");
            assert!(pad > TRIM && pad <= gen + TRIM, "pad range for n={n}: {pad}");
        }
        // 10s @44.1kHz: the concrete tail the old code got wrong.
        let (pad10, padded10) = demix_padding(441000);
        assert_eq!(pad10, 69720);
        assert_eq!(padded10, 514560);
        assert_ne!(padded10, 441000 + 2 * TRIM, "must differ from the old 2*TRIM tail");
    }

    /// Step-1 (A): documents the exact trigger the removed gate used —
    /// continuous loud audio yields ZERO suspect spans (old code then skipped
    /// MDX entirely and passed the mix through). separate() now ignores this.
    #[test]
    fn continuous_loud_audio_yields_empty_suspect_gate_trigger() {
        let sr = 44100u32;
        let n = sr as usize * 10;
        let l: Vec<f32> = (0..n)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr as f32).sin())
            .collect();
        let r = l.clone();
        let a = analyze_mix(&l, &r, sr);
        assert!(a.suspect.is_empty(), "continuous audio must trip the old gate: {:?}", a.suspect);
    }

    /// Negative test for ٤.ب.٧: a caller that already scanned the mix must not
    /// pay for a second whole-file scan — the analysis it hands in is the one
    /// `separate` logs, and obtaining it costs no scan time.
    #[test]
    fn a_given_analysis_is_logged_instead_of_rescanned() {
        let sr = 44100u32;
        let n = sr as usize;
        let l = vec![0.25f32; n];
        let r = vec![0.25f32; n];
        let given = MixAnalysis { dense: true, suspect: vec![(0, 11)], scored_windows: 4242 };

        let mut slot = None;
        let (a, scan_secs) = mix_analysis(Some(&given), &mut slot, &l, &r, sr);
        assert_eq!(a.scored_windows, 4242, "the caller's scan must be the one logged");
        assert!(a.dense, "…including its verdict");
        assert_eq!(a.suspect, vec![(0, 11)]);
        assert_eq!(scan_secs, 0.0, "a reused analysis costs no scan");
        assert!(slot.is_none(), "nothing may be scanned when an analysis was given");

        // …and with nothing given it scans exactly once, into the caller's slot.
        let mut slot = None;
        let (b, _) = mix_analysis(None, &mut slot, &l, &r, sr);
        assert_ne!(b.scored_windows, 4242, "a real scan must replace the fixture's numbers");
        let scanned_windows = b.scored_windows;
        let stored = slot.as_ref().expect("no analysis given ⇒ one scan, kept for the log");
        assert_eq!(stored.scored_windows, scanned_windows);
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
        let stems = separate(&wav, &tmp.join("out"), true, &|_| true, None).expect("CUDA separation");
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

    /// Expert D2ب: suspect spans are kept audio ±2s padding, merged; dense
    /// tone is one span, silence splits spans, all-silence is empty + sparse.
    #[test]
    fn analyze_marks_suspect_spans_with_padding() {
        let sr = 44100u32;
        let tone = |secs: f32| -> Vec<f32> {
            (0..(sr as f32 * secs) as usize)
                .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr as f32).sin() * 0.4)
                .collect()
        };
        // 10s tone / 8s silence / 10s tone → two padded spans (a 4s gap
        // would merge under ±2s padding — the merge logic working as specified).
        let mut l = tone(10.0);
        l.extend(vec![0.0f32; sr as usize * 8]);
        l.extend(tone(10.0));
        let r = l.clone();
        let a = analyze_mix(&l, &r, sr);
        assert!(a.scored_windows > 0);
        assert!(a.dense, "10s tonal runs must trip the density gate");
        assert_eq!(a.suspect.len(), 2, "silence must split spans: {:?}", a.suspect);
        let total = l.len();
        // First span ≈ [0, 12.15s): tone end (10s) + keep (0.15s) + 2s pad.
        assert!(a.suspect[0].0 == 0, "starts at file head");
        assert!((a.suspect[0].1 as f32 / sr as f32 - 12.15).abs() < 0.6, "pad after tone: {:?}", a.suspect[0]);
        // Second span ≈ [15.85s, 28s]: 2s pad before tone, clamped at end.
        assert!((a.suspect[1].0 as f32 / sr as f32 - 15.85).abs() < 0.6, "pad before tone: {:?}", a.suspect[1]);
        assert_eq!(a.suspect[1].1, total);
        // All silence → no suspect, never dense (MDX skipped downstream).
        let s0 = vec![0.0f32; sr as usize * 6];
        let a0 = analyze_mix(&s0, &s0, sr);
        assert!(a0.suspect.is_empty());
        assert!(!a0.dense);
        // Empty input is safe.
        let ae = analyze_mix(&[], &[], sr);
        assert!(ae.suspect.is_empty() && !ae.dense && ae.scored_windows == 0);
    }

    /// Expert D2ب acceptance vehicle: A/B report splitting inference-only
    /// time from session build over a 12s unit with a silence gap (MDX sees
    /// the suspect span only). `-- --nocapture`. Timing printed; the
    /// sample-exact merge (output length == input length) asserted.
    #[test]
    fn report_separate_ab_inference_vs_build() {
        let tmp = std::env::temp_dir().join(format!("hl_ab_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let sr = 44100u32;
        let mut l = vec![0.0f32; sr as usize * 4];
        for n in 0..sr as usize * 8 {
            let t = n as f32 / sr as f32;
            let v = 0.3 * (2.0 * std::f32::consts::PI * 330.0 * t).sin()
                + 0.2 * (2.0 * std::f32::consts::PI * 497.0 * t).sin();
            l.push(v);
        }
        let r = l.clone();
        let len = l.len();
        let wav = tmp.join("mix.wav");
        write_wav_stereo_f32(&wav, &l, &r, sr).unwrap();

        let t_build = std::time::Instant::now();
        let mut session = MdxSession::load(false).expect("session must build (DML/CPU)");
        let build_ms = t_build.elapsed().as_secs_f32() * 1000.0;

        let (sl, srr, _) = read_wav_stereo(&wav).unwrap();
        let analysis = analyze_mix(&sl, &srr, sr);
        assert_eq!(analysis.suspect.len(), 1, "one padded span expected: {:?}", analysis.suspect);
        let t_inf = std::time::Instant::now();
        for (a, b) in &analysis.suspect {
            let (a, b) = (*a, *b);
            let span_mix = [sl[a..b].to_vec(), srr[a..b].to_vec()];
            let _ = demix(&mut session, &span_mix, &|_| true).expect("span inference");
        }
        let inf_ms = t_inf.elapsed().as_secs_f32() * 1000.0;
        let provider = ACTIVE_PROVIDER.get().cloned().unwrap_or_else(|| "?".into());
        println!("SEPARATE-AB-REPORT provider={provider} session_build_ms={build_ms:.0} inference_ms={inf_ms:.0} spans={} scored={}",
            analysis.suspect.len(), analysis.scored_windows);

        // Full path keeps the merge sample-exact (silence passes through).
        let stems = separate(&wav, &tmp.join("out"), false, &|_| true, None).expect("separation failed");
        let (vl, _, _) = read_wav_stereo(&stems.vocals).unwrap();
        let (il, _, _) = read_wav_stereo(&stems.instrumental).unwrap();
        assert_eq!(vl.len(), len, "vocals length must equal input (sample-exact merge)");
        assert_eq!(il.len(), len, "instrumental length must equal input");
        assert!(build_ms > 0.0 && inf_ms > 0.0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Expert D2د: provider truth round-trips through an isolated base;
    /// missing/corrupt files read as unknown (never panic, never lie).
    #[test]
    fn provider_file_roundtrips_isolated() {
        let base = std::env::temp_dir().join(format!("hl_prov_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(read_provider_in(&provider_file_in(&base)), None, "missing → unknown");
        record_provider_in(&base, "CPU");
        assert_eq!(read_provider_in(&provider_file_in(&base)), Some("CPU".into()));
        record_provider_in(&base, "DirectML");
        assert_eq!(read_provider_in(&provider_file_in(&base)), Some("DirectML".into()));
        std::fs::write(provider_file_in(&base), b"{not json").unwrap();
        assert_eq!(read_provider_in(&provider_file_in(&base)), None, "corrupt → unknown");
        std::fs::write(provider_file_in(&base), b"{}").unwrap();
        assert_eq!(read_provider_in(&provider_file_in(&base)), None, "no field → unknown");
        let _ = std::fs::remove_dir_all(&base);
    }
}
