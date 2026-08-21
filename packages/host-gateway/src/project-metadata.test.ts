import { describe, expect, it } from 'vitest';

import { pruneRemovedLocalProjectMetadata } from './runtime.js';

describe('local project metadata cleanup', () => {
  it('removes assignments and appearances that refer to deleted local projects', () => {
    expect(
      pruneRemovedLocalProjectMetadata(
        {
          current: {
            id: 'current',
            name: 'Current',
            rootPaths: ['/workspace/current'],
          },
        },
        {
          keep: { projectKind: 'local', projectId: 'current' },
          remove: { projectKind: 'local', projectId: 'deleted' },
          remote: { projectKind: 'remote', projectId: 'deleted' },
          malformed: 'preserve',
        },
        {
          current: { color: 'blue' },
          deleted: { color: 'red' },
        },
      ),
    ).toEqual({
      assignments: {
        keep: { projectKind: 'local', projectId: 'current' },
        remote: { projectKind: 'remote', projectId: 'deleted' },
        malformed: 'preserve',
      },
      appearances: {
        current: { color: 'blue' },
      },
      assignmentsChanged: true,
      appearancesChanged: true,
    });
  });

  it('does not report changes when metadata already matches the active projects', () => {
    expect(
      pruneRemovedLocalProjectMetadata(
        { current: {} },
        { thread: { projectKind: 'local', projectId: 'current' } },
        { current: { color: 'blue' } },
      ),
    ).toMatchObject({
      assignmentsChanged: false,
      appearancesChanged: false,
    });
  });
});
