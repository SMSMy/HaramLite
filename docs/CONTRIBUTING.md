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

## إصدار جديد (Release) — المسار الحقيقي (كما نُفِّذ في 0.2.3)

> تنبيه: دفع وسم `vX.Y.Z` **لا يبني شيئاً**. المشغّل على الوسوم **معطَّل عمداً**
> (`release.yml:19-26` — حصة Actions متضايقة)، والتوقيع **مؤجَّل** (`:70-71` معلَّق
> بانتظار السرّ) و`includeUpdaterJson: false` (`:83` — فلا `latest.json` ولا `.sig`).
> الخطوات أدناه هي ما يحدث فعلاً، لا ما كان مخططاً له.

1. ارفع الإصدار في **المواضع الخمسة**: `package.json` · `src-tauri/tauri.conf.json` ·
   `src-tauri/Cargo.toml` · `src-tauri/Cargo.lock` (يتحدّث تلقائياً عند البناء —
   تأكّد أن المحدَّث هو الملتزَم) · `browser-extension/manifest.json` (للإضافة مسار
   إصدارات مستقل عن التطبيق).
2. ابنِ محلياً: `pnpm tauri build` (يُنتج المثبّتَين: NSIS + MSI).
3. اكتب `docs/RELEASE-X.Y.Z.md` بالبصمات **المقيسة من مخرجات بنائك المحلي**
   (`Get-FileHash -Algorithm SHA256`).
4. انشر من جهازك:
   `gh release create vX.Y.Z --target <sha> --notes-file docs/RELEASE-X.Y.Z.md <المثبّت_NSIS> <المثبّت_MSI>`.
5. **بعد النشر**: حدِّث البصمات في `docs/RELEASE-X.Y.Z.md` من **الأصول المنشورة
   فعلاً** — البناء الآلي لا يطابق المحلي بايتاً ببايت (مُثبَت على 0.2.2 و0.2.3).
6. بديل: تشغيل `release.yml` **يدوياً** من تبويب Actions (يبني وينشر بلا توقيع
   ولا `latest.json` حتى تُضاف أسرار التوقيع أدناه).
7. **أسرار المستودع المطلوبة (عند تفعيل التحديث الذاتي فقط):**
   - `TAURI_SIGNING_PRIVATE_KEY` ← محتوى `updater.key` (المولّد محلياً، **ممنوع رفعه**).
   - توليد مفتاح جديد: `pnpm tauri signer generate -w updater.key --ci` وضع المفتاح العام في `plugins.updater.pubkey`.
8. **أصول الإصلاح (`assets-v1`)** — إصدار ثابت يحوي ما ينزّله معالج الإصلاح:
   `bin/*.exe` و`models/*.onnx` (يرفعها `release.yml` عند إنشاء الإصدار أول مرة)
   و**ستة عشر ملف CUDA/cuDNN/ORT** مع منفستها (`cuda-assets.yml` هو الذي يجمّعها
   ويرفعها). تنبيه مقيس: خطوة `release.yml:85-95` **تنشئ أو تتخطّى بلا رفع**، فلا
   يُحدَّث الإصدار إلا بتشغيل `cuda-assets.yml` يدوياً. وبصمات الأصول مثبتة في
   `repair.rs` — عند تغيير الأصول حدِّث البصمات
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
