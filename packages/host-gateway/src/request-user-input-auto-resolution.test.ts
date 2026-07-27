import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RequestUserInputAutoResolution,
  type AutoResolutionChange,
} from './request-user-input-auto-resolution.js';

describe('official request user input automatic resolution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for foreground inactivity and then runs the official countdown', async () => {
    const changes: AutoResolutionChange[] = [];
    const responses: unknown[] = [];
    const manager = new RequestUserInputAutoResolution({
      foregroundInactivityMs: 60,
      defaultCountdownMs: 90,
      onAutoResolve: (response) => responses.push(response),
      onStateChanged: (change) => changes.push(change),
    });
    manager.setSurfaceForegrounded('surface', true);
    manager.setConversationPresented('surface', 'thread', true);
    manager.observeServerRequest({
      id: 7,
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread' },
    });
    expect(manager.getPendingRequestSnapshots()[0]?.resolutionState).toEqual({
      status: 'waiting-for-inactivity',
    });

    await vi.advanceTimersByTimeAsync(59);
    manager.recordConversationActivity('surface', 'thread');
    await vi.advanceTimersByTimeAsync(60);
    expect(manager.getPendingRequestSnapshots()[0]?.resolutionState).toMatchObject({
      status: 'scheduled',
    });
    await vi.advanceTimersByTimeAsync(90);
    expect(responses).toEqual([{ id: 7, result: { answers: {} } }]);
    expect(changes.slice(-2).map((change) => change.kind)).toEqual(['timed-out', 'removed']);
    manager.dispose();
  });

  it('uses the MCP supplied timeout and exact decline response', async () => {
    const responses: unknown[] = [];
    const manager = new RequestUserInputAutoResolution({
      onAutoResolve: (response) => responses.push(response),
      onStateChanged: () => undefined,
    });
    manager.observeServerRequest({
      id: 'mcp-request',
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'thread', _meta: { autoResolutionMs: 5_000 } },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(responses).toEqual([
      {
        id: 'mcp-request',
        result: { action: 'decline', content: null, _meta: null },
      },
    ]);
    manager.dispose();
  });

  it('stops the timer when app-server reports that the request was resolved', async () => {
    const responses: unknown[] = [];
    const manager = new RequestUserInputAutoResolution({
      defaultCountdownMs: 90,
      onAutoResolve: (response) => responses.push(response),
      onStateChanged: () => undefined,
    });
    manager.observeServerRequest({
      id: 'request',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread' },
    });
    manager.observeServerNotification({
      method: 'serverRequest/resolved',
      params: { requestId: 'request' },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(responses).toEqual([]);
    expect(manager.getPendingRequestSnapshots()).toEqual([]);
    manager.dispose();
  });

  it('snoozes ordinary requests but restarts MCP deadlines', () => {
    const manager = new RequestUserInputAutoResolution({
      onAutoResolve: () => undefined,
      onStateChanged: () => undefined,
    });
    manager.observeServerRequest({
      id: 'ordinary',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'ordinary-thread' },
    });
    manager.snoozeRequest('ordinary-thread', 'ordinary');
    expect(manager.getPendingRequestSnapshots()[0]?.resolutionState).toEqual({
      status: 'snoozed',
    });
    manager.observeServerRequest({
      id: 'mcp',
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'mcp-thread', _meta: { autoResolutionMs: 10_000 } },
    });
    manager.snoozeRequest('mcp-thread', 'mcp');
    expect(
      manager.getPendingRequestSnapshots().find((snapshot) => snapshot.requestId === 'mcp')
        ?.resolutionState,
    ).toMatchObject({ status: 'scheduled' });
    manager.dispose();
  });
});
