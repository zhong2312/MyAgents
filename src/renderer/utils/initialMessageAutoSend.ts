export interface InitialMessageAutoSendGate {
  hasInitialMessage: boolean;
  alreadyConsumed: boolean;
  hasSessionId: boolean;
  isConnected: boolean;
  isActive: boolean;
  runtimeReady?: boolean;
  providerCatalogReady?: boolean;
}

/**
 * Launcher handoff is already an explicit user send. Once the target Chat tab
 * has a session and SSE connection, it must submit even if the user switched
 * away during startup.
 */
export function shouldAutoSendInitialMessage(args: InitialMessageAutoSendGate): boolean {
  if (!args.hasInitialMessage) return false;
  if (args.alreadyConsumed) return false;
  if (!args.hasSessionId) return false;
  if (!args.isConnected) return false;
  if (args.runtimeReady === false) return false;
  if (args.providerCatalogReady === false) return false;
  return true;
}

/**
 * An initial message with an explicit provider is an execution identity, not a
 * preference. Never substitute the project's current provider when that exact
 * provider has not been loaded.
 */
export function resolveInitialMessageProvider<T extends { id: string }>(args: {
  explicitProviderId?: string;
  providers: readonly T[];
  currentProvider?: T;
}): T | undefined {
  if (!args.explicitProviderId) return args.currentProvider;
  return args.providers.find(provider => provider.id === args.explicitProviderId);
}
