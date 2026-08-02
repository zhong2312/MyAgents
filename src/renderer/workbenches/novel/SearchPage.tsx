import {
  AlertTriangle,
  BookOpen,
  FileText,
  Landmark,
  Lightbulb,
  Loader2,
  Network,
  Package,
  Route,
  Search,
  Sparkles,
  Swords,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  DOMAIN_ENTITY_KIND_LABELS,
  searchDomainIndex,
  type DomainEntityKind,
  type DomainEntityRef,
} from "./domainIndex";
import type { DomainIndex } from "./domainIndex";
import type { WorkbenchSearch } from "@/workbench-sdk";

const KIND_ICONS: Readonly<Record<DomainEntityKind, LucideIcon>> = Object.freeze({
  character: Users,
  faction: Swords,
  item: Package,
  location: Landmark,
  setting: Network,
  event: Sparkles,
  narrativeChapter: Route,
  chapter: BookOpen,
  inspiration: Lightbulb,
  research: FileText,
});

const KIND_FILTERS: readonly { readonly id: DomainEntityKind | "all"; readonly label: string }[] =
  Object.freeze([
    { id: "all", label: "全部" },
    ...Object.entries(DOMAIN_ENTITY_KIND_LABELS).map(([id, label]) => ({
      id: id as DomainEntityKind,
      label,
    })),
  ]);

interface SearchPageProps {
  readonly index: DomainIndex | null;
  readonly search: WorkbenchSearch;
  readonly onOpen: (ref: DomainEntityRef) => void;
}

export default function SearchPage({ index, search, onOpen }: SearchPageProps) {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<DomainEntityKind | "all">("all");
  const [selected, setSelected] = useState<DomainEntityRef | null>(null);
  const [fileHits, setFileHits] = useState<
    | {
        readonly hits: readonly {
          readonly path: string;
          readonly name: string;
          readonly matchCount: number;
        }[];
        readonly totalMatches: number;
        readonly queryTimeMs: number;
      }
    | null
  >(null);
  const [fileSearching, setFileSearching] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const results = useMemo(
    () =>
      index
        ? searchDomainIndex(
            index,
            query,
            kindFilter === "all" ? undefined : [kindFilter],
            100,
          )
        : [],
    [index, kindFilter, query],
  );

  // 全文文件搜索：仅桌面模式可用，输入停顿后触发（重置在 onChange 中完成）
  useEffect(() => {
    if (!search.isAvailable || !query.trim()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setFileSearching(true);
      setFileError(null);
      void search
        .searchFiles(query, 20, 3)
        .then((result) => {
          if (cancelled) return;
          setFileHits(result);
        })
        .catch((cause) => {
          if (cancelled) return;
          setFileError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (!cancelled) setFileSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, search]);

  const preview = selected;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line)] px-5">
        <Search className="h-4 w-4 text-[var(--accent-warm)]" />
        <h1 className="text-sm font-semibold">全局查找</h1>
        <label className="ml-auto flex h-8 min-w-0 flex-1 max-w-md items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 focus-within:border-[var(--accent-warm)]">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
              setFileHits(null);
              setFileError(null);
            }}
            placeholder="搜索实体或正文内容…"
            autoFocus
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
        <span className="shrink-0 text-xs text-[var(--ink-muted)]">
          {query ? `${results.length} 个实体命中` : "输入关键词开始搜索"}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-44 shrink-0 flex-col border-r border-[var(--line-subtle)]">
          <div className="flex h-9 shrink-0 items-center border-b border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
            类型筛选
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {KIND_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setKindFilter(filter.id)}
                className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                  kindFilter === filter.id
                    ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]"
                    : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                }`}
              >
                {filter.label}
                <span className="ml-auto text-xs text-[var(--ink-subtle)]">
                  {filter.id === "all"
                    ? index?.entities.length ?? 0
                    : (index?.entities.filter((entity) => entity.kind === filter.id)
                        .length ?? 0)}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col border-r border-[var(--line-subtle)]">
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {index === null ? (
              <div className="flex h-40 items-center justify-center text-[var(--ink-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在建立领域索引…
              </div>
            ) : results.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-[var(--ink-muted)]">
                {query ? "没有匹配的实体" : "输入关键词开始搜索"}
              </p>
            ) : (
              <ul className="space-y-1">
                {results.map((ref) => {
                  const Icon = KIND_ICONS[ref.kind];
                  const active = selected?.id === ref.id && selected?.kind === ref.kind;
                  return (
                    <li key={`${ref.kind}:${ref.id}`}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(ref);
                          onOpen(ref);
                        }}
                        className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                          active
                            ? "bg-[var(--hover-bg)]"
                            : "hover:bg-[var(--hover-bg)]"
                        }`}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-[var(--accent-warm)]" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">
                              {ref.name}
                            </span>
                            <span className="shrink-0 rounded-full bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
                              {DOMAIN_ENTITY_KIND_LABELS[ref.kind]}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
                            {ref.summary || ref.sourcePath}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {(fileSearching || fileHits || fileError) && (
              <section className="mt-4 border-t border-[var(--line-subtle)] pt-3">
                <h2 className="flex items-center gap-2 text-xs font-semibold text-[var(--ink-muted)]">
                  <FileText className="h-3.5 w-3.5" />
                  正文文件命中
                  {!search.isAvailable && (
                    <span className="font-normal text-[var(--ink-subtle)]">
                      （仅桌面模式可用）
                    </span>
                  )}
                </h2>
                {fileSearching && (
                  <p className="mt-2 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                    <Loader2 className="h-3 w-3 animate-spin" /> 全文检索中…
                  </p>
                )}
                {fileError && (
                  <p className="mt-2 flex items-center gap-2 text-xs text-[var(--error)]">
                    <AlertTriangle className="h-3 w-3" /> {fileError}
                  </p>
                )}
                {fileHits && fileHits.hits.length === 0 && (
                  <p className="mt-2 text-xs text-[var(--ink-muted)]">
                    正文中没有匹配内容
                  </p>
                )}
                {fileHits && fileHits.hits.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {fileHits.hits.map((hit) => (
                      <li key={hit.path}>
                        <button
                          type="button"
                          onClick={() => {
                            if (hit.path.startsWith("research/")) {
                              onOpen({
                                kind: "research",
                                id: hit.path,
                                name: hit.name.replace(/\.md$/i, ""),
                                aliases: [],
                                summary: "",
                                sourcePath: hit.path,
                                route: "research",
                                focus: { researchPath: hit.path },
                              });
                            }
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-[var(--hover-bg)]"
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                          <span className="min-w-0 flex-1 truncate">
                            {hit.path}
                          </span>
                          <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                            {hit.matchCount} 处
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        </main>

        <aside className="flex w-72 shrink-0 flex-col max-lg:hidden">
          <div className="flex h-9 shrink-0 items-center border-b border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
            预览与来源
          </div>
          {!preview ? (
            <p className="p-4 text-xs leading-5 text-[var(--ink-muted)]">
              点击左侧结果查看实体信息与来源文件；点击会自动定位到对应模块。
            </p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="flex items-center gap-2">
                {(() => {
                  const Icon = KIND_ICONS[preview.kind];
                  return <Icon className="h-4 w-4 text-[var(--accent-warm)]" />;
                })()}
                <h2 className="truncate text-base font-semibold">
                  {preview.name}
                </h2>
              </div>
              <dl className="mt-4 space-y-3 text-xs leading-5">
                <div>
                  <dt className="text-[var(--ink-subtle)]">类型</dt>
                  <dd className="mt-0.5 font-medium">
                    {DOMAIN_ENTITY_KIND_LABELS[preview.kind]}
                  </dd>
                </div>
                {preview.summary && (
                  <div>
                    <dt className="text-[var(--ink-subtle)]">摘要</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap">
                      {preview.summary}
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="text-[var(--ink-subtle)]">来源文件</dt>
                  <dd className="mt-0.5 break-all font-mono">
                    {preview.sourcePath}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--ink-subtle)]">稳定 ID</dt>
                  <dd className="mt-0.5 break-all font-mono">{preview.id}</dd>
                </div>
              </dl>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
