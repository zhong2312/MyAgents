export interface WorkbenchTabTarget {
  readonly workbenchId: string;
  readonly route: string;
}

export interface OpenWorkbenchRequest {
  readonly workbenchId: string;
  readonly workspacePath: string;
  readonly route?: string;
  readonly title?: string;
}

export const WORKBENCH_AGENT_SESSION_REQUEST_VERSION = 1 as const;

export type WorkbenchAgentSessionPresentation =
  | "tab"
  | "dialog"
  | "dock"
  | "compact-review"
  /**
   * The real MyAgents conversation and the workbench companion are mounted
   * into two declared regions owned by the active workbench view.
   */
  | "embedded-review";

export interface WorkbenchAgentCompanionRequest {
  /** Workbench-owned companion renderer id. Unknown ids render a safe fallback. */
  readonly id: string;
  /** Small declarative context only; credentials and file contents are forbidden. */
  readonly context?: Readonly<Record<string, string>>;
}

export interface WorkbenchAgentToolsetRequest {
  /** Host-recognized toolset id. Unknown ids are rejected before the turn starts. */
  readonly id: string;
  /** Small declarative context only; credentials and file contents are forbidden. */
  readonly context?: Readonly<Record<string, string>>;
}

/**
 * A project-owned model override selected by a workbench. The host remains
 * responsible for verifying the provider, credentials and model membership
 * immediately before execution.
 */
export interface WorkbenchModelSelection {
  readonly providerId: string;
  readonly model: string;
}

/**
 * A workbench-owned request to open a full MyAgents conversation.
 *
 * The workbench supplies domain context only. Provider selection, permissions,
 * session lifecycle, tabs and runtime ownership remain host responsibilities.
 */
export interface WorkbenchAgentSessionRequest {
  readonly version: typeof WORKBENCH_AGENT_SESSION_REQUEST_VERSION;
  readonly title: string;
  readonly initialMessage: string;
  /** Internal runtime instructions. Never persisted or rendered as a user message. */
  readonly systemPrompt?: string;
  readonly promptId?: string;
  /**
   * Host-owned presentation for the full MyAgents conversation.
   *
   * `tab` preserves the legacy behavior. `dialog` keeps the user inside the
   * current workbench while reusing the same Chat/Session implementation.
   */
  readonly presentation?: WorkbenchAgentSessionPresentation;
  /**
   * Stable DOM-safe identifier supplied by a workbench for an embedded
   * surface. The host derives the conversation and companion mount points
   * from it; no raw selectors or DOM nodes cross the SDK boundary.
   */
  readonly embeddedSurfaceId?: string;
  /** Optional workbench-owned surface rendered beside the real Agent conversation. */
  readonly companion?: WorkbenchAgentCompanionRequest;
  /** Stable task identity used to restore an existing workbench conversation. */
  readonly conversationKey?: string;
  /**
   * Optional project-local history grouping. The host persists at most two
   * levels on the resulting MyAgents Session; omitted sessions stay directly
   * under the project.
   */
  readonly historyGroupPath?: readonly string[];
  /**
   * Force a brand-new conversation for this task key.
   * Clears any live surface / local binding and always sends initialMessage.
   */
  readonly forceNew?: boolean;
  /** Business tools injected by the host for this controlled conversation. */
  readonly toolset?: WorkbenchAgentToolsetRequest;
  /** Optional project-scoped model override for this AI scene. */
  readonly modelSelection?: WorkbenchModelSelection;
}

export const WORKBENCH_AI_RUN_REQUEST_VERSION = 1 as const;

export type WorkbenchAiExecutionProfile = "standard" | "extended";

/**
 * A compact, user-facing projection of a one-shot AI run. This deliberately
 * reports execution activity rather than model reasoning or tool payloads.
 */
export type WorkbenchAiRunProgressKind = "status" | "tool" | "intent";

export interface WorkbenchAiRunProgress {
  readonly runId: string;
  readonly kind: WorkbenchAiRunProgressKind;
  readonly message: string;
  /** Optional generated-text preview for workbench-owned streaming output. */
  readonly partialOutput?: string;
  /** Monotonically increasing within a single one-shot run. */
  readonly revision: number;
}

export interface WorkbenchAiRunRequest {
  readonly version: typeof WORKBENCH_AI_RUN_REQUEST_VERSION;
  /** Optional caller-owned correlation ID for live status projection. */
  readonly runId?: string;
  readonly label: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  /** Host-owned execution budget. Extended runs remain strictly bounded. */
  readonly executionProfile?: WorkbenchAiExecutionProfile;
  /** Host-clamped deadline for complex one-shot workflows. */
  readonly timeoutMs?: number;
  /** Host-clamped turn budget for complex one-shot workflows. */
  readonly maxTurns?: number;
  /** Request a bounded text preview stream; callers pair it with runId polling. */
  readonly streamOutput?: boolean;
  /** Optional host-owned read-only business tools for this one-shot run. */
  readonly toolset?: WorkbenchAgentToolsetRequest;
  /** Optional project-scoped model override for this AI scene. */
  readonly modelSelection?: WorkbenchModelSelection;
}

export interface WorkbenchAiRunResult {
  readonly output: string;
}

export const WORKBENCH_PROJECT_INITIALIZATION_VERSION = 1 as const;

export interface WorkbenchProjectTextFile {
  /** Workspace-relative path using `/` separators. */
  readonly path: string;
  /** UTF-8 text written exactly as provided. */
  readonly content: string;
}

/**
 * Declarative, workbench-owned project layout consumed by the MyAgents host.
 *
 * The host validates every relative path and commits the complete layout as one
 * new workspace directory. It does not interpret any workbench-specific file.
 */
export interface WorkbenchProjectInitialization {
  readonly version: typeof WORKBENCH_PROJECT_INITIALIZATION_VERSION;
  readonly directories: readonly string[];
  readonly files: readonly WorkbenchProjectTextFile[];
  readonly initializeGit?: boolean;
}
