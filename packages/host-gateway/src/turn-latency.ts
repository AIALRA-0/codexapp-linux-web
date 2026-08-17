interface TurnLatencyEntry {
  firstOutputObserved: boolean;
  startedAtMs: number;
}

export interface TurnLatencyMeasurement {
  durationMs: number;
  kind: 'turn-complete' | 'turn-first-visible-output';
}

export class TurnLatencyTracker {
  #entries = new Map<string, TurnLatencyEntry>();
  #observe: (measurement: TurnLatencyMeasurement) => void;

  constructor(observe: (measurement: TurnLatencyMeasurement) => void) {
    this.#observe = observe;
  }

  start(paramsValue: unknown, startedAtMs = Date.now()): void {
    const threadId = threadIdFromParams(paramsValue);
    if (threadId === null) return;
    this.#entries.set(threadId, { firstOutputObserved: false, startedAtMs });
  }

  stop(paramsValue: unknown): void {
    const threadId = threadIdFromParams(paramsValue);
    if (threadId !== null) this.#entries.delete(threadId);
  }

  observeNotification(notificationValue: unknown, nowMs = Date.now()): void {
    const notification = recordValue(notificationValue);
    const params = recordValue(notification.params);
    const threadId = threadIdFromParams(params);
    if (threadId === null) return;
    if (notification.method === 'thread/deleted') {
      this.#entries.delete(threadId);
      return;
    }
    const entry = this.#entries.get(threadId);
    if (entry === undefined) return;
    if (isFirstVisibleAgentOutput(notification.method, params) && !entry.firstOutputObserved) {
      entry.firstOutputObserved = true;
      this.#observe({
        kind: 'turn-first-visible-output',
        durationMs: Math.max(0, nowMs - entry.startedAtMs),
      });
    }
    if (notification.method === 'turn/completed') {
      this.#observe({
        kind: 'turn-complete',
        durationMs: Math.max(0, nowMs - entry.startedAtMs),
      });
      this.#entries.delete(threadId);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

function isFirstVisibleAgentOutput(method: unknown, params: Record<string, unknown>): boolean {
  if (method === 'item/agentMessage/delta') return true;
  if (method !== 'item/completed') return false;
  return recordValue(params.item).type === 'agentMessage';
}

function threadIdFromParams(value: unknown): string | null {
  const params = recordValue(value);
  return typeof params.threadId === 'string' && params.threadId.length > 0 ? params.threadId : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
