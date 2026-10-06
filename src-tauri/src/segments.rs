//! مخطِّط مقاطع الفصل المجزأ — **نقي**: لا I/O ولا عتاد.
//!
//! **العلّة المقيسة** (2026-10-05): إزاحة المقطع الثاني 300 ثانية =
//! `13230000 mod 195840 = 108720` = **0.5551 خطوة** ⇒ لا محاذاة مع شبكة demix
//! أبداً، وحساسية النموذج للإزاحة `ratio=1.385` (أكبر من الإشارة) — أي إشارتان
//! غير مترابطتين. والضابط (نفس المدخل مرتين) `rms_diff=0` ⇒ المسار حتمي.
//!
//! **الحل**: خطة نوافذ عالمية واحدة — كل `start` ∈ مضاعفات [`DEMIX_STEP`] من
//! الصفر العالمي (مبدأ مزيج `demix`). والحدّ الفاصل بين المقاطع **قاطع**:
//! تُصدَر البادئة المنتهية فقط، بلا crossfade (بقاؤه يعيد الخطأ عند الحدود).
//!
//! **وحدّ النطاق**: تخطيط فقط. التنفيذ في `separator.rs`، والمنتج في `bridge`.
//!
//! **مسار الهوية حرفياً**: ملف ≤ مقطع واحد ⇒ مقطع واحد يغطّي `[0, total)` —
//! والمستدعي يمرّ بمسار الملف الكامل القائم.

/// خطوة شبكة demix بالعيّنات — `(1 − 0.25) × 261120 = 195840` (حقيقة مقيسة).
/// **ممنوع** مساس حشو البداية العالمي (`demix_padding`) أو وزن هانّ — أي
/// «تحسين» هناك يكسر المطابقة.
pub const DEMIX_STEP: usize = 195_840;

/// عدد خطوات الشبكة في مقطع واحد — **67** (قرار المالك، مؤكد بالحساب).
/// الطول الفعلي = `67 × 195840 = 13,121,280` عيّنة ≈ **297.53 ث** @44.1kHz.
pub const SEGMENT_STEPS: usize = 67;

/// `TRIM` من `separator.rs` (‏`N_FFT/2 = 3840`) — إزاحة العيّنة الأصلية داخل
/// المزيج المُحشّى. تُستعمل لحساب أي نافذة تُنهي أي عيّنة؛ **لا تُغيَّر**.
pub const DEMIX_TRIM: usize = 3_840;

/// مقطع مخطَّط واحد على شبكة demix العالمية (كل المواقع **عيّنات**).
///
/// - **نطاق الإصدار** `[emit_start, emit_end)` في المجال الأصلي: حدوده
///   مضاعفات [`DEMIX_STEP`] (الآخر قد يُقفل بطول الملف).
/// - **النوافذ** `first_window..=last_window` على الشبكة العالمية (مبدأ
///   المزيج المُحشّى = `k × DEMIX_STEP`).
/// - **الإحماء**: `first_window` قد يسبق النافذة الأولى التي تُسهم في
///   `emit_start` بمقدار نافذة واحدة (`m = 1`) — تُحاسَب ولا تُكتَب منها
///   عيّنة قبل `emit_start`. أول مقطع: لا إحماء (`first_window = 0`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentPlan {
    /// فهرس صفري. رقم المقطع في البروتوكول = `index + 1`.
    pub index: usize,
    /// أول عيّنة أصلية تُصدَر (مضاعف [`DEMIX_STEP`]، أو 0).
    pub emit_start: usize,
    /// نهاية نطاق الإصدار (حصرية) — مضاعف [`DEMIX_STEP`]، أو `total` لآخر مقطع.
    pub emit_end: usize,
    /// أول نافذة demix تُعالَج (تشمل الإحماء `m = 1`).
    pub first_window: usize,
    /// آخر نافذة demix تُعالَج (شاملة).
    pub last_window: usize,
}

impl SegmentPlan {
    /// صحيح فقط حين يغطّي المقطع الملف كاملاً بنافذة إحماء واحدة أو صفر —
    /// مسار الهوية للمستدعي (demix الكامل القائم).
    pub fn is_identity(&self, total_samples: usize) -> bool {
        self.emit_start == 0 && self.emit_end >= total_samples
    }

    /// عدد نوافذ المعالجة.
    pub fn window_count(&self) -> usize {
        self.last_window.saturating_sub(self.first_window) + 1
    }
}

/// مبدأ النافذة `k` في المزيج المُحشّى (الصفر العالمي) = `k × DEMIX_STEP`.
#[inline]
pub fn window_start(k: usize) -> usize {
    k * DEMIX_STEP
}

/// أصغر نافذة تُسهم في العيّنة المُحشّاة `p` (النافذة تغطّي
/// `[k·step, k·step + chunk_len)`).
fn first_window_covering(p: usize, chunk_len: usize) -> usize {
    if p < chunk_len {
        0
    } else {
        (p - chunk_len) / DEMIX_STEP + 1
    }
}

/// أكبر نافذة تُسهم في العيّنة المُحشّاة `p`.
fn last_window_covering(p: usize) -> usize {
    p / DEMIX_STEP
}

/// يخطّط المقاطع لملف طوله `total_samples` عيّنة، على شبكة [`DEMIX_STEP`].
///
/// النوات: `[0, S)`, `[S, 2S)`, … حيث `S = SEGMENT_STEPS × DEMIX_STEP`
/// (وآخر مقطع قد يقصر عند `total_samples`). كل حدّ ∈ مضاعفات `step`.
pub fn plan_segments(total_samples: usize, chunk_len: usize) -> Vec<SegmentPlan> {
    plan_segments_with(total_samples, chunk_len, SEGMENT_STEPS)
}

/// كما [`plan_segments`] لكن بعدد خطوات المقطع — للاختبار القصير (نفس
/// الشبكة ونفس الإحماء `m = 1`، بلا استثناء).
///
/// لكل مقطع `j` بنطاق إصدار `[a, b)` (أصلي):
/// - `first_window = max(0, first_covering(TRIM+a) − 1)` — إحماء `m = 1`
///   (مؤكَّد بالحساب: أقصى تغطية لعيّنة = نافذتان لأن `step/CHUNK = 0.75`).
/// - `last_window = last_covering(TRIM+b−1)` — حتى تنتهي كل عيّنات النطاق.
pub fn plan_segments_with(
    total_samples: usize,
    chunk_len: usize,
    segment_steps: usize,
) -> Vec<SegmentPlan> {
    if total_samples == 0 || chunk_len == 0 || DEMIX_STEP == 0 || segment_steps == 0 {
        return Vec::new();
    }
    let seg_len = segment_steps * DEMIX_STEP;
    let mut out = Vec::new();
    let mut emit_start = 0usize;
    let mut index = 0usize;
    while emit_start < total_samples {
        let emit_end = (emit_start + seg_len).min(total_samples);
        // العيّنات في المجال المُحشّى: p = TRIM + j
        let p_start = DEMIX_TRIM + emit_start;
        let p_end = DEMIX_TRIM + emit_end - 1; // آخر عيّنة في النطاق
        let first_cover = first_window_covering(p_start, chunk_len);
        let first_window = first_cover.saturating_sub(1); // m = 1 warmup
        let last_window = last_window_covering(p_end);
        out.push(SegmentPlan {
            index,
            emit_start,
            emit_end,
            first_window,
            last_window,
        });
        emit_start = emit_end;
        index += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// حجم قطعة demix — `HOP × (DIM_T − 1) = 1024 × 255 = 261120`.
    const CHUNK_LEN: usize = 261_120;
    /// معدّل العيّنات الذي تُقاس عليه الأطوال (عقود المولّد والبوابة).
    const SR: u32 = 44_100;

    // ─── حارس المحاذاة (الاتهام الأول) — نقي، بلا نموذج، دائم ────────────

    /// **كل `start` في كل مقطع ∈ مضاعفات `step` من الصفر العالمي** —
    /// و**حدود المقاطع (النوات) مضاعفات `step`**.
    ///
    /// كان يسقط على المخطِّط القديم (أنوية 300 ثانية: `13230000 mod 195840 =
    /// 108720`). ويبقى حارساً دائماً — لو مرّ على مخطِّط غير محاذٍ فالتشخيص
    /// خاطئ ولا يُبنى فوقه.
    #[test]
    fn every_window_start_is_a_multiple_of_step_from_global_zero() {
        // ملف 310 ث ⇒ مقطعان على الأقل عند SEGMENT_STEPS=67 (~297.5ث).
        let total = (310.0 * SR as f64) as usize;
        let plan = plan_segments(total, CHUNK_LEN);
        assert!(
            plan.len() >= 2,
            "310s ⇒ nafidhatan aw akthar, got {}",
            plan.len()
        );
        for seg in &plan {
            assert_eq!(
                seg.emit_start % DEMIX_STEP,
                0,
                "segment {} emit_start {} is NOT a multiple of step {} (remainder {})",
                seg.index,
                seg.emit_start,
                DEMIX_STEP,
                seg.emit_start % DEMIX_STEP
            );
            if seg.emit_end < total {
                assert_eq!(
                    seg.emit_end % DEMIX_STEP,
                    0,
                    "segment {} emit_end {} is NOT a multiple of step {} (remainder {})",
                    seg.index,
                    seg.emit_end,
                    DEMIX_STEP,
                    seg.emit_end % DEMIX_STEP
                );
            }
            for k in seg.first_window..=seg.last_window {
                let start = window_start(k);
                assert_eq!(
                    start % DEMIX_STEP,
                    0,
                    "segment {} window {} start {} not on the global grid",
                    seg.index,
                    k,
                    start
                );
                assert_eq!(start, k * DEMIX_STEP);
            }
        }
    }

    /// الأرقام المقيسة مثبتة: `step` · بقايا إزاحة 300ث · وحدّ التغطية.
    #[test]
    fn the_measured_step_and_offset_facts_stay_pinned() {
        let chunk_size = 261_120usize; // HOP * (DIM_T - 1)
        let step = ((1.0 - 0.25) * chunk_size as f64) as usize;
        // الربط بالثابت المُصدَّر (لا assert على const — يثير clippy).
        let exported = DEMIX_STEP;
        assert_eq!(step, exported, "DEMIX_STEP must stay 195840");
        let offset_300s = 300 * SR as usize;
        assert_eq!(
            offset_300s % exported,
            108_720,
            "300s @44.1kHz leaves 108720 samples = 0.5551 step — never aligned"
        );
        assert!(
            (exported as f64 / chunk_size as f64 - 0.75).abs() < 1e-12,
            "step/CHUNK = 0.75 ⇒ max two windows cover any sample"
        );
    }

    /// **إحماء m = 1 مؤكَّد بالحساب**: أول مقطع بلا إحماء، وما بعده
    /// `first_window = first_covering − 1` بالضبط.
    #[test]
    fn warmup_is_exactly_one_window_except_the_first_segment() {
        let seg_len = SEGMENT_STEPS * DEMIX_STEP;
        let total = seg_len * 2 + 1000;
        let plan = plan_segments(total, CHUNK_LEN);
        assert_eq!(plan.len(), 3);
        // أول مقطع: لا إحماء — النافذة 0 هي أول نافذة تُسهم في العيّنة 0.
        assert_eq!(plan[0].first_window, 0);
        assert_eq!(plan[0].emit_start, 0);
        // المقطع الثاني: إحماء واحد قبل أول نافذة تُسهم في emit_start.
        let p_start = DEMIX_TRIM + plan[1].emit_start;
        let first_cover = first_window_covering(p_start, CHUNK_LEN);
        assert_eq!(
            plan[1].first_window + 1,
            first_cover,
            "warmup must be exactly one window before first_cover"
        );
        assert!(plan[1].first_window < first_cover);
    }

    /// أقصى تغطية لعيّنة = نافذتان (الحساب الذي يؤكّد `m = 1`).
    #[test]
    fn at_most_two_windows_cover_any_sample() {
        // step/CHUNK = 0.75 < 1 ⇒ أي عيّنة تقع في نافذتين كحدّ أقصى.
        // (قيم محسوبة لا const literals — وإلا أثار assert clippy.)
        let chunk_size = 261_120usize;
        let step = ((1.0 - 0.25) * chunk_size as f64) as usize;
        assert!(step < chunk_size);
        assert!(
            2 * step > chunk_size,
            "otherwise three windows could overlap"
        );
    }

    // ─── الحدود الشاذة ──────────────────────────────────────────────────

    #[test]
    fn empty_input_plans_nothing() {
        assert!(plan_segments(0, CHUNK_LEN).is_empty());
        assert!(plan_segments(100, 0).is_empty());
    }

    /// ملف أقصر من مقطع ⇒ مقطع واحد هوية.
    #[test]
    fn file_shorter_than_one_segment_is_a_single_identity_segment() {
        let total = SEGMENT_STEPS * DEMIX_STEP - 1;
        let plan = plan_segments(total, CHUNK_LEN);
        assert_eq!(plan.len(), 1);
        assert!(plan[0].is_identity(total));
        assert_eq!(plan[0].emit_start, 0);
        assert_eq!(plan[0].emit_end, total);
        assert_eq!(plan[0].first_window, 0);
    }

    /// مقطع بنافذة واحدة (أصغر حالات المعالجة).
    #[test]
    fn a_segment_spanning_a_single_window_is_planned() {
        // طول صغير جداً لكنه يحتاج نافذة واحدة على الأقل.
        let total = 1000;
        let plan = plan_segments(total, CHUNK_LEN);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].window_count(), 1);
        assert_eq!(plan[0].first_window, 0);
        assert_eq!(plan[0].last_window, 0);
    }

    /// مقطع على الذيل: آخر مقطع يُقفل بطول الملف لا بمضاعف step.
    #[test]
    fn the_tail_segment_closes_at_total() {
        let seg_len = SEGMENT_STEPS * DEMIX_STEP;
        let total = seg_len + 500; // ذيل صغير بعد مقطع كامل
        let plan = plan_segments(total, CHUNK_LEN);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].emit_end, seg_len);
        assert_eq!(plan[1].emit_start, seg_len);
        assert_eq!(plan[1].emit_end, total, "tail closes at total");
    }

    /// البداية عند الصفر: emit_start=0 وfirst_window=0.
    #[test]
    fn start_at_zero_has_no_warmup() {
        let total = SEGMENT_STEPS * DEMIX_STEP * 2;
        let plan = plan_segments(total, CHUNK_LEN);
        assert_eq!(plan[0].emit_start, 0);
        assert_eq!(plan[0].first_window, 0);
    }

    /// النوات تُغطّي `[0, total]` بالضبط، متجاورة بلا فجوة ولا تداخل.
    #[test]
    fn cores_tile_the_file_exactly() {
        let seg_len = SEGMENT_STEPS * DEMIX_STEP;
        for total in [
            1000usize,
            seg_len - 1,
            seg_len,
            seg_len + 1,
            seg_len * 2,
            seg_len * 2 + 7,
        ] {
            let plan = plan_segments(total, CHUNK_LEN);
            let mut cursor = 0usize;
            for s in &plan {
                assert_eq!(s.emit_start, cursor, "gap/overlap at segment {}", s.index);
                assert!(s.emit_end > s.emit_start);
                cursor = s.emit_end;
            }
            assert_eq!(cursor, total, "total={total} cursor={cursor}");
        }
    }

    /// رقم المقطع في البروتوكول = `index + 1` (واحد الأساس).
    #[test]
    fn segment_numbers_are_one_based() {
        let total = SEGMENT_STEPS * DEMIX_STEP * 3;
        let plan = plan_segments(total, CHUNK_LEN);
        let nums: Vec<usize> = plan.iter().map(|s| s.index + 1).collect();
        assert_eq!(nums, vec![1, 2, 3]);
    }

    /// النطاق المعالج لكل مقطع يكفي لإنهاء كل عيّنات إصداره.
    #[test]
    fn windows_suffice_to_finalize_the_emit_range() {
        let seg_len = SEGMENT_STEPS * DEMIX_STEP;
        let total = seg_len + 10_000;
        for seg in plan_segments(total, CHUNK_LEN) {
            // بعد last_window تنتهي كل العيّنات قبل (last_window+1)*step − TRIM
            let finalized = (seg.last_window + 1) * DEMIX_STEP - DEMIX_TRIM;
            assert!(
                finalized > seg.emit_end - 1,
                "segment {}: finalized {finalized} does not reach emit_end {}",
                seg.index,
                seg.emit_end
            );
        }
    }
}
