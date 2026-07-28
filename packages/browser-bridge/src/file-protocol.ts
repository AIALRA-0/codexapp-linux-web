export function browserFileResourceUrl(value: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== 'app:' || url.hostname !== 'fs' || !url.pathname.startsWith('/@fs/')) {
    return value;
  }
  return new URL(`${url.pathname}${url.search}`, origin).href;
}

export function rewriteOfficialResourceAttribute(
  value: string,
  rewrite: (value: string) => string,
): string {
  return value
    .split(',')
    .map((candidate) => {
      const match = /^(\s*)(\S+)(.*)$/u.exec(candidate);
      if (match === null) return candidate;
      return `${match[1] ?? ''}${rewrite(match[2] ?? '')}${match[3] ?? ''}`;
    })
    .join(',');
}
