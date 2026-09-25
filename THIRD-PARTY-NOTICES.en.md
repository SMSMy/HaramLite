<!-- English translation of THIRD-PARTY-NOTICES.md. The Arabic file remains the
     canonical text; if the two ever disagree, the Arabic one governs. -->
# Third-party notices — HaramLite

> **What this file is:** documentation of every external component **distributed** with HaramLite (inside the installer or in GitHub releases), with its licence and its source.
> **What it is not:** it is not legal advice — it is a technical record of measured facts, and every item I could not prove is marked **"needs verification"** and I did not invent a licence for it.
>
> **Last updated:** 2026-09-15 · **Reference version:** 0.2.5 (engine: an FFmpeg build under **LGPLv3**) · **Auditor:** an A→Z audit session + measurements of release 0.2.5.
>
> **A source-conformance review (2026-09-25 · on `0db0ade` · the version in the tree is 0.2.8):** **every
> item** in this file was re-measured against **the shipped sources themselves** (`bin/**` · `models/**` ·
> `src-tauri/Cargo.toml`+`Cargo.lock` · `package.json`+`pnpm-lock.yaml` ·
> `src-tauri/tauri.conf.json` · `licenses/**` · the `name` tables inside the font files).
> **The result:** every **hash** and every **size** in section ١ matches exactly (5/5), the Rust package
> figures match, and **two corrections** were made: the `yt-dlp` version, which was blank, and the
> incompleteness of the licence-distribution table (12 rows out of **32** licence strings), **plus a link
> correction** in section ٥. Whatever was not measured is marked where it stands.
>
> **And the limit of this review:** what was measured is **conformance to the sources**, not **the
> interpretation of licences** — and no licence type was changed in any item.

---

## ١) Components bundled inside the installer (NSIS/MSI)

| Component | Path | Version | Licence | How we verified it |
|---|---|---|---|---|
| FFmpeg | `bin/ffmpeg.exe` (126.1 MiB · 132,238,848 bytes) | `n8.1.2-52-g5a03dfa0f6-20260914` (a `BtbN/FFmpeg-Builds` build · `win64-lgpl`) | **LGPLv3** | ✅ `ffmpeg -version`: the configuration line carries `--enable-version3` and does **not** carry `--enable-gpl` · and the hash of our published asset is `sha256:799b9ee9…61dd4b` |
| FFprobe | `bin/ffprobe.exe` (125.9 MiB · 132,033,536 bytes) | `n8.1.2-52-g5a03dfa0f6-20260914` (the same build) | **LGPLv3** | ✅ the same configuration line · and the hash of our published asset is `sha256:01af86fa…5b94dab` |
| yt-dlp | `bin/yt-dlp.exe` (17.0 MB · 17,840,399 bytes) | **`2026.08.19`** (measured 2026-09-25 with `yt-dlp --version` on the shipped binary) | **Unlicense** | ✅ the GitHub page: `yt-dlp/yt-dlp` · and the hash of our asset is `sha256:66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a` (pinned in `repair.rs` and `fetch_redist.js`) |
| Separation model | `models/UVR-MDX-NET-Voc_FT.onnx` (63.7 MB) | UVR-MDX-NET | **MIT** — with mandatory attribution | ✅ its original is published in `TRvlvr/model_repo` (the `all_public_uvr_models` release) under the same name and size |
| VC++ Redistributable | `vc_redist.x64.exe` (~24 MB) | Microsoft | Microsoft's redistribution licence | ✅ the official page: `learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution` (its existence is verified) — and our obligation: including the reference to it alongside the distribution |

> **Re-measured 2026-09-25:** the five components above are all present on disk with the exact byte
> counts recorded here (the first four at the root of the source tree, and `vc_redist.x64.exe` inside
> `src-tauri/`), and the four SHA-256 hashes re-computed here match the pinned constants in `repair.rs`
> and `fetch_redist.js`. And `ffmpeg -version` was re-run on the shipped binary: `--enable-version3`
> **present**, `--enable-gpl` **absent** — unchanged.

### FFmpeg — LGPLv3 obligations (after the 0.2.5 switch)

**The configuration line measured from the bundled binary** (`ffmpeg -version`, 2026-09-15):
`--enable-version3` **present** · `--enable-gpl` **absent** · `--disable-libx264` · `--disable-libx265` ⇒ **the file is LGPLv3** (and not GPLv3 as the earlier `gyan.dev` build was).

1. **The licence text** is shipped with the distribution: `licenses/LGPL-3.0.txt` (7,652 bytes · `sha256:e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118` from `gnu.org`) **and** `licenses/GPL-3.0.txt` (35,149 bytes · `sha256:3972dc97…dfb36986`) — the second is **necessary** because LGPLv3 is a text of "additional permissions" on top of GPLv3 and refers to it. The whole folder is listed in the bundle resources (`tauri.conf.json` ⇒ `"../licenses": "licenses"`).
2. **The corresponding source**: available more cleanly than with the earlier gyan build:
   - **The FFmpeg source itself**: the upstream version is declared **by the binary itself** (`n8.1.2-52-g5a03dfa0f6` ⇒ the branch `n8.1.2` + the revision `5a03dfa0f6`) from `ffmpeg.org`.
   - **The build scripts**: `BtbN/FFmpeg-Builds` **publishes them** (`build.sh` · `scripts.d/` · `variants/` · `patches/` · `makeimage.sh`) ⇒ there no longer remain "unpublished patches" as was the case with `gyan.dev`.
   - **Pinning the bytes**: the BtbN tag moves, but what we ship is **pinned by SHA-256 hash on the `assets-v1` release** (the two published assets being named `ffmpeg-lgpl.exe` · `ffprobe-lgpl.exe`), so what is shipped to any user is specific bytes and not "the latest build".
3. **No additional restrictions** on the file or on whoever receives it, and **the right to substitute/relink** is preserved because the linking between our application and FFmpeg is **process linking, not library linking** (item ٤).
4. **The HaramLite application itself remains MIT**: it invokes `ffmpeg`/`ffprobe` **as child processes** through `Command::new().args()` (`media.rs`) — that is, two independent programs (mere aggregation), with no linking and no combining.
5. **`--enable-libopenh264` is present in the configuration** (it is an open encoder from **Cisco**, and its licence is not LGPL): the binary carries it, **and our code does not use it on any path** — our two paths are `h264_nvenc` and `h264_mf` (and the size-cap fallback is `h264_mf` as well). It is mentioned here for transparency: whoever runs `libopenh264` directly from this binary needs the Cisco licence, and we do not. And it is not added as a fallback encoder in this release (a decision recorded in `0.2.5.md`).

> **An architectural note (a corrected history):** the reason a GPL build was chosen earlier was the use of `libx264` in **two production places** and one test place. **In 0.2.5 `libx264` was removed from the code**: the normal export path uses `h264_nvenc` first (`-preset p4 -cq 20`) and `h264_mf` as the software alternative (`-rate_control quality -quality 85`), and the size-cap path (a byte budget, the Telegram limit) uses `h264_mf` in a rate-constrained mode. And the test-sample generator no longer rests on `libx264` either.
> **Quality equivalence (measured 2026-09-15 · three real contents):** `h264_mf -quality 85` against `libx264 crf18` ⇒ **VMAF +0.06…+0.56** (equivalent, or slightly better), with a size difference of **−3.6% / +37.3% / +83.5%**, and the **output profile is `Constrained Baseline`** (no B-frames), which explains part of the size growth. **A declared limit**: the references were **compressed** ⇒ the numbers are **relative, not absolute**, and the contents are only three kinds; and the final verification was the owner's eye and his permission.

### The separation model `UVR-MDX-NET-Voc_FT.onnx` — MIT with mandatory attribution

| Item | Details |
|---|---|
| The official source | `TRvlvr/model_repo` — the `all_public_uvr_models` release (the same name, 63.7 MB) ✅ we verified the asset exists among 86 assets |
| The developers | the Ultimate Vocal Remover team — **Anjok07** and **aufr33** (the README: "UVR's core developers trained all of the models provided in this package") |
| The licence | **MIT** |
| The required attribution | the project's text verbatim: "For all third-party application developers who wish to use our models, please honor the MIT license by providing credit to UVR and its developers" ✅ read from the project README |
| A recommended attribution | the **MDX-Net** architecture from KUIELab — its licence is **MIT** ✅ |

**The attribution that must appear in the application and the site:** "The separation model is from Ultimate Vocal Remover (Anjok07 & aufr33) — under the MIT licence".

⚠️ **A declared limit:** the hash of the original is **not published** in the GitHub page for that release (the `digest` field is empty), so I could not prove that our file matches the original byte for byte. But the application pins the file's hash in `repair.rs` and verifies it on download, and the hash of our local file is: `sha256:534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111`.
> **And this limit was re-measured 2026-09-25 from the GitHub API itself:** that release really does
> have **86 assets**, the asset `UVR-MDX-NET-Voc_FT.onnx` is really present with size **66,762,490**
> bytes — which is **the same** as our local file — and its `digest` really is **empty**, exactly as
> recorded above. So the claim stands both ways: the size and the name match, and the hash **still
> cannot be** proven from GitHub.
---

## ٢) Components downloaded on demand (the `assets-v1` release; they do not enter the installer)

| Component | Files | Version | Licence | How we verified it |
|---|---|---|---|---|
| CUDA Runtime (cudart · cublas · cublasLt · cufft) | 4 DLLs | CUDA **12.8.2** | NVIDIA's licence for redistributable CUDA | ✅ from the fetch script: `developer.download.nvidia.com/compute/cuda/redist/` |
| cuDNN | 10 DLLs | cuDNN **9.12.0** | an NVIDIA licence (the same kind) | ✅ the same source |
| ONNX Runtime CUDA provider | `onnxruntime_providers_{shared,cuda}.dll` | **1.22.0** | **MIT** | ✅ the GitHub page: `microsoft/onnxruntime` |
| The assets manifest | `cuda-runtime-manifest.json` | — | produced by the project | ✅ |

**The governing licence:** the NVIDIA CUDA end-user licence agreement (CUDA EULA) — and the item concerned by name is **"1.1.2 Distribution Requirements"** ✅ (I verified its existence in the licence index at `docs.nvidia.com/cuda/eula/index.html`).
> **Re-verified 2026-09-25:** the page `docs.nvidia.com/cuda/eula/index.html` answers **HTTP 200**, and the
> string **"1.1.2. Distribution Requirements"** is present in it. And the three version numbers above are
> the ones the code actually pins: `$CUDA_VER = '12.8.2'` · `$CUDNN_VER = '9.12.0'` · `$ORT_VER = '1.22.0'`
> in `.github/workflows/cuda-assets.yml`.
**A required action:** the licence text, or an explicit reference to it, must be shipped with these assets in the release and in `assets-v1` — **not done yet.**

---

## ٣) Rust libraries (compiled into the binary)

The source of the numbers: `cargo metadata --format-version 1 --locked` on `src-tauri/Cargo.toml` ⇒ **597 packages, of which 596 are external**. The distribution by the licence field:

> **Measured 2026-09-25 on `0db0ade`:** **597 packages · 596 external** — matching exactly what was
> recorded here. And **the number of distinct licence strings is ٣٢**, not ١٢: the table below was showing
> **only the first twelve rows** (٨٨٪ of the packages) and **was silent about the remaining twenty**
> (٧٠ packages), and among them are strings with an obligational effect (`BSD-3-Clause` ·
> `CDLA-Permissive-2.0` · `0BSD` · `CC0-1.0`).
> The table is now complete, **and the added rows are marked `[+]`** so that what changed in this review is known.

| Licence | Number of packages |
|---|---|
| `MIT OR Apache-2.0` | 282 |
| `MIT` | 131 |
| `Apache-2.0 OR MIT` | 57 |
| `MIT/Apache-2.0` | 28 |
| `Zlib OR Apache-2.0 OR MIT` | 18 |
| `Unicode-3.0` | 18 |
| `Unlicense OR MIT` | 9 |
| `MPL-2.0` | 5 |
| `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | 5 |
| `ISC` | 5 |
| `Apache-2.0` | 4 |
| `Apache-2.0 OR ISC OR MIT` | 3 |
| `[+] BSD-3-Clause` | 3 |
| `[+] Apache-2.0/MIT` | 3 |
| `[+] CDLA-Permissive-2.0` | 3 |
| `[+] BSD-3-Clause OR MIT OR Apache-2.0` | 2 |
| `[+] MIT OR Apache-2.0 OR LGPL-2.1-or-later` | 2 |
| `[+] MIT OR Apache-2.0 OR Zlib` | 2 |
| `[+] Unlicense/MIT` | 2 |
| `[+] BSD-2-Clause OR Apache-2.0 OR MIT` | 2 |
| `[+] 0BSD OR MIT OR Apache-2.0` | 1 |
| `[+] BSD-3-Clause AND MIT` | 1 |
| `[+] BSD-3-Clause/MIT` | 1 |
| `[+] Apache-2.0 AND MIT` | 1 |
| `[+] CC0-1.0 OR MIT-0 OR Apache-2.0` | 1 |
| `[+] Apache-2.0 / MIT` | 1 |
| `[+] Zlib` | 1 |
| `[+] MIT OR Zlib OR Apache-2.0` | 1 |
| `[+] CC0-1.0` | 1 |
| `[+] Apache-2.0 AND ISC` | 1 |
| `[+] Apache-2.0 WITH LLVM-exception` | 1 |
| `[+] (MIT OR Apache-2.0) AND Unicode-3.0` | 1 |

**Obligation notes:**
- The overwhelming majority are permissive licences (MIT/Apache-2.0/ISC/Zlib) that impose nothing more on a binary distribution than attribution and retaining the text.
- `MPL-2.0` (5 packages) imposes making available the source of **the modified files** only — and the project does not modify their files.
- `Unicode-3.0` (18 packages) requires the licence text alongside the distribution.
- **`CDLA-Permissive-2.0` (٣ packages) · `CC0-1.0` (a package, and a package as an alternative) · `0BSD` (a package as an alternative)** — they were added to the table after having been missing from it; **no licence type was changed** and their effect is not interpreted here (see the review limit at the top of the file).
- The complete list can be generated mechanically from `Cargo.lock` with the command: `cargo metadata --format-version 1`.
- **And the limit of the table:** it is **the distribution of the text of the `license` field as the packages declare it**, not a ruling on actual compliance with each licence.

---

## ٤) The user interface and the icons

| Component | Licence | How we verified it |
|---|---|---|
| Tauri v2 + its plugins (dialog · notification · updater · opener) | **MIT OR Apache-2.0** (the interface shows Apache-2.0) | ✅ the GitHub page: `tauri-apps/tauri` · `tauri-apps/plugins-workspace` |
| Material Symbols (the icons) | **Apache-2.0** | ✅ the GitHub page: `google/material-design-icons` |
| Thmanyah Sans / Serif Display | **a restricted custom licence** — see section ٥ | ✅ the licence text extracted from inside the font file |

---

## ٥) The fonts — the Thmanyah font

**The source:** `font.thmanyah.com` (the official site from which the font is downloaded — measured: it answers **HTTP 200**) · **The owner:** Thmanyah Publishing and Distribution Company · **Contact:** `ask@thmanyah.com`
**The licence text:** "Thmanyah's Font License — Copyright © 2026, Thmanyah Publishing and Distribution, with Reserved Font Name "thmanyah"" (extracted from the name table inside the OTF file itself).
> **And a measured correction (2026-09-25) — the link the font declares about itself:** the `LicenseInfoURL`
> field in the `name` table inside the shipped OTF file is **`https://company.thmanyah.com/`** (read from
> `src/assets/fonts/thmanyahsans-Regular.otf` · `browser-extension/thmanyah-sans-*.otf`),
> **not `font.thmanyah.com`**. Both sites answer 200, **and both are mentioned**:
> `font.thmanyah.com` is the official download according to the licence text, and `company.thmanyah.com`
> is the address the font declares. **The licence text was not changed** — the correction is in **the link** alone.
> **And a limit:** it was not measured which of the two sites is the legally binding reference — that is **an interpretation of a licence**, which we do not measure.

### What it expressly permits ✅
> «**تضمين برنامج الخط في المستندات أو التطبيقات أو المنتجات** التي تنشئها»
> (translation: "**Embedding the Font Software in the documents, applications or products** you create")
> «تضمين برنامج الخط في مواقع الويب أو تطبيقات الويب… **وذلك فقط كجزء من منتج مُجمَّع أو مُعبَّأ أو مُعَمّى**»
> (translation: "Embedding the Font Software in websites or web applications… **only as part of a compiled, packaged or obfuscated product**")

### What it expressly forbids ✗
> «**إعادة توزيع برنامج الخط أو مشاركته أو رفعه أو استضافته أو إتاحته للتنزيل على أي موقع إلكتروني أو خادم أو منصة رقمية** أو خدمة مشاركة ملفات»
> (translation: "**Redistributing the Font Software, sharing it, uploading it, hosting it, or making it available for download on any website, server or digital platform**, or file-sharing service")
> «**ولا يجوز تنزيل برنامج الخط إلا من الموقع الرسمي لثمانية**»
> (translation: "**And the Font Software may not be downloaded except from Thmanyah's official site**")
> «إتاحة برنامج الخط بأي طريقة تُمكّن المستخدمين النهائيين… من استخراج برنامج الخط أو تنزيله… **بما في ذلك عبر التضمين على الويب**»
> (translation: "Making the Font Software available in any way that enables end users… to extract the Font Software or download it… **including through web embedding**")

### The three places in the project and their status

| Place | Files | The ruling **after the reply** | The action |
|---|---|---|---|
| Inside the Windows application (installer) | `src/assets/fonts/` 5 files | **expressly permitted** ("embedding it in applications… and software products") | **the font stays** — and the files are withdrawn from tracking and injected at build time |
| Inside the browser-extension package | `browser-extension/` 3 files | **expressly permitted** (a packaged product) | **the font stays** — and it is withdrawn from tracking like the application |
| The project's public repository | **11 tracked files** (5 application · 3 extension · 3 site) | **non-compliant — and the reply asks for it explicitly** | **they are removed from the public repository** (pending the owner's decision on a CI injection mechanism) |
| The web fonts on the site | `docs/assets/` 3 WOFF2 files | **not permissible**: files in a public repository **and available for download** from `haramlite.com` | **they are replaced with an OFL font** (GitHub Pages serves from the repository) |
| The repository history | 26 font files in earlier commits | **it stays exposed** by removing them from the tree alone | the owner's decision — removing it from the history is **destructive** and was not carried out |

### The rights holder's reply (2026-09-15 · Hatem Saud — `ask@thmanyah.com`)

> **What was expressly permitted:** «الترخيص الحالي يتيح استخدام الخط في المشاريع الشخصية والتجارية، بما في ذلك **تضمينه في التطبيقات والمواقع والمنتجات البرمجية**، وذلك وفق الشروط والقيود المنصوص عليها في الترخيص.»
> (translation: "The current licence allows the use of the font in personal and commercial projects, including **embedding it in applications, sites and software products**, in accordance with the terms and restrictions set out in the licence.")
> **What was forbidden:** «لا يسمح الترخيص بإعادة توزيع ملفات الخط أو مشاركتها أو **رفعها أو استضافتها على المواقع أو المستودعات أو المنصات الرقمية**، كما لا يسمح بإتاحة ملفات الخط بطريقة تمكّن المستخدمين أو الأطراف الثالثة من **استخراجها أو تنزيلها أو الوصول إليها كملفات خطوط مستقلة**.»
> (translation: "The licence does not permit redistributing the font files or sharing them, or **uploading them or hosting them on sites, repositories or digital platforms**, nor does it permit making the font files available in a way that enables users or third parties to **extract them, download them or access them as independent font files**.")
> **The explicit request:** «فإن **ملفات الخط المرفوعة حاليًا على المستودعات العامة في GitHub لا تدخل ضمن الاستخدامات المسموح بها** في الترخيص، ونأمل إزالتها من المستودعات العامة.»
> (translation: "Therefore **the font files currently uploaded to public repositories on GitHub do not fall within the permitted uses** of the licence, and we hope they will be removed from public repositories.")

**Reading the reply precisely (and correcting an earlier reading):** the reply is **not a refusal of use** — it is **a permission to embed in the product** + **a prohibition of public publication**. Accordingly, saying "we keep it and only hide the `font/` folder" is **not sufficient**: the **11 tracked files** are exactly what the reply calls "the font files currently uploaded to public repositories", and the three site files are more serious still because they are **available for download directly** from the site.

### The ready alternative (updated after the reply)
1. **The site**: replacing the web fonts with a font under the **OFL** licence (IBM Plex Sans Arabic · Noto Kufi Arabic · Cairo · Almarai) — the change is confined to `site.input.css` (the font families) and `site.tailwind.config.cjs` (the family names), plus adding the OFL files to `docs/assets/` and then regenerating `docs/assets/site.css` with `pnpm site:css`; and the guard `scripts/check-site-css.cjs` automatically verifies that every `url(*.woff2)` exists, so it passes or fails by itself.
2. **The repository**: withdrawing the 11 from tracking (`git rm --cached` + `.gitignore`) — the files stay on the owner's machine and **the local build is not affected at all** (the application reads `src/styles.css` by a relative path, the extension `popup.css`, and the site's CSS is generated) — **with an injection mechanism in CI** because `release.yml` builds the releases on GitHub and does not have the files at that moment: (a) a private repository for the fonts + an access secret, or (b) building the release locally and uploading the installers. (And the total is 1.9 MB for eight files ⇒ they are not suitable as individual GitHub "secrets".)
3. **The application and the extension**: they both stay on the Thmanyah font ✅ — expressly permitted in the reply.
4. **Not recommended**: encrypting the files and uploading them encrypted — an obligation built on a verbal loophole after an explicit request for removal, and trust matters more than 1.9 MB.

---

## ٦) The frozen references (not distributed — algorithmic references only)

| Reference | Licence | How we verified it |
|---|---|---|
| `nomadkaraoke/python-audio-separator` | **MIT** | ✅ the GitHub page |
| `Anjok07/ultimatevocalremovergui` (UVR5) | **MIT** | ✅ the GitHub page |

> These are read-only files in the engine audit; **none of them is shipped**. And the engine constants actually used are documented in `docs/AUDIT.md`.

---

## ٧) The extension (Chrome/Edge)

No external dependencies: `browser-extension/` is raw code with no libraries, apart from the font files (section ٥). And there are only three permissions, and no network request at all.

---

## ٨) The checklist before every release

- [x] **The two licence texts are shipped with the distribution** — `licenses/LGPL-3.0.txt` (7,652 bytes · `sha256:e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118`) **and** `licenses/GPL-3.0.txt` (35,149 bytes · `sha256:3972DC9744F6499F0F9B2DBF76696F2AE7AD8AF9B23DDE66D6AF86C9DFB36986`), both from `gnu.org` — and the second is necessary because LGPLv3 refers to GPLv3. The folder is listed in the bundle resources (`tauri.conf.json` ⇒ `"../licenses": "licenses"`), so the recipient receives it inside the installation folder.
- [x] **The corresponding FFmpeg source — discharged cleanly after the 0.2.5 switch**: the bundled binary is **LGPLv3** (`--enable-version3` without `--enable-gpl`), and the source revision is **declared by the binary itself** (`n8.1.2-52-g5a03dfa0f6`), and **the provider publishes its build scripts** (`BtbN/FFmpeg-Builds`: `build.sh` · `scripts.d/` · `variants/` · `patches/`) ⇒ the problem of "the provider's unpublished patches" that existed with `gyan.dev` has fallen away. And the hashes are pinned on `assets-v1`.
- [ ] **Verifying that the bundled `bin/` really is LGPL bytes** on every release: `ffmpeg -version` must show the **absence** of `--enable-gpl`, and the file's hash must match the published asset (`ffmpeg-lgpl.exe`) — it is placed in the pre-release checklist.
- [x] The model's licence is documented as **MIT** with the attribution required by UVR — see section ١.
- [x] **The NVIDIA licence is referenced**: in this file (item 1.1.2) · in the `v0.2.3` release notes · in the notes of the `assets-v1` release itself (where the assets are distributed) and in the text of the `cuda-assets.yml` workflow for what follows it.
- [x] The Tauri and plugin licences are confirmed: **MIT OR Apache-2.0** — section ٤.
- [x] **The UVR attribution is visible to the user** — in "About the program" (`src/main.ts`: the attribution list: the model name + Ultimate Vocal Remover + Anjok07 and aufr33 + MIT + a link) and in the site footer (`docs/index.html`).
- [x] The status of the Thmanyah font permission is up to date: **sent 2026-09-15 · and the reply arrived 2026-09-15** (Hatem Saud) = **a permission to embed in the product** + **a prohibition of public publication** + **a request to remove the 11 files from public repositories** — the details are in section ٥.
- [ ] **Removing the 11 Thmanyah font files from the public repository** (and what follows from it: replacing the site fonts with OFL · and a font-injection mechanism in the CI build) — pending the owner's decision; the details are in section ٥.
- [ ] **Shipping this file with the distribution — a counter-measurement (2026-09-25)**: three places in the published documentation say this file is "inside the installation folder" (`docs/RELEASE-0.2.5.md:99` · `docs/RELEASE-0.2.6.md:161` · `README.md`/`README.ar.md` in a looser wording). **And what is measured is that the bundle resources in `src-tauri/tauri.conf.json` are only four**: `"../bin"` · `"../models"` · `"../licenses"` · `"vc_redist.x64.exe"` — **and this file is not among them**, so it reaches the recipient only as a file in the repository on GitHub.
  **And the limit of the measurement:** `tauri.conf.json` establishes **what is declared to the bundler**, not what settled into an installer built earlier — and an attempt to read the file table of a 0.2.7 installer locally **failed** (the payload is LZMA-compressed, and a control test on known names found none of them ⇒ the check is blind and nothing may be built on it).
  So the item is **open**: either the file is added to `bundle.resources`, or the three places are corrected. **And `tauri.conf.json` was not modified in this round** (the owner's decision).
