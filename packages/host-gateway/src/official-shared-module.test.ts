import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveOfficialSharedModulePath } from './official-shared-module.js';

const markerSource = ['At', 'Di', 'Fi', 'il', 'an']
  .map((name) => `Object.defineProperty(exports,"${name}",{});`)
  .join('');

describe('qualified official shared module resolver', () => {
  it('follows the official main entry instead of a version-specific hashed file name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-official-shared-'));
    const buildRoot = join(root, '.vite', 'build');
    await mkdir(buildRoot, { recursive: true });
    await Promise.all([
      writeFile(
        join(buildRoot, 'main-NextBuild.js'),
        'require("./src-Helper.js");require("./src-NewOfficialHash.js");',
      ),
      writeFile(join(buildRoot, 'src-Helper.js'), 'exports.o = () => undefined;'),
      writeFile(join(buildRoot, 'src-NewOfficialHash.js'), markerSource),
    ]);

    expect(resolveOfficialSharedModulePath(root)).toBe(join(buildRoot, 'src-NewOfficialHash.js'));
  });

  it('fails closed when the official entry does not identify one shared module', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-official-shared-'));
    const buildRoot = join(root, '.vite', 'build');
    await mkdir(buildRoot, { recursive: true });
    await writeFile(join(buildRoot, 'main-Build.js'), 'require("./src-Helper.js");');
    await writeFile(join(buildRoot, 'src-Helper.js'), 'exports.o = () => undefined;');

    expect(() => resolveOfficialSharedModulePath(root)).toThrow(
      'qualified official shared module count changed: 0',
    );
  });
});
