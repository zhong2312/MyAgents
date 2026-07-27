// Regression: cold-restore pre-warm must resume an external (Codex) session with
// the SESSION SNAPSHOT's permission mode, not the renderer's racy prewarm default
// (e.g. 'auto', which maps to Codex's prompting on-request policy). Before the
// fix, prewarm trusted the caller value, resumed the thread with the wrong
// approvalPolicy, and the first send reused the pre-warmed process (Case 3) so it
// stuck — UI showed "No Restrictions" while Codex still prompted.

import { describe, expect, it } from 'vitest';

import { resolvePrewarmModel, resolvePrewarmPermissionMode } from './external-session';

describe('resolvePrewarmPermissionMode', () => {
  it('prefers the persisted session snapshot over the racy caller default', () => {
    // The exact failing case: snapshot = no-restrictions, caller sent 'auto'.
    expect(resolvePrewarmPermissionMode('no-restrictions', 'auto')).toBe('no-restrictions');
  });

  it('uses the snapshot even when the caller sends nothing', () => {
    expect(resolvePrewarmPermissionMode('no-restrictions', undefined)).toBe('no-restrictions');
  });

  it('falls back to the caller value for a brand-new session with no snapshot mode', () => {
    expect(resolvePrewarmPermissionMode(undefined, 'auto-edit')).toBe('auto-edit');
  });

  it('returns undefined when neither side has a value (runtime applies its default)', () => {
    expect(resolvePrewarmPermissionMode(undefined, undefined)).toBeUndefined();
  });

  it('honors any persisted mode, not just no-restrictions (e.g. a tightened session)', () => {
    expect(resolvePrewarmPermissionMode('suggest', 'auto')).toBe('suggest');
  });
});

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
