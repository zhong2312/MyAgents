import {
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  ExternalLink,
  Loader2,
  MapPinned,
  Plus,
  Save,
  Search,
  Swords,
  Trash2,
  UserRound,
  Users,
  Warehouse,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Popover } from "@/components/ui/Popover";
import { CustomSelect, type WorkbenchStorage } from "@/workbench-sdk";

import { createNovelCharacterLibraryRepository } from "./characterLibraryRepository";
import {
  createNovelFactionLibraryRepository,
  type LoadedFactionLibrary,
} from "./factionLibraryRepository";
import {
  type FactionAsset,
  type FactionMember,
  type FactionRecord,
  type FactionResource,
  type FactionTerritory,
} from "./factionLibrarySchema";
import type { CharacterRecord } from "./characterLibrarySchema";
import { createNovelSettingLibraryRepository } from "./settingLibraryRepository";

interface FactionLibraryProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
  readonly onOpenWorldNode?: (nodeId: string) => void;
}

interface WorldNode {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

type EntityKind = "territories" | "members" | "assets" | "resources";

const STATUS_OPTIONS = [
  { value: "active", label: "活跃" },
  { value: "neutral", label: "中立" },
  { value: "declining", label: "衰落" },
  { value: "dissolved", label: "已解散" },
] as const;

const ENTITY_CATEGORIES: readonly {
  readonly id: EntityKind;
  readonly label: string;
  readonly emptyText: string;
  readonly icon: LucideIcon;
}[] = [
  { id: "territories", label: "地盘", emptyText: "暂无地盘", icon: MapPinned },
  { id: "members", label: "人物", emptyText: "暂无成员", icon: Users },
  { id: "assets", label: "资产", emptyText: "暂无经营资产", icon: Warehouse },
  { id: "resources", label: "资源", emptyText: "暂无争夺资源", icon: Swords },
];

const ROLE_LABELS: Readonly<Record<CharacterRecord["roleWeight"], string>> = {
  main: "主要角色",
  secondary: "次要角色",
  npc: "NPC",
  extra: "路人",
};

const CHARACTER_PICKER_PAGE_SIZE = 50;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createFaction(): FactionRecord {
  const now = new Date().toISOString();
  return {
    id: createId("faction"),
    name: "新势力",
    type: "",
    status: "active",
    summary: "",
    territories: [],
    members: [],
    assets: [],
    resources: [],
    createdAt: now,
    updatedAt: now,
  };
}

function FieldLabel({
  label,
  error,
  children,
}: {
  readonly label: string;
  readonly error?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="block min-w-0">
      <div className="mb-1.5 flex min-h-4 items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--ink-muted)]">
          {label}
        </span>
        {error && <span className="text-xs text-[var(--error)]">{error}</span>}
      </div>
      {children}
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]";
const invalidInputClass = "border-[var(--error)] focus:border-[var(--error)]";
const descriptionClass = `${inputClass} min-h-56 resize-y leading-6`;

function nameOrDefault(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function normalizeDraft(draft: FactionRecord): {
  readonly faction: FactionRecord;
  readonly fieldErrors: Readonly<Record<string, string>>;
} {
  const fieldErrors: Record<string, string> = {};
  const territories = draft.territories.map(
    (item): FactionTerritory => ({
      ...item,
      name: nameOrDefault(item.name, "未命名地盘"),
      description: item.description.trim(),
    }),
  );
  const members = draft.members.map(
    (item): FactionMember => ({
      ...item,
      name: nameOrDefault(item.name, "未命名成员"),
      role: item.role.trim(),
      description: item.description.trim(),
      count: Math.max(1, item.count),
    }),
  );
  const assets = draft.assets.map(
    (item): FactionAsset => ({
      ...item,
      name: nameOrDefault(item.name, "未命名资产"),
      kind: item.kind.trim(),
      value: item.value.trim(),
      description: item.description.trim(),
    }),
  );
  const resources = draft.resources.map(
    (item): FactionResource => ({
      ...item,
      name: nameOrDefault(item.name, "未命名资源"),
      kind: item.kind.trim(),
      control: item.control.trim(),
      description: item.description.trim(),
    }),
  );

  if (!draft.name.trim()) fieldErrors.name = "请填写势力名称";
  territories.forEach((item) => {
    if (!item.name) fieldErrors[`territory:${item.id}`] = "请填写地盘名称";
  });
  members.forEach((item) => {
    if (!item.name) fieldErrors[`member:${item.id}`] = "请填写名称或类别";
  });
  assets.forEach((item) => {
    if (!item.name) fieldErrors[`asset:${item.id}`] = "请填写资产名称";
  });
  resources.forEach((item) => {
    if (!item.name) fieldErrors[`resource:${item.id}`] = "请填写资源名称";
  });

  return {
    faction: {
      ...draft,
      name: draft.name.trim(),
      type: draft.type.trim(),
      summary: draft.summary.trim(),
      territories,
      members,
      assets,
      resources,
      updatedAt: new Date().toISOString(),
    },
    fieldErrors,
  };
}

function entryLabel(
  kind: EntityKind,
  item: FactionTerritory | FactionMember | FactionAsset | FactionResource,
): string {
  if (kind === "territories")
    return (item as FactionTerritory).name || "未命名地盘";
  if (kind === "members") return (item as FactionMember).name || "未命名成员";
  if (kind === "assets") return (item as FactionAsset).name || "未命名资产";
  return (item as FactionResource).name || "未命名资源";
}

function entryMeta(
  kind: EntityKind,
  item: FactionTerritory | FactionMember | FactionAsset | FactionResource,
): string {
  if (kind === "territories")
    return (item as FactionTerritory).description || "未填写说明";
  if (kind === "members") {
    const member = item as FactionMember;
    return `${member.role || "成员"}${member.count > 1 ? ` · ${member.count} 人` : ""}`;
  }
  if (kind === "assets") {
    const asset = item as FactionAsset;
    return (
      [asset.kind, asset.value].filter(Boolean).join(" · ") || "未填写经营信息"
    );
  }
  const resource = item as FactionResource;
  return (
    [resource.kind, resource.control].filter(Boolean).join(" · ") ||
    "未填写资源状态"
  );
}

function fieldErrorKey(kind: EntityKind, id: string): string {
  if (kind === "territories") return `territory:${id}`;
  if (kind === "members") return `member:${id}`;
  if (kind === "assets") return `asset:${id}`;
  return `resource:${id}`;
}

export default function FactionLibrary({
  storage,
  projectTitle,
  isActive,
  onOpenWorldNode,
}: FactionLibraryProps) {
  const repository = useMemo(
    () => createNovelFactionLibraryRepository(storage),
    [storage],
  );
  const [loaded, setLoaded] = useState<LoadedFactionLibrary | null>(null);
  const [draft, setDraft] = useState<FactionRecord | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [worldNodes, setWorldNodes] = useState<readonly WorldNode[]>([]);
  const [characters, setCharacters] = useState<readonly CharacterRecord[]>([]);
  const [entityKind, setEntityKind] = useState<EntityKind>("territories");
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [inspectedCharacter, setInspectedCharacter] =
    useState<CharacterRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const selectedIdRef = useRef(selectedId);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [next, people, world] = await Promise.all([
        repository.load(),
        createNovelCharacterLibraryRepository(storage)
          .load()
          .catch(() => null),
        createNovelSettingLibraryRepository(storage)
          .load(projectTitle)
          .catch(() => null),
      ]);
      setLoaded(next);
      setCharacters(people?.index.characters ?? []);
      setWorldNodes(
        world?.spatialTree.nodes.map(({ id, name, parentId }) => ({
          id,
          name,
          parentId,
        })) ?? [],
      );
      const current =
        next.library.factions.find(
          (item) => item.id === selectedIdRef.current,
        ) ??
        next.library.factions[0] ??
        null;
      selectedIdRef.current = current?.id ?? "";
      setSelectedId(current?.id ?? "");
      setDraft(current ? structuredClone(current) : null);
      setSelectedEntryId("");
      setError(null);
      setFieldErrors({});
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [projectTitle, repository, storage]);

  useEffect(() => {
    if (isActive) void load();
  }, [isActive, load]);

  const selectFaction = (faction: FactionRecord) => {
    selectedIdRef.current = faction.id;
    setSelectedId(faction.id);
    setDraft(structuredClone(faction));
    setSelectedEntryId("");
    setError(null);
    setFieldErrors({});
  };

  const startNewFaction = () => {
    selectedIdRef.current = "";
    setSelectedId("");
    setDraft(createFaction());
    setSelectedEntryId("");
    setError(null);
    setFieldErrors({});
  };

  const update = (patch: Partial<FactionRecord>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setError(null);
    setFieldErrors({});
  };

  const save = async () => {
    if (!loaded || !draft) return;
    const normalized = normalizeDraft(draft);
    if (Object.keys(normalized.fieldErrors).length > 0) {
      setFieldErrors(normalized.fieldErrors);
      setError("请先补充带有提示的必填项，再保存势力档案。");
      return;
    }
    setIsSaving(true);
    try {
      const exists = loaded.library.factions.some(
        (item) => item.id === normalized.faction.id,
      );
      const library = {
        ...loaded.library,
        factions: exists
          ? loaded.library.factions.map((item) =>
              item.id === normalized.faction.id ? normalized.faction : item,
            )
          : [...loaded.library.factions, normalized.faction],
      };
      const next = await repository.save(loaded, library);
      const saved =
        next.library.factions.find(
          (item) => item.id === normalized.faction.id,
        ) ?? normalized.faction;
      setLoaded(next);
      selectedIdRef.current = saved.id;
      setSelectedId(saved.id);
      setDraft(structuredClone(saved));
      setError(null);
      setFieldErrors({});
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const removeFaction = async () => {
    if (
      !loaded ||
      !draft ||
      !loaded.library.factions.some((item) => item.id === draft.id)
    )
      return;
    setIsSaving(true);
    try {
      const next = await repository.save(loaded, {
        ...loaded.library,
        factions: loaded.library.factions.filter(
          (item) => item.id !== draft.id,
        ),
      });
      const nextDraft = next.library.factions[0] ?? null;
      setLoaded(next);
      selectedIdRef.current = nextDraft?.id ?? "";
      setSelectedId(nextDraft?.id ?? "");
      setDraft(nextDraft ? structuredClone(nextDraft) : null);
      setSelectedEntryId("");
      setError(null);
      setFieldErrors({});
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const currentEntries = useMemo(() => {
    if (!draft)
      return [] as readonly (
        | FactionTerritory
        | FactionMember
        | FactionAsset
        | FactionResource
      )[];
    return draft[entityKind];
  }, [draft, entityKind]);
  const selectedEntry =
    currentEntries.find((item) => item.id === selectedEntryId) ??
    currentEntries[0] ??
    null;

  useEffect(() => {
    if (selectedEntry?.id === selectedEntryId) return;
    setSelectedEntryId(selectedEntry?.id ?? "");
  }, [selectedEntry, selectedEntryId]);

  const addEntry = () => {
    if (!draft) return;
    if (entityKind === "territories") {
      const item: FactionTerritory = {
        id: createId("territory"),
        name: "未命名地盘",
        worldNodeId: null,
        description: "",
      };
      update({ territories: [...draft.territories, item] });
      setSelectedEntryId(item.id);
      return;
    }
    if (entityKind === "members") {
      const item: FactionMember = {
        id: createId("member"),
        name: "打手",
        characterId: null,
        role: "成员",
        count: 1,
        description: "",
      };
      update({ members: [...draft.members, item] });
      setSelectedEntryId(item.id);
      return;
    }
    if (entityKind === "assets") {
      const item: FactionAsset = {
        id: createId("asset"),
        name: "未命名资产",
        kind: "",
        value: "",
        description: "",
      };
      update({ assets: [...draft.assets, item] });
      setSelectedEntryId(item.id);
      return;
    }
    const item: FactionResource = {
      id: createId("resource"),
      name: "未命名资源",
      kind: "",
      control: "",
      description: "",
    };
    update({ resources: [...draft.resources, item] });
    setSelectedEntryId(item.id);
  };

  const removeEntry = (kind: EntityKind, id: string) => {
    if (!draft) return;
    setSelectedEntryId("");
    if (kind === "territories")
      update({
        territories: draft.territories.filter((item) => item.id !== id),
      });
    else if (kind === "members")
      update({ members: draft.members.filter((item) => item.id !== id) });
    else if (kind === "assets")
      update({ assets: draft.assets.filter((item) => item.id !== id) });
    else
      update({ resources: draft.resources.filter((item) => item.id !== id) });
  };

  return (
    <div className="flex h-full min-h-0 bg-[var(--paper)]">
      <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--line-strong)] bg-[var(--paper-elevated)] max-lg:w-56 max-md:hidden">
        <div className="flex h-12 items-center justify-between border-b border-[var(--line-subtle)] px-3">
          <h1 className="text-sm font-semibold text-[var(--ink)]">势力组织</h1>
          <button
            type="button"
            onClick={startNewFaction}
            title="新建势力"
            aria-label="新建势力"
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loaded?.library.factions.map((faction) => (
            <button
              key={faction.id}
              type="button"
              onClick={() => selectFaction(faction)}
              className={`mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors ${faction.id === selectedId ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
            >
              <span className="block truncate text-sm font-medium">
                {faction.name}
              </span>
              <span className="mt-1 block truncate text-xs text-[var(--ink-subtle)]">
                {faction.type || "未分类势力"}
              </span>
            </button>
          ))}
          {!isLoading && !loaded?.library.factions.length && (
            <p className="px-3 py-6 text-center text-xs text-[var(--ink-muted)]">
              暂无势力组织
            </p>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div
            role="alert"
            className="shrink-0 border-b border-[var(--line-subtle)] bg-[var(--error-bg)] px-5 py-2 text-sm text-[var(--error)]"
          >
            {error}
          </div>
        )}
        {isLoading ? (
          <LoadingState />
        ) : !draft ? (
          <EmptyFactionState onCreate={startNewFaction} />
        ) : (
          <>
            <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--line-strong)] bg-[var(--paper-elevated)] px-5 py-3 max-md:flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--accent-cool)]">
                  <Building2 className="h-3.5 w-3.5" />
                  势力档案
                </div>
                <h1 className="mt-1 truncate text-lg font-semibold text-[var(--ink)]">
                  {draft.name || "未命名势力"}
                </h1>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={isSaving}
                  className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-[var(--paper)] disabled:opacity-45"
                >
                  {isSaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => void removeFaction()}
                  disabled={isSaving || !selectedId}
                  title="删除势力"
                  aria-label="删除势力"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:opacity-35"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </header>

            <section className="grid shrink-0 gap-3 border-b border-[var(--line-subtle)] px-5 py-4 md:grid-cols-3">
              <FieldLabel label="势力名称" error={fieldErrors.name}>
                <input
                  className={`${inputClass} ${fieldErrors.name ? invalidInputClass : ""}`}
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </FieldLabel>
              <FieldLabel label="势力类型">
                <input
                  className={inputClass}
                  value={draft.type}
                  placeholder="宗门、家族、商会、帮派..."
                  onChange={(event) => update({ type: event.target.value })}
                />
              </FieldLabel>
              <FieldLabel label="当前状态">
                <CustomSelect
                  value={draft.status}
                  options={[...STATUS_OPTIONS]}
                  onChange={(status) =>
                    update({ status: status as FactionRecord["status"] })
                  }
                  size="toolbar"
                />
              </FieldLabel>
              <div className="md:col-span-3">
                <FieldLabel label="势力概要">
                  <textarea
                    className={`${inputClass} min-h-24 resize-y leading-6`}
                    value={draft.summary}
                    placeholder="目标、立场、历史、关键人物与当前矛盾"
                    onChange={(event) =>
                      update({ summary: event.target.value })
                    }
                  />
                </FieldLabel>
              </div>
            </section>

            <section className="flex min-h-0 flex-1 max-md:flex-col">
              <aside className="flex w-40 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)] max-md:w-full max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:border-r-0">
                <div className="border-b border-[var(--line-subtle)] px-3 py-3 text-xs font-medium text-[var(--ink-muted)] max-md:hidden">
                  资料大类
                </div>
                <div className="flex-1 p-2 max-md:flex max-md:min-w-max max-md:p-2">
                  {ENTITY_CATEGORIES.map((category) => {
                    const Icon = category.icon;
                    const count = draft[category.id].length;
                    const active = category.id === entityKind;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        onClick={() => {
                          setEntityKind(category.id);
                          setSelectedEntryId("");
                        }}
                        className={`mb-1 flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors max-md:mb-0 max-md:mr-1 max-md:w-28 ${active ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                      >
                        <Icon
                          className={`h-4 w-4 shrink-0 ${active ? "text-[var(--accent-warm)]" : ""}`}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {category.label}
                        </span>
                        <span className="text-xs text-[var(--ink-subtle)]">
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <section className="flex w-80 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)] max-md:w-full max-md:border-b max-md:border-r-0">
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--line-subtle)] px-3">
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--ink)]">
                      {
                        ENTITY_CATEGORIES.find(
                          (category) => category.id === entityKind,
                        )?.label
                      }
                    </h2>
                    <p className="mt-0.5 text-xs text-[var(--ink-subtle)]">
                      {currentEntries.length} 条
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addEntry}
                    title="添加条目"
                    aria-label="添加条目"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {currentEntries.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedEntryId(item.id)}
                      className={`mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors ${item.id === selectedEntry?.id ? "bg-[var(--accent-cool-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                    >
                      <span className="block truncate text-sm font-medium">
                        {entryLabel(entityKind, item)}
                      </span>
                      <span className="mt-1 block truncate text-xs text-[var(--ink-subtle)]">
                        {entryMeta(entityKind, item)}
                      </span>
                    </button>
                  ))}
                  {currentEntries.length === 0 && (
                    <p className="px-3 py-10 text-center text-sm text-[var(--ink-muted)]">
                      {
                        ENTITY_CATEGORIES.find(
                          (category) => category.id === entityKind,
                        )?.emptyText
                      }
                    </p>
                  )}
                </div>
              </section>

              <section className="min-w-0 flex-1 overflow-y-auto bg-[var(--paper)]">
                {selectedEntry ? (
                  <EntryDetail
                    kind={entityKind}
                    item={selectedEntry}
                    fieldError={
                      fieldErrors[fieldErrorKey(entityKind, selectedEntry.id)]
                    }
                    worldNodes={worldNodes}
                    characters={characters}
                    onOpenWorldNode={onOpenWorldNode}
                    onInspectCharacter={setInspectedCharacter}
                    onChange={(next) => {
                      if (entityKind === "territories")
                        update({
                          territories: draft.territories.map((item) =>
                            item.id === next.id
                              ? (next as FactionTerritory)
                              : item,
                          ),
                        });
                      else if (entityKind === "members")
                        update({
                          members: draft.members.map((item) =>
                            item.id === next.id
                              ? (next as FactionMember)
                              : item,
                          ),
                        });
                      else if (entityKind === "assets")
                        update({
                          assets: draft.assets.map((item) =>
                            item.id === next.id ? (next as FactionAsset) : item,
                          ),
                        });
                      else
                        update({
                          resources: draft.resources.map((item) =>
                            item.id === next.id
                              ? (next as FactionResource)
                              : item,
                          ),
                        });
                    }}
                    onRemove={() => removeEntry(entityKind, selectedEntry.id)}
                  />
                ) : (
                  <EmptyDetailState
                    label={
                      ENTITY_CATEGORIES.find(
                        (category) => category.id === entityKind,
                      )?.label ?? "条目"
                    }
                    onAdd={addEntry}
                  />
                )}
              </section>
            </section>
          </>
        )}
      </main>
      {inspectedCharacter && (
        <CharacterDetailDialog
          character={inspectedCharacter}
          onClose={() => setInspectedCharacter(null)}
        />
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      正在读取势力组织
    </div>
  );
}

function EmptyFactionState({ onCreate }: { readonly onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-[var(--ink-muted)]">
      <Building2 className="h-7 w-7" />
      <p className="mt-3 text-sm">尚未创建势力组织</p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-4 flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-3 text-sm font-medium text-[var(--ink)] hover:bg-[var(--hover-bg)]"
      >
        <Plus className="h-3.5 w-3.5" />
        新建势力
      </button>
    </div>
  );
}

function EmptyDetailState({
  label,
  onAdd,
}: {
  readonly label: string;
  readonly onAdd: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center text-[var(--ink-muted)]">
      <Building2 className="h-6 w-6" />
      <p className="mt-3 text-sm">选择或创建一条{label}记录</p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-3 text-sm font-medium text-[var(--ink)] hover:bg-[var(--hover-bg)]"
      >
        <Plus className="h-3.5 w-3.5" />
        添加{label}
      </button>
    </div>
  );
}

function DetailLayout({
  icon: Icon,
  title,
  subtitle,
  onRemove,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly subtitle: string;
  readonly onRemove: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-6 max-md:px-4">
      <header className="flex items-start justify-between gap-4 border-b border-[var(--line-strong)] pb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--accent-cool)]">
            <Icon className="h-3.5 w-3.5" />
            {subtitle}
          </div>
          <h1 className="mt-2 truncate text-xl font-semibold text-[var(--ink)]">
            {title}
          </h1>
        </div>
        <button
          type="button"
          onClick={onRemove}
          title="删除条目"
          aria-label="删除条目"
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="space-y-5 py-5">{children}</div>
    </div>
  );
}

function EntryDetail({
  kind,
  item,
  fieldError,
  worldNodes,
  characters,
  onOpenWorldNode,
  onInspectCharacter,
  onChange,
  onRemove,
}: {
  readonly kind: EntityKind;
  readonly item:
    | FactionTerritory
    | FactionMember
    | FactionAsset
    | FactionResource;
  readonly fieldError?: string;
  readonly worldNodes: readonly WorldNode[];
  readonly characters: readonly CharacterRecord[];
  readonly onOpenWorldNode?: (nodeId: string) => void;
  readonly onInspectCharacter: (character: CharacterRecord) => void;
  readonly onChange: (
    item: FactionTerritory | FactionMember | FactionAsset | FactionResource,
  ) => void;
  readonly onRemove: () => void;
}) {
  if (kind === "territories") {
    const territory = item as FactionTerritory;
    return (
      <DetailLayout
        icon={MapPinned}
        title={territory.name || "未命名地盘"}
        subtitle="地盘详情"
        onRemove={onRemove}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <FieldLabel label="关联世界架构">
            <div className="flex min-w-0 gap-1.5">
              <WorldNodePicker
                nodes={worldNodes}
                value={territory.worldNodeId}
                onChange={(worldNodeId) => {
                  const node = worldNodes.find(
                    (entry) => entry.id === worldNodeId,
                  );
                  onChange({
                    ...territory,
                    worldNodeId,
                    name: node ? node.name : territory.name,
                  });
                }}
              />
              <OpenLinkedEntityButton
                label="打开关联世界架构"
                disabled={!territory.worldNodeId || !onOpenWorldNode}
                onClick={() =>
                  territory.worldNodeId &&
                  onOpenWorldNode?.(territory.worldNodeId)
                }
              />
            </div>
          </FieldLabel>
          <FieldLabel label="地盘名称" error={fieldError}>
            <input
              className={`${inputClass} ${fieldError ? invalidInputClass : ""}`}
              value={territory.name}
              placeholder="据点、辖区或城池名称"
              onChange={(event) =>
                onChange({ ...territory, name: event.target.value })
              }
            />
          </FieldLabel>
        </div>
        <FieldLabel label="说明">
          <textarea
            className={descriptionClass}
            value={territory.description}
            placeholder="控制范围、地理特点、据点布局、战略意义与当前状况"
            onChange={(event) =>
              onChange({ ...territory, description: event.target.value })
            }
          />
        </FieldLabel>
      </DetailLayout>
    );
  }
  if (kind === "members") {
    const member = item as FactionMember;
    const character = member.characterId
      ? characters.find((entry) => entry.id === member.characterId)
      : undefined;
    return (
      <DetailLayout
        icon={Users}
        title={member.name || "未命名成员"}
        subtitle="人物详情"
        onRemove={onRemove}
      >
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <FieldLabel label="关联人物">
            <div className="flex min-w-0 gap-1.5">
              <CharacterPicker
                characters={characters}
                value={member.characterId}
                onChange={(selected) =>
                  onChange({
                    ...member,
                    characterId: selected?.id ?? null,
                    name: selected ? selected.name : member.name,
                    count: selected ? 1 : member.count,
                  })
                }
              />
              {character && (
                <button
                  type="button"
                  onClick={() => onInspectCharacter(character)}
                  title={`查看${character.name}的人物详情`}
                  aria-label={`查看${character.name}的人物详情`}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--accent-cool)] hover:text-[var(--accent-cool)]"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </FieldLabel>
          <FieldLabel label="名称 / 类别" error={fieldError}>
            <input
              className={`${inputClass} ${fieldError ? invalidInputClass : ""}`}
              value={member.name}
              placeholder="打手、帮众或姓名"
              onChange={(event) =>
                onChange({ ...member, name: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="职责">
            <input
              className={inputClass}
              value={member.role}
              placeholder="成员"
              onChange={(event) =>
                onChange({ ...member, role: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="数量">
            <input
              className={inputClass}
              type="number"
              min="1"
              value={member.count}
              onChange={(event) =>
                onChange({
                  ...member,
                  count: Math.max(1, Number(event.target.value) || 1),
                })
              }
            />
          </FieldLabel>
        </div>
        <FieldLabel label="说明">
          <textarea
            className={descriptionClass}
            value={member.description}
            placeholder="身份、能力、与势力的关系、故事作用或近期动向"
            onChange={(event) =>
              onChange({ ...member, description: event.target.value })
            }
          />
        </FieldLabel>
      </DetailLayout>
    );
  }
  if (kind === "assets") {
    const asset = item as FactionAsset;
    return (
      <DetailLayout
        icon={Warehouse}
        title={asset.name || "未命名资产"}
        subtitle="经营资产详情"
        onRemove={onRemove}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <FieldLabel label="资产名称" error={fieldError}>
            <input
              className={`${inputClass} ${fieldError ? invalidInputClass : ""}`}
              value={asset.name}
              onChange={(event) =>
                onChange({ ...asset, name: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="类型">
            <input
              className={inputClass}
              value={asset.kind}
              placeholder="店铺、船队、矿场..."
              onChange={(event) =>
                onChange({ ...asset, kind: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="规模 / 收益">
            <input
              className={inputClass}
              value={asset.value}
              placeholder="规模、产出或收益"
              onChange={(event) =>
                onChange({ ...asset, value: event.target.value })
              }
            />
          </FieldLabel>
        </div>
        <FieldLabel label="说明">
          <textarea
            className={descriptionClass}
            value={asset.description}
            placeholder="资产来源、经营方式、实际控制人、风险与故事影响"
            onChange={(event) =>
              onChange({ ...asset, description: event.target.value })
            }
          />
        </FieldLabel>
      </DetailLayout>
    );
  }
  const resource = item as FactionResource;
  return (
    <DetailLayout
      icon={Swords}
      title={resource.name || "未命名资源"}
      subtitle="争夺资源详情"
      onRemove={onRemove}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <FieldLabel label="资源名称" error={fieldError}>
          <input
            className={`${inputClass} ${fieldError ? invalidInputClass : ""}`}
            value={resource.name}
            onChange={(event) =>
              onChange({ ...resource, name: event.target.value })
            }
          />
        </FieldLabel>
        <FieldLabel label="资源类型">
          <input
            className={inputClass}
            value={resource.kind}
            placeholder="灵矿、航线、情报..."
            onChange={(event) =>
              onChange({ ...resource, kind: event.target.value })
            }
          />
        </FieldLabel>
        <FieldLabel label="控制状态">
          <input
            className={inputClass}
            value={resource.control}
            placeholder="占有、争夺中..."
            onChange={(event) =>
              onChange({ ...resource, control: event.target.value })
            }
          />
        </FieldLabel>
      </div>
      <FieldLabel label="说明">
        <textarea
          className={descriptionClass}
          value={resource.description}
          placeholder="资源产地、价值、争夺方、控制方式与局势变化"
          onChange={(event) =>
            onChange({ ...resource, description: event.target.value })
          }
        />
      </FieldLabel>
    </DetailLayout>
  );
}

function OpenLinkedEntityButton({
  label,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "请先关联条目" : label}
      aria-label={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--accent-cool)] hover:text-[var(--accent-cool)] disabled:cursor-not-allowed disabled:opacity-35"
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </button>
  );
}

function WorldNodePicker({
  nodes,
  value,
  onChange,
}: {
  readonly nodes: readonly WorldNode[];
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const childrenByParent = useMemo(() => {
    const result = new Map<string | null, WorldNode[]>();
    nodes.forEach((node) => {
      const children = result.get(node.parentId) ?? [];
      children.push(node);
      result.set(node.parentId, children);
    });
    return result;
  }, [nodes]);
  const currentNode = value ? nodesById.get(value) : undefined;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleIds = useMemo(() => {
    if (!normalizedQuery) return new Set(nodes.map((node) => node.id));
    const visible = new Set<string>();
    nodes.forEach((node) => {
      if (!node.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
        return;
      let current: WorldNode | undefined = node;
      while (current) {
        visible.add(current.id);
        current = current.parentId
          ? nodesById.get(current.parentId)
          : undefined;
      }
    });
    return visible;
  }, [nodes, nodesById, normalizedQuery]);
  useEffect(() => {
    if (!open || !value) return;
    setExpanded((current) => {
      const next = new Set(current);
      let node = nodesById.get(value);
      while (node?.parentId) {
        next.add(node.parentId);
        node = nodesById.get(node.parentId);
      }
      return next;
    });
  }, [nodesById, open, value]);
  const renderNodes = (parentId: string | null, depth = 0): React.ReactNode =>
    (childrenByParent.get(parentId) ?? [])
      .filter((node) => visibleIds.has(node.id))
      .map((node) => {
        const descendants = (childrenByParent.get(node.id) ?? []).filter(
          (item) => visibleIds.has(item.id),
        );
        const isExpanded = Boolean(normalizedQuery) || expanded.has(node.id);
        return (
          <div
            key={node.id}
            role="treeitem"
            aria-expanded={descendants.length ? isExpanded : undefined}
          >
            <div
              className={`flex h-9 items-center gap-1 rounded-md pr-1 text-sm ${node.id === value ? "bg-[var(--accent-cool-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
              style={{ paddingLeft: `${Math.min(8 + depth * 18, 80)}px` }}
            >
              <button
                type="button"
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(node.id)) next.delete(node.id);
                    else next.add(node.id);
                    return next;
                  })
                }
                aria-label={
                  isExpanded ? `收起${node.name}` : `展开${node.name}`
                }
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ${descendants.length ? "" : "pointer-events-none opacity-0"}`}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  onChange(node.id);
                  setOpen(false);
                  setQuery("");
                }}
                className="min-w-0 flex-1 truncate text-left font-medium"
              >
                {node.name}
              </button>
            </div>
            {descendants.length > 0 &&
              isExpanded &&
              renderNodes(node.id, depth + 1)}
          </div>
        );
      });
  return (
    <div className="min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="tree"
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-left text-sm text-[var(--ink)] outline-none transition-colors hover:border-[var(--line-strong)] focus:border-[var(--accent-warm)]"
      >
        <MapPinned className="h-3.5 w-3.5 shrink-0 text-[var(--accent-cool)]" />
        <span
          className={`min-w-0 flex-1 truncate ${currentNode ? "" : "text-[var(--ink-subtle)]"}`}
        >
          {currentNode?.name ?? "选择世界节点"}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
      </button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery("");
        }}
        anchorRef={triggerRef}
        placement="bottom-start"
        className="w-[min(26rem,calc(100vw-2rem))]"
        unstyled
      >
        <div className="border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2.5">
            <span className="text-sm font-semibold text-[var(--ink)]">
              选择世界架构节点
            </span>
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
                setQuery("");
              }}
              className="text-xs text-[var(--ink-muted)] hover:text-[var(--ink)]"
            >
              解除关联
            </button>
          </div>
          <label className="m-3 flex h-9 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 focus-within:border-[var(--accent-warm)]">
            <Search className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索空间节点"
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                title="清空搜索"
                className="text-[var(--ink-subtle)] hover:text-[var(--ink)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
          <div role="tree" className="max-h-80 overflow-y-auto px-2 pb-2">
            {nodes.length ? (
              renderNodes(null)
            ) : (
              <p className="px-3 py-6 text-center text-sm text-[var(--ink-muted)]">
                暂无可关联的世界节点
              </p>
            )}
            {nodes.length > 0 && visibleIds.size === 0 && (
              <p className="px-3 py-6 text-center text-sm text-[var(--ink-muted)]">
                没有匹配的节点
              </p>
            )}
          </div>
        </div>
      </Popover>
    </div>
  );
}

function CharacterPicker({
  characters,
  value,
  onChange,
}: {
  readonly characters: readonly CharacterRecord[];
  readonly value: string | null;
  readonly onChange: (character: CharacterRecord | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const selected = value
    ? characters.find((character) => character.id === value)
    : undefined;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const results = useMemo(() => {
    if (!normalizedQuery) return characters;
    return characters.filter((character) =>
      `${character.name} ${character.alias} ${character.identities.join(" ")} ${character.summary}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery),
    );
  }, [characters, normalizedQuery]);
  const totalPages = Math.max(
    1,
    Math.ceil(results.length / CHARACTER_PICKER_PAGE_SIZE),
  );
  const currentPage = Math.min(page, totalPages);
  const pageResults = results.slice(
    (currentPage - 1) * CHARACTER_PICKER_PAGE_SIZE,
    currentPage * CHARACTER_PICKER_PAGE_SIZE,
  );

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setPage(1);
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-left text-sm text-[var(--ink)] outline-none transition-colors hover:border-[var(--line-strong)] focus:border-[var(--accent-warm)]"
      >
        <UserRound className="h-3.5 w-3.5 shrink-0 text-[var(--accent-cool)]" />
        <span
          className={`min-w-0 flex-1 truncate ${selected ? "" : "text-[var(--ink-subtle)]"}`}
        >
          {selected?.name ?? "选择人物"}
        </span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[260] flex items-center justify-center bg-black/35 p-5"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) close();
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="选择人物"
            className="flex max-h-[min(42rem,calc(100vh-2.5rem))] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-4">
              <div>
                <div className="text-xs font-medium text-[var(--accent-cool)]">
                  人物库
                </div>
                <h2 className="mt-1 text-lg font-semibold text-[var(--ink)]">
                  选择关联人物
                </h2>
              </div>
              <button
                type="button"
                onClick={close}
                title="关闭"
                aria-label="关闭人物选择"
                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <label className="m-4 flex h-10 shrink-0 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 focus-within:border-[var(--accent-warm)]">
              <Search className="h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
              <input
                autoFocus
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="搜索姓名、别名、身份或简介"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  title="清空搜索"
                  className="text-[var(--ink-subtle)] hover:text-[var(--ink)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--line-subtle)] px-3 py-2">
              {pageResults.map((character) => (
                <button
                  key={character.id}
                  type="button"
                  onClick={() => {
                    onChange(character);
                    close();
                  }}
                  className={`mb-1 flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors ${character.id === value ? "bg-[var(--accent-cool-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
                >
                  <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-cool)]" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--ink)]">
                        {character.name}
                      </span>
                      {character.alias && (
                        <span className="truncate text-xs text-[var(--ink-subtle)]">
                          {character.alias}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                      {character.identities.join("、") ||
                        character.summary ||
                        "未填写身份信息"}
                    </span>
                  </span>
                </button>
              ))}
              {results.length === 0 && (
                <p className="px-3 py-10 text-center text-sm text-[var(--ink-muted)]">
                  没有匹配的人物
                </p>
              )}
            </div>
            <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-[var(--line)] px-5 py-3">
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--ink-muted)]">
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={currentPage <= 1}
                  title="上一页"
                  aria-label="上一页"
                  className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-28 text-center">
                  {results.length} 人 · {currentPage} / {totalPages} 页
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPage((current) => Math.min(totalPages, current + 1))
                  }
                  disabled={currentPage >= totalPages}
                  title="下一页"
                  aria-label="下一页"
                  className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    onChange(null);
                    close();
                  }}
                  disabled={!selected}
                  className="text-sm text-[var(--ink-muted)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35"
                >
                  解除关联
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="h-8 rounded-md border border-[var(--line)] px-3 text-sm font-medium text-[var(--ink)] hover:bg-[var(--hover-bg)]"
                >
                  取消
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

function CharacterDetailDialog({
  character,
  onClose,
}: {
  readonly character: CharacterRecord;
  readonly onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/35 p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${character.name}的人物详情`}
        className="flex max-h-[min(46rem,calc(100vh-2.5rem))] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex shrink-0 items-start justify-between border-b border-[var(--line)] px-5 py-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-[var(--accent-cool)]">
              人物库关联
            </div>
            <h2 className="mt-1 truncate text-lg font-semibold text-[var(--ink)]">
              {character.name}
            </h2>
            {character.alias && (
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                {character.alias}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭人物详情"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-5">
          <div className="grid gap-x-6 gap-y-4 border-b border-[var(--line-subtle)] pb-5 sm:grid-cols-3">
            <DialogFact label="戏份">
              {ROLE_LABELS[character.roleWeight]}
            </DialogFact>
            <DialogFact label="身份职业">
              {character.identities.join("、") || "未填写"}
            </DialogFact>
            <DialogFact label="状态">{character.status || "未填写"}</DialogFact>
            <DialogFact label="年龄">{character.age || "未填写"}</DialogFact>
            <DialogFact label="性别">{character.gender || "未填写"}</DialogFact>
            <DialogFact label="家乡">
              {character.hometown || "未填写"}
            </DialogFact>
          </div>
          <DialogSection title="人物概要">
            {character.summary || "未填写人物简介"}
          </DialogSection>
          <DialogSection title="外在设定">
            {character.appearance || "未填写外貌设定"}
          </DialogSection>
          <DialogSection title="性格与价值">
            {[character.personality, character.values]
              .filter(Boolean)
              .join("\n\n") || "未填写"}
          </DialogSection>
          <DialogSection title="动机与目标">
            {[character.motivation, character.goals, character.innerConflict]
              .filter(Boolean)
              .join("\n\n") || "未填写"}
          </DialogSection>
        </div>
      </section>
    </div>
  );
}

function DialogFact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs text-[var(--ink-muted)]">{label}</div>
      <div className="mt-1 truncate text-sm text-[var(--ink)]">{children}</div>
    </div>
  );
}

function DialogSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="border-b border-[var(--line-subtle)] py-5 last:border-b-0">
      <h3 className="text-sm font-semibold text-[var(--ink)]">{title}</h3>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">
        {children}
      </p>
    </section>
  );
}
