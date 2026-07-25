import type { InspirationLibrary } from "./inspirationSchema";

export type InspirationAiRunMode = "diagnose" | "develop";

export interface InspirationAiContext {
  readonly projectTitle: string;
  readonly focusId: string;
  readonly focusLabel: string;
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface InspirationAiRunRequest {
  readonly sceneId: "inspiration.assist";
  readonly label: string;
  readonly prompt: string;
  readonly systemPrompt: string;
}

export interface InspirationAiAgentRequest {
  readonly title: string;
  readonly initialMessage: string;
  readonly conversationKey: string;
  readonly historyGroupPath: readonly string[];
}

const CONTEXT_LIMIT = 24_000;

function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (depth >= 3) {
    return Array.isArray(value)
      ? { total: value.length, truncated: true }
      : "[复杂对象已压缩]";
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 12).map((item) => compactValue(item, depth + 1));
    return value.length > items.length
      ? { total: value.length, shown: items.length, items, truncated: true }
      : items;
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 32)
        .map(([key, item]) => [key, compactValue(item, depth + 1)]),
    );
  }
  return String(value);
}

function clipContext(facts: Readonly<Record<string, unknown>>): string {
  const compacted = JSON.stringify(compactValue(facts), null, 2);
  if (compacted.length <= CONTEXT_LIMIT) return compacted;
  return `${compacted.slice(0, CONTEXT_LIMIT)}\n[上下文已截断，不得臆测缺失内容]`;
}

export function createInspirationAiRunRequest(
  mode: InspirationAiRunMode,
  context: InspirationAiContext,
): InspirationAiRunRequest {
  const task =
    mode === "diagnose"
      ? `诊断“${context.focusLabel}”是否清晰、可发展且与现有灵感重复。先给一句结论，再按“证据、风险、补充问题、建议动作”列出最多 6 项。`
      : `围绕“${context.focusLabel}”给出 3 个互不重复的发展方向，分别说明核心变化、读者体验、需要补充的设定和潜在代价，最后推荐 1 个方向。`;
  return {
    sceneId: "inspiration.assist",
    label: `${mode === "diagnose" ? "AI 诊断" : "AI 展开"} · ${context.focusLabel}`,
    systemPrompt: `你是小说作者的灵感整理编辑。灵感是待发展素材，不是已经发生的剧情事实。

规则：
1. 只依据提供的内容，不虚构正文已经完成或设定已经确定。
2. 保留作者原始想法，明确区分原文、建议和待确认假设。
3. 建议必须具体到可继续思考的问题、冲突、人物动机或场景方向。
4. 不创建或修改其它项目数据，不声称已经修改项目。
5. 只输出简洁 Markdown。`,
    prompt: `${task}

项目：${context.projectTitle}
当前焦点：${context.focusLabel}

灵感上下文：
${clipContext(context.facts)}`,
  };
}

export function createInspirationAiAgentRequest(
  context: InspirationAiContext,
  seedOutput?: string,
): InspirationAiAgentRequest {
  const seed = seedOutput?.trim()
    ? `\n\n一次性 AI 已给出以下初稿。请把它视为待质疑的建议：\n\n${seedOutput.trim()}`
    : "";
  return {
    title: `灵感共创 · ${context.focusLabel}`,
    conversationKey: `novel.inspiration.coauthor:${context.focusId}`,
    historyGroupPath: ["灵感"],
    initialMessage: `## 小说灵感共创任务

你正在与作者共同处理“${context.projectTitle}”中的灵感“${context.focusLabel}”。

这是只读共创会话：无论作者如何表述，都只能讨论、追问和形成可执行建议。不得调用写入、编辑、删除、提案提交或其它会修改项目数据的工具；需要落库时，明确请作者在相应工作台确认并执行。

当前上下文：
${clipContext(context.facts)}${seed}`,
  };
}

export function inspirationOverview(library: InspirationLibrary) {
  return { items: library.items };
}
