import { describe, expect, it } from "vitest";

import { modelUnavailableErrorMessage } from "./modelSceneFallback";

describe("小说模型场景失效策略", () => {
  it("识别模型不存在或无权限的服务错误", () => {
    expect(
      modelUnavailableErrorMessage(
        new Error(
          "Claude Code returned an error result: The selected model may not exist or you may not have access.",
        ),
      ),
    ).toContain("selected model");
    expect(modelUnavailableErrorMessage(new Error("请求超时"))).toBeNull();
  });
});
