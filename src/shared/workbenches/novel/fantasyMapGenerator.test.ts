import { describe, expect, it } from "vitest";

import {
  generateFantasyMapCandidate,
  type FantasyPoint,
} from "./fantasyMapGenerator";

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
    const coast = generated.features.find(
      (feature) => feature.props.terrain === "coast",
    );
    if (!coast) throw new Error("生成结果缺少主大陆海岸线");

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
});
