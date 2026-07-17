import {
  Check,
  CircleDot,
  GitBranch,
  Globe2,
  Layers3,
  LocateFixed,
  Map as MapIcon,
  Minus,
  Mountain,
  Network,
  Plus,
  Route,
  Sparkles,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

type WorldMode = "continent" | "planet" | "multiverse" | "parallel";

const WORLD_MODES: readonly {
  readonly id: WorldMode;
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  { id: "continent", label: "大陆", icon: MapIcon },
  { id: "planet", label: "星球", icon: Globe2 },
  { id: "multiverse", label: "多元宇宙", icon: Network },
  { id: "parallel", label: "平行宇宙", icon: GitBranch },
] as const;

const LAYER_OPTIONS = [
  { id: "terrain", label: "地形", detail: "山脉、高原与盆地" },
  { id: "water", label: "水系", detail: "河流、湖泊与海域" },
  { id: "settlements", label: "聚落", detail: "城市、关隘与港口" },
  { id: "routes", label: "交通", detail: "驿道、航线与传送网络" },
] as const;

const MAP_TITLES: Readonly<Record<WorldMode, string>> = {
  continent: "九州大陆地理图",
  planet: "苍衡星球投影",
  multiverse: "多元宇宙拓扑",
  parallel: "景曜分歧时间线",
};

function ContinentMap({
  layers,
}: {
  layers: Readonly<Record<string, boolean>>;
}) {
  return (
    <svg
      viewBox="0 0 900 600"
      className="h-full w-full"
      role="img"
      aria-label="九州大陆地理图"
    >
      <rect width="900" height="600" fill="var(--paper-inset)" />
      <path
        d="M90 160C152 65 270 54 352 100C425 51 561 72 626 135C729 130 807 219 769 293C814 378 739 470 636 458C567 528 425 511 367 467C269 514 150 458 153 375C61 328 34 229 90 160Z"
        fill="var(--paper-elevated)"
        stroke="var(--line-strong)"
        strokeWidth="2"
      />
      <path
        d="M652 492C692 466 742 480 756 520C730 552 677 555 644 529Z"
        fill="var(--paper-elevated)"
        stroke="var(--line-strong)"
        strokeWidth="2"
      />
      {layers.terrain && (
        <g fill="none" stroke="var(--ink-subtle)" strokeWidth="4">
          <path d="M146 190L181 145L212 184L248 132L284 181L319 148L356 195" />
          <path d="M544 175L580 132L615 174L650 141L692 188" />
          <path d="M468 403L502 360L538 407L575 371L620 421" />
        </g>
      )}
      {layers.water && (
        <g fill="none" stroke="var(--accent-cool)" strokeLinecap="round">
          <path
            d="M283 174C327 226 366 239 417 272C482 315 537 307 590 349C636 385 687 393 754 376"
            strokeWidth="6"
          />
          <path d="M417 272C402 334 367 364 333 411" strokeWidth="3" />
          <path d="M538 307C556 266 590 241 636 223" strokeWidth="3" />
        </g>
      )}
      {layers.routes && (
        <g
          fill="none"
          stroke="var(--accent-warm)"
          strokeDasharray="9 8"
          strokeWidth="3"
        >
          <path d="M260 249C370 197 482 219 608 278" />
          <path d="M403 319C482 360 568 384 676 431" />
        </g>
      )}
      {layers.settlements && (
        <g
          fill="var(--accent-warm)"
          stroke="var(--paper-elevated)"
          strokeWidth="4"
        >
          <circle cx="423" cy="280" r="10" />
          <circle cx="260" cy="249" r="8" />
          <circle cx="608" cy="278" r="8" />
          <circle cx="676" cy="431" r="7" />
        </g>
      )}
      <g fill="var(--ink)" fontSize="16" fontWeight="600">
        <text x="387" y="258">
          承天
        </text>
        <text x="211" y="233">
          霜港
        </text>
        <text x="625" y="265">
          云州
        </text>
        <text x="694" y="434">
          临潮
        </text>
      </g>
      <g fill="var(--ink-muted)" fontSize="14">
        <text x="170" y="112">
          北境雪岭
        </text>
        <text x="468" y="337">
          澜江
        </text>
        <text x="436" y="457">
          南岭
        </text>
      </g>
    </svg>
  );
}

function PlanetMap() {
  return (
    <svg
      viewBox="0 0 900 600"
      className="h-full w-full"
      role="img"
      aria-label="星球投影图"
    >
      <rect width="900" height="600" fill="var(--paper-inset)" />
      <circle
        cx="450"
        cy="300"
        r="230"
        fill="var(--paper-elevated)"
        stroke="var(--line-strong)"
        strokeWidth="2"
      />
      <g fill="none" stroke="var(--line)" strokeWidth="1.5">
        <ellipse cx="450" cy="300" rx="230" ry="78" />
        <ellipse cx="450" cy="300" rx="230" ry="155" />
        <ellipse cx="450" cy="300" rx="92" ry="230" />
        <ellipse cx="450" cy="300" rx="172" ry="230" />
      </g>
      <path
        d="M293 175C352 124 421 146 440 198C477 220 476 259 448 282C382 302 341 275 317 242C277 229 264 204 293 175Z"
        fill="var(--accent-cool)"
        opacity="0.72"
      />
      <path
        d="M513 289C568 241 642 260 658 316C633 343 619 381 588 419C540 443 496 400 499 351Z"
        fill="var(--accent-warm)"
        opacity="0.66"
      />
      <circle cx="408" cy="248" r="7" fill="var(--ink)" />
      <text x="428" y="242" fill="var(--ink)" fontSize="16" fontWeight="600">
        九州大陆
      </text>
      <text x="355" y="568" fill="var(--ink-muted)" fontSize="14">
        球面 · 自定义等距投影
      </text>
    </svg>
  );
}

function MultiverseMap() {
  return (
    <svg
      viewBox="0 0 900 600"
      className="h-full w-full"
      role="img"
      aria-label="多元宇宙拓扑图"
    >
      <rect width="900" height="600" fill="var(--paper-inset)" />
      <g fill="none" stroke="var(--line-strong)" strokeWidth="3">
        <path d="M450 300L230 150" />
        <path d="M450 300L690 140" />
        <path d="M450 300L210 445" />
        <path d="M450 300L680 455" />
        <path d="M230 150C366 78 547 76 690 140" strokeDasharray="10 8" />
      </g>
      <g stroke="var(--paper-elevated)" strokeWidth="7">
        <circle cx="450" cy="300" r="52" fill="var(--accent-warm)" />
        <circle cx="230" cy="150" r="37" fill="var(--accent-cool)" />
        <circle cx="690" cy="140" r="37" fill="var(--warning)" />
        <circle cx="210" cy="445" r="37" fill="var(--ink-subtle)" />
        <circle cx="680" cy="455" r="37" fill="var(--success)" />
      </g>
      <g fill="var(--ink)" fontSize="16" fontWeight="600" textAnchor="middle">
        <text x="450" y="380">
          主宇宙
        </text>
        <text x="230" y="92">
          镜海界
        </text>
        <text x="690" y="82">
          无昼界
        </text>
        <text x="210" y="520">
          旧纪元残界
        </text>
        <text x="680" y="530">
          灵域
        </text>
      </g>
      <text x="28" y="42" fill="var(--ink-muted)" fontSize="14">
        拓扑距离 · 非物理比例
      </text>
    </svg>
  );
}

function ParallelUniverseMap() {
  return (
    <svg
      viewBox="0 0 900 600"
      className="h-full w-full"
      role="img"
      aria-label="平行宇宙分支图"
    >
      <rect width="900" height="600" fill="var(--paper-inset)" />
      <g fill="none" strokeWidth="6" strokeLinecap="round">
        <path d="M85 300H340" stroke="var(--ink-muted)" />
        <path
          d="M340 300C430 300 420 145 525 145H815"
          stroke="var(--accent-cool)"
        />
        <path d="M340 300H815" stroke="var(--accent-warm)" />
        <path
          d="M340 300C430 300 420 455 525 455H815"
          stroke="var(--warning)"
        />
      </g>
      <g fill="var(--paper-elevated)" strokeWidth="5">
        <circle cx="340" cy="300" r="17" stroke="var(--ink)" />
        <circle cx="610" cy="145" r="13" stroke="var(--accent-cool)" />
        <circle cx="610" cy="300" r="13" stroke="var(--accent-warm)" />
        <circle cx="610" cy="455" r="13" stroke="var(--warning)" />
      </g>
      <g fill="var(--ink)" fontSize="16" fontWeight="600">
        <text x="247" y="270">
          景曜三十七年
        </text>
        <text x="636" y="132">
          灵脉未逆流
        </text>
        <text x="636" y="287">
          主时间线
        </text>
        <text x="636" y="442">
          北境独立
        </text>
      </g>
      <text x="85" y="342" fill="var(--ink-muted)" fontSize="14">
        共同历史
      </text>
    </svg>
  );
}

function MapVisual({
  mode,
  layers,
}: {
  mode: WorldMode;
  layers: Readonly<Record<string, boolean>>;
}) {
  if (mode === "planet") return <PlanetMap />;
  if (mode === "multiverse") return <MultiverseMap />;
  if (mode === "parallel") return <ParallelUniverseMap />;
  return <ContinentMap layers={layers} />;
}

export default function WorldMapPrototype() {
  const [worldMode, setWorldMode] = useState<WorldMode>("continent");
  const [isGenerated, setIsGenerated] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [layers, setLayers] = useState<Record<string, boolean>>({
    terrain: true,
    water: true,
    settlements: true,
    routes: true,
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--line-subtle)] px-5 py-2 max-md:flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MapIcon className="h-4 w-4 text-[var(--accent-warm)]" />
            <h1 className="text-base font-semibold text-[var(--ink)]">
              世界地图
            </h1>
          </div>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
            独立空间模型 · 草案 04
          </p>
        </div>

        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex shrink-0 rounded-md bg-[var(--paper-inset)] p-0.5"
            aria-label="世界结构"
          >
            {WORLD_MODES.map((mode) => {
              const Icon = mode.icon;
              const active = worldMode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setWorldMode(mode.id);
                    setIsGenerated(false);
                  }}
                  className={`flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors ${
                    active
                      ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs"
                      : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="max-lg:hidden">{mode.label}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setIsGenerated(true)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
          >
            {isGenerated ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {isGenerated ? "地图已更新" : "Agent 生成地图"}
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)_18rem] max-xl:grid-cols-[13rem_minmax(0,1fr)_16rem] max-lg:grid-cols-[13rem_minmax(0,1fr)] max-md:block max-md:overflow-y-auto">
        <aside className="min-h-0 overflow-y-auto border-r border-[var(--line-subtle)] bg-[var(--paper-elevated)]/45 max-md:border-r-0 max-md:border-b">
          <div className="flex h-11 items-center gap-2 border-b border-[var(--line-subtle)] px-4">
            <Layers3 className="h-4 w-4 text-[var(--accent-cool)]" />
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              地图图层
            </h2>
          </div>
          <div className="divide-y divide-[var(--line-subtle)] px-3">
            {LAYER_OPTIONS.map((layer) => (
              <label
                key={layer.id}
                className="flex cursor-pointer items-start gap-3 px-1 py-3"
              >
                <input
                  type="checkbox"
                  checked={layers[layer.id]}
                  onChange={(event) =>
                    setLayers((current) => ({
                      ...current,
                      [layer.id]: event.target.checked,
                    }))
                  }
                  className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent-warm)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--ink)]">
                    {layer.label}
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-[var(--ink-muted)]">
                    {layer.detail}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="border-t border-[var(--line-subtle)] px-4 py-4">
            <h3 className="text-xs font-semibold text-[var(--ink-muted)]">
              地图参数
            </h3>
            <dl className="mt-3 space-y-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--ink-muted)]">时间切片</dt>
                <dd className="font-medium text-[var(--ink)]">景曜 347 年</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--ink-muted)]">比例</dt>
                <dd className="font-medium text-[var(--ink)]">1 : 8,000,000</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--ink-muted)]">坐标</dt>
                <dd className="font-medium text-[var(--ink)]">相对坐标</dd>
              </div>
            </dl>
          </div>
        </aside>

        <main className="relative min-h-0 overflow-hidden bg-[var(--paper-inset)] max-md:h-[34rem]">
          <div className="pointer-events-none absolute left-5 top-4 z-10">
            <div className="flex items-center gap-2">
              <CircleDot className="h-4 w-4 text-[var(--accent-warm)]" />
              <h2 className="text-sm font-semibold text-[var(--ink)]">
                {MAP_TITLES[worldMode]}
              </h2>
            </div>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              空间实体 48 个 · 关系边 76 条
            </p>
          </div>
          <div
            className="h-full w-full transition-transform duration-200"
            style={{ transform: `scale(${zoom / 100})` }}
          >
            <MapVisual mode={worldMode} layers={layers} />
          </div>
          <div className="absolute bottom-4 right-4 z-10 flex items-center rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] shadow-sm">
            <button
              type="button"
              onClick={() => setZoom((value) => Math.max(80, value - 10))}
              className="flex h-8 w-8 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              aria-label="缩小地图"
              title="缩小地图"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-12 text-center text-xs text-[var(--ink-muted)]">
              {zoom}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((value) => Math.min(130, value + 10))}
              className="flex h-8 w-8 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              aria-label="放大地图"
              title="放大地图"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(100)}
              className="flex h-8 w-8 items-center justify-center border-l border-[var(--line)] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              aria-label="复位地图"
              title="复位地图"
            >
              <LocateFixed className="h-3.5 w-3.5" />
            </button>
          </div>
        </main>

        <aside className="min-h-0 overflow-y-auto border-l border-[var(--line-subtle)] bg-[var(--paper-elevated)]/45 max-lg:hidden">
          <div className="flex h-11 items-center justify-between border-b border-[var(--line-subtle)] px-4">
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              生成约束
            </h2>
            <span className="text-xs font-medium text-[var(--success)]">
              就绪度 78%
            </span>
          </div>
          <div className="px-4 py-4">
            <h3 className="text-xs font-semibold text-[var(--ink-muted)]">
              空间基线
            </h3>
            <div className="mt-3 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[var(--ink-muted)]">世界根空间</span>
                <span className="font-medium text-[var(--ink)]">九州大陆</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[var(--ink-muted)]">结构模型</span>
                <span className="font-medium text-[var(--ink)]">
                  {WORLD_MODES.find((mode) => mode.id === worldMode)?.label}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[var(--ink-muted)]">实体关系</span>
                <span className="font-medium text-[var(--ink)]">
                  48 / 76 边
                </span>
              </div>
            </div>
          </div>
          <div className="border-t border-[var(--line-subtle)] px-4 py-4">
            <div className="flex items-center justify-between text-xs">
              <h3 className="font-semibold text-[var(--ink-muted)]">
                约束检查
              </h3>
              <span className="font-medium text-[var(--warning)]">
                2 项待确认
              </span>
            </div>
            <div className="mt-3 space-y-3 text-xs">
              <div className="flex items-center gap-2 text-[var(--ink)]">
                <Route className="h-3.5 w-3.5 text-[var(--warning)]" />
                北境疆界与南溟航线相交
              </div>
              <div className="flex items-center gap-2 text-[var(--ink)]">
                <Waves className="h-3.5 w-3.5 text-[var(--success)]" />
                水系连通检查通过
              </div>
              <div className="flex items-center gap-2 text-[var(--ink)]">
                <Mountain className="h-3.5 w-3.5 text-[var(--success)]" />
                地形闭合检查通过
              </div>
            </div>
          </div>
          <div className="border-t border-[var(--line-subtle)] px-4 py-4">
            <p className="text-xs leading-5 text-[var(--ink-muted)]">
              地图只读取空间 Entity、Relation、ScopeSet 和时间有效性。Markdown
              仅作为引用来源，不直接充当地图事实。
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
