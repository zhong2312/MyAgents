import { describe, expect, it, vi } from "vitest";

import { createEmptyMapDocument } from "../entities/mapSchema";
import MapSceneCanvas from "./MapSceneCanvas";
import OpenLayersMapCanvas, {
  type OpenLayersMapCanvasProps,
} from "./OpenLayersMapCanvas";

function props(): OpenLayersMapCanvasProps {
  return {
    document: createEmptyMapDocument({
      id: "map-openlayers-entry",
      name: "地理入口测试",
      projectionType: "continent",
      createdAt: "2026-08-16T00:00:00.000Z",
    }),
    tool: "select",
    activeLayerId: "layer-main",
    selectedFeatureId: null,
    timelineCursor: null,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onComponentDrop: vi.fn(),
    onSceneStroke: vi.fn(),
    onSceneErase: vi.fn(),
    onTerrainStroke: vi.fn(),
    onTerrainMaterialStroke: vi.fn(),
    onSceneStrokeMove: vi.fn(),
    onSceneRegionCreate: vi.fn(),
    onSceneRegionMove: vi.fn(),
    onArtworkStampMove: vi.fn(),
    onArtworkStampTransform: vi.fn(),
    onArtworkStampPlace: vi.fn(),
    onGeometryChange: vi.fn(),
  };
}

describe("OpenLayersMapCanvas", () => {
  it("将地理地图委托给完整的场景编辑表面，不降级为旧要素画布", () => {
    const input = props();
    const element = OpenLayersMapCanvas(input);

    expect(element.type).toBe(MapSceneCanvas);
    expect(element.props).toEqual(input);
  });
});
