//! **مسبار المرحلة ٢** — عقد `last` (ب٢) ووصل خريطة صوت الصفحة بملفها (ب٣-وصل).
//!
//! **هذا الملف غير موصول بـ`lib.rs` عمداً.** سببه مقيس: نصفه يعتمد أسماءً لا وجود
//! لها في `main` (`PipelineOutput.page_kept` مثلاً)، ووصله الآن **يُسقط بناء كل
//! أهداف الاختبار** — أي يصير غيابُ حقلٍ واحد سبباً في إخفاء بقية الحارس كله.
//! فالغياب هنا يُقاس **بنصّ المترجم** عند الوصل، لا بتنجيح صامت.
//!
//! **الوصل في المرحلة ٢** (سطر واحد في `src-tauri/src/lib.rs`):
//! ```ignore
//! #[cfg(test)] mod m6b_clip_guard_frozen;
//! ```
//! ثم يُبنى بـ`cargo test --lib --no-run` ويُسجَّل المخرج **حرفياً**:
//!   · بناء ناجح ⇒ الحقول/الدوال موجودة ⇒ تُقاس القيم أدناه
//!   · فشل بناء ⇒ **غائب**، بصيغة متوقَّعة مثل:
//!     `error[E0560]: struct `PipelineOutput` has no field named `page_kept``
//!
//! **ما يُقاس هنا بعد التثبيت** (‏الأسماء تُقرأ من الالتزام المجمَّد لا تُخمَّن):
//! ① `page_kept` حقل **مستقل** في عقد clip، و`kept_ranges` تبقى فارغة له (ب٥).
//! ② خريطة صوت الصفحة تصف **ملف صوت الصفحة** بطوله: `Σ(page_kept) ≈ مدة الملف المقصوص` (ب٣).
//! ③ `last` يحمل `mode` ويميّز أغنيةً عن clip (ب٢) — ببانٍ نقيّ إن وُجد، وإلا فحص
//!    مفتاح/قيمة (وهو فحص تمثيل: يُصرَّح بضعفه في التقرير لأنه يُخترق بمرادفة).
//! ④ مُفسَدات المرحلة ٢ على **نسخة مؤقّتة** من شجرة العامل (لا على شيفرته):
//!    قلب تراكم الخريطة · حذف `mode` من `last` · تمرير خريطة clip إلى `kept_ranges`
//!    · قصّ ملف المستخدم — وكل مُفسَد يجب أن يُسقط الحارس المقابل.

use crate::pipeline::PipelineOutput;

/// ① **حضور الحقل في العقد**: البناء الحرفي يجعل غياب `page_kept` **خطأ بناء**
/// (أي «غائب» صريحاً) لا نجاحاً صامتاً. تُثبَّت أنواع الحقول من الالتزام المجمَّد:
/// احتمالان مقيسان محتملان — `Vec<(f64,f64)>` بالثواني (كتوقيع `kept_ranges`)
/// أو `Vec<(usize,usize)>` بالعيّنات (كتوقيع `silence::compute_kept_ranges`).
#[test]
fn the_clip_contract_carries_page_kept_and_keeps_kept_ranges_empty() {
    let clip = PipelineOutput {
        vocals: None,
        instrumental: None,
        video: None,
        kept_ranges: Vec::new(),
        // TODO(freeze): ثبّت الاسم والنوع من الالتزام المجمَّد ثم أبقِ السطر.
        page_kept: vec![(0.0, 3.0)],
        seconds: 1.0,
    };
    assert!(
        clip.kept_ranges.is_empty(),
        "ب٥: مسار clip لا يملأ kept_ranges (الفخّ الدلالي)"
    );
    assert!(
        !clip.page_kept.is_empty(),
        "ب٣: مسار clip يملأ الحقل المستقل page_kept"
    );
}

/// ③ **عقد `last`**: إن كان الباني نقيّاً في الالتزام المجمَّد (‏`fn … (mode: Mode, …) -> serde_json::Value`)
/// فهذا موضعه: تُقاس **القيمة** لا النصّ. وإن لم يكن، يُسجَّل «غير مقيس بلا واجهة»
/// ولا يُستبدل بفحص نصّي يُسمّى قياساً.
#[test]
fn the_last_contract_distinguishes_song_from_clip() {
    // TODO(freeze): اربط باني العقد الحقيقي هنا. الشكل المتوقَّع للقياس:
    //   let song = last_contract(Mode::Song, &out_song, …);
    //   let clip = last_contract(Mode::Clip, &out_clip, …);
    //   assert_eq!(song["mode"], "song");
    //   assert_eq!(clip["mode"], "clip");
    //   assert!(clip["kept"].as_array().unwrap().is_empty(), "ب٥");
    //   assert!(!clip["page_kept"].as_array().unwrap().is_empty(), "ب٣");
    // والمُفسَد المسمّى: حذف `mode` ⇒ هذا الاختبار يسقط (لا مجرد اختلاف تنسيق).
    unimplemented!("يُوصَل في المرحلة ٢ على الالتزام المجمَّد");
}
