import { describe, expect, it } from 'vitest';

import { isReloadBridgeCloseCode, isTerminalBridgeCloseCode } from './reconnect.js';

describe('browser bridge reconnect policy', () => {
  it.each([4400, 4401, 4403, 4408, 4409])('does not retry terminal close code %i', (code) => {
    expect(isTerminalBridgeCloseCode(code)).toBe(true);
  });

  it.each([1000, 1001, 1012, 4001, 4500])('can retry transient close code %i', (code) => {
    expect(isTerminalBridgeCloseCode(code)).toBe(false);
  });

  it('reloads only when the server-side browser session no longer exists', () => {
    expect(isReloadBridgeCloseCode(4410)).toBe(true);
    for (const code of [1000, 4400, 4401, 4403, 4408, 4409, 4429, 4500]) {
      expect(isReloadBridgeCloseCode(code)).toBe(false);
    }
  });
});
