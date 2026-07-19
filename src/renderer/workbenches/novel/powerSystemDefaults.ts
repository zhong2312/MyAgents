import {
  NOVEL_POWER_SYSTEM_SCHEMA_VERSION,
  type PowerDesignContract,
  type PowerDimension,
  type PowerSystemIndex,
  type PowerSystemInteractions,
  type PowerSystemMeta,
  type PowerSystemRecord,
  type PowerTruthMetadata,
} from "./powerSystemSchema";

export const POWER_SYSTEM_TYPE_PRESETS = Object.freeze([
  {
    id: "blank",
    name: "空白体系",
    description: "从顶层来源、状态和规则开始自由设计",
    icon: "circle-dashed",
    builtin: true,
  },
  {
    id: "cultivation",
    name: "修炼体系",
    description: "适合境界、功法、资源积累和突破结构",
    icon: "sparkles",
    builtin: true,
  },
  {
    id: "magic",
    name: "魔法体系",
    description: "适合法术、仪式、元素、法环和魔力资源",
    icon: "wand-sparkles",
    builtin: true,
  },
  {
    id: "technology",
    name: "科技体系",
    description: "适合装备、能源、义体、权限和技术代际",
    icon: "cpu",
    builtin: true,
  },
  {
    id: "superpower",
    name: "超能力体系",
    description: "适合觉醒、个体能力、失控和能力边界",
    icon: "zap",
    builtin: true,
  },
  {
    id: "lineage",
    name: "血脉与变身",
    description: "适合血统、形态、进化、返祖和副作用",
    icon: "dna",
    builtin: true,
  },
  {
    id: "divine-contract",
    name: "神权与契约",
    description: "适合神授、信仰、誓约、名分和授权",
    icon: "scroll-text",
    builtin: true,
  },
  {
    id: "soft-system",
    name: "软体系",
    description: "适合刻意保留未知、无固定等级的神秘力量",
    icon: "cloud-fog",
    builtin: true,
  },
] satisfies PowerSystemMeta["systemTypes"]);

export function createDefaultPowerTruthMetadata(): PowerTruthMetadata {
  return {
    settingLevel: "",
    domainCategories: [],
    spatialScopeIds: [],
    timeScope: { from: "", to: "" },
    authority: "default",
    canon: "draft",
    revealStage: "",
    sourceRefs: [],
  };
}

export function createDefaultDesignContract(
  typeId: string,
): PowerDesignContract {
  if (typeId === "soft-system") {
    return {
      explanation: "mysterious",
      quantification: "descriptive",
      progression: "none",
      costPolicy: "optional",
      comparison: "incomparable",
      exceptionPolicy: "mythic",
    };
  }
  if (typeId === "superpower" || typeId === "lineage") {
    return {
      explanation: "partial",
      quantification: "mixed",
      progression: "event-driven",
      costPolicy: "recommended",
      comparison: "contextual",
      exceptionPolicy: "limited",
    };
  }
  return {
    explanation: "explicit",
    quantification: "mixed",
    progression: typeId === "blank" ? "none" : "multi-track",
    costPolicy: "recommended",
    comparison: "contextual",
    exceptionPolicy: "limited",
  };
}

export function createDefaultPowerDimensions(): PowerDimension[] {
  return [
    ["output", "输出"],
    ["defense", "防御"],
    ["control", "控制"],
    ["mobility", "机动"],
    ["endurance", "续航"],
    ["perception", "感知"],
    ["range", "作用范围"],
  ].map(([id, name]) => ({
    id,
    name,
    measurement: "numeric" as const,
    unit: "",
    lowLabel: "低",
    highLabel: "高",
    description: "",
  }));
}

export function createDefaultPowerSystemMeta(): PowerSystemMeta {
  return {
    schemaVersion: NOVEL_POWER_SYSTEM_SCHEMA_VERSION,
    systemTypes: POWER_SYSTEM_TYPE_PRESETS.map((item) => ({ ...item })),
  };
}

export function createEmptyPowerSystemIndex(): PowerSystemIndex {
  return { schemaVersion: NOVEL_POWER_SYSTEM_SCHEMA_VERSION, systems: [] };
}

export function createEmptyPowerSystemInteractions(): PowerSystemInteractions {
  return { schemaVersion: NOVEL_POWER_SYSTEM_SCHEMA_VERSION, interactions: [] };
}

export function createPowerSystemRecord(input: {
  readonly id: string;
  readonly name: string;
  readonly typeId: string;
}): PowerSystemRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: NOVEL_POWER_SYSTEM_SCHEMA_VERSION,
    id: input.id,
    name: input.name.trim(),
    aliases: [],
    typeId: input.typeId,
    status: "draft",
    summary: "",
    designContract: createDefaultDesignContract(input.typeId),
    elements: [],
    tracks: [],
    rules: [],
    relations: [],
    dimensions: createDefaultPowerDimensions(),
    benchmarks: [],
    metadata: createDefaultPowerTruthMetadata(),
    createdAt: now,
    updatedAt: now,
  };
}
