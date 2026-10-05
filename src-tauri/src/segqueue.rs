//! طابور مقاطع الصفحة بأولوية قابلة للتغيير (الدفعة ب · ميزة المعالجة التدريجية).
//!
//! **العلّة**: المشاهد الذي يقفز إلى منتصف ملف طويل ينتظر معالجة كل ما قبله
//! (السبب الجذري المقيس: لا يُخدَم بايت واحد قبل اكتمال المعالجة كاملة —
//! `serve_page_audio_slice` كان يرفض حتى وجود الملف). الترتيب الافتراضي
//! تصاعدي من البداية، وعند طلب أولوية من الموضع الحالي تُقدَّم المقاطع من
//! هناك نحو الأمام **ثم** تعود المقاطع المتخطّاة (البداية وما قبل الطلب)
//! إلى آخر الطابور — فصاحب الطلب يسمع أولاً، والباقي يُكمل ترتيبه.
//!
//! **وحدّ دلالة الطلب المزدوج**: آخر طلب يفوز — الأولوية تدور على تسلسل
//! المقاطع الأصلي `[1..n]` فتُنتج `[k..n, 1..k-1]` مهما كان الترتيب الحالي.
//!
//! **وحدّ النطاق**: هذه الوحدة **نقية** (ترتيب لا جدولة). مَن يستهلك الترتيب
//! هو مُنتِج المقاطع المجزأ (المرحلة ٤ — **غير مشحونة**: راجع سطر التدقيق)،
//! والتزامن يُدار عنده لا هنا. حجم المقطع **300 ثانية** (قرار المالك، صريح) يُعلَن ويُستهلك حيث يُقاس:
//! ثابت الصفحة/المنتج — لا هنا حيث لا مستهلك لثابت ميت.

/// ترتيب المقاطع `[1..n]` بأولوية قابلة للتغيير. الأرقام **واحدة الأساس**
/// (المقطع الأول = 1) كما يتكلم بها البروتوكول والصفحة.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentQueue {
    order: Vec<usize>,
}

impl SegmentQueue {
    /// ترتيب تصاعدي كامل من 1 إلى `n`. و`n = 0` طابور فارغ صالح.
    pub fn new(n: usize) -> Self {
        Self {
            order: (1..=n).collect(),
        }
    }

    pub fn order(&self) -> &[usize] {
        &self.order
    }

    /// أولوية للمقطع `seg`: يصير ترتيباً `[seg..n, 1..seg-1]`. طلبٌ خارج
    /// `[1..n]` يُتجاهل بصمت (لا حالة ولا خطأ) — الصفحة قد تحسب مقطعاً من
    /// مدة تقديرية تغيّرت. آخر طلب يفوز (الدوران على التسلسل الأصلي).
    pub fn prioritize_from(&mut self, seg: usize) {
        let n = self.order.len();
        if seg == 0 || seg > n || seg == 1 {
            return; // بلا معنى: البداية هي الترتيب الافتراضي نفسه
        }
        let mut out = Vec::with_capacity(n);
        out.extend(seg..=n);
        out.extend(1..seg);
        self.order = out;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_is_ascending_from_one() {
        let q = SegmentQueue::new(6);
        assert_eq!(q.order(), &[1, 2, 3, 4, 5, 6]);
        assert_eq!(q.order().len(), 6);
    }

    #[test]
    fn empty_queue_is_valid() {
        let mut q = SegmentQueue::new(0);
        q.prioritize_from(1); // لا شيء لدورانه — بلا حالة
        assert!(q.order().is_empty());
    }

    /// **شرط قبول المرحلة ٣ حرفياً**: طابور `[1..6]`، أولوية على 4 ⇒ `4,5,6,1,2,3`.
    #[test]
    fn priority_at_four_puts_four_first_then_the_skipped_tail() {
        let mut q = SegmentQueue::new(6);
        q.prioritize_from(4);
        assert_eq!(q.order(), &[4, 5, 6, 1, 2, 3]);
    }

    /// ومحاكاة رفض الضغط ⇒ يبقى `1..6` (شرط القبول الثاني حرفياً).
    #[test]
    fn without_a_request_the_natural_order_stays() {
        let mut q = SegmentQueue::new(6);
        q.prioritize_from(1); // طلب «من البداية» = لا انحراف عن الافتراضي
        assert_eq!(q.order(), &[1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn out_of_range_requests_are_ignored_silently() {
        let mut q = SegmentQueue::new(6);
        q.prioritize_from(0);
        q.prioritize_from(7);
        q.prioritize_from(usize::MAX);
        assert_eq!(q.order(), &[1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn priority_at_the_last_segment_rotates_completely() {
        let mut q = SegmentQueue::new(6);
        q.prioritize_from(6);
        assert_eq!(q.order(), &[6, 1, 2, 3, 4, 5]);
    }

    /// آخر طلب يفوز: الدوران دائماً على التسلسل الأصلي `[1..n]`.
    #[test]
    fn the_latest_request_wins_over_an_earlier_one() {
        let mut q = SegmentQueue::new(6);
        q.prioritize_from(4);
        assert_eq!(q.order(), &[4, 5, 6, 1, 2, 3]);
        q.prioritize_from(2);
        assert_eq!(q.order(), &[2, 3, 4, 5, 6, 1]);
    }

    #[test]
    fn single_segment_queue_never_moves() {
        let mut q = SegmentQueue::new(1);
        q.prioritize_from(1);
        assert_eq!(q.order(), &[1]);
    }
}
