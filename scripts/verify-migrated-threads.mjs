import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';

const codexBin = requiredEnvironment('VERIFY_CODEX_BIN');
const codexHome = requiredEnvironment('VERIFY_CODEX_HOME');
const recordsPath = requiredEnvironment('VERIFY_RECORDS');
const workspace = requiredEnvironment('VERIFY_WORKSPACE');
const rendererVersion = process.env.VERIFY_RENDERER_VERSION ?? '26.721.81911';
const migration = JSON.parse(await readFile(recordsPath, 'utf8'));
if (!Array.isArray(migration?.records)) throw new Error('migration records are missing');

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
  for (const record of migration.records) {
    const startedAt = performance.now();
    const metadata = await client.request('thread/read', {
      threadId: record.threadId,
      includeTurns: false,
    });
    const resumed = await client.request('thread/resume', {
      threadId: record.threadId,
      path: record.targetRollout,
      cwd: record.targetCwd,
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
    if (resumedCwd !== record.targetCwd) {
      throw new Error(
        `app-server resumed ${record.threadId} in ${String(resumedCwd)} instead of ${record.targetCwd}`,
      );
    }
    const digest = await fileDigest(record.targetRollout);
    if (digest.sha256 !== record.rolloutSha256 || digest.bytes !== record.rolloutBytes) {
      throw new Error(`read-only resume changed the rollout for ${record.threadId}`);
    }
    results.push({
      label: record.label,
      threadId: record.threadId,
      sourceMetadataCwd: metadataThread?.cwd,
      resumedCwd,
      historyMode: metadataThread?.historyMode ?? resumedThread?.historyMode,
      rolloutBytes: digest.bytes,
      rolloutSha256: digest.sha256,
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
