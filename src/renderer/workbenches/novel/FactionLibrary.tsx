import {
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  ExternalLink,
  FileClock,
  GitFork,
  Landmark,
  Link2,
  Loader2,
  MapPinned,
  Network,
  Plus,
  Save,
  Search,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Swords,
  Trash2,
  UserRound,
  Users,
  Warehouse,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CustomSelect, Popover, type WorkbenchStorage } from "@/workbench-sdk";

import { createNovelCharacterLibraryRepository } from "./characterLibraryRepository";
import {
  createNovelFactionLibraryRepository,
  type LoadedFactionLibrary,
} from "./factionLibraryRepository";
import {
  type FactionAsset,
  type FactionLink,
  type FactionMember,
  type FactionOrganizationUnit,
  type FactionRecord,
  type FactionRelation,
  type FactionResource,
  type FactionRight,
  type FactionTerritory,
} from "./factionLibrarySchema";
import type { CharacterRecord } from "./characterLibrarySchema";
import { createNovelTimelineLibraryRepository } from "./timelineLibraryRepository";
import { createNovelSettingLibraryRepository } from "./settingLibraryRepository";

interface FactionLibraryProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
  readonly onOpenWorldNode?: (nodeId: string) => void;
  readonly onOpenAiAgent?: (target: FactionAiTarget) => Promise<void>;
  readonly isAiAgentLaunching?: boolean;
  readonly onOpenBatchAgent?: () => Promise<void>;
  readonly isBatchAgentLaunching?: boolean;
}

interface WorldNode {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

type StoredEntityKind =
  | "territories"
  | "members"
  | "assets"
  | "resources"
  | "organizationUnits"
  | "relations"
  | "rights"
  | "links";
type EntityKind = StoredEntityKind | "history";
type FactionEntry =
  | FactionTerritory
  | FactionMember
  | FactionAsset
  | FactionResource
  | FactionOrganizationUnit
  | FactionRelation
  | FactionRight
  | FactionLink;

export type FactionAiScope =
  | "organization"
  | "relations"
  | "resources"
  | "rights"
  | "history";

export interface FactionAiTarget {
  readonly scope: FactionAiScope;
  readonly targetFactionId?: string;
  readonly requirements?: string;
}

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
  {
    id: "organizationUnits",
    label: "组织",
    emptyText: "暂无组织单元",
    icon: Landmark,
  },
  { id: "relations", label: "关系", emptyText: "暂无对外关系", icon: Network },
  {
    id: "rights",
    label: "权限",
    emptyText: "暂无权利与名分",
    icon: ShieldCheck,
  },
  { id: "links", label: "关联", emptyText: "暂无跨库关联", icon: Link2 },
  {
    id: "history",
    label: "历史",
    emptyText: "暂无关联时间线事件",
    icon: FileClock,
  },
];

const ROLE_LABELS: Readonly<Record<CharacterRecord["roleWeight"], string>> = {
  main: "主要角色",
  secondary: "次要角色",
  npc: "NPC",
  extra: "路人",
};

const CHARACTER_PICKER_PAGE_SIZE = 50;
const FACTION_PICKER_PAGE_SIZE = 50;
const FACTION_LIST_PAGE_SIZE = 100;

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
    state: {
      governance: "",
      military: "",
      economy: "",
      publicSupport: "",
      territorialIntegrity: "",
    },
    territories: [],
    members: [],
    assets: [],
    resources: [],
    organizationUnits: [],
    relations: [],
    rights: [],
    links: [],
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
      competingFactionIds: [...new Set(item.competingFactionIds)],
      history: item.history
        .map((entry) => ({
          ...entry,
          timeLabel: entry.timeLabel.trim(),
          summary: entry.summary.trim(),
        }))
        .filter((entry) => entry.timeLabel || entry.summary),
      description: item.description.trim(),
    }),
  );
  const organizationUnits = draft.organizationUnits.map(
    (item): FactionOrganizationUnit => ({
      ...item,
      name: nameOrDefault(item.name, "未命名组织单元"),
      kind: item.kind.trim(),
      description: item.description.trim(),
    }),
  );
  const relations = draft.relations.map(
    (item): FactionRelation => ({
      ...item,
      startedAt: item.startedAt.trim(),
      endedAt: item.endedAt.trim(),
      description: item.description.trim(),
    }),
  );
  const rights = draft.rights.map(
    (item): FactionRight => ({
      ...item,
      name: nameOrDefault(item.name, "未命名权利"),
      scope: item.scope.trim(),
      startedAt: item.startedAt.trim(),
      endedAt: item.endedAt.trim(),
      description: item.description.trim(),
    }),
  );
  const links = draft.links.map(
    (item): FactionLink => ({
      ...item,
      label: nameOrDefault(item.label, "未命名关联"),
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
  organizationUnits.forEach((item) => {
    if (!item.name)
      fieldErrors[`organization:${item.id}`] = "请填写组织单元名称";
  });
  rights.forEach((item) => {
    if (!item.name) fieldErrors[`right:${item.id}`] = "请填写权利名称";
  });
  links.forEach((item) => {
    if (!item.label) fieldErrors[`link:${item.id}`] = "请填写关联名称";
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
      organizationUnits,
      relations,
      rights,
      links,
      updatedAt: new Date().toISOString(),
    },
    fieldErrors,
  };
}

function entryLabel(
  kind: StoredEntityKind,
  item: FactionEntry,
  factions: readonly FactionRecord[],
): string {
  if (kind === "territories")
    return (item as FactionTerritory).name || "未命名地盘";
  if (kind === "members") return (item as FactionMember).name || "未命名成员";
  if (kind === "assets") return (item as FactionAsset).name || "未命名资产";
  if (kind === "resources")
    return (item as FactionResource).name || "未命名资源";
  if (kind === "organizationUnits") {
    return (item as FactionOrganizationUnit).name || "未命名组织单元";
  }
  if (kind === "relations") {
    const relation = item as FactionRelation;
    return (
      factions.find((faction) => faction.id === relation.targetFactionId)
        ?.name ?? "未关联势力"
    );
  }
  if (kind === "rights") return (item as FactionRight).name || "未命名权利";
  return (item as FactionLink).label || "未命名关联";
}

function entryMeta(kind: StoredEntityKind, item: FactionEntry): string {
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
  if (kind === "resources") {
    const resource = item as FactionResource;
    return (
      [resource.kind, resource.control].filter(Boolean).join(" · ") ||
      "未填写资源状态"
    );
  }
  if (kind === "organizationUnits") {
    const unit = item as FactionOrganizationUnit;
    return unit.kind || "组织单元";
  }
  if (kind === "relations") {
    const relation = item as FactionRelation;
    const label: Record<FactionRelation["kind"], string> = {
      subordinate: "隶属",
      alliance: "联盟",
      hostile: "敌对",
      competitive: "竞争",
      dependent: "依附",
    };
    return `${label[relation.kind]} · ${relation.status === "active" ? "有效" : relation.status === "suspended" ? "暂停" : "结束"}`;
  }
  if (kind === "rights") {
    const right = item as FactionRight;
    return [right.scope, right.status === "active" ? "生效" : "失效"]
      .filter(Boolean)
      .join(" · ");
  }
  const link = item as FactionLink;
  return link.kind;
}

function fieldErrorKey(kind: StoredEntityKind, id: string): string {
  if (kind === "territories") return `territory:${id}`;
  if (kind === "members") return `member:${id}`;
  if (kind === "assets") return `asset:${id}`;
  if (kind === "resources") return `resource:${id}`;
  if (kind === "organizationUnits") return `organization:${id}`;
  if (kind === "rights") return `right:${id}`;
  if (kind === "links") return `link:${id}`;
  return `relation:${id}`;
}

export default function FactionLibrary({
  storage,
  projectTitle,
  isActive,
  onOpenWorldNode,
  onOpenAiAgent,
  isAiAgentLaunching = false,
  onOpenBatchAgent,
  isBatchAgentLaunching = false,
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
  const [timelineEvents, setTimelineEvents] = useState<
    readonly {
      readonly id: string;
      readonly title: string;
      readonly timeLabel: string;
      readonly summary: string;
      readonly sortKey: number;
      readonly factionIds: readonly string[];
    }[]
  >([]);
  const [entityKind, setEntityKind] = useState<EntityKind>("territories");
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [factionQuery, setFactionQuery] = useState("");
  const [factionListPage, setFactionListPage] = useState(1);
  const [inspectedCharacter, setInspectedCharacter] =
    useState<CharacterRecord | null>(null);
  const [pendingFaction, setPendingFaction] = useState<FactionRecord | null>(
    null,
  );
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
      const [next, people, world, timeline] = await Promise.all([
        repository.load(),
        createNovelCharacterLibraryRepository(storage)
          .load()
          .catch(() => null),
        createNovelSettingLibraryRepository(storage)
          .load(projectTitle)
          .catch(() => null),
        createNovelTimelineLibraryRepository(storage)
          .load()
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
      setTimelineEvents(
        timeline?.library.events.map((event) => ({
          id: event.id,
          title: event.title,
          timeLabel: event.timeLabel,
          summary: event.summary,
          sortKey: event.sortKey,
          factionIds: event.factionIds,
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

  const applyFactionSelection = (faction: FactionRecord) => {
    selectedIdRef.current = faction.id;
    setSelectedId(faction.id);
    setDraft(structuredClone(faction));
    setSelectedEntryId("");
    setError(null);
    setFieldErrors({});
  };

  const selectFaction = (faction: FactionRecord) => {
    if (faction.id === selectedId || isSaving) return;
    if (isDirty) {
      setPendingFaction(faction);
      return;
    }
    applyFactionSelection(faction);
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

  const save = async (): Promise<boolean> => {
    if (!loaded || !draft) return false;
    const normalized = normalizeDraft(draft);
    if (Object.keys(normalized.fieldErrors).length > 0) {
      setFieldErrors(normalized.fieldErrors);
      setError("请先补充带有提示的必填项，再保存势力档案。");
      return false;
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
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const saveAndSwitchFaction = async () => {
    const target = pendingFaction;
    if (!target) return;
    const saved = await save();
    setPendingFaction(null);
    if (saved) applyFactionSelection(target);
  };

  const discardAndSwitchFaction = () => {
    if (!pendingFaction) return;
    applyFactionSelection(pendingFaction);
    setPendingFaction(null);
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
        factions: loaded.library.factions
          .filter((item) => item.id !== draft.id)
          .map((item) => ({
            ...item,
            relations: item.relations.filter(
              (relation) => relation.targetFactionId !== draft.id,
            ),
            rights: item.rights.map((right) =>
              right.issuerFactionId === draft.id
                ? { ...right, issuerFactionId: null }
                : right,
            ),
            resources: item.resources.map((resource) => ({
              ...resource,
              competingFactionIds: resource.competingFactionIds.filter(
                (factionId) => factionId !== draft.id,
              ),
            })),
          })),
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
    if (!draft || entityKind === "history")
      return [] as readonly FactionEntry[];
    return draft[entityKind] as readonly FactionEntry[];
  }, [draft, entityKind]);
  const selectedEntry =
    currentEntries.find((item) => item.id === selectedEntryId) ??
    currentEntries[0] ??
    null;
  const factionHistory = useMemo(
    () =>
      draft
        ? timelineEvents
            .filter((event) => event.factionIds.includes(draft.id))
            .sort((left, right) => right.sortKey - left.sortKey)
        : [],
    [draft, timelineEvents],
  );
  const filteredFactions = useMemo(() => {
    const normalizedQuery = factionQuery.trim().toLocaleLowerCase("zh-CN");
    const factions = loaded?.library.factions ?? [];
    if (!normalizedQuery) return factions;
    return factions.filter((faction) =>
      `${faction.name} ${faction.type} ${faction.summary}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery),
    );
  }, [factionQuery, loaded?.library.factions]);
  const factionListTotalPages = Math.max(
    1,
    Math.ceil(filteredFactions.length / FACTION_LIST_PAGE_SIZE),
  );
  const currentFactionListPage = Math.min(
    factionListPage,
    factionListTotalPages,
  );
  const visibleFactions = filteredFactions.slice(
    (currentFactionListPage - 1) * FACTION_LIST_PAGE_SIZE,
    currentFactionListPage * FACTION_LIST_PAGE_SIZE,
  );
  const organizationDepthById = useMemo(() => {
    const result = new Map<string, number>();
    if (!draft) return result;
    const byId = new Map(
      draft.organizationUnits.map((unit) => [unit.id, unit]),
    );
    draft.organizationUnits.forEach((unit) => {
      let depth = 0;
      let parentId = unit.parentId;
      const visited = new Set([unit.id]);
      while (parentId && !visited.has(parentId) && depth < 5) {
        visited.add(parentId);
        depth += 1;
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      result.set(unit.id, depth);
    });
    return result;
  }, [draft]);
  const isDirty = useMemo(() => {
    if (!draft) return false;
    const persisted = loaded?.library.factions.find(
      (faction) => faction.id === draft.id,
    );
    return !persisted || JSON.stringify(draft) !== JSON.stringify(persisted);
  }, [draft, loaded]);

  useEffect(() => {
    if (entityKind === "history") {
      if (factionHistory.some((event) => event.id === selectedEntryId)) return;
      setSelectedEntryId(factionHistory[0]?.id ?? "");
      return;
    }
    if (selectedEntry?.id === selectedEntryId) return;
    setSelectedEntryId(selectedEntry?.id ?? "");
  }, [entityKind, factionHistory, selectedEntry, selectedEntryId]);

  const addEntry = () => {
    if (!draft) return;
    if (entityKind === "history") return;
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
    if (entityKind === "resources") {
      const item: FactionResource = {
        id: createId("resource"),
        name: "未命名资源",
        kind: "",
        control: "",
        controlLevel: "contested",
        worldNodeId: null,
        itemId: null,
        competingFactionIds: [],
        history: [],
        description: "",
      };
      update({ resources: [...draft.resources, item] });
      setSelectedEntryId(item.id);
      return;
    }
    if (entityKind === "organizationUnits") {
      const item: FactionOrganizationUnit = {
        id: createId("unit"),
        parentId: null,
        name: "未命名组织单元",
        kind: "",
        leaderMemberId: null,
        description: "",
      };
      update({ organizationUnits: [...draft.organizationUnits, item] });
      setSelectedEntryId(item.id);
      return;
    }
    if (entityKind === "relations") {
      const target = (loaded?.library.factions ?? []).find(
        (faction) => faction.id !== draft.id,
      );
      if (!target) {
        setError("请先创建至少一个其他势力，才能建立势力关系。");
        return;
      }
      const item: FactionRelation = {
        id: createId("relation"),
        targetFactionId: target.id,
        kind: "alliance",
        direction: "mutual",
        status: "active",
        startedAt: "",
        endedAt: "",
        description: "",
      };
      update({ relations: [...draft.relations, item] });
      setSelectedEntryId(item.id);
      return;
    }
    if (entityKind === "rights") {
      const item: FactionRight = {
        id: createId("right"),
        name: "未命名权利",
        kind: "custom",
        issuerFactionId: null,
        worldNodeId: null,
        scope: "",
        status: "active",
        startedAt: "",
        endedAt: "",
        description: "",
      };
      update({ rights: [...draft.rights, item] });
      setSelectedEntryId(item.id);
      return;
    }
    const item: FactionLink = {
      id: createId("link"),
      kind: "custom",
      targetId: null,
      label: "未命名关联",
      description: "",
    };
    update({ links: [...draft.links, item] });
    setSelectedEntryId(item.id);
  };

  const removeEntry = (kind: StoredEntityKind, id: string) => {
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
    else if (kind === "resources")
      update({ resources: draft.resources.filter((item) => item.id !== id) });
    else if (kind === "organizationUnits")
      update({
        organizationUnits: draft.organizationUnits
          .filter((item) => item.id !== id)
          .map((item) =>
            item.parentId === id ? { ...item, parentId: null } : item,
          ),
      });
    else if (kind === "relations")
      update({ relations: draft.relations.filter((item) => item.id !== id) });
    else if (kind === "rights")
      update({ rights: draft.rights.filter((item) => item.id !== id) });
    else update({ links: draft.links.filter((item) => item.id !== id) });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--paper)]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-2 max-md:flex-wrap">
        <div className="flex min-w-0 items-center gap-3">
          <Building2 className="h-5 w-5 shrink-0 text-[var(--accent-warm)]" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">势力组织</h1>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              {projectTitle} · {loaded?.library.factions.length ?? 0} 个势力 ·{" "}
              {isSaving ? "保存中" : isDirty ? "待保存" : "已保存"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onOpenBatchAgent?.()}
          disabled={
            !onOpenBatchAgent || isBatchAgentLaunching || isAiAgentLaunching
          }
          aria-label={
            isBatchAgentLaunching ? "正在启动 Agent" : "AI 批量设计势力"
          }
          title={
            onOpenBatchAgent
              ? "打开势力批量设计 Agent"
              : "MyAgents Agent Session 当前不可用"
          }
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-warm-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isBatchAgentLaunching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          <span className="max-lg:hidden">
            {isBatchAgentLaunching ? "正在启动" : "AI 批量设计"}
          </span>
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--line-strong)] bg-[var(--paper-elevated)] max-lg:w-56 max-md:hidden">
          <div className="border-b border-[var(--line-subtle)] p-3">
            <div className="flex items-center gap-2">
              <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 focus-within:border-[var(--accent-warm)]">
                <Search className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                <input
                  value={factionQuery}
                  onChange={(event) => {
                    setFactionQuery(event.target.value);
                    setFactionListPage(1);
                  }}
                  placeholder="搜索势力"
                  className="min-w-0 flex-1 bg-transparent text-xs text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
                />
              </label>
              <button
                type="button"
                onClick={startNewFaction}
                title="新建势力"
                aria-label="新建势力"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {visibleFactions.map((faction) => (
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
            {!isLoading && filteredFactions.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-[var(--ink-muted)]">
                {factionQuery ? "没有匹配的势力" : "暂无势力组织"}
              </p>
            )}
          </div>
          {filteredFactions.length > FACTION_LIST_PAGE_SIZE && (
            <div className="flex h-10 shrink-0 items-center justify-between border-t border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
              <button
                type="button"
                onClick={() =>
                  setFactionListPage((page) => Math.max(1, page - 1))
                }
                disabled={currentFactionListPage <= 1}
                title="上一页"
                aria-label="上一页"
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] disabled:opacity-35"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span>
                {currentFactionListPage} / {factionListTotalPages}
              </span>
              <button
                type="button"
                onClick={() =>
                  setFactionListPage((page) =>
                    Math.min(factionListTotalPages, page + 1),
                  )
                }
                disabled={currentFactionListPage >= factionListTotalPages}
                title="下一页"
                aria-label="下一页"
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] disabled:opacity-35"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
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
              <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-2 max-md:flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium text-[var(--accent-cool)]">
                    <Building2 className="h-3.5 w-3.5" />
                    当前编辑势力
                  </div>
                  <h2 className="mt-1 truncate text-base font-semibold text-[var(--ink)]">
                    {draft.name || "未命名势力"}
                  </h2>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void onOpenAiAgent?.({
                        scope:
                          entityKind === "organizationUnits"
                            ? "organization"
                            : entityKind === "relations"
                              ? "relations"
                              : entityKind === "resources"
                                ? "resources"
                                : entityKind === "rights"
                                  ? "rights"
                                  : "history",
                        targetFactionId: draft.id,
                      })
                    }
                    disabled={
                      !onOpenAiAgent ||
                      isAiAgentLaunching ||
                      isBatchAgentLaunching
                    }
                    title="AI 完善当前势力资料"
                    className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)] px-2.5 text-sm font-medium text-[var(--accent-cool)] transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isAiAgentLaunching ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    <span className="max-lg:hidden">
                      {isAiAgentLaunching ? "正在启动" : "AI 完善"}
                    </span>
                  </button>
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
                <div className="md:col-span-3">
                  <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-[var(--accent-cool)]">
                    <FileClock className="h-3.5 w-3.5" />
                    当前势力状态
                  </div>
                  <div className="grid gap-3 md:grid-cols-5">
                    {(
                      [
                        ["governance", "统治与治理"],
                        ["military", "军事实力"],
                        ["economy", "经济状况"],
                        ["publicSupport", "民望 / 声誉"],
                        ["territorialIntegrity", "领土完整度"],
                      ] as const
                    ).map(([key, label]) => (
                      <FieldLabel key={key} label={label}>
                        <input
                          className={inputClass}
                          value={draft.state[key]}
                          placeholder="未设定"
                          onChange={(event) =>
                            update({
                              state: {
                                ...draft.state,
                                [key]: event.target.value,
                              },
                            })
                          }
                        />
                      </FieldLabel>
                    ))}
                  </div>
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
                      const count =
                        category.id === "history"
                          ? factionHistory.length
                          : draft[category.id].length;
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
                        {entityKind === "history"
                          ? factionHistory.length
                          : currentEntries.length}{" "}
                        条
                      </p>
                    </div>
                    {entityKind !== "history" && (
                      <button
                        type="button"
                        onClick={addEntry}
                        title="添加条目"
                        aria-label="添加条目"
                        className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {entityKind === "history"
                      ? factionHistory.map((event) => (
                          <button
                            key={event.id}
                            type="button"
                            onClick={() => setSelectedEntryId(event.id)}
                            className={`mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors ${event.id === selectedEntryId ? "bg-[var(--accent-cool-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                          >
                            <span className="block truncate text-sm font-medium">
                              {event.title}
                            </span>
                            <span className="mt-1 block truncate text-xs text-[var(--ink-subtle)]">
                              {event.timeLabel}
                            </span>
                          </button>
                        ))
                      : currentEntries.map((item) => {
                          const depth =
                            entityKind === "organizationUnits"
                              ? (organizationDepthById.get(item.id) ?? 0)
                              : 0;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setSelectedEntryId(item.id)}
                              style={
                                depth > 0
                                  ? { paddingLeft: `${12 + depth * 14}px` }
                                  : undefined
                              }
                              className={`mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors ${item.id === selectedEntry?.id ? "bg-[var(--accent-cool-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                            >
                              <span className="block truncate text-sm font-medium">
                                {entryLabel(
                                  entityKind,
                                  item,
                                  loaded?.library.factions ?? [],
                                )}
                              </span>
                              <span className="mt-1 block truncate text-xs text-[var(--ink-subtle)]">
                                {entryMeta(entityKind, item)}
                              </span>
                            </button>
                          );
                        })}
                    {(entityKind === "history"
                      ? factionHistory.length
                      : currentEntries.length) === 0 && (
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
                  {entityKind === "history" ? (
                    <FactionHistoryDetail
                      event={
                        factionHistory.find(
                          (event) => event.id === selectedEntryId,
                        ) ?? factionHistory[0]
                      }
                      faction={draft}
                    />
                  ) : selectedEntry ? (
                    <EntryDetail
                      kind={entityKind}
                      item={selectedEntry}
                      fieldError={
                        fieldErrors[fieldErrorKey(entityKind, selectedEntry.id)]
                      }
                      worldNodes={worldNodes}
                      characters={characters}
                      factions={loaded?.library.factions ?? []}
                      currentFactionId={draft.id}
                      organizationUnits={draft.organizationUnits}
                      members={draft.members}
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
                              item.id === next.id
                                ? (next as FactionAsset)
                                : item,
                            ),
                          });
                        else if (entityKind === "resources")
                          update({
                            resources: draft.resources.map((item) =>
                              item.id === next.id
                                ? (next as FactionResource)
                                : item,
                            ),
                          });
                        else if (entityKind === "organizationUnits")
                          update({
                            organizationUnits: draft.organizationUnits.map(
                              (item) =>
                                item.id === next.id
                                  ? (next as FactionOrganizationUnit)
                                  : item,
                            ),
                          });
                        else if (entityKind === "relations")
                          update({
                            relations: draft.relations.map((item) =>
                              item.id === next.id
                                ? (next as FactionRelation)
                                : item,
                            ),
                          });
                        else if (entityKind === "rights")
                          update({
                            rights: draft.rights.map((item) =>
                              item.id === next.id
                                ? (next as FactionRight)
                                : item,
                            ),
                          });
                        else
                          update({
                            links: draft.links.map((item) =>
                              item.id === next.id
                                ? (next as FactionLink)
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
      </div>
      {inspectedCharacter && (
        <CharacterDetailDialog
          character={inspectedCharacter}
          onClose={() => setInspectedCharacter(null)}
        />
      )}
      {pendingFaction && (
        <UnsavedFactionChangesDialog
          currentName={draft?.name || "当前势力"}
          targetName={pendingFaction.name || "未命名势力"}
          isSaving={isSaving}
          onSaveAndSwitch={() => void saveAndSwitchFaction()}
          onDiscardAndSwitch={discardAndSwitchFaction}
          onCancel={() => setPendingFaction(null)}
        />
      )}
    </div>
  );
}

function UnsavedFactionChangesDialog({
  currentName,
  targetName,
  isSaving,
  onSaveAndSwitch,
  onDiscardAndSwitch,
  onCancel,
}: {
  readonly currentName: string;
  readonly targetName: string;
  readonly isSaving: boolean;
  readonly onSaveAndSwitch: () => void;
  readonly onDiscardAndSwitch: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/35 p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (!isSaving && event.currentTarget === event.target) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-faction-changes-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="border-b border-[var(--line)] px-5 py-4">
          <h2
            id="unsaved-faction-changes-title"
            className="text-base font-semibold text-[var(--ink)]"
          >
            保存势力变更？
          </h2>
        </header>
        <div className="px-5 py-4 text-sm leading-6 text-[var(--ink-secondary)]">
          <p>
            “{currentName}”有未保存的变更。切换到“{targetName}
            ”前请决定如何处理。
          </p>
        </div>
        <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSaving}
            className="h-8 rounded-md border border-[var(--line)] px-3 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            继续编辑
          </button>
          <button
            type="button"
            onClick={onDiscardAndSwitch}
            disabled={isSaving}
            className="h-8 rounded-md px-3 text-sm font-medium text-[var(--error)] hover:bg-[var(--error-bg)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            放弃变更
          </button>
          <button
            type="button"
            onClick={onSaveAndSwitch}
            disabled={isSaving}
            className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-[var(--paper)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            保存并切换
          </button>
        </footer>
      </section>
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

function FactionHistoryDetail({
  event,
  faction,
}: {
  readonly event:
    | {
        readonly id: string;
        readonly title: string;
        readonly timeLabel: string;
        readonly summary: string;
      }
    | undefined;
  readonly faction: FactionRecord;
}) {
  if (!event) {
    return (
      <div className="mx-auto flex h-full max-w-3xl flex-col justify-center px-6 py-10 text-center text-[var(--ink-muted)]">
        <FileClock className="mx-auto h-7 w-7 text-[var(--accent-cool)]" />
        <h2 className="mt-3 text-base font-semibold text-[var(--ink)]">
          尚无关联历史
        </h2>
        <p className="mt-2 text-sm leading-6">
          在时间线事件中关联当前势力后，事件和状态变化会自动汇总到这里。势力库只保存当前快照，不重复维护第二份历史事实。
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl px-6 py-6 max-md:px-4">
      <header className="border-b border-[var(--line-strong)] pb-5">
        <div className="flex items-center gap-2 text-xs font-medium text-[var(--accent-cool)]">
          <ScrollText className="h-3.5 w-3.5" /> 时间线关联事件
        </div>
        <h1 className="mt-2 text-xl font-semibold text-[var(--ink)]">
          {event.title}
        </h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          {event.timeLabel}
        </p>
      </header>
      <section className="py-5">
        <p className="whitespace-pre-wrap text-sm leading-7 text-[var(--ink-secondary)]">
          {event.summary || "该事件尚未填写概要。"}
        </p>
      </section>
      <section className="border-t border-[var(--line-subtle)] py-5">
        <div className="flex items-center gap-2 text-xs font-medium text-[var(--accent-cool)]">
          <GitFork className="h-3.5 w-3.5" /> 当前势力快照
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {[
            ["统治与治理", faction.state.governance],
            ["军事实力", faction.state.military],
            ["经济状况", faction.state.economy],
            ["民望 / 声誉", faction.state.publicSupport],
            ["领土完整度", faction.state.territorialIntegrity],
          ].map(([label, value]) => (
            <div
              key={label}
              className="border-l-2 border-[var(--accent-warm)]/40 pl-3"
            >
              <dt className="text-xs text-[var(--ink-muted)]">{label}</dt>
              <dd className="mt-1 text-sm text-[var(--ink)]">
                {value || "未设定"}
              </dd>
            </div>
          ))}
        </dl>
      </section>
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
  factions,
  currentFactionId,
  organizationUnits,
  members,
  onOpenWorldNode,
  onInspectCharacter,
  onChange,
  onRemove,
}: {
  readonly kind: StoredEntityKind;
  readonly item: FactionEntry;
  readonly fieldError?: string;
  readonly worldNodes: readonly WorldNode[];
  readonly characters: readonly CharacterRecord[];
  readonly factions: readonly FactionRecord[];
  readonly currentFactionId: string;
  readonly organizationUnits: readonly FactionOrganizationUnit[];
  readonly members: readonly FactionMember[];
  readonly onOpenWorldNode?: (nodeId: string) => void;
  readonly onInspectCharacter: (character: CharacterRecord) => void;
  readonly onChange: (item: FactionEntry) => void;
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
  if (kind === "organizationUnits") {
    const unit = item as FactionOrganizationUnit;
    return (
      <DetailLayout
        icon={Landmark}
        title={unit.name || "未命名组织单元"}
        subtitle="组织层级详情"
        onRemove={onRemove}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <FieldLabel label="单元名称" error={fieldError}>
            <input
              className={`${inputClass} ${fieldError ? invalidInputClass : ""}`}
              value={unit.name}
              placeholder="刑堂、外门、州牧府、北方分号..."
              onChange={(event) =>
                onChange({ ...unit, name: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="单元类型">
            <input
              className={inputClass}
              value={unit.kind}
              placeholder="堂口、分支、官署、商号..."
              onChange={(event) =>
                onChange({ ...unit, kind: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="上级单元">
            <CustomSelect
              value={unit.parentId ?? ""}
              options={[
                { value: "", label: "无上级（根单元）" },
                ...organizationUnits
                  .filter((candidate) => candidate.id !== unit.id)
                  .map((candidate) => ({
                    value: candidate.id,
                    label: candidate.name,
                  })),
              ]}
              onChange={(parentId) =>
                onChange({ ...unit, parentId: parentId || null })
              }
              size="toolbar"
            />
          </FieldLabel>
          <FieldLabel label="负责人">
            <CustomSelect
              value={unit.leaderMemberId ?? ""}
              options={[
                { value: "", label: "未指定负责人" },
                ...members.map((member) => ({
                  value: member.id,
                  label: member.name,
                })),
              ]}
              onChange={(leaderMemberId) =>
                onChange({ ...unit, leaderMemberId: leaderMemberId || null })
              }
              size="toolbar"
            />
          </FieldLabel>
        </div>
        <FieldLabel label="说明">
          <textarea
            className={descriptionClass}
            value={unit.description}
            placeholder="职能、管辖范围、编制、晋升关系与当前状态"
            onChange={(event) =>
              onChange({ ...unit, description: event.target.value })
            }
          />
        </FieldLabel>
      </DetailLayout>
    );
  }
  if (kind === "relations") {
    const relation = item as FactionRelation;
    return (
      <DetailLayout
        icon={Network}
        title={
          factions.find((faction) => faction.id === relation.targetFactionId)
            ?.name ?? "未关联势力"
        }
        subtitle="势力关系详情"
        onRemove={onRemove}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <FieldLabel label="关联势力">
            <FactionPicker
              factions={factions.filter(
                (faction) => faction.id !== currentFactionId,
              )}
              value={relation.targetFactionId}
              onChange={(target) =>
                target && onChange({ ...relation, targetFactionId: target.id })
              }
            />
          </FieldLabel>
          <FieldLabel label="关系类型">
            <CustomSelect
              value={relation.kind}
              options={[
                { value: "subordinate", label: "隶属" },
                { value: "alliance", label: "联盟" },
                { value: "hostile", label: "敌对" },
                { value: "competitive", label: "竞争" },
                { value: "dependent", label: "依附" },
              ]}
              onChange={(kind) =>
                onChange({ ...relation, kind: kind as FactionRelation["kind"] })
              }
              size="toolbar"
            />
          </FieldLabel>
          <FieldLabel label="关系方向">
            <CustomSelect
              value={relation.direction}
              options={[
                { value: "outbound", label: "本势力指向对方" },
                { value: "inbound", label: "对方指向本势力" },
                { value: "mutual", label: "双向" },
              ]}
              onChange={(direction) =>
                onChange({
                  ...relation,
                  direction: direction as FactionRelation["direction"],
                })
              }
              size="toolbar"
            />
          </FieldLabel>
          <FieldLabel label="当前效力">
            <CustomSelect
              value={relation.status}
              options={[
                { value: "active", label: "有效" },
                { value: "suspended", label: "暂停" },
                { value: "ended", label: "已结束" },
              ]}
              onChange={(status) =>
                onChange({
                  ...relation,
                  status: status as FactionRelation["status"],
                })
              }
              size="toolbar"
            />
          </FieldLabel>
          <FieldLabel label="开始时间">
            <input
              className={inputClass}
              value={relation.startedAt}
              placeholder="故事时间或纪年"
              onChange={(event) =>
                onChange({ ...relation, startedAt: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="结束时间">
            <input
              className={inputClass}
              value={relation.endedAt}
              placeholder="未结束可留空"
              onChange={(event) =>
                onChange({ ...relation, endedAt: event.target.value })
              }
            />
          </FieldLabel>
        </div>
        <FieldLabel label="关系说明">
          <textarea
            className={descriptionClass}
            value={relation.description}
            placeholder="盟约、附庸条件、仇怨根源、竞争焦点与当前变化"
            onChange={(event) =>
              onChange({ ...relation, description: event.target.value })
            }
          />
        </FieldLabel>
      </DetailLayout>
    );
  }
  if (kind === "rights") {
    const right = item as FactionRight;
    return (
      <DetailLayout
        icon={ShieldCheck}
        title={right.name || "未命名权利"}
        subtitle="权限与法统详情"
        onRemove={onRemove}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <FieldLabel label="权利 / 名分" error={fieldError}>
            <input
              className={`${inputClass} ${fieldError ? invalidInputClass : ""}`}
              value={right.name}
              placeholder="通行权、皇室敕令、采购配额..."
              onChange={(event) =>
                onChange({ ...right, name: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="权利类型">
            <CustomSelect
              value={right.kind}
              options={[
                { value: "legitimacy", label: "法统" },
                { value: "title", label: "名分 / 封授" },
                { value: "jurisdiction", label: "辖权" },
                { value: "passage", label: "通行权" },
                { value: "procurement", label: "采购权" },
                { value: "trade", label: "贸易权" },
                { value: "mining", label: "采矿权" },
                { value: "taxation", label: "税权" },
                { value: "minting", label: "铸币权" },
                { value: "custom", label: "自定义" },
              ]}
              onChange={(kind) =>
                onChange({ ...right, kind: kind as FactionRight["kind"] })
              }
              size="toolbar"
            />
          </FieldLabel>
          <FieldLabel label="授予势力">
            <FactionPicker
              factions={factions.filter(
                (faction) => faction.id !== currentFactionId,
              )}
              value={right.issuerFactionId}
              onChange={(issuer) =>
                onChange({ ...right, issuerFactionId: issuer?.id ?? null })
              }
            />
          </FieldLabel>
          <FieldLabel label="适用地盘">
            <WorldNodePicker
              nodes={worldNodes}
              value={right.worldNodeId}
              onChange={(worldNodeId) => onChange({ ...right, worldNodeId })}
            />
          </FieldLabel>
          <FieldLabel label="适用范围">
            <input
              className={inputClass}
              value={right.scope}
              placeholder="地域、品类、额度或对象"
              onChange={(event) =>
                onChange({ ...right, scope: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="当前状态">
            <CustomSelect
              value={right.status}
              options={[
                { value: "active", label: "生效" },
                { value: "suspended", label: "暂停" },
                { value: "revoked", label: "已撤销" },
                { value: "expired", label: "已到期" },
              ]}
              onChange={(status) =>
                onChange({ ...right, status: status as FactionRight["status"] })
              }
              size="toolbar"
            />
          </FieldLabel>
          <FieldLabel label="取得时间">
            <input
              className={inputClass}
              value={right.startedAt}
              placeholder="故事时间或纪年"
              onChange={(event) =>
                onChange({ ...right, startedAt: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="终止时间">
            <input
              className={inputClass}
              value={right.endedAt}
              placeholder="未终止可留空"
              onChange={(event) =>
                onChange({ ...right, endedAt: event.target.value })
              }
            />
          </FieldLabel>
        </div>
        <FieldLabel label="说明">
          <textarea
            className={descriptionClass}
            value={right.description}
            placeholder="授予依据、约束条件、行使方式、争议与叙事影响"
            onChange={(event) =>
              onChange({ ...right, description: event.target.value })
            }
          />
        </FieldLabel>
      </DetailLayout>
    );
  }
  if (kind === "links") {
    const link = item as FactionLink;
    return (
      <DetailLayout
        icon={Link2}
        title={link.label || "未命名关联"}
        subtitle="跨库关联详情"
        onRemove={onRemove}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <FieldLabel label="关联类型">
            <CustomSelect
              value={link.kind}
              options={[
                { value: "trade-route", label: "商路" },
                { value: "war", label: "战争" },
                { value: "industry", label: "产业" },
                { value: "character", label: "人物" },
                { value: "setting", label: "世界设定" },
                { value: "item", label: "物品" },
                { value: "timeline", label: "时间线事件" },
                { value: "custom", label: "自定义" },
              ]}
              onChange={(kind) =>
                onChange({ ...link, kind: kind as FactionLink["kind"] })
              }
              size="toolbar"
            />
          </FieldLabel>
          <FieldLabel label="关联名称" error={fieldError}>
            <input
              className={`${inputClass} ${fieldError ? invalidInputClass : ""}`}
              value={link.label}
              placeholder="北境商路、赤水之战、盐铁行会..."
              onChange={(event) =>
                onChange({ ...link, label: event.target.value })
              }
            />
          </FieldLabel>
          <FieldLabel label="关联对象 ID">
            <input
              className={inputClass}
              value={link.targetId ?? ""}
              placeholder="可选：项目内稳定 ID"
              onChange={(event) =>
                onChange({
                  ...link,
                  targetId: event.target.value.trim() || null,
                })
              }
            />
          </FieldLabel>
          {link.kind === "character" && (
            <FieldLabel label="关联人物">
              <CharacterPicker
                characters={characters}
                value={link.targetId}
                onChange={(character) =>
                  onChange({
                    ...link,
                    targetId: character?.id ?? null,
                    label: character?.name ?? link.label,
                  })
                }
              />
            </FieldLabel>
          )}
          {["trade-route", "war", "industry", "setting"].includes(
            link.kind,
          ) && (
            <FieldLabel label="关联世界架构节点">
              <WorldNodePicker
                nodes={worldNodes}
                value={link.targetId}
                onChange={(targetId) => {
                  const node = worldNodes.find(
                    (candidate) => candidate.id === targetId,
                  );
                  onChange({
                    ...link,
                    targetId,
                    label: node?.name ?? link.label,
                  });
                }}
              />
            </FieldLabel>
          )}
        </div>
        <FieldLabel label="说明">
          <textarea
            className={descriptionClass}
            value={link.description}
            placeholder="该商路、战争、产业或人物如何影响势力；说明控制方式与叙事作用"
            onChange={(event) =>
              onChange({ ...link, description: event.target.value })
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
        <FieldLabel label="控制权等级">
          <CustomSelect
            value={resource.controlLevel}
            options={[
              { value: "owned", label: "完全占有" },
              { value: "dominant", label: "主导控制" },
              { value: "shared", label: "共同控制" },
              { value: "access", label: "仅有使用权" },
              { value: "contested", label: "争夺中" },
              { value: "lost", label: "已失去" },
            ]}
            onChange={(controlLevel) =>
              onChange({
                ...resource,
                controlLevel: controlLevel as FactionResource["controlLevel"],
              })
            }
            size="toolbar"
          />
        </FieldLabel>
        <FieldLabel label="资源所在地">
          <WorldNodePicker
            nodes={worldNodes}
            value={resource.worldNodeId}
            onChange={(worldNodeId) => onChange({ ...resource, worldNodeId })}
          />
        </FieldLabel>
      </div>
      <FieldLabel label="主要争夺势力">
        <div className="space-y-2">
          <FactionPicker
            factions={factions.filter(
              (faction) =>
                faction.id !== currentFactionId &&
                !resource.competingFactionIds.includes(faction.id),
            )}
            value={null}
            emptyLabel="添加争夺势力"
            onChange={(faction) => {
              if (!faction) return;
              onChange({
                ...resource,
                competingFactionIds: [
                  ...resource.competingFactionIds,
                  faction.id,
                ],
              });
            }}
          />
          {resource.competingFactionIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {resource.competingFactionIds.map((factionId) => {
                const faction = factions.find(
                  (entry) => entry.id === factionId,
                );
                return (
                  <button
                    key={factionId}
                    type="button"
                    onClick={() =>
                      onChange({
                        ...resource,
                        competingFactionIds:
                          resource.competingFactionIds.filter(
                            (id) => id !== factionId,
                          ),
                      })
                    }
                    title="移除争夺势力"
                    className="flex h-7 items-center gap-1 rounded-md bg-[var(--paper-inset)] px-2 text-xs text-[var(--ink-muted)] hover:text-[var(--error)]"
                  >
                    {faction?.name ?? "已删除势力"}
                    <X className="h-3 w-3" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </FieldLabel>
      <FieldLabel label="控制权争夺历史">
        <div className="space-y-2">
          {resource.history.map((entry, index) => (
            <div
              key={entry.id}
              className="grid gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-3 md:grid-cols-[10rem_minmax(0,1fr)_2rem]"
            >
              <input
                className={inputClass}
                value={entry.timeLabel}
                placeholder="时间"
                onChange={(event) =>
                  onChange({
                    ...resource,
                    history: resource.history.map((current) =>
                      current.id === entry.id
                        ? { ...current, timeLabel: event.target.value }
                        : current,
                    ),
                  })
                }
              />
              <input
                className={inputClass}
                value={entry.summary}
                placeholder="夺取、失守、分润或争端的结果"
                onChange={(event) =>
                  onChange({
                    ...resource,
                    history: resource.history.map((current) =>
                      current.id === entry.id
                        ? { ...current, summary: event.target.value }
                        : current,
                    ),
                  })
                }
              />
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...resource,
                    history: resource.history.filter(
                      (current) => current.id !== entry.id,
                    ),
                  })
                }
                title={`删除第 ${index + 1} 条历史`}
                aria-label={`删除第 ${index + 1} 条历史`}
                className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              onChange({
                ...resource,
                history: [
                  ...resource.history,
                  {
                    id: createId("resource-history"),
                    timeLabel: "",
                    summary: "",
                  },
                ],
              })
            }
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
          >
            <Plus className="h-3.5 w-3.5" />
            添加争夺记录
          </button>
        </div>
      </FieldLabel>
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
  const togglePicker = () => {
    if (!open && value) {
      setExpanded((current) => {
        const next = new Set(current);
        let node = nodesById.get(value);
        while (node?.parentId) {
          next.add(node.parentId);
          node = nodesById.get(node.parentId);
        }
        return next;
      });
    }
    setOpen((current) => !current);
  };
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
        onClick={togglePicker}
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

function FactionPicker({
  factions,
  value,
  onChange,
  emptyLabel = "选择势力",
}: {
  readonly factions: readonly FactionRecord[];
  readonly value: string | null;
  readonly onChange: (faction: FactionRecord | null) => void;
  readonly emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const selected = value
    ? factions.find((faction) => faction.id === value)
    : undefined;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const results = useMemo(
    () =>
      normalizedQuery
        ? factions.filter((faction) =>
            `${faction.name} ${faction.type} ${faction.summary}`
              .toLocaleLowerCase("zh-CN")
              .includes(normalizedQuery),
          )
        : factions,
    [factions, normalizedQuery],
  );
  const totalPages = Math.max(
    1,
    Math.ceil(results.length / FACTION_PICKER_PAGE_SIZE),
  );
  const currentPage = Math.min(page, totalPages);
  const pageResults = results.slice(
    (currentPage - 1) * FACTION_PICKER_PAGE_SIZE,
    currentPage * FACTION_PICKER_PAGE_SIZE,
  );
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
        className="flex h-9 min-w-0 w-full items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-left text-sm text-[var(--ink)] outline-none transition-colors hover:border-[var(--line-strong)] focus:border-[var(--accent-warm)]"
      >
        <Building2 className="h-3.5 w-3.5 shrink-0 text-[var(--accent-cool)]" />
        <span
          className={`min-w-0 flex-1 truncate ${selected ? "" : "text-[var(--ink-subtle)]"}`}
        >
          {selected?.name ?? emptyLabel}
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
            aria-label="选择势力"
            className="flex max-h-[min(42rem,calc(100vh-2.5rem))] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-4">
              <div>
                <div className="text-xs font-medium text-[var(--accent-cool)]">
                  势力组织
                </div>
                <h2 className="mt-1 text-lg font-semibold text-[var(--ink)]">
                  选择关联势力
                </h2>
              </div>
              <button
                type="button"
                onClick={close}
                title="关闭"
                aria-label="关闭势力选择"
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
                placeholder="搜索势力名称、类型或概要"
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
              {pageResults.map((faction) => (
                <button
                  key={faction.id}
                  type="button"
                  onClick={() => {
                    onChange(faction);
                    close();
                  }}
                  className={`mb-1 flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors ${faction.id === value ? "bg-[var(--accent-cool-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
                >
                  <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-cool)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--ink)]">
                      {faction.name}
                    </span>
                    <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                      {faction.type || faction.summary || "未填写势力类型"}
                    </span>
                  </span>
                </button>
              ))}
              {results.length === 0 && (
                <p className="px-3 py-10 text-center text-sm text-[var(--ink-muted)]">
                  没有匹配的势力
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
                  {results.length} 个 · {currentPage} / {totalPages} 页
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
