# HaramLite Bridge — قائمة متجر كروم (جاهزة للنسخ)

> هذه ورقة العمل للنشر: كل حقل مكتوب بنصّه النهائي. المقاسات والملفات في
> `store-assets/` (خارج git). **المعلَّق في المتجر الآن: 1.1.0** — ولا يُعدَّل حتى تُوافق قوقل على النسخة الأولى. تغيير الأيقونة يُشحن في **1.1.1** بعد الموافقة (المتجر يرفض إعادة رفع النسخة نفسها)، وحزمة 1.1.1 جاهزة في `src-tauri/target/store/`.

## الحزمة (اقرأ هذا أولاً)

الرفع **يرفض** حقل `key` في المانيفست:
`The key field is not allowed in the manifest file` — المتجر يدير معرّف العنصر
بنفسه. لذلك المستودع يحتفظ بالمفتاح (يثبّت معرّف النسخة غير المحزومة التي
يستخدمها التطوير وجسر التطبيق) و**الحزمة المرفوعة تُجرَّد منه**.

```
pnpm pack:ext          # → src-tauri/target/store/HaramLite-Bridge-1.1.1-chrome.zip
pnpm pack:ext:firefox  # للفايرفوكس (يبقي browser_specific_settings)
```

الملف الصحيح للرفع: **`HaramLite-Bridge-1.1.1-chrome.zip`** (المانيفست في الجذر،
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
| سياسة الخصوصية | **`https://haramlite.com/PRIVACY.html`** |
| الدعم | `https://github.com/SMSMy/HaramLite/issues` |

> **لا تستخدم رابط المستودع كموقع رسمي**: `github.com/SMSMy/HaramLite/…` لا يخدم
> الملفات على مسار الجذر (تحقق حيّ: **404**)، ولا يمكن إثبات ملكيته لأنه نطاق لا
> نملكه. موقع Pages مخدوم ومتحقَّق منه فعلاً (**200**) للصفحة الرئيسية وملف إثبات
> قوقل وسياسة الخصوصية.

## الأسماء

- **العربية**: `HaramLite Bridge — إزالة الموسيقى من يوتيوب`
- **English**: `HaramLite Bridge — Remove Music from YouTube`

## الوصف المختصر (≤ 132 حرفاً)

- **العربية**: `أرسل أي فيديو إلى تطبيق HaramLite على جهازك لإزالة الموسيقى — المعالجة كاملة محلياً بلا رفع لأي سحابة.`
- **English**: `Send any video to the HaramLite desktop app to strip its music — processed entirely on your machine, nothing uploaded.`

## الوصف الكامل — العربية

```
HaramLite Bridge يوصل متصفحك بتطبيق HaramLite المكتبي: تضغط زراً واحداً، فينزّل
تطبيقك الفيديو ويعالجه ويزيل الموسيقى — كل شيء على جهازك، ولا يُرفع أي ملف إلى
أي سحابة.

⚠ يلزم تطبيق HaramLite المكتبي (ويندوز): https://github.com/SMSMy/HaramLite
بدونه لا تعمل الإضافة — فهي جسر إلى تطبيقك، لا خدمة سحابية.

ما تفعله الإضافة:
• زرّان داخل مشغّل يوتيوب: «حمّل وعالج» يطلب من التطبيق تنزيل الرابط ومعالجته،
  و«شاهد مفلتراً» يشغّل الصوت المعالَج داخل الصفحة متزامناً مع الفيديو.
• مشاهدة مفلترة: يُكتم فيديو الصفحة (بإعلان واضح) ويُشغَّل الصوت المعالَج بدلاً
  منه، مع **تخطي مقاطع الصمت** التي يخلّفها كتم الموسيقى — فتقفز الصورة فوقها
  فوراً بدل تشغيلها (ويمكن إيقاف التخطي من قائمة الزر الأيمن).
• إرسال بنقرة يمين: أي رابط أو صفحة أو فيديو ← «أرسل إلى HaramLite».
• المنبثقة: حالة الاتصال بتطبيقك + زر إرسال الصفحة الحالية.

الخصوصية أولاً:
• لا تحليلات، لا تتبّع، لا حسابات، ولا أي طلب شبكة من الإضافة نفسها.
• ما تقرأه الإضافة (رابط التبويب الذي تطلب معالجته) يذهب إلى **تطبيقك على
  جهازك** عبر Native Messaging — ولا يغادر جهازك إطلاقاً.
• الصلاحيات عند الحد الأدنى: قائمة يمين + التبويب النشط عند نقرك + التخاطب مع
  التطبيق المحلي. لا وصول إلى سجل التصفح ولا إلى بقية المواقع.

يوتيوب علامة تجارية لشركة Google LLC. هذه الإضافة غير مرتبطة بهم ولا معتمدة
منهم. لقطة الشاشة في صفحة المتجر تُظهر فيلم Big Buck Bunny (مؤسسة Blender)
برخصة المشاع الإبداعي.
```

## الوصف الكامل — English

```
HaramLite Bridge connects your browser to the HaramLite desktop app: one button
sends the video to your own machine, where it is downloaded, processed and
stripped of music. Nothing is ever uploaded to a cloud.

⚠ Requires the HaramLite desktop app (Windows): https://github.com/SMSMy/HaramLite
The extension does nothing on its own — it is a bridge to your app, not a service.

What it does:
• Two buttons in the YouTube player: “Download & process” asks your app to fetch
  and process the link, and “Watch filtered” plays the processed audio inside the
  page, in sync with the video.
• Filtered watching: the page video is muted (clearly announced) and the
  processed audio takes over, including SKIPPING the silent stretches left by
  muting the music instead of playing through them (right-click to turn skipping
  off).
• Right-click → “Send to HaramLite” for any link, page or video.
• Popup: connection status plus a button to send the current page.

Privacy first:
• No analytics, no tracking, no accounts, and no network request from the
  extension itself.
• What it reads (the URL you ask it to process) goes to YOUR app on YOUR machine
  over Native Messaging. It never leaves your device.
• Minimal permissions: context menu, active tab on your click, and talking to the
  local app. No browsing-history access, no access to other sites.

YouTube is a trademark of Google LLC. This extension is not affiliated with or
endorsed by them. The store screenshot shows Big Buck Bunny (Blender Foundation)
under a Creative Commons licence.
```

---

## الصور المطلوبة (في `store-assets/`)

| الملف | المقاس | الاستخدام |
|---|---|---|
| `screenshot-1-player.png` | 1280×800 | لقطة 1: الزرّان داخل مشغّل يوتيوب |
| `screenshot-2-popup.png` | 1280×800 | لقطة 2: منبثقة الإضافة وحالة الاتصال |
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
> A content script runs on YouTube pages only, to add two buttons to the video player ("download & process" and "watch filtered") and to play the audio that was processed locally on the user's machine in sync with the page video. It reads no other content on the page, and nothing is ever sent off the device.

#### العربية (بديل مقبول)

| الصلاحية | التبرير |
|---|---|
| `contextMenus` | «إضافة عنصر واحد «أرسل إلى HaramLite» في قائمة الزر الأيمن، ليرسل المستخدم الرابط أو الصفحة أو الفيديو إلى تطبيقه المكتبي. لا يضيف غيره ولا يقرأ بيانات الصفحة.» |
| `nativeMessaging` | «للتخاطب مع تطبيق HaramLite المكتبي الذي ثبّته المستخدم على جهازه. تُمرَّر إليه الرابط الذي اختار معالجته ورسائل حالة قصيرة عبر قناة Native Messaging المحلية. لا شيء يُرسَل إلى المطوّر أو إلى أي خادم، والإضافة نفسها لا تُجري أي طلب شبكة. المضيف يُسجّله التطبيق، وعلى المستخدم تفعيل التكامل من إعداداته، وبدونه لا تفعل الإضافة شيئاً.» |
| `activeTab` | «قراءة رابط التبويب النشط لحظة نقر المستخدم على الإضافة فقط، لتسليمه إلى تطبيقه المكتبي. لا وصول في الخلفية، ولا سجل تصفح، ولا وصول إلى أي تبويب أو موقع آخر.» |
| محتوى في `*://*.youtube.com/*` | «سكربت محتوى يعمل على صفحات يوتيوب فقط لإضافة زرّين إلى المشغّل («حمّل وعالج» و«شاهد مفلتراً») وتشغيل الصوت المعالَج محلياً بتزامن مع الفيديو. لا يقرأ محتوى آخر، ولا يُرسل شيئاً خارج الجهاز.» |

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

1. [ ] رفع `HaramLite-Bridge-1.1.1-chrome.zip` (يُبنى بـ`pnpm pack:ext`؛ المانيفست في الجذر، الإصدار 1.1.1، **بلا حقل `key`**) — كعنصر جديد بظهور **Unlisted** أولاً.
2. [ ] اختيار لقطة واحدة على الأقل (المقترح: الاثنتان) + الأيقونة + البطاقة.
3. [ ] لصق سياسة الخصوصية (الرابط أعلاه) — **مطلوبة** مع `nativeMessaging`.
4. [ ] تعبئة تبويب ممارسات الخصوصية + تبريرات الصلاحيات الأربعة أعلاه.
5. [ ] التأكد أن الوصف يذكر صراحةً اشتراط تطبيق ويندوز المكتبي.
6. [ ] بعد النشر: تثبيت نسخة المتجر على جهاز فيه التطبيق **0.2.1 أو أحدث**، ثم إرسال رابط — نجاح التكامل يعني أن معرّف المتجر (`bbkb…`) مقبول.
