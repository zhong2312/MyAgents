import { describe, expect, it } from "vitest";

import {
  buildCouncilRoundPrompt,
  buildCouncilSystemPrompt,
  parseCouncilOutput,
} from "./councilRound";

const actors = [
  {
    id: "a1",
    name: "陆沉渊",
    kind: "character",
    goals: ["寻回灵墟"],
    resources: ["金丹"],
    constraints: ["不得伤及凡人"],
  },
  {
    id: "a2",
    name: "镇夜司",
    kind: "faction",
    goals: ["维持城中秩序"],
    resources: ["卫队"],
    constraints: [],
  },
];

describe("councilRound", () => {
  it("构建系统提示词与逐轮提示词", () => {
    const system = buildCouncilSystemPrompt();
    expect(system).toContain("圆桌会商");
    expect(system).toContain("JSON");

    const prompt = buildCouncilRoundPrompt({
      topic: "宗门封山后各方如何行动？",
      actors,
      round: 1,
      maxRounds: 3,
      history: [],
      isFinal: false,
    });
    expect(prompt).toContain("宗门封山后各方如何行动？");
    expect(prompt).toContain("陆沉渊");
    expect(prompt).toContain("寻回灵墟");
    expect(prompt).toContain("第 1/3 轮");
  });

  it("最终轮提示词要求投票", () => {
    const prompt = buildCouncilRoundPrompt({
      topic: "封山",
      actors,
      round: 3,
      maxRounds: 3,
      history: [{ actorId: "a1", message: "我主张开山门。" }],
      isFinal: true,
    });
    expect(prompt).toContain("最终轮");
    expect(prompt).toContain("投票");
    expect(prompt).toContain("我主张开山门。");
  });

  it("解析发言与投票 JSON（含代码围栏）", () => {
    const output = parseCouncilOutput(
      '```json\n{"statements":[{"actorId":"a1","message":"开山门以寻灵墟"},{"actorId":"a2","message":"不可，先戒严"}],"votes":[{"actorId":"a1","choice":"支持"},{"actorId":"a2","choice":"反对"}]}\n```',
    );
    expect(output.statements).toHaveLength(2);
    expect(output.statements[0]).toEqual({
      actorId: "a1",
      message: "开山门以寻灵墟",
    });
    expect(output.votes).toHaveLength(2);
    expect(output.votes[1]).toEqual({ actorId: "a2", choice: "反对" });
  });

  it("丢弃无效发言条目并拒绝空结果", () => {
    expect(() => parseCouncilOutput("{}")).toThrow();
    const output = parseCouncilOutput(
      '{"statements":[{"actorId":"a1","message":""},{"actorId":"a2","message":"有效"}],"votes":[]}',
    );
    expect(output.statements).toHaveLength(1);
  });

  it("最终轮允许只输出投票", () => {
    const output = parseCouncilOutput(
      '{"votes":[{"actorId":"a1","choice":"支持"},{"actorId":"a2","choice":"弃权"}]}',
    );
    expect(output.statements).toHaveLength(0);
    expect(output.votes).toHaveLength(2);
  });
});
