import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface OfficialDeveloperInstructionsInput {
  baseInstructions: unknown;
  gitSettings: {
    branchPrefix: string;
    commitInstructions: string;
    pullRequestInstructions: string;
  };
  isNonGitWorkspace: boolean;
  instructionOverrides: unknown;
  threadToolsEnabled: boolean;
  workspaceDependenciesEnabled: boolean;
  includeProseDetailLevelInstructions: boolean;
  threadId: string | null;
}

interface OfficialDesktopRuntimeModule {
  an?: (input: OfficialDeveloperInstructionsInput) => unknown;
}

const require = createRequire(import.meta.url);
const modules = new Map<string, OfficialDesktopRuntimeModule>();

export function buildOfficialDeveloperInstructions(
  officialSourceRoot: string,
  input: OfficialDeveloperInstructionsInput,
): string {
  const modulePath = join(officialSourceRoot, '.vite', 'build', 'src-DChWimf7.js');
  let officialModule = modules.get(modulePath);
  if (officialModule === undefined) {
    officialModule = require(modulePath) as OfficialDesktopRuntimeModule;
    modules.set(modulePath, officialModule);
  }
  if (typeof officialModule.an !== 'function') {
    throw new Error('qualified official developer-instructions builder is missing');
  }
  const instructions = officialModule.an(input);
  if (typeof instructions !== 'string') {
    throw new Error('qualified official developer-instructions builder returned invalid output');
  }
  return instructions;
}
