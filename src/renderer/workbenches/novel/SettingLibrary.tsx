import {
  AlertTriangle,
  ArrowDownAZ,
  Brackets,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileClock,
  FilePlus2,
  Files,
  Flag,
  FoldVertical,
  Globe2,
  Landmark,
  LandPlot,
  ListTree,
  Loader2,
  Map as MapIcon,
  MapPin,
  NotebookText,
  Orbit,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Tag,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  ConfirmDialog,
  CustomSelect,
  type SelectOption,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import MarkdownVisualEditor from "./MarkdownVisualEditor";
import SettingLibraryMetaEditor from "./SettingLibraryMeta";
import type { NovelAiAssistTarget } from "./aiAssistTypes";
import type { KnowledgeSourceRef } from "./knowledgeGraph";
import {
  createNovelLocationLibraryRepository,
  type LoadedLocationLibrary,
} from "./locationLibraryRepository";
import {
  validateLocationNodeReferences,
  type LocationStatus,
  type NovelLocation,
} from "./locationLibrarySchema";
import {
  createNovelSettingLibraryRepository,
  getNodeSettingReferences,
  getSpatialChildren,
  settingReferenceId,
  type LoadedSettingLibrary,
  type LoadedSettingPage,
  type SettingPageReference,
} from "./settingLibraryRepository";
import type {
  LevelType,
  SettingEntry,
  SettingLibraryMeta,
  SettingLibrarySpatialTree,
  SettingTemplate,
  SpatialNode,
} from "./settingLibrarySchema";

type EditorView = "content" | "entries" | "locations";
type DialogKind = "node" | "change-type" | "setting" | null;

const ROOT_PARENT_VALUE = "__root__";

const LOCATION_STATUS_LABELS: Record<LocationStatus, string> = {
  planned: "待登场",
  appeared: "已登场",
  archived: "已废弃",
};

const LOCATION_TYPE_OPTIONS = [
  "街道",
  "宅院",
  "建筑",
  "房间",
  "场地",
  "地标",
  "自然地貌",
  "秘境",
  "其他",
] as const;

interface SettingLibraryProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly mode: "library" | "meta";
  readonly headerActions?: ReactNode;
  readonly onAiAssist?: (
    target: NovelAiAssistTarget,
    localContext?: unknown,
  ) => Promise<string | null>;
  readonly focusSource?: KnowledgeSourceRef | null;
  readonly focusNodeId?: string | null;
}

const LEVEL_ICONS: Readonly<Record<string, LucideIcon>> = {
  "globe-2": Globe2,
  sparkles: Sparkles,
  orbit: Orbit,
  sun: Sun,
  "circle-dot": CircleDot,
  "land-plot": LandPlot,
  flag: Flag,
  map: MapIcon,
  "building-2": Building2,
  landmark: Landmark,
  brackets: Brackets,
};

function uniqueId(prefix: string): string {
  const token =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36);
  return `${prefix}-${token}`;
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function referenceName(reference: SettingPageReference): string {
  return reference.kind === "instance"
    ? reference.instance.name
    : reference.template.name;
}

function referenceGroup(reference: SettingPageReference): string {
  return reference.kind === "instance"
    ? reference.instance.group
    : reference.template.group;
}

function flattenSpatialNodes(
  tree: SettingLibrarySpatialTree,
  parentId: string | null = null,
): readonly SpatialNode[] {
  return getSpatialChildren(tree, parentId).flatMap((node) => [
    node,
    ...flattenSpatialNodes(tree, node.id),
  ]);
}

function spatialNodePath(
  tree: SettingLibrarySpatialTree,
  nodeId: string,
): string {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  const visited = new Set<string>();
  let node = byId.get(nodeId);
  while (node && !visited.has(node.id)) {
    visited.add(node.id);
    path.unshift(node.name);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return path.join(" / ");
}

function isSpatialNodeDescendant(
  tree: SettingLibrarySpatialTree,
  candidateId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  let parentId = byId.get(candidateId)?.parentId ?? null;
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return false;
}

function isLocationDescendant(
  locations: readonly NovelLocation[],
  candidateId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const visited = new Set<string>();
  let parentId = byId.get(candidateId)?.parentLocationId ?? null;
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentLocationId ?? null;
  }
  return false;
}

function Modal({
  title,
  eyebrow,
  children,
  footer,
  onClose,
}: {
  readonly title: string;
  readonly eyebrow: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg overflow-visible rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <div className="text-xs text-[var(--ink-muted)]">{eyebrow}</div>
            <h2 className="mt-1 text-lg font-semibold">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-4 overflow-visible px-5 py-5">{children}</div>
        <footer className="flex items-center justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          {footer}
        </footer>
      </section>
    </div>
  );
}

function FieldLabel({ children }: { readonly children: ReactNode }) {
  return (
    <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
      {children}
    </span>
  );
}

interface TreeBranchProps {
  readonly parentId: string | null;
  readonly library: LoadedSettingLibrary;
  readonly selectedNodeId: string;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onEdit?: (node: SpatialNode) => void;
  readonly depth?: number;
}

function TreeBranch({
  parentId,
  library,
  selectedNodeId,
  expanded,
  onToggle,
  onSelect,
  onEdit,
  depth = 0,
}: TreeBranchProps) {
  const nodes = getSpatialChildren(library.spatialTree, parentId);
  return nodes.map((node) => {
    const type = library.meta.levelTypes.find(
      (item) => item.id === node.typeId,
    );
    const Icon = LEVEL_ICONS[type?.icon ?? "brackets"] ?? Brackets;
    const children = getSpatialChildren(library.spatialTree, node.id);
    const isExpanded = expanded.has(node.id);
    const selected = node.id === selectedNodeId;
    return (
      <div
        key={node.id}
        role="treeitem"
        aria-expanded={children.length ? isExpanded : undefined}
      >
        <div
          className={`group flex h-10 items-center gap-1 rounded-md pr-2 ${
            selected
              ? "bg-[var(--accent-cool-subtle)] text-[var(--ink)] ring-1 ring-inset ring-[var(--accent-cool)]/30"
              : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          }`}
          style={{ paddingLeft: `${Math.min(depth * 16 + 4, 68)}px` }}
        >
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-label={isExpanded ? `收起${node.name}` : `展开${node.name}`}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ${
              children.length ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onSelect(node.id)}
            aria-label={`${node.name} · ${type?.name ?? "未知类型"}`}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Icon
              className={`h-4 w-4 shrink-0 ${selected ? "text-[var(--accent-cool)]" : ""}`}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {node.name}
            </span>
            <span className="max-w-24 shrink-0 truncate rounded border border-[var(--line)] bg-[var(--paper-elevated)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
              {type?.name ?? node.typeId}
            </span>
          </button>
          {onEdit && selected && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onEdit(node);
              }}
              aria-label={`编辑${node.name}`}
              title={`编辑${node.name}`}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {children.length > 0 && isExpanded && (
          <TreeBranch
            parentId={node.id}
            library={library}
            selectedNodeId={selectedNodeId}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            onEdit={onEdit}
            depth={depth + 1}
          />
        )}
      </div>
    );
  });
}

function LoadingState() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
      <Loader2 className="h-4 w-4 animate-spin" /> 正在读取设定库
    </div>
  );
}

function ErrorState({
  error,
  onRetry,
}: {
  readonly error: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg text-center">
        <AlertTriangle className="mx-auto h-7 w-7 text-[var(--warning)]" />
        <h1 className="mt-3 text-lg font-semibold">无法打开设定库</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
          {error}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mx-auto mt-5 flex h-9 items-center gap-2 rounded-md border border-[var(--line)] px-3 text-sm font-medium hover:bg-[var(--hover-bg)]"
        >
          <RefreshCw className="h-4 w-4" /> 重新读取
        </button>
      </div>
    </div>
  );
}

export default function SettingLibrary({
  storage,
  projectTitle,
  mode,
  headerActions,
  onAiAssist,
  focusSource,
  focusNodeId,
}: SettingLibraryProps) {
  const repository = useMemo(
    () => createNovelSettingLibraryRepository(storage),
    [storage],
  );
  const locationRepository = useMemo(
    () => createNovelLocationLibraryRepository(storage),
    [storage],
  );
  const [library, setLibrary] = useState<LoadedSettingLibrary | null>(null);
  const [locationLibrary, setLocationLibrary] =
    useState<LoadedLocationLibrary | null>(null);
  const [page, setPage] = useState<LoadedSettingPage | null>(null);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isPageLoading, setIsPageLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("world-root");
  const [selectedReferenceId, setSelectedReferenceId] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(["world-root"]),
  );
  const [treeQuery, setTreeQuery] = useState("");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [sortSettings, setSortSettings] = useState(false);
  const [editorView, setEditorView] = useState<EditorView>("content");
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [nodeName, setNodeName] = useState("");
  const [nodeTypeId, setNodeTypeId] = useState("");
  const [nodeParentId, setNodeParentId] = useState(ROOT_PARENT_VALUE);
  const [quickTypeName, setQuickTypeName] = useState("");
  const [settingName, setSettingName] = useState("");
  const [settingGroup, setSettingGroup] = useState("世界");
  const [promoteSetting, setPromoteSetting] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [entryDrafts, setEntryDrafts] = useState<readonly SettingEntry[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [locationDrafts, setLocationDrafts] = useState<
    readonly NovelLocation[]
  >([]);
  const [locationQuery, setLocationQuery] = useState("");
  const [locationPendingDeleteId, setLocationPendingDeleteId] = useState<
    string | null
  >(null);
  const [settingPendingDelete, setSettingPendingDelete] = useState<
    SettingPageReference | null
  >(null);
  const [nodePendingDelete, setNodePendingDelete] = useState<string | null>(
    null,
  );
  const [isTreeListOpen, setIsTreeListOpen] = useState(false);
  const [settingsDrawer, setSettingsDrawer] = useState(false);
  const dirtyRef = useRef(isDirty);
  const draftRef = useRef(draft);
  const pageRef = useRef(page);
  const libraryRef = useRef(library);
  const locationLibraryRef = useRef(locationLibrary);
  const metaSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const metaSaveCountRef = useRef(0);

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);
  useEffect(() => {
    libraryRef.current = library;
  }, [library]);
  useEffect(() => {
    locationLibraryRef.current = locationLibrary;
  }, [locationLibrary]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [next, nextLocations] = await Promise.all([
        repository.load(projectTitle),
        locationRepository.load(),
      ]);
      validateLocationNodeReferences(
        nextLocations.index,
        next.spatialTree.nodes.map((node) => node.id),
      );
      setLibrary(next);
      setLocationLibrary(nextLocations);
      setLocationDrafts(nextLocations.index.locations);
      setSelectedNodeId((current) =>
        next.spatialTree.nodes.some((node) => node.id === current)
          ? current
          : (next.spatialTree.nodes[0]?.id ?? ""),
      );
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsLoading(false);
    }
  }, [locationRepository, projectTitle, repository]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!focusSource || !library || mode !== "library") return;
    const reference = library.settingsIndex.settings.find(
      (item) =>
        item.pagePath === focusSource.path ||
        item.entriesPath === focusSource.path,
    );
    if (!reference) return;
    setSelectedNodeId(reference.nodeId);
    setSelectedReferenceId(
      settingReferenceId({ kind: "instance", instance: reference }),
    );
    setEditorView(
      reference.entriesPath === focusSource.path ? "entries" : "content",
    );
  }, [focusSource, library, mode]);

  useEffect(() => {
    if (!focusNodeId || !library || mode !== "library") return;
    const target = library.spatialTree.nodes.find(
      (node) => node.id === focusNodeId,
    );
    if (!target) return;
    setSelectedNodeId(target.id);
    setSelectedReferenceId("");
    setExpanded((current) => {
      const next = new Set(current);
      const byId = new Map(
        library.spatialTree.nodes.map((node) => [node.id, node]),
      );
      let node = target;
      while (node.parentId) {
        next.add(node.parentId);
        const parent = byId.get(node.parentId);
        if (!parent) break;
        node = parent;
      }
      return next;
    });
  }, [focusNodeId, library, mode]);

  const currentNode = library?.spatialTree.nodes.find(
    (node) => node.id === selectedNodeId,
  );
  const currentType = library?.meta.levelTypes.find(
    (type) => type.id === currentNode?.typeId,
  );
  const nodeLocations = useMemo(() => {
    if (!currentNode) return [];
    return locationDrafts
      .filter((location) => location.nodeId === currentNode.id)
      .sort(
        (left, right) =>
          left.order - right.order ||
          left.name.localeCompare(right.name, "zh-CN"),
      );
  }, [currentNode, locationDrafts]);
  const filteredNodeLocations = useMemo(() => {
    const query = locationQuery.trim().toLocaleLowerCase("zh-CN");
    if (!query) return nodeLocations;
    return nodeLocations.filter((location) =>
      `${location.name}${location.aliases.join(" ")}${location.type}`
        .toLocaleLowerCase("zh-CN")
        .includes(query),
    );
  }, [locationQuery, nodeLocations]);
  const activeLocation = nodeLocations.find(
    (location) => location.id === selectedLocationId,
  );

  useEffect(() => {
    if (
      selectedLocationId &&
      filteredNodeLocations.some(
        (location) => location.id === selectedLocationId,
      )
    ) {
      return;
    }
    setSelectedLocationId(filteredNodeLocations[0]?.id ?? "");
  }, [filteredNodeLocations, selectedLocationId]);

  const settingReferences = useMemo(() => {
    if (!library || !currentNode) return [];
    const references = getNodeSettingReferences(library, currentNode.id);
    const query = settingsQuery.trim().toLowerCase();
    const filtered = query
      ? references.filter((reference) =>
          `${referenceName(reference)}${referenceGroup(reference)}`
            .toLowerCase()
            .includes(query),
        )
      : references;
    return sortSettings
      ? [...filtered].sort((left, right) =>
          referenceName(left).localeCompare(referenceName(right), "zh-CN"),
        )
      : filtered;
  }, [currentNode, library, settingsQuery, sortSettings]);

  useEffect(() => {
    if (!settingReferences.length) {
      setSelectedReferenceId("");
      setPage(null);
      return;
    }
    if (
      !settingReferences.some(
        (reference) => settingReferenceId(reference) === selectedReferenceId,
      )
    ) {
      setSelectedReferenceId(settingReferenceId(settingReferences[0]));
    }
  }, [selectedReferenceId, settingReferences]);

  const selectedReference = settingReferences.find(
    (reference) => settingReferenceId(reference) === selectedReferenceId,
  );

  useEffect(() => {
    if (!selectedReference) return;
    let cancelled = false;
    setIsPageLoading(true);
    setError(null);
    void repository
      .loadPage(selectedReference)
      .then((loadedPage) => {
        if (cancelled) return;
        setPage(loadedPage);
        setDraft(loadedPage.content);
        setEntryDrafts(loadedPage.entries);
        setSelectedEntryId(loadedPage.entries[0]?.id ?? "");
        setIsDirty(false);
      })
      .catch((cause) => {
        if (!cancelled) setError(toError(cause));
      })
      .finally(() => {
        if (!cancelled) setIsPageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repository, selectedReference]);

  const saveCurrentPage =
    useCallback(async (): Promise<LoadedSettingPage | null> => {
      const activeLibrary = libraryRef.current;
      const activePage = pageRef.current;
      if (!activeLibrary || !activePage || isSaving) return activePage;
      if (!dirtyRef.current && activePage.reference.kind === "instance")
        return activePage;
      const content = draftRef.current;
      setIsSaving(true);
      setError(null);
      setIsDirty(false);
      try {
        const result = await repository.savePage(
          activeLibrary,
          activePage,
          content,
        );
        setLibrary(result.library);
        setPage(result.page);
        if (result.page.reference.kind === "instance") {
          setSelectedReferenceId(result.page.reference.instance.id);
        }
        return result.page;
      } catch (cause) {
        setError(toError(cause));
        setIsDirty(true);
        return null;
      } finally {
        setIsSaving(false);
      }
    }, [isSaving, repository]);

  useEffect(() => {
    if (!isDirty || isSaving || !page) return;
    const timer = window.setTimeout(() => void saveCurrentPage(), 900);
    return () => window.clearTimeout(timer);
  }, [draft, isDirty, isSaving, page, saveCurrentPage]);

  const selectNode = async (id: string) => {
    if (dirtyRef.current) await saveCurrentPage();
    setSelectedNodeId(id);
    setSelectedReferenceId("");
    setSettingsDrawer(false);
    setIsTreeListOpen(false);
  };

  const selectSetting = async (reference: SettingPageReference) => {
    if (dirtyRef.current) await saveCurrentPage();
    setSelectedReferenceId(settingReferenceId(reference));
    setSettingsDrawer(false);
  };

  const saveMeta = useCallback(
    async (meta: SettingLibraryMeta) => {
      if (!libraryRef.current) return;
      metaSaveCountRef.current += 1;
      setIsSaving(true);
      setError(null);

      const operation = metaSaveQueueRef.current.then(async () => {
        const activeLibrary = libraryRef.current;
        if (!activeLibrary) return;
        const next = await repository.saveMeta(activeLibrary, meta);
        libraryRef.current = next;
        setLibrary(next);
      });
      metaSaveQueueRef.current = operation.catch(() => undefined);

      try {
        await operation;
      } catch (cause) {
        setError(toError(cause));
      } finally {
        metaSaveCountRef.current -= 1;
        if (metaSaveCountRef.current === 0) setIsSaving(false);
      }
    },
    [repository],
  );

  const openNodeDialog = (asRoot: boolean) => {
    if (!library || !currentNode) return;
    const parentNode = asRoot ? undefined : currentNode;
    const parentType = parentNode
      ? library.meta.levelTypes.find((type) => type.id === parentNode.typeId)
      : undefined;
    const suggested = asRoot
      ? library.meta.levelTypes.find((type) => !type.archived)
      : (library.meta.levelTypes.find(
          (type) =>
            !type.archived &&
            parentType?.suggestedChildTypeIds.includes(type.id),
        ) ?? library.meta.levelTypes.find((type) => !type.archived));
    setNodeParentId(asRoot ? ROOT_PARENT_VALUE : currentNode.id);
    setNodeName("");
    setNodeTypeId(suggested?.id ?? "");
    setQuickTypeName("");
    setDialog("node");
  };

  const changeNodeParent = (parentValue: string) => {
    if (!library) return;
    setNodeParentId(parentValue);
    const parentNode =
      parentValue === ROOT_PARENT_VALUE
        ? undefined
        : library.spatialTree.nodes.find((node) => node.id === parentValue);
    const parentType = parentNode
      ? library.meta.levelTypes.find((type) => type.id === parentNode.typeId)
      : undefined;
    const suggested = parentType
      ? library.meta.levelTypes.find(
          (type) =>
            !type.archived &&
            parentType.suggestedChildTypeIds.includes(type.id),
        )
      : library.meta.levelTypes.find((type) => !type.archived);
    if (suggested) setNodeTypeId(suggested.id);
  };

  const createNode = async () => {
    let activeLibrary = libraryRef.current;
    if (!activeLibrary || !nodeName.trim()) return;
    setIsSaving(true);
    setError(null);
    try {
      let typeId = nodeTypeId;
      const parentId = nodeParentId === ROOT_PARENT_VALUE ? null : nodeParentId;
      const parentNode = parentId
        ? activeLibrary.spatialTree.nodes.find((node) => node.id === parentId)
        : undefined;
      if (parentId && !parentNode) throw new Error("选择的父节点不存在");
      if (quickTypeName.trim()) {
        typeId = uniqueId("type");
        const type: LevelType = {
          id: typeId,
          name: quickTypeName.trim(),
          description: "作者在空间树中快速创建的自定义层级类型。",
          icon: "brackets",
          mapKind: "hidden",
          source: "project",
          suggestedParentTypeIds: parentNode ? [parentNode.typeId] : [],
          suggestedChildTypeIds: [],
        };
        activeLibrary = await repository.saveMeta(activeLibrary, {
          ...activeLibrary.meta,
          levelTypes: [...activeLibrary.meta.levelTypes, type],
          profiles: [
            ...activeLibrary.meta.profiles,
            { levelTypeId: typeId, templateIds: [] },
          ],
        });
      }
      if (!typeId) throw new Error("必须为空间节点选择层级类型");
      const siblings = getSpatialChildren(activeLibrary.spatialTree, parentId);
      const node: SpatialNode = {
        id: uniqueId("node"),
        parentId,
        name: nodeName.trim(),
        typeId,
        order: siblings.length,
      };
      const next = await repository.saveSpatialTree(activeLibrary, {
        ...activeLibrary.spatialTree,
        nodes: [...activeLibrary.spatialTree.nodes, node],
      });
      setLibrary(next);
      setSelectedNodeId(node.id);
      setExpanded(
        (current) =>
          new Set([...current, ...(parentId ? [parentId] : []), node.id]),
      );
      setDialog(null);
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const saveNodeEdit = async () => {
    const activeLibrary = libraryRef.current;
    const name = nodeName.trim();
    if (!activeLibrary || !currentNode || !nodeTypeId || !name) return;
    setIsSaving(true);
    setError(null);
    try {
      const parentId = nodeParentId === ROOT_PARENT_VALUE ? null : nodeParentId;
      if (
        parentId &&
        (parentId === currentNode.id ||
          isSpatialNodeDescendant(
            activeLibrary.spatialTree,
            parentId,
            currentNode.id,
          ))
      ) {
        throw new Error("父节点不能是当前节点或其下级节点");
      }
      if (
        parentId &&
        !activeLibrary.spatialTree.nodes.some((node) => node.id === parentId)
      ) {
        throw new Error("选择的父节点不存在");
      }
      const parentChanged = parentId !== currentNode.parentId;
      const tree: SettingLibrarySpatialTree = {
        ...activeLibrary.spatialTree,
        nodes: activeLibrary.spatialTree.nodes.map((node) =>
          node.id === currentNode.id
            ? {
                ...node,
                name,
                parentId,
                typeId: nodeTypeId,
                ...(parentChanged
                  ? {
                      order: getSpatialChildren(
                        activeLibrary.spatialTree,
                        parentId,
                      ).length,
                    }
                  : {}),
              }
            : node,
        ),
      };
      const next = await repository.saveSpatialTree(activeLibrary, tree);
      setLibrary(next);
      setSelectedReferenceId("");
      setDialog(null);
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const createSetting = async () => {
    let activeLibrary = libraryRef.current;
    if (!activeLibrary || !currentNode || !settingName.trim()) return;
    setIsSaving(true);
    setError(null);
    try {
      const id = uniqueId("setting");
      let templateId: string | null = null;
      if (promoteSetting) {
        templateId = uniqueId("template");
        const template: SettingTemplate = {
          id: templateId,
          name: settingName.trim(),
          group: settingGroup,
          description: `由“${currentNode.name}”中的自定义设定提升而来。`,
          source: "project",
          version: "1.0.0",
          skeleton: `# ${settingName.trim()}\n\n## 核心内容\n`,
          agentGuide: "仅依据作者已提供的事实协助完善。",
        };
        const currentProfile = activeLibrary.meta.profiles.find(
          (profile) => profile.levelTypeId === currentNode.typeId,
        );
        activeLibrary = await repository.saveMeta(activeLibrary, {
          ...activeLibrary.meta,
          settingTemplates: [...activeLibrary.meta.settingTemplates, template],
          profiles: [
            ...activeLibrary.meta.profiles.filter(
              (profile) => profile.levelTypeId !== currentNode.typeId,
            ),
            {
              levelTypeId: currentNode.typeId,
              templateIds: [...(currentProfile?.templateIds ?? []), templateId],
            },
          ],
        });
      }
      const result = await repository.createCustomSetting(activeLibrary, {
        id,
        nodeId: currentNode.id,
        name: settingName,
        group: settingGroup,
        skeleton: `# ${settingName.trim()}\n\n## 核心内容\n`,
        templateId,
      });
      setLibrary(result.library);
      setPage(result.page);
      setDraft(result.page.content);
      setEntryDrafts([]);
      setSelectedReferenceId(id);
      setDialog(null);
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const deleteSettingPage = async () => {
    const activeLibrary = libraryRef.current;
    const target = settingPendingDelete;
    if (!activeLibrary || !target || target.kind !== "instance") return;
    setIsSaving(true);
    setError(null);
    try {
      const wasSelected = selectedReferenceId === settingReferenceId(target);
      const next = await repository.deleteSettingPage(
        activeLibrary,
        target.instance,
      );
      setLibrary(next);
      setSettingPendingDelete(null);
      if (wasSelected) {
        setSelectedReferenceId("");
        setPage(null);
        setDraft("");
        setEntryDrafts([]);
        setSelectedEntryId("");
      }
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const toggleSettingStatus = async (reference: SettingPageReference) => {
    const activeLibrary = libraryRef.current;
    if (!activeLibrary || reference.kind !== "instance") return;
    setIsSaving(true);
    setError(null);
    try {
      const nextStatus =
        reference.instance.status === "completed" ? "draft" : "completed";
      const next = await repository.updateSettingStatus(
        activeLibrary,
        reference.instance.id,
        nextStatus,
      );
      setLibrary(next);
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const deleteNode = async () => {
    const activeLibrary = libraryRef.current;
    const targetId = nodePendingDelete;
    if (!activeLibrary || !targetId) return;
    setIsSaving(true);
    setError(null);
    try {
      const next = await repository.deleteSpatialNode(activeLibrary, targetId);
      setLibrary(next);
      setNodePendingDelete(null);
      setDialog(null);
      if (selectedNodeId === targetId) {
        const fallback =
          next.spatialTree.nodes.find(
            (node) => node.id !== targetId && node.parentId === null,
          ) ?? next.spatialTree.nodes[0];
        setSelectedNodeId(fallback?.id ?? "");
        setSelectedReferenceId("");
        setPage(null);
        setDraft("");
        setEntryDrafts([]);
      }
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const ensureMaterialized = async (): Promise<LoadedSettingPage | null> => {
    if (page?.reference.kind === "instance") return page;
    return saveCurrentPage();
  };

  const addEntry = async () => {
    const materialized = await ensureMaterialized();
    if (!materialized || materialized.reference.kind !== "instance") return;
    const entry: SettingEntry = {
      id: uniqueId("entry"),
      name: "未命名词条",
      category: "术语",
      aliases: [],
      definition: "",
    };
    try {
      const next = await repository.saveEntries(materialized, [
        ...materialized.entries,
        entry,
      ]);
      setPage(next);
      setEntryDrafts(next.entries);
      setSelectedEntryId(entry.id);
    } catch (cause) {
      setError(toError(cause));
    }
  };

  const saveEntries = async (entries = entryDrafts) => {
    const materialized = await ensureMaterialized();
    if (!materialized || materialized.reference.kind !== "instance") return;
    setIsSaving(true);
    setError(null);
    try {
      const next = await repository.saveEntries(materialized, entries);
      setPage(next);
      setEntryDrafts(next.entries);
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const saveLocations = async (locations = locationDrafts) => {
    const activeLocationLibrary = locationLibraryRef.current;
    const activeSettingLibrary = libraryRef.current;
    if (!activeLocationLibrary || !activeSettingLibrary) return;
    setIsSaving(true);
    setError(null);
    try {
      const index = {
        ...activeLocationLibrary.index,
        locations: [...locations],
      };
      validateLocationNodeReferences(
        index,
        activeSettingLibrary.spatialTree.nodes.map((node) => node.id),
      );
      const next = await locationRepository.save(activeLocationLibrary, index);
      locationLibraryRef.current = next;
      setLocationLibrary(next);
      setLocationDrafts(next.index.locations);
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const addLocation = async () => {
    if (!currentNode || !locationLibraryRef.current) return;
    let id = uniqueId("location");
    let suffix = 2;
    const ids = new Set(locationDrafts.map((location) => location.id));
    while (ids.has(id)) {
      id = `${id}-${suffix}`;
      suffix += 1;
    }
    const location: NovelLocation = {
      id,
      nodeId: currentNode.id,
      parentLocationId: null,
      name: "未命名地点",
      aliases: [],
      type: "其他",
      status: "planned",
      summary: "",
      appearanceNote: "",
      description: "",
      order: nodeLocations.length,
    };
    const next = [...locationDrafts, location];
    setLocationDrafts(next);
    setSelectedLocationId(location.id);
    await saveLocations(next);
  };

  const updateLocation = (
    locationId: string,
    update: (location: NovelLocation) => NovelLocation,
  ) => {
    setLocationDrafts((current) =>
      current.map((location) =>
        location.id === locationId ? update(location) : location,
      ),
    );
  };

  const deleteLocation = async () => {
    const locationId = locationPendingDeleteId;
    if (!locationId) return;
    const location = locationDrafts.find((item) => item.id === locationId);
    const hasChildren = locationDrafts.some(
      (item) => item.parentLocationId === locationId,
    );
    if (hasChildren) {
      setError(`请先为“${location?.name ?? "该地点"}”下的地点重新选择上级地点`);
      setLocationPendingDeleteId(null);
      return;
    }
    const next = locationDrafts.filter((item) => item.id !== locationId);
    setLocationDrafts(next);
    setSelectedLocationId(
      next.find((item) => item.nodeId === currentNode?.id)?.id ?? "",
    );
    setLocationPendingDeleteId(null);
    await saveLocations(next);
  };

  if (isLoading && !library) return <LoadingState />;
  if (!library)
    return (
      <ErrorState
        error={error ?? "设定库文件不可用"}
        onRetry={() => void load()}
      />
    );
  if (!locationLibrary)
    return (
      <ErrorState
        error={error ?? "地点库文件不可用"}
        onRetry={() => void load()}
      />
    );
  if (mode === "meta") {
    return (
      <SettingLibraryMetaEditor
        library={library}
        projectTitle={projectTitle}
        isSaving={isSaving}
        error={error}
        onSave={saveMeta}
        onAiAssist={onAiAssist}
        headerActions={headerActions}
      />
    );
  }

  const activeEntry = entryDrafts.find((entry) => entry.id === selectedEntryId);
  const filteredTreeNodes = treeQuery.trim()
    ? library.spatialTree.nodes.filter((node) => {
        const type = library.meta.levelTypes.find(
          (item) => item.id === node.typeId,
        );
        return `${node.name}${type?.name ?? ""}`
          .toLowerCase()
          .includes(treeQuery.trim().toLowerCase());
      })
    : [];
  const typeOptions: SelectOption[] = library.meta.levelTypes
    .filter((type) => !type.archived)
    .map((type) => ({ value: type.id, label: type.name }));
  const locationNodeOptions: SelectOption[] = flattenSpatialNodes(
    library.spatialTree,
  ).map((node) => ({
    value: node.id,
    label: spatialNodePath(library.spatialTree, node.id),
  }));
  const locationParentOptions: SelectOption[] = activeLocation
    ? [
        { value: "", label: "不设置上级地点" },
        ...nodeLocations
          .filter(
            (location) =>
              location.id !== activeLocation.id &&
              !isLocationDescendant(
                nodeLocations,
                location.id,
                activeLocation.id,
              ),
          )
          .map((location) => ({
            value: location.id,
            label: location.name,
          })),
      ]
    : [];
  const hasLocationChanges =
    JSON.stringify(locationDrafts) !==
    JSON.stringify(locationLibrary.index.locations);
  const parentOptions: SelectOption[] = [
    {
      value: ROOT_PARENT_VALUE,
      label: "选择作为根节点",
      icon: <CircleDot className="h-4 w-4 text-[var(--accent-cool)]" />,
      content: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">作为根节点</span>
          <span className="shrink-0 text-xs text-[var(--ink-muted)]">
            无父节点
          </span>
        </span>
      ),
    },
    ...flattenSpatialNodes(library.spatialTree).map((node) => {
      const type = library.meta.levelTypes.find(
        (item) => item.id === node.typeId,
      );
      const Icon = LEVEL_ICONS[type?.icon ?? "brackets"] ?? Brackets;
      const path = spatialNodePath(library.spatialTree, node.id);
      return {
        value: node.id,
        label: `选择父节点：${path} · ${type?.name ?? node.typeId}`,
        icon: <Icon className="h-4 w-4 text-[var(--ink-muted)]" />,
        content: (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{path}</span>
            <span className="shrink-0 rounded border border-[var(--line)] bg-[var(--paper-elevated)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
              {type?.name ?? node.typeId}
            </span>
          </span>
        ),
      } satisfies SelectOption;
    }),
  ];
  const nodeEditParentOptions = currentNode
    ? parentOptions.filter(
        (option) =>
          option.value === ROOT_PARENT_VALUE ||
          (option.value !== currentNode.id &&
            !isSpatialNodeDescendant(
              library.spatialTree,
              option.value,
              currentNode.id,
            )),
      )
    : parentOptions;
  const groupOptions: SelectOption[] = [
    "世界",
    "地理",
    "历史",
    "政治",
    "军事",
    "经济",
    "社会",
    "文化",
  ].map((group) => ({ value: group, label: group }));
  const expandableNodeIds = library.spatialTree.nodes
    .filter(
      (node) => getSpatialChildren(library.spatialTree, node.id).length > 0,
    )
    .map((node) => node.id);
  const isTreeFullyExpanded =
    expandableNodeIds.length > 0 &&
    expandableNodeIds.every((nodeId) => expanded.has(nodeId));

  const panelBase = "min-h-0 bg-[var(--paper-elevated)]";
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--paper)]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-2 max-md:flex-wrap">
        <div className="flex min-w-0 items-center gap-3">
          <Globe2 className="h-5 w-5 shrink-0 text-[var(--accent-warm)]" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">世界架构</h1>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              {projectTitle} · {library.spatialTree.nodes.length} 个空间节点 ·{" "}
              {isSaving ? "保存中" : isDirty ? "待保存" : "已保存"}
            </p>
          </div>
        </div>
        {headerActions && (
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
          </div>
        )}
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {error && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--error-bg)] px-4 py-2 text-xs text-[var(--error)]">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="关闭错误"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(16rem,20rem)_minmax(16rem,21rem)_minmax(30rem,1fr)] max-[1400px]:grid-cols-[minmax(16rem,19rem)_minmax(28rem,1fr)] max-md:grid-cols-1">
          <aside
            className={`${panelBase} flex flex-col border-r border-[var(--line)] max-[1400px]:hidden`}
            aria-label="空间层级"
          >
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
              <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5">
                <Search className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                <input
                  value={treeQuery}
                  onChange={(event) => setTreeQuery(event.target.value)}
                  placeholder="搜索空间节点"
                  aria-label="搜索空间节点"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  setExpanded(
                    isTreeFullyExpanded
                      ? new Set()
                      : new Set(expandableNodeIds),
                  )
                }
                disabled={!expandableNodeIds.length}
                aria-label={isTreeFullyExpanded ? "折叠空间树" : "展开空间树"}
                title={isTreeFullyExpanded ? "折叠空间树" : "展开空间树"}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FoldVertical className="h-4 w-4" />
              </button>
              {onAiAssist && currentNode && (
                <button
                  type="button"
                  onClick={() =>
                    onAiAssist({
                      kind: "spatial-children",
                      label: `为“${currentNode.name}”生成下级空间`,
                      nodeId: currentNode.id,
                    })
                  }
                  aria-label="AI 生成下级空间"
                  title="AI 生成下级空间"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--accent-cool)] hover:bg-[var(--accent-cool-subtle)]"
                >
                  <Sparkles className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => openNodeDialog(false)}
                aria-label="新增子节点"
                title="新增子节点"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-[var(--hover-bg)]"
              >
                <Plus className="h-4 w-4" />
              </button>
            </header>
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] px-4 text-xs text-[var(--accent-cool)]">
              <Tag className="h-3.5 w-3.5" /> 每个节点必须关联层级类型
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2" role="tree">
              {treeQuery.trim() ? (
                <div className="space-y-1">
                  {filteredTreeNodes.map((node) => {
                    const type = library.meta.levelTypes.find(
                      (item) => item.id === node.typeId,
                    );
                    return (
                      <button
                        key={node.id}
                        type="button"
                        onClick={() => void selectNode(node.id)}
                        className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--hover-bg)]"
                      >
                        <span className="truncate font-medium">
                          {node.name}
                        </span>
                        <span className="ml-2 text-xs text-[var(--ink-muted)]">
                          {type?.name}
                        </span>
                      </button>
                    );
                  })}
                  {!filteredTreeNodes.length && (
                    <p className="px-3 py-8 text-center text-xs text-[var(--ink-muted)]">
                      没有匹配的空间节点
                    </p>
                  )}
                </div>
              ) : (
                <TreeBranch
                  parentId={null}
                  library={library}
                  selectedNodeId={selectedNodeId}
                  expanded={expanded}
                  onToggle={(id) =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  onSelect={(id) => void selectNode(id)}
                  onEdit={(node) => {
                    setNodeName(node.name);
                    setNodeParentId(node.parentId ?? ROOT_PARENT_VALUE);
                    setNodeTypeId(node.typeId);
                    setDialog("change-type");
                  }}
                />
              )}
            </div>
            <footer className="flex h-12 shrink-0 items-center justify-between border-t border-[var(--line)] px-3 text-xs text-[var(--ink-muted)]">
              <button
                type="button"
                onClick={() => openNodeDialog(true)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--ink)] hover:bg-[var(--hover-bg)]"
              >
                <Plus className="h-4 w-4" /> 新增根节点
              </button>
              <span>{library.spatialTree.nodes.length} 个节点</span>
            </footer>
          </aside>

          <section
            className={`${panelBase} relative flex flex-col border-r border-[var(--line)] ${
              settingsDrawer
                ? "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:flex max-md:w-80 max-md:shadow-xl"
                : "max-md:hidden"
            }`}
            aria-label="当前节点设定"
          >
            <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--line)] text-[var(--accent-cool)]">
                <Orbit className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-sm">
                  {currentNode?.name}
                </strong>
                <span className="block truncate text-xs text-[var(--ink-muted)]">
                  {currentType?.name} · {settingReferences.length} 个设定页面
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setTreeQuery("");
                  setIsTreeListOpen((current) => !current);
                }}
                aria-expanded={isTreeListOpen}
                aria-label="选择空间节点"
                title="选择空间节点"
                className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] max-[1400px]:flex"
              >
                <ListTree className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setSettingsDrawer(false)}
                aria-label="关闭当前节点设定"
                title="关闭当前节点设定"
                className="hidden h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-[var(--hover-bg)] max-md:flex"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            {isTreeListOpen && (
              <div className="absolute inset-x-0 top-14 z-30 hidden max-h-[min(34rem,calc(100vh-10rem))] flex-col overflow-hidden border-b border-[var(--line)] bg-[var(--paper-elevated)] shadow-lg max-[1400px]:flex">
                <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
                  <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2">
                    <Search className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    <input
                      value={treeQuery}
                      onChange={(event) => setTreeQuery(event.target.value)}
                      placeholder="搜索空间节点"
                      aria-label="搜索空间节点"
                      autoFocus
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setIsTreeListOpen(false)}
                    aria-label="关闭空间节点列表"
                    title="关闭空间节点列表"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-[var(--hover-bg)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto p-2" role="tree">
                  {treeQuery.trim() ? (
                    <div className="space-y-1">
                      {filteredTreeNodes.map((node) => {
                        const type = library.meta.levelTypes.find(
                          (item) => item.id === node.typeId,
                        );
                        return (
                          <button
                            key={node.id}
                            type="button"
                            onClick={() => void selectNode(node.id)}
                            className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                              node.id === selectedNodeId
                                ? "bg-[var(--accent-cool-subtle)]"
                                : "hover:bg-[var(--hover-bg)]"
                            }`}
                          >
                            <span className="truncate font-medium">
                              {node.name}
                            </span>
                            <span className="ml-2 shrink-0 text-xs text-[var(--ink-muted)]">
                              {type?.name}
                            </span>
                          </button>
                        );
                      })}
                      {!filteredTreeNodes.length && (
                        <p className="px-3 py-8 text-center text-xs text-[var(--ink-muted)]">
                          没有匹配的空间节点
                        </p>
                      )}
                    </div>
                  ) : (
                    <TreeBranch
                      parentId={null}
                      library={library}
                      selectedNodeId={selectedNodeId}
                      expanded={expanded}
                      onToggle={(id) =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        })
                      }
                      onSelect={(id) => void selectNode(id)}
                    />
                  )}
                </div>
              </div>
            )}
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
              <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5">
                <Search className="h-4 w-4 text-[var(--ink-muted)]" />
                <input
                  value={settingsQuery}
                  onChange={(event) => setSettingsQuery(event.target.value)}
                  placeholder="搜索当前节点设定"
                  aria-label="搜索当前节点设定"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
              </label>
              <button
                type="button"
                aria-pressed={sortSettings}
                onClick={() => setSortSettings((current) => !current)}
                aria-label="按名称排序设定"
                title="按名称排序设定"
                className="flex h-8 w-8 items-center justify-center rounded hover:bg-[var(--hover-bg)]"
              >
                <ArrowDownAZ className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setSettingName("");
                  setSettingGroup("世界");
                  setPromoteSetting(false);
                  setDialog("setting");
                }}
                aria-label="新增自定义设定"
                title="新增自定义设定"
                className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-warm)] text-white"
              >
                <FilePlus2 className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {settingReferences.map((reference) => {
                const id = settingReferenceId(reference);
                const selected = id === selectedReferenceId;
                const isVirtual = reference.kind === "virtual";
                const template =
                  reference.kind === "instance" &&
                  reference.instance.templateId
                    ? library.meta.settingTemplates.find(
                        (item) => item.id === reference.instance.templateId,
                      )
                    : undefined;
                const outdatedTemplate =
                  reference.kind === "instance" &&
                  reference.instance.templateId &&
                  template &&
                  (reference.instance.templateVersion !== template.version ||
                    template.archived);
                return (
                  <div
                    key={id}
                    role="button"
                    tabIndex={0}
                    onClick={() => void selectSetting(reference)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void selectSetting(reference);
                      }
                    }}
                    className={`flex w-full cursor-pointer items-center gap-3 border-b border-[var(--line-subtle)] px-4 py-3 text-left ${
                      selected
                        ? "bg-[var(--accent-warm-subtle)] shadow-[inset_3px_0_0_var(--accent-warm)]"
                        : "hover:bg-[var(--hover-bg)]"
                    }`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
                      {isVirtual ? (
                        <FileClock className="h-4 w-4" />
                      ) : (
                        <NotebookText className="h-4 w-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">
                        {referenceName(reference)}
                      </strong>
                      <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
                        {referenceGroup(reference)} ·{" "}
                        {isVirtual ? "虚拟页面" : "Markdown"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {outdatedTemplate && (
                        <span
                          className="rounded border border-[var(--line)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]"
                          title={
                            template.archived
                              ? `模板已归档${
                                  reference.instance.templateVersion
                                    ? `（页面基于 v${reference.instance.templateVersion}）`
                                    : ""
                                }`
                              : `页面基于模板 v${reference.instance.templateVersion}，当前模板 v${template.version}`
                          }
                        >
                          {template.archived ? "已归档" : "旧模板"}
                        </span>
                      )}
                      {!isVirtual && (
                        <>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void toggleSettingStatus(reference);
                            }}
                            disabled={isSaving}
                            title={
                              reference.instance.status === "completed"
                                ? "标记为草稿"
                                : "标记为已完成"
                            }
                            className="rounded-md border border-[var(--line)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:opacity-45"
                          >
                            {reference.instance.status === "completed"
                              ? "已完成"
                              : "草稿"}
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSettingPendingDelete(reference);
                            }}
                            aria-label="删除设定页面"
                            title="删除设定页面"
                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--danger-subtle)] hover:text-[var(--danger)]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
              {!settingReferences.length && (
                <div className="px-6 py-12 text-center">
                  <Files className="mx-auto h-6 w-6 text-[var(--ink-subtle)]" />
                  <p className="mt-3 text-sm font-medium">
                    当前节点没有设定页面
                  </p>
                  <p className="mt-1 text-xs text-[var(--ink-muted)]">
                    可以新增自定义设定，或在模板配置中关联默认页面。
                  </p>
                </div>
              )}
            </div>
            <footer className="flex min-h-11 shrink-0 items-center gap-2 border-t border-[var(--line)] px-4 text-xs text-[var(--ink-muted)]">
              <ShieldCheck className="h-4 w-4 text-[var(--accent-cool)]" />{" "}
              模板只提供起点，不限制幻想设定
            </footer>
          </section>

          <article className="flex min-h-0 min-w-0 flex-col bg-[var(--paper)]">
            <header className="flex h-14 shrink-0 items-end border-b border-[var(--line)] px-5">
              <button
                type="button"
                onClick={() => setSettingsDrawer(true)}
                aria-label="打开当前节点设定"
                className="mb-2 mr-2 hidden h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] max-md:flex"
              >
                <Files className="h-4 w-4" />
              </button>
              {(
                [
                  ["content", "内容", null],
                  ["entries", "词条", entryDrafts.length],
                  ["locations", "地点", nodeLocations.length],
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={editorView === id}
                  onClick={() => setEditorView(id)}
                  className={`flex h-full items-center gap-2 border-b-2 px-4 text-sm font-medium ${
                    editorView === id
                      ? "border-[var(--accent-cool)] text-[var(--ink)]"
                      : "border-transparent text-[var(--ink-muted)]"
                  }`}
                >
                  {label}
                  {count !== null && (
                    <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs">
                      {count}
                    </span>
                  )}
                </button>
              ))}
              {onAiAssist &&
                page &&
                currentNode &&
                editorView !== "locations" && (
                  <button
                    type="button"
                    onClick={() => {
                      void onAiAssist(
                        {
                          kind: "setting-page",
                          label: `完善“${referenceName(page.reference)}”`,
                          nodeId: currentNode.id,
                          settingId: settingReferenceId(page.reference),
                        },
                        { currentDraft: draft },
                      ).then((output) => {
                        if (!output) return;
                        setDraft(output);
                        setIsDirty(true);
                      });
                    }}
                    className="ml-auto mb-2 flex h-8 items-center gap-1.5 rounded-md border border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)] px-2.5 text-xs font-medium text-[var(--accent-cool)] hover:bg-[var(--paper-inset)]"
                  >
                    <Sparkles className="h-3.5 w-3.5" /> AI 写作
                  </button>
                )}
              <div
                className={`${onAiAssist && page && editorView !== "locations" ? "ml-2" : "ml-auto"} mb-2 flex h-8 items-center gap-1.5 text-xs text-[var(--ink-muted)]`}
              >
                {isSaving || isPageLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isDirty || hasLocationChanges ? (
                  <Save className="h-3.5 w-3.5" />
                ) : (
                  <Check className="h-3.5 w-3.5 text-[var(--success)]" />
                )}
                {isPageLoading
                  ? "读取中"
                  : isSaving
                    ? "保存中"
                    : isDirty || hasLocationChanges
                      ? "等待保存"
                      : "已保存"}
              </div>
            </header>
            {editorView === "locations" ? (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] bg-[var(--paper-inset)] px-5 py-2 text-xs leading-5 text-[var(--ink-muted)]">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--accent-warm)]" />
                  地点库记录故事中实际登场的地点并归属当前空间节点；世界结构层级请在空间树中维护。
                </div>
              <div className="grid min-h-0 flex-1 grid-cols-[17rem_minmax(0,1fr)] max-md:grid-cols-1">
                <aside className="min-h-0 overflow-y-auto border-r border-[var(--line)] max-md:hidden">
                  <header className="flex h-13 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
                    <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2">
                      <Search className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                      <input
                        value={locationQuery}
                        onChange={(event) =>
                          setLocationQuery(event.target.value)
                        }
                        placeholder="搜索当前区域地点"
                        aria-label="搜索当前区域地点"
                        className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void addLocation()}
                      disabled={!currentNode || isSaving}
                      aria-label="新增地点"
                      title="新增地点"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--accent-warm)] text-white disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </header>
                  {filteredNodeLocations.map((location) => {
                    const parent = nodeLocations.find(
                      (item) => item.id === location.parentLocationId,
                    );
                    return (
                      <button
                        key={location.id}
                        type="button"
                        onClick={() => setSelectedLocationId(location.id)}
                        className={`w-full border-b border-[var(--line-subtle)] px-4 py-3 text-left ${
                          selectedLocationId === location.id
                            ? "bg-[var(--accent-warm-subtle)] shadow-[inset_3px_0_0_var(--accent-warm)]"
                            : "hover:bg-[var(--hover-bg)]"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--accent-warm)]" />
                          <strong className="min-w-0 flex-1 truncate text-sm">
                            {location.name}
                          </strong>
                          <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                            {LOCATION_STATUS_LABELS[location.status]}
                          </span>
                        </span>
                        <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                          {parent ? `${parent.name} · ` : ""}
                          {location.type}
                          {location.summary ? ` · ${location.summary}` : ""}
                        </span>
                      </button>
                    );
                  })}
                  {!filteredNodeLocations.length && (
                    <div className="px-4 py-10 text-center text-xs text-[var(--ink-muted)]">
                      {locationQuery.trim()
                        ? "没有匹配的地点"
                        : "当前区域还没有地点"}
                    </div>
                  )}
                </aside>

                {activeLocation ? (
                  <section className="min-h-0 overflow-y-auto px-7 pt-6 pb-24 max-md:px-4">
                    <header className="flex items-start justify-between gap-4 border-b border-[var(--line-subtle)] pb-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                          <MapPin className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                          <span className="truncate">{currentNode?.name}</span>
                        </div>
                        <h2 className="mt-1 truncate text-xl font-semibold">
                          {activeLocation.name}
                        </h2>
                      </div>
                      <button
                        type="button"
                        onClick={() => void saveLocations()}
                        disabled={isSaving || !hasLocationChanges}
                        className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <Save className="h-4 w-4" /> 保存地点
                      </button>
                    </header>
                    <div className="grid max-w-3xl grid-cols-2 gap-5 py-5 max-md:grid-cols-1">
                      <label>
                        <FieldLabel>地点名称</FieldLabel>
                        <input
                          value={activeLocation.name}
                          onChange={(event) =>
                            updateLocation(activeLocation.id, (location) => ({
                              ...location,
                              name: event.target.value,
                            }))
                          }
                          className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm outline-none"
                        />
                      </label>
                      <label>
                        <FieldLabel>地点类型</FieldLabel>
                        <input
                          list="novel-location-types"
                          value={activeLocation.type}
                          onChange={(event) =>
                            updateLocation(activeLocation.id, (location) => ({
                              ...location,
                              type: event.target.value,
                            }))
                          }
                          className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm outline-none"
                        />
                        <datalist id="novel-location-types">
                          {LOCATION_TYPE_OPTIONS.map((type) => (
                            <option key={type} value={type} />
                          ))}
                        </datalist>
                      </label>
                      <label>
                        <FieldLabel>出场状态</FieldLabel>
                        <CustomSelect
                          value={activeLocation.status}
                          options={(
                            Object.keys(
                              LOCATION_STATUS_LABELS,
                            ) as LocationStatus[]
                          ).map((status) => ({
                            value: status,
                            label: LOCATION_STATUS_LABELS[status],
                          }))}
                          onChange={(status) =>
                            updateLocation(activeLocation.id, (location) => ({
                              ...location,
                              status: status as LocationStatus,
                            }))
                          }
                        />
                      </label>
                      <label>
                        <FieldLabel>所属区域</FieldLabel>
                        <CustomSelect
                          value={activeLocation.nodeId}
                          options={locationNodeOptions}
                          onChange={(nodeId) =>
                            updateLocation(activeLocation.id, (location) => ({
                              ...location,
                              nodeId,
                              parentLocationId: null,
                            }))
                          }
                        />
                      </label>
                      <label className="col-span-2 max-md:col-span-1">
                        <FieldLabel>上级地点</FieldLabel>
                        <CustomSelect
                          value={activeLocation.parentLocationId ?? ""}
                          options={locationParentOptions}
                          onChange={(parentLocationId) =>
                            updateLocation(activeLocation.id, (location) => ({
                              ...location,
                              parentLocationId: parentLocationId || null,
                            }))
                          }
                        />
                      </label>
                      <label className="col-span-2 max-md:col-span-1">
                        <FieldLabel>别名</FieldLabel>
                        <input
                          value={activeLocation.aliases.join("、")}
                          placeholder="使用顿号分隔多个别名"
                          onChange={(event) =>
                            updateLocation(activeLocation.id, (location) => ({
                              ...location,
                              aliases: event.target.value
                                .split(/[、,，]/u)
                                .map((alias) => alias.trim())
                                .filter(Boolean),
                            }))
                          }
                          className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm outline-none"
                        />
                      </label>
                      <label className="col-span-2 max-md:col-span-1">
                        <FieldLabel>一句话定位</FieldLabel>
                        <input
                          value={activeLocation.summary}
                          placeholder="例如：青石城最繁华的商业长街"
                          onChange={(event) =>
                            updateLocation(activeLocation.id, (location) => ({
                              ...location,
                              summary: event.target.value,
                            }))
                          }
                          className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm outline-none"
                        />
                      </label>
                      <label className="col-span-2 max-md:col-span-1">
                        <FieldLabel>出场说明</FieldLabel>
                        <input
                          value={activeLocation.appearanceNote}
                          placeholder="例如：第 12 章首次出现，主角在此与林家冲突"
                          onChange={(event) =>
                            updateLocation(activeLocation.id, (location) => ({
                              ...location,
                              appearanceNote: event.target.value,
                            }))
                          }
                          className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm outline-none"
                        />
                      </label>
                      <label className="col-span-2 max-md:col-span-1">
                        <FieldLabel>地点描述</FieldLabel>
                        <textarea
                          rows={10}
                          value={activeLocation.description}
                          onChange={(event) =>
                            updateLocation(activeLocation.id, (location) => ({
                              ...location,
                              description: event.target.value,
                            }))
                          }
                          className="w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm leading-6 outline-none"
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setLocationPendingDeleteId(activeLocation.id)
                      }
                      className="flex items-center gap-1.5 text-sm text-[var(--error)]"
                    >
                      <Trash2 className="h-4 w-4" /> 删除地点
                    </button>
                  </section>
                ) : (
                  <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
                    <div>
                      <MapPin className="mx-auto h-7 w-7 text-[var(--ink-subtle)]" />
                      <h2 className="mt-3 text-sm font-semibold">
                        当前区域还没有地点
                      </h2>
                      <button
                        type="button"
                        onClick={() => void addLocation()}
                        className="mx-auto mt-4 flex h-9 items-center gap-1.5 rounded-md border border-[var(--line)] px-3 text-sm font-medium"
                      >
                        <Plus className="h-4 w-4" /> 新增地点
                      </button>
                    </div>
                  </div>
                )}
              </div>
              </>
            ) : isPageLoading ? (
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--ink-muted)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />{" "}
                正在读取设定页面
              </div>
            ) : !page ? (
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--ink-muted)]">
                请选择或新建设定页面
              </div>
            ) : editorView === "content" ? (
              <MarkdownVisualEditor
                pageId={settingReferenceId(page.reference)}
                label={`${referenceName(page.reference)} Markdown 可视化编辑器`}
                value={draft}
                onChange={(value) => {
                  setDraft(value);
                  setIsDirty(true);
                }}
                onSave={() => void saveCurrentPage()}
              />
            ) : (
              <div className="grid min-h-0 flex-1 grid-cols-[17rem_minmax(0,1fr)] max-md:grid-cols-1">
                <aside className="min-h-0 overflow-y-auto border-r border-[var(--line)] max-md:hidden">
                  <header className="flex h-13 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
                    <div className="min-w-0 flex-1 text-sm font-semibold">
                      当前设定词条
                    </div>
                    <button
                      type="button"
                      onClick={() => void addEntry()}
                      aria-label="新增词条"
                      title="新增词条"
                      className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-warm)] text-white"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </header>
                  {entryDrafts.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedEntryId(entry.id)}
                      className={`w-full border-b border-[var(--line-subtle)] px-4 py-3 text-left ${
                        selectedEntryId === entry.id
                          ? "bg-[var(--accent-warm-subtle)]"
                          : "hover:bg-[var(--hover-bg)]"
                      }`}
                    >
                      <strong className="block truncate text-sm">
                        {entry.name}
                      </strong>
                      <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
                        {entry.category}
                      </span>
                    </button>
                  ))}
                  {!entryDrafts.length && (
                    <div className="px-4 py-10 text-center text-xs text-[var(--ink-muted)]">
                      暂无词条
                    </div>
                  )}
                </aside>
                {activeEntry ? (
                  <section className="min-h-0 overflow-y-auto px-7 pt-6 pb-24 max-md:px-4">
                    <header className="flex items-start justify-between border-b border-[var(--line-subtle)] pb-4">
                      <div>
                        <div className="text-xs text-[var(--ink-muted)]">
                          {currentNode?.name} ·{" "}
                          {page && referenceName(page.reference)}
                        </div>
                        <h2 className="mt-1 text-xl font-semibold">
                          {activeEntry.name}
                        </h2>
                      </div>
                      <button
                        type="button"
                        onClick={() => void saveEntries()}
                        disabled={isSaving}
                        className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)]"
                      >
                        <Save className="h-4 w-4" /> 保存词条
                      </button>
                    </header>
                    <div className="grid max-w-3xl grid-cols-2 gap-5 py-5 max-md:grid-cols-1">
                      <label>
                        <FieldLabel>词条名称</FieldLabel>
                        <input
                          value={activeEntry.name}
                          onChange={(event) =>
                            setEntryDrafts((current) =>
                              current.map((entry) =>
                                entry.id === activeEntry.id
                                  ? { ...entry, name: event.target.value }
                                  : entry,
                              ),
                            )
                          }
                          className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm outline-none"
                        />
                      </label>
                      <label>
                        <FieldLabel>分类</FieldLabel>
                        <CustomSelect
                          value={activeEntry.category}
                          options={[
                            "术语",
                            "地点",
                            "地理现象",
                            "历法",
                            "器物",
                            "组织",
                            "人物",
                          ].map((category) => ({
                            value: category,
                            label: category,
                          }))}
                          onChange={(value) =>
                            setEntryDrafts((current) =>
                              current.map((entry) =>
                                entry.id === activeEntry.id
                                  ? { ...entry, category: value }
                                  : entry,
                              ),
                            )
                          }
                        />
                      </label>
                      <label className="col-span-2 max-md:col-span-1">
                        <FieldLabel>别名</FieldLabel>
                        <input
                          value={activeEntry.aliases.join("、")}
                          placeholder="使用顿号分隔多个别名"
                          onChange={(event) =>
                            setEntryDrafts((current) =>
                              current.map((entry) =>
                                entry.id === activeEntry.id
                                  ? {
                                      ...entry,
                                      aliases: event.target.value
                                        .split(/[、,，]/u)
                                        .map((alias) => alias.trim())
                                        .filter(Boolean),
                                    }
                                  : entry,
                              ),
                            )
                          }
                          className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm outline-none"
                        />
                      </label>
                      <label className="col-span-2 max-md:col-span-1">
                        <FieldLabel>定义</FieldLabel>
                        <textarea
                          rows={10}
                          value={activeEntry.definition}
                          onChange={(event) =>
                            setEntryDrafts((current) =>
                              current.map((entry) =>
                                entry.id === activeEntry.id
                                  ? { ...entry, definition: event.target.value }
                                  : entry,
                              ),
                            )
                          }
                          className="w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm leading-6 outline-none"
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = entryDrafts.filter(
                          (entry) => entry.id !== activeEntry.id,
                        );
                        setEntryDrafts(next);
                        setSelectedEntryId(next[0]?.id ?? "");
                        void saveEntries(next);
                      }}
                      className="flex items-center gap-1.5 text-sm text-[var(--error)]"
                    >
                      <Trash2 className="h-4 w-4" /> 删除词条
                    </button>
                  </section>
                ) : (
                  <div className="flex min-h-0 items-center justify-center p-6 text-center">
                    <div>
                      <NotebookText className="mx-auto h-7 w-7 text-[var(--ink-subtle)]" />
                      <h2 className="mt-3 text-sm font-semibold">
                        当前设定还没有词条
                      </h2>
                      <button
                        type="button"
                        onClick={() => void addEntry()}
                        className="mx-auto mt-4 flex h-9 items-center gap-1.5 rounded-md border border-[var(--line)] px-3 text-sm font-medium"
                      >
                        <Plus className="h-4 w-4" /> 新增词条
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </article>
        </div>

        {settingsDrawer && (
          <button
            type="button"
            aria-label="关闭侧栏"
            onClick={() => setSettingsDrawer(false)}
            className="fixed inset-0 z-30 hidden bg-black/25 max-md:block"
          />
        )}

        {dialog === "node" && (
          <Modal
            eyebrow="自由空间树"
            title={
              nodeParentId === ROOT_PARENT_VALUE ? "新增根节点" : "新增空间节点"
            }
            onClose={() => setDialog(null)}
            footer={
              <>
                <button
                  type="button"
                  onClick={() => setDialog(null)}
                  className="h-9 rounded-md border border-[var(--line)] px-3 text-sm"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void createNode()}
                  disabled={!nodeName.trim() || isSaving}
                  className="h-9 rounded-md bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-45"
                >
                  创建节点
                </button>
              </>
            }
          >
            <div>
              <FieldLabel>父节点</FieldLabel>
              <CustomSelect
                ariaLabel="父节点"
                value={nodeParentId}
                options={parentOptions}
                onChange={changeNodeParent}
                size="md"
              />
              <p className="mt-1.5 text-xs leading-5 text-[var(--ink-muted)]">
                可选择任意现有空间节点，也可将新节点直接放在根层。
              </p>
            </div>
            <label className="block">
              <FieldLabel>节点名称</FieldLabel>
              <input
                value={nodeName}
                aria-label="节点名称"
                onChange={(event) => setNodeName(event.target.value)}
                autoFocus
                className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none"
              />
            </label>
            <label className="block">
              <FieldLabel>层级类型（必选）</FieldLabel>
              <CustomSelect
                value={nodeTypeId}
                options={typeOptions}
                onChange={setNodeTypeId}
                size="md"
              />
            </label>
            <label className="block">
              <FieldLabel>快速创建新类型（可选）</FieldLabel>
              <input
                value={quickTypeName}
                aria-label="快速创建新类型"
                onChange={(event) => setQuickTypeName(event.target.value)}
                placeholder="例如：源界；填写后将覆盖上方选择"
                className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none"
              />
            </label>
            <p className="text-xs leading-5 text-[var(--ink-muted)]">
              类型只提供默认设定模板和新建建议，不限制节点保存在哪一层。
            </p>
          </Modal>
        )}

        {dialog === "change-type" && currentNode && (
          <Modal
            eyebrow="非破坏性变更"
            title={`编辑“${currentNode.name}”`}
            onClose={() => setDialog(null)}
            footer={
              <>
                <button
                  type="button"
                  onClick={() => setNodePendingDelete(currentNode.id)}
                  disabled={isSaving}
                  className="mr-auto h-9 rounded-md border border-[var(--danger)] px-3 text-sm text-[var(--danger)] disabled:opacity-45"
                >
                  删除节点
                </button>
                <button
                  type="button"
                  onClick={() => setDialog(null)}
                  className="h-9 rounded-md border border-[var(--line)] px-3 text-sm"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveNodeEdit()}
                  disabled={!nodeName.trim() || !nodeTypeId || isSaving}
                  className="h-9 rounded-md bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-45"
                >
                  应用更改
                </button>
              </>
            }
          >
            <label className="block">
              <FieldLabel>节点名称</FieldLabel>
              <input
                value={nodeName}
                aria-label="节点名称"
                onChange={(event) => setNodeName(event.target.value)}
                autoFocus
                className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none"
              />
            </label>
            <div>
              <FieldLabel>父节点</FieldLabel>
              <CustomSelect
                ariaLabel="父节点"
                value={nodeParentId}
                options={nodeEditParentOptions}
                onChange={setNodeParentId}
                size="md"
              />
              <p className="mt-1.5 text-xs leading-5 text-[var(--ink-muted)]">
                不能移动到自身或其下级节点下。
              </p>
            </div>
            <label className="block">
              <FieldLabel>层级类型</FieldLabel>
              <CustomSelect
                value={nodeTypeId}
                options={typeOptions}
                onChange={setNodeTypeId}
                size="md"
              />
            </label>
            <div className="rounded-md border border-[var(--line)] bg-[var(--paper-inset)] p-3 text-xs leading-5 text-[var(--ink-muted)]">
              <ShieldCheck className="mb-2 h-4 w-4 text-[var(--success)]" />
              名称和父节点变更不会影响节点
              ID。层级类型会立即决定该节点出现哪些默认模板；当前已经落盘的{" "}
              {
                library.settingsIndex.settings.filter(
                  (setting) => setting.nodeId === currentNode.id,
                ).length
              }{" "}
              份 Markdown 正文和词条将全部保留。
            </div>
          </Modal>
        )}

        {dialog === "setting" && currentNode && (
          <Modal
            eyebrow="突破默认模板"
            title="新增自定义设定"
            onClose={() => setDialog(null)}
            footer={
              <>
                <button
                  type="button"
                  onClick={() => setDialog(null)}
                  className="h-9 rounded-md border border-[var(--line)] px-3 text-sm"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void createSetting()}
                  disabled={!settingName.trim() || isSaving}
                  className="h-9 rounded-md bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-45"
                >
                  创建并编辑
                </button>
              </>
            }
          >
            <label className="block">
              <FieldLabel>设定名称</FieldLabel>
              <input
                value={settingName}
                onChange={(event) => setSettingName(event.target.value)}
                autoFocus
                className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none"
              />
            </label>
            <label className="block">
              <FieldLabel>模板分组</FieldLabel>
              <CustomSelect
                value={settingGroup}
                options={groupOptions}
                onChange={setSettingGroup}
                size="md"
              />
            </label>
            <label className="flex cursor-pointer gap-3 rounded-md border border-[var(--line)] p-3">
              <input
                type="checkbox"
                checked={promoteSetting}
                onChange={(event) => setPromoteSetting(event.target.checked)}
              />
              <span>
                <strong className="block text-sm">
                  同时加入“{currentType?.name}”默认模板
                </strong>
                <small className="mt-1 block text-xs leading-5 text-[var(--ink-muted)]">
                  关闭时只为“{currentNode.name}”创建 Markdown
                  页面；开启后还会创建可编辑模板，并关联到同类型的新节点。
                </small>
              </span>
            </label>
            <div className="flex gap-2 text-xs leading-5 text-[var(--ink-muted)]">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />{" "}
              后续移除默认关联时，这份正文仍会保留为节点设定。
            </div>
          </Modal>
        )}
        {locationPendingDeleteId && (
          <ConfirmDialog
            title="删除地点"
            message="删除后无法恢复。若该地点仍有下级地点，请先为下级地点重新选择上级地点。"
            confirmText="删除地点"
            confirmVariant="danger"
            loading={isSaving}
            onConfirm={() => void deleteLocation()}
            onCancel={() => setLocationPendingDeleteId(null)}
          />
        )}
        {settingPendingDelete && (
          <ConfirmDialog
            title="删除设定页面"
            message={(() => {
              const target = settingPendingDelete;
              if (target.kind !== "instance") return "";
              return target.instance.templateId
                ? `将删除“${target.instance.name}”的正文与词条文件。该页来自默认模板，删除后会重新以虚拟页面出现；可在模板管理中归档模板以隐藏。`
                : `将删除“${target.instance.name}”的正文与词条文件，无法恢复。`;
            })()}
            confirmText="删除页面"
            confirmVariant="danger"
            loading={isSaving}
            onConfirm={() => void deleteSettingPage()}
            onCancel={() => setSettingPendingDelete(null)}
          />
        )}
        {nodePendingDelete && (
          <ConfirmDialog
            title="删除空间节点"
            message="将删除该空间节点。若它仍有下级节点、设定页面、地点或势力地盘引用，删除会被阻止。"
            confirmText="删除节点"
            confirmVariant="danger"
            loading={isSaving}
            onConfirm={() => void deleteNode()}
            onCancel={() => setNodePendingDelete(null)}
          />
        )}
      </div>
    </div>
  );
}
