import { describe, expect, it } from "vitest";

import { createEmptyNovelStorage } from "../../../shared/infrastructure/testStorage";
import {
  characterProposalManifestPath,
  serializeCharacterProposalManifest,
  type CharacterProposalManifest,
} from "../entities/characterProposalSchema";
import { createCharacterFileProposalRepository } from "./characterFileProposalRepository";

describe("character file proposal adapter", () => {
  it("uses object-level metadata baselines and supports per-change deletion", async () => {
    const storage = createEmptyNovelStorage();
    const manifest: CharacterProposalManifest = {
      schemaVersion: 1,
      proposalId: "race-conflict",
      title: "角色提案",
      description: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "agent", promptId: "test", promptVersion: "1.0.0" },
      operations: [
        {
          candidateId: "new-race",
          kind: "race",
          action: "create",
          summary: "新增种族",
          value: { id: "human", name: "人族", description: "" },
          status: "pending",
        },
      ],
    };
    await storage.createText(
      characterProposalManifestPath(manifest.proposalId),
      serializeCharacterProposalManifest(manifest),
      { createParents: true },
    );

    const repository = createCharacterFileProposalRepository(storage);
    const listed = await repository.list();
    const change = listed.proposals[0]?.changes[0];
    expect(change?.conflict).toBe(true);
    await repository.resolveConflict(manifest.proposalId, "new-race", {
      strategy: "use-proposal",
      expectedCurrentContent: change?.currentContent ?? null,
    }, "测试");
    const library = await (await import("./characterLibraryRepository")).createNovelCharacterLibraryRepository(storage).load();
    expect(library.meta.races.find((race) => race.id === "human")?.name).toBe("人族");
    const second = await repository.list();
    expect(second.proposals[0]?.changes[0]?.status).toBe("applied");

    const pendingManifest = { ...manifest, proposalId: "race-delete" };
    await storage.createText(
      characterProposalManifestPath(pendingManifest.proposalId),
      serializeCharacterProposalManifest(pendingManifest),
      { createParents: true },
    );
    await repository.delete(pendingManifest.proposalId, ["new-race"]);
    expect((await repository.list()).proposals).toHaveLength(1);
  });
});
