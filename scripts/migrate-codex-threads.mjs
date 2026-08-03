import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import Database from 'better-sqlite3';

const compatibleSourceOnlyColumnDefaults = new Map([['is_pinned', 0]]);

const [mode, ...argumentList] = process.argv.slice(2);
const options = parseArguments(argumentList);

if (mode === 'export') {
  await exportRecords(options);
} else if (mode === 'import') {
  await importRecords(options);
} else {
  throw new Error('usage: migrate-codex-threads.mjs <export|import> [options]');
}

async function exportRecords(values) {
  const sourceHome = requiredAbsolutePath(values, 'source-home');
  const targetHome = requiredAbsolutePath(values, 'target-home');
  const targetWorkspace = requiredAbsolutePath(values, 'target-workspace');
  const selectionPath = requiredAbsolutePath(values, 'selection');
  const outputPath = requiredAbsolutePath(values, 'output');
  const includeDeferred = values['include-deferred'] === true;
  const onlyDeferred = values['only-deferred'] === true;

  if (includeDeferred && onlyDeferred) {
    throw new Error('--include-deferred and --only-deferred cannot be used together');
  }

  const selection = JSON.parse(await readFile(selectionPath, 'utf8'));
  if (!Array.isArray(selection?.threads)) throw new Error('selection.threads must be an array');

  const database = new Database(join(sourceHome, 'state_5.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  const selectThread = database.prepare('SELECT * FROM threads WHERE id = ?');
  const records = [];
  try {
    for (const entry of selection.threads) {
      if (onlyDeferred && entry.deferUntilLast !== true) continue;
      if (!includeDeferred && !onlyDeferred && entry.deferUntilLast === true) continue;
      const threadId = requiredString(entry.threadId, 'selection thread id');
      const row = selectThread.get(threadId);
      if (row === undefined) throw new Error(`thread is missing from source database: ${threadId}`);

      const sourceRollout = resolve(requiredString(row.rollout_path, 'source rollout path'));
      const rolloutRelativePath = safeRelativePath(sourceHome, sourceRollout, 'rollout path');
      const targetRollout = join(targetHome, rolloutRelativePath);
      const targetCwd = join(
        targetWorkspace,
        safeRelativePath('.', requiredString(entry.workspace, 'workspace'), 'workspace'),
      );
      const rollout = await fileDigest(sourceRollout);
      const expectedDigest = requiredString(entry.rolloutSha256, 'expected rollout digest');
      if (rollout.sha256 !== expectedDigest) {
        throw new Error(
          `rollout changed after selection was recorded for ${threadId}: expected ${expectedDigest}, got ${rollout.sha256}`,
        );
      }

      records.push({
        label: requiredString(entry.label, 'thread label'),
        threadId,
        sourceRollout,
        targetRollout,
        targetCwd,
        rolloutRelativePath,
        rolloutSha256: rollout.sha256,
        rolloutBytes: rollout.bytes,
        row: { ...row, rollout_path: targetRollout, cwd: targetCwd },
      });
    }
  } finally {
    database.close();
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHome,
    targetHome,
    targetWorkspace,
    records,
  };
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, mode, outputPath, records: records.length })}\n`,
  );
}

async function importRecords(values) {
  const targetHome = requiredAbsolutePath(values, 'target-home');
  const recordsPath = requiredAbsolutePath(values, 'records');
  const migration = JSON.parse(await readFile(recordsPath, 'utf8'));
  if (migration?.schemaVersion !== 1 || !Array.isArray(migration.records)) {
    throw new Error('unsupported migration records file');
  }
  if (resolve(migration.targetHome) !== targetHome) {
    throw new Error('records targetHome does not match --target-home');
  }

  for (const record of migration.records) {
    const targetRollout = resolve(requiredString(record.targetRollout, 'target rollout path'));
    safeRelativePath(targetHome, targetRollout, 'target rollout path');
    const actual = await fileDigest(targetRollout);
    if (actual.sha256 !== record.rolloutSha256 || actual.bytes !== record.rolloutBytes) {
      throw new Error(`target rollout verification failed for ${record.threadId}`);
    }
  }

  const database = new Database(join(targetHome, 'state_5.sqlite'), { fileMustExist: true });
  try {
    const targetColumns = new Set(
      database
        .prepare('PRAGMA table_info(threads)')
        .all()
        .map((column) => column.name),
    );
    const existingThread = database.prepare('SELECT rollout_path, cwd FROM threads WHERE id = ?');
    const imported = [];
    const alreadyPresent = [];
    const omittedDefaultColumns = new Set();

    const transaction = database.transaction(() => {
      for (const record of migration.records) {
        const row = record.row;
        const id = requiredString(row?.id, 'thread row id');
        if (id !== record.threadId)
          throw new Error(`thread id mismatch in record ${record.threadId}`);
        const existing = existingThread.get(id);
        if (existing !== undefined) {
          if (existing.rollout_path !== row.rollout_path || existing.cwd !== row.cwd) {
            throw new Error(`target already contains a different thread record: ${id}`);
          }
          alreadyPresent.push(id);
          continue;
        }

        const columns = Object.keys(row);
        const unknownColumns = columns.filter((column) => !targetColumns.has(column));
        const unsafeUnknownColumns = unknownColumns.filter(
          (column) =>
            !compatibleSourceOnlyColumnDefaults.has(column) ||
            row[column] !== compatibleSourceOnlyColumnDefaults.get(column),
        );
        if (unsafeUnknownColumns.length > 0) {
          throw new Error(
            `target thread schema is missing non-default columns: ${unsafeUnknownColumns.join(', ')}`,
          );
        }
        for (const column of unknownColumns) omittedDefaultColumns.add(column);
        const targetRowColumns = columns.filter((column) => targetColumns.has(column));
        const columnSql = targetRowColumns.map(quoteIdentifier).join(', ');
        const placeholderSql = targetRowColumns.map((column) => `@${column}`).join(', ');
        database.prepare(`INSERT INTO threads (${columnSql}) VALUES (${placeholderSql})`).run(row);
        imported.push(id);
      }
    });
    transaction();
    database.pragma('wal_checkpoint(TRUNCATE)');
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode,
        imported,
        alreadyPresent,
        omittedDefaultColumns: [...omittedDefaultColumns].sort(),
        verified: migration.records.length,
      })}\n`,
    );
  } finally {
    database.close();
  }
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function requiredAbsolutePath(values, key) {
  const value = requiredString(values[key], `--${key}`);
  if (!isAbsolute(value)) throw new Error(`--${key} must be an absolute path`);
  return resolve(value);
}

function safeRelativePath(root, path, label) {
  const value = relative(resolve(root), resolve(root, path));
  if (
    value.length === 0 ||
    value === '..' ||
    value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`${label} must be located below ${resolve(root)}`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
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
  return {
    bytes: metadata.size,
    sha256: hash.digest('hex'),
  };
}
