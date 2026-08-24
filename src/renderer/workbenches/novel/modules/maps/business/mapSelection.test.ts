import { describe, expect, it } from "vitest";

import { createEmptyMapDocument } from "../entities/mapSchema";
import { createMapSceneStroke } from "./mapScene";
import {
  canEditMapSelectableItems,
  duplicateMapSelectableItems,
  isMapSelectableItemLocked,
  moveMapSelectableItems,
  removeMapSelectableItems,
  setMapSelectableItemsLocked,
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
    scene: {
      ...map.scene!,
      layers: map.scene!.layers.map((layer) =>
        layer.id === "scene-terrain"
          ? {
              ...layer,
              strokes: [
                createMapSceneStroke({
                  id: "terrain-land",
                  layerId: layer.id,
                  points: [
                    { x: 100, y: 120 },
                    { x: 380, y: 260 },
                  ],
                  color: "#b8ad7d",
                  width: 180,
                }),
                createMapSceneStroke({
                  id: "terrain-material",
                  layerId: layer.id,
                  terrainMaterial: "desert",
                  points: [
                    { x: 140, y: 150 },
                    { x: 340, y: 240 },
                  ],
                  color: "#c9a865",
                  width: 120,
                }),
              ],
            }
          : layer,
      ),
    },
  };
}

describe("mapSelection", () => {
  it("移动或删除地表来源要素时同步派生场景区域", () => {
    const base = document();
    const map = {
      ...base,
      features: [
        {
          id: "coast-source",
          kind: "area" as const,
          name: "大陆轮廓",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: 10, y: 10 },
            { x: 80, y: 10 },
            { x: 80, y: 60 },
          ],
          timeFrom: null,
          timeTo: null,
          props: { sceneSurface: "true" },
          description: "",
        },
      ],
      scene: {
        ...base.scene!,
        layers: base.scene!.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                regions: [
                  {
                    id: "generated-region-coast-source",
                    layerId: layer.id,
                    sourceFeatureId: "coast-source",
                    kind: "land" as const,
                    points: [
                      { x: 10, y: 10 },
                      { x: 80, y: 10 },
                      { x: 80, y: 60 },
                    ],
                    fill: "#d8c58f",
                    texture: "paper-land" as const,
                    opacity: 1,
                    edgeColor: "#536b54",
                    edgeWidth: 3,
                    terrainMaterial: null,
                  },
                ],
              }
            : layer,
        ),
      },
    };
    const moved = moveMapSelectableItems(map, ["coast-source"], {
      x: 12,
      y: -4,
    });
    expect(
      moved.scene?.layers
        .flatMap((layer) => layer.regions)
        .find((region) => region.sourceFeatureId === "coast-source")?.points,
    ).toEqual([
      { x: 22, y: 6 },
      { x: 92, y: 6 },
      { x: 92, y: 56 },
    ]);
    expect(
      removeMapSelectableItems(moved, ["coast-source"]).scene?.layers,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          regions: expect.arrayContaining([
            expect.objectContaining({ sourceFeatureId: "coast-source" }),
          ]),
        }),
      ]),
    );
  });

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

  it("按对象锁定普通要素、素材、笔触和区域，并支持组合成员", () => {
    const base = document();
    const withRegion = {
      ...base,
      scene: {
        ...base.scene!,
        layers: base.scene!.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                regions: [
                  {
                    id: "terrain-region",
                    layerId: layer.id,
                    kind: "land" as const,
                    points: [
                      { x: 80, y: 80 },
                      { x: 180, y: 80 },
                      { x: 180, y: 160 },
                    ],
                    fill: "#b8ad7d",
                    texture: "paper-land" as const,
                    opacity: 1,
                    edgeColor: "#655540",
                    edgeWidth: 2,
                  },
                ],
              }
            : layer,
        ),
      },
    };
    const grouped = {
      ...withRegion,
      groups: [
        {
          id: "group-lock",
          name: "锁定组",
          itemIds: ["feature-city", "stamp-mountain"],
        },
      ],
    };
    const locked = setMapSelectableItemsLocked(grouped, ["feature-city"], true);

    expect(isMapSelectableItemLocked(locked, "feature-city")).toBe(true);
    expect(isMapSelectableItemLocked(locked, "stamp-mountain")).toBe(true);
    expect(canEditMapSelectableItems(locked, ["feature-city"])).toBe(false);
    expect(canEditMapSelectableItems(locked, ["stamp-mountain"])).toBe(false);

    const allLocked = setMapSelectableItemsLocked(
      locked,
      ["terrain-land", "terrain-material", "terrain-region"],
      true,
    );
    expect(
      allLocked.scene?.layers
        .flatMap((layer) => [...layer.strokes, ...layer.regions])
        .filter((item) =>
          ["terrain-land", "terrain-material", "terrain-region"].includes(
            item.id,
          ),
        )
        .every((item) => item.locked === true),
    ).toBe(true);

    const unlocked = setMapSelectableItemsLocked(
      allLocked,
      [
        "feature-city",
        "stamp-mountain",
        "terrain-land",
        "terrain-material",
        "terrain-region",
      ],
      false,
    );
    expect(isMapSelectableItemLocked(unlocked, "feature-city")).toBe(false);
    expect(isMapSelectableItemLocked(unlocked, "stamp-mountain")).toBe(false);
    expect(canEditMapSelectableItems(unlocked, ["terrain-land"])).toBe(true);
  });

  it("兼容拓扑节点通过 props.locked 保存的锁定状态", () => {
    const current = document();
    const topologyLocked = {
      ...current,
      features: [
        {
          ...current.features[0]!,
          kind: "node" as const,
          props: { locked: "true" },
        },
      ],
    };
    expect(isMapSelectableItemLocked(topologyLocked, "feature-city")).toBe(
      true,
    );
    expect(canEditMapSelectableItems(topologyLocked, ["feature-city"])).toBe(
      false,
    );
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

  it("地形底稿和材质笔触可以进入同一批量移动事务", () => {
    const current = document();
    expect(
      canEditMapSelectableItems(current, ["terrain-land", "terrain-material"]),
    ).toBe(true);

    const moved = moveMapSelectableItems(
      current,
      ["terrain-land", "terrain-material"],
      { x: 64, y: -28 },
    );
    const terrainLayer = moved.scene?.layers.find(
      (layer) => layer.id === "scene-terrain",
    );
    expect(terrainLayer?.strokes).toEqual([
      expect.objectContaining({
        id: "terrain-land",
        points: [
          { x: 164, y: 92 },
          { x: 444, y: 232 },
        ],
      }),
      expect.objectContaining({
        id: "terrain-material",
        points: [
          { x: 204, y: 122 },
          { x: 404, y: 212 },
        ],
      }),
    ]);

    const removed = removeMapSelectableItems(moved, ["terrain-material"]);
    expect(
      removed.scene?.layers
        .find((layer) => layer.id === "scene-terrain")
        ?.strokes.map((stroke) => stroke.id),
    ).toEqual(["terrain-land"]);
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

  it("复制场景笔触与来源区域时保留绘制事实并重绑来源要素", () => {
    const base = document();
    const map = {
      ...base,
      features: [
        {
          id: "coast-source",
          kind: "area" as const,
          name: "大陆轮廓",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: 10, y: 10 },
            { x: 80, y: 10 },
            { x: 80, y: 60 },
          ],
          timeFrom: null,
          timeTo: null,
          props: { sceneSurface: "true" },
          description: "",
        },
      ],
      scene: {
        ...base.scene!,
        layers: base.scene!.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                regions: [
                  {
                    id: "generated-region-coast-source",
                    layerId: layer.id,
                    sourceFeatureId: "coast-source",
                    kind: "land" as const,
                    points: [
                      { x: 10, y: 10 },
                      { x: 80, y: 10 },
                      { x: 80, y: 60 },
                    ],
                    fill: "#d8c58f",
                    texture: "paper-land" as const,
                    opacity: 1,
                    edgeColor: "#536b54",
                    edgeWidth: 3,
                    terrainMaterial: null,
                  },
                ],
              }
            : layer,
        ),
      },
    };

    const copied = duplicateMapSelectableItems(map, [
      "coast-source",
      "terrain-material",
    ]);
    expect(copied.duplicatedIds).toEqual([
      "coast-source-copy",
      "terrain-material-copy",
      "generated-region-coast-source-copy",
    ]);
    const terrain = copied.map.scene!.layers.find(
      (layer) => layer.id === "scene-terrain",
    )!;
    expect(terrain.strokes).toContainEqual(
      expect.objectContaining({
        id: "terrain-material-copy",
        points: [
          { x: 158, y: 168 },
          { x: 358, y: 258 },
        ],
      }),
    );
    expect(terrain.regions).toContainEqual(
      expect.objectContaining({
        id: "generated-region-coast-source-copy",
        sourceFeatureId: "coast-source-copy",
        points: [
          { x: 28, y: 28 },
          { x: 98, y: 28 },
          { x: 98, y: 78 },
        ],
      }),
    );
  });
});
