import { describe, expect, it } from 'vitest';

import { OrderedBuffer } from './ordered-buffer.js';

describe('ordered buffer', () => {
  it('holds values until activation and flushes them in order', () => {
    const buffer = new OrderedBuffer<string>();
    const delivered: string[] = [];
    const deliver = (value: string): void => {
      delivered.push(value);
    };

    buffer.push('one', deliver);
    buffer.push('two', deliver);
    expect(buffer.size).toBe(2);
    expect(delivered).toEqual([]);

    buffer.activate(deliver);
    buffer.push('three', deliver);

    expect(buffer.active).toBe(true);
    expect(buffer.size).toBe(0);
    expect(delivered).toEqual(['one', 'two', 'three']);
  });

  it('fails closed when pre-activation input exceeds the limit', () => {
    const buffer = new OrderedBuffer<string>(1);
    buffer.push('one', () => undefined);
    expect(() => buffer.push('two', () => undefined)).toThrow(
      'ordered buffer limit exceeded before activation',
    );
  });

  it('can discard queued values after registration failure', () => {
    const buffer = new OrderedBuffer<string>();
    buffer.push('one', () => undefined);
    buffer.clear();
    expect(buffer.size).toBe(0);
  });
});
