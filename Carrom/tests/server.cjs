// Only Playwright starts this server. Production never imports anything from tests/.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHandler } = require('../../server.js');
const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'Carrom/carrom.js'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, 'support/browser-driver.js'), 'utf8');
if (!source.includes('// E2E_INJECTION_POINT')) throw new Error('Missing test injection point');
const instrumented = source.replace('// E2E_INJECTION_POINT', bridge);
const serveStatic = createHandler(root);
http.createServer((req, res) => {
  if (new URL(req.url, 'http://localhost').pathname === '/Carrom/carrom.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(instrumented);
  } else serveStatic(req, res);
}).listen(8877, '127.0.0.1', () => console.log('Playwright-only Carrom server on :8877'));
