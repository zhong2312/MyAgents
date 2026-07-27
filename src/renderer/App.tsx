import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  memo,
  lazy,
  Suspense,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import ChatBootOverlay from "@/components/ChatBootOverlay";
import { arrayMove } from "@dnd-kit/sortable";

import {
  initAnalytics,
  track,
  setAnalyticsContext,
  clearAnalyticsContext,
  setPendingSessionBirth,
  clearPendingSessionBirth,
  birthContextForSurface,
  hashAgentName,
  hashAgentNameSync,
} from "@/analytics";
import type {
  AssistantEntry,
  EntryIntent,
  HistoryEntrySource,
  PendingSessionBirthContext,
  Surface,
} from "@/analytics";
import {
  stopTabSidecar,
  startGlobalSidecar,
  initGlobalSidecarReadyPromise,
  markGlobalSidecarReady,
  getGlobalServerUrl,
  getSessionActivation,
  updateSessionTab,
  ensureSessionSidecar,
  releaseTabSession,
  activateSession,
  upgradeSessionId,
  getSessionPort,
  hasSessionSidecar,
  getSessionGeneration,
  stopSseProxy,
  startBackgroundCompletion,
  cancelBackgroundCompletion,
  updateGlobalServerUrl,
  canRestoreSession,
  getUserSchedulerLifecycleSnapshot,
  sessionHasPersistentOwners,
  setAppActiveCorrelation,
  proxyFetch,
} from "@/api/tauriClient";
import ConfirmDialog from "@/components/ConfirmDialog";
import BugReportOverlay from "@/components/BugReportOverlay";
import CustomTitleBar from "@/components/CustomTitleBar";
import LinkContextMenuProvider from "@/components/LinkContextMenuProvider";
import TabBar from "@/components/TabBar";
import TabProvider from "@/context/TabProvider";
import WorkbenchAgentSurfaceHost from "@/workbench-host/WorkbenchAgentSurfaceHost";
import {
  clearWorkbenchAgentConversation,
  loadWorkbenchAgentConversation,
  saveWorkbenchAgentConversation,
} from "@/workbench-host/agentConversationBinding";
import { isEmptyOrBrokenSession } from "@/workbench-host/workbenchAgentSessionPolicy";
import type { AdoptMigratedSessionOptions } from "@/context/TabContext";
import { useToast } from "@/components/Toast";
import { useUpdater } from "@/hooks/useUpdater";
import { useTrayEvents } from "@/hooks/useTrayEvents";
import { useHelperAgentModelDefaults } from "@/hooks/useHelperAgentModelDefaults";
import { useConfig } from "@/hooks/useConfig";
import { useSpaceBuildCapability } from "@/hooks/useSpaceBuildCapability";
import { useTabSwipeGesture } from "@/hooks/useTabSwipeGesture";
import Launcher from "@/pages/Launcher"; // eager: default first view → no cold-start fallback
// Route-split (P1): heavy / non-initial pages load on demand. lazy-Chat moves the
// entire markdown/mermaid/katex/syntax-highlighter chain out of the entry chunk
// (reachable only via Chat). Launcher stays eager (default first view → no
// cold-start fallback).
//
// NOTE: we deliberately do NOT idle-preload these. A blind idle preload made
// WKWebView warn "<chunk> was preloaded but not used within a few seconds" for
// the whole route graph on every startup, AND eagerly pulled Monaco/Markdown
// (several MB) at boot even when the user never opened those pages. In Tauri the
// chunks are LOCAL assets, so first-open is fast and just shows the same paper
// Suspense fallback the deferred-mount placeholder already uses. (If first Chat
// open ever feels slow, add a targeted preload on launch intent — not a blind
// idle preload of every route.)
const Chat = lazy(() => import("@/pages/Chat"));
const Settings = lazy(() => import("@/pages/Settings"));
const TaskCenter = lazy(() => import("@/pages/TaskCenter"));
const Space = lazy(() => import("@/pages/Space"));
const WorkbenchShell = lazy(() => import("@/workbench-sdk/WorkbenchShell"));

/** Layout-compatible Suspense fallback for a lazy page chunk — same paper fill
 *  as the deferred-mount placeholder, so a chunk-load is never a jarring blank. */
const PAGE_FALLBACK = <div className="h-full w-full bg-[var(--paper)]" />;
import {
  isProjectVisibleToUser,
  type Project,
  type Provider,
  type ProviderVerifyStatus,
} from "@/config/types";
import {
  type Tab,
  type InitialMessage,
  type LaunchSessionBirthHint,
  type SidecarConfigDisposition,
  type FilePreviewIntent,
  createNewTab,
  getFolderName,
  buildChatFlipPatch,
  generateTabId,
  isWorkbenchAgentSurfaceTab,
  MAX_TABS,
} from "@/types/tab";
import type {
  OpenWorkbenchRequest,
  WorkbenchAiRunRequest,
  WorkbenchAiRunResult,
  WorkbenchAgentSessionRequest,
  WorkbenchModelSelection,
  WorkbenchSimulationRequest,
} from "../shared/workbench-sdk";
import {
  WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
  WORKBENCH_SIMULATION_MODEL_SCENE_IDS,
} from "../shared/workbench-sdk";
import {
  dispatchWorkbenchHostAction,
  type WorkbenchNavigationGuard,
} from "@/workbench-sdk";
import { createWorkbenchTab, isSameWorkbenchTab } from "@/workbench-sdk/tab";
import { workbenchRegistry } from "@/workbench-registry";
import {
  buildRestoredTabs,
  saveOpenTabs,
  hydratePersistedState,
  pickDurableOverride,
  shouldOfferRestore,
  planRestoreTabs,
} from "@/utils/tabPersistence";
import {
  persistOpenTabsDurable,
  loadAndClearOpenTabsDurable,
  clearOpenTabsDurable,
} from "@/utils/tabPersistenceDurable";
import { consumeCleanExitMarker } from "@/utils/lastExitMarker";
import { tabContentKind, isRestoreAbandoned } from "@/utils/tabContentKind";
import { runAfterNextPaint } from "@/utils/afterPaint";
import { perfMark } from "@/utils/perfMark";
import { RENDERER_PERF_PHASE } from "../shared/perfTrace";
import type { ImageAttachment } from "@/components/SimpleChatInput";
import {
  type CronRecoverySummaryPayload,
  type CronTaskRecoveredPayload,
  CRON_EVENTS,
} from "@/types/cronEvents";
import { isBrowserDevMode, isTauriEnvironment } from "@/utils/browserMock";
import { apiGetJson } from "@/api/apiFetch";
import { createSession, getSessions, updateSession } from "@/api/sessionClient";
import { dismissTopmost } from "@/utils/closeLayer";
import { dispatchAppShortcut } from "@/utils/appShortcuts";
import { handleSelectAllKeydown } from "@/utils/selectAllRouter";
import {
  forceFlushLogs,
  setLogServerUrl,
  clearLogServerUrl,
  setAppActiveTabId,
} from "@/utils/frontendLogger";
import {
  canHotSwapSessionSidecar,
  normalizeRuntime,
  resolveEffectiveRuntime,
  planSessionOpen,
  sessionRuntimeIdentityFromMetadataForOpen,
} from "@/utils/sessionOpenPlan";
import { resolveNotificationClickRoute } from "@/utils/notificationClickRoute";
import {
  acknowledgeNotificationBadgeTarget,
  buildSessionNotificationBadgeCounts,
  countNotificationBadgeItems,
  isNotificationBadgeTargetVisible,
  normalizeNotificationBadgeIncrementPayload,
  upsertNotificationBadgeItem,
  type NotificationBadgeIncrementPayload,
  type NotificationBadgeItem,
  type NotificationBadgeTarget,
} from "@/utils/notificationBadgeRegistry";
import { applyTerminalSessionToTabs } from "@/utils/sessionTermination";
import { getSessionDisplayText } from "@/utils/sessionDisplay";
import { listenWithCleanup } from "@/utils/tauriListen";
import { migrateFloatingBallSessionBinding } from "@/floating-ball/sessionBinding";
import {
  CUSTOM_EVENTS,
  createPendingSessionId,
  isPendingSessionId,
} from "../shared/constants";
import { parseSessionHistoryGroupPath } from "../shared/session-history";
import {
  normalizeOfficialToolIds,
  type OfficialToolId,
} from "../shared/official-tools";
import { workspacePathsEqual } from "../shared/workspacePath";
import type { CapabilityInitialSelect } from "../shared/skillsTypes";
import {
  ensureSelfAwarenessWorkspace,
  resolveBuiltinSelection,
  pairBuiltinSelection,
  isProviderAvailable,
} from "@/config/configService";
import {
  getAgentByWorkspacePath,
  getAgentById,
} from "@/config/services/agentConfigService";
import type { SessionMetadata } from "@/api/sessionClient";
import type { RuntimeSource, RuntimeType } from "../shared/types/runtime";
import {
  isRuntimeBackedProvider,
  toProviderExecutionIntent,
  type RuntimeBackedProviderIdentity,
} from "../shared/providerExecution";
import {
  originAnalyticsFields,
  originFromDesktopSurface,
  originFromSessionMetadataLike,
} from "../shared/session-origin";
import { buildRuntimeBackedInitialSessionBirth } from "@/utils/providerSwitchSessionBirth";

function getChromeTabs(tabs: readonly Tab[]): Tab[] {
  return tabs.filter((tab) => !isWorkbenchAgentSurfaceTab(tab));
}

function getChromeTabCount(tabs: readonly Tab[]): number {
  return getChromeTabs(tabs).length;
}

async function configureWorkbenchAgentToolset(
  sessionId: string,
  toolset: WorkbenchAgentSessionRequest["toolset"],
  isCurrent: () => boolean,
): Promise<void> {
  if (!toolset) return;

  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!isCurrent()) return;
    try {
      const port = await getSessionPort(sessionId);
      if (!isCurrent()) return;
      if (port === null) {
        throw new Error("Agent 会话尚未就绪，无法加载工作台工具");
      }
      const response = await proxyFetch(
        `http://127.0.0.1:${port}/api/workbench-agent/configure`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolset }),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? "工作台工具加载失败");
      }
      return;
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      const transient =
        msg.includes("尚未就绪") ||
        msg.includes("error sending request") ||
        msg.includes("Connection refused") ||
        msg.includes("Connection reset") ||
        msg.includes("ECONNREFUSED");
      if (!transient || attempt === 7) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  if (!isCurrent()) return;
  throw lastError instanceof Error
    ? lastError
    : new Error("工作台工具加载失败");
}

// ============================================================
// User Support Prompt Builder
// ============================================================

function buildSupportPrompt(description: string, appVersion: string): string {
  return [
    `## 用户反馈`,
    ``,
    `**App 版本**: ${appVersion}`,
    ``,
    `> ${description}`,
    ``,
    `请使用 /support skill 帮助用户解决这个问题。`,
  ].join("\n");
}

function normalizeInitialPermissionMode(
  value: unknown,
): InitialMessage["permissionMode"] | undefined {
  return value === "auto" || value === "plan" || value === "fullAgency"
    ? value
    : undefined;
}

function isRendererForegrounded(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

function resolveInitialPermissionMode(args: {
  project: Pick<Project, "permissionMode">;
  agent?: { permissionMode?: unknown };
  defaultPermissionMode?: unknown;
}): InitialMessage["permissionMode"] | undefined {
  return (
    normalizeInitialPermissionMode(args.agent?.permissionMode) ??
    normalizeInitialPermissionMode(args.project.permissionMode) ??
    normalizeInitialPermissionMode(args.defaultPermissionMode)
  );
}

function normalizeStringSetting(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function resolveWorkbenchModelSelection(
  override: WorkbenchModelSelection | undefined,
  providers: readonly Provider[],
  apiKeys: Record<string, string>,
  verifyStatus: Record<string, ProviderVerifyStatus>,
): { provider: Provider; model: string } | undefined {
  if (!override) return undefined;
  const provider = providers.find(
    (candidate) => candidate.id === override.providerId,
  );
  if (!provider || !isProviderAvailable(provider, apiKeys, verifyStatus)) {
    throw new Error(
      "场景绑定的供应商当前不可用，请前往“设置 / 模型场景”重新选择",
    );
  }
  if (
    !provider.models.some((candidate) => candidate.model === override.model)
  ) {
    throw new Error(
      "场景绑定的模型当前不可用，请前往“设置 / 模型场景”重新选择",
    );
  }
  return { provider, model: override.model };
}

function cloneStringArray(value: string[] | undefined): string[] | undefined {
  return value ? [...value] : undefined;
}

interface SessionRuntimeOpenIdentity {
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  runtimeKnown?: boolean;
}

function fallbackRuntimeForOpen(
  fallbackRuntime: RuntimeType,
  multiAgentRuntime: boolean | undefined,
): RuntimeType {
  return multiAgentRuntime ? fallbackRuntime : "builtin";
}

function normalizeRuntimeSourceForOpen(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): RuntimeSource | undefined {
  if (runtime === "builtin") return undefined;
  return runtimeSource ?? "system-cli";
}

function analyticsRuntimeSource(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): RuntimeSource | null {
  if (runtime === "builtin") return null;
  return runtimeSource ?? "system-cli";
}

async function resolveSessionRuntimeIdentityForOpen(
  sessionId: string | null | undefined,
  fallbackRuntime: RuntimeType,
  multiAgentRuntime: boolean | undefined,
): Promise<SessionRuntimeOpenIdentity> {
  const fallback = fallbackRuntimeForOpen(fallbackRuntime, multiAgentRuntime);
  if (!sessionId || isPendingSessionId(sessionId)) {
    return {
      runtime: fallback,
      runtimeSource: normalizeRuntimeSourceForOpen(fallback, undefined),
      runtimeKnown: true,
    };
  }
  try {
    const meta = await apiGetJson<{
      success: boolean;
      session?: SessionMetadata;
    }>(`/sessions/${encodeURIComponent(sessionId)}?limit=1`);
    return sessionRuntimeIdentityFromMetadataForOpen(meta.session, fallback);
  } catch (error) {
    // Non-fatal: sidecar spawn/switch paths remain authoritative. Falling
    // back only affects whether the UI opens a new tab proactively.
    console.warn(
      `[App] Failed to resolve runtime for session ${sessionId}, using fallback ${fallback}:`,
      error,
    );
    return {
      runtime: fallback,
      runtimeSource: normalizeRuntimeSourceForOpen(fallback, undefined),
      runtimeKnown: false,
    };
  }
}

export interface LaunchProjectAnalyticsContext {
  surface?: Surface;
  entryIntent?: EntryIntent;
  assistantEntry?: AssistantEntry;
  historyEntrySource?: HistoryEntrySource;
}

// ============================================================
// MemoizedTabContent — prevents re-rendering tabs whose props haven't changed.
// When switching tabs, only the newly active and previously active tabs re-render.
// ============================================================

interface TabContentProps {
  tab: Tab;
  isActive: boolean;
  isLoading: boolean;
  error: string | null;
  /**
   * When true, render only a cheap placeholder instead of the (heavy) tab
   * content. Set for a freshly created tab so its full subtree (e.g. the
   * Launcher: BrandSection + SimpleChatInput + selectors + LauncherRightRail +
   * WorkspaceCards) does NOT mount inside the synchronous click commit —
   * that mount is what janked the "+" / Cmd+T action. handleNewTab clears
   * the flag right after the placeholder paints (runAfterNextPaint), so React
   * mounts the real content in a prompt normal-priority commit off the click
   * frame. (NOT a low-priority transition — that gets starved by background
   * tabs' SSE/poll updates → 1-2s blank; see openNewTabDeferred.)
   */
  isDeferredMount: boolean;
  settingsInitialSection: string | undefined;
  settingsInitialMcpId: string | undefined;
  settingsInitialOfficialToolId?: OfficialToolId;
  settingsInitialSelect: CapabilityInitialSelect | undefined;
  // Launcher callbacks
  onLaunchProject: (
    project: Project,
    sessionId?: string,
    initialMessage?: InitialMessage,
    analyticsContext?: LaunchProjectAnalyticsContext,
    sessionBirthHint?: LaunchSessionBirthHint,
  ) => void;
  // Chat callbacks
  onBack: (tabId: string) => Promise<void>;
  onSwitchSession: (
    tabId: string,
    sessionId: string,
    historyEntrySource?: HistoryEntrySource,
  ) => Promise<void>;
  onOpenSessionInNewTab: (
    tabId: string,
    sessionId: string,
    title: string,
    historyEntrySource?: HistoryEntrySource,
  ) => Promise<void>;
  onNewSession: (tabId: string) => Promise<boolean>;
  onUpdateGenerating: (tabId: string, isGenerating: boolean) => void;
  onUpdateTitle: (tabId: string, title: string) => void;
  onUpdateUnread: (tabId: string, hasUnread: boolean) => void;
  onRenameSession: (tabId: string, newTitle: string) => void;
  onForkSession: (
    tabId: string,
    newSessionId: string,
    agentDir: string,
    title: string,
    initialMessage?: string,
  ) => Promise<boolean>;
  onUpdateSessionId: (
    tabId: string,
    newSessionId: string,
    options?: AdoptMigratedSessionOptions,
  ) => Promise<boolean>;
  onClearInitialMessage: (tabId: string) => void;
  onSidecarConfigAdopted: (tabId: string) => void;
  onFilePreviewIntentConsumed?: (tabId: string, intentId: string) => void;
  onUpdateWorkbenchRoute: (tabId: string, route: string) => void;
  onRegisterWorkbenchNavigationGuard?: (
    tabId: string,
    guard: WorkbenchNavigationGuard | null,
  ) => void;
  onOpenWorkbenchAgentSession?: (
    workspacePath: string,
    request: WorkbenchAgentSessionRequest,
  ) => Promise<void>;
  onRunWorkbenchAi?: (
    workspacePath: string,
    request: WorkbenchAiRunRequest,
  ) => Promise<WorkbenchAiRunResult>;
  onRequestWorkbenchSimulation?: (
    workspacePath: string,
    request: WorkbenchSimulationRequest,
  ) => Promise<unknown>;
  // Settings callbacks
  onSettingsSectionChange: () => void;
  updateReady: boolean;
  updateVersion: string | null;
  updateChecking: boolean;
  updateDownloading: boolean;
  updateInstalling: boolean;
  /** Silent download is replacing pending bytes — UI button must hide. */
  updatePreparing: boolean;
  onCheckForUpdate: () => Promise<"up-to-date" | "downloading" | "error">;
  onRestartAndUpdate: () => void;
  sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
  // Task Center intent carried by the most recent OPEN_TASK_CENTER event.
  // Only read by the `taskcenter` tab; other tab views ignore it.
  taskCenterPendingIntent: { autofocusSearch?: boolean; nonce: number } | null;
}

// Exported for the cold-restore behavior test (Issue #232) — asserts a cold
// tab renders a placeholder and never mounts TabProvider.
export const MemoizedTabContent = memo(
  function TabContent({
    tab,
    isActive,
    isLoading,
    error,
    isDeferredMount,
    onLaunchProject,
    onBack,
    onSwitchSession,
    onOpenSessionInNewTab,
    onNewSession,
    onUpdateGenerating,
    onUpdateTitle,
    onUpdateUnread,
    onRenameSession,
    onForkSession,
    onUpdateSessionId,
    onClearInitialMessage,
    onSidecarConfigAdopted,
    onFilePreviewIntentConsumed,
    onUpdateWorkbenchRoute,
    onRegisterWorkbenchNavigationGuard,
    onOpenWorkbenchAgentSession,
    onRunWorkbenchAi,
    onRequestWorkbenchSimulation,
    settingsInitialSection,
    settingsInitialMcpId,
    settingsInitialOfficialToolId,
    settingsInitialSelect,
    onSettingsSectionChange,
    updateReady,
    updateVersion,
    updateChecking,
    updateDownloading,
    updateInstalling,
    updatePreparing,
    onCheckForUpdate,
    onRestartAndUpdate,
    sessionNotificationBadgeCounts,
    taskCenterPendingIntent,
  }: TabContentProps) {
    const kind = tabContentKind(tab, isDeferredMount);
    return (
      <div
        className={`absolute inset-0 ${isActive ? "" : "pointer-events-none invisible"}`}
        style={isActive ? undefined : { contentVisibility: "hidden" }}
      >
        {kind === "deferred" ? (
          // One-frame placeholder: paper-colored fill so the just-activated
          // tab paints instantly with no flash, while the real subtree mounts
          // on the next normal-priority commit (runAfterNextPaint; see
          // openNewTabDeferred).
          <div className="h-full w-full bg-[var(--paper)]" />
        ) : kind === "launcher" ? (
          <Launcher
            onLaunchProject={onLaunchProject}
            isStarting={isLoading}
            startError={error}
            isActive={isActive}
            attachmentSessionId={createPendingSessionId(tab.id)}
            sessionNotificationBadgeCounts={sessionNotificationBadgeCounts}
          />
        ) : kind === "settings" ? (
          <Suspense fallback={PAGE_FALLBACK}>
            <Settings
              initialSection={settingsInitialSection}
              initialMcpId={settingsInitialMcpId}
              initialOfficialToolId={settingsInitialOfficialToolId}
              initialSelect={settingsInitialSelect}
              onSectionChange={onSettingsSectionChange}
              isActive={isActive}
              updateReady={updateReady}
              updateVersion={updateVersion}
              updateChecking={updateChecking}
              updateDownloading={updateDownloading}
              updateInstalling={updateInstalling}
              updatePreparing={updatePreparing}
              onCheckForUpdate={onCheckForUpdate}
              onRestartAndUpdate={onRestartAndUpdate}
            />
          </Suspense>
        ) : kind === "taskcenter" ? (
          <Suspense fallback={PAGE_FALLBACK}>
            <TaskCenter
              isActive={isActive}
              pendingIntent={taskCenterPendingIntent}
            />
          </Suspense>
        ) : kind === "space" ? (
          <Suspense fallback={PAGE_FALLBACK}>
            <Space isActive={isActive} />
          </Suspense>
        ) : kind === "workbench" ? (
          <Suspense fallback={PAGE_FALLBACK}>
            <WorkbenchShell
              target={tab.workbench}
              workspacePath={tab.agentDir ?? ""}
              isActive={isActive}
              onNavigate={(route) => onUpdateWorkbenchRoute(tab.id, route)}
              onNavigationGuardChange={(guard) =>
                onRegisterWorkbenchNavigationGuard?.(tab.id, guard)
              }
              onOpenAgentSession={onOpenWorkbenchAgentSession}
              onRunAi={onRunWorkbenchAi}
              onRequestSimulation={onRequestWorkbenchSimulation}
            />
          </Suspense>
        ) : kind === "cold" ? (
          // Restored-but-not-yet-activated chat tab (Issue #232). Render only a
          // cheap placeholder — crucially NO TabProvider, so no SSE connect, no
          // ensureSessionSidecar, no recovery timers fire for tabs the user hasn't
          // opened yet. App.activateRestoredTab clears `restoreState` on first
          // activation, after which the real TabProvider branch below mounts.
          <div className="h-full w-full bg-[var(--paper)]" />
        ) : (
          <TabProvider
            tabId={tab.id}
            agentDir={tab.agentDir ?? ""}
            sessionId={tab.sessionId}
            isActive={isActive}
            onGeneratingChange={(isGenerating) =>
              onUpdateGenerating(tab.id, isGenerating)
            }
            onTitleChange={(title) => onUpdateTitle(tab.id, title)}
            onUnreadChange={(hasUnread) => onUpdateUnread(tab.id, hasUnread)}
            onSessionIdChange={(newSessionId, options) =>
              onUpdateSessionId(tab.id, newSessionId, options)
            }
          >
            <Suspense fallback={<ChatBootOverlay />}>
              <Chat
                onBack={() => onBack(tab.id)}
                onSwitchSession={(sessionId, historyEntrySource) =>
                  onSwitchSession(tab.id, sessionId, historyEntrySource)
                }
                onOpenSessionInNewTab={(sessionId, title) =>
                  onOpenSessionInNewTab(
                    tab.id,
                    sessionId,
                    title,
                    "chat_dropdown_new_tab",
                  )
                }
                onNewSession={() => onNewSession(tab.id)}
                initialMessage={tab.initialMessage}
                onInitialMessageConsumed={() => onClearInitialMessage(tab.id)}
                sidecarConfigDisposition={tab.sidecarConfigDisposition}
                onSidecarConfigAdopted={() => onSidecarConfigAdopted(tab.id)}
                pendingFilePreview={tab.pendingFilePreview}
                onFilePreviewIntentConsumed={(intentId) =>
                  onFilePreviewIntentConsumed?.(tab.id, intentId)
                }
                sessionTitle={tab.title}
                onRenameSession={(newTitle: string) =>
                  onRenameSession(tab.id, newTitle)
                }
                onForkSession={(
                  newSessionId: string,
                  agentDir: string,
                  title: string,
                  initialMessage?: string,
                ) =>
                  onForkSession(
                    tab.id,
                    newSessionId,
                    agentDir,
                    title,
                    initialMessage,
                  )
                }
                sessionNotificationBadgeCounts={sessionNotificationBadgeCounts}
              />
            </Suspense>
          </TabProvider>
        )}
      </div>
    );
  },
  (prev, next) => {
    // Return true = skip re-render
    // All callbacks are stable (via tabsRef/activeTabIdRef), so we only compare data props
    return (
      prev.tab === next.tab &&
      prev.isActive === next.isActive &&
      prev.isLoading === next.isLoading &&
      prev.error === next.error &&
      // Drives the deferred-mount → real-content transition for new tabs.
      prev.isDeferredMount === next.isDeferredMount &&
      prev.settingsInitialSection === next.settingsInitialSection &&
      prev.settingsInitialMcpId === next.settingsInitialMcpId &&
      prev.settingsInitialOfficialToolId ===
        next.settingsInitialOfficialToolId &&
      prev.settingsInitialSelect === next.settingsInitialSelect &&
      prev.updateReady === next.updateReady &&
      prev.updateVersion === next.updateVersion &&
      prev.updateChecking === next.updateChecking &&
      prev.updateDownloading === next.updateDownloading &&
      prev.updateInstalling === next.updateInstalling &&
      prev.updatePreparing === next.updatePreparing &&
      prev.sessionNotificationBadgeCounts ===
        next.sessionNotificationBadgeCounts &&
      // Reference equality — each OPEN_TASK_CENTER dispatch allocates a
      // fresh intent object (or `null`), so identity comparison is enough.
      // Without this line, a user re-clicking the Launcher's search icon
      // while Task Center is already active would see their new intent
      // dropped: isActive stays true, tab ref stays the same, so memo
      // returns true and the new `pendingIntent` prop never reaches the
      // TaskCenter tab. (v0.1.69 cross-review C1)
      prev.taskCenterPendingIntent === next.taskCenterPendingIntent
    );
  },
);

export default function App() {
  const { t } = useTranslation("app");
  // Auto-update state (silent background updates)
  const {
    updateReady,
    updateVersion,
    restartAndUpdate,
    checking: updateChecking,
    downloading: updateDownloading,
    installing: updateInstalling,
    preparing: updatePreparing,
    checkForUpdate,
    pendingUpdateOnStartup,
    dismissPendingUpdate,
  } = useUpdater();

  // Stable callback for Settings prop — ref pattern ensures memo comparator correctness
  const restartAndUpdateRef = useRef(restartAndUpdate);
  restartAndUpdateRef.current = restartAndUpdate;

  // handleRestartAndUpdate is defined further down (after toastRef is declared)
  // — see the `// Update install handler` block.

  // App config for tray behavior (shared via ConfigProvider — no CONFIG_CHANGED event needed)
  // Also get projects + CRUD actions for bug report (ensureSelfAwarenessWorkspace needs them)
  const {
    config,
    isLoading: configLoading,
    providers: appProviders,
    apiKeys: appApiKeys,
    providerVerifyStatus: appProviderVerifyStatus,
    projects: configProjects,
    addProject: configAddProject,
    patchProject: configPatchProject,
  } = useConfig();
  const spaceBuildCapability = useSpaceBuildCapability(config.spaceEnvironment);
  const teamSpaceAvailable =
    spaceBuildCapability.available && config.teamSpaceEnabled === true;

  // Helper Agent's persisted model defaults — used by BugReportOverlay for
  // initial picker selection + persist on pick. The LAUNCH_BUG_REPORT handler
  // intentionally does NOT read this: when no explicit hint is supplied, the
  // helper Tab autoSend resolves provider/model via currentAgent (= helper
  // Agent) — same path as opening ~/.myagents from the Launcher.
  const helperAgentDefaults = useHelperAgentModelDefaults();

  // Settings initial section state (for deep linking to specific section)
  const [settingsInitialSection, setSettingsInitialSection] = useState<
    string | undefined
  >(undefined);
  const [settingsInitialMcpId, setSettingsInitialMcpId] = useState<
    string | undefined
  >(undefined);
  const [settingsInitialOfficialToolId, setSettingsInitialOfficialToolId] =
    useState<OfficialToolId | undefined>(undefined);
  const [settingsInitialSelect, setSettingsInitialSelect] = useState<
    CapabilityInitialSelect | undefined
  >(undefined);

  // Bug report overlay state (triggered from titlebar feedback button)
  const [showBugReport, setShowBugReport] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    if (isTauriEnvironment()) {
      import("@tauri-apps/api/app")
        .then((m) => m.getVersion())
        .then(setAppVersion)
        .catch(() => setAppVersion("unknown"));
    } else {
      setAppVersion("dev");
    }
  }, []);

  // Multi-tab state.
  //
  // Startup behaviour (Issue #309): boot is ALWAYS a clean new launcher — we no
  // longer auto-restore the previous session. Restoring is opt-in via the
  // title-bar "恢复对话" pill, surfaced only when the last exit was NOT a
  // deliberate quit (i.e. a crash or an update-restart — see the boot-decision
  // effect below). `buildRestoredTabs()` still runs synchronously here to
  // CAPTURE the prior session's restorable tabs BEFORE the post-commit persist
  // effect overwrites localStorage with this fresh launcher; the captured set
  // becomes the pill's restore candidate, hydrated `restoreState:'cold'` (no
  // TabProvider / sidecar until first activation — see MemoizedTabContent).
  const [restoreCandidate] = useState(() => buildRestoredTabs());
  const [tabs, setTabs] = useState<Tab[]>(() => [createNewTab()]);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(
    () => tabs[0]?.id ?? null,
  );
  const [externalNotificationBadges, setExternalNotificationBadges] = useState<
    NotificationBadgeItem[]
  >([]);

  // "恢复对话" pill (Issue #309). `restorePillCount > 0` shows it; the resolved
  // candidate is held in a ref (NOT localStorage — the persist effect clears
  // that on the fresh boot) so the user can still restore after starting work.
  const restoreCandidateRef = useRef<{
    tabs: Tab[];
    activeTabId: string | null;
  } | null>(null);
  const [restorePillCount, setRestorePillCount] = useState(0);

  // Refs for stable callback access (avoids re-creating callbacks when tabs/activeTabId change)
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const chromeTabsRef = useRef<Tab[]>(getChromeTabs(tabs));
  chromeTabsRef.current = getChromeTabs(tabs);

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const configuredWorkbenchToolsetsRef = useRef(new Map<string, string>());
  const persistedWorkbenchHistoryGroupsRef = useRef(new Map<string, string>());
  const workbenchNavigationGuardsRef = useRef(
    new Map<string, WorkbenchNavigationGuard>(),
  );
  const closingWorkbenchTabsRef = useRef(new Set<string>());
  const registerWorkbenchNavigationGuard = useCallback(
    (tabId: string, guard: WorkbenchNavigationGuard | null) => {
      if (guard) workbenchNavigationGuardsRef.current.set(tabId, guard);
      else workbenchNavigationGuardsRef.current.delete(tabId);
    },
    [],
  );
  useEffect(() => {
    const liveSurfaceIds = new Set<string>();
    const liveHistoryGroupTabIds = new Set<string>();
    for (const tab of tabs) {
      const surface = tab.workbenchAgentSurface;
      const historyGroupPath =
        tab.sessionHistoryGroupPath ?? surface?.historyGroupPath;
      if (
        historyGroupPath &&
        tab.sessionId &&
        !isPendingSessionId(tab.sessionId)
      ) {
        const sessionId = tab.sessionId;
        const groupKey = `${sessionId}:${JSON.stringify(historyGroupPath)}`;
        liveHistoryGroupTabIds.add(tab.id);
        if (
          persistedWorkbenchHistoryGroupsRef.current.get(tab.id) !== groupKey
        ) {
          persistedWorkbenchHistoryGroupsRef.current.set(tab.id, groupKey);
          const isCurrent = () =>
            persistedWorkbenchHistoryGroupsRef.current.get(tab.id) === groupKey;
          void (async () => {
            let lastError: unknown;
            for (let attempt = 0; attempt < 8; attempt += 1) {
              if (!isCurrent()) return null;
              try {
                const updated = await updateSession(sessionId, {
                  historyGroupPath: [...historyGroupPath],
                });
                if (updated) return updated;
                lastError = new Error("Session metadata is not ready");
              } catch (error) {
                lastError = error;
              }
              await new Promise((resolve) =>
                window.setTimeout(resolve, 200 * (attempt + 1)),
              );
            }
            throw lastError instanceof Error
              ? lastError
              : new Error("Failed to persist Session history group");
          })()
            .then((updated) => {
              if (!updated || !isCurrent()) return;
              setTabs((current) =>
                current.map((item) =>
                  item.id === tab.id &&
                  item.sessionId === sessionId &&
                  item.sessionHistoryGroupPath
                    ? { ...item, sessionHistoryGroupPath: undefined }
                    : item,
                ),
              );
              window.dispatchEvent(
                new CustomEvent(CUSTOM_EVENTS.SESSION_HISTORY_CHANGED),
              );
            })
            .catch((error) => {
              if (!isCurrent()) return;
              persistedWorkbenchHistoryGroupsRef.current.delete(tab.id);
              console.error(
                `[App] Failed to persist history group for session ${sessionId}:`,
                error,
              );
            });
        }
      }
      if (!surface || !tab.sessionId) continue;
      liveSurfaceIds.add(tab.id);
      if (!isPendingSessionId(tab.sessionId)) {
        saveWorkbenchAgentConversation(
          surface.workbenchId,
          surface.workspacePath,
          surface.conversationKey,
          tab.sessionId,
        );
      }

      if (!surface.toolset) continue;
      const configurationKey = `${tab.sessionId}:${JSON.stringify(surface.toolset)}`;
      if (
        configuredWorkbenchToolsetsRef.current.get(tab.id) === configurationKey
      ) {
        continue;
      }
      configuredWorkbenchToolsetsRef.current.set(tab.id, configurationKey);
      const isCurrent = () =>
        configuredWorkbenchToolsetsRef.current.get(tab.id) === configurationKey;
      void configureWorkbenchAgentToolset(
        tab.sessionId,
        surface.toolset,
        isCurrent,
      ).catch((error) => {
        if (!isCurrent()) return;
        configuredWorkbenchToolsetsRef.current.delete(tab.id);
        console.error(
          `[App] Failed to configure workbench tools for session ${tab.sessionId}:`,
          error,
        );
      });
    }
    for (const tabId of configuredWorkbenchToolsetsRef.current.keys()) {
      if (!liveSurfaceIds.has(tabId)) {
        configuredWorkbenchToolsetsRef.current.delete(tabId);
      }
    }
    for (const tabId of persistedWorkbenchHistoryGroupsRef.current.keys()) {
      if (!liveHistoryGroupTabIds.has(tabId)) {
        persistedWorkbenchHistoryGroupsRef.current.delete(tabId);
      }
    }
  }, [tabs]);

  const syncRendererCorrelationForTab = useCallback(
    (
      tabId: string | null | undefined,
      nextTabs: readonly Tab[] = tabsRef.current,
    ) => {
      const activeTab = tabId
        ? nextTabs.find((t) => t.id === tabId)
        : undefined;
      setAppActiveTabId(
        tabId,
        nextTabs.map((t) => t.id),
      );
      setAppActiveCorrelation({
        tabId,
        sessionId: activeTab?.sessionId ?? undefined,
        tabs: nextTabs.map((t) => ({ id: t.id, sessionId: t.sessionId })),
      });
    },
    [],
  );

  const setActiveTabId = useCallback(
    (
      next: string | null | ((current: string | null) => string | null),
      nextTabs: readonly Tab[] = tabsRef.current,
    ) => {
      if (typeof next === "function") {
        setActiveTabIdState((current) => {
          const resolved = next(current);
          activeTabIdRef.current = resolved;
          syncRendererCorrelationForTab(resolved, nextTabs);
          return resolved;
        });
        return;
      }
      activeTabIdRef.current = next;
      syncRendererCorrelationForTab(next, nextTabs);
      setActiveTabIdState(next);
    },
    [syncRendererCorrelationForTab],
  );

  useEffect(() => {
    if (configLoading || spaceBuildCapability.isLoading || teamSpaceAvailable)
      return;

    const currentTabs = tabsRef.current;
    if (!currentTabs.some((tab) => tab.view === "space")) return;

    const remainingTabs = currentTabs.filter((tab) => tab.view !== "space");
    const nextTabs =
      remainingTabs.length > 0 ? remainingTabs : [createNewTab()];
    const currentActiveId = activeTabIdRef.current;
    const nextActiveId = nextTabs.some((tab) => tab.id === currentActiveId)
      ? currentActiveId
      : (nextTabs[nextTabs.length - 1]?.id ?? null);

    setTabs(nextTabs);
    setActiveTabId(nextActiveId, nextTabs);
  }, [
    configLoading,
    spaceBuildCapability.isLoading,
    teamSpaceAvailable,
    setActiveTabId,
  ]);

  // Persist open chat tabs after every structural change (Issue #232). This is
  // a POST-COMMIT effect — it flushes shortly after each tabs/activeTabId change
  // (not synchronously inside the mutation). The payload is tiny (≤MAX_TABS × 4
  // fields), and we deliberately avoid `beforeunload` (unreliable in Tauri
  // WKWebView; update install + app quit both exit from the Rust side, not a
  // renderer unload handshake — see the hide/quit flush below and
  // handleRestartAndUpdate). Restored "cold" tabs are persisted too (they carry
  // a real sessionId) — serializeTabs strips the runtime-only restoreState flag.
  useEffect(() => {
    saveOpenTabs(tabs, activeTabId);
  }, [tabs, activeTabId]);

  // Synchronous flush of the latest tab state. Used to close the narrow window
  // where the process exits (update relaunch, Cmd+Q / Dock quit) in the same
  // frame as a structural change, before the post-commit effect above runs.
  const flushOpenTabsNow = useCallback(() => {
    saveOpenTabs(tabsRef.current, activeTabIdRef.current);
  }, []);

  // Flush on window hide / pagehide — the Tauri-appropriate quit signal (the
  // analytics tracker uses the same visibilitychange→hidden hook; beforeunload
  // is unreliable here). Covers Cmd+Q / Dock-quit so a tab closed immediately
  // before quitting doesn't resurrect on next launch.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushOpenTabsNow();
    };
    const onPageHide = () => flushOpenTabsNow();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [flushOpenTabsNow]);

  // Boot startup-behaviour decision (Issue #309). Boot already rendered a fresh
  // launcher (no auto-restore); here we decide whether to OFFER restoring the
  // previous session via the title-bar pill, by the EXIT REASON:
  //   - Resolve the snapshot: the synchronous localStorage capture
  //     (restoreCandidate) wins; the fsync durable backstop — written by
  //     handleRestartAndUpdate right before the abrupt update-restart, where the
  //     async WebView localStorage flush can be lost — fills in when the local
  //     read came up EMPTY (pickDurableOverride).
  //   - Read the Rust clean-exit marker: PRESENT means the user deliberately
  //     quit (Cmd+Q / Dock / tray) → boot fresh, no pill. ABSENT means a crash
  //     or an update-restart → offer to restore (preserves the #232 intent as an
  //     opt-in, kills the #309 "stop force-restoring my session" complaint).
  // Single-shot under StrictMode via the ref; loadAndClearOpenTabsDurable +
  // consumeCleanExitMarker both delete on read, so a second pass is a no-op.
  const bootDecisionRef = useRef(false);
  useEffect(() => {
    if (bootDecisionRef.current) return;
    bootDecisionRef.current = true;
    void (async () => {
      const durable = await loadAndClearOpenTabsDurable();
      const override = pickDurableOverride(restoreCandidate != null, durable);
      const candidate = override
        ? hydratePersistedState(override)
        : restoreCandidate;
      const lastExitWasClean = await consumeCleanExitMarker();
      if (
        candidate &&
        shouldOfferRestore(lastExitWasClean, candidate.tabs.length)
      ) {
        restoreCandidateRef.current = candidate;
        setRestorePillCount(candidate.tabs.length);
      }
    })();
  }, [restoreCandidate]);

  // "恢复对话" pill — restore the previous session on click. Replaces a still-
  // pristine lone launcher; otherwise APPENDS (deduped by sessionId, capped at
  // MAX_TABS) so it never disturbs work the user already started this session.
  // Restored tabs are "cold" (hydratePersistedState) — no sidecar until the user
  // actually activates one.
  const handleRestoreLastSession = useCallback(() => {
    const candidate = restoreCandidateRef.current;
    setRestorePillCount(0);
    restoreCandidateRef.current = null;
    if (!candidate || candidate.tabs.length === 0) return;
    // planRestoreTabs computes the merged list AND the surviving active id from
    // the same merge, so the active tab is always present in the list (no
    // divergent-base setState — see the helper's doc). Plan against the live
    // tabs via the ref to avoid a stale closure.
    const plan = planRestoreTabs(tabsRef.current, candidate);
    if (!plan) return;
    track("restore_last_session", { count: candidate.tabs.length });
    setTabs(plan.tabs);
    setActiveTabId(plan.activeTabId);
  }, [setActiveTabId]);

  // ✕ on the pill — dismiss without restoring (don't nag again this session).
  const handleDismissRestore = useCallback(() => {
    setRestorePillCount(0);
    restoreCandidateRef.current = null;
  }, []);

  // Deferred-mount set for freshly created tabs. A tab whose id is in here
  // renders only a placeholder (see MemoizedTabContent), so clicking "+" /
  // Cmd+T does not synchronously mount the heavy Launcher subtree in the
  // click commit. handleNewTab adds the id urgently (instant chip + active
  // highlight) then clears it AFTER the placeholder paints (runAfterNextPaint),
  // so React mounts the real content in a prompt normal-priority commit.
  const [deferredMountTabIds, setDeferredMountTabIds] = useState<Set<string>>(
    () => new Set(),
  );

  // Single source of truth for opening a NEW tab whose view mounts a large
  // renderer-only subtree (Launcher / Settings / TaskCenter). It appends and
  // activates the tab in the urgent commit — so the chip + active highlight
  // paint instantly with only a cheap placeholder as content — then clears the
  // deferral once the placeholder has painted, letting React mount the heavy
  // subtree. This keeps the open action from janking the click frame regardless
  // of how heavy the view is (e.g. the 5.8k-line Settings tree).
  //
  // WHY runAfterNextPaint and NOT startTransition (the "新建 tab 黄屏" fix):
  // the reveal used to live inside a useTransition, i.e. at LOW priority. Every
  // still-mounted background Tab keeps firing NORMAL-priority state updates
  // (SSE token deltas, session-state polling, task notifications); a
  // low-priority transition gets repeatedly interrupted/restarted by that churn
  // and could stay pending for 1-2s, leaving the full-screen paper placeholder
  // on screen the whole time. A normal-priority commit scheduled right after
  // the placeholder paints is not starvable and reveals the content promptly —
  // the click already got its feedback from the placeholder, so the one-shot
  // mount runs off the click frame. See utils/afterPaint.ts for the double-rAF
  // rationale.
  //
  // NOT for Chat / session opens (handleLaunchProject / fork / switch): those
  // await a Sidecar and wire up SSE before the Chat is usable, so their mount
  // cannot be hidden behind a placeholder — they intentionally do not use this.
  const openNewTabDeferred = useCallback(
    (newTab: Tab) => {
      perfMark(RENDERER_PERF_PHASE.newTabReveal, { tabId: newTab.id }); // P0: new-tab timeline anchor
      const nextTabs = [...tabsRef.current, newTab];
      setDeferredMountTabIds((prev) => {
        if (prev.has(newTab.id)) return prev;
        const next = new Set(prev);
        next.add(newTab.id);
        return next;
      });
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id, nextTabs);
      runAfterNextPaint(() => {
        setDeferredMountTabIds((prev) => {
          if (!prev.has(newTab.id)) return prev;
          const next = new Set(prev);
          next.delete(newTab.id);
          return next;
        });
      });
    },
    [setActiveTabId],
  );

  // Helper-overlay launches must hand `handleLaunchProject` a real, committed
  // active launcher tab. Mutating activeTabIdRef before React has committed the
  // tab produces `view=undefined` and can let the new Chat auto-send while hidden.
  const openLaunchTabNow = useCallback(
    (newTab: Tab) => {
      const nextTabs = [...tabsRef.current, newTab];
      flushSync(() => {
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id, nextTabs);
      });
    },
    [setActiveTabId],
  );

  const removeUnusedPrecreatedLaunchTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const created = prev.find((t) => t.id === tabId);
      if (created && !created.sessionId && !created.agentDir) {
        return prev.filter((t) => t.id !== tabId);
      }
      return prev;
    });
  }, []);

  // Analytics Active Context — propagate active tab's sessionId/tabId so that
  // downstream track() calls auto-inject these into params (see analytics/tracker.ts).
  // Pending session ids (createPendingSessionId placeholders) are filtered out:
  // they're per-tab UI scaffolding, not the real SDK session id, and would not
  // join with session_new in the analytics pipeline.
  useEffect(() => {
    if (!activeTabId) {
      clearAnalyticsContext();
      return;
    }
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const sid = activeTab?.sessionId ?? null;
    setAnalyticsContext({
      tabId: activeTabId,
      sessionId: sid && !isPendingSessionId(sid) ? sid : null,
    });
  }, [activeTabId, tabs]);

  // Renderer correlation must follow the App-level active tab, not only mounted
  // Chat TabProviders. Launcher / Settings / TaskCenter do not mount a
  // TabProvider, but logs and proxy headers still need their tab id instead of
  // inheriting the previously-focused chat tab.
  useEffect(() => {
    syncRendererCorrelationForTab(activeTabId, tabs);
  }, [activeTabId, tabs, syncRendererCorrelationForTab]);

  // PRD 0.2.19 cross-review fix: prewarm agent_hash cache when config.agents
  // loads/changes, so the first `workspace_open` / `session_new` for each agent
  // already has agent_hash populated. Without this, `hashAgentNameSync` returns
  // null on first call (computes async + caches), creating a small tail of
  // null-hash events. Prewarm reduces the tail to near zero.
  useEffect(() => {
    const agents = config?.agents ?? [];
    for (const a of agents) {
      if (a.name) void hashAgentName(a.name);
    }
  }, [config]);

  const appProvidersRef = useRef(appProviders);
  appProvidersRef.current = appProviders;

  const appApiKeysRef = useRef(appApiKeys);
  appApiKeysRef.current = appApiKeys;

  const appProviderVerifyStatusRef = useRef(appProviderVerifyStatus);
  appProviderVerifyStatusRef.current = appProviderVerifyStatus;

  const configProjectsRef = useRef(configProjects);
  configProjectsRef.current = configProjects;

  // Ref for full AppConfig — needed by session-switch flow (T12) to resolve per-workspace
  // agent.runtime for cross-runtime detection without putting `config` into the
  // handleSwitchSession useCallback deps (it's intentionally a stable empty-deps callback).
  const configRef = useRef(config);
  configRef.current = config;

  const unreadTabCount = tabs.reduce(
    (count, tab) => count + (tab.hasUnread ? 1 : 0),
    0,
  );
  const externalNotificationBadgeCount = countNotificationBadgeItems(
    externalNotificationBadges,
  );
  const sessionNotificationBadgeCounts = useMemo(
    () => buildSessionNotificationBadgeCounts(externalNotificationBadges),
    [externalNotificationBadges],
  );
  const notificationBadgeEnabled =
    config.osNotifications && (config.notificationBadge ?? false);
  const notificationBadgeCount = notificationBadgeEnabled
    ? Math.min(unreadTabCount + externalNotificationBadgeCount, 999)
    : 0;

  useEffect(() => {
    if (!notificationBadgeEnabled && externalNotificationBadges.length !== 0) {
      setExternalNotificationBadges([]);
    }
  }, [externalNotificationBadges.length, notificationBadgeEnabled]);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("cmd_set_notification_badge", {
          count: notificationBadgeCount,
          enabled: notificationBadgeEnabled,
        }),
      )
      .catch((error) => {
        console.warn("[App] Failed to sync notification badge:", error);
      });
  }, [notificationBadgeCount, notificationBadgeEnabled]);

  const resolveSessionOriginFieldsForAnalytics = useCallback(
    async (sessionId: string, agentDir: string) => {
      try {
        const sessions = await getSessions(agentDir);
        const target = sessions.find((session) => session.id === sessionId);
        return originAnalyticsFields(originFromSessionMetadataLike(target));
      } catch (error) {
        console.warn(
          `[App] Failed to resolve session origin for ${sessionId}:`,
          error,
        );
        return originAnalyticsFields(null);
      }
    },
    [],
  );

  const trackHistorySessionOpen = useCallback(
    (
      sessionId: string,
      agentDir: string,
      runtimeIdentity: Pick<
        SessionRuntimeOpenIdentity,
        "runtime" | "runtimeSource"
      >,
      entrySource: HistoryEntrySource,
    ) => {
      void (async () => {
        const cfg = configRef.current;
        const agent = getAgentByWorkspacePath(cfg, agentDir);
        const originFields = await resolveSessionOriginFieldsForAnalytics(
          sessionId,
          agentDir,
        );
        track("history_open", {
          agent_hash: hashAgentNameSync(agent?.name ?? null),
          runtime: runtimeIdentity.runtime,
          runtime_source: analyticsRuntimeSource(
            runtimeIdentity.runtime,
            runtimeIdentity.runtimeSource,
          ),
          session_id: sessionId,
          entry_source: entrySource,
          ...originFields,
        });
      })().catch((error) => {
        console.warn(
          `[App] Failed to track history_open for session ${sessionId}:`,
          error,
        );
      });
    },
    [resolveSessionOriginFieldsForAnalytics],
  );

  const trackHistorySessionOpenAsync = useCallback(
    (sessionId: string, agentDir: string, entrySource: HistoryEntrySource) => {
      void (async () => {
        const cfg = configRef.current;
        const agent = getAgentByWorkspacePath(cfg, agentDir);
        const runtimeIdentity = await resolveSessionRuntimeIdentityForOpen(
          sessionId,
          normalizeRuntime(agent?.runtime),
          cfg?.multiAgentRuntime,
        );
        const originFields = await resolveSessionOriginFieldsForAnalytics(
          sessionId,
          agentDir,
        );
        track("history_open", {
          agent_hash: hashAgentNameSync(agent?.name ?? null),
          runtime: runtimeIdentity.runtime,
          runtime_source: analyticsRuntimeSource(
            runtimeIdentity.runtime,
            runtimeIdentity.runtimeSource,
          ),
          session_id: sessionId,
          entry_source: entrySource,
          ...originFields,
        });
      })().catch((error) => {
        console.warn(
          `[App] Failed to track history_open for session ${sessionId}:`,
          error,
        );
      });
    },
    [resolveSessionOriginFieldsForAnalytics],
  );

  // Toast (ref-stabilized per CLAUDE.md rules)
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Update install handler — toasts on failure so the user sees their click
  // had an effect. Silent failure here was the root cause of "重启更新 button
  // does nothing" reports on Windows: a flaky network would kill the install
  // verification round-trip, the JS only console.warn-ed, and the user
  // assumed the button was broken.
  const handleRestartAndUpdate = useCallback(async () => {
    // Persist open-tab state before the install/relaunch exits the process from
    // Rust (Issue #232). flushOpenTabsNow() writes localStorage (the fast path),
    // but WebKit/WebView2 persist localStorage to disk ASYNCHRONOUSLY, so the
    // abrupt NSIS exit(0) (Windows) / relaunch() (macOS) can drop that last
    // write. persistOpenTabsDurable() additionally fsyncs a ~/.myagents/
    // open-tabs.json backstop and is AWAITED here, so the tabs the user had
    // open at the click are committed to disk before the process dies; boot
    // consumes the backstop and adopts it only if localStorage came up empty.
    flushOpenTabsNow();
    await persistOpenTabsDurable(tabsRef.current, activeTabIdRef.current);
    let outcome:
      | Awaited<ReturnType<typeof restartAndUpdateRef.current>>
      | undefined;
    try {
      outcome = await restartAndUpdateRef.current();
    } finally {
      // Drop the durable handoff UNLESS the restart is actually proceeding
      // (outcome 'ok' → the process is exiting and boot will consume it). Any
      // non-'ok' outcome OR a thrown error means the process stays alive, so the
      // backstop we wrote just before must not resurrect this now-frozen snapshot
      // on a later boot. Awaited (not fire-and-forget) so it can't race a retry's
      // fresh persist, and placed in `finally` so an uncaught throw still clears.
      if (outcome !== "ok") {
        await clearOpenTabsDurable();
      }
    }
    if (outcome === "network-error") {
      toastRef.current?.error(t("appChrome.updateVerifyFailed"));
    } else if (outcome === "version-mismatch") {
      toastRef.current?.info(t("appChrome.updateExpiredRedownloading"));
    } else if (outcome === "blocked") {
      toastRef.current?.info(t("appChrome.updateInstallBlocked"));
    } else if (outcome === "error") {
      toastRef.current?.error(t("appChrome.updateInstallFailed"));
    }
    // 'ok' → process is exiting via NSIS/relaunch, no toast needed
  }, [flushOpenTabsNow, t]);

  // Per-tab loading state (keyed by tabId)
  const [loadingTabs, setLoadingTabs] = useState<Record<string, boolean>>({});
  const [tabErrors, setTabErrors] = useState<Record<string, string | null>>({});

  // Exit confirmation state (for cron tasks)
  const [exitConfirmState, setExitConfirmState] = useState<{
    runningTaskCount: number;
    resolve: (value: boolean) => void;
  } | null>(null);

  // Content container ref for tab swipe gesture
  const contentRef = useRef<HTMLDivElement>(null);

  // Per-tab launch guard — prevents concurrent launches overwriting each other's state
  const launchingTabRef = useRef<string | null>(null);

  // Global Sidecar silent retry mechanism
  const mountedRef = useRef(true);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  // Silent background retry with exponential backoff
  const startGlobalSidecarSilent = useCallback(async () => {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 2000; // 2 seconds

    try {
      // NOTE: Do NOT reset the ready promise on retry.
      // Existing waiters (useTaskCenterData etc.) hold a reference to the original promise.
      // Resetting it would orphan those waiters — they'd wait for a dead promise until
      // the 60s timeout expires, even if the sidecar is already running.
      // Keep the original promise; markGlobalSidecarReady() resolves it for ALL waiters.

      await startGlobalSidecar();

      if (!mountedRef.current) return;

      markGlobalSidecarReady();
      retryCountRef.current = 0; // Reset on success

      // Set log server URL to global sidecar for unified logging
      try {
        const globalUrl = await getGlobalServerUrl();
        setLogServerUrl(globalUrl);
        console.log("[App] Global sidecar started, log URL set:", globalUrl);
      } catch (e) {
        console.warn("[App] Failed to set log server URL:", e);
      }
    } catch (error) {
      if (!mountedRef.current) return;

      retryCountRef.current += 1;
      const currentRetry = retryCountRef.current;

      if (currentRetry <= MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s
        const delay = BASE_DELAY * Math.pow(2, currentRetry - 1);
        console.log(
          `[App] Global sidecar failed, retry ${currentRetry}/${MAX_RETRIES} in ${delay}ms`,
        );

        retryTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            void startGlobalSidecarSilent();
          }
        }, delay);
      } else {
        // Max retries reached, mark as ready to unblock waiting components
        markGlobalSidecarReady();
        console.error("[App] Global sidecar failed after max retries:", error);
      }
    }
  }, []);

  // 方案 A: Rust 统一恢复 - 前端不再主动恢复，只监听事件
  // Rust 层 initialize_cron_manager 会自动恢复所有 running 状态的任务

  // app_launch (DAU) — fire exactly once, but only AFTER config finishes loading
  // from disk. Gating on `!configLoading` makes the runtimes_active adoption
  // snapshot accurate: DEFAULT_CONFIG has no `agents` key, so a genuine no-agents
  // user would otherwise be indistinguishable from "config not loaded yet"
  // (cross-review W1). isLoading always reaches false (ConfigProvider sets it in
  // a finally), so this is DAU-safe — app_launch will always fire. initAnalytics
  // is idempotent, so awaiting it here just guarantees device_id/version preload.
  const appLaunchTrackedRef = useRef(false);
  useEffect(() => {
    if (appLaunchTrackedRef.current || configLoading) return;
    appLaunchTrackedRef.current = true;
    void initAnalytics().then(() => {
      const cfg = configRef.current;
      // distinct effective external runtimes the user has configured agents for.
      // gate-aware → '' when multiAgentRuntime is off; '' (not omitted) for a
      // loaded-but-no-agents user. Captures "configured but maybe never used"
      // runtimes that turn-level events (ai_turn_complete) can't see.
      const runtimesActive = Array.from(
        new Set(
          (cfg.agents ?? [])
            .map((a) =>
              resolveEffectiveRuntime(a.runtime, !!cfg.multiAgentRuntime),
            )
            .filter((r) => r !== "builtin"),
        ),
      )
        .sort()
        .join(",");
      track("app_launch", {
        launch_type: "cold",
        runtimes_active: runtimesActive,
      });
    });
  }, [configLoading]);

  // Start Global Sidecar on mount, cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    retryCountRef.current = 0;

    // Initialize analytics (async, non-blocking). app_launch itself is tracked
    // in a dedicated config-loaded effect (see above) so its runtimes_active
    // adoption snapshot reflects the real on-disk agent set, not DEFAULT_CONFIG.
    void initAnalytics();

    // Initialize the ready promise BEFORE starting the sidecar
    // This allows other components to wait for it
    initGlobalSidecarReadyPromise();

    // Start Global Sidecar immediately on app launch
    // This ensures MCP and other global API calls work from any page
    void startGlobalSidecarSilent();

    // NOTE: Bundled workspace (mino) initialization is handled by
    // ensureBundledWorkspace() inside ConfigProvider.load(), which runs
    // before loadProjects() to eliminate race conditions.

    // 方案 A: Rust 统一恢复 - 监听恢复事件（仅用于日志和 UI 反馈）
    // Rust 层会自动恢复任务，前端只需要监听结果
    const listenerAc = new AbortController();

    if (isTauriEnvironment()) {
      // Listen for background session completion events
      void listenWithCleanup<{ sessionId: string; sidecarStopped: boolean }>(
        "session:background-complete",
        (event) => {
          if (!mountedRef.current) return;
          const { sessionId, sidecarStopped } = event.payload;
          console.log(
            `[App] Background session completion finished: session=${sessionId}, sidecarStopped=${sidecarStopped}`,
          );

          setTabs((prev) =>
            prev.map((tab) =>
              tab.sessionId === sessionId && tab.isGenerating
                ? { ...tab, isGenerating: false }
                : tab,
            ),
          );

          const matchingTab = tabsRef.current.find(
            (tab) => tab.sessionId === sessionId && tab.agentDir,
          );
          if (matchingTab?.agentDir) {
            getSessions(matchingTab.agentDir)
              .then((sessions) => {
                if (!mountedRef.current) return;
                const refreshed = sessions.find(
                  (session) => session.id === sessionId,
                );
                if (!refreshed) return;
                const refreshedTitle = getSessionDisplayText(refreshed);
                setTabs((prev) =>
                  prev.map((tab) =>
                    tab.sessionId === sessionId && tab.title !== refreshedTitle
                      ? { ...tab, title: refreshedTitle }
                      : tab,
                  ),
                );
                window.dispatchEvent(
                  new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED),
                );
              })
              .catch((err) =>
                console.warn(
                  "[App] Failed to refresh background-completed session metadata:",
                  err,
                ),
              );
          }
        },
        listenerAc.signal,
      );

      // Floating ball "展开 ↗" (PRD 0.2.35): Rust raises the main window and
      // emits this; re-dispatch onto the existing OPEN_SESSION_IN_NEW_TAB
      // DOM-event path so the companion's session opens via the same
      // cron-aware plan→spawn flow as the task center.
      void listenWithCleanup<{
        sessionId: string;
        workspacePath: string;
        preview?: { path?: string; initialLineNumber?: number };
      }>(
        "fb:open-session",
        (event) => {
          if (!mountedRef.current) return;
          const { sessionId, workspacePath, preview } = event.payload ?? {};
          if (!sessionId || !workspacePath) return;
          window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
              detail: { sessionId, workspacePath, preview },
            }),
          );
        },
        listenerAc.signal,
      );

      void listenWithCleanup(
        "fb:open-desktop-pet-settings",
        () => {
          if (!mountedRef.current) return;
          window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
              detail: { section: "desktop-pet" },
            }),
          );
        },
        listenerAc.signal,
      );

      // Listen for individual task recovered events
      void listenWithCleanup<CronTaskRecoveredPayload>(
        CRON_EVENTS.TASK_RECOVERED,
        (event) => {
          if (!mountedRef.current) return;
          const { taskId, sessionId, port } = event.payload;
          console.log(
            `[App] Cron task recovered: ${taskId} (session: ${sessionId}, port: ${port})`,
          );
        },
        listenerAc.signal,
      );

      // Listen for recovery summary event
      void listenWithCleanup<CronRecoverySummaryPayload>(
        CRON_EVENTS.RECOVERY_SUMMARY,
        (event) => {
          if (!mountedRef.current) return;
          const { totalTasks, recoveredCount, failedCount, failedTasks } =
            event.payload;
          if (totalTasks > 0) {
            console.log(
              `[App] Cron recovery summary: ${recoveredCount}/${totalTasks} recovered, ${failedCount} failed`,
            );
            if (failedTasks.length > 0) {
              console.warn("[App] Failed tasks:", failedTasks);
            }
            track("cron_recover", {
              recovered_count: recoveredCount,
              failed_count: failedCount,
            });
          }
        },
        listenerAc.signal,
      );

      // Listen for manager ready event (indicates recovery is complete)
      void listenWithCleanup(
        CRON_EVENTS.MANAGER_READY,
        () => {
          if (!mountedRef.current) return;
          console.log("[App] Cron manager ready (Rust recovery complete)");
        },
        listenerAc.signal,
      );

      void listenWithCleanup<NotificationBadgeIncrementPayload>(
        "notification:badge-increment",
        (event) => {
          if (!mountedRef.current) return;
          const cfg = configRef.current;
          if (!cfg.osNotifications || !(cfg.notificationBadge ?? false)) return;
          const createdAt = Date.now();
          const fallbackId = `legacy:${createdAt}:${Math.random().toString(36).slice(2, 8)}`;
          const item = normalizeNotificationBadgeIncrementPayload(
            event.payload,
            fallbackId,
            createdAt,
          );
          if (!item) return;
          const activeTab = tabsRef.current.find(
            (tab) => tab.id === activeTabIdRef.current,
          );
          if (
            isRendererForegrounded() &&
            isNotificationBadgeTargetVisible(item.target, activeTab)
          ) {
            return;
          }
          setExternalNotificationBadges((items) =>
            upsertNotificationBadgeItem(items, item),
          );
        },
        listenerAc.signal,
      );

      // Listen for Global Sidecar auto-restart by Rust health monitor
      void listenWithCleanup<string>(
        "global-sidecar:restarted",
        (event) => {
          if (!mountedRef.current) return;
          const newUrl = event.payload;
          console.log(
            "[App] Global sidecar auto-restarted by health monitor:",
            newUrl,
          );
          updateGlobalServerUrl(newUrl);
          setLogServerUrl(newUrl);
          // Safety net: if the initial startGlobalSidecar() invoke is still blocked
          // (e.g., monitor killed the first sidecar during its TCP health check),
          // the ready promise would never resolve. Resolve it here so that components
          // waiting on waitForGlobalSidecar() can proceed with the new sidecar. (#58)
          markGlobalSidecarReady();
        },
        listenerAc.signal,
      );

      // session:sidecar-terminal — emitted by Rust ONLY when a Session
      // Sidecar is removed with no remaining owners (so the health monitor
      // will not auto-restart it). This is the single source of truth for
      // "the underlying session is gone for good"; reset any Tab whose
      // sessionId matches so the next `planSessionOpen` doesn't jump-to-tab
      // into a Tab whose sidecar has been dead for hours. The crash-with-
      // owners path stays handled by `session-sidecar:restarted` in
      // TabProvider — this listener deliberately doesn't fire for that case.
      //
      // Stale-event guard (Codex review CRIT-1): a same-session-id relaunch
      // can happen between Rust emitting and us receiving the event (user
      // clicks history → Scenario 4 spins up a fresh sidecar with a higher
      // generation — Rust's `instance_counter` guarantees uniqueness). The
      // stale terminal event would then wipe a tab that's already bound to
      // the live new sidecar. Re-query Rust at handling time: if a sidecar
      // entry exists for this sessionId NOW, the event is stale and the
      // current binding must NOT be cleared.
      void listenWithCleanup<{ sessionId: string; generation: number }>(
        "session:sidecar-terminal",
        async (event) => {
          if (!mountedRef.current) return;
          const { sessionId, generation } = event.payload;
          // Generation check first: a same-session relaunch after this terminal
          // event gets a fresh generation. If that replacement is currently dead
          // but still ownerful and awaiting health-monitor recovery, a liveness
          // check alone would return false and incorrectly clear the new binding.
          const currentGeneration = await getSessionGeneration(sessionId);
          if (currentGeneration !== null && currentGeneration !== generation) {
            console.log(
              `[App] Ignoring stale terminal event for ${sessionId} (event gen=${generation}, current gen=${currentGeneration})`,
            );
            return;
          }
          // Presence check for the same-generation edge case. Readiness is
          // intentionally irrelevant here; any live entry means don't clear.
          const liveSidecarPresent = await hasSessionSidecar(sessionId);
          if (liveSidecarPresent) {
            console.log(
              `[App] Ignoring stale terminal event for ${sessionId} (gen=${generation}) — live sidecar entry present`,
            );
            return;
          }
          if (!mountedRef.current) return;
          setTabs((prev) => {
            const next = applyTerminalSessionToTabs(prev, sessionId);
            if (next !== prev) {
              console.log(
                `[App] Tab.sessionId reset for terminated session ${sessionId}`,
              );
            }
            return next as typeof prev;
          });
        },
        listenerAc.signal,
      );

      // Reconcile path — Rust emits this when its terminal_events broadcast
      // lagged (capacity 64 exceeded by a shutdown burst). Payload is the
      // currently-live session id list snapshotted at lag-detection time;
      // any Tab.sessionId NOT in that set is suspect.
      //
      // Two layers of guarding (Codex review CRIT-2):
      //  (1) The snapshot can be stale by the time we receive — for each
      //      suspect, re-query Rust's current sidecar generation and only treat
      //      it as gone if Rust has no sidecar entry for that id. A newer
      //      generation must survive even if its process is temporarily dead
      //      and waiting for health-monitor recovery.
      //  (2) Candidates are taken from a tabsRef snapshot; new tabs may
      //      appear during our async work. To avoid clearing those, we
      //      apply cleanup tab-by-tab via `applyTerminalSessionToTabs`
      //      against the *current* prev, and only for the exact session
      //      ids we definitively confirmed gone.
      void listenWithCleanup<{ liveSessionIds: string[] }>(
        "session:sidecar-terminal-reconcile",
        async (event) => {
          if (!mountedRef.current) return;
          const stillLive = new Set<string>(event.payload.liveSessionIds);
          const candidates = tabsRef.current
            .filter((t) => t.sessionId && !isPendingSessionId(t.sessionId))
            .map((t) => t.sessionId as string)
            .filter((sid) => !stillLive.has(sid));
          const goneIds: string[] = [];
          await Promise.all(
            candidates.map(async (sid) => {
              const currentGeneration = await getSessionGeneration(sid);
              if (currentGeneration === null) goneIds.push(sid);
            }),
          );
          if (!mountedRef.current || goneIds.length === 0) return;
          setTabs((prev) => {
            let next = prev;
            for (const sid of goneIds) {
              next = applyTerminalSessionToTabs(next, sid) as typeof prev;
            }
            if (next !== prev) {
              console.log(
                `[App] Reconcile cleared ${goneIds.length} stale binding(s)`,
              );
            }
            return next;
          });
        },
        listenerAc.signal,
      );
    }

    return () => {
      mountedRef.current = false;
      // Clear any pending retry
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      // Tear down all listeners registered above (each listenWithCleanup
      // wires its own teardown on `signal.abort`, so a single abort here
      // reaches every one).
      listenerAc.abort();
      // Flush any pending frontend logs before shutdown
      forceFlushLogs();
      clearLogServerUrl();
      // NOTE: Do NOT call stopAllSidecars() here.
      // This cleanup runs on ANY unmount (including error boundary recovery),
      // not just app exit. Killing the sidecar during error recovery creates a
      // death loop: error → unmount → kill sidecar → sidecar unavailable → more errors.
      // Rust handles sidecar cleanup on actual exit (WindowEvent::Destroyed, ExitRequested).
    };
  }, [startGlobalSidecarSilent]);

  // Update tab isGenerating state (called from TabProvider via callback)
  const updateTabGenerating = useCallback(
    (tabId: string, isGenerating: boolean) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, isGenerating } : t)),
      );
    },
    [],
  );

  // Update tab title (called from TabProvider when auto-title or rename occurs)
  const updateTabTitle = useCallback((tabId: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title } : t)));
  }, []);

  // Update tab unread state (called from TabProvider when message completes on non-active tab)
  const updateTabUnread = useCallback((tabId: string, hasUnread: boolean) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId);
      if (tab && tab.hasUnread !== hasUnread) {
        return prev.map((t) => (t.id === tabId ? { ...t, hasUnread } : t));
      }
      return prev; // no-op: avoid unnecessary re-render
    });
  }, []);

  const updateWorkbenchRoute = useCallback((tabId: string, route: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId && tab.view === "workbench" && tab.workbench
          ? { ...tab, workbench: { ...tab.workbench, route } }
          : tab,
      ),
    );
  }, []);

  const clearActiveTabUnread = useCallback(() => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return;
    updateTabUnread(activeTabId, false);
  }, [updateTabUnread]);
  const lastUnreadClearedActiveTabIdRef = useRef<string | null>(null);

  const acknowledgeNotificationTarget = useCallback(
    (target: NotificationBadgeTarget) => {
      setExternalNotificationBadges((items) =>
        acknowledgeNotificationBadgeTarget(items, target),
      );
    },
    [],
  );

  const acknowledgeActiveChatSessionNotifications = useCallback(() => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return;
    const activeTab = tabsRef.current.find((tab) => tab.id === activeTabId);
    if (activeTab?.view !== "chat") return;
    const sessionId = activeTab.sessionId?.trim();
    if (!sessionId || isPendingSessionId(sessionId)) return;
    acknowledgeNotificationTarget({ type: "session", sessionId });
  }, [acknowledgeNotificationTarget]);

  const handleWindowFocused = useCallback(() => {
    clearActiveTabUnread();
    acknowledgeActiveChatSessionNotifications();
  }, [acknowledgeActiveChatSessionNotifications, clearActiveTabUnread]);

  // Update tab sessionId when backend creates real session (called from TabProvider)
  // This ensures Session singleton constraint works correctly:
  // - Tab.sessionId syncs with the actual session ID
  // - History dropdown can detect if session is already open in a Tab
  // - Rust HashMap keys are upgraded from "pending-xxx" to real session ID
  const updateTabSessionId = useCallback(
    async (
      tabId: string,
      newSessionId: string,
      options?: AdoptMigratedSessionOptions,
    ): Promise<boolean> => {
      // Find the current tab to get the old sessionId
      const currentTab = tabsRef.current.find((t) => t.id === tabId);
      if (!currentTab) {
        console.error(
          `[App] Refusing to update missing tab ${tabId} sessionId to ${newSessionId}`,
        );
        return false;
      }
      const oldSessionId = currentTab?.sessionId;

      console.log(
        `[App] Tab ${tabId} sessionId updating: ${oldSessionId} -> ${newSessionId}`,
      );

      // Upgrade the session ID in Rust HashMap (sidecars + session_activations)
      // This is a no-op if oldSessionId is null or same as newSessionId
      if (
        oldSessionId &&
        oldSessionId !== newSessionId &&
        !options?.sidecarAlreadyMigrated
      ) {
        const upgraded = await upgradeSessionId(oldSessionId, newSessionId);
        console.log(
          `[App] Rust HashMap upgrade: ${oldSessionId} -> ${newSessionId}, success=${upgraded}`,
        );
        if (!upgraded) {
          console.error(
            `[App] Refusing to update tab ${tabId} sessionId because Rust sidecar upgrade failed: ${oldSessionId} -> ${newSessionId}`,
          );
          return false;
        }
        if (upgraded) {
          const fbResult = await migrateFloatingBallSessionBinding(
            oldSessionId,
            newSessionId,
          );
          if (fbResult.migrated) {
            console.log(
              `[App] Floating ball session binding migrated: ${oldSessionId} -> ${newSessionId}, notified=${fbResult.notified}`,
            );
          }
        }
      } else if (
        oldSessionId &&
        oldSessionId !== newSessionId &&
        options?.sidecarAlreadyMigrated
      ) {
        console.log(
          `[App] Skipping Rust HashMap upgrade for already-migrated sidecar: ${oldSessionId} -> ${newSessionId}`,
        );
      }

      // Update UI state
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, sessionId: newSessionId } : t,
        ),
      );
      return true;
    },
    [],
  );

  // Perform the actual tab close operation (pure function, no confirmation)
  // UI updates are immediate; resource cleanup runs in background (non-blocking)
  const performCloseTab = useCallback(
    (tabId: string) => {
      const currentTabs = tabsRef.current;

      // Double-check: tab might have been removed
      const tab = currentTabs.find((t) => t.id === tabId);
      if (!tab) return;

      const remainingTabs = currentTabs.filter((item) => item.id !== tabId);
      const remainingChromeTabs = getChromeTabs(remainingTabs);
      const closingChromeTab = !isWorkbenchAgentSurfaceTab(tab);
      const actualTabCount = Math.max(
        1,
        getChromeTabCount(currentTabs) - (closingChromeTab ? 1 : 0),
      );

      // Track tab_close event with correct count
      track("tab_close", { view: tab.view, tab_count: actualTabCount });

      // Drop any leftover pending surface for this tab to avoid leaking it into
      // a later (unrelated) session_new — the analytics module keeps these
      // module-level until consumed.
      clearPendingSessionBirth(tabId);

      // ========== IMMEDIATE UI UPDATE (non-blocking) ==========
      // Update UI state first for instant response
      if (remainingChromeTabs.length === 0) {
        // Agent surfaces are not application tabs. Keep running surfaces mounted,
        // but always leave one visible launcher behind when the last chrome tab closes.
        const newTab = createNewTab();
        const nextTabs = [...remainingTabs, newTab];
        setTabs(nextTabs);
        setActiveTabId(newTab.id, nextTabs);
      } else {
        // Normal case: close the tab
        const newTabs = remainingTabs;

        // If closing the active tab, switch to the last visible tab. Hidden
        // workbench Agent surfaces must never become the chrome active tab.
        if (tabId === activeTabIdRef.current) {
          setActiveTabId(
            remainingChromeTabs[remainingChromeTabs.length - 1].id,
            newTabs,
          );
        }

        setTabs(newTabs);
      }

      // ========== BACKGROUND CLEANUP (non-blocking) ==========
      // Capture tab data before cleanup to avoid stale closure issues
      const tabSessionId = tab.sessionId;
      const tabAgentDir = tab.agentDir;

      // Resource cleanup runs asynchronously without blocking UI
      // CRITICAL: SSE proxy must be stopped BEFORE Sidecar to avoid "unexpected EOF" errors
      // When Sidecar dies, open HTTP connections break mid-stream causing errors
      const cleanupResources = async () => {
        try {
          // Step 1: Try to start background completion if AI is running
          // This keeps the Sidecar alive so AI can finish its response
          if (tabSessionId) {
            const bgResult = await startBackgroundCompletion(tabSessionId);
            if (bgResult.started) {
              console.log(
                `[App] Tab ${tabId} closing: AI still running, background completion started for session ${tabSessionId}`,
              );
            }
          }

          // Step 2: Stop SSE proxy FIRST to ensure clean disconnection
          // This prevents "unexpected EOF" errors when Sidecar is stopped
          await stopSseProxy(tabId);

          // Step 3: Release Tab's ownership of the Session Sidecar
          // If background completion is active, Sidecar continues running (BG owner keeps it alive)
          if (tabSessionId) {
            try {
              const stopped = await releaseTabSession(tabSessionId, tabId);
              console.log(
                `[App] Tab ${tabId} released session ${tabSessionId}, sidecar stopped: ${stopped}`,
              );
            } catch (error) {
              console.error(
                `[App] Error releasing session sidecar for tab ${tabId}:`,
                error,
              );
              // Fallback to legacy stopTabSidecar
              void stopTabSidecar(tabId);
            }
          } else if (tabAgentDir) {
            // No sessionId but has agentDir - legacy case, use stopTabSidecar
            void stopTabSidecar(tabId);
          }
        } catch (error) {
          console.error(
            `[App] Background cleanup error for tab ${tabId}:`,
            error,
          );
        }
      };

      // Runs in background — catch ensures no unhandled rejection
      cleanupResources().catch((err) =>
        console.error(`[App] Unhandled cleanup error for tab ${tabId}:`, err),
      );
    },
    [setActiveTabId],
  );

  // Close tab — if AI is generating, close immediately and let it finish in background.
  // Workbench-owned dirty state is resolved before the tab lifecycle continues.
  const closeTabWithConfirmation = useCallback(
    async (tabId: string) => {
      if (closingWorkbenchTabsRef.current.has(tabId)) return;
      const tab = tabsRef.current.find((t) => t.id === tabId);
      const guard = workbenchNavigationGuardsRef.current.get(tabId);

      if (guard) {
        closingWorkbenchTabsRef.current.add(tabId);
        try {
          if (!(await guard.confirmLeave())) return;
        } catch (error) {
          console.error("[App] Workbench navigation guard failed:", error);
          return;
        } finally {
          closingWorkbenchTabsRef.current.delete(tabId);
        }
      }

      if (tab?.isGenerating && tab.sessionId) {
        void performCloseTab(tabId);
        toastRef.current.info(t("appChrome.backgroundCompletion"));
        return;
      }

      void performCloseTab(tabId);
    },
    [performCloseTab, t],
  );

  // Close current active tab (for Cmd+W)
  const closeCurrentTab = useCallback(() => {
    const currentActiveTabId = activeTabIdRef.current;
    if (!currentActiveTabId) return;

    const currentTabs = tabsRef.current;
    const activeTab = currentTabs.find((t) => t.id === currentActiveTabId);

    // Special case: If only one launcher tab, do nothing
    if (
      getChromeTabCount(currentTabs) === 1 &&
      activeTab?.view === "launcher"
    ) {
      return;
    }

    // Multiple tabs OR last tab is chat/settings: use the unified confirmation logic
    void closeTabWithConfirmation(currentActiveTabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, [setActiveTabId]);

  const selectTabOrRestoreAgentSurface = useCallback(
    (tabId: string) => {
      const currentTabs = tabsRef.current;
      const target = currentTabs.find((tab) => tab.id === tabId);
      const targetSurface = target?.workbenchAgentSurface;
      if (!target || !targetSurface) {
        setActiveTabId(tabId);
        return;
      }

      const sourceTabId = targetSurface.sourceTabId;
      setTabs((items) =>
        items.map((tab) => {
          const surface = tab.workbenchAgentSurface;
          if (!surface) return tab;
          if (tab.id !== tabId && surface.sourceTabId !== sourceTabId) {
            return tab;
          }
          return {
            ...tab,
            hasUnread: tab.id === tabId ? false : tab.hasUnread,
            workbenchAgentSurface: {
              ...surface,
              presentation: tab.id === tabId ? "dialog" : "dock",
            },
          };
        }),
      );
      const sourceTab = currentTabs.find(
        (tab) =>
          tab.id === targetSurface.sourceTabId &&
          !isWorkbenchAgentSurfaceTab(tab),
      );
      const currentActive = currentTabs.find(
        (tab) =>
          tab.id === activeTabIdRef.current && !isWorkbenchAgentSurfaceTab(tab),
      );
      const fallback = getChromeTabs(currentTabs).at(-1);
      setActiveTabId(
        sourceTab?.id ?? currentActive?.id ?? fallback?.id ?? null,
      );
    },
    [setActiveTabId],
  );

  // Application-level keyboard shortcuts (new/close/switch tab, task-center,
  // settings, reload-block). The bindings + matching live in the declarative
  // APP_SHORTCUTS table (utils/appShortcuts.ts) — the same source the Settings
  // 「快捷键」reference renders from. Here we only build the side-effecting
  // context and dispatch; callbacks are stabilized via refs so the empty-deps
  // closure resolves them at press time.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      if (
        dispatchAppShortcut(e, isMac, {
          tabs: getChromeTabs(tabsRef.current),
          activeTabId: activeTabIdRef.current,
          setActiveTabId,
          newTab: handleNewTab,
          closeCurrentTab,
          dismissTopmost,
          hasBlockingBackdrop: () =>
            !!document.querySelector('.fixed.inset-0[class*="backdrop-blur"]'),
          openTaskCenter: () =>
            window.dispatchEvent(
              new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CENTER),
            ),
          openSettings: () =>
            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS)),
        })
      )
        return;
      // ⌘/Ctrl+A for plain <input>/<textarea> (chat input, rename fields). The native
      // macOS "Select All" menu item was removed so ⌘A reaches the WebView (see
      // src-tauri/src/lib.rs); Monaco and the workspace tree own it via their own
      // keydown handlers, but a plain text control has no JS owner — handle it here
      // deterministically rather than depend on an undocumented WKWebView default.
      // Returns false (no-op) for Monaco/tree/everything else, so those still own ⌘A.
      handleSelectAllKeydown(e, isMac);
    };

    // Capture phase: application-level shortcuts (Cmd+W/T/Tab, etc.) MUST fire before
    // any component-level handlers. Without capture, Monaco editor (or any component
    // calling stopPropagation) blocks the event → our handler never fires →
    // e.preventDefault() never called → Tauri native Cmd+W closes the window.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, [setActiveTabId]);

  /**
   * Launch a project with Session Singleton Architecture
   *
   * Four scenarios (evaluated in order):
   * 1. Session already open in a Tab → Jump to that Tab
   * 2. Session has running cron task (no Tab) → New Tab connects to Cron Sidecar
   * 3. Current Tab has running cron task → New Tab + New Sidecar
   * 4. Normal switch → Current Tab switches Session
   */
  const handleLaunchProject = useCallback(
    async (
      project: Project,
      sessionId?: string,
      initialMessage?: InitialMessage,
      analyticsContext?: LaunchProjectAnalyticsContext,
      sessionBirthHint?: LaunchSessionBirthHint,
    ) => {
      const activeTabId = activeTabIdRef.current;
      if (!activeTabId) return;

      // Per-tab launch guard: prevent concurrent launches on the same tab
      // A second launch would overwrite the first's initialMessage and kill its sidecar
      if (launchingTabRef.current === activeTabId) {
        console.warn(
          `[App] handleLaunchProject: launch already in progress for tab ${activeTabId}, ignoring`,
        );
        return;
      }
      launchingTabRef.current = activeTabId;

      // Resolve agent meta for analytics. `getAgentByWorkspacePath` may return
      // undefined when the workspace isn't bound to any agent (rare — happens
      // for ad-hoc paths) — in that case agent_hash=null + runtime='builtin'
      // as the natural fallback.
      //
      // Surface set is DEFERRED to after `targetTabId` is finalized below — when
      // Scenario 3 creates a new tab, the new TabProvider's chat:system-init must
      // consume the surface from THE NEW tabId, not the original activeTabId.
      // Tracked here for review feedback B2/H2 (Codex BLOCKER, Codex HIGH).
      let pendingSurfaceForLaunch: PendingSessionBirthContext | null = null;
      let workspaceOpenAnalytics: {
        agent_hash: string | null;
        runtime: ReturnType<typeof resolveEffectiveRuntime>;
        entry_intent: EntryIntent;
        has_initial_message: boolean;
        session_id: null;
      } | null = null;
      if (!sessionId) {
        // workspace_open path (NEW session): caller-provided analytics context is
        // authoritative. Falling back to launcher_input for initialMessage preserves
        // legacy producers, but new producers should pass their true entry intent
        // so `/init`, task alignment, and support diagnostics do not all collapse
        // into the launcher input bucket.
        const cfg = configRef.current;
        const agent = getAgentByWorkspacePath(cfg, project.path);
        const fallbackLaunchContext = initialMessage
          ? {
              surface: "launcher_input" as const,
              entryIntent: "send_message" as const,
            }
          : {
              surface: "agent_card" as const,
              entryIntent: "open_workspace" as const,
            };
        const launchContext = {
          surface: analyticsContext?.surface ?? fallbackLaunchContext.surface,
          entryIntent:
            analyticsContext?.entryIntent ?? fallbackLaunchContext.entryIntent,
          assistantEntry: analyticsContext?.assistantEntry,
        };
        pendingSurfaceForLaunch = {
          surface: launchContext.surface,
          entryIntent: launchContext.entryIntent,
          hasInitialMessage: !!initialMessage,
          assistantEntry: launchContext.assistantEntry,
        };
        workspaceOpenAnalytics = {
          agent_hash: hashAgentNameSync(agent?.name ?? null),
          runtime: resolveEffectiveRuntime(
            agent?.runtime,
            !!cfg.multiAgentRuntime,
          ),
          entry_intent: launchContext.entryIntent,
          has_initial_message: !!initialMessage,
          session_id: null,
        };
      }
      // history_open (existing session) is tracked in the `sessionId` branch below,
      // AFTER the session's frozen runtime (targetRuntime) is resolved. The agent's
      // config may have changed since the session was created, so config-based
      // runtime would diverge from the server-side ai_turn_complete (cross-review C2).
      // `history_open` explicitly reports the TARGET session id. It is not in the
      // Active Context auto-inject allowlist, so missing this id would make history
      // joins impossible instead of merely falling back.

      setTabErrors((prev) => ({ ...prev, [activeTabId]: null }));
      setLoadingTabs((prev) => ({ ...prev, [activeTabId]: true }));
      let targetTabId = activeTabId;

      try {
        const activeTab = tabsRef.current.find((t) => t.id === activeTabId);
        perfMark("launch_start", { tabId: activeTabId });
        console.log(
          `[App][launch] START active=${activeTabId} view=${activeTab?.view} hasSession=${!!activeTab?.sessionId} target-sessionId=${sessionId ?? "NEW"}`,
        );

        if (sessionId) {
          // Existing-session opens are not session births. Clear any stale
          // new-session birth context left on this tab so a later system-init for
          // the target history session cannot consume it as `session_new`.
          clearPendingSessionBirth(activeTabId);

          const cfg = configRef.current;
          const targetAgentRuntime = normalizeRuntime(
            getAgentByWorkspacePath(cfg, project.path)?.runtime,
          );
          const currentAgentRuntime = activeTab?.agentDir
            ? normalizeRuntime(
                getAgentByWorkspacePath(cfg, activeTab.agentDir)?.runtime,
              )
            : targetAgentRuntime;
          const [
            targetRuntimeIdentity,
            resolvedCurrentRuntimeIdentity,
            activation,
            currentSessionHasPersistentOwners,
          ] = await Promise.all([
            resolveSessionRuntimeIdentityForOpen(
              sessionId,
              targetAgentRuntime,
              cfg?.multiAgentRuntime,
            ),
            resolveSessionRuntimeIdentityForOpen(
              activeTab?.sessionId,
              currentAgentRuntime,
              cfg?.multiAgentRuntime,
            ),
            getSessionActivation(sessionId),
            activeTab?.sessionId
              ? sessionHasPersistentOwners(activeTab.sessionId)
              : Promise.resolve(false),
          ]);
          const targetRuntime = targetRuntimeIdentity.runtime;
          const resolvedCurrentRuntime = resolvedCurrentRuntimeIdentity.runtime;
          // history_open analytics (cross-review C2): report the session's FROZEN
          // runtime (targetRuntime, from session metadata) — matches the sidecar
          // spawn runtime and thus server-side ai_turn_complete.runtime — rather
          // than the agent's possibly-drifted current config.
          trackHistorySessionOpen(
            sessionId,
            project.path,
            targetRuntimeIdentity,
            analyticsContext?.historyEntrySource ?? "launcher_recent",
          );
          const currentRuntime = activeTab?.sessionId
            ? resolvedCurrentRuntime
            : targetRuntime;
          const plan = planSessionOpen({
            tabs: tabsRef.current,
            targetSessionId: sessionId,
            multiAgentRuntime: !!cfg?.multiAgentRuntime,
            currentRuntime,
            targetRuntime,
            currentRuntimeIdentity: activeTab?.sessionId
              ? resolvedCurrentRuntimeIdentity
              : targetRuntimeIdentity,
            targetRuntimeIdentity,
            targetActivation: activation,
            currentSessionHasPersistentOwners,
          });
          console.log(
            `[App] handleLaunchProject: session-open plan=${plan.type}${plan.type === "open-new-tab" ? ` reason=${plan.reason}` : ""}, target=${sessionId}`,
          );

          if (plan.type === "jump-to-tab") {
            // Defensive presence check — race window between Rust emitting
            // `session:sidecar-terminal` and the renderer applying the cleanup.
            // The terminal-event listener above is the primary fix (clears
            // stale Tab.sessionId), but if the user clicks task center inside
            // that tiny window, the planner can still match the not-yet-cleaned
            // tab and we'd "jump" to a tab whose sidecar is dead. A direct
            // `hasSessionSidecar` asks Rust whether ANY live sidecar entry
            // currently exists for this session id. False means the manager has
            // nothing, which is the exact stale-binding case. Fall through to
            // Scenario 4 (`ensureSessionSidecar` re-spawns the session, adds
            // this Tab as owner) so the user always gets a working session,
            // never an empty UI. (Codex review AI-2 wording fix.)
            const liveSidecarPresent = await hasSessionSidecar(sessionId);
            if (!liveSidecarPresent) {
              console.warn(
                `[App] Scenario 1 stale: tab ${plan.tabId} bound to session ${sessionId} but no live sidecar — falling through to relaunch`,
              );
              // Continue to Scenario 4 below. We do NOT pre-rewrite the tab's
              // sessionId here (the terminal-event listener will catch up
              // shortly, and Scenario 4's setTabs at the tail of this function
              // sets it authoritatively after `ensureSessionSidecar` succeeds).
              targetTabId = plan.tabId;
              if (plan.tabId !== activeTabId) {
                selectTabOrRestoreAgentSurface(plan.tabId);
              }
              setLoadingTabs((prev) => ({
                ...prev,
                [activeTabId]: false,
                [plan.tabId]: true,
              }));
            } else {
              console.log(
                `[App] Scenario 1: Session ${sessionId} already in tab ${plan.tabId}, jumping to it`,
              );
              selectTabOrRestoreAgentSurface(plan.tabId);
              setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
              launchingTabRef.current = null;
              return;
            }
          }

          if (plan.type === "open-new-tab") {
            if (getChromeTabCount(tabsRef.current) >= MAX_TABS) {
              setTabErrors((prev) => ({
                ...prev,
                [activeTabId]: t("appChrome.maxTabsReached"),
              }));
              setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
              launchingTabRef.current = null;
              return;
            }
            const newTab = createNewTab();
            setTabs((prev) => [...prev, newTab]);
            targetTabId = newTab.id;
            setLoadingTabs((prev) => ({
              ...prev,
              [activeTabId]: false,
              [targetTabId]: true,
            }));
          }

          if (plan.type === "attach-existing-sidecar") {
            console.log(
              `[App] Scenario 2: Session ${sessionId} has cron task ${plan.taskId} on port ${activation?.port}`,
            );
            const result = await ensureSessionSidecar(
              sessionId,
              project.path,
              "tab",
              targetTabId,
            );
            console.log(
              `[App] Tab ${targetTabId} added as owner to session ${sessionId} Sidecar on port ${result.port}`,
            );

            await updateSessionTab(sessionId, targetTabId);

            const oldSessionId = tabsRef.current.find(
              (t) => t.id === targetTabId,
            )?.sessionId;
            if (oldSessionId && oldSessionId !== sessionId) {
              await stopSseProxy(targetTabId);
              await releaseTabSession(oldSessionId, targetTabId);
            }

            setTabs((prev) =>
              prev.map((t) =>
                t.id === targetTabId
                  ? {
                      ...t,
                      agentDir: project.path,
                      sessionId,
                      view: "chat",
                      title: project.displayName || getFolderName(project.path),
                      sidecarConfigDisposition: result.isNew ? "push" : "adopt",
                    }
                  : t,
              ),
            );

            if (targetTabId !== activeTabId) {
              selectTabOrRestoreAgentSurface(targetTabId);
            }
            setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
            launchingTabRef.current = null;
            return;
          }
        } else {
          // ========================================
          // New session: current Session has a persistent owner → open in a new tab
          // ========================================
          // Only a tab WITH a session can have a persistent owner. A launcher /
          // fresh tab (no sessionId) can't — so skip the owner IPC for it.
          // That await is load-bearing for instant-nav: awaiting it yields to React,
          // which paints the workspace card's loading spinner BEFORE the flushSync
          // flip runs — so even with flushSync the user sees a brief card spinner.
          // Skipping it for the launcher case keeps the whole pre-flip path
          // synchronous → the flip lands in the same click tick → no spinner.
          const currentSessionHasPersistentOwners = activeTab?.sessionId
            ? await sessionHasPersistentOwners(activeTab.sessionId)
            : false;
          console.log(
            `[App][launch] persistent-owner-check ${activeTab?.sessionId ? `present=${currentSessionHasPersistentOwners}` : "skipped(no-session)"}`,
          );
          if (currentSessionHasPersistentOwners) {
            console.log(
              `[App] Scenario 3: Current session ${activeTab?.sessionId} has persistent owners, creating new tab`,
            );

            if (getChromeTabCount(tabsRef.current) >= MAX_TABS) {
              setTabErrors((prev) => ({
                ...prev,
                [activeTabId]: t("appChrome.maxTabsReached"),
              }));
              setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
              launchingTabRef.current = null;
              return;
            }

            const newTab = createNewTab();
            setTabs((prev) => [...prev, newTab]);
            targetTabId = newTab.id;
            setLoadingTabs((prev) => ({
              ...prev,
              [activeTabId]: false,
              [targetTabId]: true,
            }));
          }
        }

        // ========================================
        // Scenario 4: Normal switch (or Scenario 3 continuation)
        // Using Session-centric API: Tab becomes owner of Session's Sidecar
        // ========================================
        console.log(
          `[App] Scenario 4: Normal launch - tab ${targetTabId}, project: ${project.path}, sessionId: ${sessionId}`,
        );

        // If current tab has an active session, release it before launching new one
        const currentTabForLaunch = tabsRef.current.find(
          (t) => t.id === targetTabId,
        );
        const oldSessionForLaunch = currentTabForLaunch?.sessionId;
        if (oldSessionForLaunch) {
          const bgResult = await startBackgroundCompletion(oldSessionForLaunch);
          if (bgResult.started) {
            console.log(
              `[App] Scenario 4: AI running on ${oldSessionForLaunch}, background completion started`,
            );
          }
          // Always release old session regardless of AI state:
          // - If BG started: Sidecar stays alive via BG owner
          // - If idle: Sidecar stops (no more owners)
          await stopSseProxy(targetTabId);
          await releaseTabSession(oldSessionForLaunch, targetTabId);
        }

        const configForLaunchBirth = configRef.current;
        const agentForLaunchBirth = configForLaunchBirth
          ? getAgentByWorkspacePath(configForLaunchBirth, project.path)
          : undefined;
        const initialMessageHasExecutionSelection = Boolean(
          initialMessage?.providerExecutionIdentity ||
            initialMessage?.builtinSelection ||
            initialMessage?.runtimeModel ||
            sessionBirthHint?.providerExecutionIdentity ||
            sessionBirthHint?.builtinSelection ||
            sessionBirthHint?.runtimeModel,
        );
        const runtimeBackedProviderIdentityFromConfig = (() => {
          if (
            sessionId ||
            initialMessageHasExecutionSelection ||
            !configForLaunchBirth
          ) {
            return undefined;
          }
          const effectiveAgentRuntime = resolveEffectiveRuntime(
            agentForLaunchBirth?.runtime,
            !!configForLaunchBirth.multiAgentRuntime,
          );
          if (effectiveAgentRuntime !== "builtin") {
            return undefined;
          }
          const sel = resolveBuiltinSelection(
            { agent: agentForLaunchBirth, workspace: project },
            configForLaunchBirth,
            appProvidersRef.current,
            appApiKeysRef.current,
            appProviderVerifyStatusRef.current,
          );
          if (!sel || !isRuntimeBackedProvider(sel.provider)) {
            return undefined;
          }
          const intent = toProviderExecutionIntent(sel.provider, sel.model);
          return intent.kind === "runtime-backed-provider" ? intent : undefined;
        })();
        const runtimeBackedProviderIdentity =
          initialMessage?.providerExecutionIdentity ??
          sessionBirthHint?.providerExecutionIdentity ??
          runtimeBackedProviderIdentityFromConfig;

        // For ordinary new sessions (no sessionId), generate a temporary session ID;
        // the sidecar materializes it later. Runtime-backed providers are different:
        // Rust must read runtime/runtimeSource/providerExecutionIdentity from
        // sessions.json before spawning, so create a real session metadata row before
        // ensureSessionSidecar. This covers both explicit initial-message launches
        // and empty Launcher opens whose current Provider is Codex (订阅).
        let effectiveSessionId =
          sessionId ?? createPendingSessionId(targetTabId);
        if (!sessionId && runtimeBackedProviderIdentity) {
          try {
            const identity = runtimeBackedProviderIdentity;
            const identityResolvedFromCurrentConfig =
              !initialMessage?.providerExecutionIdentity &&
              !sessionBirthHint?.providerExecutionIdentity;
            const birth = buildRuntimeBackedInitialSessionBirth({
              identity,
              permissionMode:
                initialMessage?.permissionMode ??
                sessionBirthHint?.permissionMode ??
                (identityResolvedFromCurrentConfig
                  ? (normalizeStringSetting(
                      agentForLaunchBirth?.runtimeConfig?.permissionMode,
                    ) ??
                    resolveInitialPermissionMode({
                      project,
                      agent: agentForLaunchBirth,
                      defaultPermissionMode:
                        configForLaunchBirth?.defaultPermissionMode,
                    }))
                  : undefined),
              reasoningEffort:
                initialMessage?.reasoningEffort ??
                sessionBirthHint?.reasoningEffort ??
                (identityResolvedFromCurrentConfig
                  ? (normalizeStringSetting(
                      agentForLaunchBirth?.runtimeConfig?.reasoningEffort,
                    ) ??
                    normalizeStringSetting(
                      agentForLaunchBirth?.reasoningEffort,
                    ))
                  : undefined),
              mcpEnabledServers:
                initialMessage?.mcpEnabledServers ??
                sessionBirthHint?.mcpEnabledServers ??
                (identityResolvedFromCurrentConfig
                  ? cloneStringArray(
                      agentForLaunchBirth?.mcpEnabledServers ??
                        project.mcpEnabledServers,
                    )
                  : undefined),
              enabledPluginIds:
                initialMessage?.enabledPluginIds ??
                sessionBirthHint?.enabledPluginIds ??
                (identityResolvedFromCurrentConfig
                  ? cloneStringArray(
                      agentForLaunchBirth?.enabledPluginIds ??
                        project.enabledPluginIds,
                    )
                  : undefined),
              enabledOfficialToolIds:
                initialMessage?.enabledOfficialToolIds ??
                sessionBirthHint?.enabledOfficialToolIds ??
                (identityResolvedFromCurrentConfig
                  ? normalizeOfficialToolIds(
                      agentForLaunchBirth?.enabledOfficialToolIds ??
                        project.enabledOfficialToolIds ??
                        [],
                    )
                  : undefined),
            });
            console.log(
              `[App] Runtime-backed provider launch birth: provider=${identity.providerId} runtime=${birth.runtime} source=${birth.opts.runtimeSource ?? "none"} model=${identity.model}`,
            );
            const prepared = await createSession(project.path, birth.runtime, {
              ...birth.opts,
              origin: originFromDesktopSurface(
                pendingSurfaceForLaunch?.surface,
              ),
              prepareForFirstUserMessage: true,
              materializationSourceSessionId: effectiveSessionId,
            });
            effectiveSessionId = prepared.id;
          } catch (err) {
            console.error(
              "[App] Failed to create runtime-backed provider session:",
              err,
            );
            setTabErrors((prev) => ({
              ...prev,
              [targetTabId]: t("appChrome.codexSessionCreateFailed"),
            }));
            setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
            launchingTabRef.current = null;
            return;
          }
        }

        // Ensure Sidecar is running for this Session, Tab as owner.
        //
        // Pattern 4: this call resolves only after the sidecar's /health/ready
        // returns 200 — i.e. deferred init (migration / skill-seed / sdk-init)
        // has finished. If readiness times out or reports `failed`, the Rust
        // call throws with the last-observed phase embedded in the error
        // string, which we surface via `setTabErrors` → Launcher.startError.
        // For finer-grained UX (inline phase banner during the brief
        // pending → ready window) callers can use `useSessionReady`.
        // PRD 0.2.19 review fix (H2): apply pending surface to the FINAL target tab
        // (Scenario 3 may have rerouted `targetTabId` to a freshly-created tab).
        // Set BEFORE ensureSessionSidecar — the backend may emit chat:system-init
        // synchronously once readiness lands, and the target TabProvider needs to
        // consume the surface from this tabId at that moment.
        if (pendingSurfaceForLaunch) {
          if (workspaceOpenAnalytics) {
            track("workspace_open", {
              ...workspaceOpenAnalytics,
              tab_id: targetTabId,
            });
          }
          setPendingSessionBirth(targetTabId, pendingSurfaceForLaunch);
        }

        // INSTANT-NAV: flip to the chat shell BEFORE awaiting the sidecar boot, so the
        // user lands in Chat instantly (the boot runs under the "AI 启动中" overlay).
        // `effectiveSessionId` is truthy (D1): a real history/prepared runtime-backed
        // id, or a `pending-<tabId>` for ordinary new sessions → TabProvider's SSE
        // connect fires and Chat mounts now.
        //
        // `getSessionPort` is a PAINT-TIMING hint ONLY, never a config-correctness
        // input: null ⇒ flip instant (no ready sidecar to wait on); non-null ⇒ flip
        // after the (fast) ensure. The actual push-vs-adopt disposition is ALWAYS
        // decided by the single post-ensure resolver below using the authoritative
        // `result.isNew` (under the Rust manager lock). So even if getSessionPort is
        // wrong/raced/IPC-errored, the worst case is a mis-timed flip, never a config
        // stomp — that is what removed the Phase B TOCTOU. New sessions flip 'push'
        // immediately (a pending-<tabId> id is provably fresh — no creator can target
        // it); history flips 'pending' until the resolver runs.
        const instantNav = !sessionId;
        const flipInstant =
          instantNav ||
          (!!sessionId && (await getSessionPort(sessionId)) === null);
        const flipTitle = project.displayName || getFolderName(project.path);
        if (flipInstant) {
          perfMark("launch_flip", { tabId: targetTabId });
          console.log(
            `[App][launch] FLIP(flushSync) target=${targetTabId} active=${activeTabId} (chat shell should paint now)`,
          );
          // flushSync is LOAD-BEARING here, not an optimization. A plain setState
          // before `await ensureSessionSidecar` does NOT paint early: React batches
          // this promise-continuation update and coalesces it with the post-ensure
          // updates, so the chat shell only mounts AFTER the ~780ms sidecar boot
          // (verified via logs: TabProvider/Chat mount-effects fired only after
          // ensure_done). flushSync forces a synchronous render+commit of the chat
          // shell NOW, before we await the cold boot — that IS the instant-nav.
          flushSync(() => {
            setTabs((prev) =>
              prev.map((t) =>
                t.id === targetTabId
                  ? // Disposition: a NEW session (pending-<tabId> id) is provably fresh
                    // — no Rust-side creator can target a pending id — so 'push'. A
                    // HISTORY session flips 'pending': push-vs-adopt is unknown until
                    // ensure resolves (ready-port lookup is only a paint hint — a
                    // cron/IM/restart creator can spawn between the check and ensure),
                    // and the single post-ensure
                    // resolver below decides it from the authoritative result.isNew.
                    // Hard-coding a guess here is exactly the #300/#301 stomp we removed.
                    // initialMessage only on the new-session ('push') branch. A 'pending'
                    // tab must NOT carry one: autoSend gates on initialMessage and its
                    // MCP/plugin pushes are not disposition-gated, so a pending tab with a
                    // message would stomp a soon-to-be-'adopt' sidecar. History opens have
                    // no initialMessage today; this makes the invariant structural.
                    buildChatFlipPatch(t, {
                      agentDir: project.path,
                      sessionId: effectiveSessionId,
                      title: flipTitle,
                      initialMessage: instantNav ? initialMessage : undefined,
                      sidecarConfigDisposition: instantNav ? "push" : "pending",
                    })
                  : t,
              ),
            );
            if (targetTabId !== activeTabId) {
              setActiveTabId(targetTabId);
            }
          });
          // Measure the actual PAINT (double-rAF fires after the browser paints) vs
          // the flushSync commit above. card_click → chat_painted = the TRUE
          // click→visible time the user perceives; the other marks are commit-only
          // (React updated the DOM) and can't see how long the browser took to draw.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              perfMark("chat_painted", { tabId: targetTabId });
              console.log(
                `[App][launch] chat_painted target=${targetTabId} (browser painted the flip)`,
              );
            }),
          );
        }

        const result = await ensureSessionSidecar(
          effectiveSessionId,
          project.path,
          "tab",
          targetTabId,
        );
        perfMark("launch_ensured", { tabId: targetTabId });
        console.log(
          `[App] Session Sidecar ensured: port=${result.port}, isNew=${result.isNew}`,
        );

        // Cancel background completion AFTER Tab is registered as an owner.
        // (Order matters — calling cancel first when BG is the last owner causes
        // the sidecar to stop on the BG release, which kills any in-flight
        // streaming turn before its content can be persisted. With Tab already
        // an owner via ensureSessionSidecar above, the BG release is safe and
        // the in-flight turn keeps streaming into the new Tab's SSE.)
        if (sessionId) {
          await cancelBackgroundCompletion(sessionId);
        }

        // Activate session with Tab (for Session singleton tracking and fallback port lookup)
        // Always use effectiveSessionId to ensure session_activations has entry for this Tab
        await activateSession(
          effectiveSessionId,
          targetTabId,
          null,
          result.port,
          project.path,
          false,
        );

        // SINGLE RESOLVER — the authoritative join-vs-fresh decision comes ONLY from
        // result.isNew (decided under the Rust manager lock), never from a pre-ensure
        // prediction. This is what closes the Phase B TOCTOU config-stomp.
        const resolved: SidecarConfigDisposition = result.isNew
          ? "push"
          : "adopt";
        if (!flipInstant) {
          // Non-instant (live/stale history): this IS the first flip, after ensure.
          setTabs((prev) =>
            prev.map((t) =>
              t.id === targetTabId
                ? buildChatFlipPatch(t, {
                    agentDir: project.path,
                    sessionId: effectiveSessionId,
                    title: flipTitle,
                    initialMessage,
                    sidecarConfigDisposition: resolved,
                  })
                : t,
            ),
          );
          if (targetTabId !== activeTabId) {
            setActiveTabId(targetTabId);
          }
        } else {
          // Instant path already flipped (and may have auto-sent initialMessage).
          // Resolve ONLY the disposition — do NOT re-run buildChatFlipPatch, which
          // would re-attach initialMessage and risk a double-send. 'pending'→push|adopt
          // for history; for a new session result.isNew is always true → 'push' (no-op).
          setTabs((prev) =>
            prev.map((t) =>
              t.id === targetTabId
                ? { ...t, sidecarConfigDisposition: resolved }
                : t,
            ),
          );
        }
        setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // PRD 0.2.19 review fix (H3): clear pending surface on launch failure so
        // a later unrelated session_new doesn't inherit a stale surface from this
        // failed attempt. Cover both candidate tabIds (Scenario 3 retarget case).
        clearPendingSessionBirth(targetTabId);
        if (targetTabId !== activeTabId) clearPendingSessionBirth(activeTabId);

        // Closing an Agent dialog while its Sidecar is still starting is an
        // intentional cancellation. The Tauri ensure command may finish after
        // the tab owner has already released and stopped that process; do not
        // turn the expected lifecycle result into a launch error/toast.
        if (!tabsRef.current.some((tab) => tab.id === targetTabId)) {
          console.debug(
            `[App] Launch cancelled because tab ${targetTabId} was closed`,
          );
          return;
        }

        console.error("[App] Failed to start:", errorMsg);

        // Surface the error on the tab the user is actually looking at — when
        // the stale jump-to-tab fallthrough rerouted us to `plan.tabId`, the
        // visible tab is `targetTabId`, not the originally-active one. Writing
        // to `activeTabId` would silently drop the error on a hidden tab while
        // the user stares at a stuck loader. (Codex review WARN-2.)
        const errorTabId =
          targetTabId !== activeTabId ? targetTabId : activeTabId;
        setTabErrors((prev) => ({ ...prev, [errorTabId]: errorMsg }));

        // A5 (instant-nav): with the early flip the tab may already be on the chat
        // view, where `tabErrors` isn't surfaced (it only feeds the Launcher's
        // unused startError) and the startup overlay would otherwise just time out
        // to a blank chat. A toast makes the boot failure visible regardless of
        // which view the user is on. (Full in-chat "启动失败 + 重试" via
        // useSessionReady('failed'): Phase A follow-up.)
        toastRef.current.error(
          t("appChrome.launchFailed", { message: errorMsg }),
        );

        // Cross-AI review (Critical): an instant flip set the tab to chat + 'pending'
        // BEFORE this ensure threw. 'pending' has no resolver left now (the post-ensure
        // step is what threw), so the mounted chat would be WEDGED — neither push nor
        // adopt ever runs, even if the sidecar later recovers (strictly worse than the
        // old self-healing 'push', and it breaks the "never leave a chat pending"
        // invariant). Reset to a terminal 'push' so a later reconnect pushes config.
        // (The browser-dev branch below additionally flips the view.)
        setTabs((prev) =>
          prev.map((t) =>
            t.id === errorTabId && t.sidecarConfigDisposition === "pending"
              ? { ...t, sidecarConfigDisposition: "push" }
              : t,
          ),
        );

        // In browser dev mode, still allow navigation
        if (isBrowserDevMode()) {
          console.log("[App] Browser mode: continuing despite error");
          setTabs((prev) =>
            prev.map((t) =>
              t.id === errorTabId
                ? {
                    ...t,
                    agentDir: project.path,
                    view: "chat",
                    title: project.displayName || getFolderName(project.path),
                    // Terminal: ensure failed — never leave a mounted chat 'pending'.
                    sidecarConfigDisposition: "push" as const,
                  }
                : t,
            ),
          );
        }
      } finally {
        launchingTabRef.current = null;
        setLoadingTabs((prev) => ({
          ...prev,
          [activeTabId]: false,
          [targetTabId]: false,
        }));
      }
    },
    [
      selectTabOrRestoreAgentSurface,
      setActiveTabId,
      t,
      trackHistorySessionOpen,
    ],
  );

  // Clear initialMessage from a tab after it has been consumed by Chat
  const clearInitialMessage = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, initialMessage: undefined } : t,
      ),
    );
  }, []);

  // Called by Chat after it has adopted a joined sidecar's config. Move the tab to
  // 'push' so the user's SUBSEQUENT in-tab edits push to the sidecar normally (the
  // adoption is one-shot). Push effects don't replay on adopt→push because they key
  // on the `configPending` boolean, which stays false across this transition.
  const markSidecarConfigAdopted = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, sidecarConfigDisposition: "push" } : t,
      ),
    );
  }, []);

  const handleFilePreviewIntentConsumed = useCallback(
    (tabId: string, intentId: string) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId && t.pendingFilePreview?.id === intentId
            ? { ...t, pendingFilePreview: undefined }
            : t,
        ),
      );
    },
    [],
  );

  // Rename session: update tab title + persist to backend + notify listeners
  const handleRenameSession = useCallback(
    (tabId: string, newTitle: string) => {
      updateTabTitle(tabId, newTitle);
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (tab?.sessionId) {
        updateSession(tab.sessionId, { title: newTitle, titleSource: "user" })
          .then(() =>
            window.dispatchEvent(
              new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED),
            ),
          )
          .catch((err) =>
            console.error("[App] Failed to persist renamed title:", err),
          );
      }
    },
    [updateTabTitle],
  );

  /**
   * Handle fork session: create a new tab for the forked session.
   * Called from Chat after the backend has created the forked session metadata + messages.
   */
  const handleForkSession = useCallback(
    async (
      _tabId: string,
      newSessionId: string,
      forkAgentDir: string,
      title: string,
      initialMessage?: string,
    ) => {
      // Check tab limit
      if (getChromeTabCount(tabsRef.current) >= MAX_TABS) {
        toastRef.current.error(t("appChrome.tabLimitReached"));
        return false;
      }

      const newTab: Tab = {
        id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        agentDir: forkAgentDir,
        sessionId: newSessionId,
        view: "chat",
        title,
        // Fork mints a brand-new session id → fresh sidecar (no concurrent creator
        // can target it) → 'push'. The post-ensure step below confirms it.
        sidecarConfigDisposition: "push",
        ...(initialMessage ? { initialMessage: { text: initialMessage } } : {}),
      };

      setTabs((prev) => [...prev, newTab]);
      setLoadingTabs((prev) => ({ ...prev, [newTab.id]: true }));

      let ownerAcquired = false;
      try {
        const result = await ensureSessionSidecar(
          newSessionId,
          forkAgentDir,
          "tab",
          newTab.id,
        );
        ownerAcquired = true;
        console.log(
          `[App] Fork tab ${newTab.id} sidecar ensured: port=${result.port}`,
        );
        if (!tabsRef.current.some((t) => t.id === newTab.id)) {
          await releaseTabSession(newSessionId, newTab.id).catch(() => {});
          return false;
        }
        await activateSession(
          newSessionId,
          newTab.id,
          null,
          result.port,
          forkAgentDir,
          false,
        );
        setActiveTabId(newTab.id);
        return true;
      } catch (error) {
        console.error(
          "[App] Failed to start sidecar for forked session:",
          error,
        );
        setTabs((prev) => prev.filter((t) => t.id !== newTab.id));
        if (ownerAcquired) {
          await releaseTabSession(newSessionId, newTab.id).catch(() => {});
        }
        return false;
      } finally {
        setLoadingTabs((prev) => ({ ...prev, [newTab.id]: false }));
      }
    },
    [setActiveTabId, t],
  );

  /**
   * Spawn a fresh Tab bound to an EXISTING session, ensure its sidecar, and
   * register the Tab as an owner. Shared by "在新 tab 打开" (history dropdown)
   * and the cross-runtime auto-new-tab path in handleSwitchSession (Scenario
   * 1.5). Returns false (after a toast) when the tab cap is hit. Stable
   * identity ([] deps — only touches stable setters/refs/imports) so callers
   * that must stay reference-stable (handleSwitchSession) can depend on it.
   *
   * `preserveCronActivation`: when the target session is owned by a running
   * cron task, the new Tab must be added via `updateSessionTab` (which keeps
   * the activation record's `task_id` intact) rather than `activateSession`
   * (which inserts a fresh `{task_id: null}` record and breaks cron ownership
   * — the exact pitfall documented in planSessionOpen, mirrored from
   * handleSwitchSession Scenario 2).
   */
  const spawnTabForExistingSession = useCallback(
    async (
      sessionId: string,
      sessionAgentDir: string,
      title: string,
      opts?: {
        preserveCronActivation?: boolean;
        pendingFilePreview?: FilePreviewIntent;
      },
    ): Promise<boolean> => {
      if (getChromeTabCount(tabsRef.current) >= MAX_TABS) {
        toastRef.current.error(t("appChrome.tabLimitReached"));
        return false;
      }
      const newTab: Tab = {
        ...createNewTab(),
        agentDir: sessionAgentDir,
        sessionId,
        view: "chat",
        title,
        ...(opts?.pendingFilePreview
          ? { pendingFilePreview: opts.pendingFilePreview }
          : {}),
        // Existing session pre-mounted before ensure → 'pending'; the post-ensure
        // step below resolves push|adopt from result.isNew (no stomp on a join).
        sidecarConfigDisposition: "pending",
      };
      setTabs((prev) => [...prev, newTab]);
      setLoadingTabs((prev) => ({ ...prev, [newTab.id]: true }));
      let ownerAcquired = false;
      try {
        const result = await ensureSessionSidecar(
          sessionId,
          sessionAgentDir,
          "tab",
          newTab.id,
        );
        ownerAcquired = true;
        // The sidecar spawn above is the widest await window; if the user closed
        // this loading tab during it, don't activate a dead tab or point
        // activeTabId at a non-existent one. Release the owner we just acquired
        // (the close handler's release may have raced ahead and found none) and
        // bail before any activation/state commit.
        if (!tabsRef.current.some((t) => t.id === newTab.id)) {
          await releaseTabSession(sessionId, newTab.id).catch(() => {});
          return false;
        }
        if (opts?.preserveCronActivation) {
          // Cron-owned session: add this Tab as an additional owner without
          // replacing the activation record, so the cron `task_id` survives.
          await updateSessionTab(sessionId, newTab.id);
        } else {
          // Plain/background session: cancel any background completion AFTER the
          // Tab is an owner (order matters — releasing BG as the last owner would
          // stop the sidecar mid-stream; see handleLaunchProject), then activate.
          await cancelBackgroundCompletion(sessionId);
          await activateSession(
            sessionId,
            newTab.id,
            null,
            result.port,
            sessionAgentDir,
            false,
          );
        }
        setTabs((prev) =>
          prev.map((t) =>
            t.id === newTab.id
              ? {
                  ...t,
                  sidecarConfigDisposition: result.isNew ? "push" : "adopt",
                }
              : t,
          ),
        );
        setActiveTabId(newTab.id);
        return true;
      } catch (error) {
        console.error("[App] Failed to open session in new tab:", error);
        setTabs((prev) => prev.filter((t) => t.id !== newTab.id));
        // Release the Tab owner we acquired so a failed activation can't leak a
        // phantom owner that keeps the (possibly otherwise-ownerless) sidecar
        // alive forever.
        if (ownerAcquired) {
          await releaseTabSession(sessionId, newTab.id).catch(() => {});
        }
        return false;
      } finally {
        setLoadingTabs((prev) => ({ ...prev, [newTab.id]: false }));
      }
    },
    [setActiveTabId, t],
  );

  // Per-session in-flight guard for open-in-new-tab. Without it, a rapid
  // double-click both observe a `tabsRef.current` that doesn't yet reflect the
  // first `setTabs`, so planSessionOpen returns non-jump twice → two tabs for
  // one session (violates Session:Tab 1:1, can exceed MAX_TABS).
  const openingInNewTabRef = useRef<Set<string>>(new Set());

  /**
   * Open a history session in a NEW tab (vs. handleSwitchSession which reuses
   * the current tab). If the session is already open in a tab, jump to it
   * instead of spawning a duplicate — Session:Tab is 1:1, so two tabs owning
   * one sidecar would fight over it (mirrors handleSwitchSession's fast path).
   * The real activation is fetched (not hard-coded null) so a cron-owned
   * session routes through the activation-preserving attach path.
   */
  const handleOpenSessionInNewTab = useCallback(
    async (
      tabId: string,
      sessionId: string,
      title: string,
      historyEntrySource: HistoryEntrySource = "chat_dropdown_new_tab",
    ) => {
      if (openingInNewTabRef.current.has(sessionId)) return;
      openingInNewTabRef.current.add(sessionId);
      try {
        const sourceTab = tabsRef.current.find((t) => t.id === tabId);
        const sessionAgentDir = sourceTab?.agentDir;
        if (!sessionAgentDir) {
          console.error(
            "[App] Cannot open session in new tab: source tab has no agentDir",
          );
          return;
        }
        trackHistorySessionOpenAsync(
          sessionId,
          sessionAgentDir,
          historyEntrySource,
        );

        const activation = await getSessionActivation(sessionId);
        const plan = planSessionOpen({
          tabs: tabsRef.current,
          targetSessionId: sessionId,
          multiAgentRuntime: false,
          targetActivation: activation,
          currentSessionHasPersistentOwners: false,
        });
        if (plan.type === "jump-to-tab") {
          console.log(
            `[App] handleOpenSessionInNewTab: Session ${sessionId} already in tab ${plan.tabId}, jumping to it`,
          );
          selectTabOrRestoreAgentSurface(plan.tabId);
          return;
        }
        await spawnTabForExistingSession(
          sessionId,
          sessionAgentDir,
          title || getFolderName(sessionAgentDir),
          {
            preserveCronActivation: plan.type === "attach-existing-sidecar",
          },
        );
      } finally {
        openingInNewTabRef.current.delete(sessionId);
      }
    },
    [
      selectTabOrRestoreAgentSurface,
      spawnTabForExistingSession,
      trackHistorySessionOpenAsync,
    ],
  );

  /**
   * Handle session switch from within Chat (history dropdown)
   * Implements Session singleton with all 4 scenarios
   */
  const handleSwitchSession = useCallback(
    async (
      tabId: string,
      sessionId: string,
      historyEntrySource: HistoryEntrySource = "chat_dropdown",
    ) => {
      const tabsSnapshot = tabsRef.current;
      const currentTab = tabsSnapshot.find((t) => t.id === tabId);
      if (currentTab?.agentDir) {
        trackHistorySessionOpenAsync(
          sessionId,
          currentTab.agentDir,
          historyEntrySource,
        );
      }

      // Fast path: Session already open in a Tab → Jump to that Tab.
      // Skip the ~100ms of runtime/activation/cron IO below if we already know we're
      // jumping. Hard-coded inputs (`multiAgentRuntime: false`, no activation, no cron
      // running) ensure this call can only return `jump-to-tab` (when an existing
      // tab matches) or `switch-current-tab` (otherwise). The `switch-current-tab`
      // result is intentionally ignored — the full re-plan below uses real values.
      const jumpPlan = planSessionOpen({
        tabs: tabsSnapshot,
        targetSessionId: sessionId,
        multiAgentRuntime: false,
        targetActivation: null,
        currentSessionHasPersistentOwners: false,
      });
      if (jumpPlan.type === "jump-to-tab") {
        console.log(
          `[App] handleSwitchSession Scenario 1: Session ${sessionId} already in tab ${jumpPlan.tabId}, jumping to it`,
        );
        selectTabOrRestoreAgentSurface(jumpPlan.tabId);
        return;
      }

      const cfg = configRef.current;
      const currentAgentRuntime = currentTab?.agentDir
        ? normalizeRuntime(
            getAgentByWorkspacePath(cfg, currentTab.agentDir)?.runtime,
          )
        : "builtin";

      const [
        targetRuntimeIdentity,
        resolvedCurrentRuntimeIdentity,
        activation,
        currentSessionHasPersistentOwners,
      ] = await Promise.all([
        resolveSessionRuntimeIdentityForOpen(
          sessionId,
          currentAgentRuntime,
          cfg?.multiAgentRuntime,
        ),
        resolveSessionRuntimeIdentityForOpen(
          currentTab?.sessionId,
          currentAgentRuntime,
          cfg?.multiAgentRuntime,
        ),
        getSessionActivation(sessionId),
        currentTab?.sessionId
          ? sessionHasPersistentOwners(currentTab.sessionId)
          : Promise.resolve(false),
      ]);
      const targetRuntime = targetRuntimeIdentity.runtime;
      const resolvedCurrentRuntime = resolvedCurrentRuntimeIdentity.runtime;
      // When the current Tab has no session yet (fresh chat), there's no "current
      // session runtime" to compare against — treat target's runtime as current,
      // so cross-runtime check doesn't false-positive on an empty Tab. Mirrors
      // handleLaunchProject's identical guard.
      const currentRuntime = currentTab?.sessionId
        ? resolvedCurrentRuntime
        : targetRuntime;

      const plan = planSessionOpen({
        tabs: tabsRef.current,
        targetSessionId: sessionId,
        multiAgentRuntime: !!cfg?.multiAgentRuntime,
        currentRuntime,
        targetRuntime,
        currentRuntimeIdentity: currentTab?.sessionId
          ? resolvedCurrentRuntimeIdentity
          : targetRuntimeIdentity,
        targetRuntimeIdentity,
        targetActivation: activation,
        currentSessionHasPersistentOwners,
      });
      const canHotSwapCurrentSidecar = canHotSwapSessionSidecar({
        currentRuntime,
        targetRuntime,
        currentRuntimeIdentity: currentTab?.sessionId
          ? resolvedCurrentRuntimeIdentity
          : targetRuntimeIdentity,
        targetRuntimeIdentity,
      });

      if (plan.type === "jump-to-tab") {
        console.log(
          `[App] handleSwitchSession Scenario 1: Session ${sessionId} already in tab ${plan.tabId}, jumping to it`,
        );
        selectTabOrRestoreAgentSurface(plan.tabId);
        return;
      }

      // Scenario 1.5 (T12): Cross-runtime session → Open in NEW Tab.
      // The comparison is session-vs-session, not target session-vs-current agent:
      // an existing tab's sidecar belongs to the session it already loaded, while
      // the agent runtime is only the template for future sessions.
      if (plan.type === "open-new-tab" && plan.reason === "runtime-mismatch") {
        console.log(
          `[App] handleSwitchSession Scenario 1.5: Cross-runtime session (session=${plan.targetRuntime}, current=${plan.currentRuntime}), opening in new tab`,
        );
        if (!currentTab?.agentDir) {
          console.error("[App] Cannot switch: current tab has no agentDir");
          return;
        }
        await spawnTabForExistingSession(
          sessionId,
          currentTab.agentDir,
          currentTab.title || getFolderName(currentTab.agentDir),
        );
        return;
      }

      // Scenario 2: Session has running cron task (no Tab) → Add Tab as owner to existing Sidecar
      if (plan.type === "attach-existing-sidecar") {
        console.log(
          `[App] handleSwitchSession Scenario 2: Session ${sessionId} has cron task ${plan.taskId}`,
        );

        // Get current tab info to find agentDir
        if (!currentTab?.agentDir) {
          console.error("[App] Cannot switch: current tab has no agentDir");
          return;
        }

        const oldSessionId = currentTab.sessionId;
        // Capture narrowed agentDir post-guard for use across await boundaries.
        const tabAgentDir: string = currentTab.agentDir;

        try {
          // Step 1: Add Tab as owner to the cron task's Sidecar FIRST
          const result = await ensureSessionSidecar(
            sessionId,
            currentTab.agentDir,
            "tab",
            tabId,
          );
          console.log(
            `[App] Tab ${tabId} added as owner to session ${sessionId} Sidecar on port ${result.port}`,
          );
          await updateSessionTab(sessionId, tabId);

          // Step 2: Stop SSE proxy FIRST before releasing old session (avoids EOF errors)
          if (oldSessionId) {
            await stopSseProxy(tabId);
            const stopped = await releaseTabSession(oldSessionId, tabId);
            console.log(
              `[App] Released old session ${oldSessionId}, sidecar stopped: ${stopped}`,
            );
          }

          // Step 3: Update UI state (TabProvider will reconnect SSE to new Sidecar)
          //
          // Race-defensive: same reasoning as Scenario 4's setTabs — the
          // `await releaseTabSession(oldSessionId, …)` above may trigger a
          // `session:sidecar-terminal` whose listener resets this tab to
          // launcher view before our setTabs runs. Explicit `view: 'chat'`,
          // `agentDir`, and `title` make this setTabs the authoritative final
          // state. (Same workspace as before — currentTab.agentDir captured
          // pre-await is stable across the switch.)
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    sessionId,
                    sidecarConfigDisposition: result.isNew ? "push" : "adopt",
                    view: "chat",
                    agentDir: tabAgentDir,
                    title: currentTab.title || getFolderName(tabAgentDir),
                  }
                : t,
            ),
          );
        } catch (error) {
          console.error("[App] Failed to switch to cron task session:", error);
        }
        return;
      }

      // Scenario 3: Current Session has a persistent owner → Create new Tab + new Sidecar
      if (
        plan.type === "open-new-tab" &&
        plan.reason === "current-persistent-owner"
      ) {
        console.log(
          `[App] handleSwitchSession Scenario 3: Current session ${currentTab?.sessionId} has persistent owners, creating new tab`,
        );

        // Check max tabs limit
        if (getChromeTabCount(tabsRef.current) >= MAX_TABS) {
          console.warn("[App] Cannot create new tab: max tabs reached");
          return;
        }

        // Get agentDir from current tab
        const currentTabForScenario3 = tabsRef.current.find(
          (t) => t.id === tabId,
        );
        if (!currentTabForScenario3?.agentDir) {
          console.error("[App] Cannot switch: current tab has no agentDir");
          return;
        }

        // Create new tab
        const newTab = createNewTab();
        setTabs((prev) => [...prev, newTab]);
        setLoadingTabs((prev) => ({ ...prev, [newTab.id]: true }));

        try {
          // Ensure Sidecar for new Tab as owner of this Session
          const result = await ensureSessionSidecar(
            sessionId,
            currentTabForScenario3.agentDir,
            "tab",
            newTab.id,
          );
          console.log(
            `[App] New tab ${newTab.id} Sidecar ensured: port=${result.port}, isNew=${result.isNew}`,
          );

          // Update new tab state
          setTabs((prev) =>
            prev.map((t) =>
              t.id === newTab.id
                ? {
                    ...t,
                    agentDir: currentTabForScenario3.agentDir,
                    sessionId,
                    view: "chat",
                    title:
                      currentTabForScenario3.title ||
                      getFolderName(currentTabForScenario3.agentDir ?? ""),
                    sidecarConfigDisposition: result.isNew ? "push" : "adopt",
                  }
                : t,
            ),
          );

          // Jump to new tab
          setActiveTabId(newTab.id);
          console.log(
            `[App] handleSwitchSession Scenario 3: Created new tab ${newTab.id} for session ${sessionId}`,
          );
        } catch (error) {
          console.error("[App] Failed to ensure Sidecar for new tab:", error);
          // Remove the failed tab
          setTabs((prev) => prev.filter((t) => t.id !== newTab.id));
        } finally {
          setLoadingTabs((prev) => ({ ...prev, [newTab.id]: false }));
        }
        return;
      }

      // Scenario 4: Normal switch
      //
      // Two sub-paths:
      // A) AI is idle → hot-swap Sidecar via upgradeSessionId (no new process)
      // B) AI is running → start background completion for old session,
      //    release Tab from old Sidecar, create new Sidecar for new session
      console.log(
        `[App] handleSwitchSession Scenario 4: Switching tab ${tabId} to session ${sessionId}`,
      );

      // Get current tab info
      const currentTabForScenario4 = tabsRef.current.find(
        (t) => t.id === tabId,
      );
      if (!currentTabForScenario4?.agentDir) {
        console.error("[App] Cannot switch: current tab has no agentDir");
        return;
      }

      const oldSessionId = currentTabForScenario4.sessionId;
      // Capture narrowed agentDir post-guard. TS loses the narrowing across the
      // many `await` boundaries below, so we re-narrow once here.
      const tabAgentDir: string = currentTabForScenario4.agentDir;

      try {
        // NOTE: cancelBackgroundCompletion is deliberately deferred to AFTER all
        // ensure-and-activate paths below. If we cancel BG here while it's the
        // last owner of the target session's sidecar, the sidecar stops, the SDK
        // subprocess dies, and any in-flight streaming turn (with thinking,
        // tool_use blocks, and pending text) never gets persisted to disk —
        // resume from history then loads only the messages saved before the
        // turn started. The fix is to register Tab as an owner first via
        // ensureSessionSidecar, then release BG safely.

        // Track whether Tab is joining a pre-existing sidecar (e.g. IM Bot session)
        // to skip automatic config sync in Chat.tsx mount
        let joinedExisting = false;

        if (oldSessionId) {
          // Check if AI is running on old session → background completion
          const bgResult = await startBackgroundCompletion(oldSessionId);

          if (bgResult.started) {
            // AI is running → old Sidecar stays alive via BG owner, create new Sidecar for target
            console.log(
              `[App] AI running on ${oldSessionId}, starting background completion`,
            );
            await stopSseProxy(tabId);
            await releaseTabSession(oldSessionId, tabId);

            // Create/reuse Sidecar for the target session
            const result = await ensureSessionSidecar(
              sessionId,
              currentTabForScenario4.agentDir,
              "tab",
              tabId,
            );
            await activateSession(
              sessionId,
              tabId,
              null,
              result.port,
              currentTabForScenario4.agentDir,
              false,
            );
            joinedExisting = !result.isNew;
            console.log(
              `[App] Created new Sidecar for session ${sessionId} on port ${result.port}`,
            );
          } else {
            // AI is idle → check if target session already has a sidecar (e.g., from BG completion)
            // If yes, we can't use upgradeSessionId — it would overwrite the existing sidecar
            const targetHasSidecar = await hasSessionSidecar(sessionId);

            if (targetHasSidecar) {
              // Target session has existing sidecar → release current, reconnect to existing
              console.log(
                `[App] Target session ${sessionId} has existing sidecar, reconnecting`,
              );
              await stopSseProxy(tabId);
              await releaseTabSession(oldSessionId, tabId);
              const result = await ensureSessionSidecar(
                sessionId,
                currentTabForScenario4.agentDir,
                "tab",
                tabId,
              );
              await activateSession(
                sessionId,
                tabId,
                null,
                result.port,
                currentTabForScenario4.agentDir,
                false,
              );
              joinedExisting = !result.isNew;
            } else if (!canHotSwapCurrentSidecar) {
              // Rust `upgradeSessionId` is only an identity rename. It does not
              // call the Node sidecar's `/sessions/switch`, so external runtimes
              // would keep the old Codex/Gemini process and transcript owner under
              // a new Rust key. For external histories, switch to a target-owned
              // sidecar instead; the sidecar boot/restore path seeds runtimeSessionId
              // and the append-only transcript from the target session.
              console.log(
                `[App] External runtime session switch (${resolvedCurrentRuntime} -> ${targetRuntime}); replacing sidecar instead of upgradeSessionId`,
              );
              await stopSseProxy(tabId);
              await releaseTabSession(oldSessionId, tabId);
              const result = await ensureSessionSidecar(
                sessionId,
                tabAgentDir,
                "tab",
                tabId,
              );
              await activateSession(
                sessionId,
                tabId,
                null,
                result.port,
                tabAgentDir,
                false,
              );
              joinedExisting = !result.isNew;
            } else {
              // No existing sidecar for target → hot-swap via upgradeSessionId (efficient, no new process)
              const upgraded = await upgradeSessionId(oldSessionId, sessionId);

              if (upgraded) {
                const port = await getSessionPort(sessionId);
                if (port !== null) {
                  await activateSession(
                    sessionId,
                    tabId,
                    null,
                    port,
                    currentTabForScenario4.agentDir,
                    false,
                  );
                  console.log(
                    `[App] Session ${sessionId} took over Sidecar from ${oldSessionId} on port ${port}`,
                  );
                  // upgradeSessionId: Tab already owned this sidecar → joinedExisting stays false
                } else {
                  console.warn(
                    `[App] Port not found after upgrade, creating new Sidecar`,
                  );
                  const result = await ensureSessionSidecar(
                    sessionId,
                    currentTabForScenario4.agentDir,
                    "tab",
                    tabId,
                  );
                  await activateSession(
                    sessionId,
                    tabId,
                    null,
                    result.port,
                    currentTabForScenario4.agentDir,
                    false,
                  );
                  joinedExisting = !result.isNew;
                }
              } else {
                console.log(
                  `[App] Sidecar upgrade failed, creating new Sidecar for session ${sessionId}`,
                );
                await releaseTabSession(oldSessionId, tabId);
                const result = await ensureSessionSidecar(
                  sessionId,
                  currentTabForScenario4.agentDir,
                  "tab",
                  tabId,
                );
                await activateSession(
                  sessionId,
                  tabId,
                  null,
                  result.port,
                  currentTabForScenario4.agentDir,
                  false,
                );
                joinedExisting = !result.isNew;
              }
            }
          }
        } else {
          // No old Session → Create new Sidecar
          console.log(
            `[App] No previous session, creating new Sidecar for session ${sessionId}`,
          );
          const result = await ensureSessionSidecar(
            sessionId,
            currentTabForScenario4.agentDir,
            "tab",
            tabId,
          );
          await activateSession(
            sessionId,
            tabId,
            null,
            result.port,
            currentTabForScenario4.agentDir,
            false,
          );
          joinedExisting = !result.isNew;
        }

        // Tab is now an owner of the target session's sidecar (via every
        // ensureSessionSidecar branch above). Safe to cancel any BG completion
        // now — releasing the BG owner with Tab still attached keeps the sidecar
        // alive and the streaming turn intact.
        await cancelBackgroundCompletion(sessionId);

        // Update UI state - TabProvider will detect sessionId change and call loadSession()
        //
        // Race-defensive set: explicitly carry `view: 'chat'`, `agentDir`, and
        // `title` because the `await releaseTabSession(oldSessionId, …)`
        // above may have caused Rust to drop the old sidecar (when the Tab
        // was its last owner — common for IM-bot sessions opened in a desktop
        // tab whose heartbeat owner has already moved on). That drop fires
        // `session:sidecar-terminal` for `oldSessionId`, whose listener
        // (`applyTerminalSessionToTabs`) sees a tab still pointing at the old
        // id (we haven't called this setTabs yet) and resets it to launcher
        // (sets view='launcher', sessionId=null, agentDir=null, title='New Tab').
        // If we only patched `sessionId` here the launcher fields would
        // linger via `...t` and the user would land on launcher with the new
        // sessionId attached — exactly the "click history → bounced to
        // launcher" symptom. Explicit fields make this setTabs the source of
        // truth for the post-switch tab state. (The proper title arrives
        // shortly via TabProvider.loadSession → updateTabTitle; preserving
        // the pre-switch title here avoids a transient "New Tab" flash for
        // sessions whose stored title is empty.)
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  sessionId,
                  sidecarConfigDisposition: joinedExisting ? "adopt" : "push",
                  view: "chat",
                  agentDir: tabAgentDir,
                  title:
                    currentTabForScenario4.title || getFolderName(tabAgentDir),
                }
              : t,
          ),
        );
        console.log(
          `[App] handleSwitchSession Scenario 4 complete: tab ${tabId} now on session ${sessionId}`,
        );
      } catch (error) {
        console.error("[App] Failed to switch session:", error);
      }
      // spawnTabForExistingSession has stable identity ([] deps), so listing it
      // keeps exhaustive-deps happy without changing handleSwitchSession's own
      // stability (callers rely on this being reference-stable).
    },
    [
      selectTabOrRestoreAgentSurface,
      setActiveTabId,
      spawnTabForExistingSession,
      trackHistorySessionOpenAsync,
    ],
  );

  const handleBackToLauncher = useCallback(
    async (tabId: string) => {
      if (!tabId) return;

      // Get current tab to access sessionId
      const currentTab = tabsRef.current.find((t) => t.id === tabId);
      if (currentTab && isWorkbenchAgentSurfaceTab(currentTab)) {
        performCloseTab(tabId);
        return;
      }

      // Step 1: Try to start background completion if AI is running
      if (currentTab?.sessionId) {
        const bgResult = await startBackgroundCompletion(currentTab.sessionId);
        if (bgResult.started) {
          console.log(
            `[App] Back to launcher: AI still running, background completion started for session ${currentTab.sessionId}`,
          );
        }
      }

      // Step 2: Stop SSE proxy FIRST to avoid EOF errors when Sidecar stops
      await stopSseProxy(tabId);

      // Step 3: Release Tab's ownership of the Session Sidecar
      // If BackgroundCompletion or Task also owns it, Sidecar continues running
      if (currentTab?.sessionId) {
        try {
          const stopped = await releaseTabSession(currentTab.sessionId, tabId);
          console.log(
            `[App] Tab ${tabId} released session ${currentTab.sessionId}, sidecar stopped: ${stopped}`,
          );
        } catch (error) {
          console.error(
            `[App] Error releasing session sidecar for tab ${tabId}:`,
            error,
          );
          // Fallback to legacy stopTabSidecar
          void stopTabSidecar(tabId);
        }
      }

      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                agentDir: null,
                sessionId: null,
                view: "launcher",
                title: "New Tab",
                sidecarConfigDisposition: "push",
              }
            : t,
        ),
      );
    },
    [performCloseTab],
  );

  /**
   * Handle "New Session" from Chat component.
   * If AI is running, starts background completion on old session and creates new Sidecar.
   * Returns true if handled (Chat should NOT call resetSession), false if AI is idle (Chat falls back to resetSession).
   */
  const handleNewSession = useCallback(
    async (tabId: string): Promise<boolean> => {
      const currentTab = tabsRef.current.find((t) => t.id === tabId);
      if (!currentTab?.sessionId || !currentTab?.agentDir) {
        return false;
      }

      const oldSessionId = currentTab.sessionId;

      // Check if AI is running → start background completion
      const bgResult = await startBackgroundCompletion(oldSessionId);
      if (!bgResult.started) {
        // AI is idle → let Chat handle it via resetSession (more efficient, reuses Sidecar)
        return false;
      }

      // AI is running → release old Sidecar (BG owner keeps it alive), create new one
      console.log(
        `[App] handleNewSession: AI running on ${oldSessionId}, background completion started`,
      );

      try {
        await stopSseProxy(tabId);
        await releaseTabSession(oldSessionId, tabId);

        // PRD 0.2.19 cross-review fix (B4): mark the upcoming session_new as
        // 'new_chat_button' provenance. handleNewSession is the AI-running variant
        // of resetSession (user clicked "新对话" while AI was still streaming) —
        // without this, chat:system-init would fall back to 'launcher_input' and
        // silently misclassify all AI-running new-session opens.
        setPendingSessionBirth(
          tabId,
          birthContextForSurface("new_chat_button"),
        );

        // Create new pending session with new Sidecar
        const pendingSessionId = createPendingSessionId(tabId);
        const result = await ensureSessionSidecar(
          pendingSessionId,
          currentTab.agentDir,
          "tab",
          tabId,
        );
        await activateSession(
          pendingSessionId,
          tabId,
          null,
          result.port,
          currentTab.agentDir,
          false,
        );

        // Update tab state → TabProvider will detect sessionId change and reconnect
        // Fresh sidecar for the new session → 'push' (overwrites any stale disposition)
        // on the new session (e.g. user clicks "New Session" while still in IM Bot adoption window)
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  sessionId: pendingSessionId,
                  sidecarConfigDisposition: "push",
                }
              : t,
          ),
        );
        const fbResult = await migrateFloatingBallSessionBinding(
          oldSessionId,
          pendingSessionId,
        );
        if (fbResult.migrated) {
          console.log(
            `[App] Floating ball session binding migrated to pending session: ${oldSessionId} -> ${pendingSessionId}, notified=${fbResult.notified}`,
          );
        }
        console.log(
          `[App] handleNewSession: Created new Sidecar for pending session ${pendingSessionId} on port ${result.port}`,
        );
        return true;
      } catch (error) {
        console.error("[App] handleNewSession failed:", error);
        return false;
      }
    },
    [],
  );

  // ---- Restored-tab activation (Issue #232) ---------------------------------
  // A cold restored tab carries a real sessionId/agentDir but has NO sidecar and
  // does NOT mount TabProvider (see MemoizedTabContent). The first time one
  // becomes active we lazily validate it still exists on disk, ensure its
  // sidecar + activate it, then clear `restoreState` so TabProvider mounts and
  // runs its normal SSE/loadSession flow. Dedup guard prevents the startup
  // auto-activation and a near-simultaneous user click from double-spawning.
  const restoreActivationInFlight = useRef<Set<string>>(new Set());

  // Remove a restored tab that can no longer be activated (deleted session or
  // missing/moved workspace). Always keeps ≥1 tab and re-points activeTabId.
  // Decisions are computed from the current committed list BEFORE the state
  // updates so we never call setActiveTabId inside the setTabs updater (which
  // would be a side-effecting, StrictMode-double-invoke-unsafe updater).
  const dropRestoredTab = useCallback(
    (tabId: string) => {
      const remaining = tabsRef.current.filter((t) => t.id !== tabId);
      if (remaining.length === 0) {
        // Last tab gone → replace with a fresh launcher (never leave 0 tabs).
        const fresh = createNewTab();
        setTabs([fresh]);
        setActiveTabId(fresh.id);
        return;
      }
      setTabs((prev) => prev.filter((t) => t.id !== tabId));
      setActiveTabId((curr) =>
        curr === tabId ? remaining[remaining.length - 1].id : curr,
      );
    },
    [setActiveTabId],
  );

  // Attach an already-on-disk session to a tab WITHOUT going through
  // planSessionOpen — the planner would see the tab already holds this
  // sessionId and return `jump-to-tab`, self-jumping and never ensuring a
  // sidecar (handleLaunchProject's early return at the jump branch). This is the
  // minimal ensure→register path for a tab that owns no prior session.
  const attachSessionToTab = useCallback(
    async (
      tabId: string,
      sessionId: string,
      agentDir: string,
    ): Promise<{ joinedExisting: boolean }> => {
      const result = await ensureSessionSidecar(
        sessionId,
        agentDir,
        "tab",
        tabId,
      );
      const activation = result.isNew
        ? null
        : await getSessionActivation(sessionId);
      if (activation?.task_id) {
        // Cron-owned session: add this Tab without replacing the activation
        // record, otherwise the cron task_id is lost and later owner cleanup can
        // misclassify the session.
        await updateSessionTab(sessionId, tabId);
      } else {
        await activateSession(
          sessionId,
          tabId,
          null,
          result.port,
          agentDir,
          false,
        );
      }
      // Tab now owns the sidecar — safe to release any background-completion
      // owner that may have kept it warm.
      await cancelBackgroundCompletion(sessionId);
      return { joinedExisting: !result.isNew };
    },
    [],
  );

  // Release a sidecar owner we acquired during a restore activation that was
  // then abandoned (tab closed/switched mid-flight) or that threw partway.
  // Idempotent — releaseTabSession no-ops for an unknown owner/session, so it
  // is safe even if the owner was never registered or already
  // released by performCloseTab.
  const releaseAbandonedRestore = useCallback(
    async (sessionId: string, tabId: string) => {
      try {
        await releaseTabSession(sessionId, tabId);
      } catch (err) {
        console.error(
          `[App] Error releasing abandoned restore for ${sessionId}:`,
          err,
        );
      }
    },
    [],
  );

  const activateRestoredTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || tab.restoreState !== "cold") return;
      if (!tab.agentDir || !tab.sessionId) {
        dropRestoredTab(tabId);
        return;
      }
      if (restoreActivationInFlight.current.has(tabId)) return;
      restoreActivationInFlight.current.add(tabId);
      const { sessionId, agentDir } = tab;
      try {
        // Lazy validation, decoupled from global sidecar readiness: reads
        // sessions.json + workspace dir directly via Rust.
        const ok = await canRestoreSession(sessionId, agentDir);
        // If the user closed/switched the tab during validation, bail before
        // acquiring any sidecar (nothing to release yet).
        if (
          isRestoreAbandoned(
            tabsRef.current.find((t) => t.id === tabId),
            sessionId,
            agentDir,
          )
        )
          return;
        if (!ok) {
          console.warn(
            `[App] Restored tab ${tabId}: session ${sessionId} or workspace gone, dropping`,
          );
          dropRestoredTab(tabId);
          return;
        }
        const { joinedExisting } = await attachSessionToTab(
          tabId,
          sessionId,
          agentDir,
        );
        // attachSessionToTab registered Tab(tabId) as a sidecar owner. If the
        // user closed/switched the tab while we were ensuring the sidecar,
        // performCloseTab's release ran BEFORE our owner existed (no-op) → we
        // now hold an orphan. Release it ourselves rather than leak it.
        if (
          isRestoreAbandoned(
            tabsRef.current.find((t) => t.id === tabId),
            sessionId,
            agentDir,
          )
        ) {
          await releaseAbandonedRestore(sessionId, tabId);
          return;
        }
        // Clear restoreState → MemoizedTabContent mounts TabProvider, which
        // connects SSE and loadSession()s the history from JSONL.
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  restoreState: undefined,
                  sidecarConfigDisposition: joinedExisting ? "adopt" : "push",
                }
              : t,
          ),
        );
      } catch (err) {
        console.error(`[App] Failed to activate restored tab ${tabId}:`, err);
        // ensureSessionSidecar may have registered the owner before a later
        // await threw — release defensively so a partial acquisition can't leak.
        await releaseAbandonedRestore(sessionId, tabId);
        dropRestoredTab(tabId);
      } finally {
        restoreActivationInFlight.current.delete(tabId);
      }
    },
    [attachSessionToTab, dropRestoredTab, releaseAbandonedRestore],
  );

  const handleSelectTab = useCallback(
    (tabId: string) => {
      selectTabOrRestoreAgentSurface(tabId);
    },
    [selectTabOrRestoreAgentSurface],
  );

  // Activate a restored cold tab whenever it becomes active — via ANY path
  // (click, Cmd+Tab/Cmd+1-9, swipe, session jump, or the initial active tab on
  // startup). Centralizing on `activeTabId` rather than each switch handler is
  // pit-of-success: no activation path can forget to wake a restored tab, and
  // only the active tab spawns a sidecar at boot (the rest stay cold). The
  // in-flight guard + post-activation `restoreState` clear make it idempotent.
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.restoreState === "cold") {
      void activateRestoredTab(activeTabId);
    }
  }, [activeTabId, tabs, activateRestoredTab]);

  // Clear unread indicator only when the active tab identity changes. Do not key
  // this effect on `tabs`: a hidden-but-active tab marks itself unread when a
  // turn completes, and clearing on that same tabs update erases the Dock/tray
  // badge before the user returns. Window focus still clears through
  // useTrayEvents.onWindowFocused.
  useEffect(() => {
    if (!activeTabId) {
      lastUnreadClearedActiveTabIdRef.current = null;
      return;
    }
    if (lastUnreadClearedActiveTabIdRef.current === activeTabId) return;
    lastUnreadClearedActiveTabIdRef.current = activeTabId;
    clearActiveTabUnread();
  }, [activeTabId, clearActiveTabUnread]);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeTabView = activeTab?.view ?? null;
  const activeChatSessionId =
    activeTab?.view === "chat" ? (activeTab.sessionId ?? null) : null;
  useEffect(() => {
    if (!activeChatSessionId || isPendingSessionId(activeChatSessionId)) return;
    acknowledgeNotificationTarget({
      type: "session",
      sessionId: activeChatSessionId,
    });
  }, [acknowledgeNotificationTarget, activeChatSessionId]);

  useEffect(() => {
    if (activeTabView === "taskcenter") {
      acknowledgeNotificationTarget({ type: "task-center" });
    }
  }, [acknowledgeNotificationTarget, activeTabView]);

  // Trackpad two-finger horizontal swipe to switch tabs (follow-along animation)
  useTabSwipeGesture({
    contentRef,
    tabsRef: chromeTabsRef,
    activeTabIdRef,
    onSwitchTab: handleSelectTab,
  });

  const handleCloseTab = useCallback((tabId: string) => {
    // Special case: If only one launcher tab, do nothing
    const currentTabs = tabsRef.current;
    const tab = currentTabs.find((t) => t.id === tabId);
    if (getChromeTabCount(currentTabs) === 1 && tab?.view === "launcher") {
      return;
    }

    void closeTabWithConfirmation(tabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, []);

  const handleNewTab = useCallback(() => {
    const currentLength = getChromeTabCount(tabsRef.current);
    if (currentLength >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab = createNewTab();
    openNewTabDeferred(newTab);

    // Track tab_new event
    track("tab_new", { tab_count: currentLength + 1 });
  }, [openNewTabDeferred]);

  // Handle tab reordering via drag and drop
  const handleReorderTabs = useCallback((activeId: string, overId: string) => {
    setTabs((prev) => {
      const oldIndex = prev.findIndex((t) => t.id === activeId);
      const newIndex = prev.findIndex((t) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  // Open Settings as a new tab (or switch to existing one)
  // Optional initialSection parameter to open a specific section (e.g., 'providers')
  // Optional initialSelect to open a specific item's detail (skill/command/agent)
  const handleOpenSettings = useCallback(
    async (
      initialSection?: string,
      mcpServerId?: string,
      initialSelect?: CapabilityInitialSelect,
      officialToolId?: OfficialToolId,
    ) => {
      // Track settings_open event
      track("settings_open", { section: initialSection ?? null });

      // Set initial section for Settings component
      setSettingsInitialSection(initialSection);
      setSettingsInitialMcpId(mcpServerId);
      setSettingsInitialOfficialToolId(officialToolId);
      setSettingsInitialSelect(initialSelect);

      // Check if there's already a Settings tab
      const currentTabs = tabsRef.current;
      const existingSettingsTab = currentTabs.find(
        (t) => t.view === "settings",
      );
      if (existingSettingsTab) {
        // Switch to existing Settings tab
        setActiveTabId(existingSettingsTab.id);
        return;
      }

      // Create new Settings tab
      if (getChromeTabCount(currentTabs) >= MAX_TABS) {
        console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
        return;
      }

      // Create Tab first (instant UI response). The 5.8k-line Settings subtree
      // is a renderer-only mount with the same click-frame jank as the Launcher,
      // so it goes through the shared deferred-mount path (placeholder this
      // commit → real Settings on a transition render). settingsInitialSection
      // etc. are set urgently above, so Settings reads the right section when it
      // mounts on the transition.
      const newTab: Tab = {
        id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        agentDir: null,
        sessionId: null,
        view: "settings",
        title: t("tabs.settings"),
        sidecarConfigDisposition: "push",
      };
      openNewTabDeferred(newTab);

      // Global Sidecar is now started on App mount, no need to start here
    },
    [openNewTabDeferred, setActiveTabId, t],
  );

  // Listen for OPEN_SETTINGS custom event from child components
  useEffect(() => {
    const handleOpenSettingsEvent = (
      event: CustomEvent<{
        section?: string;
        mcpServerId?: string;
        officialToolId?: OfficialToolId;
        selectItem?: CapabilityInitialSelect;
      }>,
    ) => {
      handleOpenSettings(
        event.detail?.section,
        event.detail?.mcpServerId,
        event.detail?.selectItem,
        event.detail?.officialToolId,
      );
    };
    window.addEventListener(
      CUSTOM_EVENTS.OPEN_SETTINGS,
      handleOpenSettingsEvent as EventListener,
    );
    return () => {
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_SETTINGS,
        handleOpenSettingsEvent as EventListener,
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callback stabilized via tabsRef
  }, [setActiveTabId]);

  // Open TaskCenter as a singleton tab (mirrors handleOpenSettings)
  const handleOpenTaskCenter = useCallback(() => {
    const currentTabs = tabsRef.current;
    const existing = currentTabs.find((t) => t.view === "taskcenter");
    if (existing) {
      setActiveTabId(existing.id);
      acknowledgeNotificationTarget({ type: "task-center" });
      return;
    }
    if (getChromeTabCount(currentTabs) >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: "taskcenter",
      title: t("tabs.taskCenter"),
      sidecarConfigDisposition: "push",
    };
    openNewTabDeferred(newTab);
    acknowledgeNotificationTarget({ type: "task-center" });
  }, [acknowledgeNotificationTarget, openNewTabDeferred, setActiveTabId, t]);

  // Intent carried across `OPEN_TASK_CENTER` — the event dispatcher
  // (Launcher "我的任务" tab's search icon) wants more than just "open
  // the tab": it wants the Task Center's search box focused on arrival.
  // Propagating via a direct `window` listener in TaskListPanel misses
  // the first-mount case (the event fires before the tab exists), so
  // we stash the intent in state here and pass it down as a prop.
  //
  // Intent lifecycle (cross-review C2):
  //   1. Every event overwrites state — including with `null` when the
  //      event carries no focus request. Otherwise a stale intent from
  //      an earlier search path would persist and trigger unexpected
  //      focus when the user later opens Task Center via the titlebar
  //      icon or any other entry.
  //   2. Each intent gets a monotonically-increasing `nonce` (not
  //      `Date.now()`) so back-to-back same-millisecond firings still
  //      produce distinct dep-array values for the consuming effect.
  //      `useRef + ++` is cheap and collision-free.
  const taskCenterIntentCounterRef = useRef(0);
  const [taskCenterPendingIntent, setTaskCenterPendingIntent] = useState<{
    autofocusSearch?: boolean;
    nonce: number;
  } | null>(null);

  // Listen for OPEN_TASK_CENTER custom event from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { autofocusSearch?: boolean }
        | undefined;
      if (detail?.autofocusSearch) {
        taskCenterIntentCounterRef.current += 1;
        setTaskCenterPendingIntent({
          autofocusSearch: true,
          nonce: taskCenterIntentCounterRef.current,
        });
      } else {
        // Non-focus open (titlebar icon, Chat 新建 dispatch, etc.) —
        // clear any lingering search intent so returning to Task Center
        // doesn't auto-focus the search field unexpectedly.
        setTaskCenterPendingIntent(null);
      }
      handleOpenTaskCenter();
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_TASK_CENTER, handler);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_TASK_CENTER, handler);
  }, [handleOpenTaskCenter]);

  const handleOpenSpace = useCallback(() => {
    if (spaceBuildCapability.isLoading) {
      toastRef.current.info(t("titlebar.teamLoading"));
      return;
    }
    if (!spaceBuildCapability.available) {
      toastRef.current.info(
        spaceBuildCapability.reason ?? t("titlebar.teamBuildUnavailable"),
      );
      return;
    }
    if (!teamSpaceAvailable) {
      toastRef.current.info(t("titlebar.teamUnavailable"));
      return;
    }
    const currentTabs = tabsRef.current;
    const existing = currentTabs.find((t) => t.view === "space");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    if (getChromeTabCount(currentTabs) >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: "space",
      title: t("tabs.team"),
      sidecarConfigDisposition: "push",
    };
    openNewTabDeferred(newTab);
  }, [
    openNewTabDeferred,
    setActiveTabId,
    spaceBuildCapability.available,
    spaceBuildCapability.isLoading,
    spaceBuildCapability.reason,
    teamSpaceAvailable,
    t,
  ]);

  useEffect(() => {
    window.addEventListener(CUSTOM_EVENTS.OPEN_SPACE, handleOpenSpace);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SPACE, handleOpenSpace);
  }, [handleOpenSpace]);

  const handleOpenWorkbench = useCallback(
    (request: OpenWorkbenchRequest) => {
      if (!request?.workbenchId || !request.workspacePath) return;
      const currentTabs = tabsRef.current;
      const existing = currentTabs.find((tab) =>
        isSameWorkbenchTab(tab, request),
      );
      if (existing) {
        if (request.route && existing.workbench?.route !== request.route) {
          updateWorkbenchRoute(existing.id, request.route);
        }
        setActiveTabId(existing.id);
        return;
      }
      if (getChromeTabCount(currentTabs) >= MAX_TABS) {
        toastRef.current.warning(t("appChrome.tabLimitReached"));
        return;
      }
      openNewTabDeferred(
        createWorkbenchTab(request, workbenchRegistry, generateTabId()),
      );
    },
    [openNewTabDeferred, setActiveTabId, t, updateWorkbenchRoute],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      handleOpenWorkbench((event as CustomEvent<OpenWorkbenchRequest>).detail);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_WORKBENCH, handler);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_WORKBENCH, handler);
  }, [handleOpenWorkbench]);

  const handleRunWorkbenchAi = useCallback(
    async (
      workspacePath: string,
      request: WorkbenchAiRunRequest,
    ): Promise<WorkbenchAiRunResult> => {
      if (!request.prompt.trim()) throw new Error("AI 生成请求不能为空");
      const project = configProjectsRef.current.find((candidate) =>
        workspacePathsEqual(candidate.path, workspacePath),
      );
      if (!project) {
        throw new Error(`工作台项目尚未注册到 MyAgents：${workspacePath}`);
      }
      const currentConfig = configRef.current;
      if (!currentConfig) {
        throw new Error("MyAgents 配置尚未加载完成，请稍后重试");
      }
      const workspaceAgent = getAgentByWorkspacePath(
        currentConfig,
        project.path,
      );
      const effectiveRuntime = resolveEffectiveRuntime(
        workspaceAgent?.runtime,
        !!currentConfig.multiAgentRuntime,
      );
      if (effectiveRuntime !== "builtin") {
        throw new Error("工作台一次性 AI 生成当前仅支持 MyAgents 内置运行时");
      }
      const selection =
        resolveWorkbenchModelSelection(
          request.modelSelection,
          appProvidersRef.current,
          appApiKeysRef.current,
          appProviderVerifyStatusRef.current,
        ) ??
        resolveBuiltinSelection(
          { agent: workspaceAgent, workspace: project },
          currentConfig,
          appProvidersRef.current,
          appApiKeysRef.current,
          appProviderVerifyStatusRef.current,
        );
      if (!selection) {
        throw new Error(
          "当前没有可用的模型服务，请先配置 API Key 或登录订阅账号",
        );
      }
      if (isRuntimeBackedProvider(selection.provider)) {
        throw new Error("工作台一次性 AI 生成暂不支持运行时托管的模型服务");
      }
      const serverUrl = await getGlobalServerUrl();
      const response = await proxyFetch(`${serverUrl}/api/workbench-ai/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspacePath,
          prompt: request.prompt,
          systemPrompt: request.systemPrompt,
          providerId: selection.provider.id,
          model: selection.model,
        }),
      });
      const payload = (await response.json()) as {
        success?: boolean;
        output?: string;
        error?: string;
      };
      if (!response.ok || !payload.success || !payload.output) {
        throw new Error(payload.error ?? "AI 生成失败");
      }
      return { output: payload.output };
    },
    [],
  );

  const handleRequestWorkbenchSimulation = useCallback(
    async (
      workspacePath: string,
      request: WorkbenchSimulationRequest,
    ): Promise<unknown> => {
      const project = configProjectsRef.current.find((candidate) =>
        workspacePathsEqual(candidate.path, workspacePath),
      );
      if (!project) {
        throw new Error(`工作台项目尚未注册到 MyAgents：${workspacePath}`);
      }
      let validatedRequest = request;
      if (request.operation === "create" && request.modelSelections) {
        const validatedSelections = Object.fromEntries(
          Object.entries(request.modelSelections).map(
            ([sceneId, selection]) => {
              if (
                !WORKBENCH_SIMULATION_MODEL_SCENE_IDS.includes(
                  sceneId as (typeof WORKBENCH_SIMULATION_MODEL_SCENE_IDS)[number],
                )
              ) {
                throw new Error(`未知的世界推演模型场景：${sceneId}`);
              }
              const resolved = resolveWorkbenchModelSelection(
                selection,
                appProvidersRef.current,
                appApiKeysRef.current,
                appProviderVerifyStatusRef.current,
              );
              if (!resolved || isRuntimeBackedProvider(resolved.provider)) {
                throw new Error(
                  `模型场景 ${sceneId} 当前不支持运行时托管的供应商，请重新选择。`,
                );
              }
              return [
                sceneId,
                { providerId: resolved.provider.id, model: resolved.model },
              ];
            },
          ),
        );
        validatedRequest = {
          ...request,
          modelSelections: validatedSelections,
        };
      }
      const serverUrl = await getGlobalServerUrl();
      const response = await proxyFetch(
        `${serverUrl}/api/workbench-simulation/request`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspacePath, request: validatedRequest }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        data?: unknown;
        error?: string;
      };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? "世界推演服务请求失败");
      }
      return payload.data;
    },
    [],
  );

  const handleOpenWorkbenchAgentSession = useCallback(
    async (workspacePath: string, request: WorkbenchAgentSessionRequest) => {
      const presentation = request.presentation ?? "tab";
      const isSurfacePresentation =
        presentation === "dialog" || presentation === "dock";
      const surfacePresentation =
        presentation === "dock" ? ("dock" as const) : ("dialog" as const);
      const sourceTabId = activeTabIdRef.current;
      const sourceTab = tabsRef.current.find((tab) => tab.id === sourceTabId);
      const workbenchId = sourceTab?.workbench?.workbenchId;
      if (!sourceTabId || !workbenchId) {
        throw new Error("工作台 Agent 会话必须从已打开的工作台中发起");
      }
      const project = configProjectsRef.current.find((candidate) =>
        workspacePathsEqual(candidate.path, workspacePath),
      );
      if (!project) {
        throw new Error(`工作台项目尚未注册到 MyAgents：${workspacePath}`);
      }
      const conversationKey =
        request.conversationKey ?? request.promptId ?? request.title;
      const historyGroupPath = parseSessionHistoryGroupPath(
        request.historyGroupPath,
      );
      const surfaceBootstrap = {
        title: request.title,
        initialMessage: request.initialMessage,
        ...(request.promptId ? { promptId: request.promptId } : {}),
        ...(historyGroupPath ? { historyGroupPath } : {}),
        ...(request.modelSelection
          ? { modelSelection: request.modelSelection }
          : {}),
      };

      const matchesConversation = (tab: Tab): boolean =>
        tab.workbenchAgentSurface?.workbenchId === workbenchId &&
        tab.workbenchAgentSurface.conversationKey === conversationKey &&
        workspacePathsEqual(
          tab.workbenchAgentSurface.workspacePath,
          workspacePath,
        );

      const focusExistingSurface = (existingId: string) => {
        setTabs((current) =>
          current.map((tab) =>
            tab.workbenchAgentSurface
              ? {
                  ...tab,
                  hasUnread: tab.id === existingId ? false : tab.hasUnread,
                  ...(tab.id === existingId && historyGroupPath
                    ? { sessionHistoryGroupPath: historyGroupPath }
                    : {}),
                  workbenchAgentSurface: {
                    ...tab.workbenchAgentSurface,
                    presentation:
                      tab.id === existingId
                        ? surfacePresentation
                        : presentation === "dialog" &&
                            tab.workbenchAgentSurface.sourceTabId ===
                              sourceTabId
                          ? "dock"
                          : tab.workbenchAgentSurface.presentation,
                    ...(tab.id === existingId
                      ? {
                          sourceTabId,
                          toolset: request.toolset,
                          bootstrap: surfaceBootstrap,
                          ...(historyGroupPath ? { historyGroupPath } : {}),
                        }
                      : {}),
                  },
                }
              : tab,
          ),
        );
        setActiveTabId(sourceTabId);
      };

      const closeConversationSurfaces = () => {
        const toClose = tabsRef.current.filter(matchesConversation);
        if (toClose.length === 0) return;
        const closeIds = new Set(toClose.map((tab) => tab.id));
        const nextTabs = tabsRef.current.filter((tab) => !closeIds.has(tab.id));
        tabsRef.current = nextTabs;
        flushSync(() => {
          setTabs(nextTabs);
        });
        // Resource cleanup only — UI already dropped these surfaces.
        for (const tab of toClose) {
          const tabSessionId = tab.sessionId;
          const tabAgentDir = tab.agentDir;
          const tabId = tab.id;
          void (async () => {
            try {
              if (tabSessionId) {
                await startBackgroundCompletion(tabSessionId).catch(
                  () => undefined,
                );
              }
              await stopSseProxy(tabId);
              if (tabSessionId) {
                await releaseTabSession(tabSessionId, tabId).catch(
                  () => undefined,
                );
              } else if (tabAgentDir) {
                void stopTabSidecar(tabId);
              }
            } catch (error) {
              console.error(
                `[App] Failed to clean up workbench agent surface ${tabId}:`,
                error,
              );
            }
          })();
        }
      };

      let resumeSession: { id: string } | null = null;
      if (isSurfacePresentation) {
        if (request.forceNew) {
          clearWorkbenchAgentConversation(
            workbenchId,
            workspacePath,
            conversationKey,
          );
          closeConversationSurfaces();
        } else {
          const existing = tabsRef.current.find(matchesConversation);
          if (existing) {
            if (existing.isGenerating) {
              focusExistingSurface(existing.id);
              toastRef.current.info("对话进行中，已为你打开");
              return;
            }

            let shouldRecreate = false;
            if (existing.sessionId && !isPendingSessionId(existing.sessionId)) {
              const sessions = await getSessions(project.path);
              const meta = sessions.find(
                (session) => session.id === existing.sessionId,
              );
              // Only recreate when metadata is present and empty. Missing
              // metadata can mean the session index has not caught up yet.
              shouldRecreate = Boolean(meta) && isEmptyOrBrokenSession(meta);
            }

            if (!shouldRecreate) {
              focusExistingSurface(existing.id);
              toastRef.current.info("已回到上次对话");
              return;
            }

            clearWorkbenchAgentConversation(
              workbenchId,
              workspacePath,
              conversationKey,
            );
            closeConversationSurfaces();
            toastRef.current.info("上次会话未启动成功，已重新开始");
          }

          const boundSessionId = loadWorkbenchAgentConversation(
            workbenchId,
            workspacePath,
            conversationKey,
          );
          if (boundSessionId) {
            const sessions = await getSessions(project.path);
            const storedSession = sessions.find(
              (session) => session.id === boundSessionId,
            );
            if (!storedSession || isEmptyOrBrokenSession(storedSession)) {
              clearWorkbenchAgentConversation(
                workbenchId,
                workspacePath,
                conversationKey,
              );
              closeConversationSurfaces();
            } else {
              resumeSession = { id: storedSession.id };
            }
          }
        }
      }

      const visibleTabCount = tabsRef.current.filter(
        (tab) => !isWorkbenchAgentSurfaceTab(tab),
      ).length;
      if (presentation === "tab" && visibleTabCount >= MAX_TABS) {
        toastRef.current.warning(t("appChrome.tabLimitReached"));
        throw new Error(`已达到 ${MAX_TABS} 个 Tab 的上限`);
      }

      const currentConfig = configRef.current;
      if (!currentConfig) {
        throw new Error("MyAgents 配置尚未加载完成，请稍后重试");
      }
      const workspaceAgent = getAgentByWorkspacePath(
        currentConfig,
        project.path,
      );
      const effectiveRuntime = resolveEffectiveRuntime(
        workspaceAgent?.runtime,
        !!currentConfig.multiAgentRuntime,
      );
      if (request.toolset && effectiveRuntime !== "builtin") {
        throw new Error(
          "受控工作台工具当前仅支持 MyAgents 内置运行时，请先切换该项目的运行时",
        );
      }
      if (request.modelSelection && effectiveRuntime !== "builtin") {
        throw new Error("场景模型绑定当前仅支持 MyAgents 内置运行时");
      }
      const sceneModelSelection = resolveWorkbenchModelSelection(
        request.modelSelection,
        appProvidersRef.current,
        appApiKeysRef.current,
        appProviderVerifyStatusRef.current,
      );
      let initialMessage: InitialMessage | undefined;
      if (!resumeSession) {
        initialMessage = { text: request.initialMessage };
        if (request.toolset) {
          initialMessage.workbenchToolset = request.toolset;
        }

        if (effectiveRuntime === "builtin") {
          const selection =
            sceneModelSelection ??
            resolveBuiltinSelection(
              { agent: workspaceAgent, workspace: project },
              currentConfig,
              appProvidersRef.current,
              appApiKeysRef.current,
              appProviderVerifyStatusRef.current,
            );
          if (!selection) {
            throw new Error(
              "当前没有可用的模型服务，请先配置 API Key 或登录订阅账号",
            );
          }

          const providerIntent = isRuntimeBackedProvider(selection.provider)
            ? toProviderExecutionIntent(selection.provider, selection.model)
            : undefined;
          if (providerIntent?.kind === "runtime-backed-provider") {
            initialMessage.providerExecutionIdentity = providerIntent;
            initialMessage.runtimeModel = providerIntent.model;
          } else {
            initialMessage.builtinSelection = {
              providerId: selection.provider.id,
              model: selection.model,
            };
          }
          initialMessage.permissionMode = resolveInitialPermissionMode({
            project,
            agent: workspaceAgent,
            defaultPermissionMode: currentConfig.defaultPermissionMode,
          });
        } else {
          initialMessage.runtimeModel =
            normalizeStringSetting(workspaceAgent?.runtimeConfig?.model) ??
            normalizeStringSetting(workspaceAgent?.model);
        }
      } else if (request.toolset) {
        // Resumed Agent sessions retain their conversation but not the sidecar's
        // in-process SDK adapter. Hand Chat a setup-only intent so it rebinds
        // the host-owned workbench toolset before the user continues.
        initialMessage = {
          text: "",
          workbenchToolset: request.toolset,
          configureWorkbenchToolsetOnly: true,
        };
      }

      const agentSurface = isSurfacePresentation
        ? {
            ...(historyGroupPath
              ? { sessionHistoryGroupPath: historyGroupPath }
              : {}),
            workbenchAgentSurface: {
              presentation: surfacePresentation,
              sourceTabId,
              workbenchId,
              workspacePath,
              conversationKey,
              ...(historyGroupPath ? { historyGroupPath } : {}),
              toolset: request.toolset,
              bootstrap: surfaceBootstrap,
            },
          }
        : {};

      const newTab: Tab = {
        ...createNewTab(),
        ...agentSurface,
      };
      openLaunchTabNow(newTab);
      try {
        const launch = handleLaunchProject(
          project,
          resumeSession?.id,
          initialMessage,
          resumeSession
            ? { historyEntrySource: "launcher_overlay" }
            : {
                surface: "agent_card",
                entryIntent: "send_message",
              },
        );
        if (isSurfacePresentation) {
          setActiveTabId(sourceTabId);
        }
        await launch;
        setTabs((current) => {
          const targetTabId = resumeSession
            ? (current.find((tab) => tab.sessionId === resumeSession.id)?.id ??
              newTab.id)
            : newTab.id;
          return current.map((tab) =>
            tab.id === targetTabId
              ? {
                  ...tab,
                  title: request.title,
                  ...(historyGroupPath
                    ? { sessionHistoryGroupPath: historyGroupPath }
                    : {}),
                  ...(isSurfacePresentation
                    ? {
                        workbenchAgentSurface: {
                          presentation: surfacePresentation,
                          sourceTabId,
                          workbenchId,
                          workspacePath,
                          conversationKey,
                          ...(historyGroupPath ? { historyGroupPath } : {}),
                          toolset: request.toolset,
                          bootstrap: surfaceBootstrap,
                        },
                      }
                    : {}),
                }
              : presentation === "dialog" &&
                  tab.workbenchAgentSurface?.sourceTabId === sourceTabId
                ? {
                    ...tab,
                    workbenchAgentSurface: {
                      ...tab.workbenchAgentSurface,
                      presentation: "dock",
                    },
                  }
                : tab,
          );
        });
      } finally {
        removeUnusedPrecreatedLaunchTab(newTab.id);
        if (
          isSurfacePresentation &&
          tabsRef.current.some((tab) => tab.id === sourceTabId)
        ) {
          setActiveTabId(sourceTabId);
        }
      }
    },
    [
      handleLaunchProject,
      openLaunchTabNow,
      removeUnusedPrecreatedLaunchTab,
      setActiveTabId,
      t,
    ],
  );

  // PRD §8.3 — "AI 讨论" flow. Open a new Chat tab, auto-dispatch the
  // `/task-alignment` skill with the thought content + instructions to call
  // `myagents task create-from-alignment` at the end.
  useEffect(() => {
    const handler = async (raw: Event) => {
      const event = raw as CustomEvent<{
        thoughtId: string;
        content: string;
        tags: string[];
        /** Explicit workspace pick from the ThoughtCard popover (v0.1.69
         *  polish). When present we use it directly; when absent (old
         *  callers or programmatic triggers) we fall back to the smart
         *  tag→project match so behavior degrades gracefully. */
        workspaceId?: string;
      }>;
      const { thoughtId, content, tags, workspaceId } = event.detail ?? {
        thoughtId: "",
        content: "",
        tags: [],
      };
      if (!thoughtId || !content) return;

      try {
        const currentTabs = tabsRef.current;
        if (getChromeTabCount(currentTabs) >= MAX_TABS) {
          toastRef.current?.error(
            t("appChrome.maxTabsReachedWithCount", { count: MAX_TABS }),
          );
          return;
        }

        const projects = configProjectsRef.current.filter(
          isProjectVisibleToUser,
        );
        if (projects.length === 0) {
          toastRef.current?.error(t("appChrome.noWorkspaceForDiscussion"));
          return;
        }
        // Prefer the explicit pick; fall back to smart default for legacy
        // callers / programmatic use.
        const lowerTags = tags.map((t) => t.toLowerCase());
        const workspace =
          (workspaceId
            ? projects.find((p) => p.id === workspaceId)
            : undefined) ??
          projects.find((p) => lowerTags.includes(p.name.toLowerCase())) ??
          projects[0];

        // PRD 0.2.3: 从前端唯一 builtin selection helper 解析出成对的 (provider, model)。
        // 早期实现直接吃 config.defaultProviderId、跳过 workspace/agent 两层，导致
        //   provider = openrouter（全局默认）+ model = claude-opus（agent snapshot）
        // 这种 (provider X, model Y) 错配，触发 API key 验证失败。
        // helper 优先级：agent → workspace → defaultProviderId → first available，
        //   每层 isProviderAvailable 检查；返回的 model 一定 ∈ provider.models。
        const workspaceAgent =
          workspace.agentId && configRef.current
            ? getAgentById(configRef.current, workspace.agentId)
            : undefined;
        const sel = resolveBuiltinSelection(
          { agent: workspaceAgent, workspace },
          configRef.current!,
          appProvidersRef.current,
          appApiKeysRef.current,
          appProviderVerifyStatusRef.current,
        );
        if (!sel) {
          toastRef.current?.error(t("appChrome.noModelProviderForDiscussion"));
          return;
        }

        // Pre-mint the alignment session id (CC review W8) so the AI doesn't
        // have to infer a placeholder. This becomes the subdir under
        // `~/.myagents/tasks/<id>/` where alignment.md/task.md/verify.md/
        // progress.md land, and the exact value the
        // `task create-from-alignment` CLI takes (it renames that directory
        // to `~/.myagents/tasks/<newTaskId>/` on promotion).
        //
        // v0.1.69 relocation: the task-alignment skill writes via the `Write`
        // tool using the absolute home-dir path (task docs moved out of the
        // workspace so moving/renaming the workspace doesn't orphan them).
        const alignmentSessionId = `align-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

        // Persist the workspace/thought context to
        // `~/.myagents/tasks/<alignmentSessionId>/metadata.json` so that
        // when the AI later calls `myagents task create-from-alignment`
        // it only needs to pass `--name`; the backend inherits the rest
        // from this file. Without this, the AI had to re-type 3 long
        // UUIDs that it already had in its prompt context — fragile
        // (one typo → task hung on wrong workspace, silently).
        // Fire-and-forget is safe: the prompt still carries the same
        // context as a fallback, so even if the write fails the AI can
        // pass the params explicitly and the flow still works.
        if (isTauriEnvironment()) {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("cmd_task_write_alignment_metadata", {
              alignmentSessionId,
              workspaceId: workspace.id,
              workspacePath: workspace.path,
              sourceThoughtId: thoughtId,
            });
          } catch (err) {
            console.warn(
              "[App] OPEN_AI_DISCUSSION: write alignment metadata failed, AI will need to pass params explicitly:",
              err,
            );
          }
        }

        // Prompt stays minimal by design — operational details (how to
        // write the four docs, when to call `create-from-alignment`, what
        // each of the 4 discussion outcomes looks like, CLI syntax) ALL
        // live in `bundled-skills/task-alignment/SKILL.md`. The prompt
        // only carries per-conversation data the skill can't know: the
        // original thought text + four context-parameter values. Fewer
        // instructions here means the AI doesn't get steered into "write
        // files first" before the alignment dialog actually happens.
        const alignmentPrompt = [
          "我有一个想法希望进行讨论，请使用 Skill `/task-alignment` 与我讨论对齐。",
          "本次上下文参数：",
          `- alignmentSessionId: ${alignmentSessionId}`,
          `- workspaceId: ${workspace.id}`,
          `- workspacePath: ${workspace.path}`,
          `- sourceThoughtId: ${thoughtId}`,
          "",
          "[我的想法]",
          content,
        ].join("\n");

        const alignmentProviderIntent = isRuntimeBackedProvider(sel.provider)
          ? toProviderExecutionIntent(sel.provider, sel.model)
          : undefined;
        const alignmentProviderExecutionIdentity =
          alignmentProviderIntent?.kind === "runtime-backed-provider"
            ? alignmentProviderIntent
            : undefined;
        const alignmentPermissionMode = resolveInitialPermissionMode({
          project: workspace,
          agent: workspaceAgent,
          defaultPermissionMode: configRef.current?.defaultPermissionMode,
        });
        const initialMessage: InitialMessage = {
          text: alignmentPrompt,
          ...(alignmentPermissionMode
            ? { permissionMode: alignmentPermissionMode }
            : {}),
          ...(alignmentProviderExecutionIdentity
            ? {
                providerExecutionIdentity: alignmentProviderExecutionIdentity,
                runtimeModel: alignmentProviderExecutionIdentity.model,
              }
            : {
                builtinSelection: {
                  providerId: sel.provider.id,
                  model: sel.model,
                },
              }),
        };

        // Pre-seed the tab as a Chat tab before awaiting sidecar startup.
        // Without this, the user sees the Launcher briefly while
        // handleLaunchProject waits on ensureSessionSidecar, then the tab
        // "jumps" to Chat. createPendingSessionId is deterministic
        // (`pending-<tabId>`), so handleLaunchProject's internal call
        // resolves to the same id and its later setTabs is a no-op for
        // view/agentDir/sessionId.
        const newTab = createNewTab();
        if (initialMessage.providerExecutionIdentity) {
          openLaunchTabNow(newTab);
        } else {
          const seeded = {
            ...newTab,
            view: "chat" as const,
            agentDir: workspace.path,
            sessionId: createPendingSessionId(newTab.id),
            title: t("appChrome.discussionTabTitle"),
            initialMessage,
          };
          setTabs((prev) => [...prev, seeded]);
          setActiveTabId(newTab.id);
        }

        await handleLaunchProject(workspace, undefined, initialMessage, {
          surface: "task_center",
          entryIntent: "thought_alignment",
        });

        // handleLaunchProject's internal setTabs overwrites `title` with the
        // workspace display name. Restore the "任务讨论" title afterwards so
        // the tab consistently reads as a discussion session, not the
        // workspace's generic name.
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === newTab.id
              ? { ...tab, title: t("appChrome.discussionTabTitle") }
              : tab,
          ),
        );
      } catch (err) {
        console.error("[App] OPEN_AI_DISCUSSION failed:", err);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, handler);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable via refs
  }, [setActiveTabId, t]);

  // Listen for OPEN_SESSION_IN_NEW_TAB — task center's 任务执行 session list
  // dispatches this to open a historical execution in a fresh chat tab.
  //
  // Opens the session in a new tab (or jumps to it if already open) via the same
  // cron-aware plan→spawn path as the in-tab handleOpenSessionInNewTab. An earlier
  // version pre-seeded a chat tab + handleLaunchProject, which (a) could replace the
  // active session via Scenario 4, and (b) wiped a cron task's activation when the
  // pre-seeded session id made the planner pick jump-to-tab→Scenario 4. The
  // spawn path avoids both.
  useEffect(() => {
    const handler = async (raw: Event) => {
      const event = raw as CustomEvent<{
        sessionId: string;
        workspacePath: string;
        preview?: { path?: string; initialLineNumber?: number };
        historyEntrySource?: HistoryEntrySource;
      }>;
      const { sessionId, workspacePath, preview, historyEntrySource } =
        event.detail ?? {};
      if (!sessionId || !workspacePath) return;
      const pendingFilePreview: FilePreviewIntent | undefined = preview?.path
        ? {
            id: `fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            path: preview.path,
            ...(preview.initialLineNumber
              ? { initialLineNumber: preview.initialLineNumber }
              : {}),
          }
        : undefined;

      const workspace = configProjectsRef.current.find((p) =>
        workspacePathsEqual(p.path, workspacePath),
      );
      if (!workspace) {
        console.warn(
          "[App] OPEN_SESSION_IN_NEW_TAB workspace not in projects; opening by path:",
          workspacePath,
        );
      }
      if (historyEntrySource) {
        trackHistorySessionOpenAsync(
          sessionId,
          workspace?.path ?? workspacePath,
          historyEntrySource,
        );
      }

      // Dedup + cron-aware routing — mirror handleOpenSessionInNewTab (the in-tab
      // path); do NOT pre-seed + handleLaunchProject. A pre-seeded session id makes
      // planSessionOpen return jump-to-tab, which the launch flow then routes into
      // Scenario 4's release + deactivate + activate(taskId:null) → that WIPES a cron
      // task's activation ownership (cross-AI review, High). spawnTabForExistingSession
      // owns the disposition (pending → push|adopt from result.isNew), preserves the
      // cron activation via updateSessionTab when joining a cron-owned sidecar, removes
      // the tab on failure (no stuck-'pending'), and enforces MAX_TABS internally.
      const activation = await getSessionActivation(sessionId);
      const plan = planSessionOpen({
        tabs: tabsRef.current,
        targetSessionId: sessionId,
        multiAgentRuntime: false,
        targetActivation: activation,
        currentSessionHasPersistentOwners: false,
      });
      if (plan.type === "jump-to-tab") {
        // Already open → switch to it (don't duplicate, don't block on MAX_TABS).
        if (pendingFilePreview) {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === plan.tabId ? { ...t, pendingFilePreview } : t,
            ),
          );
        }
        selectTabOrRestoreAgentSurface(plan.tabId);
        return;
      }
      await spawnTabForExistingSession(
        sessionId,
        workspace?.path ?? workspacePath,
        workspace?.displayName ||
          getFolderName(workspace?.path ?? workspacePath),
        {
          preserveCronActivation: plan.type === "attach-existing-sidecar",
          pendingFilePreview,
        },
      );
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, handler);
    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB,
        handler,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable via refs
  }, [selectTabOrRestoreAgentSurface, trackHistorySessionOpenAsync]);

  // Listen for JUMP_TO_TAB custom event (Session singleton constraint)
  useEffect(() => {
    const handleJumpToTab = (
      event: CustomEvent<{ targetTabId: string; sessionId: string }>,
    ) => {
      const { targetTabId, sessionId } = event.detail;
      console.log(`[App] Jump to tab ${targetTabId} for session ${sessionId}`);
      // Check if target Tab exists
      const targetTab = tabsRef.current.find((t) => t.id === targetTabId);
      if (targetTab) {
        setActiveTabId(targetTabId);
      } else {
        console.warn(`[App] Target tab ${targetTabId} not found, cannot jump`);
      }
    };
    window.addEventListener(
      CUSTOM_EVENTS.JUMP_TO_TAB,
      handleJumpToTab as EventListener,
    );
    return () => {
      window.removeEventListener(
        CUSTOM_EVENTS.JUMP_TO_TAB,
        handleJumpToTab as EventListener,
      );
    };
  }, [setActiveTabId]);

  // Listen for LAUNCH_BUG_REPORT custom event (AI-powered bug reporting)
  useEffect(() => {
    const handleLaunchBugReport = async (
      event: CustomEvent<{
        description: string;
        providerId?: string;
        model?: string;
        appVersion: string;
        images?: ImageAttachment[];
        resumeSessionId?: string;
        assistantEntry?: AssistantEntry;
      }>,
    ) => {
      const {
        description,
        appVersion,
        providerId,
        model,
        resumeSessionId,
        assistantEntry,
      } = event.detail;
      try {
        // Resume path runs FIRST and out-of-order with the MAX_TABS guard:
        // if the helper session is already owned by another Tab, we just
        // jump there (Session : Tab = 1:1 invariant), which doesn't consume
        // a Tab slot — so MAX_TABS shouldn't block it.
        if (resumeSessionId) {
          const existing = tabsRef.current.find(
            (t) => t.sessionId === resumeSessionId,
          );
          if (existing) {
            if (existing.agentDir) {
              trackHistorySessionOpenAsync(
                resumeSessionId,
                existing.agentDir,
                "settings_helper_history",
              );
            } else {
              console.warn(
                `[App] Cannot track helper history resume ${resumeSessionId}: existing tab has no agentDir`,
              );
            }
            if (activeTabIdRef.current !== existing.id) {
              selectTabOrRestoreAgentSurface(existing.id);
            }
            return;
          }
          // No existing owner — we'll need a fresh Tab. Apply MAX_TABS now.
          if (getChromeTabCount(tabsRef.current) >= MAX_TABS) {
            console.warn(
              `[App] Max tabs (${MAX_TABS}) reached, cannot resume helper session`,
            );
            return;
          }
          const project = await ensureSelfAwarenessWorkspace(
            configProjectsRef.current,
            configAddProject,
            configPatchProject,
          );
          if (!project) {
            console.error("[App] ensureSelfAwarenessWorkspace returned null");
            return;
          }
          // Pre-create a Tab so handleLaunchProject's `switch-current-tab`
          // default doesn't overwrite the Settings tab (which IS the active
          // tab when the inbox dispatches). Then reap it post-call if the
          // planner chose `open-new-tab` (handleLaunchProject creates its
          // own Tab internally for that branch and our pre-created one is
          // left empty).
          const newTab = createNewTab();
          openLaunchTabNow(newTab);
          try {
            await handleLaunchProject(project, resumeSessionId, undefined, {
              historyEntrySource: "settings_helper_history",
            });
          } finally {
            removeUnusedPrecreatedLaunchTab(newTab.id);
          }
          return;
        }

        if (getChromeTabCount(tabsRef.current) >= MAX_TABS) {
          console.warn(
            `[App] Max tabs (${MAX_TABS}) reached, cannot open bug report`,
          );
          return;
        }

        // Ensure ~/.myagents registered as internal project
        // (CLAUDE.md + skills are synced at startup via cmd_sync_admin_agent)
        const project = await ensureSelfAwarenessWorkspace(
          configProjectsRef.current,
          configAddProject,
          configPatchProject,
        );
        if (!project) {
          console.error("[App] ensureSelfAwarenessWorkspace returned null");
          return;
        }

        // Two paths to a paired (provider, model):
        //   A. Explicit picker (BugReportOverlay): caller supplied (providerId, model)
        //      and the provider is still available — honor via pairBuiltinSelection.
        //   B. Implicit (Chat error banner / Settings mcp dialog) OR explicit-but-
        //      provider-unavailable: resolve via priority chain
        //      (helperAgent → helperProject → defaultProviderId → first available),
        //      each layer guarded by isProviderAvailable.
        // Always pass an explicit execution identity (when any provider is available)
        // so Chat tab autoSend doesn't race against the invalid-model correction
        // useEffect when helper Agent's persisted (provider, model) has gone stale.
        const helperAgent =
          project.agentId && configRef.current
            ? getAgentById(configRef.current, project.agentId)
            : undefined;
        let builtinSelection: { providerId: string; model: string } | undefined;
        let providerExecutionIdentity:
          | RuntimeBackedProviderIdentity
          | undefined;
        if (providerId) {
          const provider = appProvidersRef.current.find(
            (p) => p.id === providerId,
          );
          if (
            provider &&
            isProviderAvailable(
              provider,
              appApiKeysRef.current,
              appProviderVerifyStatusRef.current,
            )
          ) {
            const targetModel = model ?? provider.primaryModel;
            if (isRuntimeBackedProvider(provider)) {
              const intent = toProviderExecutionIntent(provider, targetModel);
              if (intent.kind === "runtime-backed-provider") {
                providerExecutionIdentity = intent;
              }
            } else {
              builtinSelection = pairBuiltinSelection(provider, model);
            }
          }
        }
        if (!builtinSelection && !providerExecutionIdentity) {
          const sel = resolveBuiltinSelection(
            { agent: helperAgent, workspace: project },
            configRef.current!,
            appProvidersRef.current,
            appApiKeysRef.current,
            appProviderVerifyStatusRef.current,
          );
          if (sel) {
            if (isRuntimeBackedProvider(sel.provider)) {
              const intent = toProviderExecutionIntent(sel.provider, sel.model);
              if (intent.kind === "runtime-backed-provider") {
                providerExecutionIdentity = intent;
              }
            } else {
              builtinSelection = {
                providerId: sel.provider.id,
                model: sel.model,
              };
            }
          }
          // else: no provider available system-wide — let Chat tab show its
          // empty-state guidance ("请先设置模型服务").
        }
        const helperPermissionMode = resolveInitialPermissionMode({
          project,
          agent: helperAgent,
          defaultPermissionMode: configRef.current?.defaultPermissionMode,
        });

        const initialMessage: InitialMessage = {
          text: buildSupportPrompt(description, appVersion),
          ...(helperPermissionMode
            ? { permissionMode: helperPermissionMode }
            : {}),
          ...(builtinSelection ? { builtinSelection } : {}),
          ...(providerExecutionIdentity
            ? {
                providerExecutionIdentity,
                runtimeModel: providerExecutionIdentity.model,
              }
            : {}),
          images: event.detail.images,
        };

        const newTab = createNewTab();
        openLaunchTabNow(newTab);

        try {
          await handleLaunchProject(project, undefined, initialMessage, {
            surface: "bug_report",
            entryIntent: "support_diagnostics",
            assistantEntry: assistantEntry ?? "other",
          });

          // Override tab title
          setTabs((prev) =>
            prev.map((tab) =>
              tab.id === newTab.id
                ? { ...tab, title: t("appChrome.diagnosticsTabTitle") }
                : tab,
            ),
          );
        } finally {
          removeUnusedPrecreatedLaunchTab(newTab.id);
        }
      } catch (err) {
        console.error("[App] Failed to launch bug report:", err);
      }
    };
    const listener = ((e: Event) => {
      void handleLaunchBugReport(e as CustomEvent);
    }) as EventListener;
    window.addEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, listener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via refs, configAdd/patchProject are stable useCallbacks
  }, [configAddProject, configPatchProject, t]);

  // Stable callback for Settings onSectionChange — avoids inline arrow creating new ref every render
  const handleSettingsSectionChange = useCallback(() => {
    setSettingsInitialSection(undefined);
    setSettingsInitialMcpId(undefined);
    setSettingsInitialOfficialToolId(undefined);
    setSettingsInitialSelect(undefined);
  }, []);

  // System tray event handling (minimize to tray, exit confirmation)
  useTrayEvents({
    minimizeToTray: config.minimizeToTray,
    onOpenSettings: () => handleOpenSettings("general"),
    onCmdWCloseTab: () => {
      // Cmd+W bottom: overlay → split → tab → launcher → STOP.
      closeCurrentTab(); // Last tab auto-creates launcher; launcher is a no-op.
    },
    onWindowFocused: handleWindowFocused,
    onExitRequested: async () => {
      // User-owned scheduler lifecycle is authoritative here. Ordinary Cron
      // lists intentionally exclude Goal and cannot protect app exit.
      try {
        const lifecycle = await getUserSchedulerLifecycleSnapshot();

        if (lifecycle.runningTaskCount > 0) {
          // Show confirmation dialog
          return new Promise<boolean>((resolve) => {
            setExitConfirmState({
              runningTaskCount: lifecycle.runningTaskCount,
              resolve,
            });
          });
        }
      } catch (error) {
        // Exit is destructive to in-flight output. Unknown lifecycle state is
        // fail-closed and asks for confirmation instead of silently quitting.
        console.error("[App] Failed to check scheduler lifecycle:", error);
        return new Promise<boolean>((resolve) => {
          setExitConfirmState({ runningTaskCount: 1, resolve });
        });
      }

      // No running tasks, allow exit
      return true;
    },
  });

  // Listen for notification clicks. Rust emits this from two paths:
  // - Windows: directly from the WinRT toast `Activated` callback
  // - macOS / Linux: when the front-end calls `cmd_consume_notification_click`
  //   on focus-regain (handled inside `useTrayEvents`)
  // Both converge here so routing has one entry point. Chat completion toasts
  // usually carry a tabId and can jump directly; cron/background toasts carry
  // sessionId + workspacePath so they can open a session even when no Tab exists.
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    void listenWithCleanup<{
      tabId?: string;
      sessionId?: string;
      workspacePath?: string;
    }>(
      "notification:click",
      (event) => {
        const route = resolveNotificationClickRoute(
          event.payload,
          (tabId, sessionId) => {
            const tab = tabsRef.current.find((t) => t.id === tabId);
            if (!tab) return false;
            return !sessionId || tab.sessionId === sessionId;
          },
        );
        if (route.type === "select-tab") {
          console.log(
            "[App] notification:click → handleSelectTab",
            route.tabId,
          );
          if (route.sessionId) {
            acknowledgeNotificationTarget({
              type: "session",
              sessionId: route.sessionId,
            });
          }
          handleSelectTab(route.tabId);
          updateTabUnread(route.tabId, false);
          return;
        }

        if (route.type === "open-session") {
          console.log(
            "[App] notification:click → open session",
            route.sessionId,
          );
          window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
              detail: {
                sessionId: route.sessionId,
                workspacePath: route.workspacePath,
              },
            }),
          );
          return;
        }

        console.warn(
          "[App] notification:click without routable target:",
          event.payload,
        );
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [acknowledgeNotificationTarget, handleSelectTab, updateTabUnread]);

  const handleMinimizeWorkbenchAgentSurface = useCallback((tabId: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId && tab.workbenchAgentSurface
          ? {
              ...tab,
              workbenchAgentSurface: {
                ...tab.workbenchAgentSurface,
                presentation: "dock",
              },
            }
          : tab,
      ),
    );
  }, []);

  const handleHideWorkbenchAgentSurface = useCallback((tabId: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId && tab.workbenchAgentSurface
          ? {
              ...tab,
              workbenchAgentSurface: {
                ...tab.workbenchAgentSurface,
                presentation: "hidden",
              },
            }
          : tab,
      ),
    );
  }, []);

  const handleExpandWorkbenchAgentSurface = useCallback(
    (tabId: string) => {
      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId
            ? { ...tab, workbenchAgentSurface: undefined, hasUnread: false }
            : tab,
        ),
      );
      setActiveTabId(tabId);
    },
    [setActiveTabId],
  );

  const handleRestartWorkbenchAgentSurface = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      const surface = tab?.workbenchAgentSurface;
      if (!surface?.bootstrap) {
        toastRef.current.warning(
          "当前会话无法重新开始，请关闭后再次从工作台启动",
        );
        return;
      }

      const sourceTabId = surface.sourceTabId;
      const restartRequest: WorkbenchAgentSessionRequest = {
        version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
        title: surface.bootstrap.title,
        initialMessage: surface.bootstrap.initialMessage,
        presentation: "dialog",
        conversationKey: surface.conversationKey,
        forceNew: true,
        ...(surface.bootstrap.promptId
          ? { promptId: surface.bootstrap.promptId }
          : {}),
        ...(surface.bootstrap.historyGroupPath
          ? { historyGroupPath: surface.bootstrap.historyGroupPath }
          : {}),
        ...(surface.bootstrap.modelSelection
          ? { modelSelection: surface.bootstrap.modelSelection }
          : {}),
        ...(surface.toolset ? { toolset: surface.toolset } : {}),
      };

      clearWorkbenchAgentConversation(
        surface.workbenchId,
        surface.workspacePath,
        surface.conversationKey,
      );
      performCloseTab(tabId);

      if (tabsRef.current.some((item) => item.id === sourceTabId)) {
        setActiveTabId(sourceTabId);
      }

      try {
        await handleOpenWorkbenchAgentSession(
          surface.workspacePath,
          restartRequest,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toastRef.current.error(message);
      }
    },
    [handleOpenWorkbenchAgentSession, performCloseTab, setActiveTabId],
  );

  const handleReviewWorkbenchAgentSurface = useCallback(
    (tabId: string) => {
      const surface = tabsRef.current.find(
        (tab) => tab.id === tabId,
      )?.workbenchAgentSurface;
      if (!surface) return;
      if (tabsRef.current.some((tab) => tab.id === surface.sourceTabId)) {
        setActiveTabId(surface.sourceTabId);
      }
      const mode = surface.toolset?.context?.mode;
      const action =
        mode === "items"
          ? "open-item-proposal-review"
          : mode === "characters"
            ? "open-character-proposal-review"
            : mode === "cultivation"
              ? "open-cultivation-proposal-review"
              : mode === "world" || mode === "template" || mode === "assist"
                ? "open-proposal-review"
                : null;
      if (!action) return;
      window.setTimeout(() => {
        dispatchWorkbenchHostAction({
          workbenchId: surface.workbenchId,
          workspacePath: surface.workspacePath,
          action,
        });
      }, 0);
    },
    [setActiveTabId],
  );

  const chromeTabs = getChromeTabs(tabs);
  const agentSurfaceTabs = tabs.filter(isWorkbenchAgentSurfaceTab);

  const renderTabContent = (tab: Tab, isActive: boolean) => (
    <MemoizedTabContent
      key={tab.id}
      tab={tab}
      isActive={isActive}
      isLoading={loadingTabs[tab.id] ?? false}
      error={tabErrors[tab.id] ?? null}
      isDeferredMount={deferredMountTabIds.has(tab.id)}
      onLaunchProject={handleLaunchProject}
      onBack={handleBackToLauncher}
      onSwitchSession={handleSwitchSession}
      onOpenSessionInNewTab={handleOpenSessionInNewTab}
      onNewSession={handleNewSession}
      onUpdateGenerating={updateTabGenerating}
      onUpdateTitle={updateTabTitle}
      onUpdateUnread={updateTabUnread}
      onRenameSession={handleRenameSession}
      onForkSession={handleForkSession}
      onUpdateSessionId={updateTabSessionId}
      onClearInitialMessage={clearInitialMessage}
      onSidecarConfigAdopted={markSidecarConfigAdopted}
      onFilePreviewIntentConsumed={handleFilePreviewIntentConsumed}
      onUpdateWorkbenchRoute={updateWorkbenchRoute}
      onRegisterWorkbenchNavigationGuard={registerWorkbenchNavigationGuard}
      onOpenWorkbenchAgentSession={handleOpenWorkbenchAgentSession}
      onRunWorkbenchAi={handleRunWorkbenchAi}
      onRequestWorkbenchSimulation={handleRequestWorkbenchSimulation}
      settingsInitialSection={
        tab.view === "settings" ? settingsInitialSection : undefined
      }
      settingsInitialMcpId={
        tab.view === "settings" ? settingsInitialMcpId : undefined
      }
      settingsInitialOfficialToolId={
        tab.view === "settings" ? settingsInitialOfficialToolId : undefined
      }
      settingsInitialSelect={
        tab.view === "settings" ? settingsInitialSelect : undefined
      }
      onSettingsSectionChange={handleSettingsSectionChange}
      updateReady={updateReady}
      updateVersion={updateVersion}
      updateChecking={updateChecking}
      updateDownloading={updateDownloading}
      updateInstalling={updateInstalling}
      updatePreparing={updatePreparing}
      onCheckForUpdate={checkForUpdate}
      onRestartAndUpdate={handleRestartAndUpdate}
      sessionNotificationBadgeCounts={
        isActive ? sessionNotificationBadgeCounts : undefined
      }
      taskCenterPendingIntent={taskCenterPendingIntent}
    />
  );

  return (
    <LinkContextMenuProvider>
      <div className="flex h-screen flex-col bg-[var(--paper)]">
        {/* Chrome-style titlebar with tabs */}
        <CustomTitleBar
          onSettingsClick={handleOpenSettings}
          onOpenBugReport={() => setShowBugReport(true)}
          updateReady={updateReady}
          updateVersion={updateVersion}
          updateInstalling={updateInstalling}
          updatePreparing={updatePreparing}
          onRestartAndUpdate={() => void handleRestartAndUpdate()}
          teamSpaceEnabled={teamSpaceAvailable}
          restoreCount={restorePillCount}
          onRestoreSession={handleRestoreLastSession}
          onDismissRestore={handleDismissRestore}
        >
          <TabBar
            tabs={chromeTabs}
            activeTabId={activeTabId}
            onSelectTab={handleSelectTab}
            onCloseTab={handleCloseTab}
            onNewTab={handleNewTab}
            onReorderTabs={handleReorderTabs}
          />
        </CustomTitleBar>

        {/* Tab content - only Chat views need TabProvider for sidecar communication */}
        <div ref={contentRef} className="relative flex-1 overflow-hidden">
          {chromeTabs.map((tab) =>
            renderTabContent(tab, tab.id === activeTabId),
          )}
          <WorkbenchAgentSurfaceHost
            surfaces={agentSurfaceTabs}
            activeSourceTabId={activeTabId}
            renderSurface={renderTabContent}
            onMinimize={handleMinimizeWorkbenchAgentSurface}
            onRestore={selectTabOrRestoreAgentSurface}
            onExpandToTab={handleExpandWorkbenchAgentSurface}
            onReview={handleReviewWorkbenchAgentSurface}
            onRestart={(tabId) => {
              void handleRestartWorkbenchAgentSurface(tabId);
            }}
            onClose={handleHideWorkbenchAgentSurface}
          />
        </div>

        {/* Exit confirmation dialog for running cron tasks */}
        {exitConfirmState && (
          <ConfirmDialog
            title={t("appChrome.exitAppTitle")}
            message={t("appChrome.exitRunningTasksMessage", {
              count: exitConfirmState.runningTaskCount,
            })}
            confirmText={t("appChrome.exit")}
            cancelText={t("appChrome.cancel")}
            confirmVariant="danger"
            onConfirm={() => {
              exitConfirmState.resolve(true);
              setExitConfirmState(null);
            }}
            onCancel={() => {
              exitConfirmState.resolve(false);
              setExitConfirmState(null);
            }}
          />
        )}

        {/* Windows: startup dialog for pending update from previous session.
          Hidden while a silent download is replacing the pending bytes —
          confirming "安装" mid-replacement could land on inconsistent
          cache/disk state. Comes back into view automatically when the
          download completes (the dialog reads pendingUpdateOnStartup, which
          is unchanged; only the visibility gate is `updatePreparing`). */}
        {pendingUpdateOnStartup && !updatePreparing && (
          <ConfirmDialog
            title={t("appChrome.newVersionTitle")}
            message={t("appChrome.newVersionMessage", {
              version: pendingUpdateOnStartup,
            })}
            confirmText={t("appChrome.install")}
            cancelText={t("appChrome.later")}
            confirmVariant="primary"
            onConfirm={() => {
              dismissPendingUpdate();
              // Route through handleRestartAndUpdate so toast feedback fires
              // on failure modes (network error / version mismatch).
              void handleRestartAndUpdate();
            }}
            onCancel={dismissPendingUpdate}
          />
        )}

        {/* Bug report overlay triggered from titlebar feedback button */}
        {showBugReport && (
          <BugReportOverlay
            onClose={() => setShowBugReport(false)}
            onNavigateToProviders={() => {
              setShowBugReport(false);
              handleOpenSettings("providers");
            }}
            appVersion={appVersion}
            providers={appProviders}
            apiKeys={appApiKeys}
            providerVerifyStatus={appProviderVerifyStatus}
            initialProviderId={helperAgentDefaults.initialProviderId}
            initialModel={helperAgentDefaults.initialModel}
            onModelChange={helperAgentDefaults.onModelChange}
            assistantEntry="tab_top"
          />
        )}
      </div>
    </LinkContextMenuProvider>
  );
}
