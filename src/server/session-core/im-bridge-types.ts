import type { HostInteractionCapability } from '../../shared/types/hostInteraction';

/** Session-stable identity of the plugin tool schema exposed to the SDK. */
export type ImBridgeToolSurface = {
  bridgePort: number;
  enabledToolGroups: string[];
  pluginId: string;
};

/** Per-turn caller identity. It must never be captured by a Session tool server. */
export type ImBridgeTurnContext = {
  senderId?: string;
  chatId?: string;
  isOwner?: boolean;
  sourceType?: string;
  accountId?: string;
  hostInteraction?: HostInteractionCapability;
};
