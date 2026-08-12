import { describe, expect, it } from 'vitest';

import {
  codexVersionFromOutput,
  historySnapshotPrincipalFromCodexAuth,
  initialRouteForAuthMethod,
  isExpectedAppServerResponseError,
  officialWebStaticDesktopResponse,
  rendererRequestFingerprint,
  rendererRequestShape,
  rendererNotificationCacheInvalidationPrefixes,
  rendererResponseCanBeCached,
  rendererResponseCacheKey,
  rendererResponseCacheInvalidationPrefixes,
  rendererResponseCacheTtlMs,
  threadResumeHasMaterialOverrides,
  threadResumeOverrideFingerprint,
} from './runtime.js';

function accessToken(authClaims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(authClaims)).toString('base64url')}.signature`;
}

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
    expect(
      rendererRequestShape('thread/resume', {
        threadId: 'thread-1',
        cwd: '/private/workspace',
      }),
    ).toEqual({
      parameterFingerprints: {
        cwd: rendererRequestFingerprint('/private/workspace'),
        threadId: rendererRequestFingerprint('thread-1'),
      },
      parameterKeys: ['cwd', 'threadId'],
    });
  });

  it('caches only slow read-only discovery requests for bounded periods', () => {
    expect(rendererResponseCacheTtlMs('plugin/list')).toBe(6 * 60 * 60 * 1_000);
    expect(rendererResponseCacheTtlMs('plugin/installed')).toBe(6 * 60 * 60 * 1_000);
    expect(rendererResponseCacheTtlMs('app/installed')).toBe(5 * 60 * 1_000);
    expect(rendererResponseCacheTtlMs('mcpServerStatus/list')).toBe(5 * 60 * 1_000);
    expect(
      rendererResponseCacheTtlMs('thread/resume', {
        excludeTurns: true,
        initialTurnsPage: { limit: 5, itemsView: 'full', sortDirection: 'desc' },
      }),
    ).toBe(24 * 60 * 60 * 1_000);
    expect(rendererResponseCacheTtlMs('thread/resume', { excludeTurns: false })).toBeNull();
    expect(rendererResponseCacheTtlMs('thread/list')).toBeNull();
    expect(rendererResponseCacheTtlMs('turn/start')).toBeNull();
  });

  it('caches only idle bounded thread resume responses', () => {
    expect(
      rendererResponseCanBeCached('thread/resume', {
        thread: { status: { type: 'idle' } },
        initialTurnsPage: { data: [] },
      }),
    ).toBe(true);
    expect(
      rendererResponseCanBeCached('thread/resume', {
        thread: { status: { type: 'active' } },
        initialTurnsPage: { data: [] },
      }),
    ).toBe(false);
    expect(
      rendererResponseCanBeCached('thread/resume', {
        thread: { status: { type: 'idle' } },
        initialTurnsPage: { data: [{ text: 'x'.repeat(8 * 1024 * 1024) }] },
      }),
    ).toBe(false);
  });

  it('reuses a resumed thread only when the later request supplies no new overrides', () => {
    const base = {
      threadId: 'thread-1',
      cwd: '/workspace',
      path: '/rollout.jsonl',
      history: null,
      excludeTurns: true,
      initialTurnsPage: { limit: 5, itemsView: 'full', sortDirection: 'desc' },
    };
    const first = {
      ...base,
      model: null,
      modelProvider: null,
      config: { feature: true },
      developerInstructions: 'current instructions',
      personality: 'friendly',
    };
    const later = {
      ...base,
      model: null,
      modelProvider: null,
      personality: null,
    };
    expect(rendererResponseCacheKey('thread/resume', first)).toBe(
      rendererResponseCacheKey('thread/resume', later),
    );
    expect(threadResumeHasMaterialOverrides(first)).toBe(true);
    expect(threadResumeHasMaterialOverrides(later)).toBe(false);
    expect(threadResumeHasMaterialOverrides({ ...later, model: 'gpt-new' })).toBe(true);
    expect(threadResumeOverrideFingerprint(first)).not.toBe(threadResumeOverrideFingerprint(later));
    expect(threadResumeOverrideFingerprint(first)).toBe(
      threadResumeOverrideFingerprint({ ...first }),
    );
    expect(threadResumeOverrideFingerprint(first)).not.toBe(
      threadResumeOverrideFingerprint({ ...first, personality: 'concise' }),
    );
  });

  it('invalidates discovery caches for official mutations and account changes', () => {
    expect(rendererResponseCacheInvalidationPrefixes('plugin/install')).toEqual([
      'plugin/',
      'app/',
    ]);
    expect(rendererResponseCacheInvalidationPrefixes('plugin/uninstall')).toEqual([
      'plugin/',
      'app/',
    ]);
    expect(rendererResponseCacheInvalidationPrefixes('config/value/write')).toEqual([
      'mcpServerStatus/',
    ]);
    expect(rendererResponseCacheInvalidationPrefixes('mcpServer/oauth/login')).toEqual([
      'mcpServerStatus/',
    ]);
    expect(rendererResponseCacheInvalidationPrefixes('account/login/start')).toEqual(['']);
    expect(rendererResponseCacheInvalidationPrefixes('account/logout')).toEqual(['']);
    expect(rendererResponseCacheInvalidationPrefixes('turn/start')).toEqual(['thread/resume:']);
    expect(rendererResponseCacheInvalidationPrefixes('thread/name/set')).toEqual([
      'thread/resume:',
    ]);
    expect(rendererResponseCacheInvalidationPrefixes('thread/read')).toEqual([]);
    expect(rendererResponseCacheInvalidationPrefixes('thread/resume')).toEqual([]);
    expect(rendererResponseCacheInvalidationPrefixes('thread/unsubscribe')).toEqual([
      'thread/resume:',
    ]);
    expect(rendererResponseCacheInvalidationPrefixes('plugin/list')).toEqual([]);
  });

  it('does not discard a completed resume cache for status-only notifications', () => {
    expect(rendererNotificationCacheInvalidationPrefixes('thread/status/changed')).toEqual([]);
    expect(rendererNotificationCacheInvalidationPrefixes('thread/started')).toEqual([]);
    expect(rendererNotificationCacheInvalidationPrefixes('turn/started')).toEqual([
      'thread/resume:',
    ]);
    expect(rendererNotificationCacheInvalidationPrefixes('turn/completed')).toEqual([
      'thread/resume:',
    ]);
    expect(rendererNotificationCacheInvalidationPrefixes('thread/deleted')).toEqual([
      'thread/resume:',
    ]);
  });
});

describe('history snapshot account isolation', () => {
  it('reads the persisted Codex account without waiting for app-server startup', () => {
    expect(
      historySnapshotPrincipalFromCodexAuth({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: accessToken({
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'account-1',
              chatgpt_user_id: 'user-1',
            },
          }),
        },
      }),
    ).toEqual({ accountId: 'account-1', userId: 'user-1' });
  });

  it('does not expose snapshots for API-key or malformed persisted auth', () => {
    expect(
      historySnapshotPrincipalFromCodexAuth({
        auth_mode: 'apikey',
        tokens: { access_token: accessToken({}) },
      }),
    ).toBeNull();
    expect(
      historySnapshotPrincipalFromCodexAuth({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'not-a-jwt' },
      }),
    ).toBeNull();
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
    expect(officialWebStaticDesktopResponse('native-desktop-apps')).toEqual({ apps: [] });
    expect(officialWebStaticDesktopResponse('native-desktop-app-by-bundle-id')).toEqual({
      app: null,
    });
    expect(officialWebStaticDesktopResponse('native-desktop-app-icon')).toEqual({
      iconSmall: null,
    });
    expect(officialWebStaticDesktopResponse('computer-use-frontmost-window')).toBeNull();
    expect(officialWebStaticDesktopResponse('unknown-method')).toBeUndefined();
  });
});
