#!/usr/bin/env node
/* خادم ثابت محلي لمعاينة موقع docs/ — للتحقق البصري فقط، لا ينشر شيئاً.
   السبب: خادم python http.server كان يقطع الاتصال تحت keep-alive في Chrome.
   الاستعمال: node scripts/serve-site.cjs [منفذ] */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'docs');
const port = Number(process.argv[2] || 8899);

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

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      const nf = path.join(root, '404.html');
      fs.readFile(nf, (e2, b2) => {
        res.writeHead(404, { 'content-type': TYPES['.html'] });
        res.end(e2 ? 'not found' : b2);
      });
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-store'
    });
    res.end(buf);
  });
});
server.keepAliveTimeout = 30000;
server.headersTimeout = 35000;
server.listen(port, '127.0.0.1', () => console.log('serving ' + root + ' on http://127.0.0.1:' + port));
