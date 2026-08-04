import type {
  RegionProjection,
  WorldSimulationScenario,
} from "./worldSimulationV2Schema";

export type WorldSimulationScopeRegion = Pick<
  RegionProjection,
  "id" | "parentId" | "connections"
>;

/**
 * 运行前预检、内核调度和模型候选必须使用同一份空间范围，避免父地域
 * 已勾选“包含子地域”时，预检仍把子地域中的主体误判为范围外。
 */
export function resolveWorldSimulationRegionScope(
  regions: readonly WorldSimulationScopeRegion[],
  scope: WorldSimulationScenario["scope"],
): Set<string> {
  if (scope.outsidePolicy === "full" || scope.regionIds.length === 0) {
    return new Set(regions.map((region) => region.id));
  }

  const regionById = new Map(regions.map((region) => [region.id, region]));
  const result = new Set(scope.regionIds);
  if (scope.includeDescendants) {
    let changed = true;
    while (changed) {
      changed = false;
      regions.forEach((region) => {
        if (
          region.parentId &&
          result.has(region.parentId) &&
          !result.has(region.id)
        ) {
          result.add(region.id);
          changed = true;
        }
      });
    }
  }

  for (let depth = 0; depth < scope.adjacencyDepth; depth += 1) {
    const current = [...result];
    current.forEach((regionId) => {
      const region = regionById.get(regionId);
      region?.connections.forEach((connection) => {
        // 包含关系表达地域层级，不是相邻或可传播的边界。
        if (connection.kind === "containment") return;
        if (connection.fromRegionId === regionId) {
          result.add(connection.toRegionId);
        } else if (
          connection.bidirectional &&
          connection.toRegionId === regionId
        ) {
          result.add(connection.fromRegionId);
        }
      });
    });
  }
  return result;
}
