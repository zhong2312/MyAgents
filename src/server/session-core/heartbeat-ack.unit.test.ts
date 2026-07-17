import { describe, expect, it } from 'vitest';

import {
  heartbeatAcknowledgementHasSubstantiveRemainder,
  stripHeartbeatAcknowledgement,
} from './heartbeat-ack';

describe('heartbeat acknowledgement normalization', () => {
  it.each([
    '**HEARTBEAT_OK**',
    '`HEARTBEAT_OK`',
    '<em>HEARTBEAT_OK</em>',
    '<div><strong>HEARTBEAT_OK</strong></div>',
    '> HEARTBEAT_OK',
    '<HEARTBEAT_OK>',
    'HEARTBEAT_OK&nbsp;',
    'HEARTBEAT_OK\u200B',
    '[HEARTBEAT_OK](https://example.com)',
  ])('treats formatting-only acknowledgement as empty: %s', (text) => {
    expect(heartbeatAcknowledgementHasSubstantiveRemainder(text)).toBe(false);
  });

  it('preserves content after removing acknowledgement formatting', () => {
    expect(stripHeartbeatAcknowledgement('<em>HEARTBEAT_OK</em> investigate')).toEqual({
      hadAcknowledgement: true,
      remainder: 'investigate',
    });
    expect(heartbeatAcknowledgementHasSubstantiveRemainder('HEARTBEAT_OK x')).toBe(true);
  });
});
