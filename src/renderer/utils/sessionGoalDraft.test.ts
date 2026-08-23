import { describe, expect, it } from 'vitest';

import { createDefaultSessionGoalDraftConfig } from './sessionGoalDraft';

describe('createDefaultSessionGoalDraftConfig', () => {
  it('arms the lightweight Goal draft with runtime birth fields', () => {
    expect(createDefaultSessionGoalDraftConfig({
      runtime: 'codex',
      permissionMode: 'full-auto',
    })).toEqual({
      taskKind: 'goal',
      prompt: '',
      endConditions: { aiCanExit: true },
      notifyEnabled: true,
      permissionMode: 'full-auto',
      runtime: 'codex',
    });
  });

  it('returns a fresh end-condition object for each draft', () => {
    const first = createDefaultSessionGoalDraftConfig({});
    const second = createDefaultSessionGoalDraftConfig({});

    expect(first.endConditions).not.toBe(second.endConditions);
  });
});
