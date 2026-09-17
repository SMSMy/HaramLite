#!/usr/bin/env node
/* خادم ثابت محلي لمعاينة موقع docs/ — للتحقق البصري فقط، لا ينشر شيئاً.
   السبب: خادم python http.server كان يقطع الاتصال تحت keep-alive في Chrome.

   ── تحصين هذه الجولة (عيبان مُقاسان، أُعيد إنتاجهما حيّاً قبل الإصلاح) ──────
   ① `GET /%` كان يُسقط **العملية كلها**: `decodeURIComponent` يرمي `URIError`
      داخل معالج الطلب بلا التقاط ⇒ موت العملية وسقوط المنفذ، وردّه للعميل
      انقطاعٌ (`ECONNRESET`) لا رمز حالة. الآن: 400 مسمّى، والخادم يبقى حيّاً.
   ② **التجواز**: كان الفحص `file.startsWith(root)` بعد `path.join` — و`path.join`
      **يُطبّع** `..`، ثم `startsWith` مطابقة سابقة نصّية لا حدّ مسار؛ فمجلد شقيق
      اسمه يبدأ بـ`docs` كان يُقرأ بـHTTP 200 (مُثبَت: `/../docs-qa-probe/marker.txt`
      أعاد `OUTSIDE-DOCS-SECRET`). الآن: تطبيع صريح ثم **حدّ مسار** (`root + sep`)
      أو المسار نفسه، وإلا 403.
   ولا يُسمح لأي طلب — بأي ترميز أو طريقة — أن يُسقط العملية: المعالج كله داخل
   `try/catch`، ويُضاف `clientError` لطلب مشوّه على مستوى المقبس.

   الاستعمال: node scripts/serve-site.cjs [منفذ] [--root <dir>] */
const http = require('http');
const fs = require('fs');
const path = require('path');

/* ── الوسائط: منفذ + جذر بديل (الافتراضي docs/ في المستودع) ────────────────── */
const argv = process.argv.slice(2);
let portArg = null, rootArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      console.error('✗ العلم --root يحتاج مساراً — مثال: --root /tmp/site');
      process.exit(2);
    }
    rootArg = argv[++i];
  } else if (/^\d+$/.test(argv[i]) && portArg === null) {
    portArg = argv[i];
  } else {
    console.error('✗ وسيط غير معروف: ' + argv[i] + ' — الاستعمال: [منفذ] [--root <dir>]');
    process.exit(2);
  }
}
const root = rootArg ? path.resolve(rootArg) : path.join(__dirname, '..', 'docs');
const port = Number(portArg || 8899);

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('✗ خادم المعاينة: بنية غير صالحة — مجلد الجذر غير موجود عند ' + root);
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wav': 'audio/wav'
};

function reply(res, code, body, type) {
  if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
  res.writeHead(code, { 'content-type': type || TYPES['.txt'], 'cache-control': 'no-store' });
  res.end(body);
}

/** يحلّ مسار الطلب إلى ملف حقيقي **داخل** الجذر، أو يرمي سبباً مسمّى. */
function resolveInsideRoot(rawUrl) {
  const raw = String(rawUrl || '/');
  const q = raw.indexOf('?');
  const rawPath = q < 0 ? raw : raw.slice(0, q);
  let rel;
  try {
    rel = decodeURIComponent(rawPath);           // ① كان يرمي URIError ويقتل العملية
  } catch {
    const e = new Error('ترميز الرابط غير صالح'); e.code = 'BAD_ENCODING'; throw e;
  }
  if (rel.includes('\0')) { const e = new Error('مسار فيه بايت صفر'); e.code = 'BAD_PATH'; throw e; }
  if (rel.endsWith('/')) rel += 'index.html';
  // تطبيع صريح بفواصل أمامية، ثم حدّ مسار — لا مطابقة سابقة نصّية (② التجواز).
  const norm = path.posix.normalize('/' + rel.replace(/\\/g, '/'));
  const file = path.resolve(root, '.' + norm);
  if (file !== root && !file.startsWith(root + path.sep)) {
    const e = new Error('مسار خارج الجذر'); e.code = 'OUTSIDE_ROOT'; throw e;
  }
  return file;
}

const server = http.createServer((req, res) => {
  // لا استثناء من أي نوع يُسقط العملية: كل شيء داخل هذا الالتقاط.
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply(res, 405, 'method not allowed');
      return;
    }
    let file;
    try {
      file = resolveInsideRoot(req.url);
    } catch (e) {
      if (e.code === 'BAD_ENCODING' || e.code === 'BAD_PATH') { reply(res, 400, 'bad request — ' + e.message); return; }
      if (e.code === 'OUTSIDE_ROOT') { reply(res, 403, 'forbidden'); return; }
      throw e;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        const nf = path.join(root, '404.html');
        fs.readFile(nf, (e2, b2) => {
          if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
          res.writeHead(404, { 'content-type': TYPES['.html'] });
          res.end(req.method === 'HEAD' ? undefined : (e2 ? 'not found' : b2));
        });
        return;
      }
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': buf.length,
        'cache-control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  } catch (e) {
    // خط الدفاع الأخير: خطأ غير متوقّع يُردّ 500 ولا يقتل الخادم.
    try { reply(res, 500, 'internal error'); } catch { /* gone */ }
    console.error('طلب فاشل: ' + (e && e.message));
  }
});
// طلب مشوّه على مستوى المقبس (بروتوكول غير صالح) يُغلق المقبس ولا يُسقط الخادم.
server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* gone */ }
});
server.keepAliveTimeout = 30000;
server.headersTimeout = 35000;
server.listen(port, '127.0.0.1', () => {
  // المنفذ الفعلي لا المطلوب: يسمح بالمنفذ 0 (منفذ حرّ يختاره النظام) فتُشغّل
  // بوّابة `guards:selfcheck` خادماً بلا تصادم مع أي شيء يعمل على الجهاز.
  console.log('serving ' + root + ' on http://127.0.0.1:' + server.address().port);
});
