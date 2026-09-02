# NEXT_STEPS.md — خارطة ما تبقى لـ HaramLite 0.2.0

> وثيقة التسليم للمحادثة الجديدة. الوضع الحالي: الخطة الأصلية (A→F) مكتملة،
> **وإصلاحات التقرير الجراحي (الأولويات 1–3) مكتملة ✓ — 20/20 مشكلة عولجت**،
> الاختبارات 23/23 ناجحة، `tsc` نظيف، وصفر تحذيرات Rust.
> المرجع الكامل للإنجازات: `IMPLEMENTATION_PLAN.md` — والتفاصيل الفنية: `surgical_audit_report.md`.

---

## ✅ الأولوية 1 — إصلاحات البطء (من التقرير الجراحي) — **مكتملة**

| # | الإصلاح | الحالة |
|---|---|---|
| R-1 | Limiter: استُبدلت حلقة `O(N × look_len)` بـ **Rolling Maximum (deque) — O(N)** وبدون أي `%` | ✅ **10.5M عينة: من +15-20ث إلى 0.70ث في debug** (~25×) |
| R-4 | PingpongDelay + Comb + Allpass: `%` → فرع `if` (لا idiv لكل عينة) | ✅ |
| R-2 | `ort::init()` **مرة واحدة عند الإقلاع** (init_ort_env) + شارة CUDA صادقة (`env_cuda`/`restart_required`) + رسالة إعادة تشغيل عند التبديل | ✅ |
| R-3 | LUFS: K-weighting على **القناة كاملة** أولاً ثم النوافذ (لا قفز للحالة 300ms للخلف) | ✅ |
| R-5 | نطاقات الصمت تحسب **مرة واحدة** وتمرر إلى القص | ✅ |

## ✅ الأولوية 2 — أحمال دائمة وأخطاء UX — **مكتملة**

| # | الإصلاح | الحالة |
|---|---|---|
| F-1 | `setInterval(refresh, 700)` → **أحداث دفع `log-line`** من MemoryLayer | ✅ |
| E-1 | `sendNativeMessage` → **`connectNative` منفذ دائم** (مضيف stdio بحلقة مستمرة + port معاد الاتصال عند موت الـ SW) | ✅ |
| E-3 | زر يوتيوب يعاد حقنه مع تنقل SPA (`yt-navigate-finish` + MutationObserver) | ✅ |
| F-3 | إيقاف الدفعة يستدعي `cancel_process` (يلغي الملف الجاري) | ✅ |
| F-4 | زر الفصل يتحول لزر «إلغاء» في المعالجة المفردة | ✅ |
| F-5 | سباق timeouts (سطر المرحلة + بطاقة الجسر) → `clearTimeout` قبل الجديد | ✅ |
| E-2 | عدّاد فشل متتالٍ (8) → وقف الاستفسار + رسالة انقطاع | ✅ |

## ✅ الأولوية 3 — تنظيف سريع — **مكتملة**

F-2 (تخزين مراجع DOM في sep-progress) · F-6 (حذف كود auto-probe الميت على input مخفي) · F-7 (كائن Audio واحد) · F-8 (حذف خيار mp4video الميت) · E-4 (`panelEls = null` عند الإغلاق) · E-5 (debounce قائمة السياق 1.5ث) · E-6 (لا «اكتمل» قديمة — `sawRunning`) · E-7 (إزالة مستمع document مع إغلاق القائمة) · **صفر تحذيرات Rust**.

## 🔵 الأولوية 4 — البناء والنشر

1. ✅ **`pnpm tauri build` نجح** — النواتج:
   - `src-tauri/target/release/bundle/nsis/HaramLite_0.2.0_x64-setup.exe` (219.5 MB)
   - `src-tauri/target/release/bundle/msi/HaramLite_0.2.0_x64_en-US.msi` (424.3 MB)
   - `src-tauri/target/release/HaramLite.exe` (36.3 MB) — فحص `--check` يخرج بالكود 0
2. ✅ **اختبار المثبت**: تثبيت صامت `/S` نجح (مجلد `%LOCALAPPDATA%\HaramLite` + اختصار قائمة ابدأ `Programs\HaramLite.lnk` — شرط إشعارات Windows/AUMID)، والنسخة **المثبتة** تعمل وتُغلق برشاقة.
   - ⚠ **التوقيع محلياً يعلق على كلمة مرور**: `updater.key` مفتاح **مشفّر** («rsign encrypted secret key») — البناء المحلي الكامل يحتاج كتابة كلمة المرور تفاعلياً، ولهذا لم يتولّد `latest.json`/`.sig` في هذه الجلسة (قُتل البناء بعد إنتاج الحزمتين).
3. **GitHub (إجراء المالك)**: رفع الكود + وسم `v0.2.0` + السرّان `TAURI_SIGNING_PRIVATE_KEY` (= محتوى `updater.key`) **و** `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (المفتاح محمي بكلمة مرور — فك التعليق في release.yml) + أول تشغيل CI (ينشئ assets-v1 تلقائياً). بعدها يعمل التحديث الذاتي كاملاً.

## 🟣 الأولوية 5 — الميزات الكبيرة المتبقية

| الميزة | الحالة |
|---|---|
| **الاستماع المباشر** (بث صوت يوتيوب لحظياً ومعالجته وإعادته) | مشروع هندسي كبير: AudioWorklet + معالجة متدفقة في Rust + connectNative — القائمة تعرضه «قريباً» |
| **التقاط الوسائط من أي صفحة** (`<video>/<audio>` عام خارج yt-dlp) | متوسط |
| **CUDA للجميع بلا تثبيت** (مكوّن `cuda-runtime` ذاتي التنزيل: cublas+cudart+cuDNN كاملة + SetDllDirectory + تراجع آمن CUDA→DML→CPU) | ✅ **نُفذ** (`cuda_runtime.rs` + أمر `install_cuda_runtime` + واجهة التنزيل + خطوتا CI) — تبقى: رفع `assets-v1` من CI والتحقق على RTX 3070 (`CUDA_RUNTIME_PLAN.md`) |
| دعم Firefox رسمياً للإضافة | `browser_specific_settings` |

---

## 🚀 سطر البدء للمحادثة الجديدة
> «نكمل HaramLite حسب NEXT_STEPS.md — تحقق من ناتج `pnpm tauri build`، ثم اختبر المثبت والإشعارات والتحديث الذاتي (الأولوية 4)، وبعدها الميزات الكبيرة (الأولوية 5).»
