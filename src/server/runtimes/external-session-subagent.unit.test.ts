import { afterEach, describe, expect, it } from 'vitest';

import {
  buildExternalAssistantSnapshotContent,
  type PersistContentBlock,
  type PersistSubagentCall,
} from './external-session';
import {
  applyExternalSubagentLifecycle,
  finalizeExternalSubagentLifecyclesForTurn,
  finalizeExternalSubagentToolInput,
  finalizeExternalToolUseInput,
  flushExternalPendingToolInputsForTurn,
  getExternalContentBlocksRef,
  resetExternalContentState,
  startExternalSubagentToolUse,
  startExternalToolUseInput,
} from './external-session/content-blocks';

afterEach(() => resetExternalContentState());

function parseSnapshot(content: string | null): PersistContentBlock[] {
  expect(content).toBeTruthy();
  return JSON.parse(content!) as PersistContentBlock[];
}

describe('external-session sub-agent live snapshot', () => {
  it('nests pending child tools under a pending spawn parent instead of flattening them', () => {
    const childId = 'wait-1::subagent-control::spawn-1';
    const childCall: PersistSubagentCall = {
      id: childId,
      name: 'CollabAgent',
      input: { tool: 'wait' },
      inputJson: '{"tool":"wait"}',
      isLoading: true,
    };

    const blocks = parseSnapshot(buildExternalAssistantSnapshotContent({
      contentBlocks: [],
      pendingTextBuffer: '',
      pendingThinkingBlock: null,
      pendingToolInputs: new Map([
        ['spawn-1', { name: 'CollabAgent', inputJson: '{"tool":"spawnAgent"}' }],
        [childId, { name: 'CollabAgent', inputJson: '{"tool":"wait"}' }],
      ]),
      childToolToParent: new Map([[childId, 'spawn-1']]),
      pendingSubagentCallsByParent: new Map([['spawn-1', [childCall]]]),
      currentAssistantText: '',
    }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool?.id).toBe('spawn-1');
    expect(blocks[0].tool?.subagentCalls).toEqual([childCall]);
  });

  it('attaches pending child message traces to an already persisted spawn parent', () => {
    const messageTraceId = 'AgentMessage::child-thread::message-1::spawn-1';
    const childCall: PersistSubagentCall = {
      id: messageTraceId,
      name: 'AgentMessage',
      input: {},
      inputJson: '',
      result: 'child output',
      isLoading: true,
    };

    const blocks = parseSnapshot(buildExternalAssistantSnapshotContent({
      contentBlocks: [{
        type: 'tool_use',
        tool: {
          id: 'spawn-1',
          name: 'CollabAgent',
          input: { tool: 'spawnAgent' },
          inputJson: '{"tool":"spawnAgent"}',
          isLoading: true,
          streamIndex: 0,
        },
      }],
      pendingTextBuffer: '',
      pendingThinkingBlock: null,
      pendingToolInputs: new Map([[messageTraceId, { name: 'AgentMessage', inputJson: '' }]]),
      childToolToParent: new Map([[messageTraceId, 'spawn-1']]),
      pendingSubagentCallsByParent: new Map([['spawn-1', [childCall]]]),
      currentAssistantText: '',
    }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool?.id).toBe('spawn-1');
    expect(blocks[0].tool?.subagentCalls).toEqual([childCall]);
    expect(blocks.some((block) => block.tool?.id === messageTraceId)).toBe(false);
  });

  // Cross-review (#0.2.29) regression — a nested sub-agent tool that emits
  // rich-media (e.g. Codex child image_generation) must carry its `attachments`
  // into the persisted snapshot so history replay re-renders the gallery instead
  // of dropping the image. Pre-fix the snapshot subagentCalls had no attachments.
  it('preserves a sub-agent tool call\'s attachments through the persisted snapshot', () => {
    const childId = 'imggen-1::subagent-control::spawn-1';
    const childCall: PersistSubagentCall = {
      id: childId,
      name: 'image_generation',
      input: {},
      inputJson: '',
      result: 'Image generated',
      isLoading: false,
      attachments: [
        { kind: 'image', refPath: '/generated/tool-attachments/s/t/img.png', mimeType: 'image/png' },
      ],
    };

    const blocks = parseSnapshot(buildExternalAssistantSnapshotContent({
      contentBlocks: [{
        type: 'tool_use',
        tool: {
          id: 'spawn-1',
          name: 'CollabAgent',
          input: { tool: 'spawnAgent' },
          inputJson: '{"tool":"spawnAgent"}',
          isLoading: true,
          streamIndex: 0,
        },
      }],
      pendingTextBuffer: '',
      pendingThinkingBlock: null,
      pendingToolInputs: new Map(),
      childToolToParent: new Map([[childId, 'spawn-1']]),
      pendingSubagentCallsByParent: new Map([['spawn-1', [childCall]]]),
      currentAssistantText: '',
    }));

    expect(blocks).toHaveLength(1);
    const subagentCalls = blocks[0].tool?.subagentCalls;
    expect(subagentCalls).toHaveLength(1);
    expect(subagentCalls?.[0].attachments).toEqual([
      { kind: 'image', refPath: '/generated/tool-attachments/s/t/img.png', mimeType: 'image/png' },
    ]);
  });
});

describe('external-session sub-agent lifecycle owner', () => {
  function materializeParent(): void {
    startExternalToolUseInput({
      toolUseId: 'spawn-1',
      toolName: 'CollabAgent',
      toolInput: { tool: 'spawnAgent' },
    });
    finalizeExternalToolUseInput('spawn-1');
  }

  it('preserves terminal-before-parent ordering and rejects terminal regression', () => {
    expect(applyExternalSubagentLifecycle({
      parentToolUseId: 'spawn-1',
      status: 'running',
      observedAt: 100,
    })).toEqual({ status: 'running', startedAt: 100 });
    expect(applyExternalSubagentLifecycle({
      parentToolUseId: 'spawn-1',
      status: 'completed',
      observedAt: 250,
    })).toEqual({ status: 'completed', startedAt: 100, finishedAt: 250 });

    materializeParent();
    applyExternalSubagentLifecycle({
      parentToolUseId: 'spawn-1',
      status: 'running',
      observedAt: 400,
    });
    expect(getExternalContentBlocksRef()[0].tool?.subagentLifecycle).toEqual({
      status: 'completed',
      startedAt: 100,
      finishedAt: 250,
    });
  });

  it('fails closed at root and visibly closes a 600-call nested trace', () => {
    materializeParent();
    applyExternalSubagentLifecycle({
      parentToolUseId: 'spawn-1',
      status: 'running',
      observedAt: 100,
    });
    for (let index = 0; index < 600; index += 1) {
      startExternalSubagentToolUse({
        parentToolUseId: 'spawn-1',
        toolUseId: `child-${index}`,
        toolName: 'Bash',
      });
    }

    expect(finalizeExternalSubagentLifecyclesForTurn({
      status: 'failed',
      observedAt: 500,
    })).toEqual([{
      parentToolUseId: 'spawn-1',
      lifecycle: { status: 'failed', startedAt: 100, finishedAt: 500 },
    }]);
    const tool = getExternalContentBlocksRef()[0].tool;
    expect(tool?.subagentCalls).toHaveLength(600);
    expect(tool?.subagentCalls?.every(call => call.isLoading === false && call.isError === true)).toBe(true);
    expect(tool?.subagentCalls?.every(call => call.result === 'Failed')).toBe(true);
  });

  it('attaches a root-fenced pending lifecycle when root flush materializes its parent', () => {
    startExternalToolUseInput({
      toolUseId: 'spawn-pending',
      toolName: 'CollabAgent',
      toolInput: { tool: 'spawnAgent' },
    });
    applyExternalSubagentLifecycle({
      parentToolUseId: 'spawn-pending',
      status: 'running',
      observedAt: 100,
    });
    finalizeExternalSubagentLifecyclesForTurn({ status: 'failed', observedAt: 500 });

    flushExternalPendingToolInputsForTurn();

    expect(getExternalContentBlocksRef()[0].tool?.subagentLifecycle).toEqual({
      status: 'failed',
      startedAt: 100,
      finishedAt: 500,
    });
  });

  it('marks a resultless post-input nested call as interrupted at root stop', () => {
    materializeParent();
    applyExternalSubagentLifecycle({
      parentToolUseId: 'spawn-1',
      status: 'running',
      observedAt: 100,
    });
    startExternalSubagentToolUse({
      parentToolUseId: 'spawn-1',
      toolUseId: 'child-running',
      toolName: 'Bash',
      toolInput: { command: 'sleep 30' },
    });
    finalizeExternalSubagentToolInput('spawn-1', 'child-running');

    finalizeExternalSubagentLifecyclesForTurn({ status: 'interrupted', observedAt: 250 });

    expect(getExternalContentBlocksRef()[0].tool?.subagentCalls?.[0]).toMatchObject({
      isLoading: false,
      isError: true,
      result: 'Interrupted',
    });
  });

  it('keeps an accepted real terminal when the root fence runs', () => {
    materializeParent();
    applyExternalSubagentLifecycle({ parentToolUseId: 'spawn-1', status: 'running', observedAt: 100 });
    applyExternalSubagentLifecycle({ parentToolUseId: 'spawn-1', status: 'interrupted', observedAt: 220 });
    expect(finalizeExternalSubagentLifecyclesForTurn({ status: 'failed', observedAt: 500 })).toEqual([]);
    expect(getExternalContentBlocksRef()[0].tool?.subagentLifecycle?.status).toBe('interrupted');
  });
});
