import { describe, expect, it } from "vitest";

import { characterSoulRecordPath } from "../../../../../../shared/workbenches/novel/characterSoulStorage";
import { createEmptyNovelStorage } from "../../../shared/infrastructure/testStorage";
import {
  characterProposalManifestPath,
  serializeCharacterProposalManifest,
  type CharacterProposalOperation,
  type CharacterProposalManifest,
} from "../entities/characterProposalSchema";
import type { CharacterRecord } from "../entities/characterLibrarySchema";
import { createNovelCharacterLibraryRepository } from "./characterLibraryRepository";
import { createNovelCharacterProposalRepository } from "./characterProposalRepository";

function character(
  id: string,
  name: string,
  targetId: string,
): CharacterRecord {
  return {
    id,
    name,
    alias: "",
    roleWeight: "secondary",
    archetype: "",
    alignment: "",
    status: "草稿",
    summary: `${name} 的摘要`,
    identities: [],
    age: "20",
    currentRealm: "",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    cultivationProfile: {
      systemId: null,
      trackId: null,
      levelId: null,
      methodIds: [],
      abilityIds: [],
      resourceBalances: {},
      activeConstraintIds: [],
      breakthroughHistory: [],
    },
    gender: "",
    raceId: "",
    soulId: "",
    groupIds: [],
    hometown: "",
    appearance: "",
    personality: "",
    values: "",
    strengths: "",
    weaknesses: "",
    fears: "",
    motivation: "",
    goals: "",
    innerConflict: "",
    background: "",
    abilities: "",
    speechStyle: "",
    habits: "",
    signatureItem: "",
    storyRole: "",
    arc: "",
    firstAppearance: "",
    completeness: 0,
    relations: [
      {
        targetId,
        type: "伙伴",
        tone: "positive",
        summary: `${name} 与对方互为伙伴`,
      },
    ],
    appearances: [],
    arcStages: [],
    inventory: [],
  };
}

function characterOperation(
  candidateId: string,
  value: CharacterRecord,
): CharacterProposalOperation {
  return {
    candidateId,
    kind: "character",
    action: "create",
    summary: `新增${value.name}`,
    value,
    status: "pending",
  };
}

async function writeProposal(
  storage: ReturnType<typeof createEmptyNovelStorage>,
  manifest: CharacterProposalManifest,
): Promise<void> {
  await storage.createText(
    characterProposalManifestPath(manifest.proposalId),
    serializeCharacterProposalManifest(manifest),
    { createParents: true },
  );
}

describe("NovelCharacterProposalRepository 角色灵魂采纳", () => {
  it("将灵魂候选写入独立记录而不重新内嵌到 library.json", async () => {
    const storage = createEmptyNovelStorage();
    const libraryRepository = createNovelCharacterLibraryRepository(storage);
    const library = await libraryRepository.load();
    const customSoul = {
      ...library.meta.souls[0]!,
      id: "proposal-soul",
      name: "提案灵魂",
      builtIn: false,
    };
    const manifest: CharacterProposalManifest = {
      schemaVersion: 1,
      proposalId: "proposal-a",
      title: "新增灵魂",
      description: "",
      createdAt: "2026-08-09T00:00:00.000Z",
      source: {
        kind: "agent",
        promptId: "novel.characters.assist",
        promptVersion: "1.0.0",
      },
      operations: [
        {
          candidateId: "candidate-soul",
          kind: "soul",
          action: "create",
          summary: "新增提案灵魂",
          value: customSoul,
          status: "pending",
        },
      ],
    };
    await writeProposal(storage, manifest);

    await createNovelCharacterProposalRepository(storage).apply(
      manifest.proposalId,
      ["candidate-soul"],
    );

    const meta = JSON.parse(
      storage.getText("characters/library.json") ?? "{}",
    ) as Record<string, unknown>;
    expect(meta).not.toHaveProperty("souls");
    expect(storage.getText(characterSoulRecordPath(customSoul.id))).toContain(
      '"name": "提案灵魂"',
    );
    await expect(libraryRepository.load()).resolves.toMatchObject({
      meta: {
        souls: expect.arrayContaining([
          expect.objectContaining({ id: customSoul.id }),
        ]),
      },
    });
  });
});

describe("NovelCharacterProposalRepository 角色关系采纳", () => {
  const proposal = (): CharacterProposalManifest => ({
    schemaVersion: 1,
    proposalId: "proposal-relations",
    title: "新增互相关联角色",
    description: "",
    createdAt: "2026-08-10T00:00:00.000Z",
    source: {
      kind: "agent",
      promptId: "novel.characters.assist",
      promptVersion: "1.0.0",
    },
    operations: [
      characterOperation(
        "candidate-a",
        character("character-a", "甲", "character-b"),
      ),
      characterOperation(
        "candidate-b",
        character("character-b", "乙", "character-a"),
      ),
    ],
  });

  it("同一批新增角色可以互相建立关系", async () => {
    const storage = createEmptyNovelStorage();
    const manifest = proposal();
    await writeProposal(storage, manifest);

    const applied = await createNovelCharacterProposalRepository(storage).apply(
      manifest.proposalId,
      ["candidate-a", "candidate-b"],
    );

    expect(
      applied.manifest.operations.map((operation) => operation.status),
    ).toEqual(["applied", "applied"]);
    const repository = createNovelCharacterLibraryRepository(storage);
    const library = await repository.load();
    expect(library.index.characters.map((entry) => entry.id).sort()).toEqual([
      "character-a",
      "character-b",
    ]);
    await expect(
      repository.loadCharacter(
        library.index.characters.find((entry) => entry.id === "character-a")!,
      ),
    ).resolves.toMatchObject({
      record: { relations: [{ targetId: "character-b" }] },
    });
  });

  it("只采纳关系来源而漏掉同批目标时明确阻止", async () => {
    const storage = createEmptyNovelStorage();
    const manifest = proposal();
    await writeProposal(storage, manifest);

    await expect(
      createNovelCharacterProposalRepository(storage).apply(
        manifest.proposalId,
        ["candidate-a"],
      ),
    ).rejects.toThrow("角色“甲”的关系指向了不存在的角色：character-b");
    const library = await createNovelCharacterLibraryRepository(storage).load();
    expect(library.index.characters).toEqual([]);
    const proposalContent = storage.getText(
      characterProposalManifestPath(manifest.proposalId),
    );
    expect(proposalContent).toContain('"status": "pending"');
  });
});
