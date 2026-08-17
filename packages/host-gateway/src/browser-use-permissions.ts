import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

export type BrowserPermissionResource = 'origin' | 'download' | 'upload' | 'fullCdp';
export type BrowserPermissionKind = 'allowed' | 'denied';
export type BrowserApprovalMode = 'alwaysAsk' | 'neverAsk';
export type BrowserFileTransferKind = 'download' | 'upload';

export interface BrowserPermissionRule {
  action: 'add' | 'remove';
  kind: BrowserPermissionKind;
  origin: string;
  resource: BrowserPermissionResource;
}

export interface BrowserPermissionSnapshot {
  fullCdpAccessEnabled: boolean;
  approvalMode: BrowserApprovalMode;
  historyApprovalMode: BrowserApprovalMode;
  downloadApprovalMode: BrowserApprovalMode;
  uploadApprovalMode: BrowserApprovalMode;
  allowedOrigins: string[];
  deniedOrigins: string[];
  allowedDownloadOrigins: string[];
  deniedDownloadOrigins: string[];
  allowedUploadOrigins: string[];
  deniedUploadOrigins: string[];
  allowedFullCdpOrigins: string[];
  deniedFullCdpOrigins: string[];
}

export async function readBrowserPermissionSnapshot(
  codexHome: string,
): Promise<BrowserPermissionSnapshot> {
  return browserPermissionSnapshot(await readBrowserPermissionConfig(codexHome));
}

export async function updateBrowserPermissionRules(
  codexHome: string,
  value: unknown,
): Promise<BrowserPermissionSnapshot> {
  const rules = parseBrowserPermissionRules(value);
  const config = await readBrowserPermissionConfig(codexHome);
  const normalized = rules.map((rule) => ({
    ...rule,
    origin:
      rule.action === 'add'
        ? normalizeBrowserPermissionOrigin(config, rule.resource, rule.origin)
        : rule.origin,
  }));
  let changed = false;
  for (const rule of normalized) changed = applyBrowserPermissionRule(config, rule) || changed;
  if (changed) await writeBrowserPermissionConfig(codexHome, config);
  return browserPermissionSnapshot(config);
}

export async function writeBrowserApprovalMode(
  codexHome: string,
  mode: unknown,
): Promise<BrowserPermissionSnapshot> {
  const config = await readBrowserPermissionConfig(codexHome);
  config.approval_mode = approvalModeToConfig(mode);
  await writeBrowserPermissionConfig(codexHome, config);
  return browserPermissionSnapshot(config);
}

export async function writeBrowserHistoryApprovalMode(
  codexHome: string,
  mode: unknown,
): Promise<BrowserPermissionSnapshot> {
  const config = await readBrowserPermissionConfig(codexHome);
  config.history_approval_mode = approvalModeToConfig(mode);
  await writeBrowserPermissionConfig(codexHome, config);
  return browserPermissionSnapshot(config);
}

export async function writeBrowserFileTransferApprovalMode(
  codexHome: string,
  kind: unknown,
  mode: unknown,
): Promise<BrowserPermissionSnapshot> {
  if (kind !== 'download' && kind !== 'upload') {
    throw new TypeError('Browser Use file transfer kind is invalid');
  }
  const config = await readBrowserPermissionConfig(codexHome);
  config[kind === 'download' ? 'download_approval_mode' : 'upload_approval_mode'] =
    approvalModeToConfig(mode);
  await writeBrowserPermissionConfig(codexHome, config);
  return browserPermissionSnapshot(config);
}

export async function writeBrowserFullCdpAccessEnabled(
  codexHome: string,
  enabled: unknown,
): Promise<BrowserPermissionSnapshot> {
  if (typeof enabled !== 'boolean') {
    throw new TypeError('Browser Use full CDP state is invalid');
  }
  const config = await readBrowserPermissionConfig(codexHome);
  config.full_cdp_access_enabled = enabled;
  await writeBrowserPermissionConfig(codexHome, config);
  return browserPermissionSnapshot(config);
}

function parseBrowserPermissionRules(value: unknown): BrowserPermissionRule[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new TypeError('Browser Use origin rules are invalid');
  }
  return value.map((entry) => {
    const rule = plainRecord(entry, 'Browser Use origin rule');
    if (rule.action !== 'add' && rule.action !== 'remove') {
      throw new TypeError('Browser Use origin rule action is invalid');
    }
    if (rule.kind !== 'allowed' && rule.kind !== 'denied') {
      throw new TypeError('Browser Use origin rule kind is invalid');
    }
    if (
      rule.resource !== 'origin' &&
      rule.resource !== 'download' &&
      rule.resource !== 'upload' &&
      rule.resource !== 'fullCdp'
    ) {
      throw new TypeError('Browser Use origin rule resource is invalid');
    }
    return {
      action: rule.action,
      kind: rule.kind,
      origin: nonEmptyString(rule.origin, 'Browser Use origin'),
      resource: rule.resource,
    };
  });
}

async function readBrowserPermissionConfig(codexHome: string): Promise<Record<string, unknown>> {
  try {
    const value = parseToml(await readFile(browserPermissionConfigPath(codexHome), 'utf8'));
    return isPlainRecord(value) ? value : {};
  } catch {
    return {};
  }
}

async function writeBrowserPermissionConfig(
  codexHome: string,
  config: Record<string, unknown>,
): Promise<void> {
  const path = browserPermissionConfigPath(codexHome);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const serialized = stringifyToml(config);
  await writeFile(path, serialized.endsWith('\n') ? serialized : `${serialized}\n`, 'utf8');
}

function browserPermissionConfigPath(codexHome: string): string {
  return join(codexHome, 'browser', 'config.toml');
}

function browserPermissionSectionName(resource: BrowserPermissionResource): string {
  switch (resource) {
    case 'origin':
      return 'origins';
    case 'download':
      return 'downloads';
    case 'upload':
      return 'uploads';
    case 'fullCdp':
      return 'full_cdp';
  }
}

function browserPermissionSection(
  config: Record<string, unknown>,
  resource: BrowserPermissionResource,
): Record<string, unknown> {
  const key = browserPermissionSectionName(resource);
  const current = config[key];
  if (isPlainRecord(current)) return current;
  const created: Record<string, unknown> = {};
  config[key] = created;
  return created;
}

function browserPermissionOrigins(
  section: Record<string, unknown> | undefined,
  kind: BrowserPermissionKind,
): string[] {
  const value = section?.[kind];
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  const origins: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || unique.has(trimmed)) continue;
    unique.add(trimmed);
    origins.push(trimmed);
  }
  return origins;
}

function normalizeBrowserPermissionOrigin(
  config: Record<string, unknown>,
  resource: BrowserPermissionResource,
  value: string,
): string {
  const section = config[browserPermissionSectionName(resource)];
  if (
    isPlainRecord(section) &&
    (browserPermissionOrigins(section, 'allowed').includes(value) ||
      browserPermissionOrigins(section, 'denied').includes(value))
  ) {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error('Invalid Browser Use origin');
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Invalid Browser Use origin protocol');
    }
    return url.origin;
  } catch (error) {
    throw new Error('Invalid Browser Use origin', { cause: error });
  }
}

function oppositeBrowserPermissionKind(kind: BrowserPermissionKind): BrowserPermissionKind {
  return kind === 'allowed' ? 'denied' : 'allowed';
}

function applyBrowserPermissionRule(
  config: Record<string, unknown>,
  rule: BrowserPermissionRule,
): boolean {
  const key = browserPermissionSectionName(rule.resource);
  if (rule.action === 'add') {
    const section = browserPermissionSection(config, rule.resource);
    const selected = browserPermissionOrigins(section, rule.kind);
    const oppositeKind = oppositeBrowserPermissionKind(rule.kind);
    const opposite = browserPermissionOrigins(section, oppositeKind);
    section[rule.kind] = selected.includes(rule.origin) ? selected : [...selected, rule.origin];
    section[oppositeKind] = opposite.filter((origin) => origin !== rule.origin);
    return !selected.includes(rule.origin) || opposite.includes(rule.origin);
  }
  const section = config[key];
  if (!isPlainRecord(section)) return false;
  const selected = browserPermissionOrigins(section, rule.kind);
  if (!selected.includes(rule.origin)) return false;
  section[rule.kind] = selected.filter((origin) => origin !== rule.origin);
  return true;
}

function browserPermissionSnapshot(config: Record<string, unknown>): BrowserPermissionSnapshot {
  const origins = isPlainRecord(config.origins) ? config.origins : undefined;
  const downloads = isPlainRecord(config.downloads) ? config.downloads : undefined;
  const uploads = isPlainRecord(config.uploads) ? config.uploads : undefined;
  const fullCdp = isPlainRecord(config.full_cdp) ? config.full_cdp : undefined;
  return {
    fullCdpAccessEnabled: config.full_cdp_access_enabled === true,
    approvalMode: approvalModeFromConfig(config.approval_mode),
    historyApprovalMode: approvalModeFromConfig(config.history_approval_mode),
    downloadApprovalMode: approvalModeFromConfig(config.download_approval_mode),
    uploadApprovalMode: approvalModeFromConfig(config.upload_approval_mode),
    allowedOrigins: browserPermissionOrigins(origins, 'allowed'),
    deniedOrigins: browserPermissionOrigins(origins, 'denied'),
    allowedDownloadOrigins: browserPermissionOrigins(downloads, 'allowed'),
    deniedDownloadOrigins: browserPermissionOrigins(downloads, 'denied'),
    allowedUploadOrigins: browserPermissionOrigins(uploads, 'allowed'),
    deniedUploadOrigins: browserPermissionOrigins(uploads, 'denied'),
    allowedFullCdpOrigins: browserPermissionOrigins(fullCdp, 'allowed'),
    deniedFullCdpOrigins: browserPermissionOrigins(fullCdp, 'denied'),
  };
}

function approvalModeFromConfig(value: unknown): BrowserApprovalMode {
  return value === 'never_ask' ? 'neverAsk' : 'alwaysAsk';
}

function approvalModeToConfig(value: unknown): 'always_ask' | 'never_ask' {
  if (value !== 'alwaysAsk' && value !== 'neverAsk') {
    throw new TypeError('Browser Use approval mode is invalid');
  }
  return value === 'neverAsk' ? 'never_ask' : 'always_ask';
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
