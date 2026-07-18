import {
  AlertTriangle,
  Check,
  ChevronRight,
  ExternalLink,
  FileText,
  Loader2,
  Network,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  buildKnowledgeGraphFromStorage,
  getKnowledgeNeighbors,
  searchKnowledgeGraph,
  type KnowledgeGraphSnapshot,
  type KnowledgeNode,
  type KnowledgeNodeKind,
  type KnowledgeSearchResult,
  type KnowledgeSourceRef,
} from "./knowledgeGraph";

type KnowledgeFilter = "all" | KnowledgeNodeKind;
type BuildStatus = "idle" | "building" | "ready" | "error";

const KIND_LABELS: Record<KnowledgeNodeKind, string> = {
  entity: "实体",
  setting: "设定",
  entry: "词条",
  heading: "正文标题",
  fact: "事实",
};

function formatSource(source: KnowledgeSourceRef): string {
  if (source.line) return `${source.path} · 第 ${source.line} 行`;
  if (source.jsonPointer) return `${source.path} · ${source.jsonPointer}`;
  return source.path;
}

function resultFromNode(node: KnowledgeNode): KnowledgeSearchResult {
  return { node, score: 0, snippet: node.description, matchedBy: [] };
}

function Toggle({
  enabled,
  disabled,
  onChange,
}: {
  readonly enabled: boolean;
  readonly disabled?: boolean;
  readonly onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="启用知识图谱"
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={`relative h-6 w-11 rounded-full transition-colors ${
        enabled ? "bg-[var(--accent-cool)]" : "bg-[var(--line-strong)]"
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          enabled ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function EmptyState({ enabled }: { readonly enabled: boolean }) {
  return (
    <div className="flex h-full min-h-[360px] items-center justify-center p-8">
      <div className="max-w-md text-center">
        <Network className="mx-auto h-9 w-9 text-[var(--accent-cool)]" />
        <h2 className="mt-4 text-lg font-semibold text-[var(--ink)]">
          {enabled ? "暂无可检索的知识" : "知识图谱已关闭"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
          {enabled
            ? "项目中还没有可解析的设定、正文或知识事实。保存内容后，图谱会在后台重新构建。"
            : "开启后，MyAgents 会从项目 Markdown 与 JSON 事实源派生实体、关系和来源索引，不会修改原始文件。"}
        </p>
      </div>
    </div>
  );
}

export default function KnowledgeBase({
  storage,
  projectTitle,
  enabled,
  onToggle,
  onOpenSource,
}: {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly enabled: boolean;
  readonly onToggle: (enabled: boolean) => Promise<void>;
  readonly onOpenSource: (source: KnowledgeSourceRef) => void;
}) {
  const [snapshot, setSnapshot] = useState<KnowledgeGraphSnapshot | null>(null);
  const [status, setStatus] = useState<BuildStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isToggling, setIsToggling] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<KnowledgeFilter>("all");
  const [selectedId, setSelectedId] = useState("");

  const rebuild = useCallback(async () => {
    if (!enabled || !storage.isAvailable) return;
    setStatus("building");
    setError(null);
    try {
      const next = await buildKnowledgeGraphFromStorage(storage);
      setSnapshot(next);
      setSelectedId((current) => current || next.nodes[0]?.id || "");
      setStatus("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }, [enabled, storage]);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      setStatus("idle");
      setSelectedId("");
      return;
    }
    void rebuild();
    let disposed = false;
    let timer: number | undefined;
    let subscription: Awaited<ReturnType<WorkbenchStorage["watch"]>> | undefined;
    void storage
      .watch(() => {
        if (disposed) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void rebuild(), 1200);
      })
      .then((next) => {
        if (disposed) void next.dispose();
        else subscription = next;
      })
      .catch((cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (subscription) void subscription.dispose();
    };
  }, [enabled, rebuild, storage]);

  const results = useMemo<readonly KnowledgeSearchResult[]>(() => {
    if (!snapshot) return [];
    const kind = filter === "all" ? undefined : filter;
    if (!query.trim()) {
      return snapshot.nodes
        .filter((node) => !kind || node.kind === kind)
        .slice(0, 60)
        .map(resultFromNode);
    }
    return searchKnowledgeGraph(snapshot, query, kind);
  }, [filter, query, snapshot]);

  const selectedResult = results.find((result) => result.node.id === selectedId);
  const selectedNode = selectedResult?.node ?? snapshot?.nodes.find((node) => node.id === selectedId);
  const neighbors = selectedNode && snapshot ? getKnowledgeNeighbors(snapshot, selectedNode.id) : [];

  const changeEnabled = async (next: boolean) => {
    setIsToggling(true);
    setError(null);
    try {
      await onToggle(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--line-subtle)] px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-[var(--ink-muted)]">
            <Network className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
            <span>小说工作台</span>
            <ChevronRight className="h-3 w-3" />
            <span>知识库</span>
          </div>
          <h1 className="mt-1 truncate text-lg font-semibold text-[var(--ink)]">{projectTitle}</h1>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <div className="flex items-center gap-2 text-[var(--ink-muted)]">
            <span>{enabled ? "知识图谱" : "知识图谱已关闭"}</span>
            <Toggle enabled={enabled} disabled={isToggling} onChange={(next) => void changeEnabled(next)} />
          </div>
          {enabled && (
            <button
              type="button"
              onClick={() => void rebuild()}
              disabled={status === "building"}
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line-strong)] px-2.5 text-xs font-medium hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
              title="重新构建知识图谱"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${status === "building" ? "animate-spin" : ""}`} />
              重建
            </button>
          )}
        </div>
      </header>

      {!enabled ? (
        <EmptyState enabled={false} />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line-subtle)] px-5 py-3">
            <div className="relative min-w-[240px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-subtle)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索人物、势力、地点、事件或关系"
                className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] pl-9 pr-9 text-sm outline-none focus:border-[var(--accent-cool)]"
              />
              {query && (
                <button
                  type="button"
                  aria-label="清空搜索"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--ink-muted)] hover:text-[var(--ink)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex h-9 items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-1">
              {(["all", "entity", "setting", "entry", "fact", "heading"] as const).map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => setFilter(item)}
                  className={`h-7 rounded px-2 text-xs ${filter === item ? "bg-[var(--accent-cool)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                >
                  {item === "all" ? "全部" : KIND_LABELS[item]}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] bg-[var(--error-bg)] px-5 py-2 text-xs text-[var(--error)]">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1 truncate">{error}</span>
              <button type="button" onClick={() => void rebuild()} className="font-medium underline">重试</button>
            </div>
          )}

          {status === "building" && !snapshot ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在构建知识图谱
            </div>
          ) : !snapshot || snapshot.nodes.length === 0 ? (
            <EmptyState enabled />
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,0.85fr)_minmax(280px,1.4fr)_minmax(300px,1fr)] divide-x divide-[var(--line-subtle)] max-xl:grid-cols-[minmax(190px,0.8fr)_minmax(260px,1.2fr)_minmax(280px,1fr)] max-lg:grid-cols-[minmax(180px,0.8fr)_minmax(260px,1.2fr)]">
              <section className="min-h-0 overflow-y-auto p-4">
                <div className="flex items-center justify-between text-xs text-[var(--ink-muted)]">
                  <span>{query ? `${results.length} 条结果` : `${snapshot.nodes.length} 个节点`}</span>
                  <span className="flex items-center gap-1 text-[var(--success)]"><Check className="h-3 w-3" /> 已同步</span>
                </div>
                <div className="mt-3 space-y-1.5">
                  {results.map((result) => (
                    <button
                      type="button"
                      key={result.node.id}
                      onClick={() => setSelectedId(result.node.id)}
                      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${selectedId === result.node.id ? "border-[var(--accent-cool)] bg-[var(--hover-bg)]" : "border-transparent hover:border-[var(--line)] hover:bg-[var(--hover-bg)]"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-[var(--ink)]">{result.node.label}</span>
                        <span className="shrink-0 text-xs text-[var(--ink-subtle)]">{KIND_LABELS[result.node.kind]}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--ink-muted)]">{result.snippet}</p>
                    </button>
                  ))}
                  {!results.length && <p className="px-2 py-8 text-center text-xs text-[var(--ink-muted)]">没有匹配结果</p>}
                </div>
              </section>

              <section className="min-h-0 overflow-y-auto p-5">
                {selectedNode ? (
                  <>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-xs text-[var(--ink-muted)]">{KIND_LABELS[selectedNode.kind]}</div>
                        <h2 className="mt-1 text-xl font-semibold text-[var(--ink)]">{selectedNode.label}</h2>
                      </div>
                      <span className="rounded-full bg-[var(--success-bg)] px-2 py-1 text-xs text-[var(--success)]">已索引</span>
                    </div>
                    <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-[var(--ink)]">{selectedNode.description || "暂无描述"}</p>

                    {selectedNode.aliases.length > 0 && (
                      <div className="mt-5">
                        <h3 className="text-xs font-semibold text-[var(--ink-muted)]">别名</h3>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {selectedNode.aliases.map((alias) => <span key={alias} className="rounded border border-[var(--line)] px-2 py-1 text-xs text-[var(--ink-muted)]">{alias}</span>)}
                        </div>
                      </div>
                    )}

                    <div className="mt-6 border-t border-[var(--line-subtle)] pt-5">
                      <h3 className="text-xs font-semibold text-[var(--ink-muted)]">关系</h3>
                      {neighbors.length ? (
                        <div className="mt-2 divide-y divide-[var(--line-subtle)]">
                          {neighbors.map(({ edge, node }) => (
                            <button type="button" key={edge.id} onClick={() => setSelectedId(node.id)} className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-[var(--accent-cool)]">
                              <span className="truncate text-[var(--ink)]">{edge.from === selectedNode.id ? "→" : "←"} {edge.label}</span>
                              <span className="ml-auto truncate text-xs text-[var(--ink-muted)]">{node.label}</span>
                            </button>
                          ))}
                        </div>
                      ) : <p className="mt-2 text-xs text-[var(--ink-muted)]">暂无已识别关系</p>}
                    </div>
                  </>
                ) : <p className="text-sm text-[var(--ink-muted)]">选择一个节点查看详情</p>}
              </section>

              <section className="min-h-0 overflow-y-auto p-5 max-lg:col-span-2 max-lg:border-t max-lg:border-[var(--line-subtle)]">
                {selectedNode ? (
                  <>
                    <h3 className="text-xs font-semibold text-[var(--ink-muted)]">来源文件</h3>
                    <div className="mt-3 space-y-2">
                      {selectedNode.sourceRefs.map((source) => (
                        <div key={`${source.path}:${source.line ?? source.jsonPointer ?? "file"}`} className="rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-3">
                          <div className="flex items-start gap-2">
                            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-cool)]" />
                            <div className="min-w-0 flex-1">
                              <p className="break-all text-xs leading-5 text-[var(--ink)]">{formatSource(source)}</p>
                              <button type="button" onClick={() => onOpenSource(source)} className="mt-2 flex items-center gap-1 text-xs font-medium text-[var(--accent-cool)] hover:underline">
                                打开并定位 <ExternalLink className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-6 border-t border-[var(--line-subtle)] pt-5 text-xs text-[var(--ink-muted)]">
                      <div className="flex justify-between gap-3"><span>节点 ID</span><span className="break-all text-right font-mono text-xs">{selectedNode.id}</span></div>
                      <div className="mt-2 flex justify-between gap-3"><span>图谱更新时间</span><span>{new Date(snapshot.builtAt).toLocaleString("zh-CN")}</span></div>
                    </div>
                  </>
                ) : <p className="text-sm text-[var(--ink-muted)]">暂无来源</p>}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
