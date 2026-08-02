export { defineWorkbench } from "./defineWorkbench";
export { createWorkbenchRegistry, DuplicateWorkbenchError } from "./registry";
export { CustomSelect, OverlayBackdrop, Popover } from "./ui";
export { useCloseLayer } from "./lifecycle";
export { useWorkbenchAvailableProviders } from "./modelCatalog";
export {
  CompactAiRunWindow,
  type CompactAiRunStatus,
  type CompactAiRunWindowProps,
} from "./CompactAiRunWindow";
export {
  ProposalReviewSurface,
  type ProposalReviewSurfaceProps,
} from "./ProposalReviewSurface";
export {
  default as ConfirmDialog,
  type ConfirmDialogProps,
} from "./ConfirmDialog";
export {
  default as DraggableDialogFrame,
  type DraggableDialogFrameProps,
} from "./DraggableDialogFrame";
export { default as WorkbenchHeaderActions } from "./WorkbenchHeaderActions";
export {
  dispatchWorkbenchHostAction,
  subscribeWorkbenchHostAction,
  type WorkbenchHostActionDetail,
  type WorkbenchHostActionFilter,
} from "./hostActions";
export type {
  OverlayBackdropProps,
  PopoverPlacement,
  PopoverProps,
  SelectOption,
} from "./ui";
export type {
  WorkbenchAvailableModel,
  WorkbenchAvailableProvider,
} from "./modelCatalog";
export type { RegisteredWorkbench, WorkbenchRegistry } from "./registry";
export type {
  WorkbenchDefinition,
  WorkbenchDefinitionOptions,
  WorkbenchAgentSessions,
  WorkbenchAgentCompanionModule,
  WorkbenchAgentCompanionProps,
  WorkbenchAiRuns,
  WorkbenchLauncherContribution,
  WorkbenchNavigationGuard,
  WorkbenchProjectCreateRequest,
  WorkbenchProjectCreatorModule,
  WorkbenchProjectCreatorProps,
  WorkbenchRendererContext,
  WorkbenchRendererModule,
  WorkbenchRendererProps,
  WorkbenchShellContribution,
  WorkbenchSimulationRuns,
} from "./types";
export type {
  WorkbenchAiRunRequest,
  WorkbenchAiRunResult,
  WorkbenchAgentSessionRequest,
  WorkbenchAgentCompanionRequest,
  WorkbenchModelSelection,
  WorkbenchProjectInitialization,
  WorkbenchProjectTextFile,
  WorkbenchSimulationActorSnapshot,
  WorkbenchSimulationAuthority,
  WorkbenchSimulationCapabilities,
  WorkbenchSimulationDataFor,
  WorkbenchSimulationEventPage,
  WorkbenchSimulationLocationSnapshot,
  WorkbenchSimulationModelSceneId,
  WorkbenchSimulationModelSelections,
  WorkbenchSimulationRequest,
  WorkbenchSimulationRuleSnapshot,
  WorkbenchSimulationRun,
  WorkbenchSimulationRunStatus,
  WorkbenchSimulationScenario,
  WorkbenchSimulationSourceRef,
  WorkbenchSimulationTimelineEventSnapshot,
  WorkbenchSimulationWorldSnapshot,
  WorkbenchSearch,
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
  WORKBENCH_SIMULATION_REQUEST_VERSION,
  WORKBENCH_SIMULATION_MODEL_SCENE_IDS,
  joinWorkbenchStoragePath,
  normalizeWorkbenchStoragePath,
  WorkbenchStoragePathError,
  WorkbenchStorageUnavailableError,
} from "../../shared/workbench-sdk";
