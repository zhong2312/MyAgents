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
  loadNovelWorkbenchDraft,
  updateNovelWorkbenchDraft,
} from "./novel-workbench-draft";
import { createNovelWorkbenchServer } from "./tools/novel-workbench-tool";
import { createInspirationFiles } from "../shared/workbenches/novel/inspirationStorage";

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
          levelTypes: [
            {
              id: "world-root",
              name: "世界根",
              description: "",
              icon: "orbit",
              mapKind: "cosmic-region",
              source: "builtin",
              suggestedParentTypeIds: [],
              suggestedChildTypeIds: [],
            },
            {
              id: "continent",
              name: "大陆",
              description: "",
              icon: "map",
              mapKind: "geographic-area",
              source: "builtin",
              suggestedParentTypeIds: ["world-root"],
              suggestedChildTypeIds: [],
            },
          ],
          settingTemplates: [
            {
              id: "universe-overview",
              name: "宇宙总览",
              group: "世界",
              description: "",
              source: "builtin",
              version: "1.0.0",
              skeleton: "",
              agentGuide: "",
            },
          ],
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
              name: "测试世界",
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
    await callTool("novel_world_upsert_draft_changes", {
      draftId,
      changes: changes.slice(0, 32),
    });
    await callTool("novel_world_upsert_draft_changes", {
      draftId,
      changes: changes.slice(32),
    });

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

  it("拒绝 meta.json 中不受支持的 source 枚举值", async () => {
    const created = await callTool("novel_world_create_draft", {
      draftId: "invalid-source-world-draft",
      title: "非法来源草稿",
    });
    const meta = {
      schemaVersion: 1,
      levelTypes: [
        {
          id: "world-root",
          name: "世界根",
          description: "",
          icon: "orbit",
          mapKind: "cosmic-region",
          source: "builtin",
          suggestedParentTypeIds: [],
          suggestedChildTypeIds: ["dao-domain"],
        },
        {
          id: "dao-domain",
          name: "道域",
          description: "",
          icon: "orbit",
          mapKind: "cosmic-region",
          source: "custom",
          suggestedParentTypeIds: ["world-root"],
          suggestedChildTypeIds: [],
        },
      ],
      settingTemplates: [
        {
          id: "universe-overview",
          name: "宇宙总览",
          group: "世界",
          description: "",
          source: "builtin",
          version: "1.0.0",
          skeleton: "",
          agentGuide: "",
        },
      ],
      profiles: [
        { levelTypeId: "world-root", templateIds: ["universe-overview"] },
        { levelTypeId: "dao-domain", templateIds: [] },
      ],
    };
    await callTool("novel_world_upsert_draft_changes", {
      draftId: created.draftId,
      changes: [
        {
          id: "update-meta",
          targetPath: "world/setting-library/meta.json",
          operation: "modify",
          summary: "新增道域层级",
          content: `${JSON.stringify(meta)}\n`,
        },
      ],
    });

    const invalid = await callTool("novel_world_validate_draft", {
      draftId: created.draftId,
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.validationToken).toBeUndefined();
    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        "层级类型 dao-domain 的 source 必须为 builtin 或 project，当前为 custom",
      ]),
    );

    meta.levelTypes[1]!.source = "project";
    await callTool("novel_world_upsert_draft_changes", {
      draftId: created.draftId,
      changes: [
        {
          id: "update-meta",
          targetPath: "world/setting-library/meta.json",
          operation: "modify",
          summary: "修正道域层级来源",
          content: `${JSON.stringify(meta)}\n`,
        },
      ],
    });
    const repaired = await callTool("novel_world_validate_draft", {
      draftId: created.draftId,
    });
    expect(repaired.valid).toBe(true);
    expect(repaired.validationToken).toEqual(expect.any(String));
  });

  it("可以对世界架构文件做小批量增量修订", async () => {
    const created = await callTool("novel_world_create_draft", {
      draftId: "incremental-world-draft",
      title: "增量世界草稿",
    });
    const id = "page-world-root-incremental";
    const pagePath = `world/setting-library/pages/world-root/${id}.md`;
    const entriesPath = `world/setting-library/entries/world-root/${id}.json`;
    const patched = await callTool("novel_world_patch_draft_changes", {
      draftId: created.draftId,
      operations: [
        {
          targetPath: "world/setting-library/settings.json",
          action: "append",
          collection: "settings",
          value: {
            id,
            nodeId: "world-root",
            templateId: null,
            name: "增量设定",
            group: "世界",
            status: "draft",
            pagePath,
            entriesPath,
          },
        },
        {
          targetPath: pagePath,
          action: "text_append",
          content: "# 增量设定\n",
        },
        {
          targetPath: entriesPath,
          action: "append",
          collection: "entries",
          initial: { schemaVersion: 1 },
          value: { id: "entry-1", name: "第一条", content: "内容" },
        },
      ],
    });
    expect(patched.changed).toEqual([
      "append:world/setting-library/settings.json",
      `text_append:${pagePath}`,
      `append:${entriesPath}`,
    ]);
    expect((patched.payload as Record<string, unknown>).changesCount).toBe(3);
    expect(
      (patched.payload as Record<string, unknown>).changes,
    ).toBeUndefined();

    const full = await callTool("novel_world_get_draft", {
      draftId: "incremental-world-draft",
      includeContent: true,
    });
    expect((full.payload as Record<string, unknown>).changes).toHaveLength(3);

    const draft = await loadNovelWorkbenchDraft<WorldDraftPayload>(
      workspace,
      "world",
      "incremental-world-draft",
    );
    const changes = new Map(
      draft.payload.changes.map((change) => [
        String(change.targetPath),
        change,
      ]),
    );
    expect(
      JSON.parse(
        String(changes.get("world/setting-library/settings.json")?.content),
      ).settings,
    ).toHaveLength(1);
    expect(changes.get(pagePath)?.content).toBe("# 增量设定\n");
    expect(
      JSON.parse(String(changes.get(entriesPath)?.content)).entries,
    ).toHaveLength(1);
  });

  it("以聚合地点库生成增量草稿和提案快照", async () => {
    const locationsDirectory = join(workspace, "world", "locations");
    const recordsDirectory = join(locationsDirectory, "records");
    await fs.mkdir(recordsDirectory, { recursive: true });
    const record = {
      id: "cloud-city",
      nodeId: "world-root",
      parentLocationId: null,
      name: "云城",
      aliases: [],
      type: "城市",
      status: "planned",
      summary: "",
      appearanceNote: "",
      description: "旧描述",
      order: 0,
    };
    await Promise.all([
      fs.writeFile(
        join(locationsDirectory, "index.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          storageVersion: 1,
          locations: [
            {
              id: "cloud-city",
              path: "world/locations/records/cloud-city.json",
            },
          ],
        })}\n`,
        "utf8",
      ),
      fs.writeFile(
        join(recordsDirectory, "cloud-city.json"),
        `${JSON.stringify(record)}\n`,
        "utf8",
      ),
    ]);

    const context = await callTool("novel_world_get_context", {});
    const contextFiles = context.files as Record<string, string>;
    const logical = JSON.parse(
      contextFiles["world/locations/index.json"] ?? "{}",
    ) as { locations?: Array<Record<string, unknown>> };
    expect(logical.locations?.[0]).toMatchObject({
      id: "cloud-city",
      name: "云城",
      description: "旧描述",
    });
    expect(logical.locations?.[0]).not.toHaveProperty("path");
    expect(context.locationSourceHash).toEqual(expect.any(String));

    await callTool("novel_world_create_draft", {
      draftId: "location-world-draft",
      title: "地点增量草稿",
    });
    await callTool("novel_world_patch_draft_changes", {
      draftId: "location-world-draft",
      operations: [
        {
          targetPath: "world/locations/index.json",
          action: "merge",
          targetId: "cloud-city",
          fields: { description: "新描述" },
        },
      ],
    });
    const validation = await callTool("novel_world_validate_draft", {
      draftId: "location-world-draft",
    });
    expect(validation.valid).toBe(true);
    const submitted = await callTool("novel_world_submit_draft", {
      draftId: "location-world-draft",
      validationToken: validation.validationToken,
    });
    expect(submitted.submitted).toBe(true);

    const beforeSnapshot = JSON.parse(
      await fs.readFile(
        join(
          workspace,
          "world",
          "setting-library",
          "proposals",
          "world-location-world-draft",
          "before",
          "__locations",
          "index.json",
        ),
        "utf8",
      ),
    ) as { locations?: Array<Record<string, unknown>> };
    expect(beforeSnapshot.locations?.[0]).toMatchObject({
      id: "cloud-city",
      description: "旧描述",
    });
    const physicalIndex = JSON.parse(
      await fs.readFile(join(locationsDirectory, "index.json"), "utf8"),
    ) as { storageVersion?: number };
    expect(physicalIndex.storageVersion).toBe(1);
  });

  it("按稳定 ID 读取已保存灵感且不回退到整库正文", async () => {
    const inspirationFiles = createInspirationFiles({
      schemaVersion: 1,
      updatedAt: "2026-08-08T00:00:00.000Z",
      items: [
        {
          id: "idea-rain",
          title: "雨夜相逢",
          body: "只有指定 ID 才能读取这段正文。",
          state: "inbox",
          source: { kind: "manual", label: "手记", uri: "" },
          tags: ["相逢"],
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
        },
      ],
    });
    for (const file of inspirationFiles) {
      await fs.mkdir(join(workspace, dirname(file.path)), { recursive: true });
      await fs.writeFile(join(workspace, file.path), file.content, "utf8");
    }

    const found = await callTool("novel_inspiration_get_context", {
      focusId: "idea-rain",
    });
    expect(found.source).toBe("saved-facts");
    expect(found.sourcePath).toBe("inspiration/records/idea-rain.json");
    expect(found.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(found.data).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          id: "idea-rain",
          body: "只有指定 ID 才能读取这段正文。",
        }),
      }),
    );

    const missing = await callTool("novel_inspiration_get_context", {
      focusId: "idea-missing",
    });
    expect(missing.sourcePath).toBe("inspiration/index.json");
    expect(missing.data).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ id: "idea-rain", title: "雨夜相逢" }),
        ],
      }),
    );
    expect(JSON.stringify(missing.data)).not.toContain(
      "只有指定 ID 才能读取这段正文。",
    );
  });

  it("拒绝把修行体系路径误传给世界架构读取工具并给出正确工具", async () => {
    const result = await callTool("novel_world_get_context", {
      paths: ["world/cultivation/index.json"],
    });
    expect(result.error).toContain("novel_cultivation_get_context");
    expect(result.error).toContain("world/cultivation/index.json");
  });

  it("一次读取超过 30 个世界架构设定文件", async () => {
    const pagesDirectory = join(
      workspace,
      "world",
      "setting-library",
      "pages",
      "world-root",
    );
    const paths = Array.from(
      { length: 31 },
      (_, index) =>
        `world/setting-library/pages/world-root/context-${index + 1}.md`,
    );
    await fs.mkdir(pagesDirectory, { recursive: true });
    await Promise.all(
      paths.map((path, index) =>
        fs.writeFile(
          join(workspace, path),
          `# 设定 ${index + 1}\n第 ${index + 1} 个世界架构事实。\n`,
          "utf8",
        ),
      ),
    );

    const context = await callTool("novel_world_get_context", { paths });
    const files = context.files as Record<string, string | null>;
    expect(context.error).toBeUndefined();
    expect(context.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(files)).toHaveLength(36);
    for (const path of paths) expect(files[path]).toContain("世界架构事实");
  });

  it("地图工具读取世界架构正文并生成 Fantasy Map 草稿", async () => {
    configureNovelWorkbenchRequest(
      {
        mode: "maps",
        promptId: "novel.maps.fantasy",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-map-1", workspace },
    );
    const settingId = "world-overview";
    const pagePath = join(
      workspace,
      "world",
      "setting-library",
      "pages",
      "world-root",
      `${settingId}.md`,
    );
    const entriesPath = join(
      workspace,
      "world",
      "setting-library",
      "entries",
      "world-root",
      `${settingId}.json`,
    );
    await fs.mkdir(dirname(pagePath), { recursive: true });
    await fs.mkdir(dirname(entriesPath), { recursive: true });
    await Promise.all([
      fs.writeFile(
        pagePath,
        "# 九州\n山脉贯穿北境，云城位于河口；东部有冰原、湿地与火山，南境延伸至沙漠。\n",
        "utf8",
      ),
      fs.writeFile(
        entriesPath,
        `${JSON.stringify({ schemaVersion: 1, entries: [] })}\n`,
        "utf8",
      ),
      fs.writeFile(
        join(workspace, "world", "setting-library", "settings.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          settings: [
            {
              id: settingId,
              nodeId: "world-root",
              templateId: null,
              name: "宇宙总览",
              group: "世界",
              status: "completed",
              pagePath:
                "world/setting-library/pages/world-root/world-overview.md",
              entriesPath:
                "world/setting-library/entries/world-root/world-overview.json",
            },
          ],
        })}\n`,
        "utf8",
      ),
    ]);

    const worldContext = await callTool("novel_world_get_context", {});
    const generated = await callTool("novel_maps_generate_fantasy_map", {
      draftId: "fantasy-map-draft",
      seed: "world-seed",
      worldNodeId: "world-root",
      generationLevelTypeId: "continent",
      worldSourceHash: String(worldContext.sourceHash),
      landmassCount: 1,
      regionCount: 4,
      riverCount: 3,
      azgaarTemplate: "eurasia",
      azgaarStates: 4,
      azgaarCultures: 3,
      azgaarReligions: 2,
      azgaarPrecipitation: 180,
    });
    expect(generated.generator).toBe("fantasy-map-tool");
    expect(generated.contextFiles).toBe(7);
    expect(generated.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(generated.scope).toEqual(
      expect.objectContaining({
        worldNodeId: "world-root",
        generationLevelTypeId: "continent",
        generationLevelName: "大陆",
      }),
    );
    expect(generated.generationPlan).toEqual(
      expect.objectContaining({
        heightmapTemplate: "eurasia",
        landmassCount: 1,
        regionCount: 4,
        riverCount: 3,
        states: 4,
        cultures: 3,
        religions: 2,
        precipitation: 180,
      }),
    );
    const draft = await loadNovelWorkbenchDraft<WorldDraftPayload>(
      workspace,
      "maps",
      "fantasy-map-draft",
    );
    const operation = draft.payload as unknown as {
      operations: Array<Record<string, unknown>>;
    };
    expect(operation.operations).toHaveLength(1);
    expect(JSON.stringify(operation.operations[0])).toContain("宇宙总览");
    const generatedFeatures =
      (
        operation.operations[0]?.value as {
          features?: Array<Record<string, unknown>>;
        }
      ).features ?? [];
    const generatedMap = operation.operations[0]?.value as {
      canvas?: Record<string, unknown>;
      layers?: Array<Record<string, unknown>>;
    };
    if (generated.runtime === "compatibility-adapter") {
      expect(
        generatedFeatures.some(
          (feature) =>
            (feature.props as Record<string, unknown> | undefined)?.terrain ===
            "lake",
        ),
      ).toBe(true);
    } else {
      expect(
        generatedFeatures.some(
          (feature) =>
            (feature.props as Record<string, unknown> | undefined)
              ?.azgaarLayer === "state",
        ),
      ).toBe(true);
      expect(
        generatedFeatures.some(
          (feature) =>
            (feature.props as Record<string, unknown> | undefined)
              ?.azgaarLayer === "province",
        ),
      ).toBe(true);
      // Full JSON 的全部城市与网格细节仍在 SVG 底图中，MapDocument 只接收
      // 经过类型限额和世界架构命名优先级筛选的可编辑对象。
      expect(generatedFeatures.length).toBeLessThan(500);
      expect(
        generatedFeatures.every(
          (feature) => feature.layerId === "layer-azgaar-boundaries",
        ),
      ).toBe(true);
      expect(generatedMap.layers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "layer-main", name: "作者要素" }),
          expect.objectContaining({
            id: "layer-azgaar-boundaries",
            name: "Azgaar 可编辑边界",
          }),
        ]),
      );
      expect(generatedMap.canvas).toEqual(
        expect.objectContaining({
          backgroundImageWidth: expect.any(Number),
          backgroundImageHeight: expect.any(Number),
        }),
      );
    }
    const generatedMaterials = new Set(
      generatedFeatures
        .map(
          (feature) =>
            (feature.props as Record<string, unknown> | undefined)
              ?.terrainMaterial,
        )
        .filter((material): material is string => typeof material === "string"),
    );
    if (generated.runtime === "compatibility-adapter") {
      expect(generatedMaterials.has("snow")).toBe(true);
      expect(generatedMaterials.has("desert")).toBe(true);
      expect(generatedMaterials.has("swamp")).toBe(true);
      expect(generatedMaterials.has("volcanic")).toBe(true);
    }
    expect(draft.payload).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("生成范围："),
      }),
    );

    await updateNovelWorkbenchDraft<Record<string, unknown>>(
      workspace,
      "maps",
      "fantasy-map-draft",
      (payload) => {
        const operations = payload.operations as Array<Record<string, unknown>>;
        const operation = operations[0] as Record<string, unknown>;
        const value = operation.value as Record<string, unknown>;
        const canvas = value.canvas as Record<string, unknown>;
        return {
          ...payload,
          operations: [
            {
              ...operation,
              value: {
                ...value,
                canvas: {
                  ...canvas,
                  backgroundImage: `data:image/svg+xml;base64,${Buffer.from(
                    `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(80 * 1024)}--></svg>`,
                    "utf8",
                  ).toString("base64")}`,
                },
              },
            },
          ],
        };
      },
    );
    const validation = await callTool("novel_maps_validate_draft", {
      draftId: "fantasy-map-draft",
    });
    expect(validation.valid).toBe(true);
    const submitted = await callTool("novel_maps_submit_draft", {
      draftId: "fantasy-map-draft",
      validationToken: validation.validationToken,
    });
    expect(submitted.submitted).toBe(true);
    const proposalRoot = join(
      workspace,
      "world",
      "maps",
      "proposals",
      "maps-fantasy-map-draft",
    );
    const manifest = JSON.parse(
      await fs.readFile(join(proposalRoot, "proposal.json"), "utf8"),
    );
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.operations[0]).not.toHaveProperty("value");
    expect(manifest.operations[0].valuePath).toMatch(
      /^candidates\/fantasy-[a-f0-9]{12}\.json$/u,
    );
    const candidateId = manifest.operations[0].candidateId as string;
    const candidate = JSON.parse(
      await fs.readFile(
        join(proposalRoot, manifest.operations[0].valuePath),
        "utf8",
      ),
    );
    expect(candidate.canvas.backgroundImage).toBeNull();
    expect(candidate.canvas.backgroundAssetPath).toBe(
      `world/maps/proposals/maps-fantasy-map-draft/assets/${candidateId}.svg`,
    );
    await expect(
      fs.stat(join(proposalRoot, "assets", `${candidateId}.svg`)),
    ).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it("Azgaar Runtime 失败时仍生成带诊断信息的兼容候选草稿", async () => {
    configureNovelWorkbenchRequest(
      {
        mode: "maps",
        promptId: "novel.maps.fantasy",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-map-runtime-fallback", workspace },
    );
    const previousRuntimeUrl = process.env.MYAGENTS_AZGAAR_RUNTIME_URL;
    process.env.MYAGENTS_AZGAAR_RUNTIME_URL = "http://127.0.0.1:1";
    let generated: Record<string, unknown>;
    try {
      const worldContext = await callTool("novel_world_get_context", {});
      generated = await callTool("novel_maps_generate_fantasy_map", {
        draftId: "fallback-map-draft",
        seed: "fallback-seed",
        worldSourceHash: String(worldContext.sourceHash),
        landmassCount: 1,
        regionCount: 4,
        riverCount: 3,
        azgaarTemplate: "eurasia",
        azgaarStates: 4,
        azgaarCultures: 3,
        azgaarReligions: 2,
        azgaarPrecipitation: 180,
      });
    } finally {
      if (previousRuntimeUrl === undefined)
        delete process.env.MYAGENTS_AZGAAR_RUNTIME_URL;
      else process.env.MYAGENTS_AZGAAR_RUNTIME_URL = previousRuntimeUrl;
    }

    expect(generated.error).toBeUndefined();
    expect(generated.runtime).toBe("compatibility-adapter");
    expect(generated.generatorAdapter).toBe(
      "fantasy-map-compatibility-adapter",
    );
    expect(generated.runtimeError).toEqual(expect.any(String));
    const draft = await loadNovelWorkbenchDraft<WorldDraftPayload>(
      workspace,
      "maps",
      "fallback-map-draft",
    );
    const operations = (
      draft.payload as unknown as {
        operations: Array<Record<string, unknown>>;
      }
    ).operations;
    expect(operations[0]?.summary).toContain("Azgaar Runtime 调用失败");
  });

  it("地图生成拒绝未通过世界架构读取取得的 sourceHash", async () => {
    configureNovelWorkbenchRequest(
      {
        mode: "maps",
        promptId: "novel.maps.fantasy",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-map-stale-source", workspace },
    );

    const generated = await callTool("novel_maps_generate_fantasy_map", {
      draftId: "stale-map-draft",
      seed: "stale-seed",
      worldSourceHash: "a".repeat(64),
      landmassCount: 1,
      regionCount: 4,
      riverCount: 3,
      azgaarTemplate: "eurasia",
      azgaarStates: 4,
      azgaarCultures: 3,
      azgaarReligions: 2,
      azgaarPrecipitation: 180,
    });

    expect(generated.error).toContain("重新调用 novel_world_get_context");
  });
});
