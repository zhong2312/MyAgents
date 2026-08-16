import { describe, expect, it } from "vitest";

import {
  mapArtworkLayerRenderPhase,
  mapArtworkLayersInPanelOrder,
  mapArtworkLayersInRenderOrder,
} from "./mapArtworkLayerOrder";
import { createEmptyMapArtwork } from "../entities/mapSchema";

describe("mapArtworkLayerOrder", () => {
  it("按素材类型固定接入底稿、场景、要素和前景合成阶段", () => {
    const artwork = {
      ...createEmptyMapArtwork(),
      layers: [
        {
          ...createEmptyMapArtwork().layers[0]!,
          id: "artwork-terrain",
          name: "地貌",
          kind: "terrain" as const,
        },
        {
          ...createEmptyMapArtwork().layers[0]!,
          id: "artwork-forest",
          name: "森林",
          kind: "vegetation" as const,
        },
        {
          ...createEmptyMapArtwork().layers[0]!,
          id: "artwork-cities",
          name: "城镇",
          kind: "stamp" as const,
        },
        {
          ...createEmptyMapArtwork().layers[0]!,
          id: "artwork-labels",
          name: "题字",
          kind: "label" as const,
        },
      ],
    };

    expect(mapArtworkLayerRenderPhase("water")).toBe("base");
    expect(mapArtworkLayerRenderPhase("relief")).toBe("scene");
    expect(
      mapArtworkLayersInRenderOrder(artwork, "scene").map((layer) => layer.id),
    ).toEqual(["artwork-forest"]);
    expect(
      mapArtworkLayersInRenderOrder(artwork, "feature").map(
        (layer) => layer.id,
      ),
    ).toEqual(["artwork-cities"]);
    expect(
      mapArtworkLayersInPanelOrder(artwork).map((layer) => layer.id),
    ).toEqual([
      "artwork-labels",
      "artwork-cities",
      "artwork-forest",
      "artwork-terrain",
    ]);
  });
});
