const DEFAULT_TTL_MS = 10 * 60_000;

interface PrewarmedThreadEntry {
  originalStartedSuppressed: boolean;
  startedAtMs: number;
  thread: Record<string, unknown>;
  timeout: NodeJS.Timeout;
  visible: boolean;
}

interface PrewarmedThreadsOptions {
  deleteExpiredThread: (threadId: string) => void;
  publishThreadStarted: (notification: {
    method: 'thread/started';
    params: { thread: Record<string, unknown> };
  }) => void;
  ttlMs?: number;
}

export class OfficialPrewarmedThreads {
  #entries = new Map<string, PrewarmedThreadEntry>();
  #options: PrewarmedThreadsOptions;

  constructor(options: PrewarmedThreadsOptions) {
    this.#options = options;
  }

  trackResponse(responseValue: unknown, startedAtMs = Date.now()): void {
    const response = recordValue(responseValue);
    if (response.error !== undefined) return;
    const result = recordValue(response.result);
    const thread = recordValue(result.thread);
    if (typeof thread.id !== 'string' || thread.id.length === 0) return;
    const threadId = thread.id;
    this.stopTracking(threadId);
    const timeout = setTimeout(() => {
      const entry = this.#entries.get(threadId);
      this.#entries.delete(threadId);
      if (entry !== undefined && !entry.visible) this.#options.deleteExpiredThread(threadId);
    }, this.#options.ttlMs ?? DEFAULT_TTL_MS);
    timeout.unref();
    this.#entries.set(threadId, {
      originalStartedSuppressed: false,
      startedAtMs,
      thread,
      timeout,
      visible: false,
    });
  }

  publishForTurnStart(paramsValue: unknown, nowMs = Date.now()): number | null {
    const params = recordValue(paramsValue);
    if (typeof params.threadId !== 'string') return null;
    const entry = this.#entries.get(params.threadId);
    if (entry === undefined || entry.visible) return null;
    entry.visible = true;
    this.#options.publishThreadStarted({
      method: 'thread/started',
      params: { thread: entry.thread },
    });
    if (entry.originalStartedSuppressed) this.stopTracking(params.threadId);
    return Math.max(0, nowMs - entry.startedAtMs);
  }

  suppressThreadStarted(notificationValue: unknown): boolean {
    const notification = recordValue(notificationValue);
    if (notification.method !== 'thread/started') return false;
    const params = recordValue(notification.params);
    const thread = recordValue(params.thread);
    if (typeof thread.id !== 'string') return false;
    const entry = this.#entries.get(thread.id);
    if (entry === undefined) return false;
    entry.originalStartedSuppressed = true;
    if (entry.visible) this.stopTracking(thread.id);
    return true;
  }

  clear(): void {
    for (const entry of this.#entries.values()) clearTimeout(entry.timeout);
    this.#entries.clear();
  }

  stopTracking(threadId: string): void {
    const entry = this.#entries.get(threadId);
    if (entry === undefined) return;
    clearTimeout(entry.timeout);
    this.#entries.delete(threadId);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
