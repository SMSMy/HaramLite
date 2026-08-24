import fs from 'fs';
import https from 'https';
import path from 'path';

const url = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const dest = path.join(process.cwd(), 'src-tauri', 'vc_redist.x64.exe');

if (!fs.existsSync(dest)) {
    console.log('Downloading vc_redist.x64.exe...');
    const file = fs.createWriteStream(dest);
    https.get(url, function(response) {
        // Handle redirect
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            https.get(response.headers.location, function(redirectResponse) {
                redirectResponse.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log('Download complete.');
                });
            });
        } else {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                console.log('Download complete.');
            });
        }
    }).on('error', function(err) {
        fs.unlink(dest, () => {});
        console.error('Error downloading vc_redist.x64.exe:', err.message);
        process.exit(1);
    });
} else {
    console.log('vc_redist.x64.exe already exists, skipping download.');
}
