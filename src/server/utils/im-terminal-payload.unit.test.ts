import { describe, expect, it } from 'vitest';

import {
  buildImCancelledPayload,
  buildImCompletePayload,
  buildImErrorPayload,
} from './im-terminal-payload';

describe('IM terminal producer payloads', () => {
  it('preserves canonical complete text and permits zero finals', () => {
    expect(buildImCompletePayload('answer\n')).toEqual({ finalPayloads: [{ text: 'answer\n' }] });
    expect(buildImCompletePayload('  ')).toEqual({ finalPayloads: [] });
  });

  it('marks errors independently and keeps cancellation user-safe', () => {
    expect(buildImErrorPayload('failed')).toEqual({
      finalPayloads: [{ text: 'failed', isError: true }],
    });
    expect(buildImCancelledPayload()).toEqual({ finalPayloads: [{ text: '🛑 已取消' }] });
  });
});
