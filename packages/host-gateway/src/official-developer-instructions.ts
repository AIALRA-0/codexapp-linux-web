import { createRequire } from 'node:module';

import {
  officialDeveloperInstructionsExportName,
  readQualifiedOfficialVersion,
} from './official-export-contract.js';
import { resolveOfficialSharedModulePath } from './official-shared-module.js';

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

type OfficialDesktopRuntimeModule = Record<string, unknown>;
type OfficialDeveloperInstructionsBuilder = (input: OfficialDeveloperInstructionsInput) => unknown;

const require = createRequire(import.meta.url);
const modules = new Map<string, OfficialDesktopRuntimeModule>();

export function buildOfficialDeveloperInstructions(
  officialSourceRoot: string,
  input: OfficialDeveloperInstructionsInput,
): string {
  const modulePath = resolveOfficialSharedModulePath(officialSourceRoot);
  let officialModule = modules.get(modulePath);
  if (officialModule === undefined) {
    officialModule = require(modulePath) as OfficialDesktopRuntimeModule;
    modules.set(modulePath, officialModule);
  }
  const version = readQualifiedOfficialVersion(officialSourceRoot);
  const exportName = officialDeveloperInstructionsExportName(version);
  const builder = officialModule[exportName];
  if (typeof builder !== 'function') {
    throw new Error('qualified official developer-instructions builder is missing');
  }
  const instructions = (builder as OfficialDeveloperInstructionsBuilder)(input);
  if (typeof instructions !== 'string') {
    throw new Error('qualified official developer-instructions builder returned invalid output');
  }
  return instructions;
}
