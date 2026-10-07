//! مصرف الوحدات التدريجيّ — الخطوة ٤أ/٣ من المرحلة ٤أ.
//!
//! يستهلك [`SegmentSink`]: يجمع العيّنات النهائية الواصلة نافذةً-بنافذة في
//! وحدات **خطوة** على الشبكة العالمية ([`crate::segments::DEMIX_STEP`]
//! عيّنة = 4.4408 ث)، ويُسلّم كل وحدة مكتملة إلى مُرمِّز مُحقون يكتب
//! `unit-XXXX.mp3` في مجلد `page-audio`.
//!
//! العقد المُلزِم (قرار المالك، HANDOFF §١١):
//! • كل وحدة على **مرساتها المطلقة** — رقمها من موضع أوّل عيّنة فيها في
//!   الشبكة، وممنوع اشتقاق أي موضع من نهاية وحدة سابقة ⇒ التراكم مستحيل
//!   بالبناء مهما كان ترتيب وصول المقاطع (والأولوية قادمة).
//! • فشل ترميز/كتابة وحدة **يُنحدر ويُعلَن**: أوّل فشل يحسم [`UnitSnapshot::degraded`]
//!   ويتوقّف إصدار الوحدات (بلا تراكم ذاكرة)، ويبقى مسارُ الملف الكامل
//!   مكتملاً — **ولا يخرج `Err` من فشل الكتابة إلى مسار الفصل أبداً**.
//!   أما خرقُ هندسة الإصدار (شريحة خارج نطاق المقطع) فخطأُ مُرسِل يُعلَن
//!   عالياً — إنه عطب في المُصدِر لا تعذُرٌ في الترميز.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::segments::SegmentPlan;
use crate::separator::{SepError, SegmentSink};

/// معلومة وحدة مخدومة: `k` واحد-أساس على الشبكة المطلقة، و`total` حجم
/// ملفها المكتوب **في تلك الوحدة**، و`done` اكتمال ترميزها.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitInfo {
    pub k: usize,
    pub total: usize,
    pub done: bool,
}

/// لقطة حالة الوحدات للقارئ (خدمة الصفحة أثناء الكتابة): القائمة بالترتيب
/// الزمني للاكتمال، والحال إن انحدر مسار الوحدات.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UnitSnapshot {
    pub units: Vec<UnitInfo>,
    pub degraded: Option<String>,
}

/// مُرمِّز وحدة مُحقون: يستقبل رقمَ وحدة مكتملة (واحد-أساس) وعيّناتها
/// (ستيريو f32) ويعيد حجم الملف المكتوب. الإنتاج: wav مؤقّت → ffmpeg
/// `libmp3lame` 320k → إعادة تسمية ذرّية؛ والاختبار: مُرمِّز مزيّف.
pub trait UnitEncode: Send {
    fn encode(&mut self, k: usize, samples: &[Vec<f32>; 2]) -> Result<usize, String>;
}

/// اسم ملف الوحدة: `unit-0001.mp3` تغطّي العيّنات `[0, DEMIX_STEP)`.
pub fn unit_file_name(k: usize) -> String {
    format!("unit-{k:04}.mp3")
}

/// وحدة مفتوحة لم تكتمل بعد (فهرس صفري داخلياً).
#[derive(Default)]
struct OpenUnit {
    l: Vec<f32>,
    r: Vec<f32>,
}

/// المُجمِّع النقيّ: يوزّع الشرائح الواصلة على وحدات الشبكة ويُرمّز
/// المكتمل. النقاوة هدفاً: كل المنطق يُقاس بلا ffmpeg ولا عتاد ولا I/O.
pub struct UnitAggregator<'e> {
    unit_size: usize,
    open: BTreeMap<usize, OpenUnit>,
    encoder: &'e mut dyn UnitEncode,
    completed: Vec<UnitInfo>,
    degraded: Option<String>,
}

impl<'e> UnitAggregator<'e> {
    pub fn new(unit_size: usize, encoder: &'e mut dyn UnitEncode) -> Self {
        assert!(unit_size > 0, "حجم وحدة صفريّ لا معنى له");
        Self {
            unit_size,
            open: BTreeMap::new(),
            encoder,
            completed: Vec::new(),
            degraded: None,
        }
    }

    /// رقم الوحدة (واحد-أساس) التي تقع فيها عيّنة عالميّة — من الشبكة لا
    /// من الجار. النقية معروضة لكي يقرأها العميل بالجدول نفسه.
    pub fn unit_of(global_sample: usize, unit_size: usize) -> usize {
        global_sample / unit_size + 1
    }

    /// استقبال شريحة نهائية من مقطع: تُوزَّع على وحدات الشبكة وتُقتطع عند
    /// حدودها بالضبط. ترتيبُ الوصول حرّ (المقاطع دوالّ نقية)، والمراسي
    /// تُحسب من الموضع العالميّ لا من مجرى الوصول.
    pub fn push(
        &mut self,
        plan: &SegmentPlan,
        emit_offset: usize,
        part: &[Vec<f32>; 2],
    ) -> Result<(), SepError> {
        if self.degraded.is_some() {
            return Ok(()); // منحدر: صمتٌ مطيع بلا تراكم
        }
        let emit_len = plan.emit_end - plan.emit_start;
        if emit_offset + part[0].len() > emit_len {
            return Err(SepError::InvalidInput(format!(
                "شريحة مصرف الوحدات خارج نطاق المقطع {}: {} + {} > {emit_len}",
                plan.index,
                plan.emit_start,
                emit_offset + part[0].len()
            )));
        }
        let mut global = plan.emit_start + emit_offset;
        let mut i = 0usize;
        while i < part[0].len() {
            let unit = global / self.unit_size;
            let inside = global % self.unit_size;
            let take = (part[0].len() - i).min(self.unit_size - inside);
            let filled = {
                let buf = self.open.entry(unit).or_default();
                buf.l.extend_from_slice(&part[0][i..i + take]);
                buf.r.extend_from_slice(&part[1][i..i + take]);
                buf.l.len()
            };
            i += take;
            global += take;
            if filled == self.unit_size {
                let full = self.open.remove(&unit).expect("وحدة فُتحت في هذه الجولة");
                self.finish_unit(unit, full);
                if self.degraded.is_some() {
                    return Ok(()); // أوّل فشل يحسم: توقّف بلا تراكم
                }
            }
        }
        Ok(())
    }

    fn finish_unit(&mut self, unit: usize, buf: OpenUnit) {
        let k = unit + 1;
        match self.encoder.encode(k, &[buf.l, buf.r]) {
            Ok(total) => self.completed.push(UnitInfo { k, total, done: true }),
            Err(reason) => {
                if self.degraded.is_none() {
                    self.degraded = Some(reason);
                }
                self.open.clear(); // توقّف الإصدار: لا وحدات نصف مكتملة معلّقة
            }
        }
    }

    /// إتمام التشغيل: تُفرَّغ البقايا كوحدةٍ أخيرة قصيرة على مرساتها من
    /// الشبكة (آخر مقطع لا يبلغ مضاعف 67·step). ومع الانحدار: لا شيء.
    /// المقطع الداخلي ينتهي على حافة وحدة بالضبط (التبليط المُقيس
    /// 67·[`crate::segments::SEGMENT_STEPS`]) فلا بقايا فيه أصلًا.
    pub fn finish(&mut self) {
        if self.degraded.is_some() {
            return;
        }
        let remaining: Vec<(usize, OpenUnit)> = std::mem::take(&mut self.open).into_iter().collect();
        for (unit, buf) in remaining {
            if buf.l.is_empty() {
                continue;
            }
            self.finish_unit(unit, buf);
            if self.degraded.is_some() {
                break;
            }
        }
    }

    pub fn snapshot(&self) -> UnitSnapshot {
        UnitSnapshot {
            units: self.completed.clone(),
            degraded: self.degraded.clone(),
        }
    }
}

/// المصرف الإنتاجيّ المُمرَّر إلى `separate`: يغلّف المُجمِّع بنسخة قراءة
/// مشتركة تُمسك قبل إطلاق مهمّة الفصل وتُقرأ من مسار الخدمة أثناء الكتابة.
pub struct UnitSink<'e> {
    core: Mutex<UnitAggregator<'e>>,
    shared: Arc<Mutex<UnitSnapshot>>,
}

impl<'e> UnitSink<'e> {
    pub fn new(unit_size: usize, encoder: &'e mut dyn UnitEncode) -> Self {
        Self {
            core: Mutex::new(UnitAggregator::new(unit_size, encoder)),
            shared: Arc::default(),
        }
    }

    /// مقبض القارئ — يُحفظ لدى الجسر لخدمة `page_units`/`page_unit` أثناء
    /// الكتابة.
    pub fn reader(&self) -> Arc<Mutex<UnitSnapshot>> {
        Arc::clone(&self.shared)
    }

    /// إتمام التشغيل: تفريغ الوحدة الأخيرة القصيرة إن وُجدت.
    pub fn finish(&self) {
        if let Ok(mut core) = self.core.lock() {
            core.finish();
        }
        self.refresh();
    }

    fn refresh(&self) {
        let snap = self.core.lock().map(|c| c.snapshot()).unwrap_or_default();
        if let Ok(mut s) = self.shared.lock() {
            *s = snap;
        }
    }
}

impl SegmentSink for UnitSink<'_> {
    fn samples_ready(
        &self,
        plan: &SegmentPlan,
        emit_offset: usize,
        part: &[Vec<f32>; 2],
    ) -> Result<(), SepError> {
        let out = self
            .core
            .lock()
            .expect("قفل مصرف الوحدات")
            .push(plan, emit_offset, part);
        self.refresh();
        out
    }
}

/// المُرمِّز الإنتاجيّ: wav مؤقّت → ffmpeg `libmp3lame` 320k → ملف `.part`
/// → إعادة تسمية ذرّية إلى الاسم النهائي ⇒ لا تُخدَم وحدة نصف مكتملة أبداً.
pub struct ProductionUnitEncoder {
    pub dir: PathBuf,
    pub sr: u32,
}

impl UnitEncode for ProductionUnitEncoder {
    fn encode(&mut self, k: usize, samples: &[Vec<f32>; 2]) -> Result<usize, String> {
        let name = unit_file_name(k);
        let wav = self.dir.join(format!("unit-{k:04}.tmp.wav"));
        let part = self.dir.join(format!("{name}.part"));
        let done_path = self.dir.join(&name);
        crate::separator::write_wav_stereo_f32_pub(&wav, &samples[0], &samples[1], self.sr)
            .map_err(|e| format!("كتابة wav للوحدة {k}: {e}"))?;
        let encoded = crate::media::compress_audio(&wav, &part, 320);
        let _ = std::fs::remove_file(&wav); // المؤقّت يُزال في الحالين
        encoded.map_err(|e| format!("ترميز الوحدة {k}: {e}"))?;
        std::fs::rename(&part, &done_path).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("إتمام الوحدة {k}: {e}")
        })?;
        std::fs::metadata(&done_path)
            .map(|m| m.len() as usize)
            .map_err(|e| format!("قياس الوحدة {k}: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNIT: usize = 1000;

    fn plan(index: usize, emit_start: usize, emit_end: usize) -> SegmentPlan {
        SegmentPlan {
            index,
            emit_start,
            emit_end,
            first_window: 0,
            last_window: 0,
        }
    }

    struct FakeEncoder {
        calls: Vec<(usize, usize)>,
        fail_on: Option<usize>,
    }

    impl FakeEncoder {
        fn new() -> Self {
            Self {
                calls: Vec::new(),
                fail_on: None,
            }
        }
    }

    impl UnitEncode for FakeEncoder {
        fn encode(&mut self, k: usize, samples: &[Vec<f32>; 2]) -> Result<usize, String> {
            if self.fail_on == Some(k) {
                return Err(format!("مُرمِّز يفشل على الوحدة {k}"));
            }
            let samples_n = samples[0].len();
            self.calls.push((k, samples_n));
            Ok(samples_n * 2) // بايتتان تمثيليّتان لكل عيّنة
        }
    }

    fn chunk(len: usize) -> [Vec<f32>; 2] {
        [vec![1.0f32; len], vec![2.0f32; len]]
    }

    /// أسماء الملفات هي المراسي المعروضة للعميل: `unit-0001` تغطّي
    /// `[0, step)` مهما كان ترتيب الوصول.
    #[test]
    fn unit_file_names_are_zero_padded_four_digits() {
        assert_eq!(unit_file_name(1), "unit-0001.mp3");
        assert_eq!(unit_file_name(67), "unit-0067.mp3");
        assert_eq!(unit_file_name(12_345), "unit-12345.mp3");
    }

    /// الوحدة تكتمل **عند حافة الشبكة بالضبط**: مهما كانت تقطيعات الوارد،
    /// الترميز يُنادى مرة واحدة لكل وحدة بطولها الكامل ومرساتها الصحيحة.
    #[test]
    fn units_complete_exactly_at_each_grid_boundary() {
        let mut enc = FakeEncoder::new();
        {
            let mut agg = UnitAggregator::new(UNIT, &mut enc);
            let p = plan(0, 0, 3 * UNIT);
            for (offset, len) in [(0usize, 700usize), (700, 500), (1200, 1500), (2700, 300)] {
                agg.push(&p, offset, &chunk(len)).expect("لا خطأ من التجميع");
            }
            let snap = agg.snapshot();
            assert_eq!(
                snap.units,
                vec![
                    UnitInfo { k: 1, total: 2000, done: true },
                    UnitInfo { k: 2, total: 2000, done: true },
                    UnitInfo { k: 3, total: 2000, done: true },
                ],
                "ثلاث وحدات مكتملة بمراسي الشبكة: {:?}",
                snap.units
            );
            assert!(snap.degraded.is_none());
        }
        assert_eq!(
            enc.calls,
            vec![(1, UNIT), (2, UNIT), (3, UNIT)],
            "ترميز مرة واحدة لكل وحدة بطولها الكامل"
        );
    }

    /// الشريحة العابرة لحدّ وحدة تُقتطع عنده بالضبط — لا عيّنة تنتقل بين
    /// وحدتين ولا تُرمّز وحدةٌ قبل اكتمالها.
    #[test]
    fn a_slice_spanning_a_boundary_is_split_exactly() {
        let mut enc = FakeEncoder::new();
        {
            let mut agg = UnitAggregator::new(UNIT, &mut enc);
            let p = plan(0, 0, 3 * UNIT);
            agg.push(&p, 0, &chunk(1500)).expect("الشريحة الأولى");
            assert_eq!(agg.snapshot().units.len(), 1, "الوحدة 1 اكتملت عند الحدّ");
            agg.push(&p, 1500, &chunk(1500)).expect("الشريحة الثانية");
            assert_eq!(agg.snapshot().units.len(), 3, "القسمة عند الحدود كاملة");
        }
        assert_eq!(
            enc.calls,
            vec![(1, UNIT), (2, UNIT), (3, UNIT)],
            "ترميز مرة واحدة لكل وحدة بطولها الكامل"
        );
    }

    /// مقطع داخلي ينتهي على حافة وحدة فلا يُفرَّغ شيء عنده؛ والبقايا لا
    /// تُرمَّز إلا عند `finish` — وهي الوحدة الأخيرة القصيرة بمرساتها.
    #[test]
    fn the_final_short_unit_flushes_on_finish_with_its_grid_anchor() {
        let mut enc = FakeEncoder::new();
        {
            let mut agg = UnitAggregator::new(UNIT, &mut enc);
            let p = plan(0, 0, 2 * UNIT + 500);
            agg.push(&p, 0, &chunk(2 * UNIT + 500)).expect("الشريحة");
            assert_eq!(
                agg.snapshot().units.len(),
                2,
                "لا ترميز للبقايا قبل الإتمام"
            );
            agg.finish();
            let snap = agg.snapshot();
            assert_eq!(snap.units.len(), 3);
            assert_eq!(snap.units.last().expect("الوحدة الأخيرة").k, 3);
            assert!(snap.units.last().unwrap().done);
        }
        assert_eq!(enc.calls, vec![(1, UNIT), (2, UNIT), (3, 500)]);
    }

    /// فشلُ كتابة/ترميز وحدة **يُنحدر ويُعلَن ولا يخرج خطأً**: الأول يحسم،
    /// وما بعد الانحدار صمتٌ مطيع بلا استدعاءات ولا تراكم ذاكرة.
    #[test]
    fn a_unit_write_failure_degrades_and_never_propagates() {
        let mut enc = FakeEncoder::new();
        enc.fail_on = Some(2);
        {
            let mut agg = UnitAggregator::new(UNIT, &mut enc);
            let p = plan(0, 0, 4 * UNIT);
            // دفعةٌ واحدة تعبر الوحدة الفاشلة — ولا `Err` يخرج مهما حدث.
            agg.push(&p, 0, &chunk(2500)).expect("فشل الكتابة لا يخرج خطأً");
            let snap = agg.snapshot();
            assert_eq!(snap.units.len(), 1, "الوحدة 1 اكتملت قبل الفشل");
            assert!(
                snap.degraded.as_deref() == Some("مُرمِّز يفشل على الوحدة 2"),
                "الانحدار مُعلَن بساببه: {:?}",
                snap.degraded
            );
            // ما بعد الانحدار: الوارد يُستقبل بلا استدعاء مُرمِّز ولا ذاكرة.
            agg.push(&p, 2500, &chunk(1500)).expect("صمتٌ مطيع");
            agg.finish();
            assert_eq!(agg.snapshot().units.len(), 1, "لا وحدات بعد الانحدار");
        }
        assert_eq!(enc.calls, vec![(1, UNIT)], "المُرمِّز لم يُنادَ بعد الفشل");
    }

    /// الأولوية القادمة تعالج المقاطع بترتيبٍ حرّ — والمراسي من الشبكة
    /// المطلقة لا من مجرى الوصول: وحدات المقطع 2 تُرمَّز بمراسيها قبل
    /// وحدات المقطع 1 وتبقى أرقامها الصحيحة.
    #[test]
    fn out_of_order_segments_still_produce_grid_indexed_units() {
        let mut enc = FakeEncoder::new();
        {
            let mut agg = UnitAggregator::new(UNIT, &mut enc);
            agg.push(&plan(1, 3 * UNIT, 6 * UNIT), 0, &chunk(3 * UNIT))
                .expect("المقطع 2 أولاً (أولوية)");
            agg.push(&plan(0, 0, 3 * UNIT), 0, &chunk(3 * UNIT))
                .expect("المقطع 1 ثانياً");
        }
        let ks: Vec<usize> = enc.calls.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            ks,
            vec![4, 5, 6, 1, 2, 3],
            "مراسي الشبكة المطلقة باستقلالٍ تامّ عن ترتيب الوصول"
        );
    }

    /// خرقُ هندسة الإصدار (شريحة خارج نطاق المقطع) خطأُ مُرسِل يُعلَن
    /// عالياً — **ليس** انحدارَ كتابة (فشل الترميز وحده يُنحدر).
    #[test]
    fn an_out_of_range_slice_is_a_sender_error_not_a_degradation() {
        let mut enc = FakeEncoder::new();
        let mut agg = UnitAggregator::new(UNIT, &mut enc);
        let p = plan(0, 0, 2 * UNIT);
        let err = agg.push(&p, 1500, &chunk(600)).unwrap_err();
        assert!(matches!(err, SepError::InvalidInput(_)), "الخطأ من نوع المُرسِل: {err:?}");
        assert!(
            agg.snapshot().degraded.is_none(),
            "خرق الهندسة ليس فشل كتابة: {:?}",
            agg.snapshot().degraded
        );
    }
}
