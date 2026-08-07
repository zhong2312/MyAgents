import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TITLE_TIMEOUT_MS,
  buildExternalTitleSessionOptions,
  extractTitleTextFromSdkMessage,
} from './title-generator';

describe('extractTitleTextFromSdkMessage', () => {
  it('reads text even when a thinking block precedes it', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hidden reasoning' },
          { type: 'text', text: '会话标题' },
        ],
      },
    })).toBe('会话标题');
  });

  it('joins multiple assistant text blocks and ignores non-text blocks', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'MyAgents ' },
          { type: 'tool_use', id: 'toolu_1' },
          { type: 'text', text: '标题修复' },
        ],
      },
    })).toBe('MyAgents 标题修复');
  });

  it('falls back to the last assistant message from a success result', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'result',
      subtype: 'success',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'first draft' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '最终标题' }] },
      ],
    })).toBe('最终标题');
  });

  it('reads the SDK 0.3 result.result field when no assistant message is present', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'result',
      subtype: 'success',
      result: 'Result 字段标题',
    })).toBe('Result 字段标题');
  });

  it('returns null for whitespace-only or failed result messages', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   ' }] },
    })).toBeNull();
    expect(extractTitleTextFromSdkMessage({
      type: 'result',
      subtype: 'error_during_execution',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ignored' }] }],
    })).toBeNull();
  });
});

describe('BUILTIN_TITLE_TIMEOUT_MS', () => {
  it('keeps builtin title generation within the same 30s budget as external title generation', () => {
    expect(BUILTIN_TITLE_TIMEOUT_MS).toBe(30_000);
  });
});

describe('buildExternalTitleSessionOptions', () => {
  const base = {
    sessionId: 'title-session',
    workspacePath: '/workspace',
    userPrompt: 'Write the title',
    runtimeType: 'codex' as const,
    model: 'gpt-5.6-sol',
  };

  it('keeps Managed Codex identity while disabling workspace MCP for the utility turn', () => {
    const options = buildExternalTitleSessionOptions({
      ...base,
      runtimeSource: 'managed-provider',
    });

    expect(options).toMatchObject({
      runtimeSource: 'managed-provider',
      mcpServers: [],
      permissionMode: 'suggest',
      reasoningEffort: 'low',
      ephemeral: true,
      maxTurns: 1,
      scenario: { type: 'desktop' },
    });
  });

  it('preserves system-cli ownership without pretending an empty injected set clears user config', () => {
    const options = buildExternalTitleSessionOptions({
      ...base,
      runtimeSource: 'system-cli',
    });

    expect(options.runtimeSource).toBe('system-cli');
    expect(options).not.toHaveProperty('mcpServers');
    expect(options).not.toHaveProperty('reasoningEffort');
    expect(options).not.toHaveProperty('ephemeral');
  });
});
