import { describe, expect, it } from 'vitest';

import {
  codexVersionFromOutput,
  initialRouteForAuthMethod,
  officialWebStaticDesktopResponse,
} from './runtime.js';

describe('official renderer initial route selection', () => {
  it('opens the official login route only when the app server has no auth method', () => {
    expect(initialRouteForAuthMethod(null)).toBe('/login');
    expect(initialRouteForAuthMethod(undefined)).toBe('/login');
    expect(initialRouteForAuthMethod('')).toBe('/login');
  });

  it('opens the official primary shell for every app-server auth method', () => {
    expect(initialRouteForAuthMethod('chatgpt')).toBe('/');
    expect(initialRouteForAuthMethod('apikey')).toBe('/');
  });
});

describe('Codex CLI version qualification', () => {
  it('ignores unrelated cold-start warnings while preserving exact version matching', () => {
    expect(
      codexVersionFromOutput(
        'codex-cli 0.146.0-alpha.3.1\n',
        'WARNING: proceeding, even though PATH aliases could not be created\n',
      ),
    ).toBe('codex-cli 0.146.0-alpha.3.1');
  });

  it('does not accept a version embedded inside arbitrary output', () => {
    expect(codexVersionFromOutput('', 'warning for codex-cli 0.146.0-alpha.3.1')).toBeNull();
  });
});

describe('official web-only desktop fallbacks', () => {
  it('returns the exact empty contracts for unavailable native discovery sources', () => {
    expect(officialWebStaticDesktopResponse('recommended-skills')).toEqual({ skills: [] });
    expect(officialWebStaticDesktopResponse('external-agent-imported-connectors')).toEqual({
      connectors: [],
    });
    expect(officialWebStaticDesktopResponse('email-domain-mail-provider')).toEqual({
      provider: 'other',
    });
    expect(officialWebStaticDesktopResponse('unknown-method')).toBeUndefined();
  });
});
