import { describe, expect, it, vi } from 'vitest';

import { BackgroundWorkTracker } from './background-work.js';

describe('background work lifecycle', () => {
  it('stays active from official turn start until official turn completion', () => {
    const changes: unknown[] = [];
    const tracker = new BackgroundWorkTracker((snapshot) => changes.push(snapshot));
    tracker.observeNotification(
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } },
      },
      100,
    );
    expect(tracker.snapshot).toEqual({
      active: true,
      activeTurnCount: 1,
      pendingServerRequestCount: 0,
      oldestStartedAtMs: 100,
    });

    tracker.observeNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    expect(tracker.snapshot.active).toBe(false);
    expect(changes).toHaveLength(2);
  });

  it('retains work waiting for an approval and releases it after the client response', () => {
    const tracker = new BackgroundWorkTracker();
    tracker.observeServerRequest(
      {
        id: 42,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      },
      200,
    );
    expect(tracker.snapshot).toMatchObject({
      active: true,
      activeTurnCount: 0,
      pendingServerRequestCount: 1,
      oldestStartedAtMs: 200,
    });

    tracker.observeClientResponse({ id: 42, result: { decision: 'accept' } });
    expect(tracker.snapshot.active).toBe(false);
  });

  it('cleans pending requests when the official lifecycle resolves or completes them', () => {
    const tracker = new BackgroundWorkTracker();
    tracker.observeNotification({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    });
    tracker.observeServerRequest({
      id: 'question',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    tracker.observeNotification({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-1', requestId: 'question' },
    });
    expect(tracker.snapshot).toMatchObject({
      active: true,
      activeTurnCount: 1,
      pendingServerRequestCount: 0,
    });

    tracker.observeNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
    });
    expect(tracker.snapshot.active).toBe(false);
  });

  it('does not publish duplicate state for unrelated notifications', () => {
    const onChanged = vi.fn();
    const tracker = new BackgroundWorkTracker(onChanged);
    tracker.observeNotification({ method: 'thread/tokenUsage/updated', params: {} });
    expect(onChanged).not.toHaveBeenCalled();
  });
});
