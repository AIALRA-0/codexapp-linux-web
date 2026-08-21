import WebSocket from 'ws';

import { CONTRACT_VERSION, type HostFrame } from '@codexapp/contracts';

import type { UserRuntime } from './runtime.js';
import { AppHostConnection } from './app-host.js';
import {
  chunkOfficialHostMessage,
  hostMessageNeedsChunking,
  type OfficialChunkedMessage,
} from './chunked-message.js';
import { PendingPortMessages } from './pending-port-messages.js';

type HostFrameValue =
  | Omit<Extract<HostFrame, { type: 'ready' }>, 'contractVersion' | 'sequence'>
  | Omit<Extract<HostFrame, { type: 'command-result' }>, 'contractVersion' | 'sequence'>
  | Omit<Extract<HostFrame, { type: 'view-message' }>, 'contractVersion' | 'sequence'>
  | Omit<Extract<HostFrame, { type: 'worker-message' }>, 'contractVersion' | 'sequence'>
  | Omit<Extract<HostFrame, { type: 'host-port-message' }>, 'contractVersion' | 'sequence'>
  | Omit<Extract<HostFrame, { type: 'fatal' }>, 'contractVersion' | 'sequence'>;

interface ActiveChunkTransfer {
  iterator: Generator<OfficialChunkedMessage>;
  lastFrame: HostFrame;
  pendingAckSequence: number;
}

export class BrowserSession {
  readonly id: string;
  readonly runtime: UserRuntime;
  #socket: WebSocket | undefined;
  #nextHostSequence = 1;
  #lastClientSequence = -1;
  #outbox = new Map<number, HostFrame>();
  #commandResults = new Map<string, HostFrame>();
  #appHostConnections = new Map<string, AppHostConnection>();
  #pendingAppHostMessages = new PendingPortMessages();
  #activeChunkTransfer: ActiveChunkTransfer | undefined;
  #queuedChunkMessages: unknown[] = [];
  #requiresReload = false;
  #viewListener: (message: unknown) => void;
  #targetedViewListener: (event: { browserSessionId: string; message: unknown }) => void;
  #workerListener: (event: { worker: string; message: unknown }) => void;

  constructor(id: string, runtime: UserRuntime) {
    this.id = id;
    this.runtime = runtime;
    this.#viewListener = (message) => {
      this.send({ type: 'view-message', message });
    };
    this.#targetedViewListener = (event) => {
      if (event.browserSessionId !== this.id) return;
      this.send({ type: 'view-message', message: event.message });
    };
    this.#workerListener = (event) => {
      this.send({ type: 'worker-message', worker: event.worker, message: event.message });
    };
    runtime.on('view-message', this.#viewListener);
    runtime.on('view-message-for-session', this.#targetedViewListener);
    runtime.on('worker-message', this.#workerListener);
    runtime.requestUserInputAutoResolution.setSurfaceForegrounded(this.id, false);
  }

  get pendingHostFrames(): number {
    return this.#outbox.size;
  }

  attach(socket: WebSocket, lastHostSequence: number): boolean {
    if (this.#requiresReload) {
      socket.close(4410, 'browser session replay unavailable');
      return false;
    }
    this.#socket?.close(4001, 'replaced by reconnect');
    this.#socket = socket;
    for (const [sequence, frame] of this.#outbox) {
      if (sequence > lastHostSequence) this.#write(frame);
    }
    this.send({
      type: 'ready',
      sessionId: this.id,
      rendererVersion: this.runtime.config.expectedRendererVersion,
      replayedThrough: this.#nextHostSequence - 1,
    });
    return true;
  }

  detach(socket: WebSocket): boolean {
    if (this.#socket !== socket) return false;
    this.#socket = undefined;
    this.runtime.requestUserInputAutoResolution.setSurfaceForegrounded(this.id, false);
    return true;
  }

  dispose(): void {
    this.runtime.off('view-message', this.#viewListener);
    this.runtime.off('view-message-for-session', this.#targetedViewListener);
    this.runtime.off('worker-message', this.#workerListener);
    this.#socket?.close(1001, 'session disposed');
    this.#socket = undefined;
    for (const connection of this.#appHostConnections.values()) connection.close();
    this.#appHostConnections.clear();
    this.#pendingAppHostMessages.clear();
    this.#activeChunkTransfer = undefined;
    this.#queuedChunkMessages.length = 0;
    this.runtime.requestUserInputAutoResolution.removeSurface(this.id);
  }

  connectAppHost(portId: string): void {
    if (this.#appHostConnections.has(portId)) {
      throw new Error(`AppHost port already exists: ${portId}`);
    }
    const connection = new AppHostConnection(portId, this, this.runtime);
    this.#appHostConnections.set(portId, connection);
    this.#pendingAppHostMessages.drain(portId, (message) => connection.deliver(message));
  }

  deliverAppHostMessage(portId: string, message: unknown): void {
    const connection = this.#appHostConnections.get(portId);
    if (connection === undefined) {
      this.#pendingAppHostMessages.queue(portId, message);
      return;
    }
    connection.deliver(message);
  }

  acknowledge(sequence: number): void {
    for (const key of this.#outbox.keys()) {
      if (key <= sequence) this.#outbox.delete(key);
    }
    const active = this.#activeChunkTransfer;
    if (active !== undefined && sequence >= active.pendingAckSequence) {
      this.#advanceChunkTransfer(active);
    }
  }

  shouldAcceptClientSequence(sequence: number): boolean {
    if (sequence <= this.#lastClientSequence) return false;
    this.#lastClientSequence = sequence;
    return true;
  }

  previousCommandResult(commandId: string): HostFrame | undefined {
    return this.#commandResults.get(commandId);
  }

  replayCommandResult(commandId: string): HostFrame | undefined {
    const prior = this.#commandResults.get(commandId);
    if (prior?.type !== 'command-result') return undefined;
    return this.send({
      type: 'command-result',
      commandId,
      ok: prior.ok,
      ...(prior.result === undefined ? {} : { result: prior.result }),
      ...(prior.error === undefined ? {} : { error: prior.error }),
    });
  }

  rememberCommandResult(commandId: string, frame: HostFrame): void {
    this.#commandResults.set(commandId, frame);
    if (this.#commandResults.size > 5_000) {
      const first = this.#commandResults.keys().next().value;
      if (first !== undefined) this.#commandResults.delete(first);
    }
  }

  send(value: HostFrameValue): HostFrame {
    if (value.type === 'view-message' && hostMessageNeedsChunking(value.message)) {
      if (this.#activeChunkTransfer !== undefined) {
        this.#queuedChunkMessages.push(value.message);
        return this.#activeChunkTransfer.lastFrame;
      }
      return this.#startChunkTransfer(value.message);
    }
    return this.#sendDirect(value);
  }

  #sendDirect(value: HostFrameValue): HostFrame {
    const frame = {
      ...value,
      contractVersion: CONTRACT_VERSION,
      sequence: this.#nextHostSequence++,
    } as HostFrame;
    if (this.#requiresReload) return frame;
    this.#outbox.set(frame.sequence, frame);
    if (this.#outbox.size > 10_000) {
      this.#requiresReload = true;
      this.#outbox.clear();
      this.#commandResults.clear();
      this.#socket?.close(4009, 'unacknowledged host frame limit exceeded');
      return frame;
    }
    this.#write(frame);
    return frame;
  }

  #startChunkTransfer(message: unknown): HostFrame {
    const iterator = chunkOfficialHostMessage(message);
    const first = iterator.next();
    if (first.done) throw new Error('chunked host message did not emit a start frame');
    const frame = this.#sendDirect({ type: 'view-message', message: first.value });
    this.#activeChunkTransfer = {
      iterator,
      lastFrame: frame,
      pendingAckSequence: frame.sequence,
    };
    return frame;
  }

  #advanceChunkTransfer(active: ActiveChunkTransfer): void {
    if (this.#activeChunkTransfer !== active) return;
    const next = active.iterator.next();
    if (!next.done) {
      const frame = this.#sendDirect({ type: 'view-message', message: next.value });
      active.lastFrame = frame;
      active.pendingAckSequence = frame.sequence;
      return;
    }
    this.#activeChunkTransfer = undefined;
    const queued = this.#queuedChunkMessages.shift();
    if (queued !== undefined) this.#startChunkTransfer(queued);
  }

  #write(frame: HostFrame): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(frame));
    }
  }
}
