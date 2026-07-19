import "./ItemLibrary.css";

import {
  Archive,
  ArchiveRestore,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  Coins,
  FileText,
  Filter,
  FlaskConical,
  Folder,
  Gem,
  GitCompareArrows,
  Inbox,
  KeyRound,
  List,
  Loader2,
  Menu,
  PackageOpen,
  PanelLeft,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Sword,
  Swords,
  Tag,
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
  CustomSelect,
  DraggableDialogFrame,
  type SelectOption,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import MarkdownVisualEditor from "./MarkdownVisualEditor";
import ItemLibraryAiDialog from "./ItemLibraryAiDialog";
import ItemBatchProposalReview from "./ItemBatchProposalReview";
import ItemLibraryManagement, {
  createEmptyItemFieldDefinition,
  ItemFieldEditorDialog,
} from "./ItemLibraryManagement";
import { UNCATEGORIZED_ITEM_CATEGORY_ID } from "./itemLibraryDefaults";
import {
  createNovelItemLibraryRepository,
  type LoadedItem,
  type LoadedItemLibrary,
} from "./itemLibraryRepository";
import {
  createItemAiRunRequest,
  parseItemAiOutput,
  type ItemAiMode,
  type ItemAiRunRequest,
  type ItemAiSuggestion,
} from "./itemLibraryAi";
import {
  getCategoryPath,
  getEffectiveCategoryFields,
  getRetainedFieldValues,
  type CategoryFieldDefinition,
  type ItemFieldDefinition,
  type ItemFieldValue,
  type ItemLibraryMeta,
  type ItemRecord,
  type ItemStatus,
} from "./itemLibrarySchema";

type DetailTab = "profile" | "description";
type CategoryFilter = "all" | "archived" | string;

interface ItemLibraryProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
  readonly onAiRun?: (request: ItemAiRunRequest) => Promise<string>;
  readonly onOpenBatchAgent?: (preferredCategoryId?: string) => Promise<void>;
  readonly isBatchAgentLaunching?: boolean;
  readonly proposalReviewOpen?: boolean;
  readonly onOpenProposalReview?: () => void;
  readonly onCloseProposalReview?: () => void;
}

const STATUS_OPTIONS: SelectOption[] = [
  { value: "draft", label: "草稿" },
  { value: "active", label: "启用" },
  { value: "inactive", label: "停用" },
  { value: "lost", label: "遗失" },
  { value: "destroyed", label: "损毁" },
  { value: "archived", label: "已归档" },
];

const FILTER_STATUS_OPTIONS: SelectOption[] = [
  { value: "all", label: "全部状态" },
  ...STATUS_OPTIONS.filter((option) => option.value !== "archived"),
];

const SORT_OPTIONS: SelectOption[] = [
  { value: "updated-desc", label: "最近修改" },
  { value: "name-asc", label: "名称排序" },
  { value: "status-asc", label: "状态排序" },
];

const CATEGORY_ICONS: Readonly<Record<string, LucideIcon>> = {
  inbox: Inbox,
  swords: Swords,
  sword: Sword,
  gem: Gem,
  "flask-conical": FlaskConical,
  "key-round": KeyRound,
  coins: Coins,
  folder: Folder,
  "move-up-right": Sword,
};

function uniqueId(prefix: string): string {
  const token =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36);
  return `${prefix}-${token}`;
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusLabel(status: ItemStatus): string {
  return (
    STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status
  );
}

function statusTone(status: ItemStatus): string {
  if (status === "active") return "text-[var(--success)]";
  if (status === "destroyed") return "text-[var(--error)]";
  if (status === "lost") return "text-[var(--warning)]";
  return "text-[var(--ink-muted)]";
}

function splitTerms(value: string): string[] {
  return value
    .split(/[，,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function descendantCategoryIds(
  meta: ItemLibraryMeta,
  categoryId: string,
): ReadonlySet<string> {
  const result = new Set<string>([categoryId]);
  const visit = (parentId: string) => {
    meta.categories
      .filter((category) => category.parentId === parentId)
      .forEach((category) => {
        result.add(category.id);
        visit(category.id);
      });
  };
  visit(categoryId);
  return result;
}

function isSelectableCategory(
  meta: ItemLibraryMeta,
  categoryId: string,
): boolean {
  return meta.categories.some(
    (category) => category.id === categoryId && !category.archived,
  );
}

function createCategoryIdForSelection(
  meta: ItemLibraryMeta,
  preferredCategoryId: string,
): string {
  if (isSelectableCategory(meta, preferredCategoryId))
    return preferredCategoryId;
  if (isSelectableCategory(meta, UNCATEGORIZED_ITEM_CATEGORY_ID)) {
    return UNCATEGORIZED_ITEM_CATEGORY_ID;
  }
  return meta.categories.find((category) => !category.archived)?.id ?? "";
}

function fieldValueLabel(value: ItemFieldValue): string {
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null) return "";
  return String(value);
}

export default function ItemLibrary({
  storage,
  projectTitle,
  isActive,
  onAiRun,
  onOpenBatchAgent,
  isBatchAgentLaunching = false,
  proposalReviewOpen = false,
  onOpenProposalReview,
  onCloseProposalReview,
}: ItemLibraryProps) {
  const repository = useMemo(
    () => createNovelItemLibraryRepository(storage),
    [storage],
  );
  const [library, setLibrary] = useState<LoadedItemLibrary | null>(null);
  const [item, setItem] = useState<LoadedItem | null>(null);
  const [recordDraft, setRecordDraft] = useState<ItemRecord | null>(null);
  const [pageDraft, setPageDraft] = useState("");
  const [aliasesText, setAliasesText] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectedCategory, setSelectedCategory] =
    useState<CategoryFilter>("all");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(["weapons", "polearms"]),
  );
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("updated-desc");
  const [detailTab, setDetailTab] = useState<DetailTab>("profile");
  const [isLoading, setIsLoading] = useState(true);
  const [isItemLoading, setIsItemLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managementMode, setManagementMode] = useState(false);
  const [createDialog, setCreateDialog] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCategoryId, setCreateCategoryId] = useState(
    UNCATEGORIZED_ITEM_CATEGORY_ID,
  );
  const [itemFieldEditor, setItemFieldEditor] = useState<{
    readonly definition: ItemFieldDefinition;
    readonly existingId: string | null;
  } | null>(null);
  const [isAiRunning, setIsAiRunning] = useState<ItemAiMode | null>(null);
  const [aiSuggestion, setAiSuggestion] = useState<ItemAiSuggestion | null>(
    null,
  );
  const [categoryDrawer, setCategoryDrawer] = useState(false);
  const [listDrawer, setListDrawer] = useState(false);

  const libraryRef = useRef(library);
  const itemRef = useRef(item);
  const selectedItemIdRef = useRef(selectedItemId);
  const selectedCategoryRef = useRef(selectedCategory);
  const recordDraftRef = useRef(recordDraft);
  const pageDraftRef = useRef(pageDraft);
  const dirtyRef = useRef(isDirty);
  const editVersionRef = useRef(0);
  const openTokenRef = useRef(0);
  const aiRequestTokenRef = useRef(0);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    libraryRef.current = library;
  }, [library]);
  useEffect(() => {
    itemRef.current = item;
  }, [item]);
  useEffect(() => {
    selectedItemIdRef.current = selectedItemId;
  }, [selectedItemId]);
  useEffect(() => {
    selectedCategoryRef.current = selectedCategory;
  }, [selectedCategory]);
  useEffect(() => {
    recordDraftRef.current = recordDraft;
  }, [recordDraft]);
  useEffect(() => {
    pageDraftRef.current = pageDraft;
  }, [pageDraft]);
  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);

  const readItem = useCallback(
    async (activeLibrary: LoadedItemLibrary, itemId: string) => {
      const token = ++openTokenRef.current;
      aiRequestTokenRef.current += 1;
      setIsAiRunning(null);
      setAiSuggestion(null);
      const entry = activeLibrary.index.items.find(
        (candidate) => candidate.id === itemId,
      );
      if (!entry) {
        setSelectedItemId("");
        selectedItemIdRef.current = "";
        setItem(null);
        setRecordDraft(null);
        setPageDraft("");
        setAliasesText("");
        setTagsText("");
        setIsDirty(false);
        return;
      }
      setSelectedItemId(itemId);
      selectedItemIdRef.current = itemId;
      setIsItemLoading(true);
      setError(null);
      try {
        const loaded = await repository.loadItem(entry);
        if (token !== openTokenRef.current) return;
        itemRef.current = loaded;
        recordDraftRef.current = loaded.record;
        pageDraftRef.current = loaded.pageContent;
        setItem(loaded);
        setRecordDraft(loaded.record);
        setPageDraft(loaded.pageContent);
        setAliasesText(loaded.record.aliases.join("，"));
        setTagsText(loaded.record.tags.join("，"));
        setIsDirty(false);
        editVersionRef.current = 0;
      } catch (cause) {
        if (token === openTokenRef.current) setError(toError(cause));
      } finally {
        if (token === openTokenRef.current) setIsItemLoading(false);
      }
    },
    [repository],
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await repository.load();
      libraryRef.current = next;
      setLibrary(next);
      const currentCategory = selectedCategoryRef.current;
      if (
        currentCategory !== "all" &&
        currentCategory !== "archived" &&
        !isSelectableCategory(next.meta, currentCategory)
      ) {
        setSelectedCategory("all");
      }
      const currentSelectedId = selectedItemIdRef.current;
      const targetId = next.index.items.some(
        (candidate) => candidate.id === currentSelectedId,
      )
        ? currentSelectedId
        : (next.index.items[0]?.id ?? "");
      await readItem(next, targetId);
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsLoading(false);
    }
  }, [readItem, repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const markRecord = (update: (record: ItemRecord) => ItemRecord) => {
    setRecordDraft((current) => {
      if (!current) return current;
      const next = update(current);
      recordDraftRef.current = next;
      return next;
    });
    editVersionRef.current += 1;
    dirtyRef.current = true;
    setIsDirty(true);
  };

  const markPage = (content: string) => {
    pageDraftRef.current = content;
    setPageDraft(content);
    editVersionRef.current += 1;
    dirtyRef.current = true;
    setIsDirty(true);
  };

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    const activeLibrary = libraryRef.current;
    const activeItem = itemRef.current;
    const activeRecord = recordDraftRef.current;
    if (!dirtyRef.current || !activeLibrary || !activeItem || !activeRecord) {
      return true;
    }
    const version = editVersionRef.current;
    const content = pageDraftRef.current;
    const operation = (async () => {
      setIsSaving(true);
      setError(null);
      try {
        const result = await repository.saveItem(
          activeLibrary,
          activeItem,
          activeRecord,
          content,
        );
        libraryRef.current = result.library;
        itemRef.current = result.item;
        setLibrary(result.library);
        setItem(result.item);
        if (version === editVersionRef.current) {
          recordDraftRef.current = result.item.record;
          pageDraftRef.current = result.item.pageContent;
          dirtyRef.current = false;
          setRecordDraft(result.item.record);
          setPageDraft(result.item.pageContent);
          setIsDirty(false);
        }
        return true;
      } catch (cause) {
        setError(toError(cause));
        setIsDirty(true);
        dirtyRef.current = true;
        return false;
      } finally {
        setIsSaving(false);
      }
    })();
    savePromiseRef.current = operation;
    const trackedOperation = operation.finally(() => {
      if (savePromiseRef.current === trackedOperation) {
        savePromiseRef.current = null;
      }
    });
    savePromiseRef.current = trackedOperation;
    return trackedOperation;
  }, [repository]);

  const flushCurrentDraft = useCallback(async (): Promise<boolean> => {
    while (dirtyRef.current) {
      if (!(await saveCurrent())) return false;
    }
    return true;
  }, [saveCurrent]);

  const reloadSafely = useCallback(async () => {
    if (await flushCurrentDraft()) await load();
  }, [flushCurrentDraft, load]);

  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (isActive && !wasActiveRef.current) void reloadSafely();
    wasActiveRef.current = isActive;
  }, [isActive, reloadSafely]);

  useEffect(
    () => () => {
      if (dirtyRef.current) void flushCurrentDraft();
    },
    [flushCurrentDraft],
  );

  useEffect(() => {
    if (!isDirty || isSaving || !recordDraft) return;
    const timer = window.setTimeout(() => void saveCurrent(), 850);
    return () => window.clearTimeout(timer);
  }, [isDirty, isSaving, pageDraft, recordDraft, saveCurrent]);

  const selectItem = async (itemId: string) => {
    if (itemId === selectedItemId) {
      setListDrawer(false);
      return;
    }
    if (!(await flushCurrentDraft())) return;
    const activeLibrary = libraryRef.current;
    if (activeLibrary) await readItem(activeLibrary, itemId);
    setListDrawer(false);
  };

  const categoryOptions = useMemo<SelectOption[]>(() => {
    if (!library) return [];
    return library.meta.categories
      .filter(
        (category) =>
          !category.archived || category.id === recordDraft?.categoryId,
      )
      .sort((left, right) => left.order - right.order)
      .map((category) => ({
        value: category.id,
        label: getCategoryPath(library.meta, category.id),
      }));
  }, [library, recordDraft?.categoryId]);

  const filteredItems = useMemo(() => {
    if (!library) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    const selectedIds =
      selectedCategory === "all" || selectedCategory === "archived"
        ? null
        : descendantCategoryIds(library.meta, selectedCategory);
    const result = library.index.items.filter((entry) => {
      if (selectedCategory === "archived") {
        if (entry.status !== "archived") return false;
      } else if (entry.status === "archived") {
        return false;
      }
      if (selectedIds && !selectedIds.has(entry.categoryId)) return false;
      if (statusFilter !== "all" && entry.status !== statusFilter) return false;
      return (
        !normalizedQuery ||
        `${entry.name} ${entry.summary} ${entry.tags.join(" ")}`
          .toLocaleLowerCase("zh-CN")
          .includes(normalizedQuery)
      );
    });
    return [...result].sort((left, right) => {
      if (sort === "name-asc")
        return left.name.localeCompare(right.name, "zh-CN");
      if (sort === "status-asc") {
        return (
          left.status.localeCompare(right.status) ||
          left.name.localeCompare(right.name, "zh-CN")
        );
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }, [library, query, selectedCategory, sort, statusFilter]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!library) return counts;
    library.meta.categories.forEach((category) => {
      const ids = descendantCategoryIds(library.meta, category.id);
      counts.set(
        category.id,
        library.index.items.filter(
          (itemEntry) =>
            itemEntry.status !== "archived" && ids.has(itemEntry.categoryId),
        ).length,
      );
    });
    return counts;
  }, [library]);

  const createItem = async () => {
    const name = createName.trim();
    if (!name || !(await flushCurrentDraft())) return;
    const activeLibrary = libraryRef.current;
    if (!activeLibrary) return;
    setIsSaving(true);
    setError(null);
    try {
      const result = await repository.createItem(activeLibrary, {
        id: uniqueId("item"),
        name,
        categoryId: createCategoryId,
      });
      libraryRef.current = result.library;
      itemRef.current = result.item;
      recordDraftRef.current = result.item.record;
      pageDraftRef.current = result.item.pageContent;
      setLibrary(result.library);
      setItem(result.item);
      setRecordDraft(result.item.record);
      setPageDraft(result.item.pageContent);
      setAliasesText("");
      setTagsText("");
      setSelectedItemId(result.item.record.id);
      selectedItemIdRef.current = result.item.record.id;
      aiRequestTokenRef.current += 1;
      setIsAiRunning(null);
      setAiSuggestion(null);
      setSelectedCategory(createCategoryId);
      setCreateDialog(false);
      setCreateName("");
      setIsDirty(false);
      setListDrawer(false);
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const openManagement = async () => {
    if (await flushCurrentDraft()) {
      aiRequestTokenRef.current += 1;
      setIsAiRunning(null);
      setAiSuggestion(null);
      setManagementMode(true);
    }
  };

  const runItemAi = async (mode: ItemAiMode) => {
    if (!onAiRun || isAiRunning || !(await flushCurrentDraft())) return;
    const activeLibrary = libraryRef.current;
    const activeRecord = recordDraftRef.current;
    if (!activeLibrary || !activeRecord) return;
    const token = ++aiRequestTokenRef.current;
    const context = {
      projectTitle,
      categoryPath: getCategoryPath(
        activeLibrary.meta,
        activeRecord.categoryId,
      ),
      record: activeRecord,
      pageContent: pageDraftRef.current,
      categoryFields: getEffectiveCategoryFields(
        activeLibrary.meta,
        activeRecord.categoryId,
      ),
    };
    const baseEditVersion = editVersionRef.current;
    setIsAiRunning(mode);
    setAiSuggestion(null);
    setError(null);
    try {
      const request = createItemAiRunRequest(mode, context);
      const output = await onAiRun(request);
      if (
        token !== aiRequestTokenRef.current ||
        recordDraftRef.current?.id !== activeRecord.id ||
        editVersionRef.current !== baseEditVersion
      ) {
        if (token === aiRequestTokenRef.current) {
          setError("物品在 AI 生成期间已修改，请重新生成建议");
        }
        return;
      }
      setAiSuggestion(parseItemAiOutput(mode, output, context));
    } catch (cause) {
      if (token === aiRequestTokenRef.current) setError(toError(cause));
    } finally {
      if (token === aiRequestTokenRef.current) setIsAiRunning(null);
    }
  };

  const launchBatchAgent = async () => {
    if (
      !onOpenBatchAgent ||
      isBatchAgentLaunching ||
      !(await flushCurrentDraft())
    ) {
      return;
    }
    const preferredCategoryId =
      selectedCategory !== "all" && selectedCategory !== "archived"
        ? selectedCategory
        : recordDraftRef.current?.categoryId;
    setError(null);
    try {
      await onOpenBatchAgent(preferredCategoryId);
    } catch (cause) {
      setError(toError(cause));
    }
  };

  const openProposalReview = async () => {
    if (await flushCurrentDraft()) onOpenProposalReview?.();
  };

  const saveMeta = async (meta: ItemLibraryMeta) => {
    const activeLibrary = libraryRef.current;
    if (!activeLibrary) return;
    setIsSaving(true);
    setError(null);
    try {
      const next = await repository.saveMeta(activeLibrary, meta);
      libraryRef.current = next;
      setLibrary(next);
      const currentCategory = selectedCategoryRef.current;
      if (
        currentCategory !== "all" &&
        currentCategory !== "archived" &&
        !isSelectableCategory(next.meta, currentCategory)
      ) {
        setSelectedCategory("all");
      }
    } catch (cause) {
      setError(toError(cause));
      throw cause;
    } finally {
      setIsSaving(false);
    }
  };

  const openCreateDialog = (preferredCategoryId = selectedCategory) => {
    const activeMeta = libraryRef.current?.meta;
    if (!activeMeta) return;
    setCreateCategoryId(
      createCategoryIdForSelection(activeMeta, preferredCategoryId),
    );
    setCreateDialog(true);
  };

  if (isLoading && !library) {
    return <LibraryLoadingState />;
  }
  if (!library) {
    return <LibraryErrorState error={error} onRetry={() => void load()} />;
  }
  if (managementMode) {
    return (
      <ItemLibraryManagement
        library={library}
        isSaving={isSaving}
        onSave={saveMeta}
        onClose={() => setManagementMode(false)}
      />
    );
  }

  const activeCategory =
    selectedCategory === "all"
      ? "全部物品"
      : selectedCategory === "archived"
        ? "已归档"
        : (library.meta.categories.find(
            (category) => category.id === selectedCategory,
          )?.name ?? "全部物品");
  const categoryFields = recordDraft
    ? getEffectiveCategoryFields(library.meta, recordDraft.categoryId)
    : [];
  const itemFields =
    recordDraft?.itemFields
      .filter((field) => !field.archived)
      .sort((left, right) => left.order - right.order) ?? [];
  const retainedValues = recordDraft
    ? getRetainedFieldValues(library.meta, recordDraft)
    : [];

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--paper)]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4">
        <div className="flex min-w-0 items-center gap-3">
          <PackageOpen className="h-5 w-5 shrink-0 text-[var(--accent-warm)]" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">物品库</h1>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              {projectTitle} · {library.index.items.length} 件物品
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void openProposalReview()}
            disabled={!onOpenProposalReview || isSaving}
            aria-label="审阅批量物品提案"
            title="审阅批量物品提案"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-45"
          >
            <GitCompareArrows className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void launchBatchAgent()}
            disabled={!onOpenBatchAgent || isBatchAgentLaunching || isSaving}
            aria-label="AI 批量生产物品"
            title={
              onOpenBatchAgent
                ? "AI 批量生产物品"
                : "当前环境不可使用 MyAgents Agent"
            }
            className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-45"
          >
            {isBatchAgentLaunching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
            )}
            <span className="max-sm:hidden">
              {isBatchAgentLaunching ? "启动中" : "AI 批量生产"}
            </span>
          </button>
          <button
            type="button"
            onClick={() => openCreateDialog()}
            className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-2.5 text-xs font-medium text-white hover:brightness-105"
          >
            <Plus className="h-4 w-4" /> 新建物品
          </button>
        </div>
      </header>

      {error && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--error-bg)] px-4 py-2 text-xs text-[var(--error)]">
          <span className="min-w-0 truncate">{error}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              void reloadSafely();
            }}
            className="shrink-0 underline underline-offset-2"
          >
            重新读取
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside
          className={`z-30 flex w-56 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)] max-lg:absolute max-lg:inset-y-0 max-lg:left-0 max-lg:shadow-xl ${
            categoryDrawer ? "max-lg:flex" : "max-lg:hidden"
          }`}
        >
          <div className="flex h-12 items-center justify-between border-b border-[var(--line)] px-3">
            <span className="text-xs font-semibold text-[var(--ink-muted)]">
              分类
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void openManagement()}
                aria-label="分类与字段管理"
                title="分类与字段管理"
                className="management-icon-button"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setCategoryDrawer(false)}
                aria-label="关闭分类栏"
                title="关闭"
                className="hidden h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] max-lg:flex"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <CategoryFilterButton
              active={selectedCategory === "all"}
              icon={PackageOpen}
              label="全部物品"
              count={
                library.index.items.filter(
                  (entry) => entry.status !== "archived",
                ).length
              }
              onClick={() => {
                setSelectedCategory("all");
                setCategoryDrawer(false);
              }}
            />
            <CategoryFilterButton
              active={selectedCategory === "archived"}
              icon={Archive}
              label="已归档"
              count={
                library.index.items.filter(
                  (entry) => entry.status === "archived",
                ).length
              }
              onClick={() => {
                setSelectedCategory("archived");
                setStatusFilter("all");
                setCategoryDrawer(false);
              }}
            />
            <div className="my-2 border-t border-[var(--line-subtle)]" />
            <div role="tree">
              <CategoryTree
                meta={library.meta}
                parentId={null}
                selectedId={selectedCategory}
                expanded={expandedCategories}
                counts={categoryCounts}
                onToggle={(id) =>
                  setExpandedCategories((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onSelect={(id) => {
                  setSelectedCategory(id);
                  setCategoryDrawer(false);
                }}
              />
            </div>
          </div>
        </aside>

        <section
          className={`z-20 flex w-[330px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper)] max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:w-[min(330px,92vw)] max-md:shadow-xl ${
            listDrawer || !recordDraft ? "max-md:flex" : "max-md:hidden"
          }`}
        >
          <div className="border-b border-[var(--line)] p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setCategoryDrawer(true)}
                  aria-label="打开分类栏"
                  title="打开分类栏"
                  className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] max-lg:flex"
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
                <h2 className="truncate text-sm font-semibold">
                  {activeCategory}
                </h2>
                <span className="text-xs text-[var(--ink-muted)]">
                  {filteredItems.length}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setListDrawer(false)}
                aria-label="关闭物品列表"
                title="关闭"
                className="hidden h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] max-md:flex"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-subtle)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称、标签、摘要"
                aria-label="搜索物品"
                className="item-library-input h-8 min-h-8 pl-8 pr-8 text-xs"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="清除搜索"
                  title="清除"
                  className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <CustomSelect
                value={statusFilter}
                options={FILTER_STATUS_OPTIONS}
                onChange={setStatusFilter}
                ariaLabel="状态筛选"
                triggerIcon={<Filter className="h-3.5 w-3.5" />}
                compact
              />
              <CustomSelect
                value={sort}
                options={SORT_OPTIONS}
                onChange={setSort}
                ariaLabel="物品排序"
                triggerIcon={<ChevronsUpDown className="h-3.5 w-3.5" />}
                compact
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {filteredItems.length === 0 ? (
              <div className="flex h-full min-h-52 flex-col items-center justify-center px-6 text-center">
                <Box className="h-7 w-7 text-[var(--ink-subtle)]" />
                <p className="mt-3 text-sm text-[var(--ink-muted)]">
                  {query ? "没有匹配的物品" : "此处暂无物品"}
                </p>
                {!query && selectedCategory !== "archived" && (
                  <button
                    type="button"
                    onClick={() => openCreateDialog()}
                    className="mt-3 flex items-center gap-1 text-xs font-medium text-[var(--accent-warm)]"
                  >
                    <Plus className="h-3.5 w-3.5" /> 新建物品
                  </button>
                )}
              </div>
            ) : (
              filteredItems.map((entry) => {
                const category = library.meta.categories.find(
                  (candidate) => candidate.id === entry.categoryId,
                );
                const CategoryIcon =
                  CATEGORY_ICONS[category?.icon ?? ""] ?? Box;
                return (
                  <button
                    type="button"
                    key={entry.id}
                    onClick={() => void selectItem(entry.id)}
                    className={`group flex w-full items-start gap-3 border-b border-[var(--line-subtle)] px-3 py-3 text-left transition-colors ${
                      selectedItemId === entry.id
                        ? "bg-[var(--selected-bg)]"
                        : "hover:bg-[var(--hover-bg)]"
                    }`}
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--line-subtle)] bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
                      <CategoryIcon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-[var(--ink)]">
                          {entry.name}
                        </span>
                        <span
                          className={`shrink-0 text-xs ${statusTone(entry.status)}`}
                        >
                          {statusLabel(entry.status)}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                        {entry.summary || category?.name || "未分类"}
                      </span>
                      {entry.tags.length > 0 && (
                        <span className="mt-1.5 flex min-w-0 items-center gap-1 text-xs text-[var(--ink-subtle)]">
                          <Tag className="h-3 w-3 shrink-0" />
                          <span className="truncate">
                            {entry.tags.join(" · ")}
                          </span>
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <main className="flex min-w-0 flex-1 flex-col bg-[var(--paper)]">
          {isItemLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--ink-muted)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 读取物品
            </div>
          ) : !recordDraft || !item ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <PackageOpen className="h-9 w-9 text-[var(--ink-subtle)]" />
              <p className="mt-3 text-sm text-[var(--ink-muted)]">
                尚未选择物品
              </p>
              <button
                type="button"
                onClick={() => setListDrawer(true)}
                className="mt-3 hidden items-center gap-1.5 rounded-md border border-[var(--line)] px-3 py-2 text-xs max-md:flex"
              >
                <List className="h-3.5 w-3.5" /> 打开物品列表
              </button>
            </div>
          ) : (
            <>
              <div className="shrink-0 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-5 pt-4 max-sm:px-3">
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => setListDrawer(true)}
                    aria-label="打开物品列表"
                    title="打开物品列表"
                    className="mt-0.5 hidden h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] max-md:flex"
                  >
                    <Menu className="h-4 w-4" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <input
                      value={recordDraft.name}
                      onChange={(event) =>
                        markRecord((record) => ({
                          ...record,
                          name: event.target.value,
                        }))
                      }
                      aria-label="物品名称"
                      className="w-full border-0 bg-transparent p-0 text-xl font-semibold text-[var(--ink)] outline-none"
                    />
                    <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-[var(--ink-muted)]">
                      <span className="truncate">
                        {getCategoryPath(library.meta, recordDraft.categoryId)}
                      </span>
                      <ChevronRight className="h-3 w-3 shrink-0" />
                      <span className={statusTone(recordDraft.status)}>
                        {statusLabel(recordDraft.status)}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void runItemAi(
                          detailTab === "profile" ? "profile" : "description",
                        )
                      }
                      disabled={!onAiRun || isAiRunning !== null || isSaving}
                      aria-label={
                        detailTab === "profile" ? "AI 完善资料" : "AI 撰写描述"
                      }
                      title={
                        onAiRun
                          ? detailTab === "profile"
                            ? "AI 完善资料"
                            : "AI 撰写描述"
                          : "当前环境不可使用 AI 生成"
                      }
                      className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {isAiRunning ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                      )}
                      <span className="max-sm:hidden">
                        {isAiRunning
                          ? "生成中"
                          : detailTab === "profile"
                            ? "AI 完善"
                            : "AI 撰写"}
                      </span>
                    </button>
                    <span className="flex items-center gap-1 text-xs text-[var(--ink-muted)] max-sm:hidden">
                      {isSaving ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : isDirty ? (
                        <CircleAlert className="h-3 w-3 text-[var(--warning)]" />
                      ) : (
                        <Check className="h-3 w-3 text-[var(--success)]" />
                      )}
                      {isSaving ? "保存中" : isDirty ? "待保存" : "已保存"}
                    </span>
                    <button
                      type="button"
                      onClick={() => void saveCurrent()}
                      disabled={
                        !isDirty || isSaving || !recordDraft.name.trim()
                      }
                      aria-label="保存物品"
                      title="保存"
                      className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--line)] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Save className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-4 flex h-9 items-end gap-1" role="tablist">
                  <DetailTabButton
                    active={detailTab === "profile"}
                    icon={SlidersHorizontal}
                    label="资料"
                    onClick={() => setDetailTab("profile")}
                  />
                  <DetailTabButton
                    active={detailTab === "description"}
                    icon={FileText}
                    label="描述"
                    onClick={() => setDetailTab("description")}
                  />
                </div>
              </div>

              {detailTab === "description" ? (
                <MarkdownVisualEditor
                  pageId={recordDraft.id}
                  label={`${recordDraft.name}详细描述`}
                  value={pageDraft}
                  onChange={markPage}
                  onSave={() => void saveCurrent()}
                  placeholder="记录物品来历、外观、能力、限制和剧情变化……"
                  fullWidth
                />
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto max-w-4xl px-6 py-6 max-sm:px-4">
                    <ProfileSection title="基础信息">
                      <div className="grid grid-cols-2 gap-x-5 gap-y-4 max-lg:grid-cols-1">
                        <FieldLabel label="主分类">
                          <CustomSelect
                            value={recordDraft.categoryId}
                            options={categoryOptions}
                            onChange={(categoryId) =>
                              markRecord((record) => ({
                                ...record,
                                categoryId,
                              }))
                            }
                            ariaLabel="主分类"
                            size="toolbar"
                          />
                        </FieldLabel>
                        <FieldLabel label="状态">
                          <CustomSelect
                            value={recordDraft.status}
                            options={STATUS_OPTIONS}
                            onChange={(status) =>
                              markRecord((record) => ({
                                ...record,
                                status: status as ItemStatus,
                              }))
                            }
                            ariaLabel="物品状态"
                            size="toolbar"
                          />
                        </FieldLabel>
                        <FieldLabel label="别名">
                          <input
                            value={aliasesText}
                            onChange={(event) => {
                              setAliasesText(event.target.value);
                              markRecord((record) => ({
                                ...record,
                                aliases: splitTerms(event.target.value),
                              }));
                            }}
                            placeholder="多个别名用逗号分隔"
                            className="item-library-input"
                          />
                        </FieldLabel>
                        <FieldLabel label="标签">
                          <input
                            value={tagsText}
                            onChange={(event) => {
                              setTagsText(event.target.value);
                              markRecord((record) => ({
                                ...record,
                                tags: splitTerms(event.target.value),
                              }));
                            }}
                            placeholder="多个标签用逗号分隔"
                            className="item-library-input"
                          />
                        </FieldLabel>
                        <FieldLabel
                          label="封面路径"
                          className="col-span-2 max-lg:col-span-1"
                        >
                          <input
                            value={recordDraft.coverPath ?? ""}
                            onChange={(event) =>
                              markRecord((record) => ({
                                ...record,
                                coverPath: event.target.value.trim() || null,
                              }))
                            }
                            placeholder="assets/images/..."
                            className="item-library-input font-mono"
                          />
                        </FieldLabel>
                        <FieldLabel
                          label="摘要"
                          className="col-span-2 max-lg:col-span-1"
                        >
                          <textarea
                            value={recordDraft.summary}
                            onChange={(event) =>
                              markRecord((record) => ({
                                ...record,
                                summary: event.target.value,
                              }))
                            }
                            rows={3}
                            className="item-library-input resize-y"
                          />
                        </FieldLabel>
                      </div>
                    </ProfileSection>

                    <ProfileSection
                      title="分类字段"
                      suffix={`${categoryFields.length} 项`}
                    >
                      {categoryFields.length === 0 ? (
                        <EmptyFieldSection text="当前分类没有扩展字段" />
                      ) : (
                        <FieldGrid>
                          {categoryFields.map((field) => (
                            <DefinitionField
                              key={field.id}
                              definition={field}
                              source={
                                library.meta.categories.find(
                                  (category) =>
                                    category.id === field.ownerCategoryId,
                                )?.name
                              }
                              value={
                                recordDraft.values[field.id] ??
                                field.defaultValue
                              }
                              onChange={(value) =>
                                markRecord((record) => ({
                                  ...record,
                                  values: {
                                    ...record.values,
                                    [field.id]: value,
                                  },
                                }))
                              }
                            />
                          ))}
                        </FieldGrid>
                      )}
                    </ProfileSection>

                    <ProfileSection
                      title="仅此物品字段"
                      suffix={`${itemFields.length} 项`}
                      action={
                        <button
                          type="button"
                          onClick={() => {
                            const maximumOrder = recordDraft.itemFields.reduce(
                              (maximum, field) =>
                                Math.max(maximum, field.order),
                              0,
                            );
                            setItemFieldEditor({
                              definition: {
                                ...createEmptyItemFieldDefinition(),
                                order: maximumOrder + 10,
                              },
                              existingId: null,
                            });
                          }}
                          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        >
                          <Plus className="h-3.5 w-3.5" /> 添加字段
                        </button>
                      }
                    >
                      {itemFields.length === 0 ? (
                        <EmptyFieldSection text="暂无仅用于此物品的字段" />
                      ) : (
                        <FieldGrid>
                          {itemFields.map((field) => (
                            <DefinitionField
                              key={field.id}
                              definition={field}
                              value={
                                recordDraft.values[field.id] ??
                                field.defaultValue
                              }
                              actions={
                                <>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setItemFieldEditor({
                                        definition: { ...field },
                                        existingId: field.id,
                                      })
                                    }
                                    className="rounded px-1.5 py-0.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                                  >
                                    编辑
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      markRecord((record) => ({
                                        ...record,
                                        itemFields: record.itemFields.map(
                                          (candidate) =>
                                            candidate.id === field.id
                                              ? { ...candidate, archived: true }
                                              : candidate,
                                        ),
                                      }))
                                    }
                                    aria-label={`归档字段${field.label}`}
                                    title="归档字段"
                                    className="flex h-6 w-6 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                                  >
                                    <Archive className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              }
                              onChange={(value) =>
                                markRecord((record) => ({
                                  ...record,
                                  values: {
                                    ...record.values,
                                    [field.id]: value,
                                  },
                                }))
                              }
                            />
                          ))}
                        </FieldGrid>
                      )}
                    </ProfileSection>

                    {retainedValues.length > 0 && (
                      <ProfileSection
                        title="保留字段"
                        suffix={`${retainedValues.length} 项`}
                        tone="retained"
                      >
                        <FieldGrid>
                          {retainedValues.map(({ fieldId, value }) => {
                            const itemDefinition = recordDraft.itemFields.find(
                              (field) => field.id === fieldId,
                            );
                            const definition =
                              library.meta.fields.find(
                                (field) => field.id === fieldId,
                              ) ?? itemDefinition;
                            return definition ? (
                              <DefinitionField
                                key={fieldId}
                                definition={definition}
                                source={
                                  itemDefinition?.archived
                                    ? "已归档 · 仅此物品"
                                    : "来自原分类"
                                }
                                value={value}
                                actions={
                                  itemDefinition?.archived ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        markRecord((record) => ({
                                          ...record,
                                          itemFields: record.itemFields.map(
                                            (field) =>
                                              field.id === fieldId
                                                ? { ...field, archived: false }
                                                : field,
                                          ),
                                        }))
                                      }
                                      className="flex h-6 items-center gap-1 rounded px-1.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                                    >
                                      <ArchiveRestore className="h-3.5 w-3.5" />
                                      恢复
                                    </button>
                                  ) : undefined
                                }
                                onChange={(nextValue) =>
                                  markRecord((record) => ({
                                    ...record,
                                    values: {
                                      ...record.values,
                                      [fieldId]: nextValue,
                                    },
                                  }))
                                }
                              />
                            ) : (
                              <FieldLabel
                                key={fieldId}
                                label={fieldId}
                                hint="未知字段定义"
                              >
                                <input
                                  value={fieldValueLabel(value)}
                                  onChange={(event) =>
                                    markRecord((record) => ({
                                      ...record,
                                      values: {
                                        ...record.values,
                                        [fieldId]: event.target.value,
                                      },
                                    }))
                                  }
                                  className="item-library-input"
                                />
                              </FieldLabel>
                            );
                          })}
                        </FieldGrid>
                      </ProfileSection>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {(categoryDrawer || listDrawer) && (
        <button
          type="button"
          aria-label="关闭侧栏"
          onClick={() => {
            setCategoryDrawer(false);
            setListDrawer(false);
          }}
          className="absolute inset-0 z-10 hidden bg-black/25 max-lg:block"
        />
      )}

      {createDialog && (
        <CreateItemDialog
          name={createName}
          categoryId={createCategoryId}
          categoryOptions={categoryOptions.filter(
            (option) =>
              !library.meta.categories.find(
                (category) => category.id === option.value,
              )?.archived,
          )}
          isSaving={isSaving}
          onNameChange={setCreateName}
          onCategoryChange={setCreateCategoryId}
          onSubmit={() => void createItem()}
          onClose={() => {
            setCreateDialog(false);
            setCreateName("");
          }}
        />
      )}

      {itemFieldEditor && recordDraft && (
        <ItemFieldEditorDialog
          title={itemFieldEditor.existingId ? "编辑物品字段" : "新增物品字段"}
          definition={itemFieldEditor.definition}
          lockType={itemFieldEditor.existingId !== null}
          onSubmit={(definition) => {
            const defaultValue = definition.defaultValue;
            markRecord((record) => ({
              ...record,
              itemFields: itemFieldEditor.existingId
                ? record.itemFields.map((field) =>
                    field.id === itemFieldEditor.existingId
                      ? definition
                      : field,
                  )
                : [...record.itemFields, definition],
              values:
                itemFieldEditor.existingId || definition.id in record.values
                  ? record.values
                  : { ...record.values, [definition.id]: defaultValue },
            }));
            setItemFieldEditor(null);
          }}
          onClose={() => setItemFieldEditor(null)}
        />
      )}

      {aiSuggestion && recordDraft && (
        <ItemLibraryAiDialog
          key={`${recordDraft.id}:${aiSuggestion.kind}`}
          itemName={recordDraft.name}
          record={recordDraft}
          fields={[...categoryFields, ...itemFields]}
          suggestion={aiSuggestion}
          onApplyProfile={(selectedKeys) => {
            if (aiSuggestion.kind !== "profile") return;
            if (selectedKeys.has("aliases") && aiSuggestion.aliases) {
              setAliasesText(aiSuggestion.aliases.join("，"));
            }
            if (selectedKeys.has("tags") && aiSuggestion.tags) {
              setTagsText(aiSuggestion.tags.join("，"));
            }
            markRecord((record) => {
              const values = { ...record.values };
              for (const [fieldId, value] of Object.entries(
                aiSuggestion.values,
              )) {
                if (selectedKeys.has(`value:${fieldId}`))
                  values[fieldId] = value;
              }
              return {
                ...record,
                summary:
                  selectedKeys.has("summary") && aiSuggestion.summary
                    ? aiSuggestion.summary
                    : record.summary,
                aliases:
                  selectedKeys.has("aliases") && aiSuggestion.aliases
                    ? [...aiSuggestion.aliases]
                    : record.aliases,
                tags:
                  selectedKeys.has("tags") && aiSuggestion.tags
                    ? [...aiSuggestion.tags]
                    : record.tags,
                values,
              };
            });
            setAiSuggestion(null);
          }}
          onApplyDescription={(content) => {
            markPage(content);
            setDetailTab("description");
            setAiSuggestion(null);
          }}
          onClose={() => setAiSuggestion(null)}
        />
      )}

      {proposalReviewOpen && onCloseProposalReview && (
        <ItemBatchProposalReview
          storage={storage}
          projectTitle={projectTitle}
          beforeMutate={flushCurrentDraft}
          onApplied={load}
          onClose={onCloseProposalReview}
        />
      )}
    </div>
  );
}

function LibraryLoadingState() {
  return (
    <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 读取物品库
    </div>
  );
}

function LibraryErrorState({
  error,
  onRetry,
}: {
  readonly error: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-[var(--paper)] px-6">
      <div className="max-w-md text-center">
        <CircleAlert className="mx-auto h-8 w-8 text-[var(--error)]" />
        <p className="mt-3 text-sm font-medium">物品库读取失败</p>
        <p className="mt-1 break-words text-xs text-[var(--ink-muted)]">
          {error}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mx-auto mt-4 flex h-9 items-center gap-2 rounded-md border border-[var(--line)] px-3 text-sm hover:bg-[var(--hover-bg)]"
        >
          <RefreshCw className="h-4 w-4" /> 重新读取
        </button>
      </div>
    </div>
  );
}

function CategoryFilterButton({
  active,
  icon: Icon,
  label,
  count,
  onClick,
}: {
  readonly active: boolean;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly count: number;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-10 w-full items-center gap-2 rounded-md px-3 text-left transition-colors ${
        active
          ? "bg-[var(--accent-cool-subtle)] text-[var(--ink)] ring-1 ring-inset ring-[var(--accent-cool)]/30"
          : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
      }`}
    >
      <Icon
        className={`h-4 w-4 shrink-0 ${active ? "text-[var(--accent-cool)]" : ""}`}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {label}
      </span>
      <span className="shrink-0 rounded border border-[var(--line)] bg-[var(--paper-elevated)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
        {count} 件
      </span>
    </button>
  );
}

function CategoryTree({
  meta,
  parentId,
  selectedId,
  expanded,
  counts,
  depth = 0,
  onToggle,
  onSelect,
}: {
  readonly meta: ItemLibraryMeta;
  readonly parentId: string | null;
  readonly selectedId: CategoryFilter;
  readonly expanded: ReadonlySet<string>;
  readonly counts: ReadonlyMap<string, number>;
  readonly depth?: number;
  readonly onToggle: (id: string) => void;
  readonly onSelect: (id: string) => void;
}) {
  const children = meta.categories
    .filter((category) => category.parentId === parentId && !category.archived)
    .sort((left, right) => left.order - right.order);
  return children.map((category) => {
    const childCount = meta.categories.filter(
      (candidate) => candidate.parentId === category.id && !candidate.archived,
    ).length;
    const Icon = CATEGORY_ICONS[category.icon] ?? Folder;
    const isExpanded = expanded.has(category.id);
    const selected = selectedId === category.id;
    return (
      <div
        key={category.id}
        role="treeitem"
        aria-expanded={childCount ? isExpanded : undefined}
      >
        <div
          style={{ paddingLeft: `${Math.min(depth * 16 + 4, 68)}px` }}
          className={`flex h-10 items-center gap-1 rounded-md pr-2 transition-colors ${
            selected
              ? "bg-[var(--accent-cool-subtle)] text-[var(--ink)] ring-1 ring-inset ring-[var(--accent-cool)]/30"
              : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          }`}
        >
          <button
            type="button"
            onClick={() => childCount > 0 && onToggle(category.id)}
            aria-label={
              isExpanded ? `收起${category.name}` : `展开${category.name}`
            }
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ${
              childCount ? "opacity-100" : "pointer-events-none opacity-0"
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
            onClick={() => onSelect(category.id)}
            aria-label={`${category.name} · ${counts.get(category.id) ?? 0} 件物品`}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Icon
              className={`h-4 w-4 shrink-0 ${selected ? "text-[var(--accent-cool)]" : ""}`}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {category.name}
            </span>
            <span className="shrink-0 rounded border border-[var(--line)] bg-[var(--paper-elevated)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
              {counts.get(category.id) ?? 0} 件
            </span>
          </button>
        </div>
        {isExpanded && childCount > 0 && (
          <CategoryTree
            meta={meta}
            parentId={category.id}
            selectedId={selectedId}
            expanded={expanded}
            counts={counts}
            depth={depth + 1}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        )}
      </div>
    );
  });
}

function DetailTabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex h-9 items-center gap-1.5 border-b-2 px-3 text-xs font-medium transition-colors ${
        active
          ? "border-[var(--accent-warm)] text-[var(--ink)]"
          : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"
      }`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function ProfileSection({
  title,
  suffix,
  action,
  tone,
  children,
}: {
  readonly title: string;
  readonly suffix?: string;
  readonly action?: ReactNode;
  readonly tone?: "retained";
  readonly children: ReactNode;
}) {
  return (
    <section className="border-b border-[var(--line)] py-5 first:pt-0 last:border-b-0">
      <div className="mb-4 flex min-h-7 items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {suffix && (
            <span
              className={`text-xs ${
                tone === "retained"
                  ? "text-[var(--warning)]"
                  : "text-[var(--ink-muted)]"
              }`}
            >
              {suffix}
            </span>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function FieldGrid({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-4 max-lg:grid-cols-1">
      {children}
    </div>
  );
}

function FieldLabel({
  label,
  hint,
  className = "",
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="mb-1.5 flex min-w-0 items-center justify-between gap-2 text-xs font-medium text-[var(--ink-muted)]">
        <span className="truncate">{label}</span>
        {hint && (
          <span className="shrink-0 text-xs font-normal text-[var(--ink-subtle)]">
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

function DefinitionField({
  definition,
  source,
  value,
  actions,
  onChange,
}: {
  readonly definition: ItemFieldDefinition | CategoryFieldDefinition;
  readonly source?: string;
  readonly value: ItemFieldValue;
  readonly actions?: ReactNode;
  readonly onChange: (value: ItemFieldValue) => void;
}) {
  return (
    <FieldLabel
      label={`${definition.label}${definition.required ? " *" : ""}`}
      hint={source}
    >
      <div className="relative">
        <FieldValueEditor
          definition={definition}
          value={value}
          onChange={onChange}
        />
        {actions && (
          <div className="absolute -top-7 right-0 flex items-center gap-0.5">
            {actions}
          </div>
        )}
      </div>
      {definition.description && (
        <span className="mt-1 block text-xs leading-4 text-[var(--ink-subtle)]">
          {definition.description}
        </span>
      )}
    </FieldLabel>
  );
}

function FieldValueEditor({
  definition,
  value,
  onChange,
}: {
  readonly definition: ItemFieldDefinition | CategoryFieldDefinition;
  readonly value: ItemFieldValue;
  readonly onChange: (value: ItemFieldValue) => void;
}) {
  if (definition.type === "textarea") {
    return (
      <textarea
        value={typeof value === "string" ? value : fieldValueLabel(value)}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className="item-library-input resize-y"
      />
    );
  }
  if (definition.type === "number") {
    return (
      <div className="relative">
        <input
          type="number"
          value={
            typeof value === "number" || typeof value === "string" ? value : ""
          }
          onChange={(event) =>
            onChange(
              event.target.value === "" ? "" : Number(event.target.value),
            )
          }
          className={`item-library-input ${definition.unit ? "pr-12" : ""}`}
        />
        {definition.unit && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--ink-muted)]">
            {definition.unit}
          </span>
        )}
      </div>
    );
  }
  if (definition.type === "single-select") {
    const stringValue = typeof value === "string" ? value : "";
    return (
      <CustomSelect
        value={stringValue}
        options={[
          { value: "", label: "未选择" },
          ...definition.options.map((option) => ({
            value: option,
            label: option,
          })),
        ]}
        onChange={onChange}
        ariaLabel={definition.label}
        size="toolbar"
      />
    );
  }
  if (definition.type === "multi-select") {
    const values = Array.isArray(value) ? value : [];
    return (
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
        {definition.options.length === 0 ? (
          <span className="text-xs text-[var(--ink-subtle)]">暂无选项</span>
        ) : (
          definition.options.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--ink)]"
            >
              <input
                type="checkbox"
                checked={values.includes(option)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...values, option]
                      : values.filter((candidate) => candidate !== option),
                  )
                }
                className="h-3.5 w-3.5 accent-[var(--accent-warm)]"
              />
              {option}
            </label>
          ))
        )}
      </div>
    );
  }
  if (definition.type === "boolean") {
    const checked = value === true;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex h-9 w-full items-center justify-between rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-xs"
      >
        <span
          className={checked ? "text-[var(--ink)]" : "text-[var(--ink-muted)]"}
        >
          {checked ? "开启" : "关闭"}
        </span>
        <span
          className={`relative h-5 w-9 rounded-full transition-colors ${
            checked ? "bg-[var(--accent-warm)]" : "bg-[var(--line-strong)]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
              checked ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </span>
      </button>
    );
  }
  return (
    <input
      value={typeof value === "string" ? value : fieldValueLabel(value)}
      onChange={(event) => onChange(event.target.value)}
      placeholder={
        definition.type === "story-time"
          ? "例如：玄历二十三年秋"
          : definition.type === "entity-reference"
            ? "实体名称或 ID"
            : definition.type === "asset-reference"
              ? "项目内资产路径"
              : undefined
      }
      className={`item-library-input ${
        definition.type === "asset-reference" ? "font-mono" : ""
      }`}
    />
  );
}

function EmptyFieldSection({ text }: { readonly text: string }) {
  return (
    <div className="border-y border-dashed border-[var(--line-subtle)] py-5 text-center text-xs text-[var(--ink-muted)]">
      {text}
    </div>
  );
}

function CreateItemDialog({
  name,
  categoryId,
  categoryOptions,
  isSaving,
  onNameChange,
  onCategoryChange,
  onSubmit,
  onClose,
}: {
  readonly name: string;
  readonly categoryId: string;
  readonly categoryOptions: SelectOption[];
  readonly isSaving: boolean;
  readonly onNameChange: (value: string) => void;
  readonly onCategoryChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}) {
  return (
    <DraggableDialogFrame
      ariaLabel="新建物品"
      className="w-[min(480px,calc(100vw-24px))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center justify-between px-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <PackageOpen className="h-4 w-4 text-[var(--accent-warm)]" />{" "}
            新建物品
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭新建物品"
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
          <FieldLabel label="物品名称">
            <input
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              autoFocus
              className="item-library-input"
            />
          </FieldLabel>
          <FieldLabel label="主分类">
            <CustomSelect
              value={categoryId}
              options={categoryOptions}
              onChange={onCategoryChange}
              ariaLabel="新物品主分类"
              size="toolbar"
            />
          </FieldLabel>
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
            disabled={!name.trim() || isSaving}
            className="flex items-center gap-2 rounded-md bg-[var(--accent-warm)] px-3 py-2 text-sm font-medium text-white hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            创建
          </button>
        </footer>
      </form>
    </DraggableDialogFrame>
  );
}
