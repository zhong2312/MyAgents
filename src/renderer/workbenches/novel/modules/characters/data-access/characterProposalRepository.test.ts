import { describe, expect, it } from "vitest";

import { characterSoulRecordPath } from "../../../../../../shared/workbenches/novel/characterSoulStorage";
import { createEmptyNovelStorage } from "../../../shared/infrastructure/testStorage";
import {
  characterProposalManifestPath,
  serializeCharacterProposalManifest,
  type CharacterProposalManifest,
} from "../entities/characterProposalSchema";
import { createNovelCharacterLibraryRepository } from "./characterLibraryRepository";
import { createNovelCharacterProposalRepository } from "./characterProposalRepository";

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
    await storage.createText(
      characterProposalManifestPath(manifest.proposalId),
      serializeCharacterProposalManifest(manifest),
      { createParents: true },
    );

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
