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

const codexHome = requiredAbsoluteArgument('--codex-home');
const projectRoot = requiredAbsoluteArgument('--project-root');
const privateRoot = requiredAbsoluteArgument('--private-root');
const configPath = join(codexHome, 'config.toml');
const googleLauncher = join(projectRoot, 'scripts', 'start-google-mcp.mjs');
const backupPath = join(codexHome, 'config.toml.before-migrated-local-mcp');
const temporaryPath = join(codexHome, `.config.toml.migrated-local-mcp.${String(process.pid)}.tmp`);

assertRegularFile(configPath, 'Codex config');
assertRegularFile(googleLauncher, 'Google MCP launcher');
assertDirectory(privateRoot, 'private MCP root');

const original = readFileSync(configPath, 'utf8');
const originalMetadata = statSync(configPath);
let next = removeTomlTable(original, '[mcp_servers.aialra_google_email]');
next = removeTomlTable(next, '[mcp_servers.aialra_microsoft_email]');

const googleConfigRoot = join(privateRoot, 'google', 'config');
const googleDataRoot = join(privateRoot, 'google', 'data');
const googleSection = [
  '# Managed by ops/configure-migrated-local-mcp.mjs.',
  '[mcp_servers.aialra_google_email]',
  'command = "/usr/bin/node"',
  `args = [${JSON.stringify(googleLauncher)}]`,
  `cwd = ${JSON.stringify(projectRoot)}`,
  'startup_timeout_sec = 120',
  'tool_timeout_sec = 120',
  'default_tools_approval_mode = "writes"',
  `env = { XDG_CONFIG_HOME = ${JSON.stringify(googleConfigRoot)}, XDG_DATA_HOME = ${JSON.stringify(googleDataRoot)} }`,
  'env_vars = ["HTTPS_PROXY", "NO_PROXY"]',
].join('\n');
next = `${next.trimEnd()}\n\n${googleSection}\n`;

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
    configuredServers: ['aialra_google_email'],
    removedServers: ['aialra_microsoft_email'],
    removalReason: 'source Microsoft 365 account is retired',
    googleStorageIsPrivate: true,
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
      while (output.at(-1)?.trim() === '# Managed by ops/configure-migrated-local-mcp.mjs.') {
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

function assertDirectory(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symbolic directory`);
  }
}
