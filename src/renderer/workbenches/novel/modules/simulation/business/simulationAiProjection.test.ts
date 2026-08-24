import { describe, expect, it } from "vitest";

import { advanceSimulationRun } from "./simulationEngine";
import {
  buildSimulationAiRepairPrompt,
  projectSimulationAiEvents,
} from "./simulationAiProjection";
import type { SimulationRun } from "../entities/simulationSchema";

const run: SimulationRun = {
  schemaVersion: 1,
  id: "run-test",
  name: "测试运行",
  status: "ready",
  baselineMode: "timeline-current",
  baselineSourceHash: "hash-test",
  baselineLabel: "测试基线",
  parentRunId: null,
  forkRoundId: null,
  startTime: 0,
  currentTime: 0,
  endTime: 365,
  timeScale: "month",
  timeStep: 1,
  observationSpaceIds: ["world-root"],
  observationSpaceLabel: "测试世界",
  observer: "ensemble",
  observerId: null,
  seed: 1,
  engineVersion: "simulation-engine/1",
  rulesetVersion: "world-rules/1",
  currentRoundId: null,
  roundsCompleted: 0,
  diagnostics: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const source = {
  characterCount: 1,
  factionCount: 1,
  locationCount: 1,
  timelineEventCount: 0,
  observationSpaceId: "world-root",
  observationSpaceLabel: "测试世界",
};

function input() {
  const result = advanceSimulationRun(run, source, "2026-01-01T00:00:00.000Z");
  return {
    run: result.run,
    round: result.round,
    hardEvents: result.events,
    historicalEvents: [],
    source,
  };
}

describe("simulation AI projection", () => {
  it("有真实主体快照时丢弃缺少主体的候选，但保留故事正文", () => {
    const richSource = {
      ...source,
      characters: [
        {
          id: "hero",
          name: "沈照夜",
          goals: "完成闭关",
          motivation: "灵石耗尽前突破",
          currentLocationId: "north",
          currentLocationLabel: "北山镇",
        },
      ],
      locations: [{ id: "north", name: "北山镇" }],
    };
    const result = advanceSimulationRun(
      run,
      richSource,
      "2026-01-01T00:00:00.000Z",
    );
    const aiInput = {
      run: result.run,
      round: result.round,
      hardEvents: result.events,
      historicalEvents: [],
      source: richSource,
    };
    const projected = projectSimulationAiEvents(
      JSON.stringify({
        narrative: "沈照夜在北山镇完成闭关准备，村民开始减少夜间出行。",
        events: [
          {
            kind: "character-action",
            title: "沈照夜在北山镇完成闭关",
            summary: "沈照夜在北山镇完成闭关，等待下一边界。",
            time: 30,
            certainty: "inferred",
            source: "character",
            entityRefs: [{ type: "character", id: "hero", label: "沈照夜" }],
            actorRefs: [{ type: "character", id: "hero", label: "沈照夜" }],
            locationRef: { type: "location", id: "north", label: "北山镇" },
            targetRefs: [],
            triggerFacts: [
              {
                id: "goal",
                label: "目标",
                value: "完成闭关",
                sourcePath: "characters/records/hero.json",
              },
            ],
            decision: "继续闭关",
            action: "完成闭关",
            stateChanges: [],
            uncertainty: "",
            causeEventIds: [],
            propagations: [],
            ruleIds: [],
          },
        ],
      }),
      aiInput,
    );
    expect(projected.events[0]).toMatchObject({
      actorRefs: [{ id: "hero" }],
      locationRef: { id: "north" },
      decision: "继续闭关",
    });
    expect(projected.narrative).toContain("村民开始减少夜间出行");
    const dropped = projectSimulationAiEvents(
      JSON.stringify({
        narrative: "没有主体引用的候选不会进入事件账本。",
        events: [
          {
            kind: "character-action",
            title: "泛化人物事件",
            summary: "没有主体和依据。",
            time: 30,
            certainty: "uncertain",
            source: "character",
            entityRefs: [],
            causeEventIds: [],
            propagations: [],
            ruleIds: [],
          },
        ],
      }),
      aiInput,
    );
    expect(dropped.events).toHaveLength(0);
    expect(dropped.droppedEventCount).toBe(1);
    expect(dropped.narrative).toContain("不会进入事件账本");
  });

  it("parses fenced JSON and assigns auditable event ids", () => {
    const result = projectSimulationAiEvents(
      [
        "```json",
        JSON.stringify({
          events: [
            {
              kind: "world-process",
              title: "AI 观察到灵气异常",
              summary: "该结果只作为不确定候选保存。",
              time: 30,
              certainty: "uncertain",
              source: "world",
              entityRefs: [
                { type: "world", id: "world-process", label: "世界过程" },
              ],
              causeEventIds: [],
              propagations: [],
              ruleIds: [],
            },
          ],
        }),
        "```",
      ].join("\n"),
      input(),
    );

    expect(result.events[0]).toMatchObject({
      id: "run-test-r1-ai0",
      certainty: "uncertain",
      source: "world",
    });
  });

  it("允许没有触发事实的 AI 候选，并自动标记不确定性", () => {
    const richSource = {
      ...source,
      characters: [{ id: "hero", name: "沈照夜" }],
      locations: [{ id: "world-root", name: "测试世界" }],
    };
    const result = advanceSimulationRun(
      run,
      richSource,
      "2026-01-01T00:00:00.000Z",
    );
    const projected = projectSimulationAiEvents(
      JSON.stringify({
        events: [
          {
            kind: "character-action",
            title: "测灵无根，石面异象",
            summary: "沈照夜在测灵时得到无根结果，测灵石表面浮现异常纹路。",
            time: 30,
            certainty: "inferred",
            source: "character",
            entityRefs: [{ type: "character", id: "hero", label: "沈照夜" }],
            actorRefs: [{ type: "character", id: "hero", label: "沈照夜" }],
            locationRef: {
              type: "location",
              id: "world-root",
              label: "测试世界",
            },
            targetRefs: [],
            triggerFacts: [],
            decision: "继续观察测灵石",
            action: "接受测灵结果",
            stateChanges: [],
            uncertainty: "",
            causeEventIds: [],
            propagations: [],
            ruleIds: [],
          },
        ],
      }),
      {
        run: result.run,
        round: result.round,
        hardEvents: result.events,
        historicalEvents: [],
        source: richSource,
      },
    );

    expect(projected.events[0]).toMatchObject({
      title: "测灵无根，石面异象",
      certainty: "uncertain",
      triggerFacts: [],
    });
    expect(projected.events[0]?.uncertainty).toContain("缺少");
  });

  it("保留没有结构化事件的故事正文", () => {
    const narrative = "北山的粮价上涨，沈照夜决定先保护村民，再调查灵脉异常。";
    const result = projectSimulationAiEvents(
      JSON.stringify({ narrative, events: [] }),
      input(),
    );

    expect(result.events).toHaveLength(0);
    expect(result.narrative).toBe(narrative);
  });

  it("模型只返回自然语言故事时直接保存叙事，不触发格式整理", () => {
    const narrative =
      "北山的风雪提前压过山口。沈照夜发现闭关准备被打断，只能先护住山村，再追查灵脉异动。";
    const result = projectSimulationAiEvents(narrative, input());

    expect(result.events).toHaveLength(0);
    expect(result.narrative).toBe(narrative);
  });

  it("模型拒答、空文本和错误说明不能被当成故事保存", () => {
    expect(() =>
      projectSimulationAiEvents(
        "我无法直接读取超出限制的资料，请提供更多上下文。",
        input(),
      ),
    ).toThrow("模型返回了拒答或错误说明");
    expect(() =>
      projectSimulationAiEvents("The model returned no text.", input()),
    ).toThrow("模型返回了拒答或错误说明");
    expect(() => projectSimulationAiEvents("   ", input())).toThrow(
      "AI 没有返回故事正文或事件候选",
    );
    expect(() =>
      projectSimulationAiEvents(
        JSON.stringify({ narrative: "", events: [] }),
        input(),
      ),
    ).toThrow("AI 没有返回故事正文或事件候选");
  });

  it("recovers a JSON object surrounded by model explanation text", () => {
    const output = JSON.stringify({
      events: [
        {
          kind: "world-process",
          title: "说明文字后的事件",
          summary: "只验证本地兼容解析，不改变事件内容。",
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
    const result = projectSimulationAiEvents(
      `我已整理结果：${output}\n以上为候选。`,
      input(),
    );

    expect(result.events[0]?.title).toBe("说明文字后的事件");
  });

  it("接受双重 JSON 编码和常见 result 包装", () => {
    const payload = JSON.stringify({ narrative: "整理后的故事", events: [] });
    expect(
      projectSimulationAiEvents(JSON.stringify(payload), input()).narrative,
    ).toBe("整理后的故事");
    expect(
      projectSimulationAiEvents(
        JSON.stringify({ result: JSON.parse(payload) }),
        input(),
      ).narrative,
    ).toBe("整理后的故事");
  });

  it("格式整理提示包含受限实体和因果引用上下文", () => {
    const richSource = {
      ...source,
      characters: [{ id: "hero", name: "沈照夜" }],
      locations: [{ id: "world-root", name: "测试世界" }],
    };
    const result = advanceSimulationRun(
      run,
      richSource,
      "2026-01-01T00:00:00.000Z",
    );
    const prompt = buildSimulationAiRepairPrompt(
      {
        run: result.run,
        round: result.round,
        hardEvents: result.events,
        historicalEvents: [],
        source: richSource,
      },
      "旧格式输出",
      "events.0.entityRefs: Invalid input",
    );
    expect(prompt).toContain('"id": "hero"');
    expect(prompt).toContain('"allowedCauseEventIds"');
    expect(prompt).toContain("events.0.entityRefs: Invalid input");
  });

  it("兼容旧事件字段并丢弃无法安全映射的引用", () => {
    const result = projectSimulationAiEvents(
      JSON.stringify({
        narrative: "旧格式事件仍然表达了世界变化。",
        events: [
          {
            kind: "world",
            title: "旧格式事件",
            summary: "旧版本输出使用了字符串引用。",
            time: 30,
            certainty: "inferred",
            source: "world-process",
            entityRefs: ["world-process"],
            actorRefs: [],
            locationRef: "world-root",
            targetRefs: [],
            triggerFacts: ["annual-cycle"],
            stateChanges: [
              {
                entity: "world-process",
                field: "state",
                from: "旧",
                to: "新",
                certainty: "uncertain",
              },
            ],
          },
        ],
      }),
      input(),
    );

    expect(result.events[0]).toMatchObject({
      kind: "world-process",
      source: "world",
      entityRefs: [{ id: "world-process" }],
      stateChanges: [
        { entityRef: { id: "world-process" }, before: "旧", after: "新" },
      ],
      triggerFacts: [],
    });
    expect(result.narrative).toBe("旧格式事件仍然表达了世界变化。");
  });

  it("拒绝非 JSON，并丢弃越界或无法确认主体的事件", () => {
    expect(() => projectSimulationAiEvents("模型自由文本", input())).toThrow(
      "不是有效 JSON",
    );

    const base = {
      kind: "character-action",
      title: "越界事件",
      summary: "不应落盘",
      certainty: "uncertain",
      source: "character",
      entityRefs: [],
      causeEventIds: [],
      propagations: [],
      ruleIds: [],
    };
    const overflow = projectSimulationAiEvents(
      JSON.stringify({ events: [{ ...base, time: 31 }] }),
      input(),
    );
    expect(overflow.events).toHaveLength(0);
    expect(overflow.droppedEventCount).toBe(1);

    const richSource = {
      ...source,
      characters: [{ id: "hero", name: "沈照夜" }],
    };
    const richResult = advanceSimulationRun(
      run,
      richSource,
      "2026-01-01T00:00:00.000Z",
    );
    const fabricated = projectSimulationAiEvents(
      JSON.stringify({
        events: [
          {
            ...base,
            time: 30,
            entityRefs: [
              { type: "character", id: "invented", label: "伪造人物" },
            ],
          },
        ],
      }),
      {
        run: richResult.run,
        round: richResult.round,
        hardEvents: richResult.events,
        historicalEvents: [],
        source: richSource,
      },
    );
    expect(fabricated.events).toHaveLength(0);
    expect(fabricated.droppedEventCount).toBe(1);
  });
});
