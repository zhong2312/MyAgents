import { describe, expect, it } from "vitest";

import {
  createMapProjectArtworkAsset,
  loadMapProjectArtworkSources,
  mapProjectArtworkDataUrl,
  mapProjectArtworkMimeType,
  mapProjectArtworkPath,
  mapProjectArtworkUsage,
} from "./mapProjectArtwork";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import {
  createEmptyMapArtwork,
  createEmptyMapScene,
} from "../entities/mapSchema";
import { addMapSceneStroke, createMapSceneStroke } from "./mapScene";

describe("mapProjectArtwork", () => {
  it("只接受可由画布稳定读取的栅格素材格式", () => {
    expect(
      mapProjectArtworkMimeType({ name: "forest.webp", type: "", size: 1 }),
    ).toBe("image/webp");
    expect(
      mapProjectArtworkMimeType({
        name: "sketch.svg",
        type: "image/svg+xml",
        size: 1,
      }),
    ).toBeNull();
  });

  it("以地图归属目录保存素材引用，JSON 只保存路径和渲染元数据", () => {
    const asset = createMapProjectArtworkAsset({
      mapId: "the-west",
      id: "asset-pine-pack",
      name: "松林笔刷.png",
      mimeType: "image/png",
      width: 1024,
      height: 768,
    });

    expect(asset).toEqual({
      id: "asset-pine-pack",
      name: "松林笔刷",
      path: "world/maps/assets/the-west/artwork/asset-pine-pack.png",
      mimeType: "image/png",
      width: 1024,
      height: 768,
      brush: true,
    });
    expect(
      mapProjectArtworkPath("the-west", "asset-pine-pack", "image/png"),
    ).toBe(asset.path);
    expect(
      mapProjectArtworkDataUrl(
        "image/png",
        Uint8Array.from([137, 80, 78, 71]).buffer,
      ),
    ).toBe("data:image/png;base64,iVBORw==");
  });

  it("从项目 assets 读取素材字节，而不依赖地图 JSON 中的 data URL", async () => {
    const asset = createMapProjectArtworkAsset({
      mapId: "the-west",
      id: "asset-river-pack",
      name: "河谷",
      mimeType: "image/png",
      width: 32,
      height: 16,
    });
    const storage = new NovelMemoryStorage({});
    await storage.createBinary(
      asset.path,
      Uint8Array.from([137, 80, 78, 71]).buffer,
      { createParents: true },
    );

    await expect(
      loadMapProjectArtworkSources(storage, [asset]),
    ).resolves.toEqual(new Map([[asset.id, "data:image/png;base64,iVBORw=="]]));
  });

  it("分别统计素材印章和连续笔刷引用，作为删除保护的唯一依据", () => {
    const asset = createMapProjectArtworkAsset({
      mapId: "the-west",
      id: "asset-pine-pack",
      name: "松林笔刷.png",
      mimeType: "image/png",
      width: 128,
      height: 64,
    });
    const unused = createMapProjectArtworkAsset({
      mapId: "the-west",
      id: "asset-unused-pack",
      name: "未使用.png",
      mimeType: "image/png",
      width: 64,
      height: 64,
    });
    const artwork = {
      ...createEmptyMapArtwork(),
      assets: [asset, unused],
      layers: [
        {
          ...createEmptyMapArtwork().layers[0]!,
          stamps: [
            {
              id: "stamp-pine",
              layerId: "artwork-stamps",
              assetId: asset.id,
              x: 320,
              y: 180,
              variant: 0,
              scale: 1,
              rotation: 0,
              opacity: 1,
              flipX: false,
              flipY: false,
            },
          ],
        },
      ],
    };
    const scene = addMapSceneStroke(
      createEmptyMapScene(),
      createMapSceneStroke({
        id: "stroke-pine",
        layerId: "scene-vegetation",
        brushAssetId: asset.id,
        points: [{ x: 12, y: 24 }],
        color: "#41775a",
        width: 64,
      }),
    );

    expect(mapProjectArtworkUsage(artwork, scene)).toEqual(
      new Map([
        [asset.id, { stamps: 1, brushStrokes: 1, total: 2 }],
        [unused.id, { stamps: 0, brushStrokes: 0, total: 0 }],
      ]),
    );
  });
});
