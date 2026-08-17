import { describe, expect, it, vi } from 'vitest';

import { StartupThreadPrewarmer } from './startup-thread-prewarmer.js';

describe('startup thread prewarmer', () => {
  it('resumes only the configured most recent thread through the official App Server', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        thread: {
          cwd: '/workspace/recent',
          path: '/rollouts/recent.jsonl',
          status: { type: 'idle' },
        },
      })
      .mockResolvedValueOnce({ config: { personality: 'friendly' } });
    const resume = vi.fn().mockResolvedValue(true);
    const onComplete = vi.fn();
    const prewarmer = new StartupThreadPrewarmer({
      count: 1,
      catalog: {
        readBootstrapSnapshot: () => ({
          entries: [
            { threadId: 'recent', cwd: '/workspace/recent' },
            { threadId: 'older', cwd: '/workspace/older' },
          ],
        }),
      },
      resume,
      onComplete,
    });

    prewarmer.schedule({ request } as never);
    await prewarmer.waitForThread('recent');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, 'config/read', {}, 30_000);
    expect(resume).toHaveBeenCalledWith(
      'recent',
      expect.objectContaining({
        threadId: 'recent',
        path: '/rollouts/recent.jsonl',
        cwd: '/workspace/recent',
        excludeTurns: true,
        model: null,
        modelProvider: null,
        personality: 'friendly',
      }),
      120_000,
    );
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'recent' }));
  });

  it('lets an incoming open wait for an in-progress prewarm instead of duplicating the scan', async () => {
    let finishResume: (() => void) | undefined;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        thread: { cwd: '/workspace', path: '/rollout.jsonl', status: { type: 'idle' } },
      })
      .mockResolvedValueOnce({ config: { personality: 'friendly' } });
    const resume = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishResume = () => resolve(true);
        }),
    );
    const prewarmer = new StartupThreadPrewarmer({
      count: 1,
      catalog: {
        readBootstrapSnapshot: () => ({
          entries: [{ threadId: 'thread-1', cwd: '/workspace' }],
        }),
      },
      resume,
    });

    prewarmer.schedule({ request } as never);
    await vi.waitFor(() => expect(finishResume).toBeTypeOf('function'));
    let released = false;
    const waiting = prewarmer.waitForThread('thread-1').then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    finishResume?.();
    await waiting;
    expect(request).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('does not resume a thread that already has active work', async () => {
    const request = vi.fn().mockResolvedValue({
      thread: { cwd: '/workspace', path: '/rollout.jsonl', status: { type: 'active' } },
    });
    const prewarmer = new StartupThreadPrewarmer({
      count: 1,
      catalog: {
        readBootstrapSnapshot: () => ({
          entries: [{ threadId: 'active', cwd: '/workspace' }],
        }),
      },
      resume: vi.fn().mockResolvedValue(true),
    });

    prewarmer.schedule({ request } as never);
    await prewarmer.waitForThread('active');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      'thread/read',
      { threadId: 'active', includeTurns: false },
      30_000,
    );
  });

  it('does not report completion when the official response could not be cached', async () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    const prewarmer = new StartupThreadPrewarmer({
      count: 1,
      catalog: {
        readBootstrapSnapshot: () => ({
          entries: [{ threadId: 'uncacheable', cwd: '/workspace' }],
        }),
      },
      resume: vi.fn().mockResolvedValue(false),
      onComplete,
      onError,
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        thread: { cwd: '/workspace', path: '/rollout.jsonl', status: { type: 'idle' } },
      })
      .mockResolvedValueOnce({ config: { personality: 'friendly' } });

    prewarmer.schedule({ request } as never);
    await prewarmer.waitForThread('uncacheable');

    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'thread/resume result was not cached' }),
      { method: 'thread/resume', threadId: 'uncacheable' },
    );
  });
});
