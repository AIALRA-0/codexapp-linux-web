import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { preloadContractSchema } from '@codexapp/contracts';

const path = resolve(process.argv[2] ?? 'manifests/preload-contracts/preload-26.721.31836.json');
const contract = preloadContractSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
const expected = new Set([
  'getPreloadStartedAtMs',
  'sendMessageFromView',
  'getPathForFile',
  'startFileDrag',
  'sendWorkerMessageFromView',
  'subscribeToWorkerMessages',
  'showContextMenu',
  'getFastModeRolloutMetrics',
  'getSharedObjectSnapshotValue',
  'getInitialSidebarBootstrap',
  'getSystemThemeVariant',
  'subscribeToSystemThemeVariant',
  'triggerSentryTestError',
  'getSentryInitOptions',
  'getAppSessionId',
  'getBuildFlavor',
  'isDeviceCheckSupported',
  'isIntelMacBuild',
  'usesOwlAppShell',
]);

const observed = new Set(contract.methods);
const missing = [...observed].filter((method) => !expected.has(method));
const invented = [...expected].filter((method) => !observed.has(method));
if (missing.length > 0 || invented.length > 0) {
  throw new Error(
    `preload contract drift: unimplemented=${missing.join(',')}; absent-upstream=${invented.join(',')}`,
  );
}
process.stdout.write(
  `${JSON.stringify({ ok: true, rendererVersion: contract.rendererVersion, methods: observed.size })}\n`,
);
