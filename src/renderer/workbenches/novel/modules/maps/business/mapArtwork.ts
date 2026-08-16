import {
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
  volcano: "△",
  canyon: "⌁",
  forest: "♣",
  "pine-grove": "♠",
  deadwood: "♧",
  jungle: "♣",
  wetland: "∿",
  grassland: "·",
  river: "〰",
  lake: "◌",
  waterfall: "≋",
  "ocean-current": "〰",
  city: "●",
  village: "•",
  port: "⚓",
  watchtower: "▥",
  bridge: "⌒",
  capital: "◆",
  fortress: "▣",
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
  let body = `<circle cx="64" cy="64" r="28" ${common}/>`;

  switch (id) {
    case "star":
      body = `<path d="M64 8 76 47l41 1-33 24 11 40-31-23-31 23 11-40L11 48l41-1Z" ${common}/><circle cx="64" cy="64" r="13" fill="#fff6c7" stroke="none"/>`;
      break;
    case "planet":
      body = `<circle cx="64" cy="64" r="39" ${common}/><path d="M30 49c18 8 40 10 68-1M32 76c16-5 38-5 63 4" fill="none" stroke="#ffffff80" stroke-width="6"/>`;
      break;
    case "ringed-planet":
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
    case "portal":
      body = `<ellipse cx="64" cy="64" rx="39" ry="52" fill="${background}" ${common}/><ellipse cx="64" cy="64" rx="22" ry="36" fill="${fill}" stroke="${stroke}" stroke-width="4"/><path d="M44 28 35 14M84 28l10-14M38 101l-10 14M90 101l10 14" ${common}/>`;
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
    case "grassland":
      width = 170;
      height = 110;
      body = `<path d="M12 85c29-37 54 9 77-20 22-28 45 8 69-21l-9 45H24Z" ${common}/><path d="M33 89V63M51 91V54M118 83V52M139 86V63" stroke="#f4efbb" stroke-width="4"/>`;
      break;
    case "river":
      width = 190;
      height = 120;
      body = `<path d="M16 12c58 20 31 42 86 52 41 7 42 26 72 43" fill="none" stroke="${stroke}" stroke-width="14"/><path d="M16 12c58 20 31 42 86 52 41 7 42 26 72 43" fill="none" stroke="${fill}" stroke-width="7"/>`;
      break;
    case "lake":
      body = `<path d="M15 62c0-26 29-43 52-31 24-20 62-4 65 25 25 13 11 51-17 54H53c-23 0-38-21-38-48Z" ${common}/><path d="M44 60c15-8 34-8 52 0" fill="none" stroke="#d8f4f580" stroke-width="5"/>`;
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

const BRUSH_ASSET_IDS = new Set([
  "archipelago",
  "mountain-range",
  "snow-peak",
  "foothills",
  "forest",
  "pine-grove",
  "deadwood",
  "jungle",
  "wetland",
  "grassland",
]);

const ARTWORK_VARIANT_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  archipelago: 3,
  "mountain-range": 4,
  "snow-peak": 3,
  foothills: 3,
  mesa: 3,
  volcano: 3,
  forest: 4,
  "pine-grove": 3,
  deadwood: 3,
  jungle: 4,
  wetland: 3,
  grassland: 3,
  city: 3,
  capital: 3,
  village: 3,
  fortress: 3,
  cave: 2,
  ruins: 2,
});

export const MAP_ARTWORK_STAMP_ASSETS: readonly MapArtworkStampAsset[] =
  Object.freeze(
    MAP_COMPONENT_PRESETS.map((component) => {
      const color = component.props.color ?? "#8b6b4a";
      const variants = Array.from(
        { length: ARTWORK_VARIANT_COUNTS[component.id] ?? 1 },
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
        brush: BRUSH_ASSET_IDS.has(component.id),
        brushFollowsPath: component.id === "mountain-range",
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
