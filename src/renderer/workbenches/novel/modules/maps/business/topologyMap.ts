import type { Connection, Edge, Node } from "@xyflow/react";

import type { MapDocument, MapFeature } from "../entities/mapSchema";

export const TOPOLOGY_SOURCE_NODE_PROP = "sourceNodeId";
export const TOPOLOGY_TARGET_NODE_PROP = "targetNodeId";

export interface TopologyNodeData extends Record<string, unknown> {
  readonly label: string;
  readonly color: string;
  readonly feature: MapFeature;
  readonly locked: boolean;
}

export type TopologyNode = Node<TopologyNodeData>;
export type TopologyEdge = Edge<Record<string, unknown>>;

function isVisibleAt(
  feature: MapFeature,
  timelineCursor: number | null,
): boolean {
  if (timelineCursor === null) return true;
  return (
    (feature.timeFrom === null || timelineCursor >= feature.timeFrom) &&
    (feature.timeTo === null || timelineCursor <= feature.timeTo)
  );
}

function visibleFeatureIds(
  document: MapDocument,
  timelineCursor: number | null,
): ReadonlySet<string> {
  const visibleLayers = new Set(
    document.layers.filter((layer) => layer.visible).map((layer) => layer.id),
  );
  return new Set(
    document.features
      .filter(
        (feature) =>
          visibleLayers.has(feature.layerId) &&
          isVisibleAt(feature, timelineCursor),
      )
      .map((feature) => feature.id),
  );
}

export function buildTopologyElements(
  document: MapDocument,
  timelineCursor: number | null,
): {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
} {
  const visibleIds = visibleFeatureIds(document, timelineCursor);
  const nodes = document.features
    .filter((feature) => feature.kind === "node" && visibleIds.has(feature.id))
    .map<TopologyNode>((feature) => {
      const layer = document.layers.find(
        (entry) => entry.id === feature.layerId,
      );
      const point = feature.points[0] ?? { x: 0, y: 0 };
      return {
        id: feature.id,
        position: point,
        draggable: !layer?.locked,
        selectable: !layer?.locked,
        data: {
          label: feature.name,
          color: feature.props.color ?? "#507b88",
          feature,
          locked: layer?.locked ?? false,
        },
        style: {
          opacity: layer?.opacity ?? 1,
        },
      };
    });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = document.features
    .filter((feature) => feature.kind === "route" && visibleIds.has(feature.id))
    .flatMap<TopologyEdge>((feature) => {
      const source = feature.props[TOPOLOGY_SOURCE_NODE_PROP];
      const target = feature.props[TOPOLOGY_TARGET_NODE_PROP];
      if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
        return [];
      }
      const layer = document.layers.find(
        (entry) => entry.id === feature.layerId,
      );
      return [
        {
          id: feature.id,
          source,
          target,
          label: feature.name,
          selectable: !layer?.locked,
          animated: feature.props.animated === "true",
          style: {
            stroke: feature.props.color ?? "#8e6044",
            strokeWidth: Number(feature.props.lineWidth ?? 2),
            opacity: layer?.opacity ?? 1,
          },
        },
      ];
    });
  return { nodes, edges };
}

export function createTopologyNodeFeature(input: {
  readonly id: string;
  readonly layerId: string;
  readonly point: { readonly x: number; readonly y: number };
}): MapFeature {
  return {
    id: input.id,
    kind: "node",
    name: "新世界",
    entityRef: null,
    layerId: input.layerId,
    points: [{ x: input.point.x, y: input.point.y }],
    timeFrom: null,
    timeTo: null,
    props: { color: "#507b88", showLabel: "true" },
    description: "",
  };
}

export function createTopologyEdgeFeature(input: {
  readonly id: string;
  readonly layerId: string;
  readonly connection: Pick<Connection, "source" | "target">;
  readonly document: MapDocument;
}): MapFeature | null {
  const { source, target } = input.connection;
  if (!source || !target || source === target) return null;
  const sourceFeature = input.document.features.find(
    (feature) => feature.id === source && feature.kind === "node",
  );
  const targetFeature = input.document.features.find(
    (feature) => feature.id === target && feature.kind === "node",
  );
  if (!sourceFeature || !targetFeature) return null;
  return {
    id: input.id,
    kind: "route",
    name: "世界通道",
    entityRef: null,
    layerId: input.layerId,
    points: [sourceFeature.points[0]!, targetFeature.points[0]!],
    timeFrom: null,
    timeTo: null,
    props: {
      color: "#8e6044",
      lineWidth: "2",
      [TOPOLOGY_SOURCE_NODE_PROP]: source,
      [TOPOLOGY_TARGET_NODE_PROP]: target,
    },
    description: "",
  };
}

export function moveTopologyNode(
  document: MapDocument,
  nodeId: string,
  point: { readonly x: number; readonly y: number },
): MapDocument {
  const movedNode = document.features.find(
    (feature) => feature.id === nodeId && feature.kind === "node",
  );
  if (!movedNode) return document;
  const nodePoints = new Map(
    document.features
      .filter((feature) => feature.kind === "node")
      .map((feature) => [
        feature.id,
        feature.id === nodeId
          ? { x: point.x, y: point.y }
          : (feature.points[0] ?? { x: 0, y: 0 }),
      ]),
  );
  return {
    ...document,
    features: document.features.map((feature) => {
      if (feature.id === nodeId) {
        return { ...feature, points: [{ x: point.x, y: point.y }] };
      }
      if (feature.kind !== "route") return feature;
      const sourceId = feature.props[TOPOLOGY_SOURCE_NODE_PROP];
      const targetId = feature.props[TOPOLOGY_TARGET_NODE_PROP];
      if (sourceId !== nodeId && targetId !== nodeId) return feature;
      const source = sourceId ? nodePoints.get(sourceId) : undefined;
      const target = targetId ? nodePoints.get(targetId) : undefined;
      return source && target
        ? { ...feature, points: [source, target] }
        : feature;
    }),
  };
}

export function removeTopologyFeature(
  document: MapDocument,
  featureId: string,
): MapDocument {
  const target = document.features.find((feature) => feature.id === featureId);
  if (!target) return document;
  const removedIds = new Set([featureId]);
  if (target.kind === "node") {
    for (const feature of document.features) {
      if (
        feature.kind === "route" &&
        (feature.props[TOPOLOGY_SOURCE_NODE_PROP] === featureId ||
          feature.props[TOPOLOGY_TARGET_NODE_PROP] === featureId)
      ) {
        removedIds.add(feature.id);
      }
    }
  }
  return {
    ...document,
    features: document.features.filter(
      (feature) => !removedIds.has(feature.id),
    ),
  };
}
