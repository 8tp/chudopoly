const { execFileSync } = require('child_process');
const { readdirSync } = require('fs');
const { join } = require('path');

const roots = ['.', 'server', 'public/js', 'scripts', 'test'];
for (const root of roots) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const file = join(root, entry.name);
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
console.log('Syntax check passed.');
