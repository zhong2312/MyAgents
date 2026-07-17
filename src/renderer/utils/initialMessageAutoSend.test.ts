import { describe, expect, it } from 'vitest';

import {
  resolveInitialMessageProvider,
  shouldAutoSendInitialMessage,
} from './initialMessageAutoSend';

describe('shouldAutoSendInitialMessage', () => {
  it('allows a launcher handoff to send from an inactive connected tab', () => {
    expect(shouldAutoSendInitialMessage({
      hasInitialMessage: true,
      alreadyConsumed: false,
      hasSessionId: true,
      isConnected: true,
      isActive: false,
      runtimeReady: true,
    })).toBe(true);
  });

  it.each([
    ['missing initial message', { hasInitialMessage: false, alreadyConsumed: false, hasSessionId: true, isConnected: true, isActive: true }],
    ['already consumed', { hasInitialMessage: true, alreadyConsumed: true, hasSessionId: true, isConnected: true, isActive: true }],
    ['missing session id', { hasInitialMessage: true, alreadyConsumed: false, hasSessionId: false, isConnected: true, isActive: true }],
    ['not connected', { hasInitialMessage: true, alreadyConsumed: false, hasSessionId: true, isConnected: false, isActive: true }],
    ['runtime not ready', { hasInitialMessage: true, alreadyConsumed: false, hasSessionId: true, isConnected: true, isActive: true, runtimeReady: false }],
    ['provider catalog not ready', { hasInitialMessage: true, alreadyConsumed: false, hasSessionId: true, isConnected: true, isActive: true, providerCatalogReady: false }],
  ])('waits when %s', (_name, gate) => {
    expect(shouldAutoSendInitialMessage(gate)).toBe(false);
  });
});

describe('resolveInitialMessageProvider', () => {
  const legacyProvider = { id: 'volcengine' };
  const apiProvider = { id: 'volcengine-api' };

  it('uses the provider explicitly locked by the initial message', () => {
    expect(resolveInitialMessageProvider({
      explicitProviderId: apiProvider.id,
      providers: [legacyProvider, apiProvider],
      currentProvider: legacyProvider,
    })).toBe(apiProvider);
  });

  it('does not fall back to the current provider while an explicit provider is missing', () => {
    expect(resolveInitialMessageProvider({
      explicitProviderId: apiProvider.id,
      providers: [legacyProvider],
      currentProvider: legacyProvider,
    })).toBeUndefined();
  });

  it('uses the current provider only when the initial message has no explicit provider', () => {
    expect(resolveInitialMessageProvider({
      providers: [legacyProvider],
      currentProvider: legacyProvider,
    })).toBe(legacyProvider);
  });
});
