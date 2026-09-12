<p align="center">
  <a href="https://haramlite.com/">
    <img src="IMG/haramless-app-icon.png" alt="HaramLite" width="128">
  </a>
</p>

<h1 align="center">HaramLite</h1>

<p align="center">
  <strong>إزالة الموسيقى من الفيديو والصوت بالذكاء الاصطناعي — محلياً 100% على جهازك</strong><br>
  لا رفع لأي ملف. لا سحابة. لا حسابات.
</p>

<p align="center">
  <em>«الموسيقى لا تليق بقلبٍ يريد الطمأنينة»</em>
</p>

<p align="center">
  <a href="https://haramlite.com/"><img src="https://img.shields.io/badge/الموقع_الرسمي-haramlite.com-0F766E?style=for-the-badge" alt="الموقع الرسمي"></a>
  <a href="https://haramlite.com/#download"><img src="https://img.shields.io/badge/تحميل-Windows_x64-111827?style=for-the-badge" alt="تحميل"></a>
  <a href="https://github.com/SMSMy/HaramLite/releases/latest"><img src="https://img.shields.io/github/v/release/SMSMy/HaramLite?style=for-the-badge&label=Release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-2F6F4E?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://haramlite.com/">الموقع الرسمي</a> ·
  <a href="https://haramlite.com/#download">التحميل</a> ·
  <a href="https://haramlite.com/PRIVACY.html">سياسة الخصوصية</a> ·
  <a href="https://github.com/SMSMy/HaramLite/releases/latest">الإصدارات</a>
</p>

<p align="center">
  <img src="IMG/Screenshot.png" alt="واجهة HaramLite" width="840">
</p>

---

> **هذا المستودع هو الشيفرة المصدرية.**  
> للمستخدمين: كل شيء — التحميل، التثبيت، والإرشادات — على **[haramlite.com](https://haramlite.com/)**.

## ماذا يفعل؟

HaramLite تطبيق ويندوز يفصل الموسيقى عن الكلام **على جهازك** بنموذج ذكاء اصطناعي محلي (ONNX). لا يغادر الملف جهازك في أي خطوة.

| الوضع | النتيجة |
|---|---|
| **مقطع عادي** | يزيل الموسيقى ويبقي الكلام طبيعياً — مناسب للبودكاست والدروس والمقابلات. |
| **أغنية** | يعزل الصوت البشري، يحسّن الحضور، ويتخطّى فترات الصمت تلقائياً. |

**أيضاً:**

- لصق رابط يوتيوب أو غيره — التنزيل والمعالجة في خطوة واحدة
- سحب عدة ملفات دفعة واحدة، أو مجلد مراقبة يعالج كل ما يُضاف إليه
- إضافة متصفح: إرسال الرابط بنقرة، والمشاهدة بعد إزالة الموسيقى داخل الصفحة مع تخطي فترات الصمت
- روبوت تيليجرام اختياري مربوط بحسابك فقط (رمز اقتران من 6 أرقام)
- يعمل في صينية النظام، مع إشعار عند اكتمال المعالجة

التفاصيل والاستخدام: **[haramlite.com](https://haramlite.com/)**

## التحميل

**حمّل من الموقع الرسمي** — هناك المثبت الموصى به ونسخة MSI:

### [haramlite.com/#download](https://haramlite.com/#download)

| الملف | لمن؟ |
|---|---|
| `HaramLite_*_x64-setup.exe` | الجميع — يثبّت VC++ وأدوات المعالجة والنموذج تلقائياً |
| `HaramLite_*_x64_en-US.msi` | البيئات المُدارة (تثبيت صامت / GPO / MDM) |

النسخ الثنائية نفسها منشورة أيضاً في [GitHub Releases](https://github.com/SMSMy/HaramLite/releases/latest).

> التحديث الذاتي داخل التطبيق متوقف حالياً (مفتاح توقيع الإصدارات غير مضبوط بعد). للترقية: نزّل المثبت الجديد من الموقع أو من صفحة الإصدارات.  
> إن نُقص أي مكوّن (نموذج / أدوات) يظهر **معالج إصلاح ذاتي** يعيد تنزيله ويتحقق من بصمة SHA-256.

**المتطلبات:** Windows 10/11 (x64). لا شيء آخر — المثبت يتولى الباقي.  
للسرعة: كرت NVIDIA (CUDA) أو أي كرت DX12 (DirectML) يُستخدم تلقائياً عند تفعيله من الإعدادات.

## الاستخدام السريع

1. ثبّت التطبيق من [صفحة التحميل](https://haramlite.com/#download) وشغّله.
2. أفلت ملفاً (فيديو أو صوت) أو الصق رابطاً.
3. اختر الوضع: **أغنية** أو **مقطع عادي**، والناتج MP3 أو MP4.
4. اضغط المعالجة — النتيجة تُحفظ بجانب الملف الأصلي.

الواجهة عربية/إنجليزية من زر في الأعلى. زر الإغلاق يخفي البرنامج إلى صينية النظام؛ الإغلاق الكامل من قائمة الأيقونة.

## الخصوصية

كل خطوة — الفحص، الفصل، المؤثرات، والترميز — تتم **على جهازك**.

- لا رفع للملفات، لا حسابات، لا تحليلات، لا إعلانات
- الإنترنت اختياري: لتنزيل رابط طلبتَه، أو تحديث yt-dlp، أو روبوت تيليجرام إن فعّلته
- رمز البوت و`api_hash` يُخزَّنان مشفّرين بـ DPAPI داخل `%LOCALAPPDATA%`
- إضافة المتصفح لا ترسل أي طلب شبكة: تتحدث مع التطبيق المحلي عبر Native Messaging فقط

السياسة الكاملة: **[haramlite.com/PRIVACY.html](https://haramlite.com/PRIVACY.html)**

## للمطورين

البناء من المصدر موثّق في [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

**المكدس:** Tauri v2 · Rust · ONNX Runtime (UVR-MDX-NET-Voc_FT) · FFmpeg · yt-dlp · TypeScript / Vite · Tailwind CSS

```text
src/                 الواجهة
src-tauri/src/       خط المعالجة (GUI + CLI)
browser-extension/   إضافة MV3 — جسر محلي بلا تتبع
docs/                دليل المساهمة
```

مشاكل أو اقتراحات: [GitHub Issues](https://github.com/SMSMy/HaramLite/issues/new) — أو من داخل التطبيق: الإعدادات ← **الإبلاغ عن مشكلة**.

## الرخصة

[MIT](LICENSE) © 2026 HaramLite Contributors

المشروع مستقل وغير مرتبط بجوجل أو يوتيوب. المستخدم مسؤول عن احترام حقوق المحتوى الذي يعالجه.

---

<p align="center">
  <a href="https://haramlite.com/"><strong>haramlite.com</strong></a>
</p>

---

## English

**HaramLite** removes background music from video and audio with on-device AI. Nothing is uploaded. There is no cloud and no account.

This repository is the source. **Users should start at [haramlite.com](https://haramlite.com/)** — download, install, privacy policy, and product docs all live there.

- **Clip mode** — remove the music, keep speech natural
- **Song mode** — isolate vocals, polish presence, trim silence
- Paste a YouTube (or other) URL, batch files, or a watch folder
- Browser extension (local native messaging) and an optional paired Telegram bot you link yourself
- Windows 10/11 x64 · GPU via CUDA or DirectML when enabled

Download: **[haramlite.com/#download](https://haramlite.com/#download)**  
Privacy: **[haramlite.com/PRIVACY.html](https://haramlite.com/PRIVACY.html)**  
Build from source: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)  
License: [MIT](LICENSE)
