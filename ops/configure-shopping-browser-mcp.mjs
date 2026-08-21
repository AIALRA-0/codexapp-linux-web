#!/usr/bin/env node

import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const codexHome = requiredAbsoluteArgument('--codex-home');
const pluginRoot = requiredAbsoluteArgument('--plugin-root');
const userRoot = dirname(codexHome);
const profileDirectory = join(
  userRoot,
  'home',
  '.local',
  'share',
  'aialra-shopping-browser',
  'profile',
);
const outputDirectory = join(userRoot, 'home', '.cache', 'aialra-shopping-browser', 'mcp');
const browserName = process.env.AIALRA_SHOPPING_BROWSER_BROWSER ?? 'chrome';
const browserExecutable =
  process.env.AIALRA_SHOPPING_BROWSER_EXECUTABLE ?? '/usr/bin/google-chrome-stable';
const configPath = join(codexHome, 'config.toml');
const launcherPath = join(pluginRoot, 'scripts', 'launch-playwright-mcp.mjs');
const backupPath = join(codexHome, 'config.toml.before-shopping-browser-mcp');
const temporaryPath = join(codexHome, `.config.toml.shopping-browser.${String(process.pid)}.tmp`);

assertRegularFile(configPath, 'Codex config');
assertRegularFile(launcherPath, 'shopping-browser launcher');
assertInside(codexHome, pluginRoot, 'plugin root');

const original = readFileSync(configPath, 'utf8');
const originalMetadata = statSync(configPath);
const withoutManagedSection = removeTomlTable(original, '[mcp_servers.aialra-shopping-browser]');
const section = [
  '# Managed by ops/configure-shopping-browser-mcp.mjs.',
  '[mcp_servers.aialra-shopping-browser]',
  'command = "node"',
  'args = ["./scripts/launch-playwright-mcp.mjs"]',
  `cwd = ${JSON.stringify(`${pluginRoot}/.`)}`,
  'startup_timeout_sec = 60',
  'tool_timeout_sec = 120',
  `env = { AIALRA_SHOPPING_BROWSER_PROFILE_DIR = ${JSON.stringify(profileDirectory)}, AIALRA_SHOPPING_BROWSER_OUTPUT_DIR = ${JSON.stringify(outputDirectory)}, AIALRA_SHOPPING_BROWSER_BROWSER = ${JSON.stringify(browserName)}, AIALRA_SHOPPING_BROWSER_EXECUTABLE = ${JSON.stringify(browserExecutable)}, AIALRA_SHOPPING_BROWSER_KEEP_BROWSER_ALIVE = "true" }`,
  'env_vars = ["DISPLAY", "HTTPS_PROXY", "NO_PROXY"]',
].join('\n');
const next = `${withoutManagedSection.trimEnd()}\n\n${section}\n`;

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
    startupTimeoutSeconds: 60,
    toolTimeoutSeconds: 120,
    forwardedEnvironmentNames: 3,
    isolatedProfileDirectory: profileDirectory,
    isolatedOutputDirectory: outputDirectory,
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
      while (output.at(-1)?.trim() === '# Managed by ops/configure-shopping-browser-mcp.mjs.') {
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

function assertInside(parent, child, label) {
  const parentReal = realpathSync(parent);
  const childReal = realpathSync(child);
  const childRelative = relative(parentReal, childReal);
  if (childRelative === '' || childRelative.startsWith('..') || isAbsolute(childRelative)) {
    throw new Error(`${label} must be inside the Codex home`);
  }
  if (dirname(childReal) === childReal) throw new Error(`${label} is invalid`);
}
