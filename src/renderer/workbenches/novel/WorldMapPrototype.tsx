import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Globe2,
  Layers3,
  Loader2,
  Map as MapIcon,
  Network,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CustomSelect,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import {
  parseSettingLibraryMeta,
  parseSettingLibrarySpatialTree,
  type SettingLibrarySpatialTree,
  type SpatialNode,
} from "./settingLibrarySchema";

interface WorldMapPrototypeProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nodeChain(
  nodes: ReadonlyMap<string, SpatialNode>,
  node: SpatialNode,
): SpatialNode[] {
  const chain: SpatialNode[] = [node];
  let current = node.parentId ? nodes.get(node.parentId) : undefined;
  while (current) {
    chain.unshift(current);
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return chain;
}

export default function WorldMapPrototype({
  storage,
  projectTitle,
  isActive,
}: WorldMapPrototypeProps) {
  const [tree, setTree] = useState<SettingLibrarySpatialTree | null>(null);
  const [typeNames, setTypeNames] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [treeContent, metaContent] = await Promise.all([
        storage.readText("world/setting-library/spatial-tree.json").catch(() => null),
        storage.readText("world/setting-library/meta.json").catch(() => null),
      ]);
      const nextTree = treeContent
        ? parseSettingLibrarySpatialTree(treeContent.content)
        : { schemaVersion: 1 as const, nodes: [] as SpatialNode[] };
      setTree(nextTree);
      if (metaContent) {
        const meta = parseSettingLibraryMeta(metaContent.content);
        setTypeNames(
          new Map(meta.levelTypes.map((type) => [type.id, type.name])),
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [storage]);

  useEffect(() => {
    if (!isActive) return;
    void load();
  }, [isActive, load]);

  const nodesById = useMemo(
    () => new Map((tree?.nodes ?? []).map((node) => [node.id, node])),
    [tree],
  );

  const filteredNodes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return null;
    const matched = new Set<string>();
    for (const node of tree?.nodes ?? []) {
      const chain = nodeChain(nodesById, node);
      if (
        chain.some(
          (entry) =>
            entry.name.toLocaleLowerCase("zh-CN").includes(needle) ||
            (typeNames.get(entry.typeId) ?? "")
              .toLocaleLowerCase("zh-CN")
              .includes(needle),
        )
      ) {
        chain.forEach((entry) => matched.add(entry.id));
      }
    }
    return matched;
  }, [nodesById, query, tree, typeNames]);

  const roots = useMemo(
    () =>
      (tree?.nodes ?? [])
        .filter((node) => !node.parentId)
        .sort((left, right) => left.order - right.order),
    [tree],
  );

  const childrenOf = useCallback(
    (parentId: string | null) =>
      (tree?.nodes ?? [])
        .filter((node) => node.parentId === parentId)
        .sort((left, right) => left.order - right.order),
    [tree],
  );

  const selected = selectedId ? nodesById.get(selectedId) : undefined;

  const toggle = (nodeId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const depthStats = useMemo(() => {
    let maxDepth = 0;
    let deepest: SpatialNode | null = null;
    for (const node of tree?.nodes ?? []) {
      const depth = nodeChain(nodesById, node).length;
      if (depth > maxDepth) {
        maxDepth = depth;
        deepest = node;
      }
    }
    return { count: tree?.nodes.length ?? 0, maxDepth, deepest };
  }, [nodesById, tree]);

  const renderNode = (node: SpatialNode, depth: number) => {
    const children = childrenOf(node.id);
    const hasChildren = children.length > 0;
    const isExpanded = expanded.has(node.id);
    const visible =
      !filteredNodes || filteredNodes.has(node.id);
    if (!visible) return null;
    const typeName = typeNames.get(node.typeId) ?? node.typeId;
    return (
      <div key={node.id}>
        <div
          className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors ${
            selectedId === node.id
              ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]"
              : "hover:bg-[var(--hover-bg)]"
          }`}
          style={{ paddingLeft: `${12 + depth * 20}px` }}
        >
          <button
            type="button"
            onClick={() => toggle(node.id)}
            disabled={!hasChildren}
            aria-label={isExpanded ? "收起" : "展开"}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--ink-subtle)] hover:bg-[var(--paper-inset)] disabled:invisible"
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setSelectedId(node.id)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            {depth === 0 ? (
              <Globe2 className="h-4 w-4 shrink-0 text-[var(--accent-warm)]" />
            ) : (
              <Network className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
            )}
            <span className="truncate font-medium">{node.name}</span>
            <span className="shrink-0 rounded-full bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
              {typeName}
            </span>
          </button>
        </div>
        {hasChildren && isExpanded && (
          <div className="border-l border-[var(--line-subtle)]">
            {children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line)] px-5">
        <MapIcon className="h-4 w-4 text-[var(--accent-warm)]" />
        <h1 className="text-sm font-semibold">世界地图</h1>
        <span className="text-xs text-[var(--ink-muted)]">{projectTitle}</span>
        <label className="ml-auto flex h-8 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 focus-within:border-[var(--accent-warm)]">
          <Search className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索空间节点"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ink-subtle)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="清空搜索"
              className="text-[var(--ink-subtle)] hover:text-[var(--ink)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
        <CustomSelect
          value={query ? "filtered" : "all"}
          options={[
            { value: "all", label: `全部节点（${depthStats.count}）` },
            { value: "filtered", label: "仅显示搜索结果" },
          ]}
          onChange={() => {}}
          ariaLabel="地图范围"
          size="toolbar"
          disabled
        />
        <button
          type="button"
          onClick={() => void load()}
          title="刷新地图"
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] bg-[var(--error-bg)] px-5 py-2 text-sm text-[var(--error)]">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex h-40 items-center justify-center text-[var(--ink-muted)]">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !tree || tree.nodes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
              <Layers3 className="h-8 w-8 text-[var(--ink-subtle)]" />
              <p>尚无空间节点。请先在世界架构中创建层级类型与空间节点。</p>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl">
              {roots.map((root) => renderNode(root, 0))}
              {filteredNodes && filteredNodes.size > 0 && (
                <p className="mt-3 text-xs text-[var(--ink-muted)]">
                  搜索结果已高亮显示其父链，共 {filteredNodes.size} 个关联节点
                </p>
              )}
            </div>
          )}
        </main>
        <aside className="flex w-72 shrink-0 flex-col border-l border-[var(--line-subtle)] max-md:hidden">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
            <Globe2 className="h-3.5 w-3.5" />
            节点详情
          </div>
          {!selected ? (
            <p className="p-4 text-xs leading-5 text-[var(--ink-muted)]">
              点击左侧节点查看详情。地图数据来自世界架构的空间节点树（
              world/setting-library/spatial-tree.json）。
            </p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <h2 className="text-base font-semibold">{selected.name}</h2>
              <div className="mt-3 space-y-3 text-xs leading-5">
                <div>
                  <span className="text-[var(--ink-subtle)]">类型</span>
                  <p className="mt-0.5 font-medium">
                    {typeNames.get(selected.typeId) ?? selected.typeId}
                  </p>
                </div>
                <div>
                  <span className="text-[var(--ink-subtle)]">层级路径</span>
                  <p className="mt-0.5">
                    {nodeChain(nodesById, selected)
                      .map((entry) => entry.name)
                      .join(" / ")}
                  </p>
                </div>
                <div>
                  <span className="text-[var(--ink-subtle)]">稳定 ID</span>
                  <p className="mt-0.5 font-mono">{selected.id}</p>
                </div>
                <div>
                  <span className="text-[var(--ink-subtle)]">直接子节点</span>
                  <p className="mt-0.5">
                    {childrenOf(selected.id).length} 个
                  </p>
                </div>
                {depthStats.deepest && (
                  <p className="border-t border-[var(--line-subtle)] pt-3 text-[var(--ink-muted)]">
                    当前地图共 {depthStats.count} 个节点，最深层级{" "}
                    {depthStats.maxDepth} 层（
                    {depthStats.deepest.name}）
                  </p>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
