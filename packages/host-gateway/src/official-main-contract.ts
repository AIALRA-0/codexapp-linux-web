import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

export interface OfficialProjectlessInstructionsInput {
  cwd: string;
  projectlessOutputDirectory: string;
  projectlessWorkspaceBrowserRoot: string;
}

export type OfficialProjectlessInstructions = (
  input: OfficialProjectlessInstructionsInput,
) => string;

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
