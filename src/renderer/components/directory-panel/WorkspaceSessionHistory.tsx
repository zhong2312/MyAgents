import {
  ChevronRight,
  Folder,
  History,
  Loader2,
  MessageSquareText,
  RefreshCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { getSessions, type SessionMetadata } from "@/api/sessionClient";
import { currentSupportedLocale } from "@/i18n/format";
import { formatTime } from "@/utils/taskCenterUtils";
import { getSessionDisplayText } from "@/utils/sessionDisplay";
import { CUSTOM_EVENTS } from "../../../shared/constants";
import { isSystemMaintenanceSession } from "../../../shared/managedScheduledJob";
import { isAutomationHistoryOrigin } from "../../../shared/session-origin";
import { parseSessionHistoryGroupPath } from "../../../shared/session-history";

interface WorkspaceSessionHistoryProps {
  readonly agentDir: string;
  readonly currentSessionId?: string | null;
  readonly onSelectSession?: (sessionId: string, title: string) => void;
  /** Controls the initial accordion state without changing generic workspace history defaults. */
  readonly defaultExpanded?: boolean;
}

interface SessionHistoryGroup {
  readonly key: string;
  readonly label: string;
  readonly sessions: readonly SessionMetadata[];
  readonly children: readonly SessionHistoryGroup[];
  readonly lastActiveAtMs: number;
}

interface MutableSessionHistoryGroup {
  key: string;
  label: string;
  sessions: SessionMetadata[];
  children: Map<string, MutableSessionHistoryGroup>;
  lastActiveAtMs: number;
}

function sessionActivityMs(session: SessionMetadata): number {
  const value = Date.parse(session.lastActiveAt);
  return Number.isFinite(value) ? value : 0;
}

function safeHistoryGroupPath(session: SessionMetadata): readonly string[] {
  try {
    return parseSessionHistoryGroupPath(session.historyGroupPath) ?? [];
  } catch {
    return [];
  }
}

function buildSessionHistoryTree(sessions: readonly SessionMetadata[]): {
  readonly rootSessions: readonly SessionMetadata[];
  readonly groups: readonly SessionHistoryGroup[];
} {
  const rootSessions: SessionMetadata[] = [];
  const roots = new Map<string, MutableSessionHistoryGroup>();

  for (const session of sessions) {
    const path = safeHistoryGroupPath(session);
    if (path.length === 0) {
      rootSessions.push(session);
      continue;
    }

    let siblings = roots;
    let parentKey = "";
    for (const segment of path) {
      const key = parentKey ? `${parentKey}\u001f${segment}` : segment;
      let group = siblings.get(segment);
      if (!group) {
        group = {
          key,
          label: segment,
          sessions: [],
          children: new Map(),
          lastActiveAtMs: 0,
        };
        siblings.set(segment, group);
      }
      group.lastActiveAtMs = Math.max(
        group.lastActiveAtMs,
        sessionActivityMs(session),
      );
      siblings = group.children;
      parentKey = key;
    }

    let leafSiblings = roots;
    let leaf: MutableSessionHistoryGroup | undefined;
    for (const segment of path) {
      leaf = leafSiblings.get(segment);
      if (!leaf) break;
      leafSiblings = leaf.children;
    }
    leaf?.sessions.push(session);
  }

  const freezeGroups = (
    groups: ReadonlyMap<string, MutableSessionHistoryGroup>,
  ): SessionHistoryGroup[] =>
    [...groups.values()]
      .sort(
        (left, right) =>
          right.lastActiveAtMs - left.lastActiveAtMs ||
          left.label.localeCompare(right.label),
      )
      .map((group) => ({
        key: group.key,
        label: group.label,
        sessions: [...group.sessions].sort(
          (left, right) => sessionActivityMs(right) - sessionActivityMs(left),
        ),
        children: freezeGroups(group.children),
        lastActiveAtMs: group.lastActiveAtMs,
      }));

  return {
    rootSessions: rootSessions.sort(
      (left, right) => sessionActivityMs(right) - sessionActivityMs(left),
    ),
    groups: freezeGroups(roots),
  };
}

export default function WorkspaceSessionHistory({
  agentDir,
  currentSessionId,
  onSelectSession,
  defaultExpanded = true,
}: WorkspaceSessionHistoryProps) {
  const { t } = useTranslation("chat");
  const locale = currentSupportedLocale();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [sessions, setSessions] = useState<SessionMetadata[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const requestSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequenceRef.current;
    try {
      const loaded = await getSessions(agentDir);
      if (sequence !== requestSequenceRef.current) return;
      setLoadError(false);
      setSessions(
        loaded.filter(
          (session) =>
            !isSystemMaintenanceSession(session) &&
            !isAutomationHistoryOrigin(session.origin, {
              cronTaskId: session.cronTaskId,
              source: session.source,
            }),
        ),
      );
    } catch (error) {
      if (sequence !== requestSequenceRef.current) return;
      console.error("[WorkspaceSessionHistory] Failed to load sessions:", error);
      setSessions([]);
      setLoadError(true);
    }
  }, [agentDir]);

  useEffect(() => {
    if (!isExpanded) return;
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 15_000);
    const handleHistoryChange = () => void refresh();
    window.addEventListener(
      CUSTOM_EVENTS.SESSION_TITLE_CHANGED,
      handleHistoryChange,
    );
    window.addEventListener(
      CUSTOM_EVENTS.SESSION_HISTORY_CHANGED,
      handleHistoryChange,
    );
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener(
        CUSTOM_EVENTS.SESSION_TITLE_CHANGED,
        handleHistoryChange,
      );
      window.removeEventListener(
        CUSTOM_EVENTS.SESSION_HISTORY_CHANGED,
        handleHistoryChange,
      );
    };
  }, [isExpanded, refresh, currentSessionId]);

  const tree = useMemo(
    () => buildSessionHistoryTree(sessions ?? []),
    [sessions],
  );

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderSession = (session: SessionMetadata, depth: number) => {
    const current = session.id === currentSessionId;
    return (
      <button
        key={session.id}
        type="button"
        aria-current={current ? "page" : undefined}
        title={getSessionDisplayText(session)}
        onClick={() => {
          if (!current) onSelectSession?.(session.id, getSessionDisplayText(session));
        }}
        className={`flex h-8 w-full items-center gap-2 pr-3 text-left text-xs transition-colors ${
          current
            ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]"
            : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        }`}
        style={{ paddingLeft: `${16 + depth * 14}px` }}
      >
        <MessageSquareText
          className={`h-3.5 w-3.5 shrink-0 ${
            current ? "text-[var(--accent-warm)]" : "text-[var(--ink-subtle)]"
          }`}
        />
        <span className="min-w-0 flex-1 truncate">
          {getSessionDisplayText(session)}
        </span>
        <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
          {formatTime(session.lastActiveAt, new Date(), locale)}
        </span>
      </button>
    );
  };

  const renderGroup = (group: SessionHistoryGroup, depth: number): React.ReactNode => {
    const collapsed = collapsedGroups.has(group.key);
    const sessionCount =
      group.sessions.length +
      group.children.reduce(
        (total, child) => total + child.sessions.length,
        0,
      );
    return (
      <div key={group.key} role="group">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => toggleGroup(group.key)}
          className="flex h-8 w-full items-center gap-1.5 pr-3 text-left text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          style={{ paddingLeft: `${12 + depth * 14}px` }}
        >
          <ChevronRight
            className={`h-3 w-3 shrink-0 transition-transform ${
              collapsed ? "" : "rotate-90"
            }`}
          />
          <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--accent-warm)]" />
          <span className="min-w-0 flex-1 truncate">{group.label}</span>
          <span className="shrink-0 text-xs font-normal text-[var(--ink-subtle)]">
            {sessionCount}
          </span>
        </button>
        {!collapsed && (
          <>
            {group.sessions.map((session) => renderSession(session, depth + 1))}
            {group.children.map((child) => renderGroup(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <section className="flex shrink-0 flex-col border-t border-[var(--line-subtle)]">
      <div className="flex h-10 shrink-0 items-center px-3">
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left text-sm text-[var(--ink)]"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform ${
              isExpanded ? "rotate-90" : ""
            }`}
          />
          <History className="h-3.5 w-3.5 shrink-0 text-[var(--accent-warm)]" />
          <span className="truncate font-semibold">
            {t("shell.history.title")}
          </span>
          {sessions && (
            <span className="text-xs font-normal text-[var(--ink-subtle)]">
              {sessions.length}
            </span>
          )}
        </button>
        {isExpanded && (
          <button
            type="button"
            aria-label={t("workspaceFiles.common.refresh")}
            title={t("workspaceFiles.common.refresh")}
            onClick={() => void refresh()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {isExpanded && (
        <div className="max-h-56 min-h-0 overflow-y-auto overscroll-contain pb-1">
          {sessions === null ? (
            <div className="flex h-16 items-center justify-center gap-2 text-xs text-[var(--ink-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("shell.history.loading")}
            </div>
          ) : loadError ? (
            <button
              type="button"
              onClick={() => void refresh()}
              className="flex h-16 w-full items-center justify-center gap-2 text-xs text-[var(--error)] hover:bg-[var(--hover-bg)]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("shell.history.loadFailed")}
            </button>
          ) : sessions.length === 0 ? (
            <div className="flex h-16 items-center justify-center text-xs text-[var(--ink-muted)]">
              {t("shell.history.empty")}
            </div>
          ) : (
            <div role="tree" aria-label={t("shell.history.title")}>
              {tree.groups.map((group) => renderGroup(group, 0))}
              {tree.rootSessions.map((session) => renderSession(session, 0))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
