import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const root = resolve(requiredArgument(process.argv.slice(2), '--root'));
const ignoredNames = new Set(repeatedArguments(process.argv.slice(2), '--ignore'));
const treeHash = createHash('sha256');
let bytes = 0;
let directories = 0;
let files = 0;
let symlinks = 0;

await visit(root);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    root,
    ignoredNames: [...ignoredNames].sort(),
    directories,
    files,
    symlinks,
    bytes,
    sha256: treeHash.digest('hex'),
  })}\n`,
);

async function visit(path) {
  const relativePath = relative(root, path).split('\\').join('/');
  if (relativePath.length > 0 && ignoredNames.has(basename(path))) return;
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    directories += 1;
    updateRecord('directory', relativePath, '');
    const entries = await readdir(path);
    entries.sort((left, right) => left.localeCompare(right, 'en'));
    for (const entry of entries) await visit(join(path, entry));
    return;
  }
  if (metadata.isSymbolicLink()) {
    symlinks += 1;
    updateRecord('symlink', relativePath, await readlink(path));
    return;
  }
  if (!metadata.isFile()) throw new Error(`unsupported filesystem entry: ${path}`);
  const content = await readFile(path);
  const contentHash = createHash('sha256').update(content).digest('hex');
  files += 1;
  bytes += metadata.size;
  updateRecord('file', relativePath, `${metadata.size}:${contentHash}`);
}

function updateRecord(type, path, value) {
  treeHash.update(type);
  treeHash.update('\0');
  treeHash.update(path);
  treeHash.update('\0');
  treeHash.update(value);
  treeHash.update('\0');
}

function repeatedArguments(values, name) {
  const results = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== name) continue;
    const value = values[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    results.push(value);
    index += 1;
  }
  return results;
}

function requiredArgument(values, name) {
  const index = values.indexOf(name);
  const value = values[index + 1];
  if (index < 0 || typeof value !== 'string' || value.startsWith('--')) {
    throw new Error(`${name} is required`);
  }
  return value;
}
