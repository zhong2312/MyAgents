import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createEmptyCultivationEcology,
  cultivationEcologySchema,
} from "../../../shared/workbenches/novel/cultivationEcologySchema";
import { createCultivationEcologyFiles } from "../../../shared/workbenches/novel/cultivationEcologyStorage";
import { createEmptyNovelStorage } from "./shared/infrastructure/testStorage";
import CultivationEcologyWorkbench from "./CultivationEcologyWorkbench";

function ecologyWithLevelAndStage() {
  return cultivationEcologySchema.parse({
    ...createEmptyCultivationEcology(),
    systems: [
      {
        id: "system-1",
        name: "玄门",
        summary: "",
        kind: "修仙",
        terminology: { energy: "", stage: "", method: "", ability: "" },
        projection: {
          originIds: [],
          manifestationIds: [],
          access: "",
          translation: "",
          medium: "",
          attenuation: "",
        },
        theoryModel: {
          statement: "",
          summary: "",
          nodeTypes: [],
          invariants: [],
          validationRules: [],
          nodeCatalog: [],
        },
        progressionTracks: [
          {
            id: "track-1",
            name: "主修",
            summary: "",
            mode: "",
            structure: "ordered",
            metrics: [
              {
                id: "metric-1",
                name: "境界强度",
                summary: "衡量境界积累。",
                unit: "点",
                model: "number",
                direction: "higher-better",
                baseline: "10",
              },
            ],
            levels: [
              {
                id: "level-1",
                name: "一境",
                summary: "",
                order: 0,
                stageType: "",
                metricThresholds: [
                  { metricId: "metric-1", threshold: "100 点" },
                ],
                quality: "",
                entryConditions: [],
                maintenanceConditions: [],
                breakthroughConditions: [],
                breakthroughResult: "",
                failureConsequences: [],
                degeneration: "",
                resourceRequirements: [],
                naturalAbilityIds: [],
                methodIds: [],
                subStages: [
                  {
                    id: "stage-1",
                    name: "初期",
                    summary: "",
                    order: 0,
                    metricThresholds: [],
                    entryConditions: [],
                    completionConditions: [],
                    resourceRequirements: [],
                    naturalAbilityIds: [],
                    methodIds: [],
                  },
                  {
                    id: "stage-2",
                    name: "中期",
                    summary: "",
                    order: 1,
                    metricThresholds: [],
                    entryConditions: [],
                    completionConditions: [],
                    resourceRequirements: [],
                    naturalAbilityIds: [],
                    methodIds: [],
                  },
                ],
              },
              {
                id: "level-2",
                name: "二境",
                summary: "",
                order: 1,
                stageType: "",
                metricThresholds: [],
                quality: "",
                entryConditions: [],
                maintenanceConditions: [],
                breakthroughConditions: [],
                breakthroughResult: "",
                failureConsequences: [],
                degeneration: "",
                resourceRequirements: [],
                naturalAbilityIds: [],
                methodIds: [],
                subStages: [],
              },
            ],
            transitions: [
              {
                id: "transition-1",
                name: "一境入二境",
                summary: "完成境界跃迁。",
                fromLevelId: "level-1",
                toLevelId: "level-2",
                transitionType: "breakthrough",
                methodIds: [],
                conditions: ["积累圆满"],
                resourceRequirements: [],
                successRule: "通过突破判定",
                successResult: "进入二境",
                failureResult: "境界受损",
                permanentConsequence: "",
                reversible: false,
              },
            ],
          },
          {
            id: "track-2",
            name: "炼体",
            summary: "",
            mode: "",
            structure: "ordered",
            metrics: [],
            levels: [
              {
                id: "level-body-1",
                name: "锻体",
                summary: "",
                order: 0,
                stageType: "",
                metricThresholds: [],
                quality: "",
                entryConditions: [],
                maintenanceConditions: [],
                breakthroughConditions: [],
                breakthroughResult: "",
                failureConsequences: [],
                degeneration: "",
                resourceRequirements: [],
                naturalAbilityIds: [],
                methodIds: [],
                subStages: [],
              },
            ],
            transitions: [],
          },
        ],
        trackInteractions: [
          {
            id: "interaction-1",
            name: "主炼协同",
            summary: "主修和炼体互相增益。",
            sourceTrackId: "track-1",
            targetTrackId: "track-2",
            kind: "synergy",
            rule: "炼体达到锻体后提高主修承载。",
            conditions: ["炼体达到锻体"],
            consequence: "突破更加稳定",
            resourcePolicy: "药材优先分配给较弱轨道",
            reversible: true,
          },
        ],
        resources: [],
        methods: [],
        abilities: [],
        formations: [],
        foundations: [],
        transitions: [],
        constraints: [],
        audit: [],
      },
    ],
  });
}

async function expectFrozenHeaderDelete(
  triggerName: string | RegExp,
  confirmTitle: string,
) {
  await renderProgression();
  fireEvent.click(screen.getByRole("button", { name: triggerName }));

  const inspector = document.querySelector(".ce-progression-inline-inspector");
  const header = inspector?.querySelector(
    ".ce-progression-inline-inspector-header",
  );
  const body = inspector?.querySelector(
    ".ce-progression-inline-inspector-body",
  );
  expect(inspector).not.toBeNull();
  expect(header).not.toBeNull();
  expect(body).not.toBeNull();
  expect(
    await within(header as HTMLElement).findByRole("button", {
      name: "删除对象",
    }),
  ).toBeInTheDocument();
  expect(
    within(body as HTMLElement).queryByRole("button", {
      name: "删除对象",
    }),
  ).not.toBeInTheDocument();

  fireEvent.click(
    within(header as HTMLElement).getByRole("button", {
      name: "删除对象",
    }),
  );
  expect(
    await screen.findByText(confirmTitle, { exact: true }),
  ).toBeInTheDocument();
}

async function renderProgression() {
  const storage = createEmptyNovelStorage();
  for (const file of createCultivationEcologyFiles(
    ecologyWithLevelAndStage(),
  )) {
    await storage.createText(file.path, file.content, {
      createParents: true,
    });
  }

  render(
    <CultivationEcologyWorkbench
      storage={storage}
      projectTitle="测试小说"
      registerNavigationGuard={() => () => {}}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "成长" }));
}

describe("CultivationEcologyWorkbench 境界检查器", () => {
  it("体系内每个模块页签都不再重复显示页面标题块", async () => {
    await renderProgression();

    const moduleNav = screen.getByRole("navigation", {
      name: "修行体系模块",
    });
    const moduleLabels = [
      "总览",
      "本源",
      "理论",
      "成长",
      "资源",
      "法门",
      "能力",
      "阵法",
      "资产",
      "根基",
      "跃迁",
      "约束",
      "审查",
    ];

    for (const label of moduleLabels) {
      fireEvent.click(within(moduleNav).getByRole("button", { name: label }));
      expect(
        document.querySelector(".ce-main-scroll > .ce-page-header"),
      ).toBeNull();
    }
  });

  it("能力页将获取方式与功能类型筛选分组展示", async () => {
    await renderProgression();

    fireEvent.click(screen.getByRole("button", { name: "能力" }));

    const acquisitionGroup = screen.getByRole("group", { name: "获取方式" });
    const functionGroup = screen.getByRole("group", { name: "功能类型" });
    expect(acquisitionGroup).toBeInTheDocument();
    expect(functionGroup).toBeInTheDocument();
    expect(
      within(acquisitionGroup).getByRole("button", { name: /全部/u }),
    ).toBeInTheDocument();
    expect(
      within(functionGroup).getByRole("button", { name: "全部" }),
    ).toBeInTheDocument();
    expect(
      within(functionGroup).getByRole("button", { name: "辅助类" }),
    ).toBeInTheDocument();
  });

  it("把境界删除入口放在冻结头部并保留确认流程", async () => {
    await expectFrozenHeaderDelete(/一境.*2 个阶段/u, "删除「一境」");
  });

  it("把境内阶段删除入口放在冻结头部并保留确认流程", async () => {
    await expectFrozenHeaderDelete(/初期/u, "删除「初期」");
  });

  it("切换并行轨道后直接在右侧编辑轨道", async () => {
    await renderProgression();

    fireEvent.click(screen.getByRole("button", { name: /炼体.*1 个境界/u }));
    expect(screen.queryByRole("dialog", { name: "对象检查" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑轨道" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /锻体.*0 个阶段/u }),
    ).toBeVisible();

    const inspector = document.querySelector(
      ".ce-progression-inline-inspector-body",
    );
    expect(inspector).not.toBeNull();
    expect(
      within(inspector as HTMLElement).getByDisplayValue("炼体"),
    ).toBeInTheDocument();
    fireEvent.click(
      within(inspector as HTMLElement).getByRole("button", {
        name: "前移轨道",
      }),
    );
    expect(
      [...document.querySelectorAll(".cp-track-item")].map((node) =>
        node.textContent?.replace(/\s+/gu, ""),
      ),
    ).toEqual(["01炼体线性递进·1个境界", "02主修线性递进·2个境界"]);
  });

  it("空的转换和交叉规则页签不会回跳到境界图", async () => {
    await renderProgression();

    fireEvent.click(screen.getByTitle("新增并行轨道"));
    const prototype = await screen.findByRole("region", {
      name: "成长轨道与境界地图",
    });
    expect(
      within(prototype).getByDisplayValue("新成长轨道"),
    ).toBeInTheDocument();

    const transitionTab = within(prototype).getByRole("tab", {
      name: /转换.*0/u,
    });
    fireEvent.click(transitionTab);
    expect(transitionTab).toHaveAttribute("aria-selected", "true");
    expect(within(prototype).getByText("当前轨道尚未定义转换")).toBeVisible();
    expect(
      within(prototype).getByRole("tab", { name: /境界图/u }),
    ).toHaveAttribute("aria-selected", "false");

    const interactionTab = within(prototype).getByRole("tab", {
      name: /交叉规则.*0/u,
    });
    fireEvent.click(interactionTab);
    expect(interactionTab).toHaveAttribute("aria-selected", "true");
    expect(within(prototype).getByText("当前轨道没有交叉规则")).toBeVisible();
  });

  it("阵图工具栏操作不会退出全屏编辑状态", async () => {
    await renderProgression();

    fireEvent.click(screen.getByRole("button", { name: "阵法" }));
    fireEvent.click(await screen.findByRole("button", { name: "新增阵法" }));
    const inspector = await screen.findByRole("dialog", { name: "对象检查" });
    fireEvent.click(
      within(inspector).getByRole("button", { name: "关闭检查器" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "全屏编辑" }));

    const actionNames = [
      "经典",
      "魔眼",
      "星盘",
      "八门",
      "新增环层",
      "新增阵元",
      "新增流向",
      "同心布局",
    ];
    for (const actionName of actionNames) {
      const editor = await screen.findByRole("dialog", { name: "新阵法" });
      const toolbar = editor.querySelector(".ce-formation-canvas-toolbar");
      expect(toolbar).not.toBeNull();
      fireEvent.click(
        within(toolbar as HTMLElement).getByRole("button", {
          name: actionName,
        }),
      );
      expect(
        screen.getByRole("dialog", { name: "新阵法" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "对象检查" })).toBeNull();
    }
  });

  it("在正式三栏工作面选择业务对象后直接在右侧编辑", async () => {
    await renderProgression();

    let prototype = await screen.findByRole("region", {
      name: "成长轨道与境界地图",
    });
    expect(prototype).toHaveClass("is-embedded");
    expect(within(prototype).queryByText("成长工作台 · 完整模型")).toBeNull();
    expect(within(prototype).queryByLabelText("数据模型路径")).toBeNull();
    expect(
      document.querySelector(".ce-main-scroll-progression"),
    ).not.toBeNull();
    expect(within(prototype).getByText("一境")).toBeVisible();
    expect(within(prototype).getByDisplayValue("主修")).toBeInTheDocument();

    fireEvent.click(within(prototype).getByRole("button", { name: /炼体/u }));
    prototype = await screen.findByRole("region", {
      name: "成长轨道与境界地图",
    });
    expect(within(prototype).getByText("锻体")).toBeVisible();
    expect(within(prototype).getByDisplayValue("炼体")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "对象检查" })).toBeNull();

    fireEvent.click(within(prototype).getByRole("button", { name: /主修/u }));
    prototype = await screen.findByRole("region", {
      name: "成长轨道与境界地图",
    });
    fireEvent.click(within(prototype).getByRole("button", { name: /初期/u }));
    expect(within(prototype).getByDisplayValue("初期")).toBeInTheDocument();

    fireEvent.click(within(prototype).getByRole("tab", { name: /指标/u }));
    fireEvent.click(
      within(prototype).getByRole("button", { name: /境界强度/u }),
    );
    expect(within(prototype).getByDisplayValue("境界强度")).toBeInTheDocument();

    fireEvent.click(within(prototype).getByRole("tab", { name: /转换/u }));
    fireEvent.click(
      within(prototype).getByRole("button", { name: /一境入二境/u }),
    );
    expect(
      within(prototype).getByDisplayValue("一境入二境"),
    ).toBeInTheDocument();

    fireEvent.click(within(prototype).getByRole("tab", { name: /交叉规则/u }));
    fireEvent.click(
      within(prototype).getByRole("button", { name: /主炼协同/u }),
    );
    expect(within(prototype).getByDisplayValue("主炼协同")).toBeInTheDocument();

    expect(screen.queryByRole("dialog", { name: "对象检查" })).toBeNull();
    expect(
      within(prototype).queryByRole("button", { name: "编辑对象" }),
    ).toBeNull();
  });

  it("通过移动操作统一境界与阶段的显示顺序", async () => {
    await renderProgression();

    fireEvent.click(screen.getByRole("button", { name: /一境.*2 个阶段/u }));
    const levelInspector = document.querySelector(
      ".ce-progression-inline-inspector-body",
    );
    expect(levelInspector).not.toBeNull();
    expect(
      within(levelInspector as HTMLElement).queryByText("境界顺序"),
    ).toBeNull();
    fireEvent.click(
      within(levelInspector as HTMLElement).getByRole("button", {
        name: "后移境界",
      }),
    );
    expect(
      [...document.querySelectorAll(".cp-level-node strong")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["二境", "一境"]);

    fireEvent.click(screen.getByRole("button", { name: /初期/u }));
    const stageInspector = document.querySelector(
      ".ce-progression-inline-inspector-body",
    );
    expect(stageInspector).not.toBeNull();
    expect(
      within(stageInspector as HTMLElement).queryByText("阶段顺序"),
    ).toBeNull();
    fireEvent.click(
      within(stageInspector as HTMLElement).getByRole("button", {
        name: "后移阶段",
      }),
    );
    expect(
      [...document.querySelectorAll(".cp-stage-list button")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["中期", "初期"]);
  });

  it("支持通过拖动手柄调整境界顺序", async () => {
    await renderProgression();

    document.querySelectorAll(".cp-level-row").forEach((row, index) => {
      const top = index * 120;
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          x: 0,
          y: top,
          top,
          left: 0,
          right: 600,
          bottom: top + 100,
          width: 600,
          height: 100,
          toJSON: () => ({}),
        }),
      });
    });
    const handle = screen.getByRole("button", {
      name: "拖动调整境界「一境」顺序",
    });
    handle.focus();
    fireEvent.keyDown(handle, { key: " ", code: "Space" });
    await waitFor(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
    fireEvent.keyDown(handle, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(handle, { key: " ", code: "Space" });

    await waitFor(() => {
      expect(
        [...document.querySelectorAll(".cp-level-node strong")].map(
          (node) => node.textContent,
        ),
      ).toEqual(["二境", "一境"]);
    });
  });

  it("新境界按需创建阶段", async () => {
    await renderProgression();

    fireEvent.click(screen.getByRole("button", { name: "新增境界" }));
    const inspector = document.querySelector(
      ".ce-progression-inline-inspector-body",
    );
    expect(inspector).not.toBeNull();
    expect(
      within(inspector as HTMLElement).getByDisplayValue("新境界 3"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "对象检查" })).toBeNull();
    const nodes = document.querySelectorAll(".cp-level-node");
    expect(nodes).toHaveLength(3);
    expect(nodes.item(2)).toHaveTextContent("新境界");
    expect(nodes.item(2)).toHaveTextContent("0 个阶段");
  });
});
