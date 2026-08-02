import type {
  TimelineBranch,
  TimelineEvent,
  TimelineLibrary,
  TimelinePeriod,
  TimelineView,
} from "./timelineLibrarySchema";

export type TimelineAiTaskId =
  | "consistency"
  | "history"
  | "branch"
  | "foreshadowing";

export interface TimelineAiAgentRequest {
  readonly task: TimelineAiTaskId;
  readonly title: string;
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

const MAX_SNAPSHOT_LENGTH = 42_000;

function clip(value: string, limit = 420): string {
  const normalized = value.trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit)}…`;
}

function cap<T>(values: readonly T[], limit: number): T[] {
  return values.length <= limit ? [...values] : [...values.slice(0, limit)];
}

function selectedById<T extends { readonly id: string }>(
  values: readonly T[],
  id: string,
): T | null {
  return values.find((value) => value.id === id) ?? null;
}

function eventSnapshot(event: TimelineEvent) {
  return {
    id: event.id,
    branchId: event.branchId,
    timeLabel: event.timeLabel,
    sortKey: event.sortKey,
    endSortKey: event.endSortKey,
    timePrecision: event.timePrecision,
    periodId: event.periodId,
    scope: event.scope,
    knowledgeScope: event.knowledgeScope,
    narrativeOrder: event.narrativeOrder,
    title: event.title,
    kind: event.kind,
    summary: clip(event.summary, 280),
    description: clip(event.description, 520),
    causeEventIds: event.causeEventIds,
    chapterIds: event.chapterIds,
    characterIds: event.characterIds,
    factionIds: event.factionIds,
    locationIds: event.locationIds,
    itemIds: event.itemIds,
    stateChanges: cap(event.stateChanges, 8).map((change) => ({
      entityType: change.entityType,
      entityId: change.entityId,
      before: clip(change.before, 120),
      after: clip(change.after, 120),
      note: clip(change.note, 160),
    })),
    foreshadowings: cap(event.foreshadowings, 8).map((foreshadowing) => ({
      id: foreshadowing.id,
      title: foreshadowing.title,
      status: foreshadowing.status,
      plantedChapterId: foreshadowing.plantedChapterId,
      payoffEventId: foreshadowing.payoffEventId,
      note: clip(foreshadowing.note, 160),
    })),
    tags: event.tags,
  };
}

function periodSnapshot(period: TimelinePeriod) {
  return {
    id: period.id,
    name: period.name,
    parentPeriodId: period.parentPeriodId,
    kind: period.kind,
    scope: period.scope,
    startSortKey: period.startSortKey,
    endSortKey: period.endSortKey,
    precision: period.precision,
    description: clip(period.description, 360),
  };
}

function branchSnapshot(branch: TimelineBranch) {
  return {
    id: branch.id,
    name: branch.name,
    parentBranchId: branch.parentBranchId,
    forkEventId: branch.forkEventId,
    description: clip(branch.description, 360),
  };
}

function viewSnapshot(view: TimelineView) {
  return {
    id: view.id,
    name: view.name,
    kind: view.kind,
    scope: view.scope,
    calendarId: view.calendarId,
    rootPeriodId: view.rootPeriodId,
  };
}

function buildSnapshot(
  library: TimelineLibrary,
  selection: TimelineAiSelection,
): string {
  const events = [...library.events].sort(
    (left, right) =>
      left.sortKey - right.sortKey ||
      left.sortOrder - right.sortOrder ||
      left.id.localeCompare(right.id),
  );
  const selectedEvent = selectedById(library.events, selection.eventId);
  const snapshot = {
    schemaVersion: library.schemaVersion,
    counts: {
      calendars: library.calendars.length,
      periods: library.periods.length,
      branches: library.branches.length,
      events: library.events.length,
      stateChanges: library.events.reduce(
        (total, event) => total + event.stateChanges.length,
        0,
      ),
      foreshadowings: library.events.reduce(
        (total, event) => total + event.foreshadowings.length,
        0,
      ),
    },
    anchors: {
      storyStartEventId: library.storyStartEventId,
      factsThroughEventId: library.factsThroughEventId,
    },
    selection: {
      branch: selectedById(library.branches, selection.branchId),
      view: selectedById(library.views, selection.viewId),
      period: selectedById(library.periods, selection.periodId),
      event: selectedEvent ? eventSnapshot(selectedEvent) : null,
      pageEventDraft: selection.eventDraft
        ? eventSnapshot(selection.eventDraft)
        : null,
    },
    calendars: library.calendars.map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      unit: calendar.unit,
      description: clip(calendar.description, 180),
    })),
    periods: cap(library.periods, 120).map(periodSnapshot),
    branches: cap(library.branches, 80).map(branchSnapshot),
    views: library.views.map(viewSnapshot),
    events: cap(events, 180).map(eventSnapshot),
    omitted: {
      periods: Math.max(0, library.periods.length - 120),
      branches: Math.max(0, library.branches.length - 80),
      events: Math.max(0, events.length - 180),
    },
  };
  const serialized = JSON.stringify(snapshot, null, 2);
  if (serialized.length <= MAX_SNAPSHOT_LENGTH) return serialized;

  return JSON.stringify(
    {
      schemaVersion: library.schemaVersion,
      counts: snapshot.counts,
      anchors: snapshot.anchors,
      selection: snapshot.selection,
      calendars: snapshot.calendars,
      periods: cap(library.periods, 60).map(periodSnapshot),
      branches: cap(library.branches, 40).map(branchSnapshot),
      views: snapshot.views,
      events: cap(events, 80).map((event) => ({
        id: event.id,
        branchId: event.branchId,
        timeLabel: event.timeLabel,
        sortKey: event.sortKey,
        title: event.title,
        kind: event.kind,
        periodId: event.periodId,
        causeEventIds: event.causeEventIds,
        chapterIds: event.chapterIds,
        narrativeOrder: event.narrativeOrder,
        foreshadowingCount: event.foreshadowings.length,
        stateChangeCount: event.stateChanges.length,
      })),
      contextNote:
        "完整快照超过上下文预算，已保留选中对象和全局时间线索引。",
    },
    null,
    2,
  );
}

export function buildTimelineAiAgentRequest({
  task,
  projectTitle,
  library,
  selection,
  userInstruction,
}: {
  readonly task: TimelineAiTaskId;
  readonly projectTitle: string;
  readonly library: TimelineLibrary;
  readonly selection: TimelineAiSelection;
  readonly userInstruction: string;
}): TimelineAiAgentRequest {
  const taskMeta = TIMELINE_AI_TASKS.find((item) => item.id === task)!;
  const runId = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const context = buildSnapshot(library, selection);
  const instruction =
    userInstruction.trim() || "请先给出最值得优先处理的三项建议。";

  return {
    task,
    title: `时间线 · ${taskMeta.label}`,
    conversationKey: `novel.timeline.assist:${task}:${runId}`,
    historyGroupPath: ["时间线", taskMeta.label],
    initialMessage: `你是 MyAgents 小说工作台的“时间线 AI 助手”。

项目：${projectTitle}
本次任务：${taskMeta.label}
任务说明：${taskMeta.description}
作者补充要求：${instruction}

下面是时间线的结构化快照；其中“pageEventDraft”可能含尚未保存的页面修改：
<timeline-context>
${context}
</timeline-context>

请按以下规则工作：
1. 只基于快照和作者补充要求分析，不要假设未提供的事实。根据实际需要，自主选择 novel_timeline_get_context、novel_narrative_get_context、novel_characters_get_context、novel_world_get_context、novel_items_get_context 或 novel_cultivation_get_context 获取补充事实；不要为了遍历模块而机械调用全部工具。
2. 快照不足以确认已保存的时间线事实，或作者要求核对最新数据时，调用 novel_timeline_get_context。该工具返回的是已保存事实；若与 pageEventDraft 冲突，必须以作者当前页面草稿为准并说明差异。
3. 明确区分世界时间（sortKey）、故事相对时间、叙事揭示顺序（narrativeOrder）和角色认知范围；不要把它们当成同一个时间轴，也不要强行补齐未知时间。
4. 时间线是世界事实源。当前会话只读取和分析，通过“草稿 -> 校验 -> 提案”协议提交候选：作者确认改动方向后调用 novel_timeline_create_draft 创建草稿，用 novel_timeline_upsert_draft_operations 分批写入事件候选（同一候选使用相同 candidateId），调用 novel_timeline_validate_draft 校验通过后，只能使用返回的 validationToken 调用 novel_timeline_submit_draft；随后调用 novel_timeline_get_proposal_status 确认 exists=true，再提示作者在时间线页点击“审阅提案”。不得调用原始文件工具，也不得声称已写入事实源。
5. 每条建议使用“发现 / 原因 / 建议动作 / 影响范围”结构，引用具体纪元、分支、事件或章节。对未落定的创作选择给出备选方案，不把检查提示当成硬性写作规则。
6. 涉及分支时，必须说明分歧点、继承历史和分歧后的可见后果；涉及伏笔时，必须说明埋设事件、预期回收位置和读者可见的信息变化。

先给出简洁诊断摘要，再按优先级提出可由作者确认后提交为时间线提案的建议。`,
  };
}
