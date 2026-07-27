import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../types';

const configState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('./appConfigService', () => ({
  atomicModifyConfig: vi.fn(async (modify: (config: AppConfig) => AppConfig) => {
    configState.current = modify(configState.current as AppConfig);
    return configState.current;
  }),
  loadAppConfig: vi.fn(async () => configState.current),
}));

import {
  patchAgentChannelConfig,
  patchAgentChannelOpenClawConfig,
} from './agentConfigService';

function initialConfig(): AppConfig {
  return {
    defaultPermissionMode: 'auto',
    themeId: 'myagents-default',
    appearanceMode: 'system',
    minimizeToTray: true,
    showDevTools: false,
    autoStart: false,
    osNotifications: true,
    notificationSound: true,
    agents: [{
      id: 'agent-1',
      name: 'Agent',
      workspacePath: '/tmp/agent',
      enabled: true,
      permissionMode: 'auto',
      channels: [{
        id: 'channel-1',
        name: 'Lark',
        type: 'openclaw:openclaw-lark',
        enabled: true,
        setupCompleted: true,
        openclawPluginConfig: { timeout: 30, streaming: true },
      }],
    }],
  };
}

describe('disk-latest Agent channel patches', () => {
  beforeEach(() => {
    configState.current = initialConfig();
  });

  it('preserves a scalar deletion when another channel control writes next', async () => {
    await patchAgentChannelOpenClawConfig(
      'agent-1',
      'channel-1',
      { type: 'delete', key: 'timeout' },
    );
    await patchAgentChannelConfig(
      'agent-1',
      'channel-1',
      { groupActivation: 'always' },
    );

    expect((configState.current as AppConfig).agents?.[0].channels?.[0]).toMatchObject({
      groupActivation: 'always',
      openclawPluginConfig: { streaming: true },
    });
  });
});
