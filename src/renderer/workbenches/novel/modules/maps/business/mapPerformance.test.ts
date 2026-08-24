import { describe, expect, it } from "vitest";

import { createEmptyMapDocument } from "../entities/mapSchema";
import { resolveMapLabelPlacements } from "./mapLabels";
import {
  applyGeneratorCandidate,
  generateFantasyMapCandidate,
} from "./mapGenerators";

describe("地图大图性能基准", () => {
  it("在高负载候选和五百个中文标签下保持可重复结果", () => {
    const baseDocument = createEmptyMapDocument({
      id: "map-performance",
      name: "大地图性能基准",
      projectionType: "continent",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const document = {
      ...baseDocument,
      canvas: { ...baseDocument.canvas, width: 4_000, height: 2_400 },
    };
    const startedAt = performance.now();
    const generated = generateFantasyMapCandidate({
      document,
      seed: "map-performance-2026",
      layerId: "layer-main",
      landmassCount: 4,
      regionCount: 12,
      riverCount: 14,
      terrainKeywords: ["雪岭", "原始森林", "沙漠", "湿地", "火山"],
      placeNames: Array.from({ length: 240 }, (_, index) => `地点${index}`),
      factionNames: Array.from({ length: 24 }, (_, index) => `势力${index}`),
      spatialNames: Array.from({ length: 24 }, (_, index) => `空间层${index}`),
    });
    const applied = applyGeneratorCandidate(document, generated);
    const featureCount = generated.features.length;
    const artworkStampCount = applied.artwork.layers.reduce(
      (count, layer) => count + layer.stamps.length,
      0,
    );
    const labels = Array.from({ length: 500 }, (_, index) => ({
      id: `label-${index}`,
      kind: "marker" as const,
      name: `第${index}处玄幻地名`,
      entityRef: null,
      layerId: "layer-main",
      points: [{ x: (index % 25) * 140, y: Math.floor(index / 25) * 100 }],
      timeFrom: null,
      timeTo: null,
      props: {
        showLabel: "true",
        importance: String(index % 6),
        entityRole: index % 11 === 0 ? "capital" : "city",
      },
      description: "",
    }));
    const placements = resolveMapLabelPlacements(labels, { zoom: 1 });
    const elapsedMs = performance.now() - startedAt;

    expect(featureCount).toBeGreaterThan(60);
    expect(artworkStampCount).toBeGreaterThan(40);
    expect(placements.size).toBe(500);
    expect(
      [...placements.values()].some((placement) => placement.visible),
    ).toBe(true);
    // 2 秒是宽松上限，主要用于捕获数量级回归而非绑定具体机器速度。
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
