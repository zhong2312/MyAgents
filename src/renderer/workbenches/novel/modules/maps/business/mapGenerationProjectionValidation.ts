import {
  mapGenerationRoleRequiresArtwork,
  type MapGenerationPlan,
} from "../../../../../../shared/workbenches/novel/mapGenerationPlan";
import { artworkComponentForRole } from "../../../../../../shared/workbenches/novel/fantasyMapGenerator";
import type { MapDocument, MapFeature } from "../entities/mapSchema";

type MapPoint = { readonly x: number; readonly y: number };

function featureAnchor(feature: MapFeature): MapPoint {
  if (["marker", "label", "node"].includes(feature.kind)) {
    return feature.points[0]!;
  }
  const totals = feature.points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  return {
    x: totals.x / feature.points.length,
    y: totals.y / feature.points.length,
  };
}

function distanceBetweenPoints(a: MapPoint, b: MapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointToSegmentDistance(
  point: MapPoint,
  start: MapPoint,
  end: MapPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distanceBetweenPoints(point, start);
  const progress = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    ),
  );
  return distanceBetweenPoints(point, {
    x: start.x + dx * progress,
    y: start.y + dy * progress,
  });
}

function pointInPolygon(
  candidate: MapPoint,
  polygon: readonly MapPoint[],
): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const current = polygon[index]!;
    const last = polygon[previous]!;
    const crosses =
      current.y > candidate.y !== last.y > candidate.y &&
      candidate.x <
        ((last.x - current.x) * (candidate.y - current.y)) /
          (last.y - current.y || Number.EPSILON) +
          current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function hasPlanRelation(feature: MapFeature, relationId: string): boolean {
  const raw = feature.props.planRelations;
  if (!raw) return false;
  try {
    const relations: unknown = JSON.parse(raw);
    return Array.isArray(relations) && relations.includes(relationId);
  } catch {
    return false;
  }
}

function relationId(
  relation: MapGenerationPlan["relations"][number],
  index: number,
): string {
  return `${relation.type}:${relation.fromId}:${relation.toId}:${index}`;
}

/**
 * 校验设定驱动地图仍然保持 generationPlan 的可编辑投影契约。
 * 普通手工地图没有 generation 元数据，不受这组约束影响。
 */
export function validateMapGenerationProjection(
  map: MapDocument,
): readonly string[] {
  const plan = map.generation?.plan;
  if (!plan) return [];

  const errors: string[] = [];
  for (const layer of map.scene?.layers ?? []) {
    for (const region of layer.regions) {
      if (!region.id.startsWith("generated-region-")) continue;
      if (!region.sourceFeatureId) {
        errors.push(
          `地图“${map.id}”生成场景区域“${region.id}”缺少来源要素，无法保持编辑同步。`,
        );
        continue;
      }
      const source = map.features.find(
        (feature) => feature.id === region.sourceFeatureId,
      );
      if (!source) {
        errors.push(
          `地图“${map.id}”生成场景区域“${region.id}”引用了不存在的来源要素“${region.sourceFeatureId}”。`,
        );
        continue;
      }
      if (
        source.points.length !== region.points.length ||
        source.points.some(
          (point, index) =>
            point.x !== region.points[index]?.x ||
            point.y !== region.points[index]?.y,
        )
      ) {
        errors.push(
          `地图“${map.id}”生成场景区域“${region.id}”与来源要素“${source.id}”的几何不同步。`,
        );
      }
    }
  }
  const byPlanEntityId = new Map<string, MapFeature>();
  const byPlanTerritoryId = new Map<string, MapFeature>();
  const bySpatialLayerId = new Map<string, MapFeature>();
  const artworkStampsBySource = new Map<string, number>();
  for (const layer of map.artwork.layers) {
    for (const stamp of layer.stamps) {
      if (!stamp.sourceFeatureId) continue;
      artworkStampsBySource.set(
        stamp.sourceFeatureId,
        (artworkStampsBySource.get(stamp.sourceFeatureId) ?? 0) + 1,
      );
      if (
        !map.features.some((feature) => feature.id === stamp.sourceFeatureId)
      ) {
        errors.push(
          "地图“" +
            map.id +
            "”素材印章“" +
            stamp.id +
            "”引用了不存在的来源要素“" +
            stamp.sourceFeatureId +
            "”。",
        );
      }
    }
  }
  for (const feature of map.features) {
    const { planEntityId, planTerritoryId, spatialLayerId, spatialRole } =
      feature.props;
    if (planEntityId) byPlanEntityId.set(planEntityId, feature);
    if (planTerritoryId) byPlanTerritoryId.set(planTerritoryId, feature);
    if (spatialLayerId && spatialRole) {
      bySpatialLayerId.set(spatialLayerId, feature);
    }
  }

  const labeledFeatures = map.features.filter(
    (feature) => feature.props.showLabel !== "false",
  );
  const chineseLabeledCount = labeledFeatures.filter((feature) =>
    /[\u3400-\u9fff]/u.test(feature.name),
  ).length;
  if (
    labeledFeatures.length > 0 &&
    chineseLabeledCount / labeledFeatures.length < 0.8
  ) {
    errors.push(
      `地图“${map.id}”中文标签覆盖率不足：${chineseLabeledCount}/${labeledFeatures.length}，请隐藏或重做非中文标签。`,
    );
  }

  for (const layer of plan.spatialLayers) {
    const feature = bySpatialLayerId.get(layer.id);
    if (!feature) {
      errors.push(
        `地图“${map.id}”规划空间层“${layer.name}”（${layer.id}）未投影为可编辑区域。`,
      );
      continue;
    }
    if (
      !["area", "polygon"].includes(feature.kind) ||
      feature.points.length < 3
    ) {
      errors.push(
        `地图“${map.id}”规划空间层“${layer.name}”缺少可编辑的区域几何。`,
      );
    }
    if (feature.props.component) {
      errors.push(
        `地图“${map.id}”结构空间层“${layer.name}”不应通过 component 伪装成地标素材。`,
      );
    }
  }

  for (const entity of plan.entities) {
    const feature = byPlanEntityId.get(entity.id);
    if (!feature) {
      errors.push(
        `地图“${map.id}”规划实体“${entity.name}”（${entity.id}）未投影为可编辑要素。`,
      );
      continue;
    }
    if (feature.props.spatialLayerId !== (entity.spatialLayerId ?? "")) {
      errors.push(
        `地图“${map.id}”规划实体“${entity.name}”未保持规划空间层“${entity.spatialLayerId ?? "无"}”。`,
      );
    }
    if (feature.points.length === 0) {
      errors.push(
        `地图“${map.id}”重要实体“${entity.name}”没有有效几何，不能完成结果检查。`,
      );
    }
    const expectedComponent = artworkComponentForRole(entity.role);
    const structuralRole = [
      "realm",
      "region",
      "mountain",
      "vein",
      "waterway",
      "lake",
      "biome",
    ].includes(entity.role);
    if (expectedComponent) {
      if (feature.props.component !== expectedComponent) {
        errors.push(
          "地图“" +
            map.id +
            "”规划地标“" +
            entity.name +
            "”必须使用“" +
            expectedComponent +
            "”可编辑素材。",
        );
      }
    } else if (structuralRole && feature.props.component) {
      errors.push(
        "地图“" +
          map.id +
          "”结构实体“" +
          entity.name +
          "”不应通过 component 伪装成地标素材。",
      );
    }
    if (
      mapGenerationRoleRequiresArtwork(entity.role) &&
      (artworkStampsBySource.get(feature.id) ?? 0) === 0
    ) {
      errors.push(
        "地图“" +
          map.id +
          "”规划实体“" +
          entity.name +
          "”缺少可回溯到来源要素的可编辑素材印章。",
      );
    }
    if (entity.role === "waterway" && feature.points.length < 2) {
      errors.push(
        `地图“${map.id}”河流“${entity.name}”缺少源头与河口两个控制点，不能完成流向检查。`,
      );
    }
    if (entity.importance >= 4 && feature.name !== entity.name) {
      errors.push(
        `地图“${map.id}”重要实体“${entity.name}”的地图名称未保持规划名称。`,
      );
    }
  }

  for (const territory of plan.territories ?? []) {
    const feature = byPlanTerritoryId.get(territory.id);
    const factionId = territory.factionRef.id;
    if (!feature) {
      errors.push(
        `地图“${map.id}”势力领地“${territory.name}”（${territory.id}，势力 ${factionId}）未投影为可编辑区域。`,
      );
      continue;
    }
    if (
      !["area", "polygon"].includes(feature.kind) ||
      feature.points.length < 3
    ) {
      errors.push(
        `地图“${map.id}”势力领地“${territory.name}”（势力 ${factionId}）缺少可编辑的区域几何。`,
      );
    }
    if (feature.props.spatialLayerId !== (territory.spatialLayerId ?? "")) {
      errors.push(
        `地图“${map.id}”势力领地“${territory.name}”未保持规划空间层“${territory.spatialLayerId ?? "无"}”。`,
      );
    }
    if (
      feature.entityRef?.kind !== "faction" ||
      feature.entityRef.id !== factionId ||
      feature.props.entityRefKind !== "faction" ||
      feature.props.entityRefId !== factionId
    ) {
      errors.push(
        `地图“${map.id}”势力领地“${territory.name}”未保持势力 faction:${factionId} 的实体引用。`,
      );
    }
    if (feature.name !== territory.name) {
      errors.push(
        `地图“${map.id}”势力领地“${territory.name}”的地图名称未保持规划名称。`,
      );
    }
    if (feature.props.boundaryStyle !== territory.boundaryStyle) {
      errors.push(
        `地图“${map.id}”势力领地“${territory.name}”未保持“${territory.boundaryStyle}”边界样式。`,
      );
    }
  }

  const canvasMinDimension = Math.min(map.canvas.width, map.canvas.height);
  const throughTolerance = Math.max(8, canvasMinDimension * 0.01);
  for (const [index, relation] of plan.relations.entries()) {
    const id = relationId(relation, index);
    const fromFeature =
      byPlanEntityId.get(relation.fromId) ??
      byPlanTerritoryId.get(relation.fromId) ??
      bySpatialLayerId.get(relation.fromId);
    const toFeature =
      byPlanEntityId.get(relation.toId) ??
      byPlanTerritoryId.get(relation.toId) ??
      bySpatialLayerId.get(relation.toId);
    if (!fromFeature || !toFeature) {
      errors.push(
        `地图“${map.id}”空间关系“${relation.description || id}”缺少关系两端的可编辑投影。`,
      );
      continue;
    }
    if (!hasPlanRelation(fromFeature, id) || !hasPlanRelation(toFeature, id)) {
      errors.push(
        `地图“${map.id}”空间关系“${relation.description || id}”未写入关系投影字段。`,
      );
    }

    const sourceAnchor = featureAnchor(fromFeature);
    const targetAnchor = featureAnchor(toFeature);
    if (["connected-to", "separated-by"].includes(relation.type)) {
      const relationFeature = map.features.find(
        (feature) => feature.props.planRelationId === id,
      );
      if (!relationFeature) {
        errors.push(
          `地图“${map.id}”空间关系“${relation.description || id}”缺少可编辑关系路线。`,
        );
      } else if (
        relationFeature.kind !== "route" ||
        relationFeature.points.length < 2 ||
        relationFeature.props.planRelationType !== relation.type ||
        relationFeature.props.planRelationFromId !== relation.fromId ||
        relationFeature.props.planRelationToId !== relation.toId
      ) {
        errors.push(
          `地图“${map.id}”空间关系“${relation.description || id}”的可编辑关系路线契约无效。`,
        );
      } else if (
        distanceBetweenPoints(relationFeature.points[0]!, sourceAnchor) > 1.5 ||
        distanceBetweenPoints(relationFeature.points.at(-1)!, targetAnchor) >
          1.5
      ) {
        errors.push(
          `地图“${map.id}”空间关系“${relation.description || id}”的关系路线未连接规划端点。`,
        );
      }
    }
    if (["located-near", "guards"].includes(relation.type)) {
      const relationTolerance = Math.max(12, canvasMinDimension * 0.04);
      if (
        distanceBetweenPoints(sourceAnchor, targetAnchor) > relationTolerance
      ) {
        errors.push(
          `地图“${map.id}”空间关系“${relation.description || id}”的要素未保持邻近位置。`,
        );
      }
    } else if (["hidden-in", "contains"].includes(relation.type)) {
      if (
        toFeature.points.length >= 3 &&
        !pointInPolygon(sourceAnchor, toFeature.points)
      ) {
        errors.push(
          `地图“${map.id}”空间关系“${relation.description || id}”的源要素未落在目标区域内。`,
        );
      }
    }

    const isWaterway =
      fromFeature.kind === "route" &&
      fromFeature.props.entityRole === "waterway";
    if (
      !isWaterway ||
      !["originates-at", "flows-through"].includes(relation.type) ||
      fromFeature.points.length < 2
    ) {
      continue;
    }
    const riverName = fromFeature.name;
    const targetName = toFeature.name;
    if (relation.type === "originates-at") {
      if (distanceBetweenPoints(fromFeature.points[0]!, targetAnchor) > 1.5) {
        errors.push(
          `地图“${map.id}”河流“${riverName}”未从“${targetName}”的规划锚点发源。`,
        );
      }
      continue;
    }
    const flowsThroughTarget =
      fromFeature.points.some(
        (point) => distanceBetweenPoints(point, targetAnchor) <= 1.5,
      ) ||
      fromFeature.points
        .slice(1)
        .some(
          (point, pointIndex) =>
            pointToSegmentDistance(
              targetAnchor,
              fromFeature.points[pointIndex]!,
              point,
            ) <= throughTolerance,
        );
    if (!flowsThroughTarget) {
      errors.push(
        `地图“${map.id}”河流“${riverName}”未流经“${targetName}”的规划锚点。`,
      );
    }
  }
  return errors;
}
