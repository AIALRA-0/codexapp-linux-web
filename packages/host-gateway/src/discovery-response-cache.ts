import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;
const MEBIBYTE = 1024 * 1024;
const DEFAULT_EVICTION_TARGET_BYTES = 48 * MEBIBYTE;
const DEFAULT_MAX_BYTES = 64 * MEBIBYTE;
const DEFAULT_MAX_ENTRY_BYTES = 8 * MEBIBYTE;

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

interface DiscoveryResponseCacheStoreOptions {
  evictionTargetBytes?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  now?: () => number;
}

interface StoredDiscoveryResponseRow {
  expires_at: number;
  result_json: string;
}

interface StoredDiscoveryResponseSizeRow {
  total_bytes: number;
}

interface EvictionCandidateRow {
  cache_key: string;
  payload_bytes: number;
  principal_key: string;
}

export interface DiscoveryResponseCacheEntry {
  expiresAtMs: number;
  result: unknown;
}

export class DiscoveryResponseCacheStore {
  readonly #database: SqliteDatabase;
  readonly #evictionTargetBytes: number;
  readonly #maxBytes: number;
  readonly #maxEntryBytes: number;
  readonly #now: () => number;

  constructor(databasePath: string, options: DiscoveryResponseCacheStoreOptions = {}) {
    this.#evictionTargetBytes = options.evictionTargetBytes ?? DEFAULT_EVICTION_TARGET_BYTES;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
    this.#now = options.now ?? Date.now;
    if (this.#evictionTargetBytes > this.#maxBytes) {
      throw new Error('Discovery cache eviction target exceeds its maximum');
    }
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new Sqlite(databasePath);
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  read(principalKey: string, cacheKey: string): DiscoveryResponseCacheEntry | null {
    nonEmptyKey(principalKey, 'principal');
    nonEmptyKey(cacheKey, 'response');
    const row = this.#database
      .prepare(
        `SELECT expires_at, result_json
         FROM renderer_discovery_cache
         WHERE principal_key = ? AND cache_key = ?`,
      )
      .get(principalKey, cacheKey) as StoredDiscoveryResponseRow | undefined;
    if (row === undefined) return null;
    const now = this.#now();
    if (row.expires_at <= now) {
      this.#delete(principalKey, cacheKey);
      return null;
    }
    let result: unknown;
    try {
      result = JSON.parse(row.result_json) as unknown;
    } catch {
      this.#delete(principalKey, cacheKey);
      return null;
    }
    this.#database
      .prepare(
        `UPDATE renderer_discovery_cache SET accessed_at = ?
         WHERE principal_key = ? AND cache_key = ?`,
      )
      .run(now, principalKey, cacheKey);
    return { expiresAtMs: row.expires_at, result };
  }

  write(
    principalKey: string,
    cacheKey: string,
    method: string,
    ttlMs: number,
    result: unknown,
  ): boolean {
    nonEmptyKey(principalKey, 'principal');
    nonEmptyKey(cacheKey, 'response');
    nonEmptyKey(method, 'method');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('Discovery cache TTL is invalid');
    }
    const resultJson = JSON.stringify(result);
    if (resultJson === undefined) return false;
    const payloadBytes = Buffer.byteLength(resultJson);
    if (payloadBytes > this.#maxEntryBytes) return false;
    const now = this.#now();
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO renderer_discovery_cache (
             principal_key, cache_key, method, expires_at, accessed_at,
             payload_bytes, result_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(principal_key, cache_key) DO UPDATE SET
             method = excluded.method,
             expires_at = excluded.expires_at,
             accessed_at = excluded.accessed_at,
             payload_bytes = excluded.payload_bytes,
             result_json = excluded.result_json`,
        )
        .run(principalKey, cacheKey, method, now + ttlMs, now, payloadBytes, resultJson);
      this.#runMaintenance(now);
    });
    return true;
  }

  invalidate(prefixes: readonly string[]): void {
    if (prefixes.length === 0) return;
    this.#transaction(() => {
      for (const prefix of prefixes) {
        if (prefix.length === 0) {
          this.#database.prepare('DELETE FROM renderer_discovery_cache').run();
        } else {
          this.#database
            .prepare(
              `DELETE FROM renderer_discovery_cache
               WHERE substr(method, 1, ?) = ?`,
            )
            .run(prefix.length, prefix);
        }
      }
    });
  }

  #delete(principalKey: string, cacheKey: string): void {
    this.#database
      .prepare(
        `DELETE FROM renderer_discovery_cache
         WHERE principal_key = ? AND cache_key = ?`,
      )
      .run(principalKey, cacheKey);
  }

  #migrate(): void {
    const currentVersion =
      (this.#database.prepare('PRAGMA user_version').get()?.user_version as number | undefined) ??
      0;
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(`Discovery cache schema ${String(currentVersion)} is newer than supported`);
    }
    if (currentVersion === SCHEMA_VERSION) return;
    this.#transaction(() => {
      this.#database.exec(`
        DROP TABLE IF EXISTS renderer_discovery_cache;
        CREATE TABLE renderer_discovery_cache (
          principal_key TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          method TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
          result_json TEXT NOT NULL,
          PRIMARY KEY (principal_key, cache_key)
        );
        CREATE INDEX renderer_discovery_cache_access_idx
          ON renderer_discovery_cache (accessed_at);
        CREATE INDEX renderer_discovery_cache_method_idx
          ON renderer_discovery_cache (method);
        PRAGMA user_version = 1;
      `);
    });
  }

  #runMaintenance(now: number): void {
    this.#database.prepare('DELETE FROM renderer_discovery_cache WHERE expires_at <= ?').run(now);
    let totalBytes =
      (
        this.#database
          .prepare(
            'SELECT COALESCE(SUM(payload_bytes), 0) AS total_bytes FROM renderer_discovery_cache',
          )
          .get() as StoredDiscoveryResponseSizeRow | undefined
      )?.total_bytes ?? 0;
    if (totalBytes <= this.#maxBytes) return;
    const candidates = this.#database
      .prepare(
        `SELECT principal_key, cache_key, payload_bytes
         FROM renderer_discovery_cache ORDER BY accessed_at`,
      )
      .all() as unknown as EvictionCandidateRow[];
    for (const candidate of candidates) {
      this.#delete(candidate.principal_key, candidate.cache_key);
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

function nonEmptyKey(value: string, label: string): void {
  if (value.length === 0) throw new Error(`Discovery cache ${label} key is empty`);
}
