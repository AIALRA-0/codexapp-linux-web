import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthentikIdentity } from '@codexapp/contracts';

import type { GatewayConfig } from './config.js';
import { userKeyForIdentity } from './identity.js';
import { RuntimeRegistry, type UserRuntime } from './runtime.js';

class RegistryRuntimeHarness extends EventEmitter {
  readonly identity: AuthentikIdentity;
  readonly userKey: string;
  readonly start = vi.fn(() => Promise.resolve());
  readonly prepareBootstrap = vi.fn(() => Promise.resolve());
  readonly stop = vi.fn(() => Promise.resolve());
  hasBackgroundWork = false;
  backgroundWorkSnapshot = {
    active: false,
    activeTurnCount: 0,
    pendingServerRequestCount: 0,
    oldestStartedAtMs: null as number | null,
  };

  constructor(identity: AuthentikIdentity) {
    super();
    this.identity = identity;
    this.userKey = userKeyForIdentity(identity);
  }

  setBackgroundWork(active: boolean): void {
    this.hasBackgroundWork = active;
    this.backgroundWorkSnapshot = {
      active,
      activeTurnCount: active ? 1 : 0,
      pendingServerRequestCount: 0,
      oldestStartedAtMs: active ? 100 : null,
    };
    this.emit('background-work-changed', this.backgroundWorkSnapshot);
  }
}

const identity: AuthentikIdentity = {
  subject: 'background-work-user',
  username: 'background-work-user',
  groups: [],
};

function createRegistry(): {
  registry: RuntimeRegistry;
  runtime: RegistryRuntimeHarness;
} {
  const runtime = new RegistryRuntimeHarness(identity);
  const registry = new RuntimeRegistry({ idleRuntimeSeconds: 60 } as GatewayConfig, {
    createRuntime: () => runtime as unknown as UserRuntime,
  });
  return { registry, runtime };
}

describe('runtime registry background retention', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never applies the idle stop timer while official work is active', async () => {
    vi.useFakeTimers();
    const { registry, runtime } = createRegistry();
    const acquired = await registry.acquire(identity);
    runtime.setBackgroundWork(true);
    registry.release(acquired);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(registry.backgroundWorkSnapshot).toMatchObject({
      active: true,
      activeRuntimeCount: 1,
      activeTurnCount: 1,
    });

    runtime.setBackgroundWork(false);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runtime.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it('preserves normal idle cleanup for runtimes with no work', async () => {
    vi.useFakeTimers();
    const { registry, runtime } = createRegistry();
    registry.release(await registry.acquire(identity));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(registry.backgroundWorkSnapshot.runtimeCount).toBe(0);
  });

  it('loads only persisted bootstrap state without waiting for the full runtime', async () => {
    const { registry, runtime } = createRegistry();
    const acquired = await registry.acquireBootstrap(identity);
    expect(runtime.prepareBootstrap).toHaveBeenCalledOnce();
    expect(runtime.start).not.toHaveBeenCalled();
    registry.release(acquired);
  });
});
