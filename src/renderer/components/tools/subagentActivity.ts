import type { ContentBlock, SubagentToolCall, ToolUseSimple } from '@/types/chat';
import type {
  SubagentLifecycle,
  SubagentLifecycleStatus,
} from '../../../shared/types/subagent-lifecycle';

/**
 * Tools that render as an expandable sub-agent container (a card holding a nested
 * `subagentCalls` trace). Single source of truth for builtin Task/Agent and
 * Codex CollabAgent spawn cards.
 */
export function isSubagentContainerTool(name: string): boolean {
  return name === 'Task' || name === 'Agent' || name === 'CollabAgent';
}

/**
 * Builtin SDK Task/Agent tools are background by default as of current Agent SDK:
 * omitted `run_in_background` means background; only explicit false means sync.
 * Codex `CollabAgent` is a MyAgents-normalized external runtime card and keeps
 * its own lifecycle semantics, so it is intentionally excluded here.
 */
export function isBackgroundSubagentTool(
  tool: Pick<ToolUseSimple, 'name' | 'parsedInput'> | null | undefined,
): boolean {
  if (!tool || (tool.name !== 'Task' && tool.name !== 'Agent')) return false;
  const input = tool.parsedInput as { run_in_background?: unknown } | undefined;
  return input?.run_in_background !== false;
}

export function isSubagentCallRunning(call: Pick<SubagentToolCall, 'isLoading'>): boolean {
  return call.isLoading === true;
}

export function hasRunningSubagentCall(tool: Pick<ToolUseSimple, 'subagentCalls'>): boolean {
  return tool.subagentCalls?.some(isSubagentCallRunning) === true;
}

/**
 * A container is active while either the parent tool itself is still executing
 * or a nested sub-agent trace entry is still streaming. This distinction matters
 * for Codex: `spawnAgent` completes as soon as the child thread is created, but
 * the child thread can keep producing nested tools for minutes afterward.
 */
export function isSubagentContainerRunning(tool: Pick<ToolUseSimple, 'name' | 'isLoading' | 'result' | 'subagentCalls' | 'subagentLifecycle'> | null | undefined): boolean {
  if (!tool || !isSubagentContainerTool(tool.name)) return false;
  if (tool.name === 'CollabAgent' && tool.subagentLifecycle) {
    return tool.subagentLifecycle.status === 'running';
  }
  return (tool.isLoading === true && !tool.result) || hasRunningSubagentCall(tool);
}

export function getSubagentContainerLifecycleStatus(
  tool: Pick<ToolUseSimple, 'name' | 'subagentLifecycle'> | null | undefined,
): SubagentLifecycleStatus | null {
  if (tool?.name !== 'CollabAgent') return null;
  return tool.subagentLifecycle?.status ?? null;
}

export function getSubagentContainerDurationMs(
  tool: Pick<ToolUseSimple, 'name' | 'subagentLifecycle'> | null | undefined,
  now = Date.now(),
): number | null {
  const lifecycle = tool?.name === 'CollabAgent' ? tool.subagentLifecycle : undefined;
  if (!lifecycle) return null;
  const end = lifecycle.status === 'running' ? now : lifecycle.finishedAt ?? lifecycle.startedAt;
  return Math.max(0, end - lifecycle.startedAt);
}

/**
 * Apply one monotonic lifecycle update to the shared Renderer content shape.
 * Consumers retain ownership of their message state; this helper only keeps
 * Tab and Companion projection semantics identical.
 */
export function applySubagentLifecycleToContent(
  content: ContentBlock[],
  parentToolUseId: string,
  lifecycle: SubagentLifecycle,
): ContentBlock[] | null {
  const index = content.findIndex(
    block => block.type === 'tool_use' && block.tool?.id === parentToolUseId,
  );
  if (index === -1) return null;
  const block = content[index];
  if (block.type !== 'tool_use' || !block.tool) return null;
  const current = block.tool.subagentLifecycle;
  if (current && current.status !== 'running') return content;
  const updated = [...content];
  updated[index] = {
    ...block,
    tool: { ...block.tool, subagentLifecycle: lifecycle },
  };
  return updated;
}
