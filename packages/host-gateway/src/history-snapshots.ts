import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { RpcTarget } from 'capnweb';

import { RpcSubscription } from './realtime-voice.js';

const SCHEMA_VERSION = 2;
const MEBIBYTE = 1024 * 1024;
const DEFAULT_EVICTION_TARGET_BYTES = 160 * MEBIBYTE;
const DEFAULT_MAX_BYTES = 200 * MEBIBYTE;
const DEFAULT_MAX_THREAD_BYTES = MEBIBYTE;
const DEFAULT_TTL_MS = 720 * 60 * 60 * 1_000;

interface SqliteStatement {
  all(...parameters: unknown[]): Array<Record<string, unknown>>;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  run(...parameters: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface SqliteDatabaseConstructor {
  new (path: string): SqliteDatabase;
}

const require = createRequire(import.meta.url);
const Sqlite = require('better-sqlite3') as SqliteDatabaseConstructor;

export interface HistorySnapshotPrincipal {
  accountId: string;
  userId: string;
}

interface HistorySnapshotStoreOptions {
  evictionTargetBytes?: number;
  maxBytes?: number;
  maxThreadBytes?: number;
  now?: () => number;
  ttlMs?: number;
}

interface StoredSnapshotRow {
  accessed_at: number;
  payload_json: string;
}

interface StoredSnapshotSizeRow {
  total_bytes: number;
}

interface EvictionCandidateRow {
  host_id: string;
  payload_bytes: number;
  principal_key: string;
  thread_id: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function snapshotThreadId(payload: string, expectedThreadId?: string): string | null {
  try {
    const parsed = record(JSON.parse(payload));
    if (
      parsed?.version !== 2 ||
      typeof parsed.threadId !== 'string' ||
      parsed.threadId.length === 0 ||
      record(parsed.threadSummary) === null ||
      typeof parsed.truncatedBefore !== 'boolean' ||
      !Array.isArray(parsed.turns)
    ) {
      return null;
    }
    return expectedThreadId === undefined || parsed.threadId === expectedThreadId
      ? parsed.threadId
      : null;
  } catch {
    return null;
  }
}

function nonEmptyKey(value: string, label: string): void {
  if (value.length === 0) throw new Error(`History cache ${label} key is empty`);
}

export class AppServerHistorySnapshotStore {
  readonly #database: SqliteDatabase;
  readonly #evictionTargetBytes: number;
  readonly #maxBytes: number;
  readonly #maxThreadBytes: number;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(databasePath: string, options: HistorySnapshotStoreOptions = {}) {
    this.#evictionTargetBytes = options.evictionTargetBytes ?? DEFAULT_EVICTION_TARGET_BYTES;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxThreadBytes = options.maxThreadBytes ?? DEFAULT_MAX_THREAD_BYTES;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (this.#evictionTargetBytes > this.#maxBytes) {
      throw new Error('History cache eviction target exceeds its maximum');
    }
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new Sqlite(databasePath);
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  write(principalKey: string, hostId: string, payload: string): void {
    nonEmptyKey(principalKey, 'principal');
    nonEmptyKey(hostId, 'host');
    const threadId = snapshotThreadId(payload);
    if (threadId === null) throw new Error('History snapshot payload is invalid');
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > this.#maxThreadBytes) {
      throw new Error('History snapshot exceeds the per-thread limit');
    }
    const now = this.#now();
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO app_server_history_snapshots (
             principal_key, host_id, thread_id, accessed_at,
             payload_bytes, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(principal_key, host_id, thread_id) DO UPDATE SET
             accessed_at = excluded.accessed_at,
             payload_bytes = excluded.payload_bytes,
             payload_json = excluded.payload_json`,
        )
        .run(principalKey, hostId, threadId, now, payloadBytes, payload);
      this.#runMaintenance(now);
    });
  }

  read(principalKey: string, hostId: string, threadId: string): string | null {
    const row = this.#database
      .prepare(
        `SELECT accessed_at, payload_json
         FROM app_server_history_snapshots
         WHERE principal_key = ? AND host_id = ? AND thread_id = ?`,
      )
      .get(principalKey, hostId, threadId) as StoredSnapshotRow | undefined;
    if (row === undefined) return null;
    const now = this.#now();
    if (
      row.accessed_at < now - this.#ttlMs ||
      snapshotThreadId(row.payload_json, threadId) === null
    ) {
      this.delete(principalKey, hostId, threadId);
      return null;
    }
    this.#database
      .prepare(
        `UPDATE app_server_history_snapshots SET accessed_at = ?
         WHERE principal_key = ? AND host_id = ? AND thread_id = ?`,
      )
      .run(now, principalKey, hostId, threadId);
    return row.payload_json;
  }

  delete(principalKey: string, hostId: string, threadId: string): void {
    this.#database
      .prepare(
        `DELETE FROM app_server_history_snapshots
         WHERE principal_key = ? AND host_id = ? AND thread_id = ?`,
      )
      .run(principalKey, hostId, threadId);
  }

  deleteHostThread(hostId: string, threadId: string): void {
    nonEmptyKey(hostId, 'host');
    nonEmptyKey(threadId, 'thread');
    this.#database
      .prepare(
        `DELETE FROM app_server_history_snapshots
         WHERE host_id = ? AND thread_id = ?`,
      )
      .run(hostId, threadId);
  }

  #migrate(): void {
    const currentVersion =
      (this.#database.prepare('PRAGMA user_version').get()?.user_version as number | undefined) ??
      0;
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(`History cache schema ${String(currentVersion)} is newer than supported`);
    }
    if (currentVersion === SCHEMA_VERSION) return;
    this.#transaction(() => {
      this.#database.exec(`
        DROP TABLE IF EXISTS app_server_history_snapshots;
        CREATE TABLE app_server_history_snapshots (
          principal_key TEXT NOT NULL,
          host_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          accessed_at INTEGER NOT NULL,
          payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
          payload_json TEXT NOT NULL,
          PRIMARY KEY (principal_key, host_id, thread_id)
        );
        CREATE INDEX app_server_history_snapshots_access_idx
          ON app_server_history_snapshots (accessed_at);
        PRAGMA user_version = 2;
      `);
    });
  }

  #runMaintenance(now: number): void {
    this.#database
      .prepare('DELETE FROM app_server_history_snapshots WHERE accessed_at < ?')
      .run(now - this.#ttlMs);
    let totalBytes =
      (
        this.#database
          .prepare(
            'SELECT COALESCE(SUM(payload_bytes), 0) AS total_bytes FROM app_server_history_snapshots',
          )
          .get() as StoredSnapshotSizeRow | undefined
      )?.total_bytes ?? 0;
    if (totalBytes <= this.#maxBytes) return;
    const candidates = this.#database
      .prepare(
        `SELECT principal_key, host_id, thread_id, payload_bytes
         FROM app_server_history_snapshots ORDER BY accessed_at`,
      )
      .all() as unknown as EvictionCandidateRow[];
    for (const candidate of candidates) {
      this.delete(candidate.principal_key, candidate.host_id, candidate.thread_id);
      totalBytes -= candidate.payload_bytes;
      if (totalBytes <= this.#evictionTargetBytes) return;
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.prepare('BEGIN IMMEDIATE').run();
    try {
      const result = operation();
      this.#database.prepare('COMMIT').run();
      return result;
    } catch (error) {
      this.#database.prepare('ROLLBACK').run();
      throw error;
    }
  }
}

type RemoteInvalidationListener = (() => unknown) & {
  dup?: () => RemoteInvalidationListener;
  onRpcBroken?: (callback: () => void) => void;
  [Symbol.dispose]?: () => void;
};

interface AppServerHistorySnapshotsServiceOptions {
  getPrincipal: () => Promise<HistorySnapshotPrincipal | null>;
  onOperation?: (method: 'delete' | 'lease' | 'read' | 'write', durationMs: number) => void;
  store: AppServerHistorySnapshotStore;
}

export class AppServerHistorySnapshotsService extends RpcTarget {
  readonly #getPrincipal: () => Promise<HistorySnapshotPrincipal | null>;
  readonly #onOperation: NonNullable<AppServerHistorySnapshotsServiceOptions['onOperation']>;
  readonly #store: AppServerHistorySnapshotStore;
  readonly #authorizationLeases = new Map<string, string>();
  readonly #invalidationListeners = new Map<string, Set<RemoteInvalidationListener>>();
  #principalKey: string | null = null;

  constructor(options: AppServerHistorySnapshotsServiceOptions) {
    super();
    this.#getPrincipal = options.getPrincipal;
    this.#store = options.store;
    this.#onOperation = options.onOperation ?? (() => undefined);
  }

  acquireAuthorizationLease(hostId: string): Promise<unknown> {
    return this.#measure('lease', () =>
      this.#runAuthorized(hostId, null, () => this.#getAuthorizationLease(hostId)),
    );
  }

  subscribeAuthorizationLeaseInvalidation(hostId: string, listenerValue: unknown): RpcSubscription {
    if (typeof listenerValue !== 'function') {
      throw new TypeError('history snapshot invalidation listener must be callable');
    }
    const supplied = listenerValue as RemoteInvalidationListener;
    const listener = supplied.dup?.() ?? supplied;
    const listeners = this.#invalidationListeners.get(hostId) ?? new Set();
    listeners.add(listener);
    this.#invalidationListeners.set(hostId, listeners);
    const subscription = new RpcSubscription(() => {
      if (!listeners.delete(listener)) return;
      listener[Symbol.dispose]?.();
      if (listeners.size === 0) this.#invalidationListeners.delete(hostId);
    });
    listener.onRpcBroken?.(() => subscription.unsubscribe());
    return subscription;
  }

  read(hostId: string, lease: string, threadId: string): Promise<unknown> {
    return this.#measure('read', () =>
      this.#runAuthorized(hostId, lease, (principalKey, hostKey) =>
        this.#store.read(principalKey, hostKey, threadId),
      ),
    );
  }

  write(hostId: string, lease: string, payload: string): Promise<unknown> {
    return this.#measure('write', () =>
      this.#runAuthorized(hostId, lease, (principalKey, hostKey) => {
        this.#store.write(principalKey, hostKey, payload);
      }),
    );
  }

  delete(hostId: string, lease: string, threadId: string): Promise<unknown> {
    return this.#measure('delete', () =>
      this.#runAuthorized(hostId, lease, (principalKey, hostKey) => {
        this.#store.delete(principalKey, hostKey, threadId);
      }),
    );
  }

  invalidate(): void {
    this.#principalKey = null;
    for (const hostId of this.#authorizationLeases.keys()) this.#invalidateHost(hostId);
  }

  async #measure(method: 'delete' | 'lease' | 'read' | 'write', operation: () => Promise<unknown>) {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.#onOperation(method, performance.now() - startedAt);
    }
  }

  async #runAuthorized<T>(
    hostId: string,
    suppliedLease: string | null,
    operation: (principalKey: string, hostKey: string) => T,
  ): Promise<{ status: 'ok'; value: T } | { status: 'unavailable' }> {
    const hostKey = hostId === 'local' ? 'local' : null;
    if (hostKey === null) return { status: 'unavailable' };
    const lease = this.#getAuthorizationLease(hostId);
    if (suppliedLease !== null && suppliedLease !== lease) return { status: 'unavailable' };
    try {
      const principal = await this.#getPrincipal();
      if (principal === null) {
        if (this.#principalKey !== null) this.invalidate();
        return { status: 'unavailable' };
      }
      const principalKey = createHash('sha256')
        .update(`${principal.userId}\0${principal.accountId}`)
        .digest('hex');
      if (this.#principalKey !== null && this.#principalKey !== principalKey) {
        this.invalidate();
        this.#principalKey = principalKey;
        return { status: 'unavailable' };
      }
      this.#principalKey = principalKey;
      if (lease !== this.#getAuthorizationLease(hostId)) return { status: 'unavailable' };
      return { status: 'ok', value: operation(principalKey, hostKey) };
    } catch {
      return { status: 'unavailable' };
    }
  }

  #getAuthorizationLease(hostId: string): string {
    const existing = this.#authorizationLeases.get(hostId);
    if (existing !== undefined) return existing;
    const lease = randomUUID();
    this.#authorizationLeases.set(hostId, lease);
    return lease;
  }

  #invalidateHost(hostId: string): void {
    this.#authorizationLeases.delete(hostId);
    for (const listener of this.#invalidationListeners.get(hostId) ?? []) {
      try {
        const result = listener();
        if (result instanceof Promise) void result.catch(() => undefined);
      } catch {
        // A broken remote listener must not prevent the remaining listeners.
      }
    }
  }
}
