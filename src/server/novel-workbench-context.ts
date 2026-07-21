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
工具失败或暂时不可用时，仍然不得请求或尝试改用 Write、Edit、Bash、Task、Agent 或其他原始文件路径修改小说项目；只能停止本次写回并说明提案尚未提交。`;

export type NovelWorkbenchMode =
  | "world"
  | "template"
  | "assist"
  | "items"
  | "characters"
  | "factions"
  | "powers";

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

let context: NovelWorkbenchContext | null = null;

export function configureNovelWorkbenchRequest(
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
    mode !== "items" &&
    mode !== "characters" &&
    mode !== "factions" &&
    mode !== "powers"
  ) {
    throw new Error(
      "toolset.context.mode must be world, template, assist, items, characters, factions or powers",
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
  context = {
    mode,
    promptId: promptId.trim(),
    promptVersion,
    ...runtime,
  };
  return context;
}

export function configureNovelWorkbenchToolset(
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
  return configureNovelWorkbenchRequest(toolset.context, runtime);
}

export function getNovelWorkbenchToolsetSnapshot(): WorkbenchAgentToolsetRequest | undefined {
  if (!context) return undefined;
  return {
    id: NOVEL_WORKBENCH_TOOLSET_ID,
    context: {
      mode: context.mode,
      promptId: context.promptId,
      promptVersion: context.promptVersion,
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
  return context;
}

const RAW_MUTATION_TOOLS = new Set([
  "Bash",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Write",
  "Task",
  "Agent",
]);

export function shouldBlockNovelWorkbenchRawMutation(
  toolName: string,
): boolean {
  if (!context) return false;
  if (
    toolName.startsWith(`mcp__${NOVEL_WORKBENCH_SDK_ADAPTER_ID}__`)
  ) {
    return false;
  }
  if (toolName.startsWith("mcp__")) return true;
  return RAW_MUTATION_TOOLS.has(toolName);
}

export function novelWorkbenchMutationDenyMessage(toolName: string): string {
  return `受控小说工作台会话禁止直接调用 ${toolName} 修改项目。请使用小说工作台内置提案工具提交变更，待作者审批后再写入正式存储。`;
}
