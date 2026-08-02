import {
  BookOpen,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  KIND_LABELS,
  type KnowledgeGraphSnapshot,
  type KnowledgeNode,
  type KnowledgeSourceRef,
} from "./knowledgeGraph";

interface WikiViewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly snapshot: KnowledgeGraphSnapshot;
  readonly onOpenSource: (source: KnowledgeSourceRef) => void;
}

/** 稳定实体链接语法：[[kind:id|显示名]]（T15）。 */
export function parseStableEntityLinks(text: string): readonly {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
}[] {
  const links: { kind: string; id: string; label: string }[] = [];
  const pattern = /\[\[([a-zA-Z]+):([a-zA-Z0-9-]+)(?:\|([^\]]+))?\]\]/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    links.push({
      kind: match[1],
      id: match[2],
      label: match[3]?.trim() || match[2],
    });
  }
  return links;
}

function groupNodes(nodes: readonly KnowledgeNode[]): ReadonlyMap<string, KnowledgeNode[]> {
  const groups = new Map<string, KnowledgeNode[]>();
  for (const node of nodes) {
    const list = groups.get(node.kind) ?? [];
    list.push(node);
    groups.set(node.kind, list);
  }
  return groups;
}

export default function WikiView({
  storage,
  projectTitle,
  snapshot,
  onOpenSource,
}: WikiViewProps) {
  const [selectedId, setSelectedId] = useState<string>(
    snapshot.nodes[0]?.id ?? "",
  );
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);

  const groups = useMemo(() => groupNodes(snapshot.nodes), [snapshot.nodes]);
  const selected = snapshot.nodes.find((node) => node.id === selectedId) ?? null;

  // 反向引用：其它节点通过 mentions 边指向选中节点
  const backlinks = useMemo(
    () =>
      selected
        ? snapshot.edges
            .filter(
              (edge) =>
                edge.kind === "mentions" && edge.to === selected.id,
            )
            .map((edge) =>
              snapshot.nodes.find((node) => node.id === edge.from),
            )
            .filter((node): node is KnowledgeNode => Boolean(node))
        : [],
    [selected, snapshot.edges, snapshot.nodes],
  );

  const exportWiki = async () => {
    setExporting(true);
    setExportResult(null);
    try {
      const lines: string[] = [`# ${projectTitle} · 世界百科`, ""];
      for (const node of snapshot.nodes) {
        lines.push(`## ${node.label}`, "");
        lines.push(`> 类型：${KIND_LABELS[node.kind]}`, "");
        if (node.description) lines.push(node.description, "");
        const sources = node.sourceRefs.map((ref) => ref.path).join("、");
        if (sources) lines.push("", `来源：${sources}`);
        lines.push("");
      }
      const content = `${lines.join("\n").trim()}\n`;
      // 导出到 publishing/export/（工作区内、非事实源目录）
      await storage.writeText("publishing/export/wiki.md", content);
      setExportResult("已导出到 publishing/export/wiki.md");
    } catch (cause) {
      setExportResult(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-52 shrink-0 flex-col border-r border-[var(--line-subtle)]">
        <div className="flex h-9 shrink-0 items-center border-b border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
          分类目录
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {[...groups.entries()].map(([kind, nodes]) => (
            <div key={kind} className="mb-2">
              <div className="px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">
                {KIND_LABELS[kind as keyof typeof KIND_LABELS] ?? kind}（{nodes.length}）
              </div>
              {nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => setSelectedId(node.id)}
                  className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
                    selectedId === node.id
                      ? "bg-[var(--accent-cool-subtle)] text-[var(--ink)]"
                      : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                  }`}
                >
                  <FileText className="h-3 w-3 shrink-0 text-[var(--ink-subtle)]" />
                  <span className="truncate">{node.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        {!selected ? (
          <p className="text-sm text-[var(--ink-muted)]">暂无条目</p>
        ) : (
          <article className="mx-auto max-w-3xl">
            <h1 className="text-xl font-semibold">{selected.label}</h1>
            <span className="mt-2 inline-block rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
              {KIND_LABELS[selected.kind]}
            </span>
            {selected.description && (
              <p className="mt-4 whitespace-pre-wrap text-sm leading-6">
                {selected.description}
              </p>
            )}
            <section className="mt-6 border-t border-[var(--line-subtle)] pt-4">
              <h2 className="text-sm font-semibold">来源文件</h2>
              <ul className="mt-2 space-y-1.5">
                {selected.sourceRefs.length === 0 && (
                  <li className="text-xs text-[var(--ink-muted)]">无来源</li>
                )}
                {selected.sourceRefs.map((source, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      onClick={() => onOpenSource(source)}
                      className="flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 py-1.5 text-xs text-[var(--accent-cool)] hover:bg-[var(--hover-bg)]"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {source.path}
                      {source.line ? `:${source.line}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <section className="mt-6 border-t border-[var(--line-subtle)] pt-4">
              <h2 className="text-sm font-semibold">反向引用</h2>
              <ul className="mt-2 space-y-1">
                {backlinks.length === 0 && (
                  <li className="text-xs text-[var(--ink-muted)]">暂无反向引用</li>
                )}
                {backlinks.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(node.id)}
                      className="text-sm text-[var(--accent-cool)] hover:underline"
                    >
                      {node.label}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </article>
        )}
      </main>

      <aside className="flex w-64 shrink-0 flex-col border-l border-[var(--line-subtle)] max-lg:hidden">
        <div className="flex h-9 shrink-0 items-center border-b border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
          百科工具
        </div>
        <div className="space-y-3 p-4 text-xs">
          <p className="leading-5 text-[var(--ink-muted)]">
            百科为面向作者的连续阅读模式，编辑请跳回事实所有者（各库来源按钮）。
          </p>
          <p className="leading-5 text-[var(--ink-muted)]">
            支持稳定实体链接语法{" "}
            <code className="rounded bg-[var(--paper-inset)] px-1 py-0.5">
              [[kind:id|名称]]
            </code>
            ，旧式 [[名称]] 仍可阅读。
          </p>
          <button
            type="button"
            onClick={() => void exportWiki()}
            disabled={exporting}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent-warm)] text-sm font-medium text-white hover:brightness-105 disabled:opacity-45"
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            导出百科
          </button>
          {exportResult && (
            <p className="rounded-md bg-[var(--accent-cool-subtle)] px-2.5 py-1.5 text-[var(--accent-cool)]">
              {exportResult}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

// 保留 RefreshCw/BookOpen 引用（宿主重建入口复用）
export { RefreshCw, BookOpen };
