import type { MapTerrainMaterial } from "../entities/mapSchema";

export interface MapTerrainMaterialPreset {
  readonly id: MapTerrainMaterial;
  readonly name: string;
  readonly color: string;
  readonly detailColor: string;
  readonly description: string;
  /** 素材栏中的非事实预览图案；画布成图由纹理合成器独立生成。 */
  readonly preview: string;
}

export const MAP_TERRAIN_MATERIAL_PRESETS: readonly MapTerrainMaterialPreset[] =
  Object.freeze([
    {
      id: "grassland",
      name: "草原",
      color: "#93a56f",
      detailColor: "#66794f",
      description: "温润草地与开阔平原",
      preview:
        "repeating-linear-gradient(84deg, #93a56f00 0 7px, #66794f99 8px 9px, #93a56f00 10px 17px)",
    },
    {
      id: "forest",
      name: "林地",
      color: "#667d55",
      detailColor: "#40583b",
      description: "浓密林地的深绿底色",
      preview:
        "radial-gradient(circle at 28% 66%, #40583bdd 0 5px, #667d5500 5.5px), radial-gradient(circle at 69% 36%, #40583baa 0 6px, #667d5500 6.5px)",
    },
    {
      id: "desert",
      name: "荒漠",
      color: "#c9a865",
      detailColor: "#9d7b43",
      description: "沙海、旱地与风蚀纹理",
      preview:
        "repeating-radial-gradient(ellipse at 50% 130%, #c9a86500 0 8px, #9d7b4399 9px 10px, #c9a86500 11px 17px)",
    },
    {
      id: "badlands",
      name: "赤地",
      color: "#ad7658",
      detailColor: "#784b3d",
      description: "峡谷、红土与干裂荒原",
      preview:
        "repeating-linear-gradient(143deg, #ad765800 0 7px, #784b3d9c 8px 10px, #ad765800 11px 18px)",
    },
    {
      id: "tundra",
      name: "冻土",
      color: "#989b7f",
      detailColor: "#6f7567",
      description: "低温苔原与灰绿色冻土",
      preview:
        "repeating-linear-gradient(24deg, #989b7f00 0 10px, #6f756784 11px 12px, #989b7f00 13px 19px)",
    },
    {
      id: "snow",
      name: "雪原",
      color: "#d8ddd3",
      detailColor: "#aab8b3",
      description: "高寒雪原与冰盖",
      preview:
        "repeating-linear-gradient(161deg, #d8ddd300 0 8px, #aab8b399 9px 10px, #d8ddd300 11px 18px)",
    },
    {
      id: "swamp",
      name: "沼泽",
      color: "#77805b",
      detailColor: "#4e5d48",
      description: "湿地、泥沼与浅水洼地",
      preview:
        "radial-gradient(ellipse at 29% 61%, #4e5d48aa 0 5px, #77805b00 5.5px), repeating-linear-gradient(90deg, #77805b00 0 8px, #4e5d4866 9px 10px, #77805b00 11px 17px)",
    },
    {
      id: "volcanic",
      name: "火山岩",
      color: "#6e6861",
      detailColor: "#3f3936",
      description: "熔岩台地与黑色火山岩",
      preview:
        "repeating-linear-gradient(135deg, #6e686100 0 9px, #3f3936c2 10px 11px, #6e686100 12px 19px), repeating-linear-gradient(43deg, #6e686100 0 13px, #3f393666 14px 15px, #6e686100 16px 24px)",
    },
  ]);

export function getMapTerrainMaterialPreset(
  material: MapTerrainMaterial,
): MapTerrainMaterialPreset {
  return (
    MAP_TERRAIN_MATERIAL_PRESETS.find((preset) => preset.id === material) ??
    MAP_TERRAIN_MATERIAL_PRESETS[0]!
  );
}
