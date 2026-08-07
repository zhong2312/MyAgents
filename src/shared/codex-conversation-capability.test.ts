import { describe, expect, it } from 'vitest';

import { supportsCodexConversationBranch } from './codex-conversation-capability';

describe('Codex conversation branch capability', () => {
  it('uses the managed runtime lock and a strict System CLI semver floor', () => {
    expect(supportsCodexConversationBranch('managed-provider', undefined)).toBe(true);
    expect(supportsCodexConversationBranch('system-cli', '0.142.9')).toBe(false);
    expect(supportsCodexConversationBranch('system-cli', '0.143.0')).toBe(true);
    expect(supportsCodexConversationBranch('system-cli', '0.146.0')).toBe(true);
    expect(supportsCodexConversationBranch('system-cli', '0.143.0-alpha.1')).toBe(false);
    expect(supportsCodexConversationBranch('system-cli', 'codex-cli 0.146.0')).toBe(true);
    expect(supportsCodexConversationBranch('system-cli', '0.146.0 dirty')).toBe(false);
    expect(supportsCodexConversationBranch('system-cli', undefined)).toBe(false);
  });
});
