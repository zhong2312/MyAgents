import {
  Atom,
  BookOpen,
  FileText,
  FolderTree,
  GitBranch,
  Landmark,
  Lightbulb,
  Loader2,
  Map as MapIcon,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { OverlayBackdrop } from "@/workbench-sdk";

import {
  DOMAIN_ENTITY_KIND_LABELS,
  searchDomainIndex,
  type DomainEntityKind,
  type DomainEntityRef,
} from "./domainIndex";
import type { DomainIndex } from "./domainIndex";

const KIND_ICONS: Readonly<Record<DomainEntityKind, LucideIcon>> =
  Object.freeze({
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
    map: MapIcon,
    cultivationSystem: Atom,
    plotLine: Route,
    storyArc: GitBranch,
    narrativeDirectory: FolderTree,
  });

export type QuickCreateKind =
  | "chapter"
  | "character"
  | "faction"
  | "item"
  | "event"
  | "inspiration"
  | "map";

interface QuickCommand {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly createKind?: QuickCreateKind;
}

const QUICK_COMMANDS: readonly QuickCommand[] = Object.freeze([
  {
    id: "new-chapter",
    label: "新建章节",
    icon: BookOpen,
    createKind: "chapter",
  },
  {
    id: "new-character",
    label: "新建人物",
    icon: Users,
    createKind: "character",
  },
  { id: "new-faction", label: "新建势力", icon: Swords, createKind: "faction" },
  { id: "new-item", label: "新建物品", icon: Package, createKind: "item" },
  {
    id: "new-event",
    label: "新建时间线事件",
    icon: Sparkles,
    createKind: "event",
  },
  {
    id: "new-inspiration",
    label: "新建灵感",
    icon: Lightbulb,
    createKind: "inspiration",
  },
  { id: "new-map", label: "新建世界地图", icon: MapIcon, createKind: "map" },
  { id: "search-all", label: "查看全部搜索结果", icon: Search },
]);

interface CommandPaletteProps {
  readonly index: DomainIndex | null;
  readonly isAvailable: boolean;
  readonly onOpen: (ref: DomainEntityRef) => void;
  readonly onShowAll: () => void;
  readonly onCreate: (kind: QuickCreateKind) => void;
}

export default function CommandPalette({
  index,
  isAvailable,
  onOpen,
  onShowAll,
  onCreate,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const handlePaletteRequest = () => {
      setQuery("");
      setActiveIndex(0);
      setOpen(true);
    };
    window.addEventListener("myagents:novel-palette", handlePaletteRequest);
    return () =>
      window.removeEventListener(
        "myagents:novel-palette",
        handlePaletteRequest,
      );
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => {
          const next = !current;
          if (next) {
            setQuery("");
            setActiveIndex(0);
          }
          return next;
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      // 等待面板渲染后聚焦输入框
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(
    () => (index ? searchDomainIndex(index, query, undefined, 8) : []),
    [index, query],
  );

  const openEntity = useCallback(
    (ref: DomainEntityRef) => {
      onOpen(ref);
      setOpen(false);
    },
    [onOpen],
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (results.length === 0) return;
      const target = results[Math.min(activeIndex, results.length - 1)];
      if (target) openEntity(target);
    }
  };

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      "[data-active='true']",
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  const showCommands = !query.trim();

  return (
    <OverlayBackdrop
      onClose={() => setOpen(false)}
      className="z-[400] items-start justify-center bg-black/25 p-0 pt-[12vh]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="全局查找"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              isAvailable
                ? "搜索人物、势力、物品、地点、事件、章节、灵感、资料…"
                : "搜索实体（正文全文搜索仅桌面模式可用）"
            }
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
          />
          <kbd className="shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 text-xs text-[var(--ink-subtle)]">
            Esc
          </kbd>
        </div>

        <ul ref={listRef} className="max-h-80 overflow-y-auto p-2">
          {index === null && (
            <li className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-[var(--ink-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在建立领域索引…
            </li>
          )}
          {index !== null && showCommands && (
            <>
              {QUICK_COMMANDS.map((command, commandIndex) => {
                const Icon = command.icon;
                return (
                  <li key={command.id}>
                    <button
                      type="button"
                      data-active={commandIndex === activeIndex}
                      onMouseEnter={() => setActiveIndex(commandIndex)}
                      onClick={() => {
                        if (command.createKind) {
                          onCreate(command.createKind);
                        } else {
                          onShowAll();
                        }
                        setOpen(false);
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm ${
                        commandIndex === activeIndex
                          ? "bg-[var(--hover-bg)] text-[var(--ink)]"
                          : "text-[var(--ink-secondary)]"
                      }`}
                    >
                      <Icon className="h-4 w-4 text-[var(--ink-subtle)]" />
                      {command.label}
                    </button>
                  </li>
                );
              })}
              {index.entities.length === 0 && (
                <li className="px-3 py-4 text-xs text-[var(--ink-muted)]">
                  项目内暂无实体，可从各模块创建。
                </li>
              )}
            </>
          )}
          {index !== null && !showCommands && results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-[var(--ink-muted)]">
              没有匹配的实体
            </li>
          )}
          {index !== null &&
            !showCommands &&
            results.map((ref, resultIndex) => {
              const Icon = KIND_ICONS[ref.kind];
              return (
                <li key={`${ref.kind}:${ref.id}`}>
                  <button
                    type="button"
                    data-active={resultIndex === activeIndex}
                    onMouseEnter={() => setActiveIndex(resultIndex)}
                    onClick={() => openEntity(ref)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left ${
                      resultIndex === activeIndex ? "bg-[var(--hover-bg)]" : ""
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-[var(--accent-warm)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--ink)]">
                        {ref.name}
                      </span>
                      {ref.summary && (
                        <span className="block truncate text-xs text-[var(--ink-muted)]">
                          {ref.summary}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 rounded-full bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
                      {DOMAIN_ENTITY_KIND_LABELS[ref.kind]}
                    </span>
                  </button>
                </li>
              );
            })}
        </ul>

        <div className="flex items-center justify-between border-t border-[var(--line)] px-4 py-2 text-xs text-[var(--ink-subtle)]">
          <span className="flex items-center gap-3">
            <span>↑↓ 选择</span>
            <span>↵ 打开</span>
            <span>Esc 关闭</span>
          </span>
          {!showCommands && (
            <button
              type="button"
              onClick={() => {
                onShowAll();
                setOpen(false);
              }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              <X className="h-3 w-3" /> 查看全部
            </button>
          )}
        </div>
      </div>
    </OverlayBackdrop>
  );
}
