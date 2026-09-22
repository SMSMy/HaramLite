//! **حارس تفنيد م٦-ب — مسار `clip`** (الادّعاءات ب١…ب٥) · **مرحلة ١: من نصّ المتطلَّب وحده**.
//!
//! **المصدر**: `ARCHIVE/0.2.9PLAN.md` §٩-ب · و`ARCHIVE/m6b-brief.md` §٢ (الفخّ الدلالي)
//! و§٣ (التصميم) و§٥ (جدول الاختبارات). كُتب هذا الملف **قبل قراءة شيفرة العامل وقبل
//! اختباراته**، وتوقّعاته مبنيّة على نصّ المتطلَّب لا على التنفيذ.
//!
//! **فلسفة الحارس**: لا يسأل «هل يمرّ اختبار العامل؟» بل «هل يصحّ القانون على **القيم**؟»
//! فكل اختبار هنا يقيس رقماً أو طولاً أو تسلسل عيّنات — لا نصّاً ولا تعليقاً.
//!
//! | الادّعاء | ما يقيسه هذا الحارس | دالّة القياس |
//! |---|---|---|
//! | ب١ تكافؤ الهوية | خريطة `[(0,n)]` تترك العيّنات **بتّاً** كما هي، تماماً كخريطة فارغة · ونموذج حساب `acc` يرفض القلب | `a_full_range_map…` · `the_identity_arithmetic…` |
//! | ب٣ الخريطة تطابق ملفها | `Σ(b−a)` **بالضبط** = طول الملف الذي قصّته الخريطة · ومسار الأغنية (الذي ينشر خريطته) يطابق ملفه · وخريطة ملف آخر **تُرفض** | `the_kept_map_sums…` · `the_song_map…` · `a_map_from_another_file…` |
//! | ب٤ ملف المستخدم كامل الطول | تشغيل حقيقي لوضع `clip` على مقطع sparse: طول ناتج المستخدم = طول المدخل (صوتاً وفيديو) | `clip_run_keeps…` · `clip_video_run_keeps…` |
//! | ب٥ لا تُمرَّر خريطة clip إلى `kept_ranges` | `kept_ranges` فارغة في تشغيل clip حقيقي · والفخّ بالأرقام: خريطة صوت الصفحة لا تصف ملف المستخدم غير المقصوص | `clip_run_keeps…` · `the_page_map_published…` |
//!
//! **وما لا يقيسه (مصرَّحاً به لا مسكوتاً عنه)**: عقد `last` في الجسر (`mode` · `page_kept`)
//! لأن الجسر يبنيه **inline** داخل مهمّة كاملة (تنزيل + ffmpeg + محرّك) وليست له واجهة
//! نقيّة تُقاس — انظر `m6b_clip_guard_frozen.rs` و`M6B_UNMEASURED` أسفل الملف. وحرّاس
//! الإضافة (‏`mapFullToCut` في `content.js`) خارج نطاق هذا الملف: تُقاس في حارس الإضافة.

use crate::effects::{enhance_song, SongEffectsConfig};
use crate::silence::{compute_kept_ranges, cut_silence_with_ranges, SilenceConfig};

/// معدّل العيّنات في كل مسار الإنتاج.
const SR: u32 = 44_100;

// ───────────────────────────── موادّ حتمية (بلا شبكة ولا صوت حقيقي) ─────────────

/// دفعة «كلام»: ضجيج عريض حتمي (هاش حسابي) — حتميّ بالكامل، وبلا نغميّة، فلا
/// تجتاز بوّابة «الموسيقى المستمرّة» فيُسلك مسار detect-then-mute بلا محرّك ONNX.
fn burst(secs: f32, amp: f32) -> Vec<f32> {
    let n = (SR as f32 * secs) as usize;
    (0..n)
        .map(|i| {
            let x = (i as f32 * 12.9898).sin() * 43758.545;
            (x - x.floor()) * 2.0 * amp - amp
        })
        .collect()
}

fn quiet(secs: f32) -> Vec<f32> {
    vec![0.0f32; (SR as f32 * secs) as usize]
}

/// مقطع «متحدّث»: دفعات ضجيج بطول `burst_secs` تفصلها صمتات بطول `quiet_secs`.
fn sparse_clip_pattern(secs: f32, burst_secs: f32, quiet_secs: f32) -> (Vec<f32>, Vec<f32>) {
    let mut l: Vec<f32> = Vec::new();
    let target = (SR as f32 * secs) as usize;
    while l.len() < target {
        l.extend(burst(burst_secs, 0.4));
        l.extend(quiet(quiet_secs));
    }
    l.truncate(target);
    (l.clone(), l)
}

/// المقطع المعتاد: دفعة ١٫٢ث وصمت ٢ث.
fn sparse_clip(secs: f32) -> (Vec<f32>, Vec<f32>) {
    sparse_clip_pattern(secs, 1.2, 2.0)
}

fn kept_sum(kept: &[(usize, usize)]) -> usize {
    kept.iter().map(|(a, b)| b.saturating_sub(*a)).sum()
}

/// يطبّق خريطةً على نسخة من المقطع ويعيد القناة اليسرى المقصوصة.
fn cut_copy(l: &[f32], r: &[f32], kept: &[(usize, usize)]) -> Vec<f32> {
    let (mut cl, mut cr) = (l.to_vec(), r.to_vec());
    cut_silence_with_ranges(&mut cl, &mut cr, SR, &SilenceConfig::default(), kept);
    cl
}

// ───────────────────────────── القوانين (تُطبَّق على الوحدة الحقيقية) ────────────

/// **القانون ①**: مجموع الخريطة (بالعيّنات) = طول الملف الذي قصّته **بالضبط**.
/// (نصّ المتطلَّب: «الخريطة تطابق ملفها: `keptSum` ≈ مدة الصوت المقصوص».)
fn law_map_sums_to_the_file_it_cut(kept: &[(usize, usize)], cut_len: usize) -> Result<(), String> {
    let sum = kept_sum(kept);
    if sum == cut_len {
        return Ok(());
    }
    Err(format!(
        "خريطة لا تصف ملفها: Σ(b−a)={sum} عيّنة وطول الملف المقصوص={cut_len} (فرق {} عيّنة)",
        cut_len as i64 - sum as i64
    ))
}

/// **القانون ②**: الخريطة **المنشورة** لملفٍ ما يجب أن يطابق مجموعُها طولَ ذلك الملف.
/// خريطة فارغة = «لا قصّ» ⇒ تصف ملفاً كامل الطول (ب١). وأي خريطة أخرى يجب أن يساوي
/// مجموعها طول الملف المنشور، وإلا فهي خريطة ملفٍ آخر (ب٣) أو خريطة مسارٍ آخر (ب٥).
fn law_published_map_matches_file(map_secs: &[(f64, f64)], file_secs: f64) -> Result<(), String> {
    if map_secs.is_empty() {
        return Ok(());
    }
    let sum: f64 = map_secs.iter().map(|(a, b)| b - a).sum();
    let tol = 2.0 / SR as f64;
    if (sum - file_secs).abs() <= tol {
        return Ok(());
    }
    Err(format!(
        "الخريطة المنشورة لا تصف الملف: Σ(kept)={sum:.4}s وطول الملف={file_secs:.4}s (فرق {:.4}s)",
        sum - file_secs
    ))
}

/// «‏`!(b > a)`» — نفس دلالة النصّ الأصلي (‏NaN ليست أكبر ⇒ تُتخطّى)، بصيغة
/// لا تُغضب clippy (‏`clippy::neg_cmp_op_on_partial_ord`) فتبقى بوّابة `rust:gates` سليمة.
fn not_greater(b: f64, a: f64) -> bool {
    !matches!(b.partial_cmp(&a), Some(std::cmp::Ordering::Greater))
}

/// **نموذج حساب** لدالة المشغّل التي تربط الزمن بالخريطة (`mapFullToCut` في `content.js`:
/// «Full-timeline seconds → cut-timeline seconds through kept ranges») — مكتوب هنا من
/// نصّ المتطلَّب (ب١) لا منقولاً من ملف الإضافة، و`flip` هو مُفسَد «قلب `acc`».
fn map_full_to_cut(t: f64, kept: Option<&[(f64, f64)]>, flip: bool) -> f64 {
    let Some(kept) = kept else {
        return t; // بلا خريطة ⇒ هوية
    };
    if kept.is_empty() {
        return t; // خريطة فارغة ⇒ هوية
    }
    let mut acc = 0.0f64;
    for (a, b) in kept {
        if not_greater(*b, *a) {
            continue;
        }
        if t <= *a {
            break;
        }
        let add = t.min(*b) - a;
        if flip {
            acc -= add;
        } else {
            acc += add;
        }
    }
    acc
}

/// «هل الموضع داخل فجوة مكتومة؟» — بلا خريطة: لا (نصّ المتطلَّب: الخريطة مسطّحة داخل الفجوة).
fn is_gap_model(t: f64, kept: Option<&[(f64, f64)]>) -> bool {
    let Some(kept) = kept else {
        return false;
    };
    if kept.is_empty() {
        return false;
    }
    for (a, b) in kept {
        if not_greater(*b, *a) {
            continue;
        }
        if t >= *a && t < *b {
            return false;
        }
    }
    true
}

// ───────────────────────────── ب١ — تكافؤ الهوية ────────────────────────────────

/// **ب١ (نصف Rust)**: خريطة تغطّي الملف كلّه `[(0,n)]` تكافئ «بلا خريطة» **بتّاً**:
/// لا طول يتغيّر ولا عيّنة واحدة تُمسّ، ونسبة المُزال صفر.
/// والمُفسَد: أي قلب في تراكم الخريطة يجعل القصّ يبتلع عيّنات ⇒ يسقط.
#[test]
fn a_full_range_map_is_bit_identical_to_no_map_on_the_cut_engine() {
    let (l0, r0) = sparse_clip(9.0);
    let cfg = SilenceConfig::default();
    let n = l0.len().min(r0.len());

    let (mut l_none, mut r_none) = (l0.clone(), r0.clone());
    let removed_none = cut_silence_with_ranges(&mut l_none, &mut r_none, SR, &cfg, &[]);

    let (mut l_full, mut r_full) = (l0.clone(), r0.clone());
    let removed_full = cut_silence_with_ranges(&mut l_full, &mut r_full, SR, &cfg, &[(0, n)]);

    assert_eq!(removed_none, 0.0, "بلا خريطة: لا قصّ");
    assert_eq!(removed_full, 0.0, "خريطة كاملة: لا قصّ (تكافؤ الهوية)");
    assert_eq!(l_full.len(), l0.len(), "الخريطة الكاملة لا تُنقص طولاً");
    assert_eq!(
        l_full, l0,
        "الخريطة الكاملة يجب أن تكون هوية بتّية: عيّنة واحدة تغيّرت"
    );
    assert_eq!(l_full, l_none, "[[0,D]] و«بلا خريطة»: الناتج نفسه");
    println!(
        "M6B-GUARD claim=b1 result=PASS samples={n} removed_none={removed_none} removed_full={removed_full}"
    );
}

/// **ب١ (نموذج الحساب + مُفسَده المسمّى)**: الخريطة الكاملة تعني «الزمن كما هو»
/// على `[0,D]`، وقلب `acc` يخرق ذلك ⇒ القانون يكشفه. (هذا نموذج Rust لقانون
/// الحساب؛ **الأثر JS نفسه** — `mapFullToCut` في `content.js` — يُقاس في حارس
/// الإضافة، وقد قِيس هنا أيضاً بتحميل الدالة الحقيقية في node — انظر التقرير.)
///
/// **وحدّ مقيس (لا يُسكت عنه)**: عند `t = D` **بالضبط** يفترق «خريطة كاملة» عن
/// «بلا خريطة» في دالّة الفجوة: `isGap(D, [[0,D]])` تعدّ الطرف فجوةً (لأن `D`
/// ليست داخل `[0,D)`) بينما «بلا خريطة» لا فجوة فيها. فالتكافؤ المطلق عند الطرف
/// الأخير **كاذب**، وصحّته على `[0,D)` وحدها — وهذا مسجَّل هنا بالقياس.
#[test]
fn the_identity_arithmetic_rejects_a_flipped_accumulator() {
    let d = 9.0f64;
    let full = [(0.0, d)];
    let mut checked = 0usize;
    let mut t = 0.0f64;
    while t < d {
        let with_map = map_full_to_cut(t, Some(&full), false);
        let with_none = map_full_to_cut(t, None, false);
        let with_empty = map_full_to_cut(t, Some(&[]), false);
        assert!(
            (with_map - t).abs() < 1e-9,
            "خريطة [[0,{d}]] ليست هوية عند t={t}: {with_map}"
        );
        assert!((with_none - t).abs() < 1e-9, "بلا خريطة ليست هوية");
        assert!((with_empty - t).abs() < 1e-9, "خريطة فارغة ليست هوية");
        assert!(
            !is_gap_model(t, Some(&full)),
            "الخريطة الكاملة لا فجوة فيها (مسطّحة): t={t}"
        );
        checked += 1;
        t += 0.25;
    }
    // الخريطة نفسها هويةٌ عند الطرف أيضاً (`min(D,D) − 0 = D`).
    assert!(
        (map_full_to_cut(d, Some(&full), false) - d).abs() < 1e-9,
        "الخريطة الكاملة عند الطرف يجب أن تكون هوية"
    );
    // الحدّ المقيس: الفجوة تفترق عن «بلا خريطة» عند الطرف وحده.
    let gap_at_end_with_map = is_gap_model(d, Some(&full));
    let gap_at_end_without = is_gap_model(d, None);
    assert!(
        gap_at_end_with_map && !gap_at_end_without,
        "الحدّ المتوقَّع تغيّر: with_map={gap_at_end_with_map} without={gap_at_end_without}"
    );
    // المُفسَد: قلب `acc` ⇒ الخريطة الكاملة تكفّ عن أن تكون هوية ⇒ يسقط
    let flipped_bad = (0..36)
        .map(|i| i as f64 * 0.25)
        .any(|t| (map_full_to_cut(t, Some(&full), true) - t).abs() >= 1e-9);
    assert!(
        flipped_bad,
        "قلب acc لم يُخرق الهوية ⇒ القانون لا يميّز (حارس بلا أسنان)"
    );
    println!(
        "M6B-GUARD claim=b1-arithmetic result=PASS t_checked={checked} flip_detected={flipped_bad} boundary_t_eq_D: isGap(full)={gap_at_end_with_map} isGap(none)={gap_at_end_without}"
    );
}

// ───────────────────────────── ب٣ — الخريطة تطابق ملفها ─────────────────────────

/// **ب١/ب٣ (المُفسَد الثاني على محرّك الخريطة)**: «قلب» معنى الخريطة — أن تصف
/// **ما قُصّ** بدل **ما بقي** — يجعل مجموعها لا يطابق الملف الذي قصّه المسار
/// الصحيح ⇒ القانون ① يسقط. (وهو نظير قلب `acc` في دالّة الزمن: الخريطة تنقلب
/// من «المحفوظ» إلى «المزال».)
///
/// **وحدّ هذا القانون (مقيس ومُعلَن)**: هو قانون **أطوال**، فهو أعمى عن قلب المعنى
/// حين تكون نسبة المحفوظ **٥٠٪ بالضبط** (‏Σ(المحفوظ) = Σ(المزال)). ولذلك يُبنى
/// المقطع هنا بنسبة منحازة (‏≈٣٠٪ محفوظ) ويُصرَّح بالشرط في `assert` — فحارسٌ على
/// الحافة يمرّ على المُفسَد ويُوهم بالقوة.
#[test]
fn a_flipped_map_meaning_fails_the_exact_law() {
    let (l0, r0) = sparse_clip_pattern(9.0, 0.8, 2.6);
    let cfg = SilenceConfig::default();
    let kept = compute_kept_ranges(&l0, &r0, SR, &cfg);
    assert!(!kept.is_empty(), "لا قصّ ⇒ لا شيء يُقاس");
    let n = l0.len();

    // الخريطة المقلوبة: الفجوات (ما أُزيل) بدل المحفوظ.
    let mut removed: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0usize;
    for (a, b) in &kept {
        if *a > cursor {
            removed.push((cursor, *a));
        }
        cursor = (*b).max(cursor);
    }
    if cursor < n {
        removed.push((cursor, n));
    }
    assert!(!removed.is_empty(), "يجب أن يكون في المقطع ما أُزيل");
    assert_ne!(
        kept_sum(&kept),
        kept_sum(&removed),
        "نسبة المحفوظ ٥٠٪ ⇒ قانون الأطوال أعمى عن قلب المعنى: اختر مقطعاً منحازاً"
    );

    let cut_correct = cut_copy(&l0, &r0, &kept);
    law_map_sums_to_the_file_it_cut(&kept, cut_correct.len()).expect("الخريطة الصحيحة تصف ملفها");
    let flipped = law_map_sums_to_the_file_it_cut(&removed, cut_correct.len());
    assert!(
        flipped.is_err(),
        "خريطة مقلوبة المعنى مرّت على القانون ⇒ الحارس أعمى: {flipped:?}"
    );
    println!(
        "M6B-GUARD claim=b1+b3-flipped result=PASS kept_sum={} removed_sum={} cut_len={} verdict={}",
        kept_sum(&kept),
        kept_sum(&removed),
        cut_correct.len(),
        flipped.unwrap_err()
    );
}
/// **ب٣**: على محرّك القصّ الحقيقي — مجموع الخريطة = طول الملف المقصوص بالضبط،
/// وبالثواني كذلك (`keptSum` مقابل مدة الصوت المُسلَّم).
#[test]
fn the_kept_map_sums_exactly_to_the_file_it_cut() {
    let (l0, r0) = sparse_clip(9.0);
    let cfg = SilenceConfig::default();
    let kept = compute_kept_ranges(&l0, &r0, SR, &cfg);
    assert!(
        !kept.is_empty(),
        "المقطع الاصطناعي يجب أن يحمل صمتات تُقصّ، وإلا فلا شيء يُقاس"
    );
    let cut = cut_copy(&l0, &r0, &kept);
    law_map_sums_to_the_file_it_cut(&kept, cut.len()).expect("قانون ب٣ على محرّك القصّ");

    // القانون المنشور: الخريطة بالثواني تصف الملف بالثواني (كما يقرؤه المشغّل).
    let map_secs: Vec<(f64, f64)> = kept
        .iter()
        .map(|(a, b)| (*a as f64 / SR as f64, *b as f64 / SR as f64))
        .collect();
    law_published_map_matches_file(&map_secs, cut.len() as f64 / SR as f64)
        .expect("قانون ب٣ بالثواني");
    println!(
        "M6B-GUARD claim=b3 result=PASS kept_ranges={} keptSum_samples={} cut_len={} keptSum_secs={:.4} cut_secs={:.4}",
        kept.len(),
        kept_sum(&kept),
        cut.len(),
        map_secs.iter().map(|(a, b)| b - a).sum::<f64>(),
        cut.len() as f64 / SR as f64
    );
}

/// **ب٣ (مُفسَده المسمّى)**: خريطة ملفٍ آخر — أو خريطة «بائتة» أُعيد استعمالها —
/// **لا تصف الملف المُسلَّم**، فيجب أن يسقط القانون. والدليل هنا على **الملف
/// المُسلَّم المقيس** (طول العيّنات بعد القصّ) لا على ملفٍ أنتجته الخريطة نفسها:
/// ذاك الأخير يطابق مجموعها دائماً، فلا يميّز شيئاً.
#[test]
fn a_map_from_another_file_is_rejected() {
    let (la, ra) = sparse_clip(9.0);
    let (lb, rb) = sparse_clip(6.0); // ملف آخر: صمتاته في مواضع أخرى
    let cfg = SilenceConfig::default();
    let kept_a = compute_kept_ranges(&la, &ra, SR, &cfg);
    let kept_b = compute_kept_ranges(&lb, &rb, SR, &cfg);
    assert!(
        !kept_a.is_empty() && !kept_b.is_empty(),
        "الملفان يجب أن يحملا قصّاً"
    );
    let to_secs = |kept: &[(usize, usize)]| -> Vec<(f64, f64)> {
        kept.iter()
            .map(|(a, b)| (*a as f64 / SR as f64, *b as f64 / SR as f64))
            .collect()
    };

    // الملف المُسلَّم فعلاً: قُصّ A بخريطتها، وطوله **يُقاس** من العيّنات.
    let delivered_a = cut_copy(&la, &ra, &kept_a);
    let delivered_secs = delivered_a.len() as f64 / SR as f64;

    // خريطته هو على ملفه المُسلَّم ⇒ تمرّ
    law_published_map_matches_file(&to_secs(&kept_a), delivered_secs).expect("خريطة الملف نفسه");

    // (١) خريطة الملف الآخر على ملفنا المُسلَّم ⇒ تسقط
    let foreign = law_published_map_matches_file(&to_secs(&kept_b), delivered_secs);
    assert!(
        foreign.is_err(),
        "خريطة ملف آخر مرّت على القانون ⇒ الحارس أعمى: {foreign:?}"
    );

    // (٢) خريطة «بائتة»: نفس الخريطة أُعيد استعمالها على ملف قُصّ بها سابقاً
    let stale_map = to_secs(&kept_a);
    let twice = cut_copy(&delivered_a, &delivered_a, &kept_a);
    let stale = law_published_map_matches_file(&stale_map, twice.len() as f64 / SR as f64);
    assert!(
        stale.is_err(),
        "خريطة بائتة مرّت على القانون: {stale:?} (طول بعد القصّ مرّتين={} عيّنة)",
        twice.len()
    );
    println!(
        "M6B-GUARD claim=b3-mutant result=PASS foreign={} stale={} delivered_secs={delivered_secs:.4} twice_secs={:.4}",
        foreign.unwrap_err(),
        stale.unwrap_err(),
        twice.len() as f64 / SR as f64
    );
}

/// **ب٣ (على المسار الذي ينشر خريطته فعلاً)**: `enhance_song` هو المسار **الوحيد**
/// الذي يقصّ ملف المستخدم (وضع الأغنية) ويعيد الخريطة المنشورة في `kept_ranges`
/// — فيجب أن تصف خريطته الملف الذي أنتجته هي (وهذا ما يجعله المرجع الذي يُقاس عليه
/// مسار clip: أي خريطة تُنشر هناك لملف لم يُقصّ تكون كاذبة).
#[test]
fn the_song_map_describes_the_file_it_actually_cut() {
    let (mut l, mut r) = sparse_clip(9.0);
    let before = l.len();
    let ranges = enhance_song(&mut l, &mut r, SR, &SongEffectsConfig::default(), &|_| true)
        .expect("سلسلة الأغنية");
    assert!(
        l.len() < before,
        "وضع الأغنية يجب أن يقصّ فعلاً، وإلا فالقانون لا يقيس شيئاً"
    );
    law_published_map_matches_file(&ranges, l.len() as f64 / SR as f64)
        .expect("خريطة الأغنية تصف ملفها");
    assert_eq!(l.len(), r.len(), "القناتان بطول واحد");
    println!(
        "M6B-GUARD claim=b3-song result=PASS ranges={} before={before} after={} sum_secs={:.4} file_secs={:.4}",
        ranges.len(),
        l.len(),
        ranges.iter().map(|(a, b)| b - a).sum::<f64>(),
        l.len() as f64 / SR as f64
    );
}

// ───────────────────────────── ب٥ — الفخّ الدلالي بالأرقام ──────────────────────

/// **ب٥**: خريطة **صوت الصفحة** (وهو مقصوص) لا تصف ملف المستخدم في مسار clip
/// (وهو **غير مقصوص** بطول كامل — ب٤). فنشر الأولى مكان الثانية يجعل الثابت المؤسِّس
/// («الخريطة مسطّحة داخل الفجوة») كاذباً — وهذه هي الأرقام التي تُثبت الكذب.
#[test]
fn the_page_map_published_as_the_deliverable_map_would_be_a_lie() {
    let (pl, pr) = sparse_clip(9.0);
    let cfg = SilenceConfig::default();
    let page_kept = compute_kept_ranges(&pl, &pr, SR, &cfg);
    assert!(!page_kept.is_empty(), "صوت الصفحة يجب أن يُقصّ فعلاً");

    let page_cut_secs = kept_sum(&page_kept) as f64 / SR as f64;
    let full_secs = pl.len() as f64 / SR as f64;
    assert!(
        page_cut_secs < full_secs - 0.5,
        "القصّ يجب أن يكون حقيقياً: {page_cut_secs:.4}s من {full_secs:.4}s"
    );

    let page_map_secs: Vec<(f64, f64)> = page_kept
        .iter()
        .map(|(a, b)| (*a as f64 / SR as f64, *b as f64 / SR as f64))
        .collect();

    // (أ) ملف المستخدم في مسار clip: غير مقصوص ⇒ طوله كامل، وخريطته المنشورة فارغة.
    law_published_map_matches_file(&[], full_secs).expect("بلا خريطة: تصف ملفاً كامل الطول");
    law_published_map_matches_file(&[(0.0, full_secs)], full_secs)
        .expect("الخريطة الكاملة تصف ملفاً كامل الطول (تكافؤ الهوية)");

    // (ب) تمرير خريطة صوت الصفحة ⇒ القانون يسقط (وهذا هو المُفسَد ب٥ بالأرقام).
    let trap = law_published_map_matches_file(&page_map_secs, full_secs);
    assert!(
        trap.is_err(),
        "خريطة صوت الصفحة مرّت على ملف المستخدم ⇒ الفخّ غير مكشوف: {trap:?}"
    );
    println!(
        "M6B-GUARD claim=b5 result=PASS page_kept_ranges={} page_cut_secs={page_cut_secs:.4} user_file_secs={full_secs:.4} trap={}",
        page_kept.len(),
        trap.unwrap_err()
    );
}

// ───────────────────────────── ب٤/ب٥ — تشغيل حقيقي لوضع clip ────────────────────

/// أدوات ffmpeg/ffprobe موجودة؟ (الحارس **يُعلن** عدم القياس ولا ينجح صامتاً.)
fn media_tools_available() -> bool {
    crate::media::resolve_tool("ffmpeg").is_ok() && crate::media::resolve_tool("ffprobe").is_ok()
}

fn guard_temp_base(name: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!("hl_m6b_guard_{name}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).expect("مجلد مؤقّت");
    p
}

/// **ب٤ + ب٥ (تشغيل حقيقي، بلا شبكة وبلا محرّك ONNX)**: مقطع **sparse** يسلك مسار
/// detect-then-mute (لا MDX)، فيمرّ المسار كاملاً بـffmpeg وحده:
/// (١) `kept_ranges` فارغة — لا خريطة clip تُمرَّر إلى حقل الأغنية (ب٥)
/// (٢) ناتج المستخدم بطول المدخل بالضبط — لم يُقصّ (ب٤).
#[test]
fn clip_run_keeps_the_deliverable_full_length_and_kept_ranges_empty() {
    if !media_tools_available() {
        println!("M6B-GUARD claim=b4+b5 status=UNMEASURED reason=ffmpeg-or-ffprobe-missing");
        return;
    }
    let _serial = crate::paths::serial_guard();
    let _env_dir = crate::paths::env_restore("HARAMLITE_DATA_DIR");
    let base = guard_temp_base("clip_run");
    std::env::set_var("HARAMLITE_DATA_DIR", base.join("data"));
    let out_dir = base.join("out");
    std::fs::create_dir_all(&out_dir).unwrap();

    // المدخل: مقطع sparse حقيقي على القرص.
    let (l, r) = sparse_clip(9.0);
    let src = base.join("sparse_clip.wav");
    crate::separator::write_wav_stereo_f32_pub(&src, &l, &r, SR).expect("كتابة المدخل");
    // بوّابة الكثافة نفسها التي يقرؤها المسار: يجب أن تكون sparse وإلا لزم محرّك MDX.
    let analysis = crate::separator::analyze_mix(&l, &r, SR);
    assert!(
        !analysis.dense,
        "المقطع الاصطناعي انقلب dense ⇒ المسار يحتاج MDX ولا يُقاس هنا"
    );

    let res = crate::pipeline::process_file(
        &src,
        &out_dir,
        crate::pipeline::Mode::Clip,
        crate::pipeline::OutKind::Audio {
            fmt: crate::pipeline::OutFormat::Wav,
        },
        false,
        true,
        false,
        None,
        &crate::proc::CancelToken::new(),
        &|_| true,
        &|_, _| {},
    );
    let out = res.expect("تشغيل clip على مقطع sparse");

    // (١) ب٥: لا خريطة clip في حقل الأغنية.
    assert!(
        out.kept_ranges.is_empty(),
        "وضع clip ملأ kept_ranges ({} نطاقاً) — الفخّ الدلالي وقع",
        out.kept_ranges.len()
    );
    // (٢) ب٤: ملف المستخدم كامل الطول.
    let vocals = out.vocals.as_ref().expect("ناتج المستخدم موجود");
    let (vl, vr, vsr) = crate::separator::read_wav_stereo(vocals).expect("قراءة الناتج");
    assert_eq!(vsr, SR, "المعدّل يجب أن يبقى 44100");
    assert_eq!(vl.len(), vr.len(), "القناتان متساويتان");
    let delta = vl.len() as i64 - l.len() as i64;
    assert!(
        delta.abs() <= 1,
        "طول ملف المستخدم تغيّر في مسار clip: المدخل={} الناتج={} (فرق {delta} عيّنة)",
        l.len(),
        vl.len()
    );
    println!(
        "M6B-GUARD claim=b4+b5 result=PASS dense={} in_samples={} out_samples={} kept_ranges={} range_secs={:.4}",
        analysis.dense,
        l.len(),
        vl.len(),
        out.kept_ranges.len(),
        vl.len() as f64 / SR as f64
    );
    let _ = std::fs::remove_dir_all(&base);
}

/// **ب٤ (مخرج الفيديو، وهو ما يستلمه المستخدم في طلب clip كامل الحفظ)**: فيديو
/// بطول T يخرج بطول T — لأن مسار clip يمرّر خريطة فارغة إلى `export_video_with_cuts`
/// (‏بلا قصّ). والمُفسَد «تمرير خريطة clip إلى kept_ranges» يقصّ الإطارات ⇒ يسقط.
#[test]
fn clip_video_run_keeps_the_deliverable_full_length() {
    if !media_tools_available() {
        println!("M6B-GUARD claim=b4-video status=UNMEASURED reason=ffmpeg-or-ffprobe-missing");
        return;
    }
    let _serial = crate::paths::serial_guard();
    let _env_dir = crate::paths::env_restore("HARAMLITE_DATA_DIR");
    let base = guard_temp_base("clip_video");
    std::env::set_var("HARAMLITE_DATA_DIR", base.join("data"));
    let out_dir = base.join("out");
    std::fs::create_dir_all(&out_dir).unwrap();

    let (l, r) = sparse_clip(9.0);
    let wav = base.join("sparse_clip.wav");
    crate::separator::write_wav_stereo_f32_pub(&wav, &l, &r, SR).expect("كتابة الصوت");
    let video = base.join("sparse_clip.mp4");
    // فيديو اختبار حتمي: نمط testsrc ثابت + صوتنا. `mpeg4` مدمج في كل بناء ffmpeg
    // (ولا يلزم مرمّز H.264 هنا: مسار «بلا قصّ» ينسخ تدفّق الفيديو كما هو).
    let ffmpeg = crate::media::resolve_tool("ffmpeg").expect("ffmpeg");
    let status = std::process::Command::new(&ffmpeg)
        .args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=160x120:rate=15:duration=9",
            "-i",
            &wav.to_string_lossy(),
            "-c:v",
            "mpeg4",
            "-c:a",
            "aac",
            "-shortest",
            &video.to_string_lossy(),
        ])
        .status()
        .expect("تشغيل ffmpeg لبناء المدخل");
    assert!(status.success(), "بناء فيديو الاختبار فشل");
    let info = crate::media::probe(&video).expect("فحص المدخل");
    assert!(
        info.has_video && !info.video_is_cover_art,
        "المدخل يجب أن يكون فيديو حقيقياً: {info:?}"
    );

    let res = crate::pipeline::process_file(
        &video,
        &out_dir,
        crate::pipeline::Mode::Clip,
        crate::pipeline::OutKind::Video { max_height: None },
        false,
        true,
        false,
        None,
        &crate::proc::CancelToken::new(),
        &|_| true,
        &|_, _| {},
    );
    let out = res.expect("تشغيل clip على فيديو sparse");
    assert!(
        out.kept_ranges.is_empty(),
        "وضع clip ملأ kept_ranges ({} نطاقاً) ⇒ سيقصّ فيديو المستخدم",
        out.kept_ranges.len()
    );
    let produced = out.video.as_ref().expect("مخرج الفيديو موجود");
    let out_info = crate::media::probe(produced).expect("فحص المخرج");
    let delta = (out_info.duration_secs - info.duration_secs).abs();
    assert!(
        delta <= 0.25,
        "طول فيديو المستخدم تغيّر في مسار clip: المدخل={:.3}s المخرج={:.3}s (فرق {delta:.3}s)",
        info.duration_secs,
        out_info.duration_secs
    );
    println!(
        "M6B-GUARD claim=b4-video result=PASS in_secs={:.3} out_secs={:.3} kept_ranges={}",
        info.duration_secs,
        out_info.duration_secs,
        out.kept_ranges.len()
    );
    let _ = std::fs::remove_dir_all(&base);
}

// ───────────────────────────── عقد `clip` — حضور الحقل وقيمته ────────────────────

/// **المرحلة ٢ — مسبار الحضور**: بناء `PipelineOutput` حرفياً مع `page_kept`
/// يجعل **غياب** الحقل خطأَ بناءٍ صريحاً (`error[E0560]: struct PipelineOutput
/// has no field named page_kept` — وهو ما قِيس على `main` قبل الدمج)، لا نجاحاً
/// صامتاً. والقيمة المقيسة هنا: مسار `clip` يحمل خريطته في الحقل **المستقل**
/// و`kept_ranges` تبقى فارغة (ب٥ على مستوى البيانات).
#[test]
fn the_clip_contract_carries_page_kept_and_keeps_kept_ranges_empty() {
    let (l0, r0) = sparse_clip(9.0);
    let page_map = compute_kept_ranges(&l0, &r0, SR, &SilenceConfig::default());
    assert!(!page_map.is_empty(), "خريطة الصفحة يجب أن تحمل قصّاً");
    let map_secs: Vec<(f64, f64)> = page_map
        .iter()
        .map(|(a, b)| (*a as f64 / SR as f64, *b as f64 / SR as f64))
        .collect();

    let clip = crate::pipeline::PipelineOutput {
        vocals: None,
        instrumental: None,
        video: None,
        kept_ranges: Vec::new(),
        page_kept: map_secs.clone(),
        seconds: 1.0,
    };
    assert!(
        clip.kept_ranges.is_empty(),
        "ب٥: مسار clip لا يملأ kept_ranges"
    );
    assert_eq!(
        clip.page_kept, map_secs,
        "ب٣: الحقل المستقل يحمل خريطة الصفحة"
    );
    // والقانون ② على الحقل الجديد: خريطته تصف ملف صوت الصفحة (المقصوص).
    law_published_map_matches_file(&clip.page_kept, kept_sum(&page_map) as f64 / SR as f64)
        .expect("خريطة الصفحة تصف ملفها");
    println!(
        "M6B-GUARD claim=contract result=PASS page_kept_ranges={} kept_ranges={}",
        clip.page_kept.len(),
        clip.kept_ranges.len()
    );
}

// ───────────────────────────── ما لم يُقَس: يُسمّى ولا يُسكت ─────────────────────

/// ادّعاء **لم يُقَس بالتشغيل** — مسمّىً صراحةً: الحارس الذي «ينجح» على ادّعاء لم
/// يُقَس هو النجاح الكاذب نفسه.
const M6B_UNMEASURED: &[(&str, &str)] = &[
    (
        "ب٢-الأثر",
        "«بلا mode يخلط المشغّل خريطة أغنية بخريطة clip»: الحقل **يوجد ويميّز** (مقيس: `last_ok_payload`)، لكن **لا مستهلك له** — الإضافة صفر تغيير في المرحلة ١ (`content.js:1243-1267` يقرأ `last.kept` بلا تمييز) و`src/**` لا يقرأ `mode`/`page_kept` (مقيس بالبحث في الشجرة) ⇒ الخلط **قائم** حتى يُستهلك الحقل: عقدٌ لا علاج",
    ),
];

#[test]
fn unmeasured_claims_are_named_not_silently_green() {
    for (claim, why) in M6B_UNMEASURED {
        println!("M6B-PROBE claim={claim} status=UNMEASURED reason={why}");
    }
    assert_eq!(
        M6B_UNMEASURED.len(),
        1,
        "قائمة غير المقيس تغيّرت ⇒ يجب تحديث التقرير لا إسكات الحارس"
    );
}
