import { describe, expect, it } from 'vitest';
import type { RuntimeDiagnostics } from '../../../shared/types/runtime';
import {
  projectRuntimeDiagnosticsExtensionChange,
  projectRuntimeDiagnosticLogEntries,
  projectRuntimeExtensionDiagnosticLogEntry,
} from './runtime-diagnostics';

function diagnostics(overrides: Partial<RuntimeDiagnostics> = {}): RuntimeDiagnostics {
  return {
    runtime: 'codex',
    runtimeSource: 'managed-provider',
    timestamp: '2026-08-09T15:12:47.471Z',
    status: {
      auth: 'ok',
      features: 'ok',
      mcpServers: 'ok',
      apps: 'ok',
    },
    effectiveEnv: { cwd: '/workspace' },
    ...overrides,
  };
}

describe('Runtime diagnostics log projection', () => {
  it('does not manufacture a new diagnostics snapshot when extensions are unchanged', () => {
    const current = diagnostics({
      extensions: {
        desiredRevision: 'revision-one',
        effectiveRevision: 'revision-one',
        state: 'applied',
        components: [{ component: 'skills', state: 'applied', code: 'skill_compiled' }],
      },
    });

    expect(projectRuntimeDiagnosticsExtensionChange(current, current.extensions!)).toBeNull();
  });

  it('preserves the producer timestamp when only extension state changes', () => {
    const current = diagnostics({
      extensions: {
        desiredRevision: 'revision-one',
        effectiveRevision: 'revision-one',
        state: 'applied',
        components: [],
      },
    });
    const extensions = {
      desiredRevision: 'revision-two',
      effectiveRevision: 'revision-one',
      state: 'pending_next_start' as const,
      components: [],
    };

    expect(projectRuntimeDiagnosticsExtensionChange(current, extensions)).toEqual({
      ...current,
      extensions,
    });
  });

  it('logs app discovery and Host tool degradation once without successful Skills', () => {
    const entries = projectRuntimeDiagnosticLogEntries(diagnostics({
      status: {
        auth: 'ok',
        features: 'ok',
        mcpServers: 'ok',
        apps: { error: 'app/list returned 403 Forbidden' },
      },
      issues: [{
        code: 'codex_app_status_failed',
        severity: 'warn',
        title: 'Codex app discovery failed',
        message: 'app/list returned 403 Forbidden',
      }],
      extensions: {
        desiredRevision: 'desired',
        effectiveRevision: 'effective',
        state: 'applied',
        components: [
          {
            component: 'skills',
            id: 'workspace:valid-skill',
            state: 'applied',
            code: 'skill_compiled',
          },
          {
            component: 'host_tools',
            state: 'unsupported',
            code: 'host_tools_catalog_immutable',
            message: 'Start a new Product Session.',
            requiresUserAction: true,
          },
        ],
      },
    }));

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      level: 'warn',
      message: '[codex-diag] codex_app_status_failed: app/list returned 403 Forbidden',
    });
    expect(entries[1]).toMatchObject({
      level: 'warn',
      message: expect.stringContaining('host_tools (host_tools_catalog_immutable'),
    });
    expect(entries.map(entry => entry.message).join('\n')).not.toContain('workspace:valid-skill');
  });

  it('promotes extension degradation to an error only when the snapshot failed', () => {
    const entry = projectRuntimeExtensionDiagnosticLogEntry({
      desiredRevision: 'desired',
      effectiveRevision: 'effective',
      state: 'failed',
      components: [{
        component: 'mcp',
        id: 'broken-server',
        state: 'failed',
        code: 'extension_reconcile_failed',
        message: 'MCP startup failed.',
      }],
    });

    expect(entry).toMatchObject({ level: 'error' });
  });

  it('keeps an optional MCP projection failure at warning severity after generation apply', () => {
    const entry = projectRuntimeExtensionDiagnosticLogEntry({
      desiredRevision: 'desired',
      effectiveRevision: 'desired',
      state: 'applied',
      components: [{
        component: 'mcp',
        id: 'unsafe-query',
        state: 'failed',
        code: 'mcp_projection_rejected',
        message: 'Unsafe URL query.',
      }],
    });

    expect(entry).toMatchObject({
      level: 'warn',
      message: expect.stringContaining('mcp/unsafe-query'),
    });
  });

  it('caps issue fan-out and preserves omitted error severity in one summary', () => {
    const entries = projectRuntimeDiagnosticLogEntries(diagnostics({
      issues: Array.from({ length: 12 }, (_, index) => ({
        code: `issue_${index}`,
        severity: index === 11 ? 'error' as const : 'warn' as const,
        title: `Issue ${index}`,
        message: `Message ${index}`,
      })),
    }));

    expect(entries).toHaveLength(6);
    expect(entries.at(-1)).toEqual({
      level: 'error',
      message: '[codex-diag] 7 additional diagnostic issue(s) omitted; see the Runtime diagnostics snapshot',
    });
  });

  it('bounds complete log messages even when diagnostic identity fields are untrusted', () => {
    const oversized = 'x'.repeat(2_000);
    const issueEntry = projectRuntimeDiagnosticLogEntries(diagnostics({
      issues: [{
        code: oversized,
        severity: 'warn',
        title: 'Oversized issue',
        message: oversized,
      }],
    }))[0];
    const extensionEntry = projectRuntimeExtensionDiagnosticLogEntry({
      desiredRevision: 'desired',
      effectiveRevision: 'effective',
      state: 'applied',
      components: [{
        component: 'skills',
        id: oversized,
        state: 'unsupported',
        code: oversized,
        message: oversized,
      }],
    });

    expect(issueEntry.message).toHaveLength(512);
    expect(issueEntry.message.endsWith('…')).toBe(true);
    expect(extensionEntry?.message).toHaveLength(512);
    expect(extensionEntry?.message.endsWith('…')).toBe(true);
  });
});
