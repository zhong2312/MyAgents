import {
  getMapComponentTerrainPreviewShapes,
  MAP_COMPONENT_PRESETS,
  type MapComponentPreset,
} from "./mapComponents";
import type {
  MapArtwork,
  MapArtworkLayer,
  MapArtworkLayerKind,
  MapArtworkProjectAsset,
  MapArtworkStamp,
} from "../entities/mapSchema";

export type MapArtworkStampAsset = {
  readonly id: string;
  /** 内置构件有完整的业务预设；项目素材只有通用素材描述。 */
  readonly component?: MapComponentPreset;
  readonly name: string;
  readonly symbol: string;
  readonly color: string;
  /** 画布中的真实素材图像。使用内置 SVG，避免依赖外部网络资源。 */
  readonly imageSrc: string;
  /** 素材的原始尺寸，用于保持不同素材的视觉比例。 */
  readonly width: number;
  readonly height: number;
  /** 同一素材的手绘轮廓变体；首个变体同时作为兼容预览图。 */
  readonly variants: readonly MapArtworkAssetVariant[];
  /** 支持连续刷出的成组素材，供后续笔刷工具复用。 */
  readonly brush: boolean;
  /** 横向素材沿笔势定向；树木等有上下朝向的素材始终保持竖直。 */
  readonly brushFollowsPath: boolean;
};

export type MapArtworkAssetVariant = {
  readonly index: number;
  readonly imageSrc: string;
  readonly width: number;
  readonly height: number;
  readonly cacheKey: string;
};

/** 同一份项目地图中的素材解析器，供场景交互画布和导出器共同使用。 */
export interface MapArtworkAssetCatalog {
  get(assetId: string): MapArtworkStampAsset | undefined;
}

const FALLBACK_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  continent: "◒",
  archipelago: "⌁",
  rift: "╱",
  "mountain-range": "▲",
  "snow-peak": "△",
  foothills: "⌒",
  mesa: "▱",
  "boulder-field": "●",
  volcano: "△",
  canyon: "⌁",
  forest: "♣",
  "broadleaf-grove": "♣",
  "pine-grove": "♠",
  "bamboo-grove": "♧",
  deadwood: "♧",
  jungle: "♣",
  wetland: "∿",
  grassland: "·",
  shrubland: "♣",
  river: "〰",
  lake: "◌",
  waterfall: "≋",
  "seaweed-bed": "♧",
  "sea-foam": "≋",
  "ocean-current": "〰",
  city: "●",
  "town-district": "▦",
  "fishing-village": "⚓",
  lighthouse: "⚑",
  graveyard: "†",
  battlefield: "⚔",
  village: "•",
  port: "⚓",
  watchtower: "▥",
  bridge: "⌒",
  capital: "◆",
  fortress: "▣",
  terraces: "▤",
  road: "╌",
  wall: "▥",
  border: "┄",
  "faction-seat": "◆",
  "secret-realm": "◇",
  ruins: "▤",
  portal: "◇",
  temple: "⌂",
  resource: "✧",
  cave: "◓",
  obelisk: "▴",
});

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const TINTED_ARTWORK_VARIANT_CACHE = new Map<string, MapArtworkAssetVariant>();

type SvgAssetOptions = {
  readonly fill: string;
  readonly stroke?: string;
  readonly background?: string;
};

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

type ArtworkShape = {
  readonly width: number;
  readonly height: number;
  readonly body: string;
};

/**
 * 新增构件必须仍然有可识别的成品预览。这里集中维护扩展目录的基础
 * 轮廓，避免未加入主 switch 时悄悄退化成一个无法表达语义的圆形。
 * 颜色、阴影和稳定变体由 createArtworkSvg 统一处理。
 */
function createExtendedArtworkShape(
  id: string,
  fill: string,
  stroke: string,
  common: string,
  variant: number,
): ArtworkShape {
  const v = variant % 3;
  const terrainPreview = getMapComponentTerrainPreviewShapes(id);
  if (terrainPreview.length > 0) {
    const path = terrainPreview
      .filter((points) => points.length >= 3)
      .map((points) => {
        const [first, ...rest] = points;
        const project = ([x, y]: readonly [number, number]) =>
          `${Math.round(90 + x * 150)} ${Math.round(64 + y * 102)}`;
        return `M${project(first!)}${rest.map((point) => `L${project(point)}`).join("")}Z`;
      })
      .join(" ");
    if (path) {
      return {
        width: 180,
        height: 128,
        body: `<path d="${path}" ${common}/><path d="${path}" fill="none" stroke="#fff7df66" stroke-width="2.5" stroke-linejoin="round"/>`,
      };
    }
  }

  if (id === "isolated-peak" || id === "rock-pillar") {
    return {
      width: 150,
      height: 132,
      body:
        id === "isolated-peak"
          ? [
              `<path d="M10 115 54 28l17 24 20-35 49 98Z" ${common}/><path d="m71 52 11 28-11-9-10 10Z" fill="#f7f0dd" stroke="none"/><path d="M27 111 55 62l16 21 19-32 27 55" fill="none" stroke="#594a3d" stroke-width="3" opacity=".6"/>`,
              `<path d="M9 115 43 43l22-31 22 42 18-24 36 85Z" ${common}/><path d="m65 12 13 38-13-10-12 12Z" fill="#f7f0dd" stroke="none"/><path d="M23 111 47 67l18 23 18-31 27 52" fill="none" stroke="#594a3d" stroke-width="3" opacity=".6"/>`,
              `<path d="M11 115 38 54l25-42 22 50 18-29 37 82Z" ${common}/><path d="m63 12 14 42-14-11-12 14Z" fill="#f7f0dd" stroke="none"/><path d="M24 111 44 73l20 20 17-34 29 52" fill="none" stroke="#594a3d" stroke-width="3" opacity=".6"/>`,
            ][v]!
          : [
              `<path d="M20 113 27 47l18-18 10 24 15-40 18 42 19-18 13 76Z" ${common}/><path d="M27 47 25 109M70 13l-1 96M107 37l-4 72" fill="none" stroke="#e7c69e" stroke-width="4" opacity=".6"/>`,
              `<path d="M18 113 25 58l18-27 13 23 17-43 17 49 20-23 15 76Z" ${common}/><path d="M25 58 23 109M73 11l-1 98M110 38l-4 71" fill="none" stroke="#e7c69e" stroke-width="4" opacity=".6"/>`,
              `<path d="M19 113 29 52l17-22 11 28 16-44 20 46 18-19 13 72Z" ${common}/><path d="M29 52 27 109M73 14l-1 95M111 39l-4 70" fill="none" stroke="#e7c69e" stroke-width="4" opacity=".6"/>`,
            ][v]!,
    };
  }

  if (id === "volcanic-crater") {
    return {
      width: 158,
      height: 126,
      body: [
        `<path d="M12 108 37 52l28-20 29 17 43 59Z" ${common}/><ellipse cx="82" cy="62" rx="29" ry="13" fill="${fill}" stroke="${stroke}" stroke-width="4"/><ellipse cx="82" cy="62" rx="14" ry="6" fill="#3f2827" stroke="#ed8954" stroke-width="3"/><path d="M82 52V30M70 48 59 29M94 48l13-19" fill="none" stroke="#ed8954" stroke-width="4" stroke-linecap="round"/>`,
        `<path d="M11 109 33 58l33-25 29 20 42 56Z" ${common}/><ellipse cx="80" cy="64" rx="31" ry="13" fill="${fill}" stroke="${stroke}" stroke-width="4"/><ellipse cx="80" cy="64" rx="15" ry="6" fill="#3f2827" stroke="#ed8954" stroke-width="3"/><path d="M80 54V31M68 50 55 30M93 50l14-18" fill="none" stroke="#ed8954" stroke-width="4" stroke-linecap="round"/>`,
        `<path d="M13 109 39 50l28-21 28 22 41 58Z" ${common}/><ellipse cx="84" cy="61" rx="28" ry="12" fill="${fill}" stroke="${stroke}" stroke-width="4"/><ellipse cx="84" cy="61" rx="13" ry="6" fill="#3f2827" stroke="#ed8954" stroke-width="3"/><path d="M84 50V27M72 47 61 27M96 47l13-18" fill="none" stroke="#ed8954" stroke-width="4" stroke-linecap="round"/>`,
      ][v]!,
    };
  }

  if (id === "karst-peaks") {
    return {
      width: 184,
      height: 124,
      body: `<path d="M9 110 31 64l18 21 25-62 25 55 20-37 48 69Z" ${common}/><path d="M31 64 25 106M74 23l-2 83M119 41l-3 65" fill="none" stroke="#dfe6c3" stroke-width="5" opacity=".7"/>`,
    };
  }

  if (id === "stone-pile" || id === "ore-vein") {
    return {
      width: 164,
      height: 118,
      body:
        id === "stone-pile"
          ? `<path d="M14 104 34 74l22 9 16-30 24 18 21-23 34 56Z" ${common}/><path d="m34 74 8 30m30-51 9 51m21-55 10 55" fill="none" stroke="#e0c9a0" stroke-width="5" opacity=".65"/>`
          : `<path d="M12 108 32 76l24 13 25-55 25 29 22-44 26 89Z" ${common}/><path d="m32 76 14 31m35-73 9 73m22-88 13 88" fill="none" stroke="#d5f0f0" stroke-width="5" opacity=".72"/>`,
    };
  }

  if (
    id === "mushroom-grove" ||
    id === "tundra-vegetation" ||
    id === "cactus"
  ) {
    return {
      width: 172,
      height: 128,
      body:
        id === "mushroom-grove"
          ? `<path d="M20 110V80m0 30V77m42 33V68m0 42V65m49 45V76m0 34V73" stroke="${stroke}" stroke-width="8" stroke-linecap="round"/><path d="M3 79c2-23 30-29 40-11 8-22 43-17 45 8 11-21 45-13 49 12Z" ${common}/><path d="M12 109h143" stroke="#66513d" stroke-width="6"/>`
          : id === "tundra-vegetation"
            ? `<path d="M10 108c12-25 29-27 42-3 16-37 33-35 47-4 17-28 35-23 62 7Z" ${common}/><path d="M32 104 42 70m18 36 5-45m20 44 13-34m18 34 3-26" stroke="#d8e5ce" stroke-width="4" stroke-linecap="round" opacity=".7"/>`
            : `<path d="M18 110V48m0 18 19-14M18 78 5 65M70 110V32m0 25 20-17M70 75 51 60M122 110V52m0 22 20-15M122 88l-15-14" fill="none" stroke="${stroke}" stroke-width="13" stroke-linecap="round"/><path d="M18 110V48m0 18 19-14M18 78 5 65M70 110V32m0 25 20-17M70 75 51 60M122 110V52m0 22 20-15M122 88l-15-14" fill="none" stroke="${fill}" stroke-width="5" stroke-linecap="round"/>`,
    };
  }

  if (id === "sea-grass") {
    return {
      width: 174,
      height: 120,
      body: `<path d="M12 108c26-16 48 5 72-3 27-9 48 8 78 0" fill="none" stroke="#4d7978" stroke-width="7"/><path d="M28 103c-5-27 7-43 6-64m15 62c2-24 13-39 21-57m15 60c-4-29 4-46 12-67m13 66c2-23 14-38 27-52m9 51c-1-19 8-30 18-44" fill="none" stroke="${fill}" stroke-width="7" stroke-linecap="round"/>`,
    };
  }

  if (id === "ice-sheet" || id === "shoal") {
    return {
      width: 178,
      height: 122,
      body:
        id === "ice-sheet"
          ? `<path d="M10 39 42 15l37 12 36-18 53 31-16 58-51 10-40-18-42 8Z" ${common}/><path d="m43 26 17 30-21 28m42-57 7 39 28 31m-7-72 17 26-22 20" fill="none" stroke="#f1ffff" stroke-width="5" opacity=".8"/>`
          : `<path d="M10 73c24-30 45-21 67-38 24-18 43 1 57 10 17 11 27 6 37 28-18 31-42 37-69 29-26 9-63 0-92-29Z" ${common}/><path d="M22 70c24-10 41-9 59-1m16-1c20-8 37-8 59 2" fill="none" stroke="#e8f6e7" stroke-width="5" opacity=".7"/>`,
    };
  }

  const pathIds = new Set([
    "riverbank",
    "tributary",
    "fjord",
    "bay",
    "undercurrent",
    "sea-ice",
    "paved-road",
    "dirt-road",
    "forest-trail",
    "trade-route",
    "mountain-pass",
    "boardwalk",
    "canal",
    "railway",
    "magic-rail",
    "national-border",
    "boundary-line",
    "ley-line",
    "sea-route",
    "stellar-route",
    "contour-line",
    "bathymetric-line",
    "fog-wall",
    "barrier",
  ]);
  if (pathIds.has(id)) {
    const path =
      v === 0
        ? "M12 86C39 21 64 106 92 48S139 18 170 82"
        : v === 1
          ? "M10 68C41 112 59 19 91 69S137 98 172 35"
          : "M12 94C38 44 61 113 94 57S139 26 170 76";
    const isDashed = [
      "national-border",
      "boundary-line",
      "contour-line",
      "bathymetric-line",
      "forest-trail",
    ].includes(id);
    return {
      width: 182,
      height: 112,
      body: `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round" opacity=".88"/><path d="${path}" fill="none" stroke="${fill}" stroke-width="${id === "fog-wall" ? 8 : 5}" stroke-linecap="round"${isDashed ? ' stroke-dasharray="12 8"' : ""}/>${id === "railway" || id === "magic-rail" ? `<path d="${path}" fill="none" stroke="#f5e8bc" stroke-width="2" stroke-dasharray="2 13"/>` : ""}`,
    };
  }

  if (id === "whirlpool") {
    return {
      width: 144,
      height: 120,
      body: `<path d="M18 62c0-27 35-43 59-26 21 15 12 47-13 49-24 2-35-25-16-39 15-11 31 4 25 17-4 9-16 8-19 0" fill="none" stroke="${stroke}" stroke-width="9" stroke-linecap="round"/><path d="M18 62c0-27 35-43 59-26 21 15 12 47-13 49" fill="none" stroke="${fill}" stroke-width="4" stroke-linecap="round"/>`,
    };
  }

  if (id === "town") {
    return {
      width: 178,
      height: 126,
      body: [
        `<path d="M9 108V71l23-18 22 18v37ZM48 108V47l25-22 25 22v61ZM92 108V62l23-18 23 18v46Z" ${common}/><path d="M19 83h25m15-22h28m15 20h22M8 108h137" fill="none" stroke="#f7e6bd" stroke-width="4"/>`,
        `<path d="M10 108V61l26-20 26 20v47ZM57 108V73l21-17 22 17v35ZM94 108V45l24-19 24 19v63Z" ${common}/><path d="M21 75h30m16 24h20m17-45h29m-90 54h113" fill="none" stroke="#f7e6bd" stroke-width="4"/>`,
        `<path d="M8 108V76l20-16 21 16v32ZM42 108V51l28-23 28 23v57ZM94 108V68l24-20 24 20v40Z" ${common}/><path d="M17 87h23m17-24h38m14 20h29M7 108h137" fill="none" stroke="#f7e6bd" stroke-width="4"/>`,
      ][v]!,
    };
  }

  if (id === "town-district") {
    return {
      width: 180,
      height: 124,
      body: `<path d="M12 20h156v86H12Z" ${common}/><path d="M12 49h156M12 78h156M51 20v86M91 20v86M130 20v86" fill="none" stroke="#f4dfb1" stroke-width="4" opacity=".85"/><path d="M23 31h16m23 0h16m23 0h16m23 0h16M22 60h17m23 0h16m23 0h16m23 0h16M22 89h18m22 0h17m22 0h17m22 0h17" stroke="${stroke}" stroke-width="5" stroke-linecap="round"/>`,
    };
  }

  if (id === "fishing-village") {
    return {
      width: 176,
      height: 126,
      body: `<path d="M11 102c29-12 49 10 76 0 28-11 47 10 78 0" fill="none" stroke="#6b9dad" stroke-width="7"/><path d="M24 95V66l22-18 22 18v29ZM73 95V57l25-20 25 20v38Z" ${common}/><path d="M36 75h20m28-2h27M40 49l8-19m60 27 15-18M21 110h138" fill="none" stroke="#f3e0bd" stroke-width="4"/>`,
    };
  }

  if (id === "lighthouse") {
    return {
      width: 138,
      height: 140,
      body: `<path d="M48 122 55 49h28l7 73Z" ${common}/><path d="M48 49h42L82 30H56Z" ${common}/><path d="M44 122h50M58 30V18h22v12" fill="none" stroke="${stroke}" stroke-width="6"/><path d="M56 44 12 31M84 44l42-13" stroke="#f4dc91" stroke-width="5" stroke-linecap="round" opacity=".8"/><path d="M67 66v32" stroke="#f7e9c7" stroke-width="5"/>`,
    };
  }

  if (id === "graveyard") {
    return {
      width: 166,
      height: 124,
      body: `<path d="M10 106h146" stroke="${stroke}" stroke-width="7"/><path d="M24 103V72c0-12 18-12 18 0v31M63 103V61c0-12 18-12 18 0v42M104 103V75c0-12 18-12 18 0v28" ${common}/><path d="M33 78v18m-9-9h18m48-19v19m-9-10h18m31 5v17m-8-8h16" stroke="#f4e3bd" stroke-width="4" stroke-linecap="round"/>`,
    };
  }

  if (id === "battlefield") {
    return {
      width: 164,
      height: 128,
      body: `<path d="M14 105c31-20 61 11 89-5 19-11 31 1 48 5" fill="none" stroke="${stroke}" stroke-width="7"/><path d="m42 97 52-62m-35 5 53 56M76 25v72M50 42l24 16m24-15L76 58" stroke="${fill}" stroke-width="8" stroke-linecap="round"/><path d="M31 28v58m-13-45h26M120 34v53m-13-40h26" stroke="#d8b66d" stroke-width="5"/>`,
    };
  }

  if (id === "farmstead") {
    return {
      width: 170,
      height: 124,
      body: `<path d="M13 106h144M29 106V63l39-28 39 28v43Z" ${common}/><path d="M68 35v71M29 63h78M49 82h38v24H49Z" fill="none" stroke="#f2dfb6" stroke-width="5"/><path d="M119 106V74l18-14 18 14v32M129 83h16" ${common}/>`,
    };
  }

  if (id === "ruin-cluster") {
    return {
      width: 174,
      height: 126,
      body: `<path d="M14 106h146M28 106V54l18-18 17 18v52M72 106V70l19-22 18 22v36M116 106V45l18-20 17 20v61" fill="none" stroke="${stroke}" stroke-width="10"/><path d="M29 55h33m12 16h34m12-26h32" stroke="${fill}" stroke-width="5"/><path d="M19 97c25-12 43 10 67 0 25-11 43 10 69 0" fill="none" stroke="#c8a978" stroke-width="4"/>`,
    };
  }

  const settlementIds = new Set([
    "town",
    "town-district",
    "fishing-village",
    "lighthouse",
    "graveyard",
    "battlefield",
    "farmstead",
    "ruin-cluster",
    "dragonbone-range",
    "world-tree-roots",
    "floating-rocks",
    "magic-storm",
    "forbidden-zone",
    "dungeon-entrance",
    "spirit-spring",
    "beast-nest",
    "star-cluster",
    "star-gate",
    "wormhole",
    "compass",
    "scale-bar",
    "mountain-banner",
    "danger-waters",
  ]);
  if (settlementIds.has(id)) {
    if (id === "star-cluster") {
      return {
        width: 164,
        height: 124,
        body: `<g fill="${fill}" stroke="${stroke}" stroke-width="3"><circle cx="37" cy="46" r="13"/><circle cx="78" cy="30" r="9"/><circle cx="116" cy="56" r="16"/><circle cx="68" cy="84" r="12"/><circle cx="137" cy="94" r="8"/></g><path d="m37 19 4 14m-11-7 14 5m34-18 3 10m35 22 5 16m-53 24 3 13" stroke="#fff2ba" stroke-width="3" stroke-linecap="round"/>`,
      };
    }
    if (id === "wormhole") {
      return {
        width: 144,
        height: 128,
        body: `<ellipse cx="72" cy="64" rx="50" ry="28" fill="none" stroke="${stroke}" stroke-width="13"/><ellipse cx="72" cy="64" rx="34" ry="18" fill="none" stroke="${fill}" stroke-width="7"/><path d="M31 44c21 14 61 19 83 4M30 84c22-13 62-18 85-4" fill="none" stroke="#f2dcff" stroke-width="4" opacity=".8"/>`,
      };
    }
    if (id === "star-gate") {
      return {
        width: 148,
        height: 136,
        body: `<ellipse cx="74" cy="68" rx="48" ry="55" fill="none" stroke="${stroke}" stroke-width="10"/><ellipse cx="74" cy="68" rx="26" ry="37" fill="${fill}" stroke="${stroke}" stroke-width="4"/><path d="m74 15 5 30 28 23-28 4-5 31-6-31-28-4 28-23Z" fill="#fff2ba" opacity=".72"/>`,
      };
    }
    if (id === "compass") {
      return {
        width: 132,
        height: 132,
        body: `<circle cx="66" cy="66" r="50" ${common}/><path d="m66 23 10 43-10 43-10-43Z" fill="#f6e4ae" stroke="${stroke}" stroke-width="3"/><path d="m23 66 43-10 43 10-43 10Z" fill="none" stroke="${stroke}" stroke-width="3"/><text x="66" y="18" text-anchor="middle" fill="${stroke}" font-size="14" font-weight="700">N</text>`,
      };
    }
    if (id === "scale-bar") {
      return {
        width: 178,
        height: 94,
        body: `<path d="M15 60h148M15 54v12m37-12v12m37-12v12m37-12v12m37-12v12" stroke="${stroke}" stroke-width="5"/><path d="M15 60h37v-12H15Zm74 0h37V48H89Z" fill="${fill}" opacity=".8"/><text x="15" y="82" fill="${stroke}" font-size="12">0</text><text x="87" y="82" fill="${stroke}" font-size="12">50</text><text x="150" y="82" fill="${stroke}" font-size="12">100</text>`,
      };
    }
    if (id === "mountain-banner") {
      return {
        width: 184,
        height: 112,
        body: `<path d="M14 34h156l-12 34H26Z" ${common}/><path d="M34 35v34m116-34v34" stroke="${stroke}" stroke-width="4"/><path d="M48 54h88" stroke="#f8edca" stroke-width="4" opacity=".75"/>`,
      };
    }
    if (id === "danger-waters") {
      return {
        width: 140,
        height: 128,
        body: `<path d="m70 12 54 96H16Z" ${common}/><path d="M70 43v34M70 91v4" stroke="#fff1c2" stroke-width="8" stroke-linecap="round"/>`,
      };
    }
    if (id === "floating-rocks") {
      return {
        width: 164,
        height: 134,
        body: `<path d="M24 50 46 27l28 7 12 25-24 20-30-8Z M100 31l19-18 25 11 3 25-24 14-22-13Z M72 94l23-19 26 12-5 27-31 8Z" ${common}/><path d="M49 83v25m68-54 2 18m-27 31 3 17" stroke="#f1e0b8" stroke-width="4" opacity=".7"/>`,
      };
    }
    if (id === "world-tree-roots" || id === "dragonbone-range") {
      return {
        width: 190,
        height: 124,
        body:
          id === "world-tree-roots"
            ? `<path d="M94 112C86 86 74 80 44 73 25 68 18 56 13 35M92 110c9-28 22-36 49-41 18-4 29-16 35-34M87 112C71 95 57 92 35 91" fill="none" stroke="${stroke}" stroke-width="17" stroke-linecap="round"/><path d="M94 112C86 86 74 80 44 73 25 68 18 56 13 35M92 110c9-28 22-36 49-41 18-4 29-16 35-34M87 112C71 95 57 92 35 91" fill="none" stroke="${fill}" stroke-width="8" stroke-linecap="round"/>`
            : `<path d="M12 81 35 45l19 19 22-43 21 39 27-20 18 26 23-21 18 42Z" ${common}/><path d="m35 45 12 48m29-72 13 73m27-53 11 53m25-47 10 45" stroke="#e6d6bd" stroke-width="4" opacity=".72"/>`,
      };
    }
    if (id === "magic-storm") {
      return {
        width: 168,
        height: 132,
        body: `<path d="M31 74c-15-27 20-49 42-30 18-28 66-10 59 23 24 10 11 46-18 44-19 24-55 10-57-11-22 3-36-10-26-26Z" ${common}/><path d="m83 39-18 34h18l-12 28 34-43H87Z" fill="#f4ddff" stroke="${stroke}" stroke-width="3"/>`,
      };
    }
    if (id === "forbidden-zone") {
      return {
        width: 148,
        height: 128,
        body: `<path d="M74 12 131 42v47l-57 29-57-29V42Z" ${common}/><path d="M44 42 104 91M104 42 44 91" stroke="#f0c4bd" stroke-width="7" opacity=".75"/>`,
      };
    }
    if (id === "dungeon-entrance") {
      return {
        width: 144,
        height: 132,
        body: `<path d="M16 115 28 57l46-40 46 40 12 58Z" ${common}/><path d="M44 115V84c0-35 60-35 60 0v31Z" fill="#292824" stroke="${stroke}" stroke-width="5"/><path d="M57 79c11-13 25-13 36 0" fill="none" stroke="#c6b28f" stroke-width="4"/>`,
      };
    }
    if (id === "spirit-spring") {
      return {
        width: 146,
        height: 126,
        body: `<ellipse cx="73" cy="82" rx="49" ry="25" ${common}/><path d="M73 85V22m0 0-18 25m18-25 19 25M51 81c10-8 35-8 45 0" fill="none" stroke="#e6ffff" stroke-width="5" stroke-linecap="round"/>`,
      };
    }
    if (id === "beast-nest") {
      return {
        width: 152,
        height: 122,
        body: `<path d="M16 96c11-31 34-35 57-20 26-18 51-3 63 20-26 18-92 18-120 0Z" ${common}/><path d="M45 91c6-15 16-16 24-3m12 3c8-15 18-14 25 1" fill="none" stroke="#f0d5ad" stroke-width="5"/><path d="m53 57-13-18m53 18 14-18" stroke="${stroke}" stroke-width="6"/>`,
      };
    }
    return {
      width: 170,
      height: 120,
      body: `<path d="M13 92 30 54l30-19 32 14 35-18 30 39-17 35H28Z" ${common}/><path d="M37 85h91M52 65h60" fill="none" stroke="#f1dfba" stroke-width="4" opacity=".68"/>`,
    };
  }

  if (
    id === "territory-fill" ||
    id === "administrative-pattern" ||
    id === "civilization-domain"
  ) {
    return {
      width: 178,
      height: 122,
      body: `<path d="M12 49 40 21l38 9 31-16 56 35-13 45-47 15-41-12-40 8Z" ${common}/><path d="M28 50c34-10 55 12 102-8m-88 48c28-14 56 6 93-9" fill="none" stroke="#f2dfb6" stroke-width="4" opacity=".7"/><path d="M42 25 67 107m42-91 11 74" fill="none" stroke="${stroke}" stroke-width="2" stroke-dasharray="4 5" opacity=".55"/>`,
    };
  }

  if (id === "cloud-layer" || id === "paper-stain" || id === "chart-wind") {
    return {
      width: 180,
      height: 116,
      body:
        id === "cloud-layer"
          ? `<path d="M20 79c-12-30 26-49 52-30 14-25 56-13 59 16 32-3 42 35 14 45H38c-12 0-22-11-18-31Z" ${common}/><path d="M34 87c31 11 69 11 109 0" fill="none" stroke="#f7ffff" stroke-width="5" opacity=".75"/>`
          : id === "paper-stain"
            ? `<path d="M13 33c36-24 58 7 84-10 30-19 48 3 71 16l-11 61c-28 18-58-7-84 6-29 14-45-8-59-21Z" ${common}/><path d="M28 48c34 13 59-11 102 1m-94 25c25 9 48-4 78 4" fill="none" stroke="#f4e3b8" stroke-width="7" opacity=".35"/>`
            : `<path d="M10 80C35 34 56 101 88 47s54-15 82 25" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round"/><path d="M20 93C45 48 66 113 98 60s52-14 72 20" fill="none" stroke="${fill}" stroke-width="3" stroke-dasharray="5 6"/>`,
    };
  }

  if (id === "hillshade") {
    return {
      width: 180,
      height: 116,
      body: `<path d="M12 101 48 32l32 43 31-60 57 86Z" fill="${fill}" fill-opacity=".54" stroke="${stroke}" stroke-width="4"/><path d="M48 32 62 101m49-86 18 86" stroke="#f3e5c5" stroke-width="5" opacity=".66"/><path d="M22 101h143" stroke="${stroke}" stroke-width="5" opacity=".72"/>`,
    };
  }

  if (
    id === "scroll-frame" ||
    id === "map-frame" ||
    id === "title-cartouche" ||
    id === "region-number"
  ) {
    return {
      width: 182,
      height: 124,
      body:
        id === "region-number"
          ? `<circle cx="91" cy="62" r="39" ${common}/><text x="91" y="77" text-anchor="middle" fill="#f9edc6" font-size="42" font-weight="700">${(v + 1).toString()}</text>`
          : id === "title-cartouche"
            ? `<path d="M12 35c18-16 31 1 47-10 13-10 25 10 37 0 15-12 27 8 36 2 15-10 27 5 38 8v47c-14 5-27 18-40 6-14-13-25 7-39-3-14-10-25 9-39 0-15-10-29 5-40-7Z" ${common}/><path d="M43 60h96" stroke="#f5e5b7" stroke-width="5" opacity=".8"/>`
            : `<path d="M22 19h138v86H22Z" fill="none" stroke="${stroke}" stroke-width="8"/><path d="M32 30h118v64H32Z" fill="none" stroke="${fill}" stroke-width="4"/><path d="M22 19c-14 9-14 20 0 28m138-28c14 9 14 20 0 28m-138 58c-14-9-14-20 0-28m138 28c14-9 14-20 0-28" fill="none" stroke="${stroke}" stroke-width="5"/>`,
    };
  }

  return {
    width: 154,
    height: 116,
    body: `<path d="M11 88 32 48l35-27 38 18 37 36-21 30-53-7-42 8Z" ${common}/><path d="M33 75c24-15 48-15 84 0m-68 17c18-9 38-9 58 0" fill="none" stroke="#f4e3b8" stroke-width="4" opacity=".65"/>`,
  };
}

/**
 * 项目自有的手绘式素材。它们不是 UI 图标，而是带轮廓、层次和阴影的
 * 画布图像，作为 Wonderdraft 风格的默认素材基线；用户仍可替换为项目素材。
 */
function createArtworkSvg(
  id: string,
  options: SvgAssetOptions,
  variant = 0,
): {
  readonly src: string;
  readonly width: number;
  readonly height: number;
} {
  const fill = options.fill;
  const stroke = options.stroke ?? "#342c25";
  const background = options.background ?? "none";
  const common = `fill="url(#asset-fill)" stroke="${stroke}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"`;
  let width = 128;
  let height = 128;
  let body = "";

  switch (id) {
    case "star":
      body = `<path d="M64 8 76 47l41 1-33 24 11 40-31-23-31 23 11-40L11 48l41-1Z" ${common}/><circle cx="64" cy="64" r="13" fill="#fff6c7" stroke="none"/>`;
      break;
    case "planet":
      body = `<circle cx="64" cy="64" r="39" ${common}/><path d="M30 49c18 8 40 10 68-1M32 76c16-5 38-5 63 4" fill="none" stroke="#ffffff80" stroke-width="6"/>`;
      break;
    case "ringed-planet":
    case "ring":
      body = `<ellipse cx="64" cy="67" rx="56" ry="18" fill="none" stroke="${stroke}" stroke-width="9"/><circle cx="64" cy="61" r="30" ${common}/><ellipse cx="64" cy="67" rx="56" ry="18" fill="none" stroke="#fff4d280" stroke-width="3"/>`;
      break;
    case "moon":
      body = `<path d="M84 18c-21 8-35 26-35 47 0 21 15 39 36 45-7 4-15 6-23 6-30 0-54-24-54-54S32 8 62 8c8 0 15 2 22 5Z" ${common}/><circle cx="69" cy="58" r="5" fill="#ffffff44" stroke="none"/><circle cx="57" cy="82" r="7" fill="#ffffff44" stroke="none"/>`;
      break;
    case "nebula":
      width = 180;
      height = 132;
      body = `<path d="M20 78c-9-30 20-52 48-42 16-28 62-19 67 11 34-6 51 37 23 55-14 27-55 28-73 8-31 20-71 0-65-32Z" ${common}/><path d="M43 77c22-27 47-27 79-5" fill="none" stroke="#fff6ff80" stroke-width="8"/>`;
      break;
    case "world-gate":
      width = 144;
      height = 144;
      body = [
        `<path d="M18 118V54l16-35h76l16 35v64ZM34 54h76M47 118V62h50v56" ${common}/><ellipse cx="72" cy="89" rx="20" ry="30" fill="${fill}" stroke="${stroke}" stroke-width="4"/><path d="M58 70c11 8 20 8 29 0M57 102c10-8 20-8 30 0" fill="none" stroke="#fff2d9" stroke-width="3" opacity=".72"/>`,
        `<path d="M19 118V48l18-30h70l18 30v70ZM37 48h70M47 118V59h50v59" ${common}/><circle cx="72" cy="89" r="26" fill="${fill}" stroke="${stroke}" stroke-width="4"/><path d="m72 62 6 20 20 7-20 7-6 20-7-20-20-7 20-7Z" fill="#fff2d9" opacity=".7"/>`,
        `<path d="M16 119 30 50 50 16h44l20 34 14 69ZM30 50h84M43 119V63h58v56" ${common}/><ellipse cx="72" cy="89" rx="22" ry="31" fill="${fill}" stroke="${stroke}" stroke-width="4"/><path d="M49 89h46M72 58v62" fill="none" stroke="#fff2d9" stroke-width="3" opacity=".62"/>`,
      ][variant % 3]!;
      break;
    case "portal":
      body = `<ellipse cx="64" cy="64" rx="39" ry="52" fill="${background}" stroke="${stroke}" stroke-width="4"/><ellipse cx="64" cy="64" rx="22" ry="36" fill="${fill}" stroke="${stroke}" stroke-width="4"/><path d="M44 28 35 14M84 28l10-14M38 101l-10 14M90 101l10 14" ${common}/>`;
      break;
    case "continent":
      width = 180;
      height = 128;
      body = `<path d="M12 62 31 31l31-11 27 12 39-10 37 27-10 31-30 19-37-8-28 17-37-18Z" ${common}/><path d="M40 47c18 12 42 14 66 6M52 88c17-9 33-11 51-4" fill="none" stroke="#fff7d966" stroke-width="6"/>`;
      break;
    case "archipelago":
      width = 180;
      height = 128;
      body = `<path d="M24 45c9-20 27-20 37-6 8 12-5 23-21 22-13-1-20-5-16-16ZM82 23c10-15 28-10 29 4 0 13-12 18-24 14-9-3-11-10-5-18ZM113 68c13-17 35-9 34 8-2 17-20 22-33 13-10-7-9-14-1-21ZM44 91c9-12 26-8 28 5 1 13-11 21-23 16-10-4-12-13-5-21Z" ${common}/>`;
      break;
    case "rift":
    case "canyon":
      width = 160;
      height = 110;
      body = `<path d="M18 17 55 42l-14 25 47 18-13 19M98 12 78 42l31 19-12 28 42 12" fill="none" stroke="${stroke}" stroke-width="15"/><path d="M18 17 55 42l-14 25 47 18-13 19M98 12 78 42l31 19-12 28 42 12" fill="none" stroke="${fill}" stroke-width="7"/>`;
      break;
    case "magic-rift":
      width = 166;
      height = 114;
      body = `<path d="M16 12 52 43l-17 22 48 16-17 23M104 10 82 42l34 18-12 30 43 12" fill="none" stroke="${stroke}" stroke-width="16"/><path d="M16 12 52 43l-17 22 48 16-17 23M104 10 82 42l34 18-12 30 43 12" fill="none" stroke="${fill}" stroke-width="7"/><path d="M26 22 46 43M111 22 91 42M48 70l25 9M118 59l-7 22" fill="none" stroke="#f6dcff" stroke-width="3" opacity=".78"/>`;
      break;
    case "cliff":
      width = 190;
      height = 112;
      body = [
        `<path d="M9 108 31 27l27 27 20-36 24 32 28-25 51 83Z" ${common}/><path d="M31 27 26 102M58 54 54 106M78 18 75 106M102 50 99 106M130 25l-4 80" fill="none" stroke="#e6bd89" stroke-width="5" opacity=".65"/>`,
        `<path d="M8 108 26 43l27-25 22 34 23-38 27 37 29-21 36 78Z" ${common}/><path d="M26 43 22 104M53 18 49 105M75 52 71 106M98 14 94 106M125 51l-4 55" fill="none" stroke="#e5bb87" stroke-width="5" opacity=".65"/>`,
        `<path d="M7 108 22 56l25-35 24 41 24-27 25-18 25 38 27-23 31 76Z" ${common}/><path d="M22 56 18 104M47 21 43 105M71 62 67 106M95 35 91 106M120 17l-4 89" fill="none" stroke="#e6bd89" stroke-width="5" opacity=".65"/>`,
      ][variant % 3]!;
      break;
    case "dunes":
      width = 184;
      height = 104;
      body = [
        `<path d="M8 89c23-46 47-45 66-7 18-28 41-33 57-5 17-17 31-20 45 12v10H8Z" ${common}/><path d="M23 86c17-18 34-16 47 1M83 86c15-17 32-17 46 0M136 89c11-11 22-12 33 0" fill="none" stroke="#f5df9e" stroke-width="5" opacity=".78"/>`,
        `<path d="M8 91c19-30 38-40 58-15 16-40 47-44 69-13 16-13 31-8 41 28v8H8Z" ${common}/><path d="M20 88c15-13 29-14 42-2M72 86c19-22 40-20 56 0M139 90c10-9 20-9 31 0" fill="none" stroke="#f5df9e" stroke-width="5" opacity=".78"/>`,
        `<path d="M8 92c20-20 39-28 58-6 17-35 45-37 66-8 19-19 32-14 44 14v7H8Z" ${common}/><path d="M21 90c14-10 27-11 40-1M76 88c18-18 37-16 51 0M140 91c9-8 19-8 29 0" fill="none" stroke="#f5df9e" stroke-width="5" opacity=".78"/>`,
      ][variant % 3]!;
      break;
    case "glacier":
      width = 180;
      height = 120;
      body = [
        `<path d="M13 110 29 47l23-29 25 19 30-23 27 35 31 61Z" ${common}/><path d="M29 47 49 100M52 18l20 84M77 37l15 65M107 14l-8 88M134 49l-12 53" fill="none" stroke="#f4ffff" stroke-width="5" opacity=".78"/>`,
        `<path d="M12 110 26 58l25-36 29 17 29-26 31 38 27 59Z" ${common}/><path d="M26 58 45 102M51 22l18 80M80 39l12 63M109 13l-10 89M140 51l-10 51" fill="none" stroke="#f4ffff" stroke-width="5" opacity=".78"/>`,
        `<path d="M11 110 24 66l24-44 31 20 28-28 31 43 25 53Z" ${common}/><path d="M24 66 42 103M48 22l18 81M79 42l10 61M107 14l-9 89M138 57l-11 46" fill="none" stroke="#f4ffff" stroke-width="5" opacity=".78"/>`,
      ][variant % 3]!;
      break;
    case "rock-spires":
      width = 170;
      height = 126;
      body = [
        `<path d="M12 112 35 42l18 24L69 12l23 64 19-38 18 74Z" ${common}/><path d="M35 42v67M69 12v97M111 38v71" fill="none" stroke="#e4c69f" stroke-width="5" opacity=".68"/>`,
        `<path d="M13 112 29 59l18-30 20 46L83 8l23 69 21-42 18 77Z" ${common}/><path d="M47 29v80M83 8v101M127 35v74" fill="none" stroke="#e4c69f" stroke-width="5" opacity=".68"/>`,
        `<path d="M11 112 27 71l21-40 18 50L86 14l20 63 25-35 15 70Z" ${common}/><path d="M48 31v78M86 14v95M131 42v67" fill="none" stroke="#e4c69f" stroke-width="5" opacity=".68"/>`,
      ][variant % 3]!;
      break;
    case "boulder-field":
      width = 174;
      height = 108;
      body = [
        `<path d="M10 99 28 67l26 7 18-33 31 16 24-30 37 24v48Z" ${common}/><path d="m28 67 12 32m32-58 9 58m22-72 11 72" fill="none" stroke="#d7c39b" stroke-width="5" opacity=".62"/>`,
        `<path d="M9 99 31 54l28 16 18-29 29 17 23-24 35 23v42Z" ${common}/><path d="m31 54 15 45m31-58 9 58m20-65 13 65" fill="none" stroke="#d7c39b" stroke-width="5" opacity=".62"/>`,
        `<path d="M10 99 25 72l24 3 23-35 28 19 20-31 40 25v46Z" ${common}/><path d="m25 72 12 27m35-59 9 59m19-71 13 71" fill="none" stroke="#d7c39b" stroke-width="5" opacity=".62"/>`,
      ][variant % 3]!;
      break;
    case "mountain-range":
      width = 190;
      height = 126;
      body = [
        `<path d="M8 108 37 55l18 20 29-58 29 52 20-30 49 69Z" ${common}/><path d="m84 17 13 37-12-8-11 11ZM37 55l10 25-9-7-9 10ZM133 39l12 28-11-8-9 10Z" fill="#f8f0dd" stroke="none"/><path d="M18 107 43 73l14 16 28-43 24 37 23-25 35 49" fill="none" stroke="#57493d" stroke-width="2.2" opacity=".55"/>`,
        `<path d="M6 108 30 72l21-35 22 32 24-55 31 61 16-22 40 55Z" ${common}/><path d="m97 14 14 40-14-10-11 12ZM51 37l10 25-10-8-8 10ZM144 53l9 22-9-7-7 8Z" fill="#f7efdc" stroke="none"/><path d="M20 107 52 61l21 26 24-44 26 45 22-21 26 40" fill="none" stroke="#5d4d40" stroke-width="2" opacity=".52"/>`,
        `<path d="M8 108 27 77l21-42 20 34 20-25 19-31 29 58 20-28 28 65Z" ${common}/><path d="m107 13 13 37-12-9-10 12ZM48 35l10 27-10-8-9 10ZM156 43l9 24-9-7-7 8Z" fill="#f8f1df" stroke="none"/><path d="M17 107 49 60l18 25 21-21 19-20 28 44 21-23 18 42" fill="none" stroke="#594a3e" stroke-width="2" opacity=".5"/>`,
        `<path d="M7 108 34 64l18 18 18-31 19 17 24-56 29 62 18-17 24 51Z" ${common}/><path d="m113 12 14 40-13-10-10 13ZM70 51l9 22-9-7-7 8ZM34 64l9 21-9-7-7 8Z" fill="#f8f0dd" stroke="none"/><path d="M18 107 53 70l17 30 19-13 24-43 27 43 18-18 16 38" fill="none" stroke="#594b3f" stroke-width="2" opacity=".52"/>`,
      ][variant % 4]!;
      break;
    case "snow-peak":
      body = [
        `<path d="M8 112 61 13l59 99Z" ${common}/><path d="m61 13 18 44-18-12-15 14Z" fill="#fbf7ea" stroke="none"/><path d="M31 105 61 45l24 60" fill="none" stroke="#5d5249" stroke-width="3" opacity=".48"/>`,
        `<path d="M6 112 50 26l16 21 17-34 39 99Z" ${common}/><path d="m83 13 14 42-14-9-11 12ZM50 26l10 28-10-8-9 11Z" fill="#faf7ec" stroke="none"/><path d="M21 105 51 50l15 19 17-24 22 60" fill="none" stroke="#5e544d" stroke-width="3" opacity=".48"/>`,
        `<path d="M7 112 42 58 66 12l55 100Z" ${common}/><path d="m66 12 17 46-17-12-14 15Z" fill="#fcf8eb" stroke="none"/><path d="M24 105 44 72l13 13 10-39 30 59" fill="none" stroke="#5d534a" stroke-width="3" opacity=".5"/>`,
      ][variant % 3]!;
      break;
    case "foothills":
      width = 170;
      height = 112;
      body = [
        `<path d="M7 104c18-42 46-51 67-19 17-39 52-47 88 19Z" ${common}/><path d="M24 100c16-26 32-30 48-7M89 98c19-31 38-34 57-6" fill="none" stroke="#eee2c1" stroke-width="5" opacity=".68"/>`,
        `<path d="M7 104c15-31 33-42 53-25 20-48 57-51 79-11 11-4 20 8 24 36Z" ${common}/><path d="M19 100c12-18 25-23 39-13M76 98c18-31 37-37 56-20" fill="none" stroke="#efe4c5" stroke-width="5" opacity=".68"/>`,
        `<path d="M7 104c20-48 45-47 66-13 14-28 35-40 51-18 19-13 33 1 39 31Z" ${common}/><path d="M22 99c14-27 31-31 48-4M88 98c11-20 23-25 35-15" fill="none" stroke="#efe3c3" stroke-width="5" opacity=".68"/>`,
      ][variant % 3]!;
      break;
    case "mesa":
      width = 158;
      height = 116;
      body = [
        `<path d="M13 108 31 46l20-19h58l18 19 18 62Z" ${common}/><path d="M31 46h96M24 69h112" fill="none" stroke="#e4b27d" stroke-width="6" opacity=".7"/>`,
        `<path d="M10 108 27 57l24-12 10-25h48l8 25 20 12 11 51Z" ${common}/><path d="M27 57h110M20 79h122" fill="none" stroke="#e5b57d" stroke-width="6" opacity=".72"/>`,
        `<path d="M12 108 22 65l24-18 7-28h64l5 29 20 17 8 43Z" ${common}/><path d="M22 65h120M18 84h128" fill="none" stroke="#e4b17b" stroke-width="6" opacity=".7"/>`,
      ][variant % 3]!;
      break;
    case "volcano":
      body = `<path d="M10 108 42 45h44l32 63Z" ${common}/><path d="M38 47c9 10 41 10 52 0" fill="none" stroke="#f4b35b" stroke-width="7"/><path d="M57 27c-9-12 7-16 0-28M78 31c-8-13 9-18 2-28" fill="none" stroke="#746455" stroke-width="6"/>`;
      break;
    case "broadleaf-grove":
      width = 174;
      height = 126;
      body = [
        `<path d="M12 108c-3-25 20-44 43-34 9-29 46-30 57-4 26-12 51 10 42 38Z" ${common}/><path d="M45 108V75M84 108V57M126 108V76" fill="none" stroke="#5a4636" stroke-width="8"/><path d="M28 89c20-14 42-14 61-5m5 1c18-11 37-9 55 3" fill="none" stroke="#f2d69a" stroke-width="4" opacity=".48"/>`,
        `<path d="M10 108c1-27 29-43 49-29 13-25 48-22 57 4 25-10 47 9 45 25Z" ${common}/><path d="M42 108V78M85 108V55M128 108V78" fill="none" stroke="#5a4636" stroke-width="8"/><path d="M25 91c21-12 42-13 61-4m12-1c16-10 35-8 51 3" fill="none" stroke="#f2d69a" stroke-width="4" opacity=".48"/>`,
        `<path d="M12 108c-2-23 20-41 42-31 11-27 47-29 59-1 23-9 45 10 42 32Z" ${common}/><path d="M43 108V80M85 108V54M129 108V77" fill="none" stroke="#5a4636" stroke-width="8"/><path d="M26 91c19-13 39-15 59-6m14 1c17-11 34-9 50 1" fill="none" stroke="#f2d69a" stroke-width="4" opacity=".48"/>`,
      ][variant % 3]!;
      break;
    case "forest":
    case "jungle":
      width = 170;
      height = 128;
      body = [
        `<path d="M13 109 33 69H20l25-42 25 42H58l18 40ZM52 109 78 57H63l30-48 31 48h-16l27 52ZM109 109l19-38h-12l23-39 24 39h-12l17 38Z" ${common}/><path d="M12 109h150" fill="none" stroke="#5a4636" stroke-width="7"/>`,
        `<path d="M8 109 31 60H17l29-46 29 46H59l24 49ZM68 109l20-39H76l25-41 26 41h-14l21 39ZM118 109l14-28h-9l18-31 20 31h-10l15 28Z" ${common}/><path d="M8 109h154" fill="none" stroke="#5b4736" stroke-width="7"/>`,
        `<path d="M10 109 25 78H15l21-35 21 35H46l16 31ZM43 109l25-49H53l30-48 30 48H98l24 49ZM102 109l24-46h-14l28-44 28 44h-15l18 46Z" ${common}/><path d="M9 109h155" fill="none" stroke="#5a4635" stroke-width="7"/>`,
        `<path d="M9 109 30 66H17l26-44 27 44H56l20 43ZM60 109l18-36H67l23-38 24 38h-13l19 36ZM99 109l25-51h-15l30-49 31 49h-16l18 51Z" ${common}/><path d="M8 109h155" fill="none" stroke="#5c4736" stroke-width="7"/>`,
      ][variant % 4]!;
      if (id === "jungle") {
        body += `<path d="M21 52c12 11 22 7 31-3M92 47c11 10 23 8 32-3M124 66c10 8 20 7 28-2" fill="none" stroke="#b9d28d" stroke-width="4" opacity=".75"/>`;
      }
      break;
    case "pine-grove":
      width = 164;
      height = 128;
      body = [
        `<path d="M9 109 29 74H18l22-31H29L51 9l23 34H63l22 31H73l20 35ZM68 109l18-31H76l20-29H86l20-32 21 32h-10l20 29h-11l18 31Z" ${common}/><path d="M10 109h143" fill="none" stroke="#4f4134" stroke-width="7"/>`,
        `<path d="M8 109 25 80H16l20-29H26L46 17l21 34H57l20 29H67l17 29ZM66 109l22-37H76l24-34H89l24-39 25 39h-12l24 34h-13l21 37Z" ${common}/><path d="M8 109h151" fill="none" stroke="#4f4134" stroke-width="7"/>`,
        `<path d="M6 109 27 73H16l23-34H28L51 3l24 36H64l23 34H75l20 36ZM79 109l17-29H87l19-27H97l18-30 19 30h-9l18 27h-10l16 29Z" ${common}/><path d="M7 109h148" fill="none" stroke="#4f4134" stroke-width="7"/>`,
      ][variant % 3]!;
      break;
    case "bamboo-grove":
      width = 166;
      height = 126;
      body = [
        `<path d="M27 108V35m0 19h19M27 75H11m16-18-15-15M77 108V18m0 21h21M77 63H58m19-18 15-18M128 108V42m0 17h20m-20 22-17-18" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round"/><path d="M27 108V35m0 19h19M27 75H11m16-18-15-15M77 108V18m0 21h21M77 63H58m19-18 15-18M128 108V42m0 17h20m-20 22-17-18" fill="none" stroke="${fill}" stroke-width="5" stroke-linecap="round"/><path d="M10 108h146" fill="none" stroke="#514536" stroke-width="7"/>`,
        `<path d="M24 108V41m0 17h18M24 76 9 60m61 48V16m0 20h23M70 67H51m19-20 16-20m43 81V37m0 17h20m-20 24-16-16" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round"/><path d="M24 108V41m0 17h18M24 76 9 60m61 48V16m0 20h23M70 67H51m19-20 16-20m43 81V37m0 17h20m-20 24-16-16" fill="none" stroke="${fill}" stroke-width="5" stroke-linecap="round"/><path d="M9 108h148" fill="none" stroke="#514536" stroke-width="7"/>`,
        `<path d="M28 108V31m0 19h20M28 76H10m61 32V23m0 19h20M71 70H53m18-22 15-18m43 78V45m0 17h20m-20 22-15-16" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round"/><path d="M28 108V31m0 19h20M28 76H10m61 32V23m0 19h20M71 70H53m18-22 15-18m43 78V45m0 17h20m-20 22-15-16" fill="none" stroke="${fill}" stroke-width="5" stroke-linecap="round"/><path d="M10 108h146" fill="none" stroke="#514536" stroke-width="7"/>`,
      ][variant % 3]!;
      break;
    case "deadwood-single":
      width = 122;
      height = 136;
      body = [
        `<path d="M61 124 58 57 31 30M58 73l37-32M58 91 29 72M58 58l5-37" fill="none" stroke="${stroke}" stroke-width="15" stroke-linecap="round"/><path d="M61 124 58 57 31 30M58 73l37-32M58 91 29 72M58 58l5-37" fill="none" stroke="${fill}" stroke-width="6" stroke-linecap="round"/><path d="M20 124h82" fill="none" stroke="${stroke}" stroke-width="8"/>`,
        `<path d="M58 124 63 52 35 38M63 70l34-35M63 88 30 79M63 53l-4-30" fill="none" stroke="${stroke}" stroke-width="15" stroke-linecap="round"/><path d="M58 124 63 52 35 38M63 70l34-35M63 88 30 79M63 53l-4-30" fill="none" stroke="${fill}" stroke-width="6" stroke-linecap="round"/><path d="M19 124h84" fill="none" stroke="${stroke}" stroke-width="8"/>`,
        `<path d="M62 124 55 59 28 42M55 76l39-27M55 94 25 83M55 59l11-34" fill="none" stroke="${stroke}" stroke-width="15" stroke-linecap="round"/><path d="M62 124 55 59 28 42M55 76l39-27M55 94 25 83M55 59l11-34" fill="none" stroke="${fill}" stroke-width="6" stroke-linecap="round"/><path d="M19 124h84" fill="none" stroke="${stroke}" stroke-width="8"/>`,
      ][variant % 3]!;
      break;
    case "deadwood":
      width = 160;
      height = 124;
      body = [
        `<path d="M38 110 45 51 25 32M45 59l25-27M102 110 98 45l-24-20M98 57l28-29M98 75l35-11" fill="none" stroke="${stroke}" stroke-width="13"/><path d="M38 110 45 51 25 32M45 59l25-27M102 110 98 45l-24-20M98 57l28-29M98 75l35-11" fill="none" stroke="${fill}" stroke-width="6"/><path d="M13 110h136" fill="none" stroke="${stroke}" stroke-width="8"/>`,
        `<path d="M32 110 37 62 15 46M37 70l24-31M93 110l7-69-22-22M99 55l30-19M98 73l34 9" fill="none" stroke="${stroke}" stroke-width="13"/><path d="M32 110 37 62 15 46M37 70l24-31M93 110l7-69-22-22M99 55l30-19M98 73l34 9" fill="none" stroke="${fill}" stroke-width="6"/><path d="M11 110h138" fill="none" stroke="${stroke}" stroke-width="8"/>`,
        `<path d="M45 110 40 46 17 25M41 61l28-22M111 110 105 57l-20-17M106 68l29-31M105 84l35-5" fill="none" stroke="${stroke}" stroke-width="13"/><path d="M45 110 40 46 17 25M41 61l28-22M111 110 105 57l-20-17M106 68l29-31M105 84l35-5" fill="none" stroke="${fill}" stroke-width="6"/><path d="M12 110h138" fill="none" stroke="${stroke}" stroke-width="8"/>`,
      ][variant % 3]!;
      break;
    case "wetland":
      width = 170;
      height = 118;
      body = `<path d="M16 91c30-20 55 12 78-6 24-19 35 15 60-6" fill="none" stroke="${stroke}" stroke-width="12"/><path d="M28 80V31M57 90V22M110 87V28M139 81V36" stroke="${fill}" stroke-width="7"/><path d="M19 102h139" fill="none" stroke="#4e7b77" stroke-width="6"/>`;
      break;
    case "reed-bed":
      width = 176;
      height = 118;
      body = [
        `<path d="M14 101c27-14 46 9 69-2 22-12 39 11 79-3" fill="none" stroke="#537d74" stroke-width="8"/><path d="M29 94V31M44 96V45M68 93V19M91 96V38M118 92V25M141 95V43" fill="none" stroke="${stroke}" stroke-width="9"/><path d="M29 31h1M44 45h1M68 19h1M91 38h1M118 25h1M141 43h1" stroke="${fill}" stroke-width="15" stroke-linecap="round"/>`,
        `<path d="M13 101c29-15 51 9 73-2 23-12 41 12 77-3" fill="none" stroke="#537d74" stroke-width="8"/><path d="M24 94V42M52 96V23M76 92V36M103 96V17M130 92V35M150 95V48" fill="none" stroke="${stroke}" stroke-width="9"/><path d="M24 42h1M52 23h1M76 36h1M103 17h1M130 35h1M150 48h1" stroke="${fill}" stroke-width="15" stroke-linecap="round"/>`,
        `<path d="M12 101c25-14 45 8 68-3 27-13 45 12 83-3" fill="none" stroke="#537d74" stroke-width="8"/><path d="M31 95V18M54 94V37M82 96V26M108 93V40M135 96V20M153 95V46" fill="none" stroke="${stroke}" stroke-width="9"/><path d="M31 18h1M54 37h1M82 26h1M108 40h1M135 20h1M153 46h1" stroke="${fill}" stroke-width="15" stroke-linecap="round"/>`,
      ][variant % 3]!;
      break;
    case "mangrove":
      width = 172;
      height = 128;
      body = [
        `<path d="M23 110V61M23 84 9 68M23 77l17-20M82 110V47M82 73 61 57M82 64l24-21M140 110V67M140 86l-15-18M140 79l19-17" fill="none" stroke="${stroke}" stroke-width="13"/><path d="M23 110V61M23 84 9 68M23 77l17-20M82 110V47M82 73 61 57M82 64l24-21M140 110V67M140 86l-15-18M140 79l19-17" fill="none" stroke="${fill}" stroke-width="6"/><path d="M10 110c28-12 44 9 70 0 26-10 45 10 82 0" fill="none" stroke="#4d7978" stroke-width="7"/>`,
        `<path d="M25 110V53M25 77 9 60M25 69l19-18M79 110V66M79 87 62 72M79 79l20-20M136 110V49M136 73l-19-17M136 67l20-20" fill="none" stroke="${stroke}" stroke-width="13"/><path d="M25 110V53M25 77 9 60M25 69l19-18M79 110V66M79 87 62 72M79 79l20-20M136 110V49M136 73l-19-17M136 67l20-20" fill="none" stroke="${fill}" stroke-width="6"/><path d="M10 110c28-12 44 9 70 0 26-10 45 10 82 0" fill="none" stroke="#4d7978" stroke-width="7"/>`,
        `<path d="M22 110V65M22 86 8 71M22 79l16-18M82 110V51M82 77 60 58M82 69l24-20M143 110V63M143 85l-16-16M143 78l18-18" fill="none" stroke="${stroke}" stroke-width="13"/><path d="M22 110V65M22 86 8 71M22 79l16-18M82 110V51M82 77 60 58M82 69l24-20M143 110V63M143 85l-16-16M143 78l18-18" fill="none" stroke="${fill}" stroke-width="6"/><path d="M10 110c28-12 44 9 70 0 26-10 45 10 82 0" fill="none" stroke="#4d7978" stroke-width="7"/>`,
      ][variant % 3]!;
      break;
    case "grassland":
      width = 170;
      height = 110;
      body = `<path d="M12 85c29-37 54 9 77-20 22-28 45 8 69-21l-9 45H24Z" ${common}/><path d="M33 89V63M51 91V54M118 83V52M139 86V63" stroke="#f4efbb" stroke-width="4"/>`;
      break;
    case "shrubland":
      width = 170;
      height = 104;
      body = [
        `<path d="M11 94c4-24 25-32 42-19 13-23 43-20 54 4 21-7 41 7 42 15Z" ${common}/><path d="M18 94h135" fill="none" stroke="#574839" stroke-width="7"/><path d="M31 78c10 6 18 5 26-2m18 6c10 6 19 5 27-3m14 4c8 5 16 4 24-2" fill="none" stroke="#d5c778" stroke-width="4" opacity=".58"/>`,
        `<path d="M10 94c3-20 23-31 40-20 12-20 40-20 53 1 21-10 45 5 46 19Z" ${common}/><path d="M17 94h137" fill="none" stroke="#574839" stroke-width="7"/><path d="M29 79c9 5 17 4 25-3m19 6c9 5 18 4 26-3m15 4c8 5 16 4 24-2" fill="none" stroke="#d5c778" stroke-width="4" opacity=".58"/>`,
        `<path d="M12 94c2-22 22-34 42-22 13-21 42-18 53 3 20-8 40 4 42 19Z" ${common}/><path d="M18 94h135" fill="none" stroke="#574839" stroke-width="7"/><path d="M31 79c9 5 17 4 25-3m20 6c9 5 18 4 26-3m14 4c8 5 16 4 24-2" fill="none" stroke="#d5c778" stroke-width="4" opacity=".58"/>`,
      ][variant % 3]!;
      break;
    case "river":
      width = 190;
      height = 120;
      body = `<path d="M16 12c58 20 31 42 86 52 41 7 42 26 72 43" fill="none" stroke="${stroke}" stroke-width="14"/><path d="M16 12c58 20 31 42 86 52 41 7 42 26 72 43" fill="none" stroke="${fill}" stroke-width="7"/>`;
      break;
    case "rapids":
      width = 190;
      height = 120;
      body = `<path d="M16 12c58 20 31 42 86 52 41 7 42 26 72 43" fill="none" stroke="${stroke}" stroke-width="16"/><path d="M16 12c58 20 31 42 86 52 41 7 42 26 72 43" fill="none" stroke="${fill}" stroke-width="8"/><path d="m30 27 11-6m18 23 13-7m17 25 13-7m22 23 13-6m17 22 12-5" fill="none" stroke="#efffff" stroke-width="4" stroke-linecap="round"/>`;
      break;
    case "lake":
      body = `<path d="M15 62c0-26 29-43 52-31 24-20 62-4 65 25 25 13 11 51-17 54H53c-23 0-38-21-38-48Z" ${common}/><path d="M44 60c15-8 34-8 52 0" fill="none" stroke="#d8f4f580" stroke-width="5"/>`;
      break;
    case "delta":
      width = 180;
      height = 118;
      body = `<path d="M16 18c11 24 20 34 38 44-11 12-22 23-29 43M54 62c28 6 50 18 78 42M54 62c23-13 45-28 67-48M54 62c13 23 29 38 52 47" fill="none" stroke="${stroke}" stroke-width="14"/><path d="M16 18c11 24 20 34 38 44-11 12-22 23-29 43M54 62c28 6 50 18 78 42M54 62c23-13 45-28 67-48M54 62c13 23 29 38 52 47" fill="none" stroke="${fill}" stroke-width="7"/>`;
      break;
    case "coral-reef":
      width = 172;
      height = 116;
      body = [
        `<path d="M16 103h142M41 103V63M41 77 24 60M41 70l17-20M83 103V48M83 74 61 58M83 64l20-27M125 103V62M125 80l-18-16M125 72l18-22" fill="none" stroke="${stroke}" stroke-width="11"/><path d="M16 103h142M41 103V63M41 77 24 60M41 70l17-20M83 103V48M83 74 61 58M83 64l20-27M125 103V62M125 80l-18-16M125 72l18-22" fill="none" stroke="${fill}" stroke-width="5"/>`,
        `<path d="M15 103h143M34 103V57M34 79 18 65M34 69l15-21M78 103V63M78 84 59 68M78 76l18-24M121 103V47M121 75 102 56M121 66l20-26" fill="none" stroke="${stroke}" stroke-width="11"/><path d="M15 103h143M34 103V57M34 79 18 65M34 69l15-21M78 103V63M78 84 59 68M78 76l18-24M121 103V47M121 75 102 56M121 66l20-26" fill="none" stroke="${fill}" stroke-width="5"/>`,
        `<path d="M15 103h143M38 103V49M38 74 20 56M38 66l17-23M84 103V60M84 82 65 64M84 73l19-23M132 103V56M132 79l-18-17M132 70l19-24" fill="none" stroke="${stroke}" stroke-width="11"/><path d="M15 103h143M38 103V49M38 74 20 56M38 66l17-23M84 103V60M84 82 65 64M84 73l19-23M132 103V56M132 79l-18-17M132 70l19-24" fill="none" stroke="${fill}" stroke-width="5"/>`,
      ][variant % 3]!;
      break;
    case "seaweed-bed":
      width = 172;
      height = 112;
      body = [
        `<path d="M15 102c18-19-7-34 13-56m19 56c17-21-5-39 13-70m23 70c17-20-4-36 14-61m23 61c18-21-5-37 13-68m23 68c18-20-4-35 13-54" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round"/><path d="M15 102c18-19-7-34 13-56m19 56c17-21-5-39 13-70m23 70c17-20-4-36 14-61m23 61c18-21-5-37 13-68m23 68c18-20-4-35 13-54" fill="none" stroke="${fill}" stroke-width="5" stroke-linecap="round"/><path d="M9 102h154" fill="none" stroke="#47798a" stroke-width="6"/>`,
        `<path d="M16 102c16-17-5-30 12-50m23 50c17-20-5-39 12-64m23 64c17-18-4-34 13-59m23 59c17-20-5-37 12-63m24 63c16-16-3-30 11-48" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round"/><path d="M16 102c16-17-5-30 12-50m23 50c17-20-5-39 12-64m23 64c17-18-4-34 13-59m23 59c17-20-5-37 12-63m24 63c16-16-3-30 11-48" fill="none" stroke="${fill}" stroke-width="5" stroke-linecap="round"/><path d="M9 102h154" fill="none" stroke="#47798a" stroke-width="6"/>`,
        `<path d="M15 102c18-20-7-37 13-62m20 62c17-18-4-33 13-57m23 57c18-20-6-38 13-68m23 68c17-18-4-35 13-58m23 58c17-17-4-31 12-52" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round"/><path d="M15 102c18-20-7-37 13-62m20 62c17-18-4-33 13-57m23 57c18-20-6-38 13-68m23 68c17-18-4-35 13-58m23 58c17-17-4-31 12-52" fill="none" stroke="${fill}" stroke-width="5" stroke-linecap="round"/><path d="M9 102h154" fill="none" stroke="#47798a" stroke-width="6"/>`,
      ][variant % 3]!;
      break;
    case "sea-foam":
    case "coast-foam":
      width = 194;
      height = 82;
      body = [
        `<path d="M10 42c15-18 30 18 46 0s30 18 46 0 30 18 46 0 28 17 37 0M24 60c11-12 23 12 35 0s23 12 35 0 23 12 35 0 23 12 35 0" fill="none" stroke="${stroke}" stroke-width="10" stroke-linecap="round"/><path d="M10 42c15-18 30 18 46 0s30 18 46 0 30 18 46 0 28 17 37 0M24 60c11-12 23 12 35 0s23 12 35 0 23 12 35 0 23 12 35 0" fill="none" stroke="${fill}" stroke-width="4" stroke-linecap="round"/>`,
        `<path d="M11 39c15-17 29 17 44 0s29 17 44 0 29 17 44 0 29 17 40 0M23 61c12-11 23 11 35 0s23 11 35 0 23 11 35 0 23 11 35 0" fill="none" stroke="${stroke}" stroke-width="10" stroke-linecap="round"/><path d="M11 39c15-17 29 17 44 0s29 17 44 0 29 17 44 0 29 17 40 0M23 61c12-11 23 11 35 0s23 11 35 0 23 11 35 0 23 11 35 0" fill="none" stroke="${fill}" stroke-width="4" stroke-linecap="round"/>`,
        `<path d="M10 43c14-19 30 19 45 0s30 19 45 0 30 19 45 0 30 19 39 0M25 62c11-13 23 13 34 0s23 13 34 0 23 13 34 0 23 13 34 0" fill="none" stroke="${stroke}" stroke-width="10" stroke-linecap="round"/><path d="M10 43c14-19 30 19 45 0s30 19 45 0 30 19 45 0 30 19 39 0M25 62c11-13 23 13 34 0s23 13 34 0 23 13 34 0 23 13 34 0" fill="none" stroke="${fill}" stroke-width="4" stroke-linecap="round"/>`,
      ][variant % 3]!;
      break;
    case "ice-floe":
      width = 178;
      height = 112;
      body = [
        `<path d="M11 86 39 45l40 8 22-25 63 39-22 29-42 8-33-16-29 15Z" ${common}/><path d="m39 45 28 43M79 53l21 51M101 28 96 84" fill="none" stroke="#f5ffff" stroke-width="5" opacity=".7"/>`,
        `<path d="M12 85 34 54l34-6 27-22 64 42-18 31-39 5-34-13-32 13Z" ${common}/><path d="m34 54 34 37M68 48l34 56M95 26 97 81" fill="none" stroke="#f5ffff" stroke-width="5" opacity=".7"/>`,
        `<path d="M11 87 37 42l36 11 29-27 61 42-19 29-41 7-30-16-32 14Z" ${common}/><path d="m37 42 36 46M73 53l30 51M102 26 98 82" fill="none" stroke="#f5ffff" stroke-width="5" opacity=".7"/>`,
      ][variant % 3]!;
      break;
    case "waterfall":
      body = `<path d="M22 26h84l-16 27 23 57H45l22-57Z" ${common}/><path d="M68 53v48M82 53v48" stroke="#d9f6ff" stroke-width="7"/>`;
      break;
    case "ocean-current":
      width = 190;
      height = 112;
      body = `<path d="M12 36c30-30 56 30 83 0 27-30 51 30 83 0M12 76c30-30 56 30 83 0 27-30 51 30 83 0" fill="none" stroke="${stroke}" stroke-width="10"/><path d="M12 36c30-30 56 30 83 0 27-30 51 30 83 0M12 76c30-30 56 30 83 0 27-30 51 30 83 0" fill="none" stroke="${fill}" stroke-width="5"/>`;
      break;
    case "city":
    case "capital":
      body = [
        `<path d="M10 108V69l22-17 21 17v39ZM47 108V47l26-22 26 22v61ZM94 108V61l19-15 18 15v47Z" ${common}/><path d="M20 79h22M59 58h28M59 76h28M104 72h17" stroke="#f8e7bf" stroke-width="4"/><path d="M7 108h130" fill="none" stroke="${stroke}" stroke-width="7"/>`,
        `<path d="M9 108V60l25-19 24 19v48ZM53 108V68l20-16 21 16v40ZM88 108V39l23-21 22 21v69Z" ${common}/><path d="M20 72h27M64 79h19M99 52h23M99 70h23" stroke="#f8e7bf" stroke-width="4"/><path d="M6 108h133" fill="none" stroke="${stroke}" stroke-width="7"/>`,
        `<path d="M8 108V74l18-15 19 15v34ZM39 108V45l29-24 29 24v63ZM91 108V67l22-18 21 18v41Z" ${common}/><path d="M17 83h19M52 58h32M52 78h32M102 77h22" stroke="#f8e7bf" stroke-width="4"/><path d="M6 108h132" fill="none" stroke="${stroke}" stroke-width="7"/>`,
      ][variant % 3]!;
      if (id === "capital")
        body += `<path d="m105 4 7 14 15 2-11 11 3 15-14-7-14 7 3-15-11-11 15-2Z" fill="#f5c75d" stroke="${stroke}" stroke-width="3"/>`;
      break;
    case "farmland":
    case "farmland-field":
      width = 180;
      height = 112;
      body = [
        `<path d="M13 104 31 32h122l14 72Z" ${common}/><path d="M31 32 67 104M64 32l36 72M98 32l35 72M132 32l35 72M19 76h142M25 53h133" fill="none" stroke="#f3df9f" stroke-width="5" opacity=".76"/>`,
        `<path d="M12 104 28 35h126l14 69Z" ${common}/><path d="M28 35 61 104M60 35l35 69M94 35l34 69M127 35l34 69M19 79h142M24 56h136" fill="none" stroke="#f3df9f" stroke-width="5" opacity=".76"/>`,
        `<path d="M13 104 35 29h118l14 75Z" ${common}/><path d="M35 29 69 104M67 29l36 75M101 29l34 75M134 29l33 75M20 75h142M27 51h132" fill="none" stroke="#f3df9f" stroke-width="5" opacity=".76"/>`,
      ][variant % 3]!;
      break;
    case "terraces":
      width = 176;
      height = 114;
      body = [
        `<path d="M10 102h156M24 82h121M42 62h85M61 42h47" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round"/><path d="M10 102h156M24 82h121M42 62h85M61 42h47" fill="none" stroke="${fill}" stroke-width="6" stroke-linecap="round"/><path d="M31 82V102m29-40v20m30-40v20m29 20v20" fill="none" stroke="#e5c982" stroke-width="4" opacity=".72"/>`,
        `<path d="M10 102h156M20 82h131M39 62h92M57 42h52" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round"/><path d="M10 102h156M20 82h131M39 62h92M57 42h52" fill="none" stroke="${fill}" stroke-width="6" stroke-linecap="round"/><path d="M30 82V102m30-40v20m31-40v20m29 20v20" fill="none" stroke="#e5c982" stroke-width="4" opacity=".72"/>`,
        `<path d="M10 102h156M26 82h119M45 62h82M62 42h45" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round"/><path d="M10 102h156M26 82h119M45 62h82M62 42h45" fill="none" stroke="${fill}" stroke-width="6" stroke-linecap="round"/><path d="M34 82V102m29-40v20m31-40v20m27 20v20" fill="none" stroke="#e5c982" stroke-width="4" opacity=".72"/>`,
      ][variant % 3]!;
      break;
    case "camp":
      width = 156;
      height = 118;
      body = [
        `<path d="M10 106 45 45l34 61ZM59 106l30-49 38 49Z" ${common}/><path d="M30 78h29M79 82h32M15 106h127" fill="none" stroke="#f1dfbf" stroke-width="4"/>`,
        `<path d="M12 106 40 52l35 54ZM56 106l34-60 42 60Z" ${common}/><path d="M28 80h25M80 76h35M15 106h127" fill="none" stroke="#f1dfbf" stroke-width="4"/>`,
        `<path d="M11 106 42 42l35 64ZM62 106l27-48 41 48Z" ${common}/><path d="M29 77h27M79 84h35M15 106h127" fill="none" stroke="#f1dfbf" stroke-width="4"/>`,
      ][variant % 3]!;
      break;
    case "mine":
      width = 152;
      height = 120;
      body = [
        `<path d="M11 110 35 57l28-31 41 20 30 64Z" ${common}/><path d="M47 110V80c0-26 40-33 54-8 5 9 4 25 4 38Z" fill="#272827" stroke="${stroke}" stroke-width="4"/><path d="M24 66h82M31 52l78 58" fill="none" stroke="#d8c6a7" stroke-width="5" opacity=".7"/>`,
        `<path d="M11 110 28 65l32-35 45 17 30 63Z" ${common}/><path d="M46 110V82c0-27 42-32 55-7 4 9 3 25 3 35Z" fill="#272827" stroke="${stroke}" stroke-width="4"/><path d="M23 69h88M34 52l75 58" fill="none" stroke="#d8c6a7" stroke-width="5" opacity=".7"/>`,
        `<path d="M10 110 33 59l28-32 45 21 28 62Z" ${common}/><path d="M47 110V79c0-25 40-30 53-7 5 8 4 24 4 38Z" fill="#272827" stroke="${stroke}" stroke-width="4"/><path d="M26 65h84M33 51l77 59" fill="none" stroke="#d8c6a7" stroke-width="5" opacity=".7"/>`,
      ][variant % 3]!;
      break;
    case "shipyard":
      width = 170;
      height = 124;
      body = [
        `<path d="M12 105h145M28 105V52h34v53M45 52V22M81 105V64h49v41M105 64V35" fill="none" stroke="${stroke}" stroke-width="10"/><path d="M44 20v69M25 43h37M104 33v58M83 52h48" fill="none" stroke="#eadcc3" stroke-width="5"/><path d="M15 113c23-12 37 10 60 0 24-11 40 11 76 0" fill="none" stroke="#6fa3b4" stroke-width="7"/>`,
        `<path d="M13 105h144M26 105V61h35v44M44 61V28M83 105V54h48v51M107 54V20" fill="none" stroke="${stroke}" stroke-width="10"/><path d="M43 26v65M24 49h38M106 18v75M84 42h48" fill="none" stroke="#eadcc3" stroke-width="5"/><path d="M15 113c23-12 37 10 60 0 24-11 40 11 76 0" fill="none" stroke="#6fa3b4" stroke-width="7"/>`,
        `<path d="M12 105h145M28 105V56h34v49M45 56V20M82 105V61h49v44M106 61V31" fill="none" stroke="${stroke}" stroke-width="10"/><path d="M44 19v71M25 45h38M105 30v61M84 48h48" fill="none" stroke="#eadcc3" stroke-width="5"/><path d="M15 113c23-12 37 10 60 0 24-11 40 11 76 0" fill="none" stroke="#6fa3b4" stroke-width="7"/>`,
      ][variant % 3]!;
      break;
    case "village":
      width = 154;
      height = 118;
      body = [
        `<path d="M8 108V72l24-19 24 19v36ZM48 108V61l28-22 28 22v47ZM97 108V75l21-17 22 17v33Z" ${common}/><path d="M20 86h13v22M64 77h18v31M110 87h12v21" fill="#f5e8ca" stroke="${stroke}" stroke-width="3"/><path d="M6 108h139" fill="none" stroke="${stroke}" stroke-width="7"/>`,
        `<path d="M9 108V66l26-20 25 20v42ZM55 108V76l21-17 22 17v32ZM91 108V57l25-20 25 20v51Z" ${common}/><path d="M21 82h15v26M68 88h14v20M105 75h17v33" fill="#f5e8ca" stroke="${stroke}" stroke-width="3"/><path d="M6 108h139" fill="none" stroke="${stroke}" stroke-width="7"/>`,
        `<path d="M7 108V77l20-17 21 17v31ZM41 108V56l29-23 28 23v52ZM91 108V72l23-18 24 18v36Z" ${common}/><path d="M18 89h12v19M58 73h18v35M105 85h14v23" fill="#f5e8ca" stroke="${stroke}" stroke-width="3"/><path d="M5 108h139" fill="none" stroke="${stroke}" stroke-width="7"/>`,
      ][variant % 3]!;
      break;
    case "port":
      width = 154;
      height = 124;
      body = `<path d="M15 104h124M31 104V65h28v39M45 65V37M78 104V51h40v53M98 51V24" fill="none" stroke="${stroke}" stroke-width="9"/><path d="M45 21v67M28 54h34M98 11v76M80 39h38" fill="none" stroke="#e9ddc4" stroke-width="5"/><path d="M13 111c22-13 37 11 58 0 21-12 38 12 68 0" fill="none" stroke="#78a8b5" stroke-width="6"/>`;
      break;
    case "watchtower":
      width = 128;
      height = 128;
      body = `<path d="M30 112 40 47h48l10 65ZM32 47l-9-20h18V13h16v14h14V13h16v14h18l-9 20Z" ${common}/><path d="M54 64h20M51 82h26M58 112V92h14v20" fill="#f2e4c8" stroke="${stroke}" stroke-width="4"/><path d="M21 112h86" fill="none" stroke="${stroke}" stroke-width="7"/>`;
      break;
    case "bridge":
      width = 174;
      height = 112;
      body = `<path d="M10 89h154M21 89V57h132v32M29 57c14-35 37-35 52 0M81 57c15-35 39-35 54 0M135 57h18" fill="none" stroke="${stroke}" stroke-width="10"/><path d="M10 102c27-13 44 11 71 0 27-12 47 12 83 0" fill="none" stroke="#6e9eac" stroke-width="6"/>`;
      break;
    case "castle-cluster":
      width = 182;
      height = 132;
      body = [
        `<path d="M12 112V55h20V28h18v27h25V39h18v16h24V28h18v27h23v57Z" ${common}/><path d="M38 78h20v34H38ZM82 72h24v40H82ZM132 80h20v32h-20Z" fill="#efe5d0" stroke="${stroke}" stroke-width="4"/><path d="M11 112h160" fill="none" stroke="#e5c982" stroke-width="6"/>`,
        `<path d="M10 112V61h22V31h17v30h28V43h18v18h26V29h18v32h25v51Z" ${common}/><path d="M36 83h19v29H36ZM83 76h22v36H83ZM132 84h20v28h-20Z" fill="#efe5d0" stroke="${stroke}" stroke-width="4"/><path d="M10 112h162" fill="none" stroke="#e5c982" stroke-width="6"/>`,
        `<path d="M11 112V54h21V24h18v30h24V42h19v12h27V25h18v29h25v58Z" ${common}/><path d="M37 76h20v36H37ZM83 70h25v42H83ZM132 78h21v34h-21Z" fill="#efe5d0" stroke="${stroke}" stroke-width="4"/><path d="M11 112h161" fill="none" stroke="#e5c982" stroke-width="6"/>`,
      ][variant % 3]!;
      break;
    case "fortress":
      body = `<path d="M21 108V43h20V25h18v18h25V25h18v18h20v65Z" ${common}/><path d="M49 74h31v34H49ZM101 74h18v34h-18Z" fill="#efe5d0" stroke="${stroke}" stroke-width="4"/>`;
      break;
    case "road":
    case "border":
      width = 190;
      height = 112;
      body = `<path d="M12 18c40 35 61 4 91 31 26 24 43 5 75 42" fill="none" stroke="${stroke}" stroke-width="15"/><path d="M12 18c40 35 61 4 91 31 26 24 43 5 75 42" fill="none" stroke="${fill}" stroke-width="7" ${id === "border" ? 'stroke-dasharray="10 10"' : ""}/>`;
      break;
    case "wall":
      width = 190;
      height = 112;
      body = `<path d="M12 24c34 25 65 5 92 30 28 23 44 6 74 34" fill="none" stroke="${stroke}" stroke-width="19"/><path d="M12 24c34 25 65 5 92 30 28 23 44 6 74 34" fill="none" stroke="${fill}" stroke-width="11"/><path d="M19 16v17M45 27v17M72 29v17M101 42v17M130 51v17M159 57v17" fill="none" stroke="#e8ddc7" stroke-width="4"/>`;
      break;
    case "faction-seat":
      body = `<path d="M24 107V53l40-34 40 34v54Z" ${common}/><path d="M64 19v88M43 66h42M36 88h56" stroke="#f7e3b0" stroke-width="5"/>`;
      break;
    case "secret-realm":
    case "ruins":
      body = `<path d="M18 108 33 51l26-24 25 24 26-24 22 81Z" ${common}/><path d="M43 103V67h40v36M95 103V74h19v29" fill="#efe4c8" stroke="${stroke}" stroke-width="4"/>`;
      break;
    case "temple":
      body = `<path d="M20 108h88M28 94h72M34 49h60M30 49 64 22l34 27ZM40 52v39M58 52v39M76 52v39M94 52v39" ${common}/>`;
      break;
    case "resource":
      body = `<path d="m64 10 15 34 37 3-28 24 9 37-33-19-33 19 9-37-28-24 37-3Z" ${common}/><circle cx="64" cy="65" r="12" fill="#fff5bd" stroke="none"/>`;
      break;
    case "cave":
      width = 150;
      height = 116;
      body = [
        `<path d="M9 108 30 55l31-31 38 8 31 29 12 47Z" ${common}/><path d="M48 108V77c0-25 42-28 51-4 3 8 2 21 2 35Z" fill="#292824" stroke="${stroke}" stroke-width="4"/><path d="M56 72c10-12 23-14 36-4" fill="none" stroke="#bcae91" stroke-width="4" opacity=".55"/>`,
        `<path d="M8 108 25 64 54 29l35-10 38 35 15 54Z" ${common}/><path d="M44 108V82c0-29 45-36 60-10 5 9 4 23 4 36Z" fill="#292824" stroke="${stroke}" stroke-width="4"/><path d="M55 69c13-12 27-11 40 1" fill="none" stroke="#bcae91" stroke-width="4" opacity=".55"/>`,
      ][variant % 2]!;
      break;
    case "obelisk":
      width = 108;
      height = 132;
      body = `<path d="M31 116 39 36 54 9l16 27 8 80Z" ${common}/><path d="M39 36h31M54 9v107M22 116h65l9 10H13Z" fill="none" stroke="${stroke}" stroke-width="4"/><path d="M46 51h16M44 67h20M43 84h22" stroke="#e5dbc7" stroke-width="4" opacity=".75"/>`;
      break;
    case "floating-island":
      width = 176;
      height = 142;
      body = [
        `<path d="M19 66 49 29h80l29 37-22 24-18 38-24-13-22 18-27-18-20 13-17-39Z" ${common}/><path d="M44 55c24 13 57 12 84-2M58 89l14 25M97 85l-8 29" fill="none" stroke="#e7d5b2" stroke-width="5" opacity=".68"/><path d="M74 16v22M64 25h20" fill="none" stroke="#fff3d7" stroke-width="4"/>`,
        `<path d="M18 67 46 34h83l29 33-20 25-20 36-25-14-23 18-25-19-20 14-16-38Z" ${common}/><path d="M42 57c24 12 58 12 87-3M57 89l15 25M99 85l-8 29" fill="none" stroke="#e7d5b2" stroke-width="5" opacity=".68"/><path d="M74 18v21M64 28h20" fill="none" stroke="#fff3d7" stroke-width="4"/>`,
        `<path d="M19 68 48 27h79l31 41-21 23-19 38-25-14-21 18-28-20-19 14-17-37Z" ${common}/><path d="M44 56c24 13 56 13 84-2M57 90l15 24M98 86l-8 28" fill="none" stroke="#e7d5b2" stroke-width="5" opacity=".68"/><path d="M74 15v22M64 25h20" fill="none" stroke="#fff3d7" stroke-width="4"/>`,
      ][variant % 3]!;
      break;
    case "world-tree":
    case "great-tree":
      width = 146;
      height = 146;
      body = [
        `<path d="M69 126V76M69 94 37 67M69 82l28-36M69 106l32-18" fill="none" stroke="${stroke}" stroke-width="16"/><path d="M69 126V76M69 94 37 67M69 82l28-36M69 106l32-18" fill="none" stroke="${fill}" stroke-width="8"/><path d="M30 64c-7-29 34-44 48-20 17-24 55-3 45 25 20 19-2 47-27 36-14 24-49 12-47-10-24 4-35-19-19-31Z" ${common}/><path d="M28 128h87" fill="none" stroke="${stroke}" stroke-width="7"/>`,
        `<path d="M69 126V71M69 93 35 62M69 80l31-37M69 106l34-17" fill="none" stroke="${stroke}" stroke-width="16"/><path d="M69 126V71M69 93 35 62M69 80l31-37M69 106l34-17" fill="none" stroke="${fill}" stroke-width="8"/><path d="M29 60c-7-30 35-44 49-20 17-24 54-2 45 26 19 19-2 46-28 35-14 24-48 12-47-10-24 4-34-19-19-31Z" ${common}/><path d="M28 128h87" fill="none" stroke="${stroke}" stroke-width="7"/>`,
        `<path d="M69 126V78M69 96 38 68M69 82l27-37M69 107l34-18" fill="none" stroke="${stroke}" stroke-width="16"/><path d="M69 126V78M69 96 38 68M69 82l27-37M69 107l34-18" fill="none" stroke="${fill}" stroke-width="8"/><path d="M31 64c-8-29 33-45 47-21 17-24 54-2 45 25 20 20-3 47-28 36-14 24-48 12-46-10-24 4-35-19-18-30Z" ${common}/><path d="M28 128h87" fill="none" stroke="${stroke}" stroke-width="7"/>`,
      ][variant % 3]!;
      break;
    case "underworld-gate":
      width = 142;
      height = 138;
      body = [
        `<path d="M20 119V58l18-32h66l18 32v61Z" ${common}/><path d="M40 119V70c0-32 42-42 62-12 8 12 7 30 7 61Z" fill="#252530" stroke="${stroke}" stroke-width="4"/><path d="M52 78c12-11 27-11 39 0M54 97c10 9 25 9 36 0" fill="none" stroke="${fill}" stroke-width="4" opacity=".8"/>`,
        `<path d="M19 119V55l19-34h66l19 34v64Z" ${common}/><path d="M40 119V69c0-31 42-42 62-12 8 12 7 30 7 62Z" fill="#252530" stroke="${stroke}" stroke-width="4"/><path d="M52 78c12-11 27-11 39 0M54 97c10 9 25 9 36 0" fill="none" stroke="${fill}" stroke-width="4" opacity=".8"/>`,
        `<path d="M20 119V61l18-36h66l18 36v58Z" ${common}/><path d="M41 119V71c0-31 41-41 61-12 8 12 7 30 7 60Z" fill="#252530" stroke="${stroke}" stroke-width="4"/><path d="M53 79c12-11 26-11 38 0M55 98c10 9 24 9 35 0" fill="none" stroke="${fill}" stroke-width="4" opacity=".8"/>`,
      ][variant % 3]!;
      break;
    default: {
      const extended = createExtendedArtworkShape(
        id,
        fill,
        stroke,
        common,
        variant,
      );
      width = extended.width;
      height = extended.height;
      body = extended.body;
      break;
    }
  }

  const variantTransform =
    variant % 3 === 1
      ? `translate(${width} 0) scale(-1 1)`
      : variant % 3 === 2
        ? `rotate(-1.5 ${width / 2} ${height / 2})`
        : "";
  const definitions = `<defs><linearGradient id="asset-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff7df" stop-opacity=".22"/><stop offset=".38" stop-color="${fill}"/><stop offset="1" stop-color="#1d1915" stop-opacity=".28"/></linearGradient><filter id="asset-shadow" x="-25%" y="-25%" width="150%" height="165%"><feDropShadow dx="0" dy="3" stdDeviation="1.8" flood-color="#241d18" flood-opacity=".34"/></filter></defs>`;
  return {
    src: svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${definitions}<rect width="100%" height="100%" fill="${background}" fill-opacity="0"/><g filter="url(#asset-shadow)"${variantTransform ? ` transform="${variantTransform}"` : ""}>${body}</g></svg>`,
    ),
    width,
    height,
  };
}

const ARTWORK_VARIANT_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  archipelago: 3,
  "mountain-range": 4,
  "snow-peak": 3,
  foothills: 3,
  mesa: 3,
  volcano: 3,
  "world-gate": 3,
  portal: 3,
  cliff: 3,
  dunes: 3,
  glacier: 3,
  "rock-spires": 3,
  "boulder-field": 3,
  forest: 4,
  "broadleaf-grove": 3,
  "pine-grove": 3,
  "bamboo-grove": 3,
  deadwood: 3,
  jungle: 4,
  wetland: 3,
  grassland: 3,
  shrubland: 3,
  "reed-bed": 3,
  mangrove: 3,
  delta: 3,
  "coral-reef": 3,
  "seaweed-bed": 3,
  "sea-foam": 3,
  "coast-foam": 3,
  "ice-floe": 3,
  city: 3,
  capital: 3,
  farmland: 3,
  terraces: 3,
  camp: 3,
  mine: 3,
  shipyard: 3,
  village: 3,
  fortress: 3,
  cave: 2,
  ruins: 2,
  "floating-island": 3,
  "world-tree": 3,
  "great-tree": 3,
  "underworld-gate": 3,
  "castle-cluster": 3,
  "farmland-field": 3,
  "deadwood-single": 3,
  "boundary-line": 3,
  ring: 3,
});

export const MAP_ARTWORK_STAMP_ASSETS: readonly MapArtworkStampAsset[] =
  Object.freeze(
    MAP_COMPONENT_PRESETS.map((component) => {
      const color = component.props.color ?? "#8b6b4a";
      const defaultVariantCount =
        component.interaction === "scatter" || component.interaction === "stamp"
          ? 3
          : 1;
      const variants = Array.from(
        {
          length: ARTWORK_VARIANT_COUNTS[component.id] ?? defaultVariantCount,
        },
        (_, index): MapArtworkAssetVariant => {
          const artwork = createArtworkSvg(
            component.id,
            { fill: color },
            index,
          );
          return {
            index,
            imageSrc: artwork.src,
            width: artwork.width,
            height: artwork.height,
            cacheKey: `${component.id}:${index}`,
          };
        },
      );
      const artwork = variants[0]!;
      return {
        id: component.id,
        component,
        name: component.name,
        symbol: component.props.symbol ?? FALLBACK_SYMBOLS[component.id] ?? "✦",
        color,
        imageSrc: artwork.imageSrc,
        width: artwork.width,
        height: artwork.height,
        variants,
        brush: component.interaction === "scatter",
        brushFollowsPath: component.followsPath ?? false,
      };
    }),
  );

export function getMapArtworkStampAsset(
  assetId: string,
): MapArtworkStampAsset | undefined {
  return MAP_ARTWORK_STAMP_ASSETS.find((asset) => asset.id === assetId);
}

/**
 * 将 JSON 中的项目素材清单与已读取的图像 URL 组合为运行时目录。没有成功
 * 读取到字节的项目素材保持不可渲染，不会退化为同名内置图标，避免误画。
 */
export function createMapArtworkAssetCatalog(
  artwork: MapArtwork,
  projectSources: ReadonlyMap<string, string> = new Map(),
): MapArtworkAssetCatalog {
  const projectAssets = new Map<string, MapArtworkProjectAsset>(
    artwork.assets.map((asset) => [asset.id, asset]),
  );
  return Object.freeze({
    get(assetId: string) {
      const projectAsset = projectAssets.get(assetId);
      if (!projectAsset) return getMapArtworkStampAsset(assetId);
      const imageSrc = projectSources.get(projectAsset.id);
      if (!imageSrc) return undefined;
      const variant: MapArtworkAssetVariant = {
        index: 0,
        imageSrc,
        width: projectAsset.width,
        height: projectAsset.height,
        cacheKey: `project:${projectAsset.id}:${projectAsset.path}`,
      };
      return {
        id: projectAsset.id,
        name: projectAsset.name,
        symbol: projectAsset.name.slice(0, 1) || "*",
        color: "#8b6b4a",
        imageSrc,
        width: projectAsset.width,
        height: projectAsset.height,
        variants: [variant],
        brush: projectAsset.brush,
        brushFollowsPath: false,
      };
    },
  });
}

export function getMapArtworkAssetVariant(
  asset: MapArtworkStampAsset,
  variant: number,
): MapArtworkAssetVariant {
  const normalized =
    ((Math.trunc(variant) % asset.variants.length) + asset.variants.length) %
    asset.variants.length;
  return asset.variants[normalized] ?? asset.variants[0]!;
}

/**
 * 内置素材的颜色来自笔触事实而非静态素材文件。只有固定目录中的 SVG 会生成
 * 着色变体；项目导入的图片没有可安全重绘的矢量源，始终保留作者原始颜色。
 */
export function getMapArtworkAssetVariantWithColor(
  asset: MapArtworkStampAsset,
  variant: number,
  color: string,
): MapArtworkAssetVariant {
  const source = getMapArtworkAssetVariant(asset, variant);
  const normalizedColor = color.trim().toLocaleLowerCase("en-US");
  if (
    !asset.component ||
    !HEX_COLOR_PATTERN.test(normalizedColor) ||
    normalizedColor === asset.color.toLocaleLowerCase("en-US")
  ) {
    return source;
  }
  const cacheKey = `${asset.id}:${source.index}:${normalizedColor}`;
  const cached = TINTED_ARTWORK_VARIANT_CACHE.get(cacheKey);
  if (cached) return cached;

  const artwork = createArtworkSvg(
    asset.component.id,
    { fill: normalizedColor },
    source.index,
  );
  const tinted: MapArtworkAssetVariant = {
    index: source.index,
    imageSrc: artwork.src,
    width: artwork.width,
    height: artwork.height,
    cacheKey: `tint:${cacheKey}`,
  };
  TINTED_ARTWORK_VARIANT_CACHE.set(cacheKey, tinted);
  return tinted;
}

export function mapArtworkVariantIndex(
  asset: MapArtworkStampAsset,
  seed: string | number,
): number {
  if (asset.variants.length <= 1) return 0;
  if (typeof seed === "number") {
    return Math.abs(Math.trunc(seed)) % asset.variants.length;
  }
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % asset.variants.length;
}

export function findMapArtworkLayer(
  artwork: MapArtwork,
  layerId?: string,
): MapArtworkLayer | undefined {
  if (layerId) {
    return artwork.layers.find((layer) => layer.id === layerId);
  }
  return (
    artwork.layers.find((layer) => layer.id === "artwork-stamps") ??
    artwork.layers.find((layer) => layer.kind === "stamp") ??
    artwork.layers[0]
  );
}

export function createMapArtworkLayer(input: {
  readonly id: string;
  readonly name: string;
  readonly kind?: MapArtworkLayerKind;
  readonly visible?: boolean;
  readonly locked?: boolean;
  readonly opacity?: number;
}): MapArtworkLayer {
  return {
    id: input.id,
    name: input.name,
    kind: input.kind ?? "stamp",
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    opacity: input.opacity ?? 1,
    stamps: [],
  };
}

export function addMapArtworkLayer(
  artwork: MapArtwork,
  layer: MapArtworkLayer,
): MapArtwork {
  if (artwork.layers.some((item) => item.id === layer.id)) return artwork;
  return { ...artwork, layers: [...artwork.layers, layer] };
}

export function updateMapArtworkLayer(
  artwork: MapArtwork,
  layerId: string,
  patch: Partial<
    Pick<MapArtworkLayer, "name" | "kind" | "visible" | "locked" | "opacity">
  >,
): MapArtwork {
  return {
    ...artwork,
    layers: artwork.layers.map((layer) =>
      layer.id === layerId ? { ...layer, ...patch } : layer,
    ),
  };
}

/**
 * 素材层数组从背景到前景保存，后加入或上移的层会覆盖较早的层。
 */
export function moveMapArtworkLayer(
  artwork: MapArtwork,
  layerId: string,
  direction: -1 | 1,
): MapArtwork {
  const index = artwork.layers.findIndex((layer) => layer.id === layerId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= artwork.layers.length) {
    return artwork;
  }
  const layers = [...artwork.layers];
  [layers[index], layers[targetIndex]] = [layers[targetIndex]!, layers[index]!];
  return { ...artwork, layers };
}

export function findMapArtworkStamp(
  artwork: MapArtwork,
  stampId: string,
): MapArtworkStamp | undefined {
  return artwork.layers
    .flatMap((layer) => layer.stamps)
    .find((stamp) => stamp.id === stampId);
}

export function createMapArtworkStamp(input: {
  readonly id: string;
  readonly layerId: string;
  readonly assetId: string;
  readonly x: number;
  readonly y: number;
  readonly sourceFeatureId?: string;
  readonly variant?: number;
  readonly scale?: number;
  readonly rotation?: number;
  readonly opacity?: number;
  readonly flipX?: boolean;
  readonly flipY?: boolean;
}): MapArtworkStamp {
  return {
    id: input.id,
    layerId: input.layerId,
    assetId: input.assetId,
    x: input.x,
    y: input.y,
    ...(input.sourceFeatureId
      ? { sourceFeatureId: input.sourceFeatureId }
      : {}),
    variant: input.variant ?? 0,
    scale: input.scale ?? 1,
    rotation: input.rotation ?? 0,
    opacity: input.opacity ?? 1,
    flipX: input.flipX ?? false,
    flipY: input.flipY ?? false,
  };
}

export function addMapArtworkStamp(
  artwork: MapArtwork,
  stamp: MapArtworkStamp,
): MapArtwork {
  return {
    ...artwork,
    layers: artwork.layers.map((layer) =>
      layer.id === stamp.layerId
        ? { ...layer, stamps: [...layer.stamps, stamp] }
        : layer,
    ),
  };
}

export function updateMapArtworkStamp(
  artwork: MapArtwork,
  stampId: string,
  patch: Partial<Omit<MapArtworkStamp, "id" | "layerId">>,
): MapArtwork {
  return {
    ...artwork,
    layers: artwork.layers.map((layer) => ({
      ...layer,
      stamps: layer.stamps.map((stamp) =>
        stamp.id === stampId ? { ...stamp, ...patch } : stamp,
      ),
    })),
  };
}

export function moveMapArtworkStampToLayer(
  artwork: MapArtwork,
  stampId: string,
  targetLayerId: string,
): MapArtwork {
  const sourceLayer = artwork.layers.find((layer) =>
    layer.stamps.some((stamp) => stamp.id === stampId),
  );
  const targetLayer = artwork.layers.find(
    (layer) => layer.id === targetLayerId,
  );
  if (!sourceLayer || !targetLayer || sourceLayer.id === targetLayer.id) {
    return artwork;
  }
  const stamp = sourceLayer.stamps.find((item) => item.id === stampId);
  if (!stamp) return artwork;
  return {
    ...artwork,
    layers: artwork.layers.map((layer) => {
      if (layer.id === sourceLayer.id) {
        return {
          ...layer,
          stamps: layer.stamps.filter((item) => item.id !== stampId),
        };
      }
      if (layer.id === targetLayer.id) {
        return {
          ...layer,
          stamps: [...layer.stamps, { ...stamp, layerId: targetLayer.id }],
        };
      }
      return layer;
    }),
  };
}

/**
 * 图层删除需要指定保留印章的目标层。调用方未提供可用目标时保持原文档，
 * 避免把地图上的素材作为图层管理的副作用丢掉。
 */
export function removeMapArtworkLayer(
  artwork: MapArtwork,
  layerId: string,
  targetLayerId: string,
): MapArtwork {
  if (artwork.layers.length <= 1 || layerId === targetLayerId) return artwork;
  const sourceLayer = artwork.layers.find((layer) => layer.id === layerId);
  const targetLayer = artwork.layers.find(
    (layer) => layer.id === targetLayerId,
  );
  if (!sourceLayer || !targetLayer) return artwork;
  return {
    ...artwork,
    layers: artwork.layers
      .filter((layer) => layer.id !== sourceLayer.id)
      .map((layer) =>
        layer.id === targetLayer.id
          ? {
              ...layer,
              stamps: [
                ...layer.stamps,
                ...sourceLayer.stamps.map((stamp) => ({
                  ...stamp,
                  layerId: targetLayer.id,
                })),
              ],
            }
          : layer,
      ),
  };
}

export function removeMapArtworkStamp(
  artwork: MapArtwork,
  stampId: string,
): MapArtwork {
  return {
    ...artwork,
    layers: artwork.layers.map((layer) => ({
      ...layer,
      stamps: layer.stamps.filter((stamp) => stamp.id !== stampId),
    })),
  };
}
