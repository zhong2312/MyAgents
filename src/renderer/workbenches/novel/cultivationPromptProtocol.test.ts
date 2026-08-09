import { describe, expect, it } from "vitest";

import {
  appendCultivationPlatformProtocol,
  CULTIVATION_AGENT_PLATFORM_PROTOCOL,
} from "./cultivationPromptProtocol";

describe("修炼体系 Agent 提示词协议", () => {
  it("始终把平台提案协议追加在可编辑提示词之后", () => {
    const result = appendCultivationPlatformProtocol(
      "自定义修炼创作方法\n请优先讨论叙事效果。",
    );
    expect(result.startsWith("自定义修炼创作方法")).toBe(true);
    expect(result.endsWith(CULTIVATION_AGENT_PLATFORM_PROTOCOL)).toBe(true);
    expect(result).toContain("novel_cultivation_validate_draft");
    expect(result).toContain("novel_cultivation_patch_draft");
    expect(result).toContain("超过限制必须拆成 patch 调用");
    expect(result).toContain("自动规范化通过校验的 JSON");
    expect(result).toContain("不得直接用 Write、Edit 或 Bash 修改正式事实源");
  });
});
