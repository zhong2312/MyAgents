import "@xyflow/react/dist/style.css";

import dagre from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";

import { createDefaultPowerTruthMetadata } from "./powerSystemDefaults";
import type { PowerInspectorSelection } from "./PowerSystemInspector";
import type {
  PowerCatalog,
  PowerCatalogEntity,
  PowerConnections,
  PowerEntityReference,
  PowerSystemIndex,
  PowerSystemRecord,
} from "./powerSystemSchema";

const NODE_WIDTH = 148;
const NODE_HEIGHT = 44;

type GraphCategory =
  | PowerCatalogEntity["kind"]
  | "system"
  | "track"
  | "state"
  | "transition"
  | "dimension";

const CATEGORY_LABELS: Readonly<Record<GraphCategory, string>> = {
  system: "力量体系",
  track: "成长轨道",
  state: "成长状态",
  transition: "状态转换",
  dimension: "质量 / 边界",
  foundation: "力量本源",
  medium: "运行介质",
  principle: "底层法则",
  resource: "资源条件",
  theory: "理论模型",
  method: "发展方法",
  capability: "能力",
};

const CATEGORY_COLORS: Readonly<Record<GraphCategory, string>> = {
  system: "#8b5e3c",
  track: "#637583",
  state: "#4b7286",
  transition: "#7b6d5d",
  dimension: "#877052",
  foundation: "#8b5e3c",
  medium: "#2e6f5e",
  principle: "#7252a3",
  resource: "#5f7b45",
  theory: "#496b9b",
  method: "#3d7a8b",
  capability: "#a24f4f",
};

interface PowerGraphNodeData extends Record<string, unknown> {
  readonly label: string;
  readonly category: GraphCategory;
  readonly reference: PowerEntityReference;
  readonly selection: PowerInspectorSelection;
}

type PowerGraphNode = Node<PowerGraphNodeData, "power">;

const HANDLE_POSITIONS = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
] as const;

function PowerNode({ data, selected }: NodeProps<PowerGraphNode>) {
  const color = CATEGORY_COLORS[data.category];
  return (
    <div
      className="relative h-full w-full rounded-md bg-[var(--paper-elevated)] px-2 py-1 text-[var(--ink)]"
      style={{
        border: `1px solid ${color}`,
        borderLeftWidth: 3,
        boxShadow: selected
          ? `0 0 0 2px color-mix(in srgb, ${color} 22%, transparent)`
          : "var(--shadow-sm)",
      }}
    >
      {HANDLE_POSITIONS.map(([side, position]) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={position}
          className="!h-1.5 !w-1.5 !border !border-[var(--paper-elevated)] !bg-[var(--ink-muted)]"
        />
      ))}
      <div className="truncate text-xs font-medium leading-3 text-[var(--ink-muted)]">
        {CATEGORY_LABELS[data.category]}
      </div>
      <div className="truncate text-xs font-semibold leading-4">
        {data.label}
      </div>
    </div>
  );
}

const nodeTypes = { power: PowerNode } as const;

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function catalogEntities(catalog: PowerCatalog): readonly PowerCatalogEntity[] {
  return [
    ...catalog.foundations,
    ...catalog.mediums,
    ...catalog.principles,
    ...catalog.resources,
    ...catalog.theories,
    ...catalog.methods,
    ...catalog.capabilities,
  ];
}

function referenceKey(reference: PowerEntityReference): string {
  if (reference.namespace === "catalog") return `catalog:${reference.targetId}`;
  if (reference.namespace === "external") {
    return `external:${reference.kind}:${reference.targetId}`;
  }
  return reference.kind === "system"
    ? `system:${reference.systemId}`
    : `system:${reference.systemId}:${reference.kind}:${reference.targetId}`;
}

function touchesSystem(reference: PowerEntityReference, systemId: string) {
  return reference.namespace === "system" && reference.systemId === systemId;
}

function layoutGraph(nodes: PowerGraphNode[], edges: Edge[]) {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    nodesep: 24,
    ranksep: 54,
    marginx: 20,
    marginy: 20,
  });
  nodes.forEach((node) =>
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }),
  );
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);
  return nodes.map((node) => {
    const point = graph.node(node.id) as { x: number; y: number };
    return {
      ...node,
      position: { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 },
    };
  });
}

interface PowerSystemGraphProps {
  readonly record: PowerSystemRecord;
  readonly catalog: PowerCatalog;
  readonly connections: PowerConnections;
  readonly index: PowerSystemIndex;
  readonly onConnectionsChange: (connections: PowerConnections) => void;
  readonly onSelectionChange: (selection: PowerInspectorSelection) => void;
}

export default function PowerSystemGraph({
  record,
  catalog,
  connections,
  index,
  onConnectionsChange,
  onSelectionChange,
}: PowerSystemGraphProps) {
  const graph = useMemo(() => {
    const allCatalog = catalogEntities(catalog);
    const directConnections = connections.connections.filter((connection) =>
      [connection.source, connection.target].some((reference) =>
        touchesSystem(reference, record.id),
      ),
    );
    const visibleCatalogIds = new Set(
      directConnections.flatMap((connection) =>
        [connection.source, connection.target]
          .filter((reference) => reference.namespace === "catalog")
          .map((reference) => reference.targetId),
      ),
    );
    const visibleConnections = connections.connections.filter((connection) => {
      if (directConnections.some((candidate) => candidate.id === connection.id))
        return true;
      return [connection.source, connection.target].every(
        (reference) =>
          reference.namespace === "catalog" &&
          visibleCatalogIds.has(reference.targetId),
      );
    });

    const nodes: PowerGraphNode[] = [];
    const addNode = (
      id: string,
      label: string,
      category: GraphCategory,
      reference: PowerEntityReference,
      selection: PowerInspectorSelection,
    ) => {
      if (nodes.some((node) => node.id === id)) return;
      nodes.push({
        id,
        type: "power",
        position: { x: 0, y: 0 },
        data: { label, category, reference, selection },
        style: { width: NODE_WIDTH, height: NODE_HEIGHT },
      });
    };

    addNode(
      `system:${record.id}`,
      record.name,
      "system",
      {
        namespace: "system",
        systemId: record.id,
        kind: "system",
        targetId: record.id,
      },
      { kind: "system" },
    );
    record.tracks.forEach((track) => {
      addNode(
        `system:${record.id}:track:${track.id}`,
        track.name,
        "track",
        {
          namespace: "system",
          systemId: record.id,
          kind: "track",
          targetId: track.id,
        },
        { kind: "track", id: track.id },
      );
      track.states.forEach((state) =>
        addNode(
          `system:${record.id}:state:${state.id}`,
          state.name,
          "state",
          {
            namespace: "system",
            systemId: record.id,
            kind: "state",
            targetId: state.id,
          },
          { kind: "state", trackId: track.id, id: state.id },
        ),
      );
      track.transitions.forEach((transition) =>
        addNode(
          `system:${record.id}:transition:${transition.id}`,
          transition.name,
          "transition",
          {
            namespace: "system",
            systemId: record.id,
            kind: "transition",
            targetId: transition.id,
          },
          { kind: "transition", trackId: track.id, id: transition.id },
        ),
      );
    });
    record.dimensions.forEach((dimension) =>
      addNode(
        `system:${record.id}:dimension:${dimension.id}`,
        dimension.name,
        "dimension",
        {
          namespace: "system",
          systemId: record.id,
          kind:
            dimension.category === "quality"
              ? "quality-dimension"
              : "boundary-dimension",
          targetId: dimension.id,
        },
        { kind: "dimension", id: dimension.id },
      ),
    );
    allCatalog
      .filter((entity) => visibleCatalogIds.has(entity.id))
      .forEach((entity) =>
        addNode(
          `catalog:${entity.id}`,
          entity.name,
          entity.kind,
          { namespace: "catalog", kind: entity.kind, targetId: entity.id },
          { kind: "catalog", id: entity.id },
        ),
      );
    visibleConnections.forEach((connection) => {
      [connection.source, connection.target].forEach((reference) => {
        if (reference.namespace !== "system" || reference.kind !== "system")
          return;
        const entry = index.systems.find(
          (system) => system.id === reference.systemId,
        );
        addNode(
          `system:${reference.systemId}`,
          entry?.name ?? reference.systemId,
          "system",
          reference,
          reference.systemId === record.id
            ? { kind: "system" }
            : { kind: "connection", id: connection.id },
        );
      });
    });

    const edges: Edge[] = [];
    record.tracks.forEach((track) => {
      edges.push({
        id: `track:${track.id}`,
        source: `system:${record.id}`,
        target: `system:${record.id}:track:${track.id}`,
        type: "smoothstep",
        style: { stroke: "var(--line-strong)", strokeWidth: 1 },
      });
      const incomingStateIds = new Set(
        track.transitions.map((transition) => transition.toStateId),
      );
      track.states
        .filter((state) => !incomingStateIds.has(state.id))
        .forEach((state) =>
          edges.push({
            id: `track-entry:${track.id}:${state.id}`,
            source: `system:${record.id}:track:${track.id}`,
            target: `system:${record.id}:state:${state.id}`,
            type: "smoothstep",
            style: { stroke: "var(--line-strong)", strokeWidth: 1 },
          }),
        );
      track.transitions.forEach((transition) => {
        const transitionNode = `system:${record.id}:transition:${transition.id}`;
        edges.push({
          id: `transition-in:${transition.id}`,
          source: transition.fromStateId
            ? `system:${record.id}:state:${transition.fromStateId}`
            : `system:${record.id}:track:${track.id}`,
          target: transitionNode,
          type: "smoothstep",
          style: { stroke: "#7b6d5d", strokeWidth: 1.2 },
        });
        edges.push({
          id: `transition-out:${transition.id}`,
          source: transitionNode,
          target: `system:${record.id}:state:${transition.toStateId}`,
          type: "smoothstep",
          animated: true,
          style: { stroke: "#7b6d5d", strokeWidth: 1.2 },
        });
      });
    });
    visibleConnections.forEach((connection) => {
      const source = referenceKey(connection.source);
      const target = referenceKey(connection.target);
      if (
        !nodes.some((node) => node.id === source) ||
        !nodes.some((node) => node.id === target)
      )
        return;
      edges.push({
        id: `connection:${connection.id}`,
        source,
        target,
        type: "smoothstep",
        label: connection.kind,
        labelStyle: { fontSize: 9, fill: "var(--ink-muted)" },
        style: { stroke: CATEGORY_COLORS.system, strokeWidth: 1.35 },
        markerEnd: {
          type: "arrowclosed" as const,
          color: CATEGORY_COLORS.system,
        },
        data: { connectionId: connection.id },
      });
    });
    return { nodes: layoutGraph(nodes, edges), edges };
  }, [catalog, connections.connections, index.systems, record]);

  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  useEffect(() => setNodes(graph.nodes), [graph.nodes, setNodes]);
  useEffect(() => setEdges(graph.edges), [graph.edges, setEdges]);

  const nodeReferences = useMemo(
    () => new Map(nodes.map((node) => [node.id, node.data.reference])),
    [nodes],
  );

  const onConnect = (connection: Connection) => {
    if (
      !connection.source ||
      !connection.target ||
      connection.source === connection.target
    )
      return;
    const source = nodeReferences.get(connection.source);
    const target = nodeReferences.get(connection.target);
    if (
      !source ||
      !target ||
      source.namespace === "external" ||
      target.namespace === "external"
    )
      return;
    const id = createId("association");
    onConnectionsChange({
      ...connections,
      connections: [
        ...connections.connections,
        {
          id,
          kind: "association",
          source,
          target,
          relation: "uses",
          compatibility: "native",
          conditions: { mode: "all", clauses: [] },
          note: "",
          metadata: createDefaultPowerTruthMetadata(),
        },
      ],
    });
    setEdges((current) =>
      addEdge(
        { ...connection, id: `connection:${id}`, type: "smoothstep" },
        current,
      ),
    );
    onSelectionChange({ kind: "connection", id });
  };

  return (
    <div className="h-[30rem] min-h-[24rem] w-full overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper)]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => onSelectionChange(node.data.selection)}
        onEdgeClick={(_, edge) => {
          const id = edge.data?.connectionId;
          if (typeof id === "string")
            onSelectionChange({ kind: "connection", id });
        }}
        connectionMode={ConnectionMode.Loose}
        fitView
        minZoom={0.25}
        maxZoom={1.8}
        nodesConnectable
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={0.8}
          color="var(--line)"
        />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          style={{ width: 96, height: 64 }}
          nodeColor={(node) =>
            CATEGORY_COLORS[node.data.category as GraphCategory]
          }
          maskColor="color-mix(in srgb, var(--paper) 78%, transparent)"
        />
      </ReactFlow>
    </div>
  );
}
