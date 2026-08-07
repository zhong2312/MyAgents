import { AlertCircle, CheckCircle, Loader2, X } from 'lucide-react';
import React, { memo, useCallback, useMemo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { SizeFunction, VirtuosoHandle } from 'react-virtuoso';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import Message from '@/components/Message';
import { PermissionPrompt, type PermissionRequest } from '@/components/PermissionPrompt';
import { AskUserQuestionPrompt, type AskUserQuestionRequest } from '@/components/AskUserQuestionPrompt';
import { ExitPlanModePrompt } from '@/components/ExitPlanModePrompt';
import { getToolLabel } from '@/components/tools/toolBadgeConfig';
import type { ExitPlanModeRequest } from '../../shared/types/planMode';
import type { Message as MessageType } from '@/types/chat';
import type { SessionState, SystemNotice } from '@/context/TabContext';
import { ChatRowLayoutProvider, type RowLayoutChangeReason } from '@/context/ChatRowLayoutContext';
import type { RowLayoutContract } from '@/utils/chatRowLayout';
import { useChatScrollDebugProbe } from '@/hooks/useChatScrollDebugProbe';
import { resolveChatBottomSpacerPx } from '@/utils/chatBottomSpacer';

function formatElapsedTime(totalSeconds: number, t: TFunction<'chat'>): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return t('shell.messageList.elapsed.hms', { hours, minutes, seconds });
  if (minutes > 0) return t('shell.messageList.elapsed.ms', { minutes, seconds });
  return t('shell.messageList.elapsed.seconds', { seconds });
}

interface MessageListProps {
  messages: readonly MessageType[];
  streamingMessage: MessageType | null;
  isLoading: boolean;
  sessionId?: string | null;
  /**
   * Whether this Tab is currently visible. When `false`, the host wraps this
   * subtree in `content-visibility: hidden`, which lets WebKit defer/skip
   * descendant layout. Virtuoso's ResizeObserver can then fire with zero or
   * stale geometry and erroneously emit `atBottomStateChange(false)` —
   * corrupting the follow-state machine. We use this flag to (a) ignore
   * those bogus measurements and (b) re-pin scroll to bottom on re-activation
   * if we were following before the tab went hidden.
   */
  isActive?: boolean;
  /** Native focus projection, used to preserve blur-time follow intent and fence focus recovery. */
  isWindowFocused?: boolean;
  // Pagination: Virtuoso maintains the visible scroll position across
  // prepended items by the absolute index of data[0]. Default 0 = no pagination.
  firstItemIndex?: number;
  heightEstimateSeed?: number[];
  layoutByMessageId?: ReadonlyMap<string, RowLayoutContract>;
  /** Fires when Virtuoso reaches the top — time to load an older page. */
  onLoadOlder?: () => void;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  onScrollerRef?: (el: HTMLElement | Window | null) => void;
  followEnabledRef: React.MutableRefObject<boolean | 'force'>;
  /** Drives the session-switch scroll pin — goes through the hook so grace/degrade state stays consistent. */
  scrollToBottom: (behavior?: 'smooth' | 'auto') => void;
  handleAtBottomChange: (atBottom: boolean) => void;
  onRowLayoutChanged?: (messageId: string, reason: RowLayoutChangeReason) => void;
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (requestId: string, decision: 'deny' | 'allow_once' | 'always_allow') => void | Promise<void>;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  pendingExitPlanMode?: ExitPlanModeRequest | null;
  onExitPlanModeApprove?: () => void;
  onExitPlanModeReject?: (feedback?: string) => void;
  systemStatus?: string | null;
  systemNotice?: SystemNotice | null;
  onDismissSystemNotice?: () => void;
  isStreaming?: boolean;
  /** Use the real streaming event trace instead of the generic waiting copy. */
  executionMode?: boolean;
  /**
   * (issue #174) Pulled in so the loading footer can swap the random
   * "苦思冥想中…" thinking line for an explicit "AI 启动中…" hint while the
   * SDK subprocess is alive but system_init hasn't arrived. Without this
   * the user can't tell whether the long wait is startup or actual work.
   */
  sessionState?: SessionState;
  onRewind?: (messageId: string) => void;
  onRetry?: (assistantMessageId: string) => void;
  onFork?: (assistantMessageId: string) => void;
  conversationOperations?: 'builtin' | 'codex';
  /** Stable projection of persisted Codex root-turn anchors for user-row eligibility. */
  rewindableUserMessageIds?: ReadonlySet<string>;
  bottomSpacerPx?: number;
}

interface MessageActionContext {
  conversationOperations: 'builtin' | 'codex';
  rewindableUserMessageIds: ReadonlySet<string>;
  onRewind?: (messageId: string) => void;
  onFork?: (assistantMessageId: string) => void;
}

const STREAMING_MESSAGE_COUNT = 20;
const noopRowLayoutChanged = (_messageId: string, _reason: RowLayoutChangeReason) => {};
const STATUS_ROW_HEIGHT_PX = 30;
const MAX_EXECUTION_TRACE_STEPS = 5;

type ExecutionStepStatus = 'active' | 'complete' | 'error';

interface ExecutionTraceStep {
  key: string;
  label: string;
  status: ExecutionStepStatus;
}

const EMPTY_MESSAGE_ID_SET: ReadonlySet<string> = new Set();

function isLargeRowShrink(reason: RowLayoutChangeReason): boolean {
  return reason === 'process-row-collapse' || reason === 'user-message-collapse-measured';
}

function isRowExpansion(reason: RowLayoutChangeReason): boolean {
  return reason === 'process-row-expand'
    || reason === 'user-message-expand'
    || reason === 'block-group-expand'
    || reason === 'expandable-container-expand';
}

/** Resolve dynamic system status keys (e.g., api_retry:2:5 → human-readable) */
function resolveSystemStatus(status: string, t: TFunction<'chat'>): string {
  if (status === 'compacting' || status === 'rewinding') {
    return t(`shell.messageList.systemStatus.${status}`);
  }
  // API retry: "api_retry:{attempt}:{maxAttempts}"
  if (status.startsWith('api_retry:')) {
    const parts = status.split(':');
    const attempt = parts[1] || '1';
    const max = parts[2] || '?';
    return t('shell.messageList.systemStatus.apiRetry', { attempt, max });
  }
  return status;
}
function getRandomStreamingMessage(t: TFunction<'chat'>): string {
  const index = Math.floor(Math.random() * STREAMING_MESSAGE_COUNT);
  return t(`shell.messageList.streaming.${index}`);
}

const StatusTimer = memo(function StatusTimer({ message }: { message: string }) {
  const { t } = useTranslation('chat');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef(0);
  useEffect(() => {
    startTimeRef.current = Date.now();
    const id = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedText = elapsedSeconds > 0 ? formatElapsedTime(elapsedSeconds, t) : null;
  const displayText = elapsedText ? `${message} (${elapsedText})` : message;
  return (
    <div
      data-chat-status-row=""
      className="flex items-center gap-2 overflow-hidden px-3 py-1.5 text-xs text-[var(--ink-muted)]"
      style={{ height: STATUS_ROW_HEIGHT_PX }}
      title={displayText}
    >
      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      <span className="min-w-0 truncate">{displayText}</span>
    </div>
  );
});

function buildExecutionTrace({
  isLoading,
  sessionState,
  systemStatus,
  streamingMessage,
  t,
}: {
  isLoading: boolean;
  sessionState?: SessionState;
  systemStatus?: string | null;
  streamingMessage: MessageType | null;
  t: TFunction<'chat'>;
}): ExecutionTraceStep[] {
  if (!isLoading && !systemStatus) return [];

  const steps: ExecutionTraceStep[] = [{
    key: 'submitted',
    label: t('shell.messageList.execution.submitted'),
    status: 'complete',
  }];

  if (systemStatus) {
    steps.push({ key: 'system-status', label: resolveSystemStatus(systemStatus, t), status: 'active' });
    return steps;
  }

  if (sessionState === 'starting') {
    steps.push({ key: 'starting', label: t('shell.messageList.execution.starting'), status: 'active' });
    return steps;
  }

  steps.push({ key: 'session-ready', label: t('shell.messageList.execution.sessionReady'), status: 'complete' });

  if (!streamingMessage || streamingMessage.role !== 'assistant') {
    steps.push({ key: 'waiting-first-response', label: t('shell.messageList.execution.waitingFirstResponse'), status: 'active' });
    return steps;
  }

  if (typeof streamingMessage.content === 'string') {
    steps.push({ key: 'generating', label: t('shell.messageList.execution.generating'), status: 'active' });
    return steps;
  }

  for (const [index, block] of streamingMessage.content.entries()) {
    if (block.type === 'thinking') {
      steps.push({
        key: `thinking-${index}`,
        label: t('shell.messageList.execution.thinking'),
        status: block.isFailed ? 'error' : block.isComplete ? 'complete' : 'active',
      });
      continue;
    }

    if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool) {
      const toolLabel = getToolLabel(block.tool, t);
      const status: ExecutionStepStatus = block.tool.isError || block.tool.isFailed
        ? 'error'
        : block.tool.isLoading ? 'active' : 'complete';
      steps.push({
        key: `tool-${block.tool.id || index}`,
        label: status === 'error'
          ? t('shell.messageList.execution.toolFailed', { name: toolLabel })
          : status === 'active'
            ? t('shell.messageList.execution.toolRunning', { name: toolLabel })
            : t('shell.messageList.execution.toolCompleted', { name: toolLabel }),
        status,
      });
      continue;
    }

    if (block.type === 'text' && (block.text || streamingMessage.streamingTextActive)) {
      steps.push({
        key: `generating-${index}`,
        label: t('shell.messageList.execution.generating'),
        status: streamingMessage.streamingTextActive ? 'active' : 'complete',
      });
    }
  }

  if (!steps.some(step => step.status === 'active')) {
    steps.push({ key: 'waiting-next-response', label: t('shell.messageList.execution.waitingNextResponse'), status: 'active' });
  }

  return steps;
}

const ExecutionTrace = memo(function ExecutionTrace({ steps }: { steps: readonly ExecutionTraceStep[] }) {
  const { t } = useTranslation('chat');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef(0);
  useEffect(() => {
    startTimeRef.current = Date.now();
    const id = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const visibleSteps = steps.length > MAX_EXECUTION_TRACE_STEPS
    ? [steps[0], ...steps.slice(-(MAX_EXECUTION_TRACE_STEPS - 1))]
    : steps;
  const currentStep = [...visibleSteps].reverse().find(step => step.status === 'active') ?? visibleSteps[visibleSteps.length - 1];
  const elapsedText = elapsedSeconds > 0 ? formatElapsedTime(elapsedSeconds, t) : null;

  return (
    <section
      data-agent-execution-trace=""
      aria-live="polite"
      className="mx-3 my-2 border-l-2 border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)] px-3 py-2"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--ink-secondary)]">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent-cool)]" />
        <span className="min-w-0 flex-1 truncate">{currentStep?.label}</span>
        {elapsedText && <span className="shrink-0 text-[var(--ink-muted)]">{elapsedText}</span>}
      </div>
      <ol className="mt-2 space-y-1">
        {visibleSteps.map(step => {
          const Icon = step.status === 'active' ? Loader2 : step.status === 'error' ? AlertCircle : CheckCircle;
          const colorClass = step.status === 'active'
            ? 'text-[var(--accent-cool)]'
            : step.status === 'error' ? 'text-[var(--error)]' : 'text-[var(--success)]';
          return (
            <li key={step.key} className="flex items-center gap-2 text-xs text-[var(--ink-muted)]">
              <Icon className={`h-3 w-3 shrink-0 ${colorClass} ${step.status === 'active' ? 'animate-spin' : ''}`} />
              <span className="min-w-0 truncate">{step.label}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
});

const SystemNoticeRow = memo(function SystemNoticeRow({
  notice,
  onDismiss,
}: {
  notice: SystemNotice;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation('chat');
  const isError = notice.level === 'error';
  const Icon = isError ? AlertCircle : CheckCircle;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--ink-muted)]">
      <Icon className={`h-3 w-3 flex-shrink-0 ${isError ? 'text-[var(--error)]' : 'text-[var(--success)]'}`} />
      <span className="flex-1">{notice.message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-0.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-muted)]"
          title={t('shell.common.close')}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
});

function hasExitPlanModeTool(message: MessageType): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string') return false;
  return message.content.some(
    block => (block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool?.name === 'ExitPlanMode'
  );
}

// ── Virtuoso Footer — memo'd component that reads dynamic values from refs ──
// Must NOT be recreated on every render (inline arrow in `components` causes Virtuoso
// to remount the footer, resetting StatusTimer and forcing extra remeasurement).
const VirtuosoFooter = memo(function VirtuosoFooter({
  pendingPermission, onPermissionDecision,
  pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel,
  showStatus, statusMessage,
  executionMode, executionSteps,
  systemNotice, onDismissSystemNotice,
  bottomSpacerPx,
}: {
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (requestId: string, decision: 'deny' | 'allow_once' | 'always_allow') => void | Promise<void>;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  showStatus: boolean;
  statusMessage: string;
  executionMode?: boolean;
  executionSteps?: readonly ExecutionTraceStep[];
  systemNotice?: SystemNotice | null;
  onDismissSystemNotice?: () => void;
  bottomSpacerPx?: number;
}) {
  const spacerHeight = resolveChatBottomSpacerPx(bottomSpacerPx);
  return (
    <div className="mx-auto max-w-3xl px-3">
      {pendingPermission && onPermissionDecision && (
        <div className="py-2">
          <PermissionPrompt
            key={pendingPermission.requestId}
            request={pendingPermission}
            onDecision={onPermissionDecision}
          />
        </div>
      )}
      {pendingAskUserQuestion && onAskUserQuestionSubmit && onAskUserQuestionCancel && (
        <div className="py-2">
          <AskUserQuestionPrompt request={pendingAskUserQuestion} onSubmit={onAskUserQuestionSubmit} onCancel={onAskUserQuestionCancel} />
        </div>
      )}
      {showStatus && (executionMode && executionSteps?.length
        ? <ExecutionTrace steps={executionSteps} />
        : <StatusTimer message={statusMessage} />)}
      {!showStatus && systemNotice && (
        <SystemNoticeRow notice={systemNotice} onDismiss={onDismissSystemNotice} />
      )}
      {/* Footer spacer follows the measured floating input stack. The extra
          clearance in resolveChatBottomSpacerPx keeps both the status row and
          streaming tail comfortably above the composer without moving either
          out of Virtuoso's scroll geometry. */}
      <div data-chat-footer-spacer="" style={{ height: spacerHeight }} aria-hidden="true" />
    </div>
  );
});

// ── No custom Scroller/List components ──
// Tested: custom Scroller (py-3 padding) and List (mx-auto max-w-3xl) break Virtuoso's
// internal height tracking — scrollHeight diverges from totalListHeight by 12,000+ px,
// causing phantom repeated content. Styling is applied inside itemContent instead.

const MessageList = memo(function MessageList({
  messages,
  streamingMessage,
  isLoading,
  sessionId,
  isActive = true,
  isWindowFocused = true,
  firstItemIndex,
  heightEstimateSeed,
  layoutByMessageId,
  onLoadOlder,
  virtuosoRef,
  onScrollerRef,
  followEnabledRef,
  scrollToBottom,
  handleAtBottomChange,
  onRowLayoutChanged,
  pendingPermission,
  onPermissionDecision,
  pendingAskUserQuestion,
  onAskUserQuestionSubmit,
  onAskUserQuestionCancel,
  pendingExitPlanMode,
  onExitPlanModeApprove,
  onExitPlanModeReject,
  systemStatus,
  systemNotice,
  onDismissSystemNotice,
  isStreaming,
  sessionState,
  executionMode = false,
  onRewind,
  onRetry,
  onFork,
  conversationOperations = 'builtin',
  rewindableUserMessageIds,
  bottomSpacerPx,
}: MessageListProps) {
  const { t } = useTranslation('chat');
  const committedWindowFocusedRef = useRef(isWindowFocused);
  const isWindowFocusReturn = isWindowFocused && !committedWindowFocusedRef.current;
  const liveHeightEstimateSeed = heightEstimateSeed?.length === messages.length ? heightEstimateSeed : undefined;

  const streamingStatusMessage = useMemo(
    () => getRandomStreamingMessage(t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages.length, t]
  );

  // ExitPlanMode
  const exitPlanModeAnchorId = useMemo(() => {
    if (!pendingExitPlanMode) return null;
    if (streamingMessage && hasExitPlanModeTool(streamingMessage)) return streamingMessage.id;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (hasExitPlanModeTool(messages[i])) return messages[i].id;
    }
    return null;
  }, [pendingExitPlanMode, streamingMessage, messages]);
  const exitPlanModeSlot = useMemo(() => {
    if (!pendingExitPlanMode || !onExitPlanModeApprove || !onExitPlanModeReject) return undefined;
    return (
      <div className="py-2">
        <ExitPlanModePrompt key={pendingExitPlanMode.requestId} request={pendingExitPlanMode} onApprove={onExitPlanModeApprove} onReject={onExitPlanModeReject} />
      </div>
    );
  }, [pendingExitPlanMode, onExitPlanModeApprove, onExitPlanModeReject]);

  const showStatus = isLoading || !!systemStatus;
  // (issue #174) During 'starting' the SDK subprocess is alive but hasn't
  // sent system_init — the random "苦思冥想中…" line would falsely imply the
  // model is already thinking. Surface a startup-specific hint instead.
  // systemStatus (e.g. compacting / api_retry) still wins because it carries
  // a more specific signal that overrides both starting and the generic
  // thinking line.
  const statusMessage = systemStatus
    ? resolveSystemStatus(systemStatus, t)
    : sessionState === 'starting'
      ? t('shell.messageList.starting')
      : streamingStatusMessage;
  const executionSteps = useMemo(() => buildExecutionTrace({
    isLoading,
    sessionState,
    systemStatus,
    streamingMessage,
    t,
  }), [isLoading, sessionState, systemStatus, streamingMessage, t]);

  // Scroll to bottom after session load / switch. Runs synchronously before
  // the next paint so there's no visible top→bottom jump when the new session's
  // data prop arrives — critical now that Virtuoso stays mounted across switches
  // (see the note below about removing `key={sessionId}`). Routes through the hook's
  // scrollToBottom('auto') so the force/grace/auto-degrade state machine stays in one
  // place — writing `followEnabledRef.current = 'force'` inline would leak force into
  // subsequent content changes without the safety timer.
  const lastScrolledSessionRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    // Never drive Virtuoso while hidden (content-visibility:hidden → stale geometry,
    // same cache-poisoning class as the data freeze below). If the session changed
    // while inactive, defer the pin: leaving lastScrolledSessionRef unset means this
    // effect re-fires and pins once isActive flips true.
    if (!isActive) return;
    if (!sessionId || sessionId === lastScrolledSessionRef.current) return;
    if (messages.length === 0) return;
    lastScrolledSessionRef.current = sessionId;
    scrollToBottom('auto');
  }, [isActive, sessionId, messages.length, scrollToBottom]);

  // Tab inactive ↔ active follow-state preservation.
  //
  // While inactive, the host wraps us in `content-visibility: hidden`. WebKit
  // skips descendant layout, so Virtuoso's ResizeObserver and internal bottom-
  // detection math can fire with zero/stale geometry. The `guardedAtBottomChange`
  // below catches the common case (atBottom callback fired while !isActive), but
  // there are timing windows around the inactive↔active transition itself where a
  // queued callback can race with the React re-render and slip through with the
  // wrong closure. Once `followEnabledRef` flips to `false`, the previous "skip
  // recovery if not following" guard would silently drop us out of follow mode
  // permanently for this stream — exactly the user-reported bug.
  //
  // Pit-of-success fix: snapshot the live follow state at the precise moment the
  // tab goes inactive (when measurements are still trustworthy and the user's
  // intent is unambiguous), then on re-activation restore the snapshot and re-pin
  // to bottom if the snapshot says we were following. This makes recovery
  // independent of whatever happens to `followEnabledRef` during the hidden
  // window — even if a stale observer flips it, the snapshot is authoritative.
  // 'force' is normalized to `true` because force is a transient programmatic
  // state; restoring it would re-enter `force` with no scrollToBottom call to
  // back it up, defeating the auto-degrade timer.
  const inactiveSnapshotRef = useRef<boolean | 'force' | null>(null);
  // Session the snapshot belongs to. A session switch while hidden invalidates the
  // snapshot: the old session's follow intent must not carry into the new session.
  const inactiveSnapshotSessionRef = useRef<string | null | undefined>(null);
  useLayoutEffect(() => {
    if (!isActive) {
      if (inactiveSnapshotRef.current === null) {
        const cur = followEnabledRef.current;
        inactiveSnapshotRef.current = cur === 'force' ? true : cur;
        inactiveSnapshotSessionRef.current = sessionId;
      }
      return;
    }
    const snap = inactiveSnapshotRef.current;
    const snapSession = inactiveSnapshotSessionRef.current;
    if (snap === null) return; // initial mount or no inactive transition recorded
    inactiveSnapshotRef.current = null;
    // Session changed while hidden → the old snapshot is stale. Drop it and let the
    // session-switch pin effect own scroll + follow for the new session (it defaults
    // a fresh session to bottom, and scrollToBottom's 'force' degrades to follow=true).
    // Without this, restoring a stale `snap === false` here would leave the freshly
    // switched-to session pinned at bottom but with auto-follow silently disabled.
    if (snapSession !== sessionId) return;
    // Restore from snapshot regardless of branch — both directions need to overwrite
    // whatever the live ref currently says. If `snap === false` we restore `false`
    // explicitly: a stale atBottom(true) callback during the hidden window could
    // have flipped the live ref to `true`, which would silently re-engage follow
    // mode against the user's actual intent (they had scrolled up before leaving).
    followEnabledRef.current = snap;
    // User had scrolled up before switching away — respect that, leave scroll alone.
    if (snap === false) return;
    // User was at bottom before switching away. Re-pin to actual scroll bottom.
    // scrollToBottom() flips the ref to 'force' + arms grace/auto-degrade timer.
    if (messages.length > 0) {
      scrollToBottom('auto');
    }
  }, [isActive, messages.length, scrollToBottom, sessionId, followEnabledRef]);

  // Keep the follow intent captured at blur authoritative until focus returns.
  // Layout-driven atBottom changes may still arrive while the visible window is
  // unfocused; rendering stays live, but those callbacks are not user intent.
  const guardedAtBottomChange = useCallback((atBottom: boolean) => {
    if (!isActive || !isWindowFocused || (isWindowFocusReturn && !committedWindowFocusedRef.current)) return;
    handleAtBottomChange(atBottom);
  }, [isActive, isWindowFocused, isWindowFocusReturn, handleAtBottomChange]);

  // ── Auto-scroll during streaming — keep the view pinned to the bottom as the
  // streaming item grows taller. `followOutput` only fires on item-COUNT change,
  // so the last item growing (text / thinking streaming in) needs an explicit nudge.
  //
  // This must stay inside Virtuoso's own scroll model — never write `el.scrollTop`
  // directly. The important detail is timing: `autoscrollToBottom()` is designed
  // for late size changes such as image loads; in react-virtuoso 4.18.3 it waits
  // for an atBottomState update and clears the observer after 100ms. Used for
  // per-token text streaming from a passive effect + rAF, it lets the browser
  // paint one frame where the growing row/footer push the status down, then snaps
  // back on Virtuoso's delayed correction. A layout-effect `scrollToIndex` lands
  // the LAST/end alignment before paint while still going through Virtuoso.
  //
  // Gated on `isLoading` (actual streaming), not merely `!!streamingMessage`: a
  // stale streaming message from the loadSession-REST / live-SSE mid-turn race
  // must NOT keep auto-scroll alive once the turn has completed.
  useLayoutEffect(() => {
    if (!streamingMessage || !isLoading || !followEnabledRef.current) return;
    // Skip while the internal Tab is hidden — scrolling against a
    // content-visibility:hidden scroller
    // can compute against stale geometry. The re-pin layout effect above restores
    // position on re-activation.
    if (!isActive) return;
    // Window-focus recovery belongs to ChatScrollController. A focus-only
    // geometry transition must not create a second LAST/end command here.
    if (isWindowFocusReturn) return;
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
  }, [streamingMessage, isLoading, isActive, isWindowFocusReturn, followEnabledRef, virtuosoRef]);

  // ── Terminal pin — pin to bottom once when a turn ends ──
  // At turn end the data-layer reveal drains the remaining text and the message moves to
  // history in a single React batch; the streaming-driven autoscroll effect above gates on
  // `isLoading`, so it won't fire for that final height growth. Without this, the last
  // revealed line(s) can land just below the fold. If we were still following (true/'force'),
  // re-pin once. Routes through scrollToBottom so the hook's grace/degrade state stays consistent.
  const prevIsLoadingRef = useRef(isLoading);
  useLayoutEffect(() => {
    const was = prevIsLoadingRef.current;
    prevIsLoadingRef.current = isLoading;
    if (was && !isLoading && isActive && !isWindowFocusReturn && followEnabledRef.current) {
      scrollToBottom('auto');
    }
  }, [isLoading, isActive, isWindowFocusReturn, followEnabledRef, scrollToBottom]);

  // Mark the focus commit trustworthy only after Virtuoso's child layout
  // effects have run. During that commit callbacks and local pins stay gated;
  // the parent ChatScrollController then executes the sole recovery intent.
  useLayoutEffect(() => {
    committedWindowFocusedRef.current = isWindowFocused;
  }, [isWindowFocused]);

  // ── Refs for stable callbacks — avoid recreating itemContent/Footer on every render ──
  const streamingMessageRef = useRef(streamingMessage);
  streamingMessageRef.current = streamingMessage;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const exitPlanModeAnchorIdRef = useRef(exitPlanModeAnchorId);
  exitPlanModeAnchorIdRef.current = exitPlanModeAnchorId;
  const exitPlanModeSlotRef = useRef(exitPlanModeSlot);
  exitPlanModeSlotRef.current = exitPlanModeSlot;
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;
  const layoutByMessageIdRef = useRef(layoutByMessageId);
  layoutByMessageIdRef.current = layoutByMessageId;
  const onRowLayoutChangedRef = useRef(onRowLayoutChanged ?? noopRowLayoutChanged);
  onRowLayoutChangedRef.current = onRowLayoutChanged ?? noopRowLayoutChanged;
  const isItemMeasurementActiveRef = useRef(isActive);
  isItemMeasurementActiveRef.current = isActive;
  const measureVisibleItemSize = useCallback<SizeFunction>((element, field) => {
    if (!isItemMeasurementActiveRef.current) {
      const knownSize = Number(element.dataset.knownSize);
      if (Number.isFinite(knownSize)) return knownSize;
    }
    const rectField = field === 'offsetWidth' ? 'width' : 'height';
    return Math.round(element.getBoundingClientRect()[rectField]);
  }, []);
  const [isLargeRowShrinking, setIsLargeRowShrinking] = useState(false);
  const collapseMeasureFrameRef = useRef<number | null>(null);
  const collapseSettleFrameRef = useRef<number | null>(null);
  const cancelPendingLargeRowShrink = useCallback(() => {
    if (collapseMeasureFrameRef.current !== null) {
      cancelAnimationFrame(collapseMeasureFrameRef.current);
      collapseMeasureFrameRef.current = null;
    }
    if (collapseSettleFrameRef.current !== null) {
      cancelAnimationFrame(collapseSettleFrameRef.current);
      collapseSettleFrameRef.current = null;
    }
  }, []);
  const handleRowLayoutChanged = useCallback((messageId: string, reason: RowLayoutChangeReason) => {
    if (isLargeRowShrink(reason)) {
      cancelPendingLargeRowShrink();
      // Keep the normal synchronous measurement path for expansion: it prevents
      // Virtuoso from correcting the viewport one frame after the user clicks.
      // A large shrink is the inverse WebKit hazard, so hold the rAF-delayed path
      // through React's commit and Virtuoso's following measurement commit, then
      // restore the fast path. This is a bounded geometry transaction, not a retry.
      setIsLargeRowShrinking(true);
      collapseMeasureFrameRef.current = requestAnimationFrame(() => {
        collapseMeasureFrameRef.current = null;
        collapseSettleFrameRef.current = requestAnimationFrame(() => {
          collapseSettleFrameRef.current = null;
          setIsLargeRowShrinking(false);
        });
      });
    } else if (isRowExpansion(reason)) {
      // A rapid re-open (or another row's expand) takes precedence over a pending
      // shrink settlement. Restore synchronous measurement in the same React
      // batch as the expansion so the clicked content never jumps out of view.
      cancelPendingLargeRowShrink();
      setIsLargeRowShrinking(false);
    }
    onRowLayoutChangedRef.current(messageId, reason);
  }, [cancelPendingLargeRowShrink]);
  useLayoutEffect(() => {
    if (isActive) return;
    // A delayed ResizeObserver callback may already be queued when the host hides
    // this Tab with content-visibility. Cancel our transaction before the next
    // frame; measureVisibleItemSize also fences any already-queued Virtuoso callback
    // to its last known size so hidden geometry cannot poison the size cache.
    cancelPendingLargeRowShrink();
    setIsLargeRowShrinking(false);
  }, [cancelPendingLargeRowShrink, isActive]);
  useEffect(() => cancelPendingLargeRowShrink, [cancelPendingLargeRowShrink]);
  // followOutput / startReached capture `isActive` DIRECTLY (not via a ref). Under
  // React 19's child-before-parent layout-effect ordering, a ref updated in our parent
  // layout effect could still read a stale value when Virtuoso's child effects fire
  // these callbacks first on the active→hidden commit. Capturing the prop means the
  // callback Virtuoso holds always matches the committed render. These recreate only on
  // a tab active⇄inactive flip (rare — no per-stream churn) and are not itemContent, so
  // a new identity never remounts rows.
  const handleFollowOutput = useMemo(
    () => (isAtBottom: boolean) => {
      // Hidden tab (content-visibility:hidden): never drive follow-scroll against
      // skipped/stale geometry (same cache-poisoning class as the data freeze below).
      if (!isActive || (isWindowFocusReturn && !committedWindowFocusedRef.current)) return false;
      const mode = followEnabledRef.current;
      if (!mode) return false;
      if (mode === 'force') return 'smooth' as const;
      return isAtBottom ? 'smooth' as const : false;
    },
    [followEnabledRef, isActive, isWindowFocusReturn]
  );

  // Pagination guard: don't load an older page off stale range math while hidden —
  // Virtuoso can fire startReached from corrupted offsets when our subtree's layout
  // was skipped (content-visibility:hidden), and a prepend in that state compounds the desync.
  const guardedLoadOlder = useCallback(() => {
    if (!isActive || (isWindowFocusReturn && !committedWindowFocusedRef.current)) return;
    onLoadOlder?.();
  }, [onLoadOlder, isActive, isWindowFocusReturn]);

  const [debugScroller, setDebugScroller] = useState<HTMLElement | null>(null);
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const next = el instanceof HTMLElement ? el : null;
    setDebugScroller(prev => (prev === next ? prev : next));
    onScrollerRef?.(el);
  }, [onScrollerRef]);

  const messageActionContext = useMemo<MessageActionContext>(() => ({
    conversationOperations,
    rewindableUserMessageIds: rewindableUserMessageIds ?? EMPTY_MESSAGE_ID_SET,
    onRewind,
    onFork,
  }), [conversationOperations, onFork, onRewind, rewindableUserMessageIds]);

  // ── Stable itemContent — volatile row actions arrive through Virtuoso context ──
  // eslint-disable-next-line react/display-name
  const renderItem = useMemo(() => (index: number, message: MessageType, actionContext: MessageActionContext) => {
    const sm = streamingMessageRef.current;
    const isStreamingMsg = !!sm && message === sm;
    const codexOperations = actionContext.conversationOperations === 'codex';
    const canRewind = !codexOperations || actionContext.rewindableUserMessageIds.has(message.id);
    const canFork = !codexOperations || Boolean(message.runtimeTurnAnchor);
    // `flow-root` (not `overflow-hidden`) establishes a BFC so child Markdown
    // margins don't leak past the wrapper — that's what e6de7173 originally
    // wanted. `overflow-hidden` did the same job but added a hard clip side
    // effect: when Virtuoso's height estimate (`defaultItemHeight=480`) was
    // far from actual short-item height (~80px), the post-mount measurement
    // correction shifted scroll anchors enough that short user bubbles got
    // visually clipped instead of merely positioned slightly off — they
    // disappeared while neighbouring items merged. flow-root keeps the
    // measurement fix without the clipping.
    return (
      <div
        className="mx-auto max-w-3xl px-3 py-1 flow-root"
        data-chat-search-scope=""
        data-message-id={message.id}
      >
        <ChatRowLayoutProvider
          messageId={message.id}
          onRowLayoutChanged={handleRowLayoutChanged}
        >
          <Message
            message={message}
            isLoading={isStreamingMsg && isLoadingRef.current}
            onRewind={canRewind ? actionContext.onRewind : undefined}
            onRetry={onRetryRef.current}
            onFork={canFork ? actionContext.onFork : undefined}
            exitPlanModeSlot={message.id === exitPlanModeAnchorIdRef.current ? exitPlanModeSlotRef.current : undefined}
            initialUserCollapsed={layoutByMessageIdRef.current?.get(message.id)?.likelyUserCollapsed === true}
          />
        </ChatRowLayoutProvider>
      </div>
    );
  }, [handleRowLayoutChanged]);

  // ── Stable computeItemKey ──
  const computeItemKey = useMemo(() => (_i: number, m: MessageType) => m.id, []);

  // ── Stable Footer wrapper — useMemo keeps component identity stable for Virtuoso ──
  const FooterComponent = useMemo(() => {
    return function Footer() {
      return (
        <VirtuosoFooter
          pendingPermission={pendingPermission}
          onPermissionDecision={onPermissionDecision}
          pendingAskUserQuestion={pendingAskUserQuestion}
          onAskUserQuestionSubmit={onAskUserQuestionSubmit}
          onAskUserQuestionCancel={onAskUserQuestionCancel}
          showStatus={showStatus}
          statusMessage={statusMessage}
          executionMode={executionMode}
          executionSteps={executionSteps}
          systemNotice={systemNotice}
          onDismissSystemNotice={onDismissSystemNotice}
          bottomSpacerPx={bottomSpacerPx}
        />
      );
    };
  }, [pendingPermission, onPermissionDecision, pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel, showStatus, statusMessage, executionMode, executionSteps, systemNotice, onDismissSystemNotice, bottomSpacerPx]);

  // ── Stable components object ──
  const components = useMemo(() => ({ Footer: FooterComponent }), [FooterComponent]);

  // ── Freeze the data fed to Virtuoso while the internal Tab is inactive ──────
  // An inactive internal Tab is wrapped in `content-visibility: hidden`, so any
  // data/height change Virtuoso processes is measured against skipped / stale
  // geometry, which poisons its internal offset+range cache → PHANTOM REPEATED ROWS,
  // then a BLANK viewport once the user scrolls back — recoverable only by remount
  // (close+reopen rebuilds the cache).
  //
  // The trigger is streaming-while-hidden: TabProvider's per-character reveal rAF
  // loop (and the tool-delta rAF flushes) keep growing the last row's height even
  // while we're hidden. Rather than chase every producer that can mutate the live
  // array, we pin the `data` / `firstItemIndex` handed to Virtuoso to the last
  // snapshot taken while active. With a referentially-stable data prop, Virtuoso
  // does no measurement work while hidden no matter how much the live array churns.
  // On re-activation we swap back to the live array (Virtuoso reconciles by
  // computeItemKey=m.id and re-measures the grown last row with real geometry); the
  // inactive→active re-pin effect above restores scroll position.
  //
  // The snapshot advances in a post-commit layout effect, NOT during render: a
  // render-phase write could persist a speculative (interrupted/discarded) active
  // snapshot under React 19 concurrency, which a later hidden render could then hand
  // to Virtuoso — exactly the post-hide measurement we're preventing. A committed
  // layout effect guarantees the snapshot is always a real, measured-while-visible state.
  const frozenDataRef = useRef<{
    data: readonly MessageType[];
    firstItemIndex: number | undefined;
    heightEstimateSeed?: number[];
    components: typeof components;
    messageActionContext: MessageActionContext;
  }>({
    data: messages,
    firstItemIndex,
    heightEstimateSeed: liveHeightEstimateSeed,
    components,
    messageActionContext,
  });
  useLayoutEffect(() => {
    if (isActive) {
      frozenDataRef.current = {
        data: messages,
        firstItemIndex,
        heightEstimateSeed: liveHeightEstimateSeed,
        components,
        messageActionContext,
      };
    }
  }, [isActive, messages, firstItemIndex, liveHeightEstimateSeed, components, messageActionContext]);
  const virtuosoData = isActive ? messages : frozenDataRef.current.data;
  const virtuosoFirstItemIndex = isActive ? firstItemIndex : frozenDataRef.current.firstItemIndex;
  const virtuosoHeightEstimateSeed = isActive ? liveHeightEstimateSeed : frozenDataRef.current.heightEstimateSeed;
  const virtuosoComponents = isActive ? components : frozenDataRef.current.components;
  const virtuosoMessageActionContext = isActive
    ? messageActionContext
    : frozenDataRef.current.messageActionContext;
  const debugProbe = useChatScrollDebugProbe({
    sessionId,
    scroller: debugScroller,
    data: virtuosoData,
    heightEstimateSeed: virtuosoHeightEstimateSeed,
  });

  return (
    <div
      className="relative flex-1"
      data-streaming={isStreaming || undefined}
    >
      {/*
        Virtuoso stays mounted across session switches. Previously `key={sessionId}`
        forced a full remount, which dropped every cached item height, rebuilt
        every ResizeObserver, and kicked off a measure→reflow→remeasure storm on
        large sessions — the single biggest contributor to "click a notification,
        come back, UI frozen for 3-5s". Now session changes are a pure data swap:
        `computeItemKey={m.id}` ensures Virtuoso reconciles items by identity,
        and the useLayoutEffect above lands the scroll on the last item in a
        single pre-paint call. Heights are recomputed lazily as items come into
        view, not up front.

        defaultItemHeight=480 is an empirical average across tool-use / text /
        thinking blocks; too low (200) causes Virtuoso to over-render initially,
        too high leaves holes at the bottom. 480 stays close to long-content
        reality but does produce sizeable post-mount corrections on short user
        bubbles (~80-150px). The previous wrapper used `overflow-hidden`, which
        amplified those corrections into hard clips: short bubbles vanished
        while neighbours merged. The wrapper is now `flow-root` (above), so any
        residual correction shows up as a small scroll bounce rather than a
        disappearing message.

        The extra top viewport and item-count overscan bias reverse scrolling
        toward pre-measuring tall Markdown/code rows before they enter view.
        Synchronous ResizeObserver delivery keeps expansions visually anchored,
        but a large one-commit collapse needs the normal animation-frame boundary
        so WebKit can publish the shorter overflow and hit-test geometry together.
        `overflowAnchor` leaves scroll anchoring to Virtuoso instead of the browser.
      */}
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={handleScrollerRef}
        data={virtuosoData}
        context={virtuosoMessageActionContext}
        computeItemKey={computeItemKey}
        firstItemIndex={virtuosoFirstItemIndex}
        heightEstimates={virtuosoHeightEstimateSeed}
        startReached={onLoadOlder ? guardedLoadOlder : undefined}
        followOutput={handleFollowOutput}
        atBottomStateChange={guardedAtBottomChange}
        rangeChanged={debugProbe?.handleRangeChanged}
        itemsRendered={debugProbe?.handleItemsRendered}
        atBottomThreshold={50}
        itemSize={measureVisibleItemSize}
        defaultItemHeight={480}
        increaseViewportBy={{ top: 1600, bottom: 800 }}
        minOverscanItemCount={{ top: 3, bottom: 1 }}
        skipAnimationFrameInResizeObserver={!isActive || !isLargeRowShrinking}
        className="h-full"
        style={{ overscrollBehavior: 'none', scrollbarGutter: 'stable', overflowAnchor: 'none' }}
        components={virtuosoComponents}
        itemContent={renderItem}
      />
    </div>
  );
});

export default MessageList;
