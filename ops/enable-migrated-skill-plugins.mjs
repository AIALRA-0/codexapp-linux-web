#!/usr/bin/env node

import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const pluginNames = [
  'github@openai-curated-remote',
  'gmail@openai-curated-remote',
  'google-drive@openai-curated-remote',
  'outlook-email@openai-curated-remote',
];
const codexHome = requiredAbsoluteArgument('--codex-home');
const configPath = join(codexHome, 'config.toml');
const backupPath = join(codexHome, 'config.toml.before-migrated-skill-plugins');
const temporaryPath = join(
  codexHome,
  `.config.toml.migrated-skill-plugins.${String(process.pid)}.tmp`,
);

assertRegularFile(configPath, 'Codex config');

const original = readFileSync(configPath, 'utf8');
const originalMetadata = statSync(configPath);
let next = original;
for (const pluginName of pluginNames) {
  next = removeTomlTable(next, `[plugins.${JSON.stringify(pluginName)}]`);
}
const sections = pluginNames.map((pluginName) =>
  [
    '# Managed by ops/enable-migrated-skill-plugins.mjs.',
    `[plugins.${JSON.stringify(pluginName)}]`,
    'enabled = true',
  ].join('\n'),
);
next = `${next.trimEnd()}\n\n${sections.join('\n\n')}\n`;

if (next !== original) {
  if (!existsSync(backupPath)) {
    copyFileSync(configPath, backupPath);
    chmodSync(backupPath, 0o600);
    chownSync(backupPath, originalMetadata.uid, originalMetadata.gid);
  }
  writeFileSync(temporaryPath, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(temporaryPath, 0o600);
  chownSync(temporaryPath, originalMetadata.uid, originalMetadata.gid);
  renameSync(temporaryPath, configPath);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    changed: next !== original,
    enabledPlugins: pluginNames,
  })}\n`,
);

function removeTomlTable(source, header) {
  const lines = source.split(/\r?\n/u);
  const output = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header) {
      skipping = true;
      while (output.at(-1)?.trim() === '# Managed by ops/enable-migrated-skill-plugins.mjs.') {
        output.pop();
      }
      continue;
    }
    if (skipping && /^\[[^\]]+\]$/u.test(trimmed)) skipping = false;
    if (!skipping) output.push(line);
  }
  return output.join('\n');
}

function requiredAbsoluteArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

function assertRegularFile(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symbolic file`);
  }
}
