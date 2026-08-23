import type { AgentConfig } from './types/agent';
import {
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_HEARTBEAT_ACTIVE_HOURS,
  DEFAULT_MEMORY_AUTO_UPDATE_CONFIG,
  DEFAULT_MEMORY_EVOLUTION_CONFIG,
  type HeartbeatConfig,
  type MemoryAutoUpdateConfig,
  type MemoryEvolutionConfig,
} from './types/im';

export interface ProactiveAgentConfigSource {
  enabled: boolean;
  heartbeat?: HeartbeatConfig;
  memoryAutoUpdate?: MemoryAutoUpdateConfig;
  memoryEvolution?: MemoryEvolutionConfig;
}

export type ProactiveAgentTogglePatch = Pick<
  AgentConfig,
  'enabled' | 'heartbeat' | 'memoryAutoUpdate' | 'memoryEvolution'
>;

/**
 * Build the durable intent for an explicit user toggle of Proactive Agent mode.
 *
 * A master toggle deliberately resets every child switch to the same value,
 * while preserving cadence, active hours, and execution history. Lifecycle
 * transitions such as archive/unarchive must not call this policy.
 */
export function buildProactiveAgentTogglePatch(
  agent: ProactiveAgentConfigSource,
  enabled: boolean,
): ProactiveAgentTogglePatch {
  return {
    enabled,
    heartbeat: {
      ...DEFAULT_HEARTBEAT_CONFIG,
      ...agent.heartbeat,
      activeHours: {
        ...DEFAULT_HEARTBEAT_ACTIVE_HOURS,
        ...agent.heartbeat?.activeHours,
      },
      enabled,
    },
    memoryAutoUpdate: {
      ...DEFAULT_MEMORY_AUTO_UPDATE_CONFIG,
      ...agent.memoryAutoUpdate,
      enabled,
    },
    memoryEvolution: {
      ...DEFAULT_MEMORY_EVOLUTION_CONFIG,
      ...agent.memoryEvolution,
      enabled,
    },
  };
}
