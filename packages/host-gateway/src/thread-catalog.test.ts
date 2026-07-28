import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

import { describe, expect, it, vi } from 'vitest';

import type { CodexAppServerClient } from '@codexapp/app-server-client';

import {
  OfficialThreadCatalog,
  type ThreadCatalogEntry,
  type ThreadCatalogSnapshot,
} from './thread-catalog.js';

function entry(threadId: string, sourceUpdatedAt: number, cwd = '/workspace'): ThreadCatalogEntry {
  return {
    hostId: 'local',
    threadId,
    displayTitle: `Thread ${threadId}`,
    sourceCreatedAt: sourceUpdatedAt - 10,
    sourceUpdatedAt,
    cwd,
    sourceKind: 'cli',
    sourceDetail: null,
    threadSource: 'cli',
    modelProvider: 'openai',
    gitBranch: null,
  };
}

class FakeClient extends EventEmitter {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  #pages: Map<string | null, { data: unknown[]; nextCursor: string | null }>;
  missingThreadIds = new Set<string>();

  constructor(pages: Array<{ cursor: string | null; data: unknown[]; nextCursor: string | null }>) {
    super();
    this.#pages = new Map(pages.map((page) => [page.cursor, page]));
  }

  request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'thread/list') {
      const cursor =
        params !== null &&
        typeof params === 'object' &&
        !Array.isArray(params) &&
        (params as Record<string, unknown>).cursor !== undefined
          ? ((params as Record<string, unknown>).cursor as string | null)
          : null;
      const page = this.#pages.get(cursor);
      if (page === undefined) throw new Error(`Unexpected cursor: ${String(cursor)}`);
      return Promise.resolve({ data: page.data, nextCursor: page.nextCursor });
    }
    if (method === 'thread/read') {
      const threadId = (params as Record<string, unknown>).threadId;
      if (typeof threadId === 'string' && this.missingThreadIds.has(threadId)) {
        throw new Error('thread not found');
      }
      return Promise.resolve({});
    }
    throw new Error(`Unexpected method: ${method}`);
  }
}

function createCatalog(
  options: {
    persisted?: unknown;
    persist?: (value: unknown) => Promise<void>;
    onError?: (error: Error) => void;
  } = {},
): OfficialThreadCatalog {
  return new OfficialThreadCatalog({
    sourceRoot: '/qualified-official-source',
    loadPersisted: () => options.persisted,
    persist: options.persist ?? (() => Promise.resolve()),
    onError: options.onError ?? (() => undefined),
    loadOfficialShared: () => ({
      Fi: [],
      o: (value) => value,
    }),
  });
}

function pageRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostId: 'local',
    cursor: null,
    filter: null,
    limit: 100,
    manualOrder: null,
    sortKey: 'updated_at',
    ...overrides,
  };
}

describe('OfficialThreadCatalog', () => {
  it('warms the first page, then completes a full official app-server scan', async () => {
    const persisted: unknown[] = [];
    const client = new FakeClient([
      { cursor: null, data: [entry('newest', 300), entry('middle', 200)], nextCursor: 'page-2' },
      { cursor: 'page-2', data: [entry('oldest', 100)], nextCursor: null },
    ]);
    const catalog = createCatalog({
      persist: (value) => {
        persisted.push(value);
        return Promise.resolve();
      },
    });
    catalog.load();

    await catalog.start(client as unknown as CodexAppServerClient);

    expect(catalog.readSnapshot()).toMatchObject({
      revision: 1,
      isComplete: false,
      entries: [{ threadId: 'newest' }, { threadId: 'middle' }],
    });
    await catalog.requestStartupSync();
    expect(catalog.readSnapshot()).toMatchObject({
      revision: 2,
      isComplete: true,
      entries: [{ threadId: 'newest' }, { threadId: 'middle' }, { threadId: 'oldest' }],
    });
    expect(client.requests.filter((request) => request.method === 'thread/list')).toHaveLength(3);
    expect(persisted).toHaveLength(2);
    catalog.stop();
  });

  it('restores the durable snapshot and provides cursor, filter, and pinned-order pages', () => {
    const snapshot: ThreadCatalogSnapshot = {
      revision: 7,
      isComplete: true,
      hosts: [{ hostId: 'local', isComplete: true }],
      entries: [entry('alpha', 300, '/workspace/a'), entry('beta', 200, '/workspace/b')],
    };
    const catalog = createCatalog({
      persisted: {
        formatVersion: 1,
        revision: snapshot.revision,
        isComplete: snapshot.isComplete,
        entries: snapshot.entries,
      },
    });
    catalog.load();

    expect(catalog.readSnapshot()).toMatchObject(snapshot);
    const first = catalog.readPage(pageRequest({ limit: 1 }));
    expect(first.entries).toMatchObject([{ threadId: 'alpha' }]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = catalog.readPage(pageRequest({ limit: 1, cursor: first.nextCursor as string }));
    expect(second).toMatchObject({ entries: [{ threadId: 'beta' }], nextCursor: null });

    expect(
      catalog.readPage(
        pageRequest({
          filter: {
            includeAll: false,
            cwdValues: [],
            cwdPrefixes: ['/workspace/b'],
            includeThreadIds: [],
            excludeThreadIds: [],
          },
        }),
      ),
    ).toMatchObject({ entries: [{ threadId: 'beta' }] });
    expect(
      catalog.readPage(
        pageRequest({
          manualOrder: { threadIds: ['beta', 'missing', 'alpha'], startIndex: 0 },
        }),
      ),
    ).toMatchObject({ entries: [{ threadId: 'beta' }, { threadId: 'alpha' }] });
  });

  it('keeps 10k-thread bootstrap, subscriptions, and filtered pagination bounded', () => {
    const entries = Array.from({ length: 10_000 }, (_, index) =>
      entry(
        `thread-${String(index).padStart(5, '0')}`,
        index,
        index % 2 === 0 ? '/workspace/even' : '/workspace/odd',
      ),
    );
    const catalog = createCatalog({
      persisted: {
        formatVersion: 1,
        revision: 1,
        isComplete: true,
        entries,
      },
    });
    catalog.load();

    const bootstrap = catalog.readBootstrapSnapshot();
    expect(bootstrap).toMatchObject({
      isComplete: false,
      hosts: [{ hostId: 'local', isComplete: false }],
    });
    expect(bootstrap.entries).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(bootstrap))).toBeLessThan(32 * 1024);
    const updates: unknown[] = [];
    catalog.subscribe((update) => updates.push(update));
    expect(updates).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(updates[0]))).toBeLessThan(32 * 1024);

    const startedAt = performance.now();
    let cursor: string | null = null;
    let count = 0;
    do {
      const page = catalog.readPage(pageRequest({ cursor }));
      count += (page.entries as unknown[]).length;
      cursor = page.nextCursor as string | null;
    } while (cursor !== null);
    expect(count).toBe(10_000);
    expect(performance.now() - startedAt).toBeLessThan(500);

    const filteredStartedAt = performance.now();
    cursor = null;
    count = 0;
    do {
      const page = catalog.readPage(
        pageRequest({
          cursor,
          filter: {
            includeAll: false,
            cwdValues: ['/workspace/even'],
            cwdPrefixes: [],
            includeThreadIds: [],
            excludeThreadIds: [],
          },
        }),
      );
      count += (page.entries as unknown[]).length;
      cursor = page.nextCursor as string | null;
    } while (cursor !== null);
    expect(count).toBe(5_000);
    expect(performance.now() - filteredStartedAt).toBeLessThan(500);
  });

  it('removes archived and confirmed-missing entries without hiding transient failures', async () => {
    const persisted = vi.fn(() => Promise.resolve());
    const client = new FakeClient([
      { cursor: null, data: [entry('archived', 300), entry('missing', 200)], nextCursor: null },
    ]);
    client.missingThreadIds.add('missing');
    const catalog = createCatalog({ persist: persisted });
    catalog.load();
    await catalog.start(client as unknown as CodexAppServerClient);

    catalog.handleNotification({
      method: 'thread/archived',
      params: { threadId: 'archived' },
    });
    await vi.waitFor(() => {
      expect(catalog.readEntries([{ hostId: 'local', threadId: 'archived' }])).toEqual([]);
    });
    await expect(
      catalog.removeMissingEntry({ hostId: 'local', threadId: 'missing' }),
    ).resolves.toBe(true);
    expect(catalog.readSnapshot().entries).toEqual([]);
    expect(persisted).toHaveBeenCalledTimes(3);
    catalog.stop();
  });

  it('rejects malformed requests and repeated server cursors', async () => {
    const errors: Error[] = [];
    const catalog = createCatalog({ onError: (error) => errors.push(error) });
    catalog.load();
    expect(() => catalog.readPage(pageRequest({ hostId: 'remote' }))).toThrow(
      'Unknown thread catalog host',
    );
    expect(() => catalog.readPage(pageRequest({ limit: 101 }))).toThrow(
      'Thread catalog page limit',
    );

    const client = new FakeClient([
      { cursor: null, data: [entry('one', 300)], nextCursor: 'again' },
      { cursor: 'again', data: [entry('two', 200)], nextCursor: 'again' },
    ]);
    await catalog.start(client as unknown as CodexAppServerClient);
    await expect(catalog.requestStartupSync()).rejects.toThrow(
      'app-server repeated a thread catalog cursor',
    );
    expect(errors).toEqual([]);
    catalog.stop();
  });

  it('reports a corrupt derived catalog and rebuilds it from the official app-server', async () => {
    const errors: Error[] = [];
    const persisted: unknown[] = [];
    const catalog = createCatalog({
      persisted: { formatVersion: 999, entries: 'broken' },
      persist: (value) => {
        persisted.push(value);
        return Promise.resolve();
      },
      onError: (error) => errors.push(error),
    });
    const client = new FakeClient([
      { cursor: null, data: [entry('recovered', 300)], nextCursor: null },
    ]);

    catalog.load();
    expect(errors.map((error) => error.message)).toEqual(['invalid persisted thread catalog']);
    await catalog.start(client as unknown as CodexAppServerClient);
    expect(catalog.readSnapshot()).toMatchObject({
      isComplete: true,
      entries: [{ threadId: 'recovered' }],
    });
    expect(persisted).toHaveLength(1);
    catalog.stop();
  });
});
