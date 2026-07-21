import type { ComponentType } from "react";

import type {
  WorkbenchAiRunRequest,
  WorkbenchAiRunResult,
  WorkbenchAgentSessionRequest,
  WorkbenchManifest,
  WorkbenchProjectInitialization,
  WorkbenchSimulationDataFor,
  WorkbenchSimulationRequest,
  WorkbenchStorage,
} from "../../shared/workbench-sdk";

export interface WorkbenchAgentSessions {
  readonly isAvailable: boolean;
  open(request: WorkbenchAgentSessionRequest): Promise<void>;
}

export interface WorkbenchAiRuns {
  readonly isAvailable: boolean;
  run(request: WorkbenchAiRunRequest): Promise<WorkbenchAiRunResult>;
}

export interface WorkbenchSimulationRuns {
  readonly isAvailable: boolean;
  request<TRequest extends WorkbenchSimulationRequest>(
    request: TRequest,
  ): Promise<WorkbenchSimulationDataFor<TRequest>>;
}

export interface WorkbenchNavigationGuard {
  /** Return true when the pending route change may continue. */
  confirmLeave(): Promise<boolean>;
}

export interface WorkbenchRendererContext {
  readonly manifest: WorkbenchManifest;
  readonly workspacePath: string;
  readonly workspaceName: string;
  readonly route: string;
  readonly isActive: boolean;
  readonly storage: WorkbenchStorage;
  readonly agentSessions: WorkbenchAgentSessions;
  readonly aiRuns: WorkbenchAiRuns;
  readonly simulationRuns: WorkbenchSimulationRuns;
  navigate(route: string): void;
  registerNavigationGuard(guard: WorkbenchNavigationGuard): () => void;
}

export interface WorkbenchRendererProps {
  readonly context: WorkbenchRendererContext;
}

export interface WorkbenchRendererModule {
  readonly default: ComponentType<WorkbenchRendererProps>;
}

export interface WorkbenchProjectCreateRequest {
  readonly workspacePath: string;
  readonly displayName: string;
  readonly icon?: string;
  readonly route?: string;
  readonly initialization: WorkbenchProjectInitialization;
}

export interface WorkbenchProjectCreatorProps {
  readonly defaultParentPath: string;
  onPickDirectory(): Promise<string | null>;
  onCreate(request: WorkbenchProjectCreateRequest): Promise<void>;
  onClose(): void;
}

export interface WorkbenchProjectCreatorModule {
  readonly default: ComponentType<WorkbenchProjectCreatorProps>;
}

export interface WorkbenchLauncherContribution {
  readonly createLabel: string;
  readonly projectTypeLabel: string;
  readonly icon?: string;
  readonly order?: number;
  readonly loadProjectCreator: () => Promise<WorkbenchProjectCreatorModule>;
}

export interface WorkbenchShellContribution {
  readonly defaultNavigationCollapsed?: boolean;
}

export interface WorkbenchDefinition {
  readonly manifest: WorkbenchManifest;
  readonly load: () => Promise<WorkbenchRendererModule>;
  readonly launcher?: WorkbenchLauncherContribution;
  readonly shell?: WorkbenchShellContribution;
}

export interface WorkbenchDefinitionOptions {
  readonly launcher?: WorkbenchLauncherContribution;
  readonly shell?: WorkbenchShellContribution;
}
