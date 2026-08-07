import { describe, expect, test } from 'vitest';

import {
  normalizeRuntime,
  planSessionOpen,
  sessionRuntimeIdentityFromMetadataForOpen,
} from './sessionOpenPlan';

describe('planSessionOpen', () => {
  test('jumps to the tab that already owns the target session', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-a',
    })).toEqual({ type: 'jump-to-tab', tabId: 'tab-a' });
  });

  test('opens a new tab for an unopened persisted session', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
    })).toEqual({ type: 'open-new-tab' });
  });
});

describe('normalizeRuntime', () => {
  test('falls back to builtin for missing or unknown runtime values', () => {
    expect(normalizeRuntime(undefined)).toBe('builtin');
    expect(normalizeRuntime('unknown')).toBe('builtin');
    expect(normalizeRuntime('gemini')).toBe('gemini');
  });
});

describe('sessionRuntimeIdentityFromMetadataForOpen', () => {
  test('prefers managed provider identity when runtime metadata is missing', () => {
    expect(sessionRuntimeIdentityFromMetadataForOpen({
      providerExecutionIdentity: {
        kind: 'runtime-backed-provider',
        providerId: 'codex-sub',
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model: 'gpt-5.4-codex',
      },
    }, 'builtin')).toEqual({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
    });
  });

  test('normalizes builtin metadata without an external runtime source', () => {
    expect(sessionRuntimeIdentityFromMetadataForOpen({
      runtime: 'builtin',
      runtimeSource: 'managed-provider',
    }, 'codex')).toEqual({
      runtime: 'builtin',
      runtimeSource: undefined,
    });
  });
});
