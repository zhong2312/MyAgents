import { nextTick } from "@vue/runtime-dom";
import { describe, expect, it, vi } from "vitest";

import type { WorkbenchSimulationRun, WorkbenchSimulationWorldSnapshot } from "@/workbench-sdk";

import { mountMiroFishNovelLab } from "./MiroFishNovelLab";
import type {
  MiroFishNovelBridge,
  MiroFishNovelContext,
} from "./mirofishBridge";

// 上游 GraphPanel.vue 依赖 d3 力导向仿真，jsdom 下 getBBox 等 SVG API 不可用。
// 组件渲染由构建期与桌面壳验证覆盖，这里只验证微应用的接线（加载、切换）。
vi.mock("./mirofish/GraphPanel.vue", () => ({
  default: {
    name: "MockGraphPanel",
    props: {
      graphData: Object,
      loading: Boolean,
      currentPhase: Number,
      isSimulating: Boolean,
      highlightNodeUuid: { type: String, default: null },
    },
    emits: ["refresh", "toggle-maximize"],
    render() {
      return null;
    },
  },
}));

const snapshot = {
  schemaVersion: 1,
  projectId: "novel-lab-test",
  title: "世界实验室验收",
  sourceRevision: "sha256:lab-test",
  anchor: "第三章末",
  actors: [
    {
      id: "actor-1",
      kind: "character",
      name: "陆沉渊",
      summary: "主角",
      locationId: null,
      goals: [],
      traits: [],
      resources: [],
      knowledge: [],
      constraints: [],
      sourceRefs: [],
    },
    {
      id: "faction-1",
      kind: "faction",
      name: "镇夜司",
      summary: "地方势力",
      locationId: null,
      goals: [],
      traits: [],
      resources: [],
      knowledge: [],
      constraints: [],
      sourceRefs: [],
    },
  ],
  locations: [
    {
      id: "location-1",
      name: "临渊城",
      summary: "边城",
      parentId: null,
      sourceRefs: [],
    },
  ],
  rules: [
    {
      id: "rule-1",
      title: "血契",
      description: "不可违背的契约",
      severity: "hard",
      sourceRefs: [],
    },
  ],
  timelineEvents: [
    {
      id: "event-1",
      title: "陆沉渊入城",
      summary: "主角抵达临渊城",
      timeLabel: "第三章",
      actorIds: ["actor-1"],
      locationIds: ["location-1"],
      sourceRefs: [],
    },
    {
      id: "event-2",
      title: "镇夜司盘查",
      summary: "入城后镇夜司开始盘查",
      timeLabel: "第三章末",
      actorIds: ["faction-1"],
      locationIds: ["location-1"],
      causeEventIds: ["event-1"],
      sourceRefs: [],
    },
  ],
} as WorkbenchSimulationWorldSnapshot;

function createBridge(
  onNavigate = vi.fn(),
  loadWorldGraph = vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
  runs: readonly WorkbenchSimulationRun[] = [],
  request = (async () => ({})) as unknown as MiroFishNovelBridge["request"],
): MiroFishNovelBridge {
  const context: MiroFishNovelContext = {
    projectId: snapshot.projectId,
    title: snapshot.title,
    snapshot,
    capabilities: {
      apiVersion: 1,
      engine: "MiroFish",
      engineVersion: "novel-test",
      features: [],
    },
    runs,
  };

  return {
    version: 1,
    loadContext: async () => context,
    refreshRuns: async () => runs,
    loadWorldGraph,
    runCouncilRound: (async () => ({
      statements: [],
      votes: [],
    })) as unknown as MiroFishNovelBridge["runCouncilRound"],
    request,
    navigate: onNavigate,
    subscribe: () => () => undefined,
  };
}

async function settleVue() {
  await Promise.resolve();
  await nextTick();
}

describe("MiroFishNovelLab", () => {
  it("通过 Host Bridge 挂载概览并在同一微应用内切换视图", async () => {
    const target = document.createElement("div");
    const onNavigate = vi.fn();
    const unmount = mountMiroFishNovelLab(target, {
      bridge: createBridge(onNavigate),
    });

    await settleVue();

    expect(target.textContent).toContain("世界实验室验收");
    expect(target.textContent).toContain("第三章末");
    expect(target.textContent).toContain("角色与势力");
    expect(target.textContent).toContain("2");
    expect(target.textContent).toContain("分析链路");
    expect(target.textContent).toContain("事实基线");
    expect(target.textContent).toContain("推演结论");
    expect(target.querySelector("iframe")).toBeNull();

    const graphButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent === "世界图谱",
    );
    expect(graphButton).toBeDefined();

    graphButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    expect(onNavigate).toHaveBeenCalledWith("graph");
    expect(target.textContent).toContain("知识实体、设定、地点与已发生事件的关系投影");
    expect(target.querySelector(".mirofish-lab-graph-panel")).not.toBeNull();

    const causalStep = Array.from(target.querySelectorAll(".mirofish-lab-workflow-step")).find(
      (button) => button.textContent?.includes("因果约束"),
    );
    causalStep?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(onNavigate).toHaveBeenCalledWith("causal");
    expect(target.textContent).toContain("影响后续");

    unmount();
    expect(target.childElementCount).toBe(0);
  });

  it("进入世界图谱时通过 Host Bridge 惰性加载图谱数据", async () => {
    const target = document.createElement("div");
    const loadWorldGraph = vi
      .fn()
      .mockResolvedValue({ nodes: [{ uuid: "n1", name: "测试节点", labels: ["实体"], attributes: {}, summary: "" }], edges: [] });
    const unmount = mountMiroFishNovelLab(target, {
      bridge: createBridge(vi.fn(), loadWorldGraph),
    });

    await settleVue();
    expect(loadWorldGraph).not.toHaveBeenCalled();

    const graphButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent === "世界图谱",
    );
    graphButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleVue();

    expect(loadWorldGraph).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("从事件参与分析选择事实事件后，会将焦点和议题带入会商", async () => {
    const target = document.createElement("div");
    const onNavigate = vi.fn();
    const unmount = mountMiroFishNovelLab(target, {
      bridge: createBridge(onNavigate),
    });

    await settleVue();
    expect(target.textContent).toContain("当前研究事件");
    expect(target.textContent).toContain("镇夜司盘查");

    const dynamicsButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent === "事件参与分析",
    );
    dynamicsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleVue();

    const eventButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("陆沉渊入城"),
    );
    eventButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleVue();

    expect(onNavigate).toHaveBeenCalledWith("causal");
    expect(target.textContent).toContain("已选“陆沉渊入城”");

    const councilButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent === "带入立场会商",
    );
    councilButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleVue();

    const topic = target.querySelector<HTMLInputElement>(
      ".mirofish-lab-council-topic",
    );
    expect(topic?.value).toBe("围绕“陆沉渊入城”，各方下一步应如何行动？");
    expect(target.textContent).toContain("基于 陆沉渊入城 讨论行动分歧");

    unmount();
  });

  it("推演报告视图通过 Host Bridge 读取完整运行并展示事件流", async () => {
    const target = document.createElement("div");
    const run: WorkbenchSimulationRun = {
      schemaVersion: 1,
      runId: "run-1",
      projectId: snapshot.projectId,
      engine: "MiroFish",
      engineVersion: "novel-test",
      status: "completed",
      currentRound: 1,
      maxRounds: 1,
      snapshot,
      scenario: {
        schemaVersion: 1,
        id: "scenario-1",
        name: "封山三日",
        objective: "推演各方反应",
        horizonRounds: 1,
        selectedActorIds: ["actor-1"],
        seedEvents: ["宗门封山"],
        constraints: [],
      },
      rounds: [],
      events: [
        {
          id: "event-1",
          round: 1,
          title: "镇夜司戒严",
          summary: "宗门封山后镇夜司宣布戒严",
          cause: "宗门封山",
          consequence: "城中人心浮动",
          actorIds: ["faction-1"],
        },
      ],
      stateChanges: [
        { entityId: "faction-1", field: "status", before: "active", after: "alert" },
      ],
      warnings: ["封山消息可能引发恐慌"],
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
    };
    const request = vi.fn().mockResolvedValue(run) as unknown as MiroFishNovelBridge["request"];
    const unmount = mountMiroFishNovelLab(target, {
      bridge: createBridge(vi.fn(), vi.fn().mockResolvedValue({ nodes: [], edges: [] }), [run], request),
    });

    await settleVue();

    const reportsButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent === "推演报告",
    );
    reportsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleVue();

    const runButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("封山三日"),
    );
    expect(runButton).toBeDefined();
    runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleVue();

    expect(request).toHaveBeenCalledWith({
      version: 1,
      operation: "get",
      runId: "run-1",
    });
    expect(target.textContent).toContain("镇夜司戒严");
    expect(target.textContent).toContain("状态变化");
    expect(target.textContent).toContain("推演警告");
    expect(target.textContent).toContain("审阅出口");

    unmount();
  });

  it("圆桌会商：填议题选主体后逐轮驱动 LLM 并展示发言", async () => {
    const target = document.createElement("div");
    const runCouncilRound = vi
      .fn()
      .mockResolvedValue({
        statements: [{ actorId: "actor-1", message: "我主张开山门。" }],
        votes: [],
      }) as unknown as MiroFishNovelBridge["runCouncilRound"];
    const bridge = createBridge(
      vi.fn(),
      vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      [],
      (async () => ({})) as unknown as MiroFishNovelBridge["request"],
    );
    bridge.runCouncilRound = runCouncilRound;
    const unmount = mountMiroFishNovelLab(target, { bridge });
    await settleVue();

    const councilButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent === "圆桌会商",
    );
    councilButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleVue();

    // 默认推选前 4 主体（快照有 2 个），填议题后开始会商。
    const topic = target.querySelector<HTMLInputElement>(
      ".mirofish-lab-council-topic",
    );
    expect(topic).not.toBeNull();
    if (topic) {
      topic.value = "封山后各方如何行动？";
      topic.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settleVue();

    const startButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent === "开始会商",
    );
    expect(startButton).toBeDefined();
    startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleVue();

    expect(runCouncilRound).toHaveBeenCalledTimes(1);
    expect(target.textContent).toContain("我主张开山门。");
    expect(target.textContent).toContain("会商实录");

    unmount();
  });

  it("圆桌会商会恢复 Host 提供的项目历史记录", async () => {
    const target = document.createElement("div");
    const bridge = createBridge();
    bridge.loadContext = async () => ({
      projectId: snapshot.projectId,
      title: snapshot.title,
      snapshot,
      capabilities: null,
      runs: [],
      councilSessions: [
        {
          schemaVersion: 1,
          topic: "封山后如何应对",
          actorIds: ["actor-1", "faction-1"],
          maxRounds: 3,
          round: 3,
          history: [{ actorId: "actor-1", message: "先稳住城中人心。" }],
          votes: [{ actorId: "faction-1", choice: "支持" }],
          status: "completed",
          updatedAt: "2026-01-01T00:00:00.000Z",
          error: null,
        },
      ],
    });
    const unmount = mountMiroFishNovelLab(target, { bridge });
    await settleVue();

    const councilButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent === "圆桌会商",
    );
    councilButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleVue();

    expect(target.textContent).toContain("历史会商 · 1 场");
    expect(target.textContent).toContain("封山后如何应对");
    expect(target.textContent).toContain("先稳住城中人心。");
    expect(target.textContent).toContain("投票结果");

    unmount();
  });
});
