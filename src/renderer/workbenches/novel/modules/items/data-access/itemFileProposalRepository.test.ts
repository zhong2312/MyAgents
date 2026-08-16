import { describe, expect, it } from "vitest";

import { createEmptyNovelStorage } from "../../../shared/infrastructure/testStorage";
import {
  ITEM_BATCH_PROPOSALS_DIRECTORY,
  serializeItemBatchProposalManifest,
  type ItemBatchProposalManifest,
} from "../entities/itemBatchProposalSchema";
import { createNovelItemLibraryRepository } from "./itemLibraryRepository";
import { createItemFileProposalRepository } from "./itemFileProposalRepository";

describe("item file proposal adapter", () => {
  it("materializes stable record targets and removes one candidate", async () => {
    const storage = createEmptyNovelStorage();
    const itemLibraryRepository = createNovelItemLibraryRepository(storage);
    const initialized = await itemLibraryRepository.load();
    await itemLibraryRepository.createItem(initialized, {
      id: "item-amulet",
      name: "旧护符",
      categoryId: "uncategorized",
      pageContent: "旧描述",
    });
    const manifest: ItemBatchProposalManifest = {
      schemaVersion: 1,
      proposalId: "item-proposal",
      title: "物品提案",
      description: "",
      categoryId: "uncategorized",
      createdAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "agent", promptId: "test", promptVersion: "1.0.0" },
      items: [
        {
          candidateId: "amulet",
          name: "新护符",
          aliases: [],
          tags: [],
          summary: "",
          values: {},
          description: "",
          status: "pending",
        },
      ],
    };
    await storage.createText(
      `${ITEM_BATCH_PROPOSALS_DIRECTORY}/${manifest.proposalId}/proposal.json`,
      serializeItemBatchProposalManifest(manifest),
      { createParents: true },
    );

    const repository = createItemFileProposalRepository(storage);
    const listed = await repository.list();
    const change = listed.proposals[0]?.changes[0];
    expect(change?.targetPath).toBe(
      "world/items/records/item-amulet.json",
    );
    expect(change?.conflict).toBe(true);
    await repository.resolveConflict(manifest.proposalId, "amulet", {
      strategy: "use-proposal",
      expectedCurrentContent: change?.currentContent ?? null,
    }, "测试");
    const reloaded = await itemLibraryRepository.load();
    const record = await itemLibraryRepository.loadItem(reloaded.index.items[0]!);
    expect(record.record.name).toBe("新护符");
    expect((await repository.list()).proposals[0]?.changes[0]?.status).toBe("applied");
  });
});
