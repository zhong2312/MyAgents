import { nextTick } from "@vue/runtime-dom";
import { describe, expect, it, vi } from "vitest";

import type { WorkbenchSimulationWorldSnapshot } from "@/workbench-sdk";

import { mountMiroFishNovelLab } from "./MiroFishNovelLab";
import type {
  MiroFishNovelBridge,
  MiroFishNovelContext,
} from "./mirofishBridge";

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
  ],
} as WorkbenchSimulationWorldSnapshot;

function createBridge(onNavigate = vi.fn()): MiroFishNovelBridge {
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
    runs: [],
  };

  return {
    version: 1,
    loadContext: async () => context,
    refreshRuns: async () => [],
    request: async () => ({}),
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
    expect(target.querySelector("iframe")).toBeNull();

    const graphButton = Array.from(target.querySelectorAll("button")).find(
      (button) => button.textContent === "世界图谱",
    );
    expect(graphButton).toBeDefined();

    graphButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    expect(onNavigate).toHaveBeenCalledWith("graph");
    expect(target.textContent).toContain("图谱投影已就绪");

    unmount();
    expect(target.childElementCount).toBe(0);
  });
});
