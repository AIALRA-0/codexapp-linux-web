import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const MAIN_BUNDLE_PATTERN = /^main-[A-Za-z0-9_-]+\.js$/u;
const SHARED_IMPORT_PATTERN = /require\((["'`])\.\/(src-[A-Za-z0-9_-]+\.js)\1\)/gu;
const SHARED_EXPORT_MARKERS = ['At', 'Di', 'Fi', 'il', 'an'] as const;

export function resolveOfficialSharedModulePath(officialSourceRoot: string): string {
  const buildRoot = resolve(officialSourceRoot, '.vite', 'build');
  const entries = readdirSync(buildRoot, { withFileTypes: true });
  const mainBundles = entries
    .filter((entry) => entry.isFile() && MAIN_BUNDLE_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  if (mainBundles.length !== 1) {
    throw new Error(`qualified official main bundle count changed: ${String(mainBundles.length)}`);
  }

  const mainBundle = mainBundles[0];
  if (mainBundle === undefined) throw new Error('qualified official main bundle is missing');
  const mainSource = readFileSync(join(buildRoot, mainBundle), 'utf8');
  const importedSourceModules = [
    ...new Set(
      [...mainSource.matchAll(SHARED_IMPORT_PATTERN)]
        .map((match) => match[2])
        .filter((name): name is string => name !== undefined),
    ),
  ];
  const matchingModules = importedSourceModules.filter((name) => {
    if (basename(name) !== name) return false;
    const path = join(buildRoot, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) return false;
    const source = readFileSync(path, 'utf8');
    return SHARED_EXPORT_MARKERS.every((marker) =>
      source.includes(`Object.defineProperty(exports,"${marker}"`),
    );
  });
  if (matchingModules.length !== 1) {
    throw new Error(
      `qualified official shared module count changed: ${String(matchingModules.length)}`,
    );
  }
  const sharedModule = matchingModules[0];
  if (sharedModule === undefined) {
    throw new Error('qualified official shared module is missing');
  }
  return join(buildRoot, sharedModule);
}
