export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024; // 32 MB
export const ATTACHMENTS_DIR_NAME = "attachments";

/**
 * Session ID management for Session-Centric Sidecar architecture
 * New sessions start with a "pending-{tabId}" ID until the backend creates the real session
 */
export const PENDING_SESSION_PREFIX = "pending-";

/** Check if a sessionId is a pending (placeholder) session */
export function isPendingSessionId(
  sessionId: string | null | undefined,
): boolean {
  return sessionId?.startsWith(PENDING_SESSION_PREFIX) ?? false;
}

/** Create a pending session ID for a new tab */
export function createPendingSessionId(tabId: string): string {
  return `${PENDING_SESSION_PREFIX}${tabId}`;
}

/**
 * API endpoints for Skills & Commands management
 */
export const API_ENDPOINTS = {
  // Skills
  SKILLS_LIST: "/api/skills",
  SKILL_DETAIL: (name: string) => `/api/skill/${encodeURIComponent(name)}`,
  SKILL_CREATE: "/api/skill/create",

  // Commands
  COMMANDS_LIST: "/api/command-items",
  COMMAND_DETAIL: (name: string) =>
    `/api/command-item/${encodeURIComponent(name)}`,
  COMMAND_CREATE: "/api/command-item/create",

  // CLAUDE.md
  CLAUDE_MD: "/api/claude-md",

  // Sub-Agents
  AGENTS_LIST: "/api/agents",
  AGENT_DETAIL: (name: string) => `/api/agent/${encodeURIComponent(name)}`,
  AGENT_CREATE: "/api/agent/create",
  AGENT_SYNC_CHECK: "/api/agent/sync-check",
  AGENT_SYNC_FROM_CLAUDE: "/api/agent/sync-from-claude",
  AGENTS_WORKSPACE_CONFIG: "/api/agents/workspace-config",
  AGENTS_ENABLED: "/api/agents/enabled",
  AGENTS_SET: "/api/agents/set",

  // Agent
  OPEN_IN_FINDER: "/agent/open-in-finder",
} as const;

/**
 * File system paths for Skills & Commands
 */
export const FS_PATHS = {
  USER_SKILLS_DIR: "~/.myagents/skills/",
  USER_COMMANDS_DIR: "~/.myagents/commands/",
  PROJECT_SKILLS_DIR: ".claude/skills/",
  PROJECT_COMMANDS_DIR: ".claude/commands/",
  USER_AGENTS_DIR: "~/.myagents/agents/",
  PROJECT_AGENTS_DIR: ".claude/agents/",
} as const;

/**
 * UI z-index layers (ordered from bottom to top)
 */
export const Z_INDEX = {
  MODAL_OVERLAY: 200,
  MODAL_DIALOG: 250,
  TOAST: 300,
  CONFIRM_DIALOG: 300,
} as const;

/**
 * Custom event names for cross-component communication
 */
export const CUSTOM_EVENTS = {
  /** Fired when a user-level skill is copied to project directory */
  SKILL_COPIED_TO_PROJECT: "skill-copied-to-project",
  /** Fired to open Settings page with optional section (e.g., 'mcp', 'providers') */
  OPEN_SETTINGS: "open-settings",
  /** Fired to open the Task Center singleton tab. Optional payload:
   *  `{ autofocusSearch?: boolean }` — when true, the Task list panel
   *  opens its search input and focuses it (used by Launcher 「我的
   *  任务」 tab's search icon to continue the search intent across
   *  tabs instead of forcing the user to re-click). */
  OPEN_TASK_CENTER: "open-task-center",
  /** Fired to open the Team Space singleton tab when the build/runtime gates allow it. */
  OPEN_SPACE: "open-space",
  /** Fired to open a workspace-bound workbench tab. Payload follows OpenWorkbenchRequest. */
  OPEN_WORKBENCH: "open-workbench",
  /**
   * Fired to open a new chat tab primed with `/task-alignment` for a thought.
   * Payload: `{ thoughtId: string; content: string; tags: string[] }`.
   */
  OPEN_AI_DISCUSSION: "open-ai-discussion",
  /** Fired when user tries to open a Session that's already active in another Tab */
  JUMP_TO_TAB: "jump-to-tab",
  /** Fired to launch AI bug report: opens new Chat tab with ~/.myagents workspace */
  LAUNCH_BUG_REPORT: "launch-bug-report",
  /** Fired when a session title changes (auto-generated or user rename) — triggers refetch in history/task center */
  SESSION_TITLE_CHANGED: "session-title-changed",
  /** Fired when project-local Session history grouping changes. */
  SESSION_HISTORY_CHANGED: "session-history-changed",
  /**
   * Fired to open a historical session in a new Chat tab.
   * Payload: `{ sessionId: string; workspacePath: string }`.
   * Used by Task Center's 任务详情 → 执行 session list so clicking a
   * past execution opens it just like clicking an entry in the
   * Launcher's 历史对话 list.
   */
  OPEN_SESSION_IN_NEW_TAB: "open-session-in-new-tab",
  /**
   * Fired from the global link context menu (LinkContextMenuProvider) when the
   * user picks "预览（内置浏览器）" on an external link. Payload:
   * `{ url: string }`. The currently active Chat tab listens; if its split
   * BrowserPanel is available, it calls `preventDefault()` to claim the
   * action. The dispatcher checks `defaultPrevented` and falls back to
   * `openExternal()` (system browser) when no Chat tab handled it.
   */
  OPEN_IN_BROWSER_PANEL: "open-in-browser-panel",
  // CONFIG_CHANGED removed — ConfigProvider shares state via Context, no DOM event bridge needed
} as const;
