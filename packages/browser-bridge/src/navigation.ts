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
