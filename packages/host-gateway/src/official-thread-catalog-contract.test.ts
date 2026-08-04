import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadQualifiedThreadCatalogContract } from './official-thread-catalog-contract.js';

const oldSourceRoot = resolve(process.cwd(), '.official', 'releases', '26.721.81911', 'source');
const latestSourceRoot =
  process.env.OFFICIAL_TEST_SOURCE_ROOT ??
  resolve(process.cwd(), '.official', 'releases', '26.727.51351', 'source');
const describeLatest = existsSync(join(latestSourceRoot, 'package.json'))
  ? describe
  : describe.skip;
const describePrevious = existsSync(join(oldSourceRoot, 'package.json')) ? describe : describe.skip;

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

describeLatest('latest qualified official thread catalog contract', () => {
  it('runs the latest official converter including preview titles and recency', () => {
    const contract = loadQualifiedThreadCatalogContract(latestSourceRoot);
    expect(contract.sourceKinds).toEqual([]);
    expect(contract.convertThread(thread(), 'local')).toMatchObject({
      threadId: 'qualified-thread',
      displayTitle: 'Qualified thread',
      sourceCreatedAt: 10,
      sourceUpdatedAt: 20,
      sourceRecencyAt: 30,
    });
    expect(contract.convertThread(thread({ ephemeral: true }), 'local')).toBeNull();
    expect(contract.convertThread(thread({ source: 'exec' }), 'local')).toBeNull();
  });
});

describePrevious('previous qualified official thread catalog contract', () => {
  it('keeps the previous qualified official converter available for rollback', () => {
    const contract = loadQualifiedThreadCatalogContract(oldSourceRoot);
    expect(contract.sourceKinds).toEqual([]);
    expect(
      contract.convertThread(
        thread({ name: 'Rollback thread', preview: undefined, recencyAt: undefined }),
        'local',
      ),
    ).toMatchObject({
      threadId: 'qualified-thread',
      displayTitle: 'Rollback thread',
      sourceCreatedAt: 10,
      sourceUpdatedAt: 20,
    });
  });
});
