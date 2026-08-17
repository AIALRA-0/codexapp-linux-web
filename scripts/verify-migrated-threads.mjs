import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';

const codexBin = requiredEnvironment('VERIFY_CODEX_BIN');
const codexHome = requiredEnvironment('VERIFY_CODEX_HOME');
const recordsPath = requiredEnvironment('VERIFY_RECORDS');
const workspace = requiredEnvironment('VERIFY_WORKSPACE');
const rendererVersion = process.env.VERIFY_RENDERER_VERSION ?? '26.730.61639';
const migration = JSON.parse(await readFile(recordsPath, 'utf8'));
const records = Array.isArray(migration?.threads) ? migration.threads : migration?.records;
if (migration?.schemaVersion !== 1 || !Array.isArray(records)) {
  throw new Error('migration thread manifest is invalid');
}
const workspaceProjectsRoot = resolveWorkspaceProjectsRoot(
  workspace,
  migration.workspaceRelativeRoot,
  migration.targetWorkspace,
);

const client = new CodexAppServerClient({
  codexBin,
  codexHome,
  cwd: workspace,
  clientVersion: rendererVersion,
  extraArgs: ['-c', 'features.code_mode_host=true'],
  requestTimeoutMs: 300_000,
});
const stderr = [];
client.on('request', (event) => {
  void event.respond({
    error: {
      code: -32_600,
      message: `unexpected server request during migrated-thread verification: ${event.request.method}`,
    },
  });
});
client.on('stderr', (line) => {
  stderr.push(line);
  if (stderr.length > 20) stderr.shift();
});

const results = [];
try {
  await client.start();
  for (const record of records) {
    const startedAt = performance.now();
    const targetCwd = resolveRecordWorkspace(workspaceProjectsRoot, record);
    const targetRollout = await findRollout(codexHome, record.threadId);
    const before = await fileDigest(targetRollout);
    if (before.sha256 !== record.rolloutSha256) {
      throw new Error(`stored rollout digest differs for ${record.label}`);
    }
    const metadata = await client.request('thread/read', {
      threadId: record.threadId,
      includeTurns: false,
    });
    const resumed = await client.request('thread/resume', {
      threadId: record.threadId,
      path: targetRollout,
      cwd: targetCwd,
      excludeTurns: true,
      initialTurnsPage: {
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'summary',
      },
    });
    const metadataThread = metadata?.thread ?? metadata;
    const resumedThread = resumed?.thread ?? resumed;
    if (metadataThread?.id !== record.threadId || resumedThread?.id !== record.threadId) {
      throw new Error(`app-server returned the wrong thread for ${record.threadId}`);
    }
    const resumedCwd = resumed?.cwd ?? resumedThread?.cwd;
    if (resumedCwd !== targetCwd) {
      throw new Error(`app-server resumed ${record.label} in the wrong workspace`);
    }
    const after = await fileDigest(targetRollout);
    if (after.sha256 !== before.sha256 || after.bytes !== before.bytes) {
      throw new Error(`read-only resume changed the rollout for ${record.label}`);
    }
    results.push({
      label: record.label,
      historyMode: metadataThread?.historyMode ?? resumedThread?.historyMode,
      rolloutBytes: after.bytes,
      readAndResumeMs: Math.round(performance.now() - startedAt),
    });
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, rendererVersion, verified: results.length, results })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stderr,
      completed: results,
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await client.stop().catch(() => undefined);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function fileDigest(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`not a regular file: ${path}`);
  const hash = createHash('sha256');
  await new Promise((resolveDigest, rejectDigest) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolveDigest);
    stream.on('error', rejectDigest);
  });
  return { bytes: metadata.size, sha256: hash.digest('hex') };
}

function resolveWorkspaceProjectsRoot(workspaceRoot, relativeRoot, storedAbsoluteRoot) {
  if (typeof relativeRoot === 'string' && relativeRoot.length > 0 && !isAbsolute(relativeRoot)) {
    const segments = relativeRoot.split(/[\\/]+/u).filter(Boolean);
    if (segments[0] === 'workspace') segments.shift();
    return resolveInside(workspaceRoot, segments.join(sep), 'workspace project root');
  }
  if (typeof storedAbsoluteRoot === 'string' && isAbsolute(storedAbsoluteRoot)) {
    return resolveAbsoluteInside(
      workspaceRoot,
      storedAbsoluteRoot,
      'stored workspace project root',
    );
  }
  throw new Error('migration workspace project root is missing or invalid');
}

function resolveRecordWorkspace(workspaceProjectsRoot, record) {
  if (typeof record?.workspace === 'string' && record.workspace.length > 0) {
    return resolveInside(workspaceProjectsRoot, record.workspace, 'thread workspace');
  }
  if (typeof record?.targetCwd === 'string' && isAbsolute(record.targetCwd)) {
    return resolveAbsoluteInside(
      workspaceProjectsRoot,
      record.targetCwd,
      'stored thread workspace',
    );
  }
  throw new Error(
    `thread workspace is missing for ${String(record?.label ?? 'unlabelled record')}`,
  );
}

function resolveInside(parent, child, label) {
  if (typeof child !== 'string' || child.length === 0 || isAbsolute(child)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const parentPath = resolve(parent);
  const childPath = resolve(parentPath, child);
  const childRelative = relative(parentPath, childPath);
  if (
    childRelative === '' ||
    childRelative.startsWith(`..${sep}`) ||
    childRelative === '..' ||
    isAbsolute(childRelative)
  ) {
    throw new Error(`${label} escapes its allowed root`);
  }
  return childPath;
}

function resolveAbsoluteInside(parent, child, label) {
  if (typeof child !== 'string' || !isAbsolute(child)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const childRelative = relative(parentPath, childPath);
  if (
    childRelative === '' ||
    childRelative.startsWith(`..${sep}`) ||
    childRelative === '..' ||
    isAbsolute(childRelative)
  ) {
    throw new Error(`${label} escapes its allowed root`);
  }
  return childPath;
}

async function findRollout(home, threadId) {
  if (typeof threadId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(threadId)) {
    throw new Error('migration thread id is invalid');
  }
  const sessionsRoot = join(resolve(home), 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const matches = [];
  await walk(sessionsRoot, async (path, entry) => {
    if (entry.isFile() && entry.name.endsWith(suffix)) matches.push(path);
  });
  if (matches.length !== 1) {
    throw new Error(
      `expected one stored rollout for a migrated thread, found ${String(matches.length)}`,
    );
  }
  return matches[0];
}

async function walk(directory, visit) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, visit);
    else await visit(path, entry);
  }
}
