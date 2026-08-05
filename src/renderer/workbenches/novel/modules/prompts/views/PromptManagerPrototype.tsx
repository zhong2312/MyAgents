import {
  AlertTriangle,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  Copy,
  FileText,
  FilePlus2,
  Filter,
  Folder,
  FolderPlus,
  FolderTree,
  Github,
  Globe2,
  Loader2,
  Package,
  PackagePlus,
  Pencil,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Tags,
  TestTube2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CustomSelect } from "@/workbench-sdk";

import MarkdownVisualEditor from "../../../MarkdownVisualEditor";
import { NOVEL_GENRES } from "../../../novelGenres";
import { createDefaultPromptLibraryModel } from "../business/promptLibraryDefaults";
import type {
  PromptDefinition,
  PromptGroup,
  PromptLibraryModel,
  PromptScope,
  PromptSkillPack,
} from "../entities/promptLibrarySchema";
import {
  detectPromptConflicts,
  resolvePromptActivation,
  type PromptActivation,
} from "../business/promptLibraryResolver";

export {
  detectPromptConflicts,
  resolvePromptActivation,
} from "../business/promptLibraryResolver";

export type {
  PromptDefinition,
  PromptGroup,
  PromptLibraryModel,
  PromptScope,
  PromptSkillPack,
} from "../entities/promptLibrarySchema";

type PromptView = "overview" | "active";

const GENRES = NOVEL_GENRES;

const DEFAULT_PROMPT_LIBRARY = createDefaultPromptLibraryModel();

const INITIAL_GROUPS = DEFAULT_PROMPT_LIBRARY.groups;
const INITIAL_SKILL_PACKS = DEFAULT_PROMPT_LIBRARY.packs;
const INITIAL_PROMPTS = DEFAULT_PROMPT_LIBRARY.prompts;

function formatScope(scope: PromptScope): string {
  return scope.kind === "global"
    ? "全局"
    : scope.genres.length > 0
      ? scope.genres.join("、")
      : "未选择题材";
}

interface PromptGroupTreeItem {
  readonly group: PromptGroup;
  readonly depth: number;
}

function flattenGroupTree(
  groups: readonly PromptGroup[],
  rootIds?: readonly string[],
): readonly PromptGroupTreeItem[] {
  const childrenByParent = new Map<string | null, PromptGroup[]>();
  for (const group of groups) {
    const siblings = childrenByParent.get(group.parentId) ?? [];
    siblings.push(group);
    childrenByParent.set(group.parentId, siblings);
  }

  const result: PromptGroupTreeItem[] = [];
  const visited = new Set<string>();
  const visit = (group: PromptGroup, depth: number) => {
    if (visited.has(group.id)) return;
    visited.add(group.id);
    result.push({ group, depth });
    for (const child of childrenByParent.get(group.id) ?? []) {
      visit(child, depth + 1);
    }
  };

  const roots = rootIds
    ? rootIds
        .map((id) => groups.find((group) => group.id === id))
        .filter((group): group is PromptGroup => Boolean(group))
    : (childrenByParent.get(null) ?? []);
  for (const root of roots) visit(root, 0);
  return result;
}

function getGroupLineage(
  group: PromptGroup,
  groups: readonly PromptGroup[],
): readonly PromptGroup[] {
  const lineage: PromptGroup[] = [];
  const visited = new Set<string>();
  let current: PromptGroup | undefined = group;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    lineage.unshift(current);
    current = current.parentId
      ? groups.find((candidate) => candidate.id === current?.parentId)
      : undefined;
  }
  return lineage;
}

function getGroupSubtreeIds(
  groupId: string,
  groups: readonly PromptGroup[],
): readonly string[] {
  const result: string[] = [];
  const visit = (id: string) => {
    result.push(id);
    groups
      .filter((group) => group.parentId === id)
      .forEach((group) => visit(group.id));
  };
  visit(groupId);
  return result;
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={onChange}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
        checked
          ? "border-[var(--accent-cool)] bg-[var(--accent-cool)]"
          : "border-[var(--line-strong)] bg-[var(--paper-inset)]"
      }`}
    >
      <span
        className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-[left] ${
          checked ? "left-[22px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

function Tag({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex min-h-5 items-center rounded border border-[var(--line)] bg-[var(--paper)] px-1.5 text-xs text-[var(--ink-muted)]">
      {children}
    </span>
  );
}

function ScopeBadge({
  scope,
  source,
}: {
  readonly scope: PromptScope;
  readonly source?: "prompt" | "group";
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs text-[var(--accent-cool)]">
      {scope.kind === "global" ? (
        <Globe2 className="h-3 w-3 shrink-0" />
      ) : (
        <Tags className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">{formatScope(scope)}</span>
      {source === "prompt" && (
        <span className="shrink-0 text-[var(--accent-warm)]">覆盖</span>
      )}
    </span>
  );
}

function GenrePicker({
  selected,
  onToggle,
  compact = false,
}: {
  readonly selected: readonly string[];
  readonly onToggle: (genre: string) => void;
  readonly compact?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {GENRES.map((genre) => {
        const active = selected.includes(genre);
        return (
          <button
            key={genre}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(genre)}
            className={`${compact ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-xs"} rounded border transition-colors ${
              active
                ? "border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)] text-[var(--accent-cool)]"
                : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
            }`}
          >
            {active && <Check className="mr-1 inline h-3 w-3" />}
            {genre}
          </button>
        );
      })}
    </div>
  );
}

function ScopeEditor({
  value,
  inheritedScope,
  onChange,
  compact = false,
}: {
  readonly value: PromptScope | null;
  readonly inheritedScope: PromptScope;
  readonly onChange: (scope: PromptScope | null) => void;
  readonly compact?: boolean;
}) {
  const mode = value?.kind ?? "inherit";
  const genreValues = value?.kind === "genres" ? value.genres : [];
  const [showGenres, setShowGenres] = useState(
    !compact && value?.kind === "genres",
  );
  return (
    <div className={compact ? "relative min-w-0" : undefined}>
      <div
        className={`grid grid-cols-3 gap-1 rounded-md bg-[var(--paper-inset)] ${
          compact ? "w-56 p-0.5" : "p-1"
        }`}
      >
        {(
          [
            ["inherit", "继承分组"],
            ["global", "全局"],
            ["genres", "指定题材"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            onClick={() => {
              if (id === "inherit") onChange(null);
              else if (id === "global") onChange({ kind: "global" });
              else {
                onChange({ kind: "genres", genres: genreValues });
                setShowGenres(true);
              }
            }}
            className={`${compact ? "h-7" : "h-8"} rounded text-xs font-medium ${
              mode === id
                ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm"
                : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
            }`}
          >
            {compact && id === "inherit" ? "继承" : label}
          </button>
        ))}
      </div>
      {!compact && mode === "inherit" && (
        <div className="mt-2 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
          <FolderTree className="h-3.5 w-3.5" />
          当前继承：{formatScope(inheritedScope)}
        </div>
      )}
      {value?.kind === "genres" && !showGenres && (
        <button
          type="button"
          onClick={() => setShowGenres(true)}
          className="mt-1 text-xs font-medium text-[var(--accent-cool)]"
        >
          {genreValues.length > 0 ? `${genreValues.length} 个题材` : "选择题材"}
        </button>
      )}
      {value?.kind === "genres" && showGenres && (
        <div
          className={
            compact
              ? "absolute left-0 top-[calc(100%+0.5rem)] z-30 w-[min(30rem,calc(100vw-2rem))] rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-3 shadow-lg max-sm:-left-20 max-sm:w-[calc(100vw-4.5rem)]"
              : "mt-3"
          }
        >
          {compact && (
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-[var(--ink-muted)]">
                适用题材
              </span>
              <span className="text-xs text-[var(--ink-subtle)]">
                已选 {genreValues.length} 项
              </span>
            </div>
          )}
          <GenrePicker
            compact
            selected={genreValues}
            onToggle={(genre) =>
              onChange({
                kind: "genres",
                genres: genreValues.includes(genre)
                  ? genreValues.filter((item) => item !== genre)
                  : [...genreValues, genre],
              })
            }
          />
          {compact && (
            <button
              type="button"
              onClick={() => setShowGenres(false)}
              className="mt-2 h-7 rounded-md border border-[var(--line)] px-2.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
            >
              完成
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PromptNavigation({
  prompts,
  groups,
  packs,
  selectedId,
  query,
  onQueryChange,
  onSelect,
  onToggleGroup,
}: {
  readonly prompts: readonly PromptDefinition[];
  readonly groups: readonly PromptGroup[];
  readonly packs: readonly PromptSkillPack[];
  readonly selectedId: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onToggleGroup: (id: string) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<readonly string[]>(() =>
    groups.map((group) => group.id),
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const promptMatches = (prompt: PromptDefinition) =>
    !normalizedQuery ||
    prompt.name.toLocaleLowerCase().includes(normalizedQuery) ||
    prompt.id.toLocaleLowerCase().includes(normalizedQuery) ||
    prompt.sourcePath?.toLocaleLowerCase().includes(normalizedQuery);

  const groupMatches = (group: PromptGroup): boolean => {
    if (!normalizedQuery) return true;
    if (
      group.name.toLocaleLowerCase().includes(normalizedQuery) ||
      group.sourcePath?.toLocaleLowerCase().includes(normalizedQuery) ||
      prompts.some(
        (prompt) => prompt.groupId === group.id && promptMatches(prompt),
      )
    ) {
      return true;
    }
    return groups
      .filter((candidate) => candidate.parentId === group.id)
      .some(groupMatches);
  };

  const isVisibleByExpansion = (group: PromptGroup) => {
    if (normalizedQuery) return true;
    let parentId = group.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (!expandedIds.includes(parentId)) return false;
      parentId =
        groups.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
    return true;
  };

  const sections = [
    {
      id: "skill-packs",
      label: "技能包",
      roots: groups
        .filter((group) => group.parentId === null)
        .map((group) => group.id),
    },
  ] as const;

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)] max-md:hidden">
      <div className="border-b border-[var(--line)] p-3">
        <label className="flex h-8 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 focus-within:border-[var(--accent-cool)]">
          <Search className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
          <span className="sr-only">搜索提示词</span>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索名称或 ID"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--ink-subtle)]"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {sections.map((section) => {
          const treeItems = flattenGroupTree(groups, section.roots).filter(
            ({ group }) => groupMatches(group) && isVisibleByExpansion(group),
          );
          if (treeItems.length === 0) return null;
          return (
            <section key={section.id} className="mb-4">
              <h2 className="px-3 pb-1 pt-2 text-xs font-semibold text-[var(--ink-subtle)]">
                {section.label}
              </h2>
              {treeItems.map(({ group, depth }) => {
                const children = groups.filter(
                  (candidate) => candidate.parentId === group.id,
                );
                const subtreeIds = getGroupSubtreeIds(group.id, groups);
                const subtreePromptCount = prompts.filter((prompt) =>
                  subtreeIds.includes(prompt.groupId),
                ).length;
                const groupPrompts = prompts.filter(
                  (prompt) =>
                    prompt.groupId === group.id &&
                    (promptMatches(prompt) ||
                      group.name.toLocaleLowerCase().includes(normalizedQuery)),
                );
                const expanded = expandedIds.includes(group.id);
                const GroupIcon =
                  group.nodeKind === "pack-root" ? Package : Folder;
                return (
                  <div key={group.id}>
                    <div
                      className="flex h-8 items-center gap-1.5 pr-3 text-xs hover:bg-[var(--hover-bg)]"
                      style={{ paddingLeft: 8 + depth * 14 }}
                    >
                      {children.length > 0 ? (
                        <button
                          type="button"
                          aria-label={`${expanded ? "收起" : "展开"}分组 ${group.name}`}
                          onClick={() =>
                            setExpandedIds((current) =>
                              current.includes(group.id)
                                ? current.filter((id) => id !== group.id)
                                : [...current, group.id],
                            )
                          }
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--ink-subtle)] hover:text-[var(--ink)]"
                        >
                          <ChevronRight
                            className={`h-3.5 w-3.5 transition-transform ${expanded || normalizedQuery ? "rotate-90" : ""}`}
                          />
                        </button>
                      ) : (
                        <span className="w-6 shrink-0" />
                      )}
                      <GroupIcon
                        className={`h-3.5 w-3.5 shrink-0 ${
                          group.nodeKind === "pack-root"
                            ? "text-[var(--accent-warm)]"
                            : "text-[var(--accent-cool)]"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {group.name}
                      </span>
                      {subtreePromptCount > 0 && (
                        <span className="text-[var(--ink-subtle)]">
                          {subtreePromptCount}
                        </span>
                      )}
                      <button
                        type="button"
                        aria-label={`${group.enabled ? "停用" : "启用"}分组 ${group.name}`}
                        title={group.enabled ? "已启用" : "已停用"}
                        onClick={() => onToggleGroup(group.id)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center"
                      >
                        <span
                          className={`h-2 w-2 rounded-full ${
                            group.enabled
                              ? "bg-[var(--success)]"
                              : "bg-[var(--ink-subtle)]"
                          }`}
                        />
                      </button>
                    </div>
                    {(expanded || normalizedQuery) &&
                      groupPrompts.map((prompt) => {
                        const promptPack = packs.find(
                          (pack) => pack.id === prompt.skillPackId,
                        );
                        const detail = prompt.sourcePath
                          ? prompt.sourcePath.split("/").at(-1)
                          : (promptPack?.name ?? "未知安装副本");
                        return (
                          <button
                            key={prompt.instanceId}
                            type="button"
                            onClick={() => onSelect(prompt.instanceId)}
                            style={{ paddingLeft: 40 + depth * 14 }}
                            className={`flex w-full items-center gap-2 py-2 pr-4 text-left transition-colors ${
                              selectedId === prompt.instanceId
                                ? "bg-[var(--accent-cool-subtle)] shadow-[inset_3px_0_0_var(--accent-cool)]"
                                : "hover:bg-[var(--hover-bg)]"
                            }`}
                          >
                            <FileText
                              className={`h-3.5 w-3.5 shrink-0 ${
                                prompt.enabled
                                  ? "text-[var(--ink-muted)]"
                                  : "text-[var(--ink-subtle)]"
                              }`}
                            />
                            <span className="min-w-0 flex-1">
                              <strong
                                className={`block truncate text-xs font-medium ${
                                  prompt.enabled
                                    ? ""
                                    : "text-[var(--ink-subtle)]"
                                }`}
                              >
                                {prompt.name}
                              </strong>
                              <span className="block truncate font-mono text-xs text-[var(--ink-subtle)]">
                                {detail}
                              </span>
                            </span>
                            {prompt.scopeOverride && (
                              <CircleDot
                                className="h-3 w-3 shrink-0 text-[var(--accent-warm)]"
                                aria-label="已覆盖分组作用域"
                              />
                            )}
                          </button>
                        );
                      })}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function PromptEditor({
  selected,
  group,
  pack,
  allGroups,
  onUpdate,
  onSave,
}: {
  readonly selected: PromptDefinition;
  readonly group: PromptGroup;
  readonly pack: PromptSkillPack;
  readonly allGroups: readonly PromptGroup[];
  readonly onUpdate: (update: Partial<PromptDefinition>) => void;
  readonly onSave: () => Promise<void>;
}) {
  const [tested, setTested] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const effectiveScope = selected.scopeOverride ?? group.scope;
  const groupPath = getGroupLineage(group, allGroups);

  const savePrompt = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setSaved(false);
    try {
      await onSave();
      setSaved(true);
    } catch {
      setSaved(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-3 max-sm:px-3">
        <div className="flex items-start gap-3 max-sm:flex-wrap">
          <div className="min-w-0 flex-1">
            <div
              aria-label="完整分组路径"
              className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-[var(--ink-muted)]"
            >
              {groupPath.map((pathGroup, index) => (
                <span key={pathGroup.id} className="contents">
                  {index > 0 && (
                    <ChevronRight className="h-3 w-3 shrink-0 text-[var(--ink-subtle)]" />
                  )}
                  <span className="break-all">{pathGroup.name}</span>
                </span>
              ))}
              <ChevronRight className="h-3 w-3 shrink-0 text-[var(--ink-subtle)]" />
              <span className="break-all font-mono text-[var(--ink-subtle)]">
                {selected.id}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 text-base font-semibold">
                {selected.name}
              </h1>
              <Tag>v{selected.version}</Tag>
              <Tag>
                <Package className="mr-1 h-3 w-3" /> {pack.name}
              </Tag>
              {selected.overridden && <Tag>已修改</Tag>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">
            {tested && (
              <span className="flex items-center gap-1 text-xs text-[var(--success)] max-lg:hidden">
                <CheckCircle2 className="h-3.5 w-3.5" /> 试运行通过
              </span>
            )}
            {saved && (
              <span className="text-xs text-[var(--success)] max-lg:hidden">
                已保存
              </span>
            )}
            <Toggle
              checked={selected.enabled}
              label={`${selected.enabled ? "停用" : "启用"}提示词 ${selected.name}`}
              onChange={() => onUpdate({ enabled: !selected.enabled })}
            />
            <button
              type="button"
              onClick={() => setTested(true)}
              aria-label="试运行"
              title="试运行"
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm max-sm:w-8 max-sm:justify-center max-sm:px-0"
            >
              <TestTube2 className="h-3.5 w-3.5" />
              <span className="max-sm:hidden">试运行</span>
            </button>
            <button
              type="button"
              onClick={() => void savePrompt()}
              disabled={isSaving}
              aria-label="保存提示词"
              title="保存提示词"
              className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-2.5 text-sm font-medium text-white max-sm:w-8 max-sm:justify-center max-sm:px-0"
            >
              {isSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              <span className="max-sm:hidden">
                {isSaving ? "保存中" : "保存"}
              </span>
            </button>
          </div>
        </div>
      </header>

      <div className="flex min-h-10 shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-1 max-sm:flex-wrap max-sm:gap-2 max-sm:px-3">
        <div className="flex h-7 shrink-0 items-center gap-2">
          <Tags className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
          <span className="text-xs font-medium text-[var(--ink-muted)]">
            作用域
          </span>
          <span className="max-sm:hidden">
            <ScopeBadge
              scope={effectiveScope}
              source={selected.scopeOverride ? "prompt" : "group"}
            />
          </span>
        </div>
        <ScopeEditor
          compact
          value={selected.scopeOverride}
          inheritedScope={group.scope}
          onChange={(scopeOverride) => {
            setSaved(false);
            onUpdate({ scopeOverride, overridden: true });
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col bg-[var(--paper)]">
        <MarkdownVisualEditor
          pageId={selected.instanceId}
          label="提示词正文"
          value={selected.content}
          placeholder="开始编写提示词……"
          fullWidth
          onSave={() => void savePrompt()}
          onChange={(content) => {
            setSaved(false);
            onUpdate({ content, overridden: true });
          }}
        />
      </div>
    </section>
  );
}

function ActiveSetView({
  activations,
  installationCount,
  projectGenres,
  onToggleGenre,
  onSelect,
  onResolveConflict,
}: {
  readonly activations: readonly PromptActivation[];
  readonly installationCount: number;
  readonly projectGenres: readonly string[];
  readonly onToggleGenre: (genre: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onResolveConflict: (
    winnerInstanceId: string,
    conflictingInstanceIds: readonly string[],
  ) => void;
}) {
  const [showExcluded, setShowExcluded] = useState(false);
  const active = activations.filter((activation) => activation.active);
  const excluded = activations.filter((activation) => !activation.active);
  const conflicts = detectPromptConflicts(activations);
  const conflictingInstanceIds = new Set(
    conflicts.flatMap((conflict) =>
      conflict.activations.map((activation) => activation.prompt.instanceId),
    ),
  );
  const executable = active.filter(
    (activation) => !conflictingInstanceIds.has(activation.prompt.instanceId),
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-5 max-sm:px-4">
        <section className="border-b border-[var(--line)] pb-5">
          <div className="flex items-start gap-4 max-md:flex-col">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
                  <Filter className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold">烬海编年史</h2>
                  <p className="text-xs text-[var(--ink-muted)]">
                    当前项目题材决定最终参与 Agent 请求的提示词
                  </p>
                </div>
              </div>
            </div>
            <div className="grid min-w-[24rem] grid-cols-4 divide-x divide-[var(--line)] rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] max-sm:min-w-0 max-sm:w-full">
              {[
                [String(active.length), "用户启用"],
                [String(excluded.length), "排除"],
                [String(conflicts.length), "冲突"],
                [String(installationCount), "安装副本"],
              ].map(([value, label]) => (
                <div key={label} className="px-3 py-2 text-center">
                  <strong className="block text-base">{value}</strong>
                  <span className="text-xs text-[var(--ink-muted)]">
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--ink-muted)]">
              <Tags className="h-3.5 w-3.5" /> 当前小说题材
            </div>
            <GenrePicker selected={projectGenres} onToggle={onToggleGenre} />
          </div>
        </section>

        {conflicts.length > 0 && (
          <section className="border-b border-[var(--line)] py-5">
            <div className="flex items-start gap-3 rounded-md border border-[var(--warning)] bg-[var(--warning-bg)] px-4 py-3 text-[var(--warning)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">
                  检测到 {conflicts.length} 组提示词冲突
                </h2>
                <p className="mt-0.5 text-xs leading-5">
                  同一稳定 ID 被多个安装副本同时启用。冲突项不会进入 Agent
                  请求，请为每组冲突选择一个保留副本。
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {conflicts.map((conflict) => {
                const conflictIds = conflict.activations.map(
                  (activation) => activation.prompt.instanceId,
                );
                return (
                  <article
                    key={conflict.promptId}
                    className="overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)]"
                  >
                    <header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--warning-bg)] text-[var(--warning)]">
                        <AlertTriangle className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold">
                          {conflict.activations[0]?.prompt.name}
                        </h3>
                        <p className="truncate font-mono text-xs text-[var(--ink-muted)]">
                          {conflict.promptId}
                        </p>
                      </div>
                      <Tag>{conflict.activations.length} 个副本</Tag>
                    </header>
                    <div className="divide-y divide-[var(--line-subtle)]">
                      {conflict.activations.map((activation) => (
                        <div
                          key={activation.prompt.instanceId}
                          className="flex items-center gap-3 px-4 py-3 max-sm:flex-wrap"
                        >
                          <Package className="h-4 w-4 shrink-0 text-[var(--accent-cool)]" />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <strong className="truncate text-sm font-medium">
                                {activation.pack.name}
                              </strong>
                              <Tag>v{activation.pack.version}</Tag>
                              {activation.pack.modified && <Tag>已修改</Tag>}
                            </div>
                            <p className="mt-0.5 truncate font-mono text-xs text-[var(--ink-subtle)]">
                              {activation.pack.id}
                            </p>
                          </div>
                          <button
                            type="button"
                            aria-label={`保留 ${activation.pack.name}，处理 ${conflict.promptId} 冲突`}
                            onClick={() =>
                              onResolveConflict(
                                activation.prompt.instanceId,
                                conflictIds,
                              )
                            }
                            className="h-8 shrink-0 rounded-md bg-[var(--accent-warm)] px-3 text-xs font-medium text-white max-sm:ml-7"
                          >
                            保留此副本
                          </button>
                        </div>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        <section className="py-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">最终启用顺序</h2>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                仅列出完成启停、目录、作用域和冲突解析后的可执行项
              </p>
            </div>
            <span className="rounded bg-[var(--success-bg)] px-2 py-1 text-xs font-medium text-[var(--success)]">
              {executable.length} 项可执行
            </span>
          </div>
          <div className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--paper-elevated)]">
            {executable.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-[var(--ink-muted)]">
                {conflicts.length > 0
                  ? "请先处理上方冲突"
                  : "当前题材下没有可用提示词"}
              </div>
            ) : (
              executable.map((activation, index) => (
                <button
                  key={activation.prompt.instanceId}
                  type="button"
                  onClick={() => onSelect(activation.prompt.instanceId)}
                  className="grid w-full grid-cols-[2.5rem_minmax(12rem,1fr)_minmax(9rem,0.8fr)_minmax(10rem,1fr)_1.25rem] items-center gap-3 border-b border-[var(--line-subtle)] px-4 py-3 text-left last:border-b-0 hover:bg-[var(--hover-bg)] max-lg:grid-cols-[2.5rem_minmax(0,1fr)_1.25rem]"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded bg-[var(--paper-inset)] font-mono text-xs text-[var(--ink-muted)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-medium">
                      {activation.prompt.name}
                    </strong>
                    <span className="block truncate font-mono text-xs text-[var(--ink-subtle)]">
                      {activation.prompt.id}
                    </span>
                  </span>
                  <span className="max-lg:hidden">
                    <ScopeBadge
                      scope={activation.effectiveScope}
                      source={activation.scopeSource}
                    />
                  </span>
                  <span className="min-w-0 max-lg:hidden">
                    <span className="block truncate text-xs">
                      {activation.pack.name}
                    </span>
                    <span
                      className={`mt-0.5 block text-xs ${
                        activation.scopeSource === "prompt"
                          ? "text-[var(--accent-warm)]"
                          : "text-[var(--ink-muted)]"
                      }`}
                    >
                      {activation.reason}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-[var(--ink-subtle)]" />
                </button>
              ))
            )}
          </div>
        </section>

        <section className="border-t border-[var(--line)] pt-4">
          <button
            type="button"
            aria-expanded={showExcluded}
            onClick={() => setShowExcluded((value) => !value)}
            className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium"
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${showExcluded ? "" : "-rotate-90"}`}
            />
            被排除的提示词
            <span className="text-xs font-normal text-[var(--ink-muted)]">
              {excluded.length}
            </span>
          </button>
          {showExcluded && (
            <div className="mt-2 divide-y divide-[var(--line-subtle)] border-y border-[var(--line-subtle)]">
              {excluded.map((activation) => (
                <div
                  key={activation.prompt.instanceId}
                  className="grid grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)] gap-4 px-3 py-3 text-xs max-sm:grid-cols-1 max-sm:gap-1"
                >
                  <span className="min-w-0 truncate text-[var(--ink-muted)]">
                    {activation.prompt.name}
                  </span>
                  <span className="min-w-0 text-[var(--warning)]">
                    {activation.reason}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

interface PromptInput {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly skillPackId: string;
  readonly groupId: string;
  readonly scopeOverride: PromptScope | null;
}

function PromptCreateDialog({
  groups,
  packs,
  onClose,
  onCreate,
}: {
  readonly groups: readonly PromptGroup[];
  readonly packs: readonly PromptSkillPack[];
  readonly onClose: () => void;
  readonly onCreate: (input: PromptInput) => void;
}) {
  const packsWithDirectories = packs.filter((pack) =>
    groups.some(
      (group) =>
        group.skillPackId === pack.id && group.nodeKind === "directory",
    ),
  );
  const defaultPackId = packsWithDirectories[0]?.id ?? "";
  const getDirectoryItems = (skillPackId: string) =>
    flattenGroupTree(
      groups.filter((group) => group.skillPackId === skillPackId),
    ).filter(({ group }) => group.nodeKind === "directory");
  const defaultDirectoryItems = getDirectoryItems(defaultPackId);
  const [name, setName] = useState("");
  const [promptId, setPromptId] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [skillPackId, setSkillPackId] = useState(defaultPackId);
  const [groupId, setGroupId] = useState(
    defaultDirectoryItems[0]?.group.id ?? "",
  );
  const [scopeOverride, setScopeOverride] = useState<PromptScope | null>(null);
  const directoryItems = getDirectoryItems(skillPackId);
  const selectedGroup = groups.find((group) => group.id === groupId);
  const validPromptId = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(promptId);
  const canSubmit = Boolean(
    name.trim() && validPromptId && version.trim() && skillPackId && groupId,
  );

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-lg border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-xl">
        <header className="flex h-14 items-center gap-3 border-b border-[var(--line)] px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
            <FilePlus2 className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">新增提示词</h2>
            <p className="text-xs text-[var(--ink-muted)]">
              选择技能包与目录后，在主编辑区编写 Markdown 正文
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭提示词弹窗"
            title="关闭"
            onClick={onClose}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              提示词名称
            </span>
            <input
              aria-label="提示词名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：章节续写"
              className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none focus:border-[var(--accent-warm)]"
            />
          </label>

          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-4 max-sm:grid-cols-1">
            <label>
              <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                稳定 ID
              </span>
              <input
                aria-label="稳定 ID"
                value={promptId}
                onChange={(event) => setPromptId(event.target.value)}
                placeholder="novel.chapter.continue"
                className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 font-mono text-xs outline-none focus:border-[var(--accent-warm)]"
              />
              {promptId && !validPromptId && (
                <span className="mt-1 block text-xs text-[var(--error)]">
                  仅允许字母、数字、点、短横线和下划线
                </span>
              )}
            </label>
            <label>
              <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                当前版本
              </span>
              <input
                aria-label="当前版本"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-xs outline-none focus:border-[var(--accent-warm)]"
              />
            </label>
          </div>

          {packsWithDirectories.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning)]">
              <AlertTriangle className="h-3.5 w-3.5" />
              请先创建技能包和目录
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
              <div>
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  所属技能包
                </span>
                <CustomSelect
                  value={skillPackId}
                  ariaLabel="提示词所属技能包"
                  onChange={(nextPackId) => {
                    setSkillPackId(nextPackId);
                    setGroupId(
                      getDirectoryItems(nextPackId)[0]?.group.id ?? "",
                    );
                    setScopeOverride(null);
                  }}
                  options={packsWithDirectories.map((pack) => ({
                    value: pack.id,
                    label: pack.name,
                    icon: (
                      <Package className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                    ),
                  }))}
                />
              </div>
              <div>
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  所属目录
                </span>
                <CustomSelect
                  value={groupId}
                  ariaLabel="提示词所属目录"
                  onChange={(nextGroupId) => {
                    setGroupId(nextGroupId);
                    setScopeOverride(null);
                  }}
                  options={directoryItems.map(({ group, depth }) => ({
                    value: group.id,
                    label: `${"　".repeat(Math.max(depth - 1, 0))}${group.name}`,
                    icon: (
                      <Folder className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
                    ),
                  }))}
                />
              </div>
            </div>
          )}

          {selectedGroup && (
            <div>
              <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                作用域
              </span>
              <ScopeEditor
                value={scopeOverride}
                inheritedScope={selectedGroup.scope}
                onChange={setScopeOverride}
              />
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-[var(--line)] px-4 text-sm"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => {
              if (!canSubmit) return;
              onCreate({
                name: name.trim(),
                id: promptId,
                version: version.trim(),
                skillPackId,
                groupId,
                scopeOverride,
              });
              onClose();
            }}
            className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-4 text-sm font-medium text-white disabled:opacity-40"
          >
            <FilePlus2 className="h-3.5 w-3.5" /> 创建并编辑
          </button>
        </footer>
      </section>
    </div>
  );
}

interface DirectoryInput {
  readonly name: string;
  readonly description: string;
  readonly parentId: string;
  readonly skillPackId: string;
  readonly scope: PromptScope;
  readonly enabled: boolean;
}

function DirectoryDialog({
  directory,
  preferredSkillPackId,
  groups,
  packs,
  onClose,
  onCreate,
  onUpdate,
}: {
  readonly directory: PromptGroup | null;
  readonly preferredSkillPackId?: string | null;
  readonly groups: readonly PromptGroup[];
  readonly packs: readonly PromptSkillPack[];
  readonly onClose: () => void;
  readonly onCreate: (input: DirectoryInput) => void;
  readonly onUpdate: (id: string, update: Partial<PromptGroup>) => void;
}) {
  const preferredPackId =
    directory?.skillPackId ??
    packs.find((pack) => pack.id === preferredSkillPackId)?.id ??
    packs[0]?.id ??
    "";
  const preferredRoot = groups.find(
    (group) =>
      group.skillPackId === preferredPackId && group.nodeKind === "pack-root",
  );
  const [name, setName] = useState(directory?.name ?? "");
  const [description, setDescription] = useState(directory?.description ?? "");
  const [skillPackId, setSkillPackId] = useState(preferredPackId);
  const [parentId, setParentId] = useState(
    directory?.parentId ?? preferredRoot?.id ?? "",
  );
  const [scope, setScope] = useState<PromptScope>(
    directory?.scope ?? { kind: "global" },
  );
  const [enabled, setEnabled] = useState(directory?.enabled ?? true);

  const excludedIds = new Set(
    directory ? getGroupSubtreeIds(directory.id, groups) : [],
  );
  const parentItems = flattenGroupTree(
    groups.filter(
      (group) =>
        group.skillPackId === skillPackId && !excludedIds.has(group.id),
    ),
  );
  const selectedPack = packs.find((pack) => pack.id === skillPackId);
  const genreValues = scope.kind === "genres" ? scope.genres : [];
  const canSubmit = Boolean(name.trim() && skillPackId && parentId);

  const submit = () => {
    if (!canSubmit) return;
    const input: DirectoryInput = {
      name: name.trim(),
      description: description.trim(),
      parentId,
      skillPackId,
      scope,
      enabled,
    };
    if (directory) {
      onUpdate(directory.id, {
        name: input.name,
        description: input.description,
        parentId: input.parentId,
        scope: input.scope,
        enabled: input.enabled,
      });
    } else {
      onCreate(input);
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-lg border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-xl">
        <header className="flex h-14 items-center gap-3 border-b border-[var(--line)] px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-cool-subtle)] text-[var(--accent-cool)]">
            <Folder className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">
              {directory ? "编辑目录" : "新建目录"}
            </h2>
            <p className="text-xs text-[var(--ink-muted)]">
              目录必须归属于一个已安装的技能包
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭目录弹窗"
            title="关闭"
            onClick={onClose}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              目录名称
            </span>
            <input
              aria-label="目录名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：章节续写"
              className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none focus:border-[var(--accent-cool)]"
            />
          </label>

          <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            <div>
              <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                所属技能包
              </span>
              {directory ? (
                <div className="flex h-9 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-inset)] px-3 text-sm">
                  <Package className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                  <span className="truncate">{selectedPack?.name}</span>
                </div>
              ) : (
                <CustomSelect
                  value={skillPackId}
                  ariaLabel="所属技能包"
                  onChange={(nextPackId) => {
                    setSkillPackId(nextPackId);
                    const nextRoot = groups.find(
                      (group) =>
                        group.skillPackId === nextPackId &&
                        group.nodeKind === "pack-root",
                    );
                    setParentId(nextRoot?.id ?? "");
                  }}
                  options={packs.map((pack) => ({
                    value: pack.id,
                    label: pack.name,
                    icon: (
                      <Package className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                    ),
                  }))}
                />
              )}
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                父目录
              </span>
              <CustomSelect
                value={parentId}
                ariaLabel="父目录"
                onChange={setParentId}
                options={parentItems.map(({ group, depth }) => ({
                  value: group.id,
                  label: `${"　".repeat(depth)}${group.name}`,
                  icon:
                    group.nodeKind === "pack-root" ? (
                      <Package className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
                    ),
                }))}
              />
            </div>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              说明
            </span>
            <textarea
              aria-label="目录说明"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说明这个目录组织哪些提示词"
              className="h-20 w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent-cool)]"
            />
          </label>

          {directory?.sourcePath && (
            <div>
              <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                安装时来源路径
              </span>
              <div className="rounded-md border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2 font-mono text-xs text-[var(--ink-muted)]">
                {directory.sourcePath}
              </div>
              <p className="mt-1 text-xs text-[var(--ink-subtle)]">
                仅用于来源追踪，不限制当前副本中的改名和移动。
              </p>
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-[var(--ink-muted)]">
                默认作用域
              </span>
              <Toggle
                checked={enabled}
                label={`${enabled ? "停用" : "启用"}目录 ${name || "未命名目录"}`}
                onChange={() => setEnabled((value) => !value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-md bg-[var(--paper-inset)] p-1">
              {(["global", "genres"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={scope.kind === kind}
                  onClick={() =>
                    setScope(
                      kind === "global"
                        ? { kind: "global" }
                        : { kind: "genres", genres: [] },
                    )
                  }
                  className={`h-8 rounded text-xs font-medium ${
                    scope.kind === kind
                      ? "bg-[var(--paper-elevated)] shadow-sm"
                      : "text-[var(--ink-muted)]"
                  }`}
                >
                  {kind === "global" ? "全局" : "多个小说题材"}
                </button>
              ))}
            </div>
            {scope.kind === "genres" && (
              <div className="mt-3">
                <GenrePicker
                  compact
                  selected={genreValues}
                  onToggle={(genre) =>
                    setScope({
                      kind: "genres",
                      genres: genreValues.includes(genre)
                        ? genreValues.filter((item) => item !== genre)
                        : [...genreValues, genre],
                    })
                  }
                />
              </div>
            )}
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-[var(--line)] px-4 text-sm"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-cool)] px-4 text-sm font-medium text-white disabled:opacity-40"
          >
            {directory ? (
              <Save className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {directory ? "保存目录" : "创建目录"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function LocalPackDialog({
  onClose,
  onCreate,
}: {
  readonly onClose: () => void;
  readonly onCreate: (name: string, description: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const canSubmit = Boolean(name.trim());

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="w-full max-w-lg rounded-lg border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-xl">
        <header className="flex h-14 items-center gap-3 border-b border-[var(--line)] px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
            <PackagePlus className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">新建本地技能包</h2>
            <p className="text-xs text-[var(--ink-muted)]">
              创建顶层技能包后，才能在其中建立目录
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭技能包弹窗"
            title="关闭"
            onClick={onClose}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              技能包名称
            </span>
            <input
              aria-label="技能包名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：我的章节写作包"
              className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none focus:border-[var(--accent-warm)]"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              说明
            </span>
            <textarea
              aria-label="技能包说明"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说明这个技能包负责的创作能力"
              className="h-20 w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent-warm)]"
            />
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-[var(--line)] px-4 text-sm"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => {
              if (!canSubmit) return;
              onCreate(name.trim(), description.trim());
              onClose();
            }}
            className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-4 text-sm font-medium text-white disabled:opacity-40"
          >
            <PackagePlus className="h-3.5 w-3.5" /> 创建技能包
          </button>
        </footer>
      </section>
    </div>
  );
}

function ManagementPanel({
  mode,
  groups,
  packs,
  prompts,
  onClose,
  onChangeMode,
  onUpdateGroup,
  onCreateGroup,
  onCreatePack,
  onTogglePack,
  onReinstallPack,
  githubInstallEnabled,
}: {
  readonly mode: "groups" | "packs";
  readonly groups: readonly PromptGroup[];
  readonly packs: readonly PromptSkillPack[];
  readonly prompts: readonly PromptDefinition[];
  readonly onClose: () => void;
  readonly onChangeMode: (mode: "groups" | "packs") => void;
  readonly onUpdateGroup: (id: string, update: Partial<PromptGroup>) => void;
  readonly onCreateGroup: (input: DirectoryInput) => void;
  readonly onCreatePack: (name: string, description: string) => void;
  readonly onTogglePack: (id: string) => void;
  readonly onReinstallPack: (id: string) => void;
  readonly githubInstallEnabled: boolean;
}) {
  const [installing, setInstalling] = useState(false);
  const [installPreview, setInstallPreview] = useState(false);
  const [directoryDialog, setDirectoryDialog] = useState<
    PromptGroup | "create" | null
  >(null);
  const [newDirectoryPackId, setNewDirectoryPackId] = useState<string | null>(
    null,
  );
  const [creatingPack, setCreatingPack] = useState(false);
  const [expandedPackId, setExpandedPackId] = useState<string | null>(
    "github.storycraft.fantasy",
  );
  const directoryCount = groups.filter(
    (group) => group.nodeKind === "directory",
  ).length;

  return (
    <div className="absolute inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-sm">
      <button
        type="button"
        aria-label="关闭管理面板"
        className="min-w-0 flex-1 cursor-default"
        onClick={onClose}
      />
      <aside className="flex h-full w-[34rem] max-w-[calc(100vw-1rem)] flex-col border-l border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-2xl">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] px-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
            {mode === "groups" ? (
              <FolderTree className="h-4 w-4" />
            ) : (
              <Package className="h-4 w-4" />
            )}
          </span>
          <div>
            <h2 className="text-sm font-semibold">
              {mode === "groups" ? "目录管理" : "技能包"}
            </h2>
            <p className="text-xs text-[var(--ink-muted)]">
              {mode === "groups"
                ? `${packs.length} 个技能包 · ${directoryCount} 个目录`
                : `${packs.length} 个已安装技能包`}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="shrink-0 border-b border-[var(--line)] px-4 py-2">
          <div className="grid grid-cols-2 rounded-md bg-[var(--paper-inset)] p-1">
            <button
              type="button"
              aria-pressed={mode === "groups"}
              onClick={() => onChangeMode("groups")}
              className={`h-8 rounded text-xs font-medium ${mode === "groups" ? "bg-[var(--paper-elevated)] shadow-sm" : "text-[var(--ink-muted)]"}`}
            >
              目录
            </button>
            <button
              type="button"
              aria-pressed={mode === "packs"}
              onClick={() => onChangeMode("packs")}
              className={`h-8 rounded text-xs font-medium ${mode === "packs" ? "bg-[var(--paper-elevated)] shadow-sm" : "text-[var(--ink-muted)]"}`}
            >
              技能包
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {mode === "groups" ? (
            <div>
              <button
                type="button"
                onClick={() => {
                  setNewDirectoryPackId(null);
                  setDirectoryDialog("create");
                }}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-dashed border-[var(--accent-cool)] text-sm font-medium text-[var(--accent-cool)] hover:bg-[var(--accent-cool-subtle)]"
              >
                <FolderPlus className="h-4 w-4" /> 新建目录
              </button>
              <div className="mt-4 divide-y divide-[var(--line)] border-y border-[var(--line)]">
                {packs.map((pack) => {
                  const packGroups = groups.filter(
                    (group) => group.skillPackId === pack.id,
                  );
                  const directoryItems = flattenGroupTree(packGroups).filter(
                    ({ group }) => group.nodeKind === "directory",
                  );
                  return (
                    <section key={pack.id} className="py-3">
                      <div className="flex min-h-9 items-center gap-2 px-2">
                        <Package className="h-4 w-4 shrink-0 text-[var(--accent-warm)]" />
                        <strong className="min-w-0 flex-1 truncate text-sm font-semibold">
                          {pack.name}
                        </strong>
                        <Tag>{directoryItems.length} 目录</Tag>
                        {!pack.enabled && <Tag>已停用</Tag>}
                        <button
                          type="button"
                          aria-label={`在 ${pack.name} 下新建目录`}
                          title="在此技能包下新建目录"
                          onClick={() => {
                            setNewDirectoryPackId(pack.id);
                            setDirectoryDialog("create");
                          }}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--accent-cool)] hover:bg-[var(--accent-cool-subtle)]"
                        >
                          <FolderPlus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {directoryItems.length === 0 ? (
                        <p className="py-2 pl-8 text-xs text-[var(--ink-subtle)]">
                          尚无目录
                        </p>
                      ) : (
                        <div className="mt-1">
                          {directoryItems.map(({ group, depth }) => {
                            const promptCount = prompts.filter(
                              (prompt) => prompt.groupId === group.id,
                            ).length;
                            return (
                              <div
                                key={group.id}
                                className="group flex min-h-9 items-center gap-2 rounded-md pr-1 hover:bg-[var(--hover-bg)]"
                                style={{ paddingLeft: 16 + (depth - 1) * 18 }}
                              >
                                <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--accent-cool)]" />
                                <span className="min-w-0 flex-1 truncate text-sm">
                                  {group.name}
                                </span>
                                {promptCount > 0 && (
                                  <Tag>{promptCount} 提示词</Tag>
                                )}
                                <Tag>
                                  {group.scope.kind === "global"
                                    ? "全局"
                                    : `${group.scope.genres.length} 题材`}
                                </Tag>
                                {!group.enabled && <Tag>停用</Tag>}
                                {group.modified && <Tag>已修改</Tag>}
                                <button
                                  type="button"
                                  aria-label={`编辑目录 ${group.name}`}
                                  title="编辑目录"
                                  onClick={() => setDirectoryDialog(group)}
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] opacity-70 hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] group-hover:opacity-100"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
                <button
                  type="button"
                  onClick={() => setCreatingPack(true)}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-dashed border-[var(--accent-warm)] text-sm font-medium text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
                >
                  <PackagePlus className="h-4 w-4" /> 新建本地技能包
                </button>
                <button
                  type="button"
                  aria-label="从 GitHub 安装技能包"
                  title={
                    githubInstallEnabled
                      ? "从 GitHub 安装技能包"
                      : "等待 MyAgents 平台安装能力接入"
                  }
                  disabled={!githubInstallEnabled}
                  onClick={() => setInstalling((value) => !value)}
                  className="flex h-9 items-center justify-center gap-2 rounded-md border border-dashed border-[var(--accent-cool)] text-sm font-medium text-[var(--accent-cool)] hover:bg-[var(--accent-cool-subtle)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Github className="h-4 w-4" /> 从 GitHub 安装
                </button>
              </div>
              {installing && (
                <div className="mt-3 rounded-md border border-[var(--line)] bg-[var(--paper)] p-3">
                  <label>
                    <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                      GitHub 仓库
                    </span>
                    <div className="flex gap-2 max-sm:flex-col">
                      <input
                        defaultValue="https://github.com/author/novel-skill-pack"
                        className="h-9 min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-xs outline-none focus:border-[var(--accent-cool)]"
                      />
                      <button
                        type="button"
                        onClick={() => setInstallPreview(true)}
                        className="h-9 shrink-0 rounded-md bg-[var(--accent-cool)] px-3 text-xs font-medium text-white"
                      >
                        读取清单
                      </button>
                    </div>
                  </label>
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--ink-muted)]">
                    <ShieldCheck className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
                    skill-pack@1 · 由 MyAgents 平台安装器校验
                  </div>
                  {installPreview && (
                    <div className="mt-3 border-t border-[var(--line-subtle)] pt-3">
                      <div className="flex items-center justify-between gap-2">
                        <strong className="text-xs">目录映射预览</strong>
                        <Tag>4 个目录分组 · 2 个提示词</Tag>
                      </div>
                      <div className="mt-2 rounded-md bg-[var(--paper-inset)] py-2 font-mono text-xs">
                        {[
                          [0, "prompts", "directory"],
                          [1, "world", "directory"],
                          [2, "power-system", "directory"],
                          [3, "generate.md", "file"],
                          [2, "factions", "directory"],
                          [3, "consistency-audit.md", "file"],
                        ].map(([depth, name, kind]) => (
                          <div
                            key={`${depth}-${name}`}
                            className="flex h-6 items-center gap-1.5 pr-2"
                            style={{ paddingLeft: 10 + Number(depth) * 16 }}
                          >
                            {kind === "directory" ? (
                              <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--accent-warm)]" />
                            ) : (
                              <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
                            )}
                            <span className="truncate">{name}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--accent-cool)]">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        目录层级将一对一复制，安装后可自由编辑
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 space-y-3">
                {packs.map((pack) => {
                  const promptCount = prompts.filter(
                    (prompt) => prompt.skillPackId === pack.id,
                  ).length;
                  const packRootIds = groups
                    .filter(
                      (group) =>
                        group.skillPackId === pack.id &&
                        group.parentId === null,
                    )
                    .map((group) => group.id);
                  const directoryItems = flattenGroupTree(groups, packRootIds);
                  const directoryExpanded = expandedPackId === pack.id;
                  return (
                    <article
                      key={pack.id}
                      className="rounded-md border border-[var(--line)] bg-[var(--paper)] p-4"
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
                            pack.source === "github"
                              ? "bg-[var(--paper-inset)] text-[var(--ink)]"
                              : "bg-[var(--accent-cool-subtle)] text-[var(--accent-cool)]"
                          }`}
                        >
                          {pack.source === "github" ? (
                            <Github className="h-4 w-4" />
                          ) : (
                            <Package className="h-4 w-4" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="truncate text-sm font-semibold">
                              {pack.name}
                            </h3>
                            <Tag>v{pack.version}</Tag>
                            {pack.copyNumber > 1 && (
                              <Tag>副本 {pack.copyNumber}</Tag>
                            )}
                            {pack.modified && <Tag>已修改</Tag>}
                          </div>
                          <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
                            {pack.description}
                          </p>
                        </div>
                        <Toggle
                          checked={pack.enabled}
                          label={`${pack.enabled ? "停用" : "启用"}技能包 ${pack.name}`}
                          onChange={() => onTogglePack(pack.id)}
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--line-subtle)] pt-3 text-xs text-[var(--ink-subtle)]">
                        <span>{promptCount} 个提示词</span>
                        <span>{pack.updatedAt}</span>
                        {pack.repository && (
                          <span className="flex min-w-0 items-center gap-1">
                            <Github className="h-3 w-3 shrink-0" />
                            <span className="truncate font-mono">
                              {pack.repository}
                            </span>
                          </span>
                        )}
                        {pack.source !== "project" && (
                          <button
                            type="button"
                            onClick={() => onReinstallPack(pack.id)}
                            className="flex items-center gap-1 font-medium text-[var(--accent-warm)]"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            重新安装为新副本
                          </button>
                        )}
                        {directoryItems.length > 0 && (
                          <button
                            type="button"
                            aria-expanded={directoryExpanded}
                            onClick={() =>
                              setExpandedPackId(
                                directoryExpanded ? null : pack.id,
                              )
                            }
                            className="ml-auto flex items-center gap-1 font-medium text-[var(--accent-cool)]"
                          >
                            <ChevronRight
                              className={`h-3.5 w-3.5 transition-transform ${directoryExpanded ? "rotate-90" : ""}`}
                            />
                            {directoryExpanded ? "收起目录" : "查看目录分组"}
                          </button>
                        )}
                      </div>
                      {directoryExpanded && (
                        <div className="mt-3 rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)] py-2">
                          <div className="px-3 pb-1 text-xs font-medium text-[var(--ink-muted)]">
                            安装副本目录
                          </div>
                          {directoryItems.map(({ group, depth }) => {
                            const directPromptCount = prompts.filter(
                              (prompt) => prompt.groupId === group.id,
                            ).length;
                            return (
                              <div
                                key={group.id}
                                className="flex min-h-7 items-center gap-2 pr-3 text-xs"
                                style={{ paddingLeft: 12 + depth * 18 }}
                              >
                                {group.nodeKind === "pack-root" ? (
                                  <Package className="h-3.5 w-3.5 shrink-0 text-[var(--accent-warm)]" />
                                ) : (
                                  <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--accent-cool)]" />
                                )}
                                <span
                                  className="min-w-0 flex-1 truncate font-mono"
                                  title={group.sourcePath || group.name}
                                >
                                  {group.name}
                                </span>
                                {directPromptCount > 0 && (
                                  <Tag>{directPromptCount} 个提示词</Tag>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </aside>
      {directoryDialog && (
        <DirectoryDialog
          key={directoryDialog === "create" ? "create" : directoryDialog.id}
          directory={directoryDialog === "create" ? null : directoryDialog}
          preferredSkillPackId={newDirectoryPackId}
          groups={groups}
          packs={packs}
          onClose={() => setDirectoryDialog(null)}
          onCreate={onCreateGroup}
          onUpdate={onUpdateGroup}
        />
      )}
      {creatingPack && (
        <LocalPackDialog
          onClose={() => setCreatingPack(false)}
          onCreate={onCreatePack}
        />
      )}
    </div>
  );
}

export interface PromptManagerPrototypeProps {
  readonly initialModel?: PromptLibraryModel;
  readonly initialProjectGenres?: readonly string[];
  readonly onModelChange?: (model: PromptLibraryModel) => void;
  readonly onSave?: (model: PromptLibraryModel) => Promise<void>;
  readonly githubInstallEnabled?: boolean;
}

export default function PromptManagerPrototype({
  initialModel,
  initialProjectGenres = ["玄幻", "东方玄幻"],
  onModelChange,
  onSave,
  githubInstallEnabled = true,
}: PromptManagerPrototypeProps = {}) {
  const [view, setView] = useState<PromptView>("overview");
  const [groups, setGroups] = useState<readonly PromptGroup[]>(
    initialModel?.groups ?? INITIAL_GROUPS,
  );
  const [packs, setPacks] = useState<readonly PromptSkillPack[]>(
    initialModel?.packs ?? INITIAL_SKILL_PACKS,
  );
  const [prompts, setPrompts] = useState<readonly PromptDefinition[]>(
    initialModel?.prompts ?? INITIAL_PROMPTS,
  );
  const [selectedId, setSelectedId] = useState(
    (initialModel?.prompts ?? INITIAL_PROMPTS)[0]?.instanceId ?? "",
  );
  const [projectGenres, setProjectGenres] =
    useState<readonly string[]>(initialProjectGenres);
  const [query, setQuery] = useState("");
  const [managementMode, setManagementMode] = useState<
    "groups" | "packs" | null
  >(null);
  const [creatingPrompt, setCreatingPrompt] = useState(false);
  const didMountRef = useRef(false);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    onModelChange?.(
      Object.freeze({
        packs: Object.freeze([...packs]),
        groups: Object.freeze([...groups]),
        prompts: Object.freeze([...prompts]),
      }),
    );
  }, [groups, onModelChange, packs, prompts]);

  const selected =
    prompts.find((prompt) => prompt.instanceId === selectedId) ?? prompts[0];
  const selectedGroup = selected
    ? (groups.find((group) => group.id === selected.groupId) ?? groups[0])
    : undefined;
  const selectedPack = selected
    ? (packs.find((pack) => pack.id === selected.skillPackId) ?? packs[0])
    : undefined;
  const activations = useMemo(
    () =>
      prompts.map((prompt) =>
        resolvePromptActivation(prompt, groups, packs, projectGenres),
      ),
    [groups, packs, projectGenres, prompts],
  );
  const conflicts = detectPromptConflicts(activations);
  const conflictingInstanceIds = new Set(
    conflicts.flatMap((conflict) =>
      conflict.activations.map((activation) => activation.prompt.instanceId),
    ),
  );
  const activeCount = activations.filter(
    (activation) =>
      activation.active &&
      !conflictingInstanceIds.has(activation.prompt.instanceId),
  ).length;
  const stoppedCount =
    prompts.length - prompts.filter((prompt) => prompt.enabled).length;
  const currentModel = (): PromptLibraryModel =>
    Object.freeze({
      packs: Object.freeze([...packs]),
      groups: Object.freeze([...groups]),
      prompts: Object.freeze([...prompts]),
    });

  const updatePrompt = (
    instanceId: string,
    update: Partial<PromptDefinition>,
  ) => {
    const target = prompts.find((prompt) => prompt.instanceId === instanceId);
    if (target) {
      setPacks((current) =>
        current.map((pack) =>
          target.skillPackId === pack.id ? { ...pack, modified: true } : pack,
        ),
      );
    }
    setPrompts((current) =>
      current.map((prompt) =>
        prompt.instanceId === instanceId ? { ...prompt, ...update } : prompt,
      ),
    );
  };
  const updateGroup = (id: string, update: Partial<PromptGroup>) => {
    const target = groups.find((group) => group.id === id);
    if (target && update.parentId !== undefined) {
      const nextParent = groups.find((group) => group.id === update.parentId);
      const subtreeIds = new Set(getGroupSubtreeIds(target.id, groups));
      if (
        !nextParent ||
        nextParent.skillPackId !== target.skillPackId ||
        subtreeIds.has(nextParent.id)
      ) {
        return;
      }
    }
    if (target) {
      setPacks((current) =>
        current.map((pack) =>
          pack.id === target.skillPackId ? { ...pack, modified: true } : pack,
        ),
      );
    }
    setGroups((current) =>
      current.map((group) =>
        group.id === id ? { ...group, ...update, modified: true } : group,
      ),
    );
  };
  const reinstallPack = (installationId: string) => {
    const currentPack = packs.find((pack) => pack.id === installationId);
    if (!currentPack) return;
    const sourcePack = INITIAL_SKILL_PACKS.find(
      (pack) => pack.packageId === currentPack.packageId,
    );
    if (!sourcePack) return;

    const copyNumber =
      Math.max(
        ...packs
          .filter((pack) => pack.packageId === currentPack.packageId)
          .map((pack) => pack.copyNumber),
      ) + 1;
    const newInstallationId = `${sourcePack.packageId}#${copyNumber}`;
    const templateGroups = INITIAL_GROUPS.filter(
      (group) => group.skillPackId === sourcePack.id,
    );
    const groupIdMap = new Map(
      templateGroups.map((group) => [
        group.id,
        `${newInstallationId}:${group.id}`,
      ]),
    );
    const newPack: PromptSkillPack = {
      ...sourcePack,
      id: newInstallationId,
      name: `${sourcePack.name} · 副本 ${copyNumber}`,
      copyNumber,
      enabled: true,
      modified: false,
      updatedAt: "刚刚重新安装",
    };
    const newGroups = templateGroups.map((group) => ({
      ...group,
      id: groupIdMap.get(group.id)!,
      name: group.nodeKind === "pack-root" ? newPack.name : group.name,
      parentId: group.parentId
        ? (groupIdMap.get(group.parentId) ?? null)
        : null,
      skillPackId: newInstallationId,
      userCreated: false,
      modified: false,
    }));
    const newPrompts = INITIAL_PROMPTS.filter(
      (prompt) => prompt.skillPackId === sourcePack.id,
    ).map((prompt) => ({
      ...prompt,
      instanceId: `${newInstallationId}:${prompt.id}`,
      groupId: groupIdMap.get(prompt.groupId)!,
      skillPackId: newInstallationId,
      overridden: false,
    }));

    setPacks((current) => [...current, newPack]);
    setGroups((current) => [...current, ...newGroups]);
    setPrompts((current) => [...current, ...newPrompts]);
  };
  const createDirectory = (input: DirectoryInput) => {
    const parent = groups.find((group) => group.id === input.parentId);
    const pack = packs.find((candidate) => candidate.id === input.skillPackId);
    if (!parent || !pack || parent.skillPackId !== pack.id) return;
    setPacks((current) =>
      current.map((pack) =>
        pack.id === input.skillPackId ? { ...pack, modified: true } : pack,
      ),
    );
    setGroups((current) => {
      const nextNumber =
        current.filter((group) => group.userCreated).length + 1;
      return [
        ...current,
        {
          id: `custom-directory-${nextNumber}`,
          name: input.name,
          description: input.description,
          parentId: input.parentId,
          nodeKind: "directory",
          skillPackId: input.skillPackId,
          sourcePath: "",
          userCreated: true,
          modified: true,
          enabled: input.enabled,
          scope: input.scope,
        },
      ];
    });
  };
  const createLocalPack = (name: string, description: string) => {
    let nextNumber =
      packs.filter((pack) => pack.packageId.startsWith("project.local."))
        .length + 1;
    while (packs.some((pack) => pack.id === `project.local.${nextNumber}`)) {
      nextNumber += 1;
    }
    const id = `project.local.${nextNumber}`;
    const rootId = `${id}:root`;
    setPacks((current) => [
      ...current,
      {
        id,
        packageId: id,
        name,
        source: "project",
        version: "1.0.0",
        enabled: true,
        updatedAt: "刚刚创建",
        description,
        copyNumber: 1,
        modified: true,
      },
    ]);
    setGroups((current) => [
      ...current,
      {
        id: rootId,
        name,
        description,
        parentId: null,
        nodeKind: "pack-root",
        skillPackId: id,
        sourcePath: "",
        userCreated: true,
        modified: true,
        enabled: true,
        scope: { kind: "global" },
      },
    ]);
  };
  const createPrompt = (input: PromptInput) => {
    const group = groups.find((candidate) => candidate.id === input.groupId);
    const pack = packs.find((candidate) => candidate.id === input.skillPackId);
    if (!group || !pack || group.skillPackId !== pack.id) return;

    const baseInstanceId = `${input.skillPackId}:${input.id}`;
    let instanceId = baseInstanceId;
    let copyNumber = 2;
    while (prompts.some((prompt) => prompt.instanceId === instanceId)) {
      instanceId = `${baseInstanceId}#${copyNumber}`;
      copyNumber += 1;
    }
    const prompt: PromptDefinition = {
      instanceId,
      id: input.id,
      name: input.name,
      groupId: input.groupId,
      version: input.version,
      enabled: true,
      overridden: true,
      skillPackId: input.skillPackId,
      scopeOverride: input.scopeOverride,
      content: "",
    };
    setPrompts((current) => [...current, prompt]);
    setPacks((current) =>
      current.map((candidate) =>
        candidate.id === input.skillPackId
          ? { ...candidate, modified: true }
          : candidate,
      ),
    );
    setSelectedId(instanceId);
    setView("overview");
  };
  const toggleGenre = (genre: string) => {
    setProjectGenres((current) =>
      current.includes(genre)
        ? current.filter((item) => item !== genre)
        : [...current, genre],
    );
  };
  const resolveConflict = (
    winnerInstanceId: string,
    conflictingIds: readonly string[],
  ) => {
    const conflictIdSet = new Set(conflictingIds);
    const affectedPackIds = new Set(
      prompts
        .filter((prompt) => conflictIdSet.has(prompt.instanceId))
        .map((prompt) => prompt.skillPackId),
    );
    setPrompts((current) =>
      current.map((prompt) =>
        conflictIdSet.has(prompt.instanceId)
          ? { ...prompt, enabled: prompt.instanceId === winnerInstanceId }
          : prompt,
      ),
    );
    setPacks((current) =>
      current.map((pack) =>
        affectedPackIds.has(pack.id) ? { ...pack, modified: true } : pack,
      ),
    );
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <header className="flex min-h-[4.5rem] shrink-0 items-center gap-4 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-2 max-sm:flex-wrap max-sm:gap-2 max-sm:px-3">
        <div className="flex min-w-0 items-center gap-3 max-sm:flex-1">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
            <Code2 className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">提示词管理</h1>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--ink-muted)] max-lg:hidden">
              <span>{prompts.length} 个提示词</span>
              <span>·</span>
              <span>{groups.length} 个分组</span>
              <span>·</span>
              <span>{packs.length} 个技能包</span>
              {stoppedCount > 0 && (
                <span className="text-[var(--warning)]">
                  · {stoppedCount} 个已停用
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="ml-2 grid shrink-0 grid-cols-2 rounded-md bg-[var(--paper-inset)] p-1 max-sm:order-3 max-sm:ml-0 max-sm:w-full">
          <button
            type="button"
            aria-pressed={view === "overview"}
            onClick={() => setView("overview")}
            className={`flex h-8 min-w-20 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium max-sm:min-w-0 ${
              view === "overview"
                ? "bg-[var(--paper-elevated)] shadow-sm"
                : "text-[var(--ink-muted)]"
            }`}
          >
            <Boxes className="h-3.5 w-3.5" /> 总览
          </button>
          <button
            type="button"
            aria-pressed={view === "active"}
            onClick={() => setView("active")}
            className={`flex h-8 min-w-24 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium max-sm:min-w-0 ${
              view === "active"
                ? "bg-[var(--paper-elevated)] shadow-sm"
                : "text-[var(--ink-muted)]"
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> 当前启用集
            <span
              className={`rounded px-1 max-sm:hidden ${
                conflicts.length > 0
                  ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                  : "bg-[var(--success-bg)] text-[var(--success)]"
              }`}
            >
              {conflicts.length > 0 ? `${conflicts.length} 冲突` : activeCount}
            </span>
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            aria-label="新增提示词"
            title="新增提示词"
            onClick={() => setCreatingPrompt(true)}
            className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-xs font-medium text-white max-sm:w-9 max-sm:justify-center max-sm:px-0"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            <span className="max-sm:hidden">新增提示词</span>
          </button>
          <button
            type="button"
            aria-label="目录管理"
            title="目录管理"
            onClick={() => setManagementMode("groups")}
            className="flex h-9 items-center gap-1.5 rounded-md border border-[var(--line)] px-3 text-xs hover:bg-[var(--hover-bg)] max-sm:w-9 max-sm:justify-center max-sm:px-0"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="max-sm:hidden">目录管理</span>
          </button>
          <button
            type="button"
            aria-label="技能包"
            title="技能包"
            onClick={() => setManagementMode("packs")}
            className="flex h-9 items-center gap-1.5 rounded-md border border-[var(--line)] px-3 text-xs hover:bg-[var(--hover-bg)] max-sm:w-9 max-sm:justify-center max-sm:px-0"
          >
            <Package className="h-3.5 w-3.5" />
            <span className="max-sm:hidden">技能包</span>
          </button>
        </div>
      </header>

      {view === "overview" ? (
        <div className="flex min-h-0 flex-1">
          <PromptNavigation
            prompts={prompts}
            groups={groups}
            packs={packs}
            selectedId={selected?.instanceId ?? ""}
            query={query}
            onQueryChange={setQuery}
            onSelect={setSelectedId}
            onToggleGroup={(id) => {
              const target = groups.find((group) => group.id === id);
              if (target) updateGroup(id, { enabled: !target.enabled });
            }}
          />
          {selected && selectedGroup && selectedPack ? (
            <PromptEditor
              key={selected.instanceId}
              selected={selected}
              group={selectedGroup}
              pack={selectedPack}
              allGroups={groups}
              onUpdate={(update) => updatePrompt(selected.instanceId, update)}
              onSave={() => onSave?.(currentModel()) ?? Promise.resolve()}
            />
          ) : (
            <div className="flex min-w-0 flex-1 flex-col items-center justify-center text-[var(--ink-muted)]">
              <FileText className="h-6 w-6" />
              <p className="mt-3 text-sm">尚未创建提示词</p>
              <button
                type="button"
                onClick={() => setCreatingPrompt(true)}
                className="mt-4 flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-white"
              >
                <FilePlus2 className="h-3.5 w-3.5" /> 新增提示词
              </button>
            </div>
          )}
        </div>
      ) : (
        <ActiveSetView
          activations={activations}
          installationCount={packs.length}
          projectGenres={projectGenres}
          onToggleGenre={toggleGenre}
          onSelect={(id) => {
            setSelectedId(id);
            setView("overview");
          }}
          onResolveConflict={resolveConflict}
        />
      )}

      {managementMode && (
        <ManagementPanel
          mode={managementMode}
          groups={groups}
          packs={packs}
          prompts={prompts}
          onClose={() => setManagementMode(null)}
          onChangeMode={setManagementMode}
          onUpdateGroup={updateGroup}
          onCreateGroup={createDirectory}
          onCreatePack={createLocalPack}
          onReinstallPack={reinstallPack}
          githubInstallEnabled={githubInstallEnabled}
          onTogglePack={(id) =>
            setPacks((current) =>
              current.map((pack) =>
                pack.id === id
                  ? { ...pack, enabled: !pack.enabled, modified: true }
                  : pack,
              ),
            )
          }
        />
      )}
      {creatingPrompt && (
        <PromptCreateDialog
          groups={groups}
          packs={packs}
          onClose={() => setCreatingPrompt(false)}
          onCreate={createPrompt}
        />
      )}
    </div>
  );
}
