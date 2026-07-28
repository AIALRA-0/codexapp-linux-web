import { describe, expect, it } from 'vitest';

import { prepareRendererRequest } from './login.js';

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
