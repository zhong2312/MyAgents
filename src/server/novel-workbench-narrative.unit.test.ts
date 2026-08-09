import { promises as fs } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNarrativeEngineeringFiles,
  narrativeRecordPath,
  type NarrativeEngineeringStorageAggregate,
} from "../shared/workbenches/novel/narrativeEngineeringStorage";

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

function fixture(): NarrativeEngineeringStorageAggregate {
  return {
    schemaVersion: 4,
    updatedAt: "2026-08-09T00:00:00.000Z",
    lines: [{
      id: "line-main",
      title: "主线",
      kind: "main",
      storyRole: "a",
      status: "active",
      color: "#123456",
      premise: "主角必须完成试炼。",
      protagonistCharacterId: null,
      keyNodes: [],
      content: "线路正文",
    }],
    arcs: [],
    directories: [],
    chapters: [],
    simulationProposals: [],
  };
}

async function writeSource(
  workspace: string,
  library: NarrativeEngineeringStorageAggregate,
): Promise<void> {
  for (const file of createNarrativeEngineeringFiles(library)) {
    const path = join(workspace, ...file.path.split("/"));
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, file.content, "utf8");
  }
}

describe("剧情工程目录化工具", () => {
  let workspace = "";

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.createServer.mockClear();
    workspace = await fs.mkdtemp(join(tmpdir(), "myagents-narrative-"));
    configureNovelWorkbenchRequest(
      {
        mode: "narrative",
        promptId: "novel.narrative.assist",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-narrative-1", workspace },
    );
    await writeSource(workspace, fixture());
    await createNovelWorkbenchServer();
  });

  afterEach(async () => {
    clearNovelWorkbenchContext();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("按记录范围读取事实并返回整个目录的 sourceHash", async () => {
    const context = await callTool("novel_narrative_get_context", {
      scope: "lines",
      ids: ["line-main"],
    });

    expect(context).toMatchObject({
      sourcePath: "narrative/index.json",
      source: "saved-facts",
      scope: "lines",
    });
    expect(context.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(context.data).toEqual({ lines: [expect.objectContaining({ id: "line-main" })] });
  });

  it("任一记录变化后使既有草稿 sourceHash 失效", async () => {
    const context = await callTool("novel_narrative_get_context", {});
    await callTool("novel_narrative_create_draft", {
      draftId: "narrative-hash-draft",
      title: "哈希测试",
      baseSourceHash: context.sourceHash,
    });
    const linePath = join(
      workspace,
      ...narrativeRecordPath("lines", "line-main").split("/"),
    );
    await fs.writeFile(
      linePath,
      `${JSON.stringify({ ...fixture().lines[0], content: "外部修改" }, null, 2)}\n`,
      "utf8",
    );

    const validated = await callTool("novel_narrative_validate_draft", {
      draftId: "narrative-hash-draft",
    });
    expect(validated.valid).toBe(false);
    expect(validated.errors).toEqual([
      expect.stringContaining("事实源已变化"),
    ]);
  });
});
