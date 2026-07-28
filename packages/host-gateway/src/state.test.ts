import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DurableStateStore } from './state.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe('DurableStateStore', () => {
  it('persists independent namespaces with an atomic state document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codexapp-state-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'host-state.json');
    const store = new DurableStateStore(path);
    await store.load();
    await Promise.all([
      store.set('settings', 'theme', 'dark'),
      store.set('persistedAtoms', 'sidebar', { collapsed: true }),
      store.set('globalState', 'count', 2),
    ]);

    const reloaded = new DurableStateStore(path);
    await reloaded.load();
    expect(reloaded.get('settings', 'theme')).toBe('dark');
    expect(reloaded.get('persistedAtoms', 'sidebar')).toEqual({ collapsed: true });
    expect(reloaded.get('globalState', 'count')).toBe(2);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('deletes keys and resets a namespace durably', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codexapp-state-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'host-state.json');
    const store = new DurableStateStore(path);
    await store.load();
    await store.set('configuration', 'one', 1);
    await store.set('configuration', 'two', 2);
    await store.set('configuration', 'one', undefined);
    await store.clear('configuration');

    const reloaded = new DurableStateStore(path);
    await reloaded.load();
    expect(reloaded.snapshot('configuration')).toEqual({});
  });

  it('updates compare-and-set state only when the expected value is current', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codexapp-state-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'host-state.json');
    const store = new DurableStateStore(path);
    await store.load();
    await store.set('globalState', 'integrity', 'one');
    await expect(
      store.compareAndSet('globalState', 'integrity', 'stale', 'incorrect'),
    ).resolves.toBe(false);
    await expect(store.compareAndSet('globalState', 'integrity', 'one', 'two')).resolves.toBe(true);
    expect(store.get('globalState', 'integrity')).toBe('two');
  });

  it('restores the last durable generation when the primary document is corrupt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codexapp-state-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'host-state.json');
    const store = new DurableStateStore(path);
    await store.load();
    await store.set('settings', 'theme', 'light');
    await store.set('settings', 'theme', 'dark');
    await writeFile(path, '{"version":', 'utf8');

    const recovered = new DurableStateStore(path);
    await recovered.load();
    expect(recovered.get('settings', 'theme')).toBe('light');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      settings: { theme: 'light' },
    });
    expect((await readdir(directory)).some((name) => name.includes('.corrupt-'))).toBe(true);
  });
});
