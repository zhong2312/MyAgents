import { describe, expect, it } from "vitest";

import { createNovelMapProposalRepository } from "./mapProposalRepository";
import { createNovelMapRepository } from "./mapRepository";
import {
  createEmptyMapArtwork,
  serializeMapDocument,
  type MapDocument,
} from "../entities/mapSchema";
import {
  serializeMapProposalManifest,
  type MapProposalManifest,
} from "../entities/mapProposalSchema";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";

function mapValue(id: string, name: string): MapDocument {
  return {
    schemaVersion: 1,
    id,
    name,
    projectionType: "continent",
    canvas: {
      width: 1600,
      height: 1000,
      backgroundColor: "#f3f0e8",
      backgroundImage: null,
      backgroundAssetPath: null,
      backgroundOpacity: 1,
      showGrid: false,
    },
    layers: [
      {
        id: "layer-main",
        name: "主图层",
        visible: true,
        locked: false,
        opacity: 1,
      },
    ],
    features: [],
    artwork: createEmptyMapArtwork(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function manifest(
  status: "pending" | "applied" | "rejected" = "pending",
): MapProposalManifest {
  return {
    schemaVersion: 2,
    proposalId: "proposal-1",
    title: "AI 地图提案",
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: {
      kind: "agent",
      promptId: "novel.maps.assist",
      promptVersion: "1.0.0",
    },
    operations: [
      {
        candidateId: "candidate-1",
        kind: "map",
        action: "create",
        summary: "新建九州地图",
        valuePath: "candidates/candidate-1.json",
        status,
      },
    ],
  };
}

function storageWithProposal(): NovelMemoryStorage {
  return new NovelMemoryStorage({
    "world/maps/proposals/proposal-1/proposal.json":
      serializeMapProposalManifest(manifest()),
    "world/maps/proposals/proposal-1/candidates/candidate-1.json":
      serializeMapDocument(mapValue("map-1", "九州")),
  });
}

class PreviewLimitedMemoryStorage extends NovelMemoryStorage {
  override async readText(path: string) {
    const file = await super.readText(path);
    if (file.size > 2 * 1024 * 1024) {
      throw new Error("File too large to preview (max 2 MB)");
    }
    return file;
  }

  override async readBinary(path: string): Promise<ArrayBuffer> {
    const content = this.getText(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return Uint8Array.from(new TextEncoder().encode(content)).buffer;
  }
}

function oversizedLegacyStorage(): PreviewLimitedMemoryStorage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(1_600_000)}--></svg>`;
  const value = mapValue("map-legacy", "旧版九州");
  value.canvas.backgroundImage = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  return new PreviewLimitedMemoryStorage({
    "world/maps/proposals/proposal-legacy/proposal.json": `${JSON.stringify(
      {
        schemaVersion: 1,
        proposalId: "proposal-legacy",
        title: "旧版大地图提案",
        description: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        source: {
          kind: "agent",
          promptId: "novel.maps.assist",
          promptVersion: "1.0.0",
        },
        operations: [
          {
            candidateId: "candidate-legacy",
            kind: "map",
            action: "create",
            summary: "迁移旧版大地图",
            value,
            status: "pending",
          },
        ],
      },
      null,
      2,
    )}\n`,
  });
}

describe("createNovelMapProposalRepository", () => {
  it("采纳 v2 地图候选并写入正式地图库", async () => {
    const storage = storageWithProposal();
    const repository = createNovelMapProposalRepository(storage);

    await repository.apply("proposal-1", ["candidate-1"]);

    const index = JSON.parse(storage.getText("world/maps/index.json")!);
    expect(index.maps.map((entry: { id: string }) => entry.id)).toEqual([
      "map-1",
    ]);
    const record = JSON.parse(
      storage.getText("world/maps/records/map-1.json")!,
    );
    expect(record.name).toBe("九州");
    const applied = JSON.parse(
      storage.getText("world/maps/proposals/proposal-1/proposal.json")!,
    );
    expect(applied.operations[0].status).toBe("applied");
  });

  it("采纳的设定驱动候选可重载、编辑并保留实体引用", async () => {
    const candidate = mapValue("map-xuanhuan", "九州玄幻地图");
    candidate.features = [
      {
        id: "feature-sword-sect",
        kind: "marker",
        name: "万剑宗",
        entityRef: { kind: "faction", id: "faction-sword-sect" },
        layerId: "layer-main",
        points: [{ x: 640, y: 280 }],
        timeFrom: null,
        timeTo: null,
        props: { showLabel: "true", component: "sect" },
        description: "依北境雪岭而建的剑修宗门。",
      },
    ];
    const proposal = manifest();
    proposal.operations[0] = {
      ...proposal.operations[0],
      candidateId: "candidate-xuanhuan",
      valuePath: "candidates/candidate-xuanhuan.json",
    };
    const storage = new NovelMemoryStorage({
      "world/maps/proposals/proposal-1/proposal.json":
        serializeMapProposalManifest(proposal),
      "world/maps/proposals/proposal-1/candidates/candidate-xuanhuan.json":
        serializeMapDocument(candidate),
    });
    const proposalRepository = createNovelMapProposalRepository(storage);
    const mapRepository = createNovelMapRepository(storage);

    await proposalRepository.apply("proposal-1", ["candidate-xuanhuan"]);

    const accepted = await mapRepository.loadMap("map-xuanhuan");
    expect(accepted.map.features).toEqual([
      expect.objectContaining({
        name: "万剑宗",
        entityRef: { kind: "faction", id: "faction-sword-sect" },
      }),
    ]);

    const saved = await mapRepository.saveMap(accepted, {
      ...accepted.map,
      features: accepted.map.features.map((feature) =>
        feature.id === "feature-sword-sect"
          ? { ...feature, points: [{ x: 720, y: 320 }] }
          : feature,
      ),
    });
    const reloaded = await mapRepository.loadMap(saved.map.id);
    expect(reloaded.map.features[0]?.points).toEqual([{ x: 720, y: 320 }]);
    expect(reloaded.map.features[0]?.entityRef).toEqual({
      kind: "faction",
      id: "faction-sword-sect",
    });
  });

  it("采纳越界地图候选时由正式仓储延展画布", async () => {
    const candidate = mapValue("map-1", "远方九州");
    candidate.features = [
      {
        id: "feature-far",
        kind: "marker",
        name: "远方",
        entityRef: null,
        layerId: "layer-main",
        points: [{ x: 2_100, y: 1_400 }],
        timeFrom: null,
        timeTo: null,
        props: {},
        description: "",
      },
    ];
    const storage = new NovelMemoryStorage({
      "world/maps/proposals/proposal-1/proposal.json":
        serializeMapProposalManifest(manifest()),
      "world/maps/proposals/proposal-1/candidates/candidate-1.json":
        serializeMapDocument(candidate),
    });
    const repository = createNovelMapProposalRepository(storage);

    await repository.apply("proposal-1", ["candidate-1"]);

    const record = JSON.parse(
      storage.getText("world/maps/records/map-1.json")!,
    ) as MapDocument;
    expect(record.canvas.width).toBeGreaterThan(2_100);
    expect(record.canvas.height).toBeGreaterThan(1_400);
    expect(record.features[0]?.points).toEqual([{ x: 2_100, y: 1_400 }]);
  });

  it("拒绝候选只更新小型 manifest，不改候选正文", async () => {
    const storage = storageWithProposal();
    const candidateBefore = storage.getText(
      "world/maps/proposals/proposal-1/candidates/candidate-1.json",
    );
    const repository = createNovelMapProposalRepository(storage);

    await repository.reject("proposal-1", ["candidate-1"]);

    expect(storage.getText("world/maps/index.json")).toBeUndefined();
    expect(
      storage.getText(
        "world/maps/proposals/proposal-1/candidates/candidate-1.json",
      ),
    ).toBe(candidateBefore);
    const rejected = JSON.parse(
      storage.getText("world/maps/proposals/proposal-1/proposal.json")!,
    );
    expect(rejected.operations[0].status).toBe("rejected");
  });

  it("读取并采纳超过 2 MB 的 v1 提案，迁移候选与 SVG 资源", async () => {
    const storage = oversizedLegacyStorage();
    const repository = createNovelMapProposalRepository(storage);

    const listed = await repository.list();
    expect(listed.errors).toEqual([]);
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0]?.operations).toHaveLength(1);

    await repository.apply("proposal-legacy", ["candidate-legacy"]);

    const migrated = JSON.parse(
      storage.getText("world/maps/proposals/proposal-legacy/proposal.json")!,
    );
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.operations[0]).not.toHaveProperty("value");
    expect(migrated.operations[0].status).toBe("applied");
    expect(
      storage.getText(
        "world/maps/proposals/proposal-legacy/candidates/candidate-legacy.json",
      ),
    ).toBeDefined();
    expect(
      storage.getText(
        "world/maps/proposals/proposal-legacy/assets/candidate-legacy.svg",
      ),
    ).toContain("<svg");
    const record = JSON.parse(
      storage.getText("world/maps/records/map-legacy.json")!,
    );
    expect(record.canvas.backgroundImage).toBeNull();
    expect(record.canvas.backgroundAssetPath).toBe(
      "world/maps/assets/map-legacy/candidate-legacy.svg",
    );
    expect(
      storage.getText("world/maps/assets/map-legacy/candidate-legacy.svg"),
    ).toContain("<svg");
  });

  it("重试采纳时复用内容相同的正式 SVG，不创建重名资源", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    const value = mapValue("map-1", "九州");
    value.canvas.backgroundAssetPath =
      "world/maps/proposals/proposal-1/assets/candidate-1.svg";
    const storage = new NovelMemoryStorage({
      "world/maps/proposals/proposal-1/proposal.json":
        serializeMapProposalManifest(manifest()),
      "world/maps/proposals/proposal-1/candidates/candidate-1.json":
        serializeMapDocument(value),
      "world/maps/proposals/proposal-1/assets/candidate-1.svg": svg,
      "world/maps/assets/map-1/candidate-1.svg": svg,
    });
    const repository = createNovelMapProposalRepository(storage);

    await repository.apply("proposal-1", ["candidate-1"]);

    const record = JSON.parse(
      storage.getText("world/maps/records/map-1.json")!,
    );
    expect(record.canvas.backgroundAssetPath).toBe(
      "world/maps/assets/map-1/candidate-1.svg",
    );
    expect(
      storage.getText("world/maps/assets/map-1/candidate-1_1.svg"),
    ).toBeUndefined();
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
