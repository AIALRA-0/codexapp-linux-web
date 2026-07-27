export function officialExternalNavigationUrl(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null;
  const value = message as Record<string, unknown>;
  if (value.type !== 'open-in-browser' || typeof value.url !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  return url.toString();
}

export function isOfficialChatGptLoginRequest(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false;
  const value = message as Record<string, unknown>;
  if (value.type !== 'mcp-request' || !isRecord(value.request)) return false;
  return (
    value.request.method === 'account/login/start' &&
    isRecord(value.request.params) &&
    value.request.params.type === 'chatgpt'
  );
}

export function isOfficialChatGptLoginCancellation(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false;
  const value = message as Record<string, unknown>;
  return (
    value.type === 'mcp-request' &&
    isRecord(value.request) &&
    value.request.method === 'account/login/cancel'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
