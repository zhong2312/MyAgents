import "@xyflow/react/dist/style.css";

import { Download, LoaderCircle } from "lucide-react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ViewportPortal,
  type Connection,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildTopologyElements,
  createTopologyEdgeFeature,
  createTopologyNodeFeature,
  type TopologyEdge,
  type TopologyNode,
} from "../business/topologyMap";
import { mapCanvasBackgroundStyle } from "../business/mapBackgrounds";
import type { MapDocument, MapFeature } from "../entities/mapSchema";
import type { MapCanvasTool } from "../business/mapCanvasSession";
import { downloadMapDocumentPng } from "./mapSceneExporter";

interface XYFlowTopologyCanvasProps {
  readonly document: MapDocument;
  readonly tool: MapCanvasTool;
  readonly activeLayerId: string;
  readonly selectedFeatureId: string | null;
  readonly focusRequest?: number;
  /** 左上扩展时 MapDocument 的坐标重定位，用于保持当前视口稳定。 */
  readonly documentRebase?: {
    readonly revision: number;
    readonly translation: { readonly x: number; readonly y: number };
  } | null;
  readonly timelineCursor: number | null;
  /** 项目素材 URL；导出器使用同一份素材解析结果。 */
  readonly projectArtworkSources?: ReadonlyMap<string, string>;
  readonly onSelect: (featureId: string | null) => void;
  readonly onCreate: (feature: MapFeature) => void;
  readonly onTopologyNodeMove: (
    featureId: string,
    point: { readonly x: number; readonly y: number },
  ) => void;
}

function nextFeatureId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export default function XYFlowTopologyCanvas({
  document,
  tool,
  activeLayerId,
  selectedFeatureId,
  focusRequest = 0,
  documentRebase = null,
  timelineCursor,
  projectArtworkSources,
  onSelect,
  onCreate,
  onTopologyNodeMove,
}: XYFlowTopologyCanvasProps) {
  const instanceRef = useRef<ReactFlowInstance<
    TopologyNode,
    TopologyEdge
  > | null>(null);
  const appliedDocumentRebaseRevisionRef = useRef(0);
  const fittedDocumentIdRef = useRef<string | null>(null);
  const elements = useMemo(
    () => buildTopologyElements(document, timelineCursor),
    [document, timelineCursor],
  );
  const activeLayer = document.layers.find(
    (layer) => layer.id === activeLayerId,
  );
  const canEditLayer = Boolean(activeLayer?.visible && !activeLayer.locked);
  const [nodes, setNodes, onNodesChange] = useNodesState<TopologyNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<TopologyEdge>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const applyDocumentRebase = useCallback(
    (rebase: XYFlowTopologyCanvasProps["documentRebase"]): void => {
      if (
        !rebase ||
        rebase.revision <= appliedDocumentRebaseRevisionRef.current
      ) {
        return;
      }
      const instance = instanceRef.current;
      if (!instance) return;
      const viewport = instance.getViewport();
      void instance.setViewport({
        x: viewport.x - rebase.translation.x * viewport.zoom,
        y: viewport.y - rebase.translation.y * viewport.zoom,
        zoom: viewport.zoom,
      });
      appliedDocumentRebaseRevisionRef.current = rebase.revision;
    },
    [],
  );

  const fitDocumentBounds = useCallback(() => {
    const instance = instanceRef.current;
    if (!instance || fittedDocumentIdRef.current === document.id) return;
    void instance.fitBounds(
      {
        x: 0,
        y: 0,
        width: Math.max(1, document.canvas.width),
        height: Math.max(1, document.canvas.height),
      },
      { padding: 0.08 },
    );
    fittedDocumentIdRef.current = document.id;
  }, [document.canvas.height, document.canvas.width, document.id]);

  useEffect(() => {
    setNodes(
      elements.nodes.map((node) => ({
        ...node,
        selected: node.id === selectedFeatureId,
      })),
    );
    setEdges(
      elements.edges.map((edge) => ({
        ...edge,
        selected: edge.id === selectedFeatureId,
      })),
    );
  }, [elements, selectedFeatureId, setEdges, setNodes]);

  useEffect(() => {
    applyDocumentRebase(documentRebase);
  }, [applyDocumentRebase, documentRebase]);

  useEffect(() => {
    fitDocumentBounds();
  }, [fitDocumentBounds]);

  useEffect(() => {
    if (focusRequest === 0 || !selectedFeatureId) return;
    if (!nodes.some((node) => node.id === selectedFeatureId)) return;
    void instanceRef.current?.fitView({
      nodes: [{ id: selectedFeatureId }],
      padding: 0.6,
      duration: 180,
      maxZoom: 1.5,
    });
  }, [focusRequest, nodes, selectedFeatureId]);

  const handleConnect = (connection: Connection) => {
    if (!canEditLayer || tool !== "route") return;
    const feature = createTopologyEdgeFeature({
      id: nextFeatureId("feature"),
      layerId: activeLayerId,
      connection,
      document,
    });
    if (feature) onCreate(feature);
  };

  const exportMap = useCallback(async () => {
    if (isExporting) return;
    setIsExporting(true);
    setExportError(null);
    try {
      await downloadMapDocumentPng(
        document,
        timelineCursor,
        projectArtworkSources,
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExporting(false);
    }
  }, [document, isExporting, projectArtworkSources, timelineCursor]);

  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden"
      style={mapCanvasBackgroundStyle(document.canvas)}
      aria-label="世界拓扑画布"
    >
      <ReactFlow<TopologyNode, TopologyEdge>
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onInit={(instance) => {
          instanceRef.current = instance;
          fitDocumentBounds();
          applyDocumentRebase(documentRebase);
        }}
        onNodeClick={(_, node) => onSelect(node.id)}
        onEdgeClick={(_, edge) => onSelect(edge.id)}
        onPaneClick={(event) => {
          if (tool === "node" && canEditLayer) {
            const point = instanceRef.current?.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            });
            if (point) {
              onCreate(
                createTopologyNodeFeature({
                  id: nextFeatureId("feature"),
                  layerId: activeLayerId,
                  point,
                }),
              );
            }
            return;
          }
          onSelect(null);
        }}
        onNodeDragStop={(_, node) => {
          onTopologyNodeMove(node.id, {
            x: Math.round(node.position.x),
            y: Math.round(node.position.y),
          });
        }}
        onConnect={handleConnect}
        nodesDraggable={tool === "select"}
        nodesConnectable={tool === "route" && canEditLayer}
        elementsSelectable={tool === "select"}
        // 与地理画布保持一致：显式平移工具允许左键拖动；其它工具仍可用
        // 中键导航，空格临时平移由 React Flow 的 panActivationKeyCode 处理。
        panOnDrag={tool === "pan" ? true : [1]}
        panActivationKeyCode="Space"
        autoPanOnNodeDrag={tool === "select"}
        autoPanSpeed={20}
        selectionOnDrag={tool === "select"}
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        colorMode="light"
        className={tool === "node" ? "cursor-crosshair" : ""}
      >
        <ViewportPortal>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 box-border border border-[#746b6080]"
            style={{
              width: Math.max(1, document.canvas.width),
              height: Math.max(1, document.canvas.height),
            }}
          />
        </ViewportPortal>
        {document.canvas.showGrid && (
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.5}
            color="#8b806f55"
          />
        )}
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => String(node.data.color)}
          maskColor="rgba(245, 240, 229, 0.72)"
          className="!border !border-[#746b6038] !bg-[#fffaf1]"
        />
        <Controls
          showInteractive={false}
          className="!border !border-[#746b6038] !bg-[#fffaf1] !shadow-none"
        />
      </ReactFlow>
      <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => void exportMap()}
          disabled={isExporting}
          title={`导出高清 PNG（${Math.round(document.canvas.width)} × ${Math.round(document.canvas.height)}）`}
          aria-label="导出高清 PNG"
          className="pointer-events-auto grid h-8 w-8 place-items-center rounded-md border border-[#746b6038] bg-[#fffaf1] text-[#51483e] shadow-sm hover:bg-[#eee8dc] disabled:cursor-wait disabled:opacity-55"
        >
          {isExporting ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </button>
        {exportError && (
          <span
            role="status"
            className="max-w-56 rounded border border-[#c7543638] bg-[#fffaf1ee] px-2 py-1 text-right text-xs text-[#9d4735]"
          >
            {exportError}
          </span>
        )}
      </div>
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-md border border-[#746b6038] bg-[#fffaf1dd] px-3 py-2 text-xs text-[#6e6256]">
            选择“拓扑节点”后点击画布创建世界
          </p>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-[#7f736633] bg-[#fffaf1cc] px-2 py-1 text-xs text-[#6e6256]">
        {document.projectionType === "multiverse"
          ? "多元宇宙拓扑"
          : "平行世界分支"}
      </div>
    </div>
  );
}
