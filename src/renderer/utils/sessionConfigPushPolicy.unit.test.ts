import { describe, expect, it } from 'vitest';
import {
  sessionConfigPushFingerprint,
  shouldPushSessionConfig,
} from './sessionConfigPushPolicy';

describe('session config push policy', () => {
  it('coalesces semantically identical background payloads', () => {
    const previous = sessionConfigPushFingerprint({
      servers: [{ id: 'example', env: { TOKEN: 'secret', MODE: 'safe' } }],
    });
    const reordered = sessionConfigPushFingerprint({
      servers: [{ env: { MODE: 'safe', TOKEN: 'secret' }, id: 'example' }],
    });

    expect(reordered).toBe(previous);
    expect(shouldPushSessionConfig(previous, reordered, 'background')).toBe(false);
  });

  it('always lets an explicit user mutation reach the Sidecar', () => {
    const fingerprint = sessionConfigPushFingerprint({ servers: [] });

    expect(shouldPushSessionConfig(fingerprint, fingerprint, 'explicit')).toBe(true);
  });
});
