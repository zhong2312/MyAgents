import { describe, expect, it } from "vitest";

import {
  generateFantasyMapCandidate,
  type FantasyPoint,
} from "./fantasyMapGenerator";
import type { MapGenerationPlan } from "./mapGenerationPlan";

function pointInPolygon(
  candidate: FantasyPoint,
  polygon: readonly FantasyPoint[],
): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const current = polygon[index]!;
    const last = polygon[previous]!;
    const cross =
      (candidate.x - current.x) * (last.y - current.y) -
      (candidate.y - current.y) * (last.x - current.x);
    const dot =
      (candidate.x - current.x) * (candidate.x - last.x) +
      (candidate.y - current.y) * (candidate.y - last.y);
    if (Math.abs(cross) < 0.1 && dot <= 0.1) return true;
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

function segmentIntersects(
  from: FantasyPoint,
  to: FantasyPoint,
  otherFrom: FantasyPoint,
  otherTo: FantasyPoint,
): boolean {
  const orientation = (
    first: FantasyPoint,
    second: FantasyPoint,
    third: FantasyPoint,
  ) =>
    (second.x - first.x) * (third.y - first.y) -
    (second.y - first.y) * (third.x - first.x);
  const firstStart = orientation(from, to, otherFrom);
  const firstEnd = orientation(from, to, otherTo);
  const secondStart = orientation(otherFrom, otherTo, from);
  const secondEnd = orientation(otherFrom, otherTo, to);
  return (
    Math.sign(firstStart) !== Math.sign(firstEnd) &&
    Math.sign(secondStart) !== Math.sign(secondEnd)
  );
}

function pathIntersectsPolygon(
  path: readonly FantasyPoint[],
  polygon: readonly FantasyPoint[],
): boolean {
  return (
    path.some((candidate) => pointInPolygon(candidate, polygon)) ||
    path.some((candidate, index) => {
      if (index === 0) return false;
      const previous = path[index - 1]!;
      return polygon.some((edge, edgeIndex) =>
        segmentIntersects(
          previous,
          candidate,
          edge,
          polygon[(edgeIndex + 1) % polygon.length]!,
        ),
      );
    })
  );
}

function segmentsCross(
  first: readonly FantasyPoint[],
  second: readonly FantasyPoint[],
  crossing: FantasyPoint,
): boolean {
  return first.some((point, index) => {
    if (index === 0) return false;
    const previous = first[index - 1]!;
    return second.some((otherPoint, otherIndex) => {
      if (otherIndex === 0) return false;
      const otherPrevious = second[otherIndex - 1]!;
      if (!segmentIntersects(previous, point, otherPrevious, otherPoint)) {
        return false;
      }
      const within = (
        candidate: FantasyPoint,
        start: FantasyPoint,
        end: FantasyPoint,
      ) =>
        candidate.x >= Math.min(start.x, end.x) - 0.1 &&
        candidate.x <= Math.max(start.x, end.x) + 0.1 &&
        candidate.y >= Math.min(start.y, end.y) - 0.1 &&
        candidate.y <= Math.max(start.y, end.y) + 0.1;
      return (
        within(crossing, previous, point) &&
        within(crossing, otherPrevious, otherPoint)
      );
    });
  });
}

function pathsCross(
  first: readonly FantasyPoint[],
  second: readonly FantasyPoint[],
): boolean {
  return first.some((point, index) => {
    if (index === 0) return false;
    const previous = first[index - 1]!;
    return second.some((otherPoint, otherIndex) => {
      if (otherIndex === 0) return false;
      return segmentIntersects(
        previous,
        point,
        second[otherIndex - 1]!,
        otherPoint,
      );
    });
  });
}

function featureAnchor(points: readonly FantasyPoint[]): FantasyPoint {
  if (points.length === 1) return points[0]!;
  const center = points.reduce(
    (result, candidate) => ({
      x: result.x + candidate.x / points.length,
      y: result.y + candidate.y / points.length,
    }),
    { x: 0, y: 0 },
  );
  return {
    x: Math.round(center.x * 10) / 10,
    y: Math.round(center.y * 10) / 10,
  };
}

describe("Fantasy Map Generator", () => {
  it("将内陆区域、地貌、聚落与河道保持在主大陆上，并让河流抵达海岸", () => {
    const input = {
      seed: "land-locked-geography",
      width: 1_600,
      height: 1_000,
      layerId: "layer-main",
      landmassCount: 3,
      regionCount: 8,
      riverCount: 7,
      terrainKeywords: ["雪岭", "原始森林"],
      placeNames: ["云城", "临海关", "北原"],
    } as const;
    const generated = generateFantasyMapCandidate(input);
    const repeated = generateFantasyMapCandidate(input);
    expect(
      generated.features.every(
        (feature) => feature.props.fantasyStyle === "xuanhuan-zh",
      ),
    ).toBe(true);
    expect(
      generated.features.some((feature) =>
        /[\u3400-\u9fff]/u.test(feature.name),
      ),
    ).toBe(true);
    expect(generated.summary).toContain("中文玄幻地图");
    const coast = generated.features.find(
      (feature) => feature.props.terrain === "coast",
    );
    if (!coast) throw new Error("生成结果缺少主大陆海岸线");

    expect(coast.kind).toBe("area");

    expect(generated).toEqual(repeated);
    const mainlandFeatures = generated.features.filter((feature) =>
      [
        "region",
        "river",
        "tributary",
        "mountain",
        "forest",
        "biome",
        "road",
      ].includes(feature.props.terrain ?? ""),
    );
    mainlandFeatures.push(
      ...generated.features.filter(
        (feature) =>
          feature.kind === "marker" && feature.props.symbol === "city",
      ),
    );
    expect(mainlandFeatures).not.toHaveLength(0);
    expect(
      generated.features.filter((feature) => feature.props.terrain === "road"),
    ).not.toHaveLength(0);
    mainlandFeatures.forEach((feature) => {
      feature.points.forEach((candidate) => {
        expect(pointInPolygon(candidate, coast.points)).toBe(true);
      });
    });

    generated.features
      .filter((feature) => feature.props.terrain === "river")
      .forEach((river) => {
        const mouth = river.points.at(-1)!;
        expect(
          coast.points.some(
            (coastPoint) =>
              coastPoint.x === mouth.x && coastPoint.y === mouth.y,
          ),
        ).toBe(true);
      });
  });

  it("根据世界架构地貌词生成湖泊、支流、分级聚落和对应材质", () => {
    const generated = generateFantasyMapCandidate({
      seed: "biome-and-hydrology",
      width: 1_600,
      height: 1_000,
      layerId: "layer-main",
      regionCount: 7,
      riverCount: 8,
      terrainKeywords: ["冰原", "沙漠", "湿地", "火山", "森林"],
    });
    const coast = generated.features.find(
      (feature) => feature.props.terrain === "coast",
    );
    if (!coast) throw new Error("生成结果缺少主大陆海岸线");

    const lakes = generated.features.filter(
      (feature) => feature.props.terrain === "lake",
    );
    expect(lakes.length).toBeGreaterThan(0);
    expect(lakes.every((lake) => lake.kind === "area")).toBe(true);
    lakes.forEach((lake) =>
      lake.points.forEach((candidate) => {
        expect(pointInPolygon(candidate, coast.points)).toBe(true);
      }),
    );

    const mainRivers = new Map(
      generated.features
        .filter((feature) => feature.props.terrain === "river")
        .map((feature) => [feature.id, feature] as const),
    );
    const tributaries = generated.features.filter(
      (feature) => feature.props.terrain === "tributary",
    );
    expect(tributaries.length).toBeGreaterThan(0);
    tributaries.forEach((tributary) => {
      const parent = mainRivers.get(tributary.props.joinsRiverId ?? "");
      expect(parent).toBeDefined();
      expect(
        parent?.points.some((candidate) =>
          Object.is(candidate, tributary.points.at(-1)),
        ),
      ).toBe(true);
    });

    const settlementTypes = new Set(
      generated.features
        .filter(
          (feature) =>
            feature.kind === "marker" &&
            typeof feature.props.settlementType === "string",
        )
        .map((feature) => feature.props.settlementType),
    );
    expect(settlementTypes).toEqual(
      new Set(["capital", "city", "village", "port"]),
    );
    const materials = new Set(
      generated.features
        .filter((feature) => feature.props.terrain === "biome")
        .map((feature) => feature.props.terrainMaterial),
    );
    ["desert", "snow", "swamp", "volcanic"].forEach((material) =>
      expect(materials.has(material)).toBe(true),
    );
  });

  it("将世界架构中的高地词投影为稳定且可编辑的地貌构件", () => {
    const input = {
      seed: "world-relief-components",
      width: 1_600,
      height: 1_000,
      layerId: "layer-main",
      regionCount: 6,
      riverCount: 5,
      terrainKeywords: ["熔岩火山", "雪岭", "丘陵", "高原台地"],
    } as const;
    const generated = generateFantasyMapCandidate(input);
    const repeated = generateFantasyMapCandidate(input);
    const coast = generated.features.find(
      (feature) => feature.props.terrain === "coast",
    );
    if (!coast) throw new Error("生成结果缺少主大陆海岸线");

    expect(generated).toEqual(repeated);
    const components = generated.features.filter(
      (feature) =>
        feature.kind === "marker" &&
        ["volcano", "snow-peak", "foothills", "mesa"].includes(
          feature.props.component ?? "",
        ),
    );
    expect(
      new Set(components.map((feature) => feature.props.component)),
    ).toEqual(new Set(["volcano", "snow-peak", "foothills", "mesa"]));
    expect(
      components.filter((feature) => feature.props.component === "foothills"),
    ).toHaveLength(2);

    const lakes = generated.features.filter(
      (feature) => feature.props.terrain === "lake",
    );
    components.forEach((feature) => {
      const placement = feature.points[0];
      expect(placement).toBeDefined();
      expect(pointInPolygon(placement!, coast.points)).toBe(true);
      lakes.forEach((lake) =>
        expect(pointInPolygon(placement!, lake.points)).toBe(false),
      );
    });
  });

  it("让山脉成为水系源头，并把聚落道路组织为可追溯的交通网络", () => {
    const generated = generateFantasyMapCandidate({
      seed: "highland-waterway-network",
      width: 1_600,
      height: 1_000,
      layerId: "layer-main",
      regionCount: 8,
      riverCount: 7,
      terrainKeywords: ["雪岭", "河谷", "森林"],
    });
    const mountains = new Map(
      generated.features
        .filter((feature) => feature.props.terrain === "mountain")
        .map((feature) => [feature.id, feature] as const),
    );
    const lakes = new Map(
      generated.features
        .filter((feature) => feature.props.terrain === "lake")
        .map((feature) => [feature.id, feature] as const),
    );
    const waterways = new Map(
      generated.features
        .filter(
          (feature) =>
            feature.props.terrain === "river" ||
            feature.props.terrain === "tributary",
        )
        .map((feature) => [feature.id, feature] as const),
    );
    const settlements = new Map(
      generated.features
        .filter((feature) => Boolean(feature.props.settlementType))
        .map((feature) => [feature.id, feature] as const),
    );

    expect(mountains.size).toBeGreaterThan(0);
    lakes.forEach((lake) =>
      expect(mountains.has(lake.props.sourceMountainId ?? "")).toBe(true),
    );
    waterways.forEach((waterway) => {
      const mountain = mountains.get(waterway.props.sourceMountainId ?? "");
      expect(mountain).toBeDefined();
      if (waterway.props.sourceType === "mountain") {
        expect(
          mountain?.points.some(
            (candidate) =>
              candidate.x === waterway.points[0]?.x &&
              candidate.y === waterway.points[0]?.y,
          ),
        ).toBe(true);
      }
      if (waterway.props.sourceType === "lake") {
        const lake = lakes.get(waterway.props.sourceLakeId ?? "");
        expect(lake).toBeDefined();
        expect(lake?.props.sourceMountainId).toBe(
          waterway.props.sourceMountainId,
        );
      }
    });

    const roads = generated.features.filter(
      (feature) => feature.props.terrain === "road",
    );
    const bridgeRoadIds = new Set(
      generated.features
        .filter((feature) => feature.props.terrain === "bridge")
        .map((feature) => feature.props.roadId),
    );
    expect(roads).toHaveLength(settlements.size - 1);
    roads.forEach((road) => {
      const origin = settlements.get(road.props.fromSettlementId ?? "");
      const destination = settlements.get(road.props.toSettlementId ?? "");
      expect(origin).toBeDefined();
      expect(destination).toBeDefined();
      expect(road.points[0]).toEqual(origin?.points[0]);
      expect(road.points.at(-1)).toEqual(destination?.points[0]);
      if (road.props.followsWaterwayId) {
        const waterway = waterways.get(road.props.followsWaterwayId);
        expect(waterway).toBeDefined();
        expect(road.props.routing).toBe("river-valley");
        expect(road.points.length).toBeGreaterThan(3);
        road.points.slice(1, -1).forEach((point) => {
          const nearestDistance = Math.min(
            ...(waterway?.points ?? []).map((waterPoint) =>
              Math.hypot(point.x - waterPoint.x, point.y - waterPoint.y),
            ),
          );
          expect(nearestDistance).toBeLessThanOrEqual(24);
        });
        if (pathsCross(road.points, waterway?.points ?? [])) {
          expect(bridgeRoadIds.has(road.id)).toBe(true);
        }
      }
    });
  });

  it("让道路绕开湖泊，并只在实际跨越水系处放置桥梁", () => {
    const generated = generateFantasyMapCandidate({
      seed: "world-biomes",
      width: 1_600,
      height: 1_000,
      layerId: "layer-main",
      regionCount: 7,
      riverCount: 8,
      terrainKeywords: ["冰原", "沙漠", "湿地", "火山", "森林"],
    });
    const lakes = generated.features.filter(
      (feature) => feature.props.terrain === "lake",
    );
    const roads = new Map(
      generated.features
        .filter((feature) => feature.props.terrain === "road")
        .map((feature) => [feature.id, feature] as const),
    );
    const watercourses = generated.features.filter(
      (feature) =>
        feature.props.terrain === "river" ||
        feature.props.terrain === "tributary",
    );

    roads.forEach((road) => {
      lakes.forEach((lake) => {
        expect(pathIntersectsPolygon(road.points, lake.points)).toBe(false);
      });
    });

    generated.features
      .filter((feature) => feature.props.symbol === "bridge")
      .forEach((bridge) => {
        const road = roads.get(bridge.props.roadId ?? "");
        const crossing = bridge.points[0];
        expect(road).toBeDefined();
        expect(crossing).toBeDefined();
        expect(
          watercourses.some((watercourse) =>
            segmentsCross(road?.points ?? [], watercourse.points, crossing!),
          ),
        ).toBe(true);
      });
  });

  it("将完整地图规划绑定到正式实体，并为未命中实体补充玄幻标记", () => {
    const generated = generateFantasyMapCandidate({
      seed: "generation-plan",
      width: 1_600,
      height: 1_000,
      layerId: "layer-main",
      regionCount: 5,
      riverCount: 5,
      plan: {
        schemaVersion: 1,
        styleId: "xuanhuan-zh",
        worldSourceHash: "a".repeat(64),
        scope: {
          worldNodeId: "world",
          nodeIds: ["world", "north"],
          nodePath: "九州",
          generationLevelTypeId: "continent",
          generationLevelName: "大陆",
        },
        azgaar: {
          heightmapTemplate: "east-asia",
          landmassCount: 1,
          regionCount: 5,
          riverCount: 5,
          states: 2,
          cultures: 2,
          religions: 1,
          precipitation: 160,
        },
        spatialLayers: [
          {
            id: "layer-north",
            name: "北荒",
            worldNodeId: "north",
            parentId: null,
            levelTypeId: "region",
            role: "region",
            zone: "north",
            climate: ["寒冷"],
            terrain: ["雪岭"],
            anchor: { x: 0.2, y: 0.2 },
            notes: "雪山北境",
          },
          {
            id: "layer-north-inner",
            name: "北荒内域",
            worldNodeId: "north",
            parentId: "layer-north",
            levelTypeId: "domain",
            role: "domain",
            zone: "north",
            climate: ["严寒"],
            terrain: ["冰原"],
            anchor: { x: 0.92, y: 0.08 },
            notes: "北荒腹地的冰原领地。",
          },
        ],
        entities: [
          {
            id: "xuan-bing-palace",
            entityRef: { kind: "setting", id: "setting-xuan-bing" },
            name: "玄冰宫",
            role: "sect",
            spatialLayerId: "layer-north",
            anchor: { x: 0.2, y: 0.2 },
            preferredTerrain: ["雪山灵脉"],
            importance: 5,
            description: "北荒宗门",
          },
          {
            id: "ancient-ruin",
            entityRef: null,
            name: "太古遗迹",
            role: "ruin",
            spatialLayerId: "layer-north",
            anchor: { x: 0.28, y: 0.25 },
            preferredTerrain: ["雪岭"],
            importance: 2,
            description: "遗迹",
          },
          {
            id: "north-snow-ridge",
            entityRef: null,
            name: "北境雪岭",
            role: "mountain",
            spatialLayerId: "layer-north",
            anchor: { x: 0.5, y: 0.34 },
            preferredTerrain: ["雪山"],
            importance: 5,
            description: "北荒的主山脉。",
          },
          {
            id: "heaven-river",
            entityRef: null,
            name: "天池河",
            role: "waterway",
            spatialLayerId: "layer-north",
            anchor: { x: 0.46, y: 0.46 },
            preferredTerrain: ["河谷"],
            importance: 5,
            description: "发源于北境雪岭的主河。",
          },
          {
            id: "cloud-city",
            entityRef: null,
            name: "云中城",
            role: "city",
            spatialLayerId: "layer-north",
            anchor: { x: 0.56, y: 0.56 },
            preferredTerrain: ["河网", "平原"],
            importance: 5,
            description: "河道交通中心。",
          },
        ],
        territories: [
          {
            id: "xuan-bing-domain",
            factionRef: { kind: "faction", id: "xuan-bing-palace" },
            name: "玄冰宫道域",
            spatialLayerId: "layer-north",
            anchor: { x: 0.24, y: 0.24 },
            extent: 0.18,
            boundaryStyle: "hatch",
            importance: 5,
            description: "玄冰宫镇守的北荒雪岭道域。",
          },
        ],
        relations: [
          {
            fromId: "xuan-bing-palace",
            toId: "layer-north",
            type: "located-near",
            description: "依托雪岭",
          },
          {
            fromId: "heaven-river",
            toId: "north-snow-ridge",
            type: "originates-at",
            description: "天池河发源于北境雪岭",
          },
          {
            fromId: "heaven-river",
            toId: "cloud-city",
            type: "flows-through",
            description: "天池河流经云中城",
          },
          {
            fromId: "xuan-bing-domain",
            toId: "layer-north",
            type: "controls",
            description: "玄冰宫道域位于北荒。",
          },
          {
            fromId: "ancient-ruin",
            toId: "north-snow-ridge",
            type: "hidden-in",
            description: "太古遗迹隐藏在北境雪岭。",
          },
          {
            fromId: "xuan-bing-palace",
            toId: "cloud-city",
            type: "connected-to",
            description: "玄冰宫灵脉与云中城相连。",
          },
          {
            fromId: "xuan-bing-domain",
            toId: "layer-north-inner",
            type: "separated-by",
            description: "玄冰宫道域与北荒内域由结界隔绝。",
          },
        ],
        visual: {
          paperPreset: "parchment",
          labelHierarchy: "balanced",
          borderStyle: "ink",
          reliefStyle: "ink-peaks",
          waterStyle: "indigo-ripple",
          terrainMaterials: ["snow"],
          ornaments: ["compass"],
          notes: "玄幻舆图",
        },
        rationale: "北荒以雪岭为骨",
      },
    });
    const palace = generated.features.find(
      (feature) => feature.props.planEntityId === "xuan-bing-palace",
    );
    const ruin = generated.features.find(
      (feature) => feature.props.planEntityId === "ancient-ruin",
    );
    const north = generated.features.find(
      (feature) =>
        feature.props.spatialLayerId === "layer-north" &&
        feature.props.spatialRole === "region",
    );
    const northInner = generated.features.find(
      (feature) => feature.props.spatialLayerId === "layer-north-inner",
    );
    const snowRidge = generated.features.find(
      (feature) => feature.props.planEntityId === "north-snow-ridge",
    );
    const heavenRiver = generated.features.find(
      (feature) => feature.props.planEntityId === "heaven-river",
    );
    const cloudCity = generated.features.find(
      (feature) => feature.props.planEntityId === "cloud-city",
    );
    const territory = generated.features.find(
      (feature) => feature.props.planTerritoryId === "xuan-bing-domain",
    );
    const connection = generated.features.find(
      (feature) => feature.props.planRelationType === "connected-to",
    );
    const separation = generated.features.find(
      (feature) => feature.props.planRelationType === "separated-by",
    );
    expect(palace?.entityRef).toEqual({
      kind: "setting",
      id: "setting-xuan-bing",
    });
    expect(north?.entityRef).toEqual({ kind: "setting", id: "north" });
    expect(north?.props).toMatchObject({
      worldNodeId: "north",
      entityRefKind: "setting",
      entityRefId: "north",
    });
    expect(palace?.props.component).toBe("faction-seat");
    expect(palace?.props.spatialLayerId).toBe("layer-north");
    expect(ruin?.props.component).toBe("ruins");
    expect(palace?.props.planRelations).toContain("located-near");
    expect(
      Math.hypot(
        (palace?.points[0]?.x ?? 0) -
          (featureAnchor(north?.points ?? []).x ?? 0),
        (palace?.points[0]?.y ?? 0) -
          (featureAnchor(north?.points ?? []).y ?? 0),
      ),
    ).toBeLessThanOrEqual(40);
    expect(
      northInner?.points.every((item) =>
        pointInPolygon(item, north?.points ?? []),
      ),
    ).toBe(true);
    for (const plannedFeature of [
      palace,
      ruin,
      snowRidge,
      heavenRiver,
      cloudCity,
    ]) {
      expect(plannedFeature).toBeDefined();
      expect(
        plannedFeature?.points.every((item) =>
          pointInPolygon(item, north?.points ?? []),
        ),
      ).toBe(true);
    }
    expect(heavenRiver?.points[0]).toEqual(
      featureAnchor(snowRidge?.points ?? []),
    );
    expect(heavenRiver?.points).toContainEqual(cloudCity?.points[0]);
    expect(territory).toMatchObject({
      kind: "area",
      name: "玄冰宫道域",
      entityRef: { kind: "faction", id: "xuan-bing-palace" },
      props: {
        planTerritoryId: "xuan-bing-domain",
        entityRole: "territory",
        entityRefKind: "faction",
        entityRefId: "xuan-bing-palace",
        boundaryStyle: "hatch",
      },
    });
    expect(territory?.points.length).toBeGreaterThanOrEqual(3);
    expect(territory?.props.planRelations).toContain("controls");
    expect(connection).toMatchObject({
      kind: "route",
      name: "灵脉连接",
      props: {
        planRelationType: "connected-to",
        planRelationFromId: "xuan-bing-palace",
        planRelationToId: "cloud-city",
        routeStyle: "ley-line",
      },
    });
    expect(connection?.points[0]).toEqual(featureAnchor(palace?.points ?? []));
    expect(connection?.points.at(-1)).toEqual(
      featureAnchor(cloudCity?.points ?? []),
    );
    expect(separation).toMatchObject({
      kind: "route",
      name: "隔绝结界",
      props: {
        planRelationType: "separated-by",
        planRelationFromId: "xuan-bing-domain",
        planRelationToId: "layer-north-inner",
        routeStyle: "barrier",
      },
    });
    expect(
      Math.hypot(
        (ruin?.points[0]?.x ?? 0) -
          (featureAnchor(snowRidge?.points ?? []).x ?? 0),
        (ruin?.points[0]?.y ?? 0) -
          (featureAnchor(snowRidge?.points ?? []).y ?? 0),
      ),
    ).toBeLessThanOrEqual(40);
  });

  it("为结构性规划角色生成正确几何，并避免错误的地标印章", () => {
    const plan: MapGenerationPlan = {
      schemaVersion: 1,
      styleId: "xuanhuan-zh",
      worldSourceHash: "b".repeat(64),
      scope: {
        worldNodeId: "world",
        nodeIds: ["world"],
        nodePath: "九州",
        generationLevelTypeId: "continent",
        generationLevelName: "大陆",
      },
      azgaar: {
        heightmapTemplate: "east-asia",
        landmassCount: 1,
        regionCount: 3,
        riverCount: 2,
        states: 2,
        cultures: 1,
        religions: 0,
        precipitation: 160,
      },
      spatialLayers: [
        {
          id: "layer-world",
          name: "九州",
          worldNodeId: "world",
          parentId: null,
          levelTypeId: "continent",
          role: "realm",
          zone: "center",
          climate: [],
          terrain: ["平原"],
          anchor: { x: 0.5, y: 0.5 },
          notes: "世界主陆块。",
        },
      ],
      entities: [
        {
          id: "planned-realm",
          entityRef: null,
          name: "中州",
          role: "realm",
          spatialLayerId: "layer-world",
          anchor: { x: 0.5, y: 0.5 },
          preferredTerrain: ["平原"],
          importance: 5,
          description: "中央大域。",
        },
        {
          id: "planned-lake",
          entityRef: null,
          name: "太虚湖",
          role: "lake",
          spatialLayerId: "layer-world",
          anchor: { x: 0.42, y: 0.42 },
          preferredTerrain: ["湖泊"],
          importance: 3,
          description: "内陆湖泊。",
        },
        {
          id: "planned-biome",
          entityRef: null,
          name: "苍梧林海",
          role: "biome",
          spatialLayerId: "layer-world",
          anchor: { x: 0.62, y: 0.56 },
          preferredTerrain: ["森林"],
          importance: 3,
          description: "连续森林地貌。",
        },
        {
          id: "planned-vein",
          entityRef: null,
          name: "北境龙脉",
          role: "vein",
          spatialLayerId: "layer-world",
          anchor: { x: 0.35, y: 0.3 },
          preferredTerrain: ["山脉"],
          importance: 4,
          description: "贯穿北境的灵脉。",
        },
        {
          id: "planned-city",
          entityRef: null,
          name: "天京",
          role: "capital",
          spatialLayerId: "layer-world",
          anchor: { x: 0.55, y: 0.5 },
          preferredTerrain: ["平原"],
          importance: 5,
          description: "中央都城。",
        },
      ],
      relations: [],
      visual: {
        paperPreset: "parchment",
        labelHierarchy: "balanced",
        borderStyle: "ink",
        reliefStyle: "ink-peaks",
        waterStyle: "indigo-ripple",
        terrainMaterials: ["forest"],
        ornaments: [],
        notes: "结构角色投影测试。",
      },
      rationale: "验证结构几何与地标素材职责分离。",
    };
    const generated = generateFantasyMapCandidate({
      seed: "structural-plan-roles",
      width: 1_600,
      height: 1_000,
      layerId: "layer-main",
      regionCount: 3,
      riverCount: 2,
      plan,
    });
    const featureFor = (id: string) =>
      generated.features.find((feature) => feature.props.planEntityId === id);

    expect(featureFor("planned-realm")).toMatchObject({
      kind: "area",
      props: { entityRole: "realm" },
    });
    expect(featureFor("planned-lake")).toMatchObject({
      kind: "area",
      props: { entityRole: "lake", terrain: "lake" },
    });
    expect(featureFor("planned-biome")).toMatchObject({
      kind: "area",
      props: { entityRole: "biome", terrain: "biome" },
    });
    expect(featureFor("planned-vein")).toMatchObject({
      kind: "route",
      props: { entityRole: "vein", terrain: "mountain" },
    });
    expect(featureFor("planned-vein")?.points.length).toBeGreaterThanOrEqual(2);
    expect(featureFor("planned-city")).toMatchObject({
      kind: "marker",
      props: { entityRole: "capital", component: "capital" },
    });
    expect(featureFor("planned-realm")?.props.component).toBeUndefined();
    expect(featureFor("planned-lake")?.props.component).toBeUndefined();
    expect(featureFor("planned-biome")?.props.component).toBeUndefined();
  });

  it("没有显式锚点时按空间区域语义落位，并让子实体继承区域方位", () => {
    const plan: MapGenerationPlan = {
      schemaVersion: 1,
      styleId: "xuanhuan-zh",
      worldSourceHash: "c".repeat(64),
      scope: {
        worldNodeId: "world",
        nodeIds: ["world", "north", "south"],
        nodePath: "九州",
        generationLevelTypeId: "continent",
        generationLevelName: "大陆",
      },
      azgaar: {
        heightmapTemplate: "east-asia",
        landmassCount: 1,
        regionCount: 4,
        riverCount: 2,
        states: 2,
        cultures: 1,
        religions: 0,
        precipitation: 160,
      },
      spatialLayers: [
        {
          id: "layer-north",
          name: "北荒",
          worldNodeId: "north",
          parentId: null,
          levelTypeId: "region",
          role: "region",
          zone: "north",
          climate: ["严寒"],
          terrain: ["雪岭"],
          anchor: null,
          notes: "北境寒冷。",
        },
        {
          id: "layer-south",
          name: "南疆",
          worldNodeId: "south",
          parentId: null,
          levelTypeId: "region",
          role: "region",
          zone: "south",
          climate: ["湿热"],
          terrain: ["雨林"],
          anchor: null,
          notes: "南疆湿热。",
        },
      ],
      entities: [
        {
          id: "north-sect",
          entityRef: { kind: "setting", id: "ice-palace" },
          name: "玄冰宫",
          role: "sect",
          spatialLayerId: "layer-north",
          anchor: null,
          preferredTerrain: ["雪岭"],
          importance: 4,
          description: "北境宗门。",
        },
        {
          id: "south-city",
          entityRef: { kind: "location", id: "rain-city" },
          name: "南疆城",
          role: "city",
          spatialLayerId: "layer-south",
          anchor: null,
          preferredTerrain: ["雨林"],
          importance: 4,
          description: "南疆城池。",
        },
      ],
      relations: [],
      visual: {
        paperPreset: "parchment",
        labelHierarchy: "balanced",
        borderStyle: "ink",
        reliefStyle: "ink-peaks",
        waterStyle: "indigo-ripple",
        terrainMaterials: ["snow", "forest"],
        ornaments: [],
        notes: "语义锚点测试。",
      },
      rationale: "北荒与南疆没有坐标时仍需按空间语义分区。",
    };
    const input = {
      seed: "semantic-zone-fallback",
      width: 1_600,
      height: 1_000,
      layerId: "layer-main",
      regionCount: 4,
      riverCount: 2,
      plan,
    } as const;
    const generated = generateFantasyMapCandidate(input);
    const repeated = generateFantasyMapCandidate(input);
    const featureFor = (id: string) =>
      generated.features.find((feature) => feature.props.planEntityId === id);
    const north = generated.features.find(
      (feature) => feature.props.spatialLayerId === "layer-north",
    );
    const south = generated.features.find(
      (feature) => feature.props.spatialLayerId === "layer-south",
    );
    const northSect = featureFor("north-sect");
    const southCity = featureFor("south-city");

    expect(north).toBeDefined();
    expect(south).toBeDefined();
    expect(northSect).toBeDefined();
    expect(southCity).toBeDefined();
    expect(north?.props.terrainMaterial).toBe("snow");
    expect(south?.props.terrainMaterial).toBe("forest");
    expect(featureAnchor(north?.points ?? []).y).toBeLessThan(
      featureAnchor(south?.points ?? []).y,
    );
    expect(featureAnchor(northSect?.points ?? []).y).toBeLessThan(
      featureAnchor(southCity?.points ?? []).y,
    );
    expect(generated).toEqual(repeated);
  });
});
