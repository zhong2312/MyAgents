import { describe, expect, it } from 'vitest';

import { MYAGENTS_TOOL_CALL_TIMEOUT_MS } from './tool-call-policy';

describe('MYAGENTS_TOOL_CALL_TIMEOUT_MS', () => {
  it('allows MyAgents-owned tools to run for five minutes', () => {
    expect(MYAGENTS_TOOL_CALL_TIMEOUT_MS).toBe(300_000);
  });
});
