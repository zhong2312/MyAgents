import { promises as fs } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTimelineFiles,
  timelineRecordPath,
  type TimelineStorageAggregate,
} from "../shared/workbenches/novel/timelineStorage";

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

const NOW = "2026-08-09T00:00:00.000Z";

function fixture(): TimelineStorageAggregate {
  return {
    schemaVersion: 1,
    calendars: [
      { id: "calendar-main", name: "主历", unit: "年", description: "" },
    ],
    periods: [],
    views: [],
    storyStartEventId: "event-main",
    factsThroughEventId: null,
    branches: [
      {
        id: "branch-main",
        name: "主线",
        parentBranchId: null,
        forkEventId: null,
        description: "",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    events: [
      {
        id: "event-main",
        branchId: "branch-main",
        title: "开端",
        summary: "事件摘要",
        description: "事件正文",
        stateChanges: [],
        foreshadowings: [],
      },
    ],
  };
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

describe("时间线目录化工具", () => {
  let workspace = "";

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.createServer.mockClear();
    workspace = await fs.mkdtemp(join(tmpdir(), "myagents-timeline-"));
    configureNovelWorkbenchRequest(
      {
        mode: "timeline",
        promptId: "novel.timeline.assist",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-timeline-1", workspace },
    );
    for (const file of createTimelineFiles(fixture())) {
      await writeText(workspace, file.path, file.content);
    }
    await createNovelWorkbenchServer();
  });

  afterEach(async () => {
    clearNovelWorkbenchContext();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("按范围读取目录记录并返回整个目录的 sourceHash", async () => {
    const context = await callTool("novel_timeline_get_context", {
      scope: "events",
      ids: ["event-main"],
    });

    expect(context).toMatchObject({
      sourcePath: "timeline/index.json",
      scope: "events",
      data: { events: [expect.objectContaining({ id: "event-main" })] },
    });
    expect(context.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("任一事件记录变化都会改变 sourceHash", async () => {
    const before = await callTool("novel_timeline_get_context", {});
    const path = join(
      workspace,
      ...timelineRecordPath("events", "event-main").split("/"),
    );
    const record = JSON.parse(await fs.readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    record.description = "外部更新";
    await fs.writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const after = await callTool("novel_timeline_get_context", {});
    expect(after.sourceHash).not.toBe(before.sourceHash);
  });
});
