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
    await writeFile(sourceRollout, '{"type":"source"}\n', 'utf8');
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
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, mode: 'sync-existing' });
    expect(await readFile(targetRollout, 'utf8')).toBe('{"type":"source"}\n');
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
  });
});
