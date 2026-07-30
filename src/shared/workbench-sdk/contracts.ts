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
  | "compact-review";

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
  readonly promptId?: string;
  /**
   * Host-owned presentation for the full MyAgents conversation.
   *
   * `tab` preserves the legacy behavior. `dialog` keeps the user inside the
   * current workbench while reusing the same Chat/Session implementation.
   */
  readonly presentation?: WorkbenchAgentSessionPresentation;
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

export interface WorkbenchAiRunRequest {
  readonly version: typeof WORKBENCH_AI_RUN_REQUEST_VERSION;
  readonly label: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  /** Optional project-scoped model override for this AI scene. */
  readonly modelSelection?: WorkbenchModelSelection;
}

export interface WorkbenchAiRunResult {
  readonly output: string;
}

export const WORKBENCH_SIMULATION_REQUEST_VERSION = 1 as const;

export type WorkbenchSimulationAuthority =
  | "canon"
  | "actual"
  | "planned"
  | "belief"
  | "author-secret";

export interface WorkbenchSimulationSourceRef {
  readonly path: string;
  readonly sourceHash: string;
  readonly authority: WorkbenchSimulationAuthority;
}

export interface WorkbenchSimulationActorSnapshot {
  readonly id: string;
  readonly name: string;
  readonly kind: "character" | "faction" | "group";
  readonly summary: string;
  readonly locationId: string | null;
  readonly goals: readonly string[];
  readonly traits: readonly string[];
  readonly resources: readonly string[];
  readonly knowledge: readonly string[];
  readonly constraints: readonly string[];
  readonly sourceRefs: readonly WorkbenchSimulationSourceRef[];
}

export interface WorkbenchSimulationLocationSnapshot {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly parentId: string | null;
  readonly sourceRefs: readonly WorkbenchSimulationSourceRef[];
}

export interface WorkbenchSimulationRuleSnapshot {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: "hard" | "soft";
  readonly sourceRefs: readonly WorkbenchSimulationSourceRef[];
}

export interface WorkbenchSimulationTimelineEventSnapshot {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly timeLabel: string;
  readonly actorIds: readonly string[];
  readonly locationIds: readonly string[];
  readonly sourceRefs: readonly WorkbenchSimulationSourceRef[];
}

export interface WorkbenchSimulationWorldSnapshot {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly title: string;
  readonly sourceRevision: string;
  readonly anchor: string;
  readonly actors: readonly WorkbenchSimulationActorSnapshot[];
  readonly locations: readonly WorkbenchSimulationLocationSnapshot[];
  readonly rules: readonly WorkbenchSimulationRuleSnapshot[];
  readonly timelineEvents: readonly WorkbenchSimulationTimelineEventSnapshot[];
}

export interface WorkbenchSimulationScenario {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly objective: string;
  readonly horizonRounds: number;
  readonly selectedActorIds: readonly string[];
  readonly seedEvents: readonly string[];
  readonly constraints: readonly string[];
}

export const WORKBENCH_SIMULATION_MODEL_SCENE_IDS = [
  "simulation.actor",
  "simulation.world",
  "simulation.resolve",
  "simulation.report",
] as const;

export type WorkbenchSimulationModelSceneId =
  (typeof WORKBENCH_SIMULATION_MODEL_SCENE_IDS)[number];

export type WorkbenchSimulationModelSelections = Readonly<
  Partial<
    Record<
      WorkbenchSimulationModelSceneId,
      WorkbenchModelSelection
    >
  >
>;

export type WorkbenchSimulationRunStatus =
  | "draft"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface WorkbenchSimulationRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly status: WorkbenchSimulationRunStatus;
  readonly currentRound: number;
  readonly maxRounds: number;
  readonly snapshot: WorkbenchSimulationWorldSnapshot;
  readonly scenario: WorkbenchSimulationScenario;
  readonly rounds: readonly Readonly<Record<string, unknown>>[];
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly stateChanges: readonly Readonly<Record<string, unknown>>[];
  readonly warnings: readonly string[];
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface WorkbenchSimulationCapabilities {
  readonly apiVersion: number;
  readonly engine: string;
  readonly engineVersion: string;
  readonly features: readonly string[];
}

interface WorkbenchSimulationRequestBase {
  readonly version: typeof WORKBENCH_SIMULATION_REQUEST_VERSION;
}

export type WorkbenchSimulationRequest =
  | (WorkbenchSimulationRequestBase & { readonly operation: "capabilities" })
  | (WorkbenchSimulationRequestBase & {
      readonly operation: "list";
      readonly projectId: string;
    })
  | (WorkbenchSimulationRequestBase & {
      readonly operation: "create";
      readonly snapshot: WorkbenchSimulationWorldSnapshot;
      readonly scenario: WorkbenchSimulationScenario;
      readonly modelSelections?: WorkbenchSimulationModelSelections;
    })
  | (WorkbenchSimulationRequestBase & {
      readonly operation:
        | "get"
        | "start"
        | "pause"
        | "resume"
        | "advance"
        | "cancel";
      readonly runId: string;
    })
  | (WorkbenchSimulationRequestBase & {
      readonly operation: "events";
      readonly runId: string;
      readonly after?: number;
      readonly limit?: number;
    });

export interface WorkbenchSimulationEventPage {
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly nextCursor: number;
  readonly total: number;
}

export type WorkbenchSimulationDataFor<
  TRequest extends WorkbenchSimulationRequest,
> = TRequest["operation"] extends "capabilities"
  ? WorkbenchSimulationCapabilities
  : TRequest["operation"] extends "list"
    ? { readonly runs: readonly WorkbenchSimulationRun[] }
    : TRequest["operation"] extends "events"
      ? WorkbenchSimulationEventPage
      : WorkbenchSimulationRun;

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
