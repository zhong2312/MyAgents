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
});
