const { buildSync } = require('esbuild');
const path = require('node:path');

function buildUI() {
  buildSync({ entryPoints: [path.join(__dirname, 'src/client/main.tsx')], bundle: true, minify: true,
    sourcemap: false, outfile: path.join(__dirname, '../.build/29-ui/app.js'), platform: 'browser',
    target: ['es2022'], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
}
module.exports = { buildUI };
if (require.main === module) buildUI();
