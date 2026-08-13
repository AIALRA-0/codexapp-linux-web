import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  chown,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import Database from 'better-sqlite3';

const compatibleSourceOnlyColumnDefaults = new Map([['is_pinned', 0]]);

const [mode, ...argumentList] = process.argv.slice(2);
const options = parseArguments(argumentList);

if (mode === 'export') {
  await exportRecords(options);
} else if (mode === 'import') {
  await importRecords(options);
} else if (mode === 'sync-existing') {
  await syncExistingRecord(options);
} else {
  throw new Error('usage: migrate-codex-threads.mjs <export|import|sync-existing> [options]');
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

async function syncExistingRecord(values) {
  const sourceHome = requiredAbsolutePath(values, 'source-home');
  const targetHome = requiredAbsolutePath(values, 'target-home');
  const threadId = requiredString(values['thread-id'], '--thread-id');
  const expectedSourceSha256 = optionalString(values['expected-source-sha256']);
  const backupRoot = requiredAbsolutePath(values, 'backup-root');

  const sourceDatabase = new Database(join(sourceHome, 'state_5.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  const targetDatabasePath = join(targetHome, 'state_5.sqlite');
  const targetDatabase = new Database(targetDatabasePath, { fileMustExist: true });
  try {
    const sourceRow = sourceDatabase.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
    const targetRow = targetDatabase.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
    if (sourceRow === undefined) throw new Error(`source thread is missing: ${threadId}`);
    if (targetRow === undefined) throw new Error(`target thread is missing: ${threadId}`);

    const sourceRollout = resolve(requiredString(sourceRow.rollout_path, 'source rollout path'));
    const targetRollout = resolve(requiredString(targetRow.rollout_path, 'target rollout path'));
    safeRelativePath(sourceHome, sourceRollout, 'source rollout path');
    safeRelativePath(targetHome, targetRollout, 'target rollout path');
    const sourceDigest = await fileDigest(sourceRollout);
    if (expectedSourceSha256 !== undefined && sourceDigest.sha256 !== expectedSourceSha256) {
      throw new Error(
        `source rollout digest changed: expected ${expectedSourceSha256}, got ${sourceDigest.sha256}`,
      );
    }

    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const backupRollout = join(backupRoot, 'rollout.jsonl');
    const backupDatabase = join(backupRoot, 'state_5.sqlite');
    await copyFile(targetRollout, backupRollout);
    targetDatabase.pragma('wal_checkpoint(TRUNCATE)');
    await copyFile(targetDatabasePath, backupDatabase);
    const targetBefore = await fileDigest(targetRollout);
    const targetMetadata = await stat(targetRollout);
    const targetDatabaseMetadata = await stat(targetDatabasePath);

    const temporaryRollout = `${targetRollout}.sync-${process.pid}`;
    const normalizedWorkspacePaths = await normalizeRolloutWorkspacePaths(
      sourceRollout,
      temporaryRollout,
      requiredString(sourceRow.cwd, 'source workspace'),
      requiredString(targetRow.cwd, 'target workspace'),
    );
    const copiedDigest = await fileDigest(temporaryRollout);
    await chmod(temporaryRollout, targetMetadata.mode);
    await chown(temporaryRollout, targetMetadata.uid, targetMetadata.gid);
    await rename(temporaryRollout, targetRollout);

    const targetColumns = new Set(
      targetDatabase
        .prepare('PRAGMA table_info(threads)')
        .all()
        .map((column) => column.name),
    );
    const immutableTargetColumns = new Set(['id', 'rollout_path', 'cwd']);
    const updatedColumns = Object.keys(sourceRow).filter(
      (column) => targetColumns.has(column) && !immutableTargetColumns.has(column),
    );
    const assignments = updatedColumns.map((column) => `${quoteIdentifier(column)} = @${column}`);
    const updateValues = Object.fromEntries(
      updatedColumns.map((column) => [column, sourceRow[column]]),
    );
    const transaction = targetDatabase.transaction(() => {
      targetDatabase
        .prepare(`UPDATE threads SET ${assignments.join(', ')} WHERE id = @id`)
        .run({ ...updateValues, id: threadId });
    });
    try {
      transaction();
    } catch (error) {
      const restoreTemporary = `${targetRollout}.restore-${process.pid}`;
      await copyFile(backupRollout, restoreTemporary);
      await rename(restoreTemporary, targetRollout);
      throw error;
    }
    targetDatabase.pragma('wal_checkpoint(TRUNCATE)');
    await restoreDatabaseOwnership(targetDatabasePath, targetDatabaseMetadata);

    const invalidatedCaches = invalidateMigratedThreadCaches(targetHome, threadId);

    const finalDigest = await fileDigest(targetRollout);
    if (finalDigest.sha256 !== copiedDigest.sha256 || finalDigest.bytes !== copiedDigest.bytes) {
      throw new Error('final target rollout digest differs from the normalized copy');
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode,
        threadId,
        backupRoot,
        source: sourceDigest,
        targetBefore,
        targetAfter: finalDigest,
        normalizedWorkspacePaths,
        invalidatedCaches,
        preservedTargetFields: [...immutableTargetColumns].sort(),
        updatedColumns,
      })}\n`,
    );
  } finally {
    sourceDatabase.close();
    targetDatabase.close();
  }
}

function invalidateMigratedThreadCaches(targetHome, threadId) {
  const targetRoot = resolve(targetHome, '..');
  const invalidated = { discoveryResponses: 0, historySnapshots: 0 };
  const discoveryDatabasePath = join(targetRoot, 'codex-discovery-responses.db');
  const historyDatabasePath = join(targetRoot, 'codex-history-snapshots.db');

  try {
    const database = new Database(discoveryDatabasePath, { fileMustExist: true });
    try {
      invalidated.discoveryResponses = Number(
        database
          .prepare(
            `DELETE FROM renderer_discovery_cache
             WHERE method IN ('thread/resume', 'thread/turns/list', 'thread/items/list')`,
          )
          .run().changes,
      );
    } finally {
      database.close();
    }
  } catch (error) {
    if (error?.code !== 'SQLITE_CANTOPEN') throw error;
  }

  try {
    const database = new Database(historyDatabasePath, { fileMustExist: true });
    try {
      invalidated.historySnapshots = Number(
        database
          .prepare('DELETE FROM app_server_history_snapshots WHERE thread_id = ?')
          .run(threadId).changes,
      );
    } finally {
      database.close();
    }
  } catch (error) {
    if (error?.code !== 'SQLITE_CANTOPEN') throw error;
  }

  return invalidated;
}

async function normalizeRolloutWorkspacePaths(
  sourcePath,
  targetPath,
  sourceWorkspace,
  targetWorkspace,
) {
  if (resolve(sourceWorkspace) === resolve(targetWorkspace)) {
    await copyFile(sourcePath, targetPath);
    return 0;
  }
  const input = createReadStream(sourcePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const output = createWriteStream(targetPath, { encoding: 'utf8', flags: 'wx', mode: 0o600 });
  let normalized = 0;
  try {
    for await (const line of lines) {
      if (!line.includes(sourceWorkspace)) {
        if (!output.write(`${line}\n`)) await once(output, 'drain');
        continue;
      }
      const record = JSON.parse(line);
      normalized += rewriteStructuredWorkspacePaths(record, sourceWorkspace, targetWorkspace);
      if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'finish');
    return normalized;
  } catch (error) {
    output.destroy();
    await rm(targetPath, { force: true });
    throw error;
  }
}

function rewriteStructuredWorkspacePaths(value, sourceWorkspace, targetWorkspace, parentKey = '') {
  if (value === null || typeof value !== 'object') return 0;
  let normalized = 0;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (
        parentKey === 'workspace_roots' &&
        typeof entry === 'string' &&
        isWorkspacePath(entry, sourceWorkspace)
      ) {
        value[index] = rewriteWorkspacePath(entry, sourceWorkspace, targetWorkspace);
        normalized += 1;
      } else {
        normalized += rewriteStructuredWorkspacePaths(
          entry,
          sourceWorkspace,
          targetWorkspace,
          parentKey,
        );
      }
    }
    return normalized;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (
      ['cwd', 'workdir', 'path', 'move_path'].includes(key) &&
      typeof entry === 'string' &&
      isWorkspacePath(entry, sourceWorkspace)
    ) {
      value[key] = rewriteWorkspacePath(entry, sourceWorkspace, targetWorkspace);
      normalized += 1;
      continue;
    }
    if (key === 'filesystem' && typeof entry === 'string' && entry.includes(sourceWorkspace)) {
      value[key] = entry.replaceAll(sourceWorkspace, targetWorkspace);
      normalized += 1;
      continue;
    }
    if (key === 'changes' && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      for (const changePath of Object.keys(entry)) {
        if (!isWorkspacePath(changePath, sourceWorkspace)) continue;
        const targetChangePath = rewriteWorkspacePath(changePath, sourceWorkspace, targetWorkspace);
        entry[targetChangePath] = entry[changePath];
        delete entry[changePath];
        normalized += 1;
      }
    }
    normalized += rewriteStructuredWorkspacePaths(entry, sourceWorkspace, targetWorkspace, key);
  }
  return normalized;
}

function isWorkspacePath(value, workspace) {
  return value === workspace || value.startsWith(`${workspace}/`);
}

function rewriteWorkspacePath(value, sourceWorkspace, targetWorkspace) {
  return `${targetWorkspace}${value.slice(sourceWorkspace.length)}`;
}

async function restoreDatabaseOwnership(databasePath, metadata) {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      await chmod(path, metadata.mode);
      await chown(path, metadata.uid, metadata.gid);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
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

function optionalString(value) {
  return value === undefined ? undefined : requiredString(value, 'optional value');
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
