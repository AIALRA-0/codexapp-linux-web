import { describe, expect, it } from 'vitest';

import { isTerminalBridgeCloseCode } from './reconnect.js';

describe('browser bridge reconnect policy', () => {
  it.each([4400, 4401, 4403, 4408, 4409])('does not retry terminal close code %i', (code) => {
    expect(isTerminalBridgeCloseCode(code)).toBe(true);
  });

  it.each([1000, 1001, 1012, 4001, 4500])('can retry transient close code %i', (code) => {
    expect(isTerminalBridgeCloseCode(code)).toBe(false);
  });
});
