const APP_SERVER_HISTORY_SNAPSHOTS_GATE = '416252813';
const INTERNATIONALIZATION_LAYER = '72216192';

interface FeatureGate {
  details?: Record<string, unknown>;
  name?: string;
  value?: boolean;
  [key: string]: unknown;
}

interface OverrideAdapter {
  getGateOverride?: (
    gate: FeatureGate,
    user?: unknown,
    options?: unknown,
  ) => FeatureGate | null | undefined;
  getLayerOverride?: (
    layer: FeatureLayer,
    user?: unknown,
    options?: unknown,
  ) => FeatureLayer | null | undefined;
  [key: string]: unknown;
}

interface FeatureLayer {
  __value?: Record<string, unknown>;
  details?: Record<string, unknown>;
  name?: string;
  [key: string]: unknown;
}

interface StatsigClient {
  overrideAdapter?: OverrideAdapter | null;
}

interface StatsigGlobal {
  firstInstance?: StatsigClient;
  instances?: Map<unknown, StatsigClient> | Record<string, StatsigClient>;
  [key: string]: unknown;
}

type StatsigScope = Record<string, unknown>;

/**
 * The unchanged official renderer already contains its recent-history snapshot
 * implementation, but OpenAI currently protects it with a remote rollout gate.
 * The Linux browser host supplies the matching official AppHost service, so it
 * opts that renderer path in through Statsig's own override-adapter seam. The
 * same official seam enables the renderer's bundled locale catalogs: without
 * it, a saved locale changes document.lang but leaves every label in English.
 */
export function installOfficialHistorySnapshotGate(scope: StatsigScope): () => void {
  const existingDescriptor = Object.getOwnPropertyDescriptor(scope, '__STATSIG__');
  let statsigGlobal = readDescriptorValue(scope, existingDescriptor);

  const decorateGlobal = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const global = value as StatsigGlobal;
    decorateStatsigClient(global.firstInstance);
    decorateInstances(global.instances);

    const instancesDescriptor = Object.getOwnPropertyDescriptor(global, 'instances');
    if (instancesDescriptor?.configurable !== false) {
      let instances = global.instances;
      Object.defineProperty(global, 'instances', {
        configurable: true,
        enumerable: instancesDescriptor?.enumerable ?? true,
        get: () => instances,
        set: (next: StatsigGlobal['instances']) => {
          instances = next;
          decorateInstances(next);
        },
      });
    }

    const firstInstanceDescriptor = Object.getOwnPropertyDescriptor(global, 'firstInstance');
    if (firstInstanceDescriptor?.configurable === false) return global;
    let firstInstance = global.firstInstance;
    Object.defineProperty(global, 'firstInstance', {
      configurable: true,
      enumerable: firstInstanceDescriptor?.enumerable ?? true,
      get: () => firstInstance,
      set: (client: StatsigClient | undefined) => {
        firstInstance = client;
        decorateStatsigClient(client);
      },
    });
    return global;
  };

  statsigGlobal = decorateGlobal(statsigGlobal);
  if (existingDescriptor?.configurable === false) return () => undefined;
  Object.defineProperty(scope, '__STATSIG__', {
    configurable: true,
    enumerable: existingDescriptor?.enumerable ?? false,
    get: () => statsigGlobal,
    set: (value: unknown) => {
      statsigGlobal = decorateGlobal(value);
    },
  });

  return () => {
    if (existingDescriptor === undefined) delete scope.__STATSIG__;
    else Object.defineProperty(scope, '__STATSIG__', existingDescriptor);
  };
}

function decorateInstances(
  instances: Map<unknown, StatsigClient> | Record<string, StatsigClient> | undefined,
): void {
  if (instances instanceof Map) {
    for (const client of instances.values()) decorateStatsigClient(client);
    if (isDecoratedInstancesMap(instances)) return;
    const originalSet = instances.set.bind(instances);
    Object.defineProperty(instances, 'set', {
      configurable: true,
      value(key: unknown, client: StatsigClient) {
        decorateStatsigClient(client);
        originalSet(key, client);
        return instances;
      },
      writable: true,
    });
    Object.defineProperty(instances, '__codexLinuxHistorySnapshotMapOverride', {
      configurable: true,
      value: true,
    });
    return;
  }
  if (instances !== undefined) {
    for (const client of Object.values(instances)) decorateStatsigClient(client);
  }
}

function isDecoratedInstancesMap(instances: Map<unknown, StatsigClient>): boolean {
  return (
    (
      instances as Map<unknown, StatsigClient> & {
        __codexLinuxHistorySnapshotMapOverride?: unknown;
      }
    ).__codexLinuxHistorySnapshotMapOverride === true
  );
}

function readDescriptorValue(
  scope: StatsigScope,
  descriptor: PropertyDescriptor | undefined,
): unknown {
  if (descriptor === undefined) return undefined;
  if ('value' in descriptor) return descriptor.value;
  return descriptor.get?.call(scope);
}

function decorateStatsigClient(client: StatsigClient | undefined): void {
  if (client === undefined || client === null || typeof client !== 'object') return;
  const previous = client.overrideAdapter;
  if (isHistorySnapshotOverride(previous)) return;

  const adapter = Object.create(previous ?? null) as OverrideAdapter;
  Object.defineProperty(adapter, '__codexLinuxHistorySnapshotOverride', {
    value: true,
  });
  adapter.getGateOverride = (gate, user, options) => {
    const officialOverride = previous?.getGateOverride?.(gate, user, options) ?? gate;
    if (officialOverride.name !== APP_SERVER_HISTORY_SNAPSHOTS_GATE) return officialOverride;
    return {
      ...officialOverride,
      details: {
        ...officialOverride.details,
        reason: 'LocalOverride',
      },
      value: true,
    };
  };
  adapter.getLayerOverride = (layer, user, options) => {
    const officialOverride = previous?.getLayerOverride?.(layer, user, options) ?? layer;
    if (officialOverride.name !== INTERNATIONALIZATION_LAYER) return officialOverride;
    return {
      ...officialOverride,
      __value: {
        ...officialOverride.__value,
        enable_i18n: true,
      },
      details: {
        ...officialOverride.details,
        reason: 'LocalOverride',
      },
    };
  };
  client.overrideAdapter = adapter;
}

function isHistorySnapshotOverride(adapter: OverrideAdapter | null | undefined): boolean {
  return adapter?.__codexLinuxHistorySnapshotOverride === true;
}
