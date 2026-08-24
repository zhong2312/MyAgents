import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { ChannelSurface } from '@/hooks/useSessionSurfaces';
import { transitionChannelBoundSession } from './chatChannelSession';

const channel: ChannelSurface = {
  agentId: 'agent-1',
  agentName: 'Agent',
  channelId: 'channel-1',
  channelType: 'openclaw:feishu',
  channelName: 'Feishu',
  sessionKey: 'agent:agent-1:openclaw:feishu:private:user-1',
  sourceType: 'private',
  sourceId: 'user-1',
  sourceDisplayName: 'User',
  platformLabel: 'Feishu',
  status: 'online',
};

const mocks = {
  migrateChannelToNewSession: vi.fn(),
  adoptMigratedSession: vi.fn(),
  releaseMigratedTabOwner: vi.fn(),
  reportError: vi.fn(),
};

function runTransition() {
  return transitionChannelBoundSession({
    sessionId: 'old-session',
    tabId: 'tab-1',
    boundChannel: channel,
    migrateChannelToNewSession: mocks.migrateChannelToNewSession,
    adoptMigratedSession: mocks.adoptMigratedSession,
    releaseMigratedTabOwner: mocks.releaseMigratedTabOwner,
    reportError: mocks.reportError,
  });
}

describe('transitionChannelBoundSession', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    vi.clearAllMocks();
    mocks.adoptMigratedSession.mockResolvedValue(true);
    mocks.releaseMigratedTabOwner.mockResolvedValue(false);
  });

  it('adopts the migrated channel session without plain reset', async () => {
    mocks.migrateChannelToNewSession.mockResolvedValue('new-session');

    await expect(runTransition()).resolves.toBe(true);

    expect(mocks.migrateChannelToNewSession).toHaveBeenCalledWith({
      oldSessionId: 'old-session',
      tabId: 'tab-1',
      sessionKey: channel.sessionKey,
    });
    expect(mocks.adoptMigratedSession).toHaveBeenCalledWith('new-session', { sidecarAlreadyMigrated: true });
    expect(mocks.releaseMigratedTabOwner).not.toHaveBeenCalled();
  });

  it('fails closed when migration returns no target', async () => {
    mocks.migrateChannelToNewSession.mockResolvedValue(null);

    await expect(runTransition()).resolves.toBe(false);

    expect(mocks.adoptMigratedSession).not.toHaveBeenCalled();
    expect(mocks.releaseMigratedTabOwner).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledWith('Channel 重绑失败，已取消新对话');
  });

  it('releases the migrated Tab owner when renderer adoption is refused', async () => {
    mocks.migrateChannelToNewSession.mockResolvedValue('new-session');
    mocks.adoptMigratedSession.mockResolvedValue(false);

    await expect(runTransition()).resolves.toBe(false);

    expect(mocks.releaseMigratedTabOwner).toHaveBeenCalledWith('new-session', 'tab-1');
    expect(mocks.reportError).toHaveBeenCalledWith('Channel 重绑失败，已取消新对话');
  });

  it('fails closed without owner cleanup when migration never committed', async () => {
    mocks.migrateChannelToNewSession.mockRejectedValue(new Error('offline'));

    await expect(runTransition()).resolves.toBe(false);

    expect(mocks.releaseMigratedTabOwner).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledWith('Channel 重绑失败，已取消新对话');
  });
});
