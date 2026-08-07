export type BufferedLiveRevisionEvent = {
  eventName: string;
  data: unknown;
  sessionId: string;
  liveRevision: number;
  connectionGeneration: number;
};

export type LiveRevisionFence = {
  sessionId: string | null;
  connectionGeneration: number;
  restoreToken: number;
  restoring: boolean;
  lastAppliedRevision: number | null;
  buffered: BufferedLiveRevisionEvent[];
};

export const EMPTY_LIVE_REVISION_FENCE: LiveRevisionFence = {
  sessionId: null,
  connectionGeneration: 0,
  restoreToken: 0,
  restoring: false,
  lastAppliedRevision: null,
  buffered: [],
};

export function beginLiveRevisionRestore(
  previous: LiveRevisionFence,
  sessionId: string,
  connectionGeneration: number,
  buffered: BufferedLiveRevisionEvent[] = [],
): LiveRevisionFence {
  return {
    sessionId,
    connectionGeneration,
    restoreToken: previous.restoreToken + 1,
    restoring: true,
    lastAppliedRevision: null,
    buffered,
  };
}

export function ingestLiveRevisionEvent(
  fence: LiveRevisionFence,
  event: BufferedLiveRevisionEvent,
): {
  fence: LiveRevisionFence;
  action: 'apply' | 'buffer' | 'drop' | 'resync';
} {
  if (fence.sessionId !== event.sessionId) {
    return { fence, action: 'drop' };
  }
  if (fence.connectionGeneration !== event.connectionGeneration) {
    if (!fence.restoring && fence.lastAppliedRevision !== null) {
      if (event.liveRevision <= fence.lastAppliedRevision) {
        return {
          fence: { ...fence, connectionGeneration: event.connectionGeneration },
          action: 'drop',
        };
      }
      if (event.liveRevision === fence.lastAppliedRevision + 1) {
        return {
          fence: {
            ...fence,
            connectionGeneration: event.connectionGeneration,
            lastAppliedRevision: event.liveRevision,
          },
          action: 'apply',
        };
      }
    }
    return {
      fence: beginLiveRevisionRestore(fence, event.sessionId, event.connectionGeneration, [event]),
      action: 'resync',
    };
  }
  if (fence.restoring) {
    return {
      fence: { ...fence, buffered: [...fence.buffered, event] },
      action: 'buffer',
    };
  }
  if (fence.lastAppliedRevision === null) {
    return {
      fence: beginLiveRevisionRestore(fence, event.sessionId, event.connectionGeneration, [event]),
      action: 'resync',
    };
  }
  if (event.liveRevision <= fence.lastAppliedRevision) {
    return { fence, action: 'drop' };
  }
  if (event.liveRevision !== fence.lastAppliedRevision + 1) {
    return {
      fence: beginLiveRevisionRestore(fence, event.sessionId, event.connectionGeneration, [event]),
      action: 'resync',
    };
  }
  return {
    fence: { ...fence, lastAppliedRevision: event.liveRevision },
    action: 'apply',
  };
}

export function completeLiveRevisionRestore(
  fence: LiveRevisionFence,
  restoreToken: number,
  snapshotRevision: number,
): {
  fence: LiveRevisionFence;
  replay: BufferedLiveRevisionEvent[];
  stale: boolean;
  needsResync: boolean;
} {
  if (!fence.restoring || fence.restoreToken !== restoreToken) {
    return { fence, replay: [], stale: true, needsResync: false };
  }

  const byRevision = new Map<number, BufferedLiveRevisionEvent>();
  for (const event of fence.buffered) {
    if (event.liveRevision > snapshotRevision) {
      byRevision.set(event.liveRevision, event);
    }
  }
  const replay = [...byRevision.values()].sort((a, b) => a.liveRevision - b.liveRevision);
  let expectedRevision = snapshotRevision + 1;
  for (const event of replay) {
    if (event.liveRevision !== expectedRevision) {
      return {
        fence: beginLiveRevisionRestore(fence, fence.sessionId!, fence.connectionGeneration, replay),
        replay: [],
        stale: false,
        needsResync: true,
      };
    }
    expectedRevision += 1;
  }

  return {
    fence: {
      ...fence,
      restoring: false,
      lastAppliedRevision: replay.at(-1)?.liveRevision ?? snapshotRevision,
      buffered: [],
    },
    replay,
    stale: false,
    needsResync: false,
  };
}
