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
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  Eye,
  Filter,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  Link2,
  Loader2,
  Lock,
  Maximize2,
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
  Trash2,
  Unlock,
  WandSparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  CustomSelect,
  DraggableDialogFrame,
  type SelectOption,
  type WorkbenchAvailableProvider,
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
import { createNovelCharacterLibraryRepository } from "./characterLibraryRepository";
import { createNovelFactionLibraryRepository } from "./factionLibraryRepository";
import { createNovelItemLibraryRepository } from "./itemLibraryRepository";
import { createNovelLocationLibraryRepository } from "./locationLibraryRepository";
import { createNovelTimelineLibraryRepository } from "./timelineLibraryRepository";
import {
  getEffectiveModelSceneSelection,
  getModelSceneBinding,
  type ModelSceneSettings,
  type NovelModelSceneId,
} from "./modelSceneSettings";
import {
  createNovelModelSceneSettingsRepository,
  type LoadedModelSceneSettings,
} from "./modelSceneSettingsRepository";
import NarrativeUnsavedChangesGuard from "./NarrativeUnsavedChangesGuard";
import type {
  CreateNovelChapterOptions,
  LoadedNovelChapter,
  LoadedNovelProject,
  UpdateNovelChapterInput,
} from "./repository";
import {
  DEFAULT_MANUSCRIPT_TYPOGRAPHY,
  orderManuscriptChapters,
  type ManuscriptDirectory,
  type ManuscriptDirectoryKind,
  type ManuscriptStructureMode,
  type ManuscriptTypography,
  type NovelChapterStatus,
} from "./projectSchema";

export interface ManuscriptAiRunRequest {
  readonly sceneId: NovelModelSceneId;
  readonly label: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
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
  readonly onSaveChapter: (
    chapterId: string,
    content: string,
    expectedContent: string,
  ) => Promise<void>;
  readonly onAiRun?: (request: ManuscriptAiRunRequest) => Promise<string>;
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

interface AiCandidate {
  readonly mode: WritingAiMode;
  readonly start: number;
  readonly end: number;
  readonly content: string;
  readonly sourceContent: string;
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
  readonly onOpenModelSettings: () => void;
}

type RoomDialogProps = Omit<RoomWorkspaceProps, "kind" | "presentation"> & {
  readonly onClose: () => void;
};

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

const ROOM_ROLES = [
  "剧情结构师",
  "人物动机师",
  "读者情绪师",
  "反套路设计师",
  "因果与规则审计",
  "商业节奏编辑",
] as const;

const SIMULATION_ROLES = [
  "主线演算师",
  "人物因果师",
  "对手行动者",
  "世界规则师",
  "连载节奏师",
  "黑天鹅变量",
] as const;

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

function extractJson(value: string): unknown {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/iu)?.[1];
  const candidate = fenced ?? trimmed;
  const firstArray = candidate.indexOf("[");
  const firstObject = candidate.indexOf("{");
  const start =
    firstArray < 0
      ? firstObject
      : firstObject < 0
        ? firstArray
        : Math.min(firstArray, firstObject);
  const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
  if (start < 0 || end < start)
    throw new Error("AI 返回内容不包含可解析的 JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

function boundedScore(value: unknown, fallback = 0): number {
  const score = Number(value);
  return Number.isFinite(score)
    ? Math.max(0, Math.min(100, Math.round(score)))
    : fallback;
}

function parseRoomSchemes(
  output: string,
  limit: number,
  kind: "brainstorm" | "simulation",
  agent: number,
): RoomScheme[] {
  try {
    const source = extractJson(output);
    const array = Array.isArray(source)
      ? source
      : source &&
          typeof source === "object" &&
          Array.isArray((source as { schemes?: unknown }).schemes)
        ? (source as { schemes: unknown[] }).schemes
        : [];
    const schemes = array.slice(0, limit).map((item, index): RoomScheme => {
      if (typeof item === "string") {
        return {
          title: `方案 ${index + 1}`,
          content: item.trim(),
          premise: item.trim(),
          opening: "",
          category: ["plot", "character", "commercial", "style", "twist"][
            agent % 5
          ] as RoomScheme["category"],
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
          category: "plot",
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
      const title = String(record.title ?? record.name ?? `方案 ${index + 1}`);
      const premise = String(record.premise ?? "").trim();
      const opening = String(record.opening ?? record.draft ?? "").trim();
      const content = [premise, record.outline, record.content, record.risk]
        .filter(
          (part): part is string =>
            typeof part === "string" && Boolean(part.trim()),
        )
        .join("\n\n");
      const rawCategory = record.category;
      const category =
        rawCategory === "character" ||
        rawCategory === "commercial" ||
        rawCategory === "style" ||
        rawCategory === "twist"
          ? rawCategory
          : "plot";
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
        content: content || JSON.stringify(record, null, 2),
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
      category: "plot" as const,
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

function parseTrackingProposal(output: string): {
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
    const operation = (
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
        operation,
      },
    ];
  });
  return {
    summary: typeof record.summary === "string" ? record.summary : "",
    changes,
  };
}

function parseQualityReview(output: string): QualityReview {
  const source = extractJson(output);
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("质量检查必须返回 JSON 对象");
  }
  const record = source as Record<string, unknown>;
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
  return {
    score: Math.max(0, Math.min(100, Number(record.score) || 0)),
    summary: String(record.summary ?? "").trim(),
    issues,
    passed: Array.isArray(record.passed)
      ? record.passed.map((item) => String(item).trim()).filter(Boolean)
      : [],
  };
}

function countCharacters(value: string): number {
  return Array.from(value).filter((character) => !/\s/u.test(character)).length;
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

function AiCandidatePanel({
  candidate,
  onApply,
  onDiscard,
}: {
  readonly candidate: AiCandidate;
  readonly onApply: (content?: string) => void;
  readonly onDiscard: () => void;
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
    <section className="ms-ai-candidate" aria-label={label}>
      <header>
        <div>
          <span className="ms-eyebrow">AI 候选</span>
          <h3>{label}</h3>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="ns-button" onClick={onDiscard}>
            放弃
          </button>
          <button
            type="button"
            className="ns-button"
            onClick={() => setPartialMode((current) => !current)}
            disabled={paragraphs.length < 2}
          >
            <ClipboardCheck className="h-3.5 w-3.5" /> 逐段选择
          </button>
          <button
            type="button"
            className="ns-button is-primary"
            onClick={() =>
              onApply(
                partialMode
                  ? paragraphs
                      .filter((_, index) => selectedParagraphs.has(index))
                      .join("\n\n")
                  : undefined,
              )
            }
            disabled={partialMode && selectedParagraphs.size === 0}
          >
            <Check className="h-3.5 w-3.5" /> 接受并创建新修订
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

const ROOM_MODEL_VALUE_SEPARATOR = "\u0000";

function roomModelValue(selection: WorkbenchModelSelection): string {
  return `${selection.providerId}${ROOM_MODEL_VALUE_SEPARATOR}${selection.model}`;
}

function parseRoomModelValue(
  value: string,
): WorkbenchModelSelection | undefined {
  if (!value) return undefined;
  const separatorIndex = value.indexOf(ROOM_MODEL_VALUE_SEPARATOR);
  if (separatorIndex < 1) return undefined;
  return {
    providerId: value.slice(0, separatorIndex),
    model: value.slice(separatorIndex + ROOM_MODEL_VALUE_SEPARATOR.length),
  };
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

function RoomWorkspace({
  kind,
  presentation = "page",
  storage,
  chapter,
  chapterPlan,
  manuscriptContent,
  enabled,
  onRun,
  onUseBrief,
  onAdoptSimulation,
  onOpenModelSettings,
}: RoomWorkspaceProps) {
  const isBrainstorm = kind === "brainstorm";
  const isDialog = presentation === "dialog";
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
  const [brainstormFilter, setBrainstormFilter] = useState<
    "all" | RoomScheme["category"]
  >("all");
  const [expandedSchemes, setExpandedSchemes] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const activeConfigs = configs.filter((config) => config.enabled);

  const runModelProviders = useMemo(
    () => availableProviders.filter((provider) => !provider.runtimeBacked),
    [availableProviders],
  );
  const roomModelOptions = useMemo<SelectOption[]>(() => {
    const projectDefault = loadedModelSettings?.settings.defaultModel;
    return [
      {
        value: "",
        label: projectDefault
          ? `默认 · ${roomModelLabel(projectDefault, runModelProviders)}`
          : "跟随全局默认模型",
      },
      ...runModelProviders.flatMap((provider) =>
        provider.models.map((model) => ({
          value: roomModelValue({
            providerId: provider.id,
            model: model.model,
          }),
          label: model.modelName || model.model,
          suffix: provider.name,
        })),
      ),
    ];
  }, [loadedModelSettings?.settings.defaultModel, runModelProviders]);

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

  const saveRoomModel = async (
    sceneId: NovelModelSceneId,
    value: string,
  ): Promise<void> => {
    if (!loadedModelSettings || savingModelSceneId) return;
    const selection = parseRoomModelValue(value);
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
      activeConfigs.flatMap((config) => config.modules),
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
            .then((loaded) => {
              context.characters = loaded.index.characters.map((character) => ({
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
        ? Promise.all([
            storage.stat(["world/rules.json", "world/worldview.md"]),
          ]).then(async ([files]) => {
            const values = await Promise.all(
              ["world/rules.json", "world/worldview.md"].map((path, index) =>
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
            };
          })
        : Promise.resolve(),
    ]);
    return context;
  };

  const run = async () => {
    if (!chapter || running.size || !activeConfigs.length) return;
    setError(null);
    setResults([]);
    setAdopted(new Set());
    setExpandedSchemes(new Set());
    setRunning(new Set(activeConfigs.map((config) => config.agent)));
    let moduleContext: Partial<Record<RoomContextModule, unknown>>;
    try {
      moduleContext = await loadRoomModuleContext();
    } catch (cause) {
      setRunning(new Set());
      setError(`上下文模块读取失败：${errorText(cause)}`);
      return;
    }
    const tasks = activeConfigs.map(async (config) => {
      const agent = config.agent;
      const role = roles[agent - 1];
      const sceneId = `manuscript.${kind}.agent${agent}` as NovelModelSceneId;
      try {
        const output = await onRun({
          sceneId,
          label: `${isBrainstorm ? "正文脑暴" : "剧情推演"} · Agent ${agent}`,
          systemPrompt: isBrainstorm
            ? `你是${role}。独立提出有明显差异的正文创作方案，不复述题面，不代替作者做最终决定。只输出 JSON 数组，每项包含 title、premise、outline、opening、category(plot|character|commercial|style|twist)、score(0-100)、tags。`
            : `你是${role}。依据现有正文和章节计划推演后续因果，不强行制造反转。只输出 JSON 数组，每项包含 title、premise、outline、riskLevel(low|medium|high)、coherence(0-100)、novelty(0-100)、riskScore(0-100)、tags、nodes；nodes 每项包含 offset(距起点章数)、title、summary、checkpoint。`,
          prompt: [
            `作品章节：${chapter.title}`,
            chapterPlan
              ? `章节计划：${chapterPlan.description}`
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
        return {
          agent,
          role,
          schemes: parseRoomSchemes(output, config.schemeCount, kind, agent),
        } satisfies RoomAgentResult;
      } catch (cause) {
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
    const next = await Promise.all(tasks);
    setResults(next);
    if (next.every((item) => item.error))
      setError("所有 Agent 都未返回可用方案");
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
  const visibleSimulationSchemes = simulationSchemes.filter(
    (item) => simulationFilter === "all" || item.kind === simulationFilter,
  );
  const resultSchemeCount = results.reduce(
    (sum, result) => sum + result.schemes.length,
    0,
  );
  const requestedSchemeCount = activeConfigs.reduce(
    (sum, item) => sum + item.schemeCount,
    0,
  );
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
      <button type="button" className="ns-button" onClick={onOpenModelSettings}>
        <Settings2 className="h-3.5 w-3.5" /> 配置各路模型
      </button>
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
            ? `开始脑暴 · ${requestedSchemeCount} 方案`
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
                  options={[3, 5, 8, 10].map((count) => ({
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
              return (
                <div
                  className={`ms-agent-config-row ${config.enabled ? "" : "is-disabled"}`}
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
                  <span className="ms-agent-index">
                    {String(config.agent).padStart(2, "0")}
                  </span>
                  <div className="ms-agent-identity">
                    <strong>{roles[config.agent - 1]}</strong>
                    <small>
                      {effectiveModel
                        ? `${roomModelLabel(effectiveModel, runModelProviders)} · Agent ${config.agent}`
                        : `独立模型场景 · Agent ${config.agent}`}
                    </small>
                  </div>
                  <CustomSelect
                    value={modelBinding ? roomModelValue(modelBinding) : ""}
                    options={roomModelOptions}
                    onChange={(value) => void saveRoomModel(sceneId, value)}
                    disabled={
                      !config.enabled ||
                      !loadedModelSettings ||
                      savingModelSceneId !== null
                    }
                    ariaLabel={`Agent ${config.agent} 模型`}
                    className="ms-agent-model-select"
                    compact
                  />
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
                  {moduleEditorAgent === config.agent && (
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
          {isDialog && isBrainstorm && (
            <div className="ms-brainstorm-results-heading">
              <div>
                <strong>候选方案</strong>
                <span>
                  {resultSchemeCount
                    ? `已返回 ${resultSchemeCount} 个方案`
                    : `等待 ${activeConfigs.length} 路 Agent 独立产出`}
                </span>
              </div>
              <div className="ms-brainstorm-heading-actions">
                <span>预计 {requestedSchemeCount} 个方案</span>
                <div className="ms-segmented" aria-label="脑暴方案筛选">
                  {(
                    [
                      ["all", "全部"],
                      ["plot", "剧情"],
                      ["character", "人物"],
                      ["commercial", "商业"],
                      ["style", "文风"],
                      ["twist", "反转"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      className={brainstormFilter === value ? "is-active" : ""}
                      onClick={() => setBrainstormFilter(value)}
                      key={value}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
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
          {!results.length && !running.size ? (
            <div className="ms-room-empty">
              {isBrainstorm ? (
                <BrainCircuit className="h-8 w-8" />
              ) : (
                <GitBranch className="h-8 w-8" />
              )}
              <p>
                每个 Agent 可单独启用并配置 1～5 个方案，模型在独立场景中设置。
              </p>
            </div>
          ) : isBrainstorm ? (
            <div className="ms-agent-grid">
              {activeConfigs.map(({ agent }) => {
                const result = results.find((item) => item.agent === agent);
                const isRunning = running.has(agent);
                return (
                  <section className="ms-agent-column" key={agent}>
                    <header>
                      <span className="ms-agent-index">
                        {String(agent).padStart(2, "0")}
                      </span>
                      <div>
                        <h3>{roles[agent - 1]}</h3>
                        <p>Agent {agent} · 独立模型</p>
                      </div>
                      {isRunning && (
                        <Loader2 className="ml-auto h-4 w-4 animate-spin" />
                      )}
                    </header>
                    {result?.error && (
                      <div className="ms-agent-error">{result.error}</div>
                    )}
                    {result?.schemes
                      .filter(
                        (scheme) =>
                          brainstormFilter === "all" ||
                          scheme.category === brainstormFilter,
                      )
                      .map((scheme, schemeIndex) => {
                        const schemeKey = `brainstorm-${agent}-${schemeIndex}`;
                        const expanded = expandedSchemes.has(schemeKey);
                        return (
                          <article
                            className="ms-scheme"
                            key={`${agent}-${schemeIndex}`}
                          >
                            <div className="ms-scheme-topline">
                              <span>方案 {schemeIndex + 1}</span>
                              {scheme.score > 0 && (
                                <b className="ms-scheme-score">
                                  {scheme.score} 分
                                </b>
                              )}
                            </div>
                            <h4>{scheme.title}</h4>
                            {scheme.tags.length > 0 && (
                              <div className="ms-scheme-tags">
                                {scheme.tags.map((tag) => (
                                  <i key={tag}>{tag}</i>
                                ))}
                              </div>
                            )}
                            <p>{scheme.premise || scheme.content}</p>
                            {scheme.opening && (
                              <>
                                <button
                                  type="button"
                                  className="ms-scheme-expand"
                                  onClick={() =>
                                    setExpandedSchemes((current) => {
                                      const next = new Set(current);
                                      if (next.has(schemeKey))
                                        next.delete(schemeKey);
                                      else next.add(schemeKey);
                                      return next;
                                    })
                                  }
                                >
                                  {expanded ? "收起正文稿" : "查看正文稿"}
                                  {expanded ? (
                                    <ChevronDown className="h-3 w-3" />
                                  ) : (
                                    <ChevronRight className="h-3 w-3" />
                                  )}
                                </button>
                                {expanded && (
                                  <p className="ms-scheme-opening">
                                    {scheme.opening}
                                  </p>
                                )}
                              </>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                onUseBrief(
                                  `${scheme.title}\n${scheme.content}${scheme.opening ? `\n\n正文稿：\n${scheme.opening}` : ""}`,
                                )
                              }
                            >
                              <WandSparkles className="h-3.5 w-3.5" />
                              作为正文创作指令
                            </button>
                          </article>
                        );
                      })}
                  </section>
                );
              })}
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

function BrainstormRoomDialog({
  storage,
  chapter,
  chapterPlan,
  manuscriptContent,
  enabled,
  onRun,
  onUseBrief,
  onAdoptSimulation,
  onOpenModelSettings,
  onClose,
}: RoomDialogProps) {
  useCloseLayer(() => {
    onClose();
    return true;
  }, 222);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <DraggableDialogFrame
      ariaLabel="AI 多 Agent 脑暴室"
      className="ms-room-dialog h-[min(820px,calc(100vh-3rem))] w-[min(1480px,calc(100vw-3rem))] max-sm:h-[calc(100vh-1.5rem)] max-sm:w-[calc(100vw-1.5rem)]"
      overlayClassName="bg-black/35 backdrop-blur-sm"
      headerClassName="ms-room-dialog-header"
      header={
        <div className="ms-room-dialog-titlebar">
          <div className="min-w-0 flex-1">
            <span className="ms-eyebrow">Multi-Agent room</span>
            <h2>
              {chapter ? `第 ${chapter.displayNumber} 章` : "当前章节"} · 多
              Agent 脑暴室
            </h2>
            <p>六个角色共享同一冻结上下文，彼此独立产出，不修改正文。</p>
          </div>
          <span className="ms-context-snapshot">
            上下文快照 · {chapter ? `CH-${chapter.displayNumber}` : "未绑定"}
          </span>
          <button
            type="button"
            className="ns-icon-button border-0"
            onClick={onClose}
            aria-label="关闭 AI 脑暴室"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <RoomWorkspace
        kind="brainstorm"
        presentation="dialog"
        storage={storage}
        chapter={chapter}
        chapterPlan={chapterPlan}
        manuscriptContent={manuscriptContent}
        enabled={enabled}
        onRun={onRun}
        onUseBrief={onUseBrief}
        onAdoptSimulation={onAdoptSimulation}
        onOpenModelSettings={onOpenModelSettings}
      />
    </DraggableDialogFrame>
  );
}

function SimulationRoomDialog({
  storage,
  chapter,
  chapterPlan,
  manuscriptContent,
  enabled,
  onRun,
  onUseBrief,
  onAdoptSimulation,
  onOpenModelSettings,
  onClose,
}: RoomDialogProps) {
  useCloseLayer(() => {
    onClose();
    return true;
  }, 223);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
            aria-label="关闭 AI 剧情推演室"
            title="关闭"
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
        manuscriptContent={manuscriptContent}
        enabled={enabled}
        onRun={onRun}
        onUseBrief={onUseBrief}
        onAdoptSimulation={onAdoptSimulation}
        onOpenModelSettings={onOpenModelSettings}
      />
    </DraggableDialogFrame>
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
  onSaveChapter,
  onAiRun,
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
  const selectedChapterSequence = canonicalChapters.findIndex(
    (chapter) => chapter.id === selectedChapterId,
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
  const [candidate, setCandidate] = useState<AiCandidate | null>(null);
  const [creativeBrief, setCreativeBrief] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [aiMode, setAiMode] = useState<WritingAiMode | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [trackingLoaded, setTrackingLoaded] = useState<Awaited<
    ReturnType<ReturnType<typeof createManuscriptTrackingRepository>["load"]>
  > | null>(null);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [qualityReview, setQualityReview] = useState<QualityReview | null>(
    null,
  );
  const [qualityBusy, setQualityBusy] = useState(false);
  const [manifestOpen, setManifestOpen] = useState(false);
  const [brainstormOpen, setBrainstormOpen] = useState(false);
  const [simulationOpen, setSimulationOpen] = useState(false);
  const [excludedContextSources, setExcludedContextSources] = useState<
    ReadonlySet<string>
  >(new Set());
  const [syncSelections, setSyncSelections] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentChapterIdRef = useRef(selectedChapter?.id ?? null);
  currentChapterIdRef.current = selectedChapter?.id ?? null;
  const trackingRepository = useMemo(
    () => createManuscriptTrackingRepository(storage),
    [storage],
  );
  const dirty = Boolean(selectedChapter && draft !== savedDraft);
  const typographyDirty =
    JSON.stringify(typographyDraft) !==
    JSON.stringify(project.chapterIndex.typography);
  const structureLocked = project.chapterIndex.structureMode === "locked";
  const hydratedChapterIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    setTypographyDraft(project.chapterIndex.typography);
  }, [project.chapterIndex.typography]);

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
      return;
    }
    setDraft(selectedChapter.content);
    setSavedDraft(selectedChapter.content);
    setTitleDraft(selectedChapter.title);
    setDisplayNumberDraft(String(selectedChapter.displayNumber));
    setSelection({ start: 0, end: 0 });
    setCandidate(null);
    setQualityReview(null);
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
    if (isSaving) return false;
    setIsSaving(true);
    setError(null);
    try {
      await onSaveChapter(selectedChapter.id, draft, savedDraft);
      setSavedDraft(draft);
      setExternalChanged(false);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [draft, isSaving, onSaveChapter, savedDraft, selectedChapter]);

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

  const requestChapter = async (chapterId: string) => {
    if (chapterId === selectedChapter?.id) return;
    if (!(await saveCurrent())) return;
    const target = project.chapters.find((chapter) => chapter.id === chapterId);
    if (target?.status === "planned" && target.narrativeChapterId) {
      try {
        await onUpdateChapter(chapterId, { status: "draft" });
      } catch (cause) {
        setError(errorText(cause));
        return;
      }
    }
    onSelectChapter(chapterId);
  };

  const commitTitle = async () => {
    if (!selectedChapter) return;
    const title = titleDraft.trim();
    if (!title) {
      setTitleDraft(selectedChapter.title);
      return;
    }
    if (title === selectedChapter.title) return;
    try {
      await onRenameChapter(selectedChapter.id, title);
    } catch (cause) {
      setTitleDraft(selectedChapter.title);
      setError(errorText(cause));
    }
  };

  const commitDisplayNumber = async () => {
    if (!selectedChapter) return;
    const displayNumber = Number(displayNumberDraft);
    if (!Number.isInteger(displayNumber) || displayNumber < 1) {
      setDisplayNumberDraft(String(selectedChapter.displayNumber));
      setError("章节编号必须是正整数");
      return;
    }
    if (displayNumber === selectedChapter.displayNumber) return;
    try {
      await onUpdateChapter(selectedChapter.id, { displayNumber });
    } catch (cause) {
      setDisplayNumberDraft(String(selectedChapter.displayNumber));
      setError(errorText(cause));
    }
  };

  const runOperation = async (name: string, task: () => Promise<void>) => {
    if (operation) return;
    setOperation(name);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setOperation(null);
    }
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
    if (!(await saveCurrent())) return;
    try {
      const id = await onCreateChapter({ directoryId: activeDirectoryId });
      onSelectChapter(id);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const createDirectory = async () => {
    const title = directoryTitle.trim();
    if (!title) return;
    await runOperation("create-directory", async () => {
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
    const title = editingDirectoryTitle.trim();
    if (!title) return;
    await runOperation("rename-directory", async () => {
      await onUpdateDirectory(directoryId, { title });
      setEditingDirectoryId(null);
    });
  };

  const moveChapter = async (direction: -1 | 1) => {
    if (!selectedChapter || structureLocked) return;
    const siblings = project.chapters
      .filter((chapter) => chapter.directoryId === selectedChapter.directoryId)
      .sort((left, right) => left.order - right.order);
    const position = siblings.findIndex(
      (chapter) => chapter.id === selectedChapter.id,
    );
    const target = position + direction;
    if (position < 0 || target < 0 || target >= siblings.length) return;
    await runOperation("reorder-chapter", () =>
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
    if (structureLocked) return;
    const siblings = project.chapterIndex.directories
      .filter((item) => item.parentId === directory.parentId)
      .sort((left, right) => left.order - right.order);
    const position = siblings.findIndex((item) => item.id === directory.id);
    const target = position + direction;
    if (position < 0 || target < 0 || target >= siblings.length) return;
    await runOperation("reorder-directory", () =>
      onUpdateDirectory(directory.id, { order: target }),
    );
  };

  const moveChapterTo = async (
    chapterId: string,
    directoryId: string,
    order?: number,
  ) => {
    if (structureLocked || chapterId === "") return;
    await runOperation("move-chapter", () =>
      onUpdateChapter(chapterId, {
        directoryId,
        ...(order === undefined ? {} : { order }),
      }),
    );
    setDraggedChapterId(null);
    setDragOverDirectoryId(null);
  };

  const selectedPlan = selectedChapter?.narrativeChapterId
    ? project.narrative.library.chapters.find(
        (plan) => plan.id === selectedChapter.narrativeChapterId,
      )
    : undefined;

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
          ? `${selectedPlan.title} · ${selectedPlan.sections.length} 个场景`
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

  const runWritingAi = async (mode: WritingAiMode, instruction = "") => {
    if (!selectedChapter || !onAiRun || aiMode) return;
    const requestChapterId = selectedChapter.id;
    const sourceContent = draft;
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
            : { start: 0, end: draft.length };
    const sceneId = `manuscript.${mode}` as NovelModelSceneId;
    const actionLabel = {
      generate: "完整生成",
      continue: "续写",
      revise: "润色",
      expand: "扩写",
    }[mode];
    setAiMode(mode);
    setError(null);
    try {
      const output = await onAiRun({
        sceneId,
        label: `${selectedChapter.title} · ${actionLabel}`,
        systemPrompt:
          "你是中文长篇小说正文编辑。严格服从已有设定、章节计划和正文事实；只输出可直接写入正文的文本，不解释过程，不使用 Markdown 代码围栏。",
        prompt: [
          `动作：${actionLabel}`,
          `章节：${selectedChapter.title}`,
          selectedPlan
            ? `章节计划：${selectedPlan.description}`
            : "章节计划：未关联",
          creativeBrief ? `作者选定的创作指令：${creativeBrief}` : "",
          instruction ? `本次专项要求：${instruction}` : "",
          buildOptionalContext(),
          mode === "continue"
            ? `已有正文：\n${sourceContent}`
            : `待处理文本：\n${target || "（空）"}`,
          mode === "expand"
            ? "扩展细节、动作、感官和对话，但不得推进到计划之外。"
            : "",
          mode === "revise"
            ? "保留事实、情节和人物声口，消除模板腔与机械工整感。"
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      if (currentChapterIdRef.current !== requestChapterId) return;
      setCandidate({
        mode,
        ...range,
        content: stripCodeFence(output),
        sourceContent,
      });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setAiMode(null);
    }
  };

  const applyCandidate = (contentOverride?: string) => {
    if (!candidate) return;
    if (draft !== candidate.sourceContent) {
      setError("AI 候选生成后正文已经变化，请放弃候选并基于当前正文重新生成");
      return;
    }
    const spacer =
      candidate.mode === "continue" &&
      candidate.start > 0 &&
      !draft.endsWith("\n")
        ? "\n\n"
        : "";
    const nextContent = contentOverride ?? candidate.content;
    const next = `${draft.slice(0, candidate.start)}${spacer}${nextContent}${draft.slice(candidate.end)}`;
    setDraft(next);
    setCandidate(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const runTracking = async () => {
    if (!selectedChapter || !onAiRun || trackingBusy || !trackingLoaded) return;
    if (!(await saveCurrent())) return;
    setTrackingBusy(true);
    setError(null);
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
        prompt: `章节：${selectedChapter.title}\n\n章节计划：${selectedPlan?.description ?? "未关联"}\n\n可引用实体目录：\n${JSON.stringify(entityCatalog, null, 2)}\n\n正文：\n${draft}`,
      });
      const proposal = parseTrackingProposal(output);
      const before = trackingLoaded;
      const next = await trackingRepository.createProposal(before, {
        chapterId: selectedChapter.id,
        chapterContentHash: hashManuscriptContent(draft),
        summary: proposal.summary,
        changes: proposal.changes,
      });
      await commitTrackingUpdate(before, next, selectedChapter.id, {
        trackingStatus: "review",
      });
    } catch (cause) {
      await onUpdateChapter(selectedChapter.id, {
        trackingStatus: "failed",
      }).catch(() => undefined);
      setError(errorText(cause));
    } finally {
      setTrackingBusy(false);
    }
  };

  const runQualityReview = async () => {
    if (!selectedChapter || !onAiRun || qualityBusy) return;
    setQualityBusy(true);
    setError(null);
    try {
      const output = await onAiRun({
        sceneId: "manuscript.quality",
        label: `${selectedChapter.title} · 正文质量检查`,
        systemPrompt:
          '你是中文长篇小说质量编辑。只输出 JSON：{"score":0,"summary":"","issues":[{"category":"计划|连续性|人物|节奏|文风|钩子","severity":"error|warning|suggestion","title":"","detail":"","evidence":"正文逐字引文","suggestion":""}],"passed":[""]}。必须以正文证据为准，不虚构设定。',
        prompt: [
          `章节：${selectedChapter.title}`,
          `章节计划：${selectedPlan?.description ?? "未关联"}`,
          selectedPlan?.sections.length
            ? `场景节拍：${selectedPlan.sections.map((section) => `${section.title}：${section.description}`).join("；")}`
            : "",
          buildOptionalContext(),
          `正文：\n${draft || "（空）"}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      setQualityReview(parseQualityReview(output));
      setInspectorView("quality");
      setMobileInspectorOpen(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setQualityBusy(false);
    }
  };

  const focusEvidence = (evidence: string) => {
    if (!evidence) return;
    const start = draft.indexOf(evidence);
    if (start < 0) return;
    const end = start + evidence.length;
    setWritingSurface("chapter");
    setEditorMode("edit");
    setSelection({ start, end });
    setMobilePane("editor");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(start, end);
    });
  };

  const markSelectionAsForeshadow = async () => {
    if (!selectedChapter || !trackingLoaded || selection.end <= selection.start)
      return;
    if (!(await saveCurrent())) return;
    const evidence = draft.slice(selection.start, selection.end).trim();
    if (!evidence) return;
    await runOperation("foreshadow-evidence", async () => {
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
    await runOperation("tracking-status", async () => {
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
    await runOperation("tracking-selection", async () => {
      const before = trackingLoaded;
      const next = await trackingRepository.applyBatchSelection(
        before,
        batch.id,
        selectedIds,
        {
          id: selectedChapter.id,
          number: selectedChapter.displayNumber,
          sequence: selectedChapterSequence + 1,
          title: selectedChapter.title,
          content: draft,
        },
      );
      await commitTrackingUpdate(before, next, selectedChapter.id, {
        trackingStatus: "synced",
        lastTrackedAt: new Date().toISOString(),
      });
    });
  };

  const changeChapterStatus = async (status: NovelChapterStatus) => {
    if (!selectedChapter) return;
    await runOperation("chapter-status", async () => {
      const shouldTrack =
        status === "complete" && selectedChapter.trackingStatus !== "synced";
      if (shouldTrack && !draft.trim()) {
        throw new Error("空白章节不能标记为已完成");
      }
      if (shouldTrack && !onAiRun) {
        throw new Error("当前没有可用模型，无法完成章节状态同步");
      }
      await onUpdateChapter(selectedChapter.id, { status });
      if (!shouldTrack) return;
      setView("tracking");
      setInspectorView("sync");
      setMobileInspectorOpen(true);
      await runTracking();
    });
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

  const deleteChapter = async () => {
    if (!selectedChapter || operation) return;
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
        draggable={!structureLocked}
        className={`ms-chapter-row ${active ? "is-active" : ""} ${draggedChapterId === chapter.id ? "is-dragging" : ""}`}
        style={{ "--tree-depth": depth } as CSSProperties}
        onClick={() => void requestChapter(chapter.id)}
        onDragStart={(event) => {
          if (structureLocked) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", chapter.id);
          setDraggedChapterId(chapter.id);
        }}
        onDragEnd={() => {
          setDraggedChapterId(null);
          setDragOverDirectoryId(null);
        }}
        onDragOver={(event) => {
          if (!draggedChapterId || draggedChapterId === chapter.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!draggedChapterId || draggedChapterId === chapter.id) return;
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
            if (!draggedChapterId || structureLocked) return;
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
            if (!draggedChapterId || structureLocked) return;
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
          {selected && !structureLocked && (
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
                      void runOperation("delete-directory", () =>
                        onDeleteDirectory(directory.id),
                      )
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
  const remainingTarget = Math.max(0, 3000 - currentWordCount);
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

  return (
    <div className="ms-studio">
      <NarrativeUnsavedChangesGuard
        dirty={dirty || typographyDirty}
        label="正文"
        registerNavigationGuard={registerNavigationGuard}
        onSave={saveAll}
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
      {brainstormOpen && (
        <BrainstormRoomDialog
          key={`brainstorm-${selectedChapter?.id ?? "empty"}`}
          storage={storage}
          chapter={selectedChapter}
          chapterPlan={selectedPlan}
          manuscriptContent={draft}
          enabled={Boolean(onAiRun)}
          onRun={onAiRun ?? (() => Promise.reject(new Error("AI 当前不可用")))}
          onUseBrief={(brief) => {
            setCreativeBrief(brief);
            setView("write");
            setBrainstormOpen(false);
          }}
          onAdoptSimulation={onAdoptSimulation}
          onOpenModelSettings={onOpenModelSettings}
          onClose={() => setBrainstormOpen(false)}
        />
      )}
      {simulationOpen && (
        <SimulationRoomDialog
          key={`simulation-${selectedChapter?.id ?? "empty"}`}
          storage={storage}
          chapter={selectedChapter}
          chapterPlan={selectedPlan}
          manuscriptContent={draft}
          enabled={Boolean(onAiRun)}
          onRun={onAiRun ?? (() => Promise.reject(new Error("AI 当前不可用")))}
          onUseBrief={(brief) => {
            setCreativeBrief(brief);
            setView("write");
            setSimulationOpen(false);
          }}
          onAdoptSimulation={onAdoptSimulation}
          onOpenModelSettings={onOpenModelSettings}
          onClose={() => setSimulationOpen(false)}
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
          {project.chapterIndexNeedsMigration && (
            <span className="ms-migration-note">保存任一结构设置后升级 v2</span>
          )}
        </div>
        <div className="ms-workbench-actions" aria-label="正文辅助工具">
          {STUDIO_ACTIONS.map((action) => {
            const Icon = action.icon;
            const isActive =
              (action.id === "brainstorm" && brainstormOpen) ||
              (action.id === "simulation" && simulationOpen) ||
              (action.id === "tracking" && view === "tracking");
            return (
              <button
                key={action.id}
                type="button"
                className={`ns-button ms-workbench-action ${isActive ? "is-active" : ""}`}
                onClick={() => {
                  if (action.id === "brainstorm") setBrainstormOpen(true);
                  else if (action.id === "simulation") setSimulationOpen(true);
                  else setView("tracking");
                }}
                title={action.label}
                aria-label={action.label}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{action.label}</span>
              </button>
            );
          })}
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
            onClick={() =>
              void runOperation("structure-mode", () =>
                onSetStructureMode(structureLocked ? "merged" : "locked"),
              )
            }
            disabled={Boolean(operation)}
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
            onClick={() => void runOperation("sync", onSynchronizeNarrative)}
            disabled={Boolean(operation)}
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
            title="打开章节与排版面板"
            aria-label="打开章节与排版面板"
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
                disabled={structureLocked}
                title="新建目录"
                aria-label="新建目录"
              >
                <Folder className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void createChapter()}
                disabled={structureLocked || isCreatingChapter}
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
                      disabled={structureLocked}
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
                      onClick={() => void runWritingAi("generate")}
                      disabled={!onAiRun || Boolean(aiMode)}
                      title="生成完整正文"
                    >
                      <Sparkles className="h-3.5 w-3.5" /> 完整生成
                    </button>
                    <button
                      type="button"
                      onClick={() => void runWritingAi("continue")}
                      disabled={!onAiRun || Boolean(aiMode)}
                      title="从光标处续写"
                    >
                      <PenLine className="h-3.5 w-3.5" /> 续写
                    </button>
                    <button
                      type="button"
                      onClick={() => void runWritingAi("revise")}
                      disabled={!onAiRun || Boolean(aiMode)}
                      title="润色选区；无选区时处理全文"
                    >
                      <WandSparkles className="h-3.5 w-3.5" /> 润色
                    </button>
                    <button
                      type="button"
                      onClick={() => void runWritingAi("expand")}
                      disabled={!onAiRun || Boolean(aiMode)}
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
                    disabled={!onAiRun || qualityBusy || !draft.trim()}
                    title="检查正文质量"
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
                  <div className="ms-creative-brief">
                    <WandSparkles className="h-3.5 w-3.5" />
                    <span>{creativeBrief}</span>
                    <button
                      type="button"
                      onClick={() => setCreativeBrief("")}
                      aria-label="清除创作指令"
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
                      onClick={() => {
                        setDraft(selectedChapter.content);
                        setSavedDraft(selectedChapter.content);
                        setExternalChanged(false);
                      }}
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
                            setSelection({
                              start: event.currentTarget.selectionStart,
                              end: event.currentTarget.selectionEnd,
                            })
                          }
                          spellCheck={false}
                          aria-label="章节正文"
                          placeholder="从这里开始写正文……"
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
                        <span>目标 3,000 字</span>
                      </footer>
                    </article>
                  )}
                </div>
                {writingSurface === "chapter" &&
                  editorMode === "edit" &&
                  selection.end > selection.start && (
                    <div className="ms-selection-toolbar" role="toolbar">
                      <span>AI</span>
                      <button
                        type="button"
                        onClick={() => void runWritingAi("revise")}
                        disabled={!onAiRun || Boolean(aiMode)}
                      >
                        润色
                      </button>
                      <button
                        type="button"
                        onClick={() => void runWritingAi("expand")}
                        disabled={!onAiRun || Boolean(aiMode)}
                      >
                        扩写
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void runWritingAi(
                            "revise",
                            "完全重写选区的表达与动作组织，但保持所有事实、人物意图和结果不变。",
                          )
                        }
                        disabled={!onAiRun || Boolean(aiMode)}
                      >
                        重写
                      </button>
                      <i />
                      <button
                        type="button"
                        onClick={() => void markSelectionAsForeshadow()}
                        disabled={Boolean(operation)}
                      >
                        标为伏笔证据
                      </button>
                    </div>
                  )}
                {candidate && (
                  <AiCandidatePanel
                    candidate={candidate}
                    onApply={applyCandidate}
                    onDiscard={() => setCandidate(null)}
                  />
                )}
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
                  <span>预计 {estimatedMinutes} 分钟达到 3,000 字</span>
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
                <button
                  type="button"
                  className="ns-button is-primary"
                  onClick={() => void runTracking()}
                  disabled={!selectedChapter || !onAiRun || trackingBusy}
                >
                  {trackingBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {trackingBusy ? "正在分析" : "分析当前章节"}
                </button>
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
                            disabled={Boolean(operation)}
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
                            disabled={Boolean(operation)}
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
                            disabled={Boolean(operation)}
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
                onClick={() => setInspectorView("chapter")}
                className={inspectorView === "chapter" ? "is-active" : ""}
                title="章节设置"
                aria-label="章节设置"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
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
                    ? `来源：剧情工程 / ${selectedPlan.title}`
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
                  这是自由正文；可在“章节”面板选择剧情章节计划进行关联。
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
                >
                  <PenLine className="h-4 w-4" />
                  <strong>续写</strong>
                  <small>从当前光标继续</small>
                </button>
                <button
                  type="button"
                  onClick={() => void runWritingAi("revise")}
                >
                  <WandSparkles className="h-4 w-4" />
                  <strong>整章润色</strong>
                  <small>保持事实和声口</small>
                </button>
                <button
                  type="button"
                  onClick={() => void runWritingAi("expand")}
                >
                  <Maximize2 className="h-4 w-4" />
                  <strong>扩写场景</strong>
                  <small>补足感官和行动</small>
                </button>
                <button type="button" onClick={() => void runQualityReview()}>
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
                  onClick={() => setBrainstormOpen(true)}
                >
                  <BrainCircuit className="h-3.5 w-3.5" /> 打开 AI 脑暴室
                </button>
                <button
                  type="button"
                  className="ns-button mt-2 w-full"
                  onClick={() => setSimulationOpen(true)}
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
                    disabled={!qualityReview.issues.length}
                  >
                    <WandSparkles className="h-3.5 w-3.5" /> 生成修复候选
                  </button>
                </>
              ) : (
                <div className="ms-inspector-empty-state">
                  <ShieldCheck className="h-7 w-7" />
                  <p>检查章节计划、人物声线、连续性、节奏和章尾钩子。</p>
                  <button
                    type="button"
                    className="ns-button is-primary"
                    onClick={() => void runQualityReview()}
                    disabled={!onAiRun || qualityBusy || !draft.trim()}
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
                disabled={!selectedChapter || !onAiRun || trackingBusy}
              >
                {trackingBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                分析当前章节
              </button>
              {latestProposedBatch && (
                <section className="ms-inspector-section">
                  <header>
                    <strong>检测到的变化</strong>
                    <span>{latestProposedBatch.changes.length} 项待确认</span>
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
                    disabled={Boolean(operation)}
                  >
                    <Check className="h-3.5 w-3.5" /> 确认并同步选中项
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
                    disabled={structureLocked}
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
                        ? void runOperation("chapter-directory", () =>
                            onUpdateChapter(selectedChapter.id, {
                              directoryId: value,
                            }),
                          )
                        : undefined
                    }
                    ariaLabel="章节所属目录"
                    size="toolbar"
                    disabled={structureLocked}
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
                      void runOperation("narrative-link", () =>
                        onLinkChapterToNarrative(
                          selectedChapter.id,
                          value || null,
                        ),
                      )
                    }
                    ariaLabel="关联剧情章节计划"
                    size="toolbar"
                    disabled={structureLocked}
                  />
                  {selectedPlan && (
                    <p className="ms-plan-summary">
                      {selectedPlan.description || "该章节计划尚未填写说明。"}
                    </p>
                  )}
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
                              disabled={structureLocked}
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
                                void runOperation("directory-parent", () =>
                                  onUpdateDirectory(directory.id, {
                                    parentId: value || null,
                                  }),
                                )
                              }
                              ariaLabel="当前目录上级目录"
                              size="toolbar"
                              disabled={structureLocked}
                            />
                            <div className="ms-directory-order-actions">
                              <button
                                type="button"
                                className="ns-button flex-1"
                                onClick={() =>
                                  void moveDirectory(directory, -1)
                                }
                                disabled={
                                  structureLocked || siblingPosition <= 0
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
                                void runOperation(
                                  "narrative-directory-link",
                                  () =>
                                    onUpdateDirectory(directory.id, {
                                      narrativeDirectoryId: value || null,
                                    }),
                                )
                              }
                              ariaLabel="关联剧情目录"
                              size="toolbar"
                              disabled={structureLocked}
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
                      disabled={structureLocked || selectedChapter.order <= 0}
                    >
                      <ArrowUp className="h-3.5 w-3.5" /> 上移
                    </button>
                    <button
                      type="button"
                      className="ns-button flex-1"
                      onClick={() => void moveChapter(1)}
                      disabled={structureLocked}
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
                    disabled={structureLocked || dirty}
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
                        void runOperation("restore", () =>
                          onRestoreChapter(item.deletionId),
                        )
                      }
                      disabled={Boolean(operation)}
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
    </div>
  );
}
