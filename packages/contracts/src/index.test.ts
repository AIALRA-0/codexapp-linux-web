import { describe, expect, it } from 'vitest';

import {
  CONTRACT_VERSION,
  clientFrameSchema,
  jsonRpcResponseSchema,
  runtimeBootstrapSchema,
} from './index.js';

describe('wire contracts', () => {
  it('rejects a frame from an unknown protocol version', () => {
    expect(() =>
      clientFrameSchema.parse({
        contractVersion: CONTRACT_VERSION + 1,
        sequence: 0,
        type: 'ack',
        hostSequence: 0,
      }),
    ).toThrow();
  });

  it('requires one JSON-RPC result branch', () => {
    expect(() => jsonRpcResponseSchema.parse({ id: 1 })).toThrow();
    expect(() => jsonRpcResponseSchema.parse({ id: 1, result: null })).not.toThrow();
  });

  it('rejects incomplete browser bootstrap state', () => {
    expect(() => runtimeBootstrapSchema.parse({ contractVersion: CONTRACT_VERSION })).toThrow();
  });
});
