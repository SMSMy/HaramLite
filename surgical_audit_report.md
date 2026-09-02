# 🔬 تقرير الفحص الجراحي — HaramLite v0.2.0

> **التاريخ:** 2026-09-01  
> **الفاحص:** Antigravity (3 فاحصين متوازيين)  
> **النطاق:** Rust Backend · Frontend (Tauri) · Browser Extension (MV3)  
> **إجمالي المشاكل:** 20 مشكلة (3 حرجة · 6 عالية · 6 متوسطة · 5 منخفضة)

---

## 📊 ملخص تنفيذي

**السبب الرئيسي للبطء الشديد** يعود إلى **3 مشاكل حرجة متضافرة**:

| # | المشكلة | الأثر |
|---|---------|-------|
| 🔴 R-1 | حلقة `O(N × look_len)` بعملية `%` في الـ Limiter | **+15-20 ثانية** على مرحلة المؤثرات |
| 🔴 R-2 | `ort::init()` يُقفل بـ DirectML — تبديل CUDA يسقط للـ CPU | **الفصل يتضاعف عدة مرات** |
| 🔴 E-1 | `sendNativeMessage` تُنشئ وتُدمّر عملية كل 1.5 ثانية | **حمل CPU/Disk مستمر** |

> [!CAUTION]
> المشكلتان R-1 و R-2 وحدهما كافيتان لتحويل عملية كانت تأخذ 45 ثانية إلى عدة دقائق.

---

## ✅ حالة المعالجة — عولجت المشاكل العشرون جميعها

| # | الحالة | الإصلاح المطبق |
|---|---|---|
| R-1 | ✅ | Limiter بـ **Rolling Maximum (monotonic deque)** — O(N) بدل O(N×look_len)+`%`؛ مسبار: 10.5M عينة من +15-20ث إلى **0.70ث (debug)**؛ اختبار انحدار bit-exact مقابل الخوارزمية القديمة (`dynamics.rs`) |
| R-2 | ✅ | **تصحيح بعد الاختبار الميداني**: بيئة ORT تُلزم **مرة واحدة عند الإقلاع بلا أي مزوّد** (`separator::init_ort_env()`) — التسجيل على مستوى البيئة + الجلسة معاً كان يسبب «Provider DmlExecutionProvider has already been registered» → CPU؛ الاختيار يتم على مستوى الجلسة (CUDA → DML → CPU بتحذيرات صادقة)، وأُلغي ربط `env_cuda`/`restart_required` لأن تسجيل الجلسة لا يحتاج إعادة تشغيل (`separator.rs`/`lib.rs`/`main.ts`) |
| R-3 | ✅ | K-weighting على **القناة كاملة** أولاً ثم حساب طاقة النوافذ؛ اختبار انحدار (نبضة على حد hop) يثبت الاستمرارية (`loudness.rs`) |
| R-4 | ✅ | `%` → فرع `if` في PingpongDelay **و** Comb **و** Allpass (كانت كلها per-sample idiv) (`reverb_delay.rs`) |
| R-5 | ✅ | `cut_silence_with_ranges` — النطاقات تحسب مرة في `effects.rs` وتمرر (`silence.rs`/`effects.rs`) |
| F-1 | ✅ | MemoryLayer يدفع حدث `log-line` عبر `attach_emitter`؛ حذف `setInterval(refresh, 700)` (`logging.rs`/`lib.rs`/`main.ts`) |
| F-2 | ✅ | تخزين مرجع العنصر النشط + أبنائه في sep-progress (استعلام DOM واحد عند التبدّل فقط) (`main.ts`) |
| F-3 | ✅ | إيقاف الدفعة يستدعي `invoke('cancel_process')` — يلغي الملف الجاري فوراً (`main.ts`) |
| F-4 | ✅ | زر الفصل يتحول إلى «⏹ إلغاء» أثناء المعالجة المفردة (`singleRunning`) (`main.ts`) |
| F-5 | ✅ | `clearTimeout` قبل جدولة إخفاء سطر المرحلة وبطاقة الجسر (`main.ts`) |
| F-6 | ✅ | حذف مستمعي keydown/change/paste الميتين على `input[type=hidden]` (`main.ts`) |
| F-7 | ✅ | كائن `Audio` واحد يعاد استخدامه بـ `currentTime = 0` (`main.ts`) |
| F-8 | ✅ | حذف الاستعلام الميت عن `option[value="mp4video"]` (`main.ts`) |
| E-1 | ✅ | `connectNative` منفذ دائم واحد + مضيف stdio بحلقة مستمرة (يقرأ حتى EOF) + إعادة اتصال عند موت الـ SW + timeout أمان 10ث (`background.js`/`bridge.rs`) |
| E-2 | ✅ | عدّاد فشل متتالٍ (8) في content.js وpopup.js → وقف الاستفسار + رسالة انقطاع |
| E-3 | ✅ | `yt-navigate-finish` + MutationObserver مخفف (debounce 200ms) يعيدان حقن الزر |
| E-4 | ✅ | `panelEls = null` عند إغلاق اللوحة (`content.js`) |
| E-5 | ✅ | Debounce قائمة السياق 1.5ث لكل (عنصر+رابط) فوق dedup الخلفي (`background.js`) |
| E-6 | ✅ | حارس `sawRunning` — لا تُعرض «اكتملت» لمهمة قديمة قبل رؤية المهمة الحالية تعمل (`popup.js`/`content.js`) |
| E-7 | ✅ | `menuCloser` يُحفظ ويُزال مع إغلاق القائمة (`content.js`) |

## 🔧 جولة الاختبار الميداني (اكتشفها المالك أثناء الاختبار الفعلي)

| # | المشكلة | الإصلاح |
|---|---|---|
| **Bug A** | طلب متصفح عالج **مخرجاً سابقاً** بدل الفيديو الأصلي: فرع «has already been downloaded» في محلل `download_media` كان غير قابل للوصول (فرع `[download]` الأول يبتلعه)، فسقط الكود على fallback «أحدث ملف وسائط في المجلد» — الذي أعاد مخرج المعالجة السابقة؛ النتيجة: قص صمت 0.0% ولاحقة مزدوجة `(Clean)_haramlite_(Clean)_haramlite` | معالجة السطر قبل محلل النسبة + **حذف fallback التخمين نهائياً** + اختبار انحدار (`yt_dlp.rs`) |
| **Bug B** | انحراف أسماء العناوين: yt-dlp يطبع مسار «منزّل بالفعل» **بلا** علامات الاقتباس العريضة (U+FF02) بينما الملف على القرص بها → فحص الوجود يفشل → «تعذر تحديد ملف الناتج» | إذا لم يوجد المسار المطبوع → **تنزيل إجباري** (`--force-overwrites`) والتقاط الملف النهائي من سطر `[Merger] Merging formats into` + اختبار انحدار |
| **Bug C** | لوحة الإضافة تعرض زر «إلغاء» بعد اكتمال المعالجة (بلا معنى) ولا تقدم فتحاً مباشراً للمخرج | زر «▶ فتح الفيديو» جديد + إخفاء الإلغاء عند الاكتمال + بروتوكول مضيف `open_file` يقرأ المسار من حالة التطبيق نفسها (المتصفح لا يمرر مسارات) + حالة الجسر تتضمن `video` (`content.js`/`bridge.rs`) |
| **Bug D** | إطلاق التطبيق أثناء عمل نسخة مخفية (من `--hidden-start`) يخرج بصمت دون أي نافذة — «شغّل البرنامج» بلا نتيجة | النسخة الثانية ترسل بايت `0x01` عبر مقبس single-instance → النسخة العاملة تُظهر نافذتها وتُركّزها؛ مجسات الجسر (اتصال بلا بيانات) تُتجاهل (`lib.rs`) |
| **Bug E** | رسالة اكتمال الجسر تعرض اسم **المدخل** (الملف المنزّل) لا المخرج | تُعرض اسم المخرج النهائي في الحالة والإشعار (`bridge.rs`) |

> **تحقق شامل:** `cargo test --lib` → 25/25 ناجحة (منها 4 انحدارات جديدة) وصفر تحذيرات؛ `pnpm exec tsc --noEmit` نظيف؛ `pnpm tauri build` أنتج حزمتي NSIS (219.5MB) وMSI (424.3MB) وتثبيت صامت نجح والتطبيق المثبت يعمل — توقيع updater محلياً يحتاج كلمة مرور المفتاح (تُضبط في أسرار CI).

---

## 🔴 حرج (CRITICAL) — 3 مشاكل

---

### R-1 · حلقة الـ Limiter بطيئة بشكل كارثي

| | |
|---|---|
| **الملف** | [dynamics.rs](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src-tauri/src/dynamics.rs) — الأسطر 81-86 |
| **التصنيف** | أداء |
| **الوحدة** | Rust Backend → DSP → Limiter |

**المشكلة:**  
حلقة البحث عن القمة (peak) في `Limiter::process` تستخدم خوارزمية `O(N × look_len)` مع عملية **modulo (`%`)** في الحلقة الداخلية:

```rust
let j = (self.pos + k) % self.look_len;
```

**لماذا هذا كارثي؟**
- ملف 4 دقائق ستيريو ≈ **10.5 مليون عينة**
- `look_len = 220` (5ms بمعدل 44100Hz)
- المجموع: **2.3 مليار** عملية modulo
- عملية `idiv` على الـ CPU تأخذ **15-20 دورة** (cycle)
- **النتيجة: +15-20 ثانية إضافية** على مرحلة المؤثرات فقط

**الحل:**
1. استبدل `%` بـ `if` بسيطة:
   ```rust
   self.idx += 1;
   if self.idx >= self.look_len { self.idx = 0; }
   ```
2. **الأفضل:** استخدم خوارزمية **Rolling Maximum** (deque-based) لتحويلها إلى `O(N)` بدل `O(N × look_len)`

---

### R-2 · `ort::init()` يُقفل البيئة — تبديل CUDA لا يعمل فعلياً

| | |
|---|---|
| **الملف** | [separator.rs](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src-tauri/src/separator.rs) — الأسطر 175-186 |
| **التصنيف** | بق + أداء |
| **الوحدة** | Rust Backend → Separator → ORT Init |

**المشكلة:**  
`ort::init()` يُستدعى داخل `MdxSession::load` (أي مع كل ملف). لكن ORT يُقفل البيئة عند أول `commit()` ويتجاهل كل الاستدعاءات التالية بصمت:

```rust
let _ = ort::init()  // يُتجاهل إذا سبق تهيئته!
    .with_execution_providers([...])
    .commit();
```

**السيناريو القاتل:**
1. تفتح التطبيق ← ORT يتهيأ بـ **DirectML فقط** (بدون CUDA)
2. تضغط زر CUDA الذكي الجديد ← تُفعّل CUDA
3. تُعالج ملف ← `ort::init()` **يفشل بصمت** ← يسقط للـ **CPU**
4. الفصل الذي كان يأخذ 10 ثواني يأخذ الآن **دقائق**!

**الحل:**
- انقل `ort::init()` إلى `lib.rs` عند بدء التطبيق
- أو أعد تشغيل التطبيق بالكامل عند تغيير إعداد CUDA (مع رسالة للمستخدم)

---

### E-1 · إضافة المتصفح تُنشئ عملية Native Host كل 1.5 ثانية

| | |
|---|---|
| **الملف** | [background.js](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/browser-extension/background.js) — الأسطر 30-40 |
| **التصنيف** | أداء |
| **الوحدة** | Browser Extension → Native Messaging |

**المشكلة:**  
الإضافة تستخدم `chrome.runtime.sendNativeMessage()` (رسائل لمرة واحدة) بدل `chrome.runtime.connectNative()` (اتصال مستمر). بما أن `content.js` و `popup.js` يستفسران عن التقدم كل 1.5 ثانية:

> **كل 1.5 ثانية** → يُنشأ process جديد → يُقرأ stdin → يُكتب stdout → يموت الـ process

**الأثر:**
- حمل مستمر على CPU والقرص حتى بدون معالجة
- استحالة التواصل الحقيقي في الوقت الفعلي
- إبطاء المعالجة الفعلية بسبب المنافسة على الموارد

**الحل:**
استخدم `chrome.runtime.connectNative()` لإنشاء **port مستمر** واحد، وأرسل/استقبل الرسائل عبره.

---

## 🟠 عالي (HIGH) — 6 مشاكل

---

### R-3 · قياس LUFS فاسد — المرشحات تتغذى على بيانات متكررة

| | |
|---|---|
| **الملف** | [loudness.rs](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src-tauri/src/loudness.rs) — الأسطر 50-55 |
| **التصنيف** | خطأ منطقي |
| **الوحدة** | Rust Backend → DSP → Loudness |

**المشكلة:**  
مرشحات K-weighting (`kl`, `kr`) **ذات الحالة** (stateful IIR) تُعالج داخل حلقة النوافذ المتداخلة. النافذة تتقدم بـ 100ms (`hop`) لكنها تُعالج 400ms (`block`). هذا يعني:

- **300ms من العينات** تُغذّى للمرشح مرتين+ بدون إعادة ضبط
- حالة المرشح تقفز **للخلف في الزمن** 300ms كل دورة
- **النتيجة:** قياسات LUFS خاطئة تماماً ← تطبيع الصوت غير صحيح

**الحل:**
طبّق المرشحات على **القناة كاملة أولاً** خارج حلقة النوافذ، ثم احسب الطاقة على النتيجة المُرشّحة.

---

### F-1 · استفسار السجلات كل 700ms بلا توقف

| | |
|---|---|
| **الملف** | [main.ts](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src/main.ts) — السطر 1523، الأسطر 236-243 |
| **التصنيف** | أداء |
| **الوحدة** | Frontend → Polling |

**المشكلة:**  
```typescript
setInterval(refresh, 700);  // يستدعي invoke('get_recent_logs') للأبد
```

حتى عندما لا يوجد أي معالجة، الـ Frontend يستدعي الـ Backend **1.4 مرة في الثانية** عبر IPC. هذا يُشغل الـ Backend ويُبقي الـ main thread مشغولاً دائماً.

**الحل:**
استخدم أحداث Tauri (`emit`) من الـ Backend لدفع السجلات عند حدوثها فقط.

---

### F-2 · استعلام DOM متكرر في كل tick تقدم

| | |
|---|---|
| **الملف** | [main.ts](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src/main.ts) — الأسطر 945-966 |
| **التصنيف** | أداء |
| **الوحدة** | Frontend → Event Handlers |

**المشكلة:**  
أحداث `sep-progress` و `sep-stage` تُطلق بتردد عالٍ جداً. كل إطلاق يستدعي:
```typescript
document.querySelector(...)  // بحث في DOM كل مرة!
document.getElementById(...)
```

**الحل:**
خزّن مراجع العناصر في متغيرات عند بدء المهمة:
```typescript
const barEl = document.getElementById('sep-bar');
// استخدم barEl مباشرة
```

---

### F-3 · إيقاف الدُفعة لا يُلغي الملف الحالي

| | |
|---|---|
| **الملف** | [main.ts](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src/main.ts) — الأسطر 997-1004 |
| **التصنيف** | خطأ منطقي |
| **الوحدة** | Frontend → Batch Processing |

**المشكلة:**  
زر "⏸ إيقاف" يضبط `batchAbort = true` فقط، مما يمنع بدء الملف **التالي**. لكنه **لا يُلغي** الملف **قيد المعالجة حالياً** لأنه لا يستدعي:
```typescript
invoke('cancel_process')  // مفقود!
```

**النتيجة:** المستخدم يضغط إيقاف ويظن أنه توقف، لكنه يجب أن ينتظر انتهاء الملف الحالي (قد يأخذ دقائق).

---

### E-2 · استفسار لا نهائي عند انقطاع Native Host

| | |
|---|---|
| **الملف** | [content.js](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/browser-extension/content.js) سطر 204، [popup.js](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/browser-extension/popup.js) سطر 81 |
| **التصنيف** | خطأ منطقي + أداء |
| **الوحدة** | Browser Extension → Polling |

**المشكلة:**  
إذا انقطع الـ Native Host أو تعطل، كتل `catch` تبتلع الخطأ بصمت:
```javascript
catch(e) { /* bridge unreachable — keep polling */ }
```
الـ `setInterval` يستمر في المحاولة كل 1.5 ثانية **للأبد**.

**الحل:**
أضف عدّاد فشل متتالي. بعد 5-10 محاولات فاشلة → أوقف الاستفسار واعرض رسالة خطأ.

---

### E-3 · زر الإضافة يختفي عند التنقل داخل YouTube (SPA)

| | |
|---|---|
| **الملف** | [content.js](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/browser-extension/content.js) — الأسطر 209-220 |
| **التصنيف** | خطأ منطقي |
| **الوحدة** | Browser Extension → Content Script |

**المشكلة:**  
YouTube هو SPA (تطبيق صفحة واحدة). الكود يحقن الزر مرة واحدة عبر `setInterval` يتوقف بعد 120 ثانية أو عند أول نجاح. عند التنقل لفيديو آخر **بدون إعادة تحميل**، عناصر المشغّل تُعاد بناؤها والزر يختفي.

**الحل:**
استمع لحدث `yt-navigate-finish` أو استخدم `MutationObserver` على حاوية المشغّل.

---

## 🟡 متوسط (MEDIUM) — 6 مشاكل

---

### R-4 · عملية modulo في حلقة PingpongDelay

| | |
|---|---|
| **الملف** | [reverb_delay.rs](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src-tauri/src/reverb_delay.rs) — الأسطر 136-144 |
| **التصنيف** | أداء |
| **الوحدة** | Rust Backend → DSP → Delay |

مثل R-1 بالضبط: `% self.buf_l.len()` في حلقة per-sample. يهدر **~150 مليون دورة CPU** لكل أغنية.

**الحل:** استبدل بـ `if idx >= len { idx = 0; }`

---

### F-4 · زر إلغاء مفقود للملف المفرد

| | |
|---|---|
| **الملف** | [main.ts](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src/main.ts) — الأسطر 1048-1050 |
| **التصنيف** | واجهة ناقصة |
| **الوحدة** | Frontend → Single File UI |

عند معالجة ملف مفرد، زر "فصل" يُعطّل فقط (`btn.disabled = true`). لا يتحول لزر إلغاء كما في وضع الدُفعة. **الطريقة الوحيدة للإلغاء** هي زر أحمر صغير في قائمة الدُفعة — تجربة استخدام غير متسقة.

---

### F-5 · سباق Timeouts في مراحل المعالجة وبطاقة الجسر

| | |
|---|---|
| **الملف** | [main.ts](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src/main.ts) — الأسطر 956-957، 1439-1440 |
| **التصنيف** | بق مخفي |
| **الوحدة** | Frontend → UI Timers |

**المشكلة:**
- **سطر المرحلة:** عند وصول المرحلة لـ 100%، timeout بـ 1200ms يُخفي السطر. في دُفعة، الملف التالي يبدأ فوراً لكن الـ timeout القديم **لم يُلغَ** ← السطر يختفي عشوائياً أثناء الملف الثاني.
- **بطاقة الجسر:** `setTimeout` يُخفي بطاقة "افتح المجلد" بعد 8000ms. إذا انتهى ملف ثانٍ بعد 4 ثواني، الـ timeout الأول يُخفي البطاقة قبل أوانها.

**الحل:** احفظ الـ timeout ID واستدعِ `clearTimeout()` قبل ضبط timeout جديد.

---

### F-6 · كود ميت — Auto-Probe على input مخفي

| | |
|---|---|
| **الملف** | [main.ts](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src/main.ts) — الأسطر 1467-1471، [index.html](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/index.html) سطر 340 |
| **التصنيف** | خطأ منطقي |
| **الوحدة** | Frontend → Input Handling |

**المشكلة:**
أحداث `keydown` و `change` و `paste` مُسجلة على `pathInputEl`، لكنه عنصر `<input type="hidden">`. العناصر المخفية لا يمكن التركيز عليها أو الكتابة فيها ← **كود ميت تماماً**.

---

### E-4 · تسريب مراجع DOM عند إغلاق اللوحة

| | |
|---|---|
| **الملف** | [content.js](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/browser-extension/content.js) — الأسطر 124، 132-138 |
| **التصنيف** | أداء / تسريب ذاكرة |
| **الوحدة** | Browser Extension → Mini Panel |

عند إغلاق اللوحة بـ `panel.remove()`، الكائن `panelEls` يحتفظ بمراجع لكل العناصر الداخلية (name, bar, status, open, cancel) مما يمنع جمع القمامة.

**الحل:** اضبط `panelEls = null` عند الإغلاق.

---

### E-5 · سباق في قائمة السياق (Context Menu)

| | |
|---|---|
| **الملف** | [background.js](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/browser-extension/background.js) — الأسطر 42-51 |
| **التصنيف** | خطأ منطقي |
| **الوحدة** | Browser Extension → Context Menu |

لا يوجد debouncing على قائمة السياق. نقرات سريعة متعددة تُرسل رسائل مكررة للـ Native Host، مما قد يُفسد الطابور.

---

## 🟢 منخفض (LOW) — 5 مشاكل

---

### R-5 · حساب مزدوج لنطاقات الصمت

| | |
|---|---|
| **الملف** | [effects.rs](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src-tauri/src/effects.rs) سطر 85-86، [silence.rs](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src-tauri/src/silence.rs) سطر 111 |
| **التصنيف** | أداء |

`compute_kept_ranges` تُحسب مرتين: مرة في `effects.rs` ومرة داخل `cut_silence`. مرّر النطاقات المحسوبة مسبقاً.

---

### F-7 · تسريب كائنات Audio

| | |
|---|---|
| **الملف** | [main.ts](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src/main.ts) — الأسطر 290-292 |
| **التصنيف** | أداء |

`playDing()` يُنشئ `new Audio()` كل مرة. في دُفعات سريعة، تتراكم كائنات غير محررة.

**الحل:** أنشئ كائن `Audio` واحد وأعد استخدامه بـ `currentTime = 0`.

---

### F-8 · كود ميت — خيار mp4video غير موجود

| | |
|---|---|
| **الملف** | [main.ts](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/src/main.ts) — السطر 585 |
| **التصنيف** | خطأ منطقي |

`querySelector('#fmt-select option[value="mp4video"]')` يبحث عن خيار غير موجود في HTML ← يفشل بصمت.

---

### E-6 · حالة قديمة عند فتح Popup

| | |
|---|---|
| **الملف** | [popup.js](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/browser-extension/popup.js) — الأسطر 55-80 |
| **التصنيف** | واجهة |

عند فتح الـ popup، إذا كانت مهمة سابقة قد انتهت، يظهر "اكتمل" فوراً لمهمة قديمة بدل واجهة الخمول.

---

### E-7 · تسريب مستمع أحداث Document

| | |
|---|---|
| **الملف** | [content.js](file:///c:/Code-backup/HaramMute%20Desktop%20III/haramlite-rs/browser-extension/content.js) — الأسطر 90-93 |
| **التصنيف** | أداء |

مستمع `click` على `document` لإغلاق القائمة لا يُزال عند الإغلاق اليدوي.

---

## 🎯 خريطة الأولويات

```
أولوية فورية (تُصلح البطء):
┌──────────────────────────────────────────────────────────────┐
│  R-1  حلقة Limiter بـ modulo    → Rolling Max أو if بدل %  │
│  R-2  ort::init() مقفل         → انقله لبدء التطبيق        │
│  R-3  LUFS فاسد                → طبّق الفلاتر أولاً        │
└──────────────────────────────────────────────────────────────┘

أولوية عالية (تجربة استخدام وأخطاء):
┌──────────────────────────────────────────────────────────────┐
│  E-1  sendNativeMessage        → connectNative              │
│  F-1  polling كل 700ms         → Tauri events               │
│  F-3  إلغاء الدُفعة ناقص      → أضف cancel_process         │
│  E-2  polling لا نهائي         → عدّاد فشل                  │
│  E-3  زر يختفي بـ SPA          → MutationObserver           │
│  F-2  DOM queries متكررة       → تخزين مؤقت                 │
└──────────────────────────────────────────────────────────────┘

أولوية متوسطة (تنظيف):
┌──────────────────────────────────────────────────────────────┐
│  R-4  modulo في Delay          → if بدل %                   │
│  F-4  زر إلغاء مفرد مفقود     → حوّل الزر                  │
│  F-5  سباق Timeouts            → clearTimeout               │
│  F-6  كود ميت auto-probe      → احذفه                      │
│  E-4  تسريب DOM                → null عند الإغلاق           │
│  E-5  سباق Context Menu       → debounce                   │
└──────────────────────────────────────────────────────────────┘

أولوية منخفضة:
┌──────────────────────────────────────────────────────────────┐
│  R-5, F-7, F-8, E-6, E-7      → إصلاحات بسيطة             │
└──────────────────────────────────────────────────────────────┘
```

---

## 📐 تقدير الأثر على الأداء

| المشكلة | الوقت المُهدر (مقطع 4 دقائق) |
|---------|-------------------------------|
| R-1 (Limiter modulo) | **+15-20 ثانية** |
| R-2 (ORT CPU fallback) | **+2-5 دقائق** (إذا سقط للـ CPU) |
| R-4 (Delay modulo) | **+1-2 ثانية** |
| R-5 (حساب مزدوج) | **+0.5 ثانية** |
| F-1 (polling 700ms) | حمل مستمر على IPC |
| E-1 (process كل 1.5s) | حمل مستمر على CPU/Disk |

> [!IMPORTANT]
> **إذا أصلحت R-1 و R-2 فقط**، ستعود السرعة لما كانت عليه تقريباً.
> إصلاح E-1 و F-1 سيُحسّن الاستجابة العامة للتطبيق والإضافة بشكل ملحوظ.
