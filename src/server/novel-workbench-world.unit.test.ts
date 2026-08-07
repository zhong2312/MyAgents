import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { loadNovelWorkbenchDraft } from "./novel-workbench-draft";
import { createNovelWorkbenchServer } from "./tools/novel-workbench-tool";

type WorldDraftPayload = {
  title: string;
  description: string;
  changes: Array<Record<string, unknown>>;
};

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

describe("novel world draft validation", () => {
  let workspace = "";

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.createServer.mockClear();
    workspace = await fs.mkdtemp(join(tmpdir(), "myagents-world-"));
    configureNovelWorkbenchRequest(
      {
        mode: "world",
        promptId: "novel.world.guide",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-world-1", workspace },
    );
    await fs.mkdir(join(workspace, "world", "setting-library"), {
      recursive: true,
    });
    await Promise.all([
      fs.writeFile(
        join(workspace, "world", "setting-library", "meta.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          levelTypes: [{ id: "world-root" }],
          settingTemplates: [{ id: "universe-overview" }],
          profiles: [
            {
              levelTypeId: "world-root",
              templateIds: ["universe-overview"],
            },
          ],
        })}\n`,
        "utf8",
      ),
      fs.writeFile(
        join(workspace, "world", "setting-library", "spatial-tree.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          nodes: [
            {
              id: "world-root",
              parentId: null,
              typeId: "world-root",
            },
          ],
        })}\n`,
        "utf8",
      ),
      fs.writeFile(
        join(workspace, "world", "setting-library", "settings.json"),
        `${JSON.stringify({ schemaVersion: 1, settings: [] })}\n`,
        "utf8",
      ),
    ]);
    await createNovelWorkbenchServer();
  });

  afterEach(async () => {
    clearNovelWorkbenchContext();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("拒绝缺少字段且把 Markdown 路径写进 entriesPath 的批量设定", async () => {
    const created = await callTool("novel_world_create_draft", {
      draftId: "bad-world-draft",
      title: "错误世界草稿",
    });
    const draftId = String(created.draftId);
    const badSettings = Array.from({ length: 36 }, (_, index) => {
      const id = `setting-${index + 1}`;
      const pagePath = `world/setting-library/pages/world-root/${id}.md`;
      return {
        id,
        nodeId: "world-root",
        templateId: null,
        pagePath,
        entriesPath: pagePath,
      };
    });
    const changes = [
      {
        id: "update-settings",
        targetPath: "world/setting-library/settings.json",
        operation: "modify",
        summary: "错误地重写设定索引",
        content: `${JSON.stringify({
          schemaVersion: 1,
          settings: badSettings,
        })}\n`,
      },
      ...badSettings.map((setting, index) => ({
        id: `create-page-${index + 1}`,
        targetPath: setting.pagePath,
        operation: "create",
        summary: `创建页面 ${index + 1}`,
        content: `# 页面 ${index + 1}\n`,
      })),
    ];
    await callTool("novel_world_upsert_draft_changes", { draftId, changes });

    const validation = await callTool("novel_world_validate_draft", {
      draftId,
    });
    const errors = validation.errors as string[];
    expect(validation.valid).toBe(false);
    expect(validation.validationToken).toBeUndefined();
    expect(errors).toHaveLength(36 * 4);
    expect(errors).toEqual(
      expect.arrayContaining([
        "设定 setting-1 缺少 name",
        "设定 setting-1 缺少 group",
        "设定 setting-1 的 status 必须是 draft 或 completed，当前为 undefined",
        expect.stringContaining("setting-1 的 entriesPath 必须形如"),
      ]),
    );

    const persisted = await loadNovelWorkbenchDraft<WorldDraftPayload>(
      workspace,
      "world",
      draftId,
    );
    expect(persisted.validation).toBeNull();

    const submitted = await callTool("novel_world_submit_draft", {
      draftId,
      validationToken: "not-a-real-token",
    });
    expect(submitted.submitted).toBe(false);
    await expect(
      fs.stat(
        join(
          workspace,
          "world",
          "setting-library",
          "proposals",
          `world-${draftId}`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("接受字段完整且正文与词条路径成对的设定草稿", async () => {
    const created = await callTool("novel_world_create_draft", {
      draftId: "valid-world-draft",
      title: "有效世界草稿",
    });
    const draftId = String(created.draftId);
    const id = "page-world-root-universe-overview";
    const pagePath = `world/setting-library/pages/world-root/${id}.md`;
    const entriesPath = `world/setting-library/entries/world-root/${id}.json`;
    const changes = [
      {
        id: "update-settings",
        targetPath: "world/setting-library/settings.json",
        operation: "modify",
        summary: "登记宇宙总览",
        content: `${JSON.stringify({
          schemaVersion: 1,
          settings: [
            {
              id,
              nodeId: "world-root",
              templateId: "universe-overview",
              templateVersion: "1.0.0",
              name: "宇宙总览",
              group: "世界",
              status: "draft",
              pagePath,
              entriesPath,
            },
          ],
        })}\n`,
      },
      {
        id: "create-page",
        targetPath: pagePath,
        operation: "create",
        summary: "创建宇宙总览正文",
        content: "# 宇宙总览\n",
      },
      {
        id: "create-entries",
        targetPath: entriesPath,
        operation: "create",
        summary: "创建宇宙总览词条",
        content: `${JSON.stringify({ schemaVersion: 1, entries: [] })}\n`,
      },
    ];
    await callTool("novel_world_upsert_draft_changes", { draftId, changes });

    const validation = await callTool("novel_world_validate_draft", {
      draftId,
    });
    expect(validation.valid).toBe(true);
    expect(validation.validationToken).toEqual(expect.any(String));

    const submitted = await callTool("novel_world_submit_draft", {
      draftId,
      validationToken: validation.validationToken,
    });
    expect(submitted.submitted).toBe(true);
    await expect(
      fs.stat(
        join(
          workspace,
          "world",
          "setting-library",
          "proposals",
          `world-${draftId}`,
          "proposal.json",
        ),
      ),
    ).resolves.toMatchObject({ isFile: expect.any(Function) });
  });
});
