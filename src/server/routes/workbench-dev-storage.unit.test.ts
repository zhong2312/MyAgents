import { afterEach, describe, expect, it, vi } from "vitest";

const projectStore = vi.hoisted(() => ({
  projects: [
    {
      id: "novel-1",
      name: "地图视觉验收",
      path: "F:\\workspace\\MyAgents-test\\小说\\地图视觉验收",
    },
  ] as Record<string, unknown>[],
}));

vi.mock("../utils/admin-config", () => ({
  loadProjects: () => projectStore.projects,
  atomicModifyProjects: async (
    modifier: (
      projects: Record<string, unknown>[],
    ) => Record<string, unknown>[],
  ) => {
    projectStore.projects = await modifier(projectStore.projects);
    return projectStore.projects;
  },
}));

import { handleWorkbenchDevStorageRoute } from "./workbench-dev-storage";

const priorEnabled = process.env.MYAGENTS_BROWSER_DEV_STORAGE;

afterEach(() => {
  if (priorEnabled === undefined) {
    delete process.env.MYAGENTS_BROWSER_DEV_STORAGE;
  } else {
    process.env.MYAGENTS_BROWSER_DEV_STORAGE = priorEnabled;
  }
  projectStore.projects = [
    {
      id: "novel-1",
      name: "地图视觉验收",
      path: "F:\\workspace\\MyAgents-test\\小说\\地图视觉验收",
    },
  ];
});

describe("浏览器开发项目注册表", () => {
  it("在显式启用时读写测试 profile 的项目清单", async () => {
    process.env.MYAGENTS_BROWSER_DEV_STORAGE = "1";

    const loaded = await handleWorkbenchDevStorageRoute(
      "/api/workbench-dev-storage/projects",
      new Request("http://127.0.0.1/api/workbench-dev-storage/projects"),
      "F:\\workspace\\MyAgents-test\\小说\\地图视觉验收",
    );
    expect(loaded?.status).toBe(200);
    await expect(loaded?.json()).resolves.toEqual({
      success: true,
      projects: projectStore.projects,
    });

    const replacement = [
      {
        id: "novel-2",
        name: "新地图项目",
        path: "F:\\workspace\\MyAgents-test\\小说\\新地图项目",
      },
    ];
    const saved = await handleWorkbenchDevStorageRoute(
      "/api/workbench-dev-storage/projects",
      new Request("http://127.0.0.1/api/workbench-dev-storage/projects", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects: replacement }),
      }),
      "F:\\workspace\\MyAgents-test\\小说\\地图视觉验收",
    );
    await expect(saved?.json()).resolves.toEqual({
      success: true,
      projects: replacement,
    });
    expect(projectStore.projects).toEqual(replacement);
  });

  it("未启用时不暴露项目注册表", async () => {
    delete process.env.MYAGENTS_BROWSER_DEV_STORAGE;

    const response = await handleWorkbenchDevStorageRoute(
      "/api/workbench-dev-storage/projects",
      new Request("http://127.0.0.1/api/workbench-dev-storage/projects"),
      "F:\\workspace\\MyAgents-test\\小说\\地图视觉验收",
    );

    expect(response?.status).toBe(404);
  });

  it("拒绝不完整的项目记录", async () => {
    process.env.MYAGENTS_BROWSER_DEV_STORAGE = "1";

    const response = await handleWorkbenchDevStorageRoute(
      "/api/workbench-dev-storage/projects",
      new Request("http://127.0.0.1/api/workbench-dev-storage/projects", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects: [{ id: "incomplete" }] }),
      }),
      "F:\\workspace\\MyAgents-test\\小说\\地图视觉验收",
    );

    expect(response?.status).toBe(400);
    expect(projectStore.projects).toHaveLength(1);
  });
});
