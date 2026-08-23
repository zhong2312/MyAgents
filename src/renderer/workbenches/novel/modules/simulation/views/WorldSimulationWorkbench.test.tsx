import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import WorldSimulationWorkbench, {
  type SimulationAiRunRequest,
} from "./WorldSimulationWorkbench";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";

function createStorage(): NovelMemoryStorage {
  return new NovelMemoryStorage({
    "characters/index.json": '{"characters":[{"id":"hero"}]}\n',
    "world/factions/index.json": '{"factions":[{"id":"guild"}]}\n',
    "world/locations/index.json": '{"locations":[{"id":"north"}]}\n',
    "timeline/index.json": '{"events":[]}\n',
    "world/setting-library/spatial-tree.json":
      '{"nodes":[{"id":"world-root","name":"测试世界","parentId":null}]}\n',
  });
}

function createStorageWithChapters(): NovelMemoryStorage {
  const chapters = [1, 2, 10_000].map((number) => ({
    id: `chapter-${String(number).padStart(6, "0")}`,
    number,
    displayNumber: number,
    title: number === 10_000 ? "潮汐之后" : `第 ${number} 章`,
    path: `manuscript/chapters/${String(number).padStart(6, "0")}.md`,
    status: "complete",
    directoryId: null,
    order: number - 1,
    narrativeChapterId: null,
    trackingStatus: "idle",
    lastTrackedAt: null,
    planningMode: "reference",
  }));
  return new NovelMemoryStorage({
    ...Object.fromEntries(
      Object.entries({
        "characters/index.json":
          '{"characters":[{"id":"hero"},{"id":"mage"}]}\n',
        "world/factions/index.json": '{"factions":[{"id":"guild"}]}\n',
        "world/locations/index.json": '{"locations":[{"id":"north"}]}\n',
        "timeline/index.json": '{"events":[]}\n',
        "world/setting-library/spatial-tree.json":
          '{"nodes":[{"id":"world-root","name":"测试世界","parentId":null}]}\n',
        "manuscript/chapters/000001.md": "第一章正文",
        "manuscript/chapters/000002.md": "第二章正文",
        "manuscript/chapters/010000.md": "第一万章正文",
      }),
    ),
    "manuscript/index.json": `${JSON.stringify(
      {
        schemaVersion: 4,
        nextChapterNumber: 10_001,
        structureMode: "free",
        directories: [],
        chapters,
        typography: {
          fontFamily: "system-serif",
          fontSize: 18,
          titleSize: 30,
          lineHeight: 1.9,
          paragraphSpacing: 12,
          firstLineIndent: 2,
          contentWidth: 760,
          textAlign: "left",
          paperTone: "warm",
        },
        trash: [],
      },
      null,
      2,
    )}\n`,
  });
}

describe("WorldSimulationWorkbench", () => {
  it("从创建运行到点击推演一轮，持久化轮次和事件", async () => {
    const storage = createStorage();
    const output = JSON.stringify({
      narrative:
        "北山的风雪提前压过山口。沈照夜发现闭关准备被打断，只能在赤霄宗封锁商路前作出选择；他决定先护住山村，再追查灵脉异动。村民开始减少夜间出行，商贩把药材和粮价重新记在木牌上。",
      events: [
        {
          kind: "character-action",
          title: "AI 观察到北境人物改变计划",
          summary: "模型依据当前人物目标和已读取事实返回一条不确定性事件候选。",
          time: 30,
          certainty: "uncertain",
          source: "character",
          entityRefs: [],
          causeEventIds: [],
          propagations: [],
          ruleIds: [],
        },
      ],
    });
    let resolveAi!: (value: string) => void;
    const onAiRun = vi.fn(
      (request: SimulationAiRunRequest) =>
        new Promise<string>((resolve) => {
          resolveAi = resolve;
          request.onProgress?.({
            runId: request.runId,
            kind: "status",
            message: "正在生成事件候选",
            revision: 1,
          });
        }),
    );
    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={onAiRun}
        registerNavigationGuard={() => () => undefined}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "建立一个可复现的世界运行",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建并进入舞台" }));

    const advanceButton = await screen.findByRole("button", {
      name: "AI 推演 1 轮",
    });
    fireEvent.click(advanceButton);

    await waitFor(() => expect(onAiRun).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent(
      "AI 推演正在生成事件候选",
    );
    expect(document.querySelector(".ws-ai-progress")).toBeNull();
    resolveAi(output);

    await waitFor(() => {
      const index = JSON.parse(
        storage.getText("world/simulations/index.json") ?? "{}",
      ) as { runs?: Array<{ path: string }> };
      expect(index.runs).toHaveLength(1);
      const manifestPath = index.runs?.[0]?.path;
      expect(manifestPath).toBeTruthy();
      const manifest = JSON.parse(
        storage.getText(manifestPath ?? "") ?? "{}",
      ) as {
        roundsCompleted?: number;
        currentTime?: number;
        endTimeAmount?: number;
        endTimeUnit?: string;
        timeStep?: number;
        aiTimeoutMinutes?: number;
      };
      expect(manifest.roundsCompleted).toBe(1);
      expect(manifest.currentTime).toBe(30);
      expect(manifest.endTimeAmount).toBe(12);
      expect(manifest.endTimeUnit).toBe("year");
      expect(manifest.timeStep).toBe(1);
      expect(manifest.aiTimeoutMinutes).toBe(5);
      expect(onAiRun.mock.calls[0]?.[0]).toMatchObject({
        executionProfile: "extended",
        timeoutMs: 300_000,
      });
    });

    expect(onAiRun).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("AI 观察到北境人物改变计划"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "北山的风雪提前压过山口。沈照夜发现闭关准备被打断，只能在赤霄宗封锁商路前作出选择；他决定先护住山村，再追查灵脉异动。村民开始减少夜间出行，商贩把药材和粮价重新记在木牌上。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(await screen.findByText("第 1 轮")).toBeInTheDocument();
    expect(screen.getByText("本轮行动记录")).toBeInTheDocument();

    const worldPulse = screen.getByRole("button", {
      name: "查看世界过程 AI 推演变化",
    });
    fireEvent.click(worldPulse);
    expect(
      screen.getByRole("heading", { name: "当前时间点" }),
    ).toBeInTheDocument();
  });

  it("可取消正在进行的 AI 推演，且不会保存未完成轮次", async () => {
    const storage = createStorage();
    let rejectAiRun: ((reason?: unknown) => void) | undefined;
    const onAiRun = vi.fn(
      (_request: SimulationAiRunRequest) =>
        new Promise<string>((_resolve, reject) => {
          rejectAiRun = reject;
        }),
    );
    const onCancelAiRun = vi.fn(async () => {
      rejectAiRun?.(new Error("本次 AI 生成已取消"));
    });
    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={onAiRun}
        onCancelAiRun={onCancelAiRun}
        registerNavigationGuard={() => () => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "创建并进入舞台" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "AI 推演 1 轮" }),
    );
    const cancelButton = await screen.findByRole("button", {
      name: "取消推演",
    });
    expect(cancelButton).toHaveAttribute("aria-label", "取消推演");
    expect(cancelButton).toHaveAttribute(
      "title",
      "停止当前 AI 推演；未完成的本轮不会保存",
    );
    fireEvent.click(cancelButton);

    await waitFor(() => expect(onCancelAiRun).toHaveBeenCalledOnce());
    expect(onCancelAiRun).toHaveBeenCalledWith(
      expect.stringMatching(/^simulation-/u),
    );
    expect(
      await screen.findByText("AI 推演已取消，未完成的本轮没有保存。"),
    ).toBeInTheDocument();
    const index = JSON.parse(
      storage.getText("world/simulations/index.json") ?? "{}",
    ) as { runs?: Array<{ path: string }> };
    const manifest = JSON.parse(
      storage.getText(index.runs?.[0]?.path ?? "") ?? "{}",
    ) as { roundsCompleted?: number };
    expect(manifest.roundsCompleted).toBe(0);
    expect(screen.queryByRole("button", { name: "取消推演" })).toBeNull();
  });

  it("宿主暂未提供取消接口时仍显示取消按钮，并丢弃本地结果", async () => {
    const storage = createStorage();
    let resolveAiRun!: (value: string) => void;
    const onAiRun = vi.fn(
      (_request: SimulationAiRunRequest) =>
        new Promise<string>((resolve) => {
          resolveAiRun = resolve;
        }),
    );
    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={onAiRun}
        registerNavigationGuard={() => () => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "创建并进入舞台" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "AI 推演 1 轮" }),
    );
    await waitFor(() => expect(onAiRun).toHaveBeenCalledOnce());
    fireEvent.click(
      await screen.findByRole("button", { name: "取消推演" }),
    );
    resolveAiRun(JSON.stringify({ narrative: "被取消的故事", events: [] }));

    expect(
      await screen.findByText("AI 推演已取消，未完成的本轮没有保存。"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    const index = JSON.parse(
      storage.getText("world/simulations/index.json") ?? "{}",
    ) as { runs?: Array<{ path: string }> };
    const manifest = JSON.parse(
      storage.getText(index.runs?.[0]?.path ?? "") ?? "{}",
    ) as { roundsCompleted?: number };
    expect(manifest.roundsCompleted).toBe(0);
  });

  it("模型返回非 JSON 时只用无工具请求整理一次再保存", async () => {
    const storage = createStorage();
    const repairOutput = JSON.stringify({
      events: [
        {
          kind: "world-process",
          title: "格式整理后的世界事件",
          summary: "该事件来自第二次格式整理请求，并仍会经过本地校验。",
          time: 30,
          certainty: "uncertain",
          source: "world",
          entityRefs: [],
          causeEventIds: [],
          propagations: [],
          ruleIds: [],
        },
      ],
    });
    const outputs = [
      "我无法直接读取超出限制的资料，请提供更多上下文。",
      repairOutput,
    ];
    const onAiRun = vi.fn(
      async (_request: SimulationAiRunRequest) =>
        outputs.shift() ?? repairOutput,
    );
    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={onAiRun}
        registerNavigationGuard={() => () => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "创建并进入舞台" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "AI 推演 1 轮" }),
    );

    await waitFor(() => expect(onAiRun).toHaveBeenCalledTimes(2));
    expect(onAiRun.mock.calls[1]?.[0]).toMatchObject({
      usesNovelContextTools: false,
      maxTurns: 1,
      streamOutput: false,
    });
    expect(await screen.findByText("格式整理后的世界事件")).toBeInTheDocument();
  });

  it("支持在运行操作中配置 AI 请求超时并持久化", async () => {
    const storage = createStorage();
    const onAiRun = vi.fn(async (_request: SimulationAiRunRequest) =>
      JSON.stringify({
        narrative: "北山的风雪暂时平息，村民开始恢复日常耕作。",
        events: [],
      }),
    );
    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={onAiRun}
        registerNavigationGuard={() => () => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "创建并进入舞台" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "运行操作" }));
    const timeoutSelect = await screen.findByRole("button", {
      name: "AI 推演请求超时",
    });
    expect(timeoutSelect).toHaveTextContent("5 分钟");
    fireEvent.click(timeoutSelect);
    fireEvent.click(screen.getByRole("button", { name: "8 分钟" }));

    await waitFor(() => {
      const index = JSON.parse(
        storage.getText("world/simulations/index.json") ?? "{}",
      ) as { runs?: Array<{ path: string }> };
      const manifest = JSON.parse(
        storage.getText(index.runs?.[0]?.path ?? "") ?? "{}",
      ) as { aiTimeoutMinutes?: number };
      expect(manifest.aiTimeoutMinutes).toBe(8);
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "AI 推演 1 轮" }),
    );
    await waitFor(() => expect(onAiRun).toHaveBeenCalledTimes(1));
    expect(onAiRun.mock.calls[0]?.[0]).toMatchObject({
      executionProfile: "extended",
      timeoutMs: 480_000,
    });
  });

  it("模型返回旧事件字段时，本地直接兼容并保存故事", async () => {
    const storage = createStorage();
    const legacyOutput = JSON.stringify({
      narrative: "旧格式结果仍然表达了北山的一次世界变化。",
      events: [
        {
          kind: "world",
          title: "旧格式世界事件",
          summary: "旧格式使用了字符串引用和 from/to 字段。",
          time: 30,
          certainty: "uncertain",
          source: "world-process",
          entityRefs: ["world-process"],
          actorRefs: ["world-process"],
          locationRef: "north",
          targetRefs: ["guild"],
          triggerFacts: ["annual-cycle"],
          decision: "",
          action: "",
          stateChanges: [
            {
              entity: "world-process",
              field: "state",
              from: "旧",
              to: "新",
              certainty: "uncertain",
            },
          ],
          uncertainty: "",
          causeEventIds: [],
          propagations: [],
          ruleIds: [],
        },
      ],
    });
    const onAiRun = vi.fn(async (_request: SimulationAiRunRequest) => legacyOutput);
    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={onAiRun}
        registerNavigationGuard={() => () => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "创建并进入舞台" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "AI 推演 1 轮" }),
    );

    await waitFor(() => expect(onAiRun).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("旧格式世界事件")).toBeInTheDocument();
    expect(
      await screen.findByText("旧格式结果仍然表达了北山的一次世界变化。"),
    ).toBeInTheDocument();
  });

  it("事件账本为空时仍展示 AI 返回的故事正文", async () => {
    const storage = createStorage();
    const narrative = "北山的粮价上涨，沈照夜决定先保护村民，再调查灵脉异常。";
    const onAiRun = vi.fn(async (_request: SimulationAiRunRequest) =>
      JSON.stringify({ narrative, events: [] }),
    );

    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={onAiRun}
        registerNavigationGuard={() => () => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "创建并进入舞台" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "AI 推演 1 轮" }),
    );

    expect(await screen.findByText(narrative)).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "本轮 AI 尚未生成该类可审计变化，故事正文仍以 AI 叙事为准。",
      ),
    ).toHaveLength(4);
  });

  it("模型只返回故事正文时只请求一次 AI 并保存本轮", async () => {
    const storage = createStorage();
    const narrative =
      "北山的风雪提前压过山口。沈照夜决定先护住山村，再追查灵脉异动。";
    const onAiRun = vi.fn(async (_request: SimulationAiRunRequest) => narrative);

    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={onAiRun}
        registerNavigationGuard={() => () => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "创建并进入舞台" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "AI 推演 1 轮" }),
    );

    expect(await screen.findByText(narrative)).toBeInTheDocument();
    expect(onAiRun).toHaveBeenCalledOnce();
    expect(screen.queryByText("AI 推演结果格式整理失败，请重试")).toBeNull();
  });

  it("读取旧版内嵌人物资料并把目标与地点带入 AI 上下文", async () => {
    const storage = new NovelMemoryStorage({
      "characters/index.json": `${JSON.stringify({
        characters: [
          {
            id: "hero",
            name: "沈照夜",
            goals: "护住北山镇",
            motivation: "不让村民卷入灵脉灾变",
            currentLocationId: "north",
            currentLocation: "北山镇",
            status: "活跃",
            inventory: [{ name: "护身符" }],
          },
        ],
      })}\n`,
      "world/factions/index.json": '{"factions":[]}\n',
      "world/locations/index.json": `${JSON.stringify({
        locations: [
          {
            id: "north",
            nodeId: "world-root",
            parentLocationId: null,
            name: "北山镇",
            type: "城镇",
            status: "appeared",
            summary: "边境城镇",
            aliases: [],
            appearanceNote: "",
            description: "",
            order: 0,
          },
        ],
      })}\n`,
      "timeline/index.json": '{"events":[]}\n',
      "world/setting-library/spatial-tree.json":
        '{"nodes":[{"id":"world-root","name":"测试世界","parentId":null}]}\n',
    });
    let request: SimulationAiRunRequest | undefined;
    const onAiRun = vi.fn(async (next: SimulationAiRunRequest) => {
      request = next;
      return "沈照夜在北山镇守住了第一道防线。";
    });

    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={onAiRun}
        registerNavigationGuard={() => () => undefined}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "创建并进入舞台" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "AI 推演 1 轮" }),
    );

    await screen.findByText("沈照夜在北山镇守住了第一道防线。");
    expect(request?.prompt).toContain("护住北山镇");
    expect(request?.prompt).toContain("不让村民卷入灵脉灾变");
    expect(request?.prompt).toContain("北山镇");
  });

  it("读取独立时间线事件记录并把正式事实交给时间调度", async () => {
    const storage = new NovelMemoryStorage({
      "characters/index.json": '{"characters":[{"id":"hero","name":"沈照夜"}]}\n',
      "world/factions/index.json": '{"factions":[]}\n',
      "world/locations/index.json": '{"locations":[]}\n',
      "timeline/index.json": `${JSON.stringify({
        events: [{ id: "fact-north", path: "timeline/events/records/fact-north.json" }],
      })}\n`,
      "timeline/events/records/fact-north.json": `${JSON.stringify({
        id: "fact-north",
        title: "北山封印松动",
        summary: "北山封印在正式时间线上出现松动。",
        sortKey: 30,
        characterIds: ["hero"],
        factionIds: [],
        locationIds: [],
      })}\n`,
      "world/setting-library/spatial-tree.json":
        '{"nodes":[{"id":"world-root","name":"测试世界","parentId":null}]}\n',
    });
    let request: SimulationAiRunRequest | undefined;
    const onAiRun = vi.fn(async (next: SimulationAiRunRequest) => {
      request = next;
      return "北山封印松动后，沈照夜开始重新布置守阵路线。";
    });

    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={onAiRun}
        registerNavigationGuard={() => () => undefined}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "创建并进入舞台" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "AI 推演 1 轮" }),
    );

    await screen.findByText("北山封印松动后，沈照夜开始重新布置守阵路线。");
    expect(request?.prompt).toContain("北山封印松动");
    expect(request?.prompt).toContain("北山封印在正式时间线上出现松动");
  });

  it("支持多选观察对象并从万章章节快速定位", async () => {
    const storage = createStorageWithChapters();
    render(
      <WorldSimulationWorkbench
        storage={storage}
        projectTitle="测试小说"
        isActive
        onAiRun={async () => JSON.stringify({ narrative: "", events: [] })}
        registerNavigationGuard={() => () => undefined}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /全部人物与势力/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /全部人物与势力/ }));
    const targetCheckboxes = screen.getAllByRole("checkbox");
    fireEvent.click(targetCheckboxes[0]!);
    fireEvent.click(targetCheckboxes[1]!);
    expect(screen.getByText("已选择 2 个主体")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "章节基线方式" }));
    fireEvent.click(screen.getByRole("button", { name: "从章节后继续" }));
    fireEvent.click(screen.getByRole("button", { name: /请选择章节/ }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "章节编号直达" }), {
      target: { value: "10000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /第 10000 章/ }));
    expect(
      screen.getByRole("button", { name: "创建并进入舞台" }),
    ).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "创建并进入舞台" }));

    await waitFor(() => {
      const index = JSON.parse(
        storage.getText("world/simulations/index.json") ?? "{}",
      ) as { runs?: Array<{ path: string }> };
      const manifest = JSON.parse(
        storage.getText(index.runs?.[0]?.path ?? "") ?? "{}",
      ) as {
        observationTargets?: readonly unknown[];
        baselineMode?: string;
        baselineChapterId?: string;
      };
      expect(manifest.observationTargets).toHaveLength(2);
      expect(manifest.baselineMode).toBe("after-chapter");
      expect(manifest.baselineChapterId).toBe("chapter-010000");
    });
  });
});
