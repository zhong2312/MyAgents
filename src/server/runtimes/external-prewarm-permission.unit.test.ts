// Prewarm model selection keeps the persisted Session snapshot ahead of the
// renderer hint. Permission no longer has a renderer hint at all: prewarm reads
// it directly through resolveWorkspaceConfig.

import { describe, expect, it } from 'vitest';

import { resolvePrewarmModel } from './external-session';

describe('resolvePrewarmModel', () => {
  it('prefers the persisted session snapshot over a missing or racy caller model', () => {
    expect(resolvePrewarmModel('gpt-5.6-sol', undefined)).toBe('gpt-5.6-sol');
    expect(resolvePrewarmModel('gpt-5.6-sol', 'gpt-5.5')).toBe('gpt-5.6-sol');
  });

  it('falls back to the caller model for a brand-new session', () => {
    expect(resolvePrewarmModel(undefined, 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolvePrewarmModel(undefined, undefined)).toBeUndefined();
  });
});
