import { describe, expect, it } from 'vitest';

import {
  initialProjectNames,
  resumeResponseContainsTurns,
  threadIdFromInitialLocation,
} from './first-paint.js';

describe('atomic first paint readiness', () => {
  it('prefers the official initial route and recognizes local task routes', () => {
    expect(
      threadIdFromInitialLocation('/', '/local/01234567-89ab-4def-8123-456789abcdef?hostId=local'),
    ).toBe('01234567-89ab-4def-8123-456789abcdef');
    expect(threadIdFromInitialLocation('/settings', '')).toBeNull();
  });

  it('accepts either the bounded initial page or an ordinary resume turn list', () => {
    expect(
      resumeResponseContainsTurns({
        initialTurnsPage: { data: [{ id: 'turn-1' }] },
        thread: { turns: [] },
      }),
    ).toBe(true);
    expect(resumeResponseContainsTurns({ thread: { turns: [{ id: 'turn-1' }] } })).toBe(true);
    expect(resumeResponseContainsTurns({ thread: { turns: [] } })).toBe(false);
  });

  it('extracts only persisted local project names from the official sidebar bootstrap', () => {
    expect(
      initialProjectNames({
        globalStateEntries: [
          { key: 'project-order', value: ['project-1'] },
          {
            key: 'local-projects',
            value: {
              'project-1': { name: 'Trillium Note', rootPaths: ['/workspace'] },
              broken: { rootPaths: [] },
            },
          },
        ],
      }),
    ).toEqual(['Trillium Note']);
  });
});
