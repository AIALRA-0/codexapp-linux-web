import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { preloadContractSchema } from '@codexapp/contracts';
import {
  extractElectronBridgeMethods,
  extractPreloadChannels,
  sha256Buffer,
} from '@codexapp/official-package';

const requestedContractPath = process.argv[2];
const requestedSourceRoot = process.env.OFFICIAL_SOURCE_ROOT;
const defaultRendererVersion = '26.721.81911';
const preliminarySourceRoot = resolve(
  requestedSourceRoot ?? join('.official', 'releases', defaultRendererVersion, 'source'),
);
const preliminaryPackageMetadata = JSON.parse(
  readFileSync(join(preliminarySourceRoot, 'package.json'), 'utf8'),
) as Record<string, unknown>;
const packageVersion = preliminaryPackageMetadata.version;
if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
  throw new Error('qualified official package version is missing');
}
const contractPath = resolve(
  requestedContractPath ?? join('manifests', 'preload-contracts', `preload-${packageVersion}.json`),
);
const contract = preloadContractSchema.parse(JSON.parse(readFileSync(contractPath, 'utf8')));
const officialSourceRoot = resolve(
  requestedSourceRoot ?? join('.official', 'releases', contract.rendererVersion, 'source'),
);
const packageMetadata =
  officialSourceRoot === preliminarySourceRoot
    ? preliminaryPackageMetadata
    : (JSON.parse(readFileSync(join(officialSourceRoot, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >);
const preloadBytes = readFileSync(join(officialSourceRoot, '.vite', 'build', 'preload.js'));
const preloadSource = preloadBytes.toString('utf8');
const sourceContract = preloadContractSchema.parse({
  contractVersion: contract.contractVersion,
  rendererVersion: packageMetadata.version,
  appBuildNumber: packageMetadata.codexBuildNumber,
  windowType: 'electron',
  methods: extractElectronBridgeMethods(preloadSource),
  channels: extractPreloadChannels(preloadSource),
  sourceSha256: sha256Buffer(preloadBytes),
});

const sourceDifferences = [
  contract.rendererVersion === sourceContract.rendererVersion
    ? undefined
    : `rendererVersion expected=${contract.rendererVersion} actual=${sourceContract.rendererVersion}`,
  contract.appBuildNumber === sourceContract.appBuildNumber
    ? undefined
    : `appBuildNumber expected=${contract.appBuildNumber} actual=${sourceContract.appBuildNumber}`,
  JSON.stringify([...contract.methods].sort()) === JSON.stringify(sourceContract.methods)
    ? undefined
    : `methods expected=${[...contract.methods].sort().join(',')} actual=${sourceContract.methods.join(',')}`,
  JSON.stringify([...contract.channels].sort()) === JSON.stringify(sourceContract.channels)
    ? undefined
    : `channels expected=${[...contract.channels].sort().join(',')} actual=${sourceContract.channels.join(',')}`,
  contract.sourceSha256 === sourceContract.sourceSha256
    ? undefined
    : `sourceSha256 expected=${contract.sourceSha256} actual=${sourceContract.sourceSha256}`,
].filter((difference): difference is string => difference !== undefined);
if (sourceDifferences.length > 0) {
  throw new Error(
    `qualified official preload does not match contract: ${sourceDifferences.join('; ')}`,
  );
}

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
  `${JSON.stringify({
    ok: true,
    rendererVersion: contract.rendererVersion,
    appBuildNumber: contract.appBuildNumber,
    methods: observed.size,
    sourceVerified: true,
  })}\n`,
);
