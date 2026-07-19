import {
  AlignJustify,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Code2,
  Columns2,
  ExternalLink,
  FileDiff,
  FileJson,
  FileText,
  GitCompareArrows,
  History,
  LayoutTemplate,
  Loader2,
  Maximize2,
  Minus,
  Minimize2,
  Network,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { DraggableDialogFrame, type WorkbenchStorage } from "@/workbench-sdk";

import type { NovelAiAssistTarget } from "./aiAssistTypes";
import PromptManager from "./PromptManager";
import SettingLibrary from "./SettingLibrary";

const DiffViewer = lazy(() => import("@/workbench-sdk/DiffViewer"));

export type AiPrototypeMode = "library" | "meta" | "prompts";

interface AiWorldDesignPrototypeProps {
  readonly storage: WorkbenchStorage;
  readonly mode: AiPrototypeMode;
  readonly onNavigate: (route: string) => void;
}

function IconButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
    >
      {children}
    </button>
  );
}

function PrototypeNavigation({
  mode,
  onNavigate,
}: {
  readonly mode: AiPrototypeMode;
  readonly onNavigate: (route: string) => void;
}) {
  const items: readonly [AiPrototypeMode, string, LucideIcon, string][] = [
    ["library", "lore", Network, "世界架构"],
    ["meta", "lore-config", LayoutTemplate, "模板配置"],
    ["prompts", "ai-prompts", Code2, "提示词管理"],
  ];
  return (
    <nav
      aria-label="小说工作台原型导航"
      className="flex w-14 shrink-0 flex-col items-center border-r border-[var(--line)] bg-[var(--paper-elevated)] py-3"
    >
      <span className="mb-4 flex h-9 w-9 items-center justify-center rounded-md bg-[var(--accent-warm)] text-white">
        <BookOpen className="h-4 w-4" />
      </span>
      <div className="flex flex-1 flex-col gap-1.5">
        {items.map(([itemMode, route, Icon, label]) => (
          <button
            key={itemMode}
            type="button"
            aria-label={label}
            title={label}
            aria-current={mode === itemMode ? "page" : undefined}
            onClick={() => onNavigate(route)}
            className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
              mode === itemMode
                ? "bg-[var(--accent-cool-subtle)] text-[var(--accent-cool)] shadow-[inset_3px_0_0_var(--accent-cool)]"
                : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
      <span
        className="h-2 w-2 rounded-full bg-[var(--success)]"
        title="项目已连接"
      />
    </nav>
  );
}

function AgentMessage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
        <Bot className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 text-sm leading-6">{children}</div>
    </div>
  );
}

interface PrototypeConversationState {
  readonly concept: string;
  readonly started: boolean;
  readonly planReady: boolean;
}

const EMPTY_CONVERSATION: PrototypeConversationState = {
  concept: "",
  started: false,
  planReady: false,
};

function FullAgentConversation({
  mode,
  onClose,
  onMinimize,
  onReview,
  conversation,
  onConversationChange,
}: {
  readonly mode: Exclude<AiPrototypeMode, "prompts">;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly onReview: () => void;
  readonly conversation: PrototypeConversationState;
  readonly onConversationChange: (next: PrototypeConversationState) => void;
}) {
  const isTemplateMode = mode === "meta";
  const [showHistory, setShowHistory] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const { concept, started, planReady } = conversation;
  const title = isTemplateMode ? "模板配置 Agent" : "世界架构 Agent";
  const intro = isTemplateMode
    ? "告诉我这套模板主要服务什么世界层级或创作目标。我会通过小说工作台工具读取当前配置，并逐步补齐层级类型、模板和关联关系。"
    : "用一句话描述你想写的世界。我会通过小说工作台工具读取现有设定，再逐步确认尺度、空间结构、规则和关键设定。";
  const placeholder = isTemplateMode
    ? "例如：为星际文明补齐恒星系、行星和城市三级模板"
    : "例如：一个被永夜潮汐锁定的双星世界，故事从边境港城开始";
  const userMessage =
    concept.trim() ||
    (isTemplateMode
      ? "为双星世界补齐从恒星系到港城的模板配置。"
      : "一个被永夜潮汐锁定的双星世界，旧神文明沉在海底，故事从边境港城开始。");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onMinimize();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onMinimize]);

  return (
    <DraggableDialogFrame
      ariaLabel={title}
      maximized={maximized}
      overlayClassName="z-50"
      className="h-[min(720px,calc(100vh-4rem))] w-[min(1040px,calc(100vw-4rem))] max-sm:h-[calc(100vh-1.5rem)] max-sm:w-[calc(100vw-1.5rem)]"
      headerClassName="flex h-14 items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4"
      header={
        <>
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-warm)] text-white">
            <Bot className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            <div className="truncate text-xs text-[var(--ink-muted)]">
              MyAgents 完整对话 · 烬海编年史
            </div>
          </div>
          <div className="ml-auto hidden items-center gap-2 text-xs text-[var(--ink-muted)] sm:flex">
            <span className="flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
              Agent Session
            </span>
            <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1">
              Claude Sonnet
            </span>
          </div>
          <IconButton
            label="新对话"
            onClick={() => {
              onConversationChange(EMPTY_CONVERSATION);
              setShowHistory(false);
            }}
          >
            <Plus className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="历史对话"
            onClick={() => setShowHistory((current) => !current)}
          >
            <History className="h-4 w-4" />
          </IconButton>
          <IconButton
            label={maximized ? "还原 Agent 窗口" : "全屏显示 Agent 窗口"}
            onClick={() => setMaximized((current) => !current)}
          >
            {maximized ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </IconButton>
          <IconButton
            label="最小化为运行小窗"
            onClick={() => {
              setMaximized(false);
              onMinimize();
            }}
          >
            <Minus className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="关闭 Agent 对话"
            onClick={() => {
              setMaximized(false);
              onClose();
            }}
          >
            <X className="h-4 w-4" />
          </IconButton>
        </>
      }
    >
      {showHistory && (
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-inset)] px-4 py-2">
          <History className="h-4 w-4 text-[var(--accent-cool)]" />
          <button
            type="button"
            onClick={() => setShowHistory(false)}
            className="min-w-0 flex-1 text-left"
          >
            <strong className="block truncate text-xs font-medium">
              上次对话（默认）
            </strong>
            <span className="block truncate text-xs text-[var(--ink-muted)]">
              {started
                ? isTemplateMode
                  ? "模板配置 Agent 会话"
                  : "世界架构 Agent 会话"
                : "尚未发送消息"}
            </span>
          </button>
          <span className="flex items-center gap-1 text-xs text-[var(--success)]">
            <Check className="h-3.5 w-3.5" /> 当前
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-48 shrink-0 border-r border-[var(--line)] bg-[var(--paper-elevated)] p-3 lg:flex lg:flex-col">
          <div className="text-xs font-semibold text-[var(--ink-muted)]">
            当前任务
          </div>
          <div className="mt-3 border-l-2 border-[var(--accent-warm)] pl-3">
            <strong className="block text-xs">
              {isTemplateMode ? "完善模板配置" : "创建世界架构"}
            </strong>
            <span className="mt-1 block text-xs leading-5 text-[var(--ink-muted)]">
              {isTemplateMode ? "元配置与默认模板" : "一句话到完整提案"}
            </span>
          </div>
          <div className="mt-6 text-xs font-semibold text-[var(--ink-muted)]">
            已授权工具
          </div>
          <div className="mt-2 space-y-1.5 text-xs text-[var(--ink-muted)]">
            {["读取项目上下文", "校验领域变更", "提交待审阅提案"].map(
              (label) => (
                <div key={label} className="flex items-center gap-2 py-1">
                  <Wrench className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
                  {label}
                </div>
              ),
            )}
          </div>
          <div className="mt-auto rounded-md border border-[var(--line)] bg-[var(--paper)] p-2.5 text-xs leading-5 text-[var(--ink-muted)]">
            <ShieldCheck className="mb-1 h-4 w-4 text-[var(--success)]" />
            Agent 不能直接修改小说文件，正式变更只会在审批后写入。
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-7 px-6 py-7 max-sm:px-4">
              <AgentMessage>
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
                  <span>
                    已加载 Skill ·{" "}
                    {isTemplateMode ? "设定模板配置" : "小说世界架构"}
                  </span>
                  <span className="rounded bg-[var(--success-bg)] px-1.5 py-0.5 text-[var(--success)]">
                    工具权限已隔离
                  </span>
                </div>
                <p className="mt-1">{intro}</p>
              </AgentMessage>

              {started && (
                <>
                  <div className="ml-auto max-w-2xl rounded-md bg-[var(--accent-warm-subtle)] px-4 py-3 text-sm leading-6">
                    {userMessage}
                  </div>
                  <AgentMessage>
                    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
                      <span className="flex items-center gap-1.5 rounded border border-[var(--line)] px-2 py-1">
                        <Check className="h-3 w-3 text-[var(--success)]" />
                        novel_world_get_context
                      </span>
                      <span>读取 6 个来源 · 未修改文件</span>
                    </div>
                    <p>
                      {isTemplateMode
                        ? "当前项目已经有宇宙、星球和聚落模板，但恒星系与城市层级之间缺少稳定的默认页面组合。我建议先确定这次补全的覆盖范围。"
                        : "我识别到这是一个以星球文明为主体、双星结构影响自然规则的世界。海底旧神文明适合作为历史与力量体系，不必先升级成宇宙级空间节点。"}
                    </p>
                    <div className="mt-4 border-l-2 border-[var(--accent-warm)] pl-4">
                      <div className="text-xs font-medium text-[var(--accent-warm)]">
                        第 1 个关键决定
                      </div>
                      <h2 className="mt-1 text-sm font-semibold">
                        {isTemplateMode
                          ? "哪些层级需要成为这次配置的默认骨架？"
                          : "故事主要可到达的空间范围是什么？"}
                      </h2>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {(isTemplateMode
                          ? [
                              "恒星系与行星",
                              "恒星系、行星、港城（推荐）",
                              "完整宇宙层级",
                            ]
                          : ["边境港城及周边", "完整星球（推荐）", "整个恒星系"]
                        ).map((choice, index) => (
                          <button
                            key={choice}
                            type="button"
                            className={`rounded-md border px-3 py-2 text-xs ${
                              index === 1
                                ? "border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)] text-[var(--ink)]"
                                : "border-[var(--line)] hover:bg-[var(--hover-bg)]"
                            }`}
                          >
                            {choice}
                          </button>
                        ))}
                      </div>
                      {!planReady && (
                        <button
                          type="button"
                          onClick={() =>
                            onConversationChange({
                              ...conversation,
                              planReady: true,
                            })
                          }
                          className="mt-4 flex h-9 items-center gap-2 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-white hover:bg-[var(--accent-warm-hover)]"
                        >
                          {isTemplateMode
                            ? "生成模板配置提案"
                            : "生成世界架构提案"}
                          <ArrowRight className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </AgentMessage>
                </>
              )}

              {planReady && (
                <AgentMessage>
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
                    <span className="flex items-center gap-1.5 rounded border border-[var(--line)] px-2 py-1">
                      <Check className="h-3 w-3 text-[var(--success)]" />
                      novel_world_submit_proposal
                    </span>
                    <span>提案已写入审阅区 · 正式文件未变化</span>
                  </div>
                  <p>
                    我已经生成第一版方案，并通过小说工作台的 Schema
                    与引用闭合校验。
                  </p>
                  <div className="mt-4 overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)]">
                    <header className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
                      <FileDiff className="h-4 w-4 text-[var(--accent-cool)]" />
                      <strong className="text-sm">
                        {isTemplateMode ? "模板配置提案" : "世界架构提案"}
                      </strong>
                      <span className="ml-auto flex items-center gap-1 text-xs text-[var(--success)]">
                        <ShieldCheck className="h-3.5 w-3.5" /> 校验通过
                      </span>
                    </header>
                    <div className="grid grid-cols-3 divide-x divide-[var(--line-subtle)] text-center">
                      {[
                        [isTemplateMode ? "6" : "12", "新增"],
                        [isTemplateMode ? "2" : "3", "修改"],
                        ["0", "冲突"],
                      ].map(([value, label]) => (
                        <div key={label} className="py-3">
                          <strong className="block text-base">{value}</strong>
                          <span className="text-xs text-[var(--ink-muted)]">
                            {label}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="divide-y divide-[var(--line-subtle)] border-t border-[var(--line)]">
                      {(isTemplateMode
                        ? [
                            ["meta.json", "+1 层级类型 · +2 模板"],
                            ["恒星系模板", "补齐核心内容与默认词条"],
                            ["类型模板关联", "+4 默认关联"],
                          ]
                        : [
                            ["meta.json", "+1 层级类型 · +2 模板"],
                            ["spatial-tree.json", "+9 空间节点"],
                            ["潮汐法则.md", "新建设定页面"],
                          ]
                      ).map(([file, detail]) => (
                        <button
                          type="button"
                          key={file}
                          onClick={onReview}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover-bg)]"
                        >
                          <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
                          <span className="min-w-0 flex-1">
                            <strong className="block truncate text-sm font-medium">
                              {file}
                            </strong>
                            <span className="text-xs text-[var(--ink-muted)]">
                              {detail}
                            </span>
                          </span>
                          <ChevronRight className="h-4 w-4 text-[var(--ink-subtle)]" />
                        </button>
                      ))}
                    </div>
                    <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-4 py-3">
                      <button
                        type="button"
                        className="h-8 rounded-md border border-[var(--line)] px-3 text-xs hover:bg-[var(--hover-bg)]"
                      >
                        继续调整
                      </button>
                      <button
                        type="button"
                        onClick={onReview}
                        className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-cool)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-cool-hover)]"
                      >
                        <GitCompareArrows className="h-3.5 w-3.5" /> 审阅提案
                      </button>
                    </footer>
                  </div>
                </AgentMessage>
              )}
            </div>
          </main>

          <footer className="shrink-0 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3">
            <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-md border border-[var(--line-strong)] bg-[var(--paper)] p-2 shadow-sm">
              <textarea
                rows={2}
                value={concept}
                onChange={(event) =>
                  onConversationChange({
                    ...conversation,
                    concept: event.target.value,
                  })
                }
                placeholder={placeholder}
                className="min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-5 outline-none"
              />
              <button
                type="button"
                aria-label="发送"
                title="发送"
                disabled={!concept.trim()}
                onClick={() =>
                  onConversationChange({
                    ...conversation,
                    started: true,
                  })
                }
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--accent-warm)] text-white hover:bg-[var(--accent-warm-hover)] disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <div className="mx-auto mt-1.5 max-w-3xl text-center text-xs text-[var(--ink-subtle)]">
              MyAgents Agent Session · 仅可调用当前工作台授权的业务工具
            </div>
          </footer>
        </div>
      </div>
    </DraggableDialogFrame>
  );
}

interface ProposalPreviewChange {
  readonly id: string;
  readonly file: string;
  readonly summary: string;
  readonly language: "json" | "markdown";
  readonly original: string;
  readonly modified: string;
}

function proposalPreviewChanges(
  mode: Exclude<AiPrototypeMode, "prompts">,
): readonly ProposalPreviewChange[] {
  if (mode === "meta") {
    return [
      {
        id: "meta-level-type",
        file: "world/setting-library/meta.json",
        summary: "新增恒星系层级类型并登记默认模板",
        language: "json",
        original: `{
  "schemaVersion": 1,
  "levelTypes": [
    { "id": "planet", "name": "星球" },
    { "id": "city", "name": "城市" }
  ]
}`,
        modified: `{
  "schemaVersion": 1,
  "levelTypes": [
    { "id": "star-system", "name": "恒星系", "mapKind": "stellar-system" },
    { "id": "planet", "name": "星球" },
    { "id": "city", "name": "城市" }
  ]
}`,
      },
      {
        id: "star-system-template",
        file: "world/setting-library/pages/templates/star-system.md",
        summary: "补齐恒星、轨道与文明边界模板骨架",
        language: "markdown",
        original: `# 恒星系\n\n## 核心内容\n`,
        modified: `# 恒星系\n\n## 核心内容\n\n描述恒星组成、主要轨道与可居住区域。\n\n## 天体结构\n\n- 主星与伴星\n- 关键行星与卫星\n- 航道和禁区\n\n## 文明边界\n\n记录行政归属、交通瓶颈和资源争夺。\n`,
      },
      {
        id: "profile-links",
        file: "world/setting-library/meta.json · profiles",
        summary: "为恒星系、星球和港城建立默认模板关联",
        language: "json",
        original: `{
  "levelTypeId": "planet",
  "templateIds": ["geography", "civilization"]
}`,
        modified: `{
  "levelTypeId": "star-system",
  "templateIds": ["star-system", "astronomical-rules", "civilization-boundary"]
}`,
      },
    ];
  }
  return [
    {
      id: "spatial-tree",
      file: "world/setting-library/spatial-tree.json",
      summary: "建立双星系统、烬海星和边境港城的空间层级",
      language: "json",
      original: `{
  "schemaVersion": 1,
  "nodes": []
}`,
      modified: `{
  "schemaVersion": 1,
  "nodes": [
    { "id": "ember-binary", "name": "烬海双星系", "levelTypeId": "star-system" },
    { "id": "ember-sea", "name": "烬海星", "parentId": "ember-binary", "levelTypeId": "planet" },
    { "id": "north-port", "name": "北境沉潮港", "parentId": "ember-sea", "levelTypeId": "city" }
  ]
}`,
    },
    {
      id: "settings-index",
      file: "world/setting-library/settings.json",
      summary: "登记潮汐法则页面和词条文件",
      language: "json",
      original: `{
  "schemaVersion": 1,
  "settings": []
}`,
      modified: `{
  "schemaVersion": 1,
  "settings": [
    {
      "id": "tidal-law",
      "nodeId": "ember-sea",
      "pagePath": "world/setting-library/pages/ember-sea/tidal-law.md",
      "entriesPath": "world/setting-library/entries/ember-sea/tidal-law.json"
    }
  ]
}`,
    },
    {
      id: "tidal-law-page",
      file: "world/setting-library/pages/ember-sea/tidal-law.md",
      summary: "新增永夜潮汐的连续说明",
      language: "markdown",
      original: "",
      modified: `# 永夜潮汐\n\n双星每隔七十三年发生一次遮蔽，海面随之升起含有旧神残响的黑潮。\n\n## 可验证规则\n\n- 黑潮只在无直射星光的海域形成。\n- 潮汐会放大记忆，却不会凭空创造记忆。\n- 沉潮港以灯塔阵列维持十二海里的稳定航道。\n`,
    },
  ];
}

function ProposalReviewPrototype({
  mode,
  onClose,
}: {
  readonly mode: Exclude<AiPrototypeMode, "prompts">;
  readonly onClose: () => void;
}) {
  const changes = useMemo(() => proposalPreviewChanges(mode), [mode]);
  const [activeId, setActiveId] = useState(changes[0]?.id ?? "");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(changes.map((change) => change.id)),
  );
  const [appliedIds, setAppliedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sideBySide, setSideBySide] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const activeChange =
    changes.find((change) => change.id === activeId) ?? changes[0];
  const pendingChanges = changes.filter((change) => !appliedIds.has(change.id));
  const selectedPendingIds = pendingChanges
    .filter((change) => selectedIds.has(change.id))
    .map((change) => change.id);
  const allPendingSelected =
    pendingChanges.length > 0 &&
    pendingChanges.every((change) => selectedIds.has(change.id));

  const toggleAll = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPendingSelected) {
        pendingChanges.forEach((change) => next.delete(change.id));
      } else {
        pendingChanges.forEach((change) => next.add(change.id));
      }
      return next;
    });
  };

  const applySelected = () => {
    if (selectedPendingIds.length === 0) return;
    setAppliedIds((current) => new Set([...current, ...selectedPendingIds]));
    setMessage(
      `已采纳 ${selectedPendingIds.length} 项变更，正式设定通过一致性校验。`,
    );
  };

  return (
    <DraggableDialogFrame
      ariaLabel="世界架构提案审批"
      maximized={maximized}
      overlayClassName="z-[60]"
      className="h-[min(760px,calc(100vh-3rem))] w-[min(1180px,calc(100vw-3rem))] max-sm:h-[calc(100vh-1.5rem)] max-sm:w-[calc(100vw-1.5rem)]"
      headerClassName="flex min-h-14 items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4 max-sm:flex-wrap max-sm:py-2"
      header={
        <>
          <button
            type="button"
            aria-label="返回 Agent 对话"
            title="返回 Agent 对话"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
            <GitCompareArrows className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">
              {mode === "meta" ? "模板配置提案" : "世界架构提案"}
            </h1>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              proposal-ember-sea-v1 · {changes.length} 项变更
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1 rounded-md bg-[var(--paper-inset)] p-1 max-sm:order-2 max-sm:ml-0">
            <button
              type="button"
              aria-pressed={sideBySide}
              onClick={() => setSideBySide(true)}
              className={`flex h-7 items-center gap-1 rounded px-2 text-xs ${
                sideBySide
                  ? "bg-[var(--paper-elevated)] shadow-sm"
                  : "text-[var(--ink-muted)]"
              }`}
            >
              <Columns2 className="h-3.5 w-3.5" /> 并排
            </button>
            <button
              type="button"
              aria-pressed={!sideBySide}
              onClick={() => setSideBySide(false)}
              className={`flex h-7 items-center gap-1 rounded px-2 text-xs ${
                !sideBySide
                  ? "bg-[var(--paper-elevated)] shadow-sm"
                  : "text-[var(--ink-muted)]"
              }`}
            >
              <AlignJustify className="h-3.5 w-3.5" /> 行内
            </button>
          </div>
          <button
            type="button"
            aria-label="重新校验提案"
            title="重新校验提案"
            onClick={() => setMessage("提案快照与正式文件一致，可以继续审批。")}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={maximized ? "还原提案窗口" : "全屏显示提案窗口"}
            title={maximized ? "还原窗口" : "全屏"}
            onClick={() => setMaximized((current) => !current)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            {maximized ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            aria-label="关闭审批"
            title="关闭审批"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      }
    >
      {message && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--success-bg)] px-4 py-2 text-xs text-[var(--success)]">
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1">{message}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setMessage(null)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <aside className="flex w-80 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)] max-lg:w-72 max-md:h-72 max-md:w-full max-md:border-r-0 max-md:border-b">
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-3">
            <input
              type="checkbox"
              aria-label="选择全部待审批变更"
              checked={allPendingSelected}
              onChange={toggleAll}
              className="h-3.5 w-3.5 accent-[var(--accent-cool)]"
            />
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs font-medium"
            >
              全部待审批变更
            </button>
            <span className="ml-auto text-xs text-[var(--ink-muted)]">
              {selectedPendingIds.length}/{pendingChanges.length}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {changes.map((change) => {
              const active = change.id === activeChange?.id;
              const applied = appliedIds.has(change.id);
              const FileIcon = change.language === "json" ? FileJson : FileText;
              return (
                <div
                  key={change.id}
                  className={`flex items-start gap-2 border-l-2 px-3 py-3 ${
                    active
                      ? "border-[var(--accent-cool)] bg-[var(--paper-inset)]"
                      : "border-transparent hover:bg-[var(--hover-bg)]"
                  }`}
                >
                  <input
                    type="checkbox"
                    aria-label={`选择变更 ${change.summary}`}
                    checked={selectedIds.has(change.id) || applied}
                    disabled={applied}
                    onChange={() =>
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (next.has(change.id)) next.delete(change.id);
                        else next.add(change.id);
                        return next;
                      })
                    }
                    className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent-cool)]"
                  />
                  <button
                    type="button"
                    onClick={() => setActiveId(change.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
                      <strong className="truncate text-xs font-medium">
                        {change.file.split("/").at(-1)}
                      </strong>
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--ink-muted)]">
                      {change.summary}
                    </span>
                    <span
                      className={`mt-1.5 inline-flex items-center gap-1 text-xs ${
                        applied
                          ? "text-[var(--success)]"
                          : "text-[var(--accent-cool)]"
                      }`}
                    >
                      {applied ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <CircleDot className="h-3 w-3" />
                      )}
                      {applied ? "已采纳" : "待审批"}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="shrink-0 border-t border-[var(--line)] p-3">
            <div className="mb-2 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
              <ShieldCheck className="h-3.5 w-3.5 text-[var(--success)]" />
              应用前重新比较 before 快照
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={selectedPendingIds.length === 0}
                onClick={() => {
                  setSelectedIds(new Set());
                  setMessage("已拒绝选中的待审批变更；提案记录仍然保留。");
                }}
                className="h-9 rounded-md border border-[var(--line)] text-xs font-medium disabled:opacity-40"
              >
                拒绝选中
              </button>
              <button
                type="button"
                disabled={selectedPendingIds.length === 0}
                onClick={applySelected}
                className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--accent-cool)] text-xs font-medium text-white hover:bg-[var(--accent-cool-hover)] disabled:opacity-40"
              >
                <Check className="h-3.5 w-3.5" /> 采纳选中
              </button>
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {activeChange ? (
            <>
              <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-2">
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate font-mono text-xs font-medium"
                    title={activeChange.file}
                  >
                    {activeChange.file}
                  </div>
                  <p className="mt-1 truncate text-xs text-[var(--ink-muted)]">
                    {activeChange.summary}
                  </p>
                </div>
                <span className="rounded bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink-muted)]">
                  {activeChange.original ? "修改" : "新增"}
                </span>
                {appliedIds.has(activeChange.id) && (
                  <span className="flex items-center gap-1 text-xs text-[var(--success)]">
                    <CheckCircle2 className="h-3.5 w-3.5" /> 已采纳
                  </span>
                )}
              </header>
              <div className="min-h-0 flex-1">
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />{" "}
                      正在加载差异组件
                    </div>
                  }
                >
                  <DiffViewer
                    key={`${activeChange.id}:${sideBySide}`}
                    original={activeChange.original}
                    modified={activeChange.modified}
                    language={activeChange.language}
                    renderSideBySide={sideBySide}
                  />
                </Suspense>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--ink-muted)]">
              请选择一项变更
            </div>
          )}
        </main>
      </div>
    </DraggableDialogFrame>
  );
}

type MiniRunStage = "context" | "running" | "ready";

interface MiniRun {
  readonly id: string;
  readonly target: NovelAiAssistTarget;
}

function AgentRunMiniWindow({
  target,
  onClose,
  onExpand,
}: {
  readonly target: NovelAiAssistTarget;
  readonly onClose: () => void;
  readonly onExpand: () => void;
}) {
  const [stage, setStage] = useState<MiniRunStage>("context");
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    const runningTimer = window.setTimeout(() => setStage("running"), 350);
    const readyTimer = window.setTimeout(() => setStage("ready"), 1200);
    return () => {
      window.clearTimeout(runningTimer);
      window.clearTimeout(readyTimer);
    };
  }, [target]);

  const steps = [
    ["装配项目上下文", stage !== "context"],
    ["调用 MyAgents Agent 接口", stage === "ready"],
    ["校验结构化结果", stage === "ready"],
  ] as const;

  return (
    <section className="border-b border-[var(--line-subtle)] last:border-b-0">
      <header className="flex h-12 items-center gap-2 border-b border-[var(--line)] px-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
          <Bot className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xs font-semibold">{target.label}</h2>
          <div className="flex items-center gap-1 text-xs text-[var(--ink-muted)]">
            {stage === "ready" ? (
              <CheckCircle2 className="h-3 w-3 text-[var(--success)]" />
            ) : (
              <Loader2 className="h-3 w-3 animate-spin text-[var(--accent-cool)]" />
            )}
            {stage === "context"
              ? "正在准备上下文"
              : stage === "running"
                ? "Agent 正在生成"
                : "结果可以审阅"}
          </div>
        </div>
        <IconButton label="展开到完整会话" onClick={onExpand}>
          <ExternalLink className="h-4 w-4" />
        </IconButton>
        <IconButton label="关闭运行小窗" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </header>

      <div className="px-4 py-3">
        <div className="divide-y divide-[var(--line-subtle)]">
          {steps.map(([label, complete], index) => (
            <div key={label} className="flex items-center gap-2 py-2 text-xs">
              {complete ? (
                <Check className="h-3.5 w-3.5 text-[var(--success)]" />
              ) : index === (stage === "context" ? 0 : 1) ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent-cool)]" />
              ) : (
                <CircleDot className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
              )}
              <span className={complete ? "text-[var(--ink-muted)]" : ""}>
                {label}
              </span>
              {index === 0 && (
                <span className="ml-auto text-[var(--ink-subtle)]">
                  P0/P1/P2 · 3,780 tokens
                </span>
              )}
            </div>
          ))}
        </div>

        {stage === "ready" && (
          <div className="mt-3 border-l-2 border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)] px-3 py-2.5">
            <div className="flex items-center justify-between text-xs">
              <strong>生成建议</strong>
              <span className="text-[var(--success)]">
                {applied ? "已应用到编辑区" : "Schema 通过"}
              </span>
            </div>
            <p className="mt-1.5 text-xs leading-5">
              {applied
                ? "候选内容已进入当前编辑草稿，仍需由作者保存后才会写入项目。"
                : "已依据当前节点、父链和相关事实生成候选内容；原文件尚未修改。"}
            </p>
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-[var(--line)] px-3 py-2.5">
        {stage === "ready" ? (
          <>
            <button
              type="button"
              onClick={() => {
                setApplied(false);
                setStage("running");
                window.setTimeout(() => setStage("ready"), 800);
              }}
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-xs"
            >
              <Play className="h-3.5 w-3.5" /> 重新生成
            </button>
            <button
              type="button"
              disabled={applied}
              onClick={() => setApplied(true)}
              className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-cool)] px-2.5 text-xs font-medium text-white"
            >
              {applied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <GitCompareArrows className="h-3.5 w-3.5" />
              )}
              {applied ? "已应用" : "应用到编辑区"}
            </button>
          </>
        ) : (
          <>
            <span className="text-xs text-[var(--ink-muted)]">
              novel.world.page.generate · v1.3.0
            </span>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-xs"
            >
              <Square className="h-3 w-3" /> 停止
            </button>
          </>
        )}
      </footer>
    </section>
  );
}

export default function AiWorldDesignPrototype({
  storage,
  mode,
  onNavigate,
}: AiWorldDesignPrototypeProps) {
  const conversationMode = mode === "meta" ? "meta" : "library";
  const [conversations, setConversations] = useState<
    Record<"library" | "meta", PrototypeConversationState>
  >(() => ({
    library: { ...EMPTY_CONVERSATION },
    meta: { ...EMPTY_CONVERSATION },
  }));
  const [fullConversation, setFullConversation] = useState<string | null>(null);
  const [miniRuns, setMiniRuns] = useState<readonly MiniRun[]>([]);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const agentLabel = mode === "meta" ? "AI 配置模板" : "AI 创建世界";
  const pageLabel =
    mode === "meta"
      ? "模板配置"
      : mode === "prompts"
        ? "提示词管理"
        : "世界架构";

  const addMiniRun = (target: NovelAiAssistTarget) => {
    const id = `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    setMiniRuns((current) => [...current, { id, target }]);
  };

  const removeMiniRun = (runId: string) => {
    setMiniRuns((current) => current.filter((run) => run.id !== runId));
  };

  const openAssist = async (target: NovelAiAssistTarget) => {
    if (target.kind === "world") {
      setConversations((current) => ({
        ...current,
        [conversationMode]: {
          concept: target.label,
          started: true,
          planReady: current[conversationMode].planReady,
        },
      }));
      setFullConversation(target.label);
      return null;
    }
    addMiniRun(target);
    return null;
  };

  return (
    <div className="flex h-screen min-h-0 overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <PrototypeNavigation mode={mode} onNavigate={onNavigate} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--line)] px-5">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{pageLabel}</h1>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              F:\\workspace\\MyAgents-test\\小说\\烬海编年史
            </p>
          </div>
          <div className="ml-4 flex shrink-0 items-center gap-2">
            <div className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-medium text-[var(--ink-muted)] max-md:hidden">
              烬海编年史
            </div>
            {mode !== "prompts" && (
              <>
                <button
                  type="button"
                  aria-label="审阅提案"
                  title="审阅提案"
                  onClick={() => setIsReviewOpen(true)}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] px-2.5 text-sm font-medium hover:bg-[var(--hover-bg)]"
                >
                  <GitCompareArrows className="h-4 w-4 text-[var(--accent-cool)]" />
                  <span className="max-lg:hidden">审阅提案</span>
                </button>
                <button
                  type="button"
                  aria-label={agentLabel}
                  title={agentLabel}
                  onClick={() => setFullConversation(agentLabel)}
                  className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-2.5 text-sm font-medium text-white hover:bg-[var(--accent-warm-hover)]"
                >
                  <Sparkles className="h-4 w-4" />
                  <span className="max-lg:hidden">{agentLabel}</span>
                </button>
              </>
            )}
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          {mode === "prompts" ? (
            <PromptManager
              storage={storage}
              projectGenres={["玄幻", "东方玄幻"]}
              isActive
            />
          ) : (
            <SettingLibrary
              storage={storage}
              projectTitle="烬海编年史"
              mode={mode}
              onAiAssist={openAssist}
            />
          )}

          {miniRuns.length > 0 && (
            <aside
              aria-label="AI 任务"
              className="absolute bottom-5 right-5 z-40 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-2xl"
            >
              <header className="flex h-12 items-center gap-2 border-b border-[var(--line)] px-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
                  <Bot className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-xs font-semibold">AI 任务</h2>
                  <p className="truncate text-xs text-[var(--ink-muted)]">
                    共 {miniRuns.length} 个任务
                  </p>
                </div>
              </header>
              <div className="max-h-[min(58vh,34rem)] overflow-y-auto">
                {[...miniRuns].reverse().map((run) => (
                  <AgentRunMiniWindow
                    key={run.id}
                    target={run.target}
                    onClose={() => removeMiniRun(run.id)}
                    onExpand={() => {
                      setConversations((current) => ({
                        ...current,
                        [conversationMode]: {
                          concept: run.target.label,
                          started: true,
                          planReady: current[conversationMode].planReady,
                        },
                      }));
                      setFullConversation(run.target.label);
                      removeMiniRun(run.id);
                    }}
                  />
                ))}
              </div>
            </aside>
          )}

          {fullConversation !== null && mode !== "prompts" && (
            <FullAgentConversation
              mode={mode}
              conversation={conversations[conversationMode]}
              onConversationChange={(next) =>
                setConversations((current) => ({
                  ...current,
                  [conversationMode]: next,
                }))
              }
              onClose={() => setFullConversation(null)}
              onMinimize={() => {
                setFullConversation(null);
                addMiniRun({
                  kind: "world",
                  label:
                    mode === "meta"
                      ? "模板配置 Agent 会话"
                      : "世界架构 Agent 会话",
                });
              }}
              onReview={() => setIsReviewOpen(true)}
            />
          )}

          {isReviewOpen && mode !== "prompts" && (
            <ProposalReviewPrototype
              mode={mode}
              onClose={() => setIsReviewOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
