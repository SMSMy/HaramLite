# المساهمة في HaramLite (Developer Guide)

## متطلبات التطوير

- [Rust & Cargo](https://rustup.rs/) (stable, MSVC toolchain)
- [Node.js](https://nodejs.org/) 20+ و [pnpm](https://pnpm.io/) 10+
- Windows 10/11 (الهدف الأساسي)

## الملفات المستثناة من Git

مجلدا `bin/` و `models/` كبيران ومستثنيان من المستودع — وفّرهما يدوياً للمطورين:

1. `bin/` ← `ffmpeg.exe` + `ffprobe.exe` + `yt-dlp.exe`
2. `models/` ← `UVR-MDX-NET-Voc_FT.onnx`

> للتطبيق المنشور: المثبت يضمّنهما تلقائياً، ومعالج الإصلاح الذاتي ينزّلهما من
> إصدار `assets-v1` عند نقصهما (انظر أدناه).

## البناء والتشغيل

```bash
pnpm install
pnpm tauri dev          # تطوير (يولّد tailwind.css تلقائياً عبر predev)
pnpm build              # واجهة فقط (fetch_redist + tailwind + tsc + vite)
pnpm tauri build        # مثبت NSIS + أصول التحديث (latest.json + .sig)
```

- عند تغيير فئات Tailwind في `index.html` أعد تشغيل `pnpm dev` أو نفّذ `pnpm build:css`.
- `src/tailwind.css` مولّد (في gitignore).

## بنية المشروع

```
src/                  الواجهة (Vite + TS + Tailwind مبني محلياً)
src-tauri/src/
  pipeline.rs         خط المعالجة المشترك (GUI + CLI)
  separator.rs        محرك الفصل (ort / MDX-Net / STFT)
  media.rs            ffprobe/ffmpeg + التوحيد + الترميز
  effects.rs …        سلسلة DSP (reverb/delay/EQ/compressor/LUFS/قص صمت)
  yt_dlp.rs           التنزيل + التحديث الآمن (SHA-256 + تبديل ذري)
  repair.rs           معالج الإصلاح الذاتي (manifest المكونات + تحقق البصمة)
  settings.rs         الإعدادات الموحدة (JSON في app_data_dir)
  watch_service.rs    مجلد المراقبة (notify + مسح دوري + حارس القرص)
  bridge.rs           Native Messaging مع إضافة المتصفح
browser-extension/    إضافة MV3 (روابط فقط — بلا تتبع)
.github/workflows/release.yml   الإصدارات (tauri-action + أصول الإصلاح)
```

## إصدار جديد (Release)

1. ارفع الإصدار في: `package.json` + `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml` + شارة `index.html`.
2. ادفع وسم `vX.Y.Z` — سير العمل يبني المثبت ويوقعه ويرفع `latest.json`.
3. **أسرار المستودع المطلوبة:**
   - `TAURI_SIGNING_PRIVATE_KEY` ← محتوى `updater.key` (المولّد محلياً، **ممنوع رفعه**).
   - توليد مفتاح جديد: `pnpm tauri signer generate -w updater.key --ci` وضع المفتاح العام في `plugins.updater.pubkey`.
4. **أصول الإصلاح (`assets-v1`):** أول تشغيل للسير ينشئ إصداراً ثابتاً باسم
   `assets-v1` يحوي `bin/*.exe` و `models/*.onnx`. بصماتها مثبتة في
   `repair.rs` — عند تغيير الأصول حدّث البصمات
   (`Get-FileHash -Algorithm SHA256`).

## ملاحظات معمارية

- **CRT ديناميكية عن قصد:** مكتبات ONNX Runtime الجاهزة تتوقع UCRT الديناميكية،
  والمثبت يثبّت VC++ Redist تلقائياً (`hooks.nsh`). لا تعد `+crt-static`.
- **قيدا النسخة المحمولة:** التحديث الذاتي وإشعارات ويندوز (AUMID) يتطلبان
  التثبيت عبر المثبت — المحمولة تخفّض رشيقاً وتوضح ذلك في الواجهة.
- **مجلد المراقبة:** الأحداث وحدها لا تكفي (OneDrive/مضاد الفيروسات يفوّتانها)
  — المسح الدوري (60 ثانية افتراضياً) شبكة الأمان، وحارس القرص يرفض قبل الفصل.
- **الإضافة:** Native Messaging فقط (لا منافذ HTTP). المضيف يكتب ملف طلب في
  `app_data_dir/requests/` والنسخة العاملة تلتقطه — انظر `bridge.rs`.

## الاختبارات اليدوية السريعة

```bash
cargo run --bin HaramLite -- --check     # فحص المكونات الأربعة
cargo run --bin HaramLite -- --probe <file>
# بروتوكول المضيف:
echo -n '{"type":"ping"}' | (اكتب الطول 4 بايت ثم الرسالة) | HaramLite.exe --native-host
```
