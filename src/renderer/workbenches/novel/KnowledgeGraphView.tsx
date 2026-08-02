import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { drag } from "d3-drag";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { GitCompareArrows, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type KnowledgeEdge,
  type KnowledgeNode,
  type KnowledgeSourceRef,
} from "./knowledgeGraph";

const KIND_LABELS: Readonly<Record<KnowledgeNode["kind"], string>> =
  Object.freeze({
    entity: "实体",
    setting: "设定",
    entry: "词条",
    heading: "正文标题",
    fact: "事实",
  });

const NODE_COLORS: Readonly<Record<KnowledgeNode["kind"], string>> =
  Object.freeze({
    entity: "#e0935a",
    setting: "#7aa2d8",
    entry: "#8fbf8f",
    heading: "#b89ad8",
    fact: "#d8b07a",
  });

interface GraphNodeDatum extends SimulationNodeDatum {
  readonly id: string;
  readonly label: string;
  readonly kind: KnowledgeNode["kind"];
}

interface GraphLinkDatum extends SimulationLinkDatum<GraphNodeDatum> {
  readonly id: string;
  readonly label: string;
}

interface KnowledgeGraphViewProps {
  readonly nodes: readonly KnowledgeNode[];
  readonly edges: readonly KnowledgeEdge[];
  readonly selectedId: string;
  readonly onSelect: (nodeId: string) => void;
  readonly onOpenSource: (source: KnowledgeSourceRef) => void;
}

/** 图谱视图：d3 力导向 + 右侧检查器。节点超过 200 时按度折叠到前 200。 */
export default function KnowledgeGraphView({
  nodes,
  edges,
  selectedId,
  onSelect,
  onOpenSource,
}: KnowledgeGraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [maxNodes, setMaxNodes] = useState(200);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  // 中心（双击设中心）+ 邻居展开
  const visible = useMemo(() => {
    let base = nodes;
    if (centerId) {
      const neighborIds = new Set<string>([centerId]);
      for (const edge of edges) {
        if (edge.from === centerId) neighborIds.add(edge.to);
        if (edge.to === centerId) neighborIds.add(edge.from);
      }
      base = base.filter((node) => neighborIds.has(node.id));
    }
    if (base.length <= maxNodes) return base;
    // 按度排序折叠
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    return [...base]
      .sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0))
      .slice(0, maxNodes);
  }, [centerId, edges, maxNodes, nodes]);

  const visibleIds = useMemo(() => new Set(visible.map((node) => node.id)), [visible]);
  const visibleEdges = useMemo(
    () =>
      edges.filter(
        (edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to),
      ),
    [edges, visibleIds],
  );

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;
  const selectedNeighbors = useMemo(
    () =>
      selectedNode
        ? edges
            .filter(
              (edge) => edge.from === selectedId || edge.to === selectedId,
            )
            .map((edge) => ({
              edge,
              other: nodes.find(
                (node) =>
                  node.id === (edge.from === selectedId ? edge.to : edge.from),
              ),
            }))
        : [],
    [edges, nodes, selectedId, selectedNode],
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || visible.length === 0) return;
    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 500;

    const nodeData: GraphNodeDatum[] = visible.map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
    }));
    const linkData: GraphLinkDatum[] = visibleEdges.map((edge) => ({
      id: edge.id,
      label: edge.label,
      source: edge.from,
      target: edge.to,
    }));

    const root = select(svg);
    root.selectAll("*").remove();
    const g = root.append("g");

    const simulation = forceSimulation<GraphNodeDatum>(nodeData)
      .force(
        "link",
        forceLink<GraphNodeDatum, GraphLinkDatum>(linkData)
          .id((node) => node.id)
          .distance(110),
      )
      .force("charge", forceManyBody<GraphNodeDatum>().strength(-420))
      .force("center", forceCenter(width / 2, height / 2))
      .force("x", forceX(width / 2).strength(0.06))
      .force("y", forceY(height / 2).strength(0.06))
      .force("collide", forceCollide<GraphNodeDatum>().radius(26));

    const link = g
      .append("g")
      .selectAll("line")
      .data(linkData)
      .join("line")
      .attr("stroke", "var(--line-strong)")
      .attr("stroke-opacity", 0.7);

    const node = g
      .append("g")
      .selectAll<SVGGElement, GraphNodeDatum>("g")
      .data(nodeData)
      .join("g")
      .call(
        drag<SVGGElement, GraphNodeDatum>()
          .on("start", (event, datum) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            datum.fx = datum.x;
            datum.fy = datum.y;
          })
          .on("drag", (event, datum) => {
            datum.fx = event.x;
            datum.fy = event.y;
          })
          .on("end", (event, datum) => {
            if (!event.active) simulation.alphaTarget(0);
            datum.fx = null;
            datum.fy = null;
          }),
      );

    node
      .append("circle")
      .attr("r", 9)
      .attr("fill", (datum) => NODE_COLORS[datum.kind] ?? "#888")
      .attr("stroke", "var(--paper)")
      .attr("stroke-width", 2);

    node
      .append("text")
      .text((datum) => datum.label)
      .attr("x", 14)
      .attr("y", 4)
      .attr("font-size", 11)
      .attr("fill", "var(--ink)");

    node
      .on("click", (event, datum) => {
        event.stopPropagation();
        onSelect(datum.id);
      })
      .on("dblclick", (event, datum) => {
        event.stopPropagation();
        setCenterId((current) => (current === datum.id ? null : datum.id));
      });

    link
      .append("title")
      .text((datum) => `${datum.label}：${(datum.source as GraphNodeDatum).label} ↔ ${(datum.target as GraphNodeDatum).label}`);

    simulation.on("tick", () => {
      link
        .attr("x1", (datum) => (datum.source as GraphNodeDatum).x ?? 0)
        .attr("y1", (datum) => (datum.source as GraphNodeDatum).y ?? 0)
        .attr("x2", (datum) => (datum.target as GraphNodeDatum).x ?? 0)
        .attr("y2", (datum) => (datum.target as GraphNodeDatum).y ?? 0);
      node.attr("transform", (datum) => `translate(${datum.x ?? 0},${datum.y ?? 0})`);
    });

    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });
    root.call(zoomBehavior).call(zoomBehavior.transform, zoomIdentity);

    return () => {
      simulation.stop();
    };
  }, [onSelect, visible, visibleEdges]);

  const showCollapsed = nodes.length > maxNodes && !centerId;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative min-h-0 min-w-0 flex-1">
        <svg
          ref={svgRef}
          className="h-full w-full outline-none"
          viewBox="0 0 800 500"
          role="application"
          aria-label="知识图谱视图（方向键选择节点，回车查看详情）"
          tabIndex={0}
          onKeyDown={(event) => {
            if (visible.length === 0) return;
            if (["ArrowDown", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              setFocusIndex((current) => (current + 1) % visible.length);
              onSelect(visible[(focusIndex + 1) % visible.length].id);
            } else if (["ArrowUp", "ArrowLeft"].includes(event.key)) {
              event.preventDefault();
              setFocusIndex((current) =>
                (current - 1 + visible.length) % visible.length,
              );
              onSelect(visible[(focusIndex - 1 + visible.length) % visible.length].id);
            } else if (event.key === "Enter") {
              event.preventDefault();
              onSelect(visible[focusIndex].id);
            }
          }}
        />
        {showCollapsed && (
          <div className="absolute left-3 top-3 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 text-xs text-[var(--ink-muted)]">
            已折叠到度最高的 {maxNodes} 个节点（共 {nodes.length}）
            <button
              type="button"
              onClick={() => setMaxNodes(Number.POSITIVE_INFINITY)}
              className="ml-2 font-medium text-[var(--accent-cool)] hover:underline"
            >
              显示全部
            </button>
          </div>
        )}
        {centerId && (
          <button
            type="button"
            onClick={() => setCenterId(null)}
            className="absolute right-3 top-3 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            退出中心模式
          </button>
        )}
        <p className="pointer-events-none absolute bottom-3 left-3 text-xs text-[var(--ink-subtle)]">
          单击/方向键选中 · 双击设为中心 · 拖拽调整 · 列表视图可用键盘完整操作
        </p>
      </div>

      <aside className="flex w-72 shrink-0 flex-col border-l border-[var(--line-subtle)] max-lg:hidden">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
          <GitCompareArrows className="h-3.5 w-3.5" />
          节点详情与关系
        </div>
        {!selectedNode ? (
          <p className="p-4 text-xs leading-5 text-[var(--ink-muted)]">
            点击图谱中的节点查看详情；双击节点以其为中心展开邻居。
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <h2 className="text-base font-semibold">{selectedNode.label}</h2>
            <span className="mt-1 inline-block rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
              {KIND_LABELS[selectedNode.kind]}
            </span>
            {selectedNode.description && (
              <p className="mt-3 whitespace-pre-wrap text-xs leading-5 text-[var(--ink-secondary)]">
                {selectedNode.description}
              </p>
            )}
            {selectedNode.sourceRefs.length > 0 && (
              <button
                type="button"
                onClick={() => onOpenSource(selectedNode.sourceRefs[0])}
                className="mt-3 flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 py-1.5 text-xs text-[var(--accent-cool)] hover:bg-[var(--hover-bg)]"
              >
                <GitCompareArrows className="h-3 w-3" />
                编辑来源
              </button>
            )}
            {selectedNeighbors.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xs font-semibold text-[var(--ink-muted)]">
                  直接关系（{selectedNeighbors.length}）
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {selectedNeighbors.map(({ edge, other }) => (
                    <li key={edge.id}>
                      <button
                        type="button"
                        onClick={() => other && onSelect(other.id)}
                        className="w-full rounded-md border border-[var(--line)] px-2.5 py-1.5 text-left text-xs hover:bg-[var(--hover-bg)]"
                      >
                        <span className="block truncate font-medium">
                          {other?.label ?? "（未知节点）"}
                        </span>
                        <span className="mt-0.5 block text-[var(--ink-muted)]">
                          {edge.label}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

// 保证 Loader2 引用（构建中状态由宿主处理）
export { Loader2 };
