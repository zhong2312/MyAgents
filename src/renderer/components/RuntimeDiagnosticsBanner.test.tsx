import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { RuntimeDiagnostics } from '../../shared/types/runtime';
import RuntimeDiagnosticsBanner from './RuntimeDiagnosticsBanner';

function expectTextContaining(...parts: string[]) {
  expect(
    screen.getAllByText((_content, element) => {
      const text = element?.textContent ?? '';
      return parts.every((part) => text.includes(part));
    }).length,
  ).toBeGreaterThan(0);
}

const blockingDiagnostics: RuntimeDiagnostics = {
  runtime: 'codex',
  runtimeSource: 'system-cli',
  timestamp: '2026-07-03T00:00:00.000Z',
  status: {
    auth: 'ok',
    apps: 'ok',
    mcpServers: 'ok',
    features: 'ok',
  },
  auth: {
    authMethod: null,
    requiresLogin: true,
  },
  effectiveEnv: {
    cwd: '/Users/example/project',
  },
};

describe('RuntimeDiagnosticsBanner i18n', () => {
  it('localizes diagnostic chrome while preserving raw runtime payloads', async () => {
    await i18n.changeLanguage('en-US');
    const diagnostics: RuntimeDiagnostics = {
      runtime: 'codex',
      timestamp: '2026-06-28T00:00:00.000Z',
      status: {
        auth: { error: '原始 auth 错误' },
        apps: 'ok',
        mcpServers: 'ok',
        features: 'unsupported',
      },
      auth: {
        authMethod: null,
        requiresLogin: true,
      },
      apps: [
        {
          id: 'artifact-tool',
          isEnabled: true,
          isAccessible: false,
          needsAuth: true,
        },
      ],
      mcpServers: [
        {
          name: '用户MCP',
          toolCount: 1,
          resourceCount: 0,
          state: 'failed',
          authStatus: 'oauth-required',
        },
      ],
      features: [
        {
          name: 'artifact',
          enabled: false,
          defaultEnabled: true,
        },
      ],
      effectiveEnv: {
        cwd: '/tmp/用户工作区',
        proxy: {
          http: 'http://127.0.0.1:7890',
          https: 'http://127.0.0.1:7890',
          no: 'localhost,127.0.0.1',
        },
        proxyPolicy: 'terminal',
        myagentsProxyInjected: false,
        hasOpenaiApiKey: false,
        hasAnthropicApiKey: true,
        hasCodexHome: true,
      },
    };

    render(<RuntimeDiagnosticsBanner diagnostics={diagnostics} />);

    const headline = screen.getByRole('button', { name: /Sign in to Codex to continue/ });
    expect(headline).toBeInTheDocument();

    await userEvent.click(headline);

    expect(screen.getByText('Problems')).toBeInTheDocument();
    expect(screen.getByText('Auth [Failed: 原始 auth 错误]')).toBeInTheDocument();
    expect(screen.queryByText('认证')).not.toBeInTheDocument();
    expect(screen.getByText(/Codex login required/)).toBeInTheDocument();
    expectTextContaining('inaccessible ', 'artifact-tool');
    expectTextContaining('用户MCP', 'state=failed');
    expectTextContaining('cwd: /tmp/用户工作区');
    expectTextContaining('Diagnostic snapshot: 2026-06-28T00:00:00.000Z. CLI sync info:');
  });
});

describe('RuntimeDiagnosticsBanner diagnostics action', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('calls onDiagnose for blocking diagnostics', () => {
    const onDiagnose = vi.fn();
    render(
      <RuntimeDiagnosticsBanner
        diagnostics={blockingDiagnostics}
        onDiagnose={onDiagnose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Ask helper to diagnose/ }));

    expect(onDiagnose).toHaveBeenCalledTimes(1);
    expect(onDiagnose).toHaveBeenCalledWith(blockingDiagnostics);
  });

  it('does not render diagnostics action for non-blocking diagnostics', () => {
    render(
      <RuntimeDiagnosticsBanner
        diagnostics={{
          ...blockingDiagnostics,
          auth: {
            authMethod: null,
            requiresLogin: false,
          },
        }}
        onDiagnose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Ask helper to diagnose/ })).not.toBeInTheDocument();
  });

  it('keeps warning RPC failures and safely skipped unsupported extensions log-only', () => {
    const { container } = render(
      <RuntimeDiagnosticsBanner
        diagnostics={{
          ...blockingDiagnostics,
          runtimeSource: 'managed-provider',
          auth: { authMethod: 'chatgpt', requiresLogin: false },
          status: {
            auth: 'ok',
            features: 'ok',
            mcpServers: { error: 'mcpServerStatus/list timed out' },
            apps: { error: 'app/list returned 403 Forbidden' },
          },
          issues: [
            {
              code: 'codex_mcp_status_failed',
              severity: 'warn',
              title: 'Codex MCP status failed',
              message: 'mcpServerStatus/list timed out',
            },
            {
              code: 'codex_app_status_failed',
              severity: 'warn',
              title: 'Codex app discovery failed',
              message: 'app/list returned 403 Forbidden',
            },
          ],
          extensions: {
            desiredRevision: 'same-revision',
            effectiveRevision: 'same-revision',
            state: 'unchanged',
            components: [
              {
                component: 'skills',
                id: 'workspace:claude-only-skill',
                state: 'unsupported',
                code: 'skill_unsupported_fields',
              },
              {
                component: 'plugins',
                id: 'plugin-with-hooks',
                state: 'unsupported',
                code: 'plugin_hooks_unsupported',
              },
            ],
          },
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('does not infer a blocker when every optional diagnostic RPC warns', () => {
    const { container } = render(
      <RuntimeDiagnosticsBanner
        diagnostics={{
          ...blockingDiagnostics,
          auth: { authMethod: 'chatgpt', requiresLogin: false },
          status: {
            auth: { error: 'auth query failed' },
            features: { error: 'feature query failed' },
            mcpServers: { error: 'MCP query failed' },
            apps: { error: 'app/list returned 403 Forbidden' },
          },
          issues: [
            {
              code: 'codex_auth_status_failed',
              severity: 'warn',
              title: 'Codex auth status failed',
              message: 'auth query failed',
            },
            {
              code: 'codex_app_status_failed',
              severity: 'warn',
              title: 'Codex app discovery failed',
              message: 'app/list returned 403 Forbidden',
            },
          ],
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('lists only producer-owned errors as blocking problems', async () => {
    render(
      <RuntimeDiagnosticsBanner
        diagnostics={{
          ...blockingDiagnostics,
          auth: { authMethod: 'chatgpt', requiresLogin: false },
          status: {
            auth: 'ok',
            features: 'ok',
            mcpServers: 'ok',
            apps: { error: 'app/list returned 403 Forbidden' },
          },
          issues: [
            {
              code: 'codex_app_status_failed',
              severity: 'warn',
              title: 'Codex app discovery failed',
              message: 'app/list returned 403 Forbidden',
            },
            {
              code: 'runtime_start_failed',
              severity: 'error',
              title: 'Codex runtime failed',
              message: 'Runtime process exited during startup.',
            },
          ],
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Codex runtime failed/ }));

    const problems = screen.getByText('Problems').parentElement!;
    expect(within(problems).getByText(/Runtime process exited during startup/)).toBeInTheDocument();
    expect(within(problems).queryByText(/app\/list returned 403/)).not.toBeInTheDocument();
  });

  it('silently skips failed optional extension components when the snapshot is healthy', () => {
    const { container } = render(
      <RuntimeDiagnosticsBanner
        diagnostics={{
          ...blockingDiagnostics,
          runtimeSource: 'managed-provider',
          auth: { authMethod: 'chatgpt', requiresLogin: false },
          extensions: {
            desiredRevision: 'same-revision',
            effectiveRevision: 'same-revision',
            state: 'unchanged',
            components: [
              {
                component: 'commands',
                id: 'workspace:BOOTSTRAP.md',
                state: 'failed',
                code: 'command_invalid_name',
              },
            ],
          },
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('still surfaces a failed extension snapshot', () => {
    render(
      <RuntimeDiagnosticsBanner
        diagnostics={{
          ...blockingDiagnostics,
          runtimeSource: 'managed-provider',
          auth: { authMethod: 'chatgpt', requiresLogin: false },
          extensions: {
            desiredRevision: 'desired-revision',
            effectiveRevision: 'effective-revision',
            state: 'failed',
            components: [],
          },
        }}
      />,
    );

    expect(screen.getByRole('button', {
      name: /Managed Codex extension application failed/,
    })).toBeInTheDocument();
  });

  it.each(['pending_next_start', 'deferred_until_idle'] as const)(
    'does not turn the normal %s extension lifecycle into a banner',
    (state) => {
      const { container } = render(
        <RuntimeDiagnosticsBanner
          diagnostics={{
            ...blockingDiagnostics,
            runtimeSource: 'managed-provider',
            auth: { authMethod: 'chatgpt', requiresLogin: false },
            extensions: {
              desiredRevision: 'desired-revision',
              effectiveRevision: null,
              state,
              components: [],
            },
          }}
        />,
      );

      expect(container).toBeEmptyDOMElement();
    },
  );

  it('keeps passive Host tool catalogue drift out of the blocking banner', () => {
    const diagnostics: RuntimeDiagnostics = {
      ...blockingDiagnostics,
      timestamp: '2026-08-08T00:00:00.000Z',
      auth: { authMethod: 'chatgpt', requiresLogin: false },
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
        desiredRevision: 'desired-revision',
        effectiveRevision: 'effective-revision',
        state: 'applied',
        components: [
          {
            component: 'skills',
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
    };
    const { container } = render(<RuntimeDiagnosticsBanner diagnostics={diagnostics} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps an optional MCP projection failure out of the banner when the generation applied', () => {
    const diagnostics: RuntimeDiagnostics = {
      ...blockingDiagnostics,
      auth: { authMethod: 'chatgpt', requiresLogin: false },
      issues: [],
      extensions: {
        desiredRevision: 'desired-revision',
        effectiveRevision: 'desired-revision',
        state: 'applied',
        components: [{
          component: 'mcp',
          id: 'unsafe-query',
          state: 'failed',
          code: 'mcp_projection_rejected',
          message: 'Unsafe URL query.',
        }],
      },
    };

    const { container } = render(<RuntimeDiagnosticsBanner diagnostics={diagnostics} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows only failed extension components when the snapshot itself failed', async () => {
    render(
      <RuntimeDiagnosticsBanner
        diagnostics={{
          ...blockingDiagnostics,
          auth: { authMethod: 'chatgpt', requiresLogin: false },
          extensions: {
            desiredRevision: 'desired-revision',
            effectiveRevision: 'effective-revision',
            state: 'failed',
            components: [
              {
                component: 'skills',
                id: 'workspace:valid-skill',
                state: 'applied',
                code: 'skill_compiled',
              },
              {
                component: 'mcp',
                id: 'broken-server',
                state: 'failed',
                code: 'extension_reconcile_failed',
                message: 'MCP startup failed.',
              },
            ],
          },
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', {
      name: /Managed Codex extension application failed/,
    }));

    expectTextContaining('Extension mcp/broken-server', 'MCP startup failed.');
    expect(screen.queryByText(/workspace:valid-skill/)).not.toBeInTheDocument();
  });
});
