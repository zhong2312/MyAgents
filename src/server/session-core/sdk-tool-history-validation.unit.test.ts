import { describe, expect, it } from 'vitest';
import type { MessageWire } from '../builtin-session/types';
import {
  findMalformedSdkToolHistory,
  findMalformedToolHistory,
  hasMalformedRawToolContent,
  isInvalidProviderParameterError,
  nextMalformedToolRecoveryAttempt,
  repairMalformedToolHistory,
} from './sdk-tool-history-validation';

function message(content: MessageWire['content']): MessageWire {
  return {
    id: 'm1',
    role: 'assistant',
    content,
    timestamp: '2026-08-07T00:00:00.000Z',
  };
}

describe('SDK tool history validation', () => {
  it('rejects empty tool ids and names in persisted MessageWire blocks', () => {
    const messages = [message([{
      type: 'tool_use',
      tool: { id: '', name: '  ', input: {}, streamIndex: 0 },
    }])];

    expect(findMalformedToolHistory(messages).map(issue => issue.reason)).toEqual([
      'missing_id',
      'missing_name',
    ]);
  });

  it('rejects raw SDK tool results without a tool_use_id', () => {
    expect(hasMalformedRawToolContent([{
      type: 'tool_result',
      tool_use_id: '',
      content: 'failed',
    }])).toBe(true);
  });

  it('accepts valid raw SDK tool calls and results', () => {
    const sdkMessages = [{
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'novel_world_get_draft', input: {} },
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
        ],
      },
    }];

    expect(findMalformedSdkToolHistory(sdkMessages)).toEqual([]);
  });

  it('removes only malformed blocks and preserves valid text and tools', () => {
    const source = [message([
      { type: 'text', text: '保留说明' },
      { type: 'tool_use', tool: { id: '', name: '', input: {}, streamIndex: 1 } },
      { type: 'tool_use', tool: { id: 'ok', name: 'Read', input: {}, streamIndex: 2 } },
    ])];

    const repair = repairMalformedToolHistory(source);

    expect(repair.issues).toHaveLength(2);
    expect(repair.changedMessageIds).toEqual(['m1']);
    expect(repair.removedMessageIds).toEqual([]);
    expect(repair.messages[0].content).toEqual([
      { type: 'text', text: '保留说明' },
      { type: 'tool_use', tool: { id: 'ok', name: 'Read', input: {}, streamIndex: 2 } },
    ]);
  });

  it('drops a message that contains only malformed tool blocks', () => {
    const repair = repairMalformedToolHistory([message([{
      type: 'tool_use',
      tool: { id: '', name: '', input: {}, streamIndex: 0 },
    }])]);

    expect(repair.messages).toEqual([]);
    expect(repair.removedMessageIds).toEqual(['m1']);
  });

  it('allows exactly one hidden recovery attempt', () => {
    expect(nextMalformedToolRecoveryAttempt()).toBe(1);
    expect(nextMalformedToolRecoveryAttempt(1)).toBeNull();
  });

  it('matches the provider error reported for polluted tool history', () => {
    expect(isInvalidProviderParameterError(
      'API Error: 400 A parameter specified in the request is not valid Request id: abc',
    )).toBe(true);
    expect(isInvalidProviderParameterError('API Error: 429 rate limited')).toBe(false);
  });
});
