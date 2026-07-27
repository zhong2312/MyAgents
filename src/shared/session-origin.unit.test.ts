import { describe, expect, it } from 'vitest';

import { normalizeSessionOrigin } from './session-origin';

describe('registered Agent session origin', () => {
  it('preserves an exact Space and Registered Agent binding', () => {
    expect(normalizeSessionOrigin({
      kind: 'registered-agent',
      surface: 'space_issue_delivery',
      context: {
        spaceId: ' space-1 ',
        registeredAgentId: ' agent-1 ',
      },
    })).toEqual({
      kind: 'registered-agent',
      surface: 'space_issue_delivery',
      context: {
        spaceId: 'space-1',
        registeredAgentId: 'agent-1',
      },
    });
  });

  it('never attaches Agent identity context to another origin kind', () => {
    expect(normalizeSessionOrigin({
      kind: 'desktop',
      surface: 'launcher_input',
      context: {
        spaceId: 'space-1',
        registeredAgentId: 'agent-1',
      },
    })).toEqual({
      kind: 'desktop',
      surface: 'launcher_input',
    });
  });

  it('rejects context-free or partially identified Registered Agent origins', () => {
    expect(normalizeSessionOrigin({
      kind: 'registered-agent',
      surface: 'space_issue_delivery',
    })).toBeUndefined();
    expect(normalizeSessionOrigin({
      kind: 'registered-agent',
      surface: 'space_issue_delivery',
      context: { spaceId: 'space-1', registeredAgentId: ' ' },
    })).toBeUndefined();
    expect(normalizeSessionOrigin({
      kind: 'desktop',
      surface: 'space_issue_delivery',
    })).toBeUndefined();
  });
});
