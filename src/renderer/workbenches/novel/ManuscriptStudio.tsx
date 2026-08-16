import "./ManuscriptStudio.css";

import {
  AlertTriangle,
  AlignJustify,
  AlignLeft,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArchiveRestore,
  BookMarked,
  BookOpen,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  Download,
  Database,
  Eye,
  Filter,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  Link2,
  Lightbulb,
  Loader2,
  Lock,
  Maximize2,
  Network,
  PanelRight,
  PenLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Trash2,
  Unlock,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  ConfirmDialog,
  CustomSelect,
  DraggableDialogFrame,
  Popover,
  subscribeWorkbenchHostAction,
  type SelectOption,
  type WorkbenchAvailableProvider,
  type WorkbenchAiExecutionProfile,
  type WorkbenchAiRunProgress,
  type WorkbenchModelSelection,
  type WorkbenchNavigationGuard,
  type WorkbenchStorage,
  useCloseLayer,
  useWorkbenchAvailableProviders,
} from "@/workbench-sdk";

import {
  createManuscriptTrackingRepository,
  hashManuscriptContent,
} from "./manuscriptTrackingRepository";
import {
  manuscriptTrackingOperationSchema,
  manuscriptTrackingDomainSchema,
  type ManuscriptTrackingBatch,
  type ManuscriptTrackingChange,
  type ManuscriptTrackingOperation,
} from "./manuscriptTrackingSchema";
import {
  createNovelCharacterLibraryRepository,
  loadCharacterRecords,
} from "./modules/characters";
import { createNovelFactionLibraryRepository } from "./modules/factions/data-access/factionLibraryRepository";
import { createNovelItemLibraryRepository } from "./itemLibraryRepository";
import { createNovelLocationLibraryRepository } from "./modules/locations/data-access/locationLibraryRepository";
import { parseSettingLibrarySettingsIndex } from "./settingLibrarySchema";
import { createNovelTimelineLibraryRepository } from "./timelineLibraryRepository";
import {
  getEffectiveModelSceneSelection,
  getModelSceneBinding,
  type ModelSceneSettings,
  type NovelModelSceneId,
} from "./modelSceneSettings";
import {
  MAX_CHAPTER_WORD_COUNT,
  MIN_CHAPTER_WORD_COUNT,
  parseChapterWordCount,
} from "./modules/project/business/projectPlanning";
import {
  createNovelModelSceneSettingsRepository,
  type LoadedModelSceneSettings,
} from "./modelSceneSettingsRepository";
import NarrativeUnsavedChangesGuard from "./NarrativeUnsavedChangesGuard";
import {
  buildManuscriptExportMarkdown,
  downloadTextFile,
  sanitizeExportFileName,
} from "./manuscriptExport";
import type {
  CreateNovelChapterOptions,
  LoadedNovelChapter,
  LoadedNovelProject,
  UpdateNovelChapterInput,
} from "./repository";
import { createNovelRepository } from "./repository";
import {
  buildFullGenerationQuickContext,
  countFullGenerationQuickContextItems,
  createFullGenerationQuickContextSelection,
  getFullGenerationSettingIdsForNode,
  loadFullGenerationQuickContextCatalog,
  replaceFullGenerationQuickContextIds,
  toggleFullGenerationQuickContextId,
  type FullGenerationContextReadMode,
  type FullGenerationQuickContextCatalog,
  type FullGenerationQuickContextIdField,
  type FullGenerationQuickContextSelection,
} from "./fullGenerationQuickContext";
import {
  DEFAULT_MANUSCRIPT_TYPOGRAPHY,
  orderManuscriptChapters,
  type ManuscriptDirectory,
  type ManuscriptDirectoryKind,
  type ManuscriptStructureMode,
  type ManuscriptTypography,
  type NovelChapterStatus,
} from "./projectSchema";
import type {
  ManuscriptVersionRecord,
  ManuscriptVersionSettings,
} from "./manuscriptVersionSchema";

const DiffViewer = lazy(() => import("@/workbench-sdk/DiffViewer"));

export interface ManuscriptAiRunRequest {
  readonly sceneId: NovelModelSceneId;
  readonly runId?: string;
  readonly label: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly modelSelection?: WorkbenchModelSelection;
  readonly executionProfile?: WorkbenchAiExecutionProfile;
  readonly timeoutMs?: number;
  readonly maxTurns?: number;
  readonly usesNovelContextTools?: boolean;
  readonly novelContextToolCallLimit?: number;
  readonly onProgress?: (progress: WorkbenchAiRunProgress) => void;
}

export interface ManuscriptAiAgentRequest {
  readonly sceneId: NovelModelSceneId;
  readonly title: string;
  readonly initialMessage: string;
  readonly conversationKey: string;
  readonly runId: string;
  readonly chapterId: string;
  readonly chapterTitle: string;
  readonly presentation?: "dialog" | "compact-review" | "embedded-review";
  readonly embeddedSurfaceId?: string;
  readonly companionContext?: Readonly<Record<string, string>>;
}

interface ManuscriptStudioProps {
  readonly storage: WorkbenchStorage;
  readonly project: LoadedNovelProject;
  readonly selectedChapterId: string;
  readonly isCreatingChapter: boolean;
  readonly onSelectChapter: (chapterId: string) => void;
  readonly onCreateChapter: (
    options?: CreateNovelChapterOptions,
  ) => Promise<string>;
  readonly onUpdateChapter: (
    chapterId: string,
    input: UpdateNovelChapterInput,
  ) => Promise<void>;
  readonly onRenameChapter: (chapterId: string, title: string) => Promise<void>;
  readonly onLinkChapterToNarrative: (
    chapterId: string,
    narrativeChapterId: string | null,
  ) => Promise<void>;
  readonly onCreateDirectory: (
    parentId: string | null,
    kind: ManuscriptDirectoryKind,
    title: string,
  ) => Promise<string>;
  readonly onUpdateDirectory: (
    directoryId: string,
    input: {
      readonly title?: string;
      readonly parentId?: string | null;
      readonly kind?: ManuscriptDirectoryKind;
      readonly order?: number;
      readonly narrativeDirectoryId?: string | null;
    },
  ) => Promise<void>;
  readonly onDeleteDirectory: (directoryId: string) => Promise<void>;
  readonly onSetStructureMode: (mode: ManuscriptStructureMode) => Promise<void>;
  readonly onSynchronizeNarrative: () => Promise<void>;
  readonly onSaveTypography: (
    typography: ManuscriptTypography,
  ) => Promise<void>;
  readonly onDeleteChapter: (
    chapterId: string,
    expectedContent: string,
  ) => Promise<void>;
  readonly onRestoreChapter: (deletionId: string) => Promise<void>;
  readonly onDeleteChapterPermanently: (deletionId: string) => Promise<void>;
  readonly onSaveChapter: (
    chapterId: string,
    content: string,
    expectedContent: string,
  ) => Promise<void>;
  readonly onLoadManuscriptVersions: (
    chapterId: string,
  ) => Promise<readonly ManuscriptVersionRecord[]>;
  readonly onLoadManuscriptVersionSettings: () => Promise<ManuscriptVersionSettings>;
  readonly onSaveManuscriptVersionLimit: (maxVersions: number) => Promise<void>;
  readonly onRestoreManuscriptVersion: (
    chapterId: string,
    versionId: string,
  ) => Promise<void>;
  readonly onExtractChaptersToNarrative: (input: {
    readonly extractions: readonly {
      readonly chapterId: string;
      readonly sourceContentHash: string;
      readonly targetNarrativeChapterId: string | null;
      readonly title: string;
      readonly description: string;
      readonly sections: readonly {
        readonly title: string;
        readonly description: string;
      }[];
    }[];
  }) => Promise<void>;
  readonly onAiRun?: (request: ManuscriptAiRunRequest) => Promise<string>;
  readonly onOpenAiAgent?: (request: ManuscriptAiAgentRequest) => Promise<void>;
  readonly onAdoptSimulation: (input: {
    readonly title: string;
    readonly description: string;
    readonly premise: string;
    readonly sourceChapterPlanId: string | null;
    readonly sourceManuscriptChapterId: string | null;
    readonly agentRole: string;
    readonly coherence: number;
    readonly novelty: number;
    readonly risk: number;
    readonly riskLevel: RoomScheme["riskLevel"];
    readonly tags: readonly string[];
    readonly nodes: readonly RoomPathNode[];
  }) => Promise<void>;
  readonly onOpenNarrative: () => void;
  readonly onOpenModelSettings: () => void;
  readonly registerNavigationGuard: (
    guard: WorkbenchNavigationGuard,
  ) => () => void;
}

type StudioView = "write" | "tracking";
type InspectorView =
  | "plan"
  | "reference"
  | "ai"
  | "quality"
  | "sync"
  | "chapter"
  | "typography"
  | "trash";
type WritingAiMode = "generate" | "continue" | "revise" | "expand";
type WritingSurface = "chapter" | "continuous" | "scenes";
type TreeFilter = "all" | "volume" | "sync";

interface TextSelection {
  readonly start: number;
  readonly end: number;
}

interface SelectionToolbarPosition {
  readonly left: number;
  readonly top: number;
}

interface AiCandidate {
  readonly mode: WritingAiMode;
  readonly start: number;
  readonly end: number;
  readonly content: string;
  readonly sourceContent: string;
  /** 候选生成时磁盘中该章的基线，独立于作者尚未保存的本地草稿。 */
  readonly persistedSourceContent: string;
  readonly quickSelection: boolean;
  readonly anchor: SelectionToolbarPosition | null;
}

interface SelectionAiLoading {
  readonly mode: WritingAiMode;
  readonly anchor: SelectionToolbarPosition;
}

interface RoomScheme {
  readonly title: string;
  readonly content: string;
  readonly premise: string;
  readonly opening: string;
  readonly category: "plot" | "character" | "commercial" | "style" | "twist";
  readonly score: number;
  readonly coherence: number;
  readonly novelty: number;
  readonly risk: number;
  readonly riskLevel: "low" | "medium" | "high";
  readonly tags: readonly string[];
  readonly nodes: readonly RoomPathNode[];
}

interface RoomPathNode {
  readonly offset: number;
  readonly title: string;
  readonly summary: string;
  readonly checkpoint: string;
}

type RoomContextModule =
  | "continuity"
  | "characters"
  | "timeline"
  | "items"
  | "locations"
  | "factions"
  | "world-rules";

interface RoomAgentResult {
  readonly agent: number;
  readonly role: string;
  readonly schemes: readonly RoomScheme[];
  readonly error?: string;
}

export type BrainstormRoundtablePhase =
  | "idle"
  | "council"
  | "contracting"
  | "designing"
  | "synthesizing"
  | "auditing"
  | "failed"
  | "ready";

type BrainstormAgentProgressState =
  | "queued"
  | "requesting"
  | "received"
  | "parsing"
  | "success"
  | "partial"
  | "timeout"
  | "failed";

interface BrainstormAgentProgress {
  readonly id: string;
  readonly agent: number | null;
  readonly role: string;
  readonly state: BrainstormAgentProgressState;
  readonly task: string;
  readonly detail: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
}

export interface BrainstormPlanContract {
  readonly id: string;
  readonly title: string;
  readonly coreChoice: string;
  readonly causalChain: string;
  readonly requiredBeats: readonly string[];
  readonly characterQuestion: string;
  readonly emotionArc: string;
  readonly twist: string;
  readonly hook: string;
  readonly nonNegotiables: readonly string[];
  readonly openQuestions: readonly string[];
}

export interface BrainstormRoundtable {
  readonly summary: string;
  readonly sharedFacts: readonly string[];
  readonly authorIntent: readonly string[];
  readonly agreements: readonly string[];
  readonly disagreements: readonly string[];
  readonly contracts: readonly BrainstormPlanContract[];
}

export interface BrainstormDesignerContribution {
  readonly agent: number;
  readonly role: string;
  readonly planId: string;
  readonly status: "available" | "invalid" | "missing" | "timeout" | "failed";
  readonly diagnostic?: string;
  readonly contribution: string;
  readonly evidence: readonly string[];
  readonly assumptions: readonly string[];
  readonly conflicts: readonly string[];
}

export interface BrainstormCouncilNote {
  readonly agent: number;
  readonly role: string;
  readonly opportunities: readonly string[];
  readonly constraints: readonly string[];
  readonly recommendation: string;
  readonly questions: readonly string[];
}

export interface BrainstormCompletePlan {
  readonly id: string;
  readonly title: string;
  readonly premise: string;
  readonly content: string;
  readonly opening: string;
  readonly beats: readonly string[];
  readonly evidence: readonly string[];
  readonly assumptions: readonly string[];
  readonly conflicts: readonly string[];
  readonly contributions: readonly BrainstormDesignerContribution[];
  readonly audit: {
    readonly score: number;
    readonly summary: string;
    readonly risks: readonly string[];
  };
}

interface RoomAgentConfig {
  readonly agent: number;
  readonly enabled: boolean;
  readonly schemeCount: number;
  readonly modules: readonly RoomContextModule[];
}

interface RoomWorkspaceProps {
  readonly kind: "brainstorm" | "simulation";
  readonly presentation?: "page" | "dialog";
  readonly storage: WorkbenchStorage;
  readonly chapter: LoadedNovelChapter | undefined;
  readonly chapterPlan:
    | LoadedNovelProject["narrative"]["library"]["chapters"][number]
    | undefined;
  readonly planningMode: LoadedNovelChapter["planningMode"] | undefined;
  readonly manuscriptContent: string;
  readonly enabled: boolean;
  readonly onRun: (request: ManuscriptAiRunRequest) => Promise<string>;
  readonly onUseBrief: (brief: string) => void;
  readonly onAdoptSimulation: (input: {
    readonly title: string;
    readonly description: string;
    readonly premise: string;
    readonly sourceChapterPlanId: string | null;
    readonly sourceManuscriptChapterId: string | null;
    readonly agentRole: string;
    readonly coherence: number;
    readonly novelty: number;
    readonly risk: number;
    readonly riskLevel: RoomScheme["riskLevel"];
    readonly tags: readonly string[];
    readonly nodes: readonly RoomPathNode[];
  }) => Promise<void>;
  readonly onShowAgentPrompt?: (agent: number) => void;
  readonly outputFontScale?: BrainstormFontScale;
  readonly onBusyChange?: (busy: boolean) => void;
}

type RoomDialogProps = Omit<RoomWorkspaceProps, "kind" | "presentation"> & {
  readonly onClose: () => void;
};

interface BrainstormRoomDialogProps extends RoomDialogProps {
  readonly project: LoadedNovelProject;
  readonly initialNotes: string;
  readonly generationContext: string;
  readonly targetWordCount?: number;
  readonly persistedManuscriptContent: string;
  readonly onOpenAiAgent?: (request: ManuscriptAiAgentRequest) => Promise<void>;
  readonly onApplyGeneratedText: (
    content: string,
    expectedContent: string,
    expectedPersistedContent: string,
  ) => Promise<void> | void;
  readonly onOpenModelSettings: () => void;
}

type FullGenerationStep = 1 | 2 | 3;

export interface FullGenerationFragment {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly source: string;
}

export interface FullGenerationPlan {
  readonly id: string;
  readonly agent: number;
  readonly agentName: string;
  readonly title: string;
  readonly premise: string;
  readonly fragments: readonly FullGenerationFragment[];
}

interface FullGenerationWorkflowProps {
  readonly storage: WorkbenchStorage;
  readonly project: LoadedNovelProject;
  readonly open: boolean;
  readonly embedded?: boolean;
  readonly agentOnly?: boolean;
  readonly chapter: LoadedNovelChapter | undefined;
  readonly chapterPlan:
    | LoadedNovelProject["narrative"]["library"]["chapters"][number]
    | undefined;
  readonly manuscriptContent: string;
  readonly persistedManuscriptContent: string;
  readonly initialNotes: string;
  readonly generationContext: string;
  readonly targetWordCount?: number;
  readonly onRun?: (request: ManuscriptAiRunRequest) => Promise<string>;
  readonly onApplyGeneratedText: (
    content: string,
    expectedContent: string,
    expectedPersistedContent: string,
  ) => Promise<void> | void;
  readonly onOpenAiAgent?: (request: ManuscriptAiAgentRequest) => Promise<void>;
  readonly onOpenModelSettings: () => void;
  readonly onClose: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
}

type FullGenerationChapterPlan =
  LoadedNovelProject["narrative"]["library"]["chapters"][number];
type FullGenerationChapterPlanContext = Pick<
  FullGenerationChapterPlan,
  "title" | "description"
> & {
  readonly sections: readonly Pick<
    FullGenerationChapterPlan["sections"][number],
    "title" | "description"
  >[];
};

export function formatFullGenerationChapterPlan(
  chapterPlan: FullGenerationChapterPlanContext | undefined,
): string {
  if (!chapterPlan) return "剧情工程章节计划：未关联";
  const sections = chapterPlan.sections
    .map(
      (section, index) =>
        `${index + 1}. ${section.title || "未命名节拍"}：${section.description}`,
    )
    .join("\n");
  return [
    `剧情工程章节计划：${chapterPlan.title}`,
    chapterPlan.description,
    sections ? `章节节拍：\n${sections}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const BRAINSTORM_FONT_SCALE_OPTIONS = [
  80, 90, 100, 110, 125, 150, 175, 200,
] as const;

export type BrainstormFontScale =
  (typeof BRAINSTORM_FONT_SCALE_OPTIONS)[number];

export function buildBrainstormFontScaleStyle(
  scale: BrainstormFontScale,
): CSSProperties {
  const ratio = scale / 100;
  const scaled = (base: number) => `${Number((base * ratio).toFixed(2))}px`;
  return {
    "--text-xs": scaled(12),
    "--text-sm": scaled(14),
    "--text-base": scaled(16),
    "--text-lg": scaled(18),
    "--text-xl": scaled(20),
    "--text-2xl": scaled(22),
    "--text-3xl": scaled(28),
  } as CSSProperties;
}

interface QualityIssue {
  readonly category: string;
  readonly severity: "error" | "warning" | "suggestion";
  readonly title: string;
  readonly detail: string;
  readonly evidence: string;
  readonly suggestion: string;
}

interface QualityReview {
  readonly score: number;
  readonly summary: string;
  readonly issues: readonly QualityIssue[];
  readonly passed: readonly string[];
}

interface NarrativeExtractionDraft {
  readonly chapterId: string;
  readonly title: string;
  readonly description: string;
  readonly sections: readonly {
    readonly title: string;
    readonly description: string;
  }[];
}

interface ContextManifestSource {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly characters: number;
  readonly required: boolean;
}

const STATUS_LABELS: Record<NovelChapterStatus, string> = {
  planned: "待写",
  draft: "草稿",
  revising: "修订中",
  complete: "已完成",
};

const TRACKING_LABELS: Record<LoadedNovelChapter["trackingStatus"], string> = {
  idle: "未分析",
  pending: "分析中",
  review: "待审阅",
  synced: "已同步",
  stale: "正文已变化",
  failed: "同步失败",
};

const PLANNING_MODE_LABELS: Record<LoadedNovelChapter["planningMode"], string> =
  {
    reference: "参考大纲",
    detached: "脱纲创作",
  };

const DIRECTORY_KIND_LABELS: Record<ManuscriptDirectoryKind, string> = {
  volume: "卷",
  part: "篇",
  folder: "目录",
};

const DOMAIN_LABELS: Record<ManuscriptTrackingChange["domain"], string> = {
  timeline: "时间线",
  "character-appearance": "人物出场",
  "character-state": "人物状态",
  relationship: "人物关系",
  inventory: "人物物品",
  location: "地点状态",
  faction: "势力状态",
  foreshadow: "伏笔",
  "world-rule": "世界规则",
  continuity: "承接事项",
};

const BRAINSTORM_ROLE_PROFILES: readonly {
  readonly role: string;
  readonly category: RoomScheme["category"];
  readonly focus: string;
  readonly deliverable: string;
  readonly exclusion: string;
}[] = [
  {
    role: "剧情结构师",
    category: "plot",
    focus: "本章的推进、阻力、转折与章末去向",
    deliverable: "给出 3 至 5 个可落地的剧情节拍，明确哪一拍改变了局面",
    exclusion: "不要把人物心理分析、反转噱头或商业钩子当成方案主体",
  },
  {
    role: "人物动机师",
    category: "character",
    focus: "一个核心人物不愿承认的欲望、选择代价与关系变化",
    deliverable: "指出人物为何此刻只能做这个选择，以及选择后谁与谁的关系被改写",
    exclusion: "不要重述完整主线；剧情只能服务于人物选择的压力测试",
  },
  {
    role: "读者情绪师",
    category: "style",
    focus: "读者预期、情绪失衡、释放与余波组成的章节情绪曲线",
    deliverable: "标出起势、压迫、情绪拐点和结尾余味，并落到具体场景动作",
    exclusion: "不要只列事件或泛泛抒情；必须说明读者会为何期待下一段",
  },
  {
    role: "反套路设计师",
    category: "twist",
    focus: "读者的默认预期、可验证的偏转与偏转后的代价",
    deliverable: "给出一个不违背既有事实的信息锚点，以及反转后仍需承担的后果",
    exclusion: "不要为了反转推翻已知人物动机、世界规则或正文证据",
  },
  {
    role: "因果与规则审计",
    category: "plot",
    focus: "已发生事实的因果闭环、规则成本与下一步必然结果",
    deliverable: "写清触发原因、可见代价、不可省略的承接事项和潜在矛盾",
    exclusion: "不要另起一条无依据的新支线，也不要用巧合解决冲突",
  },
  {
    role: "商业节奏编辑",
    category: "commercial",
    focus: "开场抓取、信息递进、即时爽点与章末追读钩子",
    deliverable: "拆出本章的钩子、兑现点和悬念落点，保证每一段都有阅读驱动力",
    exclusion: "不要牺牲人物逻辑或因果完整性来硬塞爽点和断章",
  },
];

const ROOM_ROLES = BRAINSTORM_ROLE_PROFILES.map(({ role }) => role);

const SIMULATION_ROLES = [
  "主线演算师",
  "人物因果师",
  "对手行动者",
  "世界规则师",
  "连载节奏师",
  "黑天鹅变量",
] as const;

const SIMULATION_HORIZON_OPTIONS = Array.from(
  { length: 10 },
  (_, index) => index + 1,
);

/** 复杂一次性工作流共用的宿主扩展执行预算。 */
export const EXTENDED_AI_EXECUTION_PROFILE = "extended" as const;
export const EXTENDED_AI_DEFAULT_TIMEOUT_MINUTES = 5;
export const EXTENDED_AI_DEFAULT_MAX_TURNS = 16;
export const EXTENDED_AI_TIMEOUT_MINUTES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
] as const;
export const EXTENDED_AI_MAX_TURNS = [8, 12, 16] as const;

const EXTENDED_AI_TIMEOUT_OPTIONS: SelectOption[] =
  EXTENDED_AI_TIMEOUT_MINUTES.map((minutes) => ({
    value: String(minutes),
    label: `${minutes} 分钟`,
  }));

const EXTENDED_AI_MAX_TURNS_OPTIONS: SelectOption[] = EXTENDED_AI_MAX_TURNS.map(
  (turns) => ({
    value: String(turns),
    label: `${turns} 轮`,
  }),
);

export function applyExtendedAiRunBudget(
  request: ManuscriptAiRunRequest,
  timeoutMinutes: number,
  maxTurns = EXTENDED_AI_DEFAULT_MAX_TURNS,
): ManuscriptAiRunRequest {
  const normalizedMinutes = Number.isFinite(timeoutMinutes)
    ? Math.min(10, Math.max(1, Math.round(timeoutMinutes)))
    : EXTENDED_AI_DEFAULT_TIMEOUT_MINUTES;
  return {
    ...request,
    executionProfile: EXTENDED_AI_EXECUTION_PROFILE,
    timeoutMs: normalizedMinutes * 60_000,
    maxTurns: Number.isFinite(maxTurns)
      ? Math.min(16, Math.max(1, Math.round(maxTurns)))
      : EXTENDED_AI_DEFAULT_MAX_TURNS,
  };
}

/** 保留剧情推演预算的已发布常量，默认值来自共享扩展预算。 */
export const SIMULATION_AI_EXECUTION_PROFILE = EXTENDED_AI_EXECUTION_PROFILE;
export const SIMULATION_AI_TIMEOUT_MS =
  EXTENDED_AI_DEFAULT_TIMEOUT_MINUTES * 60_000;
export const SIMULATION_AI_MAX_TURNS = EXTENDED_AI_DEFAULT_MAX_TURNS;

const ROOM_CONTEXT_MODULES: readonly {
  readonly id: RoomContextModule;
  readonly label: string;
}[] = [
  { id: "continuity", label: "连续性" },
  { id: "characters", label: "人物" },
  { id: "timeline", label: "时间线" },
  { id: "items", label: "物品" },
  { id: "locations", label: "地点" },
  { id: "factions", label: "势力" },
  { id: "world-rules", label: "世界规则" },
];

const DEFAULT_ROOM_MODULES: readonly (readonly RoomContextModule[])[] = [
  ["continuity", "timeline", "world-rules"],
  ["characters", "continuity", "items"],
  ["continuity", "timeline", "factions"],
  ["world-rules", "locations", "items"],
  ["timeline", "continuity", "characters"],
  ["factions", "world-rules", "continuity"],
];

function clipBrainstormContext(value: unknown, limit: number): string {
  const serialized = JSON.stringify(value ?? null, null, 2);
  if (serialized.length <= limit) return serialized;
  return `${serialized.slice(0, limit)}\n[本模块摘要已截断]`;
}

export function buildBrainstormContextDigest(
  context: Partial<Record<RoomContextModule, unknown>>,
  modules: readonly RoomContextModule[],
  options: {
    readonly perModuleChars?: number;
    readonly totalChars?: number;
  } = {},
): string {
  const perModuleChars = Math.max(200, options.perModuleChars ?? 1_200);
  const totalChars = Math.max(perModuleChars, options.totalChars ?? 4_000);
  const moduleLabel = new Map(
    ROOM_CONTEXT_MODULES.map((module) => [module.id, module.label]),
  );
  const sections: string[] = [];
  let used = 0;
  for (const module of [...new Set(modules)]) {
    const section = `【${moduleLabel.get(module) ?? module}】\n${clipBrainstormContext(context[module], perModuleChars)}`;
    const remaining = totalChars - used;
    if (remaining <= 0) break;
    if (section.length > remaining) {
      sections.push(
        `${section.slice(0, Math.max(0, remaining - 12))}\n[摘要到达上限]`,
      );
      break;
    }
    sections.push(section);
    used += section.length + 2;
  }
  return sections.join("\n\n") || "（没有可用的额外事实摘要）";
}

const FONT_OPTIONS = [
  { value: "system-serif", label: "阅读衬线" },
  { value: "songti", label: "宋体" },
  { value: "kaiti", label: "楷体" },
  { value: "fangsong", label: "仿宋" },
  { value: "system-sans", label: "无衬线" },
];

const STUDIO_ACTIONS: readonly {
  readonly id: "brainstorm" | "simulation" | "tracking";
  readonly label: string;
  readonly icon: typeof PenLine;
}[] = [
  { id: "brainstorm", label: "AI 脑暴室", icon: BrainCircuit },
  { id: "simulation", label: "剧情推演室", icon: GitBranch },
  { id: "tracking", label: "状态同步", icon: History },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/iu,
  );
  return match?.[1]?.trim() ?? trimmed;
}

function stripJsonTrailingCommas(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(value[lookahead] ?? "")) lookahead += 1;
      if (value[lookahead] === "}" || value[lookahead] === "]") continue;
    }
    result += character;
  }
  return result;
}

function tryParseJson(value: string): unknown {
  const candidate = value.replace(/^\uFEFF/u, "").trim();
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(stripJsonTrailingCommas(candidate));
    } catch {
      return undefined;
    }
  }
}

function extractJson(value: string): unknown {
  const trimmed = value.trim();
  const fencedCandidates = Array.from(
    trimmed.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/giu),
    (match) => match[1] ?? "",
  );
  const candidates = [trimmed, ...fencedCandidates];
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) return parsed;
  }

  // 模型偶尔会在 JSON 前后补说明，或先输出其它代码块，逐个寻找完整对象或数组。
  for (const candidate of candidates) {
    for (let start = 0; start < candidate.length; start += 1) {
      if (candidate[start] !== "{" && candidate[start] !== "[") continue;
      const expectedClosers: string[] = [];
      let inString = false;
      let escaped = false;
      for (let index = start; index < candidate.length; index += 1) {
        const character = candidate[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') {
          inString = true;
          continue;
        }
        if (character === "{") expectedClosers.push("}");
        else if (character === "[") expectedClosers.push("]");
        else if (character === "}" || character === "]") {
          if (expectedClosers.pop() !== character) break;
          if (!expectedClosers.length) {
            const parsed = tryParseJson(candidate.slice(start, index + 1));
            if (parsed !== undefined) return parsed;
            break;
          }
        }
      }
    }
  }
  throw new Error("AI 返回内容不包含可解析的 JSON");
}

function boundedScore(value: unknown, fallback = 0): number {
  const score = Number(value);
  return Number.isFinite(score)
    ? Math.max(0, Math.min(100, Math.round(score)))
    : fallback;
}

function roomText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (depth >= 2 || value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map((item, index) => {
        const text = roomText(item, depth + 1);
        return text ? `${index + 1}. ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [
      record.title,
      record.summary,
      record.description,
      record.content,
      record.detail,
    ]
      .map((item) => roomText(item, depth + 1))
      .filter(Boolean)
      .join("：");
  }
  return "";
}

function isRoomSchemeRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [
    "title",
    "name",
    "premise",
    "outline",
    "opening",
    "draft",
    "content",
  ].some((key) => key in value);
}

export function parseRoomSchemes(
  output: string,
  limit: number,
  kind: "brainstorm" | "simulation",
  agent: number,
): RoomScheme[] {
  const defaultCategory =
    kind === "brainstorm"
      ? (BRAINSTORM_ROLE_PROFILES[agent - 1]?.category ?? "plot")
      : ("plot" as const);
  try {
    const source = extractJson(output);
    const array = Array.isArray(source)
      ? source
      : source &&
          typeof source === "object" &&
          Array.isArray((source as { schemes?: unknown }).schemes)
        ? (source as { schemes: unknown[] }).schemes
        : isRoomSchemeRecord(source)
          ? [source]
          : [];
    const schemes = array.slice(0, limit).map((item, index): RoomScheme => {
      if (typeof item === "string") {
        return {
          title: `方案 ${index + 1}`,
          content: item.trim(),
          premise: item.trim(),
          opening: "",
          category: defaultCategory,
          score: 0,
          coherence: 0,
          novelty: 0,
          risk: 0,
          riskLevel: "medium",
          tags: [],
          nodes: [],
        };
      }
      if (!item || typeof item !== "object") {
        return {
          title: `方案 ${index + 1}`,
          content: String(item),
          premise: String(item),
          opening: "",
          category: defaultCategory,
          score: 0,
          coherence: 0,
          novelty: 0,
          risk: 0,
          riskLevel: "medium",
          tags: [],
          nodes: [],
        };
      }
      const record = item as Record<string, unknown>;
      const title =
        roomText(record.title ?? record.name).split("\n")[0] ||
        `方案 ${index + 1}`;
      const premise = roomText(record.premise);
      const opening = roomText(record.opening ?? record.draft);
      const content = [premise, record.outline, record.content, record.risk]
        .map((part) => roomText(part))
        .filter(Boolean)
        .join("\n\n");
      const rawCategory = record.category;
      const category =
        rawCategory === "character" ||
        rawCategory === "commercial" ||
        rawCategory === "style" ||
        rawCategory === "twist"
          ? rawCategory
          : defaultCategory;
      const rawRiskLevel = record.riskLevel;
      const riskLevel =
        rawRiskLevel === "low" || rawRiskLevel === "high"
          ? rawRiskLevel
          : "medium";
      const nodes = Array.isArray(record.nodes)
        ? record.nodes
            .slice(0, 12)
            .flatMap((node, nodeIndex): RoomPathNode[] => {
              if (!node || typeof node !== "object") return [];
              const value = node as Record<string, unknown>;
              const nodeTitle = String(value.title ?? "").trim();
              if (!nodeTitle) return [];
              return [
                {
                  offset: Math.max(
                    1,
                    Math.round(Number(value.offset) || nodeIndex + 1),
                  ),
                  title: nodeTitle,
                  summary: String(value.summary ?? "").trim(),
                  checkpoint: String(value.checkpoint ?? "").trim(),
                },
              ];
            })
        : [];
      const coherence = boundedScore(record.coherence);
      const novelty = boundedScore(record.novelty);
      const risk = boundedScore(record.riskScore ?? record.risk);
      return {
        title,
        content: content || "未提供方案详情",
        premise,
        opening,
        category,
        score: boundedScore(
          record.score,
          Math.round((coherence + novelty) / 2),
        ),
        coherence,
        novelty,
        risk,
        riskLevel,
        tags: Array.isArray(record.tags)
          ? record.tags
              .map((tag) => String(tag).trim())
              .filter(Boolean)
              .slice(0, 6)
          : [],
        nodes,
      };
    });
    if (schemes.length) return schemes;
  } catch {
    // 非结构化输出仍保留为单个可用方案。
  }
  const fallback = stripCodeFence(output);
  return [
    {
      title: "方案 1",
      content: fallback,
      premise: fallback,
      opening: "",
      category: defaultCategory,
      score: 0,
      coherence: 0,
      novelty: 0,
      risk: 0,
      riskLevel: kind === "simulation" ? ("medium" as const) : ("low" as const),
      tags: [],
      nodes: [],
    },
  ].slice(0, limit);
}

export function buildBrainstormSystemPrompt(agent: number): string {
  const profile = BRAINSTORM_ROLE_PROFILES[agent - 1];
  if (!profile) {
    throw new Error(`未知脑暴 Agent：${agent}`);
  }
  return [
    `你是${profile.role}，只从“${profile.focus}”这个视角提出方案。`,
    `必须交付：${profile.deliverable}。`,
    `边界：${profile.exclusion}。`,
    "同一批方案必须彼此有可辨认的不同选择或不同后果，不能只替换人名、地点或措辞。",
    `只输出 JSON 数组，不要 Markdown 或解释。category 必须为 "${profile.category}"；title、premise、outline、opening 均为字符串，outline 用换行写 3 至 5 个节拍，tags 为不超过 4 项的字符串数组，score 为 0 至 100 的整数。`,
  ].join("\n");
}

export function buildBrainstormControllerPrompt(input: {
  readonly chapterTitle: string;
  readonly chapterPlan: string;
  readonly manuscriptContent: string;
  readonly authorIntent?: string;
  readonly context: unknown;
  readonly planCount: number;
  readonly councilNotes: readonly BrainstormCouncilNote[];
}): string {
  return [
    "你是中文长篇小说脑暴室的总控 Agent，负责主持一次结构化创作会诊。",
    "先从统一事实快照中区分事实、作者要求和可推断内容，再汇总设计师会诊意见。不要直接写正文，不要把单个专业意见称为完整方案。",
    `请为本章设计 ${input.planCount} 套彼此差异明确的方案契约。每套契约必须包含共同的核心选择、因果链、必备节拍、人物问题、情绪弧线、反转处理、开场/章末钩子、不可违背边界和待作者决定的问题。`,
    '只输出 JSON：{"summary":"","sharedFacts":[],"authorIntent":[],"agreements":[],"disagreements":[],"contracts":[{"id":"plan-1","title":"","coreChoice":"","causalChain":"","requiredBeats":[],"characterQuestion":"","emotionArc":"","twist":"","hook":"","nonNegotiables":[],"openQuestions":[]}]}',
    `章节：${input.chapterTitle}`,
    input.chapterPlan,
    `当前正文事实基线：\n${input.manuscriptContent || "（空）"}`,
    input.authorIntent?.trim()
      ? `作者本次意图：\n${input.authorIntent.trim()}`
      : "作者本次意图：未补充",
    `设计师会诊意见：\n${JSON.stringify(input.councilNotes, null, 2)}`,
    `必要事实摘要：\n${typeof input.context === "string" ? input.context : JSON.stringify(input.context, null, 2)}`,
  ].join("\n\n");
}

export function buildBrainstormCouncilPrompt(input: {
  readonly chapterTitle: string;
  readonly chapterPlan: string;
  readonly manuscriptContent: string;
  readonly authorIntent: string;
  readonly role: string;
  readonly focus: string;
  readonly context: unknown;
}): string {
  return [
    `你是“${input.role}”，参加正文脑暴的会诊阶段。此时不要生成完整方案，只从“${input.focus}”角度向总控提交简短意见。`,
    "分别指出可利用的机会、不能违背的约束、你推荐总控采用的方向，以及需要其他角色或作者回答的问题。",
    '只输出 JSON：{"opportunities":[],"constraints":[],"recommendation":"","questions":[]}',
    `章节：${input.chapterTitle}`,
    input.chapterPlan,
    `当前正文事实基线：\n${input.manuscriptContent || "（空）"}`,
    input.authorIntent.trim()
      ? `作者本轮意图：\n${input.authorIntent.trim()}`
      : "作者本轮意图：未补充",
    `与你职责有关的事实摘要：\n${typeof input.context === "string" ? input.context : JSON.stringify(input.context, null, 2)}`,
  ].join("\n\n");
}

export function buildBrainstormDesignerSystemPrompt(agent: number): string {
  const profile = BRAINSTORM_ROLE_PROFILES[agent - 1];
  if (!profile) throw new Error(`未知脑暴 Agent：${agent}`);
  return [
    `你是${profile.role}，负责“${profile.focus}”。`,
    `必须交付：${profile.deliverable}。`,
    `边界：${profile.exclusion}。`,
    "你正在为总控已经锁定的一套完整方案提供专业贡献。不得另起方案，不得修改方案 ID，不得输出多个候选。",
    "只输出调用方指定的 JSON 对象，不要 Markdown 或额外解释。",
  ].join("\n");
}

export function buildBrainstormCouncilSystemPrompt(agent: number): string {
  const profile = BRAINSTORM_ROLE_PROFILES[agent - 1];
  if (!profile) throw new Error(`未知脑暴 Agent：${agent}`);
  return [
    `你是${profile.role}，负责“${profile.focus}”。`,
    `专业边界：${profile.exclusion}。`,
    "你正在参加方案形成前的会诊，只提交专业判断、约束和问题，不生成完整方案，也不替总控做最终取舍。",
    "只输出调用方指定的 JSON 对象，不要 Markdown 或额外解释。",
  ].join("\n");
}

export function buildBrainstormDesignerPrompt(input: {
  readonly chapterTitle: string;
  readonly chapterPlan: string;
  readonly contract: BrainstormPlanContract;
  readonly role: string;
  readonly focus: string;
  readonly context: unknown;
  readonly roundtable: BrainstormRoundtable;
}): string {
  return [
    `你是“${input.role}”，正在参与一套已经锁定前提的完整方案设计。你不能另起一条主线，必须围绕方案 ${input.contract.id} 的共同契约提供你的专业贡献。`,
    `职责重点：${input.focus}`,
    "输出必须说明：你的设计如何服务核心选择；引用了哪些事实依据；新增了哪些创作假设；与其它约束是否冲突。",
    '只输出 JSON：{"planId":"","contribution":"","evidence":[],"assumptions":[],"conflicts":[]}',
    `章节：${input.chapterTitle}`,
    input.chapterPlan,
    `方案契约：\n${JSON.stringify(input.contract, null, 2)}`,
    `会诊共识：\n${JSON.stringify({ agreements: input.roundtable.agreements, disagreements: input.roundtable.disagreements }, null, 2)}`,
    `与你职责有关的事实摘要：\n${typeof input.context === "string" ? input.context : JSON.stringify(input.context, null, 2)}`,
  ].join("\n\n");
}

export function buildBrainstormDesignerBatchPrompt(input: {
  readonly chapterTitle: string;
  readonly chapterPlan: string;
  readonly contracts: readonly BrainstormPlanContract[];
  readonly role: string;
  readonly focus: string;
  readonly context: unknown;
  readonly roundtable: BrainstormRoundtable;
}): string {
  return [
    `你是“${input.role}”，要围绕总控锁定的 ${input.contracts.length} 套方案契约分别提交专业贡献。不得新增方案、合并方案或修改任何 planId。`,
    `职责重点：${input.focus}`,
    "每套贡献都必须说明它如何服务该方案的核心选择、引用了哪些事实依据、新增了哪些创作假设，以及是否与约束冲突。",
    '只输出 JSON：{"contributions":[{"planId":"plan-1","contribution":"","evidence":[],"assumptions":[],"conflicts":[]}]}。每个输入方案必须且只能对应一项。',
    `章节：${input.chapterTitle}`,
    input.chapterPlan,
    `方案契约：\n${JSON.stringify(input.contracts, null, 2)}`,
    `会诊共识：\n${JSON.stringify({ agreements: input.roundtable.agreements, disagreements: input.roundtable.disagreements }, null, 2)}`,
    `与你职责有关的事实摘要：\n${typeof input.context === "string" ? input.context : JSON.stringify(input.context, null, 2)}`,
  ].join("\n\n");
}

export function buildBrainstormSynthesisPrompt(input: {
  readonly chapterTitle: string;
  readonly chapterPlan: string;
  readonly contract: BrainstormPlanContract;
  readonly contributions: readonly BrainstormDesignerContribution[];
}): string {
  return [
    "你是脑暴室总控 Agent 的方案整合与审计阶段。请把同一方案契约下的各专业贡献整合为一套可直接交给正文 Agent 的完整创作方案。",
    "保留每条贡献的事实依据和创作假设；发现冲突时显式列出，不要静默抹平。审计评分只反映当前证据和约束下的可执行性，不代表作者已经确认。",
    "content 必须便于作者浏览：每个小节以【小节标题】单独成行，每个关键节拍以 ①、② 等编号单独成段，段落之间保留空行；不得将完整方案压成一段连续文字。",
    '只输出 JSON：{"id":"","title":"","premise":"","content":"","opening":"","beats":[],"evidence":[],"assumptions":[],"conflicts":[],"audit":{"score":0,"summary":"","risks":[]}}',
    `章节：${input.chapterTitle}`,
    input.chapterPlan,
    `方案契约：\n${JSON.stringify(input.contract, null, 2)}`,
    `设计师贡献：\n${JSON.stringify(input.contributions, null, 2)}`,
  ].join("\n\n");
}

export function buildBrainstormSynthesisBatchPrompt(input: {
  readonly chapterTitle: string;
  readonly chapterPlan: string;
  readonly contracts: readonly BrainstormPlanContract[];
  readonly contributions: readonly BrainstormDesignerContribution[];
}): string {
  return [
    "你是脑暴室总控 Agent 的方案整合与审计阶段。请分别整合同一方案契约下的专业贡献，不得合并不同方案，也不得改变 planId。",
    "保留事实依据和创作假设；发现冲突时显式列出。审计评分只反映当前证据和约束下的可执行性。",
    "每项 content 必须便于作者浏览：每个小节以【小节标题】单独成行，每个关键节拍以 ①、② 等编号单独成段，段落之间保留空行；不得将完整方案压成一段连续文字。",
    '只输出 JSON：{"plans":[{"id":"plan-1","title":"","premise":"","content":"","opening":"","beats":[],"evidence":[],"assumptions":[],"conflicts":[],"audit":{"score":0,"summary":"","risks":[]}}]}。每个方案契约必须且只能返回一项。',
    `章节：${input.chapterTitle}`,
    input.chapterPlan,
    `方案契约：\n${JSON.stringify(input.contracts, null, 2)}`,
    `设计师贡献：\n${JSON.stringify(input.contributions, null, 2)}`,
  ].join("\n\n");
}

export function parseBrainstormRoundtable(
  output: string,
  planCount: number,
): BrainstormRoundtable {
  const source = extractJson(output);
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("总控会诊未返回有效对象");
  }
  const record = source as Record<string, unknown>;
  const textList = (value: unknown): readonly string[] =>
    Array.isArray(value)
      ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
  const contracts = Array.isArray(record.contracts)
    ? record.contracts.slice(0, planCount).flatMap((value, index) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return [];
        const item = value as Record<string, unknown>;
        const id = roomText(item.id) || `plan-${index + 1}`;
        const title = roomText(item.title) || `候选方案 ${index + 1}`;
        return [
          {
            id,
            title,
            coreChoice: roomText(item.coreChoice),
            causalChain: roomText(item.causalChain),
            requiredBeats: textList(item.requiredBeats),
            characterQuestion: roomText(item.characterQuestion),
            emotionArc: roomText(item.emotionArc),
            twist: roomText(item.twist),
            hook: roomText(item.hook),
            nonNegotiables: textList(item.nonNegotiables),
            openQuestions: textList(item.openQuestions),
          } satisfies BrainstormPlanContract,
        ];
      })
    : [];
  if (!contracts.length) throw new Error("总控会诊未返回方案契约");
  return {
    summary: roomText(record.summary),
    sharedFacts: textList(record.sharedFacts),
    authorIntent: textList(record.authorIntent),
    agreements: textList(record.agreements),
    disagreements: textList(record.disagreements),
    contracts,
  };
}

export function parseBrainstormContribution(
  output: string,
  agent: number,
  role: string,
  planId: string,
): BrainstormDesignerContribution {
  const source = extractJson(output);
  const record =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  return {
    agent,
    role,
    planId: roomText(record.planId) || planId,
    status: roomText(record.contribution) ? "available" : "invalid",
    ...(!roomText(record.contribution)
      ? { diagnostic: `${role}返回了方案 ${planId}，但贡献正文为空` }
      : {}),
    contribution: roomText(record.contribution),
    evidence: Array.isArray(record.evidence)
      ? record.evidence.map(String).filter(Boolean)
      : [],
    assumptions: Array.isArray(record.assumptions)
      ? record.assumptions.map(String).filter(Boolean)
      : [],
    conflicts: Array.isArray(record.conflicts)
      ? record.conflicts.map(String).filter(Boolean)
      : [],
  };
}

function normalizeBrainstormPlanId(value: unknown): string {
  return roomText(value)
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[—–－]+/gu, "-");
}

function isBrainstormContributionRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [
    "planId",
    "plan_id",
    "id",
    "contribution",
    "content",
    "design",
    "proposal",
    "evidence",
    "assumptions",
    "conflicts",
  ].some((key) => key in record);
}

function brainstormContributionValues(source: unknown): readonly unknown[] {
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== "object") return [];
  const record = source as Record<string, unknown>;
  for (const key of ["contributions", "plans", "results", "items"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>).map(
        ([planId, contribution]) =>
          isBrainstormContributionRecord(contribution)
            ? {
                ...contribution,
                planId: roomText(contribution.planId) || planId,
              }
            : { planId, contribution },
      );
    }
  }
  if (isBrainstormContributionRecord(record)) return [record];
  const keyedValues = Object.entries(record).filter(
    ([, value]) => value !== null && value !== undefined,
  );
  return keyedValues.map(([planId, contribution]) => ({
    ...(isBrainstormContributionRecord(contribution)
      ? contribution
      : { contribution }),
    planId: isBrainstormContributionRecord(contribution)
      ? roomText(contribution.planId) || planId
      : planId,
  }));
}

function parseBrainstormContributionRecord(
  record: Record<string, unknown>,
  agent: number,
  role: string,
  planId: string,
  diagnostic?: string,
): BrainstormDesignerContribution {
  const contribution = roomText(
    record.contribution ??
      record.content ??
      record.design ??
      record.proposal ??
      record.summary ??
      record.detail,
  );
  const textList = (value: unknown): readonly string[] =>
    Array.isArray(value)
      ? value.map((item) => roomText(item)).filter(Boolean)
      : roomText(value)
        ? [roomText(value)]
        : [];
  return {
    agent,
    role,
    planId,
    status: contribution ? "available" : "invalid",
    ...(diagnostic || !contribution
      ? {
          diagnostic: [
            diagnostic,
            !contribution
              ? `${role}返回了方案 ${planId}，但贡献字段缺失或为空`
              : "",
          ]
            .filter(Boolean)
            .join("；"),
        }
      : {}),
    contribution,
    evidence: textList(record.evidence ?? record.basis ?? record.references),
    assumptions: textList(record.assumptions ?? record.hypotheses),
    conflicts: textList(record.conflicts ?? record.risks ?? record.constraints),
  };
}

export function parseBrainstormContributionBatch(
  output: string,
  agent: number,
  role: string,
  contracts: readonly BrainstormPlanContract[],
): readonly BrainstormDesignerContribution[] {
  const source = extractJson(output);
  const values = brainstormContributionValues(source);
  const contractByNormalizedId = new Map(
    contracts.map((contract) => [
      normalizeBrainstormPlanId(contract.id),
      contract,
    ]),
  );
  const byPlanId = new Map<string, BrainstormDesignerContribution>();
  const diagnostics: string[] = [];
  const unresolved: Record<string, unknown>[] = [];
  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const returnedPlanId = roomText(
      record.planId ?? record.plan_id ?? record.id,
    );
    const contract = contractByNormalizedId.get(
      normalizeBrainstormPlanId(returnedPlanId),
    );
    if (!contract) {
      unresolved.push(record);
      if (returnedPlanId) diagnostics.push(`未知方案 ID：${returnedPlanId}`);
      else diagnostics.push(`第 ${index + 1} 项缺少 planId`);
      continue;
    }
    if (byPlanId.has(contract.id)) {
      diagnostics.push(`方案 ${contract.id} 返回了重复贡献`);
      continue;
    }
    byPlanId.set(
      contract.id,
      parseBrainstormContributionRecord(record, agent, role, contract.id),
    );
  }
  if (values.length === contracts.length) {
    const unmatchedContracts = contracts.filter(
      (contract) => !byPlanId.has(contract.id),
    );
    if (unresolved.length === unmatchedContracts.length) {
      unresolved.forEach((record, index) => {
        const contract = unmatchedContracts[index];
        if (!contract) return;
        byPlanId.set(
          contract.id,
          parseBrainstormContributionRecord(
            record,
            agent,
            role,
            contract.id,
            "返回项的 planId 未能匹配方案契约，已按方案顺序对齐",
          ),
        );
      });
      if (unresolved.length) {
        diagnostics.push("部分贡献缺少可识别的 planId，已按方案顺序对齐");
      }
    }
  }
  return contracts.map(
    (contract) =>
      byPlanId.get(contract.id) ?? {
        agent,
        role,
        planId: contract.id,
        status: "missing",
        diagnostic: [
          `${role}未返回方案 ${contract.id} 的贡献`,
          ...diagnostics,
        ].join("；"),
        contribution: "",
        evidence: [],
        assumptions: [],
        conflicts: [`${role}未返回方案 ${contract.id} 的贡献`, ...diagnostics],
      },
  );
}

export function parseBrainstormCouncilNote(
  output: string,
  agent: number,
  role: string,
): BrainstormCouncilNote {
  const source = extractJson(output);
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${role}未返回有效会诊意见`);
  }
  const record = source as Record<string, unknown>;
  const textList = (value: unknown): readonly string[] =>
    Array.isArray(value)
      ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
  return {
    agent,
    role,
    opportunities: textList(record.opportunities),
    constraints: textList(record.constraints),
    recommendation: roomText(record.recommendation),
    questions: textList(record.questions),
  };
}

export function parseBrainstormCompletePlan(
  output: string,
  contract: BrainstormPlanContract,
  contributions: readonly BrainstormDesignerContribution[],
): BrainstormCompletePlan {
  const source = extractJson(output);
  const record =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  const textList = (value: unknown): readonly string[] =>
    Array.isArray(value)
      ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
  const auditRecord =
    record.audit &&
    typeof record.audit === "object" &&
    !Array.isArray(record.audit)
      ? (record.audit as Record<string, unknown>)
      : {};
  return {
    id: roomText(record.id) || contract.id,
    title: roomText(record.title) || contract.title,
    premise: roomText(record.premise) || contract.coreChoice,
    content:
      roomText(record.content) ||
      contributions
        .map((item) => item.contribution)
        .filter(Boolean)
        .join("\n\n"),
    opening: roomText(record.opening),
    beats: textList(record.beats).length
      ? textList(record.beats)
      : contract.requiredBeats,
    evidence: textList(record.evidence).length
      ? textList(record.evidence)
      : contributions.flatMap((item) => item.evidence),
    assumptions: textList(record.assumptions).length
      ? textList(record.assumptions)
      : contributions.flatMap((item) => item.assumptions),
    conflicts: textList(record.conflicts).length
      ? textList(record.conflicts)
      : contributions.flatMap((item) => item.conflicts),
    contributions,
    audit: {
      score: Math.max(0, Math.min(100, Number(auditRecord.score) || 0)),
      summary: roomText(auditRecord.summary),
      risks: textList(auditRecord.risks),
    },
  };
}

export function parseBrainstormCompletePlanBatch(
  output: string,
  contracts: readonly BrainstormPlanContract[],
  contributions: readonly BrainstormDesignerContribution[],
): readonly BrainstormCompletePlan[] {
  const source = extractJson(output);
  const values = Array.isArray(source)
    ? source
    : source &&
        typeof source === "object" &&
        !Array.isArray(source) &&
        Array.isArray((source as { plans?: unknown }).plans)
      ? (source as { plans: unknown[] }).plans
      : [];
  const byPlanId = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const planId = roomText(record.id);
    if (
      contracts.some((contract) => contract.id === planId) &&
      !byPlanId.has(planId)
    ) {
      byPlanId.set(planId, record);
    }
  }
  return contracts.map((contract) => {
    const planContributions = contributions.filter(
      (item) => item.planId === contract.id,
    );
    const record = byPlanId.get(contract.id);
    if (!record) {
      return {
        id: contract.id,
        title: contract.title,
        premise: contract.coreChoice,
        content: planContributions
          .map((item) => item.contribution)
          .filter(Boolean)
          .join("\n\n"),
        opening: contract.hook,
        beats: contract.requiredBeats,
        evidence: planContributions.flatMap((item) => item.evidence),
        assumptions: planContributions.flatMap((item) => item.assumptions),
        conflicts: [...contract.openQuestions, "总控未返回该方案的整合结果"],
        contributions: planContributions,
        audit: {
          score: 0,
          summary: "需要人工审阅。",
          risks: ["缺少总控整合结果"],
        },
      };
    }
    return parseBrainstormCompletePlan(
      JSON.stringify(record),
      contract,
      planContributions,
    );
  });
}

function isTrackingOperationCompatible(
  domain: ManuscriptTrackingChange["domain"],
  operation: ManuscriptTrackingOperation,
): boolean {
  if (domain === "timeline") return operation.kind === "timeline-event";
  if (domain === "character-appearance")
    return operation.kind === "character-appearance";
  if (domain === "character-state") return operation.kind === "character-field";
  if (domain === "relationship") return operation.kind === "relationship";
  if (domain === "inventory") return operation.kind === "inventory";
  if (domain === "location") return operation.kind === "location-field";
  if (domain === "faction") return operation.kind === "faction-field";
  if (domain === "foreshadow") return operation.kind === "foreshadow";
  return operation.kind === "continuity-fact";
}

export function parseTrackingProposal(output: string): {
  readonly summary: string;
  readonly changes: readonly Omit<ManuscriptTrackingChange, "id">[];
} {
  const source = extractJson(output);
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("连续性分析必须返回 JSON 对象");
  }
  const record = source as Record<string, unknown>;
  if (!Array.isArray(record.changes))
    throw new Error("连续性分析缺少 changes 数组");
  const changes = record.changes.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const domain = manuscriptTrackingDomainSchema.safeParse(item.domain);
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const after = typeof item.after === "string" ? item.after.trim() : "";
    const evidence =
      typeof item.evidence === "string" ? item.evidence.trim() : "";
    if (!domain.success || !title || !after || !evidence) return [];
    const directOperation = manuscriptTrackingOperationSchema.safeParse(
      item.operation,
    );
    const stableKey =
      typeof item.key === "string" && /^[a-z0-9][a-z0-9-]*$/u.test(item.key)
        ? item.key
        : `fact-${index + 1}`;
    const operationCandidate = (
      directOperation.success
        ? directOperation.data
        : domain.data === "timeline"
          ? {
              kind: "timeline-event" as const,
              eventKind:
                item.eventKind === "turning-point" ||
                item.eventKind === "battle" ||
                item.eventKind === "discovery" ||
                item.eventKind === "foreshadowing" ||
                item.eventKind === "backstory"
                  ? item.eventKind
                  : ("event" as const),
              timeLabel:
                typeof item.timeLabel === "string" ? item.timeLabel : "",
            }
          : domain.data === "character-appearance"
            ? ({ kind: "character-appearance" } as const)
            : domain.data === "character-state"
              ? ({
                  kind: "character-field",
                  field:
                    item.field === "currentRealm" ||
                    item.field === "goals" ||
                    item.field === "motivation" ||
                    item.field === "hometown"
                      ? item.field
                      : "status",
                } as const)
              : domain.data === "relationship" &&
                  typeof item.targetEntityId === "string"
                ? ({
                    kind: "relationship",
                    targetCharacterId: item.targetEntityId,
                    relationType:
                      typeof item.relationType === "string" &&
                      item.relationType.trim()
                        ? item.relationType.trim()
                        : "剧情关系",
                    tone:
                      item.tone === "positive" || item.tone === "negative"
                        ? item.tone
                        : "neutral",
                  } as const)
                : domain.data === "inventory"
                  ? ({
                      kind: "inventory",
                      itemId:
                        typeof item.itemId === "string" && item.itemId.trim()
                          ? item.itemId.trim()
                          : null,
                      name:
                        typeof item.itemName === "string" &&
                        item.itemName.trim()
                          ? item.itemName.trim()
                          : title,
                      quantity:
                        typeof item.quantity === "number" && item.quantity >= 0
                          ? item.quantity
                          : 1,
                      unit: typeof item.unit === "string" ? item.unit : "",
                    } as const)
                  : domain.data === "location"
                    ? ({
                        kind: "location-field",
                        field:
                          item.field === "status" || item.field === "summary"
                            ? item.field
                            : "appearanceNote",
                        status:
                          item.status === "planned" ||
                          item.status === "appeared" ||
                          item.status === "archived"
                            ? item.status
                            : null,
                      } as const)
                    : domain.data === "faction"
                      ? ({
                          kind: "faction-field",
                          field:
                            item.field === "status" ||
                            item.field === "governance" ||
                            item.field === "military" ||
                            item.field === "economy" ||
                            item.field === "publicSupport" ||
                            item.field === "territorialIntegrity"
                              ? item.field
                              : "summary",
                          status:
                            item.status === "active" ||
                            item.status === "neutral" ||
                            item.status === "declining" ||
                            item.status === "dissolved"
                              ? item.status
                              : null,
                        } as const)
                      : domain.data === "foreshadow"
                        ? ({
                            kind: "foreshadow",
                            foreshadowingId:
                              typeof item.foreshadowingId === "string" &&
                              item.foreshadowingId.trim()
                                ? item.foreshadowingId.trim()
                                : null,
                            status:
                              item.status === "paid-off" ||
                              item.status === "abandoned"
                                ? item.status
                                : "planted",
                            payoffEventId:
                              typeof item.payoffEventId === "string" &&
                              item.payoffEventId.trim()
                                ? item.payoffEventId.trim()
                                : null,
                          } as const)
                        : domain.data === "world-rule" ||
                            domain.data === "continuity"
                          ? ({
                              kind: "continuity-fact",
                              key: stableKey,
                            } as const)
                          : null
    ) as ManuscriptTrackingOperation | null;
    const parsedOperation =
      manuscriptTrackingOperationSchema.safeParse(operationCandidate);
    if (
      !parsedOperation.success ||
      !isTrackingOperationCompatible(domain.data, parsedOperation.data)
    ) {
      return [];
    }
    return [
      {
        domain: domain.data,
        entityId:
          typeof item.entityId === "string" && item.entityId.trim()
            ? item.entityId.trim()
            : null,
        title,
        before: typeof item.before === "string" ? item.before : null,
        after,
        evidence,
        operation: parsedOperation.data,
      },
    ];
  });
  if (record.changes.length > 0 && !changes.length) {
    throw new Error("连续性分析返回的变化均不可执行，请重新运行分析");
  }
  return {
    summary: typeof record.summary === "string" ? record.summary : "",
    changes,
  };
}

export function parseNarrativeExtraction(
  output: string,
  chapters: readonly LoadedNovelChapter[],
): readonly NarrativeExtractionDraft[] {
  const source = extractJson(output);
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("正文提炼必须返回 JSON 对象");
  }
  const values = (source as { chapters?: unknown }).chapters;
  if (!Array.isArray(values)) {
    throw new Error("正文提炼缺少 chapters 数组");
  }
  if (!chapters.length) {
    throw new Error("没有可供提炼的正文章节");
  }
  const requested = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  const drafts = values.flatMap((value, index): NarrativeExtractionDraft[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const chapterId = String(record.sourceChapterId ?? "").trim();
    const chapter = requested.get(chapterId);
    if (!chapter) return [];
    if (seen.has(chapterId)) {
      duplicateIds.add(chapterId);
      return [];
    }
    seen.add(chapterId);
    const title = String(record.title ?? chapter.title).trim() || chapter.title;
    const description = String(record.description ?? "").trim();
    const sections = Array.isArray(record.sections)
      ? record.sections.slice(0, 12).flatMap((section, sectionIndex) => {
          if (!section || typeof section !== "object" || Array.isArray(section))
            return [];
          const item = section as Record<string, unknown>;
          const sectionTitle = String(item.title ?? "").trim();
          const sectionDescription = String(item.description ?? "").trim();
          if (!sectionTitle && !sectionDescription) return [];
          return [
            {
              title: sectionTitle || `场景 ${sectionIndex + 1}`,
              description: sectionDescription,
            },
          ];
        })
      : [];
    return [
      {
        chapterId,
        title,
        description:
          description ||
          `正文实录：${excerpt(chapter.content, 180) || `第 ${index + 1} 个已选章节`}`,
        sections,
      },
    ];
  });
  const missingIds = chapters
    .map((chapter) => chapter.id)
    .filter((chapterId) => !seen.has(chapterId));
  if (duplicateIds.size) {
    throw new Error("正文提炼返回了重复章节结果，请重新运行提炼");
  }
  if (missingIds.length) {
    throw new Error(
      `正文提炼缺少 ${missingIds.length} 个已选章节结果，请重新运行提炼`,
    );
  }
  if (!drafts.length) {
    throw new Error("AI 未返回任何可关联的正文章节提炼结果");
  }
  return drafts;
}

export function parseQualityReview(output: string): QualityReview {
  const source = extractJson(output);
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("质量检查必须返回 JSON 对象");
  }
  const record = source as Record<string, unknown>;
  const rawScore = record.score;
  const score =
    typeof rawScore === "number"
      ? rawScore
      : typeof rawScore === "string" && rawScore.trim()
        ? Number(rawScore)
        : Number.NaN;
  if (!Number.isFinite(score)) {
    throw new Error("质量检查缺少有效的 score 数值");
  }
  const rawIssues = Array.isArray(record.issues) ? record.issues : [];
  const issues = rawIssues.flatMap((item): QualityIssue[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const issue = item as Record<string, unknown>;
    const severity =
      issue.severity === "error" ||
      issue.severity === "warning" ||
      issue.severity === "suggestion"
        ? issue.severity
        : "suggestion";
    const title = String(issue.title ?? "").trim();
    if (!title) return [];
    return [
      {
        category: String(issue.category ?? "综合").trim() || "综合",
        severity,
        title,
        detail: String(issue.detail ?? "").trim(),
        evidence: String(issue.evidence ?? "").trim(),
        suggestion: String(issue.suggestion ?? "").trim(),
      },
    ];
  });
  const summary = String(record.summary ?? "").trim();
  const passed = Array.isArray(record.passed)
    ? record.passed.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (!summary && !issues.length && !passed.length) {
    throw new Error("质量检查没有返回摘要、问题或已通过项");
  }
  return {
    score: Math.max(0, Math.min(100, score)),
    summary,
    issues,
    passed,
  };
}

export function isQualityReviewCurrent({
  sourceContent,
  currentDraftContent,
  currentSavedContent,
  currentPersistedContent,
  externalChanged,
}: {
  readonly sourceContent: string;
  readonly currentDraftContent: string;
  readonly currentSavedContent: string;
  readonly currentPersistedContent: string | undefined;
  readonly externalChanged: boolean;
}): boolean {
  return (
    !externalChanged &&
    sourceContent === currentDraftContent &&
    sourceContent === currentSavedContent &&
    sourceContent === currentPersistedContent
  );
}

export function countCharacters(value: string): number {
  return Array.from(value).filter((character) => !/\s/u.test(character)).length;
}

export function buildWritingWordBudget(
  targetWordCount: number | null,
  mode: WritingAiMode,
  currentCount: number,
  targetCount: number,
): string {
  if (!targetWordCount) return "本章未设置目标字数，不做固定字数约束。";
  const minimum = Math.ceil(targetWordCount * 0.9);
  const maximum = Math.floor(targetWordCount * 1.1);
  const remaining = Math.max(0, targetWordCount - currentCount);
  const modeRule =
    mode === "generate"
      ? `完整生成结果必须控制在 ${minimum}～${maximum} 字。`
      : mode === "continue"
        ? `续写完成后的整章正文必须控制在 ${minimum}～${maximum} 字；当前已有 ${currentCount} 字，本次新增内容通常控制在不超过 ${remaining + Math.ceil(targetWordCount * 0.1)} 字。`
        : mode === "revise"
          ? `润色不得明显改变篇幅；处理结果应使整章正文尽量保持在 ${minimum}～${maximum} 字，除非原文已经超出范围。`
          : `扩写完成后的整章正文必须控制在 ${minimum}～${maximum} 字；不要为了凑字数重复表达或添加计划外剧情。`;
  return [
    `字数约束（本章目标默认继承项目总览：${targetWordCount} 字，允许上下浮动 10%，即 ${minimum}～${maximum} 字）。`,
    `当前整章非空字符数：${currentCount}；本次处理文本非空字符数：${targetCount}。`,
    modeRule,
    "字数按中文、英文、数字和标点等非空字符计数；不要输出说明、标题或 Markdown 代码围栏。",
  ].join("\n");
}

export interface FullGenerationTextBudget {
  readonly count: number;
  readonly target: number | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly withinRange: boolean;
}

export function evaluateFullGenerationTextBudget(
  content: string,
  targetWordCount: number | null | undefined,
): FullGenerationTextBudget {
  const count = countCharacters(content);
  if (!targetWordCount || !Number.isFinite(targetWordCount)) {
    return {
      count,
      target: null,
      minimum: null,
      maximum: null,
      withinRange: true,
    };
  }
  const target = Math.max(1, Math.round(targetWordCount));
  const minimum = Math.ceil(target * 0.9);
  const maximum = Math.floor(target * 1.1);
  return {
    count,
    target,
    minimum,
    maximum,
    withinRange: count >= minimum && count <= maximum,
  };
}

const FULL_GENERATION_META_LINE =
  /^(?:let me\b.*(?:count|estimate|check|range)|actually,?\s+let me\b|i(?:'ll| will)\s+(?:estimate|count|check)|paragraph\s+\d+\s*[:：]|(?:word|character)\s*count\s*[:：]|(?:total|estimated)\b.*(?:words?|characters?)|(?:字数|字符数)(?:统计|核对|估算|检查)?\s*[:：])/iu;

export function sanitizeFullGenerationTextOutput(output: string): string {
  const normalized = stripCodeFence(output)
    .replace(/<thinking>[\s\S]*?<\/thinking>/giu, "")
    .replace(/<analysis>[\s\S]*?<\/analysis>/giu, "")
    .trim();
  if (!normalized) return "";
  const lines = normalized.split(/\r?\n/u);
  let metaStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!FULL_GENERATION_META_LINE.test(lines[index]?.trim() ?? "")) continue;
    const tail = lines.slice(index).filter((line) => line.trim());
    const metaLines = tail.filter((line) =>
      FULL_GENERATION_META_LINE.test(line.trim()),
    ).length;
    const prefix = lines.slice(0, index).join("\n").trim();
    if (
      countCharacters(prefix) >= 100 &&
      (metaLines >= 2 || tail.length <= 3)
    ) {
      metaStart = index;
      break;
    }
  }
  if (metaStart < 0) return normalized;
  let cutAt = metaStart;
  while (cutAt > 0 && !lines[cutAt - 1]?.trim()) cutAt -= 1;
  if (cutAt > 0 && /^-{3,}$/u.test(lines[cutAt - 1]?.trim() ?? "")) {
    cutAt -= 1;
  }
  return lines.slice(0, cutAt).join("\n").trim();
}

function getTextareaSelectionAnchor(
  textarea: HTMLTextAreaElement,
  selectionEnd: number,
): SelectionToolbarPosition {
  const rect = textarea.getBoundingClientRect();
  const fallback = {
    left: rect.left + rect.width / 2,
    top: rect.top + Math.min(rect.height - 20, 48),
  };
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallback;
  }
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const copiedProperties = [
    "box-sizing",
    "border-left-width",
    "border-right-width",
    "border-top-width",
    "border-bottom-width",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "font-variant",
    "line-height",
    "letter-spacing",
    "text-transform",
    "text-indent",
    "text-align",
    "tab-size",
  ];
  copiedProperties.forEach((property) =>
    mirror.style.setProperty(property, computed.getPropertyValue(property)),
  );
  mirror.style.position = "fixed";
  mirror.style.left = `${rect.left}px`;
  mirror.style.top = `${rect.top}px`;
  mirror.style.width = `${rect.width}px`;
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflow = "hidden";
  mirror.textContent = textarea.value.slice(0, selectionEnd);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(selectionEnd) || "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const markerRect = marker.getBoundingClientRect();
  mirror.remove();
  return {
    left: Math.min(
      rect.right - 16,
      Math.max(rect.left + 16, markerRect.left - textarea.scrollLeft),
    ),
    top: Math.min(
      rect.bottom - 12,
      Math.max(rect.top + 16, markerRect.top - textarea.scrollTop),
    ),
  };
}

interface SelectionPopoverDragState {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startLeft: number;
  readonly startTop: number;
}

function clampSelectionPopoverPosition(
  element: HTMLElement,
  left: number,
  top: number,
) {
  const viewportPadding = 12;
  const bounds = element.getBoundingClientRect();
  return {
    left: Math.min(
      Math.max(viewportPadding, left),
      Math.max(
        viewportPadding,
        window.innerWidth - bounds.width - viewportPadding,
      ),
    ),
    top: Math.min(
      Math.max(viewportPadding, top),
      Math.max(
        viewportPadding,
        window.innerHeight - bounds.height - viewportPadding,
      ),
    ),
  };
}

function useSelectionPopoverLayout(anchor: SelectionToolbarPosition | null) {
  const elementRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<SelectionPopoverDragState | null>(null);
  const manualPositionRef = useRef(false);
  const updateLayout = useCallback(() => {
    const element = elementRef.current;
    if (!anchor || !element || typeof window === "undefined") return;

    if (manualPositionRef.current) {
      const next = clampSelectionPopoverPosition(
        element,
        element.getBoundingClientRect().left,
        element.getBoundingClientRect().top,
      );
      element.style.left = `${next.left}px`;
      element.style.top = `${next.top}px`;
      return;
    }

    const bounds = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const viewportPadding = 12;
    const gap = 12;
    const spaceBelow = viewportHeight - anchor.top - gap - viewportPadding;
    const spaceAbove = anchor.top - gap - viewportPadding;
    const placement =
      spaceBelow >= bounds.height || spaceBelow >= spaceAbove
        ? "below"
        : "above";
    const minimumLeft = bounds.width / 2 + viewportPadding;
    const maximumLeft = viewportWidth - bounds.width / 2 - viewportPadding;
    const left =
      minimumLeft > maximumLeft
        ? viewportWidth / 2
        : Math.min(maximumLeft, Math.max(minimumLeft, anchor.left));

    element.style.left = `${left}px`;
    element.style.top = `${placement === "below" ? anchor.top + gap : anchor.top - gap}px`;
    element.classList.toggle("is-above", placement === "above");
  }, [anchor]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (
        event.button !== 0 ||
        (event.target as HTMLElement).closest("button, input, a")
      ) {
        return;
      }
      const element = elementRef.current;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      manualPositionRef.current = true;
      element.classList.remove("is-above");
      element.classList.add("is-manual");
      element.style.left = `${bounds.left}px`;
      element.style.top = `${bounds.top}px`;
      dragRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLeft: bounds.left,
        startTop: bounds.top,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      const element = elementRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !element) return;
      const next = clampSelectionPopoverPosition(
        element,
        drag.startLeft + event.clientX - drag.startClientX,
        drag.startTop + event.clientY - drag.startClientY,
      );
      element.style.left = `${next.left}px`;
      element.style.top = `${next.top}px`;
      event.preventDefault();
    },
    [],
  );

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useLayoutEffect(() => {
    if (!anchor || !elementRef.current || typeof window === "undefined") return;
    updateLayout();
    window.addEventListener("resize", updateLayout);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateLayout);
    resizeObserver?.observe(elementRef.current);
    return () => {
      window.removeEventListener("resize", updateLayout);
      resizeObserver?.disconnect();
    };
  }, [anchor, updateLayout]);

  return {
    elementRef,
    dragHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: finishDrag,
      onPointerCancel: finishDrag,
    },
  };
}

export type BrainstormPlanContentBlock =
  | {
      readonly kind: "heading";
      readonly text: string;
    }
  | {
      readonly kind: "step";
      readonly marker: string;
      readonly text: string;
    }
  | {
      readonly kind: "paragraph";
      readonly text: string;
    };

export function formatBrainstormPlanContent(
  value: string,
): readonly BrainstormPlanContentBlock[] {
  const normalized = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]*(【[^【】\n]+】)[ \t]*/gu, "\n\n$1\n\n")
    .replace(/[ \t]*([①-⑳])/gu, "\n\n$1 ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!normalized) return [];

  return normalized
    .split(/\n\s*\n/u)
    .flatMap<BrainstormPlanContentBlock>((section) => {
      const text = section.trim();
      if (/^【[^【】\n]+】$/u.test(text)) {
        return [{ kind: "heading" as const, text }];
      }
      const step = /^([①-⑳])\s*(.*)$/su.exec(text);
      if (step) {
        return [
          {
            kind: "step" as const,
            marker: step[1],
            text: step[2].trim(),
          },
        ];
      }
      return [{ kind: "paragraph" as const, text }];
    });
}

function splitParagraphs(value: string): readonly string[] {
  return value
    .split(/\n\s*\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function excerpt(value: string, limit = 180): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}……` : compact;
}

function directoryIcon(open: boolean) {
  return open ? (
    <FolderOpen className="h-3.5 w-3.5" />
  ) : (
    <Folder className="h-3.5 w-3.5" />
  );
}

function StructureBadge({ mode }: { readonly mode: ManuscriptStructureMode }) {
  const locked = mode === "locked";
  return (
    <span
      className={`ms-structure-badge ${locked ? "is-locked" : "is-merged"}`}
    >
      {locked ? <Lock className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
      {locked ? "结构已锁定" : "剧情结构同步"}
    </span>
  );
}

function DeleteChapterDialog({
  open,
  title,
  appliedBatchCount,
  appliedChangeCount,
  deleting,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly appliedBatchCount: number;
  readonly appliedChangeCount: number;
  readonly deleting: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  useCloseLayer(() => {
    if (!open) return false;
    if (!deleting) onCancel();
    return true;
  }, 220);
  if (!open) return null;
  return (
    <DraggableDialogFrame
      ariaLabel="删除章节"
      className="w-[min(520px,calc(100vw-24px))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center gap-2 px-4">
          <AlertTriangle className="h-4 w-4 text-[var(--error)]" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
            删除“{title}”
          </h2>
          <button
            className="ns-icon-button border-0"
            type="button"
            onClick={onCancel}
            disabled={deleting}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="ms-delete-impact">
        <p>章节正文会移入项目回收站，剧情章节计划不会被删除。</p>
        <div className="ms-impact-summary">
          <span>
            <strong>1</strong>
            <small>正文文件</small>
          </span>
          <span>
            <strong>{appliedBatchCount}</strong>
            <small>状态批次</small>
          </span>
          <span>
            <strong>{appliedChangeCount}</strong>
            <small>状态变化</small>
          </span>
          <span>
            <strong>1</strong>
            <small>剧情关联</small>
          </span>
        </div>
        {appliedBatchCount > 0 && (
          <div className="ms-impact-warning">
            <History className="h-4 w-4" />
            <span>
              删除会回退人物、时间线、物品、伏笔等已应用状态；恢复章节时可重新应用。
            </span>
          </div>
        )}
        <label className="ms-delete-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>我已查看影响范围，确认移动正文并重建连续性状态。</span>
        </label>
      </div>
      <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
        <button
          className="ns-button"
          type="button"
          onClick={onCancel}
          disabled={deleting}
        >
          取消
        </button>
        <button
          className="ns-button is-danger"
          type="button"
          onClick={onConfirm}
          disabled={deleting || !confirmed}
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          {deleting
            ? "正在回退并删除"
            : `删除并回退 ${appliedChangeCount} 项状态`}
        </button>
      </footer>
    </DraggableDialogFrame>
  );
}

function ManuscriptVersionDialog({
  open,
  chapterTitle,
  currentContent,
  versions,
  selectedVersion,
  maxVersions,
  versionLimitDraft,
  dirty,
  busy,
  onClose,
  onSelectVersion,
  onVersionLimitChange,
  onVersionLimitBlur,
  onRestore,
}: {
  readonly open: boolean;
  readonly chapterTitle: string;
  readonly currentContent: string;
  readonly versions: readonly ManuscriptVersionRecord[];
  readonly selectedVersion: ManuscriptVersionRecord | null;
  readonly maxVersions: number;
  readonly versionLimitDraft: string;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSelectVersion: (version: ManuscriptVersionRecord) => void;
  readonly onVersionLimitChange: (value: string) => void;
  readonly onVersionLimitBlur: () => void;
  readonly onRestore: (version: ManuscriptVersionRecord) => void;
}) {
  useCloseLayer(() => {
    if (!open) return false;
    if (!busy) onClose();
    return true;
  }, 220);
  if (!open) return null;
  return (
    <DraggableDialogFrame
      ariaLabel="正文历史版本"
      className="ms-version-dialog"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center gap-2 px-4">
          <History className="h-4 w-4 text-[var(--accent-warm)]" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">正文历史版本</h2>
            <span className="block truncate text-xs text-[var(--ink-muted)]">
              {chapterTitle}
            </span>
          </div>
          <button
            type="button"
            className="ns-icon-button border-0"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭历史版本"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="ms-version-dialog-body">
        <aside className="ms-version-dialog-list">
          <div className="ms-version-dialog-list-header">
            <strong>历史版本</strong>
            <span>
              {versions.length} / {maxVersions}
            </span>
          </div>
          <label className="ms-version-limit-field">
            <span>最大保留版本数</span>
            <input
              type="number"
              min={1}
              max={200}
              value={versionLimitDraft}
              onChange={(event) => onVersionLimitChange(event.target.value)}
              onBlur={onVersionLimitBlur}
              aria-label="最大保留版本数"
            />
          </label>
          <div className="ms-version-dialog-items">
            {versions.map((version) => (
              <button
                type="button"
                key={version.versionId}
                className={`ms-version-dialog-item ${selectedVersion?.versionId === version.versionId ? "is-selected" : ""}`}
                onClick={() => onSelectVersion(version)}
              >
                <strong>
                  {new Date(version.createdAt).toLocaleString("zh-CN")}
                </strong>
                <span>
                  {version.wordCount.toLocaleString()} 字 ·{" "}
                  {version.source === "restore"
                    ? "恢复前快照"
                    : version.source === "ai-apply"
                      ? "AI 应用"
                      : "手动保存"}
                </span>
              </button>
            ))}
            {!versions.length && (
              <p className="ms-inspector-empty">暂无历史版本</p>
            )}
          </div>
        </aside>
        <section className="ms-version-dialog-compare">
          <header>
            <div>
              <strong>版本对比</strong>
              <span>
                {selectedVersion
                  ? new Date(selectedVersion.createdAt).toLocaleString("zh-CN")
                  : "请选择历史版本"}
              </span>
            </div>
            <button
              type="button"
              className="ns-button is-primary"
              disabled={!selectedVersion || dirty || busy}
              onClick={() => selectedVersion && onRestore(selectedVersion)}
              title={dirty ? "请先保存当前正文" : "恢复选中版本"}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArchiveRestore className="h-3.5 w-3.5" />
              )}
              恢复到当前版本
            </button>
          </header>
          <div className="min-h-0 flex-1">
            {selectedVersion ? (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    正在载入差异
                  </div>
                }
              >
                <DiffViewer
                  key={selectedVersion.versionId}
                  original={selectedVersion.content}
                  modified={currentContent}
                  language="markdown"
                  renderSideBySide
                  className="h-full"
                />
              </Suspense>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                从左侧选择一个历史版本
              </div>
            )}
          </div>
          {dirty && (
            <p className="ms-version-dialog-warning">
              当前正文有未保存修改，请先保存后再恢复历史版本。
            </p>
          )}
        </section>
      </div>
    </DraggableDialogFrame>
  );
}

function NarrativeExtractionDialog({
  open,
  chapters,
  selectedChapterIds,
  narrativePlans,
  targetNarrativeChapterId,
  drafts,
  busy,
  aiAvailable,
  onClose,
  onToggleChapter,
  onTargetChange,
  onChangeDraft,
  onRun,
  onApply,
}: {
  readonly open: boolean;
  readonly chapters: readonly LoadedNovelChapter[];
  readonly selectedChapterIds: ReadonlySet<string>;
  readonly narrativePlans: LoadedNovelProject["narrative"]["library"]["chapters"];
  readonly targetNarrativeChapterId: string;
  readonly drafts: readonly NarrativeExtractionDraft[];
  readonly busy: boolean;
  readonly aiAvailable: boolean;
  readonly onClose: () => void;
  readonly onToggleChapter: (chapterId: string, checked: boolean) => void;
  readonly onTargetChange: (value: string) => void;
  readonly onChangeDraft: (
    chapterId: string,
    patch: Partial<Omit<NarrativeExtractionDraft, "chapterId">>,
  ) => void;
  readonly onRun: () => void;
  readonly onApply: () => void;
}) {
  useCloseLayer(() => {
    if (!open) return false;
    if (!busy) onClose();
    return true;
  }, 220);
  if (!open) return null;
  const selectedCount = selectedChapterIds.size;
  const canApply = Boolean(drafts.length) && !busy;
  const hasPendingDrafts = drafts.length > 0;
  return (
    <DraggableDialogFrame
      ariaLabel="从正文提炼到剧情工程"
      className="ms-extraction-dialog"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center gap-2 px-4">
          <BookMarked className="h-4 w-4 text-[var(--accent-warm)]" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">
              从正文提炼到剧情工程
            </h2>
            <span className="block truncate text-xs text-[var(--ink-muted)]">
              正文事实优先，确认后写入当前剧情工程
            </span>
          </div>
          <button
            type="button"
            className="ns-icon-button border-0"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭正文提炼"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="ms-extraction-dialog-body">
        <aside className="ms-extraction-sources">
          <header>
            <strong>正文范围</strong>
            <span>{selectedCount} 章</span>
          </header>
          <p>可一次选择多章；每章会提炼为独立的剧情章节。</p>
          <div className="ms-extraction-source-list">
            {chapters.map((chapter) => (
              <label key={chapter.id}>
                <input
                  type="checkbox"
                  checked={selectedChapterIds.has(chapter.id)}
                  disabled={busy || hasPendingDrafts}
                  onChange={(event) =>
                    onToggleChapter(chapter.id, event.target.checked)
                  }
                />
                <span>
                  <strong>
                    第 {chapter.displayNumber} 章 · {chapter.title}
                  </strong>
                  <small>{chapter.words.toLocaleString()} 字</small>
                </span>
              </label>
            ))}
          </div>
          <label className="ms-extraction-target">
            <span>写入位置</span>
            <CustomSelect
              value={targetNarrativeChapterId}
              options={[
                { value: "", label: "新建剧情章节" },
                ...narrativePlans.map((plan) => ({
                  value: plan.id,
                  label: plan.title,
                })),
              ]}
              onChange={onTargetChange}
              ariaLabel="剧情工程写入位置"
              size="toolbar"
              disabled={busy || hasPendingDrafts || selectedCount !== 1}
            />
          </label>
          {selectedCount !== 1 && (
            <p className="ms-extraction-hint">
              批量抽取会为每章新建剧情章节，避免覆盖已有规划。
            </p>
          )}
          <button
            type="button"
            className="ns-button is-primary w-full"
            onClick={onRun}
            disabled={busy || hasPendingDrafts || !selectedCount || !aiAvailable}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {busy ? "正在提炼" : "AI 提炼正文事实"}
          </button>
          {hasPendingDrafts && (
            <p className="ms-extraction-hint">
              当前提炼结果待确认；写入或放弃后才可修改范围并重新提炼。
            </p>
          )}
          {!aiAvailable && (
            <p className="ms-extraction-hint">
              当前没有可用模型，无法自动提炼。
            </p>
          )}
        </aside>
        <section className="ms-extraction-preview">
          <header>
            <div>
              <strong>剧情工程预览</strong>
              <span>确认后才写入，不会改动正文原文</span>
            </div>
            <button
              type="button"
              className="ns-button is-primary"
              onClick={onApply}
              disabled={!canApply}
              title="确认后写入剧情工程，不会修改正文"
              aria-label="写入剧情工程"
            >
              <Check className="h-3.5 w-3.5" /> 写入剧情工程
            </button>
          </header>
          <div className="ms-extraction-preview-list">
            {drafts.map((draft) => (
              <article key={draft.chapterId}>
                <span>
                  {chapters.find((chapter) => chapter.id === draft.chapterId)
                    ?.title ?? "正文"}
                </span>
                <input
                  value={draft.title}
                  onChange={(event) =>
                    onChangeDraft(draft.chapterId, {
                      title: event.target.value,
                    })
                  }
                  disabled={busy}
                  aria-label="提炼后的剧情章节标题"
                />
                <textarea
                  value={draft.description}
                  onChange={(event) =>
                    onChangeDraft(draft.chapterId, {
                      description: event.target.value,
                    })
                  }
                  disabled={busy}
                  aria-label="提炼后的剧情章节概要"
                />
                <ol>
                  {draft.sections.map((section, index) => (
                    <li key={`${draft.chapterId}-${index}`}>
                      <strong>{section.title}</strong>
                      <span>{section.description || "未提取场景说明"}</span>
                    </li>
                  ))}
                  {!draft.sections.length && (
                    <li className="is-empty">未拆分场景，将只写入章节概要。</li>
                  )}
                </ol>
              </article>
            ))}
            {!drafts.length && (
              <div className="ms-room-empty">
                <BookMarked className="h-7 w-7" />
                <p>选择正文后运行提炼，结果会在这里供你确认。</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </DraggableDialogFrame>
  );
}

function EmptyWritingState({
  creating,
  onCreate,
}: {
  readonly creating: boolean;
  readonly onCreate: () => void;
}) {
  return (
    <div className="ms-empty-writing">
      <FileText className="h-7 w-7" />
      <h2>还没有正文</h2>
      <p>从空白章节开始，或切换到合并/锁定模式同步剧情工程章节。</p>
      <button
        type="button"
        className="ns-button is-primary"
        onClick={onCreate}
        disabled={creating}
      >
        {creating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <FilePlus2 className="h-4 w-4" />
        )}
        新建第一章
      </button>
    </div>
  );
}

export function assertManuscriptCandidateSourceSnapshot({
  currentDraftContent,
  currentPersistedContent,
  candidateSourceContent,
  candidatePersistedContent,
}: {
  readonly currentDraftContent: string;
  readonly currentPersistedContent: string;
  readonly candidateSourceContent: string;
  readonly candidatePersistedContent: string;
}): void {
  if (currentDraftContent !== candidateSourceContent) {
    throw new Error(
      "正文在候选生成后已经变化，请放弃候选并基于当前正文重新生成",
    );
  }
  if (currentPersistedContent !== candidatePersistedContent) {
    throw new Error(
      "磁盘正文在候选生成后已经变化，请先载入最新版本再重新生成候选",
    );
  }
}

function AiCandidatePanel({
  candidate,
  onApply,
  onDiscard,
  isApplying,
}: {
  readonly candidate: AiCandidate;
  readonly onApply: (content?: string) => void | Promise<void>;
  readonly onDiscard: () => void;
  readonly isApplying: boolean;
}) {
  const [partialMode, setPartialMode] = useState(false);
  const paragraphs = splitParagraphs(candidate.content);
  const [selectedParagraphs, setSelectedParagraphs] = useState<
    ReadonlySet<number>
  >(() => new Set(paragraphs.map((_, index) => index)));
  const label = {
    generate: "完整正文候选",
    continue: "续写候选",
    revise: "润色候选",
    expand: "扩写候选",
  }[candidate.mode];
  const before = candidate.sourceContent.slice(candidate.start, candidate.end);
  return (
    <section
      className="ms-ai-candidate"
      role="dialog"
      aria-label={label}
      aria-busy={isApplying}
    >
      <header>
        <div>
          <span className="ms-eyebrow">AI 候选</span>
          <h3>{label}</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="ns-button"
            onClick={onDiscard}
            disabled={isApplying}
          >
            放弃
          </button>
          <button
            type="button"
            className="ns-button"
            onClick={() => setPartialMode((current) => !current)}
            disabled={paragraphs.length < 2 || isApplying}
          >
            <ClipboardCheck className="h-3.5 w-3.5" /> 逐段选择
          </button>
          <button
            type="button"
            className="ns-button is-primary"
            onClick={() =>
              void onApply(
                partialMode
                  ? paragraphs
                      .filter((_, index) => selectedParagraphs.has(index))
                      .join("\n\n")
                  : undefined,
              )
            }
            disabled={
              isApplying || (partialMode && selectedParagraphs.size === 0)
            }
          >
            {isApplying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {isApplying ? "正在校验正文" : "接受并创建新修订"}
          </button>
        </div>
      </header>
      <div className="ms-candidate-diff">
        <section>
          <header>
            <span>当前正文</span>
            <small>BEFORE</small>
          </header>
          <div>{before || "（插入位置）"}</div>
        </section>
        <section>
          <header>
            <span>候选正文</span>
            <small>AFTER</small>
          </header>
          <div>
            {partialMode
              ? paragraphs.map((paragraph, index) => (
                  <label className="ms-candidate-paragraph" key={index}>
                    <input
                      type="checkbox"
                      checked={selectedParagraphs.has(index)}
                      onChange={(event) =>
                        setSelectedParagraphs((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(index);
                          else next.delete(index);
                          return next;
                        })
                      }
                    />
                    <span>{paragraph}</span>
                  </label>
                ))
              : candidate.content}
          </div>
        </section>
      </div>
    </section>
  );
}

function SelectionAiCandidatePopover({
  candidate,
  onApply,
  onDiscard,
  isApplying,
}: {
  readonly candidate: AiCandidate;
  readonly onApply: () => void | Promise<void>;
  readonly onDiscard: () => void;
  readonly isApplying: boolean;
}) {
  const label = {
    revise: "快速润色",
    expand: "快速扩写",
    generate: "快速生成",
    continue: "快速续写",
  }[candidate.mode];
  const before = candidate.sourceContent.slice(candidate.start, candidate.end);
  const { elementRef, dragHandlers } = useSelectionPopoverLayout(
    candidate.anchor,
  );
  return (
    <section
      ref={elementRef}
      className="ms-selection-ai-popover"
      role="dialog"
      aria-label={`AI ${label}结果`}
      style={
        candidate.anchor
          ? {
              left: candidate.anchor.left,
              top: candidate.anchor.top + 12,
            }
          : undefined
      }
    >
      <header {...dragHandlers} title="拖动标题栏移动窗口">
        <span>
          <Sparkles className="h-3.5 w-3.5" /> AI {label}
        </span>
        <button
          type="button"
          onClick={onDiscard}
          disabled={isApplying}
          aria-label="关闭快速 AI 结果"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <section className="ms-selection-ai-diff" aria-label="原文与 AI 候选对比">
        <header>
          <span>原选区 / AI 候选</span>
          <small>红色删除，绿色新增</small>
        </header>
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="ms-selection-ai-diff-loading">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在载入对比
              </div>
            }
          >
            <DiffViewer
              key={`${candidate.start}:${candidate.end}:${candidate.content}`}
              original={before}
              modified={candidate.content}
              language="plaintext"
              renderSideBySide={false}
              className="h-full"
            />
          </Suspense>
        </div>
      </section>
      <footer>
        <small>
          原 {countCharacters(before)} 字 → 候选{" "}
          {countCharacters(candidate.content)} 字
        </small>
        <div>
          <button
            type="button"
            className="ns-button is-primary"
            onClick={() => void onApply()}
            disabled={isApplying}
          >
            {isApplying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {isApplying ? "正在校验" : "替换"}
          </button>
          <button
            type="button"
            className="ns-button"
            onClick={onDiscard}
            disabled={isApplying}
          >
            取消
          </button>
        </div>
      </footer>
    </section>
  );
}

function SelectionAiLoadingPopover({
  loading,
}: {
  readonly loading: SelectionAiLoading;
}) {
  const label = {
    revise: "快速润色",
    expand: "快速扩写",
    generate: "快速生成",
    continue: "快速续写",
  }[loading.mode];
  const { elementRef, dragHandlers } = useSelectionPopoverLayout(
    loading.anchor,
  );
  return (
    <section
      ref={elementRef}
      className="ms-selection-ai-popover ms-selection-ai-popover--loading"
      role="status"
      aria-live="polite"
      aria-label={`AI ${label}处理中`}
      style={{
        left: loading.anchor.left,
        top: loading.anchor.top + 12,
      }}
    >
      <header {...dragHandlers} title="拖动标题栏移动窗口">
        <span>
          <Sparkles className="h-3.5 w-3.5" /> AI {label}
        </span>
      </header>
      <div className="ms-selection-ai-loading-content">
        <Loader2 className="h-4 w-4 animate-spin" />
        <div>
          <strong>正在处理选中文字</strong>
          <small>正在整理上下文并生成候选内容</small>
        </div>
      </div>
    </section>
  );
}

function ContextManifestDialog({
  open,
  sources,
  excluded,
  onToggle,
  onClose,
}: {
  readonly open: boolean;
  readonly sources: readonly ContextManifestSource[];
  readonly excluded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly onClose: () => void;
}) {
  useCloseLayer(() => {
    if (!open) return false;
    onClose();
    return true;
  }, 221);
  if (!open) return null;
  const enabledCharacters = sources
    .filter((source) => source.required || !excluded.has(source.id))
    .reduce((sum, source) => sum + source.characters, 0);
  return (
    <DraggableDialogFrame
      ariaLabel="本次 AI 上下文检查"
      className="w-[min(660px,calc(100vw-24px))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-14 items-center gap-3 px-4">
          <BookMarked className="h-4 w-4 text-[var(--accent-warm)]" />
          <div className="min-w-0 flex-1">
            <span className="ms-eyebrow">Context manifest</span>
            <h2 className="truncate text-sm font-semibold">
              本次 AI 上下文检查
            </h2>
          </div>
          <button
            type="button"
            className="ns-icon-button border-0"
            onClick={onClose}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="ms-manifest-list">
        {sources.map((source, index) => {
          const isIncluded = source.required || !excluded.has(source.id);
          return (
            <article
              className={`ms-manifest-row ${source.required ? "is-required" : ""}`}
              key={source.id}
            >
              <span className="ms-manifest-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <strong>{source.title}</strong>
                <small>{source.detail}</small>
              </div>
              <span>{source.characters.toLocaleString()} 字符</span>
              {source.required ? (
                <b>强制</b>
              ) : (
                <button type="button" onClick={() => onToggle(source.id)}>
                  {isIncluded ? "排除" : "恢复"}
                </button>
              )}
            </article>
          );
        })}
      </div>
      <footer className="flex items-center gap-3 border-t border-[var(--line)] px-5 py-3 text-xs text-[var(--ink-muted)]">
        <span>
          已启用 {enabledCharacters.toLocaleString()} 字符 ·
          生成时绑定当前正文快照
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="ns-button is-primary"
          onClick={onClose}
        >
          <Check className="h-3.5 w-3.5" /> 完成检查
        </button>
      </footer>
    </DraggableDialogFrame>
  );
}

export function roomProviderOptions(
  binding: WorkbenchModelSelection | undefined,
  providers: readonly WorkbenchAvailableProvider[],
  defaultModel: WorkbenchModelSelection | undefined,
): SelectOption[] {
  const options: SelectOption[] = [
    {
      value: "",
      label: defaultModel
        ? `默认 · ${roomModelSelectionLabel(defaultModel, providers)}`
        : "跟随全局默认模型",
    },
    ...providers.map((provider) => ({
      value: provider.id,
      label: provider.name,
      suffix: provider.vendor,
    })),
  ];
  if (
    binding &&
    !providers.some((provider) => provider.id === binding.providerId)
  ) {
    options.splice(1, 0, {
      value: binding.providerId,
      label: `不可用：${binding.providerId}`,
      suffix: "需重新选择",
    });
  }
  return options;
}

export function roomModelOptions(
  binding: WorkbenchModelSelection | undefined,
  provider: WorkbenchAvailableProvider | undefined,
): SelectOption[] {
  if (!provider) {
    return binding
      ? [{ value: binding.model, label: `不可用：${binding.model}` }]
      : [];
  }
  const options = provider.models.map((model) => ({
    value: model.model,
    label: model.modelName || model.model,
    suffix: model.modelName === model.model ? undefined : model.model,
  }));
  if (
    binding &&
    !provider.models.some((model) => model.model === binding.model)
  ) {
    options.unshift({
      value: binding.model,
      label: `不可用：${binding.model}`,
      suffix: "需重新选择",
    });
  }
  return options;
}

function RoomModelCascadeSelect({
  binding,
  providers,
  defaultModel,
  disabled,
  onChange,
  ariaLabel,
  className,
}: {
  readonly binding: WorkbenchModelSelection | undefined;
  readonly providers: readonly WorkbenchAvailableProvider[];
  readonly defaultModel: WorkbenchModelSelection | undefined;
  readonly disabled: boolean;
  readonly onChange: (selection: WorkbenchModelSelection | undefined) => void;
  readonly ariaLabel: string;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const activeProvider = providers.find(
    (provider) => provider.id === activeProviderId,
  );
  const triggerLabel = binding
    ? roomModelSelectionLabel(binding, providers)
    : defaultModel
      ? `默认 · ${roomModelSelectionLabel(defaultModel, providers)}`
      : "跟随全局默认模型";

  const close = () => {
    setOpen(false);
    setActiveProviderId(null);
  };

  return (
    <div className={`relative ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        title={triggerLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setActiveProviderId(null);
          setOpen((current) => !current);
        }}
        className="ms-room-model-cascade-trigger"
      >
        <span>{triggerLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <Popover
        open={open && !disabled}
        onClose={close}
        anchorRef={triggerRef}
        placement="bottom-start"
        matchAnchorWidth
        className="ms-room-model-cascade-popover shadow-md"
        style={{ minWidth: "280px" }}
        zIndex={300}
      >
        {activeProviderId ? (
          <>
            <div className="ms-room-model-cascade-heading">
              <button
                type="button"
                onClick={() => setActiveProviderId(null)}
                aria-label="返回供应商列表"
                title="返回供应商列表"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <strong>{activeProvider?.name ?? activeProviderId}</strong>
              <span>选择模型</span>
            </div>
            <div className="ms-room-model-cascade-options">
              {roomModelOptions(binding, activeProvider).length ? (
                roomModelOptions(binding, activeProvider).map((option) => {
                  const selected =
                    binding?.providerId === activeProvider?.id &&
                    binding?.model === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={!activeProvider}
                      onClick={() => {
                        if (!activeProvider) return;
                        onChange({
                          providerId: activeProvider.id,
                          model: option.value,
                        });
                        close();
                      }}
                      className={`ms-room-model-cascade-option ${selected ? "is-selected" : ""}`}
                    >
                      <span className="ms-room-model-cascade-option-copy">
                        <strong>{option.label}</strong>
                        {option.suffix && <small>{option.suffix}</small>}
                      </span>
                      {selected && <Check className="h-3.5 w-3.5" />}
                    </button>
                  );
                })
              ) : (
                <p className="ms-room-model-cascade-empty">
                  该供应商暂无可用模型
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="ms-room-model-cascade-heading">
              <strong>选择供应商</strong>
              <span>再选择模型</span>
            </div>
            <div className="ms-room-model-cascade-options">
              {roomProviderOptions(binding, providers, defaultModel).map(
                (option) => {
                  const provider = providers.find(
                    (item) => item.id === option.value,
                  );
                  const selected = binding
                    ? binding.providerId === option.value
                    : option.value === "";
                  const isUnavailable = Boolean(option.value && !provider);
                  return (
                    <button
                      key={option.value || "default"}
                      type="button"
                      disabled={isUnavailable}
                      onClick={() => {
                        if (!option.value) {
                          onChange(undefined);
                          close();
                          return;
                        }
                        if (provider) setActiveProviderId(provider.id);
                      }}
                      className={`ms-room-model-cascade-option ${selected ? "is-selected" : ""}`}
                    >
                      <span className="ms-room-model-cascade-option-copy">
                        <strong>{option.label}</strong>
                        {option.suffix && <small>{option.suffix}</small>}
                      </span>
                      {provider && <ChevronRight className="h-3.5 w-3.5" />}
                      {selected && !provider && (
                        <Check className="h-3.5 w-3.5" />
                      )}
                    </button>
                  );
                },
              )}
            </div>
          </>
        )}
      </Popover>
    </div>
  );
}

function roomModelLabel(
  selection: WorkbenchModelSelection,
  providers: readonly WorkbenchAvailableProvider[],
): string {
  const provider = providers.find((item) => item.id === selection.providerId);
  return (
    provider?.models.find((item) => item.model === selection.model)
      ?.modelName || selection.model
  );
}

export function roomModelSelectionLabel(
  selection: WorkbenchModelSelection,
  providers: readonly WorkbenchAvailableProvider[],
): string {
  const provider = providers.find((item) => item.id === selection.providerId);
  return `${provider?.name ?? selection.providerId} · ${roomModelLabel(selection, providers)}`;
}

function brainstormProgressStateForError(
  cause: unknown,
): BrainstormAgentProgressState {
  return /超时|timeout|timed out|超过\s*\d+\s*秒/iu.test(errorText(cause))
    ? "timeout"
    : "failed";
}

function formatBrainstormElapsed(
  item: BrainstormAgentProgress,
  now: number,
): string {
  if (!item.startedAt) return "";
  const finishedAt = item.completedAt ?? now;
  return `${Math.max(0, Math.floor((finishedAt - item.startedAt) / 1000))} 秒`;
}

function brainstormProgressLabel(state: BrainstormAgentProgressState): string {
  switch (state) {
    case "queued":
      return "排队中";
    case "requesting":
      return "请求中";
    case "received":
      return "已返回";
    case "parsing":
      return "解析中";
    case "success":
      return "完成";
    case "partial":
      return "部分完成";
    case "timeout":
      return "超时";
    case "failed":
      return "失败";
  }
}

function brainstormContributionStatusLabel(
  contribution: BrainstormDesignerContribution,
): string {
  switch (contribution.status) {
    case "available":
      return contribution.diagnostic ? "已返回 · 顺序对齐" : "已返回";
    case "invalid":
      return "格式异常";
    case "missing":
      return "缺少该方案";
    case "timeout":
      return "请求超时";
    case "failed":
      return "请求失败";
  }
}

function yieldBrainstormProgressFrame(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function RoomWorkspace({
  kind,
  presentation = "page",
  storage,
  chapter,
  chapterPlan,
  planningMode,
  manuscriptContent,
  enabled,
  onRun,
  onUseBrief,
  onAdoptSimulation,
  onShowAgentPrompt,
  outputFontScale = 100,
  onBusyChange,
}: RoomWorkspaceProps) {
  const isBrainstorm = kind === "brainstorm";
  const isDialog = presentation === "dialog";
  const outputFontScaleStyle = isBrainstorm
    ? buildBrainstormFontScaleStyle(outputFontScale)
    : undefined;
  const roles = isBrainstorm ? ROOM_ROLES : SIMULATION_ROLES;
  const availableProviders = useWorkbenchAvailableProviders();
  const modelRepository = useMemo(
    () => createNovelModelSceneSettingsRepository(storage),
    [storage],
  );
  const [configs, setConfigs] = useState<readonly RoomAgentConfig[]>(() =>
    Array.from({ length: 6 }, (_, index) => ({
      agent: index + 1,
      enabled: isBrainstorm ? index < 3 : true,
      schemeCount: 2,
      modules: [...(DEFAULT_ROOM_MODULES[index] ?? [])],
    })),
  );
  const [running, setRunning] = useState<ReadonlySet<number>>(new Set());
  const [results, setResults] = useState<readonly RoomAgentResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [simulationStart, setSimulationStart] = useState("chapter-end");
  const [simulationHorizon, setSimulationHorizon] = useState(5);
  const [runTimeoutMinutes, setRunTimeoutMinutes] = useState(
    EXTENDED_AI_DEFAULT_TIMEOUT_MINUTES,
  );
  const [runMaxTurns, setRunMaxTurns] = useState(EXTENDED_AI_DEFAULT_MAX_TURNS);
  const [simulationFilter, setSimulationFilter] = useState<
    "all" | "stable" | "bold"
  >("all");
  const [guardrails, setGuardrails] = useState<ReadonlySet<string>>(
    () => new Set(["主线目标", "卷级验收", "人物状态", "规则边界", "伏笔账本"]),
  );
  const [adopting, setAdopting] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<ReadonlySet<string>>(new Set());
  const [loadedModelSettings, setLoadedModelSettings] =
    useState<LoadedModelSceneSettings | null>(null);
  const [modelSettingsError, setModelSettingsError] = useState<string | null>(
    null,
  );
  const [savingModelSceneId, setSavingModelSceneId] =
    useState<NovelModelSceneId | null>(null);
  const [moduleEditorAgent, setModuleEditorAgent] = useState<number | null>(
    null,
  );
  const [brainstormPlanCount, setBrainstormPlanCount] = useState(3);
  const [brainstormAuthorIntent, setBrainstormAuthorIntent] = useState("");
  const [brainstormPhase, setBrainstormPhase] =
    useState<BrainstormRoundtablePhase>("idle");
  const [brainstormRoundtable, setBrainstormRoundtable] =
    useState<BrainstormRoundtable | null>(null);
  const [brainstormPlans, setBrainstormPlans] = useState<
    readonly BrainstormCompletePlan[]
  >([]);
  const [brainstormAgentProgress, setBrainstormAgentProgress] = useState<
    readonly BrainstormAgentProgress[]
  >([]);
  const [brainstormProgressNow, setBrainstormProgressNow] = useState(
    Date.now(),
  );
  const [selectedBrainstormPlanId, setSelectedBrainstormPlanId] = useState<
    string | null
  >(null);
  const [expandedSchemes, setExpandedSchemes] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const runInFlightRef = useRef(false);
  const activeConfigs = configs.filter((config) => config.enabled);

  useEffect(() => {
    onBusyChange?.(running.size > 0);
  }, [onBusyChange, running]);
  const controllerProgress = isBrainstorm
    ? brainstormAgentProgress.find((item) => item.agent === null)
    : undefined;
  const controllerSceneId =
    "manuscript.brainstorm.synthesis" as NovelModelSceneId;
  const controllerModelBinding =
    isBrainstorm && loadedModelSettings
      ? getModelSceneBinding(loadedModelSettings.settings, controllerSceneId)
      : undefined;
  const controllerEffectiveModel =
    isBrainstorm && loadedModelSettings
      ? getEffectiveModelSceneSelection(
          loadedModelSettings.settings,
          controllerSceneId,
        )
      : undefined;

  const renderBrainstormProgressIcon = (
    state: BrainstormAgentProgressState,
  ) => {
    if (state === "requesting" || state === "parsing") {
      return <Loader2 className="h-3 w-3 animate-spin" />;
    }
    if (state === "success") return <CheckCircle2 className="h-3 w-3" />;
    if (state === "timeout" || state === "failed") {
      return <AlertTriangle className="h-3 w-3" />;
    }
    return <CircleDot className="h-3 w-3" />;
  };

  const runModelProviders = useMemo(
    () => availableProviders.filter((provider) => !provider.runtimeBacked),
    [availableProviders],
  );
  useEffect(() => {
    let cancelled = false;
    void modelRepository
      .load()
      .then((loaded) => {
        if (cancelled) return;
        setLoadedModelSettings(loaded);
        setModelSettingsError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setModelSettingsError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [modelRepository]);

  useEffect(() => {
    if (
      !brainstormAgentProgress.some(
        (item) =>
          item.state === "requesting" ||
          item.state === "received" ||
          item.state === "parsing",
      )
    )
      return;
    setBrainstormProgressNow(Date.now());
    const timer = window.setInterval(
      () => setBrainstormProgressNow(Date.now()),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [brainstormAgentProgress]);

  const saveRoomModel = async (
    sceneId: NovelModelSceneId,
    selection: WorkbenchModelSelection | undefined,
  ): Promise<void> => {
    if (!loadedModelSettings || savingModelSceneId) return;
    const bindings: Record<string, WorkbenchModelSelection> = {
      ...loadedModelSettings.settings.bindings,
    };
    if (selection) bindings[sceneId] = selection;
    else delete bindings[sceneId];
    const settings: ModelSceneSettings = {
      schemaVersion: loadedModelSettings.settings.schemaVersion,
      ...(loadedModelSettings.settings.defaultModel
        ? { defaultModel: loadedModelSettings.settings.defaultModel }
        : {}),
      bindings,
    };
    setSavingModelSceneId(sceneId);
    try {
      const next = await modelRepository.save(loadedModelSettings, settings);
      setLoadedModelSettings(next);
      setModelSettingsError(null);
    } catch (cause) {
      setModelSettingsError(errorText(cause));
    } finally {
      setSavingModelSceneId(null);
    }
  };

  const updateConfig = (
    agent: number,
    patch: Partial<
      Pick<RoomAgentConfig, "enabled" | "schemeCount" | "modules">
    >,
  ) => {
    setConfigs((current) =>
      current.map((config) =>
        config.agent === agent ? { ...config, ...patch } : config,
      ),
    );
  };

  const toggleAgentModule = (agent: number, module: RoomContextModule) => {
    const config = configs.find((item) => item.agent === agent);
    if (!config) return;
    const modules = config.modules.includes(module)
      ? config.modules.filter((item) => item !== module)
      : [...config.modules, module];
    updateConfig(agent, { modules });
  };

  const loadRoomModuleContext = async (): Promise<
    Partial<Record<RoomContextModule, unknown>>
  > => {
    const requested = new Set(
      isBrainstorm
        ? ROOM_CONTEXT_MODULES.map((module) => module.id)
        : activeConfigs.flatMap((config) => config.modules),
    );
    const context: Partial<Record<RoomContextModule, unknown>> = {};
    await Promise.all([
      requested.has("continuity")
        ? createManuscriptTrackingRepository(storage)
            .load()
            .then((loaded) => {
              context.continuity = loaded.ledger.batches
                .filter((batch) => batch.status === "applied")
                .flatMap((batch) => batch.changes)
                .slice(0, 40)
                .map((change) => ({
                  domain: change.domain,
                  entityId: change.entityId,
                  title: change.title,
                  value: change.after,
                }));
            })
        : Promise.resolve(),
      requested.has("characters")
        ? createNovelCharacterLibraryRepository(storage)
            .load()
            .then(async (loaded) => {
              const repository = createNovelCharacterLibraryRepository(storage);
              const characters = await loadCharacterRecords(repository, loaded);
              context.characters = characters.map((character) => ({
                id: character.id,
                name: character.name,
                status: character.status,
                goals: character.goals,
                motivation: character.motivation,
                relations: character.relations,
                inventory: character.inventory,
              }));
            })
        : Promise.resolve(),
      requested.has("timeline")
        ? createNovelTimelineLibraryRepository(storage)
            .load()
            .then((loaded) => {
              context.timeline = [...loaded.library.events]
                .sort(
                  (left, right) =>
                    right.sortKey - left.sortKey ||
                    right.sortOrder - left.sortOrder,
                )
                .slice(0, 30)
                .map((event) => ({
                  id: event.id,
                  timeLabel: event.timeLabel,
                  title: event.title,
                  summary: event.summary,
                  chapterIds: event.chapterIds,
                }));
            })
        : Promise.resolve(),
      requested.has("items")
        ? createNovelItemLibraryRepository(storage)
            .load()
            .then((loaded) => {
              context.items = loaded.index.items.map((item) => ({
                id: item.id,
                name: item.name,
                status: item.status,
                summary: item.summary,
              }));
            })
        : Promise.resolve(),
      requested.has("locations")
        ? createNovelLocationLibraryRepository(storage)
            .load()
            .then((loaded) => {
              context.locations = loaded.index.locations.map((location) => ({
                id: location.id,
                name: location.name,
                status: location.status,
                summary: location.summary,
              }));
            })
        : Promise.resolve(),
      requested.has("factions")
        ? createNovelFactionLibraryRepository(storage)
            .load()
            .then((loaded) => {
              context.factions = loaded.library.factions.map((faction) => ({
                id: faction.id,
                name: faction.name,
                status: faction.status,
                summary: faction.summary,
                state: faction.state,
              }));
            })
        : Promise.resolve(),
      requested.has("world-rules")
        ? storage
            .stat(["world/setting-library/settings.json"])
            .then(async ([settingsFile]) => {
              if (!settingsFile?.exists) {
                // 旧项目兼容：仍以 worldview.md / rules.json 提供世界观上下文
                const [files] = await Promise.all([
                  storage.stat(["world/rules.json", "world/worldview.md"]),
                ]);
                const values = await Promise.all(
                  ["world/rules.json", "world/worldview.md"].map(
                    (path, index) =>
                      files[index]?.exists
                        ? storage
                            .readText(path)
                            .then((file) => file.content.slice(0, 8000))
                        : Promise.resolve(""),
                  ),
                );
                context["world-rules"] = {
                  rules: values[0],
                  worldview: values[1],
                  source: "legacy",
                };
                return;
              }
              // 现行事实源：设定库已落盘页面正文
              const settingsFileContent = await storage.readText(
                "world/setting-library/settings.json",
              );
              const settingsIndex = parseSettingLibrarySettingsIndex(
                settingsFileContent.content,
              );
              const rules: string[] = [];
              const worldview: string[] = [];
              for (const setting of settingsIndex.settings) {
                try {
                  const page = await storage.readText(setting.pagePath);
                  const entry = `## ${setting.name}（${setting.group}）\n${page.content.slice(0, 4000)}`;
                  if (
                    /法则|规则|时空/u.test(`${setting.name}${setting.group}`)
                  ) {
                    rules.push(entry);
                  } else {
                    worldview.push(entry);
                  }
                } catch {
                  // 页面文件缺失时跳过
                }
              }
              const combine = (items: string[]) =>
                items.join("\n\n").slice(0, 20000);
              context["world-rules"] = {
                rules: combine(rules),
                worldview:
                  combine(worldview) ||
                  "（设定库尚未落盘设定页面；请在“世界架构”中编辑设定）",
                source: "setting-library",
              };
            })
        : Promise.resolve(),
    ]);
    return context;
  };

  const run = async () => {
    if (!chapter || runInFlightRef.current || !activeConfigs.length) return;
    runInFlightRef.current = true;
    // 在第一个 await 前同步报告，保证外层导航守卫已经开始拦截。
    onBusyChange?.(true);
    const roomRunBudget = {
      timeoutMinutes: runTimeoutMinutes,
      maxTurns: runMaxTurns,
    };
    const runRoomAi = (request: ManuscriptAiRunRequest) =>
      onRun(
        applyExtendedAiRunBudget(
          request,
          roomRunBudget.timeoutMinutes,
          roomRunBudget.maxTurns,
        ),
      );
    setError(null);
    setResults([]);
    setAdopted(new Set());
    setExpandedSchemes(new Set());
    setBrainstormRoundtable(null);
    setBrainstormPlans([]);
    setBrainstormAgentProgress(
      isBrainstorm
        ? [
            {
              id: "controller",
              agent: null,
              role: "总控 Agent",
              state: "queued",
              task: "生成方案契约",
              detail: "等待设计师会诊",
            },
            ...activeConfigs.map((config) => ({
              id: `designer-${config.agent}`,
              agent: config.agent,
              role: BRAINSTORM_ROLE_PROFILES[config.agent - 1].role,
              state: "queued" as const,
              task: "会诊意见",
              detail: "等待会诊",
            })),
          ]
        : activeConfigs.map((config) => ({
            id: `simulation-agent-${config.agent}`,
            agent: config.agent,
            role: roles[config.agent - 1],
            state: "queued" as const,
            task: "推演方案",
            detail: "等待开始本轮推演",
          })),
    );
    setSelectedBrainstormPlanId(null);
    setRunning(new Set(activeConfigs.map((config) => config.agent)));
    let moduleContext: Partial<Record<RoomContextModule, unknown>>;
    try {
      moduleContext = await loadRoomModuleContext();
    } catch (cause) {
      setRunning(new Set());
      runInFlightRef.current = false;
      onBusyChange?.(false);
      if (!isBrainstorm) {
        setBrainstormAgentProgress((current) =>
          current.map((item) => ({
            ...item,
            state: "failed",
            detail: `上下文读取失败：${errorText(cause)}`,
            completedAt: Date.now(),
          })),
        );
      }
      setError(`上下文模块读取失败：${errorText(cause)}`);
      return;
    }

    if (isBrainstorm) {
      let currentBrainstormPhase: BrainstormRoundtablePhase = "council";
      try {
        setBrainstormPhase("council");
        const controllerContext = buildBrainstormContextDigest(
          moduleContext,
          ROOM_CONTEXT_MODULES.map((module) => module.id),
          { perModuleChars: 900, totalChars: 5_000 },
        );
        const chapterPlanText = chapterPlan
          ? planningMode === "detached"
            ? `章节计划（仅作对照，本章已脱纲）：${chapterPlan.description}`
            : `章节计划：${chapterPlan.description}`
          : "章节计划：未关联";
        const councilNotes = await Promise.all(
          activeConfigs.map(async (config) => {
            const profile = BRAINSTORM_ROLE_PROFILES[config.agent - 1];
            setBrainstormAgentProgress((current) =>
              current.map((item) =>
                item.id === `designer-${config.agent}`
                  ? {
                      ...item,
                      state: "requesting",
                      task: "会诊意见",
                      detail: "正在提交专业判断",
                      startedAt: Date.now(),
                      completedAt: undefined,
                    }
                  : item,
              ),
            );
            try {
              const output = await runRoomAi({
                sceneId:
                  `manuscript.brainstorm.agent${config.agent}` as NovelModelSceneId,
                label: `${chapter.title} · 会诊 · ${profile.role}`,
                systemPrompt: buildBrainstormCouncilSystemPrompt(config.agent),
                prompt: buildBrainstormCouncilPrompt({
                  chapterTitle: chapter.title,
                  chapterPlan: chapterPlanText,
                  manuscriptContent: manuscriptContent.slice(-3000),
                  authorIntent: brainstormAuthorIntent,
                  role: profile.role,
                  focus: profile.focus,
                  context: buildBrainstormContextDigest(
                    moduleContext,
                    DEFAULT_ROOM_MODULES[config.agent - 1] ?? ["continuity"],
                    { perModuleChars: 1_000, totalChars: 2_800 },
                  ),
                }),
              });
              setBrainstormAgentProgress((current) =>
                current.map((item) =>
                  item.id === `designer-${config.agent}`
                    ? { ...item, state: "received", detail: "会诊意见已返回" }
                    : item,
                ),
              );
              await yieldBrainstormProgressFrame();
              setBrainstormAgentProgress((current) =>
                current.map((item) =>
                  item.id === `designer-${config.agent}`
                    ? { ...item, state: "parsing", detail: "正在校验会诊意见" }
                    : item,
                ),
              );
              const note = parseBrainstormCouncilNote(
                output,
                config.agent,
                profile.role,
              );
              setBrainstormAgentProgress((current) =>
                current.map((item) =>
                  item.id === `designer-${config.agent}`
                    ? {
                        ...item,
                        state: "success",
                        detail: "会诊意见已提交",
                        completedAt: Date.now(),
                      }
                    : item,
                ),
              );
              return note;
            } catch (cause) {
              const detail = errorText(cause);
              setBrainstormAgentProgress((current) =>
                current.map((item) =>
                  item.id === `designer-${config.agent}`
                    ? {
                        ...item,
                        state: brainstormProgressStateForError(cause),
                        detail,
                        completedAt: Date.now(),
                      }
                    : item,
                ),
              );
              return {
                agent: config.agent,
                role: profile.role,
                opportunities: [],
                constraints: [],
                recommendation: "",
                questions: [`会诊失败：${detail}`],
              } satisfies BrainstormCouncilNote;
            }
          }),
        );
        const successfulCouncilNotes = councilNotes.filter(
          (note) =>
            note.recommendation ||
            note.opportunities.length ||
            note.constraints.length,
        );
        if (!successfulCouncilNotes.length) {
          const failures = councilNotes
            .flatMap((note) =>
              note.questions.filter((question) =>
                question.startsWith("会诊失败："),
              ),
            )
            .map((question) => question.replace(/^会诊失败：/u, ""));
          setBrainstormAgentProgress((current) =>
            current.map((item) =>
              item.id === "controller"
                ? {
                    ...item,
                    state: "failed",
                    detail: "未执行：设计师会诊没有可用意见",
                    completedAt: Date.now(),
                  }
                : item,
            ),
          );
          throw new Error(
            `会诊阶段没有任何设计师返回可用意见${failures.length ? `：${[...new Set(failures)].join("；")}` : ""}`,
          );
        }
        currentBrainstormPhase = "contracting";
        setBrainstormPhase("contracting");
        setBrainstormAgentProgress((current) =>
          current.map((item) =>
            item.id === "controller"
              ? {
                  ...item,
                  state: "requesting",
                  task: "生成方案契约",
                  detail: `正在汇总 ${successfulCouncilNotes.length} 位设计师意见`,
                  startedAt: Date.now(),
                  completedAt: undefined,
                }
              : item,
          ),
        );
        let councilOutput: string;
        try {
          councilOutput = await runRoomAi({
            sceneId: "manuscript.brainstorm.synthesis",
            label: `${chapter.title} · 总控会诊`,
            systemPrompt:
              "你是脑暴室总控 Agent。主持结构化会诊，先建立共同事实和作者意图，再输出多套方案契约。",
            prompt: buildBrainstormControllerPrompt({
              chapterTitle: chapter.title,
              chapterPlan: chapterPlanText,
              manuscriptContent: manuscriptContent.slice(-4000),
              authorIntent: brainstormAuthorIntent,
              context: controllerContext,
              planCount: brainstormPlanCount,
              councilNotes,
            }),
          });
        } catch (cause) {
          setBrainstormAgentProgress((current) =>
            current.map((item) =>
              item.id === "controller"
                ? {
                    ...item,
                    state: brainstormProgressStateForError(cause),
                    detail: errorText(cause),
                    completedAt: Date.now(),
                  }
                : item,
            ),
          );
          throw cause;
        }
        setBrainstormAgentProgress((current) =>
          current.map((item) =>
            item.id === "controller"
              ? { ...item, state: "received", detail: "方案契约已返回" }
              : item,
          ),
        );
        await yieldBrainstormProgressFrame();
        setBrainstormAgentProgress((current) =>
          current.map((item) =>
            item.id === "controller"
              ? { ...item, state: "parsing", detail: "正在校验方案契约" }
              : item,
          ),
        );
        let roundtable: BrainstormRoundtable;
        try {
          roundtable = parseBrainstormRoundtable(
            councilOutput,
            brainstormPlanCount,
          );
        } catch (cause) {
          setBrainstormAgentProgress((current) =>
            current.map((item) =>
              item.id === "controller"
                ? {
                    ...item,
                    state: "failed",
                    detail: `方案契约解析失败：${errorText(cause)}`,
                    completedAt: Date.now(),
                  }
                : item,
            ),
          );
          throw cause;
        }
        setBrainstormRoundtable(roundtable);
        setBrainstormAgentProgress((current) =>
          current.map((item) =>
            item.id === "controller"
              ? {
                  ...item,
                  state: "success",
                  detail: `已锁定 ${roundtable.contracts.length} 套方案契约`,
                  completedAt: Date.now(),
                }
              : item,
          ),
        );
        currentBrainstormPhase = "designing";
        setBrainstormPhase("designing");
        const contributionBatches = await Promise.all(
          activeConfigs.map(async (config) => {
            const roleProfile = BRAINSTORM_ROLE_PROFILES[config.agent - 1];
            setBrainstormAgentProgress((current) =>
              current.map((item) =>
                item.id === `designer-${config.agent}`
                  ? {
                      ...item,
                      state: "requesting",
                      task: `设计 ${roundtable.contracts.length} 套方案`,
                      detail: "正在生成专业贡献",
                      startedAt: Date.now(),
                      completedAt: undefined,
                    }
                  : item,
              ),
            );
            try {
              const output = await runRoomAi({
                sceneId:
                  `manuscript.brainstorm.agent${config.agent}` as NovelModelSceneId,
                label: `${chapter.title} · 并行设计 · ${roleProfile.role}`,
                systemPrompt: buildBrainstormDesignerSystemPrompt(config.agent),
                prompt: buildBrainstormDesignerBatchPrompt({
                  chapterTitle: chapter.title,
                  chapterPlan: chapterPlanText,
                  contracts: roundtable.contracts,
                  role: roleProfile.role,
                  focus: roleProfile.focus,
                  context: buildBrainstormContextDigest(
                    moduleContext,
                    DEFAULT_ROOM_MODULES[config.agent - 1] ?? ["continuity"],
                    { perModuleChars: 900, totalChars: 2_500 },
                  ),
                  roundtable,
                }),
              });
              setBrainstormAgentProgress((current) =>
                current.map((item) =>
                  item.id === `designer-${config.agent}`
                    ? { ...item, state: "received", detail: "专业贡献已返回" }
                    : item,
                ),
              );
              await yieldBrainstormProgressFrame();
              setBrainstormAgentProgress((current) =>
                current.map((item) =>
                  item.id === `designer-${config.agent}`
                    ? { ...item, state: "parsing", detail: "正在对齐方案 ID" }
                    : item,
                ),
              );
              const contributions = parseBrainstormContributionBatch(
                output,
                config.agent,
                roleProfile.role,
                roundtable.contracts,
              );
              const availableCount = contributions.filter(
                (entry) => entry.status === "available",
              ).length;
              setBrainstormAgentProgress((current) =>
                current.map((item) =>
                  item.id === `designer-${config.agent}`
                    ? {
                        ...item,
                        state:
                          availableCount === roundtable.contracts.length
                            ? "success"
                            : "partial",
                        detail: `已对齐 ${availableCount}/${roundtable.contracts.length} 套方案`,
                        completedAt: Date.now(),
                      }
                    : item,
                ),
              );
              return contributions;
            } catch (cause) {
              const detail = errorText(cause);
              setBrainstormAgentProgress((current) =>
                current.map((item) =>
                  item.id === `designer-${config.agent}`
                    ? {
                        ...item,
                        state: brainstormProgressStateForError(cause),
                        detail,
                        completedAt: Date.now(),
                      }
                    : item,
                ),
              );
              return roundtable.contracts.map(
                (contract) =>
                  ({
                    agent: config.agent,
                    role: roleProfile.role,
                    planId: contract.id,
                    status: /超时|timeout/iu.test(detail)
                      ? "timeout"
                      : "failed",
                    diagnostic: detail,
                    contribution: "",
                    evidence: [],
                    assumptions: [],
                    conflicts: [detail],
                  }) satisfies BrainstormDesignerContribution,
              );
            }
          }),
        );
        const contributionEntries = contributionBatches.flat();
        currentBrainstormPhase = "synthesizing";
        setBrainstormPhase("synthesizing");
        setBrainstormAgentProgress((current) =>
          current.map((item) =>
            item.id === "controller"
              ? {
                  ...item,
                  state: "requesting",
                  task: "整合与因果审计",
                  detail: `正在整合 ${roundtable.contracts.length} 套方案`,
                  startedAt: Date.now(),
                  completedAt: undefined,
                }
              : item,
          ),
        );
        let completePlans: readonly BrainstormCompletePlan[];
        try {
          const output = await runRoomAi({
            sceneId: "manuscript.brainstorm.synthesis",
            label: `${chapter.title} · 总控整合与审计`,
            systemPrompt:
              "你是脑暴室总控 Agent，负责分别整合同一批方案契约下的多角色贡献并进行因果审计。",
            prompt: buildBrainstormSynthesisBatchPrompt({
              chapterTitle: chapter.title,
              chapterPlan: chapterPlanText,
              contracts: roundtable.contracts,
              contributions: contributionEntries,
            }),
          });
          setBrainstormAgentProgress((current) =>
            current.map((item) =>
              item.id === "controller"
                ? { ...item, state: "received", detail: "完整方案已返回" }
                : item,
            ),
          );
          await yieldBrainstormProgressFrame();
          setBrainstormAgentProgress((current) =>
            current.map((item) =>
              item.id === "controller"
                ? { ...item, state: "parsing", detail: "正在校验整合结果" }
                : item,
            ),
          );
          completePlans = parseBrainstormCompletePlanBatch(
            output,
            roundtable.contracts,
            contributionEntries,
          );
          setBrainstormAgentProgress((current) =>
            current.map((item) =>
              item.id === "controller"
                ? {
                    ...item,
                    state: "success",
                    detail: `已完成 ${completePlans.length} 套方案审计`,
                    completedAt: Date.now(),
                  }
                : item,
            ),
          );
        } catch (cause) {
          const detail = errorText(cause);
          setBrainstormAgentProgress((current) =>
            current.map((item) =>
              item.id === "controller"
                ? {
                    ...item,
                    state: brainstormProgressStateForError(cause),
                    detail,
                    completedAt: Date.now(),
                  }
                : item,
            ),
          );
          completePlans = roundtable.contracts.map((contract) => {
            const contributions = contributionEntries.filter(
              (item) => item.planId === contract.id,
            );
            return {
              id: contract.id,
              title: contract.title,
              premise: contract.coreChoice,
              content: contributions
                .map((item) => item.contribution)
                .filter(Boolean)
                .join("\n\n"),
              opening: contract.hook,
              beats: contract.requiredBeats,
              evidence: contributions.flatMap((item) => item.evidence),
              assumptions: contributions.flatMap((item) => item.assumptions),
              conflicts: [...contract.openQuestions, detail],
              contributions,
              audit: {
                score: 0,
                summary: "总控整合失败，需要重试或人工审阅。",
                risks: [detail],
              },
            } satisfies BrainstormCompletePlan;
          });
        }
        setBrainstormPhase("auditing");
        setBrainstormPlans(completePlans);
        setSelectedBrainstormPlanId(completePlans[0]?.id ?? null);
        setBrainstormPhase("ready");
        setResults([]);
        return;
      } catch (cause) {
        setBrainstormPhase("failed");
        setError(
          currentBrainstormPhase === "council"
            ? `脑暴会诊失败：${errorText(cause)}`
            : currentBrainstormPhase === "contracting"
              ? `总控方案契约失败：${errorText(cause)}`
              : currentBrainstormPhase === "designing"
                ? `设计师并行设计失败：${errorText(cause)}`
                : currentBrainstormPhase === "synthesizing"
                  ? `总控整合审计失败：${errorText(cause)}`
                  : `脑暴流程失败：${errorText(cause)}`,
        );
        return;
      } finally {
        setRunning(new Set());
        runInFlightRef.current = false;
        onBusyChange?.(false);
      }
    }

    const tasks = activeConfigs.map(async (config) => {
      const agent = config.agent;
      const role = roles[agent - 1];
      const sceneId = `manuscript.${kind}.agent${agent}` as NovelModelSceneId;
      const progressId = `simulation-agent-${agent}`;
      const updateSimulationProgress = (
        patch: Partial<BrainstormAgentProgress>,
      ) => {
        if (isBrainstorm) return;
        setBrainstormAgentProgress((current) =>
          current.map((item) =>
            item.id === progressId ? { ...item, ...patch } : item,
          ),
        );
      };
      updateSimulationProgress({
        state: "requesting",
        task: "请求模型",
        detail: "正在读取冻结的正文与项目事实",
        startedAt: Date.now(),
        completedAt: undefined,
      });
      try {
        const output = await runRoomAi({
          sceneId,
          label: `${isBrainstorm ? "正文脑暴" : "剧情推演"} · Agent ${agent}`,
          systemPrompt: isBrainstorm
            ? buildBrainstormSystemPrompt(agent)
            : planningMode === "detached"
              ? `你是${role}。以现有正文事实和作者当前创作方向推演后续因果；章节计划仅作对照，可以提出偏离计划的可行路径。只输出 JSON 数组，每项包含 title、premise、outline、riskLevel(low|medium|high)、coherence(0-100)、novelty(0-100)、riskScore(0-100)、tags、nodes；nodes 每项包含 offset(距起点章数)、title、summary、checkpoint。`
              : `你是${role}。依据现有正文和章节计划推演后续因果，不强行制造反转。只输出 JSON 数组，每项包含 title、premise、outline、riskLevel(low|medium|high)、coherence(0-100)、novelty(0-100)、riskScore(0-100)、tags、nodes；nodes 每项包含 offset(距起点章数)、title、summary、checkpoint。`,
          prompt: [
            `作品章节：${chapter.title}`,
            chapterPlan
              ? planningMode === "detached"
                ? `章节计划（仅作对照，本章已脱纲）：${chapterPlan.description}`
                : `章节计划：${chapterPlan.description}`
              : "章节计划：未关联",
            `当前正文：\n${manuscriptContent || "（空）"}`,
            config.modules.length
              ? `本 Agent 启用的上下文模块：\n${JSON.stringify(
                  Object.fromEntries(
                    config.modules.map((module) => [
                      module,
                      moduleContext[module],
                    ]),
                  ),
                  null,
                  2,
                )}`
              : "本 Agent 未启用额外上下文模块。",
            !isBrainstorm
              ? `推演起点：${simulationStart}；向后 ${simulationHorizon} 章；必须遵守：${[...guardrails].join("、") || "无额外约束"}`
              : "",
            `请给出 ${config.schemeCount} 个不同方案。`,
          ].join("\n\n"),
        });
        updateSimulationProgress({
          state: "received",
          task: "已返回候选",
          detail: "模型输出已返回，正在解析路径",
        });
        await yieldBrainstormProgressFrame();
        updateSimulationProgress({
          state: "parsing",
          task: "解析路径",
          detail: "正在校验方案结构与章节节点",
        });
        const schemes = parseRoomSchemes(
          output,
          config.schemeCount,
          kind,
          agent,
        );
        updateSimulationProgress({
          state: "success",
          task: `完成 ${schemes.length} 条路径`,
          detail: "候选路径已准备好审阅",
          completedAt: Date.now(),
        });
        return {
          agent,
          role,
          schemes,
        } satisfies RoomAgentResult;
      } catch (cause) {
        updateSimulationProgress({
          state: brainstormProgressStateForError(cause),
          task: "请求失败",
          detail: errorText(cause),
          completedAt: Date.now(),
        });
        return {
          agent,
          role,
          schemes: [],
          error: errorText(cause),
        } satisfies RoomAgentResult;
      } finally {
        setRunning((current) => {
          const next = new Set(current);
          next.delete(agent);
          return next;
        });
      }
    });
    try {
      const next = await Promise.all(tasks);
      setResults(next);
      if (next.every((item) => item.error))
        setError("所有 Agent 都未返回可用方案");
    } finally {
      runInFlightRef.current = false;
      onBusyChange?.(false);
    }
  };

  const adoptSimulation = async (
    key: string,
    scheme: RoomScheme,
    agentRole: string,
  ): Promise<void> => {
    if (adopting) return;
    setAdopting(key);
    setError(null);
    try {
      await onAdoptSimulation({
        title: scheme.title,
        description: scheme.content,
        premise: scheme.premise,
        sourceChapterPlanId: chapterPlan?.id ?? null,
        sourceManuscriptChapterId: chapter?.id ?? null,
        agentRole,
        coherence: scheme.coherence,
        novelty: scheme.novelty,
        risk: scheme.risk,
        riskLevel: scheme.riskLevel,
        tags: scheme.tags,
        nodes: scheme.nodes,
      });
      setAdopted((current) => new Set([...current, key]));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setAdopting(null);
    }
  };

  const simulationSchemes = results.flatMap((result) =>
    result.schemes.map((scheme, index) => ({
      agent: result.agent,
      role: result.role,
      scheme,
      key: `${result.agent}-${index}`,
      kind:
        scheme.riskLevel === "high" || scheme.risk >= 70
          ? ("bold" as const)
          : ("stable" as const),
    })),
  );
  const selectedBrainstormPlan = brainstormPlans.find(
    (plan) => plan.id === selectedBrainstormPlanId,
  );
  const buildCompletePlanBrief = (plan: BrainstormCompletePlan): string =>
    [
      `本章完整创作方案：${plan.title}`,
      `核心前提：${plan.premise}`,
      plan.content,
      plan.beats.length
        ? `关键节拍：\n${plan.beats.map((beat, index) => `${index + 1}. ${beat}`).join("\n")}`
        : "",
      plan.opening ? `开场与钩子：\n${plan.opening}` : "",
      plan.evidence.length
        ? `事实依据：\n${plan.evidence.map((item) => `- ${item}`).join("\n")}`
        : "",
      plan.assumptions.length
        ? `创作假设：\n${plan.assumptions.map((item) => `- ${item}`).join("\n")}`
        : "",
      plan.conflicts.length
        ? `待确认风险：\n${plan.conflicts.map((item) => `- ${item}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  const visibleSimulationSchemes = simulationSchemes.filter(
    (item) => simulationFilter === "all" || item.kind === simulationFilter,
  );
  const requestedSchemeCount = isBrainstorm
    ? brainstormPlanCount
    : activeConfigs.reduce((sum, item) => sum + item.schemeCount, 0);
  const simulationStartChapter =
    (chapter?.displayNumber ?? 0) + (simulationStart === "chapter-end" ? 0 : 1);
  const chapterCheckpointLabel = chapter
    ? chapter.title.trim() &&
      chapter.title.trim() !== `第 ${chapter.displayNumber} 章`
      ? `第 ${chapter.displayNumber} 章 · ${chapter.title.trim()}`
      : `第 ${chapter.displayNumber} 章`
    : "未绑定章节";
  const simulationStartLabel = chapter
    ? simulationStart === "chapter-end"
      ? chapterCheckpointLabel
      : simulationStart === "next-plan"
        ? `第 ${chapter.displayNumber + 1} 章计划`
        : `当前单元末 · 第 ${chapter.displayNumber + 1} 章起`
    : "未绑定章节";
  const runDisabled =
    !enabled || !chapter || running.size > 0 || activeConfigs.length === 0;
  const renderRoomControls = (className: string) => (
    <div className={className}>
      <button
        type="button"
        className="ns-button is-primary"
        onClick={() => void run()}
        disabled={runDisabled}
      >
        {running.size ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isBrainstorm ? (
          <BrainCircuit className="h-3.5 w-3.5" />
        ) : (
          <GitBranch className="h-3.5 w-3.5" />
        )}
        {running.size
          ? `等待 ${running.size} 路`
          : isBrainstorm
            ? brainstormPlans.length
              ? "重新会诊"
              : `开始会诊 · ${requestedSchemeCount} 套完整方案`
            : `开始推演 · ${requestedSchemeCount} 条路径`}
      </button>
    </div>
  );

  return (
    <div className={`ms-room ${isDialog ? "is-dialog" : ""}`}>
      {!isDialog && (
        <header className="ms-room-header">
          <div>
            <span className="ms-eyebrow">
              {isBrainstorm ? "Divergent writing" : "Causal simulation"}
            </span>
            <h2>{isBrainstorm ? "AI 脑暴室" : "AI 剧情推演室"}</h2>
            <p>
              {isBrainstorm
                ? "从不同创作立场同时寻找正文写法。"
                : "让不同立场独立推演行动、规则碰撞和剧情分支。"}
            </p>
          </div>
          {renderRoomControls("ms-room-controls")}
        </header>
      )}
      {(error || modelSettingsError) && (
        <div className="ms-inline-error">{error ?? modelSettingsError}</div>
      )}
      <div className="ms-room-layout">
        <aside className="ms-agent-config">
          <section
            className="ms-room-run-budget"
            title={`应用于本次${isBrainstorm ? "脑暴" : "推演"}中的每个 AI 请求`}
          >
            <header>
              <strong>运行预算</strong>
              <span>每次请求</span>
            </header>
            <div>
              <label>
                <span>超时</span>
                <CustomSelect
                  value={String(runTimeoutMinutes)}
                  options={EXTENDED_AI_TIMEOUT_OPTIONS}
                  onChange={(value) => setRunTimeoutMinutes(Number(value))}
                  ariaLabel={`${isBrainstorm ? "脑暴" : "剧情推演"}单次请求超时`}
                  triggerIcon={<Timer className="h-3.5 w-3.5" />}
                  className="ms-room-run-budget-select"
                  popoverMinWidth={112}
                  compact
                  disabled={running.size > 0}
                />
              </label>
              <label>
                <span>轮次</span>
                <CustomSelect
                  value={String(runMaxTurns)}
                  options={EXTENDED_AI_MAX_TURNS_OPTIONS}
                  onChange={(value) => setRunMaxTurns(Number(value))}
                  ariaLabel={`${isBrainstorm ? "脑暴" : "剧情推演"}最大轮次`}
                  triggerIcon={<RefreshCw className="h-3.5 w-3.5" />}
                  className="ms-room-run-budget-select"
                  popoverMinWidth={112}
                  compact
                  disabled={running.size > 0}
                />
              </label>
            </div>
          </section>
          {!isBrainstorm && (
            <section className="ms-simulation-boundary">
              <div>
                <strong>推演边界</strong>
                <span>
                  {isDialog
                    ? `启用 ${activeConfigs.length} / 6`
                    : "同一检查点独立演算"}
                </span>
              </div>
              <label>
                <span>从哪里开始</span>
                <CustomSelect
                  value={simulationStart}
                  options={[
                    { value: "chapter-end", label: "当前章结尾" },
                    { value: "next-plan", label: "下一章计划" },
                    { value: "unit-end", label: "当前单元末" },
                  ]}
                  onChange={setSimulationStart}
                  ariaLabel="推演起点"
                  compact
                />
              </label>
              <label>
                <span>向后推演</span>
                <CustomSelect
                  value={String(simulationHorizon)}
                  options={SIMULATION_HORIZON_OPTIONS.map((count) => ({
                    value: String(count),
                    label: `未来 ${count} 章`,
                  }))}
                  onChange={(value) => setSimulationHorizon(Number(value))}
                  ariaLabel="推演章数"
                  compact
                />
              </label>
              <div className="ms-guardrails">
                {[
                  "主线目标",
                  "卷级验收",
                  "人物状态",
                  "规则边界",
                  "伏笔账本",
                ].map((item) => (
                  <label key={item}>
                    <input
                      type="checkbox"
                      checked={guardrails.has(item)}
                      onChange={(event) =>
                        setGuardrails((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(item);
                          else next.delete(item);
                          return next;
                        })
                      }
                    />
                    <span>{item}</span>
                  </label>
                ))}
              </div>
            </section>
          )}
          <div className="ms-agent-config-heading">
            <strong>
              {isBrainstorm
                ? isDialog
                  ? "Agent 阵容"
                  : "Agent 配置"
                : "推演 Agent"}
            </strong>
            <span>
              {isBrainstorm
                ? `启用 ${activeConfigs.length} / 6`
                : "每个产出 1～5 条路径"}
            </span>
          </div>
          <div className="ms-agent-config-list">
            {isBrainstorm && (
              <div className="ms-agent-config-row is-brainstorm is-controller">
                <input
                  type="checkbox"
                  checked
                  disabled
                  aria-label="总控 Agent 始终启用"
                  title="总控 Agent 始终启用"
                />
                <div className="ms-agent-identity">
                  <div className="ms-agent-identity-heading">
                    <strong>总控</strong>
                    <div className="ms-agent-identity-actions">
                      {onShowAgentPrompt && (
                        <button
                          type="button"
                          className="ms-agent-prompt-button"
                          onClick={() => onShowAgentPrompt(0)}
                          aria-label="查看总控完整提示词"
                          title="查看总控使用的完整提示词"
                        >
                          <FileText className="h-3 w-3" />
                          <span>提示词</span>
                        </button>
                      )}
                    </div>
                  </div>
                  {controllerEffectiveModel && (
                    <small>
                      {roomModelSelectionLabel(
                        controllerEffectiveModel,
                        runModelProviders,
                      )}
                    </small>
                  )}
                </div>
                <RoomModelCascadeSelect
                  binding={controllerModelBinding}
                  providers={runModelProviders}
                  defaultModel={loadedModelSettings?.settings.defaultModel}
                  disabled={!loadedModelSettings || savingModelSceneId !== null}
                  onChange={(selection) =>
                    void saveRoomModel(controllerSceneId, selection)
                  }
                  ariaLabel="总控供应商和模型"
                  className="ms-agent-model-cascade-select"
                />
                <div className="ms-agent-runtime-info">
                  <div className="ms-agent-runtime-copy">
                    <span>{controllerProgress?.task ?? "等待开始"}</span>
                    <div className="ms-agent-runtime-timing">
                      <span
                        className={`ms-agent-runtime-state is-${controllerProgress?.state ?? "queued"}`}
                        aria-label={brainstormProgressLabel(
                          controllerProgress?.state ?? "queued",
                        )}
                        title={brainstormProgressLabel(
                          controllerProgress?.state ?? "queued",
                        )}
                      >
                        {renderBrainstormProgressIcon(
                          controllerProgress?.state ?? "queued",
                        )}
                      </span>
                      <time>
                        {controllerProgress
                          ? formatBrainstormElapsed(
                              controllerProgress,
                              brainstormProgressNow,
                            ) || "未开始"
                          : "未开始"}
                      </time>
                    </div>
                  </div>
                  <p
                    className="ms-agent-runtime-detail"
                    title={
                      controllerProgress?.detail ??
                      "总控将在设计师会诊后生成方案契约并完成整合审计。"
                    }
                  >
                    {controllerProgress?.detail ??
                      "总控将在设计师会诊后生成方案契约并完成整合审计。"}
                  </p>
                </div>
              </div>
            )}
            {configs.map((config) => {
              const sceneId =
                `manuscript.${kind}.agent${config.agent}` as NovelModelSceneId;
              const modelBinding = loadedModelSettings
                ? getModelSceneBinding(loadedModelSettings.settings, sceneId)
                : undefined;
              const effectiveModel = loadedModelSettings
                ? getEffectiveModelSceneSelection(
                    loadedModelSettings.settings,
                    sceneId,
                  )
                : undefined;
              const agentProgress = brainstormAgentProgress.find(
                (item) => item.agent === config.agent,
              );
              const progressState = agentProgress?.state ?? "queued";
              return (
                <div
                  className={`ms-agent-config-row ${isBrainstorm ? "is-brainstorm" : ""} ${config.enabled ? "" : "is-disabled"}`}
                  key={config.agent}
                >
                  <input
                    type="checkbox"
                    checked={config.enabled}
                    onChange={(event) =>
                      updateConfig(config.agent, {
                        enabled: event.target.checked,
                      })
                    }
                    aria-label={`启用 Agent ${config.agent}`}
                  />
                  {!isBrainstorm && (
                    <span className="ms-agent-index">
                      {String(config.agent).padStart(2, "0")}
                    </span>
                  )}
                  <div className="ms-agent-identity">
                    <div className="ms-agent-identity-heading">
                      <strong>{roles[config.agent - 1]}</strong>
                      {isBrainstorm && (
                        <div className="ms-agent-identity-actions">
                          {onShowAgentPrompt && (
                            <button
                              type="button"
                              className="ms-agent-prompt-button"
                              onClick={() => onShowAgentPrompt(config.agent)}
                              aria-label={`查看 Agent ${config.agent} 完整提示词`}
                              title="查看该 Agent 使用的完整提示词"
                            >
                              <FileText className="h-3 w-3" />
                              <span>提示词</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {effectiveModel && (
                      <small>
                        {roomModelSelectionLabel(
                          effectiveModel,
                          runModelProviders,
                        )}
                      </small>
                    )}
                  </div>
                  <RoomModelCascadeSelect
                    binding={modelBinding}
                    providers={runModelProviders}
                    defaultModel={loadedModelSettings?.settings.defaultModel}
                    disabled={
                      !config.enabled ||
                      !loadedModelSettings ||
                      savingModelSceneId !== null
                    }
                    onChange={(selection) =>
                      void saveRoomModel(sceneId, selection)
                    }
                    ariaLabel={`Agent ${config.agent} 供应商和模型`}
                    className="ms-agent-model-cascade-select"
                  />
                  {config.enabled && (
                    <div className="ms-agent-runtime-info">
                      <div className="ms-agent-runtime-copy">
                        <span>{agentProgress?.task ?? "等待开始"}</span>
                        <div className="ms-agent-runtime-timing">
                          <span
                            className={`ms-agent-runtime-state is-${progressState}`}
                            aria-label={brainstormProgressLabel(progressState)}
                            title={brainstormProgressLabel(progressState)}
                          >
                            {renderBrainstormProgressIcon(progressState)}
                          </span>
                          <time>
                            {agentProgress
                              ? formatBrainstormElapsed(
                                  agentProgress,
                                  brainstormProgressNow,
                                ) || "未开始"
                              : "未开始"}
                          </time>
                        </div>
                      </div>
                      <p
                        className="ms-agent-runtime-detail"
                        title={
                          agentProgress?.detail ??
                          (isBrainstorm
                            ? "等待开始本轮会诊。"
                            : "等待开始本轮推演。")
                        }
                      >
                        {agentProgress?.detail ??
                          (isBrainstorm
                            ? "等待开始本轮会诊。"
                            : "等待开始本轮推演。")}
                      </p>
                    </div>
                  )}
                  {!isBrainstorm && (
                    <CustomSelect
                      value={String(config.schemeCount)}
                      options={[1, 2, 3, 4, 5].map((count) => ({
                        value: String(count),
                        label: `${count} 个方案`,
                      }))}
                      onChange={(value) =>
                        updateConfig(config.agent, {
                          schemeCount: Number(value),
                        })
                      }
                      disabled={!config.enabled}
                      ariaLabel={`Agent ${config.agent} 方案数`}
                      className="ms-agent-scheme-select"
                      compact
                    />
                  )}
                  {!isBrainstorm && (
                    <button
                      type="button"
                      className="ms-agent-module-button"
                      disabled={!config.enabled}
                      onClick={() =>
                        setModuleEditorAgent((current) =>
                          current === config.agent ? null : config.agent,
                        )
                      }
                      aria-expanded={moduleEditorAgent === config.agent}
                      title="配置该 Agent 使用的上下文模块"
                    >
                      {moduleEditorAgent === config.agent
                        ? "收起模块"
                        : `${config.modules.length} 个模块`}
                      {moduleEditorAgent === config.agent ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </button>
                  )}
                  {!isBrainstorm && moduleEditorAgent === config.agent && (
                    <div className="ms-agent-module-panel">
                      {ROOM_CONTEXT_MODULES.map((module) => (
                        <label key={module.id}>
                          <input
                            type="checkbox"
                            checked={config.modules.includes(module.id)}
                            disabled={!config.enabled}
                            onChange={() =>
                              toggleAgentModule(config.agent, module.id)
                            }
                          />
                          <span>{module.label}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {isBrainstorm && (
            <section className="ms-brainstorm-intent">
              <label htmlFor="ms-brainstorm-author-intent">作者本轮意图</label>
              <textarea
                id="ms-brainstorm-author-intent"
                value={brainstormAuthorIntent}
                onChange={(event) =>
                  setBrainstormAuthorIntent(event.target.value)
                }
                placeholder="例如：希望主角主动做选择，结尾留下不可逆的关系代价。"
                aria-label="作者本轮意图"
              />
              {isDialog && (
                <label className="ms-brainstorm-count-control">
                  <span>完整方案数</span>
                  <CustomSelect
                    value={String(brainstormPlanCount)}
                    options={[2, 3, 4].map((count) => ({
                      value: String(count),
                      label: `${count} 套`,
                    }))}
                    onChange={(value) => setBrainstormPlanCount(Number(value))}
                    disabled={
                      brainstormPhase !== "idle" && brainstormPhase !== "ready"
                    }
                    ariaLabel="完整方案数"
                    compact
                  />
                </label>
              )}
            </section>
          )}
          {isDialog && (
            <footer className="ms-room-dialog-actions">
              {renderRoomControls("ms-room-dialog-controls")}
              <small>
                模型和上下文锁定在本次
                {isBrainstorm ? "脑暴" : "推演"}快照中。
              </small>
            </footer>
          )}
        </aside>

        <main className="ms-room-results">
          {isBrainstorm && brainstormRoundtable && (
            <section
              className="ms-brainstorm-roundtable"
              aria-label="总控会诊摘要"
            >
              <header>
                <div>
                  <strong>总控会诊摘要</strong>
                  <span>
                    {brainstormRoundtable.summary || "已建立本轮共同创作前提"}
                  </span>
                </div>
                <span className={`ms-roundtable-phase is-${brainstormPhase}`}>
                  {brainstormPhase === "ready"
                    ? "已完成"
                    : brainstormPhase === "failed"
                      ? "失败"
                      : brainstormPhase === "council"
                        ? "设计师会诊"
                        : brainstormPhase === "contracting"
                          ? "总控定契约"
                          : brainstormPhase === "designing"
                            ? "并行设计"
                            : brainstormPhase === "synthesizing" ||
                                brainstormPhase === "auditing"
                              ? "总控整合"
                              : "处理中"}
                </span>
              </header>
              <div className="ms-roundtable-columns">
                <div>
                  <small>共同事实</small>
                  {brainstormRoundtable.sharedFacts.slice(0, 5).map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </div>
                <div>
                  <small>团队共识</small>
                  {brainstormRoundtable.agreements.slice(0, 5).map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </div>
                <div>
                  <small>待解决分歧</small>
                  {brainstormRoundtable.disagreements
                    .slice(0, 5)
                    .map((item) => (
                      <p key={item}>{item}</p>
                    ))}
                </div>
              </div>
            </section>
          )}
          {!isBrainstorm && (
            <>
              <div className="ms-simulation-toolbar">
                <div>
                  <strong>候选剧情路径</strong>
                  <span>
                    {simulationSchemes.length
                      ? `${simulationSchemes.length} 条路径`
                      : `等待 ${activeConfigs.length} 路 Agent`}{" "}
                    · 覆盖未来 {simulationHorizon} 章
                  </span>
                </div>
                <div className="ms-segmented">
                  {(
                    [
                      ["all", "全部"],
                      ["stable", "稳健"],
                      ["bold", "高变"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      className={simulationFilter === value ? "is-active" : ""}
                      onClick={() => setSimulationFilter(value)}
                      key={value}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ms-simulation-origin">
                <span>
                  <small>推演起点</small>
                  <strong>{simulationStartLabel}</strong>
                </span>
                <i>
                  <GitBranch className="h-3.5 w-3.5" />
                </i>
                <span>
                  <small>推演边界</small>
                  <strong>
                    第 {simulationStartChapter + simulationHorizon} 章
                  </strong>
                </span>
                <b>当前正文快照已冻结</b>
              </div>
            </>
          )}
          {!results.length &&
          !running.size &&
          (!isBrainstorm || !brainstormPlans.length) ? (
            <div className="ms-room-empty">
              {isBrainstorm ? (
                <BrainCircuit className="h-8 w-8" />
              ) : (
                <GitBranch className="h-8 w-8" />
              )}
              <p>
                {isBrainstorm
                  ? "总控会先主持会诊，再生成彼此可比较的完整方案。"
                  : "每个 Agent 可单独启用并配置 1～5 个方案，模型在独立场景中设置。"}
              </p>
            </div>
          ) : isBrainstorm ? (
            <div className="ms-complete-plan-layout">
              <nav className="ms-complete-plan-list" aria-label="完整方案列表">
                {brainstormPlans.map((plan, index) => (
                  <button
                    type="button"
                    key={plan.id}
                    className={
                      selectedBrainstormPlanId === plan.id ? "is-active" : ""
                    }
                    onClick={() => setSelectedBrainstormPlanId(plan.id)}
                  >
                    <span>方案 {String(index + 1).padStart(2, "0")}</span>
                    <strong>{plan.title}</strong>
                    <small>
                      {plan.audit.score ? `${plan.audit.score} 分 · ` : ""}
                      {
                        plan.contributions.filter(
                          (item) => item.status === "available",
                        ).length
                      }
                      /{plan.contributions.length} 位贡献可用
                    </small>
                  </button>
                ))}
              </nav>
              {selectedBrainstormPlan && (
                <article
                  className="ms-complete-plan"
                  style={outputFontScaleStyle}
                >
                  <header>
                    <div>
                      <span className="ms-eyebrow">完整创作方案</span>
                      <h3>{selectedBrainstormPlan.title}</h3>
                      <p>{selectedBrainstormPlan.premise}</p>
                    </div>
                    <div className="ms-complete-plan-actions">
                      <span className="ms-plan-score">
                        {selectedBrainstormPlan.audit.score || "-"}
                        <small>审计分</small>
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          onUseBrief(
                            buildCompletePlanBrief(selectedBrainstormPlan),
                          )
                        }
                      >
                        <WandSparkles className="h-3.5 w-3.5" />
                        采用此完整方案并进入正文
                      </button>
                    </div>
                  </header>
                  <section className="ms-plan-content">
                    <div className="ms-plan-narrative">
                      {formatBrainstormPlanContent(
                        selectedBrainstormPlan.content,
                      ).map((block, index) =>
                        block.kind === "heading" ? (
                          <h4 key={`${index}-${block.text}`}>{block.text}</h4>
                        ) : block.kind === "step" ? (
                          <p
                            className="ms-plan-narrative-step"
                            key={`${index}-${block.marker}-${block.text}`}
                          >
                            <b>{block.marker}</b>
                            <span>{block.text}</span>
                          </p>
                        ) : (
                          <p
                            className="ms-plan-narrative-paragraph"
                            key={`${index}-${block.text}`}
                          >
                            {block.text}
                          </p>
                        ),
                      )}
                    </div>
                    {selectedBrainstormPlan.beats.length > 0 && (
                      <div className="ms-plan-beats">
                        <strong>关键节拍</strong>
                        {selectedBrainstormPlan.beats.map((beat, index) => (
                          <p key={`${index}-${beat}`}>
                            <b>{index + 1}</b>
                            {beat}
                          </p>
                        ))}
                      </div>
                    )}
                  </section>
                  <div className="ms-plan-evidence-grid">
                    <section>
                      <strong>事实依据</strong>
                      {selectedBrainstormPlan.evidence.map((item) => (
                        <p key={item}>{item}</p>
                      ))}
                    </section>
                    <section>
                      <strong>创作假设</strong>
                      {selectedBrainstormPlan.assumptions.map((item) => (
                        <p key={item}>{item}</p>
                      ))}
                    </section>
                    <section>
                      <strong>审计风险</strong>
                      {(selectedBrainstormPlan.conflicts.length
                        ? selectedBrainstormPlan.conflicts
                        : selectedBrainstormPlan.audit.risks
                      ).map((item) => (
                        <p key={item}>{item}</p>
                      ))}
                    </section>
                  </div>
                  <details className="ms-plan-contributions" open>
                    <summary>
                      查看设计师贡献 ·{" "}
                      {
                        selectedBrainstormPlan.contributions.filter(
                          (item) => item.status === "available",
                        ).length
                      }
                      /{selectedBrainstormPlan.contributions.length} 位可用
                    </summary>
                    <div>
                      {selectedBrainstormPlan.contributions.map((item) => (
                        <section
                          key={`${item.planId}-${item.agent}`}
                          className={`is-${item.status}`}
                        >
                          <header>
                            <div>
                              <strong>{item.role}</strong>
                              <span>Agent {item.agent}</span>
                            </div>
                            <b>{brainstormContributionStatusLabel(item)}</b>
                          </header>
                          <p>
                            {item.contribution ||
                              item.diagnostic ||
                              "该角色未返回该方案的可用贡献。"}
                          </p>
                          {item.evidence.length > 0 && (
                            <small>依据：{item.evidence.join("；")}</small>
                          )}
                          {item.diagnostic && item.contribution && (
                            <small>对齐说明：{item.diagnostic}</small>
                          )}
                        </section>
                      ))}
                    </div>
                  </details>
                </article>
              )}
            </div>
          ) : (
            <div className="ms-simulation-paths">
              {visibleSimulationSchemes.map((item) => {
                const nodes = item.scheme.nodes;
                const schemeKey = `simulation-${item.key}`;
                const expanded = expandedSchemes.has(schemeKey);
                return (
                  <article className="ms-simulation-path" key={item.key}>
                    <header>
                      <span className="ms-agent-index">
                        {String(item.agent).padStart(2, "0")}
                      </span>
                      <div>
                        <h3>{item.scheme.title}</h3>
                        <p>
                          {item.role} · Agent {item.agent}
                        </p>
                      </div>
                      <span className={`ms-risk is-${item.scheme.riskLevel}`}>
                        {item.scheme.riskLevel === "high"
                          ? "高风险"
                          : item.scheme.riskLevel === "low"
                            ? "低风险"
                            : "中风险"}
                      </span>
                    </header>
                    <div className="ms-simulation-metrics">
                      <span>
                        <small>连贯度</small>
                        <b>{item.scheme.coherence || "-"}</b>
                      </span>
                      <span>
                        <small>新颖度</small>
                        <b>{item.scheme.novelty || "-"}</b>
                      </span>
                      <span>
                        <small>风险分</small>
                        <b>{item.scheme.risk || "-"}</b>
                      </span>
                      {item.scheme.tags.length > 0 && (
                        <div className="ms-scheme-tags">
                          {item.scheme.tags.map((tag) => (
                            <i key={tag}>{tag}</i>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="ms-path-timeline">
                      {nodes.length ? (
                        nodes.map((node) => (
                          <span key={`${node.offset}-${node.title}`}>
                            <b>{simulationStartChapter + node.offset}</b>
                            <small>{node.title}</small>
                          </span>
                        ))
                      ) : (
                        <span>
                          <b>-</b>
                          <small>未返回章节节点</small>
                        </span>
                      )}
                    </div>
                    <p>{item.scheme.premise || item.scheme.content}</p>
                    {nodes.length > 0 && (
                      <button
                        type="button"
                        className="ms-simulation-detail-toggle"
                        onClick={() =>
                          setExpandedSchemes((current) => {
                            const next = new Set(current);
                            if (next.has(schemeKey)) next.delete(schemeKey);
                            else next.add(schemeKey);
                            return next;
                          })
                        }
                      >
                        {expanded ? "收起节点详情" : "展开节点详情"}
                        {expanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </button>
                    )}
                    {expanded && nodes.length > 0 && (
                      <div className="ms-simulation-node-details">
                        {nodes.map((node) => (
                          <div key={`${node.offset}-${node.title}`}>
                            <b>
                              第 {simulationStartChapter + node.offset} 章 ·{" "}
                              {node.title}
                            </b>
                            {node.summary && <p>{node.summary}</p>}
                            {node.checkpoint && (
                              <small>验收：{node.checkpoint}</small>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <footer>
                      <button
                        type="button"
                        onClick={() =>
                          onUseBrief(
                            `${item.scheme.title}\n${item.scheme.content}`,
                          )
                        }
                      >
                        作为正文指令
                      </button>
                      <button
                        type="button"
                        className="is-primary"
                        onClick={() =>
                          void adoptSimulation(item.key, item.scheme, item.role)
                        }
                        disabled={
                          adopting === item.key || adopted.has(item.key)
                        }
                      >
                        {adopting === item.key ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : adopted.has(item.key) ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowRight className="h-3.5 w-3.5" />
                        )}
                        {adopted.has(item.key)
                          ? "已送入剧情工程"
                          : "送入剧情工程"}
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function AgentPromptDialog({
  agent,
  onClose,
}: {
  readonly agent: number;
  readonly onClose: () => void;
}) {
  useCloseLayer(() => {
    onClose();
    return true;
  }, 224);

  const isController = agent === 0;
  const role = isController
    ? "总控"
    : (ROOM_ROLES[agent - 1] ?? `Agent ${agent}`);
  const prompt = isController
    ? [
        "你是脑暴室总控 Agent，负责主持结构化创作会诊。",
        "先从统一事实快照中区分事实、作者要求和可推断内容，再汇总设计师会诊意见并生成多套方案契约。",
        "每套方案契约必须锁定核心选择、因果链、必备节拍、人物问题、情绪弧线、反转处理、开场或章末钩子、不可违背边界和待作者决定的问题。",
        "设计师围绕已锁定的方案契约并行提交专业贡献后，分别整合同一方案下的贡献并进行因果审计；保留事实依据、创作假设与冲突，不得合并不同方案。",
        "只输出调用方要求的 JSON，不要 Markdown 或额外解释。",
      ].join("\n")
    : buildBrainstormSystemPrompt(agent);

  return (
    <DraggableDialogFrame
      ariaLabel={`${role}完整提示词`}
      className="ms-agent-prompt-dialog h-[min(640px,calc(100vh-5rem))] w-[min(760px,calc(100vw-3rem))] max-sm:h-[calc(100vh-3rem)] max-sm:w-[calc(100vw-1.5rem)]"
      overlayClassName="bg-transparent"
      headerClassName="ms-agent-prompt-dialog-header"
      header={
        <div className="ms-agent-prompt-dialog-titlebar">
          <div>
            <strong>{role}</strong>
            <span>
              {isController
                ? "正文脑暴总控提示词"
                : `Agent ${agent} · 正文脑暴系统提示词`}
            </span>
          </div>
          <button
            type="button"
            className="ns-icon-button border-0"
            onClick={onClose}
            aria-label="关闭提示词"
            title="关闭提示词"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="ms-agent-prompt-body">
        <pre>{prompt}</pre>
      </div>
    </DraggableDialogFrame>
  );
}

function BrainstormRoomDialog({
  project,
  initialNotes,
  generationContext,
  targetWordCount,
  persistedManuscriptContent,
  onOpenAiAgent,
  onApplyGeneratedText,
  onOpenModelSettings,
  storage,
  chapter,
  chapterPlan,
  planningMode,
  manuscriptContent,
  enabled,
  onRun,
  onUseBrief,
  onAdoptSimulation,
  onClose,
  onBusyChange,
}: BrainstormRoomDialogProps) {
  const [roomStep, setRoomStep] = useState<"brainstorm" | "generation">(
    "brainstorm",
  );
  const [isBrainstormBusy, setIsBrainstormBusy] = useState(false);
  const [isFullGenerationBusy, setIsFullGenerationBusy] = useState(false);
  const nestedBusyRef = useRef({
    brainstorm: false,
    fullGeneration: false,
  });
  const [generationNotes, setGenerationNotes] = useState(initialNotes);
  const [contextOpen, setContextOpen] = useState(false);
  const [promptAgent, setPromptAgent] = useState<number | null>(null);
  const [fontScale, setFontScale] = useState<BrainstormFontScale>(100);
  const roomBusy = isBrainstormBusy || isFullGenerationBusy;
  const reportNestedBusy = useCallback(
    (kind: "brainstorm" | "fullGeneration", busy: boolean) => {
      nestedBusyRef.current[kind] = busy;
      if (kind === "brainstorm") setIsBrainstormBusy(busy);
      else setIsFullGenerationBusy(busy);
      onBusyChange?.(
        nestedBusyRef.current.brainstorm ||
          nestedBusyRef.current.fullGeneration,
      );
    },
    [onBusyChange],
  );
  useEffect(
    () => () => {
      onBusyChange?.(false);
    },
    [onBusyChange],
  );
  const closeDialog = useCallback(() => {
    if (!roomBusy) onClose();
  }, [onClose, roomBusy]);

  useCloseLayer(() => {
    if (roomBusy) return true;
    if (contextOpen) {
      setContextOpen(false);
      return true;
    }
    if (promptAgent !== null) {
      setPromptAgent(null);
      return true;
    }
    if (roomStep === "generation") {
      setRoomStep("brainstorm");
      return true;
    }
    onClose();
    return true;
  }, 222);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (roomBusy) return;
      if (contextOpen) setContextOpen(false);
      else if (promptAgent !== null) setPromptAgent(null);
      else if (roomStep === "generation") setRoomStep("brainstorm");
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextOpen, onClose, promptAgent, roomBusy, roomStep]);

  const switchToGeneration = useCallback(() => {
    if (roomBusy) return;
    setContextOpen(false);
    setPromptAgent(null);
    setRoomStep("generation");
  }, [roomBusy]);

  const switchToBrainstorm = useCallback(() => {
    setRoomStep("brainstorm");
  }, []);

  return (
    <>
      <DraggableDialogFrame
        ariaLabel="AI 脑暴与正文生成工作台"
        className="ms-room-dialog h-[min(820px,calc(100vh-3rem))] w-[min(1184px,calc(100vw-3rem))] max-sm:h-[calc(100vh-1.5rem)] max-sm:w-[calc(100vw-1.5rem)]"
        overlayClassName="bg-transparent"
        headerClassName="ms-room-dialog-header"
        header={
          <div className="ms-room-dialog-titlebar">
            <div className="ms-room-dialog-title min-w-0 flex-1">
              <h2>
                {chapter ? `第 ${chapter.displayNumber} 章` : "当前章节"} · AI
                脑暴与正文生成
              </h2>
              <p>
                {roomStep === "brainstorm"
                  ? "先发散创作方向，再将确认后的方案直接带入正文生成。"
                  : "在当前脑暴室内确认方案、补充要求并生成正文。"}
              </p>
            </div>
            <nav className="ms-room-flow-steps" aria-label="脑暴室流程">
              <button
                type="button"
                className={roomStep === "brainstorm" ? "is-active" : ""}
                onClick={() => setRoomStep("brainstorm")}
                disabled={roomBusy}
                aria-current={roomStep === "brainstorm" ? "step" : undefined}
              >
                <span>1</span>
                脑暴
              </button>
              <button
                type="button"
                className={roomStep === "generation" ? "is-active" : ""}
                onClick={switchToGeneration}
                disabled={roomBusy}
                aria-current={roomStep === "generation" ? "step" : undefined}
              >
                <span>2</span>
                正文生成
              </button>
            </nav>
            {roomStep === "brainstorm" && (
              <label className="ms-font-scale-control" data-no-dialog-drag>
                <span>产出字体</span>
                <CustomSelect
                  value={String(fontScale)}
                  options={BRAINSTORM_FONT_SCALE_OPTIONS.map((scale) => ({
                    value: String(scale),
                    label: `${scale}%`,
                  }))}
                  onChange={(value) =>
                    setFontScale(Number(value) as BrainstormFontScale)
                  }
                  ariaLabel="脑暴产出字体缩放"
                  className="ms-font-scale-select"
                  compact
                />
              </label>
            )}
            {roomStep === "brainstorm" && (
              <button
                type="button"
                className="ms-context-snapshot"
                aria-expanded={contextOpen}
                aria-controls="brainstorm-context-snapshot"
                onClick={() => setContextOpen((current) => !current)}
                title="查看冻结上下文"
              >
                上下文快照 ·{" "}
                {chapter ? `CH-${chapter.displayNumber}` : "未绑定"}
              </button>
            )}
            {roomStep === "brainstorm" && contextOpen && (
              <div
                id="brainstorm-context-snapshot"
                className="ms-context-popover"
                data-no-dialog-drag
                role="dialog"
                aria-label="脑暴上下文快照"
              >
                <strong>本次脑暴上下文</strong>
                <dl>
                  <div>
                    <dt>章节</dt>
                    <dd>{chapter?.title ?? "未绑定章节"}</dd>
                  </div>
                  <div>
                    <dt>正文</dt>
                    <dd>
                      {manuscriptContent
                        ? `${Array.from(manuscriptContent).length.toLocaleString()} 字`
                        : "空正文"}
                    </dd>
                  </div>
                  <div>
                    <dt>章节计划</dt>
                    <dd>{chapterPlan ? "已关联" : "未关联"}</dd>
                  </div>
                  <div>
                    <dt>状态</dt>
                    <dd>正文快照已冻结</dd>
                  </div>
                </dl>
              </div>
            )}
            <button
              type="button"
              className="ns-icon-button border-0"
              onClick={closeDialog}
              disabled={roomBusy}
              aria-label="关闭 AI 脑暴室"
              title={roomBusy ? "AI 任务正在运行，完成后可关闭" : "关闭"}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        }
      >
        <div
          className={`ms-room-step ${roomStep === "brainstorm" ? "" : "is-hidden"}`}
          aria-hidden={roomStep !== "brainstorm"}
        >
          <RoomWorkspace
            kind="brainstorm"
            presentation="dialog"
            storage={storage}
            chapter={chapter}
            chapterPlan={chapterPlan}
            planningMode={planningMode}
            manuscriptContent={manuscriptContent}
            enabled={enabled}
            onRun={onRun}
            onUseBrief={(brief) => {
              setGenerationNotes(brief);
              onUseBrief(brief);
              switchToGeneration();
            }}
            onAdoptSimulation={onAdoptSimulation}
            onShowAgentPrompt={setPromptAgent}
            outputFontScale={fontScale}
            onBusyChange={(busy) => reportNestedBusy("brainstorm", busy)}
          />
        </div>
        <FullGenerationWorkflow
          storage={storage}
          project={project}
          open={roomStep === "generation"}
          embedded
          agentOnly
          chapter={chapter}
          chapterPlan={chapterPlan}
          manuscriptContent={manuscriptContent}
          persistedManuscriptContent={persistedManuscriptContent}
          initialNotes={generationNotes}
          generationContext={generationContext}
          targetWordCount={targetWordCount}
          onRun={onRun}
          onOpenAiAgent={onOpenAiAgent}
          onApplyGeneratedText={onApplyGeneratedText}
          onOpenModelSettings={onOpenModelSettings}
          onClose={switchToBrainstorm}
          onBusyChange={(busy) => reportNestedBusy("fullGeneration", busy)}
        />
      </DraggableDialogFrame>
      {promptAgent !== null && (
        <AgentPromptDialog
          agent={promptAgent}
          onClose={() => setPromptAgent(null)}
        />
      )}
    </>
  );
}

function SimulationRoomDialog({
  storage,
  chapter,
  chapterPlan,
  planningMode,
  manuscriptContent,
  enabled,
  onRun,
  onUseBrief,
  onAdoptSimulation,
  onClose,
  onBusyChange,
}: RoomDialogProps) {
  const [isSimulationBusy, setIsSimulationBusy] = useState(false);
  const reportSimulationBusy = useCallback(
    (busy: boolean) => {
      setIsSimulationBusy(busy);
      onBusyChange?.(busy);
    },
    [onBusyChange],
  );
  useEffect(
    () => () => {
      onBusyChange?.(false);
    },
    [onBusyChange],
  );
  useCloseLayer(() => {
    if (!isSimulationBusy) onClose();
    return true;
  }, 223);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSimulationBusy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSimulationBusy, onClose]);

  return (
    <DraggableDialogFrame
      ariaLabel="AI 剧情推演室"
      className="ms-room-dialog ms-simulation-dialog h-[min(820px,calc(100vh-3rem))] w-[min(1480px,calc(100vw-3rem))] max-sm:h-[calc(100vh-1.5rem)] max-sm:w-[calc(100vw-1.5rem)]"
      overlayClassName="bg-black/35 backdrop-blur-sm"
      headerClassName="ms-room-dialog-header"
      header={
        <div className="ms-room-dialog-titlebar">
          <div className="min-w-0 flex-1">
            <span className="ms-eyebrow">Plot simulation lab</span>
            <h2>
              {chapter ? `第 ${chapter.displayNumber} 章之后` : "当前章节之后"}{" "}
              · AI 剧情推演室
            </h2>
            <p>
              每个 Agent
              从同一剧情检查点独立演算后续因果链，只创建候选分支，不修改正式大纲。
            </p>
          </div>
          <span className="ms-context-snapshot">
            剧情检查点 · {chapter ? `PLOT-${chapter.displayNumber}` : "未绑定"}
          </span>
          <button
            type="button"
            className="ns-icon-button border-0"
            onClick={onClose}
            disabled={isSimulationBusy}
            aria-label="关闭 AI 剧情推演室"
            title={isSimulationBusy ? "AI 任务正在运行，完成后可关闭" : "关闭"}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <RoomWorkspace
        kind="simulation"
        presentation="dialog"
        storage={storage}
        chapter={chapter}
        chapterPlan={chapterPlan}
        planningMode={planningMode}
        manuscriptContent={manuscriptContent}
        enabled={enabled}
        onRun={onRun}
        onUseBrief={onUseBrief}
        onAdoptSimulation={onAdoptSimulation}
        onBusyChange={reportSimulationBusy}
      />
    </DraggableDialogFrame>
  );
}

const FULL_GENERATION_AGENTS = [
  "Agent 01",
  "Agent 02",
  "Agent 03",
  "Agent 04",
  "Agent 05",
  "Agent 06",
] as const;

type FullGenerationAgentStatus =
  | "idle"
  | "running"
  | "retrying"
  | "repairing"
  | "ready"
  | "error";
type FullGenerationSchemeCount = 1 | 2 | 3;

export const FULL_GENERATION_AI_EXECUTION_PROFILE =
  EXTENDED_AI_EXECUTION_PROFILE;
export const FULL_GENERATION_TEXT_TOOL_CALL_LIMIT = 6;
export const FULL_GENERATION_DEFAULT_TIMEOUT_MINUTES =
  EXTENDED_AI_DEFAULT_TIMEOUT_MINUTES;
export const FULL_GENERATION_DEFAULT_MAX_TURNS = EXTENDED_AI_DEFAULT_MAX_TURNS;
export const FULL_GENERATION_TIMEOUT_MINUTES = EXTENDED_AI_TIMEOUT_MINUTES;
const FULL_GENERATION_TIMEOUT_OPTIONS = EXTENDED_AI_TIMEOUT_OPTIONS;
export const FULL_GENERATION_MAX_TURNS = EXTENDED_AI_MAX_TURNS;
const FULL_GENERATION_MAX_TURNS_OPTIONS = EXTENDED_AI_MAX_TURNS_OPTIONS;

export function applyFullGenerationRunTimeout(
  request: ManuscriptAiRunRequest,
  timeoutMinutes: number,
  maxTurns = FULL_GENERATION_DEFAULT_MAX_TURNS,
): ManuscriptAiRunRequest {
  return applyExtendedAiRunBudget(request, timeoutMinutes, maxTurns);
}

const FULL_GENERATION_TONE_BIASES = [
  {
    value: "balanced",
    label: "自由发挥",
    instruction: "不预设单一情绪风格，优先服从本章剧情目标和人物状态。",
  },
  {
    value: "humorous",
    label: "偏幽默",
    instruction: "增加自然的机锋、反差和轻松感，笑点必须来自人物性格与处境。",
  },
  {
    value: "comedic",
    label: "偏搞笑",
    instruction:
      "提高喜剧事件与包袱密度，允许误会和节奏错位，但不能破坏人物可信度。",
  },
  {
    value: "hot-blooded",
    label: "偏热血",
    instruction: "突出迎难而上、意志碰撞和行动爆发，形成清晰的情绪抬升。",
  },
  {
    value: "passionate",
    label: "偏激情",
    instruction: "强化强烈欲望、情感冲突和关系张力，让人物选择更有温度与力度。",
  },
  {
    value: "suspenseful",
    label: "偏悬疑",
    instruction: "控制信息释放，用疑点、误导和逐步验证维持紧张感与阅读牵引。",
  },
  {
    value: "oppressive",
    label: "偏压迫",
    instruction: "强化限制条件、迫近威胁和无处可退的压力，同时保留人物主动性。",
  },
  {
    value: "warm",
    label: "偏温情",
    instruction:
      "通过具体行动与细节表现理解、照顾和关系变化，避免直接说教煽情。",
  },
  {
    value: "twist",
    label: "偏反转",
    instruction:
      "围绕已有事实设计可回溯的认知反转，提前埋设线索，不使用无依据突变。",
  },
  {
    value: "restrained",
    label: "偏克制",
    instruction: "减少直白宣泄，以动作、停顿、潜台词和细节承载情绪与冲突。",
  },
] as const;

type FullGenerationToneBias =
  (typeof FULL_GENERATION_TONE_BIASES)[number]["value"];

const FULL_GENERATION_TONE_OPTIONS: SelectOption[] =
  FULL_GENERATION_TONE_BIASES.map(({ value, label }) => ({ value, label }));

function getFullGenerationToneBias(toneBias: FullGenerationToneBias) {
  return (
    FULL_GENERATION_TONE_BIASES.find((item) => item.value === toneBias) ??
    FULL_GENERATION_TONE_BIASES[0]
  );
}

function FullGenerationLiveStatus({
  progress,
}: {
  readonly progress: WorkbenchAiRunProgress;
}) {
  const label =
    progress.kind === "tool"
      ? "工具"
      : progress.kind === "intent"
        ? "执行意图"
        : "状态";
  return (
    <div
      className="ms-full-generation-live-status"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <b>{label}</b>
      <span title={progress.message}>{progress.message}</span>
    </div>
  );
}

interface FullGenerationAgentConfig {
  readonly agent: number;
  readonly enabled: boolean;
  readonly schemeCount: FullGenerationSchemeCount;
  readonly toneBias: FullGenerationToneBias;
  readonly extraPrompt: string;
  readonly modelSelection: WorkbenchModelSelection | undefined;
}

interface FullGenerationAgentResult {
  readonly status: FullGenerationAgentStatus;
  readonly plans: readonly FullGenerationPlan[];
  readonly error?: string;
  readonly liveStatus?: WorkbenchAiRunProgress;
}

function createFullGenerationRunId(): string {
  const randomId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `full-generation-${randomId}`;
}

function createFullGenerationAgentConfigs(): readonly FullGenerationAgentConfig[] {
  return FULL_GENERATION_AGENTS.map((_, index) => ({
    agent: index + 1,
    enabled: index < 3,
    schemeCount: 2,
    toneBias: "balanced",
    extraPrompt: "",
    modelSelection: undefined,
  }));
}

function createFullGenerationAgentResults(): Readonly<
  Record<number, FullGenerationAgentResult>
> {
  return Object.fromEntries(
    FULL_GENERATION_AGENTS.map((_, index) => [
      index + 1,
      {
        status: "idle",
        plans: [],
      },
    ]),
  ) as Readonly<Record<number, FullGenerationAgentResult>>;
}

export function buildFullGenerationAgentSystemPrompt(
  readMode: FullGenerationContextReadMode = "agent",
): string {
  const contextInstruction =
    readMode === "quick"
      ? "作者已经人工选择资料，并把同一份资料快照一次性附在用户消息中。禁止调用任何工具；只依据已附资料、当前章节和作者要求完成全部方案并一次性输出。未选择的资料不代表不存在，不得自行补造其中的事实。"
      : "开始构思前，先判断本章真正需要哪些项目事实，再按需使用小说工作台内置只读工具读取当前章节正文、前面章节、设定库、人物库、剧情工程、时间线和连续性状态。优先在一次调用中取得同一领域所需范围，同一个工具原则上只调用一次；资料读取完成后直接生成，不要边写边反复补查。不要为了遍历而调用无关工具，也不要调用任何写入工具。";
  return `你是 MyAgents 小说工作台的正文方案 Agent。所有 Agent 职责相同，必须独立生成差异明显的正文方案，不区分角色分工。

${contextInstruction}当前章节和作者附加提示词优先级最高，项目事实用于约束方案而不是被改写。

方案必须是可以直接指导正文写作的场景级详细蓝图，不是梗概列表。每个方案拆成 3～6 个按正文顺序排列的片段，每个片段 content 约 300～600 个中文字，完整方案约 1200～2500 字。每个片段都要具体写清：场景目标、在场人物的行动与阻力、信息如何释放、关键对话或动作设计、情绪变化，以及如何衔接下一片段。不要用“双方发生冲突”“主角解决问题”之类空泛概括代替过程。

只输出 JSON，不要使用 Markdown 代码围栏：{"plans":[{"title":"方案标题","premise":"方案核心取舍与主要因果链","fragments":[{"title":"片段标题","summary":"片段的叙事作用","content":"场景级详细写作蓝图"}]}]}。严格返回用户要求的方案数量；方案之间必须在事件选择、人物行动、信息揭示或后果上有实质差异。`;
}

export function buildFullGenerationAgentPrompt(input: {
  readonly chapterId: string;
  readonly chapterNumber: string | number;
  readonly chapterTitle: string;
  readonly schemeCount: FullGenerationSchemeCount;
  readonly chapterPlan: string;
  readonly generationContext: string;
  readonly manuscriptContent: string;
  readonly targetWordCount?: number;
  readonly toneBias: FullGenerationToneBias;
  readonly extraPrompt: string;
}): string {
  const toneBias = getFullGenerationToneBias(input.toneBias);
  return [
    `章节 ID：${input.chapterId}`,
    `章节：第 ${input.chapterNumber} 章 · ${input.chapterTitle}`,
    `本 Agent 需要生成 ${input.schemeCount} 个不同方案。`,
    `内容偏向：${toneBias.label}\n执行要求：${toneBias.instruction}`,
    input.chapterPlan,
    input.targetWordCount
      ? `本章正文目标：${input.targetWordCount} 字，方案规模和场景密度必须能支撑该篇幅。`
      : "本章正文目标：未设置固定字数。",
    input.generationContext,
    input.manuscriptContent.trim()
      ? `当前章节已有未保存正文（只作事实基线）：\n${excerpt(input.manuscriptContent, 1800)}`
      : "当前章节正文为空。",
    input.extraPrompt.trim()
      ? `该 Agent 的额外提示词：\n${input.extraPrompt.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildFullGenerationAgentRunRequest(input: {
  readonly agent: number;
  readonly chapterTitle: string;
  readonly prompt: string;
  readonly modelSelection: WorkbenchModelSelection | undefined;
  readonly readMode?: FullGenerationContextReadMode;
}): ManuscriptAiRunRequest {
  const readMode = input.readMode ?? "agent";
  return {
    sceneId: `manuscript.brainstorm.agent${input.agent}` as NovelModelSceneId,
    label: `${input.chapterTitle} · 正文方案 · Agent ${input.agent}`,
    systemPrompt: buildFullGenerationAgentSystemPrompt(readMode),
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    executionProfile: FULL_GENERATION_AI_EXECUTION_PROFILE,
    ...(readMode === "agent" ? { usesNovelContextTools: true } : {}),
    prompt: input.prompt,
  };
}

export function buildFullGenerationPlanRepairRunRequest(input: {
  readonly request: ManuscriptAiRunRequest;
  readonly output: string;
  readonly schemeCount: FullGenerationSchemeCount;
}): ManuscriptAiRunRequest {
  return {
    sceneId: input.request.sceneId,
    label: `${input.request.label} · 整理返回格式`,
    systemPrompt: `你是小说正文方案的格式整理器。只能整理用户提供的已有方案，不得增加、删改或续写剧情事实，不得调用任何工具。只输出严格 JSON，不要解释，不要使用 Markdown 代码围栏。结构必须是：{"plans":[{"title":"方案标题","premise":"核心取舍与因果链","fragments":[{"title":"片段标题","summary":"叙事作用","content":"完整的场景级写作蓝图"}]}]}。最多保留 ${input.schemeCount} 个方案，并保留每个方案原有的全部有效片段。`,
    ...(input.request.modelSelection
      ? { modelSelection: input.request.modelSelection }
      : {}),
    executionProfile: FULL_GENERATION_AI_EXECUTION_PROFILE,
    prompt: `请把下面的 Agent 原始返回整理为约定 JSON。不要重新创作；原文中没有的信息留空，不要补写。\n\n【原始返回】\n${input.output.slice(0, 60_000)}`,
  };
}

export function buildFullGenerationSuggestionRepairRunRequest(input: {
  readonly output: string;
  readonly allowedIds: readonly string[];
}): ManuscriptAiRunRequest {
  return {
    sceneId: "manuscript.brainstorm.synthesis",
    label: "正文方案 · AI 建议选片 · 整理返回格式",
    systemPrompt:
      '你是正文方案选片结果的格式整理器。只能从用户提供的原始返回中保留已有片段 ID 和理由，不得新增、改写或推测 ID，不得调用任何工具。只输出严格 JSON，不要解释，不要使用 Markdown 代码围栏。结构必须是：{"fragmentIds":["片段ID"],"reason":"选择理由"}。',
    executionProfile: FULL_GENERATION_AI_EXECUTION_PROFILE,
    prompt: `请把下面的原始返回整理为约定 JSON。只能使用允许的片段 ID。\n\n允许的片段 ID：${input.allowedIds.join(", ")}\n\n【原始返回】\n${input.output.slice(0, 40_000)}`,
  };
}

export function buildFullGenerationTextRunRequest(input: {
  readonly chapterTitle: string;
  readonly prompt: string;
  readonly targetWordCount?: number;
  readonly readMode?: FullGenerationContextReadMode;
}): ManuscriptAiRunRequest {
  const readMode = input.readMode ?? "agent";
  const targetInstruction = input.targetWordCount
    ? `本章目标字数为 ${input.targetWordCount} 字（默认继承项目总览，可由作者在本章上下文中调整），最终正文必须控制在 ${Math.ceil(input.targetWordCount * 0.9)}～${Math.floor(input.targetWordCount * 1.1)} 个非空字符。`
    : "本章未设定目标字数，按章节剧情需要控制篇幅。";
  return {
    sceneId: "manuscript.generate",
    label: `${input.chapterTitle} · 完整生成正文`,
    systemPrompt: `你是 MyAgents 小说工作台的中文长篇小说正文写作 Agent。${
      readMode === "quick"
        ? "作者已把人工选择的项目资料快照一次性附在用户消息中；禁止调用任何工具，直接依据已附资料一次性输出完整正文。未选择的资料不代表不存在，不得自行补造其中的事实。"
        : "开始写作前，按需使用小说工作台内置只读工具核对人物、设定、剧情工程、时间线、前文和连续性；不要遍历无关资料，同一个工具原则上只调用一次。"
    }作者确认的方案片段、人工建议和当前章节正文事实优先级最高。${targetInstruction}只输出可直接采用的完整章节正文，不解释过程，不输出标题，不使用 Markdown 代码围栏；不要展示字数统计、自检、推理过程或写作说明。正文必须具有完整场景、具体行动、自然对话、清晰因果、情绪变化和章末牵引，避免梗概腔、模板腔与机械工整感。`,
    executionProfile: FULL_GENERATION_AI_EXECUTION_PROFILE,
    ...(readMode === "agent"
      ? {
          usesNovelContextTools: true,
          novelContextToolCallLimit: FULL_GENERATION_TEXT_TOOL_CALL_LIMIT,
        }
      : {}),
    prompt: input.prompt,
  };
}

export function buildFullGenerationTextAgentInitialMessage(input: {
  readonly runId: string;
  readonly chapterId: string;
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly chapterPlan: string;
  readonly targetWordCount: number;
  readonly readMode: FullGenerationContextReadMode;
  readonly selectedFragments: readonly FullGenerationFragment[];
  readonly writerNotes: string;
  readonly suggestionReason: string;
  readonly quickContext: string;
}): string {
  const minimum = Math.ceil(input.targetWordCount * 0.9);
  const maximum = Math.floor(input.targetWordCount * 1.1);
  const selectedPlan = input.selectedFragments.length
    ? [
        "按以下顺序整合作者确认的方案片段。它们是必须满足的写作约束，不是要求逐字照抄的正文：",
        ...input.selectedFragments.map(
          (fragment, index) =>
            String(index + 1) + ". " + fragment.title + "\n" + fragment.content,
        ),
      ].join("\n\n")
    : "作者跳过了方案选择，请直接依据已保存事实和章节计划完成本章。";
  const readRule =
    input.readMode === "quick"
      ? [
          "资料读取方式：快速模式。",
          "作者选择的资料快照已经完整附在本消息中。除第 1 步为取得 sourceHash 而调用 novel_manuscript_get_context 外，不得调用任何 novel_*_get_context 读取工具，也不得用未选择的资料补造事实。",
          input.quickContext
            ? "【作者选择的资料快照】\n" + input.quickContext
            : "【作者选择的资料快照】作者未选择额外资料。",
        ].join("\n\n")
      : [
          "资料读取方式：智能体自主读取。",
          "先读取当前章节，然后仅在确有必要时调用人物、时间线、剧情工程、世界架构、物品、势力、修行体系、连续性或灵感的小说工作台读取工具。不得为遍历资料而机械调用全部工具；已读取的资料不得重复读取。",
        ].join("\n\n");

  return [
    "你是 MyAgents 小说工作台的正文写作 Agent。当前任务是生成一份可审阅、可应用的完整章节正文。",
    "任务标识：runId=" + input.runId,
    "目标章节：第 " +
      input.chapterNumber +
      " 章 · " +
      input.chapterTitle +
      "（chapterId=" +
      input.chapterId +
      "）",
    "字数硬约束：本章目标 " +
      input.targetWordCount.toLocaleString() +
      " 字，完整候选必须控制在 " +
      minimum.toLocaleString() +
      "～" +
      maximum.toLocaleString() +
      " 个非空字符。不要通过重复、梗概或无关支线凑字数。",
    input.chapterPlan,
    selectedPlan,
    input.writerNotes ? "作者附加建议：\n" + input.writerNotes : "",
    input.suggestionReason
      ? "AI 选片参考理由：\n" + input.suggestionReason
      : "",
    readRule,
    [
      "执行协议：",
      "1. 必须先调用 novel_manuscript_get_context，并传 chapterId=" +
        input.chapterId +
        "，取得当前章节全文、sourceHash 与长度；不得猜测或复述不存在的正文。",
      "2. 遵守上述资料读取方式后再开始写作。已写正文、总览约束、作者确认片段和作者建议优先于任何推测。",
      "3. 调用 novel_manuscript_create_draft 创建草稿：runId 必须为 " +
        input.runId +
        "，chapterId 必须为 " +
        input.chapterId +
        "，mode 必须为 generate，rangeStart=0，rangeEnd 必须等于第 1 步返回的当前章节全文长度，baseSourceHash 必须使用第 1 步返回值。",
      "4. 使用 novel_manuscript_upsert_candidate 分块写入完整章节候选。首块替换 candidate，后续块使用同一 candidateId 并传 append=true；每块不得超过工具限制。候选只写正文，不写标题、解释、字数统计、Markdown 围栏或自检过程。",
      "5. 完成后依次调用 novel_manuscript_validate_draft、novel_manuscript_submit_draft 和 novel_manuscript_get_proposal_status。只允许提交候选草稿，不得直接改写正式正文；sourceHash 冲突时停止并说明正文已变化。",
      "6. 正文必须有完整场景、具体行动、自然对话、明确因果、人物声口、情绪变化和章末牵引，避免模板腔与机械工整感。",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildFullGenerationTextCorrectionRunRequest(input: {
  readonly request: ManuscriptAiRunRequest;
  readonly output: string;
  readonly targetWordCount: number;
}): ManuscriptAiRunRequest {
  const target = Math.max(1, Math.round(input.targetWordCount));
  const minimum = Math.ceil(target * 0.9);
  const maximum = Math.floor(target * 1.1);
  return {
    sceneId: "manuscript.generate",
    label: `${input.request.label} · 按总览字数调整`,
    systemPrompt: `你是中文长篇小说正文终稿编辑。只能调整用户提供的正文候选，不得调用任何工具，不得输出解释、标题、Markdown、字数统计、自检或推理过程。保持原有剧情事实、人物行动顺序、关键信息和章末牵引；通过删减重复、压缩或补足场景细节，将最终正文控制在 ${minimum}～${maximum} 个非空字符，尽量接近本章目标 ${target} 字。只输出调整后的完整正文。`,
    ...(input.request.modelSelection
      ? { modelSelection: input.request.modelSelection }
      : {}),
    executionProfile: FULL_GENERATION_AI_EXECUTION_PROFILE,
    prompt: [
      `本章目标：${target} 字；允许范围：${minimum}～${maximum} 个非空字符。`,
      `原始写作约束摘要：\n${input.request.prompt.slice(0, 16_000)}`,
      `需要调整的正文候选：\n${input.output.slice(0, 40_000)}`,
      "直接返回调整后的完整正文，不要附带任何检查过程。",
    ].join("\n\n"),
  };
}

export function isFullGenerationMaxTurnsError(error: unknown): boolean {
  const message = errorText(error);
  return (
    /reached maximum number of turns(?:\s*\(\d+\))?/i.test(message) ||
    /\berror_max_turns\b/i.test(message) ||
    message.includes("触达最大轮次上限")
  );
}

export function isFullGenerationTimeoutError(error: unknown): boolean {
  const message = errorText(error);
  return (
    /AI 运行超过\s*\d+\s*秒/iu.test(message) ||
    /(?:timed?\s*out|timeout|超时)/iu.test(message)
  );
}

export function buildFullGenerationRecoveryRunRequest(
  request: ManuscriptAiRunRequest,
): ManuscriptAiRunRequest {
  const isTextGeneration = request.sceneId === "manuscript.generate";
  const recoveryInstruction = `这是上一轮未能在时间或轮次预算内完成后的唯一一次自动收敛重试。不得调用任何工具、不得补充读取资料，也不要复述任务；只依据本次用户消息中已有的章节计划、前文摘要、连续性状态、作者要求和已选方案直接返回${isTextGeneration ? "完整章节正文纯文本" : "约定 JSON"}，不要解释过程或使用 Markdown 代码围栏。`;
  return {
    ...request,
    label: `${request.label} · 收敛重试`,
    systemPrompt: [request.systemPrompt, recoveryInstruction]
      .filter(Boolean)
      .join("\n\n"),
    prompt: `${request.prompt}\n\n【无工具收敛重试】上一轮未能在时间或轮次预算内收敛。本轮不得调用工具或补充资料，直接完成${isTextGeneration ? "完整正文" : "全部方案"}。`,
    usesNovelContextTools: undefined,
    novelContextToolCallLimit: undefined,
  };
}

export async function runFullGenerationAgentWithRecovery(input: {
  readonly request: ManuscriptAiRunRequest;
  readonly onRun: (request: ManuscriptAiRunRequest) => Promise<string>;
  readonly onRecovery?: () => void;
}): Promise<string> {
  try {
    return await input.onRun(input.request);
  } catch (cause) {
    if (
      !isFullGenerationMaxTurnsError(cause) &&
      !isFullGenerationTimeoutError(cause)
    ) {
      throw cause;
    }
    input.onRecovery?.();
    try {
      return await input.onRun(
        buildFullGenerationRecoveryRunRequest(input.request),
      );
    } catch (recoveryCause) {
      throw new Error(
        `已自动收敛重试一次，仍未完成：${errorText(recoveryCause)}`,
      );
    }
  }
}

function fullGenerationRecordValue(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function fullGenerationPlanValues(
  value: unknown,
  depth = 0,
): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 2) return [];
  const record = value as Record<string, unknown>;
  const direct = fullGenerationRecordValue(record, [
    "plans",
    "schemes",
    "方案",
    "方案列表",
    "candidates",
  ]);
  if (Array.isArray(direct)) return direct;
  if (direct && typeof direct === "object") return [direct];
  const fragments = fullGenerationRecordValue(record, [
    "fragments",
    "segments",
    "sections",
    "片段",
    "正文片段",
  ]);
  if (
    Array.isArray(fragments) ||
    (fragments && typeof fragments === "object")
  ) {
    return [record];
  }
  for (const key of ["data", "result", "output", "plan", "方案内容"]) {
    const nested = fullGenerationPlanValues(record[key], depth + 1);
    if (nested.length) return nested;
  }
  return [];
}

function cleanFullGenerationMarkdownControlLine(value: string): string {
  return value
    .trim()
    .replace(/^#{1,6}\s*/u, "")
    .replace(/^[-+*]\s+/u, "")
    .replace(/\*\*/gu, "")
    .trim();
}

function fullGenerationMarkdownLabel(
  value: string,
  labels: readonly string[],
): string | null {
  const normalized = cleanFullGenerationMarkdownControlLine(value);
  for (const label of labels) {
    if (!normalized.startsWith(label)) continue;
    const rest = normalized.slice(label.length);
    const match = rest.match(/^\s*[：:]\s*([\s\S]*)$/u);
    if (match) return match[1]?.trim() ?? "";
  }
  return null;
}

function parseFullGenerationMarkdownPlans(output: string): readonly unknown[] {
  interface MarkdownFragment {
    title: string;
    summary: string;
    contentLines: string[];
  }
  interface MarkdownPlan {
    title: string;
    premise: string;
    bodyLines: string[];
    fragments: MarkdownFragment[];
  }

  const plans: MarkdownPlan[] = [];
  let plan: MarkdownPlan | null = null;
  let fragment: MarkdownFragment | null = null;
  const finishFragment = () => {
    if (!plan || !fragment) return;
    const content = fragment.contentLines.join("\n").trim();
    if (content || fragment.summary) {
      plan.fragments.push({
        ...fragment,
        contentLines: [content || fragment.summary],
      });
    }
    fragment = null;
  };
  const finishPlan = () => {
    if (!plan) return;
    finishFragment();
    const body = plan.bodyLines.join("\n").trim();
    if (!plan.fragments.length && body) {
      plan.fragments.push({
        title: "正文推进",
        summary: "",
        contentLines: [body],
      });
    }
    if (plan.fragments.length) plans.push(plan);
    plan = null;
  };

  for (const rawLine of output
    .replace(/```[^\r\n]*|```/gu, "")
    .split(/\r?\n/u)) {
    const controlLine = cleanFullGenerationMarkdownControlLine(rawLine);
    const planHeading = controlLine.match(
      /^(?:方案|plan)\s*(?:第\s*)?([0-9一二三四五六七八九十]+)\s*(?:[：:、.-]\s*)?(.*)$/iu,
    );
    if (planHeading) {
      finishPlan();
      plan = {
        title: planHeading[2]?.trim() || `方案 ${planHeading[1]}`,
        premise: "",
        bodyLines: [],
        fragments: [],
      };
      continue;
    }
    const fragmentHeading = controlLine.match(
      /^(?:片段|场景|段落|fragment|segment)\s*(?:第\s*)?([0-9一二三四五六七八九十]+)\s*(?:[：:、.-]\s*)?(.*)$/iu,
    );
    if (fragmentHeading) {
      if (!plan) {
        plan = { title: "正文方案", premise: "", bodyLines: [], fragments: [] };
      }
      finishFragment();
      fragment = {
        title: fragmentHeading[2]?.trim() || `片段 ${fragmentHeading[1]}`,
        summary: "",
        contentLines: [],
      };
      continue;
    }
    if (!plan) continue;
    const premise = fullGenerationMarkdownLabel(rawLine, [
      "核心取舍与主要因果链",
      "核心取舍",
      "主要因果链",
      "方案核心",
      "方案概述",
      "核心思路",
      "premise",
    ]);
    if (premise !== null && !fragment) {
      plan.premise = premise;
      continue;
    }
    if (fragment) {
      const summary = fullGenerationMarkdownLabel(rawLine, [
        "片段的叙事作用",
        "片段作用",
        "叙事作用",
        "摘要",
        "summary",
      ]);
      if (summary !== null) {
        fragment.summary = summary;
        continue;
      }
      const content = fullGenerationMarkdownLabel(rawLine, [
        "场景级详细写作蓝图",
        "详细写作蓝图",
        "详细内容",
        "片段内容",
        "content",
      ]);
      if (content !== null) {
        if (content) fragment.contentLines.push(content);
        continue;
      }
      if (controlLine) fragment.contentLines.push(rawLine.trim());
    } else if (controlLine) {
      plan.bodyLines.push(rawLine.trim());
    }
  }
  finishPlan();
  return plans.map((item) => ({
    title: item.title,
    premise: item.premise || item.bodyLines.join("\n").trim(),
    fragments: item.fragments.map((entry) => ({
      title: entry.title,
      summary: entry.summary,
      content: entry.contentLines.join("\n").trim(),
    })),
  }));
}

export function parseFullGenerationPlans(
  output: string,
  agent: number,
  limit: number,
): readonly FullGenerationPlan[] {
  let source: readonly unknown[] = [];
  try {
    source = fullGenerationPlanValues(extractJson(output));
  } catch {
    source = parseFullGenerationMarkdownPlans(output);
  }
  if (!source.length) source = parseFullGenerationMarkdownPlans(output);
  if (!source.length) throw new Error(`Agent ${agent} 返回内容格式无法识别`);

  const plans = source.slice(0, limit).flatMap((item, planIndex) => {
    if (typeof item === "string") {
      const content = item.trim();
      if (!content) return [];
      return [
        {
          id: `agent-${agent}-plan-${planIndex + 1}`,
          agent,
          agentName: `Agent ${String(agent).padStart(2, "0")}`,
          title: `方案 ${planIndex + 1}`,
          premise: excerpt(content, 72),
          fragments: [
            {
              id: `agent-${agent}-plan-${planIndex + 1}-fragment-1`,
              title: "正文推进",
              summary: excerpt(content, 72),
              content,
              source: `Agent ${String(agent).padStart(2, "0")}`,
            },
          ],
        },
      ];
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const fragmentValue = fullGenerationRecordValue(record, [
      "fragments",
      "segments",
      "sections",
      "片段",
      "正文片段",
    ]);
    const rawFragments = Array.isArray(fragmentValue)
      ? fragmentValue
      : fragmentValue && typeof fragmentValue === "object"
        ? Object.values(fragmentValue)
        : [];
    const fallbackContent = roomText(
      fullGenerationRecordValue(record, [
        "content",
        "text",
        "body",
        "内容",
        "正文",
      ]),
    );
    const fragmentCandidates = rawFragments.length
      ? rawFragments
      : fallbackContent
        ? [fallbackContent]
        : [];
    const fragments = fragmentCandidates
      .slice(0, 8)
      .flatMap((fragment, fragmentIndex) => {
        if (typeof fragment === "string") {
          const content = fragment.trim();
          if (!content) return [];
          return [
            {
              id: `agent-${agent}-plan-${planIndex + 1}-fragment-${fragmentIndex + 1}`,
              title: `片段 ${fragmentIndex + 1}`,
              summary: excerpt(content, 72),
              content,
              source: `Agent ${String(agent).padStart(2, "0")}`,
            },
          ];
        }
        if (
          !fragment ||
          typeof fragment !== "object" ||
          Array.isArray(fragment)
        )
          return [];
        const fragmentRecord = fragment as Record<string, unknown>;
        const content = roomText(
          fullGenerationRecordValue(fragmentRecord, [
            "content",
            "text",
            "body",
            "detail",
            "内容",
            "正文",
            "详细内容",
            "写作蓝图",
          ]),
        );
        if (!content) return [];
        return [
          {
            id: `agent-${agent}-plan-${planIndex + 1}-fragment-${fragmentIndex + 1}`,
            title:
              roomText(
                fullGenerationRecordValue(fragmentRecord, [
                  "title",
                  "name",
                  "标题",
                  "片段标题",
                ]),
              ) || `片段 ${fragmentIndex + 1}`,
            summary:
              roomText(
                fullGenerationRecordValue(fragmentRecord, [
                  "summary",
                  "description",
                  "purpose",
                  "摘要",
                  "叙事作用",
                  "片段作用",
                ]),
              ) || excerpt(content, 72),
            content,
            source: `Agent ${String(agent).padStart(2, "0")}`,
          },
        ];
      });
    if (!fragments.length) return [];
    return [
      {
        id: `agent-${agent}-plan-${planIndex + 1}`,
        agent,
        agentName: `Agent ${String(agent).padStart(2, "0")}`,
        title:
          roomText(
            fullGenerationRecordValue(record, [
              "title",
              "name",
              "标题",
              "方案标题",
            ]),
          ) || `方案 ${planIndex + 1}`,
        premise:
          roomText(
            fullGenerationRecordValue(record, [
              "premise",
              "summary",
              "description",
              "核心取舍",
              "主要因果链",
              "方案概述",
              "核心思路",
            ]),
          ) || fragments.map((fragment) => fragment.summary).join("；"),
        fragments,
      },
    ];
  });
  if (!plans.length) throw new Error(`Agent ${agent} 未返回可用方案片段`);
  return plans;
}

export function parseFullGenerationSuggestion(
  output: string,
  allowedIds: ReadonlySet<string>,
): { readonly fragmentIds: readonly string[]; readonly reason: string } {
  const parsed = extractJson(output);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI 建议未返回对象");
  }
  const record = parsed as Record<string, unknown>;
  const rawIds = Array.isArray(record.fragmentIds)
    ? record.fragmentIds
    : Array.isArray(record.fragments)
      ? record.fragments
      : [];
  const fragmentIds = Array.from(
    new Set(
      rawIds.flatMap((value) => {
        const id = typeof value === "string" ? value.trim() : "";
        return id && allowedIds.has(id) ? [id] : [];
      }),
    ),
  );
  if (!fragmentIds.length) throw new Error("AI 建议没有选中可用片段");
  return {
    fragmentIds,
    reason: roomText(record.reason ?? record.summary),
  };
}

export function orderFullGenerationFragments(
  plans: readonly FullGenerationPlan[],
  selectedIds: ReadonlySet<string>,
  order: readonly string[],
): readonly FullGenerationFragment[] {
  const fragments = plans.flatMap((plan) => plan.fragments);
  const fragmentsById = new Map(
    fragments.map((fragment) => [fragment.id, fragment]),
  );
  const orderedIds = [
    ...order,
    ...fragments
      .map((fragment) => fragment.id)
      .filter((id) => selectedIds.has(id) && !order.includes(id)),
  ];
  const seen = new Set<string>();
  return orderedIds.flatMap((id) => {
    const fragment = fragmentsById.get(id);
    if (!fragment || !selectedIds.has(id) || seen.has(id)) return [];
    seen.add(id);
    return [fragment];
  });
}

type FullGenerationQuickContextCategory =
  | "settings"
  | "timeline"
  | "narrative"
  | "characters"
  | "chapters"
  | "inspirations"
  | "factions";

function FullGenerationContextCheckbox({
  checked,
  mixed = false,
  disabled = false,
  ariaLabel,
  onChange,
}: {
  readonly checked: boolean;
  readonly mixed?: boolean;
  readonly disabled?: boolean;
  readonly ariaLabel: string;
  readonly onChange: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={onChange}
    />
  );
}

function FullGenerationQuickContextDialog({
  catalog,
  selection,
  loading,
  error,
  onChange,
  onClose,
}: {
  readonly catalog: FullGenerationQuickContextCatalog | null;
  readonly selection: FullGenerationQuickContextSelection;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onChange: (selection: FullGenerationQuickContextSelection) => void;
  readonly onClose: () => void;
}) {
  const [activeCategory, setActiveCategory] =
    useState<FullGenerationQuickContextCategory>("settings");
  const [expandedNodes, setExpandedNodes] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        catalog?.settingNodes
          .filter((node) => node.parentId === null)
          .map((node) => node.id) ?? [],
      ),
  );
  const [characterQuery, setCharacterQuery] = useState("");

  useCloseLayer(() => {
    onClose();
    return true;
  }, 246);

  const updateIds = (
    field: FullGenerationQuickContextIdField,
    ids: readonly string[],
  ) => onChange(replaceFullGenerationQuickContextIds(selection, field, ids));
  const toggleId = (field: FullGenerationQuickContextIdField, id: string) =>
    onChange(toggleFullGenerationQuickContextId(selection, field, id));
  const selectedItemCount = countFullGenerationQuickContextItems(selection);
  const categoryCounts: Readonly<
    Record<FullGenerationQuickContextCategory, number>
  > = {
    settings: selection.settingIds.length,
    timeline: selection.includeTimeline ? 1 : 0,
    narrative:
      selection.narrativeLineIds.length +
      selection.narrativeDirectoryIds.length +
      selection.narrativeChapterIds.length,
    characters: selection.characterIds.length,
    chapters: selection.previousChapterCount,
    inspirations: selection.inspirationIds.length,
    factions: selection.factionIds.length,
  };

  const settingRows = useMemo(() => {
    if (!catalog) return [];
    const rows: (
      | {
          readonly kind: "node";
          readonly id: string;
          readonly depth: number;
          readonly name: string;
        }
      | {
          readonly kind: "setting";
          readonly id: string;
          readonly depth: number;
          readonly name: string;
          readonly group: string;
        }
    )[] = [];
    const visit = (parentId: string | null, depth: number) => {
      catalog.settingNodes
        .filter((node) => node.parentId === parentId)
        .sort((left, right) => left.order - right.order)
        .forEach((node) => {
          rows.push({ kind: "node", id: node.id, depth, name: node.name });
          if (!expandedNodes.has(node.id)) return;
          catalog.settings
            .filter((setting) => setting.nodeId === node.id)
            .forEach((setting) =>
              rows.push({
                kind: "setting",
                id: setting.id,
                depth: depth + 1,
                name: setting.name,
                group: setting.group,
              }),
            );
          visit(node.id, depth + 1);
        });
    };
    visit(null, 0);
    return rows;
  }, [catalog, expandedNodes]);

  const filteredCharacters = useMemo(() => {
    if (!catalog) return [];
    const query = characterQuery.trim().toLocaleLowerCase();
    if (!query) return catalog.characters;
    return catalog.characters.filter((character) =>
      [character.name, character.summary, character.id]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [catalog, characterQuery]);

  const choiceList = (
    field: FullGenerationQuickContextIdField,
    items: readonly {
      readonly id: string;
      readonly title: string;
      readonly detail?: string;
    }[],
    emptyText: string,
  ) => {
    const selectedIds = new Set(selection[field]);
    return items.length ? (
      <div className="ms-quick-context-choice-list">
        {items.map((item) => (
          <label key={item.id} className="ms-quick-context-choice-row">
            <FullGenerationContextCheckbox
              checked={selectedIds.has(item.id)}
              ariaLabel={`选择${item.title}`}
              onChange={() => toggleId(field, item.id)}
            />
            <span>
              <strong>{item.title}</strong>
              {item.detail && <small>{item.detail}</small>}
            </span>
          </label>
        ))}
      </div>
    ) : (
      <div className="ms-quick-context-empty">{emptyText}</div>
    );
  };

  const narrativeGroup = (
    title: string,
    field: FullGenerationQuickContextIdField,
    items: readonly {
      readonly id: string;
      readonly title: string;
      readonly detail?: string;
    }[],
  ) => {
    const current = selection[field];
    const allSelected =
      items.length > 0 && items.every((item) => current.includes(item.id));
    const mixed =
      !allSelected && items.some((item) => current.includes(item.id));
    return (
      <section className="ms-quick-context-group">
        <header>
          <FullGenerationContextCheckbox
            checked={allSelected}
            mixed={mixed}
            disabled={!items.length}
            ariaLabel={`全选${title}`}
            onChange={() =>
              updateIds(
                field,
                allSelected
                  ? current.filter(
                      (id) => !items.some((item) => item.id === id),
                    )
                  : Array.from(
                      new Set([...current, ...items.map((item) => item.id)]),
                    ),
              )
            }
          />
          <strong>{title}</strong>
          <span>
            {
              current.filter((id) => items.some((item) => item.id === id))
                .length
            }
            /{items.length}
          </span>
        </header>
        {choiceList(field, items, `暂无${title}资料`)}
      </section>
    );
  };

  const categories: readonly {
    readonly id: FullGenerationQuickContextCategory;
    readonly label: string;
    readonly icon: ReactNode;
  }[] = [
    {
      id: "settings",
      label: "世界架构",
      icon: <Network className="h-4 w-4" />,
    },
    { id: "timeline", label: "时间线", icon: <History className="h-4 w-4" /> },
    {
      id: "narrative",
      label: "剧情工程",
      icon: <GitBranch className="h-4 w-4" />,
    },
    { id: "characters", label: "人物库", icon: <Users className="h-4 w-4" /> },
    { id: "chapters", label: "前文", icon: <BookOpen className="h-4 w-4" /> },
    {
      id: "inspirations",
      label: "灵感",
      icon: <Lightbulb className="h-4 w-4" />,
    },
    {
      id: "factions",
      label: "势力",
      icon: <ShieldCheck className="h-4 w-4" />,
    },
  ];

  return (
    <DraggableDialogFrame
      ariaLabel="选择快速模式资料"
      className="ms-quick-context-dialog"
      overlayClassName="bg-black/20"
      headerClassName="ms-quick-context-header"
      header={
        <div className="ms-quick-context-titlebar">
          <div>
            <strong>选择快速模式资料</strong>
            <span>仅注入作者勾选的正式资料，所有 Agent 共用同一快照</span>
          </div>
          <button
            type="button"
            className="ns-icon-button border-0"
            onClick={onClose}
            aria-label="关闭资料选择"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      {loading && (
        <div className="ms-quick-context-loading">
          <Loader2 className="h-5 w-5 animate-spin" />
          正在读取可选资料目录
        </div>
      )}
      {!loading && error && (
        <div className="ms-quick-context-failure" role="alert">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}
      {!loading && catalog && (
        <div className="ms-quick-context-workspace">
          <nav aria-label="资料分类">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                className={activeCategory === category.id ? "is-active" : ""}
                onClick={() => setActiveCategory(category.id)}
              >
                {category.icon}
                <span>{category.label}</span>
                <b>{categoryCounts[category.id]}</b>
              </button>
            ))}
          </nav>
          <main>
            {catalog.issues.length > 0 && (
              <div className="ms-quick-context-issues" role="status">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>{catalog.issues.join("；")}</span>
              </div>
            )}
            {activeCategory === "settings" && (
              <section className="ms-quick-context-panel">
                <header>
                  <div>
                    <strong>世界架构</strong>
                    <span>勾选层级会包含其下全部资料，也可以只选具体一篇</span>
                  </div>
                  <span>{selection.settingIds.length} 篇已选</span>
                </header>
                <div className="ms-quick-context-tree">
                  {settingRows.length ? (
                    settingRows.map((row) => {
                      if (row.kind === "setting") {
                        return (
                          <label
                            key={`setting-${row.id}`}
                            className="ms-quick-context-tree-row is-setting"
                            style={
                              { "--context-depth": row.depth } as CSSProperties
                            }
                          >
                            <FullGenerationContextCheckbox
                              checked={selection.settingIds.includes(row.id)}
                              ariaLabel={`选择设定${row.name}`}
                              onChange={() => toggleId("settingIds", row.id)}
                            />
                            <FileText className="h-3.5 w-3.5" />
                            <span>
                              <strong>{row.name}</strong>
                              <small>{row.group}</small>
                            </span>
                          </label>
                        );
                      }
                      const settingIds = getFullGenerationSettingIdsForNode(
                        catalog,
                        row.id,
                      );
                      const selectedCount = settingIds.filter((id) =>
                        selection.settingIds.includes(id),
                      ).length;
                      const allSelected =
                        settingIds.length > 0 &&
                        selectedCount === settingIds.length;
                      const hasChildren =
                        catalog.settingNodes.some(
                          (node) => node.parentId === row.id,
                        ) ||
                        catalog.settings.some(
                          (setting) => setting.nodeId === row.id,
                        );
                      return (
                        <div
                          key={`node-${row.id}`}
                          className="ms-quick-context-tree-row is-node"
                          style={
                            { "--context-depth": row.depth } as CSSProperties
                          }
                        >
                          <button
                            type="button"
                            disabled={!hasChildren}
                            onClick={() =>
                              setExpandedNodes((current) => {
                                const next = new Set(current);
                                if (next.has(row.id)) next.delete(row.id);
                                else next.add(row.id);
                                return next;
                              })
                            }
                            aria-label={`${expandedNodes.has(row.id) ? "收起" : "展开"}${row.name}`}
                          >
                            {expandedNodes.has(row.id) ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <FullGenerationContextCheckbox
                            checked={allSelected}
                            mixed={selectedCount > 0 && !allSelected}
                            disabled={!settingIds.length}
                            ariaLabel={`选择${row.name}下全部资料`}
                            onChange={() =>
                              updateIds(
                                "settingIds",
                                allSelected
                                  ? selection.settingIds.filter(
                                      (id) => !settingIds.includes(id),
                                    )
                                  : Array.from(
                                      new Set([
                                        ...selection.settingIds,
                                        ...settingIds,
                                      ]),
                                    ),
                              )
                            }
                          />
                          <Folder className="h-3.5 w-3.5" />
                          <strong>{row.name}</strong>
                          <span>
                            {selectedCount}/{settingIds.length}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="ms-quick-context-empty">
                      暂无世界架构资料
                    </div>
                  )}
                </div>
              </section>
            )}
            {activeCategory === "timeline" && (
              <section className="ms-quick-context-panel">
                <header>
                  <div>
                    <strong>时间线</strong>
                    <span>时间线按完整事实库一次性注入</span>
                  </div>
                </header>
                <label className="ms-quick-context-feature-choice">
                  <FullGenerationContextCheckbox
                    checked={selection.includeTimeline}
                    disabled={!catalog.timeline}
                    ariaLabel="选择完整时间线"
                    onChange={() =>
                      onChange({
                        ...selection,
                        includeTimeline: !selection.includeTimeline,
                      })
                    }
                  />
                  <History className="h-5 w-5" />
                  <span>
                    <strong>完整时间线</strong>
                    <small>
                      {catalog.timeline
                        ? `${catalog.timeline.events.length} 个事件 · ${catalog.timeline.periods.length} 个纪元 · ${catalog.timeline.branches.length} 条分支`
                        : "暂无时间线资料"}
                    </small>
                  </span>
                </label>
              </section>
            )}
            {activeCategory === "narrative" && (
              <section className="ms-quick-context-panel">
                <header>
                  <div>
                    <strong>剧情工程</strong>
                    <span>线路、大纲和章节可以分别多选</span>
                  </div>
                </header>
                <div className="ms-quick-context-groups">
                  {narrativeGroup(
                    "线路",
                    "narrativeLineIds",
                    catalog.narrativeLines.map((line) => ({
                      id: line.id,
                      title: line.title,
                      detail: line.premise || line.content,
                    })),
                  )}
                  {narrativeGroup(
                    "大纲",
                    "narrativeDirectoryIds",
                    catalog.narrativeDirectories.map((directory) => ({
                      id: directory.id,
                      title: directory.title,
                      detail: directory.description,
                    })),
                  )}
                  {narrativeGroup(
                    "章节",
                    "narrativeChapterIds",
                    catalog.narrativeChapters.map((chapter) => ({
                      id: chapter.id,
                      title: chapter.title,
                      detail: `${chapter.sections.length} 节 · ${chapter.description}`,
                    })),
                  )}
                </div>
              </section>
            )}
            {activeCategory === "characters" && (
              <section className="ms-quick-context-panel">
                <header>
                  <div>
                    <strong>人物库</strong>
                    <span>支持搜索并勾选多个具体人物</span>
                  </div>
                  <span>{selection.characterIds.length} 人已选</span>
                </header>
                <label className="ms-quick-context-search">
                  <Search className="h-4 w-4" />
                  <input
                    type="search"
                    value={characterQuery}
                    onChange={(event) => setCharacterQuery(event.target.value)}
                    placeholder="搜索姓名、摘要或 ID"
                    aria-label="搜索人物"
                  />
                </label>
                {choiceList(
                  "characterIds",
                  filteredCharacters.map((character) => ({
                    id: character.id,
                    title: character.name,
                    detail: character.summary || character.id,
                  })),
                  characterQuery ? "没有匹配的人物" : "人物库为空",
                )}
              </section>
            )}
            {activeCategory === "chapters" && (
              <section className="ms-quick-context-panel">
                <header>
                  <div>
                    <strong>前 N 章内容</strong>
                    <span>从当前章向前连续读取，最多 5 章</span>
                  </div>
                </header>
                <div
                  className="ms-quick-context-chapter-count"
                  role="group"
                  aria-label="前文章数"
                >
                  {Array.from(
                    {
                      length: Math.min(5, catalog.previousChapters.length) + 1,
                    },
                    (_, count) => count,
                  ).map((count) => (
                    <button
                      key={count}
                      type="button"
                      className={
                        selection.previousChapterCount === count
                          ? "is-active"
                          : ""
                      }
                      onClick={() =>
                        onChange({ ...selection, previousChapterCount: count })
                      }
                    >
                      {count === 0 ? "不读取" : `前 ${count} 章`}
                    </button>
                  ))}
                </div>
                <div className="ms-quick-context-chapter-list">
                  {selection.previousChapterCount > 0 ? (
                    catalog.previousChapters
                      .slice(-selection.previousChapterCount)
                      .map((chapter) => (
                        <div key={chapter.id}>
                          <BookOpen className="h-3.5 w-3.5" />
                          <span>
                            <strong>
                              第 {chapter.displayNumber} 章 · {chapter.title}
                            </strong>
                            <small>{chapter.words.toLocaleString()} 字</small>
                          </span>
                        </div>
                      ))
                  ) : (
                    <div className="ms-quick-context-empty">
                      本轮不注入前文章节
                    </div>
                  )}
                </div>
              </section>
            )}
            {activeCategory === "inspirations" && (
              <section className="ms-quick-context-panel">
                <header>
                  <div>
                    <strong>灵感</strong>
                    <span>只注入本章确实需要参考的灵感素材</span>
                  </div>
                  <span>{selection.inspirationIds.length} 条已选</span>
                </header>
                {choiceList(
                  "inspirationIds",
                  catalog.inspirations.map((item) => ({
                    id: item.id,
                    title: item.title,
                    detail: item.tags.length
                      ? item.tags.join(" · ")
                      : item.body.slice(0, 120),
                  })),
                  "暂无灵感素材",
                )}
              </section>
            )}
            {activeCategory === "factions" && (
              <section className="ms-quick-context-panel">
                <header>
                  <div>
                    <strong>势力</strong>
                    <span>可以同时选择多个本章相关势力</span>
                  </div>
                  <span>{selection.factionIds.length} 个已选</span>
                </header>
                {choiceList(
                  "factionIds",
                  catalog.factions.map((faction) => ({
                    id: faction.id,
                    title: faction.name,
                    detail: [faction.type, faction.summary]
                      .filter(Boolean)
                      .join(" · "),
                  })),
                  "暂无势力资料",
                )}
              </section>
            )}
          </main>
        </div>
      )}
      <footer className="ms-quick-context-footer">
        <span>
          已选 {selectedItemCount} 项
          {selection.previousChapterCount
            ? `，包含前 ${selection.previousChapterCount} 章`
            : ""}
        </span>
        <button
          type="button"
          className="ns-button is-primary"
          onClick={onClose}
        >
          <Check className="h-3.5 w-3.5" />
          完成选择
        </button>
      </footer>
    </DraggableDialogFrame>
  );
}

function FullGenerationWorkflow({
  storage,
  project,
  open,
  embedded = false,
  agentOnly = false,
  chapter,
  chapterPlan,
  manuscriptContent,
  persistedManuscriptContent,
  initialNotes,
  generationContext,
  targetWordCount,
  onRun,
  onApplyGeneratedText,
  onOpenAiAgent,
  onOpenModelSettings,
  onClose,
  onBusyChange,
}: FullGenerationWorkflowProps) {
  const availableProviders = useWorkbenchAvailableProviders();
  const runModelProviders = useMemo(
    () => availableProviders.filter((provider) => !provider.runtimeBacked),
    [availableProviders],
  );
  const modelRepository = useMemo(
    () => createNovelModelSceneSettingsRepository(storage),
    [storage],
  );
  const [step, setStep] = useState<FullGenerationStep>(1);
  const [agentConfigs, setAgentConfigs] = useState<
    readonly FullGenerationAgentConfig[]
  >(createFullGenerationAgentConfigs);
  const [agentResults, setAgentResults] = useState<
    Readonly<Record<number, FullGenerationAgentResult>>
  >(createFullGenerationAgentResults);
  const [activeAgent, setActiveAgent] = useState(1);
  const [selectedFragments, setSelectedFragments] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [selectedFragmentOrder, setSelectedFragmentOrder] = useState<
    readonly string[]
  >([]);
  const [writerNotes, setWriterNotes] = useState("");
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isStartingGeneration, setIsStartingGeneration] = useState(false);
  const [hasStartedGeneration, setHasStartedGeneration] = useState(false);
  const [isFinalGenerationRetrying, setIsFinalGenerationRetrying] =
    useState(false);
  const [isAdjustingTextLength, setIsAdjustingTextLength] = useState(false);
  const [isApplyingGeneratedText, setIsApplyingGeneratedText] = useState(false);
  const [finalGenerationLiveStatus, setFinalGenerationLiveStatus] =
    useState<WorkbenchAiRunProgress | null>(null);
  const [generatedText, setGeneratedText] = useState("");
  const [generatedSourceContent, setGeneratedSourceContent] = useState("");
  const [generatedPersistedSourceContent, setGeneratedPersistedSourceContent] =
    useState("");
  const [discardGeneratedTextOpen, setDiscardGeneratedTextOpen] =
    useState(false);
  const [suggestionReason, setSuggestionReason] = useState("");
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    FULL_GENERATION_DEFAULT_TIMEOUT_MINUTES,
  );
  const [maxTurns, setMaxTurns] = useState(FULL_GENERATION_DEFAULT_MAX_TURNS);
  const [contextReadMode, setContextReadMode] =
    useState<FullGenerationContextReadMode>("agent");
  const [isContextPanelOpen, setIsContextPanelOpen] = useState(false);
  const [quickContextSelection, setQuickContextSelection] =
    useState<FullGenerationQuickContextSelection>(() =>
      createFullGenerationQuickContextSelection(),
    );
  const [quickContextCatalog, setQuickContextCatalog] =
    useState<FullGenerationQuickContextCatalog | null>(null);
  const [quickContextOpen, setQuickContextOpen] = useState(false);
  const [isLoadingQuickContext, setIsLoadingQuickContext] = useState(false);
  const [isPreparingQuickContext, setIsPreparingQuickContext] = useState(false);
  const [workflowOperationCount, setWorkflowOperationCount] = useState(0);
  const [quickContextError, setQuickContextError] = useState<string | null>(
    null,
  );
  const [chapterTargetWordCountInput, setChapterTargetWordCountInput] =
    useState(() => (targetWordCount ? String(targetWordCount) : ""));
  const [expandedAgentSettings, setExpandedAgentSettings] = useState<
    number | null
  >(1);
  const [isBasePromptOpen, setIsBasePromptOpen] = useState(false);
  const [loadedModelSettings, setLoadedModelSettings] =
    useState<LoadedModelSceneSettings | null>(null);
  const [modelSettingsError, setModelSettingsError] = useState<string | null>(
    null,
  );
  const agentResultRefs = useRef(new Map<number, HTMLElement>());
  const basePromptTriggerRef = useRef<HTMLButtonElement | null>(null);
  const embeddedAgentLaunchStateRef = useRef<
    "idle" | "starting" | "started" | "failed"
  >("idle");
  const activeWorkflowOperationsRef = useRef(0);
  const [isEmbeddedConversationMounted, setIsEmbeddedConversationMounted] =
    useState(false);
  const [embeddedLaunchRevision, setEmbeddedLaunchRevision] = useState(0);
  const embeddedConversationTargetRef = useCallback(
    (element: HTMLDivElement | null) => {
      setIsEmbeddedConversationMounted(Boolean(element));
    },
    [],
  );
  const chapterTargetWordCount = parseChapterWordCount(
    chapterTargetWordCountInput,
  );
  const activeChapterId = chapter?.id;

  const selectedAgents = useMemo(
    () => agentConfigs.filter((config) => config.enabled),
    [agentConfigs],
  );
  const plans = useMemo(
    () =>
      agentConfigs.flatMap((config) => agentResults[config.agent]?.plans ?? []),
    [agentConfigs, agentResults],
  );
  const selectedPlanFragments = orderFullGenerationFragments(
    plans,
    selectedFragments,
    selectedFragmentOrder,
  );
  const visibleAgentConfigs = useMemo(() => {
    return agentConfigs.filter(
      (config) =>
        config.enabled ||
        config.agent === activeAgent ||
        agentResults[config.agent]?.status !== "idle",
    );
  }, [activeAgent, agentConfigs, agentResults]);
  const isGeneratingPlans =
    isPreparingQuickContext ||
    agentConfigs.some((config) => {
      const status = agentResults[config.agent]?.status;
      return (
        status === "running" || status === "retrying" || status === "repairing"
      );
    });
  const runningAgentCount = visibleAgentConfigs.filter((config) => {
    const status = agentResults[config.agent]?.status;
    return (
      status === "running" || status === "retrying" || status === "repairing"
    );
  }).length;
  const readyAgentCount = visibleAgentConfigs.filter(
    (config) => agentResults[config.agent]?.status === "ready",
  ).length;
  const workflowBusy =
    isGeneratingPlans ||
    isSuggesting ||
    isStartingGeneration ||
    isApplyingGeneratedText ||
    workflowOperationCount > 0;

  const beginWorkflowOperation = () => {
    activeWorkflowOperationsRef.current += 1;
    setWorkflowOperationCount((count) => count + 1);
    // 在首个 await 前同步通知宿主，避免外层正文操作抢在 effect 前进入。
    onBusyChange?.(true);
  };

  const endWorkflowOperation = () => {
    activeWorkflowOperationsRef.current = Math.max(
      0,
      activeWorkflowOperationsRef.current - 1,
    );
    setWorkflowOperationCount((count) => Math.max(0, count - 1));
    if (activeWorkflowOperationsRef.current === 0) onBusyChange?.(false);
  };

  useEffect(() => {
    onBusyChange?.(workflowBusy || activeWorkflowOperationsRef.current > 0);
  }, [onBusyChange, workflowBusy]);

  const requestClose = useCallback(() => {
    if (workflowBusy) return;
    if (generatedText.trim()) {
      setDiscardGeneratedTextOpen(true);
      return;
    }
    onClose();
  }, [generatedText, onClose, workflowBusy]);

  useCloseLayer(() => {
    if (!open) return false;
    requestClose();
    return true;
  }, 240);

  useEffect(() => {
    if (!open) return;
    embeddedAgentLaunchStateRef.current = "idle";
    setEmbeddedLaunchRevision(0);
    setStep(agentOnly ? 3 : 1);
    setWriterNotes(initialNotes);
    setSuggestionReason("");
    setWorkflowError(null);
    setAgentConfigs(createFullGenerationAgentConfigs());
    setAgentResults(createFullGenerationAgentResults());
    setActiveAgent(1);
    setSelectedFragments(new Set());
    setSelectedFragmentOrder([]);
    setExpandedAgentSettings(1);
    setIsBasePromptOpen(false);
    setHasStartedGeneration(false);
    setGeneratedText("");
    setGeneratedSourceContent("");
    setGeneratedPersistedSourceContent("");
    setDiscardGeneratedTextOpen(false);
    setIsFinalGenerationRetrying(false);
    setIsAdjustingTextLength(false);
    setIsApplyingGeneratedText(false);
    setFinalGenerationLiveStatus(null);
    setTimeoutMinutes(FULL_GENERATION_DEFAULT_TIMEOUT_MINUTES);
    setMaxTurns(FULL_GENERATION_DEFAULT_MAX_TURNS);
    setContextReadMode("agent");
    setQuickContextSelection(createFullGenerationQuickContextSelection());
    setQuickContextCatalog(null);
    setQuickContextOpen(false);
    setIsLoadingQuickContext(false);
    setIsPreparingQuickContext(false);
    setQuickContextError(null);
    setChapterTargetWordCountInput(
      targetWordCount ? String(targetWordCount) : "",
    );
  }, [agentOnly, open, chapter?.id, initialNotes, targetWordCount]);

  useEffect(() => {
    if (!open || contextReadMode !== "quick" || !activeChapterId) return;
    let cancelled = false;
    setIsLoadingQuickContext(true);
    setQuickContextError(null);
    void loadFullGenerationQuickContextCatalog({
      storage,
      project,
      chapterId: activeChapterId,
    })
      .then((catalog) => {
        if (cancelled) return;
        setQuickContextCatalog(catalog);
        setQuickContextSelection(
          createFullGenerationQuickContextSelection(
            Math.min(3, catalog.previousChapters.length),
          ),
        );
      })
      .catch((cause) => {
        if (cancelled) return;
        setQuickContextCatalog(null);
        setQuickContextError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingQuickContext(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChapterId, contextReadMode, open, project, storage]);

  useEffect(() => {
    setGeneratedText("");
    setGeneratedSourceContent("");
    setGeneratedPersistedSourceContent("");
    setIsFinalGenerationRetrying(false);
    setIsAdjustingTextLength(false);
    setFinalGenerationLiveStatus(null);
  }, [
    chapterTargetWordCountInput,
    selectedFragmentOrder,
    selectedFragments,
    suggestionReason,
    writerNotes,
  ]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadedModelSettings(null);
    setModelSettingsError(null);
    void modelRepository
      .load()
      .then((loaded) => {
        if (cancelled) return;
        setLoadedModelSettings(loaded);
      })
      .catch((cause) => {
        if (cancelled) return;
        setLoadedModelSettings(null);
        setModelSettingsError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [modelRepository, open]);

  useEffect(() => {
    if (
      !open ||
      !chapter ||
      !agentConfigs.length ||
      step !== 3 ||
      !isEmbeddedConversationMounted ||
      embeddedAgentLaunchStateRef.current !== "idle"
    ) {
      return;
    }
    if (!onOpenAiAgent) {
      embeddedAgentLaunchStateRef.current = "failed";
      setWorkflowError("MyAgents Agent Session 当前不可用");
      return;
    }
    if (!chapterTargetWordCount) {
      embeddedAgentLaunchStateRef.current = "failed";
      setWorkflowError(
        `本章目标字数必须是 ${MIN_CHAPTER_WORD_COUNT.toLocaleString()}～${MAX_CHAPTER_WORD_COUNT.toLocaleString()} 的整数。`,
      );
      return;
    }

    embeddedAgentLaunchStateRef.current = "starting";
    setIsStartingGeneration(true);
    setHasStartedGeneration(false);
    setWorkflowError(null);

    void (async () => {
      try {
        let quickContext = "";
        if (contextReadMode === "quick") {
          setIsPreparingQuickContext(true);
          if (!quickContextCatalog) {
            throw new Error(
              quickContextError ??
                (isLoadingQuickContext
                  ? "快速模式资料目录仍在读取，请稍后再试"
                  : "快速模式资料目录尚未就绪"),
            );
          }
          quickContext = await buildFullGenerationQuickContext({
            storage,
            catalog: quickContextCatalog,
            selection: quickContextSelection,
          });
        }
        const runId =
          "full-generation-" +
          Date.now().toString(36) +
          "-" +
          Math.random().toString(36).slice(2, 8);
        await onOpenAiAgent({
          sceneId: "manuscript.generate",
          title: chapter.title + " · 完整生成",
          conversationKey: chapter.id + ".full-generation." + runId,
          runId,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          presentation: "embedded-review",
          embeddedSurfaceId: "novel-full-generation-" + chapter.id,
          companionContext: {
            targetWordCount: String(chapterTargetWordCount),
            chapterNumber: String(chapter.displayNumber),
          },
          initialMessage: buildFullGenerationTextAgentInitialMessage({
            runId,
            chapterId: chapter.id,
            chapterNumber: chapter.displayNumber,
            chapterTitle: chapter.title,
            chapterPlan: formatFullGenerationChapterPlan(chapterPlan),
            targetWordCount: chapterTargetWordCount,
            readMode: contextReadMode,
            selectedFragments: selectedPlanFragments,
            writerNotes,
            suggestionReason,
            quickContext,
          }),
        });
        setHasStartedGeneration(true);
        embeddedAgentLaunchStateRef.current = "started";
      } catch (cause) {
        embeddedAgentLaunchStateRef.current = "failed";
        setWorkflowError(errorText(cause));
      } finally {
        setIsStartingGeneration(false);
        setIsPreparingQuickContext(false);
      }
    })();
  }, [
    agentConfigs.length,
    chapter,
    chapterPlan,
    chapterTargetWordCount,
    contextReadMode,
    embeddedLaunchRevision,
    isEmbeddedConversationMounted,
    isLoadingQuickContext,
    onOpenAiAgent,
    open,
    quickContextCatalog,
    quickContextError,
    quickContextSelection,
    selectedPlanFragments,
    step,
    storage,
    suggestionReason,
    writerNotes,
  ]);

  if (!open || !chapter || !agentConfigs.length) return null;

  const embeddedSurfaceId = "novel-full-generation-" + chapter.id;
  const generatedTextBudget = evaluateFullGenerationTextBudget(
    generatedText,
    chapterTargetWordCount,
  );

  const runWithWorkflowTimeout = (
    request: ManuscriptAiRunRequest,
    onProgress?: (progress: WorkbenchAiRunProgress) => void,
  ) => {
    if (!onRun) return Promise.reject(new Error("AI 当前不可用"));
    const runId = createFullGenerationRunId();
    onProgress?.({
      runId,
      kind: "status",
      message: "正在提交生成任务",
      revision: 0,
    });
    return onRun({
      ...applyFullGenerationRunTimeout(request, timeoutMinutes, maxTurns),
      runId,
      onProgress,
    });
  };

  const updateAgentConfig = (
    agent: number,
    patch: Partial<FullGenerationAgentConfig>,
  ) => {
    setAgentConfigs((current) =>
      current.map((config) =>
        config.agent === agent ? { ...config, ...patch } : config,
      ),
    );
  };

  const updateChapterTargetWordCount = (value: string) => {
    setChapterTargetWordCountInput(value);
    setAgentResults(createFullGenerationAgentResults());
    setSelectedFragments(new Set());
    setSelectedFragmentOrder([]);
    setSuggestionReason("");
    setWorkflowError(null);
  };

  const clearFullGenerationContextResults = () => {
    setAgentResults(createFullGenerationAgentResults());
    setSelectedFragments(new Set());
    setSelectedFragmentOrder([]);
    setSuggestionReason("");
    setHasStartedGeneration(false);
    setGeneratedText("");
    setGeneratedSourceContent("");
    setGeneratedPersistedSourceContent("");
    setWorkflowError(null);
  };

  const updateContextReadMode = (mode: FullGenerationContextReadMode) => {
    if (mode === contextReadMode) {
      if (mode === "quick") setQuickContextOpen(true);
      return;
    }
    setContextReadMode(mode);
    setQuickContextCatalog(null);
    setQuickContextError(null);
    setQuickContextOpen(mode === "quick");
    clearFullGenerationContextResults();
  };

  const updateQuickContextSelection = (
    selection: FullGenerationQuickContextSelection,
  ) => {
    setQuickContextSelection(selection);
    clearFullGenerationContextResults();
  };

  const resolveQuickContextSnapshot = async (): Promise<string> => {
    if (!quickContextCatalog) {
      throw new Error(
        quickContextError ??
          (isLoadingQuickContext
            ? "快速模式资料目录仍在读取，请稍后再试"
            : "快速模式资料目录尚未就绪"),
      );
    }
    const quickContext = await buildFullGenerationQuickContext({
      storage,
      catalog: quickContextCatalog,
      selection: quickContextSelection,
    });
    return quickContext;
  };

  const resolveFullGenerationContext = async (): Promise<string> => {
    if (contextReadMode === "agent") return generationContext;
    const quickContext = await resolveQuickContextSnapshot();
    return [generationContext, quickContext].filter(Boolean).join("\n\n");
  };

  const focusAgentResult = (agent: number) => {
    setActiveAgent(agent);
    window.requestAnimationFrame(() => {
      agentResultRefs.current.get(agent)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  const toggleAgent = (agent: number) => {
    const config = agentConfigs.find((item) => item.agent === agent);
    if (!config) return;
    updateAgentConfig(agent, { enabled: !config.enabled });
    if (config.enabled) {
      setAgentResults((current) => ({
        ...current,
        [agent]: { status: "idle", plans: [] },
      }));
      const discardedIds = new Set(
        (agentResults[agent]?.plans ?? []).flatMap((plan) =>
          plan.fragments.map((fragment) => fragment.id),
        ),
      );
      setSelectedFragments(
        (current) =>
          new Set([...current].filter((id) => !discardedIds.has(id))),
      );
      setSelectedFragmentOrder((current) =>
        current.filter((id) => !discardedIds.has(id)),
      );
    }
  };

  const toggleFragment = (id: string) => {
    const isSelected = selectedFragments.has(id);
    setSelectedFragments((current) => {
      const next = new Set(current);
      if (isSelected) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectedFragmentOrder((order) =>
      isSelected
        ? order.filter((item) => item !== id)
        : order.includes(id)
          ? order
          : [...order, id],
    );
  };

  const moveSelectedFragment = (id: string, offset: -1 | 1) => {
    setSelectedFragmentOrder((current) => {
      const index = current.indexOf(id);
      const nextIndex = index + offset;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const generatePlans = async (requestedAgents = selectedAgents) => {
    if (!onRun || !requestedAgents.length) return;
    if (!chapterTargetWordCount) {
      setWorkflowError(
        `本章目标字数必须是 ${MIN_CHAPTER_WORD_COUNT.toLocaleString()}～${MAX_CHAPTER_WORD_COUNT.toLocaleString()} 的整数。`,
      );
      return;
    }
    beginWorkflowOperation();
    let sharedGenerationContext: string;
    if (contextReadMode === "quick") setIsPreparingQuickContext(true);
    try {
      sharedGenerationContext = await resolveFullGenerationContext();
    } catch (cause) {
      setWorkflowError(errorText(cause));
      endWorkflowOperation();
      return;
    } finally {
      setIsPreparingQuickContext(false);
    }
    setWorkflowError(null);
    setSuggestionReason("");
    const discardedIds = new Set(
      requestedAgents.flatMap((config) =>
        (agentResults[config.agent]?.plans ?? []).flatMap((plan) =>
          plan.fragments.map((fragment) => fragment.id),
        ),
      ),
    );
    setSelectedFragments(
      (current) => new Set([...current].filter((id) => !discardedIds.has(id))),
    );
    setSelectedFragmentOrder((current) =>
      current.filter((id) => !discardedIds.has(id)),
    );
    setAgentResults((current) => {
      const next = { ...current };
      for (const config of requestedAgents) {
        next[config.agent] = { status: "running", plans: [] };
      }
      return next;
    });
    let failedCount = 0;
    await Promise.all(
      requestedAgents.map(async (config) => {
        try {
          const reportAgentProgress = (progress: WorkbenchAiRunProgress) => {
            setAgentResults((current) => ({
              ...current,
              [config.agent]: {
                ...(current[config.agent] ?? { status: "running", plans: [] }),
                liveStatus: progress,
              },
            }));
          };
          const request = buildFullGenerationAgentRunRequest({
            agent: config.agent,
            chapterTitle: chapter.title,
            modelSelection: config.modelSelection,
            readMode: contextReadMode,
            prompt: buildFullGenerationAgentPrompt({
              chapterId: chapter.id,
              chapterNumber: chapter.displayNumber,
              chapterTitle: chapter.title,
              schemeCount: config.schemeCount,
              chapterPlan: formatFullGenerationChapterPlan(chapterPlan),
              generationContext: sharedGenerationContext,
              manuscriptContent,
              targetWordCount: chapterTargetWordCount,
              toneBias: config.toneBias,
              extraPrompt: config.extraPrompt,
            }),
          });
          const output = await runFullGenerationAgentWithRecovery({
            request,
            onRun: (nextRequest) =>
              runWithWorkflowTimeout(nextRequest, reportAgentProgress),
            onRecovery: () => {
              setAgentResults((current) => ({
                ...current,
                [config.agent]: { status: "retrying", plans: [] },
              }));
            },
          });
          let nextPlans: readonly FullGenerationPlan[];
          try {
            nextPlans = parseFullGenerationPlans(
              output,
              config.agent,
              config.schemeCount,
            );
          } catch {
            setAgentResults((current) => ({
              ...current,
              [config.agent]: { status: "repairing", plans: [] },
            }));
            let repairedOutput: string;
            try {
              repairedOutput = await runWithWorkflowTimeout(
                buildFullGenerationPlanRepairRunRequest({
                  request,
                  output,
                  schemeCount: config.schemeCount,
                }),
                reportAgentProgress,
              );
            } catch (repairCause) {
              throw new Error(
                `AI 返回格式无法本地识别，自动整理也未完成：${errorText(repairCause)}`,
              );
            }
            try {
              nextPlans = parseFullGenerationPlans(
                repairedOutput,
                config.agent,
                config.schemeCount,
              );
            } catch (repairParseCause) {
              throw new Error(
                `AI 返回格式整理后仍无法识别：${errorText(repairParseCause)}`,
              );
            }
          }
          setAgentResults((current) => ({
            ...current,
            [config.agent]: { status: "ready", plans: nextPlans },
          }));
        } catch (cause) {
          failedCount += 1;
          setAgentResults((current) => ({
            ...current,
            [config.agent]: {
              status: "error",
              plans: [],
              error: errorText(cause),
            },
          }));
        }
      }),
    );
    if (failedCount > 0) {
      setWorkflowError(
        `${failedCount} 个 Agent 未返回可用方案，请在对应结果区查看错误并重试。`,
      );
    }
    endWorkflowOperation();
  };

  const requestAiSuggestion = async () => {
    if (!onRun || !plans.length || isSuggesting) return;
    beginWorkflowOperation();
    setIsSuggesting(true);
    setWorkflowError(null);
    try {
      const sharedContext = await resolveFullGenerationContext();
      const fragmentCatalog = plans.flatMap((plan) =>
        plan.fragments.map((fragment) =>
          [
            `ID: ${fragment.id}`,
            `Agent: ${plan.agentName}`,
            `方案: ${plan.title}`,
            `片段: ${fragment.title}`,
            `作用: ${fragment.summary}`,
            `内容: ${fragment.content}`,
          ].join("\n"),
        ),
      );
      let output = await runWithWorkflowTimeout({
        sceneId: "manuscript.brainstorm.synthesis",
        label: `${chapter.title} · AI 建议选片`,
        systemPrompt:
          '你是 MyAgents 小说工作台的正文方案综合编辑。只输出 JSON：{"fragmentIds":["片段ID"],"reason":"选择理由"}。从候选中选择一组能够按顺序组成单章、彼此不矛盾且符合章节计划的片段；不要改写 ID，不要使用 Markdown 代码围栏。',
        prompt: [
          `章节：第 ${chapter.displayNumber} 章 · ${chapter.title}`,
          formatFullGenerationChapterPlan(chapterPlan),
          sharedContext,
          `候选片段：\n\n${fragmentCatalog.join("\n\n---\n\n")}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      const allowedIds = new Set(
        plans.flatMap((plan) => plan.fragments.map((fragment) => fragment.id)),
      );
      let suggestion: {
        readonly fragmentIds: readonly string[];
        readonly reason: string;
      };
      try {
        suggestion = parseFullGenerationSuggestion(output, allowedIds);
      } catch {
        output = await runWithWorkflowTimeout(
          buildFullGenerationSuggestionRepairRunRequest({
            output,
            allowedIds: [...allowedIds],
          }),
        );
        suggestion = parseFullGenerationSuggestion(output, allowedIds);
      }
      setSelectedFragments(new Set(suggestion.fragmentIds));
      setSelectedFragmentOrder(suggestion.fragmentIds);
      setSuggestionReason(suggestion.reason);
    } catch (cause) {
      setWorkflowError(errorText(cause));
    } finally {
      setIsSuggesting(false);
      endWorkflowOperation();
    }
  };

  const retryEmbeddedTextGeneration = () => {
    if (embeddedAgentLaunchStateRef.current === "starting") return;
    embeddedAgentLaunchStateRef.current = "idle";
    setWorkflowError(null);
    setEmbeddedLaunchRevision((current) => current + 1);
  };

  const startTextGeneration = async () => {
    if (!onRun || isStartingGeneration || isApplyingGeneratedText) return;
    if (!chapterTargetWordCount) {
      setWorkflowError(
        `本章目标字数必须是 ${MIN_CHAPTER_WORD_COUNT.toLocaleString()}～${MAX_CHAPTER_WORD_COUNT.toLocaleString()} 的整数。`,
      );
      return;
    }
    beginWorkflowOperation();
    setIsStartingGeneration(true);
    setIsFinalGenerationRetrying(false);
    setIsAdjustingTextLength(false);
    setGeneratedText("");
    setGeneratedSourceContent("");
    setGeneratedPersistedSourceContent("");
    setWorkflowError(null);
    const reportFinalGenerationProgress = (progress: WorkbenchAiRunProgress) =>
      setFinalGenerationLiveStatus(progress);
    try {
      const sourceContent = manuscriptContent;
      const persistedSourceContent = persistedManuscriptContent;
      const sharedGenerationContext = await resolveFullGenerationContext();
      const prompt = [
        "作者已在完整生成工作流中确认本章写作方向。",
        `章节：第 ${chapter.displayNumber} 章 · ${chapter.title}`,
        buildWritingWordBudget(
          chapterTargetWordCount,
          "generate",
          countCharacters(sourceContent),
          countCharacters(sourceContent),
        ),
        formatFullGenerationChapterPlan(chapterPlan),
        selectedPlanFragments.length
          ? [
              "按以下顺序整合作者选中的方案片段；它们是写作约束，不是要求逐字照抄的正文：",
              ...selectedPlanFragments.map(
                (fragment, index) =>
                  `${index + 1}. ${fragment.title}\n${fragment.content}`,
              ),
            ].join("\n\n")
          : "作者跳过了方案选择，请直接依据项目事实和章节计划完成正文。",
        writerNotes ? `作者附加建议：\n${writerNotes}` : "",
        suggestionReason ? `AI 选片参考理由：\n${suggestionReason}` : "",
        sharedGenerationContext,
        sourceContent.trim()
          ? `当前章节已有正文（作为事实基线，本次返回完整章节正文）：\n${excerpt(sourceContent, 16000)}`
          : "当前章节正文为空，请从开篇开始生成完整章节。",
      ]
        .filter(Boolean)
        .join("\n\n");
      const request = buildFullGenerationTextRunRequest({
        chapterTitle: chapter.title,
        prompt,
        targetWordCount: chapterTargetWordCount,
        readMode: contextReadMode,
      });
      const output = await runFullGenerationAgentWithRecovery({
        request,
        onRun: (nextRequest) =>
          runWithWorkflowTimeout(nextRequest, reportFinalGenerationProgress),
        onRecovery: () => {
          setIsFinalGenerationRetrying(true);
          setFinalGenerationLiveStatus({
            runId: "",
            kind: "status",
            message: "正在发起无工具收敛重试",
            revision: 0,
          });
        },
      });
      let content = sanitizeFullGenerationTextOutput(output);
      if (!content) throw new Error("正文生成没有返回可用内容");
      let budget = evaluateFullGenerationTextBudget(
        content,
        chapterTargetWordCount,
      );
      if (budget.target && !budget.withinRange) {
        setIsAdjustingTextLength(true);
        try {
          const correctedOutput = await runWithWorkflowTimeout(
            buildFullGenerationTextCorrectionRunRequest({
              request,
              output: content,
              targetWordCount: budget.target,
            }),
            reportFinalGenerationProgress,
          );
          const correctedContent =
            sanitizeFullGenerationTextOutput(correctedOutput);
          if (correctedContent) content = correctedContent;
          budget = evaluateFullGenerationTextBudget(
            content,
            chapterTargetWordCount,
          );
          if (!budget.withinRange) {
            setWorkflowError(
              `已按本章目标自动调整一次，但当前仍为 ${budget.count.toLocaleString()} 字；请编辑到 ${budget.minimum?.toLocaleString()}～${budget.maximum?.toLocaleString()} 字后再采用。`,
            );
          }
        } catch (correctionCause) {
          setWorkflowError(
            `正文已生成，但自动调整到总览字数时失败：${errorText(correctionCause)}。请编辑候选或重新生成。`,
          );
        } finally {
          setIsAdjustingTextLength(false);
        }
      }
      setGeneratedSourceContent(sourceContent);
      setGeneratedPersistedSourceContent(persistedSourceContent);
      setGeneratedText(content);
    } catch (cause) {
      setWorkflowError(errorText(cause));
    } finally {
      setIsStartingGeneration(false);
      setIsFinalGenerationRetrying(false);
      setIsAdjustingTextLength(false);
      setFinalGenerationLiveStatus(null);
      endWorkflowOperation();
    }
  };

  const applyGeneratedText = async () => {
    const content = generatedText.trim();
    if (!content || isApplyingGeneratedText || isStartingGeneration) return;
    const budget = evaluateFullGenerationTextBudget(
      content,
      chapterTargetWordCount,
    );
    if (!budget.withinRange) {
      setWorkflowError(
        `当前正文为 ${budget.count.toLocaleString()} 字，不符合本章设定的 ${budget.minimum?.toLocaleString()}～${budget.maximum?.toLocaleString()} 字范围。`,
      );
      return;
    }
    beginWorkflowOperation();
    setIsApplyingGeneratedText(true);
    setWorkflowError(null);
    try {
      await onApplyGeneratedText(
        content,
        generatedSourceContent,
        generatedPersistedSourceContent,
      );
      onClose();
    } catch (cause) {
      setWorkflowError(errorText(cause));
    } finally {
      setIsApplyingGeneratedText(false);
      endWorkflowOperation();
    }
  };

  const stepLabel = (value: FullGenerationStep) =>
    value === 1 ? "方案" : value === 2 ? "确认" : "生成";

  if (!open) return null;

  const agentSessionStarted = Boolean(onOpenAiAgent) && hasStartedGeneration;

  const workflowStepNavigation = (
    <div className="ms-full-generation-steps" aria-label="生成步骤">
      {([1, 2, 3] as const).map((value) => (
        <button
          key={value}
          type="button"
          className={
            step === value ? "is-active" : step > value ? "is-done" : ""
          }
          onClick={() => setStep(value)}
          disabled={workflowBusy || agentSessionStarted}
          aria-current={step === value ? "step" : undefined}
        >
          <span>
            {step > value ? <Check className="h-3.5 w-3.5" /> : value}
          </span>
          {stepLabel(value)}
        </button>
      ))}
    </div>
  );

  const workflowStepMeta = (
    <div className="ms-full-generation-step-meta">
      {step === 1
        ? "选择 Agent 与方案数量"
        : step === 2
          ? `${selectedFragments.size} 个片段已选`
          : generatedText
            ? "正文候选已生成"
            : "工作台内生成正文"}
    </div>
  );

  const workflowHeader = (
    <div className="ms-full-generation-titlebar">
      <div className="ms-full-generation-title">
        <span>正文完整生成</span>
        <strong>
          第 {chapter?.displayNumber ?? "-"} 章 · {chapter?.title ?? "当前章节"}
        </strong>
      </div>
      {workflowStepNavigation}
      {workflowStepMeta}
      <button
        className="ns-icon-button border-0"
        type="button"
        onClick={requestClose}
        disabled={workflowBusy}
        aria-label="关闭完整生成"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  const workflowContent = (
    <>
      {workflowError && (
        <div className="ms-full-generation-error" role="alert">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>{workflowError}</span>
          <button type="button" onClick={() => setWorkflowError(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {step === 1 && (
        <div className="ms-full-generation-body">
          <aside className="ms-full-generation-config">
            <section className="ms-full-generation-context-section">
              <button
                type="button"
                className="ms-full-generation-context-toggle"
                onClick={() => setIsContextPanelOpen((current) => !current)}
                aria-expanded={isContextPanelOpen}
                aria-controls="full-generation-settings-panel"
              >
                <span>
                  <strong>设置</strong>
                  <small>
                    {timeoutMinutes} 分钟 · {maxTurns} 轮 ·{" "}
                    {chapterTargetWordCount
                      ? `${chapterTargetWordCount.toLocaleString()} 字`
                      : "目标未设置"}
                    {" · "}
                    {contextReadMode === "quick" ? "快速模式" : "自主读取"}
                    {contextReadMode === "quick"
                      ? ` · ${countFullGenerationQuickContextItems(quickContextSelection)} 项`
                      : ""}
                  </small>
                </span>
                <ChevronDown
                  className={isContextPanelOpen ? "is-open" : ""}
                  aria-hidden="true"
                />
              </button>
              {isContextPanelOpen && (
                <div
                  id="full-generation-settings-panel"
                  className="ms-full-generation-context-panel"
                >
                  <section
                    className="ms-full-generation-run-budget"
                    title="应用于本窗口内的方案生成、AI 建议和正文生成"
                  >
                    <header>
                      <strong>运行预算</strong>
                      <span>全流程</span>
                    </header>
                    <div>
                      <label>
                        <span>超时</span>
                        <CustomSelect
                          value={String(timeoutMinutes)}
                          options={FULL_GENERATION_TIMEOUT_OPTIONS}
                          onChange={(value) => setTimeoutMinutes(Number(value))}
                          ariaLabel="完整生成全局超时时间"
                          triggerIcon={<Timer className="h-3.5 w-3.5" />}
                          className="ms-full-generation-run-budget-select"
                          popoverMinWidth={112}
                          compact
                          disabled={
                            isGeneratingPlans ||
                            isSuggesting ||
                            isStartingGeneration ||
                            isApplyingGeneratedText
                          }
                        />
                      </label>
                      <label>
                        <span>轮次</span>
                        <CustomSelect
                          value={String(maxTurns)}
                          options={FULL_GENERATION_MAX_TURNS_OPTIONS}
                          onChange={(value) => setMaxTurns(Number(value))}
                          ariaLabel="完整生成最大轮次"
                          triggerIcon={<RefreshCw className="h-3.5 w-3.5" />}
                          className="ms-full-generation-run-budget-select"
                          popoverMinWidth={112}
                          compact
                          disabled={
                            isGeneratingPlans ||
                            isSuggesting ||
                            isStartingGeneration ||
                            isApplyingGeneratedText
                          }
                        />
                      </label>
                    </div>
                  </section>
                  <div className="ms-full-generation-context">
                    <div className="ms-full-generation-context-overview">
                      <div className="ms-full-generation-context-row">
                        <span>剧情计划</span>
                        <b>
                          {chapterPlan
                            ? `${chapterPlan.sections.length} 个节拍`
                            : "未关联"}
                        </b>
                      </div>
                      <div className="ms-full-generation-target-field">
                        <div className="ms-full-generation-context-row">
                          <span>本章目标</span>
                          <label className="ms-full-generation-word-count-input">
                            <input
                              type="number"
                              min={MIN_CHAPTER_WORD_COUNT}
                              max={MAX_CHAPTER_WORD_COUNT}
                              step={100}
                              inputMode="numeric"
                              value={chapterTargetWordCountInput}
                              onChange={(event) =>
                                updateChapterTargetWordCount(event.target.value)
                              }
                              disabled={
                                isGeneratingPlans ||
                                isSuggesting ||
                                isStartingGeneration ||
                                isApplyingGeneratedText
                              }
                              aria-label="本章目标字数"
                              aria-invalid={chapterTargetWordCount === null}
                            />
                            <i>字</i>
                          </label>
                        </div>
                        <small
                          className={`ms-full-generation-word-count-hint ${chapterTargetWordCount ? "" : "is-error"}`}
                        >
                          {chapterTargetWordCount
                            ? chapterTargetWordCount === targetWordCount
                              ? `默认继承总览；允许 ${Math.ceil(chapterTargetWordCount * 0.9).toLocaleString()}～${Math.floor(chapterTargetWordCount * 1.1).toLocaleString()} 字`
                              : `仅本次生成；总览默认 ${targetWordCount?.toLocaleString() ?? "未设置"} 字`
                            : `请输入 ${MIN_CHAPTER_WORD_COUNT.toLocaleString()}～${MAX_CHAPTER_WORD_COUNT.toLocaleString()} 的整数`}
                        </small>
                      </div>
                    </div>
                    <dl className="ms-full-generation-context-summary">
                      <div>
                        <dt>前文范围</dt>
                        <dd>
                          {contextReadMode === "quick"
                            ? quickContextSelection.previousChapterCount
                              ? `前 ${quickContextSelection.previousChapterCount} 章`
                              : "不读取前文"
                            : "智能体按需判断"}
                        </dd>
                      </div>
                      <div>
                        <dt>资料来源</dt>
                        <dd>
                          {contextReadMode === "quick"
                            ? "人工选择并一次性注入"
                            : "小说只读工具"}
                        </dd>
                      </div>
                      <div>
                        <dt>正文基线</dt>
                        <dd>
                          {Array.from(
                            manuscriptContent,
                          ).length.toLocaleString()}{" "}
                          字
                        </dd>
                      </div>
                    </dl>
                    <div className="ms-full-generation-read-section">
                      <div className="ms-full-generation-context-group-label">
                        <span>读取方式</span>
                        <small>
                          {contextReadMode === "quick"
                            ? "人工预选"
                            : "按需读取"}
                        </small>
                      </div>
                      <div
                        className="ms-full-generation-read-mode"
                        role="group"
                        aria-label="资料读取方式"
                        data-no-dialog-drag
                      >
                        <button
                          type="button"
                          className={
                            contextReadMode === "quick" ? "is-active" : ""
                          }
                          onClick={() => updateContextReadMode("quick")}
                          disabled={
                            isGeneratingPlans ||
                            isSuggesting ||
                            isStartingGeneration ||
                            isApplyingGeneratedText
                          }
                          aria-pressed={contextReadMode === "quick"}
                        >
                          <Database className="h-3.5 w-3.5" />
                          快速模式
                        </button>
                        <button
                          type="button"
                          className={
                            contextReadMode === "agent" ? "is-active" : ""
                          }
                          onClick={() => updateContextReadMode("agent")}
                          disabled={
                            isGeneratingPlans ||
                            isSuggesting ||
                            isStartingGeneration ||
                            isApplyingGeneratedText
                          }
                          aria-pressed={contextReadMode === "agent"}
                        >
                          <Bot className="h-3.5 w-3.5" />
                          智能体自主读取
                        </button>
                      </div>
                      {contextReadMode === "quick" && (
                        <button
                          type="button"
                          className="ms-full-generation-context-picker-trigger"
                          onClick={() => setQuickContextOpen(true)}
                          disabled={
                            isGeneratingPlans ||
                            isSuggesting ||
                            isStartingGeneration ||
                            isApplyingGeneratedText
                          }
                        >
                          {isLoadingQuickContext ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <SlidersHorizontal className="h-3.5 w-3.5" />
                          )}
                          <span>
                            {isLoadingQuickContext
                              ? "正在读取资料目录"
                              : quickContextError
                                ? "资料目录读取失败"
                                : "选择本轮资料"}
                          </span>
                          <b>
                            {countFullGenerationQuickContextItems(
                              quickContextSelection,
                            )}{" "}
                            项
                          </b>
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>
            <section className="ms-full-generation-agent-roster">
              <div className="ms-full-generation-section-heading">
                <div className="ms-full-generation-roster-heading">
                  <strong>Agent 阵容</strong>
                  <span>{selectedAgents.length}/6</span>
                </div>
                <button
                  ref={basePromptTriggerRef}
                  type="button"
                  className="ms-full-generation-base-prompt-trigger"
                  onClick={() => setIsBasePromptOpen((current) => !current)}
                  aria-expanded={isBasePromptOpen}
                  aria-haspopup="dialog"
                >
                  <Eye className="h-3.5 w-3.5" />
                  基础提示词
                </button>
                <Popover
                  open={isBasePromptOpen}
                  onClose={() => setIsBasePromptOpen(false)}
                  anchorRef={basePromptTriggerRef}
                  placement="bottom-start"
                  className="ms-full-generation-base-prompt-popover shadow-md"
                  style={{ minWidth: "300px" }}
                  zIndex={300}
                >
                  <div className="ms-full-generation-base-prompt">
                    <div>
                      <FileText className="h-3.5 w-3.5" />
                      <strong>正文方案 Agent 基础提示词</strong>
                      <span>只读</span>
                    </div>
                    <pre>
                      {buildFullGenerationAgentSystemPrompt(contextReadMode)}
                    </pre>
                  </div>
                </Popover>
              </div>
              <div className="ms-agent-config-list ms-full-generation-agent-list">
                {agentConfigs.map((config) => {
                  const result = agentResults[config.agent] ?? {
                    status: "idle" as const,
                    plans: [],
                  };
                  const toneBias = getFullGenerationToneBias(config.toneBias);
                  const isExpanded = expandedAgentSettings === config.agent;
                  const sceneId =
                    `manuscript.brainstorm.agent${config.agent}` as NovelModelSceneId;
                  const sceneModel = loadedModelSettings
                    ? getEffectiveModelSceneSelection(
                        loadedModelSettings.settings,
                        sceneId,
                      )
                    : undefined;
                  return (
                    <div
                      key={config.agent}
                      className={`ms-agent-config-row ms-full-generation-config-row ${
                        activeAgent === config.agent ? "is-active" : ""
                      } ${config.enabled ? "" : "is-disabled"}`}
                    >
                      <input
                        type="checkbox"
                        checked={config.enabled}
                        onChange={() => {
                          focusAgentResult(config.agent);
                          toggleAgent(config.agent);
                        }}
                        aria-label={`启用 Agent ${config.agent}`}
                      />
                      <span className="ms-agent-index">
                        {String(config.agent).padStart(2, "0")}
                      </span>
                      <button
                        type="button"
                        className="ms-agent-identity"
                        onClick={() => focusAgentResult(config.agent)}
                      >
                        <span className="ms-agent-identity-heading">
                          <strong>
                            Agent {String(config.agent).padStart(2, "0")}
                          </strong>
                          <span
                            className={`ms-full-generation-agent-row-status is-${result.status}`}
                            aria-label={`Agent ${config.agent} ${result.status}`}
                          >
                            {result.status === "running" ||
                            result.status === "retrying" ||
                            result.status === "repairing" ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : result.status === "ready" ? (
                              <CheckCircle2 className="h-3 w-3" />
                            ) : result.status === "error" ? (
                              <AlertTriangle className="h-3 w-3" />
                            ) : (
                              <CircleDot className="h-3 w-3" />
                            )}
                            {result.status === "running"
                              ? "生成中"
                              : result.status === "retrying"
                                ? "收敛重试 1/1"
                                : result.status === "repairing"
                                  ? "整理返回格式"
                                  : result.status === "ready"
                                    ? `${result.plans.length} 个方案`
                                    : result.status === "error"
                                      ? "失败"
                                      : config.enabled
                                        ? "待生成"
                                        : "未启用"}
                          </span>
                        </span>
                        <small>
                          {toneBias.label} ·{" "}
                          {contextReadMode === "quick"
                            ? "使用人工资料快照一次生成"
                            : "自主读取项目资料后生成"}
                        </small>
                      </button>
                      <RoomModelCascadeSelect
                        binding={config.modelSelection}
                        providers={runModelProviders}
                        defaultModel={sceneModel}
                        disabled={
                          !config.enabled ||
                          result.status === "running" ||
                          result.status === "retrying" ||
                          result.status === "repairing"
                        }
                        onChange={(selection) =>
                          updateAgentConfig(config.agent, {
                            modelSelection: selection,
                          })
                        }
                        ariaLabel={`Agent ${config.agent} 本次供应商和模型`}
                        className="ms-full-generation-model-select"
                      />
                      <CustomSelect
                        value={config.toneBias}
                        options={FULL_GENERATION_TONE_OPTIONS}
                        onChange={(value) =>
                          updateAgentConfig(config.agent, {
                            toneBias: value as FullGenerationToneBias,
                          })
                        }
                        disabled={!config.enabled}
                        ariaLabel={`Agent ${config.agent} 内容偏向`}
                        className="ms-full-generation-tone-select"
                        popoverMinWidth={190}
                        compact
                      />
                      <CustomSelect
                        value={String(config.schemeCount)}
                        options={[1, 2, 3].map((count) => ({
                          value: String(count),
                          label: `${count} 个方案`,
                        }))}
                        onChange={(value) =>
                          updateAgentConfig(config.agent, {
                            schemeCount: Number(
                              value,
                            ) as FullGenerationSchemeCount,
                          })
                        }
                        disabled={!config.enabled}
                        ariaLabel={`Agent ${config.agent} 方案数`}
                        className="ms-agent-scheme-select"
                        compact
                      />
                      <button
                        type="button"
                        className="ms-agent-module-button"
                        disabled={!config.enabled}
                        onClick={() => {
                          setActiveAgent(config.agent);
                          setExpandedAgentSettings((current) =>
                            current === config.agent ? null : config.agent,
                          );
                        }}
                        aria-expanded={isExpanded}
                        title="配置该 Agent 的独立提示词"
                      >
                        <span>
                          {isExpanded ? "收起独立提示词设置" : "独立提示词设置"}
                        </span>
                        <span
                          className={`ms-full-generation-prompt-status ${
                            config.extraPrompt.trim() ? "is-configured" : ""
                          }`}
                        >
                          {config.extraPrompt.trim() ? "已设置" : "未设置"}
                        </span>
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </button>
                      {isExpanded && (
                        <div className="ms-full-generation-agent-settings">
                          <textarea
                            value={config.extraPrompt}
                            maxLength={4000}
                            disabled={!config.enabled}
                            onChange={(event) =>
                              updateAgentConfig(config.agent, {
                                extraPrompt: event.target.value,
                              })
                            }
                            aria-label={`Agent ${config.agent} 额外提示词`}
                            placeholder="例如：保留谈判路线，章末必须出现新的时间压力。"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
            <footer className="ms-full-generation-config-actions">
              <div>
                <button
                  type="button"
                  className="ns-button"
                  onClick={onOpenModelSettings}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  配置模型
                </button>
                <button
                  type="button"
                  className="ns-button is-primary"
                  onClick={() => void generatePlans()}
                  disabled={
                    !onRun ||
                    !selectedAgents.length ||
                    !chapterTargetWordCount ||
                    isGeneratingPlans
                  }
                >
                  {isGeneratingPlans ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {isGeneratingPlans
                    ? isPreparingQuickContext
                      ? "正在整理资料"
                      : `${runningAgentCount} 路并行中`
                    : "并行生成"}
                </button>
              </div>
              <small className={modelSettingsError ? "is-error" : undefined}>
                {modelSettingsError
                  ? `未读取到场景默认模型：${modelSettingsError}`
                  : "每个 Agent 的模型与创作设置只随本次方案生成提交。"}
              </small>
            </footer>
          </aside>
          <main className="ms-full-generation-preview">
            <div className="ms-full-generation-results-head">
              <div>
                <span className="ms-eyebrow">并行 Agent 结果</span>
                <strong>
                  {runningAgentCount
                    ? `${runningAgentCount} 个 Agent 正在同时生成`
                    : isPreparingQuickContext
                      ? "正在把人工选择的资料整理为同一上下文快照"
                      : `${readyAgentCount}/${visibleAgentConfigs.length} 个 Agent 已返回 · ${selectedFragments.size} 个片段已选`}
                </strong>
              </div>
              <div className="ms-full-generation-results-actions">
                <button
                  type="button"
                  className="ns-button"
                  onClick={() => void requestAiSuggestion()}
                  disabled={
                    !plans.length || !onRun || isSuggesting || isGeneratingPlans
                  }
                >
                  {isSuggesting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {isSuggesting ? "正在建议" : "AI 建议选片"}
                </button>
              </div>
            </div>
            {suggestionReason && (
              <div className="ms-full-generation-suggestion">
                <Sparkles className="h-3.5 w-3.5" />
                <span>{suggestionReason}</span>
              </div>
            )}
            <div className="ms-full-generation-agent-content">
              {visibleAgentConfigs.map((config) => {
                const result = agentResults[config.agent] ?? {
                  status: "idle" as const,
                  plans: [],
                };
                const toneBias = getFullGenerationToneBias(config.toneBias);
                const selectedCount = result.plans
                  .flatMap((plan) => plan.fragments)
                  .filter((fragment) =>
                    selectedFragments.has(fragment.id),
                  ).length;
                return (
                  <section
                    key={config.agent}
                    id={`full-generation-agent-${config.agent}`}
                    ref={(node) => {
                      if (node) agentResultRefs.current.set(config.agent, node);
                      else agentResultRefs.current.delete(config.agent);
                    }}
                    className={`ms-full-generation-agent-section ${
                      activeAgent === config.agent ? "is-active" : ""
                    }`}
                    aria-labelledby={`full-generation-agent-${config.agent}-title`}
                  >
                    <header className="ms-full-generation-agent-section-head">
                      <button
                        type="button"
                        className="ms-full-generation-agent-section-title"
                        onClick={() => setActiveAgent(config.agent)}
                      >
                        <i>{String(config.agent).padStart(2, "0")}</i>
                        <span>
                          <strong
                            id={`full-generation-agent-${config.agent}-title`}
                          >
                            Agent {String(config.agent).padStart(2, "0")}
                          </strong>
                          <small>
                            {toneBias.label} · {config.schemeCount} 个方案
                          </small>
                        </span>
                      </button>
                      <span
                        className={`ms-full-generation-agent-section-status is-${result.status}`}
                        aria-live="polite"
                      >
                        {result.status === "running" ||
                        result.status === "retrying" ||
                        result.status === "repairing" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : result.status === "ready" ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : result.status === "error" ? (
                          <AlertTriangle className="h-3.5 w-3.5" />
                        ) : (
                          <CircleDot className="h-3.5 w-3.5" />
                        )}
                        {result.status === "running"
                          ? "生成中"
                          : result.status === "retrying"
                            ? "正在收敛重试 1/1"
                            : result.status === "repairing"
                              ? "正在整理返回格式"
                              : result.status === "ready"
                                ? `${result.plans.length} 个方案 · ${selectedCount} 个片段已选`
                                : result.status === "error"
                                  ? "生成失败"
                                  : config.enabled
                                    ? "等待生成"
                                    : "未勾选"}
                      </span>
                    </header>

                    {result.status === "idle" && (
                      <div className="ms-full-generation-agent-placeholder">
                        <FileText className="h-5 w-5" />
                        <div>
                          <strong>尚未生成内容</strong>
                          <p>
                            {config.enabled
                              ? "开始后会在这里显示资料读取状态与详细方案。"
                              : "勾选该 Agent 后可与其他 Agent 同时生成。"}
                          </p>
                        </div>
                        {config.enabled && (
                          <button
                            type="button"
                            className="ns-button"
                            onClick={() => void generatePlans([config])}
                            disabled={
                              !onRun ||
                              !chapterTargetWordCount ||
                              isGeneratingPlans
                            }
                          >
                            <Sparkles className="h-3.5 w-3.5" />
                            单独生成
                          </button>
                        )}
                      </div>
                    )}

                    {(result.status === "running" ||
                      result.status === "retrying" ||
                      result.status === "repairing") && (
                      <div className="ms-full-generation-agent-placeholder is-waiting">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <div>
                          <strong>
                            {result.status === "retrying"
                              ? "达到轮次上限，正在收敛重试 1/1"
                              : result.status === "repairing"
                                ? "方案已返回，正在整理为可选片段"
                                : contextReadMode === "quick"
                                  ? "正在依据人工资料快照构思详细方案"
                                  : "正在自主读取资料并构思详细方案"}
                          </strong>
                          {result.liveStatus && (
                            <FullGenerationLiveStatus
                              progress={result.liveStatus}
                            />
                          )}
                          <p>
                            {result.status === "retrying"
                              ? "本轮不再调用工具，只依据本次请求中已有的章节计划、前文摘要、连续性状态和作者要求直接输出完整方案。"
                              : result.status === "repairing"
                                ? "仅整理已有内容的结构，不会重新生成方案，也不会再次读取项目资料。"
                                : `将按“${toneBias.label}”方向组织 ${config.schemeCount} 个差异方案，每个片段包含完整的场景行动与衔接。`}
                          </p>
                          <div
                            className="ms-full-generation-waiting-steps"
                            aria-label="生成进度"
                          >
                            <span className="is-active">
                              <Check className="h-3 w-3" />
                              {result.status === "running"
                                ? "任务已提交"
                                : "方案已返回"}
                            </span>
                            <span className="is-active">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {result.status === "retrying"
                                ? "收敛重试 1/1"
                                : result.status === "repairing"
                                  ? "整理返回格式"
                                  : contextReadMode === "quick"
                                    ? "一次性生成"
                                    : "读取与构思"}
                            </span>
                            <span>拆分详细片段</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {result.status === "error" && (
                      <div className="ms-full-generation-agent-placeholder is-error">
                        <AlertTriangle className="h-5 w-5" />
                        <div>
                          <strong>本次运行未完成</strong>
                          <p>{result.error ?? "没有返回可用方案，请重试。"}</p>
                        </div>
                        <button
                          type="button"
                          className="ns-button"
                          onClick={() => void generatePlans([config])}
                          disabled={
                            !onRun ||
                            !chapterTargetWordCount ||
                            isGeneratingPlans
                          }
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          重试
                        </button>
                      </div>
                    )}

                    {result.status === "ready" && (
                      <div className="ms-full-generation-plan-grid">
                        {result.plans.map((plan, planIndex) => (
                          <article
                            className="ms-full-generation-plan"
                            key={plan.id}
                          >
                            <header>
                              <span>
                                方案 {planIndex + 1} · {plan.fragments.length}{" "}
                                个片段
                              </span>
                              <strong>{plan.title}</strong>
                              <p>{plan.premise}</p>
                            </header>
                            <div>
                              {plan.fragments.map((fragment, index) => (
                                <button
                                  type="button"
                                  className={
                                    selectedFragments.has(fragment.id)
                                      ? "is-selected"
                                      : ""
                                  }
                                  key={fragment.id}
                                  onClick={() => toggleFragment(fragment.id)}
                                  aria-pressed={selectedFragments.has(
                                    fragment.id,
                                  )}
                                >
                                  <span className="ms-full-generation-fragment-copy">
                                    <span className="ms-full-generation-fragment-title">
                                      <b>{index + 1}</b>
                                      <strong>{fragment.title}</strong>
                                      <em>{fragment.summary}</em>
                                    </span>
                                    <span className="ms-full-generation-fragment-content">
                                      {fragment.content}
                                    </span>
                                  </span>
                                  {selectedFragments.has(fragment.id) ? (
                                    <CheckCircle2 className="h-4 w-4" />
                                  ) : (
                                    <CircleDot className="h-4 w-4" />
                                  )}
                                </button>
                              ))}
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </main>
        </div>
      )}

      {step === 2 && (
        <div className="ms-full-generation-confirm">
          <section className="ms-full-generation-confirm-main">
            <div className="ms-full-generation-section-heading">
              <div>
                <span className="ms-eyebrow">已选片段</span>
                <strong>确认本章拼接顺序</strong>
              </div>
              <span>{selectedFragments.size} 个片段</span>
            </div>
            {suggestionReason && (
              <div className="ms-full-generation-suggestion">
                <Sparkles className="h-3.5 w-3.5" />
                <span>AI 选片建议：{suggestionReason}</span>
              </div>
            )}
            {selectedPlanFragments.length ? (
              <ol className="ms-full-generation-selected-list">
                {selectedPlanFragments.map((fragment, index) => (
                  <li key={fragment.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{fragment.title}</strong>
                      <small>
                        {fragment.source} · {fragment.content}
                      </small>
                    </div>
                    <div className="ms-full-generation-selected-actions">
                      <button
                        type="button"
                        onClick={() => moveSelectedFragment(fragment.id, -1)}
                        disabled={index === 0}
                        title="上移片段"
                        aria-label={`上移${fragment.title}`}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveSelectedFragment(fragment.id, 1)}
                        disabled={index === selectedPlanFragments.length - 1}
                        title="下移片段"
                        aria-label={`下移${fragment.title}`}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleFragment(fragment.id)}
                        title="移除片段"
                        aria-label={`移除${fragment.title}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="ms-full-generation-empty is-compact">
                <FileText className="h-6 w-6" />
                <h3>暂未选择片段</h3>
                <p>可以完全由人工编写补充建议，直接进入正文生成。</p>
              </div>
            )}
            <button
              type="button"
              className="ns-button"
              onClick={() => setStep(1)}
            >
              <ArrowRight className="h-3.5 w-3.5 rotate-180" />
              返回方案选择
            </button>
          </section>
          <aside className="ms-full-generation-notes">
            <span className="ms-eyebrow">作者输入</span>
            <h3>人工补充建议或写作指令</h3>
            <p>
              有片段时补充约束；没有片段时，这里可以完整写下本章的人工写作方向。
            </p>
            <textarea
              value={writerNotes}
              onChange={(event) => setWriterNotes(event.target.value)}
              placeholder="例如：章尾保留灰烬剑痕，但不要揭示幕后人物。"
            />
            <div className="ms-full-generation-note-foot">
              <span>{writerNotes.length} 字</span>
              <button
                type="button"
                className="ns-button"
                onClick={() => setWriterNotes("")}
                disabled={!writerNotes}
              >
                清空
              </button>
            </div>
          </aside>
        </div>
      )}

      {step === 3 && (
        <div className="ms-full-generation-final">
          <section className="ms-full-generation-agent-pane">
            <div
              ref={embeddedConversationTargetRef}
              id={embeddedSurfaceId + "-conversation"}
              className="ms-full-generation-embedded-target"
            >
              {!hasStartedGeneration && (
                <div className="ms-full-generation-embedded-empty">
                  {isStartingGeneration ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : (
                    <Bot className="h-6 w-6" />
                  )}
                  <div>
                    <span className="ms-eyebrow">MyAgents 正文 Agent</span>
                    <strong>
                      {isStartingGeneration
                        ? "正在打开正文会话"
                        : "正在载入正文 Agent"}
                    </strong>
                    <p>
                      {isStartingGeneration
                        ? "正在连接当前项目的 Agent、模型和小说工作台工具。"
                        : contextReadMode === "quick"
                          ? "将作者选择的资料快照一次性带入 Agent 上下文。"
                          : "Agent 会按需读取正文、设定、人物、剧情工程和时间线。"}
                    </p>
                  </div>
                  {workflowError && !isStartingGeneration && (
                    <button
                      type="button"
                      className="ns-button"
                      onClick={retryEmbeddedTextGeneration}
                      disabled={!onOpenAiAgent || !chapterTargetWordCount}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      重新连接 Agent
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
          <section className="ms-full-generation-output">
            <div
              id={embeddedSurfaceId + "-companion"}
              className="ms-full-generation-embedded-output"
            >
              {!hasStartedGeneration && (
                <div className="ms-full-generation-embedded-empty">
                  {isStartingGeneration ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : (
                    <FileText className="h-6 w-6" />
                  )}
                  <div>
                    <span className="ms-eyebrow">正文候选</span>
                    <strong>
                      {isStartingGeneration
                        ? "等待 Agent 建立正文草稿"
                        : "候选将显示在这里"}
                    </strong>
                    <p>
                      Agent 会先读取必要资料，再通过正文草稿协议提交完整候选。
                    </p>
                  </div>
                </div>
              )}
            </div>
            {generatedText ? (
              <>
                <div className="ms-full-generation-output-head">
                  <div>
                    <span className="ms-eyebrow">正文候选</span>
                    <strong>
                      {generatedTextBudget.withinRange
                        ? "已在当前工作流中生成，可直接编辑"
                        : "字数超出总览范围，请编辑后再采用"}
                    </strong>
                  </div>
                  <span
                    className={`ms-full-generation-status ${generatedTextBudget.withinRange ? "is-ready" : "is-error"}`}
                  >
                    {generatedTextBudget.withinRange ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5" />
                    )}
                    {generatedTextBudget.count.toLocaleString()} 字
                    {generatedTextBudget.target
                      ? ` / 目标 ${generatedTextBudget.target.toLocaleString()}`
                      : ""}
                  </span>
                </div>
                <textarea
                  className="ms-full-generation-output-text"
                  value={generatedText}
                  onChange={(event) => setGeneratedText(event.target.value)}
                  aria-label="生成的正文候选"
                />
                <footer>
                  <span>
                    {generatedTextBudget.withinRange
                      ? "采用后写入当前正文草稿，不会自动保存。"
                      : `请编辑到 ${generatedTextBudget.minimum?.toLocaleString()}～${generatedTextBudget.maximum?.toLocaleString()} 字，达到总览范围后才可采用。`}
                  </span>
                  <div className="ms-full-generation-output-actions">
                    <button
                      type="button"
                      className="ns-button"
                      onClick={() => void startTextGeneration()}
                      disabled={isStartingGeneration || isApplyingGeneratedText}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      重新生成
                    </button>
                    <button
                      type="button"
                      className="ns-button is-primary"
                      onClick={() => void applyGeneratedText()}
                      disabled={
                        !generatedText.trim() ||
                        !generatedTextBudget.withinRange ||
                        isStartingGeneration ||
                        isApplyingGeneratedText
                      }
                    >
                      {isApplyingGeneratedText ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      {isApplyingGeneratedText ? "正在写入" : "采用到正文"}
                    </button>
                  </div>
                </footer>
              </>
            ) : (
              <div
                className={`ms-full-generation-empty ${isStartingGeneration ? "is-waiting" : ""}`}
              >
                {isStartingGeneration ? (
                  <Loader2 className="h-7 w-7 animate-spin" />
                ) : (
                  <WandSparkles className="h-7 w-7" />
                )}
                <h3>
                  {isAdjustingTextLength
                    ? "正文已返回，正在按总览字数调整"
                    : isFinalGenerationRetrying
                      ? "上一轮未完成，正在收敛重试 1/1"
                      : isStartingGeneration
                        ? "正在生成完整正文"
                        : agentSessionStarted
                          ? "正文 Agent 已建立审阅会话"
                          : "在当前窗口生成完整正文"}
                </h3>
                {isStartingGeneration && finalGenerationLiveStatus && (
                  <FullGenerationLiveStatus
                    progress={finalGenerationLiveStatus}
                  />
                )}
                <p>
                  {isAdjustingTextLength
                    ? `本章目标为 ${chapterTargetWordCount?.toLocaleString() ?? "未设置"} 字，正在压缩或补足正文并清除检查说明。`
                    : isFinalGenerationRetrying
                      ? "恢复轮不再调用工具，只依据本次请求中已有的章节计划、前文摘要、连续性状态和作者要求直接返回完整正文。"
                      : isStartingGeneration
                        ? contextReadMode === "quick"
                          ? `已一次性注入 ${countFullGenerationQuickContextItems(quickContextSelection)} 项人工资料，正在直接生成正文。`
                          : "正在自主读取必要的设定、人物、剧情工程、时间线与前文，生成结果会直接显示在这里。"
                        : agentSessionStarted
                          ? "Agent 的执行过程与待审候选已保留在左右面板；只能通过提案审阅写回正文。"
                          : contextReadMode === "quick"
                          ? "使用作者选择的同一份资料快照直接生成，结果留在本窗口审阅。"
                          : "复用 MyAgents 当前项目模型和小说只读工具，结果留在本窗口审阅，不再打开新的 Agent 对话。"}
                </p>
                {!isStartingGeneration && (
                  <div className="ms-full-generation-handoff-list">
                    <span>
                      <Check className="h-3.5 w-3.5" /> 复用当前项目模型场景
                    </span>
                    <span>
                      <Check className="h-3.5 w-3.5" />{" "}
                      {contextReadMode === "quick"
                        ? "人工资料一次性注入"
                        : "复用小说工作台只读工具"}
                    </span>
                    <span>
                      <Check className="h-3.5 w-3.5" /> 候选确认后才写入正文
                    </span>
                    <span>
                      <Check className="h-3.5 w-3.5" /> 总览每章字数自动校验
                    </span>
                  </div>
                )}
                {!isStartingGeneration && !agentSessionStarted && (
                  <button
                    type="button"
                    className="ns-button is-primary"
                    onClick={() => void startTextGeneration()}
                    disabled={!onRun || !chapterTargetWordCount || workflowBusy}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {!onRun
                      ? "当前 AI 不可用"
                      : chapterTargetWordCount
                        ? "开始生成正文"
                        : "请先设置本章字数"}
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      <footer className="ms-full-generation-footer">
        <span>
          {step === 1
            ? "方案仅供比较，选择后才会进入正文生成"
            : step === 2
              ? "确认结果也可以完全由人工编写"
              : "正文候选需人工审阅后再写入"}
        </span>
        <div>
          {step === 1 && (
            <button
              type="button"
              className="ns-button"
              onClick={() => setStep(3)}
              disabled={workflowBusy}
            >
              跳过方案与确认
            </button>
          )}
          {step < 3 ? (
            <button
              type="button"
              className="ns-button is-primary"
              onClick={() => setStep((step + 1) as FullGenerationStep)}
              disabled={workflowBusy}
            >
              {step === 1 ? "进入确认" : "确认并进入生成"}
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              className="ns-button"
              onClick={requestClose}
              disabled={workflowBusy}
            >
              稍后处理
            </button>
          )}
        </div>
      </footer>
    </>
  );

  return (
    <>
      {discardGeneratedTextOpen && (
        <ConfirmDialog
          title="放弃生成的正文候选"
          message="当前生成的正文候选尚未写入正文。关闭后将丢弃该候选，且无法恢复。"
          confirmText="放弃候选"
          confirmVariant="danger"
          onConfirm={() => {
            setDiscardGeneratedTextOpen(false);
            onClose();
          }}
          onCancel={() => setDiscardGeneratedTextOpen(false)}
        />
      )}
      {embedded ? (
        <div
          className={`ms-full-generation-embedded ${
            agentOnly ? "is-agent-only" : ""
          }`}
        >
          {!agentOnly && (
            <header className="ms-full-generation-embedded-header">
              <div className="ms-full-generation-titlebar">
                <div className="ms-full-generation-title">
                  <span>正文完整生成</span>
                  <strong>
                    第 {chapter?.displayNumber ?? "-"} 章 ·{" "}
                    {chapter?.title ?? "当前章节"}
                  </strong>
                </div>
                {workflowStepNavigation}
                {workflowStepMeta}
              </div>
            </header>
          )}
          {workflowContent}
        </div>
      ) : (
        <DraggableDialogFrame
          ariaLabel="正文完整生成工作流"
          className="ms-full-generation-dialog"
          overlayClassName="bg-black/40 backdrop-blur-sm"
          headerClassName="ms-full-generation-header"
          header={workflowHeader}
        >
          {workflowContent}
        </DraggableDialogFrame>
      )}
      {quickContextOpen && (
        <FullGenerationQuickContextDialog
          key={quickContextCatalog ? "ready" : "loading"}
          catalog={quickContextCatalog}
          selection={quickContextSelection}
          loading={isLoadingQuickContext}
          error={quickContextError}
          onChange={updateQuickContextSelection}
          onClose={() => setQuickContextOpen(false)}
        />
      )}
    </>
  );
}

export default function ManuscriptStudio({
  storage,
  project,
  selectedChapterId,
  isCreatingChapter,
  onSelectChapter,
  onCreateChapter,
  onUpdateChapter,
  onRenameChapter,
  onLinkChapterToNarrative,
  onCreateDirectory,
  onUpdateDirectory,
  onDeleteDirectory,
  onSetStructureMode,
  onSynchronizeNarrative,
  onSaveTypography,
  onDeleteChapter,
  onRestoreChapter,
  onDeleteChapterPermanently,
  onSaveChapter,
  onLoadManuscriptVersions,
  onLoadManuscriptVersionSettings,
  onSaveManuscriptVersionLimit,
  onRestoreManuscriptVersion,
  onExtractChaptersToNarrative,
  onAiRun,
  onOpenAiAgent,
  onAdoptSimulation,
  onOpenNarrative,
  onOpenModelSettings,
  registerNavigationGuard,
}: ManuscriptStudioProps) {
  const selectedChapter = project.chapters.find(
    (chapter) => chapter.id === selectedChapterId,
  );
  const canonicalChapters = useMemo(
    () =>
      orderManuscriptChapters(
        project.chapterIndex.directories,
        project.chapters,
      ),
    [project.chapterIndex.directories, project.chapters],
  );
  const [view, setView] = useState<StudioView>("write");
  const [inspectorView, setInspectorView] = useState<InspectorView>("plan");
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"tree" | "editor" | "context">(
    "editor",
  );
  const [writingSurface, setWritingSurface] =
    useState<WritingSurface>("chapter");
  const [treeSearch, setTreeSearch] = useState("");
  const [treeFilter, setTreeFilter] = useState<TreeFilter>("all");
  const [draft, setDraft] = useState(selectedChapter?.content ?? "");
  const [savedDraft, setSavedDraft] = useState(selectedChapter?.content ?? "");
  const [titleDraft, setTitleDraft] = useState(selectedChapter?.title ?? "");
  const [displayNumberDraft, setDisplayNumberDraft] = useState(
    String(selectedChapter?.displayNumber ?? 1),
  );
  const [editorMode, setEditorMode] = useState<"edit" | "preview">("edit");
  const [selection, setSelection] = useState<TextSelection>({
    start: 0,
    end: 0,
  });
  const [selectionToolbarPosition, setSelectionToolbarPosition] =
    useState<SelectionToolbarPosition | null>(null);
  const [candidate, setCandidate] = useState<AiCandidate | null>(null);
  const [isApplyingCandidate, setIsApplyingCandidate] = useState(false);
  const [selectionAiLoading, setSelectionAiLoading] =
    useState<SelectionAiLoading | null>(null);
  const [creativeBrief, setCreativeBrief] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const [aiMode, setAiMode] = useState<WritingAiMode | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  // 状态更新会在当前事件结束后才反映到渲染层；写入锁必须先同步生效。
  const operationRef = useRef<string | null>(null);
  const [draggedChapterId, setDraggedChapterId] = useState<string | null>(null);
  const [dragOverDirectoryId, setDragOverDirectoryId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [externalChanged, setExternalChanged] = useState(false);
  const [expandedDirectories, setExpandedDirectories] = useState<
    ReadonlySet<string>
  >(() => new Set(project.chapterIndex.directories.map((item) => item.id)));
  const [activeDirectoryId, setActiveDirectoryId] = useState<string | null>(
    selectedChapter?.directoryId ?? null,
  );
  const [directoryFormOpen, setDirectoryFormOpen] = useState(false);
  const [directoryTitle, setDirectoryTitle] = useState("");
  const [directoryKind, setDirectoryKind] =
    useState<ManuscriptDirectoryKind>("volume");
  const [editingDirectoryId, setEditingDirectoryId] = useState<string | null>(
    null,
  );
  const [editingDirectoryTitle, setEditingDirectoryTitle] = useState("");
  const [typographyDraft, setTypographyDraft] = useState<ManuscriptTypography>(
    project.chapterIndex.typography,
  );
  const [versionSettings, setVersionSettings] =
    useState<ManuscriptVersionSettings | null>(null);
  const [versionLimitDraft, setVersionLimitDraft] = useState("20");
  const [versions, setVersions] = useState<readonly ManuscriptVersionRecord[]>(
    [],
  );
  const [selectedVersion, setSelectedVersion] =
    useState<ManuscriptVersionRecord | null>(null);
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<{
    readonly deletionId: string;
    readonly title: string;
  } | null>(null);
  const [narrativeExtractionOpen, setNarrativeExtractionOpen] = useState(false);
  const [narrativeExtractionChapterIds, setNarrativeExtractionChapterIds] =
    useState<ReadonlySet<string>>(new Set());
  const [narrativeExtractionTargetId, setNarrativeExtractionTargetId] =
    useState("");
  const [narrativeExtractionDrafts, setNarrativeExtractionDrafts] = useState<
    readonly NarrativeExtractionDraft[]
  >([]);
  const [narrativeExtractionBusy, setNarrativeExtractionBusy] = useState(false);
  const [narrativeExtractionDiscardOpen, setNarrativeExtractionDiscardOpen] =
    useState(false);
  const narrativeExtractionSourceHashesRef = useRef<
    ReadonlyMap<string, string>
  >(new Map());
  const [trackingLoaded, setTrackingLoaded] = useState<Awaited<
    ReturnType<ReturnType<typeof createManuscriptTrackingRepository>["load"]>
  > | null>(null);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [qualityReview, setQualityReview] = useState<QualityReview | null>(
    null,
  );
  const [qualityReviewSourceContent, setQualityReviewSourceContent] =
    useState("");
  const [qualityBusy, setQualityBusy] = useState(false);
  const [manifestOpen, setManifestOpen] = useState(false);
  const [brainstormOpen, setBrainstormOpen] = useState(false);
  const [brainstormBusy, setBrainstormBusy] = useState(false);
  const [fullGenerationOpen, setFullGenerationOpen] = useState(false);
  const [fullGenerationBusy, setFullGenerationBusy] = useState(false);
  const [simulationOpen, setSimulationOpen] = useState(false);
  const [simulationBusy, setSimulationBusy] = useState(false);
  const [excludedContextSources, setExcludedContextSources] = useState<
    ReadonlySet<string>
  >(new Set());
  const [syncSelections, setSyncSelections] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentChapterIdRef = useRef(selectedChapter?.id ?? null);
  currentChapterIdRef.current = selectedChapter?.id ?? null;
  const draftRef = useRef(draft);
  const savedDraftRef = useRef(savedDraft);
  draftRef.current = draft;
  savedDraftRef.current = savedDraft;
  const trackingRepository = useMemo(
    () => createManuscriptTrackingRepository(storage),
    [storage],
  );
  const dirty = Boolean(selectedChapter && draft !== savedDraft);
  const manuscriptTaskBusy = Boolean(
    aiMode ||
      trackingBusy ||
      qualityBusy ||
      narrativeExtractionBusy ||
      fullGenerationBusy ||
      isApplyingCandidate ||
      brainstormBusy ||
      simulationBusy,
  );
  const hasPendingNarrativeExtraction = narrativeExtractionDrafts.length > 0;
  const manuscriptAiBusy = Boolean(
    manuscriptTaskBusy || candidate || hasPendingNarrativeExtraction,
  );
  const manuscriptMutationBusy =
    Boolean(operation) || isSaving || manuscriptAiBusy;
  const typographyDirty =
    JSON.stringify(typographyDraft) !==
    JSON.stringify(project.chapterIndex.typography);
  const structureLocked = project.chapterIndex.structureMode === "locked";
  const hydratedChapterIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    setTypographyDraft(project.chapterIndex.typography);
  }, [project.chapterIndex.typography]);

  useEffect(
    () =>
      subscribeWorkbenchHostAction(
        {
          workbenchId: "io.myagents.novel",
          workspacePath: storage.rootPath,
          action: "manuscript-chapter-applied",
        },
        (detail) => {
          const chapterId = detail.payload?.chapterId;
          const content = detail.payload?.content;
          if (
            !chapterId ||
            chapterId !== currentChapterIdRef.current ||
            content === undefined
          ) {
            return;
          }
          if (draftRef.current === savedDraftRef.current) {
            setDraft(content);
            setSavedDraft(content);
            setExternalChanged(false);
          } else if (draftRef.current !== content) {
            setExternalChanged(true);
          }
        },
      ),
    [storage.rootPath],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      onLoadManuscriptVersionSettings(),
      selectedChapter
        ? onLoadManuscriptVersions(selectedChapter.id)
        : Promise.resolve([] as readonly ManuscriptVersionRecord[]),
    ])
      .then(([settings, loadedVersions]) => {
        if (cancelled) return;
        setVersionSettings(settings);
        setVersionLimitDraft(String(settings.maxVersions));
        setVersions(loadedVersions);
        setSelectedVersion((current) =>
          current &&
          loadedVersions.some((item) => item.versionId === current.versionId)
            ? current
            : (loadedVersions[0] ?? null),
        );
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [
    onLoadManuscriptVersionSettings,
    onLoadManuscriptVersions,
    project.chapterIndexContent,
    selectedChapter,
  ]);

  useEffect(() => {
    let cancelled = false;
    void trackingRepository
      .load()
      .then((loaded) => {
        if (!cancelled) setTrackingLoaded(loaded);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [project.chapterIndexContent, trackingRepository]);

  useEffect(() => {
    const chapterId = selectedChapter?.id ?? null;
    if (hydratedChapterIdRef.current === chapterId) return;
    hydratedChapterIdRef.current = chapterId;
    if (!selectedChapter) {
      setDraft("");
      setSavedDraft("");
      setTitleDraft("");
      setDisplayNumberDraft("1");
      setSyncSelections({});
      return;
    }
    setDraft(selectedChapter.content);
    setSavedDraft(selectedChapter.content);
    setTitleDraft(selectedChapter.title);
    setDisplayNumberDraft(String(selectedChapter.displayNumber));
    setSelection({ start: 0, end: 0 });
    setSelectionToolbarPosition(null);
    setCandidate(null);
    setIsApplyingCandidate(false);
    setSelectionAiLoading(null);
    setQualityReview(null);
    setQualityReviewSourceContent("");
    setSyncSelections({});
    setExternalChanged(false);
    setActiveDirectoryId(selectedChapter.directoryId);
  }, [selectedChapter]);

  useEffect(() => {
    if (!selectedChapter || selectedChapter.content === savedDraft) return;
    if (draft === savedDraft) {
      setDraft(selectedChapter.content);
      setSavedDraft(selectedChapter.content);
      setExternalChanged(false);
    } else {
      setExternalChanged(true);
    }
  }, [draft, savedDraft, selectedChapter]);

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    if (!selectedChapter || draft === savedDraft) return true;
    if (isSaving || saveInFlightRef.current) return false;
    saveInFlightRef.current = true;
    setIsSaving(true);
    setError(null);
    try {
      await onSaveChapter(selectedChapter.id, draft, savedDraft);
      setSavedDraft(draft);
      setExternalChanged(false);
      const savedVersions = await onLoadManuscriptVersions(selectedChapter.id);
      setVersions(savedVersions);
      setSelectedVersion(savedVersions[0] ?? null);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      saveInFlightRef.current = false;
      setIsSaving(false);
    }
  }, [
    draft,
    isSaving,
    onLoadManuscriptVersions,
    onSaveChapter,
    savedDraft,
    selectedChapter,
  ]);

  const assertCurrentCandidateSource = useCallback(
    async (
      candidateSourceContent: string,
      candidatePersistedContent: string,
    ) => {
      const chapter = selectedChapter;
      if (!chapter || currentChapterIdRef.current !== chapter.id) {
        throw new Error("当前章节已切换，请重新生成正文候选");
      }
      const persisted = await storage.readText(chapter.path);
      if (currentChapterIdRef.current !== chapter.id) {
        throw new Error("当前章节已切换，请重新生成正文候选");
      }
      if (persisted.content !== candidatePersistedContent) {
        setExternalChanged(true);
      }
      assertManuscriptCandidateSourceSnapshot({
        currentDraftContent: draftRef.current,
        currentPersistedContent: persisted.content,
        candidateSourceContent,
        candidatePersistedContent,
      });
    },
    [selectedChapter, storage],
  );

  const ensureCurrentDraftMatchesDisk = useCallback(
    async (action: string): Promise<string> => {
      const chapter = selectedChapter;
      if (!chapter || currentChapterIdRef.current !== chapter.id) {
        throw new Error("当前章节已切换，请重新发起操作");
      }
      const persisted = await storage.readText(chapter.path);
      if (currentChapterIdRef.current !== chapter.id) {
        throw new Error("当前章节已切换，请重新发起操作");
      }
      if (persisted.content !== draftRef.current) {
        setExternalChanged(true);
        throw new Error(`磁盘正文已变化，请先载入磁盘版本再${action}`);
      }
      return persisted.content;
    },
    [selectedChapter, storage],
  );

  const reloadCurrentChapterFromDisk = useCallback(async () => {
    const chapter = selectedChapter;
    if (!chapter || isApplyingCandidate) return;
    if (candidate || hasPendingNarrativeExtraction) {
      setError("请先采用或放弃当前 AI 候选，再载入磁盘正文");
      return;
    }
    const chapterId = chapter.id;
    try {
      const persisted = await storage.readText(chapter.path);
      if (currentChapterIdRef.current !== chapterId) return;
      draftRef.current = persisted.content;
      savedDraftRef.current = persisted.content;
      setDraft(persisted.content);
      setSavedDraft(persisted.content);
      setCandidate(null);
      setSelection({ start: 0, end: 0 });
      setSelectionToolbarPosition(null);
      setQualityReview(null);
      setQualityReviewSourceContent("");
      setNarrativeExtractionDrafts([]);
      narrativeExtractionSourceHashesRef.current = new Map();
      setExternalChanged(false);
      setError(null);
    } catch (cause) {
      setError(`无法载入磁盘正文：${errorText(cause)}`);
    }
  }, [candidate, hasPendingNarrativeExtraction, isApplyingCandidate, selectedChapter, storage]);

  const saveAll = useCallback(async () => {
    const saved = await saveCurrent();
    if (!saved) return false;
    if (typographyDirty) {
      try {
        await onSaveTypography(typographyDraft);
      } catch (cause) {
        setError(errorText(cause));
        return false;
      }
    }
    return true;
  }, [onSaveTypography, saveCurrent, typographyDirty, typographyDraft]);

  const saveBeforeNavigation = useCallback(async () => {
    if (candidate || isApplyingCandidate) {
      throw new Error(
        "存在尚未处理的 AI 候选，请先采用或放弃候选后再离开正文。",
      );
    }
    if (hasPendingNarrativeExtraction) {
      throw new Error(
        "存在尚未处理的正文提炼候选，请先写入或放弃候选后再离开正文。",
      );
    }
    return saveAll();
  }, [
    candidate,
    hasPendingNarrativeExtraction,
    isApplyingCandidate,
    saveAll,
  ]);

  const exportManuscript = useCallback(async () => {
    if (!(await saveAll())) return;
    setError(null);
    try {
      // 从磁盘重新加载，确保导出内容包含刚保存的草稿
      const latest = await createNovelRepository(storage).load();
      const markdown = buildManuscriptExportMarkdown(latest);
      downloadTextFile(
        `${sanitizeExportFileName(latest.metadata.title)}-整稿.md`,
        markdown,
      );
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [saveAll, storage]);

  const requestChapter = async (chapterId: string) => {
    if (chapterId === selectedChapter?.id) return;
    if (candidate || isApplyingCandidate) {
      setError("请先采用或放弃当前 AI 候选，再切换章节");
      return;
    }
    if (
      manuscriptMutationBusy ||
      operationRef.current ||
      saveInFlightRef.current
    ) {
      setError("当前正文操作尚未完成，请等待保存、结构更新或 AI 任务结束后再切换章节");
      return;
    }
    if (!(await saveCurrent())) return;
    const target = project.chapters.find((chapter) => chapter.id === chapterId);
    if (target?.status === "planned" && target.narrativeChapterId) {
      let activated = false;
      await runManuscriptMutation("activate-planned-chapter", async () => {
        await onUpdateChapter(chapterId, { status: "draft" });
        activated = true;
      });
      if (!activated) return;
    }
    onSelectChapter(chapterId);
  };

  const rejectManuscriptMutationWhileAiBusy = (): boolean => {
    if (!manuscriptAiBusy) return false;
    setError("正在处理 AI 任务或存在待处理候选，请完成处理后再修改正文结构或章节元数据");
    return true;
  };

  const rejectManuscriptAiWhileMutationBusy = (): boolean => {
    if (
      !operationRef.current &&
      !operation &&
      !saveInFlightRef.current &&
      !isSaving
    )
      return false;
    setError("正在保存或更新正文结构，请等待当前操作完成后再启动 AI 功能");
    return true;
  };

  const commitTitle = async () => {
    if (!selectedChapter) return;
    if (rejectManuscriptMutationWhileAiBusy()) {
      setTitleDraft(selectedChapter.title);
      return;
    }
    const title = titleDraft.trim();
    if (!title) {
      setTitleDraft(selectedChapter.title);
      return;
    }
    if (title === selectedChapter.title) return;
    await runManuscriptMutation("rename-chapter", async () => {
      try {
        await onRenameChapter(selectedChapter.id, title);
      } catch (cause) {
        setTitleDraft(selectedChapter.title);
        throw cause;
      }
    });
  };

  const commitDisplayNumber = async () => {
    if (!selectedChapter) return;
    if (rejectManuscriptMutationWhileAiBusy()) {
      setDisplayNumberDraft(String(selectedChapter.displayNumber));
      return;
    }
    const displayNumber = Number(displayNumberDraft);
    if (!Number.isInteger(displayNumber) || displayNumber < 1) {
      setDisplayNumberDraft(String(selectedChapter.displayNumber));
      setError("章节编号必须是正整数");
      return;
    }
    if (displayNumber === selectedChapter.displayNumber) return;
    await runManuscriptMutation("chapter-display-number", async () => {
      try {
        await onUpdateChapter(selectedChapter.id, { displayNumber });
      } catch (cause) {
        setDisplayNumberDraft(String(selectedChapter.displayNumber));
        throw cause;
      }
    });
  };

  const runOperation = async (name: string, task: () => Promise<void>) => {
    if (operationRef.current) return;
    operationRef.current = name;
    setOperation(name);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      operationRef.current = null;
      setOperation((current) => (current === name ? null : current));
    }
  };

  const runManuscriptMutation = async (
    name: string,
    task: () => Promise<void>,
  ) => {
    if (rejectManuscriptMutationWhileAiBusy()) return;
    await runOperation(name, task);
  };

  const commitTrackingUpdate = async (
    before: NonNullable<typeof trackingLoaded>,
    next: NonNullable<typeof trackingLoaded>,
    chapterId: string,
    patch: UpdateNovelChapterInput,
  ): Promise<void> => {
    setTrackingLoaded(next);
    try {
      await onUpdateChapter(chapterId, patch);
    } catch (error) {
      try {
        const rolledBack = await trackingRepository.replaceLedger(
          next,
          before.ledger,
        );
        setTrackingLoaded(rolledBack);
      } catch (recoveryError) {
        throw new Error(
          `${errorText(error)}；状态账本补偿失败：${errorText(recoveryError)}`,
        );
      }
      throw error;
    }
  };

  const createChapter = async () => {
    await runManuscriptMutation("create-chapter", async () => {
      if (!(await saveCurrent())) return;
      const id = await onCreateChapter({ directoryId: activeDirectoryId });
      onSelectChapter(id);
    });
  };

  const createDirectory = async () => {
    if (rejectManuscriptMutationWhileAiBusy()) return;
    const title = directoryTitle.trim();
    if (!title) return;
    await runManuscriptMutation("create-directory", async () => {
      const id = await onCreateDirectory(
        activeDirectoryId,
        directoryKind,
        title,
      );
      setExpandedDirectories((current) => new Set([...current, id]));
      setActiveDirectoryId(id);
      setDirectoryTitle("");
      setDirectoryFormOpen(false);
    });
  };

  const saveDirectoryTitle = async (directoryId: string) => {
    if (rejectManuscriptMutationWhileAiBusy()) return;
    const title = editingDirectoryTitle.trim();
    if (!title) return;
    await runManuscriptMutation("rename-directory", async () => {
      await onUpdateDirectory(directoryId, { title });
      setEditingDirectoryId(null);
    });
  };

  const moveChapter = async (direction: -1 | 1) => {
    if (
      !selectedChapter ||
      structureLocked ||
      rejectManuscriptMutationWhileAiBusy()
    )
      return;
    const siblings = project.chapters
      .filter((chapter) => chapter.directoryId === selectedChapter.directoryId)
      .sort((left, right) => left.order - right.order);
    const position = siblings.findIndex(
      (chapter) => chapter.id === selectedChapter.id,
    );
    const target = position + direction;
    if (position < 0 || target < 0 || target >= siblings.length) return;
    await runManuscriptMutation("reorder-chapter", () =>
      onUpdateChapter(selectedChapter.id, { order: target }),
    );
  };

  const isDirectoryDescendant = (
    candidateId: string,
    ancestorId: string,
  ): boolean => {
    const visited = new Set<string>();
    let cursor = project.chapterIndex.directories.find(
      (directory) => directory.id === candidateId,
    );
    while (cursor?.parentId && !visited.has(cursor.id)) {
      if (cursor.parentId === ancestorId) return true;
      visited.add(cursor.id);
      cursor = project.chapterIndex.directories.find(
        (directory) => directory.id === cursor?.parentId,
      );
    }
    return false;
  };

  const moveDirectory = async (
    directory: ManuscriptDirectory,
    direction: -1 | 1,
  ) => {
    if (structureLocked || rejectManuscriptMutationWhileAiBusy()) return;
    const siblings = project.chapterIndex.directories
      .filter((item) => item.parentId === directory.parentId)
      .sort((left, right) => left.order - right.order);
    const position = siblings.findIndex((item) => item.id === directory.id);
    const target = position + direction;
    if (position < 0 || target < 0 || target >= siblings.length) return;
    await runManuscriptMutation("reorder-directory", () =>
      onUpdateDirectory(directory.id, { order: target }),
    );
  };

  const moveChapterTo = async (
    chapterId: string,
    directoryId: string,
    order?: number,
  ) => {
    if (
      structureLocked ||
      chapterId === "" ||
      rejectManuscriptMutationWhileAiBusy()
    )
      return;
    await runManuscriptMutation("move-chapter", () =>
      onUpdateChapter(chapterId, {
        directoryId,
        ...(order === undefined ? {} : { order }),
      }),
    );
    setDraggedChapterId(null);
    setDragOverDirectoryId(null);
  };

  const deleteDirectory = async (directoryId: string) => {
    await runManuscriptMutation("delete-directory", () =>
      onDeleteDirectory(directoryId),
    );
  };

  const toggleStructureMode = async () => {
    await runManuscriptMutation("structure-mode", () =>
      onSetStructureMode(structureLocked ? "merged" : "locked"),
    );
  };

  const synchronizeNarrative = async () => {
    if (rejectManuscriptMutationWhileAiBusy()) return;
    await runManuscriptMutation("sync", async () => {
      if (!(await saveCurrent())) return;
      await onSynchronizeNarrative();
    });
  };

  const selectedPlan = selectedChapter?.narrativeChapterId
    ? project.narrative.library.chapters.find(
        (plan) => plan.id === selectedChapter.narrativeChapterId,
      )
    : undefined;

  const openNarrativeExtraction = () => {
    if (
      !selectedChapter ||
      rejectManuscriptMutationWhileAiBusy() ||
      rejectManuscriptAiWhileMutationBusy()
    )
      return;
    setNarrativeExtractionChapterIds(new Set([selectedChapter.id]));
    setNarrativeExtractionTargetId(selectedPlan?.id ?? "");
    setNarrativeExtractionDrafts([]);
    narrativeExtractionSourceHashesRef.current = new Map();
    setNarrativeExtractionOpen(true);
  };

  const runNarrativeExtraction = async () => {
    if (!onAiRun || narrativeExtractionBusy) return;
    if (rejectManuscriptAiWhileMutationBusy()) return;
    if (hasPendingNarrativeExtraction) {
      setError("请先写入或放弃当前正文提炼候选，再重新提炼");
      return;
    }
    if (
      aiMode ||
      trackingBusy ||
      qualityBusy ||
      candidate ||
      isApplyingCandidate
    ) {
      setError("请等待当前 AI 任务完成后再提炼正文");
      return;
    }
    const sourceChapters = canonicalChapters.filter((chapter) =>
      narrativeExtractionChapterIds.has(chapter.id),
    );
    if (!sourceChapters.length) {
      setError("请至少选择一章正文");
      return;
    }
    setNarrativeExtractionBusy(true);
    setError(null);
    try {
      if (!(await saveCurrent())) return;
      const requestChapterId = selectedChapter?.id ?? null;
      if (currentChapterIdRef.current !== requestChapterId) {
        throw new Error("当前章节已切换，请重新运行正文提炼");
      }
      const persistedSourceChapters = await Promise.all(
        sourceChapters.map(async (chapter) => ({
          ...chapter,
          content: (await storage.readText(chapter.path)).content,
        })),
      );
      const persistedCurrentChapter = persistedSourceChapters.find(
        (chapter) => chapter.id === requestChapterId,
      );
      if (
        persistedCurrentChapter &&
        persistedCurrentChapter.content !== draftRef.current
      ) {
        setExternalChanged(true);
        throw new Error("磁盘正文已变化，请先载入磁盘版本再提炼剧情工程");
      }
      const sourceHashes = new Map(
        persistedSourceChapters.map((chapter) => [
          chapter.id,
          hashManuscriptContent(chapter.content),
        ]),
      );
      const output = await onAiRun({
        sceneId: "manuscript.outlineExtract",
        label: `正文提炼剧情工程 · ${sourceChapters.length} 章`,
        systemPrompt:
          '你是长篇小说剧情工程编辑。正文是唯一事实来源，不得用既有大纲覆盖正文事实。只输出 JSON：{"chapters":[{"sourceChapterId":"正文稳定ID","title":"剧情章节标题","description":"本章实际发生的剧情概要、主线支线、情绪目标、爽点和未解悬念","sections":[{"title":"场景标题","description":"该场景实际推进、人物动作和结果"}]}]}。每个输入章节必须恰好输出一项；不得编造正文中不存在的剧情、人物状态、物品或伏笔。',
        prompt: [
          "任务：将以下已写正文提炼为剧情工程章节。",
          "已有大纲仅作对照，不是事实来源；正文与大纲冲突时，以正文为准。",
          selectedPlan
            ? `当前关联计划（仅供对照）：${selectedPlan.title}\n${selectedPlan.description}`
            : "当前正文未关联章节计划。",
          ...persistedSourceChapters.map(
            (chapter) =>
              `正文稳定ID：${chapter.id}\n章节：第 ${chapter.displayNumber} 章 · ${chapter.title}\n正文：\n${chapter.content}`,
          ),
        ].join("\n\n"),
      });
      if (currentChapterIdRef.current !== requestChapterId) {
        throw new Error("当前章节已切换，已丢弃旧的正文提炼结果");
      }
      const changedDuringExtraction = (
        await Promise.all(
          persistedSourceChapters.map(async (chapter) => {
            const currentContent = (await storage.readText(chapter.path)).content;
            return currentContent === chapter.content ? null : chapter.id;
          }),
        )
      ).find((chapterId): chapterId is string => chapterId !== null);
      if (changedDuringExtraction) {
        if (changedDuringExtraction === requestChapterId) {
          setExternalChanged(true);
        }
        narrativeExtractionSourceHashesRef.current = new Map();
        setNarrativeExtractionDrafts([]);
        throw new Error(
          "正文在提炼期间发生变化，已丢弃旧结果，请重新运行提炼",
        );
      }
      narrativeExtractionSourceHashesRef.current = sourceHashes;
      setNarrativeExtractionDrafts(
        parseNarrativeExtraction(output, persistedSourceChapters),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setNarrativeExtractionBusy(false);
    }
  };

  const applyNarrativeExtraction = async () => {
    if (
      narrativeExtractionBusy ||
      !narrativeExtractionDrafts.length ||
      rejectManuscriptAiWhileMutationBusy()
    )
      return;
    const selectedIds = new Set(narrativeExtractionChapterIds);
    const draftIds = new Set(
      narrativeExtractionDrafts.map((draft) => draft.chapterId),
    );
    const invalidDraft = narrativeExtractionDrafts.find(
      (draft) =>
        !selectedIds.has(draft.chapterId) ||
        !draft.title.trim() ||
        !draft.description.trim(),
    );
    if (invalidDraft || draftIds.size !== narrativeExtractionDrafts.length) {
      setError("请为每个已选章节填写唯一的标题和剧情概要");
      return;
    }
    const isSingleChapter = narrativeExtractionDrafts.length === 1;
    const targetExists =
      !isSingleChapter ||
      !narrativeExtractionTargetId ||
      project.narrative.library.chapters.some(
        (chapter) => chapter.id === narrativeExtractionTargetId,
      );
    if (!targetExists) {
      setError("写入位置已失效，请重新选择剧情章节");
      return;
    }
    const currentHashes = narrativeExtractionSourceHashesRef.current;
    if (
      narrativeExtractionDrafts.some(
        (draft) => !currentHashes.has(draft.chapterId),
      )
    ) {
      setError("提炼结果缺少正文来源版本，请重新运行提炼");
      return;
    }
    const changedChapter = [...currentHashes.entries()].find(
      ([chapterId, sourceHash]) => {
        const chapter = canonicalChapters.find((item) => item.id === chapterId);
        const content =
          chapterId === currentChapterIdRef.current
            ? draftRef.current
            : chapter?.content;
        return !content || hashManuscriptContent(content) !== sourceHash;
      },
    );
    if (changedChapter) {
      setError("正文在提炼结果生成后发生变化，请重新运行提炼");
      return;
    }
    try {
      const persistedChangedChapter = (
        await Promise.all(
          [...currentHashes.entries()].map(async ([chapterId, sourceHash]) => {
            const chapter = canonicalChapters.find(
              (item) => item.id === chapterId,
            );
            if (!chapter) return chapterId;
            const content = (await storage.readText(chapter.path)).content;
            return hashManuscriptContent(content) === sourceHash
              ? null
              : chapterId;
          }),
        )
      ).find((chapterId): chapterId is string => chapterId !== null);
      if (persistedChangedChapter) {
        if (persistedChangedChapter === currentChapterIdRef.current) {
          setExternalChanged(true);
        }
        setError("磁盘正文在提炼结果生成后发生变化，请重新运行提炼");
        return;
      }
    } catch (cause) {
      setError(`无法校验提炼正文来源：${errorText(cause)}`);
      return;
    }
    const targetNarrativeChapterId = isSingleChapter
      ? narrativeExtractionTargetId || null
      : null;
    setNarrativeExtractionBusy(true);
    setError(null);
    try {
      await onExtractChaptersToNarrative({
        extractions: narrativeExtractionDrafts.map((draft) => ({
          chapterId: draft.chapterId,
          sourceContentHash: currentHashes.get(draft.chapterId) ?? "",
          targetNarrativeChapterId,
          title: draft.title,
          description: draft.description,
          sections: draft.sections,
        })),
      });
      setNarrativeExtractionOpen(false);
      setNarrativeExtractionDrafts([]);
      narrativeExtractionSourceHashesRef.current = new Map();
      setInspectorView("plan");
      setMobileInspectorOpen(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setNarrativeExtractionBusy(false);
    }
  };

  const requestCloseNarrativeExtraction = () => {
    if (narrativeExtractionBusy) return;
    if (hasPendingNarrativeExtraction) {
      setNarrativeExtractionDiscardOpen(true);
      return;
    }
    setNarrativeExtractionOpen(false);
  };

  const discardNarrativeExtraction = () => {
    setNarrativeExtractionDiscardOpen(false);
    setNarrativeExtractionDrafts([]);
    narrativeExtractionSourceHashesRef.current = new Map();
    setNarrativeExtractionOpen(false);
  };

  const contextManifest = useMemo<readonly ContextManifestSource[]>(() => {
    if (!selectedChapter) return [];
    const currentPosition = canonicalChapters.findIndex(
      (chapter) => chapter.id === selectedChapter.id,
    );
    const previous = canonicalChapters.slice(
      Math.max(0, currentPosition - 3),
      Math.max(0, currentPosition),
    );
    const continuityChanges =
      trackingLoaded?.ledger.batches
        .filter((batch) => batch.status === "applied")
        .flatMap((batch) => batch.changes)
        .slice(0, 24) ?? [];
    const sources: ContextManifestSource[] = [
      {
        id: "rules",
        title: "正文写作协议与安全规则",
        detail: "候选优先、事实不越界、不得直接覆盖正文",
        characters: 380,
        required: true,
      },
      {
        id: "plan",
        title: "当前章节计划与场景节拍",
        detail: selectedPlan
          ? `${selectedPlan.title} · ${selectedPlan.sections.length} 个场景 · ${PLANNING_MODE_LABELS[selectedChapter.planningMode]}`
          : "当前正文未关联剧情章节计划",
        characters:
          (selectedPlan?.description.length ?? 0) +
          (selectedPlan?.sections.reduce(
            (sum, section) => sum + section.description.length,
            0,
          ) ?? 0),
        required: true,
      },
      {
        id: "continuity",
        title: "连续性状态账本",
        detail: `${continuityChanges.length} 项已应用人物、关系、物品与规则状态`,
        characters: continuityChanges.reduce(
          (sum, change) => sum + change.after.length + change.evidence.length,
          0,
        ),
        required: false,
      },
      {
        id: "previous",
        title: "前 3 章正文尾段",
        detail: previous.length
          ? previous.map((chapter) => chapter.title).join("、")
          : "没有可用前文章节",
        characters: previous.reduce(
          (sum, chapter) => sum + Math.min(chapter.content.length, 1200),
          0,
        ),
        required: false,
      },
      {
        id: "narrative-links",
        title: "剧情线路、故事弧与期待动作",
        detail: selectedPlan
          ? `${selectedPlan.lineIds.length} 条线路 · ${selectedPlan.arcIds.length} 个故事弧`
          : "未关联",
        characters:
          (selectedPlan?.lineIds.length ?? 0) * 80 +
          (selectedPlan?.arcIds.length ?? 0) * 80,
        required: false,
      },
    ];
    return sources;
  }, [canonicalChapters, selectedChapter, selectedPlan, trackingLoaded]);

  const buildOptionalContext = (): string => {
    if (!selectedChapter) return "";
    const chunks: string[] = [];
    if (!excludedContextSources.has("previous")) {
      const currentPosition = canonicalChapters.findIndex(
        (chapter) => chapter.id === selectedChapter.id,
      );
      const previous = canonicalChapters.slice(
        Math.max(0, currentPosition - 3),
        Math.max(0, currentPosition),
      );
      if (previous.length) {
        chunks.push(
          `前文衔接：\n${previous
            .map(
              (chapter) =>
                `${chapter.title}：${excerpt(chapter.content.slice(-1200), 500)}`,
            )
            .join("\n")}`,
        );
      }
    }
    if (!excludedContextSources.has("continuity")) {
      const changes =
        trackingLoaded?.ledger.batches
          .filter((batch) => batch.status === "applied")
          .flatMap((batch) => batch.changes)
          .slice(0, 24) ?? [];
      if (changes.length) {
        chunks.push(
          `当前连续性状态：\n${changes.map((change) => `- ${change.title}：${change.after}`).join("\n")}`,
        );
      }
    }
    return chunks.join("\n\n");
  };

  const updateTextSelection = (textarea: HTMLTextAreaElement) => {
    const nextSelection = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
    setSelection(nextSelection);
    setSelectionToolbarPosition(
      nextSelection.end > nextSelection.start
        ? getTextareaSelectionAnchor(textarea, nextSelection.end)
        : null,
    );
  };

  const runWritingAi = async (
    mode: WritingAiMode,
    instruction = "",
    options: { readonly quickSelection?: boolean } = {},
  ) => {
    const quickSelection =
      options.quickSelection === true ||
      (selection.end > selection.start &&
        (mode === "revise" || mode === "expand"));
    if (
      !selectedChapter ||
      (quickSelection ? !onAiRun : !onOpenAiAgent && !onAiRun) ||
      manuscriptAiBusy
    ) {
      return;
    }
    if (rejectManuscriptAiWhileMutationBusy()) return;
    const quickSelectionAnchor = quickSelection
      ? (selectionToolbarPosition ??
        (textareaRef.current
          ? getTextareaSelectionAnchor(textareaRef.current, selection.end)
          : null))
      : null;
    if (quickSelectionAnchor) {
      setSelectionAiLoading({ mode, anchor: quickSelectionAnchor });
      setSelectionToolbarPosition(null);
    }
    const actionLabel = {
      generate: "完整生成",
      continue: "续写",
      revise: "润色",
      expand: "扩写",
    }[mode];
    setAiMode(mode);
    setError(null);
    try {
      if (dirty && !(await saveCurrent())) return;
      const requestChapterId = selectedChapter.id;
      const sourceContent = await ensureCurrentDraftMatchesDisk(actionLabel);
      if (currentChapterIdRef.current !== requestChapterId) return;
      const hasSelection = selection.end > selection.start;
      const target = hasSelection
        ? sourceContent.slice(selection.start, selection.end)
        : sourceContent;
      const range =
        mode === "continue"
          ? {
              start: selection.end || sourceContent.length,
              end: selection.end || sourceContent.length,
            }
          : mode === "generate"
            ? { start: 0, end: sourceContent.length }
            : hasSelection
              ? selection
              : { start: 0, end: sourceContent.length };
      const sceneId = `manuscript.${mode}` as NovelModelSceneId;
      const planGuidance = selectedPlan
        ? selectedChapter.planningMode === "detached"
          ? `关联章节计划（仅作对照，本章已脱纲）：${selectedPlan.title}\n${selectedPlan.description}`
          : `关联章节计划（参考）：${selectedPlan.title}\n${selectedPlan.description}`
        : "关联章节计划：无，当前为自由正文";
      const planningRule =
        selectedChapter.planningMode === "detached"
          ? "正文事实和作者指令优先；章节计划仅用于对照，不得以计划否定已写正文。"
          : "参考章节计划与正文事实；正文事实和作者指令优先于计划。";
      const writingWordBudget = buildWritingWordBudget(
        project.metadata.chapterWordCount,
        mode,
        countCharacters(sourceContent),
        countCharacters(target),
      );
      const runId = `manuscript-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      if (onOpenAiAgent && !quickSelection) {
        await onOpenAiAgent({
          sceneId,
          title: `${selectedChapter.title} · ${actionLabel}`,
          conversationKey: `${selectedChapter.id}.${mode}.${runId}`,
          runId,
          chapterId: selectedChapter.id,
          chapterTitle: selectedChapter.title,
          initialMessage: [
            "你是 MyAgents 小说工作台的正文写作 Agent。",
            `本次任务：${actionLabel}`,
            `runId：${runId}`,
            `章节 ID：${selectedChapter.id}`,
            `章节标题：${selectedChapter.title}`,
            `处理模式：${mode}`,
            `处理范围：${range.start}..${range.end}`,
            planGuidance,
            writingWordBudget,
            creativeBrief ? `作者选定的创作指令：${creativeBrief}` : "",
            instruction ? `本次专项要求：${instruction}` : "",
            target ? `作者当前选中的文本：\n${target}` : "",
            `执行规则：
1. 必须先调用 novel_manuscript_get_context，传 chapterId=${selectedChapter.id}，取得当前章节全文与 sourceHash；不得猜测正文。
2. 根据实际需要调用人物、时间线、物品、势力、世界架构、剧情工程、修炼体系和连续性只读工具；只读取完成本次写作所需的上下文，不要机械遍历。
3. 使用 novel_manuscript_create_draft 创建草稿，runId 必须为 ${runId}，chapterId 必须为 ${selectedChapter.id}，mode 必须为 ${mode}，rangeStart/rangeEnd 必须为 ${range.start}/${range.end}，baseSourceHash 使用第一步返回值。
4. 使用 novel_manuscript_upsert_candidate 小块写入候选；首次调用替换 candidate，后续保持同一 candidateId 并传 append=true 追加，单次不要超过工具限制。候选只包含处理范围的替换或插入文本，不要解释，不要 Markdown 代码围栏。
5. 依次调用 novel_manuscript_validate_draft、novel_manuscript_submit_draft 和 novel_manuscript_get_proposal_status。工具只会提交候选，不能直接改正文。
6. ${planningRule} 严格遵守世界设定和连续性状态；保留人物声口，避免模板腔和机械工整感。sourceHash 冲突时停止本次提案并说明正文已变化；可继续使用原始命令和文件工具读取素材，但不得把绕过提案协议的文件修改冒充为正文候选。`,
            mode === "expand"
              ? selectedChapter.planningMode === "detached"
                ? "扩写重点：补足动作、感官、对话和因果；只要不违背正文事实和作者指令，可以突破原计划。"
                : "扩写重点：补足动作、感官、对话和因果，优先保持计划边界。"
              : "",
            mode === "revise"
              ? "润色重点：保留事实、情节与人物声口，提升节奏和自然度。"
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
        return;
      }
      if (!onAiRun) return;
      const output = await onAiRun({
        sceneId,
        label: `${selectedChapter.title} · ${actionLabel}`,
        systemPrompt: `你是中文长篇小说正文编辑。${planningRule} 严格遵守已有设定、正文事实和用户指定的字数范围；只输出可直接写入正文的文本，不解释过程，不使用 Markdown 代码围栏。`,
        prompt: [
          `动作：${actionLabel}`,
          `章节：${selectedChapter.title}`,
          quickSelection
            ? "执行方式：选区快速处理。只返回选中文本的替换内容，不要打开对话或解释。"
            : "",
          planGuidance,
          writingWordBudget,
          creativeBrief ? `作者选定的创作指令：${creativeBrief}` : "",
          instruction ? `本次专项要求：${instruction}` : "",
          buildOptionalContext(),
          mode === "continue"
            ? `已有正文：\n${sourceContent}`
            : `待处理文本：\n${target || "（空）"}`,
          mode === "expand"
            ? selectedChapter.planningMode === "detached"
              ? "扩展细节、动作、感官和对话；正文事实优先，可按作者指令突破原计划。"
              : "扩展细节、动作、感官和对话，优先保持计划边界。"
            : "",
          mode === "revise"
            ? "保留事实、情节和人物声口，消除模板腔与机械工整感。"
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      if (currentChapterIdRef.current !== requestChapterId) return;
      const latestPersistedContent = (
        await storage.readText(selectedChapter.path)
      ).content;
      if (currentChapterIdRef.current !== requestChapterId) return;
      if (latestPersistedContent !== sourceContent) {
        setExternalChanged(true);
      }
      assertManuscriptCandidateSourceSnapshot({
        currentDraftContent: draftRef.current,
        currentPersistedContent: latestPersistedContent,
        candidateSourceContent: sourceContent,
        candidatePersistedContent: sourceContent,
      });
      setCandidate({
        mode,
        ...range,
        content: stripCodeFence(output),
        sourceContent,
        persistedSourceContent: sourceContent,
        quickSelection,
        anchor: quickSelection ? quickSelectionAnchor : null,
      });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setAiMode(null);
      if (quickSelection) setSelectionAiLoading(null);
    }
  };

  const applyCandidate = async (contentOverride?: string) => {
    const currentCandidate = candidate;
    if (!currentCandidate || isApplyingCandidate) return;
    setIsApplyingCandidate(true);
    setError(null);
    try {
      await assertCurrentCandidateSource(
        currentCandidate.sourceContent,
        currentCandidate.persistedSourceContent,
      );
      const sourceContent = currentCandidate.sourceContent;
      const spacer =
        currentCandidate.mode === "continue" &&
        currentCandidate.start > 0 &&
        !sourceContent.endsWith("\n")
          ? "\n\n"
          : "";
      const nextContent = contentOverride ?? currentCandidate.content;
      const next = `${sourceContent.slice(0, currentCandidate.start)}${spacer}${nextContent}${sourceContent.slice(currentCandidate.end)}`;
      setDraft(next);
      setCandidate(null);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setIsApplyingCandidate(false);
    }
  };

  const runTracking = async () => {
    if (rejectManuscriptAiWhileMutationBusy()) return false;
    if (!trackingLoaded) {
      setError("连续性账本正在载入，请稍后再分析当前章节");
      return false;
    }
    if (
      !selectedChapter ||
      !onAiRun ||
      trackingBusy ||
      qualityBusy ||
      aiMode ||
      narrativeExtractionBusy ||
      candidate ||
      isApplyingCandidate
    )
      return false;
    const requestChapterId = selectedChapter.id;
    const sourceContent = draftRef.current;
    if (!(await saveCurrent())) return false;
    if (currentChapterIdRef.current !== requestChapterId) return false;
    let persistedSourceContent: string;
    try {
      persistedSourceContent = (await storage.readText(selectedChapter.path))
        .content;
    } catch (cause) {
      setError(`无法读取连续性分析正文：${errorText(cause)}`);
      return false;
    }
    if (
      persistedSourceContent !== sourceContent ||
      draftRef.current !== sourceContent
    ) {
      setExternalChanged(true);
      setError("正文在连续性分析开始前已经变化，请先保存后重新分析");
      return false;
    }
    const sourceHash = hashManuscriptContent(persistedSourceContent);
    const trackingStateBeforeRun = {
      trackingStatus: selectedChapter.trackingStatus,
      lastTrackedAt: selectedChapter.lastTrackedAt,
    };
    setTrackingBusy(true);
    setError(null);
    try {
      await onUpdateChapter(requestChapterId, { trackingStatus: "pending" });
    } catch (cause) {
      setTrackingBusy(false);
      setError(errorText(cause));
      return false;
    }
    try {
      const [characters, items, locations, factions, timeline] =
        await Promise.all([
          createNovelCharacterLibraryRepository(storage).load(),
          createNovelItemLibraryRepository(storage).load(),
          createNovelLocationLibraryRepository(storage).load(),
          createNovelFactionLibraryRepository(storage).load(),
          createNovelTimelineLibraryRepository(storage).load(),
        ]);
      const entityCatalog = {
        characters: characters.index.characters.map((character) => ({
          id: character.id,
          name: character.name,
        })),
        items: items.index.items.map((item) => ({
          id: item.id,
          name: item.name,
        })),
        locations: locations.index.locations.map((location) => ({
          id: location.id,
          name: location.name,
        })),
        factions: factions.library.factions.map((faction) => ({
          id: faction.id,
          name: faction.name,
        })),
        foreshadowings: timeline.library.events.flatMap((event) =>
          event.foreshadowings.map((foreshadowing) => ({
            id: foreshadowing.id,
            title: foreshadowing.title,
            status: foreshadowing.status,
            eventId: event.id,
          })),
        ),
      };
      const output = await onAiRun({
        sceneId: "manuscript.continuity",
        label: `${selectedChapter.title} · 连续性同步`,
        systemPrompt: `你是小说连续性状态抽取器。只提取正文明确发生的事实，每一项必须带正文中的逐字证据和可执行 operation。只能引用目录中存在的稳定 ID；找不到稳定 ID 的人物、地点、势力变化不要输出。只输出 JSON：{"summary":"","changes":[{"domain":"timeline|character-appearance|character-state|relationship|inventory|location|faction|foreshadow|world-rule|continuity","entityId":null,"title":"","before":null,"after":"","evidence":"正文逐字引文","operation":{"kind":"对应操作"}}]}。operation 规则：timeline 使用 {kind:"timeline-event",eventKind:"event|turning-point|battle|discovery|foreshadowing|backstory",timeLabel:""}；人物出场使用 {kind:"character-appearance"}；人物状态使用 {kind:"character-field",field:"status|currentRealm|goals|motivation|hometown"}；关系使用 {kind:"relationship",targetCharacterId:"稳定ID",relationType:"",tone:"positive|negative|neutral"}；物品使用 {kind:"inventory",itemId:null或稳定ID,name:"",quantity:1,unit:""}；地点使用 {kind:"location-field",field:"status|appearanceNote|summary",status:null或"planned|appeared|archived"}；势力使用 {kind:"faction-field",field:"status|summary|governance|military|economy|publicSupport|territorialIntegrity",status:null或"active|neutral|declining|dissolved"}；新伏笔使用 {kind:"foreshadow",foreshadowingId:null,status:"planted",payoffEventId:null}；回收或废弃伏笔必须引用目录里的伏笔 ID，使用 {kind:"foreshadow",foreshadowingId:"稳定ID",status:"paid-off|abandoned",payoffEventId:null}，回收事件由系统自动关联当前章节；世界规则和承接事项使用 {kind:"continuity-fact",key:"英文或拼音稳定短键"}。`,
        prompt: `章节：${selectedChapter.title}\n\n章节计划：${selectedPlan?.description ?? "未关联"}\n\n可引用实体目录：\n${JSON.stringify(entityCatalog, null, 2)}\n\n正文：\n${persistedSourceContent}`,
      });
      if (currentChapterIdRef.current !== requestChapterId) {
        try {
          await onUpdateChapter(requestChapterId, trackingStateBeforeRun);
        } catch (cause) {
          setError(
            `连续性分析结果已丢弃，但无法复位章节状态：${errorText(cause)}`,
          );
        }
        return false;
      }
      if (draftRef.current !== sourceContent) {
        await onUpdateChapter(requestChapterId, { trackingStatus: "stale" });
        setError("正文在连续性分析期间发生变化，旧结果已丢弃，请重新分析");
        return false;
      }
      const latestPersistedContent = (
        await storage.readText(selectedChapter.path)
      ).content;
      if (hashManuscriptContent(latestPersistedContent) !== sourceHash) {
        setExternalChanged(true);
        await onUpdateChapter(requestChapterId, { trackingStatus: "stale" });
        setError("磁盘正文在连续性分析期间发生变化，旧结果已丢弃，请重新分析");
        return false;
      }
      const proposal = parseTrackingProposal(output);
      if (!proposal.changes.length) {
        await onUpdateChapter(requestChapterId, {
          trackingStatus: "synced",
          lastTrackedAt: new Date().toISOString(),
        });
        return true;
      }
      const before = trackingLoaded;
      const next = await trackingRepository.createProposal(before, {
        chapterId: requestChapterId,
        chapterContentHash: sourceHash,
        summary: proposal.summary,
        changes: proposal.changes,
      });
      await commitTrackingUpdate(before, next, requestChapterId, {
        trackingStatus: "review",
      });
      return true;
    } catch (cause) {
      let message = errorText(cause);
      try {
        await onUpdateChapter(requestChapterId, {
          trackingStatus: "failed",
        });
      } catch (statusCause) {
        message = `${message}；无法记录同步失败状态：${errorText(statusCause)}`;
      }
      if (currentChapterIdRef.current === requestChapterId) {
        setError(message);
      }
      return false;
    } finally {
      setTrackingBusy(false);
    }
  };

  const runQualityReview = async () => {
    if (rejectManuscriptAiWhileMutationBusy()) return;
    if (
      !selectedChapter ||
      !onAiRun ||
      qualityBusy ||
      trackingBusy ||
      aiMode ||
      narrativeExtractionBusy ||
      candidate ||
      isApplyingCandidate
    )
      return;
    const requestChapterId = selectedChapter.id;
    setQualityBusy(true);
    setError(null);
    setQualityReview(null);
    setQualityReviewSourceContent("");
    try {
      if (!(await saveCurrent())) return;
      if (currentChapterIdRef.current !== requestChapterId) return;
      const reviewedContent = await ensureCurrentDraftMatchesDisk("质量审查");
      const output = await onAiRun({
        sceneId: "manuscript.quality",
        label: `${selectedChapter.title} · 正文质量检查`,
        systemPrompt:
          '你是中文长篇小说质量编辑。只输出 JSON：{"score":0,"summary":"","issues":[{"category":"计划|连续性|人物|节奏|文风|钩子","severity":"error|warning|suggestion","title":"","detail":"","evidence":"正文逐字引文","suggestion":""}],"passed":[""]}。必须以正文证据为准，不虚构设定。',
        prompt: [
          `章节：${selectedChapter.title}`,
          selectedPlan
            ? selectedChapter.planningMode === "detached"
              ? `章节计划（仅作对照，本章已脱纲）：${selectedPlan.description}`
              : `章节计划：${selectedPlan.description}`
            : "章节计划：未关联",
          selectedChapter.planningMode === "detached"
            ? "审查规则：正文事实优先。计划偏离仅作为建议，除非造成设定或连续性冲突，不得判为错误。"
            : "",
          selectedPlan?.sections.length
            ? `场景节拍：${selectedPlan.sections.map((section) => `${section.title}：${section.description}`).join("；")}`
            : "",
          buildOptionalContext(),
          `正文：\n${reviewedContent || "（空）"}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      if (currentChapterIdRef.current !== requestChapterId) return;
      if (draftRef.current !== reviewedContent) {
        setError("正文在质量审查期间发生变化，旧结果已丢弃，请重新检查");
        return;
      }
      const latestPersistedContent = (
        await storage.readText(selectedChapter.path)
      ).content;
      if (latestPersistedContent !== reviewedContent) {
        setExternalChanged(true);
        setError("磁盘正文在质量审查期间发生变化，旧结果已丢弃，请重新检查");
        return;
      }
      setQualityReview(parseQualityReview(output));
      setQualityReviewSourceContent(reviewedContent);
      setInspectorView("quality");
      setMobileInspectorOpen(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setQualityBusy(false);
    }
  };

  const focusEvidence = (evidence: string) => {
    if (!evidence.trim()) {
      setError("该项没有可定位的正文证据");
      return false;
    }
    const start = draft.indexOf(evidence);
    if (start < 0) {
      setError("正文已变化，未找到该项证据，请重新运行检查或同步");
      return false;
    }
    const end = start + evidence.length;
    setWritingSurface("chapter");
    setEditorMode("edit");
    setSelection({ start, end });
    setMobilePane("editor");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(start, end);
    });
    return true;
  };

  const markSelectionAsForeshadow = async () => {
    if (!trackingLoaded) {
      setError("连续性账本正在载入，请稍后再标记伏笔证据");
      return;
    }
    if (!selectedChapter || selection.end <= selection.start) return;
    if (rejectManuscriptMutationWhileAiBusy()) return;
    if (!(await saveCurrent())) return;
    const evidence = draft.slice(selection.start, selection.end).trim();
    if (!evidence) return;
    await runManuscriptMutation("foreshadow-evidence", async () => {
      const before = trackingLoaded;
      const next = await trackingRepository.createProposal(before, {
        chapterId: selectedChapter.id,
        chapterContentHash: hashManuscriptContent(draft),
        summary: "作者标记的伏笔证据",
        changes: [
          {
            domain: "foreshadow",
            entityId: null,
            title: excerpt(evidence, 28),
            before: null,
            after: "作为待确认的伏笔证据写入连续性账本",
            evidence,
            operation: {
              kind: "foreshadow",
              foreshadowingId: null,
              status: "planted",
              payoffEventId: null,
            },
          },
        ],
      });
      await commitTrackingUpdate(before, next, selectedChapter.id, {
        trackingStatus: "review",
      });
      setInspectorView("sync");
      setMobileInspectorOpen(true);
    });
  };

  const setTrackingBatchStatus = async (
    batch: ManuscriptTrackingBatch,
    status: ManuscriptTrackingBatch["status"],
  ) => {
    if (!selectedChapter || !trackingLoaded) return;
    await runManuscriptMutation("tracking-status", async () => {
      const before = trackingLoaded;
      const next = await trackingRepository.setBatchStatus(
        before,
        batch.id,
        status,
      );
      const chapterBatches = next.ledger.batches.filter(
        (item) => item.chapterId === selectedChapter.id,
      );
      const trackingStatus = chapterBatches.some(
        (item) => item.status === "proposed",
      )
        ? "review"
        : chapterBatches.some((item) => item.status === "applied")
          ? "synced"
          : "idle";
      await commitTrackingUpdate(before, next, selectedChapter.id, {
        trackingStatus,
        lastTrackedAt:
          status === "applied"
            ? new Date().toISOString()
            : selectedChapter.lastTrackedAt,
      });
    });
  };

  const applyTrackingSelection = async (batch: ManuscriptTrackingBatch) => {
    if (!selectedChapter || !trackingLoaded) return;
    const selectedIds =
      syncSelections[batch.id] ?? batch.changes.map((change) => change.id);
    await runManuscriptMutation("tracking-selection", async () => {
      const before = trackingLoaded;
      const next = await trackingRepository.applyBatchSelection(
        before,
        batch.id,
        selectedIds,
      );
      await commitTrackingUpdate(before, next, selectedChapter.id, {
        trackingStatus: "synced",
        lastTrackedAt: new Date().toISOString(),
      });
    });
  };

  const changeChapterStatus = async (status: NovelChapterStatus) => {
    if (!selectedChapter) return;
    const previousStatus = selectedChapter.status;
    const shouldTrack =
      status === "complete" && selectedChapter.trackingStatus !== "synced";
    if (shouldTrack && !draft.trim()) {
      setError("空白章节不能标记为已完成");
      return;
    }
    if (shouldTrack && !onAiRun) {
      setError("当前没有可用模型，无法完成章节状态同步");
      return;
    }
    if (shouldTrack && !trackingLoaded) {
      setError("连续性账本正在载入，请稍后再标记章节完成");
      return;
    }

    // 先提交状态变更并释放结构写入锁，再启动连续性分析。否则
    // runTracking 会把它所属的外层 chapter-status 操作误判为并发写入，
    // 导致“标记完成”永远无法进入同步流程。
    let statusUpdated = false;
    await runManuscriptMutation("chapter-status", async () => {
      await onUpdateChapter(selectedChapter.id, { status });
      statusUpdated = true;
    });
    if (!statusUpdated || !shouldTrack) return;

    setView("tracking");
    setInspectorView("sync");
    setMobileInspectorOpen(true);
    const tracked = await runTracking();
    if (!tracked && currentChapterIdRef.current === selectedChapter.id) {
      await runManuscriptMutation("chapter-status-rollback", () =>
        onUpdateChapter(selectedChapter.id, {
          status: previousStatus,
          trackingStatus: "failed",
        }),
      );
    }
  };

  const chapterBatches =
    trackingLoaded?.ledger.batches.filter(
      (batch) => batch.chapterId === selectedChapter?.id,
    ) ?? [];
  const appliedBatchCount = chapterBatches.filter(
    (batch) => batch.status === "applied",
  ).length;
  const appliedChangeCount = chapterBatches
    .filter((batch) => batch.status === "applied")
    .reduce((sum, batch) => sum + batch.changes.length, 0);
  const latestProposedBatch = chapterBatches.find(
    (batch) => batch.status === "proposed",
  );
  const latestProposedSelectedIds = latestProposedBatch
    ? (syncSelections[latestProposedBatch.id] ??
      latestProposedBatch.changes.map((change) => change.id))
    : [];
  const qualityReviewStale = Boolean(
    qualityReview &&
      !isQualityReviewCurrent({
        sourceContent: qualityReviewSourceContent,
        currentDraftContent: draft,
        currentSavedContent: savedDraft,
        currentPersistedContent: selectedChapter?.content,
        externalChanged,
      }),
  );
  const chapterWordTarget = project.metadata.chapterWordCount ?? 3000;

  const deleteChapter = async () => {
    if (!selectedChapter || operation) return;
    if (rejectManuscriptMutationWhileAiBusy()) return;
    setOperation("delete-chapter");
    try {
      await onDeleteChapter(selectedChapter.id, savedDraft);
      setDeleteOpen(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setOperation(null);
    }
  };

  const normalizedTreeSearch = treeSearch.trim().toLocaleLowerCase("zh-CN");
  const currentVolumeId = (() => {
    let directoryId = selectedChapter?.directoryId ?? activeDirectoryId;
    while (directoryId) {
      const directory = project.chapterIndex.directories.find(
        (item) => item.id === directoryId,
      );
      if (!directory) return null;
      if (directory.kind === "volume") return directory.id;
      directoryId = directory.parentId;
    }
    return null;
  })();
  const volumeDirectoryIds = (() => {
    if (!currentVolumeId) return new Set<string>();
    const ids = new Set<string>([currentVolumeId]);
    let changed = true;
    while (changed) {
      changed = false;
      project.chapterIndex.directories.forEach((directory) => {
        if (
          directory.parentId &&
          ids.has(directory.parentId) &&
          !ids.has(directory.id)
        ) {
          ids.add(directory.id);
          changed = true;
        }
      });
    }
    return ids;
  })();
  const chapterVisible = (chapter: LoadedNovelChapter): boolean => {
    if (treeFilter === "sync" && chapter.trackingStatus === "synced")
      return false;
    if (
      treeFilter === "volume" &&
      (!chapter.directoryId || !volumeDirectoryIds.has(chapter.directoryId))
    )
      return false;
    if (!normalizedTreeSearch) return true;
    const plan = chapter.narrativeChapterId
      ? project.narrative.library.chapters.find(
          (item) => item.id === chapter.narrativeChapterId,
        )
      : undefined;
    return [
      chapter.title,
      STATUS_LABELS[chapter.status],
      TRACKING_LABELS[chapter.trackingStatus],
      plan?.description ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(normalizedTreeSearch);
  };
  const directoryVisible = (directory: ManuscriptDirectory): boolean => {
    if (treeFilter === "volume" && !volumeDirectoryIds.has(directory.id)) {
      return false;
    }
    if (!normalizedTreeSearch) return true;
    if (
      normalizedTreeSearch &&
      directory.title.toLocaleLowerCase("zh-CN").includes(normalizedTreeSearch)
    )
      return true;
    if (
      project.chapters.some(
        (chapter) =>
          chapter.directoryId === directory.id && chapterVisible(chapter),
      )
    )
      return true;
    return project.chapterIndex.directories
      .filter((item) => item.parentId === directory.id)
      .some(directoryVisible);
  };

  const renderChapterButton = (chapter: LoadedNovelChapter, depth: number) => {
    if (!chapterVisible(chapter)) return null;
    const active = chapter.id === selectedChapter?.id;
    return (
      <button
        key={chapter.id}
        type="button"
        draggable={!structureLocked && !manuscriptMutationBusy}
        className={`ms-chapter-row ${active ? "is-active" : ""} ${draggedChapterId === chapter.id ? "is-dragging" : ""}`}
        style={{ "--tree-depth": depth } as CSSProperties}
        onClick={() => void requestChapter(chapter.id)}
        onDragStart={(event) => {
          if (structureLocked || manuscriptMutationBusy) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", chapter.id);
          setDraggedChapterId(chapter.id);
        }}
        onDragEnd={() => {
          setDraggedChapterId(null);
          setDragOverDirectoryId(null);
        }}
        onDragOver={(event) => {
          if (
            manuscriptMutationBusy ||
            !draggedChapterId ||
            draggedChapterId === chapter.id
          )
            return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (
            manuscriptMutationBusy ||
            !draggedChapterId ||
            draggedChapterId === chapter.id
          )
            return;
          void moveChapterTo(
            draggedChapterId,
            chapter.directoryId!,
            chapter.order,
          );
        }}
        title={`${chapter.title} · ${chapter.words.toLocaleString()} 字 · 拖动到目录可移动`}
      >
        <span className="ms-chapter-number">
          {String(chapter.displayNumber).padStart(2, "0")}
        </span>
        <span className="ms-chapter-copy">
          <strong>{chapter.title}</strong>
          <small>
            {chapter.status === "planned"
              ? "关联剧情 · 点击开始写作"
              : !chapter.narrativeChapterId
                ? "未关联剧情计划"
                : `${chapter.words.toLocaleString()} 字 · ${chapter.trackingStatus === "synced" ? "已同步" : STATUS_LABELS[chapter.status]}`}
          </small>
        </span>
        {chapter.status === "planned" ? (
          <span className="ms-chapter-plan-badge">开始写作</span>
        ) : (
          <span
            className={`ms-chapter-status-dot ${
              chapter.trackingStatus === "synced"
                ? "is-synced"
                : chapter.trackingStatus === "review" ||
                    chapter.trackingStatus === "stale" ||
                    chapter.status === "revising"
                  ? "is-attention"
                  : "is-draft"
            }`}
            aria-label={TRACKING_LABELS[chapter.trackingStatus]}
          />
        )}
      </button>
    );
  };

  const renderDirectory = (
    directory: ManuscriptDirectory,
    depth: number,
  ): ReactNode => {
    if (!directoryVisible(directory)) return null;
    const open =
      expandedDirectories.has(directory.id) || Boolean(normalizedTreeSearch);
    const selected = activeDirectoryId === directory.id;
    const children = project.chapterIndex.directories
      .filter((item) => item.parentId === directory.id)
      .sort((left, right) => left.order - right.order);
    const siblings = project.chapterIndex.directories
      .filter((item) => item.parentId === directory.parentId)
      .sort((left, right) => left.order - right.order);
    const siblingPosition = siblings.findIndex(
      (item) => item.id === directory.id,
    );
    const chapters = project.chapters
      .filter((chapter) => chapter.directoryId === directory.id)
      .sort((left, right) => left.order - right.order);
    const chapterCount = (() => {
      const directoryIds = new Set([directory.id]);
      let changed = true;
      while (changed) {
        changed = false;
        project.chapterIndex.directories.forEach((candidate) => {
          if (
            candidate.parentId &&
            directoryIds.has(candidate.parentId) &&
            !directoryIds.has(candidate.id)
          ) {
            directoryIds.add(candidate.id);
            changed = true;
          }
        });
      }
      return project.chapters.filter((chapter) =>
        chapter.directoryId ? directoryIds.has(chapter.directoryId) : false,
      ).length;
    })();
    const directorySubtitle =
      depth === 0 && directory.narrativeDirectoryId
        ? `关联剧情工程 / ${DIRECTORY_KIND_LABELS[directory.kind]}`
        : directory.kind === "part"
          ? `章节 · ${chapterCount} 章`
          : directory.kind === "folder"
            ? `副本 · ${chapterCount} 章`
            : `${DIRECTORY_KIND_LABELS[directory.kind]} · ${chapterCount} 章`;
    const editing = editingDirectoryId === directory.id;
    return (
      <div key={directory.id}>
        <div
          className={`ms-directory-row ${selected ? "is-selected" : ""} ${dragOverDirectoryId === directory.id ? "is-drop-target" : ""}`}
          style={{ "--tree-depth": depth } as CSSProperties}
          onDragOver={(event) => {
            if (
              !draggedChapterId ||
              structureLocked ||
              manuscriptMutationBusy
            )
              return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDragOverDirectoryId(directory.id);
          }}
          onDragLeave={(event) => {
            const relatedTarget = event.relatedTarget;
            if (
              !(relatedTarget instanceof Node) ||
              !event.currentTarget.contains(relatedTarget)
            ) {
              setDragOverDirectoryId((current) =>
                current === directory.id ? null : current,
              );
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (
              !draggedChapterId ||
              structureLocked ||
              manuscriptMutationBusy
            )
              return;
            void moveChapterTo(draggedChapterId, directory.id);
          }}
        >
          <button
            type="button"
            className="ms-tree-chevron"
            onClick={() =>
              setExpandedDirectories((current) => {
                const next = new Set(current);
                if (next.has(directory.id)) next.delete(directory.id);
                else next.add(directory.id);
                return next;
              })
            }
            aria-label={open ? "折叠目录" : "展开目录"}
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          {editing ? (
            <input
              className="ms-directory-edit"
              value={editingDirectoryTitle}
              disabled={manuscriptMutationBusy}
              onChange={(event) => setEditingDirectoryTitle(event.target.value)}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter")
                  void saveDirectoryTitle(directory.id);
                if (event.key === "Escape") setEditingDirectoryId(null);
              }}
            />
          ) : (
            <button
              type="button"
              className="ms-directory-main"
              onClick={() => setActiveDirectoryId(directory.id)}
            >
              {directoryIcon(open)}
              <span className="ms-directory-copy">
                <strong>{directory.title}</strong>
                <small>{directorySubtitle}</small>
              </span>
              {depth === 0 && (
                <span className="ms-directory-count">{chapterCount}</span>
              )}
            </button>
          )}
          {selected && !structureLocked && !manuscriptMutationBusy && (
            <div className="ms-directory-actions">
              {editing ? (
                <>
                  <button
                    type="button"
                    onClick={() => void saveDirectoryTitle(directory.id)}
                    aria-label="保存目录名称"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingDirectoryId(null)}
                    aria-label="取消目录编辑"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingDirectoryId(directory.id);
                      setEditingDirectoryTitle(directory.title);
                    }}
                    aria-label="重命名目录"
                    title="重命名目录"
                  >
                    <PenLine className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void moveDirectory(directory, -1)}
                    disabled={siblingPosition <= 0}
                    aria-label="目录上移"
                    title="同级上移"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void moveDirectory(directory, 1)}
                    disabled={
                      siblingPosition < 0 ||
                      siblingPosition >= siblings.length - 1
                    }
                    aria-label="目录下移"
                    title="同级下移"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void deleteDirectory(directory.id)
                    }
                    aria-label="删除目录"
                    title="删除目录"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {open && (
          <div>
            {children.map((child) => renderDirectory(child, depth + 1))}
            {chapters.map((chapter) => renderChapterButton(chapter, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const rootDirectories = project.chapterIndex.directories
    .filter((directory) => directory.parentId === null)
    .sort((left, right) => left.order - right.order);
  const directoryHasNarrativeAncestor = (directoryId: string): boolean => {
    let current = project.chapterIndex.directories.find(
      (directory) => directory.id === directoryId,
    );
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.narrativeDirectoryId) return true;
      visited.add(current.id);
      const parentId = current.parentId;
      current = parentId
        ? project.chapterIndex.directories.find(
            (directory) => directory.id === parentId,
          )
        : undefined;
    }
    return false;
  };
  const narrativeRootDirectories = rootDirectories.filter((directory) =>
    directoryHasNarrativeAncestor(directory.id),
  );
  const manualRootDirectories = rootDirectories.filter(
    (directory) => !directoryHasNarrativeAncestor(directory.id),
  );
  const structuredChapterCount = project.chapters.filter(
    (chapter) => chapter.narrativeChapterId !== null,
  ).length;
  const orderedChapters = canonicalChapters;
  const selectedChapterIndex = orderedChapters.findIndex(
    (chapter) => chapter.id === selectedChapter?.id,
  );
  const continuousChapters =
    selectedChapterIndex < 0
      ? []
      : orderedChapters.slice(
          Math.max(0, selectedChapterIndex - 1),
          selectedChapterIndex + 2,
        );
  const currentWordCount = countCharacters(draft);
  const sessionDelta = currentWordCount - (selectedChapter?.words ?? 0);
  const remainingTarget = Math.max(0, chapterWordTarget - currentWordCount);
  const estimatedMinutes = Math.max(1, Math.ceil(remainingTarget / 220));
  const activeTrackingChanges =
    trackingLoaded?.ledger.batches
      .filter((batch) => batch.status === "applied")
      .flatMap((batch) => batch.changes)
      .slice(0, 12) ?? [];
  const editorStyle = {
    "--manuscript-font-size": `${typographyDraft.fontSize}px`,
    "--manuscript-title-size": `${typographyDraft.titleSize}px`,
    "--manuscript-line-height": typographyDraft.lineHeight,
    "--manuscript-paragraph-spacing": `${typographyDraft.paragraphSpacing}px`,
    "--manuscript-indent": `${typographyDraft.firstLineIndent}em`,
    "--manuscript-width": `${typographyDraft.contentWidth}px`,
    "--manuscript-text-align": typographyDraft.textAlign,
  } as CSSProperties;
  const preparePersistedManuscriptAiSource = async (): Promise<boolean> => {
    if (
      !selectedChapter ||
      manuscriptAiBusy ||
      rejectManuscriptAiWhileMutationBusy()
    )
      return false;
    const requestChapterId = selectedChapter.id;
    if (!(await saveCurrent())) return false;
    if (currentChapterIdRef.current !== requestChapterId) return false;
    try {
      const persisted = await storage.readText(selectedChapter.path);
      if (
        currentChapterIdRef.current !== requestChapterId ||
        persisted.content !== draftRef.current
      ) {
        setExternalChanged(true);
        setError("正文在启动 AI 前发生变化，请先保存当前正文后重试");
        return false;
      }
      return true;
    } catch (cause) {
      setError(`无法读取正文事实源：${errorText(cause)}`);
      return false;
    }
  };
  const openFullGeneration = async () => {
    if (!(await preparePersistedManuscriptAiSource())) return;
    setFullGenerationBusy(false);
    setFullGenerationOpen(true);
  };
  const openBrainstormRoom = async () => {
    if (!(await preparePersistedManuscriptAiSource())) return;
    setBrainstormBusy(false);
    setBrainstormOpen(true);
  };
  const openSimulationRoom = async () => {
    if (!onAiRun || !(await preparePersistedManuscriptAiSource())) return;
    setSimulationBusy(false);
    setSimulationOpen(true);
  };

  return (
    <div className="ms-studio">
      <NarrativeUnsavedChangesGuard
        dirty={
          dirty ||
          typographyDirty ||
          Boolean(candidate) ||
          hasPendingNarrativeExtraction
        }
        blockLeave={manuscriptTaskBusy}
        label="正文"
        registerNavigationGuard={registerNavigationGuard}
        onSave={saveBeforeNavigation}
      />
      <DeleteChapterDialog
        open={deleteOpen}
        title={selectedChapter?.title ?? "章节"}
        appliedBatchCount={appliedBatchCount}
        appliedChangeCount={appliedChangeCount}
        deleting={operation === "delete-chapter"}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void deleteChapter()}
      />
      {permanentDeleteTarget && (
        <ConfirmDialog
          title="彻底删除章节"
          message={`确定要彻底删除“${permanentDeleteTarget.title}”吗？此操作不可恢复：正文文件、历史版本与回收站记录将一并清除。`}
          confirmText="彻底删除"
          confirmVariant="danger"
          loading={Boolean(operation)}
          onConfirm={() =>
            void runManuscriptMutation("permanent-delete", async () => {
              await onDeleteChapterPermanently(
                permanentDeleteTarget.deletionId,
              );
              setPermanentDeleteTarget(null);
            })
          }
          onCancel={() => setPermanentDeleteTarget(null)}
        />
      )}
      {narrativeExtractionDiscardOpen && (
        <ConfirmDialog
          title="放弃正文提炼候选"
          message={`当前有 ${narrativeExtractionDrafts.length} 章待确认的剧情工程提炼结果。放弃后不会写入剧情工程，且无法恢复。`}
          confirmText="放弃候选"
          confirmVariant="danger"
          onConfirm={discardNarrativeExtraction}
          onCancel={() => setNarrativeExtractionDiscardOpen(false)}
        />
      )}
      <ContextManifestDialog
        open={manifestOpen}
        sources={contextManifest}
        excluded={excludedContextSources}
        onToggle={(id) =>
          setExcludedContextSources((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onClose={() => setManifestOpen(false)}
      />
      <NarrativeExtractionDialog
        open={narrativeExtractionOpen}
        chapters={canonicalChapters}
        selectedChapterIds={narrativeExtractionChapterIds}
        narrativePlans={project.narrative.library.chapters}
        targetNarrativeChapterId={narrativeExtractionTargetId}
        drafts={narrativeExtractionDrafts}
        busy={narrativeExtractionBusy}
        aiAvailable={Boolean(onAiRun)}
        onClose={requestCloseNarrativeExtraction}
        onToggleChapter={(chapterId, checked) => {
          setNarrativeExtractionChapterIds((current) => {
            const next = new Set(current);
            if (checked) next.add(chapterId);
            else next.delete(chapterId);
            return next;
          });
          setNarrativeExtractionDrafts([]);
          narrativeExtractionSourceHashesRef.current = new Map();
          setNarrativeExtractionTargetId("");
        }}
        onTargetChange={setNarrativeExtractionTargetId}
        onChangeDraft={(chapterId, patch) =>
          setNarrativeExtractionDrafts((current) =>
            current.map((draft) =>
              draft.chapterId === chapterId ? { ...draft, ...patch } : draft,
            ),
          )
        }
        onRun={() => void runNarrativeExtraction()}
        onApply={() => void applyNarrativeExtraction()}
      />
      {brainstormOpen && (
        <BrainstormRoomDialog
          key={`brainstorm-${selectedChapter?.id ?? "empty"}`}
          project={project}
          initialNotes={creativeBrief}
          generationContext={buildOptionalContext()}
          targetWordCount={project.metadata.chapterWordCount ?? undefined}
          onOpenAiAgent={onOpenAiAgent}
          onApplyGeneratedText={async (
            content,
            expectedContent,
            expectedPersistedContent,
          ) => {
            await assertCurrentCandidateSource(
              expectedContent,
              expectedPersistedContent,
            );
            setDraft(content);
            setCandidate(null);
            setSelection({ start: 0, end: 0 });
            setSelectionToolbarPosition(null);
            setView("write");
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          onOpenModelSettings={onOpenModelSettings}
          storage={storage}
          chapter={selectedChapter}
          chapterPlan={selectedPlan}
          planningMode={selectedChapter?.planningMode}
          manuscriptContent={savedDraft}
          persistedManuscriptContent={savedDraft}
          enabled={Boolean(onAiRun)}
          onRun={onAiRun ?? (() => Promise.reject(new Error("AI 当前不可用")))}
          onUseBrief={(brief) => {
            setCreativeBrief(brief);
            setView("write");
          }}
          onAdoptSimulation={onAdoptSimulation}
          onClose={() => {
            setBrainstormBusy(false);
            setBrainstormOpen(false);
          }}
          onBusyChange={setBrainstormBusy}
        />
      )}
      {fullGenerationOpen && (
        <FullGenerationWorkflow
          storage={storage}
          project={project}
          open
          chapter={selectedChapter}
          chapterPlan={selectedPlan}
          manuscriptContent={savedDraft}
          persistedManuscriptContent={savedDraft}
          initialNotes={creativeBrief}
          generationContext={buildOptionalContext()}
          targetWordCount={project.metadata.chapterWordCount ?? undefined}
          onRun={onAiRun}
          onOpenAiAgent={onOpenAiAgent}
          onApplyGeneratedText={async (
            content,
            expectedContent,
            expectedPersistedContent,
          ) => {
            await assertCurrentCandidateSource(
              expectedContent,
              expectedPersistedContent,
            );
            setDraft(content);
            setCandidate(null);
            setSelection({ start: 0, end: 0 });
            setSelectionToolbarPosition(null);
            setView("write");
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          onOpenModelSettings={onOpenModelSettings}
          onClose={() => {
            setFullGenerationBusy(false);
            setFullGenerationOpen(false);
          }}
          onBusyChange={setFullGenerationBusy}
        />
      )}
      {simulationOpen && (
        <SimulationRoomDialog
          key={`simulation-${selectedChapter?.id ?? "empty"}`}
          storage={storage}
          chapter={selectedChapter}
          chapterPlan={selectedPlan}
          planningMode={selectedChapter?.planningMode}
          manuscriptContent={savedDraft}
          enabled={Boolean(onAiRun)}
          onRun={onAiRun ?? (() => Promise.reject(new Error("AI 当前不可用")))}
          onUseBrief={(brief) => {
            setCreativeBrief(brief);
            setView("write");
            setSimulationBusy(false);
            setSimulationOpen(false);
          }}
          onAdoptSimulation={onAdoptSimulation}
          onClose={() => {
            setSimulationBusy(false);
            setSimulationOpen(false);
          }}
          onBusyChange={setSimulationBusy}
        />
      )}
      <header className="ms-topbar">
        <div className="ms-project-title">
          <FileText className="h-4 w-4" />
          <span>{project.metadata.title}</span>
          <b>/</b>
          <strong>{selectedChapter?.title ?? "正文"}</strong>
          <StructureBadge mode={project.chapterIndex.structureMode} />
          {selectedChapter && (
            <span className={`ms-status-chip is-${selectedChapter.status}`}>
              {STATUS_LABELS[selectedChapter.status]}
            </span>
          )}
          {selectedChapter?.trackingStatus === "review" && (
            <span className="ms-status-chip is-warning">同步待更新</span>
          )}
          {selectedChapter?.planningMode === "detached" && (
            <span className="ms-status-chip is-warning">正文优先</span>
          )}
          {project.chapterIndexNeedsMigration && (
            <span className="ms-migration-note">保存任一结构设置后升级 v4</span>
          )}
        </div>
        <div className="ms-workbench-actions" aria-label="正文辅助工具">
          {STUDIO_ACTIONS.map((action) => {
            const Icon = action.icon;
            const isActive =
              (action.id === "brainstorm" && brainstormOpen) ||
              (action.id === "simulation" && simulationOpen) ||
              (action.id === "tracking" && view === "tracking");
            const returnsToManuscript =
              action.id === "tracking" && view === "tracking";
            const disabled =
              (action.id === "brainstorm" || action.id === "simulation") &&
              (!selectedChapter || !onAiRun || manuscriptMutationBusy);
            return (
              <button
                key={action.id}
                type="button"
                className={`ns-button ms-workbench-action ${isActive ? "is-active" : ""}`}
                onClick={() => {
                  if (action.id === "brainstorm") void openBrainstormRoom();
                  else if (action.id === "simulation")
                    void openSimulationRoom();
                  else setView(returnsToManuscript ? "write" : "tracking");
                }}
                title={returnsToManuscript ? "回到正文" : action.label}
                aria-label={returnsToManuscript ? "回到正文" : action.label}
                disabled={disabled}
              >
                {returnsToManuscript ? (
                  <ChevronLeft className="h-3.5 w-3.5" />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
                <span>{returnsToManuscript ? "回到正文" : action.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            className="ns-button ms-workbench-action"
            onClick={() => void exportManuscript()}
            title="导出整稿 Markdown（自动保存后按目录顺序导出）"
            aria-label="导出整稿 Markdown"
          >
            <Download className="h-3.5 w-3.5" />
            <span>导出</span>
          </button>
        </div>
        <div className="ms-structure-controls">
          <button
            type="button"
            className={`ns-button ms-continuous-toggle ${writingSurface === "continuous" ? "is-active" : ""}`}
            onClick={() => {
              setView("write");
              setWritingSurface((current) =>
                current === "continuous" ? "chapter" : "continuous",
              );
            }}
            title="连续稿阅读"
          >
            <BookOpen className="h-3.5 w-3.5" /> 连续稿
          </button>
          <button
            type="button"
            className={`ns-button ms-structure-lock ${structureLocked ? "is-active" : ""}`}
            onClick={() => void toggleStructureMode()}
            disabled={manuscriptMutationBusy}
            title={structureLocked ? "解除剧情结构锁定" : "锁定剧情结构"}
            aria-label={structureLocked ? "解除剧情结构锁定" : "锁定剧情结构"}
          >
            {structureLocked ? (
              <Unlock className="h-3.5 w-3.5" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            <span>{structureLocked ? "解锁结构" : "锁定结构"}</span>
          </button>
          <button
            type="button"
            className="ns-icon-button"
            onClick={() => void synchronizeNarrative()}
            disabled={manuscriptMutationBusy}
            title="同步剧情工程"
            aria-label="同步剧情工程"
          >
            {operation === "sync" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            className="ms-mobile-inspector-toggle"
            onClick={() => setMobileInspectorOpen((open) => !open)}
            title="打开基本与排版面板"
            aria-label="打开基本与排版面板"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      <nav className="ms-mobile-pane-switch" aria-label="移动端工作面">
        {(
          [
            ["tree", "目录"],
            ["editor", "正文"],
            ["context", "上下文"],
          ] as const
        ).map(([pane, label]) => (
          <button
            type="button"
            className={mobilePane === pane ? "is-active" : ""}
            onClick={() => setMobilePane(pane)}
            key={pane}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="ms-errorbar">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="关闭错误"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className={`ms-body is-mobile-${mobilePane}`}>
        <aside className="ms-outline">
          <div className="ms-outline-heading">
            <div>
              <span className="ms-eyebrow">Manuscript</span>
              <strong>正文目录</strong>
            </div>
            <div>
              <button
                type="button"
                onClick={() => {
                  setDirectoryKind(activeDirectoryId ? "folder" : "volume");
                  setDirectoryFormOpen(true);
                }}
                disabled={structureLocked || manuscriptMutationBusy}
                title="新建目录"
                aria-label="新建目录"
              >
                <Folder className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void createChapter()}
                disabled={
                  structureLocked || isCreatingChapter || manuscriptMutationBusy
                }
                title="新建章节"
                aria-label="新建章节"
              >
                {isCreatingChapter ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
          <div
            className={`ms-mode-notice is-${structureLocked ? "locked" : "merged"}`}
          >
            {structureLocked ? (
              <Lock className="h-3.5 w-3.5" />
            ) : (
              <Link2 className="h-3.5 w-3.5" />
            )}
            <span>
              {structureLocked
                ? "剧情工程卷与章节已锁定同步；正文页不可修改目录结构。"
                : "目录主架构自动来自剧情工程；自由内容可作为补充。"}
            </span>
          </div>
          <label className="ms-tree-search">
            <Search className="h-3.5 w-3.5" />
            <input
              value={treeSearch}
              onChange={(event) => setTreeSearch(event.target.value)}
              placeholder="搜索章节、人物或状态"
            />
            {treeSearch && (
              <button
                type="button"
                onClick={() => setTreeSearch("")}
                aria-label="清除搜索"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </label>
          <div className="ms-tree-filters">
            {(
              [
                ["all", "全部"],
                ["volume", "本卷"],
                ["sync", "待同步"],
              ] as const
            ).map(([filter, label]) => (
              <button
                type="button"
                className={treeFilter === filter ? "is-active" : ""}
                onClick={() => setTreeFilter(filter)}
                disabled={filter === "volume" && !currentVolumeId}
                key={filter}
              >
                {filter === "sync" && <Filter className="h-3 w-3" />}
                {label}
                {filter === "sync" && (
                  <b>
                    {
                      project.chapters.filter(
                        (chapter) => chapter.trackingStatus !== "synced",
                      ).length
                    }
                  </b>
                )}
              </button>
            ))}
          </div>
          {directoryFormOpen && (
            <form
              className="ms-directory-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createDirectory();
              }}
            >
              <input
                value={directoryTitle}
                onChange={(event) => setDirectoryTitle(event.target.value)}
                placeholder={activeDirectoryId ? "子目录名称" : "卷名或目录名"}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Escape") setDirectoryFormOpen(false);
                }}
              />
              <CustomSelect
                value={directoryKind}
                options={[
                  { value: "volume", label: "卷" },
                  { value: "part", label: "篇" },
                  { value: "folder", label: "目录" },
                ]}
                onChange={(value) =>
                  setDirectoryKind(value as ManuscriptDirectoryKind)
                }
                ariaLabel="目录类型"
                compact
              />
              <button
                type="submit"
                disabled={
                  !directoryTitle.trim() || operation === "create-directory"
                }
                aria-label="确认新建"
                title="确认新建"
              >
                {operation === "create-directory" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setDirectoryFormOpen(false)}
                aria-label="取消"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </form>
          )}
          <div className="ms-tree-scroll">
            {narrativeRootDirectories.length > 0 && (
              <div className="ms-tree-section-header">
                <strong>
                  剧情工程结构<small>（自动同步）</small>
                </strong>
                <span>{structuredChapterCount} 章</span>
              </div>
            )}
            {narrativeRootDirectories.map((directory) =>
              renderDirectory(directory, 0),
            )}
            {manualRootDirectories.length > 0 && (
              <div className="ms-unassigned-group ms-free-content-group">
                <button
                  type="button"
                  className={`ms-unassigned-group-header ${activeDirectoryId === null ? "is-selected" : ""}`}
                  onClick={() => setActiveDirectoryId(null)}
                >
                  <strong>自由内容</strong>
                  <small>{manualRootDirectories.length} 个目录</small>
                </button>
                {manualRootDirectories.map((directory) =>
                  renderDirectory(directory, 0),
                )}
              </div>
            )}
            {!rootDirectories.length && (
              <p className="ms-tree-empty">暂无目录与章节</p>
            )}
          </div>
          <footer>
            <button
              type="button"
              onClick={() => {
                setInspectorView("trash");
                setMobileInspectorOpen(true);
                setMobilePane("context");
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> 回收站
              {project.chapterIndex.trash.length > 0 && (
                <b>{project.chapterIndex.trash.length}</b>
              )}
            </button>
            <span>{project.chapters.length} 章</span>
            <span>
              {project.chapters
                .reduce((sum, chapter) => sum + chapter.words, 0)
                .toLocaleString()}{" "}
              字
            </span>
          </footer>
        </aside>

        <main className="ms-main">
          {view === "write" &&
            (selectedChapter ? (
              <div
                className={`ms-writing is-font-${typographyDraft.fontFamily} is-paper-${typographyDraft.paperTone} is-align-${typographyDraft.textAlign}`}
                style={editorStyle}
              >
                <header className="ms-writing-toolbar">
                  <div className="ms-writing-surface-switch">
                    {(
                      [
                        ["chapter", "连续正文"],
                        [
                          "scenes",
                          `场景卡 ${selectedPlan?.sections.length ?? 0}`,
                        ],
                      ] as const
                    ).map(([surface, label]) => (
                      <button
                        type="button"
                        className={
                          writingSurface === surface ? "is-active" : ""
                        }
                        onClick={() => setWritingSurface(surface)}
                        key={surface}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="ms-title-editor">
                    <span>第 {selectedChapter.displayNumber} 章</span>
                    <input
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onBlur={() => void commitTitle()}
                      disabled={structureLocked || manuscriptMutationBusy}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          setTitleDraft(selectedChapter.title);
                          event.currentTarget.blur();
                        }
                      }}
                      aria-label="章节标题"
                    />
                  </div>
                  <div className="ms-writing-actions">
                    <button
                      type="button"
                      onClick={() => void openFullGeneration()}
                      disabled={
                        !selectedChapter ||
                        (!onOpenAiAgent && !onAiRun) ||
                        manuscriptMutationBusy
                      }
                      title="生成完整正文"
                    >
                      <Sparkles className="h-3.5 w-3.5" /> 完整生成
                    </button>
                    <button
                      type="button"
                      onClick={() => void runWritingAi("continue")}
                      disabled={
                        !selectedChapter ||
                        (!onOpenAiAgent && !onAiRun) ||
                        manuscriptMutationBusy
                      }
                      title="从光标处续写"
                    >
                      <PenLine className="h-3.5 w-3.5" /> 续写
                    </button>
                    <button
                      type="button"
                      onClick={() => void runWritingAi("revise")}
                      disabled={
                        !selectedChapter ||
                        (!onOpenAiAgent && !onAiRun) ||
                        manuscriptMutationBusy
                      }
                      title="润色选区；无选区时处理全文"
                    >
                      <WandSparkles className="h-3.5 w-3.5" /> 润色
                    </button>
                    <button
                      type="button"
                      onClick={() => void runWritingAi("expand")}
                      disabled={
                        !selectedChapter ||
                        (!onOpenAiAgent && !onAiRun) ||
                        manuscriptMutationBusy
                      }
                      title="扩写选区；无选区时处理全文"
                    >
                      <Maximize2 className="h-3.5 w-3.5" /> 扩写
                    </button>
                    {aiMode && (
                      <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-warm)]" />
                    )}
                  </div>
                  <div
                    className="ms-editor-mode"
                    hidden={writingSurface !== "chapter"}
                  >
                    <button
                      type="button"
                      className={editorMode === "edit" ? "is-active" : ""}
                      onClick={() => setEditorMode("edit")}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className={editorMode === "preview" ? "is-active" : ""}
                      onClick={() => setEditorMode("preview")}
                    >
                      预览
                    </button>
                  </div>
                  <button
                    type="button"
                    className="ns-icon-button"
                    onClick={() => void runQualityReview()}
                    disabled={!onAiRun || manuscriptMutationBusy || !draft.trim()}
                    title="检查当前草稿，不会修改正文"
                    aria-label="检查正文质量"
                  >
                    {qualityBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="ns-icon-button"
                    onClick={() => {
                      setInspectorView("typography");
                      setMobileInspectorOpen(true);
                      setMobilePane("context");
                    }}
                    title="全局正文排版"
                    aria-label="全局正文排版"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="ns-icon-button"
                    onClick={() => {
                      setVersionDialogOpen(true);
                    }}
                    title="历史版本"
                    aria-label="历史版本"
                  >
                    <History className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="ns-button"
                    onClick={() => void saveCurrent()}
                    disabled={!dirty || isSaving}
                  >
                    {isSaving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : dirty ? (
                      <Save className="h-3.5 w-3.5" />
                    ) : (
                      <Check className="h-3.5 w-3.5 text-[var(--success)]" />
                    )}
                    {isSaving ? "保存中" : dirty ? "保存" : "已保存"}
                  </button>
                </header>
                {creativeBrief && (
                  <div className="ms-creative-brief" role="status">
                    <WandSparkles className="h-3.5 w-3.5" />
                    <div className="ms-creative-brief-copy">
                      <strong>本章创作方案</strong>
                      <span title={creativeBrief}>{creativeBrief}</span>
                    </div>
                    <button
                      type="button"
                      className="ns-icon-button"
                      onClick={() => setCreativeBrief("")}
                      aria-label="移除本章创作方案"
                      title="移除本章创作方案"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {externalChanged && (
                  <div className="ms-external-warning">
                    磁盘正文已变化，本地草稿未被覆盖。
                    <button
                      type="button"
                      onClick={() => void reloadCurrentChapterFromDisk()}
                      disabled={
                        Boolean(candidate) ||
                        hasPendingNarrativeExtraction ||
                        isApplyingCandidate
                      }
                      title={
                        candidate || hasPendingNarrativeExtraction
                          ? "请先采用或放弃当前 AI 候选"
                          : "载入磁盘版本"
                      }
                    >
                      载入磁盘版本
                    </button>
                  </div>
                )}
                <div className="ms-paper-scroll">
                  {writingSurface === "continuous" ? (
                    <section className="ms-continuous-manuscript">
                      <header>
                        <div>
                          <span className="ms-eyebrow">
                            Continuous manuscript
                          </span>
                          <strong>连续稿 · 当前章前后各一章</strong>
                        </div>
                        <button
                          type="button"
                          onClick={() => setWritingSurface("chapter")}
                        >
                          回到当前章编辑
                        </button>
                      </header>
                      {continuousChapters.map((chapter) => {
                        const content =
                          chapter.id === selectedChapter.id
                            ? draft
                            : chapter.content;
                        const plan = chapter.narrativeChapterId
                          ? project.narrative.library.chapters.find(
                              (item) => item.id === chapter.narrativeChapterId,
                            )
                          : undefined;
                        return (
                          <article
                            className={
                              chapter.id === selectedChapter.id
                                ? "is-current"
                                : content.trim()
                                  ? ""
                                  : "is-plan"
                            }
                            key={chapter.id}
                          >
                            <span>第 {chapter.displayNumber} 章</span>
                            <h2>{chapter.title}</h2>
                            {content.trim() ? (
                              splitParagraphs(content).map(
                                (paragraph, index) => (
                                  <p key={index}>{paragraph}</p>
                                ),
                              )
                            ) : (
                              <p>
                                {plan?.description || "该章节尚未开始写作。"}
                              </p>
                            )}
                            {chapter.id !== selectedChapter.id && (
                              <button
                                type="button"
                                onClick={() => void requestChapter(chapter.id)}
                              >
                                {content.trim() ? "打开本章" : "开始写本章"}
                              </button>
                            )}
                          </article>
                        );
                      })}
                    </section>
                  ) : writingSurface === "scenes" ? (
                    <section className="ms-scene-board">
                      <header>
                        <div>
                          <span className="ms-eyebrow">Scene cards</span>
                          <h2>
                            {selectedPlan?.title ?? selectedChapter.title}
                          </h2>
                          <p>
                            {selectedPlan?.description ||
                              "当前章节没有关联剧情计划，可继续按连续正文写作。"}
                          </p>
                        </div>
                        <span>
                          {selectedPlan?.sections.length ?? 0} 个计划场景
                        </span>
                      </header>
                      <div className="ms-scene-list">
                        {(selectedPlan?.sections ?? []).map(
                          (section, index) => (
                            <article key={section.id}>
                              <span className="ms-scene-number">
                                {String(index + 1).padStart(2, "0")}
                              </span>
                              <div>
                                <h3>{section.title || `场景 ${index + 1}`}</h3>
                                <p>
                                  {section.description || "尚未填写场景说明"}
                                </p>
                                <small>
                                  POV {section.povCharacterId || "未指定"} ·{" "}
                                  {section.paragraphs.length} 个段落计划
                                </small>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setCreativeBrief(
                                    `${section.title}\n${section.description}`,
                                  );
                                  setWritingSurface("chapter");
                                }}
                              >
                                <WandSparkles className="h-3.5 w-3.5" />{" "}
                                写这个场景
                              </button>
                            </article>
                          ),
                        )}
                        {!selectedPlan?.sections.length && (
                          <div className="ms-scene-empty">
                            <BookMarked className="h-7 w-7" />
                            <p>剧情工程中尚未拆分场景。</p>
                            <button type="button" onClick={onOpenNarrative}>
                              前往剧情工程
                            </button>
                          </div>
                        )}
                      </div>
                    </section>
                  ) : (
                    <article className="ms-manuscript-page">
                      <header className="ms-chapter-title-block">
                        <span>
                          {project.chapterIndex.directories.find(
                            (directory) =>
                              directory.id === selectedChapter.directoryId,
                          )?.title ?? "目录待同步"}
                          <i /> CHAPTER{" "}
                          {String(selectedChapter.displayNumber).padStart(
                            2,
                            "0",
                          )}
                        </span>
                        <h1>{titleDraft}</h1>
                        {selectedPlan?.description && (
                          <p>目标：{selectedPlan.description}</p>
                        )}
                      </header>
                      {editorMode === "edit" ? (
                        <textarea
                          ref={textareaRef}
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onSelect={(event) =>
                            updateTextSelection(event.currentTarget)
                          }
                          spellCheck={false}
                          aria-label="章节正文"
                          placeholder="从这里开始写正文……"
                          disabled={isSaving || manuscriptMutationBusy}
                        />
                      ) : (
                        <div className="ms-preview">
                          {draft.trim() ? (
                            splitParagraphs(draft).map((paragraph, index) => (
                              <p key={index}>{paragraph}</p>
                            ))
                          ) : (
                            <span>正文为空</span>
                          )}
                        </div>
                      )}
                      <footer className="ms-chapter-end">
                        <span>{currentWordCount.toLocaleString()} 字</span>
                        <i />
                        <span>
                          {selectedPlan?.sections.length ?? 0} 个计划场景
                        </span>
                        <i />
                        <span>
                          {project.metadata.chapterWordCount
                            ? `目标 ${project.metadata.chapterWordCount.toLocaleString()} 字（±10%）`
                            : "未设置章节目标字数"}
                        </span>
                      </footer>
                    </article>
                  )}
                </div>
                {writingSurface === "chapter" &&
                  editorMode === "edit" &&
                  selectionToolbarPosition &&
                  selection.end > selection.start && (
                    <div
                      className="ms-selection-toolbar"
                      role="toolbar"
                      style={
                        selectionToolbarPosition
                          ? {
                              left: selectionToolbarPosition.left,
                              top: selectionToolbarPosition.top,
                            }
                          : undefined
                      }
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      <span>AI</span>
                      <button
                        type="button"
                        onClick={() =>
                          void runWritingAi("revise", "", {
                            quickSelection: true,
                          })
                        }
                        disabled={!onAiRun || manuscriptMutationBusy}
                      >
                        润色
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void runWritingAi("expand", "", {
                            quickSelection: true,
                          })
                        }
                        disabled={!onAiRun || manuscriptMutationBusy}
                      >
                        扩写
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void runWritingAi(
                            "revise",
                            "完全重写选区的表达与动作组织，但保持所有事实、人物意图和结果不变。",
                            { quickSelection: true },
                          )
                        }
                        disabled={!onAiRun || manuscriptMutationBusy}
                      >
                        重写
                      </button>
                      <i />
                      <button
                        type="button"
                        onClick={() => void markSelectionAsForeshadow()}
                        disabled={manuscriptMutationBusy || !trackingLoaded}
                      >
                        标为伏笔证据
                      </button>
                    </div>
                  )}
                {selectionAiLoading && !candidate && (
                  <SelectionAiLoadingPopover loading={selectionAiLoading} />
                )}
                {candidate &&
                  (candidate.quickSelection && candidate.anchor ? (
                    <SelectionAiCandidatePopover
                      candidate={candidate}
                      onApply={() => applyCandidate()}
                      onDiscard={() => setCandidate(null)}
                      isApplying={isApplyingCandidate}
                    />
                  ) : (
                    <AiCandidatePanel
                      candidate={candidate}
                      onApply={applyCandidate}
                      onDiscard={() => setCandidate(null)}
                      isApplying={isApplyingCandidate}
                    />
                  ))}
                <footer className="ms-writing-footer">
                  <span>
                    <i className="ms-presence-dot" />
                    {dirty ? "本地草稿有修改" : "本地草稿安全"}
                  </span>
                  <span>
                    {selection.end > selection.start
                      ? `已选 ${selection.end - selection.start} 字`
                      : "未选择文本"}
                  </span>
                  <span>正文 {currentWordCount.toLocaleString()} 字</span>
                  <span>
                    本次净增 {sessionDelta >= 0 ? "+" : ""}
                    {sessionDelta.toLocaleString()}
                  </span>
                  <span>
                    预计 {estimatedMinutes} 分钟达到{" "}
                    {chapterWordTarget.toLocaleString()} 字
                  </span>
                </footer>
              </div>
            ) : (
              <EmptyWritingState
                creating={isCreatingChapter}
                onCreate={() => void createChapter()}
              />
            ))}

          {view === "tracking" && (
            <div className="ms-tracking">
              <header className="ms-tracking-header">
                <div>
                  <span className="ms-eyebrow">
                    Reversible continuity ledger
                  </span>
                  <h2>正文状态同步</h2>
                  <p>
                    从已保存正文提取带证据的状态变化，审阅后应用；删除章节会按批次回退。
                  </p>
                </div>
                <div className="ms-room-controls gap-2">
                  <button
                    type="button"
                    className="ns-button is-primary"
                    onClick={() => void runTracking()}
                    disabled={
                      !selectedChapter ||
                      !onAiRun ||
                      manuscriptMutationBusy ||
                      !trackingLoaded
                    }
                  >
                    {trackingBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {trackingBusy
                      ? "正在分析"
                      : !trackingLoaded
                        ? "正在载入状态账本"
                        : "分析当前章节"}
                  </button>
                </div>
              </header>
              {!selectedChapter ? (
                <div className="ms-room-empty">
                  <History className="h-8 w-8" />
                  <p>请先选择章节。</p>
                </div>
              ) : !chapterBatches.length ? (
                <div className="ms-room-empty">
                  <History className="h-8 w-8" />
                  <p>当前章节还没有状态批次。</p>
                </div>
              ) : (
                <div className="ms-batch-list">
                  {chapterBatches.map((batch) => (
                    <section className="ms-batch" key={batch.id}>
                      <header>
                        <div>
                          <span>
                            {new Date(batch.createdAt).toLocaleString("zh-CN")}
                          </span>
                          <h3>{batch.summary || "章节状态变更"}</h3>
                        </div>
                        <span className={`ms-batch-status is-${batch.status}`}>
                          {batch.status === "proposed"
                            ? "待审阅"
                            : batch.status === "applied"
                              ? "已应用"
                              : "已回退"}
                        </span>
                      </header>
                      <div className="ms-change-list">
                        {batch.changes.map((change) => (
                          <article key={change.id}>
                            <span>{DOMAIN_LABELS[change.domain]}</span>
                            <div>
                              <h4>{change.title}</h4>
                              <p>{change.after}</p>
                              <blockquote>{change.evidence}</blockquote>
                            </div>
                          </article>
                        ))}
                      </div>
                      <footer>
                        {batch.status === "proposed" && (
                          <button
                            type="button"
                            className="ns-button is-primary"
                            onClick={() => void applyTrackingSelection(batch)}
                            disabled={manuscriptMutationBusy}
                          >
                            <Check className="h-3.5 w-3.5" /> 应用批次
                          </button>
                        )}
                        {batch.status === "applied" && (
                          <button
                            type="button"
                            className="ns-button"
                            onClick={() =>
                              void setTrackingBatchStatus(batch, "reverted")
                            }
                            disabled={manuscriptMutationBusy}
                          >
                            <History className="h-3.5 w-3.5" /> 回退批次
                          </button>
                        )}
                        {batch.status === "reverted" && (
                          <button
                            type="button"
                            className="ns-button"
                            onClick={() =>
                              void setTrackingBatchStatus(batch, "applied")
                            }
                            disabled={manuscriptMutationBusy}
                          >
                            <ArchiveRestore className="h-3.5 w-3.5" /> 重新应用
                          </button>
                        )}
                      </footer>
                    </section>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>

        <aside
          className={`ms-inspector ${mobileInspectorOpen ? "is-mobile-open" : ""}`}
        >
          <header className="ms-context-header">
            <div>
              <span className="ms-eyebrow">Chapter context</span>
              <strong>本章上下文</strong>
            </div>
            <div>
              <button
                type="button"
                onClick={() => setMobileInspectorOpen(false)}
                title="收起上下文"
                aria-label="收起上下文"
              >
                <PanelRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </header>
          <div className="ms-inspector-tabs">
            {(
              [
                ["plan", "计划"],
                ["chapter", "基本"],
                ["reference", "资料"],
                ["ai", "AI"],
                ["quality", "质量"],
                ["sync", "同步"],
              ] as const
            ).map(([tab, label]) => (
              <button
                type="button"
                className={inspectorView === tab ? "is-active" : ""}
                onClick={() => setInspectorView(tab)}
                key={tab}
              >
                <span>{label}</span>
                {tab === "quality" && qualityReview?.issues.length ? (
                  <b>{qualityReview.issues.length}</b>
                ) : null}
                {tab === "sync" && latestProposedBatch ? (
                  <b>{latestProposedBatch.changes.length}</b>
                ) : null}
              </button>
            ))}
          </div>

          {inspectorView === "plan" && (
            <div className="ms-inspector-scroll ms-context-panel">
              <div className="ms-context-source">
                <GitBranch className="h-3.5 w-3.5" />
                <span>
                  {selectedPlan
                    ? selectedChapter?.planningMode === "detached"
                      ? `正文优先 / 对照：${selectedPlan.title}`
                      : `来源：剧情工程 / ${selectedPlan.title}`
                    : "当前正文未关联剧情章节计划"}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    selectedPlan
                      ? onOpenNarrative()
                      : setInspectorView("chapter")
                  }
                >
                  {selectedPlan ? "打开" : "关联计划"}
                </button>
              </div>
              {!selectedPlan && selectedChapter && (
                <p className="ms-inspector-hint">
                  这是自由正文；可直接创作，阶段完成后在“章节”面板提炼到剧情工程。
                </p>
              )}
              {selectedPlan?.id &&
                selectedChapter?.planningMode === "detached" && (
                  <p className="ms-inspector-hint">
                    本章已明确脱离原规划。计划用于对照，正文与计划冲突时以正文事实为准。
                  </p>
                )}
              <section className="ms-inspector-section">
                <header>
                  <strong>章节目标</strong>
                  <span>只读</span>
                </header>
                <p>{selectedPlan?.description || "尚未填写章节目标。"}</p>
              </section>
              <section className="ms-inspector-section">
                <header>
                  <strong>关键节拍</strong>
                  <span>{selectedPlan?.sections.length ?? 0} 个场景</span>
                </header>
                <ol className="ms-beat-list">
                  {(selectedPlan?.sections ?? []).map((section, index) => {
                    const done = Boolean(
                      section.description &&
                        draft.includes(section.description.slice(0, 12)),
                    );
                    return (
                      <li className={done ? "is-done" : ""} key={section.id}>
                        <i>
                          {done ? <Check className="h-3 w-3" /> : index + 1}
                        </i>
                        <span>
                          <strong>
                            {section.title || `场景 ${index + 1}`}
                          </strong>
                          <small>
                            {section.description || "尚未填写场景说明"}
                          </small>
                        </span>
                      </li>
                    );
                  })}
                  {!selectedPlan?.sections.length && (
                    <li>
                      <i>0</i>
                      <span>
                        <strong>尚未拆分关键节拍</strong>
                        <small>可在剧情工程中添加场景和段落计划。</small>
                      </span>
                    </li>
                  )}
                </ol>
              </section>
              <section className="ms-inspector-section">
                <header>
                  <strong>推进来源</strong>
                </header>
                <div className="ms-tag-row">
                  {(selectedPlan?.lineIds ?? []).map((id) => (
                    <span key={id}>线路 · {id}</span>
                  ))}
                  {(selectedPlan?.arcIds ?? []).map((id) => (
                    <span className="is-green" key={id}>
                      故事弧 · {id}
                    </span>
                  ))}
                  {!selectedPlan?.lineIds.length &&
                    !selectedPlan?.arcIds.length && (
                      <span>未关联线路或故事弧</span>
                    )}
                </div>
              </section>
              <section className="ms-inspector-section">
                <header>
                  <strong>期待动作</strong>
                  <span>
                    {
                      chapterBatches
                        .flatMap((batch) => batch.changes)
                        .filter((change) => change.domain === "foreshadow")
                        .length
                    }{" "}
                    项
                  </span>
                </header>
                {chapterBatches
                  .flatMap((batch) => batch.changes)
                  .filter((change) => change.domain === "foreshadow")
                  .slice(0, 4)
                  .map((change) => (
                    <article className="ms-expectation-row" key={change.id}>
                      <CircleDot className="h-3.5 w-3.5" />
                      <span>
                        <strong>{change.title}</strong>
                        <small>{change.after}</small>
                      </span>
                    </article>
                  ))}
              </section>
              <section className="ms-inspector-section">
                <header>
                  <strong>章节六项交付</strong>
                  <span>正文实时估算</span>
                </header>
                <div className="ms-delivery-grid">
                  {[
                    ["推进", Boolean(draft.trim())],
                    ["代价", /代价|失去|受伤|损耗|牺牲/u.test(draft)],
                    ["规则碰撞", /规则|法则|禁制|限制|反噬/u.test(draft)],
                    ["关系变化", /信任|背叛|承诺|关系|同行/u.test(draft)],
                    ["信息增量", currentWordCount > 600],
                    [
                      "章尾钩子",
                      /[？?!！]|却|忽然|竟|原来/u.test(draft.slice(-180)),
                    ],
                  ].map(([label, done]) => (
                    <span className={done ? "is-done" : ""} key={String(label)}>
                      {done && <Check className="h-3 w-3" />}
                      {label}
                    </span>
                  ))}
                </div>
              </section>
            </div>
          )}

          {inspectorView === "reference" && (
            <div className="ms-inspector-scroll ms-context-panel">
              <section className="ms-reference-summary">
                <BookMarked className="h-5 w-5" />
                <div>
                  <strong>本章关联资料</strong>
                  <p>来自已应用连续性状态与剧情计划关联。</p>
                </div>
              </section>
              {activeTrackingChanges.map((change) => (
                <article className="ms-reference-item" key={change.id}>
                  <span>{DOMAIN_LABELS[change.domain].slice(0, 1)}</span>
                  <div>
                    <strong>{change.title}</strong>
                    <small>{change.after}</small>
                  </div>
                  <button
                    type="button"
                    onClick={() => focusEvidence(change.evidence)}
                    disabled={!draft.includes(change.evidence)}
                  >
                    定位
                  </button>
                </article>
              ))}
              {!activeTrackingChanges.length && (
                <p className="ms-inspector-empty">尚无已应用的关联资料</p>
              )}
            </div>
          )}

          {inspectorView === "ai" && (
            <div className="ms-inspector-scroll ms-context-panel">
              <section className="ms-ai-context-summary">
                <WandSparkles className="h-5 w-5" />
                <div>
                  <strong>正文助手</strong>
                  <p>所有结果先进入候选审阅，不会直接覆盖正文。</p>
                </div>
              </section>
              <div className="ms-ai-action-grid">
                <button
                  type="button"
                  onClick={() => void runWritingAi("continue")}
                  disabled={
                    !selectedChapter ||
                    (!onOpenAiAgent && !onAiRun) ||
                    manuscriptMutationBusy
                  }
                >
                  <PenLine className="h-4 w-4" />
                  <strong>续写</strong>
                  <small>从当前光标继续</small>
                </button>
                <button
                  type="button"
                  onClick={() => void runWritingAi("revise")}
                  disabled={
                    !selectedChapter ||
                    (!onOpenAiAgent && !onAiRun) ||
                    manuscriptMutationBusy
                  }
                >
                  <WandSparkles className="h-4 w-4" />
                  <strong>整章润色</strong>
                  <small>保持事实和声口</small>
                </button>
                <button
                  type="button"
                  onClick={() => void runWritingAi("expand")}
                  disabled={
                    !selectedChapter ||
                    (!onOpenAiAgent && !onAiRun) ||
                    manuscriptMutationBusy
                  }
                >
                  <Maximize2 className="h-4 w-4" />
                  <strong>扩写场景</strong>
                  <small>补足感官和行动</small>
                </button>
                <button
                  type="button"
                  onClick={() => void runQualityReview()}
                  disabled={
                    !selectedChapter ||
                    !onAiRun ||
                    manuscriptMutationBusy ||
                    !draft.trim()
                  }
                >
                  <ShieldCheck className="h-4 w-4" />
                  <strong>质量检查</strong>
                  <small>计划、连续性与钩子</small>
                </button>
              </div>
              <section className="ms-inspector-section">
                <header>
                  <strong>本次上下文</strong>
                  <button type="button" onClick={() => setManifestOpen(true)}>
                    检查清单
                  </button>
                </header>
                <div className="ms-context-meter">
                  <i
                    style={{
                      width: `${Math.min(
                        100,
                        contextManifest.reduce(
                          (sum, source) =>
                            sum +
                            (source.required ||
                            !excludedContextSources.has(source.id)
                              ? source.characters
                              : 0),
                          0,
                        ) / 120,
                      )}%`,
                    }}
                  />
                </div>
                <ul className="ms-context-source-list">
                  {contextManifest.map((source) => (
                    <li key={source.id}>
                      <span>{source.title}</span>
                      <b>
                        {source.required
                          ? "强制"
                          : excludedContextSources.has(source.id)
                            ? "已排除"
                            : source.characters.toLocaleString()}
                      </b>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="ms-inspector-section">
                <header>
                  <strong>创意工作室</strong>
                </header>
                <button
                  type="button"
                  className="ns-button w-full"
                  onClick={() => void openBrainstormRoom()}
                  disabled={!selectedChapter || !onAiRun || manuscriptMutationBusy}
                >
                  <BrainCircuit className="h-3.5 w-3.5" /> 打开 AI 脑暴室
                </button>
                <button
                  type="button"
                  className="ns-button mt-2 w-full"
                  onClick={() => void openSimulationRoom()}
                  disabled={!selectedChapter || !onAiRun || manuscriptMutationBusy}
                >
                  <GitBranch className="h-3.5 w-3.5" /> 打开剧情推演室
                </button>
              </section>
            </div>
          )}

          {inspectorView === "quality" && (
            <div className="ms-inspector-scroll ms-context-panel">
              {qualityReview ? (
                <>
                  {qualityReviewStale && (
                    <div className="ms-quality-stale" role="status">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      正文已变化，这份审查结果仅供参考，请重新检查后再生成修复候选。
                    </div>
                  )}
                  <section className="ms-quality-summary">
                    <div>
                      <strong>{qualityReview.score}</strong>
                      <span>本章质量</span>
                    </div>
                    <p>{qualityReview.summary || "检查已完成"}</p>
                  </section>
                  {qualityReview.issues.map((issue, index) => (
                    <button
                      type="button"
                      className={`ms-quality-issue is-${issue.severity}`}
                      onClick={() => focusEvidence(issue.evidence)}
                      key={`${issue.title}-${index}`}
                    >
                      <AlertTriangle className="h-4 w-4" />
                      <span>
                        <strong>{issue.title}</strong>
                        <small>{issue.detail}</small>
                        {issue.suggestion && <em>{issue.suggestion}</em>}
                      </span>
                      <b>{issue.category}</b>
                    </button>
                  ))}
                  <section className="ms-inspector-section">
                    <header>
                      <strong>已通过</strong>
                      <span>{qualityReview.passed.length} 项</span>
                    </header>
                    <ul className="ms-passed-list">
                      {qualityReview.passed.map((item) => (
                        <li key={item}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> {item}
                        </li>
                      ))}
                    </ul>
                  </section>
                  <button
                    type="button"
                    className="ns-button is-primary w-full"
                    onClick={() =>
                      void runWritingAi(
                        "revise",
                        `修复以下质量问题：${qualityReview.issues.map((issue) => `${issue.title}：${issue.suggestion}`).join("；")}`,
                      )
                    }
                    disabled={
                      !qualityReview.issues.length ||
                      qualityReviewStale ||
                      manuscriptMutationBusy
                    }
                  >
                    <WandSparkles className="h-3.5 w-3.5" /> 生成修复候选
                  </button>
                </>
              ) : (
                <div className="ms-inspector-empty-state">
                  <ShieldCheck className="h-7 w-7" />
                  <p>
                    检查当前草稿的计划、人物声线、连续性、节奏和章尾钩子；不会修改正文。
                  </p>
                  <button
                    type="button"
                    className="ns-button is-primary"
                    onClick={() => void runQualityReview()}
                    disabled={!onAiRun || manuscriptMutationBusy || !draft.trim()}
                  >
                    {qualityBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    开始质量检查
                  </button>
                </div>
              )}
            </div>
          )}

          {inspectorView === "sync" && (
            <div className="ms-inspector-scroll ms-context-panel">
              <section className="ms-sync-banner">
                <History className="h-5 w-5" />
                <div>
                  <strong>
                    {TRACKING_LABELS[selectedChapter?.trackingStatus ?? "idle"]}
                  </strong>
                  <p>状态变化按章节批次保存，可审阅、应用和回退。</p>
                </div>
              </section>
              <button
                type="button"
                className="ns-button is-primary w-full"
                onClick={() => void runTracking()}
                disabled={
                  !selectedChapter ||
                  !onAiRun ||
                  manuscriptMutationBusy ||
                  !trackingLoaded
                }
              >
                {trackingBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {trackingBusy
                  ? "正在分析"
                  : !trackingLoaded
                    ? "正在载入状态账本"
                    : "分析当前章节"}
              </button>
              {latestProposedBatch && (
                <section className="ms-inspector-section">
                  <header>
                    <strong>检测到的变化</strong>
                    <span>
                      {latestProposedBatch.changes.length} 项待确认 · 已选{" "}
                      {latestProposedSelectedIds.length}
                    </span>
                  </header>
                  <div className="ms-sync-changes">
                    {latestProposedBatch.changes.map((change) => {
                      const selectedIds =
                        syncSelections[latestProposedBatch.id] ??
                        latestProposedBatch.changes.map((item) => item.id);
                      return (
                        <label key={change.id}>
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(change.id)}
                            onChange={(event) =>
                              setSyncSelections((current) => {
                                const nextIds = new Set(selectedIds);
                                if (event.target.checked)
                                  nextIds.add(change.id);
                                else nextIds.delete(change.id);
                                return {
                                  ...current,
                                  [latestProposedBatch.id]: [...nextIds],
                                };
                              })
                            }
                          />
                          <span>
                            <strong>{change.title}</strong>
                            <small>{change.after}</small>
                          </span>
                          <b>{DOMAIN_LABELS[change.domain]}</b>
                        </label>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="ns-button is-primary w-full"
                    onClick={() =>
                      void applyTrackingSelection(latestProposedBatch)
                    }
                    disabled={
                      manuscriptMutationBusy ||
                      latestProposedSelectedIds.length === 0
                    }
                  >
                    <Check className="h-3.5 w-3.5" /> 确认并同步选中项（
                    {latestProposedSelectedIds.length}）
                  </button>
                </section>
              )}
              <button
                type="button"
                className="ns-button w-full"
                onClick={() => setView("tracking")}
              >
                <Eye className="h-3.5 w-3.5" /> 查看全部状态批次与回退
              </button>
            </div>
          )}

          {inspectorView === "chapter" &&
            (selectedChapter ? (
              <div className="ms-inspector-scroll">
                <section className="ms-inspector-section">
                  <span className="ms-eyebrow">
                    Chapter{" "}
                    {String(selectedChapter.displayNumber).padStart(2, "0")}
                  </span>
                  <h2>{selectedChapter.title}</h2>
                  <dl>
                    <div>
                      <dt>字数</dt>
                      <dd>{selectedChapter.words.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>状态同步</dt>
                      <dd>{TRACKING_LABELS[selectedChapter.trackingStatus]}</dd>
                    </div>
                  </dl>
                </section>
                <section className="ms-inspector-section">
                  <label>写作状态</label>
                  <CustomSelect
                    value={selectedChapter.status}
                    options={Object.entries(STATUS_LABELS).map(
                      ([value, label]) => ({ value, label }),
                    )}
                    onChange={(value) =>
                      void changeChapterStatus(value as NovelChapterStatus)
                    }
                    ariaLabel="章节状态"
                    size="toolbar"
                    disabled={manuscriptMutationBusy}
                  />
                  <label>章节编号</label>
                  <input
                    className="ms-inline-input"
                    type="number"
                    min={1}
                    step={1}
                    value={displayNumberDraft}
                    onChange={(event) =>
                      setDisplayNumberDraft(event.target.value)
                    }
                    onBlur={() => void commitDisplayNumber()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        setDisplayNumberDraft(
                          String(selectedChapter.displayNumber),
                        );
                        event.currentTarget.blur();
                      }
                    }}
                    aria-label="章节显示编号"
                    disabled={structureLocked || manuscriptMutationBusy}
                  />
                  <label>所属目录</label>
                  <CustomSelect
                    value={selectedChapter.directoryId ?? ""}
                    options={project.chapterIndex.directories.map(
                      (directory) => ({
                        value: directory.id,
                        label: directory.title,
                      }),
                    )}
                    onChange={(value) =>
                      value
                        ? void runManuscriptMutation("chapter-directory", () =>
                            onUpdateChapter(selectedChapter.id, {
                              directoryId: value,
                            }),
                          )
                        : undefined
                    }
                    ariaLabel="章节所属目录"
                    size="toolbar"
                    disabled={structureLocked || manuscriptMutationBusy}
                  />
                  <label>剧情章节计划</label>
                  <CustomSelect
                    value={selectedChapter.narrativeChapterId ?? ""}
                    options={[
                      { value: "", label: "未关联" },
                      ...project.narrative.library.chapters.map((plan) => ({
                        value: plan.id,
                        label: plan.title,
                        suffix:
                          plan.manuscriptChapterId &&
                          plan.manuscriptChapterId !== selectedChapter.id ? (
                            <span className="text-[var(--ink-subtle)]">
                              已关联
                            </span>
                          ) : undefined,
                      })),
                    ]}
                    onChange={(value) =>
                      void runManuscriptMutation("narrative-link", () =>
                        onLinkChapterToNarrative(
                          selectedChapter.id,
                          value || null,
                        ),
                      )
                    }
                    ariaLabel="关联剧情章节计划"
                    size="toolbar"
                    disabled={structureLocked || manuscriptMutationBusy}
                  />
                  {selectedPlan ? (
                    <>
                      <label>正文创作方式</label>
                      <CustomSelect
                        value={selectedChapter.planningMode}
                        options={Object.entries(PLANNING_MODE_LABELS).map(
                          ([value, label]) => ({ value, label }),
                        )}
                        onChange={(value) =>
                          void runManuscriptMutation(
                            "chapter-planning-mode",
                            () =>
                            onUpdateChapter(selectedChapter.id, {
                              planningMode:
                                value as LoadedNovelChapter["planningMode"],
                            }),
                          )
                        }
                        ariaLabel="正文创作方式"
                        size="toolbar"
                        disabled={manuscriptMutationBusy}
                      />
                      <p className="ms-plan-summary">
                        {selectedChapter.planningMode === "detached"
                          ? "正文优先：大纲仅作对照，允许本章明确突破原规划。"
                          : "参考大纲：AI 会参考本章计划，但正文事实始终优先。"}
                      </p>
                    </>
                  ) : (
                    <p className="ms-plan-summary">
                      当前是自由正文，可直接开始创作，完成后再提炼到剧情工程。
                    </p>
                  )}
                  {selectedPlan && (
                    <p className="ms-plan-summary">
                      {selectedPlan.description || "该章节计划尚未填写说明。"}
                    </p>
                  )}
                  <button
                    type="button"
                    className="ns-button is-primary w-full"
                    onClick={openNarrativeExtraction}
                    disabled={!onAiRun || !draft.trim() || manuscriptMutationBusy}
                  >
                    <BookMarked className="h-3.5 w-3.5" /> 提炼到剧情工程
                  </button>
                </section>
                {activeDirectoryId &&
                  project.chapterIndex.directories.some(
                    (directory) => directory.id === activeDirectoryId,
                  ) && (
                    <section className="ms-inspector-section">
                      <h3>当前目录</h3>
                      {(() => {
                        const directory = project.chapterIndex.directories.find(
                          (item) => item.id === activeDirectoryId,
                        )!;
                        const parentOptions = [
                          { value: "", label: "根目录" },
                          ...project.chapterIndex.directories
                            .filter(
                              (item) =>
                                item.id !== directory.id &&
                                !isDirectoryDescendant(item.id, directory.id),
                            )
                            .sort((left, right) =>
                              left.title.localeCompare(right.title, "zh-CN"),
                            )
                            .map((item) => ({
                              value: item.id,
                              label: item.title,
                            })),
                        ];
                        const siblings = project.chapterIndex.directories
                          .filter(
                            (item) => item.parentId === directory.parentId,
                          )
                          .sort((left, right) => left.order - right.order);
                        const siblingPosition = siblings.findIndex(
                          (item) => item.id === directory.id,
                        );
                        return (
                          <>
                            <input
                              className="ms-inline-input"
                              value={
                                editingDirectoryId === directory.id
                                  ? editingDirectoryTitle
                                  : directory.title
                              }
                              disabled={
                                structureLocked || manuscriptMutationBusy
                              }
                              onChange={(event) => {
                                setEditingDirectoryId(directory.id);
                                setEditingDirectoryTitle(event.target.value);
                              }}
                              onBlur={() => {
                                if (editingDirectoryId === directory.id)
                                  void saveDirectoryTitle(directory.id);
                              }}
                              aria-label="当前目录名称"
                            />
                            <label>上级目录</label>
                            <CustomSelect
                              value={directory.parentId ?? ""}
                              options={parentOptions}
                              onChange={(value) =>
                                void runManuscriptMutation(
                                  "directory-parent",
                                  () =>
                                  onUpdateDirectory(directory.id, {
                                    parentId: value || null,
                                  }),
                                )
                              }
                              ariaLabel="当前目录上级目录"
                              size="toolbar"
                              disabled={
                                structureLocked || manuscriptMutationBusy
                              }
                            />
                            <div className="ms-directory-order-actions">
                              <button
                                type="button"
                                className="ns-button flex-1"
                                onClick={() =>
                                  void moveDirectory(directory, -1)
                                }
                                disabled={
                                  structureLocked ||
                                  manuscriptMutationBusy ||
                                  siblingPosition <= 0
                                }
                              >
                                <ArrowUp className="h-3.5 w-3.5" /> 上移
                              </button>
                              <button
                                type="button"
                                className="ns-button flex-1"
                                onClick={() => void moveDirectory(directory, 1)}
                                disabled={
                                  structureLocked ||
                                  manuscriptMutationBusy ||
                                  siblingPosition < 0 ||
                                  siblingPosition >= siblings.length - 1
                                }
                              >
                                <ArrowDown className="h-3.5 w-3.5" /> 下移
                              </button>
                            </div>
                            <label>关联剧情目录</label>
                            <CustomSelect
                              value={directory.narrativeDirectoryId ?? ""}
                              options={[
                                { value: "", label: "未关联" },
                                ...project.narrative.library.directories.map(
                                  (item) => ({
                                    value: item.id,
                                    label: item.title,
                                  }),
                                ),
                              ]}
                              onChange={(value) =>
                                void runManuscriptMutation(
                                  "narrative-directory-link",
                                  () =>
                                    onUpdateDirectory(directory.id, {
                                      narrativeDirectoryId: value || null,
                                    }),
                                )
                              }
                              ariaLabel="关联剧情目录"
                              size="toolbar"
                              disabled={
                                structureLocked || manuscriptMutationBusy
                              }
                            />
                          </>
                        );
                      })()}
                    </section>
                  )}
                <section className="ms-inspector-section">
                  <h3>章节顺序</h3>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="ns-button flex-1"
                      onClick={() => void moveChapter(-1)}
                      disabled={
                        structureLocked ||
                        manuscriptMutationBusy ||
                        selectedChapter.order <= 0
                      }
                    >
                      <ArrowUp className="h-3.5 w-3.5" /> 上移
                    </button>
                    <button
                      type="button"
                      className="ns-button flex-1"
                      onClick={() => void moveChapter(1)}
                      disabled={structureLocked || manuscriptMutationBusy}
                    >
                      <ArrowDown className="h-3.5 w-3.5" /> 下移
                    </button>
                  </div>
                </section>
                <section className="ms-inspector-section">
                  <h3>连续性</h3>
                  <div className="ms-sync-summary">
                    <History className="h-4 w-4" />
                    <div>
                      <strong>
                        {TRACKING_LABELS[selectedChapter.trackingStatus]}
                      </strong>
                      <span>
                        {chapterBatches.length} 个批次 · {appliedBatchCount}{" "}
                        个已应用
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ns-button w-full"
                    onClick={() => setView("tracking")}
                  >
                    <History className="h-3.5 w-3.5" /> 打开状态同步
                  </button>
                </section>
                <section className="ms-inspector-section is-danger-zone">
                  <button
                    type="button"
                    className="ns-button is-danger w-full"
                    onClick={() => setDeleteOpen(true)}
                    disabled={structureLocked || dirty || manuscriptMutationBusy}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> 删除章节
                  </button>
                  {dirty && <p>请先保存正文再删除。</p>}
                </section>
              </div>
            ) : (
              <p className="ms-inspector-empty">选择章节后查看详情</p>
            ))}

          {inspectorView === "typography" && (
            <div className="ms-inspector-scroll">
              <section className="ms-inspector-section">
                <span className="ms-eyebrow">Project typography</span>
                <h2>全局正文排版</h2>
                <p>作用于项目内所有章节的写作纸面与预览。</p>
              </section>
              <section className="ms-inspector-section ms-typography-form">
                <label>排版预设</label>
                <div className="ms-typography-presets">
                  <button
                    type="button"
                    onClick={() =>
                      setTypographyDraft({
                        ...DEFAULT_MANUSCRIPT_TYPOGRAPHY,
                        fontSize: 18,
                        titleSize: 30,
                        lineHeight: 1.95,
                        paragraphSpacing: 12,
                        contentWidth: 760,
                      })
                    }
                  >
                    <strong>专注写作</strong>
                    <small>舒展 · 衬线</small>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setTypographyDraft({
                        ...DEFAULT_MANUSCRIPT_TYPOGRAPHY,
                        fontFamily: "system-sans",
                        fontSize: 16,
                        titleSize: 26,
                        lineHeight: 1.65,
                        paragraphSpacing: 6,
                        firstLineIndent: 0,
                        contentWidth: 880,
                        paperTone: "gray",
                      })
                    }
                  >
                    <strong>紧凑校对</strong>
                    <small>高密 · 无衬线</small>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setTypographyDraft({
                        ...DEFAULT_MANUSCRIPT_TYPOGRAPHY,
                        fontFamily: "kaiti",
                        fontSize: 19,
                        titleSize: 32,
                        lineHeight: 2.1,
                        paragraphSpacing: 16,
                        contentWidth: 680,
                        textAlign: "justify",
                        paperTone: "white",
                      })
                    }
                  >
                    <strong>纸书阅读</strong>
                    <small>窄版 · 楷体</small>
                  </button>
                </div>
                <label>字体</label>
                <CustomSelect
                  value={typographyDraft.fontFamily}
                  options={FONT_OPTIONS}
                  onChange={(value) =>
                    setTypographyDraft((current) => ({
                      ...current,
                      fontFamily: value as ManuscriptTypography["fontFamily"],
                    }))
                  }
                  ariaLabel="正文字体"
                  size="toolbar"
                />
                {(
                  [
                    ["fontSize", "字号", 14, 28, 1, "px"],
                    ["titleSize", "章节标题", 22, 44, 1, "px"],
                    ["lineHeight", "行间距", 1.3, 2.6, 0.1, ""],
                    ["paragraphSpacing", "段落间距", 0, 40, 1, "px"],
                    ["firstLineIndent", "首行缩进", 0, 4, 0.5, "em"],
                    ["contentWidth", "纸面宽度", 560, 1000, 20, "px"],
                  ] as const
                ).map(([key, label, min, max, step, suffix]) => (
                  <label className="ms-range-field" key={key}>
                    <span>
                      {label}
                      <strong>
                        {typographyDraft[key]}
                        {suffix}
                      </strong>
                    </span>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={typographyDraft[key]}
                      onChange={(event) =>
                        setTypographyDraft((current) => ({
                          ...current,
                          [key]: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                ))}
                <label>段落对齐</label>
                <div className="ms-segmented">
                  <button
                    type="button"
                    className={
                      typographyDraft.textAlign === "left" ? "is-active" : ""
                    }
                    onClick={() =>
                      setTypographyDraft((current) => ({
                        ...current,
                        textAlign: "left",
                      }))
                    }
                  >
                    <AlignLeft className="h-3.5 w-3.5" /> 左对齐
                  </button>
                  <button
                    type="button"
                    className={
                      typographyDraft.textAlign === "justify" ? "is-active" : ""
                    }
                    onClick={() =>
                      setTypographyDraft((current) => ({
                        ...current,
                        textAlign: "justify",
                      }))
                    }
                  >
                    <AlignJustify className="h-3.5 w-3.5" /> 两端对齐
                  </button>
                </div>
                <label>纸张底色</label>
                <div className="ms-paper-swatches">
                  {(
                    [
                      ["warm", "暖纸"],
                      ["white", "纯白"],
                      ["gray", "柔灰"],
                    ] as const
                  ).map(([tone, label]) => (
                    <button
                      type="button"
                      className={`is-${tone} ${typographyDraft.paperTone === tone ? "is-active" : ""}`}
                      onClick={() =>
                        setTypographyDraft((current) => ({
                          ...current,
                          paperTone: tone,
                        }))
                      }
                      title={label}
                      aria-label={label}
                      key={tone}
                    />
                  ))}
                </div>
                <div
                  className={`ms-typography-preview is-font-${typographyDraft.fontFamily} is-paper-${typographyDraft.paperTone} is-align-${typographyDraft.textAlign}`}
                  style={editorStyle}
                >
                  <span>实时样张</span>
                  <h3>{selectedChapter?.title ?? "章节标题"}</h3>
                  <p>{excerpt(draft, 92) || "正文排版会实时显示在这里。"}</p>
                </div>
                <button
                  type="button"
                  className="ns-button w-full"
                  onClick={() =>
                    setTypographyDraft({ ...DEFAULT_MANUSCRIPT_TYPOGRAPHY })
                  }
                  disabled={!typographyDirty}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> 恢复项目默认
                </button>
                <button
                  type="button"
                  className="ns-button is-primary w-full"
                  onClick={() =>
                    void runOperation("typography", () =>
                      onSaveTypography(typographyDraft),
                    )
                  }
                  disabled={!typographyDirty || Boolean(operation)}
                >
                  {operation === "typography" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  {typographyDirty ? "保存全局排版" : "排版已保存"}
                </button>
              </section>
            </div>
          )}

          {inspectorView === "trash" && (
            <div className="ms-inspector-scroll">
              <section className="ms-inspector-section">
                <span className="ms-eyebrow">Reversible delete</span>
                <h2>章节回收站</h2>
                <p>恢复章节时会同时恢复该章删除时回退的状态批次。</p>
              </section>
              <div className="ms-trash-list">
                {project.chapterIndex.trash.map((item) => (
                  <article key={item.deletionId}>
                    <div>
                      <strong>{item.title}</strong>
                      <span>
                        {new Date(item.deletedAt).toLocaleString("zh-CN")}
                      </span>
                      <small>{item.rollbackBatchIds.length} 个状态批次</small>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setPermanentDeleteTarget({
                          deletionId: item.deletionId,
                          title: item.title,
                        })
                      }
                      disabled={manuscriptMutationBusy}
                      title="彻底删除（不可恢复）"
                      aria-label={`彻底删除 ${item.title}`}
                      className="ms-trash-purge"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void runManuscriptMutation("restore", () =>
                          onRestoreChapter(item.deletionId),
                        )
                      }
                      disabled={manuscriptMutationBusy}
                      title="恢复章节"
                      aria-label={`恢复 ${item.title}`}
                    >
                      <ArchiveRestore className="h-4 w-4" />
                    </button>
                  </article>
                ))}
                {!project.chapterIndex.trash.length && (
                  <p className="ms-inspector-empty">回收站为空</p>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
      <ManuscriptVersionDialog
        open={versionDialogOpen && Boolean(selectedChapter)}
        chapterTitle={selectedChapter?.title ?? ""}
        currentContent={selectedChapter?.content ?? draft}
        versions={versions}
        selectedVersion={selectedVersion}
        maxVersions={versionSettings?.maxVersions ?? 20}
        versionLimitDraft={versionLimitDraft}
        dirty={dirty}
        busy={operation === "restore-version" || operation === "version-limit"}
        onClose={() => setVersionDialogOpen(false)}
        onSelectVersion={setSelectedVersion}
        onVersionLimitChange={setVersionLimitDraft}
        onVersionLimitBlur={() => {
          const value = Number(versionLimitDraft);
          if (!Number.isInteger(value) || value < 1 || value > 200) {
            setVersionLimitDraft(String(versionSettings?.maxVersions ?? 20));
            return;
          }
          void runOperation("version-limit", async () => {
            await onSaveManuscriptVersionLimit(value);
            const settings = await onLoadManuscriptVersionSettings();
            setVersionSettings(settings);
            setVersionLimitDraft(String(settings.maxVersions));
            if (selectedChapter) {
              setVersions(await onLoadManuscriptVersions(selectedChapter.id));
            }
          });
        }}
        onRestore={(version) => {
          if (!selectedChapter) return;
          void runManuscriptMutation("restore-version", async () => {
            if (
              !window.confirm(
                `恢复到 ${new Date(version.createdAt).toLocaleString("zh-CN")}？当前正文会先保存为一个版本。`,
              )
            ) {
              return;
            }
            await onRestoreManuscriptVersion(
              selectedChapter.id,
              version.versionId,
            );
            const loadedVersions = await onLoadManuscriptVersions(
              selectedChapter.id,
            );
            setVersions(loadedVersions);
            setSelectedVersion(loadedVersions[0] ?? null);
          });
        }}
      />
    </div>
  );
}
