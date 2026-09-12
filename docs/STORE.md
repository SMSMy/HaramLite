# HaramLite Bridge — قائمة متجر كروم (جاهزة للنسخ)

> هذه ورقة العمل للنشر: كل حقل مكتوب بنصّه النهائي. المقاسات والملفات في
> `store-assets/` (خارج git). الإصدار المرفوع: **1.1.0**.

## الحزمة (اقرأ هذا أولاً)

الرفع **يرفض** حقل `key` في المانيفست:
`The key field is not allowed in the manifest file` — المتجر يدير معرّف العنصر
بنفسه. لذلك المستودع يحتفظ بالمفتاح (يثبّت معرّف النسخة غير المحزومة التي
يستخدمها التطوير وجسر التطبيق) و**الحزمة المرفوعة تُجرَّد منه**.

```
pnpm pack:ext          # → src-tauri/target/store/HaramLite-Bridge-1.1.0-chrome.zip
pnpm pack:ext:firefox  # للفايرفوكس (يبقي browser_specific_settings)
```

الملف الصحيح للرفع: **`HaramLite-Bridge-1.1.0-chrome.zip`** (المانيفست في الجذر،
بلا `key` ولا `browser_specific_settings`، 9 ملفات).

> ⚠ **ارفعها كتحديث للعنصر القائم** (1.0.15) لا كعنصر جديد: معرّف العنصر القائم
> `bbkbpldbnkoncockinoapcmbiijejgpn` وهو مقبول في التطبيق، بينما العنصر الجديد
> يحصل على معرّف عشوائي لا يعرفه التطبيق بعد ⇒ ينكسر التكامل حتى نُصدر تحديثاً
> يضيفه. (ونسخة التطبيق يجب أن تكون 0.2.1 أو أحدث.)

---

## الهوية

| الحقل | القيمة |
|---|---|
| اللغة الأساسية | العربية (`ar`) |
| لغات إضافية | الإنجليزية (`en`) |
| الفئة | **Productivity** (الإنتاجية) |
| الموقع الرسمي | `https://github.com/SMSMy/HaramLite` |
| سياسة الخصوصية | `https://github.com/SMSMy/HaramLite/blob/main/docs/PRIVACY.md` |
| الدعم | `https://github.com/SMSMy/HaramLite/issues` |

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

## تبويب «ممارسات الخصوصية» — الإجابات الجاهزة

**ما الذي تجمعه الإضافة؟** لا شيء يغادر جهاز المستخدم.
الإضافة تُمرّر رابط الصفحة التي يطلب المستخدم معالجتها إلى **تطبيقه المحلي**
عبر Native Messaging. لا يُرسَل أي شيء إلى المطوّر أو إلى أي خادم أو طرف ثالث،
ولا يوجد تحليل أو تتبّع أو إعلانات.

نموذج «استخدام البيانات»: **لا تُحدَّد أي فئة** (لأن «الجمع» في سياسة كروم يعني
نقل البيانات خارج جهاز المستخدم، وهذا لا يحدث). وإن سأل المراجع عن قراءة رابط
التبويب، فالجواب المكتوب أعلاه هو الصياغة المعتمدة.

### تبرير كل صلاحية (يُطلب حرفياً عند الرفع)

| الصلاحية | التبرير |
|---|---|
| `nativeMessaging` | «التخاطب مع تطبيق HaramLite المكتبي **الذي ثبّته المستخدم بنفسه** لتمرير رابط الفيديو إليه. المعالجة تحدث على جهاز المستخدم، ولا تُرسل بيانات إلى أي خادم.» |
| `contextMenus` | «إضافة عنصر «أرسل إلى HaramLite» في قائمة الزر الأيمن، وهو المسار الذي اختاره المستخدم لإرسال رابط.» |
| `activeTab` | «قراءة رابط التبويب النشط **فقط عند نقر المستخدم على الإضافة**، لإرساله إلى تطبيقه المحلي.» |
| محتوى في `*://*.youtube.com/*` | «إضافة الزرّين إلى مشغّل يوتيوب وتنفيذ المشاهدة المفلترة داخل الصفحة (كتم الفيديو ومزامنة الصوت المعالَج). لا يُقرأ أي محتوى آخر ولا تُرسل أي صفحة إلى الخارج.» |

### «الاستخدام المفرد» (Single purpose)

«جسر بين المتصفح وتطبيق HaramLite المكتبي: يمرّر رابط الفيديو المطلوب إلى
التطبيق لمعالجته محلياً، ويشغّل الناتج داخل الصفحة.» — جملة واحدة تكفي المراجع.

---

## قائمة تحقق قبل النقر على «إرسال للمراجعة»

1. [ ] رفع `HaramLite-Bridge-1.1.0-chrome.zip` (يُبنى بـ`pnpm pack:ext`؛ المانيفست في الجذر، الإصدار 1.1.0 > المنشور 1.0.15، **بلا حقل `key`**).
2. [ ] اختيار لقطة واحدة على الأقل (المقترح: الاثنتان) + الأيقونة + البطاقة.
3. [ ] لصق سياسة الخصوصية (الرابط أعلاه) — **مطلوبة** مع `nativeMessaging`.
4. [ ] تعبئة تبويب ممارسات الخصوصية + تبريرات الصلاحيات الأربعة أعلاه.
5. [ ] التأكد أن الوصف يذكر صراحةً اشتراط تطبيق ويندوز المكتبي.
6. [ ] بعد النشر: تثبيت نسخة المتجر على جهاز فيه التطبيق **0.2.1 أو أحدث**، ثم إرسال رابط — نجاح التكامل يعني أن معرّف المتجر (`bbkb…`) مقبول.
