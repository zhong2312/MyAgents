import type {
  CharacterGroupDefinition,
  CharacterLibraryIndex,
  CharacterLibraryMeta,
  CharacterSoulDefinition,
  RaceDefinition,
} from "../entities/characterLibrarySchema";

export const CHARACTER_LIBRARY_SCHEMA_VERSION = 1 as const;
export const UNGROUPED_CHARACTER_GROUP_ID = "ungrouped";

const defaultRaces: readonly RaceDefinition[] = [
  {
    id: "human",
    name: "人族",
    description: "分布最广的族群，各地文化、体貌与寿命差异显著。",
  },
];

const builtInSouls: readonly CharacterSoulDefinition[] = [
  {
    id: "global-strategist",
    builtIn: true,
    name: "全局推演",
    category: "谋略与责任",
    summary: "先把局势放回全局，再在资源约束下选择可持续的解法。",
    expressionDna: "先交代条件与代价，再给出判断；语气克制、完整。",
    mentalModel: "把人物、资源、时间和后果同时放在棋盘上推演。",
    decisionHeuristics: "先算最坏结果，再分配有限资源；关键选择能对整体负责。",
    valueAntiPatterns: "不能写成全知全能；过度揽责必须产生真实代价。",
    boundaries: "只影响思考与判断倾向，不覆盖人物经历、口吻与既有设定。",
    expressionConflictKeywords: ["句子短", "极简短", "很少谈道理"],
    decisionConflictKeywords: ["冲动", "凭直觉", "两边下注"],
    valueConflictKeywords: ["只求自保"],
    amplificationKeywords: ["归咎于自己", "承担骂名", "替别人做决定"],
  },
  {
    id: "truth-seeker",
    builtIn: true,
    name: "追根究底",
    category: "求真与拆解",
    summary: "不满足于知道名词，必须亲手拆开因果，直到能够清楚解释。",
    expressionDna: "偏好具体例子、反问和现场验证，主动拆掉术语带来的权威感。",
    mentalModel: "把复杂问题还原为能验证的小问题，区分理解与只记住名称。",
    decisionHeuristics: "先做可证伪的判断，再用最小实验排除错误。",
    valueAntiPatterns: "不能把好奇写成轻浮；必须允许误判与重新验证。",
    boundaries: "只影响求证方式和表达倾向，不带入外部时代知识或真实身份。",
    expressionConflictKeywords: ["措辞完整而克制", "很少反问"],
    decisionConflictKeywords: ["只讲具体的人和伤口"],
    valueConflictKeywords: ["秘密不能永远只属于掌权者"],
    amplificationKeywords: ["无法判断", "过目不忘"],
  },
  {
    id: "sensitive-observer",
    builtIn: true,
    name: "敏感锋利",
    category: "感知与自尊",
    summary: "能读出关系中最细小的温差，以克制、机锋和自尊保护脆弱内核。",
    expressionDna: "言语含蓄而有锋芒，善用停顿、反话和细节，不直接索取理解。",
    mentalModel: "先感知关系变化，再判断事件；对被忽视和失去体面格外敏锐。",
    decisionHeuristics: "宁可承担孤独，也不接受带有施舍意味的安全。",
    valueAntiPatterns: "不能把敏感等同软弱或只会落泪。",
    boundaries: "只借用感知精度、自尊与表达锋芒，人物自身成长线和处境优先。",
    expressionConflictKeywords: ["嘴碎", "俗语", "极简短的字条"],
    decisionConflictKeywords: ["快速识别", "临场判断极快"],
    valueConflictKeywords: ["谁给饭吃"],
    amplificationKeywords: ["难以直接表达关心", "不轻易相信"],
  },
  {
    id: "nimble-protector",
    builtIn: true,
    name: "机敏守护",
    category: "机变与守护",
    summary: "先看穿对手的模式，再以巧破力；所有机敏最终服务于重要的人。",
    expressionDna: "伶俐、跳脱，善于用玩笑藏试探，把对手引入自己的节奏。",
    mentalModel: "把局面视为多步博弈，迅速识别人情、利益与行动窗口的联系。",
    decisionHeuristics:
      "先设计反制，再决定是否正面冲突；危机时优先保护重要的人。",
    valueAntiPatterns: "不能把机智写成万能；聪明必须有算漏的时候。",
    boundaries: "只借用机变、守护和表达节奏，不复制外部关系、经历与称谓。",
    expressionConflictKeywords: ["寡言", "措辞完整而克制", "很少谈道理"],
    decisionConflictKeywords: ["只相信物证", "长期隐瞒"],
    valueConflictKeywords: ["稳定高于", "多数人活下去"],
    amplificationKeywords: ["把关系换算成筹码", "欠下太多人情"],
  },
  {
    id: "rule-breaker",
    builtIn: true,
    name: "破局反叛",
    category: "行动与自由",
    summary: "对虚伪秩序保持本能警惕，先行动撕开缺口，再承担选择的后果。",
    expressionDna: "直接、鲜明、带挑衅感；不为权威修饰语气。",
    mentalModel: "先识别谁在借规则获利，再寻找规则之外的行动空间。",
    decisionHeuristics: "先打破关键限制，再在运动中寻找答案。",
    valueAntiPatterns: "不能把反叛写成无成本任性；不能跳过角色认知与剧情因果。",
    boundaries: "只借用破局倾向和自由意志，不带入外部事件、能力或标志性台词。",
    expressionConflictKeywords: ["寡言、克制", "措辞完整而克制"],
    decisionConflictKeywords: ["先观察再行动", "战略耐心"],
    valueConflictKeywords: ["秩序", "稳定"],
    amplificationKeywords: ["冲动", "危险", "无法判断"],
  },
];

const ungroupedGroup: CharacterGroupDefinition = {
  id: UNGROUPED_CHARACTER_GROUP_ID,
  name: "未分组",
  description: "尚未加入任何角色分组的角色。",
};

export function createDefaultCharacterLibraryMeta(): CharacterLibraryMeta {
  return {
    schemaVersion: CHARACTER_LIBRARY_SCHEMA_VERSION,
    races: defaultRaces.map((race) => ({ ...race })),
    groups: [],
    ungroupedGroup: { ...ungroupedGroup },
    souls: builtInSouls.map((soul) => ({
      ...soul,
      expressionConflictKeywords: [...soul.expressionConflictKeywords],
      decisionConflictKeywords: [...soul.decisionConflictKeywords],
      valueConflictKeywords: [...soul.valueConflictKeywords],
      amplificationKeywords: [...soul.amplificationKeywords],
    })),
  };
}

export function createEmptyCharacterLibraryIndex(): CharacterLibraryIndex {
  return { schemaVersion: CHARACTER_LIBRARY_SCHEMA_VERSION, characters: [] };
}
