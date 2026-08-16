import type { WorkbenchStorage } from "@/workbench-sdk";

import type {
  MapArtwork,
  MapArtworkAssetMimeType,
  MapArtworkProjectAsset,
  MapScene,
} from "../entities/mapSchema";

export const MAP_PROJECT_ARTWORK_MAX_BYTES = 12 * 1024 * 1024;

const MIME_EXTENSION: Readonly<Record<MapArtworkAssetMimeType, string>> =
  Object.freeze({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  });

const EXTENSION_MIME: Readonly<Record<string, MapArtworkAssetMimeType>> =
  Object.freeze({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  });

export type MapProjectArtworkFile = {
  readonly name: string;
  readonly type: string;
  readonly size: number;
};

/** 项目素材在当前地图中的结构化引用统计，供素材库展示和删除保护复用。 */
export type MapProjectArtworkUsage = Readonly<{
  readonly stamps: number;
  readonly brushStrokes: number;
  readonly total: number;
}>;

export function mapProjectArtworkMimeType(
  file: MapProjectArtworkFile,
): MapArtworkAssetMimeType | null {
  if (
    file.type === "image/png" ||
    file.type === "image/jpeg" ||
    file.type === "image/webp"
  ) {
    return file.type;
  }
  const extension = file.name.trim().split(".").at(-1)?.toLocaleLowerCase();
  return extension ? (EXTENSION_MIME[extension] ?? null) : null;
}

export function mapProjectArtworkFileName(name: string): string {
  const normalized = name
    .trim()
    .replace(/\.[^.]+$/u, "")
    .replace(/[<>:"/\\|?*]/gu, "-")
    .replace(/\p{Cc}/gu, "-")
    .replace(/\s+/gu, " ")
    .slice(0, 160)
    .trim();
  return normalized || "未命名素材";
}

export function mapProjectArtworkPath(
  mapId: string,
  assetId: string,
  mimeType: MapArtworkAssetMimeType,
): string {
  return `world/maps/assets/${mapId}/artwork/${assetId}.${MIME_EXTENSION[mimeType]}`;
}

export function createMapProjectArtworkAsset(input: {
  readonly mapId: string;
  readonly id: string;
  readonly name: string;
  readonly mimeType: MapArtworkAssetMimeType;
  readonly width: number;
  readonly height: number;
  readonly brush?: boolean;
}): MapArtworkProjectAsset {
  return {
    id: input.id,
    name: mapProjectArtworkFileName(input.name),
    path: mapProjectArtworkPath(input.mapId, input.id, input.mimeType),
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    brush: input.brush ?? true,
  };
}

/**
 * 只统计已登记的项目素材。内置素材与已丢失的旧引用不会被混进项目素材管理，
 * 因而不会阻止作者清理一个实际未使用的导入文件。
 */
export function mapProjectArtworkUsage(
  artwork: MapArtwork,
  scene: MapScene | undefined,
): ReadonlyMap<string, MapProjectArtworkUsage> {
  const counts = new Map<string, { stamps: number; brushStrokes: number }>(
    artwork.assets.map((asset) => [asset.id, { stamps: 0, brushStrokes: 0 }]),
  );

  for (const layer of artwork.layers) {
    for (const stamp of layer.stamps) {
      const count = counts.get(stamp.assetId);
      if (count) count.stamps += 1;
    }
  }
  for (const layer of scene?.layers ?? []) {
    for (const stroke of layer.strokes) {
      if (!stroke.brushAssetId) continue;
      const count = counts.get(stroke.brushAssetId);
      if (count) count.brushStrokes += 1;
    }
  }

  return new Map(
    [...counts].map(([assetId, count]) => [
      assetId,
      Object.freeze({
        stamps: count.stamps,
        brushStrokes: count.brushStrokes,
        total: count.stamps + count.brushStrokes,
      }),
    ]),
  );
}

function arrayBufferToBase64(content: ArrayBuffer): string {
  const bytes = new Uint8Array(content);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export function mapProjectArtworkDataUrl(
  mimeType: MapArtworkAssetMimeType,
  content: ArrayBuffer,
): string {
  return `data:${mimeType};base64,${arrayBufferToBase64(content)}`;
}

/**
 * 按清单读取项目素材。某个外部文件被作者移动或删除时，只令该素材不可绘制；
 * 其余资产仍可继续使用，保存时也不会把缺失内容错误地补回 JSON。
 */
export async function loadMapProjectArtworkSources(
  storage: WorkbenchStorage,
  assets: readonly MapArtworkProjectAsset[],
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    assets.map(async (asset) => {
      try {
        const content = await storage.readBinary(asset.path);
        return [
          asset.id,
          mapProjectArtworkDataUrl(asset.mimeType, content),
        ] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [string, string] => entry !== null,
    ),
  );
}
