//! م١ — محدِّد فتحات الفصل **عبر العمليات** + سِجلّ المهامّ.
//!
//! ## العطل المقيس الذي يعالجه هذا الملف
//!
//! لم يكن في التطبيق أي محدِّد تنفيذ متزامن، وخمسة مداخل تستدعي
//! `pipeline::process_file` — كلٌّ منها يُحمّل جلسة ORT خاصّة به. ومحدِّد
//! **داخل العملية** لا يكفي: مسار `cli.rs` عملية منفصلة تماماً عن الواجهة،
//! فتتجاوز أي عدّاد في ذاكنة العملية.
//!
//! ## أساس السقف (`MAX_LIMIT = 2`) — قياسات `nvidia-smi` على جهاز واحد
//!
//! **لا رقم واحد هنا بلا قائسه وطريقته**. والقياسات ثلاثة **لتشكيلات مختلفة**
//! (لا تكرار لقياس واحد) — جهاز واحد (RTX 3070 · 8192 MiB) بثلاثة سطور:
//!
//! | القياس | من قاسه · الطريقة | المزوّد | طول المقطع | ذروة فصلين متزامنين | أُعيد إنتاجه؟ |
//! |---|---|---|---|---|---|
//! | خط الأساس (بلا فصل) | المالك · `nvidia-smi` | CUDA | — | 1419 MiB | لا |
//! | فصل واحد | المالك · `nvidia-smi` | CUDA | 180 ث | 3732 MiB | لا (المدقّق: 920 · 2771) |
//! | فصلان معاً | المالك · `nvidia-smi` | CUDA | 180 ث | **6069 MiB** | لا |
//! | فصلان معاً | العامل السابق · `nvidia-smi` | CUDA | **12 ث** | **4734 MiB** | لا |
//! | فصلان معاً | المدقّق · `nvidia-smi` | **DirectML** | 180 ث | **7943 MiB** (هامش **249**) | **نعم** |
//! | فصلان معاً | **مدقّق الجولة الأولى** · `nvidia-smi` | **غير موثَّق في المصدر** | — | **7947 MiB** (هامش **245**) | — |
//!
//! **ولا يُنسب رقم إلى غير قائسه**: صفّ **7947** كان منسوباً في نسخة سابقة إلى
//! «العامل السابق · CUDA» — والتصحيح أنّ قائسه **مدقّق الجولة الأولى** (قياس
//! مستقلّ) و**مزوّده غير موثَّق في المصدر**، فلا يُدَّعى له مزوّد ولا طول مقطع.
//! والعمود «أُعيد إنتاجه؟» باقٍ صادقاً كما هو: **7943** وحده أُعيد إنتاجه (على
//! DirectML)، و**7947 لم يُعَد**.
//!
//! **والقراءة المقيسة أهمّ من الأرقام**: الذروة **تتغيّر بطول المقطع وبالمزوّد**
//! — 4734 عند 12 ثانية مقابل 6069 عند 180 ثانية (كلاهما CUDA)، و7943 على
//! **مزوّد الاحتياط DirectML**. وهذا **ينقض** فرضاً قديماً مكتوباً في
//! `docs/BACKLOG-0.3.md:316` («الأرجح أن الذاكرة لا تتغيّر بطول الملف»).
//! **وحدّ أمانة**: الطول والمزوّد **متداخلان** في هذه القياسات (لم نُجرِ قياساً
//! يعزل أحدهما عن الآخر)، فليس هذا فصلاً نظيفاً لمتغيّر واحد — والثابت وحده أن
//! 12 ث ≠ 180 ث على CUDA.
//!
//! **وأسوأ حالة معروفة** هي **مزوّد الاحتياط (DirectML) على ملف طويل**:
//! **7943 من 8192 MiB — هامش 249** — وهذا وحده يبرّر الافتراضيّ **1** ويُبقي
//! السقف **2** اختياراً واعياً لا افتراضاً مريحاً. وهو أيضاً **أساس `MAX_LIMIT`
//! = 2**: أسوأ ما قيس، والثالث يُنفق هامشاً غير موجود.
//!
//! **وأمانة نسبة**: «3732» و«6069» قياسان سابقان **لم يُعاد إنتاجهما** في هذه
//! الجولة (المدقّق قاس 920 و2771/2726 على DirectML، و6069 لا يظهر في أي قياس
//! لهذه الجولة). والفرق **لا يُخفى**: قياس المالك كان على **CUDA** وعلى صوت
//! **180 ثانية** (‏`BACKLOG-0.3.md:305-309`)، و**مزوّد اليوم DirectML لغياب
//! مكتبات CUDA من `bin/`** — واختلافُ المزوّد وحده كافٍ لتفسير الفرق.
//! (و«1419 + n × 2325 ≈ 8.4 GB» كان **توقّعاً للثلاثة لم يُقَس** — لا قياساً.)
//!
//! **وطول المقطع «12 ثانية» مُثبَت في الشيفرة**: `separator.rs:1420`
//! (`let len = sr as usize * 12;`) في اختبار `cuda_full_separation_smoke`
//! (‏`#[ignore]`، لذلك لا يظهر في سجلات المنتج — وهو سبب إخفاق من نفى وجوده
//! بفحص السجلات وحدها).
//!
//! ## الافتراضيّ **1** والسقف 2 — قرار المالك بعد هذا القياس
//!
//! إعداد `max_concurrent_jobs` افتراضيّه **1** (`DEFAULT_LIMIT` أدناه): هو ما
//! تأخذه نسخة جديدة، أو ملفّ إعدادات لا يحمل الحقل أصلاً. والسقف المسموح يبقى
//! 2 (`MAX_LIMIT`) لمن يطلبه صراحةً من الواجهة: فأسوأ ما قيس للفصلين هامش
//! **245 MiB**، فالاثنان **خيار واعٍ** لا افتراض مريح.
//!
//! ## العطل الثاني المقيس: **الرمز المفقود عند قتل العملية** (وعلاجه)
//!
//! **العطل**: السِّيمافور **لا مالك له**. فإذا قُتلت عملية وهي تحمل رمزاً
//! (`TerminateProcess` · `Ctrl+C` · انهيار) **لا يعود الرمز ما دامت أي عملية
//! أخرى تحمل مقبضاً للكائن** — ومقابض المنتج **مخزَّنة مدى الحياة** في
//! `CACHE`، فالواجهة الدائمة (أو CLI أب) تُبقي الكائن حيّاً. **والقياس**
//! (بمسبارَي المشرف والمدقّق، كلٌّ على حِدة): بعد قتل الحاصر بقي العدّاد
//! ناقصاً — `TIMEOUT` ولا شيء يعمل — ولم يُستعَد إلا بزوال **آخر** مقبض. ومع
//! `DEFAULT_LIMIT = 1` صار كل CLI يحتاج الرمزين ⇒ **كل مهمّة لاحقة تنتظر 30
//! دقيقة ثم تفشل**.
//!
//! **والعلاج**: **زوج mutexات مسمّاة** بدل الزوجين السِّيمافوريين. والفرق
//! الجوهري سطر واحد: **للـmutex مالك** (الخيط الذي اكتسبه).
//!
//! * mutex **غير مملوك = متاح** (`CreateMutexW(NULL, FALSE, …)` ينشئه بلا
//!   مالك)، والاكتساب ملكيّةُ خيط.
//! * ومن مات مالكه بلا تحرير صار **abandoned = متاح**، والمنتظر التالي يأخذه
//!   ويرث الملكيّة — و`WaitForMultipleObjects` تُعلمه بذلك:
//!   **`WAIT_ABANDONED_0` (0x80)** نجاح لا خطأ، ومع `bWaitAll = TRUE` تعني أنه
//!   **ملك الاثنين** فعلاً (قِيس: `ReleaseMutex` للاثنين بعده أعادت `true`).
//! * فـ**الاسترجاع فوري** عند موت المالك — **بلا بروتوكول إضافي**، وبلا أثر
//!   لبقاء مقابض أخرى مفتوحة على الكائن.
//!
//! ## الحلّ — **زوج mutexات مسمّاة** في نواة ويندوز
//!
//! كائن مسمّى في نطاق `Global\` يراه كل عمليات الجلسة، والملكيّة محفوظة في
//! النواة لا في أي عملية. وهذا الملف يستعمل **رمزين** (`<name>-a` و
//! `<name>-b`):
//!
//! * مهمّة بسقف 2 تأخذ **رمزاً واحداً** — أيّهما صار متاحاً
//!   (`WaitForMultipleObjects` بعدّاد 2 و`bWaitAll = FALSE`) ⇒ فتحتان معاً.
//! * مهمّة بسقف 1 تأخذ **الرمزين معاً** (`bWaitAll = TRUE`) ⇒ **حصرية فعلية**.
//!
//! ولماذا زوج لا كائن واحد بعدّاد: كائن واحد كان يجعل «السقف» عدّاداً **متغيّراً**
//! (ويندوز يتجاهل السقف المطلوب إن كان الكائن قائماً، فتكون السعة سعةَ أول من
//! أنشأ) — وبالزوج **لا سعة متغيّرة أصلاً**، فينتفي «السقف سقف أول من أنشأ» من
//! أصله. وحارس RAII (`Drop`) يحرّر **ما أُخذ بالضبط** عند الخروج — حتى مع
//! الخطأ والذعر.
//!
//! **وثلاثة قيود يفرضها الـmutex، وهي مُعالَجة هنا صراحةً**:
//!
//! 1. **الملكيّة للخيط لا للعملية**: التحرير **يجب** أن يقع على الخيط الذي
//!    اكتسب؛ و`ReleaseMutex` من خيط آخر **تفشل** (`ERROR_NOT_OWNER`). ولذلك
//!    الحارس `WinSem` **`!Send` عن قصد** (`PhantomData<*const ()>`) فيستحيل
//!    نقله بين الخيوط **عند التصريف** لا في التعليق.
//! 2. **الاكتساب التراكبي**: لو أخذ الخيط رمزاً ثم طلب اسمه ثانيةً **لمنحه
//!    ويندوز ملكيّة تراكبية فوراً** (ولا يحجب)، وتحرير واحد لا يكفي ⇒ المنتظر
//!    الآخر يعبر **بينما الحاصر يعمل** = **ثغرة صامتة في ب٢**. فسجلّ
//!    `thread_local` لما يحمله هذا الخيط من الأسماء يردّ الطلب بخطأ عربي صريح
//!    بدل المنح الصامت.
//! 3. **الاسترجاع لا يزيل المقبض**: المقبض يبقى ما دام الكائن حيّاً، والملكيّة
//!    وحدها تُرفع بموت المالك. فلا إغلاق مقبض في مسار العمل العادي.
//!
//! ## قيد مقيس: الميزانية **لكل اسم كائن**
//!
//! التحديد كلّه معلَّق على **الاسم** لا على التطبيق: تمرير `HARAMLITE_SLOTS_NAME`
//! باسم آخر (أو تشغيل نسخة باسم مختلف) يفتح **ميزانية ثانية كاملة** — أي
//! فتحتان إضافيتان على البطاقة نفسها. والاسم المتجاوز يكوّن **الرمزين معاً**
//! (`<name>-a` و`<name>-b`) فلا تختلط ميزانيته بغيرها.
//!
//! ## ما لا يفعله هذا الملف (بصراحة)
//!
//! * **~~لا يقتل شجرة العمليات~~ — صار يقتلها (م٢)**: `cancel_job` يضبط رمز
//!   الإلغاء **لكل مهمّة** **ويقتل أبناءها فوراً** (`proc::kill_children`:
//!   مقابض العمليات المسجَّلة، بـ`taskkill /T /F`)، و`proc::enter` في
//!   `run_registered_with` يجعل كل نداء أداة داخل المهمّة يسجّل مقبضه.
//!   والحدّ الباقي **معلَن لا مخفيّ**: نداء ONNX داخل العملية
//!   (`separator::separate`) غير قابل للقطع، فالمهمّة داخله تُهجر عند أول حدّ
//!   بعده وتُعاد بلا ناتج (دلالة على مرحلتين — قرار المالك).
//! * **سقف الكائن لا يُعاد ضبطه على عملية تعمل**: الرمزان ملكيّتان لا عدّاد،
//!   فإعداد هذه العملية (`set_limit`) يغيّر **ما تأخذه مهامّها الجديدة**
//!   (رمزاً أو رمزين) ولا يمسّ مهاماً جارية ولا كائناً قائماً — وهذا هو
//!   المضمون الدقيق لـ«الإعداد حيّ»: يُطبَّق على المهامّ الجديدة بلا إعادة
//!   تشغيل، ولا يُقاطع الجاري.
//! * **لا استرجاع قبل موت الخيط المالك**: الاسترجاع التلقائي يعمل **بموت
//!   المالك** (لا بمرور زمن)، فمهمّة تُعلَّق إلى الأبد داخل الفصل تُبقي رمزها
//!   إلى الأبد. وذلك سلوك **مقصود** لا عطل: المهلة (`DEFAULT_WAIT`) تحدّ
//!   الانتظار، ولا تقتل حاصراً بطيئاً.
//! * **الرمز المفقود بموت العملية صار مُصلَحاً** (كان قيداً في التصميم السابق
//!   بالسِّيمافور، وهو **عطل مقيس** بمسبارَي المشرف والمدقّق: بقي العدّاد
//!   ناقصاً حتى زوال آخر مقبض): بالـmutex يصير **abandoned** ويُستعاد فوراً.
//!   ودليله الدائم `a_killed_owner_releases_its_slots_without_waiting_for_handles`
//!   (عملية تُقتل بـ`TerminateProcess` **بينما عملية الفحص تحمل مقبضاً**).
//! * **الرمز يعود فوراً بموت مالكه، وقفل الملف كذلك (م٢)**: هذا الملف يحرّر
//!   **الفتحة** لحظة موت المالك (‏mutex ⇒ abandoned)، وقفل الملف في
//!   `pipeline.rs` (`ProcessingClaim`) كان يبقى **١٢ ساعة** بعد موت العملية
//!   القاسر (`STALE_LOCK_SECS` القديم) فتفشل إعادة معالجة **الملف نفسه** —
//!   وهو **عطل مقيس** صار الإلغاء بسببه عقوبة. والآن القفل يخزّن **PID
//!   وطابعاً زمنياً** ويُسترجع بفحص **حياة العملية المالكة** (`pipeline.rs`:
//!   `lock_owner_is_dead`) ⇒ إعادة المحاولة على الملف نفسه تنجح **فوراً** بعد
//!   قتل مهمّة، والطابع الزمني بقي **مساراً بديلاً** لحالة قفل بلا PID.
//!   ودليله الدائم `a_dead_owner_lock_is_reclaimed_immediately` في `pipeline.rs`
//!   و`a_cancelled_job_reprocesses_the_same_file_immediately` هنا.
//! * **المسار غير ويندوز** (`mod local`) لا يعرف «المالك الميّت» أصلاً: زوج
//!   الرموز هناك **داخل العملية** (`Mutex`+`Condvar`)، ولا عبور عمليات — فلا
//!   عملية أجنبية تموت وهي تحمل رمزاً. وإن مات **خيط** داخل العملية وهو يحمل
//!   رمزاً بقي الرمز محجوزاً حتى نهاية العملية (الاختبارات لا تُنتج هذه الحالة،
//!   والمقصود بها `cargo test` على أي منصّة لا الإنتاج).

use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::pipeline::{self, Mode, OutKind, PipelineOutput};
use crate::proc::{self, CancelToken, JobCtx};

// ───────────────────────────── الاسم والسقف ─────────────────────────────

/// اسم جسم النواة الافتراضي. نطاق `Global\` مقصود: الفتحات تُحجز **عبر
/// العمليات** لا عبر الخيوط، ومسار CLI عملية أخرى.
pub const DEFAULT_NAME: &str = r"Global\HaramLite-Separation-Slots";

/// متغيّر البيئة الذي يتجاوز الاسم — للاختبار أساساً: اسم فريد لكل اختبار
/// فلا يتنازع الاختبار مع تطبيق المالك العامل (وهو شرط صريح في التكليف).
pub const ENV_NAME: &str = "HARAMLITE_SLOTS_NAME";

/// السقف المطلق لعدد الفصول المتزامنة على الجهاز.
///
/// **لماذا 2 لا أكثر**: قياس `nvidia-smi` على بطاقة المالك (RTX 3070 ·
/// 8192 MiB) — فصلان متزامنان بلغا ذروة **7947 من 8192 MiB (97%)** والهامش
/// **245 MiB** فقط، وفصل واحد ≈ 3732 MiB، ونموّ `BFCArena for Cuda` ≈ 2.28 GB
/// لكل جلسة. فالثالث يُنفق هامشاً غير موجود. والسقف حدّ **بطاقة** لا تفضيل
/// (التفصيل والطريقة في رأس الملف).
pub const MAX_LIMIT: u32 = 2;

/// عدد **الرموز** في زوج الـmutexات المسمّاة: رمز لكل فتحة يسمح بها السقف.
/// (كان سِّيمافوراً في التصميم الأول — والتحرير التلقائي بموت المالك هو ما
/// نقله إلى mutex؛ انظر رأس الملف.)
const TOKENS: usize = MAX_LIMIT as usize;

/// حسّاس بنيوي: تصميم الزوج يرمّز **سقفاً = 2** وحده.
///
/// مهمّة بسقف `n` تأخذ `MAX_LIMIT + 1 - n` رمزاً؛ وسقف 1 تعني «كل الرموز»
/// فلا تُنفَّذ إلا بـ`WaitForMultipleObjects(bWaitAll = TRUE)`. أما «k من n»
/// لـ`1 < k < n` فلا تُعبَّر بها نداءً واحداً. فرفع `MAX_LIMIT` بلا إعادة
/// تصميم **يفتح ثغرة في ضمان ب١** ⇒ يُمنع عند التصريف لا في التعليق.
const _: () = assert!(
    MAX_LIMIT == 2,
    "زوج الرموز يرمّز سقفاً = 2 فقط؛ رفع MAX_LIMIT يحتاج إعادة تصميم (k من n)"
);

/// القيمة الافتراضية لإعداد `max_concurrent_jobs` (وهي أيضاً سقف العملية
/// إذا لم يُطبَّق أي إعداد: CLI مثلاً).
///
/// **الافتراضي 1 لا 2** — قرار المالك في جولة م١ بعد قياس الهامش: فصلان
/// متزامنان بلغا ذروة **7943 من 8192 MiB (هامش 249)** في أسوأ ما قيس وأُعيد
/// إنتاجه، فالسقف 2 يبقى متاحاً لمن يطلبه صراحةً، والافتراضيّ يقف عند الطرف
/// الآمن. (الأساس والطريقة والقياسات كلها في رأس الملف.)
///
/// **وحدّ مقيس على من يُطبَّق عليه هذا الافتراضيّ**: `set_limit` يُنادى من
/// **مسار الواجهة وحده** (`lib.rs:922` عند تغيير الإعداد، و`lib.rs:1316` عند
/// الإقلاع)، ولا يناديه `cli.rs` (يستدعي `slots::run_separation` مباشرة) ⇒
/// **مهمّة CLI تعمل دائماً بالافتراضيّ `DEFAULT_LIMIT`**، و`max_concurrent_jobs`
/// في الإعدادات **لا أثر له على CLI**. وهذا سلوك قائم **مُوثَّق لا مُغيَّر**
/// (وإلا صار كذباً بالتوثيق لا في السلوك).
pub const DEFAULT_LIMIT: u32 = 1;

/// أقصى انتظار لفتحة قبل الخطأ الصريح — **لا انتظار أبدي**: تشابك عمليتين
/// تنتظران إلى الأبد أسوأ من خطأ يقول للمستخدم ما جرى.
pub const DEFAULT_WAIT: Duration = Duration::from_secs(30 * 60);

/// قصّ ما خرج عن المدى المسموح (1..=MAX_LIMIT). الصفر يُرفع إلى 1 لأن سقفاً
/// صفرياً يعني انتظاراً أبدياً لا تعطيلاً.
pub fn clamp_limit(n: u32) -> u32 {
    n.clamp(1, MAX_LIMIT)
}

/// **كم رمزاً تأخذ مهمّة بسقف `limit`** من زوج الرموز.
///
/// سقف `MAX_LIMIT` ⇒ رمز واحد (فتحتان متزامنتان)، وسقف 1 ⇒ الرمزان معاً
/// (حصرية فعلية: لا يبقى رمز لغيرهما). والصيغة تُبقي الدلالة صريحة عند قراءة
/// السقف، والحسّاس في الأعلى يمنع سقفاً ثالثاً لا يُعبَّر عنه.
fn tokens_required(limit: u32) -> usize {
    (MAX_LIMIT + 1 - clamp_limit(limit)) as usize
}

/// نصّ خطأ المهلة — **مصدر واحد** للمنصّتين، فالاختبارات تؤكّد النصّ نفسه على
/// أي منهما.
fn timeout_message(timeout: Duration) -> String {
    format!(
        "انتهت مهلة انتظار فتحة الفصل ({:.0} دقيقة) — فصول أخرى تعمل على هذا الجهاز؛ \
         أعد المحاولة بعد انتهائها أو ارفع المهلة",
        timeout.as_secs_f64() / 60.0
    )
}

/// الاسم الفعلي: تجاوز البيئة إن وُجد نصّ غير فارغ، وإلا الافتراضي.
fn slot_name() -> String {
    match std::env::var(ENV_NAME) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => DEFAULT_NAME.to_string(),
    }
}

/// سقف هذه العملية (يضبطه `set_limit` من الإعدادات). الافتراضي `DEFAULT_LIMIT`.
static LIMIT: AtomicU32 = AtomicU32::new(DEFAULT_LIMIT);

/// يضبط السقف من الإعدادات (مقصوضاً دائماً).
pub fn set_limit(n: u32) {
    LIMIT.store(clamp_limit(n), Ordering::SeqCst);
}

/// السقف الحالي (مقصوض — لا يمكن أن يتجاوز `MAX_LIMIT` ولو عبث أحد بالذاترة).
pub fn current_limit() -> u32 {
    clamp_limit(LIMIT.load(Ordering::SeqCst))
}

// ───────────────────────────── سِجلّ المهامّ ─────────────────────────────

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

struct JobEntry {
    label: String,
    /// مسار الإدخال (م٢): الواجهة تُطابق عنصر الطابور بالمهمّة **عبر المسار**،
    /// و`None` لمهمّة بلا ملف (نداءات التشخيص في الاختبارات).
    path: Option<String>,
    started_ms: u128,
    /// **سياق المهمّة**: الرمز الذي تقرؤه حدود المراحل ونداءات الأدوات،
    /// ومقابض العمليات الفرعية الحيّة (فيقتلها `cancel_job` فوراً).
    ctx: Arc<JobCtx>,
}

fn registry() -> &'static Mutex<Vec<(u64, JobEntry)>> {
    static JOBS: OnceLock<Mutex<Vec<(u64, JobEntry)>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(Vec::new()))
}

fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::SeqCst)
}

/// صورة مهمّة نشطة — تُقرأ من `active_jobs()` لمن يريد عرضها أو إلغاءها.
///
/// **العقد مُجمَّد (م٢)**: هذه الحقول الأربعة بأسمائها وأنواعها هي ما تُبنى
/// عليه الواجهة (`invoke("active_jobs")`)، و`path` هو ما تُطابق به عنصر
/// الطابور بالمهمّة. لا تُغيَّر بلا تصريح.
#[derive(Debug, Clone, serde::Serialize)]
pub struct JobInfo {
    pub id: u64,
    /// الوسم/المصدر: `"gui"` · `"cli"` · `"bridge"` · `"watch"` · `"telegram"`.
    pub label: String,
    /// مسار ملف الإدخال — `None` إن كانت المهمّة بلا ملف.
    pub path: Option<String>,
    /// طابع البدء (ميلي ثانية منذ حقبة يونكس) — يشمل زمن انتظار الفتحة.
    pub started_ms: u128,
    /// هل طُلب إلغاؤها؟ (الرمز يضبطه `cancel_job`، وتقرؤه حدود المراحل
    /// ونداءات الأدوات — فالإلغاء صار يوقف فعلاً في م٢.)
    pub cancelled: bool,
}

/// حارس تسجيل المهمّة: إلغاء التسجيل في `Drop` — أي عند النجاح **وعند الخطأ
/// وعند الذعر** (`Drop` يعمل أثناء فكّ المكدّس). ولا شيء هنا يفكّ الذعر ولا
/// يقفل قفلاً يُميت: القفل يُعالَج من التسمّم دائماً.
///
/// وهو أيضاً **مالك سياق المهمّة**: يبقى `Arc<JobCtx>` حيّاً ما دام الحارس،
/// فيضمن `proc::enter` في `run_registered_with` أن المؤشّر لا يشيخ.
pub struct JobGuard {
    id: u64,
    label: String,
    started_ms: u128,
    ctx: Arc<JobCtx>,
}

impl JobGuard {
    /// رمز إلغاء **هذه المهمّة** — يُمرَّر إلى `pipeline::process_file` فيقرؤه
    /// كل حدّ مرحلة وكل نداء أداة.
    pub fn token(&self) -> CancelToken {
        self.ctx.cancel.clone().unwrap_or_default()
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        // خيوط قراءة المخرجات تُضمّ **قبل** إلغاء التسجيل: لا يبقى قارئ على
        // أنبوب طفل قُتل (وإلا وُجد خيط يتيم بعد «انتهت المهمّة» في السجلّ).
        proc::join_reader_threads(&self.ctx);
        let removed = {
            let mut jobs = registry().lock().unwrap_or_else(|p| p.into_inner());
            let before = jobs.len();
            jobs.retain(|(id, _)| *id != self.id);
            before != jobs.len()
        };
        let elapsed = now_ms().saturating_sub(self.started_ms);
        let cancelled = self
            .ctx
            .cancel
            .as_ref()
            .map(|c| c.is_cancelled())
            .unwrap_or(false);
        if removed {
            tracing::info!(
                target: "slots",
                "انتهت المهمة #{} ({}) بعد {elapsed}ms — أُلغيت: {cancelled}",
                self.id, self.label
            );
        } else {
            tracing::warn!(target: "slots", "المهمة #{} ({}) لم تكن مسجَّلة عند الانتهاء", self.id, self.label);
        }
    }
}

/// يسجّل مهمّة ويعيد حارساً يلغي التسجيل عند سقوطه.
fn register_job(label: &str, path: Option<&str>) -> JobGuard {
    let id = next_id();
    let started_ms = now_ms();
    let ctx = Arc::new(JobCtx {
        cancel: Some(CancelToken::new()),
        ..Default::default()
    });
    {
        let mut jobs = registry().lock().unwrap_or_else(|p| p.into_inner());
        jobs.push((
            id,
            JobEntry {
                label: label.to_string(),
                path: path.map(str::to_string),
                started_ms,
                ctx: ctx.clone(),
            },
        ));
    }
    tracing::info!(
        target: "slots",
        "بدأت المهمة #{id} ({label}){}",
        path.map(|p| format!(" — {p}")).unwrap_or_default()
    );
    JobGuard {
        id,
        label: label.to_string(),
        started_ms,
        ctx,
    }
}

/// المهامّ النشطة الآن، مرتّبةً بمعرّفها (أي بترتيب بدئها).
pub fn active_jobs() -> Vec<JobInfo> {
    let jobs = registry().lock().unwrap_or_else(|p| p.into_inner());
    let mut out: Vec<JobInfo> = jobs
        .iter()
        .map(|(id, e)| JobInfo {
            id: *id,
            label: e.label.clone(),
            path: e.path.clone(),
            started_ms: e.started_ms,
            cancelled: e
                .ctx
                .cancel
                .as_ref()
                .map(|c| c.is_cancelled())
                .unwrap_or(false),
        })
        .collect();
    out.sort_by_key(|j| j.id);
    out
}

/// يضبط رمز الإلغاء **لهذه المهمّة وحدها** **ويقتل أبناءها فوراً**.
///
/// يعيد `false` إن لم تكن المهمّة نشطة (انتهت أو معرّف خاطئ) — فلا يُدَّعى
/// إلغاء لم يقع. وعند `true` يكون الإلغاء **قد وقع**: الرمز مضبوط (فتسقط
/// حدود المراحل عند أول فحص) وشجرة العمليات المنفصلة (ffmpeg/yt-dlp ومخدّم
/// مُدمِجها) قُتلت بـ`taskkill /T /F` في هذا النداء نفسه.
///
/// **حدّ صريح باقٍ**: نداء ONNX داخل العملية غير قابل للقطع؛ مهمّة داخل
/// `separator::separate` تُهجر عند أول حدّ بعده (دلالة على مرحلتين — قرار المالك).
pub fn cancel_job(id: u64) -> bool {
    let (ctx, label) = {
        let jobs = registry().lock().unwrap_or_else(|p| p.into_inner());
        match jobs.iter().find(|(jid, _)| *jid == id) {
            Some((_, e)) => (e.ctx.clone(), e.label.clone()),
            None => return false,
        }
    };
    if let Some(c) = ctx.cancel.as_ref() {
        c.set();
    }
    let killed = proc::kill_children(&ctx);
    tracing::warn!(
        target: "slots",
        "طُلب إلغاء المهمة #{id} ({label}) — قُتلت {killed} عملية فرعية حيّة"
    );
    true
}

/// يطلب إلغاء كل المهامّ النشطة (يستدعيه أمر الواجهة `cancel_process` إضافةً
/// إلى العلم العام القائم). يعيد عدد المهامّ التي وُسمت.
///
/// وكل مهمّة تُلغي **أبناءها هي** (`cancel_job` لكل معرّف) — فلا تلمس مهمّةٌ
/// عمليات مهمّة أخرى.
pub fn cancel_all() -> usize {
    let jobs = active_jobs();
    if !jobs.is_empty() {
        let now = now_ms();
        let described: Vec<String> = jobs
            .iter()
            .map(|j| {
                format!(
                    "#{} {}{} (+{}ms)",
                    j.id,
                    j.label,
                    if j.cancelled {
                        " [طُلب إلغاؤها سابقاً]"
                    } else {
                        ""
                    },
                    now.saturating_sub(j.started_ms)
                )
            })
            .collect();
        tracing::info!(target: "slots", "إلغاء {} مهمّة نشطة: {}", jobs.len(), described.join(" · "));
    }
    // قائمة المعرّفات تُقرأ أولاً (وإلا تغيّر السِجلّ أثناء المرور).
    let ids: Vec<u64> = jobs.iter().map(|j| j.id).collect();
    ids.into_iter().filter(|id| cancel_job(*id)).count()
}

/// ينتظر حتى يفرغ السِجلّ أو تنتهي المهلة. يعيد `true` إن فرغ.
///
/// **لماذا هو موجود**: من يقول «أُلغيت» يجب أن يكون صادقاً. `cancel_job`
/// يعيد «سُجِّل الطلب» لا «توقّف العمل»، وهذا النداء هو الفرق بينهما — يستعمله
/// `/kill` في تلغرام فينتظر قبل أن يجيب، **ويستعمله اختبار اليتيم** بعده ليقيس
/// أن السِجلّ فرغ فعلاً (ت٤) لا أن الطلب «أُرسل». ولهذا يبقى عامّاً على كل
/// المنصّات: `telegram` وحده `#[cfg(windows)]`، فلو وُسم به لقيست ت٤ على
/// ويندوز وحدها.
pub fn wait_until_idle(timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    loop {
        if active_jobs().is_empty() {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// ينتظر انتهاء **مهامّ بعينها** (بمعرّفاتها) أو انتهاء المهلة. يعيد `true`
/// إن لم يبقَ منها شيء في السِجلّ.
pub fn wait_until_gone(ids: &[u64], timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    loop {
        let live = active_jobs();
        if !live.iter().any(|j| ids.contains(&j.id)) {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// ─────────────────────── الفتحة (mutex نواة/عملية) ───────────────────────

/// حارس فتحة. النوع يختلف بحسب المنصّة، والسلوك واحد: `Drop` يحرّر الفتحة.
#[cfg(windows)]
type SlotGuard = WinSem;
#[cfg(not(windows))]
type SlotGuard = LocalSem;

/// فشل الاكتساب: `(هل يصحّ السقوط إلى نطاق الجلسة؟, الرسالة العربية)`.
///
/// زوج لا `enum`: الفروع لا تُنشأ كلها على كل منصّة، و`enum` بفرع لا يُنشأ
/// يُنتج تحذير `dead_code` — ولا نُضيف `#[allow(dead_code)]` (ممنوع في العقد).
type AcquireFailure = (bool, String);

/// **سجلّ ما يحمله هذا الخيط** من أسماء الرموز — عدّ مرجعي لكل اسم.
///
/// لماذا: ملكيّة الـmutex **تراكبية** بخيطها، فطلبُ الخيط اسمًا يحمله يمنحه
/// ويندوز ملكيّة ثانية **فوراً بلا حجب**، وتحرير واحد لا يكفي ⇒ منتظر آخر
/// يعبر والحاصر يعمل = **ثغرة صامتة في ب٢**. فهذا السجلّ يردّ الطلب بخطأ
/// عربي صريح بدل المنح الصامت.
///
/// **يُبنى على ويندوز وحده**: `mod local` لا يعرف الملكيّة التراكبية أصلاً
/// (رمز محجوز يبقى محجوزاً حتى يُحرَّر، فطلبُ الخيط نفسه يفشل بمهلة كما يفشل
/// لغيره) — فلا سجلّ هناك ولا حاجة إليه.
#[cfg(windows)]
fn held_counts(
) -> &'static std::thread::LocalKey<std::cell::RefCell<std::collections::HashMap<String, usize>>> {
    std::thread_local! {
        static HELD: std::cell::RefCell<std::collections::HashMap<String, usize>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }
    &HELD
}

/// يسجّل اكتساب رمز باسمه (عدّ مرجعي: رمزا المهمّة نفسها = عدّان).
#[cfg(windows)]
fn register_held(name: &str) {
    held_counts().with(|h| *h.borrow_mut().entry(name.to_string()).or_insert(0) += 1);
}

/// يلغي تسجيل رمز (يُنقص العدّ، ويحذف الاسم عند الصفر).
#[cfg(windows)]
fn unregister_held(name: &str) {
    held_counts().with(|h| {
        let mut map = h.borrow_mut();
        if let Some(n) = map.get_mut(name) {
            *n -= 1;
            if *n == 0 {
                map.remove(name);
            }
        }
    });
}

/// هل يحمل **هذا الخيط** الرمز بهذا الاسم؟ (يُقرأ في فحص التراكب.)
#[cfg(windows)]
fn holds_token(name: &str) -> bool {
    held_counts().with(|h| h.borrow().get(name).copied().unwrap_or(0) > 0)
}

/// كم مرّة يحمل **هذا الخيط** الرمز بهذا الاسم؟ (عدّان = رمزا الزوج معاً.)
#[cfg(windows)]
fn held_count(name: &str) -> usize {
    held_counts().with(|h| h.borrow().get(name).copied().unwrap_or(0))
}

/// نصّ خطأ الاكتساب التراكبي — **مصدر واحد** للمنصّتين.
///
/// **و`#[cfg(windows)]` لا زخرفة**: مستدعيها الوحيد هو `kernel::acquire` وهو
/// `#[cfg(windows)]`، فعلى غير ويندوز تصير دالةً غير مستعملة (`dead_code`) —
/// وذلك يناقض قصد الملف المعلَن (لا `#[allow(dead_code)]` في هذا المستودع).
#[cfg(windows)]
fn reentry_message(name: &str) -> String {
    format!(
        "رفض اكتساب تراكبي: هذا الخيط يحمل رمز الفصل «{name}» بالفعل — \
         لا تُطلب الفتحة نفسها مرّتين على الخيط الواحد (الملكيّة تراكبية في \
         ويندوز فيمرّ منتظر آخر بلا حجب)"
    )
}

#[cfg(windows)]
mod kernel {
    //! **زوج mutexات نواة مسمّاة** — ملكيّة خيط، واسترجاع تلقائي بموت المالك.
    //!
    //! لماذا **mutex** لا سِّيمافور (وهو جوهر إصلاح العطل الثاني): السِّيمافور
    //! **لا مالك له**، فقتل حامله لا يُعيد عدّاده ما بقيت أي عملية تحمل مقبضاً
    //! للكائن. وللـmutex **مالك**، فموته يجعل الكائن **abandoned = متاحاً**
    //! ويأخذه المنتظر التالي ويرث الملكيّة — بلا بروتوكول إضافي ولا زمن انتظار.
    //!
    //! ولماذا زوج لا كائن واحد بعدّاد: كائن واحد يجعل «السقف» عدّاداً متغيّراً
    //! (ويندوز يتجاهل السقف المطلوب إن كان الكائن قائماً) — وبالزوج لا سعة
    //! متغيّرة أصلاً، فينتفي العطل من أصله.
    //!
    //! | سقف المهمّة | ما تأخذه | الأثر |
    //! |---|---|---|
    //! | 2 | رمز **واحد**، أيّهما (`bWaitAll = FALSE`) | مهمّتان متزامنتان |
    //! | 1 | **الرمزان معاً** (`bWaitAll = TRUE`) | حصرية: لا شيء معهما |
    //!
    //! و**أكواد النجاح أربعة لا واحد**: `WAIT_OBJECT_0` و`WAIT_ABANDONED_0`
    //! (0x80) للحالة «الأول»، و`+1` منهما (1 و0x81) للا-حصرية. والمهلة
    //! `WAIT_TIMEOUT` (0x102) وحدها مهلة، وما عداها خطأ صريح. و`bWaitAll = TRUE`
    //! **لا يجزّئ الاكتساب** حتى مع `WAIT_ABANDONED_0` (قِيس: ملك الاثنين).

    use super::{
        reentry_message, timeout_message, AcquireFailure, Duration, SlotGuard, WinSem, TOKENS,
    };
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{
        GetLastError, BOOL, ERROR_ALREADY_EXISTS, HANDLE, WAIT_ABANDONED_0, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        CreateMutexW, OpenMutexW, ReleaseMutex, WaitForMultipleObjects, MUTEX_ALL_ACCESS,
    };

    /// لواحق الرموز: رمز لكل فتحة. أسماء **جديدة تماماً** لا كائن قديم بها من
    /// نسخة سابقة (الاسم القديم كان بلا لاحقة، وكائنه سِّيمافور) ⇒ لا يُفتح
    /// كائن موروث بنوع أو سعة غير ما نتوقّع. (وهي خاصّة بفضاء أسماء النواة،
    /// فمحلّها هذا الوحدة.)
    const TOKEN_SUFFIX: [&str; TOKENS] = ["a", "b"];

    /// اسم **رمز** من الزوج مشتقّاً من الاسم الأساس: تجاوز البيئة
    /// (`HARAMLITE_SLOTS_NAME`) يكوّن الرمزين معاً، فلا تختلط ميزانيتان.
    /// (`pub(super)` لأن `WinSem::drop` في الوحدة الأم يحتاجه.)
    pub(super) fn token_name(base: &str, i: usize) -> String {
        format!("{base}-{}", TOKEN_SUFFIX[i])
    }

    /// مقابض مفتوحة في هذه العملية، بالاسم — فلا يُعاد الإنشاء مع كل مهمّة،
    /// ولا يُغلق مقبض مستعمل (الإغلاق كان سيُبطل الكائن إن كان آخر مقبض).
    ///
    /// **وهذا هو ما كان يجعل العطل ممكناً**: المقبض يعيش مدى الحياة، فالكائن
    /// لا يزول بموت حامله. وبالـmutex لم يعد ذلك يمنع الاسترجاع (الملكيّة
    /// تُرفع بموت المالك لا بزوال الكائن) — وهو ما يقيسه
    /// `a_killed_owner_releases_its_slots_without_waiting_for_handles`.
    fn cache() -> &'static Mutex<HashMap<String, isize>> {
        static CACHE: OnceLock<Mutex<HashMap<String, isize>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// يفتح mutex قائماً، وإلا يُنشئه **غير مملوك** (`bInitialOwner = FALSE`).
    ///
    /// (`pub(super)` لأن اختبار «الرمز يعود عند قتل المالك» يحتاج أن يحمل
    /// **هو** مقبضاً للكائن — وهو تشكيل الإنتاج: الواجهة الدائمة تحمل المقابض.)
    pub(super) fn token_handle(name: &str) -> Result<isize, AcquireFailure> {
        let mut map = cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(h) = map.get(name) {
            return Ok(*h);
        }
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // `OpenMutexW` أولاً: العملية الثانية تجد كائن الأولى فلا تُنشئ ثانياً.
        let mut handle = unsafe { OpenMutexW(MUTEX_ALL_ACCESS, 0, wide.as_ptr()) };
        let created = handle.is_null();
        if created {
            // `FALSE` = **بلا مالك**: الإنشاء لا يعني الاكتساب، وإلا صار من
            // أنشأ الكائن حاصراً له بلا أن يطلبه.
            handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
        }
        if handle.is_null() {
            let code = unsafe { GetLastError() };
            return Err((
                true,
                format!("تعذر إنشاء/فتح mutex الفصل «{name}» (رمز Win32 {code})"),
            ));
        }
        if created {
            // `GetLastError` فوراً بعد `CreateMutexW` (لا نداء Win32 بينهما).
            let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
            if existed {
                tracing::debug!(target: "slots", "mutex الفصل «{name}» كان قائماً ففُتح بلا إنشاء");
            } else {
                tracing::info!(
                    target: "slots",
                    "أُنشئ mutex الفصل «{name}» **غير مملوك** — ويندوز يمنح الملكيّة لمن ينتظره، \
                     ويُعيدها فوراً (abandoned) إن مات مالكها"
                );
            }
        }
        let raw = handle as isize;
        map.insert(name.to_string(), raw);
        Ok(raw)
    }

    /// يكتسب `tokens` رمزاً من رمزَي الاسم الأساس، بمهلة.
    pub(super) fn acquire(
        base: &str,
        tokens: usize,
        timeout: Duration,
    ) -> Result<SlotGuard, AcquireFailure> {
        let handles = [
            token_handle(&token_name(base, 0))?,
            token_handle(&token_name(base, 1))?,
        ];
        // **رفض الاكتساب التراكبي على الخيط نفسه** قبل أي نداء نواة: لو طلب
        // الخيط اسماً يحمله لمنحه ويندوز ملكيّة تراكبية فوراً (بلا حجب) —
        // فتحرير واحد لا يكفي، ويعبر منتظر آخر بينما الحاصر يعمل. والفرعان
        // كلاهما مرفوض: (١) رمز يملكه هذا الخيط من الزوج (طلب سقف 2)،
        // (٢) الزوج كامل بيده (طلب حصرية ثانية).
        let blocked = if tokens >= TOKENS {
            let (a, b) = (token_name(base, 0), token_name(base, 1));
            (super::holds_token(&a) && super::holds_token(&b))
                || super::held_count(&a) >= 2
                || super::held_count(&b) >= 2
        } else {
            super::holds_token(&token_name(base, 0)) || super::holds_token(&token_name(base, 1))
        };
        if blocked {
            return Err((false, reentry_message(base)));
        }
        // الرمزان معاً = حصرية (سقف 1). وحسّاس التصريف يضمن ألّا يكون الطلب
        // إلا 1 أو الرمزين، فلا حاجة إلى «k من n» غير قابل للتنفيذ.
        let all = tokens >= TOKENS;
        let raw: [HANDLE; TOKENS] = [handles[0] as _, handles[1] as _];
        // `as_millis` u128 ⇒ قصّ إلى u32-1: `INFINITE` (0xFFFFFFFF) لا يُستعمل
        // أبداً، فالمهمّة لا تنتظر أبداً حتى لو أُعطي مهلة هائلة. والمهلة
        // `Duration::ZERO` مدعومة (استطلاع فوري بلا انتظار).
        let ms = timeout.as_millis().min((u32::MAX - 1) as u128) as u32;
        let rc = unsafe { WaitForMultipleObjects(TOKENS as u32, raw.as_ptr(), all as BOOL, ms) };
        // **`WAIT_ABANDONED_0` نجاح لا خطأ**: مالك سابق مات بلا تحرير،
        // والملكيّة آلت إلينا. ومع `bWaitAll = TRUE` تعني أننا **ملكنا
        // الاثنين** (قِيس: `ReleaseMutex` للاثنين بعده أعادت `true`).
        let took: Option<[bool; TOKENS]> = if rc == WAIT_OBJECT_0 || rc == WAIT_ABANDONED_0 {
            // `bWaitAll = TRUE`: الرمزان. و`FALSE`: **الأول وحده** (أدنى فهرسةً
            // صار متاحاً) — ويندوز لا يكتسب إلا الرمز الذي أُعيد فهرسه.
            Some(if all { [true, true] } else { [true, false] })
        } else if !all && (rc == WAIT_OBJECT_0 + 1 || rc == WAIT_ABANDONED_0 + 1) {
            Some([false, true])
        } else if rc == WAIT_TIMEOUT {
            // **لا شيء أُخذ**: `TRUE` لا يجزّئ الاكتساب، و`FALSE` لا يكتسب عند
            // المهلة ⇒ الزوج كما كان، ومهمّة تالية تجد ما كانت تجده.
            return Err((false, timeout_message(timeout)));
        } else {
            return Err((false, format!("فشل انتظار فتحة الفصل (رمز Win32 {rc})")));
        };
        let held_now = took.expect("كل كود نجاح صار رمزاً مأخوذاً");
        for (i, taken) in held_now.iter().enumerate() {
            if *taken {
                super::register_held(&token_name(base, i));
            }
        }
        Ok(WinSem::new(base.to_string(), handles, held_now))
    }
    /// يحرّر **ملكيّة** الرمز. `ReleaseMutex` من غير مالكه تفشل
    /// (`ERROR_NOT_OWNER`) — والسجلّ يكشف ذلك بدل أن يمرّ صامتاً.
    pub(super) fn release(name: &str, handle: isize) -> bool {
        let ok = unsafe { ReleaseMutex(handle as _) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            tracing::warn!(
                target: "slots",
                "تعذر تحرير ملكيّة mutex الفصل «{name}» (رمز Win32 {code}) — \
                 الملكيّة للخيط الذي اكتسب، والتحرير من خيط آخر يفشل"
            );
            return false;
        }
        super::unregister_held(name);
        true
    }
}

/// حارس الفتحة على ويندوز: مقابض رمزَي النواة + **ما أُخذ بالضبط**.
///
/// **`!Send` عن قصد**: الحقل `PhantomData<*const ()>` يمنع نقل الحارس بين
/// الخيوط **عند التصريف**، لأن ملكيّة الـmutex **للخيط** لا للعملية، فتحريره
/// من خيط آخر يفشل (`ERROR_NOT_OWNER`).
#[cfg(windows)]
struct WinSem {
    /// الاسم الأساس — مفتاح سجلّ «ما يحمله هذا الخيط» (`held_counts`).
    name: String,
    /// `HANDLE` مؤشّر خام (`*mut c_void`) لا يقبل `Send`/`Sync` تلقائياً.
    /// نخزّنه `isize` ونتحوّل عند النداء: مقابض النواة صالحة من أي خيط في
    /// العملية (ضمان Win32)، والمقبض لا يُغلق أبداً فلا إغلاق مزدوج.
    handles: [isize; TOKENS],
    /// ما أُخذ: رمز واحد (سقف 2) أو الرمزان (سقف 1). التحرير **بقدره**.
    held: [bool; TOKENS],
    /// الخيط الذي أخذ الرموز — الملكيّة له، والتحرير من غيره يفشل.
    owner: std::thread::ThreadId,
    /// يمنع `Send` — انظر توثيق النوع.
    _not_send: std::marker::PhantomData<*const ()>,
}

#[cfg(windows)]
impl WinSem {
    fn new(name: String, handles: [isize; TOKENS], held: [bool; TOKENS]) -> Self {
        Self {
            name,
            handles,
            held,
            owner: std::thread::current().id(),
            _not_send: std::marker::PhantomData,
        }
    }
}

#[cfg(windows)]
impl Drop for WinSem {
    fn drop(&mut self) {
        // **على الخيط الذي أخذ**: الملكيّة ملكيّة الخيط، و`ReleaseMutex` من
        // غيره تفشل (`ERROR_NOT_OWNER`). والحارس `!Send` يمنع النقل عند
        // التصريف، وهذا الفحص يمسك أي التفاف عليه من داخل العملية (استعارة
        // عبر `&` مشترك في سياق غير آمن، أو إسقاط في خيط آخر).
        debug_assert!(
            self.owner == std::thread::current().id(),
            "أُسقط حارس الفتحة «{}» على خيط غير الذي أخذها ({} ≠ {}) — \
             الملكيّة للخيط، والتحرير من غيره يفشل",
            self.name,
            fmt_thread(self.owner),
            fmt_thread(std::thread::current().id())
        );
        // تحرير **ما أُخذ بالضبط**: تحرير غير مأخوذ يفشل، وتفويت مأخوذ يُجمّد
        // فتحة إلى الأبد.
        for i in 0..TOKENS {
            if self.held[i] {
                kernel::release(&kernel::token_name(&self.name, i), self.handles[i]);
            }
        }
    }
}

/// صيغة مقروءة لمعرّف خيط (رسائل الفحص).
#[cfg(windows)]
fn fmt_thread(id: std::thread::ThreadId) -> String {
    format!("{id:?}")
}

#[cfg(not(windows))]
mod local {
    //! انحدار غير ويندوز: **زوج رموز داخل العملية** (مصفوفة + `Condvar`)
    //! مفتاحه الاسم — بنفس دلالة الزوج في النواة: الرمز لأيّ مهمّة، والرمزان
    //! للحصرية، والاكتساب **لا يُجزَّأ** (كـ`bWaitAll`). الغرض أن يبقى
    //! `cargo test` ممكناً على أي منصّة بنفس السلوك لا بشكل يشبهه.

    use super::{timeout_message, AcquireFailure, Duration, LocalPair, LocalSem, TOKENS};
    use std::collections::HashMap;
    use std::sync::{Arc, Condvar, Mutex, OnceLock};
    use std::time::Instant;

    fn registry() -> &'static Mutex<HashMap<String, Arc<LocalPair>>> {
        static MAP: OnceLock<Mutex<HashMap<String, Arc<LocalPair>>>> = OnceLock::new();
        MAP.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// يأخذ `n` رمزاً حرّاً (الأدنى فهرسةً أولاً) أو **لا شيء**: عند نقص رمز
    /// يُعاد ما أُخذ — فلا اكتساب جزئي، مطابقةً لـ`bWaitAll = TRUE`.
    fn take(free: &mut [bool; TOKENS], n: usize) -> Option<[bool; TOKENS]> {
        let mut taken = [false; TOKENS];
        let mut left = n;
        for i in 0..TOKENS {
            if left == 0 {
                break;
            }
            if free[i] {
                free[i] = false;
                taken[i] = true;
                left -= 1;
            }
        }
        if left == 0 {
            return Some(taken);
        }
        for i in 0..TOKENS {
            if taken[i] {
                free[i] = true;
            }
        }
        None
    }

    pub(super) fn acquire(
        name: &str,
        tokens: usize,
        timeout: Duration,
    ) -> Result<LocalSem, AcquireFailure> {
        let pair = {
            let mut map = registry().lock().unwrap_or_else(|p| p.into_inner());
            map.entry(name.to_string())
                .or_insert_with(|| {
                    Arc::new(LocalPair {
                        free: Mutex::new([true; TOKENS]),
                        cv: Condvar::new(),
                    })
                })
                .clone()
        };
        let mut free = pair.free.lock().unwrap_or_else(|p| p.into_inner());
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(taken) = take(&mut free, tokens) {
                // القفل يُسقط **قبل** نقل `pair` إلى الحارس: `MutexGuard` يستعير
                // من `pair.free`، فنقله وهو حيّ خطأ تصريف لا يظهر إلا على منصّة
                // غير ويندوز (اكتُشف بإجبار فرع `cfg(not(windows))` على التصريف).
                drop(free);
                return Ok(LocalSem { pair, taken });
            }
            let now = Instant::now();
            if now >= deadline {
                return Err((false, timeout_message(timeout)));
            }
            // الاستيقاظ الكاذب والمهلة يُعاد فحصهما في رأس الحلقة، فلا مسار
            // يُعلن فشلاً ورمزٌ حرّ.
            let (guard, _) = pair
                .cv
                .wait_timeout(free, deadline - now)
                .unwrap_or_else(|p| p.into_inner());
            free = guard;
        }
    }

    /// تحرير **ما أُخذ بالضبط**، ثم `notify_all`.
    ///
    /// `notify_all` لا `notify_one` **عمداً**: حاصرٌ يحتاج الرمزين قد يُوقَظ
    /// أولاً برمز واحد فيعود إلى الانتظار، ولو كان الإيقاظ واحداً لنام من
    /// يستطيع الأخذ ⇒ **ضياع إيقاظ** لا مجرّد بطء.
    pub(super) fn release(pair: &Arc<LocalPair>, taken: [bool; TOKENS]) {
        let mut free = pair.free.lock().unwrap_or_else(|p| p.into_inner());
        for i in 0..TOKENS {
            if taken[i] {
                free[i] = true;
            }
        }
        pair.cv.notify_all();
    }
}

/// زوج الرموز في انحدار غير ويندوز: `true` = الرمز حرّ.
#[cfg(not(windows))]
struct LocalPair {
    free: Mutex<[bool; TOKENS]>,
    cv: std::sync::Condvar,
}

#[cfg(not(windows))]
struct LocalSem {
    pair: Arc<LocalPair>,
    /// ما أُخذ بالضبط (مطابقةً لدلالة `WinSem`).
    taken: [bool; TOKENS],
}

#[cfg(not(windows))]
impl Drop for LocalSem {
    fn drop(&mut self) {
        local::release(&self.pair, self.taken);
    }
}

/// فتحة في نطاق الجلسة (بلا بادئة `Global\`) — بديل إن رُفض النطاق العام.
fn session_local(name: &str) -> Option<String> {
    name.strip_prefix(r"Global\")
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// يكتسب فتحة بالاسم المعطى: يفتح رمزَي النواة أو يُنشئهما، ثم ينتظر بمهلة.
///
/// عدد الرموز يُشتقّ من السقف مرة واحدة هنا (`tokens_required`) فيسري الأمر
/// نفسه على المنصّتين.
///
/// **السقوط إلى نطاق الجلسة**: إنشاء كائن في `Global\` يحتاج
/// `SeCreateGlobalPrivilege` وهي ليست مضمونة لكل مستخدم. فإن رُفض الإنشاء
/// (وليس الانتظار) أُعيدت المحاولة باسم بلا البادئة — وهو نطاق الجلسة، وهو
/// المدى الذي تتنازع فيه عملياتنا فعلاً (الواجهة وخدمة المراقبة والجسر في
/// العملية نفسها، وCLI في الجلسة نفسها). فلا يتحوّل رفضُ الصلاحية إلى تعطيل
/// الفصل كله. واللواحق تُضاف **بعد** نزع البادئة، فالرمزين هما الرمزان في
/// النطاقين.
fn acquire_named(name: &str, limit: u32, timeout: Duration) -> Result<SlotGuard, String> {
    let tokens = tokens_required(limit);
    match platform_acquire(name, tokens, timeout) {
        Ok(guard) => Ok(guard),
        Err((retry_local, why)) => {
            if !retry_local {
                return Err(why);
            }
            match session_local(name) {
                Some(local) => {
                    tracing::warn!(
                        target: "slots",
                        "{why} — السقوط إلى نطاق الجلسة «{local}»"
                    );
                    platform_acquire(&local, tokens, timeout).map_err(|(_, e)| e)
                }
                None => Err(why),
            }
        }
    }
}

#[cfg(windows)]
fn platform_acquire(
    name: &str,
    tokens: usize,
    timeout: Duration,
) -> Result<SlotGuard, AcquireFailure> {
    kernel::acquire(name, tokens, timeout)
}

#[cfg(not(windows))]
fn platform_acquire(
    name: &str,
    tokens: usize,
    timeout: Duration,
) -> Result<SlotGuard, AcquireFailure> {
    local::acquire(name, tokens, timeout)
}

// ───────────────────────── مدخل الفصل الواحد ─────────────────────────

/// نتيجة محاولة الاكتساب: الحارس + **هل وقع انتظار فعلي؟**
///
/// **ولماذا هذا الحقل**: السطر «بانتظار فتحة فصل…» كان يُطبع **قبل** الطلب
/// دائماً، فيكذب على مهمّة أخذت الفتحة فوراً — قِيس: مهمّة حرّة انتهت في
/// **433ms** وطُبع السطران، والحالة الحرّة **9.8ms** مقابل المحجوزة **18.618s**.
/// فالآن يُحاول **فوراً** أولاً، ولا يُعلَن انتظار **إلا إذا وقع**.
struct Acquired {
    /// الحارس — يُحرَّر عند سقوطه.
    _guard: SlotGuard,
    /// هل انتُظر؟ (كاذب = أُخذ الرمز من المحاولة الفورية.)
    waited: bool,
    /// زمن الانتظار المقيس (صفر إن لم يقع انتظار فعلًا).
    waited_for: Duration,
}

/// محاولة **فورية** أولاً (`Duration::ZERO`)، ثم المهلة الكاملة عند الفشل.
///
/// والمحاولة الفورية مدعومة على المنصّتين: ويندوز `WaitForMultipleObjects`
/// بمهلة 0 (استطلاع لا انتظار)، وغير ويندوز `deadline = now` في `local`.
/// فمهلة الصفر تعني «لا تنتظر» لا «انتهت المهلة خطأً».
fn acquire_now_or_wait(
    slot_name: &str,
    limit: u32,
    timeout: Duration,
    on_wait: impl FnOnce(),
) -> Result<Acquired, String> {
    match acquire_named(slot_name, limit, Duration::ZERO) {
        Ok(guard) => Ok(Acquired {
            _guard: guard,
            waited: false,
            waited_for: Duration::ZERO,
        }),
        Err(_) => {
            // **الإعلان قبل الحجب لا بعده**: المستخدم يجب أن يعرف أن المهمّة
            // تنتظر **وهي تنتظر** (قاس المدقّق ٣٤٢ ثانية صمت تامّ)، وزمن
            // الانتظار المقيس يُسجَّل بعد الاكتساب. ولذلك `on_wait` نداءٌ صريح
            // يُستدعى هنا، فيُختبر بإغلاق يسجّل **لحظته** لا بالتقاط السجلّ.
            on_wait();
            let started = std::time::Instant::now();
            let guard = acquire_named(slot_name, limit, timeout)?;
            Ok(Acquired {
                _guard: guard,
                waited: true,
                waited_for: started.elapsed(),
            })
        }
    }
}

/// **النواة الوحيدة**: سِجلّ المهمّة + فتحة الفصل + الجسم، في نقطة واحدة
/// تمرّ منها كل مهمّة فصل. الترتيب مقصود: التسجيل قبل الانتظار (فتظهر
/// المهمّة المنتظرة في السِجلّ لا المخدومة وحدها)، والتحرير بترتيب عكسي
/// (الفتحة تُحرَّر قبل إلغاء التسجيل، فلا تبقى مهمّة «نشطة» بلا فتحة).
///
/// والسقف يُقرأ **لحظة الطلب** (ب٣): تغيير الإعداد في الإعدادات يغيّر ما تأخذه
/// المهامّ **الجديدة** بلا إعادة تشغيل، ولا يمسّ مهمّة جارية (الرموز المأخوذة
/// تبقى بيد صاحبها حتى ينتهي).
fn run_registered<T>(
    slot_name: &str,
    label: &str,
    path: Option<&str>,
    body: impl FnOnce(&CancelToken) -> Result<T, String>,
) -> Result<T, String> {
    run_registered_with(slot_name, label, path, current_limit(), body)
}

/// نفس النواة بسقف صريح — يفصل «ما تأخذه هذه المهمّة» عن الحالة العامة
/// (`LIMIT`)، فيُقاس سقف بعينه بلا لمس إعداد العملية كلها (والاختبارات تحتاجه).
///
/// **و`proc::enter` هنا هو ما يجعل الإلغاء حقيقيّاً**: كل نداء أداة داخل الجسم
/// (عبر خيوط المهمّة هذه وأبنائها المسجّلة) يجد سياق المهمّة فيسجّل مقبضه،
/// فيقتله `cancel_job(id)` فوراً. والحارس يُزيل السياق في `Drop` — حتى عند
/// الذعر وعند الخروج المبكر لفشل الفتحة.
fn run_registered_with<T>(
    slot_name: &str,
    label: &str,
    path: Option<&str>,
    limit: u32,
    body: impl FnOnce(&CancelToken) -> Result<T, String>,
) -> Result<T, String> {
    let job = register_job(label, path);
    let token = job.token();
    let _ctx = proc::enter(&job.ctx);
    // **الإعلان صادق أو لا يكون**: محاولة فورية أولاً، ولا سطر انتظار إطلاقاً
    // إن أُخذت الفتحة فوراً. وإن وقع انتظار فعلاً أُعلن **قبله** (فالانتظار كان
    // صامتاً في السجلّ: قاس المدقّق ٣٤٢ ثانية بلا أثر)، ثم يُسجَّل **زمنه
    // المقيس** بعد الاكتساب — لا تخميناً. (سطران لا سطر: «بانتظار» أثناء
    // الانتظار، و«انتظرت ٥١.٠ ث» بعده — وكلاهما صادق في لحظته.)
    let got = acquire_now_or_wait(slot_name, limit, DEFAULT_WAIT, || {
        tracing::info!(
            target: "slots",
            "المهمّة ({label}) بانتظار فتحة فصل (سقف {limit})…"
        );
    })
    .inspect_err(|e| {
        tracing::warn!(target: "slots", "المهمّة ({label}) لم تحصل على فتحة فصل: {e}");
    })?;
    if got.waited {
        tracing::info!(
            target: "slots",
            "انتظرت المهمّة ({label}) فتحة فصل {:.1} ث (سقف {limit})",
            got.waited_for.as_secs_f64()
        );
    }
    body(&token)
}

/// فصل ملف عبر `pipeline::process_file` تحت فتحة جهاز — **المدخل الواحد**.
///
/// `label` هو وسم المصدر (`"gui"` · `"cli"` · `"bridge"` · `"watch"` ·
/// `"telegram"`) ويظهر في سِجلّ المهامّ. والوسائط بعدها بنفس ترتيب
/// `pipeline::process_file` حرفياً، فلا يتغيّر شيء في `progress`/`stage`.
///
/// **م٢**: يُسجَّل مسار الإدخال مع المهمّة (`active_jobs()[i].path`)، ويُبنى
/// **رمز إلغاء لكل مهمّة** يُمرَّر إلى `process_file` — فـ`cancel_job(id)`
/// يوقف هذه المهمّة وحدها (ويقتل أدواتها الجارية).
///
/// الخطأ `String` لا `PipelineError`: الخطأ صار من مصدرين (الفتحة والمحرّك)،
/// وكل المواضع الخمسة تحوّله إلى نصّ أصلاً.
pub fn run_separation(
    label: &str,
    input: &Path,
    out_dir: &Path,
    mode: Mode,
    kind: OutKind,
    keep_instrumental: bool,
    keep_vocals: bool,
    use_cuda: bool,
    preview_seconds: Option<f32>,
    progress: &dyn Fn(f32) -> bool,
    stage: &dyn Fn(&str, f32),
) -> Result<PipelineOutput, String> {
    run_separation_as(
        &slot_name(),
        label,
        input,
        out_dir,
        mode,
        kind,
        keep_instrumental,
        keep_vocals,
        use_cuda,
        preview_seconds,
        progress,
        stage,
    )
}

/// نفس `run_separation` باسم فتحة صريح — للاختبار: كل اختبار باسمه الفريد فلا
/// يتنازع مع تطبيق المالك العامل، ولا ينتظر فتحات محجوزة في الجهاز.
fn run_separation_as(
    slot_name: &str,
    label: &str,
    input: &Path,
    out_dir: &Path,
    mode: Mode,
    kind: OutKind,
    keep_instrumental: bool,
    keep_vocals: bool,
    use_cuda: bool,
    preview_seconds: Option<f32>,
    progress: &dyn Fn(f32) -> bool,
    stage: &dyn Fn(&str, f32),
) -> Result<PipelineOutput, String> {
    run_registered(slot_name, label, Some(&input.to_string_lossy()), |token| {
        pipeline::process_file(
            input,
            out_dir,
            mode,
            kind,
            keep_instrumental,
            keep_vocals,
            use_cuda,
            preview_seconds,
            token,
            progress,
            stage,
        )
        .map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::atomic::AtomicBool;

    /// **إثبات التملّك قبل الحكم، دائماً**: كائن النواة قد لا يكون موجوداً بعد
    /// (وإن كان الاسم فريداً)، فننتظر ظهور العلامة في ملف السجلّ بمهلة صريحة —
    /// وإلا كان الحكم على قياس لم يقع.
    fn wait_for_marker(log: &Path, marker: &str, timeout: Duration) -> String {
        let started = std::time::Instant::now();
        loop {
            let raw = std::fs::read_to_string(log).unwrap_or_default();
            if raw.contains(marker) {
                return raw;
            }
            assert!(
                started.elapsed() < timeout,
                "لم تظهر العلامة «{marker}» خلال {timeout:?} — القياس باطل. المحتوى:\n{raw}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(windows)]
    fn win_terminate_process(pid: u32) -> std::io::Result<()> {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error());
            }
            let ok = TerminateProcess(handle, 1);
            let err = std::io::Error::last_os_error();
            CloseHandle(handle);
            if ok == 0 {
                Err(err)
            } else {
                Ok(())
            }
        }
    }

    /// يكتسب على **خيط آخر** ويعيد `(هل نجح, الخطأ نصّاً, الزمن المنقضي)`
    /// **بلا الحارس**: الحارس `!Send` عن قصد (ملكيّة الـmutex للخيط)، فلا يعبر
    /// الخيوط — وهو ضمان **عند التصريف** يمنع تحريراً من خيط غير مالكه.
    /// فيُقاس الزمن داخله ويُعاد ما يكفي للحكم.
    fn acquire_measured_on_thread(
        name: &str,
        limit: u32,
        timeout: Duration,
    ) -> (bool, String, Duration) {
        let n = name.to_string();
        std::thread::spawn(move || {
            let t = std::time::Instant::now();
            let r = acquire_named(&n, limit, timeout);
            let waited = t.elapsed();
            match r {
                Ok(_guard) => (true, String::new(), waited), // الحارس يُسقط هنا
                Err(e) => (false, e, waited),
            }
        })
        .join()
        .expect("لا ذعر في خيط الاكتساب")
    }

    /// يكتسب على خيط آخر **ويُبقي** الحارس حيّاً `hold` مدّة، ثم يُسقطه.
    /// (يُستعمل لترتيب حكم «منتقص ⇒ مهلة» ثم «بعد التحرير ⇒ فوراً».)
    fn acquire_held_on_thread(
        name: &str,
        limit: u32,
        hold: Duration,
    ) -> std::thread::JoinHandle<bool> {
        let n = name.to_string();
        std::thread::spawn(move || {
            match acquire_named(&n, limit, Duration::from_secs(10)) {
                Ok(_guard) => {
                    std::thread::sleep(hold);
                    true // الحارس يُسقط عند خروج الخيط
                }
                Err(_) => false,
            }
        })
    }

    /// **فتحة فورية واحدة** — محاولة بمهلة **صفر** على **خيط نقيّ** جديد.
    ///
    /// **ولماذا محاولة واحدة لكل خيط، ولماذا خيط جديد أصلاً** (وهذا مقيس لا
    /// مفترض): حارس السقف الكامل يردّ طلب **الرمز الثاني** من الخيط الذي يحمل
    /// رمزاً **تراكبياً** (`kernel::acquire`: فرع `tokens < TOKENS`)، فخيط
    /// يحمل `-a` **لا يستطيع** أن يأخذ `-b` — أي أن أي خيط يقتصر على فتحة
    /// واحدة، فمحاولتان على خيط واحد تعطيان «1» **أبداً** لا ميزانية. وهذا
    /// بالضبط ما أسقط أول كتابتين لهذا الحارس على الشيفرة السليمة، فالقاعدة
    /// الآن: **كل محاولة على خيطها**، والنتيجة تُقرأ من عدّ المحاولات.
    fn take_slot_once(name: &str) -> Result<SlotGuard, String> {
        acquire_named(name, MAX_LIMIT, Duration::ZERO)
    }

    /// يقيس الميزانية **بالعدّ لا بالاستنتاج** — و**بالتزامن لا بالتتابع**:
    /// `MAX_LIMIT + 1` محاولة فورية (مهلة صفر)، كلٌّ على **خيطها**، وكل خيط
    /// يُبقي رمزه محجوزاً حتى يُطلَق **بعلم واحد** بعد جمع كل الرسائل. فطول
    /// النجاحات هو عدد الفتحات المتاحة **في اللحظة نفسها**.
    ///
    /// **وبيان لماذا لا تكفي محاولات متتابعة على خيط واحد يُحرَّر بعده**
    /// (وهي أول صيغة كُتبت هنا وسقطت على الشيفرة السليمة): لو حرّر كل خيط رمزه
    /// قبل الخيط التالي لصار القياس على **تعاقب** لا على **تزامن** — وثلاث
    /// نجاحات تُقرأ على ميزانية فتحتين (قِيس: `[true, true, true]`)، وهو باطل.
    ///
    /// **والإطلاق بعلم لا بحاجز**: صيغة سابقة استعملت `Barrier` فعلق الاختبار
    /// (قِيس: عُلّق أكثر من 20 ثانية فأُوقف). والسبب بنيوي: خيط **الفشل**
    /// يخرج من غير أن يبلغ الحاجز، وفي حالة «الميزانية صفر» تفشل **كل** الخيوط
    /// والعدّ يتوقّف عند أولها ⇒ من بقي على الحاجز لا يكتمل عدده أبداً. فالعلم
    /// لا يتطلّب عدداً متساوياً: من نجح ينتظر العلم، ومن فشل يخرج فوراً.
    ///
    /// والقيمة المُعادة: سلسلة `true` تتلوها `false` واحدة (محاولة الفشل التي
    /// أوقفت العدّ) — فميزانية حرّة تماماً = `[true, true, false]`، وفتحة
    /// واحدة = `[true, false]`، ولا شيء = `[false]`.
    fn measure_budget(name: &str) -> (Vec<bool>, String) {
        const ATTEMPTS: usize = MAX_LIMIT as usize + 1;
        /// انتظار الخيط الناجح إطلاقَ العلم (قصير: القياس كله أسرع منه).
        const HOLD_LIMIT: Duration = Duration::from_secs(5);
        let release = Arc::new(AtomicBool::new(false));
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let mut workers = Vec::with_capacity(ATTEMPTS);
        for _ in 0..ATTEMPTS {
            let n = name.to_string();
            let release = release.clone();
            let tx = tx.clone();
            workers.push(std::thread::spawn(move || match take_slot_once(&n) {
                Ok(_guard) => {
                    let _ = tx.send(Ok(()));
                    // الرمز **يبقى محجوزاً** حتى يُقاس الباقي (وهذا هو الفرق
                    // بين قياس التزامن وقياس التعاقب).
                    let deadline = std::time::Instant::now() + HOLD_LIMIT;
                    while !release.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e));
                }
            }));
        }
        drop(tx);
        let mut got = Vec::new();
        let mut failure = String::new();
        // **الترتيب غير مضمون، فالحكم لا يُبنى على أول رسالة**: كل خيط يكتسب
        // لحظةَ يكتسب ويُرسل فوراً، فخيط فشل (مهلة صفر = استطلاع) قد يُرسل
        // **فشله قبل نجاح غيره**. وقد قِيس هذا فعلاً: ميزانية **حرّة تماماً**
        // أُعلنت `[false]` لأن رسالة الفشل وصلت أولاً — فالقاعدة: **تُجمع
        // ATTEMPTS رسالةً بالضبط** (كل خيط يُرسل واحدة قبل أن يتوقّف على العلم)
        // ثم يُقرأ العدّ، ولا يُحكم على أول رسالة.
        // (و`rx.iter()` لا يصلح هنا: القناة لا تُغلق إلا بزوال **كل** المرسِلين،
        // وخيوط النجاح ما زالت حيّة تنتظر العلم وفي يدها نُسخها من المرسِل.)
        //
        // **ولا تُهمَل الرسالة الأولى**: صيغة سابقة كتبت `if let Ok(Err(e))`
        // فأضاعت نجاحاً وصل أولاً، فقُرئ عدّان على أنهما واحد (قِيس:
        // `[true, false]` على ميزانية كاملة) — وهذا ثالث عطل قياس أُصلح هنا.
        for _ in 0..ATTEMPTS {
            match rx.recv() {
                Ok(Ok(())) => got.push(true),
                Ok(Err(e)) => {
                    if failure.is_empty() {
                        failure = e;
                    }
                }
                Err(_) => break,
            }
        }
        got.push(failure.is_empty()); // محاولة العدّ الأخيرة: نجاح إن لم يقع فشل
        release.store(true, Ordering::SeqCst);
        // **والانتظار حتى موت كل محاولة**: لو رجع القياس ورموزُ محاولاته ما
        // زالت حيّة لصار القياس التالي على ميزانية منتقصة بسبب قياس سابق —
        // وهو **بالضبط** ما أسقط القسم (٢) أول تشغيل (قِيس: الميزانية صفر
        // وخيطُ قياس سابق نائم على رمزه).
        for w in workers {
            let _ = w.join();
        }
        (got, failure)
    }

    /// يقيس الميزانية على خيط واحد ثم **يُطلقه**: تبويب المحاولات على خيوط
    /// متتابعة يفصل زمن كل قياس عن الذي بعده (وإلا بقي رمز القياس محجوزاً
    /// فصار القياس التالي على ميزانية منتقصة).
    fn measure_budget_on_clean_thread(name: &str) -> std::thread::JoinHandle<(Vec<bool>, String)> {
        let n = name.to_string();
        std::thread::spawn(move || measure_budget(&n))
    }
    /// حكم على الميزانية المتاحة، **من خيط نظيف**، بسلسلة النجاح/الفشل
    /// المتوقَّعة (`expected` تنتهي بـ`false`: محاولة العدّ الأخيرة).
    fn assert_budget(name: &str, expected: &[bool], what: &str) {
        let (got, why) = measure_budget_on_clean_thread(name)
            .join()
            .expect("لا ذعر في خيط القياس");
        assert_eq!(
            got,
            expected.to_vec(),
            "{what}: المتوقَّع {expected:?} والمقيس {got:?} (الفشل: {why:?})"
        );
        if got.last() == Some(&false) {
            assert!(
                why.contains("انتهت مهلة انتظار فتحة الفصل"),
                "{what}: العدّ توقّف بسبب غير مقيس (يجب أن يكون **مهلة** على فتحة \
                 محجوزة، لا رفضاً تراكبياً) — الفشل: {why:?}"
            );
        }
    }

    /// حارس يحجز فتحة (سقف `limit`) على **خيط آخر** ويُبقيها حتى يُطلَق،
    /// **بلا نوم تخميني**: الخيط يُعلم عبر قناة **بعد** الاكتساب الفعلي،
    /// فالحكم يقع على زوج محجوز فعلاً لا على «مصادفة جدولة» (كان `sleep`).
    ///
    /// والإطلاق **حاجز** لا نوم: الخيط ينتظر `release.wait()`، فالاختبار يقرّر
    /// متى يتحرّر الرمز ولا يترك خيطاً نائماً بعد انتهائه. وإذا لم يكتسب
    /// الخيط (أو ذعر) **لا يصل الإشعار** فيفشل `recv()` بدل أن يمرّ صامتاً.
    fn acquire_holding_on_thread(
        name: &str,
        limit: u32,
    ) -> (std::sync::mpsc::Receiver<()>, Arc<std::sync::Barrier>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let release = Arc::new(std::sync::Barrier::new(2));
        let thread_release = release.clone();
        let n = name.to_string();
        std::thread::spawn(
            move || match acquire_named(&n, limit, Duration::from_secs(10)) {
                Ok(_guard) => {
                    let _ = tx.send(());
                    thread_release.wait();
                }
                Err(e) => panic!("خيط الحجز لم يكتسب: {e}"),
            },
        );
        (rx, release)
    }

    /// اسم فريد لكل اختبار: لا تنازع مع تطبيق المالك ولا مع اختبار آخر.
    fn unique_name(tag: &str) -> String {
        format!(
            r"Global\HaramLite-Test-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        )
    }

    /// مجلد عمل فريد لكل **تشغيل** (لا لكل مهمّة فقط).
    ///
    /// **ولماذا عدّاد لا `pid` وحده**: `tmp_dir` كان يبني الاسم من `pid`+الوسم
    /// وحدهما، وويندوز **يعيد استعمال المعرّفات** — فتشغيل ثانٍ في العملية نفسها
    /// (أو معرّف أُعيد) يجد مجلداً من تشغيل سابق. وقد **وقع هذا فعلاً** في هذه
    /// الجولة: اختبار «الرمز يعود عند قتل المالك» قرأ ملف تتبّع **قديماً** فيه
    /// `HOLDING OK` من تشغيل سابق، فمرّ في 0.03 ث **دون أن يعمل الحاجز أصلاً**
    /// (وكاد يُثبت نجاحاً كاذباً). فالاسم يحمل الآن **عدّاداً ذرّياً** لا يتكرّر
    /// في العملية، ويُتحقَّق قبله أن المجلد **جديد فعلاً**.
    fn tmp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("hl_slots_{}_{}_{}", std::process::id(), tag, n));
        // حارس ضدّ إعادة الاستعمال: مجلد موجود مسبقاً = قياس على أثر قديم.
        if d.exists() {
            let _ = std::fs::remove_dir_all(&d);
        }
        std::fs::create_dir_all(&d).unwrap();
        assert!(
            std::fs::read_dir(&d)
                .map(|mut i| i.next().is_none())
                .unwrap_or(false),
            "مجلد العمل يجب أن يكون فارغاً: {}",
            d.display()
        );
        d
    }

    /// يتحقّق أن ملف التتبّع **لم يكن موجوداً** قبل التشغيل — فلا يُقرأ أثر قديم.
    fn assert_no_stale_log(log: &Path) {
        assert!(
            !log.exists(),
            "ملف تتبّع قديم موجود قبل التشغيل ({} بايت): القياس سيكون على أثر سابق",
            std::fs::metadata(log).map(|m| m.len()).unwrap_or(0)
        );
    }

    /// أقصى تداخل من أزواج (طابع زمني, +1 بداية/−1 نهاية).
    ///
    /// عند تساوي الطابع: **النهاية قبل البداية** — نهاية في اللحظة نفسها
    /// ليست تداخلاً، وإلا عُدّ التسليم المتعاقب تزامناً كاذباً.
    fn max_overlap(events: &[(u128, i32)]) -> usize {
        let mut ev = events.to_vec();
        ev.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let (mut cur, mut peak) = (0i32, 0i32);
        for (_, delta) in ev {
            cur += delta;
            peak = peak.max(cur);
        }
        peak.max(0) as usize
    }

    /// الاختبارات التي تلمس السِجلّ العامّ تتسلسل: السِجلّ **واحد للعملية**،
    /// فلو تشابه اختباران لصار القياس تابعاً لترتيب الخيوط لا للسلوك.
    fn registry_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ── القيمة والاسم (دوالّ نقية) ─────────────────────────────────────

    // ── عقد الالتحام مع الواجهة (م٢) ─────────────────────────────────

    /// **عقد الالتحام (م٢)**: الواجهة تُطابق عنصر الطابور بالمهمّة عبر `path`
    /// (`src/jobs.ts`)، فإن لم يُملأ المسار لم يجد الزرّ مهمّته فقال «لا مهمّة
    /// خلفية» — صادق لكنه غير مفيد. وهذا الاختبار يثبّت أن المسار **يُسجَّل
    /// فعلاً** عبر المسار الإنتاجي نفسه (`run_registered_with` الذي يناديه
    /// `run_separation`)، وأن وسم مهمّة الواجهة يبقى `"gui"` (الواجهة تقارنه
    /// نصّاً: `String(job.label).toLowerCase() === 'gui'`).
    ///
    /// (أُضيف عند الدمج لأن العاملَين أشارا إليه كنقطة التحام ولم يثبّتها
    /// أحدٌ منهما: عامل الواجهة لا يملك Rust، وعامل النواة لا يملك الواجهة.)
    #[test]
    fn a_running_job_exposes_its_input_path_and_the_gui_label() {
        let _lock = registry_lock();
        let name = unique_name("ui-contract");
        let input = r"C:\in\song with space.mp3";
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let n = name.clone();
        let t = std::thread::spawn(move || {
            run_registered_with(&n, "gui", Some(input), MAX_LIMIT, |_tok| {
                let _ = tx.send(());
                std::thread::sleep(Duration::from_millis(300));
                Ok(())
            })
            .expect("المهمّة أُخذت فتحة");
        });
        rx.recv_timeout(Duration::from_secs(5))
            .expect("المهمّة بدأت خلال المهلة");
        let jobs = active_jobs();
        let me = jobs
            .iter()
            .find(|j| j.path.as_deref() == Some(input))
            .expect("مهمّة بمسار الإدخال مسجّلة في السِجلّ");
        assert_eq!(me.label, "gui", "وسم مهمّة الواجهة يبقى gui نصّاً");
        assert!(!me.cancelled, "ولا تكون ملغاة قبل أي طلب إلغاء");
        assert!(me.started_ms > 0, "وطابع البدء مسجَّل");
        t.join().expect("لا ذعر في خيط المهمّة");
        assert!(
            active_jobs()
                .iter()
                .all(|j| j.path.as_deref() != Some(input)),
            "وتُزال من السِجلّ بعد الانتهاء (فلا صفوف عالقة في الطابور)"
        );
    }

    #[test]
    fn the_limit_is_clamped_to_the_card_ceiling() {
        // `current_limit()` حالة عامّة للعملية: القفل يمنع أن يقرأها هذا
        // الاختبار في اللحظة التي يغيّرها فيها اختبار آخر (ب٣ يقيس تغييرها حيّاً).
        let _lock = registry_lock();
        assert_eq!(clamp_limit(1), 1, "الحدّ الأدنى المسموح");
        assert_eq!(clamp_limit(2), MAX_LIMIT, "السقف المسموح");
        assert_eq!(clamp_limit(0), 1, "الصفر يُرفع إلى 1 لا يُترك انتظاراً أبدياً");
        assert_eq!(clamp_limit(9), MAX_LIMIT, "ما خرج يُقصّ إلى السقف");
        assert_eq!(current_limit(), DEFAULT_LIMIT, "بلا إعداد: الافتراضي");
    }

    #[test]
    fn the_default_name_is_the_global_one_and_the_env_overrides_it() {
        // لا يضبط أي اختبار هذا المتغيّر (ولا يلمس البيئة أصلاً) فالقراءة آمنة.
        match std::env::var(ENV_NAME) {
            Ok(v) if !v.trim().is_empty() => assert_eq!(slot_name(), v),
            _ => assert_eq!(slot_name(), DEFAULT_NAME),
        }
        assert!(DEFAULT_NAME.starts_with(r"Global\"), "النطاق يعبر العمليات");
        assert_eq!(
            session_local(DEFAULT_NAME).as_deref(),
            Some("HaramLite-Separation-Slots"),
            "بديل الجلسة يسقط البادئة وحدها"
        );
        assert_eq!(session_local("HaramLite-No-Prefix"), None);
        assert_eq!(session_local(r"Global\"), None, "اسم فارغ ليس بديلاً");
    }

    // ── داخل العملية: 3 خيوط والسقف 2 ⇒ أقصى تزامن مقيس = 2 ─────────────

    const HOLD_MS: u64 = 400;

    #[test]
    fn three_threads_never_exceed_the_cap() {
        let _lock = registry_lock();
        // هذا الاختبار يقيس **السقف** لا الافتراضيّ: بعد قرار المالك صار
        // الافتراضيّ 1 (وله اختبار سلوكيّ مستقلّ أدناه)، فهنا يُرفع السقف
        // صراحةً إلى `MAX_LIMIT` بالمسار الذي تسلكه الإعدادات (`set_limit`)،
        // ويُعاد إلى أصله قبل انتهاء القفل.
        set_limit(MAX_LIMIT);
        let name = unique_name("inproc");
        let events: Arc<Mutex<Vec<(u128, i32)>>> = Arc::new(Mutex::new(Vec::new()));
        let mut threads = Vec::new();
        for _ in 0..3 {
            let name = name.clone();
            let events = events.clone();
            threads.push(std::thread::spawn(move || {
                run_registered(&name, "inproc", None, |_| {
                    events.lock().unwrap().push((now_ms(), 1));
                    std::thread::sleep(Duration::from_millis(HOLD_MS));
                    events.lock().unwrap().push((now_ms(), -1));
                    Ok(())
                })
                .expect("فتحة متاحة خلال المهلة");
            }));
        }
        for t in threads {
            t.join().expect("لا ذعر في الخيوط");
        }

        set_limit(DEFAULT_LIMIT); // الإعداد العامّ يعود إلى أصله قبل أي حكم
        let events = events.lock().unwrap().clone();
        assert_eq!(events.len(), 6, "ثلاث بدايات وثلاث نهايات");
        let peak = max_overlap(&events);
        // يُطبع دائماً كي يراه من يُشغّل `--nocapture`، وليبقى القياس قابلاً
        // لإعادة الإنتاج لا مجرّد كلمة «نجح».
        eprintln!(
            "م١/داخل العملية: أقصى تزامن مُقاس = {peak} (السقف {}) — الأحداث: {events:?}",
            current_limit()
        );
        assert_eq!(
            peak, MAX_LIMIT as usize,
            "أقصى تزامن مُقاس يجب أن يساوي السقف ({MAX_LIMIT})، وقياسه {peak} — الأحداث: {events:?}"
        );
    }

    /// **ب٣ — الإعداد حيّ**: يُطبَّق على المهامّ **الجديدة** بلا إعادة تشغيل،
    /// ولا يقاطع الجارية. **والمسار المُقاس هو الإنتاجيّ** (`run_registered`
    /// الذي يقرأ `current_limit()`)، لا سقف صريح.
    ///
    /// **ولماذا لا يكفي أن يُضبط الإعداد على 1**: بعد قرار المالك صار
    /// `DEFAULT_LIMIT = 1` أيضاً، فصار «قرأ الإعداد الحيّ» و«قرأ ثابت التصريف»
    /// **غير قابلين للتفريق** — ومُفسَد المدقّق (‏`run_registered` يقرأ
    /// `DEFAULT_LIMIT` بدل `current_limit()`) **لم يُسقط الاختبار** السابق.
    /// فالضبط هنا **بعيد عن الافتراضيّ**: حاصرٌ يمسك **رمزاً واحداً** (بسقف
    /// `MAX_LIMIT` = 2)، ثم `set_limit(MAX_LIMIT)`، ثم مهمّة عبر `run_registered`
    /// يجب أن **تنطلق فوراً** وتتقاطع مع الحاصر. ومُفسَد M3 يقرأ 1 ⇒ ينتظر
    /// الرمزين ⇒ لا تتقاطع الفترتان ⇒ سقوط مؤكَّد.
    ///
    /// **وحدّ المهلة (T-8)**: المُفسَد ينتظر `DEFAULT_WAIT` (30 دقيقة)، فلا
    /// يُنتَظر انتهاؤه: الحكم يتوقّف عند **مهلة قصيرة معلنة** (20 ث) ويفشل
    /// بسببها. فالسقوط **فشل سريع محدود** لا تعليق.
    ///
    /// (`set_limit` حالة عامّة للعملية، والاختبار يعيدها إلى أصلها **قبل** أي
    /// حكم — وكل اختبار يقرأ `current_limit()` يأخذ `registry_lock` نفسه.)
    #[test]
    fn a_new_setting_applies_to_new_jobs_without_interrupting_running_ones() {
        let _lock = registry_lock();
        let name = unique_name("live-limit");
        let events: Arc<Mutex<Vec<TracedEvent>>> = Arc::new(Mutex::new(Vec::new()));

        // الجارية: سقف السقف الكامل ⇒ **رمز واحد** (لا الرمزان)، وتبقى حيّة.
        // `run_registered_with` هنا مقصود: الحاصر يجب أن يمسك رمزاً واحداً
        // (ولو استعمل `run_registered` لأخذ الرمزين قبل أن يُغيَّر الإعداد).
        let holder = {
            let name = name.clone();
            let events = events.clone();
            std::thread::spawn(move || {
                run_registered_with(&name, "holder", None, MAX_LIMIT, |_| {
                    events.lock().unwrap().push((0, now_ms(), 1));
                    std::thread::sleep(Duration::from_millis(HOLD_MS));
                    events.lock().unwrap().push((0, now_ms(), -1));
                    Ok(())
                })
                .expect("الجارية أخذت رمزاً");
            })
        };
        // لا يُقاس الترتيب على مصادفة جدولة: ننتظر حتى تحمل الجارية رمزها فعلاً.
        let started = std::time::Instant::now();
        while events.lock().unwrap().is_empty() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "الجارية لم تبدأ"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        // الإعداد يتغيّر **والجارية تعمل** — بلا إعادة تشغيل أي شيء. والقيمة
        // **بعيدة عن الافتراضيّ** (2 مقابل 1) فلا يُخلَط الإعداد بالثابت.
        set_limit(MAX_LIMIT);
        assert_eq!(current_limit(), MAX_LIMIT, "الإعداد الحيّ انضبط");

        // مهمّة جديدة **بالمسار الإنتاجيّ**: تقرأ السقف لحظة الطلب ⇒ 2 ⇒ تحتاج
        // **رمزاً واحداً** فقط، والثاني حرّ ⇒ تنطلق فوراً وتتقاطع مع الجارية.
        let newcomer = {
            let name = name.clone();
            let events = events.clone();
            std::thread::spawn(move || {
                run_registered(&name, "newcomer", None, |_| {
                    events.lock().unwrap().push((1, now_ms(), 1));
                    std::thread::sleep(Duration::from_millis(HOLD_MS));
                    events.lock().unwrap().push((1, now_ms(), -1));
                    Ok(())
                })
                .expect("الجديدة أخذت الرمز الثاني");
            })
        };

        // حدّ المهلة: لا ننتظر `DEFAULT_WAIT` (30 دقيقة) في حالة المُفسَد.
        // والانتظار على **نهاية الجديدة** (حدث `-1` بمعرّفها)، لا على `spans()`
        // وهي تشترط اكتمال كل فترة (فالجارية ما زالت مفتوحة هنا).
        let deadline = started + Duration::from_millis(HOLD_MS) + Duration::from_secs(20);
        while !events
            .lock()
            .unwrap()
            .iter()
            .any(|(id, _, d)| *id == 1 && *d < 0)
        {
            assert!(
                std::time::Instant::now() < deadline,
                "الجديدة لم تنتهِ خلال {deadline:?} — أو أنها **انتظرت** الجارية \
                 (وهو ما يفعله مُفسَد M3: يقرأ الافتراضيّ 1 فيطلب الرمزين). \
                 الأحداث حتى الآن: {:?}",
                events.lock().unwrap()
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        holder.join().expect("لا ذعر في الجارية");
        newcomer.join().expect("لا ذعر في الجديدة");
        set_limit(DEFAULT_LIMIT); // الإعداد العامّ يعود إلى أصله قبل أي حكم

        let events = events.lock().unwrap().clone();
        let spans = spans(&events);
        assert_eq!(spans.len(), 2, "فترتان (جارية وجديدة): {spans:?}");
        let h = spans.iter().find(|(id, _, _)| *id == 0).expect("الجارية");
        let n = spans.iter().find(|(id, _, _)| *id == 1).expect("الجديدة");
        assert!(
            overlap_ms((h.1, h.2), (n.1, n.2)) >= (HOLD_MS - 100) as u128,
            "الجديدة يجب أن تتقاطع مع الجارية في معظم مدّتها (سقف 2 = رمز لكلٍّ) — \
             ولا تتقاطع إلا إذا انتظرت الجارية، وهذا مُفسَد M3: {spans:?}"
        );
        assert!(
            h.2 - h.1 >= (HOLD_MS - 20) as u128,
            "الجارية أكملت مدّتها كاملة (لم تُقاطَع): {spans:?}"
        );
        eprintln!(
            "ب٣/سقف حيّ: الجارية {h:?} والجديدة {n:?} — تقاطع {}ms بلا مقاطعة",
            overlap_ms((h.1, h.2), (n.1, n.2))
        );
    }

    // ── عبر العمليات: 3 عمليات مساعدة ⇒ أقصى تداخل مقيس = 2 ─────────────

    const HELPER_MODE: &str = "HARAMLITE_SLOT_HELPER";
    const HELPER_SLOT: &str = "HARAMLITE_SLOT_HELPER_SLOT";
    const HELPER_LOG: &str = "HARAMLITE_SLOT_HELPER_LOG";
    const HELPER_READY: &str = "HARAMLITE_SLOT_HELPER_READY";
    const HELPER_ID: &str = "HARAMLITE_SLOT_HELPER_ID";
    /// سقف المساعد (اختياري: الافتراضي `DEFAULT_LIMIT`) — لقياس خليط الإعدادات.
    const HELPER_LIMIT: &str = "HARAMLITE_SLOT_HELPER_LIMIT";
    /// تأخير المساعد بعد الحاجز بالملّي ثانية (اختياري: 0) — يُرتَّب به الطلب
    /// فيُقاس «الحصرية لا تتقاطع» بضابط موجب في اللحظة نفسها.
    const HELPER_DELAY_MS: &str = "HARAMLITE_SLOT_HELPER_DELAY_MS";
    const HELPERS: usize = 3;

    // ── أدوات قياس التقاطع (تُستعمل داخل العملية وعبرها) ────────────────

    /// حدث تتبّع موسوم بمعرّف المهمّة: `(المعرّف, الطابع الزمني, +1 بداية/−1 نهاية)`.
    type TracedEvent = (usize, u128, i32);

    /// يقرأ سطور التتبّع `{id} START|END {ts}` إلى أحداث موسومة.
    fn parse_trace(raw: &str) -> Vec<TracedEvent> {
        let mut out = Vec::new();
        for line in raw.lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            assert_eq!(f.len(), 3, "سطر تتبّع غير سليم (تداخل كتابة؟): {line:?}");
            let id: usize = f[0]
                .parse()
                .unwrap_or_else(|_| panic!("معرّف غير رقمي: {line:?}"));
            let ts: u128 = f[2]
                .parse()
                .unwrap_or_else(|_| panic!("طابع غير رقمي: {line:?}"));
            match f[1] {
                "START" => out.push((id, ts, 1)),
                "END" => out.push((id, ts, -1)),
                other => panic!("حدث غير معروف {other:?} في {line:?}"),
            }
        }
        out
    }

    /// الأحداث بلا وسوم — لقياس الذروة بـ`max_overlap`.
    fn deltas(events: &[TracedEvent]) -> Vec<(u128, i32)> {
        events.iter().map(|(_, ts, d)| (*ts, *d)).collect()
    }

    /// فترات المهامّ: `(المعرّف, البداية, النهاية)`. وبداية بلا نهاية (أو
    /// العكس) تُسقط الاختبار: سطر ناقص لا يُقرأ فترةً صفرية تمرّ صامتة.
    fn spans(events: &[TracedEvent]) -> Vec<(usize, u128, u128)> {
        let mut starts: Vec<(usize, u128)> = Vec::new();
        let mut out = Vec::new();
        for (id, ts, d) in events {
            if *d > 0 {
                starts.push((*id, *ts));
            } else {
                let pos = starts
                    .iter()
                    .position(|(sid, _)| sid == id)
                    .unwrap_or_else(|| panic!("نهاية بلا بداية للمهمّة {id}"));
                let (_, start) = starts.remove(pos);
                out.push((*id, start, *ts));
            }
        }
        assert!(starts.is_empty(), "بدايات بلا نهايات: {starts:?}");
        out
    }

    /// تداخل فترتين بالملّي ثانية — و**النهاية قبل البداية** عند تساوي الطابع
    /// (اتفاقية `max_overlap` نفسها: تسليم في اللحظة نفسها ليس تداخلاً).
    fn overlap_ms(a: (u128, u128), b: (u128, u128)) -> u128 {
        a.1.min(b.1).saturating_sub(a.0.max(b.0))
    }

    /// يحكم على قياس واحد بثلاثة شروط معاً:
    ///   • **ب١**: الذروة لا تتجاوز `MAX_LIMIT`.
    ///   • **ب٢**: كل مهمّة بسقف 1 **لا تتقاطع** مع أي مهمّة أخرى.
    ///   • **ضابط موجب**: مهمّتا السقف `MAX_LIMIT` تتقاطعان فعلاً (ذروة =
    ///     `MAX_LIMIT`) — وإلا كان «لا تقاطع» نتيجة أداة عمياء لا نتيجة محدِّد.
    ///     وإن كانت الخطة حصرية كلها فالمتوقَّع ذروة = 1 (تسلسل تامّ).
    fn assert_peak_and_exclusivity(events: &[TracedEvent], plan: &[(u32, u64)], where_: &str) {
        let spans = spans(events);
        assert_eq!(
            spans.len(),
            plan.len(),
            "{where_}: فترة لكل مهمّة — الفترات: {spans:?}"
        );
        let peak = max_overlap(&deltas(events));
        eprintln!("ت٣/{where_}: أقصى تزامن مُقاس = {peak} (السقف {MAX_LIMIT}) — الفترات: {spans:?}");
        assert!(
            peak <= MAX_LIMIT as usize,
            "{where_}: الذروة {peak} تجاوزت السقف {MAX_LIMIT} — الفترات: {spans:?}"
        );

        let exclusive: Vec<usize> = plan
            .iter()
            .enumerate()
            .filter(|(_, (l, _))| *l == 1)
            .map(|(i, _)| i)
            .collect();
        assert!(
            !exclusive.is_empty(),
            "{where_}: الخطة بلا مهمّة بسقف 1 — القياس بلا موضوع"
        );
        for id in &exclusive {
            let a = spans
                .iter()
                .find(|(sid, _, _)| sid == id)
                .unwrap_or_else(|| panic!("{where_}: فترة الحصرية #{id} غائبة"));
            for (oid, s, e) in &spans {
                if oid == id {
                    continue;
                }
                assert_eq!(
                    overlap_ms((a.1, a.2), (*s, *e)),
                    0,
                    "{where_}: المهمّة بسقف 1 #{id} تقاطعت مع #{oid} — الفترات: {spans:?}"
                );
            }
        }

        let wide = plan.iter().filter(|(l, _)| *l == MAX_LIMIT).count();
        let expect = if wide >= 2 { MAX_LIMIT as usize } else { 1 };
        assert_eq!(
            peak, expect,
            "{where_}: الذروة المتوقَّعة {expect} وقياسها {peak} — الفترات: {spans:?}"
        );
    }

    /// يكتب سطراً كاملاً بنداء كتابة واحد على الملف المشترك.
    fn append_line(path: &Path, line: &str) {
        use std::io::Write;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path);
        match file {
            Ok(mut f) => {
                if let Err(e) = f.write_all(line.as_bytes()) {
                    eprintln!("helper: تعذر الكتابة في ملف التتبّع: {e}");
                }
            }
            Err(e) => eprintln!("helper: تعذر فتح ملف التتبّع: {e}"),
        }
    }

    /// **عملية مساعدة** (ليست اختباراً في الوضع العادي): تنتظر الحاجز ثم تأخذ
    /// فتحة بسقفها وتكتب بدايتها ونهايتها بطابع زمني في ملف مشترك.
    ///
    /// تُشغَّل بـ`current_exe` مع `HARAMLITE_SLOT_HELPER=1` من الاختبارات
    /// التالية؛ وفي تشغيل `cargo test` العادي تعود فوراً بلا عمل.
    ///
    /// `HARAMLITE_SLOT_HELPER_LIMIT` (سقف المهمّة) و`HARAMLITE_SLOT_HELPER_DELAY_MS`
    /// (تأخير بعد الحاجز) اختياريان: بلا ضبطهما يتصرّف المساعد كما كان.
    #[test]
    fn slot_helper_process() {
        if std::env::var(HELPER_MODE).is_err() {
            return; // لسنا في وضع المساعد
        }
        let slot = std::env::var(HELPER_SLOT).expect("اسم الفتحة");
        let log = PathBuf::from(std::env::var(HELPER_LOG).expect("ملف التتبّع"));
        let ready = PathBuf::from(std::env::var(HELPER_READY).expect("مجلد الحاجز"));
        let id = std::env::var(HELPER_ID).expect("معرّف المساعد");
        let limit: u32 = std::env::var(HELPER_LIMIT)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_LIMIT);
        let delay_ms: u64 = std::env::var(HELPER_DELAY_MS)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        // حاجز: كل المساعدين يبدأون الطلب في اللحظة نفسها تقريباً، وإلا كان
        // «عدم التداخل» أثراً من تباعد الإقلاع لا من المحدِّد.
        std::fs::write(ready.join(format!("h{id}")), b"1").expect("ملف الحاجز");
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while std::fs::read_dir(&ready).map(|d| d.count()).unwrap_or(0) < HELPERS {
            assert!(
                std::time::Instant::now() < deadline,
                "انتهت مهلة الحاجز: لم يصل كل المساعدين"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        // التأخير **بعد** الحاجز مقصود: يُرتَّب الطلب فيُقاس في اللحظة نفسها
        // أن مهمّتَي السقف الكامل تتقاطعان وأن الحصرية لا تتقاطع (ضابط موجب).
        std::thread::sleep(Duration::from_millis(delay_ms));

        run_registered_with(&slot, "helper", None, limit, |_| {
            append_line(&log, &format!("{id} START {}\n", now_ms()));
            std::thread::sleep(Duration::from_millis(HOLD_MS));
            append_line(&log, &format!("{id} END {}\n", now_ms()));
            Ok(())
        })
        .expect("المساعد أخذ فتحة خلال المهلة");
    }

    /// يُطلق `HELPERS` عملية مساعدة — **باسم فتحة واحد** للجميع (وهو جوهر
    /// القياس: بأسماء مختلفة لما تنازعوا على زوج رموز واحد) — لكلٍّ سقفها
    /// وتأخيرها، ثم ينتظرها ويعيد نصّ سجلّ التتبّع.
    fn run_three_helpers(tag: &str, plan: [(u32, u64); HELPERS]) -> String {
        let dir = tmp_dir(tag);
        let log = dir.join("trace.log");
        let ready = dir.join("ready");
        std::fs::create_dir_all(&ready).unwrap();
        // **حارس القياس**: سجلّ قديم كان سيُقرأ كأنه تتبّع هذه الجولة.
        assert_no_stale_log(&log);

        let exe = std::env::current_exe().expect("مسار ثنائي الاختبار");
        let slot = unique_name(tag);
        let mut children = Vec::new();
        for (i, (limit, delay)) in plan.iter().enumerate() {
            let child = Command::new(&exe)
                .args([
                    "slots::tests::slot_helper_process",
                    "--exact",
                    "--nocapture",
                ])
                .env(HELPER_MODE, "1")
                .env(HELPER_SLOT, &slot)
                .env(HELPER_LOG, &log)
                .env(HELPER_READY, &ready)
                .env(HELPER_ID, i.to_string())
                .env(HELPER_LIMIT, limit.to_string())
                .env(HELPER_DELAY_MS, delay.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("إطلاق عملية مساعدة");
            children.push(child);
        }
        let mut failed = Vec::new();
        for (i, mut c) in children.into_iter().enumerate() {
            let status = c.wait().expect("انتظار المساعد");
            if !status.success() {
                failed.push(format!("المساعد {i}: {status}"));
            }
        }
        // السجلّ يُقرأ **قبل** الحكم كي يظهر في رسالة الفشل لا أن يضيع.
        let raw = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(
            failed.is_empty(),
            "{} — سجلّ التتبّع:\n{raw}",
            failed.join(" · ")
        );
        let _ = std::fs::remove_dir_all(&dir);
        raw
    }

    #[test]
    fn three_helper_processes_never_overlap_more_than_the_cap() {
        if std::env::var(HELPER_MODE).is_ok() {
            return; // لا نُعيد إطلاق المساعدين من داخل مساعد
        }
        let _lock = registry_lock();
        // السقف الكامل صراحةً للثلاثة (لا الافتراضيّ: صار 1) وبلا تأخير.
        let raw = run_three_helpers("xproc", [(MAX_LIMIT, 0); HELPERS]);
        let events = parse_trace(&raw);
        let (started, ended) = (
            events.iter().filter(|(_, _, d)| *d > 0).count(),
            events.iter().filter(|(_, _, d)| *d < 0).count(),
        );
        // إثبات أن القياس وقع فعلاً: 3 عمليات × (بداية+نهاية).
        assert_eq!(
            (started, ended),
            (HELPERS, HELPERS),
            "سطور التتبّع ناقصة — القياس باطل. المحتوى:\n{raw}"
        );
        let peak = max_overlap(&deltas(&events));
        // الدليل الخام: الطوابع الزمنية الحقيقية من العمليات الثلاث، لا نداء
        // API يقول «حصلت على فتحة».
        eprintln!(
            "م١/عبر العمليات: أقصى تداخل مُقاس = {peak} (السقف {}) — سطور التتبّع:\n{raw}",
            current_limit()
        );
        assert_eq!(
            peak, MAX_LIMIT as usize,
            "أقصى تداخل بين العمليات يجب أن يساوي السقف ({MAX_LIMIT})، وقياسه {peak}. \
             السطور:\n{raw}"
        );
    }

    /// **الافتراضيّ 1** (قرار المالك بعد قياس هامش الفصلين): ثلاث عمليات
    /// **بلا سقف صريح** — أي بالافتراضيّ وحده — تتسلّس كلّها: أقصى تداخل مُقاس
    /// **1** لا 2. وهذا هو مُفسَد القرار: إعادة `DEFAULT_LIMIT` إلى 2 تُسقط هذا
    /// الاختبار (تصير الذروة 2)، فلا يبقى الافتراضيّ رقماً في تعليق بلا ضابط.
    #[test]
    fn the_default_cap_serialises_three_helper_processes() {
        if std::env::var(HELPER_MODE).is_ok() {
            return;
        }
        let _lock = registry_lock();
        assert_eq!(
            current_limit(),
            DEFAULT_LIMIT,
            "بلا أي ضبط: السقف هو الافتراضيّ"
        );
        let raw = run_three_helpers("xdef", [(DEFAULT_LIMIT, 0); HELPERS]);
        let events = parse_trace(&raw);
        let (started, ended) = (
            events.iter().filter(|(_, _, d)| *d > 0).count(),
            events.iter().filter(|(_, _, d)| *d < 0).count(),
        );
        assert_eq!(
            (started, ended),
            (HELPERS, HELPERS),
            "سطور التتبّع ناقصة — القياس باطل. المحتوى:\n{raw}"
        );
        let peak = max_overlap(&deltas(&events));
        eprintln!(
            "م١/الافتراضيّ: أقصى تداخل مُقاس = {peak} (الافتراضيّ {DEFAULT_LIMIT}) — سطور التتبّع:\n{raw}"
        );
        assert_eq!(
            peak, 1,
            "بالافتراضيّ 1 يجب أن تتسلّس العمليات الثلاث (الذروة 1)، وقياسها {peak}. \
             السطور:\n{raw}"
        );
    }

    /// **ت٣ — الخليط**: مهمّتان بسقف 2 ومهمّة بسقف 1 على **ثلاث عمليات**.
    /// والترتيب مقصود: الحصرية أولاً فتأخذ الرمزين، والاثنتان تنتظران ثم تأخذ
    /// كلٌّ رمزاً فتتقاطعان ⇒ يُقاس في اللحظة نفسها أن الحصرية معزولة (ب٢) وأن
    /// الأداة ترى التداخل فعلاً (ضابط موجب)، وأن الذروة لا تتجاوز السقف (ب١).
    #[test]
    fn a_mixed_gang_of_three_processes_respects_the_cap_and_the_exclusive_job() {
        if std::env::var(HELPER_MODE).is_ok() {
            return;
        }
        let _lock = registry_lock();
        let plan = [(1u32, 0u64), (MAX_LIMIT, 100), (MAX_LIMIT, 200)];
        let raw = run_three_helpers("xmix", plan);
        let events = parse_trace(&raw);
        assert_eq!(
            events.len(),
            HELPERS * 2,
            "سطور التتبّع ناقصة — القياس باطل:\n{raw}"
        );
        assert_peak_and_exclusivity(&events, &plan, "عبر العمليات/خليط");
    }

    /// **ب٢ في أنقى صورها**: ثلاثة مساعدين كلّهم بسقف 1 على ثلاث عمليات ⇒
    /// لا تقاطع واحد بين أي فترتين (تسلسل تامّ، ذروة = 1). ويسقط على تصميم
    /// يأخذ للحصرية رمزاً واحداً: حينها يتقاطع اثنان.
    #[test]
    fn three_exclusive_processes_run_strictly_one_at_a_time() {
        if std::env::var(HELPER_MODE).is_ok() {
            return;
        }
        let _lock = registry_lock();
        let plan = [(1u32, 0u64); HELPERS];
        let raw = run_three_helpers("xexcl3", plan);
        let events = parse_trace(&raw);
        assert_eq!(
            events.len(),
            HELPERS * 2,
            "سطور التتبّع ناقصة — القياس باطل:\n{raw}"
        );
        assert_peak_and_exclusivity(&events, &plan, "عبر العمليات/حصرية ثلاثية");
    }

    /// **داخل العملية** بالخطة نفسها: ضابط ثالث للقياس نفسه بلا عمليات —
    /// فإن اختلف سلوك المنصّة الواحدة عن نفسها ظهر الفرق هنا.
    #[test]
    fn a_mixed_plan_in_one_process_respects_the_cap_and_the_exclusive_job() {
        let _lock = registry_lock();
        let name = unique_name("inproc-mix");
        let plan = [(1u32, 0u64), (MAX_LIMIT, 100), (MAX_LIMIT, 200)];
        let events: Arc<Mutex<Vec<TracedEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let mut threads = Vec::new();
        for (id, (limit, delay)) in plan.iter().enumerate() {
            let name = name.clone();
            let events = events.clone();
            let (limit, delay) = (*limit, *delay);
            threads.push(std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(delay));
                run_registered_with(&name, "inproc-mix", None, limit, |_| {
                    events.lock().unwrap().push((id, now_ms(), 1));
                    std::thread::sleep(Duration::from_millis(HOLD_MS));
                    events.lock().unwrap().push((id, now_ms(), -1));
                    Ok(())
                })
                .expect("فتحة متاحة خلال المهلة");
            }));
        }
        for t in threads {
            t.join().expect("لا ذعر في الخيوط");
        }
        let events = events.lock().unwrap().clone();
        assert_eq!(events.len(), HELPERS * 2, "أحداث ناقصة: {events:?}");
        assert_peak_and_exclusivity(&events, &plan, "داخل العملية/خليط");
    }

    // ── السِجلّ: لا تسرّب في مسار النجاح ولا الخطأ ولا الذعر ─────────────

    #[test]
    fn the_job_registry_is_empty_after_success_failure_and_panic() {
        let _lock = registry_lock();
        let name = unique_name("leak");
        assert!(active_jobs().is_empty(), "لا مهمّة مسجَّلة قبل البدء");

        // ضابط موجب: المهمّة **مسجَّلة وهي تعمل** — لولا هذا لكان «السِجلّ
        // فارغ» صحيحاً حتى لو لم يُسجَّل شيء قطّ (نجاح كاذب).
        let seen = run_registered(&name, "jobs-live", None, |_| {
            Ok::<_, String>(
                active_jobs()
                    .iter()
                    .map(|j| j.label.clone())
                    .collect::<Vec<_>>(),
            )
        })
        .expect("مهمّة ناجحة");
        assert_eq!(
            seen,
            vec!["jobs-live".to_string()],
            "المهمّة مرئية أثناء عملها"
        );
        assert!(active_jobs().is_empty(), "نجاح ⇒ لا شيء يبقى مسجَّلاً");

        // مسار الفشل: نفس الشيء.
        let failed = run_registered(&name, "jobs-fail", None, |_| {
            Err::<(), String>("عطل مصطنع".into())
        });
        assert!(failed.is_err(), "الجسم أعاد خطأً");
        assert!(active_jobs().is_empty(), "فشل ⇒ لا شيء يبقى مسجَّلاً");

        // مسار الذعر: الحارس يسقط أثناء فكّ المكدّس فيُلغى التسجيل.
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {})); // ذعر متوقَّع: لا نُلوّث الخرج
        let caught = std::panic::catch_unwind(|| {
            let _ = run_registered::<()>(&name, "jobs-panic", None, |_| panic!("ذعر مصطنع"));
        });
        std::panic::set_hook(previous_hook);
        assert!(caught.is_err(), "الذعر فعلاً وقع");
        assert!(active_jobs().is_empty(), "ذعر ⇒ لا شيء يبقى مسجَّلاً");
    }

    #[test]
    fn cancelling_targets_one_job_and_reports_what_it_did() {
        let _lock = registry_lock();
        let name = unique_name("cancel");
        let mut inside = Vec::new();
        run_registered(&name, "cancel-me", None, |_| {
            let alive = active_jobs();
            assert_eq!(alive.len(), 1, "مهمّة واحدة نشطة");
            let id = alive[0].id;
            assert!(!alive[0].cancelled, "لم يُطلب إلغاؤها بعد");
            assert!(cancel_job(id), "إلغاء مهمّة نشطة يُبلَّغ بنجاح");
            inside = active_jobs();
            Ok::<_, String>(())
        })
        .expect("مهمّة ناجحة");
        assert_eq!(inside.len(), 1, "المهمّة بقيت نشطة بعد طلب الإلغاء");
        assert!(inside[0].cancelled, "الرمز انضبط فعلاً");
        assert!(
            !cancel_job(inside[0].id),
            "بعد انتهائها لا يُدَّعى إلغاء (المعرّف لم يبق نشطاً)"
        );
        assert!(!cancel_job(0), "معرّف غير موجود ⇒ false");
        assert!(active_jobs().is_empty(), "السِجلّ فارغ في النهاية");
    }

    // ── م٢: الإلغاء الحقيقي — قتل الشجرة، صفر يتيم، إعادة معالجة فورية ──

    /// كم ينام المساعد وأبناؤه (ثانية) إن لم يُقتلوا — أطول بكثير من كل مهلة
    /// في هذه الاختبارات، فلا يمرّ اختبارٌ لأن النوم انتهى من نفسه.
    const HELPER_SLEEP_SECS: u32 = 60;

    /// أمر «نائم» **بعملية حقيقية لها ابن حقيقي**: `pwsh` يشغّل بـ`Start-Process`
    /// عملية `pwsh` ثانية تنام ثم تكتب علامة، **ويكتب رقمها** في `pid_file` —
    /// وهذه بنية مُدمِج ffmpeg في الإنتاج حرفياً (عملية تنام بينما الأب يعمل)،
    /// فلا تُقاس «الشجرة» على عملية بلا أبناء فتبدو دائماً نظيفة.
    #[cfg(windows)]
    fn sleeper_command(
        marker: &Path,
        secs: u32,
        pid_file: &Path,
    ) -> (String, Vec<std::ffi::OsString>) {
        let child_script = format!(
            "Start-Sleep -Seconds {secs}; New-Item -Path '{}' -ItemType File -Force | Out-Null",
            marker.display()
        );
        // بلا `-Wait`: الأب يواصل فوراً، والابن يعيش مستقلاً — وهو ما يجعله
        // «يتيماً» إن قُتل الأب وحده.
        let script = format!(
            "$c = Start-Process -FilePath 'pwsh' -ArgumentList '-NoProfile','-NonInteractive','-Command',\"{child_script}\" -PassThru -WindowStyle Hidden; \
             Set-Content -Path '{}' -Value $c.Id; \
             Start-Sleep -Seconds {secs}",
            pid_file.display()
        );
        (
            "pwsh".to_string(),
            ["-NoProfile", "-NonInteractive", "-Command", &script]
                .iter()
                .map(std::ffi::OsString::from)
                .collect(),
        )
    }

    /// ينتظر ظهور ملف (وعاء القياس: رقم الابن).
    #[cfg(windows)]
    fn wait_for_file(p: &Path, timeout: Duration) -> bool {
        let started = std::time::Instant::now();
        while started.elapsed() < timeout {
            if p.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        p.exists()
    }

    /// هل هذه العملية حيّة؟ (فحص مباشر من الاختبار، لا من كود الإنتاج.)
    #[cfg(windows)]
    fn pid_alive(pid: u32) -> bool {
        let out = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ 'alive' }} else {{ 'gone' }}"
                ),
            ])
            .output();
        out.map(|o| String::from_utf8_lossy(&o.stdout).contains("alive"))
            .unwrap_or(false)
    }

    /// يقتل عملية وابنها الشجرة — تنظيف اختبار فاشل، لا قياس.
    #[cfg(windows)]
    fn cleanup_pid(pid: u32) {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
    }

    /// **الادّعاء (ت٢ · ت١)**: `cancel_job(id)` يقتل **شجرة** العمليات فوراً،
    /// والسِجلّ يفرغ، ولا يبقى أثر.
    ///
    /// القياس على **مسار الإنتاج نفسه**: مهمّة حقيقية في السِجلّ، وأداة طويلة
    /// **حقيقية** (`pwsh` نائم 60 ث) تُشغَّل بـ`proc::run_cancellable_cmd` على
    /// **الخيط نفسه** الذي دخل سياق المهمّة — وهو شرط المسار الإنتاجي (سياق
    /// المهمّة `thread_local`، فلا يراه خيط آخر لم يدخل). والإلغاء يجري من خيط
    /// ثانٍ **كما في الإنتاج** (زر الإيقاف/`/kill` من خيط آخر أثناء الحجب).
    ///
    /// والدليل **علامتان لا تُكتبان إلا عند النجاة**: علامة الابن
    /// (`tree_done`) تُكتب بعد 60 ث، وعلامة الأداة (`tool_done`) في نهاية
    /// سكربت pwsh — فغيابهما يعني أن الشجرة كلها ماتت قبل أوانها.
    #[cfg(windows)]
    #[test]
    fn cancel_kills_the_whole_process_tree_and_frees_the_registry() {
        let _lock = registry_lock();
        let dir = tmp_dir("cancel_tree");
        let tree_done = dir.join("tree_done");
        let tool_done = dir.join("tool_done");
        assert!(
            !tree_done.exists() && !tool_done.exists(),
            "ملفات علامة قديمة — القياس سيكون على أثر سابق"
        );

        let name = unique_name("cancel-tree");
        let child_pid_file = dir.join("child.pid");
        let (program, args) = sleeper_command(&tree_done, HELPER_SLEEP_SECS, &child_pid_file);
        let mut stopped = Duration::MAX;
        let mut message = String::new();
        let outcome = run_registered(&name, "cancel-tree", None, |token| {
            let id = active_jobs().first().map(|j| j.id).expect("مسجَّلة");
            // خيط المُلغِي: ينتظر أن تستقر الأداة جارية **وقد وُلد ابنها**
            // (وإلا قِيس «صفر يتيم» على شجرة لم تُولد بعد)، ثم يُلغي — تماماً
            // كما يقع في الإنتاج (الطلب من خيط آخر أثناء حجب نداء الأداة).
            let pid_file = child_pid_file.clone();
            let killer = std::thread::spawn(move || {
                let started = std::time::Instant::now();
                let born = wait_for_file(&pid_file, Duration::from_secs(20));
                let t = std::time::Instant::now();
                let ok = cancel_job(id);
                (ok, t.elapsed(), born, started.elapsed())
            });
            // ضابط موجب: الأداة **جارية** لحظة الطلب (لا نوم انتهى من نفسه).
            let r = proc::run_cancellable_cmd(
                Path::new(&program),
                &args,
                proc::current_cancel().as_ref(),
            );
            let (ok, elapsed, born, waited) = killer.join().expect("خيط الإلغاء");
            assert!(ok, "cancel_job على مهمّة نشطة");
            assert!(born, "الابن لم يُولد خلال {waited:?} — القياس بلا شجرة باطل");
            stopped = elapsed;
            message = match r {
                Ok(o) => format!("نجحت ({:?})", o.status),
                Err(e) => e,
            };
            assert!(token.is_cancelled(), "رمز المهمّة انضبط في السِجلّ");
            Err::<(), String>("انتهت المهمّة بعد الإلغاء (متوقَّع)".into())
        });
        assert!(outcome.is_err(), "الإلغاء لا يُعيد نجاحاً");
        assert_eq!(message, proc::CANCELLED, "نداء الأداة عاد بالإلغاء");
        let child_pid: u32 = std::fs::read_to_string(&child_pid_file)
            .unwrap_or_default()
            .trim()
            .parse()
            .expect("رقم الابن مكتوب (فالشجرة وُلدت فعلاً)");
        // مهلة قصيرة: `taskkill /T` غير متزامن، فلا يُقاس «يتيم» في لحظة القتل.
        let gone_deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut child_gone = !pid_alive(child_pid);
        while !child_gone && std::time::Instant::now() < gone_deadline {
            std::thread::sleep(Duration::from_millis(100));
            child_gone = !pid_alive(child_pid);
        }
        for (p, what) in [
            (&tree_done, "الابن نجا 60 ث (الشجرة لم تُقتل)"),
            (&tool_done, "الأداة أكملت نومها (لم تُقتل)"),
        ] {
            assert!(!p.exists(), "{what}: {}", p.display());
        }
        assert!(
            child_gone,
            "الابن (pid={child_pid}) ما زال حيّاً بعد الإلغاء — يتيم مقيس"
        );
        assert!(
            stopped < Duration::from_secs(2),
            "من الطلب إلى انتهاء النداء {stopped:?} — تجاوز السقف (النوم 60 ث)"
        );
        // والسِجلّ يفرغ (ت٤).
        assert!(wait_until_idle(Duration::from_secs(5)), "السِجلّ يفرغ");
        // **صفر يتيم**: لا `pwsh` نائمة على `Start-Sleep` في الجهاز.
        let strays = stray_sleepers();
        assert!(strays.is_empty(), "عمليات يتيمة بعد الإلغاء: {strays:?}");
        eprintln!(
            "م٢/اليتيم: الرسالة «{message}» · من الطلب إلى العودة {stopped:?} · \
             الابن pid={child_pid} حيّ={} · علامات النجاة (0 متوقَّعة): tree={} tool={} · \
             مجرَّدات pwsh النائمة: {}",
            pid_alive(child_pid),
            tree_done.exists(),
            tool_done.exists(),
            strays.len()
        );
        // تنظيف: لو فشل القياس أعلاه يبقى الابن — يُقتل بأي حال.
        cleanup_pid(child_pid);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// جرد `pwsh` النائمة على `Start-Sleep` **بعينها** — لا جرد كل `pwsh` على
    /// الجهاز (وإلا قاس الاختبار عمليات غيره).
    ///
    /// **ولا يعدّ نفسه**: الأمر الذي يجرد يُشغَّل بـ`powershell` لكن سطر أوامره
    /// يحمل النصّ `Start-Sleep` (فهو يبحث عنه) — فرُصد **قائسٌ يعدّ ذاته** في
    /// أول تشغيل. فيُمرَّر معرّف القائس ويُستثنى.
    #[cfg(windows)]
    fn stray_sleepers() -> Vec<u32> {
        let me = std::process::id();
        let out = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Get-CimInstance Win32_Process -Filter \"Name='pwsh.exe'\" | \
                     Where-Object {{ $_.CommandLine -like '*Start-Sleep*' -and $_.ProcessId -ne {me} }} | \
                     Select-Object -ExpandProperty ProcessId"
                ),
            ])
            .output();
        let text = out
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        text.split_whitespace()
            .filter_map(|t| t.trim().parse::<u32>().ok())
            .filter(|p| *p != me)
            .collect()
    }

    /// **الادّعاء (ت٣ · ت٦)**: لا ناتج جزئي ولا مجلد عمل بعد الإلغاء، والخطأ
    /// يحمل «أُلغيت»، **والسِجلّ يفرغ** (ت٤) — بنداء `/kill` نفسه
    /// (`wait_until_idle`) الذي ينتظره البوت قبل أن يجيب.
    #[cfg(windows)]
    #[test]
    fn a_cancelled_tool_reports_cancellation_and_leaves_no_output() {
        let _lock = registry_lock();
        let dir = tmp_dir("cancel_out");
        let never = dir.join("never_written.mp3");
        let done = dir.join("tool_done");
        let child_pid_file = dir.join("child.pid");
        let name = unique_name("cancel-out");
        let mut message = String::new();
        let outcome = run_registered(&name, "cancel-out", None, |token| {
            let id = active_jobs().first().map(|j| j.id).expect("مسجَّلة");
            token.set();
            assert!(cancel_job(id), "الإلغاء يقع");
            // الأداة تُشغَّل برمز مضبوط سلفاً: أول دورة استطلاع تقتلها.
            let (program, args) = sleeper_command(&done, HELPER_SLEEP_SECS, &child_pid_file);
            let r = proc::run_cancellable_cmd(
                Path::new(&program),
                &args,
                proc::current_cancel().as_ref(),
            );
            message = match r {
                Ok(o) => format!("نجحت ({:?})", o.status),
                Err(e) => e,
            };
            Ok::<(), String>(())
        });
        assert!(outcome.is_ok(), "الجسم نفسه لم يفشل — الفشل من الأداة");
        assert_eq!(message, proc::CANCELLED, "الرسالة هي رسالة الإلغاء الواحدة");
        assert!(!done.exists(), "الأداة لم تكمل: {}", done.display());
        assert!(!never.exists(), "لا ناتج جزئي: {}", never.display());
        assert!(wait_until_idle(Duration::from_secs(5)), "السِجلّ يفرغ (ت٤)");
        assert!(stray_sleepers().is_empty(), "لا يتيم بعد إلغاء الأداة");
        eprintln!("م٢/لا ناتج: الرسالة «{message}» · ناتج={}", never.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **الادّعاء (ت٦)**: مسار الفشل يحفظ `stderr` — إسقاط القراءة يُسقط هذا.
    ///
    /// **حدّ أمانة في القياس**: النصّ المقصود **ASCII** عن قصد. محاولة أولى
    /// بعلامة عربية فشلت لأن تمرير وسيطة عربية عبر `CreateProcess` إلى
    /// `powershell` يعبر ترميز وحدة التحكّم (cp1256 على هذا الجهاز) — فالفرق
    /// المرصود كان في **الأداة لا في الأنبوب**. والاتّباع الدقيق (UTF-8 عبر
    /// الأنبوب) هو ما يقيسه `a_utf8_stderr_survives_the_pipe` أدناه.
    #[cfg(windows)]
    #[test]
    fn a_failing_tool_still_reports_the_last_stderr_line() {
        let out = proc::run_cancellable(
            Path::new("powershell"),
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Error.WriteLine('stderr-tail-marker'); exit 3",
            ],
            None,
        )
        .expect("النداء نجح (الخروج ≠0 ليس فشل تشغيل)");
        assert!(!out.status.success(), "رمز الخروج ≠0");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(
            err.contains("stderr-tail-marker"),
            "stderr محفوظ في المخرجات: {err:?}"
        );
    }

    /// **الادّعاء**: الأنبوب يحمل UTF-8 سليماً (وهو ما يمرّ فعلاً في الإنتاج:
    /// رسائل ffmpeg و`PYTHONIOENCODING=utf-8` في yt-dlp). والعلامة تُبنى في
    /// الأداة من بايتات صريحة، فلا يعبر النصّ ترميز وسائط ويندوز.
    #[cfg(windows)]
    #[test]
    fn a_utf8_stderr_survives_the_pipe() {
        let out = proc::run_cancellable(
            Path::new("powershell"),
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::OpenStandardError().Write([byte[]](0xD8,0xB3,0xD8,0xB7,0xD8,0xB1),0,6); exit 3",
            ],
            None,
        )
        .expect("النداء نجح");
        assert!(!out.status.success(), "رمز الخروج ≠0");
        assert_eq!(
            String::from_utf8_lossy(&out.stderr).trim(),
            "سطر",
            "ثلاثة بايتات UTF-8 تعبر الأنبوب كما هي"
        );
    }

    // ── الغلاف نفسه على المحرّك الحقيقي ────────────────────────────────

    /// `run_separation` الحقيقي (بلا محرّك مُبدَّل): ملف غير موجود ⇒ فشل سريع
    /// من المحرّك، والسِجلّ يعود فارغاً والفتحة تُحرَّر. اسم الفتحة فريد، فلا
    /// ينتظر الاختبار فتحات تطبيق المالك.
    ///
    /// **وهو أيضاً مُفسَد إعادة المعالجة**: قبل إصلاح القفل كان القفل الميت
    /// يبقى ١٢ ساعة — ومسار هذا الاختبار لا يلمسه (لا يُقتل حامله)، فالمُفسَد
    /// المقصود هناك في `pipeline::tests` حيث يُقتل المالك فعلاً.
    #[test]
    fn the_real_wrapper_fails_fast_on_a_missing_file_and_leaves_no_trace() {
        let _lock = registry_lock();
        let name = unique_name("real");
        let dir = tmp_dir("real");
        let missing = dir.join("لا-يوجد.mp3");
        let started = std::time::Instant::now();
        let result = run_separation_as(
            &name,
            "test",
            &missing,
            &dir,
            Mode::Song,
            OutKind::Audio {
                fmt: pipeline::OutFormat::Mp3,
            },
            false,
            true,
            false,
            None,
            &|_| true,
            &|_, _| {},
        );
        assert!(result.is_err(), "ملف غير موجود لا ينجح");
        let err = result.err().unwrap_or_default();
        assert!(!err.is_empty(), "الخطأ يحمل رسالة: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "الفشل يجب أن يكون سريعاً لا أن ينتظر مهلة"
        );
        assert!(active_jobs().is_empty(), "السِجلّ فارغ بعد الفشل الحقيقي");
        // والفتحة تحرّرت فعلاً: مهمّة ثانية بالاسم نفسه تجدها فوراً.
        run_registered(&name, "after-failure", None, |_| Ok(())).expect("الفتحة متاحة بعد الفشل");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **مُفسَد «العملية الميتة»**: عملية تأخذ فتحتين ثم تخرج بـ`exit` بلا
    /// تحرير (لا تعمل المدوِّرات)، فيجب أن يعود الكائن كاملاً لمن يأتي بعدها
    /// **ما دام لم يبق مقبض مفتوح**. والتحقّق يجري في عملية ثالثة، لأن أي
    /// مقبض في عملية الفحص نفسه يُبقي الكائن حيّاً بعدد ناقص.
    ///
    /// (**الحالة الثانية** — «والفحص يحمل مقبضاً» — في
    /// `a_killed_owner_releases_its_slots_without_waiting_for_handles`؛ وهما
    /// حالتان مختلفتان: هنا لا مقبض آخر أصلاً، وهناك المقبض باقٍ في عملية
    /// الفحص.) وبالـmutex صار المسار هنا يمرّ بـ**abandoned** كذلك، فالاختبار
    /// يقيس اليوم أن الخروج بـ`exit` لا يُفقد الرمز — وهو ما يعنيه اسمه.
    #[cfg(windows)]
    #[test]
    fn a_dead_process_slots_are_reusable_once_its_last_handle_is_gone() {
        if std::env::var(HELPER_MODE).is_ok() {
            return;
        }
        let _lock = registry_lock();
        let dir = tmp_dir("dead");
        let slot = unique_name("dead");
        let exe = std::env::current_exe().expect("مسار ثنائي الاختبار");
        assert_no_stale_log(&dir.join("probe.log"));

        // ١) عملية تأخذ الفتحتين ثم تموت بلا تحرير.
        let taken = Command::new(&exe)
            .args(["slots::tests::slot_hog_process", "--exact", "--nocapture"])
            .env(HELPER_MODE, "1")
            .env(HELPER_SLOT, &slot)
            .env(HELPER_LOG, dir.join("hog.log"))
            .env(HELPER_READY, &dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .env(HELPER_READY, &dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("إطلاق عملية الحجز");
        assert!(taken.success(), "عملية الحجز خرجت بلا خطأ");

        // ٢) عملية ثالثة (لا تحمل مقبضاً) تجد الفتحتين متاحتين.
        let check = Command::new(&exe)
            .args(["slots::tests::slot_probe_process", "--exact", "--nocapture"])
            .env(HELPER_MODE, "1")
            .env(HELPER_SLOT, &slot)
            .env(HELPER_LOG, dir.join("probe.log"))
            .env(HELPER_READY, &dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("إطلاق عملية الفحص");
        let raw = std::fs::read_to_string(dir.join("probe.log")).unwrap_or_default();
        assert!(
            check.success(),
            "الفتحتان يجب أن تعودا بعد موت ماسكهما — سجلّ الفحص: {raw}"
        );
        assert!(raw.contains("PROBE OK"), "سجلّ الفحص: {raw}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// عملية تحجز فتحتين ثم تخرج بلا تحرير (`exit` لا يعمل مدوِّرات المكدّس).
    ///
    /// والحجز على **خيطين**: الملكيّة صارت ملكيّة **خيط** (mutex)، فالخيط
    /// الواحد لا يجمع رمزَي الزوج بسقف `MAX_LIMIT` (وطلبه ثانيةً مرفوض
    /// تراكبياً). فالمطلوب «الرمزان محجوزان» ⇒ خيط لكل رمز.
    #[cfg(windows)]
    #[test]
    fn slot_hog_process() {
        if std::env::var(HELPER_MODE).is_err() {
            return;
        }
        let slot = std::env::var(HELPER_SLOT).expect("اسم الفتحة");
        let log = PathBuf::from(std::env::var(HELPER_LOG).expect("ملف السجلّ"));
        // خيط لكل رمز: كلٌّ بسقف `MAX_LIMIT` فيأخذ رمزاً واحداً (ولا يُستعمل
        // الافتراضيّ هنا: صار 1 فيأخذ النداء الأول الرمزين ويفشل الثاني بمهلة).
        let mut threads = Vec::new();
        for _ in 0..TOKENS {
            let slot = slot.clone();
            threads.push(std::thread::spawn(move || {
                acquire_named(&slot, MAX_LIMIT, Duration::from_secs(10)).is_ok()
            }));
        }
        let ok = threads.into_iter().all(|t| t.join().unwrap_or(false));
        append_line(&log, &format!("HOG {}\n", if ok { "OK" } else { "FAIL" }));
        assert!(ok, "العملية الحاجزة يجب أن تأخذ الفتحتين");
        // بلا `drop`: الخروج الفوري لا يعمل المدوِّرات.
        std::process::exit(0);
    }

    /// **ت-ب: الإعلان صادق — لا سطر انتظار بلا انتظار.**
    ///
    /// العطل المقيس: السطر كان يُطبع **قبل** الطلب دائماً، فمهمّة حرّة انتهت
    /// في **433ms** طُبع لها «بانتظار فتحة فصل…» (وقياس المدقّق: الحرّة
    /// **9.8ms** مقابل المحجوزة **18.618s**). فالقياس هنا على الحقل الذي
    /// يُبنى عليه الإعلان: فتحة حرّة ⇒ `waited = false`؛ فتحة محجوزة تُحرَّر
    /// **أثناء** الانتظار ⇒ `waited = true` **وزمن انتظار مقيس > 0**.
    ///
    /// **المُفسَد**: جعل الإعلان دائماً (محاولة واحدة بالمهلة الكاملة بلا
    /// استطلاع فوري) ⇒ الحالة الحرّة ترجع `waited = true` فيسقط الاختبار.
    /// **ومُفسَد ثانٍ**: نقل الإعلان إلى **ما بعد** الاكتساب ⇒ ينقلب ترتيب
    /// اللحظتين فيسقط (وقد أُسقط فعلاً: فارق 3.4µs بدل ≥200ms).
    #[test]
    fn a_free_slot_is_taken_without_waiting_and_a_taken_one_reports_its_wait() {
        let _lock = registry_lock();
        let name = unique_name("honest-wait");

        // (١) حرّة ⇒ بلا انتظار (ولا إعلان).
        let free_announcements = Arc::new(Mutex::new(0usize));
        let fa = free_announcements.clone();
        let free = acquire_now_or_wait(&name, MAX_LIMIT, Duration::from_secs(5), || {
            *fa.lock().unwrap() += 1;
        })
        .expect("فتحة حرّة تُؤخذ فوراً");
        assert!(
            !free.waited,
            "فتحة حرّة لا تُعلن انتظاراً — كان السطر يُطبع دائماً فيكذب"
        );
        assert_eq!(
            *free_announcements.lock().unwrap(),
            0,
            "فتحة حرّة ⇒ صفر إعلان (لا سطر انتظار في الحالة الحرّة)"
        );
        assert_eq!(free.waited_for, Duration::ZERO, "ولا زمن انتظار لها");
        drop(free);

        // (٢) محجوزة تُحرَّر أثناء الانتظار ⇒ انتظار مُعلَن **بزمنه المقيس**،
        // و**الإعلان قبل الحجب لا بعده**: نُسجّل لحظة الإعلان ولحظة الاكتساب
        // ونقارنهما. الحاجز يُمسَك على خيط آخر مدّةً (800ms) أطول من مهلة
        // القياس (400ms)، فالتوقيت مضبوط لا رهين مصادفة جدولة.
        let holder = acquire_held_on_thread(&name, 1, Duration::from_millis(800));
        std::thread::sleep(Duration::from_millis(60));
        let announced_at = Arc::new(Mutex::new(None::<std::time::Instant>));
        let acquired_at = Arc::new(Mutex::new(None::<std::time::Instant>));
        let (aa, ac) = (announced_at.clone(), acquired_at.clone());
        let started = std::time::Instant::now();
        let busy = acquire_now_or_wait(&name, MAX_LIMIT, Duration::from_secs(5), || {
            *aa.lock().unwrap() = Some(std::time::Instant::now());
        })
        .expect("الفتحة تُحرَّر خلال المهلة");
        *ac.lock().unwrap() = Some(std::time::Instant::now());
        let measured = started.elapsed();
        assert!(busy.waited, "فتحة محجوزة ⇒ انتظار فعلي، ولا بد أن يُعلَن");
        let ann = announced_at.lock().unwrap().expect("الإعلان وقع");
        let acq = acquired_at.lock().unwrap().expect("الاكتساب وقع");
        assert!(
            ann < acq,
            "الإعلان يجب أن يسبق الاكتساب (قبل الحجب لا بعده): {ann:?} ≥ {acq:?}"
        );
        assert!(
            acq.duration_since(ann) >= Duration::from_millis(200),
            "الإعلان وقع والحاجز ما زال ماسكاً (فارق {:?} فقط) ⇒ لم يُعلن أثناء الانتظار",
            acq.duration_since(ann)
        );
        assert!(
            busy.waited_for >= Duration::from_millis(200),
            "زمن الانتظار المقيس يجب أن يكون معتبراً: {:?}",
            busy.waited_for
        );
        assert!(
            busy.waited_for <= measured,
            "الزمن المُعلَن لا يتجاوز ما قاسه المستدعي: {:?} > {measured:?}",
            busy.waited_for
        );
        eprintln!(
            "ت-ب/الإعلان الصادق: حرّة ⇒ waited=false · محجوزة ⇒ waited=true بعد {:?} (المقيس في المستدعي {measured:?})",
            busy.waited_for
        );
        assert!(holder.join().unwrap_or(false), "الحاجز كان يحمل الرمز فعلاً");
    }

    /// عملية ثالثة: تتحقّق أن السقف كامل بعد موت الحاجز.
    ///
    /// والرمزان يُحجزان على **خيطين**: الملكيّة ملكيّة خيط، فالخيط الواحد لا
    /// يجمع رمزَي الزوج بسقف `MAX_LIMIT` (وطلبه ثانيةً يُرفض تراكبياً).
    #[test]
    fn slot_probe_process() {
        if std::env::var(HELPER_MODE).is_err() {
            return;
        }
        let slot = std::env::var(HELPER_SLOT).expect("اسم الفتحة");
        let log = PathBuf::from(std::env::var(HELPER_LOG).expect("ملف السجلّ"));
        // خيط يحمل رمزاً **مدّةً** (لا نداءً عابراً يحرّر فوراً)، وهذا الخيط
        // يأخذ الرمز الآخر — فإن كان أيّهما محجوزاً فشل أحد الطرفين.
        let slot2 = slot.clone();
        let other = std::thread::spawn(move || {
            match acquire_named(&slot2, MAX_LIMIT, Duration::from_secs(5)) {
                Ok(_guard) => {
                    std::thread::sleep(Duration::from_millis(300));
                    true
                }
                Err(e) => {
                    eprintln!("probe: الرمز الأول لم يُتح: {e}");
                    false
                }
            }
        });
        let b = acquire_named(&slot, MAX_LIMIT, Duration::from_secs(5));
        let ok = b.is_ok() && other.join().unwrap_or(false);
        append_line(&log, &format!("PROBE {}\n", if ok { "OK" } else { "FAIL" }));
        assert!(ok, "بعد موت الحاجز يجب أن تُتاح الفتحتان كاملتين");
    }

    /// **ت-جديد-١ [الأهم] — الرمز يعود عند قتل مالكه، وعملية الفحص تحمل مقبضاً.**
    ///
    /// هذا **تشكيل الإنتاج**: الواجهة الدائمة تحمل مقابض الكائن مدى الحياة
    /// (`kernel::cache`)، فبالسِّيمافور كان الرمز **لا يعود أبداً** ما دام أي
    /// مقبض مفتوحاً — وهو عطل **مقيس** بمسبارَي المشرف والمدقّق. وبالـmutex
    /// تُرفع الملكيّة **بموت المالك** (abandoned) لا بزوال الكائن، فيعود الرمز
    /// **فوراً**.
    ///
    /// والاختبار يفعل بالترتيب: (١) يفتح هو نفسه مقبضَي الكائن عبر
    /// `kernel::token_handle` — فيصير «الحامل الآخر للمقبض»، (٢) يُشغّل عملية
    /// تحجز **الرمزين** وتُعلن ذلك، (٣) **يقتلها بـ`TerminateProcess`** وهي
    /// حاجزة (لا خروج نظيف)، (٤) مهمّة **بسقف 1** (تحتاج الرمزين) يجب أن تنجح
    /// **بلا انتظار المهلة**. وبمهلة قصيرة (10 ث) لا 30 دقيقة، فالسقوط سريع
    /// ومُعلَن لا معلَّق.
    ///
    /// **المُفسَد**: (أ) إرجاع السِّيمافور، (ب) تجاهل `WAIT_ABANDONED_0`
    /// (معاملته خطأً/مهلة) — كلاهما يُسقط هذا الاختبار بمهلة صريحة.
    #[cfg(windows)]
    #[test]
    fn a_killed_owner_releases_its_slots_without_waiting_for_handles() {
        if std::env::var(HELPER_MODE).is_ok() {
            return; // لا نُطلق مساعدين من داخل مساعد
        }
        let _lock = registry_lock();
        let dir = tmp_dir("killed");
        let slot = unique_name("killed");
        let log = dir.join("probe.log");
        let exe = std::env::current_exe().expect("مسار ثنائي الاختبار");
        // **حارس القياس**: لا ملف تتبّع قديم يُقرأ كأنه إعلان هذه الجولة.
        assert_no_stale_log(&log);

        // (١) الفحص نفسه يحمل مقبضاً لكل رمز — وهذا **تشكيل الإنتاج**، ولولاه
        // لكان الاختبار يقيس حالة أخرى (وهي المُغطّاة بالاختبار القديم).
        let h0 = kernel::token_handle(&kernel::token_name(&slot, 0)).expect("مقبض الرمز a");
        let h1 = kernel::token_handle(&kernel::token_name(&slot, 1)).expect("مقبض الرمز b");
        assert!(h0 != 0 && h1 != 0, "مقبضان صالحان للكائن نفسه");

        // (٢) عملية تحجز الرمزين وتُعلن، ثم تنتظر القتل. (خرج الخطأ **موروث**
        // لا `null`: تشخيص فشل المساعد يجب أن يظهر في مخرجات الاختبار.)
        let mut hog = Command::new(&exe)
            .args(["slots::tests::slot_keep_process", "--exact", "--nocapture"])
            .env(HELPER_MODE, "1")
            .env(HELPER_SLOT, &slot)
            .env(HELPER_LOG, &log)
            .env(HELPER_READY, &dir)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("إطلاق عملية الحجز");
        let raw = wait_for_marker(&log, "HOLDING", Duration::from_secs(20));
        assert!(raw.contains("HOLDING OK"), "الحجز فشل: {raw}");

        // (٣) القتل الفوري: لا `Drop` ولا `ReleaseMutex` — مالك ميّت.
        win_terminate_process(hog.id()).expect("TerminateProcess على الحاجز");
        let status = hog.wait().expect("انتظار خروج الحاجز");
        assert!(
            !status.success(),
            "العملية يجب أن تموت بالقتل لا أن تخرج بنجاح: {status}"
        );

        // (٤) الرمزان يعودان **فوراً** لمهمّة بسقف 1 — وهي تحتاج الرمزين معاً.
        let started = std::time::Instant::now();
        let exclusive = acquire_named(&slot, 1, Duration::from_secs(10)).unwrap_or_else(|e| {
            panic!("الرمزان لم يعودا بعد موت مالكهما (والمقابض ما زالت مفتوحة في هذه العملية): {e}")
        });
        let waited = started.elapsed();
        eprintln!(
            "ت-جديد-١: الرمزان عادا بعد قتل المالك في {waited:?} (المهلة كانت 10s) — \
             والمقابضان مفتوحان في عملية الفحص: {h0:#x} · {h1:#x}"
        );
        assert!(
            waited < Duration::from_secs(5),
            "العودة يجب أن تكون فورية لا بعد مهلة ({waited:?})"
        );
        drop(exclusive);
        // وبعد التحرير: تنجح مهمّة بسقف كامل على الرمز الثاني أيضاً (لا رمز ضاع).
        acquire_named(&slot, MAX_LIMIT, Duration::from_secs(5)).expect("رمز حرّ بعد التحرير");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// مساعد ت-جديد-١: يحجز **الرمزين** (خيط لكل رمز) ويُعلن، ثم ينتظر القتل.
    ///
    /// **ولا يمرّ بصرّاف الاختبارات** (`slot_keep_process` الحقيقي): صرّاف
    /// `libtest` يُشغّل الاختبار على خيط ثم **ينتظر انتهاءه**، فـ«الانتظار
    /// الطويل» يُعلّق الصرّاف ولا يُنتج عملية حاجزة. هذا المساعد يأخذ الرمزين
    /// بمقابض نواة مباشرة (`kernel::token_handle` + `WaitForMultipleObjects`)
    /// ويُبقيهما مملوكين لهذين الخيطين، ثم ينتظر القتل في `park`.
    #[cfg(windows)]
    fn keep_process_main(slot: &str, log: &Path) {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use windows_sys::Win32::Foundation::{BOOL, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::WaitForMultipleObjects;

        // خيط لكل رمز: الملكيّة ملكيّة خيط، فالرمزان لا يُجمعان على خيط واحد.
        static ACQUIRED: AtomicUsize = AtomicUsize::new(0);
        let mut threads = Vec::new();
        for i in 0..TOKENS {
            let name = kernel::token_name(slot, i);
            let h = match kernel::token_handle(&name) {
                Ok(h) => h,
                Err((_, e)) => {
                    append_line(log, &format!("HOLDING FAIL {e}\n"));
                    return;
                }
            };
            threads.push(std::thread::spawn(move || {
                let raw: [HANDLE; 1] = [h as _];
                let rc = unsafe { WaitForMultipleObjects(1, raw.as_ptr(), 0 as BOOL, 10_000) };
                if rc == WAIT_OBJECT_0 {
                    ACQUIRED.fetch_add(1, AtomicOrdering::SeqCst);
                    // بلا `ReleaseMutex` وبلا خروج من الخيط: park للأبد.
                    std::thread::park();
                } else if rc == WAIT_TIMEOUT {
                    eprintln!("keep: مهلة على الرمز {i}");
                } else {
                    eprintln!("keep: رمز غير متوقَّع {rc:#x} على الرمز {i}");
                }
            }));
        }
        // لا ننتظر الخيوط (لا تنتهي): ننتظر وقوع الاكتساب فعلاً.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while ACQUIRED.load(AtomicOrdering::SeqCst) < TOKENS {
            if std::time::Instant::now() >= deadline {
                append_line(
                    log,
                    &format!(
                        "HOLDING FAIL timeout {}\n",
                        ACQUIRED.load(AtomicOrdering::SeqCst)
                    ),
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        append_line(log, &format!("HOLDING OK pid={}\n", std::process::id()));
        // الحجز قائم على خيطَي المساعد؛ والصرّاف يُبقي العملية حيّة حتى القتل.
        std::thread::park();
    }

    /// موجّه المساعد: يُستدعى من `slot_keep_process` بعد فحص `HELPER_MODE`.
    #[cfg(windows)]
    #[test]
    fn slot_keep_process() {
        if std::env::var(HELPER_MODE).is_err() {
            return;
        }
        let slot = std::env::var(HELPER_SLOT).expect("اسم الفتحة");
        let log = PathBuf::from(std::env::var(HELPER_LOG).expect("ملف السجلّ"));
        keep_process_main(&slot, &log);
    }

    /// **ت-جديد-٣ — الاكتساب التراكبي على الخيط نفسه مرفوض بخطأ صريح.**
    ///
    /// لأن ملكيّة الـmutex **تراكبية**: لو مرّ الطلب لمنحه ويندوز الملكيّة
    /// **فوراً بلا حجب**، وتحرير واحد لا يكفي ⇒ منتظر آخر يعبر والحاصر يعمل
    /// = ثغرة صامتة في ب٢. فيجب أن يكون الردّ **خطأً عربياً** لا نجاحاً صامتاً
    /// ولا انتظاراً.
    #[cfg(windows)]
    #[test]
    fn recursive_acquisition_on_the_same_thread_is_refused() {
        let _lock = registry_lock();
        let name = unique_name("reentry");

        // (أ) الخيط يحمل رمزاً بسقف 2 ثم يطلب رمزاً آخر بالاسم نفسه.
        let first = acquire_named(&name, MAX_LIMIT, Duration::from_secs(5)).expect("رمز حرّ");
        let again = acquire_named(&name, MAX_LIMIT, Duration::from_millis(200));
        let err = again
            .err()
            .expect("الطلب الثاني على الخيط نفسه يجب أن يُرفض لا أن يُمنح");
        assert!(
            err.contains("رفض اكتساب تراكبي"),
            "خطأ عربي صريح عن التراكب: {err}"
        );
        eprintln!("ت-جديد-٣: رُفض الطلب التراكبي فوراً — {err}");

        // (ب) وبعد إسقاط الأول: الطلب ينجح (الحارس أزال التسجيل فعلاً).
        drop(first);
        let re =
            acquire_named(&name, MAX_LIMIT, Duration::from_secs(5)).expect("بعد التحرير لا تراكب");
        drop(re);

        // (ج) وبسقف 1: من يحمل **الرمزين** لا يستطيع طلب حصرية ثانية.
        let both = acquire_named(&name, 1, Duration::from_secs(5)).expect("الرمزان حُرّان");
        let second_excl = acquire_named(&name, 1, Duration::from_millis(200));
        assert!(
            second_excl.is_err(),
            "حصرية ثانية على الخيط نفسه يجب أن تُرفض"
        );
        // والحارس يحرّر الرمزين فعلاً: بعدهما تنجح حصرية أخرى فوراً.
        drop(both);
        acquire_named(&name, 1, Duration::from_secs(5)).expect("الرمزان حُرّان بعد الإسقاط");
    }

    /// **ت-جديد-٤ — التحرير في أربعة مسارات**: النجاح · الخطأ · الذعر · والخروج
    /// بلا تحرير (`std::process::exit` في عملية أخرى، ويُعالجه abandoned).
    ///
    /// الثلاثة الأولى تُقاس **داخل العملية** بمهمّة واحدة بعد كل مسار: لو لم
    /// يتحرّر الرمز لفشلت بمهلة. والرابع مساره `slot_hog_process` (خروج بلا
    /// تحرير) + `slot_probe_process`، وهو المُغطّى في اختبار العملية الميتة.
    #[test]
    fn a_slot_returns_on_success_error_and_panic() {
        let _lock = registry_lock();
        let name = unique_name("paths");

        // ١) النجاح: المهمّة تحمل الرمز ثم تُسقطه.
        run_registered(&name, "ok", None, |_| Ok::<_, String>(())).expect("مهمّة ناجحة");

        // ٢) الخطأ: الجسم يعيد خطأً — الحارس يُسقط الرمز أثناء الانتشار.
        let failed = run_registered(&name, "err", None, |_| {
            Err::<(), String>("عطل مصطنع".into())
        });
        assert!(failed.is_err(), "الجسم أعاد خطأً");

        // ٣) الذعر: الحارس يُسقط الرمز أثناء فكّ المكدّس.
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {})); // ذعر متوقَّع: لا نُلوّث الخرج
        let caught = std::panic::catch_unwind(|| {
            let _ = run_registered::<()>(&name, "panic", None, |_| panic!("ذعر مصطنع"));
        });
        std::panic::set_hook(previous_hook);
        assert!(caught.is_err(), "الذعر وقع فعلاً");

        // الضابط الموجب: بعد الثلاثة، **الرمزين** حُرّان — مهمّة بسقف 1 تنجح
        // فوراً. ولولا التحرير في مسار واحد منها لبقيت محجوزة وفشل هذا السطر.
        let started = std::time::Instant::now();
        let free = acquire_named(&name, 1, Duration::from_secs(5))
            .expect("الرمزان حُرّان بعد النجاح والخطأ والذعر");
        let waited = started.elapsed();
        eprintln!("ت-جديد-٤: الرمزان حُرّان بعد ثلاثة مسارات في {waited:?}");
        assert!(waited < Duration::from_secs(1), "بلا انتظار ({waited:?})");
        drop(free);
    }

    /// المُفسَد الآخر: سقف أصغر ⇒ الانتظار يعطي خطأً عربياً صريحاً لا انتظاراً
    /// أبدياً. يُقاس بمهلة قصيرة جداً كي يبقى الاختبار سريعاً.
    ///
    /// والانتظار يقع على **خيط آخر**: الملكيّة صارت ملكيّة خيط (mutex)، فطلب
    /// الخيط نفسه ما يحمله يُرفض **تراكبياً** (لا بمهلة) — وهو مُقاس في
    /// `recursive_acquisition_on_the_same_thread_is_refused`. فهنا الموضوع
    /// «فتحة محجوزة» لا «إعادة اكتساب».
    #[test]
    fn a_taken_slot_times_out_with_an_explicit_arabic_error() {
        let _lock = registry_lock();
        let name = unique_name("timeout");
        let _held = acquire_named(&name, 1, Duration::from_secs(5)).expect("فتحة وحيدة");
        let (ok, err, waited) = acquire_measured_on_thread(&name, 1, Duration::from_millis(300));
        assert!(!ok, "لا فتحة ثانية بسقف 1");
        assert!(
            err.contains("انتهت مهلة انتظار فتحة الفصل"),
            "رسالة عربية صريحة: {err}"
        );
        assert!(
            waited >= Duration::from_millis(250) && waited < Duration::from_secs(5),
            "انتظر المهلة المطلوبة لا أكثر ({waited:?})"
        );
    }

    /// **التحرير بقدر ما أُخذ بالضبط — في كل مسارات الاكتساب الثلاثة.**
    ///
    /// **ولماذا أُعيد كتابته** (كان يقيس الأثر **بالاستنتاج** لا **مباشرةً**):
    /// مُفسَد «التحرير الجزئي» (`WinSem::drop` ⇒ `if self.held[i] && i == 0`)
    /// **لم يُسقطه**، وأسقط ثلاثة اختبارات **أخرى** لسبب **تابع** (رمز مسرَّب
    /// يُبقي الاسم في سجلّ `held_counts` فيُرفض الاكتساب التالي) — أي أن
    /// الخاصّية «حرّر **بقدر ما** أُخذ» كانت محروسة **بالمصادفة** لا بحارسها.
    ///
    /// **والقياس الآن مباشر**: «الميزانية المتاحة» تُقاس **بالعدّ على خيوط
    /// نقية** بمحاولات فورية بمهلة صفر (‏`assert_budget` ⇒ `measure_budget`)،
    /// **قبل** إسقاط الحارس وبعده، في كل مسار من مسارات الاكتساب الثلاثة
    /// (‏`T` = نجاح، `F` = فشل — والأخيرة محاولة العدّ التي توقّف عليها):
    ///
    /// | المسار | ما يحمله الحارس | قبل الإسقاط | بعد الإسقاط |
    /// |---|---|---|---|
    /// | سقف 1 (حصرية) | الرمزان معاً | `[F]` | `[T,T,F]` |
    /// | سقف 2 · الرمز الثاني | `-b` (و`-a` بيد خيط آخر) | `[F]` | `[T,F]` |
    /// | سقف 2 · الرمز الأول | `-a` (و`-b` بيد خيط آخر) | `[F]` | `[T,F]` |
    ///
    /// و«قبل» تُثبت نصف الخاصّية (المأخوذ مأخوذ فعلاً)، و«بعد» تُثبت النصف
    /// الآخر: **الرمز الذي كان بيد الحارس صار حرّاً** — وهو بعينه ما يفسده
    /// مُفسَد التحرير الجزئي (`i == 0` ⇒ الرمز الثاني لا يُحرَّر ⇒ تبقى
    /// الميزانية `[F]` حيث يجب أن تكون `[T,F]`).
    ///
    /// **ومسارا الرمزين مقيسان كلٌّ على حِدة، ولا يُفترض أيّهما بيد من**: كل قسم
    /// يبدأ والزوج **حرّ تماماً**، فيأخذ الخيط الحاجز الرمز الأدنى فهرسةً
    /// (`-a`) ويأخذ خيط الاختبار الباقي — ويُقاس **أيُّهما** بيد خيط الاختبار
    /// فعلاً (`held_count`) ويُشترط أن يكون هو مسار القسم. فمُفسَد `i == 0`
    /// لا يُسقط قسماً واحداً بل **الاثنين**.
    ///
    /// **وسقط من هذا التوثيق خطرٌ كان مكتوباً ولا وجود له**: كان يقول إن
    /// «التحرير **أكثر** مما أُخذ» يفتح **فتحة ثالثة** (خرق ب١). وهذا **مستحيل
    /// بالقياس**: `ReleaseMutex` من غير مالكه تُعيد `false` و`ERROR_NOT_OWNER`
    /// = **288** (قِيس في هذه الجولة: تحرير غير مملوك ⇒ `ok=0 err=288`،
    /// وتحرير ثانٍ بعد تحريرٍ ناجح ⇒ `ok=0 err=288` كذلك). وتحرير الـmutex
    /// **أكثر** من مرّات الاكتساب لا يزيد عدّاداً — فلا فتحة زائدة من هذا
    /// الطريق أصلاً. والذي يحمي فعلاً صنفان لا ثالث لهما:
    /// (١) **`!Send` على الحارس** (`PhantomData<*const ()>`) فيستحيل تحريره من
    /// خيط غير مالكه؛ (٢) **حارس الاكتساب التراكبي** (`held_counts`) فيردّ طلب
    /// الخيط لما يحمله قبل أي نداء نواة. وحادثٌ لم يُقَس لا يُوثَّق كخطر.
    ///
    /// **وحدّان مقيسان على القياس نفسه** (كلٌّ منهما أسقط نسخةً من هذا الحارس
    /// على شيفرة سليمة، فسُجّلا في التوثيق لا في الظنّ):
    /// 1. **لا محاولتين على خيط واحد**: حارس السقف الكامل يردّ الرمز الثاني من
    ///    الخيط الذي يحمل رمزاً **تراكبياً**، فأي خيط يقتصر على فتحة واحدة ⇒
    ///    القياس على خيط واحد يعطي «1» أبداً. فكل محاولة على **خيطها**.
    /// 2. **ولا قياس على الخيط الحامل**: سجلّ `held_counts` `thread_local`،
    ///    فخيط يحمل رمزاً يردّه حارسه تراكبياً فلا يرى الميزانية كاملة.
    #[test]
    fn releasing_gives_back_exactly_the_tokens_that_were_taken() {
        let _lock = registry_lock();
        let name = unique_name("release-exact");

        // (١) **سقف 1** يأخذ **الرمزين**: لا فتحة فورية وهو حيّ، والاثنان
        // يعودان بعد إسقاطه.
        let exclusive = acquire_named(&name, 1, Duration::from_secs(5)).expect("الرمزان");
        assert_budget(&name, &[false], "حارس الحصرية يحمل الرمزين");
        drop(exclusive);
        assert_budget(&name, &[true, true, false], "بعد إسقاط حارس الحصرية");

        // (٢) **الرمز الثاني** (`-b`): الخيط الحاجز يأخذ الأدنى (`-a`)، فيبقى
        // الثاني لخيط الاختبار. والانتظار على **إشعار الاكتساب** لا على نوم.
        let (a_held, a_release) = acquire_holding_on_thread(&name, MAX_LIMIT);
        a_held.recv().expect("خيط الحجز أخذ الرمز الأول فعلاً");
        let first = acquire_named(&name, MAX_LIMIT, Duration::from_secs(5))
            .expect("الرمز الثاني حرّ ما دام الأول بيد غيرك");
        assert!(
            held_count(&kernel::token_name(&name, 1)) > 0,
            "هذا القسم يقيس مسار الرمز **الثاني** (`held[1]`): يجب أن يكون هو بيد خيط الاختبار"
        );
        // الرمزان محجوزان الآن (واحد هنا وواحد هناك) ⇒ لا فتحة فورية.
        assert_budget(&name, &[false], "الرمزان محجوزان: واحد هنا وواحد هناك");
        drop(first);
        assert_budget(&name, &[true, false], "بعد إسقاط حارس الرمز الثاني");
        a_release.wait();
        assert_budget(&name, &[true, true, false], "بعد تحرير الرمز الأول من خيطه");

        // (٣) **الرمز الثاني** (`-b`): الخيط الآخر يأخذ `-a` أولاً، ثم يأخذ
        // (٣) **الرمز الأول** (`held[0]`): الأدوار معكوسة. الزوج حرّ تماماً،
        // فيأخذ **خيط الاختبار** الأدنى (`-a`, و`held[0] = true`)، ثم يأخذ
        // الخيط الآخر الباقي (`held[1]`) — فالمسار المقيس هنا هو `held[0]`،
        // وهو المسار الذي **لا** يمسّه مُفسَد `i == 0` إلا بأن يترك الرمز
        // المأخوذ بلا تحرير (فيسقط هذا القسم).
        let second = acquire_named(&name, MAX_LIMIT, Duration::from_secs(5)).expect("رمز حرّ");
        assert!(
            held_count(&kernel::token_name(&name, 0)) > 0,
            "هذا القسم يقيس مسار الرمز **الأول** (`held[0]`): يجب أن يكون هو بيد خيط الاختبار"
        );
        // والرمز الآخر يُحجَز على **خيط يبقى حيّاً** حتى يُطلَق: القياس على أثر
        // انتهاء خيط كان يحمله يقيس زوجاً حرّاً لا زوجاً محجوزاً (وقد وقع ذلك
        // فعلاً: `acquire_measured_on_thread` تُسقط حارسها لحظة انتهائها).
        let (b_held, b_release) = acquire_holding_on_thread(&name, MAX_LIMIT);
        b_held.recv().expect("خيط الحجز أخذ الرمز الباقي فعلاً");
        assert_budget(&name, &[false], "الرمزان محجوزان: واحد هنا وواحد هناك");
        drop(second);
        assert_budget(&name, &[true, false], "بعد إسقاط حارس الرمز الأول");
        b_release.wait();
        assert_budget(&name, &[true, true, false], "بعد تحرير الرمز الآخر من خيطه");
    }

    /// **مسار المهلة على الزوج** (وهو ما يجعل الحصرية آمنة): مهمّة بسقف 1
    /// تنتهي مهلتها ومهمّة أخرى تحمل رمزاً ⇒ **لا تتغيّر حالة الرمزين**:
    /// مهمّة تالية بسقف 2 تنجح **فوراً**، وبعد تحرير الرمزين تنجح الحصرية فوراً.
    /// (و`bWaitAll = TRUE` لا يجزّئ الاكتساب، فهذا ليس تفصيلاً بل خاصّية.)
    ///
    /// وكل طلب يقع على **خيط مستقلّ**: الملكيّة ملكيّة خيط، فطلبُ الخيط نفسه
    /// ما يحمله يُرفض تراكبياً لا بمهلة (وذلك مُقاس في اختباره الخاصّ).
    #[test]
    fn an_exclusive_timeout_leaves_the_tokens_untouched() {
        let _lock = registry_lock();
        let name = unique_name("excl-timeout");

        // مهمّة بسقف السقف الكامل تحمل رمزاً واحداً (والثاني حرّ) — على هذا
        // الخيط، فلا يمنع خيط المنتظر شيئاً.
        let held = acquire_named(&name, MAX_LIMIT, Duration::from_secs(5)).expect("رمز حرّ");

        // مهمّة بسقف 1: تحتاج الرمزين ⇒ مهلة صريحة بلا أي أثر على الزوج.
        let (ok, err, waited) = acquire_measured_on_thread(&name, 1, Duration::from_millis(300));
        assert!(!ok, "سقف 1 مع رمز محجوز لا ينجح");
        assert!(
            err.contains("انتهت مهلة انتظار فتحة الفصل"),
            "رسالة عربية صريحة: {err}"
        );
        assert!(
            waited >= Duration::from_millis(250) && waited < Duration::from_secs(5),
            "انتظر المهلة المطلوبة لا أكثر ({waited:?})"
        );

        // الدليل أن المنتظر الفاشل **لم يأخذ شيئاً**: الرمز الثاني ما زال حرّاً.
        // ويُمسَك على خيط آخر **مدّة** (لا نداءً عابراً): وإلا لتحرّر قبل حكم
        // «الرمزان محجوزان» فصار الحكم على زوج حرّ — قياس بلا موضوع.
        let second = acquire_held_on_thread(&name, MAX_LIMIT, Duration::from_millis(600));
        // ننتظر قليلاً حتى يقع الاكتساب فعلاً قبل الحكم (لا مصادفة جدولة).
        std::thread::sleep(Duration::from_millis(100));

        // وفحص العكس: الرمزان محجوزان الآن ⇒ حصرية ثانية تنتهي مهلتها.
        // (وطلبها على هذا الخيط مرفوض تراكبياً — فيُقاس على خيط آخر.)
        let (ok3, err3, waited3) = acquire_measured_on_thread(&name, 1, Duration::from_millis(200));
        assert!(!ok3, "الرمزان محجوزان ⇒ لا حصرية ثانية (خطأ: {err3})");
        assert!(
            waited3 >= Duration::from_millis(150),
            "الحصرية انتظرت مهلتها كاملة ({waited3:?})"
        );

        // بعد التحرير: الحصرية تنجح فوراً — لا رمز ضاع ولا رمز زاد.
        assert!(second.join().unwrap_or(false), "الرمز الثاني أُخذ فعلاً");
        drop(held);
        let (ok4, err4, waited4) = acquire_measured_on_thread(&name, 1, Duration::from_secs(5));
        assert!(ok4, "الرمزان حُرّان بعد التحرير: {err4}");
        assert!(
            waited4 < Duration::from_secs(1),
            "بلا انتظار بعد التحرير ({waited4:?})"
        );
    }

    /// الذعر لا يسرّب **الفتحة** (لا السِجلّ وحده): الحارس يتحرّر أثناء فكّ
    /// المكدّس، فما بعده يجد السقف كاملاً وفوراً. وهذا هو الفرق العملي بين
    /// حارس RAII وعلمٍ يُصفَّر في آخر سطر من الدالة — الأخير يُتخطّى بالذعر.
    #[test]
    fn a_panicking_job_still_frees_its_slot() {
        let _lock = registry_lock();
        let name = unique_name("panic");
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {})); // ذعر متوقَّع: لا نُلوّث الخرج
        let caught = std::panic::catch_unwind(|| {
            let _ = run_registered::<()>(&name, "panic-holder", None, |_| panic!("ذعر مصطنع"));
        });
        std::panic::set_hook(previous_hook);
        assert!(caught.is_err(), "الذعر وقع فعلاً");

        // السقف كامل من جديد: تُكتسب فتحتان (وهما السقف) بلا انتظار.
        let started = std::time::Instant::now();
        let mut held = Vec::new();
        for i in 0..current_limit() {
            held.push(
                acquire_named(&name, current_limit(), Duration::from_secs(5))
                    .unwrap_or_else(|e| panic!("الفتحة رقم {i} لم تُتح بعد الذعر: {e}")),
            );
        }
        assert_eq!(held.len(), current_limit() as usize, "السقف كامل بعد الذعر");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "بلا انتظار: الفتحة كانت حرّة فعلاً ({:?})",
            started.elapsed()
        );
    }
}
