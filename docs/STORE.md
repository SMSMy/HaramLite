# HaramLite Bridge — قائمة متجر كروم (جاهزة للنسخ)

> هذه ورقة العمل للنشر: كل حقل مكتوب بنصّه النهائي. المقاسات والملفات في
> `store-assets/` (خارج git). **المنشور في المتجر: 1.1.1 علناً** — بوابة الرفع انفتحت (وافقت قوقل على النسخة الأولى). **1.1.2 رُفعت كتحديث للعنصر القائم في 2026-09-15 وهي قيد مراجعة المتجر** (إصلاح زر المشاهدة + أيقونة جديدة + نافذة جديدة + اختيار الوضع في النافذة). والحزمة المرفوعة `HaramLite-Bridge-1.1.2-chrome.zip` فُحصت مقابل المستودع فجاءت **12/12 ملفاً مطابقة** ⇒ لا حاجة لإعادة رفع. والمتجر يرفض إعادة رفع النسخة نفسها، فأي تعديل لاحق على ملفات التشغيل يوجب رفع **1.1.3**.
>
> **1.1.5 جاهزة للرفع (2026-09-15)**: `HaramLite-Bridge-1.1.5-chrome.zip` — **355696 بايت** · `sha256:236242b1b1bc472cf9cbc1dee45b80c2a98a83631b08161e2ba89d19269270e0` · **١٢ مدخلاً** · مانيفستها **1.1.5** بلا `key` وبلا `browser_specific_settings` · و**`content.js` داخلها مطابق بايتاً ببايت** للمستودع (‏`sha256:9175eccc4fd6c2bad75cf2d5d9594bc7cc6602d55da50a19ebc49f8612852230`). وتضيف على 1.1.2: **السلوك الإجباريّ** (لا خيار للمستخدم — حُذف الصندوق ومفتاح التخزين) · **وضع التسريع** للفجوات المتقاربة (صورة أسرع حتى ٣× **بلا أي `seek`** ⇒ لا وقوف صورة ولا تقدّم صوت) مع بقاء القطع للمعزولة والطويلة · **إصلاح عطل [حرج] في طبقة الأثر** (كان `trace` ينادي نفسه أبداً فلا يصل صفّ قياس) · و**مدرّج أطوال الفجوات** (`hist` و`keptBefore`) في سطر `load`. والقبول الميداني عند المالك **مُنجَز** على 1.1.5 (لقطته المنبثقة تُظهر `v1.1.5`).

## الحزمة (اقرأ هذا أولاً)

الرفع **يرفض** حقل `key` في المانيفست:
`The key field is not allowed in the manifest file` — المتجر يدير معرّف العنصر
بنفسه. لذلك المستودع يحتفظ بالمفتاح (يثبّت معرّف النسخة غير المحزومة التي
يستخدمها التطوير وجسر التطبيق) و**الحزمة المرفوعة تُجرَّد منه**.

```
pnpm pack:ext          # → src-tauri/target/store/HaramLite-Bridge-1.1.2-chrome.zip
pnpm pack:ext:firefox  # للفايرفوكس (يبقي browser_specific_settings)
```

الملف الصحيح للرفع: **`HaramLite-Bridge-1.1.2-chrome.zip`** (المانيفست في الجذر،
بلا `key` ولا `browser_specific_settings`، 9 ملفات).

## تسلسل النشر الأول (مهم — يمنع إضافة معطوبة)

هذا **أول نشر** ولا يوجد عنصر قائم، ومعرّف العنصر الجديد **لا يمكن معرفته قبل
الرفع**، والتطبيق لا يقبل إلا المعرّفات المعروفة (نموذج ثقة مقصود: معرّف غير
متحقَّق منه لا يُسمح له بقيادة التطبيق). لذلك:

1. [ ] ارفع الحزمة في المتجر واختر الظهور **Unlisted (غير مُدرجة)**.
2. [ ] انسخ **معرّف العنصر (Item ID)** من لوحة المطوّر وأرسله — يُضاف في
   `src-tauri/src/bridge.rs` عند `CHROME_STORE_EXT_ID`.
3. [ ] يُعاد بناء 0.2.1 ويُنشأ **إصدار GitHub** بالمثبتات (عبر `gh`، بلا Actions).
4. [ ] بعدها يُحوَّل ظهور الإضافة إلى **Public**.

بهذا لا يرى أي مستخدم إضافةً لا تعمل: الإضافة والتطبيق يُنشران متوافقين.

> **فايرفوكس لا يحتاج هذا التسلسل**: معرّف الإضافة فيه `browser_specific_settings.gecko.id`
> وهو **مختار عندنا** (`haramlite_bridge@harammute.app`) ومقبول مسبقاً في التطبيق.

---

## الهوية

| الحقل | القيمة |
|---|---|
| اللغة الأساسية | العربية (`ar`) |
| لغات إضافية | الإنجليزية (`en`) |
| الفئة | **Productivity** (الإنتاجية) |
| الموقع الرسمي | **`https://haramlite.com`** (ومرآته `https://smsmy.github.io/HaramLite/`) |
| سياسة الخصوصية | **`https://haramlite.com/bridge-privacy.html`** — صفحة مركَّزة على الإضافة، وهي مقتطف حرفي من [السياسة الكاملة](https://haramlite.com/PRIVACY.html) التي تغطي التطبيق أيضاً |
| الدعم | `https://github.com/SMSMy/HaramLite/issues` |

> **لا تستخدم رابط المستودع كموقع رسمي**: `github.com/SMSMy/HaramLite/…` لا يخدم
> الملفات على مسار الجذر (تحقق حيّ: **404**)، ولا يمكن إثبات ملكيته لأنه نطاق لا
> نملكه. موقع Pages مخدوم ومتحقَّق منه فعلاً (**200**) للصفحة الرئيسية وملف إثبات
> قوقل وسياسة الخصوصية.

## الأسماء

- **العربية**: `HaramLite Bridge — شاهد بلا موسيقى`
- **English**: `HaramLite Bridge — Watch without music`

> ملاحظة مقصودة: **الاسم لا يذكر يوتيوب** (علامة تجارية + إشارة قد تُربط بأدوات التنزيل)، ويُذكر يوتيوب داخل الوصف فقط مع سطر العلامة التجارية في آخره.

## الوصف المختصر (≤ 132 حرفاً)

- **العربية**: `يُشغّل الصوت بعد إزالة الموسيقى داخل مشغّل يوتيوب، ويتخطّى فترات الصمت — المعالجة على جهازك.`
- **English**: `Plays your music-free audio inside the YouTube player and skips silent gaps — processed on your own machine.`

## الوصف الكامل — العربية

```
HaramLite Bridge يجعل مشاهدة يوتيوب بلا موسيقى ممكنة داخل الصفحة نفسها، عبر تطبيق HaramLite
المكتبي الذي ثبّته أنت على جهازك. لا حساب، ولا خدمة سحابية، ولا يُرفع أي ملف.

⚠ يلزم تطبيق HaramLite المكتبي (ويندوز): https://haramlite.com
بدون التطبيق لا تعمل الإضافة — فهي واجهة متصفح لتطبيقك، والمعالجة كلها تحدث على جهازك.

■ ما تفعله الإضافة داخل الصفحة
• «شاهد بعد إزالة الموسيقى»: يُكتم صوت فيديو الصفحة (بإعلان واضح على الشاشة) ويُشغَّل بدلاً منه
  الصوت الذي عالجه تطبيقك، متزامناً مع الفيديو frame-by-frame.
• تخطي فترات الصمت: الفترات التي تبقى صامتة بعد إزالة الموسيقى تُتخطّى تلقائياً فلا تشعر بفجوات
  (ويمكن إيقاف التخطي من قائمة الزر الأيمن).
• اختيار الوضع داخل النافذة: «مقطع عادي» أو «وضع أغنية»، لكل رابط على حدة.
• حالة الاتصال بتطبيقك وزرّ إرسال الصفحة الحالية في نافذة الإضافة.
• إرسال بنقرة يمين: أي رابط أو صفحة ← «أرسل إلى HaramLite».

■ ما لا تفعله الإضافة — بصراحة
• لا تُنزّل الإضافة أي محتوى بنفسها، ولا تحفظ أي ملف، ولا تُجري أي طلب شبكة: ما تقرأه هو رابط
  التبويب الذي تطلب معالجته، ويمرّ إلى تطبيقك على جهازك عبر Native Messaging.
• لا تتجاوز الإضافة ولا تطبيقها حمايةً تقنية ولا جدار دفع ولا قيد تسجيل دخول، ولا تفكّ تشفيراً.
  تعمل الإضافة على المحتوى الذي تستطيع مشاهدته أصلاً في متصفحك، والمعالجة مسؤولية المستخدم
  في المحتوى الذي يملك حق معالجته.
• لا حساب، ولا تحليلات، ولا تتبّع، ولا إعلانات، ولا كود بعيد.
• الصلاحيات عند الحد الأدنى: قائمة الزر الأيمن + التبويب النشط عند نقرك + التخاطب مع تطبيقك
  المحلي. لا وصول إلى سجل التصفح، ولا إلى أي موقع آخر غير youtube.com.

■ كيف تعمل بالتفصيل
يقرأ تطبيقك المحلي الرابط الذي اخترته، ويعالج الصوت على جهازك (فصل الصوت عن الموسيقى بمحرّك
ONNX محلي ثم تحسينه وقصّ الصمت)، ثم تُشغّل الإضافة الناتج داخل المشغّل بدل صوت الصفحة.
ويبقى كل شيء على جهازك: لا رفع، ولا وسيط، ولا تخزين خارجي.


يوتيوب علامة تجارية لشركة Google LLC. هذه الإضافة مستقلة وغير مرتبطة بهم ولا معتمدة منهم.
لقطة الشاشة في صفحة المتجر تُظهر فيلم Big Buck Bunny (مؤسسة Blender) برخصة المشاع الإبداعي.
```

## الوصف الكامل — English

```
HaramLite Bridge makes watching YouTube without music possible inside the page itself, through the
HaramLite desktop app that you install and run on your own computer. No account, no cloud service,
and nothing is ever uploaded.

⚠ Requires the HaramLite desktop app (Windows): https://haramlite.com
Without the app the extension does nothing - it is a browser front end for your app, and all
processing happens on your machine.

■ What the extension does in the page
• "Watch without music": the page video's audio is muted (clearly announced on screen) and the audio
  your app produced is played in its place, kept in sync with the video frame by frame.
• Silence skipping: the stretches that stay silent once the music is gone are skipped automatically,
  so the video plays without gaps (right-click to turn skipping off).
• Mode choice in the popup: Clip or Song, per link.
• Connection status for your app and a button to send the current page.
• Right-click: "Send to HaramLite" for any link or page.

■ What the extension does NOT do - plainly
• The extension does not download anything itself, store any file, or make any network request. What
  it reads is the tab URL you asked to process, and it travels to your own app over Native Messaging.
• Neither the extension nor its app bypasses technical protection measures, paywalls or login
  restrictions, and it does not break encryption. It works on content you can already watch in your
  browser, and processing content is the user's responsibility for media they have the right to use.
• No account, no analytics, no tracking, no ads, no remote code.
• Minimal permissions: a context-menu item, the active tab when you click, and talking to your local
  app. No browsing history, and no site other than youtube.com.

■ How it works in detail
Your local app reads the link you chose and processes the audio on your machine (separating voice from
music with a local ONNX model, then polishing it and trimming silence); the extension then plays that
result inside the player in place of the page audio. Everything stays on your computer: no upload, no
middleman, no external storage.


YouTube is a trademark of Google LLC. This extension is independent, not affiliated with or endorsed
by them. The store screenshot shows Big Buck Bunny (Blender Foundation) under a Creative Commons
licence.
```

## الصور المطلوبة (في `store-assets/`)

| الملف | المقاس | الاستخدام |
|---|---|---|
| `screenshot-1-player.jpg` | 1280×800 | لقطة 1: الزرّان داخل مشغّل يوتيوب |
| `screenshot-2-popup.png` | 1280×800 | لقطة 2: منبثقة الإضافة وحالة الاتصال — **حُدِّثت 2026-09-15 لتُظهر الإصدار 1.1.5** (نسخة v1.1.0 محفوظة في `store-assets/archive/`) |
| `icon-128.png` | 128×128 | أيقونة المتجر |
| `promo-440x280.png` | 440×280 | البطاقة الترويجية الصغيرة |

> لقطات الشاشة من واجهة حقيقية: فيديو برخصة حرة، وجلسة متصفح **بلا حساب** —
> لا بيانات شخصية في أي صورة.

---

## ربط الدومين `haramlite.com` بـGitHub Pages — **تمّ ✓ (2026-09-12)**

المنطقة على Cloudflare (`phoenix.ns.cloudflare.com` · `lou.ns.cloudflare.com`)، والسجلات
العشرة منشورة ومتحقَّق منها عبر DoH محايد: **4 A** + **4 AAAA** على الجذر، **CNAME**
لـ`www` → `smsmy.github.io`، و**TXT** لإثبات ملكية قوقل. وكلها **DNS only** (بلا بروكسي).

### السجلات المطلوبة (كلها **DNS only / سحابة رمادية**)

> ⚠️ **أهم نقطة**: يجب أن تكون السحابة **رمادية (DNS only)** لكل السجلات. تفعيل
> البروكسي (سحابة برتقالية) يمنع GitHub من إصدار شهادة HTTPS وقد يُنتج حلقة إعادة
> توجيه. GitHub Pages يعمل مع Cloudflare **بشرط عدم التمرير عبر البروكسي**.

| النوع | الاسم | القيمة |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |
| CNAME | `www` | `smsmy.github.io` |

(العناوين مأخوذة من توثيق GitHub الرسمي، لا من مصادر ثانوية.)

### الطريقان

1. **يدوياً (موصى به — بلا مشاركة أي سر)**: Cloudflare ← DNS ← Records ← إضافة
   التسعة، أو أسرع: **Import and Export ← Import** ولصق ملف BIND:

```
haramlite.com.     1 IN A     185.199.108.153
haramlite.com.     1 IN A     185.199.109.153
haramlite.com.     1 IN A     185.199.110.153
haramlite.com.     1 IN A     185.199.111.153
haramlite.com.     1 IN AAAA  2606:50c0:8000::153
haramlite.com.     1 IN AAAA  2606:50c0:8001::153
haramlite.com.     1 IN AAAA  2606:50c0:8002::153
haramlite.com.     1 IN AAAA  2606:50c0:8003::153
www.haramlite.com. 1 IN CNAME smsmy.github.io.
```

2. **بتوكن**: يجب أن يحمل صلاحية `Zone → DNS → Edit` لنطاق `haramlite.com`
   وحده. توكن بنطاق `Workers` **لا يصلح** (فُحص: يُقرأ المنطقة لكنه يُرجع **403**
   على سجلات DNS). وأي توكن يُشارَك يُبطَل فوراً بعد الاستخدام.

### ما نُفِّذ بعد الانتشار

1. ✓ ملف `docs/CNAME` يحوي `haramlite.com` (أُضيف **بعد** انتشار DNS لا قبله).
2. ✓ ضبط الدومين المخصص في Pages، و✓ **فرض HTTPS** بعد إصدار شهادة Let's Encrypt.
3. ✓ التحقق العملي: `/` و`/PRIVACY.html` وملف إثبات قوقل → **200** مع شهادة صالحة،
   و`https://smsmy.github.io/HaramLite/` يحوّل **301** إلى الدومين.

### إثبات الملكية في Search Console (بعد الربط)

رمز الإثبات المُحمَّل صادر لعنصر `github.com/…` **ولا يصلح لعنصر جديد**؛ فعند
إضافة عنصر `haramlite.com` يعطي قوقل **ملفاً أو سجل TXT جديداً**. والأفضل الآن
إثبات **عنصر نطاق** بسجل TXT (مرة واحدة ويغطي كل النطاقات الفرعية).

---

## تبويب «ممارسات الخصوصية» — الإجابات الجاهزة

**ما الذي تجمعه الإضافة؟** لا شيء يغادر جهاز المستخدم.
الإضافة تُمرّر رابط الصفحة التي يطلب المستخدم معالجتها إلى **تطبيقه المحلي**
عبر Native Messaging. لا يُرسَل أي شيء إلى المطوّر أو إلى أي خادم أو طرف ثالث،
ولا يوجد تحليل أو تتبّع أو إعلانات.

نموذج «استخدام البيانات»: **لا تُحدَّد أي فئة** (لأن «الجمع» في سياسة كروم يعني
نقل البيانات خارج جهاز المستخدم، وهذا لا يحدث). وإن سأل المراجع عن قراءة رابط
التبويب، فالجواب المكتوب أعلاه هو الصياغة المعتمدة.

### تبرير كل صلاحية (يُطلب حرفياً عند الرفع)

#### English — انسخ هذا (أسرع في المراجعة)

**contextMenus**
> Adds one item, "Send to HaramLite", to the browser's right-click menu so the user can send the link, page or video they are looking at to their own HaramLite desktop application. It adds nothing else and reads no page data.

**nativeMessaging**
> Used only to talk to the HaramLite desktop app that the user installs and runs on their own computer. The extension passes the URL the user chose to process, plus short status messages, over the local Native Messaging channel. Nothing is sent to the developer or to any server — the extension itself makes no network request. The messaging host is registered by the desktop app, and the user must switch the integration on in that app's settings; without it the extension does nothing.

**activeTab**
> Reads the URL of the active tab only at the moment the user clicks the extension, so that URL can be handed to their desktop app for processing. There is no background access, no browsing-history access and no access to any other tab or site.

**Host permission for `*://*.youtube.com/*`**
> A content script runs on YouTube pages only, to add two buttons to the video player ("process this video" and "watch without music") and to play the audio that was processed locally on the user's machine in sync with the page video. It reads no other content on the page, stores nothing, downloads nothing itself, and never sends anything off the device. It does not download media, does not access cookies or login state, and calls no network API: it only overlays locally processed audio on a video the user is already watching.

#### العربية (بديل مقبول)

| الصلاحية | التبرير |
|---|---|
| `contextMenus` | «إضافة عنصر واحد «أرسل إلى HaramLite» في قائمة الزر الأيمن، ليرسل المستخدم الرابط أو الصفحة أو الفيديو إلى تطبيقه المكتبي. لا يضيف غيره ولا يقرأ بيانات الصفحة.» |
| `nativeMessaging` | «للتخاطب مع تطبيق HaramLite المكتبي الذي ثبّته المستخدم على جهازه. تُمرَّر إليه الرابط الذي اختار معالجته ورسائل حالة قصيرة عبر قناة Native Messaging المحلية. لا شيء يُرسَل إلى المطوّر أو إلى أي خادم، والإضافة نفسها لا تُجري أي طلب شبكة. المضيف يُسجّله التطبيق، وعلى المستخدم تفعيل التكامل من إعداداته، وبدونه لا تفعل الإضافة شيئاً.» |
| `activeTab` | «قراءة رابط التبويب النشط لحظة نقر المستخدم على الإضافة فقط، لتسليمه إلى تطبيقه المكتبي. لا وصول في الخلفية، ولا سجل تصفح، ولا وصول إلى أي تبويب أو موقع آخر.» |
| محتوى في `*://*.youtube.com/*` | «سكربت محتوى يعمل على صفحات يوتيوب فقط لإضافة زرّين إلى المشغّل («عالج هذا الفيديو» و«شاهد بعد إزالة الموسيقى») وتشغيل الصوت المعالَج محلياً بتزامن مع الفيديو. لا يقرأ محتوى آخر، ولا يُرسل شيئاً خارج الجهاز.» |

#### سؤال «الكود البعيد» (Remote code)

الجواب الصحيح: **«لا، لا أستخدم الكود البعيد»** ✓ — كل الشيفرة داخل الحزمة، بلا `eval` ولا سكربتات خارجية (تحقّق آلي: صفر `eval`/`new Function`/`importScripts`).

#### ملاحظة عن لافتة «المراجعة المطوّلة»

طلب `nativeMessaging` (وأذونات المضيف) **قد يستدعي مراجعة بشرية مطوّلة تؤخر النشر** — وهذا متوقع ومعلن ولا يعني رفضاً. التبريرات المحددة أعلاه هي ما يقرؤه المراجع، فكلما كانت أوضح كان القرار أسرع. وبعد النشر: ثبّت نسخة المتجر على جهاز فيه تطبيق **0.2.1** وجرّب إرسال رابط.

### «الاستخدام المفرد» (Single purpose)

> Bridge between the browser and the user's own HaramLite desktop app: it forwards the video URL the user chooses to that local app for processing, and plays the processed result inside the page.

«جسر بين المتصفح وتطبيق HaramLite المكتبي: يمرّر رابط الفيديو المطلوب إلى
التطبيق لمعالجته محلياً، ويشغّل الناتج داخل الصفحة.»

---

## قائمة تحقق قبل النقر على «إرسال للمراجعة»

1. [x] رفع `HaramLite-Bridge-1.1.2-chrome.zip` (يُبنى بـ`pnpm pack:ext`؛ المانيفست في الجذر، الإصدار 1.1.2، **بلا حقل `key`**) — **كتحديث للعنصر القائم** (لا عنصر جديد ولا `Unlisted` أولاً — النسخة الأولى اعتُمدت ونُشرت علناً). ✅ **نُفِّذ 2026-09-15** (بانتظار اعتماد المراجعة).
2. [ ] **رفع `HaramLite-Bridge-1.1.5-chrome.zip`** كتحديث للعنصر القائم (المتجر يرفض إعادة رفع النسخة نفسها). الحزمة فُحصت: **١٢ مدخلاً** · بلا `key` · و`content.js` داخلها **مطابق بايتاً ببايت** للمستودع. **بيد المالك** (يحتاج جلسة قوقل في المتصفح).
3. [ ] اختيار لقطة واحدة على الأقل (المقترح: الاثنتان — و`store-assets/screenshot-2-popup.png` مُحدَّثة الآن لتُظهر 1.1.5) + الأيقونة + البطاقة.
4. [ ] لصق سياسة الخصوصية (الرابط أعلاه) — **مطلوبة** مع `nativeMessaging`.
5. [ ] تعبئة تبويب ممارسات الخصوصية + تبريرات الصلاحيات الأربعة أعلاه.
6. [ ] التأكد أن الوصف يذكر صراحةً اشتراط تطبيق ويندوز المكتبي.
7. [ ] بعد النشر: تثبيت نسخة المتجر على جهاز فيه التطبيق **0.2.5** (المثبّت المنشور) أو أحدث، ثم إرسال رابط — نجاح التكامل يعني أن معرّف المتجر (`kaijaffkolenjhfcbaepmjndheahhikg`) مقبول.

## إن رُفضت الإضافة — قائمة الاستئناف الجاهزة

لا يُعاد رفع النص نفسه. يُرفع استئناف بنقاط محددة وقابلة للتحقق:

1. **الحزمة لا تحتوي أي منزّل**: لا `yt-dlp` ولا `FFmpeg` ولا أي ثنائي — 9 ملفات نصية فقط (JS/HTML/CSS/JSON/PNG). تحقّق بالأمر: `pnpm pack:ext` ثم فحص الأرشيف.
2. **الإضافة لا تنزّل ولا تتصل**: لا استخدام لـ`chrome.downloads`، ولا `fetch`/`XMLHttpRequest`، ولا أي طلب شبكة — يمكن إثباته بمراقبة شبكة المتصفح أثناء التشغيل.
3. **لا تجاوز**: لا تفكّ حماية تقنية، ولا تتخطى جدار دفع أو قيد تسجيل دخول، ولا تقرأ كوكيز الجلسة.
4. **المستخدم يشاهد الفيديو أصلاً** داخل يوتيوب؛ الإضافة تبدّل **مسار الصوت** فقط (كتم صوت الصفحة وتشغيل الصوت المعالَج محلياً) مع تخطي فترات الصمت.
5. **لا يُحفظ أي ملف يوتيوب من الإضافة**، ولا يُخزَّن أي محتوى.
6. **الغرض**: إزالة الموسيقى لمشاهدة شخصية، لا أرشفة محتوى ولا إعادة نشر.

**إن حدّدوا `Blue Zinc` أو `Blue Copper`** (Prohibited products) فالاستئناف بلا تغيير سلوك غالباً يفشل — والخياران حينها:
- إبقاء الإضافة **Unlisted** إن مُرّرت، أو
- إصدار نسخة **جسر تشغيل فقط** (بلا إرسال روابط)، ويبقى التنزيل يدوياً داخل التطبيق بلصق الرابط — وهذا يفصل «التسهيل» عن الإضافة تماماً.

**فايرفوكس أسهل لهذه الفئة** — يبقى مسار Mozilla قائماً (`pnpm pack:ext:firefox`) ولا يُربط مصير المشروع بكروم وحده.