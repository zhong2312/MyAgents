import type { MapDocument, MapScenePoint } from "../entities/mapSchema";

type EditableLayer = {
  readonly visible: boolean;
  readonly locked: boolean;
};

export type MapSelectableItemsDuplication = {
  readonly map: MapDocument;
  /** 按地图事实顺序返回的副本 id；用于把副本设为新的临时选区。 */
  readonly duplicatedIds: readonly string[];
};

function isEditableLayer(layer: EditableLayer | undefined): boolean {
  return Boolean(layer?.visible && !layer.locked);
}

/**
 * 框选对象限定为普通地图要素和独立素材印章。海陆区域与连续笔触属于场景
 * 合成底稿，继续使用其单件编辑协议，避免批量平移破坏地形语义。
 */
export function isEditableMapSelectableItem(
  map: MapDocument,
  id: string,
): boolean {
  const feature = map.features.find((item) => item.id === id);
  if (feature) {
    return isEditableLayer(
      map.layers.find((layer) => layer.id === feature.layerId),
    );
  }
  return isEditableLayer(
    map.artwork.layers.find((layer) =>
      layer.stamps.some((stamp) => stamp.id === id),
    ),
  );
}

export function canEditMapSelectableItems(
  map: MapDocument,
  itemIds: readonly string[],
): boolean {
  const ids = [...new Set(itemIds)];
  return (
    ids.length > 0 && ids.every((id) => isEditableMapSelectableItem(map, id))
  );
}

/** 一次性平移选区，调用者负责把这次操作写入单个撤销历史节点。 */
export function moveMapSelectableItems(
  map: MapDocument,
  itemIds: readonly string[],
  delta: MapScenePoint,
): MapDocument {
  const ids = new Set(itemIds);
  if (ids.size === 0 || (delta.x === 0 && delta.y === 0)) return map;
  return {
    ...map,
    features: map.features.map((feature) =>
      ids.has(feature.id)
        ? {
            ...feature,
            points: feature.points.map((point) => ({
              x: point.x + delta.x,
              y: point.y + delta.y,
            })),
          }
        : feature,
    ),
    artwork: {
      ...map.artwork,
      layers: map.artwork.layers.map((layer) => ({
        ...layer,
        stamps: layer.stamps.map((stamp) =>
          ids.has(stamp.id)
            ? {
                ...stamp,
                x: stamp.x + delta.x,
                y: stamp.y + delta.y,
              }
            : stamp,
        ),
      })),
    },
  };
}

function nextDuplicateId(sourceId: string, occupiedIds: Set<string>): string {
  const base = `${sourceId}-copy`;
  let candidate = base;
  let suffix = 2;
  while (occupiedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  occupiedIds.add(candidate);
  return candidate;
}

/**
 * 复制可独立变换的选区。副本保留所属图层与全部样式事实，只平移一个固定
 * 偏移量以便立即可见；地形区域和连续笔触仍遵守其单件编辑协议。
 */
export function duplicateMapSelectableItems(
  map: MapDocument,
  itemIds: readonly string[],
  offset: MapScenePoint = { x: 18, y: 18 },
): MapSelectableItemsDuplication {
  const selectedIds = new Set(itemIds);
  if (selectedIds.size === 0) return { map, duplicatedIds: [] };

  const occupiedIds = new Set([
    ...map.features.map((feature) => feature.id),
    ...map.artwork.layers.flatMap((layer) =>
      layer.stamps.map((stamp) => stamp.id),
    ),
  ]);
  const duplicatedIdsBySourceId = new Map<string, string>();
  for (const feature of map.features) {
    if (selectedIds.has(feature.id)) {
      duplicatedIdsBySourceId.set(
        feature.id,
        nextDuplicateId(feature.id, occupiedIds),
      );
    }
  }
  for (const layer of map.artwork.layers) {
    for (const stamp of layer.stamps) {
      if (selectedIds.has(stamp.id)) {
        duplicatedIdsBySourceId.set(
          stamp.id,
          nextDuplicateId(stamp.id, occupiedIds),
        );
      }
    }
  }
  if (duplicatedIdsBySourceId.size === 0) {
    return { map, duplicatedIds: [] };
  }

  const duplicateFeature = (feature: MapDocument["features"][number]) => {
    const duplicateId = duplicatedIdsBySourceId.get(feature.id);
    if (!duplicateId) return [feature];
    return [
      feature,
      {
        ...feature,
        id: duplicateId,
        name: `${feature.name} 副本`,
        entityRef: feature.entityRef ? { ...feature.entityRef } : null,
        points: feature.points.map((point) => ({
          x: point.x + offset.x,
          y: point.y + offset.y,
        })),
        props: { ...feature.props },
      },
    ];
  };

  const duplicateStamp = (
    stamp: MapDocument["artwork"]["layers"][number]["stamps"][number],
  ) => {
    const duplicateId = duplicatedIdsBySourceId.get(stamp.id);
    if (!duplicateId) return [stamp];
    return [
      stamp,
      {
        ...stamp,
        id: duplicateId,
        x: stamp.x + offset.x,
        y: stamp.y + offset.y,
      },
    ];
  };

  return {
    map: {
      ...map,
      features: map.features.flatMap(duplicateFeature),
      artwork: {
        ...map.artwork,
        layers: map.artwork.layers.map((layer) => ({
          ...layer,
          stamps: layer.stamps.flatMap(duplicateStamp),
        })),
      },
    },
    duplicatedIds: [...duplicatedIdsBySourceId.values()],
  };
}

/** 一次性删除选区；拓扑图使用其独立的级联删除协议，不走此函数。 */
export function removeMapSelectableItems(
  map: MapDocument,
  itemIds: readonly string[],
): MapDocument {
  const ids = new Set(itemIds);
  if (ids.size === 0) return map;
  return {
    ...map,
    features: map.features.filter((feature) => !ids.has(feature.id)),
    artwork: {
      ...map.artwork,
      layers: map.artwork.layers.map((layer) => ({
        ...layer,
        stamps: layer.stamps.filter((stamp) => !ids.has(stamp.id)),
      })),
    },
  };
}
