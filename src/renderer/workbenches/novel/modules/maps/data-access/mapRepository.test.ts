import { describe, expect, it } from "vitest";

import {
  createNovelMapRepository,
  validateMapEntityReferences,
} from "./mapRepository";
import {
  createEmptyMapArtwork,
  createEmptyMapDocument,
  createEmptyMapScene,
  parseMapDocument,
  type MapDocument,
} from "../entities/mapSchema";
import { addMapSceneStroke, createMapSceneStroke } from "../business/mapScene";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";

function mapDocument(): MapDocument {
  return {
    schemaVersion: 1,
    id: "map-1",
    name: "九州",
    projectionType: "continent",
    layers: [
      {
        id: "layer-main",
        name: "主图层",
        visible: true,
        locked: false,
        opacity: 1,
      },
    ],
    canvas: {
      width: 1600,
      height: 1000,
      backgroundColor: "#f3f0e8",
      showGrid: true,
    },
    features: [
      {
        id: "feature-1",
        kind: "marker",
        name: "青云山",
        entityRef: { kind: "location", id: "loc-1" },
        layerId: "layer-main",
        points: [{ x: 10, y: 20 }],
        timeFrom: null,
        timeTo: null,
        props: {},
        description: "",
      },
    ],
    artwork: createEmptyMapArtwork(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("createNovelMapRepository", () => {
  it("新旧自由圈定区域共用闭合几何契约", () => {
    const document = createEmptyMapDocument({
      id: "map-area",
      name: "区域测试",
      projectionType: "continent",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const area = {
      id: "feature-area",
      kind: "area" as const,
      name: "北境",
      entityRef: null,
      layerId: "layer-main",
      points: [
        { x: 10, y: 10 },
        { x: 120, y: 10 },
        { x: 70, y: 90 },
      ],
      timeFrom: null,
      timeTo: null,
      props: {},
      description: "",
    };

    expect(
      parseMapDocument(
        "world/maps/records/map-area.json",
        JSON.stringify({ ...document, features: [area] }),
      ).features[0]?.kind,
    ).toBe("area");
    expect(() =>
      parseMapDocument(
        "world/maps/records/map-area.json",
        JSON.stringify({
          ...document,
          features: [{ ...area, points: area.points.slice(0, 2) }],
        }),
      ),
    ).toThrow("自由圈定区域至少需要三个坐标点");
    expect(
      parseMapDocument(
        "world/maps/records/map-area.json",
        JSON.stringify({
          ...document,
          features: [{ ...area, kind: "polygon" }],
        }),
      ).features[0]?.kind,
    ).toBe("polygon");
  });

  it("创建地图并写索引与记录，可加载与保存", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelMapRepository(storage);

    const created = await repository.createMap({
      id: "map-1",
      name: "九州",
      projectionType: "continent",
    });
    expect(created.map.features).toHaveLength(0);
    expect(created.map.layers).toHaveLength(1);

    const loaded = await repository.loadMap("map-1");
    expect(loaded.map.id).toBe("map-1");

    const updated = await repository.saveMap(loaded, mapDocument());
    expect(updated.map.features).toHaveLength(1);
    expect(updated.map.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");

    const index = await repository.loadIndex();
    expect(index.index.maps).toHaveLength(1);
    expect(index.index.maps[0]?.name).toBe("九州");
  });

  it("保存边界外事实时由仓储统一延展画布", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelMapRepository(storage);
    const created = await repository.createMap({
      id: "map-1",
      name: "九州",
      projectionType: "continent",
    });
    const candidate = {
      ...created.map,
      features: [
        {
          id: "feature-far",
          kind: "marker" as const,
          name: "远方",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 2_000, y: 1_500 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    };

    const saved = await repository.saveMap(created, candidate);

    expect(saved.map.canvas.width).toBeGreaterThan(2_000);
    expect(saved.map.canvas.height).toBeGreaterThan(1_500);
    expect(saved.map.features[0]?.points).toEqual([{ x: 2_000, y: 1_500 }]);
    const persisted = JSON.parse(
      storage.getText("world/maps/records/map-1.json")!,
    ) as MapDocument;
    expect(persisted.canvas.width).toBe(saved.map.canvas.width);
    expect(persisted.features[0]?.points).toEqual([{ x: 2_000, y: 1_500 }]);
  });

  it("首次手工落图按内容包络初始化画布，并保留可继续绘制的留白", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelMapRepository(storage);
    const created = await repository.createMap({
      id: "map-leading-edge",
      name: "左上留白",
      projectionType: "continent",
    });
    const candidate = {
      ...created.map,
      features: [
        {
          id: "feature-leading-edge",
          kind: "marker" as const,
          name: "边境港口",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 0, y: 0 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    };

    const saved = await repository.saveMap(created, candidate);

    // 单点标记的可见外沿为 6px；首次落图后的画布由外沿与四周固定
    // 留白精确推导，不能再退回到默认的 640 × 400 最小画板。
    expect(saved.map.canvas).toMatchObject({ width: 332, height: 332 });
    expect(saved.map.features[0]?.points).toEqual([{ x: 166, y: 166 }]);
  });

  it("保存 Agent 生成的新地图时按生成内容包络初始化画布", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelMapRepository(storage);
    const created = await repository.createMap({
      id: "map-generated",
      name: "生成地图",
      projectionType: "continent",
    });
    const generated = {
      ...created.map,
      features: [
        {
          id: "generated-land",
          kind: "polygon" as const,
          name: "主大陆",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: 420, y: 60 },
            { x: 860, y: 80 },
            { x: 780, y: 360 },
            { x: 460, y: 340 },
          ],
          timeFrom: null,
          timeTo: null,
          props: { generator: "fantasy-map-tool", terrain: "coast" },
          description: "生成大陆",
        },
      ],
    };

    const saved = await repository.saveMap(created, generated);

    expect(saved.map.canvas).toMatchObject({ width: 760, height: 620 });
    expect(saved.map.features[0]?.points).toEqual([
      { x: 160, y: 160 },
      { x: 600, y: 180 },
      { x: 520, y: 460 },
      { x: 200, y: 440 },
    ]);
  });

  it("保存时校验稳定 id 与冲突保护", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelMapRepository(storage);
    await repository.createMap({
      id: "map-1",
      name: "九州",
      projectionType: "continent",
    });

    await expect(
      repository.createMap({
        id: "map-1",
        name: "重复",
        projectionType: "planet",
      }),
    ).rejects.toThrow("地图 id 已存在");

    const loaded = await repository.loadMap("map-1");
    // 模拟外部修改 → expectedContent 冲突
    storage.setExternalText(
      "world/maps/records/map-1.json",
      storage
        .getText("world/maps/records/map-1.json")!
        .replace("九州", "外部改名"),
    );
    await expect(
      repository.saveMap(loaded, { ...loaded.map, name: "我的改名" }),
    ).rejects.toThrow("File changed externally");
  });

  it("保存时拒绝悬空的拓扑地图关联", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelMapRepository(storage);
    const created = await repository.createMap({
      id: "map-topology",
      name: "诸界拓扑",
      projectionType: "multiverse",
    });
    const candidate: MapDocument = {
      ...created.map,
      features: [
        {
          id: "node-missing-map",
          kind: "node",
          name: "失效世界",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 100, y: 100 }],
          timeFrom: null,
          timeTo: null,
          props: { linkedMapId: "map-does-not-exist" },
          description: "",
        },
      ],
    };

    await expect(repository.saveMap(created, candidate)).rejects.toThrow(
      "关联了不存在的地图：map-does-not-exist",
    );
  });

  it("删除地图前阻止仍被其他拓扑节点引用的目标", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelMapRepository(storage);
    await repository.createMap({
      id: "map-target",
      name: "目标世界",
      projectionType: "continent",
    });
    const source = await repository.createMap({
      id: "map-source",
      name: "拓扑总图",
      projectionType: "multiverse",
    });
    await repository.saveMap(source, {
      ...source.map,
      features: [
        {
          id: "node-target",
          kind: "node",
          name: "目标世界节点",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 100, y: 100 }],
          timeFrom: null,
          timeTo: null,
          props: { linkedMapId: "map-target" },
          description: "",
        },
      ],
    });

    await expect(repository.deleteMap("map-target")).rejects.toThrow(
      "拓扑节点“目标世界节点”仍然关联此地图",
    );
    expect((await repository.loadIndex()).index.maps).toHaveLength(2);
  });

  it("旧地图缺少 scene 时仍可加载，并在首次绘制后持久化场景", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelMapRepository(storage);
    await repository.createMap({
      id: "map-legacy",
      name: "旧大陆",
      projectionType: "continent",
    });

    const recordPath = "world/maps/records/map-legacy.json";
    const createdContent = storage.getText(recordPath);
    if (!createdContent) throw new Error("测试地图记录未创建");
    const legacyValue = JSON.parse(createdContent) as Record<string, unknown>;
    delete legacyValue.scene;
    storage.setExternalText(recordPath, `${JSON.stringify(legacyValue)}\n`);

    const loaded = await repository.loadMap("map-legacy");
    expect(loaded.map.scene).toBeUndefined();

    const scene = createEmptyMapScene();
    const stroke = createMapSceneStroke({
      id: "stroke-legacy-migration",
      layerId: "scene-terrain",
      points: [
        { x: 120, y: 180 },
        { x: 180, y: 210 },
      ],
      color: "#8b6b4a",
      width: 64,
    });
    const saved = await repository.saveMap(loaded, {
      ...loaded.map,
      scene: addMapSceneStroke(scene, stroke),
    });
    expect(saved.map.scene?.layers[0]?.strokes).toHaveLength(1);

    const reloaded = await repository.loadMap("map-legacy");
    expect(reloaded.map.scene?.layers[0]?.strokes[0]?.id).toBe(
      "stroke-legacy-migration",
    );
  });

  it("损坏或旧版索引只读报错，不会静默清空原文件", async () => {
    const legacyContent = JSON.stringify({
      schemaVersion: 1,
      maps: [
        {
          id: "map-a366ca15",
          name: "未命名地图",
          kind: "continent",
          coordinateMode: "relative",
          visibleLayerIds: ["water", "routes"],
          points: [{ id: "p-1", x: 1, y: 2 }],
        },
      ],
    });
    const storage = new NovelMemoryStorage({
      "world/maps/index.json": legacyContent,
    });
    const repository = createNovelMapRepository(storage);

    await expect(repository.loadIndex()).rejects.toThrow(
      "world/maps/index.json 格式错误",
    );
    expect(storage.getText("world/maps/index.json")).toBe(legacyContent);
  });

  it("删除地图移除索引与记录", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelMapRepository(storage);
    await repository.createMap({
      id: "map-1",
      name: "九州",
      projectionType: "continent",
    });

    await repository.deleteMap("map-1");

    const index = await repository.loadIndex();
    expect(index.index.maps).toHaveLength(0);
    expect(storage.getText("world/maps/records/map-1.json")).toBeUndefined();
  });

  it("实体引用校验检测悬空引用", async () => {
    const storage = new NovelMemoryStorage({});
    const errors = await validateMapEntityReferences(storage, mapDocument(), {
      character: new Set(),
      event: new Set(),
      location: new Set(["loc-1"]),
      faction: new Set(),
      item: new Set(),
      setting: new Set(),
    });
    expect(errors).toEqual([]);

    const missing = await validateMapEntityReferences(storage, mapDocument(), {
      character: new Set(),
      event: new Set(),
      location: new Set(),
      faction: new Set(),
      item: new Set(),
      setting: new Set(),
    });
    expect(missing[0]).toMatch(/关联了不存在的location：loc-1/);
  });
});
