import { AsyncLocalStorage } from "node:async_hooks";

import type { WorkbenchAgentToolsetRequest } from "../shared/workbench-sdk";

/**
 * Claude Agent SDK transport id for the host-owned novel workbench tools.
 * This is an adapter detail and must never be exposed as a user-configurable
 * MCP service or as a product-facing connection state.
 */
export const NOVEL_WORKBENCH_SDK_ADAPTER_ID = "novel-workbench" as const;

export const NOVEL_WORKBENCH_TOOLSET_ID = "novel-world" as const;

export const NOVEL_WORKBENCH_SDK_INSTRUCTIONS = `这些工具是 MyAgents 小说工作台自动提供的内置业务工具，不是用户配置的 MCP 服务。
向用户描述时统一称为“小说工作台内置工具”，不得暴露 mcp__ 前缀、novel-workbench 适配器名称或底层传输协议。
不得建议用户前往 MCP 设置、开关 MCP 服务、检查 MCP 连接或通过重启应用恢复这些工具。
如果工具调用失败，只能如实说明小说工作台内置工具本次执行失败；不要臆测网络连接、服务进程或用户配置原因。
可根据当前任务自主选择时间线、剧情、人物、世界、物品或修行体系的上下文读取工具，不要为了遍历工具而进行无目的调用。领域路由必须保持一致：世界架构只调用 novel_world_get_context，修行体系只调用 novel_cultivation_get_context（事实源入口为 world/cultivation/index.json，各体系模块按目录拆分），不要把修行路径传给世界架构工具。地图生成必须先调用 novel_world_get_context 获取 sourceHash，再把该 sourceHash 传给 novel_maps_generate_fantasy_map；地图工具会重新读取完整的空间树、设定 Markdown、词条、地点聚合和势力聚合并校验哈希，拒绝使用过期世界架构生成候选。若没有配置独立 Azgaar Runtime，工具会明确返回 compatibility-adapter 降级标识，不得把它描述为已调用 Azgaar 核心。
跨领域上下文工具只用于读取事实；草稿、校验和提交工具仍受当前会话领域约束，不得尝试跨领域写入。
所有小说工作台写入都必须小批量增量进行：单次默认不超过 32 项、64 KB；优先复用同一草稿多次调用领域 upsert/patch 工具，禁止为了修改少量字段重新上传完整大 JSON。工具返回大小或批次超限时，必须拆分后继续同一草稿。
普通 SDK 命令和文件工具仍然可用。可按任务需要使用 Read、Glob、Grep、Bash 等工具读取小说项目内外的素材与设定，也可在用户任务需要时使用 Write、Edit 等工具处理文件；不得声称受控小说工作台会话没有文件系统访问权限。
小说工作台管理的正式结构化事实仍应通过当前领域的“草稿 -> 校验 -> 提案”协议写回。内置工具失败或 sourceHash 冲突时，不得把原始文件操作冒充为提案提交成功；应如实说明提案尚未提交。`;

export type NovelWorkbenchMode =
  | "world"
  | "template"
  | "assist"
  | "narrative"
  | "manuscript"
  | "timeline"
  | "inspiration"
  | "items"
  | "characters"
  | "factions"
  | "cultivation"
  | "maps";

export interface NovelWorkbenchContext {
  readonly mode: NovelWorkbenchMode;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly sessionId?: string;
  readonly workspace?: string;
}

export interface NovelWorkbenchRuntimeBinding {
  readonly sessionId: string;
  readonly workspace: string;
}

const NOVEL_WORKBENCH_TOOL_PREFIXES: Readonly<
  Record<NovelWorkbenchMode, readonly string[]>
> = {
  world: ["novel_world_"],
  template: ["novel_world_"],
  assist: ["novel_world_"],
  narrative: ["novel_narrative_"],
  manuscript: ["novel_manuscript_"],
  timeline: ["novel_timeline_"],
  inspiration: [],
  items: ["novel_items_"],
  characters: ["novel_characters_"],
  factions: ["novel_factions_"],
  cultivation: ["novel_cultivation_"],
  maps: ["novel_maps_"],
};

export const NOVEL_WORKBENCH_READ_TOOL_NAMES = [
  "novel_knowledge_search",
  "novel_world_get_context",
  "novel_narrative_get_context",
  "novel_timeline_get_context",
  "novel_items_get_context",
  "novel_characters_get_context",
  "novel_cultivation_get_context",
  "novel_factions_get_context",
  "novel_manuscript_get_context",
  "novel_continuity_get_context",
  "novel_inspiration_get_context",
] as const;

const NOVEL_WORKBENCH_CROSS_DOMAIN_READ_TOOLS = new Set<string>(
  NOVEL_WORKBENCH_READ_TOOL_NAMES,
);

function normalizeNovelWorkbenchToolName(toolName: string): string {
  const adapterPrefix = `mcp__${NOVEL_WORKBENCH_SDK_ADAPTER_ID}__`;
  return toolName.startsWith(adapterPrefix)
    ? toolName.slice(adapterPrefix.length)
    : toolName;
}

export function isNovelWorkbenchToolAllowed(
  mode: NovelWorkbenchMode,
  toolName: string,
): boolean {
  const normalized = normalizeNovelWorkbenchToolName(toolName);
  return (
    NOVEL_WORKBENCH_CROSS_DOMAIN_READ_TOOLS.has(normalized) ||
    NOVEL_WORKBENCH_TOOL_PREFIXES[mode].some((prefix) =>
      normalized.startsWith(prefix),
    )
  );
}

let context: NovelWorkbenchContext | null = null;
const scopedContext = new AsyncLocalStorage<NovelWorkbenchContext>();

function normalizeNovelWorkbenchRequest(
  value: unknown,
  runtime: NovelWorkbenchRuntimeBinding,
): NovelWorkbenchContext {
  if (!value || typeof value !== "object") {
    throw new Error("toolset.context is required");
  }
  const input = value as Record<string, unknown>;
  const mode = input.mode;
  const promptId = input.promptId;
  const promptVersion = input.promptVersion;
  if (
    mode !== "world" &&
    mode !== "template" &&
    mode !== "assist" &&
    mode !== "narrative" &&
    mode !== "manuscript" &&
    mode !== "timeline" &&
    mode !== "inspiration" &&
    mode !== "items" &&
    mode !== "characters" &&
    mode !== "factions" &&
    mode !== "cultivation" &&
    mode !== "maps"
  ) {
    throw new Error(
      "toolset.context.mode must be world, template, assist, narrative, manuscript, timeline, inspiration, items, characters, factions, cultivation or maps",
    );
  }
  if (typeof promptId !== "string" || !promptId.trim()) {
    throw new Error("toolset.context.promptId is required");
  }
  if (
    typeof promptVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(promptVersion)
  ) {
    throw new Error("toolset.context.promptVersion must be semver");
  }
  return {
    mode,
    promptId: promptId.trim(),
    promptVersion,
    ...runtime,
  };
}

function normalizeNovelWorkbenchToolset(
  value: unknown,
  runtime: NovelWorkbenchRuntimeBinding,
): NovelWorkbenchContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workbench toolset is required");
  }
  const toolset = value as { id?: unknown; context?: unknown };
  if (toolset.id !== NOVEL_WORKBENCH_TOOLSET_ID) {
    throw new Error("Unknown workbench Agent toolset.");
  }
  return normalizeNovelWorkbenchRequest(toolset.context, runtime);
}

export function configureNovelWorkbenchRequest(
  value: unknown,
  runtime: NovelWorkbenchRuntimeBinding,
): NovelWorkbenchContext {
  context = normalizeNovelWorkbenchRequest(value, runtime);
  return context;
}

export function configureNovelWorkbenchToolset(
  value: unknown,
  runtime: NovelWorkbenchRuntimeBinding,
): NovelWorkbenchContext {
  context = normalizeNovelWorkbenchToolset(value, runtime);
  return context;
}

/** Run a one-shot Agent with an isolated novel context without mutating Session state. */
export function runWithNovelWorkbenchToolset<T>(
  value: unknown,
  runtime: NovelWorkbenchRuntimeBinding,
  run: () => T,
): T {
  return scopedContext.run(normalizeNovelWorkbenchToolset(value, runtime), run);
}

export function getNovelWorkbenchToolsetSnapshot():
  | WorkbenchAgentToolsetRequest
  | undefined {
  const activeContext = getNovelWorkbenchContext();
  if (!activeContext) return undefined;
  return {
    id: NOVEL_WORKBENCH_TOOLSET_ID,
    context: {
      mode: activeContext.mode,
      promptId: activeContext.promptId,
      promptVersion: activeContext.promptVersion,
    },
  };
}

export function clearNovelWorkbenchContext(): void {
  context = null;
}

export function bindNovelWorkbenchRuntime(runtime: {
  readonly sessionId: string;
  readonly workspace?: string;
}): void {
  if (!context) return;
  context = { ...context, ...runtime };
}

export function getNovelWorkbenchContext(): NovelWorkbenchContext | null {
  return scopedContext.getStore() ?? context;
}

export function shouldBlockNovelWorkbenchTool(toolName: string): boolean {
  if (!context) return false;
  if (toolName.startsWith(`mcp__${NOVEL_WORKBENCH_SDK_ADAPTER_ID}__`)) {
    return !isNovelWorkbenchToolAllowed(context.mode, toolName);
  }
  return toolName.startsWith("mcp__");
}

export function novelWorkbenchToolDenyMessage(toolName: string): string {
  if (toolName.startsWith(`mcp__${NOVEL_WORKBENCH_SDK_ADAPTER_ID}__`)) {
    return `当前小说工作台会话不允许调用 ${toolName} 执行跨领域写入。上下文读取可以跨领域，草稿、校验和提交必须使用当前会话领域的小说工作台内置工具。`;
  }
  return `当前小说工作台会话没有装配 ${toolName}。这不会限制 Bash、Read、Glob、Grep、Write、Edit 等普通 SDK 命令和文件工具。`;
}
