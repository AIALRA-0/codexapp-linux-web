import { describe, expect, it } from 'vitest';

import {
  toOfficialRendererNotification,
  toOfficialRendererRequest,
} from './official-renderer-messages.js';

describe('official renderer app-server message contract', () => {
  it('flattens notifications for the current official renderer', () => {
    expect(
      toOfficialRendererNotification({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      }),
    ).toEqual({
      type: 'mcp-notification',
      hostId: 'local',
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    });
  });

  it('does not retain the obsolete nested notification envelope', () => {
    expect(toOfficialRendererNotification({ method: 'item/completed' })).not.toHaveProperty(
      'message',
    );
  });

  it('places server requests in the request property', () => {
    expect(
      toOfficialRendererRequest({
        id: 7,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'item-1' },
      }),
    ).toEqual({
      type: 'mcp-request',
      hostId: 'local',
      request: {
        id: 7,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'item-1' },
      },
    });
  });
});
