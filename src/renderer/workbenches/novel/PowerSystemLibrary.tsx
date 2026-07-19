import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  Atom,
  Check,
  CircleHelp,
  CircleDashed,
  Gauge,
  GitBranch,
  GripVertical,
  Layers3,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Sparkles,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
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
  type WorkbenchStorage,
} from "@/workbench-sdk";

import MarkdownVisualEditor from "./MarkdownVisualEditor";
import PowerSystemGraph from "./PowerSystemGraph";
import PowerSystemInspector, {
  createPowerRule,
  type PowerInspectorSelection,
} from "./PowerSystemInspector";
import { auditPowerSystem } from "./powerSystemAudit";
import { createDefaultPowerTruthMetadata } from "./powerSystemDefaults";
import {
  createNovelPowerSystemRepository,
  type LoadedPowerSystem,
  type LoadedPowerSystemLibrary,
} from "./powerSystemRepository";
import type {
  CrossSystemInteraction,
  PowerBenchmark,
  PowerCapability,
  PowerDimension,
  PowerElement,
  PowerMethod,
  PowerOrigin,
  PowerResource,
  PowerState,
  PowerStateTrack,
  PowerSystemRecord,
} from "./powerSystemSchema";

interface PowerSystemLibraryProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
  readonly headerActions?: ReactNode;
}

type PowerView =
  | "architecture"
  | "states"
  | "capabilities"
  | "resources"
  | "rules"
  | "interactions"
  | "scales"
  | "audit";

const VIEW_ITEMS: readonly {
  readonly id: PowerView;
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  { id: "architecture", label: "架构", icon: Network },
  { id: "states", label: "状态", icon: GitBranch },
  { id: "capabilities", label: "能力", icon: Sparkles },
  { id: "resources", label: "资源", icon: Atom },
  { id: "rules", label: "规则", icon: ShieldAlert },
  { id: "interactions", label: "交互", icon: ArrowRightLeft },
  { id: "scales", label: "标尺", icon: Gauge },
  { id: "audit", label: "审查", icon: Check },
];

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]";

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createElement(kind: PowerElement["kind"]): PowerElement {
  const base = {
    id: createId(kind),
    name:
      kind === "origin"
        ? "新力量来源"
        : kind === "resource"
          ? "新资源"
          : kind === "method"
            ? "新运用方式"
            : "新能力",
    subtypeId: "",
    summary: "",
    metadata: createDefaultPowerTruthMetadata(),
  };
  if (kind === "origin") {
    return { ...base, kind, availability: "unknown" } satisfies PowerOrigin;
  }
  if (kind === "resource") {
    return {
      ...base,
      kind,
      measurement: "descriptive",
      unit: "",
      minimum: null,
      maximum: null,
      recovery: "",
      depletion: "",
    } satisfies PowerResource;
  }
  if (kind === "method") {
    return {
      ...base,
      kind,
      acquisition: "unknown",
      procedure: "",
    } satisfies PowerMethod;
  }
  return {
    ...base,
    kind,
    activation: "active",
    effect: "",
    target: "",
    range: "",
    duration: "",
  } satisfies PowerCapability;
}

function createTrack(): PowerStateTrack {
  return {
    id: createId("track"),
    name: "新状态轨道",
    subtypeId: "",
    summary: "",
    mode: "ordered",
    states: [],
    transitions: [],
    metadata: createDefaultPowerTruthMetadata(),
  };
}

function createState(track: PowerStateTrack): PowerState {
  return {
    id: createId("state"),
    name: `状态 ${track.states.length + 1}`,
    summary: "",
    order: track.states.length,
    metadata: createDefaultPowerTruthMetadata(),
  };
}

function createDimension(): PowerDimension {
  return {
    id: createId("dimension"),
    name: "新维度",
    measurement: "numeric",
    unit: "",
    lowLabel: "低",
    highLabel: "高",
    description: "",
  };
}

function createBenchmark(): PowerBenchmark {
  return {
    id: createId("benchmark"),
    name: "新场景标尺",
    context: "",
    values: [],
  };
}

function elementKindLabel(kind: PowerElement["kind"]): string {
  return {
    origin: "来源",
    resource: "资源",
    method: "方式",
    capability: "能力",
  }[kind];
}

function EmptyLibrary({
  isInitializing,
  onInitialize,
}: {
  readonly isInitializing: boolean;
  readonly onInitialize: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-md bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
          <Waypoints className="h-5 w-5" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-[var(--ink)]">
          尚未建立力量体系库
        </h1>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
          初始化只会创建新的结构化事实源，不会读取、迁移或覆盖旧的
          world/power-system.md。
        </p>
        <button
          type="button"
          disabled={isInitializing}
          onClick={onInitialize}
          className="mx-auto mt-5 flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-4 text-sm font-medium text-white disabled:opacity-45"
        >
          {isInitializing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          初始化力量体系库
        </button>
      </div>
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
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-lg text-center">
        <AlertTriangle className="mx-auto h-6 w-6 text-[var(--error)]" />
        <h1 className="mt-3 text-base font-semibold">无法读取力量体系</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
          {error}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mx-auto mt-4 flex h-9 items-center gap-1.5 rounded-md border border-[var(--line)] px-3 text-sm"
        >
          <RefreshCw className="h-3.5 w-3.5" /> 重新读取
        </button>
      </div>
    </div>
  );
}

function CreateSystemDialog({
  library,
  onClose,
  onCreate,
}: {
  readonly library: LoadedPowerSystemLibrary;
  readonly onClose: () => void;
  readonly onCreate: (name: string, typeId: string) => void;
}) {
  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState("blank");
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 p-4">
      <section className="w-full max-w-md overflow-hidden rounded-lg border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-xl">
        <header className="flex h-14 items-center gap-3 border-b border-[var(--line)] px-5">
          <Waypoints className="h-4 w-4 text-[var(--accent-warm)]" />
          <h2 className="text-sm font-semibold">新建力量体系</h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-4 p-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              体系名称
            </span>
            <input
              autoFocus
              className={inputClass}
              value={name}
              placeholder="例如：灵能、王权契约、第三代义体"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              起始预设
            </span>
            <CustomSelect
              value={typeId}
              options={library.meta.systemTypes.map((type) => ({
                value: type.id,
                label: type.name,
                description: type.description,
              }))}
              onChange={setTypeId}
            />
          </label>
          <p className="text-xs leading-5 text-[var(--ink-muted)]">
            预设只决定默认设计契约和显示方式，所有体系使用同一套数据模型。
          </p>
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() => onCreate(name.trim(), typeId)}
            className="h-9 rounded-md bg-[var(--accent-warm)] px-4 text-sm font-medium text-white disabled:opacity-40"
          >
            创建
          </button>
        </footer>
      </section>
    </div>
  );
}

function PowerSystemHelpDialog({ onClose }: { readonly onClose: () => void }) {
  return (
    <DraggableDialogFrame
      ariaLabel="力量体系设计说明"
      className="w-[min(680px,calc(100vw-24px))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center justify-between px-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
            <CircleHelp className="h-4 w-4 text-[var(--accent-cool)]" />
            力量体系设计说明
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭力量体系设计说明"
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="max-h-[min(680px,calc(100vh-9rem))] overflow-y-auto p-5">
        <p className="text-sm leading-6 text-[var(--ink-muted)]">
          力量体系描述的是故事中“某种力量如何成立并产生影响”，不是固定题材的等级表。修炼、魔法、科技、超能力、血脉、神权契约和弱规则体系都使用同一套结构。
        </p>

        <section className="mt-5 border-b border-[var(--line-subtle)] pb-4">
          <h2 className="text-sm font-semibold text-[var(--ink)]">
            1. 先建立力量的因果骨架
          </h2>
          <div className="mt-3 grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-2 text-xs max-sm:grid-cols-1">
            {[
              ["来源", "力量从哪里来"],
              ["资源", "需要什么载体或消耗"],
              ["方式", "如何获得与运用"],
              ["能力", "最终能产生什么效果"],
            ].map(([title, description], index) => (
              <div key={title} className="contents">
                <div className="min-w-0 border-l-2 border-[var(--accent-warm)] pl-2.5">
                  <strong className="block font-semibold text-[var(--ink)]">
                    {title}
                  </strong>
                  <span className="mt-0.5 block leading-5 text-[var(--ink-muted)]">
                    {description}
                  </span>
                </div>
                {index < 3 && (
                  <ArrowRight className="h-3.5 w-3.5 text-[var(--ink-subtle)] max-sm:hidden" />
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-5 text-[var(--ink-muted)]">
            不是每个体系都必须拥有四类元素。只记录实际存在的部分，再用关系说明依赖、转化、增强、克制或替代。
          </p>
        </section>

        <section className="border-b border-[var(--line-subtle)] py-4">
          <h2 className="text-sm font-semibold text-[var(--ink)]">
            2. 用状态与规则定义变化
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
            “状态”记录角色、物品或组织可能经历的阶段；转换负责表达推进、分支、合流、回退、变形、恢复与事件触发。“规则”补充跨状态生效的条件、优先级、效果、代价和例外。这样既能表达严格等级，也能表达非线性成长、装备迭代或契约关系。
          </p>
        </section>

        <section className="border-b border-[var(--line-subtle)] py-4">
          <h2 className="text-sm font-semibold text-[var(--ink)]">
            3. 区分体系内部与体系之间
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
            如果两组力量拥有彼此独立的来源和运行规则，应拆成两个体系，再在“交互”中记录兼容、干扰、转化、克制或共鸣；如果只是同一机制的不同流派、装备或能力，则保留在一个体系内。
          </p>
        </section>

        <section className="border-b border-[var(--line-subtle)] py-4">
          <h2 className="text-sm font-semibold text-[var(--ink)]">
            4. 标尺只服务具体场景
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
            “标尺”按速度、范围、精度、代价、稳定性等独立维度比较对象。它用于回答某个场景中的明确问题，不合并成永久的总战力数字，避免不同机制被错误压缩到同一排名。
          </p>
        </section>

        <section className="pt-4">
          <h2 className="text-sm font-semibold text-[var(--ink)]">
            5. 让设定能被正文追溯
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
            右侧资料中的设定层级、领域、时空范围、权威级别、Canon、揭示阶段与来源引用共同说明一条设定在何处成立、可信到什么程度，以及读者何时能够知道。完成建模后，用“审查”检查体系是否满足自己的设计契约。
          </p>
        </section>
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

function SortableStateRow({
  state,
  active,
  onSelect,
}: {
  readonly state: PowerState;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: state.id });
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onSelect}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={`grid w-full grid-cols-[2rem_2rem_minmax(0,1fr)] items-center border-b border-[var(--line-subtle)] px-3 py-2.5 text-left ${active ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
    >
      <span
        {...attributes}
        {...listeners}
        className="flex h-7 w-7 cursor-grab items-center justify-center rounded text-[var(--ink-subtle)] hover:bg-[var(--paper-inset)]"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>
      <span className="font-mono text-xs text-[var(--ink-subtle)]">
        {String(state.order + 1).padStart(2, "0")}
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-sm font-medium">
          {state.name}
        </strong>
        <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
          {state.summary || "暂无说明"}
        </span>
      </span>
    </button>
  );
}

function ElementTable({
  elements,
  selection,
  onSelect,
}: {
  readonly elements: readonly PowerElement[];
  readonly selection: PowerInspectorSelection;
  readonly onSelect: (id: string) => void;
}) {
  if (elements.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
        暂无内容
      </div>
    );
  }
  return (
    <div className="overflow-auto">
      <div className="grid min-w-[680px] grid-cols-[8rem_minmax(10rem,1fr)_9rem_1.5fr] border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-2 text-xs font-medium text-[var(--ink-muted)]">
        <span>类型</span>
        <span>名称</span>
        <span>子类型</span>
        <span>摘要</span>
      </div>
      {elements.map((element) => (
        <button
          key={element.id}
          type="button"
          onClick={() => onSelect(element.id)}
          className={`grid min-w-[680px] w-full grid-cols-[8rem_minmax(10rem,1fr)_9rem_1.5fr] items-center border-b border-[var(--line-subtle)] px-4 py-3 text-left text-sm ${selection.kind === "element" && selection.id === element.id ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
        >
          <span className="text-xs font-medium text-[var(--ink-muted)]">
            {elementKindLabel(element.kind)}
          </span>
          <strong className="truncate font-medium">{element.name}</strong>
          <span className="truncate text-xs text-[var(--ink-muted)]">
            {element.subtypeId || "未分类"}
          </span>
          <span className="truncate text-xs text-[var(--ink-muted)]">
            {element.summary || "暂无摘要"}
          </span>
        </button>
      ))}
    </div>
  );
}

export default function PowerSystemLibrary({
  storage,
  projectTitle,
  isActive,
  headerActions,
}: PowerSystemLibraryProps) {
  const repository = useMemo(
    () => createNovelPowerSystemRepository(storage),
    [storage],
  );
  const [library, setLibrary] = useState<LoadedPowerSystemLibrary | null>(null);
  const [system, setSystem] = useState<LoadedPowerSystem | null>(null);
  const [draft, setDraft] = useState<PowerSystemRecord | null>(null);
  const [pageDraft, setPageDraft] = useState("");
  const [interactionsDraft, setInteractionsDraft] = useState<
    LoadedPowerSystemLibrary["interactions"] | null
  >(null);
  const [selectedSystemId, setSelectedSystemId] = useState("");
  const [selection, setSelection] = useState<PowerInspectorSelection>({
    kind: "system",
  });
  const [view, setView] = useState<PowerView>("architecture");
  const [architectureMode, setArchitectureMode] = useState<"graph" | "notes">(
    "graph",
  );
  const [systemSearch, setSystemSearch] = useState("");
  const [selectedTrackId, setSelectedTrackId] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const loadLibrary = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const loaded = await repository.load();
      setLibrary(loaded);
      setInteractionsDraft(loaded?.interactions ?? null);
      if (!loaded) {
        setSystem(null);
        setDraft(null);
        setSelectedSystemId("");
      } else {
        const nextId = loaded.index.systems.some(
          (entry) => entry.id === selectedSystemId,
        )
          ? selectedSystemId
          : (loaded.index.systems[0]?.id ?? "");
        setSelectedSystemId(nextId);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [repository, selectedSystemId]);

  useEffect(() => {
    if (isActive) void loadLibrary();
  }, [isActive, loadLibrary]);

  useEffect(() => {
    if (!library || !selectedSystemId) {
      setSystem(null);
      setDraft(null);
      return;
    }
    const entry = library.index.systems.find(
      (item) => item.id === selectedSystemId,
    );
    if (!entry) return;
    let disposed = false;
    setError(null);
    void repository
      .loadSystem(entry)
      .then((loaded) => {
        if (disposed) return;
        setSystem(loaded);
        setDraft(loaded.record);
        setPageDraft(loaded.pageContent);
        setSelection({ kind: "system" });
        setSelectedTrackId(loaded.record.tracks[0]?.id ?? "");
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, [library, repository, selectedSystemId]);

  const interactionsDirty = Boolean(
    library &&
      interactionsDraft &&
      JSON.stringify(library.interactions) !==
        JSON.stringify(interactionsDraft),
  );
  const systemDirty = Boolean(
    system &&
      draft &&
      (JSON.stringify(system.record) !== JSON.stringify(draft) ||
        system.pageContent !== pageDraft),
  );
  const isDirty = systemDirty || interactionsDirty;

  const save = useCallback(async () => {
    if (!library || !interactionsDraft) return;
    setIsSaving(true);
    setError(null);
    try {
      let nextLibrary = library;
      if (system && draft && systemDirty) {
        const result = await repository.saveSystem(
          nextLibrary,
          system,
          draft,
          pageDraft,
        );
        nextLibrary = result.library;
        setSystem(result.system);
        setDraft(result.system.record);
        setPageDraft(result.system.pageContent);
      }
      if (interactionsDirty) {
        nextLibrary = await repository.saveInteractions(
          nextLibrary,
          interactionsDraft,
        );
      }
      setLibrary(nextLibrary);
      setInteractionsDraft(nextLibrary.interactions);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsSaving(false);
    }
  }, [
    draft,
    interactionsDirty,
    interactionsDraft,
    library,
    pageDraft,
    repository,
    system,
    systemDirty,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (isDirty && !isSaving) void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDirty, isSaving, save]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在读取力量体系
      </div>
    );
  }
  if (error && !library)
    return <ErrorState error={error} onRetry={() => void loadLibrary()} />;
  if (!library) {
    return (
      <EmptyLibrary
        isInitializing={isInitializing}
        onInitialize={() => {
          setIsInitializing(true);
          setError(null);
          void repository
            .initialize()
            .then((loaded) => {
              setLibrary(loaded);
              setInteractionsDraft(loaded.interactions);
            })
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setIsInitializing(false));
        }}
      />
    );
  }

  const filteredSystems = library.index.systems.filter((entry) =>
    `${entry.name} ${entry.summary}`
      .toLowerCase()
      .includes(systemSearch.trim().toLowerCase()),
  );

  const addElement = (kind: PowerElement["kind"]) => {
    if (!draft) return;
    const element = createElement(kind);
    setDraft({ ...draft, elements: [...draft.elements, element] });
    setSelection({ kind: "element", id: element.id });
  };

  const activeTrack = draft?.tracks.find(
    (track) => track.id === selectedTrackId,
  );
  const auditIssues = draft ? auditPowerSystem(draft) : [];

  const renderCenter = () => {
    if (!draft) {
      return (
        <div className="flex h-full items-center justify-center">
          <div className="text-center">
            <CircleDashed className="mx-auto h-5 w-5 text-[var(--ink-subtle)]" />
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              创建第一个力量体系后开始设计
            </p>
          </div>
        </div>
      );
    }

    if (view === "architecture") {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-[var(--line-subtle)] px-3 py-1.5">
            {(["origin", "resource", "method", "capability"] as const).map(
              (kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => addElement(kind)}
                  className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <Plus className="h-3.5 w-3.5" /> {elementKindLabel(kind)}
                </button>
              ),
            )}
            <div className="ml-auto flex rounded-md bg-[var(--paper-inset)] p-0.5">
              <button
                type="button"
                onClick={() => setArchitectureMode("graph")}
                className={`h-7 rounded px-2 text-xs ${architectureMode === "graph" ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm" : "text-[var(--ink-muted)]"}`}
              >
                图谱
              </button>
              <button
                type="button"
                onClick={() => setArchitectureMode("notes")}
                className={`h-7 rounded px-2 text-xs ${architectureMode === "notes" ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm" : "text-[var(--ink-muted)]"}`}
              >
                说明
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {architectureMode === "graph" ? (
              <PowerSystemGraph
                record={draft}
                onChange={setDraft}
                onSelectElement={(id) => setSelection({ kind: "element", id })}
                onSelectRelation={(id) =>
                  setSelection({ kind: "relation", id })
                }
              />
            ) : (
              <MarkdownVisualEditor
                pageId={draft.id}
                label={`${draft.name}说明`}
                value={pageDraft}
                onChange={setPageDraft}
                onSave={() => void save()}
                fullWidth
              />
            )}
          </div>
        </div>
      );
    }

    if (view === "states") {
      const reorderStates = (event: DragEndEvent) => {
        if (!activeTrack || !event.over || event.active.id === event.over.id)
          return;
        const oldIndex = activeTrack.states.findIndex(
          (state) => state.id === event.active.id,
        );
        const newIndex = activeTrack.states.findIndex(
          (state) => state.id === event.over?.id,
        );
        const states = arrayMove(activeTrack.states, oldIndex, newIndex).map(
          (state, order) => ({ ...state, order }),
        );
        setDraft({
          ...draft,
          tracks: draft.tracks.map((track) =>
            track.id === activeTrack.id ? { ...track, states } : track,
          ),
        });
      };
      return (
        <div className="flex h-full min-h-0">
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-[var(--line-subtle)]">
            <div className="flex h-11 items-center justify-between border-b border-[var(--line-subtle)] px-3">
              <span className="text-xs font-semibold text-[var(--ink-muted)]">
                状态轨道
              </span>
              <button
                type="button"
                title="新增状态轨道"
                onClick={() => {
                  const track = createTrack();
                  setDraft({ ...draft, tracks: [...draft.tracks, track] });
                  setSelectedTrackId(track.id);
                  setSelection({ kind: "track", id: track.id });
                }}
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--hover-bg)]"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {draft.tracks.map((track) => (
              <button
                key={track.id}
                type="button"
                onClick={() => {
                  setSelectedTrackId(track.id);
                  setSelection({ kind: "track", id: track.id });
                }}
                className={`w-full border-b border-[var(--line-subtle)] px-3 py-3 text-left ${selectedTrackId === track.id ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
              >
                <strong className="block truncate text-sm font-medium">
                  {track.name}
                </strong>
                <span className="mt-1 block text-xs text-[var(--ink-muted)]">
                  {track.states.length} 个状态 · {track.mode}
                </span>
              </button>
            ))}
          </aside>
          <div className="min-w-0 flex-1 overflow-y-auto">
            {activeTrack ? (
              <>
                <div className="flex h-11 items-center justify-between border-b border-[var(--line-subtle)] px-4">
                  <div className="min-w-0">
                    <strong className="truncate text-sm font-semibold">
                      {activeTrack.name}
                    </strong>
                    <span className="ml-2 text-xs text-[var(--ink-muted)]">
                      拖拽调整顺序
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={activeTrack.states.length === 0}
                      onClick={() => {
                        const ordered = [...activeTrack.states].sort(
                          (left, right) => left.order - right.order,
                        );
                        const transition = {
                          id: createId("transition"),
                          fromStateId:
                            ordered.length > 1 ? ordered[0]!.id : null,
                          toStateId: ordered.at(-1)!.id,
                          kind: "branch" as const,
                          conditions: { mode: "all" as const, clauses: [] },
                          costs: [],
                          outcomes: [],
                          failure: "",
                        };
                        setDraft({
                          ...draft,
                          tracks: draft.tracks.map((track) =>
                            track.id === activeTrack.id
                              ? {
                                  ...track,
                                  transitions: [
                                    ...track.transitions,
                                    transition,
                                  ],
                                }
                              : track,
                          ),
                        });
                        setSelection({
                          kind: "transition",
                          trackId: activeTrack.id,
                          id: transition.id,
                        });
                      }}
                      className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-35"
                    >
                      <GitBranch className="h-3.5 w-3.5" /> 添加转换
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const state = createState(activeTrack);
                        const previous = [...activeTrack.states]
                          .sort((left, right) => left.order - right.order)
                          .at(-1);
                        const transitions = previous
                          ? [
                              ...activeTrack.transitions,
                              {
                                id: createId("transition"),
                                fromStateId: previous.id,
                                toStateId: state.id,
                                kind: "advance" as const,
                                conditions: {
                                  mode: "all" as const,
                                  clauses: [],
                                },
                                costs: [],
                                outcomes: [],
                                failure: "",
                              },
                            ]
                          : activeTrack.transitions;
                        setDraft({
                          ...draft,
                          tracks: draft.tracks.map((track) =>
                            track.id === activeTrack.id
                              ? {
                                  ...track,
                                  states: [...track.states, state],
                                  transitions,
                                }
                              : track,
                          ),
                        });
                        setSelection({
                          kind: "state",
                          trackId: activeTrack.id,
                          id: state.id,
                        });
                      }}
                      className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"
                    >
                      <Plus className="h-3.5 w-3.5" /> 添加状态
                    </button>
                  </div>
                </div>
                <DndContext sensors={sensors} onDragEnd={reorderStates}>
                  <SortableContext
                    items={[...activeTrack.states]
                      .sort((left, right) => left.order - right.order)
                      .map((state) => state.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {[...activeTrack.states]
                      .sort((left, right) => left.order - right.order)
                      .map((state) => (
                        <SortableStateRow
                          key={state.id}
                          state={state}
                          active={
                            selection.kind === "state" &&
                            selection.id === state.id
                          }
                          onSelect={() =>
                            setSelection({
                              kind: "state",
                              trackId: activeTrack.id,
                              id: state.id,
                            })
                          }
                        />
                      ))}
                  </SortableContext>
                </DndContext>
                {activeTrack.transitions.length > 0 && (
                  <section className="border-t border-[var(--line)] px-4 py-4">
                    <h3 className="text-xs font-semibold text-[var(--ink-muted)]">
                      状态转换
                    </h3>
                    <div className="mt-2 space-y-1.5">
                      {activeTrack.transitions.map((transition) => {
                        const from = activeTrack.states.find(
                          (state) => state.id === transition.fromStateId,
                        );
                        const to = activeTrack.states.find(
                          (state) => state.id === transition.toStateId,
                        );
                        return (
                          <button
                            key={transition.id}
                            type="button"
                            onClick={() =>
                              setSelection({
                                kind: "transition",
                                trackId: activeTrack.id,
                                id: transition.id,
                              })
                            }
                            className="flex items-center gap-2 rounded-md border border-[var(--line-subtle)] px-3 py-2 text-xs"
                          >
                            <span>{from?.name ?? "入口"}</span>
                            <ArrowRight className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
                            <span>{to?.name ?? transition.toStateId}</span>
                            <span className="ml-auto text-[var(--ink-muted)]">
                              {transition.kind}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                新增一条状态轨道开始设计
              </div>
            )}
          </div>
        </div>
      );
    }

    if (view === "capabilities") {
      return (
        <div className="flex h-full flex-col">
          <div className="flex h-11 items-center justify-end border-b border-[var(--line-subtle)] px-3">
            <button
              type="button"
              onClick={() => addElement("capability")}
              className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"
            >
              <Plus className="h-3.5 w-3.5" /> 新增能力
            </button>
          </div>
          <ElementTable
            elements={draft.elements.filter(
              (item) => item.kind === "capability",
            )}
            selection={selection}
            onSelect={(id) => setSelection({ kind: "element", id })}
          />
        </div>
      );
    }

    if (view === "resources") {
      const elements = draft.elements.filter(
        (item) => item.kind !== "capability",
      );
      return (
        <div className="flex h-full flex-col">
          <div className="flex h-11 items-center justify-end gap-1 border-b border-[var(--line-subtle)] px-3">
            {(["origin", "resource", "method"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => addElement(kind)}
                className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"
              >
                <Plus className="h-3.5 w-3.5" /> {elementKindLabel(kind)}
              </button>
            ))}
          </div>
          <ElementTable
            elements={elements}
            selection={selection}
            onSelect={(id) => setSelection({ kind: "element", id })}
          />
        </div>
      );
    }

    if (view === "rules") {
      return (
        <div className="h-full overflow-y-auto">
          <div className="flex h-11 items-center justify-between border-b border-[var(--line-subtle)] px-4">
            <span className="text-xs font-semibold text-[var(--ink-muted)]">
              条件、结果、代价与例外
            </span>
            <button
              type="button"
              onClick={() => {
                const rule = createPowerRule();
                setDraft({ ...draft, rules: [...draft.rules, rule] });
                setSelection({ kind: "rule", id: rule.id });
              }}
              className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"
            >
              <Plus className="h-3.5 w-3.5" /> 新增规则
            </button>
          </div>
          {draft.rules.map((rule) => (
            <button
              key={rule.id}
              type="button"
              onClick={() => setSelection({ kind: "rule", id: rule.id })}
              className={`grid w-full grid-cols-[5rem_minmax(10rem,1fr)_7rem_7rem_1.5fr] items-center border-b border-[var(--line-subtle)] px-4 py-3 text-left text-sm ${selection.kind === "rule" && selection.id === rule.id ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
            >
              <span className="font-mono text-xs text-[var(--ink-muted)]">
                P{rule.priority}
              </span>
              <strong className="truncate font-medium">{rule.name}</strong>
              <span className="text-xs text-[var(--ink-muted)]">
                {rule.conditions.clauses.length} 条件
              </span>
              <span className="text-xs text-[var(--ink-muted)]">
                {rule.costs.length} 代价
              </span>
              <span className="truncate text-xs text-[var(--ink-muted)]">
                {rule.summary || rule.effects.join("；") || "暂无结果"}
              </span>
            </button>
          ))}
        </div>
      );
    }

    if (view === "interactions") {
      return (
        <div className="h-full overflow-y-auto">
          <div className="flex h-11 items-center justify-between border-b border-[var(--line-subtle)] px-4">
            <span className="text-xs font-semibold text-[var(--ink-muted)]">
              体系内部关系与跨体系作用
            </span>
            <button
              type="button"
              onClick={() => {
                if (!interactionsDraft) return;
                const first = draft.elements[0];
                const otherSystem = library.index.systems.find(
                  (entry) => entry.id !== draft.id,
                );
                const interaction: CrossSystemInteraction = {
                  id: createId("interaction"),
                  name: "新跨体系交互",
                  left: first
                    ? {
                        systemId: draft.id,
                        kind: first.kind,
                        targetId: first.id,
                      }
                    : {
                        systemId: draft.id,
                        kind: "system",
                        targetId: draft.id,
                      },
                  right: {
                    systemId: otherSystem?.id ?? draft.id,
                    kind: "system",
                    targetId: otherSystem?.id ?? draft.id,
                  },
                  kind: "compatible",
                  conditions: { mode: "all", clauses: [] },
                  summary: "",
                  metadata: createDefaultPowerTruthMetadata(),
                };
                setInteractionsDraft({
                  ...interactionsDraft,
                  interactions: [
                    ...interactionsDraft.interactions,
                    interaction,
                  ],
                });
                setSelection({ kind: "interaction", id: interaction.id });
              }}
              className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"
            >
              <Plus className="h-3.5 w-3.5" /> 跨体系交互
            </button>
          </div>
          <section>
            <h3 className="border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-4 py-2 text-xs font-semibold text-[var(--ink-muted)]">
              内部关系
            </h3>
            {draft.relations.map((relation) => (
              <button
                key={relation.id}
                type="button"
                onClick={() =>
                  setSelection({ kind: "relation", id: relation.id })
                }
                className="grid w-full grid-cols-[minmax(8rem,1fr)_7rem_minmax(8rem,1fr)_1.5fr] items-center border-b border-[var(--line-subtle)] px-4 py-3 text-left text-sm hover:bg-[var(--hover-bg)]"
              >
                <span className="truncate">{relation.fromId}</span>
                <span className="text-xs text-[var(--accent-cool)]">
                  {relation.kind}
                </span>
                <span className="truncate">{relation.toId}</span>
                <span className="truncate text-xs text-[var(--ink-muted)]">
                  {relation.summary}
                </span>
              </button>
            ))}
          </section>
          <section>
            <h3 className="border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-4 py-2 text-xs font-semibold text-[var(--ink-muted)]">
              跨体系交互
            </h3>
            {interactionsDraft?.interactions.map((interaction) => (
              <button
                key={interaction.id}
                type="button"
                onClick={() =>
                  setSelection({ kind: "interaction", id: interaction.id })
                }
                className={`grid w-full grid-cols-[minmax(8rem,1fr)_7rem_minmax(8rem,1fr)_1.5fr] items-center border-b border-[var(--line-subtle)] px-4 py-3 text-left text-sm ${selection.kind === "interaction" && selection.id === interaction.id ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
              >
                <span className="truncate">
                  {interaction.left.systemId} / {interaction.left.targetId}
                </span>
                <span className="text-xs text-[var(--accent-warm)]">
                  {interaction.kind}
                </span>
                <span className="truncate">
                  {interaction.right.systemId} / {interaction.right.targetId}
                </span>
                <span className="truncate text-xs text-[var(--ink-muted)]">
                  {interaction.summary}
                </span>
              </button>
            ))}
          </section>
        </div>
      );
    }

    if (view === "scales") {
      return (
        <div className="flex h-full min-h-0">
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-[var(--line-subtle)]">
            <div className="flex h-11 items-center justify-between border-b border-[var(--line-subtle)] px-3">
              <span className="text-xs font-semibold text-[var(--ink-muted)]">
                比较维度
              </span>
              <button
                type="button"
                title="新增维度"
                onClick={() => {
                  const dimension = createDimension();
                  setDraft({
                    ...draft,
                    dimensions: [...draft.dimensions, dimension],
                  });
                  setSelection({ kind: "dimension", id: dimension.id });
                }}
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--hover-bg)]"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {draft.dimensions.map((dimension) => (
              <button
                key={dimension.id}
                type="button"
                onClick={() =>
                  setSelection({ kind: "dimension", id: dimension.id })
                }
                className="w-full border-b border-[var(--line-subtle)] px-3 py-2.5 text-left hover:bg-[var(--hover-bg)]"
              >
                <strong className="block truncate text-sm font-medium">
                  {dimension.name}
                </strong>
                <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
                  {dimension.measurement}
                </span>
              </button>
            ))}
          </aside>
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="flex h-11 items-center justify-between border-b border-[var(--line-subtle)] px-4">
              <span className="text-xs font-semibold text-[var(--ink-muted)]">
                场景标尺，不生成永久总战力
              </span>
              <button
                type="button"
                onClick={() => {
                  const benchmark = createBenchmark();
                  setDraft({
                    ...draft,
                    benchmarks: [...draft.benchmarks, benchmark],
                  });
                  setSelection({ kind: "benchmark", id: benchmark.id });
                }}
                className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"
              >
                <Plus className="h-3.5 w-3.5" /> 新增标尺
              </button>
            </div>
            {draft.benchmarks.map((benchmark) => (
              <button
                key={benchmark.id}
                type="button"
                onClick={() =>
                  setSelection({ kind: "benchmark", id: benchmark.id })
                }
                className={`block w-full border-b border-[var(--line-subtle)] px-4 py-4 text-left ${selection.kind === "benchmark" && selection.id === benchmark.id ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
              >
                <strong className="text-sm font-semibold">
                  {benchmark.name}
                </strong>
                <span className="ml-2 text-xs text-[var(--ink-muted)]">
                  {benchmark.context || "未设置场景"}
                </span>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {draft.dimensions.slice(0, 8).map((dimension) => {
                    const value = benchmark.values.find(
                      (candidate) => candidate.dimensionId === dimension.id,
                    );
                    const maximum = Math.max(
                      value?.maximum ?? value?.minimum ?? 0,
                      0,
                    );
                    return (
                      <div
                        key={dimension.id}
                        className="grid grid-cols-[5rem_1fr_4rem] items-center gap-2 text-xs"
                      >
                        <span className="truncate text-[var(--ink-muted)]">
                          {dimension.name}
                        </span>
                        <span className="h-1.5 overflow-hidden rounded-sm bg-[var(--paper-inset)]">
                          <span
                            className="block h-full bg-[var(--accent-cool)]"
                            style={{ width: `${Math.min(100, maximum)}%` }}
                          />
                        </span>
                        <span className="truncate text-right font-mono text-[var(--ink-muted)]">
                          {value?.label ||
                            (value?.minimum === null ||
                            value?.minimum === undefined
                              ? "—"
                              : value.minimum === value.maximum
                                ? value.minimum
                                : `${value.minimum}-${value.maximum ?? "?"}`)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </button>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="h-full overflow-y-auto">
        <div className="grid grid-cols-3 border-b border-[var(--line)]">
          {(["error", "warning", "info"] as const).map((severity) => (
            <div
              key={severity}
              className="border-r border-[var(--line-subtle)] px-5 py-4 last:border-r-0"
            >
              <div className="text-2xl font-semibold">
                {
                  auditIssues.filter((issue) => issue.severity === severity)
                    .length
                }
              </div>
              <div className="mt-1 text-xs text-[var(--ink-muted)]">
                {severity === "error"
                  ? "阻断问题"
                  : severity === "warning"
                    ? "风险"
                    : "提示"}
              </div>
            </div>
          ))}
        </div>
        {auditIssues.map((issue) => (
          <button
            key={issue.id}
            type="button"
            onClick={() => {
              if (issue.targetKind === "element" && issue.targetId) {
                setView("capabilities");
                setSelection({ kind: "element", id: issue.targetId });
              } else if (issue.targetKind === "track" && issue.targetId) {
                setView("states");
                setSelectedTrackId(issue.targetId);
                setSelection({ kind: "track", id: issue.targetId });
              } else if (issue.targetKind === "rule" && issue.targetId) {
                setView("rules");
                setSelection({ kind: "rule", id: issue.targetId });
              } else if (issue.targetKind === "dimension" && issue.targetId) {
                setView("scales");
                setSelection({ kind: "dimension", id: issue.targetId });
              } else {
                setSelection({ kind: "system" });
              }
            }}
            className="flex w-full items-start gap-3 border-b border-[var(--line-subtle)] px-5 py-4 text-left hover:bg-[var(--hover-bg)]"
          >
            <span
              className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${issue.severity === "error" ? "bg-[var(--error)]" : issue.severity === "warning" ? "bg-[var(--warning)]" : "bg-[var(--info)]"}`}
            />
            <span className="min-w-0">
              <strong className="block text-sm font-medium">
                {issue.title}
              </strong>
              <span className="mt-1 block text-xs leading-5 text-[var(--ink-muted)]">
                {issue.detail}
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <header className="flex min-h-13 shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-2">
        <Waypoints className="h-4 w-4 text-[var(--accent-warm)]" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1">
            <h1 className="truncate text-sm font-semibold">力量体系</h1>
            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              aria-label="查看力量体系设计说明"
              title="力量体系设计说明"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <CircleHelp className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="truncate text-xs text-[var(--ink-muted)]">
            {projectTitle}
          </p>
        </div>
        {draft && (
          <button
            type="button"
            onClick={() => setSelection({ kind: "system" })}
            className="ml-2 min-w-0 truncate border-l border-[var(--line)] pl-3 text-sm font-medium hover:text-[var(--accent-warm)]"
          >
            {draft.name}
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {headerActions}
          {error && (
            <span
              className="max-w-80 truncate text-xs text-[var(--error)]"
              title={error}
            >
              {error}
            </span>
          )}
          <span
            className={`text-xs ${isDirty ? "text-[var(--warning)]" : "text-[var(--success)]"}`}
          >
            {isDirty ? "有未保存修改" : "已保存"}
          </span>
          <button
            type="button"
            disabled={!isDirty || isSaving}
            onClick={() => void save()}
            className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-white disabled:opacity-40"
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            保存
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--line-subtle)] bg-[var(--paper-elevated)]/45">
          <div className="border-b border-[var(--line-subtle)] p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[var(--ink-subtle)]" />
              <input
                className={`${inputClass} h-9 pl-8`}
                value={systemSearch}
                placeholder="搜索体系"
                onChange={(event) => setSystemSearch(event.target.value)}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filteredSystems.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSelectedSystemId(entry.id)}
                className={`w-full border-b border-[var(--line-subtle)] px-3 py-3 text-left ${selectedSystemId === entry.id ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
              >
                <div className="flex items-center gap-2">
                  <Layers3 className="h-3.5 w-3.5 shrink-0 text-[var(--accent-cool)]" />
                  <strong className="min-w-0 flex-1 truncate text-sm font-medium">
                    {entry.name}
                  </strong>
                  <span className="text-xs text-[var(--ink-subtle)]">
                    {entry.status}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 pl-5 text-xs leading-4 text-[var(--ink-muted)]">
                  {entry.summary || "暂无摘要"}
                </p>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="flex h-11 shrink-0 items-center justify-center gap-1.5 border-t border-[var(--line)] text-sm font-medium text-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"
          >
            <Plus className="h-4 w-4" /> 新建体系
          </button>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <nav className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--line-subtle)] px-2">
            {VIEW_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setView(item.id)}
                  className={`flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium ${view === item.id ? "border-[var(--accent-warm)] text-[var(--ink)]" : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"}`}
                >
                  <Icon className="h-3.5 w-3.5" /> {item.label}
                </button>
              );
            })}
          </nav>
          <div className="min-h-0 flex-1">{renderCenter()}</div>
        </main>
        {draft && interactionsDraft && (
          <aside className="w-[22rem] shrink-0 overflow-y-auto border-l border-[var(--line-subtle)] bg-[var(--paper-elevated)]/35 max-xl:w-80">
            <PowerSystemInspector
              selection={selection}
              record={draft}
              meta={library.meta}
              index={library.index}
              interactions={interactionsDraft}
              onChange={setDraft}
              onInteractionsChange={setInteractionsDraft}
              onSelectionChange={setSelection}
            />
          </aside>
        )}
      </div>
      {isCreateOpen && (
        <CreateSystemDialog
          library={library}
          onClose={() => setIsCreateOpen(false)}
          onCreate={(name, typeId) => {
            setError(null);
            void repository
              .createSystem(library, {
                id: createId("power-system"),
                name,
                typeId,
              })
              .then((result) => {
                setLibrary(result.library);
                setSystem(result.system);
                setDraft(result.system.record);
                setPageDraft(result.system.pageContent);
                setSelectedSystemId(result.system.record.id);
                setIsCreateOpen(false);
              })
              .catch((cause) => setError(errorMessage(cause)));
          }}
        />
      )}
      {isHelpOpen && (
        <PowerSystemHelpDialog onClose={() => setIsHelpOpen(false)} />
      )}
    </div>
  );
}
