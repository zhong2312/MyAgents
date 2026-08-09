import { describe, expect, it } from "vitest";

import { mergeCultivationAiPatch } from "./cultivationAiPatch";

describe("修炼模块 AI 补丁", () => {
  it("拒绝嵌套引用 ID，同时允许补充普通文本字段", () => {
    const base = {
      id: "ability-1",
      name: "引雷",
      effect: "",
      scriptureSource: { methodId: "method-1", summary: "" },
      cast: { amount: "", fullPowerLevelId: "level-1" },
    };
    const merged = mergeCultivationAiPatch(base, {
      effect: "将灵力转化为雷霆",
      scriptureSource: { methodId: "method-forged", summary: "来自古卷" },
      cast: { fullPowerLevelId: "level-forged", amount: "三成灵力" },
      id: "ability-forged",
    });

    expect(merged).toEqual({
      ...base,
      effect: "将灵力转化为雷霆",
      scriptureSource: { methodId: "method-1", summary: "来自古卷" },
      cast: { amount: "三成灵力", fullPowerLevelId: "level-1" },
    });
  });
});
