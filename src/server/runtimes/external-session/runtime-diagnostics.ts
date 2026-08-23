import type {
  RuntimeDiagnostics,
  RuntimeExtensionDiagnostics,
} from '../../../shared/types/runtime';

export interface RuntimeDiagnosticLogEntry {
  level: 'warn' | 'error';
  message: string;
}

const MAX_VISIBLE_DIAGNOSTIC_ITEMS = 5;
const MAX_DIAGNOSTIC_LOG_MESSAGE_LENGTH = 512;

function runtimeExtensionDiagnosticsEqual(
  left: RuntimeExtensionDiagnostics | undefined,
  right: RuntimeExtensionDiagnostics,
): boolean {
  if (!left) return false;
  if (
    left.desiredRevision !== right.desiredRevision
    || left.effectiveRevision !== right.effectiveRevision
    || left.state !== right.state
    || left.components.length !== right.components.length
  ) {
    return false;
  }
  return left.components.every((component, index) => {
    const candidate = right.components[index];
    return component.component === candidate.component
      && component.id === candidate.id
      && component.state === candidate.state
      && component.code === candidate.code
      && component.message === candidate.message
      && component.requiresUserAction === candidate.requiresUserAction;
  });
}

/**
 * Product-extension reconciliation projects into the latest Runtime-owned
 * diagnostics snapshot; it is not a new Runtime diagnostics collection.
 * Return null for an idempotent projection and preserve the producer timestamp
 * for a real extension transition.
 */
export function projectRuntimeDiagnosticsExtensionChange(
  current: RuntimeDiagnostics,
  extensions: RuntimeExtensionDiagnostics,
): RuntimeDiagnostics | null {
  if (runtimeExtensionDiagnosticsEqual(current.extensions, extensions)) return null;
  return { ...current, extensions };
}

function boundDiagnosticLogMessage(message: string): string {
  if (message.length <= MAX_DIAGNOSTIC_LOG_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_DIAGNOSTIC_LOG_MESSAGE_LENGTH - 1)}…`;
}

export function projectRuntimeExtensionDiagnosticLogEntry(
  extensions: RuntimeExtensionDiagnostics | undefined,
): RuntimeDiagnosticLogEntry | null {
  const degradedExtensions = extensions?.components.filter(component => (
    component.state === 'failed' || component.state === 'unsupported'
  )) ?? [];
  if (degradedExtensions.length === 0) return null;

  const visible = degradedExtensions.slice(0, MAX_VISIBLE_DIAGNOSTIC_ITEMS).map(component => {
    const identity = `${component.component}${component.id ? `/${component.id}` : ''}`;
    const reason = component.message ? `: ${component.message.slice(0, 120)}` : '';
    return `${identity} (${component.code}${reason})`;
  });
  const remainder = degradedExtensions.length > visible.length
    ? `; +${degradedExtensions.length - visible.length} more`
    : '';
  return {
    level: extensions?.state === 'failed' ? 'error' : 'warn',
    message: boundDiagnosticLogMessage(
      `[codex-diag] Managed Codex extension component(s) degraded: ${visible.join('; ')}${remainder}`,
    ),
  };
}

/**
 * Project one diagnostics snapshot into a bounded Logs-panel summary.
 * `issues` owns RPC severity, so reading the duplicate raw `status` errors
 * here would emit every app/MCP failure twice.
 */
export function projectRuntimeDiagnosticLogEntries(
  diagnostics: RuntimeDiagnostics,
): RuntimeDiagnosticLogEntry[] {
  const issues = diagnostics.issues ?? [];
  const visibleIssues = issues.slice(0, MAX_VISIBLE_DIAGNOSTIC_ITEMS);
  const entries: RuntimeDiagnosticLogEntry[] = visibleIssues.map(issue => ({
    level: issue.severity === 'error' ? 'error' : 'warn',
    message: boundDiagnosticLogMessage(`[codex-diag] ${issue.code}: ${issue.message}`),
  }));
  if (issues.length > visibleIssues.length) {
    const omitted = issues.slice(visibleIssues.length);
    entries.push({
      level: omitted.some(issue => issue.severity === 'error') ? 'error' : 'warn',
      message: boundDiagnosticLogMessage(
        `[codex-diag] ${omitted.length} additional diagnostic issue(s) omitted; see the Runtime diagnostics snapshot`,
      ),
    });
  }

  const extensionEntry = projectRuntimeExtensionDiagnosticLogEntry(diagnostics.extensions);
  if (extensionEntry) entries.push(extensionEntry);
  return entries;
}
