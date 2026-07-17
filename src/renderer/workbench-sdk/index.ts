export { defineWorkbench } from "./defineWorkbench";
export { createWorkbenchRegistry, DuplicateWorkbenchError } from "./registry";
export { CustomSelect, Popover } from "./ui";
export {
  CompactAiRunWindow,
  type CompactAiRunStatus,
  type CompactAiRunWindowProps,
} from "./CompactAiRunWindow";
export {
  ProposalReviewSurface,
  type ProposalReviewSurfaceProps,
} from "./ProposalReviewSurface";
export type { PopoverPlacement, PopoverProps, SelectOption } from "./ui";
export type { RegisteredWorkbench, WorkbenchRegistry } from "./registry";
export type {
  WorkbenchDefinition,
  WorkbenchDefinitionOptions,
  WorkbenchAgentSessions,
  WorkbenchAiRuns,
  WorkbenchLauncherContribution,
  WorkbenchProjectCreateRequest,
  WorkbenchProjectCreatorModule,
  WorkbenchProjectCreatorProps,
  WorkbenchRendererContext,
  WorkbenchRendererModule,
  WorkbenchRendererProps,
  WorkbenchShellContribution,
} from "./types";
export type {
  WorkbenchAiRunRequest,
  WorkbenchAiRunResult,
  WorkbenchAgentSessionRequest,
  WorkbenchProjectInitialization,
  WorkbenchProjectTextFile,
  WorkbenchCreateTextOptions,
  WorkbenchRemoveOptions,
  WorkbenchStorage,
  WorkbenchStorageChange,
  WorkbenchStorageEntry,
  WorkbenchStorageEntryKind,
  WorkbenchStoragePathInfo,
  WorkbenchStorageSubscription,
  WorkbenchStorageTransfer,
  WorkbenchStorageTransferResult,
  WorkbenchTextFile,
  WorkbenchWriteTextOptions,
} from "../../shared/workbench-sdk";
export {
  WORKBENCH_AI_RUN_REQUEST_VERSION,
  WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
  WORKBENCH_PROJECT_INITIALIZATION_VERSION,
  joinWorkbenchStoragePath,
  normalizeWorkbenchStoragePath,
  WorkbenchStoragePathError,
  WorkbenchStorageUnavailableError,
} from "../../shared/workbench-sdk";
