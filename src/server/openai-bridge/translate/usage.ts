// Normalized token usage: intermediate representation between OpenAI and Anthropic formats

import type { OpenAIUsage } from '../types/openai';
import type { ResponsesUsage } from '../types/openai-responses';
import type { AnthropicUsage } from '../types/anthropic';

export type UsageWarningLogger = (message: string) => void;

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
}

export function emptyUsage(): UsageSnapshot {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
  };
}

interface UsageParts {
  protocol: 'chat_completions' | 'responses';
  totalInputTokens: unknown;
  outputTokens: unknown;
  cacheReadInputTokens: unknown;
  cacheCreationInputTokens: unknown;
  reasoningTokens: unknown;
}

function finiteNonNegative(value: unknown, field: string, invalidFields: string[]): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (value !== undefined && value !== null) invalidFields.push(field);
  return 0;
}

/** OpenAI total-input usage → Anthropic's mutually-exclusive token partitions. */
function normalizeOpenAIUsage(
  parts: UsageParts,
  warn?: UsageWarningLogger,
): UsageSnapshot {
  const invalidFields: string[] = [];
  const totalInput = finiteNonNegative(parts.totalInputTokens, 'total_input', invalidFields);
  const rawCacheRead = finiteNonNegative(parts.cacheReadInputTokens, 'cache_read', invalidFields);
  const rawCacheCreation = finiteNonNegative(parts.cacheCreationInputTokens, 'cache_write', invalidFields);
  const outputTokens = finiteNonNegative(parts.outputTokens, 'output', invalidFields);
  const reasoningTokens = finiteNonNegative(parts.reasoningTokens, 'reasoning', invalidFields);

  const cacheReadInputTokens = Math.min(rawCacheRead, totalInput);
  const cacheCreationInputTokens = Math.min(rawCacheCreation, totalInput - cacheReadInputTokens);
  if (rawCacheRead + rawCacheCreation > totalInput) invalidFields.push('cache_partitions_exceed_total');

  if (invalidFields.length > 0) {
    warn?.(
      `[bridge] Malformed ${parts.protocol} usage fields=${[...new Set(invalidFields)].join(',')}`
      + ` normalized_total=${totalInput} normalized_read=${cacheReadInputTokens}`
      + ` normalized_write=${cacheCreationInputTokens}`,
    );
  }

  return {
    inputTokens: totalInput - cacheReadInputTokens - cacheCreationInputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
  };
}

/** OpenAI usage → normalized UsageSnapshot */
export function fromOpenAIUsage(
  usage: OpenAIUsage | null | undefined,
  warn?: UsageWarningLogger,
): UsageSnapshot {
  if (!usage) return emptyUsage();
  return normalizeOpenAIUsage({
    protocol: 'chat_completions',
    totalInputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens,
    cacheCreationInputTokens: usage.prompt_tokens_details?.cache_write_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  }, warn);
}

/** Responses usage → normalized UsageSnapshot */
export function fromResponsesUsage(
  usage: ResponsesUsage | null | undefined,
  warn?: UsageWarningLogger,
): UsageSnapshot {
  if (!usage) return emptyUsage();
  return normalizeOpenAIUsage({
    protocol: 'responses',
    totalInputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.input_tokens_details?.cached_tokens,
    cacheCreationInputTokens: usage.input_tokens_details?.cache_write_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  }, warn);
}

/** UsageSnapshot → Anthropic usage format */
export function toAnthropicUsage(snap: UsageSnapshot): AnthropicUsage {
  return {
    input_tokens: snap.inputTokens,
    output_tokens: snap.outputTokens,
    ...(snap.cacheReadInputTokens > 0 ? { cache_read_input_tokens: snap.cacheReadInputTokens } : {}),
    ...(snap.cacheCreationInputTokens > 0 ? { cache_creation_input_tokens: snap.cacheCreationInputTokens } : {}),
  };
}

/** Merge a partial OpenAI usage update into an existing snapshot (for streaming accumulation) */
export function mergeUsage(
  existing: UsageSnapshot,
  usage: OpenAIUsage | null | undefined,
  warn?: UsageWarningLogger,
): UsageSnapshot {
  if (!usage) return existing;
  const existingTotal = existing.inputTokens
    + existing.cacheReadInputTokens
    + existing.cacheCreationInputTokens;
  return normalizeOpenAIUsage({
    protocol: 'chat_completions',
    totalInputTokens: usage.prompt_tokens ?? existingTotal,
    outputTokens: usage.completion_tokens ?? existing.outputTokens,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? existing.cacheReadInputTokens,
    cacheCreationInputTokens: usage.prompt_tokens_details?.cache_write_tokens ?? existing.cacheCreationInputTokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? existing.reasoningTokens,
  }, warn);
}
