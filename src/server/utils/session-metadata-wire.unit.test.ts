import { describe, expect, it } from 'vitest';

import { toClientSessionMetadata } from './session-metadata-wire';

describe('toClientSessionMetadata', () => {
  it('projects the legacy disk count as turnCount without mutating storage metadata', () => {
    const metadata = {
      id: 'session-1',
      providerEnvJson: '{"API_KEY":"secret"}',
      stats: {
        messageCount: 3,
        totalInputTokens: 10,
        totalOutputTokens: 2,
      },
    };

    const result = toClientSessionMetadata(metadata);

    expect(result).toEqual({
      id: 'session-1',
      providerEnvJson: '[redacted]',
      stats: {
        turnCount: 3,
        totalInputTokens: 10,
        totalOutputTokens: 2,
        totalCacheReadTokens: undefined,
        totalCacheCreationTokens: undefined,
      },
    });
    expect(metadata.stats).toHaveProperty('messageCount', 3);
    expect(metadata.providerEnvJson).toContain('secret');
  });
});
