import { beforeEach, describe, expect, it } from 'vitest';

import { getCurrentImBridgeTurnContext } from '../agent-session';
import {
  popPendingOutputOwner,
  pushPendingOutputOwner,
  removePendingOutputOwnerByQueueId,
  resetTurnForTest,
} from '../builtin-session/turn';
import { imRequestRegistry } from '../utils/im-request-registry';

describe('IM Bridge active request identity', () => {
  beforeEach(() => {
    resetTurnForTest();
    imRequestRegistry.clear();
  });

  it('keeps the FIFO head identity while a later realtime message is already yielded', () => {
    imRequestRegistry.register('request-a', 'session-1', 'feishu_group');
    imRequestRegistry.setImBridgeTurnContext('request-a', {
      senderId: 'sender-a',
      chatId: 'chat-a',
      accountId: 'account-a',
      isOwner: true,
    });
    imRequestRegistry.register('request-b', 'session-1', 'feishu_group');
    imRequestRegistry.setImBridgeTurnContext('request-b', {
      senderId: 'sender-b',
      chatId: 'chat-b',
      accountId: 'account-b',
      isOwner: false,
    });

    pushPendingOutputOwner('queue-a', 'request-a');
    pushPendingOutputOwner('queue-b', 'request-b');
    expect(getCurrentImBridgeTurnContext()).toMatchObject({
      senderId: 'sender-a',
      accountId: 'account-a',
    });

    expect(popPendingOutputOwner()).toMatchObject({ requestId: 'request-a' });
    imRequestRegistry.unregister('request-a');
    expect(getCurrentImBridgeTurnContext()).toMatchObject({
      senderId: 'sender-b',
      accountId: 'account-b',
    });

    expect(popPendingOutputOwner()).toMatchObject({ requestId: 'request-b' });
    imRequestRegistry.unregister('request-b');
    expect(getCurrentImBridgeTurnContext()).toBeNull();
  });

  it('keeps a non-IM output slot ahead of a later realtime IM message', () => {
    imRequestRegistry.register('request-b', 'session-1', 'feishu_group');
    imRequestRegistry.setImBridgeTurnContext('request-b', {
      senderId: 'sender-b',
      chatId: 'chat-b',
      accountId: 'account-b',
      isOwner: false,
    });

    pushPendingOutputOwner('queue-desktop', null);
    pushPendingOutputOwner('queue-b', 'request-b');

    expect(getCurrentImBridgeTurnContext()).toBeNull();
    expect(popPendingOutputOwner()).toMatchObject({
      queueId: 'queue-desktop',
      requestId: null,
    });
    expect(getCurrentImBridgeTurnContext()).toMatchObject({
      senderId: 'sender-b',
      accountId: 'account-b',
    });
  });

  it('removes a cancelled non-IM yield by queue identity without shifting another owner', () => {
    imRequestRegistry.register('request-c', 'session-1', 'feishu_group');
    imRequestRegistry.setImBridgeTurnContext('request-c', {
      senderId: 'sender-c',
      chatId: 'chat-c',
      isOwner: false,
    });

    pushPendingOutputOwner('queue-desktop-a', null);
    pushPendingOutputOwner('queue-desktop-b', null);
    pushPendingOutputOwner('queue-c', 'request-c');

    expect(removePendingOutputOwnerByQueueId('queue-desktop-b')).toBe(true);
    expect(popPendingOutputOwner()).toMatchObject({ queueId: 'queue-desktop-a' });
    expect(getCurrentImBridgeTurnContext()).toMatchObject({ senderId: 'sender-c' });
  });
});
