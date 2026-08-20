import {
  ExternalLink,
  FileUp,
  Loader2,
  Mountain,
  Orbit,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CustomSelect, type WorkbenchStorage } from "@/workbench-sdk";
import {
  MAP_GENERATORS,
  generateRedBlobCandidate,
  importAzgaarCandidate,
  previewGeneratorCandidate,
  type MapGeneratorCandidate,
  type MapGeneratorId,
} from "../business/mapGenerators";
import { mapGenerationLevelIds } from "../business/mapGenerationScope";
import type { MapDocument } from "../entities/mapSchema";
import {
  createNovelSettingLibraryRepository,
  type LoadedSettingLibrary,
} from "../../../settingLibraryRepository";
import MapProposalPreview from "./MapProposalPreview";

const AZGAAR_URL = "https://azgaar.github.io/Fantasy-Map-Generator/";

interface MapGeneratorDialogProps {
  readonly document: MapDocument;
  readonly activeLayerId: string;
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly agentAvailable: boolean;
  readonly agentLaunching: boolean;
  readonly onLaunchAgent: (request: MapAgentGenerationRequest) => Promise<void>;
  readonly onApply: (candidate: MapGeneratorCandidate) => void;
  readonly onClose: () => void;
}

export interface MapAgentGenerationRequest {
  readonly mapId: string;
  readonly mapName: string;
  readonly layerId: string;
  readonly width: number;
  readonly height: number;
  readonly seed: string;
  readonly worldNodeId: string;
  readonly worldNodeName: string;
  readonly worldNodePath: string;
  readonly generationLevelTypeId: string;
  readonly generationLevelName: string;
}

type SpatialScopeOption = {
  readonly id: string;
  readonly name: string;
  readonly path: string;
};

function spatialScopeOptions(
  library: LoadedSettingLibrary,
): readonly SpatialScopeOption[] {
  const nodesById = new Map(
    library.spatialTree.nodes.map((node) => [node.id, node] as const),
  );
  const typeById = new Map(
    library.meta.levelTypes.map((type) => [type.id, type] as const),
  );
  const getPath = (nodeId: string): string => {
    const parts: string[] = [];
    const visited = new Set<string>();
    let node = nodesById.get(nodeId);
    while (node && !visited.has(node.id)) {
      visited.add(node.id);
      parts.unshift(node.name);
      node = node.parentId ? nodesById.get(node.parentId) : undefined;
    }
    return parts.join(" / ");
  };
  return [...library.spatialTree.nodes]
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.name.localeCompare(right.name, "zh-CN"),
    )
    .map((node) => {
      const type = typeById.get(node.typeId);
      return {
        id: node.id,
        name: node.name,
        path: getPath(node.id),
        ...(type ? { typeName: type.name } : {}),
      };
    });
}

function preferredGenerationLevelId(levelIds: readonly string[]): string {
  return (
    ["continent", "country", "province", "city", "planet"].find((id) =>
      levelIds.includes(id),
    ) ??
    levelIds[0] ??
    ""
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function MapGeneratorDialog({
  document,
  activeLayerId,
  storage,
  projectTitle,
  agentAvailable,
  agentLaunching,
  onLaunchAgent,
  onApply,
  onClose,
}: MapGeneratorDialogProps) {
  const [generatorId, setGeneratorId] =
    useState<MapGeneratorId>("agent-azgaar");
  const [candidate, setCandidate] = useState<MapGeneratorCandidate | null>(
    null,
  );
  const [seed, setSeed] = useState(() => document.id);
  const [worldLibrary, setWorldLibrary] = useState<LoadedSettingLibrary | null>(
    null,
  );
  const [worldLibraryError, setWorldLibraryError] = useState<string | null>(
    null,
  );
  const [worldNodeId, setWorldNodeId] = useState("");
  const [generationLevelTypeId, setGenerationLevelTypeId] = useState("");
  const [landmassCount, setLandmassCount] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generator = MAP_GENERATORS.find((entry) => entry.id === generatorId)!;
  const scopeOptions = useMemo(
    () => (worldLibrary ? spatialScopeOptions(worldLibrary) : []),
    [worldLibrary],
  );
  const generationLevelOptions = useMemo(() => {
    if (!worldLibrary || !worldNodeId) return [];
    const availableIds = new Set(
      mapGenerationLevelIds(worldLibrary, worldNodeId),
    );
    return worldLibrary.meta.levelTypes
      .filter((type) => availableIds.has(type.id))
      .map((type) => ({ value: type.id, label: type.name }));
  }, [worldLibrary, worldNodeId]);
  const selectedScope = scopeOptions.find(
    (option) => option.id === worldNodeId,
  );
  const selectedGenerationLevel = worldLibrary?.meta.levelTypes.find(
    (type) => type.id === generationLevelTypeId,
  );
  const previewMap = useMemo(() => {
    if (!candidate) return null;
    // 预览必须走与“加入当前地图”相同的投影链路，才能看到场景区域、
    // 地形材质、素材印章、底图以及来源图层，而不是只显示候选折线。
    return previewGeneratorCandidate(document, candidate);
  }, [candidate, document]);

  useEffect(() => {
    let disposed = false;
    void createNovelSettingLibraryRepository(storage)
      .load(projectTitle)
      .then((library) => {
        if (disposed) return;
        setWorldLibrary(library);
        setWorldLibraryError(null);
      })
      .catch((cause) => {
        if (disposed) return;
        setWorldLibraryError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, [projectTitle, storage]);

  useEffect(() => {
    if (scopeOptions.length === 0) return;
    setWorldNodeId((current) =>
      scopeOptions.some((option) => option.id === current)
        ? current
        : scopeOptions[0]!.id,
    );
  }, [scopeOptions]);

  useEffect(() => {
    const levelIds = generationLevelOptions.map((option) => option.value);
    if (levelIds.length === 0) {
      setGenerationLevelTypeId("");
      return;
    }
    setGenerationLevelTypeId((current) =>
      levelIds.includes(current)
        ? current
        : preferredGenerationLevelId(levelIds),
    );
  }, [generationLevelOptions]);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 24 * 1024 * 1024) {
      setError("生成器文件不能超过 24 MB。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const content = await file.text();
      setCandidate(
        importAzgaarCandidate({
          fileName: file.name,
          content,
          document,
          layerId: activeLayerId,
        }),
      );
    } catch (cause) {
      setCandidate(null);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const generate = () => {
    setError(null);
    setCandidate(
      generateRedBlobCandidate({
        seed,
        document,
        layerId: activeLayerId,
        landmassCount,
      }),
    );
  };

  const launchAgent = async () => {
    setError(null);
    if (!selectedScope || !selectedGenerationLevel) {
      setError("请先选择世界架构范围和生成层级。");
      return;
    }
    try {
      await onLaunchAgent({
        mapId: document.id,
        mapName: document.name,
        layerId: activeLayerId,
        width: document.canvas.width,
        height: document.canvas.height,
        seed,
        worldNodeId: selectedScope.id,
        worldNodeName: selectedScope.name,
        worldNodePath: selectedScope.path,
        generationLevelTypeId: selectedGenerationLevel.id,
        generationLevelName: selectedGenerationLevel.name,
      });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[320] flex items-center justify-center px-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="map-generator-title"
        className="flex max-h-[min(720px,88vh)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl"
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line)] px-4">
          <Sparkles className="h-4 w-4 text-[var(--accent-warm)]" />
          <h2 id="map-generator-title" className="text-sm font-semibold">
            地图生成器
          </h2>
          <span className="text-xs text-[var(--ink-muted)]">
            {document.name}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭地图生成器"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] max-sm:grid-cols-1">
          <nav className="border-r border-[var(--line-subtle)] p-3 max-sm:border-r-0 max-sm:border-b">
            {MAP_GENERATORS.map((entry) => {
              const Icon =
                entry.id === "agent-azgaar"
                  ? Orbit
                  : entry.id === "azgaar"
                    ? Mountain
                    : Sparkles;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    setGeneratorId(entry.id);
                    setCandidate(null);
                    setError(null);
                  }}
                  className={`mb-1 flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left ${generatorId === entry.id ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <strong className="block text-xs font-medium">
                      {entry.name}
                    </strong>
                    <span className="mt-1 block text-xs leading-4 text-[var(--ink-subtle)]">
                      {entry.mode === "agent"
                        ? "读取设定 · Agent Tool"
                        : entry.mode === "import"
                          ? "外部生成 · 本地导入"
                          : "离线备选 · 不读取设定"}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 overflow-y-auto p-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">{generator.name}</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
                  {generator.description}
                </p>
              </div>
              {generatorId === "azgaar" && (
                <a
                  href={AZGAAR_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> 打开 Azgaar
                </a>
              )}
            </div>

            {generatorId === "agent-azgaar" ? (
              <div className="mt-5 rounded-md border border-[var(--line)] bg-[var(--paper-inset)] p-4">
                <div className="grid grid-cols-2 gap-3">
                  <label className="col-span-2 block text-xs">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      世界架构范围
                    </span>
                    <CustomSelect
                      value={worldNodeId}
                      options={scopeOptions.map((option) => ({
                        value: option.id,
                        label: option.path,
                      }))}
                      onChange={setWorldNodeId}
                      ariaLabel="世界架构范围"
                      placeholder="正在读取世界架构…"
                      disabled={!worldLibrary || scopeOptions.length === 0}
                      popoverMinWidth={360}
                    />
                  </label>
                  <label className="col-span-2 block text-xs">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      生成层级
                    </span>
                    <CustomSelect
                      value={generationLevelTypeId}
                      options={generationLevelOptions}
                      onChange={setGenerationLevelTypeId}
                      ariaLabel="生成层级"
                      placeholder="请选择生成层级"
                      disabled={generationLevelOptions.length === 0}
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      种子
                    </span>
                    <input
                      value={seed}
                      onChange={(event) => setSeed(event.target.value)}
                      className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 outline-none focus:border-[var(--accent-warm)]"
                    />
                  </label>
                </div>
                <div className="mt-4 border-t border-[var(--line-subtle)] pt-4">
                  <div className="flex items-start gap-2 text-xs leading-5 text-[var(--ink-muted)]">
                    <Orbit className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-warm)]" />
                    <span>
                      Agent
                      会读取所选范围及其下级的设定、地点与势力，自己决定大陆、区域、河流和国家等密度，再调用
                      Azgaar
                      Tool。生成结果进入地图提案审阅，不会直接覆盖当前地图。
                    </span>
                  </div>
                  {worldLibraryError && (
                    <p className="mt-2 text-xs text-[var(--error)]">
                      世界架构读取失败：{worldLibraryError}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={
                      !agentAvailable ||
                      agentLaunching ||
                      !selectedScope ||
                      !selectedGenerationLevel
                    }
                    onClick={() => void launchAgent()}
                    className="mt-4 flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent-warm)] text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {agentLaunching ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Orbit className="h-3.5 w-3.5" />
                    )}
                    {agentLaunching ? "正在打开 Agent..." : "交给 Agent 生成"}
                  </button>
                  {!agentAvailable && (
                    <p className="mt-2 text-xs text-[var(--error)]">
                      MyAgents Agent Session 当前不可用，无法执行设定驱动生成。
                    </p>
                  )}
                </div>
              </div>
            ) : generatorId === "azgaar" ? (
              <label className="mt-5 flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-[var(--line-strong)] bg-[var(--paper-inset)] px-5 text-center hover:border-[var(--accent-warm)]">
                {loading ? (
                  <Loader2 className="h-6 w-6 animate-spin text-[var(--accent-warm)]" />
                ) : (
                  <FileUp className="h-6 w-6 text-[var(--accent-warm)]" />
                )}
                <span className="mt-3 text-sm font-medium">
                  选择 Azgaar 导出文件
                </span>
                <span className="mt-1 text-xs text-[var(--ink-muted)]">
                  Full / Minimal JSON、GeoJSON 或 SVG；原生 .map 请先在独立
                  Azgaar 中打开后导出
                </span>
                <input
                  type="file"
                  accept=".json,.geojson,.svg,.map,application/json,image/svg+xml,application/octet-stream"
                  className="sr-only"
                  onChange={(event) => void importFile(event.target.files?.[0])}
                />
              </label>
            ) : (
              <div className="mt-5 grid grid-cols-2 gap-3 rounded-md border border-[var(--line)] bg-[var(--paper-inset)] p-4">
                <label className="block text-xs">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    种子
                  </span>
                  <input
                    value={seed}
                    onChange={(event) => setSeed(event.target.value)}
                    className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 outline-none focus:border-[var(--accent-warm)]"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    大陆数量 · {landmassCount}
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={6}
                    value={landmassCount}
                    onChange={(event) =>
                      setLandmassCount(Number(event.target.value))
                    }
                    className="h-9 w-full"
                  />
                </label>
                <button
                  type="button"
                  onClick={generate}
                  className="col-span-2 flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--ink)] text-xs font-medium text-[var(--paper)]"
                >
                  <Sparkles className="h-3.5 w-3.5" /> 生成离线草图
                </button>
              </div>
            )}

            {error && (
              <p className="mt-4 rounded-md bg-[var(--error-bg)] px-3 py-2 text-xs text-[var(--error)]">
                {error}
              </p>
            )}
            {candidate && (
              <>
                {previewMap && (
                  <MapProposalPreview
                    key={`${previewMap.id}:${previewMap.canvas.width}:${previewMap.canvas.height}`}
                    map={previewMap}
                    className="mt-4"
                  />
                )}
                <div className="mt-3 border-t border-[var(--line-subtle)] pt-3">
                  <div className="flex items-center gap-2">
                    <strong className="min-w-0 flex-1 truncate text-sm">
                      {candidate.title}
                    </strong>
                    <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                      {candidate.features.length} 个要素
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
                    {candidate.summary}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <footer className="flex min-h-14 shrink-0 items-center justify-end gap-2 border-t border-[var(--line)] px-4 py-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-[var(--line)] px-3 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            取消
          </button>
          {generatorId !== "agent-azgaar" && (
            <button
              type="button"
              disabled={!candidate}
              onClick={() => candidate && onApply(candidate)}
              className="h-8 rounded-md bg-[var(--accent-warm)] px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              加入当前地图
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
