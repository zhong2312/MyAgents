/**
 * Raw persisted workspace fields from pre-0.4.4 Agent/IM records.
 *
 * These helpers are the only TypeScript boundary allowed to inspect the
 * retired fields. Callers receive plain strings and must immediately resolve
 * them through Project authority; normal AgentConfig code never sees either
 * property in its type.
 */
function readLegacyStringField(record: unknown, field: string): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const value = (record as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readLegacyAgentWorkspacePath(record: unknown): string | undefined {
  return readLegacyStringField(record, 'workspacePath');
}

export function readLegacyImBotWorkspacePath(record: unknown): string | undefined {
  return readLegacyStringField(record, 'defaultWorkspacePath');
}
