import { describe, expect, it, vi } from 'vitest';

import { installOfficialHistorySnapshotGate } from './official-feature-gates.js';

describe('official renderer feature overrides', () => {
  it('keeps the experimental history snapshot path off and enables official locales', () => {
    const scope: Record<string, unknown> = {};
    const restore = installOfficialHistorySnapshotGate(scope);
    const statsig = {} as { firstInstance?: { overrideAdapter?: Record<string, unknown> } };
    scope.__STATSIG__ = statsig;
    statsig.firstInstance = {};

    const override = statsig.firstInstance.overrideAdapter?.getGateOverride as (
      gate: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(override({ name: '416252813', value: true, details: { reason: 'Network' } })).toEqual({
      name: '416252813',
      value: false,
      details: { reason: 'LocalOverride' },
    });
    expect(override({ name: 'unrelated', value: false })).toEqual({
      name: 'unrelated',
      value: false,
    });
    const layerOverride = statsig.firstInstance.overrideAdapter?.getLayerOverride as (
      layer: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(
      layerOverride({
        name: '72216192',
        __value: { enable_i18n: false, locale_source: 'IDE' },
        details: { reason: 'Network' },
      }),
    ).toEqual({
      name: '72216192',
      __value: { enable_i18n: true, locale_source: 'IDE' },
      details: { reason: 'LocalOverride' },
    });
    expect(layerOverride({ name: 'unrelated', __value: { enabled: false } })).toEqual({
      name: 'unrelated',
      __value: { enabled: false },
    });
    const dynamicConfigOverride = statsig.firstInstance.overrideAdapter
      ?.getDynamicConfigOverride as (config: Record<string, unknown>) => Record<string, unknown>;
    const paginatedHistory = dynamicConfigOverride({
      name: '1865103671',
      __value: { enabled: false, page_size: 5 },
      details: { reason: 'Network' },
      get: (key: string, fallback: unknown) =>
        key === 'page_size' ? 5 : key === 'enabled' ? false : fallback,
    });
    expect(paginatedHistory).toMatchObject({
      __value: { enabled: true, page_size: 5 },
      details: { reason: 'LocalOverride' },
    });
    const paginatedHistoryGet = paginatedHistory.get as (key: string, fallback: unknown) => unknown;
    expect(paginatedHistoryGet('enabled', false)).toBe(true);
    expect(paginatedHistoryGet('page_size', 0)).toBe(5);

    restore();
    expect('__STATSIG__' in scope).toBe(false);
  });

  it('preserves an existing official override adapter', () => {
    const originalOverride = vi.fn((gate: Record<string, unknown>) => ({
      ...gate,
      value: gate.name === 'official-gate',
    }));
    const originalLayerOverride = vi.fn((layer: Record<string, unknown>) => ({
      ...layer,
      __value: { official: true },
    }));
    const originalDynamicConfigOverride = vi.fn((config: Record<string, unknown>) => ({
      ...config,
      __value: { official: true },
      get: (key: string, fallback: unknown) => (key === 'official' ? true : fallback),
    }));
    const client = {
      overrideAdapter: {
        getGateOverride: originalOverride,
        getDynamicConfigOverride: originalDynamicConfigOverride,
        getLayerOverride: originalLayerOverride,
        marker: 'official',
      },
    };
    const scope: Record<string, unknown> = {
      __STATSIG__: { firstInstance: client },
    };
    installOfficialHistorySnapshotGate(scope);

    const override = client.overrideAdapter.getGateOverride;
    expect(override({ name: 'official-gate', value: false })).toMatchObject({ value: true });
    expect(override({ name: '416252813', value: true })).toMatchObject({ value: false });
    expect(
      client.overrideAdapter.getLayerOverride({
        name: '72216192',
        __value: { enable_i18n: false },
      }),
    ).toMatchObject({ __value: { enable_i18n: true, official: true } });
    expect(client.overrideAdapter.marker).toBe('official');
    expect(originalOverride).toHaveBeenCalledTimes(2);
    const paginatedHistory = client.overrideAdapter.getDynamicConfigOverride?.({
      name: '1865103671',
      __value: { enabled: false },
    }) as Record<string, unknown>;
    expect(paginatedHistory).toMatchObject({ __value: { enabled: true, official: true } });
    expect(
      (paginatedHistory.get as (key: string, fallback: unknown) => unknown)('official', false),
    ).toBe(true);
    expect(originalDynamicConfigOverride).toHaveBeenCalledOnce();
    expect(originalLayerOverride).toHaveBeenCalledTimes(1);
  });

  it('decorates clients registered through the instances collection', () => {
    const client: { overrideAdapter?: Record<string, unknown> } = {};
    const scope: Record<string, unknown> = {};
    installOfficialHistorySnapshotGate(scope);
    scope.__STATSIG__ = { instances: { web: client } };

    expect(typeof client.overrideAdapter?.getGateOverride).toBe('function');
  });

  it('decorates clients added later to the Statsig instances map', () => {
    const instances = new Map<string, { overrideAdapter?: Record<string, unknown> }>();
    const scope: Record<string, unknown> = {};
    installOfficialHistorySnapshotGate(scope);
    scope.__STATSIG__ = { instances };
    const client: { overrideAdapter?: Record<string, unknown> } = {};

    instances.set('web', client);

    const override = client.overrideAdapter?.getGateOverride as (
      gate: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(override({ name: '416252813', value: false })).toMatchObject({ value: false });
  });

  it('decorates an instances collection assigned after the global object', () => {
    const scope: Record<string, unknown> = {};
    installOfficialHistorySnapshotGate(scope);
    const statsig: {
      instances?: Map<string, { overrideAdapter?: Record<string, unknown> }>;
    } = {};
    scope.__STATSIG__ = statsig;
    const client: { overrideAdapter?: Record<string, unknown> } = {};

    statsig.instances = new Map([['web', client]]);

    expect(typeof client.overrideAdapter?.getGateOverride).toBe('function');
  });
});
