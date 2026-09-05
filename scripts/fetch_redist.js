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
// (same assets-v1 release, same SHA-256) — the in-app repair wizard and CI
// then resolve the exact same bytes. Existing files are NEVER touched
// (dev machines may carry newer self-updated tools); only missing files
// are downloaded and hash-verified before use.
const ASSET_BASE = 'https://github.com/SMSMy/HaramLite/releases/download/assets-v1';
const COMPONENTS = [
    { asset: 'ffmpeg.exe', subdir: 'bin', sha256: '09948d4cdd0650da6ff5a87577469f2a218dc2615ae379f8f734d24c49de0f73' },
    { asset: 'ffprobe.exe', subdir: 'bin', sha256: 'a6618e99bb58869ded3c6f37b53aa1a8d701c3591dbb7b5b317d47369c112be2' },
    { asset: 'yt-dlp.exe', subdir: 'bin', sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a' },
    { asset: 'UVR-MDX-NET-Voc_FT.onnx', subdir: 'models', sha256: '534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111' },
];
const MIN_COMPONENT_BYTES = 1 * 1024 * 1024;

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

async function fetchComponent(comp) {
    const dest = path.join(process.cwd(), comp.subdir, comp.asset);
    if (fs.existsSync(dest)) {
        console.log(`${comp.asset} already exists, skipping download.`);
        return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const url = `${ASSET_BASE}/${comp.asset}`;
    console.log(`Downloading ${comp.asset} (~large, one-time on clean runners)...`);
    try {
        await downloadToFile(url, dest);
        const tmp = dest + '.download';
        const size = fs.statSync(tmp).size;
        if (size < MIN_COMPONENT_BYTES) {
            fs.unlinkSync(tmp);
            fail(`${comp.asset} too small (${size} bytes) — refusing it`);
        }
        const actual = await sha256File(tmp);
        if (actual !== comp.sha256) {
            fs.unlinkSync(tmp);
            fail(`${comp.asset} SHA-256 mismatch:\n  got      ${actual}\n  expected ${comp.sha256}`);
        }
        fs.renameSync(tmp, dest);
        console.log(`${comp.asset} verified (${size} bytes, sha256 ok).`);
    } catch (err) {
        try { fs.unlinkSync(dest + '.download'); } catch { /* already gone */ }
        fail(`Failed fetching ${comp.asset}: ${err.message}`);
    }
}

// Legacy callback downloader for vc_redist (behavior preserved).
function downloadRedist(targetUrl, redirectsLeft, onDone) {
    if (redirectsLeft < 0) fail('Too many redirects fetching vc_redist.x64.exe');
    https.get(targetUrl, function(response) {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            downloadRedist(response.headers.location, redirectsLeft - 1, onDone);
            return;
        }
        if (status !== 200) {
            response.resume();
            fail(`Unexpected status ${status} fetching vc_redist.x64.exe — refusing to bundle it`);
            return;
        }
        const file = fs.createWriteStream(redistDest);
        file.on('error', (err) => fail(`Write failed for vc_redist.x64.exe: ${err.message}`));
        response.pipe(file);
        file.on('finish', () => {
            file.close(() => {
                let size = 0;
                try { size = fs.statSync(redistDest).size; } catch { /* handled below */ }
                if (size < MIN_SANE_BYTES) {
                    fail(`vc_redist.x64.exe too small (${size} bytes) — refusing to bundle it`);
                    return;
                }
                console.log(`Download complete (${size} bytes).`);
                onDone();
            });
        });
    }).on('error', function(err) {
        fail(`Error downloading vc_redist.x64.exe: ${err.message}`);
    });
}

async function main() {
    if (!fs.existsSync(redistDest)) {
        console.log('Downloading vc_redist.x64.exe...');
        await new Promise((resolve) => downloadRedist(redistUrl, 3, resolve));
    } else {
        console.log('vc_redist.x64.exe already exists, skipping download.');
    }
    for (const comp of COMPONENTS) {
        await fetchComponent(comp);
    }
}

main().catch((err) => fail(String(err && err.message ? err.message : err)));
