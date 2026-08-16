import { describe, expect, it } from "vitest";

import {
  createFactionFileProposalRepository,
  createNovelFactionProposalRepository,
} from "./factionProposalRepository";
import {
  serializeFactionProposalManifest,
  type FactionProposalManifest,
} from "../entities/factionProposalSchema";
import type { FactionRecord } from "../entities/factionLibrarySchema";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import {
  createFactionFiles,
  factionRecordPath,
} from "../../../../../../shared/workbenches/novel/factionStorage";

function faction(id: string, name: string, summary: string): FactionRecord {
  return {
    id,
    name,
    type: "宗门",
    status: "active",
    summary,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function manifest(
  proposalId: string,
  operations: FactionProposalManifest["operations"],
): FactionProposalManifest {
  return {
    schemaVersion: 1,
    proposalId,
    title: "AI 势力提案",
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: {
      kind: "agent",
      promptId: "novel.factions.assist",
      promptVersion: "1.0.0",
    },
    operations,
  };
}

function storageWithProposal(): NovelMemoryStorage {
  return new NovelMemoryStorage({
    "world/factions/index.json": JSON.stringify({
      schemaVersion: 2,
      storageVersion: 1,
      factions: [],
    }),
    "world/factions/proposals/proposal-1/proposal.json":
      serializeFactionProposalManifest(
        manifest("proposal-1", [
          {
            candidateId: "candidate-1",
            kind: "faction",
            action: "create",
            summary: "新建青云宗",
            value: {
              id: "faction-1",
              name: "青云宗",
              type: "宗门",
              status: "active",
              summary: "正道魁首",
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
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            status: "pending",
          },
          {
            candidateId: "candidate-2",
            kind: "faction",
            action: "create",
            summary: "新建魔宗",
            value: {
              id: "faction-2",
              name: "魔宗",
              type: "魔道",
              status: "active",
              summary: "魔道巨擘",
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
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            status: "pending",
          },
        ]),
      ),
  });
}

describe("createNovelFactionProposalRepository", () => {
  it("采纳选中的势力候选并写入正式库", async () => {
    const storage = storageWithProposal();
    const repository = createNovelFactionProposalRepository(storage);

    await repository.apply("proposal-1", ["candidate-1"]);

    const factions = JSON.parse(storage.getText("world/factions/index.json")!)
      .factions as { readonly id: string }[];
    expect(factions.map((faction) => faction.id)).toEqual(["faction-1"]);
    const applied = JSON.parse(
      storage.getText("world/factions/proposals/proposal-1/proposal.json")!,
    );
    expect(
      applied.operations.find(
        (operation: { candidateId: string }) =>
          operation.candidateId === "candidate-1",
      ).status,
    ).toBe("applied");
    expect(
      applied.operations.find(
        (operation: { candidateId: string }) =>
          operation.candidateId === "candidate-2",
      ).status,
    ).toBe("pending");
  });

  it("采纳时执行跨库引用校验，悬空引用被拒绝", async () => {
    const storage = new NovelMemoryStorage({
      "world/factions/index.json": JSON.stringify({
        schemaVersion: 2,
        storageVersion: 1,
        factions: [],
      }),
      "world/factions/proposals/proposal-1/proposal.json":
        serializeFactionProposalManifest(
          manifest("proposal-1", [
            {
              candidateId: "candidate-1",
              kind: "faction",
              action: "create",
              summary: "新建势力",
              value: {
                id: "faction-1",
                name: "青云宗",
                type: "宗门",
                status: "active",
                summary: "",
                state: {
                  governance: "",
                  military: "",
                  economy: "",
                  publicSupport: "",
                  territorialIntegrity: "",
                },
                territories: [],
                members: [
                  {
                    id: "member-1",
                    name: "首席弟子",
                    characterId: "char-missing",
                    role: "弟子",
                    count: 1,
                    description: "",
                  },
                ],
                assets: [],
                resources: [],
                organizationUnits: [],
                relations: [],
                rights: [],
                links: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              status: "pending",
            },
          ]),
        ),
    });
    const repository = createNovelFactionProposalRepository(storage);

    await expect(
      repository.apply("proposal-1", ["candidate-1"]),
    ).rejects.toThrow(/成员“首席弟子”关联了不存在的角色/);
    // 正式库未被写入
    expect(
      JSON.parse(storage.getText("world/factions/index.json")!).factions,
    ).toHaveLength(0);
  });

  it("拒绝候选只更新提案状态", async () => {
    const storage = storageWithProposal();
    const repository = createNovelFactionProposalRepository(storage);

    await repository.reject("proposal-1", ["candidate-2"]);

    expect(
      JSON.parse(storage.getText("world/factions/index.json")!).factions,
    ).toHaveLength(0);
    const applied = JSON.parse(
      storage.getText("world/factions/proposals/proposal-1/proposal.json")!,
    );
    expect(
      applied.operations.find(
        (operation: { candidateId: string }) =>
          operation.candidateId === "candidate-2",
      ).status,
    ).toBe("rejected");
  });

  it("删除提案目录", async () => {
    const storage = storageWithProposal();
    const repository = createNovelFactionProposalRepository(storage);

    await repository.deleteProposals(["proposal-1"]);

    expect(
      storage.getText("world/factions/proposals/proposal-1/proposal.json"),
    ).toBeUndefined();
  });

  it("兼容旧 AI 提案的说明字段，但不会把说明字段写入正式势力记录", async () => {
    const storage = storageWithProposal();
    const proposalPath = "world/factions/proposals/proposal-1/proposal.json";
    const document = JSON.parse(storage.getText(proposalPath)!) as {
      operations: Array<{ value: Record<string, unknown> }>;
    };
    Object.assign(document.operations[0]!.value, {
      aliases: ["云宗"],
      location: "东境",
      coreGoals: ["守护东境"],
      hierarchy: "掌门 -> 长老",
      keyMembers: ["掌门"],
      authority: "东境护法权",
      evolutionHook: "宗门内部分裂",
    });
    storage.setExternalText(
      proposalPath,
      `${JSON.stringify(document, null, 2)}\n`,
    );

    const fileRepository = createFactionFileProposalRepository(storage);
    const listed = await fileRepository.list();
    const change = listed.proposals[0]?.changes[0];
    expect(change?.loadError).toBeNull();
    expect(change?.afterContent).not.toContain('"aliases"');

    await fileRepository.apply("proposal-1", ["candidate-1"], "测试小说");

    const saved = JSON.parse(
      storage.getText(factionRecordPath("faction-1"))!,
    ) as Record<string, unknown>;
    expect(saved.name).toBe("青云宗");
    expect(saved).not.toHaveProperty("aliases");
    expect(saved).not.toHaveProperty("coreGoals");
  });

  it("单个候选格式错误时仍保留整份提案和其它候选供审阅", async () => {
    const storage = storageWithProposal();
    const proposalPath = "world/factions/proposals/proposal-1/proposal.json";
    const document = JSON.parse(storage.getText(proposalPath)!) as {
      operations: Array<{ value: Record<string, unknown> }>;
    };
    document.operations[0]!.value.id = "INVALID ID";
    storage.setExternalText(
      proposalPath,
      `${JSON.stringify(document, null, 2)}\n`,
    );

    const listed = await createFactionFileProposalRepository(storage).list();

    expect(listed.errors).toEqual([]);
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0]?.changes[0]).toMatchObject({
      targetPath: "world/factions/records/candidate-1.json",
      loadError: expect.stringContaining("格式无效"),
    });
    expect(listed.proposals[0]?.changes[1]?.loadError).toBeNull();
  });

  it("按对象基准识别更新冲突，并通过统一契约显式使用提案版本", async () => {
    const baseline = faction("faction-1", "青云宗", "原始概要");
    const files = createFactionFiles({
      schemaVersion: 2,
      factions: [baseline],
    });
    const proposalDocument = manifest("proposal-update", [
      {
        candidateId: "candidate-update",
        kind: "faction",
        action: "update",
        targetId: "faction-1",
        summary: "更新青云宗概要",
        baseValue: baseline,
        value: faction("faction-1", "青云宗", "提案概要"),
        status: "pending",
      },
    ]);
    const storage = new NovelMemoryStorage({
      ...Object.fromEntries(files.map((file) => [file.path, file.content])),
      "world/factions/proposals/proposal-update/proposal.json":
        serializeFactionProposalManifest(proposalDocument),
    });
    const changed = faction("faction-1", "青云宗", "作者刚刚修改的概要");
    storage.setExternalText(
      factionRecordPath("faction-1"),
      `${JSON.stringify(changed, null, 2)}\n`,
    );

    const repository = createFactionFileProposalRepository(storage);
    const listed = await repository.list();
    const change = listed.proposals[0]?.changes[0];
    expect(change).toMatchObject({
      conflict: true,
      baseContentAvailable: true,
      currentContent: `${JSON.stringify(changed, null, 2)}\n`,
    });

    await repository.resolveConflict(
      "proposal-update",
      "candidate-update",
      {
        strategy: "use-proposal",
        expectedCurrentContent: change?.currentContent ?? null,
      },
      "测试小说",
    );

    expect(
      JSON.parse(storage.getText(factionRecordPath("faction-1"))!).summary,
    ).toBe("提案概要");
  });

  it("新建目标已存在时只允许通过显式冲突决议覆盖", async () => {
    const storage = storageWithProposal();
    const formal = faction("faction-1", "青云宗", "正式库已有版本");
    for (const file of createFactionFiles({
      schemaVersion: 2,
      factions: [formal],
    })) {
      storage.setExternalText(file.path, file.content);
    }
    const repository = createFactionFileProposalRepository(storage);
    const listed = await repository.list();
    const change = listed.proposals[0]?.changes[0];
    expect(change?.conflict).toBe(true);

    await repository.resolveConflict(
      "proposal-1",
      "candidate-1",
      {
        strategy: "use-proposal",
        expectedCurrentContent: change?.currentContent ?? null,
      },
      "测试小说",
    );

    expect(
      JSON.parse(storage.getText(factionRecordPath("faction-1"))!).summary,
    ).toBe("正道魁首");
  });
});
