import { describe, expect, it } from 'vitest';

import { TurnLatencyTracker, type TurnLatencyMeasurement } from './turn-latency.js';

describe('turn latency tracker', () => {
  it('measures first visible agent output and completion without recording content', () => {
    const measurements: TurnLatencyMeasurement[] = [];
    const tracker = new TurnLatencyTracker((measurement) => measurements.push(measurement));
    tracker.start({ threadId: 'thread-1' }, 1_000);

    tracker.observeNotification(
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', delta: 'secret content' },
      },
      1_275,
    );
    tracker.observeNotification(
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', delta: 'more secret content' },
      },
      1_300,
    );
    tracker.observeNotification(
      { method: 'turn/completed', params: { threadId: 'thread-1' } },
      1_500,
    );

    expect(measurements).toEqual([
      { kind: 'turn-first-visible-output', durationMs: 275 },
      { kind: 'turn-complete', durationMs: 500 },
    ]);
    expect(JSON.stringify(measurements)).not.toContain('secret');
  });

  it('uses a completed agent message as the first-output fallback', () => {
    const measurements: TurnLatencyMeasurement[] = [];
    const tracker = new TurnLatencyTracker((measurement) => measurements.push(measurement));
    tracker.start({ threadId: 'thread-2' }, 2_000);
    tracker.observeNotification(
      {
        method: 'item/completed',
        params: { threadId: 'thread-2', item: { type: 'agentMessage', text: 'secret' } },
      },
      2_450,
    );
    expect(measurements).toEqual([{ kind: 'turn-first-visible-output', durationMs: 450 }]);
  });

  it('forgets stopped, deleted, malformed, and cleared turns', () => {
    const measurements: TurnLatencyMeasurement[] = [];
    const tracker = new TurnLatencyTracker((measurement) => measurements.push(measurement));
    tracker.start({ threadId: 'stopped' }, 0);
    tracker.stop({ threadId: 'stopped' });
    tracker.observeNotification(
      { method: 'turn/completed', params: { threadId: 'stopped' } },
      1_000,
    );
    tracker.start({ threadId: 'deleted' }, 0);
    tracker.observeNotification({ method: 'thread/deleted', params: { threadId: 'deleted' } }, 500);
    tracker.observeNotification(
      { method: 'turn/completed', params: { threadId: 'deleted' } },
      1_000,
    );
    tracker.start({}, 0);
    tracker.start({ threadId: 'cleared' }, 0);
    tracker.clear();
    tracker.observeNotification(
      { method: 'turn/completed', params: { threadId: 'cleared' } },
      1_000,
    );
    expect(measurements).toEqual([]);
  });
});
