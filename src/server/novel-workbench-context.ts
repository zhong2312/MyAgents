export const NOVEL_WORKBENCH_MCP_ID = "novel-workbench" as const;

export type NovelWorkbenchMode = "world" | "template" | "assist";

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
  if (mode !== "world" && mode !== "template" && mode !== "assist") {
    throw new Error("toolset.context.mode must be world, template or assist");
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
  if (toolName.startsWith(`mcp__${NOVEL_WORKBENCH_MCP_ID}__`)) return false;
  if (toolName.startsWith("mcp__")) return true;
  return RAW_MUTATION_TOOLS.has(toolName);
}

export function novelWorkbenchMutationDenyMessage(toolName: string): string {
  return `受控小说工作台会话禁止直接调用 ${toolName} 修改项目。请使用 ${NOVEL_WORKBENCH_MCP_ID} 的提案工具提交变更，待作者审批后再写入正式存储。`;
}
