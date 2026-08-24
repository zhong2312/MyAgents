import type { TimelineEvent } from "../entities/timelineLibrarySchema";

export type TimelineAiTaskId =
  | "consistency"
  | "history"
  | "branch"
  | "foreshadowing";

export interface TimelineAiAgentRequest {
  readonly task: TimelineAiTaskId;
  readonly title: string;
  readonly systemPrompt: string;
  readonly initialMessage: string;
  readonly conversationKey: string;
  readonly historyGroupPath: readonly string[];
}

export interface TimelineAiSelection {
  readonly branchId: string;
  readonly viewId: string;
  readonly periodId: string;
  readonly eventId: string;
  readonly eventDraft: TimelineEvent | null;
}

export const TIMELINE_AI_TASKS: readonly {
  readonly id: TimelineAiTaskId;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    id: "consistency",
    label: "时间序列校验",
    description: "检查时间范围、直接前因、状态变化和叙事揭示顺序的矛盾。",
  },
  {
    id: "history",
    label: "历史事件补全",
    description: "围绕当前纪元或事件补齐必要的前史、转折与长期余波。",
  },
  {
    id: "branch",
    label: "分支后果推演",
    description: "分析分歧点后的连锁后果，并区分主线事实与平行可能性。",
  },
  {
    id: "foreshadowing",
    label: "伏笔与揭示闭环",
    description: "梳理埋设、回收与信息揭示节奏，找出可用的补强位置。",
  },
];

export function buildTimelineAiAgentRequest({
  task,
  projectTitle,
  selection,
  userInstruction,
}: {
  readonly task: TimelineAiTaskId;
  readonly projectTitle: string;
  readonly selection: TimelineAiSelection;
  readonly userInstruction: string;
}): TimelineAiAgentRequest {
  const taskMeta = TIMELINE_AI_TASKS.find((item) => item.id === task)!;
  const runId = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const instruction =
    userInstruction.trim() || "请先给出最值得优先处理的三项建议。";

  return {
    task,
    title: `时间线 · ${taskMeta.label}`,
    conversationKey: `novel.timeline.assist:${task}:${runId}`,
    historyGroupPath: ["时间线", taskMeta.label],
    systemPrompt: `你是 MyNovelStudio 小说工作台的“时间线 AI 助手”。

项目：${projectTitle}
本次任务：${taskMeta.label}
任务说明：${taskMeta.description}
作者补充要求：${instruction}

目标标识：${JSON.stringify({
      branchId: selection.branchId,
      viewId: selection.viewId,
      periodId: selection.periodId,
      eventId: selection.eventId,
    })}

上下文读取规则：正式时间线事实不在启动消息中展开。请按需调用 novel_timeline_get_context；需要剧情、人物、世界、物品或修行事实时再调用对应的小说工作台内置工具。当前页面草稿只能由作者在工作台确认后保存，不应假设工具可以读取未保存内容。

请按以下规则工作：
1. 先按任务需要调用 novel_timeline_get_context 获取已保存事实；不要为了遍历模块而机械调用全部工具。
2. 该工具返回的是已保存事实；无法确认的内容必须明确标为待确认，不得臆测。
3. 明确区分世界时间（sortKey）、故事相对时间、叙事揭示顺序（narrativeOrder）和角色认知范围；不要把它们当成同一个时间轴，也不要强行补齐未知时间。
4. 时间线是世界事实源。当前会话只读取和分析，通过“草稿 -> 校验 -> 提案”协议提交候选：作者确认改动方向后调用 novel_timeline_create_draft 创建草稿，用 novel_timeline_upsert_draft_operations 分批写入事件候选（同一候选使用相同 candidateId）；每个 value 必须完整符合正式事件结构，createdAt 和 updatedAt 由系统写入，不要自行填写或修改。调用 novel_timeline_validate_draft 校验通过后，只能使用返回的 validationToken 调用 novel_timeline_submit_draft；随后调用 novel_timeline_get_proposal_status 确认 exists=true，再提示作者在时间线页点击“审阅提案”。可按需使用原始命令和文件工具读取项目内外素材并核对事实，但不得把原始文件操作冒充为已写入事实源。
5. 每条建议使用“发现 / 原因 / 建议动作 / 影响范围”结构，引用具体纪元、分支、事件或章节。对未落定的创作选择给出备选方案，不把检查提示当成硬性写作规则。
6. 涉及分支时，必须说明分歧点、继承历史和分歧后的可见后果；涉及伏笔时，必须说明埋设事件、预期回收位置和读者可见的信息变化。

先给出简洁诊断摘要，再按优先级提出可由作者确认后提交为时间线提案的建议。`,
    initialMessage: "请开始执行当前小说工作台时间线任务。",
  };
}
