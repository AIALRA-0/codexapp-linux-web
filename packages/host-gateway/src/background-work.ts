import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from '@codexapp/contracts';

export interface BackgroundWorkSnapshot {
  active: boolean;
  activeTurnCount: number;
  pendingServerRequestCount: number;
  oldestStartedAtMs: number | null;
}

interface ActiveTurn {
  key: string;
  threadId: string | null;
  turnId: string;
  startedAtMs: number;
}

interface PendingServerRequest {
  requestId: JsonRpcId;
  threadId: string | null;
  turnId: string | null;
  startedAtMs: number;
}

export class BackgroundWorkTracker {
  #activeTurns = new Map<string, ActiveTurn>();
  #pendingServerRequests = new Map<JsonRpcId, PendingServerRequest>();
  #onChanged: (snapshot: BackgroundWorkSnapshot) => void;

  constructor(onChanged: (snapshot: BackgroundWorkSnapshot) => void = () => undefined) {
    this.#onChanged = onChanged;
  }

  get active(): boolean {
    return this.#activeTurns.size > 0 || this.#pendingServerRequests.size > 0;
  }

  get snapshot(): BackgroundWorkSnapshot {
    const startedAtValues = [
      ...Array.from(this.#activeTurns.values(), (turn) => turn.startedAtMs),
      ...Array.from(this.#pendingServerRequests.values(), (request) => request.startedAtMs),
    ];
    return {
      active: this.active,
      activeTurnCount: this.#activeTurns.size,
      pendingServerRequestCount: this.#pendingServerRequests.size,
      oldestStartedAtMs: startedAtValues.length === 0 ? null : Math.min(...startedAtValues),
    };
  }

  observeServerRequest(request: JsonRpcRequest, nowMs = Date.now()): void {
    const params = recordValue(request.params);
    const prior = this.snapshot;
    this.#pendingServerRequests.set(request.id, {
      requestId: request.id,
      threadId: stringValue(params.threadId),
      turnId: stringValue(params.turnId),
      startedAtMs: nowMs,
    });
    this.#publishIfChanged(prior);
  }

  observeClientResponse(response: JsonRpcResponse): void {
    const prior = this.snapshot;
    this.#pendingServerRequests.delete(response.id);
    this.#publishIfChanged(prior);
  }

  observeNotification(notification: JsonRpcNotification, nowMs = Date.now()): void {
    const prior = this.snapshot;
    const params = recordValue(notification.params);
    if (notification.method === 'turn/started') {
      const turn = recordValue(params.turn);
      const turnId = stringValue(turn.id);
      if (turnId !== null) {
        const threadId = stringValue(params.threadId) ?? stringValue(turn.threadId);
        const key = turnKey(threadId, turnId);
        this.#activeTurns.set(key, { key, threadId, turnId, startedAtMs: nowMs });
      }
    } else if (notification.method === 'turn/completed') {
      const turn = recordValue(params.turn);
      const turnId = stringValue(turn.id);
      const threadId = stringValue(params.threadId) ?? stringValue(turn.threadId);
      if (turnId !== null) this.#removeTurn(threadId, turnId);
      this.#removeRequestsForTurn(threadId, turnId);
    } else if (notification.method === 'serverRequest/resolved') {
      const requestId = params.requestId;
      if (isJsonRpcId(requestId)) this.#pendingServerRequests.delete(requestId);
    } else if (notification.method === 'thread/deleted') {
      const threadId = stringValue(params.threadId);
      if (threadId !== null) this.#removeThread(threadId);
    }
    this.#publishIfChanged(prior);
  }

  clear(): void {
    const prior = this.snapshot;
    this.#activeTurns.clear();
    this.#pendingServerRequests.clear();
    this.#publishIfChanged(prior);
  }

  #removeTurn(threadId: string | null, turnId: string): void {
    if (threadId !== null) {
      this.#activeTurns.delete(turnKey(threadId, turnId));
      return;
    }
    for (const [key, turn] of this.#activeTurns) {
      if (turn.turnId === turnId) this.#activeTurns.delete(key);
    }
  }

  #removeRequestsForTurn(threadId: string | null, turnId: string | null): void {
    for (const [requestId, request] of this.#pendingServerRequests) {
      const matchesTurn = turnId !== null && request.turnId === turnId;
      const matchesThread = threadId !== null && request.threadId === threadId;
      if (matchesTurn || matchesThread) this.#pendingServerRequests.delete(requestId);
    }
  }

  #removeThread(threadId: string): void {
    for (const [key, turn] of this.#activeTurns) {
      if (turn.threadId === threadId) this.#activeTurns.delete(key);
    }
    for (const [requestId, request] of this.#pendingServerRequests) {
      if (request.threadId === threadId) this.#pendingServerRequests.delete(requestId);
    }
  }

  #publishIfChanged(prior: BackgroundWorkSnapshot): void {
    const next = this.snapshot;
    if (
      prior.active === next.active &&
      prior.activeTurnCount === next.activeTurnCount &&
      prior.pendingServerRequestCount === next.pendingServerRequestCount &&
      prior.oldestStartedAtMs === next.oldestStartedAtMs
    ) {
      return;
    }
    this.#onChanged(next);
  }
}

function turnKey(threadId: string | null, turnId: string): string {
  return `${threadId ?? ''}\u0000${turnId}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value))
  );
}
