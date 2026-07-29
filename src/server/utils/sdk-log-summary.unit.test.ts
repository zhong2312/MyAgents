import { describe, expect, it } from 'vitest';

import { summarizeSensitiveSdkMessage } from './sdk-log-summary';

describe('summarizeSensitiveSdkMessage', () => {
  it('keeps init diagnostics without workspace or plugin paths', () => {
    const summary = summarizeSensitiveSdkMessage({
      type: 'system',
      subtype: 'init',
      cwd: '/secret/workspace',
      session_id: 'secret-session',
      model: 'claude-test',
      permissionMode: 'default',
      tools: ['Read', 'Bash'],
      mcp_servers: [{ name: 'secret-server', status: 'connected' }],
      plugins: [{ name: 'secret-plugin', path: '/secret/plugin', version: '9.9.9' }],
      skills: ['secret-skill'],
      agents: ['secret-agent'],
      slash_commands: ['/secret-command'],
      capabilities: ['interrupt_receipt_v1'],
    });
    const serialized = JSON.stringify(summary);

    expect(summary).toEqual(expect.objectContaining({
      type: 'system',
      subtype: 'init',
      model: 'claude-test',
      toolCount: 2,
      mcpServerCount: 1,
      pluginCount: 1,
    }));
    expect(serialized).not.toContain('/secret');
    expect(serialized).not.toContain('secret-session');
    expect(serialized).not.toContain('9.9.9');
  });

  it('keeps result status and usage without assistant/error/tool content', () => {
    const summary = summarizeSensitiveSdkMessage({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'api_error',
      result: 'secret assistant output',
      errors: ['secret provider body'],
      permission_denials: [{ tool_input: { path: '/secret/file' } }],
      session_id: 'secret-session',
      duration_ms: 42,
      num_turns: 2,
      usage: { input_tokens: 12, output_tokens: 3 },
      modelUsage: { 'secret-model': {} },
    });
    const serialized = JSON.stringify(summary);

    expect(summary).toEqual(expect.objectContaining({
      type: 'result',
      isError: true,
      terminalReason: 'api_error',
      inputTokens: 12,
      outputTokens: 3,
      errorCount: 1,
      permissionDenialCount: 1,
    }));
    expect(serialized).not.toContain('secret assistant');
    expect(serialized).not.toContain('secret provider');
    expect(serialized).not.toContain('/secret');
    expect(serialized).not.toContain('secret-model');
  });

  it('summarizes assistant messages without model output or identifiers', () => {
    const summary = summarizeSensitiveSdkMessage({
      type: 'assistant',
      uuid: 'secret-message-id',
      session_id: 'secret-session',
      request_id: 'secret-request',
      parent_tool_use_id: 'secret-tool-id',
      task_description: 'secret task description',
      message: {
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'secret assistant output' }],
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    });
    const serialized = JSON.stringify(summary);

    expect(summary).toEqual({
      type: 'assistant',
      model: 'claude-test',
      stopReason: 'end_turn',
      error: undefined,
      aborted: false,
      contentBlockCount: 1,
      inputTokens: 12,
      outputTokens: 7,
    });
    expect(serialized).not.toContain('secret');
  });

  it('summarizes user and peer messages without prompts, origins, or tool results', () => {
    const summary = summarizeSensitiveSdkMessage({
      type: 'user',
      uuid: 'secret-message-id',
      session_id: 'secret-session',
      message: { content: [{ type: 'text', text: 'secret raw prompt' }] },
      tool_use_result: { stdout: 'secret tool output' },
      origin: {
        kind: 'peer',
        from: 'secret-peer',
        fromSession: 'secret-peer-session',
        body: 'secret peer body',
      },
      priority: 'next',
      shouldQuery: false,
    });
    const serialized = JSON.stringify(summary);

    expect(summary).toEqual({
      type: 'user',
      isSynthetic: false,
      shouldQuery: false,
      priority: 'next',
      originKind: 'peer',
      contentBlockCount: 1,
      hasToolUseResult: true,
    });
    expect(serialized).not.toContain('secret');
  });

  it('fails closed for unknown SDK payloads and non-record values', () => {
    const unknown = summarizeSensitiveSdkMessage({
      type: 'future_event',
      subtype: 'future_status',
      output: 'secret future payload',
      nested: { body: 'secret nested payload' },
    });

    expect(unknown).toEqual({ type: 'future_event', subtype: 'future_status' });
    expect(JSON.stringify(unknown)).not.toContain('secret');
    expect(summarizeSensitiveSdkMessage('secret raw value')).toEqual({ type: 'unknown' });
  });
});
