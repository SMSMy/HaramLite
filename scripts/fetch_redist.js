import fs from 'fs';
import https from 'https';
import path from 'path';

const url = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const dest = path.join(process.cwd(), 'src-tauri', 'vc_redist.x64.exe');
// Audit 2026-09-03: sanity floor for the real installer (an error page is
// kilobytes). A pinned SHA-256 would be stronger; the URL is versionless so
// a floor + status check is the stable option.
const MIN_SANE_BYTES = 5 * 1024 * 1024;

function fail(msg) {
    try { fs.unlinkSync(dest); } catch { /* already gone */ }
    console.error(msg);
    process.exit(1);
}

function download(targetUrl, redirectsLeft, onDone) {
    if (redirectsLeft < 0) fail('Too many redirects fetching vc_redist.x64.exe');
    https.get(targetUrl, function(response) {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            download(response.headers.location, redirectsLeft - 1, onDone);
            return;
        }
        if (status !== 200) {
            response.resume();
            fail(`Unexpected status ${status} fetching vc_redist.x64.exe — refusing to bundle it`);
            return;
        }
        const file = fs.createWriteStream(dest);
        file.on('error', (err) => fail(`Write failed for vc_redist.x64.exe: ${err.message}`));
        response.pipe(file);
        file.on('finish', () => {
            file.close(() => {
                let size = 0;
                try { size = fs.statSync(dest).size; } catch { /* handled below */ }
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

if (!fs.existsSync(dest)) {
    console.log('Downloading vc_redist.x64.exe...');
    download(url, 3, () => {});
} else {
    console.log('vc_redist.x64.exe already exists, skipping download.');
}
