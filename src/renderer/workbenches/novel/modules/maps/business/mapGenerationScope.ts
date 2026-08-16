import type {
  SettingLibraryMeta,
  SettingLibrarySpatialTree,
} from "../../../settingLibrarySchema";

export type MapGenerationScopeLibrary = {
  readonly meta: Pick<SettingLibraryMeta, "levelTypes">;
  readonly spatialTree: Pick<SettingLibrarySpatialTree, "nodes">;
};

const MAP_GENERATION_KINDS = new Set([
  "planet-point",
  "geographic-area",
  "settlement-point",
]);

/**
 * 返回所选范围本身及其后代可作为地图生成目标的层级类型。
 *
 * 作者可以直接选择叶子大陆、国家或行星；因此不能只检查后代节点。
 * 当空项目只有世界根、尚未建立任何可绘制空间时，允许从全部可用层级中
 * 创建第一张候选地图。空间树一旦存在实际可绘制节点，范围就严格限定在
 * 所选节点及其后代；层级类型顺序仍由元数据定义，保证选择器稳定。
 */
export function mapGenerationLevelIds(
  library: MapGenerationScopeLibrary,
  worldNodeId: string,
): readonly string[] {
  const selected = library.spatialTree.nodes.find(
    (node) => node.id === worldNodeId,
  );
  if (!selected) return [];

  const childrenByParent = new Map<string, string[]>();
  library.spatialTree.nodes.forEach((node) => {
    if (!node.parentId) return;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node.id);
    childrenByParent.set(node.parentId, children);
  });

  const coveredNodeIds = new Set([selected.id]);
  const pending = [...(childrenByParent.get(selected.id) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (coveredNodeIds.has(id)) continue;
    coveredNodeIds.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }

  const coveredTypeIds = new Set(
    library.spatialTree.nodes
      .filter((node) => coveredNodeIds.has(node.id))
      .map((node) => node.typeId),
  );
  const supportedTypes = library.meta.levelTypes.filter(
    (type) => MAP_GENERATION_KINDS.has(type.mapKind) && !type.archived,
  );
  const inScope = supportedTypes.filter((type) => coveredTypeIds.has(type.id));
  return (inScope.length > 0 ? inScope : supportedTypes).map((type) => type.id);
}
