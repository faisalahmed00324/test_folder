// Production/static server. Test-only scripts are deliberately not in the allowlist.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ASSETS = [
  'Carrom/carrom.html',
  'Carrom/carrom.css',
  'Carrom/carrom-rules.js',
  'Carrom/carrom-physics.js',
  'Carrom/carrom.js',
  '29_Card/index.html',
  '29_Card/app.js',
  '29_Card/app.css',
];
const ASSET_SOURCES = { '29_Card/app.js': '.build/29-ui/app.js', '29_Card/app.css': '.build/29-ui/app.css' };

function createHandler(root = __dirname) {
  return (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = pathname === '/' ? 'Carrom/carrom.html' : pathname.slice(1);
    if (!ASSETS.includes(file)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    fs.readFile(path.join(root, root === __dirname ? ASSET_SOURCES[file] || file : file), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' }[path.extname(file)];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  };
}

module.exports = { ASSETS, ASSET_SOURCES, createHandler };

if (require.main === module) {
  const production = process.argv.includes('--production');
  const root = production ? require('./scripts/build.cjs').build() : __dirname;
  const portArg = process.argv.find(arg => arg.startsWith('--port='));
  const port = Number(portArg ? portArg.split('=')[1] : process.env.PORT || 8765);
  http.createServer(createHandler(root)).listen(port, '127.0.0.1', () => {
    console.log(`Carrom: http://127.0.0.1:${port}/Carrom/carrom.html`);
  });
}
