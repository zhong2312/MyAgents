import { describe, expect, it, vi } from 'vitest';

import { createCompatApi, shouldSuppressPluginDebugLog } from './compat-api';

describe('plugin bridge logger policy', () => {
  it('suppresses partial callback debug chatter without hiding other levels', () => {
    expect(shouldSuppressPluginDebugLog(['feishu: onPartialReply (len=42)', { len: 42 }])).toBe(true);
    expect(shouldSuppressPluginDebugLog(['onPartialReply: buffering NO_REPLY prefix'])).toBe(true);
    expect(shouldSuppressPluginDebugLog(['gateway connected'])).toBe(false);

    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const api = createCompatApi({});
      api.logger.debug('feishu: onPartialReply (len=42)', { len: 42 });
      api.logger.debug('gateway connected');
      api.logger.warn('onPartialReply failed');

      expect(debug).toHaveBeenCalledOnce();
      expect(debug).toHaveBeenCalledWith('[plugin]', 'gateway connected');
      expect(warn).toHaveBeenCalledWith('[plugin]', 'onPartialReply failed');
    } finally {
      debug.mockRestore();
      warn.mockRestore();
    }
  });
});
