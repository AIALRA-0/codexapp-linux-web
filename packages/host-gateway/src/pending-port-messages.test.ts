import { describe, expect, it } from 'vitest';

import { PendingPortMessages } from './pending-port-messages.js';

describe('pending AppHost port messages', () => {
  it('preserves messages that arrive before their port registration', () => {
    const pending = new PendingPortMessages();
    const delivered: unknown[] = [];
    pending.queue('port-one', 'one');
    pending.queue('port-one', 'two');

    pending.drain('port-one', (message) => delivered.push(message));

    expect(delivered).toEqual(['one', 'two']);
    expect(pending.messageCount).toBe(0);
  });

  it('bounds unknown ports and queued messages', () => {
    const ports = new PendingPortMessages(1, 2);
    ports.queue('port-one', 'one');
    expect(() => ports.queue('port-two', 'two')).toThrow('pending AppHost port limit exceeded');

    ports.queue('port-one', 'two');
    expect(() => ports.queue('port-one', 'three')).toThrow(
      'pending AppHost message limit exceeded',
    );
  });
});
