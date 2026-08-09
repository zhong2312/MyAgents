import { promises as fs } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFactionFiles,
  factionRecordPath,
  type FactionStorageAggregate,
  type FactionStorageRecord,
} from "../shared/workbenches/novel/factionStorage";

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

function faction(): FactionStorageRecord {
  return {
    id: "faction-cloud-sect",
    name: "青云宗",
    type: "宗门",
    status: "active",
    summary: "坐镇东玄大陆的剑修宗门。",
    state: {
      governance: "",
      military: "",
      economy: "",
      publicSupport: "",
      territorialIntegrity: "",
    },
    territories: [],
    members: [],
    assets: [],
    resources: [],
    organizationUnits: [],
    relations: [],
    rights: [],
    links: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function fixture(): FactionStorageAggregate {
  return { schemaVersion: 2, factions: [faction()] };
}

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

async function writeText(
  workspace: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(workspace, ...relativePath.split("/"));
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, "utf8");
}

describe("势力库目录化工具", () => {
  let workspace = "";

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.createServer.mockClear();
    workspace = await fs.mkdtemp(join(tmpdir(), "myagents-faction-"));
    configureNovelWorkbenchRequest(
      {
        mode: "factions",
        promptId: "novel.factions.assist",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-faction-1", workspace },
    );
    for (const file of createFactionFiles(fixture())) {
      await writeText(workspace, file.path, file.content);
    }
    await createNovelWorkbenchServer();
  });

  afterEach(async () => {
    clearNovelWorkbenchContext();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("从独立记录读取上下文并用整个目录计算 sourceHash", async () => {
    const before = await callTool("novel_factions_get_context", {
      factionId: "faction-cloud-sect",
    });
    expect(before).toMatchObject({
      sourcePath: "world/factions/index.json",
      factions: [
        {
          id: "faction-cloud-sect",
          name: "青云宗",
        },
      ],
    });
    expect(before.sourceHash).toMatch(/^[a-f0-9]{64}$/u);

    const recordPath = join(
      workspace,
      ...factionRecordPath("faction-cloud-sect").split("/"),
    );
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    record.summary = "外部更新后的宗门摘要。";
    await fs.writeFile(
      recordPath,
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );

    const after = await callTool("novel_factions_get_context", {});
    expect(after.sourceHash).not.toBe(before.sourceHash);
  });

  it("校验更新草稿时从独立记录识别已有势力", async () => {
    await callTool("novel_factions_create_draft", {
      draftId: "faction-update-draft",
      title: "调整青云宗",
    });
    await callTool("novel_factions_upsert_draft_operations", {
      draftId: "faction-update-draft",
      operations: [
        {
          candidateId: "candidate-cloud-sect",
          kind: "faction",
          action: "update",
          targetId: "faction-cloud-sect",
          summary: "更新势力摘要",
          value: {
            ...faction(),
            summary: "调整后的势力摘要。",
          },
        },
      ],
    });

    await expect(
      callTool("novel_factions_validate_draft", {
        draftId: "faction-update-draft",
      }),
    ).resolves.toMatchObject({ valid: true });
  });
});
