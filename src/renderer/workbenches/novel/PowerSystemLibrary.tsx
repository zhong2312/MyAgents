import {
  AlertTriangle,
  Atom,
  BookOpenText,
  BrainCircuit,
  CheckCircle2,
  CircleGauge,
  FlaskConical,
  GitBranch,
  Link2,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  Sparkles,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { CustomSelect, type WorkbenchStorage } from "@/workbench-sdk";

import MarkdownVisualEditor from "./MarkdownVisualEditor";
import PowerSystemGraph from "./PowerSystemGraph";
import PowerSystemInspector, {
  type PowerInspectorSelection,
} from "./PowerSystemInspector";
import {
  auditPowerSystem,
  type PowerSystemAuditIssue,
} from "./powerSystemAudit";
import {
  createDefaultPowerTruthMetadata,
  createDefaultStateContract,
  createPowerSystemRecord,
} from "./powerSystemDefaults";
import {
  createNovelPowerSystemRepository,
  type LoadedPowerSystem,
  type LoadedPowerSystemLibrary,
} from "./powerSystemRepository";
import type {
  PowerCatalog,
  PowerCatalogEntity,
  PowerCatalogKind,
  PowerCapability,
  PowerConnection,
  PowerConditionGroup,
  PowerConnections,
  PowerEntityReference,
  PowerFoundation,
  PowerMedium,
  PowerMethod,
  PowerMetricDimension,
  PowerPrinciple,
  PowerProgressionState,
  PowerProgressionTrack,
  PowerProgressionTransition,
  PowerResource,
  PowerSystemRecord,
  PowerTheory,
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
  | "methods"
  | "theories"
  | "capabilities"
  | "resources"
  | "quality"
  | "connections"
  | "audit"
  | "notes";

const VIEW_ITEMS: readonly {
  readonly id: PowerView;
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  { id: "architecture", label: "体系架构", icon: Network },
  { id: "states", label: "成长状态", icon: GitBranch },
  { id: "methods", label: "发展方法", icon: ScrollText },
  { id: "theories", label: "理论模型", icon: BrainCircuit },
  { id: "capabilities", label: "能力目录", icon: Zap },
  { id: "resources", label: "资源条件", icon: FlaskConical },
  { id: "quality", label: "质量边界", icon: CircleGauge },
  { id: "connections", label: "关联矩阵", icon: Link2 },
  { id: "audit", label: "一致性审查", icon: AlertTriangle },
  { id: "notes", label: "体系说明", icon: BookOpenText },
];

const CATALOG_LABELS: Readonly<Record<PowerCatalogKind, string>> = {
  foundation: "力量本源",
  medium: "运行介质",
  principle: "底层法则",
  resource: "资源",
  theory: "理论模型",
  method: "发展方法",
  capability: "能力",
};

const CONNECTION_LABELS: Readonly<Record<PowerConnection["kind"], string>> = {
  association: "通用关联",
  "method-application": "方法应用",
  "resource-requirement": "资源需求",
  "capability-access": "能力准入",
  "system-interaction": "体系交互",
};

const CONNECTION_FILTERS: readonly ("all" | PowerConnection["kind"])[] = [
  "all",
  ...Object.keys(CONNECTION_LABELS),
] as ("all" | PowerConnection["kind"])[];

const EMPTY_INSPECTOR_RECORD = createPowerSystemRecord({
  id: "unassigned-system",
  name: "尚未创建体系",
  typeId: "blank",
});

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function baseCatalogEntity(kind: PowerCatalogKind) {
  return {
    id: createId(kind),
    name: `新${CATALOG_LABELS[kind]}`,
    aliases: [],
    subtypeId: "",
    summary: "",
    tags: [],
    metadata: createDefaultPowerTruthMetadata(),
  };
}

function createCatalogEntity(kind: PowerCatalogKind): PowerCatalogEntity {
  const base = baseCatalogEntity(kind);
  switch (kind) {
    case "foundation":
      return {
        ...base,
        kind,
        foundationType: "unknown",
        availability: "unknown",
        manifestation: "",
      } satisfies PowerFoundation;
    case "medium":
      return {
        ...base,
        kind,
        mediumType: "unknown",
        carrier: "",
        circulation: "",
        storage: "",
        loss: "",
      } satisfies PowerMedium;
    case "principle":
      return {
        ...base,
        kind,
        principleType: "custom",
        scope: "system",
        statements: [],
        conditions: [],
        exceptions: [],
        priority: 100,
      } satisfies PowerPrinciple;
    case "resource":
      return {
        ...base,
        kind,
        resourceType: "other",
        measurement: "unknown",
        unit: "",
        qualityDimensions: [],
        replenishment: "",
        scarcity: "",
      } satisfies PowerResource;
    case "theory":
      return {
        ...base,
        kind,
        representationType: "unknown",
        substrateRefs: [],
        topology: {
          spatialDimensions: null,
          nodeDefinition: "",
          connectionDefinition: "",
          structure: "",
        },
        operations: [],
        controlStrategy: "",
        complexity: {
          memory: "unknown",
          parallelism: "unknown",
          abstraction: "unknown",
          dynamism: "unknown",
        },
        assumptions: [],
        invariants: [],
        failureModes: [],
      } satisfies PowerTheory;
    case "method":
      return {
        ...base,
        kind,
        acquisition: "unknown",
        roles: [],
        theoryRefs: [],
        procedure: "",
        phases: [],
        outputs: [],
        failureConsequences: [],
      } satisfies PowerMethod;
    case "capability":
      return {
        ...base,
        kind,
        capabilityType: "custom",
        activation: "active",
        effect: "",
        target: "",
        range: "",
        duration: "",
        costs: [],
        limitations: [],
        sideEffects: [],
        countermeasures: [],
      } satisfies PowerCapability;
  }
}

function addCatalogEntity(
  catalog: PowerCatalog,
  entity: PowerCatalogEntity,
): PowerCatalog {
  switch (entity.kind) {
    case "foundation":
      return { ...catalog, foundations: [...catalog.foundations, entity] };
    case "medium":
      return { ...catalog, mediums: [...catalog.mediums, entity] };
    case "principle":
      return { ...catalog, principles: [...catalog.principles, entity] };
    case "resource":
      return { ...catalog, resources: [...catalog.resources, entity] };
    case "theory":
      return { ...catalog, theories: [...catalog.theories, entity] };
    case "method":
      return { ...catalog, methods: [...catalog.methods, entity] };
    case "capability":
      return { ...catalog, capabilities: [...catalog.capabilities, entity] };
  }
}

function removeCatalogEntity(catalog: PowerCatalog, id: string): PowerCatalog {
  return {
    ...catalog,
    foundations: catalog.foundations.filter((item) => item.id !== id),
    mediums: catalog.mediums.filter((item) => item.id !== id),
    principles: catalog.principles.filter((item) => item.id !== id),
    resources: catalog.resources.filter((item) => item.id !== id),
    theories: catalog.theories.filter((item) => item.id !== id),
    methods: catalog.methods.filter((item) => item.id !== id),
    capabilities: catalog.capabilities.filter((item) => item.id !== id),
  };
}

function createTrack(): PowerProgressionTrack {
  return {
    id: createId("track"),
    name: "新成长轨道",
    subtypeId: "",
    summary: "",
    mode: "ordered",
    states: [],
    transitions: [],
    metadata: createDefaultPowerTruthMetadata(),
  };
}

function createState(order: number): PowerProgressionState {
  return {
    id: createId("state"),
    name: `新状态 ${order + 1}`,
    aliases: [],
    stateType: "stage",
    summary: "",
    order,
    contract: createDefaultStateContract(),
    metadata: createDefaultPowerTruthMetadata(),
  };
}

function createTransition(
  track: PowerProgressionTrack,
): PowerProgressionTransition | null {
  const ordered = [...track.states].sort(
    (left, right) => left.order - right.order,
  );
  const target = ordered.at(-1);
  if (!target) return null;
  const source = ordered.length > 1 ? ordered.at(-2) : null;
  return {
    id: createId("transition"),
    name: source ? `${source.name} → ${target.name}` : `进入${target.name}`,
    fromStateId: source?.id ?? null,
    toStateId: target.id,
    transitionType: "advance",
    conditions: { mode: "all", clauses: [] },
    qualityCarryover: "preserve",
    qualityRule: "",
    outcomes: [],
    failureModes: [],
    reversible: false,
  };
}

function createDimension(
  category: PowerMetricDimension["category"],
): PowerMetricDimension {
  return {
    id: createId(category),
    name: category === "quality" ? "新质量维度" : "新边界维度",
    category,
    measurement: "descriptive",
    unit: "",
    lowLabel: "",
    highLabel: "",
    description: "",
  };
}

function sameReference(
  left: PowerEntityReference,
  right: PowerEntityReference,
): boolean {
  if (
    left.namespace !== right.namespace ||
    left.kind !== right.kind ||
    left.targetId !== right.targetId
  ) {
    return false;
  }
  return (
    left.namespace !== "system" ||
    (right.namespace === "system" && left.systemId === right.systemId)
  );
}

function matchesAnyReference(
  reference: PowerEntityReference,
  targets: readonly PowerEntityReference[],
): boolean {
  return targets.some((target) => sameReference(reference, target));
}

function cleanConditionReferences(
  group: PowerConditionGroup,
  targets: readonly PowerEntityReference[],
): PowerConditionGroup {
  return {
    ...group,
    clauses: group.clauses.map((clause) =>
      clause.subjectRef && matchesAnyReference(clause.subjectRef, targets)
        ? { ...clause, subjectRef: null }
        : clause,
    ),
  };
}

function cleanRecordReferences(
  record: PowerSystemRecord,
  targets: readonly PowerEntityReference[],
): PowerSystemRecord {
  return {
    ...record,
    tracks: record.tracks.map((track) => ({
      ...track,
      states: track.states.map((state) => ({
        ...state,
        contract: {
          ...state.contract,
          entryConditions: cleanConditionReferences(
            state.contract.entryConditions,
            targets,
          ),
          maintenanceConditions: cleanConditionReferences(
            state.contract.maintenanceConditions,
            targets,
          ),
          exitConditions: cleanConditionReferences(
            state.contract.exitConditions,
            targets,
          ),
        },
      })),
      transitions: track.transitions.map((transition) => ({
        ...transition,
        conditions: cleanConditionReferences(transition.conditions, targets),
      })),
    })),
  };
}

function cleanCatalogReferences(
  catalog: PowerCatalog,
  targets: readonly PowerEntityReference[],
): PowerCatalog {
  return {
    ...catalog,
    theories: catalog.theories.map((theory) => ({
      ...theory,
      substrateRefs: theory.substrateRefs.filter(
        (reference) => !matchesAnyReference(reference, targets),
      ),
    })),
    methods: catalog.methods.map((method) => ({
      ...method,
      theoryRefs: method.theoryRefs.filter(
        (reference) => !matchesAnyReference(reference, targets),
      ),
    })),
  };
}

function connectionDimensionMatches(
  connection: PowerConnection,
  dimensionId: string,
  targets: readonly PowerEntityReference[],
): boolean {
  if (connection.target.namespace !== "system") return false;
  const systemId = connection.target.systemId;
  return targets.some(
    (target) =>
      target.namespace === "system" &&
      target.systemId === systemId &&
      target.targetId === dimensionId &&
      ["quality-dimension", "boundary-dimension"].includes(target.kind),
  );
}

function cleanConnectionReferences(
  connections: PowerConnections,
  targets: readonly PowerEntityReference[],
): PowerConnections {
  return {
    ...connections,
    connections: connections.connections
      .filter(
        (connection) =>
          !matchesAnyReference(connection.source, targets) &&
          !matchesAnyReference(connection.target, targets),
      )
      .map((connection): PowerConnection => {
        const conditions = cleanConditionReferences(
          connection.conditions,
          targets,
        );
        if (connection.kind === "method-application") {
          return {
            ...connection,
            conditions,
            theoryRef:
              connection.theoryRef &&
              matchesAnyReference(connection.theoryRef, targets)
                ? null
                : connection.theoryRef,
            qualityEffects: connection.qualityEffects.filter(
              (effect) =>
                !connectionDimensionMatches(
                  connection,
                  effect.dimensionId,
                  targets,
                ),
            ),
            boundaryEffects: connection.boundaryEffects.filter(
              (effect) =>
                !connectionDimensionMatches(
                  connection,
                  effect.dimensionId,
                  targets,
                ),
            ),
          };
        }
        if (connection.kind === "resource-requirement") {
          return {
            ...connection,
            conditions,
            substituteRefs: connection.substituteRefs.filter(
              (reference) => !matchesAnyReference(reference, targets),
            ),
          };
        }
        return { ...connection, conditions };
      }),
  };
}

function referenceName(
  reference: PowerEntityReference,
  catalog: PowerCatalog,
  record: PowerSystemRecord | null,
  library: LoadedPowerSystemLibrary,
): string {
  if (reference.namespace === "external") return reference.targetId;
  if (reference.namespace === "catalog") {
    const entities: readonly PowerCatalogEntity[] = [
      ...catalog.foundations,
      ...catalog.mediums,
      ...catalog.principles,
      ...catalog.resources,
      ...catalog.theories,
      ...catalog.methods,
      ...catalog.capabilities,
    ];
    return (
      entities.find((item) => item.id === reference.targetId)?.name ??
      reference.targetId
    );
  }
  if (reference.kind === "system") {
    return (
      library.index.systems.find((item) => item.id === reference.systemId)
        ?.name ?? reference.systemId
    );
  }
  if (record?.id === reference.systemId) {
    if (
      reference.kind === "quality-dimension" ||
      reference.kind === "boundary-dimension"
    ) {
      return (
        record.dimensions.find((item) => item.id === reference.targetId)
          ?.name ?? reference.targetId
      );
    }
    for (const track of record.tracks) {
      if (reference.kind === "track" && track.id === reference.targetId)
        return track.name;
      const state = track.states.find((item) => item.id === reference.targetId);
      if (reference.kind === "state" && state) return state.name;
      const transition = track.transitions.find(
        (item) => item.id === reference.targetId,
      );
      if (reference.kind === "transition" && transition) return transition.name;
    }
  }
  return reference.targetId;
}

function EntityList({
  title,
  description,
  entities,
  selection,
  onAdd,
  onSelect,
}: {
  readonly title: string;
  readonly description: string;
  readonly entities: readonly PowerCatalogEntity[];
  readonly selection: PowerInspectorSelection;
  readonly onAdd: () => void;
  readonly onSelect: (entity: PowerCatalogEntity) => void;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--ink)]">{title}</h2>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
            {description}
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="ns-compact-primary-button"
        >
          <Plus className="h-3.5 w-3.5" /> 添加
        </button>
      </div>
      {entities.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-8 text-center text-xs text-[var(--ink-muted)]">
          尚未建立{title}。只创建在故事中真正会被使用的对象。
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
          {entities.map((entity) => {
            const active =
              selection.kind === "catalog" && selection.id === entity.id;
            return (
              <button
                key={entity.id}
                type="button"
                onClick={() => onSelect(entity)}
                className={`min-h-20 rounded-lg border px-3 py-2 text-left transition-colors ${
                  active
                    ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]"
                    : "border-[var(--line)] bg-[var(--paper-elevated)] hover:border-[var(--line-strong)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="truncate text-sm font-semibold text-[var(--ink)]">
                    {entity.name}
                  </strong>
                  <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                    {CATALOG_LABELS[entity.kind]}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-4 text-[var(--ink-muted)]">
                  {entity.summary || "等待补充定义、用途与边界"}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CreateSystemDialog({
  types,
  onClose,
  onCreate,
}: {
  readonly types: LoadedPowerSystemLibrary["meta"]["systemTypes"];
  readonly onClose: () => void;
  readonly onCreate: (name: string, typeId: string) => void;
}) {
  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState(types[0]?.id ?? "blank");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <header className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              创建力量体系
            </h2>
            <p className="text-xs text-[var(--ink-muted)]">
              类型只提供起始设计契约，不限制后续结构。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ns-icon-button"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-4 p-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              体系名称
            </span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent-warm)]"
              placeholder="例如：灵能、符文魔法、义体协议"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              起始类型
            </span>
            <CustomSelect
              value={typeId}
              options={types.map((type) => ({
                value: type.id,
                label: `${type.name} · ${type.description}`,
              }))}
              onChange={setTypeId}
              size="toolbar"
            />
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-4 py-3">
          <button type="button" onClick={onClose} className="ns-compact-button">
            取消
          </button>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() => onCreate(name.trim(), typeId)}
            className="ns-compact-primary-button disabled:opacity-50"
          >
            创建体系
          </button>
        </footer>
      </div>
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
  const [loadedSystem, setLoadedSystem] = useState<LoadedPowerSystem | null>(
    null,
  );
  const [recordDraft, setRecordDraft] = useState<PowerSystemRecord | null>(
    null,
  );
  const [catalogDraft, setCatalogDraft] = useState<PowerCatalog | null>(null);
  const [connectionsDraft, setConnectionsDraft] =
    useState<PowerConnections | null>(null);
  const [pageDraft, setPageDraft] = useState("");
  const [view, setView] = useState<PowerView>("architecture");
  const [selection, setSelection] = useState<PowerInspectorSelection>({
    kind: "system",
  });
  const [search, setSearch] = useState("");
  const [connectionFilter, setConnectionFilter] = useState<
    "all" | PowerConnection["kind"]
  >("all");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [dirty, setDirty] = useState({
    record: false,
    catalog: false,
    connections: false,
    page: false,
  });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLibrary = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await repository.load();
      setLibrary(next);
      setCatalogDraft(next?.catalog ?? null);
      setConnectionsDraft(next?.connections ?? null);
      if (next?.index.systems[0]) {
        const system = await repository.loadSystem(next.index.systems[0]);
        setLoadedSystem(system);
        setRecordDraft(system.record);
        setPageDraft(system.pageContent);
      } else {
        setLoadedSystem(null);
        setRecordDraft(null);
        setPageDraft("");
      }
      setSelection({ kind: "system" });
      setDirty({
        record: false,
        catalog: false,
        connections: false,
        page: false,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);
  void isActive;

  const hasDirty = Object.values(dirty).some(Boolean);
  const updateRecord = (record: PowerSystemRecord) => {
    setRecordDraft(record);
    setDirty((current) => ({ ...current, record: true }));
  };
  const updateCatalog = (catalog: PowerCatalog) => {
    setCatalogDraft(catalog);
    setDirty((current) => ({ ...current, catalog: true }));
  };
  const updateConnections = (connections: PowerConnections) => {
    setConnectionsDraft(connections);
    setDirty((current) => ({ ...current, connections: true }));
  };

  const selectSystem = async (systemId: string) => {
    if (!library || systemId === recordDraft?.id) return;
    if (
      hasDirty &&
      !window.confirm("当前修改尚未保存。切换体系会放弃这些修改，是否继续？")
    )
      return;
    const entry = library.index.systems.find((item) => item.id === systemId);
    if (!entry) return;
    setIsLoading(true);
    setError(null);
    try {
      const system = await repository.loadSystem(entry);
      setLoadedSystem(system);
      setRecordDraft(system.record);
      setCatalogDraft(library.catalog);
      setConnectionsDraft(library.connections);
      setPageDraft(system.pageContent);
      setSelection({ kind: "system" });
      setDirty({
        record: false,
        catalog: false,
        connections: false,
        page: false,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  };

  const initialize = async () => {
    if (
      !window.confirm(
        "将以新版通用力量模型初始化该项目。已有旧版力量体系文件不会被迁移，是否继续？",
      )
    )
      return;
    setIsLoading(true);
    setError(null);
    try {
      const next = await repository.initialize();
      setLibrary(next);
      setCatalogDraft(next.catalog);
      setConnectionsDraft(next.connections);
      setMessage("力量体系工作区已初始化");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  };

  const save = async () => {
    if (!library || !catalogDraft || !connectionsDraft || isSaving) return;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await repository.saveWorkspace(library, loadedSystem, {
        ...(recordDraft && loadedSystem && (dirty.record || dirty.page)
          ? { record: recordDraft, pageContent: pageDraft }
          : {}),
        ...(dirty.catalog ? { catalog: catalogDraft } : {}),
        ...(dirty.connections ? { connections: connectionsDraft } : {}),
      });
      const nextLibrary = result.library;
      const nextSystem = result.system;
      setLibrary(nextLibrary);
      setLoadedSystem(nextSystem);
      setRecordDraft(nextSystem?.record ?? null);
      setCatalogDraft(nextLibrary.catalog);
      setConnectionsDraft(nextLibrary.connections);
      setDirty({
        record: false,
        catalog: false,
        connections: false,
        page: false,
      });
      setMessage("力量体系已保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const createSystem = async (name: string, typeId: string) => {
    if (!library) return;
    if (
      (dirty.record || dirty.page) &&
      !window.confirm(
        "当前体系的修改尚未保存。创建新体系会放弃这些修改，是否继续？",
      )
    ) {
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      let current = library;
      if (
        catalogDraft &&
        connectionsDraft &&
        (dirty.catalog || dirty.connections)
      ) {
        current = await repository.saveLibrary(
          current,
          catalogDraft,
          connectionsDraft,
        );
      }
      const result = await repository.createSystem(current, {
        id: createId("power-system"),
        name,
        typeId,
      });
      setLibrary(result.library);
      setLoadedSystem(result.system);
      setRecordDraft(result.system.record);
      setCatalogDraft(result.library.catalog);
      setConnectionsDraft(result.library.connections);
      setPageDraft(result.system.pageContent);
      setDirty({
        record: false,
        catalog: false,
        connections: false,
        page: false,
      });
      setSelection({ kind: "system" });
      setIsCreateOpen(false);
      setMessage(`已创建“${name}”`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  };

  const addEntity = (kind: PowerCatalogKind) => {
    if (!catalogDraft) return;
    const entity = createCatalogEntity(kind);
    updateCatalog(addCatalogEntity(catalogDraft, entity));
    setSelection({ kind: "catalog", id: entity.id });
  };

  const addTrack = () => {
    if (!recordDraft) return;
    const track = createTrack();
    updateRecord({ ...recordDraft, tracks: [...recordDraft.tracks, track] });
    setSelection({ kind: "track", id: track.id });
  };

  const addState = (trackId: string) => {
    if (!recordDraft) return;
    const track = recordDraft.tracks.find((item) => item.id === trackId);
    if (!track) return;
    const state = createState(
      Math.max(-1, ...track.states.map((item) => item.order)) + 1,
    );
    updateRecord({
      ...recordDraft,
      tracks: recordDraft.tracks.map((item) =>
        item.id === trackId
          ? { ...item, states: [...item.states, state] }
          : item,
      ),
    });
    setSelection({ kind: "state", trackId, id: state.id });
  };

  const addTransition = (trackId: string) => {
    if (!recordDraft) return;
    const track = recordDraft.tracks.find((item) => item.id === trackId);
    if (!track) return;
    const transition = createTransition(track);
    if (!transition) {
      setError("请先在成长轨道中建立至少一个状态");
      return;
    }
    updateRecord({
      ...recordDraft,
      tracks: recordDraft.tracks.map((item) =>
        item.id === trackId
          ? { ...item, transitions: [...item.transitions, transition] }
          : item,
      ),
    });
    setSelection({ kind: "transition", trackId, id: transition.id });
  };

  const addDimension = (category: PowerMetricDimension["category"]) => {
    if (!recordDraft) return;
    const dimension = createDimension(category);
    updateRecord({
      ...recordDraft,
      dimensions: [...recordDraft.dimensions, dimension],
    });
    setSelection({ kind: "dimension", id: dimension.id });
  };

  const addConnection = (kind: PowerConnection["kind"]) => {
    if (!library || !catalogDraft || !connectionsDraft || !recordDraft) {
      setError("请先创建并选择一个力量体系");
      return;
    }
    const systemRef: PowerEntityReference = {
      namespace: "system",
      systemId: recordDraft.id,
      kind: "system",
      targetId: recordDraft.id,
    };
    const common = {
      id: createId(kind),
      conditions: { mode: "all" as const, clauses: [] },
      note: "",
      metadata: createDefaultPowerTruthMetadata(),
    };
    let connection: PowerConnection;
    if (kind === "method-application") {
      const method = catalogDraft.methods[0];
      if (!method) return setError("请先建立至少一个发展方法");
      connection = {
        ...common,
        kind,
        source: { namespace: "catalog", kind: "method", targetId: method.id },
        target: systemRef,
        role: "advance",
        compatibility: "native",
        theoryRef: method.theoryRefs[0] ?? null,
        executionModel: "",
        efficiency: { mode: "qualitative", value: null, note: "" },
        qualityEffects: [],
        boundaryEffects: [],
        outcomes: [],
        failureModes: [],
      };
    } else if (kind === "resource-requirement") {
      const resource = catalogDraft.resources[0];
      if (!resource) return setError("请先建立至少一个资源");
      connection = {
        ...common,
        kind,
        source: {
          namespace: "catalog",
          kind: "resource",
          targetId: resource.id,
        },
        target: systemRef,
        purpose: "develop",
        amount: {
          mode: "descriptive",
          minimum: null,
          maximum: null,
          value: "",
          unit: "",
        },
        quality: "",
        consumed: true,
        substituteRefs: [],
        shortageConsequence: "",
      };
    } else if (kind === "capability-access") {
      const capability = catalogDraft.capabilities[0];
      if (!capability) return setError("请先建立至少一个能力");
      connection = {
        ...common,
        kind,
        source: systemRef,
        target: {
          namespace: "catalog",
          kind: "capability",
          targetId: capability.id,
        },
        accessMode: "learnable",
        mastery: "available",
      };
    } else if (kind === "system-interaction") {
      const target = library.index.systems.find(
        (item) => item.id !== recordDraft.id,
      );
      if (!target) return setError("体系交互至少需要两个力量体系");
      connection = {
        ...common,
        kind,
        source: systemRef,
        target: {
          namespace: "system",
          systemId: target.id,
          kind: "system",
          targetId: target.id,
        },
        interaction: "compatible",
        effect: "",
      };
    } else {
      const target =
        catalogDraft.foundations[0] ??
        catalogDraft.mediums[0] ??
        catalogDraft.principles[0];
      if (!target) return setError("请先建立本源、介质或法则，再创建通用关联");
      connection = {
        ...common,
        kind,
        source: systemRef,
        target: {
          namespace: "catalog",
          kind: target.kind,
          targetId: target.id,
        },
        relation: "uses",
        compatibility: "native",
      };
    }
    updateConnections({
      ...connectionsDraft,
      connections: [...connectionsDraft.connections, connection],
    });
    setSelection({ kind: "connection", id: connection.id });
    setView("connections");
  };

  const deleteSelection = () => {
    if (!catalogDraft || !connectionsDraft) return;
    if (!window.confirm("确认删除当前对象？相关连接和局部引用会同时清理。"))
      return;
    const applyReferenceCleanup = (
      targets: readonly PowerEntityReference[],
      nextRecord: PowerSystemRecord | null,
      nextCatalog: PowerCatalog,
    ) => {
      if (nextRecord) {
        updateRecord(cleanRecordReferences(nextRecord, targets));
      }
      updateCatalog(cleanCatalogReferences(nextCatalog, targets));
      updateConnections(cleanConnectionReferences(connectionsDraft, targets));
    };
    let deleted = false;
    if (selection.kind === "catalog") {
      const entity = [
        ...catalogDraft.foundations,
        ...catalogDraft.mediums,
        ...catalogDraft.principles,
        ...catalogDraft.resources,
        ...catalogDraft.theories,
        ...catalogDraft.methods,
        ...catalogDraft.capabilities,
      ].find((item) => item.id === selection.id);
      if (!entity) return;
      applyReferenceCleanup(
        [
          {
            namespace: "catalog",
            kind: entity.kind,
            targetId: entity.id,
          },
        ],
        recordDraft,
        removeCatalogEntity(catalogDraft, entity.id),
      );
      deleted = true;
    } else if (selection.kind === "connection") {
      updateConnections({
        ...connectionsDraft,
        connections: connectionsDraft.connections.filter(
          (item) => item.id !== selection.id,
        ),
      });
      deleted = true;
    } else if (recordDraft && selection.kind === "track") {
      const track = recordDraft.tracks.find((item) => item.id === selection.id);
      if (!track) return;
      const targets: PowerEntityReference[] = [
        {
          namespace: "system",
          systemId: recordDraft.id,
          kind: "track",
          targetId: track.id,
        },
        ...track.states.map(
          (state): PowerEntityReference => ({
            namespace: "system",
            systemId: recordDraft.id,
            kind: "state",
            targetId: state.id,
          }),
        ),
        ...track.transitions.map(
          (transition): PowerEntityReference => ({
            namespace: "system",
            systemId: recordDraft.id,
            kind: "transition",
            targetId: transition.id,
          }),
        ),
      ];
      applyReferenceCleanup(
        targets,
        {
          ...recordDraft,
          tracks: recordDraft.tracks.filter((item) => item.id !== track.id),
        },
        catalogDraft,
      );
      deleted = true;
    } else if (recordDraft && selection.kind === "state") {
      const track = recordDraft.tracks.find(
        (item) => item.id === selection.trackId,
      );
      if (!track?.states.some((item) => item.id === selection.id)) return;
      const removedTransitions = track.transitions.filter(
        (item) =>
          item.fromStateId === selection.id || item.toStateId === selection.id,
      );
      const targets: PowerEntityReference[] = [
        {
          namespace: "system",
          systemId: recordDraft.id,
          kind: "state",
          targetId: selection.id,
        },
        ...removedTransitions.map(
          (transition): PowerEntityReference => ({
            namespace: "system",
            systemId: recordDraft.id,
            kind: "transition",
            targetId: transition.id,
          }),
        ),
      ];
      applyReferenceCleanup(
        targets,
        {
          ...recordDraft,
          tracks: recordDraft.tracks.map((item) =>
            item.id === track.id
              ? {
                  ...item,
                  states: item.states.filter(
                    (state) => state.id !== selection.id,
                  ),
                  transitions: item.transitions.filter(
                    (transition) =>
                      !removedTransitions.some(
                        (removed) => removed.id === transition.id,
                      ),
                  ),
                }
              : item,
          ),
        },
        catalogDraft,
      );
      deleted = true;
    } else if (recordDraft && selection.kind === "transition") {
      const track = recordDraft.tracks.find(
        (item) => item.id === selection.trackId,
      );
      if (!track?.transitions.some((item) => item.id === selection.id)) return;
      applyReferenceCleanup(
        [
          {
            namespace: "system",
            systemId: recordDraft.id,
            kind: "transition",
            targetId: selection.id,
          },
        ],
        {
          ...recordDraft,
          tracks: recordDraft.tracks.map((item) =>
            item.id === track.id
              ? {
                  ...item,
                  transitions: item.transitions.filter(
                    (transition) => transition.id !== selection.id,
                  ),
                }
              : item,
          ),
        },
        catalogDraft,
      );
      deleted = true;
    } else if (recordDraft && selection.kind === "dimension") {
      const dimension = recordDraft.dimensions.find(
        (item) => item.id === selection.id,
      );
      if (!dimension) return;
      applyReferenceCleanup(
        [
          {
            namespace: "system",
            systemId: recordDraft.id,
            kind:
              dimension.category === "quality"
                ? "quality-dimension"
                : "boundary-dimension",
            targetId: dimension.id,
          },
        ],
        {
          ...recordDraft,
          dimensions: recordDraft.dimensions.filter(
            (item) => item.id !== dimension.id,
          ),
          tracks: recordDraft.tracks.map((track) => ({
            ...track,
            states: track.states.map((state) => ({
              ...state,
              contract: {
                ...state.contract,
                baseQualities: state.contract.baseQualities.filter(
                  (item) => item.dimensionId !== dimension.id,
                ),
                baseBoundaries: state.contract.baseBoundaries.filter(
                  (item) => item.dimensionId !== dimension.id,
                ),
              },
            })),
          })),
        },
        catalogDraft,
      );
      deleted = true;
    }
    if (deleted) setSelection({ kind: "system" });
  };

  const issues = useMemo(
    () =>
      recordDraft && catalogDraft && connectionsDraft && library
        ? auditPowerSystem(
            recordDraft,
            catalogDraft,
            connectionsDraft,
            new Set(library.index.systems.map((item) => item.id)),
          )
        : [],
    [catalogDraft, connectionsDraft, library, recordDraft],
  );

  const selectIssue = (issue: PowerSystemAuditIssue) => {
    if (!issue.targetKind || !issue.targetId || !recordDraft) return;
    if (issue.targetKind === "system") setSelection({ kind: "system" });
    else if (issue.targetKind === "catalog")
      setSelection({ kind: "catalog", id: issue.targetId });
    else if (issue.targetKind === "track")
      setSelection({ kind: "track", id: issue.targetId });
    else if (issue.targetKind === "dimension")
      setSelection({ kind: "dimension", id: issue.targetId });
    else if (issue.targetKind === "connection")
      setSelection({ kind: "connection", id: issue.targetId });
    else {
      const track = recordDraft.tracks.find((item) =>
        issue.targetKind === "state"
          ? item.states.some((state) => state.id === issue.targetId)
          : item.transitions.some(
              (transition) => transition.id === issue.targetId,
            ),
      );
      if (!track) return;
      setSelection(
        issue.targetKind === "state"
          ? { kind: "state", trackId: track.id, id: issue.targetId }
          : { kind: "transition", trackId: track.id, id: issue.targetId },
      );
    }
  };

  if (isLoading && !library) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在读取力量体系…
      </div>
    );
  }

  if (!library || !catalogDraft || !connectionsDraft) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] p-8">
        <div className="max-w-lg rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 text-center shadow-sm">
          <Atom className="mx-auto h-8 w-8 text-[var(--accent-warm)]" />
          <h1 className="mt-3 text-base font-semibold text-[var(--ink)]">
            建立通用力量生态
          </h1>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
            新模型把体系、成长状态、理论、方法、资源与能力拆开，再通过明确连接组合。旧版数据不会迁移。
          </p>
          {error && <p className="mt-3 text-xs text-[var(--error)]">{error}</p>}
          <button
            type="button"
            onClick={() => void initialize()}
            className="ns-compact-primary-button mt-4"
          >
            <Sparkles className="h-4 w-4" /> 初始化新版工作区
          </button>
        </div>
      </div>
    );
  }

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredSystems = library.index.systems.filter((system) =>
    `${system.name} ${system.summary}`
      .toLocaleLowerCase()
      .includes(normalizedSearch),
  );
  const selectedSystemType = library.meta.systemTypes.find(
    (item) => item.id === recordDraft?.typeId,
  );
  const filteredConnections = connectionsDraft.connections.filter(
    (connection) =>
      connectionFilter === "all" || connection.kind === connectionFilter,
  );

  const renderCenter = () => {
    if (view === "architecture") {
      return (
        <div className="space-y-5 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-base font-semibold text-[var(--ink)]">
                力量生态架构
              </h1>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                本源回答力量来自哪里，介质回答如何承载与流动，法则约束所有具体用法。
              </p>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => addEntity("foundation")}
                className="ns-compact-button"
              >
                <Plus className="h-3.5 w-3.5" /> 本源
              </button>
              <button
                type="button"
                onClick={() => addEntity("medium")}
                className="ns-compact-button"
              >
                <Plus className="h-3.5 w-3.5" /> 介质
              </button>
              <button
                type="button"
                onClick={() => addEntity("principle")}
                className="ns-compact-button"
              >
                <Plus className="h-3.5 w-3.5" /> 法则
              </button>
            </div>
          </div>
          {recordDraft ? (
            <PowerSystemGraph
              record={recordDraft}
              catalog={catalogDraft}
              connections={connectionsDraft}
              index={library.index}
              onConnectionsChange={updateConnections}
              onSelectionChange={setSelection}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-16 text-center text-sm text-[var(--ink-muted)]">
              共享目录可以先建立；创建体系后，图谱会显示体系与这些对象之间的连接。
            </div>
          )}
          <div className="grid gap-5 xl:grid-cols-3">
            <EntityList
              title="力量本源"
              description="自然、血脉、精神、神权、技术或社会制度"
              entities={catalogDraft.foundations}
              selection={selection}
              onAdd={() => addEntity("foundation")}
              onSelect={(entity) =>
                setSelection({ kind: "catalog", id: entity.id })
              }
            />
            <EntityList
              title="运行介质"
              description="能量、身体、灵魂、符号、设备、网络或权限"
              entities={catalogDraft.mediums}
              selection={selection}
              onAdd={() => addEntity("medium")}
              onSelect={(entity) =>
                setSelection({ kind: "catalog", id: entity.id })
              }
            />
            <EntityList
              title="底层法则"
              description="不变量、禁制、转换规则、优先级与例外"
              entities={catalogDraft.principles}
              selection={selection}
              onAdd={() => addEntity("principle")}
              onSelect={(entity) =>
                setSelection({ kind: "catalog", id: entity.id })
              }
            />
          </div>
        </div>
      );
    }
    if (view === "states") {
      return (
        <div className="space-y-4 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-base font-semibold text-[var(--ink)]">
                成长状态
              </h1>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                状态定义获得了什么，转换定义如何到达；境界、等级、形态、控制阶段都是状态。
              </p>
            </div>
            <button
              type="button"
              onClick={addTrack}
              disabled={!recordDraft}
              className="ns-compact-primary-button disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" /> 添加轨道
            </button>
          </div>
          {!recordDraft ? (
            <div className="rounded-lg border border-dashed border-[var(--line)] p-10 text-center text-sm text-[var(--ink-muted)]">
              先创建一个体系，才能定义它的成长状态。
            </div>
          ) : recordDraft.tracks.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--line)] p-10 text-center text-sm text-[var(--ink-muted)]">
              当前体系没有成长轨道。事件型或软力量体系也可以保持无轨道。
            </div>
          ) : (
            recordDraft.tracks.map((track) => (
              <section
                key={track.id}
                className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]"
              >
                <header className="flex items-center justify-between gap-3 border-b border-[var(--line-subtle)] px-3 py-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSelection({ kind: "track", id: track.id })
                    }
                    className="min-w-0 text-left"
                  >
                    <strong className="block truncate text-sm text-[var(--ink)]">
                      {track.name}
                    </strong>
                    <span className="text-xs text-[var(--ink-muted)]">
                      {track.mode} · {track.states.length} 个状态 ·{" "}
                      {track.transitions.length} 条转换
                    </span>
                  </button>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => addState(track.id)}
                      className="ns-compact-button"
                    >
                      <Plus className="h-3 w-3" /> 状态
                    </button>
                    <button
                      type="button"
                      onClick={() => addTransition(track.id)}
                      className="ns-compact-button"
                    >
                      <Plus className="h-3 w-3" /> 转换
                    </button>
                  </div>
                </header>
                <div className="grid gap-3 p-3 lg:grid-cols-[1fr_13rem]">
                  <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
                    {[...track.states]
                      .sort((a, b) => a.order - b.order)
                      .map((state, index) => (
                        <div
                          key={state.id}
                          className="flex shrink-0 items-center gap-2"
                        >
                          {index > 0 && (
                            <span className="text-[var(--ink-subtle)]">→</span>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setSelection({
                                kind: "state",
                                trackId: track.id,
                                id: state.id,
                              })
                            }
                            className={`w-36 rounded-md border px-2.5 py-2 text-left ${selection.kind === "state" && selection.id === state.id ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]" : "border-[var(--line)] bg-[var(--paper)]"}`}
                          >
                            <span className="block text-xs text-[var(--ink-subtle)]">
                              {state.stateType} · {state.order + 1}
                            </span>
                            <strong className="block truncate text-xs text-[var(--ink)]">
                              {state.name}
                            </strong>
                          </button>
                        </div>
                      ))}
                  </div>
                  <div className="space-y-1.5 border-l border-[var(--line-subtle)] pl-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-subtle)]">
                      状态转换
                    </div>
                    {track.transitions.length === 0 ? (
                      <p className="text-xs text-[var(--ink-muted)]">
                        尚未建立转换
                      </p>
                    ) : (
                      track.transitions.map((transition) => (
                        <button
                          key={transition.id}
                          type="button"
                          onClick={() =>
                            setSelection({
                              kind: "transition",
                              trackId: track.id,
                              id: transition.id,
                            })
                          }
                          className={`block w-full truncate rounded px-2 py-1.5 text-left text-xs ${selection.kind === "transition" && selection.id === transition.id ? "bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                        >
                          {transition.name}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </section>
            ))
          )}
        </div>
      );
    }
    if (view === "methods")
      return (
        <div className="p-4">
          <EntityList
            title="发展方法"
            description="功法、训练、冥想、研究、改造、仪式与授权流程；方法描述怎样发展，而不是发展到了什么状态。"
            entities={catalogDraft.methods}
            selection={selection}
            onAdd={() => addEntity("method")}
            onSelect={(entity) =>
              setSelection({ kind: "catalog", id: entity.id })
            }
          />
        </div>
      );
    if (view === "theories")
      return (
        <div className="p-4">
          <EntityList
            title="理论模型"
            description="解释方法为何有效：表达模型、拓扑结构、基础操作、控制策略、复杂度与失败模式。"
            entities={catalogDraft.theories}
            selection={selection}
            onAdd={() => addEntity("theory")}
            onSelect={(entity) =>
              setSelection({ kind: "catalog", id: entity.id })
            }
          />
        </div>
      );
    if (view === "capabilities")
      return (
        <div className="p-4">
          <EntityList
            title="能力目录"
            description="基础能力与可学习技能使用同一模型，通过能力准入区分自动获得、允许学习、装备、契约或授权。"
            entities={catalogDraft.capabilities}
            selection={selection}
            onAdd={() => addEntity("capability")}
            onSelect={(entity) =>
              setSelection({ kind: "catalog", id: entity.id })
            }
          />
        </div>
      );
    if (view === "resources")
      return (
        <div className="p-4">
          <EntityList
            title="资源条件"
            description="燃料、材料、环境、信息、权限、情绪、身体条件与时间；具体消耗通过资源需求连接到方法、状态或能力。"
            entities={catalogDraft.resources}
            selection={selection}
            onAdd={() => addEntity("resource")}
            onSelect={(entity) =>
              setSelection({ kind: "catalog", id: entity.id })
            }
          />
        </div>
      );
    if (view === "quality") {
      return (
        <div className="space-y-5 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-base font-semibold text-[var(--ink)]">
                质量与边界
              </h1>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                质量描述同一状态下“做得有多好”，边界描述“最多能做到哪里”；不生成单一总战力。
              </p>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => addDimension("quality")}
                className="ns-compact-button"
              >
                <Plus className="h-3.5 w-3.5" /> 质量
              </button>
              <button
                type="button"
                onClick={() => addDimension("boundary")}
                className="ns-compact-button"
              >
                <Plus className="h-3.5 w-3.5" /> 边界
              </button>
            </div>
          </div>
          {!recordDraft ? (
            <div className="rounded-lg border border-dashed border-[var(--line)] p-10 text-center text-sm text-[var(--ink-muted)]">
              质量与边界属于具体体系，请先创建体系。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {(["quality", "boundary"] as const).map((category) => (
                <section
                  key={category}
                  className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]"
                >
                  <header className="border-b border-[var(--line-subtle)] px-3 py-2 text-xs font-semibold text-[var(--ink)]">
                    {category === "quality" ? "质量维度" : "能力边界"}
                  </header>
                  <div className="divide-y divide-[var(--line-subtle)]">
                    {recordDraft.dimensions
                      .filter((item) => item.category === category)
                      .map((dimension) => (
                        <button
                          key={dimension.id}
                          type="button"
                          onClick={() =>
                            setSelection({
                              kind: "dimension",
                              id: dimension.id,
                            })
                          }
                          className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left ${selection.kind === "dimension" && selection.id === dimension.id ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
                        >
                          <span>
                            <strong className="block text-xs text-[var(--ink)]">
                              {dimension.name}
                            </strong>
                            <span className="text-xs text-[var(--ink-muted)]">
                              {dimension.measurement}
                              {dimension.unit ? ` · ${dimension.unit}` : ""}
                            </span>
                          </span>
                          <span className="text-xs text-[var(--ink-subtle)]">
                            {dimension.lowLabel || "低"} →{" "}
                            {dimension.highLabel || "高"}
                          </span>
                        </button>
                      ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      );
    }
    if (view === "connections") {
      return (
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-base font-semibold text-[var(--ink)]">
                关联矩阵
              </h1>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                连接把共享对象应用到具体体系、状态或转换；同一方法可在不同体系中产生不同效率和质量。
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(
                Object.keys(CONNECTION_LABELS) as PowerConnection["kind"][]
              ).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => addConnection(kind)}
                  className="ns-compact-button"
                >
                  <Plus className="h-3 w-3" /> {CONNECTION_LABELS[kind]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-1">
            {CONNECTION_FILTERS.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() =>
                  setConnectionFilter(kind as typeof connectionFilter)
                }
                className={`rounded-md px-2.5 py-1 text-xs ${connectionFilter === kind ? "bg-[var(--paper)] font-medium text-[var(--ink)] shadow-sm" : "text-[var(--ink-muted)] hover:text-[var(--ink)]"}`}
              >
                {kind === "all" ? "全部" : CONNECTION_LABELS[kind]}
              </button>
            ))}
          </div>
          <div className="overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]">
            <div className="grid grid-cols-[8rem_1fr_2rem_1fr_6rem] gap-2 border-b border-[var(--line)] bg-[var(--hover-bg)] px-3 py-2 text-xs font-semibold text-[var(--ink-muted)]">
              <span>连接类型</span>
              <span>来源</span>
              <span></span>
              <span>目标</span>
              <span>状态</span>
            </div>
            {filteredConnections.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-[var(--ink-muted)]">
                当前筛选下没有连接
              </div>
            ) : (
              filteredConnections.map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  onClick={() =>
                    setSelection({ kind: "connection", id: connection.id })
                  }
                  className={`grid w-full grid-cols-[8rem_1fr_2rem_1fr_6rem] gap-2 border-b border-[var(--line-subtle)] px-3 py-2 text-left text-xs last:border-0 ${selection.kind === "connection" && selection.id === connection.id ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
                >
                  <span className="font-medium text-[var(--ink)]">
                    {CONNECTION_LABELS[connection.kind]}
                  </span>
                  <span className="truncate text-[var(--ink-muted)]">
                    {referenceName(
                      connection.source,
                      catalogDraft,
                      recordDraft,
                      library,
                    )}
                  </span>
                  <span className="text-center text-[var(--ink-subtle)]">
                    →
                  </span>
                  <span className="truncate text-[var(--ink-muted)]">
                    {referenceName(
                      connection.target,
                      catalogDraft,
                      recordDraft,
                      library,
                    )}
                  </span>
                  <span className="text-xs text-[var(--ink-subtle)]">
                    {connection.conditions.clauses.length
                      ? `${connection.conditions.clauses.length} 条条件`
                      : "总是"}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      );
    }
    if (view === "audit") {
      return (
        <div className="space-y-4 p-4">
          <div>
            <h1 className="text-base font-semibold text-[var(--ink)]">
              一致性审查
            </h1>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              检查成长契约、认知模型、方法理论、能力边界与连接引用，不评价故事风格。
            </p>
          </div>
          {!recordDraft ? (
            <div className="rounded-lg border border-dashed border-[var(--line)] p-10 text-center text-sm text-[var(--ink-muted)]">
              选择体系后开始审查。
            </div>
          ) : issues.length === 0 ? (
            <div className="flex items-center gap-3 rounded-lg border border-[var(--success)]/30 bg-[var(--success-bg)] p-4 text-sm text-[var(--success)]">
              <CheckCircle2 className="h-5 w-5" /> 当前未发现结构性问题
            </div>
          ) : (
            <div className="space-y-2">
              {issues.map((issue) => (
                <button
                  key={issue.id}
                  type="button"
                  onClick={() => selectIssue(issue)}
                  className="flex w-full gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3 text-left hover:border-[var(--line-strong)]"
                >
                  <AlertTriangle
                    className={`mt-0.5 h-4 w-4 shrink-0 ${issue.severity === "error" ? "text-[var(--error)]" : issue.severity === "warning" ? "text-[var(--warning)]" : "text-[var(--ink-muted)]"}`}
                  />
                  <span>
                    <strong className="block text-sm text-[var(--ink)]">
                      {issue.title}
                    </strong>
                    <span className="mt-0.5 block text-xs leading-5 text-[var(--ink-muted)]">
                      {issue.detail}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }
    return recordDraft ? (
      <div className="h-full p-4">
        <MarkdownVisualEditor
          pageId={`world/power-systems/pages/${recordDraft.id}.md`}
          label={`${recordDraft.name}说明`}
          value={pageDraft}
          onChange={(value) => {
            setPageDraft(value);
            setDirty((current) => ({ ...current, page: true }));
          }}
          onSave={() => void save()}
          fullWidth
          placeholder="记录体系的叙事用途、读者认知顺序、关键例外和作者备注……"
        />
      </div>
    ) : (
      <div className="p-10 text-center text-sm text-[var(--ink-muted)]">
        体系说明属于具体体系，请先创建体系。
      </div>
    );
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--paper)] text-[var(--ink)]">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Atom className="h-4 w-4 text-[var(--accent-warm)]" />
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold">
              力量体系 · {projectTitle}
            </div>
            <div className="truncate text-xs text-[var(--ink-subtle)]">
              {recordDraft
                ? `${recordDraft.name} · ${selectedSystemType?.name ?? recordDraft.typeId}`
                : "共享力量目录"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {message && (
            <span className="mr-2 text-xs text-[var(--success)]">
              {message}
            </span>
          )}
          {error && (
            <span
              className="mr-2 max-w-80 truncate text-xs text-[var(--error)]"
              title={error}
            >
              {error}
            </span>
          )}
          <button
            type="button"
            onClick={() => void loadLibrary()}
            className="ns-icon-button"
            title="重新读取"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!hasDirty || isSaving}
            className="ns-compact-primary-button disabled:opacity-45"
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}{" "}
            {hasDirty ? "保存" : "已保存"}
          </button>
          {headerActions}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)]">
          <div className="border-b border-[var(--line-subtle)] p-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-[var(--ink-subtle)]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-full rounded-md border border-[var(--line)] bg-[var(--paper)] py-1.5 pl-8 pr-2 text-xs outline-none focus:border-[var(--accent-warm)]"
                placeholder="查找体系"
              />
            </div>
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="ns-compact-button mt-2 w-full justify-center"
            >
              <Plus className="h-3.5 w-3.5" /> 新建体系
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto border-b border-[var(--line-subtle)] p-1.5">
            {filteredSystems.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-[var(--ink-muted)]">
                暂无体系
              </div>
            ) : (
              filteredSystems.map((system) => (
                <button
                  key={system.id}
                  type="button"
                  onClick={() => void selectSystem(system.id)}
                  className={`mb-0.5 block w-full rounded-md px-2.5 py-2 text-left ${recordDraft?.id === system.id ? "bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                >
                  <strong className="block truncate text-xs font-semibold">
                    {system.name}
                  </strong>
                  <span className="mt-0.5 block truncate text-xs opacity-75">
                    {library.meta.systemTypes.find(
                      (type) => type.id === system.typeId,
                    )?.name ?? system.typeId}{" "}
                    · {system.status}
                  </span>
                </button>
              ))
            )}
          </div>
          <nav className="flex-1 overflow-y-auto p-1.5">
            {VIEW_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setView(item.id)}
                  className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs ${view === item.id ? "bg-[var(--paper)] font-medium text-[var(--ink)] shadow-sm" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                  {item.id === "audit" && issues.length > 0 && (
                    <span className="ml-auto rounded-full bg-[var(--warning-bg)] px-1.5 text-xs text-[var(--warning)]">
                      {issues.length}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">{renderCenter()}</main>
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-[var(--line)] bg-[var(--paper-elevated)] xl:w-[22rem]">
          {selection.kind === "system" && !recordDraft ? (
            <div className="p-6 text-center text-xs leading-5 text-[var(--ink-muted)]">
              从中间目录选择对象进行编辑，或先创建一个力量体系。
            </div>
          ) : (
            <PowerSystemInspector
              selection={selection}
              record={recordDraft ?? EMPTY_INSPECTOR_RECORD}
              catalog={catalogDraft}
              connections={connectionsDraft}
              meta={library.meta}
              index={library.index}
              onRecordChange={updateRecord}
              onCatalogChange={updateCatalog}
              onConnectionsChange={updateConnections}
              onSelectionChange={setSelection}
              onDeleteSelection={deleteSelection}
            />
          )}
        </aside>
      </div>
      {isCreateOpen && (
        <CreateSystemDialog
          types={library.meta.systemTypes}
          onClose={() => setIsCreateOpen(false)}
          onCreate={(name, typeId) => void createSystem(name, typeId)}
        />
      )}
      {isLoading && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-[var(--paper)]/35">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--accent-warm)]" />
        </div>
      )}
    </div>
  );
}
