const fs = require('node:fs');
const path = require('node:path');

function build() {
  const root = path.join(__dirname, '..');
  const output = path.join(root, 'dist');
  const { ASSETS } = require('../server.js');
  fs.mkdirSync(output, { recursive: true });
  for (const file of ASSETS) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const destination = path.join(output, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, source.replace('  // E2E_INJECTION_POINT\n', ''));
  }
  return output;
}

module.exports = { build };
if (require.main === module) console.log(`Production assets: ${build()}`);
