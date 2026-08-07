import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  metadata: undefined as Record<string, unknown> | undefined,
  data: undefined as { messages: unknown[] } | undefined,
  broadcast: vi.fn(),
}));

vi.mock('../../sse', () => ({
  broadcast: mocks.broadcast,
}));

vi.mock('../../SessionStore', () => ({
  getSessionMetadata: vi.fn(() => mocks.metadata),
  getSessionData: vi.fn(() => mocks.data),
  loadSessionTranscript: vi.fn(async () => ({
    messages: mocks.data?.messages ?? [],
    cursor: { persistedMessageCount: mocks.data?.messages.length ?? 0 },
    hasMalformedRows: false,
  })),
  appendSessionMessages: vi.fn(),
  mutateSessionTranscript: vi.fn(),
  saveSessionMetadata: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));

import {
  hasPendingExternalAskUserQuestion,
  respondExternalPermission,
  respondExternalAskUserQuestion,
} from '../external-session';
import { setExternalActiveProcess, setExternalActiveRuntime, resetExternalLifecycleState } from './lifecycle';
import {
  getExternalInteractiveRequest,
  getExternalPermissionSuggestions,
  resetExternalInteractiveState,
  setExternalAskUserQuestion,
  setExternalInteractiveRequest,
  setExternalPermissionSuggestions,
} from './interactive';
import type { AgentRuntime, RuntimeProcess } from '../types';

describe('external interactive owner integration', () => {
  beforeEach(() => {
    resetExternalInteractiveState();
    resetExternalLifecycleState();
    mocks.broadcast.mockClear();
  });

  it('does not consume AskUserQuestion pending state when the runtime process is gone', async () => {
    const requestId = 'ask-process-gone';
    setExternalAskUserQuestion(requestId, {
      input: {
        questions: [
          {
            question: 'Continue?',
            header: 'Confirm',
            options: [{ label: 'Yes', description: 'Proceed' }],
            multiSelect: false,
          },
        ],
      },
    });
    setExternalInteractiveRequest(requestId, {
      type: 'ask-user-question:request',
      data: {
        requestId,
        questions: [
          {
            question: 'Continue?',
            header: 'Confirm',
            options: [{ label: 'Yes', description: 'Proceed' }],
            multiSelect: false,
          },
        ],
        previewFormat: 'html',
      },
    });

    await expect(respondExternalAskUserQuestion(requestId, { '0': 'Yes' })).resolves.toBe(false);
    expect(hasPendingExternalAskUserQuestion(requestId)).toBe(true);
  });

  it('keeps permission pending state when runtime delivery fails', async () => {
    const requestId = 'perm-delivery-fails';
    const respondPermission = vi.fn(async () => {
      throw new Error('stdin closed');
    });
    setExternalActiveProcess({
      pid: 123,
      exited: false,
      writeLine: vi.fn(async () => undefined),
      kill: vi.fn(),
      waitForExit: vi.fn(async () => 0),
    } satisfies RuntimeProcess, []);
    setExternalActiveRuntime({
      type: 'codex',
      respondPermission,
    } as unknown as AgentRuntime);
    setExternalPermissionSuggestions(requestId, ['suggested-rule']);
    setExternalInteractiveRequest(requestId, {
      type: 'permission:request',
      data: {
        requestId,
        toolName: 'Edit',
        toolUseId: 'tool-1',
        input: '{}',
      },
    });

    await expect(respondExternalPermission(requestId, 'always_allow')).rejects.toThrow('stdin closed');
    expect(getExternalPermissionSuggestions(requestId)).toEqual(['suggested-rule']);
    expect(getExternalInteractiveRequest(requestId)).toMatchObject({
      type: 'permission:request',
      data: { requestId },
    });
    expect(respondPermission).toHaveBeenCalledWith(
      expect.anything(),
      requestId,
      'always_allow',
      undefined,
      ['suggested-rule'],
    );
    expect(mocks.broadcast).not.toHaveBeenCalledWith('permission:expired', expect.anything());
  });

  it('broadcasts permission expiry after successful runtime delivery', async () => {
    const requestId = 'perm-delivery-ok';
    const respondPermission = vi.fn(async () => undefined);
    setExternalActiveProcess({
      pid: 123,
      exited: false,
      writeLine: vi.fn(async () => undefined),
      kill: vi.fn(),
      waitForExit: vi.fn(async () => 0),
    } satisfies RuntimeProcess, []);
    setExternalActiveRuntime({
      type: 'codex',
      respondPermission,
    } as unknown as AgentRuntime);
    setExternalInteractiveRequest(requestId, {
      type: 'permission:request',
      data: {
        requestId,
        toolName: 'Shell',
        toolUseId: 'tool-2',
        input: '{}',
      },
    });

    await expect(respondExternalPermission(requestId, 'allow_once')).resolves.toBe(true);

    expect(mocks.broadcast).toHaveBeenCalledWith('permission:expired', {
      requestId,
      reason: 'resolved',
    });
    expect(getExternalInteractiveRequest(requestId)).toBeUndefined();
  });
});
