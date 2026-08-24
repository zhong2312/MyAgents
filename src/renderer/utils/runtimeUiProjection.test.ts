import { describe, expect, it } from 'vitest';

import {
  projectInputChromeRuntime,
  projectRuntimeExtensionUpdateNotice,
  shouldShowBuiltinSdkSlashCommands,
  shouldUseExternalRuntimeInputControls,
} from './runtimeUiProjection';

describe('runtime UI projection', () => {
  it('keeps managed Codex execution hidden behind builtin provider chrome', () => {
    expect(projectInputChromeRuntime({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: true,
    })).toBe('builtin');
    expect(shouldUseExternalRuntimeInputControls({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: true,
    })).toBe(false);
  });

  it('keeps user-managed CLI runtimes in external runtime controls', () => {
    expect(projectInputChromeRuntime({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: false,
    })).toBe('codex');
    expect(shouldUseExternalRuntimeInputControls({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: false,
    })).toBe(true);
  });

  it('only exposes Claude Agent SDK system slash commands to builtin Sessions', () => {
    expect(shouldShowBuiltinSdkSlashCommands('builtin')).toBe(true);
    expect(shouldShowBuiltinSdkSlashCommands('codex')).toBe(false);
    expect(shouldShowBuiltinSdkSlashCommands('claude-code')).toBe(false);
    expect(shouldShowBuiltinSdkSlashCommands('gemini')).toBe(false);
  });

  it('only requests extension feedback when the user must wait or act', () => {
    expect(projectRuntimeExtensionUpdateNotice({
      desiredRevision: 'desired',
      effectiveRevision: null,
      state: 'pending_next_start',
      components: [],
    })).toBeNull();

    expect(projectRuntimeExtensionUpdateNotice({
      desiredRevision: 'desired',
      effectiveRevision: 'effective',
      state: 'deferred_until_idle',
      components: [],
    })).toBe('deferred');

    expect(projectRuntimeExtensionUpdateNotice({
      desiredRevision: 'desired',
      effectiveRevision: 'effective',
      state: 'applied',
      components: [{
        component: 'plugins',
        state: 'unsupported',
        code: 'plugin_hooks_unsupported',
      }],
    })).toBeNull();

    expect(projectRuntimeExtensionUpdateNotice({
      desiredRevision: 'desired',
      effectiveRevision: 'effective',
      state: 'applied',
      components: [{
        component: 'host_tools',
        state: 'unsupported',
        code: 'host_tools_catalog_immutable',
        requiresUserAction: true,
      }],
    })).toBe('unsupported');
  });
});
