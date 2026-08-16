import { describe, expect, it } from "vitest";

import {
  buildTopologyElements,
  createTopologyEdgeFeature,
  createTopologyNodeFeature,
  moveTopologyNode,
  removeTopologyFeature,
} from "./topologyMap";
import {
  createEmptyMapDocument,
  mapDocumentSchema,
} from "../entities/mapSchema";
import { expandMapCanvasToContent } from "./mapCanvasBounds";

function topologyDocument() {
  const document = createEmptyMapDocument({
    id: "map-1",
    name: "诸界",
    projectionType: "multiverse",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const left = createTopologyNodeFeature({
    id: "node-left",
    layerId: "layer-main",
    point: { x: 120, y: 180 },
  });
  const right = createTopologyNodeFeature({
    id: "node-right",
    layerId: "layer-main",
    point: { x: 580, y: 340 },
  });
  const edge = createTopologyEdgeFeature({
    id: "route-1",
    layerId: "layer-main",
    connection: { source: left.id, target: right.id },
    document: { ...document, features: [left, right] },
  });
  return { ...document, features: [left, right, edge!] };
}

describe("topologyMap", () => {
  it("把节点和带端点引用的路线映射为 XYFlow 元素", () => {
    const document = topologyDocument();
    const elements = buildTopologyElements(document, null);

    expect(elements.nodes.map((node) => node.id)).toEqual([
      "node-left",
      "node-right",
    ]);
    expect(elements.edges).toMatchObject([
      { id: "route-1", source: "node-left", target: "node-right" },
    ]);
    expect(mapDocumentSchema.parse(document)).toEqual(document);
  });

  it("隐藏图层和时间切片会同时过滤节点与连接", () => {
    const document = topologyDocument();
    const timed = {
      ...document,
      features: document.features.map((feature) => ({
        ...feature,
        timeFrom: 10,
        timeTo: 20,
      })),
    };
    expect(buildTopologyElements(timed, 5)).toEqual({ nodes: [], edges: [] });
    expect(buildTopologyElements(timed, 15).nodes).toHaveLength(2);
    expect(
      buildTopologyElements(
        {
          ...timed,
          layers: timed.layers.map((layer) => ({ ...layer, visible: false })),
        },
        15,
      ),
    ).toEqual({ nodes: [], edges: [] });
  });

  it("拒绝自环和不存在端点", () => {
    const document = topologyDocument();
    expect(
      createTopologyEdgeFeature({
        id: "route-invalid",
        layerId: "layer-main",
        connection: { source: "node-left", target: "node-left" },
        document,
      }),
    ).toBeNull();
    expect(
      createTopologyEdgeFeature({
        id: "route-invalid",
        layerId: "layer-main",
        connection: { source: "node-left", target: "missing" },
        document,
      }),
    ).toBeNull();
  });

  it("移动节点时原子更新关联路线端点", () => {
    const moved = moveTopologyNode(topologyDocument(), "node-left", {
      x: 260,
      y: 280,
    });

    expect(
      moved.features.find((feature) => feature.id === "node-left")?.points,
    ).toEqual([{ x: 260, y: 280 }]);
    expect(
      moved.features.find((feature) => feature.id === "route-1")?.points,
    ).toEqual([
      { x: 260, y: 280 },
      { x: 580, y: 340 },
    ]);
  });

  it("节点移出任意边缘后由统一画布边界扩展并保持连接端点同步", () => {
    const moved = moveTopologyNode(topologyDocument(), "node-left", {
      x: -40,
      y: -20,
    });
    const expanded = expandMapCanvasToContent(moved);

    // 拓扑节点本体、标签和路线默认线宽都会计入内容外沿。
    expect(expanded.canvas).toMatchObject({ width: 1_848, height: 1_230 });
    expect(
      expanded.features.find((feature) => feature.id === "node-left")?.points,
    ).toEqual([{ x: 208, y: 210 }]);
    expect(
      expanded.features.find((feature) => feature.id === "route-1")?.points,
    ).toEqual([
      { x: 208, y: 210 },
      { x: 828, y: 570 },
    ]);
  });

  it("删除节点时清理关联路线", () => {
    const removed = removeTopologyFeature(topologyDocument(), "node-left");
    expect(removed.features.map((feature) => feature.id)).toEqual([
      "node-right",
    ]);
  });
});
