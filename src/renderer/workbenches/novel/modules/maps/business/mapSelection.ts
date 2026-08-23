import type {
  MapDocument,
  MapObjectGroup,
  MapSceneRegion,
  MapScenePoint,
  MapSceneStroke,
} from "../entities/mapSchema";

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

/** 返回成员所属的持久组合；组合不允许嵌套，因此每个对象最多命中一个。 */
export function findMapSelectableGroup(
  map: MapDocument,
  itemId: string,
): MapObjectGroup | undefined {
  return map.groups?.find((group) => group.itemIds.includes(itemId));
}

/**
 * 将任意成员选择展开为完整组合。调用方仍只保存对象 id，不把“组合”伪装成
 * 另一种渲染对象，所有几何继续由原对象持有。
 */
export function expandMapSelectableItemIds(
  map: MapDocument,
  itemIds: readonly string[],
): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  itemIds.forEach((itemId) => {
    const group = findMapSelectableGroup(map, itemId);
    (group?.itemIds ?? [itemId]).forEach((candidateId) => {
      if (seen.has(candidateId)) return;
      seen.add(candidateId);
      result.push(candidateId);
    });
  });
  return result;
}

/** 仅当选区完整等于一个组合时，画布才应隐藏成员级变换手柄。 */
export function isMapSelectableGroupSelection(
  map: MapDocument,
  itemIds: readonly string[],
): boolean {
  const selectedIds = new Set(itemIds);
  return Boolean(
    selectedIds.size > 1 &&
      map.groups?.some(
        (group) =>
          group.itemIds.length === selectedIds.size &&
          group.itemIds.every((itemId) => selectedIds.has(itemId)),
      ),
  );
}

/**
 * 把当前选区固定为一个组合。若选区包含旧组合成员，旧组合会被合并或解散，
 * 以维持“一个对象只能属于一个组合”的文档契约。
 */
export function createMapSelectableGroup(
  map: MapDocument,
  input: {
    readonly id: string;
    readonly name?: string;
    readonly itemIds: readonly string[];
  },
): MapDocument {
  const itemIds = expandMapSelectableItemIds(map, input.itemIds);
  const existingItemIds = new Set<string>([
    ...map.features.map((feature) => feature.id),
    ...map.artwork.layers.flatMap((layer) =>
      layer.stamps.map((stamp) => stamp.id),
    ),
    ...(map.scene?.layers.flatMap((layer) => [
      ...layer.strokes.map((stroke) => stroke.id),
      ...layer.regions.map((region) => region.id),
    ]) ?? []),
  ]);
  const validItemIds = itemIds.filter((itemId) => existingItemIds.has(itemId));
  if (validItemIds.length < 2) return map;

  const groupedIds = new Set(validItemIds);
  const groups = (map.groups ?? [])
    .filter((group) => group.id !== input.id)
    .map((group) => ({
      ...group,
      itemIds: group.itemIds.filter((itemId) => !groupedIds.has(itemId)),
    }))
    .filter((group) => group.itemIds.length >= 2);
  return {
    ...map,
    groups: [
      ...groups,
      {
        id: input.id,
        name: input.name?.trim() || "组合",
        itemIds: validItemIds,
      },
    ],
  };
}

/** 解除组合只移除组合引用，不改写成员的图层、几何和样式。 */
export function ungroupMapSelectableItems(
  map: MapDocument,
  groupId: string,
): MapDocument {
  if (!map.groups?.some((group) => group.id === groupId)) return map;
  return {
    ...map,
    groups: map.groups.filter((group) => group.id !== groupId),
  };
}

/**
 * 地理画布的多选包含普通要素、独立素材印章和场景内容。场景笔触/区域
 * 仍然保持各自的矢量事实，只把一次平移作为同一个事务提交，避免材质
 * 覆盖层与底层陆地被迫分开移动。
 */
export function isEditableMapSelectableItem(
  map: MapDocument,
  id: string,
): boolean {
  if (isMapSelectableItemLocked(map, id)) return false;
  const feature = map.features.find((item) => item.id === id);
  if (feature) {
    return isEditableLayer(
      map.layers.find((layer) => layer.id === feature.layerId),
    );
  }
  const artworkLayer = map.artwork.layers.find((layer) =>
    layer.stamps.some((stamp) => stamp.id === id),
  );
  if (artworkLayer) return isEditableLayer(artworkLayer);
  for (const layer of map.scene?.layers ?? []) {
    if (
      layer.strokes.some((stroke) => stroke.id === id) ||
      layer.regions.some((region) => region.id === id)
    ) {
      return isEditableLayer(layer);
    }
  }
  return false;
}

/**
 * 统一读取画布对象的锁定状态。拓扑节点早期把状态写在 props.locked，
 * 普通地理对象则使用对象级字段；两种格式都必须在选择层得到相同语义。
 */
export function isMapSelectableItemLocked(
  map: MapDocument,
  id: string,
): boolean {
  const feature = map.features.find((item) => item.id === id);
  if (feature) {
    return feature.locked === true || feature.props.locked === "true";
  }
  const artworkLayer = map.artwork.layers.find((layer) =>
    layer.stamps.some((stamp) => stamp.id === id),
  );
  if (artworkLayer) {
    return (
      artworkLayer.stamps.find((stamp) => stamp.id === id)?.locked === true
    );
  }
  for (const layer of map.scene?.layers ?? []) {
    const stroke = layer.strokes.find((candidate) => candidate.id === id);
    if (stroke) return stroke.locked === true;
    const region = layer.regions.find((candidate) => candidate.id === id);
    if (region) {
      if (region.locked === true) return true;
      const source = region.sourceFeatureId
        ? map.features.find(
            (candidate) => candidate.id === region.sourceFeatureId,
          )
        : undefined;
      return Boolean(
        source && (source.locked === true || source.props.locked === "true"),
      );
    }
  }
  return false;
}

/** 一次性修改对象级锁定状态，图层锁定状态保持不变。 */
export function setMapSelectableItemsLocked(
  map: MapDocument,
  itemIds: readonly string[],
  locked: boolean,
): MapDocument {
  const ids = new Set(expandMapSelectableItemIds(map, itemIds));
  if (ids.size === 0) return map;
  let changed = false;
  const features = map.features.map((feature) => {
    if (!ids.has(feature.id) || feature.locked === locked) return feature;
    changed = true;
    return { ...feature, locked };
  });
  const artwork = {
    ...map.artwork,
    layers: map.artwork.layers.map((layer) => ({
      ...layer,
      stamps: layer.stamps.map((stamp) => {
        if (!ids.has(stamp.id) || stamp.locked === locked) return stamp;
        changed = true;
        return { ...stamp, locked };
      }),
    })),
  };
  const scene = map.scene
    ? {
        ...map.scene,
        layers: map.scene.layers.map((layer) => ({
          ...layer,
          strokes: layer.strokes.map((stroke) => {
            if (!ids.has(stroke.id) || stroke.locked === locked) return stroke;
            changed = true;
            return { ...stroke, locked };
          }),
          regions: layer.regions.map((region) => {
            const sourceSelected = Boolean(
              region.sourceFeatureId && ids.has(region.sourceFeatureId),
            );
            if (
              (!ids.has(region.id) && !sourceSelected) ||
              region.locked === locked
            ) {
              return region;
            }
            changed = true;
            return { ...region, locked };
          }),
        })),
      }
    : map.scene;
  return changed ? { ...map, features, artwork, scene } : map;
}

export function canEditMapSelectableItems(
  map: MapDocument,
  itemIds: readonly string[],
): boolean {
  const ids = expandMapSelectableItemIds(map, itemIds);
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
  const ids = new Set(expandMapSelectableItemIds(map, itemIds));
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
    scene: map.scene
      ? {
          ...map.scene,
          layers: map.scene.layers.map((layer) => ({
            ...layer,
            strokes: layer.strokes.map((stroke) =>
              ids.has(stroke.id)
                ? {
                    ...stroke,
                    points: stroke.points.map((point) => ({
                      x: point.x + delta.x,
                      y: point.y + delta.y,
                    })),
                  }
                : stroke,
            ),
            regions: layer.regions.map((region) =>
              ids.has(region.id)
                ? {
                    ...region,
                    points: region.points.map((point) => ({
                      x: point.x + delta.x,
                      y: point.y + delta.y,
                    })),
                  }
                : region.sourceFeatureId && ids.has(region.sourceFeatureId)
                  ? {
                      ...region,
                      points: region.points.map((point) => ({
                        x: point.x + delta.x,
                        y: point.y + delta.y,
                      })),
                    }
                  : region,
            ),
          })),
        }
      : map.scene,
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
 * 偏移量以便立即可见；普通要素、素材印章、场景笔触和场景区域共用同一
 * 复制事务，避免 Ctrl+C/Ctrl+V 对不同画布内容产生不一致行为。
 */
export function duplicateMapSelectableItems(
  map: MapDocument,
  itemIds: readonly string[],
  offset: MapScenePoint = { x: 18, y: 18 },
): MapSelectableItemsDuplication {
  const selectedIds = new Set(expandMapSelectableItemIds(map, itemIds));
  if (selectedIds.size === 0) return { map, duplicatedIds: [] };

  // 海陆场景区域是来源 Feature 的可见投影。复制来源时必须把投影一起
  // 带走并在下面改绑到副本，否则 `sceneSurface` 要素会变成不可见事实。
  for (const layer of map.scene?.layers ?? []) {
    for (const region of layer.regions) {
      if (region.sourceFeatureId && selectedIds.has(region.sourceFeatureId)) {
        selectedIds.add(region.id);
      }
    }
  }

  const occupiedIds = new Set([
    ...map.features.map((feature) => feature.id),
    ...map.artwork.layers.flatMap((layer) =>
      layer.stamps.map((stamp) => stamp.id),
    ),
    ...(map.scene?.layers.flatMap((layer) => [
      ...layer.strokes.map((stroke) => stroke.id),
      ...layer.regions.map((region) => region.id),
    ]) ?? []),
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
  for (const layer of map.scene?.layers ?? []) {
    for (const stroke of layer.strokes) {
      if (selectedIds.has(stroke.id)) {
        duplicatedIdsBySourceId.set(
          stroke.id,
          nextDuplicateId(stroke.id, occupiedIds),
        );
      }
    }
    for (const region of layer.regions) {
      if (selectedIds.has(region.id)) {
        duplicatedIdsBySourceId.set(
          region.id,
          nextDuplicateId(region.id, occupiedIds),
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

  const duplicateStroke = (stroke: MapSceneStroke) => {
    const duplicateId = duplicatedIdsBySourceId.get(stroke.id);
    if (!duplicateId) return [stroke];
    return [
      stroke,
      {
        ...stroke,
        id: duplicateId,
        points: stroke.points.map((point) => ({
          x: point.x + offset.x,
          y: point.y + offset.y,
        })),
      },
    ];
  };

  const duplicateRegion = (region: MapSceneRegion) => {
    const duplicateId = duplicatedIdsBySourceId.get(region.id);
    if (!duplicateId) return [region];
    const duplicateSourceFeatureId = region.sourceFeatureId
      ? duplicatedIdsBySourceId.get(region.sourceFeatureId)
      : undefined;
    return [
      region,
      {
        ...region,
        id: duplicateId,
        ...(duplicateSourceFeatureId
          ? { sourceFeatureId: duplicateSourceFeatureId }
          : { sourceFeatureId: undefined }),
        points: region.points.map((point) => ({
          x: point.x + offset.x,
          y: point.y + offset.y,
        })),
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
      scene: map.scene
        ? {
            ...map.scene,
            layers: map.scene.layers.map((layer) => ({
              ...layer,
              strokes: layer.strokes.flatMap(duplicateStroke),
              regions: layer.regions.flatMap(duplicateRegion),
            })),
          }
        : map.scene,
    },
    duplicatedIds: [...duplicatedIdsBySourceId.values()],
  };
}

/** 一次性删除选区；拓扑图使用其独立的级联删除协议，不走此函数。 */
export function removeMapSelectableItems(
  map: MapDocument,
  itemIds: readonly string[],
): MapDocument {
  const ids = new Set(expandMapSelectableItemIds(map, itemIds));
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
    scene: map.scene
      ? {
          ...map.scene,
          layers: map.scene.layers.map((layer) => ({
            ...layer,
            strokes: layer.strokes.filter((stroke) => !ids.has(stroke.id)),
            regions: layer.regions.filter(
              (region) =>
                !ids.has(region.id) &&
                !(region.sourceFeatureId && ids.has(region.sourceFeatureId)),
            ),
          })),
        }
      : map.scene,
    groups: map.groups
      ?.map((group) => ({
        ...group,
        itemIds: group.itemIds.filter((itemId) => !ids.has(itemId)),
      }))
      .filter((group) => group.itemIds.length >= 2),
  };
}
