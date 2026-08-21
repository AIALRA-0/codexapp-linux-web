import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext, runInThisContext } from 'node:vm';

export interface OfficialProjectlessInstructionsInput {
  cwd: string;
  projectlessOutputDirectory: string;
  projectlessWorkspaceBrowserRoot: string;
}

export type OfficialProjectlessInstructions = (
  input: OfficialProjectlessInstructionsInput,
) => string;

export type OfficialLocalExecutionHostRpc = new (
  getExecutionHost: (hostId: string) => unknown,
) => unknown;

export function loadQualifiedLocalExecutionHostRpc(
  sourceRoot: string,
): OfficialLocalExecutionHostRpc {
  const source = readQualifiedMainSource(sourceRoot);
  const marker =
    'getExecutionHost;targetsByHostId=new Map;constructor(e){super(),this.getExecutionHost=e}getHost(e)';
  const markerIndex = source.indexOf(marker);
  if (
    markerIndex < 0 ||
    source.indexOf(marker, markerIndex + marker.length) >= 0 ||
    markerIndex > 500_000
  ) {
    throw new Error('qualified official local execution host RPC changed');
  }
  const classPrefix = source.slice(Math.max(0, markerIndex - 200), markerIndex);
  const classMatch =
    /([A-Za-z_$][A-Za-z0-9_$]*)=class extends [A-Za-z_$][A-Za-z0-9_$]*\.Ct\{$/u.exec(classPrefix);
  const className = classMatch?.[1];
  if (className === undefined) {
    throw new Error('qualified official local execution host RPC name changed');
  }
  const statementEnd = source.indexOf(';var ', markerIndex);
  if (statementEnd < 0 || statementEnd - markerIndex > 250_000) {
    throw new Error('qualified official local execution host RPC dependency boundary changed');
  }

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
  const moduleValue: { exports: Record<string, unknown> } = { exports: {} };
  const qualifiedSource = `${source.slice(0, statementEnd + 1)}\n;module.exports.__qualifiedLocalExecutionHostRpc=${className};`;
  const evaluate = runInThisContext(
    `(function(require,module,exports,__dirname,__filename){${qualifiedSource}\n})`,
    { filename: mainPath, timeout: 5_000 },
  ) as (...args: unknown[]) => void;
  evaluate(qualifiedRequire, moduleValue, moduleValue.exports, dirname(mainPath), mainPath);
  const candidate = moduleValue.exports.__qualifiedLocalExecutionHostRpc;
  if (typeof candidate !== 'function') {
    throw new Error('qualified official local execution host RPC did not load');
  }
  const instance = new (candidate as OfficialLocalExecutionHostRpc)(() => ({})) as {
    getHost?: unknown;
  };
  if (typeof instance.getHost !== 'function') {
    throw new Error('qualified official local execution host RPC behavior changed');
  }
  return candidate as OfficialLocalExecutionHostRpc;
}

export function loadQualifiedProjectlessInstructions(
  sourceRoot: string,
): OfficialProjectlessInstructions {
  const source = readQualifiedMainSource(sourceRoot);
  const marker = '`### Projectless Chat`';
  const matchingFunctions: string[] = [];
  let markerIndex = source.indexOf(marker);
  while (markerIndex >= 0) {
    const functionStart = source.lastIndexOf('function ', markerIndex);
    if (functionStart >= 0) {
      const header = source.slice(functionStart, markerIndex);
      if (
        header.includes('projectlessOutputDirectory:') &&
        header.includes('projectlessWorkspaceBrowserRoot:')
      ) {
        const functionSource = extractFunctionSource(source, functionStart);
        if (!matchingFunctions.includes(functionSource)) matchingFunctions.push(functionSource);
      }
    }
    markerIndex = source.indexOf(marker, markerIndex + marker.length);
  }
  if (matchingFunctions.length !== 1) {
    throw new Error(
      `qualified official projectless instruction function changed: ${String(matchingFunctions.length)}`,
    );
  }
  const sandbox: Record<string, unknown> = {};
  const candidate = runInNewContext(`(${matchingFunctions[0] as string})`, sandbox, {
    timeout: 1_000,
  }) as unknown;
  if (typeof candidate !== 'function') {
    throw new Error('qualified official projectless instruction function is invalid');
  }
  const instructions = candidate as OfficialProjectlessInstructions;
  const probe = instructions({
    cwd: '/qualified/workspace',
    projectlessOutputDirectory: '/qualified/output',
    projectlessWorkspaceBrowserRoot: '/qualified/root',
  });
  if (
    typeof probe !== 'string' ||
    !probe.includes('### Projectless Chat') ||
    !probe.includes('/qualified/output') ||
    !probe.includes('Prefer answering inline in chat')
  ) {
    throw new Error('qualified official projectless instruction behavior changed');
  }
  return instructions;
}

export function readQualifiedMainSource(sourceRoot: string): string {
  const buildRoot = resolve(sourceRoot, '.vite', 'build');
  const candidates = readdirSync(buildRoot)
    .filter((name) => /^main-[A-Za-z0-9_-]+\.js$/u.test(name))
    .sort();
  if (candidates.length !== 1) {
    throw new Error('qualified official main process module changed');
  }
  return readFileSync(resolve(buildRoot, candidates[0] as string), 'utf8');
}

function extractFunctionSource(source: string, start: number): string {
  const signatureEnd = source.indexOf('){', start);
  if (signatureEnd < 0) throw new Error('qualified official function signature changed');
  const bodyStart = signatureEnd + 1;
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index] as string;
    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('qualified official function body changed');
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
