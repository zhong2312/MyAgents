import { describe, expect, it } from "vitest";

import { createNovelMapProposalRepository } from "./mapProposalRepository";
import {
  serializeMapProposalManifest,
  type MapProposalManifest,
} from "../entities/mapProposalSchema";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";

function manifest(
  operations: MapProposalManifest["operations"],
): MapProposalManifest {
  return {
    schemaVersion: 1,
    proposalId: "proposal-1",
    title: "AI 地图提案",
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "agent", promptId: "novel.maps.assist", promptVersion: "1.0.0" },
    operations,
  };
}

function mapValue(id: string, name: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    name,
    projectionType: "continent",
    layers: [{ id: "layer-main", name: "主图层", visible: true }],
    features: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function storageWithProposal(): NovelMemoryStorage {
  return new NovelMemoryStorage({
    "world/maps/proposals/proposal-1/proposal.json":
      serializeMapProposalManifest(
        manifest([
          {
            candidateId: "candidate-1",
            kind: "map",
            action: "create",
            summary: "新建九州地图",
            value: mapValue("map-1", "九州"),
            status: "pending",
          },
        ]),
      ),
  });
}

describe("createNovelMapProposalRepository", () => {
  it("采纳地图候选并写入正式地图库", async () => {
    const storage = storageWithProposal();
    const repository = createNovelMapProposalRepository(storage);

    await repository.apply("proposal-1", ["candidate-1"]);

    const index = JSON.parse(storage.getText("world/maps/index.json")!);
    expect(index.maps.map((entry: { id: string }) => entry.id)).toEqual(["map-1"]);
    const record = JSON.parse(storage.getText("world/maps/records/map-1.json")!);
    expect(record.name).toBe("九州");
    const applied = JSON.parse(
      storage.getText("world/maps/proposals/proposal-1/proposal.json")!,
    );
    expect(applied.operations[0].status).toBe("applied");
  });

  it("拒绝候选只更新提案状态", async () => {
    const storage = storageWithProposal();
    const repository = createNovelMapProposalRepository(storage);

    await repository.reject("proposal-1", ["candidate-1"]);

    expect(storage.getText("world/maps/index.json")).toBeUndefined();
    const applied = JSON.parse(
      storage.getText("world/maps/proposals/proposal-1/proposal.json")!,
    );
    expect(applied.operations[0].status).toBe("rejected");
  });

  it("删除提案目录", async () => {
    const storage = storageWithProposal();
    const repository = createNovelMapProposalRepository(storage);

    await repository.deleteProposals(["proposal-1"]);

    expect(
      storage.getText("world/maps/proposals/proposal-1/proposal.json"),
    ).toBeUndefined();
  });
});
