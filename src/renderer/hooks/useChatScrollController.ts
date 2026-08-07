import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { useVirtuosoScroll } from '@/hooks/useVirtuosoScroll';
import type { RowLayoutChangeReason } from '@/context/ChatRowLayoutContext';
import type { Message as MessageType } from '@/types/chat';

export interface ScrollAnchorSnapshot {
  messageId: string;
  offsetFromViewportTop: number;
  label: string;
}

export interface ScrollToMessageOptions {
  align?: 'start' | 'center' | 'end';
  behavior?: 'smooth' | 'auto';
  pauseMs?: number;
}

export interface RestoreAnchorOptions {
  behavior?: 'auto' | 'smooth';
}

export interface ChatScrollController {
  virtuosoRef: ReturnType<typeof useVirtuosoScroll>['virtuosoRef'];
  scrollerRef: ReturnType<typeof useVirtuosoScroll>['scrollerRef'];
  followEnabledRef: ReturnType<typeof useVirtuosoScroll>['followEnabledRef'];
  attachScroller: ReturnType<typeof useVirtuosoScroll>['attachScroller'];
  scrollToBottom: ReturnType<typeof useVirtuosoScroll>['scrollToBottom'];
  pauseAutoScroll: ReturnType<typeof useVirtuosoScroll>['pauseAutoScroll'];
  handleAtBottomChange: ReturnType<typeof useVirtuosoScroll>['handleAtBottomChange'];
  scrollToMessage: (messageId: string, options?: ScrollToMessageOptions) => void;
  scrollToTool: (toolId: string, hostMessageId?: string) => void;
  captureAnchor: (label: string) => ScrollAnchorSnapshot | null;
  restoreAnchorAfterNextCommit: (anchor: ScrollAnchorSnapshot, options?: RestoreAnchorOptions) => void;
  onRowLayoutChanged: (messageId: string, reason: RowLayoutChangeReason) => void;
}

export interface UseChatScrollControllerOptions {
  messages: readonly MessageType[];
  isActive: boolean;
  isWindowFocused?: boolean;
  sessionId?: string | null;
  rootRef?: RefObject<HTMLElement | null>;
}

interface WindowFocusScrollSnapshot {
  sessionId: string | null;
  follow: boolean;
  anchor: ScrollAnchorSnapshot | null;
}

interface PendingAnchorRestore {
  anchor: ScrollAnchorSnapshot;
  options?: RestoreAnchorOptions;
  pending: boolean;
}

const MESSAGE_SCOPE_SELECTOR = '[data-chat-search-scope][data-message-id]';
const DEFAULT_JUMP_PAUSE_MS = 2000;

function shouldPinBottomAfterNextCommit(reason: RowLayoutChangeReason): boolean {
  return reason === 'attachment-settle' || reason === 'widget-resize';
}

function isDirectRowToggle(reason: RowLayoutChangeReason): boolean {
  return reason === 'process-row-expand'
    || reason === 'process-row-collapse'
    || reason === 'user-message-expand'
    || reason === 'block-group-expand'
    || reason === 'expandable-container-expand';
}

function escapeCssIdentifier(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}

function findMessageScope(root: HTMLElement, messageId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    `[data-chat-search-scope][data-message-id="${escapeCssIdentifier(messageId)}"]`,
  );
}

function getScrollerRect(scroller: HTMLElement): DOMRect {
  return scroller.getBoundingClientRect();
}

function getVisibleMessageScopes(scroller: HTMLElement): HTMLElement[] {
  const scrollerRect = getScrollerRect(scroller);
  return Array.from(scroller.querySelectorAll<HTMLElement>(MESSAGE_SCOPE_SELECTOR))
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > scrollerRect.top + 1 && rect.top < scrollerRect.bottom - 1;
    })
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

function getToolHostMessageId(messages: readonly MessageType[], toolId: string): string | null {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const found = message.content.some(block =>
      (block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool?.id === toolId
    );
    if (found) return message.id;
  }
  return null;
}

export function useChatScrollController({
  messages,
  isActive,
  isWindowFocused = true,
  sessionId,
  rootRef,
}: UseChatScrollControllerOptions): ChatScrollController {
  const {
    virtuosoRef,
    scrollerRef,
    followEnabledRef,
    attachScroller,
    scrollToBottom,
    pauseAutoScroll,
    handleAtBottomChange,
  } = useVirtuosoScroll();
  const messagesRef = useRef(messages);
  // Ref mirror for stable imperative callbacks; handlers read this after commit.
  // eslint-disable-next-line react-hooks/refs
  messagesRef.current = messages;
  const isActiveRef = useRef(isActive);
  // eslint-disable-next-line react-hooks/refs
  isActiveRef.current = isActive;
  const sessionIdRef = useRef(sessionId ?? null);
  // eslint-disable-next-line react-hooks/refs
  sessionIdRef.current = sessionId ?? null;
  const rootRefRef = useRef(rootRef);
  // eslint-disable-next-line react-hooks/refs
  rootRefRef.current = rootRef;
  const pendingAnchorRef = useRef<PendingAnchorRestore | null>(null);
  const [anchorRestoreTick, setAnchorRestoreTick] = useState(0);
  const pendingBottomPinRef = useRef(false);
  const [bottomPinTick, setBottomPinTick] = useState(0);
  const windowFocusSnapshotRef = useRef<WindowFocusScrollSnapshot | null>(null);
  const previousWindowFocusedRef = useRef(isWindowFocused);
  const previousIsActiveRef = useRef(isActive);

  const messageIndexById = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((message, index) => map.set(message.id, index));
    return map;
  }, [messages]);
  const messageIndexByIdRef = useRef(messageIndexById);
  // eslint-disable-next-line react-hooks/refs
  messageIndexByIdRef.current = messageIndexById;

  const captureAnchor = useCallback((label: string): ScrollAnchorSnapshot | null => {
    if (!isActiveRef.current) return null;
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const scopes = getVisibleMessageScopes(scroller);
    if (scopes.length === 0) return null;
    const scrollerTop = getScrollerRect(scroller).top;
    const anchorEl = scopes.find(el => el.getBoundingClientRect().top >= scrollerTop - 1) ?? scopes[0];
    const messageId = anchorEl.getAttribute('data-message-id');
    if (!messageId) return null;
    return {
      messageId,
      offsetFromViewportTop: anchorEl.getBoundingClientRect().top - scrollerTop,
      label,
    };
  }, [scrollerRef]);

  const restoreAnchor = useCallback((
    anchor: ScrollAnchorSnapshot,
    options: RestoreAnchorOptions | undefined,
    restoreIntent: PendingAnchorRestore,
  ) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const restoreSessionId = sessionIdRef.current;
    const index = messageIndexByIdRef.current.get(anchor.messageId);
    if (index === undefined) {
      if (import.meta.env.DEV) {
        console.debug('[chat-scroll] Skipping deleted focus anchor', {
          sessionId: restoreSessionId,
          messageId: anchor.messageId,
          label: anchor.label,
        });
      }
      return;
    }

    const adjustOffset = () => {
      if (
        !isActiveRef.current
        || sessionIdRef.current !== restoreSessionId
        || pendingAnchorRef.current !== restoreIntent
      ) return;
      const scope = findMessageScope(scroller, anchor.messageId);
      if (!scope) return;
      const scrollerTop = getScrollerRect(scroller).top;
      const nextOffset = scope.getBoundingClientRect().top - scrollerTop;
      const delta = nextOffset - anchor.offsetFromViewportTop;
      if (Math.abs(delta) >= 1) {
        virtuosoRef.current?.scrollBy({ top: delta, behavior: options?.behavior ?? 'auto' });
      }
    };

    const mountedScope = findMessageScope(scroller, anchor.messageId);
    if (mountedScope) {
      adjustOffset();
      return;
    }

    virtuosoRef.current?.scrollToIndex({
      index,
      align: 'start',
      behavior: options?.behavior ?? 'auto',
    });
    requestAnimationFrame(adjustOffset);
  }, [scrollerRef, virtuosoRef]);

  const restoreAnchorAfterNextCommit = useCallback((anchor: ScrollAnchorSnapshot, options?: RestoreAnchorOptions) => {
    pendingAnchorRef.current = { anchor, options, pending: true };
    setAnchorRestoreTick(tick => tick + 1);
  }, []);

  useLayoutEffect(() => {
    const wasWindowFocused = previousWindowFocusedRef.current;
    const wasActive = previousIsActiveRef.current;
    previousWindowFocusedRef.current = isWindowFocused;
    previousIsActiveRef.current = isActive;

    // A window-focus snapshot only belongs to the Chat that was active at blur.
    // Internal Tab switching has its own recovery path in MessageList.
    if (!isActive) {
      pendingAnchorRef.current = null;
      windowFocusSnapshotRef.current = null;
      return;
    }

    if (wasWindowFocused && !isWindowFocused && wasActive) {
      // Drop commands prepared against the pre-blur commit. The focus snapshot
      // below is the sole recovery intent for this geometry boundary.
      pendingAnchorRef.current = null;
      pendingBottomPinRef.current = false;
      const follow = followEnabledRef.current !== false;
      windowFocusSnapshotRef.current = {
        sessionId: sessionId ?? null,
        follow,
        anchor: follow ? null : captureAnchor('window-blur'),
      };
      return;
    }

    if (!wasWindowFocused && isWindowFocused) {
      const snapshot = windowFocusSnapshotRef.current;
      windowFocusSnapshotRef.current = null;
      if (!snapshot || snapshot.sessionId !== (sessionId ?? null)) return;
      if (snapshot.follow) {
        scrollToBottom('auto');
        return;
      }
      // Stale background callbacks may have changed the live ref. The blur
      // snapshot is authoritative for this recovery.
      followEnabledRef.current = false;
      if (snapshot.anchor) {
        restoreAnchorAfterNextCommit(snapshot.anchor, { behavior: 'auto' });
      }
    }
  }, [captureAnchor, followEnabledRef, isActive, isWindowFocused, restoreAnchorAfterNextCommit, scrollToBottom, sessionId]);

  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending?.pending) return;
    if (!isActiveRef.current) {
      pendingAnchorRef.current = null;
      return;
    }
    pending.pending = false;
    restoreAnchor(pending.anchor, pending.options, pending);
  }, [anchorRestoreTick, restoreAnchor]);

  const pinBottomAfterNextCommit = useCallback(() => {
    pendingBottomPinRef.current = true;
    setBottomPinTick(tick => tick + 1);
  }, []);

  useLayoutEffect(() => {
    if (!pendingBottomPinRef.current) return;
    pendingBottomPinRef.current = false;
    if (!isActiveRef.current || !followEnabledRef.current) return;
    scrollToBottom('auto');
  }, [bottomPinTick, followEnabledRef, scrollToBottom]);

  const scrollToMessage = useCallback((messageId: string, options: ScrollToMessageOptions = {}) => {
    const index = messageIndexByIdRef.current.get(messageId);
    if (index === undefined) return;
    pauseAutoScroll(options.pauseMs ?? DEFAULT_JUMP_PAUSE_MS);
    virtuosoRef.current?.scrollToIndex({
      index,
      behavior: options.behavior ?? 'smooth',
      align: options.align ?? 'start',
    });
  }, [pauseAutoScroll, virtuosoRef]);

  const scrollToTool = useCallback((toolId: string, hostMessageId?: string) => {
    const messageId = hostMessageId ?? getToolHostMessageId(messagesRef.current, toolId);
    if (!messageId) return;
    scrollToMessage(messageId, { align: 'center', behavior: 'smooth', pauseMs: DEFAULT_JUMP_PAUSE_MS });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root = rootRefRef.current?.current ?? scrollerRef.current;
        if (!root) return;
        const el = root.querySelector<HTMLElement>(`[data-tool-id="${escapeCssIdentifier(toolId)}"]`);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('agent-status-flash');
        window.setTimeout(() => el.classList.remove('agent-status-flash'), 1500);
      });
    });
  }, [scrollerRef, scrollToMessage]);

  const onRowLayoutChanged = useCallback((messageId: string, reason: RowLayoutChangeReason) => {
    if (!isActiveRef.current) return;
    // A click-driven disclosure must grow or shrink from the clicked row in normal
    // document flow. Restoring the first fully visible *message* is the wrong owner:
    // when the clicked row belongs to a message whose top is already above the
    // viewport, that anchor is a later message below the click. Preserving it makes
    // the disclosure expand upward and can leave WebKit's paint and hit-test geometry
    // on different scroll offsets. Virtuoso owns the row-size update; do not add a
    // second scroll correction for direct toggles.
    if (isDirectRowToggle(reason)) return;
    if (reason === 'tool-complete' && followEnabledRef.current) {
      scrollToBottom('auto');
      return;
    }
    if (shouldPinBottomAfterNextCommit(reason) && followEnabledRef.current) {
      pinBottomAfterNextCommit();
      return;
    }
    if (!messageIndexByIdRef.current.has(messageId)) return;
    const anchor = captureAnchor(reason);
    if (!anchor) return;
    restoreAnchorAfterNextCommit(anchor, { behavior: 'auto' });
  }, [captureAnchor, followEnabledRef, pinBottomAfterNextCommit, restoreAnchorAfterNextCommit, scrollToBottom]);

  return {
    virtuosoRef,
    scrollerRef,
    followEnabledRef,
    attachScroller,
    scrollToBottom,
    pauseAutoScroll,
    handleAtBottomChange,
    scrollToMessage,
    scrollToTool,
    captureAnchor,
    restoreAnchorAfterNextCommit,
    onRowLayoutChanged,
  };
}
