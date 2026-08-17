import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DiscoveryResponseCacheStore } from './discovery-response-cache.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

async function createStore(
  options: ConstructorParameters<typeof DiscoveryResponseCacheStore>[1] = {},
): Promise<{ path: string; store: DiscoveryResponseCacheStore }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-discovery-cache-'));
  temporaryRoots.push(root);
  const path = join(root, 'discovery.db');
  return { path, store: new DiscoveryResponseCacheStore(path, options) };
}

describe('official discovery response cache', () => {
  it('persists JSON responses without crossing Codex accounts', async () => {
    const { path, store } = await createStore();
    expect(
      store.write('principal-a', 'plugin/list:key', 'plugin/list', 10_000, { plugins: [1] }),
    ).toBe(true);
    store.close();

    const reopened = new DiscoveryResponseCacheStore(path);
    expect(reopened.read('principal-a', 'plugin/list:key')?.result).toEqual({ plugins: [1] });
    expect(reopened.read('principal-b', 'plugin/list:key')).toBeNull();
    reopened.close();
  });

  it('expires results and never returns oversized entries', async () => {
    let now = 1_000;
    const { store } = await createStore({ maxEntryBytes: 20, now: () => now });
    expect(store.write('principal', 'small', 'plugin/list', 100, { ok: true })).toBe(true);
    expect(store.write('principal', 'large', 'plugin/list', 100, { text: 'x'.repeat(100) })).toBe(
      false,
    );
    now = 1_101;
    expect(store.read('principal', 'small')).toBeNull();
    expect(store.read('principal', 'large')).toBeNull();
    store.close();
  });

  it('invalidates only the official discovery namespace changed by a mutation', async () => {
    const { store } = await createStore();
    store.write('principal', 'plugin', 'plugin/list', 10_000, { plugins: [] });
    store.write('principal', 'mcp', 'mcpServerStatus/list', 10_000, { servers: [] });

    store.invalidate(['plugin/']);
    expect(store.read('principal', 'plugin')).toBeNull();
    expect(store.read('principal', 'mcp')?.result).toEqual({ servers: [] });
    store.invalidate(['']);
    expect(store.read('principal', 'mcp')).toBeNull();
    store.close();
  });
});
