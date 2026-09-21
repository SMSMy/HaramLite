import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';

// ── vc_redist (unchanged behavior) ──────────────────────────────────────
const redistUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const redistDest = path.join(process.cwd(), 'src-tauri', 'vc_redist.x64.exe');
// Audit 2026-09-03: sanity floor for the real installer (an error page is
// kilobytes). A pinned SHA-256 would be stronger; the URL is versionless so
// a floor + status check is the stable option.
const MIN_SANE_BYTES = 5 * 1024 * 1024;

// ── CI bundle resources (added 2026-09-05) ──────────────────────────────
// Release-CI root cause: a clean runner has no bin/ or models/ (both
// gitignored, fetched by nothing) so tauri build dies on `..\bin`.
// These MUST stay byte-identical to `src-tauri/src/repair.rs` COMPONENTS
// (same assets-v1 release, same remote asset name, same SHA-256) — the in-app
// repair wizard and CI then resolve the exact same bytes.
//
// 2026-09-15 (ب.١ · ب.٤.أ): `asset` and `dest` are now separate. The release
// asset is named after its license (`ffmpeg-lgpl.exe`) so the LGPL switch is
// auditable, while the file must still LAND as `bin/ffmpeg.exe` because
// `media::resolve_tool("ffmpeg")` looks for exactly that name. The 0.2.4 GPL
// assets keep their old names on the same release, so a published client's
// self-repair keeps verifying the bytes its embedded hash expects.
//
// 2026-09-17 (ن-٢ في خطة 0.2.9 §١١) — **البصمة تُقاس عند الوجود أيضاً**:
// كان الشرط `if (fs.existsSync(dest)) { …; return; }` يفحص **الوجود قبل البصمة**،
// فملف موجود ببصمة خاطئة (تنزيل قديم، أو نصّ أُبدل يدوياً، أو أثر نسخ جزئي) كان
// **يُشحن بلا أي قراءة بصمة** — و`repair.rs` في التطبيق يرفض تلك البايتات نفسها،
// فينكسر الإصلاح الذاتي عند المستخدم بلا أن يسقط شيء في البناء.
// والقاعدة الآن: **موجود ⇒ تُقاس بصمته**، ومخالفتها فشل صريح. والاستثناء الوحيد
// مقصود ومعلَن: `--allow-foreign` لمطوّر يُبقي عمداً أداة أحدث في `bin/`
// (كانت النية القديمة «أدوات المطور الأحدث آمنة»؛ صارت **مُعلَنة** لا صامتة،
// ولا يمرّرها أي مسار إصدار: `pnpm build` و`release.yml` بلا وسائط).
const ASSET_BASE = 'https://github.com/SMSMy/HaramLite/releases/download/assets-v1';
const COMPONENTS = [
    { asset: 'ffmpeg-lgpl.exe', dest: 'ffmpeg.exe', subdir: 'bin', sha256: '799b9ee9484f1cb7eeee997099afc8ab8cda7a2a9bd52615d5ddf3770561dd4b' },
    { asset: 'ffprobe-lgpl.exe', dest: 'ffprobe.exe', subdir: 'bin', sha256: '01af86fa4b71fd53c11862ecbc7089519cdf9fe7403b821ceee860f415b94dab' },
    { asset: 'yt-dlp.exe', dest: 'yt-dlp.exe', subdir: 'bin', sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a' },
    { asset: 'UVR-MDX-NET-Voc_FT.onnx', dest: 'UVR-MDX-NET-Voc_FT.onnx', subdir: 'models', sha256: '534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111' },
];
const MIN_COMPONENT_BYTES = 1 * 1024 * 1024;

// ── CLI ─────────────────────────────────────────────────────────────────
const USAGE = `الاستعمال: node ./scripts/fetch_redist.js [خيارات]

  --verify                  تحقّق فقط: كل ملف مطلوب موجود وبصمته مطابقة — **ولا تنزيل**
  --asset-url-base=<url>    أساس روابط الأصول (افتراضاً assets-v1) — للقياس المصنوع
  --allow-foreign           اسمح بملف موجود ببصمة مختلفة (لمطوّر يُبقي أداة أحدث عمداً).
                            لا يمرّرها أي مسار إصدار، ويُطبع تحذير صارخ.
  --help, -h                هذه الرسالة

بلا خيارات (كما في \`pnpm build\` و\`release.yml\`): ينزّل **الغائب** بتحقّق SHA-256،
ويتحقّق من **الموجود** — فملف ببصمة خاطئة يُسقط البناء بصوت عالٍ.`;

function parseArgs(argv) {
    const opts = { verify: false, allowForeign: false, help: false, assetUrlBase: ASSET_BASE };
    for (const raw of argv) {
        if (raw === '--verify') opts.verify = true;
        else if (raw === '--allow-foreign') opts.allowForeign = true;
        else if (raw === '--help' || raw === '-h') opts.help = true;
        else if (raw.startsWith('--asset-url-base=')) opts.assetUrlBase = raw.slice('--asset-url-base='.length).replace(/\/$/, '');
        else fail(`✗ وسيط غير معروف: ${raw}\n\n${USAGE}`);
    }
    if (!opts.assetUrlBase) fail(`✗ --asset-url-base يحتاج قيمة غير فارغة\n\n${USAGE}`);
    return opts;
}

function fail(msg) {
    console.error(msg);
    process.exit(1);
}

function get(targetUrl, redirectsLeft) {
    return new Promise((resolve, reject) => {
        if (redirectsLeft < 0) {
            reject(new Error('Too many redirects'));
            return;
        }
        https.get(targetUrl, { headers: { 'User-Agent': 'HaramLite-CI-fetch/0.2' } }, (response) => {
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400 && response.headers.location) {
                response.resume();
                get(response.headers.location, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            if (status !== 200) {
                response.resume();
                reject(new Error(`Unexpected status ${status}`));
                return;
            }
            resolve(response);
        }).on('error', reject);
    });
}

function downloadToFile(url, dest) {
    return get(url, 5).then((response) => new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest + '.download');
        file.on('error', (err) => reject(new Error(`Write failed: ${err.message}`)));
        response.pipe(file);
        file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
    }));
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * يقيس **ملفاً موجوداً**: البصمة عند الوجود لا عند التنزيل فقط (ن-٢).
 *
 * يُرجع true إن مضى الملف (مطابق، أو مخالف مع `--allow-foreign`)، ويسقط بـexit 1
 * إن خالف. والملف المخالف **لا يُحذف ولا يُستبدل** هنا: القرار للمستخدم، والحذف
 * الصامت لعمل قد يكون مقصوداً أسوأ من الفشل الصريح.
 */
async function verifyExisting(dest, comp, opts) {
    const size = fs.statSync(dest).size;
    const actual = await sha256File(dest);
    if (actual === comp.sha256) {
        console.log(`${comp.dest} already exists and matches its pinned SHA-256 (${size} bytes) — skipping download.`);
        return true;
    }
    if (opts.allowForeign) {
        console.warn(
            `⚠ ${comp.dest} موجود ببصمة مختلفة — مُرِّر بـ--allow-foreign (لمطوّر يُبقي أداة أحدث عمداً).\n` +
            `    المقروء:  ${actual}\n    المثبَّت: ${comp.sha256}`
        );
        return true;
    }
    fail(
        `✗ ${comp.dest} موجود لكن بصمته لا تطابق المثبَّتة — لا تُشحن بايتات أجنبية.\n` +
        `    الملف:    ${dest} (${size} bytes)\n` +
        `    المقروء:  ${actual}\n` +
        `    المثبَّت: ${comp.sha256}\n` +
        `    وrepair.rs في التطبيق يرفض هذه البايتات نفسها ⇒ الإصلاح الذاتي مكسور بصمت.\n` +
        `    للإصلاح: احذف الملف وأعد التشغيل، أو node scripts/fetch-resources.cjs --force --only=${comp.dest}\n` +
        `    (ولمطوّر يُبقي أداة أحدث عمداً: --allow-foreign — ولا يمرّرها أي مسار إصدار)`
    );
    return false; // unreachable: fail() يخرج
}

async function fetchComponent(comp, opts) {
    const dest = path.join(process.cwd(), comp.subdir, comp.dest);
    if (fs.existsSync(dest)) {
        await verifyExisting(dest, comp, opts);
        return;
    }
    if (opts.verify) {
        fail(`✗ ${comp.dest} مفقود — و--verify لا ينزّل شيئاً (والمطلوب قبل البناء: sha256 ${comp.sha256})`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const url = `${opts.assetUrlBase}/${comp.asset}`;
    console.log(`Downloading ${comp.asset} (~large, one-time on clean runners)...`);
    try {
        await downloadToFile(url, dest);
        const tmp = dest + '.download';
        const size = fs.statSync(tmp).size;
        if (size < MIN_COMPONENT_BYTES) {
            fs.unlinkSync(tmp);
            fail(`✗ ${comp.asset} too small (${size} bytes) — refusing it`);
        }
        const actual = await sha256File(tmp);
        if (actual !== comp.sha256) {
            fs.unlinkSync(tmp);
            fail(`✗ ${comp.asset} SHA-256 mismatch:\n  got      ${actual}\n  expected ${comp.sha256}`);
        }
        fs.renameSync(tmp, dest);
        console.log(`${comp.asset} verified (${size} bytes, sha256 ok) → ${comp.dest}`);
    } catch (err) {
        try { fs.unlinkSync(dest + '.download'); } catch { /* already gone */ }
        fail(`✗ Failed fetching ${comp.asset}: ${err.message}`);
    }
}

/**
 * `vc_redist.x64.exe`: لا بصمة مثبَّتة له (الرابط بلا إصدار — انظر الأرضية أعلاه)،
 * فالمقيس **عند الوجود** أرضية الحجم: ملف 0 بايت أو صفحة خطأ محفوظة كانت تمرّ
 * بصمت قبل هذا (ن-٢ في شقّه الثاني).
 */
async function checkRedist(opts) {
    if (fs.existsSync(redistDest)) {
        const size = fs.statSync(redistDest).size;
        if (size < MIN_SANE_BYTES) {
            fail(
                `✗ vc_redist.x64.exe موجود لكن حجمه ${size} bytes — أصغر من الأرضية ${MIN_SANE_BYTES}.\n` +
                `    الملف: ${redistDest} (صفحة خطأ أو تنزيل منقطع محفوظ؟) — ارفض شحنه.\n` +
                `    للإصلاح: احذف الملف وأعد التشغيل.`
            );
        }
        console.log(`vc_redist.x64.exe already exists (${size} bytes ≥ floor), skipping download.`);
        return;
    }
    if (opts.verify) {
        fail(`✗ vc_redist.x64.exe مفقود — و--verify لا ينزّل شيئاً (وهو مورد حزمة مطلوب)`);
    }
    console.log('Downloading vc_redist.x64.exe...');
    await new Promise((resolve) => downloadRedist(redistUrl, 3, resolve));
}

// Legacy callback downloader for vc_redist (behavior preserved).
function downloadRedist(targetUrl, redirectsLeft, onDone) {
    if (redirectsLeft < 0) fail('✗ Too many redirects fetching vc_redist.x64.exe');
    https.get(targetUrl, function(response) {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            downloadRedist(response.headers.location, redirectsLeft - 1, onDone);
            return;
        }
        if (status !== 200) {
            response.resume();
            fail(`✗ Unexpected status ${status} fetching vc_redist.x64.exe — refusing to bundle it`);
            return;
        }
        const file = fs.createWriteStream(redistDest);
        file.on('error', (err) => fail(`✗ Write failed for vc_redist.x64.exe: ${err.message}`));
        response.pipe(file);
        file.on('finish', () => {
            file.close(() => {
                let size = 0;
                try { size = fs.statSync(redistDest).size; } catch { /* handled below */ }
                if (size < MIN_SANE_BYTES) {
                    fail(`✗ vc_redist.x64.exe too small (${size} bytes) — refusing to bundle it`);
                    return;
                }
                console.log(`Download complete (${size} bytes).`);
                onDone();
            });
        });
    }).on('error', function(err) {
        fail(`✗ Error downloading vc_redist.x64.exe: ${err.message}`);
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(USAGE);
        return;
    }
    if (opts.verify) console.log('الوضع: تحقّق فقط (--verify) — لا تنزيل ولا كتابة.');
    await checkRedist(opts);
    for (const comp of COMPONENTS) {
        await fetchComponent(comp, opts);
    }
    if (opts.verify) {
        console.log(`✓ --verify: ${COMPONENTS.length} مكوّناً + vc_redist.x64.exe موجودة وبصماتها مطابقة.`);
    }
}

main().catch((err) => fail(`✗ ${String(err && err.message ? err.message : err)}`));
