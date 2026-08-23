import { describe, expect, it, vi } from 'vitest';

import type { RuntimeType } from '../../shared/types/runtime';
import type { SessionMetadata } from '../types/session';
import { decideBuiltinSessionResume, type SdkTranscriptProbe } from './builtin-session-resume';

function meta(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: 'session-1',
    agentDir: '/tmp/workspace',
    title: 'New Chat',
    createdAt: '2026-06-14T00:00:00.000Z',
    lastActiveAt: '2026-06-14T00:00:00.000Z',
    unifiedSession: true,
    runtime: 'builtin',
    ...overrides,
  };
}

function probe(messages: readonly unknown[] = []): SdkTranscriptProbe {
  return vi.fn().mockResolvedValue(messages);
}

describe('decideBuiltinSessionResume', () => {
  it('does not resume metadata-only builtin sessions created before SDK persistence', async () => {
    const sdkProbe = probe([]);

    const decision = await decideBuiltinSessionResume({
      meta: meta(),
      currentRuntime: 'builtin',
      agentDir: '/tmp/workspace',
      probeSdkTranscript: sdkProbe,
    });

    expect(decision).toEqual({ shouldResume: false, reason: 'no-sdk-transcript' });
    expect(sdkProbe).toHaveBeenCalledWith('session-1', { dir: '/tmp/workspace', limit: 1 });
  });

  it('resumes when sdkSessionId records a registered SDK session', async () => {
    const sdkProbe = probe([{ type: 'user' }]);

    const decision = await decideBuiltinSessionResume({
      meta: meta({ sdkSessionId: 'sdk-session-1' }),
      currentRuntime: 'builtin',
      agentDir: '/tmp/workspace',
      probeSdkTranscript: sdkProbe,
    });

    expect(decision).toEqual({
      shouldResume: true,
      resumeSessionId: 'sdk-session-1',
      reason: 'sdk-session-id',
    });
    expect(sdkProbe).toHaveBeenCalledWith('sdk-session-1', { dir: '/tmp/workspace', limit: 1 });
  });

  it('creates the exact persisted SDK candidate when its transcript does not exist yet', async () => {
    const sdkProbe = probe([]);

    const decision = await decideBuiltinSessionResume({
      meta: meta({ sdkSessionId: 'replacement-sdk-session' }),
      currentRuntime: 'builtin',
      agentDir: '/tmp/workspace',
      probeSdkTranscript: sdkProbe,
    });

    expect(decision).toEqual({ shouldResume: false, reason: 'no-sdk-transcript' });
    expect(sdkProbe).toHaveBeenCalledWith('replacement-sdk-session', {
      dir: '/tmp/workspace',
      limit: 1,
    });
  });

  it('fails closed when the exact SDK candidate cannot be probed', async () => {
    const failure = new Error('permission denied');
    const sdkProbe = vi.fn().mockRejectedValue(failure);

    const decision = await decideBuiltinSessionResume({
      meta: meta({ sdkSessionId: 'replacement-sdk-session' }),
      currentRuntime: 'builtin',
      agentDir: '/tmp/workspace',
      probeSdkTranscript: sdkProbe,
    });

    expect(decision).toEqual({ shouldResume: false, reason: 'probe-error', error: failure });
  });

  it('recovers unified sessions whose SDK transcript exists before sdkSessionId was saved', async () => {
    const decision = await decideBuiltinSessionResume({
      meta: meta(),
      currentRuntime: 'builtin',
      agentDir: '/tmp/workspace',
      probeSdkTranscript: probe([{ type: 'user' }]),
    });

    expect(decision).toEqual({
      shouldResume: true,
      resumeSessionId: 'session-1',
      reason: 'unified-transcript',
    });
  });

  it('does not let builtin SDK resume sessions created by external runtimes', async () => {
    const sdkProbe = probe([{ type: 'user' }]);

    const decision = await decideBuiltinSessionResume({
      meta: meta({ runtime: 'gemini' }),
      currentRuntime: 'builtin',
      agentDir: '/tmp/workspace',
      probeSdkTranscript: sdkProbe,
    });

    expect(decision).toEqual({ shouldResume: false, reason: 'runtime-mismatch' });
    expect(sdkProbe).not.toHaveBeenCalled();
  });

  it('keeps external runtimes out of builtin SDK resume state', async () => {
    const decision = await decideBuiltinSessionResume({
      meta: meta({ runtime: 'gemini' }),
      currentRuntime: 'gemini' as RuntimeType,
      agentDir: '/tmp/workspace',
      probeSdkTranscript: probe([{ type: 'user' }]),
    });

    expect(decision).toEqual({ shouldResume: false, reason: 'external-runtime' });
  });
});
