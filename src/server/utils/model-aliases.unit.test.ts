import { describe, expect, it } from 'vitest';

import { modelAliasEnvChangesForModel, resolveSessionModelAliases } from './model-aliases';

describe('resolveSessionModelAliases', () => {
  it('rebases collapsed aliases to the active session model', () => {
    expect(resolveSessionModelAliases(
      { sonnet: 'MiniMax-M3', opus: 'MiniMax-M3', haiku: 'MiniMax-M3' },
      'MiniMax-M2.7',
    )).toEqual({
      fable: 'MiniMax-M2.7',
      sonnet: 'MiniMax-M2.7',
      opus: 'MiniMax-M2.7',
      haiku: 'MiniMax-M2.7',
    });
  });

  it('preserves intentionally split alias routing', () => {
    const aliases = {
      fable: 'deepseek-v4-pro',
      sonnet: 'deepseek-v4-pro',
      opus: 'deepseek-v4-pro',
      haiku: 'deepseek-v4-flash',
    };

    expect(resolveSessionModelAliases(aliases, 'deepseek-v4-pro')).toEqual(aliases);
  });

  it('only backfills fable for incomplete alias tables', () => {
    const aliases = { sonnet: 'provider-sonnet' };

    expect(resolveSessionModelAliases(aliases, 'active-model')).toEqual({
      fable: 'provider-sonnet',
      sonnet: 'provider-sonnet',
    });
  });

  it('adds fable from opus for legacy alias tables', () => {
    expect(resolveSessionModelAliases(
      { sonnet: 'provider-main', opus: 'provider-best', haiku: 'provider-fast' },
      'provider-main',
    )).toEqual({
      fable: 'provider-best',
      sonnet: 'provider-main',
      opus: 'provider-best',
      haiku: 'provider-fast',
    });
  });
});

describe('modelAliasEnvChangesForModel', () => {
  it('detects when a collapsed alias table needs subprocess env reinjection', () => {
    expect(modelAliasEnvChangesForModel(
      { sonnet: 'MiniMax-M3', opus: 'MiniMax-M3', haiku: 'MiniMax-M3' },
      'MiniMax-M3',
      'MiniMax-M2.7',
    )).toBe(true);
  });

  it('ignores selected-model changes for split alias routing', () => {
    expect(modelAliasEnvChangesForModel(
      { fable: 'deepseek-v4-pro', sonnet: 'deepseek-v4-pro', opus: 'deepseek-v4-pro', haiku: 'deepseek-v4-flash' },
      'deepseek-v4-pro',
      'deepseek-v4-lite',
    )).toBe(false);
  });
});
