import { describe, expect, it } from 'vitest';

import { ConnectionRateLimiter } from './rate-limit.js';

describe('per-connection rate limiter', () => {
  it('allows a bounded burst, rejects excess, and refills over time', () => {
    const limiter = new ConnectionRateLimiter(2, 3, 1_000);
    expect(limiter.consume(1_000)).toBe(true);
    expect(limiter.consume(1_000)).toBe(true);
    expect(limiter.consume(1_000)).toBe(true);
    expect(limiter.consume(1_000)).toBe(false);
    expect(limiter.consume(1_499)).toBe(false);
    expect(limiter.consume(1_500)).toBe(true);
    expect(limiter.consume(2_500)).toBe(true);
    expect(limiter.consume(2_500)).toBe(true);
    expect(limiter.consume(2_500)).toBe(false);
  });

  it('does not refill when the wall clock moves backwards', () => {
    const limiter = new ConnectionRateLimiter(1, 1, 5_000);
    expect(limiter.consume(5_000)).toBe(true);
    expect(limiter.consume(4_000)).toBe(false);
    expect(limiter.consume(6_000)).toBe(true);
  });
});
