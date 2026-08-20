import { describe, expect, it } from "vitest";

import {
  convertAzgaarExportToFeatures,
  selectAzgaarMapDocumentFeatures,
  type AzgaarMapFeature,
} from "./azgaarExportAdapter";

describe("azgaarExportAdapter", () => {
  it("把官方 pack JSON 的 burg、river 和 region 转成候选要素", () => {
    const features = convertAzgaarExportToFeatures({
      width: 1600,
      height: 1000,
      layerId: "layer-main",
      value: {
        pack: {
          burgs: [{ i: 1, name: "云城", x: 100, y: 200 }],
          markers: [],
          rivers: [
            {
              i: 2,
              name: "青河",
              points: [
                [100, 200],
                [300, 400],
              ],
            },
          ],
          routes: [],
        },
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { id: "north", name: "北境", fill: "#aa8844" },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [10, 0],
                  [10, 10],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      },
    });

    expect(features.map((feature) => feature.name)).toEqual([
      "云城",
      "青河",
      "北境",
    ]);
    expect(features.map((feature) => feature.kind)).toEqual([
      "marker",
      "route",
      "area",
    ]);
    expect(features[0]?.points).toEqual([{ x: 100, y: 200 }]);
    expect(features[1]?.points).toEqual([
      { x: 100, y: 200 },
      { x: 300, y: 400 },
    ]);
    expect(
      features.every((feature) =>
        feature.points.every(
          (point) =>
            point.x >= 0 && point.x <= 1600 && point.y >= 0 && point.y <= 1000,
        ),
      ),
    ).toBe(true);
  });

  it("对 GeoJSON 集合使用统一坐标变换，保留要素之间的相对位置", () => {
    const features = convertAzgaarExportToFeatures({
      width: 1_000,
      height: 500,
      layerId: "layer-main",
      value: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "西城" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
          {
            type: "Feature",
            properties: { name: "东城" },
            geometry: { type: "Point", coordinates: [100, 0] },
          },
        ],
      },
    });

    expect(features).toHaveLength(2);
    expect(features[0]?.points[0]?.x).toBeLessThan(
      features[1]?.points[0]?.x ?? 0,
    );
  });

  it("空导出不伪造地图事实", () => {
    expect(
      convertAzgaarExportToFeatures({
        value: {},
        width: 1600,
        height: 1000,
        layerId: "layer-main",
      }),
    ).toEqual([]);
  });

  it("从官方 JSON 的 cells/vertices 重建国家、省份和生物群系边界", () => {
    const features = convertAzgaarExportToFeatures({
      width: 400,
      height: 200,
      layerId: "layer-main",
      value: {
        info: { width: 400, height: 200 },
        pack: {
          cells: [
            { i: 0, v: [0, 1, 4, 3], state: 1, province: 1, biome: 2, f: 0 },
            { i: 1, v: [1, 2, 5, 4], state: 1, province: 1, biome: 2, f: 0 },
            { i: 2, v: [3, 4, 7, 6], state: 2, province: 2, biome: 3, f: 1 },
          ],
          vertices: [
            { i: 0, p: [0, 0] },
            { i: 1, p: [200, 0] },
            { i: 2, p: [400, 0] },
            { i: 3, p: [0, 100] },
            { i: 4, p: [200, 100] },
            { i: 5, p: [400, 100] },
            { i: 6, p: [0, 200] },
            { i: 7, p: [200, 200] },
          ],
          states: [
            { i: 0, name: "海洋" },
            { i: 1, name: "北境", color: "#aa5544" },
            { i: 2, name: "南境", color: "#4477aa" },
          ],
          provinces: [
            { i: 0, name: "海洋" },
            { i: 1, name: "北省", color: "#bb8866" },
            { i: 2, name: "南省", color: "#6688bb" },
          ],
          biomes: [
            { i: 0, name: "海洋" },
            { i: 1, name: "草原" },
            { i: 2, name: "森林", color: "#559955" },
            { i: 3, name: "荒漠", color: "#ccaa55" },
          ],
          features: [
            { i: 0, type: "lake" },
            { i: 1, type: "lake", name: "南湖" },
          ],
        },
      },
    });

    expect(
      features.filter((feature) => feature.props.azgaarLayer === "state"),
    ).toHaveLength(2);
    expect(
      features.filter((feature) => feature.props.azgaarLayer === "province"),
    ).toHaveLength(2);
    expect(
      features.filter((feature) => feature.props.azgaarLayer === "biome"),
    ).toHaveLength(2);
    expect(features.some((feature) => feature.name === "北境")).toBe(true);
    expect(features.every((feature) => feature.points.length >= 1)).toBe(true);
  });

  it("保留世界架构命名对象，并按类型筛选 Full JSON 的细碎编辑要素", () => {
    const feature = (
      id: string,
      name: string,
      layer: "burg" | "river",
      importance: number,
    ): AzgaarMapFeature => ({
      id,
      kind: layer === "burg" ? "marker" : "route",
      name,
      entityRef: null,
      layerId: "layer-main",
      points:
        layer === "burg"
          ? [{ x: importance, y: 0 }]
          : [
              { x: 0, y: 0 },
              { x: importance, y: 0 },
            ],
      timeFrom: null,
      timeTo: null,
      props: {
        azgaarLayer: layer,
        azgaarImportance: String(importance),
      },
      description: "",
    });
    const source = [
      feature("burg-named", "云城", "burg", 1),
      feature("burg-large", "大城", "burg", 100),
      feature("burg-middle", "中城", "burg", 50),
      feature("river-short", "短河", "river", 10),
      feature("river-long", "长河", "river", 100),
    ];

    const selected = selectAzgaarMapDocumentFeatures({
      features: source,
      preserveNames: ["云城"],
      maximumPerLayer: { burg: 1, river: 1 },
    });

    expect(selected.features.map((item) => item.id)).toEqual([
      "burg-named",
      "burg-large",
      "river-long",
    ]);
    expect(selected.sourceCount).toBe(5);
    expect(selected.omittedCount).toBe(2);
    expect(selected.omittedByLayer).toMatchObject({ burg: 1, river: 1 });
  });
});
