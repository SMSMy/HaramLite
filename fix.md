اً). وجدت 3 أخطاء حقيقية، مرتبة حسب الخطورة:

## 1. باگ أمني : آلية تحديث yt-dlp تكسر نفسها بنفسها
**الملف:** `src-tauri/src/yt_dlp.rs`، دالة `ensure_updated` (~سطر 298-337) + `download_verified` (~سطر 241-243)

التوثيق في أعلى الملف يصف تسلسلاً آمناً: تنزيل → تحقق SHA-256 → إعادة تسمية إلى `.new` → نسخ احتياطي للنسخة الحالية → تبديل ذري → فحص → استرجاع عند الفشل. لكن الكود الفعلي لا يطابق هذا:

- `download_verified` تنزّل الملف المتحقَّق منه وتعيد تسميته **مباشرة إلى `dest`** (وهو نفسه `target`، مسار yt-dlp.exe النشط)، وليس إلى ملف `.new` منفصل — سطر 242: `std::fs::rename(&tmp, dest)`.
- بعدها فقط (سطر 306) يُستدعى `resolve_ytdlp()` لتحديد `active`، ثم يُنسخ `active_path` إلى `backup`.

المشكلة: في أي تحديث ثانٍ وما بعده، `resolve_ytdlp()` سيجد نفس المسار `target` (لأنه ضمن أولوياته)، وهو **الملف الجديد الذي تم استبداله للتو**. فالنسخة الاحتياطية تلتقط النسخة الجديدة لا القديمة. فإذا فشل فحص `--version` بعد التثبيت، خطوة "الاسترجاع" (سطر 327-330) تنسخ الملف الجديد فوق نفسه — لا استرجاع فعلي يحدث. هذا بالضبط صنف الخطأ (BUG-02) الذي يدّعي الكود أنه يحلّه "by construction".

**اتجاه الإصلاح:** يجب تنزيل الملف إلى `target.with_extension("new")`، ثم أخذ النسخة الاحتياطية من `target` الحالي *قبل* أي كتابة عليه، ثم التبديل، ثم الفحص.

## 2. باگ منطقي: `--inst-only` في CLI لا يعمل إطلاقاً
**الملف:** `src-tauri/src/cli.rs`، سطر 200

```rust
match pipeline::process_file(path, &out_dir, o.mode, kind, o.keep_both, false, &|p| {
```

المعامل الخامس (`keep_instrumental`) هو `o.keep_both` فقط — لا يأخذ `o.keep_inst_only` بعين الاعتبار رغم أن التوثيق في أعلى الملف (سطر 4) وشاشة المساعدة (سطر 46: "حفظ الموسيقى فقط") يعرّفان `--inst-only` كخيار مستقل.

الأثر: عند تشغيل `haramlite song.mp3 --inst-only` (بدون `--both`)، فإن `keep_instrumental = false`، فتحذف `pipeline::process_file` ملف الموسيقى (`stems.instrumental`) فعلياً من القرص (انظر `pipeline.rs` سطر 139-144)، وتُرجع `None`. لاحقاً في `cli.rs` سطر 210-217، الشرط `if !o.keep_inst_only` يمنع طباعة مسار الصوت، والشرط `if let Some(inst) = &out.instrumental` لا يُنفَّذ لأنه `None`. النتيجة: لا شيء يُطبع للمستخدم، والملف الوحيد المُنتَج فعلياً هو ملف الصوت (voice) غير المطلوب، بينما الموسيقى المطلوبة محذوفة.

**اتجاه الإصلاح:** السطر يجب أن يكون `o.keep_both || o.keep_inst_only`.

## 3. باگ برمجي: اختبار لا يُصرَّف (compile error)
**الملف:** `src-tauri/src/separator.rs`، سطر 445

```rust
let stems = separate(&wav_path, &out_dir, &|p| { ... }).expect("separation failed");
```

توقيع الدالة الفعلي (سطر 373-378):
```rust
pub fn separate(input_wav: &Path, out_dir: &Path, use_cuda: bool, progress: &dyn Fn(f32) -> bool) -> ...
```

الاستدعاء في الاختبار يمرّر 3 معاملات فقط وينقصه `use_cuda: bool`، كما أن الـ closure يعيد `()` بدل `bool`. هذا خطأ تصريف كامل — يعني أن `cargo test` (أو أي CI يشغّل الاختبارات) سيفشل فوراً لأي تعديل على الملف، وأن حزمة الاختبارات هذه معطوبة أصلاً منذ إضافة معامل `use_cuda` لدعم GPU من دون تحديث موقع الاستدعاء المقابل.

## ملاحظة ثانوية (أداء/جودة، ليست خطأ توقف)
`pipeline.rs` سطر 179-180: حتى عندما لا يُحذف أي صمت فعلياً في وضع "أغنية"، تُعيد `compute_kept_ranges` نطاقاً واحداً يغطي الملف كله `(0, n)` بدل قائمة فارغة. هذا يجعل `export_video_with_cuts` يسلك دوماً مسار إعادة الترميز الكامل (`libx264 crf18`) بدل مسار الـ remux السريع بلا فقدان جودة، حتى لو لم يُقصّ أي شيء فعلياً من الفيديو.


عند التجربة على جهاز اخر يظهر لي وهي نفس المشكلة التي حاولنا اصلاحها 
الجهاز مع ان c++ مضمن 

الاول 
The code execution cannot proceed because VCRUNTIME140_1.dll was not found. Reinstalling the program may fix this problem.
الثاني 
The code execution cannot proceed because MSVCP140_1.dll was not found. Reinstalling the program may fix this problem.


بصفتك المطور، هذه خطوات عملية مرتبة حسب الأولوية — الأولى تؤكّد التشخيص فعلياً بدل الاعتماد على افتراضي، والباقي إصلاح جذري:

## 0. تأكيد التشخيص قبل تعديل أي كود (5 دقائق)
لا تفترض — تحقق. على أي جهاز فيه المشكلة، افتح `Dependencies.exe` (بديل حديث مفتوح المصدر لـ Dependency Walker: `github.com/lucasg/Dependencies`) وافحص `onnxruntime.dll` الموجود فعلياً داخل مجلد التثبيت (`$INSTDIR`). هذا سيخبرك بالضبط أي DLL يطلب `VCRUNTIME140_1.dll`/`MSVCP140_1.dll` — الاحتمال الأقوى هو `onnxruntime.dll` نفسه (مبني بأدوات MSVC حديثة)، لكن تأكيدها يوفر عليك وقتاً لو كان السبب شيئاً آخر مثل توافق DirectML.

## 1. أصلح منطق `hooks.nsh` — لا تحاول عدّ الإصدارات، شغّله دائماً
فحص `Installed == 1` عيب بنيوي لأنه لا يميّز بين إصدار قديم وحديث. الحل الأبسط والأكثر موثوقية هو التخلي عن الفحص الشرطي تماماً — مثبّت مايكروسوفت نفسه idempotent (يتحقق من الإصدار داخلياً ويخرج بسرعة إن كان محدّثاً):

```nsis
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing Microsoft Visual C++ Redistributable..."
  ExecWait '"$INSTDIR\vc_redist.x64.exe" /install /quiet /norestart' $0
  DetailPrint "vc_redist exit code: $0"
  ; 0 = نجاح | 3010 = نجاح لكن يحتاج إعادة تشغيل | 1638 = نسخة أحدث مثبّتة أصلاً (نجاح فعلياً)
  ${If} $0 != 0
  ${AndIf} $0 != 3010
  ${AndIf} $0 != 1638
    DetailPrint "تحذير: فشل تثبيت VC++ Redistributable (كود $0)"
  ${EndIf}
!macroend
```
لاحظ أني نقلته من `PREINSTALL` إلى `POSTINSTALL` — والسبب في البند التالي.

## 2. لا تعتمد على مسار نسبي هش لملف `vc_redist.x64.exe` — اجعله resource رسمي
المسار `..\..\..\..\vc_redist.x64.exe` يعتمد على بنية مجلدات tauri-bundler الداخلية المؤقتة، وهي عرضة للتغيّر بين إصدارات الأداة، وملف الـ exe نفسه غير متتبَّع في المستودع (تماماً مثل `bin/` و`models/`). أدرجه كـ resource رسمي بنفس الطريقة:

في `tauri.conf.json`:
```json
"resources": {
  "../bin": "bin",
  "../models": "models",
  "../vendor/vc_redist.x64.exe": "vc_redist.x64.exe"
}
```
وثّق في README (بجانب فقرة "الملفات المستثناة" الموجودة أصلاً لـ bin/models) أن `vendor/vc_redist.x64.exe` يجب توفيره يدوياً — أو الأفضل: أضف سكربت جلب تلقائي (PowerShell) يُشغَّل قبل `pnpm tauri build` يُنزّله من `https://aka.ms/vs/17/release/vc_redist.x64.exe` إذا لم يكن موجوداً، حتى لا يعتمد البناء على نسخة يدوية قد تكون قديمة عند مطور آخر.

بهذا الترتيب، بحلول `POSTINSTALL`، يكون tauri-bundler قد نسخ `vc_redist.x64.exe` فعلياً إلى `$INSTDIR` ضمن خطوة نسخ الـ resources العادية، فيصبح استدعاء `$INSTDIR\vc_redist.x64.exe` في الهوك مضموناً وليس مبنياً على تخمين بنية مجلدات مؤقتة.

## 3. تحقق أن `onnxruntime.dll` (و`DirectML.dll` إن لزم) تُشحن فعلياً داخل حزمة NSIS
هذه أهم نقطة غير مؤكدة عندي — لم أتحقق منها في الكود، وأنصحك أن تتحقق أنت مباشرة بدل افتراض أن tauri-bundler يلتقطها تلقائياً:
- شغّل `cargo build --release` وافحص `src-tauri/target/release/` — بحث عن أي `*.dll` (crate الـ `ort` بميزة `copy-dylibs` الافتراضية عادة ينسخ `onnxruntime.dll` بجانب الـ exe في هذا المجلد).
- بعد `pnpm tauri build`، ثبّت الحزمة الناتجة على جهاز نظيف وافحص `$INSTDIR` — هل نفس ملفات الـ DLL موجودة؟
- إن لم تكن موجودة، أضفها صراحة في `resources` بنفس أسلوب البند 2 بدل الاعتماد على أي التقاط ضمني من tauri-bundler.

## 4. دفاع إضافي (اختياري، لا يحل المشكلة الأساسية لكنه يقلل السطح)
اربط CRT الخاص بملف `haramlite.exe` نفسه بشكل ثابت (لا يؤثر على `onnxruntime.dll` لأنه ثنائي جاهز مُصرَّف مسبقاً، لكنه يزيل اعتمادية الـ exe نفسه على النظام):

في `.cargo/config.toml` داخل `src-tauri`:
```toml
[target.x86_64-pc-windows-msvc]
rustflags = ["-C", "target-feature=+crt-static"]
```
هذا يقلل نقاط الفشل لكنه **لن** يحل مشكلة `onnxruntime.dll` لأنها مكتبة ثنائية خارجية لا يمكن إعادة ربطها من المصدر.

## الخلاصة العملية
البند 1+2 يحلّان المشكلة فعلياً لأي تنصيب جديد. البند 3 هو التحقق الحاسم الذي يحدد إن كان هناك سبب إضافي (DLL غير مشحون أصلاً) غير علاقته بـ VC++ Redistributable. ابدأ بالبند 0 لتأكيد أن السبب هو فعلاً `onnxruntime.dll` قبل إعادة بناء الحزمة بالكامل — توفر عليك دورة بناء كاملة إذا كان التشخيص خاطئاً.