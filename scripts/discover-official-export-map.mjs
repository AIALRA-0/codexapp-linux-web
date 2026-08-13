import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  officialDesktopStateExportNames,
  officialDeveloperInstructionsExportName,
  officialGitExportNames,
  readQualifiedOfficialVersion,
} from '../packages/host-gateway/dist/official-export-contract.js';
import { resolveOfficialSharedModulePath } from '../packages/host-gateway/dist/official-shared-module.js';

const localRequire = createRequire(import.meta.url);
const moduleLoader = localRequire('node:module');
const originalLoad = moduleLoader._load;
const compatibleBetterSqlite3 = localRequire('better-sqlite3');
moduleLoader._load = function loadQualifiedDependency(request, parent, isMain) {
  if (request === 'better-sqlite3') return compatibleBetterSqlite3;
  return originalLoad.call(this, request, parent, isMain);
};
Object.defineProperty(process.versions, 'electron', {
  configurable: true,
  value: '42.3.0',
});

const referenceRoot = requiredArgument('--reference-root');
const candidateRoot = requiredArgument('--candidate-root');
const referenceVersion = readQualifiedOfficialVersion(referenceRoot);
const candidateVersion = packageVersion(candidateRoot);
const referenceExports = loadSharedModule(referenceRoot);
const candidateExports = loadSharedModule(candidateRoot);
const referenceMap = officialDesktopStateExportNames(referenceVersion);

const suggestions = suggestMappings(referenceMap);
const gitSuggestions = suggestMappings(officialGitExportNames(referenceVersion));
const developerInstructionSuggestions = suggestMappings({
  developerInstructions: officialDeveloperInstructionsExportName(referenceVersion),
});

function suggestMappings(exportMap) {
  return Object.fromEntries(
    Object.entries(exportMap).map(([semanticName, exportName]) => {
      const referenceValue = referenceExports[exportName];
      const candidates = Object.entries(candidateExports)
        .map(([candidateName, candidateValue]) => ({
          exportName: candidateName,
          ...compareValues(referenceValue, candidateValue),
        }))
        .filter((candidate) => candidate.compatible)
        .sort(
          (left, right) =>
            right.score - left.score || left.exportName.localeCompare(right.exportName),
        )
        .slice(0, 5);
      return [
        semanticName,
        {
          referenceExport: exportName,
          referenceSourcePreview:
            typeof referenceValue === 'function'
              ? Function.prototype.toString.call(referenceValue).slice(0, 500)
              : undefined,
          candidates,
        },
      ];
    }),
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      referenceVersion,
      candidateVersion,
      referenceExportCount: Object.keys(referenceExports).length,
      candidateExportCount: Object.keys(candidateExports).length,
      suggestions,
      gitSuggestions,
      developerInstructionSuggestions,
    },
    null,
    2,
  )}\n`,
);

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return resolve(value);
}

function packageVersion(root) {
  const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof value.version !== 'string' || value.version.length === 0) {
    throw new Error('candidate package version is missing');
  }
  return value.version;
}

function loadSharedModule(root) {
  const packageRequire = createRequire(join(root, 'package.json'));
  return packageRequire(resolveOfficialSharedModulePath(root));
}

function compareValues(reference, candidate) {
  const referenceShape = valueShape(reference);
  const candidateShape = valueShape(candidate);
  if (referenceShape !== candidateShape) {
    return { compatible: false, score: 0, shape: candidateShape };
  }
  if (referenceShape !== 'function') {
    const exact = stableValue(reference) === stableValue(candidate);
    return { compatible: true, score: exact ? 1_000 : 1, shape: candidateShape };
  }

  const referenceConstructible = isConstructible(reference);
  const candidateConstructible = isConstructible(candidate);
  if (referenceConstructible !== candidateConstructible) {
    return {
      compatible: false,
      score: 0,
      shape: candidateShape,
      constructible: candidateConstructible,
    };
  }

  const referenceFingerprint = functionFingerprint(reference);
  const candidateFingerprint = functionFingerprint(candidate);
  const arityScore = reference.length === candidate.length ? 40 : 0;
  const lengthRatio =
    Math.min(referenceFingerprint.sourceLength, candidateFingerprint.sourceLength) /
    Math.max(referenceFingerprint.sourceLength, candidateFingerprint.sourceLength, 1);
  const tokenScore =
    weightedJaccard(referenceFingerprint.tokens, candidateFingerprint.tokens) * 500;
  const literalScore =
    weightedJaccard(referenceFingerprint.literals, candidateFingerprint.literals) * 800;
  const prototypeScore =
    weightedJaccard(referenceFingerprint.prototypeKeys, candidateFingerprint.prototypeKeys) * 1_000;
  return {
    compatible: true,
    score:
      Math.round(
        (arityScore + lengthRatio * 100 + tokenScore + literalScore + prototypeScore) * 100,
      ) / 100,
    shape: candidateShape,
    constructible: candidateConstructible,
    arity: candidate.length,
    sourceLength: candidateFingerprint.sourceLength,
    commonLiterals: intersection(referenceFingerprint.literals, candidateFingerprint.literals),
    commonTokens: intersection(referenceFingerprint.tokens, candidateFingerprint.tokens).slice(
      0,
      20,
    ),
    prototypeKeys: candidateFingerprint.prototypeKeys,
    sourcePreview: candidateFingerprint.sourcePreview,
  };
}

function isConstructible(value) {
  try {
    Reflect.construct(String, [], value);
    return true;
  } catch {
    return false;
  }
}

function valueShape(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function stableValue(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return valueShape(value);
  }
}

function functionFingerprint(value) {
  const source = Function.prototype.toString.call(value);
  const literals = [...source.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/gu)]
    .map((match) => match[2])
    .filter((literal) => typeof literal === 'string' && literal.length >= 2);
  const properties = [...source.matchAll(/\.([A-Za-z_$][A-Za-z0-9_$]*)/gu)].map(
    (match) => match[1],
  );
  const objectKeys = [...source.matchAll(/(?:^|[,{])([A-Za-z_$][A-Za-z0-9_$]*):/gu)].map(
    (match) => match[1],
  );
  const numbers = [...source.matchAll(/(?:^|[^A-Za-z0-9_$])(-?\d+(?:\.\d+)?)/gu)].map(
    (match) => match[1],
  );
  return {
    sourceLength: source.length,
    sourcePreview: source.slice(0, 500),
    literals: unique(literals),
    tokens: unique([...properties, ...objectKeys, ...numbers].filter(Boolean)),
    prototypeKeys:
      value.prototype === undefined
        ? []
        : Object.getOwnPropertyNames(value.prototype).filter((name) => name !== 'constructor'),
  };
}

function unique(values) {
  return [...new Set(values)];
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function weightedJaccard(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 0;
  return intersection([...leftSet], [...rightSet]).length / union.size;
}
