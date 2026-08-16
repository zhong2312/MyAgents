import { describe, expect, it } from 'vitest';
import {
  resolveWorkbenchAiPromptCharacterLimit,
  resolveWorkbenchAiRunBudget,
  WORKBENCH_AI_EXTENDED_PROMPT_CHARACTER_LIMIT,
  WORKBENCH_AI_STANDARD_PROMPT_CHARACTER_LIMIT,
} from './workbench-ai-run-budget';

describe('resolveWorkbenchAiRunBudget', () => {
  it('keeps ordinary one-shot runs on the standard bounded budget', () => {
    expect(resolveWorkbenchAiRunBudget(undefined, 999_999)).toEqual({
      profile: 'standard',
      timeoutMs: 180_000,
      maxTurns: 8,
    });
  });

  it('defaults extended runs to five minutes and caps explicit requests at ten minutes', () => {
    expect(resolveWorkbenchAiRunBudget('extended', undefined)).toEqual({
      profile: 'extended',
      timeoutMs: 300_000,
      maxTurns: 16,
    });
    expect(resolveWorkbenchAiRunBudget('extended', 60_000, 8)).toMatchObject({
      timeoutMs: 60_000,
      maxTurns: 8,
    });
    expect(resolveWorkbenchAiRunBudget('extended', 60_000, 999)?.maxTurns).toBe(16);
    expect(resolveWorkbenchAiRunBudget('extended', 900_000)?.timeoutMs).toBe(600_000);
  });

  it('rejects unknown profiles instead of silently granting a larger budget', () => {
    expect(resolveWorkbenchAiRunBudget('unbounded', 900_000)).toBeNull();
  });

  it('only grants the larger prompt budget to the extended profile', () => {
    expect(resolveWorkbenchAiPromptCharacterLimit(undefined)).toBe(
      WORKBENCH_AI_STANDARD_PROMPT_CHARACTER_LIMIT,
    );
    expect(resolveWorkbenchAiPromptCharacterLimit('unbounded')).toBe(
      WORKBENCH_AI_STANDARD_PROMPT_CHARACTER_LIMIT,
    );
    expect(resolveWorkbenchAiPromptCharacterLimit('extended')).toBe(
      WORKBENCH_AI_EXTENDED_PROMPT_CHARACTER_LIMIT,
    );
  });
});
