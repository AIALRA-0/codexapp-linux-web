import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OfficialAppDirectoryCache } from './official-app-directory.js';

async function createCache(value: unknown): Promise<OfficialAppDirectoryCache> {
  const root = await mkdtemp(join(tmpdir(), 'codex-official-app-directory-'));
  const directory = join(root, 'cache', 'codex_app_directory');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'e448a982a703ae90fd8068f6b73a30f24c3bff0d.json'),
    JSON.stringify(value),
  );
  return new OfficialAppDirectoryCache(root);
}

describe('official app directory cache', () => {
  it('pages the exact official cache records with an opaque cursor', async () => {
    const connectors = [
      { id: 'app-1', name: 'First', branding: { accentColor: '#fff' } },
      { id: 'app-2', name: 'Second', isAccessible: true },
      { id: 'app-3', name: 'Third', logoUrl: 'connectors://app-3/logo?theme=light' },
    ];
    const cache = await createCache({ schema_version: 1, connectors });
    const first = await cache.list({ cursor: null, limit: 2, forceRefetch: false });
    expect(first?.data).toEqual(connectors.slice(0, 2));
    expect(first?.nextCursor).toMatch(/^official-app-directory-v1:/u);
    const second = await cache.list({ cursor: first?.nextCursor, limit: 2, forceRefetch: false });
    expect(second).toEqual({ data: connectors.slice(2), nextCursor: null });
  });

  it('leaves explicit hard refreshes on the official app-server path', async () => {
    const cache = await createCache({
      schema_version: 1,
      connectors: [{ id: 'app-1', name: 'First' }],
    });
    await expect(cache.list({ forceRefetch: true })).resolves.toBeNull();
  });

  it('rejects malformed unofficial cache content', async () => {
    const cache = await createCache({
      schema_version: 1,
      connectors: [{ id: 'missing-name' }],
    });
    await expect(cache.list({ forceRefetch: false })).resolves.toBeNull();
  });
});
