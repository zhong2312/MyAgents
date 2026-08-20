import { describe, expect, it } from "vitest";

import {
  createMapComponentPrefabFeature,
  createMapComponentPrefabRegions,
  createMapComponentSurfaceBrushPoints,
  createMapComponentSurfaceBrushRegions,
  getMapComponentTerrainPreviewShapes,
  MAP_COMPONENT_PRESETS,
  mapComponentInteraction,
  mapComponentPlacement,
  mapComponentsInCategory,
  mapComponentsInInteraction,
} from "./mapComponents";
import { getMapArtworkStampAsset } from "./mapArtwork";
import {
  getMapBackgroundPreset,
  mapCanvasBackgroundStyle,
} from "./mapBackgrounds";
import { MAP_TERRAIN_MATERIAL_PRESETS } from "./mapTerrainMaterials";
import { createEmptyMapDocument } from "../entities/mapSchema";

type ComponentRequirement = readonly [
  id: string,
  name: string,
  category: string,
  interaction: "surface" | "scatter" | "path" | "stamp",
  placement: "stamp" | "path" | "terrain-prefab" | "overlay",
];

/**
 * 作者需求中的名称是构件库验收契约，而非仅用于文案搜索。每项都必须
 * 有明确的类别、交互和落图位置，防止后续把连续笔刷重新退化成单体印章。
 */
const USER_COMPONENT_REQUIREMENTS: readonly ComponentRequirement[] = [
  ["continent", "大陆板块", "landmass", "surface", "terrain-prefab"],
  ["archipelago", "群岛", "landmass", "surface", "terrain-prefab"],
  ["mountain-range", "山脉脊线", "mountain", "scatter", "stamp"],
  ["isolated-peak", "孤峰", "mountain", "stamp", "stamp"],
  ["foothills", "丘陵", "mountain", "scatter", "stamp"],
  ["volcano", "火山", "mountain", "stamp", "stamp"],
  ["volcanic-crater", "火山口", "mountain", "stamp", "stamp"],
  ["canyon", "峡谷", "mountain", "path", "path"],
  ["cliff", "断崖", "mountain", "scatter", "stamp"],
  ["mesa", "台地", "mountain", "stamp", "stamp"],
  ["glacier", "冰川", "mountain", "scatter", "stamp"],
  ["dunes", "沙丘", "mountain", "scatter", "stamp"],
  ["rock-pillar", "岩柱", "mountain", "stamp", "stamp"],
  ["karst-peaks", "喀斯特", "mountain", "scatter", "stamp"],
  ["broadleaf-grove", "阔叶林", "vegetation", "scatter", "stamp"],
  ["pine-grove", "针叶林", "vegetation", "scatter", "stamp"],
  ["jungle", "雨林", "vegetation", "scatter", "stamp"],
  ["shrubland", "灌木", "vegetation", "scatter", "stamp"],
  ["grassland", "草地", "vegetation", "scatter", "stamp"],
  ["farmland-field", "农田", "vegetation", "scatter", "stamp"],
  ["mangrove", "红树林", "vegetation", "scatter", "stamp"],
  ["deadwood", "枯木林", "vegetation", "scatter", "stamp"],
  ["mushroom-grove", "蘑菇林", "vegetation", "scatter", "stamp"],
  ["tundra-vegetation", "苔原植被", "vegetation", "scatter", "stamp"],
  ["waterfall", "瀑布", "water", "stamp", "stamp"],
  ["rapids", "急流", "water", "path", "path"],
  ["delta", "三角洲", "water", "surface", "terrain-prefab"],
  ["lake", "湖泊", "water", "surface", "terrain-prefab"],
  ["wetland", "湿地", "water", "surface", "terrain-prefab"],
  ["reed-bed", "芦苇荡", "water", "scatter", "stamp"],
  ["coral-reef", "珊瑚礁", "water", "scatter", "stamp"],
  ["ice-sheet", "冰原", "water", "surface", "terrain-prefab"],
  ["sea-foam", "海浪泡沫", "water", "scatter", "stamp"],
  ["ocean-current", "洋流", "water", "path", "path"],
  ["capital", "都城", "civilization", "stamp", "stamp"],
  ["town", "城镇", "civilization", "scatter", "stamp"],
  ["village", "村落", "civilization", "scatter", "stamp"],
  ["port", "港口", "civilization", "stamp", "stamp"],
  ["fortress", "要塞", "civilization", "stamp", "stamp"],
  ["watchtower", "瞭望塔", "civilization", "stamp", "stamp"],
  ["bridge", "桥梁", "civilization", "stamp", "stamp"],
  ["mine", "矿井", "civilization", "stamp", "stamp"],
  ["ruins", "遗迹", "landmark", "stamp", "stamp"],
  ["temple", "神殿", "landmark", "stamp", "stamp"],
  ["farmstead", "农庄", "civilization", "stamp", "stamp"],
  ["camp", "营地", "civilization", "stamp", "stamp"],
  ["paved-road", "石板路", "civilization", "path", "path"],
  ["dirt-road", "土路", "civilization", "path", "path"],
  ["forest-trail", "林间小径", "civilization", "path", "path"],
  ["trade-route", "商路", "civilization", "path", "path"],
  ["sea-route", "航线", "water", "path", "path"],
  ["wall", "城墙", "civilization", "path", "path"],
  ["national-border", "国界", "civilization", "path", "path"],
  ["territory-fill", "疆域填色", "civilization", "surface", "overlay"],
  ["administrative-pattern", "行政区纹理", "civilization", "surface", "overlay"],
  ["world-gate", "世界之门", "celestial", "stamp", "stamp"],
  ["floating-island", "浮空岛", "landmark", "stamp", "stamp"],
  ["magic-rift", "魔法裂隙", "landmark", "path", "path"],
  ["great-tree", "巨树", "landmark", "stamp", "stamp"],
  ["forbidden-zone", "禁地", "landmark", "stamp", "stamp"],
  ["underworld-gate", "地下入口", "landmark", "stamp", "stamp"],
  ["secret-realm", "秘境", "landmark", "stamp", "stamp"],
  ["ruin-cluster", "遗迹群", "landmark", "stamp", "stamp"],
  ["portal", "传送阵", "landmark", "stamp", "stamp"],
  ["star", "恒星", "celestial", "stamp", "stamp"],
  ["planet", "行星", "celestial", "stamp", "stamp"],
  ["moon", "卫星", "celestial", "stamp", "stamp"],
  ["ring", "星环", "celestial", "stamp", "stamp"],
  ["nebula", "星云", "celestial", "stamp", "stamp"],
  ["star-cluster", "星团", "celestial", "stamp", "stamp"],
  ["star-gate", "星门", "celestial", "stamp", "stamp"],
  ["wormhole", "虫洞", "celestial", "stamp", "stamp"],
  ["civilization-domain", "文明疆域", "celestial", "surface", "overlay"],
  ["stellar-route", "星际航线", "celestial", "path", "path"],
  ["compass", "罗盘", "cartography", "stamp", "stamp"],
  ["scale-bar", "比例尺", "cartography", "stamp", "stamp"],
  ["scroll-frame", "地图卷轴边框", "cartography", "stamp", "stamp"],
  ["chart-wind", "海图风纹", "cartography", "scatter", "stamp"],
  ["mountain-banner", "山名飘带", "cartography", "stamp", "stamp"],
  ["danger-waters", "危险水域标记", "cartography", "stamp", "stamp"],
  ["bamboo-grove", "竹林", "vegetation", "scatter", "stamp"],
  ["stone-pile", "石堆", "mountain", "scatter", "stamp"],
  ["ore-vein", "矿脉", "mountain", "scatter", "stamp"],
  ["cactus", "仙人掌", "vegetation", "scatter", "stamp"],
  ["sea-grass", "海草与海藻", "water", "scatter", "stamp"],
  ["shoal", "浅滩", "water", "surface", "terrain-prefab"],
  ["riverbank", "河岸", "water", "path", "path"],
  ["tributary", "支流", "water", "path", "path"],
  ["fjord", "峡湾", "water", "path", "path"],
  ["bay", "港湾", "water", "path", "path"],
  ["whirlpool", "漩涡", "water", "scatter", "stamp"],
  ["undercurrent", "暗流", "water", "path", "path"],
  ["sea-ice", "海冰", "water", "path", "path"],
  ["mountain-pass", "山道", "civilization", "path", "path"],
  ["boardwalk", "栈道", "civilization", "path", "path"],
  ["canal", "运河", "civilization", "path", "path"],
  ["railway", "铁路", "civilization", "path", "path"],
  ["magic-rail", "魔导轨道", "civilization", "path", "path"],
  ["boundary-line", "边界线", "civilization", "path", "path"],
  ["ley-line", "灵脉", "civilization", "path", "path"],
  ["town-district", "城镇街区", "civilization", "stamp", "stamp"],
  ["castle-cluster", "城堡群", "civilization", "stamp", "stamp"],
  ["terraces", "梯田", "civilization", "scatter", "stamp"],
  ["fishing-village", "渔村", "civilization", "stamp", "stamp"],
  ["lighthouse", "灯塔", "civilization", "stamp", "stamp"],
  ["graveyard", "墓地", "civilization", "stamp", "stamp"],
  ["battlefield", "战场", "civilization", "stamp", "stamp"],
  ["dragonbone-range", "龙骨山脉", "landmark", "stamp", "stamp"],
  ["world-tree-roots", "世界树根系", "landmark", "stamp", "stamp"],
  ["floating-rocks", "漂浮碎石", "landmark", "scatter", "stamp"],
  ["magic-storm", "魔法风暴", "landmark", "stamp", "stamp"],
  ["fog-wall", "禁区雾墙", "landmark", "path", "path"],
  ["barrier", "结界", "landmark", "path", "path"],
  ["dungeon-entrance", "地下城入口", "landmark", "stamp", "stamp"],
  ["spirit-spring", "灵泉", "landmark", "stamp", "stamp"],
  ["beast-nest", "巨兽巢穴", "landmark", "stamp", "stamp"],
  ["contour-line", "等高线", "cartography", "path", "path"],
  ["hillshade", "山体阴影", "cartography", "scatter", "stamp"],
  ["bathymetric-line", "海图水深线", "cartography", "path", "path"],
  ["cloud-layer", "云层", "cartography", "scatter", "stamp"],
  ["paper-stain", "纸张污渍", "cartography", "scatter", "stamp"],
  ["map-frame", "边框", "cartography", "stamp", "stamp"],
  ["title-cartouche", "题图", "cartography", "stamp", "stamp"],
  ["region-number", "区域编号", "cartography", "stamp", "stamp"],
];

const USER_TERRAIN_MATERIAL_REQUIREMENTS = [
  ["beach", "沙滩", "land"],
  ["gravel-beach", "砾石滩", "land"],
  ["salt-flat", "盐碱地", "land"],
  ["tundra", "冻土", "land"],
  ["volcanic-ash", "火山灰", "land"],
  ["lava", "熔岩地", "land"],
  ["karst", "喀斯特", "land"],
  ["badlands", "恶地", "land"],
  ["snow", "雪原", "land"],
  ["snow-cover", "冰雪覆盖", "land"],
  ["shallow-sea", "浅海", "water"],
  ["deep-sea", "深海", "water"],
] as const;

describe("地图设计器构件库", () => {
  it("用户定义的构件都有准确名称、四类交互、落图事实与可渲染素材", () => {
    const byId = new Map(
      MAP_COMPONENT_PRESETS.map((component) => [component.id, component]),
    );

    for (const [id, name, category, interaction, placement] of USER_COMPONENT_REQUIREMENTS) {
      const component = byId.get(id);
      expect(component, id).toMatchObject({ name, category, interaction });
      expect(component && mapComponentPlacement(component), id).toBe(placement);

      const asset = getMapArtworkStampAsset(id);
      expect(asset, `${id} 缺少可渲染素材`).toMatchObject({
        id,
        name,
        brush: interaction === "scatter",
      });
      expect(asset?.imageSrc, id).toMatch(/^data:image\/svg\+xml/u);
      expect(asset?.variants.length, id).toBeGreaterThan(0);
    }
  });

  it("用户定义的地形材质有正确表面语义和纹理预览", () => {
    const byId = new Map(
      MAP_TERRAIN_MATERIAL_PRESETS.map((material) => [material.id, material]),
    );
    for (const [id, name, surface] of USER_TERRAIN_MATERIAL_REQUIREMENTS) {
      const material = byId.get(id);
      expect(material, id).toMatchObject({ id, name, surface });
      expect(material?.preview, id).toContain("gradient");
      expect(material?.color, id).toMatch(/^#[0-9a-f]{6}$/iu);
    }
  });

  it("完整覆盖地图素材清单，并固定四类交互语义", () => {
    const requiredIds = [
      "mountain-range",
      "isolated-peak",
      "foothills",
      "castle-cluster",
      "volcano",
      "volcanic-crater",
      "canyon",
      "cliff",
      "mesa",
      "glacier",
      "dunes",
      "rock-pillar",
      "karst-peaks",
      "broadleaf-grove",
      "pine-grove",
      "jungle",
      "shrubland",
      "grassland",
      "farmland",
      "farmland-field",
      "mangrove",
      "deadwood",
      "deadwood-single",
      "mushroom-grove",
      "tundra-vegetation",
      "waterfall",
      "rapids",
      "delta",
      "lake",
      "wetland",
      "reed-bed",
      "coral-reef",
      "ice-sheet",
      "sea-foam",
      "coast-foam",
      "ocean-current",
      "capital",
      "town",
      "town-district",
      "fishing-village",
      "lighthouse",
      "graveyard",
      "battlefield",
      "village",
      "port",
      "fortress",
      "watchtower",
      "bridge",
      "mine",
      "ruins",
      "temple",
      "farmstead",
      "camp",
      "paved-road",
      "dirt-road",
      "forest-trail",
      "trade-route",
      "sea-route",
      "wall",
      "national-border",
      "boundary-line",
      "territory-fill",
      "administrative-pattern",
      "world-gate",
      "floating-island",
      "magic-rift",
      "world-tree",
      "great-tree",
      "forbidden-zone",
      "underworld-gate",
      "secret-realm",
      "ruin-cluster",
      "portal",
      "star",
      "planet",
      "moon",
      "ringed-planet",
      "ring",
      "nebula",
      "star-cluster",
      "star-gate",
      "wormhole",
      "civilization-domain",
      "stellar-route",
      "compass",
      "scale-bar",
      "scroll-frame",
      "chart-wind",
      "mountain-banner",
      "danger-waters",
    ];
    const byId = new Map(
      MAP_COMPONENT_PRESETS.map((component) => [component.id, component]),
    );
    expect(requiredIds.every((id) => byId.has(id))).toBe(true);
    expect(new Set(requiredIds).size).toBe(requiredIds.length);
    expect(
      MAP_COMPONENT_PRESETS.every((component) =>
        ["surface", "scatter", "path", "stamp"].includes(
          mapComponentInteraction(component),
        ),
      ),
    ).toBe(true);
    expect(mapComponentsInInteraction("surface").length).toBeGreaterThan(5);
    expect(mapComponentsInInteraction("scatter").length).toBeGreaterThan(20);
    expect(mapComponentsInInteraction("path").length).toBeGreaterThan(20);
    expect(mapComponentsInInteraction("stamp").length).toBeGreaterThan(20);
  });

  it("用户新增名称与四类交互保持一一对应", () => {
    const expectations = [
      ["castle-cluster", "城堡群", "stamp"],
      ["farmland-field", "农田", "scatter"],
      ["deadwood-single", "枯木", "scatter"],
      ["boundary-line", "边界线", "path"],
      ["great-tree", "巨树", "stamp"],
      ["ring", "星环", "stamp"],
      ["mesa", "台地", "stamp"],
      ["karst-peaks", "喀斯特", "scatter"],
      ["shrubland", "灌木", "scatter"],
      ["grassland", "草地", "scatter"],
      ["sea-foam", "海浪泡沫", "scatter"],
      ["coast-foam", "海岸浪花", "scatter"],
    ] as const;
    for (const [id, name, interaction] of expectations) {
      const component = MAP_COMPONENT_PRESETS.find((item) => item.id === id);
      expect(component, id).toBeDefined();
      expect(component?.name, id).toBe(name);
      expect(component ? mapComponentInteraction(component) : undefined).toBe(
        interaction,
      );
    }
  });

  it("表面构件笔刷将开放轨迹扩展为连续区域，并保留闭合轨迹边界", () => {
    const continent = MAP_COMPONENT_PRESETS.find(
      (component) => component.id === "continent",
    )!;
    const openPoints = createMapComponentSurfaceBrushPoints({
      points: [
        { x: 100, y: 200 },
        { x: 280, y: 240 },
        { x: 460, y: 180 },
      ],
      width: 80,
      closed: false,
    });
    expect(openPoints.length).toBe(6);
    expect(new Set(openPoints.map((point) => `${point.x}:${point.y}`)).size).toBe(
      openPoints.length,
    );
    const regions = createMapComponentSurfaceBrushRegions({
      component: continent,
      id: "surface-brush",
      layerId: "scene-terrain",
      points: openPoints,
      width: 80,
      closed: true,
      curve: "arc",
    });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      id: "surface-brush",
      layerId: "scene-terrain",
      kind: "land",
      curve: "arc",
    });
    expect(regions[0]?.points).toEqual(openPoints);
  });

  it("每个注册构件都能按交互类型落到真实地图事实", () => {
    const canvas = { width: 1_600, height: 1_000 };
    for (const component of MAP_COMPONENT_PRESETS) {
      const asset = getMapArtworkStampAsset(component.id);
      expect(asset, `${component.id} 缺少素材资产`).toBeDefined();
      expect(asset?.variants.length, component.id).toBeGreaterThan(0);

      if (component.interaction === "scatter") {
        expect(asset?.brush, component.id).toBe(true);
        continue;
      }

      if (component.interaction === "path") {
        const feature = createMapComponentPrefabFeature({
          component,
          id: `contract-${component.id}`,
          layerId: "layer-main",
          anchor: { x: 800, y: 500 },
          canvas,
        });
        expect(feature, component.id).toMatchObject({ kind: "route" });
        expect(feature?.points.length, component.id).toBeGreaterThanOrEqual(2);
        continue;
      }

      if (component.interaction === "surface") {
        if (mapComponentPlacement(component) === "overlay") {
          const feature = createMapComponentPrefabFeature({
            component,
            id: `contract-${component.id}`,
            layerId: "layer-main",
            anchor: { x: 800, y: 500 },
            canvas,
          });
          expect(feature, component.id).toMatchObject({
            kind: "area",
            props: expect.objectContaining({ component: component.id }),
          });
        } else {
          const regions = createMapComponentPrefabRegions({
            component,
            id: `contract-${component.id}`,
            layerId: "scene-terrain",
            anchor: { x: 800, y: 500 },
            canvas,
          });
          expect(regions.length, component.id).toBeGreaterThan(0);
          expect(regions[0]?.points.length, component.id).toBeGreaterThanOrEqual(3);
        }
        continue;
      }

      const feature = createMapComponentPrefabFeature({
        component,
        id: `contract-${component.id}`,
        layerId: "layer-main",
        anchor: { x: 800, y: 500 },
        canvas,
      });
      expect(asset?.brush, component.id).toBe(false);
      expect(feature?.points.length, component.id).toBeGreaterThan(0);
    }
  });

  it("湖泊和湿地使用连续水域区域，而不是单个装饰印章", () => {
    for (const componentId of ["lake", "wetland"]) {
      const component = MAP_COMPONENT_PRESETS.find(
        (item) => item.id === componentId,
      )!;
      expect(mapComponentInteraction(component)).toBe("surface");
      expect(component.terrainPrefab).toMatchObject({
        kind: "water",
        texture: "water-ripple",
      });
      const regions = createMapComponentPrefabRegions({
        component,
        id: `region-${componentId}`,
        layerId: "scene-water",
        anchor: { x: 800, y: 500 },
        canvas: { width: 1600, height: 1000 },
      });
      expect(regions).toHaveLength(1);
      expect(regions[0]?.points.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("疆域与行政纹理是覆盖层，不得改写海陆事实", () => {
    for (const componentId of [
      "territory-fill",
      "administrative-pattern",
      "civilization-domain",
    ]) {
      const component = MAP_COMPONENT_PRESETS.find(
        (item) => item.id === componentId,
      )!;
      expect(component.interaction).toBe("surface");
      expect(mapComponentPlacement(component)).toBe("overlay");
      expect(
        createMapComponentPrefabRegions({
          component,
          id: `overlay-${componentId}`,
          layerId: "scene-terrain",
          anchor: { x: 800, y: 500 },
          canvas: { width: 1600, height: 1000 },
        }),
      ).toEqual([]);
      expect(
        createMapComponentPrefabFeature({
          component,
          id: `feature-${componentId}`,
          layerId: "layer-main",
          anchor: { x: 800, y: 500 },
          canvas: { width: 1600, height: 1000 },
        }),
      ).toMatchObject({
        kind: "area",
        props: expect.objectContaining({ component: componentId }),
      });
    }
  });

  it("新构件不再写入重复的 polygon 区域类型", () => {
    expect(
      MAP_COMPONENT_PRESETS.some(
        (component) => component.drawKind === "polygon",
      ),
    ).toBe(false);

    const grassland = MAP_COMPONENT_PRESETS.find(
      (component) => component.id === "grassland",
    )!;
    const feature = createMapComponentPrefabFeature({
      component: grassland,
      id: "feature-grassland",
      layerId: "layer-main",
      anchor: { x: 800, y: 500 },
      canvas: { width: 1_600, height: 1_000 },
    });
    expect(feature.kind).toBe("area");
    expect(feature.points.length).toBeGreaterThanOrEqual(3);
  });

  it("提供宇宙、地貌、生态、水系、文明和地标构件", () => {
    expect(MAP_COMPONENT_PRESETS.length).toBeGreaterThanOrEqual(45);
    expect(mapComponentsInCategory("celestial")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "planet" })]),
    );
    expect(mapComponentsInCategory("landmark")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "secret-realm" }),
        expect.objectContaining({ id: "cave" }),
        expect.objectContaining({ id: "obelisk" }),
      ]),
    );
    expect(mapComponentsInCategory("mountain")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "snow-peak" }),
        expect.objectContaining({ id: "foothills" }),
        expect.objectContaining({ id: "cliff" }),
        expect.objectContaining({ id: "dunes" }),
        expect.objectContaining({ id: "glacier" }),
        expect.objectContaining({ id: "boulder-field" }),
      ]),
    );
    expect(mapComponentsInCategory("vegetation")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "broadleaf-grove" }),
        expect.objectContaining({ id: "bamboo-grove" }),
        expect.objectContaining({ id: "shrubland" }),
      ]),
    );
    expect(mapComponentsInCategory("water")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "delta" }),
        expect.objectContaining({ id: "rapids" }),
        expect.objectContaining({ id: "coral-reef" }),
        expect.objectContaining({ id: "seaweed-bed" }),
        expect.objectContaining({ id: "sea-foam" }),
      ]),
    );
    expect(mapComponentsInCategory("civilization")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "village" }),
        expect.objectContaining({ id: "port" }),
        expect.objectContaining({ id: "bridge" }),
        expect.objectContaining({ id: "road" }),
        expect.objectContaining({ id: "wall" }),
        expect.objectContaining({ id: "farmland" }),
        expect.objectContaining({ id: "terraces" }),
        expect.objectContaining({ id: "shipyard" }),
      ]),
    );
  });

  it("按构件职责把连续素材、水域区域和路径分别落为对应事实", () => {
    const cliff = MAP_COMPONENT_PRESETS.find((item) => item.id === "cliff")!;
    const delta = MAP_COMPONENT_PRESETS.find((item) => item.id === "delta")!;
    const rapids = MAP_COMPONENT_PRESETS.find((item) => item.id === "rapids")!;
    const canvas = { width: 1_600, height: 1_000 };

    expect(mapComponentPlacement(cliff)).toBe("stamp");
    expect(mapComponentPlacement(delta)).toBe("terrain-prefab");
    expect(mapComponentPlacement(rapids)).toBe("path");

    const deltaRegions = createMapComponentPrefabRegions({
      component: delta,
      id: "region-delta",
      layerId: "scene-water",
      anchor: { x: 800, y: 500 },
      canvas,
    });
    expect(deltaRegions).toHaveLength(1);
    expect(deltaRegions[0]).toMatchObject({
      kind: "water",
      texture: "water-ripple",
      edgeColor: "#376c7c",
    });
    expect(deltaRegions[0]?.points.length).toBeGreaterThanOrEqual(8);

    expect(
      createMapComponentPrefabFeature({
        component: rapids,
        id: "feature-rapids",
        layerId: "layer-main",
        anchor: { x: 800, y: 500 },
        canvas,
      }),
    ).toMatchObject({
      kind: "route",
      props: { terrain: "rapids", sourceWidth: "3", mouthWidth: "7" },
    });
  });

  it("将构件转换为保留现有地图要素契约的可保存要素", () => {
    const river = MAP_COMPONENT_PRESETS.find((item) => item.id === "river")!;
    const feature = createMapComponentPrefabFeature({
      component: river,
      id: "feature-river",
      layerId: "layer-main",
      anchor: { x: 800, y: 500 },
      canvas: { width: 1600, height: 1000 },
    });

    expect(feature).toMatchObject({
      id: "feature-river",
      kind: "route",
      layerId: "layer-main",
      props: {
        component: "river",
        terrain: "river",
        lineWidth: "4",
        sourceWidth: "2",
        mouthWidth: "10",
      },
    });
    expect(feature.points.length).toBeGreaterThan(2);
    expect(
      new Set(feature.points.map((point) => `${point.x},${point.y}`)).size,
    ).toBeGreaterThan(2);
  });

  it("默认羊皮纸背景可切换为宇宙星空预设", () => {
    const document = createEmptyMapDocument({
      id: "map-background",
      name: "星海",
      projectionType: "planet",
      createdAt: "2026-08-15T00:00:00.000Z",
    });
    expect(document.canvas.backgroundPreset).toBe("parchment");

    const starfield = getMapBackgroundPreset("starfield");
    expect(starfield.name).toBe("宇宙星空");
    expect(
      mapCanvasBackgroundStyle({
        ...document.canvas,
        backgroundPreset: "starfield",
        backgroundColor: starfield.color,
      }).backgroundImage,
    ).toContain("radial-gradient");
  });

  it("拖拽路径预制件会按起终点缩放并旋转，而不是固定尺寸落点", () => {
    const river = MAP_COMPONENT_PRESETS.find((item) => item.id === "river")!;
    const feature = createMapComponentPrefabFeature({
      component: river,
      id: "feature-drag-river",
      layerId: "layer-main",
      anchor: { x: 600, y: 400 },
      canvas: { width: 1600, height: 1000 },
      gesture: {
        start: { x: 200, y: 400 },
        end: { x: 1000, y: 400 },
      },
    });

    const xs = feature.points.map((point) => point.x);
    expect(Math.min(...xs)).toBe(200);
    expect(Math.max(...xs)).toBe(1000);
    expect(
      new Set(feature.points.map((point) => point.y)).size,
    ).toBeGreaterThan(1);
  });

  it("道路和城墙预制件保留路线样式事实", () => {
    const wall = MAP_COMPONENT_PRESETS.find((item) => item.id === "wall")!;
    const feature = createMapComponentPrefabFeature({
      component: wall,
      id: "feature-wall",
      layerId: "layer-main",
      anchor: { x: 800, y: 500 },
      canvas: { width: 1600, height: 1000 },
    });

    expect(feature).toMatchObject({
      kind: "route",
      props: {
        terrain: "wall",
        routeStyle: "wall",
        routeWidth: "10",
        routeColor: "#a59780",
      },
    });
  });

  it("按构件职责将海陆、路线和成品素材落为各自唯一的可编辑事实", () => {
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const river = MAP_COMPONENT_PRESETS.find((item) => item.id === "river")!;
    const mountains = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "mountain-range",
    )!;

    expect(mapComponentPlacement(continent)).toBe("terrain-prefab");
    expect(mapComponentPlacement(river)).toBe("path");
    expect(mapComponentPlacement(mountains)).toBe("stamp");
    expect(mapComponentInteraction(mountains)).toBe("scatter");
    expect(mountains.followsPath).toBe(true);
  });

  it("山脉脊线和村落都支持素材笔刷，并保留准星印章入口", () => {
    for (const componentId of ["mountain-range", "village"]) {
      const component = MAP_COMPONENT_PRESETS.find(
        (item) => item.id === componentId,
      )!;
      expect(component.interaction).toBe("scatter");
      expect(mapComponentPlacement(component)).toBe("stamp");
    }
  });

  it("大陆和群岛预制件直接落为可编辑的海陆区域", () => {
    const canvas = { width: 1600, height: 1000 };
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const archipelago = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "archipelago",
    )!;
    const regions = createMapComponentPrefabRegions({
      component: continent,
      id: "region-continent",
      layerId: "scene-terrain",
      anchor: { x: 800, y: 500 },
      canvas,
    });
    const islands = createMapComponentPrefabRegions({
      component: archipelago,
      id: "region-archipelago",
      layerId: "scene-terrain",
      anchor: { x: 800, y: 500 },
      canvas,
    });

    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      kind: "land",
      texture: "paper-land",
      edgeWidth: 3,
    });
    expect(regions[0]?.points.length).toBeGreaterThan(8);
    expect(islands).toHaveLength(7);
    expect(islands.every((region) => region.points.length >= 3)).toBe(true);
  });

  it("大陆板块与水域各提供 20 个独立轮廓预设，并共用卡片预览几何", () => {
    const canvas = { width: 1_600, height: 1_000 };
    const categories = [
      ["landmass", "land"],
      ["water", "water"],
    ] as const;

    for (const [category, kind] of categories) {
      const presets = mapComponentsInCategory(category).filter(
        (component) => component.terrainPrefab,
      );
      expect(presets, category).toHaveLength(20);
      expect(
        new Set(presets.map((component) => component.terrainPrefab?.shape)).size,
        category,
      ).toBe(20);

      for (const component of presets) {
        const regions = createMapComponentPrefabRegions({
          component,
          id: `preset-${component.id}`,
          layerId: kind === "land" ? "scene-terrain" : "scene-water",
          anchor: { x: 800, y: 500 },
          canvas,
        });
        expect(regions.length, component.id).toBeGreaterThan(0);
        expect(regions.every((region) => region.kind === kind), component.id).toBe(
          true,
        );
        expect(getMapComponentTerrainPreviewShapes(component.id).length, component.id).toBeGreaterThan(0);
      }
    }
  });

  it("大陆和群岛使用稳定但不规则的海岸线，而不是重复的规则多边形", () => {
    const canvas = { width: 1_600, height: 1_000 };
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const archipelago = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "archipelago",
    )!;
    const input = {
      component: continent,
      id: "region-organic-coast",
      layerId: "scene-terrain",
      anchor: { x: 800, y: 500 },
      canvas,
    } as const;
    const first = createMapComponentPrefabRegions(input);
    const repeated = createMapComponentPrefabRegions(input);
    const alternate = createMapComponentPrefabRegions({
      ...input,
      id: "region-organic-coast-alternate",
    });
    const islands = createMapComponentPrefabRegions({
      component: archipelago,
      id: "region-organic-archipelago",
      layerId: "scene-terrain",
      anchor: { x: 800, y: 500 },
      canvas,
    });

    expect(first[0]?.points).toHaveLength(64);
    expect(repeated[0]?.points).toEqual(first[0]?.points);
    expect(alternate[0]?.points).not.toEqual(first[0]?.points);
    expect(islands.every((region) => region.points.length === 40)).toBe(true);
    expect(
      new Set(islands.map((region) => JSON.stringify(region.points))).size,
    ).toBeGreaterThan(1);
  });

  it("拖拽大陆预制件会沿手势方向生成更大的可编辑区域", () => {
    const canvas = { width: 1600, height: 1000 };
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const regions = createMapComponentPrefabRegions({
      component: continent,
      id: "region-drag-continent",
      layerId: "scene-terrain",
      anchor: { x: 800, y: 500 },
      canvas,
      gesture: {
        start: { x: 260, y: 480 },
        end: { x: 1340, y: 480 },
      },
    });
    const points = regions[0]?.points ?? [];
    expect(Math.min(...points.map((point) => point.x))).toBe(260);
    expect(Math.max(...points.map((point) => point.x))).toBe(1340);
  });

  it("靠近右下边缘放置大陆时保留完整轮廓，交由画布边界扩展", () => {
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const regions = createMapComponentPrefabRegions({
      component: continent,
      id: "region-edge-continent",
      layerId: "scene-terrain",
      anchor: { x: 1_570, y: 970 },
      canvas: { width: 1_600, height: 1_000 },
    });

    const points = regions.flatMap((region) => region.points);
    expect(Math.max(...points.map((point) => point.x))).toBeGreaterThan(1_600);
    expect(Math.max(...points.map((point) => point.y))).toBeGreaterThan(1_000);
  });

  it("靠近左上边缘放置大陆时保留负向轮廓，交由画布统一重定位", () => {
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const regions = createMapComponentPrefabRegions({
      component: continent,
      id: "region-northwest-continent",
      layerId: "scene-terrain",
      anchor: { x: 40, y: 30 },
      canvas: { width: 1_600, height: 1_000 },
    });

    const points = regions.flatMap((region) => region.points);
    expect(Math.min(...points.map((point) => point.x))).toBeLessThan(0);
    expect(Math.min(...points.map((point) => point.y))).toBeLessThan(0);
  });
});
