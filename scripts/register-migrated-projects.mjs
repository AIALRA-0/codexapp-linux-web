import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import Database from 'better-sqlite3';

import { DurableStateStore } from '../packages/host-gateway/dist/state.js';

const options = parseArguments(process.argv.slice(2));
const userRoot = requiredAbsolutePath(options, 'user-root');
const codexHome = requiredAbsolutePath(options, 'codex-home');
const projectsRoot = requiredAbsolutePath(options, 'projects-root');
const recordsPath = requiredAbsolutePath(options, 'records');
const statePath = resolve(userRoot, 'host-state.json');
const migration = JSON.parse(await readFile(recordsPath, 'utf8'));

if (!Array.isArray(migration?.records) || migration.records.length === 0) {
  throw new Error('migration records must contain at least one thread');
}
await requireDirectory(projectsRoot, 'projects root');

const database = new Database(resolve(codexHome, 'state_5.sqlite'), {
  readonly: true,
  fileMustExist: true,
});
const activeThreadIds = new Set();
try {
  for (const row of database.prepare('SELECT id FROM threads').all()) {
    activeThreadIds.add(requiredString(row.id, 'database thread id'));
  }
} finally {
  database.close();
}

const store = new DurableStateStore(statePath);
await store.load();
const globalState = store.snapshot('globalState');
const localProjects = objectValue(globalState['local-projects']);
const assignments = filterThreadRecord(
  objectValue(globalState['thread-project-assignments']),
  activeThreadIds,
);
const rootToProjectId = new Map();

for (const [projectId, value] of Object.entries(localProjects)) {
  if (!isRecord(value) || !Array.isArray(value.rootPaths)) continue;
  for (const rootPath of value.rootPaths) {
    if (typeof rootPath === 'string') rootToProjectId.set(resolve(rootPath), projectId);
  }
}

const importedProjectIds = [];
const migratedThreadIds = new Set();
const workspaceHints = filterThreadRecord(
  objectValue(globalState['thread-workspace-root-hints']),
  activeThreadIds,
);
const now = Date.now();

for (const record of migration.records) {
  const threadId = requiredString(record.threadId, 'migration thread id');
  if (!activeThreadIds.has(threadId)) {
    throw new Error(`migration thread is missing from the target database: ${threadId}`);
  }
  const targetCwd = requiredAbsoluteRecordPath(record.targetCwd, 'target cwd');
  const relativeCwd = safeRelativePath(projectsRoot, targetCwd, 'target cwd');
  const projectSegment = relativeCwd.split(sep)[0];
  if (projectSegment === undefined || projectSegment.length === 0) {
    throw new Error(`target cwd does not identify a project: ${targetCwd}`);
  }
  const projectRoot = await realpath(resolve(projectsRoot, projectSegment));
  await requireDirectory(projectRoot, 'project root');

  let projectId = rootToProjectId.get(projectRoot);
  if (projectId === undefined) {
    projectId = deterministicProjectId(projectRoot);
    const previous = localProjects[projectId];
    const createdAt =
      isRecord(previous) && typeof previous.createdAt === 'number' ? previous.createdAt : now;
    localProjects[projectId] = {
      id: projectId,
      name: projectDisplayName(basename(projectRoot)),
      rootPaths: [projectRoot],
      createdAt,
      updatedAt: now,
    };
    rootToProjectId.set(projectRoot, projectId);
  }
  if (!importedProjectIds.includes(projectId)) importedProjectIds.push(projectId);

  assignments[threadId] = {
    projectKind: 'local',
    projectId,
    cwd: targetCwd,
    pendingCoreUpdate: false,
  };
  workspaceHints[threadId] = targetCwd;
  migratedThreadIds.add(threadId);
}

const existingOrder = stringArray(globalState['project-order']);
globalState['local-projects'] = localProjects;
globalState['project-order'] = [
  ...importedProjectIds,
  ...existingOrder.filter((projectId) => !importedProjectIds.includes(projectId)),
];
globalState['thread-project-assignments'] = assignments;
globalState['thread-workspace-root-hints'] = workspaceHints;
globalState['projectless-thread-ids'] = stringArray(globalState['projectless-thread-ids']).filter(
  (threadId) => activeThreadIds.has(threadId) && !migratedThreadIds.has(threadId),
);
globalState['pinned-thread-ids'] = stringArray(globalState['pinned-thread-ids']).filter(
  (threadId) => activeThreadIds.has(threadId),
);
globalState['thread-projectless-output-directories'] = filterThreadRecord(
  objectValue(globalState['thread-projectless-output-directories']),
  activeThreadIds,
);
globalState['sidebar-thread-metadata'] = filterThreadRecord(
  objectValue(globalState['sidebar-thread-metadata']),
  activeThreadIds,
);
globalState['sidebar-project-thread-orders'] = filterThreadOrderRecord(
  objectValue(globalState['sidebar-project-thread-orders']),
  activeThreadIds,
);
globalState['selected-project'] ??= {
  type: 'local',
  projectId: importedProjectIds[0],
};

const previousCatalog = objectValue(globalState['__browser-host-official-thread-catalog-v1']);
globalState['__browser-host-official-thread-catalog-v1'] = {
  formatVersion: 1,
  revision:
    typeof previousCatalog.revision === 'number' && Number.isFinite(previousCatalog.revision)
      ? previousCatalog.revision + 1
      : 1,
  isComplete: false,
  entries: [],
};

await store.replace('globalState', globalState);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    activeThreads: activeThreadIds.size,
    assignedThreads: migratedThreadIds.size,
    registeredProjects: importedProjectIds.length,
    catalogReset: true,
  })}\n`,
);

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`--${key} needs a value`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requiredAbsolutePath(values, key) {
  return requiredAbsoluteRecordPath(values[key], `--${key}`);
}

function requiredAbsoluteRecordPath(value, label) {
  const path = requiredString(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return resolve(path);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function safeRelativePath(root, path, label) {
  const value = relative(resolve(root), resolve(path));
  if (value.length === 0 || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`${label} must be located below ${resolve(root)}`);
  }
  return value;
}

async function requireDirectory(path, label) {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

function deterministicProjectId(path) {
  const bytes = createHash('sha256').update(`codexapp-project:${path}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function projectDisplayName(name) {
  return (
    {
      'aialra-email': 'AIALRA Email',
      'aialra-interview': 'AIALRA Interview',
      'audit-skill': '审计 Skill',
      'career-coaching': '求职陪跑',
      'contabo-vps': 'Contabo VPS',
      'expression-skill': '语气 Skill',
      'trillium-reader': 'Trillium Reader',
      'usc-course': 'USC 课程体系',
    }[name] ?? name
  );
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectValue(value) {
  return isRecord(value) ? { ...value } : {};
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function filterThreadRecord(value, allowedIds) {
  return Object.fromEntries(Object.entries(value).filter(([threadId]) => allowedIds.has(threadId)));
}

function filterThreadOrderRecord(value, allowedIds) {
  return Object.fromEntries(
    Object.entries(value).map(([projectId, threadIds]) => [
      projectId,
      stringArray(threadIds).filter((threadId) => allowedIds.has(threadId)),
    ]),
  );
}
