import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  direct: vi.fn(),
  sdkQuery: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mocks.sdkQuery,
}));

vi.mock("./novel-workbench-context", () => ({
  NOVEL_WORKBENCH_SDK_ADAPTER_ID: "novel-workbench",
  NOVEL_WORKBENCH_READ_TOOL_NAMES: ["novel_world_get_context"],
  runWithNovelWorkbenchToolset: (
    _toolset: unknown,
    _runtime: unknown,
    run: () => unknown,
  ) => run(),
}));

vi.mock("./tools/novel-workbench-tool", () => ({
  createNovelWorkbenchServer: vi.fn(async () => ({})),
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

  it("工具调用后没有正文时，会基于已读取资料执行一次无工具收敛", async () => {
    async function* firstTurn() {
      yield {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "novel_world_get_context" }],
        },
      };
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [{ type: "text", text: "世界设定快照" }],
            },
          ],
        },
      };
      yield { type: "result", subtype: "success", messages: [] };
    }
    async function* recoveryTurn() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "收敛后的故事正文" }] },
      };
    }
    mocks.sdkQuery
      .mockImplementationOnce(() => firstTurn())
      .mockImplementationOnce(() => recoveryTurn());

    const output = await generateOneShotText({
      prompt: "请依据世界设定完成本轮推演",
      systemPrompt: "输出故事正文与事件候选",
      workspacePath: "C:/workspace",
      model: "test-model",
      maxTurns: 6,
      toolset: {
        id: "novel-world",
        context: {
          mode: "world",
          promptId: "novel.simulation.advance",
          promptVersion: "1.0.0",
        },
      },
    });

    expect(output).toBe("收敛后的故事正文");
    expect(mocks.sdkQuery).toHaveBeenCalledTimes(2);
    expect(mocks.sdkQuery.mock.calls[1]?.[0]?.prompt).toContain("世界设定快照");
    expect(mocks.sdkQuery.mock.calls[1]?.[0]?.options).toMatchObject({
      maxTurns: 1,
      mcpServers: {},
    });
  });
});
