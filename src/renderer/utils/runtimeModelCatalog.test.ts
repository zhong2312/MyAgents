import { describe, expect, it } from 'vitest';
import {
  clearRuntimeModelOverride,
  resolveAgentRuntimeModelCatalogIdentity,
  resolveRuntimeModelCatalogIdentity,
  runtimeModelCatalogPath,
} from './runtimeModelCatalog';

describe('runtimeModelCatalogPath', () => {
  it('keeps the two Codex catalog owners distinct', () => {
    expect(runtimeModelCatalogPath('codex', 'managed-provider'))
      .toBe('/api/runtime/models?type=codex&source=managed-provider');
    expect(runtimeModelCatalogPath('codex', 'system-cli'))
      .toBe('/api/runtime/models?type=codex&source=system-cli');
    expect(runtimeModelCatalogPath('codex'))
      .toBe('/api/runtime/models?type=codex&source=system-cli');
  });

  it('does not add a Codex source to other runtimes', () => {
    expect(runtimeModelCatalogPath('gemini', 'managed-provider'))
      .toBe('/api/runtime/models?type=gemini');
  });
});

describe('clearRuntimeModelOverride', () => {
  it('preserves the rest of the runtime identity and profile', () => {
    expect(clearRuntimeModelOverride({
      source: 'managed-provider',
      model: 'gpt-5.6-sol',
      permissionMode: 'no-restrictions',
      reasoningEffort: 'high',
      envPolicy: { proxy: 'myagents' },
    })).toEqual({
      source: 'managed-provider',
      permissionMode: 'no-restrictions',
      reasoningEffort: 'high',
      envPolicy: { proxy: 'myagents' },
    });
  });

  it('removes an otherwise empty override object', () => {
    expect(clearRuntimeModelOverride({ model: 'gpt-5.6-sol' })).toBeUndefined();
  });
});

describe('resolveRuntimeModelCatalogIdentity', () => {
  it('inherits the complete Agent identity when Task runtime is unset', () => {
    expect(resolveRuntimeModelCatalogIdentity(
      undefined,
      { source: 'managed-provider', model: 'stale-managed-model' },
      { runtime: 'codex', source: 'system-cli' },
    )).toEqual({ runtime: 'codex', source: 'system-cli' });

    expect(resolveRuntimeModelCatalogIdentity(
      undefined,
      { source: 'system-cli', model: 'stale-system-model' },
      { runtime: 'codex', source: 'managed-provider' },
    )).toEqual({ runtime: 'codex', source: 'managed-provider' });
  });

  it('uses the explicit Task source when Task owns the runtime', () => {
    expect(resolveRuntimeModelCatalogIdentity(
      'codex',
      { source: 'managed-provider' },
      { runtime: 'codex', source: 'system-cli' },
    )).toEqual({ runtime: 'codex', source: 'managed-provider' });
  });

  it('projects the canonical managed Agent storage shape', () => {
    expect(resolveAgentRuntimeModelCatalogIdentity({
      providerId: 'codex-sub',
      runtime: 'builtin',
    })).toEqual({ runtime: 'codex', source: 'managed-provider' });
  });
});
