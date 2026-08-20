export type InspirationAiRunMode = "diagnose" | "develop";

export interface InspirationAiContext {
  readonly projectTitle: string;
  readonly focusId: string;
  readonly focusLabel: string;
}

export interface InspirationAiAgentRequest {
  readonly sceneId: "inspiration.assist" | "inspiration.coauthor";
  readonly title: string;
  readonly systemPrompt: string;
  readonly initialMessage: string;
  readonly conversationKey: string;
  readonly historyGroupPath: readonly string[];
}

export function createInspirationAiAgentRequest(
  context: InspirationAiContext,
  mode?: InspirationAiRunMode,
): InspirationAiAgentRequest {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const task =
    mode === "diagnose"
      ? "诊断当前灵感的清晰度、重复风险和待补问题；先给一句结论，再按证据、风险、补充问题和建议动作输出。"
      : mode === "develop"
        ? "围绕当前灵感提出三个互不重复的发展方向，说明核心变化、读者体验、需要补充的设定和潜在代价，最后推荐一个方向。"
        : "与作者讨论、追问并形成可执行的灵感发展建议。";
  const historyLabel =
    mode === "diagnose"
      ? "诊断当前灵感"
      : mode === "develop"
        ? "展开发展方向"
        : "深度共创";
  return {
    sceneId: mode ? "inspiration.assist" : "inspiration.coauthor",
    title: `灵感共创 · ${context.focusLabel}`,
    conversationKey: mode
      ? `novel.inspiration.assist:${mode}:${context.focusId}:${runId}`
      : `novel.inspiration.coauthor:${context.focusId}`,
    historyGroupPath: ["灵感", historyLabel],
    systemPrompt: `你是 MyAgents 小说工作台的灵感共创编辑。

焦点灵感稳定 ID：${context.focusId}

本次任务：${task}

这是只读共创会话：无论作者如何表述，都只能讨论、追问和形成可执行建议。不得调用写入、编辑、删除、提案提交或其它会修改项目数据的工具；需要落库时，明确请作者在相应工作台确认并执行。

上下文读取规则：正式灵感内容不在启动消息中展开。开始分析前调用 novel_inspiration_get_context，并传入 focusId；需要其它领域事实时再按需调用相应的小说工作台内置读取工具。不要为了遍历模块而机械调用全部工具。`,
    initialMessage: "请开始执行当前小说工作台灵感共创任务。",
  };
}
