import { afterEach, describe, expect, it } from 'vitest';
import {
  applyExternalSubagentToolResult,
  appendExternalToolResultDeltaToContent,
  buildCurrentExternalAssistantSnapshotContent,
  finalizeExternalToolUseInput,
  replaceExternalToolUseInput,
  resetExternalContentState,
  startExternalSubagentToolUse,
  startExternalToolUseInput,
} from './content-blocks';

afterEach(() => resetExternalContentState());

describe('external live assistant content', () => {
  it('keeps top-level tool result deltas in the owner snapshot', () => {
    startExternalToolUseInput({ toolUseId: 'tool-1', toolName: 'Read' });
    finalizeExternalToolUseInput('tool-1');

    expect(appendExternalToolResultDeltaToContent('tool-1', 'partial')).toBe(true);

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool.result).toBe('partial');
  });

  it('keeps nested subagent result deltas in the owner snapshot', () => {
    startExternalToolUseInput({ toolUseId: 'parent', toolName: 'Task' });
    finalizeExternalToolUseInput('parent');
    startExternalSubagentToolUse({
      parentToolUseId: 'parent',
      toolUseId: 'child',
      toolName: 'AgentMessage',
    });

    expect(appendExternalToolResultDeltaToContent('child', 'working')).toBe(true);

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool.subagentCalls[0].result).toBe('working');
  });

  it('keeps a nested large-result ref in the owner snapshot', () => {
    startExternalToolUseInput({ toolUseId: 'parent', toolName: 'Task' });
    finalizeExternalToolUseInput('parent');
    startExternalSubagentToolUse({
      parentToolUseId: 'parent',
      toolUseId: 'child',
      toolName: 'Edit',
    });
    applyExternalSubagentToolResult({
      parentToolUseId: 'parent',
      toolUseId: 'child',
      content: 'preview',
      metadata: {
        largeValueRef: {
          kind: 'ref',
          id: 'a1b2c3d4',
          sizeBytes: 300_000,
          mimetype: 'text/plain',
          preview: 'preview',
          expiresAt: Date.now() + 60_000,
        },
      },
    });

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool.subagentCalls[0].resultMeta.largeValueRef).toMatchObject({
      id: 'a1b2c3d4',
      sizeBytes: 300_000,
    });
  });

  it('replaces a started tool snapshot with completion-owned input before persistence', () => {
    startExternalToolUseInput({
      toolUseId: 'edit-1',
      toolName: 'Edit',
      toolInput: { file_path: '/workspace/a.ts' },
    });

    expect(replaceExternalToolUseInput('edit-1', {
      file_path: '/workspace/a.ts',
      changes: [{
        path: '/workspace/a.ts',
        kind: { type: 'update' },
        diff: 'applied',
      }],
    })).toBe('Edit');
    expect(finalizeExternalToolUseInput('edit-1')).toBe(true);

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool.input).toEqual({
      file_path: '/workspace/a.ts',
      changes: [
        { path: '/workspace/a.ts', kind: { type: 'update' }, diff: 'applied' },
      ],
    });
  });
});
