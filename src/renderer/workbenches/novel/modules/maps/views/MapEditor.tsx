import {
  Check,
  Clock3,
  CircleDashed,
  Eye,
  EyeOff,
  Globe2,
  Hand,
  Layers3,
  Lock,
  Loader2,
  GitCompareArrows,
  Map as MapIcon,
  MapPin,
  MousePointer2,
  Network,
  Pentagon,
  Plus,
  Route,
  Save,
  Type,
  Trash2,
  Unlock,
  Undo2,
  Redo2,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmDialog, CustomSelect, type WorkbenchProjection, type WorkbenchStorage } from "@/workbench-sdk";
import MapProposalReview from "./MapProposalReview";
import MapCanvas, { type MapCanvasTool } from "./MapCanvas";
import NarrativeUnsavedChangesGuard from "../../../NarrativeUnsavedChangesGuard";

import WorldMapPrototype from "./WorldMapPrototype";
import {
  createNovelMapRepository,
  validateMapEntityReferences,
  type LoadedMapDocument,
} from "../data-access/mapRepository";
import {
  MAP_PROJECTION_LABELS,
  mapEntityKindSchema,
  type MapDocument,
  type MapEntityKind,
  type MapFeature,
  type MapFeatureKind,
  type MapProjectionType,
} from "../entities/mapSchema";
import { buildDomainIndex, type DomainEntityRef } from "../../../shared/business/domainIndex";
import { type TimelineEvent } from "../../../timelineLibrarySchema";
import { createNovelTimelineLibraryRepository } from "../../../timelineLibraryRepository";
import { TIMELINE_INDEX_PATH } from "../../../../../../shared/workbenches/novel/timelineStorage";

const FEATURE_KIND_LABELS: Readonly<Record<MapFeatureKind, string>> =
  Object.freeze({
    marker: "标记点",
    label: "文本标签",
    area: "区域",
    polygon: "多边形",
    route: "路线",
    node: "拓扑节点",
  });

const FEATURE_KIND_ICONS: Readonly<Record<MapFeatureKind, typeof MapPin>> =
  Object.freeze({
    marker: MapPin,
    label: Type,
    area: CircleDashed,
    polygon: Pentagon,
    route: Route,
    node: Network,
  });

interface MapEditorProps {
  readonly storage: WorkbenchStorage;
  readonly projection?: WorkbenchProjection;
  readonly projectTitle: string;
  readonly isActive: boolean;
  readonly registerNavigationGuard?: Parameters<typeof NarrativeUnsavedChangesGuard>[0]["registerNavigationGuard"];
}

export default function MapEditor({
  storage,
  projection,
  projectTitle,
  isActive,
  registerNavigationGuard,
}: MapEditorProps) {
  const repository = useMemo(() => createNovelMapRepository(storage), [storage]);
  const [tab, setTab] = useState<"tree" | "maps">("maps");
  const [maps, setMaps] = useState<readonly { id: string; name: string }[]>([]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [doc, setDoc] = useState<LoadedMapDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [deleteMapTarget, setDeleteMapTarget] = useState<string | null>(null);
  const [entityOptions, setEntityOptions] = useState<DomainEntityRef[]>([]);
  const [history, setHistory] = useState<{ content: string; map: MapDocument }[]>([]);
  const [future, setFuture] = useState<{ content: string; map: MapDocument }[]>([]);
  const [newMapOpen, setNewMapOpen] = useState(false);
  const [newMapName, setNewMapName] = useState("");
  const [newMapProjection, setNewMapProjection] =
    useState<MapProjectionType>("continent");
  const [proposalReviewOpen, setProposalReviewOpen] = useState(false);
  const [tool, setTool] = useState<MapCanvasTool>("select");
  const [activeLayerId, setActiveLayerId] = useState("layer-main");
  const [timelineEvents, setTimelineEvents] = useState<readonly TimelineEvent[]>([]);
  const [timelineCursor, setTimelineCursor] = useState<number | null>(null);

  const loadMaps = useCallback(async () => {
    try {
      const index = await repository.loadIndex();
      setMaps(index.index.maps);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [repository]);

  useEffect(() => {
    if (!isActive) return;
    void loadMaps();
  }, [isActive, loadMaps]);

  // 实体选项（T11 引用校验的数据源）
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    void buildDomainIndex(storage, projection).then((index) => {
      if (!cancelled) {
        setEntityOptions(
          index.entities.filter((entity) =>
            mapEntityKindSchema.safeParse(entity.kind).success,
          ),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, projection, storage]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    void storage.stat([TIMELINE_INDEX_PATH])
      .then(async ([info]) => {
        if (!info?.exists || info.kind !== "file") return { events: [] as readonly TimelineEvent[] };
        const timeline = await createNovelTimelineLibraryRepository(storage).load();
        return { events: timeline.library.events };
      })
      .then((result) => {
        if (!cancelled) setTimelineEvents(result.events);
      })
      .catch(() => {
        if (!cancelled) setTimelineEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isActive, storage]);

  const openMap = useCallback(
    async (mapId: string) => {
      setError(null);
      try {
        const loaded = await repository.loadMap(mapId);
        setDoc(loaded);
        setSelectedMapId(mapId);
        setSelectedFeatureId(null);
        setActiveLayerId(loaded.map.layers[0]?.id ?? "layer-main");
        setHistory([]);
        setFuture([]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [repository],
  );

  const createMap = useCallback(async () => {
    const id = `map-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      await repository.createMap({
        id,
        name: newMapName.trim() || "未命名地图",
        projectionType: newMapProjection,
      });
      setNewMapOpen(false);
      setNewMapName("");
      await loadMaps();
      await openMap(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [loadMaps, newMapName, newMapProjection, openMap, repository]);

  const mutateDoc = useCallback(
    (mutator: (map: MapDocument) => MapDocument) => {
      setDoc((current) => {
        if (!current) return current;
        const next = mutator(current.map);
        setHistory((prev) => [...prev.slice(-49), current]);
        setFuture([]);
        return { map: next, content: current.content };
      });
    },
    [],
  );

  const undo = useCallback(() => {
    setDoc((current) => {
      if (!current) return current;
      const previous = history.at(-1);
      if (!previous) return current;
      setHistory((prev) => prev.slice(0, -1));
      setFuture((prev) => [...prev, current]);
      setSelectedFeatureId(null);
      return previous;
    });
  }, [history]);

  const redo = useCallback(() => {
    setDoc((current) => {
      if (!current) return current;
      const next = future.at(-1);
      if (!next) return current;
      setFuture((prev) => prev.slice(0, -1));
      setHistory((prev) => [...prev, current]);
      setSelectedFeatureId(null);
      return next;
    });
  }, [future]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!doc) return false;
    setSaving(true);
    setError(null);
    try {
      // T11：保存前校验实体引用存在性
      const idsByKind: Record<MapEntityKind, Set<string>> = {
        character: new Set(),
        event: new Set(),
        location: new Set(),
        faction: new Set(),
        item: new Set(),
        setting: new Set(),
      };
      for (const ref of entityOptions) {
        if (ref.kind in idsByKind) idsByKind[ref.kind as MapEntityKind].add(ref.id);
      }
      const errors = await validateMapEntityReferences(storage, doc.map, idsByKind);
      if (errors.length > 0) {
        setError(errors.join("；"));
        return false;
      }
      const saved = await repository.saveMap(doc, doc.map);
      setDoc(saved);
      setHistory([]);
      setFuture([]);
      await loadMaps();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }, [doc, entityOptions, loadMaps, repository, storage]);

  const createFeature = useCallback(
    (feature: MapFeature) => {
      mutateDoc((map) => ({ ...map, features: [...map.features, feature] }));
      setSelectedFeatureId(feature.id);
    },
    [mutateDoc],
  );

  const isDirty = Boolean(doc && history.length > 0);

  const updateFeature = useCallback(
    (featureId: string, patch: Partial<MapFeature>) => {
      mutateDoc((map) => ({
        ...map,
        features: map.features.map((feature) =>
          feature.id === featureId ? { ...feature, ...patch } : feature,
        ),
      }));
    },
    [doc, mutateDoc],
  );

  const updateGeometry = useCallback(
    (featureId: string, points: MapFeature["points"], props?: MapFeature["props"]) => {
      mutateDoc((map) => ({
        ...map,
        features: map.features.map((feature) =>
          feature.id === featureId
            ? { ...feature, points, props: props ? { ...feature.props, ...props } : feature.props }
            : feature,
        ),
      }));
    },
    [mutateDoc],
  );

  const updateCanvas = useCallback(
    (patch: Partial<MapDocument["canvas"]>) => {
      mutateDoc((map) => ({ ...map, canvas: { ...map.canvas, ...patch } }));
    },
    [mutateDoc],
  );

  const importBackground = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("底图必须是图片文件。");
        return;
      }
      if (file.size > 12 * 1024 * 1024) {
        setError("底图文件不能超过 12 MB。");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") updateCanvas({ backgroundImage: reader.result });
      };
      reader.onerror = () => setError("底图读取失败。");
      reader.readAsDataURL(file);
    },
    [updateCanvas],
  );

  const removeFeature = useCallback(
    (featureId: string) => {
      mutateDoc((map) => ({
        ...map,
        features: map.features.filter((feature) => feature.id !== featureId),
      }));
      setSelectedFeatureId(null);
    },
    [mutateDoc],
  );

  const updateLayer = useCallback(
    (layerId: string, patch: Partial<MapDocument["layers"][number]>) => {
      mutateDoc((map) => ({
        ...map,
        layers: map.layers.map((layer) =>
          layer.id === layerId ? { ...layer, ...patch } : layer,
        ),
      }));
    },
    [mutateDoc],
  );

  const addLayer = useCallback(() => {
    const id = `layer-${Date.now().toString(36)}`;
    mutateDoc((map) => ({
      ...map,
      layers: [
        ...map.layers,
        {
          id,
          name: `图层 ${map.layers.length + 1}`,
          visible: true,
          locked: false,
          opacity: 1,
        },
      ],
    }));
    setActiveLayerId(id);
  }, [mutateDoc]);

  const removeLayer = useCallback(
    (layerId: string) => {
      if (!doc || doc.map.layers.length <= 1) {
        setError("地图至少需要保留一个图层。");
        return;
      }
      if (doc.map.features.some((feature) => feature.layerId === layerId)) {
        setError("当前图层仍包含地图要素，请先移动或删除这些要素。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        layers: map.layers.filter((layer) => layer.id !== layerId),
      }));
      setActiveLayerId(doc.map.layers.find((layer) => layer.id !== layerId)?.id ?? "layer-main");
    },
    [mutateDoc],
  );

  const moveLayer = useCallback(
    (layerId: string, direction: -1 | 1) => {
      mutateDoc((map) => {
        const index = map.layers.findIndex((layer) => layer.id === layerId);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= map.layers.length) return map;
        const layers = [...map.layers];
        [layers[index], layers[target]] = [layers[target], layers[index]];
        return { ...map, layers };
      });
    },
    [mutateDoc],
  );

  const selectedFeature = doc?.map.features.find(
    (feature) => feature.id === selectedFeatureId,
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <NarrativeUnsavedChangesGuard
        dirty={isDirty}
        label="地图"
        registerNavigationGuard={registerNavigationGuard ?? (() => () => undefined)}
        onSave={save}
      />
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line)] px-5">
        <MapIcon className="h-4 w-4 text-[var(--accent-warm)]" />
        <h1 className="text-sm font-semibold">世界地图</h1>
        <span className="text-xs text-[var(--ink-muted)]">{projectTitle}</span>
        <div className="ml-4 flex h-8 items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-1">
          <button
            type="button"
            onClick={() => setTab("maps")}
            className={`h-6 rounded px-2 text-xs ${tab === "maps" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
          >
            地图编辑
          </button>
          <button
            type="button"
            onClick={() => setTab("tree")}
            className={`h-6 rounded px-2 text-xs ${tab === "tree" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
          >
            空间节点树
          </button>
        </div>
        {tab === "maps" && doc && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={undo}
              disabled={history.length === 0}
              title="撤销"
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-35"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={future.length === 0}
              title="重做"
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-35"
            >
              <Redo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setProposalReviewOpen(true)}
              title="审阅 AI 提交的地图提案"
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              <GitCompareArrows className="h-4 w-4" />
              <span className="max-lg:hidden">审阅提案</span>
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !isDirty}
              className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-white hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {isDirty ? "保存" : "已保存"}
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="shrink-0 border-b border-[var(--line-subtle)] bg-[var(--error-bg)] px-5 py-2 text-sm text-[var(--error)]">
          {error}
        </div>
      )}

      {tab === "tree" ? (
        <WorldMapPrototype
          storage={storage}
          projectTitle={projectTitle}
          isActive={isActive}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-52 shrink-0 flex-col border-r border-[var(--line-subtle)]">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--line-subtle)] px-3">
              <span className="text-xs font-medium text-[var(--ink-muted)]">
                地图库
              </span>
              <button
                type="button"
                onClick={() => setNewMapOpen(true)}
                title="新建地图"
                className="flex h-6 w-6 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {maps.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-[var(--ink-muted)]">
                  暂无地图，点击右上角新建
                </p>
              )}
              {maps.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => void openMap(entry.id)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${
                    selectedMapId === entry.id
                      ? "bg-[var(--accent-warm-subtle)]"
                      : "hover:bg-[var(--hover-bg)]"
                  }`}
                >
                  <MapIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span
                    role="button"
                    title="删除地图"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteMapTarget(entry.id);
                    }}
                    className="shrink-0 rounded p-1 text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3 w-3" />
                  </span>
                </button>
              ))}
            </div>
            {doc && (
              <>
                <div className="flex h-9 shrink-0 items-center justify-between border-t border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
                  <span className="flex items-center"><Layers3 className="mr-1.5 h-3.5 w-3.5" /> 图层</span>
                  <button type="button" title="新建图层" onClick={addLayer} className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--hover-bg)]"><Plus className="h-3.5 w-3.5" /></button>
                </div>
                <div className="max-h-56 shrink-0 overflow-y-auto border-t border-[var(--line-subtle)] p-2">
                  {doc.map.layers.map((layer) => (
                    <div
                      key={layer.id}
                      onClick={() => setActiveLayerId(layer.id)}
                      className={`mb-1 rounded-md border px-2 py-1.5 text-xs ${activeLayerId === layer.id ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]" : "border-transparent hover:bg-[var(--hover-bg)]"}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <button type="button" title={layer.visible ? "隐藏图层" : "显示图层"} onClick={(event) => { event.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }} className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)]">{layer.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</button>
                        <input value={layer.name} onClick={(event) => event.stopPropagation()} onChange={(event) => updateLayer(layer.id, { name: event.target.value })} className="min-w-0 flex-1 bg-transparent outline-none" aria-label={`图层名称：${layer.name}`} />
                        <button type="button" title={layer.locked ? "解锁图层" : "锁定图层"} onClick={(event) => { event.stopPropagation(); updateLayer(layer.id, { locked: !layer.locked }); }} className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)]">{layer.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}</button>
                        <button type="button" title="上移图层" aria-label={`上移图层：${layer.name}`} disabled={doc.map.layers.indexOf(layer) === 0} onClick={(event) => { event.stopPropagation(); moveLayer(layer.id, -1); }} className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] disabled:opacity-30"><ArrowUp className="h-3 w-3" /></button>
                        <button type="button" title="下移图层" aria-label={`下移图层：${layer.name}`} disabled={doc.map.layers.indexOf(layer) === doc.map.layers.length - 1} onClick={(event) => { event.stopPropagation(); moveLayer(layer.id, 1); }} className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] disabled:opacity-30"><ArrowDown className="h-3 w-3" /></button>
                        <button type="button" title="删除图层" onClick={(event) => { event.stopPropagation(); removeLayer(layer.id); }} className="rounded p-1 text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                      {activeLayerId === layer.id && (
                        <label className="mt-1.5 flex items-center gap-2 px-1 text-[10px] text-[var(--ink-muted)]">
                          透明度
                          <input type="range" min={0.1} max={1} step={0.1} value={layer.opacity} onChange={(event) => updateLayer(layer.id, { opacity: Number(event.target.value) })} className="min-w-0 flex-1" />
                          {Math.round(layer.opacity * 100)}%
                        </label>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex h-9 shrink-0 items-center border-t border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">要素 · {doc.map.features.length}</div>
                <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--line-subtle)] p-2">
                  {doc.map.features.filter((feature) => feature.layerId === activeLayerId).map((feature) => {
                    const Icon = FEATURE_KIND_ICONS[feature.kind];
                    return <button key={feature.id} type="button" onClick={() => { setSelectedFeatureId(feature.id); setTool("select"); }} className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${selectedFeatureId === feature.id ? "bg-[var(--hover-bg)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}><Icon className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{feature.name}</span></button>;
                  })}
                </div>
              </>
            )}
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            {!doc ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
                <Globe2 className="h-8 w-8 text-[var(--ink-subtle)]" />
                <p>选择左侧地图或新建一张地图</p>
              </div>
            ) : (
              <>
                <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-1 border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-3 py-1.5">
                  <button type="button" onClick={() => setTool("select")} title="选择与编辑" className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs ${tool === "select" ? "bg-[var(--ink)] text-[var(--paper)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}><MousePointer2 className="h-3.5 w-3.5" />选择</button>
                  <button type="button" onClick={() => setTool("pan")} title="平移画布" className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs ${tool === "pan" ? "bg-[var(--ink)] text-[var(--paper)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}><Hand className="h-3.5 w-3.5" />平移</button>
                  <span className="mx-1 h-5 w-px bg-[var(--line-subtle)]" />
                  {(
                    Object.entries(FEATURE_KIND_LABELS) as [
                      MapFeatureKind,
                      string,
                    ][]
                  ).map(([kind, label]) => (
                    (() => {
                      const Icon = FEATURE_KIND_ICONS[kind];
                      const activeLayer = doc.map.layers.find((layer) => layer.id === activeLayerId);
                      return <button key={kind} type="button" onClick={() => setTool(kind)} disabled={!activeLayer?.visible || activeLayer.locked} title={`绘制${label}`} aria-label={`绘制${label}`} className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-35 ${tool === kind ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}><Icon className="h-3.5 w-3.5" />+ {label}</button>;
                    })()
                  ))}
                  <label className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--ink-subtle)]">
                    <Clock3 className="h-3.5 w-3.5" />
                    <span className="sr-only">时间切片</span>
                    <select
                      value={timelineCursor === null ? "all" : String(timelineCursor)}
                      onChange={(event) => setTimelineCursor(event.target.value === "all" ? null : Number(event.target.value))}
                      className="max-w-44 rounded border border-[var(--line)] bg-[var(--paper)] px-1.5 py-1 text-[10px] text-[var(--ink-muted)]"
                      aria-label="时间切片"
                    >
                      <option value="all">全部时间</option>
                      {timelineEvents.map((event) => (
                        <option key={event.id} value={event.sortKey}>{event.timeLabel} · {event.title}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="min-h-0 flex-1 bg-[#d8d1c3] p-3">
                  <div className="h-full overflow-hidden rounded-md border border-[#746b6038] bg-[#f3f0e8] shadow-[0_12px_32px_rgba(55,47,39,0.12)]">
                    <MapCanvas document={doc.map} tool={tool} activeLayerId={activeLayerId} selectedFeatureId={selectedFeatureId} timelineCursor={timelineCursor} onSelect={setSelectedFeatureId} onCreate={createFeature} onGeometryChange={updateGeometry} />
                  </div>
                </div>
              </>
            )}
          </main>

          <aside className="flex w-64 shrink-0 flex-col border-l border-[var(--line-subtle)] max-lg:hidden">
            <div className="flex h-9 shrink-0 items-center border-b border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
              要素检查器
            </div>
            {!selectedFeature ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs">
                <p className="leading-5 text-[var(--ink-muted)]">点击画布上的要素查看与编辑；工具栏可添加要素。地图级设置在这里统一管理。</p>
                <label className="block"><span className="mb-1 block text-[var(--ink-muted)]">画布尺寸</span><div className="grid grid-cols-2 gap-2"><input type="number" min={320} max={100000} value={doc?.map.canvas.width ?? 1600} onChange={(event) => updateCanvas({ width: Math.max(320, Number(event.target.value) || 1600) })} aria-label="画布宽度" className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2 py-1.5" /><input type="number" min={240} max={100000} value={doc?.map.canvas.height ?? 1000} onChange={(event) => updateCanvas({ height: Math.max(240, Number(event.target.value) || 1000) })} aria-label="画布高度" className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2 py-1.5" /></div></label>
                <div className="grid grid-cols-2 gap-2"><label className="block"><span className="mb-1 block text-[var(--ink-muted)]">底色</span><input type="color" value={doc?.map.canvas.backgroundColor ?? "#f3f0e8"} onChange={(event) => updateCanvas({ backgroundColor: event.target.value })} className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]" /></label><label className="flex items-end gap-2 pb-1.5 text-[var(--ink-muted)]"><input type="checkbox" checked={doc?.map.canvas.showGrid ?? true} onChange={(event) => updateCanvas({ showGrid: event.target.checked })} />显示网格</label></div>
                <label className="block"><span className="mb-1 block text-[var(--ink-muted)]">底图</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => importBackground(event.target.files?.[0])} className="block w-full text-[11px] text-[var(--ink-muted)]" />{doc?.map.canvas.backgroundImage && <button type="button" onClick={() => updateCanvas({ backgroundImage: null })} className="mt-2 rounded border border-[var(--line)] px-2 py-1 text-[11px] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]">移除底图</button>}</label>
                {doc?.map.canvas.backgroundImage && <label className="block"><span className="mb-1 block text-[var(--ink-muted)]">底图透明度 · {Math.round((doc.map.canvas.backgroundOpacity ?? 1) * 100)}%</span><input type="range" min={0.1} max={1} step={0.05} value={doc.map.canvas.backgroundOpacity ?? 1} onChange={(event) => updateCanvas({ backgroundOpacity: Number(event.target.value) })} className="w-full" /></label>}
              </div>
            ) : (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs">
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">名称</span>
                  <input
                    value={selectedFeature.name}
                    onChange={(event) =>
                      updateFeature(selectedFeature.id, { name: event.target.value })
                    }
                    className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none focus:border-[var(--accent-warm)]"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">线条颜色</span>
                    <input type="color" value={selectedFeature.props.color ?? "#b26d45"} onChange={(event) => updateFeature(selectedFeature.id, { props: { ...selectedFeature.props, color: event.target.value } })} className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">线宽</span>
                    <input type="number" min={1} max={12} value={selectedFeature.props.lineWidth ?? "2"} onChange={(event) => updateFeature(selectedFeature.id, { props: { ...selectedFeature.props, lineWidth: String(Math.max(1, Math.min(12, Number(event.target.value) || 2))) } })} className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none" />
                  </label>
                </div>
                {(selectedFeature.kind === "label" || selectedFeature.kind === "marker" || selectedFeature.kind === "node") && (
                  <label className="flex items-center gap-2 text-[var(--ink-muted)]"><input type="checkbox" checked={selectedFeature.props.showLabel === "true" || selectedFeature.kind === "label"} disabled={selectedFeature.kind === "label"} onChange={(event) => updateFeature(selectedFeature.id, { props: { ...selectedFeature.props, showLabel: String(event.target.checked) } })} />显示名称</label>
                )}
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">类型</span>
                  <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5">
                    {FEATURE_KIND_LABELS[selectedFeature.kind]}
                  </span>
                </label>
                <div className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">关联实体（派生）</span>
                  {selectedFeature.entityRef ? (
                    <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5">
                       {entityOptions.find(
                         (option) =>
                           option.id === selectedFeature.entityRef?.id &&
                           option.kind === selectedFeature.entityRef?.kind,
                       )?.name ?? selectedFeature.entityRef.id}
                      <span className="ml-1 text-[var(--ink-subtle)]">
                        ({selectedFeature.entityRef.kind})
                      </span>
                    </span>
                  ) : (
                    <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5 text-[var(--ink-muted)]">
                      未关联实体
                    </span>
                  )}
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">修改关联实体</span>
                  <CustomSelect
                     value={
                       selectedFeature.entityRef
                         ? `${selectedFeature.entityRef.kind}:${selectedFeature.entityRef.id}`
                         : ""
                     }
                    options={[
                      { value: "", label: "（不关联）" },
                      ...entityOptions.map((option) => ({
                         value: `${option.kind}:${option.id}`,
                        label: `${option.name}（${option.kind}）`,
                      })),
                    ]}
                    onChange={(value) => {
                      const [kind, id] = value.split(":");
                      const entity = entityOptions.find(
                        (option) => option.kind === kind && option.id === id,
                      );
                      updateFeature(selectedFeature.id, {
                        entityRef: entity
                          ? { kind: entity.kind as MapEntityKind, id: entity.id }
                          : null,
                      });
                    }}
                    ariaLabel="关联实体"
                    size="sm"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">时间起点</span>
                    <input
                      type="number"
                      value={selectedFeature.timeFrom ?? ""}
                      onChange={(event) =>
                        updateFeature(selectedFeature.id, {
                          timeFrom: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                      placeholder="长期或未知"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">时间终点</span>
                    <input
                      type="number"
                      value={selectedFeature.timeTo ?? ""}
                      onChange={(event) =>
                        updateFeature(selectedFeature.id, {
                          timeTo: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                      placeholder="长期或未知"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">说明</span>
                  <textarea
                    value={selectedFeature.description}
                    onChange={(event) =>
                      updateFeature(selectedFeature.id, {
                        description: event.target.value,
                      })
                    }
                    rows={3}
                    className="w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeFeature(selectedFeature.id)}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-[var(--error)] hover:bg-[var(--error-bg)]"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 删除要素
                </button>
              </div>
            )}
          </aside>
        </div>
      )}

      {newMapOpen && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/30 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setNewMapOpen(false);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createMap();
            }}
            className="w-full max-w-sm rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
          >
            <h2 className="text-base font-semibold">新建地图</h2>
            <label className="mt-4 block text-sm">
              <span className="mb-1 block text-[var(--ink-muted)]">名称</span>
              <input
                value={newMapName}
                onChange={(event) => setNewMapName(event.target.value)}
                autoFocus
                placeholder="例如：九州全图"
                className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none focus:border-[var(--accent-warm)]"
              />
            </label>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block text-[var(--ink-muted)]">投影类型</span>
              <CustomSelect
                value={newMapProjection}
                options={Object.entries(MAP_PROJECTION_LABELS).map(
                  ([value, label]) => ({ value, label }),
                )}
                onChange={(value) =>
                  setNewMapProjection(value as MapProjectionType)
                }
                ariaLabel="投影类型"
                size="sm"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNewMapOpen(false)}
                className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
              >
                取消
              </button>
              <button
                type="submit"
                className="flex items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 py-1.5 text-sm font-medium text-white"
              >
                <Check className="h-3.5 w-3.5" /> 创建
              </button>
            </div>
          </form>
        </div>
      )}

      {proposalReviewOpen && (
        <MapProposalReview
          storage={storage}
          projectTitle={projectTitle}
          onApplied={() => void loadMaps()}
          onClose={() => setProposalReviewOpen(false)}
        />
      )}
      {deleteMapTarget && (
        <ConfirmDialog
          title="删除地图"
          message={`确定要删除地图“${maps.find((entry) => entry.id === deleteMapTarget)?.name ?? deleteMapTarget}”吗？其记录文件会被移除。`}
          confirmText="删除"
          confirmVariant="danger"
          onConfirm={() => {
            void (async () => {
              try {
                await repository.deleteMap(deleteMapTarget);
                if (selectedMapId === deleteMapTarget) {
                  setDoc(null);
                  setSelectedMapId(null);
                }
                await loadMaps();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setDeleteMapTarget(null);
              }
            })();
          }}
          onCancel={() => setDeleteMapTarget(null)}
        />
      )}
    </div>
  );
}
