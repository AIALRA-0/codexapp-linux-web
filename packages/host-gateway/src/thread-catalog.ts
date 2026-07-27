import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import type { CodexAppServerClient } from '@codexapp/app-server-client';

const PAGE_LIMIT = 100;
const MAX_CATALOG_ENTRIES = 50_000;
const PERSISTED_FORMAT_VERSION = 1;
const CURSOR_VERSION = 2;

interface OfficialSharedModule {
  Fi: unknown[];
  o: (thread: unknown, hostId: string) => unknown;
}

export interface ThreadCatalogEntry {
  hostId: string;
  threadId: string;
  displayTitle: string;
  sourceCreatedAt: number;
  sourceUpdatedAt: number;
  cwd: string;
  sourceKind: string;
  sourceDetail: unknown;
  threadSource: unknown;
  modelProvider: unknown;
  gitBranch: string | null;
}

export interface ThreadCatalogSnapshot {
  revision: number;
  isComplete: boolean;
  hosts: Array<{ hostId: string; isComplete: boolean }>;
  entries: ThreadCatalogEntry[];
}

export interface ThreadCatalogStatus {
  revision: number;
  populationEnabled: boolean;
  hosts: Array<{ hostId: string; isComplete: boolean; revision: number }>;
}

interface PersistedCatalog {
  formatVersion: typeof PERSISTED_FORMAT_VERSION;
  revision: number;
  isComplete: boolean;
  entries: ThreadCatalogEntry[];
}

interface SortedCatalog {
  revision: number;
  entries: ThreadCatalogEntry[];
  indexByThreadId: Map<string, number>;
}

interface ThreadListResponse {
  data: unknown[];
  nextCursor: string | null;
}

interface CatalogCursor {
  version: typeof CURSOR_VERSION;
  hostId: string;
  filterFingerprint: string;
  sortKey: 'created_at' | 'updated_at';
  sourceUpdatedAt: number;
  sourceCreatedAt: number;
  threadId: string;
}

interface CatalogFilter {
  includeAll: boolean;
  cwdValues: string[];
  cwdPrefixes: string[];
  includeThreadIds: string[];
  excludeThreadIds: string[];
}

interface ManualOrder {
  threadIds: string[];
  startIndex: number;
}

interface ReadPageRequest {
  hostId: 'local';
  cursor: string | null;
  filter: CatalogFilter | null;
  limit: number;
  manualOrder: ManualOrder | null;
  sortKey: 'created_at' | 'updated_at';
}

interface CatalogOptions {
  sourceRoot: string;
  loadPersisted: () => unknown;
  persist: (value: PersistedCatalog) => Promise<void>;
  onError: (error: Error) => void;
  loadOfficialShared?: () => OfficialSharedModule;
}

const require = createRequire(import.meta.url);

export class OfficialThreadCatalog {
  readonly sourceRoot: string;
  #loadPersisted: () => unknown;
  #persist: (value: PersistedCatalog) => Promise<void>;
  #onError: (error: Error) => void;
  #loadOfficialShared: (() => OfficialSharedModule) | undefined;
  #client: CodexAppServerClient | undefined;
  #convertThread: OfficialSharedModule['o'] | undefined;
  #sourceKinds: unknown[] = [];
  #entries = new Map<string, ThreadCatalogEntry>();
  #sortedCatalogs = new Map<'created_at' | 'updated_at', SortedCatalog>();
  #revision = 0;
  #isComplete = false;
  #populationEnabled = false;
  #loaded = false;
  #stopped = false;
  #refreshPromise: Promise<void> | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #listeners = new Set<(update: unknown) => void>();
  #statusListeners = new Set<(status: ThreadCatalogStatus) => void>();

  constructor(options: CatalogOptions) {
    this.sourceRoot = resolve(options.sourceRoot);
    this.#loadPersisted = options.loadPersisted;
    this.#persist = options.persist;
    this.#onError = options.onError;
    this.#loadOfficialShared = options.loadOfficialShared;
  }

  load(): void {
    if (this.#loaded) return;
    let cached: PersistedCatalog | null = null;
    try {
      cached = parsePersistedCatalog(this.#loadPersisted());
    } catch (error) {
      this.#reportError(error);
    }
    if (cached !== null) {
      this.#revision = cached.revision;
      this.#isComplete = cached.isComplete;
      this.#entries = new Map(cached.entries.map((entry) => [entry.threadId, entry]));
    }
    this.#loaded = true;
  }

  async start(client: CodexAppServerClient): Promise<void> {
    if (!this.#loaded) throw new Error('Thread catalog must be loaded before it starts');
    if (this.#stopped) throw new Error('Thread catalog is stopped');
    this.#client = client;
    const sharedPath = join(this.sourceRoot, '.vite', 'build', 'src-DChWimf7.js');
    const shared =
      this.#loadOfficialShared?.() ?? (require(sharedPath) as Partial<OfficialSharedModule>);
    if (typeof shared.o !== 'function' || !Array.isArray(shared.Fi)) {
      throw new Error('qualified official thread catalog exports changed');
    }
    this.#convertThread = shared.o;
    this.#sourceKinds = [...shared.Fi];
    if (this.#entries.size === 0) {
      try {
        await this.#scan(true);
      } catch (error) {
        this.#reportError(error);
      }
    }
    this.scheduleRefresh(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    this.#listeners.clear();
    this.#statusListeners.clear();
    this.#client = undefined;
  }

  readSnapshot(): ThreadCatalogSnapshot {
    this.#assertLoaded();
    return {
      revision: this.#revision,
      isComplete: this.#isComplete,
      hosts: [{ hostId: 'local', isComplete: this.#isComplete }],
      entries: [...this.#sortedCatalog('updated_at').entries],
    };
  }

  readBootstrapSnapshot(limit = PAGE_LIMIT): ThreadCatalogSnapshot {
    this.#assertLoaded();
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) {
      throw new Error(`Thread catalog bootstrap limit must be between 1 and ${PAGE_LIMIT}`);
    }
    const entries = this.#sortedCatalog('updated_at').entries;
    const isComplete = this.#isComplete && entries.length <= limit;
    return {
      revision: this.#revision,
      isComplete,
      hosts: [{ hostId: 'local', isComplete }],
      entries: entries.slice(0, limit),
    };
  }

  readStatus(): ThreadCatalogStatus {
    this.#assertLoaded();
    return {
      revision: this.#revision,
      populationEnabled: this.#populationEnabled,
      hosts: [
        {
          hostId: 'local',
          isComplete: this.#isComplete,
          revision: this.#revision,
        },
      ],
    };
  }

  readPage(value: unknown): Record<string, unknown> {
    const request = parseReadPageRequest(value);
    const filterFingerprint = fingerprintFilter(request.filter);
    if (request.manualOrder !== null) {
      if (request.cursor !== null) {
        throw new Error('Manual thread catalog pages do not use a cursor');
      }
      const page: ThreadCatalogEntry[] = [];
      let index = request.manualOrder.startIndex;
      for (
        ;
        index < request.manualOrder.threadIds.length && page.length < request.limit;
        index += 1
      ) {
        const threadId = request.manualOrder.threadIds[index];
        if (threadId === undefined) continue;
        const entry = this.#entries.get(threadId);
        if (entry !== undefined && entryMatchesFilter(entry, request.filter)) page.push(entry);
      }
      return {
        entries: page,
        nextCursor: null,
        ...(index < request.manualOrder.threadIds.length ? { nextManualIndex: index } : {}),
      };
    }

    const sorted = this.#sortedCatalog(request.sortKey);
    const entries =
      request.filter === null
        ? sorted.entries
        : sorted.entries.filter((entry) => entryMatchesFilter(entry, request.filter));
    let startIndex = 0;
    if (request.cursor !== null) {
      const cursor = parseCursor(request.cursor);
      if (cursor.hostId !== request.hostId) {
        throw new Error('Thread catalog cursor belongs to another host');
      }
      if (cursor.filterFingerprint !== filterFingerprint) {
        throw new Error('Thread catalog cursor uses a different filter');
      }
      if (cursor.sortKey !== request.sortKey) {
        throw new Error('Thread catalog cursor uses a different sort order');
      }
      const exactIndex =
        request.filter === null
          ? (sorted.indexByThreadId.get(cursor.threadId) ?? -1)
          : entries.findIndex((entry) => entry.threadId === cursor.threadId);
      startIndex =
        exactIndex >= 0
          ? exactIndex + 1
          : entries.findIndex((entry) => compareEntryToCursor(entry, cursor) > 0);
      if (startIndex < 0) startIndex = entries.length;
    }
    const page = entries.slice(startIndex, startIndex + request.limit);
    const last = page.at(-1);
    return {
      entries: page,
      nextCursor:
        last === undefined || startIndex + page.length >= entries.length
          ? null
          : encodeCursor({
              version: CURSOR_VERSION,
              hostId: 'local',
              filterFingerprint,
              sortKey: request.sortKey,
              sourceUpdatedAt: last.sourceUpdatedAt,
              sourceCreatedAt: last.sourceCreatedAt,
              threadId: last.threadId,
            }),
    };
  }

  readEntries(value: unknown): ThreadCatalogEntry[] {
    if (!Array.isArray(value) || value.length > 100) {
      throw new Error('Thread catalog entry request exceeds 100');
    }
    return value.flatMap((item) => {
      const reference = parseThreadReference(item);
      const entry = this.#entries.get(reference.threadId);
      return entry === undefined ? [] : [entry];
    });
  }

  async removeMissingEntry(value: unknown): Promise<boolean> {
    const reference = parseThreadReference(value);
    const entry = this.#entries.get(reference.threadId);
    if (entry === undefined) return true;
    try {
      await this.#requireClient().request(
        'thread/read',
        { threadId: reference.threadId, includeTurns: false },
        30_000,
      );
      return false;
    } catch (error) {
      if (!isMissingThreadError(error)) throw error;
      this.#entries.delete(reference.threadId);
      await this.#commit(true);
      return true;
    }
  }

  subscribe(listener: (update: unknown) => void): () => void {
    this.#listeners.add(listener);
    listener({ type: 'snapshot', snapshot: this.readSnapshot() });
    return () => this.#listeners.delete(listener);
  }

  subscribeStatus(listener: (status: ThreadCatalogStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.readStatus());
    return () => this.#statusListeners.delete(listener);
  }

  setPopulationEnabled(enabled: boolean): void {
    if (this.#populationEnabled === enabled) return;
    this.#populationEnabled = enabled;
    this.#publishStatus();
    if (enabled) this.scheduleRefresh(0);
  }

  async requestSync(hostIdsValue?: unknown): Promise<ThreadCatalogStatus> {
    if (hostIdsValue !== undefined && hostIdsValue !== null) {
      if (!Array.isArray(hostIdsValue) || hostIdsValue.some((value) => value !== 'local')) {
        throw new Error('Thread catalog sync host list is invalid');
      }
      if (!hostIdsValue.includes('local')) return this.readStatus();
    }
    await this.#refresh();
    return this.readStatus();
  }

  async requestStartupSync(): Promise<void> {
    await this.#refresh();
  }

  handleNotification(value: unknown): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const notification = value as Record<string, unknown>;
    if (typeof notification.method !== 'string' || !notification.method.startsWith('thread/')) {
      if (notification.method === 'turn/completed') this.scheduleRefresh(100);
      return;
    }
    if (
      notification.method === 'thread/archived' &&
      notification.params !== null &&
      typeof notification.params === 'object' &&
      !Array.isArray(notification.params)
    ) {
      const threadId = (notification.params as Record<string, unknown>).threadId;
      if (typeof threadId === 'string' && this.#entries.delete(threadId)) {
        void this.#commit(true).catch((error: unknown) => this.#reportError(error));
      }
      return;
    }
    this.scheduleRefresh(100);
  }

  scheduleRefresh(delayMs = 250): void {
    if (this.#stopped || this.#client === undefined) return;
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.#refresh().catch((error: unknown) => this.#reportError(error));
    }, delayMs);
    this.#refreshTimer.unref();
  }

  async #refresh(): Promise<void> {
    if (this.#refreshPromise !== undefined) return this.#refreshPromise;
    this.#refreshPromise = this.#scan(false);
    try {
      await this.#refreshPromise;
    } finally {
      this.#refreshPromise = undefined;
    }
  }

  async #scan(firstPageOnly: boolean): Promise<void> {
    const client = this.#requireClient();
    const convertThread = this.#convertThread;
    if (convertThread === undefined) throw new Error('official thread converter is unavailable');
    const scanned = new Map<string, ThreadCatalogEntry>();
    let cursor: string | null = null;
    const observedCursors = new Set<string>();
    do {
      const response = parseThreadListResponse(
        await client.request(
          'thread/list',
          {
            archived: false,
            cursor,
            limit: PAGE_LIMIT,
            parentThreadId: null,
            sortKey: 'updated_at',
            sortDirection: 'desc',
            sourceKinds: this.#sourceKinds,
            useStateDbOnly: true,
          },
          30_000,
        ),
      );
      for (const thread of response.data) {
        const converted = parseCatalogEntry(convertThread(thread, 'local'));
        if (converted !== null) scanned.set(converted.threadId, converted);
        if (scanned.size > MAX_CATALOG_ENTRIES) {
          throw new Error(`Thread catalog exceeds ${MAX_CATALOG_ENTRIES} entries`);
        }
      }
      cursor = response.nextCursor;
      if (firstPageOnly) break;
      if (cursor !== null && observedCursors.has(cursor)) {
        throw new Error('app-server repeated a thread catalog cursor');
      }
      if (cursor !== null) observedCursors.add(cursor);
    } while (cursor !== null);

    if (firstPageOnly) {
      for (const [threadId, entry] of scanned) this.#entries.set(threadId, entry);
      this.#isComplete = cursor === null;
    } else {
      this.#entries = scanned;
      this.#isComplete = true;
    }
    await this.#commit(true);
  }

  async #commit(publish: boolean): Promise<void> {
    this.#revision += 1;
    const persisted: PersistedCatalog = {
      formatVersion: PERSISTED_FORMAT_VERSION,
      revision: this.#revision,
      isComplete: this.#isComplete,
      entries: [...this.#sortedCatalog('updated_at').entries],
    };
    await this.#persist(persisted);
    if (publish) {
      const update = { type: 'snapshot', snapshot: this.readSnapshot() };
      for (const listener of this.#listeners) listener(update);
      this.#publishStatus();
    }
  }

  #sortedCatalog(sortKey: 'created_at' | 'updated_at'): SortedCatalog {
    const cached = this.#sortedCatalogs.get(sortKey);
    if (cached?.revision === this.#revision) return cached;
    const entries = [...this.#entries.values()];
    entries.sort((left, right) => compareEntries(left, right, sortKey));
    const sorted = {
      revision: this.#revision,
      entries,
      indexByThreadId: new Map(entries.map((entry, index) => [entry.threadId, index])),
    };
    this.#sortedCatalogs.set(sortKey, sorted);
    return sorted;
  }

  #publishStatus(): void {
    const status = this.readStatus();
    for (const listener of this.#statusListeners) listener(status);
  }

  #requireClient(): CodexAppServerClient {
    if (this.#client === undefined) throw new Error('Thread catalog app-server is unavailable');
    return this.#client;
  }

  #reportError(error: unknown): void {
    this.#onError(error instanceof Error ? error : new Error('Unknown thread catalog failure'));
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error('Thread catalog is not loaded');
  }
}

function parseThreadListResponse(value: unknown): ThreadListResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('app-server returned an invalid thread list');
  }
  const response = value as Record<string, unknown>;
  if (
    !Array.isArray(response.data) ||
    (response.nextCursor !== null && typeof response.nextCursor !== 'string')
  ) {
    throw new Error('app-server returned an invalid thread list');
  }
  return { data: response.data, nextCursor: response.nextCursor };
}

function parseCatalogEntry(value: unknown): ThreadCatalogEntry | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('official thread converter returned an invalid entry');
  }
  const entry = value as Record<string, unknown>;
  if (
    entry.hostId !== 'local' ||
    typeof entry.threadId !== 'string' ||
    entry.threadId.length === 0 ||
    typeof entry.displayTitle !== 'string' ||
    !Number.isFinite(entry.sourceCreatedAt) ||
    !Number.isFinite(entry.sourceUpdatedAt) ||
    typeof entry.cwd !== 'string' ||
    typeof entry.sourceKind !== 'string' ||
    (entry.gitBranch !== null && typeof entry.gitBranch !== 'string')
  ) {
    throw new Error('official thread converter returned an invalid entry');
  }
  return {
    hostId: 'local',
    threadId: entry.threadId,
    displayTitle: entry.displayTitle,
    sourceCreatedAt: entry.sourceCreatedAt as number,
    sourceUpdatedAt: entry.sourceUpdatedAt as number,
    cwd: entry.cwd,
    sourceKind: entry.sourceKind,
    sourceDetail: entry.sourceDetail,
    threadSource: entry.threadSource,
    modelProvider: entry.modelProvider,
    gitBranch: entry.gitBranch,
  };
}

function parsePersistedCatalog(value: unknown): PersistedCatalog | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid persisted thread catalog');
  }
  const document = value as Record<string, unknown>;
  if (
    document.formatVersion !== PERSISTED_FORMAT_VERSION ||
    !Number.isInteger(document.revision) ||
    (document.revision as number) < 0 ||
    typeof document.isComplete !== 'boolean' ||
    !Array.isArray(document.entries) ||
    document.entries.length > MAX_CATALOG_ENTRIES
  ) {
    throw new Error('invalid persisted thread catalog');
  }
  const entries = document.entries.map((entry) => {
    const parsed = parseCatalogEntry(entry);
    if (parsed === null) throw new Error('persisted thread catalog contains a null entry');
    return parsed;
  });
  return {
    formatVersion: PERSISTED_FORMAT_VERSION,
    revision: document.revision as number,
    isComplete: document.isComplete,
    entries,
  };
}

function parseReadPageRequest(value: unknown): ReadPageRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Thread catalog page request must be an object');
  }
  const request = value as Record<string, unknown>;
  if (request.hostId !== 'local') throw new Error('Unknown thread catalog host');
  if (
    !Number.isInteger(request.limit) ||
    (request.limit as number) < 1 ||
    (request.limit as number) > PAGE_LIMIT
  ) {
    throw new Error(`Thread catalog page limit must be between 1 and ${PAGE_LIMIT}`);
  }
  if (request.sortKey !== 'created_at' && request.sortKey !== 'updated_at') {
    throw new Error('Thread catalog sort order is invalid');
  }
  return {
    hostId: 'local',
    cursor:
      request.cursor === undefined || request.cursor === null
        ? null
        : parseNonEmptyString(request.cursor, 'thread catalog cursor'),
    filter:
      request.filter === undefined || request.filter === null
        ? null
        : parseCatalogFilter(request.filter),
    limit: request.limit as number,
    manualOrder:
      request.manualOrder === undefined || request.manualOrder === null
        ? null
        : parseManualOrder(request.manualOrder),
    sortKey: request.sortKey,
  };
}

function parseCatalogFilter(value: unknown): CatalogFilter {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Thread catalog filter is invalid');
  }
  const filter = value as Record<string, unknown>;
  return {
    includeAll: filter.includeAll === true,
    cwdValues: parseStringArray(filter.cwdValues, 'thread catalog CWD values'),
    cwdPrefixes: parseStringArray(filter.cwdPrefixes, 'thread catalog CWD prefixes'),
    includeThreadIds: parseStringArray(
      filter.includeThreadIds,
      'thread catalog included thread ids',
    ),
    excludeThreadIds: parseStringArray(
      filter.excludeThreadIds,
      'thread catalog excluded thread ids',
    ),
  };
}

function parseManualOrder(value: unknown): ManualOrder {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Manual thread catalog order is invalid');
  }
  const order = value as Record<string, unknown>;
  const threadIds = parseStringArray(order.threadIds, 'manual thread catalog ids');
  if (
    !Number.isInteger(order.startIndex) ||
    (order.startIndex as number) < 0 ||
    (order.startIndex as number) > threadIds.length
  ) {
    throw new Error('Manual thread catalog start index is invalid');
  }
  return { threadIds, startIndex: order.startIndex as number };
}

function parseThreadReference(value: unknown): { hostId: 'local'; threadId: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Thread catalog reference is invalid');
  }
  const reference = value as Record<string, unknown>;
  if (reference.hostId !== 'local') throw new Error('Unknown thread catalog host');
  return {
    hostId: 'local',
    threadId: parseNonEmptyString(reference.threadId, 'thread catalog thread id'),
  };
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = parseNonEmptyString(item, label);
    if (!seen.has(parsed)) {
      seen.add(parsed);
      result.push(parsed);
    }
  }
  return result;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function entryMatchesFilter(entry: ThreadCatalogEntry, filter: CatalogFilter | null): boolean {
  if (filter === null) return true;
  if (filter.excludeThreadIds.includes(entry.threadId)) return false;
  if (filter.includeAll) return true;
  return (
    filter.includeThreadIds.includes(entry.threadId) ||
    filter.cwdValues.includes(entry.cwd) ||
    filter.cwdPrefixes.some((prefix) => entry.cwd.startsWith(prefix))
  );
}

function compareEntries(
  left: ThreadCatalogEntry,
  right: ThreadCatalogEntry,
  sortKey: 'created_at' | 'updated_at',
): number {
  const leftPrimary = sortKey === 'created_at' ? left.sourceCreatedAt : left.sourceUpdatedAt;
  const rightPrimary = sortKey === 'created_at' ? right.sourceCreatedAt : right.sourceUpdatedAt;
  const leftSecondary = sortKey === 'created_at' ? left.sourceUpdatedAt : left.sourceCreatedAt;
  const rightSecondary = sortKey === 'created_at' ? right.sourceUpdatedAt : right.sourceCreatedAt;
  return (
    rightPrimary - leftPrimary ||
    rightSecondary - leftSecondary ||
    left.threadId.localeCompare(right.threadId)
  );
}

function compareEntryToCursor(entry: ThreadCatalogEntry, cursor: CatalogCursor): number {
  const primary = cursor.sortKey === 'created_at' ? entry.sourceCreatedAt : entry.sourceUpdatedAt;
  const cursorPrimary =
    cursor.sortKey === 'created_at' ? cursor.sourceCreatedAt : cursor.sourceUpdatedAt;
  const secondary = cursor.sortKey === 'created_at' ? entry.sourceUpdatedAt : entry.sourceCreatedAt;
  const cursorSecondary =
    cursor.sortKey === 'created_at' ? cursor.sourceUpdatedAt : cursor.sourceCreatedAt;
  if (primary !== cursorPrimary) return cursorPrimary - primary;
  if (secondary !== cursorSecondary) return cursorSecondary - secondary;
  return entry.threadId.localeCompare(cursor.threadId);
}

function fingerprintFilter(filter: CatalogFilter | null): string {
  if (filter === null) return 'all';
  return createHash('sha256').update(JSON.stringify(filter)).digest('base64url');
}

function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function parseCursor(value: string): CatalogCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const cursor = parsed as Record<string, unknown>;
    if (
      cursor.version !== CURSOR_VERSION ||
      cursor.hostId !== 'local' ||
      typeof cursor.filterFingerprint !== 'string' ||
      (cursor.sortKey !== 'created_at' && cursor.sortKey !== 'updated_at') ||
      !Number.isFinite(cursor.sourceUpdatedAt) ||
      !Number.isFinite(cursor.sourceCreatedAt) ||
      typeof cursor.threadId !== 'string' ||
      cursor.threadId.length === 0
    ) {
      throw new Error();
    }
    return cursor as unknown as CatalogCursor;
  } catch {
    throw new Error('Invalid thread catalog cursor');
  }
}

function isMissingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('not found') ||
    message.includes('no rollout found') ||
    message.includes('does not exist')
  );
}
