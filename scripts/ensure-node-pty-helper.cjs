const { chmodSync, existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

// node-pty uses spawn-helper only on macOS. Linux uses forkpty directly and
// Windows uses its ConPTY/winpty binaries.
if (process.platform !== 'darwin') process.exit(0);

const packageRoot = dirname(require.resolve('node-pty/package.json'));
const candidates = [
  join(packageRoot, 'build', 'Release', 'spawn-helper'),
  join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
];
const helperPath = candidates.find((candidate) => existsSync(candidate));

if (helperPath === undefined) {
  throw new Error(`node-pty spawn-helper is missing for ${process.platform}-${process.arch}`);
}

chmodSync(helperPath, 0o755);
