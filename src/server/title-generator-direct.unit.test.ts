import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  direct: vi.fn(),
  sdkQuery: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mocks.sdkQuery,
}));

vi.mock("./direct-one-shot", () => ({
  generateDirectOneShotText: mocks.direct,
  DirectOneShotCancelledError: class DirectOneShotCancelledError extends Error {},
  DirectOneShotTimeoutError: class DirectOneShotTimeoutError extends Error {},
}));

import { generateOneShotText } from "./title-generator";

describe("generateOneShotText direct route", () => {
  beforeEach(() => {
    mocks.direct.mockReset();
    mocks.sdkQuery.mockReset();
  });

  it("does not instantiate the Agent SDK for a provider-backed no-tool turn", async () => {
    mocks.direct.mockResolvedValue("润色结果");

    const output = await generateOneShotText({
      prompt: "请润色正文",
      systemPrompt: "只输出正文",
      workspacePath: "C:/workspace",
      model: "test-model",
      maxTurns: 1,
      streamText: true,
      providerEnv: {
        providerId: "test-provider",
        baseUrl: "https://provider.test",
        apiKey: "test-key",
        apiProtocol: "anthropic",
      },
    });

    expect(output).toBe("润色结果");
    expect(mocks.direct).toHaveBeenCalledOnce();
    expect(mocks.sdkQuery).not.toHaveBeenCalled();
  });
});
