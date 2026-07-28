import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildOfficialDeveloperInstructions,
  type OfficialDeveloperInstructionsInput,
} from './official-developer-instructions.js';

describe('qualified official developer instructions', () => {
  it('loads the exact builder exported by the qualified official runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-official-instructions-'));
    const buildRoot = join(root, '.vite', 'build');
    await mkdir(buildRoot, { recursive: true });
    await writeFile(
      join(buildRoot, 'src-DChWimf7.js'),
      'exports.an = (input) => JSON.stringify(input);',
      'utf8',
    );
    const input: OfficialDeveloperInstructionsInput = {
      baseInstructions: null,
      gitSettings: {
        branchPrefix: 'codex/',
        commitInstructions: '',
        pullRequestInstructions: '',
      },
      isNonGitWorkspace: true,
      instructionOverrides: null,
      threadToolsEnabled: false,
      workspaceDependenciesEnabled: false,
      includeProseDetailLevelInstructions: false,
      threadId: null,
    };

    expect(buildOfficialDeveloperInstructions(root, input)).toBe(JSON.stringify(input));
  });
});
