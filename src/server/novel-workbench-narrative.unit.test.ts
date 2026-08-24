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
    lines: [
      {
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
      },
    ],
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

async function writeNovelMetadata(workspace: string): Promise<void> {
  await fs.writeFile(
    join(workspace, "novel.json"),
    `${JSON.stringify(
      {
        title: "三百万字测试小说",
        targetWordCountMin: 3_000_000,
        targetWordCountMax: 3_000_000,
        chapterWordCount: 3_000,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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
    await writeNovelMetadata(workspace);
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
    expect(context.data).toEqual({
      lines: [expect.objectContaining({ id: "line-main" })],
    });
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
    expect(validated.errors).toEqual([expect.stringContaining("事实源已变化")]);
  });

  it("全书规划必须符合目标字数折算的章节规模，并保留目录额度", async () => {
    const context = await callTool("novel_narrative_get_context", {});
    await callTool("novel_narrative_create_draft", {
      draftId: "narrative-full-scale",
      title: "全书规模测试",
      baseSourceHash: context.sourceHash,
      planningScope: "full-novel",
    });
    await callTool("novel_narrative_upsert_draft_directories", {
      draftId: "narrative-full-scale",
      directories: [
        {
          candidateId: "volume-one",
          parentId: null,
          kind: "volume",
          title: "第一卷",
          order: 0,
          plannedChapterCount: 0,
        },
        {
          candidateId: "part-one",
          parentId: "volume-one",
          kind: "part",
          title: "开篇",
          order: 0,
          plannedChapterCount: 2,
        },
      ],
    });

    const undersized = await callTool("novel_narrative_validate_draft", {
      draftId: "narrative-full-scale",
    });
    expect(undersized.valid).toBe(false);
    expect(undersized.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("全书规划 2 章"),
        expect.stringContaining("1000 至 1000 章"),
      ]),
    );

    await callTool("novel_narrative_upsert_draft_directories", {
      draftId: "narrative-full-scale",
      directories: [
        {
          candidateId: "part-one",
          parentId: "volume-one",
          kind: "part",
          title: "开篇",
          order: 0,
          plannedChapterCount: 1_000,
        },
      ],
    });
    const validated = await callTool("novel_narrative_validate_draft", {
      draftId: "narrative-full-scale",
    });
    expect(validated.valid).toBe(true);

    const submitted = await callTool("novel_narrative_submit_draft", {
      draftId: "narrative-full-scale",
      validationToken: validated.validationToken,
    });
    expect(submitted.submitted).toBe(true);
    const proposal = JSON.parse(
      await fs.readFile(
        join(
          workspace,
          "narrative",
          "proposals",
          "narrative-narrative-full-scale",
          "proposal.json",
        ),
        "utf8",
      ),
    ) as { directories: Array<{ value: { plannedChapterCount: number } }> };
    expect(proposal.directories[1]?.value.plannedChapterCount).toBe(1_000);
  });

  it("局部规划不受全书章节规模约束", async () => {
    const context = await callTool("novel_narrative_get_context", {});
    await callTool("novel_narrative_create_draft", {
      draftId: "narrative-partial-scale",
      title: "局部补章测试",
      baseSourceHash: context.sourceHash,
    });
    await callTool("novel_narrative_upsert_draft_directories", {
      draftId: "narrative-partial-scale",
      directories: [
        {
          candidateId: "volume-partial",
          parentId: null,
          kind: "volume",
          title: "局部卷",
          order: 0,
          plannedChapterCount: 0,
        },
        {
          candidateId: "part-partial",
          parentId: "volume-partial",
          kind: "part",
          title: "局部篇",
          order: 0,
          plannedChapterCount: 2,
        },
      ],
    });

    const validated = await callTool("novel_narrative_validate_draft", {
      draftId: "narrative-partial-scale",
    });
    expect(validated.valid).toBe(true);
  });
});
