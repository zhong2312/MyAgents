import type { RuntimeSource } from './types/runtime';

const MINIMUM_CODEX_CONVERSATION_BRANCH_VERSION = [0, 143, 0] as const;
const OFFICIAL_STABLE_VERSION = /^(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)$/i;

export function supportsCodexConversationBranch(
  runtimeSource: RuntimeSource | undefined,
  version: string | undefined,
): boolean {
  if (runtimeSource === 'managed-provider') return true;
  if (runtimeSource !== 'system-cli' || !version) return false;
  const match = OFFICIAL_STABLE_VERSION.exec(version.trim());
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < MINIMUM_CODEX_CONVERSATION_BRANCH_VERSION.length; index += 1) {
    if (actual[index] !== MINIMUM_CODEX_CONVERSATION_BRANCH_VERSION[index]) {
      return actual[index] > MINIMUM_CODEX_CONVERSATION_BRANCH_VERSION[index];
    }
  }
  return true;
}
