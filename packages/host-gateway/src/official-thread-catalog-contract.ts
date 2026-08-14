import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

import { readQualifiedOfficialVersion } from './official-export-contract.js';
import { readQualifiedMainSource } from './official-main-contract.js';
import { resolveOfficialSharedModulePath } from './official-shared-module.js';

export interface QualifiedThreadCatalogContract {
  convertThread: (thread: unknown, hostId: string) => unknown;
  sourceKinds: unknown[];
}

interface OldOfficialThreadCatalogModule {
  Fi?: unknown;
  o?: unknown;
}

interface LatestOfficialThreadCatalogModule {
  Di?: unknown;
  wi?: unknown;
  _i?: unknown;
}

export function loadQualifiedThreadCatalogContract(
  sourceRoot: string,
): QualifiedThreadCatalogContract {
  const qualifiedSourceRoot = resolve(sourceRoot);
  const version = readQualifiedOfficialVersion(qualifiedSourceRoot);
  const officialRequire = createRequire(resolve(qualifiedSourceRoot, 'package.json'));
  const sharedPath = resolveOfficialSharedModulePath(qualifiedSourceRoot);
  if (version === '26.721.81911') {
    const shared = officialRequire(sharedPath) as OldOfficialThreadCatalogModule;
    if (typeof shared.o !== 'function' || !Array.isArray(shared.Fi)) {
      throw new Error('qualified official thread catalog exports changed');
    }
    return {
      convertThread: shared.o as QualifiedThreadCatalogContract['convertThread'],
      sourceKinds: [...(shared.Fi as unknown[])],
    };
  }

  const shared = officialRequire(sharedPath) as LatestOfficialThreadCatalogModule;
  const sourceKinds =
    version === '26.810.41047'
      ? shared.Di
      : version === '26.803.81509'
        ? (shared as LatestOfficialThreadCatalogModule & { bi?: unknown }).bi
        : version === '26.730.61639'
          ? shared._i
          : shared.wi;
  if (!Array.isArray(sourceKinds)) {
    throw new Error('qualified official thread catalog source kinds changed');
  }
  const qualifiedSourceKinds = sourceKinds as unknown[];
  return {
    convertThread: loadLatestOfficialThreadConverter(qualifiedSourceRoot, version),
    sourceKinds: [...qualifiedSourceKinds],
  };
}

function loadLatestOfficialThreadConverter(
  sourceRoot: string,
  version: '26.727.51351' | '26.730.61639' | '26.803.81509' | '26.810.41047',
): QualifiedThreadCatalogContract['convertThread'] {
  const mainSource = readQualifiedMainSource(sourceRoot);
  const contract =
    version === '26.810.41047'
      ? {
          converterName: 'Rx',
          converterMarker: 'function Rx(e,t=Lx){if(e.ephemeral||e.parentThreadId!=null',
          endMarker: 'var Hx=`codex-notification`',
        }
      : version === '26.803.81509'
        ? {
            converterName: 'uS',
            converterMarker: 'function uS(e,t=lS){if(e.ephemeral||e.parentThreadId!=null',
            endMarker: 'var mS=`codex-notification`',
          }
        : version === '26.730.61639'
          ? {
              converterName: 'cS',
              converterMarker: 'function cS(e,t=sS){if(e.ephemeral||e.parentThreadId!=null',
              endMarker: 'var fS=`codex-notification`',
            }
          : {
              converterName: 'qx',
              converterMarker: 'function qx(e,t=Vx){if(e.ephemeral||e.parentThreadId!=null',
              endMarker: 'var Zx=`codex-notification`',
            };
  const { converterMarker } = contract;
  const converterIndex = mainSource.indexOf(converterMarker);
  if (
    converterIndex < 0 ||
    mainSource.indexOf(converterMarker, converterIndex + converterMarker.length) >= 0 ||
    !mainSource
      .slice(converterIndex, converterIndex + 1_400)
      .includes('sourceRecencyAt:e.recencyAt!=null&&Number.isFinite(e.recencyAt)')
  ) {
    throw new Error('qualified official thread converter changed');
  }
  const prefixEnd = mainSource.indexOf(contract.endMarker, converterIndex);
  if (prefixEnd < 0 || prefixEnd > 1_000_000) {
    throw new Error('qualified official thread converter dependency boundary changed');
  }
  const moduleValue: { exports: Record<string, unknown> } = { exports: {} };
  const mainPath = resolve(sourceRoot, '.vite', 'build', 'qualified-main.js');
  const realRequire = createRequire(mainPath);
  const inertModule = createInertModule();
  const qualifiedRequire = (request: string): unknown => {
    if (request === 'electron') return inertModule;
    if (request.startsWith('./') && !/^\.\/src-[A-Za-z0-9_-]+\.js$/u.test(request)) {
      return inertModule;
    }
    return realRequire(request);
  };
  const source = `${mainSource.slice(0, prefixEnd)}\n;module.exports.__qualifiedThreadConverter=${contract.converterName};`;
  const evaluate = runInThisContext(
    `(function(require,module,exports,__dirname,__filename){${source}\n})`,
    {
      filename: mainPath,
      timeout: 5_000,
    },
  ) as (...args: unknown[]) => void;
  evaluate(qualifiedRequire, moduleValue, moduleValue.exports, dirname(mainPath), mainPath);
  const converter = moduleValue.exports.__qualifiedThreadConverter;
  if (typeof converter !== 'function') {
    throw new Error('qualified official thread converter did not load');
  }
  const convertThread = converter as QualifiedThreadCatalogContract['convertThread'];
  const probe = convertThread(
    {
      id: 'qualified-thread',
      name: null,
      preview: '## Qualified **thread**',
      cwd: '/qualified/workspace',
      source: 'cli',
      updatedAt: 20,
      createdAt: 10,
      recencyAt: 30,
      ephemeral: false,
      parentThreadId: null,
      threadSource: 'cli',
      modelProvider: 'openai',
      gitInfo: null,
    },
    'local',
  ) as Record<string, unknown> | null;
  if (
    probe === null ||
    probe.displayTitle !== 'Qualified thread' ||
    probe.sourceRecencyAt !== 30 ||
    probe.threadId !== 'qualified-thread'
  ) {
    throw new Error('qualified official thread converter behavior changed');
  }
  return convertThread;
}

function createInertModule(): unknown {
  const callable = function inertOfficialModule(): unknown {
    return inert;
  };
  const inert: unknown = new Proxy(callable, {
    apply: () => inert,
    construct: () => inert as object,
    get: (_target, property) => {
      if (property === 'then') return undefined;
      if (property === Symbol.toPrimitive) return () => '';
      return inert;
    },
  });
  return inert;
}
