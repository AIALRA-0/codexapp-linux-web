import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

interface SqliteStatement {
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  run(...parameters: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface SqliteDatabaseConstructor {
  new (path: string, options?: { readonly?: boolean }): SqliteDatabase;
}

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as SqliteDatabaseConstructor;
const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'migrate-codex-threads.mjs',
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('existing thread synchronization', () => {
  it('copies verified history and metadata while preserving server paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-thread-sync-'));
    temporaryRoots.push(root);
    const sourceHome = join(root, 'source');
    const targetHome = join(root, 'target');
    const backupRoot = join(root, 'backup');
    const sourceRollout = join(sourceHome, 'sessions', 'source.jsonl');
    const targetRollout = join(targetHome, 'sessions', 'target.jsonl');
    await mkdir(dirname(sourceRollout), { recursive: true });
    await mkdir(dirname(targetRollout), { recursive: true });
    await writeFile(
      sourceRollout,
      [
        JSON.stringify({
          type: 'turn_context',
          payload: {
            cwd: join(root, 'local-workspace'),
            workspace_roots: [join(root, 'local-workspace')],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            arguments: JSON.stringify({ workdir: join(root, 'local-workspace') }),
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(targetRollout, '{"type":"target"}\n', 'utf8');

    const sourceDatabase = new Database(join(sourceHome, 'state_5.sqlite'));
    const targetDatabase = new Database(join(targetHome, 'state_5.sqlite'));
    for (const database of [sourceDatabase, targetDatabase]) {
      database.exec(
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, updated_at INTEGER, title TEXT)',
      );
    }
    sourceDatabase
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)')
      .run('thread-1', sourceRollout, join(root, 'local-workspace'), 200, 'new title');
    targetDatabase
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)')
      .run('thread-1', targetRollout, join(root, 'server-workspace'), 100, 'old title');
    sourceDatabase.close();
    targetDatabase.close();

    const discoveryDatabase = new Database(join(root, 'codex-discovery-responses.db'));
    discoveryDatabase.exec(`
      CREATE TABLE renderer_discovery_cache (
        method TEXT NOT NULL,
        cache_key TEXT NOT NULL
      );
      INSERT INTO renderer_discovery_cache VALUES ('thread/resume', 'stale-thread');
      INSERT INTO renderer_discovery_cache VALUES ('plugin/list', 'keep-plugin');
    `);
    discoveryDatabase.close();
    const historyDatabase = new Database(join(root, 'codex-history-snapshots.db'));
    historyDatabase.exec(`
      CREATE TABLE app_server_history_snapshots (
        thread_id TEXT NOT NULL
      );
      INSERT INTO app_server_history_snapshots VALUES ('thread-1');
      INSERT INTO app_server_history_snapshots VALUES ('thread-2');
    `);
    historyDatabase.close();

    const expectedDigest = createHash('sha256')
      .update(await readFile(sourceRollout))
      .digest('hex');
    const { stdout } = await execute(process.execPath, [
      script,
      'sync-existing',
      '--source-home',
      sourceHome,
      '--target-home',
      targetHome,
      '--thread-id',
      'thread-1',
      '--expected-source-sha256',
      expectedDigest,
      '--backup-root',
      backupRoot,
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      mode: 'sync-existing',
      invalidatedCaches: { discoveryResponses: 1, historySnapshots: 1 },
    });
    const normalizedRollout = await readFile(targetRollout, 'utf8');
    const normalizedLines = normalizedRollout
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(normalizedLines[0]).toMatchObject({
      payload: {
        cwd: join(root, 'server-workspace'),
        workspace_roots: [join(root, 'server-workspace')],
      },
    });
    expect(normalizedRollout).toContain(join(root, 'local-workspace'));
    expect(await readFile(join(backupRoot, 'rollout.jsonl'), 'utf8')).toBe('{"type":"target"}\n');

    const verifiedTarget = new Database(join(targetHome, 'state_5.sqlite'), {
      readonly: true,
    });
    expect(verifiedTarget.prepare('SELECT * FROM threads WHERE id = ?').get('thread-1')).toEqual({
      id: 'thread-1',
      rollout_path: targetRollout,
      cwd: join(root, 'server-workspace'),
      updated_at: 200,
      title: 'new title',
    });
    verifiedTarget.close();

    const verifiedDiscovery = new Database(join(root, 'codex-discovery-responses.db'), {
      readonly: true,
    });
    expect(verifiedDiscovery.prepare('SELECT method FROM renderer_discovery_cache').get()).toEqual({
      method: 'plugin/list',
    });
    verifiedDiscovery.close();
    const verifiedHistory = new Database(join(root, 'codex-history-snapshots.db'), {
      readonly: true,
    });
    expect(
      verifiedHistory.prepare('SELECT thread_id FROM app_server_history_snapshots').get(),
    ).toEqual({ thread_id: 'thread-2' });
    verifiedHistory.close();
  });
});
