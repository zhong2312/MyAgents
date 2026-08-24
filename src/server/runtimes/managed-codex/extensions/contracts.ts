import type { McpServerDefinition } from '../../../../shared/config-types';
import type { InteractionScenario } from '../../../system-prompt';

export const MANAGED_CODEX_EXTENSION_PROTOCOL_VERSION = '0.146.0';

export type ManagedCodexExtensionApplyState =
  | 'unchanged'
  | 'applied'
  | 'pending_next_start'
  | 'deferred_until_idle'
  | 'not_applicable'
  | 'unsupported'
  | 'failed';

export type ManagedCodexExtensionComponentKind =
  | 'scenario'
  | 'skills'
  | 'commands'
  | 'agents'
  | 'mcp'
  | 'plugins'
  | 'host_tools';

export interface ManagedCodexExtensionComponentResult {
  component: ManagedCodexExtensionComponentKind;
  /** Stable, non-secret identity within the component (command name, plugin id, ...). */
  id?: string;
  state: ManagedCodexExtensionApplyState;
  code: string;
  message?: string;
  /** Direct configuration actionability; passive Chat diagnostics remain log-only. */
  requiresUserAction?: boolean;
}

export interface ManagedCodexExtensionStatus {
  desiredRevision: string;
  effectiveRevision: string | null;
  state: ManagedCodexExtensionApplyState;
  components: ManagedCodexExtensionComponentResult[];
}

export interface ManagedCodexExtensionUpdateResult {
  success: boolean;
  extensionStatus: ManagedCodexExtensionStatus;
  error?: string;
}

export interface ManagedCodexCommandSpec {
  name: string;
  description: string;
  body: string;
  scope: 'project' | 'user' | 'plugin';
  sourceId: string;
  sourceLocalId?: string;
}

export interface ManagedCodexSkillSpec {
  name: string;
  description: string;
  /** Digest of the trusted SKILL.md contents; never the user-authored body. */
  contentSha256: string;
  path: string;
  scope: 'project' | 'user' | 'plugin';
  sourceId: string;
  sourceLocalId?: string;
}

export interface ManagedCodexAgentRoleSpec {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  skills: Array<{ name: string; path: string }>;
  scope: 'project' | 'user' | 'plugin';
  sourceId: string;
}

export interface ManagedCodexDynamicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ManagedCodexHostToolCall {
  processGeneration: string;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
  signal: AbortSignal;
}

export type ManagedCodexHostToolContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string }
  | { type: 'audio'; dataUrl: string };

export interface ManagedCodexHostToolResult {
  success: boolean;
  contentItems: ManagedCodexHostToolContentItem[];
}

export interface ManagedCodexHostToolDispatcher {
  readonly descriptors: readonly ManagedCodexDynamicToolSpec[];
  dispatch(call: ManagedCodexHostToolCall): Promise<ManagedCodexHostToolResult>;
  dispose(reason: string): void;
}

export interface ManagedCodexExtensionSnapshot {
  revision: string;
  workspacePath: string;
  scenario: InteractionScenario;
  enabledPluginIds: string[];
  skills: ManagedCodexSkillSpec[];
  commands: ManagedCodexCommandSpec[];
  agents: ManagedCodexAgentRoleSpec[];
  mcpServers: McpServerDefinition[];
  dynamicTools: ManagedCodexDynamicToolSpec[];
  hostToolDispatcher?: ManagedCodexHostToolDispatcher;
  components: ManagedCodexExtensionComponentResult[];
}

export interface ManagedCodexCommandExpansion {
  commandName: string;
  rawText: string;
  runtimeText: string;
  revision: string;
}
