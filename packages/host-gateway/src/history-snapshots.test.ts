import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppServerHistorySnapshotsService,
  AppServerHistorySnapshotStore,
} from './history-snapshots.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

async function createStore(
  options: ConstructorParameters<typeof AppServerHistorySnapshotStore>[1] = {},
): Promise<AppServerHistorySnapshotStore> {
  const root = await mkdtemp(join(tmpdir(), 'codex-history-snapshots-'));
  temporaryRoots.push(root);
  return new AppServerHistorySnapshotStore(join(root, 'history.db'), options);
}

function snapshot(threadId: string, text = 'latest answer'): string {
  return JSON.stringify({
    version: 2,
    threadId,
    threadSummary: { title: 'Large task' },
    truncatedBefore: true,
    turns: [
      {
        omittedItemCount: 0,
        turn: {
          id: 'turn-1',
          items: [{ id: 'item-1', type: 'agentMessage', text }],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    ],
  });
}

describe('official app-server history snapshots', () => {
  it('persists an account- and host-isolated snapshot', async () => {
    const store = await createStore();
    const payload = snapshot('thread-1');
    store.write('principal-a', 'local', payload);

    expect(store.read('principal-a', 'local', 'thread-1')).toBe(payload);
    expect(store.read('principal-b', 'local', 'thread-1')).toBeNull();
    expect(store.read('principal-a', 'other', 'thread-1')).toBeNull();
    store.close();
  });

  it('rejects invalid and oversized snapshots', async () => {
    const store = await createStore({ maxThreadBytes: 100 });

    expect(() => store.write('principal', 'local', '{}')).toThrow(
      'History snapshot payload is invalid',
    );
    expect(() => store.write('principal', 'local', snapshot('thread-1'))).toThrow(
      'History snapshot exceeds the per-thread limit',
    );
    store.close();
  });

  it('expires snapshots without returning stale content', async () => {
    let now = 1_000;
    const store = await createStore({ now: () => now, ttlMs: 100 });
    store.write('principal', 'local', snapshot('thread-1'));
    now = 1_101;

    expect(store.read('principal', 'local', 'thread-1')).toBeNull();
    store.close();
  });

  it('requires a current official account lease for every operation', async () => {
    const store = await createStore();
    let principal = { accountId: 'account-1', userId: 'user-1' };
    const service = new AppServerHistorySnapshotsService({
      getPrincipal: () => Promise.resolve(principal),
      store,
    });
    const leaseResult = (await service.acquireAuthorizationLease('local')) as {
      status: string;
      value: string;
    };
    expect(leaseResult.status).toBe('ok');
    expect(await service.write('local', leaseResult.value, snapshot('thread-1'))).toMatchObject({
      status: 'ok',
    });
    expect(await service.read('local', leaseResult.value, 'thread-1')).toEqual({
      status: 'ok',
      value: snapshot('thread-1'),
    });

    const invalidated = vi.fn();
    service.subscribeAuthorizationLeaseInvalidation('local', invalidated);
    principal = { accountId: 'account-2', userId: 'user-1' };
    expect(await service.read('local', leaseResult.value, 'thread-1')).toEqual({
      status: 'unavailable',
    });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(await service.read('remote', leaseResult.value, 'thread-1')).toEqual({
      status: 'unavailable',
    });
    store.close();
  });
});
