import {
  NOVEL_POWER_SYSTEM_SCHEMA_VERSION,
  type PowerCatalog,
  type PowerCognitiveModel,
  type PowerConditionGroup,
  type PowerConnections,
  type PowerDesignContract,
  type PowerMetricDimension,
  type PowerStateContract,
  type PowerSystemIndex,
  type PowerSystemMeta,
  type PowerSystemRecord,
  type PowerTruthMetadata,
} from "./powerSystemSchema";

export const POWER_SYSTEM_TYPE_PRESETS = Object.freeze([
  {
    id: "blank",
    name: "空白体系",
    description: "不预设成长、资源或能力结构",
    icon: "circle-dashed",
    builtin: true,
  },
  {
    id: "cultivation",
    name: "修炼体系",
    description: "适合功法、境界、资源、突破与质量差异",
    icon: "sparkles",
    builtin: true,
  },
  {
    id: "magic",
    name: "魔法体系",
    description: "适合魔力介质、咒式理论、法术与施法边界",
    icon: "wand-sparkles",
    builtin: true,
  },
  {
    id: "superpower",
    name: "异能体系",
    description: "适合觉醒、控制阶段、能力表达与失控风险",
    icon: "zap",
    builtin: true,
  },
  {
    id: "martial",
    name: "武道体系",
    description: "适合身体训练、劲力介质、技法与体能边界",
    icon: "swords",
    builtin: true,
  },
  {
    id: "technology",
    name: "科技改造",
    description: "适合装备、能源、义体、协议与技术代际",
    icon: "cpu",
    builtin: true,
  },
  {
    id: "lineage",
    name: "血脉与形态",
    description: "适合激活、返祖、变身、进化和副作用",
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
    name: "软力量体系",
    description: "允许理论、边界与成长保持部分未知",
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

export function createEmptyConditionGroup(): PowerConditionGroup {
  return { mode: "all", clauses: [] };
}

export function createDefaultCognitiveModel(): PowerCognitiveModel {
  return {
    representationType: "unknown",
    description: "",
    memoryLoad: "unknown",
    parallelism: "unknown",
    abstraction: "unknown",
    dynamism: "unknown",
    spatialDimensions: null,
    requiredSkills: [],
    breakthroughInsight: "",
  };
}

export function createDefaultStateContract(): PowerStateContract {
  return {
    entryConditions: createEmptyConditionGroup(),
    maintenanceConditions: createEmptyConditionGroup(),
    exitConditions: createEmptyConditionGroup(),
    baseQualities: [],
    baseBoundaries: [],
    cognition: createDefaultCognitiveModel(),
    stability: "",
    risks: [],
  };
}

export function createDefaultDesignContract(
  typeId: string,
): PowerDesignContract {
  if (typeId === "soft-system") {
    return {
      explanation: "mysterious",
      progression: "none",
      costPolicy: "optional",
      comparison: "incomparable",
      theoryPolicy: "unknown",
    };
  }
  if (typeId === "superpower" || typeId === "lineage") {
    return {
      explanation: "partial",
      progression: "event-driven",
      costPolicy: "recommended",
      comparison: "contextual",
      theoryPolicy: "partial",
    };
  }
  return {
    explanation: "explicit",
    progression: typeId === "blank" ? "none" : "multi-track",
    costPolicy: "recommended",
    comparison: "contextual",
    theoryPolicy: "explicit",
  };
}

export function createDefaultPowerDimensions(): PowerMetricDimension[] {
  return [
    {
      id: "quality-stability",
      name: "稳定性",
      category: "quality" as const,
      lowLabel: "脆弱",
      highLabel: "稳定",
    },
    {
      id: "quality-control",
      name: "控制精度",
      category: "quality" as const,
      lowLabel: "粗放",
      highLabel: "精密",
    },
    {
      id: "boundary-capacity",
      name: "储量上限",
      category: "boundary" as const,
      lowLabel: "有限",
      highLabel: "庞大",
    },
    {
      id: "boundary-throughput",
      name: "瞬时吞吐",
      category: "boundary" as const,
      lowLabel: "缓慢",
      highLabel: "爆发",
    },
  ].map((dimension) => ({
    ...dimension,
    measurement: "descriptive" as const,
    unit: "",
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

export function createEmptyPowerCatalog(): PowerCatalog {
  return {
    schemaVersion: NOVEL_POWER_SYSTEM_SCHEMA_VERSION,
    foundations: [],
    mediums: [],
    principles: [],
    resources: [],
    theories: [],
    methods: [],
    capabilities: [],
  };
}

export function createEmptyPowerConnections(): PowerConnections {
  return {
    schemaVersion: NOVEL_POWER_SYSTEM_SCHEMA_VERSION,
    connections: [],
  };
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
    tracks: [],
    dimensions: createDefaultPowerDimensions(),
    metadata: createDefaultPowerTruthMetadata(),
    createdAt: now,
    updatedAt: now,
  };
}
