import { promises as fs } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

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
import {
  createEmptyCultivationEcology,
  type CultivationEcology,
} from "../shared/workbenches/novel/cultivationEcologySchema";
import {
  createCultivationEcologyFiles,
  loadCultivationEcologyFiles,
  serializeCultivationFileSnapshot,
} from "../shared/workbenches/novel/cultivationEcologyStorage";
import {
  hashNovelWorkbenchDraftPayload,
  loadNovelWorkbenchDraft,
} from "./novel-workbench-draft";
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

function originFixture() {
  return {
    id: "origin-1",
    name: "本源",
    summary: "",
    kind: "本源",
    ontologyStatement: "",
    status: "stable" as const,
    scopes: [],
    constraints: [],
    manifestations: [],
    relations: [],
  };
}

async function writeCultivationSource(
  workspace: string,
  ecology: CultivationEcology,
): Promise<void> {
  for (const file of createCultivationEcologyFiles(ecology)) {
    const path = join(workspace, ...file.path.split("/"));
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, file.content, "utf8");
  }
}

async function readCultivationSource(workspace: string) {
  const loaded = await loadCultivationEcologyFiles((path) =>
    fs.readFile(join(workspace, ...path.split("/")), "utf8"),
  );
  return {
    content: `${JSON.stringify(loaded.ecology, null, 2)}\n`,
    sourceHash: hashNovelWorkbenchDraftPayload(
      serializeCultivationFileSnapshot(loaded.files),
    ),
  };
}

describe("修炼体系增量草稿工具", () => {
  let workspace = "";

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.createServer.mockClear();
    workspace = await fs.mkdtemp(join(tmpdir(), "myagents-cultivation-"));
    configureNovelWorkbenchRequest(
      {
        mode: "cultivation",
        promptId: "novel.cultivation.assist",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-cultivation-1", workspace },
    );
    const ecology: CultivationEcology = {
      ...createEmptyCultivationEcology(),
      worldOrigins: [originFixture()],
    };
    await writeCultivationSource(workspace, ecology);
    await createNovelWorkbenchServer();
  });

  afterEach(async () => {
    clearNovelWorkbenchContext();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("按稳定 ID 增量修改且默认不回传整份内容", async () => {
    const source = await readCultivationSource(workspace);
    const created = await callTool("novel_cultivation_create_draft", {
      draftId: "cultivation-patch-draft",
      title: "增量草稿",
      baseSourceHash: source.sourceHash,
    });
    expect(
      (created.payload as Record<string, unknown>).contentBytes,
    ).toBeTypeOf("number");
    expect(
      (created.payload as Record<string, unknown>).content,
    ).toBeUndefined();

    const patched = await callTool("novel_cultivation_patch_draft", {
      draftId: "cultivation-patch-draft",
      operations: [
        {
          action: "merge",
          targetId: "origin-1",
          fields: { summary: "已增量更新" },
        },
      ],
    });
    expect(patched.changed).toEqual(["merge:origin-1"]);
    expect(
      (patched.payload as Record<string, unknown>).content,
    ).toBeUndefined();

    const draft = await loadNovelWorkbenchDraft<{
      content: string;
    }>(workspace, "cultivation", "cultivation-patch-draft");
    const parsed = JSON.parse(draft.payload.content) as CultivationEcology;
    expect(parsed.worldOrigins[0]?.summary).toBe("已增量更新");

    const full = await callTool("novel_cultivation_get_draft", {
      draftId: "cultivation-patch-draft",
      includeContent: true,
    });
    expect((full.payload as Record<string, unknown>).content).toContain(
      "已增量更新",
    );
  });

  it("拒绝通过 merge 修改稳定 ID", async () => {
    const source = await readCultivationSource(workspace);
    await callTool("novel_cultivation_create_draft", {
      draftId: "cultivation-protected-draft",
      title: "保护字段",
      baseSourceHash: source.sourceHash,
    });
    const result = await callTool("novel_cultivation_patch_draft", {
      draftId: "cultivation-protected-draft",
      operations: [
        {
          action: "merge",
          targetId: "origin-1",
          fields: { id: "other-origin" },
        },
      ],
    });
    expect(result.error).toContain("稳定字段");
  });

  it("支持追加和删除对象，并拒绝超大整份替换", async () => {
    const source = await readCultivationSource(workspace);
    await callTool("novel_cultivation_create_draft", {
      draftId: "cultivation-append-remove-draft",
      title: "追加删除",
      baseSourceHash: source.sourceHash,
    });

    const appended = await callTool("novel_cultivation_patch_draft", {
      draftId: "cultivation-append-remove-draft",
      operations: [
        {
          action: "append",
          collection: "worldOrigins",
          value: { ...originFixture(), id: "origin-2", name: "第二本源" },
        },
      ],
    });
    expect(appended.changed).toEqual(["append:worldOrigins"]);

    const removed = await callTool("novel_cultivation_patch_draft", {
      draftId: "cultivation-append-remove-draft",
      operations: [{ action: "remove", targetId: "origin-2" }],
    });
    expect(removed.changed).toEqual(["remove:origin-2"]);

    const oversized = await callTool("novel_cultivation_upsert_draft", {
      draftId: "cultivation-append-remove-draft",
      content: JSON.stringify({ content: "x".repeat(70 * 1024) }),
    });
    expect(oversized.error).toContain("请改用 novel_cultivation_patch_draft");
  });

  it("校验时自动规范化草稿并直接返回可提交令牌", async () => {
    const source = await readCultivationSource(workspace);
    await callTool("novel_cultivation_create_draft", {
      draftId: "cultivation-normalize-draft",
      title: "自动规范化",
      baseSourceHash: source.sourceHash,
    });
    await callTool("novel_cultivation_upsert_draft", {
      draftId: "cultivation-normalize-draft",
      content: JSON.stringify(JSON.parse(source.content)),
    });

    const validated = await callTool("novel_cultivation_validate_draft", {
      draftId: "cultivation-normalize-draft",
    });
    expect(validated).toMatchObject({ valid: true, normalized: true });
    expect(validated.validationToken).toEqual(expect.any(String));

    const draft = await loadNovelWorkbenchDraft<{ content: string }>(
      workspace,
      "cultivation",
      "cultivation-normalize-draft",
    );
    expect(draft.payload.content).toBe(source.content);
    expect(draft.validation?.revision).toBe(draft.revision);
  });

  it("提交时按变化模块生成多文件提案快照", async () => {
    const source = await readCultivationSource(workspace);
    await callTool("novel_cultivation_create_draft", {
      draftId: "cultivation-module-proposal",
      title: "模块提案",
      baseSourceHash: source.sourceHash,
    });
    await callTool("novel_cultivation_patch_draft", {
      draftId: "cultivation-module-proposal",
      operations: [
        {
          action: "merge",
          targetId: "origin-1",
          fields: { summary: "模块化更新" },
        },
      ],
    });
    const validated = await callTool("novel_cultivation_validate_draft", {
      draftId: "cultivation-module-proposal",
    });
    const submitted = await callTool("novel_cultivation_submit_draft", {
      draftId: "cultivation-module-proposal",
      validationToken: validated.validationToken,
    });
    expect(submitted.submitted).toBe(true);

    const proposalRoot = join(
      workspace,
      "world",
      "cultivation-proposals",
      "cultivation-cultivation-module-proposal",
    );
    const manifest = JSON.parse(
      await fs.readFile(join(proposalRoot, "proposal.json"), "utf8"),
    ) as { changes: { targetPath: string }[] };
    expect(manifest.changes.map((change) => change.targetPath)).toEqual(
      expect.arrayContaining([
        "world/cultivation/index.json",
        "world/cultivation/origins/records/origin-1.json",
      ]),
    );
    expect(JSON.stringify(manifest)).not.toContain("cultivation-ecology.json");
    await expect(
      fs.readFile(
        join(
          proposalRoot,
          "after",
          "world",
          "cultivation",
          "origins",
          "records",
          "origin-1.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("模块化更新");
  });
});
