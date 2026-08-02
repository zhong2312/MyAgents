import { describe, expect, it } from "vitest";

import {
  createNovelFactionProposalRepository,
} from "./factionProposalRepository";
import {
  serializeFactionProposalManifest,
  type FactionProposalManifest,
} from "./factionProposalSchema";
import { NovelMemoryStorage } from "./testStorage";

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

    const factions = JSON.parse(
      storage.getText("world/factions/index.json")!,
    ).factions as { readonly id: string }[];
    expect(factions.map((faction) => faction.id)).toEqual(["faction-1"]);
    const applied = JSON.parse(
      storage.getText(
        "world/factions/proposals/proposal-1/proposal.json",
      )!,
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

    await expect(repository.apply("proposal-1", ["candidate-1"])).rejects.toThrow(
      /成员“首席弟子”关联了不存在的角色/,
    );
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
      storage.getText(
        "world/factions/proposals/proposal-1/proposal.json",
      )!,
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
});
