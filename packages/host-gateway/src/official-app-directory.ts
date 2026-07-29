import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const OFFICIAL_CACHE_NAME = /^[a-f0-9]{40}\.json$/u;
const CURSOR_PREFIX = 'official-app-directory-v1';
const DEFAULT_PAGE_SIZE = 1_000;
const MAX_PAGE_SIZE = 1_000;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CONNECTORS = 10_000;

interface OfficialAppDirectorySnapshot {
  cacheKey: string;
  connectors: Array<Record<string, unknown>>;
  mtimeMs: number;
  path: string;
  size: number;
}

export interface OfficialAppDirectoryPage {
  data: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

export class OfficialAppDirectoryCache {
  readonly codexHome: string;

  #snapshot: OfficialAppDirectorySnapshot | null = null;
  #loading: Promise<OfficialAppDirectorySnapshot | null> | null = null;

  constructor(codexHome: string) {
    this.codexHome = codexHome;
  }

  async list(paramsValue: unknown): Promise<OfficialAppDirectoryPage | null> {
    const params = recordValue(paramsValue);
    if (params.forceRefetch === true) return null;
    const snapshot = await this.#load();
    if (snapshot === null) return null;
    const offset = parseCursor(params.cursor, snapshot.cacheKey);
    if (offset === null) return null;
    const limit = pageSize(params.limit);
    if (limit === 0) return { data: [], nextCursor: null };
    const end = Math.min(snapshot.connectors.length, offset + limit);
    return {
      data: snapshot.connectors.slice(offset, end),
      nextCursor:
        end < snapshot.connectors.length
          ? `${CURSOR_PREFIX}:${snapshot.cacheKey}:${String(end)}`
          : null,
    };
  }

  async #load(): Promise<OfficialAppDirectorySnapshot | null> {
    if (this.#loading !== null) return this.#loading;
    this.#loading = this.#loadCurrent();
    try {
      return await this.#loading;
    } finally {
      this.#loading = null;
    }
  }

  async #loadCurrent(): Promise<OfficialAppDirectorySnapshot | null> {
    const directory = join(this.codexHome, 'cache', 'codex_app_directory');
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => OFFICIAL_CACHE_NAME.test(name));
    } catch {
      return null;
    }
    const candidates = await Promise.all(
      names.map(async (name) => {
        const path = join(directory, name);
        try {
          const details = await stat(path);
          return details.isFile() && details.size > 0 && details.size <= MAX_CACHE_BYTES
            ? { mtimeMs: details.mtimeMs, path, size: details.size }
            : null;
        } catch {
          return null;
        }
      }),
    );
    const candidate = candidates
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
    if (candidate === undefined) return null;
    if (
      this.#snapshot !== null &&
      this.#snapshot.path === candidate.path &&
      this.#snapshot.mtimeMs === candidate.mtimeMs &&
      this.#snapshot.size === candidate.size
    ) {
      return this.#snapshot;
    }
    try {
      const parsed = JSON.parse(await readFile(candidate.path, 'utf8')) as unknown;
      const value = recordValue(parsed);
      if (value.schema_version !== 1 || !Array.isArray(value.connectors)) return null;
      if (
        value.connectors.length === 0 ||
        value.connectors.length > MAX_CONNECTORS ||
        !value.connectors.every(isOfficialAppRecord)
      ) {
        return null;
      }
      this.#snapshot = {
        ...candidate,
        cacheKey: basename(candidate.path, '.json'),
        connectors: value.connectors,
      };
      return this.#snapshot;
    } catch {
      return null;
    }
  }
}

function isOfficialAppRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.name === 'string' &&
    record.name.length > 0
  );
}

function parseCursor(value: unknown, cacheKey: string): number | null {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'string') return null;
  const match = new RegExp(`^${CURSOR_PREFIX}:${cacheKey}:(\\d+)$`, 'u').exec(value);
  if (match === null) return null;
  const offset = Number.parseInt(match[1] ?? '', 10);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}

function pageSize(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || Number(value) < 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Number(value), MAX_PAGE_SIZE);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
