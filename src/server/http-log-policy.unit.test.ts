import { describe, expect, it } from 'vitest';

import { shouldLogHttpRequest } from './http-log-policy';

describe('HTTP request log policy', () => {
  it('silences health and session-state polling while retaining actionable routes', () => {
    expect(shouldLogHttpRequest('GET', '/health')).toBe(false);
    expect(shouldLogHttpRequest('GET', '/health/live')).toBe(false);
    expect(shouldLogHttpRequest('GET', '/health/ready')).toBe(false);
    expect(shouldLogHttpRequest('GET', '/health/functional')).toBe(false);
    expect(shouldLogHttpRequest('GET', '/api/session-state')).toBe(false);
    expect(shouldLogHttpRequest('POST', '/chat/send')).toBe(true);
  });

  it('retains writes even when their path is also used for quiet reads', () => {
    expect(shouldLogHttpRequest('GET', '/sessions')).toBe(false);
    expect(shouldLogHttpRequest('POST', '/sessions')).toBe(true);
  });
});
