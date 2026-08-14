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
      .mockResolvedValueOnce({ thread: { id: 'recent' } });
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
      onComplete,
    });

    prewarmer.schedule({ request } as never);
    await prewarmer.waitForThread('recent');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      2,
      'thread/resume',
      expect.objectContaining({
        threadId: 'recent',
        path: '/rollouts/recent.jsonl',
        cwd: '/workspace/recent',
        excludeTurns: true,
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
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishResume = () => resolve({ thread: { id: 'thread-1' } });
          }),
      );
    const prewarmer = new StartupThreadPrewarmer({
      count: 1,
      catalog: {
        readBootstrapSnapshot: () => ({
          entries: [{ threadId: 'thread-1', cwd: '/workspace' }],
        }),
      },
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
});
