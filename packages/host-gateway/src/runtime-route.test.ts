import { describe, expect, it } from 'vitest';

import {
  codexVersionFromOutput,
  initialRouteForAuthMethod,
  isExpectedAppServerResponseError,
  officialWebStaticDesktopResponse,
  rendererRequestFingerprint,
  rendererRequestShape,
} from './runtime.js';

describe('renderer request diagnostics', () => {
  it('identifies equal parameter records without logging their values', () => {
    const first = rendererRequestFingerprint({ cwds: ['/workspace'], marketplaceKinds: null });
    const reordered = rendererRequestFingerprint({ marketplaceKinds: null, cwds: ['/workspace'] });
    const different = rendererRequestFingerprint({ cwds: ['/other'], marketplaceKinds: null });
    expect(first).toMatch(/^[a-f0-9]{12}$/u);
    expect(reordered).toBe(first);
    expect(different).not.toBe(first);
  });

  it('records only non-sensitive plugin request structure', () => {
    expect(
      rendererRequestShape('plugin/list', {
        cwds: ['/private/workspace'],
        marketplaceKinds: ['system'],
      }),
    ).toEqual({
      cwdCount: 1,
      cwdsProvided: true,
      marketplaceKindCount: 1,
      marketplaceKindsProvided: true,
    });
    expect(rendererRequestShape('thread/list', { cwd: '/private/workspace' })).toBeUndefined();
  });
});

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

describe('expected official app-server responses', () => {
  it('does not classify an ordinary missing optional file as a host capability failure', () => {
    expect(
      isExpectedAppServerResponseError(
        'fs/readFile',
        -32_603,
        'No such file or directory (os error 2)',
      ),
    ).toBe(true);
    expect(isExpectedAppServerResponseError('fs/readFile', -32_603, 'Permission denied')).toBe(
      false,
    );
    expect(isExpectedAppServerResponseError('app/list', -32_603, '403 Forbidden')).toBe(false);
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
    expect(officialWebStaticDesktopResponse('ambient-suggestions')).toEqual({
      file: { currentSuggestionIds: [], suggestions: [] },
    });
    expect(officialWebStaticDesktopResponse('fast-mode-rollout-metrics')).toEqual({
      estimatedSavedMs: 0,
      rolloutCountWithCompletedTurns: 0,
    });
    expect(officialWebStaticDesktopResponse('unknown-method')).toBeUndefined();
  });
});
