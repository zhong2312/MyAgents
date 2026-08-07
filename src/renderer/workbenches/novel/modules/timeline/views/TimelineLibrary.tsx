import "./TimelineLibrary.css";

import {
  BookOpenText,
  Building2,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock3,
  GitBranchPlus,
  GitCompareArrows,
  GitFork,
  ListTree,
  Loader2,
  MapPin,
  Milestone,
  PackageOpen,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { scaleLinear } from "d3";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  CustomSelect,
  DraggableDialogFrame,
  type SelectOption,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import { createNovelCharacterLibraryRepository } from "../../characters";
import { createNovelFactionLibraryRepository } from "../../factions/data-access/factionLibraryRepository";
import { createNovelItemLibraryRepository } from "../../../itemLibraryRepository";
import { createNovelLocationLibraryRepository } from "../../../locationLibraryRepository";
import { parseNovelChapterIndex } from "../../../projectSchema";
import {
  createNovelTimelineLibraryRepository,
  type LoadedTimelineLibrary,
} from "../data-access/timelineLibraryRepository";
import TimelineProposalReview from "./TimelineProposalReview";
import type { DomainEntityRef } from "../../../shared/business/domainIndex";
import {
  getTimelineBranchEvents,
  getTimelinePeriodDescendantIds,
  MAIN_TIMELINE_BRANCH_ID,
  type TimelineBranch,
  type TimelineCalendar,
  type TimelineEntityType,
  type TimelineEvent,
  type TimelineEventKind,
  type TimelineForeshadowing,
  type TimelineForeshadowingStatus,
  type TimelineKnowledgeScope,
  type TimelineLibrary,
  type TimelinePeriod,
  type TimelinePeriodKind,
  type TimelineProjectedEvent,
  type TimelineScope,
  type TimelineStateChange,
  type TimelineTimeExpression,
  type TimelineTimePrecision,
  type TimelineView,
} from "../entities/timelineLibrarySchema";
import TimelineAiDialog from "./TimelineAiDialog";
import {
  buildTimelineAiAgentRequest,
  type TimelineAiAgentRequest,
  type TimelineAiTaskId,
} from "../business/timelineAi";

interface TimelineLibraryProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
  readonly onOpenAiAgent?: (request: TimelineAiAgentRequest) => Promise<void>;
  /** 外部实体定位请求（T3 消费：优先定位到事件所属分支）。 */
  readonly focus?: DomainEntityRef | null;
}

interface ReferenceOption {
  readonly id: string;
  readonly name: string;
  readonly meta?: string;
}

interface TimelineReferences {
  readonly characters: readonly ReferenceOption[];
  readonly factions: readonly ReferenceOption[];
  readonly items: readonly ReferenceOption[];
  readonly locations: readonly ReferenceOption[];
  readonly chapters: readonly ReferenceOption[];
}

interface BranchDialogState {
  readonly mode: "create" | "edit";
  readonly branchId: string | null;
  readonly name: string;
  readonly parentBranchId: string | null;
  readonly forkEventId: string | null;
  readonly description: string;
}

interface PeriodDialogState {
  readonly mode: "create" | "edit";
  readonly periodId: string | null;
  readonly name: string;
  readonly parentPeriodId: string | null;
  readonly kind: TimelinePeriodKind;
  readonly scope: TimelineScope;
  readonly startSortKey: string;
  readonly endSortKey: string;
  readonly precision: TimelineTimePrecision;
  readonly description: string;
}

type TimelineSidebarMode = "periods" | "branches";

const EVENT_KIND_OPTIONS: SelectOption[] = [
  { value: "event", label: "重大事件" },
  { value: "turning-point", label: "剧情转折" },
  { value: "battle", label: "战斗 / 冲突" },
  { value: "discovery", label: "发现 / 揭示" },
  { value: "foreshadowing", label: "伏笔" },
  { value: "backstory", label: "历史 / 背景" },
];

const STATE_ENTITY_TYPE_OPTIONS: SelectOption[] = [
  { value: "character", label: "人物" },
  { value: "faction", label: "势力" },
  { value: "item", label: "物品" },
  { value: "location", label: "地点" },
];

const FORESHADOWING_STATUS_OPTIONS: SelectOption[] = [
  { value: "planted", label: "已埋设" },
  { value: "paid-off", label: "已回收" },
  { value: "abandoned", label: "已废弃" },
];

const PERIOD_KIND_OPTIONS: SelectOption[] = [
  { value: "era", label: "大时代" },
  { value: "epoch", label: "纪元" },
  { value: "age", label: "子纪元" },
  { value: "phase", label: "阶段" },
];

const TIMELINE_SCOPE_OPTIONS: SelectOption[] = [
  { value: "universe", label: "宇宙史" },
  { value: "local", label: "地方史" },
  { value: "story", label: "故事进程" },
];

const KNOWLEDGE_SCOPE_OPTIONS: SelectOption[] = [
  { value: "public", label: "凡俗可知" },
  { value: "local", label: "地方可知" },
  { value: "sect", label: "宗门秘闻" },
  { value: "high", label: "高阶档案" },
  { value: "observer", label: "观察者真相" },
];

const TIME_PRECISION_OPTIONS: SelectOption[] = [
  { value: "exact", label: "精确时间" },
  { value: "range", label: "时间区间" },
  { value: "approximate", label: "约略时间" },
  { value: "unknown", label: "未知时间" },
];

const inputClass =
  "timeline-input w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)] disabled:cursor-not-allowed disabled:bg-[var(--paper-inset)] disabled:text-[var(--ink-muted)]";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function createId(prefix: string): string {
  const token = globalThis.crypto?.randomUUID?.().slice(0, 8);
  return `${prefix}-${token ?? Date.now().toString(36)}`;
}

function compareEvents(left: TimelineEvent, right: TimelineEvent): number {
  if (left.sortKey !== right.sortKey) return left.sortKey - right.sortKey;
  if (left.sortOrder !== right.sortOrder) {
    return left.sortOrder - right.sortOrder;
  }
  return left.id.localeCompare(right.id);
}

function eventKindLabel(kind: TimelineEventKind): string {
  return (
    EVENT_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind
  );
}

function optionLabel(options: readonly SelectOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function splitTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[，,]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function parseOptionalNumber(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function displayNames(
  ids: readonly string[],
  options: readonly ReferenceOption[],
): string {
  const names = ids.map(
    (id) => options.find((option) => option.id === id)?.name ?? "已删除对象",
  );
  return names.join("、");
}

function referenceOptionsForEntityType(
  references: TimelineReferences,
  type: TimelineEntityType,
): readonly ReferenceOption[] {
  if (type === "character") return references.characters;
  if (type === "faction") return references.factions;
  if (type === "item") return references.items;
  return references.locations;
}

function branchRows(library: TimelineLibrary): readonly {
  readonly branch: TimelineBranch;
  readonly depth: number;
}[] {
  const rows: { branch: TimelineBranch; depth: number }[] = [];
  const childrenByParent = new Map<string | null, TimelineBranch[]>();
  library.branches.forEach((branch) => {
    const children = childrenByParent.get(branch.parentBranchId) ?? [];
    children.push(branch);
    childrenByParent.set(branch.parentBranchId, children);
  });
  childrenByParent.forEach((branches) =>
    branches.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
  );
  const append = (parentId: string | null, depth: number) => {
    (childrenByParent.get(parentId) ?? []).forEach((branch) => {
      rows.push({ branch, depth });
      append(branch.id, depth + 1);
    });
  };
  append(null, 0);
  return rows;
}

function periodRows(library: TimelineLibrary): readonly {
  readonly period: TimelinePeriod;
  readonly depth: number;
}[] {
  const rows: { period: TimelinePeriod; depth: number }[] = [];
  const childrenByParent = new Map<string | null, TimelinePeriod[]>();
  library.periods.forEach((period) => {
    const children = childrenByParent.get(period.parentPeriodId) ?? [];
    children.push(period);
    childrenByParent.set(period.parentPeriodId, children);
  });
  childrenByParent.forEach((periods) =>
    periods.sort((left, right) => {
      const leftStart = left.startSortKey ?? Number.NEGATIVE_INFINITY;
      const rightStart = right.startSortKey ?? Number.NEGATIVE_INFINITY;
      if (leftStart !== rightStart) return leftStart - rightStart;
      return left.createdAt.localeCompare(right.createdAt);
    }),
  );
  const append = (parentId: string | null, depth: number) => {
    (childrenByParent.get(parentId) ?? []).forEach((period) => {
      rows.push({ period, depth });
      append(period.id, depth + 1);
    });
  };
  append(null, 0);
  return rows;
}

function formatTimeRange(start: number | null, end: number | null): string {
  if (start === null && end === null) return "时间未定";
  if (start !== null && end === null) return `${start} 起`;
  if (start === null && end !== null) return `至 ${end}`;
  return start === end ? String(start) : `${start} - ${end}`;
}

function formatAxisValue(value: number): string {
  if (Math.abs(value) >= 100_000_000) {
    return `${Number((value / 100_000_000).toFixed(3))} 亿`;
  }
  return String(value);
}

function displayEventTime(
  event: TimelineEvent,
  view: TimelineView | null,
  library: TimelineLibrary | null,
): { readonly label: string; readonly meta: string } {
  if (view?.kind === "narrative") {
    return {
      label:
        event.narrativeOrder === null
          ? "未排叙事顺序"
          : `叙事 #${event.narrativeOrder + 1}`,
      meta: event.timeLabel,
    };
  }
  if (view?.calendarId === "story" && library) {
    const start = library.storyStartEventId
      ? library.events.find((item) => item.id === library.storyStartEventId)
      : null;
    if (!start) return { label: "未设故事起点", meta: event.timeLabel };
    const offset = event.sortKey - start.sortKey;
    return {
      label:
        offset === 0 ? "故事起点" : `故事 ${offset > 0 ? "+" : ""}${offset}`,
      meta: event.timeLabel,
    };
  }
  const expression = view
    ? event.timeExpressions.find((item) => item.calendarId === view.calendarId)
    : undefined;
  return {
    label: expression?.label ?? event.timeLabel,
    meta: `#${event.sortKey}`,
  };
}

function descendantsOf(
  library: TimelineLibrary,
  branchId: string,
): ReadonlySet<string> {
  const result = new Set<string>([branchId]);
  const append = (parentId: string) => {
    library.branches
      .filter((branch) => branch.parentBranchId === parentId)
      .forEach((branch) => {
        result.add(branch.id);
        append(branch.id);
      });
  };
  append(branchId);
  return result;
}

function eventForBranch(
  library: TimelineLibrary,
  branchId: string,
): readonly TimelineEvent[] {
  return library.events
    .filter((event) => event.branchId === branchId)
    .sort(compareEvents);
}

async function loadReferences(
  storage: WorkbenchStorage,
): Promise<TimelineReferences> {
  const [characters, factions, items, locations, chapterFile] =
    await Promise.all([
      createNovelCharacterLibraryRepository(storage)
        .load()
        .catch(() => null),
      createNovelFactionLibraryRepository(storage)
        .load()
        .catch(() => null),
      createNovelItemLibraryRepository(storage)
        .load()
        .catch(() => null),
      createNovelLocationLibraryRepository(storage)
        .load()
        .catch(() => null),
      storage.readText("manuscript/index.json").catch(() => null),
    ]);
  const chapters = chapterFile
    ? parseNovelChapterIndex(chapterFile.content).chapters.map((chapter) => ({
        id: chapter.id,
        name: chapter.title,
        meta: `第 ${chapter.displayNumber} 章`,
      }))
    : [];
  return {
    characters:
      characters?.index.characters.map((character) => ({
        id: character.id,
        name: character.name,
      })) ?? [],
    factions:
      factions?.library.factions.map((faction) => ({
        id: faction.id,
        name: faction.name,
        meta: faction.type,
      })) ?? [],
    items:
      items?.index.items.map((item) => ({
        id: item.id,
        name: item.name,
        meta: item.summary,
      })) ?? [],
    locations:
      locations?.index.locations.map((location) => ({
        id: location.id,
        name: location.name,
        meta: location.type,
      })) ?? [],
    chapters,
  };
}

export default function TimelineLibrary({
  storage,
  projectTitle,
  isActive,
  onOpenAiAgent,
  focus,
}: TimelineLibraryProps) {
  const repository = useMemo(
    () => createNovelTimelineLibraryRepository(storage),
    [storage],
  );
  const [loaded, setLoaded] = useState<LoadedTimelineLibrary | null>(null);
  const [references, setReferences] = useState<TimelineReferences>({
    characters: [],
    factions: [],
    items: [],
    locations: [],
    chapters: [],
  });
  const [selectedBranchId, setSelectedBranchId] = useState(
    MAIN_TIMELINE_BRANCH_ID,
  );

  // 外部实体定位：焦点事件存在时切到其分支（T3）
  useEffect(() => {
    if (!focus || focus.kind !== "event") return;
    const target = loaded?.library.events.find((event) => event.id === focus.id);
    if (target) setSelectedBranchId(target.branchId);
  }, [focus, loaded?.library.events]);
  const [selectedViewId, setSelectedViewId] = useState("universe-history");
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [sidebarMode, setSidebarMode] =
    useState<TimelineSidebarMode>("periods");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [eventDraft, setEventDraft] = useState<TimelineEvent | null>(null);
  const [branchDialog, setBranchDialog] = useState<BranchDialogState | null>(
    null,
  );
  const [periodDialog, setPeriodDialog] = useState<PeriodDialogState | null>(
    null,
  );
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isAiDialogOpen, setIsAiDialogOpen] = useState(false);
  const [proposalReviewOpen, setProposalReviewOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setSelection = useCallback(
    (library: TimelineLibrary, branchId: string, preferredEventId = "") => {
      const projected = getTimelineBranchEvents(library, branchId);
      const selected =
        projected.find((item) => item.event.id === preferredEventId) ??
        projected.find((item) => !item.inherited) ??
        projected[0];
      setSelectedBranchId(branchId);
      setSelectedEventId(selected?.event.id ?? "");
      setEventDraft(
        selected && !selected.inherited
          ? structuredClone(selected.event)
          : null,
      );
    },
    [],
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [timeline, nextReferences] = await Promise.all([
        repository.load(),
        loadReferences(storage),
      ]);
      setLoaded(timeline);
      setReferences(nextReferences);
      setSelection(timeline.library, MAIN_TIMELINE_BRANCH_ID);
      setSelectedViewId(timeline.library.views[0]?.id ?? "");
      setSelectedPeriodId(timeline.library.periods[0]?.id ?? "");
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [repository, setSelection, storage]);

  useEffect(() => {
    if (isActive) void load();
  }, [isActive, load]);

  const selectedBranch =
    loaded?.library.branches.find((branch) => branch.id === selectedBranchId) ??
    null;
  const selectedPeriod =
    loaded?.library.periods.find((period) => period.id === selectedPeriodId) ??
    null;
  const selectedView =
    loaded?.library.views.find((view) => view.id === selectedViewId) ?? null;
  const storyStartEvent = loaded?.library.storyStartEventId
    ? loaded.library.events.find(
        (event) => event.id === loaded.library.storyStartEventId,
      )
    : null;
  const axisOffset =
    selectedView?.calendarId === "story" ? (storyStartEvent?.sortKey ?? 0) : 0;
  const branchProjectedEvents = useMemo(
    () =>
      loaded
        ? getTimelineBranchEvents(loaded.library, selectedBranchId)
        : ([] as readonly TimelineProjectedEvent[]),
    [loaded, selectedBranchId],
  );
  const projectedEvents = useMemo(() => {
    if (!loaded || !selectedView) return branchProjectedEvents;
    const rootPeriod = selectedView.rootPeriodId
      ? loaded.library.periods.find(
          (period) => period.id === selectedView.rootPeriodId,
        )
      : null;
    const periodIds = selectedView.rootPeriodId
      ? getTimelinePeriodDescendantIds(
          loaded.library,
          selectedView.rootPeriodId,
        )
      : null;
    const filtered = branchProjectedEvents.filter(({ event }) => {
      if (selectedView.scope !== "all" && event.scope !== selectedView.scope) {
        return false;
      }
      if (!periodIds || rootPeriod?.parentPeriodId === null) return true;
      return event.periodId !== null && periodIds.has(event.periodId);
    });
    if (selectedView.kind !== "narrative") return filtered;
    return [...filtered].sort((left, right) => {
      const leftOrder = left.event.narrativeOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.event.narrativeOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return compareEvents(left.event, right.event);
    });
  }, [branchProjectedEvents, loaded, selectedView]);
  const selectedProjectedEvent =
    projectedEvents.find((item) => item.event.id === selectedEventId) ?? null;
  const directBranchEvents = loaded
    ? eventForBranch(loaded.library, selectedBranchId)
    : [];
  const canCreateBranch = directBranchEvents.length > 0;

  useEffect(() => {
    if (!loaded) return;
    const current = projectedEvents.find(
      (item) => item.event.id === selectedEventId,
    );
    if (current) return;
    const next =
      projectedEvents.find((item) => !item.inherited) ?? projectedEvents[0];
    setSelectedEventId(next?.event.id ?? "");
    setEventDraft(next && !next.inherited ? structuredClone(next.event) : null);
  }, [loaded, projectedEvents, selectedEventId]);

  const persist = async (
    library: TimelineLibrary,
    branchId: string,
    eventId = "",
  ) => {
    if (!loaded) return;
    setIsSaving(true);
    try {
      const next = await repository.save(loaded, library);
      setLoaded(next);
      setSelection(next.library, branchId, eventId);
      setError(null);
      return next;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const selectBranch = (branchId: string) => {
    if (!loaded) return;
    setSelection(loaded.library, branchId);
    setError(null);
  };

  const selectEvent = (projected: TimelineProjectedEvent) => {
    setSelectedEventId(projected.event.id);
    setEventDraft(
      projected.inherited ? null : structuredClone(projected.event),
    );
    setError(null);
  };

  const createEvent = async () => {
    if (!loaded || !selectedBranch) return;
    const now = new Date().toISOString();
    const largestSortKey = loaded.library.events.reduce(
      (largest, event) => Math.max(largest, event.sortKey),
      0,
    );
    const event: TimelineEvent = {
      id: createId("timeline-event"),
      branchId: selectedBranch.id,
      timeLabel: "待定时间",
      sortKey: largestSortKey + 1,
      sortOrder: 0,
      endSortKey: null,
      timePrecision: "exact",
      timeExpressions: [],
      periodId:
        selectedPeriodId && selectedPeriodId !== loaded.library.periods[0]?.id
          ? selectedPeriodId
          : null,
      scope:
        selectedView?.scope && selectedView.scope !== "all"
          ? selectedView.scope
          : "story",
      knowledgeScope: "public",
      narrativeOrder:
        selectedView?.kind === "narrative"
          ? loaded.library.events.reduce(
              (highest, item) => Math.max(highest, item.narrativeOrder ?? -1),
              -1,
            ) + 1
          : null,
      title: "未命名事件",
      kind: "event",
      summary: "",
      description: "",
      characterIds: [],
      locationIds: [],
      chapterIds: [],
      factionIds: [],
      itemIds: [],
      causeEventIds: [],
      stateChanges: [],
      foreshadowings: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    await persist(
      { ...loaded.library, events: [...loaded.library.events, event] },
      selectedBranch.id,
      event.id,
    );
  };

  const saveEvent = async () => {
    if (!loaded || !eventDraft || !selectedBranch) return;
    if (!eventDraft.title.trim() || !eventDraft.timeLabel.trim()) {
      setError("事件名称和故事时间不能为空");
      return;
    }
    const event: TimelineEvent = {
      ...eventDraft,
      title: eventDraft.title.trim(),
      timeLabel: eventDraft.timeLabel.trim(),
      summary: eventDraft.summary.trim(),
      description: eventDraft.description.trim(),
      tags: eventDraft.tags.map((tag) => tag.trim()).filter(Boolean),
      updatedAt: new Date().toISOString(),
    };
    await persist(
      {
        ...loaded.library,
        events: loaded.library.events.map((item) =>
          item.id === event.id ? event : item,
        ),
      },
      selectedBranch.id,
      event.id,
    );
  };

  const removeEvent = async () => {
    if (!loaded || !eventDraft || !selectedBranch) return;
    if (
      loaded.library.branches.some(
        (branch) => branch.forkEventId === eventDraft.id,
      )
    ) {
      setError("该事件是分支的分歧点，需先移除或调整对应子分支");
      return;
    }
    await persist(
      {
        ...loaded.library,
        storyStartEventId:
          loaded.library.storyStartEventId === eventDraft.id
            ? null
            : loaded.library.storyStartEventId,
        events: loaded.library.events.filter(
          (item) => item.id !== eventDraft.id,
        ),
      },
      selectedBranch.id,
    );
  };

  const openCreateBranchDialog = () => {
    if (!selectedBranch || !directBranchEvents.length) return;
    const selectedDirectEvent = directBranchEvents.find(
      (event) => event.id === selectedEventId,
    );
    setBranchDialog({
      mode: "create",
      branchId: null,
      name: "新分支",
      parentBranchId: selectedBranch.id,
      forkEventId:
        selectedDirectEvent?.id ?? directBranchEvents.at(-1)?.id ?? null,
      description: "",
    });
  };

  const openEditBranchDialog = () => {
    if (!selectedBranch) return;
    setBranchDialog({
      mode: "edit",
      branchId: selectedBranch.id,
      name: selectedBranch.name,
      parentBranchId: selectedBranch.parentBranchId,
      forkEventId: selectedBranch.forkEventId,
      description: selectedBranch.description,
    });
  };

  const saveBranch = async (draft: BranchDialogState) => {
    if (!loaded) return;
    if (!draft.name.trim()) {
      setError("分支名称不能为空");
      return;
    }
    const now = new Date().toISOString();
    const isMain = draft.branchId === MAIN_TIMELINE_BRANCH_ID;
    if (!isMain && (!draft.parentBranchId || !draft.forkEventId)) {
      setError("子分支必须选择上级分支和分歧事件");
      return;
    }
    const existing = draft.branchId
      ? loaded.library.branches.find((branch) => branch.id === draft.branchId)
      : null;
    const branch: TimelineBranch = {
      id: existing?.id ?? createId("timeline-branch"),
      name: draft.name.trim(),
      parentBranchId: isMain ? null : draft.parentBranchId,
      forkEventId: isMain ? null : draft.forkEventId,
      description: draft.description.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const branches = existing
      ? loaded.library.branches.map((item) =>
          item.id === branch.id ? branch : item,
        )
      : [...loaded.library.branches, branch];
    const next = await persist({ ...loaded.library, branches }, branch.id);
    if (next) setBranchDialog(null);
  };

  const removeBranch = async () => {
    if (
      !loaded ||
      !selectedBranch ||
      selectedBranch.id === MAIN_TIMELINE_BRANCH_ID
    ) {
      return;
    }
    if (
      loaded.library.events.some(
        (event) => event.branchId === selectedBranch.id,
      )
    ) {
      setError("分支内仍有事件，删除前请先移走或删除这些事件");
      return;
    }
    if (
      loaded.library.branches.some(
        (branch) => branch.parentBranchId === selectedBranch.id,
      )
    ) {
      setError("分支仍包含子分支，删除前请先处理子分支");
      return;
    }
    await persist(
      {
        ...loaded.library,
        branches: loaded.library.branches.filter(
          (branch) => branch.id !== selectedBranch.id,
        ),
      },
      selectedBranch.parentBranchId ?? MAIN_TIMELINE_BRANCH_ID,
    );
  };

  const openCreatePeriodDialog = () => {
    if (!loaded) return;
    const parent =
      selectedPeriod ??
      loaded.library.periods.find((period) => period.parentPeriodId === null) ??
      null;
    setPeriodDialog({
      mode: "create",
      periodId: null,
      name: "新纪元",
      parentPeriodId: parent?.id ?? null,
      kind: "epoch",
      scope: parent?.scope ?? "universe",
      startSortKey: "",
      endSortKey: "",
      precision: "range",
      description: "",
    });
  };

  const openEditPeriodDialog = () => {
    if (!selectedPeriod) return;
    setPeriodDialog({
      mode: "edit",
      periodId: selectedPeriod.id,
      name: selectedPeriod.name,
      parentPeriodId: selectedPeriod.parentPeriodId,
      kind: selectedPeriod.kind,
      scope: selectedPeriod.scope,
      startSortKey:
        selectedPeriod.startSortKey === null
          ? ""
          : String(selectedPeriod.startSortKey),
      endSortKey:
        selectedPeriod.endSortKey === null
          ? ""
          : String(selectedPeriod.endSortKey),
      precision: selectedPeriod.precision,
      description: selectedPeriod.description,
    });
  };

  const savePeriod = async (draft: PeriodDialogState) => {
    if (!loaded) return;
    if (!draft.name.trim()) {
      setError("纪元名称不能为空");
      return;
    }
    const startSortKey = parseOptionalNumber(draft.startSortKey);
    const endSortKey = parseOptionalNumber(draft.endSortKey);
    if (
      startSortKey !== null &&
      endSortKey !== null &&
      endSortKey < startSortKey
    ) {
      setError("纪元结束时间不能早于开始时间");
      return;
    }
    const now = new Date().toISOString();
    const existing = draft.periodId
      ? loaded.library.periods.find((period) => period.id === draft.periodId)
      : null;
    const isRoot = existing?.parentPeriodId === null;
    if (!isRoot && !draft.parentPeriodId) {
      setError("子级纪元必须选择上级纪元");
      return;
    }
    if (
      existing &&
      draft.parentPeriodId &&
      getTimelinePeriodDescendantIds(loaded.library, existing.id).has(
        draft.parentPeriodId,
      )
    ) {
      setError("纪元不能移动到自身或其子级纪元下");
      return;
    }
    const period: TimelinePeriod = {
      id: existing?.id ?? createId("timeline-period"),
      name: draft.name.trim(),
      parentPeriodId: isRoot ? null : draft.parentPeriodId,
      kind: draft.kind,
      scope: draft.scope,
      startSortKey,
      endSortKey,
      precision: draft.precision,
      description: draft.description.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const periods = existing
      ? loaded.library.periods.map((item) =>
          item.id === period.id ? period : item,
        )
      : [...loaded.library.periods, period];
    const next = await persist(
      { ...loaded.library, periods },
      selectedBranchId,
      selectedEventId,
    );
    if (next) {
      setSelectedPeriodId(period.id);
      setPeriodDialog(null);
    }
  };

  const removePeriod = async () => {
    if (!loaded || !selectedPeriod || selectedPeriod.parentPeriodId === null) {
      return;
    }
    if (
      loaded.library.periods.some(
        (period) => period.parentPeriodId === selectedPeriod.id,
      )
    ) {
      setError("纪元仍包含子级，删除前请先处理子级纪元");
      return;
    }
    if (
      loaded.library.events.some(
        (event) => event.periodId === selectedPeriod.id,
      )
    ) {
      setError("纪元仍关联事件，删除前请先调整这些事件的所属纪元");
      return;
    }
    const parentId = selectedPeriod.parentPeriodId;
    const next = await persist(
      {
        ...loaded.library,
        periods: loaded.library.periods.filter(
          (period) => period.id !== selectedPeriod.id,
        ),
      },
      selectedBranchId,
      selectedEventId,
    );
    if (next) {
      setSelectedPeriodId(parentId);
      setPeriodDialog(null);
    }
  };

  const updateEvent = (patch: Partial<TimelineEvent>) => {
    setEventDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const setStoryStart = async () => {
    if (!loaded || !eventDraft) return;
    if (!eventDraft.title.trim() || !eventDraft.timeLabel.trim()) {
      setError("事件名称和故事时间不能为空");
      return;
    }
    const event: TimelineEvent = {
      ...eventDraft,
      title: eventDraft.title.trim(),
      timeLabel: eventDraft.timeLabel.trim(),
      summary: eventDraft.summary.trim(),
      description: eventDraft.description.trim(),
      tags: eventDraft.tags.map((tag) => tag.trim()).filter(Boolean),
      updatedAt: new Date().toISOString(),
    };
    await persist(
      {
        ...loaded.library,
        storyStartEventId: event.id,
        events: loaded.library.events.map((item) =>
          item.id === event.id ? event : item,
        ),
      },
      selectedBranchId,
      event.id,
    );
  };

  const setFactsThrough = async () => {
    if (!loaded || !eventDraft) return;
    if (eventDraft.branchId !== MAIN_TIMELINE_BRANCH_ID) {
      setError("事实截止只能设置在主时间线事件上");
      return;
    }
    if (!eventDraft.title.trim() || !eventDraft.timeLabel.trim()) {
      setError("事件名称和故事时间不能为空");
      return;
    }
    const event: TimelineEvent = {
      ...eventDraft,
      title: eventDraft.title.trim(),
      timeLabel: eventDraft.timeLabel.trim(),
      summary: eventDraft.summary.trim(),
      description: eventDraft.description.trim(),
      tags: eventDraft.tags.map((tag) => tag.trim()).filter(Boolean),
      updatedAt: new Date().toISOString(),
    };
    await persist(
      {
        ...loaded.library,
        factsThroughEventId: event.id,
        events: loaded.library.events.map((item) =>
          item.id === event.id ? event : item,
        ),
      },
      selectedBranchId,
      event.id,
    );
  };

  const selectedLabel = selectedProjectedEvent
    ? `事件：${selectedProjectedEvent.event.title}`
    : selectedPeriod
      ? `纪元：${selectedPeriod.name}`
      : selectedBranch
        ? `分支：${selectedBranch.name}`
        : "全局时间线";
  const foreshadowingCount =
    loaded?.library.events.reduce(
      (total, event) => total + event.foreshadowings.length,
      0,
    ) ?? 0;
  const submitAiTask = async (
    task: TimelineAiTaskId,
    userInstruction: string,
  ) => {
    if (!loaded || !onOpenAiAgent) return;
    const request = buildTimelineAiAgentRequest({
      task,
      projectTitle,
      library: loaded.library,
      selection: {
        branchId: selectedBranchId,
        viewId: selectedViewId,
        periodId: selectedPeriodId,
        eventId: selectedEventId,
        eventDraft,
      },
      userInstruction,
    });
    setIsAiDialogOpen(false);
    try {
      await onOpenAiAgent(request);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <div className="timeline-library flex h-full min-h-0 flex-col overflow-hidden bg-[var(--paper)]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-2 max-md:flex-wrap">
        <div className="flex min-w-0 items-center gap-3">
          <Milestone className="h-5 w-5 shrink-0 text-[var(--accent-warm)]" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1">
              <h1 className="truncate text-sm font-semibold">时间线</h1>
              <button
                type="button"
                onClick={() => setIsHelpOpen(true)}
                aria-label="查看时间线使用说明"
                title="时间线使用说明"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              >
                <CircleHelp className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              {projectTitle} · {loaded?.library.events.length ?? 0} 个事件 ·{" "}
              {isLoading ? "读取中" : isSaving ? "保存中" : "已保存"}
            </p>
          </div>
        </div>
      </header>
      <div className="timeline-library-content relative flex min-h-0 flex-1">
        <aside className="timeline-branches flex w-60 shrink-0 flex-col border-r border-[var(--line-strong)] bg-[var(--paper-elevated)] max-lg:w-52 max-md:hidden">
          <div className="flex h-12 items-center justify-between border-b border-[var(--line-subtle)] px-3">
            <div
              className="flex items-center rounded-md bg-[var(--paper-inset)] p-0.5"
              role="tablist"
            >
              <button
                type="button"
                role="tab"
                aria-selected={sidebarMode === "periods"}
                onClick={() => setSidebarMode("periods")}
                className={`flex h-7 items-center gap-1 rounded px-2 text-xs font-medium transition-colors ${sidebarMode === "periods" ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs" : "text-[var(--ink-muted)]"}`}
              >
                <ListTree className="h-3.5 w-3.5" />
                纪元
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebarMode === "branches"}
                onClick={() => setSidebarMode("branches")}
                className={`flex h-7 items-center gap-1 rounded px-2 text-xs font-medium transition-colors ${sidebarMode === "branches" ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs" : "text-[var(--ink-muted)]"}`}
              >
                <GitFork className="h-3.5 w-3.5" />
                分支
              </button>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={
                  sidebarMode === "periods"
                    ? openEditPeriodDialog
                    : openEditBranchDialog
                }
                disabled={
                  isSaving ||
                  (sidebarMode === "periods"
                    ? !selectedPeriod
                    : !selectedBranch)
                }
                title={
                  sidebarMode === "periods" ? "编辑当前纪元" : "编辑当前分支"
                }
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={
                  sidebarMode === "periods"
                    ? openCreatePeriodDialog
                    : openCreateBranchDialog
                }
                disabled={
                  isSaving || (sidebarMode === "branches" && !canCreateBranch)
                }
                title={
                  sidebarMode === "periods"
                    ? "新建子级纪元"
                    : canCreateBranch
                      ? "从当前分支的事件创建分支"
                      : "先在当前分支创建事件"
                }
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35"
              >
                {sidebarMode === "periods" ? (
                  <Plus className="h-4 w-4" />
                ) : (
                  <GitBranchPlus className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loaded &&
              sidebarMode === "periods" &&
              periodRows(loaded.library).map(({ period, depth }) => (
                <button
                  key={period.id}
                  type="button"
                  onClick={() => setSelectedPeriodId(period.id)}
                  className={`timeline-branch-row mb-1 w-full rounded-md py-2 text-left text-sm transition-colors ${period.id === selectedPeriodId ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                  style={{
                    paddingLeft: `${12 + depth * 16}px`,
                    paddingRight: "10px",
                  }}
                >
                  <span className="flex items-center gap-2">
                    <Clock3 className="h-3.5 w-3.5 shrink-0 text-[var(--accent-cool)]" />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {period.name}
                    </span>
                  </span>
                  <span className="mt-1 block truncate pl-6 text-xs text-[var(--ink-subtle)]">
                    {formatTimeRange(period.startSortKey, period.endSortKey)}
                  </span>
                </button>
              ))}
            {loaded &&
              sidebarMode === "branches" &&
              branchRows(loaded.library).map(({ branch, depth }) => (
                <button
                  key={branch.id}
                  type="button"
                  onClick={() => selectBranch(branch.id)}
                  className={`timeline-branch-row mb-1 flex w-full items-center gap-2 rounded-md py-2 text-left text-sm transition-colors ${branch.id === selectedBranchId ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                  style={{
                    paddingLeft: `${12 + depth * 16}px`,
                    paddingRight: "10px",
                  }}
                >
                  {branch.parentBranchId ? (
                    <GitFork className="h-3.5 w-3.5 shrink-0 text-[var(--accent-cool)]" />
                  ) : (
                    <Clock3 className="h-3.5 w-3.5 shrink-0 text-[var(--accent-warm)]" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {branch.name}
                  </span>
                </button>
              ))}
          </div>
          <div className="border-t border-[var(--line-subtle)] px-3 py-3 text-xs text-[var(--ink-subtle)]">
            {sidebarMode === "periods"
              ? "纪元可以不限层级地继续细分"
              : "分支继承分歧点之前的历史"}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-h-12 items-center justify-between gap-4 border-b border-[var(--line-strong)] px-5 py-2 max-sm:px-4">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <h2 className="truncate text-base font-semibold text-[var(--ink)]">
                  {selectedView?.name ?? "时间线"}
                </h2>
                {selectedBranch && (
                  <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                    {selectedBranch.parentBranchId
                      ? "分支视图"
                      : selectedBranch.name}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div className="w-28 max-sm:hidden">
                <CustomSelect
                  value={selectedViewId}
                  options={
                    loaded?.library.views.map((view) => ({
                      value: view.id,
                      label: view.name,
                    })) ?? []
                  }
                  onChange={setSelectedViewId}
                  ariaLabel="时间线视图"
                  size="toolbar"
                />
              </div>
              <button
                type="button"
                onClick={openEditBranchDialog}
                disabled={!selectedBranch || isSaving}
                title="编辑当前分支"
                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-35"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setIsAiDialogOpen(true)}
                disabled={!onOpenAiAgent || !loaded}
                title={
                  !onOpenAiAgent
                    ? "当前环境暂不支持 AI 共创"
                    : loaded
                      ? "使用 AI 校验和推演当前时间线"
                      : "正在读取时间线"
                }
                className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] px-2.5 text-sm font-medium text-[var(--ink)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Sparkles className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                <span className="max-lg:hidden">AI 推演</span>
              </button>
              <button
                type="button"
                onClick={() => setProposalReviewOpen(true)}
                disabled={!loaded}
                title="审阅 AI 提交的时间线提案"
                className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-40"
              >
                <GitCompareArrows className="h-3.5 w-3.5" />
                <span className="max-lg:hidden">审阅提案</span>
              </button>
              <button
                type="button"
                onClick={() => void createEvent()}
                disabled={!selectedBranch || isSaving}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-white hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isSaving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                <span className="max-sm:hidden">新建事件</span>
              </button>
            </div>
          </header>

          {error && (
            <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] bg-[var(--error-bg)] px-5 py-2 text-sm text-[var(--error)]">
              <CircleAlert className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在读取时间线
            </div>
          ) : (
            <div className="timeline-workspace min-h-0 flex-1 overflow-y-auto">
              <section className="border-b border-[var(--line-subtle)] px-5 py-4 max-sm:px-4">
                <TimelineRail
                  events={projectedEvents}
                  selectedEventId={selectedEventId}
                  axisOffset={axisOffset}
                  onSelect={selectEvent}
                />
              </section>
              <section className="timeline-event-list px-5 py-3 max-sm:px-4">
                {projectedEvents.map((projected) => (
                  <EventListRow
                    key={projected.event.id}
                    projected={projected}
                    selected={projected.event.id === selectedEventId}
                    references={references}
                    time={displayEventTime(
                      projected.event,
                      selectedView,
                      loaded?.library ?? null,
                    )}
                    onSelect={() => selectEvent(projected)}
                  />
                ))}
                {!projectedEvents.length && (
                  <div className="flex min-h-40 flex-col items-center justify-center text-center text-[var(--ink-muted)]">
                    <Clock3 className="h-6 w-6" />
                    <p className="mt-3 text-sm">从一件重大事件开始记录故事</p>
                  </div>
                )}
              </section>
            </div>
          )}
        </main>

        <aside className="timeline-inspector flex w-[min(392px,34vw)] shrink-0 flex-col border-l border-[var(--line-strong)] bg-[var(--paper-elevated)] max-xl:w-[min(344px,38vw)]">
          <EventInspector
            draft={eventDraft}
            projected={selectedProjectedEvent}
            references={references}
            eventOptions={projectedEvents.map(({ event }) => event)}
            allEvents={loaded?.library.events ?? []}
            calendars={loaded?.library.calendars ?? []}
            periods={loaded?.library.periods ?? []}
            storyStartEventId={loaded?.library.storyStartEventId ?? null}
            factsThroughEventId={loaded?.library.factsThroughEventId ?? null}
            isSaving={isSaving}
            onUpdate={updateEvent}
            onSave={() => void saveEvent()}
            onRemove={() => void removeEvent()}
            onSetStoryStart={() => void setStoryStart()}
            onSetFactsThrough={() => void setFactsThrough()}
          />
          {selectedBranch && selectedBranch.id !== MAIN_TIMELINE_BRANCH_ID && (
            <div className="border-t border-[var(--line-subtle)] px-4 py-3">
              <button
                type="button"
                onClick={() => void removeBranch()}
                disabled={isSaving}
                className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:opacity-35"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除当前分支
              </button>
            </div>
          )}
        </aside>

        {branchDialog && loaded && (
          <BranchDialog
            library={loaded.library}
            draft={branchDialog}
            isSaving={isSaving}
            onChange={setBranchDialog}
            onClose={() => setBranchDialog(null)}
            onSubmit={() => void saveBranch(branchDialog)}
          />
        )}
        {periodDialog && loaded && (
          <PeriodDialog
            library={loaded.library}
            draft={periodDialog}
            isSaving={isSaving}
            onChange={setPeriodDialog}
            onClose={() => setPeriodDialog(null)}
            onSubmit={() => void savePeriod(periodDialog)}
            onRemove={() => void removePeriod()}
          />
        )}
      </div>
      {isHelpOpen && (
        <TimelineHelpDialog onClose={() => setIsHelpOpen(false)} />
      )}
      {isAiDialogOpen && loaded && onOpenAiAgent && (
        <TimelineAiDialog
          projectTitle={projectTitle}
          selectedLabel={selectedLabel}
          counts={{
            events: loaded.library.events.length,
            periods: loaded.library.periods.length,
            branches: loaded.library.branches.length,
            foreshadowings: foreshadowingCount,
          }}
          onClose={() => setIsAiDialogOpen(false)}
          onSubmit={submitAiTask}
        />
      )}
      {proposalReviewOpen && loaded && (
        <TimelineProposalReview
          storage={storage}
          projectTitle={projectTitle}
          onApplied={load}
          onClose={() => setProposalReviewOpen(false)}
        />
      )}
    </div>
  );
}

function TimelineHelpDialog({ onClose }: { readonly onClose: () => void }) {
  return (
    <DraggableDialogFrame
      ariaLabel="时间线使用说明"
      className="w-[min(640px,calc(100vw-24px))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center justify-between px-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
            <CircleHelp className="h-4 w-4 text-[var(--accent-cool)]" />
            时间线使用说明
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭时间线使用说明"
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="max-h-[min(640px,calc(100vh-9rem))] overflow-y-auto p-5">
        <p className="text-sm leading-6 text-[var(--ink-muted)]">
          时间线只有一份世界事实。宇宙史、地方史和故事进程只是查看同一批事件的不同方式。
        </p>
        <div className="mt-5 space-y-4">
          <section className="border-b border-[var(--line-subtle)] pb-4">
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              1. 先组织纪元
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
              左侧“纪元”树从宇宙史根节点开始，可继续建立大时代、纪元、子纪元与阶段。纪元记录自身的时间范围，子级范围不能超出上级。
            </p>
          </section>
          <section className="border-b border-[var(--line-subtle)] pb-4">
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              2. 用统一世界时间记录事件
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
              每个事件的排序键是从宇宙起源开始的统一坐标，用来稳定排列历史；故事时间是作者自由书写的展示名称。持续事件可以补充结束排序键与时间精度。
            </p>
          </section>
          <section className="border-b border-[var(--line-subtle)] pb-4">
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              3. 在视图之间切换
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
              宇宙史查看完整世界历史，地方史筛选地方事件，故事进程以指定事件为零点显示相对时间，叙事揭示则按正文中的揭露顺序排列。事件编辑页可将任一已保存事件设为故事起点。
            </p>
          </section>
          <section className="border-b border-[var(--line-subtle)] pb-4">
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              4. 并列记录多种历法
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
              在事件资料的“多历法时间表达”中，可以为宇宙纪年、本地历法或故事相对时间写入各自的说法。它们只并列展示，不会被系统自动换算。
            </p>
          </section>
          <section>
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              5. 用分支与因果处理可能性
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
              左侧切换到“分支”后，可从当前分支的事件建立平行发展。子分支继承分歧点之前的历史；事件的“直接前因”只记录最直接的原因，后果由后续事件自动推导。
            </p>
          </section>
        </div>
      </div>
      <footer className="flex justify-end border-t border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
        >
          关闭
        </button>
      </footer>
    </DraggableDialogFrame>
  );
}

function TimelineRail({
  events,
  selectedEventId,
  axisOffset,
  onSelect,
}: {
  readonly events: readonly TimelineProjectedEvent[];
  readonly selectedEventId: string;
  readonly axisOffset: number;
  readonly onSelect: (event: TimelineProjectedEvent) => void;
}) {
  if (!events.length) {
    return (
      <div className="timeline-rail-empty flex h-36 items-center justify-center text-sm text-[var(--ink-muted)]">
        时间轴会按事件的排序键自动排布
      </div>
    );
  }
  const values = events.map((item) => item.event.sortKey - axisOffset);
  const lower = Math.min(...values);
  const upper = Math.max(...values);
  const padding = lower === upper ? 1 : Math.max(1, (upper - lower) * 0.08);
  const railWidth = Math.max(800, events.length * 160);
  const railInset = 48;
  const scale = scaleLinear()
    .domain([lower - padding, upper + padding])
    .range([railInset, railWidth - railInset]);
  const ticks = scale.ticks(5);
  const laneEnds: number[] = [];
  const layout = events.map((projected, index) => {
    const x = scale(projected.event.sortKey - axisOffset);
    let lane = laneEnds.findIndex((lastX) => x - lastX >= 18);
    if (lane < 0) {
      lane = laneEnds.length < 4 ? laneEnds.length : index % 4;
    }
    laneEnds[lane] = x;
    return { projected, x, y: 94 - lane * 20 };
  });
  const selectedLayout = layout.find(
    ({ projected }) => projected.event.id === selectedEventId,
  );
  const selectedLabelAnchor = selectedLayout
    ? selectedLayout.x < railWidth * 0.2
      ? "start"
      : selectedLayout.x > railWidth * 0.8
        ? "end"
        : "middle"
    : "middle";

  return (
    <div className="timeline-rail-scroll overflow-x-auto">
      <svg
        className="timeline-rail block h-48"
        viewBox={`0 0 ${railWidth} 192`}
        style={{ width: `${railWidth}px`, minWidth: "100%" }}
        role="img"
        aria-label="当前分支的时间事件"
      >
        <line
          x1={railInset}
          y1="118"
          x2={railWidth - railInset}
          y2="118"
          className="timeline-rail-line"
        />
        {ticks.map((tick) => {
          const x = scale(tick);
          return (
            <g key={tick}>
              <line
                x1={x}
                y1="112"
                x2={x}
                y2="124"
                className="timeline-rail-tick"
              />
              <text
                x={x}
                y="146"
                textAnchor="middle"
                className="timeline-rail-tick-label"
              >
                {formatAxisValue(tick)}
              </text>
            </g>
          );
        })}
        {layout.map(({ projected, x, y }) => {
          const { event } = projected;
          const selected = event.id === selectedEventId;
          return (
            <g
              key={event.id}
              className="timeline-rail-event"
              onClick={() => onSelect(projected)}
              role="button"
              tabIndex={0}
              onKeyDown={(keyboardEvent) => {
                if (
                  keyboardEvent.key === "Enter" ||
                  keyboardEvent.key === " "
                ) {
                  keyboardEvent.preventDefault();
                  onSelect(projected);
                }
              }}
            >
              <title>{`${event.timeLabel} · ${event.title}`}</title>
              <line
                x1={x}
                y1={y + 10}
                x2={x}
                y2="114"
                className="timeline-rail-stem"
              />
              <circle
                cx={x}
                cy={y}
                r={selected ? 8 : 6}
                className={
                  selected
                    ? "timeline-rail-dot is-selected"
                    : projected.inherited
                      ? "timeline-rail-dot is-inherited"
                      : "timeline-rail-dot"
                }
              />
            </g>
          );
        })}
        {selectedLayout && (
          <text
            x={selectedLayout.x}
            y={selectedLayout.y - 16}
            textAnchor={selectedLabelAnchor}
            className="timeline-rail-selected-label"
          >
            {selectedLayout.projected.event.title.length > 24
              ? `${selectedLayout.projected.event.title.slice(0, 24)}…`
              : selectedLayout.projected.event.title}
          </text>
        )}
      </svg>
    </div>
  );
}

function EventListRow({
  projected,
  selected,
  references,
  time,
  onSelect,
}: {
  readonly projected: TimelineProjectedEvent;
  readonly selected: boolean;
  readonly references: TimelineReferences;
  readonly time: { readonly label: string; readonly meta: string };
  readonly onSelect: () => void;
}) {
  const { event } = projected;
  const associations = [
    event.characterIds.length
      ? `${displayNames(event.characterIds, references.characters)}`
      : "",
    event.locationIds.length
      ? `${displayNames(event.locationIds, references.locations)}`
      : "",
    event.factionIds.length
      ? `${displayNames(event.factionIds, references.factions)}`
      : "",
    event.itemIds.length
      ? `${displayNames(event.itemIds, references.items)}`
      : "",
  ].filter(Boolean);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`timeline-event-row block w-full text-left transition-colors ${selected ? "is-selected" : "hover:bg-[var(--hover-bg)]"}`}
    >
      <div className="timeline-event-grid">
        <div className="timeline-event-time">
          <span className="block text-xs font-medium text-[var(--accent-cool)]">
            {time.label}
          </span>
          <span className="mt-1 block text-xs text-[var(--ink-subtle)]">
            {time.meta}
          </span>
        </div>
        <div className="timeline-event-axis" aria-hidden="true">
          <div
            className={`timeline-event-marker ${projected.inherited ? "is-inherited" : ""}`}
          />
        </div>
        <div className="timeline-event-content min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {projected.inherited && (
              <span className="timeline-inherited-tag">
                继承 · {projected.sourceBranch.name}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-[var(--ink)]">
              {event.title}
            </span>
            <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
              {eventKindLabel(event.kind)}
            </span>
            <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
          </div>
          {(event.summary || associations.length > 0) && (
            <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-[var(--ink-muted)]">
              {event.summary && (
                <span className="truncate">{event.summary}</span>
              )}
              {associations.length > 0 && (
                <span className="truncate text-[var(--ink-subtle)]">
                  {associations.join(" · ")}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function EventInspector({
  draft,
  projected,
  references,
  eventOptions,
  allEvents,
  calendars,
  periods,
  storyStartEventId,
  factsThroughEventId,
  isSaving,
  onUpdate,
  onSave,
  onRemove,
  onSetStoryStart,
  onSetFactsThrough,
}: {
  readonly draft: TimelineEvent | null;
  readonly projected: TimelineProjectedEvent | null;
  readonly references: TimelineReferences;
  readonly eventOptions: readonly TimelineEvent[];
  readonly allEvents: readonly TimelineEvent[];
  readonly calendars: readonly TimelineCalendar[];
  readonly periods: readonly TimelinePeriod[];
  readonly storyStartEventId: string | null;
  readonly factsThroughEventId: string | null;
  readonly isSaving: boolean;
  readonly onUpdate: (patch: Partial<TimelineEvent>) => void;
  readonly onSave: () => void;
  readonly onRemove: () => void;
  readonly onSetStoryStart: () => void;
  readonly onSetFactsThrough: () => void;
}) {
  const selectableEventOptions = eventOptions
    .filter((event) => event.id !== draft?.id)
    .map((event) => ({
      id: event.id,
      name: event.title,
      meta: event.timeLabel,
    }));
  const periodOptions = [
    { value: "", label: "不归入纪元" },
    ...periods.map((period) => ({ value: period.id, label: period.name })),
  ];
  if (!projected) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-[var(--ink-muted)]">
        <Milestone className="h-6 w-6" />
        <p className="mt-3 text-sm">选择一件事件查看资料</p>
      </div>
    );
  }
  if (projected.inherited || !draft) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <InspectorHeader title={projected.event.title} />
        <div className="border-b border-[var(--line-subtle)] bg-[var(--accent-cool)]/8 px-4 py-3 text-xs leading-5 text-[var(--accent-cool)]">
          此事件继承自“{projected.sourceBranch.name}
          ”，在当前分支只读。请新建事件记录分歧后的发展。
        </div>
        <ReadOnlyEvent
          event={projected.event}
          references={references}
          allEvents={allEvents}
          calendars={calendars}
          periods={periods}
          storyStartEventId={storyStartEventId}
        />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <InspectorHeader
        title={draft.title || "未命名事件"}
        actions={
          <>
            <button
              type="button"
              onClick={onSave}
              disabled={isSaving}
              title="保存事件"
              className="flex h-8 items-center gap-1 rounded-md bg-[var(--accent-warm)] px-2.5 text-xs font-medium text-white disabled:opacity-45"
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
              onClick={onRemove}
              disabled={isSaving}
              title="删除事件"
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:opacity-35"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        }
      />
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="故事时间">
            <input
              value={draft.timeLabel}
              onChange={(event) => onUpdate({ timeLabel: event.target.value })}
              className={inputClass}
              placeholder="元历三年秋"
            />
          </Field>
          <Field label="排序键">
            <input
              value={draft.sortKey}
              onChange={(event) =>
                onUpdate({ sortKey: Number(event.target.value) || 0 })
              }
              className={inputClass}
              type="number"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="结束排序键">
            <input
              value={draft.endSortKey ?? ""}
              onChange={(event) =>
                onUpdate({
                  endSortKey: parseOptionalNumber(event.target.value),
                })
              }
              className={inputClass}
              type="number"
              placeholder="单点事件留空"
            />
          </Field>
          <Field label="时间精度">
            <CustomSelect
              value={draft.timePrecision}
              options={TIME_PRECISION_OPTIONS}
              onChange={(timePrecision) =>
                onUpdate({
                  timePrecision: timePrecision as TimelineTimePrecision,
                })
              }
              ariaLabel="事件时间精度"
              size="toolbar"
            />
          </Field>
        </div>
        <TimeExpressionsEditor
          expressions={draft.timeExpressions}
          calendars={calendars}
          onChange={(timeExpressions) => onUpdate({ timeExpressions })}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="所属范围">
            <CustomSelect
              value={draft.scope}
              options={TIMELINE_SCOPE_OPTIONS}
              onChange={(scope) => onUpdate({ scope: scope as TimelineScope })}
              ariaLabel="事件所属范围"
              size="toolbar"
            />
          </Field>
          <Field label="认知层级">
            <CustomSelect
              value={draft.knowledgeScope}
              options={KNOWLEDGE_SCOPE_OPTIONS}
              onChange={(knowledgeScope) =>
                onUpdate({
                  knowledgeScope: knowledgeScope as TimelineKnowledgeScope,
                })
              }
              ariaLabel="事件认知层级"
              size="toolbar"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="所属纪元">
            <CustomSelect
              value={draft.periodId ?? ""}
              options={periodOptions}
              onChange={(periodId) => onUpdate({ periodId: periodId || null })}
              ariaLabel="事件所属纪元"
              size="toolbar"
            />
          </Field>
          <Field label="叙事顺序">
            <input
              value={draft.narrativeOrder ?? ""}
              onChange={(event) => {
                const value = parseOptionalNumber(event.target.value);
                onUpdate({
                  narrativeOrder:
                    value !== null && Number.isInteger(value) && value >= 0
                      ? value
                      : null,
                });
              }}
              className={inputClass}
              type="number"
              min="0"
              step="1"
              placeholder="从 0 开始"
            />
          </Field>
        </div>
        <div className="rounded-md border border-[var(--line)] bg-[var(--paper-inset)]/45 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-[var(--ink-muted)]">
                故事起点
              </p>
              <p className="mt-0.5 text-xs text-[var(--ink-subtle)]">
                {storyStartEventId === draft.id
                  ? "当前事件是故事相对时间的零点"
                  : "用于故事进程视图计算相对时间"}
              </p>
            </div>
            <button
              type="button"
              onClick={onSetStoryStart}
              disabled={isSaving || storyStartEventId === draft.id}
              className="shrink-0 rounded-md px-2 py-1.5 text-xs font-medium text-[var(--accent-cool)] hover:bg-[var(--paper)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {storyStartEventId === draft.id ? "已设为起点" : "设为起点"}
            </button>
          </div>
        </div>
        <div className="rounded-md border border-[var(--line)] bg-[var(--paper-inset)]/45 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-[var(--ink-muted)]">
                世界事实截止
              </p>
            </div>
            <button
              type="button"
              onClick={onSetFactsThrough}
              disabled={
                isSaving ||
                draft.branchId !== MAIN_TIMELINE_BRANCH_ID ||
                factsThroughEventId === draft.id
              }
              className="shrink-0 rounded-md px-2 py-1.5 text-xs font-medium text-[var(--accent-cool)] hover:bg-[var(--paper)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {factsThroughEventId === draft.id ? "已设为截止" : "设为截止"}
            </button>
          </div>
        </div>
        <Field label="事件名称">
          <input
            value={draft.title}
            onChange={(event) => onUpdate({ title: event.target.value })}
            className={inputClass}
            placeholder="青石街初遇"
          />
        </Field>
        <Field label="事件类型">
          <CustomSelect
            value={draft.kind}
            options={EVENT_KIND_OPTIONS}
            onChange={(kind) => onUpdate({ kind: kind as TimelineEventKind })}
            ariaLabel="事件类型"
            size="toolbar"
          />
        </Field>
        <Field label="一句话概览">
          <textarea
            value={draft.summary}
            onChange={(event) => onUpdate({ summary: event.target.value })}
            className={`${inputClass} min-h-20 resize-y`}
            placeholder="这一事件造成的直接变化"
          />
        </Field>
        <Field label="事件经过">
          <textarea
            value={draft.description}
            onChange={(event) => onUpdate({ description: event.target.value })}
            className={`${inputClass} min-h-32 resize-y`}
            placeholder="人物动机、经过、结果与后续影响"
          />
        </Field>
        <ReferencePicker
          icon={<Users className="h-3.5 w-3.5" />}
          label="关联人物"
          values={draft.characterIds}
          options={references.characters}
          onToggle={(id) =>
            onUpdate({ characterIds: toggleId(draft.characterIds, id) })
          }
        />
        <ReferencePicker
          icon={<MapPin className="h-3.5 w-3.5" />}
          label="关联地点"
          values={draft.locationIds}
          options={references.locations}
          onToggle={(id) =>
            onUpdate({ locationIds: toggleId(draft.locationIds, id) })
          }
        />
        <ReferencePicker
          icon={<Building2 className="h-3.5 w-3.5" />}
          label="关联势力"
          values={draft.factionIds}
          options={references.factions}
          onToggle={(id) =>
            onUpdate({ factionIds: toggleId(draft.factionIds, id) })
          }
        />
        <ReferencePicker
          icon={<PackageOpen className="h-3.5 w-3.5" />}
          label="关联物品"
          values={draft.itemIds}
          options={references.items}
          onToggle={(id) => onUpdate({ itemIds: toggleId(draft.itemIds, id) })}
        />
        <ReferencePicker
          icon={<BookOpenText className="h-3.5 w-3.5" />}
          label="关联章节"
          values={draft.chapterIds}
          options={references.chapters}
          onToggle={(id) =>
            onUpdate({ chapterIds: toggleId(draft.chapterIds, id) })
          }
        />
        <ReferencePicker
          icon={<GitFork className="h-3.5 w-3.5" />}
          label="直接前因"
          values={draft.causeEventIds}
          options={selectableEventOptions}
          onToggle={(id) =>
            onUpdate({ causeEventIds: toggleId(draft.causeEventIds, id) })
          }
        />
        <DerivedConsequences event={draft} allEvents={allEvents} />
        <StateChangesEditor
          changes={draft.stateChanges}
          references={references}
          onChange={(stateChanges) => onUpdate({ stateChanges })}
        />
        <ForeshadowingEditor
          foreshadowings={draft.foreshadowings}
          chapterOptions={references.chapters}
          eventOptions={selectableEventOptions}
          defaultChapterId={draft.chapterIds[0] ?? null}
          onChange={(foreshadowings) => onUpdate({ foreshadowings })}
        />
        <Field label="标签">
          <input
            value={draft.tags.join("，")}
            onChange={(event) =>
              onUpdate({ tags: splitTerms(event.target.value) })
            }
            className={inputClass}
            placeholder="主线，伏笔，感情线"
          />
        </Field>
      </div>
    </div>
  );
}

function TimeExpressionsEditor({
  expressions,
  calendars,
  onChange,
}: {
  readonly expressions: readonly TimelineTimeExpression[];
  readonly calendars: readonly TimelineCalendar[];
  readonly onChange: (expressions: TimelineTimeExpression[]) => void;
}) {
  const availableCalendars = calendars.filter(
    (calendar) =>
      !expressions.some((expression) => expression.calendarId === calendar.id),
  );
  const updateExpression = (
    index: number,
    patch: Partial<TimelineTimeExpression>,
  ) => {
    onChange(
      expressions.map((expression, expressionIndex) =>
        expressionIndex === index ? { ...expression, ...patch } : expression,
      ),
    );
  };
  return (
    <section className="border-y border-[var(--line-subtle)] py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-[var(--ink-muted)]">
            多历法时间表达
          </h3>
          <p className="mt-1 text-xs leading-5 text-[var(--ink-subtle)]">
            各历法只记录作者确认的表达，不强制换算。
          </p>
        </div>
        <button
          type="button"
          disabled={!availableCalendars.length}
          onClick={() => {
            const calendar = availableCalendars[0];
            if (!calendar) return;
            onChange([
              ...expressions,
              {
                calendarId: calendar.id,
                label: calendar.name,
                startValue: null,
                endValue: null,
                precision: "exact",
              },
            ]);
          }}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>
      {!expressions.length && (
        <p className="mt-2 text-xs leading-5 text-[var(--ink-subtle)]">
          尚未记录本地历法或其它并行历法的时间说法。
        </p>
      )}
      <div className="mt-2 space-y-3">
        {expressions.map((expression, index) => {
          const calendarOptions = calendars
            .filter(
              (calendar) =>
                calendar.id === expression.calendarId ||
                !expressions.some(
                  (candidate, candidateIndex) =>
                    candidateIndex !== index &&
                    candidate.calendarId === calendar.id,
                ),
            )
            .map((calendar) => ({
              value: calendar.id,
              label: `${calendar.name} · ${calendar.unit}`,
            }));
          return (
            <div
              key={`${expression.calendarId}-${index}`}
              className="rounded-md border border-[var(--line)] bg-[var(--paper)] p-3"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_2rem] gap-2">
                <CustomSelect
                  value={expression.calendarId}
                  options={calendarOptions}
                  onChange={(calendarId) =>
                    updateExpression(index, { calendarId })
                  }
                  ariaLabel="历法"
                  size="toolbar"
                />
                <button
                  type="button"
                  onClick={() =>
                    onChange(
                      expressions.filter(
                        (_, expressionIndex) => expressionIndex !== index,
                      ),
                    )
                  }
                  title="移除时间表达"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <input
                value={expression.label}
                onChange={(event) =>
                  updateExpression(index, { label: event.target.value })
                }
                className={`${inputClass} mt-2`}
                placeholder="如：百帝元年"
              />
              <div className="mt-2 grid grid-cols-3 gap-2">
                <input
                  value={expression.startValue ?? ""}
                  onChange={(event) =>
                    updateExpression(index, {
                      startValue: parseOptionalNumber(event.target.value),
                    })
                  }
                  className={inputClass}
                  type="number"
                  placeholder="起始值"
                />
                <input
                  value={expression.endValue ?? ""}
                  onChange={(event) =>
                    updateExpression(index, {
                      endValue: parseOptionalNumber(event.target.value),
                    })
                  }
                  className={inputClass}
                  type="number"
                  placeholder="结束值"
                />
                <CustomSelect
                  value={expression.precision}
                  options={TIME_PRECISION_OPTIONS}
                  onChange={(precision) =>
                    updateExpression(index, {
                      precision: precision as TimelineTimePrecision,
                    })
                  }
                  ariaLabel="历法时间精度"
                  size="toolbar"
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function InspectorHeader({
  title,
  actions,
}: {
  readonly title: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-12 items-center justify-between gap-3 border-b border-[var(--line-subtle)] px-4 py-2">
      <div className="min-w-0">
        <div className="text-xs font-medium text-[var(--accent-cool)]">
          事件资料
        </div>
        <h2 className="mt-0.5 truncate text-sm font-semibold text-[var(--ink)]">
          {title}
        </h2>
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      )}
    </header>
  );
}

function ReadOnlyEvent({
  event,
  references,
  allEvents,
  calendars,
  periods,
  storyStartEventId,
}: {
  readonly event: TimelineEvent;
  readonly references: TimelineReferences;
  readonly allEvents: readonly TimelineEvent[];
  readonly calendars: readonly TimelineCalendar[];
  readonly periods: readonly TimelinePeriod[];
  readonly storyStartEventId: string | null;
}) {
  const groups = [
    {
      label: "人物",
      value: displayNames(event.characterIds, references.characters),
    },
    {
      label: "地点",
      value: displayNames(event.locationIds, references.locations),
    },
    {
      label: "势力",
      value: displayNames(event.factionIds, references.factions),
    },
    {
      label: "物品",
      value: displayNames(event.itemIds, references.items),
    },
    {
      label: "章节",
      value: displayNames(event.chapterIds, references.chapters),
    },
  ].filter((item) => item.value);
  const eventsById = new Map(
    allEvents.map((candidate) => [candidate.id, candidate]),
  );
  const causes = event.causeEventIds.map(
    (id) => eventsById.get(id)?.title ?? "已删除事件",
  );
  const consequences = allEvents
    .filter((candidate) => candidate.causeEventIds.includes(event.id))
    .map((candidate) => candidate.title);
  const period = periods.find((item) => item.id === event.periodId);
  const metadata = [
    {
      label: "统一时间",
      value:
        event.endSortKey === null
          ? `#${event.sortKey}`
          : `#${event.sortKey} - #${event.endSortKey}`,
    },
    {
      label: "时间精度",
      value: optionLabel(TIME_PRECISION_OPTIONS, event.timePrecision),
    },
    { label: "所属纪元", value: period?.name ?? "未归入纪元" },
    {
      label: "所属范围",
      value: optionLabel(TIMELINE_SCOPE_OPTIONS, event.scope),
    },
    {
      label: "认知层级",
      value: optionLabel(KNOWLEDGE_SCOPE_OPTIONS, event.knowledgeScope),
    },
    {
      label: "叙事顺序",
      value:
        event.narrativeOrder === null
          ? "未编排"
          : `第 ${event.narrativeOrder + 1} 个揭示`,
    },
  ];
  return (
    <div className="space-y-4 p-4 text-sm">
      <div className="flex items-center gap-2 text-xs text-[var(--ink-muted)]">
        <span>{event.timeLabel}</span>
        <span>{eventKindLabel(event.kind)}</span>
        {storyStartEventId === event.id && <span>故事起点</span>}
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-md border border-[var(--line)] bg-[var(--paper-inset)]/45 p-3">
        {metadata.map((item) => (
          <div key={item.label}>
            <span className="text-xs text-[var(--ink-subtle)]">
              {item.label}
            </span>
            <p className="mt-1 text-xs text-[var(--ink)]">{item.value}</p>
          </div>
        ))}
      </div>
      {event.timeExpressions.length > 0 && (
        <div>
          <span className="text-xs text-[var(--ink-subtle)]">
            多历法时间表达
          </span>
          <div className="mt-1 space-y-1.5 text-sm text-[var(--ink)]">
            {event.timeExpressions.map((expression) => {
              const calendar = calendars.find(
                (item) => item.id === expression.calendarId,
              );
              return (
                <p key={`${expression.calendarId}-${expression.label}`}>
                  {calendar?.name ?? "已删除历法"}：{expression.label}
                  {expression.startValue !== null ||
                  expression.endValue !== null
                    ? `（${formatTimeRange(expression.startValue, expression.endValue)}）`
                    : ""}
                  {` · ${optionLabel(TIME_PRECISION_OPTIONS, expression.precision)}`}
                </p>
              );
            })}
          </div>
        </div>
      )}
      {event.summary && (
        <p className="leading-6 text-[var(--ink)]">{event.summary}</p>
      )}
      {event.description && (
        <p className="whitespace-pre-wrap leading-6 text-[var(--ink-muted)]">
          {event.description}
        </p>
      )}
      {groups.map((group) => (
        <div key={group.label}>
          <span className="text-xs text-[var(--ink-subtle)]">
            {group.label}
          </span>
          <p className="mt-1 text-sm text-[var(--ink)]">{group.value}</p>
        </div>
      ))}
      {causes.length > 0 && (
        <div>
          <span className="text-xs text-[var(--ink-subtle)]">直接前因</span>
          <p className="mt-1 text-sm text-[var(--ink)]">{causes.join("、")}</p>
        </div>
      )}
      {consequences.length > 0 && (
        <div>
          <span className="text-xs text-[var(--ink-subtle)]">直接后果</span>
          <p className="mt-1 text-sm text-[var(--ink)]">
            {consequences.join("、")}
          </p>
        </div>
      )}
      {event.stateChanges.length > 0 && (
        <div>
          <span className="text-xs text-[var(--ink-subtle)]">状态变化</span>
          <div className="mt-1 space-y-1.5 text-sm text-[var(--ink)]">
            {event.stateChanges.map((change) => {
              const target = displayNames(
                [change.entityId],
                referenceOptionsForEntityType(references, change.entityType),
              );
              return (
                <p key={change.id}>
                  {target}：{change.before || "未记录"} →{" "}
                  {change.after || "未记录"}
                  {change.note ? `（${change.note}）` : ""}
                </p>
              );
            })}
          </div>
        </div>
      )}
      {event.foreshadowings.length > 0 && (
        <div>
          <span className="text-xs text-[var(--ink-subtle)]">伏笔</span>
          <div className="mt-1 space-y-1.5 text-sm text-[var(--ink)]">
            {event.foreshadowings.map((foreshadowing) => {
              const payoff = foreshadowing.payoffEventId
                ? (eventsById.get(foreshadowing.payoffEventId)?.title ??
                  "已删除事件")
                : "未回收";
              const status =
                FORESHADOWING_STATUS_OPTIONS.find(
                  (option) => option.value === foreshadowing.status,
                )?.label ?? foreshadowing.status;
              return (
                <p key={foreshadowing.id}>
                  {foreshadowing.title} · {status} · {payoff}
                </p>
              );
            })}
          </div>
        </div>
      )}
      {event.tags.length > 0 && (
        <p className="text-xs text-[var(--ink-muted)]">
          {event.tags.join(" · ")}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function ReferencePicker({
  icon,
  label,
  values,
  options,
  onToggle,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly values: readonly string[];
  readonly options: readonly ReferenceOption[];
  readonly onToggle: (id: string) => void;
}) {
  const selected = displayNames(values, options);
  return (
    <details className="timeline-reference-picker rounded-md border border-[var(--line)] bg-[var(--paper)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm text-[var(--ink)]">
        <span className="flex items-center gap-2">
          {icon}
          {label}
        </span>
        <span className="max-w-36 truncate text-xs text-[var(--ink-muted)]">
          {selected || "未关联"}
        </span>
      </summary>
      <div className="max-h-44 overflow-y-auto border-t border-[var(--line-subtle)] p-2">
        {options.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <input
              type="checkbox"
              checked={values.includes(option.id)}
              onChange={() => onToggle(option.id)}
              className="accent-[var(--accent-warm)]"
            />
            <span className="min-w-0 flex-1 truncate">{option.name}</span>
            {option.meta && (
              <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                {option.meta}
              </span>
            )}
          </label>
        ))}
        {!options.length && (
          <p className="px-2 py-2 text-xs text-[var(--ink-subtle)]">
            暂无可关联记录
          </p>
        )}
      </div>
    </details>
  );
}

function DerivedConsequences({
  event,
  allEvents,
}: {
  readonly event: TimelineEvent;
  readonly allEvents: readonly TimelineEvent[];
}) {
  const consequences = allEvents.filter((candidate) =>
    candidate.causeEventIds.includes(event.id),
  );
  return (
    <div className="rounded-md border border-[var(--line)] bg-[var(--paper-inset)]/45 px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--ink-muted)]">
        <GitFork className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
        直接后果
      </div>
      <p className="mt-1.5 text-xs leading-5 text-[var(--ink)]">
        {consequences.length
          ? consequences.map((item) => item.title).join("、")
          : "尚未有事件将此事件标记为前因"}
      </p>
    </div>
  );
}

function StateChangesEditor({
  changes,
  references,
  onChange,
}: {
  readonly changes: readonly TimelineStateChange[];
  readonly references: TimelineReferences;
  readonly onChange: (changes: TimelineStateChange[]) => void;
}) {
  const addableTypes = STATE_ENTITY_TYPE_OPTIONS.map(
    (option) => option.value as TimelineEntityType,
  ).filter(
    (type) => referenceOptionsForEntityType(references, type).length > 0,
  );
  const addChange = () => {
    const entityType = addableTypes[0];
    if (!entityType) return;
    const entity = referenceOptionsForEntityType(references, entityType)[0];
    if (!entity) return;
    onChange([
      ...changes,
      {
        id: createId("timeline-state"),
        entityType,
        entityId: entity.id,
        before: "",
        after: "",
        note: "",
      },
    ]);
  };
  const updateChange = (id: string, patch: Partial<TimelineStateChange>) => {
    onChange(
      changes.map((change) =>
        change.id === id ? { ...change, ...patch } : change,
      ),
    );
  };

  return (
    <section className="border-y border-[var(--line-subtle)] py-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-[var(--ink-muted)]">
          <Milestone className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
          状态变化
        </h3>
        <button
          type="button"
          onClick={addChange}
          disabled={!addableTypes.length}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>
      {!changes.length && (
        <p className="mt-2 text-xs leading-5 text-[var(--ink-subtle)]">
          记录人物、势力、物品或地点在此事件前后的关键变化。
        </p>
      )}
      <div className="mt-2 space-y-3">
        {changes.map((change) => {
          const entityOptions = referenceOptionsForEntityType(
            references,
            change.entityType,
          );
          const entitySelectOptions = entityOptions.map((option) => ({
            value: option.id,
            label: option.name,
          }));
          return (
            <div
              key={change.id}
              className="rounded-md border border-[var(--line)] bg-[var(--paper)] p-3"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2">
                <CustomSelect
                  value={change.entityType}
                  options={STATE_ENTITY_TYPE_OPTIONS}
                  onChange={(entityType) => {
                    const nextType = entityType as TimelineEntityType;
                    const nextEntity = referenceOptionsForEntityType(
                      references,
                      nextType,
                    )[0];
                    updateChange(change.id, {
                      entityType: nextType,
                      entityId: nextEntity?.id ?? change.entityId,
                    });
                  }}
                  ariaLabel="状态变化对象类型"
                  size="toolbar"
                />
                <CustomSelect
                  value={change.entityId}
                  options={entitySelectOptions}
                  onChange={(entityId) => updateChange(change.id, { entityId })}
                  ariaLabel="状态变化对象"
                  size="toolbar"
                />
                <button
                  type="button"
                  onClick={() =>
                    onChange(changes.filter((item) => item.id !== change.id))
                  }
                  title="移除状态变化"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  value={change.before}
                  onChange={(event) =>
                    updateChange(change.id, { before: event.target.value })
                  }
                  className={inputClass}
                  placeholder="变化前"
                />
                <input
                  value={change.after}
                  onChange={(event) =>
                    updateChange(change.id, { after: event.target.value })
                  }
                  className={inputClass}
                  placeholder="变化后"
                />
              </div>
              <input
                value={change.note}
                onChange={(event) =>
                  updateChange(change.id, { note: event.target.value })
                }
                className={`${inputClass} mt-2`}
                placeholder="变化原因或后续影响"
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ForeshadowingEditor({
  foreshadowings,
  chapterOptions,
  eventOptions,
  defaultChapterId,
  onChange,
}: {
  readonly foreshadowings: readonly TimelineForeshadowing[];
  readonly chapterOptions: readonly ReferenceOption[];
  readonly eventOptions: readonly ReferenceOption[];
  readonly defaultChapterId: string | null;
  readonly onChange: (foreshadowings: TimelineForeshadowing[]) => void;
}) {
  const chapterSelectOptions = [
    { value: "", label: "未关联章节" },
    ...chapterOptions.map((option) => ({
      value: option.id,
      label: option.name,
    })),
  ];
  const eventSelectOptions = [
    { value: "", label: "尚未回收" },
    ...eventOptions.map((option) => ({
      value: option.id,
      label: `${option.meta ?? ""} · ${option.name}`,
    })),
  ];
  const updateForeshadowing = (
    id: string,
    patch: Partial<TimelineForeshadowing>,
  ) => {
    onChange(
      foreshadowings.map((foreshadowing) =>
        foreshadowing.id === id
          ? { ...foreshadowing, ...patch }
          : foreshadowing,
      ),
    );
  };
  return (
    <section className="border-b border-[var(--line-subtle)] pb-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-[var(--ink-muted)]">
          <Clock3 className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
          伏笔与回收
        </h3>
        <button
          type="button"
          onClick={() =>
            onChange([
              ...foreshadowings,
              {
                id: createId("timeline-foreshadowing"),
                title: "未命名伏笔",
                status: "planted",
                plantedChapterId: defaultChapterId,
                payoffEventId: null,
                note: "",
              },
            ])
          }
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>
      {!foreshadowings.length && (
        <p className="mt-2 text-xs leading-5 text-[var(--ink-subtle)]">
          将伏笔绑定到埋设事件，再选择未来的回收事件。
        </p>
      )}
      <div className="mt-2 space-y-3">
        {foreshadowings.map((foreshadowing) => (
          <div
            key={foreshadowing.id}
            className="rounded-md border border-[var(--line)] bg-[var(--paper)] p-3"
          >
            <div className="flex items-center gap-2">
              <input
                value={foreshadowing.title}
                onChange={(event) =>
                  updateForeshadowing(foreshadowing.id, {
                    title: event.target.value,
                  })
                }
                className={inputClass}
                placeholder="伏笔名称"
              />
              <button
                type="button"
                onClick={() =>
                  onChange(
                    foreshadowings.filter(
                      (item) => item.id !== foreshadowing.id,
                    ),
                  )
                }
                title="移除伏笔"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <CustomSelect
                value={foreshadowing.status}
                options={FORESHADOWING_STATUS_OPTIONS}
                onChange={(status) => {
                  const nextStatus = status as TimelineForeshadowingStatus;
                  updateForeshadowing(foreshadowing.id, {
                    status: nextStatus,
                    payoffEventId:
                      nextStatus === "paid-off"
                        ? (foreshadowing.payoffEventId ??
                          eventOptions[0]?.id ??
                          null)
                        : foreshadowing.payoffEventId,
                  });
                }}
                ariaLabel="伏笔状态"
                size="toolbar"
              />
              <CustomSelect
                value={foreshadowing.plantedChapterId ?? ""}
                options={chapterSelectOptions}
                onChange={(plantedChapterId) =>
                  updateForeshadowing(foreshadowing.id, {
                    plantedChapterId: plantedChapterId || null,
                  })
                }
                ariaLabel="伏笔埋设章节"
                size="toolbar"
              />
            </div>
            <div className="mt-2">
              <CustomSelect
                value={foreshadowing.payoffEventId ?? ""}
                options={eventSelectOptions}
                onChange={(payoffEventId) =>
                  updateForeshadowing(foreshadowing.id, {
                    payoffEventId: payoffEventId || null,
                  })
                }
                ariaLabel="伏笔回收事件"
                size="toolbar"
              />
            </div>
            <input
              value={foreshadowing.note}
              onChange={(event) =>
                updateForeshadowing(foreshadowing.id, {
                  note: event.target.value,
                })
              }
              className={`${inputClass} mt-2`}
              placeholder="埋设方式、回收意图或废弃原因"
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function PeriodDialog({
  library,
  draft,
  isSaving,
  onChange,
  onClose,
  onSubmit,
  onRemove,
}: {
  readonly library: TimelineLibrary;
  readonly draft: PeriodDialogState;
  readonly isSaving: boolean;
  readonly onChange: (draft: PeriodDialogState) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly onRemove: () => void;
}) {
  const existing = draft.periodId
    ? library.periods.find((period) => period.id === draft.periodId)
    : null;
  const isRoot = existing?.parentPeriodId === null;
  const excludedIds = draft.periodId
    ? getTimelinePeriodDescendantIds(library, draft.periodId)
    : new Set<string>();
  const parentOptions = library.periods
    .filter((period) => !excludedIds.has(period.id))
    .map((period) => ({ value: period.id, label: period.name }));
  const canSubmit = Boolean(
    draft.name.trim() && (isRoot || draft.parentPeriodId),
  );

  return (
    <DraggableDialogFrame
      ariaLabel={draft.mode === "create" ? "新建纪元" : "编辑纪元"}
      className="w-[min(560px,calc(100vw-24px))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center justify-between px-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
            <ListTree className="h-4 w-4 text-[var(--accent-cool)]" />
            {draft.mode === "create" ? "新建纪元" : "编辑纪元"}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭纪元编辑"
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="space-y-4 p-5">
          <Field label="纪元名称">
            <input
              value={draft.name}
              onChange={(event) =>
                onChange({ ...draft, name: event.target.value })
              }
              className={inputClass}
              autoFocus
            />
          </Field>
          {isRoot ? (
            <Field label="上级纪元">
              <input value="根纪元" className={inputClass} disabled />
            </Field>
          ) : (
            <Field label="上级纪元">
              <CustomSelect
                value={draft.parentPeriodId ?? ""}
                options={parentOptions}
                onChange={(parentPeriodId) =>
                  onChange({
                    ...draft,
                    parentPeriodId: parentPeriodId || null,
                  })
                }
                ariaLabel="上级纪元"
                size="toolbar"
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="层级类型">
              <CustomSelect
                value={draft.kind}
                options={PERIOD_KIND_OPTIONS}
                onChange={(kind) =>
                  onChange({ ...draft, kind: kind as TimelinePeriodKind })
                }
                ariaLabel="纪元层级类型"
                size="toolbar"
              />
            </Field>
            <Field label="所属范围">
              <CustomSelect
                value={draft.scope}
                options={TIMELINE_SCOPE_OPTIONS}
                onChange={(scope) =>
                  onChange({ ...draft, scope: scope as TimelineScope })
                }
                ariaLabel="纪元所属范围"
                size="toolbar"
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="开始排序键">
              <input
                value={draft.startSortKey}
                onChange={(event) =>
                  onChange({ ...draft, startSortKey: event.target.value })
                }
                className={inputClass}
                type="number"
                placeholder="未知"
              />
            </Field>
            <Field label="结束排序键">
              <input
                value={draft.endSortKey}
                onChange={(event) =>
                  onChange({ ...draft, endSortKey: event.target.value })
                }
                className={inputClass}
                type="number"
                placeholder="未知"
              />
            </Field>
            <Field label="时间精度">
              <CustomSelect
                value={draft.precision}
                options={TIME_PRECISION_OPTIONS}
                onChange={(precision) =>
                  onChange({
                    ...draft,
                    precision: precision as TimelineTimePrecision,
                  })
                }
                ariaLabel="纪元时间精度"
                size="toolbar"
              />
            </Field>
          </div>
          <Field label="纪元说明">
            <textarea
              value={draft.description}
              onChange={(event) =>
                onChange({ ...draft, description: event.target.value })
              }
              className={`${inputClass} min-h-28 resize-y`}
              placeholder="记录该纪元的边界、核心变化与命名依据"
            />
          </Field>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-3">
          {!isRoot && draft.mode === "edit" && (
            <button
              type="button"
              onClick={onRemove}
              disabled={isSaving}
              className="mr-auto flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Trash2 className="h-4 w-4" />
              删除纪元
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!canSubmit || isSaving}
            className="flex items-center gap-2 rounded-md bg-[var(--accent-warm)] px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            保存纪元
          </button>
        </footer>
      </form>
    </DraggableDialogFrame>
  );
}

function BranchDialog({
  library,
  draft,
  isSaving,
  onChange,
  onClose,
  onSubmit,
}: {
  readonly library: TimelineLibrary;
  readonly draft: BranchDialogState;
  readonly isSaving: boolean;
  readonly onChange: (draft: BranchDialogState) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}) {
  const isMain = draft.branchId === MAIN_TIMELINE_BRANCH_ID;
  const excludedIds = draft.branchId
    ? descendantsOf(library, draft.branchId)
    : new Set<string>();
  const parentOptions = library.branches
    .filter((branch) => !excludedIds.has(branch.id))
    .map((branch) => ({ value: branch.id, label: branch.name }));
  const forkEvents = draft.parentBranchId
    ? eventForBranch(library, draft.parentBranchId)
    : [];
  const forkOptions = forkEvents.map((event) => ({
    value: event.id,
    label: `${event.timeLabel} · ${event.title}`,
  }));
  const canSubmit = Boolean(
    draft.name.trim() &&
      (isMain || (draft.parentBranchId && draft.forkEventId)),
  );

  return (
    <DraggableDialogFrame
      ariaLabel={draft.mode === "create" ? "新建时间分支" : "编辑时间分支"}
      className="w-[min(500px,calc(100vw-24px))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center justify-between px-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
            <GitFork className="h-4 w-4 text-[var(--accent-cool)]" />
            {draft.mode === "create" ? "新建时间分支" : "编辑时间分支"}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭时间分支编辑"
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="space-y-4 p-5">
          <Field label="分支名称">
            <input
              value={draft.name}
              onChange={(event) =>
                onChange({ ...draft, name: event.target.value })
              }
              className={inputClass}
              autoFocus
            />
          </Field>
          {!isMain && (
            <>
              <Field label="上级分支">
                <CustomSelect
                  value={draft.parentBranchId ?? ""}
                  options={parentOptions}
                  onChange={(parentBranchId) => {
                    const nextEvents = eventForBranch(library, parentBranchId);
                    onChange({
                      ...draft,
                      parentBranchId: parentBranchId || null,
                      forkEventId: nextEvents[0]?.id ?? null,
                    });
                  }}
                  ariaLabel="上级分支"
                  size="toolbar"
                />
              </Field>
              <Field label="分歧事件">
                <CustomSelect
                  value={draft.forkEventId ?? ""}
                  options={forkOptions}
                  onChange={(forkEventId) =>
                    onChange({ ...draft, forkEventId: forkEventId || null })
                  }
                  ariaLabel="分歧事件"
                  size="toolbar"
                />
                <p className="mt-1.5 text-xs leading-5 text-[var(--ink-subtle)]">
                  分支会继承该事件及其之前的上级历史。
                </p>
              </Field>
            </>
          )}
          <Field label="分支说明">
            <textarea
              value={draft.description}
              onChange={(event) =>
                onChange({ ...draft, description: event.target.value })
              }
              className={`${inputClass} min-h-24 resize-y`}
              placeholder="这条分支从何处分歧，关注怎样的可能性"
            />
          </Field>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!canSubmit || isSaving}
            className="flex items-center gap-2 rounded-md bg-[var(--accent-warm)] px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            保存分支
          </button>
        </footer>
      </form>
    </DraggableDialogFrame>
  );
}
