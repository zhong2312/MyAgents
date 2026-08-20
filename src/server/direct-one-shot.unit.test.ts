import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("undici", () => ({
  fetch: mocks.fetch,
  ProxyAgent: class {
    async close(): Promise<void> {
      return undefined;
    }
  },
}));

vi.mock("./proxy-state", () => ({
  getProxyForProviderUrl: vi.fn(() => undefined),
}));

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function requestFor(apiProtocol: "anthropic" | "openai") {
  return {
    prompt: "请润色这一段正文。",
    systemPrompt: "只输出润色后的正文。",
    workspacePath: "C:/workspace",
    model: "test-model",
    providerEnv: {
      providerId: "test-provider",
      baseUrl:
        apiProtocol === "openai"
          ? "https://provider.test/v1"
          : "https://provider.test",
      apiKey: "test-key",
      apiProtocol,
      upstreamFormat: "chat_completions" as const,
    },
    streamText: true,
    timeoutMs: 1_000,
  };
}

describe("generateDirectOneShotText", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
  });

  it("直接调用 Anthropic Messages API 并转发文本增量", async () => {
    mocks.fetch.mockResolvedValue(
      sseResponse([
        'data: {"type":"content_block_start","content_block":{"type":"text","text":"润"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"色"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );
    const progress: string[] = [];
    const { generateDirectOneShotText } = await import("./direct-one-shot");
    const output = await generateDirectOneShotText({
      ...requestFor("anthropic"),
      onProgress: (partialOutput) => progress.push(partialOutput),
    });

    expect(output).toBe("润色");
    expect(progress).toEqual(["润", "润色"]);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://provider.test/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
    const init = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "test-model",
      stream: true,
      messages: [{ role: "user", content: "请润色这一段正文。" }],
    });
  });

  it("复用 OpenAI bridge 的单次 HTTP 请求，不经过 SDK", async () => {
    mocks.fetch.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"桥"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"接"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const progress: string[] = [];
    const { generateDirectOneShotText } = await import("./direct-one-shot");
    const output = await generateDirectOneShotText({
      ...requestFor("openai"),
      onProgress: (partialOutput) => progress.push(partialOutput),
    });

    expect(output).toBe("桥接");
    expect(progress.at(-1)).toBe("桥接");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://provider.test/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("支持无需增量 UI 的一次性 JSON 响应", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "ignored" },
            { type: "text", text: "质量审查结果" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { generateDirectOneShotText } = await import("./direct-one-shot");

    await expect(
      generateDirectOneShotText({
        ...requestFor("anthropic"),
        streamText: false,
      }),
    ).resolves.toBe("质量审查结果");
  });

  it("超时和取消会中断底层请求并返回明确错误", async () => {
    mocks.fetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const {
      generateDirectOneShotText,
      DirectOneShotTimeoutError,
      DirectOneShotCancelledError,
    } = await import("./direct-one-shot");

    await expect(
      generateDirectOneShotText({ ...requestFor("anthropic"), timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(DirectOneShotTimeoutError);

    const abortController = new AbortController();
    const pending = generateDirectOneShotText({
      ...requestFor("anthropic"),
      abortController,
      timeoutMs: 1_000,
    });
    abortController.abort();
    await expect(pending).rejects.toBeInstanceOf(DirectOneShotCancelledError);
  });
});
