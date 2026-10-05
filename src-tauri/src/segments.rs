//! مخطِّط نوافذ الفصل المجزأ (المرحلة ٤أ‑1) — **نقي**: لا I/O ولا عتاد.
//!
//! **العلّة**: الملفات الطويلة (أطول من 300 ثانية — حجم المقطع، قرار المالك)
//! تُعالَج اليوم دفعة واحدة، فلا يكتب المنتج صوت صفحة قبل اكتمال الكل، وأي
//! قفزة في المنتصف تنتظر كل ما قبلها. الفصل المجزأ يقطّع النطاق إلى مقاطع
//! تشغيل، ويُعطي كل مقطع **سياق تداخل** عند الحوافّ كي لا يجوع النموذج، ثم
//! يُخاط النتائج بـ`crossfade` (المرحلة ٤أ‑2 — آلية fade القائمة، بلا اختراع).
//!
//! **وحدّ النطاق**: هذه الوحدة تخطيط فقط. التنفيذ (`separator.rs`) والمنتج
//! (`bridge`) وكتابة الملفات **خارجها** — ولا ثابت 300 مخزّن هنا (درس
//! `segqueue`: بلا مستهلك ⇒ بلا ميت؛ القيمة تُمرَّر من حيث تُقاس).
//!
//! **مسار الهوية حرفياً**: ملف ≤ طول النافذة ⇒ نافذة واحدة تساوي نواتها تساوي
//! `[0, total]` — المستدعي يمرّ بمسار الملف الكامل القائم بلا crossfade.

/// نافذة مخطَّطة واحدة على خطّ الزمن المطلق (بالثواني).
///
/// **النواة** (`core_start`/`core_len`) هي مقطع التشغيل الذي يُكتب ويُخدَم —
/// النوات متجاورة بلا تداخل، ورقم المقطع في البروتوكول هو `index + 1` (واحد
/// الأساس، كما يتكلم `content.js` و`segqueue`).
///
/// **نطاق المعالجة** (`start`/`len`) يوسّع النواة بـ`overlap` على الجانبين
/// (مقيَّد بـ`[0, total]`) كي يرى النموذج سياق الحوافّ.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    /// فهرس صفري. رقم مقطع التشغيل = `index + 1`.
    pub index: usize,
    /// بداية نطاق المعالجة (بالثواني).
    pub start: f64,
    /// طول نطاق المعالجة (بالثواني).
    pub len: f64,
    /// بداية النواة — بداية مقطع التشغيل.
    pub core_start: f64,
    /// طول النواة — طول مقطع التشغيل (آخر مقطع قد يقصر).
    pub core_len: f64,
}

impl Window {
    /// صحيح فقط حين يساوي نطاق المعالجة النواة بالضبط — أي لا سياق
    /// ولا crossfade. هذا هو **مسار الهوية** للمستدعي.
    pub fn is_identity(&self) -> bool {
        self.start == self.core_start && self.len == self.core_len
    }

    /// نهاية النواة الحصرية (بالثواني).
    pub fn core_end(&self) -> f64 {
        self.core_start + self.core_len
    }

    /// نهاية نطاق المعالجة الحصرية (بالثواني).
    pub fn end(&self) -> f64 {
        self.start + self.len
    }
}

/// يخطّط نوافذ الفصل المجزأ لملف طوله `total_secs`.
///
/// النوات تُغطّي `[0, total_secs]` بعرض `window_secs` (الآخر قد يقصر) — عقد
/// مقاطع التشغيل (`SEGMENT_SECS = 300` ورقم المقطع `index + 1`). كل نواة
/// تتوسّع بـ`overlap_secs` على الجانبين لسياق demix، مقيَّدة بالملف.
///
/// **الهوية (حرفياً)**: `total_secs <= window_secs` ⇒ نافذة واحدة تساوي
/// نواتها تساوي `[0, total]` ([`Window::is_identity`]) — المطلوب من المستدعي
/// أن يمرّ بالمسار القائم للملف الكامل دون crossfade.
///
/// مدخلات غير صالحة (`total_secs <= 0` · `window_secs <= 0` · `overlap_secs < 0`
/// · أو أي غير منتهٍ/NaN) ⇒ خطة فارغة — لا حالة ولا خطأ، على نمط
/// [`livemap::split_plan`] (ولكن برفض صريح لغير المنتهي: NaN و∞ يُفسدان
/// الحلقة أدناه).
pub fn plan_windows(total_secs: f64, window_secs: f64, overlap_secs: f64) -> Vec<Window> {
    if !total_secs.is_finite()
        || total_secs <= 0.0
        || !window_secs.is_finite()
        || window_secs <= 0.0
        || !overlap_secs.is_finite()
        || overlap_secs < 0.0
    {
        return Vec::new();
    }

    // ملف ≤ النافذة: نافذة هوية واحدة — بلا توسيع سياق إطلاقاً.
    if total_secs <= window_secs {
        return vec![Window {
            index: 0,
            start: 0.0,
            len: total_secs,
            core_start: 0.0,
            core_len: total_secs,
        }];
    }

    let mut out = Vec::new();
    let mut core_start = 0.0f64;
    let mut index = 0usize;
    while core_start < total_secs {
        let core_len = (total_secs - core_start).min(window_secs);
        let core_end = core_start + core_len;
        let start = (core_start - overlap_secs).max(0.0);
        let end = (core_end + overlap_secs).min(total_secs);
        out.push(Window {
            index,
            start,
            len: end - start,
            core_start,
            core_len,
        });
        core_start = core_end;
        index += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// الحدود المعلنة في التكليف حرفياً: 0 · 299 · 300 · 301 · 900.
    const WINDOW: f64 = 300.0;
    const OVERLAP: f64 = 2.0;

    #[test]
    fn zero_or_negative_total_plans_nothing() {
        assert!(plan_windows(0.0, WINDOW, OVERLAP).is_empty());
        assert!(plan_windows(-1.0, WINDOW, OVERLAP).is_empty());
    }

    #[test]
    fn invalid_window_or_overlap_plans_nothing() {
        assert!(plan_windows(600.0, 0.0, OVERLAP).is_empty());
        assert!(plan_windows(600.0, WINDOW, -1.0).is_empty());
        // غير منتهٍ/NaN مرفوض صراحة — وإلا حلّقت الحلقة أو فسدت الحدود.
        assert!(plan_windows(f64::NAN, WINDOW, OVERLAP).is_empty());
        assert!(plan_windows(f64::INFINITY, WINDOW, OVERLAP).is_empty());
        assert!(plan_windows(600.0, f64::NAN, OVERLAP).is_empty());
        assert!(plan_windows(600.0, WINDOW, f64::NAN).is_empty());
    }

    /// **مسار الهوية حرفياً** — ملف 299 (< 300) ⇒ نافذة واحدة تساوي نواتها.
    #[test]
    fn file_just_below_window_is_one_identity_window() {
        let p = plan_windows(299.0, WINDOW, OVERLAP);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].index, 0);
        assert_eq!(p[0].core_start, 0.0);
        assert_eq!(p[0].core_len, 299.0);
        assert!(p[0].is_identity(), "النواة = المعالجة = [0, 299]");
    }

    /// ملف 300 (= النافذة) — الهوية نفسها، بلا توسيع سياق.
    #[test]
    fn file_exactly_at_window_is_one_identity_window() {
        let p = plan_windows(WINDOW, WINDOW, OVERLAP);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].core_len, WINDOW);
        assert!(p[0].is_identity(), "النواة = المعالجة = [0, 300]");
    }

    /// ملف 301: نواتان — 300 + 1، ونطاق المعالجة يتوسّع بالسياق.
    #[test]
    fn file_just_over_window_splits_into_two_with_context() {
        let p = plan_windows(301.0, WINDOW, OVERLAP);
        assert_eq!(p.len(), 2);
        assert!(!p[0].is_identity());
        assert_eq!(p[0].core_start, 0.0);
        assert_eq!(p[0].core_len, 300.0);
        assert_eq!(p[1].core_start, 300.0);
        assert_eq!(p[1].core_len, 1.0);
        // سياق المعالجة: يسار الأول مقيَّد بـ0، ويمينه يمتد إلى نهاية الملف
        // (302 تُقيَّد بـ301); ويسار الثاني −overlap (داخل الأول)، ويمينه
        // مقيَّد بالنهاية. منطقة التداخل [298, 301] هي سياق كلٍّ منهما.
        assert_eq!(p[0].start, 0.0);
        assert!((p[0].end() - 301.0).abs() < 1e-9);
        assert!((p[1].start - 298.0).abs() < 1e-9);
        assert!((p[1].end() - 301.0).abs() < 1e-9);
        assert!((p[1].start - p[0].core_end()).abs() < 1e-9 + OVERLAP);
    }

    /// ملف 900: ثلاث نوات **مليئة** 300 — لا شذرة ذيل (لا اختراع).
    #[test]
    fn nine_hundred_is_three_full_segments() {
        let p = plan_windows(900.0, WINDOW, OVERLAP);
        assert_eq!(p.len(), 3);
        for (i, w) in p.iter().enumerate() {
            assert_eq!(w.index, i);
            assert_eq!(w.core_start, i as f64 * WINDOW);
            assert_eq!(w.core_len, WINDOW);
        }
        assert_eq!(p[2].core_end(), 900.0);
    }

    /// النوات تُغطّي `[0, total]` بالضبط، متجاورة بلا فجوة ولا تداخل نوات.
    #[test]
    fn cores_tile_the_file_exactly() {
        for total in [299.0, 300.0, 301.0, 450.0, 900.0, 1201.0] {
            let p = plan_windows(total, WINDOW, OVERLAP);
            let mut cursor = 0.0;
            for w in &p {
                assert!(
                    (w.core_start - cursor).abs() < 1e-9,
                    "gap/overlap at {}",
                    w.index
                );
                assert!(w.core_len > 0.0);
                cursor = w.core_end();
            }
            assert!(
                (cursor - total).abs() < 1e-9,
                "total={total} cursor={cursor}"
            );
        }
    }

    /// رقم المقطع في البروتوكول = `index + 1` (واحد الأساس — `content.js`/`segqueue`).
    #[test]
    fn segment_numbers_are_one_based() {
        let p = plan_windows(900.0, WINDOW, OVERLAP);
        let nums: Vec<usize> = p.iter().map(|w| w.index + 1).collect();
        assert_eq!(nums, vec![1, 2, 3]);
    }

    /// `overlap = 0` ⇒ نطاق المعالجة = النواة (لا سياق) — والهوية لملف واحد
    /// تبقى هوية، ومتعددة النوافذ تبقى بلا توسيع.
    #[test]
    fn zero_overlap_keeps_processing_equal_to_core() {
        let one = plan_windows(300.0, WINDOW, 0.0);
        assert!(one[0].is_identity());
        let two = plan_windows(301.0, WINDOW, 0.0);
        assert_eq!(two.len(), 2);
        assert!(two[0].is_identity());
        assert!(two[1].is_identity());
    }
}
