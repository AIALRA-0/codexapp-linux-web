import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
      join(root, 'package.json'),
      JSON.stringify({ version: '26.721.81911' }),
      'utf8',
    );
    await writeFile(
      join(buildRoot, 'main-TestBuild.js'),
      'require("./src-TestOfficial.js");',
      'utf8',
    );
    await writeFile(
      join(buildRoot, 'src-TestOfficial.js'),
      [
        'Object.defineProperty(exports,"At",{get:function(){return () => undefined}});',
        'Object.defineProperty(exports,"Di",{get:function(){return "none"}});',
        'Object.defineProperty(exports,"Fi",{get:function(){return []}});',
        'Object.defineProperty(exports,"il",{get:function(){return 268435456}});',
        'Object.defineProperty(exports,"an",{get:function(){return (input) => JSON.stringify(input)}});',
      ].join(''),
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

const qualifiedSourceRoot =
  process.env.OFFICIAL_TEST_SOURCE_ROOT ??
  resolve(process.cwd(), '.official', 'releases', '26.727.51351', 'source');
const describeQualified = existsSync(join(qualifiedSourceRoot, 'package.json'))
  ? describe
  : describe.skip;

describeQualified('current official developer instructions', () => {
  it('executes the version-locked builder from the current official package', () => {
    const instructions = buildOfficialDeveloperInstructions(qualifiedSourceRoot, {
      baseInstructions: 'Qualified base instructions',
      gitSettings: {
        branchPrefix: 'qualified/',
        commitInstructions: 'Qualified commit instructions',
        pullRequestInstructions: 'Qualified pull request instructions',
      },
      isNonGitWorkspace: false,
      instructionOverrides: null,
      threadToolsEnabled: false,
      workspaceDependenciesEnabled: false,
      includeProseDetailLevelInstructions: false,
      threadId: null,
    });
    expect(instructions).toContain('Qualified base instructions');
    expect(instructions).toContain('Branch prefix: `qualified/`');
    expect(instructions).toContain('Qualified commit instructions');
    expect(instructions).toContain('Qualified pull request instructions');
  });
});
