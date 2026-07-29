// Tab types for multi-tab architecture

import type { ImageAttachment } from '@/components/SimpleChatInput';
import type { PermissionMode } from '@/config/types';
import type { CronSchedule, CronEndConditions, CronDelivery, ScheduledTaskKind } from '@/types/cronTask';
import type { RuntimeBackedProviderIdentity } from '../../shared/providerExecution';
import type { OfficialToolId } from '../../shared/official-tools';
import type {
    WorkbenchAgentToolsetRequest,
    WorkbenchModelSelection,
    WorkbenchTabTarget,
} from '../../shared/workbench-sdk';

export interface WorkbenchAgentSurfaceBootstrap {
    readonly title: string;
    readonly initialMessage: string;
    readonly promptId?: string;
    readonly historyGroupPath?: readonly string[];
    readonly modelSelection?: WorkbenchModelSelection;
}

export interface WorkbenchAgentSurfaceState {
    readonly presentation: 'dialog' | 'dock' | 'hidden';
    readonly sourceTabId: string;
    readonly workbenchId: string;
    readonly workspacePath: string;
    readonly conversationKey: string;
    readonly historyGroupPath?: readonly string[];
    readonly toolset?: WorkbenchAgentToolsetRequest;
    readonly bootstrap?: WorkbenchAgentSurfaceBootstrap;
}

/** Cron settings drafted in the launcher input. Sent forward via
 *  `InitialMessage.cron` and consumed by Chat's `autoSend` to switch from
 *  the normal `sendMessage` path to `startCronTask` (PRD 0.2.7). The launcher
 *  only stages these values; the actual `cmd_create_cron_task` happens after
 *  handoff so a user closing the launcher mid-edit doesn't leave orphan crons. */
export interface InitialMessageCron {
    /** Explicit creation surface; never infer Goal identity from schedule shape. */
    taskKind: ScheduledTaskKind;
    /** Schedule (e.g. `every 30m`, cron expression, one-shot at). */
    schedule: CronSchedule;
    /** Whether each tick uses the same session or spawns a fresh one. */
    runMode: 'single_session' | 'new_session';
    endConditions: CronEndConditions;
    notifyEnabled: boolean;
    delivery?: CronDelivery;
    name?: string;
    /** Plain interval (minutes) for back-compat with the legacy field; we
     *  pass it through unchanged so `CronTaskConfig` consumers don't need to
     *  re-derive from the schedule. */
    intervalMinutes: number;
    /** UI-level distinction between "run inline in the current chat" and
     *  "spawn a standalone background task". Mirrors `runMode` semantically
     *  but is what the modal's edit form needs to round-trip correctly:
     *  the modal computes `runMode` from this (Goal forces `single_session`),
     *  so when re-opening the
     *  editor without this field we'd default to `current_session` and
     *  silently rewrite a "新开对话" task as "当前对话".
     *
     *  Launcher-only path also branches on this — `executionTarget ===
     *  'new_task'` short-circuits in `Launcher.handleBrandSend` to create
     *  the task directly without opening a chat tab (matching the modal's
     *  promise: "创建独立定时任务，不占用当前对话"). */
    executionTarget?: 'current_session' | 'new_task';
}

/** Message data passed from Launcher to Chat for auto-send on workspace open.
 *  Security: Only stores providerId, never the API key. Chat builds providerEnv at send time.
 *
 *  Provider/model pairing (PRD 0.2.3):
 *    - builtinSelection: builtin runtime 的 (provider, model) 二元组。类型上强制成对，
 *      消除「传 providerId 不传 model」导致的 env/model 错配（OPEN_AI_DISCUSSION P1）。
 *      只能由 resolveBuiltinSelection helper 构造，不允许手拼。
 *    - runtimeModel: external runtime（CC / Codex / Gemini）的 model；没有 provider 概念。
 *    两者互斥：调用方根据当前 runtime 维度只填其一。
 *
 *  Cron handoff (PRD 0.2.7):
 *    - cron: when set, Chat's autoSend dispatches to `startCronTask(text)` instead
 *      of `sendMessage`. Launcher's cron StatusBar drives this — confirming the
 *      cron dialog populates the field, send carries it forward, Chat lands and
 *      creates the task. Failure path restores all of {text, images, cron} to the
 *      Chat input box so the user can retry without losing their draft. */
export interface InitialMessage {
    text: string;
    images?: ImageAttachment[];
    permissionMode?: PermissionMode;
    mcpEnabledServers?: string[];
    /** PRD 0.2.17 — Claude plugin ids the user chose in Launcher's tool
     *  menu. Carried into the new Tab as initial selection (Chat seeds
     *  workspaceEnabledPlugins from this); mirrors mcpEnabledServers
     *  semantics exactly. */
    enabledPluginIds?: string[];
    enabledOfficialToolIds?: OfficialToolId[];
    /** Builtin runtime 的 (provider, model) 选择 — 类型上强制成对 */
    builtinSelection?: { providerId: string; model: string };
    /** External runtime 的 model — 没有 provider 概念 */
    runtimeModel?: string;
    /** Provider-facing runtime-backed identity, e.g. Managed Codex Provider. */
    providerExecutionIdentity?: RuntimeBackedProviderIdentity;
    /** #324 — 推理强度 setting ('default' | level)。手递（hand-carry）进新 Tab：
     *  launcher 的 agent-config 写盘是异步的，handoff 不能赌它赢过 sidecar 启动
     *  自解析；与 builtinSelection/runtimeModel 同理。 */
    reasoningEffort?: string;
    /** Optional cron task configuration drafted in launcher (PRD 0.2.7). */
    cron?: InitialMessageCron;
    /** Host-managed tools for a controlled workbench conversation. */
    workbenchToolset?: WorkbenchAgentToolsetRequest;
    /** Rebind a workbench toolset without sending a user message. */
    configureWorkbenchToolsetOnly?: boolean;
}

/**
 * Empty workspace opens have no user message, but may still need to carry the
 * Launcher's local execution selection into session birth before async config
 * persistence has refreshed App.configRef.
 */
export interface LaunchSessionBirthHint {
    permissionMode?: PermissionMode | string;
    mcpEnabledServers?: string[];
    enabledPluginIds?: string[];
    enabledOfficialToolIds?: OfficialToolId[];
    builtinSelection?: { providerId: string; model: string };
    runtimeModel?: string;
    providerExecutionIdentity?: RuntimeBackedProviderIdentity;
    reasoningEffort?: string;
}

/**
 * How a freshly-mounted Chat reconciles config with its session's sidecar.
 * Replaces the old `joinedExistingSidecar?: boolean`, whose `undefined → ?? false
 * → push` collapse had no way to express "not decided yet" and silently pushed
 * config onto sidecars that should have been adopted (the #300/#301 stomp class).
 *
 *  - 'push'    — push this tab's config (MCP / agents / model) to the sidecar.
 *                A fresh sidecar this tab spawned (was `joined === false`).
 *  - 'adopt'   — adopt the live sidecar's existing config; do NOT push.
 *                Joined an already-running sidecar (IM / cron / background; was
 *                `joined === true`).
 *  - 'pending' — disposition not yet known: the tab flipped to chat BEFORE
 *                `ensureSessionSidecar` resolved (instant-nav). Chat does NEITHER
 *                push nor adopt until the single post-ensure resolver sets
 *                push|adopt from the authoritative `result.isNew`. Makes "flip
 *                instant without resolving" a typed, safe state — not a stomp.
 *
 * Required on Tab so every constructor must choose (compile-enforced pit of
 * success). Runtime-only — serializeTabs' field whitelist strips it on persist.
 */
export type SidecarConfigDisposition = 'pending' | 'push' | 'adopt';

/** Runtime-only request for Chat to open a workspace file once after mount/activation. */
export interface FilePreviewIntent {
    id: string;
    path: string;
    initialLineNumber?: number;
}

export interface Tab {
    id: string;
    agentDir: string | null;  // null = showing Launcher
    sessionId: string | null; // null = not started
    view: 'launcher' | 'chat' | 'settings' | 'capabilities' | 'taskcenter' | 'space' | 'workbench';
    title: string;            // Display title for the tab
    /** Runtime-only Launcher selection. The Tab owns this projection so the
     * global shell can read the active workspace without a second App mirror. */
    launcherWorkspacePath?: string | null;
    isGenerating?: boolean;   // true = AI is outputting, used for close confirmation
    hasUnread?: boolean;      // true = task completed but user hasn't viewed this tab yet
    initialMessage?: InitialMessage;  // Launcher → Chat auto-send message
    // Note: cronTaskId and sidecarPort are no longer stored in Tab.
    // Sidecar lifecycle is now managed by SidecarManager's Owner model.
    // Use getSessionPort(sessionId) to get the ready port when needed.
    sidecarConfigDisposition: SidecarConfigDisposition;  // push | adopt | pending — see type doc
    /** Runtime-only (never persisted). 'cold' = restored from a previous
     *  session on startup but not yet activated: App renders it as lightweight
     *  tab chrome WITHOUT mounting TabProvider — so no SSE connect, no
     *  ensureSessionSidecar, no recovery timers fire — until the user (or the
     *  initial active-tab activation) opens it. Cleared by
     *  App.activateRestoredTab once its sidecar is ensured. See PRD 0.2.25. */
    restoreState?: 'cold';
    /** Runtime-only (never persisted). Set by floating-ball path actions to
     *  ask the target Chat tab to open a workspace file in its preview surface. */
    pendingFilePreview?: FilePreviewIntent;
    /** Workbench identity and logical route. Present only when view=workbench. */
    workbench?: WorkbenchTabTarget;
    /** Runtime-only host surface for a workbench-launched full conversation. */
    workbenchAgentSurface?: WorkbenchAgentSurfaceState;
    /** Runtime-only history grouping persisted after a pending session receives an id. */
    sessionHistoryGroupPath?: readonly string[];
}

export interface TabState {
    tabs: Tab[];
    activeTabId: string | null;
}

// Maximum number of tabs allowed. The titlebar uses Chrome-like adaptive tab
// sizing, and 12 keeps common multi-session work visible without turning every
// mounted chat tab into unbounded sidecar ownership.
export const MAX_TABS = 12;

export function isWorkbenchAgentSurfaceTab(tab: Tab): boolean {
    return tab.workbenchAgentSurface !== undefined;
}

// Generate unique tab ID
export function generateTabId(): string {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Generate session title from first message
export function generateSessionTitle(firstMessage: string): string {
    const maxLength = 20;
    const trimmed = firstMessage.trim();
    if (!trimmed) {
        return 'New Chat';
    }
    if (trimmed.length <= maxLength) {
        return trimmed;
    }
    return trimmed.slice(0, maxLength) + '...';
}

// Get folder name from path (supports both / and \ separators)
export function getFolderName(path: string): string {
    // Normalize path separators and split
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
}

// Create a new empty tab (shows Launcher)
export function createNewTab(): Tab {
    return {
        id: generateTabId(),
        agentDir: null,
        sessionId: null,
        view: 'launcher',
        title: 'New Tab',
        // A launcher tab carries the benign default; when it flips to chat for a
        // NEW session the flip sets 'push' explicitly anyway. (Never read while
        // the tab is a launcher — Chat isn't mounted.)
        sidecarConfigDisposition: 'push',
    };
}

/**
 * Build the tab patch that flips a tab into the **chat** view — the canonical
 * "open chat" shape. Adopted by the instant-nav launch flips
 * (App.handleLaunchProject); other inline `view:'chat'` flip sites
 * (handleSwitchSession / spawnTabForExistingSession / Scenario-2 attach) should
 * migrate to it. NOTE: the D1 type-guarantee below holds only where this helper
 * is used — inline flips elsewhere are not yet type-guarded.
 *
 * **D1 (instant-nav) — enforced by the type:** a chat flip MUST carry a truthy
 * `sessionId` (a real backend id, or a `pending-<tabId>` placeholder). If it
 * doesn't, TabProvider's session-aware SSE connect effect never fires →
 * `isConnected` stays false forever → autoSend / model-push / loadSession never
 * run → the tab is permanently blank. `sessionId: string` (non-null) makes
 * "flip to chat without a sessionId" a compile error, not a runtime blank tab.
 */
export function buildChatFlipPatch(
    tab: Tab,
    fields: {
        agentDir: string;
        sessionId: string; // D1: non-null by type — cannot flip to chat without one
        title: string;
        initialMessage?: InitialMessage;
        // Required: every chat flip must declare how config reconciles. 'pending'
        // for an instant flip whose disposition the post-ensure resolver will set;
        // 'push'/'adopt' when already known. No default — forcing the choice is the
        // whole point (the old optional boolean is what let the stomp slip through).
        sidecarConfigDisposition: SidecarConfigDisposition;
    },
): Tab {
    // D1 runtime backstop: `sessionId: string` blocks `null` at compile time but
    // not `''`. A falsy sessionId here is a permanent blank tab (TabProvider's SSE
    // connect effect never fires), so fail loud rather than strand the tab.
    if (!fields.sessionId) {
        throw new Error('buildChatFlipPatch: sessionId must be a non-empty id (D1) — flipping to chat without one strands the tab');
    }
    return {
        ...tab,
        agentDir: fields.agentDir,
        sessionId: fields.sessionId,
        view: 'chat',
        title: fields.title,
        // Only attach when provided — undefined must not clobber a prior value
        // mid-launch (matches the existing `...(initialMessage ? {…} : {})` idiom).
        ...(fields.initialMessage ? { initialMessage: fields.initialMessage } : {}),
        // Always set (required) — a chat flip always declares its disposition, and
        // it must OVERWRITE any stale value from `...tab` (a reused tab may carry a
        // prior 'adopt'/'pending').
        sidecarConfigDisposition: fields.sidecarConfigDisposition,
    };
}
