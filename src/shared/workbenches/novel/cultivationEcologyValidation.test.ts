import { describe, expect, it } from "vitest";

import {
  cultivationEcologySchema,
  type CultivationEcology,
} from "./cultivationEcologySchema";
import { validateCultivationEcology } from "./cultivationEcologyValidation";

function ecologyFixture(): CultivationEcology {
  return cultivationEcologySchema.parse({
    schemaVersion: 6,
    updatedAt: "2026-08-08T00:00:00.000Z",
    worldOrigins: [],
    crossSystemRelations: [],
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
          nodeCatalog: [
            {
              id: "theory-1",
              name: "灵流",
              summary: "",
              kind: "",
              role: "",
              capacity: "",
              accessCondition: "",
              invariant: "",
              aliases: [],
            },
          ],
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
                name: "纯度",
                summary: "",
                unit: "",
                model: "number",
                direction: "higher-better",
                baseline: "",
              },
            ],
            levels: [
              {
                id: "level-1",
                name: "一境",
                summary: "",
                order: 0,
                stageType: "",
                metricThresholds: [{ metricId: "metric-1", threshold: "" }],
                quality: "",
                entryConditions: [],
                maintenanceConditions: [],
                breakthroughConditions: [],
                breakthroughResult: "",
                failureConsequences: [],
                degeneration: "",
                resourceRequirements: [],
                naturalAbilityIds: [],
                methodIds: ["method-1"],
                subStages: [],
              },
            ],
            transitions: [],
          },
        ],
        resources: [],
        methods: [
          {
            id: "method-1",
            name: "吐纳",
            summary: "",
            kind: "",
            theoryReference: "",
            script: [],
            formula: "",
            coverage: {
              startLevelId: "level-1",
              stableLimitId: null,
              theoryLimitId: null,
              absoluteLimitId: null,
            },
            effects: {
              speed: "",
              conversion: "",
              quality: "",
              breakthrough: "",
              loss: "",
            },
            compatibility: [],
            risks: [],
            itemIds: [],
            operationTopologies: [],
            courses: [],
          },
        ],
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

describe("修炼生态语义校验", () => {
  it("接受内部引用闭合的生态", () => {
    expect(validateCultivationEcology(ecologyFixture())).toEqual([]);
  });

  it("拒绝不存在的阶段引用和物品引用", () => {
    const ecology = ecologyFixture();
    ecology.systems[0]!.methods[0]!.coverage.startLevelId = "missing-level";
    ecology.systems[0]!.methods[0]!.itemIds = ["missing-item"];
    const errors = validateCultivationEcology(ecology, {
      itemIds: new Set(["real-item"]),
    });
    expect(errors.some((error) => error.includes("法门覆盖阶段"))).toBe(true);
    expect(errors.some((error) => error.includes("法门物品"))).toBe(true);
  });

  it("拒绝境界与境内阶段的数组位置和 order 不一致", () => {
    const ecology = ecologyFixture();
    const level = ecology.systems[0]!.progressionTracks[0]!.levels[0]!;
    level.order = 2;
    level.subStages = [
      {
        id: "stage-1",
        name: "初期",
        summary: "",
        order: 3,
        metricThresholds: [],
        entryConditions: [],
        completionConditions: [],
        resourceRequirements: [],
        naturalAbilityIds: [],
        methodIds: [],
      },
    ];

    const errors = validateCultivationEcology(ecology);
    expect(
      errors.some((error) => error.includes("境界“level-1”顺序应为 0")),
    ).toBe(true);
    expect(
      errors.some((error) => error.includes("阶段“stage-1”顺序应为 0")),
    ).toBe(true);
  });

  it("拒绝故事转折规则引用不存在的经历、法门和约束", () => {
    const ecology = ecologyFixture();
    const system = ecology.systems[0]!;
    system.narrativeMilestones = [
      {
        id: "milestone-trial",
        name: "试炼",
        summary: "完成试炼",
        category: "trial",
        satisfiedBy: [],
      },
    ];
    const level = system.progressionTracks[0]!.levels[0]!;
    level.simulationBreakthroughRule = {
      schemaVersion: 1,
      status: "approved",
      enabled: true,
      requiredMethodIds: ["missing-method"],
      requiredAbilityIds: [],
      forbiddenActiveConstraintIds: ["missing-constraint"],
      requiredNarrativeMilestoneIds: ["missing-milestone"],
    };
    const errors = validateCultivationEcology(ecology);
    expect(errors.some((error) => error.includes("故事转折法门"))).toBe(true);
    expect(errors.some((error) => error.includes("故事转折约束"))).toBe(true);
    expect(errors.some((error) => error.includes("故事转折经历"))).toBe(true);
  });
});
