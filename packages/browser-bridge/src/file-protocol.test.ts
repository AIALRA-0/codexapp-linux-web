import { describe, expect, it } from 'vitest';

import { browserFileResourceUrl, rewriteOfficialResourceAttribute } from './file-protocol.js';

describe('official app file protocol browser mapping', () => {
  it('maps the official app://fs URL to the authenticated same-origin file route', () => {
    expect(
      browserFileResourceUrl(
        'app://fs/@fs/srv/aialra/users/person/generated_images/thread/image%201.png?version=2',
        'https://codex.example/',
      ),
    ).toBe(
      'https://codex.example/@fs/srv/aialra/users/person/generated_images/thread/image%201.png?version=2',
    );
  });

  it.each([
    'https://cdn.openai.com/image.png',
    'data:image/png;base64,AQID',
    'app://other/@fs/private/file.png',
    'not a URL',
  ])('leaves unrelated resource URL unchanged: %s', (value) => {
    expect(browserFileResourceUrl(value, 'https://codex.example/')).toBe(value);
  });

  it('rewrites every official candidate in a srcset without changing its density descriptor', () => {
    const rewrite = (value: string): string =>
      browserFileResourceUrl(value, 'https://codex.example/');
    expect(
      rewriteOfficialResourceAttribute(
        'app://fs/@fs/srv/image.png 1x, app://fs/@fs/srv/image@2x.png 2x',
        rewrite,
      ),
    ).toBe(
      'https://codex.example/@fs/srv/image.png 1x, https://codex.example/@fs/srv/image@2x.png 2x',
    );
  });
});
