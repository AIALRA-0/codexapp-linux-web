export class ConnectionRateLimiter {
  readonly refillPerSecond: number;
  readonly capacity: number;
  #tokens: number;
  #lastRefillMs: number;

  constructor(refillPerSecond: number, capacity: number, nowMs = Date.now()) {
    if (
      !Number.isFinite(refillPerSecond) ||
      refillPerSecond <= 0 ||
      !Number.isFinite(capacity) ||
      capacity < 1
    ) {
      throw new Error('connection rate limiter values must be positive');
    }
    this.refillPerSecond = refillPerSecond;
    this.capacity = capacity;
    this.#tokens = capacity;
    this.#lastRefillMs = nowMs;
  }

  consume(nowMs = Date.now()): boolean {
    const elapsedMs = Math.max(0, nowMs - this.#lastRefillMs);
    this.#lastRefillMs = Math.max(this.#lastRefillMs, nowMs);
    this.#tokens = Math.min(
      this.capacity,
      this.#tokens + (elapsedMs / 1_000) * this.refillPerSecond,
    );
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
