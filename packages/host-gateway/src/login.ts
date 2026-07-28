import { jsonRpcRequestSchema, type JsonRpcRequest } from '@codexapp/contracts';

export interface PreparedRendererRequest {
  request: JsonRpcRequest;
}

export function prepareRendererRequest(requestValue: unknown): PreparedRendererRequest {
  const request = jsonRpcRequestSchema.parse(requestValue);
  if (request.method !== 'account/login/start' || !isRecord(request.params)) {
    return { request };
  }
  if (request.params.type !== 'chatgpt') return { request };
  return {
    request: {
      ...request,
      params: { type: 'chatgptDeviceCode' },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
