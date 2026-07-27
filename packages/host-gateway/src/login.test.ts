import { describe, expect, it } from 'vitest';

import { prepareRendererRequest, transformRendererResponse } from './login.js';

describe('browser-safe official ChatGPT login', () => {
  it('uses the official app-server device-code flow for the official sign-in button', () => {
    const prepared = prepareRendererRequest({
      id: 12,
      method: 'account/login/start',
      params: {
        type: 'chatgpt',
        appBrand: 'chatgpt',
        useHostedLoginSuccessPage: true,
      },
    });
    expect(prepared).toEqual({
      request: {
        id: 12,
        method: 'account/login/start',
        params: { type: 'chatgptDeviceCode' },
      },
      responseTransform: 'chatgpt-device-code',
    });
  });

  it('returns the response shape expected by the unmodified official renderer', () => {
    const response = transformRendererResponse(
      {
        id: 12,
        result: {
          type: 'chatgptDeviceCode',
          loginId: 'login-id',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-12345',
        },
      },
      'chatgpt-device-code',
    );
    expect(response).toEqual({
      id: 12,
      result: {
        type: 'chatgpt',
        loginId: 'login-id',
        authUrl: 'https://auth.openai.com/codex/device?user_code=ABCD-12345',
      },
    });
  });

  it('does not rewrite API-key login', () => {
    const request = {
      id: 13,
      method: 'account/login/start',
      params: { type: 'apiKey', apiKey: 'not-a-real-key' },
    };
    expect(prepareRendererRequest(request)).toEqual({ request });
  });
});
