import { describe, expect, it } from 'vitest';

import {
  chunkOfficialHostMessage,
  hostMessageNeedsChunking,
  type OfficialChunkToken,
} from './chunked-message.js';

describe('official host chunked message compatibility', () => {
  it('preserves a nested large renderer message through the official token protocol', () => {
    const original = {
      type: 'mcp-response',
      message: {
        id: 'large-thread',
        result: {
          turns: Array.from({ length: 40 }, (_, index) => ({
            id: index,
            text: `${'中🙂\n'.repeat(12_000)}-${String(index)}`,
          })),
        },
      },
    };

    expect(hostMessageNeedsChunking(original)).toBe(true);
    const chunks = [
      ...chunkOfficialHostMessage(original, { transferId: 'fixed', wireBytes: 4096 }),
    ];
    expect(chunks[0]).toMatchObject({ kind: 'start', sequence: 0, transferId: 'fixed' });
    expect(chunks.at(-1)).toMatchObject({ kind: 'end', transferId: 'fixed' });
    expect(chunks.length).toBeGreaterThan(10);
    expect(
      assemble(chunks.flatMap((chunk) => (chunk.kind === 'chunk' ? chunk.tokens : []))),
    ).toEqual(original);
  });

  it('passes small messages without chunking and rejects cyclic values', () => {
    expect(hostMessageNeedsChunking({ type: 'small', value: 1 })).toBe(false);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => hostMessageNeedsChunking(cyclic)).toThrow(/cycle/u);
  });
});

function assemble(tokens: OfficialChunkToken[]): unknown {
  const unset = Symbol('unset');
  let root: unknown = unset;
  let stringChunks: string[] | null = null;
  let stringTarget: 'key' | 'value' | null = null;
  const stack: Array<
    | { type: 'array'; value: unknown[] }
    | { type: 'object'; value: Record<string, unknown>; key: string | null }
  > = [];
  const save = (value: unknown): void => {
    const container = stack.at(-1);
    if (container === undefined) {
      if (root !== unset) throw new Error('multiple roots');
      root = value;
    } else if (container.type === 'array') {
      container.value.push(value);
    } else {
      if (container.key === null) throw new Error('missing key');
      container.value[container.key] = value;
      container.key = null;
    }
  };
  const setKey = (key: string): void => {
    const container = stack.at(-1);
    if (container?.type !== 'object' || container.key !== null) throw new Error('invalid key');
    container.key = key;
  };
  for (const token of tokens) {
    switch (token.type) {
      case 'array-start': {
        const value: unknown[] = [];
        save(value);
        stack.push({ type: 'array', value });
        break;
      }
      case 'object-start': {
        const value: Record<string, unknown> = {};
        save(value);
        stack.push({ type: 'object', value, key: null });
        break;
      }
      case 'container-end':
        stack.pop();
        break;
      case 'key':
        setKey(token.value);
        break;
      case 'value':
        save(token.value);
        break;
      case 'string-start':
        stringChunks = [];
        stringTarget = token.target;
        break;
      case 'string-chunk':
        stringChunks?.push(token.value);
        break;
      case 'string-end': {
        const value = stringChunks?.join('') ?? '';
        if (stringTarget === 'key') setKey(value);
        else save(value);
        stringChunks = null;
        stringTarget = null;
        break;
      }
    }
  }
  if (root === unset || stack.length > 0 || stringChunks !== null) throw new Error('incomplete');
  return root;
}
