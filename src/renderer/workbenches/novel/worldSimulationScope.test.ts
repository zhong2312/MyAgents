import { describe, expect, it } from "vitest";

import { createDefaultWorldSimulationScenario } from "./worldSimulationV2Schema";
import { resolveWorldSimulationRegionScope } from "./worldSimulationScope";

const sourceRefs = [
  {
    path: "fixture.json",
    sourceHash: "sha256:fixture",
    authority: "canon" as const,
  },
];

const containment = {
  id: "containment-root-child",
  fromRegionId: "root",
  toRegionId: "child",
  kind: "containment" as const,
  travelDays: "1",
  capacity: 1,
  attenuation: 0,
  bidirectional: true,
  sourceRefs,
};

const road = {
  id: "road-child-neighbor",
  fromRegionId: "child",
  toRegionId: "neighbor",
  kind: "road" as const,
  travelDays: "2",
  capacity: 1,
  attenuation: 0,
  bidirectional: true,
  sourceRefs,
};

const regions = [
  { id: "root", parentId: null, connections: [containment] },
  {
    id: "child",
    parentId: "root",
    connections: [containment, road],
  },
  { id: "neighbor", parentId: null, connections: [road] },
] as const;

describe("resolveWorldSimulationRegionScope", () => {
  it("expands descendants and actual adjacent connections, but not containment edges", () => {
    const base = createDefaultWorldSimulationScenario().scope;

    const expanded = resolveWorldSimulationRegionScope(regions, {
      ...base,
      regionIds: ["root"],
      includeDescendants: true,
      adjacencyDepth: 1,
    });
    const containmentOnly = resolveWorldSimulationRegionScope(regions, {
      ...base,
      regionIds: ["child"],
      includeDescendants: false,
      adjacencyDepth: 1,
    });

    expect([...expanded]).toEqual(["root", "child", "neighbor"]);
    expect([...containmentOnly]).toEqual(["child", "neighbor"]);
  });
});
