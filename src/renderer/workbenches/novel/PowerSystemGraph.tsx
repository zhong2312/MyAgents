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

import type {
  PowerConnectionSide,
  PowerElement,
  PowerRelation,
  PowerSystemRecord,
} from "./powerSystemSchema";

const NODE_WIDTH = 156;
const NODE_HEIGHT = 50;

const KIND_LABELS: Readonly<Record<PowerElement["kind"], string>> = {
  origin: "来源",
  resource: "资源",
  method: "方式",
  capability: "能力",
};

const KIND_COLORS: Readonly<Record<PowerElement["kind"], string>> = {
  origin: "#8b5e3c",
  resource: "#2e6f5e",
  method: "#4a7ab5",
  capability: "#a24f4f",
};

interface PowerGraphNodeData extends Record<string, unknown> {
  readonly element: PowerElement;
}

type PowerGraphNode = Node<PowerGraphNodeData, "power">;

const HANDLE_POSITIONS: Readonly<Record<PowerConnectionSide, Position>> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

function PowerNode({ data, selected }: NodeProps<PowerGraphNode>) {
  const { element } = data;
  const color = KIND_COLORS[element.kind];
  return (
    <div
      className="relative h-full w-full rounded-md bg-[var(--paper-elevated)] px-2 py-1 text-[var(--ink)]"
      style={{
        border: `1px solid ${color}`,
        borderLeftWidth: 4,
        boxShadow: selected
          ? `0 0 0 2px color-mix(in srgb, ${color} 24%, transparent)`
          : "var(--shadow-sm)",
      }}
    >
      {(Object.keys(HANDLE_POSITIONS) as PowerConnectionSide[]).map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={HANDLE_POSITIONS[side]}
          className="!h-2 !w-2 !border !border-[var(--paper-elevated)] !bg-[var(--ink)]"
        />
      ))}
      <div className="min-w-0 text-left">
        <div className="text-xs font-medium leading-3 text-[var(--ink-muted)]">
          {KIND_LABELS[element.kind]}
        </div>
        <div className="mt-0.5 truncate text-xs font-semibold leading-4 text-[var(--ink)]">
          {element.name}
        </div>
      </div>
    </div>
  );
}

const POWER_NODE_TYPES = { power: PowerNode } as const;

function automaticHandles(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): {
  readonly fromHandle: PowerConnectionSide;
  readonly toHandle: PowerConnectionSide;
} {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX >= 0
      ? { fromHandle: "right", toHandle: "left" }
      : { fromHandle: "left", toHandle: "right" };
  }
  return deltaY >= 0
    ? { fromHandle: "bottom", toHandle: "top" }
    : { fromHandle: "top", toHandle: "bottom" };
}

function connectionSide(value: string | null): PowerConnectionSide | undefined {
  return value === "top" ||
    value === "right" ||
    value === "bottom" ||
    value === "left"
    ? value
    : undefined;
}

function layoutNodes(record: PowerSystemRecord): {
  readonly nodes: PowerGraphNode[];
  readonly edges: Edge[];
} {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", ranksep: 64, nodesep: 22 });
  record.elements.forEach((element) => {
    graph.setNode(element.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });
  record.relations.forEach((relation) => {
    graph.setEdge(relation.fromId, relation.toId);
  });
  dagre.layout(graph);

  const positions = new Map(
    record.elements.map((element) => {
      const position = graph.node(element.id) as
        | { x: number; y: number }
        | undefined;
      return [element.id, position ?? { x: 0, y: 0 }] as const;
    }),
  );

  return {
    nodes: record.elements.map((element) => {
      const position = positions.get(element.id);
      return {
        id: element.id,
        type: "power",
        position: {
          x: (position?.x ?? 0) - NODE_WIDTH / 2,
          y: (position?.y ?? 0) - NODE_HEIGHT / 2,
        },
        data: { element },
        style: {
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        },
      };
    }),
    edges: record.relations.map((relation) => {
      const handles = automaticHandles(
        positions.get(relation.fromId) ?? { x: 0, y: 0 },
        positions.get(relation.toId) ?? { x: 0, y: 0 },
      );
      return {
        id: relation.id,
        source: relation.fromId,
        target: relation.toId,
        sourceHandle: relation.fromHandle ?? handles.fromHandle,
        targetHandle: relation.toHandle ?? handles.toHandle,
        label: relation.kind,
        type: "smoothstep",
        style: { stroke: "var(--ink-subtle)" },
        labelStyle: { fill: "var(--ink-muted)", fontSize: 10 },
        labelBgStyle: { fill: "var(--paper)", fillOpacity: 0.92 },
        markerEnd: { type: "arrowclosed" },
      };
    }),
  };
}

function relationId(): string {
  return `relation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

interface PowerSystemGraphProps {
  readonly record: PowerSystemRecord;
  readonly onChange: (record: PowerSystemRecord) => void;
  readonly onSelectElement: (id: string) => void;
  readonly onSelectRelation: (id: string) => void;
}

export default function PowerSystemGraph({
  record,
  onChange,
  onSelectElement,
  onSelectRelation,
}: PowerSystemGraphProps) {
  const layout = useMemo(() => layoutNodes(record), [record]);
  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges);

  useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
  }, [layout, setEdges, setNodes]);

  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const relation: PowerRelation = {
      id: relationId(),
      fromId: connection.source,
      toId: connection.target,
      kind: "requires",
      summary: "",
      ...(connectionSide(connection.sourceHandle)
        ? { fromHandle: connectionSide(connection.sourceHandle) }
        : {}),
      ...(connectionSide(connection.targetHandle)
        ? { toHandle: connectionSide(connection.targetHandle) }
        : {}),
    };
    setEdges((current) =>
      addEdge(
        {
          id: relation.id,
          source: relation.fromId,
          target: relation.toId,
          sourceHandle: relation.fromHandle,
          targetHandle: relation.toHandle,
          type: "smoothstep",
        },
        current,
      ),
    );
    onChange({ ...record, relations: [...record.relations, relation] });
    onSelectRelation(relation.id);
  };

  if (record.elements.length === 0) {
    return (
      <div className="flex h-full min-h-80 items-center justify-center px-8 text-center">
        <div>
          <p className="text-sm font-medium text-[var(--ink)]">
            还没有力量元素
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
            从顶部添加来源、资源、运用方式或能力，再连接它们建立因果关系。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 bg-[var(--paper)]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={POWER_NODE_TYPES}
        connectionMode={ConnectionMode.Loose}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        onNodeClick={(_, node) => onSelectElement(node.id)}
        onEdgeClick={(_, edge) => onSelectRelation(edge.id)}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.25}
        maxZoom={1.8}
        colorMode="light"
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1}
          color="var(--line-strong)"
        />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) =>
            KIND_COLORS[
              (node.data?.element as PowerElement | undefined)?.kind ?? "method"
            ]
          }
          maskColor="color-mix(in srgb, var(--paper) 72%, transparent)"
          style={{ background: "var(--paper-elevated)" }}
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
