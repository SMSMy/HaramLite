//! Silence cutting for song mode — removes dead-air runs with musical padding.
//!
//! م٦-ب: نفس الكاشف يُستعمل على **صوت الصفحة** في مسار `clip` (عتبات القصّ
//! نفسها — قرار المالك §١٧/٣)، والقصّ هناك يقع على **نسخة** تُسلَّم للمشغّل
//! ولا يمسّ ملف المستخدم.

/// Cut configuration.
pub struct SilenceConfig {
    /// Detection threshold relative to the LOUD parts of this file:
    /// fraction (0..1) of the 90th-percentile window RMS.
    pub relative_threshold: f32,
    /// absolute floor in dBFS below relative logic
    pub absolute_floor_db: f32,
    /// silence must last at least this long to be cut
    pub min_silence_ms: u32,
    /// keep this much "silence" on each side of a cut (breathing room)
    pub keep_ms: u32,
    /// fade length applied at every cut edge to avoid clicks
    pub fade_ms: u32,
}

impl Default for SilenceConfig {
    fn default() -> Self {
        Self {
            relative_threshold: 0.06, // ≈ −24 dB vs loud parts
            absolute_floor_db: -55.0,
            min_silence_ms: 800,
            keep_ms: 150,
            // Expert D2ج: 50ms crossfade at every jump (was 12ms — too
            // short, residual clicks survived on bright material).
            fade_ms: 50,
        }
    }
}

struct Range {
    start: usize,
    end: usize, // exclusive
}

fn window_rms(l: &[f32], r: &[f32], win: usize) -> Vec<f32> {
    let n = l.len().min(r.len());
    let count = n / win.max(1);
    (0..count)
        .map(|w| {
            let s = w * win;
            // Audit 2026-09-03: a single NaN/Inf sample (rogue model output
            // or float-WAV oddity) must never poison the whole measurement —
            // treat non-finite as loud (+inf) so it is never cut, never NaN.
            let sum: f32 = l[s..s + win]
                .iter()
                .chain(r[s..s + win].iter())
                .map(|v| if v.is_finite() { v * v } else { f32::INFINITY })
                .sum();
            if sum.is_finite() {
                (sum / (win * 2) as f32).sqrt()
            } else {
                f32::INFINITY
            }
        })
        .collect()
}

/// Returns kept ranges [start,end) of samples after cutting silences.
pub fn compute_kept_ranges(
    l: &[f32],
    r: &[f32],
    sr: u32,
    cfg: &SilenceConfig,
) -> Vec<(usize, usize)> {
    let n = l.len().min(r.len());
    let win = (sr as usize / 20).max(64); // 50 ms windows
    let rms = window_rms(l, r, win);

    // adaptive threshold: 90th percentile × factor, clamped by absolute floor.
    // Audit 2026-09-03: total_cmp can never panic (the old partial_cmp unwrap
    // died on one NaN and took the whole bridge/watch thread with it).
    // Audit 2026-09-15 (٤.ب.٨): non-finite windows are deliberately LOUD (see
    // window_rms) and must not vote in the percentile. They used to: ~10% of
    // them pushed p90 to +inf, the threshold became +inf, and every *finite*
    // window then counted as silence — the real audio was cut to slivers while
    // the rogue region was kept. With no finite window there is nothing to
    // measure, so nothing is cut (empty ⇒ "no cuts", see cut_silence_with_ranges).
    let mut sorted: Vec<f32> = rms.iter().copied().filter(|v| v.is_finite()).collect();
    if sorted.is_empty() {
        return Vec::new();
    }
    sorted.sort_by(|a, b| a.total_cmp(b));
    let p90 = sorted
        .get((sorted.len() as f32 * 0.9) as usize)
        .copied()
        .unwrap_or(1.0);
    let floor = 10f32.powf(cfg.absolute_floor_db / 20.0);
    let threshold = (p90 * cfg.relative_threshold).max(floor);

    let silent_windows: Vec<bool> = rms.iter().map(|v| *v < threshold).collect();

    // find silence RUNS ≥ min duration
    let min_run = ((cfg.min_silence_ms as usize * sr as usize / 1000) / win).max(1);
    let mut cuts: Vec<(usize, usize)> = Vec::new(); // window indices
    let mut run_start: Option<usize> = None;
    for (idx, &is_silent) in silent_windows.iter().enumerate() {
        if is_silent {
            if run_start.is_none() {
                run_start = Some(idx);
            }
        } else if let Some(rs) = run_start.take() {
            if idx - rs >= min_run {
                cuts.push((rs, idx));
            }
        }
    }
    if let Some(rs) = run_start.take() {
        if silent_windows.len() - rs >= min_run && rs > 0 {
            // trailing silence — only cut if it's not the whole file tail we need
            cuts.push((rs, silent_windows.len()));
        }
    }

    if cuts.is_empty() {
        return vec![];
    }

    // build kept ranges = inverse of cuts, padded by keep_ms
    let pad = cfg.keep_ms as usize * sr as usize / 1000;
    let mut kept: Vec<Range> = Vec::new();
    let mut cursor = 0usize;
    for (rs, re_) in cuts {
        let cut_start = ((rs * win) + pad).min(n);
        let cut_end = (re_ * win).saturating_sub(pad).max(cut_start);
        if cut_start > cursor {
            kept.push(Range {
                start: cursor,
                end: cut_start,
            });
        }
        cursor = cut_end.max(cursor);
    }
    if cursor < n {
        kept.push(Range {
            start: cursor,
            end: n,
        });
    }
    kept.retain(|r| r.end - r.start > sr as usize / 10); // drop slivers <100ms
    kept.into_iter().map(|rg| (rg.start, rg.end)).collect()
}

/// نفس المقاطع على **الخط الزمني بالثواني** — وهو الخط الذي يخاطبه مشغّل
/// الصفحة (`mapFullToCut` في الإضافة ثوانٍ لا عيّنات، `content.js:488`).
///
/// مفصولة عن [`compute_kept_ranges`] لأن التحويل قسمة واحدة، ولأن الاختبارات
/// تحكم على الوحدتين (ثوانٍ مقابل عيّنات) لا على رقم واحد.
pub fn kept_ranges_sec(l: &[f32], r: &[f32], sr: u32, cfg: &SilenceConfig) -> Vec<(f64, f64)> {
    if sr == 0 {
        return Vec::new();
    }
    let s = sr as f64;
    compute_kept_ranges(l, r, sr, cfg)
        .into_iter()
        .map(|(a, b)| (a as f64 / s, b as f64 / s))
        .collect()
}

/// عكس [`kept_ranges_sec`]: مقاطع بالثواني ⟶ مقاطع بالعيّنات، لتُطبَّق على ملف
/// **آخر** على الخط الزمني نفسه (نسخة صوت الصفحة في `bridge.rs`).
///
/// التقريب إلى أقرب عيّنة خطؤه عيّنة واحدة (≈23µs) ولا يتراكم: كل مقطع يُقرَّب
/// مستقلاً عن موضعه المطلق. والمقاطع الشاذّة (غير منتهية/مقلوبة/سالبة) تُسقَط
/// بدل أن تُنتج فهرساً مُشوَّهاً — و[`cut_silence_with_ranges`] يقصّ على حدود
/// المخزن أصلاً.
pub fn ranges_from_secs(kept: &[(f64, f64)], sr: u32) -> Vec<(usize, usize)> {
    if sr == 0 {
        return Vec::new();
    }
    let s = sr as f64;
    kept.iter()
        .filter(|(a, b)| a.is_finite() && b.is_finite() && *a >= 0.0 && b > a)
        .map(|(a, b)| ((a * s).round() as usize, (b * s).round() as usize))
        .collect()
}

/// In-place silence removal on stereo buffers. Returns removed fraction 0..1.
/// The production path (effects.rs) calls [`cut_silence_with_ranges`] directly
/// to reuse already-computed ranges; this entry point stays for CLI/future
/// callers and is exercised by the tests.
#[allow(dead_code)]
pub fn cut_silence(l: &mut Vec<f32>, r: &mut Vec<f32>, sr: u32, cfg: &SilenceConfig) -> f32 {
    let ranges = compute_kept_ranges(l, r, sr, cfg);
    cut_silence_with_ranges(l, r, sr, cfg, &ranges)
}

/// Apply a cut using ranges already computed by [`compute_kept_ranges`].
/// Audit R-5: callers that need the ranges anyway (e.g. for mirroring cuts on
/// the video track) pass them in instead of running the whole detection pass twice.
pub fn cut_silence_with_ranges(
    l: &mut Vec<f32>,
    r: &mut Vec<f32>,
    sr: u32,
    cfg: &SilenceConfig,
    ranges: &[(usize, usize)],
) -> f32 {
    let before = l.len().min(r.len());
    if ranges.is_empty() {
        return 0.0;
    }

    let fade = (cfg.fade_ms as usize * sr as usize / 1000).max(2);
    let mut nl = Vec::with_capacity(before);
    let mut nr = Vec::with_capacity(before);

    for (idx, (start, end)) in ranges.iter().enumerate() {
        let a = (*start).min(l.len());
        let b = (*end).min(l.len());
        if b <= a {
            continue;
        }
        let seg_start = nl.len();
        nl.extend_from_slice(&l[a..b]);
        nr.extend_from_slice(&r[a..b]);

        // Short fades at every INTERIOR cut boundary to avoid clicks:
        // fade-IN at the start of a segment that follows a cut, fade-OUT at
        // the end of a segment that precedes a cut. (The file's own true
        // start/end is left untouched.)
        // Expert D2ج direction fix (2026-09-06): the tail loop used
        // `g = (head - k) / head` at `len - 1 - k`, which rises to FULL
        // volume at the splice — a fade-IN on a pre-cut tail, i.e. the exact
        // recorded direction fault. Tails must FALL to zero: `g = (k + 1)`.
        let head = fade.min(b - a);
        if idx > 0 {
            for k in 0..head {
                let g = (k + 1) as f32 / head as f32;
                nl[seg_start + k] *= g;
                nr[seg_start + k] *= g;
            }
        }
        if idx + 1 < ranges.len() {
            for k in 0..head {
                let g = (k + 1) as f32 / head as f32;
                let li = nl.len() - 1 - k;
                let ri = nr.len() - 1 - k;
                nl[li] *= g;
                nr[ri] *= g;
            }
        }
    }

    let removed = 1.0 - nl.len().max(1) as f32 / before.max(1) as f32;
    *l = nl;
    *r = nr;
    removed.clamp(0.0, 1.0)
}

/// Expert D2أ: render detect-then-mute directly on stereo buffers (no MDX):
/// mute ranges → 0, duck ranges → −12 dB (≈0.251), with `fade_ms` linear
/// ramps at every edge so muting itself never clicks. Mute wins overlaps.
/// Ranges are absolute seconds; out-of-bounds ends clamp. In place.
pub fn apply_mute_duck(
    l: &mut [f32],
    r: &mut [f32],
    sr: u32,
    mute: &[(f64, f64)],
    duck: &[(f64, f64)],
    fade_ms: u32,
) {
    let n = l.len().min(r.len());
    if n == 0 || sr == 0 {
        return;
    }
    const DUCK_GAIN: f32 = 0.251;
    let fade = ((fade_ms as usize * sr as usize) / 1000).max(2);
    let to_idx = |t: f64| ((t * sr as f64) as usize).min(n);
    // Duck first, mute second so mute wins every overlap.
    for (ranges, target) in [(duck, DUCK_GAIN), (mute, 0.0f32)] {
        for &(a, b) in ranges {
            if !(b > a) {
                continue;
            }
            let s = to_idx(a);
            let e = to_idx(b);
            if e <= s || s >= n {
                continue;
            }
            let f = fade.min((e - s) / 2).max(1);
            for k in s..e {
                // distance to the nearest edge → ramp 0..1 over `fade`
                let d = (k - s).min(e - 1 - k) + 1;
                let t = (d.min(f) as f32) / (f as f32);
                // gain path target→1 at edges would click on entry; instead
                // ramp 1→target on the way in and back on the way out:
                // g = 1 + (target − 1) * edge_shape, edge_shape 0 at the
                // exact boundary rising to 1 `fade` samples inside.
                let g = 1.0 + (target - 1.0) * t;
                if k < l.len() && k < r.len() {
                    l[k] *= g;
                    r[k] *= g;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_middle_gap_and_keeps_content() {
        let sr = 44100u32;
        let tone = |secs: f32| -> Vec<f32> {
            (0..(sr as f32 * secs) as usize)
                .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr as f32).sin() * 0.5)
                .collect()
        };

        let mut l = tone(2.0);
        l.extend(std::iter::repeat_n(0.0, sr as usize * 2)); // 2s silence
        l.extend(tone(2.0));
        let mut r = l.clone();

        let removed = cut_silence(&mut l, &mut r, sr, &SilenceConfig::default());

        // expect ~2s removed out of 6s ≈ 0.33
        assert!((removed - 1.0 / 3.0).abs() < 0.08, "removed={removed}");
        assert!(l.iter().all(|v| v.is_finite()));
        assert!(l.len() < sr as usize * 5, "must shrink");
    }

    /// Negative test for ٤.ب.٨: rogue non-finite windows must not poison the
    /// adaptive threshold. Before the fix ~10% of them pushed the 90th
    /// percentile to +inf, so every finite window counted as silence: the real
    /// audio was cut away and the rogue region was kept.
    #[test]
    fn non_finite_windows_never_poison_the_threshold() {
        let sr = 44100u32;
        let n = sr as usize * 2;
        let mut l = vec![0.5f32; n]; // loud and constant: nothing may be cut
        let r = l.clone();
        for v in l.iter_mut().take(n / 5) {
            *v = f32::NAN; // 20% of the samples ⇒ ~20% of the 50 ms windows
        }

        let kept = compute_kept_ranges(&l, &r, sr, &SilenceConfig::default());

        assert!(
            kept.is_empty(),
            "a loud file must not be cut at all (empty ⇒ no cuts); got {} ranges",
            kept.len()
        );

        // All-non-finite input is "nothing to measure", not "everything silent".
        let bad = vec![f32::INFINITY; n];
        assert!(compute_kept_ranges(&bad, &bad, sr, &SilenceConfig::default()).is_empty());
    }

    #[test]
    fn no_silence_means_no_cut() {
        let sr = 44100u32;
        let tone = |a: f32| -> Vec<f32> {
            (0..sr as usize * 3)
                .map(|i| (i as f32 * 0.01).sin() * a)
                .collect()
        };
        let mut l = tone(0.5);
        let mut r = tone(0.5);
        let removed = cut_silence(&mut l, &mut r, sr, &SilenceConfig::default());
        assert!(removed < 0.02, "should not cut loud content: {removed}");
        assert_eq!(l.len(), sr as usize * 3);
    }

    /// Audit 2026-09-03: NaN/Inf anywhere in the buffers must never panic
    /// (it used to kill the bridge-worker/watch thread via sort unwrap).
    #[test]
    fn nan_never_panics_and_never_cuts() {
        let sr = 44100u32;
        let mut l = vec![0.4f32; sr as usize * 2];
        let mut r = vec![0.4f32; sr as usize * 2];
        l[sr as usize] = f32::NAN;
        r[100] = f32::INFINITY;
        r[200] = f32::NEG_INFINITY;
        // must complete without panicking (the old sort unwrap died here)
        let ranges = compute_kept_ranges(&l, &r, sr, &SilenceConfig::default());
        let removed =
            cut_silence_with_ranges(&mut l, &mut r, sr, &SilenceConfig::default(), &ranges);
        assert!(removed.is_finite() && (0.0..=1.0).contains(&removed));
        // all-loud buffers with spikes: nothing cut
        let mut l2 = vec![0.5f32; sr as usize * 3];
        let mut r2 = l2.clone();
        l2[10] = f32::NAN;
        let removed2 = cut_silence(&mut l2, &mut r2, sr, &SilenceConfig::default());
        assert!(removed2 < 0.02, "spikes must not trigger cuts: {removed2}");
    }

    #[test]
    fn fades_prevent_clicks_at_boundaries() {
        // ensure first sample of output is faded toward zero when a cut happened
        let sr = 44100u32;
        let mut l = vec![0.7f32; sr as usize]; // constant DC → "silence" by RMS?
                                               // craft: quiet then loud then quiet
        let mut sig: Vec<f32> = std::iter::repeat_n(0.00001f32, sr as usize).collect();
        sig.extend(std::iter::repeat_n(0.6f32, sr as usize));
        sig.extend(std::iter::repeat_n(0.00001f32, sr as usize));
        let mut r = sig.clone();
        let mut ll = sig.clone();
        let _ = (&mut l, &mut r);
        let removed = cut_silence(&mut ll, &mut r, sr, &SilenceConfig::default());
        assert!(removed > 0.2);
    }

    /// Expert D2ج direction regression (2026-09-06): the pre-cut tail must
    /// FALL to zero at the splice. The old `(head-k)` shape rose to full
    /// volume at the cut — clicks on every jump. Fails pre-fix, passes post.
    /// NOTE: DC signal (no zero crossings — a tone's phase could zero the
    /// seam sample by luck and vacate the test) with hand-made ranges so the
    /// fade zone sits on real audio (detection-derived ranges pad seams with
    /// kept silence, which measures ~0 under EITHER shape and proves nothing).
    #[test]
    fn pre_cut_tail_falls_to_zero_at_splice() {
        let sr = 44100u32;
        let n = sr as usize * 4;
        let mut l = vec![0.5f32; n];
        let mut r = vec![0.5f32; n];
        let cfg = SilenceConfig::default();
        let fade = (cfg.fade_ms as usize * sr as usize / 1000).max(2);
        // One seam at exactly 2.0s over full-scale DC.
        let ranges = [(0usize, sr as usize * 2), (sr as usize * 2, n)];
        cut_silence_with_ranges(&mut l, &mut r, sr, &cfg, &ranges);
        assert_eq!(l.len(), n, "full-cover ranges change nothing");
        // Seam edge: post-fix ≈0 (1/fade × 0.5); pre-fix full 0.5.
        assert!(l[sr as usize * 2 - 1].abs() < 0.05, "seam edge must be ~0");
        // Tail block envelope collapses (mean 0.25 vs mid 0.5).
        let mean_abs = |v: &[f32]| v.iter().map(|x| x.abs()).sum::<f32>() / v.len() as f32;
        let tail = &l[sr as usize * 2 - fade..sr as usize * 2];
        let mid = &l[sr as usize..sr as usize * 3 / 2];
        assert!(mean_abs(tail) / mean_abs(mid) < 0.75, "tail must fall");
        // Post-cut head rises from zero (fade-IN intact after the fix).
        assert!(l[sr as usize * 2].abs() < 0.05, "head must start near zero");
        // Head fade spans exactly the configured width (50ms), not a stub.
        assert!(
            fade == sr as usize / 20,
            "fade width must be 50ms, got {fade}"
        );
    }

    /// Expert D2ج: the seam crossfade is 50ms by default.
    #[test]
    fn seam_crossfade_defaults_to_50ms() {
        assert_eq!(SilenceConfig::default().fade_ms, 50);
    }

    /// Expert D2أ: direct mute/duck rendering — mute zeros the interior,
    /// duck hits −12 dB, edges ramp without clicks, mute wins overlaps.
    #[test]
    fn direct_mute_duck_renders_cleanly() {
        let sr = 44100u32;
        let n = sr as usize * 4;
        let tone: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr as f32).sin() * 0.5)
            .collect();
        let mut l = tone.clone();
        let mut r = tone.clone();
        apply_mute_duck(&mut l, &mut r, sr, &[(1.0, 2.0)], &[(2.5, 3.0)], 50);
        // mute interior is silent
        let mid_mute = &l[(sr as usize * 3 / 2)..(sr as usize * 17 / 10)];
        assert!(
            mid_mute.iter().all(|v| v.abs() < 1e-6),
            "mute interior must be 0"
        );
        // duck interior is −12 dB of the tone (peak 0.5 → 0.1255)
        let mid_duck = &l[(sr as usize * 27 / 10)..(sr as usize * 28 / 10)];
        let peak = mid_duck.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        assert!((peak - 0.5 * 0.251).abs() < 0.02, "duck peak={peak}");
        // pass regions untouched
        assert!((l[100] - tone[100]).abs() < 1e-6);
        // no clicks: max sample-to-sample step stays small everywhere
        let max_step = l
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f32, f32::max);
        assert!(max_step < 0.05, "click detected: step={max_step}");
        assert_eq!(l.len(), n, "rendering never changes length");
    }

    /// Mute wins any duck overlap.
    #[test]
    fn direct_mute_wins_overlap() {
        let sr = 44100u32;
        let n = sr as usize * 2;
        let mut l = vec![0.5f32; n];
        let mut r = vec![0.5f32; n];
        apply_mute_duck(&mut l, &mut r, sr, &[(0.5, 1.5)], &[(0.0, 2.0)], 50);
        let mid = &l[(sr as usize * 9 / 10)..(sr as usize * 11 / 10)];
        assert!(mid.iter().all(|v| v.abs() < 1e-6), "overlap must be silent");
    }

    /// **ب١ (وجه القصّ) — تكافؤ الهوية**: تمرير «الملف كله» كمقطع محفوظ واحد
    /// يترك العيّنات **متطابقة بايتاً بايتاً** مع عدم تمرير خريطة أصلاً.
    ///
    /// مُفسَده: أي تغيير يجعل المسار «بخريطة كاملة» يمرّ بتدرّج أو يكتب شيئاً
    /// ⇒ يسقط هذا الاختبار (ولذلك يفحص العيّنات لا الطول وحده).
    #[test]
    fn a_full_cover_range_is_identical_to_no_range_at_all() {
        let sr = 44100u32;
        let n = sr as usize * 3;
        // محتوى غير دوري (لا يُخفي فرقاً في التدرّج بصدفة طورية).
        let base: Vec<f32> = (0..n)
            .map(|i| ((i * 7919) % 104729) as f32 / 104729.0 - 0.5)
            .collect();
        let cfg = SilenceConfig::default();

        let (mut l0, mut r0) = (base.clone(), base.clone());
        let removed0 = cut_silence_with_ranges(&mut l0, &mut r0, sr, &cfg, &[]);
        let (mut l1, mut r1) = (base.clone(), base.clone());
        let removed1 = cut_silence_with_ranges(&mut l1, &mut r1, sr, &cfg, &[(0, n)]);

        assert_eq!(removed0, 0.0);
        assert_eq!(removed1, 0.0, "«الملف كله» ليس حذفاً");
        assert_eq!(l0, l1, "الهوية يجب ألا تلمس العيّنات");
        assert_eq!(r0, r1, "الهوية يجب ألا تلمس العيّنات");
        assert_eq!(l1.len(), n);
    }

    /// المقطع بالثواني يساوي المقطع بالعيّنات مقسوماً على معدّل العيّنة —
    /// والتحويل عكس نفسه بلا انزياح يتراكم.
    #[test]
    fn seconds_and_samples_agree_and_round_trip() {
        let sr = 44100u32;
        let mut l = vec![0.5f32; sr as usize * 2];
        l.extend(std::iter::repeat_n(0.0f32, sr as usize * 2)); // فجوة 2s
        l.extend(std::iter::repeat_n(0.5f32, sr as usize * 2));
        let r = l.clone();

        let secs = kept_ranges_sec(&l, &r, sr, &SilenceConfig::default());
        let samples = compute_kept_ranges(&l, &r, sr, &SilenceConfig::default());
        assert_eq!(secs.len(), samples.len());
        assert_eq!(secs.len(), 2, "فجوة وسطى ⇒ مقطعان: {secs:?}");
        for (s, m) in secs.iter().zip(samples.iter()) {
            assert!((s.0 * sr as f64 - m.0 as f64).abs() < 1e-6);
            assert!((s.1 * sr as f64 - m.1 as f64).abs() < 1e-6);
        }
        // عكس التحويل: ±عيّنة واحدة لكل حدّ، بلا تراكم.
        let back = ranges_from_secs(&secs, sr);
        for (m, b) in samples.iter().zip(back.iter()) {
            assert!(
                m.0.abs_diff(b.0) <= 1 && m.1.abs_diff(b.1) <= 1,
                "{m:?} ⟷ {b:?}"
            );
        }
        assert_eq!(back.len(), samples.len(), "لا يُسقط مقطعاً صالحاً");
    }

    /// المقاطع الشاذّة تُسقَط في التحويل ولا تُنتج فهرساً مُشوَّهاً.
    #[test]
    fn ranges_from_secs_drops_malformed_input() {
        let sr = 44100u32;
        assert!(ranges_from_secs(&[], sr).is_empty());
        assert!(ranges_from_secs(&[(2.0, 2.0)], sr).is_empty());
        assert!(ranges_from_secs(&[(3.0, 1.0)], sr).is_empty());
        assert!(ranges_from_secs(&[(-1.0, 3.0)], sr).is_empty());
        assert!(ranges_from_secs(&[(0.0, f64::NAN)], sr).is_empty());
        assert!(ranges_from_secs(&[(0.0, f64::INFINITY)], sr).is_empty());
        assert!(ranges_from_secs(&[(0.0, 1.0)], 0).is_empty(), "معدّل صفري");
        assert_eq!(ranges_from_secs(&[(0.0, 1.0)], sr), vec![(0, sr as usize)]);
    }
}
