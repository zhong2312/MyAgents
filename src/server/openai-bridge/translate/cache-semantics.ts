import type { AnthropicCacheControl } from '../types/anthropic';

/**
 * Project SDK-owned cache intent only when the active bridge generation has
 * enabled target-protocol breakpoints. This helper deliberately does not infer
 * stability, TTL, or cache mode.
 */
export function projectPromptCacheBreakpoint(
  enabled: boolean,
  cacheControl: AnthropicCacheControl | null | undefined,
): { mode: 'explicit' } | undefined {
  return enabled && cacheControl?.type === 'ephemeral' ? { mode: 'explicit' } : undefined;
}
