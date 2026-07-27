import {
  Archive,
  ArrowRight,
  Brain,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Dna,
  Edit3,
  Fingerprint,
  Folder,
  GitBranch,
  HeartHandshake,
  Link2,
  Loader2,
  LocateFixed,
  Minus,
  Network,
  Package,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Unlink,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { drag } from "d3-drag";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  CustomSelect,
  OverlayBackdrop,
  Popover,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import {
  cultivationEcologySchema,
  type CultivationEcology,
} from "../../../shared/workbenches/novel/cultivationEcologySchema";

import {
  createNovelCharacterLibraryRepository,
  type LoadedCharacterLibrary,
} from "./characterLibraryRepository";
import type { CharacterLibraryMeta } from "./characterLibrarySchema";
import CharacterProposalReview from "./CharacterProposalReview";
import { createNovelItemLibraryRepository } from "./itemLibraryRepository";
import type { ItemIndexEntry } from "./itemLibrarySchema";

type RoleWeight = "main" | "secondary" | "npc" | "extra";
type DetailTab =
  | "profile"
  | "cultivation"
  | "inventory"
  | "soul"
  | "arc"
  | "relations"
  | "appearances";
type LibraryView = "characters" | "network" | "souls";
type SoulConflictSeverity = "conflict" | "tension" | "amplification";

interface CharacterRelation {
  readonly targetId: string;
  readonly type: string;
  readonly tone: "positive" | "negative" | "neutral";
  readonly summary: string;
}

interface CharacterAppearance {
  readonly chapter: string;
  readonly title: string;
  readonly event: string;
  readonly state: string;
}

interface CharacterInventoryItem {
  readonly id: string;
  itemId: string | null;
  name: string;
  quantity: number;
  unit: string;
  description: string;
}

interface CharacterCultivationProfile {
  systemId: string | null;
  trackId: string | null;
  levelId: string | null;
  methodIds: string[];
  abilityIds: string[];
  resourceBalances: Record<string, { quantity: number; quality: string }>;
  activeConstraintIds: string[];
  breakthroughHistory: {
    transitionId: string;
    occurredAt: string;
    result: string;
    consequence: string;
  }[];
}

const EMPTY_CULTIVATION_PROFILE: CharacterCultivationProfile = {
  systemId: null,
  trackId: null,
  levelId: null,
  methodIds: [],
  abilityIds: [],
  resourceBalances: {},
  activeConstraintIds: [],
  breakthroughHistory: [],
};

function ensureCharacterCultivationProfile(
  character: CharacterRecord,
): CharacterRecord & { cultivationProfile: CharacterCultivationProfile } {
  return {
    ...character,
    cultivationProfile: character.cultivationProfile ?? {
      ...EMPTY_CULTIVATION_PROFILE,
      methodIds: [],
      abilityIds: [],
      activeConstraintIds: [],
      breakthroughHistory: [],
      resourceBalances: {},
    },
  };
}

interface CharacterRecord {
  readonly id: string;
  name: string;
  alias: string;
  roleWeight: RoleWeight;
  archetype: string;
  alignment: string;
  status: string;
  summary: string;
  identities: string[];
  age: string;
  currentRealm: string;
  realmProgressNodes: string[];
  baseLifespan: string;
  lifespanLoss: string;
  spiritRoot: string;
  daoBody: string;
  cultivationMethod: string;
  cultivationProfile?: CharacterCultivationProfile;
  gender: string;
  raceId: string;
  soulId: string;
  groupIds: string[];
  hometown: string;
  appearance: string;
  personality: string;
  values: string;
  strengths: string;
  weaknesses: string;
  fears: string;
  motivation: string;
  goals: string;
  innerConflict: string;
  background: string;
  abilities: string;
  speechStyle: string;
  habits: string;
  signatureItem: string;
  storyRole: string;
  arc: string;
  firstAppearance: string;
  completeness: number;
  relations: CharacterRelation[];
  appearances: CharacterAppearance[];
  inventory: CharacterInventoryItem[];
  arcStages: {
    readonly id?: string;
    title: string;
    state: string;
    detail: string;
    complete: boolean;
  }[];
}

interface RaceDefinition {
  readonly id: string;
  name: string;
  description: string;
}

interface CharacterSoulDefinition {
  readonly id: string;
  readonly builtIn: boolean;
  name: string;
  category: string;
  summary: string;
  expressionDna: string;
  mentalModel: string;
  decisionHeuristics: string;
  valueAntiPatterns: string;
  boundaries: string;
  expressionConflictKeywords: string[];
  decisionConflictKeywords: string[];
  valueConflictKeywords: string[];
  amplificationKeywords: string[];
}

interface SoulConflictFinding {
  readonly severity: SoulConflictSeverity;
  readonly title: string;
  readonly characterField: string;
  readonly characterEvidence: string;
  readonly soulTendency: string;
  readonly resolution: string;
}

interface SoulCompatibilityAnalysis {
  readonly score: number;
  readonly label: string;
  readonly findings: SoulConflictFinding[];
}

type CharacterSoulFormValue = Pick<
  CharacterSoulDefinition,
  | "name"
  | "category"
  | "summary"
  | "expressionDna"
  | "mentalModel"
  | "decisionHeuristics"
  | "valueAntiPatterns"
  | "boundaries"
>;

interface CharacterGroupDefinition {
  readonly id: string;
  name: string;
  description: string;
}

type GroupEditorState =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly groupId: string };

type RaceEditorState =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly raceId: string };

type SoulEditorState =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly soulId: string };

type CharacterChangeHandler = (patch: Partial<CharacterRecord>) => void;

interface RelationGraphNode extends SimulationNodeDatum {
  readonly id: string;
  readonly name: string;
  readonly archetype: string;
  readonly central: boolean;
}

interface RelationGraphLink extends SimulationLinkDatum<RelationGraphNode> {
  readonly type: string;
  readonly tone: CharacterRelation["tone"];
}

interface CharacterLibraryPrototypeProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
  readonly onOpenAiAgent?: (target: CharacterAiTarget) => Promise<void>;
  readonly isAiAgentLaunching?: boolean;
  readonly proposalReviewOpen?: boolean;
  readonly onOpenProposalReview?: () => void;
  readonly onCloseProposalReview?: () => void;
}

export type CharacterAiScope =
  | "character"
  | "relationship"
  | "soul"
  | "race"
  | "group";

export interface CharacterAiTarget {
  readonly scope: CharacterAiScope;
  readonly requirements: string;
  readonly targetCharacterId?: string;
}

const ROLE_LABELS: Readonly<Record<RoleWeight, string>> = {
  main: "主要角色",
  secondary: "次要角色",
  npc: "NPC",
  extra: "路人",
};

const ROLE_FILTERS: readonly {
  readonly id: "all" | RoleWeight;
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  { id: "all", label: "全部戏份", icon: Users },
  { id: "main", label: "主要角色", icon: CircleDot },
  { id: "secondary", label: "次要角色", icon: UserRound },
  { id: "npc", label: "NPC", icon: Shield },
  { id: "extra", label: "路人", icon: BookOpen },
];

const ALIGNMENT_OPTIONS = [
  "守序善良",
  "中立善良",
  "混乱善良",
  "守序中立",
  "绝对中立",
  "混乱中立",
  "守序邪恶",
  "中立邪恶",
  "混乱邪恶",
] as const;

const _INITIAL_RACES: RaceDefinition[] = [
  {
    id: "human",
    name: "人族",
    description: "分布最广的族群，各地文化、体貌与寿命差异显著。",
  },
  {
    id: "spirit-blooded",
    name: "灵裔",
    description: "血脉中保留灵性印记，通常能感知常人难以察觉的气息。",
  },
  {
    id: "yao",
    name: "妖族",
    description: "由山川草木与飞禽走兽化生，族群形态和习俗各不相同。",
  },
  {
    id: "dragon-blooded",
    name: "龙裔",
    description: "继承古龙血脉，体魄、寿命与元素亲和远超常人。",
  },
  {
    id: "merfolk",
    name: "鲛人",
    description: "世居沿海与深水城邦，擅长水下行动和潮汐术法。",
  },
  {
    id: "winged",
    name: "羽民",
    description: "生有羽翼的高原族群，以迁徙航线维系各支部族。",
  },
  {
    id: "stoneborn",
    name: "石灵",
    description: "从矿脉与山岩中孕生，拥有漫长寿命和坚韧躯体。",
  },
  {
    id: "moonfolk",
    name: "月民",
    description: "依循月相生活的古老族群，重视记忆、誓约与观星传统。",
  },
  {
    id: "nightfolk",
    name: "夜族",
    description: "适应暗夜环境的族群，感官敏锐，畏惧强烈日光。",
  },
  {
    id: "wood-spirit",
    name: "森灵",
    description: "与古木共生的森林族群，以年轮记录家族与历史。",
  },
  {
    id: "tideborn",
    name: "潮裔",
    description: "诞生于潮汐灵脉，情绪和力量会随海潮周期变化。",
  },
  {
    id: "fireborn",
    name: "炎裔",
    description: "生活在火山与熔谷地区，对高温和火焰具有天然耐受。",
  },
];

const _INITIAL_CHARACTER_SOULS: CharacterSoulDefinition[] = [
  {
    id: "global-strategist",
    builtIn: true,
    name: "诸葛亮式 · 全局推演",
    category: "谋略与责任",
    summary: "先把局势放回全局，再在资源约束下选择可持续的解法。",
    expressionDna:
      "先交代条件与代价，再给出判断；语气克制、完整，很少只凭情绪下结论。",
    mentalModel:
      "把人物、资源、时间和后果同时放在棋盘上推演，优先寻找能长期维持的结构。",
    decisionHeuristics:
      "先算最坏结果，再分配有限资源；关键选择必须能对整体负责，而非只赢眼前一局。",
    valueAntiPatterns:
      "不能写成全知全能，也不能让责任感抹去私人欲望；过度揽责必须产生真实代价。",
    boundaries:
      "只借用全局思考与责任倾向，不移植原型经历、时代使命、口头禅或历史成就。",
    expressionConflictKeywords: ["句子短", "极简短", "很少谈道理"],
    decisionConflictKeywords: ["冲动", "凭直觉", "两边下注"],
    valueConflictKeywords: ["只求自保", "规矩不能让活人饿死"],
    amplificationKeywords: ["归咎于自己", "承担骂名", "替别人做决定"],
  },
  {
    id: "truth-seeker",
    builtIn: true,
    name: "费曼式 · 追根究底",
    category: "求真与拆解",
    summary: "不满足于知道名词，必须亲手拆开因果，直到能够清楚解释。",
    expressionDna: "偏好具体例子、反问和现场验证，主动拆掉术语带来的权威感。",
    mentalModel: "把复杂问题还原为能验证的小问题，区分真正理解与只是记住名称。",
    decisionHeuristics:
      "先做可证伪的判断，再用最小实验排除错误；事实优先于身份与面子。",
    valueAntiPatterns:
      "不能把好奇写成轻浮，也不能让聪明成为无所不知；必须允许误判与重新验证。",
    boundaries:
      "只影响求证方式和表达倾向，不带入现代科学经历、真实身份或时代知识。",
    expressionConflictKeywords: ["措辞完整而克制", "拒绝时常用", "很少反问"],
    decisionConflictKeywords: ["只讲具体的人和伤口"],
    valueConflictKeywords: ["秘密不能永远只属于掌权者"],
    amplificationKeywords: ["无法判断", "过目不忘"],
  },
  {
    id: "sensitive-observer",
    builtIn: true,
    name: "林黛玉式 · 敏感锋利",
    category: "感知与自尊",
    summary: "能读出关系中最细小的温差，以克制、机锋和自尊保护脆弱内核。",
    expressionDna: "言语含蓄而有锋芒，善用停顿、反话和细节，不直接索取理解。",
    mentalModel:
      "先感知关系变化，再判断事件；对被忽视、被替代和失去体面格外敏锐。",
    decisionHeuristics:
      "宁可承担孤独，也不接受带有施舍意味的安全；重要选择首先守住尊严。",
    valueAntiPatterns:
      "不能把敏感等同软弱或只会落泪，也不能照搬原作悲剧和具体关系。",
    boundaries:
      "只借用感知精度、自尊与表达锋芒，人物自身成长线和现实处境优先。",
    expressionConflictKeywords: ["嘴碎", "俗语", "极简短的字条"],
    decisionConflictKeywords: ["快速识别", "临场判断极快"],
    valueConflictKeywords: ["谁给饭吃"],
    amplificationKeywords: ["难以直接表达关心", "不轻易相信", "残酷的沉默"],
  },
  {
    id: "nimble-protector",
    builtIn: true,
    name: "黄蓉式 · 机敏守护",
    category: "机变与守护",
    summary: "先看穿对手的模式，再以巧破力；所有机敏最终服务于重要的人。",
    expressionDna:
      "伶俐、跳脱，善于用玩笑藏试探，用轻巧语气把对手引入自己的节奏。",
    mentalModel: "把局面视为多步博弈，迅速识别人情、利益与行动窗口之间的联系。",
    decisionHeuristics:
      "先设计反制，再决定是否正面冲突；遇到真正危机时优先保护身后的人。",
    valueAntiPatterns:
      "不能把机智写成万能，也不能让算计失去情感动机；聪明必须有算漏的时候。",
    boundaries:
      "只借用机变、守护和表达节奏，不复制原作关系、武学、经历与称谓。",
    expressionConflictKeywords: ["寡言", "措辞完整而克制", "很少谈道理"],
    decisionConflictKeywords: ["只相信物证", "长期隐瞒"],
    valueConflictKeywords: ["稳定高于", "多数人活下去"],
    amplificationKeywords: ["把关系换算成筹码", "欠下太多人情"],
  },
  {
    id: "rule-breaker",
    builtIn: true,
    name: "孙悟空式 · 破局反叛",
    category: "行动与自由",
    summary: "对虚伪秩序保持本能警惕，先行动撕开缺口，再承担选择的后果。",
    expressionDna:
      "直接、鲜明、带挑衅感；不为权威修饰语气，情绪与行动常同时发生。",
    mentalModel: "先识别谁在借规则获利，再寻找规则之外的行动空间。",
    decisionHeuristics:
      "被动等待只会让局面收紧；先打破关键限制，再在运动中寻找答案。",
    valueAntiPatterns:
      "不能把反叛写成无成本任性，也不能让强行动力跳过角色认知与剧情因果。",
    boundaries:
      "只借用破局倾向和自由意志，不带入神话能力、原作事件或标志性台词。",
    expressionConflictKeywords: ["寡言、克制", "措辞完整而克制", "面容温和"],
    decisionConflictKeywords: ["先观察再行动", "战略耐心", "维持的脆弱平衡"],
    valueConflictKeywords: ["秩序", "稳定"],
    amplificationKeywords: ["冲动", "危险", "无法判断"],
  },
  {
    id: "knowing-doing",
    builtIn: true,
    name: "王阳明式 · 知行合一",
    category: "自省与行动",
    summary: "判断必须落实为行动，真正的答案来自承担之后仍能自我校正。",
    expressionDna:
      "语气平实坚定，少做空泛议论，常把问题拉回当事人此刻能做什么。",
    mentalModel: "外部困局与内在选择同时存在；先辨清动机，再用行动验证判断。",
    decisionHeuristics:
      "不能把知道与做到分开；在信息不完整时，选择当前最应承担的一步。",
    valueAntiPatterns:
      "不能写成万能心灵鸡汤，也不能用自省消解真实制度、资源和暴力问题。",
    boundaries:
      "只借用知行关系与自省方式，不移植历史身份、学说名句或具体生平。",
    expressionConflictKeywords: ["玩笑", "俗语", "巧舌"],
    decisionConflictKeywords: ["两边下注", "拒绝让任何人卷入"],
    valueConflictKeywords: ["只属于掌权者"],
    amplificationKeywords: ["归咎于自己", "无法真正离开", "固执"],
  },
  {
    id: "northern-watch",
    builtIn: false,
    name: "北境守夜人",
    category: "项目自定义",
    summary: "在漫长失守经验中形成的谨慎守望：不抢功，但绝不让风险无人承担。",
    expressionDna: "句子短，先报事实再报判断；承诺只说一次，说出口就必须兑现。",
    mentalModel:
      "任何安全都来自有人持续守住薄弱处，优先观察缺口、补给和撤退路线。",
    decisionHeuristics:
      "先保全普通人和退路，再争取胜利；无法两全时，由下令者承担留下的代价。",
    valueAntiPatterns:
      "不能把谨慎写成畏缩，不能让牺牲成为廉价口号，也不能永远独自承担。",
    boundaries:
      "服从当前人物小传、章节状态与角色认知；不自动赋予北境经历或军旅身份。",
    expressionConflictKeywords: ["嘴碎", "措辞完整", "反话"],
    decisionConflictKeywords: ["先打破", "冲动", "两边下注"],
    valueConflictKeywords: ["只求自保", "谁给饭吃"],
    amplificationKeywords: ["不愿求助", "承担骂名", "替别人做决定"],
  },
];

const _INITIAL_GROUPS: CharacterGroupDefinition[] = [
  {
    id: "core-cast",
    name: "核心人物",
    description: "直接推动主线、承担主要矛盾的核心角色。",
  },
  {
    id: "northern-line",
    name: "北境线",
    description: "与北境兵变、玄甲军旧案相关的角色。",
  },
  {
    id: "capital-line",
    name: "京城线",
    description: "活跃于京城权力与情报网络中的角色。",
  },
  {
    id: "river-line",
    name: "三江线",
    description: "与三江码头、漕运和江湖势力相关的角色。",
  },
];

const UNGROUPED_FILTER = "ungrouped";

const _INITIAL_UNGROUPED_GROUP: CharacterGroupDefinition = {
  id: UNGROUPED_FILTER,
  name: "未分组",
  description: "尚未加入任何角色分组的角色。",
};

function createLibraryId(prefix: string): string {
  const token = globalThis.crypto?.randomUUID?.().slice(0, 12);
  return `${prefix}-${token ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`}`;
}

const _SAMPLE_CHARACTERS: CharacterRecord[] = [
  {
    id: "lu-chenzhou",
    name: "陆沉舟",
    alias: "听潮枪",
    roleWeight: "main",
    archetype: "主角",
    alignment: "守序中立",
    status: "活跃",
    summary: "旧朝遗孤，以一杆残枪追查北境兵变的真相。",
    identities: ["临川镖局挂名镖师", "前玄甲军校尉"],
    age: "二十七岁",
    currentRealm: "",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    gender: "男",
    raceId: "human",
    soulId: "global-strategist",
    groupIds: ["core-cast", "northern-line"],
    hometown: "北境",
    appearance: "身形修长，左眉有一道淡疤；常穿洗旧的玄色短袍。",
    personality: "寡言、克制，习惯先观察再行动；对弱者有近乎固执的保护欲。",
    values: "秩序只有在保护普通人时才值得遵守。",
    strengths: "临场判断极快，能从细节中复原战场经过。",
    weaknesses: "不愿求助，把所有损失都归咎于自己的决定。",
    fears: "再次因迟疑失去同袍，也害怕真相证明父亲确实参与叛乱。",
    motivation: "为玄甲军洗清污名，并找到兵变当夜失踪的妹妹。",
    goals: "短期进入京城军档库；长期重建一支不受门阀控制的边军。",
    innerConflict: "越接近真相，越必须在家族清白与天下稳定之间做选择。",
    background: "景曜三十七年北境兵变后被镖局收留，十年间从未停止追查旧案。",
    abilities: "陆家枪术、战场测绘、军械辨识；内息受旧伤限制，不能久战。",
    speechStyle: "句子短，很少反问；真正愤怒时反而会称呼对方全名。",
    habits: "思考时用拇指摩挲枪尾的铜环。",
    signatureItem: "断成两截后重新接合的乌木长枪“照夜”",
    inventory: [],
    storyRole: "承担调查主线，也是旧秩序与新选择之间的承压点。",
    arc: "从独自背负旧案，到承认真相无法由一个人定义，并主动建立新的同盟。",
    firstAppearance: "第 1 章 · 雨夜停棺",
    completeness: 86,
    relations: [
      {
        targetId: "xie-wantang",
        type: "同盟",
        tone: "positive",
        summary: "互相利用起步，在一次次交付后建立有限而牢固的信任。",
      },
      {
        targetId: "ning-buyi",
        type: "宿敌",
        tone: "negative",
        summary: "两人都要查清旧案，却对真相应该服务谁有根本分歧。",
      },
      {
        targetId: "wen-hesheng",
        type: "旧部",
        tone: "neutral",
        summary: "闻鹤生知道陆家旧事，但始终隐瞒兵变当夜的一段军令。",
      },
    ],
    appearances: [
      {
        chapter: "01",
        title: "雨夜停棺",
        event: "护送无名棺木入临川，发现玄甲军旧制箭簇。",
        state: "警觉",
      },
      {
        chapter: "07",
        title: "档案中的死人",
        event: "第一次与谢晚棠交换情报，得知妹妹可能仍在人世。",
        state: "动摇",
      },
      {
        chapter: "18",
        title: "照夜出匣",
        event: "为救旧部公开身份，从幕后调查转入明面对抗。",
        state: "决绝",
      },
    ],
    arcStages: [
      {
        title: "独行者",
        state: "已完成",
        detail: "只相信物证与自己的判断，拒绝让任何人卷入旧案。",
        complete: true,
      },
      {
        title: "有限同盟",
        state: "进行中",
        detail: "与谢晚棠交换筹码，却仍为每个伙伴预留退路。",
        complete: false,
      },
      {
        title: "真相代价",
        state: "待展开",
        detail: "发现父亲主动承担叛名，以掩护一场更大的撤退。",
        complete: false,
      },
      {
        title: "重建秩序",
        state: "待展开",
        detail: "不再为陆家翻案，而是公开全部证据并承担后果。",
        complete: false,
      },
    ],
  },
  {
    id: "xie-wantang",
    name: "谢晚棠",
    alias: "司夜主簿",
    roleWeight: "main",
    archetype: "盟友",
    alignment: "守序善良",
    status: "活跃",
    summary: "司夜台最年轻的主簿，把情报当作可以精确计算的债。",
    identities: ["司夜台主簿", "谢氏旁支"],
    age: "二十四岁",
    currentRealm: "",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    gender: "女",
    raceId: "human",
    soulId: "truth-seeker",
    groupIds: ["core-cast", "capital-line"],
    hometown: "京畿",
    appearance: "总是一身靛青官服，发间只簪一枚素银叶。",
    personality: "冷静、敏锐，擅长把情绪藏进礼数；私下有很轻的好胜心。",
    values: "制度可以不完美，但秘密不能永远只属于掌权者。",
    strengths: "记忆力惊人，能快速识别情报链中的缺口。",
    weaknesses: "习惯把关系换算成筹码，难以直接表达关心。",
    fears: "成为家族向上攀爬时可以随时舍弃的一枚棋子。",
    motivation: "拿到足以让司夜台脱离门阀控制的证据。",
    goals: "查明军档删改源头，并保住司夜台内部的线人。",
    innerConflict: "她需要陆沉舟相信自己，却不能交出全部底牌。",
    background: "从谢氏档房一步步进入司夜台，见过太多被重新书写的历史。",
    abilities: "情报分析、文书鉴伪、短刃防身。",
    speechStyle: "措辞完整而克制，拒绝时常用“恐怕不合规矩”。",
    habits: "听到谎言时会把纸页边角压平。",
    signatureItem: "记录私人债务与承诺的黑皮簿",
    inventory: [],
    storyRole: "情报入口、制度视角，也是主角学习信任的主要对象。",
    arc: "从相信信息足以控制局面，到愿意为无法量化的人承担风险。",
    firstAppearance: "第 3 章 · 司夜来客",
    completeness: 78,
    relations: [
      {
        targetId: "lu-chenzhou",
        type: "同盟",
        tone: "positive",
        summary: "从交易关系逐步转向共同承担风险。",
      },
      {
        targetId: "gu-changan",
        type: "表亲",
        tone: "neutral",
        summary: "家族关系亲近，政治立场逐渐分离。",
      },
    ],
    appearances: [
      {
        chapter: "03",
        title: "司夜来客",
        event: "以查禁军械为名试探陆沉舟。",
        state: "审视",
      },
      {
        chapter: "12",
        title: "纸上旧痕",
        event: "发现档案删改笔迹来自谢氏内部。",
        state: "失衡",
      },
    ],
    arcStages: [
      {
        title: "精确交易",
        state: "已完成",
        detail: "相信所有关系都可以用信息和承诺结算。",
        complete: true,
      },
      {
        title: "不可计量",
        state: "进行中",
        detail: "第一次为保护线人提交不完整的官方记录。",
        complete: false,
      },
      {
        title: "公开选择",
        state: "待展开",
        detail: "在家族与司夜台之间做出无法撤回的选择。",
        complete: false,
      },
    ],
  },
  {
    id: "ning-buyi",
    name: "宁不疑",
    alias: "小侯爷",
    roleWeight: "main",
    archetype: "对手",
    alignment: "守序邪恶",
    status: "活跃",
    summary: "接管北境军权的年轻统帅，坚信稳定高于迟来的公正。",
    identities: ["定北侯世子", "羽林左卫统领"],
    age: "二十九岁",
    currentRealm: "",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    gender: "男",
    raceId: "human",
    soulId: "global-strategist",
    groupIds: ["core-cast", "northern-line", "capital-line"],
    hometown: "京畿",
    appearance: "面容温和，常着不带纹饰的白甲，右手戴黑色护指。",
    personality: "有礼、耐心、极少失态；能真诚欣赏敌人的能力。",
    values: "让多数人活下去，比替少数人讨回公道更重要。",
    strengths: "战略耐心与组织能力极强，敢于承担骂名。",
    weaknesses: "把人视为秩序中的位置，无法接受不可计算的选择。",
    fears: "北境再次陷入军阀混战，证明父辈的牺牲毫无意义。",
    motivation: "彻底埋葬旧案，让边境获得二十年喘息。",
    goals: "控制司夜台证据链，迫使陆沉舟成为自己的新军旗帜。",
    innerConflict: "他尊重陆沉舟，却必须摧毁对方正在寻找的真相。",
    background: "少年时亲历兵变后的饥荒，把一切失序都视为可以预防的罪。",
    abilities: "军阵推演、骑射、政治谈判。",
    speechStyle: "总是先复述对方观点，再指出其中代价。",
    habits: "每次下令前都会摘下右手护指。",
    signatureItem: "定北军旧帅留下的黑檀令箭",
    inventory: [],
    storyRole: "价值观对手；他的方案有效，因此比单纯反派更难击败。",
    arc: "从控制一切变量，到面对秩序本身制造的失控。",
    firstAppearance: "第 6 章 · 白甲入城",
    completeness: 74,
    relations: [
      {
        targetId: "lu-chenzhou",
        type: "宿敌",
        tone: "negative",
        summary: "彼此认可能力，却不能接受对方对公义与秩序的排序。",
      },
      {
        targetId: "wen-hesheng",
        type: "监视",
        tone: "neutral",
        summary: "保留闻鹤生性命，以此观察旧军余部的动向。",
      },
    ],
    appearances: [
      {
        chapter: "06",
        title: "白甲入城",
        event: "以平乱之名接管临川城防。",
        state: "从容",
      },
      {
        chapter: "18",
        title: "照夜出匣",
        event: "公开邀请陆沉舟进入羽林卫。",
        state: "试探",
      },
    ],
    arcStages: [
      {
        title: "秩序执行者",
        state: "已完成",
        detail: "相信代价只要被准确计算，就可以被正当化。",
        complete: true,
      },
      {
        title: "变量失控",
        state: "进行中",
        detail: "陆沉舟公开身份后，旧军开始脱离他的推演。",
        complete: false,
      },
      {
        title: "无解之局",
        state: "待展开",
        detail: "必须亲手否定父辈建立的稳定逻辑。",
        complete: false,
      },
    ],
  },
  {
    id: "gu-changan",
    name: "顾长安",
    alias: "顾七",
    roleWeight: "secondary",
    archetype: "盟友",
    alignment: "混乱善良",
    status: "活跃",
    summary: "走遍三江码头的掮客，消息真假参半，人情从不赊账。",
    identities: ["漕帮账房", "私盐线掮客"],
    age: "三十一岁",
    currentRealm: "",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    gender: "男",
    raceId: "human",
    soulId: "nimble-protector",
    groupIds: ["river-line"],
    hometown: "江南",
    appearance: "笑眼，手上总有洗不掉的墨迹。",
    personality: "圆滑、热心、嘴碎，危急时反而异常可靠。",
    values: "规矩不能让活人饿死。",
    strengths: "人脉广，能迅速找到货物与人的去向。",
    weaknesses: "欠下太多人情，无法真正离开漕运体系。",
    fears: "自己的双面身份连累码头上的家人。",
    motivation: "保住漕帮底层船户的生路。",
    goals: "找出军械借漕粮入京的完整路线。",
    innerConflict: "继续帮陆沉舟会毁掉自己努力维持的脆弱平衡。",
    background: "从船童做到账房，靠替各方解决麻烦活到今天。",
    abilities: "账目追踪、码头黑话、开锁。",
    speechStyle: "爱用俗语，把危险说得像一桩小买卖。",
    habits: "谈价时敲三下桌面。",
    signatureItem: "一把缺了两颗珠子的乌木算盘",
    inventory: [],
    storyRole: "连接城市底层网络，并给沉重主线提供生活气。",
    arc: "从两边下注的生存者，转为公开承担立场。",
    firstAppearance: "第 4 章 · 三江六码头",
    completeness: 63,
    relations: [
      {
        targetId: "xie-wantang",
        type: "表亲",
        tone: "neutral",
        summary: "互相嫌弃，却都在暗中替对方收拾残局。",
      },
      {
        targetId: "lu-chenzhou",
        type: "债主",
        tone: "positive",
        summary: "陆沉舟救过他的船队，他用情报慢慢还债。",
      },
    ],
    appearances: [
      {
        chapter: "04",
        title: "三江六码头",
        event: "辨认出棺木底板来自官造漕船。",
        state: "试探",
      },
    ],
    arcStages: [
      {
        title: "两边下注",
        state: "已完成",
        detail: "任何时候都给自己保留第二条船。",
        complete: true,
      },
      {
        title: "无路可退",
        state: "进行中",
        detail: "为了船户名单第一次烧掉自己的退路。",
        complete: false,
      },
    ],
  },
  {
    id: "wen-hesheng",
    name: "闻鹤生",
    alias: "闻叔",
    roleWeight: "npc",
    archetype: "导师",
    alignment: "中立善良",
    status: "失踪",
    summary: "玄甲军旧医官，知道兵变当夜最后一道军令。",
    identities: ["药铺掌柜", "前玄甲军医官"],
    age: "五十六岁",
    currentRealm: "",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    gender: "男",
    raceId: "human",
    soulId: "northern-watch",
    groupIds: ["northern-line"],
    hometown: "北境",
    appearance: "背微驼，右耳听力很差，袖口常有药草碎屑。",
    personality: "温和而固执，对旧事保持近乎残酷的沉默。",
    values: "活下来的人没有资格替死者选择荣耀。",
    strengths: "医术、旧军人脉、对北境地形的熟悉。",
    weaknesses: "长期隐瞒让他习惯用保护之名替别人做决定。",
    fears: "陆沉舟重复其父亲的选择。",
    motivation: "让陆家最后一个孩子远离北境旧案。",
    goals: "在宁不疑找到自己前销毁军令副本。",
    innerConflict: "说出真相能救陆沉舟，也可能让整个北境重新开战。",
    background: "兵变后改名换姓，在临川经营小药铺。",
    abilities: "战地医术、辨毒、旧军密语。",
    speechStyle: "很少谈道理，只讲具体的人和伤口。",
    habits: "说谎时会反复清点药柜。",
    signatureItem: "玄甲军制式铜药匙",
    inventory: [],
    storyRole: "掌握关键缺失信息，也是上一代沉默代价的具象化。",
    arc: "从隐瞒真相保护后辈，到承认后辈有权自己选择。",
    firstAppearance: "第 2 章 · 旧药铺",
    completeness: 58,
    relations: [
      {
        targetId: "lu-chenzhou",
        type: "旧部",
        tone: "positive",
        summary: "把陆沉舟当作故主遗孤，也因此不肯平等地对待他的选择。",
      },
      {
        targetId: "ning-buyi",
        type: "被监视者",
        tone: "negative",
        summary: "知道宁氏接管北境的真正条件。",
      },
    ],
    appearances: [
      {
        chapter: "02",
        title: "旧药铺",
        event: "认出箭簇，却谎称只是仿制品。",
        state: "隐瞒",
      },
    ],
    arcStages: [
      {
        title: "保护性沉默",
        state: "进行中",
        detail: "坚信不知道真相才是陆沉舟最安全的结局。",
        complete: false,
      },
      {
        title: "交还选择",
        state: "待展开",
        detail: "把最后一道军令交给陆沉舟。",
        complete: false,
      },
    ],
  },
  {
    id: "a-yan",
    name: "阿砚",
    alias: "小哑巴",
    roleWeight: "extra",
    archetype: "见证者",
    alignment: "绝对中立",
    status: "活跃",
    summary: "码头抄号童子，见过那口无名棺第一次被搬上船。",
    identities: ["三江码头抄号童子"],
    age: "约十三岁",
    currentRealm: "",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    gender: "男",
    raceId: "human",
    soulId: "",
    groupIds: ["river-line"],
    hometown: "",
    appearance: "瘦小，脖子上挂着一截断铅笔。",
    personality: "机警，不轻易相信穿官服的人。",
    values: "谁给饭吃，就替谁守住秘密。",
    strengths: "记号与船号过目不忘。",
    weaknesses: "无法判断自己掌握的信息有多危险。",
    fears: "被送回牙行。",
    motivation: "攒够钱离开码头。",
    goals: "找到失踪的同伴小满。",
    innerConflict: "说出船号可能救人，也会暴露藏身处。",
    background: "两年前被顾长安从牙行赎出。",
    abilities: "认船号、钻狭窄货舱、简单手语。",
    speechStyle: "用手势和极简短的字条交流。",
    habits: "紧张时把铅笔藏进袖口。",
    signatureItem: "断铅笔",
    inventory: [],
    storyRole: "提供关键目击信息，并展示大人物选择落到普通人身上的代价。",
    arc: "从只求自保，到主动留下证词。",
    firstAppearance: "第 4 章 · 三江六码头",
    completeness: 41,
    relations: [
      {
        targetId: "gu-changan",
        type: "受照顾",
        tone: "positive",
        summary: "把顾长安视为不肯承认的养父。",
      },
    ],
    appearances: [
      {
        chapter: "04",
        title: "三江六码头",
        event: "在人群边缘认出被刮去的旧船号。",
        state: "戒备",
      },
    ],
    arcStages: [
      {
        title: "沉默目击者",
        state: "进行中",
        detail: "掌握线索，但没有相信任何一方。",
        complete: false,
      },
    ],
  },
];

function roleTone(roleWeight: RoleWeight): string {
  if (roleWeight === "main") {
    return "bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]";
  }
  if (roleWeight === "secondary") {
    return "bg-[var(--success-bg)] text-[var(--success)]";
  }
  if (roleWeight === "npc") {
    return "bg-[var(--info-bg)] text-[var(--info)]";
  }
  return "bg-[var(--paper-inset)] text-[var(--ink-muted)]";
}

function findSoulConflictEvidence(
  fields: readonly { readonly label: string; readonly value: string }[],
  keywords: readonly string[],
): { readonly label: string; readonly value: string } | undefined {
  return fields.find((field) =>
    keywords.some((keyword) => field.value.includes(keyword)),
  );
}

function analyzeSoulCompatibility(
  character: CharacterRecord,
  soul: CharacterSoulDefinition,
): SoulCompatibilityAnalysis {
  const findings: SoulConflictFinding[] = [];
  const expressionEvidence = findSoulConflictEvidence(
    [
      { label: "语言风格", value: character.speechStyle },
      { label: "性格", value: character.personality },
    ],
    soul.expressionConflictKeywords,
  );
  const decisionEvidence = findSoulConflictEvidence(
    [
      { label: "性格", value: character.personality },
      { label: "优点 / 长处", value: character.strengths },
      { label: "习惯 / 小动作", value: character.habits },
    ],
    soul.decisionConflictKeywords,
  );
  const valueEvidence = findSoulConflictEvidence(
    [
      { label: "价值观 / 信念", value: character.values },
      { label: "动机 / 欲望", value: character.motivation },
      { label: "短期与长期目标", value: character.goals },
    ],
    soul.valueConflictKeywords,
  );
  const amplificationEvidence = findSoulConflictEvidence(
    [
      { label: "弱点 / 缺陷", value: character.weaknesses },
      { label: "恐惧 / 软肋", value: character.fears },
      { label: "核心矛盾", value: character.innerConflict },
    ],
    soul.amplificationKeywords,
  );

  if (expressionEvidence) {
    findings.push({
      severity: "conflict",
      title: "表达节奏冲突",
      characterField: expressionEvidence.label,
      characterEvidence: expressionEvidence.value,
      soulTendency: soul.expressionDna,
      resolution:
        "保留角色原有说话节奏；灵魂只参与幕后思考和判断顺序，不替换角色口吻。",
    });
  }
  if (decisionEvidence) {
    findings.push({
      severity: "tension",
      title: "决策方式存在张力",
      characterField: decisionEvidence.label,
      characterEvidence: decisionEvidence.value,
      soulTendency: soul.decisionHeuristics,
      resolution:
        "场景行为服从人物当前目标与能力边界，只采纳和既有设定相容的决策步骤。",
    });
  }
  if (valueEvidence) {
    findings.push({
      severity: "conflict",
      title: "价值排序冲突",
      characterField: valueEvidence.label,
      characterEvidence: valueEvidence.value,
      soulTendency: soul.mentalModel,
      resolution:
        "角色价值观是硬约束；灵魂倾向只能形成诱惑或内在张力，不能直接改写人物立场。",
    });
  }
  if (amplificationEvidence) {
    findings.push({
      severity: "amplification",
      title: "既有缺陷可能被放大",
      characterField: amplificationEvidence.label,
      characterEvidence: amplificationEvidence.value,
      soulTendency: soul.valueAntiPatterns,
      resolution:
        "降低灵魂注入强度，并保留求助、失败或反证，避免把人物缺陷强化成单一标签。",
    });
  }

  const penalty = findings.reduce((total, finding) => {
    if (finding.severity === "conflict") return total + 18;
    if (finding.severity === "tension") return total + 10;
    return total + 6;
  }, 0);
  const score = Math.max(38, 96 - penalty);
  const label =
    score >= 85 ? "适配良好" : score >= 65 ? "有条件适配" : "高冲突";
  return { score, label, findings };
}

function soulAnalysisTone(score: number): string {
  if (score >= 85) return "text-[var(--success)] bg-[var(--success-bg)]";
  if (score >= 65) {
    return "text-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]";
  }
  return "text-[var(--error)] bg-[var(--error-bg)]";
}

function relationTone(tone: CharacterRelation["tone"]): string {
  if (tone === "positive") return "text-[var(--success)]";
  if (tone === "negative") return "text-[var(--error)]";
  return "text-[var(--warning)]";
}

function graphToneColor(tone: CharacterRelation["tone"]): string {
  if (tone === "positive") return "var(--success)";
  if (tone === "negative") return "var(--error)";
  return "var(--warning)";
}

function CharacterMark({
  character,
  size = "medium",
}: {
  readonly character: CharacterRecord;
  readonly size?: "small" | "medium" | "large";
}) {
  const sizeClass =
    size === "large"
      ? "h-16 w-16 text-xl"
      : size === "small"
        ? "h-8 w-8 text-xs"
        : "h-10 w-10 text-sm";
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--paper-inset)] font-semibold text-[var(--ink-secondary)] ${sizeClass}`}
    >
      {character.name.slice(0, 1)}
    </span>
  );
}

function SectionTitle({
  icon: Icon,
  children,
}: {
  readonly icon: LucideIcon;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] pb-2">
      <Icon className="h-4 w-4 text-[var(--accent-warm)]" />
      <h3 className="text-sm font-semibold text-[var(--ink)]">{children}</h3>
    </div>
  );
}

function ReadField({
  label,
  value,
  editing,
  multiline = true,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly editing: boolean;
  readonly multiline?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <span className="pt-1 text-xs font-medium text-[var(--ink-muted)]">
        {label}
      </span>
      {editing ? (
        multiline ? (
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={2}
            className="min-h-16 resize-y rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm leading-6 text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
          />
        ) : (
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="h-9 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
          />
        )
      ) : (
        <span className="min-w-0 whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">
          {value || "未填写"}
        </span>
      )}
    </label>
  );
}

type CultivationReferenceOption = {
  readonly value: string;
  readonly label: string;
};

function CultivationReferenceField({
  label,
  value,
  options,
  editing,
  onChange,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly options: readonly CultivationReferenceOption[];
  readonly editing: boolean;
  readonly onChange: (value: string | null) => void;
}) {
  if (!editing)
    return (
      <ReadField
        label={label}
        value={options.find((option) => option.value === value)?.label ?? value ?? ""}
        editing={false}
        multiline={false}
        onChange={() => undefined}
      />
    );
  return (
    <label className="grid gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <span className="pt-1 text-xs font-medium text-[var(--ink-muted)]">{label}</span>
      <CustomSelect
        value={value ?? ""}
        options={[{ value: "", label: "未绑定" }, ...options]}
        onChange={(next) => onChange(next || null)}
        ariaLabel={label}
        size="md"
      />
    </label>
  );
}

function CultivationIdListField({
  label,
  ids,
  options,
  editing,
  onChange,
}: {
  readonly label: string;
  readonly ids: readonly string[];
  readonly options: readonly CultivationReferenceOption[];
  readonly editing: boolean;
  readonly onChange: (ids: string[]) => void;
}) {
  const optionMap = new Map(options.map((option) => [option.value, option.label]));
  if (!editing)
    return (
      <ReadField
        label={label}
        value={ids
          .map((id) => optionMap.get(id) ?? `${id}（失效引用）`)
          .join("、")}
        editing={false}
        multiline={false}
        onChange={() => undefined}
      />
    );
  const available = options.filter((option) => !ids.includes(option.value));
  return (
    <div className="grid gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <span className="pt-1 text-xs font-medium text-[var(--ink-muted)]">{label}</span>
      <div className="space-y-2">
        {ids.map((id) => (
          <div key={id} className="flex items-center justify-between gap-2 rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)] px-2.5 py-1.5 text-sm">
            <span className="min-w-0 truncate text-[var(--ink-secondary)]">
              {optionMap.get(id) ?? `${id}（失效引用）`}
            </span>
            <button
              type="button"
              onClick={() => onChange(ids.filter((candidate) => candidate !== id))}
              aria-label={`移除${label}${optionMap.get(id) ?? id}`}
              title="移除"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <CustomSelect
          value=""
          options={available}
          onChange={(id) => {
            if (id) onChange([...ids, id]);
          }}
          ariaLabel={`添加${label}`}
          placeholder={available.length > 0 ? `添加${label}` : "没有可添加的选项"}
          disabled={available.length === 0}
          size="md"
        />
      </div>
    </div>
  );
}

function IdentityListField({
  values,
  editing,
  onChange,
}: {
  readonly values: readonly string[];
  readonly editing: boolean;
  readonly onChange: (values: string[]) => void;
}) {
  const visibleValues = values.filter((value) => value.trim());

  return (
    <div className="grid gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <span className="pt-1 text-xs font-medium text-[var(--ink-muted)]">
        身份 / 职业
      </span>
      {editing ? (
        <div className="space-y-2">
          {values.map((value, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                value={value}
                onChange={(event) => {
                  const next = [...values];
                  next[index] = event.target.value;
                  onChange(next);
                }}
                placeholder={
                  index === 0 ? "例如：司夜台主簿" : "继续添加身份或职业"
                }
                className="h-9 min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
              />
              <button
                type="button"
                onClick={() =>
                  onChange(values.filter((_, itemIndex) => itemIndex !== index))
                }
                aria-label={`删除身份或职业 ${index + 1}`}
                title="删除"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange([...values, ""])}
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
          >
            <Plus className="h-3.5 w-3.5" />
            添加身份 / 职业
          </button>
        </div>
      ) : visibleValues.length > 0 ? (
        <ul className="space-y-1.5 text-sm leading-6 text-[var(--ink-secondary)]">
          {visibleValues.map((value, index) => (
            <li key={`${value}-${index}`} className="flex items-start gap-2">
              <span className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-[var(--accent-warm)]" />
              <span>{value}</span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-sm leading-6 text-[var(--ink-secondary)]">
          未填写
        </span>
      )}
    </div>
  );
}

function RaceField({
  raceId,
  races,
  editing,
  onChange,
  onManage,
}: {
  readonly raceId: string;
  readonly races: readonly RaceDefinition[];
  readonly editing: boolean;
  readonly onChange: (raceId: string) => void;
  readonly onManage: () => void;
}) {
  const race = races.find((item) => item.id === raceId);

  return (
    <div className="grid gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <span className="pt-1 text-xs font-medium text-[var(--ink-muted)]">
        种族
      </span>
      {editing ? (
        <CustomSelect
          value={raceId}
          options={[
            { value: "", label: "未设置" },
            ...races.map((item) => ({
              value: item.id,
              label: item.name || "未命名种族",
            })),
          ]}
          onChange={onChange}
          ariaLabel="选择种族"
          placeholder="选择种族"
          size="toolbar"
          className="min-w-0"
          footerAction={{
            label: "管理种族",
            icon: <Dna className="h-3.5 w-3.5" />,
            onClick: onManage,
          }}
        />
      ) : (
        <span className="text-sm leading-6 text-[var(--ink-secondary)]">
          {race?.name || "未填写"}
        </span>
      )}
    </div>
  );
}

function CharacterGroupField({
  groupIds,
  groups,
  editing,
  onChange,
}: {
  readonly groupIds: readonly string[];
  readonly groups: readonly CharacterGroupDefinition[];
  readonly editing: boolean;
  readonly onChange: (groupIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const assignedGroups = groups.filter((group) => groupIds.includes(group.id));
  const selectionLabel =
    assignedGroups.length === 0
      ? "选择角色分组"
      : assignedGroups.length === 1
        ? assignedGroups[0].name || "未命名分组"
        : `${assignedGroups[0].name || "未命名分组"} 等 ${assignedGroups.length} 个`;

  return (
    <div className="grid gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <span className="pt-1 text-xs font-medium text-[var(--ink-muted)]">
        角色分组
      </span>
      {editing ? (
        <div className="relative min-w-0">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-label="选择角色分组"
            className="flex h-9 w-full items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-left text-sm text-[var(--ink)] outline-none transition-colors hover:border-[var(--line-strong)] focus:border-[var(--accent-warm)]"
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--accent-cool)]" />
            <span
              className={`min-w-0 flex-1 truncate ${
                assignedGroups.length === 0 ? "text-[var(--ink-muted)]" : ""
              }`}
            >
              {selectionLabel}
            </span>
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
          <Popover
            open={open}
            onClose={() => setOpen(false)}
            anchorRef={triggerRef}
            placement="bottom-start"
            matchAnchorWidth
            className="shadow-md"
            zIndex={300}
          >
            <div className="max-h-60 overflow-y-auto py-1">
              {groups.length > 0 ? (
                groups.map((group) => {
                  const selected = groupIds.includes(group.id);
                  return (
                    <button
                      key={group.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        onChange(
                          selected
                            ? groupIds.filter((id) => id !== group.id)
                            : [...groupIds, group.id],
                        )
                      }
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                        selected
                          ? "bg-[var(--accent-cool)]/10 font-medium text-[var(--accent-cool)]"
                          : "text-[var(--ink)] hover:bg-[var(--paper-inset)]"
                      }`}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                          selected
                            ? "border-[var(--accent-cool)] bg-[var(--accent-cool)] text-white"
                            : "border-[var(--line-strong)]"
                        }`}
                      >
                        {selected && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {group.name || "未命名分组"}
                      </span>
                    </button>
                  );
                })
              ) : (
                <p className="px-3 py-3 text-sm text-[var(--ink-muted)]">
                  暂无角色分组
                </p>
              )}
            </div>
          </Popover>
        </div>
      ) : assignedGroups.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {assignedGroups.map((group) => (
            <span
              key={group.id}
              className="rounded-md bg-[var(--accent-cool)]/10 px-2 py-1 text-xs font-medium text-[var(--accent-cool)]"
            >
              {group.name || "未命名分组"}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-sm leading-6 text-[var(--ink-secondary)]">
          未分组
        </span>
      )}
    </div>
  );
}

function ProfileTab({
  character,
  races,
  groups,
  editing,
  onChange,
  onManageRaces,
}: {
  readonly character: CharacterRecord;
  readonly races: readonly RaceDefinition[];
  readonly groups: readonly CharacterGroupDefinition[];
  readonly editing: boolean;
  readonly onChange: CharacterChangeHandler;
  readonly onManageRaces: () => void;
}) {
  return (
    <div className="grid min-h-0 grid-cols-2 gap-x-8 gap-y-7 px-6 py-6 max-xl:grid-cols-1">
      <section className="space-y-4">
        <SectionTitle icon={UserRound}>身份与外观</SectionTitle>
        <CharacterGroupField
          groupIds={character.groupIds}
          groups={groups}
          editing={editing}
          onChange={(groupIds) => onChange({ groupIds })}
        />
        <IdentityListField
          values={character.identities}
          editing={editing}
          onChange={(identities) => onChange({ identities })}
        />
        <ReadField
          label="性别"
          value={character.gender}
          editing={editing}
          multiline={false}
          onChange={(gender) => onChange({ gender })}
        />
        <RaceField
          raceId={character.raceId}
          races={races}
          editing={editing}
          onChange={(raceId) => onChange({ raceId })}
          onManage={onManageRaces}
        />
        <ReadField
          label="家乡"
          value={character.hometown}
          editing={editing}
          multiline={false}
          onChange={(hometown) => onChange({ hometown })}
        />
        <ReadField
          label="外貌特征"
          value={character.appearance}
          editing={editing}
          onChange={(appearance) => onChange({ appearance })}
        />
      </section>

      <section className="space-y-4">
        <SectionTitle icon={Shield}>性格内核</SectionTitle>
        <ReadField
          label="性格"
          value={character.personality}
          editing={editing}
          onChange={(personality) => onChange({ personality })}
        />
        <ReadField
          label="价值观 / 信念"
          value={character.values}
          editing={editing}
          onChange={(values) => onChange({ values })}
        />
        <ReadField
          label="优点 / 长处"
          value={character.strengths}
          editing={editing}
          onChange={(strengths) => onChange({ strengths })}
        />
        <ReadField
          label="弱点 / 缺陷"
          value={character.weaknesses}
          editing={editing}
          onChange={(weaknesses) => onChange({ weaknesses })}
        />
      </section>

      <section className="space-y-4">
        <SectionTitle icon={Target}>驱动力</SectionTitle>
        <ReadField
          label="动机 / 欲望"
          value={character.motivation}
          editing={editing}
          onChange={(motivation) => onChange({ motivation })}
        />
        <ReadField
          label="短期与长期目标"
          value={character.goals}
          editing={editing}
          onChange={(goals) => onChange({ goals })}
        />
        <ReadField
          label="恐惧 / 软肋"
          value={character.fears}
          editing={editing}
          onChange={(fears) => onChange({ fears })}
        />
        <ReadField
          label="核心矛盾"
          value={character.innerConflict}
          editing={editing}
          onChange={(innerConflict) => onChange({ innerConflict })}
        />
      </section>

      <section className="space-y-4">
        <SectionTitle icon={BookOpen}>故事功能</SectionTitle>
        <ReadField
          label="背景故事"
          value={character.background}
          editing={editing}
          onChange={(background) => onChange({ background })}
        />
        <ReadField
          label="能力"
          value={character.abilities}
          editing={editing}
          onChange={(abilities) => onChange({ abilities })}
        />
        <ReadField
          label="故事作用"
          value={character.storyRole}
          editing={editing}
          onChange={(storyRole) => onChange({ storyRole })}
        />
      </section>

      <section className="space-y-4">
        <SectionTitle icon={Sparkles}>鲜活细节</SectionTitle>
        <ReadField
          label="语言风格"
          value={character.speechStyle}
          editing={editing}
          onChange={(speechStyle) => onChange({ speechStyle })}
        />
        <ReadField
          label="习惯 / 小动作"
          value={character.habits}
          editing={editing}
          onChange={(habits) => onChange({ habits })}
        />
        <ReadField
          label="标志性物品"
          value={character.signatureItem}
          editing={editing}
          onChange={(signatureItem) => onChange({ signatureItem })}
        />
      </section>
    </div>
  );
}

function RealmProgressNodesField({
  values,
  editing,
  onChange,
}: {
  readonly values: readonly string[];
  readonly editing: boolean;
  readonly onChange: (values: string[]) => void;
}) {
  const visibleValues = values.filter((value) => value.trim());
  return (
    <div className="grid gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <span className="pt-1 text-xs font-medium text-[var(--ink-muted)]">
        境内过程节点
      </span>
      {editing ? (
        <div className="space-y-2">
          {values.map((value, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                value={value}
                onChange={(event) => {
                  const next = [...values];
                  next[index] = event.target.value;
                  onChange(next);
                }}
                placeholder={
                  index === 0 ? "例如：筑基初期 · 稳固灵台" : "继续添加过程节点"
                }
                className="h-9 min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
              />
              <button
                type="button"
                onClick={() =>
                  onChange(values.filter((_, itemIndex) => itemIndex !== index))
                }
                aria-label={`删除过程节点 ${index + 1}`}
                title="删除"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange([...values, ""])}
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
          >
            <Plus className="h-3.5 w-3.5" />
            添加过程节点
          </button>
        </div>
      ) : visibleValues.length > 0 ? (
        <ol className="space-y-1.5 text-sm leading-6 text-[var(--ink-secondary)]">
          {visibleValues.map((value, index) => (
            <li key={`${value}-${index}`} className="flex items-start gap-2">
              <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-warm)]" />
              <span>{value}</span>
            </li>
          ))}
        </ol>
      ) : (
        <span className="text-sm leading-6 text-[var(--ink-secondary)]">
          未填写
        </span>
      )}
    </div>
  );
}

function CultivationTab({
  character,
  ecology,
  editing,
  onChange,
}: {
  readonly character: CharacterRecord;
  readonly ecology: CultivationEcology | null;
  readonly editing: boolean;
  readonly onChange: CharacterChangeHandler;
}) {
  const profile = character.cultivationProfile ?? EMPTY_CULTIVATION_PROFILE;
  const updateProfile = (patch: Partial<CharacterCultivationProfile>) =>
    onChange({ cultivationProfile: { ...profile, ...patch } });
  const selectedSystem = ecology?.systems.find(
    (system) => system.id === profile.systemId,
  );
  const tracks = selectedSystem?.progressionTracks ?? [];
  const selectedTrack = tracks.find((track) => track.id === profile.trackId);
  const levels = selectedTrack?.levels ?? [];
  const reference = (items: readonly { id: string; name: string }[]) =>
    items.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }));
  const systemOptions = reference(ecology?.systems ?? []);
  const trackOptions = reference(tracks);
  const levelOptions = reference(levels);
  const methodOptions = reference(selectedSystem?.methods ?? []);
  const abilityOptions = reference(selectedSystem?.abilities ?? []);
  const constraintOptions = reference(selectedSystem?.constraints ?? []);
  return (
    <div className="grid min-h-0 grid-cols-2 gap-x-8 gap-y-7 px-6 py-6 max-xl:grid-cols-1">
      <section className="space-y-4">
        <SectionTitle icon={Sparkles}>境界与过程</SectionTitle>
        <ReadField
          label="当前境界"
          value={character.currentRealm}
          editing={editing}
          multiline={false}
          onChange={(currentRealm) => onChange({ currentRealm })}
        />
        <RealmProgressNodesField
          values={character.realmProgressNodes}
          editing={editing}
          onChange={(realmProgressNodes) => onChange({ realmProgressNodes })}
        />
      </section>

      <section className="space-y-4">
        <SectionTitle icon={Target}>寿元</SectionTitle>
        <ReadField
          label="基础寿元"
          value={character.baseLifespan}
          editing={editing}
          multiline={false}
          onChange={(baseLifespan) => onChange({ baseLifespan })}
        />
        <ReadField
          label="当前年龄"
          value={character.age}
          editing={editing}
          multiline={false}
          onChange={(age) => onChange({ age })}
        />
        <ReadField
          label="寿元损耗"
          value={character.lifespanLoss}
          editing={editing}
          multiline={false}
          onChange={(lifespanLoss) => onChange({ lifespanLoss })}
        />
      </section>

      <section className="col-span-2 space-y-4 max-xl:col-span-1">
        <SectionTitle icon={Dna}>根基与传承</SectionTitle>
        <ReadField
          label="灵根"
          value={character.spiritRoot}
          editing={editing}
          multiline={false}
          onChange={(spiritRoot) => onChange({ spiritRoot })}
        />
        <ReadField
          label="道体"
          value={character.daoBody}
          editing={editing}
          multiline={false}
          onChange={(daoBody) => onChange({ daoBody })}
        />
        <ReadField
          label="功法"
          value={character.cultivationMethod}
          editing={editing}
          onChange={(cultivationMethod) => onChange({ cultivationMethod })}
        />
        <CultivationReferenceField
          label="修行体系"
          value={profile.systemId}
          options={systemOptions}
          editing={editing}
          onChange={(systemId) =>
            updateProfile({
              systemId,
              trackId: null,
              levelId: null,
              methodIds: [],
              abilityIds: [],
              activeConstraintIds: [],
              resourceBalances: {},
              breakthroughHistory: [],
            })
          }
        />
        <CultivationReferenceField
          label="成长轨道"
          value={profile.trackId}
          options={trackOptions}
          editing={editing}
          onChange={(trackId) => updateProfile({ trackId, levelId: null })}
        />
        <CultivationReferenceField
          label="当前阶段"
          value={profile.levelId}
          options={levelOptions}
          editing={editing}
          onChange={(levelId) => updateProfile({ levelId })}
        />
        <CultivationIdListField
          label="已掌握法门"
          ids={profile.methodIds}
          options={methodOptions}
          editing={editing}
          onChange={(methodIds) => updateProfile({ methodIds })}
        />
        <CultivationIdListField
          label="已掌握能力"
          ids={profile.abilityIds}
          options={abilityOptions}
          editing={editing}
          onChange={(abilityIds) => updateProfile({ abilityIds })}
        />
        <CultivationIdListField
          label="活跃约束"
          ids={profile.activeConstraintIds}
          options={constraintOptions}
          editing={editing}
          onChange={(activeConstraintIds) => updateProfile({ activeConstraintIds })}
        />
      </section>
    </div>
  );
}

function CharacterInventoryTab({
  character,
  itemEntries,
  itemLibraryLoading,
  itemLibraryError,
  editing,
  onChange,
  onRefreshItemLibrary,
}: {
  readonly character: CharacterRecord;
  readonly itemEntries: readonly ItemIndexEntry[];
  readonly itemLibraryLoading: boolean;
  readonly itemLibraryError: string | null;
  readonly editing: boolean;
  readonly onChange: CharacterChangeHandler;
  readonly onRefreshItemLibrary: () => void;
}) {
  const itemById = useMemo(
    () => new Map(itemEntries.map((item) => [item.id, item])),
    [itemEntries],
  );
  const availableItemEntries = useMemo(
    () => itemEntries.filter((item) => item.status !== "archived"),
    [itemEntries],
  );
  const linkedCount = character.inventory.filter((item) => item.itemId).length;

  const updateInventoryItem = (
    itemId: string,
    patch: Partial<CharacterInventoryItem>,
  ) => {
    onChange({
      inventory: character.inventory.map((item) =>
        item.id === itemId ? { ...item, ...patch } : item,
      ),
    });
  };

  const addStandaloneItem = () => {
    onChange({
      inventory: [
        ...character.inventory,
        {
          id: createLibraryId("inventory"),
          itemId: null,
          name: "未命名物品",
          quantity: 1,
          unit: "件",
          description: "",
        },
      ],
    });
  };

  const addLinkedItem = (itemId: string) => {
    const item = itemById.get(itemId);
    if (!item) return;
    onChange({
      inventory: [
        ...character.inventory,
        {
          id: createLibraryId("inventory"),
          itemId: item.id,
          name: item.name,
          quantity: 1,
          unit: "件",
          description: item.summary,
        },
      ],
    });
  };

  return (
    <div className="px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line-subtle)] pb-4">
        <div>
          <SectionTitle icon={Package}>物品栏</SectionTitle>
          <p className="mt-1 text-sm leading-6 text-[var(--ink-secondary)]">
            {character.inventory.length} 件物品 · {linkedCount} 件关联物品库
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefreshItemLibrary}
            disabled={itemLibraryLoading}
            aria-label="刷新物品库"
            title="刷新物品库"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-45"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${itemLibraryLoading ? "animate-spin" : ""}`}
            />
          </button>
          {editing && (
            <>
              {itemLibraryLoading || availableItemEntries.length === 0 ? (
                <button
                  type="button"
                  disabled
                  title={
                    itemLibraryLoading ? "正在读取物品库" : "物品库暂无物品"
                  }
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 text-xs font-medium text-[var(--ink-muted)] opacity-45"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  {itemLibraryLoading ? "正在读取物品库" : "物品库暂无物品"}
                </button>
              ) : (
                <CustomSelect
                  value=""
                  options={availableItemEntries.map((item) => ({
                    value: item.id,
                    label: item.name,
                    suffix: (
                      <span className="max-w-28 truncate text-[var(--ink-muted)]">
                        {item.summary || "无摘要"}
                      </span>
                    ),
                  }))}
                  onChange={addLinkedItem}
                  ariaLabel="从物品库关联物品"
                  placeholder="关联物品库物品"
                  triggerIcon={<Link2 className="h-3.5 w-3.5" />}
                  size="toolbar"
                  className="w-44"
                />
              )}
              <button
                type="button"
                onClick={addStandaloneItem}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-2.5 text-xs font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
              >
                <Plus className="h-3.5 w-3.5" />
                新增独立物品
              </button>
            </>
          )}
        </div>
      </div>

      {itemLibraryError && (
        <p className="border-b border-[var(--line-subtle)] py-3 text-sm text-[var(--warning)]">
          {itemLibraryError}；仍可维护不关联物品库的独立物品。
        </p>
      )}

      {character.inventory.length === 0 ? (
        <div className="py-14 text-center">
          <Package className="mx-auto h-7 w-7 text-[var(--ink-subtle)]" />
          <p className="mt-3 text-sm font-medium text-[var(--ink-secondary)]">
            物品栏为空
          </p>
          <p className="mt-1 text-sm text-[var(--ink-muted)]">
            记录角色持有、携带或正在使用的物品。
          </p>
          {editing && (
            <button
              type="button"
              onClick={addStandaloneItem}
              className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              <Plus className="h-3.5 w-3.5" />
              添加第一件物品
            </button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-[var(--line-subtle)]">
          {editing && (
            <div className="grid gap-x-5 px-0 py-2 text-xs font-medium text-[var(--ink-muted)] xl:grid-cols-[minmax(12rem,0.8fr)_9rem_minmax(15rem,1.2fr)_auto]">
              <span>物品名称</span>
              <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-2">
                <span>数量</span>
                <span>单位</span>
              </div>
              <span>物品说明</span>
              <span className="sr-only">操作</span>
            </div>
          )}
          {character.inventory.map((inventoryItem) => {
            const linkedItem = inventoryItem.itemId
              ? itemById.get(inventoryItem.itemId)
              : undefined;
            const displayName = linkedItem?.name ?? inventoryItem.name;
            const linkState = inventoryItem.itemId
              ? linkedItem
                ? "已关联物品库"
                : "关联物品已不存在"
              : "独立物品";

            return (
              <article
                key={inventoryItem.id}
                className="grid gap-x-5 gap-y-3 py-5 xl:grid-cols-[minmax(12rem,0.8fr)_9rem_minmax(15rem,1.2fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    {inventoryItem.itemId ? (
                      <Link2 className="h-4 w-4 shrink-0 text-[var(--accent-cool)]" />
                    ) : (
                      <Package className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                    )}
                    {editing ? (
                      <input
                        value={inventoryItem.name}
                        onChange={(event) =>
                          updateInventoryItem(inventoryItem.id, {
                            name: event.target.value,
                          })
                        }
                        aria-label="物品名称"
                        className="min-w-0 flex-1 border-b border-[var(--line)] bg-transparent py-1 text-sm font-semibold text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
                      />
                    ) : (
                      <span className="truncate text-sm font-semibold text-[var(--ink)]">
                        {displayName}
                      </span>
                    )}
                  </div>
                  <p
                    className={`mt-2 text-xs ${
                      inventoryItem.itemId && !linkedItem
                        ? "text-[var(--warning)]"
                        : "text-[var(--ink-muted)]"
                    }`}
                  >
                    {linkState}
                  </p>
                </div>

                <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-2 self-start xl:mt-0">
                  {editing ? (
                    <>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={inventoryItem.quantity}
                        onChange={(event) =>
                          updateInventoryItem(inventoryItem.id, {
                            quantity: Math.max(
                              0,
                              Number.isFinite(event.target.valueAsNumber)
                                ? event.target.valueAsNumber
                                : 0,
                            ),
                          })
                        }
                        aria-label="数量"
                        className="h-8 min-w-0 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
                      />
                      <input
                        value={inventoryItem.unit}
                        onChange={(event) =>
                          updateInventoryItem(inventoryItem.id, {
                            unit: event.target.value,
                          })
                        }
                        aria-label="数量单位"
                        placeholder="单位"
                        className="h-8 min-w-0 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
                      />
                    </>
                  ) : (
                    <div className="col-span-2 text-sm text-[var(--ink-secondary)]">
                      {inventoryItem.quantity} {inventoryItem.unit || "件"}
                    </div>
                  )}
                </div>

                <div className="min-w-0">
                  {editing ? (
                    <textarea
                      value={inventoryItem.description}
                      onChange={(event) =>
                        updateInventoryItem(inventoryItem.id, {
                          description: event.target.value,
                        })
                      }
                      aria-label="物品说明"
                      placeholder="物品说明"
                      rows={2}
                      className="min-h-16 w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-sm leading-6 text-[var(--ink-secondary)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
                    />
                  ) : (
                    <p className="text-sm leading-6 text-[var(--ink-secondary)]">
                      {inventoryItem.description || "未填写物品说明"}
                    </p>
                  )}
                </div>

                {editing && (
                  <div className="flex items-start justify-end gap-1 xl:pt-0.5">
                    {inventoryItem.itemId && (
                      <button
                        type="button"
                        onClick={() =>
                          updateInventoryItem(inventoryItem.id, {
                            itemId: null,
                          })
                        }
                        aria-label="解除物品库关联"
                        title="解除物品库关联"
                        className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                      >
                        <Unlink className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        onChange({
                          inventory: character.inventory.filter(
                            (item) => item.id !== inventoryItem.id,
                          ),
                        })
                      }
                      aria-label="删除物品栏条目"
                      title="删除"
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SoulConflictItem({
  finding,
}: {
  readonly finding: SoulConflictFinding;
}) {
  const meta =
    finding.severity === "conflict"
      ? {
          label: "直接冲突",
          tone: "bg-[var(--error-bg)] text-[var(--error)]",
        }
      : finding.severity === "tension"
        ? {
            label: "需要约束",
            tone: "bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]",
          }
        : {
            label: "缺陷放大",
            tone: "bg-[var(--warning-bg)] text-[var(--warning)]",
          };

  return (
    <article className="border-b border-[var(--line-subtle)] py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium ${meta.tone}`}
        >
          {meta.label}
        </span>
        <h4 className="text-sm font-semibold text-[var(--ink)]">
          {finding.title}
        </h4>
      </div>
      <div className="mt-3 grid gap-4 text-sm leading-6 lg:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-[var(--ink-muted)]">
            角色原设定 · {finding.characterField}
          </p>
          <p className="mt-1 text-[var(--ink-secondary)]">
            {finding.characterEvidence}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium text-[var(--ink-muted)]">
            灵魂倾向
          </p>
          <p className="mt-1 text-[var(--ink-secondary)]">
            {finding.soulTendency}
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2 rounded-md bg-[var(--paper-inset)] px-3 py-2 text-sm leading-6 text-[var(--ink-secondary)]">
        <ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-[var(--success)]" />
        <span>{finding.resolution}</span>
      </div>
    </article>
  );
}

function CharacterSoulTab({
  character,
  souls,
  onBind,
  onOpenLibrary,
}: {
  readonly character: CharacterRecord;
  readonly souls: readonly CharacterSoulDefinition[];
  readonly onBind: (soulId: string) => void;
  readonly onOpenLibrary: () => void;
}) {
  const [candidateSoulId, setCandidateSoulId] = useState(character.soulId);

  const boundSoul = souls.find((soul) => soul.id === character.soulId);
  const candidateSoul = souls.find((soul) => soul.id === candidateSoulId);
  const analysis = candidateSoul
    ? analyzeSoulCompatibility(character, candidateSoul)
    : undefined;

  return (
    <div className="px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
        <div>
          <div className="flex items-center gap-2">
            <Fingerprint className="h-4 w-4 text-[var(--accent-cool)]" />
            <h3 className="text-sm font-semibold text-[var(--ink)]">
              角色灵魂
            </h3>
            {boundSoul && (
              <span className="rounded bg-[var(--success-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--success)]">
                已绑定
              </span>
            )}
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
            {boundSoul
              ? `${boundSoul.name} · ${boundSoul.summary}`
              : "当前角色尚未绑定灵魂。"}
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenLibrary}
          className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line-strong)] px-2.5 text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
        >
          <Fingerprint className="h-3.5 w-3.5" />
          打开灵魂库
        </button>
      </div>

      <div className="grid gap-8 pt-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="min-w-0">
          <div className="grid items-end gap-3 border-b border-[var(--line-subtle)] pb-5 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                预选角色灵魂
              </label>
              <CustomSelect
                value={candidateSoulId}
                options={[
                  { value: "", label: "暂不绑定" },
                  ...souls.map((soul) => ({
                    value: soul.id,
                    label: `${soul.name} · ${soul.category}`,
                  })),
                ]}
                onChange={setCandidateSoulId}
                ariaLabel="选择角色灵魂"
                size="toolbar"
                className="w-full"
              />
            </div>
            {boundSoul && (
              <button
                type="button"
                onClick={() => {
                  setCandidateSoulId("");
                  onBind("");
                }}
                className="flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--error)]"
              >
                <Unlink className="h-3.5 w-3.5" />
                解除绑定
              </button>
            )}
            <button
              type="button"
              disabled={!candidateSoul || candidateSoulId === character.soulId}
              onClick={() => onBind(candidateSoulId)}
              className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Link2 className="h-3.5 w-3.5" />
              {boundSoul ? "确认更换" : "确认绑定"}
            </button>
          </div>

          {candidateSoul && analysis ? (
            <div className="pt-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-[var(--ink-muted)]">
                    绑定前冲突审阅
                  </p>
                  <h4 className="mt-1 text-base font-semibold text-[var(--ink)]">
                    {candidateSoul.name}
                  </h4>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`rounded-md px-2.5 py-1 text-sm font-medium ${soulAnalysisTone(analysis.score)}`}
                  >
                    {analysis.label}
                  </span>
                  <span className="text-2xl font-semibold tabular-nums text-[var(--ink)]">
                    {analysis.score}
                    <span className="ml-0.5 text-xs font-normal text-[var(--ink-muted)]">
                      / 100
                    </span>
                  </span>
                </div>
              </div>

              {analysis.findings.length > 0 ? (
                <div className="mt-3">
                  {analysis.findings.map((finding) => (
                    <SoulConflictItem
                      key={`${finding.severity}-${finding.title}`}
                      finding={finding}
                    />
                  ))}
                </div>
              ) : (
                <div className="mt-5 flex gap-3 border-y border-[var(--line-subtle)] py-5">
                  <ShieldCheck className="h-5 w-5 shrink-0 text-[var(--success)]" />
                  <div>
                    <p className="text-sm font-medium text-[var(--ink)]">
                      未发现明显硬冲突
                    </p>
                    <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">
                      仍以当前章节状态、人物认知和情节因果作为最终约束。
                    </p>
                  </div>
                </div>
              )}

              <div className="mt-5 grid gap-x-8 gap-y-5 border-t border-[var(--line-subtle)] pt-5 md:grid-cols-2">
                <div>
                  <p className="text-xs font-medium text-[var(--ink-muted)]">
                    表达 DNA
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[var(--ink-secondary)]">
                    {candidateSoul.expressionDna}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--ink-muted)]">
                    心智模型
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[var(--ink-secondary)]">
                    {candidateSoul.mentalModel}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center border-b border-[var(--line-subtle)] text-center">
              <Fingerprint className="h-7 w-7 text-[var(--ink-subtle)]" />
              <p className="mt-3 text-sm font-medium text-[var(--ink)]">
                选择一个灵魂开始审阅
              </p>
            </div>
          )}
        </section>

        <aside className="border-l border-[var(--line-subtle)] pl-6 max-xl:border-l-0 max-xl:border-t max-xl:pl-0 max-xl:pt-5">
          <p className="text-xs font-semibold text-[var(--ink-muted)]">
            执行优先级
          </p>
          <ol className="mt-4 space-y-4">
            {[
              ["1", "角色硬设定", "人物小传、价值观、能力和语言风格"],
              ["2", "场景事实", "当前剧情、角色认知和关系状态"],
              ["3", "灵魂倾向", "表达、思考与决策启发"],
            ].map(([order, title, detail]) => (
              <li key={order} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--line-strong)] text-xs font-semibold text-[var(--ink-muted)]">
                  {order}
                </span>
                <div>
                  <p className="text-sm font-medium text-[var(--ink)]">
                    {title}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-[var(--ink-muted)]">
                    {detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-6 border-t border-[var(--line-subtle)] pt-5">
            <p className="text-xs font-semibold text-[var(--ink-muted)]">
              注入范围
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {["表达方式", "心智模型", "决策倾向"].map((label) => (
                <span
                  key={label}
                  className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink-secondary)]"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>

          {candidateSoul && (
            <div className="mt-6 border-t border-[var(--line-subtle)] pt-5">
              <p className="text-xs font-semibold text-[var(--ink-muted)]">
                灵魂边界
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--ink-secondary)]">
                {candidateSoul.boundaries}
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function ArcTab({ character }: { readonly character: CharacterRecord }) {
  return (
    <div className="px-6 py-6">
      <div className="grid grid-cols-[minmax(0,1fr)_16rem] gap-8 max-xl:grid-cols-1">
        <section>
          <SectionTitle icon={GitBranch}>成长弧光</SectionTitle>
          <p className="mt-4 text-sm leading-6 text-[var(--ink-secondary)]">
            {character.arc}
          </p>
          <ol className="mt-7 space-y-0">
            {character.arcStages.map((stage, index) => (
              <li
                key={stage.id ?? `${stage.title}-${index}`}
                className="relative flex gap-4 pb-7 last:pb-0"
              >
                {index < character.arcStages.length - 1 && (
                  <span className="absolute left-3 top-7 h-[calc(100%-1.25rem)] w-px bg-[var(--line-strong)]" />
                )}
                <span
                  className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                    stage.complete
                      ? "border-[var(--success)] bg-[var(--success)] text-white"
                      : stage.state === "进行中"
                        ? "border-[var(--accent-warm)] bg-[var(--paper-elevated)] text-[var(--accent-warm)]"
                        : "border-[var(--line-strong)] bg-[var(--paper-elevated)] text-[var(--ink-subtle)]"
                  }`}
                >
                  {stage.complete ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="text-sm font-semibold text-[var(--ink)]">
                      {stage.title}
                    </h4>
                    <span className="text-xs text-[var(--ink-muted)]">
                      {stage.state}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">
                    {stage.detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <aside className="border-l border-[var(--line-subtle)] pl-6 max-xl:border-l-0 max-xl:border-t max-xl:pl-0 max-xl:pt-5">
          <h3 className="text-sm font-semibold text-[var(--ink)]">弧光检查</h3>
          <dl className="mt-4 space-y-4 text-sm">
            <div>
              <dt className="text-xs text-[var(--ink-muted)]">起点信念</dt>
              <dd className="mt-1 leading-6 text-[var(--ink-secondary)]">
                只有自己掌握全部证据，才不会再害死别人。
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--ink-muted)]">终点选择</dt>
              <dd className="mt-1 leading-6 text-[var(--ink-secondary)]">
                公开证据，把如何理解真相的权利交还给所有人。
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--ink-muted)]">不可逆代价</dt>
              <dd className="mt-1 leading-6 text-[var(--ink-secondary)]">
                陆家将永远无法得到单一而清白的结论。
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}

function RelationsTab({
  character,
  characters,
  onSelect,
}: {
  readonly character: CharacterRecord;
  readonly characters: readonly CharacterRecord[];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <div className="px-6 py-6">
      <SectionTitle icon={Network}>人物关系</SectionTitle>
      <div className="mt-4 divide-y divide-[var(--line-subtle)]">
        {character.relations.map((relation) => {
          const target = characters.find(
            (candidate) => candidate.id === relation.targetId,
          );
          if (!target) return null;
          return (
            <button
              key={`${relation.targetId}-${relation.type}`}
              type="button"
              onClick={() => onSelect(target.id)}
              className="flex w-full items-center gap-4 px-2 py-4 text-left hover:bg-[var(--hover-bg)]"
            >
              <CharacterMark character={target} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--ink)]">
                    {target.name}
                  </span>
                  <span
                    className={`text-xs font-medium ${relationTone(relation.tone)}`}
                  >
                    {relation.type}
                  </span>
                </div>
                <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">
                  {relation.summary}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AppearancesTab({
  character,
}: {
  readonly character: CharacterRecord;
}) {
  return (
    <div className="px-6 py-6">
      <SectionTitle icon={BookOpen}>出场记录</SectionTitle>
      <div className="mt-4 overflow-hidden rounded-md border border-[var(--line)]">
        <div className="grid grid-cols-[5rem_10rem_minmax(0,1fr)_5rem] gap-4 border-b border-[var(--line)] bg-[var(--paper-inset)]/55 px-4 py-2 text-xs font-medium text-[var(--ink-muted)] max-lg:grid-cols-[4rem_minmax(0,1fr)_5rem]">
          <span>章节</span>
          <span className="max-lg:hidden">标题</span>
          <span>关键事件</span>
          <span>状态</span>
        </div>
        {character.appearances.map((appearance) => (
          <div
            key={`${appearance.chapter}-${appearance.title}`}
            className="grid grid-cols-[5rem_10rem_minmax(0,1fr)_5rem] gap-4 border-b border-[var(--line-subtle)] px-4 py-3 text-sm last:border-b-0 max-lg:grid-cols-[4rem_minmax(0,1fr)_5rem]"
          >
            <span className="font-medium text-[var(--ink)]">
              第 {appearance.chapter} 章
            </span>
            <span className="text-[var(--ink-secondary)] max-lg:hidden">
              {appearance.title}
            </span>
            <span className="leading-6 text-[var(--ink-muted)]">
              {appearance.event}
            </span>
            <span className="text-[var(--accent-cool)]">
              {appearance.state}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RelationNetwork({
  characters,
  selectedId,
  onSelect,
}: {
  readonly characters: readonly CharacterRecord[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}) {
  const selected =
    characters.find((character) => character.id === selectedId) ??
    characters[0];
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const related = selected.relations
    .map((relation) => ({
      relation,
      character: characters.find(
        (candidate) => candidate.id === relation.targetId,
      ),
    }))
    .filter(
      (
        item,
      ): item is {
        relation: CharacterRelation;
        character: CharacterRecord;
      } => Boolean(item.character),
    );

  useEffect(() => {
    if (!svgRef.current) return;

    const width = 760;
    const height = 520;
    const nodes: RelationGraphNode[] = [
      {
        id: selected.id,
        name: selected.name,
        archetype: selected.archetype,
        central: true,
        x: width / 2,
        y: height / 2,
        fx: width / 2,
        fy: height / 2,
      },
      ...related.map(({ character }) => ({
        id: character.id,
        name: character.name,
        archetype: character.archetype,
        central: false,
      })),
    ];
    const links: RelationGraphLink[] = related.map(({ relation }) => ({
      source: selected.id,
      target: relation.targetId,
      type: relation.type,
      tone: relation.tone,
    }));

    const svg = select(svgRef.current);
    svg.selectAll("*").remove();
    const viewport = svg.append("g").attr("class", "relation-graph-viewport");
    const linkLayer = viewport.append("g").attr("aria-hidden", "true");
    const labelLayer = viewport.append("g").attr("aria-hidden", "true");
    const nodeLayer = viewport.append("g");

    const linkSelection = linkLayer
      .selectAll<SVGLineElement, RelationGraphLink>("line")
      .data(links)
      .join("line")
      .attr("stroke", (link) => graphToneColor(link.tone))
      .attr("stroke-opacity", 0.55)
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", (link) =>
        link.tone === "neutral" ? "5 5" : null,
      );
    const labelSelection = labelLayer
      .selectAll<SVGTextElement, RelationGraphLink>("text")
      .data(links)
      .join("text")
      .attr("text-anchor", "middle")
      .attr("font-size", 12)
      .attr("fill", (link) => graphToneColor(link.tone))
      .attr("paint-order", "stroke")
      .attr("stroke", "var(--paper)")
      .attr("stroke-width", 5)
      .attr("stroke-linejoin", "round")
      .text((link) => link.type);

    const nodeSelection = nodeLayer
      .selectAll<SVGGElement, RelationGraphNode>("g")
      .data(nodes, (node) => node.id)
      .join((enter) => {
        const group = enter.append("g").style("cursor", "grab");
        group
          .append("circle")
          .attr("r", (node) => (node.central ? 30 : 24))
          .attr("fill", "var(--paper-elevated)")
          .attr("stroke", (node) =>
            node.central ? "var(--accent-warm)" : "var(--line-strong)",
          )
          .attr("stroke-width", (node) => (node.central ? 2.5 : 1.5));
        group
          .append("text")
          .attr("class", "node-name")
          .attr("text-anchor", "middle")
          .attr("dy", (node) => (node.central ? 5 : 4))
          .attr("font-size", (node) => (node.central ? 16 : 14))
          .attr("font-weight", 600)
          .attr("fill", "var(--ink)")
          .text((node) => node.name);
        group
          .append("text")
          .attr("class", "node-archetype")
          .attr("text-anchor", "middle")
          .attr("dy", (node) => (node.central ? 52 : 43))
          .attr("font-size", 12)
          .attr("fill", "var(--ink-muted)")
          .text((node) => node.archetype);
        group
          .append("foreignObject")
          .attr("x", -44)
          .attr("y", -40)
          .attr("width", 88)
          .attr("height", 94)
          .append("xhtml:button")
          .attr("type", "button")
          .attr("aria-label", (node) => `${node.name} ${node.archetype}`)
          .style("display", "block")
          .style("width", "100%")
          .style("height", "100%")
          .style("cursor", "grab")
          .style("border", "0")
          .style("background", "transparent");
        return group;
      });

    const simulation = forceSimulation<RelationGraphNode>(nodes)
      .alphaDecay(0.08)
      .force(
        "link",
        forceLink<RelationGraphNode, RelationGraphLink>(links)
          .id((node) => node.id)
          .distance(150)
          .strength(0.9),
      )
      .force("charge", forceManyBody<RelationGraphNode>().strength(-420))
      .force("center", forceCenter(width / 2, height / 2))
      .force(
        "collision",
        forceCollide<RelationGraphNode>().radius((node) =>
          node.central ? 78 : 64,
        ),
      );

    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.72, 1.75])
      .on("zoom", (event) => {
        viewport.attr("transform", event.transform);
      });
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);

    const dragBehavior = drag<SVGGElement, RelationGraphNode>()
      .on("start", (event, node) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        node.fx = node.x;
        node.fy = node.y;
      })
      .on("drag", (event, node) => {
        node.fx = event.x;
        node.fy = event.y;
      })
      .on("end", (event, node) => {
        if (!event.active) simulation.alphaTarget(0);
        if (!node.central) {
          node.fx = null;
          node.fy = null;
        }
      });
    nodeSelection.call(dragBehavior);
    nodeSelection
      .select<HTMLButtonElement>("button")
      .on("click", (event, node) => {
        event.stopPropagation();
        if (!node.central) onSelect(node.id);
      });

    simulation.on("tick", () => {
      linkSelection
        .attr("x1", (link) => (link.source as RelationGraphNode).x ?? 0)
        .attr("y1", (link) => (link.source as RelationGraphNode).y ?? 0)
        .attr("x2", (link) => (link.target as RelationGraphNode).x ?? 0)
        .attr("y2", (link) => (link.target as RelationGraphNode).y ?? 0);
      labelSelection
        .attr(
          "x",
          (link) =>
            (((link.source as RelationGraphNode).x ?? 0) +
              ((link.target as RelationGraphNode).x ?? 0)) /
            2,
        )
        .attr(
          "y",
          (link) =>
            (((link.source as RelationGraphNode).y ?? 0) +
              ((link.target as RelationGraphNode).y ?? 0)) /
            2,
        );
      nodeSelection.attr(
        "transform",
        (node) => `translate(${node.x ?? width / 2},${node.y ?? height / 2})`,
      );
    });

    return () => {
      simulation.stop();
      svg.on(".zoom", null);
      svg.selectAll("*").remove();
      zoomRef.current = null;
    };
  }, [characters, onSelect, related, selected]);

  const changeZoom = (scale: number) => {
    if (!svgRef.current || !zoomRef.current) return;
    select(svgRef.current).call(zoomRef.current.scaleBy, scale);
  };

  const resetZoom = () => {
    if (!svgRef.current || !zoomRef.current) return;
    select(svgRef.current).call(zoomRef.current.transform, zoomIdentity);
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)_18rem] max-xl:grid-cols-[16rem_minmax(0,1fr)] max-lg:grid-cols-1 max-lg:overflow-y-auto">
      <aside className="min-h-0 overflow-y-auto border-r border-[var(--line-subtle)] bg-[var(--paper-elevated)]/40 p-3 max-lg:max-h-64 max-lg:border-b max-lg:border-r-0">
        <p className="px-2 pb-2 text-xs font-semibold text-[var(--ink-muted)]">
          选择中心人物
        </p>
        <div className="space-y-1">
          {characters.map((character) => (
            <button
              key={character.id}
              type="button"
              onClick={() => onSelect(character.id)}
              className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left ${
                character.id === selected.id
                  ? "bg-[var(--accent-warm-subtle)]"
                  : "hover:bg-[var(--hover-bg)]"
              }`}
            >
              <CharacterMark character={character} size="small" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--ink)]">
                  {character.name}
                </span>
                <span className="block truncate text-xs text-[var(--ink-muted)]">
                  {character.archetype}
                </span>
              </span>
              <span className="text-xs text-[var(--ink-subtle)]">
                {character.relations.length}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className="relative min-h-[32rem] overflow-hidden bg-[var(--paper)] max-lg:min-h-[28rem]">
        <div className="absolute inset-x-6 top-5 z-10 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              {selected.name}的关系网络
            </h2>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              直接关系 {related.length} 条 · D3 力导向布局
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-[var(--ink-muted)] max-lg:hidden">
              <CircleDot className="h-3.5 w-3.5 text-[var(--success)]" />
              当前时间切片 · 第 18 章
            </span>
            <div className="flex items-center rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xs">
              <button
                type="button"
                onClick={() => changeZoom(1.18)}
                aria-label="放大关系图"
                title="放大关系图"
                className="flex h-8 w-8 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => changeZoom(0.84)}
                aria-label="缩小关系图"
                title="缩小关系图"
                className="flex h-8 w-8 items-center justify-center border-l border-[var(--line)] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={resetZoom}
                aria-label="复位关系图"
                title="复位关系图"
                className="flex h-8 w-8 items-center justify-center border-l border-[var(--line)] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <LocateFixed className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div className="absolute inset-x-3 bottom-3 top-16">
          <svg
            ref={svgRef}
            viewBox="0 0 760 520"
            className="h-full w-full"
            role="img"
            aria-label={`${selected.name}的人物关系图`}
          />
        </div>

        <div className="absolute bottom-5 left-5 z-10 flex items-center gap-4 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)]/90 px-3 py-2 text-xs text-[var(--ink-muted)] shadow-xs">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[var(--success)]" />
            同盟 / 亲近
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[var(--error)]" />
            对立 / 冲突
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[var(--warning)]" />
            中性关系
          </span>
        </div>
      </main>

      <aside className="min-h-0 overflow-y-auto border-l border-[var(--line-subtle)] bg-[var(--paper-elevated)]/40 px-4 py-5 max-xl:hidden">
        <h2 className="text-sm font-semibold text-[var(--ink)]">关系摘要</h2>
        <div className="mt-4 divide-y divide-[var(--line-subtle)]">
          {related.map(({ relation, character }) => (
            <button
              key={character.id}
              type="button"
              onClick={() => onSelect(character.id)}
              className="block w-full py-3 text-left"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-[var(--ink)]">
                  {character.name}
                </span>
                <span
                  className={`text-xs font-medium ${relationTone(relation.tone)}`}
                >
                  {relation.type}
                </span>
              </div>
              <p className="mt-1 line-clamp-3 text-xs leading-5 text-[var(--ink-muted)]">
                {relation.summary}
              </p>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

function AgentDesignDialog({
  initialScope,
  onClose,
  onCreate,
}: {
  readonly initialScope: CharacterAiScope;
  readonly onClose: () => void;
  readonly onCreate: (value: {
    readonly scope: CharacterAiScope;
    readonly requirements: string;
  }) => void;
}) {
  const [scope, setScope] = useState<CharacterAiScope>(initialScope);
  const [requirements, setRequirements] = useState("");
  const options: readonly {
    readonly id: CharacterAiScope;
    readonly label: string;
    readonly description: string;
    readonly placeholder: string;
  }[] = [
    {
      id: "character",
      label: "完整人物卡",
      description: "补齐身份、动机、能力、短板与叙事功能。",
      placeholder:
        "例如：设计一位能打破现有同盟平衡、但不重复既有角色功能的女性角色。",
    },
    {
      id: "relationship",
      label: "关系与弧光",
      description: "围绕现有角色补全关系张力、转折与成长线。",
      placeholder: "例如：为主角设计一条从互相利用到主动托付的关系弧光。",
    },
    {
      id: "soul",
      label: "角色灵魂",
      description: "生成表达、心智模型与决策倾向，不改写人物硬设定。",
      placeholder: "例如：设计一套适合冷静调查者的灵魂倾向，避免强化其控制欲。",
    },
    {
      id: "race",
      label: "种族设定",
      description: "定义族群特征、社会习俗和可用于角色选择的约束。",
      placeholder: "例如：补充一个与潮汐术法共生、但寿命短暂的沿海种族。",
    },
    {
      id: "group",
      label: "角色分组",
      description: "按故事线、阵营或冲突面组织角色分组。",
      placeholder: "例如：为京城权力线设计 3 个不重叠的角色分组。",
    },
  ];
  const activeOption = options.find((option) => option.id === scope)!;
  return (
    <OverlayBackdrop onClose={onClose} className="z-[250] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="character-agent-design-title"
        className="w-full max-w-lg rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-[var(--accent-warm)]" />
            <h2
              id="character-agent-design-title"
              className="text-lg font-semibold text-[var(--ink)]"
            >
              {activeOption.label} Agent
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-5 px-5 py-5">
          <label className="block">
            <span className="text-sm font-medium text-[var(--ink)]">
              设计要求
            </span>
            <textarea
              autoFocus
              value={requirements}
              onChange={(event) => setRequirements(event.target.value)}
              placeholder={activeOption.placeholder}
              rows={4}
              className="mt-2 w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm leading-6 text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
            />
          </label>
          <div>
            <span className="text-sm font-medium text-[var(--ink)]">
              生成范围
            </span>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setScope(option.id)}
                  className={`h-9 rounded-md border px-2 text-sm ${
                    scope === option.id
                      ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]"
                      : "border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)]"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="mt-3 border-l-2 border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)] px-3 py-2 text-xs leading-5 text-[var(--ink-secondary)]">
              <strong className="font-medium text-[var(--ink)]">
                {activeOption.label}
              </strong>
              <span className="ml-1">{activeOption.description}</span>
            </div>
          </div>
          <p className="text-xs leading-5 text-[var(--ink-muted)]">
            Agent 只会创建待审阅候选；正式人物库不会在生成时被直接改写。
          </p>
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() =>
              onCreate({ scope, requirements: requirements.trim() })
            }
            className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
          >
            <Sparkles className="h-3.5 w-3.5" />
            生成提案
          </button>
        </footer>
      </div>
    </OverlayBackdrop>
  );
}

function RaceEditorDialog({
  mode,
  race,
  onSave,
  onClose,
}: {
  readonly mode: "create" | "edit";
  readonly race?: RaceDefinition;
  readonly onSave: (value: { name: string; description: string }) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(race?.name ?? "");
  const [description, setDescription] = useState(race?.description ?? "");
  const editing = mode === "edit";
  const title = editing ? "编辑种族" : "新增种族";

  return (
    <OverlayBackdrop onClose={onClose} className="z-[250] px-4 py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="race-editor-title"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex items-center justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--accent-cool)]/10 text-[var(--accent-cool)]">
              <Dna className="h-4 w-4" />
            </span>
            <h2 id="race-editor-title" className="text-lg font-semibold">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`关闭${title}`}
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-4 px-5 py-5">
          <label className="block">
            <span className="text-sm font-medium text-[var(--ink)]">
              种族名称
            </span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：龙裔"
              className="mt-2 h-10 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-[var(--ink)]">
              种族说明
            </span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="补充体貌、寿命、文化或血脉特征"
              rows={3}
              className="mt-2 min-h-20 w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm leading-6 text-[var(--ink-secondary)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
            />
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() =>
              onSave({ name: name.trim(), description: description.trim() })
            }
            className="h-9 rounded-md bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {editing ? "保存" : "创建种族"}
          </button>
        </footer>
      </div>
    </OverlayBackdrop>
  );
}

function RaceManagementDialog({
  races,
  usageByRace,
  onUpdate,
  onCreate,
  onDelete,
  onOpenAiDesign,
  onClose,
}: {
  readonly races: readonly RaceDefinition[];
  readonly usageByRace: Readonly<Record<string, number>>;
  readonly onUpdate: (id: string, patch: Partial<RaceDefinition>) => void;
  readonly onCreate: (value: { name: string; description: string }) => void;
  readonly onDelete: (id: string) => void;
  readonly onOpenAiDesign?: () => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<RaceEditorState | null>(null);

  const filteredRaces = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return races;
    return races.filter((race) =>
      `${race.name} ${race.description}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalized),
    );
  }, [query, races]);

  const totalPages = Math.max(1, Math.ceil(filteredRaces.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRaces = filteredRaces.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const rangeStart =
    filteredRaces.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(currentPage * pageSize, filteredRaces.length);
  const editingRace =
    editor?.mode === "edit"
      ? races.find((race) => race.id === editor.raceId)
      : undefined;

  const saveEditor = (value: { name: string; description: string }) => {
    if (!editor) return;
    if (editor.mode === "create") {
      onCreate(value);
      setQuery("");
      setPage(Math.ceil((races.length + 1) / pageSize));
    } else {
      onUpdate(editor.raceId, value);
    }
    setEditor(null);
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200] px-4 py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="race-management-title"
        className="flex h-[calc(100vh-4rem)] max-h-[48rem] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--accent-cool)]/10 text-[var(--accent-cool)]">
              <Dna className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 id="race-management-title" className="text-lg font-semibold">
                种族管理
              </h2>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                项目内共 {races.length} 个种族定义
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭种族管理"
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid shrink-0 gap-2 border-b border-[var(--line-subtle)] px-5 py-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto_auto]">
          <label className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 focus-within:border-[var(--accent-warm)]">
            <Search className="h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="搜索种族名称或说明"
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setPage(1);
                }}
                aria-label="清空种族搜索"
                title="清空"
                className="text-[var(--ink-subtle)] hover:text-[var(--ink)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
          <CustomSelect
            value={String(pageSize)}
            options={[10, 20, 50].map((size) => ({
              value: String(size),
              label: `${size} 条 / 页`,
            }))}
            onChange={(value) => {
              setPageSize(Number(value));
              setPage(1);
            }}
            ariaLabel="每页种族数量"
            size="toolbar"
          />
          <button
            type="button"
            onClick={onOpenAiDesign}
            disabled={!onOpenAiDesign}
            className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--line-strong)] px-3 text-sm font-medium text-[var(--accent-cool)] hover:bg-[var(--accent-cool-subtle)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Sparkles className="h-3.5 w-3.5" />
            AI 生成
          </button>
          <button
            type="button"
            onClick={() => setEditor({ mode: "create" })}
            className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            新增种族
          </button>
        </div>

        <div className="hidden shrink-0 grid-cols-[minmax(8rem,0.8fr)_minmax(12rem,1.6fr)_6rem_5rem] gap-4 border-b border-[var(--line-subtle)] bg-[var(--paper)]/70 px-5 py-2 text-xs font-medium text-[var(--ink-muted)] sm:grid">
          <span>种族名称</span>
          <span>说明</span>
          <span>使用情况</span>
          <span className="text-right">操作</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5">
          {pageRaces.length > 0 ? (
            <div className="divide-y divide-[var(--line-subtle)]">
              {pageRaces.map((race) => {
                const usage = usageByRace[race.id] ?? 0;
                return (
                  <div
                    key={race.id}
                    className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 sm:grid-cols-[minmax(8rem,0.8fr)_minmax(12rem,1.6fr)_6rem_5rem] sm:gap-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[var(--ink)]">
                        {race.name || "未命名种族"}
                      </p>
                      <p className="mt-1 line-clamp-1 text-xs text-[var(--ink-muted)] sm:hidden">
                        {race.description || "暂无说明"}
                      </p>
                    </div>
                    <p className="hidden min-w-0 truncate text-sm text-[var(--ink-muted)] sm:block">
                      {race.description || "暂无说明"}
                    </p>
                    <span
                      className={`hidden w-fit rounded-full px-2 py-1 text-xs font-medium sm:inline-flex ${
                        usage > 0
                          ? "bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]"
                          : "bg-[var(--paper-inset)] text-[var(--ink-muted)]"
                      }`}
                    >
                      {usage > 0 ? `${usage} 位` : "未使用"}
                    </span>
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          setEditor({ mode: "edit", raceId: race.id })
                        }
                        aria-label={`编辑${race.name || "未命名种族"}`}
                        title="编辑种族"
                        className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(race.id)}
                        disabled={usage > 0}
                        aria-label={`删除${race.name || "未命名种族"}`}
                        title={
                          usage > 0 ? "请先调整引用此种族的角色" : "删除种族"
                        }
                        className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--ink-subtle)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-full min-h-48 flex-col items-center justify-center text-center">
              <Dna className="h-7 w-7 text-[var(--ink-subtle)]" />
              <p className="mt-3 text-sm font-medium">
                {query ? "没有匹配的种族" : "还没有种族定义"}
              </p>
            </div>
          )}
        </div>

        <footer className="grid shrink-0 items-center gap-3 border-t border-[var(--line)] px-5 py-3 sm:grid-cols-[1fr_auto_1fr]">
          <span className="text-xs text-[var(--ink-muted)]">
            显示 {rangeStart}-{rangeEnd}，共 {filteredRaces.length} 条
          </span>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
              aria-label="上一页"
              title="上一页"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-20 text-center text-sm text-[var(--ink-secondary)]">
              第 {currentPage} / {totalPages} 页
            </span>
            <button
              type="button"
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
              aria-label="下一页"
              title="下一页"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 justify-self-end rounded-md bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
          >
            完成
          </button>
        </footer>
      </div>

      {editor && (editor.mode === "create" || editingRace) && (
        <RaceEditorDialog
          key={
            editor.mode === "create" ? "create-race" : `edit-${editor.raceId}`
          }
          mode={editor.mode}
          race={editingRace}
          onSave={saveEditor}
          onClose={() => setEditor(null)}
        />
      )}
    </OverlayBackdrop>
  );
}

function SoulEditorDialog({
  soul,
  usageCount,
  onSave,
  onDelete,
  onClose,
}: {
  readonly soul?: CharacterSoulDefinition;
  readonly usageCount: number;
  readonly onSave: (value: CharacterSoulFormValue) => void;
  readonly onDelete?: () => void;
  readonly onClose: () => void;
}) {
  const [form, setForm] = useState<CharacterSoulFormValue>({
    name: soul?.name ?? "",
    category: soul?.category ?? "",
    summary: soul?.summary ?? "",
    expressionDna: soul?.expressionDna ?? "",
    mentalModel: soul?.mentalModel ?? "",
    decisionHeuristics: soul?.decisionHeuristics ?? "",
    valueAntiPatterns: soul?.valueAntiPatterns ?? "",
    boundaries:
      soul?.boundaries ??
      "角色硬设定、当前剧情与角色认知优先；灵魂不移植原型经历与身份。",
  });
  const editing = Boolean(soul);
  const updateField = <K extends keyof CharacterSoulFormValue>(
    field: K,
    value: CharacterSoulFormValue[K],
  ) => setForm((current) => ({ ...current, [field]: value }));
  const canSave =
    form.name.trim() &&
    form.summary.trim() &&
    form.expressionDna.trim() &&
    form.mentalModel.trim() &&
    form.decisionHeuristics.trim();

  return (
    <OverlayBackdrop className="z-[80]" onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "编辑角色灵魂" : "新建角色灵魂"}
        className="flex h-[min(48rem,calc(100vh-2rem))] w-[min(48rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--accent-cool-subtle)] text-[var(--accent-cool)]">
              <Fingerprint className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-[var(--ink)]">
                {editing ? "编辑角色灵魂" : "新建角色灵魂"}
              </h2>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                结构参考角色视角 Skill，不覆盖人物自身设定
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={editing ? "关闭编辑角色灵魂" : "关闭新建角色灵魂"}
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-medium text-[var(--ink-muted)]">
              灵魂名称
              <input
                value={form.name}
                onChange={(event) => updateField("name", event.target.value)}
                placeholder="例如：北境守夜人"
                className="mt-1.5 h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
              />
            </label>
            <label className="text-xs font-medium text-[var(--ink-muted)]">
              分类
              <input
                value={form.category}
                onChange={(event) =>
                  updateField("category", event.target.value)
                }
                placeholder="例如：谋略与责任"
                className="mt-1.5 h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
              />
            </label>
          </div>

          {(
            [
              [
                "summary",
                "灵魂定位",
                "一句话说明这个灵魂稳定提供什么气质与判断方式。",
                3,
              ],
              [
                "expressionDna",
                "表达 DNA",
                "说话习惯、用词偏好、句式和情绪外显方式。",
                4,
              ],
              [
                "mentalModel",
                "心智模型",
                "如何理解局面、关系、信息与因果。",
                4,
              ],
              [
                "decisionHeuristics",
                "决策启发式",
                "面对压力、风险与两难时如何做选择。",
                4,
              ],
              [
                "valueAntiPatterns",
                "价值观反模式",
                "哪些写法会让这个灵魂失真、扁平或过强。",
                4,
              ],
              [
                "boundaries",
                "诚实边界",
                "哪些内容绝不能覆盖人物小传、剧情事实和角色认知。",
                4,
              ],
            ] as const
          ).map(([field, label, placeholder, rows]) => (
            <label
              key={field}
              className="mt-4 block text-xs font-medium text-[var(--ink-muted)]"
            >
              {label}
              <textarea
                value={form[field]}
                onChange={(event) => updateField(field, event.target.value)}
                placeholder={placeholder}
                rows={rows}
                className="mt-1.5 w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm leading-6 text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
              />
            </label>
          ))}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-4">
          <div>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                disabled={usageCount > 0}
                title={
                  usageCount > 0 ? "请先解除引用此灵魂的角色" : "删除角色灵魂"
                }
                className="flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-[var(--error)] hover:bg-[var(--error-bg)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除灵魂
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={() =>
                onSave({
                  name: form.name.trim(),
                  category: form.category.trim() || "自定义灵魂",
                  summary: form.summary.trim(),
                  expressionDna: form.expressionDna.trim(),
                  mentalModel: form.mentalModel.trim(),
                  decisionHeuristics: form.decisionHeuristics.trim(),
                  valueAntiPatterns: form.valueAntiPatterns.trim(),
                  boundaries: form.boundaries.trim(),
                })
              }
              className="h-9 rounded-md bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editing ? "保存" : "创建灵魂"}
            </button>
          </div>
        </footer>
      </div>
    </OverlayBackdrop>
  );
}

function SoulLibraryPage({
  souls,
  characters,
  currentCharacter,
  usageBySoul,
  onBind,
  onCreate,
  onUpdate,
  onDelete,
  onOpenAiDesign,
  onClose,
}: {
  readonly souls: readonly CharacterSoulDefinition[];
  readonly characters: readonly CharacterRecord[];
  readonly currentCharacter: CharacterRecord | undefined;
  readonly usageBySoul: Readonly<Record<string, number>>;
  readonly onBind: (soulId: string) => void;
  readonly onCreate: (value: CharacterSoulFormValue) => string;
  readonly onUpdate: (id: string, value: CharacterSoulFormValue) => void;
  readonly onDelete: (id: string) => void;
  readonly onOpenAiDesign?: () => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "builtIn" | "custom">("all");
  const [selectedId, setSelectedId] = useState(
    currentCharacter?.soulId || souls[0]?.id || "",
  );
  const [editor, setEditor] = useState<SoulEditorState | null>(null);

  const visibleSouls = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return souls.filter((soul) => {
      if (scope === "builtIn" && !soul.builtIn) return false;
      if (scope === "custom" && soul.builtIn) return false;
      if (!normalized) return true;
      return `${soul.name} ${soul.category} ${soul.summary}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalized);
    });
  }, [query, scope, souls]);

  const selectedSoul =
    visibleSouls.find((soul) => soul.id === selectedId) ?? visibleSouls[0];
  const selectedCharacters = selectedSoul
    ? characters.filter((character) => character.soulId === selectedSoul.id)
    : [];
  const editingSoul =
    editor?.mode === "edit"
      ? souls.find((soul) => soul.id === editor.soulId)
      : undefined;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--paper)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--accent-cool-subtle)] text-[var(--accent-cool)]">
            <Fingerprint className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-[var(--ink)]">
              角色灵魂设计
            </h2>
            <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
              {souls.length} 个灵魂 ·{" "}
              {characters.filter((character) => character.soulId).length}{" "}
              位角色已绑定
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenAiDesign}
            disabled={!onOpenAiDesign}
            aria-label="AI 设计角色灵魂"
            title="AI 设计角色灵魂"
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-[var(--accent-cool)] hover:bg-[var(--accent-cool-subtle)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span className="max-sm:hidden">AI 设计</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="返回人物库"
            title="返回人物库"
            className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <ChevronLeft className="h-4 w-4" />
            返回人物库
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)] max-md:grid-cols-1">
        <aside className="flex min-h-0 flex-col border-r border-[var(--line)] bg-[var(--paper)] max-md:hidden">
          <div className="space-y-3 border-b border-[var(--line)] p-3">
            <div className="flex h-9 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 focus-within:border-[var(--accent-warm)]">
              <Search className="h-4 w-4 text-[var(--ink-subtle)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索灵魂名称或定位"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="清空灵魂搜索"
                  title="清空"
                  className="text-[var(--ink-subtle)] hover:text-[var(--ink)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="grid grid-cols-3 rounded-md bg-[var(--paper-inset)] p-0.5 text-xs">
              {(
                [
                  ["all", "全部"],
                  ["builtIn", "内置"],
                  ["custom", "自定义"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setScope(id)}
                  className={`h-7 rounded ${scope === id ? "bg-[var(--paper-elevated)] font-medium text-[var(--ink)] shadow-xs" : "text-[var(--ink-muted)] hover:text-[var(--ink)]"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setEditor({ mode: "create" })}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] text-sm font-medium text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
            >
              <Plus className="h-3.5 w-3.5" />
              新建自定义灵魂
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {visibleSouls.map((soul) => {
              const usage = usageBySoul[soul.id] ?? 0;
              const active = selectedSoul?.id === soul.id;
              return (
                <button
                  key={soul.id}
                  type="button"
                  onClick={() => setSelectedId(soul.id)}
                  className={`mb-1 w-full rounded-md border px-3 py-2.5 text-left transition-colors ${active ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]" : "border-transparent hover:bg-[var(--paper-inset)]"}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <strong className="truncate text-sm font-medium text-[var(--ink)]">
                      {soul.name}
                    </strong>
                    <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                      {usage > 0 ? `${usage} 位` : "未使用"}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                    {soul.category} · {soul.builtIn ? "内置" : "项目自定义"}
                  </span>
                </button>
              );
            })}
            {visibleSouls.length === 0 && (
              <div className="flex h-40 items-center justify-center text-sm text-[var(--ink-muted)]">
                没有匹配的角色灵魂
              </div>
            )}
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto px-6 py-5">
          {selectedSoul ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-[var(--ink)]">
                      {selectedSoul.name}
                    </h3>
                    <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
                      {selectedSoul.builtIn ? "内置灵魂" : "自定义灵魂"}
                    </span>
                    <span className="rounded bg-[var(--accent-cool-subtle)] px-1.5 py-0.5 text-xs text-[var(--accent-cool)]">
                      {selectedSoul.category}
                    </span>
                  </div>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--ink-secondary)]">
                    {selectedSoul.summary}
                  </p>
                  {selectedCharacters.length > 0 && (
                    <p className="mt-2 text-xs text-[var(--ink-muted)]">
                      已绑定：
                      {selectedCharacters
                        .map((character) => character.name)
                        .join("、")}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!selectedSoul.builtIn && (
                    <button
                      type="button"
                      onClick={() =>
                        setEditor({ mode: "edit", soulId: selectedSoul.id })
                      }
                      aria-label={`编辑${selectedSoul.name}`}
                      title="编辑灵魂"
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {currentCharacter && (
                    <button
                      type="button"
                      disabled={currentCharacter.soulId === selectedSoul.id}
                      onClick={() => onBind(selectedSoul.id)}
                      className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {currentCharacter.soulId === selectedSoul.id ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Link2 className="h-3.5 w-3.5" />
                      )}
                      {currentCharacter.soulId === selectedSoul.id
                        ? `已绑定${currentCharacter.name}`
                        : `绑定到${currentCharacter.name}`}
                    </button>
                  )}
                </div>
              </div>

              <div className="grid gap-x-8 gap-y-5 border-b border-[var(--line)] py-5 md:grid-cols-2">
                {[
                  ["表达 DNA", selectedSoul.expressionDna, Fingerprint],
                  ["心智模型", selectedSoul.mentalModel, Brain],
                  ["决策启发式", selectedSoul.decisionHeuristics, Target],
                  ["价值观反模式", selectedSoul.valueAntiPatterns, Shield],
                ].map(([label, value, Icon]) => {
                  const DetailIcon = Icon as LucideIcon;
                  return (
                    <div key={label as string} className="flex gap-3">
                      <DetailIcon className="mt-1 h-4 w-4 shrink-0 text-[var(--accent-cool)]" />
                      <div>
                        <p className="text-xs font-semibold text-[var(--ink-muted)]">
                          {label as string}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-[var(--ink-secondary)]">
                          {value as string}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              <section className="border-t border-[var(--line)] pt-5">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-[var(--success)]" />
                  <h4 className="text-sm font-semibold text-[var(--ink)]">
                    绑定规则
                  </h4>
                </div>
                <p className="mt-3 text-sm leading-6 text-[var(--ink-secondary)]">
                  灵魂库只维护灵魂本身与绑定关系。冲突审阅只在角色页为某个角色预选某个灵魂时触发，不对所有角色和灵魂做批量矩阵计算。
                </p>
              </section>
            </>
          ) : (
            <div className="flex h-full min-h-80 items-center justify-center text-sm text-[var(--ink-muted)]">
              选择一个角色灵魂查看详情
            </div>
          )}
        </main>
      </div>

      {editor && (editor.mode === "create" || editingSoul) && (
        <SoulEditorDialog
          key={editor.mode === "create" ? "create-soul" : editor.soulId}
          soul={editingSoul}
          usageCount={editingSoul ? (usageBySoul[editingSoul.id] ?? 0) : 0}
          onSave={(value) => {
            if (editor.mode === "create") {
              const id = onCreate(value);
              setScope("custom");
              setQuery("");
              setSelectedId(id);
            } else {
              onUpdate(editor.soulId, value);
            }
            setEditor(null);
          }}
          onDelete={
            editingSoul
              ? () => {
                  onDelete(editingSoul.id);
                  setEditor(null);
                  setSelectedId(
                    souls.find((soul) => soul.id !== editingSoul.id)?.id ?? "",
                  );
                }
              : undefined
          }
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

function GroupEditorDialog({
  mode,
  group,
  usageCount,
  onSave,
  onDelete,
  onClose,
}: {
  readonly mode: "create" | "edit";
  readonly group?: CharacterGroupDefinition;
  readonly usageCount: number;
  readonly onSave: (value: { name: string; description: string }) => void;
  readonly onDelete?: () => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const editing = mode === "edit";
  const title = editing ? "编辑角色分组" : "新增角色分组";

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200] px-4 py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-editor-title"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex items-center justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--accent-cool)]/10 text-[var(--accent-cool)]">
              <Folder className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 id="group-editor-title" className="text-lg font-semibold">
                {title}
              </h2>
              {editing && (
                <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                  {usageCount > 0 ? `${usageCount} 位角色` : "尚未使用"}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`关闭${title}`}
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-5">
          <label className="block">
            <span className="text-sm font-medium text-[var(--ink)]">
              分组名称
            </span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：北境线"
              className="mt-2 h-10 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-[var(--ink)]">
              分组说明
            </span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="补充分组范围或剧情线索"
              rows={3}
              className="mt-2 min-h-20 w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm leading-6 text-[var(--ink-secondary)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
            />
          </label>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-4">
          <div>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                disabled={usageCount > 0}
                title={usageCount > 0 ? "请先移出引用此分组的角色" : "删除分组"}
                className="flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-[var(--error)] hover:bg-[var(--error-bg)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除分组
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!name.trim()}
              onClick={() =>
                onSave({ name: name.trim(), description: description.trim() })
              }
              className="h-9 rounded-md bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editing ? "保存" : "创建分组"}
            </button>
          </div>
        </footer>
      </div>
    </OverlayBackdrop>
  );
}

export default function CharacterLibraryPrototype({
  storage,
  projectTitle,
  isActive,
  onOpenAiAgent,
  isAiAgentLaunching = false,
  proposalReviewOpen = false,
  onOpenProposalReview,
  onCloseProposalReview,
}: CharacterLibraryPrototypeProps) {
  const repository = useMemo(
    () => createNovelCharacterLibraryRepository(storage),
    [storage],
  );
  const itemLibraryRepository = useMemo(
    () => createNovelItemLibraryRepository(storage),
    [storage],
  );
  const [library, setLibrary] = useState<LoadedCharacterLibrary | null>(null);
  const [characters, setCharacters] = useState<CharacterRecord[]>([]);
  const [races, setRaces] = useState<RaceDefinition[]>([]);
  const [souls, setSouls] = useState<CharacterSoulDefinition[]>([]);
  const [groups, setGroups] = useState<CharacterGroupDefinition[]>([]);
  const [cultivationEcology, setCultivationEcology] =
    useState<CultivationEcology | null>(null);
  const [ungroupedGroup, setUngroupedGroup] =
    useState<CharacterGroupDefinition>({
      id: UNGROUPED_FILTER,
      name: "未分组",
      description: "尚未加入任何角色分组的角色。",
    });
  const [selectedId, setSelectedId] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | RoleWeight>("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("profile");
  const [view, setView] = useState<LibraryView>("characters");
  const [editing, setEditing] = useState(false);
  const [agentDialog, setAgentDialog] = useState(false);
  const [raceDialog, setRaceDialog] = useState(false);
  const [groupEditor, setGroupEditor] = useState<GroupEditorState | null>(null);
  const [agentDialogScope, setAgentDialogScope] =
    useState<CharacterAiScope>("character");
  const [proposalCreated, setProposalCreated] = useState(false);
  const [itemEntries, setItemEntries] = useState<ItemIndexEntry[]>([]);
  const [itemLibraryLoading, setItemLibraryLoading] = useState(false);
  const [itemLibraryError, setItemLibraryError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const libraryRef = useRef<LoadedCharacterLibrary | null>(library);
  const charactersRef = useRef(characters);
  const isDirtyRef = useRef(isDirty);
  const savingPromiseRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    libraryRef.current = library;
  }, [library]);
  useEffect(() => {
    charactersRef.current = characters;
  }, [characters]);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  const applyLibrary = useCallback((next: LoadedCharacterLibrary) => {
    libraryRef.current = next;
    charactersRef.current = next.index.characters;
    setLibrary(next);
    setCharacters(next.index.characters);
    setRaces(next.meta.races);
    setSouls(next.meta.souls);
    setGroups(next.meta.groups);
    setUngroupedGroup(next.meta.ungroupedGroup);
    setSelectedId((current) =>
      next.index.characters.some((character) => character.id === current)
        ? current
        : (next.index.characters[0]?.id ?? ""),
    );
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      applyLibrary(await repository.load());
      setIsDirty(false);
      isDirtyRef.current = false;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, [applyLibrary, repository]);

  const refreshItemLibrary = useCallback(async () => {
    setItemLibraryLoading(true);
    setItemLibraryError(null);
    try {
      const itemLibrary = await itemLibraryRepository.load();
      setItemEntries(itemLibrary.index.items);
    } catch (cause) {
      setItemLibraryError(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setItemLibraryLoading(false);
    }
  }, [itemLibraryRepository]);

  useEffect(() => {
    if (!isActive || detailTab !== "inventory") return;
    void refreshItemLibrary();
  }, [detailTab, isActive, refreshItemLibrary]);

  const saveCharacters = useCallback(async (): Promise<boolean> => {
    if (savingPromiseRef.current) return savingPromiseRef.current;
    const activeLibrary = libraryRef.current;
    if (!activeLibrary || !isDirtyRef.current) return true;
    const snapshot = charactersRef.current;
    const normalizedSnapshot = snapshot.map(ensureCharacterCultivationProfile);
    const operation = (async () => {
      setIsSaving(true);
      setError(null);
      try {
        const saved = await repository.saveCharacters(
          activeLibrary,
          normalizedSnapshot,
        );
        const latestCharacters = charactersRef.current;
        const next =
          latestCharacters === snapshot
            ? saved
            : {
                ...saved,
                index: {
                  ...saved.index,
                  characters: latestCharacters.map(
                    ensureCharacterCultivationProfile,
                  ),
                },
              };
        libraryRef.current = next;
        setLibrary(next);
        if (latestCharacters === snapshot) {
          isDirtyRef.current = false;
          setIsDirty(false);
        }
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setIsSaving(false);
      }
    })();
    savingPromiseRef.current = operation;
    void operation.finally(() => {
      if (savingPromiseRef.current === operation)
        savingPromiseRef.current = null;
    });
    return operation;
  }, [repository]);

  const flushCharacters = useCallback(async (): Promise<boolean> => {
    while (isDirtyRef.current) {
      if (!(await saveCharacters())) return false;
    }
    return true;
  }, [saveCharacters]);

  const updateMeta = useCallback(
    async (nextMeta: CharacterLibraryMeta) => {
      const activeLibrary = libraryRef.current;
      if (!activeLibrary) return false;
      setIsSaving(true);
      setError(null);
      try {
        const saved = await repository.saveMeta(activeLibrary, nextMeta);
        applyLibrary(saved);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [applyLibrary, repository],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let disposed = false;
    if (!storage.isAvailable) {
      setCultivationEcology(null);
      return () => {
        disposed = true;
      };
    }
    void storage
      .stat(["world/cultivation-ecology.json"])
      .then(async ([entry]) => {
        if (!entry?.exists) return null;
        const file = await storage.readText("world/cultivation-ecology.json");
        let parsed: unknown;
        try {
          parsed = JSON.parse(file.content);
        } catch {
          return null;
        }
        const result = cultivationEcologySchema.safeParse(parsed);
        return result.success ? result.data : null;
      })
      .then((next) => {
        if (!disposed) setCultivationEcology(next);
      })
      .catch(() => {
        if (!disposed) setCultivationEcology(null);
      });
    return () => {
      disposed = true;
    };
  }, [storage]);

  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (isActive && !wasActiveRef.current && !isDirtyRef.current) void load();
    wasActiveRef.current = isActive;
  }, [isActive, load]);

  useEffect(() => {
    if (!isDirty || isSaving) return;
    const timer = window.setTimeout(() => void saveCharacters(), 650);
    return () => window.clearTimeout(timer);
  }, [characters, isDirty, isSaving, saveCharacters]);

  useEffect(
    () => () => {
      if (isDirtyRef.current) void saveCharacters();
    },
    [saveCharacters],
  );

  const filteredCharacters = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return characters.filter((character) => {
      if (roleFilter !== "all" && character.roleWeight !== roleFilter) {
        return false;
      }
      if (
        groupFilter === UNGROUPED_FILTER
          ? character.groupIds.length > 0
          : groupFilter !== "all" && !character.groupIds.includes(groupFilter)
      ) {
        return false;
      }
      if (!normalized) return true;
      return `${character.name} ${character.alias} ${character.summary} ${character.identities.join(" ")}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalized);
    });
  }, [characters, groupFilter, query, roleFilter]);

  const hasActiveFilters =
    Boolean(query.trim()) || roleFilter !== "all" || groupFilter !== "all";
  const clearCharacterFilters = () => {
    setQuery("");
    setRoleFilter("all");
    setGroupFilter("all");
  };

  const selectedCharacter =
    characters.find((character) => character.id === selectedId) ??
    characters[0];
  const selectedCharacterId = selectedCharacter?.id;

  useEffect(() => {
    if (
      filteredCharacters.length === 0 ||
      filteredCharacters.some((character) => character.id === selectedId)
    ) {
      return;
    }
    setSelectedId(filteredCharacters[0].id);
    setEditing(false);
  }, [filteredCharacters, selectedId]);

  const raceUsageById = useMemo(
    () =>
      characters.reduce<Record<string, number>>((counts, character) => {
        if (character.raceId) {
          counts[character.raceId] = (counts[character.raceId] ?? 0) + 1;
        }
        return counts;
      }, {}),
    [characters],
  );

  const soulUsageById = useMemo(
    () =>
      characters.reduce<Record<string, number>>((counts, character) => {
        if (character.soulId) {
          counts[character.soulId] = (counts[character.soulId] ?? 0) + 1;
        }
        return counts;
      }, {}),
    [characters],
  );

  const groupUsageById = useMemo(
    () =>
      characters.reduce<Record<string, number>>((counts, character) => {
        character.groupIds.forEach((groupId) => {
          counts[groupId] = (counts[groupId] ?? 0) + 1;
        });
        return counts;
      }, {}),
    [characters],
  );

  const ungroupedCount = characters.filter(
    (character) => character.groupIds.length === 0,
  ).length;

  const updateCharacters = useCallback(
    (updater: (current: readonly CharacterRecord[]) => CharacterRecord[]) => {
      setCharacters((current) =>
        (() => {
          const next = updater(current);
          charactersRef.current = next;
          return next;
        })(),
      );
      isDirtyRef.current = true;
      setIsDirty(true);
    },
    [],
  );

  const updateCharacter: CharacterChangeHandler = (patch) => {
    if (!selectedCharacter) return;
    updateCharacters((current) =>
      current.map((character) =>
        character.id === selectedCharacter.id
          ? { ...character, ...patch }
          : character,
      ),
    );
  };

  const saveCurrentCharacter = useCallback(
    () => flushCharacters(),
    [flushCharacters],
  );

  const finishEditing = useCallback(async () => {
    if (!selectedCharacterId) return;
    updateCharacters((current) =>
      current.map((character) =>
        character.id === selectedCharacterId
          ? {
              ...character,
              identities: character.identities
                .map((identity) => identity.trim())
                .filter(Boolean),
              realmProgressNodes: character.realmProgressNodes
                .map((node) => node.trim())
                .filter(Boolean),
            }
          : character,
      ),
    );
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
    if (await saveCurrentCharacter()) setEditing(false);
  }, [saveCurrentCharacter, selectedCharacterId, updateCharacters]);

  useEffect(() => {
    if (!editing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveCurrentCharacter();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === "Enter" &&
        !isSaving
      ) {
        event.preventDefault();
        void finishEditing();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, finishEditing, isSaving, saveCurrentCharacter]);

  const updateRace = (id: string, patch: Partial<RaceDefinition>) => {
    const activeMeta = libraryRef.current?.meta;
    if (!activeMeta) return;
    void updateMeta({
      ...activeMeta,
      races: activeMeta.races.map((race) =>
        race.id === id ? { ...race, ...patch } : race,
      ),
    });
  };

  const addRace = (value: { name: string; description: string }) => {
    const activeMeta = libraryRef.current?.meta;
    if (!activeMeta) return;
    const id = createLibraryId("race");
    void updateMeta({
      ...activeMeta,
      races: [...activeMeta.races, { id, ...value }],
    });
  };

  const deleteRace = (id: string) => {
    if ((raceUsageById[id] ?? 0) > 0) return;
    const activeMeta = libraryRef.current?.meta;
    if (!activeMeta) return;
    void updateMeta({
      ...activeMeta,
      races: activeMeta.races.filter((race) => race.id !== id),
    });
  };

  const addSoul = (value: CharacterSoulFormValue) => {
    const activeMeta = libraryRef.current?.meta;
    if (!activeMeta) return "";
    const id = createLibraryId("soul");
    void updateMeta({
      ...activeMeta,
      souls: [
        ...activeMeta.souls,
        {
          id,
          builtIn: false,
          ...value,
          expressionConflictKeywords: [],
          decisionConflictKeywords: [],
          valueConflictKeywords: [],
          amplificationKeywords: [],
        },
      ],
    });
    return id;
  };

  const updateSoul = (id: string, value: CharacterSoulFormValue) => {
    const activeMeta = libraryRef.current?.meta;
    if (!activeMeta) return;
    void updateMeta({
      ...activeMeta,
      souls: activeMeta.souls.map((soul) =>
        soul.id === id ? { ...soul, ...value } : soul,
      ),
    });
  };

  const deleteSoul = (id: string) => {
    if ((soulUsageById[id] ?? 0) > 0) return;
    const activeMeta = libraryRef.current?.meta;
    if (!activeMeta) return;
    void updateMeta({
      ...activeMeta,
      souls: activeMeta.souls.filter((soul) => soul.id !== id || soul.builtIn),
    });
  };

  const updateGroup = (
    id: string,
    patch: Partial<CharacterGroupDefinition>,
  ) => {
    const activeMeta = libraryRef.current?.meta;
    if (!activeMeta) return;
    void updateMeta({
      ...activeMeta,
      groups: activeMeta.groups.map((group) =>
        group.id === id ? { ...group, ...patch } : group,
      ),
    });
  };

  const deleteGroup = (id: string) => {
    if ((groupUsageById[id] ?? 0) > 0) return;
    const activeMeta = libraryRef.current?.meta;
    if (!activeMeta) return;
    void updateMeta({
      ...activeMeta,
      groups: activeMeta.groups.filter((group) => group.id !== id),
    });
    if (groupFilter === id) setGroupFilter("all");
  };

  const saveGroupEditor = (value: { name: string; description: string }) => {
    if (!groupEditor) return;
    if (groupEditor.mode === "create") {
      const activeMeta = libraryRef.current?.meta;
      if (activeMeta) {
        void updateMeta({
          ...activeMeta,
          groups: [
            ...activeMeta.groups,
            { id: createLibraryId("group"), ...value },
          ],
        });
      }
    } else if (groupEditor.groupId === UNGROUPED_FILTER) {
      const activeMeta = libraryRef.current?.meta;
      if (activeMeta) {
        void updateMeta({
          ...activeMeta,
          ungroupedGroup: { ...activeMeta.ungroupedGroup, ...value },
        });
      }
    } else {
      updateGroup(groupEditor.groupId, value);
    }
    setGroupEditor(null);
  };

  const createBlankCharacter = () => {
    const id = createLibraryId("character");
    const blank: CharacterRecord = {
      id,
      name: "未命名角色",
      alias: "",
      roleWeight: "secondary",
      archetype: "待定",
      alignment: "绝对中立",
      status: "草稿",
      summary: "",
      identities: [],
      age: "",
      currentRealm: "",
      realmProgressNodes: [],
      baseLifespan: "",
      lifespanLoss: "",
      spiritRoot: "",
      daoBody: "",
      cultivationMethod: "",
      cultivationProfile: { ...EMPTY_CULTIVATION_PROFILE },
      gender: "",
      raceId: races[0]?.id ?? "",
      soulId: "",
      groupIds: [],
      hometown: "",
      appearance: "",
      personality: "",
      values: "",
      strengths: "",
      weaknesses: "",
      fears: "",
      motivation: "",
      goals: "",
      innerConflict: "",
      background: "",
      abilities: "",
      speechStyle: "",
      habits: "",
      signatureItem: "",
      inventory: [],
      storyRole: "",
      arc: "",
      firstAppearance: "未安排",
      completeness: 8,
      relations: [],
      appearances: [],
      arcStages: [],
    };
    updateCharacters((current) => [blank, ...current]);
    setSelectedId(id);
    setRoleFilter("all");
    setGroupFilter("all");
    setView("characters");
    setDetailTab("profile");
    setEditing(true);
  };

  const openAgentDialog = (scope: CharacterAiScope) => {
    setAgentDialogScope(scope);
    setAgentDialog(true);
  };

  const createAgentProposal = (value: {
    readonly scope: CharacterAiScope;
    readonly requirements: string;
  }) => {
    setAgentDialog(false);
    if (!onOpenAiAgent) return;
    setProposalCreated(true);
    window.setTimeout(() => setProposalCreated(false), 2600);
    void onOpenAiAgent({
      ...value,
      ...(selectedCharacter &&
      (value.scope === "character" || value.scope === "relationship")
        ? { targetCharacterId: selectedCharacter.id }
        : {}),
    }).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  const selectCharacter = (id: string) => {
    setSelectedId(id);
    setEditing(false);
    if (view === "characters") setDetailTab("profile");
  };

  const groupEditorTarget =
    groupEditor?.mode === "edit"
      ? groupEditor.groupId === UNGROUPED_FILTER
        ? ungroupedGroup
        : groups.find((group) => group.id === groupEditor.groupId)
      : undefined;

  const groupEditorUsage = groupEditorTarget
    ? groupEditorTarget.id === UNGROUPED_FILTER
      ? ungroupedCount
      : (groupUsageById[groupEditorTarget.id] ?? 0)
    : 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-2 max-md:flex-wrap">
        <div className="flex min-w-0 items-center gap-3">
          <Users className="h-5 w-5 shrink-0 text-[var(--accent-warm)]" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">人物库</h1>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              {projectTitle} · {characters.length} 位角色 ·{" "}
              {isSaving ? "保存中" : isDirty ? "待保存" : "已保存"}
            </p>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <div className="flex rounded-md bg-[var(--paper-inset)] p-0.5">
            <button
              type="button"
              onClick={() => setView("characters")}
              className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm ${
                view === "characters"
                  ? "bg-[var(--paper-elevated)] font-medium text-[var(--ink)] shadow-xs"
                  : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
              }`}
            >
              <UserRound className="h-3.5 w-3.5" />
              人物档案
            </button>
            <button
              type="button"
              onClick={() => setView("network")}
              className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm ${
                view === "network"
                  ? "bg-[var(--paper-elevated)] font-medium text-[var(--ink)] shadow-xs"
                  : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
              }`}
            >
              <Network className="h-3.5 w-3.5" />
              关系图谱
            </button>
          </div>
          <button
            type="button"
            onClick={() => setView("souls")}
            aria-label="角色灵魂设计"
            title="角色灵魂设计"
            className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm ${view === "souls" ? "bg-[var(--accent-cool-subtle)] font-medium text-[var(--accent-cool)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
          >
            <Fingerprint className="h-3.5 w-3.5" />
            <span className="max-xl:hidden">灵魂设计</span>
          </button>
          <button
            type="button"
            onClick={() => setRaceDialog(true)}
            aria-label="种族管理"
            title="种族管理"
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <Dna className="h-3.5 w-3.5" />
            <span className="max-xl:hidden">种族管理</span>
          </button>
          <button
            type="button"
            onClick={onOpenProposalReview}
            disabled={!onOpenProposalReview}
            aria-label="审阅角色设计提案"
            title="审阅角色设计提案"
            className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] px-2.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <GitBranch className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
            <span className="max-xl:hidden">审阅提案</span>
          </button>
          <button
            type="button"
            onClick={() => openAgentDialog("character")}
            disabled={!onOpenAiAgent || isAiAgentLaunching}
            aria-label="Agent 设计角色"
            title="Agent 设计角色"
            className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] px-2.5 text-sm font-medium hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Sparkles className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
            <span className="max-lg:hidden">
              {isAiAgentLaunching ? "正在打开" : "AI 设计角色"}
            </span>
          </button>
          <button
            type="button"
            onClick={createBlankCharacter}
            className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-2.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            新建角色
          </button>
        </div>
      </header>

      {proposalCreated && (
        <div className="absolute right-4 top-16 z-40 flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm shadow-md">
          <Check className="h-4 w-4 text-[var(--success)]" />
          角色设计 Agent 已打开
        </div>
      )}

      {error && library && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line-subtle)] bg-[var(--warning-bg)] px-4 py-2 text-xs text-[var(--warning)]">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            重新载入
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--line-strong)] border-t-[var(--accent-warm)]" />
          正在读取人物库
        </div>
      ) : error && !library ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-[var(--error)]">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="h-8 rounded-md bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
          >
            重新读取
          </button>
        </div>
      ) : !selectedCharacter && view !== "souls" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <Users className="h-6 w-6 text-[var(--accent-warm)]" />
          <p className="mt-3 text-sm font-medium">人物库尚无角色</p>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            从一张人物卡开始建立项目角色设定。
          </p>
          <button
            type="button"
            onClick={createBlankCharacter}
            className="mt-4 flex h-8 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            新建角色
          </button>
        </div>
      ) : view === "souls" ? (
        <SoulLibraryPage
          souls={souls}
          characters={characters}
          currentCharacter={selectedCharacter}
          usageBySoul={soulUsageById}
          onBind={(soulId) => updateCharacter({ soulId })}
          onCreate={addSoul}
          onUpdate={updateSoul}
          onDelete={deleteSoul}
          onOpenAiDesign={
            onOpenAiAgent ? () => openAgentDialog("soul") : undefined
          }
          onClose={() => setView("characters")}
        />
      ) : view === "network" ? (
        <RelationNetwork
          characters={characters}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[13rem_18rem_minmax(0,1fr)] max-xl:grid-cols-[11.5rem_16rem_minmax(0,1fr)] max-lg:grid-cols-[16rem_minmax(0,1fr)] max-md:block max-md:overflow-y-auto">
          <aside className="min-h-0 overflow-y-auto border-r border-[var(--line-subtle)] bg-[var(--paper-elevated)]/40 px-3 py-4 max-lg:hidden">
            <div className="flex items-center justify-between gap-2 px-2">
              <p className="text-xs font-semibold text-[var(--ink-muted)]">
                角色分组
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => openAgentDialog("group")}
                  disabled={!onOpenAiAgent}
                  aria-label="AI 设计角色分组"
                  title="AI 设计角色分组"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--accent-cool)] hover:bg-[var(--accent-cool-subtle)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setGroupEditor({ mode: "create" })}
                  aria-label="新增角色分组"
                  title="新增角色分组"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <nav className="mt-2 space-y-1">
              <button
                type="button"
                onClick={() => setGroupFilter("all")}
                className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm ${
                  groupFilter === "all"
                    ? "bg-[var(--accent-warm-subtle)] font-medium text-[var(--accent-warm)]"
                    : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                }`}
              >
                <Users className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate text-left">
                  全部角色
                </span>
                <span className="text-xs opacity-70">{characters.length}</span>
              </button>
              {groups.map((group) => (
                <div
                  key={group.id}
                  className={`group flex h-9 w-full items-center rounded-md text-sm ${
                    groupFilter === group.id
                      ? "bg-[var(--accent-warm-subtle)] font-medium text-[var(--accent-warm)]"
                      : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setGroupFilter(group.id)}
                    className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left"
                  >
                    <Folder className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {group.name || "未命名分组"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setGroupEditor({ mode: "edit", groupId: group.id })
                    }
                    aria-label={`编辑${group.name || "未命名分组"}`}
                    title="编辑分组"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <span className="w-6 shrink-0 pr-2 text-right text-xs opacity-70">
                    {groupUsageById[group.id] ?? 0}
                  </span>
                </div>
              ))}
              <div
                className={`group flex h-9 w-full items-center rounded-md text-sm ${
                  groupFilter === UNGROUPED_FILTER
                    ? "bg-[var(--accent-warm-subtle)] font-medium text-[var(--accent-warm)]"
                    : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setGroupFilter(UNGROUPED_FILTER)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left"
                >
                  <Folder className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {ungroupedGroup.name || "未分组"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setGroupEditor({
                      mode: "edit",
                      groupId: UNGROUPED_FILTER,
                    })
                  }
                  aria-label={`编辑${ungroupedGroup.name || "未分组"}`}
                  title="编辑分组"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--ink-subtle)] hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                </button>
                <span className="w-6 shrink-0 pr-2 text-right text-xs opacity-70">
                  {ungroupedCount}
                </span>
              </div>
            </nav>

            <div className="mt-6 border-t border-[var(--line-subtle)] pt-4">
              <p className="px-2 text-xs font-semibold text-[var(--ink-muted)]">
                阵容检查
              </p>
              <dl className="mt-3 space-y-3 px-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[var(--ink-muted)]">核心阵容</dt>
                  <dd className="font-medium text-[var(--success)]">完整</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[var(--ink-muted)]">价值观冲突</dt>
                  <dd className="font-medium text-[var(--ink)]">3 组</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[var(--ink-muted)]">孤立角色</dt>
                  <dd className="font-medium text-[var(--warning)]">1 位</dd>
                </div>
              </dl>
            </div>

            <button
              type="button"
              className="mt-5 flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              <Archive className="h-4 w-4" />
              已归档
              <span className="ml-auto text-xs">2</span>
            </button>
          </aside>

          <section className="flex min-h-0 flex-col border-r border-[var(--line-subtle)] bg-[var(--paper-elevated)]/20 max-md:max-h-80 max-md:border-b max-md:border-r-0">
            <div className="shrink-0 border-b border-[var(--line-subtle)] p-3">
              <label className="flex h-9 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 focus-within:border-[var(--accent-warm)]">
                <Search className="h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索姓名、身份或简介"
                  className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="清空搜索"
                    title="清空搜索"
                    className="text-[var(--ink-subtle)] hover:text-[var(--ink)]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </label>
              <div className="mt-2 flex items-center gap-2">
                <CustomSelect
                  value={roleFilter}
                  options={ROLE_FILTERS.map((filter) => {
                    const Icon = filter.icon;
                    return {
                      value: filter.id,
                      label: filter.label,
                      icon: <Icon className="h-3.5 w-3.5" />,
                    };
                  })}
                  onChange={(value) =>
                    setRoleFilter(value as "all" | RoleWeight)
                  }
                  ariaLabel="筛选戏份权重"
                  size="toolbar"
                  className="min-w-0 flex-1"
                />
                <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                  {filteredCharacters.length} 位
                </span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {filteredCharacters.map((character) => (
                <button
                  key={character.id}
                  type="button"
                  onClick={() => selectCharacter(character.id)}
                  className={`mb-1 flex w-full gap-3 rounded-md px-2.5 py-2.5 text-left ${
                    selectedCharacter.id === character.id
                      ? "bg-[var(--accent-warm-subtle)]"
                      : "hover:bg-[var(--hover-bg)]"
                  }`}
                >
                  <CharacterMark character={character} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <strong className="truncate text-sm font-semibold text-[var(--ink)]">
                        {character.name}
                      </strong>
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium ${roleTone(character.roleWeight)}`}
                      >
                        {ROLE_LABELS[character.roleWeight]}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                      {character.summary || "尚未填写人物简介"}
                    </span>
                    <span className="mt-1.5 flex items-center gap-2 text-xs text-[var(--ink-subtle)]">
                      <span>{character.archetype}</span>
                      <span>·</span>
                      <span>{character.completeness}%</span>
                    </span>
                  </span>
                </button>
              ))}
              {filteredCharacters.length === 0 && (
                <div className="flex h-40 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-[var(--ink-muted)]">
                  <span>没有匹配的角色</span>
                  {hasActiveFilters && (
                    <button
                      type="button"
                      onClick={clearCharacterFilters}
                      className="h-7 rounded-md px-2 text-xs font-medium text-[var(--accent-cool)] hover:bg-[var(--accent-cool-subtle)]"
                    >
                      清除全部筛选
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>

          <main className="min-h-0 overflow-y-auto bg-[var(--paper)]">
            {filteredCharacters.length === 0 && hasActiveFilters && (
              <div className="flex items-center justify-between gap-4 border-b border-[var(--line-subtle)] bg-[var(--warning-bg)] px-5 py-2 text-xs text-[var(--warning)]">
                <span>当前查看的角色不符合筛选条件。</span>
                <button
                  type="button"
                  onClick={clearCharacterFilters}
                  className="shrink-0 font-medium underline underline-offset-2"
                >
                  清除筛选
                </button>
              </div>
            )}
            <div className="border-b border-[var(--line)] bg-[var(--paper-elevated)]/55 px-6 py-5">
              <div className="flex items-start gap-4">
                <CharacterMark character={selectedCharacter} size="large" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {editing ? (
                      <input
                        value={selectedCharacter.name}
                        onChange={(event) =>
                          updateCharacter({ name: event.target.value })
                        }
                        className="min-w-0 flex-1 border-b border-[var(--accent-warm)] bg-transparent text-xl font-semibold text-[var(--ink)] outline-none"
                      />
                    ) : (
                      <h2 className="text-xl font-semibold text-[var(--ink)]">
                        {selectedCharacter.name}
                      </h2>
                    )}
                    {editing ? (
                      <>
                        <CustomSelect
                          value={selectedCharacter.roleWeight}
                          options={ROLE_FILTERS.slice(1).map((option) => ({
                            value: option.id,
                            label: option.label,
                          }))}
                          onChange={(roleWeight) =>
                            updateCharacter({
                              roleWeight: roleWeight as RoleWeight,
                            })
                          }
                          ariaLabel="戏份权重"
                          size="toolbar"
                          className="w-28"
                        />
                        <CustomSelect
                          value={selectedCharacter.alignment}
                          options={ALIGNMENT_OPTIONS.map((alignment) => ({
                            value: alignment,
                            label: alignment,
                          }))}
                          onChange={(alignment) =>
                            updateCharacter({ alignment })
                          }
                          ariaLabel="阵营"
                          size="toolbar"
                          className="w-28"
                        />
                      </>
                    ) : (
                      <>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${roleTone(selectedCharacter.roleWeight)}`}
                        >
                          {ROLE_LABELS[selectedCharacter.roleWeight]}
                        </span>
                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                          {selectedCharacter.alignment}
                        </span>
                        {selectedCharacter.currentRealm && (
                          <span className="rounded-full bg-[var(--accent-cool)]/10 px-2 py-0.5 text-xs font-medium text-[var(--accent-cool)]">
                            {selectedCharacter.currentRealm}
                          </span>
                        )}
                      </>
                    )}
                    <span className="flex items-center gap-1 text-xs text-[var(--success)]">
                      <CircleDot className="h-3 w-3" />
                      {selectedCharacter.status}
                    </span>
                  </div>
                  {editing ? (
                    <input
                      value={selectedCharacter.alias}
                      onChange={(event) =>
                        updateCharacter({ alias: event.target.value })
                      }
                      placeholder="别名 / 称号"
                      className="mt-1 w-full bg-transparent text-sm text-[var(--ink-muted)] outline-none placeholder:text-[var(--ink-subtle)]"
                    />
                  ) : (
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">
                      {selectedCharacter.alias || "暂无别名"} ·{" "}
                      {selectedCharacter.identities
                        .filter(Boolean)
                        .join(" · ") || "暂无身份"}
                    </p>
                  )}
                  {editing ? (
                    <textarea
                      value={selectedCharacter.summary}
                      onChange={(event) =>
                        updateCharacter({ summary: event.target.value })
                      }
                      rows={2}
                      placeholder="一句话人物简介"
                      className="mt-3 w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm leading-6 outline-none focus:border-[var(--accent-warm)]"
                    />
                  ) : (
                    <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--ink-secondary)]">
                      {selectedCharacter.summary || "尚未填写人物简介。"}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {editing && (
                    <button
                      type="button"
                      onClick={() => void saveCurrentCharacter()}
                      disabled={isSaving || !isDirty}
                      aria-label="保存角色"
                      title={
                        isSaving ? "正在保存" : isDirty ? "保存角色" : "已保存"
                      }
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--accent-cool)] hover:bg-[var(--accent-cool-subtle)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isSaving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : isDirty ? (
                        <Save className="h-3.5 w-3.5" />
                      ) : (
                        <Check className="h-3.5 w-3.5 text-[var(--success)]" />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      editing ? void finishEditing() : setEditing(true)
                    }
                    disabled={editing && isSaving}
                    aria-label={editing ? "保存并完成编辑" : "编辑角色"}
                    title={
                      editing ? "保存并完成（Ctrl/Cmd + Enter）" : "编辑角色"
                    }
                    className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm ${
                      editing
                        ? "bg-[var(--success-bg)] font-medium text-[var(--success)]"
                        : "text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    }`}
                  >
                    {editing ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Edit3 className="h-3.5 w-3.5" />
                    )}
                    {editing ? (isSaving ? "保存中" : "保存并完成") : "编辑"}
                  </button>
                </div>
              </div>

              <dl className="mt-5 grid grid-cols-4 divide-x divide-[var(--line-subtle)] border-t border-[var(--line-subtle)] pt-4 max-xl:grid-cols-2 max-xl:gap-y-4 max-xl:divide-x-0">
                <div className="pr-4">
                  <dt className="text-xs text-[var(--ink-muted)]">
                    资料完整度
                  </dt>
                  <dd className="mt-1 flex items-center gap-2 text-sm font-semibold">
                    {selectedCharacter.completeness}%
                    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--paper-inset)]">
                      <span
                        className="block h-full rounded-full bg-[var(--accent-warm)]"
                        style={{ width: `${selectedCharacter.completeness}%` }}
                      />
                    </span>
                  </dd>
                </div>
                <div className="px-4 max-xl:px-0">
                  <dt className="text-xs text-[var(--ink-muted)]">首次出场</dt>
                  <dd className="mt-1 text-sm font-semibold text-[var(--ink)]">
                    {selectedCharacter.firstAppearance}
                  </dd>
                </div>
                <div className="px-4 max-xl:px-0">
                  <dt className="text-xs text-[var(--ink-muted)]">直接关系</dt>
                  <dd className="mt-1 text-sm font-semibold text-[var(--ink)]">
                    {selectedCharacter.relations.length} 条
                  </dd>
                </div>
                <div className="pl-4 max-xl:pl-0">
                  <dt className="text-xs text-[var(--ink-muted)]">当前弧光</dt>
                  <dd className="mt-1 text-sm font-semibold text-[var(--accent-cool)]">
                    {selectedCharacter.arcStages.find(
                      (stage) => stage.state === "进行中",
                    )?.title ?? "待规划"}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="sticky top-0 z-20 flex h-11 items-center gap-1 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-5">
              {(
                [
                  ["profile", "人物卡", UserRound],
                  ["cultivation", "修炼", Sparkles],
                  ["inventory", "物品栏", Package],
                  ["soul", "灵魂", Fingerprint],
                  ["arc", "角色弧", GitBranch],
                  ["relations", "关系", HeartHandshake],
                  ["appearances", "出场", BookOpen],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setDetailTab(id)}
                  className={`relative flex h-full items-center gap-1.5 px-3 text-sm font-medium ${
                    detailTab === id
                      ? "text-[var(--accent-warm)] after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-[var(--accent-warm)]"
                      : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setView("network");
                  setSelectedId(selectedCharacter.id);
                }}
                className="ml-auto flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                查看图谱
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>

            {detailTab === "profile" && (
              <ProfileTab
                character={selectedCharacter}
                races={races}
                groups={groups}
                editing={editing}
                onChange={updateCharacter}
                onManageRaces={() => setRaceDialog(true)}
              />
            )}
            {detailTab === "cultivation" && (
              <CultivationTab
                character={selectedCharacter}
                ecology={cultivationEcology}
                editing={editing}
                onChange={updateCharacter}
              />
            )}
            {detailTab === "inventory" && (
              <CharacterInventoryTab
                character={selectedCharacter}
                itemEntries={itemEntries}
                itemLibraryLoading={itemLibraryLoading}
                itemLibraryError={itemLibraryError}
                editing={editing}
                onChange={updateCharacter}
                onRefreshItemLibrary={() => void refreshItemLibrary()}
              />
            )}
            {detailTab === "soul" && (
              <CharacterSoulTab
                key={`${selectedCharacter.id}-${selectedCharacter.soulId}`}
                character={selectedCharacter}
                souls={souls}
                onBind={(soulId) => updateCharacter({ soulId })}
                onOpenLibrary={() => setView("souls")}
              />
            )}
            {detailTab === "arc" && <ArcTab character={selectedCharacter} />}
            {detailTab === "relations" && (
              <RelationsTab
                character={selectedCharacter}
                characters={characters}
                onSelect={selectCharacter}
              />
            )}
            {detailTab === "appearances" && (
              <AppearancesTab character={selectedCharacter} />
            )}
          </main>
        </div>
      )}

      {agentDialog && (
        <AgentDesignDialog
          initialScope={agentDialogScope}
          onClose={() => setAgentDialog(false)}
          onCreate={createAgentProposal}
        />
      )}
      {raceDialog && (
        <RaceManagementDialog
          races={races}
          usageByRace={raceUsageById}
          onUpdate={updateRace}
          onCreate={addRace}
          onDelete={deleteRace}
          onOpenAiDesign={
            onOpenAiAgent ? () => openAgentDialog("race") : undefined
          }
          onClose={() => setRaceDialog(false)}
        />
      )}
      {groupEditor && (groupEditor.mode === "create" || groupEditorTarget) && (
        <GroupEditorDialog
          key={
            groupEditor.mode === "create"
              ? "create-group"
              : `edit-${groupEditor.groupId}`
          }
          mode={groupEditor.mode}
          group={groupEditorTarget}
          usageCount={groupEditorUsage}
          onSave={saveGroupEditor}
          onDelete={
            groupEditor.mode === "edit" &&
            groupEditor.groupId !== UNGROUPED_FILTER
              ? () => {
                  deleteGroup(groupEditor.groupId);
                  setGroupEditor(null);
                }
              : undefined
          }
          onClose={() => setGroupEditor(null)}
        />
      )}
      {proposalReviewOpen && onCloseProposalReview && (
        <CharacterProposalReview
          storage={storage}
          projectTitle={projectTitle}
          beforeMutate={flushCharacters}
          onApplied={load}
          onClose={onCloseProposalReview}
        />
      )}
    </div>
  );
}
