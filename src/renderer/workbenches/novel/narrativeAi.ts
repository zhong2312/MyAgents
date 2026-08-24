import type { NarrativeWorkspaceView } from "./NarrativeAudit";

export type NarrativeAiTaskId =
  | "current"
  | "outline"
  | "structure"
  | "weaving"
  | "chapters";

export interface NarrativeAiSelection {
  readonly view: NarrativeWorkspaceView;
  readonly selectedLineId: string;
  readonly selectedArcId: string;
  readonly selectedDirectoryId: string;
  readonly selectedChapterId: string;
}

export interface NarrativeAiAgentRequest {
  readonly task: NarrativeAiTaskId;
  readonly title: string;
  readonly systemPrompt: string;
  readonly initialMessage: string;
  readonly conversationKey: string;
  readonly historyGroupPath: readonly string[];
}

export const NARRATIVE_AI_TASKS: readonly {
  readonly id: NarrativeAiTaskId;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    id: "current",
    label: "分析当前视图",
    description: "围绕当前选中的线路、故事弧、目录、章节或检查项给出建议。",
  },
  {
    id: "outline",
    label: "大纲结构规划",
    description: "规划卷、篇、组的层级、子主题与章节归属，并识别目录缺口。",
  },
  {
    id: "structure",
    label: "全局结构体检",
    description: "检查主线、支线、故事弧、章节分布和节奏缺口。",
  },
  {
    id: "weaving",
    label: "线路与故事弧编织",
    description: "寻找线路交汇、角色弧拐点和章/节关联的加强机会。",
  },
  {
    id: "chapters",
    label: "章节与节规划",
    description: "为当前目录创建章节候选，并在每章内拆分节与段规划。",
  },
];

export function buildNarrativeAiAgentRequest({
  task,
  projectTitle,
  selection,
  userInstruction,
  hasUnsavedChanges = false,
}: {
  readonly task: NarrativeAiTaskId;
  readonly projectTitle: string;
  readonly selection: NarrativeAiSelection;
  readonly userInstruction: string;
  readonly hasUnsavedChanges?: boolean;
}): NarrativeAiAgentRequest {
  const taskMeta = NARRATIVE_AI_TASKS.find(
    (candidate) => candidate.id === task,
  )!;
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const proposalMutationRule =
    "更新已有线路、故事弧、目录或章节时，必须在对应 upsert 工具中填写 targetId，且 targetId 必须是上下文中已有对象的稳定 ID。更新章节时，既有节和段也必须分别用 targetId 保留稳定 ID；只有明确新增对象时才省略 targetId。不得仅因标题相同而新建副本。";
  const outlineTaskRule =
    task === "outline"
      ? '\n\n本次是全书大纲结构规划：先以小说总览中的“预计章节规模”为容量契约，规划覆盖全书的卷、篇、组层级、主题或时空边界和排序。不得把少量样章当作全书规划。创建草稿时必须传 planningScope: "full-novel"；叶子目录必须填写 plannedChapterCount，非叶子目录填写 0，所有叶子目录的章节额度之和必须落在预计章节范围内。若快照不足以判断已保存的目录状态，可按需调用 novel_narrative_get_context({ scope: "outline" })。作者要求实际创建或调整大纲时，必须用 novel_narrative_upsert_draft_directories 写入目录候选：父目录引用同一草稿的 candidateId 或已有目录稳定 ID，根卷使用 null。卷、篇、组属于目录，不得创建同名故事弧代替目录；本任务不必为每一章展开节和段。'
      : "";
  const chapterTaskRule =
    task === "chapters"
      ? '\n\n本次是章节与节规划：目标是创建或更新正式可审阅的章节候选，而不是修改大纲目录说明。先按需调用 novel_narrative_get_context({ scope: "chapters" }) 和 novel_narrative_get_context({ scope: "outline" }) 获取完整章节与目录事实，再调用 novel_narrative_upsert_draft_chapters。每章必须归属当前选中目录（或作者指定目录），至少包含一个有标题和简述的节；节内可按需要提供多个段规划。章和节可关联线路、故事弧，段不关联。新建章、节、段省略 targetId；更新既有章时必须提交完整章节结构，并为保留的章、节、段填写各自 targetId。不得创建或修改正文 Markdown。'
      : "";
  const defaultInstruction =
    task === "chapters"
      ? "请为当前选中的目录规划并创建章节与节候选；根据已有线路和故事弧拆分每章的节，必要时补充段规划。"
      : "请先给出最值得优先处理的三项建议。";
  const instruction = `${
    userInstruction.trim() || defaultInstruction
  }\n\n${proposalMutationRule}${outlineTaskRule}${chapterTaskRule}`;
  return {
    task,
    title: `剧情工程 · ${taskMeta.label}`,
    conversationKey: `novel.narrative.assist:${task}:${runId}`,
    historyGroupPath: ["剧情工程", taskMeta.label],
    systemPrompt: `你是 MyAgents 小说工作台的“剧情工程 AI 助手”。

项目：${projectTitle}
当前视图：${selection.view}
目标标识：${JSON.stringify({
      selectedLineId: selection.selectedLineId,
      selectedArcId: selection.selectedArcId,
      selectedDirectoryId: selection.selectedDirectoryId,
      selectedChapterId: selection.selectedChapterId,
    })}
本次任务：${taskMeta.label}
任务说明：${taskMeta.description}
作者补充要求：${instruction}

上下文读取规则：正式剧情、人物、正文、世界和物品事实不在启动消息中展开。请根据任务按需调用 novel_narrative_get_context、novel_characters_get_context、novel_manuscript_get_context、novel_world_get_context、novel_items_get_context；不要为了遍历模块而机械调用全部工具。
${hasUnsavedChanges ? "当前剧情工程页面存在未保存修改，禁止创建草稿覆盖页面；请作者先保存页面或明确放弃草稿。" : "当前页面没有未保存修改。"}

请按以下规则工作：
1. 作者明确要求创建或更新线路、故事弧、卷篇组目录、章节或节时，必须先调用 novel_narrative_get_context 获取最新 sourceHash，再调用 novel_narrative_create_draft；随后分别使用 novel_narrative_upsert_draft_lines、novel_narrative_upsert_draft_story_arcs、novel_narrative_upsert_draft_directories 或 novel_narrative_upsert_draft_chapters 写入对应候选。线路和故事弧必须包含关键节点；目录必须提供正确的父目录、类型和顺序；章节必须包含至少一个节。
2. 草稿完成后必须调用 novel_narrative_validate_draft，再使用这次返回的 validationToken 调用 novel_narrative_submit_draft。最后调用 novel_narrative_get_proposal_status 回查提案。工具只会生成待审提案，不会直接创建正式对象；只能向作者报告“提案已提交，请在剧情工程中审阅”，不得声称已经写入正式事实源。
3. sourceHash 不匹配时，重新读取剧情工程事实并创建新草稿，不能用旧 hash 重试。
4. 工具只能创建剧情规划提案，绝不修改正文。可按需使用原始命令和文件工具读取项目内外素材并核对事实；正式剧情规划仍通过目录候选或章节候选写入，节和段始终嵌套在章内，不得把原始文件操作冒充为已提交提案。
5. 非创建请求以分析和建议为主。每条建议使用“发现 / 原因 / 建议动作 / 影响范围”结构，并引用工具返回的具体线路、故事弧、章节或节标题；优先尊重非线性创作，不要把检查提示当成硬性写作规则。
6. 结合人物库的角色弧关联，明确区分角色弧事实与剧情工程中的章节投影。

先判断作者是否要求实际创建；需要创建时先调用工具并报告真实返回结果，否则给出简洁诊断摘要和按优先级排序的建议。`,
    initialMessage: "请开始执行当前小说工作台剧情工程任务。",
  };
}
