import { describe, expect, it } from 'vitest';

import {
  isOfficialChatGptLoginCancellation,
  isOfficialChatGptLoginRequest,
  officialExternalNavigationUrl,
} from './navigation.js';

describe('official external browser navigation', () => {
  it('accepts the official OpenAI device authorization URL', () => {
    expect(
      officialExternalNavigationUrl({
        type: 'open-in-browser',
        url: 'https://auth.openai.com/codex/device?user_code=ABCD-12345',
      }),
    ).toBe('https://auth.openai.com/codex/device?user_code=ABCD-12345');
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.com/'])(
    'rejects unsafe external URL %s',
    (url) => {
      expect(officialExternalNavigationUrl({ type: 'open-in-browser', url })).toBeNull();
    },
  );

  it('recognizes the official interactive ChatGPT login request', () => {
    expect(
      isOfficialChatGptLoginRequest({
        type: 'mcp-request',
        request: {
          method: 'account/login/start',
          params: { type: 'chatgpt' },
        },
      }),
    ).toBe(true);
    expect(
      isOfficialChatGptLoginRequest({
        type: 'mcp-request',
        request: {
          method: 'account/login/start',
          params: { type: 'apiKey' },
        },
      }),
    ).toBe(false);
  });

  it('recognizes official login cancellation', () => {
    expect(
      isOfficialChatGptLoginCancellation({
        type: 'mcp-request',
        request: { method: 'account/login/cancel', params: { loginId: 'one' } },
      }),
    ).toBe(true);
  });
});
