import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { GitBranch, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CustomSelect, type WorkbenchStorage } from "@/workbench-sdk";

import {
  buildStickyFromInspiration,
  createInspirationBoardRepository,
  type CanvasEdge,
  type CanvasNode,
  type LoadedBoard,
} from "../data-access/inspirationBoard";
import { createNovelInspirationRepository } from "../data-access/inspirationRepository";
import {
  toCanvasNode,
  toInspirationFlowNode,
  type InspirationFlowNode,
} from "./inspirationCanvasAdapters";

interface InspirationCanvasProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
}

function toFlowEdge(edge: CanvasEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label || "推演",
    style: edge.label ? { stroke: "var(--accent-warm)" } : undefined,
  };
}

export default function InspirationCanvas({
  storage,
  projectTitle,
  isActive,
}: InspirationCanvasProps) {
  const repository = useMemo(
    () => createInspirationBoardRepository(storage),
    [storage],
  );
  const inspirationRepository = useMemo(
    () => createNovelInspirationRepository(storage),
    [storage],
  );
  const [boards, setBoards] = useState<readonly { id: string; name: string }[]>(
    [],
  );
  const [boardId, setBoardId] = useState<string | null>(null);
  const [loadedBoard, setLoadedBoard] = useState<LoadedBoard | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<InspirationFlowNode>(
    [],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const openingBoardIdRef = useRef<string | null>(null);

  const loadBoards = useCallback(async () => {
    try {
      const index = await repository.loadIndex();
      setBoards(index.boards);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [repository]);

  useEffect(() => {
    if (!isActive) return;
    void loadBoards();
  }, [isActive, loadBoards]);

  const openBoard = useCallback(
    async (id: string) => {
      setError(null);
      openingBoardIdRef.current = id;
      try {
        const loaded = await repository.loadBoard(id);
        setBoardId(id);
        setLoadedBoard(loaded);
        setNodes(loaded.board.nodes.map(toInspirationFlowNode));
        setEdges(loaded.board.edges.map(toFlowEdge));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (openingBoardIdRef.current === id) {
          openingBoardIdRef.current = null;
        }
      }
    },
    [repository, setEdges, setNodes],
  );

  useEffect(() => {
    if (boardId || openingBoardIdRef.current || boards.length === 0) return;
    void openBoard(boards[0]!.id);
  }, [boardId, boards, openBoard]);

  const createBoard = useCallback(async () => {
    setError(null);
    try {
      const name = window.prompt("画布名称：", "灵感推演板");
      if (!name?.trim()) return;
      const created = await repository.createBoard(name);
      await loadBoards();
      await openBoard(created.board.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [loadBoards, openBoard, repository]);

  const saveBoard = useCallback(async () => {
    if (!loadedBoard) return;
    setSaving(true);
    setError(null);
    try {
      const next: CanvasNode[] = nodes.map(toCanvasNode);
      const nextEdges: CanvasEdge[] = edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label:
          typeof edge.label === "string" && edge.label !== "推演"
            ? edge.label
            : "",
      }));
      const saved = await repository.saveBoard(loadedBoard, {
        ...loadedBoard.board,
        nodes: next,
        edges: nextEdges,
      });
      setLoadedBoard(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [edges, loadedBoard, nodes, repository]);

  const addSticky = useCallback(async () => {
    if (!boardId) return;
    setError(null);
    try {
      // T18：新增便签 → 后台同步创建一条灵感记录
      const title = window.prompt("便签内容：", "新灵感");
      if (!title?.trim()) return;
      const current = await inspirationRepository.load();
      const now = new Date().toISOString();
      const inspiration = {
        id: `insp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        title: title.trim(),
        body: "",
        state: "inbox" as const,
        source: { kind: "manual" as const, label: "灵感画布", uri: "" },
        tags: [],
        createdAt: now,
        updatedAt: now,
      };
      const nextLibrary = {
        ...current.library,
        updatedAt: now,
        items: [inspiration, ...current.library.items],
      };
      await inspirationRepository.save(current, nextLibrary);
      const node = buildStickyFromInspiration(inspiration, {
        x: 40 + nodes.length * 20,
        y: 40 + nodes.length * 16,
      });
      const flowNode: InspirationFlowNode = toInspirationFlowNode(node);
      setNodes((current) => [...current, flowNode]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [boardId, inspirationRepository, nodes.length, setNodes]);

  const deleteBoard = useCallback(async () => {
    if (
      !loadedBoard ||
      !window.confirm(`确认删除画布“${loadedBoard.board.name}”？`)
    ) {
      return;
    }
    setError(null);
    try {
      await repository.deleteBoard(loadedBoard.board.id);
      setBoardId(null);
      setLoadedBoard(null);
      setNodes([]);
      setEdges([]);
      await loadBoards();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [loadBoards, loadedBoard, repository, setEdges, setNodes]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) => addEdge({ ...connection, label: "推演" }, current));
    },
    [setEdges],
  );

  // T19：连线采纳入口——视觉推演默认不产生事实，采纳时提示走 Agent 提案
  const adoptSelection = useCallback(() => {
    setError(null);
    const visualEdges = edges.filter(
      (edge) => !edge.label || edge.label === "推演",
    );
    if (visualEdges.length === 0) {
      setError("没有可采纳的视觉连线（带标记的连线已视为正式关系）。");
      return;
    }
    const nextEdges = edges.map((edge) =>
      !edge.label || edge.label === "推演"
        ? { ...edge, label: "正式", style: { stroke: "var(--accent-warm)" } }
        : edge,
    );
    setEdges(nextEdges);
    setError(
      "已标记为正式关系。请通过 AI 会话（如人物库/势力设计）提交对应领域提案以落库。",
    );
  }, [edges, setEdges]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line)] px-5">
        <GitBranch className="h-4 w-4 text-[var(--accent-warm)]" />
        <h1 className="text-sm font-semibold">灵感画布</h1>
        <span className="text-xs text-[var(--ink-muted)]">{projectTitle}</span>
        <CustomSelect
          value={boardId ?? ""}
          options={[
            { value: "", label: "（选择画布）" },
            ...boards.map((board) => ({ value: board.id, label: board.name })),
          ]}
          onChange={(value) => {
            if (value) void openBoard(value);
          }}
          ariaLabel="选择画布"
          size="sm"
          className="ml-2"
        />
        <button
          type="button"
          onClick={() => void createBoard()}
          className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
        >
          <Plus className="h-3.5 w-3.5" /> 新建画布
        </button>
        {loadedBoard && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void addSticky()}
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
            >
              <Plus className="h-3.5 w-3.5" /> 新建便签
            </button>
            <button
              type="button"
              onClick={adoptSelection}
              title="把视觉连线标记为正式关系（提交对应领域提案以落库）"
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
            >
              <GitBranch className="h-3.5 w-3.5" /> 采纳连线
            </button>
            <button
              type="button"
              onClick={() => void saveBoard()}
              disabled={saving}
              className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-white hover:brightness-105 disabled:opacity-45"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              保存
            </button>
            <button
              type="button"
              onClick={() => void deleteBoard()}
              title="删除当前画布"
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--error)] px-2.5 text-sm text-[var(--error)] hover:bg-[var(--error-bg)]"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除画布
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="shrink-0 border-b border-[var(--line-subtle)] bg-[var(--error-bg)] px-5 py-2 text-sm text-[var(--error)]">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {!boardId ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
            <GitBranch className="h-8 w-8 text-[var(--ink-subtle)]" />
            <p>选择或新建一个画布开始推演</p>
          </div>
        ) : (
          <ReactFlow<InspirationFlowNode, Edge>
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
            <Controls />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
