import { promises as fs } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CharacterSoulDefinition } from "../shared/workbenches/novel/characterLibrarySchema";
import {
  characterSoulRecordPath,
  createCharacterSoulFiles,
} from "../shared/workbenches/novel/characterSoulStorage";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (args: Record<string, unknown>) => Promise<ToolResult>
  >(),
  createServer: vi.fn((config: unknown) => ({
    type: "sdk",
    name: "novel-workbench",
    config,
  })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mocks.createServer,
  tool: vi.fn(
    (
      name: string,
      _description: string,
      _schema: unknown,
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => {
      mocks.handlers.set(name, handler);
      return { name };
    },
  ),
}));

import {
  clearNovelWorkbenchContext,
  configureNovelWorkbenchRequest,
} from "./novel-workbench-context";
import { createNovelWorkbenchServer } from "./tools/novel-workbench-tool";

function decode(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = mocks.handlers.get(name);
  if (!handler) throw new Error(`测试工具未注册：${name}`);
  return decode(await handler(args));
}

function soul(): CharacterSoulDefinition {
  return {
    id: "soul-a",
    builtIn: false,
    name: "审慎决断",
    category: "决策",
    summary: "先核对事实再行动。",
    expressionDna: "简洁",
    mentalModel: "证据优先",
    decisionHeuristics: "先验证",
    valueAntiPatterns: "拒绝武断",
    boundaries: "不覆盖人物经历",
    expressionConflictKeywords: [],
    decisionConflictKeywords: [],
    valueConflictKeywords: [],
    amplificationKeywords: [],
  };
}

async function writeText(
  workspace: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(workspace, ...relativePath.split("/"));
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, "utf8");
}

describe("人物库目录化工具", () => {
  let workspace = "";

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.createServer.mockClear();
    workspace = await fs.mkdtemp(join(tmpdir(), "myagents-character-"));
    configureNovelWorkbenchRequest(
      {
        mode: "characters",
        promptId: "novel.characters.assist",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-character-1", workspace },
    );
    await writeText(
      workspace,
      "characters/library.json",
      `${JSON.stringify(
        {
          schemaVersion: 1,
          races: [],
          groups: [],
          ungroupedGroup: {
            id: "ungrouped",
            name: "未分组",
            description: "",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeText(
      workspace,
      "characters/index.json",
      `${JSON.stringify({ schemaVersion: 1, characters: [] }, null, 2)}\n`,
    );
    for (const file of createCharacterSoulFiles([soul()])) {
      await writeText(workspace, file.path, file.content);
    }
    await createNovelWorkbenchServer();
  });

  afterEach(async () => {
    clearNovelWorkbenchContext();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("从灵魂目录聚合上下文并返回完整事实源哈希", async () => {
    const context = await callTool("novel_characters_get_context", {});

    expect(context).toMatchObject({
      sourcePath: "characters/index.json",
      souls: [
        expect.objectContaining({ id: "soul-a", mentalModel: "证据优先" }),
      ],
    });
    expect(context.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("任一灵魂记录变化都会改变上下文 sourceHash", async () => {
    const before = await callTool("novel_characters_get_context", {});
    const recordPath = join(
      workspace,
      ...characterSoulRecordPath("soul-a").split("/"),
    );
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    record.mentalModel = "外部更新";
    await fs.writeFile(
      recordPath,
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );

    const after = await callTool("novel_characters_get_context", {});
    expect(after.sourceHash).not.toBe(before.sourceHash);
  });
});
