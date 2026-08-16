import { describe, expect, it } from "vitest";

import { createEmptyMapDocument } from "../entities/mapSchema";
import {
  canEditMapSelectableItems,
  duplicateMapSelectableItems,
  moveMapSelectableItems,
  removeMapSelectableItems,
} from "./mapSelection";

function document() {
  const map = createEmptyMapDocument({
    id: "map-selection",
    name: "框选测试",
    projectionType: "continent",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    ...map,
    features: [
      {
        id: "feature-city",
        kind: "marker" as const,
        name: "北城",
        entityRef: null,
        layerId: "layer-main",
        points: [{ x: 320, y: 240 }],
        timeFrom: null,
        timeTo: null,
        props: {},
        description: "",
      },
    ],
    artwork: {
      ...map.artwork,
      layers: map.artwork.layers.map((layer) => ({
        ...layer,
        stamps: [
          {
            id: "stamp-mountain",
            layerId: layer.id,
            assetId: "mountain-range",
            x: 520,
            y: 360,
            variant: 0,
            scale: 1,
            rotation: 0,
            opacity: 1,
            flipX: false,
            flipY: false,
          },
        ],
      })),
    },
  };
}

describe("mapSelection", () => {
  it("只允许可见且未锁定的要素与印章进入批量操作", () => {
    const current = document();
    expect(
      canEditMapSelectableItems(current, ["feature-city", "stamp-mountain"]),
    ).toBe(true);

    const locked = {
      ...current,
      layers: current.layers.map((layer) =>
        layer.id === "layer-main" ? { ...layer, locked: true } : layer,
      ),
    };
    expect(
      canEditMapSelectableItems(locked, ["feature-city", "stamp-mountain"]),
    ).toBe(false);
    expect(canEditMapSelectableItems(current, ["missing"])).toBe(false);
  });

  it("批量移动和删除只修改选区内的地图事实", () => {
    const current = document();
    const moved = moveMapSelectableItems(
      current,
      ["feature-city", "stamp-mountain"],
      { x: 80, y: -40 },
    );

    expect(moved.features[0]?.points).toEqual([{ x: 400, y: 200 }]);
    expect(moved.artwork.layers[0]?.stamps[0]).toMatchObject({
      x: 600,
      y: 320,
    });

    const removed = removeMapSelectableItems(moved, ["feature-city"]);
    expect(removed.features).toHaveLength(0);
    expect(removed.artwork.layers[0]?.stamps).toHaveLength(1);
  });

  it("批量复制要素和印章，副本保留图层并成为独立事实", () => {
    const current = document();
    const copied = duplicateMapSelectableItems(current, [
      "feature-city",
      "stamp-mountain",
    ]);

    expect(copied.duplicatedIds).toEqual([
      "feature-city-copy",
      "stamp-mountain-copy",
    ]);
    expect(copied.map.features).toEqual([
      current.features[0],
      expect.objectContaining({
        id: "feature-city-copy",
        name: "北城 副本",
        layerId: "layer-main",
        points: [{ x: 338, y: 258 }],
      }),
    ]);
    expect(copied.map.artwork.layers[0]?.stamps).toEqual([
      current.artwork.layers[0]?.stamps[0],
      expect.objectContaining({
        id: "stamp-mountain-copy",
        layerId: "artwork-stamps",
        x: 538,
        y: 378,
      }),
    ]);

    const copiedAgain = duplicateMapSelectableItems(
      copied.map,
      copied.duplicatedIds,
    );
    expect(copiedAgain.duplicatedIds).toEqual([
      "feature-city-copy-copy",
      "stamp-mountain-copy-copy",
    ]);
  });
});
