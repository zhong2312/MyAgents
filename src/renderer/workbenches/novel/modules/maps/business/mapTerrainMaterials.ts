import type {
  MapTerrainMaterial,
  MapTerrainMaterialSurface,
} from "../entities/mapSchema";

export interface MapTerrainMaterialPreset {
  readonly id: MapTerrainMaterial;
  readonly name: string;
  readonly color: string;
  readonly detailColor: string;
  readonly description: string;
  readonly surface: MapTerrainMaterialSurface;
  /** 素材栏中的非事实预览图案；画布成图由纹理合成器独立生成。 */
  readonly preview: string;
}

export const MAP_TERRAIN_MATERIAL_PRESETS: readonly MapTerrainMaterialPreset[] =
  Object.freeze([
    {
      id: "grassland",
      name: "草地",
      color: "#93a56f",
      detailColor: "#66794f",
      description: "温润草地与开阔平原",
      surface: "land",
      preview:
        "repeating-linear-gradient(84deg, #93a56f00 0 7px, #66794f99 8px 9px, #93a56f00 10px 17px)",
    },
    {
      id: "forest",
      name: "林地",
      color: "#667d55",
      detailColor: "#40583b",
      description: "浓密林地的深绿底色",
      surface: "land",
      preview:
        "radial-gradient(circle at 28% 66%, #40583bdd 0 5px, #667d5500 5.5px), radial-gradient(circle at 69% 36%, #40583baa 0 6px, #667d5500 6.5px)",
    },
    {
      id: "desert",
      name: "荒漠",
      color: "#c9a865",
      detailColor: "#9d7b43",
      description: "沙海、旱地与风蚀纹理",
      surface: "land",
      preview:
        "repeating-radial-gradient(ellipse at 50% 130%, #c9a86500 0 8px, #9d7b4399 9px 10px, #c9a86500 11px 17px)",
    },
    {
      id: "beach",
      name: "沙滩",
      color: "#d9c48c",
      detailColor: "#aa8d58",
      description: "海岸、河滩与风蚀沙洲",
      surface: "land",
      preview:
        "repeating-linear-gradient(8deg, #d9c48c00 0 6px, #aa8d587a 7px 8px, #d9c48c00 9px 15px)",
    },
    {
      id: "gravel-beach",
      name: "砾石滩",
      color: "#b5a68c",
      detailColor: "#776b5b",
      description: "粗砾海岸、河口砾洲与碎石滩",
      surface: "land",
      preview:
        "radial-gradient(circle at 18% 30%, #776b5b99 0 2px, #b5a68c00 2.5px), radial-gradient(circle at 66% 70%, #776b5b88 0 3px, #b5a68c00 3.5px), radial-gradient(circle at 84% 20%, #776b5b66 0 2px, #b5a68c00 2.5px)",
    },
    {
      id: "salt-flat",
      name: "盐碱地",
      color: "#d2c8a8",
      detailColor: "#9f936d",
      description: "盐沼、盐碱荒原与白色干涸湖床",
      surface: "land",
      preview:
        "repeating-linear-gradient(32deg, #d2c8a800 0 11px, #9f936d70 12px 13px, #d2c8a800 14px 24px), repeating-linear-gradient(148deg, #d2c8a800 0 16px, #ffffff77 17px 18px, #d2c8a800 19px 31px)",
    },
    {
      id: "badlands",
      name: "恶地",
      color: "#ad7658",
      detailColor: "#784b3d",
      description: "恶地（赤地）、峡谷、红土与干裂荒原",
      surface: "land",
      preview:
        "repeating-linear-gradient(143deg, #ad765800 0 7px, #784b3d9c 8px 10px, #ad765800 11px 18px)",
    },
    {
      id: "tundra",
      name: "冻土",
      color: "#989b7f",
      detailColor: "#6f7567",
      description: "低温苔原与灰绿色冻土",
      surface: "land",
      preview:
        "repeating-linear-gradient(24deg, #989b7f00 0 10px, #6f756784 11px 12px, #989b7f00 13px 19px)",
    },
    {
      id: "snow",
      name: "雪原",
      color: "#d8ddd3",
      detailColor: "#aab8b3",
      description: "高寒雪原与冰盖",
      surface: "land",
      preview:
        "repeating-linear-gradient(161deg, #d8ddd300 0 8px, #aab8b399 9px 10px, #d8ddd300 11px 18px)",
    },
    {
      id: "snow-cover",
      name: "冰雪覆盖",
      color: "#edf4f2",
      detailColor: "#9fb7bb",
      description: "山地积雪、冻原雪被与常年冰雪",
      surface: "land",
      preview:
        "repeating-linear-gradient(176deg, #edf4f200 0 9px, #9fb7bb99 10px 12px, #edf4f200 13px 23px), radial-gradient(circle at 28% 32%, #ffffffcc 0 3px, #edf4f200 4px)",
    },
    {
      id: "swamp",
      name: "沼泽",
      color: "#77805b",
      detailColor: "#4e5d48",
      description: "湿地、泥沼与浅水洼地",
      surface: "land",
      preview:
        "radial-gradient(ellipse at 29% 61%, #4e5d48aa 0 5px, #77805b00 5.5px), repeating-linear-gradient(90deg, #77805b00 0 8px, #4e5d4866 9px 10px, #77805b00 11px 17px)",
    },
    {
      id: "volcanic",
      name: "火山岩",
      color: "#6e6861",
      detailColor: "#3f3936",
      description: "熔岩台地与黑色火山岩",
      surface: "land",
      preview:
        "repeating-linear-gradient(135deg, #6e686100 0 9px, #3f3936c2 10px 11px, #6e686100 12px 19px), repeating-linear-gradient(43deg, #6e686100 0 13px, #3f393666 14px 15px, #6e686100 16px 24px)",
    },
    {
      id: "volcanic-ash",
      name: "火山灰",
      color: "#81766d",
      detailColor: "#514943",
      description: "火山灰原、黑色尘土与喷发沉积",
      surface: "land",
      preview:
        "radial-gradient(circle at 22% 31%, #51494399 0 2px, #81766d00 3px), radial-gradient(circle at 70% 62%, #514943bb 0 3px, #81766d00 4px), repeating-linear-gradient(110deg, #81766d00 0 12px, #51494355 13px 15px, #81766d00 16px 25px)",
    },
    {
      id: "lava",
      name: "熔岩地",
      color: "#6f4037",
      detailColor: "#3f2827",
      description: "流动熔岩、火山裂隙与灼热地表",
      surface: "land",
      preview:
        "repeating-linear-gradient(135deg, #6f403700 0 10px, #ed895466 11px 13px, #6f403700 14px 24px), repeating-linear-gradient(45deg, #6f403700 0 18px, #2a202055 19px 21px, #6f403700 22px 33px)",
    },
    {
      id: "karst",
      name: "喀斯特",
      color: "#9b9d83",
      detailColor: "#5d6658",
      description: "石灰岩峰林、溶洞与喀斯特洼地",
      surface: "land",
      preview:
        "radial-gradient(ellipse at 26% 58%, #5d665899 0 5px, #9b9d8300 6px), radial-gradient(ellipse at 73% 30%, #5d665877 0 7px, #9b9d8300 8px), repeating-linear-gradient(82deg, #9b9d8300 0 13px, #dce0c977 14px 16px, #9b9d8300 17px 27px)",
    },
    {
      id: "shallow-sea",
      name: "浅海",
      color: "#6fa8b2",
      detailColor: "#3e7786",
      description: "近岸浅海、陆架与清澈潮间水域",
      surface: "water",
      preview:
        "repeating-linear-gradient(8deg, #6fa8b200 0 7px, #d7f1e999 8px 10px, #6fa8b200 11px 18px)",
    },
    {
      id: "deep-sea",
      name: "深海",
      color: "#2f5e79",
      detailColor: "#1f405c",
      description: "深海盆地、暗海与远洋水域",
      surface: "water",
      preview:
        "repeating-radial-gradient(ellipse at 40% 120%, #2f5e7900 0 9px, #91c3d455 10px 12px, #2f5e7900 13px 24px), repeating-linear-gradient(164deg, #2f5e7900 0 15px, #1f405c77 16px 18px, #2f5e7900 19px 30px)",
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
