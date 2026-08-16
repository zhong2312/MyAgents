import type { WorkbenchAiExecutionProfile } from '../shared/workbench-sdk';

const MIN_TIMEOUT_MS = 10_000;
const STANDARD_MAX_TIMEOUT_MS = 180_000;
const EXTENDED_DEFAULT_TIMEOUT_MS = 300_000;
const EXTENDED_MAX_TIMEOUT_MS = 600_000;

/** 普通一次性请求保持紧凑，避免把任意大文本送入模型运行时。 */
export const WORKBENCH_AI_STANDARD_PROMPT_CHARACTER_LIMIT = 60_000;
/**
 * 正文完整生成会把作者确认的多领域快照一次性注入用户提示词。
 * 该档位仍受运行时、超时和轮次预算限制，只扩大单次资料快照容量。
 */
export const WORKBENCH_AI_EXTENDED_PROMPT_CHARACTER_LIMIT = 200_000;

export interface WorkbenchAiRunBudget {
  readonly profile: WorkbenchAiExecutionProfile;
  readonly timeoutMs?: number;
  readonly maxTurns: number;
}

export function resolveWorkbenchAiPromptCharacterLimit(
  profileValue: unknown,
): number {
  return profileValue === "extended"
    ? WORKBENCH_AI_EXTENDED_PROMPT_CHARACTER_LIMIT
    : WORKBENCH_AI_STANDARD_PROMPT_CHARACTER_LIMIT;
}

export function resolveWorkbenchAiRunBudget(
  profileValue: unknown,
  timeoutValue: unknown,
  maxTurnsValue?: unknown,
): WorkbenchAiRunBudget | null {
  if (
    profileValue !== undefined
    && profileValue !== 'standard'
    && profileValue !== 'extended'
  ) {
    return null;
  }

  const profile = profileValue === 'extended' ? 'extended' : 'standard';
  const maxTimeoutMs = profile === 'extended'
    ? EXTENDED_MAX_TIMEOUT_MS
    : STANDARD_MAX_TIMEOUT_MS;
  const requestedTimeoutMs = typeof timeoutValue === 'number' && Number.isFinite(timeoutValue)
    ? Math.round(timeoutValue)
    : undefined;
  const timeoutMs = requestedTimeoutMs === undefined
    ? profile === 'extended' ? EXTENDED_DEFAULT_TIMEOUT_MS : undefined
    : Math.max(MIN_TIMEOUT_MS, Math.min(maxTimeoutMs, requestedTimeoutMs));

  const requestedMaxTurns = typeof maxTurnsValue === 'number' && Number.isFinite(maxTurnsValue)
    ? Math.round(maxTurnsValue)
    : undefined;
  const maxTurns = requestedMaxTurns === undefined
    ? profile === 'extended' ? 16 : 8
    : Math.max(1, Math.min(profile === 'extended' ? 16 : 8, requestedMaxTurns));

  return {
    profile,
    timeoutMs,
    maxTurns,
  };
}
