import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSessionData: vi.fn(),
  getSessionMetadata: vi.fn(),
  updateSessionMetadata: vi.fn(),
  broadcast: vi.fn(),
  setPostTurnTitleHook: vi.fn(),
  generateTitle: vi.fn(),
  generateTitleExternal: vi.fn(),
}));

vi.mock('./SessionStore', () => ({
  getSessionData: mocks.getSessionData,
  getSessionMetadata: mocks.getSessionMetadata,
  updateSessionMetadata: mocks.updateSessionMetadata,
}));

vi.mock('./sse', () => ({
  broadcast: mocks.broadcast,
}));

vi.mock('./turn-hooks', () => ({
  setPostTurnTitleHook: mocks.setPostTurnTitleHook,
}));

vi.mock('./title-generator', () => ({
  generateTitle: mocks.generateTitle,
  generateTitleExternal: mocks.generateTitleExternal,
}));

import { generateAndApplyTitle } from './session-title-service';

describe('generateAndApplyTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionMetadata.mockReturnValue({
      id: 'session-1',
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      titleSource: 'default',
    });
    mocks.generateTitleExternal.mockResolvedValue(null);
  });

  it('preserves the Session runtime source for external title generation', async () => {
    const rounds = [{ user: '原始问题', assistant: '回答' }];

    await generateAndApplyTitle(
      'session-1',
      rounds,
      'codex',
      'gpt-5.6-sol',
      undefined,
      '/workspace',
    );

    expect(mocks.generateTitleExternal).toHaveBeenCalledWith(
      rounds,
      'codex',
      'gpt-5.6-sol',
      '/workspace',
      'managed-provider',
    );
  });
});
