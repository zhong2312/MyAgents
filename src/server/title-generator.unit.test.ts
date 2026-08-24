import { describe, expect, it } from "vitest";
import {
  BUILTIN_TITLE_TIMEOUT_MS,
  OneShotTextTimeoutError,
  buildExternalTitleSessionOptions,
  extractTitleTextFromSdkMessage,
  extractOneShotSdkError,
  extractOneShotTextDeltaFromSdkMessage,
  extractOneShotToolContextFromSdkMessage,
  isOneShotMaxTurnsError,
  resolveOneShotReadToolCallLimit,
  resolveOneShotTextMaxTurns,
  shouldUseDirectOneShotText,
} from "./title-generator";

describe("extractTitleTextFromSdkMessage", () => {
  it("reads text even when a thinking block precedes it", () => {
    expect(
      extractTitleTextFromSdkMessage({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hidden reasoning" },
            { type: "text", text: "会话标题" },
          ],
        },
      }),
    ).toBe("会话标题");
  });

  it("joins multiple assistant text blocks and ignores non-text blocks", () => {
    expect(
      extractTitleTextFromSdkMessage({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "MyAgents " },
            { type: "tool_use", id: "toolu_1" },
            { type: "text", text: "标题修复" },
          ],
        },
      }),
    ).toBe("MyAgents 标题修复");
  });

  it("falls back to the last assistant message from a success result", () => {
    expect(
      extractTitleTextFromSdkMessage({
        type: "result",
        subtype: "success",
        messages: [
          { role: "user", content: [{ type: "text", text: "prompt" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "first draft" }],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "x" },
              { type: "text", text: "最终标题" },
            ],
          },
        ],
      }),
    ).toBe("最终标题");
  });

  it("reads the SDK 0.3 result.result field when no assistant message is present", () => {
    expect(
      extractTitleTextFromSdkMessage({
        type: "result",
        subtype: "success",
        result: "Result 字段标题",
      }),
    ).toBe("Result 字段标题");
  });

  it("returns null for whitespace-only or failed result messages", () => {
    expect(
      extractTitleTextFromSdkMessage({
        type: "assistant",
        message: { content: [{ type: "text", text: "   " }] },
      }),
    ).toBeNull();
    expect(
      extractTitleTextFromSdkMessage({
        type: "result",
        subtype: "error_during_execution",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "ignored" }] },
        ],
      }),
    ).toBeNull();
  });
});

describe("BUILTIN_TITLE_TIMEOUT_MS", () => {
  it("keeps builtin title generation within the same 30s budget as external title generation", () => {
    expect(BUILTIN_TITLE_TIMEOUT_MS).toBe(30_000);
  });
});

describe("OneShotTextTimeoutError", () => {
  it("preserves the bounded one-shot deadline for the API error response", () => {
    const error = new OneShotTextTimeoutError(150_000);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OneShotTextTimeoutError");
    expect(error.timeoutMs).toBe(150_000);
  });
});

describe("resolveOneShotTextMaxTurns", () => {
  it("applies the extended tool budget while keeping tool-free runs single-turn", () => {
    expect(resolveOneShotTextMaxTurns(16, true)).toBe(16);
    expect(resolveOneShotTextMaxTurns(999, true)).toBe(16);
    expect(resolveOneShotTextMaxTurns(16, false)).toBe(1);
  });
});

describe("shouldUseDirectOneShotText", () => {
  it("only enables the direct path for provider-backed tool-free runs", () => {
    const base = {
      prompt: "prompt",
      systemPrompt: "system",
      workspacePath: "/workspace",
      model: "model",
      maxTurns: 1,
    };
    expect(shouldUseDirectOneShotText(base)).toBe(false);
    expect(
      shouldUseDirectOneShotText({
        ...base,
        providerEnv: { apiProtocol: "anthropic", apiKey: "key" },
      }),
    ).toBe(true);
    expect(
      shouldUseDirectOneShotText({
        ...base,
        providerEnv: { apiProtocol: "openai", apiKey: "key" },
        toolset: { id: "novel-workbench", context: { mode: "full" } },
      }),
    ).toBe(false);
  });
});

describe("extractOneShotTextDeltaFromSdkMessage", () => {
  it("reads text deltas without treating tool payloads as output", () => {
    expect(
      extractOneShotTextDeltaFromSdkMessage({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "润色后的句子" },
        },
      }),
    ).toBe("润色后的句子");
    expect(
      extractOneShotTextDeltaFromSdkMessage({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
      }),
    ).toBe("");
  });
});

describe("one-shot max-turn recovery", () => {
  it("recognizes the SDK terminal error and keeps only successful tool returns", () => {
    expect(
      extractOneShotSdkError({
        type: "result",
        subtype: "error_max_turns",
        errors: [
          "Claude Code returned an error result: Reached maximum number of turns (16)",
        ],
      }),
    ).toContain("Reached maximum number of turns");
    expect(isOneShotMaxTurnsError(new Error("error_max_turns"))).toBe(true);
    expect(
      extractOneShotToolContextFromSdkMessage({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [{ type: "text", text: "世界架构资料" }],
            },
            {
              type: "tool_result",
              is_error: true,
              content: [{ type: "text", text: "不要保留" }],
            },
          ],
        },
      }),
    ).toBe("世界架构资料");
  });
});

describe("resolveOneShotReadToolCallLimit", () => {
  it("accepts a bounded declarative recovery limit", () => {
    expect(resolveOneShotReadToolCallLimit("5")).toBe(5);
    expect(resolveOneShotReadToolCallLimit(3.6)).toBe(4);
    expect(resolveOneShotReadToolCallLimit("0")).toBe(1);
    expect(resolveOneShotReadToolCallLimit("99")).toBe(10);
  });

  it("ignores malformed limits", () => {
    expect(resolveOneShotReadToolCallLimit(undefined)).toBeUndefined();
    expect(resolveOneShotReadToolCallLimit("five")).toBeUndefined();
    expect(resolveOneShotReadToolCallLimit("5.5")).toBeUndefined();
  });
});

describe("buildExternalTitleSessionOptions", () => {
  const base = {
    sessionId: "title-session",
    workspacePath: "/workspace",
    userPrompt: "Write the title",
    clientUserMessageId: "title-user-message",
    runtimeType: "codex" as const,
    model: "gpt-5.6-sol",
  };

  it("keeps Managed Codex identity while disabling workspace MCP for the utility turn", () => {
    const options = buildExternalTitleSessionOptions({
      ...base,
      runtimeSource: "managed-provider",
    });

    expect(options).toMatchObject({
      runtimeSource: "managed-provider",
      mcpServers: [],
      permissionMode: "suggest",
      reasoningEffort: "low",
      ephemeral: true,
      maxTurns: 1,
      scenario: { type: "desktop" },
    });
  });

  it("preserves system-cli ownership without pretending an empty injected set clears user config", () => {
    const options = buildExternalTitleSessionOptions({
      ...base,
      runtimeSource: "system-cli",
    });

    expect(options.runtimeSource).toBe("system-cli");
    expect(options).not.toHaveProperty("mcpServers");
    expect(options).not.toHaveProperty("reasoningEffort");
    expect(options).not.toHaveProperty("ephemeral");
  });
});
