import { describe, expect, it } from "vitest";

import {
  createNovelSettingLibraryRepository,
  SETTING_LIBRARY_PATHS,
} from "./settingLibraryRepository";
import { createEmptyNovelStorage } from "./testStorage";
import { createNovelWorldProposalRepository } from "./worldProposalRepository";
import { createNovelLocationLibraryRepository } from "./modules/locations/data-access/locationLibraryRepository";
import { serializeLocationLibraryIndex } from "./modules/locations/entities/locationLibrarySchema";
import { locationRecordPath } from "../../../shared/workbenches/novel/locationStorage";
import {
  serializeWorldProposalManifest,
  worldProposalManifestPath,
  worldProposalSnapshotPath,
  type WorldProposalManifest,
} from "./worldProposalSchema";

async function seedTreeProposal() {
  const storage = createEmptyNovelStorage();
  const library =
    await createNovelSettingLibraryRepository(storage).load("测试小说");
  const proposalId = "first-world-draft";
  const targetPath = "world/setting-library/spatial-tree.json";
  const nextTree = {
    ...library.spatialTree,
    nodes: [
      ...library.spatialTree.nodes,
      {
        id: "first-continent",
        parentId: "world-root",
        name: "第一大陆",
        typeId: "continent",
        order: 1,
      },
    ],
  };
  const afterContent = `${JSON.stringify(nextTree, null, 2)}\n`;
  const manifest: WorldProposalManifest = {
    schemaVersion: 1,
    proposalId,
    title: "第一版世界架构",
    description: "新增第一大陆",
    createdAt: "2026-07-16T08:00:00.000Z",
    source: {
      kind: "agent",
      promptId: "novel.world.guide",
      promptVersion: "1.2.0",
    },
    changes: [
      {
        id: "update-tree",
        targetPath,
        operation: "modify",
        summary: "新增第一大陆",
        status: "pending",
      },
    ],
  };
  await storage.createText(
    worldProposalSnapshotPath(proposalId, "before", targetPath),
    library.spatialTreeContent,
    { createParents: true },
  );
  await storage.createText(
    worldProposalSnapshotPath(proposalId, "after", targetPath),
    afterContent,
    { createParents: true },
  );
  await storage.createText(
    worldProposalManifestPath(proposalId),
    serializeWorldProposalManifest(manifest),
    { createParents: true },
  );
  return { storage, proposalId, targetPath, afterContent };
}

async function seedLocationProposal({
  compactSnapshots = false,
}: { compactSnapshots?: boolean } = {}) {
  const storage = createEmptyNovelStorage();
  await createNovelSettingLibraryRepository(storage).load("测试小说");
  const locationRepository = createNovelLocationLibraryRepository(storage);
  let current = await locationRepository.load();
  current = await locationRepository.save(current, {
    ...current.index,
    locations: [
      {
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
      },
    ],
  });
  const proposalId = "update-cloud-city";
  const targetPath = "world/locations/index.json";
  const beforeContent = serializeLocationLibraryIndex(current.index);
  const afterContent = serializeLocationLibraryIndex({
    ...current.index,
    locations: current.index.locations.map((location) => ({
      ...location,
      description: "新描述",
    })),
  });
  const snapshotContent = (content: string): string =>
    compactSnapshots ? JSON.stringify(JSON.parse(content)) : content;
  const manifest: WorldProposalManifest = {
    schemaVersion: 1,
    proposalId,
    title: "更新云城",
    description: "补充地点描述",
    createdAt: "2026-08-09T08:00:00.000Z",
    source: {
      kind: "agent",
      promptId: "novel.world.guide",
      promptVersion: "1.2.0",
    },
    changes: [
      {
        id: "update-location",
        targetPath,
        operation: "modify",
        summary: "补充云城描述",
        status: "pending",
      },
    ],
  };
  await Promise.all([
    storage.createText(
      worldProposalSnapshotPath(proposalId, "before", targetPath),
      snapshotContent(beforeContent),
      { createParents: true },
    ),
    storage.createText(
      worldProposalSnapshotPath(proposalId, "after", targetPath),
      snapshotContent(afterContent),
      { createParents: true },
    ),
    storage.createText(
      worldProposalManifestPath(proposalId),
      serializeWorldProposalManifest(manifest),
      { createParents: true },
    ),
  ]);
  return { storage, proposalId, targetPath, beforeContent, afterContent };
}

function createExternalTreeContent(
  storage: ReturnType<typeof createEmptyNovelStorage>,
  targetPath: string,
  nodeId: string,
): string {
  const content = storage.getText(targetPath);
  if (!content) throw new Error("测试缺少空间树事实源");
  const tree = JSON.parse(content) as {
    nodes: Array<{
      id: string;
      parentId: string | null;
      name: string;
      typeId: string;
      order: number;
    }>;
  };
  return `${JSON.stringify(
    {
      ...tree,
      nodes: [
        ...tree.nodes,
        {
          id: nodeId,
          parentId: "world-root",
          name: `人工节点 ${nodeId}`,
          typeId: "continent",
          order: tree.nodes.length,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

describe("createNovelWorldProposalRepository", () => {
  it("通过地点 Repository 应用逻辑快照并保留轻量根索引", async () => {
    const { storage, proposalId, targetPath, afterContent } =
      await seedLocationProposal();

    const applied = await createNovelWorldProposalRepository(storage).apply(
      proposalId,
      ["update-location"],
      "测试小说",
    );
    const physicalIndex = JSON.parse(storage.getText(targetPath) ?? "{}") as {
      storageVersion?: number;
      locations?: Array<{ id: string; path: string }>;
    };
    const record = JSON.parse(
      storage.getText(locationRecordPath("cloud-city")) ?? "{}",
    ) as { description?: string };

    expect(physicalIndex.storageVersion).toBe(1);
    expect(physicalIndex.locations).toEqual([
      {
        id: "cloud-city",
        path: "world/locations/records/cloud-city.json",
      },
    ]);
    expect(record.description).toBe("新描述");
    expect(applied.changes[0]?.currentContent).toBe(afterContent);
  });

  it("规范化压缩地点快照后完成写后复验", async () => {
    const { storage, proposalId, afterContent } = await seedLocationProposal({
      compactSnapshots: true,
    });

    const applied = await createNovelWorldProposalRepository(storage).apply(
      proposalId,
      ["update-location"],
      "测试小说",
    );

    expect(applied.changes[0]?.currentContent).toBe(afterContent);
    expect(applied.manifest.changes[0]?.status).toBe("applied");
  });

  it("地点提案审计写入失败时回滚整个地点目录", async () => {
    const { storage, proposalId, beforeContent } = await seedLocationProposal({
      compactSnapshots: true,
    });
    storage.failWritePathOnce = worldProposalManifestPath(proposalId);

    await expect(
      createNovelWorldProposalRepository(storage).apply(
        proposalId,
        ["update-location"],
        "测试小说",
      ),
    ).rejects.toThrow("Injected write failure");
    const current = await createNovelLocationLibraryRepository(storage).load();
    expect(serializeLocationLibraryIndex(current.index)).toBe(beforeContent);
  });

  it("loads before/after snapshots and applies a selected validated change", async () => {
    const { storage, proposalId, targetPath, afterContent } =
      await seedTreeProposal();
    const repository = createNovelWorldProposalRepository(storage);
    const { proposals } = await repository.list();
    const [proposal] = proposals;

    expect(proposal?.changes[0]).toMatchObject({
      id: "update-tree",
      conflict: false,
      status: "pending",
    });
    const applied = await repository.apply(
      proposalId,
      ["update-tree"],
      "测试小说",
    );

    expect(storage.getText(targetPath)).toBe(afterContent);
    expect(applied.manifest.changes[0]?.status).toBe("applied");
  });

  it("detects an external edit and preserves it instead of applying stale output", async () => {
    const { storage, proposalId, targetPath } = await seedTreeProposal();
    storage.setExternalText(targetPath, "人工修改后的空间树\n");
    const repository = createNovelWorldProposalRepository(storage);
    const proposal = await repository.load(proposalId);

    expect(proposal.changes[0]?.conflict).toBe(true);
    await expect(
      repository.apply(proposalId, ["update-tree"], "测试小说"),
    ).rejects.toThrow("目标文件已变化");
    expect(storage.getText(targetPath)).toBe("人工修改后的空间树\n");
  });

  it("uses the proposal version after an explicit conflict resolution", async () => {
    const { storage, proposalId, targetPath, afterContent } =
      await seedTreeProposal();
    storage.setExternalText(
      targetPath,
      createExternalTreeContent(storage, targetPath, "manual-continent"),
    );
    const repository = createNovelWorldProposalRepository(storage);
    const proposal = await repository.load(proposalId);
    const change = proposal.changes[0];
    expect(change?.conflict).toBe(true);

    const applied = await repository.resolveConflict(
      proposalId,
      "update-tree",
      {
        strategy: "use-proposal",
        expectedCurrentContent: change?.currentContent ?? null,
      },
      "测试小说",
    );

    expect(storage.getText(targetPath)).toBe(afterContent);
    expect(applied.manifest.changes[0]?.status).toBe("applied");
  });

  it("blocks a conflict resolution when formal content changes again", async () => {
    const { storage, proposalId, targetPath } = await seedTreeProposal();
    storage.setExternalText(
      targetPath,
      createExternalTreeContent(storage, targetPath, "manual-continent-a"),
    );
    const repository = createNovelWorldProposalRepository(storage);
    const proposal = await repository.load(proposalId);
    const reviewedContent = proposal.changes[0]?.currentContent ?? null;
    const latestContent = createExternalTreeContent(
      storage,
      targetPath,
      "manual-continent-b",
    );
    storage.setExternalText(targetPath, latestContent);

    await expect(
      repository.resolveConflict(
        proposalId,
        "update-tree",
        {
          strategy: "use-proposal",
          expectedCurrentContent: reviewedContent,
        },
        "测试小说",
      ),
    ).rejects.toThrow("正式内容在冲突处理期间再次变化");
    expect(storage.getText(targetPath)).toBe(latestContent);
  });

  it("rejects a change without touching the target file", async () => {
    const { storage, proposalId, targetPath } = await seedTreeProposal();
    const before = storage.getText(targetPath);
    const proposal = await createNovelWorldProposalRepository(storage).reject(
      proposalId,
      ["update-tree"],
    );

    expect(storage.getText(targetPath)).toBe(before);
    expect(proposal.manifest.changes[0]?.status).toBe("rejected");
  });

  it("rolls back an applied file when the proposal audit update fails", async () => {
    const { storage, proposalId, targetPath } = await seedTreeProposal();
    const before = storage.getText(targetPath);
    storage.failWritePathOnce = worldProposalManifestPath(proposalId);

    await expect(
      createNovelWorldProposalRepository(storage).apply(
        proposalId,
        ["update-tree"],
        "测试小说",
      ),
    ).rejects.toThrow("Injected write failure");
    expect(storage.getText(targetPath)).toBe(before);
    expect(
      JSON.parse(storage.getText(worldProposalManifestPath(proposalId)) ?? "{}")
        .changes[0].status,
    ).toBe("pending");
  });

  it("requires selected materialized files to close the final settings index", async () => {
    const storage = createEmptyNovelStorage();
    const library =
      await createNovelSettingLibraryRepository(storage).load("测试小说");
    const proposalId = "materialize-custom-setting";
    const pagePath = "world/setting-library/pages/world-root/custom-history.md";
    const entriesPath =
      "world/setting-library/entries/world-root/custom-history.json";
    const settingsContent = `${JSON.stringify(
      {
        schemaVersion: 1,
        settings: [
          {
            id: "custom-history",
            nodeId: "world-root",
            templateId: null,
            name: "自定义历史",
            group: "历史",
            status: "draft",
            pagePath,
            entriesPath,
          },
        ],
      },
      null,
      2,
    )}\n`;
    const entriesContent = `${JSON.stringify(
      { schemaVersion: 1, entries: [] },
      null,
      2,
    )}\n`;
    const manifest: WorldProposalManifest = {
      schemaVersion: 1,
      proposalId,
      title: "新增自定义历史设定",
      description: "同时创建索引、正文和词条",
      createdAt: "2026-07-16T09:00:00.000Z",
      source: {
        kind: "agent",
        promptId: "novel.world.guide",
        promptVersion: "1.2.0",
      },
      changes: [
        {
          id: "update-settings",
          targetPath: SETTING_LIBRARY_PATHS.settings,
          operation: "modify",
          summary: "登记自定义历史",
          status: "pending",
        },
        {
          id: "create-page",
          targetPath: pagePath,
          operation: "create",
          summary: "创建正文",
          status: "pending",
        },
        {
          id: "create-entries",
          targetPath: entriesPath,
          operation: "create",
          summary: "创建词条",
          status: "pending",
        },
      ],
    };
    await Promise.all([
      storage.createText(
        worldProposalSnapshotPath(
          proposalId,
          "before",
          SETTING_LIBRARY_PATHS.settings,
        ),
        library.settingsIndexContent,
        { createParents: true },
      ),
      storage.createText(
        worldProposalSnapshotPath(
          proposalId,
          "after",
          SETTING_LIBRARY_PATHS.settings,
        ),
        settingsContent,
        { createParents: true },
      ),
      storage.createText(
        worldProposalSnapshotPath(proposalId, "after", pagePath),
        "# 自定义历史\n",
        { createParents: true },
      ),
      storage.createText(
        worldProposalSnapshotPath(proposalId, "after", entriesPath),
        entriesContent,
        { createParents: true },
      ),
      storage.createText(
        worldProposalManifestPath(proposalId),
        serializeWorldProposalManifest(manifest),
        { createParents: true },
      ),
    ]);
    const repository = createNovelWorldProposalRepository(storage);

    await expect(
      repository.apply(proposalId, ["update-settings"], "测试小说"),
    ).rejects.toThrow("引用了不存在的设定文件");

    const applied = await repository.apply(
      proposalId,
      ["update-settings", "create-page", "create-entries"],
      "测试小说",
    );
    expect(storage.getText(pagePath)).toBe("# 自定义历史\n");
    expect(storage.getText(entriesPath)).toBe(entriesContent);
    expect(
      applied.manifest.changes.every((change) => change.status === "applied"),
    ).toBe(true);
  });

  it("revalidates the persisted file set and rolls back across-file races", async () => {
    const { storage, proposalId, targetPath } = await seedTreeProposal();
    const beforeTree = storage.getText(targetPath);
    const metaContent = storage.getText(SETTING_LIBRARY_PATHS.meta);
    if (!metaContent) throw new Error("测试缺少设定库元配置");
    const meta = JSON.parse(metaContent) as {
      levelTypes: Array<{
        id: string;
        suggestedParentTypeIds: string[];
        suggestedChildTypeIds: string[];
      }>;
      profiles: Array<{ levelTypeId: string }>;
    };
    const externalMeta = `${JSON.stringify(
      {
        ...meta,
        levelTypes: meta.levelTypes
          .filter((type) => type.id !== "continent")
          .map((type) => ({
            ...type,
            suggestedParentTypeIds: type.suggestedParentTypeIds.filter(
              (parentTypeId) => parentTypeId !== "continent",
            ),
            suggestedChildTypeIds: type.suggestedChildTypeIds.filter(
              (childTypeId) => childTypeId !== "continent",
            ),
          })),
        profiles: meta.profiles.filter(
          (profile) => profile.levelTypeId !== "continent",
        ),
      },
      null,
      2,
    )}\n`;
    storage.afterWriteOnce = (path) => {
      if (path === targetPath) {
        storage.setExternalText(SETTING_LIBRARY_PATHS.meta, externalMeta);
      }
    };

    await expect(
      createNovelWorldProposalRepository(storage).apply(
        proposalId,
        ["update-tree"],
        "测试小说",
      ),
    ).rejects.toThrow("关联了不存在的层级类型");
    expect(storage.getText(targetPath)).toBe(beforeTree);
    expect(storage.getText(SETTING_LIBRARY_PATHS.meta)).toBe(externalMeta);
  });

  it("isolates a malformed proposal while returning valid proposals", async () => {
    const { storage } = await seedTreeProposal();
    await storage.createText(
      worldProposalManifestPath("broken-proposal"),
      "{ not valid json\n",
      { createParents: true },
    );

    const result = await createNovelWorldProposalRepository(storage).list();

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.manifest.proposalId).toBe("first-world-draft");
    expect(result.errors).toEqual([
      expect.objectContaining({ proposalId: "broken-proposal" }),
    ]);
  });
});
