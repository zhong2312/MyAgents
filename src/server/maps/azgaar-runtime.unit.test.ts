import { describe, expect, it, vi } from "vitest";

import { createAzgaarRuntimeClient } from "./azgaar-runtime";

describe("azgaar runtime client", () => {
  it("发送世界 sourceHash 和文件快照并解析官方导出", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ format: "json", content: '{"pack":{}}' }), { status: 200 }),
    );
    const runtime = createAzgaarRuntimeClient({ baseUrl: "http://127.0.0.1:4567", fetchImpl });
    const result = await runtime.generate({
      seed: "nine-realms",
      width: 1600,
      height: 1000,
      world: { sourceHash: "a".repeat(64), files: { "world/settings.md": "山脉" } },
    });
    expect(result).toEqual({ format: "json", content: '{"pack":{}}' });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.seed).toBe("nine-realms");
    expect(body.world.contextHash).toBe("a".repeat(64));
    expect(body.world.files["world/settings.md"]).toBe("山脉");
  });

  it("Runtime HTTP 错误会返回可诊断信息", async () => {
    const runtime = createAzgaarRuntimeClient({
      baseUrl: "http://127.0.0.1:4567",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: "浏览器入口缺失" }), { status: 503 }),
      ),
    });
    await expect(runtime.generate({ seed: "x", width: 1, height: 1, world: { sourceHash: "b", files: {} } })).rejects.toThrow("HTTP 503：浏览器入口缺失");
  });
});
