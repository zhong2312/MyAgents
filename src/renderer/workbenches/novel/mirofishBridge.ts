import type {
  WorkbenchSimulationCapabilities,
  WorkbenchSimulationDataFor,
  WorkbenchSimulationRequest,
  WorkbenchSimulationRun,
  WorkbenchSimulationWorldSnapshot,
  WorkbenchSimulationRuns,
} from "@/workbench-sdk";

import type { WorldGraphPanelData } from "./mirofish/worldGraphData";
import type {
  CouncilRoundInput,
  CouncilRoundOutput,
  CouncilSession,
} from "./mirofish/councilRound";

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
  /** Host 从项目文件读取的会商历史，Vue 表面没有文件系统访问能力。 */
  readonly councilSessions?: readonly CouncilSession[];
}

export interface MiroFishNovelBridge {
  readonly version: typeof MIROFISH_NOVEL_BRIDGE_VERSION;
  loadContext(): Promise<MiroFishNovelContext>;
  refreshRuns(projectId: string): Promise<readonly WorkbenchSimulationRun[]>;
  /** 世界图谱数据：由 Host 在隔离侧构建，Vue 表面只消费投影结果。 */
  loadWorldGraph(): Promise<WorldGraphPanelData>;
  /** 圆桌会商：Host 用模型场景逐轮驱动 LLM 发言与投票。 */
  runCouncilRound(input: CouncilRoundInput): Promise<CouncilRoundOutput>;
  saveCouncilSession?(session: CouncilSession): Promise<void>;
  /** 按操作分派返回类型：get/start/… → WorkbenchSimulationRun。 */
  request<TRequest extends WorkbenchSimulationRequest>(
    request: TRequest,
  ): Promise<WorkbenchSimulationDataFor<TRequest>>;
  navigate(view: MiroFishNovelView): void;
  subscribe(listener: () => void): () => void;
}

interface MiroFishNovelBridgeOptions {
  readonly simulationRuns: WorkbenchSimulationRuns;
  readonly loadSnapshot: () => Promise<WorkbenchSimulationWorldSnapshot>;
  readonly loadWorldGraph: () => Promise<WorldGraphPanelData>;
  readonly runCouncilRound: (input: CouncilRoundInput) => Promise<CouncilRoundOutput>;
  readonly saveCouncilSession?: (session: CouncilSession) => Promise<void>;
  readonly loadCouncilSessions?: () => Promise<readonly CouncilSession[]>;
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
      let councilSessions: readonly CouncilSession[] = [];
      try {
        councilSessions = await options.loadCouncilSessions?.() ?? [];
      } catch {
        // A malformed history must not prevent the world snapshot from opening.
      }
      context = Object.freeze({
        projectId: snapshot.projectId,
        title: snapshot.title,
        snapshot,
        capabilities,
        runs,
        councilSessions,
      });
      notify();
      return context;
    },

    async refreshRuns(projectId: string) {
      return refreshRuns(projectId);
    },

    async loadWorldGraph() {
      return options.loadWorldGraph();
    },

    async runCouncilRound(input: CouncilRoundInput) {
      return options.runCouncilRound(input);
    },

    async saveCouncilSession(session: CouncilSession) {
      await options.saveCouncilSession?.(session);
      if (context) {
        const councilSessions = [
          session,
          ...(context.councilSessions ?? []).filter(
            (item) =>
              item.topic !== session.topic ||
              item.actorIds.join("\u0000") !== session.actorIds.join("\u0000"),
          ),
        ].slice(0, 50);
        context = Object.freeze({ ...context, councilSessions });
        notify();
      }
    },

    async request<TRequest extends WorkbenchSimulationRequest>(
      request: TRequest,
    ): Promise<WorkbenchSimulationDataFor<TRequest>> {
      assertScopedRequest(request);
      const result = await options.simulationRuns.request(request);
      notify();
      return result as WorkbenchSimulationDataFor<TRequest>;
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
