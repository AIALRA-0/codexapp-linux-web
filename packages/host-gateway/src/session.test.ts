import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { HostFrame } from '@codexapp/contracts';

import type { UserRuntime } from './runtime.js';
import { BrowserSession } from './session.js';

class RuntimeHarness extends EventEmitter {
  readonly config = { expectedRendererVersion: '26.721.31836' };
  readonly requestUserInputAutoResolution = {
    setSurfaceForegrounded: () => undefined,
    removeSurface: () => undefined,
  };
}

class SocketHarness {
  readonly frames: HostFrame[] = [];
  readonly readyState = WebSocket.OPEN;
  readonly closes: Array<{ code: number; reason: string }> = [];

  send(source: string): void {
    this.frames.push(JSON.parse(source) as HostFrame);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

function createSession(): BrowserSession {
  return new BrowserSession(randomUUID(), new RuntimeHarness() as unknown as UserRuntime);
}

describe('browser session reconnect protocol', () => {
  it('replays only unacknowledged host frames and preserves their original sequence', () => {
    const session = createSession();
    const firstMessage = session.send({ type: 'view-message', message: { value: 1 } });
    const firstSocket = new SocketHarness();
    session.attach(firstSocket as unknown as WebSocket, 0);

    expect(firstSocket.frames[0]).toEqual(firstMessage);
    expect(firstSocket.frames[1]).toMatchObject({ type: 'ready', sequence: 2 });
    session.acknowledge(2);
    session.detach(firstSocket as unknown as WebSocket);

    const offlineMessage = session.send({ type: 'view-message', message: { value: 2 } });
    expect(session.pendingHostFrames).toBe(1);
    const secondSocket = new SocketHarness();
    session.attach(secondSocket as unknown as WebSocket, 2);

    expect(secondSocket.frames[0]).toEqual(offlineMessage);
    expect(secondSocket.frames[1]).toMatchObject({ type: 'ready', sequence: 4 });
    expect(secondSocket.frames.map((frame) => frame.sequence)).toEqual([3, 4]);
    session.dispose();
  });

  it('rejects duplicate and out-of-order browser frames', () => {
    const session = createSession();
    expect(session.shouldAcceptClientSequence(10)).toBe(true);
    expect(session.shouldAcceptClientSequence(10)).toBe(false);
    expect(session.shouldAcceptClientSequence(9)).toBe(false);
    expect(session.shouldAcceptClientSequence(11)).toBe(true);
    session.dispose();
  });

  it('ignores a delayed close event from the socket replaced by a reconnect', () => {
    const session = createSession();
    const oldSocket = new SocketHarness();
    const currentSocket = new SocketHarness();
    session.attach(oldSocket as unknown as WebSocket, 0);
    session.attach(currentSocket as unknown as WebSocket, 0);

    expect(oldSocket.closes).toEqual([{ code: 4001, reason: 'replaced by reconnect' }]);
    expect(session.detach(oldSocket as unknown as WebSocket)).toBe(false);
    expect(session.detach(currentSocket as unknown as WebSocket)).toBe(true);
    session.dispose();
  });

  it('replays a remembered command result without executing the command again', () => {
    const session = createSession();
    const commandId = randomUUID();
    const original = session.send({
      type: 'command-result',
      commandId,
      ok: true,
      result: { accepted: true },
    });
    session.rememberCommandResult(commandId, original);
    const socket = new SocketHarness();
    session.attach(socket as unknown as WebSocket, original.sequence);

    const replay = session.replayCommandResult(commandId);
    expect(replay).toMatchObject({
      type: 'command-result',
      commandId,
      ok: true,
      result: { accepted: true },
    });
    expect(replay?.sequence).toBeGreaterThan(original.sequence);
    session.dispose();
  });

  it('bounds disconnected replay memory without throwing into an active task', () => {
    const session = createSession();
    for (let index = 0; index < 10_001; index += 1) {
      expect(() => session.send({ type: 'view-message', message: { index } })).not.toThrow();
    }
    expect(session.pendingHostFrames).toBe(0);

    const socket = new SocketHarness();
    expect(session.attach(socket as unknown as WebSocket, 0)).toBe(false);
    expect(socket.closes).toEqual([{ code: 4410, reason: 'browser session replay unavailable' }]);
    session.dispose();
  });

  it('delivers a targeted renderer response only to its owning browser session', () => {
    const runtime = new RuntimeHarness();
    const first = new BrowserSession('session-first', runtime as unknown as UserRuntime);
    const second = new BrowserSession('session-second', runtime as unknown as UserRuntime);

    runtime.emit('view-message-for-session', {
      browserSessionId: 'session-second',
      message: { type: 'mcp-response', message: { id: 7, result: { ok: true } } },
    });

    expect(first.pendingHostFrames).toBe(0);
    expect(second.pendingHostFrames).toBe(1);
    first.dispose();
    second.dispose();
  });
});
