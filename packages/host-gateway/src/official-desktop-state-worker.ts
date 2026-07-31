import { createRequire } from 'node:module';
import { constants, type Dirent } from 'node:fs';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

import { resolveOfficialSharedModulePath } from './official-shared-module.js';

interface WorkerRequest {
  type: 'request';
  id: number;
  operation: string;
  params?: unknown;
}

interface OfficialDesktopStateModule {
  E: (items: unknown[]) => unknown[];
  Bl: (automation: unknown) => boolean;
  Ht: () => Promise<unknown>;
  Gt: (params: unknown) => Promise<unknown>;
  Wt: () => Promise<unknown>;
  Cr: (rrule: string) => boolean;
  Di: string;
  Er: (id: string, nextRunAt: number | null) => boolean;
  Gr: (pendingThreadId: string, threadId: string) => boolean;
  Tr: (now: number, limit?: number) => unknown[];
  Vr: (
    automationId: string,
    threadId: string,
    threadTitle: string,
    sourceCwd: string | null,
  ) => boolean;
  qr: () => boolean;
  br: (rrule: string) => number | null;
  kr: (id: string, nextRunAt: number | null) => boolean;
  Sr: (input: { rrule: string; now: number }) => number | null;
  xr: (input: { automation: unknown; now: number }) => number | null;
  zl: (input: { automation: unknown; models: unknown[] }) => unknown;
  Jl: (mode: string, roots: string[], config: Record<string, unknown>) => Record<string, unknown>;
  Ql: (requirements: unknown, config: Record<string, unknown>) => string[];
  Xl: (config: Record<string, unknown>) => unknown;
  Yl: (approvalPolicy: string) => { sandboxPolicy: unknown };
  Zl: (value: unknown) => boolean;
  rn: (input: {
    baseInstructions: string;
    isNonGitWorkspace: boolean;
    threadToolsEnabled: boolean;
  }) => string;
  Xa: (input: {
    cwd: string;
    projectlessOutputDirectory: string;
    projectlessWorkspaceBrowserRoot: string;
  }) => string;
  wr: () => unknown[];
  _r: (input: unknown, compatibilityCwds?: string[]) => unknown;
  Ar: (input: unknown, compatibilityCwds?: string[]) => unknown;
  yr: (id: string) => unknown;
  vr: (id: string) => string;
  Ur: (id: string) => boolean;
  T: (limit?: number) => unknown[];
  w: () => unknown;
  C: (id: string, readAt: number | null) => unknown;
  S: (readAt: number) => number;
  Kr: (
    threadId: string,
    archivedUserMessage: string | null,
    archivedAssistantMessage: string | null,
  ) => boolean;
  Wr: (threadId: string, archivedReason?: string) => boolean;
  Hr: (threadId: string) => boolean;
  Rr: (input: { codexHome: string; threadId: string }) => Promise<boolean | null>;
  il: number;
  zo: (bytes: Uint8Array) => Promise<string | null>;
  Rt: (options: {
    appServerClient: OfficialLocalExecutionHost;
    preferWsl: boolean;
  }) => Promise<unknown>;
  Lt: (options: {
    appServerClient: OfficialLocalExecutionHost;
    avatarId: string;
    preferWsl: boolean;
  }) => Promise<unknown>;
  on: (options: {
    codexHome: string;
    filesystem: OfficialLocalExecutionHost;
    marketplaces: unknown[];
    path: typeof posix;
  }) => Promise<unknown>;
  Sc: (marketplaceName: string) => boolean;
  xc: (buildFlavor: string) => string;
  Jr: () => void;
}

interface OfficialLocalExecutionHost {
  codexHome: () => Promise<string>;
  platformPath: () => Promise<typeof posix>;
  readFile: (path: string) => Promise<ReadableStream<Uint8Array>>;
  writeFile: (path: string, value: string | Uint8Array) => Promise<void>;
  createDirectory: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  stat: (
    path: string,
    options?: { followSymlinks?: boolean },
  ) => Promise<Awaited<ReturnType<typeof stat>>>;
  readDirectory: (path: string) => Promise<Dirent[]>;
  remove: (path: string, options?: { force?: boolean; recursive?: boolean }) => Promise<void>;
  copyFile: (
    source: string,
    destination: string,
    options?: { exclusive?: boolean },
  ) => Promise<void>;
  copy: (source: string, destination: string, options?: { recursive?: boolean }) => Promise<void>;
}

interface NodeModuleLoader {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
}

const QUALIFIED_ELECTRON_VERSION = '42.3.0';
const require = createRequire(import.meta.url);
const moduleLoader = require('node:module') as NodeModuleLoader;
const originalLoad = moduleLoader._load;
const compatibleBetterSqlite3 = require('better-sqlite3') as unknown;

moduleLoader._load = function loadQualifiedDependency(
  request: string,
  parent: unknown,
  isMain: boolean,
): unknown {
  if (request === 'better-sqlite3') return compatibleBetterSqlite3;
  return originalLoad.call(this, request, parent, isMain);
};

Object.defineProperty(process.versions, 'electron', {
  configurable: true,
  value: QUALIFIED_ELECTRON_VERSION,
});

const sourceRootValue = process.env.OFFICIAL_SOURCE_ROOT;
if (typeof sourceRootValue !== 'string' || sourceRootValue.length === 0) {
  throw new Error('OFFICIAL_SOURCE_ROOT is required by the official desktop state worker');
}
const sourceRoot = resolve(sourceRootValue);
const officialRequire = createRequire(join(sourceRoot, 'package.json'));
const official = officialRequire(
  resolveOfficialSharedModulePath(sourceRoot),
) as Partial<OfficialDesktopStateModule>;

for (const exportName of [
  'E',
  'Bl',
  'Ht',
  'Gt',
  'Wt',
  'Cr',
  'Er',
  'Gr',
  'Tr',
  'Vr',
  'qr',
  'br',
  'kr',
  'Sr',
  'xr',
  'zl',
  'Jl',
  'Ql',
  'Xl',
  'Yl',
  'Zl',
  'rn',
  'Xa',
  'wr',
  '_r',
  'Ar',
  'yr',
  'vr',
  'Ur',
  'T',
  'w',
  'C',
  'S',
  'Kr',
  'Wr',
  'Hr',
  'Rr',
  'zo',
  'Rt',
  'Lt',
  'on',
  'Sc',
  'xc',
  'Jr',
] as const) {
  if (typeof official[exportName] !== 'function') {
    throw new Error(`qualified official desktop state export changed: ${exportName}`);
  }
}
if (official.Di !== 'none') {
  throw new Error('qualified official automation summary constant changed');
}
if (official.il !== 256 * 1024 * 1024) {
  throw new Error('qualified official workspace file size limit changed');
}

const state = official as OfficialDesktopStateModule;
const codexHome = requiredEnvironmentPath('CODEX_HOME');
const configuredUserRuntimeRoot = dirname(codexHome);
const canonicalUserRuntimeRoot = await realpath(configuredUserRuntimeRoot);
const localExecutionHost: OfficialLocalExecutionHost = {
  codexHome() {
    return Promise.resolve(codexHome);
  },
  platformPath() {
    return Promise.resolve(posix);
  },
  async readFile(path) {
    const bytes = await readFile(await readableWorkerPath(path));
    const body = new Response(bytes).body;
    if (body === null) throw new Error('Official file stream could not be created');
    return body;
  },
  async writeFile(path, value) {
    await writeFile(await writableWorkerPath(path), value);
  },
  async createDirectory(path, options = {}) {
    await mkdir(await writableWorkerPath(path), { recursive: options.recursive ?? true });
  },
  async stat(path, options = {}) {
    return options.followSymlinks === false
      ? lstat(await writableWorkerPath(path))
      : stat(await readableWorkerPath(path));
  },
  readDirectory(path) {
    return readableWorkerPath(path).then(async (resolvedPath) =>
      readdir(resolvedPath, { withFileTypes: true }),
    );
  },
  async remove(path, options = {}) {
    await rm(await writableWorkerPath(path), {
      recursive: options.recursive ?? true,
      force: options.force ?? true,
    });
  },
  async copyFile(source, destination, options = {}) {
    await copyFile(
      await readableWorkerPath(source),
      await writableWorkerPath(destination),
      options.exclusive === true ? constants.COPYFILE_EXCL : 0,
    );
  },
  async copy(source, destination, options = {}) {
    await cp(await readableWorkerPath(source), await writableWorkerPath(destination), {
      recursive: options.recursive ?? false,
    });
  },
};

process.on('message', (message: unknown) => {
  if (isShutdownMessage(message)) {
    state.Jr();
    process.disconnect();
    return;
  }
  if (!isWorkerRequest(message)) return;
  void execute(message)
    .then((result) => {
      process.send?.({ type: 'response', id: message.id, result });
    })
    .catch((error: unknown) => {
      process.send?.({
        type: 'response',
        id: message.id,
        error: error instanceof Error ? error.message : 'official desktop state operation failed',
      });
    });
});

process.send?.({ type: 'ready' });

async function execute(request: WorkerRequest): Promise<unknown> {
  const params = recordParams(request.params);
  switch (request.operation) {
    case 'keymap.get':
      return state.Ht();
    case 'keymap.set':
      return state.Gt(params);
    case 'keymap.reset':
      return state.Wt();
    case 'file.detect-kind':
      return state.zo(bytesValue(params.bytes, 'file sample'));
    case 'file.max-bytes':
      return { maxBytes: state.il };
    case 'custom-avatars.load':
      return state.Rt({
        appServerClient: localExecutionHost,
        preferWsl: false,
      });
    case 'custom-avatars.load-avatar':
      return state.Lt({
        appServerClient: localExecutionHost,
        avatarId: nonEmptyString(params.avatarId, 'custom avatar id'),
        preferWsl: false,
      });
    case 'plugin-scheduled-tasks.list': {
      const buildFlavor = nonEmptyString(params.buildFlavor, 'plugin build flavor');
      const hiddenMarketplaceNames = boundedStringArray(
        params.hiddenMarketplaceNames,
        'hidden plugin marketplaces',
      );
      const expectedInternalMarketplaceName = state.xc(buildFlavor);
      const marketplaces = unknownArray(params.marketplaces, 'plugin marketplaces').filter(
        (marketplace) => {
          const value = recordValue(marketplace, 'plugin marketplace');
          const name = nonEmptyString(value.name, 'plugin marketplace name');
          return (
            !hiddenMarketplaceNames.includes(name) &&
            (!state.Sc(name) || name === expectedInternalMarketplaceName)
          );
        },
      );
      return state.on({
        codexHome,
        filesystem: localExecutionHost,
        marketplaces,
        path: posix,
      });
    }
    case 'automations.list':
      return { items: state.wr() };
    case 'automations.get':
      return state.yr(nonEmptyString(params.id, 'automation id'));
    case 'automations.due': {
      const now =
        params.now === undefined ? Date.now() : finiteNumber(params.now, 'automation due time');
      return {
        items: state.Tr(now, optionalLimit(params.limit, 3)),
      };
    }
    case 'automations.defer-heartbeat': {
      const id = nonEmptyString(params.id, 'automation id');
      const automation = state.yr(id);
      if (automation === null || !state.Bl(automation)) {
        throw new Error('Heartbeat automation not found.');
      }
      const now =
        params.now === undefined ? Date.now() : finiteNumber(params.now, 'heartbeat defer time');
      const automationRecord = recordValue(automation, 'heartbeat automation');
      const rrule = nonEmptyString(automationRecord.rrule, 'heartbeat automation recurrence rule');
      const interval = state.br(rrule);
      const nextRunAt = interval === null ? state.Sr({ rrule, now }) : now + interval;
      if (!state.kr(id, nextRunAt)) throw new Error('Heartbeat schedule update failed.');
      return { nextRunAt };
    }
    case 'automations.prepare-run': {
      const id = nonEmptyString(params.id, 'automation id');
      const automation = state.yr(id);
      if (automation === null) throw new Error('Automation not found.');
      const now =
        params.now === undefined ? Date.now() : finiteNumber(params.now, 'automation run time');
      const automationRecord = recordValue(automation, 'automation');
      const nextRunAt =
        finiteOrNull(automationRecord.nextRunAt) !== null &&
        (automationRecord.nextRunAt as number) <= now &&
        state.Cr(nonEmptyString(automationRecord.rrule, 'automation recurrence rule'))
          ? null
          : state.xr({ automation, now });
      if (!state.Er(id, nextRunAt)) {
        throw new Error('Automation schedule update failed.');
      }
      return {
        previousAutomation: automation,
        automation: state.yr(id),
        modelSettings: state.zl({
          automation,
          models: unknownArray(params.models, 'automation models'),
        }),
      };
    }
    case 'automations.resolve-permissions': {
      const config = recordValue(params.config, 'automation configuration');
      const sourceCwds = stringArray(params.sourceCwds);
      const requirements = params.requirements ?? null;
      const configuredMode =
        config.sandbox_mode !== undefined || config.approval_policy !== undefined
          ? 'custom'
          : state.Zl(state.Xl(config))
            ? 'guardian-approvals'
            : 'auto';
      const preferredMode =
        params.preferredMode === null || params.preferredMode === undefined
          ? configuredMode
          : nonEmptyString(params.preferredMode, 'preferred permission mode');
      const supportedModes = state.Ql(requirements, config);
      const fallbackMode =
        [configuredMode, 'auto', 'granular', 'guardian-approvals', 'read-only'].find((mode) =>
          supportedModes.includes(mode),
        ) ??
        supportedModes.at(-1) ??
        'read-only';
      const selectedMode = supportedModes.includes(preferredMode) ? preferredMode : fallbackMode;
      const resolved = state.Jl(selectedMode, sourceCwds, config);
      const approvalPolicy =
        selectedMode !== 'granular' &&
        resolved.approvalsReviewer === 'user' &&
        allowedApprovalPolicies(requirements)?.includes('never') === true
          ? 'never'
          : resolved.approvalPolicy;
      return { ...resolved, approvalPolicy };
    }
    case 'automations.developer-instructions': {
      const baseInstructions = nonEmptyString(
        params.baseInstructions,
        'automation developer instructions',
      );
      const primary = state.rn({
        baseInstructions,
        isNonGitWorkspace: true,
        threadToolsEnabled: true,
      });
      if (params.projectless !== true) return { instructions: primary };
      const cwd = nonEmptyString(params.cwd, 'automation working directory');
      const outputDirectory = nonEmptyString(params.outputDirectory, 'automation output directory');
      const workspaceRoot = nonEmptyString(params.workspaceRoot, 'automation workspace root');
      return {
        instructions: [
          primary,
          state.Xa({
            cwd,
            projectlessOutputDirectory: outputDirectory,
            projectlessWorkspaceBrowserRoot: workspaceRoot,
          }),
        ].join('\n\n'),
      };
    }
    case 'automations.constants':
      return {
        defaultSummary: state.Di,
      };
    case 'automations.create': {
      const item = state._r(params.input, stringArray(params.compatibilityCwds));
      if (item === null) throw new Error('Automation create failed.');
      return { item };
    }
    case 'automations.update': {
      const item = state.Ar(params.input, stringArray(params.compatibilityCwds));
      if (item === null) throw new Error('Automation update failed.');
      return { item };
    }
    case 'automations.delete': {
      const id = nonEmptyString(params.id, 'automation id');
      const item = state.yr(id);
      const status = state.vr(id);
      const success = status === 'deleted' || status === 'not_found';
      if (success) state.Ur(id);
      return { item, success, status };
    }
    case 'inbox.list': {
      const limit = optionalLimit(params.limit, 200);
      return { items: state.T(limit), unreadRunCounts: state.w() };
    }
    case 'inbox.set-read': {
      const id = nonEmptyString(params.id, 'inbox item id');
      if (typeof params.isRead !== 'boolean') throw new Error('inbox read state is invalid');
      return {
        item: state.C(id, params.isRead ? Date.now() : null),
        unreadRunCounts: state.w(),
      };
    }
    case 'inbox.mark-all-read': {
      const readAt =
        params.readAt === undefined ? Date.now() : finiteNumber(params.readAt, 'read timestamp');
      return { changed: state.S(readAt), unreadRunCounts: state.w() };
    }
    case 'inbox.persist': {
      const items = unknownArray(params.items, 'inbox items');
      return {
        items: state.E(items),
        unreadRunCounts: state.w(),
      };
    }
    case 'thread.archive-inactive':
      return {
        archived: await state.Rr({
          codexHome: nonEmptyString(params.codexHome, 'Codex home'),
          threadId: nonEmptyString(params.threadId, 'thread id'),
        }),
      };
    case 'automation-run.create': {
      return {
        success: state.Vr(
          nonEmptyString(params.automationId, 'automation id'),
          nonEmptyString(params.threadId, 'automation run thread id'),
          nonEmptyString(params.threadTitle, 'automation run thread title'),
          optionalString(params.sourceCwd),
        ),
      };
    }
    case 'automation-run.replace-pending':
      return {
        success: state.Gr(
          nonEmptyString(params.pendingThreadId, 'pending automation run thread id'),
          nonEmptyString(params.threadId, 'automation run thread id'),
        ),
      };
    case 'automation-run.complete': {
      const threadId = nonEmptyString(params.threadId, 'automation run thread id');
      const title = nullableString(params.title, 'automation run inbox title');
      const description = nullableString(params.description, 'automation run inbox description');
      const items = state.E([{ threadId, title, description }]);
      if (params.readAt !== undefined) {
        state.C(threadId, nullableFiniteNumber(params.readAt, 'automation run read timestamp'));
      }
      return {
        success: items.length > 0,
        unreadRunCounts: state.w(),
      };
    }
    case 'automation-run.settle-interrupted':
      return {
        success: state.qr(),
        unreadRunCounts: state.w(),
      };
    case 'automation-run.archive': {
      const threadId = nonEmptyString(params.threadId, 'automation run thread id');
      const archivedUserMessage = optionalString(params.archivedUserMessage);
      const archivedAssistantMessage = optionalString(params.archivedAssistantMessage);
      if (archivedUserMessage !== null || archivedAssistantMessage !== null) {
        state.Kr(threadId, archivedUserMessage, archivedAssistantMessage);
      }
      return {
        success: state.Wr(threadId, optionalString(params.archivedReason) ?? undefined),
      };
    }
    case 'automation-run.delete':
      return {
        success: state.Hr(nonEmptyString(params.threadId, 'automation run thread id')),
      };
    default:
      throw new Error(`Unknown official desktop state operation: ${request.operation}`);
  }
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    request.type === 'request' &&
    Number.isInteger(request.id) &&
    (request.id as number) > 0 &&
    typeof request.operation === 'string'
  );
}

function isShutdownMessage(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === 'shutdown'
  );
}

function recordParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('official desktop state parameters must be an object');
  }
  return value as Record<string, unknown>;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return nonEmptyString(value, 'optional desktop state string');
}

function nullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return nonEmptyString(value, label);
}

function unknownArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error(`${label} are invalid`);
  }
  return value;
}

function bytesValue(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > 4_096) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error('automation compatibility directories are invalid');
  }
  return value.map((item) => nonEmptyString(item, 'automation compatibility directory'));
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error(`${label} are invalid`);
  }
  return value.map((item) => nonEmptyString(item, label));
}

function optionalLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1_000) {
    throw new Error('inbox item limit is invalid');
  }
  return value as number;
}

function finiteNumber(value: unknown, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} is invalid`);
  return value as number;
}

function finiteOrNull(value: unknown): number | null {
  return Number.isFinite(value) ? (value as number) : null;
}

function nullableFiniteNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  return finiteNumber(value, label);
}

function allowedApprovalPolicies(value: unknown): string[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>).allowedApprovalPolicies;
  if (!Array.isArray(nested)) return null;
  return nested.filter((entry): entry is string => typeof entry === 'string');
}

function requiredEnvironmentPath(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

function lexicalWorkerPath(path: string): string {
  if (!isAbsolute(path)) throw new Error('Official worker path must be absolute');
  const resolvedPath = resolve(path);
  assertPathWithin(configuredUserRuntimeRoot, resolvedPath);
  return resolvedPath;
}

function canonicalWorkerPath(path: string): string {
  const resolvedPath = resolve(path);
  assertPathWithin(canonicalUserRuntimeRoot, resolvedPath);
  return resolvedPath;
}

function assertPathWithin(root: string, path: string): void {
  const pathFromRoot = relative(root, path);
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${posix.sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error('Official worker path is outside the user runtime');
  }
}

async function readableWorkerPath(path: string): Promise<string> {
  const resolvedPath = lexicalWorkerPath(path);
  const canonicalPath = await realpath(resolvedPath);
  return canonicalWorkerPath(canonicalPath);
}

async function writableWorkerPath(path: string): Promise<string> {
  const resolvedPath = lexicalWorkerPath(path);
  try {
    return await readableWorkerPath(resolvedPath);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
  const canonicalParent = await realpath(dirname(resolvedPath));
  canonicalWorkerPath(canonicalParent);
  return join(canonicalParent, basename(resolvedPath));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
