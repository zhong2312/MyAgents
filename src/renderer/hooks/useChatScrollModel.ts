import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Message as MessageType } from '@/types/chat';
import {
  buildMessageLayoutFingerprint,
  estimateMessageRowHeight,
  type RowLayoutContract,
} from '@/utils/chatRowLayout';
import { projectVisibleChatTimelineRows } from '@/utils/chatTimelineRows';

export interface ChatScrollModel {
  data: readonly MessageType[];
  firstItemIndex?: number;
  heightEstimateSeed: number[];
  layoutByMessageId: ReadonlyMap<string, RowLayoutContract>;
}

export interface UseChatScrollModelOptions {
  historyMessages: readonly MessageType[];
  streamingMessage: MessageType | null;
  firstItemIndex?: number;
  sessionId?: string | null;
}

interface HeightEstimateSeedCache {
  sessionId?: string | null;
  orderedIdsKey: string;
  estimatesById: ReadonlyMap<string, number>;
  seed: number[];
}

function getViewportHeight(): number {
  if (typeof window === 'undefined') return 800;
  return window.innerHeight || 800;
}

export function useChatScrollModel({
  historyMessages,
  streamingMessage,
  firstItemIndex,
  sessionId,
}: UseChatScrollModelOptions): ChatScrollModel {
  const [viewportHeight, setViewportHeight] = useState(getViewportHeight);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      const next = getViewportHeight();
      setViewportHeight(prev => (Math.abs(prev - next) < 80 ? prev : next));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const data = useMemo(
    () => projectVisibleChatTimelineRows(historyMessages, streamingMessage),
    [historyMessages, streamingMessage],
  );

  const orderedIdsKey = useMemo(
    () => data.map(message => message.id).join('\u001f'),
    [data],
  );

  const layoutFingerprint = useMemo(
    () => [
      sessionId ?? '',
      data.map(message => buildMessageLayoutFingerprint(message, viewportHeight)).join('\u001f'),
    ].join('\u001e'),
    [data, sessionId, viewportHeight],
  );

  const { layoutByMessageId } = useMemo(() => {
    const nextLayout = new Map<string, RowLayoutContract>();

    for (const message of data) {
      const contract = estimateMessageRowHeight(message, viewportHeight);
      nextLayout.set(message.id, contract);
    }

    return {
      layoutByMessageId: nextLayout,
    };
    // `layoutFingerprint` is the semantic dependency: token-level streaming
    // changes that stay inside the same line/code/attachment bucket keep the
    // previous live layout while `data` below remains live for rendering/search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutFingerprint]);

  const heightEstimateSeedCacheRef = useRef<HeightEstimateSeedCache>({
    sessionId,
    orderedIdsKey: '',
    estimatesById: new Map(),
    seed: [],
  });

  const heightEstimateSeedCache = useMemo<HeightEstimateSeedCache>(() => {
    const previous = heightEstimateSeedCacheRef.current;
    if (previous.sessionId === sessionId && previous.orderedIdsKey === orderedIdsKey) {
      return previous;
    }

    const canReusePrevious = previous.sessionId === sessionId;
    const nextEstimatesById = new Map<string, number>();
    const nextSeed = data.map((message) => {
      const cached = canReusePrevious ? previous.estimatesById.get(message.id) : undefined;
      const estimate = cached ?? estimateMessageRowHeight(message, viewportHeight).estimatedHeight;
      nextEstimatesById.set(message.id, estimate);
      return estimate;
    });

    return {
      sessionId,
      orderedIdsKey,
      estimatesById: nextEstimatesById,
      seed: nextSeed,
    };
  }, [data, orderedIdsKey, sessionId, viewportHeight]);

  useLayoutEffect(() => {
    heightEstimateSeedCacheRef.current = heightEstimateSeedCache;
  }, [heightEstimateSeedCache]);

  return {
    data,
    firstItemIndex,
    heightEstimateSeed: heightEstimateSeedCache.seed,
    layoutByMessageId,
  };
}
