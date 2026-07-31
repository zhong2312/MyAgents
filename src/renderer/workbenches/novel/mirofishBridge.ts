import type {
  WorkbenchSimulationCapabilities,
  WorkbenchSimulationRequest,
  WorkbenchSimulationRun,
  WorkbenchSimulationWorldSnapshot,
  WorkbenchSimulationRuns,
} from "@/workbench-sdk";

export const MIROFISH_NOVEL_BRIDGE_VERSION = 1 as const;

export type MiroFishNovelView =
  | "overview"
  | "graph"
  | "dynamics"
  | "causal"
  | "council"
  | "reports";

export interface MiroFishNovelContext {
  readonly projectId: string;
  readonly title: string;
  readonly snapshot: WorkbenchSimulationWorldSnapshot;
  readonly capabilities: WorkbenchSimulationCapabilities | null;
  readonly runs: readonly WorkbenchSimulationRun[];
}

export interface MiroFishNovelBridge {
  readonly version: typeof MIROFISH_NOVEL_BRIDGE_VERSION;
  loadContext(): Promise<MiroFishNovelContext>;
  refreshRuns(projectId: string): Promise<readonly WorkbenchSimulationRun[]>;
  request<TRequest extends WorkbenchSimulationRequest>(
    request: TRequest,
  ): Promise<unknown>;
  navigate(view: MiroFishNovelView): void;
  subscribe(listener: () => void): () => void;
}

interface MiroFishNovelBridgeOptions {
  readonly simulationRuns: WorkbenchSimulationRuns;
  readonly loadSnapshot: () => Promise<WorkbenchSimulationWorldSnapshot>;
  readonly onNavigate?: (view: MiroFishNovelView) => void;
}

/**
 * The Vue surface only receives this host-owned object. It never receives a
 * workspace path, a model credential, or a free-form project selector.
 */
export function createMiroFishNovelBridge(
  options: MiroFishNovelBridgeOptions,
): MiroFishNovelBridge {
  const listeners = new Set<() => void>();
  let context: MiroFishNovelContext | null = null;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const refreshRuns = async (projectId: string) => {
    const result = await options.simulationRuns.request({
      version: 1,
      operation: "list",
      projectId,
    });
    const runs = result.runs;
    if (context?.projectId === projectId) {
      context = Object.freeze({ ...context, runs });
      notify();
    }
    return runs;
  };

  const assertScopedRequest = (request: WorkbenchSimulationRequest) => {
    if (request.operation === "capabilities") return;
    if (!context) {
      throw new Error("世界实验室尚未读取当前小说上下文。");
    }
    if (request.operation === "list" && request.projectId !== context.projectId) {
      throw new Error("推演项目必须与当前小说项目一致。");
    }
    if (
      request.operation === "create" &&
      request.snapshot.projectId !== context.projectId
    ) {
      throw new Error("推演快照必须属于当前小说项目。");
    }
    const runId =
      request.operation === "get" ||
      request.operation === "start" ||
      request.operation === "pause" ||
      request.operation === "resume" ||
      request.operation === "advance" ||
      request.operation === "cancel" ||
      request.operation === "events"
        ? request.runId
        : null;
    if (runId && !context.runs.some((run) => run.runId === runId)) {
      throw new Error("推演运行不属于当前小说项目。");
    }
  };

  return Object.freeze({
    version: MIROFISH_NOVEL_BRIDGE_VERSION,

    async loadContext() {
      const snapshot = await options.loadSnapshot();
      let capabilities: WorkbenchSimulationCapabilities | null = null;
      try {
        capabilities = await options.simulationRuns.request({
          version: 1,
          operation: "capabilities",
        });
      } catch {
        // The lab can still inspect the local snapshot when Companion is down.
      }
      let runs: readonly WorkbenchSimulationRun[] = [];
      try {
        runs = await refreshRuns(snapshot.projectId);
      } catch {
        // Keep the connection error local to the Vue surface.
      }
      context = Object.freeze({
        projectId: snapshot.projectId,
        title: snapshot.title,
        snapshot,
        capabilities,
        runs,
      });
      notify();
      return context;
    },

    async refreshRuns(projectId: string) {
      return refreshRuns(projectId);
    },

    async request(request: WorkbenchSimulationRequest) {
      assertScopedRequest(request);
      const result = await options.simulationRuns.request(request);
      notify();
      return result;
    },

    navigate(view: MiroFishNovelView) {
      options.onNavigate?.(view);
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
