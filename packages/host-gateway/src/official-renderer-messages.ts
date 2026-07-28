import type { JsonRpcNotification, JsonRpcRequest } from '@codexapp/contracts';

export interface OfficialRendererNotificationMessage {
  type: 'mcp-notification';
  hostId: 'local';
  method: string;
  params?: unknown;
}

export interface OfficialRendererRequestMessage {
  type: 'mcp-request';
  hostId: 'local';
  request: JsonRpcRequest;
}

/**
 * Keep this shape aligned with the currently bundled official renderer.
 *
 * Notifications are deliberately flattened. The official renderer reads
 * `method` and `params` directly from the window message; the older
 * `{ message: { method, params } }` envelope is silently ignored.
 */
export function toOfficialRendererNotification(
  notification: JsonRpcNotification,
): OfficialRendererNotificationMessage {
  return {
    type: 'mcp-notification',
    hostId: 'local',
    method: notification.method,
    ...(notification.params === undefined ? {} : { params: notification.params }),
  };
}

/**
 * Server-initiated JSON-RPC requests use the `request` property in the
 * official renderer contract. This is intentionally different from
 * `mcp-response`, whose payload remains in `message`.
 */
export function toOfficialRendererRequest(request: JsonRpcRequest): OfficialRendererRequestMessage {
  return {
    type: 'mcp-request',
    hostId: 'local',
    request,
  };
}
