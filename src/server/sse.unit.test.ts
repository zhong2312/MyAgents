import { afterEach, describe, expect, it, vi } from 'vitest';

import { broadcast } from './sse';

describe('SSE replay diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['live-user-echo', 'session-b'],
    ['cold-history', undefined],
  ])('logs %s replay scope presence without identifiers or content', (replayKind, sessionId) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    broadcast('chat:message-replay', {
      replayKind,
      sessionId,
      message: {
        id: '0',
        role: 'user',
        content: 'private message body',
      },
    });

    expect(log).toHaveBeenCalledWith(
      `[sse] chat:message-replay -> messageId=0 replayKind=${replayKind} role=user sessionScope=${sessionId ? 'present' : 'none'}`,
    );
    expect(log.mock.calls.flat().join(' ')).not.toContain('private message body');
    expect(log.mock.calls.flat().join(' ')).not.toContain('session-b');
  });
});
