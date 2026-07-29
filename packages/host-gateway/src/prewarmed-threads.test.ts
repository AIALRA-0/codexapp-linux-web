import { afterEach, describe, expect, it, vi } from 'vitest';

import { OfficialPrewarmedThreads } from './prewarmed-threads.js';

afterEach(() => {
  vi.useRealTimers();
});

function createHarness(ttlMs = 10 * 60_000) {
  const deleted: string[] = [];
  const published: unknown[] = [];
  const tracker = new OfficialPrewarmedThreads({
    deleteExpiredThread: (threadId) => deleted.push(threadId),
    publishThreadStarted: (notification) => published.push(notification),
    ttlMs,
  });
  return { deleted, published, tracker };
}

describe('official prewarmed thread lifecycle', () => {
  it('suppresses the original start until the first turn makes the thread visible', () => {
    const { published, tracker } = createHarness();
    tracker.trackResponse({ id: 'prewarm', result: { thread: { id: 'thread-1', name: '' } } });

    expect(
      tracker.suppressThreadStarted({
        method: 'thread/started',
        params: { thread: { id: 'thread-1', name: '' } },
      }),
    ).toBe(true);
    expect(published).toEqual([]);

    tracker.publishForTurnStart({ threadId: 'thread-1' });
    expect(published).toEqual([
      {
        method: 'thread/started',
        params: { thread: { id: 'thread-1', name: '' } },
      },
    ]);
    tracker.clear();
  });

  it('publishes before turn start and then suppresses a late original notification', () => {
    const { published, tracker } = createHarness();
    tracker.trackResponse({ id: 'prewarm', result: { thread: { id: 'thread-2' } } }, 1_000);

    expect(tracker.publishForTurnStart({ threadId: 'thread-2' }, 1_275)).toBe(275);
    expect(published).toHaveLength(1);
    expect(
      tracker.suppressThreadStarted({
        method: 'thread/started',
        params: { thread: { id: 'thread-2' } },
      }),
    ).toBe(true);
    tracker.clear();
  });

  it('deletes only an unused invisible prewarm after the official lifecycle', () => {
    vi.useFakeTimers();
    const { deleted, tracker } = createHarness(1_000);
    tracker.trackResponse({ id: 'prewarm', result: { thread: { id: 'thread-unused' } } });
    vi.advanceTimersByTime(1_000);
    expect(deleted).toEqual(['thread-unused']);

    tracker.trackResponse({ id: 'prewarm-2', result: { thread: { id: 'thread-visible' } } });
    tracker.publishForTurnStart({ threadId: 'thread-visible' });
    vi.advanceTimersByTime(1_000);
    expect(deleted).toEqual(['thread-unused']);
    tracker.clear();
  });

  it('ignores malformed and failed prewarm responses', () => {
    vi.useFakeTimers();
    const { deleted, published, tracker } = createHarness(1);
    tracker.trackResponse({ id: 'failed', error: { code: -32_603, message: 'failed' } });
    tracker.trackResponse({ id: 'malformed', result: { thread: {} } });
    vi.advanceTimersByTime(10);
    expect(tracker.publishForTurnStart({ threadId: 'missing' })).toBeNull();
    expect({ deleted, published }).toEqual({ deleted: [], published: [] });
    tracker.clear();
  });

  it('stops tracking a prewarm that the app server deletes', () => {
    vi.useFakeTimers();
    const { deleted, tracker } = createHarness(1_000);
    tracker.trackResponse({ id: 'prewarm', result: { thread: { id: 'thread-deleted' } } });
    tracker.stopTracking('thread-deleted');
    vi.advanceTimersByTime(1_000);
    expect(deleted).toEqual([]);
    tracker.clear();
  });
});
