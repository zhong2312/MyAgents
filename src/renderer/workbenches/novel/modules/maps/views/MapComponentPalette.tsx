import {
  Check,
  Landmark,
  MapPin,
  Mountain,
  Crosshair,
  Palette,
  Paintbrush,
  Pencil,
  Pentagon,
  Sparkles,
  Trash2,
  Trees,
  Upload,
  Waves,
  X,
} from "lucide-react";
import { useState } from "react";

import {
  MAP_COMPONENT_CATEGORIES,
  MAP_COMPONENT_DRAG_MIME,
  mapComponentPlacement,
  mapComponentsInCategory,
  type MapComponentCategory,
  type MapComponentPreset,
} from "../business/mapComponents";
import { getMapArtworkStampAsset } from "../business/mapArtwork";
import type { MapArtworkStampAsset } from "../business/mapArtwork";
import type { MapProjectArtworkUsage } from "../business/mapProjectArtwork";
import {
  MAP_TERRAIN_MATERIAL_PRESETS,
  type MapTerrainMaterialPreset,
} from "../business/mapTerrainMaterials";
import type { MapTerrainMaterial } from "../entities/mapSchema";

type PaletteCategory =
  | MapComponentCategory
  | "terrain-material"
  | "project-artwork";

const CATEGORY_ICONS = {
  celestial: Sparkles,
  landmass: Pentagon,
  mountain: Mountain,
  vegetation: Trees,
  water: Waves,
  civilization: Landmark,
  landmark: MapPin,
  "terrain-material": Palette,
  "project-artwork": Upload,
} as const;

interface MapComponentPaletteProps {
  readonly disabled: boolean;
  readonly terrainMaterialDisabled?: boolean;
  readonly onInsert: (component: MapComponentPreset) => void;
  readonly onPick?: (component: MapComponentPreset) => void;
  readonly onBrush?: (component: MapComponentPreset) => void;
  readonly onTerrainMaterial?: (material: MapTerrainMaterialPreset) => void;
  readonly activeBrushAssetId?: string | null;
  readonly activeStampAssetId?: string | null;
  readonly activeComponentId?: string | null;
  readonly activeTerrainMaterial?: MapTerrainMaterial | null;
  readonly activeToolLabel?: string;
  readonly projectArtworkAssets?: readonly MapArtworkStampAsset[];
  readonly projectArtworkUsage?: ReadonlyMap<string, MapProjectArtworkUsage>;
  readonly onImportProjectArtwork?: () => void;
  readonly onPickProjectArtwork?: (assetId: string) => void;
  readonly onBrushProjectArtwork?: (assetId: string) => void;
  readonly onRenameProjectArtwork?: (assetId: string, name: string) => void;
  readonly onRemoveProjectArtwork?: (assetId: string) => void;
  readonly orientation?: "horizontal" | "vertical";
}

export default function MapComponentPalette({
  disabled,
  terrainMaterialDisabled = disabled,
  onInsert,
  onPick,
  onBrush,
  onTerrainMaterial,
  activeBrushAssetId = null,
  activeStampAssetId = null,
  activeComponentId = null,
  activeTerrainMaterial = null,
  activeToolLabel,
  projectArtworkAssets = [],
  projectArtworkUsage = new Map(),
  onImportProjectArtwork,
  onPickProjectArtwork,
  onBrushProjectArtwork,
  onRenameProjectArtwork,
  onRemoveProjectArtwork,
  orientation = "horizontal",
}: MapComponentPaletteProps) {
  const [category, setCategory] = useState<PaletteCategory>(
    onTerrainMaterial ? "terrain-material" : "celestial",
  );
  const [editingProjectArtworkId, setEditingProjectArtworkId] = useState<
    string | null
  >(null);
  const [projectArtworkName, setProjectArtworkName] = useState("");
  const categories: readonly {
    readonly id: PaletteCategory;
    readonly name: string;
  }[] = [
    ...(onTerrainMaterial
      ? ([{ id: "terrain-material", name: "地貌材质" }] as const)
      : []),
    ...MAP_COMPONENT_CATEGORIES,
    ...(onImportProjectArtwork || projectArtworkAssets.length > 0
      ? ([{ id: "project-artwork", name: "项目素材" }] as const)
      : []),
  ];
  const components =
    category === "terrain-material" || category === "project-artwork"
      ? []
      : mapComponentsInCategory(category);
  const vertical = orientation === "vertical";

  return (
    <section
      className={
        vertical
          ? "map-asset-dock flex w-[218px] shrink-0 flex-col border-r border-[var(--line-subtle)] bg-[var(--paper)]"
          : "shrink-0 border-b border-[var(--line-subtle)] bg-[var(--paper)]"
      }
      aria-label="地图构件库"
    >
      <div
        className={
          vertical
            ? "shrink-0 border-b border-[var(--line-subtle)] px-3 py-3"
            : "flex min-h-10 items-center gap-1 overflow-x-auto border-b border-[var(--line-subtle)] px-3 py-1"
        }
      >
        <div className={vertical ? "mb-2" : "contents"}>
          <span className="mr-1 shrink-0 text-xs font-semibold tracking-wide text-[var(--ink)]">
            资产库
          </span>
          {vertical && (
            <span className="mt-1 block text-xs text-[var(--ink-subtle)]">
              拖入画布即可放置预制件
            </span>
          )}
        </div>
        {categories.map((item) => {
          const Icon = CATEGORY_ICONS[item.id];
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setCategory(item.id)}
              className={`${vertical ? "h-8 w-full justify-start px-2.5" : "h-7 shrink-0 px-2"} flex items-center gap-1.5 rounded-md text-xs transition-colors ${category === item.id ? "bg-[var(--accent-warm)] text-[#171b1e]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.name}
            </button>
          );
        })}
      </div>
      <div
        className={
          vertical
            ? "min-h-0 flex-1 overflow-y-auto px-2.5 py-3"
            : "flex min-h-12 items-stretch gap-1 overflow-x-auto px-3 py-1.5"
        }
      >
        {vertical && activeToolLabel && (
          <div className="mb-2 flex items-center justify-between rounded-md border border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)] px-2 py-1.5 text-xs">
            <span className="text-[var(--ink-muted)]">当前工具</span>
            <span className="max-w-28 truncate font-medium text-[var(--ink)]">
              {activeToolLabel}
            </span>
          </div>
        )}
        {vertical && (
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-subtle)]">
              {categories.find((item) => item.id === category)?.name}
            </span>
            <span className="text-xs text-[var(--ink-subtle)]">
              {category === "terrain-material"
                ? MAP_TERRAIN_MATERIAL_PRESETS.length
                : category === "project-artwork"
                  ? projectArtworkAssets.length
                  : components.length}{" "}
              项
            </span>
          </div>
        )}
        {category === "terrain-material" && onTerrainMaterial ? (
          <div className={vertical ? "grid grid-cols-2 gap-1.5" : "contents"}>
            {MAP_TERRAIN_MATERIAL_PRESETS.map((material) => (
              <button
                key={material.id}
                type="button"
                disabled={terrainMaterialDisabled}
                onClick={() => onTerrainMaterial(material)}
                title={material.description}
                aria-label={`使用${material.name}材质笔刷`}
                className={`${vertical ? "min-h-[76px] w-full px-2 py-2" : "w-[88px] shrink-0 px-2 py-1.5"} flex flex-col items-start justify-end rounded-md border text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${activeTerrainMaterial === material.id ? "border-[var(--accent-warm)] bg-[var(--hover-bg)]" : "border-transparent hover:border-[var(--line)] hover:bg-[var(--hover-bg)]"}`}
              >
                <span
                  className={`${vertical ? "h-10" : "h-9"} mb-1 block w-full rounded border border-[var(--line-subtle)]`}
                  style={{
                    backgroundColor: material.color,
                    backgroundImage: material.preview,
                    backgroundSize: "auto",
                  }}
                  aria-hidden="true"
                />
                <span className="w-full truncate font-medium">
                  {material.name}
                </span>
              </button>
            ))}
          </div>
        ) : category === "project-artwork" ? (
          <div className={vertical ? "space-y-2" : "flex items-stretch gap-1"}>
            {onImportProjectArtwork && (
              <button
                type="button"
                disabled={disabled}
                onClick={onImportProjectArtwork}
                className={`${vertical ? "flex min-h-[76px] w-full flex-col items-start justify-center gap-1.5 px-2" : "flex w-[112px] shrink-0 flex-col items-center justify-center gap-1 px-2"} rounded-md border border-dashed border-[var(--line)] text-xs text-[var(--ink-muted)] transition-colors hover:border-[var(--accent-warm)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35`}
              >
                <Upload className="h-4 w-4 text-[var(--accent-warm)]" />
                <span>导入 PNG / JPG / WebP</span>
              </button>
            )}
            {projectArtworkAssets.map((asset) => {
              const usage = projectArtworkUsage.get(asset.id);
              const isEditing = editingProjectArtworkId === asset.id;
              const used = (usage?.total ?? 0) > 0;
              return (
                <div
                  key={asset.id}
                  className={`${vertical ? "min-h-[116px] w-full" : "w-[112px] shrink-0"} relative rounded-md border border-transparent transition-colors hover:border-[var(--line)] hover:bg-[var(--hover-bg)] ${activeBrushAssetId === asset.id || activeStampAssetId === asset.id ? "border-[var(--accent-warm)] bg-[var(--hover-bg)]" : ""} ${disabled ? "opacity-35" : ""}`}
                >
                  <button
                    type="button"
                    disabled={disabled || !onPickProjectArtwork || isEditing}
                    draggable={
                      !disabled && Boolean(onPickProjectArtwork) && !isEditing
                    }
                    onClick={() => onPickProjectArtwork?.(asset.id)}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "copy";
                      event.dataTransfer.setData(
                        MAP_COMPONENT_DRAG_MIME,
                        asset.id,
                      );
                    }}
                    title={`放置${asset.name}`}
                    aria-label={`放置${asset.name}`}
                    className={`${vertical ? "min-h-[96px] w-full items-start justify-end px-2 py-2" : "w-full justify-center px-2 py-1.5"} flex flex-col text-left text-xs disabled:cursor-not-allowed`}
                  >
                    <span
                      className={`${vertical ? "h-12" : "h-10"} mb-1 flex w-full items-center justify-center overflow-hidden rounded border border-[var(--line-subtle)] bg-[var(--paper-elevated)]`}
                    >
                      <img
                        src={asset.imageSrc}
                        alt=""
                        draggable={false}
                        className="h-full w-full object-contain p-1"
                      />
                    </span>
                    <span className="w-full truncate font-medium">
                      {asset.name}
                    </span>
                    <span className="mt-0.5 w-full truncate text-xs text-[var(--ink-subtle)]">
                      {used
                        ? `${usage?.stamps ?? 0} 印章 · ${usage?.brushStrokes ?? 0} 笔触`
                        : "未使用"}
                    </span>
                  </button>
                  <div className="absolute left-1 top-1 flex gap-1">
                    {onRenameProjectArtwork && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          setEditingProjectArtworkId(asset.id);
                          setProjectArtworkName(asset.name);
                        }}
                        title={`重命名${asset.name}`}
                        aria-label={`重命名${asset.name}`}
                        className="grid h-6 w-6 place-items-center rounded border border-[var(--line-subtle)] bg-[var(--paper-elevated)] text-[var(--ink-subtle)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {onRemoveProjectArtwork && (
                      <button
                        type="button"
                        disabled={disabled || used}
                        onClick={() => onRemoveProjectArtwork(asset.id)}
                        title={
                          used
                            ? `已被 ${usage?.total ?? 0} 处地图内容使用，删除引用后才能移除`
                            : `移除${asset.name}`
                        }
                        aria-label={`移除${asset.name}`}
                        className="grid h-6 w-6 place-items-center rounded border border-[var(--line-subtle)] bg-[var(--paper-elevated)] text-[var(--ink-subtle)] hover:text-[var(--error)] disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {asset.brush && onBrushProjectArtwork && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onBrushProjectArtwork(asset.id)}
                      title={`使用${asset.name}笔刷`}
                      aria-label={`使用${asset.name}笔刷`}
                      className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded border border-[var(--line-subtle)] bg-[var(--paper-elevated)] text-[var(--ink-subtle)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed"
                    >
                      <Paintbrush className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {isEditing && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        onRenameProjectArtwork?.(asset.id, projectArtworkName);
                        setEditingProjectArtworkId(null);
                      }}
                      className="absolute inset-x-1 bottom-1 z-10 flex items-center gap-1 rounded border border-[var(--line)] bg-[var(--paper-elevated)] p-1"
                    >
                      <input
                        autoFocus
                        value={projectArtworkName}
                        onChange={(event) =>
                          setProjectArtworkName(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.preventDefault();
                          setEditingProjectArtworkId(null);
                        }}
                        aria-label={`重命名${asset.name}`}
                        className="min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
                      />
                      <button
                        type="submit"
                        title="确认重命名"
                        aria-label="确认重命名"
                        className="grid h-5 w-5 shrink-0 place-items-center text-[var(--accent-warm)]"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingProjectArtworkId(null)}
                        title="取消重命名"
                        aria-label="取消重命名"
                        className="grid h-5 w-5 shrink-0 place-items-center text-[var(--ink-subtle)]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className={vertical ? "grid grid-cols-2 gap-1.5" : "contents"}>
            {components.map((component) =>
              (() => {
                const asset = getMapArtworkStampAsset(component.id);
                const startsBrush = Boolean(
                  asset?.brush &&
                    onBrush &&
                    mapComponentPlacement(component) === "stamp",
                );
                return (
                  <div
                    key={component.id}
                    className={`${vertical ? "min-h-[96px] w-full" : "w-[96px] shrink-0"} relative rounded-md border border-transparent transition-colors hover:border-[var(--line)] hover:bg-[var(--hover-bg)] ${activeBrushAssetId === component.id || activeStampAssetId === component.id || activeComponentId === component.id ? "border-[var(--accent-warm)] bg-[var(--hover-bg)]" : ""} ${disabled ? "opacity-35" : ""}`}
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      draggable={!disabled}
                      onClick={() => {
                        if (startsBrush) {
                          onBrush?.(component);
                          return;
                        }
                        onInsert(component);
                      }}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "copy";
                        event.dataTransfer.setData(
                          MAP_COMPONENT_DRAG_MIME,
                          component.id,
                        );
                      }}
                      title={`${component.name}：${component.description}。${startsBrush ? "点击后沿画布拖动即可连续绘制。" : "点击后在画布放置或拖绘。"}`}
                      aria-label={
                        startsBrush
                          ? `使用${component.name}笔刷`
                          : `放置${component.name}`
                      }
                      className={`${vertical ? "min-h-[96px] w-full items-start justify-end px-2 py-2" : "w-full justify-center px-2 py-1.5"} flex flex-col text-left text-xs disabled:cursor-not-allowed`}
                    >
                      <span
                        className={`${vertical ? "h-12" : "h-10"} mb-1 flex w-full items-center justify-center overflow-hidden rounded border border-[var(--line-subtle)] bg-[var(--paper-elevated)]`}
                      >
                        {asset ? (
                          <img
                            src={asset.imageSrc}
                            alt=""
                            draggable={false}
                            className="h-full w-full object-contain p-1"
                          />
                        ) : (
                          (() => {
                            const Icon = CATEGORY_ICONS[component.category];
                            return (
                              <Icon className="h-4 w-4 text-[var(--accent-warm)]" />
                            );
                          })()
                        )}
                      </span>
                      <span className="truncate font-medium">
                        {component.name}
                      </span>
                      {!vertical && (
                        <span className="mt-0.5 truncate text-xs text-[var(--ink-subtle)]">
                          拖入即落图
                        </span>
                      )}
                    </button>
                    {asset?.brush &&
                      onBrush &&
                      mapComponentPlacement(component) !== "stamp" && (
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => onBrush(component)}
                          title={`使用${component.name}笔刷`}
                          aria-label={`使用${component.name}笔刷`}
                          className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded border border-[var(--line-subtle)] bg-[var(--paper-elevated)] text-[var(--ink-subtle)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed"
                        >
                          <Paintbrush className="h-3.5 w-3.5" />
                        </button>
                      )}
                    {onPick && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onPick(component)}
                        title={`拾取${component.name}并在画布落图`}
                        aria-label={`拾取${component.name}`}
                        className="absolute bottom-1 right-1 grid h-6 w-6 place-items-center rounded border border-[var(--line-subtle)] bg-[var(--paper-elevated)] text-[var(--ink-subtle)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed"
                      >
                        <Crosshair className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })(),
            )}
          </div>
        )}
      </div>
    </section>
  );
}
