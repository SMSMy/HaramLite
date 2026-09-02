# HaramLite Bridge — إضافة المتصفح

إضافة MV3 بسيطة تجعل المتصفح «جسراً» إلى تطبيق HaramLite المكتبي: أرسل رابط أي
فيديو بنقرة يمين، ويتولى التطبيق التنزيل والمعالجة كاملة **محلياً على جهازك** —
بلا رفع أي ملف لأي سحابة، وبلا تتبع.

## التثبيت (تطوير / تجربة)

1. ثبّت HaramLite وشغّله مرة واحدة.
2. من **الإعدادات ← تفعيل التكامل مع المتصفح** (يكتب التطبيق ملف المضيف
   ومفاتيح التسجيل تلقائياً).
3. في Chrome/Edge: `chrome://extensions` ← فعّل «وضع المطور» ←
   **Load unpacked** ← اختر هذا المجلد `browser-extension`.
   - Firefox: `about:debugging#/runtime/this-firefox` ← Load Temporary
     Add-on ← اختر `manifest.json`.

> معرّف الإضافة الثابت: `jchaeejligdfbkgkbgneimclkagoopig`
> (مشتق من المفتاح المضمّن في `manifest.json` — لا يتغير بين الأجهزة).

## كيف يعمل

```
نقرة يمين على رابط/صفحة/فيديو ← «أرسل إلى HaramLite»
        │  Native Messaging (stdio — لا منافذ مفتوحة)
        ▼
HaramLite.exe --native-host  ← يكتب ملف طلب في مجلد requests ويخرج
        │  (يشغّل التطبيق إن لم يكن يعمل)
        ▼
التطبيق (مراقب الطلبات) ← تنزيل yt-dlp ← المعالجة الكاملة ← إشعار النظام
```

- `background.js`: قائمة السياق + بروتوكول Native Messaging.
- `popup.*`: حالة الاتصال بالتطبيق وتعليمات الاستخدام.
- لا تحليلات، لا شبكة خارجية، `content_security_policy` مقيّدة بـ `'self'`.

## النشر المستقبلي

للنشر على متجر Chrome/Edge يُستخدم نفس `manifest.json` (المفتاح يضمن نفس
المعرّف)، ولنشر Firefox تُضاف `browser_specific_settings.gecko.id` =
`haramlite_bridge@harammute.app` (مسجّل مسبقاً في `allowed_extensions`
للمضيف من جهة التطبيق).
