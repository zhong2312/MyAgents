import { describe, expect, it } from 'vitest';

import {
  classifyExternalTurnFailureCleanup,
  isExternalModelFallbackRestartNeeded,
  isSuccessfulExternalTurnCompletion,
  summarizeExternalRuntimeMessageForLog,
} from './external-session';

describe('external turn completion status', () => {
  it('treats only successful runtime statuses as a successful turn', () => {
    expect(isSuccessfulExternalTurnCompletion({})).toBe(true);
    expect(isSuccessfulExternalTurnCompletion({ status: 'completed' })).toBe(true);
    expect(isSuccessfulExternalTurnCompletion({ status: 'success' })).toBe(true);
    expect(isSuccessfulExternalTurnCompletion({ status: 'succeeded' })).toBe(true);

    expect(isSuccessfulExternalTurnCompletion({ status: 'interrupted' })).toBe(false);
    expect(isSuccessfulExternalTurnCompletion({ status: 'cancelled' })).toBe(false);
    expect(isSuccessfulExternalTurnCompletion({ status: 'failed' })).toBe(false);
  });

  it('does not restart fallback runtimes for a model already reported by the live process', () => {
    expect(isExternalModelFallbackRestartNeeded('gpt-5.5', '', 'gpt-5.5')).toBe(false);
    expect(isExternalModelFallbackRestartNeeded('gpt-5.5', 'gpt-5.5', '')).toBe(false);

    expect(isExternalModelFallbackRestartNeeded('gpt-5.5', '', '')).toBe(true);
    expect(isExternalModelFallbackRestartNeeded('gpt-5.5', 'gpt-5.1', 'gpt-5.1')).toBe(true);
  });

  it('defers cleanup to stopExternalSession during intentional teardown', () => {
    expect(classifyExternalTurnFailureCleanup({ status: 'interrupted' }, true)).toBe('defer-to-stop');
    expect(classifyExternalTurnFailureCleanup({ status: 'failed' }, true)).toBe('defer-to-stop');

    expect(classifyExternalTurnFailureCleanup({ status: 'interrupted' }, false)).toBe('stopped');
    expect(classifyExternalTurnFailureCleanup({ status: 'cancelled' }, false)).toBe('stopped');
    expect(classifyExternalTurnFailureCleanup({ status: 'failed' }, false)).toBe('error');
  });

  it('projects terminal provider errors into irreversible log metadata', () => {
    const marker = 'EXTERNAL_TERMINAL_PRIVATE_MARKER';
    const summary = summarizeExternalRuntimeMessageForLog(
      `${marker} at /Users/private/provider-body`,
    );

    expect(summary).toMatch(/^\{"present":true,"chars":\d+,"hash":"[a-f0-9]{12}"\}$/);
    expect(summary).not.toContain(marker);
    expect(summary).not.toContain('/Users/private');
  });
});
