import {
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@codexapp/contracts';

export type RendererResponseTransform = 'chatgpt-device-code';

export interface PreparedRendererRequest {
  request: JsonRpcRequest;
  responseTransform?: RendererResponseTransform;
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
    responseTransform: 'chatgpt-device-code',
  };
}

export function transformRendererResponse(
  responseValue: unknown,
  transform: RendererResponseTransform | undefined,
): JsonRpcResponse {
  const response = jsonRpcResponseSchema.parse(responseValue);
  if (transform !== 'chatgpt-device-code' || response.error !== undefined) return response;
  if (!isRecord(response.result)) {
    throw new Error('device-code login returned an invalid result');
  }
  const { loginId, type, userCode, verificationUrl } = response.result;
  if (
    type !== 'chatgptDeviceCode' ||
    typeof loginId !== 'string' ||
    typeof userCode !== 'string' ||
    !/^[A-Za-z0-9]+-[A-Za-z0-9]+$/u.test(userCode) ||
    typeof verificationUrl !== 'string'
  ) {
    throw new Error('device-code login response is missing required fields');
  }
  const authUrl = new URL(verificationUrl);
  if (
    authUrl.protocol !== 'https:' ||
    authUrl.username !== '' ||
    authUrl.password !== '' ||
    authUrl.hostname !== 'auth.openai.com'
  ) {
    throw new Error('device-code login returned an untrusted verification URL');
  }
  authUrl.searchParams.set('user_code', userCode);
  authUrl.hash = '';
  return jsonRpcResponseSchema.parse({
    ...response,
    result: {
      type: 'chatgpt',
      loginId,
      authUrl: authUrl.toString(),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
