import { describe, expect, it, vi } from "vitest";

import type {
  WorkbenchSimulationRequest,
  WorkbenchSimulationWorldSnapshot,
  WorkbenchSimulationRuns,
} from "@/workbench-sdk";

import { createMiroFishNovelBridge } from "./mirofishBridge";

const snapshot = {
  schemaVersion: 1,
  projectId: "novel-bridge-test",
  title: "桥接测试",
  sourceRevision: "sha256:test",
  anchor: "第一章",
  actors: [],
  locations: [],
  rules: [],
  timelineEvents: [],
} as WorkbenchSimulationWorldSnapshot;

function createRunsClient(
  handler: (request: WorkbenchSimulationRequest) => Promise<unknown>,
): WorkbenchSimulationRuns {
  return {
    isAvailable: true,
    request: handler as WorkbenchSimulationRuns["request"],
  };
}

describe("MiroFish novel Host Bridge", () => {
  it("自动绑定快照项目并隐藏项目路径选择", async () => {
    const requests: WorkbenchSimulationRequest[] = [];
    const bridge = createMiroFishNovelBridge({
      simulationRuns: createRunsClient(async (request) => {
        requests.push(request);
        if (request.operation === "capabilities") {
          return {
            apiVersion: 1,
            engine: "MiroFish",
            engineVersion: "novel",
            features: [],
          };
        }
        return { runs: [] };
      }),
      loadSnapshot: async () => snapshot,
      loadWorldGraph: async () => ({ nodes: [], edges: [] }),
      runCouncilRound: async () => ({ statements: [], votes: [] }),
    });

    const context = await bridge.loadContext();

    expect(context.projectId).toBe(snapshot.projectId);
    expect(requests).toEqual([
      { version: 1, operation: "capabilities" },
      { version: 1, operation: "list", projectId: snapshot.projectId },
    ]);
    expect(JSON.stringify(requests)).not.toContain("workspacePath");
  });

  it("服务不可用时仍能展示本地事实快照", async () => {
    const bridge = createMiroFishNovelBridge({
      simulationRuns: createRunsClient(async () => {
        throw new Error("companion unavailable");
      }),
      loadSnapshot: async () => snapshot,
      loadWorldGraph: async () => ({ nodes: [], edges: [] }),
      runCouncilRound: async () => ({ statements: [], votes: [] }),
    });

    await expect(bridge.loadContext()).resolves.toMatchObject({
      projectId: snapshot.projectId,
      snapshot,
      capabilities: null,
      runs: [],
    });
  });

  it("导航只通过 Host 回调传播", async () => {
    const onNavigate = vi.fn();
    const bridge = createMiroFishNovelBridge({
      simulationRuns: createRunsClient(async () => ({ runs: [] })),
      loadSnapshot: async () => snapshot,
      loadWorldGraph: async () => ({ nodes: [], edges: [] }),
      runCouncilRound: async () => ({ statements: [], votes: [] }),
      onNavigate,
    });

    bridge.navigate("graph");

    expect(onNavigate).toHaveBeenCalledWith("graph");
  });

  it("拒绝跨项目请求和未知运行", async () => {
    const request = vi.fn(async () => ({ runs: [] }));
    const bridge = createMiroFishNovelBridge({
      simulationRuns: createRunsClient(request),
      loadSnapshot: async () => snapshot,
      loadWorldGraph: async () => ({ nodes: [], edges: [] }),
      runCouncilRound: async () => ({ statements: [], votes: [] }),
    });
    await bridge.loadContext();

    await expect(
      bridge.request({ version: 1, operation: "list", projectId: "other" }),
    ).rejects.toThrow("当前小说项目");
    await expect(
      bridge.request({ version: 1, operation: "get", runId: "novel-run-other" }),
    ).rejects.toThrow("不属于当前小说项目");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("世界图谱数据由 Host 在隔离侧构建并原样转发", async () => {
    const graphData = {
      nodes: [{ uuid: "n1", name: "灵墟", labels: ["实体"], attributes: {}, summary: "" }],
      edges: [],
    };
    const bridge = createMiroFishNovelBridge({
      simulationRuns: createRunsClient(async () => ({ runs: [] })),
      loadSnapshot: async () => snapshot,
      loadWorldGraph: async () => graphData,
      runCouncilRound: async () => ({ statements: [], votes: [] }),
    });

    await expect(bridge.loadWorldGraph()).resolves.toBe(graphData);
  });

  it("圆桌会商由 Host 驱动并原样转发", async () => {
    const council = {
      statements: [{ actorId: "a1", message: "开山门" }],
      votes: [{ actorId: "a1", choice: "支持" }],
    };
    const bridge = createMiroFishNovelBridge({
      simulationRuns: createRunsClient(async () => ({ runs: [] })),
      loadSnapshot: async () => snapshot,
      loadWorldGraph: async () => ({ nodes: [], edges: [] }),
      runCouncilRound: async () => council,
    });

    await expect(
      bridge.runCouncilRound({
        topic: "封山",
        actors: [{ id: "a1", name: "陆沉渊", kind: "character", goals: [], resources: [], constraints: [] }],
        round: 1,
        maxRounds: 3,
        history: [],
        isFinal: false,
      }),
    ).resolves.toBe(council);
  });

  it("会商历史由 Host 从项目文件读取后传递给微应用", async () => {
    const sessions = [
      {
        schemaVersion: 1 as const,
        topic: "封山后如何应对",
        actorIds: ["a1"],
        maxRounds: 3,
        round: 3,
        history: [{ actorId: "a1", message: "先稳住城中人心。" }],
        votes: [{ actorId: "a1", choice: "支持" }],
        status: "completed" as const,
        updatedAt: "2026-01-01T00:00:00.000Z",
        error: null,
      },
    ];
    const bridge = createMiroFishNovelBridge({
      simulationRuns: createRunsClient(async () => ({ runs: [] })),
      loadSnapshot: async () => snapshot,
      loadWorldGraph: async () => ({ nodes: [], edges: [] }),
      runCouncilRound: async () => ({ statements: [], votes: [] }),
      loadCouncilSessions: async () => sessions,
    });

    await expect(bridge.loadContext()).resolves.toMatchObject({
      councilSessions: sessions,
    });
  });
});
