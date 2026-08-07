import { describe, expect, it } from 'vitest';
import {
  EMPTY_LIVE_REVISION_FENCE,
  beginLiveRevisionRestore,
  completeLiveRevisionRestore,
  ingestLiveRevisionEvent,
  type BufferedLiveRevisionEvent,
} from './liveRevisionFence';

function event(liveRevision: number, connectionGeneration = 1): BufferedLiveRevisionEvent {
  return {
    eventName: 'chat:message-chunk',
    data: `chunk-${liveRevision}`,
    sessionId: 'session-a',
    liveRevision,
    connectionGeneration,
  };
}

describe('live revision restore fence', () => {
  it('drops snapshot-covered events and replays the contiguous tail once', () => {
    let fence = beginLiveRevisionRestore(EMPTY_LIVE_REVISION_FENCE, 'session-a', 1);
    fence = ingestLiveRevisionEvent(fence, event(2)).fence;
    fence = ingestLiveRevisionEvent(fence, event(4)).fence;
    fence = ingestLiveRevisionEvent(fence, event(3)).fence;

    const completed = completeLiveRevisionRestore(fence, fence.restoreToken, 2);

    expect(completed.needsResync).toBe(false);
    expect(completed.replay.map(item => item.liveRevision)).toEqual([3, 4]);
    expect(completed.fence.lastAppliedRevision).toBe(4);
    expect(completed.fence.restoring).toBe(false);
  });

  it('requests a fresh snapshot when a revision gap remains after REST', () => {
    let fence = beginLiveRevisionRestore(EMPTY_LIVE_REVISION_FENCE, 'session-a', 1);
    fence = ingestLiveRevisionEvent(fence, event(5)).fence;

    const completed = completeLiveRevisionRestore(fence, fence.restoreToken, 3);

    expect(completed.needsResync).toBe(true);
    expect(completed.replay).toEqual([]);
    expect(completed.fence.restoring).toBe(true);
    expect(completed.fence.restoreToken).toBe(fence.restoreToken + 1);
  });

  it('continues a new connection when revisions stay contiguous and resyncs only on a gap', () => {
    let fence = beginLiveRevisionRestore(EMPTY_LIVE_REVISION_FENCE, 'session-a', 1);
    fence = completeLiveRevisionRestore(fence, fence.restoreToken, 7).fence;

    expect(ingestLiveRevisionEvent(fence, event(7)).action).toBe('drop');
    const next = ingestLiveRevisionEvent(fence, event(8));
    expect(next.action).toBe('apply');
    const reconnected = ingestLiveRevisionEvent(next.fence, event(9, 2));
    expect(reconnected.action).toBe('apply');
    expect(reconnected.fence.connectionGeneration).toBe(2);
    const gap = ingestLiveRevisionEvent(reconnected.fence, event(11, 2));
    expect(gap.action).toBe('resync');
    expect(gap.fence.buffered).toEqual([event(11, 2)]);
  });

  it('starts a fresh revision epoch after a Sidecar replacement', () => {
    let fence = beginLiveRevisionRestore(EMPTY_LIVE_REVISION_FENCE, 'session-a', 1);
    fence = completeLiveRevisionRestore(fence, fence.restoreToken, 50).fence;

    const restarted = beginLiveRevisionRestore(fence, 'session-a', 2);
    const restored = completeLiveRevisionRestore(restarted, restarted.restoreToken, 0).fence;
    const firstNewProcessEvent = ingestLiveRevisionEvent(restored, event(1, 2));

    expect(firstNewProcessEvent.action).toBe('apply');
    expect(firstNewProcessEvent.fence.lastAppliedRevision).toBe(1);
  });
});
